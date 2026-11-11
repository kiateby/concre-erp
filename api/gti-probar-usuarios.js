// ══════════════════════════════════════════════════════════════════════════════
// PRUEBA DE CONEXIÓN — ¿cada usuario del ERP logra entrar a GTI con su clave?
//
// Para cada usuario activo del ERP dice:
//   · cómo se llaman las dos variables que hay que crear en Vercel para él;
//   · si ya están creadas;
//   · y, si lo están, qué contestó GTI al consultar con ese usuario y clave.
//
// La prueba es una CONSULTA de estado (EstadoHacienda): no emite, no cambia
// ni borra nada, ni en pruebas ni en producción.
//
// Nunca imprime usuarios ni claves de GTI: solo el nombre de las variables.
//
// Cómo se abre:
//   /api/gti-probar-usuarios?llave=LA_PALABRA
//   /api/gti-probar-usuarios?llave=LA_PALABRA&ambiente=produccion
// donde LA_PALABRA es el valor de GTI_LLAVE_PRUEBA en Vercel. Sin ella no
// contesta, porque la respuesta lleva nombres de colaboradores.
// ══════════════════════════════════════════════════════════════════════════════

const G = require('./_gti');
const P = require('./_gti_payload');

function leer(datos) {
  if (datos == null) return '';
  if (typeof datos === 'string') return datos.slice(0, 300);
  const limpio = G.sinSecretos(datos);
  const m = limpio && (limpio.Message || limpio.message || limpio.Mensaje || limpio.mensaje
    || limpio.Descripcion || limpio.descripcion || limpio.crudo);
  return String(m || JSON.stringify(limpio)).slice(0, 300);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const llave = process.env.GTI_LLAVE_PRUEBA || '';
  const dada = String((req.query && req.query.llave) || '');
  if (!llave) {
    return res.status(500).json({ ok: false,
      error: 'Falta crear la variable GTI_LLAVE_PRUEBA en Vercel (una palabra cualquiera).' });
  }
  if (dada !== llave) {
    return res.status(401).json({ ok: false, error: 'Llave incorrecta.' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false,
      error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en Vercel.' });
  }

  try {
    const empresaId = String((req.query && req.query.empresa) || 'concre');
    const emp = (await G.sbGet('fact_empresas', 'id=eq.' + encodeURIComponent(empresaId) + '&limit=1'))[0];
    if (!emp) return res.status(404).json({ ok: false, error: 'No existe la empresa ' + empresaId });

    const pedido = String((req.query && req.query.ambiente) || '');
    const ambiente = (pedido === 'produccion' || pedido === 'pruebas')
      ? pedido : (emp.gti_ambiente || 'pruebas');

    // Un consecutivo real de la empresa para preguntar por él. Si todavía no
    // hay ninguno, se pregunta por uno que no existe: igual se ve si GTI dejó
    // entrar al usuario o lo rechazó.
    const ult = await G.sbGet('fact_docs', 'empresa_id=eq.' + encodeURIComponent(empresaId)
      + '&consecutivo_fiscal=not.is.null&order=enviado_en.desc&limit=1');
    const real = ult[0] && ult[0].consecutivo_fiscal;
    const consecutivo = real || '00100001010000000000';

    const usuarios = await G.sbGet('usuarios', 'select=id,nombre,rol,estado&order=nombre.asc');
    const filas = [];

    async function probar(usuarioId) {
      let cred;
      try { cred = G.credenciales(empresaId, ambiente, usuarioId); }
      catch (e) { return { conecto: false, respuesta: String(e.message || e) }; }
      if (G.SIMULADOR) return { conecto: null, respuesta: 'GTI_SIMULADOR está activo: no se llamó a GTI.' };
      const r = await G.llamarGTI(cred, P.METODOS.estado, { consecutivo: consecutivo });
      return {
        conecto: !!r.ok,
        http: r.status,
        respuesta: r.ok ? 'GTI aceptó el usuario y la clave.'
                        : (r.error || leer(r.datos) || 'sin mensaje'),
      };
    }

    // El usuario general, como referencia de qué contesta GTI cuando todo está bien
    const general = await probar(null);

    for (const u of usuarios) {
      if (u.estado && u.estado !== 'activo') continue;
      const v = G.variablesDeUsuario(empresaId, u.id);
      if (!v) continue;
      const tieneU = !!process.env[v.usuario];
      const tieneC = !!process.env[v.clave];
      const fila = {
        colaborador: u.nombre || u.id,
        rol: u.rol || '',
        variable_usuario: v.usuario,
        variable_clave: v.clave,
        configurado: (tieneU && tieneC) ? 'sí'
          : (tieneU || tieneC) ? ('incompleto — falta ' + (tieneU ? v.clave : v.usuario))
          : 'no — NO puede emitir hasta que se creen sus dos variables',
      };
      if (tieneU && tieneC) {
        const p = await probar(u.id);
        fila.conecto = p.conecto === null ? 'simulador' : (p.conecto ? 'SÍ' : 'NO');
        if (p.http !== undefined) fila.http = p.http;
        fila.respuesta_de_gti = p.respuesta;
      }
      filas.push(fila);
    }

    return res.status(200).json({
      ok: true,
      ambiente: ambiente,
      nota: 'Prueba de solo consulta: no emite ni cambia nada.'
        + (real ? '' : ' Todavía no hay documentos emitidos; se consultó un consecutivo inexistente,'
          + ' así que compare cada respuesta con la del usuario general.'),
      usuario_general: {
        conecto: general.conecto === null ? 'simulador' : (general.conecto ? 'SÍ' : 'NO'),
        http: general.http, respuesta_de_gti: general.respuesta,
      },
      usuarios: filas,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
