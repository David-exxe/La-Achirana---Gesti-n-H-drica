// Plantillas de correo (HTML con estilos en línea, compatibles con Gmail y Outlook)
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const soles = n => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function marco({ titulo, color = '#0f5c63', etiqueta, cuerpo, boton }) {
    return `<!doctype html><html lang="es"><body style="margin:0;background:#eef2f3;font-family:Arial,Helvetica,sans-serif;color:#1d2b33">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f3;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 28px rgba(15,40,50,.12)">
<tr><td style="background:${color};padding:22px 28px;color:#fff">
  <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.8">La Achirana · Junta de Usuarios</div>
  <div style="font-size:22px;font-weight:bold;margin-top:6px">${esc(titulo)}</div>
  ${etiqueta ? `<div style="display:inline-block;margin-top:10px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.18);font-size:12px">${esc(etiqueta)}</div>` : ''}
</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.55">${cuerpo}
${boton ? `<div style="margin-top:22px"><a href="${esc(boton.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${esc(boton.texto)}</a></div>` : ''}
</td></tr>
<tr><td style="padding:14px 28px 22px;font-size:12px;color:#7a8b93;border-top:1px solid #e6ecee">Correo automático del Sistema de Gestión Hídrica La Achirana. No respondas a este mensaje.</td></tr>
</table></td></tr></table></body></html>`;
}

function tabla(filas) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid #e6ecee;border-radius:12px;border-collapse:separate;overflow:hidden">
${filas.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v], i) => `<tr style="background:${i % 2 ? '#f7fafb' : '#fff'}"><td style="padding:10px 14px;color:#5b6d75;font-size:13px;width:42%">${esc(k)}</td><td style="padding:10px 14px;font-weight:bold;font-size:14px">${esc(v)}</td></tr>`).join('')}
</table>`;
}

function texto(filas) {
    return filas.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');
}

const PLANTILLAS = {
    // Para la Junta: un regante envió su constancia (Yape, Plin o banco)
    pago_reportado: d => {
        const filas = [['Regante', d.cliente], ['Documento', d.documento], ['Monto', soles(d.monto)], ['Medio', d.medio], ['N.° de operación', d.operacion], ['Fecha de la operación', d.fecha_operacion]];
        return {
            asunto: `Pago por validar: ${soles(d.monto)} · ${d.cliente}`,
            html: marco({ titulo: 'Nuevo pago por validar', color: '#b07d2b', etiqueta: 'Requiere revisión', cuerpo: `<p style="margin:0">Un regante reportó un pago con constancia. Revisa el voucher y apruébalo o recházalo.</p>${tabla(filas)}`, boton: d.url ? { texto: 'Abrir pagos por validar', url: d.url } : null }),
            texto: `Nuevo pago por validar\n${texto(filas)}`,
        };
    },
    // Para el regante: recibimos su constancia
    constancia_recibida: d => {
        const filas = [['Monto', soles(d.monto)], ['Medio', d.medio], ['N.° de operación', d.operacion]];
        return {
            asunto: 'Recibimos tu constancia de pago',
            html: marco({ titulo: 'Constancia recibida', etiqueta: 'En validación', cuerpo: `<p style="margin:0">Hola${d.cliente ? `, ${esc(d.cliente)}` : ''}. La Junta revisará tu pago y te enviará tu comprobante cuando lo apruebe.</p>${tabla(filas)}` }),
            texto: `Constancia recibida (en validación)\n${texto(filas)}`,
        };
    },
    // Para la Junta y el regante: pago aprobado con comprobante
    pago_aprobado: d => {
        const filas = [['Regante', d.cliente], ['Documento', d.documento], ['Comprobante', d.numero], ['Monto', soles(d.monto)], ['Medio', d.medio], ['Operación', d.operacion], ['Volumen', d.volumen_m3 ? `${d.volumen_m3} m³` : null]];
        return {
            asunto: `Pago aprobado ${d.numero || ''} · ${soles(d.monto)}`.trim(),
            html: marco({ titulo: 'Pago aprobado', color: '#1f7a4d', etiqueta: d.demo ? 'Demostración · sin cobro real' : 'Comprobante emitido', cuerpo: `<p style="margin:0">${d.para_junta ? 'Se registró un pago aprobado en el sistema.' : 'Tu pago fue aprobado. Descarga tu comprobante desde “Pagos y comprobantes”.'}</p>${tabla(filas)}`, boton: d.url ? { texto: 'Ver en el sistema', url: d.url } : null }),
            texto: `Pago aprobado\n${texto(filas)}`,
        };
    },
    // Para el regante: pago rechazado
    pago_rechazado: d => {
        const filas = [['Monto', soles(d.monto)], ['Operación', d.operacion], ['Motivo', d.motivo]];
        return {
            asunto: 'Tu pago no pudo ser validado',
            html: marco({ titulo: 'Pago no validado', color: '#b23b3b', etiqueta: 'Revisa y vuelve a enviar', cuerpo: `<p style="margin:0">La Junta no pudo validar tu constancia. Puedes enviarla de nuevo desde el sistema.</p>${tabla(filas)}` }),
            texto: `Pago no validado\n${texto(filas)}`,
        };
    },
    // Prueba desde el panel
    prueba: d => ({
        asunto: 'Prueba de notificaciones · La Achirana',
        html: marco({ titulo: 'Las notificaciones funcionan', etiqueta: 'Correo de prueba', cuerpo: `<p style="margin:0">Este correo confirma que el sistema puede avisarte de cada pago.</p>${tabla([['Enviado por', d.usuario], ['Fecha', d.fecha]])}` }),
        texto: `Correo de prueba de La Achirana. Enviado por ${d.usuario || '—'} el ${d.fecha || ''}.`,
    }),
};

function renderizar(nombre, datos) {
    return PLANTILLAS[nombre](datos);
}

module.exports = { PLANTILLAS, renderizar, esc };
