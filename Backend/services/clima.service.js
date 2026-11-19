// =====================================================================
//  Clima de la cuenca alta del río Ica + simulación de llegada del agua
//
//  Fuentes (gratuitas, sin API key):
//   - Open-Meteo Forecast API: lluvia diaria y horaria (modelos ECMWF/GFS/ICON)
//     https://open-meteo.com/en/docs
//   - Open-Meteo Flood API (GloFAS, Copernicus): caudal modelado del río
//     https://open-meteo.com/en/docs/flood-api
//
//  Simulación de llegada (estimación, no medición):
//   tiempo de viaje = rango entre
//     · tiempo de concentración de Kirpich: tc[min] = 0.0195 · L^0.77 · S^-0.385
//       (L = longitud del cauce en m, S = pendiente media m/m)
//     · L / velocidad de la onda de avenida (CLIMA_VELOCIDAD_MIN … MAX m/s)
//   aplicado desde la hora "centro" de la lluvia de cada día (promedio
//   ponderado de la lluvia horaria).
// =====================================================================
const config = require('../Config/env');
const { query } = require('../Config/db');
const cacheExt = require('./cacheExterno');
const CLAVE = 'clima_cuenca';

const NIVELES = ['verde', 'amarillo', 'naranja', 'rojo'];
const TEXTO_NIVEL = { verde: 'sin lluvia relevante', amarillo: 'lluvia moderada', naranja: 'lluvia fuerte', rojo: 'lluvia muy fuerte' };

let cache = { datos: null, expira: 0, error: null };
let enCurso = null;

function nivelPorLluvia(mm) {
    const [a, n, r] = config.clima.umbrales;
    if (mm >= r) return 'rojo';
    if (mm >= n) return 'naranja';
    if (mm >= a) return 'amarillo';
    return 'verde';
}

function temporada(fecha = new Date()) {
    const m = fecha.getMonth() + 1;
    if ([12, 1, 2, 3].includes(m)) return { clave: 'lluvias', texto: 'Temporada de lluvias en la sierra (diciembre a marzo)' };
    if ([4, 11].includes(m)) return { clave: 'transicion', texto: 'Transición de temporada en la sierra' };
    return { clave: 'estiaje', texto: 'Época seca (estiaje) en la sierra' };
}

/** Rango de horas que tarda el agua desde el punto hasta la bocatoma. */
function tiempoViaje(punto, altBocatoma) {
    const L = Number(punto.distancia_rio_km) * 1000;
    const H = Math.max(1, Number(punto.altitud_m) - altBocatoma);
    if (L <= 0) return null;
    const S = H / L;
    const kirpichH = (0.0195 * Math.pow(L, 0.77) * Math.pow(S, -0.385)) / 60;
    const rapidoH = L / config.clima.velocidadMax / 3600;
    const lentoH = L / config.clima.velocidadMin / 3600;
    return {
        min_h: Math.round(Math.min(kirpichH, rapidoH) * 10) / 10,
        max_h: Math.round(Math.max(kirpichH, lentoH) * 10) / 10,
        kirpich_h: Math.round(kirpichH * 10) / 10,
        pendiente_pct: Math.round(S * 1000) / 10,
    };
}

async function obtenerJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LaAchirana-GestionHidrica/2.0' } });
        if (!r.ok) throw new Error(`HTTP ${r.status} en ${new URL(url).host}`);
        return await r.json();
    } finally {
        clearTimeout(t);
    }
}

async function consultarServicios(puntos) {
    const lat = puntos.map(p => p.latitud).join(',');
    const lon = puntos.map(p => p.longitud).join(',');
    const urlPronostico = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat}&longitude=${lon}`
        + '&daily=precipitation_sum,precipitation_probability_max,precipitation_hours,temperature_2m_max,temperature_2m_min'
        + '&hourly=precipitation&past_days=2&forecast_days=7&timezone=America%2FLima';

    const bocatoma = puntos.find(p => p.tipo === 'bocatoma') || puntos[0];
    const urlCaudal = 'https://flood-api.open-meteo.com/v1/flood'
        + `?latitude=${bocatoma.latitud}&longitude=${bocatoma.longitud}`
        + '&daily=river_discharge,river_discharge_mean,river_discharge_max&past_days=30&forecast_days=30';

    const [pron, caudal] = await Promise.allSettled([obtenerJson(urlPronostico), obtenerJson(urlCaudal)]);
    if (pron.status === 'rejected') throw new Error(`Open-Meteo no respondió: ${pron.reason.message}`);
    const lista = Array.isArray(pron.value) ? pron.value : [pron.value];
    return { pronosticos: lista, caudal: caudal.status === 'fulfilled' ? caudal.value : null, errorCaudal: caudal.status === 'rejected' ? caudal.reason.message : null };
}

/** Hora media (ponderada por lluvia) de cada día, a partir de la serie horaria. */
function centroidesPorDia(hourly) {
    const res = {};
    if (!hourly?.time) return res;
    hourly.time.forEach((t, i) => {
        const mm = hourly.precipitation[i] || 0;
        if (mm <= 0) return;
        const [dia, hora] = t.split('T');
        const h = parseInt(hora, 10) + 0.5;
        res[dia] = res[dia] || { suma: 0, pond: 0 };
        res[dia].suma += mm;
        res[dia].pond += mm * h;
    });
    return Object.fromEntries(Object.entries(res).map(([d, v]) => [d, v.pond / v.suma]));
}

const fechaLima = (dia, horas) => {
    // dia "YYYY-MM-DD" en hora de Lima (UTC-5) + horas decimales
    const base = new Date(`${dia}T00:00:00-05:00`).getTime();
    return new Date(base + horas * 3600 * 1000).toISOString();
};

function construirResumen(puntos, { pronosticos, caudal, errorCaudal }) {
    const bocatoma = puntos.find(p => p.tipo === 'bocatoma');
    const altBoc = bocatoma ? Number(bocatoma.altitud_m) : 500;
    const valle = puntos.find(p => p.tipo === 'valle');
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

    const salida = puntos.map((p, i) => {
        const f = pronosticos[i] || {};
        const d = f.daily || {};
        const centros = centroidesPorDia(f.hourly);
        const viaje = p.tipo === 'sierra' ? tiempoViaje(p, altBoc) : null;
        const dias = (d.time || []).map((fecha, k) => {
            const mm = Math.round((d.precipitation_sum?.[k] ?? 0) * 10) / 10;
            const nivel = nivelPorLluvia(mm);
            let llegada = null;
            if (viaje && !p.regulado && nivel !== 'verde') {
                const centro = centros[fecha] ?? 12;
                llegada = {
                    desde: fechaLima(fecha, centro + viaje.min_h),
                    hasta: fechaLima(fecha, centro + viaje.max_h),
                    hora_centro_lluvia: Math.round(centro * 10) / 10,
                };
                if (valle) {
                    const extra = Number(valle.distancia_rio_km) * 1000 / config.clima.velocidadMax / 3600;
                    const extraLento = Number(valle.distancia_rio_km) * 1000 / config.clima.velocidadMin / 3600;
                    llegada.ciudad_desde = fechaLima(fecha, centro + viaje.min_h + extra);
                    llegada.ciudad_hasta = fechaLima(fecha, centro + viaje.max_h + extraLento);
                }
            }
            return {
                fecha,
                pasado: fecha < hoy,
                precip_mm: mm,
                probabilidad: d.precipitation_probability_max?.[k] ?? null,
                horas_lluvia: d.precipitation_hours?.[k] ?? null,
                t_max: d.temperature_2m_max?.[k] ?? null,
                t_min: d.temperature_2m_min?.[k] ?? null,
                nivel,
                llegada,
            };
        });
        const futuros = dias.filter(x => !x.pasado);
        return {
            id: p.id, nombre: p.nombre, tipo: p.tipo, latitud: Number(p.latitud), longitud: Number(p.longitud),
            altitud_m: p.altitud_m, distancia_rio_km: Number(p.distancia_rio_km), regulado: p.regulado, notas: p.notas,
            viaje,
            acumulado_7d: Math.round(futuros.reduce((s, x) => s + x.precip_mm, 0) * 10) / 10,
            nivel_max: futuros.reduce((m, x) => (NIVELES.indexOf(x.nivel) > NIVELES.indexOf(m) ? x.nivel : m), 'verde'),
            dias,
        };
    });

    // Alerta global: el peor día en los puntos de sierra no regulados
    // Prioridad: nivel > punto no regulado (genera avenida) > milímetros
    const puntaje = (p, d) => NIVELES.indexOf(d.nivel) * 10000 + (p.regulado ? 0 : 5000) + d.precip_mm;
    let peor = null;
    for (const p of salida.filter(x => x.tipo === 'sierra')) {
        for (const dia of p.dias.filter(x => !x.pasado)) {
            if (!peor || puntaje(p, dia) > puntaje(peor.punto, peor.dia)) peor = { punto: p, dia };
        }
    }
    let alerta = { nivel: 'verde', titulo: 'Sin lluvias significativas en la cuenca alta', mensaje: 'No se prevén lluvias relevantes en las cabeceras del río Ica durante los próximos 7 días.' };
    if (peor && peor.dia.nivel !== 'verde') {
        const { punto, dia } = peor;
        alerta = {
            nivel: dia.nivel,
            titulo: `${TEXTO_NIVEL[dia.nivel][0].toUpperCase()}${TEXTO_NIVEL[dia.nivel].slice(1)} prevista en ${punto.nombre}`,
            mensaje: punto.regulado
                ? `Se esperan ${dia.precip_mm} mm el ${dia.fecha}. Es una laguna regulada: el agua se almacena y llega a Ica según las descargas programadas.`
                : `Se esperan ${dia.precip_mm} mm el ${dia.fecha}. Según la simulación, el agua llegaría a la bocatoma La Achirana en ${punto.viaje.min_h}–${punto.viaje.max_h} horas.`,
            punto: punto.nombre,
            fecha: dia.fecha,
            precip_mm: dia.precip_mm,
            probabilidad: dia.probabilidad,
            llegada: dia.llegada,
        };
    }

    // Caudal modelado del río (GloFAS)
    let rio = null;
    if (caudal?.daily?.time) {
        const dd = caudal.daily;
        const idxHoy = dd.time.indexOf(hoy);
        const futuros = dd.river_discharge.slice(Math.max(0, idxHoy)).filter(v => v !== null);
        rio = {
            fuente: 'GloFAS (Copernicus) vía Open-Meteo',
            fechas: dd.time,
            caudal: dd.river_discharge,
            media: dd.river_discharge_mean || null,
            maximo: dd.river_discharge_max || null,
            hoy: idxHoy >= 0 ? dd.river_discharge[idxHoy] : null,
            pico_30d: futuros.length ? Math.max(...futuros) : null,
            nota: 'Caudal modelado en la celda de río más cercana a la bocatoma (resolución ≈ 5 km). Es referencial; no reemplaza el aforo.',
        };
    }

    return {
        actualizado: new Date().toISOString(),
        fuente: 'Open-Meteo (pronóstico) · GloFAS (caudal)',
        umbrales_mm: config.clima.umbrales,
        velocidad_ms: [config.clima.velocidadMin, config.clima.velocidadMax],
        temporada: temporada(),
        alerta,
        puntos: salida,
        rio,
        error_rio: errorCaudal,
    };
}

async function guardarAlertas(resumen) {
    for (const p of resumen.puntos) {
        for (const d of p.dias) {
            await query(
                `INSERT INTO alertas_climaticas (punto_id, fecha, precip_mm, probabilidad, nivel, llegada_desde, llegada_hasta, actualizado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, now())
                 ON CONFLICT (punto_id, fecha) DO UPDATE SET precip_mm = EXCLUDED.precip_mm, probabilidad = EXCLUDED.probabilidad,
                    nivel = EXCLUDED.nivel, llegada_desde = EXCLUDED.llegada_desde, llegada_hasta = EXCLUDED.llegada_hasta, actualizado_en = now()`,
                [p.id, d.fecha, d.precip_mm, d.probabilidad, d.nivel, d.llegada?.desde || null, d.llegada?.hasta || null]
            );
        }
    }
}

/**
 * Datos SIMULADOS para presentaciones/pruebas (CLIMA_SIMULACION=true en .env).
 * Genera una tormenta creciente en la sierra. La interfaz lo marca como simulación.
 */
function datosSimulados(puntos) {
    const dias = [];
    for (let i = -2; i < 7; i++) dias.push(new Date(Date.now() - 5 * 3600e3 + i * 86400e3).toISOString().slice(0, 10));
    const perfil = [0, 1, 2, 6, 14, 26, 38, 18, 7];
    const pronosticos = puntos.map(p => {
        const f = p.tipo === 'sierra' ? (p.altitud_m > 4000 ? 0.8 : p.altitud_m > 3200 ? 1.1 : 0.9) : 0.02;
        const hourly = { time: [], precipitation: [] };
        dias.forEach((d, k) => {
            for (let h = 0; h < 24; h++) {
                hourly.time.push(`${d}T${String(h).padStart(2, '0')}:00`);
                hourly.precipitation.push(h >= 13 && h <= 19 ? (perfil[k] * f) / 7 : 0);
            }
        });
        return {
            daily: {
                time: dias,
                precipitation_sum: perfil.map(v => Math.round(v * f * 10) / 10),
                precipitation_probability_max: perfil.map(v => Math.min(95, 15 + v * 2)),
                precipitation_hours: perfil.map(v => Math.min(12, Math.round(v / 3))),
                temperature_2m_max: dias.map(() => (p.tipo === 'sierra' ? 13 : 29)),
                temperature_2m_min: dias.map(() => (p.tipo === 'sierra' ? 0 : 16)),
            },
            hourly,
        };
    });
    const caudal = { daily: { time: [], river_discharge: [], river_discharge_mean: [], river_discharge_max: [] } };
    for (let i = -30; i < 30; i++) {
        caudal.daily.time.push(new Date(Date.now() - 5 * 3600e3 + i * 86400e3).toISOString().slice(0, 10));
        const pico = Math.exp(-Math.pow((i - 5) / 2.2, 2)) * 48;
        caudal.daily.river_discharge.push(Math.round((3 + pico + Math.sin(i / 3)) * 10) / 10);
        caudal.daily.river_discharge_mean.push(8);
        caudal.daily.river_discharge_max.push(60);
    }
    return { pronosticos, caudal, errorCaudal: null };
}

async function refrescar() {
    const { rows: puntos } = await query('SELECT * FROM puntos_monitoreo WHERE activo ORDER BY altitud_m DESC');
    if (!puntos.length) throw new Error('No hay puntos de monitoreo activos.');
    const simulacion = process.env.CLIMA_SIMULACION === 'true';
    let datos, desdeBd = null;
    if (simulacion) datos = datosSimulados(puntos);
    else {
        // 1) Dato guardado en la BD todavía vigente → no se consulta Open-Meteo
        const guardado = await cacheExt.leer(CLAVE);
        const vigente = guardado && Date.now() - guardado.actualizado < config.clima.refrescoMin * 60e3;
        if (vigente || (guardado && cacheExt.enPausa(CLAVE))) {
            datos = guardado.datos; desdeBd = guardado;
        } else if (cacheExt.enPausa(CLAVE)) {
            throw new Error(`Open-Meteo está limitando las consultas; se reintenta en ${cacheExt.minutosPausa(CLAVE)} min`);
        } else {
            try {
                datos = await consultarServicios(puntos);
                await cacheExt.guardar(CLAVE, datos);
            } catch (err) {
                cacheExt.pausar(CLAVE, err);
                if (!guardado) throw err;
                datos = guardado.datos; desdeBd = { ...guardado, error: err.message };   // último dato bueno
            }
        }
    }
    const resumen = construirResumen(puntos, datos);
    if (desdeBd) {
        resumen.actualizado = new Date(desdeBd.actualizado).toISOString();
        if (desdeBd.error || Date.now() - desdeBd.actualizado > config.clima.refrescoMin * 60e3) resumen.desactualizado = true;
    }
    if (simulacion) {
        resumen.simulacion = true;
        resumen.fuente = 'DATOS SIMULADOS (CLIMA_SIMULACION=true)';
        return (cache = { datos: resumen, expira: Date.now() + 5 * 60 * 1000, error: null }).datos; // no se guarda en BD
    }
    await guardarAlertas(resumen).catch(e => console.warn('⚠️  No se guardaron alertas:', e.message));
    // si se sirvió un dato viejo, se vuelve a intentar cuando termine la pausa
    const espera = resumen.desactualizado ? Math.max(5, cacheExt.minutosPausa(CLAVE)) : config.clima.refrescoMin;
    cache = { datos: resumen, expira: Date.now() + espera * 60 * 1000, error: null };
    return resumen;
}

/** Devuelve el resumen (desde caché si está vigente). */
async function obtenerResumen({ forzar = false } = {}) {
    if (!forzar && cache.datos && Date.now() < cache.expira) return cache.datos;
    if (!enCurso) {
        enCurso = refrescar().finally(() => { enCurso = null; });
    }
    try {
        return await enCurso;
    } catch (err) {
        cache.error = err.message;
        if (cache.datos) return { ...cache.datos, desactualizado: true, error: err.message };
        throw err;
    }
}

function invalidar() { cache.expira = 0; }

function iniciarActualizacionPeriodica() {
    const ms = config.clima.refrescoMin * 60 * 1000;
    const tarea = () => obtenerResumen({ forzar: true })
        .then(r => console.log(`🌧️  Clima actualizado: alerta ${r.alerta.nivel.toUpperCase()}`))
        .catch(e => console.warn('⚠️  No se pudo actualizar el clima:', e.message));
    setTimeout(tarea, 3000).unref();
    setInterval(tarea, ms).unref();
}

module.exports = { obtenerResumen, iniciarActualizacionPeriodica, invalidar, tiempoViaje, nivelPorLluvia, construirResumen };
