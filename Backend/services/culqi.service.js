// =====================================================================
//  Culqi: cobro con tarjeta (Visa, Mastercard, Amex, Diners) y Yape
//   - El navegador nunca envía el número de tarjeta a este servidor:
//     el formulario de Culqi lo convierte en un "token" (tkn_… o ype_…).
//   - Aquí solo se usa ese token para crear el cargo con la llave secreta.
//   Documentación: https://docs.culqi.com
// =====================================================================
const config = require('../Config/env');
const { ErrorHttp } = require('../utils/validacion');

const API = 'https://api.culqi.com/v2';

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
        respuesta = await fetch(`${API}/charges`, {
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

module.exports = { configuracionPublica, crearCargo };
