// =====================================================================
//  Panel de control (solo administradores)
// =====================================================================
import { get, post, put, del } from './api.js';
import { estado } from './estado.js';
import { esc, soles, numero, entero, fechaHora, toast, confirmar, conCarga, filaVacia, NIVEL, abrirModal } from './ui.js';
import { tarjetaMedio, marca } from './pagar.js';
import { urlVoucher, verVoucher } from './voucher.js';
import { mostrarComprobante } from './comprobante.js';
import { validarFormulario, erroresServidor, limpiarErrores, datosFormulario } from './validacion.js';

let tab = 'clientes';
let clientesCache = [];
let usuariosCache = [];
let puntosCache = [];
let alRecargarClientes = () => {};

export async function cargarAdmin() {
    await Promise.all([pintarMetricas(), cargarTab(tab)]);
}

async function pintarMetricas() {
    const r = await get('/admin/recaudacion-total');
    document.getElementById('metricas-admin').innerHTML = `
        <div class="metrica destacada"><div class="etq">Recaudado este mes</div><div class="val">${soles(r.mes)}</div><div class="sub">Hoy: ${soles(r.hoy)}</div></div>
        <div class="metrica"><div class="etq">Recaudación histórica</div><div class="val">${soles(r.total)}</div><div class="sub">Pagos aprobados</div></div>
        <div class="metrica"><div class="etq">Por cobrar</div><div class="val">${soles(r.por_cobrar)}</div><div class="sub">Consumo pendiente a S/ ${Number(r.tarifa_m3).toFixed(4)}/m³</div></div>
        <div class="metrica"><div class="etq">Pagos por validar</div><div class="val">${r.pendientes}</div><div class="sub">${r.pendientes ? '<button type="button" class="enlace" data-ir-tab="validar">Revisar ahora →</button>' : 'Nada pendiente'}</div></div>`;
    const badge = document.getElementById('badge-validar');
    badge.textContent = r.pendientes;
    badge.classList.toggle('hidden', !r.pendientes);
}

async function cargarTab(nombre) {
    tab = nombre;
    document.querySelectorAll('#admin-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === nombre)));
    document.querySelectorAll('[data-tabpanel]').forEach(p => p.classList.toggle('hidden', p.dataset.tabpanel !== nombre));
    if (nombre === 'clientes') await cargarClientes();
    if (nombre === 'usuarios') await cargarUsuarios();
    if (nombre === 'tarifa') await cargarTarifa();
    if (nombre === 'riego') await cargarRiego();
    if (nombre === 'validar') await cargarValidar();
    if (nombre === 'medios') await cargarCuentas();
    if (nombre === 'puntos') await cargarPuntos();
    if (nombre === 'auditoria') await cargarAuditoria();
    if (nombre === 'integraciones') await cargarIntegraciones();
}

// ---------------- Integraciones ----------------
const filaInt = (ok, texto, neutro = false) => `<li class="${neutro ? 'neutro' : ok ? 'ok' : 'mal'}"><i class="fa-solid ${neutro ? 'fa-circle-info' : ok ? 'fa-circle-check' : 'fa-circle-xmark'}"></i><span>${esc(texto)}</span></li>`;
const chipInt = (el, ok, txt) => { el.textContent = txt; el.className = `chip ${ok ? 'ok' : 'nivel-naranja'}`; };

async function cargarIntegraciones() {
    await Promise.all([estadoCorreo(), diagnosticoCulqi()]);
}

async function estadoCorreo() {
    const e = await get('/admin/correo/estado');
    chipInt(document.getElementById('int-correo-estado'), e.ok, e.ok ? 'Activo' : e.configurado ? 'Revisar' : 'Desactivado');
    document.getElementById('int-correo-lista').innerHTML = [
        filaInt(e.configurado, e.configurado ? `Microservicio: ${e.url}` : 'Microservicio sin conectar'),
        e.proveedor ? filaInt(e.proveedor !== 'consola', `Proveedor: ${e.proveedor}${e.proveedor === 'consola' ? ' (solo registra, no envía)' : ''}`) : '',
        e.remitente ? filaInt(true, `Remitente: ${e.remitente}`) : '',
        filaInt(e.destinatarios > 0, e.destinatarios ? `${e.destinatarios} correo(s) de la Junta` : 'Falta el correo de la Junta'),
        e.problema ? filaInt(false, e.problema) : '',
    ].join('');
}

async function diagnosticoCulqi() {
    const d = await get('/admin/culqi/diagnostico');
    chipInt(document.getElementById('int-culqi-estado'), d.listo, d.listo ? (d.modo === 'prueba' ? 'Prueba OK' : 'Producción OK') : d.activo ? 'Revisar' : 'Modo demo');
    document.getElementById('int-culqi-lista').innerHTML = d.chequeos.map(c => filaInt(c.ok, c.detalle, c.id === 'rsa')).join('')
        + (!d.activo ? filaInt(true, 'Sin llaves: se usa el cobro de demostración (no cobra).', true) : '');
    document.getElementById('int-culqi-tarjetas').innerHTML = d.tarjetasPrueba.length
        ? `<div class="tarjetas-prueba">${d.tarjetasPrueba.map(t => `<div><strong>${esc(t.marca)}</strong><span class="mono">${esc(t.numero)}</span><small>${esc(t.vence)} · CVV ${esc(t.cvv)}</small></div>`).join('')}</div>` : '';
}

// ---------------- Regantes ----------------
async function cargarClientes() {
    clientesCache = await get('/clientes');
    pintarClientes();
}

function pintarClientes() {
    const q = document.getElementById('buscar-cliente').value.trim().toLowerCase();
    const lista = clientesCache.filter(c => !q || c.nombre.toLowerCase().includes(q) || c.documento.includes(q));
    const tbody = document.getElementById('tbody-clientes');
    if (!lista.length) { tbody.innerHTML = filaVacia(6, q ? 'Ningún regante coincide con la búsqueda.' : 'Aún no hay regantes registrados.', 'fa-tractor'); return; }
    tbody.innerHTML = lista.map(c => `
        <tr>
            <td class="num">${esc(c.documento)}<div class="small muted">${c.tipo === 'empresa' ? 'RUC' : 'DNI'}</div></td>
            <td><strong>${esc(c.nombre)}</strong><div class="small muted">${esc(c.ubicacion_sector || '')} · ${esc(c.cultivo || '')}</div></td>
            <td class="der num">${numero(c.hectareas)} ha</td>
            <td>${c.tiene_pin ? '<span class="chip ok">Asignado</span>' : '<span class="chip pendiente">Sin código</span>'}</td>
            <td>${c.activo ? '<span class="chip agua">Activo</span>' : '<span class="chip anulado">Inactivo</span>'}</td>
            <td class="acciones">
                <button type="button" class="icon-btn" data-editar-cliente="${Number(c.id)}" aria-label="Editar ${esc(c.nombre)}"><i class="fa-regular fa-pen-to-square"></i></button>
                ${c.activo
                    ? `<button type="button" class="icon-btn danger" data-borrar-cliente="${Number(c.id)}" aria-label="Eliminar ${esc(c.nombre)}"><i class="fa-regular fa-trash-can"></i></button>`
                    : `<button type="button" class="icon-btn" data-reactivar-cliente="${Number(c.id)}" aria-label="Reactivar ${esc(c.nombre)}"><i class="fa-solid fa-rotate-left"></i></button>`}
            </td>
        </tr>`).join('');
}

function ajustarDocumento() {
    const tipo = document.getElementById('fcl-tipo').value;
    const doc = document.getElementById('fcl-doc');
    const esRuc = tipo === 'empresa';
    doc.dataset.validar = esRuc ? 'ruc' : 'dni';
    doc.maxLength = esRuc ? 11 : 8;
    doc.placeholder = esRuc ? '11 dígitos' : '8 dígitos';
    doc.closest('.field').querySelector('label').textContent = esRuc ? 'RUC' : 'DNI';
    document.getElementById('fcl-nombre').placeholder = esRuc ? 'Ej. Agrícola San Juan S.A.C.' : 'Ej. María Quispe Huamán';
    if (doc.value) doc.dispatchEvent(new Event('focusout', { bubbles: true }));
    // Solo los fundos/empresas pueden almacenar
    document.getElementById('fcl-alm-wrap').classList.toggle('hidden', !esRuc);
    if (!esRuc) document.getElementById('fcl-almacena').checked = false;
    ajustarAlmacen();
}

function ajustarAlmacen() {
    const on = document.getElementById('fcl-almacena').checked;
    document.getElementById('fcl-cap-wrap').classList.toggle('hidden', !on);
    if (!on) document.getElementById('fcl-cap').value = '';
}

function editarCliente(id) {
    const c = clientesCache.find(x => x.id === id);
    if (!c) return;
    const f = document.getElementById('form-cliente');
    limpiarErrores(f);
    f.rid.value = c.id; f.tipo.value = c.tipo; ajustarDocumento();
    f.documento.value = c.documento; f.nombre.value = c.nombre; f.hectareas.value = c.hectareas;
    f.ubicacion_sector.value = c.ubicacion_sector || ''; f.cultivo.value = c.cultivo || ''; f.pin.value = '';
    f.quitar_pin.checked = false;
    f.almacena.checked = Boolean(c.almacena);
    f.capacidad_reservorio_m3.value = c.capacidad_reservorio_m3 ?? '';
    ajustarDocumento();
    document.getElementById('fcl-quitar-pin-wrap').classList.toggle('hidden', !c.tiene_pin);
    document.getElementById('fcl-titulo').textContent = `Editar: ${c.nombre}`;
    f.querySelector('[type=submit] span').textContent = 'Guardar cambios';
    f.nombre.focus();
}

function reiniciarFormCliente() {
    const f = document.getElementById('form-cliente');
    f.reset(); f.rid.value = '';
    limpiarErrores(f);
    ajustarDocumento();
    document.getElementById('fcl-quitar-pin-wrap').classList.add('hidden');
    document.getElementById('fcl-titulo').textContent = 'Nuevo regante';
    f.querySelector('[type=submit] span').textContent = 'Guardar regante';
}

async function guardarCliente(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    const cuerpo = { ...d, hectareas: Number(d.hectareas), pin: d.pin || null, capacidad_reservorio_m3: d.capacidad_reservorio_m3 ? Number(d.capacidad_reservorio_m3) : null };
    delete cuerpo.rid;
    try {
        await conCarga(f.querySelector('[type=submit]'), () => (d.rid ? put(`/admin/clientes/${d.rid}`, cuerpo) : post('/admin/clientes', cuerpo)));
        toast(d.rid ? 'Regante actualizado.' : 'Regante registrado.', 'ok');
        reiniciarFormCliente();
        await cargarClientes();
        alRecargarClientes();
    } catch (err) {
        erroresServidor(f, err.campos);
        toast(err.message, 'error');
    }
}

// ---------------- Personal ----------------
async function cargarUsuarios() {
    usuariosCache = await get('/admin/usuarios');
    const tbody = document.getElementById('tbody-usuarios');
    tbody.innerHTML = usuariosCache.map(u => `
        <tr>
            <td><strong>${esc(u.nombre)}</strong>${u.id === estado.sesion.datos.id ? ' <span class="chip agua sin-punto">Tú</span>' : ''}</td>
            <td>${esc(u.email)}</td>
            <td>${({ admin: 'Administrador', operador: 'Operador', gerente: 'Gerente' })[u.rol] || esc(u.rol)}</td>
            <td class="small muted">${u.ultimo_acceso ? esc(fechaHora(u.ultimo_acceso)) : 'Nunca'}</td>
            <td class="acciones">
                <button type="button" class="icon-btn" data-editar-usuario="${Number(u.id)}" aria-label="Editar ${esc(u.nombre)}"><i class="fa-regular fa-pen-to-square"></i></button>
                ${u.id !== estado.sesion.datos.id ? `<button type="button" class="icon-btn danger" data-borrar-usuario="${Number(u.id)}" aria-label="Eliminar ${esc(u.nombre)}"><i class="fa-regular fa-trash-can"></i></button>` : ''}
            </td>
        </tr>`).join('') || filaVacia(5, 'Sin personal registrado.');
}

function editarUsuario(id) {
    const u = usuariosCache.find(x => x.id === id);
    if (!u) return;
    const f = document.getElementById('form-usuario');
    limpiarErrores(f);
    f.rid.value = u.id; f.nombre.value = u.nombre; f.email.value = u.email; f.rol.value = u.rol; f.pass.value = '';
    f.pass.dataset.opcional = 'true';
    document.getElementById('fu-pass-hint').textContent = 'Déjala vacía para mantener la actual.';
    document.getElementById('fu-titulo').textContent = `Editar: ${u.nombre}`;
    f.nombre.focus();
}

function reiniciarFormUsuario() {
    const f = document.getElementById('form-usuario');
    f.reset(); f.rid.value = ''; f.pass.dataset.opcional = 'false';
    limpiarErrores(f);
    document.getElementById('fu-pass-hint').textContent = 'Mínimo 8 caracteres con mayúscula, minúscula, número y símbolo.';
    document.getElementById('fu-titulo').textContent = 'Nuevo miembro del personal';
}

async function guardarUsuario(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    const cuerpo = { nombre: d.nombre, email: d.email, rol: d.rol, pass: d.pass || undefined };
    try {
        await conCarga(f.querySelector('[type=submit]'), () => (d.rid ? put(`/admin/usuarios/${d.rid}`, cuerpo) : post('/admin/usuarios', cuerpo)));
        toast(d.rid ? 'Datos actualizados.' : 'Usuario creado.', 'ok');
        reiniciarFormUsuario();
        cargarUsuarios();
    } catch (err) {
        erroresServidor(f, err.campos);
        toast(err.message, 'error');
    }
}

// ---------------- Tarifa ----------------
async function cargarTarifa() {
    const t = await get('/tarifa');
    document.getElementById('ft-precio').placeholder = Number(t.precio_m3).toFixed(4);
    document.getElementById('tbody-tarifas').innerHTML = t.historial.map((h, i) => `
        <tr>
            <td class="num">${esc(h.desde)}${i === 0 ? ' <span class="chip ok">Vigente</span>' : ''}</td>
            <td class="der num"><strong>${Number(h.precio_m3).toFixed(4)}</strong></td>
            <td>${esc(h.motivo || '–')}</td>
            <td>${esc(h.por || 'Sistema')}</td>
        </tr>`).join('');
}

async function guardarTarifa(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    const ok = await confirmar({ titulo: 'Cambiar tarifa', mensaje: `La nueva tarifa será S/ ${Number(d.precio_m3).toFixed(4)} por m³ y se aplicará a los próximos cobros.`, aceptar: 'Aplicar tarifa' });
    if (!ok) return;
    try {
        await post('/admin/tarifa', { precio_m3: Number(d.precio_m3), motivo: d.motivo });
        toast('Tarifa actualizada.', 'ok');
        f.reset();
        cargarTarifa(); pintarMetricas();
    } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error'); }
}

// ---------------- Cupos y riego (parámetros del reparto) ----------------
async function cargarRiego() {
    const [p, dem] = await Promise.all([get('/admin/riego/parametros'), get('/turnos/demandas')]);
    const f = document.getElementById('form-riego');
    f.dotacion_m3_ha.value = Number(p.dotacion_m3_ha);
    f.adicional_pct_parcelero.value = Number(p.adicional_pct_parcelero);
    f.adicional_pct_fundo.value = Number(p.adicional_pct_fundo);
    f.tope_pct_parcelero.value = Number(p.tope_pct_parcelero);
    f.tope_pct_fundo.value = Number(p.tope_pct_fundo);
    f.prioridad_adicional.value = p.prioridad_adicional;
    f.dias_almacenamiento.value = p.dias_almacenamiento;
    f.canal_capacidad_lps.value = Number(p.canal_capacidad_lps);
    f.reservorio_junta_m3.value = Number(p.reservorio_junta_m3);
    actualizarEjemploDotacion();
    document.getElementById('fr-factores').innerHTML = p.factores.length
        ? p.factores.map((x, i) => `
            <label class="factor-fila" for="fr-f-${i}"><span>${esc(x.cultivo)}</span>
                <input id="fr-f-${i}" class="input mono" inputmode="decimal" data-cultivo="${esc(x.cultivo)}" value="${Number(x.factor).toFixed(2)}" aria-label="Factor de ${esc(x.cultivo)}"></label>`).join('')
        : '<p class="small muted">Los cultivos aparecen aquí al registrar regantes.</p>';
    const total = dem.reduce((s, c) => s + c.cupo_base_m3, 0);
    const maximo = dem.reduce((s, c) => s + c.maximo_m3, 0);
    document.getElementById('tbody-demandas').innerHTML = dem.map(c => `
        <tr>
            <td><strong>${esc(c.nombre)}</strong><div class="small muted">${c.tipo === 'empresa' ? 'Fundo' : 'Parcelero'} · ${esc(c.cultivo || '–')}${c.almacena ? ' · almacena' : ''}</div></td>
            <td class="der num">${numero(c.hectareas)} ha</td>
            <td class="der num">${Number(c.factor).toFixed(2)}</td>
            <td class="der num"><strong>${entero(c.cupo_base_m3)}</strong> m³</td>
            <td class="der num">+${entero(c.adicional_m3)} m³<div class="small muted">${numero(c.adicional_pct)} %</div></td>
            <td class="der num"><strong class="texto-arena">${entero(c.maximo_m3)}</strong> m³</td>
            <td class="der num">${numero(c.tope_pct)} %<div class="small muted">${c.tope_canal_m3 ? `${entero(c.tope_canal_m3)} m³ hoy` : 'sin caudal'}</div></td>
        </tr>`).join('') + (dem.length ? `<tr class="fila-total"><td colspan="3"><strong>Total diario</strong><div class="small muted">Caudal necesario las 24 h: ${numero(total / 86.4)} L/s (máximo ${numero(maximo / 86.4)} L/s)</div></td><td class="der num"><strong>${entero(total)}</strong> m³</td><td></td><td class="der num"><strong>${entero(maximo)}</strong> m³</td><td></td></tr>` : '');
}

function actualizarEjemploDotacion() {
    const f = document.getElementById('form-riego');
    const d = Number(f.dotacion_m3_ha.value) || 0;
    const ap = Number(f.adicional_pct_parcelero.value) || 0;
    const base = 5 * d;
    document.getElementById('fr-dotacion-hint').textContent = d > 0
        ? `Ej.: un parcelero de 5 ha recibe ${entero(base)} m³/día de cupo base y puede comprar o almacenar hasta ${entero(base * ap / 100)} m³ más (${numero(ap)} %): máximo ${entero(base * (1 + ap / 100))} m³.`
        : 'Cupo base = hectáreas × dotación × factor del cultivo.';
}

async function guardarRiego(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const factores = [];
    let mal = null;
    f.querySelectorAll('[data-cultivo]').forEach(inp => {
        const v = Number(inp.value.replace(',', '.'));
        const ok = Number.isFinite(v) && v >= 0.1 && v <= 3;
        inp.setAttribute('aria-invalid', String(!ok));
        if (!ok) mal ||= inp; else factores.push({ cultivo: inp.dataset.cultivo, factor: v });
    });
    if (mal) { mal.focus(); return toast('Cada factor debe estar entre 0.10 y 3.00.', 'aviso'); }
    const n = k => Number(f[k].value);
    try {
        await conCarga(f.querySelector('[type=submit]'), () => put('/admin/riego/parametros', {
            dotacion_m3_ha: n('dotacion_m3_ha'), dias_almacenamiento: n('dias_almacenamiento'), prioridad_adicional: f.prioridad_adicional.value,
            adicional_pct_parcelero: n('adicional_pct_parcelero'), adicional_pct_fundo: n('adicional_pct_fundo'),
            tope_pct_parcelero: n('tope_pct_parcelero'), tope_pct_fundo: n('tope_pct_fundo'),
            canal_capacidad_lps: n('canal_capacidad_lps'), reservorio_junta_m3: n('reservorio_junta_m3'), factores,
        }));
        toast('Parámetros guardados. Se aplican al generar o recalcular turnos.', 'ok', 6000);
        cargarRiego();
    } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error'); }
}

// ---------------- Pagos por validar ----------------
const urlsVoucher = new Map();
async function cargarValidar() {
    const lista = await get('/admin/pagos/por-validar');
    const cont = document.getElementById('validar-lista');
    urlsVoucher.forEach(u => URL.revokeObjectURL(u)); urlsVoucher.clear();
    if (!lista.length) {
        cont.innerHTML = '<div class="vacio-grande"><i class="fa-solid fa-circle-check"></i><strong>No hay pagos por validar</strong><span>Cuando un regante envíe la constancia de su Yape, Plin o transferencia aparecerá aquí.</span></div>';
        return;
    }
    cont.innerHTML = lista.map(p => {
        const mk = marca(p.entidad);
        const espera = Number(p.horas_espera);
        return `<article class="validar-card" data-pago="${Number(p.id)}">
            <button type="button" class="validar-img ${p.tiene_voucher ? '' : 'sin'}" data-ver-voucher="${Number(p.id)}" aria-label="Ampliar constancia">
                ${p.tiene_voucher ? '<i class="fa-solid fa-spinner spin"></i>' : '<i class="fa-regular fa-image"></i><span>Sin captura</span>'}
            </button>
            <div class="validar-info">
                <div class="fila-flex"><span class="medio-chip ${mk.clase}">${esc(mk.corto)}</span><span class="espacio"></span>
                    <span class="chip ${espera > 24 ? 'rechazado' : 'pendiente'}">${espera < 1 ? 'Hace minutos' : `Hace ${numero(espera, 0)} h`}</span></div>
                <h4>${esc(p.cliente_nombre)}</h4>
                <div class="small muted">${p.cliente_tipo === 'empresa' ? 'RUC' : 'DNI'} ${esc(p.cliente_doc)} · ${p.tipo === 'FACTURA' ? 'Factura' : 'Boleta'}</div>
                <dl class="validar-datos">
                    <div><dt>Monto</dt><dd class="num"><strong>${soles(p.monto)}</strong>${Math.abs(Number(p.monto_declarado) - Number(p.monto)) > 0.009 ? ` <span class="texto-peligro">(declaró ${soles(p.monto_declarado)})</span>` : ''}</dd></div>
                    <div><dt>N.° operación</dt><dd class="mono">${esc(p.operacion)}</dd></div>
                    <div><dt>Pagó el</dt><dd class="num">${esc(p.fecha_operacion)}</dd></div>
                    <div><dt>A la cuenta</dt><dd class="num">${esc(p.cuenta_numero || '–')}</dd></div>
                </dl>
                <div class="validar-acciones">
                    <button type="button" class="btn btn-danger btn-sm" data-rechazar="${Number(p.id)}"><i class="fa-solid fa-xmark"></i> Rechazar</button>
                    <button type="button" class="btn btn-primary btn-sm" data-aprobar="${Number(p.id)}"><i class="fa-solid fa-check"></i> Aprobar y emitir</button>
                </div>
            </div>
        </article>`;
    }).join('');
    // Miniaturas (se piden con el token)
    for (const p of lista.filter(x => x.tiene_voucher)) {
        urlVoucher(p.id).then(url => {
            urlsVoucher.set(p.id, url);
            const b = cont.querySelector(`[data-ver-voucher="${p.id}"]`);
            if (b) b.innerHTML = `<img src="${url}" alt="Constancia de ${esc(p.cliente_nombre)}">`;
        }).catch(() => {});
    }
}

async function validarPago(id, decision) {
    let motivo = '';
    if (decision === 'rechazar') {
        motivo = await new Promise(resolve => {
            let enviado = false;
            const m = abrirModal(`
                <form novalidate>
                    <div class="modal-cab"><h3>Rechazar pago</h3></div>
                    <div class="modal-cuerpo form-grid">
                        <p class="small muted">El regante verá este motivo y podrá enviar su pago otra vez.</p>
                        <div class="motivos-rapidos">
                            ${['El pago no aparece en la cuenta de la Junta.', 'El monto no coincide con la deuda.', 'El número de operación no coincide con la constancia.', 'La captura no es legible.'].map(t => `<button type="button" class="chip agua sin-punto" data-motivo="${esc(t)}">${esc(t)}</button>`).join('')}
                        </div>
                        <div class="field"><label for="rz-motivo">Motivo</label><input id="rz-motivo" class="input" maxlength="200" data-foco></div>
                    </div>
                    <div class="modal-pie"><button type="button" class="btn btn-ghost" data-cerrar>Cancelar</button><button type="submit" class="btn btn-danger">Rechazar</button></div>
                </form>`, { alCerrar: () => { if (!enviado) resolve(null); } });
            const inp = m.el.querySelector('#rz-motivo');
            m.el.querySelectorAll('[data-motivo]').forEach(b => b.addEventListener('click', () => { inp.value = b.dataset.motivo; inp.focus(); }));
            m.el.querySelector('form').addEventListener('submit', e => {
                e.preventDefault();
                if (inp.value.trim().length < 5) { inp.setAttribute('aria-invalid', 'true'); return toast('Escribe el motivo (mínimo 5 caracteres).', 'aviso'); }
                enviado = true; resolve(inp.value.trim()); m.cerrar();
            });
        });
        if (!motivo) return;
    } else {
        const ok = await confirmar({ titulo: 'Aprobar pago', mensaje: 'Confirma que el dinero ya está en la cuenta de la Junta. Se emitirá el comprobante y la deuda quedará pagada.', aceptar: 'Aprobar y emitir' });
        if (!ok) return;
    }
    try {
        const r = await post(`/admin/pagos/${id}/validar`, { decision, motivo });
        if (decision === 'aprobar') { toast(`Pago aprobado: ${r.pago.numero}`, 'ok'); mostrarComprobante(r.pago); } else toast('Pago rechazado. El regante verá el motivo.', 'aviso');
        await Promise.all([cargarValidar(), pintarMetricas()]);
    } catch (err) { toast(err.message, 'error'); }
}

// ---------------- Medios de pago (Yape, Plin, bancos) ----------------
let cuentasCache = [];
let metodoCuenta = 'yape';
let qrNuevo = null;
const ENTIDADES_BANCO = ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Banco de la Nación', 'BanBif', 'Caja Ica', 'Otra'];

async function cargarCuentas() {
    cuentasCache = await get('/admin/cuentas-cobro');
    const cont = document.getElementById('cuentas-lista');
    cont.innerHTML = cuentasCache.length ? cuentasCache.map(c => `
        <div class="cuenta-item ${c.activo ? '' : 'inactiva'}">
            ${tarjetaMedio(c, { seleccionable: false })}
            <div class="cuenta-item-pie">
                <span class="small muted">${esc(c.titular)}${c.cci ? ` · CCI ${esc(c.cci)}` : ''}${c.qr ? ' · con QR' : ''}${c.activo ? '' : ' · <strong>oculta</strong>'}</span>
                <span class="espacio"></span>
                <button type="button" class="icon-btn" data-editar-cuenta="${Number(c.id)}" aria-label="Editar"><i class="fa-regular fa-pen-to-square"></i></button>
                <button type="button" class="icon-btn danger" data-borrar-cuenta="${Number(c.id)}" aria-label="Eliminar"><i class="fa-regular fa-trash-can"></i></button>
            </div>
        </div>`).join('') : '<div class="aviso arena"><i class="fa-solid fa-triangle-exclamation"></i><span>Aún no hay medios de pago. Registra el Yape de la Junta y al menos una cuenta bancaria para que los regantes puedan pagar a distancia.</span></div>';
}

function ponerMetodo(metodo) {
    metodoCuenta = metodo;
    document.querySelectorAll('#fcu-metodo [data-metodo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.metodo === metodo)));
    const banco = metodo === 'transferencia';
    const sel = document.getElementById('fcu-entidad');
    sel.innerHTML = (banco ? ENTIDADES_BANCO : [metodo === 'yape' ? 'Yape (BCP)' : 'Plin']).map(e => `<option>${esc(e)}</option>`).join('');
    document.getElementById('fcu-entidad-wrap').classList.toggle('hidden', !banco);
    document.getElementById('fcu-cci-wrap').classList.toggle('hidden', !banco);
    document.getElementById('fcu-qr-wrap').classList.toggle('hidden', banco);
    document.getElementById('fcu-numero-lbl').textContent = banco ? 'Número de cuenta' : `Celular de ${metodo === 'yape' ? 'Yape' : 'Plin'}`;
    document.getElementById('fcu-numero').placeholder = banco ? 'Ej. 191-12345678-0-12' : '9XX XXX XXX';
}

function reiniciarCuenta() {
    const f = document.getElementById('form-cuenta');
    f.reset(); f.rid.value = ''; qrNuevo = null;
    limpiarErrores(f);
    document.getElementById('fcu-qr-prev').classList.add('hidden');
    document.getElementById('fcu-quitar-qr-wrap').classList.add('hidden');
    document.getElementById('fcu-titulo').textContent = 'Nuevo medio de pago';
    ponerMetodo('yape');
}

function editarCuenta(id) {
    const c = cuentasCache.find(x => x.id === id);
    if (!c) return;
    const f = document.getElementById('form-cuenta');
    reiniciarCuenta();
    ponerMetodo(c.metodo);
    f.rid.value = c.id; f.entidad.value = c.entidad; f.titular.value = c.titular; f.numero.value = c.numero;
    f.cci.value = c.cci || ''; f.instrucciones.value = c.instrucciones || ''; f.activo.checked = c.activo;
    if (c.qr) {
        const prev = document.getElementById('fcu-qr-prev');
        prev.innerHTML = `<img src="${c.qr}" alt="QR actual">`; prev.classList.remove('hidden');
        document.getElementById('fcu-quitar-qr-wrap').classList.remove('hidden');
    }
    document.getElementById('fcu-titulo').textContent = `Editar: ${marca(c.entidad).corto}`;
    f.titular.focus();
}

async function guardarCuenta(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    const cuerpo = { metodo: metodoCuenta, entidad: d.entidad, titular: d.titular, numero: d.numero, cci: d.cci, instrucciones: d.instrucciones, activo: d.activo, quitar_qr: d.quitar_qr, qr: qrNuevo || undefined };
    try {
        await conCarga(f.querySelector('[type=submit]'), () => (d.rid ? put(`/admin/cuentas-cobro/${d.rid}`, cuerpo) : post('/admin/cuentas-cobro', cuerpo)));
        toast('Medio de pago guardado.', 'ok');
        reiniciarCuenta();
        cargarCuentas();
    } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error'); }
}

async function leerQr(input) {
    const a = input.files[0];
    qrNuevo = null;
    if (!a) return;
    if (!/^image\/(png|jpeg|webp)$/.test(a.type) || a.size > 600 * 1024) {
        input.value = '';
        return toast('El QR debe ser una imagen JPG, PNG o WEBP de hasta 600 KB.', 'aviso');
    }
    qrNuevo = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(a); });
    const prev = document.getElementById('fcu-qr-prev');
    prev.innerHTML = `<img src="${qrNuevo}" alt="Vista previa del QR">`; prev.classList.remove('hidden');
}

// ---------------- Puntos de monitoreo ----------------
async function cargarPuntos() {
    const [puntos, alertas] = await Promise.all([get('/admin/clima/puntos'), get('/admin/clima/historial')]);
    puntosCache = puntos;
    const tipos = { sierra: 'Sierra', bocatoma: 'Bocatoma', valle: 'Valle' };
    document.getElementById('tbody-puntos').innerHTML = puntos.map(p => `
        <tr>
            <td><strong>${esc(p.nombre)}</strong><div class="small muted num">${Number(p.latitud).toFixed(4)}, ${Number(p.longitud).toFixed(4)}</div></td>
            <td>${esc(tipos[p.tipo])}${p.regulado ? ' · regulada' : ''}</td>
            <td class="der num">${Number(p.altitud_m).toLocaleString('es-PE')} m</td>
            <td class="der num">${numero(p.distancia_rio_km)} km</td>
            <td>${p.activo ? '<span class="chip agua">Activo</span>' : '<span class="chip anulado">Inactivo</span>'}</td>
            <td class="acciones">
                <button type="button" class="icon-btn" data-editar-punto="${Number(p.id)}" aria-label="Editar ${esc(p.nombre)}"><i class="fa-regular fa-pen-to-square"></i></button>
                <button type="button" class="icon-btn danger" data-borrar-punto="${Number(p.id)}" aria-label="Eliminar ${esc(p.nombre)}"><i class="fa-regular fa-trash-can"></i></button>
            </td>
        </tr>`).join('') || filaVacia(6, 'Sin puntos de monitoreo.');
    document.getElementById('tbody-alertas').innerHTML = alertas.map(a => `
        <tr>
            <td class="num">${esc(String(a.fecha).slice(0, 10))}</td>
            <td>${esc(a.punto)}</td>
            <td class="der num">${numero(a.precip_mm, 1)} mm</td>
            <td><span class="chip nivel-${esc(a.nivel)}">${esc(NIVEL[a.nivel]?.txt || a.nivel)}</span></td>
            <td class="small">${a.llegada_desde ? `${esc(fechaHora(a.llegada_desde))} – ${esc(fechaHora(a.llegada_hasta))}` : '–'}</td>
        </tr>`).join('') || filaVacia(5, 'No se registraron alertas en los últimos 90 días.', 'fa-sun');
}

function editarPunto(id) {
    const p = puntosCache.find(x => x.id === id);
    if (!p) return;
    const f = document.getElementById('form-punto');
    limpiarErrores(f);
    f.rid.value = p.id; f.nombre.value = p.nombre; f.tipo.value = p.tipo; f.latitud.value = p.latitud; f.longitud.value = p.longitud;
    f.altitud_m.value = p.altitud_m; f.distancia_rio_km.value = p.distancia_rio_km; f.regulado.checked = p.regulado; f.activo.checked = p.activo;
    f.notas.value = p.notas || '';
    document.getElementById('fp-titulo').textContent = `Editar: ${p.nombre}`;
    f.nombre.focus();
}

async function guardarPunto(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    const cuerpo = { ...d, latitud: Number(d.latitud), longitud: Number(d.longitud), altitud_m: Number(d.altitud_m), distancia_rio_km: Number(d.distancia_rio_km) };
    delete cuerpo.rid;
    try {
        await conCarga(f.querySelector('[type=submit]'), () => (d.rid ? put(`/admin/clima/puntos/${d.rid}`, cuerpo) : post('/admin/clima/puntos', cuerpo)));
        toast('Punto guardado. El pronóstico se recalculará.', 'ok');
        f.reset(); f.rid.value = ''; document.getElementById('fp-titulo').textContent = 'Nuevo punto de monitoreo';
        estado.clima = null;
        cargarPuntos();
        window.dispatchEvent(new Event('clima-actualizado'));
    } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error'); }
}

// ---------------- Bitácora ----------------
async function cargarAuditoria() {
    const filas = await get('/admin/auditoria');
    const acciones = {
        login: 'Ingresó', login_fallido: 'Intento fallido de ingreso', crear: 'Creó', editar: 'Editó', eliminar: 'Eliminó',
        desactivar: 'Desactivó', reactivar: 'Reactivó', registrar_caudal: 'Registró lectura', eliminar_caudal: 'Eliminó lectura',
        pago_culqi: 'Pago en línea (Culqi)', pago_rechazado_culqi: 'Pago en línea rechazado', pago_demo: 'Pago de demostración', checkout_mp: 'Inició pago con Mercado Pago', confirmar_mp: 'Confirmó pago', webhook_mp: 'Aviso de Mercado Pago',
        pago_manual: 'Registró pago en caja', cambiar_tarifa: 'Cambió la tarifa', reportar_pago: 'Envió constancia de pago',
        validar_pago: 'Aprobó un pago', rechazar_pago: 'Rechazó un pago', caudal_canal: 'Registró caudal del canal',
        generar_turnos: 'Generó turnos', cancelar_turno: 'Canceló un turno', parametros_riego: 'Cambió cupos y parámetros',
    };
    document.getElementById('tbody-auditoria').innerHTML = filas.map(a => `
        <tr>
            <td class="num small">${esc(a.fecha)}</td>
            <td>${esc(a.actor_nombre || (a.actor_tipo === 'sistema' ? 'Sistema' : '–'))}<div class="small muted">${esc(a.actor_tipo)}</div></td>
            <td>${esc(acciones[a.accion] || a.accion)}</td>
            <td class="small">${esc(a.entidad || '')}${a.entidad_id ? ` #${Number(a.entidad_id)}` : ''}</td>
            <td class="small muted num">${esc(a.ip || '')}</td>
        </tr>`).join('') || filaVacia(5, 'Sin actividad registrada.');
}

// ---------------- Eventos ----------------
export function iniciarAdmin({ onClientesCambiados }) {
    alRecargarClientes = onClientesCambiados || (() => {});
    document.getElementById('btn-culqi-diag').addEventListener('click', e => conCarga(e.currentTarget, diagnosticoCulqi, 'Probando…').catch(err => toast(err.message, 'error')));
    document.getElementById('form-correo-prueba').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.currentTarget;
        if (!validarFormulario(f)) return;
        try {
            const r = await conCarga(f.querySelector('[type=submit]'), () => post('/admin/correo/prueba', { email: f.email.value.trim() || undefined }), 'Enviando…');
            toast(`Correo de prueba enviado a ${r.para}.`, 'ok');
            estadoCorreo().catch(() => {});
        } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error', 8000); }
    });
    document.getElementById('admin-tabs').addEventListener('click', e => {
        const b = e.target.closest('[data-tab]');
        if (b) cargarTab(b.dataset.tab).catch(err => toast(err.message, 'error'));
    });

    const fc = document.getElementById('form-cliente');
    fc.addEventListener('submit', guardarCliente);
    fc.addEventListener('reset', () => setTimeout(reiniciarFormCliente));
    document.getElementById('fcl-tipo').addEventListener('change', ajustarDocumento);
    document.getElementById('buscar-cliente').addEventListener('input', pintarClientes);
    document.getElementById('tbody-clientes').addEventListener('click', async e => {
        const ed = e.target.closest('[data-editar-cliente]');
        const bo = e.target.closest('[data-borrar-cliente]');
        const re = e.target.closest('[data-reactivar-cliente]');
        if (ed) editarCliente(Number(ed.dataset.editarCliente));
        if (bo) {
            const c = clientesCache.find(x => x.id === Number(bo.dataset.borrarCliente));
            const ok = await confirmar({ titulo: 'Eliminar regante', mensaje: `¿Eliminar a ${c?.nombre}? Si tiene comprobantes emitidos, se desactivará en lugar de borrarse.`, aceptar: 'Eliminar', peligro: true });
            if (!ok) return;
            try {
                const r = await del(`/admin/clientes/${bo.dataset.borrarCliente}`);
                toast(r.mensaje || 'Regante eliminado.', r.desactivado ? 'aviso' : 'ok', 7000);
                await cargarClientes(); alRecargarClientes();
            } catch (err) { toast(err.message, 'error'); }
        }
        if (re) {
            try { await post(`/admin/clientes/${re.dataset.reactivarCliente}/reactivar`); toast('Regante reactivado.', 'ok'); await cargarClientes(); alRecargarClientes(); } catch (err) { toast(err.message, 'error'); }
        }
    });

    const fu = document.getElementById('form-usuario');
    fu.addEventListener('submit', guardarUsuario);
    fu.addEventListener('reset', () => setTimeout(reiniciarFormUsuario));
    document.getElementById('tbody-usuarios').addEventListener('click', async e => {
        const ed = e.target.closest('[data-editar-usuario]');
        const bo = e.target.closest('[data-borrar-usuario]');
        if (ed) editarUsuario(Number(ed.dataset.editarUsuario));
        if (bo) {
            const u = usuariosCache.find(x => x.id === Number(bo.dataset.borrarUsuario));
            const ok = await confirmar({ titulo: 'Eliminar usuario', mensaje: `${u?.nombre} ya no podrá ingresar al panel.`, aceptar: 'Eliminar', peligro: true });
            if (!ok) return;
            try { await del(`/admin/usuarios/${bo.dataset.borrarUsuario}`); toast('Usuario eliminado.', 'ok'); cargarUsuarios(); } catch (err) { toast(err.message, 'error'); }
        }
    });

    document.getElementById('form-tarifa').addEventListener('submit', guardarTarifa);
    document.getElementById('form-riego').addEventListener('submit', guardarRiego);
    document.getElementById('fcl-almacena').addEventListener('change', ajustarAlmacen);
    ['dotacion_m3_ha', 'adicional_pct_parcelero'].forEach(n => document.getElementById('form-riego')[n].addEventListener('input', actualizarEjemploDotacion));
    document.getElementById('metricas-admin').addEventListener('click', e => { const b = e.target.closest('[data-ir-tab]'); if (b) cargarTab(b.dataset.irTab).catch(err => toast(err.message, 'error')); });
    document.getElementById('btn-recargar-validar').addEventListener('click', () => cargarValidar().catch(err => toast(err.message, 'error')));
    document.getElementById('validar-lista').addEventListener('click', e => {
        const ap = e.target.closest('[data-aprobar]'); const re = e.target.closest('[data-rechazar]'); const vv = e.target.closest('[data-ver-voucher]');
        if (ap) validarPago(Number(ap.dataset.aprobar), 'aprobar');
        if (re) validarPago(Number(re.dataset.rechazar), 'rechazar');
        if (vv && !vv.classList.contains('sin')) verVoucher(Number(vv.dataset.verVoucher));
    });
    const fcu = document.getElementById('form-cuenta');
    fcu.addEventListener('submit', guardarCuenta);
    fcu.addEventListener('reset', () => setTimeout(reiniciarCuenta));
    document.getElementById('fcu-metodo').addEventListener('click', e => { const b = e.target.closest('[data-metodo]'); if (b) ponerMetodo(b.dataset.metodo); });
    document.getElementById('fcu-qr').addEventListener('change', e => leerQr(e.target));
    document.getElementById('cuentas-lista').addEventListener('click', async e => {
        const ed = e.target.closest('[data-editar-cuenta]'); const bo = e.target.closest('[data-borrar-cuenta]');
        if (ed) editarCuenta(Number(ed.dataset.editarCuenta));
        if (bo) {
            const ok = await confirmar({ titulo: 'Eliminar medio de pago', mensaje: 'Los regantes ya no verán esta cuenta. Si tiene pagos asociados, solo se ocultará.', aceptar: 'Eliminar', peligro: true });
            if (!ok) return;
            try { const r = await del(`/admin/cuentas-cobro/${bo.dataset.borrarCuenta}`); toast(r.mensaje || 'Medio de pago eliminado.', r.desactivada ? 'aviso' : 'ok'); cargarCuentas(); } catch (err) { toast(err.message, 'error'); }
        }
    });
    ponerMetodo('yape');

    const fp = document.getElementById('form-punto');
    fp.addEventListener('submit', guardarPunto);
    fp.addEventListener('reset', () => setTimeout(() => { fp.rid.value = ''; limpiarErrores(fp); document.getElementById('fp-titulo').textContent = 'Nuevo punto de monitoreo'; }));
    document.getElementById('tbody-puntos').addEventListener('click', async e => {
        const ed = e.target.closest('[data-editar-punto]');
        const bo = e.target.closest('[data-borrar-punto]');
        if (ed) editarPunto(Number(ed.dataset.editarPunto));
        if (bo) {
            const ok = await confirmar({ titulo: 'Eliminar punto', mensaje: 'Se borrará el punto y su historial de alertas.', aceptar: 'Eliminar', peligro: true });
            if (!ok) return;
            try { await del(`/admin/clima/puntos/${bo.dataset.borrarPunto}`); toast('Punto eliminado.', 'ok'); estado.clima = null; cargarPuntos(); } catch (err) { toast(err.message, 'error'); }
        }
    });
}
