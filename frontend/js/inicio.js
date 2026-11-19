// =====================================================================
//  Vista "Mi agua": métricas, lecturas, pago y registro de caudal
// =====================================================================
import { get, post, del } from './api.js';
import { estado, esPersonal, esAdmin } from './estado.js';
import { esc, soles, numero, fechaHora, toast, abrirModal, confirmar, conCarga, filaVacia } from './ui.js';
import { validarFormulario, erroresServidor, limpiarErrores, datosFormulario } from './validacion.js';
import { mostrarComprobante } from './comprobante.js';
import { pintarMiTurno } from './turnos.js';
import { abrirPago, marca } from './pagar.js';

let tipoComprobante = 'BOLETA';
let cotizacion = null;

export async function cargarInicio() {
    const id = estado.clienteId;
    if (!id) {
        document.getElementById('tbody-caudal').innerHTML = filaVacia(7, 'Registra un regante en el Panel de control para empezar.', 'fa-tractor');
        return;
    }
    const [cliente, lecturas, resumen, coti] = await Promise.all([
        get(`/clientes/${id}`),
        get(`/caudal?cliente_id=${id}`),
        get(`/caudal/resumen?cliente_id=${id}`),
        get(`/pagos/cotizacion?cliente_id=${id}`),
    ]);
    if (id !== estado.clienteId) return; // el usuario cambió de cliente mientras cargaba
    estado.cliente = cliente;
    cotizacion = coti;
    pintarMetricas(cliente, resumen, coti);
    pintarMiTurno();
    pintarLecturas(lecturas);
    pintarPago(cliente, coti);
}

function pintarMetricas(c, r, coti) {
    document.getElementById('inicio-titulo').textContent = esPersonal() ? c.nombre : `Hola, ${c.nombre.split(' ')[0]}`;
    document.getElementById('inicio-sub').textContent = `${c.tipo === 'empresa' ? 'RUC' : 'DNI'} ${c.documento} · ${c.ubicacion_sector || 'Sin sector'}`;
    document.getElementById('m-ha').innerHTML = `${numero(c.hectareas)}<small>ha</small>`;
    document.getElementById('m-cultivo').textContent = c.cultivo || '–';
    document.getElementById('m-lps').innerHTML = r.lps_ultimo != null ? `${numero(r.lps_ultimo)}<small>L/s</small>` : '–';
    document.getElementById('m-lps-fecha').textContent = r.fecha_ultima ? `Lectura del ${fechaHora(r.fecha_ultima)}` : 'Sin lecturas aún';
    document.getElementById('m-pend').innerHTML = `${numero(r.volumen_pendiente, 0)}<small>m³</small>`;
    document.getElementById('m-pend-sub').textContent = `${numero(r.volumen_total, 0)} m³ entregados en total`;
    document.getElementById('m-deuda').textContent = soles(coti.monto);
    const deuda = document.getElementById('m-deuda');
    deuda.classList.toggle('val-largo', soles(coti.monto).length > 11);
    const sub = document.getElementById('m-deuda-sub');
    sub.textContent = coti.lecturas ? `${coti.lecturas} lectura(s) sin pagar` : 'Estás al día';
    // Atajo: lleva al recuadro de pago
    if (coti.lecturas && coti.monto > 0 && !coti.en_validacion) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-arena btn-sm ir-pagar';
        b.innerHTML = '<i class="fa-solid fa-wallet"></i> Pagar ahora';
        b.addEventListener('click', () => {
            const panel = document.getElementById('panel-pago');
            panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            panel.classList.remove('resaltar'); void panel.offsetWidth; panel.classList.add('resaltar');
        });
        sub.append(document.createElement('br'), b);
    } else if (coti.en_validacion) {
        sub.textContent = 'Pago en validación';
    }
}

function pintarLecturas(lecturas) {
    const tbody = document.getElementById('tbody-caudal');
    document.getElementById('lecturas-cuenta').textContent = lecturas.length ? `${lecturas.length} registros` : '';
    if (!lecturas.length) {
        tbody.innerHTML = filaVacia(7, 'Todavía no hay lecturas del hidrómetro.', 'fa-gauge');
        return;
    }
    tbody.innerHTML = lecturas.map(l => `
        <tr>
            <td class="num">${esc(fechaHora(l.fecha))}</td>
            <td class="der num"><strong class="texto-agua">${numero(l.lps)}</strong> L/s</td>
            <td class="der num">${l.horas != null ? numero(l.horas) : '24'}</td>
            <td class="der num"><strong>${numero(l.volumen_m3)}</strong> m³</td>
            <td>${l.por_turno ? `<span class="chip ${l.estado === 'Almacenamiento' ? 'pendiente' : 'agua'} sin-punto">${esc(l.estado)}</span>` : `<span class="chip ${l.estado === 'Óptimo' ? 'optimo' : 'agua'}">Lectura · ${esc(l.estado)}</span>`}</td>
            <td>${l.pagado ? '<span class="chip ok sin-punto"><i class="fa-solid fa-check"></i> Pagado</span>' : '<span class="chip pendiente">Pendiente</span>'}</td>
            <td class="acciones solo-admin">${!l.pagado && esAdmin() ? `<button type="button" class="icon-btn danger" data-borrar-lectura="${Number(l.id)}" aria-label="Eliminar lectura"><i class="fa-regular fa-trash-can"></i></button>` : ''}</td>
        </tr>`).join('');
}

function pintarPago(c, coti) {
    document.getElementById('pago-tarifa').textContent = `S/ ${Number(coti.tarifa_m3).toFixed(4)} por m³`;
    const periodo = coti.periodo ? `${coti.periodo.desde} → ${coti.periodo.hasta}` : '–';
    document.getElementById('pago-cuenta').innerHTML = `
        <div class="cuenta-fila"><span>Periodo</span><span>${esc(periodo)}</span></div>
        <div class="cuenta-fila"><span>Volumen</span><span>${numero(coti.volumen_m3)} m³</span></div>
        <div class="cuenta-fila"><span>Operación gravada</span><span>${soles(coti.subtotal)}</span></div>
        <div class="cuenta-fila"><span>IGV (18 %)</span><span>${soles(coti.igv)}</span></div>
        <div class="cuenta-total"><span class="label">Total</span><span class="monto">${soles(coti.monto)}</span></div>`;

    const esEmpresa = c.tipo === 'empresa';
    const btnFactura = document.querySelector('#pago-tipo [data-tipo="FACTURA"]');
    btnFactura.disabled = !esEmpresa;
    if (!esEmpresa && tipoComprobante === 'FACTURA') seleccionarTipo('BOLETA');
    document.getElementById('pago-tipo-hint').textContent = esEmpresa ? 'Elige factura si necesitas crédito fiscal.' : 'La factura solo se emite a clientes con RUC.';

    const aviso = document.getElementById('pago-aviso');
    const btn = document.getElementById('btn-pagar');
    const btnCaja = document.getElementById('btn-pago-caja');
    const v = coti.en_validacion;
    const rech = coti.ultimo_rechazo;
    if (v) {
        aviso.innerHTML = `<div class="aviso agua estado-pago"><i class="fa-solid fa-hourglass-half"></i><span><strong>Pago en validación.</strong> Enviaste ${soles(v.monto)} por ${esc(marca(v.entidad).corto)} (op. <span class="mono">${esc(v.operacion)}</span>) el ${esc(v.enviado)}. La Junta lo revisará y emitirá tu comprobante.</span></div>`;
        btn.disabled = true; btnCaja.disabled = true;
    } else if (!coti.lecturas) {
        aviso.innerHTML = '<div class="aviso agua"><i class="fa-solid fa-circle-check"></i><span>No tienes consumo pendiente. Aparecerá aquí cuando se registren nuevas lecturas.</span></div>';
        btn.disabled = true; btnCaja.disabled = true;
    } else {
        aviso.innerHTML = rech ? `<div class="aviso peligro"><i class="fa-solid fa-circle-xmark"></i><span><strong>Tu último pago fue rechazado</strong> (${esc(rech.fecha)}): ${esc(rech.motivo_rechazo || 'sin detalle')}. Puedes volver a enviarlo.</span></div>` : '';
        btn.disabled = false; btnCaja.disabled = false;
    }
}

function seleccionarTipo(tipo) {
    tipoComprobante = tipo;
    document.querySelectorAll('#pago-tipo [data-tipo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tipo === tipo)));
}

async function pagar(boton) {
    await conCarga(boton, () => abrirPago({ cotizacion, tipo: tipoComprobante, alTerminar: () => cargarInicio() }), 'Abriendo…');
}

function pagoEnCaja() {
    const m = abrirModal(`
        <form id="form-caja" novalidate>
            <div class="modal-cab"><h3>Registrar pago en caja</h3></div>
            <div class="modal-cuerpo form-grid">
                <p>Se emitirá una <strong>${esc(tipoComprobante.toLowerCase())}</strong> por <strong>${soles(cotizacion?.monto)}</strong> a nombre de ${esc(estado.cliente?.nombre)}.</p>
                <div class="field">
                    <label for="caja-metodo">Medio de pago</label>
                    <select id="caja-metodo" name="metodo" class="select">
                        <option value="efectivo">Efectivo</option>
                        <option value="yape">Yape</option>
                        <option value="plin">Plin</option>
                        <option value="transferencia">Transferencia bancaria</option>
                        <option value="deposito">Depósito bancario</option>
                    </select>
                </div>
                <div class="field hidden" id="caja-ref-wrap">
                    <label for="caja-ref">Número de operación</label>
                    <input id="caja-ref" name="referencia" class="input mono" maxlength="40" placeholder="Ej. 00123456">
                    <span class="error" data-error-de="referencia"></span>
                </div>
            </div>
            <div class="modal-pie">
                <button type="button" class="btn btn-ghost" data-cerrar>Cancelar</button>
                <button type="submit" class="btn btn-arena" data-foco><i class="fa-solid fa-check"></i> Registrar pago</button>
            </div>
        </form>`);
    const form = m.el.querySelector('form');
    const sel = form.querySelector('#caja-metodo');
    sel.addEventListener('change', () => form.querySelector('#caja-ref-wrap').classList.toggle('hidden', sel.value === 'efectivo'));
    form.addEventListener('submit', async e => {
        e.preventDefault();
        limpiarErrores(form);
        const d = datosFormulario(form);
        if (d.metodo !== 'efectivo' && !/^[A-Za-z0-9-]{4,40}$/.test(d.referencia)) {
            return erroresServidor(form, { referencia: 'Entre 4 y 40 caracteres (letras, números o guiones).' });
        }
        try {
            const r = await conCarga(form.querySelector('[type=submit]'), () => post('/admin/pagos/manual', { ...d, cliente_id: estado.clienteId, tipo: tipoComprobante }));
            m.cerrar();
            toast(`Pago registrado: ${r.pago.numero}`, 'ok');
            mostrarComprobante(r.pago);
            cargarInicio();
        } catch (err) {
            erroresServidor(form, err.campos);
            toast(err.message, 'error');
        }
    });
}

async function guardarCaudal(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!validarFormulario(form)) return;
    const d = datosFormulario(form);
    try {
        await conCarga(form.querySelector('[type=submit]'), () => post('/caudal', {
            cliente_id: estado.clienteId, lps: Number(d.lps), fecha: d.fecha ? new Date(d.fecha).toISOString() : undefined,
        }));
        form.reset();
        actualizarConversion();
        toast('Lectura guardada.', 'ok');
        cargarInicio();
    } catch (err) {
        erroresServidor(form, err.campos);
        toast(err.message, 'error');
    }
}

function actualizarConversion() {
    const v = Number(document.getElementById('fc-lps').value);
    const hint = document.getElementById('fc-conv');
    hint.textContent = v > 0 ? `= ${numero(v * 3.6)} m³/h · ${numero(v * 3.6 * 24)} m³/día` : 'Se convierte a m³/h y m³/día automáticamente.';
}

export function iniciarInicio() {
    document.getElementById('pago-tipo').addEventListener('click', e => {
        const b = e.target.closest('[data-tipo]');
        if (b && !b.disabled) seleccionarTipo(b.dataset.tipo);
    });
    document.getElementById('btn-pagar').addEventListener('click', e => pagar(e.currentTarget));
    document.getElementById('btn-pago-caja').addEventListener('click', pagoEnCaja);
    document.getElementById('form-caudal').addEventListener('submit', guardarCaudal);
    document.getElementById('fc-lps').addEventListener('input', actualizarConversion);
    document.getElementById('fc-fecha').max = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('tbody-caudal').addEventListener('click', async e => {
        const b = e.target.closest('[data-borrar-lectura]');
        if (!b) return;
        const ok = await confirmar({ titulo: 'Eliminar lectura', mensaje: 'La lectura se borrará de forma permanente. Solo se pueden borrar lecturas no pagadas.', aceptar: 'Eliminar', peligro: true });
        if (!ok) return;
        try { await del(`/caudal/${b.dataset.borrarLectura}`); toast('Lectura eliminada.', 'ok'); cargarInicio(); } catch (err) { toast(err.message, 'error'); }
    });
}
