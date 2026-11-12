const { query, transaccion } = require('../Config/db');
const { ErrorHttp, entero, limpiar } = require('../utils/validacion');
const { clienteObjetivo } = require('../middleware/auth');
const pagosSrv = require('../services/pagos.service');
const { leerImagen, aDataUrl } = require('../utils/imagen');
const auditoria = require('../services/auditoria.service');
const culqi = require('../services/culqi.service');
const config = require('../Config/env');
const crypto = require('crypto');

const TIPOS = ['BOLETA', 'FACTURA'];
const METODOS = ['yape', 'plin', 'transferencia'];
const ENTIDADES = {
    yape: ['Yape (BCP)'],
    plin: ['Plin'],
    transferencia: ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Banco de la Nación', 'BanBif', 'Caja Ica', 'Otra'],
};
const MEDIOS_CAJA = ['efectivo', 'yape', 'plin', 'transferencia', 'deposito'];

const tipoValido = t => {
    const tipo = String(t || 'BOLETA').toUpperCase();
    if (!TIPOS.includes(tipo)) throw new ErrorHttp(400, 'Tipo de comprobante no válido.', { tipo: 'Boleta o factura.' });
    return tipo;
};

async function cotizacion(req, res) {
    const clienteId = clienteObjetivo(req, req.query.cliente_id);
    const c = await pagosSrv.cotizar(clienteId);
    const enValidacion = await query(
        `SELECT id, monto, metodo, entidad, operacion, TO_CHAR(actualizado_en AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS enviado
           FROM pagos WHERE cliente_id = $1 AND estado = 'validacion' ORDER BY id DESC LIMIT 1`, [clienteId]);
    const rechazado = await query(
        `SELECT id, motivo_rechazo, TO_CHAR(validado_en AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS fecha
           FROM pagos WHERE cliente_id = $1 AND estado = 'rechazado' AND validado_en > now() - INTERVAL '7 days' ORDER BY id DESC LIMIT 1`, [clienteId]);
    res.json({ ...c, en_validacion: enValidacion.rows[0] || null, ultimo_rechazo: rechazado.rows[0] || null, puede_pagar_online: c.lecturas > 0 && c.monto > 0 && !enValidacion.rows[0] });
}

// ------------------------------------------------------------------ Yape, Plin y bancos
async function cuentasActivas() {
    const { rows } = await query('SELECT * FROM cuentas_cobro WHERE activo ORDER BY orden, id');
    return rows;
}
const cuentaPublica = c => ({
    id: c.id, metodo: c.metodo, entidad: c.entidad, titular: c.titular, numero: c.numero, cci: c.cci,
    instrucciones: c.instrucciones, qr: aDataUrl(c.qr_mime, c.qr_datos), activo: c.activo, orden: c.orden,
});

/** Medios de pago que el regante puede usar (configurados por la Junta). */
async function medios(req, res) {
    res.json({ cuentas: (await cuentasActivas()).map(cuentaPublica), entidades: ENTIDADES });
}

/**
 * El regante (o el personal en su nombre) informa un pago hecho por Yape, Plin o transferencia.
 * Queda "en validación" hasta que un administrador lo compare con su app o estado de cuenta.
 */
async function reportar(req, res) {
    const clienteId = clienteObjetivo(req, req.body?.cliente_id);
    const tipo = tipoValido(req.body?.tipo);
    const cuentaId = entero(req.body?.cuenta_id, 'medio de pago');
    const operacion = limpiar(req.body?.operacion || '').toUpperCase();
    const montoDeclarado = Number(req.body?.monto);
    const fechaTxt = String(req.body?.fecha_operacion || '');
    const errores = {};
    if (!/^[A-Z0-9-]{4,30}$/.test(operacion)) errores.operacion = 'Entre 4 y 30 caracteres: letras, números o guiones.';
    const fecha = new Date(fechaTxt);
    if (Number.isNaN(fecha.getTime())) errores.fecha_operacion = 'Indica la fecha y hora del pago.';
    else if (fecha.getTime() > Date.now() + 10 * 60000) errores.fecha_operacion = 'La fecha no puede ser futura.';
    else if (fecha.getTime() < Date.now() - 15 * 86400000) errores.fecha_operacion = 'Solo pagos de los últimos 15 días.';
    if (!Number.isFinite(montoDeclarado) || montoDeclarado <= 0) errores.monto = 'Indica el monto que pagaste.';
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los datos del pago.', errores);

    const { rows: cuentas } = await query('SELECT * FROM cuentas_cobro WHERE id = $1 AND activo', [cuentaId]);
    const cuenta = cuentas[0];
    if (!cuenta) throw new ErrorHttp(400, 'Ese medio de pago ya no está disponible.', { cuenta_id: 'Elige otro medio.' });
    // Yape y Plin: la captura es obligatoria. Transferencia: recomendada.
    const voucher = leerImagen(req.body?.voucher, { campo: 'voucher', obligatoria: cuenta.metodo !== 'transferencia' });

    const previo = await query("SELECT id FROM pagos WHERE cliente_id = $1 AND estado = 'validacion' LIMIT 1", [clienteId]);
    if (previo.rows[0]) throw new ErrorHttp(409, 'Ya tienes un pago en validación. Espera a que la Junta lo revise antes de enviar otro.');

    const { pago, cotizacion: c } = await pagosSrv.crearPendiente({
        clienteId, tipo, metodo: cuenta.metodo, usuarioId: req.sesion.tipo === 'usuario' ? req.sesion.id : null,
    });
    if (Math.abs(montoDeclarado - c.monto) > 0.009) {
        throw new ErrorHttp(400, `El monto debe ser exactamente ${c.monto.toFixed(2)} soles.`, { monto: `Debe ser S/ ${c.monto.toFixed(2)}.` });
    }
    try {
        await transaccion(async db => {
            await db.query(
                `UPDATE pagos SET estado = 'validacion', cuenta_id = $2, entidad = $3, operacion = $4, fecha_operacion = $5,
                        monto_declarado = $6, actualizado_en = now() WHERE id = $1`,
                [pago.id, cuenta.id, cuenta.entidad, operacion, fecha, montoDeclarado]
            );
            if (voucher) {
                await db.query(
                    `INSERT INTO vouchers (pago_id, mime, datos, tamano) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (pago_id) DO UPDATE SET mime = EXCLUDED.mime, datos = EXCLUDED.datos, tamano = EXCLUDED.tamano, subido_en = now()`,
                    [pago.id, voucher.mime, voucher.datos, voucher.datos.length]
                );
            }
            await db.query(
                'INSERT INTO historial_pagos (cliente_id, pago_id, monto, estado, detalle) VALUES ($1,$2,$3,$4,$5)',
                [pago.cliente_id, pago.id, pago.monto, 'validacion', `${cuenta.entidad} · operación ${operacion}`]
            );
        });
    } catch (err) {
        if (err.code === '23505') throw new ErrorHttp(409, 'Ese número de operación ya fue registrado en otro pago.', { operacion: 'Número de operación repetido.' });
        throw err;
    }
    await auditoria.registrar(req, 'reportar_pago', 'pagos', pago.id, { metodo: cuenta.metodo, entidad: cuenta.entidad, operacion, monto: c.monto });
    const { rows } = await query('SELECT * FROM pagos WHERE id = $1', [pago.id]);
    res.status(201).json({ pago: await formatear(rows[0]) });
}

/** Imagen del voucher (dueño del pago o personal). */
async function voucher(req, res) {
    const id = entero(req.params.id, 'pago');
    const { rows } = await query('SELECT v.mime, v.datos, p.cliente_id FROM vouchers v JOIN pagos p ON p.id = v.pago_id WHERE v.pago_id = $1', [id]);
    const v = rows[0];
    if (!v || (req.sesion.tipo === 'cliente' && v.cliente_id !== req.sesion.id)) throw new ErrorHttp(404, 'Voucher no encontrado.');
    res.setHeader('Content-Type', v.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.send(v.datos);
}

/** Cola de pagos por validar (administrador y gerencia). */
async function porValidar(req, res) {
    const { rows } = await query(
        `SELECT p.id, p.cliente_id, c.nombre AS cliente_nombre, c.documento AS cliente_doc, c.tipo AS cliente_tipo,
                p.tipo, p.monto, p.monto_declarado, p.metodo, p.entidad, p.operacion, p.volumen_m3,
                TO_CHAR(p.fecha_operacion AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS fecha_operacion,
                TO_CHAR(p.actualizado_en AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS enviado,
                ROUND(EXTRACT(EPOCH FROM (now() - p.actualizado_en)) / 3600.0, 1) AS horas_espera,
                (v.pago_id IS NOT NULL) AS tiene_voucher, cc.numero AS cuenta_numero, cc.titular AS cuenta_titular
           FROM pagos p JOIN clientes c ON c.id = p.cliente_id
           LEFT JOIN vouchers v ON v.pago_id = p.id
           LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_id
          WHERE p.estado = 'validacion' ORDER BY p.actualizado_en ASC`
    );
    res.json(rows);
}

/** El administrador aprueba (emite comprobante) o rechaza un pago informado. */
async function validar(req, res) {
    const id = entero(req.params.id, 'pago');
    const decision = String(req.body?.decision || '');
    const motivo = limpiar(req.body?.motivo || '');
    if (!['aprobar', 'rechazar'].includes(decision)) throw new ErrorHttp(400, 'Decisión no válida.');
    if (decision === 'rechazar' && (motivo.length < 5 || motivo.length > 200)) {
        throw new ErrorHttp(400, 'Explica al regante por qué se rechaza.', { motivo: 'Entre 5 y 200 caracteres.' });
    }
    const { rows } = await query('SELECT * FROM pagos WHERE id = $1', [id]);
    const pago = rows[0];
    if (!pago) throw new ErrorHttp(404, 'Pago no encontrado.');
    if (pago.estado !== 'validacion') throw new ErrorHttp(409, 'Este pago ya fue revisado.');
    let resultado;
    if (decision === 'aprobar') {
        resultado = await pagosSrv.aprobar(id, { statusDetail: pago.operacion, metodoDetalle: `${pago.entidad} op. ${pago.operacion}` });
    } else {
        resultado = await pagosSrv.actualizarEstado(id, 'rechazado', { statusDetail: 'rechazado_por_junta' });
        await query('UPDATE pagos SET motivo_rechazo = $2 WHERE id = $1', [id, motivo]);
    }
    await query('UPDATE pagos SET validado_por = $2, validado_en = now() WHERE id = $1', [id, req.sesion.id]);
    await auditoria.registrar(req, decision === 'aprobar' ? 'validar_pago' : 'rechazar_pago', 'pagos', id, { motivo: motivo || null, monto: pago.monto });
    const fin = await query('SELECT * FROM pagos WHERE id = $1', [id]);
    res.json({ pago: await formatear(fin.rows[0]) });
}

// ------------------------------------------------------------------ Pago en línea (Culqi / demostración)
/** Qué pagos en línea están disponibles: Culqi real/pruebas o modo demostración. */
async function enLinea(req, res) {
    res.json({ culqi: culqi.configuracionPublica(), demo: config.pagosDemo });
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

/** Cobra con el token que generó el checkout de Culqi (tarjeta o Yape). */
async function cargoCulqi(req, res) {
    if (!config.culqi.activo) throw new ErrorHttp(503, 'El pago con tarjeta no está configurado.');
    const clienteId = clienteObjetivo(req, req.body?.cliente_id);
    const tipo = tipoValido(req.body?.tipo);
    const token = String(req.body?.token || '');
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^(tkn|ype)_(test|live)_[A-Za-z0-9]{6,60}$/.test(token)) throw new ErrorHttp(400, 'El token de pago no es válido. Vuelve a intentarlo.');
    if (!EMAIL_RE.test(email)) throw new ErrorHttp(400, 'Falta un correo válido para enviarte la constancia de Culqi.');
    const metodo = token.startsWith('ype_') ? 'yape' : 'tarjeta';
    const { pago, cliente } = await pagosSrv.crearPendiente({ clienteId, tipo, metodo, montoMinimo: config.culqi.montoMinimo });

    let cargo;
    try {
        cargo = await culqi.crearCargo({
            token, email, monto: pago.monto,
            descripcion: `Canon hidrico La Achirana - pago ${pago.id}`,
            metadata: { pago_id: String(pago.id), cliente_id: String(clienteId), documento: String(cliente.documento || '') },
        });
    } catch (err) {
        await pagosSrv.actualizarEstado(pago.id, 'anulado', { statusDetail: 'culqi_rechazado' });
        await auditoria.registrar(req, 'pago_rechazado_culqi', 'pagos', pago.id, { monto: pago.monto, motivo: err.message });
        throw err;
    }
    const entidad = cargo.medio === 'yape' ? 'Yape (Culqi)' : `${cargo.marca}${cargo.ultimos4 ? ` ****${cargo.ultimos4}` : ''}`;
    await query('UPDATE pagos SET metodo = $2, entidad = $3, operacion = $4, fecha_operacion = now(), monto_declarado = monto WHERE id = $1',
        [pago.id, cargo.medio, entidad.slice(0, 60), cargo.id.slice(0, 60)]);
    const aprobado = await pagosSrv.aprobar(pago.id, { statusDetail: cargo.id, metodoDetalle: `Culqi ${entidad}` });
    await auditoria.registrar(req, 'pago_culqi', 'pagos', pago.id, { monto: pago.monto, cargo: cargo.id, medio: cargo.medio });
    res.status(201).json({ pago: await formatear(aprobado), mensaje: cargo.mensaje });
}

/**
 * Modo demostración (sin Culqi): simula un cobro aprobado para presentar el sistema.
 * El número de tarjeta NUNCA llega al servidor: solo la marca y los últimos 4 dígitos.
 */
async function cargoDemo(req, res) {
    if (!config.pagosDemo) throw new ErrorHttp(404, 'El modo demostración está desactivado.');
    const clienteId = clienteObjetivo(req, req.body?.cliente_id);
    const tipo = tipoValido(req.body?.tipo);
    const medio = String(req.body?.medio || '');
    if (!['tarjeta', 'yape'].includes(medio)) throw new ErrorHttp(400, 'Medio no válido.');
    let entidad;
    if (medio === 'tarjeta') {
        const marca = String(req.body?.marca || '');
        const ultimos4 = String(req.body?.ultimos4 || '');
        if (!['Visa', 'Mastercard', 'Amex', 'Diners'].includes(marca) || !/^\d{4}$/.test(ultimos4)) throw new ErrorHttp(400, 'Datos de tarjeta no válidos.');
        entidad = `Demo ${marca} ****${ultimos4}`;
    } else {
        const celular = String(req.body?.celular || '');
        if (!/^9\d{8}$/.test(celular)) throw new ErrorHttp(400, 'Celular no válido.', { celular: '9 dígitos, empieza con 9.' });
        entidad = `Demo Yape ***${celular.slice(-3)}`;
    }
    const { pago } = await pagosSrv.crearPendiente({ clienteId, tipo, metodo: medio });
    const operacion = `DEMO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await query('UPDATE pagos SET entidad = $2, operacion = $3, fecha_operacion = now(), monto_declarado = monto WHERE id = $1', [pago.id, entidad, operacion]);
    const aprobado = await pagosSrv.aprobar(pago.id, { statusDetail: operacion, metodoDetalle: entidad });
    await auditoria.registrar(req, 'pago_demo', 'pagos', pago.id, { monto: pago.monto, medio });
    res.status(201).json({ pago: await formatear(aprobado), demo: true });
}

// ------------------------------------------------------------------ Cuentas de cobro (admin)
function validarCuenta(b) {
    const errores = {};
    const metodo = String(b.metodo || '');
    const entidad = limpiar(b.entidad || '');
    const titular = limpiar(b.titular || '');
    const numero = String(b.numero || '').replace(/[\s-]/g, '');
    const cci = String(b.cci || '').replace(/[\s-]/g, '');
    const instrucciones = limpiar(b.instrucciones || '');
    if (!METODOS.includes(metodo)) errores.metodo = 'Elige Yape, Plin o transferencia.';
    else if (!ENTIDADES[metodo].includes(entidad)) errores.entidad = 'Elige la entidad.';
    if (titular.length < 3 || titular.length > 100) errores.titular = 'Entre 3 y 100 caracteres.';
    if (metodo === 'yape' || metodo === 'plin') {
        if (!/^9\d{8}$/.test(numero)) errores.numero = 'Celular de 9 dígitos que empieza con 9.';
    } else if (!/^\d{10,20}$/.test(numero)) errores.numero = 'Número de cuenta: entre 10 y 20 dígitos.';
    if (metodo === 'transferencia' && cci && !/^\d{20}$/.test(cci)) errores.cci = 'El CCI tiene 20 dígitos.';
    if (instrucciones.length > 200) errores.instrucciones = 'Máximo 200 caracteres.';
    const qr = metodo === 'transferencia' ? null : leerImagen(b.qr, { campo: 'qr', obligatoria: false, maxBytes: 600 * 1024 });
    const orden = Number.isInteger(Number(b.orden)) ? Number(b.orden) : 0;
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    return { metodo, entidad, titular, numero, cci: metodo === 'transferencia' ? cci || null : null, instrucciones: instrucciones || null, qr, orden, activo: b.activo !== false, quitarQr: b.quitar_qr === true };
}

async function listarCuentas(req, res) {
    const { rows } = await query('SELECT * FROM cuentas_cobro ORDER BY orden, id');
    res.json(rows.map(cuentaPublica));
}
async function crearCuenta(req, res) {
    const d = validarCuenta(req.body || {});
    const { rows } = await query(
        `INSERT INTO cuentas_cobro (metodo, entidad, titular, numero, cci, qr_mime, qr_datos, instrucciones, activo, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [d.metodo, d.entidad, d.titular, d.numero, d.cci, d.qr?.mime || null, d.qr?.datos || null, d.instrucciones, d.activo, d.orden]
    );
    await auditoria.registrar(req, 'crear', 'cuentas_cobro', rows[0].id, { metodo: d.metodo, entidad: d.entidad });
    res.status(201).json(cuentaPublica(rows[0]));
}
async function actualizarCuenta(req, res) {
    const id = entero(req.params.id, 'cuenta');
    const d = validarCuenta(req.body || {});
    const qrSql = d.qr ? ', qr_mime = $10, qr_datos = $11' : d.quitarQr || d.metodo === 'transferencia' ? ', qr_mime = NULL, qr_datos = NULL' : '';
    const params = [d.metodo, d.entidad, d.titular, d.numero, d.cci, d.instrucciones, d.activo, d.orden, id];
    if (d.qr) params.push(d.qr.mime, d.qr.datos);
    const { rows } = await query(
        `UPDATE cuentas_cobro SET metodo=$1, entidad=$2, titular=$3, numero=$4, cci=$5, instrucciones=$6, activo=$7, orden=$8${qrSql}
          WHERE id = $9 RETURNING *`, params);
    if (!rows[0]) throw new ErrorHttp(404, 'Cuenta no encontrada.');
    await auditoria.registrar(req, 'editar', 'cuentas_cobro', id, { metodo: d.metodo });
    res.json(cuentaPublica(rows[0]));
}
async function eliminarCuenta(req, res) {
    const id = entero(req.params.id, 'cuenta');
    const usada = await query('SELECT 1 FROM pagos WHERE cuenta_id = $1 LIMIT 1', [id]);
    if (usada.rows[0]) {
        await query('UPDATE cuentas_cobro SET activo = false WHERE id = $1', [id]);
        await auditoria.registrar(req, 'desactivar', 'cuentas_cobro', id);
        return res.json({ ok: true, desactivada: true, mensaje: 'La cuenta tiene pagos asociados: se desactivó en lugar de borrarse.' });
    }
    const r = await query('DELETE FROM cuentas_cobro WHERE id = $1', [id]);
    if (!r.rowCount) throw new ErrorHttp(404, 'Cuenta no encontrada.');
    await auditoria.registrar(req, 'eliminar', 'cuentas_cobro', id);
    res.json({ ok: true });
}

/** Pago en caja (efectivo/transferencia) registrado por un administrador. */
async function pagoManual(req, res) {
    const clienteId = entero(req.body?.cliente_id, 'cliente');
    const tipo = tipoValido(req.body?.tipo);
    const metodo = String(req.body?.metodo || '').toLowerCase();
    if (!MEDIOS_CAJA.includes(metodo)) {
        throw new ErrorHttp(400, 'Elige el medio de pago.', { metodo: 'Efectivo, Yape, Plin, transferencia o depósito.' });
    }
    const referencia = limpiar(req.body?.referencia || '');
    if (metodo !== 'efectivo' && !/^[A-Za-z0-9-]{4,40}$/.test(referencia)) {
        throw new ErrorHttp(400, 'Ingresa el número de operación.', { referencia: 'Entre 4 y 40 caracteres (letras, números o guiones).' });
    }
    const { pago } = await pagosSrv.crearPendiente({ clienteId, tipo, metodo, usuarioId: req.sesion.id });
    if (referencia) await query('UPDATE pagos SET operacion = $2, entidad = $3 WHERE id = $1', [pago.id, referencia.toUpperCase(), `caja-${metodo}`]);
    const aprobado = await pagosSrv.aprobar(pago.id, { statusDetail: referencia || null, metodoDetalle: metodo });
    await auditoria.registrar(req, 'pago_manual', 'pagos', pago.id, { metodo, referencia, monto: pago.monto });
    res.status(201).json({ pago: await formatear(aprobado) });
}

async function formatear(p) {
    const { rows } = await query(
        `SELECT p.id, p.cliente_id, c.nombre AS cliente_nombre, c.documento AS cliente_doc, c.tipo AS cliente_tipo,
                c.ubicacion_sector AS cliente_dir, TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha,
                p.tipo, p.numero, p.concepto, p.monto, p.estado, p.metodo, p.volumen_m3, p.tarifa_m3, p.mp_status_detail,
                p.entidad, p.operacion, p.motivo_rechazo,
                TO_CHAR(p.fecha_operacion AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS fecha_operacion
           FROM pagos p JOIN clientes c ON c.id = p.cliente_id WHERE p.id = $1`,
        [p.id]
    );
    const r = rows[0];
    return { ...r, ...pagosSrv.desglose(Number(r.monto)), motivo: r.motivo_rechazo || null };
}

async function listar(req, res) {
    const clienteId = req.sesion.tipo === 'cliente' || req.query.cliente_id ? clienteObjetivo(req, req.query.cliente_id) : null;
    const filtro = req.query.filtro;
    const estado = req.query.estado;
    const params = [];
    const cond = ['1=1'];
    if (clienteId) { params.push(clienteId); cond.push(`p.cliente_id = $${params.length}`); }
    if (filtro === 'dia') cond.push('p.fecha >= CURRENT_DATE');
    else if (filtro === 'semana') cond.push("p.fecha >= CURRENT_DATE - INTERVAL '7 days'");
    else if (filtro === 'mes') cond.push("p.fecha >= CURRENT_DATE - INTERVAL '30 days'");
    if (estado && ['aprobado', 'pendiente', 'validacion', 'rechazado', 'anulado', 'revision', 'reembolsado'].includes(estado)) {
        params.push(estado); cond.push(`p.estado = $${params.length}`);
    } else {
        cond.push("p.estado IN ('aprobado','validacion','rechazado','revision','reembolsado')");
    }
    const { rows } = await query(
        `SELECT p.id, p.cliente_id, c.nombre AS cliente_nombre, c.documento AS cliente_doc,
                TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') AS fecha, p.tipo, p.numero, p.concepto, p.monto,
                p.estado, p.metodo, p.volumen_m3, p.entidad, p.operacion, p.motivo_rechazo
           FROM pagos p JOIN clientes c ON c.id = p.cliente_id
          WHERE ${cond.join(' AND ')}
          ORDER BY p.fecha DESC, p.id DESC LIMIT 500`,
        params
    );
    const pagos = rows.map(p => ({ ...p, ...pagosSrv.desglose(Number(p.monto)), motivo: p.motivo_rechazo || null }));
    const totalAcumulado = pagosSrv.redondear(pagos.filter(p => p.estado === 'aprobado').reduce((s, p) => s + Number(p.monto), 0));
    res.json({ pagos, totalAcumulado });
}

async function comprobante(req, res) {
    const id = entero(req.params.id, 'pago');
    const { rows } = await query('SELECT * FROM pagos WHERE id = $1', [id]);
    const p = rows[0];
    if (!p || (req.sesion.tipo === 'cliente' && p.cliente_id !== req.sesion.id)) throw new ErrorHttp(404, 'Comprobante no encontrado.');
    if (p.estado !== 'aprobado') throw new ErrorHttp(400, 'Este pago aún no está aprobado; no tiene comprobante.');
    res.json(await formatear(p));
}

async function recaudacion(req, res) {
    const { rows } = await query(`
        SELECT COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado'), 0) AS total,
               COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado' AND fecha >= date_trunc('month', CURRENT_DATE)), 0) AS mes,
               COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado' AND fecha >= CURRENT_DATE), 0) AS hoy,
               COUNT(*) FILTER (WHERE estado = 'validacion')::int AS pendientes,
               COUNT(*) FILTER (WHERE estado = 'revision')::int AS en_revision
          FROM pagos`);
    const deuda = await query(`
        SELECT COALESCE(SUM(COALESCE(h.volumen_m3, h.m3_dia)), 0) AS m3 FROM historial_caudal h
          JOIN clientes c ON c.id = h.cliente_id WHERE h.pago_id IS NULL AND c.activo`);
    const tarifa = await pagosSrv.tarifaVigente();
    const porMes = await query(`
        SELECT TO_CHAR(date_trunc('month', fecha), 'YYYY-MM') AS mes, SUM(monto) AS total
          FROM pagos WHERE estado = 'aprobado' AND fecha >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
         GROUP BY 1 ORDER BY 1`);
    res.json({
        totalGlobal: rows[0].total, ...rows[0],
        por_cobrar: pagosSrv.redondear(deuda.rows[0].m3 * tarifa.precio_m3),
        tarifa_m3: tarifa.precio_m3,
        por_mes: porMes.rows,
    });
}

async function obtenerTarifa(req, res) {
    const t = await pagosSrv.tarifaVigente();
    const hist = await query(
        `SELECT t.precio_m3, TO_CHAR(t.vigente_desde AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS desde, t.motivo, u.nombre AS por
           FROM tarifas t LEFT JOIN usuarios u ON u.id = t.creado_por ORDER BY t.vigente_desde DESC LIMIT 10`
    );
    res.json({ precio_m3: t.precio_m3, historial: hist.rows });
}

async function cambiarTarifa(req, res) {
    const precio = Number(req.body?.precio_m3);
    const motivo = limpiar(req.body?.motivo || '');
    const errores = {};
    if (!Number.isFinite(precio) || precio <= 0 || precio >= 1000) errores.precio_m3 = 'Debe ser mayor que 0 y menor que 1000.';
    else if (Math.round(precio * 10000) / 10000 !== precio) errores.precio_m3 = 'Máximo 4 decimales.';
    if (motivo.length < 5 || motivo.length > 200) errores.motivo = 'Explica el cambio (5 a 200 caracteres).';
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    await query('INSERT INTO tarifas (precio_m3, motivo, creado_por) VALUES ($1,$2,$3)', [precio, motivo, req.sesion.id]);
    await auditoria.registrar(req, 'cambiar_tarifa', 'tarifas', null, { precio, motivo });
    res.status(201).json({ ok: true, precio_m3: precio });
}

module.exports = {
    cotizacion, medios, reportar, voucher, porValidar, validar, pagoManual, listar, comprobante,
    recaudacion, obtenerTarifa, cambiarTarifa, enLinea, cargoCulqi, cargoDemo, listarCuentas, crearCuenta, actualizarCuenta, eliminarCuenta,
};
