// =====================================================================
//  Imágenes subidas (voucher de pago, QR de Yape/Plin)
//  Se aceptan solo JPG, PNG o WEBP verificando la "firma" real del archivo.
// =====================================================================
const { ErrorHttp } = require('./validacion');

const FIRMAS = [
    { mime: 'image/png', ok: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { mime: 'image/jpeg', ok: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mime: 'image/webp', ok: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/** Convierte "data:image/...;base64,..." en { mime, datos } validando tipo y tamaño. */
function leerImagen(dataUrl, { campo = 'imagen', maxBytes = 3 * 1024 * 1024, obligatoria = true } = {}) {
    if (dataUrl === undefined || dataUrl === null || dataUrl === '') {
        if (obligatoria) throw new ErrorHttp(400, 'Adjunta la imagen.', { [campo]: 'Adjunta una foto o captura.' });
        return null;
    }
    if (typeof dataUrl !== 'string') throw new ErrorHttp(400, 'Imagen no válida.', { [campo]: 'Formato no válido.' });
    const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new ErrorHttp(400, 'La imagen debe ser JPG, PNG o WEBP.', { [campo]: 'Solo JPG, PNG o WEBP.' });
    const datos = Buffer.from(m[2], 'base64');
    if (datos.length > maxBytes) throw new ErrorHttp(400, `La imagen pesa más de ${Math.round(maxBytes / 1048576)} MB.`, { [campo]: 'Imagen demasiado grande.' });
    const tipo = FIRMAS.find(f => f.ok(datos));
    if (!tipo) throw new ErrorHttp(400, 'El archivo no es una imagen válida.', { [campo]: 'No es una imagen válida.' });
    return { mime: tipo.mime, datos };
}

const aDataUrl = (mime, datos) => (mime && datos ? `data:${mime};base64,${Buffer.from(datos).toString('base64')}` : null);

module.exports = { leerImagen, aDataUrl };
