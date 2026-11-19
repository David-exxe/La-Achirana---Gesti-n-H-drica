const { query } = require('../Config/db');
const clima = require('../services/clima.service');
const lluvia = require('../services/lluvia.service');
const { ErrorHttp, entero, limpiar, RE } = require('../utils/validacion');
const auditoria = require('../services/auditoria.service');

/** Mensaje corto para el usuario; el detalle técnico queda en el log. */
function mensajeClima(err) {
    console.warn('⚠️  Clima:', err.message);
    return /429|limitando/.test(err.message)
        ? 'El pronóstico está saturado en este momento. Vuelve a intentarlo en unos minutos.'
        : 'El pronóstico no está disponible en este momento. Se reintentará automáticamente.';
}

async function resumen(req, res) {
    const forzar = req.query.forzar === '1' && req.sesion.tipo === 'usuario';
    try {
        res.json(await clima.obtenerResumen({ forzar }));
    } catch (err) {
        throw new ErrorHttp(503, mensajeClima(err));
    }
}

/** URLs de Open-Meteo para que el navegador consulte directo si el servidor está bloqueado. */
async function fuentes(req, res) {
    res.json({ ...(await clima.fuentes()), malla: lluvia.urlMalla() });
}

/** Datos traídos por el navegador: se validan y se procesan. Solo el personal los guarda para todos. */
async function resumenExterno(req, res) {
    try {
        res.json(await clima.procesarExterno(req.body, { confiable: req.sesion.tipo === 'usuario' }));
    } catch (err) {
        throw new ErrorHttp(400, `No se pudo procesar el pronóstico: ${err.message}`);
    }
}

async function mallaExterna(req, res) {
    try {
        res.json(await lluvia.procesarExterno(req.body, { confiable: req.sesion.tipo === 'usuario' }));
    } catch (err) {
        throw new ErrorHttp(400, `No se pudo procesar la lluvia: ${err.message}`);
    }
}

/** Malla horaria de lluvia (pasado 24 h + próximas 48 h) para la animación. */
async function malla(req, res) {
    try {
        res.json(await lluvia.obtenerMalla({ forzar: req.query.forzar === '1' && req.sesion.tipo === 'usuario' }));
    } catch (err) {
        throw new ErrorHttp(503, mensajeClima(err));
    }
}

async function listarPuntos(req, res) {
    const { rows } = await query('SELECT * FROM puntos_monitoreo ORDER BY altitud_m DESC');
    res.json(rows);
}

function validarPunto(b) {
    const e = {};
    const nombre = limpiar(b.nombre ?? '');
    const tipo = b.tipo;
    const latitud = Number(b.latitud), longitud = Number(b.longitud);
    const altitud = Number(b.altitud_m), distancia = Number(b.distancia_rio_km);
    const notas = limpiar(b.notas ?? '');
    if (nombre.length < 3 || nombre.length > 100 || !RE.texto.test(nombre)) e.nombre = 'Entre 3 y 100 caracteres válidos.';
    if (!['sierra', 'bocatoma', 'valle'].includes(tipo)) e.tipo = 'Tipo no válido.';
    if (!Number.isFinite(latitud) || latitud < -18.5 || latitud > 0) e.latitud = 'Latitud de Perú: entre -18.5 y 0.';
    if (!Number.isFinite(longitud) || longitud < -81.5 || longitud > -68.5) e.longitud = 'Longitud de Perú: entre -81.5 y -68.5.';
    if (!Number.isInteger(altitud) || altitud < 0 || altitud > 6800) e.altitud_m = 'Altitud entera entre 0 y 6800 m.';
    if (!Number.isFinite(distancia) || distancia < 0 || distancia > 600) e.distancia_rio_km = 'Entre 0 y 600 km.';
    if (notas.length > 250) e.notas = 'Máximo 250 caracteres.';
    if (Object.keys(e).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', e);
    return [nombre, tipo, latitud, longitud, altitud, distancia, b.regulado === true, b.activo !== false, notas || null];
}

async function crearPunto(req, res) {
    const v = validarPunto(req.body || {});
    const { rows } = await query(
        `INSERT INTO puntos_monitoreo (nombre, tipo, latitud, longitud, altitud_m, distancia_rio_km, regulado, activo, notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, v
    );
    clima.invalidar();
    await auditoria.registrar(req, 'crear', 'puntos_monitoreo', rows[0].id);
    res.status(201).json(rows[0]);
}

async function actualizarPunto(req, res) {
    const id = entero(req.params.id, 'punto');
    const v = validarPunto(req.body || {});
    const { rows } = await query(
        `UPDATE puntos_monitoreo SET nombre=$1, tipo=$2, latitud=$3, longitud=$4, altitud_m=$5, distancia_rio_km=$6,
                regulado=$7, activo=$8, notas=$9 WHERE id=$10 RETURNING *`, [...v, id]
    );
    if (!rows[0]) throw new ErrorHttp(404, 'Punto no encontrado.');
    clima.invalidar();
    await auditoria.registrar(req, 'editar', 'puntos_monitoreo', id);
    res.json(rows[0]);
}

async function eliminarPunto(req, res) {
    const id = entero(req.params.id, 'punto');
    const r = await query('DELETE FROM puntos_monitoreo WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErrorHttp(404, 'Punto no encontrado.');
    clima.invalidar();
    await auditoria.registrar(req, 'eliminar', 'puntos_monitoreo', id);
    res.json({ ok: true });
}

async function historial(req, res) {
    const { rows } = await query(
        `SELECT a.fecha, p.nombre AS punto, a.precip_mm, a.probabilidad, a.nivel,
                a.llegada_desde, a.llegada_hasta, a.actualizado_en
           FROM alertas_climaticas a JOIN puntos_monitoreo p ON p.id = a.punto_id
          WHERE a.nivel <> 'verde' AND a.fecha >= CURRENT_DATE - INTERVAL '90 days'
          ORDER BY a.fecha DESC, a.precip_mm DESC LIMIT 200`
    );
    res.json(rows);
}

module.exports = { fuentes, resumenExterno, mallaExterna,
    malla, resumen, listarPuntos, crearPunto, actualizarPunto, eliminarPunto, historial };
