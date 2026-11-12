// ══════════════════════════════════════════════════════════════════════════════
// PRUEBA DE CONEXIÓN — ¿cada usuario del ERP logra entrar a GTI con su clave?
//
// Para cada usuario activo del ERP dice:
//   · cómo se llaman las dos variables que hay que crear en Vercel para él;
//   · si ya están creadas;
//   · y, si lo están, qué contestó GTI al consultar con ese usuario y clave.
//
// La prueba llama a CargarDocumento con el cuerpo vacío: no hay documento que
// emitir, así que no emite, no cambia ni borra nada. Ver «LA SONDA» abajo.
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

    const usuarios = await G.sbGet('usuarios', 'select=id,nombre,rol,estado&order=nombre.asc');
    const filas = [];

    // LA SONDA. La primera versión consultaba EstadoHacienda y dio un falso
    // «conectó»: GTI contesta esa consulta sin validar la clave del usuario
    // (12/11/2026: Jose Pablo salió «SÍ» y al emitir GTI respondió 401).
    //
    // Ahora se llama al mismo método que emite, CargarDocumento, pero con el
    // cuerpo VACÍO: sin documentos no hay nada que GTI pueda emitir. Lo que
    // interesa es solo el código con que contesta:
    //   401                    → GTI rechazó el usuario o la clave
    //   cualquier otro código  → pasó la puerta (y se queja del cuerpo vacío)
    // Para no suponer cómo contesta GTI, primero se manda la misma sonda con un
    // usuario inventado: si esa NO da 401, la sonda no sirve para distinguir y
    // se dice «no concluyente» en lugar de afirmar algo que no se sabe.
    async function sonda(cred) {
      const r = await G.llamarGTI(cred, P.METODOS.emitir, { cuerpo: {} });
      return { http: r.status, texto: r.error || leer(r.datos) || 'sin mensaje' };
    }

    let control = null;
    if (!G.SIMULADOR) {
      const base = G.credenciales(empresaId, ambiente, null);
      control = await sonda(Object.assign({}, base,
        { usuario: 'usuario-inexistente-sonda-erp', clave: 'sonda' }));
    }
    const sondaSirve = !!control && control.http === 401;

    async function probar(usuarioId) {
      let cred;
      try { cred = G.credenciales(empresaId, ambiente, usuarioId); }
      catch (e) { return { conecto: 'NO', respuesta: String(e.message || e) }; }
      if (G.SIMULADOR) return { conecto: 'simulador', respuesta: 'GTI_SIMULADOR está activo: no se llamó a GTI.' };
      const r = await sonda(cred);
      if (r.http === 401) {
        return { conecto: 'NO', http: 401,
          respuesta: 'GTI rechazó el usuario o la clave en ' + ambiente + ': ' + r.texto };
      }
      if (!sondaSirve) {
        return { conecto: 'no concluyente', http: r.http,
          respuesta: 'GTI no distingue usuarios en esta prueba; solo emitiendo se sabrá. Contestó: ' + r.texto };
      }
      return { conecto: 'SÍ', http: r.http,
        respuesta: 'GTI aceptó el usuario y la clave (y, como se esperaba, objetó el cuerpo vacío: ' + r.texto + ')' };
    }

    // El usuario general, como referencia
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
        fila.conecto = p.conecto;
        if (p.http !== undefined) fila.http = p.http;
        fila.respuesta_de_gti = p.respuesta;
      }
      filas.push(fila);
    }

    return res.status(200).json({
      ok: true,
      ambiente: ambiente,
      nota: 'No emite nada: se llama a GTI con el cuerpo vacío y solo se mira si acepta al usuario.',
      control_con_usuario_inventado: control
        ? { http: control.http, sirve_la_prueba: sondaSirve ? 'sí' : 'no' } : null,
      usuario_general: {
        conecto: general.conecto,
        http: general.http, respuesta_de_gti: general.respuesta,
      },
      usuarios: filas,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
