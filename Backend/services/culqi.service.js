// =====================================================================
//  Culqi: cobro con tarjeta (Visa, Mastercard, Amex, Diners) y Yape
//   - El navegador nunca envía el número de tarjeta a este servidor:
//     el formulario de Culqi lo convierte en un "token" (tkn_… o ype_…).
//   - Aquí solo se usa ese token para crear el cargo con la llave secreta.
//   Documentación: https://docs.culqi.com
// =====================================================================
const config = require('../Config/env');
const { ErrorHttp } = require('../utils/validacion');

const API = () => config.culqi.apiUrl;

/** Datos públicos para abrir el checkout en el navegador. */
function configuracionPublica() {
    const c = config.culqi;
    return {
        activo: c.activo,
        pruebas: c.pruebas,
        publicKey: c.activo ? c.publicKey : null,
        rsaId: c.activo && c.rsaId ? c.rsaId : null,
        rsaPublicKey: c.activo && c.rsaPublicKey ? c.rsaPublicKey : null,
        yape: c.yape,
        montoMinimo: c.montoMinimo,
    };
}

/**
 * Crea un cargo. Devuelve { id, marca, ultimos4, medio } si la venta fue exitosa.
 * Lanza ErrorHttp con el mensaje de Culqi para el usuario si fue rechazada.
 */
async function crearCargo({ token, monto, email, descripcion, metadata }) {
    if (!config.culqi.activo) throw new ErrorHttp(503, 'El pago con tarjeta no está configurado.');
    const cuerpo = {
        amount: Math.round(Number(monto) * 100),     // Culqi trabaja en céntimos
        currency_code: 'PEN',
        email,
        source_id: token,
        capture: true,
        description: String(descripcion || 'Canon hídrico').slice(0, 80),
        metadata,
    };
    let respuesta;
    let datos;
    try {
        respuesta = await fetch(`${API()}/charges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.culqi.secretKey}` },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(30000),
        });
        datos = await respuesta.json().catch(() => ({}));
    } catch (err) {
        console.error('Culqi sin respuesta:', err.message);
        throw new ErrorHttp(502, 'No pudimos comunicarnos con la pasarela de pago. No se realizó ningún cobro; inténtalo en unos minutos.');
    }

    // El banco pide verificación 3D Secure: este sistema no la soporta todavía
    if (datos?.action_code === 'REVIEW') {
        throw new ErrorHttp(402, 'Tu banco pide una verificación adicional (3D Secure). No se realizó el cobro. Prueba con otra tarjeta o paga con Yape.');
    }
    if (!respuesta.ok || datos?.object === 'error' || datos?.object !== 'charge') {
        const msg = datos?.user_message || datos?.merchant_message || 'La operación fue rechazada.';
        console.warn('Culqi rechazó el cargo:', datos?.type, datos?.code, datos?.merchant_message);
        throw new ErrorHttp(402, msg, { culqi: datos?.code || datos?.type || 'rechazado' });
    }
    if (datos.outcome?.type && datos.outcome.type !== 'venta_exitosa') {
        throw new ErrorHttp(402, datos.outcome.user_message || 'La operación no fue aprobada.');
    }

    const fuente = datos.source || {};
    const numero = String(fuente.card_number || fuente.source?.card_number || '');
    const marca = fuente.iin?.card_brand || fuente.source?.iin?.card_brand || null;
    const esYape = String(token).startsWith('ype_') || /yape/i.test(String(fuente.type || fuente.object || ''));
    return {
        id: datos.id,
        medio: esYape ? 'yape' : 'tarjeta',
        marca: esYape ? 'Yape' : (marca || 'Tarjeta'),
        ultimos4: numero ? numero.slice(-4) : null,
        mensaje: datos.outcome?.user_message || null,
    };
}

/**
 * Diagnóstico para el panel: revisa el formato de las llaves y hace una
 * consulta de solo lectura a Culqi (no cobra nada).
 */
async function diagnostico() {
    const c = config.culqi;
    const pk = c.publicKey, sk = c.secretKey;
    const modoPk = /^pk_test_/.test(pk) ? 'prueba' : /^pk_live_/.test(pk) ? 'produccion' : null;
    const modoSk = /^sk_test_/.test(sk) ? 'prueba' : /^sk_live_/.test(sk) ? 'produccion' : null;
    const chequeos = [
        { id: 'publica', ok: Boolean(modoPk), detalle: pk ? (modoPk ? `Llave pública de ${modoPk}` : 'La llave pública debe empezar con pk_test_ o pk_live_') : 'Falta CULQI_PUBLIC_KEY' },
        { id: 'secreta', ok: Boolean(modoSk), detalle: sk ? (modoSk ? `Llave secreta de ${modoSk}` : 'La llave secreta debe empezar con sk_test_ o sk_live_') : 'Falta CULQI_SECRET_KEY' },
        { id: 'pareja', ok: Boolean(modoPk && modoSk && modoPk === modoSk), detalle: !(modoPk && modoSk) ? 'Faltan llaves para comparar el entorno' : modoPk !== modoSk ? 'Una llave es de prueba y la otra de producción' : 'Ambas llaves son del mismo entorno' },
        { id: 'rsa', ok: true, detalle: c.rsaId && c.rsaPublicKey ? 'Cifrado RSA configurado' : 'Sin cifrado RSA (opcional)' },
    ];
    let conexion = { ok: false, detalle: 'No se probó: faltan llaves válidas.' };
    if (modoSk) {
        try {
            const r = await fetch(`${API()}/charges?limit=1`, { headers: { Authorization: `Bearer ${sk}` }, signal: AbortSignal.timeout(15000) });
            const d = await r.json().catch(() => ({}));
            conexion = r.ok
                ? { ok: true, detalle: 'Culqi aceptó la llave secreta.' }
                : { ok: false, detalle: d.merchant_message || d.user_message || `Culqi respondió ${r.status}` };
        } catch (err) {
            conexion = { ok: false, detalle: `Sin respuesta de Culqi: ${err.message}` };
        }
    }
    chequeos.push({ id: 'conexion', ...conexion });
    return {
        activo: c.activo, modo: modoSk || modoPk || null, yape: c.yape,
        listo: chequeos.every(x => x.ok), chequeos,
        // Más tarjetas de prueba: https://docs.culqi.com (sección Tarjetas de prueba)
        tarjetasPrueba: modoSk === 'prueba' ? [
            { marca: 'Visa', numero: '4111 1111 1111 1111', vence: 'fecha futura', cvv: '123', resultado: 'Aprobada' },
        ] : [],
    };
}

module.exports = { configuracionPublica, crearCargo, diagnostico };
