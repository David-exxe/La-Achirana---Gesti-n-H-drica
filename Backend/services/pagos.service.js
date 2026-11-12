// =====================================================================
//  Lógica de cobro del canon hídrico
//   - Cobra SOLO las lecturas de caudal pendientes (no todo el historial)
//   - Precio desde la tabla "tarifas" (no desde el navegador)
//   - Numeración correlativa con secuencias de PostgreSQL
// =====================================================================
const { query, transaccion } = require('../Config/db');
const { ErrorHttp } = require('../utils/validacion');

const redondear = n => Math.round(n * 100) / 100;

async function tarifaVigente(db = { query }) {
    const { rows } = await db.query('SELECT id, precio_m3, vigente_desde FROM tarifas ORDER BY vigente_desde DESC, id DESC LIMIT 1');
    if (!rows[0]) throw new ErrorHttp(500, 'No hay una tarifa configurada.');
    return rows[0];
}

function desglose(total) {
    const subtotal = redondear(total / 1.18);
    return { subtotal, igv: redondear(total - subtotal), total: redondear(total) };
}

/** Calcula cuánto debe el cliente ahora mismo. */
async function cotizar(clienteId, db = { query }) {
    const tarifa = await tarifaVigente(db);
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS lecturas, COALESCE(SUM(COALESCE(volumen_m3, m3_dia)), 0) AS volumen, MAX(id) AS hasta_id,
                TO_CHAR(MIN(fecha), 'YYYY-MM-DD') AS desde, TO_CHAR(MAX(fecha), 'YYYY-MM-DD') AS hasta
           FROM historial_caudal WHERE cliente_id = $1 AND pago_id IS NULL`,
        [clienteId]
    );
    const r = rows[0];
    const volumen = redondear(r.volumen);
    const monto = redondear(volumen * tarifa.precio_m3);
    return {
        lecturas: r.lecturas,
        volumen_m3: volumen,
        tarifa_m3: tarifa.precio_m3,
        monto,
        ...desglose(monto),
        lectura_hasta_id: r.hasta_id,
        periodo: r.desde ? { desde: r.desde, hasta: r.hasta } : null,
    };
}

function conceptoDe(c) {
    const periodo = c.periodo ? ` del ${c.periodo.desde} al ${c.periodo.hasta}` : '';
    return `Canon hídrico por consumo volumétrico${periodo} (${c.volumen_m3.toFixed(2)} m³ a S/ ${Number(c.tarifa_m3).toFixed(4)} por m³)`;
}

/**
 * Crea (o reutiliza) un pago PENDIENTE para el cliente.
 * Bloquea la fila del cliente para evitar dobles cobros simultáneos.
 */
async function crearPendiente({ clienteId, tipo, metodo, usuarioId = null, montoMinimo = 0 }) {
    return transaccion(async db => {
        const cli = await db.query('SELECT * FROM clientes WHERE id = $1 FOR UPDATE', [clienteId]);
        const cliente = cli.rows[0];
        if (!cliente) throw new ErrorHttp(404, 'Cliente no encontrado.');
        if (cliente.activo === false) throw new ErrorHttp(400, 'El cliente está inactivo.');
        if (tipo === 'FACTURA' && cliente.tipo !== 'empresa') {
            throw new ErrorHttp(400, 'La factura solo se emite a clientes con RUC. Elige boleta.', { tipo: 'Solo para RUC.' });
        }

        const c = await cotizar(clienteId, db);
        if (c.lecturas === 0 || c.monto <= 0) {
            throw new ErrorHttp(400, 'No tienes consumo pendiente de pago. Cuando se registren nuevas lecturas de caudal podrás pagar.');
        }
        if (c.monto < montoMinimo) {
            throw new ErrorHttp(400, `El monto pendiente (S/ ${c.monto.toFixed(2)}) es menor al mínimo para pagar en línea (S/ ${montoMinimo.toFixed(2)}). Puedes pagarlo en caja o esperar a acumular más consumo.`);
        }

        // ¿Ya existe uno pendiente idéntico? Se reutiliza (evita preferencias duplicadas)
        const prev = await db.query(
            `SELECT * FROM pagos WHERE cliente_id = $1 AND estado = 'pendiente' AND metodo = $2 AND tipo = $3
               AND lectura_hasta_id = $4 AND monto = $5 AND fecha > now() - INTERVAL '20 hours'
             ORDER BY id DESC LIMIT 1`,
            [clienteId, metodo, tipo, c.lectura_hasta_id, c.monto]
        );
        if (prev.rows[0]) return { pago: prev.rows[0], cliente, cotizacion: c, reutilizado: true };

        // Anula pendientes anteriores (montos desactualizados)
        await db.query(
            "UPDATE pagos SET estado = 'anulado', actualizado_en = now() WHERE cliente_id = $1 AND estado = 'pendiente'",
            [clienteId]
        );

        const ins = await db.query(
            `INSERT INTO pagos (cliente_id, tipo, concepto, monto, estado, metodo, volumen_m3, tarifa_m3, lectura_hasta_id, registrado_por)
             VALUES ($1,$2,$3,$4,'pendiente',$5,$6,$7,$8,$9) RETURNING *`,
            [clienteId, tipo, conceptoDe(c), c.monto, metodo, c.volumen_m3, c.tarifa_m3, c.lectura_hasta_id, usuarioId]
        );
        await evento(db, ins.rows[0], 'pendiente', `Pago creado (${metodo})`);
        return { pago: ins.rows[0], cliente, cotizacion: c, reutilizado: false };
    });
}

async function evento(db, pago, estado, detalle) {
    await db.query(
        'INSERT INTO historial_pagos (cliente_id, pago_id, monto, estado, detalle) VALUES ($1,$2,$3,$4,$5)',
        [pago.cliente_id, pago.id, pago.monto, estado, String(detalle || '').slice(0, 200)]
    );
}

/** Aprueba el pago: asigna número, marca lecturas como pagadas. Idempotente. */
async function aprobar(pagoId, { mpPaymentId = null, statusDetail = null, metodoDetalle = null } = {}) {
    return transaccion(async db => {
        const { rows } = await db.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [pagoId]);
        const pago = rows[0];
        if (!pago) throw new ErrorHttp(404, 'Pago no encontrado.');
        if (pago.estado === 'aprobado') return pago;

        const marcadas = await db.query(
            'UPDATE historial_caudal SET pago_id = $1 WHERE cliente_id = $2 AND pago_id IS NULL AND id <= $3',
            [pago.id, pago.cliente_id, pago.lectura_hasta_id || 0]
        );

        // Si otro pago ya cubrió estas lecturas, el dinero entró dos veces: queda para revisión/devolución
        const estadoFinal = marcadas.rowCount === 0 && pago.lectura_hasta_id ? 'revision' : 'aprobado';
        let numero = null;
        if (estadoFinal === 'aprobado') {
            const serie = pago.tipo === 'FACTURA' ? 'F001' : 'B001';
            const seq = pago.tipo === 'FACTURA' ? 'seq_factura' : 'seq_boleta';
            const n = await db.query(`SELECT nextval('${seq}') AS n`);
            numero = `${serie}-${String(n.rows[0].n).padStart(8, '0')}`;
        }
        const upd = await db.query(
            `UPDATE pagos SET estado = $2::varchar, numero = COALESCE($3, numero), mp_payment_id = COALESCE($4, mp_payment_id),
                    mp_status_detail = COALESCE($5, mp_status_detail), pagado_en = now(), actualizado_en = now(),
                    fecha = CASE WHEN $2::varchar = 'aprobado' THEN now() ELSE fecha END
              WHERE id = $1 RETURNING *`,
            [pago.id, estadoFinal, numero, mpPaymentId, statusDetail]
        );
        await evento(db, upd.rows[0], estadoFinal,
            estadoFinal === 'aprobado' ? `Aprobado ${metodoDetalle || ''} ${numero}`.trim() : 'Pago duplicado: requiere devolución');
        return upd.rows[0];
    });
}

async function actualizarEstado(pagoId, estado, { mpPaymentId = null, statusDetail = null } = {}) {
    return transaccion(async db => {
        const { rows } = await db.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [pagoId]);
        const pago = rows[0];
        if (!pago) throw new ErrorHttp(404, 'Pago no encontrado.');
        if (pago.estado === 'aprobado' && estado !== 'reembolsado') return pago; // no retroceder un aprobado
        if (pago.estado === estado && pago.mp_status_detail === statusDetail) return pago;
        if (estado === 'reembolsado') {
            await db.query('UPDATE historial_caudal SET pago_id = NULL WHERE pago_id = $1', [pago.id]);
        }
        const upd = await db.query(
            `UPDATE pagos SET estado = $2, mp_payment_id = COALESCE($3, mp_payment_id), mp_status_detail = $4, actualizado_en = now()
              WHERE id = $1 RETURNING *`,
            [pago.id, estado, mpPaymentId, statusDetail]
        );
        await evento(db, upd.rows[0], estado, statusDetail || '');
        return upd.rows[0];
    });
}

module.exports = { tarifaVigente, cotizar, desglose, crearPendiente, aprobar, actualizarEstado, redondear };
