// =====================================================================
//  Utilidades criptográficas (solo módulo nativo "crypto" de Node)
//   - Hash de contraseñas con scrypt + sal aleatoria
//   - Tokens JWT firmados con HMAC-SHA256
// =====================================================================
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../Config/env');

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, LONGITUD = 32;

/** Devuelve "scrypt$N$r$p$sal$hash" (≈ 90 caracteres). */
async function hashClave(textoPlano) {
    const sal = crypto.randomBytes(16);
    const derivada = await scrypt(String(textoPlano), sal, LONGITUD, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

function esHash(valor) {
    return typeof valor === 'string' && valor.startsWith('scrypt$') && valor.split('$').length === 6;
}

/** Compara en tiempo constante. */
async function verificarClave(textoPlano, almacenado) {
    if (!esHash(almacenado)) return false;
    const [, n, r, p, salB64, hashB64] = almacenado.split('$');
    const esperado = Buffer.from(hashB64, 'base64');
    const derivada = await scrypt(String(textoPlano), Buffer.from(salB64, 'base64'), esperado.length, {
        N: parseInt(n, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return derivada.length === esperado.length && crypto.timingSafeEqual(derivada, esperado);
}

// Hash "señuelo" para que el tiempo de respuesta sea igual exista o no el usuario
let hashSenuelo = null;
async function verificarSenuelo(textoPlano) {
    if (!hashSenuelo) hashSenuelo = await hashClave(crypto.randomBytes(12).toString('hex'));
    await verificarClave(textoPlano, hashSenuelo);
    return false;
}

// ---------------- JWT (HS256) ----------------
const b64url = buf => Buffer.from(buf).toString('base64url');

function firmarToken(payload, horas = config.jwt.expiraHoras) {
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const cuerpo = b64url(JSON.stringify({ ...payload, iat: ahora, exp: ahora + Math.round(horas * 3600) }));
    const firma = crypto.createHmac('sha256', config.jwt.secreto).update(`${cabecera}.${cuerpo}`).digest('base64url');
    return `${cabecera}.${cuerpo}.${firma}`;
}

function verificarToken(token) {
    if (typeof token !== 'string') return null;
    const partes = token.split('.');
    if (partes.length !== 3) return null;
    const [cabecera, cuerpo, firma] = partes;
    try {
        const head = JSON.parse(Buffer.from(cabecera, 'base64url').toString('utf8'));
        if (head.alg !== 'HS256') return null; // evita el ataque "alg: none"
        const esperada = crypto.createHmac('sha256', config.jwt.secreto).update(`${cabecera}.${cuerpo}`).digest();
        const recibida = Buffer.from(firma, 'base64url');
        if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
        const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
        if (!datos.exp || datos.exp < Math.floor(Date.now() / 1000)) return null;
        return datos;
    } catch {
        return null;
    }
}

module.exports = { hashClave, verificarClave, verificarSenuelo, esHash, firmarToken, verificarToken };
