// =====================================================================
//  Cliente del microservicio de correo (carpeta servicio-correo/)
//   - Nunca bloquea el cobro: los avisos se envían en segundo plano.
//   - En Render el servicio gratuito puede estar dormido: si falla, se
//     reintenta una vez a los 40 s.
// =====================================================================
const config = require('../Config/env');

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const activo = () => Boolean(config.correo.url && config.correo.clave);
const destinosJunta = () => config.correo.junta.filter(x => EMAIL_RE.test(x));

async function llamar(ruta, { metodo = 'GET', cuerpo, timeoutMs = 20000 } = {}) {
    const r = await fetch(`${config.correo.url}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.correo.clave}` },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(datos.error || `El servicio de correo respondió ${r.status}`), { estado: r.status });
    return datos;
}

/** Envía y espera la respuesta (se usa en la prueba del panel). */
async function enviarAhora(plantilla, para, datos) {
    if (!activo()) throw Object.assign(new Error('Las notificaciones por correo no están configuradas (CORREO_SERVICIO_URL y CORREO_CLAVE).'), { estado: 503 });
    return llamar('/enviar', { metodo: 'POST', cuerpo: { plantilla, para, datos }, timeoutMs: 60000 });
}

/** Envía en segundo plano; nunca lanza error. */
function notificar(plantilla, para, datos) {
    const lista = [...new Set((Array.isArray(para) ? para : [para]).filter(x => EMAIL_RE.test(String(x || ''))))];
    if (!lista.length) return;
    if (!activo()) { console.log(`✉️  (correo desactivado) ${plantilla} → ${lista.length} destinatario(s)`); return; }
    const intento = () => llamar('/enviar', { metodo: 'POST', cuerpo: { plantilla, para: lista, datos } });
    intento().catch(err => {
        if (err.estado && err.estado < 500 && err.estado !== 429) { console.warn(`✉️  No se envió ${plantilla}: ${err.message}`); return; }
        setTimeout(() => intento().catch(e => console.warn(`✉️  No se envió ${plantilla} (2.º intento): ${e.message}`)), 40000).unref?.();
    });
}

const URL_PANEL = () => `${config.urlPublica}/#admin`;
const URL_PAGOS = () => `${config.urlPublica}/#pagos`;
const MEDIO = { efectivo: 'Efectivo (caja)', yape: 'Yape', plin: 'Plin', transferencia: 'Transferencia', deposito: 'Depósito', tarjeta: 'Tarjeta' };

function medioTexto(pago) {
    const base = MEDIO[pago.metodo] || pago.metodo || '';
    const ent = pago.entidad && !String(pago.entidad).startsWith('caja') ? String(pago.entidad) : '';
    if (!ent) return base;
    return ent.toLowerCase().includes(String(base).toLowerCase()) ? ent : `${base} · ${ent}`;
}

function datosPago(pago, cliente) {
    return {
        cliente: cliente?.nombre, documento: cliente?.documento, monto: pago.monto, numero: pago.numero || null,
        medio: medioTexto(pago),
        operacion: pago.operacion || null, volumen_m3: pago.volumen_m3 != null ? Number(pago.volumen_m3).toFixed(2) : null,
        fecha_operacion: pago.fecha_operacion ? new Date(pago.fecha_operacion).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : null,
        demo: String(pago.operacion || '').startsWith('DEMO-'),
    };
}

/** Avisos por evento de pago. */
const avisos = {
    reportado(pago, cliente) {
        const d = datosPago(pago, cliente);
        notificar('pago_reportado', destinosJunta(), { ...d, url: URL_PANEL() });
        if (pago.email_contacto) notificar('constancia_recibida', pago.email_contacto, d);
    },
    aprobado(pago, cliente, emailExtra = null) {
        const d = datosPago(pago, cliente);
        notificar('pago_aprobado', destinosJunta(), { ...d, para_junta: true, url: URL_PANEL() });
        const regante = [pago.email_contacto, emailExtra].filter(Boolean);
        if (regante.length) notificar('pago_aprobado', regante, { ...d, url: URL_PAGOS() });
    },
    rechazado(pago, cliente) {
        if (pago.email_contacto) notificar('pago_rechazado', pago.email_contacto, { ...datosPago(pago, cliente), motivo: pago.motivo_rechazo });
    },
};

async function estado() {
    const base = { configurado: activo(), destinatarios: destinosJunta().length, url: config.correo.url ? config.correo.url.replace(/^(https?:\/\/[^/]+).*/, '$1') : null };
    if (!activo()) return { ...base, ok: false, problema: 'Faltan CORREO_SERVICIO_URL y CORREO_CLAVE en las variables del servicio.' };
    try {
        const s = await llamar('/salud', { timeoutMs: 60000 });
        return { ...base, ok: s.ok && base.destinatarios > 0, proveedor: s.proveedor, remitente: s.remitente, problema: s.problema || (base.destinatarios ? null : 'Falta NOTIFICAR_PAGOS_A (correo de la Junta).') };
    } catch (err) {
        return { ...base, ok: false, problema: `No se pudo contactar al servicio de correo: ${err.message}` };
    }
}

module.exports = { notificar, enviarAhora, avisos, estado, activo, destinosJunta, EMAIL_RE };
