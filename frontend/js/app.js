// =====================================================================
//  LA ACHIRANA · Punto de entrada del frontend
// =====================================================================
import { get, post, token } from './api.js';
import { estado, esPersonal, esAdmin, esCliente, esStaff, esGerente, esGestion } from './estado.js';
import { esc, toast, conCarga, iniciales, NIVEL, colorNivel } from './ui.js';
import { activarValidacionEnVivo, validarFormulario, erroresServidor, limpiarErrores, datosFormulario } from './validacion.js';
import { redibujarTodo } from './graficos.js';
import { cargarInicio, iniciarInicio } from './inicio.js';
import { cargarPagos, iniciarPagos } from './pagos.js';
import { cargarAnalisis, iniciarAnalisis } from './analisis.js';
import { cargarClima, iniciarClima, obtenerClima } from './clima.js';
import { cargarAdmin, iniciarAdmin } from './admin.js';
import { cargarTurnos, iniciarTurnos, reiniciarTurnos } from './turnos.js';
import { cargarGerencia, iniciarGerencia } from './gerencia.js';

const VISTAS = { inicio: cargarInicio, gerencia: cargarGerencia, turnos: cargarTurnos, clima: () => cargarClima(), pagos: cargarPagos, analisis: cargarAnalisis, admin: cargarAdmin };
const permitida = v => VISTAS[v] && (v !== 'admin' || esAdmin()) && (v !== 'gerencia' || esGestion());
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- Login
function modoLogin(modo) {
    document.querySelectorAll('[data-modo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
    $('form-login-cliente').classList.toggle('hidden', modo !== 'cliente');
    $('form-login-admin').classList.toggle('hidden', modo !== 'admin');
    (modo === 'cliente' ? $('lc-doc') : $('la-email')).focus();
}

function ajustarDocLogin() {
    const esRuc = $('lc-tipo').value === 'RUC';
    const input = $('lc-doc');
    input.dataset.validar = esRuc ? 'ruc-login' : 'dni';
    input.maxLength = esRuc ? 11 : 8;
    input.placeholder = esRuc ? '11 dígitos' : '8 dígitos';
    input.closest('.field').querySelector('label').textContent = esRuc ? 'Número de RUC' : 'Número de DNI';
    if (input.value.length > input.maxLength) input.value = input.value.slice(0, input.maxLength);
    limpiarErrores($('form-login-cliente'));
}

async function loginCliente(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    try {
        const r = await conCarga(f.querySelector('[type=submit]'), () => post('/auth/login-cliente', d), 'Verificando…');
        token.guardar(r.token);
        await entrar({ tipo: 'cliente', datos: r.cliente });
        if (r.aviso) toast(r.aviso, 'aviso', 8000);
    } catch (err) {
        erroresServidor(f, err.campos);
        toast(err.message, 'error');
    }
}

async function loginAdmin(e) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!validarFormulario(f)) return;
    const d = datosFormulario(f);
    try {
        const r = await conCarga(f.querySelector('[type=submit]'), () => post('/auth/login-admin', d), 'Verificando…');
        token.guardar(r.token);
        f.reset();
        await entrar({ tipo: 'usuario', datos: r.usuario });
    } catch (err) {
        erroresServidor(f, err.campos);
        $('la-pass').value = '';
        toast(err.message, 'error');
    }
}

// ---------------------------------------------------------------- Sesión
function aplicarRol() {
    const admin = esAdmin(), personal = esPersonal(), cliente = esCliente(), gestion = esGestion();
    document.querySelectorAll('.solo-admin').forEach(el => el.classList.toggle('hidden', !admin));
    document.querySelectorAll('.solo-personal').forEach(el => el.classList.toggle('hidden', !personal));
    document.querySelectorAll('.solo-cliente').forEach(el => el.classList.toggle('hidden', !cliente));
    document.querySelectorAll('.solo-gestion').forEach(el => el.classList.toggle('hidden', !gestion));
    document.querySelectorAll('.solo-staff').forEach(el => el.classList.toggle('hidden', !esStaff()));
    // Operador y gerente: ven el selector de regantes
    if (esStaff()) document.querySelector('.selector-cliente.solo-admin')?.classList.remove('hidden');
    // El operador y el gerente no cobran
    if (esStaff() && !admin) $('panel-pago').classList.add('hidden');
}

async function entrar(sesion) {
    estado.sesion = sesion;
    reiniciarTurnos();
    $('vista-login').classList.add('hidden');
    $('vista-app').classList.remove('hidden');
    const nombre = sesion.datos.nombre;
    $('usuario-nombre').textContent = nombre;
    $('usuario-avatar').textContent = iniciales(nombre);
    $('usuario-rol').textContent = sesion.tipo === 'cliente'
        ? (sesion.datos.tipo === 'empresa' ? 'Fundo / empresa' : 'Parcelero')
        : ({ admin: 'Administrador', operador: 'Operador', gerente: 'Gerente' }[sesion.datos.rol] || sesion.datos.rol);
    aplicarRol();

    if (esCliente()) {
        estado.clienteId = sesion.datos.id;
        estado.cliente = sesion.datos;
        $('top-cliente-nombre').textContent = sesion.datos.nombre;
    } else {
        await cargarSelectorClientes();
    }

    actualizarAlerta(true);
    const destino = (location.hash || '').replace('#', '');
    irA(permitida(destino) ? destino : esGerente() ? 'gerencia' : 'inicio');
}

async function cargarSelectorClientes() {
    estado.clientes = await get('/clientes');
    const sel = $('sel-cliente');
    const activos = estado.clientes.filter(c => c.activo);
    sel.innerHTML = activos.length
        ? activos.map(c => `<option value="${Number(c.id)}">${esc(c.nombre)} · ${esc(c.documento)}</option>`).join('')
        : '<option value="">Sin regantes registrados</option>';
    let guardado = null;
    try { guardado = Number(sessionStorage.getItem('achirana_cliente')); } catch { /* sin almacenamiento */ }
    const elegido = activos.find(c => c.id === estado.clienteId) || activos.find(c => c.id === guardado) || activos[0];
    estado.clienteId = elegido?.id || null;
    if (elegido) sel.value = String(elegido.id);
}

function salir(mensaje) {
    token.borrar();
    estado.sesion = null; estado.clienteId = null; estado.cliente = null; estado.clima = null;
    $('vista-app').classList.add('hidden');
    $('vista-login').classList.remove('hidden');
    history.replaceState(null, '', location.pathname);
    if (mensaje) toast(mensaje, 'aviso');
}

// ---------------------------------------------------------------- Navegación
async function irA(vista, cargar = true) {
    if (!permitida(vista)) vista = esGerente() ? 'gerencia' : 'inicio';
    estado.vista = vista;
    document.querySelectorAll('[data-vista]').forEach(s => s.classList.toggle('hidden', s.dataset.vista !== vista));
    document.querySelectorAll('.nav [data-ir]').forEach(b => (b.dataset.ir === vista ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    if (location.hash !== `#${vista}`) history.replaceState(null, '', `#${vista}`);
    $('sidebar').classList.remove('abierta');
    window.scrollTo({ top: 0 });
    if (!cargar) return;
    try {
        await VISTAS[vista]();
    } catch (err) {
        toast(err.message, 'error', 7000);
    }
}

// ---------------------------------------------------------------- Alerta climática (todos los roles)
async function actualizarAlerta(primeraVez = false) {
    const franja = $('alerta-franja');
    try {
        const c = await obtenerClima();
        const a = c.alerta;
        franja.dataset.nivel = a.nivel;
        $('alerta-icono').innerHTML = `<i class="fa-solid ${NIVEL[a.nivel].icono}"></i>`;
        $('alerta-icono').style.background = `color-mix(in srgb, ${colorNivel(a.nivel)} 22%, transparent)`;
        $('alerta-icono').style.color = colorNivel(a.nivel);
        $('alerta-titulo').textContent = a.nivel === 'verde' ? 'Sierra sin alertas' : a.titulo;
        $('alerta-texto').textContent = a.nivel === 'verde' ? a.mensaje : a.mensaje;
        const dot = $('nav-dot-clima');
        dot.style.background = a.nivel === 'verde' ? 'transparent' : colorNivel(a.nivel);
        $('chip-simulacion').classList.toggle('hidden', !c.simulacion);
        if (primeraVez && a.nivel !== 'verde') {
            toast(`${a.titulo}. ${a.llegada ? 'Revisa cuándo llegaría el agua en “Lluvias en la sierra”.' : ''}`, a.nivel === 'rojo' ? 'error' : 'aviso', 9000);
        }
    } catch (err) {
        franja.dataset.nivel = 'verde';
        $('alerta-titulo').textContent = 'Pronóstico de la sierra no disponible';
        $('alerta-texto').textContent = err.message;
    }
}

// ---------------------------------------------------------------- Arranque
function alternarTema() {
    const actual = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = actual;
    try { localStorage.setItem('achirana_tema', actual); } catch { /* sin almacenamiento */ }
    redibujarTodo();
}

function eventosGlobales() {
    activarValidacionEnVivo();
    document.addEventListener('click', e => {
        const t = e.target.closest('[data-accion], [data-ir], [data-ver-clave]');
        if (!t) return;
        if (t.dataset.verClave) {
            const input = $(t.dataset.verClave);
            input.type = input.type === 'password' ? 'text' : 'password';
            t.innerHTML = `<i class="fa-regular ${input.type === 'password' ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
            t.setAttribute('aria-label', input.type === 'password' ? 'Mostrar' : 'Ocultar');
        } else if (t.dataset.ir) {
            irA(t.dataset.ir);
        } else if (t.dataset.accion === 'tema') {
            alternarTema();
        } else if (t.dataset.accion === 'salir') {
            salir();
        } else if (t.dataset.accion === 'menu') {
            $('sidebar').classList.toggle('abierta');
        }
    });
    document.querySelectorAll('[data-modo]').forEach(b => b.addEventListener('click', () => modoLogin(b.dataset.modo)));
    $('lc-tipo').addEventListener('change', ajustarDocLogin);
    $('form-login-cliente').addEventListener('submit', loginCliente);
    $('form-login-admin').addEventListener('submit', loginAdmin);
    $('sel-cliente').addEventListener('change', e => {
        estado.clienteId = Number(e.target.value) || null;
        try { sessionStorage.setItem('achirana_cliente', String(estado.clienteId)); } catch { /* sin almacenamiento */ }
        if (['inicio', 'pagos', 'analisis'].includes(estado.vista)) irA(estado.vista);
    });
    window.addEventListener('sesion-expirada', e => salir(e.detail || 'Tu sesión expiró. Vuelve a ingresar.'));
    window.addEventListener('clima-actualizado', () => actualizarAlerta());
    window.addEventListener('hashchange', () => {
        const v = location.hash.replace('#', '');
        if (estado.sesion && v !== estado.vista && permitida(v)) irA(v);
    });
    // Refresca la alerta cada 30 minutos mientras la página esté abierta
    setInterval(() => { if (estado.sesion) { estado.clima = null; actualizarAlerta(); } }, 30 * 60 * 1000);

    iniciarInicio();
    iniciarPagos();
    iniciarAnalisis();
    iniciarClima();
    iniciarTurnos();
    iniciarAdmin({ onClientesCambiados: async () => { await cargarSelectorClientes(); } });
    iniciarGerencia();
}

async function arrancar() {
    eventosGlobales();
    ajustarDocLogin();
    if (!token.obtener()) return;
    try {
        const yo = await get('/auth/yo');
        await entrar(yo.tipo === 'usuario' ? { tipo: 'usuario', datos: yo.usuario } : { tipo: 'cliente', datos: yo.cliente });
    } catch {
        token.borrar();
    }
}

arrancar();
