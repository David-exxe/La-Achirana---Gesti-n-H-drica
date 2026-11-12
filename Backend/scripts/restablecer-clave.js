// =====================================================================
//  Restablecer la contraseña de un administrador (cuando nadie puede entrar)
//
//  Uso (desde la carpeta del proyecto):
//    npm run reset-clave -- correo@dominio.com "NuevaClave#2026"
//
//  - Solo funciona en la computadora donde está el .env y la base de datos.
//  - Desbloquea la cuenta si estaba bloqueada por intentos fallidos.
// =====================================================================
const { pool } = require('../Config/db');
const { hashClave } = require('../utils/seguridad');
const { problemaClave, RE } = require('../utils/validacion');

(async () => {
    const [email, clave] = process.argv.slice(2);
    if (!email || !clave) {
        console.log('Uso:  npm run reset-clave -- correo@dominio.com "NuevaClave#2026"');
        process.exit(1);
    }
    if (!RE.email.test(email)) { console.error('❌ Correo no válido.'); process.exit(1); }
    const problema = problemaClave(clave);
    if (problema) { console.error(`❌ Contraseña débil: ${problema}`); process.exit(1); }

    try {
        const r = await pool.query(
            `UPDATE usuarios SET pass = $1, intentos_fallidos = 0, bloqueado_hasta = NULL, activo = true
              WHERE LOWER(email) = LOWER($2) RETURNING id, nombre, email, rol`,
            [await hashClave(clave), email]
        );
        if (!r.rowCount) {
            const { rows } = await pool.query('SELECT email FROM usuarios ORDER BY id');
            console.error(`❌ No existe un usuario con el correo ${email}. Correos registrados:`);
            rows.forEach(u => console.error(`   - ${u.email}`));
            process.exit(1);
        }
        const u = r.rows[0];
        await pool.query(
            "INSERT INTO auditoria (actor_tipo, accion, entidad, entidad_id, detalle) VALUES ('sistema','reset_clave_consola','usuarios',$1,$2)",
            [u.id, JSON.stringify({ email: u.email })]
        ).catch(() => {});
        console.log(`✅ Contraseña actualizada para ${u.nombre} (${u.email}, ${u.rol}). Ya puedes ingresar.`);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
