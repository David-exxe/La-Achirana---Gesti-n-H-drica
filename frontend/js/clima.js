// =====================================================================
//  Vista "Lluvias en la sierra"
//   - Perfil del río (Choclococha → bocatoma → Ica) con la lluvia del día
//   - Simulación de llegada del agua
//   - Mapa: NASA GIBS (IMERG, MODIS) + Windy embebido
//   - Caudal modelado GloFAS
// =====================================================================
import { get } from './api.js';
import { estado, esPersonal } from './estado.js';
import { esc, numero, fechaHora, diaSemana, hoyLima, NIVEL, colorNivel, toast, conCarga } from './ui.js';
import { dibujar, opcionesBase, temaGraficos } from './graficos.js';

let diaSel = null;
let mapa = null;
let capas = {};
let windyCargado = false;

export async function obtenerClima(forzar = false) {
    estado.clima = await get(`/clima/resumen${forzar ? '?forzar=1' : ''}`);
    return estado.clima;
}

export async function cargarClima(forzar = false) {
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

// ---------- Mapa ----------
function fechaImagen() {
    // IMERG "early" tiene unas horas de retraso: por defecto mostramos ayer
    return new Date(Date.now() - 5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
}

function capaBase() {
    const claro = document.documentElement.dataset.theme === 'light';
    return L.tileLayer(`https://{s}.basemaps.cartocdn.com/${claro ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`, {
        attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 12,
    });
}

function iniciarMapa(c) {
    if (!window.L) return;
    const estadoCapa = document.getElementById('capa-estado');
    const inputFecha = document.getElementById('capa-fecha');
    if (!mapa) {
        mapa = L.map('mapa-leaflet', { zoomControl: true, scrollWheelZoom: false }).setView([-13.75, -75.35], 8);
        capas.base = capaBase().addTo(mapa);
        inputFecha.value = fechaImagen();
        inputFecha.max = hoyLima();
        crearCapasNasa(inputFecha.value);
        inputFecha.addEventListener('change', () => { if (inputFecha.value) crearCapasNasa(inputFecha.value); });
        document.getElementById('capa-imerg').addEventListener('change', e => alternar(capas.imerg, e.target.checked));
        document.getElementById('capa-nubes').addEventListener('change', e => alternar(capas.nubes, e.target.checked));
        window.addEventListener('tema-cambiado', () => { mapa.removeLayer(capas.base); capas.base = capaBase().addTo(mapa); capas.base.bringToBack(); });
    }
    // Puntos de monitoreo
    capas.puntos?.remove();
    capas.puntos = L.layerGroup().addTo(mapa);
    c.puntos.forEach(p => {
        const dia = p.dias.find(d => d.fecha === diaSel) || {};
        const col = p.tipo === 'sierra' ? colorNivel(dia.nivel || 'verde') : (p.tipo === 'bocatoma' ? '#e3b866' : '#3fc1c9');
        L.circleMarker([p.latitud, p.longitud], { radius: p.tipo === 'sierra' ? 9 : 7, color: '#0f1b26', weight: 2, fillColor: col, fillOpacity: 0.95 })
            .bindPopup(`<strong>${esc(p.nombre)}</strong><br>${p.altitud_m.toLocaleString('es-PE')} m s. n. m.<br>
                Lluvia ${esc(diaSel)}: <b>${numero(dia.precip_mm || 0, 1)} mm</b>${dia.probabilidad != null ? ` (${dia.probabilidad}%)` : ''}<br>
                Próximos 7 días: ${numero(p.acumulado_7d, 1)} mm
                ${p.viaje && !p.regulado ? `<br>Llegada a bocatoma: ${numero(p.viaje.min_h, 0)}–${numero(p.viaje.max_h, 0)} h` : ''}
                ${p.notas ? `<br><span style="opacity:.75">${esc(p.notas)}</span>` : ''}`)
            .addTo(capas.puntos);
    });
    const boc = c.puntos.find(p => p.tipo === 'bocatoma');
    if (boc) {
        c.puntos.filter(p => p.tipo === 'sierra').forEach(p => {
            L.polyline([[p.latitud, p.longitud], [boc.latitud, boc.longitud]], { color: '#3fc1c9', weight: 1.5, dashArray: '4 6', opacity: 0.7 }).addTo(capas.puntos);
        });
    }
    setTimeout(() => mapa.invalidateSize(), 60);
    estadoCapa.textContent = 'Fuente: NASA GIBS / Worldview';
}

function crearCapasNasa(fecha) {
    const estadoCapa = document.getElementById('capa-estado');
    ['imerg', 'nubes'].forEach(k => capas[k] && mapa.removeLayer(capas[k]));
    let errores = 0;
    capas.imerg = L.tileLayer.wms('https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', {
        layers: 'IMERG_Precipitation_Rate', format: 'image/png', transparent: true, opacity: 0.85, time: fecha,
        attribution: 'NASA GPM IMERG · GIBS',
    });
    capas.imerg.on('tileerror', () => {
        errores++;
        if (errores === 3) estadoCapa.textContent = 'La capa IMERG no respondió para esa fecha. Prueba otra fecha o usa “Pronóstico animado”.';
    });
    capas.nubes = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${fecha}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
        maxNativeZoom: 9, maxZoom: 12, opacity: 0.85, attribution: 'NASA MODIS Terra · GIBS',
    });
    if (document.getElementById('capa-nubes').checked) capas.nubes.addTo(mapa);
    if (document.getElementById('capa-imerg').checked) capas.imerg.addTo(mapa);
    capas.puntos?.eachLayer(l => l.bringToFront?.());
}

function alternar(capa, mostrar) {
    if (!capa || !mapa) return;
    if (mostrar) capa.addTo(mapa); else mapa.removeLayer(capa);
}

function mostrarMapa(tipo) {
    document.querySelectorAll('[data-mapa]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapa === tipo)));
    document.getElementById('mapa-nasa').classList.toggle('hidden', tipo !== 'nasa');
    document.getElementById('mapa-windy').classList.toggle('hidden', tipo !== 'windy');
    if (tipo === 'windy' && !windyCargado) {
        const src = 'https://embed.windy.com/embed2.html?lat=-13.85&lon=-75.35&detailLat=-13.83&detailLon=-75.26'
            + '&width=650&height=450&zoom=8&level=surface&overlay=rain&product=ecmwf&menu=&message=true&marker=true'
            + '&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1';
        document.getElementById('mapa-windy').innerHTML = `<iframe title="Pronóstico de lluvia animado (Windy, modelo ECMWF)" src="${src}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
        windyCargado = true;
    }
    if (tipo === 'nasa') setTimeout(() => mapa?.invalidateSize(), 60);
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
    document.getElementById('btn-clima-refrescar').addEventListener('click', e => {
        if (!esPersonal()) return;
        conCarga(e.currentTarget, () => cargarClima(true), 'Actualizando…')
            .then(() => { toast('Pronóstico actualizado.', 'ok'); window.dispatchEvent(new Event('clima-actualizado')); })
            .catch(err => toast(err.message, 'error'));
    });
    window.addEventListener('tema-cambiado', () => { if (estado.vista === 'clima' && estado.clima) { pintarPerfil(estado.clima); pintarChips(estado.clima); pintarRio(estado.clima); } });
}
