// ══════════════════════════════════════════════════════════════════════════════
// EL ÚNICO ARCHIVO QUE HAY QUE AJUSTAR CON EL MANUAL DE GTI
//
// Todo lo demás del puente (la cola, el sondeo, el guardado del XML y el PDF,
// la bitácora, el manejo de errores) ya está resuelto y no depende de GTI.
// Lo que falta es la traducción: cómo se llama cada campo en el JSON de
// «Carga Factura» y en qué ruta se manda.
//
// Los nombres de abajo están armados con lo que sí es público: el esquema 4.4
// de Hacienda, que es el que GTI convierte a XML. La estructura de datos es
// la correcta; los NOMBRES de las llaves y las RUTAS hay que confirmarlos
// contra el manual de 68 páginas. Cada uno está marcado con « ⚠ manual ».
//
// No se inventa nada más allá de eso a propósito: una factura electrónica es
// un documento fiscal, y un campo mal armado lo rechaza Hacienda con un
// código que después hay que ir a descifrar.
//
// Mientras GTI_SIMULADOR=1, este archivo igual se ejecuta completo: así se
// prueba que el documento arme bien, aunque no salga a ningún lado.
// ══════════════════════════════════════════════════════════════════════════════

// ── Rutas del servicio ──────────────────────────────────────────────────────
// ⚠ manual: confirmar las tres rutas y si van sobre la misma URL base.
const RUTAS = {
  emitir:    '/api/v1/comprobantes',
  estado:    '/api/v1/comprobantes/estado',
  descargar: '/api/v1/comprobantes/archivos',
};

// ── Tipos de comprobante (esto sí es de Hacienda, no de GTI) ────────────────
const TIPO_DOC = {
  FE:  '01',   // factura electrónica
  ND:  '02',   // nota de débito
  NC:  '03',   // nota de crédito
  TE:  '04',   // tiquete electrónico
  FEC: '08',   // factura electrónica de compra
};

// ── Unidades de medida de Hacienda ──────────────────────────────────────────
// A la izquierda lo que se imprime en la proforma; a la derecha el código que
// acepta Hacienda. Lo que no esté en la tabla sale como 'Unid'.
const UNIDAD_COD = {
  'Unid': 'Unid', 'Unidad': 'Unid',
  'm²': 'm2', 'm2': 'm2',
  'm³': 'm3', 'm3': 'm3',
  'ml': 'm', 'm': 'm',
  'kg': 'kg', 'Saco': 'Unid', 'Galón': 'Gal', 'Estañón': 'Unid',
  'Día': 'Sp', 'Hora': 'h', 'Sp': 'Sp', 'Global': 'Sp', 'Juego': 'Unid',
};

function unidadCod(u) {
  return UNIDAD_COD[String(u || '').trim()] || 'Unid';
}

// Hacienda trabaja con 5 decimales en cantidades y precios, y 2 en totales.
function d5(n) { return Number(Number(n || 0).toFixed(5)); }
function d2(n) { return Number(Number(n || 0).toFixed(2)); }

// ── El receptor ─────────────────────────────────────────────────────────────
function receptor(cli, doc) {
  // Sin cliente en fact_clientes no se factura: lo bloquea la revisión previa
  // antes de llegar acá, pero se vuelve a verificar por si acaso.
  if (!cli) throw new Error('El documento no tiene cliente de facturación ligado.');

  const ident = String(cli.identificacion || '').replace(/\D/g, '');
  if (!ident) throw new Error('El cliente no tiene cédula.');
  if (!cli.correo) throw new Error('El cliente no tiene correo y Hacienda lo exige.');

  const r = {
    // ⚠ manual
    nombre: String(cli.nombre || doc.cliente_nombre || '').slice(0, 100),
    identificacion: { tipo: String(cli.tipo_identificacion || 2).padStart(2, '0'), numero: ident },
    correoElectronico: String(cli.correo).trim(),
  };

  if (cli.nombre_comercial) r.nombreComercial = String(cli.nombre_comercial).slice(0, 80);
  if (cli.telefono) {
    r.telefono = { codigoPais: String(cli.cod_pais || '506'),
                   numTelefono: String(cli.telefono).replace(/\D/g, '') };
  }

  // La ubicación es opcional para una persona física, pero si va, va completa:
  // Hacienda rechaza una provincia sin cantón.
  if (cli.provincia && cli.canton && cli.distrito) {
    r.ubicacion = {
      provincia: String(cli.provincia),
      canton: String(cli.canton),
      distrito: String(cli.distrito),
      barrio: cli.barrio ? String(cli.barrio) : undefined,
      otrasSenas: String(cli.otras_senales || cli.direccion || 'Sin otras señas').slice(0, 250),
    };
  }

  // Los correos en copia son de GTI, no de Hacienda: GTI los usa para enviar
  // el comprobante a más de una dirección.
  const copia = Array.isArray(cli.correos_copia) ? cli.correos_copia.filter(Boolean) : [];
  if (copia.length) r.correosCopia = copia;   // ⚠ manual

  return r;
}

// ── Una línea ───────────────────────────────────────────────────────────────
function linea(l, i, doc) {
  const cabys = String(l.cabys || '').replace(/\D/g, '');
  if (cabys.length !== 13) {
    throw new Error('La línea «' + (l.descripcion || i + 1) + '» no tiene CABYS de 13 dígitos.');
  }
  const cant = d5(l.cantidad);
  const precio = d5(l.precio_unitario);
  if (precio <= 0) {
    throw new Error('La línea «' + (l.descripcion || i + 1) + '» tiene precio en 0.');
  }

  const montoTotal = d2(cant * precio);
  const desc = d2(l.descuento_monto);
  const subtotal = d2(montoTotal - desc);
  const ivaPct = Number(l.iva_pct != null ? l.iva_pct : doc.iva_pct || 13);
  const ivaMonto = d2(subtotal * ivaPct / 100);

  const o = {
    // ⚠ manual
    numeroLinea: i + 1,
    codigoCabys: cabys,
    cantidad: cant,
    unidadMedida: l.unidad_cod || unidadCod(l.unidad),
    detalle: String(l.descripcion || '').slice(0, 200),
    precioUnitario: precio,
    montoTotal: montoTotal,
    subTotal: subtotal,
    montoTotalLinea: d2(subtotal + ivaMonto),
    impuesto: [{
      codigo: '01',              // IVA
      codigoTarifa: tarifaIVA(ivaPct),
      tarifa: ivaPct,
      monto: ivaMonto,
    }],
    impuestoNeto: ivaMonto,
  };

  if (l.codigo) o.codigoComercial = [{ tipo: '04', codigo: String(l.codigo).slice(0, 20) }];
  if (desc > 0) {
    o.descuento = [{ montoDescuento: desc,
                     naturalezaDescuento: String(l.descuento_motivo || 'Descuento comercial').slice(0, 80) }];
  }

  // Exoneración, si el cliente la tiene en esta línea.
  if (l.exo_numero && Number(l.exo_pct) > 0) {
    o.impuesto[0].exoneracion = {
      tipoDocumento: String(l.exo_tipo_doc || '01'),
      numeroDocumento: String(l.exo_numero),
      nombreInstitucion: String(l.exo_institucion || ''),
      fechaEmision: l.exo_fecha,
      porcentajeExoneracion: Number(l.exo_pct),
      montoExoneracion: d2(ivaMonto * Number(l.exo_pct) / 100),
    };
  }

  return o;
}

// Códigos de tarifa del IVA en Hacienda. Los tres regímenes que usa CONCRE
// son el general y las reducidas; el resto queda por si aparece.
function tarifaIVA(pct) {
  const p = Number(pct);
  if (p === 0) return '01';
  if (p === 1) return '02';
  if (p === 2) return '03';
  if (p === 4) return '04';
  if (p === 8) return '06';
  if (p === 13) return '08';
  return '08';
}

// ── El documento completo ───────────────────────────────────────────────────
function armar(doc, lineas, cliente, empresa, cred) {
  if (!lineas || !lineas.length) throw new Error('El documento no tiene líneas.');

  const det = lineas
    .slice()
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map((l, i) => linea(l, i, doc));

  const gravado = d2(det.reduce((s, l) => s + l.subTotal, 0));
  const descuento = d2(det.reduce((s, l) => s + ((l.descuento || [{}])[0].montoDescuento || 0), 0));
  const impuesto = d2(det.reduce((s, l) => s + l.impuestoNeto, 0));

  const cuerpo = {
    // ── Lo que identifica la cuenta en GTI ──
    // ⚠ manual: puede ir en el cuerpo o en un encabezado de autenticación.
    usuario: cred.usuario,
    clave: cred.clave,
    numCuenta: cred.cuenta,

    // ── El comprobante ──
    // ⚠ manual: la clave de 50 dígitos y el consecutivo de 20 los asigna GTI.
    // Si el manual dice que los tiene que mandar el cliente, hay que agregar
    // acá el generador y usar fact_consecutivos, que ya quedó preparada.
    tipoDocumento: TIPO_DOC[doc.tipo_doc] || TIPO_DOC.FE,
    fechaEmision: new Date().toISOString(),
    condicionVenta: String(doc.cond_venta || '01'),
    medioPago: [String(doc.medio_pago || '01')],
    codigoMoneda: String(doc.moneda || 'CRC'),

    emisor: {
      // Todo esto sale de fact_empresas, editable desde la pestaña.
      nombre: String(empresa.razon_social || empresa.nombre_comercial || ''),
      identificacion: { tipo: String(empresa.tipo_identificacion || 2).padStart(2, '0'),
                        numero: String(empresa.identificacion || '').replace(/\D/g, '') },
      nombreComercial: String(empresa.nombre_comercial || ''),
      actividadEconomica: String(empresa.actividad_economica || ''),
      correoElectronico: String(empresa.correo || ''),
      ubicacion: {
        provincia: String(empresa.provincia || ''),
        canton: String(empresa.canton || ''),
        distrito: String(empresa.distrito || ''),
        otrasSenas: String(empresa.direccion || '').slice(0, 250),
      },
    },

    receptor: receptor(cliente, doc),
    detalleServicio: det,

    resumenFactura: {
      totalGravado: gravado,
      totalExento: 0,
      totalVenta: d2(gravado + descuento),
      totalDescuentos: descuento,
      totalVentaNeta: gravado,
      totalImpuesto: impuesto,
      totalComprobante: d2(gravado + impuesto),
    },
  };

  if (String(doc.cond_venta) === '02') {
    cuerpo.plazoCredito = String(doc.plazo_credito || 30);
  }
  if (String(doc.moneda) === 'USD') {
    const tc = Number(doc.tipo_cambio);
    if (!(tc > 0)) throw new Error('El documento está en dólares y no tiene tipo de cambio.');
    cuerpo.tipoCambio = d5(tc);
  }
  if (doc.notas) cuerpo.otros = String(doc.notas).slice(0, 500);

  // Referencia, para notas de crédito y débito.
  if (doc.ref_clave) {
    cuerpo.informacionReferencia = [{
      tipoDoc: String(doc.ref_tipo_doc || '01'),
      numero: String(doc.ref_clave),
      fechaEmision: doc.ref_fecha,
      codigo: String(doc.ref_codigo || '01'),
      razon: String(doc.ref_razon || '').slice(0, 180),
    }];
  }

  // El total que arma el puente tiene que coincidir con el que muestra la
  // pestaña. Si no coincide, algo se calculó distinto y es mejor parar acá
  // que mandarle a Hacienda un documento que no cuadra con lo que el cliente
  // vio en la proforma.
  const totalDoc = d2(doc.total);
  const totalArmado = cuerpo.resumenFactura.totalComprobante;
  if (totalDoc > 0 && Math.abs(totalDoc - totalArmado) > 1) {
    throw new Error('El total del documento (' + totalDoc + ') no coincide con el que se armó ('
      + totalArmado + '). Revise las líneas antes de emitir.');
  }

  return cuerpo;
}

// ── Lectura de la respuesta de GTI ──────────────────────────────────────────
// Se leen varios nombres posibles porque no está confirmado cuál usa: así el
// puente funciona con cualquiera de ellos y el manual solo confirma. Lo que
// no se reconozca queda igual en la bitácora, sin perderse.

function leerEmision(datos) {
  const d = datos || {};
  return {
    clave: d.clave || d.Clave || d.claveNumerica || null,
    consecutivo: d.consecutivo || d.numeroConsecutivo || d.NumeroConsecutivo || null,
    gtiId: d.id || d.idComprobante || d.token || null,
    estado: normalizarEstado(d.estado || d.Estado || d.status),
    mensaje: d.mensaje || d.Mensaje || d.detalle || d.descripcion || null,
  };
}

function leerEstado(datos) {
  const d = datos || {};
  return {
    estado: normalizarEstado(d.estado || d.Estado || d.status || d.indEstado),
    mensaje: d.mensaje || d.Mensaje || d.detalleMensaje || d.descripcion || null,
    xml: d.xml || d.xmlFirmado || null,
    xmlRespuesta: d.respuestaXml || d.xmlRespuesta || d.respuesta || null,
  };
}

// Lo que diga GTI se traduce a los estados de fact_docs.
function normalizarEstado(e) {
  const s = String(e || '').toLowerCase();
  if (!s) return null;
  if (/acept/.test(s)) return 'aceptado';
  if (/rechaz/.test(s)) return 'rechazado';
  if (/recib|proces|pendien|enviad/.test(s)) return 'recibido';
  if (/error|fall/.test(s)) return 'error';
  return 'recibido';
}

// ── Respuestas del simulador ────────────────────────────────────────────────
// Imitan el camino real: primero «recibido», y a partir del segundo sondeo
// «aceptado». Así se puede ver la pestaña completa funcionando sin GTI.

function simularEmision(doc) {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const aa = String(hoy.getFullYear()).slice(2);
  const ced = '3101846556'.padStart(12, '0');
  const cons = '001' + '00001' + '01' + String(Date.now()).slice(-10);
  const seg = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return {
    clave: '506' + dd + mm + aa + ced + cons + '1' + seg,
    consecutivo: cons,
    id: 'sim_' + Date.now(),
    estado: 'recibido',
    mensaje: 'SIMULADO — no salió a GTI ni a Hacienda',
  };
}

// Se decide por el tiempo transcurrido desde el envío, NO por el número de
// intento: cada consulta de estado es un trabajo distinto en la cola y todos
// llegan con su propio contador en cero, así que contando intentos el
// simulado nunca pasaba de «recibido» y el camino no terminaba nunca.
//
// Con el tiempo queda igual al camino real: la consulta de los 30 segundos
// dice «en proceso» y la de los 2 minutos ya dice «aceptado».
const SIM_SEG_ACEPTA = 60;

function simularEstado(doc) {
  const desde = doc && doc.enviado_en ? new Date(doc.enviado_en).getTime() : 0;
  const seg = desde ? (Date.now() - desde) / 1000 : 999;

  if (seg >= SIM_SEG_ACEPTA) {
    return { estado: 'aceptado',
             mensaje: 'SIMULADO — aceptado (no salió a GTI ni a Hacienda)',
             xml: '<?xml version="1.0"?><FacturaElectronica><!-- simulado --></FacturaElectronica>',
             respuestaXml: '<?xml version="1.0"?><MensajeHacienda><Mensaje>1</Mensaje>'
                         + '<DetalleMensaje>SIMULADO</DetalleMensaje></MensajeHacienda>' };
  }
  return { estado: 'recibido', mensaje: 'SIMULADO — en proceso en Hacienda' };
}

module.exports = {
  RUTAS, TIPO_DOC, unidadCod, tarifaIVA,
  armar, leerEmision, leerEstado, normalizarEstado,
  simularEmision, simularEstado,
};
