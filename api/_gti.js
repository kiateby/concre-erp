// ══════════════════════════════════════════════════════════════════════════════
// PUENTE CON GTI — piezas compartidas
//
// Este archivo corre en Vercel, NUNCA en el navegador. Es el único lugar del
// sistema que conoce el usuario y la clave de GTI, y esos dos datos viven en
// variables de entorno del proyecto, no en el código ni en el index.html.
//
// Por qué importa: el index.html se descarga en la máquina de cualquiera que
// abra el ERP. Si las credenciales estuvieran ahí, cualquier empleado podría
// emitir facturas a nombre de la empresa desde la consola del navegador.
//
// Variables de entorno que hay que crear en Vercel (Settings → Environment
// Variables). Una terna por empresa, porque cada una tiene su cuenta de GTI:
//
//   GTI_URL_PRUEBAS         https://... (del manual de GTI)
//   GTI_URL_PRODUCCION      https://...
//
//   GTI_USUARIO_CONCRE      113750786          (cuenta de pruebas 5662)
//   GTI_CLAVE_CONCRE        ••••••             ← Kia la saca del portal de GTI
//   GTI_CUENTA_CONCRE       5662
//
//   GTI_USUARIO_CONCREEQUIPOS / GTI_CLAVE_... / GTI_CUENTA_...   (Etapa 5)
//   GTI_USUARIO_FIBRA        / GTI_CLAVE_... / GTI_CUENTA_...    (Etapa 5)
//
//   SUPABASE_URL            https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY    la llave service_role (NO la anon)
//
//   GTI_SIMULADOR           1  → no llama a GTI; responde como si lo hubiera
//                                hecho. Sirve para probar todo el camino
//                                antes de tener el manual y la clave.
//                                En producción esta variable NO debe existir.
// ══════════════════════════════════════════════════════════════════════════════

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ── Supabase por REST, sin librería ─────────────────────────────────────────
// Se hace a mano para no agregar dependencias al proyecto: son cuatro verbos.
// La llave de servicio pasa por encima de RLS, que es justamente lo que se
// necesita acá y lo que no se puede permitir en el navegador.

function _cab(extra) {
  return Object.assign({
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function sbGet(tabla, query) {
  const r = await fetch(SB_URL + '/rest/v1/' + tabla + '?' + query, { headers: _cab() });
  const t = await r.text();
  if (!r.ok) throw new Error('supabase GET ' + tabla + ' ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : [];
}

async function sbPatch(tabla, query, datos) {
  const r = await fetch(SB_URL + '/rest/v1/' + tabla + '?' + query, {
    method: 'PATCH',
    headers: _cab({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(datos),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('supabase PATCH ' + tabla + ' ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : [];
}

async function sbInsert(tabla, filas) {
  const r = await fetch(SB_URL + '/rest/v1/' + tabla, {
    method: 'POST',
    headers: _cab({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(filas),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('supabase INSERT ' + tabla + ' ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : [];
}

// Sube un archivo al bucket privado. upsert:true porque un reintento tiene
// que poder sobreescribir sin fallar.
async function sbSubir(bucket, ruta, contenido, tipo) {
  const r = await fetch(SB_URL + '/storage/v1/object/' + bucket + '/' + ruta, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': tipo || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: contenido,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('storage ' + ruta + ' ' + r.status + ': ' + t.slice(0, 200));
  }
  return ruta;
}

// ── Credenciales de GTI, por empresa ────────────────────────────────────────
// El sufijo sale del id de la empresa en fact_empresas: 'concre' →
// GTI_USUARIO_CONCRE. Si falta alguna, se dice cuál, sin imprimir su valor.

function credenciales(empresaId, ambiente) {
  const suf = String(empresaId || 'concre').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const usuario = process.env['GTI_USUARIO_' + suf];
  const clave = process.env['GTI_CLAVE_' + suf];
  const cuenta = process.env['GTI_CUENTA_' + suf];

  const faltan = [];
  if (!usuario) faltan.push('GTI_USUARIO_' + suf);
  if (!clave) faltan.push('GTI_CLAVE_' + suf);
  if (!cuenta) faltan.push('GTI_CUENTA_' + suf);

  const url = (ambiente === 'produccion')
    ? process.env.GTI_URL_PRODUCCION
    : process.env.GTI_URL_PRUEBAS;
  if (!url) faltan.push(ambiente === 'produccion' ? 'GTI_URL_PRODUCCION' : 'GTI_URL_PRUEBAS');

  if (faltan.length) {
    const e = new Error('Faltan variables de entorno en Vercel: ' + faltan.join(', '));
    e.configuracion = true;
    throw e;
  }
  return { usuario, clave, cuenta, url, ambiente: ambiente || 'pruebas' };
}

// Quita usuario y clave de cualquier objeto antes de guardarlo en la bitácora.
// La bitácora la lee la aplicación, o sea el navegador.
function sinSecretos(obj) {
  const malas = /^(usuario|user|username|clave|password|pass|token|secret|authorization)$/i;
  function limpiar(v) {
    if (Array.isArray(v)) return v.map(limpiar);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = malas.test(k) ? '···' : limpiar(v[k]);
      return o;
    }
    return v;
  }
  try { return limpiar(obj); } catch (e) { return null; }
}

// ── Llamada a GTI ───────────────────────────────────────────────────────────
// Un solo lugar por donde sale todo, para que el registro, los tiempos de
// espera y el modo simulador valgan para las tres acciones.

const SIMULADOR = process.env.GTI_SIMULADOR === '1';

async function llamarGTI(cred, ruta, cuerpo, simular) {
  if (SIMULADOR) {
    const r = await simular();
    return { ok: true, status: 200, datos: r, simulado: true };
  }

  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), 25000);   // Vercel corta a los 30 s
  try {
    const r = await fetch(cred.url.replace(/\/+$/, '') + ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: ctl.signal,
    });
    const txt = await r.text();
    let datos = null;
    try { datos = txt ? JSON.parse(txt) : null; } catch (e) { datos = { crudo: txt.slice(0, 2000) }; }
    return { ok: r.ok, status: r.status, datos };
  } catch (e) {
    return { ok: false, status: 0, datos: null, error: (e.name === 'AbortError')
      ? 'GTI no contestó en 25 segundos' : String(e.message || e) };
  } finally {
    clearTimeout(reloj);
  }
}

module.exports = {
  SIMULADOR,
  sbGet, sbPatch, sbInsert, sbSubir,
  credenciales, sinSecretos, llamarGTI,
};
