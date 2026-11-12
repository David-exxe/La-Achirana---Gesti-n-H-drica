// =====================================================================
//  Manejo centralizado de errores: nunca exponer detalles internos de SQL
// =====================================================================
const { ErrorHttp } = require('../utils/validacion');
const config = require('../Config/env');

const MENSAJES_PG = {
    '23505': 'Ya existe un registro con ese dato (documento o correo repetido).',
    '23503': 'El registro está relacionado con otros datos y no se puede completar la operación.',
    '23514': 'Un valor no cumple las reglas de la base de datos.',
    '22P02': 'Formato de dato inválido.',
    '22003': 'Número fuera de rango.',
    '22001': 'Un texto excede la longitud permitida.',
};

// eslint-disable-next-line no-unused-vars
function manejadorErrores(err, req, res, _next) {
    if (err instanceof ErrorHttp) {
        return res.status(err.estado).json({ error: err.message, campos: err.campos });
    }
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'El cuerpo de la solicitud no es JSON válido.' });
    }
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'La solicitud es demasiado grande.' });
    }
    if (err?.code && MENSAJES_PG[err.code]) {
        return res.status(409).json({ error: MENSAJES_PG[err.code] });
    }
    if (err?.message?.startsWith('CORS')) {
        return res.status(403).json({ error: 'Origen no permitido.' });
    }
    console.error(`❌ [${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({
        error: 'Ocurrió un error interno. Inténtalo de nuevo en unos minutos.',
        ...(config.entorno === 'development' ? { detalle: err.message } : {}),
    });
}

function noEncontrado(req, res) {
    res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
}

module.exports = { manejadorErrores, noEncontrado };
