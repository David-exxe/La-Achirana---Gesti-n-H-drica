// =====================================================================
//  Cliente HTTP de la API
//  Si abres el frontend desde Live Server (puerto 5500), apunta al backend 3000.
// =====================================================================
const BASE = ['5500', '5501', '8080'].includes(location.port) ? `${location.protocol}//${location.hostname}:3000/api` : '/api';
const CLAVE = 'achirana_token';

export class ErrorApi extends Error {
    constructor(mensaje, estado, campos) {
        super(mensaje);
        this.estado = estado;
        this.campos = campos || null;
    }
}

// sessionStorage: la sesión se borra al cerrar la pestaña
export const token = {
    obtener() { try { return sessionStorage.getItem(CLAVE); } catch { return null; } },
    guardar(t) { try { sessionStorage.setItem(CLAVE, t); } catch { /* sin almacenamiento */ } },
    borrar() { try { sessionStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ } },
};

export async function api(metodo, ruta, cuerpo) {
    const cabeceras = { Accept: 'application/json' };
    if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
    const t = token.obtener();
    if (t) cabeceras.Authorization = `Bearer ${t}`;

    let resp;
    try {
        resp = await fetch(BASE + ruta, { method: metodo, headers: cabeceras, body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined });
    } catch {
        throw new ErrorApi('No se pudo conectar con el servidor. Verifica que el backend esté encendido (npm start).', 0);
    }
    let datos = null;
    try { datos = await resp.json(); } catch { /* respuesta vacía */ }

    if (!resp.ok) {
        if (resp.status === 401 && t) window.dispatchEvent(new CustomEvent('sesion-expirada', { detail: datos?.error }));
        throw new ErrorApi(datos?.error || `Error ${resp.status}`, resp.status, datos?.campos);
    }
    return datos;
}

export const get = ruta => api('GET', ruta);
export const post = (ruta, cuerpo = {}) => api('POST', ruta, cuerpo);
export const put = (ruta, cuerpo = {}) => api('PUT', ruta, cuerpo);
export const del = ruta => api('DELETE', ruta);
