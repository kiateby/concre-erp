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
//
// Dato clave del manual: después de emitir, TODO se consulta con el
// CONSECUTIVO de 20 dígitos que devolvió GTI, no con la clave de 50. Por eso
// consecutivo_fiscal se guarda antes que nada y es lo que amarra el resto.
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
// más tarde; después queda fallido.
//
// Solo la EMISIÓN puede dejar el documento en 'error'. Si lo que falló fue
// bajar el XML o preguntar el estado de un comprobante que Hacienda ya aceptó,
// el documento sigue aceptado: marcarlo como error sería mentir sobre un
// documento fiscal que existe. Se anota el problema y se deja el estado.
async function fallar(t, e) {
  const msg = String(e.message || e).slice(0, 900);
  const reintentar = (t.intentos || 0) + 1 < MAX_INTENTOS && !e.configuracion;

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, reintentar
    ? { estado: 'pendiente', error: msg,
        correr_en: new Date(Date.now() + 60000 * Math.pow(3, t.intentos || 0)).toISOString() }
    : { estado: 'fallido', error: msg, terminado_en: new Date().toISOString() });

  if (!reintentar) {
    const cambios = { actualizado_en: new Date().toISOString() };
    if (t.accion === 'emitir') {
      cambios.estado_hacienda = 'error';
      cambios.estado_hacienda_msg = msg;
    } else {
      cambios.estado_hacienda_msg = 'Aviso al ' + (t.accion === 'estado'
        ? 'consultar el estado' : 'bajar los archivos') + ': ' + msg;
    }
    await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, cambios).catch(() => {});
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

  const r = await G.llamarGTI(cred, P.METODOS.emitir, {
    cuerpo: cuerpo,
    simular: () => P.simularEmision(doc),
  });

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    enviado: G.sinSecretos(cuerpo), respuesta: G.sinSecretos(r.datos),
    http_status: r.status,
  });

  // GTI contesta 202 (Accepted), no 200: fetch lo da como ok, pero se deja
  // dicho acá para que no se «arregle» a 200 en el futuro.
  if (!r.ok) throw new Error(r.error || ('GTI respondió ' + r.status + ': ' +
    JSON.stringify(r.datos || {}).slice(0, 400)));

  const e = P.leerEmision(r.datos);
  if (!e.clave || !e.consecutivo) {
    throw new Error('GTI no devolvió '
      + (!e.clave && !e.consecutivo ? 'la clave ni el consecutivo'
         : !e.clave ? 'la clave' : 'el consecutivo')
      + (e.mensaje ? ' — ' + e.mensaje : '')
      + '. Respuesta: ' + JSON.stringify(G.sinSecretos(r.datos) || {}).slice(0, 400));
  }

  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, {
    clave: e.clave,
    consecutivo_fiscal: e.consecutivo,
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

  return { id: t.id, ok: true, clave: e.clave, consecutivo: e.consecutivo, estado: e.estado };
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
  if (!doc.consecutivo_fiscal) {
    throw new Error('el documento no tiene consecutivo de GTI: todavía no se emitió');
  }

  const emp = (await G.sbGet('fact_empresas', 'id=eq.' + doc.empresa_id + '&limit=1'))[0];
  const cred = G.credenciales(doc.empresa_id, emp && emp.gti_ambiente);

  const r = await G.llamarGTI(cred, P.METODOS.estado, {
    consecutivo: doc.consecutivo_fiscal,
    simular: () => P.simularEstado(doc),
  });

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    enviado: { metodo: r.metodo, consecutivo: doc.consecutivo_fiscal },
    respuesta: G.sinSecretos(r.datos), http_status: r.status,
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

  // Aceptado: hay que bajar el XML y el PDF. GTI los entrega dentro de los
  // tres días; si se pierde la ventana, no se recuperan. Se espera 45 segundos
  // porque el PDF no está listo en el mismo instante en que Hacienda acepta.
  if (e.estado === 'aceptado' && !doc.xml_path) {
    await G.sbInsert('fact_emisiones', [{
      empresa_id: doc.empresa_id, doc_id: t.doc_id, accion: 'descargar',
      estado: 'pendiente', correr_en: new Date(Date.now() + 45000).toISOString(),
      usuario_id: t.usuario_id, usuario_nombre: t.usuario_nombre,
    }]);
  }

  return { id: t.id, ok: true, estado: e.estado, codigo: e.codigo };
}

// ── Bajar el XML y el PDF ───────────────────────────────────────────────────
// Son tres llamadas distintas: el XML enviado, el XML de respuesta de Hacienda
// y el PDF. Cada una se salta si ya está guardada, para que un reintento por
// el PDF no vuelva a pedir los XML — el PDF tiene límite de frecuencia y de
// una sola petición por documento.
async function descargar(t) {
  const doc = (await G.sbGet('fact_docs', 'id=eq.' + t.doc_id + '&limit=1'))[0];
  if (!doc) throw new Error('el documento ya no existe');
  if (!doc.consecutivo_fiscal) throw new Error('el documento no tiene consecutivo de GTI');

  const emp = (await G.sbGet('fact_empresas', 'id=eq.' + doc.empresa_id + '&limit=1'))[0];
  const cred = G.credenciales(doc.empresa_id, emp && emp.gti_ambiente);

  const cons = doc.consecutivo_fiscal;
  const base = doc.empresa_id + '/' + String(doc.fecha || '').slice(0, 4) + '/' +
               (doc.clave || cons);
  const cambios = {};
  const bajados = [];

  if (!doc.xml_path) {
    const r = await G.llamarGTI(cred, P.METODOS.xmlEnviado, {
      consecutivo: cons, simular: () => ({ xml: P.simularXml('enviado') }),
    });
    if (!r.ok) throw new Error('XML enviado: ' + (r.error || 'GTI respondió ' + r.status));
    const x = xmlDe(r.datos);
    if (x) {
      cambios.xml_path = await G.sbSubir(BUCKET, base + '.xml', x, 'application/xml');
      bajados.push('xml');
    }
  }

  if (!doc.xml_resp_path) {
    const r = await G.llamarGTI(cred, P.METODOS.xmlRespuesta, {
      consecutivo: cons, simular: () => ({ xml: P.simularXml('respuesta') }),
    });
    if (!r.ok) throw new Error('XML de respuesta: ' + (r.error || 'GTI respondió ' + r.status));
    const x = xmlDe(r.datos);
    if (x) {
      cambios.xml_resp_path = await G.sbSubir(BUCKET, base + '-respuesta.xml', x, 'application/xml');
      bajados.push('respuesta');
    }
  }

  // Se guarda lo que ya se bajó antes de pedir el PDF: si el PDF falla y el
  // trabajo se reintenta, los XML no se vuelven a pedir.
  if (Object.keys(cambios).length) {
    await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, cambios);
  }

  let avisoPdf = null;
  if (!doc.pdf_path) {
    const r = await G.llamarGTI(cred, P.METODOS.pdf, {
      consecutivo: cons, simular: () => P.simularPdf(),
    });
    if (!r.ok) throw new Error('PDF: ' + (r.error || 'GTI respondió ' + r.status));

    const p = P.leerPdf(r.datos);
    if (p.ok) {
      const ruta = await G.sbSubir(BUCKET, base + '.pdf',
        Buffer.from(p.base64.replace(/^data:.*;base64,/, ''), 'base64'), 'application/pdf');
      await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, { pdf_path: ruta });
      bajados.push('pdf');
    } else if (p.reintentar) {
      // Códigos 3, 6 y 7 del manual: volver a intentar más tarde. Se levanta
      // el error para que la cola lo reprograme; los XML ya quedaron guardados.
      throw new Error('PDF: ' + (p.mensaje || 'GTI pidió reintentar') +
        ' (código ' + p.codigo + ')');
    } else {
      // El PDF no es indispensable: se puede volver a armar desde el XML, que
      // es el documento fiscal. Se anota y no se marca el documento en error.
      avisoPdf = 'No se pudo bajar el PDF de GTI' +
        (p.mensaje ? ': ' + p.mensaje : '') + (p.codigo != null ? ' (código ' + p.codigo + ')' : '');
    }
  }

  await G.sbPatch('fact_docs', 'id=eq.' + t.doc_id, Object.assign(
    { archivos_en: new Date().toISOString() },
    avisoPdf ? { estado_hacienda_msg: avisoPdf } : {}));

  await G.sbPatch('fact_emisiones', 'id=eq.' + t.id, {
    estado: 'hecho', error: avisoPdf || null, terminado_en: new Date().toISOString(),
  });

  return { id: t.id, ok: true, archivos: bajados, aviso: avisoPdf };
}

// GTI devuelve el XML como cuerpo de la respuesta. Se acepta también en base64
// por si algún método lo entrega así.
function xmlDe(datos) {
  const s = String((datos && (datos.xml || datos.Datos || datos.datos)) || '');
  if (!s.trim()) return null;
  if (/^\s*</.test(s)) return s;
  try {
    const t = Buffer.from(s, 'base64').toString('utf8');
    return /^\s*</.test(t) ? t : s;
  } catch (e) { return s; }
}
