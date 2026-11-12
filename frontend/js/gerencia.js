// =====================================================================
//  Tablero gerencial (gerente y administrador)
//   - Equipo y regantes: alineación del personal, parceleros vs fundos, deudas
//   - Costos e ingresos: canon, otros ingresos, egresos y costo del m³
//   - Capacidad y cupos: cuánto puede mover La Achirana y simulador de reparto
// =====================================================================
import { get, post, del } from './api.js';
import { estado } from './estado.js';
import { esc, soles, numero, entero, fechaHora, toast, confirmar, conCarga, filaVacia, cssVar, hoyLima } from './ui.js';
import { validarFormulario, erroresServidor, limpiarErrores, datosFormulario } from './validacion.js';
import { dibujar, opcionesBase, temaGraficos } from './graficos.js';

let tab = 'resumen';
let meses = 12;
let tipoMov = 'egreso';
let categorias = null;
let fin = null;
let cap = null;
let simTimer = null;
let ultimaSim = null;

const pct = (v, d = 1) => (v === null || v === undefined ? '–' : `${numero(v, d)} %`);
const m3 = v => `${entero(v)}<small>m³</small>`;
const mesCorto = ym => new Date(`${ym}-15T12:00:00`).toLocaleDateString('es-PE', { month: 'short', year: '2-digit' }).replace('.', '');
const hace = iso => {
    if (!iso) return 'Nunca';
    const h = (Date.now() - new Date(iso)) / 3600e3;
    return h < 1 ? 'Hace minutos' : h < 24 ? `Hace ${Math.round(h)} h` : `Hace ${Math.round(h / 24)} día(s)`;
};

export async function cargarGerencia() {
    marcarTab();
    if (tab === 'resumen') await cargarResumen();
    if (tab === 'finanzas') await cargarFinanzas();
    if (tab === 'capacidad') await cargarCapacidad();
}

function marcarTab() {
    document.querySelectorAll('#ger-tabs [data-gtab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gtab === tab)));
    document.querySelectorAll('[data-gpanel]').forEach(p => p.classList.toggle('hidden', p.dataset.gpanel !== tab));
}

// ================================================================ Resumen
async function cargarResumen() {
    const r = await get('/gerencia/resumen');
    const { parceleros: p, fundos: f } = r.regantes;
    const deuda = p.deuda + f.deuda;
    const ok = r.indicadores.filter(i => i.estado === 'ok').length;
    document.getElementById('ger-metricas').innerHTML = `
        <div class="metrica"><div class="etq">Regantes activos</div><div class="val">${p.cantidad + f.cantidad}</div><div class="sub">${p.cantidad} parceleros · ${f.cantidad} fundos</div></div>
        <div class="metrica"><div class="etq">Área bajo riego</div><div class="val">${numero(p.hectareas + f.hectareas, 1)}<small>ha</small></div><div class="sub">${numero(p.hectareas, 1)} ha parceleros · ${numero(f.hectareas, 1)} ha fundos</div></div>
        <div class="metrica"><div class="etq">Cupo base diario</div><div class="val">${m3(p.cupo_base_m3_dia + f.cupo_base_m3_dia)}</div><div class="sub">Máximo con adicional: ${entero(p.maximo_m3_dia + f.maximo_m3_dia)} m³</div></div>
        <div class="metrica destacada"><div class="etq">Por cobrar</div><div class="val">${soles(deuda)}</div><div class="sub">${p.morosos + f.morosos} regante(s) con más de 30 días</div></div>`;

    document.getElementById('ger-alineacion-score').textContent = `${ok} de ${r.indicadores.length} en verde`;
    const ico = { ok: 'fa-circle-check', aviso: 'fa-triangle-exclamation', mal: 'fa-circle-xmark' };
    document.getElementById('ger-indicadores').innerHTML = r.indicadores.map(i => `
        <div class="semaforo ${esc(i.estado)}">
            <i class="fa-solid ${ico[i.estado]}"></i>
            <div><strong>${esc(i.titulo)}</strong><span>${esc(i.detalle)}</span></div>
            <span class="responsable">${esc(i.responsable)}</span>
        </div>`).join('');

    const fila = (etq, a, b, fmt = v => v) => `<tr><td>${etq}</td><td class="der num">${fmt(a)}</td><td class="der num">${fmt(b)}</td></tr>`;
    const barra = (a, b) => {
        const t = a + b || 1;
        return `<div class="barra-comp"><span style="width:${(a / t) * 100}%" class="parc"></span><span style="width:${(b / t) * 100}%" class="fundo"></span></div>`;
    };
    document.getElementById('ger-regantes').innerHTML = `
        <div class="comp-leyenda"><span><i class="parc"></i>Parceleros</span><span><i class="fundo"></i>Fundos</span></div>
        <div class="comp-bloque"><span class="small muted">Hectáreas</span>${barra(p.hectareas, f.hectareas)}</div>
        <div class="comp-bloque"><span class="small muted">Cupo base diario</span>${barra(p.cupo_base_m3_dia, f.cupo_base_m3_dia)}</div>
        <div class="comp-bloque"><span class="small muted">Consumo del mes</span>${barra(p.consumo_mes_m3, f.consumo_mes_m3)}</div>
        <table class="tabla compacta" style="margin-top:12px">
            <thead><tr><th></th><th class="der">Parceleros</th><th class="der">Fundos</th></tr></thead>
            <tbody>
                ${fila('Activos', p.cantidad, f.cantidad)}
                ${fila('Hectáreas', p.hectareas, f.hectareas, v => numero(v, 1))}
                ${fila('Cupo base / día', p.cupo_base_m3_dia, f.cupo_base_m3_dia, v => `${entero(v)} m³`)}
                ${fila('Máximo / día', p.maximo_m3_dia, f.maximo_m3_dia, v => `${entero(v)} m³`)}
                ${fila('Consumo del mes', p.consumo_mes_m3, f.consumo_mes_m3, v => `${entero(v)} m³`)}
                ${fila('Deuda', p.deuda, f.deuda, soles)}
                ${fila('Morosos (+30 días)', p.morosos, f.morosos)}
                ${fila('Con código de acceso', `${p.con_codigo}/${p.cantidad}`, `${f.con_codigo}/${f.cantidad}`)}
                ${fila('Almacenan / reservorios', '–', `${f.almacenan} · ${entero(f.capacidad_reservorios_m3)} m³`)}
            </tbody>
        </table>`;

    const roles = { admin: 'Administrador', operador: 'Operador', gerente: 'Gerente' };
    document.getElementById('ger-personal').innerHTML = r.personal.map(u => {
        const dias = u.ultimo_acceso ? (Date.now() - new Date(u.ultimo_acceso)) / 864e5 : Infinity;
        const est = !u.activo ? '<span class="chip anulado">Desactivado</span>'
            : u.bloqueado ? '<span class="chip rechazado">Bloqueado</span>'
            : u.rol === 'gerente' ? '<span class="chip agua sin-punto">Gerencia</span>'
            : dias > 7 ? '<span class="chip pendiente">Sin ingresar +7 días</span>'
            : u.acciones_7d === 0 ? '<span class="chip pendiente">Sin actividad</span>' : '<span class="chip ok">Al día</span>';
        return `<tr>
            <td><strong>${esc(u.nombre)}</strong><div class="small muted">${esc(roles[u.rol] || u.rol)} · ${esc(u.email)}</div></td>
            <td class="small">${esc(hace(u.ultimo_acceso))}${u.ultima_accion ? `<div class="muted">Última acción: ${esc(fechaHora(u.ultima_accion))}</div>` : ''}</td>
            <td class="der num"><strong>${u.acciones_7d}</strong></td>
            <td class="der num">${u.lecturas_30d}</td>
            <td class="der num">${u.pagos_30d}</td>
            <td class="der num">${u.turnos_30d}</td>
            <td>${est}${u.fallidos_7d ? `<div class="small texto-peligro">${u.fallidos_7d} intento(s) fallido(s)</div>` : ''}</td>
        </tr>`;
    }).join('') || filaVacia(7, 'Sin personal registrado.');

    document.getElementById('ger-deuda-sub').textContent = `Tarifa vigente S/ ${Number(r.tarifa_m3).toFixed(4)} por m³`;
    document.getElementById('ger-deudores').innerHTML = r.deudores.map(d => `
        <tr>
            <td><strong>${esc(d.nombre)}</strong><div class="small muted num">${esc(d.documento)}</div></td>
            <td>${d.tipo === 'empresa' ? 'Fundo' : 'Parcelero'}</td>
            <td class="der num">${entero(d.m3)} m³</td>
            <td class="der num"><strong>${soles(d.deuda)}</strong></td>
            <td class="der">${d.dias > 30 ? `<span class="chip rechazado">${d.dias} días</span>` : `<span class="chip pendiente">${d.dias} días</span>`}</td>
        </tr>`).join('') || filaVacia(5, 'Ningún regante tiene deuda.', 'fa-face-smile');
}

// ================================================================ Finanzas
async function cargarFinanzas() {
    const [f, mov] = await Promise.all([get(`/gerencia/finanzas?meses=${meses}`), get('/gerencia/movimientos')]);
    fin = f;
    categorias = f.categorias;
    pintarCategorias();
    const t = f.totales, i = f.indicadores;
    document.getElementById('fin-metricas').innerHTML = `
        <div class="metrica"><div class="etq">Ingresos</div><div class="val">${soles(t.ingresos)}</div><div class="sub">Canon ${soles(t.canon)} · otros ${soles(t.otros_ingresos)}</div></div>
        <div class="metrica"><div class="etq">Egresos</div><div class="val">${soles(t.egresos)}</div><div class="sub">Gastos registrados en ${f.meses} meses</div></div>
        <div class="metrica destacada"><div class="etq">Resultado</div><div class="val ${t.resultado < 0 ? 'texto-peligro' : ''}">${soles(t.resultado)}</div><div class="sub">Margen ${pct(i.margen_pct)}</div></div>
        <div class="metrica"><div class="etq">Costo por m³ entregado</div><div class="val">${i.costo_m3 === null ? '–' : `S/ ${Number(i.costo_m3).toFixed(4)}`}</div><div class="sub">Tarifa: S/ ${Number(i.tarifa_m3).toFixed(4)} ${i.costo_m3 === null ? '· registra los egresos para calcularlo' : ''}${i.costo_m3 !== null ? (i.costo_m3 > i.tarifa_m3 ? '<span class="texto-peligro">· la tarifa no cubre el costo</span>' : '<span class="texto-ok">· la tarifa cubre el costo</span>') : ''}</div></div>`;
    document.getElementById('fin-metricas-2').innerHTML = `
        <div class="metrica"><div class="etq">Agua captada de la sierra</div><div class="val">${m3(t.captado_m3)}</div><div class="sub">Según el caudal del canal registrado</div></div>
        <div class="metrica"><div class="etq">Entregada a regantes</div><div class="val">${m3(t.entregado_m3)}</div><div class="sub">Eficiencia de entrega ${pct(i.eficiencia_entrega_pct)}</div></div>
        <div class="metrica"><div class="etq">Cobrada</div><div class="val">${m3(t.cobrado_m3)}</div><div class="sub">Eficiencia de cobro ${pct(i.eficiencia_cobro_pct)}</div></div>
        <div class="metrica"><div class="etq">Por cobrar hoy</div><div class="val">${soles(i.por_cobrar)}</div><div class="sub">Consumo entregado sin pagar</div></div>`;
    pintarGraficosFin();

    document.getElementById('tbody-mov').innerHTML = mov.movimientos.map(m => `
        <tr>
            <td class="num small">${esc(m.fecha)}</td>
            <td><span class="chip ${m.tipo === 'egreso' ? 'revision' : 'ok'} sin-punto">${m.tipo === 'egreso' ? 'Egreso' : 'Ingreso'}</span> <strong>${esc(m.categoria)}</strong>
                <div class="small muted">${esc(m.descripcion)}${m.documento ? ` · ${esc(m.documento)}` : ''}${m.registrado_por ? ` · ${esc(m.registrado_por)}` : ''}</div></td>
            <td class="der num"><strong class="${m.tipo === 'egreso' ? 'texto-peligro' : 'texto-ok'}">${m.tipo === 'egreso' ? '−' : '+'}${soles(m.monto)}</strong></td>
            <td class="acciones"><button type="button" class="icon-btn danger" data-borrar-mov="${Number(m.id)}" aria-label="Eliminar movimiento"><i class="fa-regular fa-trash-can"></i></button></td>
        </tr>`).join('') || filaVacia(4, 'Aún no registras egresos. Sin ellos no se puede calcular el costo del agua.', 'fa-file-invoice-dollar');
}

function pintarGraficosFin() {
    if (!fin) return;
    const t = temaGraficos();
    const naranja = cssVar('--n-naranja');
    const etiquetas = fin.serie.map(s => mesCorto(s.mes));
    const base = opcionesBase({ unidadY: 'S/' });
    dibujar('graf-fin-mes', {
        type: 'bar',
        data: {
            labels: etiquetas,
            datasets: [
                { type: 'line', label: 'Resultado', data: fin.serie.map(s => s.resultado), borderColor: t.arena, backgroundColor: t.arena, borderWidth: 2.5, tension: 0.3, pointRadius: 3, order: 0 },
                { label: 'Ingresos', data: fin.serie.map(s => s.ingresos), backgroundColor: `${t.agua}cc`, borderRadius: 6, maxBarThickness: 22, order: 1 },
                { label: 'Egresos', data: fin.serie.map(s => s.egresos), backgroundColor: `${naranja}cc`, borderRadius: 6, maxBarThickness: 22, order: 1 },
            ],
        },
        options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, beginAtZero: true } } },
    });
    dibujar('graf-fin-agua', {
        type: 'bar',
        data: {
            labels: etiquetas,
            datasets: [
                { label: 'Captado', data: fin.serie.map(s => s.captado_m3), backgroundColor: `${cssVar('--agua-2')}99`, borderRadius: 5, maxBarThickness: 16 },
                { label: 'Entregado', data: fin.serie.map(s => s.entregado_m3), backgroundColor: `${t.agua}dd`, borderRadius: 5, maxBarThickness: 16 },
                { label: 'Cobrado', data: fin.serie.map(s => s.cobrado_m3), backgroundColor: `${t.arena}dd`, borderRadius: 5, maxBarThickness: 16 },
            ],
        },
        options: opcionesBase({ unidadY: 'm³' }),
    });
    const egr = fin.por_categoria.filter(c => c.tipo === 'egreso');
    const paleta = [naranja, t.arena, t.agua, cssVar('--n-rojo'), cssVar('--agua-2'), cssVar('--ok'), t.tenue];
    dibujar('graf-fin-cat', egr.length ? {
        type: 'doughnut',
        data: { labels: egr.map(c => c.categoria), datasets: [{ data: egr.map(c => c.total), backgroundColor: paleta, borderColor: cssVar('--surface'), borderWidth: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, color: t.texto } }, tooltip: { callbacks: { label: c => `${c.label}: ${soles(c.parsed)}` } } } },
    } : vacioGrafico('Registra egresos para ver su distribución'));
    const med = fin.por_medio;
    dibujar('graf-fin-medio', med.length ? {
        type: 'bar',
        data: { labels: med.map(m => m.medio.startsWith('caja-') ? `Caja · ${m.metodo}` : m.medio), datasets: [{ label: 'Cobrado', data: med.map(m => m.total), backgroundColor: med.map((_, k) => paleta[(k + 2) % paleta.length]), borderRadius: 6, maxBarThickness: 26 }] },
        options: { ...opcionesBase({ unidadY: 'S/' }), indexAxis: 'y' },
    } : vacioGrafico('Aún no hay cobros en el periodo'));
}

const vacioGrafico = texto => ({
    type: 'bar', data: { labels: [texto], datasets: [{ data: [0] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: true, grid: { display: false } }, y: { display: false } } },
});

function pintarCategorias() {
    const sel = document.getElementById('fm-cat');
    if (!categorias) return;
    const actual = sel.value;
    sel.innerHTML = categorias[tipoMov].map(c => `<option>${esc(c)}</option>`).join('');
    if (categorias[tipoMov].includes(actual)) sel.value = actual;
}

async function guardarMovimiento(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    try {
        await conCarga(f.querySelector('[type=submit]'), () => post('/gerencia/movimientos', { ...d, tipo: tipoMov, monto: Number(d.monto) }));
        toast(tipoMov === 'egreso' ? 'Egreso registrado.' : 'Ingreso registrado.', 'ok');
        f.reset(); f.fecha.value = hoyLima(); limpiarErrores(f); pintarCategorias();
        cargarFinanzas();
    } catch (err) { erroresServidor(f, err.campos); toast(err.message, 'error'); }
}

// ================================================================ Capacidad y cupos
async function cargarCapacidad() {
    const [c, cupos] = await Promise.all([get('/gerencia/capacidad'), get('/turnos/demandas')]);
    cap = c;
    const q = c.parametros.canal_capacidad_lps;
    document.getElementById('cap-metricas').innerHTML = `
        <div class="metrica"><div class="etq">Capacidad de conducción</div><div class="val">${m3(c.conduccion.m3_dia)}</div><div class="sub">por día · ${numero(q)} L/s · ${numero(c.conduccion.m3_mes / 1e6, 2)} millones m³/mes</div></div>
        <div class="metrica"><div class="etq">Almacenamiento disponible</div><div class="val">${m3(c.almacenamiento.total_m3)}</div><div class="sub">Reservorios de fundos ${entero(c.almacenamiento.fundos_m3)} m³ · Junta ${entero(c.almacenamiento.junta_m3)} m³</div></div>
        <div class="metrica"><div class="etq">Demanda base diaria</div><div class="val">${m3(c.demanda.base_m3_dia)}</div><div class="sub">${numero(c.demanda.hectareas, 1)} ha · equivale a ${numero(c.demanda.base_lps)} L/s continuos</div></div>
        <div class="metrica destacada"><div class="etq">Uso actual del canal</div><div class="val">${c.actual ? pct(c.actual.uso_pct) : '–'}</div><div class="sub">${c.actual ? `${numero(c.actual.lps)} L/s registrados · cubre ${pct(c.actual.cubre_base_pct, 0)} de la demanda` : 'Sin caudal registrado'}</div></div>`;
    document.getElementById('cap-nota').textContent = `Capacidad del canal: ${numero(q)} L/s (dato de diseño editable en Panel → Cupos y riego)`;

    const capDia = c.conduccion.m3_dia;
    const w = v => `${Math.max(0, Math.min(100, (v / capDia) * 100))}%`;
    const actualPos = c.actual ? Math.min(100, (c.actual.m3_dia / capDia) * 100) : null;
    document.getElementById('cap-barra').innerHTML = `
        <div class="cb-pista">
            <span class="cb-seg base" style="width:${w(c.demanda.base_m3_dia)}" title="Demanda base"></span>
            <span class="cb-seg adic" style="width:${w(c.demanda.maximo_m3_dia - c.demanda.base_m3_dia)}" title="Adicional máximo"></span>
            ${actualPos !== null ? `<span class="cb-actual" style="left:${actualPos}%"><b>Hoy ${numero(c.actual.lps)} L/s</b></span>` : ''}
        </div>
        <div class="cb-escala"><span>0</span><span>${entero(capDia / 2)} m³</span><span>${entero(capDia)} m³/día</span></div>
        <div class="cuenca-leyenda" style="padding:0">
            <span><i class="cuadro" style="background:var(--agua)"></i> Cupo base de todos (${entero(c.demanda.base_m3_dia)} m³)</span>
            <span><i class="cuadro" style="background:var(--arena)"></i> Adicional máximo (${entero(c.demanda.maximo_m3_dia - c.demanda.base_m3_dia)} m³)</span>
            <span><i class="cuadro" style="background:var(--surface-3)"></i> Capacidad libre (${entero(Math.max(0, capDia - c.demanda.maximo_m3_dia))} m³)</span>
        </div>`;
    const caja = (ico, t, v, s) => `<div class="cap-caja"><i class="fa-solid ${ico}"></i><div><span class="small muted">${t}</span><strong>${v}</strong><span class="small muted">${s}</span></div></div>`;
    document.getElementById('cap-detalle').innerHTML = [
        caja('fa-gauge-high', 'Por hora', `${entero(c.conduccion.m3_hora)} m³`, `${numero(q)} L/s × 3.6`),
        caja('fa-calendar-days', 'Por año (a plena capacidad)', `${numero(c.conduccion.m3_anio / 1e6, 1)} millones m³`, 'Referencia de conducción, no de disponibilidad del río'),
        caja('fa-seedling', 'Hectáreas atendibles a capacidad máxima', `${entero(c.demanda.hectareas_atendibles)} ha`, `Con la dotación media actual (${numero(c.demanda.base_m3_dia / Math.max(1, c.demanda.hectareas), 1)} m³/ha·día)`),
        caja('fa-warehouse', 'Autonomía con lo almacenado', c.almacenamiento.dias_autonomia === null ? '–' : `${numero(c.almacenamiento.dias_autonomia, 1)} días`, 'Si el canal se corta: reservorios ÷ demanda base'),
        caja('fa-percent', 'Demanda base vs. capacidad', pct(c.demanda.uso_canal_base_pct), `Máximo con adicional: ${numero(c.demanda.maximo_lps)} L/s`),
    ].join('');

    const rango = document.getElementById('sim-lps');
    rango.max = String(Math.round(q * 1.1));
    if (!rango.dataset.iniciado) { rango.value = String(Math.round(c.actual ? c.actual.lps : c.demanda.base_lps)); rango.dataset.iniciado = '1'; }
    const presets = [
        ['Estiaje', Math.round(c.demanda.base_lps * 0.5)],
        ['Justo la demanda', Math.round(c.demanda.base_lps)],
        ...(c.actual ? [['Caudal de hoy', Math.round(c.actual.lps)]] : []),
        ['Avenida', Math.round(q)],
    ];
    document.getElementById('sim-presets').innerHTML = presets.map(([t, v]) => `<button type="button" class="chip agua sin-punto" data-preset="${v}">${esc(t)} · ${entero(v)} L/s</button>`).join('');
    simular();

    // Cupos
    const p = c.parametros;
    document.getElementById('cupos-sub').textContent = `Dotación ${numero(p.dotacion_m3_ha)} m³/ha·día · adicional ${numero(p.adicional_pct_parcelero)} % parceleros / ${numero(p.adicional_pct_fundo)} % fundos`;
    const ej = 5 * p.dotacion_m3_ha;
    const orden = { parcelero: 'primero los parceleros y luego los fundos', fundo: 'primero los fundos y luego los parceleros', igual: 'a todos a la vez, en proporción' }[p.prioridad_adicional];
    document.getElementById('cupos-regla').innerHTML = `<i class="fa-solid fa-scale-balanced"></i><span>
        <strong>Regla de reparto.</strong> Cupo base = hectáreas × ${numero(p.dotacion_m3_ha)} m³ × factor del cultivo. Ejemplo: un parcelero de 5 ha recibe <strong>${entero(ej)} m³</strong> al día y puede comprar o almacenar <strong>${entero(ej * p.adicional_pct_parcelero / 100)} m³</strong> más (${numero(p.adicional_pct_parcelero)} %).
        Mientras alguien no complete su cupo, ningún parcelero puede llevarse más del <strong>${numero(p.tope_pct_parcelero)} %</strong> del agua del día ni ningún fundo más del <strong>${numero(p.tope_pct_fundo)} %</strong>. El adicional se atiende ${orden}.</span>`;
    document.getElementById('cupos-tbody').innerHTML = cupos.map(r => {
        const usado = r.maximo_m3 > 0 ? Math.min(100, (r.programado_hoy_m3 / r.maximo_m3) * 100) : 0;
        const basePct = r.maximo_m3 > 0 ? (r.cupo_base_m3 / r.maximo_m3) * 100 : 0;
        return `<tr>
            <td><strong>${esc(r.nombre)}</strong><div class="small muted">${r.tipo === 'empresa' ? 'Fundo' : 'Parcelero'} · ${esc(r.cultivo || '–')} · factor ${Number(r.factor).toFixed(2)}</div></td>
            <td class="der num">${numero(r.hectareas)} ha</td>
            <td class="der num"><strong>${entero(r.cupo_base_m3)}</strong> m³</td>
            <td class="der num">+${entero(r.adicional_m3)} m³</td>
            <td class="der num"><strong class="texto-arena">${entero(r.maximo_m3)}</strong> m³</td>
            <td class="der num">${numero(r.tope_pct)} %<div class="small muted">${r.tope_canal_m3 ? `${entero(r.tope_canal_m3)} m³` : '–'}</div></td>
            <td><div class="cupo-barra" title="Programado hoy ${entero(r.programado_hoy_m3)} de ${entero(r.maximo_m3)} m³"><span class="lleno" style="width:${usado}%"></span><span class="marca-base" style="left:${basePct}%"></span></div>
                <div class="small muted">${entero(r.programado_hoy_m3)} m³ de ${entero(r.maximo_m3)}</div></td>
        </tr>`;
    }).join('') || filaVacia(7, 'No hay regantes activos.');
}

function simular() {
    const lps = Number(document.getElementById('sim-lps').value);
    const horas = Number(document.getElementById('sim-horas').value);
    document.getElementById('sim-lps-txt').textContent = `${entero(lps)} L/s · ${entero(lps * 3.6 * horas)} m³ en ${horas} h`;
    clearTimeout(simTimer);
    simTimer = setTimeout(async () => {
        try {
            ultimaSim = await post('/gerencia/simular', { lps, horas });
            pintarSimulacion(ultimaSim);
        } catch (err) { toast(err.message, 'error'); }
    }, 180);
}

function pintarSimulacion(s) {
    const cob = s.cobertura_pct;
    document.getElementById('sim-metricas').innerHTML = `
        <div class="metrica"><div class="etq">Agua del día</div><div class="val">${m3(s.volumen_m3)}</div><div class="sub">${pct(s.uso_canal_pct, 0)} de la capacidad del canal</div></div>
        <div class="metrica ${cob < 100 ? 'alerta' : ''}"><div class="etq">Cupos base cubiertos</div><div class="val">${pct(cob, 0)}</div><div class="sub">${cob < 100 ? 'No alcanza: se reparte en proporción, protegiendo a los más pequeños' : 'Todos reciben su cupo completo'}</div></div>
        <div class="metrica"><div class="etq">Adicional entregado</div><div class="val">${m3(s.adicional_m3)}</div><div class="sub">Compra o almacenamiento</div></div>
        <div class="metrica destacada"><div class="etq">Sin asignar</div><div class="val">${m3(s.sin_asignar_m3)}</div><div class="sub">${s.sin_asignar_m3 > 1 ? 'Todos llegaron a su máximo' : 'Se usa toda el agua'}</div></div>`;
    const V = s.volumen_m3 || 1;
    const seg = (cls, v, t) => (v > 0 ? `<span class="${cls}" style="width:${(v / V) * 100}%" title="${esc(t)}: ${entero(v)} m³">${(v / V) > 0.08 ? `${esc(t)} ${numero((v / V) * 100, 0)} %` : ''}</span>` : '');
    document.getElementById('sim-barra').innerHTML = `<div class="sim-pista">${seg('parc', s.parceleros_m3, 'Parceleros')}${seg('fundo', s.fundos_m3, 'Fundos')}${seg('libre', s.sin_asignar_m3, 'Sin asignar')}</div>`;
    document.getElementById('sim-tbody').innerHTML = s.detalle.map(d => {
        const basePct = d.maximo > 0 ? (d.cupo_base / d.maximo) * 100 : 0;
        const recibe = d.maximo > 0 ? Math.min(100, (d.total / d.maximo) * 100) : 0;
        const estado = d.cubre_pct < 99.5 ? `<span class="chip rechazado">Recibe ${numero(d.cubre_pct, 0)} % de su cupo</span>`
            : d.adicional > 0.5 && Math.abs(d.total - d.maximo) < 1 ? '<span class="chip ok">Cupo + adicional completo</span>'
            : '<span class="chip agua sin-punto">Cupo completo</span>';
        return `<tr>
            <td><strong>${esc(d.nombre)}</strong><div class="small muted">${d.tipo === 'empresa' ? 'Fundo' : 'Parcelero'} · ${numero(d.hectareas)} ha</div></td>
            <td class="der num">${entero(d.cupo_base)} m³</td>
            <td><div class="cupo-barra"><span class="lleno ${d.cubre_pct < 99.5 ? 'corto' : ''}" style="width:${recibe}%"></span><span class="marca-base" style="left:${basePct}%"></span></div>
                <div class="small muted">${entero(d.total)} m³ de ${entero(d.maximo)} posibles</div></td>
            <td class="der num">${d.adicional > 0 ? `+${entero(d.adicional)} m³` : '–'}</td>
            <td class="der num">${pct(d.pct_canal)}</td>
            <td>${estado}${d.limitado && d.cubre_pct < 99.5 ? '<div class="small texto-arena">Frenado por su límite de participación para proteger a los demás</div>' : ''}</td>
        </tr>`;
    }).join('');
}

// ================================================================ Eventos
export function iniciarGerencia() {
    document.getElementById('ger-tabs').addEventListener('click', e => {
        const b = e.target.closest('[data-gtab]');
        if (!b) return;
        tab = b.dataset.gtab;
        cargarGerencia().catch(err => toast(err.message, 'error'));
    });
    document.getElementById('ger-periodo').addEventListener('click', e => {
        const b = e.target.closest('[data-meses]');
        if (!b) return;
        meses = Number(b.dataset.meses);
        document.querySelectorAll('#ger-periodo [data-meses]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        cargarFinanzas().catch(err => toast(err.message, 'error'));
    });
    document.getElementById('fm-tipo').addEventListener('click', e => {
        const b = e.target.closest('[data-tipo-mov]');
        if (!b) return;
        tipoMov = b.dataset.tipoMov;
        document.querySelectorAll('#fm-tipo [data-tipo-mov]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        pintarCategorias();
    });
    const fm = document.getElementById('form-mov');
    fm.fecha.value = hoyLima();
    fm.fecha.max = hoyLima();
    fm.addEventListener('submit', guardarMovimiento);
    document.getElementById('tbody-mov').addEventListener('click', async e => {
        const b = e.target.closest('[data-borrar-mov]');
        if (!b) return;
        const ok = await confirmar({ titulo: 'Eliminar movimiento', mensaje: 'El movimiento se borrará y los totales se recalcularán.', aceptar: 'Eliminar', peligro: true });
        if (!ok) return;
        try { await del(`/gerencia/movimientos/${b.dataset.borrarMov}`); toast('Movimiento eliminado.', 'ok'); cargarFinanzas(); } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('sim-lps').addEventListener('input', simular);
    document.getElementById('sim-horas').addEventListener('change', simular);
    document.getElementById('sim-presets').addEventListener('click', e => {
        const b = e.target.closest('[data-preset]');
        if (!b) return;
        document.getElementById('sim-lps').value = b.dataset.preset;
        simular();
    });
    window.addEventListener('tema-cambiado', () => { if (estado.vista === 'gerencia' && tab === 'finanzas') pintarGraficosFin(); });
}
