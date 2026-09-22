// ══════════════════════════════════════════════════════════════════════════════
// EL PUENTE — procesa la cola de fact_emisiones
//
// Se llama de tres maneras, y las tres hacen lo mismo:
//   · el ERP lo toca (POST sin cuerpo) justo después de encolar un trabajo;
//   · el Cron de Vercel, como red de seguridad para lo que quedó pendiente;
//   · a mano, abriendo /api/gti-procesar en el navegador.
//
// Por qué no necesita contraseña: no recibe ningún dato. No se le puede
// pedir «emití esta factura» — solo «revisá la cola». Los trabajos los pone
// el ERP en Supabase, con los mismos permisos que ya tiene sobre el resto del
// sistema. Quien no pueda escribir en fact_emisiones no puede emitir nada,
// y tocar este endpoint sin trabajos en cola no hace absolutamente nada.
//
// Las credenciales de GTI solo existen acá, en variables de entorno.
// ══════════════════════════════════════════════════════════════════════════════

const G = require('./_gti');
const P = require('./_gti_payload');

const BUCKET = 'fact-comprobantes';
const MAX_POR_CORRIDA = 5;      // Vercel corta a los 30 s; 5 caben de sobra
const MAX_INTENTOS = 4;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false,
      error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en Vercel.' });
  }

  const hechos = [];
  try {
    const ahora = new Date().toISOString();
    const cola = await G.sbGet('fact_emisiones',
      'estado=eq.pendiente&correr_en=lte.' + encodeURIComponent(ahora) +
      '&order=correr_en.asc&limit=' + MAX_POR_CORRIDA);

    for (const trabajo of cola) {
      hechos.push(await procesar(trabajo));
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }

  return res.status(200).json({
    ok: true, simulador: G.SIMULADOR, procesados: hechos.length, detalle: hechos,
  });
};

// ── Un trabajo ──────────────────────────────────────────────────────────────
async function procesar(t) {
  // Se toma el trabajo antes de hacer nada: la condición estado=pendiente en
  // el PATCH evita que dos corridas simultáneas manden la misma factura dos
  // veces. Si otra corrida lo tomó primero, el PATCH no devuelve filas.
  let tomado;
  try {
    tomado = await G.sbPatch('fact_emisiones', 'id=eq.' + t.id + '&estado=eq.pendiente', {
      estado: 'procesando', tomado_en: new Date().toISOString(), intentos: (t.intentos || 0) + 1,
    });
  } catch (e) {
    return { id: t.id, ok: false, error: 'no se pudo tomar: ' + e.message };
  }
  if (!tomado || !tomado.length) return { id: t.id, ok: false, error: 'ya lo tomó otra corrida' };

  try {
    if (t.accion === 'emitir') return await emitir(t);
    if (t.accion === 'estado') return await consultarEstado(t);
    if (t.accion === 'descargar') return await descargar(t);
    throw new Error('acción desconocida: ' + t.accion);
  } catch (e) {
    return await fallar(t, e);
  }
}

// Un fallo se guarda con su motivo. Se reintenta hasta MAX_INTENTOS, cada vez
// más tarde; después queda fallido y el documento en 'error', para que el
// usuario lo vea en la pestaña y no se quede esperando en silencio.
async function fallar(t, e) {
  const msg = String(e.message || e).slice(0, 900);
  const reintentar = (t.intentos || 0) + 1 < MAX_INTENTOS && !e.configuracion;

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, reintentar
    ? { estado: 'pendiente', error: msg,
        correr_en: new Date(Date.now() + 60000 * Math.pow(3, t.intentos || 0)).toISOString() }
    : { estado: 'fallido', error: msg, terminado_en: new Date().toISOString() });

  if (!reintentar) {
    await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, {
      estado_hacienda: 'error', estado_hacienda_msg: msg,
      actualizado_en: new Date().toISOString(),
    }).catch(() => {});
  }
  return { id: t.id, ok: false, error: msg, reintenta: reintentar };
}

// ── Emitir ──────────────────────────────────────────────────────────────────
async function emitir(t) {
  const doc = (await G.sbGet('fact_docs', 'id=eq.' + t.doc_id + '&limit=1'))[0];
  if (!doc) throw new Error('el documento ya no existe');

  // Si ya tiene clave, ya salió: no se manda de nuevo. Una factura emitida
  // dos veces son dos documentos fiscales y hay que anular uno con nota de
  // crédito, así que este portón es importante.
  if (doc.clave) {
    await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
      estado: 'hecho', error: 'ya tenía clave; no se reenvió',
      terminado_en: new Date().toISOString(),
    });
    return { id: t.id, ok: true, nota: 'ya estaba emitido' };
  }

  const emp = (await G.sbGet('fact_empresas', 'id=eq.' + doc.empresa_id + '&limit=1'))[0];
  if (!emp) throw new Error('no se encontró la empresa ' + doc.empresa_id);

  const lineas = await G.sbGet('fact_lineas', 'doc_id=eq.' + t.doc_id + '&order=orden.asc');
  const cli = doc.fact_cliente_id
    ? (await G.sbGet('fact_clientes', 'id=eq.' + doc.fact_cliente_id + '&limit=1'))[0]
    : null;

  const cred = G.credenciales(doc.empresa_id, emp.gti_ambiente);
  const cuerpo = P.armar(doc, lineas, cli, emp, cred);

  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, {
    estado_hacienda: 'enviando', enviado_en: new Date().toISOString(),
  });

  const r = await G.llamarGTI(cred, P.RUTAS.emitir, cuerpo, () => P.simularEmision(doc));

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    enviado: G.sinSecretos(cuerpo), respuesta: G.sinSecretos(r.datos),
    http_status: r.status,
  });

  if (!r.ok) throw new Error(r.error || ('GTI respondió ' + r.status + ': ' +
    JSON.stringify(r.datos || {}).slice(0, 400)));

  const e = P.leerEmision(r.datos);
  if (!e.clave) throw new Error('GTI no devolvió la clave. Respuesta: ' +
    JSON.stringify(r.datos || {}).slice(0, 400));

  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, {
    clave: e.clave,
    consecutivo_fiscal: e.consecutivo || null,
    gti_id: e.gtiId || null,
    estado_hacienda: e.estado || 'recibido',
    estado_hacienda_msg: e.mensaje || null,
    actualizado_en: new Date().toISOString(),
  });

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    estado: 'hecho', terminado_en: new Date().toISOString(),
  });

  // GTI no avisa cuando Hacienda resuelve: hay que preguntar. Se encolan las
  // tres consultas de una vez, a los 30 segundos, 2 minutos y 5 minutos.
  const t0 = Date.now();
  await G.sbInsert('fact_emisiones', [30000, 120000, 300000].map(ms => ({
    empresa_id: doc.empresa_id, doc_id: t.doc_id, accion: 'estado',
    estado: 'pendiente', correr_en: new Date(t0 + ms).toISOString(),
    usuario_id: t.usuario_id, usuario_nombre: t.usuario_nombre,
  })));

  return { id: t.id, ok: true, clave: e.clave, estado: e.estado };
}

// ── Consultar el estado ─────────────────────────────────────────────────────
async function consultarEstado(t) {
  const doc = (await G.sbGet('fact_docs', 'id=eq.' + t.doc_id + '&limit=1'))[0];
  if (!doc) throw new Error('el documento ya no existe');

  // Si Hacienda ya resolvió, no se vuelve a preguntar: las otras dos
  // consultas encoladas se descartan solas por acá.
  if (doc.estado_hacienda === 'aceptado' || doc.estado_hacienda === 'rechazado') {
    await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
      estado: 'hecho', error: 'ya estaba resuelto', terminado_en: new Date().toISOString(),
    });
    return { id: t.id, ok: true, nota: 'ya resuelto: ' + doc.estado_hacienda };
  }
  if (!doc.clave) throw new Error('el documento no tiene clave: todavía no se emitió');

  const emp = (await G.sbGet('fact_empresas', 'id=eq.' + doc.empresa_id + '&limit=1'))[0];
  const cred = G.credenciales(doc.empresa_id, emp && emp.gti_ambiente);

  const cuerpo = { usuario: cred.usuario, clave: cred.clave, numCuenta: cred.cuenta,
                   claveComprobante: doc.clave, id: doc.gti_id || undefined };  // ⚠ manual

  const r = await G.llamarGTI(cred, P.RUTAS.estado, cuerpo,
    () => P.simularEstado(doc, t.intentos || 0));

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    enviado: G.sinSecretos(cuerpo), respuesta: G.sinSecretos(r.datos), http_status: r.status,
  });

  if (!r.ok) throw new Error(r.error || ('GTI respondió ' + r.status));

  const e = P.leerEstado(r.datos);
  const cambios = { estado_hacienda: e.estado || 'recibido',
                    estado_hacienda_msg: e.mensaje || null,
                    actualizado_en: new Date().toISOString() };
  if (e.estado === 'aceptado' || e.estado === 'rechazado') {
    cambios.resuelto_en = new Date().toISOString();
  }
  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, cambios);

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    estado: 'hecho', terminado_en: new Date().toISOString(),
  });

  // Aceptado: hay que bajar el XML y el PDF ya. GTI los entrega una sola vez
  // y dentro de los 3 días; si se pierde la ventana, no se recuperan.
  if (e.estado === 'aceptado' && !doc.xml_path) {
    await G.sbInsert('fact_emisiones', [{
      empresa_id: doc.empresa_id, doc_id: t.doc_id, accion: 'descargar',
      estado: 'pendiente', correr_en: new Date().toISOString(),
      usuario_id: t.usuario_id, usuario_nombre: t.usuario_nombre,
    }]);
  }

  return { id: t.id, ok: true, estado: e.estado };
}

// ── Bajar el XML y el PDF ───────────────────────────────────────────────────
async function descargar(t) {
  const doc = (await G.sbGet('fact_docs', 'id=eq.' + t.doc_id + '&limit=1'))[0];
  if (!doc) throw new Error('el documento ya no existe');
  if (!doc.clave) throw new Error('el documento no tiene clave');

  const emp = (await G.sbGet('fact_empresas', 'id=eq.' + doc.empresa_id + '&limit=1'))[0];
  const cred = G.credenciales(doc.empresa_id, emp && emp.gti_ambiente);

  const cuerpo = { usuario: cred.usuario, clave: cred.clave, numCuenta: cred.cuenta,
                   claveComprobante: doc.clave, incluirPdf: true };   // ⚠ manual

  const r = await G.llamarGTI(cred, P.RUTAS.descargar, cuerpo, () => ({
    xml: '<?xml version="1.0"?><FacturaElectronica><!-- simulado --></FacturaElectronica>',
    respuestaXml: '<?xml version="1.0"?><MensajeHacienda><Mensaje>1</Mensaje></MensajeHacienda>',
    pdf: null,
  }));

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    enviado: G.sinSecretos(cuerpo), respuesta: { archivos: 'no se guardan acá por tamaño' },
    http_status: r.status,
  });

  if (!r.ok) throw new Error(r.error || ('GTI respondió ' + r.status));

  const d = r.datos || {};
  const base = doc.empresa_id + '/' + String(doc.fecha || '').slice(0, 4) + '/' + doc.clave;
  const cambios = { archivos_en: new Date().toISOString() };

  if (d.xml) {
    cambios.xml_path = await G.sbSubir(BUCKET, base + '.xml', texto(d.xml), 'application/xml');
  }
  const resp = d.respuestaXml || d.xmlRespuesta || d.respuesta;
  if (resp) {
    cambios.xml_resp_path = await G.sbSubir(BUCKET, base + '-respuesta.xml',
      texto(resp), 'application/xml');
  }
  if (d.pdf) {
    cambios.pdf_path = await G.sbSubir(BUCKET, base + '.pdf',
      Buffer.from(String(d.pdf).replace(/^data:.*;base64,/, ''), 'base64'), 'application/pdf');
  }

  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, cambios);
  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    estado: 'hecho', terminado_en: new Date().toISOString(),
  });

  return { id: t.id, ok: true, archivos: Object.keys(cambios).filter(k => k.endsWith('_path')) };
}

// GTI puede mandar el XML como texto plano o en base64; se acepta cualquiera.
function texto(v) {
  const s = String(v || '');
  if (/^\s*</.test(s)) return s;
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch (e) { return s; }
}
