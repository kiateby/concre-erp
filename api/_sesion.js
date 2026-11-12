// ══════════════════════════════════════════════════════════════════════════════
// EL PASE DE SESIÓN — firmar y comprobar
//
// Un solo lugar para las dos operaciones, porque las usan varios servicios:
// /api/login lo entrega, y los demás (/api/gti-procesar…) lo exigen.
// ══════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function firmar(datos, secreto) {
  const cabeza = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const cuerpo = b64u(JSON.stringify(datos));
  const firma = b64u(crypto.createHmac('sha256', secreto).update(cabeza + '.' + cuerpo).digest());
  return cabeza + '.' + cuerpo + '.' + firma;
}

// Devuelve los datos del pase si la firma es buena y no venció; si no, null.
function verificar(token, secreto) {
  if (!secreto) return null;
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

function portador(req) {
  const h = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  return h.replace(/^Bearer\s+/i, '');
}

// El pase de quien llama, si trae uno válido de un usuario del ERP.
function sesionDe(req) {
  const d = verificar(portador(req), process.env.SUPABASE_JWT_SECRET || '');
  return (d && d.erp_uid && d.role === 'authenticated') ? d : null;
}

// Comparación que no delata por tiempo cuántos caracteres coinciden.
function igual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { firmar, verificar, portador, sesionDe, igual };
