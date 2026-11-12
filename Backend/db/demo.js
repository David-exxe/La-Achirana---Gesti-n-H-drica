// =====================================================================
//  Datos de DEMOSTRACIÓN (ficticios) para presentar el sistema.
//   - Solo se cargan si SEMBRAR_DEMO=true y la tabla clientes está vacía.
//   - Nombres, DNI (99xxxxxx), RUC (20999xxxxxx), consumos, pagos y
//     movimientos son INVENTADOS: no corresponden a personas ni empresas reales.
//   - Fechas relativas al día de carga (últimos 60 días).
// =====================================================================
const { transaccion } = require('../Config/db');

// Generador pseudoaleatorio con semilla: los mismos datos en cada carga
function prng(semilla) {
    let a = semilla >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const R = prng(20261112);
const entre = (a, b) => a + R() * (b - a);
const elegir = arr => arr[Math.floor(R() * arr.length)];
const r2 = n => Math.round(n * 100) / 100;

function rucConDigito(base10) {
    const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = pesos.reduce((acc, p, i) => acc + p * Number(base10[i]), 0);
    let dv = 11 - (suma % 11);
    if (dv === 10) dv = 0;
    if (dv === 11) dv = 1;
    return base10 + dv;
}

const NOMBRES = ['Juan', 'María', 'José', 'Rosa', 'Luis', 'Carmen', 'Pedro', 'Ana', 'Jorge', 'Elena', 'Víctor', 'Lucía', 'Manuel', 'Teresa',
    'Raúl', 'Gloria', 'César', 'Juana', 'Miguel', 'Isabel', 'Alberto', 'Norma', 'Félix', 'Delia', 'Hugo', 'Marta', 'Óscar', 'Edith', 'Walter', 'Nelly'];
const APELLIDOS = ['Quispe', 'Huamán', 'Flores', 'Mendoza', 'Ramos', 'García', 'Tataje', 'Hernández', 'Uchuya', 'Cabrera', 'Pecho', 'Donayre',
    'Muñante', 'Yataco', 'Ccahuana', 'Saravia', 'Bendezú', 'Arotoma', 'Magallanes', 'Lévano', 'Cartagena', 'Pariona', 'Huarcaya', 'Espino'];
const SECTORES = ['Los Aquijes', 'Pueblo Nuevo', 'Tate', 'Pachacútec', 'Santiago', 'Parcona', 'La Tinguiña'];
const CULTIVOS_PARC = ['Pallar', 'Uva', 'Maíz', 'Algodón', 'Palta', 'Mandarina', 'Espárrago', 'Granado', 'Frijol'];
const CULTIVOS_FUNDO = ['Uva de mesa', 'Espárrago', 'Palta Hass', 'Mandarina', 'Granado', 'Dátil'];
const FUNDOS = ['Agrícola Huarango Verde S.A.C.', 'Fundo Las Dunas Altas S.A.C.', 'Agroexportadora Valle del Sol S.A.C.', 'Fundo Santa Clotilde S.A.C.',
    'Agrícola Médano Dorado S.A.C.', 'Fundo Los Pallares S.A.C.', 'Agrícola Achirana Sur S.A.C.', 'Fundo Cerro Prieto Ica S.A.C.',
    'Agroindustrias Tres Huarangos S.A.C.', 'Fundo El Algarrobal S.A.C.'];

const DIAS = 60;
const MOROSOS_PARC = 3;          // parceleros sin pagar más de 30 días
const MOROSOS_FUNDO = 1;

function generarClientes() {
    const usados = new Set();
    const parceleros = [];
    for (let i = 0; i < 30; i++) {
        let nombre;
        do { nombre = `${elegir(NOMBRES)} ${elegir(APELLIDOS)} ${elegir(APELLIDOS)}`; } while (usados.has(nombre));
        usados.add(nombre);
        parceleros.push({
            tipo: 'parcelero', documento: String(99000000 + i * 7919 + 101).slice(0, 8), nombre,
            hectareas: r2(entre(0.5, 12)), sector: elegir(SECTORES), cultivo: elegir(CULTIVOS_PARC), almacena: false, capacidad: null,
        });
    }
    const fundos = FUNDOS.map((nombre, i) => {
        const almacena = i % 4 !== 3;
        return {
            tipo: 'empresa', documento: rucConDigito(`2099900${String(1000 + i * 37).padStart(3, '0')}`.slice(0, 10)), nombre,
            hectareas: r2(entre(40, 450)), sector: elegir(SECTORES), cultivo: elegir(CULTIVOS_FUNDO), almacena,
            capacidad: almacena ? Math.round(entre(8, 80)) * 1000 : null,
        };
    });
    return { parceleros, fundos };
}

async function sembrarDemo() {
    return transaccion(async db => {
        const n = await db.query('SELECT COUNT(*)::int AS n FROM clientes');
        if (n.rows[0].n > 0) return { omitido: true };
        const tarifa = Number((await db.query('SELECT precio_m3 FROM tarifas ORDER BY vigente_desde DESC, id DESC LIMIT 1')).rows[0]?.precio_m3 || 0.12);
        const { parceleros, fundos } = generarClientes();
        const metodos = [
            { metodo: 'efectivo', entidad: null }, { metodo: 'yape', entidad: 'Yape (BCP)' }, { metodo: 'yape', entidad: 'Yape (BCP)' },
            { metodo: 'plin', entidad: 'Plin' }, { metodo: 'transferencia', entidad: 'BCP' }, { metodo: 'transferencia', entidad: 'Interbank' },
        ];
        let lecturas = 0, pagos = 0;

        const todos = [...parceleros.map((c, i) => ({ ...c, moroso: i < MOROSOS_PARC })), ...fundos.map((c, i) => ({ ...c, moroso: i < MOROSOS_FUNDO }))];
        for (const c of todos) {
            const ins = await db.query(
                `INSERT INTO clientes (tipo, documento, nombre, hectareas, ubicacion_sector, cultivo, almacena, capacidad_reservorio_m3, creado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - INTERVAL '75 days') RETURNING id`,
                [c.tipo, c.documento, c.nombre, c.hectareas, c.sector, c.cultivo, c.almacena, c.capacidad]
            );
            const id = ins.rows[0].id;
            // Lecturas cada 2 a 4 días durante los últimos 60 días
            const filas = [];
            for (let d = DIAS; d >= 1; d -= 2 + Math.floor(R() * 3)) {
                const lps = c.tipo === 'empresa' ? r2(c.hectareas * entre(0.45, 0.7)) : r2(Math.max(1.5, c.hectareas * entre(0.7, 1.1)));
                const horas = c.tipo === 'empresa' ? r2(entre(12, 22)) : r2(entre(3, 9));
                const volumen = r2(lps * 3.6 * horas);
                const r = await db.query(
                    `INSERT INTO historial_caudal (cliente_id, fecha, lps, m3_hora, m3_dia, estado, volumen_m3, horas)
                     VALUES ($1, now() - make_interval(days => $2::int), $3, $4, $5, 'Normal', $6, $7) RETURNING id`,
                    [id, d, lps, r2(lps * 3.6), r2(lps * 86.4), volumen, horas]
                );
                filas.push({ id: r.rows[0].id, d, volumen });
                lecturas++;
            }
            if (c.moroso) continue;
            // Dos pagos: lecturas de hace más de 40 días y lecturas entre 40 y 12 días
            for (const [desde, hasta, pagoDia] of [[DIAS + 1, 41, 38], [40, 12, 9]]) {
                const lote = filas.filter(f => f.d <= desde && f.d >= hasta);
                if (!lote.length) continue;
                const volumen = r2(lote.reduce((s, f) => s + f.volumen, 0));
                const monto = r2(volumen * tarifa);
                if (monto <= 0) continue;
                const tipo = c.tipo === 'empresa' ? 'FACTURA' : 'BOLETA';
                const seq = tipo === 'FACTURA' ? 'seq_factura' : 'seq_boleta';
                const num = (await db.query(`SELECT nextval('${seq}') AS n`)).rows[0].n;
                const numero = `${tipo === 'FACTURA' ? 'F001' : 'B001'}-${String(num).padStart(8, '0')}`;
                const m = elegir(metodos);
                const operacion = m.entidad ? `DEMO${String(Math.floor(entre(10000000, 99999999)))}` : null;
                const p = await db.query(
                    `INSERT INTO pagos (cliente_id, fecha, tipo, numero, concepto, monto, estado, metodo, volumen_m3, tarifa_m3, lectura_hasta_id,
                                        pagado_en, entidad, operacion, fecha_operacion, monto_declarado, validado_en)
                     VALUES ($1, now() - make_interval(days => $2::int), $3, $4, $5, $6, 'aprobado', $7, $8, $9, $10,
                             now() - make_interval(days => $2::int), $11, $12::varchar,
                             CASE WHEN $12::varchar IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) END,
                             CASE WHEN $12::varchar IS NULL THEN NULL ELSE $6::numeric END,
                             CASE WHEN $12::varchar IS NULL THEN NULL ELSE now() - make_interval(days => $2::int) END)
                     RETURNING id`,
                    [id, pagoDia, tipo, numero, `Canon hídrico por consumo volumétrico (${volumen.toFixed(2)} m³ a S/ ${tarifa.toFixed(4)} por m³) – demostración`,
                        monto, m.metodo, volumen, tarifa, Math.max(...lote.map(f => f.id)), m.entidad, operacion]
                );
                await db.query('UPDATE historial_caudal SET pago_id = $1 WHERE id = ANY($2::int[])', [p.rows[0].id, lote.map(f => f.id)]);
                await db.query(
                    "INSERT INTO historial_pagos (cliente_id, pago_id, monto, estado, detalle) VALUES ($1,$2,$3,'aprobado',$4)",
                    [id, p.rows[0].id, monto, `Aprobado ${m.metodo} ${numero} (demostración)`]
                );
                pagos++;
            }
        }

        // Caudal del canal: una lectura diaria (estiaje, con variación) y una de hoy
        for (let d = DIAS; d >= 0; d--) {
            const lps = r2(entre(900, 1500) - d * 4);
            await db.query(
                `INSERT INTO caudal_canal (fecha, lps, m3_hora, m3_dia, nota)
                 VALUES (now() - make_interval(days => $1::int, hours => 2), $2, $3, $4, 'Lectura de demostración')`,
                [d, lps, r2(lps * 3.6), r2(lps * 86.4)]
            );
        }

        // Movimientos financieros de los últimos 6 meses (montos de demostración)
        const mov = [];
        for (let mes = 5; mes >= 0; mes--) {
            const f = dia => `(date_trunc('month', now()) - make_interval(months => ${mes}) + make_interval(days => ${dia}))::date`;
            mov.push([f(4), 'egreso', 'Personal', 'Planilla del personal de campo y oficina (demostración)', r2(entre(4500, 5200))]);
            mov.push([f(9), 'egreso', 'Operación y mantenimiento', 'Mantenimiento de compuertas y tomas (demostración)', r2(entre(1800, 3600))]);
            mov.push([f(14), 'egreso', 'Energía y combustible', 'Combustible de camioneta y bombas (demostración)', r2(entre(600, 950))]);
            mov.push([f(19), 'egreso', 'Administración', 'Útiles, internet y telefonía (demostración)', r2(entre(350, 600))]);
            if (mes % 3 === 0) mov.push([f(22), 'egreso', 'Retribución económica (ANA)', 'Pago trimestral de retribución económica (demostración)', r2(entre(2500, 3200))]);
            if (mes === 2) mov.push([f(11), 'egreso', 'Infraestructura y obras', 'Descolmatación de un tramo del canal (demostración)', 12000]);
            mov.push([f(24), 'ingreso', 'Multas y recargos', 'Recargos por pago tardío (demostración)', r2(entre(150, 450))]);
        }
        for (const [fecha, tipo, categoria, descripcion, monto] of mov) {
            await db.query(`INSERT INTO movimientos (fecha, tipo, categoria, descripcion, monto) VALUES (${fecha}, $1, $2, $3, $4)`,
                [tipo, categoria, descripcion, monto]);
        }
        return { omitido: false, clientes: todos.length, lecturas, pagos, movimientos: mov.length };
    });
}

module.exports = { sembrarDemo, generarClientes, rucConDigito };
