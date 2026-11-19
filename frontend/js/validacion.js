// =====================================================================
//  Validación en el navegador (la definitiva siempre ocurre en el servidor)
//  Uso: <input data-validar="dni"> y validarFormulario(form)
// =====================================================================

const SOLO_DIGITOS = new Set(['dni', 'ruc', 'ruc-login', 'pin-opcional', 'documento', 'dias']);
const DECIMALES = new Set(['lps', 'lps-canal', 'hectareas', 'tarifa', 'latitud', 'longitud', 'distancia', 'capacidad', 'lamina', 'dotacion', 'porcentaje', 'porcentaje0', 'capacidad-canal', 'volumen0', 'monto']);

export function rucValido(ruc) {
    if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
    const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = pesos.reduce((a, p, i) => a + p * Number(ruc[i]), 0);
    let dv = 11 - (suma % 11);
    if (dv === 10) dv = 0;
    if (dv === 11) dv = 1;
    return dv === Number(ruc[10]);
}

/** Explica qué le falta a un correo (null si es válido). Igual que en el servidor. */
export function problemaEmail(e) {
    if (!e) return 'Ingresa tu correo.';
    if (/\s/.test(e)) return 'El correo no lleva espacios.';
    const partes = e.split('@');
    if (partes.length === 1) return 'Falta el @ (nombre@dominio.com).';
    if (partes.length > 2) return 'Solo puede haber un @.';
    const [usuario, dominio] = partes;
    if (!usuario) return 'Falta el nombre antes del @.';
    if (!dominio) return 'Falta el dominio después del @ (ej. gmail.com).';
    if (!dominio.includes('.')) return 'Falta la extensión del dominio (.com, .pe…).';
    if (!/\.[A-Za-z]{2,24}$/.test(dominio)) return 'La extensión del dominio no es válida.';
    if (!/^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/.test(e) || e.length > 120) return 'El correo tiene caracteres no permitidos.';
    return null;
}

const decimalesMax = (v, n) => !String(v).includes('.') || String(v).split('.')[1].length <= n;
const NOMBRE = /^[\p{L}\p{N} .,'&()\-/]+$/u;
const TEXTO = /^[\p{L}\p{N} .,'&()\-/#°ºª:;+]+$/u;

/** Cada regla devuelve null si es válido, o el mensaje de error. */
const REGLAS = {
    requerido: v => (v ? null : 'Este campo es obligatorio.'),
    email: v => problemaEmail(v),
    'email-opcional': v => (v ? problemaEmail(v) : null),
    dni: v => (!v ? 'Ingresa tu DNI.' : /\D/.test(v) ? 'El DNI solo lleva números.' : v.length !== 8 ? `El DNI tiene 8 dígitos (van ${v.length}).` : null),
    ruc: v => (!/^\d{11}$/.test(v) ? 'El RUC tiene exactamente 11 dígitos.' : !/^(10|15|16|17|20)/.test(v) ? 'El RUC empieza con 10, 15, 16, 17 o 20.' : rucValido(v) ? null : 'El dígito verificador no coincide. Revisa el número.'),
    'ruc-login': v => (!v ? 'Ingresa tu RUC.' : /\D/.test(v) ? 'El RUC solo lleva números.' : v.length !== 11 ? `El RUC tiene 11 dígitos (van ${v.length}).` : !/^(10|15|16|17|20)/.test(v) ? 'El RUC empieza con 10, 15, 16, 17 o 20.' : rucValido(v) ? null : 'RUC no válido: revisa el último dígito.'),
    'pin-opcional': v => (!v ? null : !/^\d{6}$/.test(v) ? 'El código tiene 6 dígitos.' : null),
    nombre: v => (v.length < 3 ? 'Mínimo 3 caracteres.' : v.length > 100 ? 'Máximo 100 caracteres.' : NOMBRE.test(v) ? null : 'Usa solo letras, números y . , - & ( ) /'),
    'nombre-persona': v => (v.length < 2 ? 'Mínimo 2 caracteres.' : /^[\p{L} .'-]+$/u.test(v) ? null : 'Solo letras y espacios.'),
    cultivo: v => (v.length < 2 ? 'Mínimo 2 caracteres.' : NOMBRE.test(v) ? null : 'Contiene caracteres no permitidos.'),
    sector: v => (v.length < 2 ? 'Mínimo 2 caracteres.' : TEXTO.test(v) ? null : 'Contiene caracteres no permitidos.'),
    hectareas: v => {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n)) return 'Ingresa un número (ej. 12.5).';
        if (n <= 0) return 'Debe ser mayor que 0.';
        if (n > 99999999) return 'Valor demasiado grande.';
        return decimalesMax(v, 2) ? null : 'Máximo 2 decimales.';
    },
    lps: v => {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n)) return 'Ingresa el caudal en L/s.';
        if (n <= 0) return 'Debe ser mayor que 0.';
        if (n > 5000) return 'Máximo 5000 L/s.';
        return decimalesMax(v, 2) ? null : 'Máximo 2 decimales.';
    },
    'lps-canal': v => {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n)) return 'Ingresa el caudal del canal en L/s (0 si está seco).';
        if (n < 0) return 'No puede ser negativo.';
        if (n > 20000) return 'Máximo 20 000 L/s.';
        return decimalesMax(v, 2) ? null : 'Máximo 2 decimales.';
    },
    capacidad: v => (!v ? null : Number(v) > 0 && Number(v) <= 1e9 ? null : 'Debe ser mayor que 0 (o déjalo vacío).'),
    lamina: v => (v !== '' && Number(v) > 0 && Number(v) <= 30 && decimalesMax(v, 2) ? null : 'Entre 0.1 y 30 mm/día (máx. 2 decimales).'),
    dias: v => (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 30 ? null : 'Número entero entre 1 y 30.'),
    tarifa: v => {
        const n = Number(v);
        if (v === '' || !Number.isFinite(n) || n <= 0) return 'Ingresa un precio mayor que 0.';
        if (n >= 1000) return 'Debe ser menor que 1000.';
        return decimalesMax(v, 4) ? null : 'Máximo 4 decimales.';
    },
    motivo: v => (v.length < 5 ? 'Explica el motivo (mínimo 5 caracteres).' : null),
    'fecha-pasada': v => (!v ? null : new Date(v).getTime() > Date.now() + 5 * 60000 ? 'La fecha no puede ser futura.' : null),
    clave: (v, input) => {
        const opcional = input.dataset.opcional === 'true';
        if (!v) return opcional ? null : 'Ingresa una contraseña.';
        if (v.length < 8) return 'Mínimo 8 caracteres.';
        if (!/[A-Z]/.test(v)) return 'Falta una mayúscula.';
        if (!/[a-z]/.test(v)) return 'Falta una minúscula.';
        if (!/\d/.test(v)) return 'Falta un número.';
        if (!/[^A-Za-z0-9]/.test(v)) return 'Falta un símbolo (ej. # $ _ @).';
        return null;
    },
    latitud: v => (v !== '' && Number(v) >= -18.5 && Number(v) <= 0 ? null : 'Entre -18.5 y 0 (Perú).'),
    longitud: v => (v !== '' && Number(v) >= -81.5 && Number(v) <= -68.5 ? null : 'Entre -81.5 y -68.5 (Perú).'),
    altitud: v => (/^\d{1,4}$/.test(v) && Number(v) <= 6800 ? null : 'Número entero entre 0 y 6800.'),
    distancia: v => (v !== '' && Number(v) >= 0 && Number(v) <= 600 ? null : 'Entre 0 y 600 km.'),
    dotacion: v => (v !== '' && Number(v) >= 1 && Number(v) <= 300 && decimalesMax(v, 2) ? null : 'Entre 1 y 300 m³/ha (máx. 2 decimales).'),
    porcentaje: v => (v !== '' && Number(v) >= 1 && Number(v) <= 100 && decimalesMax(v, 2) ? null : 'Entre 1 y 100 %.'),
    porcentaje0: v => (v !== '' && Number(v) >= 0 && Number(v) <= 100 && decimalesMax(v, 2) ? null : 'Entre 0 y 100 %.'),
    'capacidad-canal': v => (v !== '' && Number(v) >= 1 && Number(v) <= 50000 && decimalesMax(v, 2) ? null : 'Entre 1 y 50 000 L/s.'),
    volumen0: v => (v !== '' && Number(v) >= 0 && Number(v) <= 1e9 && decimalesMax(v, 2) ? null : 'Entre 0 y 1 000 000 000 m³.'),
    monto: v => (v !== '' && Number(v) > 0 && Number(v) < 1e8 && decimalesMax(v, 2) ? null : 'Monto mayor que 0 (máx. 2 decimales).'),
    descripcion: v => (v.length < 3 ? 'Mínimo 3 caracteres.' : v.length > 200 ? 'Máximo 200 caracteres.' : null),
    operacion: v => (/^[A-Za-z0-9-]{4,30}$/.test(v) ? null : 'Entre 4 y 30 caracteres: letras, números o guiones.'),
    celular: v => (/^9\d{8}$/.test(v.replace(/\s/g, '')) ? null : 'Celular de 9 dígitos que empieza con 9.'),
};

function cajaError(input) {
    const form = input.form || input.closest('form') || document;
    return form.querySelector(`[data-error-de="${input.name}"]`);
}

export function mostrarError(input, mensaje) {
    const caja = cajaError(input);
    if (mensaje) {
        input.setAttribute('aria-invalid', 'true');
        if (caja) { caja.textContent = mensaje; caja.id ||= `err-${input.id || input.name}`; input.setAttribute('aria-describedby', caja.id); }
    } else {
        input.removeAttribute('aria-invalid');
        if (caja) caja.textContent = '';
    }
}

export function validarCampo(input) {
    const regla = REGLAS[input.dataset.validar];
    if (!regla) return true;
    const valor = input.type === 'password' ? input.value : input.value.trim();
    const error = regla(valor, input);
    mostrarError(input, error);
    return !error;
}

/** Valida todo el formulario; enfoca el primer campo con error. */
export function validarFormulario(form) {
    let primero = null;
    for (const input of form.querySelectorAll('[data-validar]')) {
        if (input.closest('.hidden') || input.disabled) continue;
        if (!validarCampo(input) && !primero) primero = input;
    }
    primero?.focus();
    return !primero;
}

/** Pinta los errores que devuelve el servidor ({ campo: mensaje }). */
export function erroresServidor(form, campos) {
    if (!campos) return;
    let primero = null;
    for (const [nombre, msg] of Object.entries(campos)) {
        const input = form.querySelector(`[name="${CSS.escape(nombre)}"]`);
        if (input) { mostrarError(input, msg); primero ||= input; }
    }
    primero?.focus();
}

export function limpiarErrores(form) {
    form.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
    form.querySelectorAll('[data-error-de]').forEach(e => { e.textContent = ''; });
}

/** Activa validación en vivo y filtros de teclado en todo el documento. */
export function activarValidacionEnVivo(raiz = document) {
    raiz.addEventListener('input', e => {
        const el = e.target;
        if (!el.dataset?.validar) return;
        if (SOLO_DIGITOS.has(el.dataset.validar) || el.dataset.validar === 'altitud') {
            const limpio = el.value.replace(/\D+/g, '');
            if (limpio !== el.value) el.value = limpio;
        } else if (DECIMALES.has(el.dataset.validar)) {
            let limpio = el.value.replace(',', '.').replace(el.dataset.validar === 'latitud' || el.dataset.validar === 'longitud' ? /[^\d.-]/g : /[^\d.]/g, '');
            const partes = limpio.split('.');
            if (partes.length > 2) limpio = `${partes.shift()}.${partes.join('')}`;
            if (limpio !== el.value) el.value = limpio;
        }
        if (el.getAttribute('aria-invalid') === 'true') validarCampo(el);
    });
    raiz.addEventListener('focusout', e => {
        const el = e.target;
        if (el.dataset?.validar && el.value !== '') validarCampo(el);
    });
}

export function datosFormulario(form) {
    const datos = {};
    for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === 'checkbox') datos[el.name] = el.checked;
        else datos[el.name] = el.type === 'password' ? el.value : el.value.trim();
    }
    return datos;
}
