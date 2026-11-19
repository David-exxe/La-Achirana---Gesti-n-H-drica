// =====================================================================
//  Rutas de la API
//   Leyenda:  🔓 pública   🔐 sesión (cliente o personal)   🛡️ solo admin   📊 gerencia (gerente y admin)
// =====================================================================
const { Router } = require('express');
const { requiereSesion, requiereAdmin } = require('../middleware/auth');
const { limitador } = require('../middleware/seguridad');

const auth = require('../controllers/auth.controller');
const clientes = require('../controllers/clientes.controller');
const usuarios = require('../controllers/usuarios.controller');
const caudal = require('../controllers/caudal.controller');
const pagos = require('../controllers/pagos.controller');
const clima = require('../controllers/clima.controller');
const turnos = require('../controllers/turnos.controller');
const gerencia = require('../controllers/gerencia.controller');

const r = Router();

const limiteLogin = limitador({ ventanaMs: 15 * 60 * 1000, max: 20, mensaje: 'Demasiados intentos de ingreso desde tu red. Espera 15 minutos.' });
const limitePago = limitador({ ventanaMs: 60 * 1000, max: 10, mensaje: 'Demasiadas solicitudes de pago. Espera un minuto.' });

// 🔓 Autenticación
r.post('/auth/login-admin', limiteLogin, auth.loginAdmin);
r.post('/auth/login-cliente', limiteLogin, auth.loginCliente);

// A partir de aquí todo requiere sesión
r.use(requiereSesion);
r.get('/auth/yo', auth.yo);

// Clientes
r.get('/clientes', requiereAdmin('operador', 'gerente'), clientes.listar);
r.get('/clientes/:id', clientes.obtener);                    // 🔐 un cliente solo ve el suyo
r.post('/admin/clientes', requiereAdmin(), clientes.crear);
r.put('/admin/clientes/:id', requiereAdmin(), clientes.actualizar);
r.delete('/admin/clientes/:id', requiereAdmin(), clientes.eliminar);
r.post('/admin/clientes/:id/reactivar', requiereAdmin(), clientes.reactivar);

// Usuarios administradores
r.get('/admin/usuarios', requiereAdmin('gerente'), usuarios.listar);
r.post('/admin/usuarios', requiereAdmin(), usuarios.crear);
r.put('/admin/usuarios/:id', requiereAdmin(), usuarios.actualizar);
r.delete('/admin/usuarios/:id', requiereAdmin(), usuarios.eliminar);
r.get('/admin/auditoria', requiereAdmin('gerente'), usuarios.auditoriaReciente);

// Caudal
r.get('/caudal', caudal.listar);
r.get('/caudal/resumen', caudal.resumen);
r.get('/caudal/grafico', caudal.grafico);
r.post('/caudal', requiereAdmin('operador'), caudal.crear);
r.delete('/caudal/:id', requiereAdmin(), caudal.eliminar);

// Pagos
r.get('/pagos', pagos.listar);
r.get('/pagos/cotizacion', pagos.cotizacion);
r.get('/pagos/medios', pagos.medios);                         // 🔐 Yape, Plin y cuentas de la Junta
r.post('/pagos/reportar', limitePago, pagos.reportar);         // 🔐 el regante informa su pago con voucher
r.get('/pagos/en-linea', pagos.enLinea);                       // 🔐 Culqi o modo demostración
r.post('/pagos/culqi/cargo', limitePago, pagos.cargoCulqi);    // 🔐 tarjeta / Yape vía Culqi
r.post('/pagos/demo/cargo', limitePago, pagos.cargoDemo);      // 🔐 solo en modo demostración
r.get('/pagos/:id/comprobante', pagos.comprobante);
r.get('/pagos/:id/voucher', pagos.voucher);
r.post('/admin/pagos/manual', requiereAdmin(), pagos.pagoManual);
r.get('/admin/pagos/por-validar', requiereAdmin('gerente'), pagos.porValidar);
r.post('/admin/pagos/:id/validar', requiereAdmin(), pagos.validar);
r.get('/admin/correo/estado', requiereAdmin(), pagos.estadoCorreo);
r.post('/admin/correo/prueba', requiereAdmin(), pagos.probarCorreo);
r.get('/admin/culqi/diagnostico', requiereAdmin(), pagos.diagnosticoCulqi);
r.get('/admin/recaudacion-total', requiereAdmin('gerente'), pagos.recaudacion);
r.get('/admin/cuentas-cobro', requiereAdmin(), pagos.listarCuentas);
r.post('/admin/cuentas-cobro', requiereAdmin(), pagos.crearCuenta);
r.put('/admin/cuentas-cobro/:id', requiereAdmin(), pagos.actualizarCuenta);
r.delete('/admin/cuentas-cobro/:id', requiereAdmin(), pagos.eliminarCuenta);
r.get('/tarifa', pagos.obtenerTarifa);
r.post('/admin/tarifa', requiereAdmin(), pagos.cambiarTarifa);

// Canal y turnos de riego
r.get('/canal/caudal', requiereAdmin('operador', 'gerente'), turnos.listarCaudalCanal);
r.post('/canal/caudal', requiereAdmin('operador'), turnos.registrarCaudalCanal);
r.get('/turnos', turnos.listar);                               // 🔐 el cliente solo ve los suyos
r.post('/turnos/generar', requiereAdmin('operador'), turnos.generar);
r.post('/turnos/:id/cancelar', requiereAdmin('operador'), turnos.cancelar);
r.get('/turnos/demandas', requiereAdmin('operador', 'gerente'), turnos.demandas);
r.get('/admin/riego/parametros', requiereAdmin('gerente'), turnos.obtenerParametros);
r.put('/admin/riego/parametros', requiereAdmin(), turnos.guardarParametros);

// Clima y alertas
r.get('/clima/resumen', clima.resumen);
r.get('/clima/lluvia', clima.malla);
r.get('/admin/clima/puntos', requiereAdmin(), clima.listarPuntos);
r.post('/admin/clima/puntos', requiereAdmin(), clima.crearPunto);
r.put('/admin/clima/puntos/:id', requiereAdmin(), clima.actualizarPunto);
r.delete('/admin/clima/puntos/:id', requiereAdmin(), clima.eliminarPunto);
r.get('/admin/clima/historial', requiereAdmin(), clima.historial);

// 📊 Gerencia
r.get('/gerencia/resumen', requiereAdmin('gerente'), gerencia.resumen);
r.get('/gerencia/finanzas', requiereAdmin('gerente'), gerencia.finanzas);
r.get('/gerencia/movimientos', requiereAdmin('gerente'), gerencia.listarMovimientos);
r.post('/gerencia/movimientos', requiereAdmin('gerente'), gerencia.crearMovimiento);
r.delete('/gerencia/movimientos/:id', requiereAdmin('gerente'), gerencia.eliminarMovimiento);
r.get('/gerencia/capacidad', requiereAdmin('gerente'), gerencia.capacidad);
r.post('/gerencia/simular', requiereAdmin('gerente'), gerencia.simular);

module.exports = r;
