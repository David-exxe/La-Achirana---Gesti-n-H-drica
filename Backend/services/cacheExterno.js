// =====================================================================
//  Caché persistente de servicios externos (Open-Meteo) en PostgreSQL.
//   - En Render gratis el servicio se duerme y pierde la memoria: así no
//     vuelve a consultar Open-Meteo cada vez que despierta.
//   - Si Open-Meteo responde 429 (demasiadas consultas), se deja de
//     consultar un tiempo y se sirve el último dato bueno.
// =====================================================================
const { query } = require('../Config/db');

const pausas = {};               // clave → ms hasta cuando no se consulta

async function leer(clave) {
    try {
        const { rows } = await query('SELECT datos, actualizado FROM cache_externo WHERE clave = $1', [clave]);
        return rows[0] ? { datos: rows[0].datos, actualizado: new Date(rows[0].actualizado).getTime() } : null;
    } catch (err) {
        console.warn(`⚠️  No se leyó la caché ${clave}: ${err.message}`);
        return null;
    }
}

async function guardar(clave, datos) {
    try {
        await query(`INSERT INTO cache_externo (clave, datos, actualizado) VALUES ($1, $2, now())
                     ON CONFLICT (clave) DO UPDATE SET datos = EXCLUDED.datos, actualizado = now()`, [clave, JSON.stringify(datos)]);
    } catch (err) {
        console.warn(`⚠️  No se guardó la caché ${clave}: ${err.message}`);
    }
}

/** Marca una pausa tras un error de límite (429) o caída del servicio. */
function pausar(clave, err) {
    const limite = /HTTP 429/.test(err?.message || '');
    const min = limite ? 20 : 5;
    pausas[clave] = Date.now() + min * 60e3;
    console.warn(`⏸️  ${clave}: sin consultar Open-Meteo por ${min} min (${err?.message})`);
}

const enPausa = clave => (pausas[clave] || 0) > Date.now();
const minutosPausa = clave => Math.max(0, Math.ceil(((pausas[clave] || 0) - Date.now()) / 60e3));

module.exports = { leer, guardar, pausar, enPausa, minutosPausa };
