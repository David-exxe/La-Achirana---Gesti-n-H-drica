// Prueba local del microservicio (proveedor "consola"): node prueba.js
process.env.CORREO_CLAVE = 'clave-de-prueba-123';
process.env.CORREO_PROVEEDOR = 'consola';
const assert = require('assert');
const { servidor } = require('./server');
const { PLANTILLAS } = require('./plantillas');

servidor.listen(0, async () => {
    const base = `http://127.0.0.1:${servidor.address().port}`;
    const enviar = (cuerpo, clave = process.env.CORREO_CLAVE) => fetch(`${base}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clave}` }, body: JSON.stringify(cuerpo),
    });
    try {
        const salud = await (await fetch(`${base}/salud`)).json();
        assert.equal(salud.ok, true);
        assert.equal((await enviar({ plantilla: 'prueba', para: ['a@b.pe'] }, 'mala')).status, 401);
        assert.equal((await enviar({ plantilla: 'prueba', para: ['sin-arroba.pe'] })).status, 400);
        assert.equal((await enviar({ plantilla: 'prueba', para: ['a@dominio'] })).status, 400);
        assert.equal((await enviar({ plantilla: 'nada', para: ['a@b.pe'] })).status, 400);
        const datos = { cliente: 'Regante <b>X</b>', documento: '99000001', monto: 120.5, numero: 'B001-00000001', medio: 'Yape', operacion: 'DEMO-1', demo: true, url: 'https://x.pe' };
        for (const p of Object.keys(PLANTILLAS)) {
            const r = await enviar({ plantilla: p, para: ['junta@laachirana.pe'], datos });
            assert.equal(r.status, 202, p);
        }
        const html = PLANTILLAS.pago_aprobado(datos).html;
        assert.ok(!html.includes('<b>X</b>') && html.includes('&lt;b&gt;'), 'escapa HTML');
        console.log('✅ servicio-correo: todas las pruebas pasaron');
    } catch (e) {
        console.error('❌', e.message); process.exitCode = 1;
    } finally { servidor.close(); }
});
