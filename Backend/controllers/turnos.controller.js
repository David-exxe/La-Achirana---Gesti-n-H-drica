const { query, transaccion } = require('../Config/db');
const { ErrorHttp, entero, limpiar, validarFecha } = require('../utils/validacion');
const turnos = require('../services/turnos.service');
const auditoria = require('../services/auditoria.service');

const r2 = n => Math.round(n * 100) / 100;

/** Registra el caudal del canal y (por defecto) recalcula los turnos de hoy desde ahora. */
async function registrarCaudalCanal(req, res) {
    const lps = Number(req.body?.lps);
    const nota = limpiar(req.body?.nota || '');
    const errores = {};
    if (!Number.isFinite(lps) || lps < 0) errores.lps = 'Ingresa el caudal en L/s (0 si el canal está seco).';
    else if (lps > 20000) errores.lps = 'Máximo 20 000 L/s.';
    else if (Math.round(lps * 100) / 100 !== lps) errores.lps = 'Máximo 2 decimales.';
    if (nota.length > 200) errores.nota = 'Máximo 200 caracteres.';
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);

    const { rows } = await query(
        `INSERT INTO caudal_canal (lps, m3_hora, m3_dia, nota, registrado_por) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [lps, r2(lps * 3.6), r2(lps * 86.4), nota || null, req.sesion.id]
    );
    await auditoria.registrar(req, 'caudal_canal', 'caudal_canal', rows[0].id, { lps });

    let plan = null;
    if (req.body?.recalcular !== false) {
        plan = await turnos.planificar({ lps, caudalId: rows[0].id, desde: new Date() });
        // Si mañana ya estaba programado, también se actualiza con el nuevo caudal
        const manana = new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
        const hay = await query("SELECT 1 FROM turnos_riego WHERE fecha = $1 AND estado = 'programado' LIMIT 1", [manana]);
        if (hay.rows.length) {
            plan.manana = await turnos.planificar({ fecha: manana, lps, caudalId: rows[0].id, desde: new Date(`${manana}T00:00:00-05:00`) });
        }
    }
    res.status(201).json({ lectura: rows[0], plan });
}

async function listarCaudalCanal(req, res) {
    const fecha = validarFecha(req.query.fecha) || turnos.hoyLima();
    const { rows } = await query(
        `SELECT c.id, c.fecha, c.lps, c.m3_hora, c.m3_dia, c.nota, u.nombre AS registrado_por
           FROM caudal_canal c LEFT JOIN usuarios u ON u.id = c.registrado_por
          WHERE (c.fecha AT TIME ZONE 'America/Lima')::date = $1
          ORDER BY c.fecha DESC`,
        [fecha]
    );
    const vigente = await turnos.caudalVigente();
    res.json({ lecturas: rows, vigente });
}

/** Genera (o regenera) los turnos de un día. Hoy: desde ahora. Mañana: desde las 00:00. */
async function generar(req, res) {
    const fecha = validarFecha(req.body?.fecha) || turnos.hoyLima();
    const hoy = turnos.hoyLima();
    if (fecha < hoy) throw new ErrorHttp(400, 'No se pueden programar días pasados.');
    const desde = fecha === hoy ? new Date() : new Date(`${fecha}T00:00:00-05:00`);
    const plan = await turnos.planificar({ fecha, desde });
    await auditoria.registrar(req, 'generar_turnos', 'turnos_riego', null, { fecha, turnos: plan.turnos });
    res.json(plan);
}

async function listar(req, res) {
    const fecha = validarFecha(req.query.fecha) || turnos.hoyLima();
    const clienteId = req.sesion.tipo === 'cliente' ? req.sesion.id : (req.query.cliente_id ? entero(req.query.cliente_id, 'cliente') : null);
    // Antes de mostrar, se registran los turnos que ya terminaron
    await transaccion(db => turnos.cumplirTurnosVencidos(db));
    const lista = await turnos.listar({ fecha, clienteId });
    const vigente = await turnos.caudalVigente();
    const p = await turnos.parametros();
    const total = lista.filter(t => t.estado !== 'cancelado');
    res.json({
        fecha,
        caudal_vigente: vigente ? { lps: vigente.lps, fecha: vigente.fecha } : null,
        parametros: {
            lamina_mm_dia: p.lamina_mm_dia, dotacion_m3_ha: r2(Number(p.lamina_mm_dia) * 10), dias_almacenamiento: p.dias_almacenamiento,
            adicional_pct_parcelero: p.adicional_pct_parcelero, adicional_pct_fundo: p.adicional_pct_fundo,
            tope_pct_parcelero: p.tope_pct_parcelero, tope_pct_fundo: p.tope_pct_fundo, prioridad_adicional: p.prioridad_adicional,
        },
        resumen: {
            turnos: total.length,
            riego_m3: r2(total.filter(t => t.tipo === 'riego').reduce((s, t) => s + Number(t.volumen_m3), 0)),
            almacenamiento_m3: r2(total.filter(t => t.tipo !== 'riego').reduce((s, t) => s + Number(t.volumen_m3), 0)),
            adicional_m3: r2(total.filter(t => t.tipo !== 'riego').reduce((s, t) => s + Number(t.volumen_m3), 0)),
            cumplidos: total.filter(t => t.estado === 'cumplido').length,
        },
        turnos: lista,
    });
}

/** El regante no tomó el agua: se cancela (no se cobra). Si estaba en curso, se cobra solo lo entregado. */
async function cancelar(req, res) {
    const id = entero(req.params.id, 'turno');
    const motivo = limpiar(req.body?.motivo || '');
    const r = await transaccion(async db => {
        const { rows } = await db.query('SELECT * FROM turnos_riego WHERE id = $1 FOR UPDATE', [id]);
        const t = rows[0];
        if (!t) throw new ErrorHttp(404, 'Turno no encontrado.');
        if (t.estado !== 'programado') throw new ErrorHttp(409, 'Solo se pueden cancelar turnos programados.');
        const ahora = new Date();
        if (new Date(t.inicio) < ahora && new Date(t.fin) > ahora) {
            const vol = r2(Number(t.lps) * 3.6 * ((ahora - new Date(t.inicio)) / 3600000));
            await db.query("UPDATE turnos_riego SET fin = $2, volumen_m3 = $3, estado = 'programado' WHERE id = $1", [id, ahora, vol]);
            await turnos.cumplirTurnosVencidos(db, ahora);
            return { parcial: true, volumen_m3: vol };
        }
        await db.query("UPDATE turnos_riego SET estado = 'cancelado' WHERE id = $1", [id]);
        return { parcial: false };
    });
    await auditoria.registrar(req, 'cancelar_turno', 'turnos_riego', id, { motivo, ...r });
    res.json({ ok: true, ...r });
}

async function demandas(req, res) {
    res.json(await turnos.demandas());
}

const CAMPOS_RIEGO = {
    adicional_pct_parcelero: [0, 100, 'Entre 0 y 100 %.'],
    adicional_pct_fundo: [0, 100, 'Entre 0 y 100 %.'],
    tope_pct_parcelero: [1, 100, 'Entre 1 y 100 %.'],
    tope_pct_fundo: [1, 100, 'Entre 1 y 100 %.'],
    canal_capacidad_lps: [1, 50000, 'Entre 1 y 50 000 L/s.'],
    reservorio_junta_m3: [0, 1e9, 'Entre 0 y 1 000 000 000 m³.'],
};

async function obtenerParametros(req, res) {
    const p = await turnos.parametros();
    const fac = await turnos.factores();
    const salida = { lamina_mm_dia: p.lamina_mm_dia, dotacion_m3_ha: r2(Number(p.lamina_mm_dia) * 10), dias_almacenamiento: p.dias_almacenamiento, prioridad_adicional: p.prioridad_adicional };
    for (const k of Object.keys(CAMPOS_RIEGO)) salida[k] = p[k];
    salida.factores = [...fac.entries()].map(([cultivo, factor]) => ({ cultivo, factor })).sort((a, b) => a.cultivo.localeCompare(b.cultivo));
    res.json(salida);
}

async function guardarParametros(req, res) {
    const b = req.body || {};
    // Se acepta la dotación en m³/ha·día (lámina = dotación / 10) o la lámina directa
    const lamina = b.dotacion_m3_ha !== undefined && b.dotacion_m3_ha !== '' ? Number(b.dotacion_m3_ha) / 10 : Number(b.lamina_mm_dia);
    const dias = Number(b.dias_almacenamiento);
    const prioridad = String(b.prioridad_adicional || 'parcelero');
    const factores = Array.isArray(b.factores) ? b.factores : [];
    const errores = {};
    if (!Number.isFinite(lamina) || lamina <= 0 || lamina > 30) errores.dotacion_m3_ha = 'Entre 1 y 300 m³ por hectárea al día.';
    else if (Math.round(lamina * 1000) / 1000 !== lamina) errores.dotacion_m3_ha = 'Máximo 2 decimales.';
    if (!Number.isInteger(dias) || dias < 1 || dias > 30) errores.dias_almacenamiento = 'Número entero entre 1 y 30.';
    if (!['parcelero', 'fundo', 'igual'].includes(prioridad)) errores.prioridad_adicional = 'Elige un orden de atención.';
    const valores = {};
    for (const [k, [min, max, msg]] of Object.entries(CAMPOS_RIEGO)) {
        if (b[k] === undefined || b[k] === '') continue;
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < min || v > max || Math.round(v * 100) / 100 !== v) errores[k] = msg;
        else valores[k] = v;
    }
    const limpios = [];
    for (const f of factores.slice(0, 200)) {
        const cultivo = limpiar(f?.cultivo || '').toLowerCase();
        const factor = Number(f?.factor);
        if (!cultivo || cultivo.length > 100) continue;
        if (!Number.isFinite(factor) || factor < 0.1 || factor > 3) { errores[`factor_${cultivo}`] = `Factor de "${cultivo}" entre 0.1 y 3.`; continue; }
        limpios.push([cultivo, Math.round(factor * 100) / 100]);
    }
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);

    await transaccion(async db => {
        const sets = ['lamina_mm_dia = $1', 'dias_almacenamiento = $2', 'prioridad_adicional = $3', 'actualizado_en = now()', 'actualizado_por = $4'];
        const params = [Math.round(lamina * 100) / 100, dias, prioridad, req.sesion.id];
        for (const [k, v] of Object.entries(valores)) { params.push(v); sets.push(`${k} = $${params.length}`); }
        await db.query(`UPDATE parametros_riego SET ${sets.join(', ')} WHERE id = 1`, params);
        for (const [cultivo, factor] of limpios) {
            await db.query(
                'INSERT INTO factores_cultivo (cultivo, factor) VALUES ($1,$2) ON CONFLICT (cultivo) DO UPDATE SET factor = EXCLUDED.factor',
                [cultivo, factor]
            );
        }
    });
    await auditoria.registrar(req, 'parametros_riego', 'parametros_riego', 1, { lamina, dias, prioridad, ...valores, factores: limpios.length });
    res.json({ ok: true });
}

module.exports = {
    registrarCaudalCanal, listarCaudalCanal, generar, listar, cancelar, demandas, obtenerParametros, guardarParametros,
};
