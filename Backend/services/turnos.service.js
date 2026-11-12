// =====================================================================
//  Reparto del agua del canal en turnos de riego (24 horas)
//
//  Entrada: el caudal del canal en L/s, registrado por el personal.
//  Reglas (definidas por la Junta):
//   1. CUPO BASE de cada regante = hectáreas × dotación (m³/ha·día) × factor del cultivo
//      (dotación = lámina general en mm × 10, porque 1 mm sobre 1 ha = 10 m³)
//   2. Si el agua del día alcanza, cada uno recibe su cupo base. Si no alcanza, se reparte
//      en proporción (todos reciben el mismo % de su cupo).
//   3. LÍMITE DE PARTICIPACIÓN: ningún regante puede llevarse más del X % del agua del día
//      (un % para parceleros y otro para fundos). Lo que no puede tomar pasa a los demás.
//   4. ADICIONAL (compra o almacenamiento): si sobra agua, cada regante puede recibir hasta
//      un % extra de su cupo base, en el ORDEN DE ATENCIÓN configurado (por defecto primero
//      parceleros, luego fundos). Los fundos que almacenan tampoco pasan la capacidad de su
//      reservorio en la ventana de días configurada.
//   5. Lo que nadie puede recibir queda como "sin asignar".
//   6. Cada turno usa todo el caudal del canal: duración = volumen / (L/s × 3.6) horas.
//   7. El orden de riego rota cada día para que nadie riegue siempre de noche.
//   8. Al cumplirse un turno, su volumen se registra como consumo y se cobra.
//   9. Si cambia el caudal, se recalculan los turnos pendientes desde ese momento.
// =====================================================================
const { query, transaccion } = require('../Config/db');
const { ErrorHttp } = require('../utils/validacion');

const H = 3600 * 1000;
const r2 = n => Math.round(n * 100) / 100;
const inicioDia = fecha => new Date(`${fecha}T00:00:00-05:00`);
const hoyLima = () => new Date(Date.now() - 5 * H).toISOString().slice(0, 10);
const normalizarCultivo = c => String(c || '').trim().toLowerCase();

async function parametros(db = { query }) {
    const { rows } = await db.query('SELECT * FROM parametros_riego WHERE id = 1');
    return rows[0] || { lamina_mm_dia: 7, dias_almacenamiento: 7, turno_minimo_min: 5 };
}

const esFundo = c => c.tipo === 'empresa';
const pctAdicional = (c, p) => Number(esFundo(c) ? p.adicional_pct_fundo : p.adicional_pct_parcelero) || 0;
const pctTope = (c, p) => Number(esFundo(c) ? p.tope_pct_fundo : p.tope_pct_parcelero) || 100;

/** Cupo de un regante: base diaria, adicional permitido y máximo. */
function cupoDe(c, p, fac) {
    const factor = fac.get(normalizarCultivo(c.cultivo)) ?? 1;
    const dotacion = Number(p.lamina_mm_dia) * 10; // m³ por hectárea por día
    const base = Number(c.hectareas) * dotacion * factor;
    const adicional = base * pctAdicional(c, p) / 100;
    return { factor, dotacion, base, adicional, maximo: base + adicional, tope_pct: pctTope(c, p), adicional_pct: pctAdicional(c, p) };
}

/**
 * Asignación pura (no toca la BD). La usan el reparto real y el simulador gerencial.
 * filas: [{ id, fundo, base, basePend, adicTope, entregadoHoy }]
 * V: volumen disponible desde ahora. Vref: volumen total del día (para el límite de participación).
 */
function asignar(V, filas, p, Vref = V) {
    const capRest = f => Math.max(0, (f.topePct / 100) * Vref - f.entregadoHoy);
    const suma = m => [...m.values()].reduce((s, v) => s + v, 0);
    // Fase 1: cupo base respetando el límite de participación (protege a los demás)
    const base = repartirConTope(V, filas.map(f => ({ id: f.id, peso: f.basePend, tope: Math.min(f.basePend, capRest(f)) })));
    let resto = V - suma(base);
    // Fase 2: si todos los demás ya tienen su cupo y sobra agua, se completa el cupo base de los limitados
    if (resto > 0.01) {
        const extra = repartirConTope(resto, filas.map(f => ({ id: f.id, peso: f.basePend, tope: f.basePend - base.get(f.id) })));
        for (const [id, v] of extra) { base.set(id, base.get(id) + v); resto -= v; }
    }
    const totalBasePend = filas.reduce((s, f) => s + f.basePend, 0);
    // Fase 3: adicional (compra/almacenamiento) en el orden de atención, con límite de participación
    const adic = new Map(filas.map(f => [f.id, 0]));
    const grupos = p.prioridad_adicional === 'fundo' ? [filas.filter(f => f.fundo), filas.filter(f => !f.fundo)]
        : p.prioridad_adicional === 'igual' ? [filas] : [filas.filter(f => !f.fundo), filas.filter(f => f.fundo)];
    for (const conLimite of [true, false]) {
        // Fase 4 (conLimite = false): el agua que nadie más puede recibir completa el adicional, sin pasar el máximo
        for (const g of grupos) {
            if (resto <= 0.01) break;
            const a = repartirConTope(resto, g.map(f => {
                const libre = f.adicTope - adic.get(f.id);
                return { id: f.id, peso: f.base, tope: Math.max(0, conLimite ? Math.min(libre, capRest(f) - base.get(f.id) - adic.get(f.id)) : libre) };
            }));
            for (const [id, v] of a) { adic.set(id, adic.get(id) + v); resto -= v; }
        }
    }
    return {
        base, adic,
        sinAsignar: Math.max(0, resto),
        cobertura: totalBasePend > 0 ? Math.min(1, suma(base) / totalBasePend) : 1,
        limitados: filas.filter(f => capRest(f) + 0.01 < f.basePend).map(f => f.id),
    };
}

async function factores(db = { query }) {
    // Asegura que cada cultivo registrado tenga su fila (factor 1.00 por defecto)
    await db.query(
        `INSERT INTO factores_cultivo (cultivo)
         SELECT DISTINCT LOWER(TRIM(cultivo)) FROM clientes WHERE cultivo IS NOT NULL AND TRIM(cultivo) <> ''
         ON CONFLICT (cultivo) DO NOTHING`
    );
    const { rows } = await db.query('SELECT cultivo, factor FROM factores_cultivo');
    return new Map(rows.map(r => [r.cultivo, Number(r.factor)]));
}

async function caudalVigente(db = { query }) {
    const { rows } = await db.query('SELECT * FROM caudal_canal ORDER BY fecha DESC, id DESC LIMIT 1');
    return rows[0] || null;
}

/** Registra en historial_caudal (y por lo tanto en la deuda) los turnos ya terminados. */
async function cumplirTurnosVencidos(db, hasta = new Date()) {
    const { rows } = await db.query(
        `UPDATE turnos_riego SET estado = 'cumplido'
          WHERE estado = 'programado' AND fin <= $1
          RETURNING *`,
        [hasta]
    );
    for (const t of rows) await registrarConsumo(db, t);
    return rows.length;
}

async function registrarConsumo(db, t) {
    const horas = (new Date(t.fin) - new Date(t.inicio)) / H;
    const lps = Number(t.lps);
    await db.query(
        `INSERT INTO historial_caudal (cliente_id, fecha, lps, m3_hora, m3_dia, volumen_m3, horas, estado, turno_id)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'America/Lima'), $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (turno_id) WHERE turno_id IS NOT NULL DO NOTHING`,
        [t.cliente_id, t.fin, lps, r2(lps * 3.6), r2(lps * 86.4), r2(Number(t.volumen_m3)), r2(horas),
         t.tipo === 'almacenamiento' ? 'Almacenamiento' : t.tipo === 'adicional' ? 'Adicional' : 'Turno de riego', t.id]
    );
}

/** Reparte "volumen" entre candidatos según su peso, sin pasar el tope de cada uno (llenado por niveles). */
function repartirConTope(volumen, candidatos) {
    const asignado = new Map(candidatos.map(c => [c.id, 0]));
    let restante = volumen;
    let activos = candidatos.filter(c => c.tope > 0.01 && c.peso > 0);
    while (restante > 0.01 && activos.length) {
        const sumaPesos = activos.reduce((s, c) => s + c.peso, 0);
        let usado = 0;
        const siguientes = [];
        for (const c of activos) {
            const parte = (restante * c.peso) / sumaPesos;
            const libre = c.tope - asignado.get(c.id);
            const dar = Math.min(parte, libre);
            asignado.set(c.id, asignado.get(c.id) + dar);
            usado += dar;
            if (libre - dar > 0.01) siguientes.push(c);
        }
        restante -= usado;
        if (siguientes.length === activos.length) break; // nadie llegó a su tope: ya se repartió todo
        activos = siguientes;
    }
    return asignado;
}

/**
 * Calcula y guarda los turnos de "fecha" desde el instante "desde" con el caudal "lps".
 * Conserva los turnos ya cumplidos; corta el turno en curso; reemplaza los pendientes.
 */
async function planificar({ fecha = hoyLima(), desde = new Date(), lps = null, caudalId = null } = {}) {
    return transaccion(async db => {
        // Evita dos planificaciones simultáneas
        await db.query('SELECT pg_advisory_xact_lock(784512)');

        const ini = inicioDia(fecha);
        const finDia = new Date(ini.getTime() + 24 * H);
        let T = new Date(Math.max(new Date(desde).getTime(), ini.getTime()));
        if (T >= finDia) throw new ErrorHttp(400, 'Ese día ya terminó; no se pueden programar turnos.');

        if (lps === null) {
            const c = await caudalVigente(db);
            if (!c) throw new ErrorHttp(400, 'Primero registra el caudal del canal (L/s).');
            lps = Number(c.lps); caudalId = c.id;
        }

        // 1) Cerrar lo que ya terminó (nunca turnos futuros) y cortar el turno en curso
        await cumplirTurnosVencidos(db, new Date(Math.min(T.getTime(), Date.now())));
        const enCurso = await db.query(
            "SELECT * FROM turnos_riego WHERE fecha = $1 AND estado = 'programado' AND inicio < $2 AND fin > $2 FOR UPDATE",
            [fecha, T]
        );
        for (const t of enCurso.rows) {
            const vol = r2(Number(t.lps) * 3.6 * ((T - new Date(t.inicio)) / H));
            if (vol < 1) { await db.query('DELETE FROM turnos_riego WHERE id = $1', [t.id]); continue; } // recién empezado: se reprograma
            const upd = await db.query(
                "UPDATE turnos_riego SET fin = $2, volumen_m3 = $3, estado = 'cumplido' WHERE id = $1 RETURNING *",
                [t.id, T, vol]
            );
            await registrarConsumo(db, upd.rows[0]);
        }
        // 2) Borrar los pendientes (se recalculan)
        await db.query("DELETE FROM turnos_riego WHERE fecha = $1 AND estado = 'programado'", [fecha]);

        const p = await parametros(db);
        const fac = await factores(db);
        const dias = Number(p.dias_almacenamiento);

        const { rows: clientes } = await db.query('SELECT * FROM clientes WHERE activo ORDER BY id');
        const entregado = await db.query(
            `SELECT cliente_id, tipo, SUM(volumen_m3) AS vol FROM turnos_riego
              WHERE fecha = $1 AND estado = 'cumplido' GROUP BY cliente_id, tipo`,
            [fecha]
        );
        const riegoHoy = new Map(), almHoy = new Map();
        entregado.rows.forEach(r => { const m = r.tipo === 'riego' ? riegoHoy : almHoy; m.set(r.cliente_id, (m.get(r.cliente_id) || 0) + Number(r.vol)); });
        const almSemana = await db.query(
            `SELECT cliente_id, SUM(volumen_m3) AS vol FROM turnos_riego
              WHERE tipo IN ('almacenamiento','adicional') AND estado <> 'cancelado' AND fecha > $1::date - $2::int AND fecha < $1::date
              GROUP BY cliente_id`,
            [fecha, dias]
        );
        const almPrevio = new Map(almSemana.rows.map(r => [r.cliente_id, Number(r.vol)]));

        const horasRestantes = (finDia - T) / H;
        const volumenDisponible = lps > 0 ? lps * 3.6 * horasRestantes : 0;
        const entregadoHoyTotal = [...riegoHoy.values(), ...almHoy.values()].reduce((x, v) => x + v, 0);

        // 3) Cupo de cada regante y lo que le falta hoy
        const filas = clientes.map(c => {
            const cu = cupoDe(c, p, fac);
            const riegoYa = riegoHoy.get(c.id) || 0, adicYa = almHoy.get(c.id) || 0;
            let adicTope = Math.max(0, cu.adicional - adicYa);
            if (c.almacena && c.capacidad_reservorio_m3) {
                adicTope = Math.min(adicTope, Math.max(0, Number(c.capacidad_reservorio_m3) - (almPrevio.get(c.id) || 0) - adicYa));
            }
            return {
                c, id: c.id, fundo: esFundo(c), base: cu.base, demanda: cu.base,
                basePend: Math.max(0, cu.base - riegoYa), adicTope, entregadoHoy: riegoYa + adicYa, topePct: cu.tope_pct,
            };
        });
        const totalPendiente = filas.reduce((x, f) => x + f.basePend, 0);
        const reparto = asignar(volumenDisponible, filas, p, volumenDisponible + entregadoHoyTotal);
        const riego = reparto.base, almacen = reparto.adic, cobertura = reparto.cobertura;

        // 4) Orden rotativo diario
        const n = filas.length;
        const diaDelAnio = Math.floor((ini - new Date(`${fecha.slice(0, 4)}-01-01T00:00:00-05:00`)) / (24 * H));
        const rot = n ? diaDelAnio % n : 0;
        const ordenados = [...filas.slice(rot), ...filas.slice(0, rot)];

        const nuevos = [];
        let cursor = T.getTime();
        let orden = 0;
        const agregar = async (f, tipo, vol) => {
            if (vol < 1 || lps <= 0) return; // menos de 1 m³ no amerita turno
            const dur = (vol / (lps * 3.6)) * H;
            const inicio = new Date(cursor);
            const fin = new Date(Math.min(cursor + dur, finDia.getTime()));
            if (fin - inicio < 30 * 1000) return;
            const volReal = r2(lps * 3.6 * ((fin - inicio) / H));
            const { rows } = await db.query(
                `INSERT INTO turnos_riego (fecha, cliente_id, tipo, orden, inicio, fin, lps, volumen_m3, caudal_canal_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
                [fecha, f.c.id, tipo, ++orden, inicio, fin, lps, volReal, caudalId]
            );
            nuevos.push(rows[0]);
            cursor = fin.getTime();
        };
        for (const f of ordenados) await agregar(f, 'riego', riego.get(f.c.id) || 0);
        // El adicional se atiende en el orden de prioridad configurado
        const prio = p.prioridad_adicional === 'fundo' ? f => (f.fundo ? 0 : 1) : p.prioridad_adicional === 'igual' ? () => 0 : f => (f.fundo ? 1 : 0);
        for (const f of [...ordenados].sort((x, y) => prio(x) - prio(y))) {
            await agregar(f, f.c.almacena ? 'almacenamiento' : 'adicional', almacen.get(f.c.id) || 0);
        }

        const usado = nuevos.reduce((s, t) => s + Number(t.volumen_m3), 0);
        return {
            fecha, desde: T.toISOString(), lps,
            volumen_disponible: r2(volumenDisponible),
            demanda_pendiente: r2(totalPendiente),
            cobertura_pct: Math.round(Math.min(1, cobertura) * 1000) / 10,
            programado_m3: r2(usado),
            sobrante_m3: r2(Math.max(0, volumenDisponible - usado)),
            sin_asignar_m3: r2(reparto.sinAsignar),
            limitados: reparto.limitados.length,
            turnos: nuevos.length,
        };
    });
}

/** Resumen y lista de turnos de un día (para personal: todos; para cliente: los suyos). */
async function listar({ fecha = hoyLima(), clienteId = null }) {
    const params = [fecha];
    let filtro = '';
    if (clienteId) { params.push(clienteId); filtro = 'AND t.cliente_id = $2'; }
    const { rows } = await query(
        `SELECT t.id, t.cliente_id, c.nombre AS cliente_nombre, c.tipo AS cliente_tipo, c.documento, c.hectareas, c.cultivo,
                t.tipo, t.orden, t.inicio, t.fin, t.lps, t.volumen_m3, t.estado,
                ROUND(EXTRACT(EPOCH FROM (t.fin - t.inicio)) / 60.0) AS minutos,
                CASE WHEN t.estado = 'programado' AND t.inicio <= now() AND t.fin > now() THEN true ELSE false END AS en_curso
           FROM turnos_riego t JOIN clientes c ON c.id = t.cliente_id
          WHERE t.fecha = $1 ${filtro}
          ORDER BY t.inicio, t.id`,
        params
    );
    return rows;
}

async function demandas() {
    const p = await parametros();
    const fac = await factores();
    const { rows } = await query('SELECT id, nombre, tipo, documento, hectareas, cultivo, almacena, capacidad_reservorio_m3 FROM clientes WHERE activo ORDER BY tipo DESC, nombre');
    const hoy = hoyLima();
    const ent = await query(
        `SELECT cliente_id, SUM(volumen_m3) FILTER (WHERE tipo = 'riego') AS base, SUM(volumen_m3) FILTER (WHERE tipo <> 'riego') AS adic
           FROM turnos_riego WHERE fecha = $1 AND estado <> 'cancelado' GROUP BY cliente_id`, [hoy]);
    const mapa = new Map(ent.rows.map(r => [r.cliente_id, r]));
    const v = await caudalVigente();
    const vDia = v ? Number(v.lps) * 86.4 : 0;
    return rows.map(c => {
        const cu = cupoDe(c, p, fac);
        const e = mapa.get(c.id) || {};
        const hoyM3 = Number(e.base || 0) + Number(e.adic || 0);
        return {
            ...c, factor: cu.factor, dotacion_m3_ha: r2(cu.dotacion),
            demanda_m3_dia: r2(cu.base), cupo_base_m3: r2(cu.base),
            adicional_pct: cu.adicional_pct, adicional_m3: r2(cu.adicional), maximo_m3: r2(cu.maximo),
            tope_pct: cu.tope_pct, tope_canal_m3: r2(vDia * cu.tope_pct / 100),
            programado_hoy_m3: r2(hoyM3), base_hoy_m3: r2(Number(e.base || 0)), adicional_hoy_m3: r2(Number(e.adic || 0)),
            tope_almacen_m3: c.almacena && c.capacidad_reservorio_m3 ? r2(Number(c.capacidad_reservorio_m3)) : 0,
        };
    });
}

let temporizador = null;
function iniciarCumplimientoAutomatico() {
    const tarea = () => transaccion(db => cumplirTurnosVencidos(db))
        .then(n => { if (n) console.log(`💧 ${n} turno(s) cumplido(s) registrados como consumo.`); })
        .catch(e => console.warn('⚠️  Error al cerrar turnos:', e.message));
    tarea();
    temporizador = setInterval(tarea, 60 * 1000);
    temporizador.unref();
}

module.exports = {
    planificar, listar, demandas, parametros, factores, caudalVigente, cumplirTurnosVencidos,
    iniciarCumplimientoAutomatico, hoyLima, repartirConTope, asignar, cupoDe, esFundo,
};
