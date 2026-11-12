// =====================================================================
//  Pago en línea
//   - Con llaves de Culqi: se abre el checkout oficial de Culqi (tarjeta
//     o Yape). El número de tarjeta va cifrado a Culqi, nunca a la Junta.
//   - Sin llaves (modo demostración): formulario realista que NO cobra y
//     solo acepta tarjetas de prueba. Al servidor van marca y últimos 4.
// =====================================================================
import { post } from './api.js';
import { estado } from './estado.js';
import { esc, soles, toast } from './ui.js';

// Tarjetas de prueba (las mismas que publica Culqi para su ambiente de pruebas)
const PRUEBA = [
    { numero: '4111111111111111', marca: 'Visa' },
    { numero: '5111111111111118', marca: 'Mastercard' },
    { numero: '371212121212122', marca: 'Amex' },
    { numero: '36001212121210', marca: 'Diners' },
];

const MARCAS = {
    Visa: { re: /^4/, largo: [16], cvv: 3, icono: 'fa-cc-visa', grupos: [4, 4, 4, 4] },
    Mastercard: { re: /^(5[1-5]|2[2-7])/, largo: [16], cvv: 3, icono: 'fa-cc-mastercard', grupos: [4, 4, 4, 4] },
    Amex: { re: /^3[47]/, largo: [15], cvv: 4, icono: 'fa-cc-amex', grupos: [4, 6, 5] },
    Diners: { re: /^3(0[0-5]|[68])/, largo: [14], cvv: 3, icono: 'fa-cc-diners-club', grupos: [4, 6, 4] },
};
const marcaDe = n => Object.keys(MARCAS).find(k => MARCAS[k].re.test(n)) || null;

function luhn(n) {
    let suma = 0;
    for (let i = 0; i < n.length; i++) {
        let d = Number(n[n.length - 1 - i]);
        if (i % 2) { d *= 2; if (d > 9) d -= 9; }
        suma += d;
    }
    return n.length > 11 && suma % 10 === 0;
}
function agrupar(n, marca) {
    const g = (MARCAS[marca] || MARCAS.Visa).grupos;
    const out = [];
    let i = 0;
    for (const t of g) { if (i >= n.length) break; out.push(n.slice(i, i + t)); i += t; }
    return out.join(' ');
}
const espera = ms => new Promise(r => setTimeout(r, ms));

function pantallaProcesando(cuerpo, texto) {
    cuerpo.innerHTML = `<div class="procesando-pago"><div class="anillo"></div><strong>${esc(texto)}</strong><span class="small muted">No cierres esta ventana.</span></div>`;
}

// --------------------------------------------------------------- Tarjeta (demostración)
export function formularioTarjeta(cuerpo, { cotizacion, tipo, cliente, alAprobar, alVolver }) {
    cuerpo.innerHTML = `
        <div class="aviso arena demo-aviso"><i class="fa-solid fa-flask"></i><span><strong>Modo demostración:</strong> no se cobra dinero y solo se aceptan tarjetas de prueba. Cuando la Junta active Culqi, aquí aparecerá el formulario seguro de Culqi.</span>
            <button type="button" class="btn btn-sm btn-ghost" data-prueba><i class="fa-solid fa-wand-magic-sparkles"></i> Usar tarjeta de prueba</button></div>
        <div class="tarjeta-layout">
            <div class="tarjeta-escena"><div class="tarjeta-3d" id="tj">
                <div class="tj-cara tj-frente">
                    <div class="tj-fila"><span class="tj-chip"></span><i class="fa-brands fa-cc-visa tj-marca hidden" id="tj-marca"></i><i class="fa-solid fa-wifi tj-nfc"></i></div>
                    <div class="tj-numero mono" id="tj-num">•••• •••• •••• ••••</div>
                    <div class="tj-fila tj-pie"><div><small>Titular</small><span id="tj-nom">NOMBRE APELLIDO</span></div><div><small>Vence</small><span id="tj-ven" class="mono">MM/AA</span></div></div>
                </div>
                <div class="tj-cara tj-dorso">
                    <div class="tj-banda"></div>
                    <div class="tj-firma"><span class="mono" id="tj-cvv">•••</span></div>
                    <small class="tj-legal">Código de seguridad (CVV) · 3 dígitos atrás, o 4 al frente en Amex</small>
                </div>
            </div></div>
            <form id="tj-form" class="form-grid" novalidate autocomplete="off">
                <div class="field">
                    <label for="tj-numero">Número de tarjeta</label>
                    <div class="input-icono"><input id="tj-numero" class="input mono" inputmode="numeric" maxlength="19" placeholder="1234 5678 9012 3456" autocomplete="off"><i class="fa-regular fa-credit-card" id="tj-ico"></i></div>
                    <span class="error" data-error-de="numero"></span>
                </div>
                <div class="field">
                    <label for="tj-titular">Nombre como figura en la tarjeta</label>
                    <input id="tj-titular" class="input" maxlength="40" placeholder="JUAN PEREZ" autocomplete="off">
                    <span class="error" data-error-de="titular"></span>
                </div>
                <div class="form-grid cols-2" style="gap:12px">
                    <div class="field">
                        <label for="tj-vence">Vencimiento</label>
                        <input id="tj-vence" class="input mono" inputmode="numeric" maxlength="5" placeholder="MM/AA" autocomplete="off">
                        <span class="error" data-error-de="vence"></span>
                    </div>
                    <div class="field">
                        <label for="tj-cvv-in">CVV <i class="fa-regular fa-circle-question" title="3 dígitos al reverso (4 al frente en American Express)"></i></label>
                        <input id="tj-cvv-in" class="input mono" inputmode="numeric" maxlength="4" placeholder="123" autocomplete="off" type="password">
                        <span class="error" data-error-de="cvv"></span>
                    </div>
                </div>
                <div class="field">
                    <label for="tj-email">Correo para la constancia</label>
                    <input id="tj-email" class="input" type="email" maxlength="100" placeholder="tucorreo@gmail.com" value="${esc(cliente.email || '')}">
                    <span class="error" data-error-de="email"></span>
                </div>
                <div class="modal-pie" style="padding:0;border:0">
                    <button type="button" class="btn btn-ghost" data-volver><i class="fa-solid fa-arrow-left"></i> Otro medio</button>
                    <button type="submit" class="btn btn-arena"><i class="fa-solid fa-lock"></i> Pagar ${soles(cotizacion.monto)}</button>
                </div>
            </form>
        </div>`;

    const $ = sel => cuerpo.querySelector(sel);
    const tj = $('#tj');
    const f = { numero: $('#tj-numero'), titular: $('#tj-titular'), vence: $('#tj-vence'), cvv: $('#tj-cvv-in'), email: $('#tj-email') };
    const err = (campo, txt) => { cuerpo.querySelector(`[data-error-de="${campo}"]`).textContent = txt || ''; if (f[campo]) { if (txt) f[campo].setAttribute('aria-invalid', 'true'); else f[campo].removeAttribute('aria-invalid'); } };
    let marca = null;

    const pintar = () => {
        const n = f.numero.value.replace(/\D/g, '');
        marca = marcaDe(n);
        const ico = $('#tj-marca');
        ico.className = `fa-brands ${marca ? MARCAS[marca].icono : 'fa-cc-visa'} tj-marca ${marca ? '' : 'hidden'}`;
        $('#tj-ico').className = marca ? `fa-brands ${MARCAS[marca].icono}` : 'fa-regular fa-credit-card';
        tj.dataset.marca = (marca || '').toLowerCase();
        const largo = marca ? MARCAS[marca].largo[0] : 16;
        const relleno = (n + '•'.repeat(Math.max(0, largo - n.length))).slice(0, largo);
        $('#tj-num').textContent = agrupar(relleno, marca);
        $('#tj-nom').textContent = f.titular.value.trim().toUpperCase() || 'NOMBRE APELLIDO';
        $('#tj-ven').textContent = f.vence.value || 'MM/AA';
        $('#tj-cvv').textContent = f.cvv.value ? '•'.repeat(f.cvv.value.length) : (marca === 'Amex' ? '••••' : '•••');
    };

    f.numero.addEventListener('input', () => {
        const n = f.numero.value.replace(/\D/g, '').slice(0, 16);
        const mk = marcaDe(n);
        f.numero.value = agrupar(n, mk);
        f.cvv.maxLength = mk === 'Amex' ? 4 : 3;
        err('numero');
        pintar();
    });
    f.titular.addEventListener('input', () => { f.titular.value = f.titular.value.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ .'-]/g, ''); pintar(); });
    f.vence.addEventListener('input', e => {
        let v = f.vence.value.replace(/\D/g, '').slice(0, 4);
        if (v.length === 1 && Number(v) > 1) v = `0${v}`;
        f.vence.value = v.length > 2 ? `${v.slice(0, 2)}/${v.slice(2)}` : (v.length === 2 && e.inputType !== 'deleteContentBackward' ? `${v}/` : v);
        pintar();
    });
    f.cvv.addEventListener('input', () => { f.cvv.value = f.cvv.value.replace(/\D/g, ''); pintar(); });
    f.cvv.addEventListener('focus', () => { if (marca !== 'Amex') tj.classList.add('volteada'); });
    f.cvv.addEventListener('blur', () => tj.classList.remove('volteada'));
    $('[data-prueba]').addEventListener('click', () => {
        const t = PRUEBA[0];
        const d = new Date();
        f.numero.value = t.numero; f.numero.dispatchEvent(new Event('input'));
        f.titular.value = (cliente.nombre || 'Regante de prueba').toUpperCase().slice(0, 30);
        f.vence.value = `${String(d.getMonth() + 1).padStart(2, '0')}/${String((d.getFullYear() + 3) % 100).padStart(2, '0')}`;
        f.cvv.value = '123';
        if (!f.email.value) f.email.value = 'prueba@laachirana.pe';
        pintar();
    });
    $('[data-volver]').addEventListener('click', alVolver);
    f.numero.focus();
    pintar();

    $('#tj-form').addEventListener('submit', async e => {
        e.preventDefault();
        const n = f.numero.value.replace(/\D/g, '');
        let ok = true;
        const fallo = (c, t) => { err(c, t); ok = false; };
        ['numero', 'titular', 'vence', 'cvv', 'email'].forEach(c => err(c));
        if (!marca) fallo('numero', 'Aceptamos Visa, Mastercard, American Express y Diners.');
        else if (!MARCAS[marca].largo.includes(n.length) || !luhn(n)) fallo('numero', 'El número de tarjeta no es válido.');
        else if (!PRUEBA.some(t => t.numero === n)) fallo('numero', 'Modo demostración: usa una tarjeta de prueba (botón “Usar tarjeta de prueba”).');
        if (f.titular.value.trim().length < 4) fallo('titular', 'Escribe el nombre del titular.');
        const [mm, aa] = f.vence.value.split('/').map(Number);
        const fin = new Date(2000 + (aa || 0), mm || 0, 1);
        if (!(mm >= 1 && mm <= 12) || !aa || fin <= new Date()) fallo('vence', 'Fecha vencida o no válida.');
        if (f.cvv.value.length !== (marca === 'Amex' ? 4 : 3)) fallo('cvv', marca === 'Amex' ? '4 dígitos.' : '3 dígitos.');
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(f.email.value.trim())) fallo('email', 'Correo no válido.');
        if (!ok) return;
        const ultimos4 = n.slice(-4);
        // Se descartan los datos sensibles antes de seguir
        f.numero.value = ''; f.cvv.value = '';
        pantallaProcesando(cuerpo, 'Procesando el pago con tu banco…');
        try {
            await espera(1400);
            const r = await post('/pagos/demo/cargo', { cliente_id: estado.clienteId, tipo, medio: 'tarjeta', marca, ultimos4 });
            alAprobar(r.pago, { demo: true });
        } catch (er) {
            toast(er.message, 'error', 7000);
            alVolver();
        }
    });
}

// --------------------------------------------------------------- Yape (demostración)
export function formularioYape(cuerpo, { cotizacion, tipo, alAprobar, alVolver }) {
    cuerpo.innerHTML = `
        <div class="aviso arena demo-aviso"><i class="fa-solid fa-flask"></i><span><strong>Modo demostración:</strong> no se cobra dinero. Con Culqi activo, el cobro se hace en tu Yape real.</span></div>
        <div class="yape-layout">
            <div class="yape-celu" aria-hidden="true">
                <div class="yape-pantalla">
                    <div class="yape-top"><i class="fa-solid fa-bars"></i><strong>yape</strong><i class="fa-regular fa-bell"></i></div>
                    <div class="yape-menu-item"><i class="fa-solid fa-key"></i> Código de aprobación</div>
                    <div class="yape-codigo mono" id="yp-demo">— — —  — — —</div>
                    <small>Válido por 2 minutos</small>
                </div>
            </div>
            <form id="yp-form" class="form-grid" novalidate autocomplete="off">
                <ol class="pasos-app">
                    <li>Abre tu app <strong>Yape</strong>.</li>
                    <li>Toca el menú <i class="fa-solid fa-bars"></i> y elige <strong>“Código de aprobación”</strong>.</li>
                    <li>Escribe aquí tu celular y el código de 6 dígitos.</li>
                </ol>
                <div class="field">
                    <label for="yp-cel">Celular afiliado a Yape</label>
                    <input id="yp-cel" class="input mono" inputmode="numeric" maxlength="9" placeholder="987654321">
                    <span class="error" data-error-de="celular"></span>
                </div>
                <div class="field">
                    <label>Código de aprobación</label>
                    <div class="otp" id="yp-otp">${Array.from({ length: 6 }, (_, i) => `<input class="input mono" inputmode="numeric" maxlength="1" aria-label="Dígito ${i + 1}">`).join('')}</div>
                    <span class="error" data-error-de="codigo"></span>
                    <button type="button" class="link-btn small" data-generar><i class="fa-solid fa-wand-magic-sparkles"></i> Generar un código de prueba</button>
                </div>
                <div class="modal-pie" style="padding:0;border:0">
                    <button type="button" class="btn btn-ghost" data-volver><i class="fa-solid fa-arrow-left"></i> Otro medio</button>
                    <button type="submit" class="btn btn-yape"><i class="fa-solid fa-bolt"></i> Yapear ${soles(cotizacion.monto)}</button>
                </div>
            </form>
        </div>`;
    const $ = sel => cuerpo.querySelector(sel);
    const cel = $('#yp-cel');
    const cajas = [...cuerpo.querySelectorAll('#yp-otp input')];
    cel.addEventListener('input', () => { cel.value = cel.value.replace(/\D/g, ''); });
    cajas.forEach((c, i) => {
        c.addEventListener('input', () => { c.value = c.value.replace(/\D/g, '').slice(-1); if (c.value && cajas[i + 1]) cajas[i + 1].focus(); });
        c.addEventListener('keydown', e => { if (e.key === 'Backspace' && !c.value && cajas[i - 1]) cajas[i - 1].focus(); });
        c.addEventListener('paste', e => {
            const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
            if (t.length) { e.preventDefault(); t.split('').forEach((d, j) => { if (cajas[j]) cajas[j].value = d; }); cajas[Math.min(t.length, 5)].focus(); }
        });
    });
    $('[data-generar]').addEventListener('click', () => {
        const cod = String(Math.floor(100000 + Math.random() * 900000));
        $('#yp-demo').textContent = `${cod.slice(0, 3)} ${cod.slice(3)}`;
        cod.split('').forEach((d, j) => { cajas[j].value = d; });
        if (!cel.value) cel.value = '987654321';
    });
    $('[data-volver]').addEventListener('click', alVolver);
    cel.focus();
    $('#yp-form').addEventListener('submit', async e => {
        e.preventDefault();
        const codigo = cajas.map(c => c.value).join('');
        cuerpo.querySelector('[data-error-de="celular"]').textContent = /^9\d{8}$/.test(cel.value) ? '' : '9 dígitos, empieza con 9.';
        cuerpo.querySelector('[data-error-de="codigo"]').textContent = /^\d{6}$/.test(codigo) ? '' : 'Escribe los 6 dígitos.';
        if (!/^9\d{8}$/.test(cel.value) || !/^\d{6}$/.test(codigo)) return;
        const celular = cel.value;
        pantallaProcesando(cuerpo, 'Confirmando con Yape…');
        try {
            await espera(1400);
            const r = await post('/pagos/demo/cargo', { cliente_id: estado.clienteId, tipo, medio: 'yape', celular });
            alAprobar(r.pago, { demo: true });
        } catch (er) {
            toast(er.message, 'error', 7000);
            alVolver();
        }
    });
}

// --------------------------------------------------------------- Culqi (real o pruebas)
let cargaCulqi = null;
function cargarCulqi() {
    if (window.Culqi) return Promise.resolve();
    if (!cargaCulqi) {
        cargaCulqi = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://checkout.culqi.com/js/v4';
            s.onload = () => resolve();
            s.onerror = () => { cargaCulqi = null; reject(new Error('No se pudo cargar la pasarela de pago. Revisa tu conexión.')); };
            document.head.appendChild(s);
        });
    }
    return cargaCulqi;
}

export async function abrirCulqi({ medio, config, cotizacion, tipo, alAprobar, ocupado }) {
    try {
        await cargarCulqi();
    } catch (err) { toast(err.message, 'error'); return; }
    const Culqi = window.Culqi;
    Culqi.publicKey = config.publicKey;
    const ajustes = {
        title: 'Junta de Usuarios La Achirana',
        currency: 'PEN',
        amount: Math.round(Number(cotizacion.monto) * 100),
    };
    if (config.rsaId && config.rsaPublicKey) { ajustes.xculqirsaid = config.rsaId; ajustes.rsapublickey = config.rsaPublicKey; }
    Culqi.settings(ajustes);
    Culqi.options({
        lang: 'auto',
        installments: false,
        modal: true,
        paymentMethods: { tarjeta: medio === 'tarjeta', yape: medio === 'yape', bancaMovil: false, agente: false, billetera: false, cuotealo: false },
        style: { bannerColor: '#0f5c63', buttonBackground: '#b07d2b', menuColor: '#0f5c63', linksColor: '#0f5c63', buttonText: 'Pagar', buttonTextColor: '#ffffff', priceColor: '#0f5c63' },
    });
    // Culqi llama a esta función global cuando el usuario termina
    window.culqi = async () => {
        if (Culqi.token) {
            const token = Culqi.token;
            Culqi.close();
            ocupado?.(true);
            try {
                const r = await post('/pagos/culqi/cargo', { cliente_id: estado.clienteId, tipo, token: token.id, email: token.email });
                alAprobar(r.pago);
            } catch (err) {
                toast(err.message, 'error', 9000);
            } finally { ocupado?.(false); }
        } else if (Culqi.error) {
            toast(Culqi.error.user_message || Culqi.error.merchant_message || 'No se pudo procesar el pago.', 'error', 7000);
        }
    };
    Culqi.open();
}
