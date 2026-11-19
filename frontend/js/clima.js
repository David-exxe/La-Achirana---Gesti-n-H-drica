// =====================================================================
//  Vista "Lluvias en la sierra"
//   - Perfil del río (Choclococha → bocatoma → Ica) con la lluvia del día
//   - Simulación de llegada del agua
//   - Mapa de la cuenca (mapa / satélite / nubes MODIS)
//   - Lluvia en movimiento: malla horaria animada (/api/clima/lluvia)
//   - Caudal modelado GloFAS
// =====================================================================
import { get, post } from './api.js';
import { estado, esPersonal } from './estado.js';
import { esc, numero, fechaHora, diaSemana, hoyLima, NIVEL, colorNivel, toast, conCarga } from './ui.js';
import { dibujar, opcionesBase, temaGraficos } from './graficos.js';

let diaSel = null;
let mapa = null;
let capas = {};
let fondo = 'mapa';
let vistaMapa = 'cuenca';
// Lluvia en movimiento
const lluvia = { mapa: null, capa: null, datos: null, imagenes: [], frame: 0, timer: null, vel: 450, cargado: 0 };

// ---------- Pronóstico (servidor y, si falla, consulta directa del navegador) ----------
let fuentesClima = null;
let climaEnCurso = null;

async function abrirDirecto(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Open-Meteo respondió ${r.status}`);
    return r.json();
}

/**
 * Si Open-Meteo bloquea la IP compartida del servidor (HTTP 429), el navegador
 * consulta con su propia conexión y el servidor solo procesa los datos.
 */
async function climaDesdeNavegador() {
    fuentesClima ||= await get('/clima/fuentes');
    const [p, c] = await Promise.allSettled([abrirDirecto(fuentesClima.pronostico), abrirDirecto(fuentesClima.caudal)]);
    if (p.status === 'rejected') throw p.reason;
    const lista = Array.isArray(p.value) ? p.value : [p.value];
    return post('/clima/resumen-externo', {
        pronosticos: lista.map(x => ({ daily: x.daily, hourly: { time: x.hourly.time, precipitation: x.hourly.precipitation } })),
        caudal: c.status === 'fulfilled' && c.value?.daily ? { daily: c.value.daily } : null,
    });
}

async function mallaDesdeNavegador() {
    fuentesClima ||= await get('/clima/fuentes');
    const r = await abrirDirecto(fuentesClima.malla);
    const lista = Array.isArray(r) ? r : [r];
    const horas = lista[0].hourly.time;
    const valores = horas.map((_, h) => lista.map(x => Math.max(0, Number(x.hourly.precipitation[h]) || 0)));
    return post('/clima/lluvia-externo', { horas, valores });
}

export function obtenerClima(forzar = false) {
    // Una sola consulta a la vez (la franja de alerta y la vista piden lo mismo)
    if (climaEnCurso && !forzar) return climaEnCurso;
    climaEnCurso = (async () => {
        try {
            estado.clima = await get(`/clima/resumen${forzar ? '?forzar=1' : ''}`);
        } catch (err) {
            if (err.estado !== 503) throw err;
            try { estado.clima = await climaDesdeNavegador(); }
            catch (e2) { console.warn('Respaldo de clima falló:', e2.message); throw err; }
        }
        return estado.clima;
    })().finally(() => { climaEnCurso = null; });
    return climaEnCurso;
}

export async function cargarClima(forzar = false) {
    crearMapa();                       // el mapa se ve aunque el pronóstico no cargue
    if (vistaMapa === 'lluvia') cargarLluvia(forzar).catch(() => {});
    const c = forzar || !estado.clima ? await obtenerClima(forzar) : estado.clima;
    const futuros = diasFuturos(c);
    if (!diaSel || !futuros.includes(diaSel)) {
        diaSel = c.alerta?.fecha && futuros.includes(c.alerta.fecha) ? c.alerta.fecha : futuros[0];
    }
    document.getElementById('clima-actualizado').textContent =
        `${c.simulacion ? 'Simulación · ' : ''}Actualizado ${fechaHora(c.actualizado)}${c.desactualizado ? ' (sin conexión, mostrando último dato)' : ''}`;
    const temp = document.getElementById('cuenca-temporada');
    temp.textContent = c.temporada.texto;
    temp.className = `chip ${c.temporada.clave === 'lluvias' ? 'nivel-naranja' : 'agua'}`;
    document.getElementById('cuenca-titulo').textContent = c.alerta.nivel === 'verde' ? 'La cuenca alta está tranquila' : c.alerta.titulo;
    document.getElementById('cuenca-texto').textContent = c.alerta.mensaje;

    pintarChips(c);
    pintarPerfil(c);
    pintarLlegada(c);
    pintarMatriz(c);
    pintarRio(c);
    pintarMetodo(c);
    iniciarMapa(c);
}

const diasFuturos = c => (c.puntos.find(p => p.tipo === 'sierra')?.dias || []).filter(d => !d.pasado).map(d => d.fecha);

function pintarChips(c) {
    const sierra = c.puntos.filter(p => p.tipo === 'sierra');
    const cont = document.getElementById('dias-chips');
    cont.innerHTML = diasFuturos(c).map(f => {
        const max = Math.max(0, ...sierra.map(p => p.dias.find(d => d.fecha === f)?.precip_mm || 0));
        const niv = sierra.map(p => p.dias.find(d => d.fecha === f)?.nivel || 'verde')
            .reduce((a, b) => (['verde', 'amarillo', 'naranja', 'rojo'].indexOf(b) > ['verde', 'amarillo', 'naranja', 'rojo'].indexOf(a) ? b : a), 'verde');
        const etiqueta = f === hoyLima() ? 'hoy' : diaSemana(f);
        return `<button type="button" class="dia-chip" data-dia="${esc(f)}" aria-pressed="${f === diaSel}">
            <span class="d1">${esc(etiqueta)} ${esc(f.slice(8))}</span>
            <span class="d2">${numero(max, 1)} mm</span>
            <span class="barra" style="background:${colorNivel(niv)}"></span>
        </button>`;
    }).join('');
}

// ---------- Perfil del río (SVG) ----------
function pintarPerfil(c) {
    const W = 1000, H = 360, padX = 110, top = 110, base = 300;
    const sierra = c.puntos.filter(p => p.tipo === 'sierra');
    const boc = c.puntos.find(p => p.tipo === 'bocatoma');
    const valle = c.puntos.find(p => p.tipo === 'valle');
    if (!sierra.length || !boc) {
        document.getElementById('perfil-contenedor').innerHTML = '<p class="cargando">Configura al menos un punto de sierra y la bocatoma en el Panel.</p>';
        return;
    }
    const maxDist = Math.max(...sierra.map(p => p.distancia_rio_km));
    const extra = valle ? valle.distancia_rio_km : 0;
    const total = maxDist + extra || 1;
    const maxAlt = Math.max(...c.puntos.map(p => p.altitud_m)) + 300;
    const xDe = p => padX + ((p.tipo === 'sierra' ? maxDist - p.distancia_rio_km : p.tipo === 'bocatoma' ? maxDist : maxDist + p.distancia_rio_km) / total) * (W - padX * 2);
    const yDe = alt => base - (alt / maxAlt) * (base - top);

    const nodos = [...sierra, boc, ...(valle ? [valle] : [])].map(p => ({ p, x: xDe(p), y: yDe(p.altitud_m) })).sort((a, b) => a.x - b.x);
    // Curva suave (Catmull-Rom → Bézier)
    const pts = [{ x: padX - 30, y: nodos[0].y - 6 }, ...nodos, { x: W - padX + 30, y: nodos[nodos.length - 1].y + 4 }];
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
    }
    const area = `${d} L${pts[pts.length - 1].x},${base + 30} L${pts[0].x},${base + 30} Z`;

    // Eje de altitudes
    const marcas = [0, 1000, 2000, 3000, 4000].filter(a => a < maxAlt);
    const eje = marcas.map(a => `<line class="eje" x1="6" x2="${W - padX + 30}" y1="${yDe(a)}" y2="${yDe(a)}" stroke-dasharray="2 6"/>
        <text class="eje-txt" x="8" y="${yDe(a) - 4}" text-anchor="start">${a.toLocaleString('es-PE')} m</text>`).join('');

    let peor = null;
    const marcadores = nodos.map(({ p, x, y }, i) => {
        const dia = p.dias.find(z => z.fecha === diaSel) || { precip_mm: 0, nivel: 'verde' };
        const col = colorNivel(dia.nivel);
        const alto = Math.min(90, dia.precip_mm * 2.4);
        const esSierra = p.tipo === 'sierra';
        if (esSierra && !p.regulado && dia.nivel !== 'verde' && (!peor || dia.precip_mm > peor.mm)) peor = { x, y, mm: dia.precip_mm };
        // Solo la sierra lleva barra de lluvia (en el valle casi no llueve y no genera avenida)
        const barra = esSierra
            ? `<rect x="${x - 9}" y="${y - 14 - alto}" width="18" height="${Math.max(2, alto)}" rx="5" fill="${col}" opacity="${dia.nivel === 'verde' ? 0.45 : 0.95}"/>
               <text class="p-mm" x="${x}" y="${y - 22 - alto}" text-anchor="middle" fill="${col}">${numero(dia.precip_mm, 1)} mm</text>` : '';
        // Etiquetas: la primera se alinea a la izquierda, la última a la derecha y por encima
        const ultimo = i === nodos.length - 1 && p.tipo === 'valle';
        const vecinoCerca = !ultimo && i > 0 && nodos[i + 1] && nodos[i + 1].x - x < 170;
        const ancla = i === 0 ? 'start' : ultimo || vecinoCerca ? 'end' : 'middle';
        const lx = i === 0 ? x - 12 : ultimo ? x + 8 : vecinoCerca ? x - 12 : x;
        const ly = ultimo ? y - 40 : y + 22;
        const viaje = esSierra && p.viaje
            ? `<text class="p-viaje" x="${lx}" y="${ly + 28}" text-anchor="${ancla}">${p.regulado ? 'laguna regulada' : `≈ ${numero(p.viaje.min_h, 0)}–${numero(p.viaje.max_h, 0)} h de viaje`}</text>` : '';
        const icono = p.tipo === 'bocatoma' ? 'M-6,-6 h12 v12 h-12 Z' : null;
        return `<g>
            ${barra}
            ${icono ? `<path d="${icono}" transform="translate(${x},${y})" style="fill:var(--arena);stroke:var(--surface)" stroke-width="2"/>`
                    : `<circle cx="${x}" cy="${y}" r="6.5" style="fill:var(--surface);stroke:${esSierra ? col : 'var(--agua)'}" stroke-width="3"/>`}
            <text class="p-nombre" x="${lx}" y="${ly}" text-anchor="${ancla}">${esc(p.nombre)}</text>
            <text class="p-alt" x="${lx}" y="${ly + 14}" text-anchor="${ancla}">${p.altitud_m.toLocaleString('es-PE')} m</text>
            ${viaje}
        </g>`;
    }).join('');

    // Pulso de agua: un solo movimiento, desde el peor punto hacia la bocatoma
    const reducir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let pulso = '';
    if (peor && !reducir) {
        const bx = xDe(boc), by = yDe(boc.altitud_m);
        const tramo = nodos.filter(n => n.x >= peor.x && n.x <= bx);
        const camino = tramo.map((n, i) => `${i ? 'L' : 'M'}${n.x},${n.y}`).join(' ');
        pulso = `<path id="tramo-pulso" d="${camino}" fill="none" stroke="none"/>
            <circle r="6" class="pulso"><animateMotion dur="3.2s" repeatCount="indefinite" rotate="auto"><mpath href="#tramo-pulso"/></animateMotion></circle>`;
    }

    document.getElementById('perfil-contenedor').innerHTML = `
        <svg class="perfil-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Perfil esquemático del río Ica con la lluvia prevista para el día elegido">
            <defs>
                <linearGradient id="gradCuenca" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style="stop-color:var(--agua);stop-opacity:.22"/>
                    <stop offset="1" style="stop-color:var(--agua);stop-opacity:0"/>
                </linearGradient>
            </defs>
            ${eje}
            <path class="rio-area" d="${area}"/>
            <path class="rio-linea" d="${d}"/>
            ${pulso}
            ${marcadores}
        </svg>`;

    const [a, n, r] = c.umbrales_mm;
    document.getElementById('cuenca-leyenda').innerHTML = `
        <span><i class="cuadro" style="background:${colorNivel('verde')}"></i> menos de ${a} mm</span>
        <span><i class="cuadro" style="background:${colorNivel('amarillo')}"></i> ${a}–${n} mm moderada</span>
        <span><i class="cuadro" style="background:${colorNivel('naranja')}"></i> ${n}–${r} mm fuerte</span>
        <span><i class="cuadro" style="background:${colorNivel('rojo')}"></i> más de ${r} mm muy fuerte</span>
        <span class="muted">Perfil esquemático: Tambo y Santiago son afluentes distintos que forman el río Ica.</span>`;
}

function pintarLlegada(c) {
    const cont = document.getElementById('llegada');
    const llegadas = c.puntos
        .filter(p => p.tipo === 'sierra' && !p.regulado)
        .map(p => ({ p, d: p.dias.find(z => z.fecha === diaSel) }))
        .filter(x => x.d?.llegada)
        .sort((a, b) => a.d.llegada.desde.localeCompare(b.d.llegada.desde));
    const reguladas = c.puntos.filter(p => p.tipo === 'sierra' && p.regulado && (p.dias.find(z => z.fecha === diaSel)?.nivel || 'verde') !== 'verde');

    if (!llegadas.length) {
        cont.innerHTML = `
            <div class="icono" style="background:color-mix(in srgb, ${colorNivel('verde')} 16%, transparent);color:${colorNivel('verde')}"><i class="fa-solid fa-water"></i></div>
            <div><h3>Sin avenida prevista para ${esc(diaSel === hoyLima() ? 'hoy' : fechaLarga(diaSel))}</h3>
            <p>La lluvia prevista en las cabeceras no alcanza el umbral de ${c.umbrales_mm[0]} mm que usamos para estimar escorrentía hacia el río.${reguladas.length ? ` En ${esc(reguladas.map(p => p.nombre).join(', '))} sí llovería, pero el agua queda almacenada y se libera según la operación del sistema.` : ''}</p></div>`;
        return;
    }
    const primera = llegadas[0];
    const niv = llegadas.reduce((m, x) => (['verde', 'amarillo', 'naranja', 'rojo'].indexOf(x.d.nivel) > ['verde', 'amarillo', 'naranja', 'rojo'].indexOf(m) ? x.d.nivel : m), 'verde');
    const col = colorNivel(niv);
    cont.innerHTML = `
        <div class="icono" style="background:color-mix(in srgb, ${col} 20%, transparent);color:${col}"><i class="fa-solid ${NIVEL[niv].icono}"></i></div>
        <div>
            <h3>El agua llegaría a la bocatoma desde el ${esc(fechaHora(primera.d.llegada.desde))}</h3>
            <p>${llegadas.map(({ p, d }) => `<strong>${esc(p.nombre)}</strong> (${numero(d.precip_mm, 1)} mm, lluvia centrada a las ${String(Math.floor(d.llegada.hora_centro_lluvia)).padStart(2, '0')}:00): bocatoma entre ${esc(fechaHora(d.llegada.desde))} y ${esc(fechaHora(d.llegada.hasta))}${d.llegada.ciudad_desde ? `; ciudad de Ica entre ${esc(fechaHora(d.llegada.ciudad_desde))} y ${esc(fechaHora(d.llegada.ciudad_hasta))}` : ''}`).join('<br>')}</p>
        </div>`;
}

const fechaLarga = f => new Date(`${f}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima' });

function pintarMatriz(c) {
    const dias = c.puntos[0]?.dias || [];
    const filas = c.puntos.map(p => `
        <tr>
            <th class="punto" scope="row">${esc(p.nombre)}<small>${p.altitud_m.toLocaleString('es-PE')} m${p.regulado ? ' · regulada' : ''}</small></th>
            ${p.dias.map(d => `<td class="n-${d.nivel} ${d.pasado ? 'pasado' : ''}" title="${esc(NIVEL[d.nivel].txt)}">${numero(d.precip_mm, 1)}${d.probabilidad != null ? `<small>${d.probabilidad}%</small>` : ''}</td>`).join('')}
        </tr>`).join('');
    document.getElementById('matriz').innerHTML = `
        <thead><tr><th></th>${dias.map(d => `<th>${esc(d.fecha === hoyLima() ? 'Hoy' : diaSemana(d.fecha))}<br>${esc(d.fecha.slice(8))}/${esc(d.fecha.slice(5, 7))}</th>`).join('')}</tr></thead>
        <tbody>${filas}</tbody>`;
}

function pintarRio(c) {
    const nota = document.getElementById('rio-nota');
    if (!c.rio) {
        nota.textContent = `No se pudo obtener el caudal modelado${c.error_rio ? ` (${c.error_rio})` : ''}.`;
        return;
    }
    const t = temaGraficos();
    const hoy = hoyLima();
    const idxHoy = c.rio.fechas.indexOf(hoy);
    dibujar('graf-rio', {
        type: 'line',
        data: {
            labels: c.rio.fechas.map(f => f.slice(5)),
            datasets: [
                {
                    label: 'Caudal', data: c.rio.caudal, borderColor: t.agua, borderWidth: 2.2, pointRadius: 0, tension: 0.3, fill: true,
                    backgroundColor: `${t.agua}22`,
                    segment: { borderDash: ctx => (idxHoy >= 0 && ctx.p0DataIndex >= idxHoy ? [5, 4] : undefined) },
                },
                ...(c.rio.media ? [{ label: 'Media histórica', data: c.rio.media, borderColor: t.arena, borderWidth: 1.4, borderDash: [2, 4], pointRadius: 0, fill: false }] : []),
            ],
        },
        options: { ...opcionesBase({ unidadY: 'm³/s' }), plugins: { ...opcionesBase({ unidadY: 'm³/s' }).plugins, legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 12, usePointStyle: true } } } },
    });
    nota.textContent = `${c.rio.nota} Línea punteada: pronóstico. Hoy: ${c.rio.hoy != null ? `${numero(c.rio.hoy)} m³/s` : 's/d'} · pico previsto 30 días: ${c.rio.pico_30d != null ? `${numero(c.rio.pico_30d)} m³/s` : 's/d'}.`;
}

function pintarMetodo(c) {
    const [vmin, vmax] = c.velocidad_ms;
    const filas = c.puntos.filter(p => p.viaje).map(p =>
        `<li><strong>${esc(p.nombre)}</strong>: ${numero(p.distancia_rio_km, 0)} km de cauce, pendiente ${numero(p.viaje.pendiente_pct, 1)} %, Kirpich ${numero(p.viaje.kirpich_h, 1)} h → ${numero(p.viaje.min_h, 1)}–${numero(p.viaje.max_h, 1)} h${p.regulado ? ' (laguna regulada: no se usa para avenidas)' : ''}</li>`).join('');
    document.getElementById('metodo').innerHTML = `
        <p>Es una <strong>estimación</strong>, no una medición. Sirve para anticipar, no reemplaza los avisos de SENAMHI ni el aforo en la bocatoma.</p>
        <ol>
            <li>Tomamos la lluvia pronosticada por hora en cada cabecera (${esc(c.fuente)}) y su hora central del día.</li>
            <li>El tiempo de viaje es el rango entre el tiempo de concentración de Kirpich <code>tc = 0.0195 · L^0.77 · S^-0.385</code> y la distancia dividida entre una velocidad de avenida de ${numero(vmin, 1)} a ${numero(vmax, 1)} m/s.</li>
            <li>Solo se estima llegada cuando la lluvia del día supera ${c.umbrales_mm[0]} mm.</li>
        </ol>
        <ul style="margin:0;padding-left:20px;display:grid;gap:4px">${filas}</ul>
        <p class="small">Distancias y umbrales se ajustan en el Panel de control y en el archivo .env.</p>`;
}

// ---------- Mapa de la cuenca ----------
const fechaAyer = () => new Date(Date.now() - 5 * 3600e3 - 86400e3).toISOString().slice(0, 10);

function capaFondo() {
    if (fondo === 'satelite') {
        return L.layerGroup([
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 17, attribution: 'Imágenes &copy; Esri, Maxar, Earthstar' }),
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 17, opacity: 0.9 }),
        ]);
    }
    if (fondo === 'osm') {
        return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap' });
    }
    // Mapa base sin llave (Esri Canvas): gris oscuro o claro según el tema
    const tono = document.documentElement.dataset.theme === 'light' ? 'Light' : 'Dark';
    const esri = s => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${tono}_Gray_${s}/MapServer/tile/{z}/{y}/{x}`;
    return L.layerGroup([
        L.tileLayer(esri('Base'), { maxZoom: 16, attribution: 'Mapa &copy; Esri, HERE, Garmin, &copy; OpenStreetMap' }),
        L.tileLayer(esri('Reference'), { maxZoom: 16 }),
    ]);
}

/** Si el proveedor del fondo falla varias veces, se cambia a OpenStreetMap. */
function vigilarFondo(m, ref) {
    let errores = 0;
    const capas = ref.base.getLayers ? ref.base.getLayers() : [ref.base];
    capas.forEach(l => l.on('tileerror', () => {
        if (++errores === 6 && fondo === 'mapa') {
            console.warn('Fondo del mapa sin respuesta: se usa OpenStreetMap');
            fondo = 'osm';
            ponerFondo(m, ref);
            fondo = 'mapa';
        }
    }));
}

/** Leaflet calcula mal el tamaño si el mapa nace oculto: se corrige al cambiar el tamaño del contenedor. */
function encuadrar(m) {
    const el = m.getContainer();
    if (!m._encuadre || !el.clientWidth || !el.clientHeight) return;   // se reintenta cuando sea visible
    m.invalidateSize({ pan: false });
    m.fitBounds(m._encuadre, { padding: [50, 50], maxZoom: 10 });
    m._encuadre = null;
}

function vigilarTamano(m, el) {
    let ancho = 0;
    const alCambiar = () => {
        m.invalidateSize({ pan: false });
        // Si el ancho cambia mucho (giro del celular, panel que se abre), se vuelve a encuadrar
        if (ancho && m._base && Math.abs(el.clientWidth - ancho) / ancho > 0.25) m._encuadre = m._base;
        if (el.clientWidth) ancho = el.clientWidth;
        encuadrar(m);
    };
    if ('ResizeObserver' in window) new ResizeObserver(alCambiar).observe(el);
    else window.addEventListener('resize', () => m.invalidateSize());
}

function ponerFondo(m, ref) {
    if (ref.base) m.removeLayer(ref.base);
    ref.base = capaFondo().addTo(m);
    ref.base.eachLayer ? ref.base.eachLayer(l => l.setZIndex?.(0)) : ref.base.setZIndex?.(0);
    if (fondo === 'mapa') vigilarFondo(m, ref);
}

function crearMapa() {
    if (!window.L || mapa) return;
    {
        const el = document.getElementById('mapa-leaflet');
        mapa = L.map(el, { zoomControl: false, scrollWheelZoom: false, attributionControl: true }).setView([-13.75, -75.35], 8);
        L.control.zoom({ position: 'topright' }).addTo(mapa);
        ponerFondo(mapa, capas);
        vigilarTamano(mapa, el);
    }
}

function iniciarMapa(c) {
    if (!window.L) { document.getElementById('mapa-leaflet').innerHTML = '<p class="cargando">No se pudo cargar el mapa.</p>'; return; }
    crearMapa();
    capas.puntos?.remove();
    capas.puntos = L.layerGroup().addTo(mapa);
    const boc = c.puntos.find(p => p.tipo === 'bocatoma');
    if (boc) {
        c.puntos.filter(p => p.tipo === 'sierra').forEach(p => {
            L.polyline([[p.latitud, p.longitud], [boc.latitud, boc.longitud]], { color: '#3fc1c9', weight: 2, dashArray: '2 8', lineCap: 'round', opacity: 0.85 }).addTo(capas.puntos);
        });
    }
    c.puntos.forEach(p => {
        const dia = p.dias.find(d => d.fecha === diaSel) || {};
        const col = p.tipo === 'sierra' ? colorNivel(dia.nivel || 'verde') : (p.tipo === 'bocatoma' ? '#e3b866' : '#3fc1c9');
        L.circleMarker([p.latitud, p.longitud], { radius: p.tipo === 'sierra' ? 10 : 8, color: '#ffffff', weight: 2.5, fillColor: col, fillOpacity: 1 })
            .bindTooltip(`${esc(p.nombre)} · ${numero(dia.precip_mm || 0, 1)} mm`, { direction: 'top', offset: [0, -8] })
            .bindPopup(`<strong>${esc(p.nombre)}</strong><br>${p.altitud_m.toLocaleString('es-PE')} m<br>
                Lluvia: <b>${numero(dia.precip_mm || 0, 1)} mm</b>${dia.probabilidad != null ? ` · ${dia.probabilidad}%` : ''}<br>
                7 días: ${numero(p.acumulado_7d, 1)} mm
                ${p.viaje && !p.regulado ? `<br>Llega en ${numero(p.viaje.min_h, 0)}–${numero(p.viaje.max_h, 0)} h` : ''}`)
            .addTo(capas.puntos);
    });
    if (!capas.encuadrado && c.puntos.length > 1) {
        capas.encuadrado = true;
        mapa._encuadre = mapa._base = L.latLngBounds(c.puntos.map(p => [p.latitud, p.longitud]));
        encuadrar(mapa);
    }
    requestAnimationFrame(() => mapa.invalidateSize());
}

function alternarFondo(nuevo) {
    fondo = nuevo;
    document.querySelectorAll('[data-fondo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fondo === fondo)));
    if (mapa) ponerFondo(mapa, capas);
    if (lluvia.mapa) ponerFondo(lluvia.mapa, lluvia);
}

function mostrarMapa(tipo) {
    vistaMapa = tipo;
    document.querySelectorAll('[data-mapa]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapa === tipo)));
    document.getElementById('mapa-cuenca').classList.toggle('hidden', tipo !== 'cuenca');
    document.getElementById('mapa-lluvia-vista').classList.toggle('hidden', tipo !== 'lluvia');
    document.getElementById('mapa-nasa-vista').classList.toggle('hidden', tipo !== 'nasa');
    document.getElementById('mapa-windy-vista').classList.toggle('hidden', tipo !== 'windy');
    if (tipo !== 'lluvia') pausar();
    if (tipo !== 'nasa') pausarNasa();
    if (tipo === 'lluvia') cargarLluvia().catch(err => toast(err.message, 'error'));
    else if (tipo === 'nasa') iniciarNasa();
    else if (tipo === 'windy') iniciarWindy();
    else requestAnimationFrame(() => mapa?.invalidateSize());
}

// ---------- Satélite NASA (GIBS) ----------
// Lluvia: GPM IMERG cada 30 min (capa IMERG_Precipitation_Rate_30min, nivel máx. 6, ~6-7 h de retraso).
// Nubes: foto en color real del día anterior (MODIS Terra/Aqua o VIIRS).
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const PASOS_NASA = 48;                          // 24 h en pasos de 30 min
const TRANSPARENTE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const nasa = { mapa: null, base: null, nubes: null, sat: 'MODIS_Terra', imerg: [], frame: PASOS_NASA - 1, verLluvia: true, verNubes: true, timer: null, fin: 0 };

function horasNasa() {
    // Última media hora publicada (con margen de 7 h) y las 23.5 h anteriores
    const fin = Math.floor((Date.now() - 7 * 3600e3) / 1800e3) * 1800e3;
    nasa.fin = fin;
    return Array.from({ length: PASOS_NASA }, (_, i) => new Date(fin - (PASOS_NASA - 1 - i) * 1800e3));
}
const isoGibs = d => d.toISOString().slice(0, 19) + 'Z';      // GIBS exige segundos: 2026-11-19T03:00:00Z

function capaNubes() {
    return L.tileLayer(`${GIBS}/${nasa.sat}_CorrectedReflectance_TrueColor/default/${fechaAyer()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
        maxNativeZoom: 9, maxZoom: 14, opacity: 0.8, errorTileUrl: TRANSPARENTE, attribution: 'NASA GIBS',
    });
}

function capaImerg(i) {
    if (!nasa.imerg[i]) {
        nasa.imerg[i] = L.tileLayer(`${GIBS}/IMERG_Precipitation_Rate_30min/default/${isoGibs(nasa.horas[i])}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, {
            maxNativeZoom: 6, maxZoom: 14, opacity: 0, errorTileUrl: TRANSPARENTE, className: 'capa-imerg', zIndex: 20,
        });
    }
    return nasa.imerg[i];
}

function iniciarNasa() {
    if (!window.L) return;
    if (!nasa.mapa) {
        const el = document.getElementById('mapa-nasa');
        nasa.mapa = L.map(el, { zoomControl: false, scrollWheelZoom: false }).setView([-13.75, -75.35], 7);
        L.control.zoom({ position: 'topright' }).addTo(nasa.mapa);
        ponerFondo(nasa.mapa, nasa);
        vigilarTamano(nasa.mapa, el);
        nasa.marcas = L.layerGroup().addTo(nasa.mapa);
        nasa.mapa._encuadre = nasa.mapa._base = L.latLngBounds([[-14.6, -76.3], [-12.7, -74.4]]);
        encuadrar(nasa.mapa);
        document.getElementById('nasa-escala').innerHTML = '<b>Lluvia satelital</b><span>color más intenso = más lluvia</span>';
    }
    // Las horas se recalculan si pasó media hora desde la última carga
    const fin = Math.floor((Date.now() - 7 * 3600e3) / 1800e3) * 1800e3;
    if (fin !== nasa.fin) {
        nasa.imerg.forEach(l => l && nasa.mapa.removeLayer(l));
        nasa.imerg = [];
        nasa.horas = horasNasa();
        nasa.frame = PASOS_NASA - 1;
    }
    if (!nasa.nubes) { nasa.nubes = capaNubes(); if (nasa.verNubes) nasa.nubes.addTo(nasa.mapa); }
    if (estado.clima) {
        nasa.marcas.clearLayers();
        estado.clima.puntos.forEach(p => L.circleMarker([p.latitud, p.longitud], { radius: 5, color: '#fff', weight: 2, fillColor: p.tipo === 'bocatoma' ? '#e3b866' : '#0f1b26', fillOpacity: 1 })
            .bindTooltip(esc(p.nombre), { direction: 'top' }).addTo(nasa.marcas));
    }
    irANasa(nasa.frame);
    requestAnimationFrame(() => nasa.mapa.invalidateSize());
}

function irANasa(i) {
    nasa.frame = (i + PASOS_NASA) % PASOS_NASA;
    document.getElementById('nasa-slider').value = String(nasa.frame);
    nasa.imerg.forEach((l, k) => l && k !== nasa.frame && l.setOpacity(0));
    if (nasa.verLluvia) {
        const capa = capaImerg(nasa.frame);
        if (!nasa.mapa.hasLayer(capa)) capa.addTo(nasa.mapa);
        capa.setOpacity(0.9);
        // precarga la siguiente para que la animación no parpadee
        const sig = capaImerg((nasa.frame + 1) % PASOS_NASA);
        if (!nasa.mapa.hasLayer(sig)) sig.addTo(nasa.mapa);
    }
    const h = nasa.horas[nasa.frame];
    const hace = Math.round((Date.now() - h.getTime()) / 3600e3);
    document.getElementById('nasa-reloj').innerHTML = `<span class="etq">Satélite</span> ${esc(h.toLocaleString('es-PE', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }))}<small>hace ${hace} h</small>`;
}

function reproducirNasa() {
    pausarNasa();
    const b = document.getElementById('nasa-play');
    b.innerHTML = '<i class="fa-solid fa-pause"></i>'; b.setAttribute('aria-label', 'Pausar');
    nasa.timer = setInterval(() => irANasa(nasa.frame + 1), 600);
}

function pausarNasa() {
    if (nasa.timer) clearInterval(nasa.timer);
    nasa.timer = null;
    const b = document.getElementById('nasa-play');
    if (b) { b.innerHTML = '<i class="fa-solid fa-play"></i>'; b.setAttribute('aria-label', 'Reproducir'); }
}

// ---------- Windy (se carga solo al abrir la pestaña) ----------
function iniciarWindy() {
    const caja = document.getElementById('mapa-windy');
    if (caja.querySelector('iframe')) return;
    const url = 'https://embed.windy.com/embed2.html?lat=-13.85&lon=-75.35&detailLat=-13.83&detailLon=-75.26'
        + '&width=650&height=450&zoom=8&level=surface&overlay=rain&product=ecmwf&menu=&message=true&marker=true'
        + '&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1';
    caja.innerHTML = `<iframe src="${url}" title="Pronóstico de lluvia Windy" loading="lazy" referrerpolicy="no-referrer" allowfullscreen></iframe>`;
}

// ---------- Lluvia en movimiento ----------
// Escala tipo radar (mm/h)
const ESCALA = [
    [0.1, [125, 211, 252]], [0.5, [56, 189, 248]], [1, [37, 99, 235]], [2, [124, 58, 237]],
    [5, [219, 39, 119]], [10, [239, 68, 68]], [20, [250, 204, 21]],
];
function colorMm(v) {
    if (v < ESCALA[0][0]) return null;
    let c = ESCALA[0][1];
    for (const [lim, col] of ESCALA) if (v >= lim) c = col;
    return c;
}

/** Convierte cada hora de la malla en una imagen suavizada (el navegador interpola). */
function imagenesMalla(d) {
    const nx = d.lon.length, ny = d.lat.length, f = 4;
    const cv = document.createElement('canvas');
    cv.width = nx; cv.height = ny;
    const ctx = cv.getContext('2d');
    const grande = document.createElement('canvas');
    grande.width = nx * f * 8; grande.height = ny * f * 8;
    const g = grande.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    return d.valores.map(fila => {
        const img = ctx.createImageData(nx, ny);
        fila.forEach((v, i) => {
            const col = colorMm(v);
            const k = i * 4;          // fila i/nx = latitud (norte→sur), columna = longitud (oeste→este)
            if (col) { img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = Math.min(235, 120 + v * 22); }
        });
        ctx.putImageData(img, 0, 0);
        g.clearRect(0, 0, grande.width, grande.height);
        g.drawImage(cv, 0, 0, grande.width, grande.height);
        return grande.toDataURL('image/png');
    });
}

const horaTxt = h => {
    const d = new Date(`${h}:00-05:00`);
    return d.toLocaleString('es-PE', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' });
};

async function cargarLluvia(forzar = false) {
    const carg = document.getElementById('lluvia-cargando');
    if (!forzar && lluvia.datos && Date.now() - lluvia.cargado < 15 * 60e3) { asegurarMapaLluvia(); return; }
    carg.classList.remove('hidden');
    try {
        let d;
        try { d = await get(`/clima/lluvia${forzar ? '?forzar=1' : ''}`); }
        catch (err) {
            if (err.estado !== 503) throw err;
            try { d = await mallaDesdeNavegador(); }
            catch (e2) { console.warn('Respaldo de lluvia falló:', e2.message); throw err; }
        }
        lluvia.datos = d;
        lluvia.cargado = Date.now();
        lluvia.imagenes = imagenesMalla(d);
        asegurarMapaLluvia();
        const slider = document.getElementById('lluvia-slider');
        slider.max = String(d.horas.length - 1);
        pintarKpisLluvia(d);
        pintarGraficoLluvia(d);
        document.getElementById('lluvia-fuente').innerHTML = `<i class="fa-solid fa-circle-info"></i> ${d.simulacion ? 'Simulación de ejemplo' : 'Open-Meteo · pronóstico horario'}${d.desactualizado ? ' · último dato disponible' : ''}`;
        irAFrame(d.ahora);
    } finally {
        carg.classList.add('hidden');
    }
}

function asegurarMapaLluvia() {
    if (!window.L) return;
    const d = lluvia.datos;
    if (!lluvia.mapa) {
        const el = document.getElementById('mapa-lluvia');
        lluvia.mapa = L.map(el, { zoomControl: false, scrollWheelZoom: false }).setView([-13.65, -75.35], 8);
        L.control.zoom({ position: 'topright' }).addTo(lluvia.mapa);
        ponerFondo(lluvia.mapa, lluvia);
        vigilarTamano(lluvia.mapa, el);
        lluvia.marcas = L.layerGroup().addTo(lluvia.mapa);
        document.getElementById('lluvia-escala').innerHTML = `<b>mm/h</b>${ESCALA.map(([v, c]) => `<span><i class="punto" style="background:rgb(${c.join(',')})"></i>${v}</span>`).join('')}`;
    }
    if (d && !lluvia.capa) {
        const m = d.paso / 2;
        const limites = [[Math.min(...d.lat) - m, Math.min(...d.lon) - m], [Math.max(...d.lat) + m, Math.max(...d.lon) + m]];
        lluvia.capa = L.imageOverlay(lluvia.imagenes[0], limites, { opacity: 0.85, className: 'capa-lluvia', interactive: false }).addTo(lluvia.mapa);
        L.rectangle(limites, { color: '#3fc1c9', weight: 1, dashArray: '3 6', fill: false, opacity: 0.6, interactive: false }).addTo(lluvia.mapa);
        lluvia.mapa._encuadre = lluvia.mapa._base = L.latLngBounds(limites);
        encuadrar(lluvia.mapa);
    }
    // Puntos de referencia (los mismos de la cuenca)
    if (estado.clima && lluvia.marcas) {
        lluvia.marcas.clearLayers();
        estado.clima.puntos.forEach(p => L.circleMarker([p.latitud, p.longitud], { radius: 5, color: '#fff', weight: 2, fillColor: p.tipo === 'bocatoma' ? '#e3b866' : '#0f1b26', fillOpacity: 1 })
            .bindTooltip(esc(p.nombre), { direction: 'top' }).addTo(lluvia.marcas));
    }
    requestAnimationFrame(() => lluvia.mapa.invalidateSize());
}

function irAFrame(i) {
    const d = lluvia.datos;
    if (!d) return;
    lluvia.frame = (i + d.horas.length) % d.horas.length;
    lluvia.capa?.setUrl(lluvia.imagenes[lluvia.frame]);
    document.getElementById('lluvia-slider').value = String(lluvia.frame);
    const s = d.serie[lluvia.frame];
    const rel = lluvia.frame === d.ahora ? 'Ahora' : lluvia.frame < d.ahora ? 'Pasado' : 'Pronóstico';
    document.getElementById('lluvia-reloj').innerHTML = `<span class="etq ${rel === 'Ahora' ? 'ahora' : rel === 'Pasado' ? 'pasado' : ''}">${rel}</span> ${esc(horaTxt(d.horas[lluvia.frame]))}<small>máx ${numero(s.max, 1)} mm/h</small>`;
    lluvia.grafico?.update('none');
}

function reproducir() {
    if (!lluvia.datos) return;
    pausar();
    const btn = document.getElementById('lluvia-play');
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    btn.setAttribute('aria-label', 'Pausar');
    lluvia.timer = setInterval(() => irAFrame(lluvia.frame + 1), lluvia.vel);
}

function pausar() {
    if (lluvia.timer) clearInterval(lluvia.timer);
    lluvia.timer = null;
    const btn = document.getElementById('lluvia-play');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-play"></i>'; btn.setAttribute('aria-label', 'Reproducir'); }
}

function pintarKpisLluvia(d) {
    const r = d.resumen;
    const kpi = (icono, valor, etiqueta, clase = '') => `<div class="kpi-mini ${clase}"><i class="fa-solid ${icono}"></i><div><strong>${valor}</strong><span>${etiqueta}</span></div></div>`;
    document.getElementById('lluvia-kpis').innerHTML = [
        kpi('fa-bolt', `${numero(r.max.mm_h, 1)} <small>mm/h</small>`, r.max.hora ? `Pico · ${esc(horaTxt(r.max.hora))}` : 'Pico', r.max.mm_h >= 5 ? 'alerta' : ''),
        kpi('fa-mountain', `${numero(r.sierra_24h_mm, 1)} <small>mm</small>`, 'Sierra · 24 h'),
        kpi('fa-tree', `${numero(r.valle_24h_mm, 1)} <small>mm</small>`, 'Valle · 24 h'),
        kpi('fa-clock', `${r.horas_con_lluvia_24h} <small>h</small>`, 'Con lluvia · 24 h'),
    ].join('');
}

function pintarGraficoLluvia(d) {
    const t = temaGraficos();
    const base = opcionesBase({ unidadY: 'mm/h' });
    const marcaFrame = {
        id: 'marcaFrame',
        afterDatasetsDraw(chart) {
            const x = chart.scales.x.getPixelForValue(lluvia.frame);
            const { top, bottom } = chart.chartArea;
            const ctx = chart.ctx;
            ctx.save();
            ctx.strokeStyle = t.arena; ctx.lineWidth = 2; ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
            const xa = chart.scales.x.getPixelForValue(d.ahora);
            ctx.strokeStyle = t.tenue; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(xa, top); ctx.lineTo(xa, bottom); ctx.stroke();
            ctx.restore();
        },
    };
    lluvia.grafico = dibujar('graf-lluvia', {
        type: 'bar',
        data: {
            labels: d.horas.map(h => h.slice(11, 13) === '00' ? `${h.slice(8, 10)}/${h.slice(5, 7)}` : `${h.slice(11, 13)}h`),
            datasets: [
                { label: 'Sierra', data: d.serie.map(x => x.sierra), backgroundColor: `${t.agua}cc`, borderRadius: 3, barPercentage: 0.9, categoryPercentage: 1 },
                { type: 'line', label: 'Valle', data: d.serie.map(x => x.valle), borderColor: t.arena, borderWidth: 2, pointRadius: 0, tension: 0.35 },
            ],
        },
        options: {
            ...base,
            onClick: (_e, el, chart) => { const x = chart.scales.x.getValueForPixel(_e.x); if (Number.isFinite(x)) { pausar(); irAFrame(Math.round(x)); } },
            plugins: { ...base.plugins, legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, usePointStyle: true } } },
            scales: { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, autoSkip: true, maxTicksLimit: 12 } } },
        },
        plugins: [marcaFrame],
    });
}

export function iniciarClima() {
    document.getElementById('dias-chips').addEventListener('click', e => {
        const b = e.target.closest('[data-dia]');
        if (!b || !estado.clima) return;
        diaSel = b.dataset.dia;
        pintarChips(estado.clima);
        pintarPerfil(estado.clima);
        pintarLlegada(estado.clima);
        iniciarMapa(estado.clima);
    });
    document.querySelector('.mapa-tabs').addEventListener('click', e => {
        const b = e.target.closest('[data-mapa]');
        if (b) mostrarMapa(b.dataset.mapa);
    });
    document.querySelectorAll('[data-fondo]').forEach(b => b.addEventListener('click', () => alternarFondo(b.dataset.fondo)));
    document.querySelectorAll('[data-nasa]').forEach(b => b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        if (!nasa.mapa) return;
        if (b.dataset.nasa === 'nubes') { nasa.verNubes = on; if (on) nasa.nubes.addTo(nasa.mapa); else nasa.mapa.removeLayer(nasa.nubes); }
        else { nasa.verLluvia = on; if (!on) { pausarNasa(); nasa.imerg.forEach(l => l && l.setOpacity(0)); } else irANasa(nasa.frame); }
    }));
    document.querySelectorAll('[data-sat]').forEach(b => b.addEventListener('click', () => {
        nasa.sat = b.dataset.sat;
        document.querySelectorAll('[data-sat]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        if (!nasa.mapa) return;
        if (nasa.nubes) nasa.mapa.removeLayer(nasa.nubes);
        nasa.nubes = capaNubes();
        if (nasa.verNubes) nasa.nubes.addTo(nasa.mapa);
    }));
    document.getElementById('nasa-play').addEventListener('click', () => (nasa.timer ? pausarNasa() : reproducirNasa()));
    document.getElementById('nasa-slider').addEventListener('input', e => { pausarNasa(); irANasa(Number(e.target.value)); });
    document.getElementById('lluvia-play').addEventListener('click', () => (lluvia.timer ? pausar() : reproducir()));
    document.getElementById('lluvia-slider').addEventListener('input', e => { pausar(); irAFrame(Number(e.target.value)); });
    document.getElementById('lluvia-ahora').addEventListener('click', () => { pausar(); irAFrame(lluvia.datos?.ahora || 0); });
    document.querySelector('.velocidad').addEventListener('click', e => {
        const b = e.target.closest('[data-vel]');
        if (!b) return;
        lluvia.vel = Number(b.dataset.vel);
        document.querySelectorAll('[data-vel]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        if (lluvia.timer) reproducir();
    });
    // Teclado: espacio = reproducir/pausar, flechas = hora
    document.getElementById('mapa-lluvia-vista').addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' && e.key !== ' ') return;
        if (e.key === ' ') { e.preventDefault(); lluvia.timer ? pausar() : reproducir(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { pausar(); pausarNasa(); } });
    document.getElementById('btn-clima-refrescar').addEventListener('click', e => {
        if (!esPersonal()) return;
        conCarga(e.currentTarget, () => Promise.all([cargarClima(true), vistaMapa === 'lluvia' ? cargarLluvia(true) : null]), 'Actualizando…')
            .then(() => { toast('Pronóstico actualizado.', 'ok'); window.dispatchEvent(new Event('clima-actualizado')); })
            .catch(err => toast(err.message, 'error'));
    });
    window.addEventListener('tema-cambiado', () => {
        if (mapa && fondo === 'mapa') ponerFondo(mapa, capas);
        if (lluvia.mapa && fondo === 'mapa') ponerFondo(lluvia.mapa, lluvia);
        if (nasa.mapa && fondo === 'mapa') ponerFondo(nasa.mapa, nasa);
        if (estado.vista === 'clima' && estado.clima) { pintarPerfil(estado.clima); pintarChips(estado.clima); pintarRio(estado.clima); if (lluvia.datos) pintarGraficoLluvia(lluvia.datos); }
    });
}
