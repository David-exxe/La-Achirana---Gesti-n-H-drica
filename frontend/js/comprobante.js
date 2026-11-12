// =====================================================================
//  Comprobante (boleta/factura) en pantalla y en PDF
// =====================================================================
import { esc, soles, abrirModal, toast } from './ui.js';

const EMISOR = {
    nombre: 'JUNTA DE USUARIOS LA ACHIRANA',
    linea: 'Distrito de Riego Ica · Sector Hidráulico Ica',
    ruc: '20456789123', // ⚠️ Reemplaza por el RUC real de la Junta
    email: 'administracion@laachirana.org.pe',
};

const titulo = p => (p.tipo === 'FACTURA' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA ELECTRÓNICA');
const medio = m => ({ mercadopago: 'Mercado Pago', yape: 'Yape', plin: 'Plin', tarjeta: 'Tarjeta', efectivo: 'Efectivo', transferencia: 'Transferencia', deposito: 'Depósito', legado: 'Sistema anterior' }[m] || m);

export function mostrarComprobante(p) {
    const html = `
        <div class="modal-cuerpo" style="padding:18px">
            <div class="comprobante" id="comprobante-imprimible">
                <div class="comp-cab">
                    <div>
                        <h2>${EMISOR.nombre}</h2>
                        <p>${EMISOR.linea}</p>
                        <p>${EMISOR.email}</p>
                    </div>
                    <div class="comp-ruc">
                        <div><strong>R.U.C. ${EMISOR.ruc}</strong></div>
                        <div class="t">${titulo(p)}</div>
                        <div class="n">${esc(p.numero || 'SIN NÚMERO')}</div>
                    </div>
                </div>
                <dl class="comp-datos">
                    <dt>Señor(es)</dt><dd>${esc(p.cliente_nombre)}</dd>
                    <dt>${p.cliente_tipo === 'empresa' ? 'RUC' : 'DNI'}</dt><dd>${esc(p.cliente_doc)}</dd>
                    <dt>Dirección</dt><dd>${esc(p.cliente_dir || '–')}</dd>
                    <dt>Fecha emisión</dt><dd>${esc(p.fecha)}</dd>
                    <dt>Medio de pago</dt><dd>${esc(medio(p.metodo))}${p.mp_payment_id ? ` · Operación ${esc(p.mp_payment_id)}` : ''}</dd>
                    <dt>Moneda</dt><dd>Soles (PEN)</dd>
                </dl>
                <table class="comp-tabla">
                    <thead><tr><th>Cant.</th><th>U.M.</th><th>Descripción</th><th style="text-align:right">Importe</th></tr></thead>
                    <tbody><tr><td>${esc(Number(p.volumen_m3 || 1).toFixed(2))}</td><td>${p.volumen_m3 ? 'M3' : 'NIU'}</td><td>${esc(p.concepto)}</td><td style="text-align:right">${soles(p.total)}</td></tr></tbody>
                </table>
                <div class="comp-totales">
                    <span>Op. gravada</span><span>${soles(p.subtotal)}</span>
                    <span>IGV (18 %)</span><span>${soles(p.igv)}</span>
                    <span class="total">Importe total</span><span class="total">${soles(p.total)}</span>
                </div>
                <div class="comp-pie">
                    Representación impresa del comprobante electrónico. Documento generado por el sistema de gestión de la Junta.
                </div>
            </div>
        </div>
        <div class="modal-pie">
            <button type="button" class="btn btn-ghost" data-cerrar>Cerrar</button>
            <button type="button" class="btn btn-ghost" data-imprimir><i class="fa-solid fa-print"></i> Imprimir</button>
            <button type="button" class="btn btn-primary" data-pdf data-foco><i class="fa-solid fa-file-arrow-down"></i> Descargar PDF</button>
        </div>`;
    const m = abrirModal(html, { ancho: true });
    m.el.querySelector('[data-pdf]').addEventListener('click', () => descargarPdf(p));
    m.el.querySelector('[data-imprimir]').addEventListener('click', () => window.print());
}

export function descargarPdf(p) {
    if (!window.jspdf) return toast('No se pudo cargar el generador de PDF. Revisa tu conexión.', 'error');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const azul = [15, 79, 87];
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...azul);
    doc.text(EMISOR.nombre, 15, 22);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text([EMISOR.linea, EMISOR.email], 15, 28);

    doc.setDrawColor(29, 42, 51); doc.setLineWidth(0.6); doc.roundedRect(130, 12, 65, 30, 2, 2);
    doc.setTextColor(29, 42, 51); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text(`R.U.C. ${EMISOR.ruc}`, 162.5, 19, { align: 'center' });
    doc.setFillColor(29, 42, 51); doc.rect(130, 22, 65, 8, 'F');
    doc.setTextColor(255); doc.setFontSize(8.5); doc.text(titulo(p), 162.5, 27.3, { align: 'center' });
    doc.setTextColor(180, 35, 24); doc.setFontSize(12); doc.text(p.numero || '-', 162.5, 37.5, { align: 'center' });

    doc.setDrawColor(185, 196, 203); doc.setLineDashPattern([1.5, 1.5], 0); doc.line(15, 48, 195, 48); doc.setLineDashPattern([], 0);
    const filas = [
        ['Señor(es):', p.cliente_nombre], [p.cliente_tipo === 'empresa' ? 'RUC:' : 'DNI:', p.cliente_doc],
        ['Dirección:', p.cliente_dir || '-'], ['Fecha emisión:', p.fecha],
        ['Medio de pago:', `${medio(p.metodo)}${p.mp_payment_id ? ` - Operación ${p.mp_payment_id}` : ''}`], ['Moneda:', 'Soles (PEN)'],
    ];
    doc.setFontSize(9.5); doc.setTextColor(29, 42, 51);
    filas.forEach(([k, v], i) => { doc.setFont('helvetica', 'bold'); doc.text(k, 15, 56 + i * 6); doc.setFont('helvetica', 'normal'); doc.text(String(v), 48, 56 + i * 6); });

    let y = 96;
    doc.setFillColor(29, 42, 51); doc.rect(15, y, 180, 8, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('CANT.', 18, y + 5.5); doc.text('U.M.', 38, y + 5.5); doc.text('DESCRIPCIÓN', 55, y + 5.5); doc.text('IMPORTE', 192, y + 5.5, { align: 'right' });
    doc.setTextColor(29, 42, 51); doc.setFont('helvetica', 'normal');
    const desc = doc.splitTextToSize(p.concepto, 105);
    doc.text(Number(p.volumen_m3 || 1).toFixed(2), 18, y + 14); doc.text(p.volumen_m3 ? 'M3' : 'NIU', 38, y + 14);
    doc.text(desc, 55, y + 14); doc.text(soles(p.total), 192, y + 14, { align: 'right' });
    y += 16 + desc.length * 4.5;
    doc.setDrawColor(185, 196, 203); doc.line(15, y, 195, y);

    y += 10;
    const tot = [['Op. gravada', soles(p.subtotal)], ['IGV (18 %)', soles(p.igv)]];
    tot.forEach(([k, v], i) => { doc.text(k, 130, y + i * 6); doc.text(v, 192, y + i * 6, { align: 'right' }); });
    doc.setDrawColor(29, 42, 51); doc.setLineWidth(0.6); doc.line(130, y + 9, 195, y + 9);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...azul);
    doc.text('Importe total', 130, y + 15); doc.text(soles(p.total), 192, y + 15, { align: 'right' });

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100);
    doc.text('Representación impresa del comprobante electrónico generado por el sistema de la Junta de Usuarios La Achirana.', 105, 280, { align: 'center' });
    doc.save(`${p.tipo === 'FACTURA' ? 'Factura' : 'Boleta'}_${p.numero || p.id}.pdf`);
}
