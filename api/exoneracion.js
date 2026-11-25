// ══════════════════════════════════════════════════════════════════════════════
// /api/exoneracion — consulta a Hacienda si una autorización de exoneración
// existe y está vigente.
//
// Por qué pasa por el servidor y no por el navegador: el servicio de Hacienda
// (api.hacienda.go.cr/fe/ex) tiene límite de consultas por IP y no se sabe si
// acepta llamadas directas desde una página. Acá además se exige el pase de
// sesión, para que el servicio no sirva de puente abierto a cualquiera.
//
// GET /api/exoneracion?numero=AL-00460853-20      (con Authorization: Bearer <pase>)
//
// Respuesta (siempre 200 si el servicio funcionó; el resultado va en `estado`):
//   { ok:true, estado:'vigente'|'vencida'|'futura'|'no_existe'|'error', datos:{…}, mensaje }
//   estado 'error' = no se pudo consultar (Hacienda caído, límite, tiempo agotado):
//   NO significa que la exoneración sea mala.
//
// No toca la base ni GTI, y no emite nada.
// ══════════════════════════════════════════════════════════════════════════════
const S = require('./_sesion');

const URL_HACIENDA = 'https://api.hacienda.go.cr/fe/ex';
const FORMATO = /^AL-\d{8}-\d{2}$/i;
const ESPERA_MS = 8000;

// Fecha de hoy en Costa Rica (UTC−6, sin horario de verano), como AAAA-MM-DD.
function hoyCR(ahora) {
  const d = new Date((ahora || Date.now()) - 6 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const dia = (v) => (v ? String(v).slice(0, 10) : null);
// Hacienda manda los códigos con cero a la izquierda («04», «01»): se dejan tal cual.
const codigo = (v) => String(v == null ? '' : v).trim();

// Convierte la respuesta cruda de Hacienda a lo que usa el ERP.
function normalizar(j, hoy) {
  const emision = dia(j.fechaEmision);
  const vence = dia(j.fechaVencimiento);
  const cabys = Array.isArray(j.cabys) ? j.cabys.map(String) : [];
  let estado = 'vigente';
  if (vence && vence < hoy) estado = 'vencida';
  else if (emision && emision > hoy) estado = 'futura';
  return {
    estado,
    datos: {
      numero: String(j.numeroDocumento || '').toUpperCase(),
      identificacion: String(j.identificacion || '').replace(/\D/g, ''),
      porcentaje: Number(j.porcentajeExoneracion) || 0,
      emision, vence,
      tipo_doc: codigo(j.tipoDocumento && j.tipoDocumento.codigo),
      tipo_doc_txt: (j.tipoDocumento && j.tipoDocumento.descripcion) || '',
      institucion: codigo(j.CodigoInstitucion != null ? j.CodigoInstitucion : j.codigoInstitucion),
      institucion_txt: j.nombreInstitucion || '',
      posee_cabys: !!j.poseeCabys,
      cabys,
    },
  };
}

async function consultar(numero, opc) {
  const o = opc || {};
  const f = o.fetch || fetch;
  const hoy = hoyCR(o.ahora);
  const n = String(numero || '').trim().toUpperCase();
  if (!FORMATO.test(n)) {
    return { ok: false, status: 400, error: 'El número debe tener la forma AL-00000000-00.' };
  }
  let r;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), o.espera || ESPERA_MS) : null;
    r = await f(URL_HACIENDA + '?autorizacion=' + encodeURIComponent(n),
      { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
    if (t) clearTimeout(t);
  } catch (e) {
    return { ok: true, estado: 'error', mensaje: 'Hacienda no contestó a tiempo. Intente de nuevo en un momento.' };
  }
  if (r.status === 404) {
    return { ok: true, estado: 'no_existe', mensaje: 'Hacienda no tiene registrada la autorización ' + n + '.' };
  }
  if (r.status === 429) {
    return { ok: true, estado: 'error', mensaje: 'Hacienda limitó las consultas. Espere unos minutos.' };
  }
  if (r.status === 400) {
    return { ok: true, estado: 'no_existe', mensaje: 'Hacienda no reconoce el formato de ' + n + '.' };
  }
  if (!r.ok) {
    return { ok: true, estado: 'error', mensaje: 'Hacienda contestó con el error ' + r.status + '.' };
  }
  let j;
  try { j = await r.json(); } catch (e) {
    return { ok: true, estado: 'error', mensaje: 'La respuesta de Hacienda no se pudo leer.' };
  }
  if (!j || !j.numeroDocumento) {
    return { ok: true, estado: 'no_existe', mensaje: 'Hacienda no tiene registrada la autorización ' + n + '.' };
  }
  const x = normalizar(j, hoy);
  const msg = x.estado === 'vigente' ? 'Vigente' + (x.datos.vence ? ' hasta ' + x.datos.vence : '')
    : x.estado === 'vencida' ? 'Venció el ' + x.datos.vence
    : 'Todavía no está vigente (emitida el ' + x.datos.emision + ')';
  return { ok: true, estado: x.estado, datos: x.datos, mensaje: msg };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.sesionDe(req)) {
    return res.status(401).json({ ok: false, error: 'Falta iniciar sesión.' });
  }
  const numero = (req.query && req.query.numero) || '';
  const out = await consultar(numero);
  return res.status(out.status || 200).json(out);
}

module.exports = handler;
module.exports.consultar = consultar;
module.exports.normalizar = normalizar;
module.exports.hoyCR = hoyCR;
