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
//   GTI_URL_PRUEBAS
//     https://pruebas.gticr.com/AplicacionFEPruebas/ApiCargaFactura/api/Documentos
//   GTI_URL_PRODUCCION
//     https://www.facturaelectronica.cr/ApiCargaFactura/api/Documentos
//
//   GTI_USUARIO_CONCRE      el CORREO (o la cédula) del usuario ligado a la
//                           empresa en GTI — no el número de cuenta
//   GTI_CLAVE_CONCRE        ••••••   ← Kia la saca del portal de GTI
//   GTI_CUENTA_CONCRE       5662     (el «Nº de Cuenta» de la cuenta en GTI)
//
//   GTI_USUARIO_CONCREEQUIPOS / GTI_CLAVE_... / GTI_CUENTA_...   (Etapa 5)
//   GTI_USUARIO_FIBRA        / GTI_CLAVE_... / GTI_CUENTA_...    (Etapa 5)
//
//   SUPABASE_URL            https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY    la llave service_role (NO la anon)
//
//   GTI_SIMULADOR           1  → no llama a GTI; responde como si lo hubiera
//                                hecho. Sirve para probar todo el camino
//                                antes de tener la clave del portal.
//                                En producción esta variable NO debe existir.
//
// Las credenciales de GTI van en la QUERY STRING de cada llamada, así lo pide
// el manual. Por eso acá nunca se registra la URL armada: llevaría la clave
// escrita. Lo que se registra es el nombre del método y los parámetros que no
// son secretos.
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

const SIMULADOR = process.env.GTI_SIMULADOR === '1';

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

  // En modo simulador no se le pide nada de GTI: justamente sirve para probar
  // todo el camino ANTES de tener la clave del portal.
  if (faltan.length && SIMULADOR) {
    return {
      usuario: usuario || 'SIMULADO', clave: clave || 'SIMULADO',
      cuenta: cuenta || '5662', url: url || 'https://simulador.local',
      ambiente: ambiente || 'pruebas', incompleta: faltan,
    };
  }

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
  const malas = /^(usuario|user|username|clave|password|pass|token|secret|authorization|pusuario|pclave|purl|url)$/i;
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

// ── La URL base del servicio ────────────────────────────────────────────────
// La variable de entorno se acepta de cualquiera de las tres formas en que
// aparece escrita en el manual: con el método pegado al final, hasta
// /api/Documentos, o solo hasta /ApiCargaFactura. Así no importa cuál se pegó.
const METODOS_CONOCIDOS = 'CargarDocumento|EstadoHacienda|EstadoCorreo|ConsultaXMLEnviado'
  + '|ConsultaXMLRespuesta|ConsultarBytesPDF|ObtenerBytesPdfEmision|ReenviarCorreo'
  + '|ConsultaDocumento|PagarFactura';

function baseDocumentos(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(new RegExp('/(' + METODOS_CONOCIDOS + ')$', 'i'), '');
  if (!/\/ApiCargaFactura(\/|$)/i.test(u) && !/\/ServicioCargaFactura(\/|$)/i.test(u)) {
    u += '/ApiCargaFactura';
  }
  if (!/\/api\/Documentos$/i.test(u)) u += '/api/Documentos';
  return u;
}

// ── Llamada a GTI ───────────────────────────────────────────────────────────
// Un solo lugar por donde sale todo, para que el registro, los tiempos de
// espera y el modo simulador valgan para todos los métodos.
//
// «met» es una entrada de P.METODOS. Las credenciales se agregan acá y en
// ningún momento salen en el objeto que se devuelve.

async function llamarGTI(cred, met, opciones) {
  const o = opciones || {};

  if (SIMULADOR) {
    const r = await o.simular();
    return { ok: true, status: 200, datos: r, simulado: true, metodo: met.ruta };
  }

  // Los parámetros: el método dice si lleva consecutivo. ObtenerBytesPdfEmision
  // es el único que los nombra sin el prefijo «p» y con minúscula inicial.
  const nombre = met.sinPrefijo
    ? (n => n.charAt(0).toLowerCase() + n.slice(1))
    : (n => 'p' + n);

  const p = new URLSearchParams();
  p.set(nombre('NumCuenta'), String(cred.cuenta));
  if (met.consecutivo) {
    if (!o.consecutivo) {
      throw new Error('El método ' + met.ruta + ' necesita el consecutivo de 20 dígitos '
        + 'que devolvió GTI al emitir, y el documento no lo tiene guardado.');
    }
    p.set(nombre('Consecutivo'), String(o.consecutivo));
  }
  for (const k of Object.keys(o.params || {})) p.set(nombre(k), String(o.params[k]));
  p.set(nombre('Usuario'), String(cred.usuario));
  p.set(nombre('Clave'), String(cred.clave));

  const url = baseDocumentos(cred.url) + '/' + met.ruta + '?' + p.toString();

  // El manual aconseja hasta un minuto de espera en cargas individuales;
  // Vercel corta la función a los 30 segundos, así que se aborta a los 25 y el
  // trabajo queda en la cola para reintentarse.
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), 25000);
  try {
    const pedido = {
      method: met.verbo,
      headers: { 'Accept': met.respuesta === 'xml' ? 'application/xml, text/xml, */*'
                                                   : 'application/json, */*' },
      signal: ctl.signal,
    };
    if (met.cuerpo) {
      pedido.headers['Content-Type'] = 'application/json';
      pedido.body = JSON.stringify(o.cuerpo || {});
    }

    const r = await fetch(url, pedido);
    const txt = await r.text();

    let datos;
    if (met.respuesta === 'xml') {
      // El XML puede venir con un JSON de error en vez del documento.
      if (/^\s*[{[]/.test(txt)) {
        try { datos = JSON.parse(txt); } catch (e) { datos = { xml: txt }; }
      } else {
        datos = { xml: txt };
      }
    } else {
      try { datos = txt ? JSON.parse(txt) : null; }
      catch (e) { datos = { crudo: txt.slice(0, 2000) }; }
    }
    return { ok: r.ok, status: r.status, datos, metodo: met.ruta };
  } catch (e) {
    return {
      ok: false, status: 0, datos: null, metodo: met.ruta,
      error: (e.name === 'AbortError')
        ? 'GTI no contestó en 25 segundos' : String(e.message || e),
    };
  } finally {
    clearTimeout(reloj);
  }
}

module.exports = {
  SIMULADOR,
  sbGet, sbPatch, sbInsert, sbSubir,
  credenciales, sinSecretos, llamarGTI, baseDocumentos,
};
