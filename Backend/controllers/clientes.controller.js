const { query } = require('../Config/db');
const { hashClave } = require('../utils/seguridad');
const { validarCliente, entero, ErrorHttp } = require('../utils/validacion');
const { publicoCliente } = require('./auth.controller');
const auditoria = require('../services/auditoria.service');

async function listar(req, res) {
    const { rows } = await query('SELECT * FROM clientes ORDER BY nombre ASC');
    res.json(rows.map(publicoCliente));
}

async function obtener(req, res) {
    const id = entero(req.params.id, 'cliente');
    if (req.sesion.tipo === 'cliente' && req.sesion.id !== id) throw new ErrorHttp(403, 'Solo puedes ver tus propios datos.');
    const { rows } = await query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (!rows[0]) throw new ErrorHttp(404, 'Cliente no encontrado.');
    res.json(publicoCliente(rows[0]));
}

async function crear(req, res) {
    const d = validarCliente(req.body);
    const pinHash = d.pin ? await hashClave(d.pin) : null;
    const { rows } = await query(
        `INSERT INTO clientes (tipo, documento, nombre, hectareas, ubicacion_sector, cultivo, pin_hash, almacena, capacidad_reservorio_m3)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [d.tipo, d.documento, d.nombre, d.hectareas, d.ubicacion_sector, d.cultivo, pinHash, d.almacena, d.capacidad_reservorio_m3]
    );
    await auditoria.registrar(req, 'crear', 'clientes', rows[0].id, { documento: d.documento });
    res.status(201).json(publicoCliente(rows[0]));
}

async function actualizar(req, res) {
    const id = entero(req.params.id, 'cliente');
    const d = validarCliente(req.body, { esEdicion: true });
    const quitarPin = req.body.quitar_pin === true;
    const params = [d.tipo, d.documento, d.nombre, d.hectareas, d.ubicacion_sector, d.cultivo, id, d.almacena, d.capacidad_reservorio_m3];
    let extra = '';
    if (d.pin) { params.push(await hashClave(d.pin)); extra = `, pin_hash = $${params.length}, intentos_fallidos = 0, bloqueado_hasta = NULL`; }
    else if (quitarPin) extra = ', pin_hash = NULL';
    const { rows } = await query(
        `UPDATE clientes SET tipo=$1, documento=$2, nombre=$3, hectareas=$4, ubicacion_sector=$5, cultivo=$6,
                almacena=$8, capacidad_reservorio_m3=$9${extra}
         WHERE id=$7 RETURNING *`, params
    );
    if (!rows[0]) throw new ErrorHttp(404, 'Cliente no encontrado.');
    await auditoria.registrar(req, 'editar', 'clientes', id, { pin_cambiado: Boolean(d.pin), pin_quitado: quitarPin });
    res.json(publicoCliente(rows[0]));
}

async function eliminar(req, res) {
    const id = entero(req.params.id, 'cliente');
    const pagos = await query("SELECT COUNT(*)::int AS n FROM pagos WHERE cliente_id = $1 AND estado = 'aprobado'", [id]);
    if (pagos.rows[0].n > 0) {
        // Con comprobantes emitidos no se borra (trazabilidad tributaria): se desactiva.
        await query('UPDATE clientes SET activo = false WHERE id = $1', [id]);
        await auditoria.registrar(req, 'desactivar', 'clientes', id);
        return res.json({ ok: true, desactivado: true, mensaje: 'El cliente tiene comprobantes emitidos: se desactivó en lugar de eliminarse.' });
    }
    const r = await query('DELETE FROM clientes WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErrorHttp(404, 'Cliente no encontrado.');
    await auditoria.registrar(req, 'eliminar', 'clientes', id);
    res.json({ ok: true });
}

async function reactivar(req, res) {
    const id = entero(req.params.id, 'cliente');
    await query('UPDATE clientes SET activo = true WHERE id = $1', [id]);
    await auditoria.registrar(req, 'reactivar', 'clientes', id);
    res.json({ ok: true });
}

module.exports = { listar, obtener, crear, actualizar, eliminar, reactivar };
