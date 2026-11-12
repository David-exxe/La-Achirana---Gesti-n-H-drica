// =====================================================================
//  Esquema y migraciones idempotentes.
//  - Respeta tus tablas actuales (usuarios, clientes, historial_caudal,
//    pagos, historial_pagos) y les AGREGA columnas, nunca borra datos.
//  - Cada migración se registra en "migraciones_aplicadas" para correr una sola vez.
// =====================================================================
const { pool } = require('../Config/db');
const config = require('../Config/env');
const { hashClave, esHash } = require('../utils/seguridad');

const esquemaBase = `
CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
    nombre      VARCHAR(100) PRIMARY KEY,
    aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios (
    id     SERIAL PRIMARY KEY,
    email  VARCHAR(100) UNIQUE NOT NULL,
    pass   VARCHAR(255) NOT NULL,
    nombre VARCHAR(100) NOT NULL,
    rol    VARCHAR(20)  NOT NULL
);

CREATE TABLE IF NOT EXISTS clientes (
    id               SERIAL PRIMARY KEY,
    tipo             VARCHAR(20)  NOT NULL,
    documento        VARCHAR(20)  UNIQUE NOT NULL,
    nombre           VARCHAR(100) NOT NULL,
    hectareas        NUMERIC(10,2) NOT NULL CHECK (hectareas > 0),
    ubicacion_sector VARCHAR(150),
    cultivo          VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS historial_caudal (
    id         SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
    fecha      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    lps        NUMERIC(10,2) NOT NULL,
    m3_hora    NUMERIC(10,2) NOT NULL,
    m3_dia     NUMERIC(10,2) NOT NULL,
    estado     VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS pagos (
    id         SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
    fecha      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tipo       VARCHAR(20) NOT NULL,
    numero     VARCHAR(50),
    concepto   VARCHAR(200) NOT NULL,
    monto      NUMERIC(10,2) NOT NULL CHECK (monto >= 0)
);

CREATE TABLE IF NOT EXISTS historial_pagos (
    id         SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
    fecha      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    monto      NUMERIC(10,2),
    estado     VARCHAR(30)
);

-- ---------- TABLAS NUEVAS ----------

-- Tarifa vigente por m³ (una sola fuente de verdad para el cobro)
CREATE TABLE IF NOT EXISTS tarifas (
    id            SERIAL PRIMARY KEY,
    precio_m3     NUMERIC(10,4) NOT NULL CHECK (precio_m3 > 0 AND precio_m3 < 1000),
    vigente_desde TIMESTAMPTZ NOT NULL DEFAULT now(),
    motivo        VARCHAR(200),
    creado_por    INT REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Puntos de la cuenca alta (sierra) y del valle que se monitorean
CREATE TABLE IF NOT EXISTS puntos_monitoreo (
    id               SERIAL PRIMARY KEY,
    nombre           VARCHAR(100) NOT NULL,
    tipo             VARCHAR(20)  NOT NULL CHECK (tipo IN ('sierra','bocatoma','valle')),
    latitud          NUMERIC(9,5) NOT NULL CHECK (latitud BETWEEN -18.5 AND 0),
    longitud         NUMERIC(9,5) NOT NULL CHECK (longitud BETWEEN -81.5 AND -68.5),
    altitud_m        INT NOT NULL CHECK (altitud_m BETWEEN 0 AND 6800),
    distancia_rio_km NUMERIC(7,2) NOT NULL DEFAULT 0 CHECK (distancia_rio_km >= 0),
    regulado         BOOLEAN NOT NULL DEFAULT false,
    activo           BOOLEAN NOT NULL DEFAULT true,
    notas            VARCHAR(250)
);

-- Pronóstico/alerta por punto y día (se actualiza en cada consulta al servicio de clima)
CREATE TABLE IF NOT EXISTS alertas_climaticas (
    id              SERIAL PRIMARY KEY,
    punto_id        INT NOT NULL REFERENCES puntos_monitoreo(id) ON DELETE CASCADE,
    fecha           DATE NOT NULL,
    precip_mm       NUMERIC(7,2) NOT NULL,
    probabilidad    INT,
    nivel           VARCHAR(10) NOT NULL CHECK (nivel IN ('verde','amarillo','naranja','rojo')),
    llegada_desde   TIMESTAMPTZ,
    llegada_hasta   TIMESTAMPTZ,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (punto_id, fecha)
);

-- Bitácora de acciones sensibles (quién hizo qué y desde dónde)
CREATE TABLE IF NOT EXISTS auditoria (
    id          BIGSERIAL PRIMARY KEY,
    actor_tipo  VARCHAR(10) NOT NULL,
    actor_id    INT,
    accion      VARCHAR(50) NOT NULL,
    entidad     VARCHAR(30),
    entidad_id  INT,
    detalle     JSONB,
    ip          VARCHAR(64),
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS seq_boleta  START 1;
CREATE SEQUENCE IF NOT EXISTS seq_factura START 1;
`;

// Migraciones que modifican tablas existentes (se ejecutan una sola vez)
const migraciones = [
    {
        nombre: '2026_10_usuarios_seguridad',
        sql: `
            ALTER TABLE usuarios ALTER COLUMN pass TYPE VARCHAR(255);
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos INT NOT NULL DEFAULT 0;
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ;
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_acceso TIMESTAMPTZ;
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT now();
        `,
    },
    {
        nombre: '2026_10_clientes_pin',
        sql: `
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS intentos_fallidos INT NOT NULL DEFAULT 0;
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ;
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT now();
        `,
    },
    {
        nombre: '2026_10_pagos_mercadopago',
        sql: `
            ALTER TABLE pagos ALTER COLUMN numero DROP NOT NULL;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'aprobado';
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS metodo VARCHAR(30) NOT NULL DEFAULT 'legado';
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS volumen_m3 NUMERIC(14,2);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS tarifa_m3 NUMERIC(10,4);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS lectura_hasta_id INT;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mp_preference_id VARCHAR(80);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mp_payment_id VARCHAR(40);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mp_status_detail VARCHAR(80);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS checkout_url TEXT;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS pagado_en TIMESTAMPTZ;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now();
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS registrado_por INT REFERENCES usuarios(id) ON DELETE SET NULL;
            ALTER TABLE pagos ALTER COLUMN estado SET DEFAULT 'pendiente';
            ALTER TABLE pagos ALTER COLUMN metodo SET DEFAULT 'mercadopago';
            CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_mp_payment ON pagos (mp_payment_id) WHERE mp_payment_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_numero ON pagos (numero) WHERE numero IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ix_pagos_cliente ON pagos (cliente_id, estado);
        `,
    },
    {
        nombre: '2026_10_caudal_pagado',
        sql: `
            ALTER TABLE historial_caudal ADD COLUMN IF NOT EXISTS pago_id INT REFERENCES pagos(id) ON DELETE SET NULL;
            ALTER TABLE historial_caudal ADD COLUMN IF NOT EXISTS registrado_por INT REFERENCES usuarios(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS ix_caudal_cliente ON historial_caudal (cliente_id, fecha);
            -- Los pagos antiguos cobraban TODO el volumen acumulado a la fecha del pago.
            -- Marcamos esas lecturas como ya pagadas para no volver a cobrarlas.
            UPDATE historial_caudal h
               SET pago_id = sub.pago_id
              FROM (
                    SELECT h2.id AS caudal_id,
                           (SELECT p.id FROM pagos p
                             WHERE p.cliente_id = h2.cliente_id AND p.fecha >= h2.fecha
                             ORDER BY p.fecha ASC LIMIT 1) AS pago_id
                      FROM historial_caudal h2
                     WHERE h2.pago_id IS NULL
                   ) sub
             WHERE h.id = sub.caudal_id AND sub.pago_id IS NOT NULL;
        `,
    },
    {
        nombre: '2026_10_historial_pagos_eventos',
        sql: `
            ALTER TABLE historial_pagos ADD COLUMN IF NOT EXISTS pago_id INT REFERENCES pagos(id) ON DELETE CASCADE;
            ALTER TABLE historial_pagos ADD COLUMN IF NOT EXISTS detalle VARCHAR(200);
            ALTER TABLE historial_pagos ALTER COLUMN estado TYPE VARCHAR(30);
        `,
    },
    {
        // Reparto del agua del canal en turnos de riego
        nombre: '2026_10_turnos_riego',
        sql: `
            -- Caudal total del canal que registra el personal (puede cambiar varias veces al día)
            CREATE TABLE IF NOT EXISTS caudal_canal (
                id             SERIAL PRIMARY KEY,
                fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
                lps            NUMERIC(10,2) NOT NULL CHECK (lps >= 0 AND lps <= 20000),
                m3_hora        NUMERIC(12,2) NOT NULL,
                m3_dia         NUMERIC(14,2) NOT NULL,
                nota           VARCHAR(200),
                registrado_por INT REFERENCES usuarios(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS ix_caudal_canal_fecha ON caudal_canal (fecha DESC);

            -- Turnos de entrega de agua a cada regante
            CREATE TABLE IF NOT EXISTS turnos_riego (
                id               SERIAL PRIMARY KEY,
                fecha            DATE NOT NULL,
                cliente_id       INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                tipo             VARCHAR(15) NOT NULL CHECK (tipo IN ('riego','almacenamiento')),
                orden            INT NOT NULL,
                inicio           TIMESTAMPTZ NOT NULL,
                fin              TIMESTAMPTZ NOT NULL,
                lps              NUMERIC(10,2) NOT NULL,
                volumen_m3       NUMERIC(14,2) NOT NULL CHECK (volumen_m3 >= 0),
                estado           VARCHAR(12) NOT NULL DEFAULT 'programado' CHECK (estado IN ('programado','cumplido','cancelado')),
                caudal_canal_id  INT REFERENCES caudal_canal(id) ON DELETE SET NULL,
                creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
                CHECK (fin > inicio)
            );
            CREATE INDEX IF NOT EXISTS ix_turnos_fecha ON turnos_riego (fecha, inicio);
            CREATE INDEX IF NOT EXISTS ix_turnos_cliente ON turnos_riego (cliente_id, fecha);

            -- Parámetros del reparto (una sola fila)
            CREATE TABLE IF NOT EXISTS parametros_riego (
                id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                lamina_mm_dia       NUMERIC(5,2) NOT NULL DEFAULT 7 CHECK (lamina_mm_dia > 0 AND lamina_mm_dia <= 30),
                dias_almacenamiento INT NOT NULL DEFAULT 7 CHECK (dias_almacenamiento BETWEEN 1 AND 30),
                turno_minimo_min    INT NOT NULL DEFAULT 5 CHECK (turno_minimo_min BETWEEN 1 AND 120),
                actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
                actualizado_por     INT REFERENCES usuarios(id) ON DELETE SET NULL
            );
            INSERT INTO parametros_riego (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

            -- Factor de demanda por cultivo (multiplica la lámina general). 1.00 = igual a la lámina.
            CREATE TABLE IF NOT EXISTS factores_cultivo (
                cultivo  VARCHAR(100) PRIMARY KEY,
                factor   NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (factor >= 0.1 AND factor <= 3)
            );

            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS almacena BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE clientes ADD COLUMN IF NOT EXISTS capacidad_reservorio_m3 NUMERIC(14,2) CHECK (capacidad_reservorio_m3 IS NULL OR capacidad_reservorio_m3 > 0);

            -- Volumen realmente entregado (lo que se cobra). Antes se usaba m3_dia.
            ALTER TABLE historial_caudal ADD COLUMN IF NOT EXISTS volumen_m3 NUMERIC(14,2);
            ALTER TABLE historial_caudal ADD COLUMN IF NOT EXISTS horas NUMERIC(6,2);
            ALTER TABLE historial_caudal ADD COLUMN IF NOT EXISTS turno_id INT REFERENCES turnos_riego(id) ON DELETE SET NULL;
            UPDATE historial_caudal SET volumen_m3 = m3_dia WHERE volumen_m3 IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS ux_caudal_turno ON historial_caudal (turno_id) WHERE turno_id IS NOT NULL;
        `,
    },
    {
        // Cupos por hectárea, adicional, tope de participación y capacidad del sistema
        nombre: '2026_11_cupos_y_capacidad',
        sql: `
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS adicional_pct_parcelero NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (adicional_pct_parcelero BETWEEN 0 AND 100);
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS adicional_pct_fundo     NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (adicional_pct_fundo BETWEEN 0 AND 100);
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS tope_pct_parcelero      NUMERIC(5,2) NOT NULL DEFAULT 15 CHECK (tope_pct_parcelero BETWEEN 1 AND 100);
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS tope_pct_fundo          NUMERIC(5,2) NOT NULL DEFAULT 30 CHECK (tope_pct_fundo BETWEEN 1 AND 100);
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS prioridad_adicional     VARCHAR(10)  NOT NULL DEFAULT 'parcelero' CHECK (prioridad_adicional IN ('parcelero','fundo','igual'));
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS canal_capacidad_lps     NUMERIC(10,2) NOT NULL DEFAULT 3000 CHECK (canal_capacidad_lps > 0 AND canal_capacidad_lps <= 50000);
            ALTER TABLE parametros_riego ADD COLUMN IF NOT EXISTS reservorio_junta_m3     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reservorio_junta_m3 >= 0);

            ALTER TABLE turnos_riego DROP CONSTRAINT IF EXISTS turnos_riego_tipo_check;
            ALTER TABLE turnos_riego ADD CONSTRAINT turnos_riego_tipo_check CHECK (tipo IN ('riego','almacenamiento','adicional'));
        `,
    },
    {
        // Finanzas: egresos y otros ingresos que registra la Junta
        nombre: '2026_11_movimientos_financieros',
        sql: `
            CREATE TABLE IF NOT EXISTS movimientos (
                id             SERIAL PRIMARY KEY,
                fecha          DATE NOT NULL,
                tipo           VARCHAR(8)  NOT NULL CHECK (tipo IN ('ingreso','egreso')),
                categoria      VARCHAR(40) NOT NULL,
                descripcion    VARCHAR(200) NOT NULL,
                monto          NUMERIC(12,2) NOT NULL CHECK (monto > 0 AND monto < 100000000),
                documento      VARCHAR(40),
                registrado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
                creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS ix_movimientos_fecha ON movimientos (fecha);
        `,
    },
    {
        // Pagos con Yape, Plin y bancos peruanos (reemplaza a Mercado Pago)
        nombre: '2026_11_pagos_yape_bancos',
        sql: `
            CREATE TABLE IF NOT EXISTS cuentas_cobro (
                id          SERIAL PRIMARY KEY,
                metodo      VARCHAR(15) NOT NULL CHECK (metodo IN ('yape','plin','transferencia')),
                entidad     VARCHAR(30) NOT NULL,
                titular     VARCHAR(100) NOT NULL,
                numero      VARCHAR(30) NOT NULL,
                cci         VARCHAR(20),
                qr_mime     VARCHAR(20),
                qr_datos    BYTEA,
                instrucciones VARCHAR(200),
                activo      BOOLEAN NOT NULL DEFAULT true,
                orden       INT NOT NULL DEFAULT 0,
                creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS cuenta_id       INT REFERENCES cuentas_cobro(id) ON DELETE SET NULL;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS entidad         VARCHAR(30);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS operacion       VARCHAR(40);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS fecha_operacion TIMESTAMPTZ;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS monto_declarado NUMERIC(10,2);
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS validado_por    INT REFERENCES usuarios(id) ON DELETE SET NULL;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS validado_en     TIMESTAMPTZ;
            ALTER TABLE pagos ADD COLUMN IF NOT EXISTS motivo_rechazo  VARCHAR(200);
            ALTER TABLE pagos ALTER COLUMN metodo SET DEFAULT 'efectivo';
            -- Un mismo número de operación no puede usarse en dos pagos vigentes
            CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_operacion ON pagos (entidad, operacion)
                WHERE operacion IS NOT NULL AND estado NOT IN ('rechazado','anulado');

            CREATE TABLE IF NOT EXISTS vouchers (
                pago_id   INT PRIMARY KEY REFERENCES pagos(id) ON DELETE CASCADE,
                mime      VARCHAR(20) NOT NULL,
                datos     BYTEA NOT NULL,
                tamano    INT NOT NULL,
                subido_en TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `,
    },
    {
        nombre: '2026_10_secuencias_desde_existentes',
        sql: `
            SELECT setval('seq_boleta',  GREATEST(1, COALESCE((SELECT MAX(NULLIF(regexp_replace(numero, '^B001-0*', ''), '')::INT) FROM pagos WHERE numero ~ '^B001-\\d+$'), 0) + 1), false);
            SELECT setval('seq_factura', GREATEST(1, COALESCE((SELECT MAX(NULLIF(regexp_replace(numero, '^F001-0*', ''), '')::INT) FROM pagos WHERE numero ~ '^F001-\\d+$'), 0) + 1), false);
        `,
    },
];

// Puntos por defecto: cuenca alta del río Ica (Huancavelica) y bocatoma La Achirana.
// Coordenadas de los centros poblados; distancias por el cauce APROXIMADAS (editables en el Panel).
const PUNTOS_INICIALES = [
    ['Laguna Choclococha', 'sierra', -13.16038, -75.07250, 4550, 150, true, 'Sistema Choclococha: agua regulada que se trasvasa a la cuenca del Ica.'],
    ['Tambo (Huaytará)', 'sierra', -13.82722, -75.07611, 3559, 90, false, 'Río Tambo, uno de los formadores del río Ica.'],
    ['Santiago de Chocorvos', 'sierra', -13.82533, -75.25773, 2828, 65, false, 'Río Santiago, el otro formador del río Ica.'],
    ['Bocatoma La Achirana', 'bocatoma', -13.93244, -75.67015, 528, 0, false, 'San José de Los Molinos. Referencia de llegada del agua.'],
    ['Ica (ciudad)', 'valle', -14.06777, -75.72861, 406, 20, false, 'Valle de Ica. La distancia es aguas ABAJO de la bocatoma.'],
];

async function aplicarMigraciones() {
    await pool.query(esquemaBase);

    const { rows } = await pool.query('SELECT nombre FROM migraciones_aplicadas');
    const hechas = new Set(rows.map(r => r.nombre));

    for (const m of migraciones) {
        if (hechas.has(m.nombre)) continue;
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await c.query(m.sql);
            await c.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [m.nombre]);
            await c.query('COMMIT');
            console.log(`   ✔ Migración aplicada: ${m.nombre}`);
        } catch (err) {
            await c.query('ROLLBACK');
            throw new Error(`Falló la migración ${m.nombre}: ${err.message}`);
        } finally {
            c.release();
        }
    }

    // Índice único de email sin distinguir mayúsculas (si hay duplicados, avisamos)
    try {
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_email_lower ON usuarios (LOWER(email))');
    } catch {
        console.warn('⚠️  Hay correos de administradores repetidos (mayúsc./minúsc.). Corrígelos para activar el índice único.');
    }

    await migrarClavesPlanas();
    await crearAdminInicial();
    await crearGerenteInicial();
    await sembrarDatosBase();
    if (String(process.env.SEMBRAR_DEMO).toLowerCase() === 'true') {
        const r = await require('./demo').sembrarDemo();
        if (!r.omitido) console.log(`   🌱 Datos de demostración: ${r.clientes} regantes, ${r.lecturas} lecturas, ${r.pagos} pagos, ${r.movimientos} movimientos.`);
    }
}

/** Convierte contraseñas guardadas en texto plano a hash scrypt. */
async function migrarClavesPlanas() {
    const { rows } = await pool.query('SELECT id, pass FROM usuarios');
    let n = 0;
    for (const u of rows) {
        if (!esHash(u.pass)) {
            await pool.query('UPDATE usuarios SET pass = $1 WHERE id = $2', [await hashClave(u.pass), u.id]);
            n++;
        }
    }
    if (n) console.log(`   🔐 ${n} contraseña(s) en texto plano fueron cifradas con scrypt.`);
}

async function crearAdminInicial() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
    if (rows[0].n > 0) return;
    const { email, pass, nombre } = config.adminInicial;
    if (!email || !pass) {
        console.warn('⚠️  No hay administradores. Define ADMIN_INICIAL_EMAIL y ADMIN_INICIAL_PASS en .env y reinicia.');
        return;
    }
    await pool.query(
        "INSERT INTO usuarios (email, pass, nombre, rol) VALUES ($1, $2, $3, 'admin')",
        [email.toLowerCase(), await hashClave(pass), nombre]
    );
    console.log(`   👤 Administrador inicial creado: ${email}. Borra ADMIN_INICIAL_PASS del .env.`);
}

async function crearGerenteInicial() {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM usuarios WHERE rol = 'gerente'");
    if (rows[0].n > 0) return;
    const { email, pass, nombre } = config.gerenteInicial;
    if (!email || !pass) return;
    const existe = await pool.query('SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
    if (existe.rowCount) return;
    await pool.query(
        "INSERT INTO usuarios (email, pass, nombre, rol) VALUES ($1, $2, $3, 'gerente')",
        [email.toLowerCase(), await hashClave(pass), nombre]
    );
    console.log(`   👔 Cuenta de gerente creada: ${email}. Cambia su contraseña en Panel → Personal.`);
}

async function sembrarDatosBase() {
    const t = await pool.query('SELECT COUNT(*)::int AS n FROM tarifas');
    if (t.rows[0].n === 0) {
        await pool.query('INSERT INTO tarifas (precio_m3, motivo) VALUES ($1, $2)', [config.tarifaInicial, 'Tarifa inicial']);
    }
    const p = await pool.query('SELECT COUNT(*)::int AS n FROM puntos_monitoreo');
    if (p.rows[0].n === 0) {
        for (const fila of PUNTOS_INICIALES) {
            await pool.query(
                `INSERT INTO puntos_monitoreo (nombre, tipo, latitud, longitud, altitud_m, distancia_rio_km, regulado, notas)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, fila
            );
        }
    }
}

module.exports = { aplicarMigraciones };
