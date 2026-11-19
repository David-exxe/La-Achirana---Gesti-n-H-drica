# La Achirana · Gestión hídrica (v3.2)

Sistema web para la Junta de Usuarios La Achirana. Incluye consumo de agua por regante, cobro del canon hídrico con tarjeta y Yape en línea (Culqi), y con Yape, Plin y transferencias bancarias (BCP, Interbank, BBVA…), comprobantes, tablero gerencial con costos, ingresos, capacidad del canal y cupos por hectárea, y alertas de lluvia en la sierra con una simulación de cuándo llega el agua a Ica.

## 1. Instalación

```bash
npm install                 # usa solo express, pg y cors
cp .env.example .env        # en Windows: copy .env.example .env
npm run secret              # copia el resultado en JWT_SECRET del .env
npm start                   # abre http://localhost:3000
```

- El **frontend lo sirve el mismo backend**. Ya no hace falta Live Server: abre `http://localhost:3000`.
- Al iniciar, el servidor **migra tu base actual sin borrar datos**: agrega columnas y tablas nuevas, y cifra las contraseñas que estaban en texto plano. Tus admins siguen entrando con la misma clave.
- Si antes tenías instalados `mercadopago` o `dotenv`, ya no se usan. Puedes quitarlos con `npm uninstall mercadopago dotenv`.
- Mercado Pago se retiró por completo. Ya no necesitas `MP_ACCESS_TOKEN` en el `.env`.

## 2. Estructura

```
Backend/
  app.js                    servidor, cabeceras de seguridad, archivos estáticos
  Config/env.js             lee el .env (sin dependencias)
  Config/db.js              pool de PostgreSQL
  db/migraciones.js         esquema + migraciones idempotentes
  middleware/               auth (JWT y roles), seguridad (CSP, límite de peticiones), errores
  controllers/              auth, clientes, usuarios, caudal, pagos, clima, turnos, gerencia
  services/                 pagos, clima, turnos (cupos), auditoría
  utils/imagen.js           valida imágenes (QR y vouchers) por su contenido real
  routes/index.js           todas las rutas, con su nivel de acceso
frontend/
  index.html, css/styles.css
  vendor/                   Leaflet, Chart.js y Font Awesome locales (no dependen de CDN)
servicio-correo/            microservicio de correo (segundo servicio en Render, sin dependencias)
  js/  pago-linea.js (tarjeta/Yape Culqi y demo) · app.js (entrada) · api.js · validacion.js · ui.js · inicio.js · clima.js · pagos.js · analisis.js · admin.js · comprobante.js · turnos.js · gerencia.js · pagar.js · voucher.js
```

## 3. Pagos con Yape, Plin y bancos

**Primero configura las cuentas de cobro** en **Panel → Medios de pago**:
- **Yape o Plin:** celular (9 dígitos), titular y la **captura del QR** (en Yape: menú → "Mi QR" → descargar).
- **Banco:** entidad (BCP, Interbank, BBVA, Scotiabank, Banco de la Nación, BanBif, Caja Ica…), número de cuenta y CCI (20 dígitos).
- Puedes desactivar una cuenta sin borrarla. La columna derecha muestra cómo la verá el regante.

**Cómo paga el regante** (botón *Pagar con Yape, Plin o banco* en *Mi agua*):
1. **Elige** el medio: tarjetas con los colores de cada marca.
2. **Paga:** ve el QR o el número de cuenta. Tiene botones para copiar número, CCI, monto exacto y referencia (`ACH-<DNI/RUC>`). El monto queda reservado 15 minutos.
3. **Envía la constancia:** arrastra o toma la foto del voucher, que se comprime sola. Luego escribe el N.° de operación, la fecha y el monto.
4. El pago queda **"En validación"** y la deuda no se cobra dos veces.

**Cómo valida la Junta** en **Panel → Pagos por validar** (con contador rojo):
- Compara el voucher con tu app de Yape/Plin o con el estado de cuenta del banco.
- **Aprobar y emitir:** se genera la boleta o factura (B001-…, F001-…) y la deuda pasa a cero.
- **Rechazar:** eliges un motivo. El regante lo ve en su pantalla y puede volver a enviar.

**Controles:**
- El monto debe ser exacto.
- No se acepta el mismo N.° de operación dos veces en la misma entidad.
- Solo puede haber un pago en validación por regante.
- La imagen se verifica por su contenido (PNG, JPG o WEBP) y pesa como máximo 3 MB.

En caja, el personal registra pagos en efectivo, Yape, Plin, transferencia o depósito.

> Para que el pago se apruebe solo, sin revisar el voucher, usa el pago en línea con Culqi (sección 3a).

## 3a. Pago en línea con tarjeta o Yape (Culqi)

El regante también puede pagar **con tarjeta** (Visa, Mastercard, American Express o Diners) o con **Yape al instante**. El cobro se confirma solo y la boleta o factura se emite en el acto, sin validación manual.

**Cómo funciona:**
- La web abre el formulario seguro de **Culqi**. Los datos de la tarjeta van cifrados directo a Culqi; el servidor de la Junta nunca los ve ni los guarda (exigencia PCI).
- Culqi devuelve un *token*. El servidor cobra con su llave secreta y, si el cobro es exitoso, aprueba el pago y emite el comprobante.
- **Yape:** el regante escribe su celular y el **código de aprobación** que saca de su app (menú → Código de aprobación).
- **Si la tarjeta se rechaza**, el regante ve el mensaje del banco y no se cobra nada.
- **Si el banco pide 3D Secure**, el cobro no se hace y se le sugiere otro medio.

**Activarlo:**
1. Crea una cuenta de pruebas en https://integ-panel.culqi.com.
2. En **Desarrollo → API Keys**, copia la llave pública (`pk_test_…`) y la secreta (`sk_test_…`).
3. En **Desarrollo → RSA Keys**, genera y copia el RSA ID y la llave RSA. Es opcional, pero recomendado.
4. Pégalas en el `.env` (`CULQI_PUBLIC_KEY`, `CULQI_SECRET_KEY`, `CULQI_RSA_ID`, `CULQI_RSA_PUBLIC_KEY`) y reinicia con `npm start`.
5. Prueba con las tarjetas de prueba de Culqi, por ejemplo `4111 1111 1111 1111` con cualquier fecha futura y CVV `123`.
6. **Para cobrar dinero real**, la Junta debe afiliarse como comercio en Culqi con su **RUC**, su cuenta bancaria y su representante legal. Culqi revisa la afiliación y entrega las llaves `pk_live_…` y `sk_live_…`. Solo se cambian esas llaves en el `.env`.

**Modo demostración** (cuando no hay llaves de Culqi):
- Aparecen un formulario de tarjeta realista y un Yape simulado, marcados como **Demo**.
- **No se cobra dinero.** Solo acepta tarjetas de prueba: el botón *Usar tarjeta de prueba* rellena todo.
- Al servidor solo llegan la marca y los últimos 4 dígitos, nunca el número completo ni el CVV.
- Se apaga solo en producción (`NODE_ENV=production`) o con `PAGOS_DEMO=false`.
- Los pagos de demostración quedan como aprobados con la entidad "Demo …". Úsalos solo en la base de pruebas.

## 3a-bis. Validar Culqi en modo prueba (developer)

1. Crea tu cuenta gratis en https://integ-panel.culqi.com y copia `pk_test_…` y `sk_test_…`.
2. En Render → servicio `achirana` → **Environment**, agrega `CULQI_PUBLIC_KEY`, `CULQI_SECRET_KEY` y pon `PAGOS_DEMO=false`.
3. Entra como admin → **Panel → Integraciones**. La tarjeta *Culqi* revisa las llaves (prefijo, mismo entorno) y hace una consulta de solo lectura a Culqi. Si todo está bien muestra **Prueba OK**.
4. Paga como regante con la tarjeta `4111 1111 1111 1111`, fecha futura, CVV `123`, o con Yape de prueba. No se cobra dinero real.

Lo que el servidor ya maneja: tarjeta rechazada (muestra el mensaje del banco), 3D Secure (no cobra y sugiere otro medio), Yape (`ype_…`) y doble cobro (bloqueado). Se probó con un simulador de la API de Culqi.

## 3a-ter. Avisos por correo de cada pago

Cada pago dispara un correo. Lo envía el microservicio `servicio-correo/`, que corre como **segundo servicio en Render** y usa **Brevo** (300 correos/día gratis).

| Evento | Junta | Regante* |
|---|---|---|
| Constancia de Yape/Plin/banco enviada | Pago por validar | Constancia recibida |
| Pago aprobado (validación, Culqi, demo o caja) | Pago aprobado | Pago aprobado + n.° de comprobante |
| Pago rechazado | — | Motivo del rechazo |

\* Solo si el regante escribe su correo (campo opcional al pagar).

**Activarlo (una vez):**
1. Crea una cuenta en https://www.brevo.com → **Senders, Domains & Dedicated IPs → Senders** → agrega y verifica el correo que enviará (ej. `pagos.laachirana@gmail.com`).
2. **SMTP & API → API Keys** → genera una llave (`xkeysib-…`).
3. Sube el código y sincroniza el Blueprint: Render crea `achirana-correo` y te pide `BREVO_API_KEY` y `CORREO_REMITENTE` (el correo verificado).
4. Copia la URL de `achirana-correo` (ej. `https://achirana-correo.onrender.com`) y pégala en el servicio `achirana` como `CORREO_SERVICIO_URL`. En `NOTIFICAR_PAGOS_A` pon el correo de la Junta.
5. **Panel → Integraciones → Enviar prueba.** Si llega, ya está.

`CORREO_CLAVE` se genera y se copia sola entre los dos servicios. Si un correo falla, el pago no se afecta: el aviso se reintenta una vez.

## 3b. Rol Gerente y Tablero gerencial

**Cuenta del gerente:**
- Al iniciar, el servidor crea sola una cuenta de gerente si no existe ninguna: correo `gerente@laachirana.pe`, contraseña `Gerente2026#` (solo en desarrollo; en producción y en Render la clave sale de `GERENTE_INICIAL_PASS`).
- Entra por el acceso del **Personal**, igual que los administradores. Llega directo a su tablero.
- Cambia la contraseña en **Panel → Personal**, o define `GERENTE_INICIAL_EMAIL` y `GERENTE_INICIAL_PASS` en el `.env` antes del primer arranque.
- En producción (`NODE_ENV=production`) solo se crea si defines esas variables.
- Puedes crear más gerentes en **Panel → Personal → Nuevo miembro** con el rol **Gerente**.

**Qué puede hacer el gerente:**
- Ver todo: regantes, turnos, pagos, la bitácora y el tablero gerencial.
- Registrar ingresos y egresos de la Junta.
- No puede aprobar pagos ni modificar regantes, tarifas o personal.

**Pestañas de *Gerencia → Tablero gerencial*:**
1. **Equipo y regantes**
   - Semáforo de alineamiento con 8 indicadores: canal registrado hoy, turnos, pagos por validar, códigos de acceso, morosidad, actividad del personal, cuentas de cobro y seguridad.
   - Resumen de parceleros frente a fundos agrícolas: hectáreas, cupo, consumo, deuda y morosos.
   - Actividad de cada administrador y operador.
   - Principales deudores.
2. **Costos e ingresos**
   - Ingresos (canon + otros), egresos y resultado mensual.
   - Costo por m³, margen y eficiencia: agua captada frente a entregada frente a cobrada.
   - Gráficos por categoría y por medio de pago.
   - Registro de egresos (mantenimiento, personal, energía, limpieza de canal…) e ingresos extra.
3. **Capacidad y cupos**
   - Cuánto puede conducir el canal por hora, día, mes y año.
   - Cuánto se puede almacenar (reservorios de fundos + Junta) y cuántos días de autonomía da.
   - Hectáreas atendibles.
   - **Simulador:** mueve el caudal (estiaje, normal, avenida) y ve cuánto le tocaría a cada regante.

> **Importante:** la capacidad del canal viene en **3000 L/s como valor referencial**. Reemplázala por el caudal de diseño real en **Panel → Cupos y riego → Capacidad del canal**.

## 3c. Cupos y límites por hectárea

Los parámetros se editan en **Panel → Cupos y riego**.

- **Cupo base diario** = hectáreas × dotación (m³/ha·día) × factor del cultivo.
  - La dotación por defecto es 70 m³/ha·día, que equivale a 7 mm.
- **Adicional** (lo que el regante puede comprar o almacenar de más) = cupo base × %.
  - El porcentaje es distinto para parceleros y para fundos (10 % por defecto).
  - **Ejemplo:** 5 ha con 100 m³/ha·día dan 500 m³ de cupo. Con 10 % el adicional es **50 m³**; para que sean 100 m³ pon **20 %**.
- **Límite por regante:** nadie puede llevarse más de un % del canal en el día.
  - Por defecto, 15 % para un parcelero y 30 % para un fundo.
- **Orden de atención del adicional:** primero parceleros, primero fundos o por igual.

**Cómo se reparte:**
1. Primero todos reciben su cupo base, respetando el límite.
2. Si sobra agua, se completa el cupo base de quien quedó limitado.
3. Luego se entrega el adicional en el orden elegido.
4. El agua que sobra después de eso queda como *sin asignar* (disponible para la Junta).

Los turnos adicionales aparecen como *Adicional*, o como *Almacenamiento* si el fundo tiene reservorio.

## 4. Lluvias en la sierra

- **Pronóstico:** Open-Meteo, gratis y sin API key, para Laguna Choclococha, Tambo (Huaytará) y Santiago de Chocorvos.
- **Caudal modelado del río Ica:** GloFAS (Copernicus), también vía Open-Meteo.
- **Alerta para regantes y personal:** una franja visible en todas las pantallas, más un aviso al ingresar.
- **Simulación de llegada:** el rango entre el tiempo de concentración de Kirpich y la distancia dividida entre la velocidad de avenida (1.5–3.5 m/s). Se aplica desde la hora central de la lluvia del día.
- **Mapa · Cuenca:** puntos de monitoreo sobre mapa o **satélite** (Esri).
- **Mapa · Satélite NASA:** lluvia medida por satélite cada 30 min (GPM IMERG, capa `IMERG_Precipitation_Rate_30min`, llega con ~7 h de retraso) animada en las últimas 24 h, más la foto de nubes del día anterior (MODIS Terra, Aqua o VIIRS).
- **Mapa · Windy:** pronóstico animado de lluvia (modelo ECMWF). Se carga solo al abrir la pestaña.
- **Mapa · Lluvia en movimiento:** malla de 72 puntos sobre la cuenca con lluvia **hora por hora** (Open-Meteo, ayer + 2 días). Botón ▶ para animarla, barra de tiempo, velocidad 1×/2×/4×, pico en mm/h y gráfico sierra vs. valle. Ruta: `GET /api/clima/lluvia`.
- **Datos editables:** distancias, altitudes y puntos se cambian en **Panel → Puntos de monitoreo**. Umbrales y velocidades se cambian en `.env`.
- **Modo presentación:** `CLIMA_SIMULACION=true` muestra una tormenta simulada, marcada como tal en la interfaz.

> Las distancias por cauce de los puntos iniciales son **aproximadas**. Ajústalas con datos de la ALA Ica / ANA si los tienes.

## 4b. Turnos de riego (reparto del canal)

1. El personal registra el **caudal del canal en L/s** (vista *Turnos de riego*). El sistema lo convierte solo a m³/hora y m³/día. Puede registrarse varias veces al día.
2. **Demanda diaria de cada regante** = hectáreas × lámina general (mm/día) × 10 × factor del cultivo. Recuerda que 1 mm sobre 1 ha equivale a 10 m³.
   - La lámina y los factores se editan en **Panel → Cupos y riego**. Todos los factores empiezan en 1.00.
   - La lámina inicial es 7 mm/día, el valor que traía tu `data.json` anterior.
3. **Reparto en 24 horas.** Cada turno recibe todo el caudal del canal durante el tiempo que le corresponde. El orden rota cada día para que nadie riegue siempre de noche.
   - **Si el agua no alcanza:** se reparte en proporción a la demanda. Todos reciben el mismo % de lo que necesitan.
   - **Si sobra:** va a los fundos marcados como *Almacena agua en reservorio*, hasta ha × lámina × 10 × 7 días, sin pasar la capacidad del reservorio. Se descuenta lo que ya almacenaron en esa semana.
4. **Si cambia el caudal**, los turnos pendientes se recalculan desde ese momento:
   - El turno en curso se corta y se cobra lo entregado.
   - Si mañana ya estaba programado, también se actualiza.
5. **Cobro automático.** Al terminar cada turno, su volumen (L/s × horas) se registra como consumo del regante y entra a su deuda.
6. **Ajustes manuales.** El personal puede **cancelar** un turno (no se cobra) o **terminarlo antes** (se cobra solo lo entregado).

Para la vista del regante:
- En *Mi agua* aparece su próximo turno.
- En *Turnos de riego* ve solo los suyos.

## 5. Tablas nuevas y por qué

| Tabla | Para qué |
|---|---|
| `tarifas` | Un solo precio por m³, con historial de cambios. Antes había S/ 12.50/ha en pantalla y S/ 0.12/m³ en el backend. |
| `puntos_monitoreo` | Puntos de la sierra, la bocatoma y el valle, editables sin tocar código. |
| `alertas_climaticas` | Historial del pronóstico y de las alertas por punto y día. |
| `auditoria` | Bitácora de quién hizo qué: ingresos, intentos fallidos, cambios, pagos. |
| `caudal_canal` | Cada registro del caudal del canal (L/s) con hora, nota y quién lo registró. |
| `turnos_riego` | El horario: quién recibe agua, de qué hora a qué hora, volumen y estado. |
| `parametros_riego` | Lámina general y días de almacenamiento. |
| `factores_cultivo` | Factor de demanda de cada cultivo. |
| `movimientos` | Ingresos y egresos de la Junta para el tablero gerencial. |
| `cuentas_cobro` | Cuentas Yape, Plin y bancarias donde pagan los regantes (con QR). |
| `vouchers` | Imagen de la constancia de cada pago reportado. |
| `migraciones_aplicadas` | Control interno de migraciones. |

**Columnas nuevas:**
- `pagos`: estado, método, entidad, N.° de operación, fecha, monto declarado, quién validó y motivo de rechazo.
- `parametros_riego`: adicional %, límite % y orden de atención (por tipo), capacidad del canal y reservorio de la Junta.
- `historial_caudal.pago_id`: marca qué lecturas ya se pagaron.
- `clientes.pin_hash`: código de acceso de 6 dígitos.
- `usuarios`: bloqueo por intentos fallidos y último acceso.
- `historial_pagos`: ahora registra cada cambio de estado de un pago.
- `clientes.almacena` y `capacidad_reservorio_m3`: indican qué fundos almacenan y cuánto les cabe.
- `historial_caudal`: nuevas columnas `volumen_m3` (lo que se cobra), `horas` y `turno_id`.

## 5b. Ingreso con DNI, RUC o correo

- Tres pestañas: **DNI** (parcelero), **RUC** (fundo) y **Correo** (personal de la Junta).
- DNI y RUC solo aceptan números: las letras y espacios no se escriben, ni siquiera al pegar. Un contador muestra `5/8` o `9/11` y aparece ✓ al completar.
- El RUC se valida con su dígito verificador.
- El correo dice qué le falta: el @, el dominio, la extensión (.com, .pe) o que tiene espacios. El servidor repite todas las validaciones.

## 6. Seguridad aplicada

- **Autenticación:** JWT firmado (HS256) y roles admin / gerente / operador / cliente. Antes todas las rutas `/api/admin/*` estaban abiertas.
- **Aislamiento:** un cliente solo puede ver sus propios datos.
- **Contraseñas:** cifradas con scrypt, con política de complejidad y bloqueo de 15 minutos tras 5 intentos fallidos.
- **Validación en servidor:** DNI, RUC con dígito verificador, rangos, caracteres permitidos y tipos. La misma validación existe en el navegador, campo por campo.
- **Cabeceras:** CSP estricta (sin scripts inline), anti-XSS en todo lo que se pinta y protección contra clickjacking.
- **Límite de peticiones:** general, por login y por pagos.
- **Credenciales:** viven en `.env`. Ya no hay claves escritas en el código.
- **Errores:** los de SQL ya no se muestran al usuario.
- **Pendiente:** `CLIENTE_PIN_OBLIGATORIO=false` por defecto. Asigna códigos a tus regantes desde el Panel y luego cámbialo a `true`.

## 7. Antes de producción

- Reemplaza el RUC de la Junta en `frontend/js/comprobante.js` (`EMISOR.ruc`).
- La boleta o factura es una representación interna. Para validez ante SUNAT necesitas un OSE / PSE de facturación electrónica.
- Usa HTTPS y `NODE_ENV=production`.

## Subir a GitHub y desplegar en Render

**1. Subir a GitHub** (el `.gitignore` ya deja fuera `.env` y `node_modules`; nunca subas tu `.env`):
```bash
git init
git add .
git commit -m "La Achirana v3.2"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/achirana.git
git push -u origin main
```

**2. Desplegar en Render:**
1. En Render, elige **New → Blueprint** y selecciona el repositorio. Render lee `render.yaml` y crea dos cosas: la base de datos `achirana-db` y el servicio web `achirana`.
2. Render te pide tres valores:
   - `ADMIN_INICIAL_EMAIL` y `ADMIN_INICIAL_PASS`: el primer administrador.
   - `GERENTE_INICIAL_PASS`: la clave del gerente (`gerente@laachirana.pe`).
3. Espera a que termine. La web queda en `https://achirana.onrender.com` (o el nombre que Render asigne). Las tablas se crean solas al primer arranque.
4. Revisa que todo responde en `https://…onrender.com/api/salud`. Debe mostrar `{"ok":true,"version":"3.2.0"}`.

Si prefieres crear todo a mano (sin Blueprint):
1. Crea una base **PostgreSQL**.
2. Crea un **Web Service** con build `npm install` y start `npm start`.
3. Agrega estas variables:
   - `DATABASE_URL`: la *Internal Database URL* de tu base.
   - `NODE_ENV=production`
   - `JWT_SECRET`: genéralo con `npm run secret`.
   - `ADMIN_INICIAL_EMAIL`, `ADMIN_INICIAL_PASS` y `GERENTE_INICIAL_PASS`.

**Antes de presentar, ten en cuenta:**
- **La base de datos en Render empieza vacía.** Para llevar tus datos locales:
  ```bash
  pg_dump -Fc -d Achirana -f achirana.dump
  pg_restore --no-owner -d "URL_EXTERNA_DE_RENDER" achirana.dump
  ```
  Usa la *External Database URL* que aparece en la base de Render.
- **El plan gratuito de Render tiene límites:**
  - El servicio web se duerme tras 15 minutos sin visitas; la primera carga después tarda unos segundos.
  - La base de datos gratuita vence a los 30 días.
- **Datos de demostración:** con `SEMBRAR_DEMO=true`, al arrancar con la base vacía se cargan datos **ficticios**: 30 parceleros (DNI 99xxxxxx), 10 fundos (RUC 20999xxxxxx), 60 días de lecturas, pagos, lecturas del canal y 6 meses de movimientos. Sirven para presentar el sistema; no corresponden a personas ni empresas reales. Con datos reales de la Junta, pon `SEMBRAR_DEMO=false`.
- **Modo demostración:** `PAGOS_DEMO=true` deja activos los cobros simulados con tarjeta y Yape. Para cobrar de verdad, agrega las llaves de Culqi (`CULQI_PUBLIC_KEY`, `CULQI_SECRET_KEY`) y pon `PAGOS_DEMO=false`.
- **HTTPS:** Render lo da automáticamente. El sistema detecta la dirección pública con `RENDER_EXTERNAL_URL`.

