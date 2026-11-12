// Helpers de Chart.js con los colores del tema
import { cssVar } from './ui.js';

const instancias = new Map();

export function temaGraficos() {
    return {
        texto: cssVar('--text-2'),
        tenue: cssVar('--text-3'),
        linea: cssVar('--line'),
        agua: cssVar('--agua'),
        arena: cssVar('--arena'),
        superficie: cssVar('--surface-3'),
        fuente: "'Public Sans', system-ui, sans-serif",
    };
}

export function dibujar(id, config) {
    const lienzo = document.getElementById(id);
    if (!lienzo || !window.Chart) return null;
    instancias.get(id)?.destroy();
    const t = temaGraficos();
    Chart.defaults.font.family = t.fuente;
    Chart.defaults.color = t.texto;
    const g = new Chart(lienzo.getContext('2d'), config);
    instancias.set(id, g);
    return g;
}

export function opcionesBase({ unidadY = '', apilado = false } = {}) {
    const t = temaGraficos();
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: cssVar('--surface-3'), titleColor: cssVar('--text'), bodyColor: cssVar('--text'),
                borderColor: cssVar('--line-strong'), borderWidth: 1, padding: 10, cornerRadius: 8, displayColors: false,
                callbacks: { label: c => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString('es-PE', { maximumFractionDigits: 2 })} ${unidadY}` },
            },
        },
        scales: {
            x: { stacked: apilado, grid: { display: false }, ticks: { color: t.tenue, maxRotation: 0, autoSkipPadding: 14 }, border: { color: t.linea } },
            y: { stacked: apilado, beginAtZero: true, grid: { color: t.linea }, ticks: { color: t.tenue }, border: { display: false } },
        },
    };
}

export function redibujarTodo() {
    // Al cambiar de tema, se vuelven a dibujar desde cada vista
    window.dispatchEvent(new Event('tema-cambiado'));
}
