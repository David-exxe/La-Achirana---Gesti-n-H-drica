// Muestra la constancia (voucher) de un pago. La imagen se pide con el token y se muestra como blob.
import { token } from './api.js';
import { abrirModal, toast, esc } from './ui.js';

const BASE = ['5500', '5501', '8080'].includes(location.port) ? `${location.protocol}//${location.hostname}:3000/api` : '/api';

export async function urlVoucher(id) {
    const r = await fetch(`${BASE}/pagos/${id}/voucher`, { headers: { Authorization: `Bearer ${token.obtener()}` } });
    if (!r.ok) throw new Error(r.status === 404 ? 'Este pago no tiene constancia adjunta.' : 'No se pudo cargar la constancia.');
    return URL.createObjectURL(await r.blob());
}

export async function verVoucher(id, titulo = 'Constancia de pago') {
    try {
        const url = await urlVoucher(id);
        abrirModal(`
            <div class="modal-cab"><h3>${esc(titulo)}</h3></div>
            <div class="modal-cuerpo voucher-grande"><img src="${url}" alt="Constancia de pago"></div>
            <div class="modal-pie"><a class="btn btn-ghost" href="${url}" download="constancia-${Number(id)}.jpg"><i class="fa-solid fa-download"></i> Descargar</a><button type="button" class="btn btn-primary" data-cerrar data-foco>Cerrar</button></div>`,
        { alCerrar: () => setTimeout(() => URL.revokeObjectURL(url), 1000) });
    } catch (err) { toast(err.message, 'error'); }
}
