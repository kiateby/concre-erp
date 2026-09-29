// ══════════════════════════════════════════════════════════════════════════════
// LA TRADUCCIÓN A GTI — armado del JSON y lectura de las respuestas
//
// Este archivo es el único que conoce el contrato de «API Carga Factura 4.4»
// de GTI. Todo lo demás del puente (la cola, el sondeo, el guardado del XML y
// del PDF, la bitácora, los reintentos) no depende de GTI y no se toca.
//
// Está armado contra el «Instructivo técnico para el uso del API Carga Factura
// 4.4» (v1.0, 1/9/2026), que reemplazó las suposiciones que había antes. Cada
// número de código lleva al lado la tabla del manual de donde salió, para que
// el día que Hacienda cambie una tabla se sepa exactamente qué corregir.
//
// Tres cosas del manual cambian el diseño respecto de lo que se había supuesto:
//
//   1. Las credenciales van en la QUERY STRING (pNumCuenta, pUsuario, pClave),
//      no en el cuerpo. El cuerpo es solo el comprobante.
//   2. GTI asigna la clave de 50 dígitos y el consecutivo de 20. No se mandan.
//      Y a partir de ahí, TODO se consulta por el consecutivo que devolvió GTI,
//      no por la clave: por eso consecutivo_fiscal es un dato crítico.
//   3. Los datos del emisor NO se envían: GTI los toma de la cuenta. Del nodo
//      Emisor solo existe Registrofiscal8707, que es de bebidas alcohólicas.
//
// Mientras GTI_SIMULADOR=1 este archivo se ejecuta completo igual: así se
// prueba que el documento arme bien aunque no salga a ningún lado.
// ══════════════════════════════════════════════════════════════════════════════

// ── Métodos del servicio ────────────────────────────────────────────────────
// Todos cuelgan de la misma base: .../ApiCargaFactura/api/Documentos/<método>
//
//   pruebas     https://pruebas.gticr.com/AplicacionFEPruebas/ApiCargaFactura/api/Documentos
//   producción  https://www.facturaelectronica.cr/ApiCargaFactura/api/Documentos
//
// «params» dice qué lleva la query aparte de la cuenta, el usuario y la clave.
// «pdf» es el único GET, y el único que nombra los parámetros SIN el prefijo p.
const METODOS = {
  emitir:      { ruta: 'CargarDocumento',        verbo: 'POST', cuerpo: true,  respuesta: 'json' },
  estado:      { ruta: 'EstadoHacienda',         verbo: 'POST', consecutivo: true, respuesta: 'json' },
  estadoCorreo:{ ruta: 'EstadoCorreo',           verbo: 'POST', consecutivo: true, respuesta: 'json' },
  xmlEnviado:  { ruta: 'ConsultaXMLEnviado',     verbo: 'POST', consecutivo: true, respuesta: 'xml'  },
  xmlRespuesta:{ ruta: 'ConsultaXMLRespuesta',   verbo: 'POST', consecutivo: true, respuesta: 'xml'  },
  pdf:         { ruta: 'ObtenerBytesPdfEmision', verbo: 'GET',  consecutivo: true, respuesta: 'json',
                 sinPrefijo: true },
  reenviar:    { ruta: 'ReenviarCorreo',         verbo: 'POST', consecutivo: true, respuesta: 'json' },
};

// ── Tabla 1 · TipoDoc ───────────────────────────────────────────────────────
// Entero, no cadena de dos dígitos: el manual da el código pelado.
const TIPO_DOC = {
  FE:  1,   // factura electrónica
  ND:  2,   // nota de débito
  NC:  3,   // nota de crédito
  TE:  4,   // tiquete electrónico
  FEC: 8,   // factura electrónica de compra
  FEE: 9,   // factura de exportación
  REP: 10,  // recibo electrónico de pago
};

// ── Tabla 8 · TipoDocRef ────────────────────────────────────────────────────
// El tipo del documento AL QUE la nota se refiere.
const TIPO_DOC_REF = {
  FE: 1, ND: 2, NC: 3, TE: 4,
  FEC_NC: 17,   // nota de crédito a factura electrónica de compra
  FEC_ND: 18,   // nota de débito a factura electrónica de compra
  OTRO: 99,
};

// ── Tabla 7 · AccionRef ─────────────────────────────────────────────────────
// Por qué esta nota se refiere a aquel comprobante. La versión 4.4 no tiene
// «corrige texto»: un dato mal escrito se arregla anulando y volviendo a
// facturar, no con una nota parcial.
const ACCION_REF = {
  anula:              1,
  corrige_monto:      2,
  otro_documento:     4,
  devolucion:         6,
  sustituye:          7,
  nc_financiera:      9,
  nd_financiera:      10,
  anula_error_mat:    13,
  corrige_error_mat:  14,
  otros:              99,
};

// Los motivos como los ve el usuario en la pestaña. La pestaña guarda la LLAVE
// ('anula', 'devolucion'…) y acá se resuelve al número, para que el número de
// Hacienda viva en un solo archivo y corregirlo no obligue a tocar el
// index.html ni a migrar notas ya guardadas.
const MOTIVOS_NOTA = {
  NC: [
    {v:'anula',       lbl:'Anular la factura completa', cod:'anula',         todo:true,
     ayuda:'La factura queda sin efecto. Se usa cuando se facturó por error o el trabajo no se hizo.'},
    {v:'devolucion',  lbl:'Devolución parcial',         cod:'devolucion',    todo:false,
     ayuda:'El cliente devolvió parte de lo facturado. Se escogen las líneas y las cantidades devueltas.'},
    {v:'descuento',   lbl:'Descuento acordado después', cod:'corrige_monto', todo:false,
     ayuda:'Se rebaja el monto de una o varias líneas por un acuerdo posterior a la factura.'},
    {v:'error_monto', lbl:'Error en el monto facturado',cod:'corrige_monto', todo:false,
     ayuda:'Se cobró de más. La nota rebaja la diferencia.'},
  ],
  ND: [
    {v:'cobro_mas',   lbl:'Se facturó de menos',        cod:'corrige_monto', todo:false,
     ayuda:'Hay que cobrar la diferencia sobre lo que ya se facturó.'},
    {v:'cargo_extra', lbl:'Cargo adicional',            cod:'corrige_monto', todo:false,
     ayuda:'Algo que se suma después: trabajo extra, materiales, intereses.'},
  ],
};

// ── Tabla 3 · CondicionVenta ────────────────────────────────────────────────
const COND_VENTA = { contado: 1, credito: 2, otros: 99 };

// ── Tabla 4 · MedioPagos ────────────────────────────────────────────────────
const MEDIO_PAGO = {
  efectivo: 1, tarjeta: 2, cheque: 3, transferencia: 4,
  terceros: 5, sinpe: 6, plataforma: 7, otros: 99,
};

// ── Tabla 11 · Moneda ───────────────────────────────────────────────────────
const MONEDA = { CRC: 1, USD: 2, EUR: 3 };

// ── Tabla 5 · CodigoImp · y Tabla 6 · CodigoTarifa ──────────────────────────
const IMP_IVA = 1;                     // impuesto al valor agregado

// De porcentaje de IVA al código de tarifa. Los que usa CONCRE son el general
// y el exento; el resto queda por si aparece.
const TARIFA = {
  0:    1,   // tarifa 0% (art. 32, num 1, RLIVA)
  1:    2,
  2:    3,
  4:    4,
  8:    7,   // transitorio 8%
  13:   8,   // tarifa general
  0.5:  9,
};
const TARIFA_EXENTA = 10;

// ── Tabla 14 · SituacionEnvio ───────────────────────────────────────────────
const SITUACION_NORMAL = 1;

// ── Tabla 13 · UnidadMedida ─────────────────────────────────────────────────
// El código es un ENTERO, no la abreviatura. La tabla del manual además marca
// cada unidad como servicio o mercancía, y de esa marca depende en qué columna
// de Totales cae la línea — por eso va acá y no en la pestaña.
//
// A la izquierda están tanto los nombres que usa el catálogo de CONCRE como
// las abreviaturas de Hacienda, porque las líneas viejas guardaron en
// unidad_cod la abreviatura ('Unid', 'm2', 'Sp') de cuando así se creía.
const UNIDADES = {
  // mercancías
  'unidad': {c:1,  s:false}, 'unid': {c:1,  s:false}, 'und': {c:1, s:false},
  'saco':   {c:1,  s:false}, 'estañón': {c:1, s:false}, 'estanon': {c:1, s:false},
  'juego':  {c:1,  s:false}, 'tarima': {c:1, s:false},
  'kg':     {c:2,  s:false}, 'kilogramo': {c:2, s:false},
  'oz':     {c:4,  s:false},
  'l':      {c:5,  s:false}, 'litro': {c:5, s:false},
  'gal':    {c:7,  s:false}, 'galón': {c:7, s:false}, 'galon': {c:7, s:false},
  'm':      {c:10, s:false}, 'metro': {c:10, s:false}, 'ml': {c:10, s:false},
  'ml lineal': {c:10, s:false},
  'mlt':    {c:19, s:false},
  'g':      {c:20, s:false}, 'gramo': {c:20, s:false},
  't':      {c:23, s:false}, 'tonelada': {c:23, s:false},
  'm²':     {c:30, s:false}, 'm2': {c:30, s:false},
  'm³':     {c:31, s:false}, 'm3': {c:31, s:false},
  'cm':     {c:93, s:false},
  'mm':     {c:94, s:false},
  'qq':     {c:114, s:false}, 'quintal': {c:114, s:false},
  // servicios
  'min':    {c:12,  s:true}, 'minuto': {c:12, s:true},
  'h':      {c:13,  s:true}, 'hora': {c:13, s:true},
  'd':      {c:14,  s:true}, 'día': {c:14, s:true}, 'dia': {c:14, s:true},
  'sp':     {c:24,  s:true}, 'servicios profesionales': {c:24, s:true},
  'km':     {c:91,  s:true},
  'alc':    {c:97,  s:true},
  'cm2':    {c:98,  s:true}, 'comisiones': {c:98, s:true},
  'os':     {c:100, s:true}, 'global': {c:100, s:true}, 'otro servicio': {c:100, s:true},
  'st':     {c:102, s:true}, 'servicios técnicos': {c:102, s:true},
  'kwh':    {c:112, s:true},
};
const UNIDAD_POR_DEFECTO = { c: 1, s: false };

function _unidadInfo(u) {
  const t = String(u == null ? '' : u).trim();
  if (!t) return UNIDAD_POR_DEFECTO;

  // Ya viene como código de Hacienda
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    for (const k of Object.keys(UNIDADES)) if (UNIDADES[k].c === n) return UNIDADES[k];
    return { c: n, s: false };
  }
  return UNIDADES[t.toLowerCase()] || UNIDAD_POR_DEFECTO;
}

// Código de Hacienda de una unidad, como entero.
function unidadCod(u) { return _unidadInfo(u).c; }

// ¿Esta unidad es de servicio? Decide en qué columna de Totales cae la línea.
// Ojo: para Hacienda el m² es MERCANCÍA aunque lo que CONCRE venda por m² sea
// mano de obra. La clasificación es de la tabla, no del criterio comercial, y
// así es como la pide GTI.
function esServicio(u) { return !!_unidadInfo(u).s; }

// ── Redondeo, como lo pide el manual ────────────────────────────────────────
// Media unidad SUBE, y se redondea sobre la representación DECIMAL, no sobre
// el binario: (2.675).toFixed(2) da 2.67 porque en binario 2.675 es
// 2.67499999…, y el manual dice explícitamente que ese 5 sube a 2.68.
// Dos decimales en totales, cinco en montos unitarios.
function red(n, dec) {
  const x = Number(n || 0);
  if (!isFinite(x)) return 0;
  const f = Math.pow(10, dec);
  const y = Number(x.toPrecision(15)) * f;
  const ent = Math.floor(Math.abs(y));
  const frac = Number((Math.abs(y) - ent).toPrecision(12));
  const r = (frac >= 0.5 ? ent + 1 : ent) * (x < 0 ? -1 : 1);
  return r / f;
}
function d2(n) { return red(n, 2); }
function d5(n) { return red(n, 5); }
function d3(n) { return red(n, 3); }

// ── Fechas ──────────────────────────────────────────────────────────────────
// El manual pide YYYY-MM-DDTHH:mm:ss, sin zona. Un ISO con «Z» se lo manda a
// GTI en UTC y la factura sale con la hora corrida seis horas.
function fechaGTI(v) {
  const f = v ? new Date(v) : new Date();
  if (isNaN(f.getTime())) return null;
  const off = 6 * 60;   // Costa Rica, sin horario de verano
  const l = new Date(f.getTime() - off * 60000);
  return l.toISOString().replace(/\.\d+Z$/, '');
}

// ── Texto ───────────────────────────────────────────────────────────────────
function txt(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}
function ent(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/\D/g, ''), 10);
  return isFinite(n) ? n : null;
}

// ── El receptor ─────────────────────────────────────────────────────────────
//
// En una factura de compra (FEC) el receptor es el VENDEDOR, que se digita en
// el momento: no está en fact_clientes y no debe estarlo, porque no es un
// cliente. Sus datos viven en el propio documento.
function receptorDeDoc(doc) {
  return {
    nombre: doc.cliente_nombre,
    tipo_identificacion: doc.cliente_tipo_ident,
    identificacion: doc.cliente_identificacion,
    actividad_economica: doc.cliente_actividad,
    correo: doc.cliente_correo,
    telefono: doc.cliente_telefono,
    cod_pais: doc.cliente_cod_pais,
    provincia: doc.cliente_provincia,
    canton: doc.cliente_canton,
    distrito: doc.cliente_distrito,
    barrio: doc.cliente_barrio,
    otras_senales: doc.cliente_otras_senales,
    direccion: doc.cliente_direccion,
    correos_copia: doc.cliente_correos_copia,
  };
}

function receptor(cli, doc) {
  if (!cli) throw new Error('El documento no tiene cliente de facturación ligado.');
  const esCompra = doc && doc.tipo_doc === 'FEC';

  const ident = txt(cli.identificacion).replace(/[^0-9A-Za-z]/g, '');
  if (!ident) {
    throw new Error(esCompra ? 'El vendedor no tiene cédula.' : 'El cliente no tiene cédula.');
  }

  const r = {
    Nombre: txt(cli.nombre || (doc && doc.cliente_nombre), 100),
    TipoIdent: Number(cli.tipo_identificacion || (esCompra ? 1 : 2)),
    Identificacion: ident.slice(0, 20),
  };

  // En una FEC el receptor tiene que estar inscrito ante Hacienda y su
  // actividad económica es obligatoria (el manual la marca solo para FEC).
  if (esCompra) {
    const act = txt(cli.actividad_economica || (doc && doc.cliente_actividad), 6);
    if (!act) {
      throw new Error('La factura de compra necesita la actividad económica del vendedor '
        + '(Hacienda la exige en este tipo de comprobante).');
    }
    r.ActividadEconomica = act;
  } else if (cli.actividad_economica) {
    r.ActividadEconomica = txt(cli.actividad_economica, 6);
  }

  if (cli.nombre_comercial) r.NombComercial = txt(cli.nombre_comercial, 80);

  // Al vendedor de una compra no se le puede exigir correo: muchas veces no
  // tiene, y el comprobante no se le manda a él — quien declara es CONCRE.
  const correo = txt(cli.correo);
  if (correo) r.Correo = correo;
  else if (!esCompra) {
    throw new Error('El cliente no tiene correo, y sin correo el comprobante no se le puede enviar.');
  }

  // Copia es una CADENA con los correos separados por «;», no un arreglo.
  const copia = (Array.isArray(cli.correos_copia) ? cli.correos_copia : [])
    .map(x => txt(x)).filter(Boolean);
  if (copia.length) r.Copia = copia.join(';').slice(0, 200);

  const tel = ent(cli.telefono);
  if (tel) {
    r.AreaTelefono = ent(cli.cod_pais) || 506;
    r.NumTelefono = tel;
  }

  // La dirección es opcional, pero si va, va completa: Hacienda rechaza una
  // provincia sin cantón, y exige las señas exactas si hay cualquier campo.
  const pr = ent(cli.provincia), ca = ent(cli.canton), di = ent(cli.distrito);
  const senas = txt(cli.otras_senales || cli.direccion, 160);
  if (pr && ca && di && senas.length >= 5) {
    r.Provincia = pr;
    r.Canton = ca;
    r.Distrito = di;
    r.Direccion = senas;
    // NombreBarrio es texto de 5 a 50 caracteres. Si lo que hay guardado es un
    // código numérico o una palabra de menos de 5 letras, no se manda: un
    // barrio mal armado tumba el comprobante entero.
    const ba = txt(cli.barrio, 50);
    if (ba.length >= 5 && !/^\d+$/.test(ba)) r.NombreBarrio = ba;
  }

  return r;
}

// ── Una línea de detalle ────────────────────────────────────────────────────
function linea(l, i, doc) {
  const cabys = txt(l.cabys).replace(/\D/g, '');
  if (cabys.length !== 13) {
    throw new Error('La línea «' + (l.descripcion || (i + 1)) + '» no tiene CABYS de 13 dígitos.');
  }

  const cant = d3(l.cantidad);
  if (!(cant > 0)) {
    throw new Error('La línea «' + (l.descripcion || (i + 1)) + '» tiene cantidad en 0.');
  }
  const precio = d5(l.precio_unitario);
  if (!(precio > 0)) {
    throw new Error('La línea «' + (l.descripcion || (i + 1)) + '» tiene precio en 0.');
  }
  const desc = txt(l.descripcion);
  if (!desc) throw new Error('La línea ' + (i + 1) + ' no tiene descripción.');

  const unid = l.unidad_cod != null && String(l.unidad_cod).trim() !== ''
    ? l.unidad_cod : l.unidad;

  const montoTotal = d2(cant * precio);
  const descuento = d2(l.descuento_monto);
  const neto = d2(montoTotal - descuento);

  const o = {
    Cantidad: cant,
    UnidadMedida: unidadCod(unid),
    PrecioUnitario: precio,
    Codigo: cabys,                       // Tabla 24 · CAByS
  };

  // El manual escribe este campo con tilde en la tabla de Detalle y sin tilde
  // en otras. Van los dos nombres con el mismo valor: el deserializador de GTI
  // toma el que conozca e ignora el otro, y así una tilde no tumba la emisión.
  o.Descripcion = txt(desc, 200);
  o['Descripción'] = o.Descripcion;

  if (l.unidad && !/^\d+$/.test(String(l.unidad)) && unidadCod(unid) === 1
      && String(l.unidad).trim().toLowerCase() !== 'unidad'
      && String(l.unidad).trim().toLowerCase() !== 'unid') {
    // Una unidad propia del giro («1 tarima», «1 saco») que Hacienda no tiene:
    // se declara como unidad 1 y el nombre real se manda en UnidadComercial.
    o.UnidadComercial = txt(l.unidad, 20);
  }

  if (descuento > 0) {
    o.MontoDescuento = descuento;
    o.CodigoDescuento = '07';            // Tabla 16 · descuento comercial
    if (l.descuento_motivo) o.DetalleDescuento = txt(l.descuento_motivo, 80);
  }

  if (l.codigo) {
    o.CodigoComercial = [{ Tipo: '01', Codigo: txt(l.codigo, 20) }];  // Tabla 10 · del vendedor
  }

  // ── Impuesto ──
  // Sin IVA la línea es EXENTA y no lleva nodo de impuestos: el manual define
  // «exento» justamente como la línea que no tiene código de impuesto.
  const pct = Number(l.iva_pct != null ? l.iva_pct : (doc.iva_pct != null ? doc.iva_pct : 13));
  const pctExo = Number(l.exo_pct || 0);
  let montoImp = 0, montoExo = 0;

  if (pct > 0) {
    montoImp = d2(neto * pct / 100);
    const imp = {
      CodigoImp: IMP_IVA,
      PorcentajeImp: red(pct, 2),
      MontoImpuesto: montoImp,
      CodigoTarifa: TARIFA[pct] != null ? TARIFA[pct] : TARIFA[13],
    };

    if (l.exo_numero && pctExo > 0) {
      montoExo = d2(neto * pctExo / 100);
      imp.Exoneracion = {
        TipoDocExo: Number(ent(l.exo_tipo_doc) || 1),          // Tabla 9
        NumeroExo: txt(l.exo_numero, 40),
        NombreInstitucion: txt(l.exo_institucion || '1', 160), // Tabla 19
        FechaExoneracion: fechaGTI(l.exo_fecha),
        MontoExonerado: montoExo,
        PorcentajeExonerado: Math.round(pctExo),
      };
    }
    o.Impuestos = [imp];
  }

  // Lo que sigue no viaja: son las cifras con que se arma Totales.
  o.__calc = {
    servicio: esServicio(unid),
    montoTotal: montoTotal,
    descuento: descuento,
    neto: neto,
    pct: pct,
    pctExo: pctExo,
    montoImp: montoImp,
    montoExo: montoExo,
    exento: !(pct > 0),
  };
  return o;
}

// La pestaña guarda el motivo tal como lo escogió el usuario ('devolucion',
// 'descuento'…). Acá se resuelve al número de la Tabla 7.
function codigoReferencia(motivo) {
  const m = txt(motivo);
  if (/^\d{1,2}$/.test(m)) return Number(m);        // ya venía como código
  if (ACCION_REF[m] != null) return ACCION_REF[m];  // llave directa

  for (const tipo of Object.keys(MOTIVOS_NOTA)) {
    const hit = MOTIVOS_NOTA[tipo].find(x => x.v === m);
    if (hit) return ACCION_REF[hit.cod] != null ? ACCION_REF[hit.cod] : ACCION_REF.anula;
  }
  return ACCION_REF.anula;
}

// El tipo del documento referido, según de qué documento salió la nota.
function tipoDocReferido(refTipo, tipoNota) {
  const t = txt(refTipo).toUpperCase();
  if (t === 'FEC') return tipoNota === 'ND' ? TIPO_DOC_REF.FEC_ND : TIPO_DOC_REF.FEC_NC;
  if (TIPO_DOC_REF[t] != null) return TIPO_DOC_REF[t];
  if (/^\d{1,2}$/.test(t)) return Number(t);
  return TIPO_DOC_REF.FE;
}

// ── El documento completo ───────────────────────────────────────────────────
function armar(doc, lineas, cliente, empresa, cred) {
  if (!lineas || !lineas.length) throw new Error('El documento no tiene líneas.');

  const det = lineas.slice()
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map((l, i) => linea(l, i, doc));

  // ── Totales, con la separación servicios / mercancías que pide el manual ──
  const T = {
    servGravado: 0, servExento: 0, servExonerado: 0,
    mercaGravada: 0, mercaExenta: 0, mercaExonerada: 0,
    descuento: 0, impuesto: 0, exonerado: 0,
  };

  for (const l of det) {
    const c = l.__calc;
    T.descuento += c.descuento;
    T.impuesto += c.montoImp;
    T.exonerado += c.montoExo;

    // Los baldes de Totales se arman con MontoTotal (antes del descuento):
    // el descuento se resta aparte, en TotalVentaNeta.
    if (c.exento) {
      if (c.servicio) T.servExento += c.montoTotal; else T.mercaExenta += c.montoTotal;
    } else if (c.pctExo > 0 && c.pct > 0) {
      const parte = Math.min(1, c.pctExo / c.pct);
      const exo = c.montoTotal * parte;
      if (c.servicio) { T.servExonerado += exo; T.servGravado += c.montoTotal - exo; }
      else            { T.mercaExonerada += exo; T.mercaGravada += c.montoTotal - exo; }
    } else {
      if (c.servicio) T.servGravado += c.montoTotal; else T.mercaGravada += c.montoTotal;
    }
  }

  const totalGravado   = d2(T.servGravado + T.mercaGravada);
  const totalExento    = d2(T.servExento + T.mercaExenta);
  const totalExonerado = d2(T.servExonerado + T.mercaExonerada);
  const totalVenta     = d2(totalGravado + totalExento + totalExonerado);
  const totalDescuento = d2(T.descuento);
  const totalVentaNeta = d2(totalVenta - totalDescuento);
  const totalImpuesto  = d2(T.impuesto - T.exonerado);
  const totalComprobante = d2(totalVentaNeta + totalImpuesto);

  const Totales = {
    TotalServGravado:   d2(T.servGravado),
    TotalServExento:    d2(T.servExento),
    TotalServExonerado: d2(T.servExonerado),
    TotalMercaGravada:  d2(T.mercaGravada),
    TotalMercaExenta:   d2(T.mercaExenta),
    TotalMercaExonerada:d2(T.mercaExonerada),
    TotalGravado:       totalGravado,
    TotalExento:        totalExento,
    TotalExonerado:     totalExonerado,
    TotalOtrosCargos:   0,
    TotalIVADevuelto:   0,
    TotalVenta:         totalVenta,
    TotalDescuento:     totalDescuento,
    TotalVentaNeta:     totalVentaNeta,
    TotalImpuesto:      totalImpuesto,
    TotalComprobante:   totalComprobante,
    TotalNoSujeto:      0,
    TotalServNoSujeto:  0,
    TotalMercaNoSujeta: 0,
    TotalImpuestoAsumidoFabrica: 0,
  };

  // ── Encabezado ──
  const numCuenta = ent(cred && cred.cuenta) || ent(empresa && empresa.gti_num_cuenta);
  if (!numCuenta) {
    const e = new Error('No se sabe el número de cuenta de GTI de la empresa.');
    e.configuracion = true;
    throw e;
  }
  const actividad = txt(empresa && empresa.actividad_economica, 6);
  if (!actividad) {
    const e = new Error('La empresa no tiene código de actividad económica, '
      + 'y Hacienda lo exige en todos los comprobantes.');
    e.configuracion = true;
    throw e;
  }

  const cond = ent(doc.cond_venta) || COND_VENTA.contado;
  const moneda = MONEDA[txt(doc.moneda).toUpperCase()] || MONEDA.CRC;

  const Encabezado = {
    NumCuenta: numCuenta,
    TipoDoc: TIPO_DOC[doc.tipo_doc] != null ? TIPO_DOC[doc.tipo_doc] : TIPO_DOC.FE,
    CondicionVenta: cond,
    Sucursal: ent(empresa && empresa.casa_matriz) || 1,
    Terminal: ent(empresa && empresa.punto_venta) || 1,
    Moneda: moneda,
    SituacionEnvio: SITUACION_NORMAL,
    CodigoActividad: actividad,
    // La clave de 50 dígitos y el consecutivo de 20 los asigna GTI: el manual
    // los marca opcionales y mutuamente dependientes. No se mandan.
    // NumeroFactura es NUESTRO consecutivo ('FA-12'), el que GTI devuelve como
    // NumInterno y el que usa ConsultaDocumento — así el documento se puede
    // rastrear de los dos lados.
    NumeroFactura: txt(doc.consecutivo, 50) || undefined,
  };
  if (empresa && empresa.nombre_comercial) {
    Encabezado.NombComercial = txt(empresa.nombre_comercial, 80);
  }
  if (cond === COND_VENTA.credito) {
    Encabezado.PlazoCredito = ent(doc.plazo_credito) || 30;
  }
  if (cond === COND_VENTA.otros) {
    Encabezado.CondicionVentaOtros = txt(doc.condiciones, 100) || 'Según acuerdo con el cliente';
  }
  if (moneda !== MONEDA.CRC) {
    const tc = Number(doc.tipo_cambio);
    if (!(tc > 0)) {
      throw new Error('El documento no está en colones y no tiene tipo de cambio.');
    }
    Encabezado.TipoCambio = d5(tc);
  }
  const fe = fechaGTI(doc.fecha);
  if (fe) Encabezado.FechaFactura = fe;

  // Medios de pago: obligatorio salvo en las condiciones de crédito.
  if (cond !== COND_VENTA.credito) {
    const mp = ent(doc.medio_pago) || MEDIO_PAGO.efectivo;
    Encabezado.MediosPagos = [{
      TipoMedioPago: mp,
      TotalMedioPago: totalComprobante,
    }];
    if (mp === MEDIO_PAGO.otros) {
      Encabezado.MediosPagos[0].MedioPagoOtros = txt(doc.condiciones, 100) || 'Otro medio de pago';
    }
  }

  // Del nodo Emisor solo existe Registrofiscal8707 (bebidas alcohólicas). Los
  // datos de CONCRE los toma GTI de la cuenta: no se envían, y mandarlos de
  // más era justamente lo que estaba mal antes.

  const cuerpo = {
    Encabezado: Encabezado,
    Receptor: (doc.tipo_doc === 'FEC') ? receptor(receptorDeDoc(doc), doc)
                                       : receptor(cliente, doc),
    Detalle: det.map(l => { const o = Object.assign({}, l); delete o.__calc; return o; }),
    Totales: Totales,
    Extra: { EsVersion4_4: true },       // obligatorio para facturar en 4.4
  };

  if (doc.notas) cuerpo.Otros = { Notas: txt(doc.notas, 500) };

  // ── Referencia, para notas de crédito y débito ──
  // Sin esto la nota no se liga a nada y Hacienda la rechaza.
  if (doc.ref_clave) {
    const razon = txt(doc.ref_razon, 200);
    if (!razon) throw new Error('La nota no tiene el motivo escrito, y Hacienda lo exige.');
    cuerpo.Referencia = {
      TipoDocRef: tipoDocReferido(doc.ref_tipo_doc, doc.tipo_doc),
      NumeroRef: txt(doc.ref_clave, 50),
      AccionRef: codigoReferencia(doc.ref_codigo),
      FechaRef: fechaGTI(doc.ref_fecha),
      RazonNota: razon,
    };
  } else if (doc.tipo_doc === 'NC' || doc.tipo_doc === 'ND') {
    throw new Error('Una nota de crédito o débito tiene que referirse a una factura emitida.');
  }

  // El total que arma el puente tiene que coincidir con el que muestra la
  // pestaña. Si no coincide, algo se calculó distinto, y es mejor parar acá
  // que mandarle a Hacienda un documento que no cuadra con lo que el cliente
  // vio en la proforma.
  const totalDoc = d2(doc.total);
  if (totalDoc > 0 && Math.abs(totalDoc - totalComprobante) > 1) {
    throw new Error('El total del documento (' + totalDoc + ') no coincide con el que se armó ('
      + totalComprobante + '). Revise las líneas antes de emitir.');
  }

  return cuerpo;
}

// ── Lectura de la respuesta de CargarDocumento ──────────────────────────────
// GTI contesta 202 con { NumCarga, Estado, Error, Fecha, Respuestas:[ ... ] }.
// Cada elemento de Respuestas trae Consecutivo y ClaveNumerica, que son los
// dos datos que hay que guardar: sin el consecutivo no se puede consultar el
// estado ni bajar el XML.
function leerEmision(datos) {
  const d = datos || {};
  const lista = d.Respuestas || d.respuestas || d.Respuesta || d.respuesta;
  const r = (Array.isArray(lista) ? lista[0] : lista) || {};

  const cod = r.Codigo != null ? Number(r.Codigo) : null;
  const err = txt(r.Error) || txt(d.Error);
  const det = txt(r.Detalle);

  return {
    clave: txt(r.ClaveNumerica || r.claveNumerica || d.ClaveNumerica) || null,
    consecutivo: txt(r.Consecutivo || r.consecutivo || d.Consecutivo) || null,
    gtiId: txt(r.IdDocumento != null ? r.IdDocumento : (d.NumCarga != null ? d.NumCarga : '')) || null,
    numInterno: txt(r.NumInterno) || null,
    codigo: cod,
    // Para CargarDocumento el 0 es «Exitoso»: es otra tabla de códigos, no la
    // de EstadoHacienda. Si no vino código, manda que haya clave.
    estado: (cod === 0 || cod === null) ? 'recibido' : 'error',
    mensaje: [det, err].filter(Boolean).join(' — ').slice(0, 900) || null,
  };
}

// ── Lectura de EstadoHacienda ───────────────────────────────────────────────
// Contesta { Codigo: "100", Respuesta, Detalle }. Los códigos son de la página
// 56 del manual, y cada uno dice qué hacer: los 101, 105, 106 y 108 son
// «todavía no», así que el documento sigue en camino y hay que volver a
// preguntar; el 104 es «GTI no lo tiene», que es un error de verdad.
const ESTADO_HACIENDA = {
  100: { estado: 'aceptado',  txt: 'Aceptado por Hacienda' },
  101: { estado: 'recibido',  txt: 'En proceso en Hacienda' },
  102: { estado: 'rechazado', txt: 'Rechazado por Hacienda' },
  103: { estado: 'error',     txt: 'Hacienda reportó un error en el comprobante' },
  104: { estado: 'error',     txt: 'GTI no encontró el documento' },
  105: { estado: 'recibido',  txt: 'Pendiente de enviar a Hacienda' },
  106: { estado: 'recibido',  txt: 'Hacienda todavía no ha respondido' },
  107: { estado: 'recibido',  txt: 'Hacienda reporta un estado desconocido' },
  108: { estado: 'recibido',  txt: 'Hay que volver a consultar más tarde' },
};

function leerEstado(datos) {
  const d = datos || {};
  const cod = d.Codigo != null ? Number(d.Codigo) : (d.codigo != null ? Number(d.codigo) : null);
  const m = ESTADO_HACIENDA[cod];

  const dicho = [txt(d.Detalle || d.detalle), txt(d.Respuesta || d.respuesta)]
    .filter(Boolean).join(' — ');

  return {
    codigo: cod,
    estado: m ? m.estado : normalizarEstado(d.Respuesta || d.Estado || d.estado),
    mensaje: (dicho || (m ? m.txt : null) || null) && (dicho || m.txt).slice(0, 900),
  };
}

// Respaldo por si GTI contesta con palabras y no con código.
function normalizarEstado(e) {
  const s = txt(e).toLowerCase();
  if (!s) return null;
  if (/rechaz/.test(s)) return 'rechazado';
  if (/acept/.test(s)) return 'aceptado';
  if (/recib|proces|pendien|enviad|espere/.test(s)) return 'recibido';
  if (/error|fall|no se encontr/.test(s)) return 'error';
  return 'recibido';
}

// ── Lectura de ObtenerBytesPdfEmision ───────────────────────────────────────
// Contesta { Codigo, Mensaje, Datos } con el PDF en base64 en «Datos».
// Códigos: 1 éxito · 2 autenticación · 3 procesamiento · 4 validación ·
// 5 no encontrado · 6 interno · 7 frecuencia excedida (esperar 30 s).
function leerPdf(datos) {
  const d = datos || {};
  const cod = d.Codigo != null ? Number(d.Codigo) : null;
  return {
    codigo: cod,
    ok: cod === 1 && !!(d.Datos || d.datos),
    reintentar: cod === 3 || cod === 6 || cod === 7,
    base64: txt(d.Datos || d.datos) || null,
    mensaje: txt(d.Mensaje || d.mensaje) || null,
  };
}

// ── Respuestas del simulador ────────────────────────────────────────────────
// Imitan el camino real con la misma forma que trae GTI, para que la lectura
// de arriba sea la misma con simulador y sin él.

function simularEmision(doc) {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const aa = String(hoy.getFullYear()).slice(2);
  const ced = '3101846556'.padStart(12, '0');
  const cons = '001' + '00001' + '01' + String(Date.now()).slice(-10);
  const seg = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return {
    NumCarga: Number(String(Date.now()).slice(-7)),
    Estado: 202,
    Error: 'OK',
    Fecha: fechaGTI(),
    Respuestas: [{
      Codigo: 0,
      NumDoc: 1,
      NumInterno: txt(doc && doc.consecutivo),
      Consecutivo: cons,
      ClaveNumerica: '506' + dd + mm + aa + ced + cons + '1' + seg,
      Error: 'Exitoso',
      Detalle: 'SIMULADO — no salió a GTI ni a Hacienda',
    }],
  };
}

// Se decide por el tiempo transcurrido desde el envío, NO por el número de
// intento: cada consulta de estado es un trabajo distinto en la cola y todos
// llegan con su propio contador en cero, así que contando intentos el
// documento simulado nunca pasaba de «recibido» y el camino no terminaba.
const SIM_SEG_ACEPTA = 60;

function simularEstado(doc) {
  const desde = doc && doc.enviado_en ? new Date(doc.enviado_en).getTime() : 0;
  const seg = desde ? (Date.now() - desde) / 1000 : 999;
  if (seg >= SIM_SEG_ACEPTA) {
    return { Codigo: '100', Respuesta: 'Se ha aceptado el documento (SIMULADO)',
             Detalle: 'SIMULADO — no salió a GTI ni a Hacienda' };
  }
  return { Codigo: '101', Respuesta: 'En proceso (SIMULADO)', Detalle: 'SIMULADO' };
}

function simularXml(que) {
  return que === 'respuesta'
    ? '<?xml version="1.0" encoding="utf-8"?><MensajeHacienda><Mensaje>1</Mensaje>'
      + '<DetalleMensaje>SIMULADO</DetalleMensaje></MensajeHacienda>'
    : '<?xml version="1.0" encoding="utf-8"?><FacturaElectronica><!-- simulado --></FacturaElectronica>';
}

function simularPdf() {
  return { Codigo: 1, Mensaje: 'Exitoso', Datos: null };
}

module.exports = {
  METODOS, TIPO_DOC, TIPO_DOC_REF, ACCION_REF, MOTIVOS_NOTA,
  COND_VENTA, MEDIO_PAGO, MONEDA, TARIFA, TARIFA_EXENTA, IMP_IVA,
  ESTADO_HACIENDA,
  codigoReferencia, tipoDocReferido, receptorDeDoc, receptor,
  unidadCod, esServicio, red, fechaGTI,
  armar, leerEmision, leerEstado, leerPdf, normalizarEstado,
  simularEmision, simularEstado, simularXml, simularPdf,
};
