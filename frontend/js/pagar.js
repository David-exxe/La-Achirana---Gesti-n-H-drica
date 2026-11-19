// =====================================================================
//  Asistente de pago
//   A) En línea (Culqi): tarjeta o Yape con código de aprobación → se
//      cobra y se emite la boleta/factura al instante.
//   B) Yape, Plin o transferencia a la cuenta de la Junta → el regante
//      envía su constancia y la Junta la valida.
//   Sin llaves de Culqi, el modo demostración simula A sin cobrar.
// =====================================================================
import { get, post } from './api.js';
import { estado } from './estado.js';
import { esc, soles, toast, abrirModal, conCarga, copiar } from './ui.js';
import { erroresServidor, limpiarErrores, problemaEmail } from './validacion.js';
import { formularioTarjeta, formularioYape, abrirCulqi } from './pago-linea.js';

const MARCA = {
    'Yape (BCP)': { clase: 'yape', corto: 'Yape', icono: 'fa-mobile-screen-button' },
    Plin: { clase: 'plin', corto: 'Plin', icono: 'fa-mobile-screen-button' },
    BCP: { clase: 'bcp', corto: 'BCP', icono: 'fa-building-columns' },
    Interbank: { clase: 'ibk', corto: 'Interbank', icono: 'fa-building-columns' },
    BBVA: { clase: 'bbva', corto: 'BBVA', icono: 'fa-building-columns' },
    Scotiabank: { clase: 'scotia', corto: 'Scotiabank', icono: 'fa-building-columns' },
    'Banco de la Nación': { clase: 'bn', corto: 'Banco de la Nación', icono: 'fa-building-columns' },
    BanBif: { clase: 'banbif', corto: 'BanBif', icono: 'fa-building-columns' },
    'Caja Ica': { clase: 'cajaica', corto: 'Caja Ica', icono: 'fa-building-columns' },
    Otra: { clase: 'otro', corto: 'Banco', icono: 'fa-building-columns' },
};
export const marca = entidad => MARCA[entidad] || MARCA.Otra;
const grupo = n => String(n).replace(/(\d{3})(?=\d)/g, '$1 ');
const ahoraLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Tarjeta de un medio de pago (se reutiliza en el panel de administración). */
export function tarjetaMedio(c, { seleccionable = true } = {}) {
    const m = marca(c.entidad);
    const sub = c.metodo === 'transferencia' ? `Cuenta ${grupo(c.numero)}` : grupo(c.numero);
    return `<${seleccionable ? 'button type="button"' : 'div'} class="medio-card ${m.clase}" data-cuenta="${Number(c.id)}">
        <span class="medio-ico"><i class="fa-solid ${m.icono}"></i></span>
        <span class="medio-txt"><strong>${esc(c.metodo === 'transferencia' ? `Transferencia ${m.corto}` : m.corto)}</strong><small>${esc(sub)}</small></span>
        ${seleccionable ? '<i class="fa-solid fa-chevron-right medio-flecha"></i>' : ''}
    </${seleccionable ? 'button' : 'div'}>`;
}

/** Reduce la foto del voucher (máx. 1400 px, JPEG) antes de enviarla. */
async function comprimir(archivo) {
    if (!/^image\/(png|jpeg|webp)$/.test(archivo.type)) throw new Error('Sube una imagen JPG, PNG o WEBP.');
    if (archivo.size > 15 * 1024 * 1024) throw new Error('La imagen pesa más de 15 MB.');
    const bmp = await createImageBitmap(archivo);
    const escala = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(bmp.width * escala);
    lienzo.height = Math.round(bmp.height * escala);
    const ctx = lienzo.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    ctx.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    return lienzo.toDataURL('image/jpeg', 0.82);
}

/**
 * Abre el asistente. cotizacion = respuesta de /pagos/cotizacion; tipo = BOLETA | FACTURA.
 * alTerminar se llama cuando el pago queda enviado.
 */
export async function abrirPago({ cotizacion, tipo, alTerminar }) {
    let medios;
    let linea;
    try {
        [medios, linea] = await Promise.all([get('/pagos/medios').then(r => r.cuentas), get('/pagos/en-linea')]);
    } catch (err) { toast(err.message, 'error'); return; }
    const hayLinea = linea.culqi.activo || linea.demo;
    const cliente = estado.cliente || {};
    const ref = `ACH-${cliente.documento || estado.clienteId}`;
    let cuenta = null;
    let voucher = null;
    let reloj = null;

    const m = abrirModal(`
        <div class="modal-cab pago-cab">
            <div>
                <h3>Pagar canon hídrico</h3>
                <div class="small muted">${esc(cliente.nombre || '')} · ${tipo === 'FACTURA' ? 'Factura' : 'Boleta'}</div>
            </div>
            <div class="pago-monto-mini">${soles(cotizacion.monto)}</div>
        </div>
        <ol class="pasos-pago" id="pp-pasos">
            <li data-paso="1" class="activo"><span>1</span> Elige</li>
            <li data-paso="2"><span>2</span> Paga</li>
            <li data-paso="3"><span>3</span> <em id="pp-paso3">Envía tu constancia</em></li>
        </ol>
        <div class="modal-cuerpo pago-cuerpo" id="pp-cuerpo"></div>
    `, { ancho: true, alCerrar: () => clearInterval(reloj) });
    const cuerpo = m.el.querySelector('#pp-cuerpo');
    const marcarPaso = n => m.el.querySelectorAll('#pp-pasos li').forEach(li => {
        const p = Number(li.dataset.paso);
        li.classList.toggle('activo', p === n);
        li.classList.toggle('hecho', p < n);
    });

    // ---------- Paso 1: elegir medio
    const paso1 = () => {
        clearInterval(reloj);
        m.el.querySelector('#pp-paso3').textContent = 'Envía tu constancia';
        marcarPaso(1);
        if (!medios.length && !hayLinea) {
            cuerpo.innerHTML = `<div class="aviso arena"><i class="fa-solid fa-circle-info"></i><span>La Junta todavía no registró números de Yape, Plin ni cuentas bancarias. Puedes pagar en la oficina.</span></div>
                <div class="modal-pie"><button type="button" class="btn btn-ghost" data-cerrar>Cerrar</button></div>`;
            return;
        }
        const billeteras = medios.filter(c => c.metodo !== 'transferencia');
        const bancos = medios.filter(c => c.metodo === 'transferencia');
        const etqDemo = linea.demo ? '<span class="tag-demo">Demo</span>' : (linea.culqi.pruebas ? '<span class="tag-demo">Pruebas</span>' : '');
        const enLinea = hayLinea ? `<div class="medio-grupo"><span class="label">Pago en línea · tu boleta sale al instante ${etqDemo}</span><div class="medios-grid">
                <button type="button" class="medio-card tarjeta" data-linea="tarjeta">
                    <span class="medio-ico"><i class="fa-regular fa-credit-card"></i></span>
                    <span class="medio-txt"><strong>Tarjeta de crédito o débito</strong><small class="marcas-mini"><i class="fa-brands fa-cc-visa"></i><i class="fa-brands fa-cc-mastercard"></i><i class="fa-brands fa-cc-amex"></i><i class="fa-brands fa-cc-diners-club"></i></small></span>
                    <i class="fa-solid fa-chevron-right medio-flecha"></i></button>
                ${linea.demo || linea.culqi.yape ? `<button type="button" class="medio-card yape" data-linea="yape">
                    <span class="medio-ico"><i class="fa-solid fa-bolt"></i></span>
                    <span class="medio-txt"><strong>Yape al instante</strong><small>Con tu código de aprobación</small></span>
                    <i class="fa-solid fa-chevron-right medio-flecha"></i></button>` : ''}
            </div></div>` : '';
        cuerpo.innerHTML = `
            <p class="pago-intro">Paga <strong>${soles(cotizacion.monto)}</strong> por ${esc(String(cotizacion.volumen_m3))} m³ de agua. Elige cómo quieres pagar:</p>
            ${enLinea}
            ${billeteras.length && hayLinea ? '<div class="separador-o"><span>o paga a la cuenta de la Junta y envía tu constancia</span></div>' : ''}
            ${billeteras.length ? `<div class="medio-grupo"><span class="label">Billetera digital · al instante</span><div class="medios-grid">${billeteras.map(c => tarjetaMedio(c)).join('')}</div></div>` : ''}
            ${bancos.length ? `<div class="medio-grupo"><span class="label">Transferencia o depósito bancario</span><div class="medios-grid">${bancos.map(c => tarjetaMedio(c)).join('')}</div></div>` : ''}
            <p class="small muted" style="margin-top:14px"><i class="fa-solid fa-lock"></i> ${hayLinea ? 'Los datos de tu tarjeta van cifrados directamente a la pasarela de pago; la Junta nunca los ve ni los guarda.' : 'No te pedimos claves ni datos de tarjeta. Pagas desde tu propia app y nos envías la constancia.'}</p>`;
        cuerpo.querySelectorAll('[data-linea]').forEach(b => b.addEventListener('click', () => pagoLinea(b.dataset.linea)));
        cuerpo.querySelectorAll('[data-cuenta]').forEach(b => b.addEventListener('click', () => {
            cuenta = medios.find(c => c.id === Number(b.dataset.cuenta));
            paso2();
        }));
        cuerpo.querySelector('[data-linea], [data-cuenta]')?.focus();
    };

    // ---------- Pago en línea (Culqi o demostración)
    const pagoLinea = medio => {
        m.el.querySelector('#pp-paso3').textContent = 'Confirmado';
        const comun = { cotizacion, tipo, cliente, demo: linea.demo, alAprobar: aprobado, alVolver: paso1 };
        if (linea.culqi.activo) {
            abrirCulqi({ ...comun, medio, config: linea.culqi, ocupado: v => cuerpo.classList.toggle('procesando', v) });
            return;
        }
        marcarPaso(2);
        (medio === 'tarjeta' ? formularioTarjeta : formularioYape)(cuerpo, comun);
    };

    // ---------- Pago en línea aprobado
    const aprobado = (pago, { demo = false } = {}) => {
        clearInterval(reloj);
        m.el.querySelector('#pp-pasos').classList.add('hidden');
        cuerpo.innerHTML = `
            <div class="pago-listo">
                <div class="check-animado"><i class="fa-solid fa-check"></i></div>
                <h3>¡Pago aprobado!</h3>
                <p>Pagaste <strong>${soles(pago.monto)}</strong> con <strong>${esc(pago.entidad || '')}</strong>.</p>
                <div class="recibo-mini">
                    <div><span>Comprobante</span><strong class="mono">${esc(pago.numero || '—')}</strong></div>
                    <div><span>Operación</span><strong class="mono">${esc(pago.operacion || '')}</strong></div>
                    <div><span>Fecha</span><strong>${esc(pago.fecha || '')}</strong></div>
                </div>
                <ol class="linea-estado">
                    <li class="hecho"><i class="fa-solid fa-check"></i><span>Pagado</span></li>
                    <li class="hecho"><i class="fa-solid fa-check"></i><span>Confirmado</span></li>
                    <li class="hecho"><i class="fa-solid fa-file-invoice"></i><span>${pago.tipo === 'FACTURA' ? 'Factura' : 'Boleta'} emitida</span></li>
                </ol>
                ${demo ? '<p class="small muted"><i class="fa-solid fa-flask"></i> Modo demostración: no se cobró dinero real.</p>' : '<p class="small muted">Descarga tu comprobante en “Pagos y comprobantes”.</p>'}
            </div>
            <div class="modal-pie"><button type="button" class="btn btn-primary" data-cerrar data-foco>Listo</button></div>`;
        cuerpo.querySelector('[data-foco]')?.focus();
        alTerminar?.(pago);
    };

    // ---------- Paso 2: instrucciones para pagar
    const paso2 = () => {
        marcarPaso(2);
        const mk = marca(cuenta.entidad);
        const billetera = cuenta.metodo !== 'transferencia';
        const app = mk.corto;
        const pasosTxt = billetera
            ? [`Abre tu app de <strong>${esc(app)}</strong>.`, cuenta.qr ? 'Escanea el código QR <em>o</em> busca el número.' : 'Elige “Yapear/Plinear a un número” y escribe el número.',
               `Ingresa <strong>exactamente ${soles(cotizacion.monto)}</strong>.`, `En el mensaje escribe <strong>${esc(ref)}</strong>.`, 'Guarda la captura de la constancia.']
            : [`Entra a tu banca por internet o app de tu banco.`, `Transfiere a la cuenta ${cuenta.cci ? 'o al CCI ' : ''}de ${esc(cuenta.titular)}.`,
               `Monto: <strong>exactamente ${soles(cotizacion.monto)}</strong>.`, `En la descripción escribe <strong>${esc(ref)}</strong>.`, 'Guarda la constancia (captura o PDF convertido a imagen).'];
        cuerpo.innerHTML = `
            <div class="pago-instr ${mk.clase}">
                <div class="pago-destino">
                    ${billetera && cuenta.qr ? `<div class="qr-caja"><img src="${cuenta.qr}" alt="Código QR de ${esc(app)} de ${esc(cuenta.titular)}"><span>Escanéame con ${esc(app)}</span></div>` : `<div class="qr-caja sin-qr"><i class="fa-solid ${mk.icono}"></i><span>${esc(app)}</span></div>`}
                    <div class="destino-datos">
                        <div class="dato-copiable"><span class="label">${billetera ? `Número ${esc(app)}` : `Cuenta ${esc(app)}`}</span>
                            <div><strong class="mono grande">${esc(grupo(cuenta.numero))}</strong><button type="button" class="icon-btn" data-copiar="${esc(cuenta.numero)}" data-etq="Número copiado" aria-label="Copiar número"><i class="fa-regular fa-copy"></i></button></div></div>
                        ${cuenta.cci ? `<div class="dato-copiable"><span class="label">CCI (desde otros bancos)</span>
                            <div><strong class="mono">${esc(grupo(cuenta.cci))}</strong><button type="button" class="icon-btn" data-copiar="${esc(cuenta.cci)}" data-etq="CCI copiado" aria-label="Copiar CCI"><i class="fa-regular fa-copy"></i></button></div></div>` : ''}
                        <div class="dato-copiable"><span class="label">Titular</span><div><strong>${esc(cuenta.titular)}</strong></div></div>
                        <div class="dato-copiable monto"><span class="label">Monto exacto</span>
                            <div><strong class="mono grande">${soles(cotizacion.monto)}</strong><button type="button" class="icon-btn" data-copiar="${Number(cotizacion.monto).toFixed(2)}" data-etq="Monto copiado" aria-label="Copiar monto"><i class="fa-regular fa-copy"></i></button></div></div>
                        <div class="dato-copiable"><span class="label">Mensaje / referencia</span>
                            <div><strong class="mono">${esc(ref)}</strong><button type="button" class="icon-btn" data-copiar="${esc(ref)}" data-etq="Referencia copiada" aria-label="Copiar referencia"><i class="fa-regular fa-copy"></i></button></div></div>
                    </div>
                </div>
                <ol class="pasos-app">${pasosTxt.map(t => `<li>${t}</li>`).join('')}</ol>
                ${cuenta.instrucciones ? `<div class="aviso agua"><i class="fa-solid fa-circle-info"></i><span>${esc(cuenta.instrucciones)}</span></div>` : ''}
                <div class="reloj-pago"><i class="fa-regular fa-clock"></i> Te reservamos este monto por <strong id="pp-reloj">15:00</strong>. Si se agota, vuelve a abrir el pago: el monto se recalcula con tu consumo.</div>
            </div>
            <div class="modal-pie">
                <button type="button" class="btn btn-ghost" data-volver><i class="fa-solid fa-arrow-left"></i> Otro medio</button>
                <button type="button" class="btn btn-arena" data-siguiente data-foco>Ya pagué, enviar constancia <i class="fa-solid fa-arrow-right"></i></button>
            </div>`;
        cuerpo.querySelectorAll('[data-copiar]').forEach(b => b.addEventListener('click', () => copiar(b.dataset.copiar, b.dataset.etq)));
        cuerpo.querySelector('[data-volver]').addEventListener('click', paso1);
        cuerpo.querySelector('[data-siguiente]').addEventListener('click', paso3);
        const fin = Date.now() + 15 * 60000;
        clearInterval(reloj);
        reloj = setInterval(() => {
            const el = cuerpo.querySelector('#pp-reloj');
            if (!el) return clearInterval(reloj);
            const s = Math.max(0, Math.round((fin - Date.now()) / 1000));
            el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
            if (!s) { clearInterval(reloj); el.closest('.reloj-pago').classList.add('agotado'); }
        }, 1000);
    };

    // ---------- Paso 3: enviar constancia
    const paso3 = () => {
        marcarPaso(3);
        const billetera = cuenta.metodo !== 'transferencia';
        cuerpo.innerHTML = `
            <form id="pp-form" class="form-grid" novalidate>
                <div class="voucher-zona" id="pp-zona" tabindex="0" role="button" aria-label="Subir captura de la constancia">
                    <input type="file" id="pp-file" accept="image/png,image/jpeg,image/webp" hidden>
                    <div class="voucher-vacio"><i class="fa-solid fa-cloud-arrow-up"></i><strong>Sube la captura de tu constancia</strong><span>Arrástrala aquí o toca para elegirla${billetera ? '' : ' (recomendado)'}</span></div>
                    <img alt="Vista previa de la constancia" class="hidden">
                </div>
                <span class="error" data-error-de="voucher"></span>
                <div class="form-grid cols-2" style="gap:12px">
                    <div class="field">
                        <label for="pp-op">N.° de operación</label>
                        <input id="pp-op" name="operacion" class="input mono" maxlength="30" autocomplete="off" placeholder="${billetera ? 'Ej. 04512873' : 'Ej. 123456'}" required data-validar="operacion">
                        <span class="hint">Aparece en la constancia de ${esc(marca(cuenta.entidad).corto)}.</span>
                        <span class="error" data-error-de="operacion"></span>
                    </div>
                    <div class="field">
                        <label for="pp-fecha">Fecha y hora del pago</label>
                        <input id="pp-fecha" name="fecha_operacion" type="datetime-local" class="input" value="${ahoraLocal()}" max="${ahoraLocal()}" required>
                        <span class="error" data-error-de="fecha_operacion"></span>
                    </div>
                </div>
                <div class="field">
                    <label for="pp-monto">Monto pagado (S/)</label>
                    <input id="pp-monto" name="monto" class="input mono" inputmode="decimal" value="${Number(cotizacion.monto).toFixed(2)}" required data-validar="monto">
                    <span class="hint">Debe ser exactamente ${soles(cotizacion.monto)}.</span>
                    <span class="error" data-error-de="monto"></span>
                </div>
                <div class="field">
                    <label for="pp-email"><i class="fa-regular fa-envelope"></i> Correo para avisarte <span class="muted">(opcional)</span></label>
                    <input id="pp-email" name="email" type="email" class="input" maxlength="120" placeholder="tucorreo@gmail.com" data-validar="email-opcional" spellcheck="false" autocapitalize="off" inputmode="email">
                    <span class="error" data-error-de="email"></span>
                </div>
                <div class="modal-pie" style="padding:0;border:0">
                    <button type="button" class="btn btn-ghost" data-volver><i class="fa-solid fa-arrow-left"></i> Volver</button>
                    <button type="submit" class="btn btn-arena"><i class="fa-solid fa-paper-plane"></i> Enviar constancia</button>
                </div>
            </form>`;
        const form = cuerpo.querySelector('#pp-form');
        const zona = cuerpo.querySelector('#pp-zona');
        const file = cuerpo.querySelector('#pp-file');
        const img = zona.querySelector('img');
        const cargar = async archivo => {
            if (!archivo) return;
            try {
                zona.classList.add('cargando-img');
                voucher = await comprimir(archivo);
                img.src = voucher; img.classList.remove('hidden');
                zona.classList.add('con-imagen');
                form.querySelector('[data-error-de="voucher"]').textContent = '';
            } catch (err) { toast(err.message, 'error'); } finally { zona.classList.remove('cargando-img'); }
        };
        zona.addEventListener('click', () => file.click());
        zona.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
        file.addEventListener('change', () => cargar(file.files[0]));
        zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('arrastrando'); });
        zona.addEventListener('dragleave', () => zona.classList.remove('arrastrando'));
        zona.addEventListener('drop', e => { e.preventDefault(); zona.classList.remove('arrastrando'); cargar(e.dataTransfer.files[0]); });
        if (voucher) { img.src = voucher; img.classList.remove('hidden'); zona.classList.add('con-imagen'); }
        cuerpo.querySelector('[data-volver]').addEventListener('click', paso2);
        form.operacion.focus();
        form.addEventListener('submit', async e => {
            e.preventDefault();
            limpiarErrores(form);
            const errores = {};
            const op = form.operacion.value.trim();
            if (!/^[A-Za-z0-9-]{4,30}$/.test(op)) errores.operacion = 'Entre 4 y 30 caracteres: letras, números o guiones.';
            if (!form.fecha_operacion.value) errores.fecha_operacion = 'Indica la fecha y hora.';
            const monto = Number(form.monto.value.replace(',', '.'));
            if (Math.abs(monto - Number(cotizacion.monto)) > 0.009) errores.monto = `Debe ser exactamente ${soles(cotizacion.monto)}.`;
            if (billetera && !voucher) errores.voucher = 'Sube la captura de tu constancia.';
            const email = form.email.value.trim().toLowerCase();
            const pe = email ? problemaEmail(email) : null;
            if (pe) errores.email = pe;
            if (Object.keys(errores).length) {
                if (errores.voucher) form.querySelector('[data-error-de="voucher"]').textContent = errores.voucher;
                erroresServidor(form, errores);
                return;
            }
            try {
                const r = await conCarga(form.querySelector('[type=submit]'), () => post('/pagos/reportar', {
                    cliente_id: estado.clienteId, tipo, cuenta_id: cuenta.id, operacion: op,
                    fecha_operacion: new Date(form.fecha_operacion.value).toISOString(), monto, voucher: voucher || undefined, email: email || undefined,
                }), 'Enviando…');
                listo(r.pago);
                alTerminar?.(r.pago);
            } catch (err) {
                if (err.campos?.voucher) form.querySelector('[data-error-de="voucher"]').textContent = err.campos.voucher;
                erroresServidor(form, err.campos);
                toast(err.message, 'error', 7000);
            }
        });
    };

    // ---------- Paso 4: enviado
    const listo = pago => {
        clearInterval(reloj);
        m.el.querySelector('#pp-pasos').classList.add('hidden');
        cuerpo.innerHTML = `
            <div class="pago-listo">
                <div class="check-animado"><i class="fa-solid fa-check"></i></div>
                <h3>¡Constancia enviada!</h3>
                <p>Recibimos tu pago de <strong>${soles(pago.monto)}</strong> por ${esc(marca(pago.entidad).corto)} (operación <span class="mono">${esc(pago.operacion)}</span>).</p>
                <ol class="linea-estado">
                    <li class="hecho"><i class="fa-solid fa-check"></i><span>Enviado</span></li>
                    <li class="actual"><i class="fa-solid fa-magnifying-glass"></i><span>La Junta valida tu pago</span></li>
                    <li><i class="fa-solid fa-file-invoice"></i><span>Se emite tu ${pago.tipo === 'FACTURA' ? 'factura' : 'boleta'}</span></li>
                </ol>
                <p class="small muted">La validación se hace en horario de oficina. Verás el estado en “Pagos y comprobantes”.</p>
            </div>
            <div class="modal-pie"><button type="button" class="btn btn-primary" data-cerrar data-foco>Entendido</button></div>`;
        cuerpo.querySelector('[data-foco]')?.focus();
    };

    paso1();
}
