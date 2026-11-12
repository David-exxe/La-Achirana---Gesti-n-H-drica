const { query } = require('../Config/db');
const { hashClave } = require('../utils/seguridad');
const { validarUsuario, entero, ErrorHttp } = require('../utils/validacion');
const auditoria = require('../services/auditoria.service');

async function listar(req, res) {
    const { rows } = await query(
        'SELECT id, nombre, email, rol, activo, ultimo_acceso FROM usuarios ORDER BY nombre ASC'
    );
    res.json(rows);
}

async function crear(req, res) {
    const d = validarUsuario(req.body);
    const { rows } = await query(
        'INSERT INTO usuarios (nombre, email, pass, rol) VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol, activo',
        [d.nombre, d.email, await hashClave(d.pass), d.rol]
    );
    await auditoria.registrar(req, 'crear', 'usuarios', rows[0].id, { email: d.email });
    res.status(201).json(rows[0]);
}

async function actualizar(req, res) {
    const id = entero(req.params.id, 'usuario');
    const d = validarUsuario(req.body, { esEdicion: true });
    if (id === req.sesion.id && d.rol !== 'admin') throw new ErrorHttp(400, 'No puedes quitarte tu propio rol de administrador.');
    const params = [d.nombre, d.email, d.rol, id];
    let extra = '';
    if (d.pass) { params.push(await hashClave(d.pass)); extra = `, pass = $${params.length}, intentos_fallidos = 0, bloqueado_hasta = NULL`; }
    const { rows } = await query(
        `UPDATE usuarios SET nombre=$1, email=$2, rol=$3${extra} WHERE id=$4 RETURNING id, nombre, email, rol, activo`, params
    );
    if (!rows[0]) throw new ErrorHttp(404, 'Usuario no encontrado.');
    await auditoria.registrar(req, 'editar', 'usuarios', id, { clave_cambiada: Boolean(d.pass) });
    res.json(rows[0]);
}

async function eliminar(req, res) {
    const id = entero(req.params.id, 'usuario');
    if (id === req.sesion.id) throw new ErrorHttp(400, 'No puedes eliminar tu propia cuenta.');
    const admins = await query("SELECT COUNT(*)::int AS n FROM usuarios WHERE rol = 'admin' AND activo AND id <> $1", [id]);
    if (admins.rows[0].n === 0) throw new ErrorHttp(400, 'Debe quedar al menos un administrador activo.');
    const r = await query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErrorHttp(404, 'Usuario no encontrado.');
    await auditoria.registrar(req, 'eliminar', 'usuarios', id);
    res.json({ ok: true });
}

async function auditoriaReciente(req, res) {
    const { rows } = await query(
        `SELECT a.id, a.actor_tipo, a.actor_id, a.accion, a.entidad, a.entidad_id, a.detalle, a.ip,
                TO_CHAR(a.creado_en AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS fecha,
                COALESCE(u.nombre, c.nombre) AS actor_nombre
           FROM auditoria a
           LEFT JOIN usuarios u ON a.actor_tipo = 'usuario' AND u.id = a.actor_id
           LEFT JOIN clientes c ON a.actor_tipo = 'cliente' AND c.id = a.actor_id
          ORDER BY a.id DESC LIMIT 100`
    );
    res.json(rows);
}

module.exports = { listar, crear, actualizar, eliminar, auditoriaReciente };
