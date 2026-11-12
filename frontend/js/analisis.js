// =====================================================================
//  Vista "Análisis de caudal"
// =====================================================================
import { get } from './api.js';
import { estado } from './estado.js';
import { numero, toast, hoyLima } from './ui.js';
import { dibujar, opcionesBase, temaGraficos } from './graficos.js';

let rango = null;
let ultimos = [];

export async function cargarAnalisis() {
    if (!estado.clienteId) return;
    const p = new URLSearchParams({ cliente_id: estado.clienteId });
    if (rango) { p.set('desde', rango.desde); p.set('hasta', rango.hasta); }
    ultimos = await get(`/caudal/grafico?${p}`);
    pintar();
}

function pintar() {
    const datos = ultimos;
    const t = temaGraficos();
    const etiquetas = datos.map(d => d.fecha.slice(5, 16).replace(' ', ' · '));
    const lps = datos.map(d => d.lps);
    const resumen = document.getElementById('g-resumen');
    if (datos.length) {
        const prom = lps.reduce((a, b) => a + b, 0) / lps.length;
        resumen.textContent = `${datos.length} lecturas · promedio ${numero(prom)} L/s · máximo ${numero(Math.max(...lps))} L/s`;
    } else {
        resumen.textContent = rango ? 'Sin lecturas en ese rango.' : 'Sin lecturas en los últimos 30 días.';
    }

    dibujar('graf-lps', {
        type: 'line',
        data: {
            labels: etiquetas,
            datasets: [
                {
                    label: 'Caudal', data: lps, borderColor: t.agua, borderWidth: 2.5, tension: 0.3, pointRadius: datos.length > 40 ? 0 : 3,
                    pointBackgroundColor: t.agua, fill: true,
                    backgroundColor: ctx => {
                        const { chart } = ctx; const { ctx: c, chartArea } = chart;
                        if (!chartArea) return 'transparent';
                        const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                        g.addColorStop(0, `${t.agua}55`); g.addColorStop(1, `${t.agua}00`);
                        return g;
                    },
                },
                { label: 'Umbral óptimo', data: datos.map(() => 14), borderColor: t.arena, borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, fill: false },
            ],
        },
        options: { ...opcionesBase({ unidadY: 'L/s' }), plugins: { ...opcionesBase({ unidadY: 'L/s' }).plugins, legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 12, usePointStyle: true } } } },
    });

    dibujar('graf-m3', {
        type: 'bar',
        data: { labels: etiquetas, datasets: [{ label: 'Volumen', data: datos.map(d => d.m3_dia), backgroundColor: `${t.arena}cc`, borderRadius: 6, maxBarThickness: 28 }] },
        options: opcionesBase({ unidadY: 'm³' }),
    });
}

export function iniciarAnalisis() {
    const hoy = hoyLima();
    document.getElementById('g-desde').max = hoy;
    document.getElementById('g-hasta').max = hoy;
    document.getElementById('form-rango').addEventListener('submit', e => {
        e.preventDefault();
        const desde = document.getElementById('g-desde').value;
        const hasta = document.getElementById('g-hasta').value;
        if (!desde || !hasta) return toast('Elige las dos fechas del rango.', 'aviso');
        if (desde > hasta) return toast('La fecha "desde" no puede ser posterior a "hasta".', 'aviso');
        rango = { desde, hasta };
        cargarAnalisis().catch(err => toast(err.message, 'error'));
    });
    window.addEventListener('tema-cambiado', () => { if (estado.vista === 'analisis') pintar(); });
}
