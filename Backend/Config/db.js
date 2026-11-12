// =====================================================================
//  Conexión a PostgreSQL (pool compartido)
// =====================================================================
const { Pool, types } = require('pg');
const config = require('./env');

// NUMERIC (oid 1700) llega como string por defecto: lo convertimos a número.
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));

const pool = new Pool({
    ...config.db,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
});

pool.on('error', err => {
    console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message);
});

/** Ejecuta una función dentro de una transacción. */
async function transaccion(fn) {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const resultado = await fn(cliente);
        await cliente.query('COMMIT');
        return resultado;
    } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        cliente.release();
    }
}

module.exports = { pool, query: (texto, params) => pool.query(texto, params), transaccion };
