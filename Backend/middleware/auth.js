// =====================================================================
//  Autenticación y autorización por rol
// =====================================================================
const { verificarToken } = require('../utils/seguridad');
const { ErrorHttp } = require('../utils/validacion');

/** Exige un token válido. Deja los datos en req.sesion = { tipo, id, rol, nombre } */
function requiereSesion(req, _res, next) {
    const cabecera = req.get('authorization') || '';
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
    const datos = verificarToken(token);
    if (!datos) return next(new ErrorHttp(401, 'Tu sesión expiró o no es válida. Vuelve a ingresar.'));
    req.sesion = datos;
    next();
}

/** Solo administradores (y opcionalmente operadores). */
function requiereAdmin(...rolesExtra) {
    const permitidos = new Set(['admin', ...rolesExtra]);
    return (req, _res, next) => {
        if (req.sesion?.tipo !== 'usuario' || !permitidos.has(req.sesion.rol)) {
            return next(new ErrorHttp(403, 'No tienes permiso para esta acción.'));
        }
        next();
    };
}

const esPersonal = s => s?.tipo === 'usuario';

/**
 * Resuelve qué cliente se está consultando:
 *  - un cliente SOLO puede ver sus propios datos (se ignora lo que mande);
 *  - el personal puede indicar cualquier cliente_id.
 */
function clienteObjetivo(req, valor) {
    if (req.sesion.tipo === 'cliente') return req.sesion.id;
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw new ErrorHttp(400, 'Selecciona un cliente válido.');
    return n;
}

module.exports = { requiereSesion, requiereAdmin, esPersonal, clienteObjetivo };
