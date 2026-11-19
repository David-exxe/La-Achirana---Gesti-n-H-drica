// =====================================================================
//  Validación de entrada (servidor). Nunca confiar en el navegador.
// =====================================================================
const config = require('../Config/env');

class ErrorHttp extends Error {
    constructor(estado, mensaje, campos) {
        super(mensaje);
        this.estado = estado;
        this.campos = campos; // { campo: 'mensaje' }
    }
}

const RE = {
    dni: /^\d{8}$/,
    ruc: /^(10|15|16|17|20)\d{9}$/,
    email: /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/,
    pin: /^\d{6}$/,
    // Letras (con tildes/ñ), números, espacios y signos comunes en razones sociales
    nombre: /^[\p{L}\p{N} .,'&()\-/]+$/u,
    texto: /^[\p{L}\p{N} .,'&()\-/#°ºª:;+]+$/u,
};

/** Dígito verificador del RUC (módulo 11, SUNAT). */
/** Explica qué le falta a un correo (null si es válido). */
function problemaEmail(valor) {
    const e = String(valor || '').trim();
    if (!e) return 'Ingresa tu correo.';
    if (/\s/.test(e)) return 'El correo no puede tener espacios.';
    const partes = e.split('@');
    if (partes.length === 1) return 'Falta el @ (ejemplo: nombre@dominio.com).';
    if (partes.length > 2) return 'El correo solo puede tener un @.';
    const [usuario, dominio] = partes;
    if (!usuario) return 'Falta el nombre antes del @.';
    if (!dominio) return 'Falta el dominio después del @ (ejemplo: gmail.com).';
    if (!dominio.includes('.')) return 'Al dominio le falta la extensión (.com, .pe…).';
    if (!/\.[A-Za-z]{2,24}$/.test(dominio)) return 'La extensión del dominio no es válida.';
    if (!RE.email.test(e) || e.length > 120) return 'El correo tiene caracteres no permitidos.';
    return null;
}

function rucValido(ruc) {
    if (!RE.ruc.test(ruc)) return false;
    const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = pesos.reduce((acc, p, i) => acc + p * parseInt(ruc[i], 10), 0);
    let dv = 11 - (suma % 11);
    if (dv === 10) dv = 0;
    if (dv === 11) dv = 1;
    return dv === parseInt(ruc[10], 10);
}

/** Política de contraseña: 8-72, mayúscula, minúscula, número y símbolo. */
function problemaClave(clave) {
    if (typeof clave !== 'string' || clave.length < 8) return 'Mínimo 8 caracteres.';
    if (clave.length > 72) return 'Máximo 72 caracteres.';
    if (!/[A-Z]/.test(clave)) return 'Incluye al menos una mayúscula.';
    if (!/[a-z]/.test(clave)) return 'Incluye al menos una minúscula.';
    if (!/\d/.test(clave)) return 'Incluye al menos un número.';
    if (!/[^A-Za-z0-9]/.test(clave)) return 'Incluye al menos un símbolo (ej. # $ _ @).';
    return null;
}

// Normaliza texto y descarta objetos/arreglos (evita inyección de tipos: { "$ne": 1 }, [..])
const limpiar = v => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function entero(v, nombre = 'id') {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new ErrorHttp(400, `El ${nombre} no es válido.`);
    return n;
}

function validarCliente(body, { esEdicion = false } = {}) {
    const errores = {};
    const tipo = limpiar(body.tipo);
    const documento = limpiar(String(body.documento ?? ''));
    const nombre = limpiar(body.nombre ?? '');
    const sector = limpiar(body.ubicacion_sector ?? '');
    const cultivo = limpiar(body.cultivo ?? '');
    const hectareas = Number(body.hectareas);
    const pin = body.pin === undefined || body.pin === null ? '' : String(body.pin).trim();

    if (!['empresa', 'parcelero'].includes(tipo)) errores.tipo = 'Elige empresa (RUC) o parcelero (DNI).';

    if (tipo === 'parcelero' && !RE.dni.test(documento)) errores.documento = 'El DNI debe tener exactamente 8 dígitos.';
    if (tipo === 'empresa') {
        if (!RE.ruc.test(documento)) errores.documento = 'El RUC debe tener 11 dígitos y empezar con 10, 15, 16, 17 o 20.';
        else if (config.validarDigitoRuc && !rucValido(documento)) errores.documento = 'El dígito verificador del RUC no es correcto.';
    }

    if (nombre.length < 3 || nombre.length > 100) errores.nombre = 'Entre 3 y 100 caracteres.';
    else if (!RE.nombre.test(nombre)) errores.nombre = 'Contiene caracteres no permitidos.';

    if (!Number.isFinite(hectareas) || hectareas <= 0) errores.hectareas = 'Debe ser mayor que 0.';
    else if (hectareas > 99999999) errores.hectareas = 'Valor demasiado grande.';
    else if (Math.round(hectareas * 100) / 100 !== hectareas) errores.hectareas = 'Máximo 2 decimales.';

    if (sector.length < 2 || sector.length > 150) errores.ubicacion_sector = 'Entre 2 y 150 caracteres.';
    else if (!RE.texto.test(sector)) errores.ubicacion_sector = 'Contiene caracteres no permitidos.';

    if (cultivo.length < 2 || cultivo.length > 100) errores.cultivo = 'Entre 2 y 100 caracteres.';
    else if (!RE.nombre.test(cultivo)) errores.cultivo = 'Contiene caracteres no permitidos.';

    if (pin && !RE.pin.test(pin)) errores.pin = 'El código de acceso debe tener 6 dígitos.';
    if (pin && /^(\d)\1{5}$|^123456$|^654321$/.test(pin)) errores.pin = 'Elige un código menos predecible.';

    // Almacenamiento en reservorio: solo fundos/empresas
    const almacena = tipo === 'empresa' && body.almacena === true;
    let capacidad = null;
    const capRaw = body.capacidad_reservorio_m3;
    if (almacena && capRaw !== undefined && capRaw !== null && capRaw !== '') {
        capacidad = Number(capRaw);
        if (!Number.isFinite(capacidad) || capacidad <= 0) errores.capacidad_reservorio_m3 = 'Debe ser mayor que 0 (o déjalo vacío).';
        else if (capacidad > 1e9) errores.capacidad_reservorio_m3 = 'Valor demasiado grande.';
        else capacidad = Math.round(capacidad * 100) / 100;
    }

    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    return { tipo, documento, nombre, hectareas, ubicacion_sector: sector, cultivo, pin: pin || null, almacena, capacidad_reservorio_m3: almacena ? capacidad : null, esEdicion };
}

function validarUsuario(body, { esEdicion = false } = {}) {
    const errores = {};
    const nombre = limpiar(body.nombre ?? '');
    const email = limpiar(body.email ?? '').toLowerCase();
    const pass = body.pass ?? '';
    const rol = body.rol ? limpiar(body.rol) : 'admin';

    if (nombre.length < 2 || nombre.length > 100) errores.nombre = 'Entre 2 y 100 caracteres.';
    else if (!/^[\p{L} .'-]+$/u.test(nombre)) errores.nombre = 'Solo letras y espacios.';
    if (!RE.email.test(email) || email.length > 100) errores.email = 'Correo no válido.';
    if (!['admin', 'operador', 'gerente'].includes(rol)) errores.rol = 'Rol no válido.';
    // En edición la contraseña es opcional (si se deja vacía no se cambia)
    if (!esEdicion || pass) {
        const p = problemaClave(pass);
        if (p) errores.pass = p;
    }
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    return { nombre, email, pass: pass || null, rol };
}

function validarCaudal(body) {
    const errores = {};
    const lps = Number(body.lps);
    if (!Number.isFinite(lps) || lps <= 0) errores.lps = 'Ingresa un caudal mayor que 0.';
    else if (lps > 5000) errores.lps = 'Valor fuera de rango (máx. 5000 L/s).';
    else if (Math.round(lps * 100) / 100 !== lps) errores.lps = 'Máximo 2 decimales.';
    let fecha = null;
    if (body.fecha) {
        const f = new Date(body.fecha);
        if (Number.isNaN(f.getTime())) errores.fecha = 'Fecha no válida.';
        else if (f.getTime() > Date.now() + 5 * 60 * 1000) errores.fecha = 'La fecha no puede ser futura.';
        else fecha = f;
    }
    if (Object.keys(errores).length) throw new ErrorHttp(400, 'Revisa los campos marcados.', errores);
    return { cliente_id: entero(body.cliente_id, 'cliente'), lps, fecha };
}

function validarFecha(v) {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) {
        throw new ErrorHttp(400, 'Formato de fecha inválido (AAAA-MM-DD).');
    }
    return v;
}

module.exports = {
    ErrorHttp, RE, rucValido, problemaEmail, problemaClave, limpiar, entero,
    validarCliente, validarUsuario, validarCaudal, validarFecha,
};
