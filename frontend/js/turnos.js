// =====================================================================
//  Vista "Turnos de riego"
//   - Personal: registra el caudal del canal, genera y recalcula turnos
//   - Regante: ve solo sus turnos
// =====================================================================
import { get, post } from './api.js';
import { estado, esPersonal, esStaff } from './estado.js';
import { esc, numero, entero, toast, confirmar, conCarga, filaVacia, hoyLima } from './ui.js';
import { validarFormulario, erroresServidor, datosFormulario } from './validacion.js';

let dia = 'hoy';
let ultimo = null;

const fechaSel = () => (dia === 'hoy' ? hoyLima() : new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10));
const hora = iso => new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
const duracion = min => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min` : `${Math.max(1, Math.round(min))} min`);
const TIPO = { riego: 'Riego (cupo base)', almacenamiento: 'Almacenamiento', adicional: 'Adicional' };

export async function cargarTurnos() {
    const fecha = fechaSel();
    const peticiones = [get(`/turnos?fecha=${fecha}`)];
    if (esStaff()) peticiones.push(get(`/canal/caudal?fecha=${hoyLima()}`));
    const [datos, canal] = await Promise.all(peticiones);
    ultimo = datos;
    pintarMetricas(datos);
    pintarLinea(datos);
    pintarTabla(datos);
    if (canal) pintarCanal(canal);
    document.getElementById('linea-titulo').textContent = dia === 'hoy' ? 'Horario de hoy' : 'Horario de mañana';
    document.getElementById('turnos-sub').textContent = esStaff()
        ? 'El caudal del canal se reparte en 24 horas: primero el cupo base de cada regante (según sus hectáreas), sin que nadie pase su límite de participación; si sobra, el adicional en el orden de atención.'
        : 'Estos son tus turnos. Durante tu turno recibes todo el caudal del canal; el volumen entregado se suma a tu consumo.';
}

function pintarMetricas(d) {
    const q = d.caudal_vigente ? Number(d.caudal_vigente.lps) : null;
    const cont = document.getElementById('metricas-turnos');
    if (!esStaff()) {
        const mios = d.turnos.filter(t => t.estado !== 'cancelado');
        const vol = mios.reduce((s, t) => s + Number(t.volumen_m3), 0);
        const min = mios.reduce((s, t) => s + Number(t.minutos), 0);
        cont.innerHTML = `
            <div class="metrica"><div class="etq">Tus turnos</div><div class="val">${mios.length}</div><div class="sub">${dia === 'hoy' ? 'Hoy' : 'Mañana'}</div></div>
            <div class="metrica"><div class="etq">Tiempo de agua</div><div class="val">${min ? duracion(min) : '–'}</div><div class="sub">Con todo el caudal del canal</div></div>
            <div class="metrica destacada"><div class="etq">Volumen asignado</div><div class="val">${entero(vol)}<small>m³</small></div><div class="sub">Se suma a tu consumo al cumplirse</div></div>
            <div class="metrica"><div class="etq">Caudal del canal</div><div class="val">${q != null ? numero(q) : '–'}<small>L/s</small></div><div class="sub">Último registro</div></div>`;
        return;
    }
    const r = d.resumen;
    cont.innerHTML = `
        <div class="metrica"><div class="etq">Caudal vigente</div><div class="val">${q != null ? numero(q) : '–'}<small>L/s</small></div><div class="sub">${q != null ? `${numero(q * 3.6)} m³/h · ${entero(q * 86.4)} m³/día` : 'Registra el caudal del canal'}</div></div>
        <div class="metrica"><div class="etq">Turnos</div><div class="val">${r.turnos}</div><div class="sub">${r.cumplidos} cumplidos</div></div>
        <div class="metrica"><div class="etq">Cupo base (riego)</div><div class="val">${entero(r.riego_m3)}<small>m³</small></div><div class="sub">${numero(d.parametros.dotacion_m3_ha)} m³/ha × factor del cultivo</div></div>
        <div class="metrica destacada"><div class="etq">Adicional / almacenamiento</div><div class="val">${entero(r.adicional_m3 ?? r.almacenamiento_m3)}<small>m³</small></div><div class="sub">Hasta +${numero(d.parametros.adicional_pct_parcelero)} % parceleros · +${numero(d.parametros.adicional_pct_fundo)} % fundos</div></div>`;
}

function pintarLinea(d) {
    const cont = document.getElementById('linea-tiempo');
    if (!d.turnos.length) {
        cont.innerHTML = `<div class="aviso agua"><i class="fa-solid fa-circle-info"></i><span>${esStaff()
            ? 'No hay turnos para este día. Registra el caudal del canal o pulsa “Generar turnos”.'
            : 'No tienes turnos programados para este día.'}</span></div>`;
        return;
    }
    const ini = new Date(`${d.fecha}T00:00:00-05:00`).getTime();
    const total = 24 * 3600e3;
    const pct = t => Math.max(0, Math.min(100, ((t - ini) / total) * 100));
    const segs = d.turnos.map(t => {
        const a = pct(new Date(t.inicio).getTime()), b = pct(new Date(t.fin).getTime());
        const clase = t.estado === 'programado' ? t.tipo : t.estado;
        const mio = estado.clienteId === t.cliente_id && esStaff() ? 'resaltado' : '';
        return `<button type="button" class="lt-seg ${clase} ${mio}" style="left:${a}%;width:${Math.max(0.25, b - a)}%" data-turno="${Number(t.id)}"
            title="${esc(t.cliente_nombre)} · ${hora(t.inicio)}–${hora(t.fin)} · ${entero(t.volumen_m3)} m³">${b - a > 6 ? esc(t.cliente_nombre) : ''}</button>`;
    }).join('');
    const ahora = Date.now();
    const lineaAhora = ahora > ini && ahora < ini + total ? `<span class="lt-ahora" style="left:${pct(ahora)}%"></span>` : '';
    const horas = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
    cont.innerHTML = `<div class="lt-barra">${segs}${lineaAhora}</div><div class="lt-horas">${horas}</div>`;
}

function pintarTabla(d) {
    const tbody = document.getElementById('tbody-turnos');
    if (!d.turnos.length) { tbody.innerHTML = filaVacia(8, 'Sin turnos para este día.', 'fa-clock'); return; }
    const chip = t => (t.en_curso ? '<span class="chip ok">En curso</span>'
        : t.estado === 'cumplido' ? '<span class="chip agua sin-punto"><i class="fa-solid fa-check"></i> Cumplido</span>'
        : t.estado === 'cancelado' ? '<span class="chip anulado">Cancelado</span>' : '<span class="chip pendiente">Programado</span>');
    tbody.innerHTML = d.turnos.map((t, i) => `
        <tr id="fila-turno-${Number(t.id)}" class="${esStaff() && estado.clienteId === t.cliente_id ? 'es-mio' : ''}">
            <td class="num">${i + 1}</td>
            <td><strong>${esc(t.cliente_nombre)}</strong><div class="small muted">${numero(t.hectareas)} ha · ${esc(t.cultivo || '')}</div></td>
            <td>${t.tipo === 'riego' ? '<span class="chip agua sin-punto">Cupo base</span>' : `<span class="chip pendiente sin-punto">${t.tipo === 'almacenamiento' ? 'Almacenamiento' : 'Adicional'}</span>`}<div class="small muted">${t.cliente_tipo === 'empresa' ? 'Fundo' : 'Parcelero'}</div></td>
            <td class="num">${hora(t.inicio)} – ${hora(t.fin)}</td>
            <td class="der num">${duracion(Number(t.minutos))}</td>
            <td class="der num"><strong>${entero(t.volumen_m3)}</strong> m³<div class="small muted">a ${numero(t.lps)} L/s</div></td>
            <td>${chip(t)}</td>
            <td class="acciones solo-personal">${t.estado === 'programado' && esPersonal()
                ? `<button type="button" class="btn btn-ghost btn-sm" data-cancelar-turno="${Number(t.id)}">${t.en_curso ? 'Terminar ahora' : 'Cancelar'}</button>` : ''}</td>
        </tr>`).join('');
    if (!esPersonal()) document.querySelectorAll('#tbody-turnos .solo-personal').forEach(el => el.classList.add('hidden'));
}

function pintarCanal(c) {
    const v = c.vigente;
    document.getElementById('canal-vigente').textContent = v ? `Vigente: ${numero(v.lps)} L/s desde las ${hora(v.fecha)}` : 'Sin registros';
    const tbody = document.getElementById('tbody-canal');
    tbody.innerHTML = c.lecturas.length ? c.lecturas.map(l => `
        <tr>
            <td class="num">${hora(l.fecha)}</td>
            <td class="der num"><strong class="texto-agua">${numero(l.lps)}</strong></td>
            <td class="der num">${numero(l.m3_hora)}</td>
            <td class="der num">${entero(l.m3_dia)}</td>
            <td class="small">${esc(l.nota || '')}</td>
            <td class="small muted">${esc(l.registrado_por || '')}</td>
        </tr>`).join('') : filaVacia(6, 'Aún no registras el caudal del canal hoy.', 'fa-gauge');
}

function resumenPlan(plan) {
    if (!plan) return 'Caudal registrado.';
    if (!plan.turnos) return 'Caudal registrado. No quedan turnos por programar hoy.';
    const cob = plan.cobertura_pct < 100
        ? `El agua de las horas que quedan cubre el ${numero(plan.cobertura_pct, 1)} % de la demanda pendiente; se repartió en proporción.`
        : `Cubre todos los cupos base${plan.sin_asignar_m3 > 1 ? `; ${entero(plan.sin_asignar_m3)} m³ quedan sin asignar porque todos llegaron a su límite` : ''}.`;
    const lim = plan.limitados ? ` ${plan.limitados} regante(s) llegaron a su límite de participación.` : '';
    return `${plan.turnos} turnos programados (${entero(plan.programado_m3)} m³). ${cob}${lim}${plan.manana ? ' También se actualizó el horario de mañana.' : ''}`;
}

async function registrarCanal(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    try {
        const r = await conCarga(f.querySelector('[type=submit]'), () => post('/canal/caudal', { lps: Number(d.lps), nota: d.nota, recalcular: d.recalcular }));
        f.lps.value = ''; f.nota.value = '';
        actualizarConversion();
        toast(resumenPlan(r.plan), 'ok', 8000);
        dia = 'hoy'; marcarDia();
        await cargarTurnos();
    } catch (err) {
        erroresServidor(f, err.campos);
        toast(err.message, 'error');
    }
}

async function generar(boton) {
    const fecha = fechaSel();
    const ok = await confirmar({
        titulo: dia === 'hoy' ? 'Generar turnos de hoy' : 'Generar turnos de mañana',
        mensaje: dia === 'hoy'
            ? 'Se recalcularán los turnos pendientes desde ahora con el último caudal registrado. Los turnos cumplidos no cambian.'
            : 'Se programará el día completo (00:00 a 24:00) con el último caudal registrado. Podrás recalcular si el caudal cambia.',
        aceptar: 'Generar',
    });
    if (!ok) return;
    try {
        const plan = await conCarga(boton, () => post('/turnos/generar', { fecha }), 'Calculando…');
        toast(resumenPlan(plan), 'ok', 8000);
        cargarTurnos();
    } catch (err) { toast(err.message, 'error', 7000); }
}

function actualizarConversion() {
    const v = Number(document.getElementById('fcn-lps').value);
    document.getElementById('fcn-conv').textContent = v > 0
        ? `= ${numero(v * 3.6)} m³/hora · ${entero(v * 86.4)} m³/día`
        : 'Se convierte a m³/hora y m³/día automáticamente.';
}

function marcarDia() {
    document.querySelectorAll('#turnos-dia [data-dia]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dia === dia)));
}

/** Panel "Turno de riego de hoy" en la vista Mi agua */
export async function pintarMiTurno() {
    const cont = document.getElementById('mi-turno');
    if (!estado.clienteId) { cont.innerHTML = '<p class="muted small">Selecciona un regante.</p>'; return; }
    try {
        const q = esStaff() ? `&cliente_id=${estado.clienteId}` : '';
        const d = await get(`/turnos?fecha=${hoyLima()}${q}`);
        const activos = d.turnos.filter(t => t.estado !== 'cancelado');
        const proximo = activos.find(t => t.en_curso) || activos.find(t => t.estado === 'programado');
        if (!activos.length) {
            cont.innerHTML = '<p class="muted small">No hay turno programado para hoy.</p>';
            return;
        }
        const vol = activos.reduce((s, t) => s + Number(t.volumen_m3), 0);
        cont.innerHTML = `<div class="mi-turno">
            ${proximo
                ? `<div><span class="label">${proximo.en_curso ? 'Recibiendo agua ahora' : 'Próximo turno'}</span>
                     <div class="mi-turno-hora">${hora(proximo.inicio)} – ${hora(proximo.fin)}</div>
                     <div class="small muted">${TIPO[proximo.tipo]} · ${entero(proximo.volumen_m3)} m³ a ${numero(proximo.lps)} L/s</div></div>`
                : '<div><span class="label">Turnos de hoy cumplidos</span></div>'}
            <div class="small muted">${activos.length} turno(s) hoy · ${entero(vol)} m³ en total</div>
        </div>`;
    } catch (err) {
        cont.innerHTML = `<p class="small texto-peligro">${esc(err.message)}</p>`;
    }
}

/** Al cambiar de sesión se vuelve a mostrar el día de hoy. */
export function reiniciarTurnos() { dia = 'hoy'; marcarDia(); }

export function iniciarTurnos() {
    document.getElementById('form-canal').addEventListener('submit', registrarCanal);
    document.getElementById('fcn-lps').addEventListener('input', actualizarConversion);
    document.getElementById('btn-generar-turnos').addEventListener('click', e => generar(e.currentTarget));
    document.getElementById('turnos-dia').addEventListener('click', e => {
        const b = e.target.closest('[data-dia]');
        if (!b) return;
        dia = b.dataset.dia; marcarDia();
        cargarTurnos().catch(err => toast(err.message, 'error'));
    });
    document.getElementById('linea-tiempo').addEventListener('click', e => {
        const s = e.target.closest('[data-turno]');
        if (!s) return;
        const fila = document.getElementById(`fila-turno-${s.dataset.turno}`);
        fila?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        fila?.animate([{ background: 'var(--agua-tint)' }, { background: 'transparent' }], { duration: 1200 });
    });
    document.getElementById('tbody-turnos').addEventListener('click', async e => {
        const b = e.target.closest('[data-cancelar-turno]');
        if (!b) return;
        const t = ultimo?.turnos.find(x => x.id === Number(b.dataset.cancelarTurno));
        const ok = await confirmar({
            titulo: t?.en_curso ? 'Terminar turno ahora' : 'Cancelar turno',
            mensaje: t?.en_curso
                ? `Se cortará el turno de ${t.cliente_nombre}. Solo se cobrará el agua entregada hasta ahora.`
                : `${t?.cliente_nombre} no recibirá este turno y no se le cobrará. Para reasignar el agua, pulsa luego “Generar turnos”.`,
            aceptar: t?.en_curso ? 'Terminar' : 'Cancelar turno', peligro: true,
        });
        if (!ok) return;
        try {
            const r = await post(`/turnos/${b.dataset.cancelarTurno}/cancelar`, {});
            toast(r.parcial ? `Turno terminado: se registraron ${entero(r.volumen_m3)} m³.` : 'Turno cancelado.', 'ok');
            cargarTurnos();
        } catch (err) { toast(err.message, 'error'); }
    });
    // Refresca la vista cada minuto mientras esté abierta (avance de la línea "ahora")
    setInterval(() => { if (estado.vista === 'turnos' && estado.sesion) cargarTurnos().catch(() => {}); }, 60 * 1000);
}
