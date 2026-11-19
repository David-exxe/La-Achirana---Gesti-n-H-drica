// =====================================================================
//  LA ACHIRANA · Microservicio de correo
//  Recibe avisos del sistema principal y los envía por una API de correo.
//    GET  /salud            → estado y proveedor configurado
//    POST /enviar           → { plantilla, para: [correos], datos: {...} }
//                             cabecera  Authorization: Bearer <CORREO_CLAVE>
//  Proveedores (CORREO_PROVEEDOR):
//    brevo   → https://api.brevo.com/v3/smtp/email   (BREVO_API_KEY)
//    resend  → https://api.resend.com/emails         (RESEND_API_KEY)
//    consola → no envía; imprime el correo (para desarrollo y pruebas)
//  Sin dependencias: solo Node.js 20+.
// =====================================================================
const http = require('http');
const crypto = require('crypto');
const { renderizar, PLANTILLAS } = require('./plantillas');

const PUERTO = Number(process.env.PORT) || 4100;
const CLAVE = process.env.CORREO_CLAVE || '';
const PROVEEDOR = (process.env.CORREO_PROVEEDOR || 'consola').toLowerCase();
const REMITENTE = process.env.CORREO_REMITENTE || '';            // correo verificado en Brevo/Resend
const NOMBRE_REMITENTE = process.env.CORREO_NOMBRE || 'Junta de Usuarios La Achirana';
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const historial = [];                                            // últimos envíos (en memoria)

// ------------------------------------------------------------------ límite simple: 60 envíos por minuto
let ventana = { inicio: Date.now(), n: 0 };
function permitido() {
    if (Date.now() - ventana.inicio > 60000) ventana = { inicio: Date.now(), n: 0 };
    return ++ventana.n <= 60;
}

function iguales(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function responder(res, estado, cuerpo) {
    res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(cuerpo));
}

function leerJson(req, max = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const partes = [];
        req.on('data', c => {
            total += c.length;
            if (total > max) { reject(Object.assign(new Error('Cuerpo demasiado grande.'), { estado: 413 })); req.destroy(); return; }
            partes.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); }
            catch { reject(Object.assign(new Error('JSON no válido.'), { estado: 400 })); }
        });
        req.on('error', reject);
    });
}

// ------------------------------------------------------------------ proveedores
async function enviarBrevo({ para, asunto, html, texto }) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY || '', 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { name: NOMBRE_REMITENTE, email: REMITENTE }, to: para.map(email => ({ email })), subject: asunto, htmlContent: html, textContent: texto }),
        signal: AbortSignal.timeout(15000),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(datos.message || `Brevo respondió ${r.status}`), { estado: r.status >= 500 ? 502 : 400 });
    return datos.messageId || datos.messageIds?.[0] || 'brevo';
}

async function enviarResend({ para, asunto, html, texto }) {
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${NOMBRE_REMITENTE} <${REMITENTE}>`, to: para, subject: asunto, html, text: texto }),
        signal: AbortSignal.timeout(15000),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(datos.message || `Resend respondió ${r.status}`), { estado: r.status >= 500 ? 502 : 400 });
    return datos.id || 'resend';
}

async function enviarConsola({ para, asunto, texto }) {
    console.log(`📧 [consola] Para: ${para.join(', ')} | Asunto: ${asunto}\n${texto}\n`);
    return `consola-${Date.now()}`;
}

const PROVEEDORES = { brevo: enviarBrevo, resend: enviarResend, consola: enviarConsola };

function configuracionLista() {
    if (!PROVEEDORES[PROVEEDOR]) return `Proveedor desconocido: ${PROVEEDOR}`;
    if (PROVEEDOR === 'consola') return null;
    if (!EMAIL_RE.test(REMITENTE)) return 'Falta CORREO_REMITENTE (correo verificado en el proveedor).';
    if (PROVEEDOR === 'brevo' && !process.env.BREVO_API_KEY) return 'Falta BREVO_API_KEY.';
    if (PROVEEDOR === 'resend' && !process.env.RESEND_API_KEY) return 'Falta RESEND_API_KEY.';
    return null;
}

async function enviarConReintento(mensaje) {
    const fn = PROVEEDORES[PROVEEDOR];
    try { return await fn(mensaje); }
    catch (err) {
        if ((err.estado || 502) < 500) throw err;             // error de datos o de llave: no se reintenta
        await new Promise(r => setTimeout(r, 1500));
        return fn(mensaje);
    }
}

// ------------------------------------------------------------------ servidor
const servidor = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        if (req.method === 'GET' && (url.pathname === '/salud' || url.pathname === '/')) {
            const problema = configuracionLista();
            return responder(res, 200, { ok: !problema, servicio: 'correo', proveedor: PROVEEDOR, remitente: REMITENTE ? REMITENTE.replace(/^(.).*(@.*)$/, '$1***$2') : null, problema, plantillas: Object.keys(PLANTILLAS), enviados: historial.length });
        }
        if (req.method === 'POST' && url.pathname === '/enviar') {
            if (!CLAVE || !iguales((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), CLAVE)) return responder(res, 401, { ok: false, error: 'Clave del servicio incorrecta.' });
            if (!permitido()) return responder(res, 429, { ok: false, error: 'Demasiados envíos. Intenta en un minuto.' });
            const problema = configuracionLista();
            if (problema) return responder(res, 503, { ok: false, error: problema });

            const b = await leerJson(req);
            const para = [...new Set((Array.isArray(b.para) ? b.para : [b.para]).map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
            if (!para.length || para.length > 5 || !para.every(x => EMAIL_RE.test(x))) return responder(res, 400, { ok: false, error: 'Destinatarios no válidos (1 a 5 correos con @ y dominio).' });
            if (!PLANTILLAS[b.plantilla]) return responder(res, 400, { ok: false, error: `Plantilla desconocida: ${b.plantilla}` });

            const mensaje = { para, ...renderizar(b.plantilla, b.datos || {}) };
            const id = await enviarConReintento(mensaje);
            historial.push({ id, plantilla: b.plantilla, para: para.length, en: new Date().toISOString() });
            if (historial.length > 200) historial.shift();
            console.log(`✉️  ${b.plantilla} → ${para.length} destinatario(s) [${id}]`);
            return responder(res, 202, { ok: true, id, proveedor: PROVEEDOR });
        }
        responder(res, 404, { ok: false, error: 'Ruta no encontrada.' });
    } catch (err) {
        console.error('Error al enviar:', err.message);
        responder(res, err.estado || 500, { ok: false, error: err.message });
    }
});

if (require.main === module) {
    servidor.listen(PUERTO, '0.0.0.0', () => {
        const problema = configuracionLista();
        console.log(`📮 Servicio de correo en el puerto ${PUERTO} · proveedor: ${PROVEEDOR}${problema ? ` · ⚠️ ${problema}` : ''}`);
        if (!CLAVE) console.log('⚠️  Falta CORREO_CLAVE: se rechazarán todos los envíos.');
    });
}

module.exports = { servidor };
