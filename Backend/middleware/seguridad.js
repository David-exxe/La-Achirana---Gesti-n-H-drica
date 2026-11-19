// =====================================================================
//  Cabeceras de seguridad (equivalente a helmet) y límite de peticiones
// =====================================================================
const config = require('../Config/env');
const { ErrorHttp } = require('../utils/validacion');

const CSP = [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://checkout.culqi.com https://js.culqi.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://unpkg.com https://*.culqi.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://*.culqi.com data:",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://gibs.earthdata.nasa.gov https://server.arcgisonline.com https://unpkg.com https://cdnjs.cloudflare.com https://*.culqi.com",
    "frame-src https://embed.windy.com https://*.culqi.com",
    "connect-src 'self' https://api.open-meteo.com https://flood-api.open-meteo.com https://*.culqi.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
].join('; ');

function cabecerasSeguras(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.esHttps) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
}

/** Limitador en memoria por IP (ventana fija). */
function limitador({ ventanaMs, max, mensaje }) {
    const registros = new Map();
    setInterval(() => {
        const ahora = Date.now();
        for (const [k, v] of registros) if (v.reinicio < ahora) registros.delete(k);
    }, ventanaMs).unref();

    return (req, res, next) => {
        const clave = req.ip;
        const ahora = Date.now();
        let r = registros.get(clave);
        if (!r || r.reinicio < ahora) {
            r = { cuenta: 0, reinicio: ahora + ventanaMs };
            registros.set(clave, r);
        }
        r.cuenta++;
        res.setHeader('RateLimit-Remaining', Math.max(0, max - r.cuenta));
        if (r.cuenta > max) {
            res.setHeader('Retry-After', Math.ceil((r.reinicio - ahora) / 1000));
            return next(new ErrorHttp(429, mensaje || 'Demasiadas solicitudes. Espera un momento.'));
        }
        next();
    };
}

module.exports = { cabecerasSeguras, limitador };
