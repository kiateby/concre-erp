// ══════════════════════════════════════════════════════════════════════════════
// INICIO DE SESIÓN VERIFICADO POR EL SERVIDOR
//
// Antes, el ERP bajaba la tabla de usuarios al navegador y comparaba la
// contraseña ahí mismo. Para eso la base tenía que dejarse leer con la llave
// pública que va escrita en el index.html — y con esa misma llave se podía leer
// y cambiar TODO: facturas, clientes, planilla, usuarios.
//
// Ahora la contraseña se comprueba AQUÍ, en Vercel. Si es correcta, se entrega
// un pase firmado (un JWT) que vence solo. La base de datos reconoce ese pase y
// le abre al que lo trae; a quien llegue solo con la llave pública, no.
//
//   POST /api/login   {usuario, clave}            → {ok, token, vence}
//   POST /api/login   {renovar:true} + Bearer     → {ok, token, vence}
//   GET  /api/login                               → {configurado: true|false}
//
// Variables en Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   las que ya usa el puente de GTI
//   SUPABASE_JWT_SECRET                  el «JWT Secret» del proyecto de Supabase
//                                        (Settings → API / JWT Keys). Es lo que
//                                        hace que la base confíe en el pase.
//
// Nunca devuelve contraseñas ni su cifrado.
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const G = require('./_gti');

const HORAS_DE_SESION = 12;

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function firmar(datos, secreto) {
  const cabeza = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const cuerpo = b64u(JSON.stringify(datos));
  const firma = b64u(crypto.createHmac('sha256', secreto).update(cabeza + '.' + cuerpo).digest());
  return cabeza + '.' + cuerpo + '.' + firma;
}

function verificar(token, secreto) {
  const p = String(token || '').split('.');
  if (p.length !== 3) return null;
  const esperada = b64u(crypto.createHmac('sha256', secreto).update(p[0] + '.' + p[1]).digest());
  const a = Buffer.from(p[2]), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!datos || !datos.exp || datos.exp * 1000 < Date.now()) return null;
  return datos;
}

// Supabase espera que «sub» sea un UUID. Los ids del ERP no lo son ('admin',
// 'pablo'), así que se deriva uno fijo de cada id; el id real va en «erp_uid».
function uuidDe(id) {
  const h = crypto.createHash('sha256').update('erp-concre:' + String(id)).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

// El mismo formato que usa el ERP: sha256$<sal>$<hash de «sal:clave»>.
// Las contraseñas viejas en texto plano siguen sirviendo; el ERP las cifra
// solo en el primer ingreso, igual que antes.
function claveCorrecta(clave, guardada) {
  guardada = guardada == null ? '' : String(guardada);
  if (!guardada) return false;
  if (guardada.indexOf('sha256$') === 0) {
    const p = guardada.split('$');
    if (p.length !== 3) return false;
    const h = crypto.createHash('sha256').update(p[1] + ':' + String(clave)).digest('hex');
    const a = Buffer.from(h), b = Buffer.from(p[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(String(clave)), b = Buffer.from(guardada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pase(u, secreto) {
  const ahora = Math.floor(Date.now() / 1000);
  const exp = ahora + HORAS_DE_SESION * 3600;
  const token = firmar({
    iss: 'erp-concre', aud: 'authenticated', role: 'authenticated',
    sub: uuidDe(u.id), erp_uid: u.id, erp_rol: u.rol || 'user',
    iat: ahora, exp: exp,
  }, secreto);
  return { ok: true, token: token, vence: exp * 1000, id: u.id };
}

const espera = (ms) => new Promise(r => setTimeout(r, ms));

async function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secreto = process.env.SUPABASE_JWT_SECRET || '';
  const listo = !!(secreto && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

  if (req.method === 'GET') return res.status(200).json({ configurado: listo });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  // 503 = «todavía no está montado»: el ERP entra como antes y avisa.
  if (!listo) return res.status(503).json({ ok: false, configurado: false,
    error: 'Falta SUPABASE_JWT_SECRET en Vercel.' });

  try {
    const c = await leerCuerpo(req);

    // ── renovar un pase que todavía sirve ───────────────────────────────────
    if (c.renovar) {
      const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
      const datos = verificar(h.replace(/^Bearer\s+/i, ''), secreto);
      if (!datos || !datos.erp_uid) return res.status(401).json({ ok: false, error: 'La sesión venció.' });
      const u = (await G.sbGet('usuarios', 'id=eq.' + encodeURIComponent(datos.erp_uid)
        + '&select=id,rol,estado&limit=1'))[0];
      if (!u) return res.status(401).json({ ok: false, error: 'El usuario ya no existe.' });
      return res.status(200).json(pase(u, secreto));
    }

    // ── entrar con usuario y contraseña ─────────────────────────────────────
    const usuario = String(c.usuario || '').trim().toLowerCase();
    const clave = String(c.clave == null ? '' : c.clave);
    if (!usuario || !clave) return res.status(400).json({ ok: false, error: 'Falta el usuario o la contraseña.' });

    const todos = await G.sbGet('usuarios', 'select=id,username,password,rol,estado');
    const u = todos.find(x => String(x.username || '').toLowerCase() === usuario);
    if (!u) { await espera(600); return res.status(401).json({ ok: false, motivo: 'usuario', error: 'Usuario no encontrado' }); }
    if (!claveCorrecta(clave, u.password)) {
      await espera(600);   // frena a quien prueba contraseñas una tras otra
      return res.status(401).json({ ok: false, motivo: 'clave', error: 'Contraseña incorrecta' });
    }
    return res.status(200).json(pase(u, secreto));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports._interno = { firmar, verificar, claveCorrecta, uuidDe };
