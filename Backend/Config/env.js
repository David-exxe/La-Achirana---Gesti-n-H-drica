// =====================================================================
//  Carga de variables de entorno (.env) sin dependencias externas.
//  Busca el .env en la raíz del proyecto y, si no existe, en /Backend.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cargarArchivoEnv(ruta) {
    if (!fs.existsSync(ruta)) return false;
    const contenido = fs.readFileSync(ruta, 'utf8');
    for (const linea of contenido.split(/\r?\n/)) {
        const limpia = linea.trim();
        if (!limpia || limpia.startsWith('#')) continue;
        const idx = limpia.indexOf('=');
        if (idx === -1) continue;
        const clave = limpia.slice(0, idx).trim();
        let valor = limpia.slice(idx + 1).trim();
        if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
            valor = valor.slice(1, -1);
        }
        // Las variables reales del sistema tienen prioridad sobre el archivo
        if (process.env[clave] === undefined) process.env[clave] = valor;
    }
    return true;
}

const raiz = path.resolve(__dirname, '..', '..');
const encontrado = cargarArchivoEnv(path.join(raiz, '.env')) || cargarArchivoEnv(path.join(raiz, 'Backend', '.env'));
if (!encontrado && !process.env.RENDER && !process.env.DATABASE_URL) {
    console.warn('⚠️  No se encontró archivo .env. Copia .env.example como .env y complétalo.');
}

const num = (v, def) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
};
const bool = (v, def) => (v === undefined || v === '' ? def : String(v).toLowerCase() === 'true');

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
    jwtSecret = crypto.randomBytes(48).toString('base64url');
    console.warn('⚠️  JWT_SECRET vacío o muy corto: se generó uno temporal. Las sesiones se cerrarán al reiniciar.');
    console.warn('    Genera uno permanente con "npm run secret" y pégalo en tu .env');
}

const umbrales = (process.env.CLIMA_UMBRALES_MM || '5,15,30').split(',').map(n => parseFloat(n)).filter(Number.isFinite);

const config = {
    entorno: process.env.NODE_ENV || 'development',
    puerto: parseInt(process.env.PORT, 10) || 3000,
    // En Render, RENDER_EXTERNAL_URL trae la dirección pública (https://…onrender.com)
    urlPublica: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
    corsOrigenes: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // DATABASE_URL (Render, Railway, Neon…) tiene prioridad sobre PGHOST/PGUSER/…
    db: process.env.DATABASE_URL
        ? {
            connectionString: process.env.DATABASE_URL,
            // La URL interna de Render no usa SSL; la externa (…render.com) y otros proveedores sí.
            ssl: bool(process.env.PGSSL, /\.render\.com|neon\.tech|supabase\.co|sslmode=require/i.test(process.env.DATABASE_URL))
                ? { rejectUnauthorized: false } : false,
        }
        : {
            host: process.env.PGHOST || 'localhost',
            port: parseInt(process.env.PGPORT, 10) || 5432,
            database: process.env.PGDATABASE || 'Achirana',
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || '',
            ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
        },
    jwt: {
        secreto: jwtSecret,
        expiraHoras: num(process.env.JWT_EXPIRA_HORAS, 8),
    },
    clientePinObligatorio: bool(process.env.CLIENTE_PIN_OBLIGATORIO, false),
    validarDigitoRuc: bool(process.env.VALIDAR_DIGITO_RUC, true),
    adminInicial: {
        email: process.env.ADMIN_INICIAL_EMAIL || '',
        pass: process.env.ADMIN_INICIAL_PASS || '',
        nombre: process.env.ADMIN_INICIAL_NOMBRE || 'Administrador',
    },
    // Cuenta de gerente que se crea sola si aún no existe ninguna.
    // En producción solo se crea si defines GERENTE_INICIAL_PASS en el .env.
    gerenteInicial: {
        email: process.env.GERENTE_INICIAL_EMAIL || 'gerente@laachirana.pe',
        pass: process.env.GERENTE_INICIAL_PASS
            || (process.env.NODE_ENV === 'production' ? '' : 'Gerente2026#'),
        nombre: process.env.GERENTE_INICIAL_NOMBRE || 'Gerente General',
    },
    tarifaInicial: num(process.env.TARIFA_M3_INICIAL, 0.12),
    // Pasarela Culqi (tarjeta y Yape con cobro automático).
    // Llaves de prueba: integ-panel.culqi.com · Llaves reales: mipanel.culqi.com
    culqi: {
        publicKey: (process.env.CULQI_PUBLIC_KEY || '').trim(),
        secretKey: (process.env.CULQI_SECRET_KEY || '').trim(),
        rsaId: (process.env.CULQI_RSA_ID || '').trim(),
        rsaPublicKey: (process.env.CULQI_RSA_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim(),
        montoMinimo: num(process.env.CULQI_MONTO_MINIMO, 1),
        yape: bool(process.env.CULQI_YAPE, true),
        // Solo para pruebas locales con un simulador; en Render déjalo vacío.
        apiUrl: (process.env.CULQI_API_URL || 'https://api.culqi.com/v2').replace(/\/+$/, ''),
    },
    // Microservicio de correo (carpeta servicio-correo/, segundo servicio en Render)
    correo: {
        url: (process.env.CORREO_SERVICIO_URL || '').trim().replace(/\/+$/, ''),
        clave: (process.env.CORREO_CLAVE || '').trim(),
        junta: (process.env.NOTIFICAR_PAGOS_A || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    },
    clima: {
        umbrales: umbrales.length === 3 ? umbrales : [5, 15, 30],
        velocidadMin: num(process.env.CLIMA_VELOCIDAD_MIN, 1.5),
        velocidadMax: num(process.env.CLIMA_VELOCIDAD_MAX, 3.5),
        refrescoMin: Math.max(15, num(process.env.CLIMA_REFRESCO_MIN, 60)),
    },
};

config.esHttps = config.urlPublica.startsWith('https://');
config.culqi.activo = Boolean(config.culqi.publicKey && config.culqi.secretKey);
config.culqi.pruebas = config.culqi.secretKey.startsWith('sk_test_');
// En Render, fromService entrega solo el host del servicio de correo (sin https://)
if (config.correo.url && !/^https?:\/\//.test(config.correo.url)) config.correo.url = `https://${config.correo.url}`;
// Modo demostración: formulario de tarjeta y Yape simulados (no cobra). Solo si no hay Culqi.
config.pagosDemo = !config.culqi.activo && bool(process.env.PAGOS_DEMO, process.env.NODE_ENV !== 'production');

module.exports = config;
