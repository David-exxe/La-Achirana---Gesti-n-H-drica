// =====================================================================
//  LA ACHIRANA · Servidor principal
//  Ejecuta:  npm start   (o  npm run dev  para recargar al guardar)
//  Abre:     http://localhost:3000
// =====================================================================
const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./Config/env');
const { pool } = require('./Config/db');
const { aplicarMigraciones } = require('./db/migraciones');
const { cabecerasSeguras, limitador } = require('./middleware/seguridad');
const { manejadorErrores, noEncontrado } = require('./middleware/errores');
const rutas = require('./routes');
const clima = require('./services/clima.service');
const turnos = require('./services/turnos.service');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // necesario detrás de ngrok / proxy para leer la IP real

app.use(cabecerasSeguras);

// CORS: mismo origen siempre permitido; otros orígenes solo si están en CORS_ORIGINS
const permitidos = new Set([config.urlPublica, `http://localhost:${config.puerto}`, `http://127.0.0.1:${config.puerto}`, ...config.corsOrigenes]);
app.use('/api', cors({
    origin(origen, cb) {
        if (!origen || permitidos.has(origen)) return cb(null, true);
        cb(new Error('CORS: origen no permitido'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
}));

// Fotos de voucher y QR necesitan un límite mayor; el resto de la API, 50 KB
app.use('/api/pagos/reportar', express.json({ limit: '5mb' }));
app.use('/api/admin/cuentas-cobro', express.json({ limit: '1mb' }));
app.use(['/api/clima/resumen-externo', '/api/clima/lluvia-externo'], express.json({ limit: '400kb' }));
app.use(express.json({ limit: '50kb' }));
// Verificación de salud (Render la usa para saber si el servicio está vivo)
app.get('/api/salud', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true, version: require('../package.json').version }); }
    catch { res.status(503).json({ ok: false }); }
});
app.use('/api', limitador({ ventanaMs: 60 * 1000, max: 300 }));
app.use('/api', rutas);
app.use('/api', noEncontrado);

// Frontend estático (mismo origen que la API → sin problemas de CORS)
const carpetaFront = path.join(__dirname, '..', 'frontend');
app.use(express.static(carpetaFront, { index: 'index.html', maxAge: config.entorno === 'production' ? '1h' : 0 }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(carpetaFront, 'index.html')));

app.use(manejadorErrores);

async function iniciar() {
    console.log('=================================================');
    try {
        await pool.query('SELECT 1');
        const destino = config.db.connectionString
            ? new URL(config.db.connectionString).host + new URL(config.db.connectionString).pathname
            : `${config.db.database}@${config.db.host}:${config.db.port}`;
        console.log(`🗄️  Conectado a PostgreSQL: ${destino}`);
        await aplicarMigraciones();
        console.log('✅ Base de datos lista.');
    } catch (err) {
        console.error('❌ No se pudo preparar la base de datos:', err.message);
        console.error('   Revisa DATABASE_URL (o PGHOST / PGDATABASE / PGUSER / PGPASSWORD) en tu .env o en las variables de Render');
        process.exit(1);
    }

    app.listen(config.puerto, '0.0.0.0', () => {
        console.log(`🚀 La Achirana disponible en ${config.urlPublica}`);
        console.log('💳 Pagos: Yape, Plin y transferencias (configura las cuentas en Panel → Medios de pago)');
        console.log('=================================================');
        clima.iniciarActualizacionPeriodica();
        turnos.iniciarCumplimientoAutomatico();
    });
}

if (require.main === module) iniciar();

module.exports = app;
