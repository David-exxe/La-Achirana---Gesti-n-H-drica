// =====================================================================
//  Vista "Pagos y comprobantes"
// =====================================================================
import { get } from './api.js';
import { estado, esStaff } from './estado.js';
import { esc, soles, fechaHora, chipEstado, filaVacia, toast, MEDIOS } from './ui.js';
import { marca } from './pagar.js';
import { verVoucher } from './voucher.js';
import { mostrarComprobante } from './comprobante.js';

let filtro = 'todos';

export async function cargarPagos() {
    const todos = esStaff() && document.getElementById('pagos-todos').checked;
    const params = new URLSearchParams({ filtro });
    if (!todos && estado.clienteId) params.set('cliente_id', estado.clienteId);
    const datos = await get(`/pagos?${params}`);
    document.querySelectorAll('.col-cliente').forEach(c => c.classList.toggle('hidden', !todos));
    document.getElementById('pagos-sub').textContent = todos
        ? 'Movimientos de todos los regantes.'
        : `Historial de pagos${estado.cliente ? ` de ${estado.cliente.nombre}` : ''}. Descarga el comprobante de cada pago aprobado.`;

    const aprobados = datos.pagos.filter(p => p.estado === 'aprobado');
    const pendientes = datos.pagos.filter(p => p.estado === 'validacion');
    const m3 = aprobados.reduce((s, p) => s + Number(p.volumen_m3 || 0), 0);
    document.getElementById('metricas-pagos').innerHTML = `
        <div class="metrica destacada"><div class="etq">Total pagado</div><div class="val">${soles(datos.totalAcumulado)}</div><div class="sub">En el periodo elegido</div></div>
        <div class="metrica"><div class="etq">Comprobantes emitidos</div><div class="val">${aprobados.length}</div><div class="sub">${aprobados.filter(p => p.tipo === 'FACTURA').length} facturas · ${aprobados.filter(p => p.tipo === 'BOLETA').length} boletas</div></div>
        <div class="metrica"><div class="etq">Volumen pagado</div><div class="val">${Math.round(m3).toLocaleString('es-PE')}<small>m³</small></div><div class="sub">Agua liquidada</div></div>
        <div class="metrica"><div class="etq">En validación</div><div class="val">${pendientes.length}</div><div class="sub">Constancias por revisar</div></div>`;

    const tbody = document.getElementById('tbody-pagos');
    if (!datos.pagos.length) {
        tbody.innerHTML = filaVacia(8, 'No hay pagos en este periodo.', 'fa-receipt');
        return;
    }
    tbody.innerHTML = datos.pagos.map(p => `
        <tr>
            <td class="num">${esc(fechaHora(p.fecha))}</td>
            <td class="col-cliente ${todos ? '' : 'hidden'}">${esc(p.cliente_nombre)}<div class="small muted num">${esc(p.cliente_doc)}</div></td>
            <td><strong>${esc(p.tipo === 'FACTURA' ? 'Factura' : 'Boleta')}</strong><div class="small muted num">${esc(p.numero || '—')}</div></td>
            <td style="max-width:340px">${esc(p.concepto)}${p.motivo && p.estado !== 'aprobado' ? `<div class="small texto-peligro">${esc(p.motivo)}</div>` : ''}</td>
            <td>${esc(p.entidad && !p.entidad.startsWith('caja') ? marca(p.entidad).corto : (MEDIOS[p.metodo] || p.metodo))}${p.operacion ? `<div class="small muted num">Op. ${esc(p.operacion)}</div>` : ''}</td>
            <td>${chipEstado(p.estado)}</td>
            <td class="der num"><strong>${soles(p.monto)}</strong></td>
            <td class="acciones">${p.estado === 'aprobado' ? `<button type="button" class="btn btn-ghost btn-sm" data-comprobante="${Number(p.id)}"><i class="fa-regular fa-file-lines"></i> Ver</button>` : ''}${['yape', 'plin', 'transferencia'].includes(p.metodo) && p.operacion && !String(p.entidad || '').startsWith('caja') ? `<button type="button" class="icon-btn" data-voucher="${Number(p.id)}" aria-label="Ver constancia"><i class="fa-regular fa-image"></i></button>` : ''}</td>
        </tr>`).join('');
}

export function iniciarPagos() {
    document.getElementById('filtro-pagos').addEventListener('click', e => {
        const b = e.target.closest('[data-filtro]');
        if (!b) return;
        filtro = b.dataset.filtro;
        document.querySelectorAll('#filtro-pagos [data-filtro]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        cargarPagos().catch(err => toast(err.message, 'error'));
    });
    document.getElementById('pagos-todos').addEventListener('change', () => cargarPagos().catch(err => toast(err.message, 'error')));
    document.getElementById('tbody-pagos').addEventListener('click', async e => {
        const vb = e.target.closest('[data-voucher]');
        if (vb) return verVoucher(Number(vb.dataset.voucher));
        const b = e.target.closest('[data-comprobante]');
        if (!b) return;
        try { mostrarComprobante(await get(`/pagos/${b.dataset.comprobante}/comprobante`)); } catch (err) { toast(err.message, 'error'); }
    });
}
