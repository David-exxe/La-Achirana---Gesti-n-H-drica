// Estado compartido de la aplicación
export const estado = {
    sesion: null,        // { tipo: 'usuario' | 'cliente', datos }
    clienteId: null,     // cliente que se está viendo
    cliente: null,       // datos del cliente actual
    clientes: [],        // lista (solo personal)
    clima: null,         // último resumen de clima
    vista: 'inicio',
};

const rol = () => estado.sesion?.datos?.rol;
/** Cualquier usuario de la Junta (admin, operador o gerente). */
export const esStaff = () => estado.sesion?.tipo === 'usuario';
/** Personal operativo: registra caudal, turnos, pagos (admin y operador). El gerente es de solo lectura. */
export const esPersonal = () => esStaff() && rol() !== 'gerente';
export const esAdmin = () => esStaff() && rol() === 'admin';
export const esGerente = () => esStaff() && rol() === 'gerente';
/** Puede ver la vista gerencial (gerente y administrador). */
export const esGestion = () => esAdmin() || esGerente();
export const esCliente = () => estado.sesion?.tipo === 'cliente';
