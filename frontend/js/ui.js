// =====================================================================
//  Utilidades de interfaz: escape anti-XSS, formatos, toasts y modales
// =====================================================================

/** Escapa texto para insertarlo en HTML de forma segura. */
export function esc(valor) {
    return String(valor ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

const fmtSoles = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });
export const soles = n => fmtSoles.format(Number(n) || 0);
export const numero = (n, dec = 2) => new Intl.NumberFormat('es-PE', { maximumFractionDigits: dec, minimumFractionDigits: 0 }).format(Number(n) || 0);
export const entero = n => fmtNum.format(Math.round(Number(n) || 0));

export function fechaCorta(iso) {
    if (!iso) return '–';
    const d = new Date(iso.length <= 10 ? `${iso}T12:00:00-05:00` : iso.replace(' ', 'T'));
    return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', timeZone: 'America/Lima' });
}
export function fechaHora(iso) {
    if (!iso) return '–';
    const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T'));
    return d.toLocaleString('es-PE', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
}
export function diaSemana(iso) {
    return new Date(`${iso}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'short', timeZone: 'America/Lima' }).replace('.', '');
}
export const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

const ESTADOS_PAGO = {
    aprobado: 'Aprobado', pendiente: 'Pendiente', validacion: 'En validación', rechazado: 'Rechazado', anulado: 'Anulado',
    revision: 'En revisión', reembolsado: 'Reembolsado',
};
export const chipEstado = e => `<span class="chip ${esc(e)}">${esc(ESTADOS_PAGO[e] || e)}</span>`;

export const NIVEL = {
    verde: { txt: 'Sin alerta', icono: 'fa-mountain-sun' },
    amarillo: { txt: 'Lluvia moderada', icono: 'fa-cloud-rain' },
    naranja: { txt: 'Lluvia fuerte', icono: 'fa-cloud-showers-heavy' },
    rojo: { txt: 'Lluvia muy fuerte', icono: 'fa-cloud-showers-water' },
};
export const colorNivel = n => getComputedStyle(document.documentElement).getPropertyValue(`--n-${n}`).trim() || '#5bb98b';
export const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------- Toasts ----------------
export function toast(mensaje, tipo = 'info', ms = 4800) {
    const iconos = { ok: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info', aviso: 'fa-triangle-exclamation' };
    const el = document.createElement('div');
    el.className = `toast ${tipo}`;
    el.innerHTML = `<i class="fa-solid ${iconos[tipo] || iconos.info}"></i><div></div>`;
    el.lastElementChild.textContent = mensaje;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
}

// ---------------- Modales ----------------
export function abrirModal(html, { ancho = false, alCerrar } = {}) {
    const fondo = document.createElement('div');
    fondo.className = 'modal-fondo';
    fondo.innerHTML = `<div class="modal ${ancho ? 'modal-ancho' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    const anterior = document.activeElement;
    const cerrar = () => {
        fondo.remove();
        document.removeEventListener('keydown', teclas);
        anterior?.focus?.();
        alCerrar?.();
    };
    const teclas = e => { if (e.key === 'Escape') cerrar(); };
    fondo.addEventListener('click', e => { if (e.target === fondo || e.target.closest('[data-cerrar]')) cerrar(); });
    document.addEventListener('keydown', teclas);
    document.getElementById('modales').appendChild(fondo);
    (fondo.querySelector('[data-foco]') || fondo.querySelector('button, input, select'))?.focus();
    return { el: fondo, cerrar };
}

/** Reemplazo de window.confirm, accesible y con estilo. */
export function confirmar({ titulo, mensaje, aceptar = 'Confirmar', peligro = false }) {
    return new Promise(resolve => {
        let respondido = false;
        const m = abrirModal(`
            <div class="modal-cab"><h3>${esc(titulo)}</h3></div>
            <div class="modal-cuerpo">${esc(mensaje)}</div>
            <div class="modal-pie">
                <button type="button" class="btn btn-ghost" data-cerrar>Cancelar</button>
                <button type="button" class="btn ${peligro ? 'btn-danger' : 'btn-primary'}" data-ok data-foco>${esc(aceptar)}</button>
            </div>`, { alCerrar: () => { if (!respondido) resolve(false); } });
        m.el.querySelector('[data-ok]').addEventListener('click', () => { respondido = true; m.cerrar(); resolve(true); });
    });
}

/** Pone un botón en estado "cargando" mientras dura la promesa. */
export async function conCarga(boton, promesaFn, texto = 'Procesando…') {
    if (!boton) return promesaFn();
    const original = boton.innerHTML;
    boton.disabled = true;
    boton.innerHTML = `<i class="fa-solid fa-spinner spin"></i> ${esc(texto)}`;
    try {
        return await promesaFn();
    } finally {
        boton.disabled = false;
        boton.innerHTML = original;
    }
}

export const filaVacia = (cols, texto, icono = 'fa-inbox') =>
    `<tr><td colspan="${cols}" class="vacio"><i class="fa-solid ${icono}"></i>${esc(texto)}</td></tr>`;

export const iniciales = nombre => String(nombre || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');

/** Copia texto al portapapeles con aviso. */
export async function copiar(texto, etiqueta = 'Copiado') {
    try {
        await navigator.clipboard.writeText(String(texto));
        toast(`${etiqueta}: ${texto}`, 'ok', 2500);
    } catch {
        toast('No se pudo copiar. Selecciona el texto y cópialo manualmente.', 'aviso');
    }
}

export const MEDIOS = {
    yape: 'Yape', plin: 'Plin', tarjeta: 'Tarjeta', transferencia: 'Transferencia', deposito: 'Depósito', efectivo: 'Efectivo',
    mercadopago: 'Mercado Pago (anterior)', legado: 'Sistema anterior',
};
