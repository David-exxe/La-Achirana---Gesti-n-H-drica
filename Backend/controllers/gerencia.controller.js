// =====================================================================
//  Gerencia: resumen del personal y de los regantes, finanzas
//  (ingresos, egresos y costo del agua), capacidad del sistema y simulador.
//  Lectura: gerente y administrador. Registro de movimientos: ambos.
// =====================================================================
const { query } = require('../Config/db');
const { ErrorHttp, entero, limpiar, validarFecha } = require('../utils/validacion');
const turnos = require('../services/turnos.service');
const pagosSrv = require('../services/pagos.service');
const auditoria = require('../services/auditoria.service');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;

const CATEGORIAS = {
    egreso: ['Operación y mantenimiento', 'Personal', 'Energía y combustible', 'Retribución económica (ANA)', 'Infraestructura y obras', 'Administración', 'Otros egresos'],
    ingreso: ['Multas y recargos', 'Aportes y transferencias', 'Venta de servicios', 'Otros ingresos'],
};

// ------------------------------------------------------------------ Resumen
async function resumen(req, res) {
    const personal = await query(`
        SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.ultimo_acceso,
               (u.bloqueado_hasta IS NOT NULL AND u.bloqueado_hasta > now()) AS bloqueado,
               COUNT(a.id) FILTER (WHERE a.creado_en > now() - INTERVAL '7 days')::int AS acciones_7d,
               COUNT(a.id) FILTER (WHERE a.creado_en > now() - INTERVAL '30 days')::int AS acciones_30d,
               COUNT(a.id) FILTER (WHERE a.accion IN ('registrar_caudal','caudal_canal') AND a.creado_en > now() - INTERVAL '30 days')::int AS lecturas_30d,
               COUNT(a.id) FILTER (WHERE a.accion IN ('pago_manual','validar_pago','rechazar_pago') AND a.creado_en > now() - INTERVAL '30 days')::int AS pagos_30d,
               COUNT(a.id) FILTER (WHERE a.accion IN ('generar_turnos','cancelar_turno') AND a.creado_en > now() - INTERVAL '30 days')::int AS turnos_30d,
               COUNT(a.id) FILTER (WHERE a.accion = 'login_fallido' AND a.creado_en > now() - INTERVAL '7 days')::int AS fallidos_7d,
               MAX(a.creado_en) FILTER (WHERE a.accion NOT IN ('login','login_fallido')) AS ultima_accion
          FROM usuarios u
          LEFT JOIN auditoria a ON a.actor_tipo = 'usuario' AND a.actor_id = u.id
         GROUP BY u.id ORDER BY u.rol, u.nombre`);

    const tarifa = await pagosSrv.tarifaVigente();
    const p = await turnos.parametros();
    const fac = await turnos.factores();
    const { rows: clientes } = await query(`
        SELECT c.*, COALESCE(d.m3, 0) AS m3_pend, d.desde AS pend_desde, COALESCE(m.m3, 0) AS m3_mes
          FROM clientes c
          LEFT JOIN (SELECT cliente_id, SUM(COALESCE(volumen_m3, m3_dia)) AS m3, MIN(fecha) AS desde
                       FROM historial_caudal WHERE pago_id IS NULL GROUP BY cliente_id) d ON d.cliente_id = c.id
          LEFT JOIN (SELECT cliente_id, SUM(COALESCE(volumen_m3, m3_dia)) AS m3
                       FROM historial_caudal WHERE fecha >= date_trunc('month', CURRENT_DATE) GROUP BY cliente_id) m ON m.cliente_id = c.id`);

    const grupo = tipo => {
        const l = clientes.filter(c => c.tipo === tipo && c.activo !== false);
        const cupos = l.map(c => turnos.cupoDe(c, p, fac));
        const deudas = l.map(c => Number(c.m3_pend) * Number(tarifa.precio_m3));
        const morosos = l.filter(c => c.pend_desde && (Date.now() - new Date(c.pend_desde)) > 30 * 86400000);
        return {
            cantidad: l.length,
            hectareas: r2(l.reduce((s, c) => s + Number(c.hectareas), 0)),
            cupo_base_m3_dia: r2(cupos.reduce((s, c) => s + c.base, 0)),
            maximo_m3_dia: r2(cupos.reduce((s, c) => s + c.maximo, 0)),
            consumo_mes_m3: r2(l.reduce((s, c) => s + Number(c.m3_mes), 0)),
            deuda: r2(deudas.reduce((s, d) => s + d, 0)),
            morosos: morosos.length,
            con_codigo: l.filter(c => c.pin_hash).length,
            almacenan: l.filter(c => c.almacena).length,
            capacidad_reservorios_m3: r2(l.reduce((s, c) => s + (c.almacena ? Number(c.capacidad_reservorio_m3 || 0) : 0), 0)),
            inactivos: clientes.filter(c => c.tipo === tipo && c.activo === false).length,
        };
    };
    const deudores = clientes.filter(c => c.activo !== false && Number(c.m3_pend) > 0)
        .map(c => ({ id: c.id, nombre: c.nombre, tipo: c.tipo, documento: c.documento, deuda: r2(Number(c.m3_pend) * Number(tarifa.precio_m3)),
            m3: r2(c.m3_pend), dias: c.pend_desde ? Math.floor((Date.now() - new Date(c.pend_desde)) / 86400000) : 0 }))
        .sort((a, b) => b.deuda - a.deuda).slice(0, 8);

    // Indicadores de alineación del equipo (semáforo)
    const hoy = turnos.hoyLima();
    const [canalHoy, turnosHoy, validacion, cuentas, ult] = await Promise.all([
        query("SELECT MAX(fecha) AS ultima, COUNT(*)::int AS n FROM caudal_canal WHERE (fecha AT TIME ZONE 'America/Lima')::date = $1", [hoy]),
        query("SELECT COUNT(*)::int AS n FROM turnos_riego WHERE fecha = $1 AND estado <> 'cancelado'", [hoy]),
        query("SELECT COUNT(*)::int AS n, MAX(EXTRACT(EPOCH FROM (now() - actualizado_en)) / 3600.0) AS horas FROM pagos WHERE estado = 'validacion'"),
        query('SELECT COUNT(*)::int AS n FROM cuentas_cobro WHERE activo'),
        query("SELECT MAX(creado_en) AS f FROM auditoria WHERE accion = 'parametros_riego'"),
    ]);
    const activos = clientes.filter(c => c.activo !== false);
    const sinCodigo = activos.filter(c => !c.pin_hash).length;
    const staffActivo = personal.rows.filter(u => u.activo && u.rol !== 'gerente');
    const ausentes = staffActivo.filter(u => !u.ultimo_acceso || Date.now() - new Date(u.ultimo_acceso) > 7 * 86400000);
    const horasVal = Number(validacion.rows[0].horas || 0);
    const morososTotal = activos.filter(c => c.pend_desde && (Date.now() - new Date(c.pend_desde)) > 30 * 86400000).length;
    const ind = (clave, titulo, estado, detalle, responsable) => ({ clave, titulo, estado, detalle, responsable });
    const indicadores = [
        ind('canal', 'Caudal del canal registrado hoy', canalHoy.rows[0].n ? 'ok' : 'mal',
            canalHoy.rows[0].n ? `${canalHoy.rows[0].n} registro(s) hoy` : 'Nadie registró el caudal del canal hoy', 'Operadores'),
        ind('turnos', 'Turnos de riego programados para hoy', turnosHoy.rows[0].n ? 'ok' : 'mal',
            turnosHoy.rows[0].n ? `${turnosHoy.rows[0].n} turno(s)` : 'No hay turnos programados hoy', 'Operadores'),
        ind('validacion', 'Pagos por validar', !validacion.rows[0].n ? 'ok' : horasVal > 24 ? 'mal' : 'aviso',
            !validacion.rows[0].n ? 'Ninguno pendiente' : `${validacion.rows[0].n} pago(s); el más antiguo espera ${r2(horasVal)} h`, 'Administradores'),
        ind('codigos', 'Regantes con código de acceso', sinCodigo === 0 ? 'ok' : sinCodigo / Math.max(1, activos.length) > 0.3 ? 'mal' : 'aviso',
            `${activos.length - sinCodigo} de ${activos.length} tienen código`, 'Administradores'),
        ind('morosidad', 'Regantes con deuda de más de 30 días', morososTotal === 0 ? 'ok' : morososTotal / Math.max(1, activos.length) > 0.2 ? 'mal' : 'aviso',
            `${morososTotal} regante(s)`, 'Administradores'),
        ind('personal', 'Personal que ingresó en los últimos 7 días', ausentes.length === 0 ? 'ok' : 'aviso',
            ausentes.length ? `Sin ingresar: ${ausentes.map(u => u.nombre).join(', ')}` : `Los ${staffActivo.length} activos ingresaron`, 'Gerencia'),
        ind('cuentas', 'Medios de pago (Yape, Plin, bancos) configurados', cuentas.rows[0].n ? 'ok' : 'mal',
            cuentas.rows[0].n ? `${cuentas.rows[0].n} cuenta(s) activa(s)` : 'Los regantes no pueden pagar a distancia', 'Administradores'),
        ind('seguridad', 'Intentos fallidos de ingreso (7 días)', personal.rows.some(u => u.fallidos_7d >= 5 || u.bloqueado) ? 'aviso' : 'ok',
            `${personal.rows.reduce((s, u) => s + u.fallidos_7d, 0)} intento(s) fallido(s)`, 'Administradores'),
    ];

    res.json({
        personal: personal.rows,
        regantes: { parceleros: grupo('parcelero'), fundos: grupo('empresa') },
        deudores,
        indicadores,
        tarifa_m3: tarifa.precio_m3,
        parametros_actualizados: ult.rows[0].f,
    });
}

// ------------------------------------------------------------------ Finanzas
async function finanzas(req, res) {
    const meses = Math.min(24, Math.max(3, parseInt(req.query.meses, 10) || 12));
    const desde = `date_trunc('month', CURRENT_DATE) - INTERVAL '${meses - 1} months'`;
    const serie = await query(`
        WITH m AS (SELECT to_char(g, 'YYYY-MM') AS mes FROM generate_series(${desde}, date_trunc('month', CURRENT_DATE), INTERVAL '1 month') g),
        ing AS (SELECT to_char(date_trunc('month', COALESCE(pagado_en, fecha) AT TIME ZONE 'America/Lima'), 'YYYY-MM') AS mes, SUM(monto) AS canon, SUM(volumen_m3) AS m3
                  FROM pagos WHERE estado = 'aprobado' GROUP BY 1),
        mov AS (SELECT to_char(fecha, 'YYYY-MM') AS mes, SUM(monto) FILTER (WHERE tipo = 'egreso') AS egresos, SUM(monto) FILTER (WHERE tipo = 'ingreso') AS otros
                  FROM movimientos GROUP BY 1),
        ent AS (SELECT to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes, SUM(COALESCE(volumen_m3, m3_dia)) AS m3 FROM historial_caudal GROUP BY 1),
        cap AS (SELECT to_char(date_trunc('month', fecha AT TIME ZONE 'America/Lima'), 'YYYY-MM') AS mes,
                       SUM(lps * 3.6 * EXTRACT(EPOCH FROM (LEAST(sig, fecha + INTERVAL '31 days') - fecha)) / 3600.0) AS m3
                  FROM (SELECT fecha, lps, LEAD(fecha, 1, now()) OVER (ORDER BY fecha) AS sig FROM caudal_canal) x GROUP BY 1)
        SELECT m.mes, COALESCE(ing.canon, 0) AS canon, COALESCE(mov.otros, 0) AS otros_ingresos, COALESCE(mov.egresos, 0) AS egresos,
               COALESCE(cap.m3, 0) AS captado_m3, COALESCE(ent.m3, 0) AS entregado_m3, COALESCE(ing.m3, 0) AS cobrado_m3
          FROM m LEFT JOIN ing USING (mes) LEFT JOIN mov USING (mes) LEFT JOIN ent USING (mes) LEFT JOIN cap USING (mes)
         ORDER BY m.mes`);
    const filas = serie.rows.map(r => {
        const o = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'mes' ? v : r2(v)]));
        o.ingresos = r2(o.canon + o.otros_ingresos);
        o.resultado = r2(o.ingresos - o.egresos);
        return o;
    });
    const suma = k => r2(filas.reduce((s, f) => s + f[k], 0));
    const tot = {
        canon: suma('canon'), otros_ingresos: suma('otros_ingresos'), ingresos: suma('ingresos'), egresos: suma('egresos'),
        resultado: suma('resultado'), captado_m3: suma('captado_m3'), entregado_m3: suma('entregado_m3'), cobrado_m3: suma('cobrado_m3'),
    };
    const tarifa = await pagosSrv.tarifaVigente();
    const porCobrar = await query(`SELECT COALESCE(SUM(COALESCE(h.volumen_m3, h.m3_dia)), 0) AS m3 FROM historial_caudal h JOIN clientes c ON c.id = h.cliente_id WHERE h.pago_id IS NULL AND c.activo`);
    const facturable = r2(tot.entregado_m3 * Number(tarifa.precio_m3));
    const indicadores = {
        tarifa_m3: Number(tarifa.precio_m3),
        costo_m3: tot.entregado_m3 > 0 && tot.egresos > 0 ? Math.round((tot.egresos / tot.entregado_m3) * 10000) / 10000 : null,
        ingreso_m3: tot.cobrado_m3 > 0 ? Math.round((tot.canon / tot.cobrado_m3) * 10000) / 10000 : null,
        margen_pct: tot.ingresos > 0 && tot.egresos > 0 ? r2((tot.resultado / tot.ingresos) * 100) : null,
        eficiencia_entrega_pct: tot.captado_m3 > 0 ? r2((tot.entregado_m3 / tot.captado_m3) * 100) : null,
        eficiencia_cobro_pct: facturable > 0 ? r2((tot.canon / facturable) * 100) : null,
        por_cobrar: r2(Number(porCobrar.rows[0].m3) * Number(tarifa.precio_m3)),
    };
    const porCategoria = await query(`
        SELECT tipo, categoria, SUM(monto) AS total FROM movimientos WHERE fecha >= (${desde})::date GROUP BY tipo, categoria ORDER BY total DESC`);
    const porMedio = await query(`
        SELECT COALESCE(NULLIF(entidad, ''), metodo) AS medio, metodo, COUNT(*)::int AS n, SUM(monto) AS total
          FROM pagos WHERE estado = 'aprobado' AND COALESCE(pagado_en, fecha) >= (${desde}) GROUP BY 1, 2 ORDER BY total DESC`);
    res.json({
        meses, serie: filas, totales: tot, indicadores,
        por_categoria: porCategoria.rows.map(r => ({ ...r, total: r2(r.total) })),
        por_medio: porMedio.rows.map(r => ({ ...r, total: r2(r.total) })),
        categorias: CATEGORIAS,
    });
}

async function listarMovimientos(req, res) {
    const { rows } = await query(
        `SELECT m.id, TO_CHAR(m.fecha, 'YYYY-MM-DD') AS fecha, m.tipo, m.categoria, m.descripcion, m.monto, m.documento, u.nombre AS registrado_por
           FROM movimientos m LEFT JOIN usuarios u ON u.id = m.registrado_por ORDER BY m.fecha DESC, m.id DESC LIMIT 300`);
    res.json({ movimientos: rows, categorias: CATEGORIAS });
}

async function crearMovimiento(req, res) {
    const b = req.body || {};
    const tipo = String(b.tipo || '');
    const categoria = limpiar(b.categoria || '');
    const descripcion = limpiar(b.descripcion || '');
    const documento = limpiar(b.documento || '');
    const monto = Number(b.monto);
    const errores = {};
    let fecha = null;
    try { fecha = validarFecha(b.fecha); } catch { errores.fecha = 'Fecha no válida.'; }
    if (!fecha && !errores.fecha) errores.fecha = 'Indica la fecha.';
    else if (fecha && fecha > turnos.hoyLima()) errores.fecha = 'La fecha no puede ser futura.';
    if (!['ingreso', 'egreso'].includes(tipo)) errores.tipo = 'Elige ingreso o egreso.';
    else if (!CATEGORIAS[tipo].includes(categoria)) errores.categoria = 'Elige una categoría.';
    if (descripcion.length < 3 || descripcion.length > 200) errores.descripcion = 'Entre 3 y 200 caracteres.';
    if (!Number.isFinite(monto) || monto <= 0 || monto >= 1e8) errores.monto = 'Monto mayor que 0.';
    else if (Math.round(monto * 100) / 100 !== monto) errores.monto = 'Máximo 2 decimales.';
    if (documento.length > 40) errores.documento = 'Máximo 40 caracteres.';
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    const { rows } = await query(
        `INSERT INTO movimientos (fecha, tipo, categoria, descripcion, monto, documento, registrado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [fecha, tipo, categoria, descripcion, monto, documento || null, req.sesion.id]);
    await auditoria.registrar(req, 'crear', 'movimientos', rows[0].id, { tipo, categoria, monto });
    res.status(201).json({ ok: true, id: rows[0].id });
}

async function eliminarMovimiento(req, res) {
    const id = entero(req.params.id, 'movimiento');
    const r = await query('DELETE FROM movimientos WHERE id = $1 RETURNING tipo, monto', [id]);
    if (!r.rowCount) throw new ErrorHttp(404, 'Movimiento no encontrado.');
    await auditoria.registrar(req, 'eliminar', 'movimientos', id, r.rows[0]);
    res.json({ ok: true });
}

// ------------------------------------------------------------------ Capacidad y simulación
async function datosModelo() {
    const p = await turnos.parametros();
    const fac = await turnos.factores();
    const { rows } = await query('SELECT * FROM clientes WHERE activo ORDER BY id');
    const regantes = rows.map(c => {
        const cu = turnos.cupoDe(c, p, fac);
        return {
            id: c.id, nombre: c.nombre, tipo: c.tipo, fundo: turnos.esFundo(c), hectareas: Number(c.hectareas),
            base: cu.base, basePend: cu.base, adicTope: c.almacena && c.capacidad_reservorio_m3 ? Math.min(cu.adicional, Number(c.capacidad_reservorio_m3)) : cu.adicional, maximo: cu.maximo, entregadoHoy: 0, topePct: cu.tope_pct,
            almacena: Boolean(c.almacena), reservorio: c.almacena ? Number(c.capacidad_reservorio_m3 || 0) : 0,
        };
    });
    return { p, regantes };
}

async function capacidad(req, res) {
    const { p, regantes } = await datosModelo();
    const vig = await turnos.caudalVigente();
    const qmax = Number(p.canal_capacidad_lps);
    const base = regantes.reduce((s, r) => s + r.base, 0);
    const maximo = regantes.reduce((s, r) => s + r.maximo, 0);
    const ha = regantes.reduce((s, r) => s + r.hectareas, 0);
    const resFundos = regantes.reduce((s, r) => s + r.reservorio, 0);
    const resJunta = Number(p.reservorio_junta_m3);
    const capDia = qmax * 86.4;
    const qActual = vig ? Number(vig.lps) : null;
    const dotacionMedia = ha > 0 ? base / ha : Number(p.lamina_mm_dia) * 10;
    const mensual = await query(`
        SELECT to_char(d, 'YYYY-MM') AS mes,
               COALESCE((SELECT SUM(COALESCE(volumen_m3, m3_dia)) FROM historial_caudal WHERE date_trunc('month', fecha) = d), 0) AS entregado
          FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months', date_trunc('month', CURRENT_DATE), INTERVAL '1 month') d`);
    res.json({
        parametros: {
            canal_capacidad_lps: qmax, reservorio_junta_m3: resJunta, dotacion_m3_ha: r2(Number(p.lamina_mm_dia) * 10),
            adicional_pct_parcelero: Number(p.adicional_pct_parcelero), adicional_pct_fundo: Number(p.adicional_pct_fundo),
            tope_pct_parcelero: Number(p.tope_pct_parcelero), tope_pct_fundo: Number(p.tope_pct_fundo), prioridad_adicional: p.prioridad_adicional,
        },
        conduccion: { m3_hora: r2(qmax * 3.6), m3_dia: r2(capDia), m3_mes: r2(capDia * 30), m3_anio: r2(capDia * 365) },
        almacenamiento: { fundos_m3: r2(resFundos), junta_m3: r2(resJunta), total_m3: r2(resFundos + resJunta),
            dias_autonomia: base > 0 ? r2((resFundos + resJunta) / base) : null },
        demanda: { hectareas: r2(ha), base_m3_dia: r2(base), maximo_m3_dia: r2(maximo), base_lps: r2(base / 86.4), maximo_lps: r2(maximo / 86.4),
            uso_canal_base_pct: r2((base / capDia) * 100), hectareas_atendibles: r2(capDia / dotacionMedia) },
        actual: qActual === null ? null : { lps: qActual, m3_dia: r2(qActual * 86.4), uso_pct: r2((qActual / qmax) * 100), cubre_base_pct: base > 0 ? r2(Math.min(100, (qActual * 86.4 / base) * 100)) : null },
        entregado_mensual: mensual.rows.map(r => ({ mes: r.mes, m3: r2(r.entregado) })),
    });
}

/** Simula el reparto de un día con un caudal dado, sin guardar nada. */
async function simular(req, res) {
    const lps = Number(req.body?.lps);
    const horas = req.body?.horas === undefined ? 24 : Number(req.body.horas);
    if (!Number.isFinite(lps) || lps < 0 || lps > 50000) throw new ErrorHttp(400, 'Caudal entre 0 y 50 000 L/s.', { lps: 'Entre 0 y 50 000.' });
    if (!Number.isFinite(horas) || horas <= 0 || horas > 24) throw new ErrorHttp(400, 'Horas entre 1 y 24.', { horas: 'Entre 1 y 24.' });
    const { p, regantes } = await datosModelo();
    const V = lps * 3.6 * horas;
    const r = turnos.asignar(V, regantes, p, V);
    const det = regantes.map(g => {
        const b = r.base.get(g.id) || 0, a = r.adic.get(g.id) || 0;
        return { id: g.id, nombre: g.nombre, tipo: g.tipo, hectareas: g.hectareas, cupo_base: r2(g.base), maximo: r2(g.maximo),
            base: r2(b), adicional: r2(a), total: r2(b + a), pct_canal: V > 0 ? r2(((b + a) / V) * 100) : 0,
            cubre_pct: g.base > 0 ? r2((b / g.base) * 100) : 100, limitado: r.limitados.includes(g.id) };
    }).sort((x, y) => y.total - x.total);
    const tot = k => r2(det.reduce((s, d) => s + d[k], 0));
    res.json({
        lps, horas, volumen_m3: r2(V), uso_canal_pct: r2((lps / Number(p.canal_capacidad_lps)) * 100),
        base_m3: tot('base'), adicional_m3: tot('adicional'), sin_asignar_m3: r2(r.sinAsignar),
        cobertura_pct: r2(r.cobertura * 100), limitados: r.limitados.length,
        parceleros_m3: r2(det.filter(d => d.tipo !== 'empresa').reduce((s, d) => s + d.total, 0)),
        fundos_m3: r2(det.filter(d => d.tipo === 'empresa').reduce((s, d) => s + d.total, 0)),
        detalle: det,
    });
}

module.exports = { resumen, finanzas, listarMovimientos, crearMovimiento, eliminarMovimiento, capacidad, simular };
