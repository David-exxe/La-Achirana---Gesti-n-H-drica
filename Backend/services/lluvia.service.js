// =====================================================================
//  Lluvia en movimiento: malla de pronóstico horario sobre la cuenca del
//  río Ica (sierra de Huancavelica → valle de Ica).
//   - Fuente: Open-Meteo (sin llave), varias coordenadas en una sola
//     consulta: https://open-meteo.com/en/docs
//   - Con CLIMA_SIMULACION=true genera una tormenta de ejemplo.
// =====================================================================
const config = require('../Config/env');
const cacheExt = require('./cacheExterno');

// Malla de 7 × 6 puntos (paso 0.2°) que cubre cabeceras, bocatoma y valle.
// Open-Meteo cuenta cada punto como una consulta: 42 puntos cada 2 h.
const LAT = Array.from({ length: 7 }, (_, i) => +(-13.05 - i * 0.2).toFixed(2));     // -13.05 … -14.25
const LON = Array.from({ length: 6 }, (_, j) => +(-75.9 + j * 0.2).toFixed(2));      // -75.90 … -74.90
const PASO = 0.2;
const CLAVE = 'lluvia_malla';
const VIGENCIA_MIN = 120;
// Celdas de "sierra" (aguas arriba de la bocatoma, al noreste)
const esSierra = (la, lo) => la > -13.95 && lo > -75.55;

let cache = { datos: null, expira: 0 };
let enCurso = null;

async function obtenerJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'LaAchirana-GestionHidrica/3.2' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${new URL(url).host}`);
    return r.json();
}

function celdas() {
    const out = [];
    for (const la of LAT) for (const lo of LON) out.push([la, lo]);
    return out;
}

function urlMalla() {
    const c = celdas();
    return 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${c.map(x => x[0]).join(',')}&longitude=${c.map(x => x[1]).join(',')}`
        + '&hourly=precipitation&past_days=1&forecast_days=2&timezone=America%2FLima';
}

async function consultarOpenMeteo() {
    const lista = await obtenerJson(urlMalla());
    const arr = Array.isArray(lista) ? lista : [lista];
    const horas = arr[0].hourly.time;
    const valores = horas.map((_, h) => arr.map(p => Math.round((p.hourly.precipitation[h] || 0) * 10) / 10));
    return { horas, valores, simulacion: false };
}

/** Tormenta de ejemplo: núcleos que nacen en la sierra por la tarde y bajan hacia el suroeste. */
function simular() {
    const c = celdas();
    const inicio = new Date();
    inicio.setMinutes(0, 0, 0);
    inicio.setHours(inicio.getHours() - 24);
    const horas = [], valores = [];
    for (let h = 0; h < 72; h++) {
        const t = new Date(inicio.getTime() + h * 3600e3);
        horas.push(new Date(t.getTime() - 5 * 3600e3).toISOString().slice(0, 16));
        const horaLocal = (t.getUTCHours() + 24 - 5) % 24;
        const tarde = Math.max(0, Math.sin(((horaLocal - 11) / 12) * Math.PI));    // máximo a las 17 h
        const fila = c.map(([la, lo]) => {
            let v = 0;
            for (const [la0, lo0, fase, fuerza] of [[-13.2, -75.0, 0, 6], [-13.4, -75.15, 9, 4.5], [-13.1, -75.3, 30, 5]]) {
                const avance = ((h + fase) % 24) / 24;                     // el núcleo se desplaza durante el día
                const cla = la0 - avance * 0.55, clo = lo0 - avance * 0.6;
                const d2 = ((la - cla) / 0.22) ** 2 + ((lo - clo) / 0.28) ** 2;
                v += fuerza * tarde * Math.exp(-d2);
            }
            return Math.round(v * 10) / 10;
        });
        valores.push(fila);
    }
    return { horas, valores, simulacion: true };
}

function resumir({ horas, valores, simulacion = false }) {
    const c = celdas();
    const idxSierra = c.map((x, i) => (esSierra(x[0], x[1]) ? i : -1)).filter(i => i >= 0);
    const idxValle = c.map((x, i) => (!esSierra(x[0], x[1]) ? i : -1)).filter(i => i >= 0);
    const prom = (fila, idx) => Math.round((idx.reduce((s, i) => s + fila[i], 0) / idx.length) * 100) / 100;
    const serie = valores.map((fila, h) => ({ hora: horas[h], sierra: prom(fila, idxSierra), valle: prom(fila, idxValle), max: Math.max(...fila) }));
    let max = { mm_h: 0, hora: null, lat: null, lon: null };
    valores.forEach((fila, h) => fila.forEach((v, i) => { if (v > max.mm_h) max = { mm_h: v, hora: horas[h], lat: c[i][0], lon: c[i][1] }; }));
    // índice de "ahora" en la serie (horas en hora local de Lima)
    const ahoraLima = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 13);
    const ahora = Math.max(0, horas.findIndex(x => x.slice(0, 13) === ahoraLima));
    const prox24 = serie.slice(ahora, ahora + 24);
    return {
        simulacion, actualizado: new Date().toISOString(), lat: LAT, lon: LON, paso: PASO, horas, valores, serie, ahora,
        resumen: {
            max, sierra_24h_mm: Math.round(prox24.reduce((s, x) => s + x.sierra, 0) * 10) / 10,
            valle_24h_mm: Math.round(prox24.reduce((s, x) => s + x.valle, 0) * 10) / 10,
            horas_con_lluvia_24h: prox24.filter(x => x.max >= 0.2).length,
        },
    };
}

async function obtenerMalla({ forzar = false } = {}) {
    if (!forzar && cache.datos && Date.now() < cache.expira) return cache.datos;
    if (!enCurso) {
        enCurso = (async () => {
            if (process.env.CLIMA_SIMULACION === 'true') {
                const datos = resumir(simular());
                cache = { datos, expira: Date.now() + 5 * 60e3 };
                return datos;
            }
            let guardado = await cacheExt.leer(CLAVE);
            if (guardado && guardado.datos?.celdas !== celdas().length) guardado = null;   // malla de otra versión
            const edadMin = guardado ? (Date.now() - guardado.actualizado) / 60e3 : Infinity;
            let crudo, desactualizado = false, actualizado = guardado?.actualizado;
            if (guardado && (edadMin < VIGENCIA_MIN || cacheExt.enPausa(CLAVE)) && !(forzar && !cacheExt.enPausa(CLAVE))) {
                crudo = guardado.datos;
                desactualizado = edadMin >= VIGENCIA_MIN;
            } else if (cacheExt.enPausa(CLAVE)) {
                throw new Error(`Open-Meteo está limitando las consultas; se reintenta en ${cacheExt.minutosPausa(CLAVE)} min`);
            } else {
                try {
                    crudo = await consultarOpenMeteo();
                    // si cambió la malla (versión anterior), no se reutiliza lo guardado
                    await cacheExt.guardar(CLAVE, { ...crudo, celdas: celdas().length });
                    actualizado = Date.now();
                } catch (err) {
                    cacheExt.pausar(CLAVE, err);
                    if (!guardado) throw err;
                    crudo = guardado.datos; desactualizado = true;
                }
            }
            const datos = { ...resumir(crudo), actualizado: new Date(actualizado).toISOString(), desactualizado };
            const espera = desactualizado ? Math.max(5, cacheExt.minutosPausa(CLAVE)) : Math.max(15, VIGENCIA_MIN - Math.floor(edadMin === Infinity ? 0 : edadMin));
            cache = { datos, expira: Date.now() + espera * 60e3 };
            return datos;
        })().finally(() => { enCurso = null; });
    }
    try {
        return await enCurso;
    } catch (err) {
        if (cache.datos) return { ...cache.datos, desactualizado: true };
        throw err;
    }
}

/** Malla calculada por el navegador ({horas, valores}); se valida y, si es del personal, se guarda. */
async function procesarExterno(cuerpo, { confiable = false } = {}) {
    const n = celdas().length;
    const { horas, valores } = cuerpo || {};
    if (!Array.isArray(horas) || horas.length < 24 || horas.length > 96 || !horas.every(h => typeof h === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(h))) throw new Error('Horas no válidas.');
    if (!Array.isArray(valores) || valores.length !== horas.length || !valores.every(f => Array.isArray(f) && f.length === n && f.every(v => typeof v === 'number' && v >= 0 && v <= 300))) throw new Error('Valores de lluvia no válidos.');
    const crudo = { horas, valores: valores.map(f => f.map(v => Math.round(v * 10) / 10)), simulacion: false };
    if (confiable) await cacheExt.guardar(CLAVE, { ...crudo, celdas: n });
    const datos = { ...resumir(crudo), actualizado: new Date().toISOString(), desactualizado: false, fuente_navegador: true };
    if (confiable) cache = { datos, expira: Date.now() + VIGENCIA_MIN * 60e3 };
    return datos;
}

module.exports = { urlMalla, procesarExterno, obtenerMalla, simular, resumir, celdas, LAT, LON };
