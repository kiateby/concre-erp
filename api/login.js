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

const { firmar, verificar, portador } = require('./_sesion');

// ── Límite de intentos ──────────────────────────────────────────────────────
// Cinco contraseñas equivocadas seguidas bloquean ese usuario 15 minutos. La
// cuenta se lleva en la tabla login_intentos (no en memoria: cada llamada a
// Vercel puede caer en un servidor distinto). Un ingreso correcto la borra.
const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

async function leerIntentos(usuario) {
  try {
    const f = (await G.sbGet('login_intentos', 'usuario=eq.' + encodeURIComponent(usuario) + '&limit=1'))[0];
    if (!f) return { fallos: 0, hasta: 0, hay: true };
    const hasta = f.bloqueado_hasta ? new Date(f.bloqueado_hasta).getTime() : 0;
    // Un bloqueo ya cumplido deja la cuenta en cero
    if (hasta && hasta <= Date.now()) return { fallos: 0, hasta: 0, hay: true };
    return { fallos: Number(f.fallos) || 0, hasta: hasta, hay: true };
  } catch (e) {
    // Si la tabla todavía no existe, no se limita: es preferible a dejar a
    // todos sin poder entrar por un SQL que falta.
    return { fallos: 0, hasta: 0, hay: false };
  }
}

async function guardarIntentos(usuario, fallos, hasta) {
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/login_intentos?on_conflict=usuario', {
      method: 'POST',
      headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ usuario: usuario, fallos: fallos,
        bloqueado_hasta: hasta ? new Date(hasta).toISOString() : null,
        ultimo_fallo: fallos ? new Date().toISOString() : null,
        actualizado_en: new Date().toISOString() }]),
    });
    return r.ok;
  } catch (e) { return false; }
}

// Dónde está la contraseña (cifrada) de un usuario. Desde la etapa A de
// seguridad vive en «usuarios_claves», una tabla que solo este servidor puede
// leer. Si esa tabla todavía no existe (SQL sin correr) o el usuario no tiene
// fila allí, se usa la columna de siempre: así el orden de instalación no deja
// a nadie afuera.
async function claveGuardada(u) {
  try {
    const f = (await G.sbGet('usuarios_claves', 'id=eq.' + encodeURIComponent(u.id) + '&select=password&limit=1'))[0];
    if (f && f.password) return f.password;
  } catch (e) { /* la tabla no existe todavía */ }
  return u.password || '';
}

const minutosQueFaltan = (hasta) => Math.max(1, Math.ceil((hasta - Date.now()) / 60000));

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

// «Activo» es el estado normal. Un usuario viejo sin ese dato cuenta como activo.
function estaActivo(u) {
  const e = String((u && u.estado) || 'activo').trim().toLowerCase();
  return e === 'activo';
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
      const datos = verificar(portador(req), secreto);
      if (!datos || !datos.erp_uid) return res.status(401).json({ ok: false, error: 'La sesión venció.' });
      const u = (await G.sbGet('usuarios', 'id=eq.' + encodeURIComponent(datos.erp_uid)
        + '&select=id,rol,estado&limit=1'))[0];
      if (!u) return res.status(401).json({ ok: false, error: 'El usuario ya no existe.' });
      // Un usuario desactivado pierde la sesión en la siguiente renovación
      // (a más tardar media hora después de desactivarlo).
      if (!estaActivo(u)) return res.status(401).json({ ok: false, error: 'El usuario fue desactivado.' });
      return res.status(200).json(pase(u, secreto));
    }

    // ── entrar con usuario y contraseña ─────────────────────────────────────
    const usuario = String(c.usuario || '').trim().toLowerCase();
    const clave = String(c.clave == null ? '' : c.clave);
    if (!usuario || !clave) return res.status(400).json({ ok: false, error: 'Falta el usuario o la contraseña.' });

    const llave = usuario.slice(0, 60);
    const cuenta = await leerIntentos(llave);
    if (cuenta.hasta > Date.now()) {
      const min = minutosQueFaltan(cuenta.hasta);
      return res.status(423).json({ ok: false, motivo: 'bloqueado', minutos: min,
        error: 'Usuario bloqueado por demasiados intentos. Vuelva a intentar en ' + min
          + (min === 1 ? ' minuto.' : ' minutos.') });
    }

    const todos = await G.sbGet('usuarios', 'select=id,username,password,rol,estado');
    const u = todos.find(x => String(x.username || '').toLowerCase() === usuario);
    const guardada = u ? await claveGuardada(u) : '';

    if (!u || !claveCorrecta(clave, guardada)) {
      await espera(600);   // frena a quien prueba contraseñas una tras otra
      const base = u ? 'Contraseña incorrecta' : 'Usuario no encontrado';
      if (!cuenta.hay) return res.status(401).json({ ok: false, motivo: u ? 'clave' : 'usuario', error: base });
      const fallos = cuenta.fallos + 1;
      if (fallos >= MAX_INTENTOS) {
        const hasta = Date.now() + MINUTOS_BLOQUEO * 60000;
        await guardarIntentos(llave, fallos, hasta);
        return res.status(423).json({ ok: false, motivo: 'bloqueado', minutos: MINUTOS_BLOQUEO, restantes: 0,
          error: base + '. Se agotaron los ' + MAX_INTENTOS + ' intentos: el usuario queda bloqueado '
            + MINUTOS_BLOQUEO + ' minutos.' });
      }
      await guardarIntentos(llave, fallos, 0);
      const quedan = MAX_INTENTOS - fallos;
      return res.status(401).json({ ok: false, motivo: u ? 'clave' : 'usuario', restantes: quedan,
        error: base + '. Le ' + (quedan === 1 ? 'queda 1 intento' : 'quedan ' + quedan + ' intentos')
          + ' antes del bloqueo.' });
    }

    // Contraseña correcta, pero el superadmin lo desactivó: no entra.
    if (!estaActivo(u)) {
      return res.status(403).json({ ok: false, motivo: 'inactivo',
        error: 'Este usuario está inactivo. Consulte con el administrador.' });
    }
    if (cuenta.fallos) await guardarIntentos(llave, 0, 0);
    return res.status(200).json(pase(u, secreto));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports._interno = { firmar, verificar, claveCorrecta, uuidDe, MAX_INTENTOS, MINUTOS_BLOQUEO };
