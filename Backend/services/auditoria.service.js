const { query } = require('../Config/db');

/** Registra una acción sensible. Nunca debe romper la operación principal. */
async function registrar(req, accion, entidad = null, entidadId = null, detalle = null) {
    try {
        await query(
            `INSERT INTO auditoria (actor_tipo, actor_id, accion, entidad, entidad_id, detalle, ip)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [req?.sesion?.tipo || 'sistema', req?.sesion?.id || null, accion, entidad, entidadId,
             detalle ? JSON.stringify(detalle) : null, req?.ip || null]
        );
    } catch (err) {
        console.warn('⚠️  No se pudo registrar auditoría:', err.message);
    }
}

module.exports = { registrar };
