const { query } = require('../Config/db');
const { validarCaudal, validarFecha, ErrorHttp } = require('../utils/validacion');
const { clienteObjetivo } = require('../middleware/auth');
const auditoria = require('../services/auditoria.service');

// Regla de negocio original: ≥ 14 L/s = Óptimo, en otro caso Normal
const estadoPorLps = lps => (lps >= 14 ? 'Óptimo' : 'Normal');

async function listar(req, res) {
    const clienteId = clienteObjetivo(req, req.query.cliente_id);
    const limite = Math.min(500, Math.max(1, parseInt(req.query.limite, 10) || 200));
    const { rows } = await query(
        `SELECT h.id, h.cliente_id, TO_CHAR(h.fecha, 'YYYY-MM-DD HH24:MI') AS fecha,
                h.lps, h.m3_hora, h.m3_dia, COALESCE(h.volumen_m3, h.m3_dia) AS volumen_m3, h.horas,
                h.estado, (h.turno_id IS NOT NULL) AS por_turno, (h.pago_id IS NOT NULL) AS pagado
           FROM historial_caudal h
          WHERE h.cliente_id = $1
          ORDER BY h.fecha DESC, h.id DESC
          LIMIT $2`,
        [clienteId, limite]
    );
    res.json(rows);
}

async function resumen(req, res) {
    const clienteId = clienteObjetivo(req, req.query.cliente_id);
    const { rows } = await query(
        `SELECT COUNT(*)::int AS lecturas,
                COALESCE(SUM(COALESCE(volumen_m3, m3_dia)), 0) AS volumen_total,
                COALESCE(SUM(COALESCE(volumen_m3, m3_dia)) FILTER (WHERE pago_id IS NULL), 0) AS volumen_pendiente,
                COALESCE(ROUND(AVG(lps), 2), 0) AS lps_promedio,
                (SELECT lps FROM historial_caudal WHERE cliente_id = $1 ORDER BY fecha DESC, id DESC LIMIT 1) AS lps_ultimo,
                (SELECT TO_CHAR(fecha, 'YYYY-MM-DD HH24:MI') FROM historial_caudal WHERE cliente_id = $1 ORDER BY fecha DESC, id DESC LIMIT 1) AS fecha_ultima
           FROM historial_caudal WHERE cliente_id = $1`,
        [clienteId]
    );
    res.json(rows[0]);
}

async function crear(req, res) {
    const d = validarCaudal(req.body);
    const existe = await query('SELECT id, activo FROM clientes WHERE id = $1', [d.cliente_id]);
    if (!existe.rows[0]) throw new ErrorHttp(404, 'El cliente no existe.');
    if (existe.rows[0].activo === false) throw new ErrorHttp(400, 'El cliente está inactivo.');

    const m3Hora = Math.round(d.lps * 3.6 * 100) / 100;
    const m3Dia = Math.round(m3Hora * 24 * 100) / 100;
    const { rows } = await query(
        `INSERT INTO historial_caudal (cliente_id, lps, m3_hora, m3_dia, volumen_m3, horas, estado, fecha, registrado_por)
         VALUES ($1,$2,$3,$4,$4,24,$5, COALESCE($6::timestamp, CURRENT_TIMESTAMP), $7)
         RETURNING id, cliente_id, TO_CHAR(fecha, 'YYYY-MM-DD HH24:MI') AS fecha, lps, m3_hora, m3_dia, volumen_m3, estado`,
        [d.cliente_id, d.lps, m3Hora, m3Dia, estadoPorLps(d.lps), d.fecha, req.sesion.id]
    );
    await auditoria.registrar(req, 'registrar_caudal', 'historial_caudal', rows[0].id, { lps: d.lps });
    res.status(201).json(rows[0]);
}

async function eliminar(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ErrorHttp(400, 'Lectura no válida.');
    const r = await query('DELETE FROM historial_caudal WHERE id = $1 AND pago_id IS NULL', [id]);
    if (!r.rowCount) throw new ErrorHttp(409, 'No se puede borrar: la lectura no existe o ya fue pagada.');
    await auditoria.registrar(req, 'eliminar_caudal', 'historial_caudal', id);
    res.json({ ok: true });
}

async function grafico(req, res) {
    const clienteId = clienteObjetivo(req, req.query.cliente_id);
    const desde = validarFecha(req.query.desde);
    const hasta = validarFecha(req.query.hasta);
    const params = [clienteId];
    let filtro;
    if (desde && hasta) {
        if (desde > hasta) throw new ErrorHttp(400, 'La fecha "desde" no puede ser mayor que "hasta".');
        params.push(`${desde} 00:00:00`, `${hasta} 23:59:59`);
        filtro = 'AND fecha BETWEEN $2 AND $3';
    } else {
        filtro = "AND fecha >= CURRENT_DATE - INTERVAL '30 days'";
    }
    const { rows } = await query(
        `SELECT TO_CHAR(fecha, 'YYYY-MM-DD HH24:MI') AS fecha, lps, COALESCE(volumen_m3, m3_dia) AS m3_dia
           FROM historial_caudal WHERE cliente_id = $1 ${filtro}
          ORDER BY fecha ASC, id ASC LIMIT 2000`,
        params
    );
    res.json(rows);
}

module.exports = { listar, resumen, crear, eliminar, grafico };
