const { query } = require('../Config/db');
const config = require('../Config/env');
const { verificarClave, verificarSenuelo, firmarToken } = require('../utils/seguridad');
const { ErrorHttp, RE, limpiar } = require('../utils/validacion');
const auditoria = require('../services/auditoria.service');

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

async function registrarFallo(tabla, id) {
    await query(
        `UPDATE ${tabla}
            SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= $2 THEN 0 ELSE intentos_fallidos + 1 END,
                bloqueado_hasta   = CASE WHEN intentos_fallidos + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE bloqueado_hasta END
          WHERE id = $1`,
        [id, MAX_INTENTOS, String(MINUTOS_BLOQUEO)]
    );
}

const mensajeBloqueo = hasta => {
    const min = Math.max(1, Math.ceil((new Date(hasta) - Date.now()) / 60000));
    return `Demasiados intentos fallidos. Vuelve a intentarlo en ${min} minuto(s).`;
};

async function loginAdmin(req, res) {
    const email = limpiar(req.body?.email ?? '').toLowerCase();
    const pass = req.body?.pass ?? '';
    if (!RE.email.test(email) || typeof pass !== 'string' || !pass || pass.length > 72) {
        throw new ErrorHttp(400, 'Ingresa un correo y una contraseña válidos.', {
            ...(!RE.email.test(email) ? { email: 'Correo no válido.' } : {}),
            ...(!pass ? { pass: 'Ingresa tu contraseña.' } : {}),
        });
    }

    const { rows } = await query('SELECT * FROM usuarios WHERE LOWER(email) = $1', [email]);
    const u = rows[0];
    const credencialesMal = new ErrorHttp(401, 'Correo o contraseña incorrectos.');

    if (!u) { await verificarSenuelo(pass); throw credencialesMal; }
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) throw new ErrorHttp(429, mensajeBloqueo(u.bloqueado_hasta));
    if (u.activo === false) throw new ErrorHttp(403, 'Tu cuenta está desactivada. Contacta a un administrador.');

    if (!(await verificarClave(pass, u.pass))) {
        await registrarFallo('usuarios', u.id);
        await auditoria.registrar(req, 'login_fallido', 'usuarios', u.id);
        throw credencialesMal;
    }

    await query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = now() WHERE id = $1', [u.id]);
    const sesion = { tipo: 'usuario', id: u.id, rol: u.rol, nombre: u.nombre };
    req.sesion = sesion;
    await auditoria.registrar(req, 'login', 'usuarios', u.id);
    res.json({ token: firmarToken(sesion), usuario: { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } });
}

async function loginCliente(req, res) {
    const documento = String(req.body?.documento ?? '').trim();
    const tipoDoc = req.body?.tipoDoc;
    const pin = String(req.body?.pin ?? '').trim();

    const errores = {};
    if (tipoDoc === 'DNI' && !RE.dni.test(documento)) errores.documento = 'El DNI debe tener 8 dígitos.';
    else if (tipoDoc === 'RUC' && !RE.ruc.test(documento)) errores.documento = 'El RUC debe tener 11 dígitos y empezar con 10, 15, 16, 17 o 20.';
    else if (!['DNI', 'RUC'].includes(tipoDoc)) errores.tipoDoc = 'Elige DNI o RUC.';
    if (pin && !RE.pin.test(pin)) errores.pin = 'El código tiene 6 dígitos.';
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los datos ingresados.', errores);

    const tipoEsperado = tipoDoc === 'RUC' ? 'empresa' : 'parcelero';
    const { rows } = await query('SELECT * FROM clientes WHERE documento = $1', [documento]);
    const c = rows[0];
    const noEncontrado = new ErrorHttp(401, 'Documento o código de acceso incorrectos.');

    if (!c || c.tipo !== tipoEsperado) { await verificarSenuelo(pin || 'x'); throw noEncontrado; }
    if (c.bloqueado_hasta && new Date(c.bloqueado_hasta) > new Date()) throw new ErrorHttp(429, mensajeBloqueo(c.bloqueado_hasta));
    if (c.activo === false) throw new ErrorHttp(403, 'Este usuario está inactivo. Acércate a la Junta.');

    if (c.pin_hash) {
        if (!pin) throw new ErrorHttp(401, 'Ingresa tu código de acceso de 6 dígitos.', { pin: 'Requerido para tu cuenta.' });
        if (!(await verificarClave(pin, c.pin_hash))) {
            await registrarFallo('clientes', c.id);
            throw noEncontrado;
        }
    } else if (config.clientePinObligatorio) {
        throw new ErrorHttp(403, 'Aún no tienes código de acceso. Solicítalo en la oficina de la Junta.');
    }

    await query('UPDATE clientes SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [c.id]);
    const sesion = { tipo: 'cliente', id: c.id, rol: 'cliente', nombre: c.nombre };
    req.sesion = sesion;
    await auditoria.registrar(req, 'login', 'clientes', c.id);
    res.json({
        token: firmarToken(sesion),
        cliente: publicoCliente(c),
        aviso: c.pin_hash ? null : 'Tu cuenta aún no tiene código de acceso. Pide uno en la Junta para mayor seguridad.',
    });
}

async function yo(req, res) {
    if (req.sesion.tipo === 'usuario') {
        const { rows } = await query('SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = $1', [req.sesion.id]);
        if (!rows[0] || rows[0].activo === false) throw new ErrorHttp(401, 'Tu sesión ya no es válida.');
        return res.json({ tipo: 'usuario', usuario: rows[0] });
    }
    const { rows } = await query('SELECT * FROM clientes WHERE id = $1', [req.sesion.id]);
    if (!rows[0] || rows[0].activo === false) throw new ErrorHttp(401, 'Tu sesión ya no es válida.');
    res.json({ tipo: 'cliente', cliente: publicoCliente(rows[0]) });
}

function publicoCliente(c) {
    return {
        id: c.id, tipo: c.tipo, documento: c.documento, nombre: c.nombre, hectareas: c.hectareas,
        ubicacion_sector: c.ubicacion_sector, cultivo: c.cultivo, tiene_pin: Boolean(c.pin_hash), activo: c.activo !== false,
        almacena: Boolean(c.almacena), capacidad_reservorio_m3: c.capacidad_reservorio_m3 ?? null,
    };
}

module.exports = { loginAdmin, loginCliente, yo, publicoCliente };
