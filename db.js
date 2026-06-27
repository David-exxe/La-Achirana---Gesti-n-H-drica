const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. CONFIGURACIÓN DE CONEXIÓN A POSTGRESQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'la_achirana', 
    password: 'TU_CONTRASEÑA_AQUÍ', // 👈 COLOCA AQUÍ TU CLAVE REAL DE PGADMIN
    port: 5432,
});

// 2. AUTOMATIZACIÓN SEGURA Y PERSISTENTE
const inicializarBaseDeDatos = async () => {
    try {
        console.log("⏳ Sincronizando base de datos en Modo Seguro Permanente...");

        // Tabla de Usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                email VARCHAR(100) UNIQUE NOT NULL,
                pass VARCHAR(100) NOT NULL,
                nombre VARCHAR(100) NOT NULL,
                rol VARCHAR(20) NOT NULL
            );
        `);

        // Tabla de Clientes
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                id SERIAL PRIMARY KEY,
                tipo VARCHAR(20) NOT NULL,
                documento VARCHAR(20) UNIQUE NOT NULL,
                nombre VARCHAR(100) NOT NULL,
                hectareas NUMERIC(10,2) NOT NULL CONSTRAINT chk_hectareas_positivas CHECK (hectareas > 0),
                ubicacion_sector VARCHAR(150),
                cultivo VARCHAR(100),
                CONSTRAINT chk_documento_valido CHECK (LENGTH(documento) IN (8, 11))
            );
        `);

        // Tabla de Historial de Caudal
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historial_caudal (
                id SERIAL PRIMARY KEY,
                cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                lps NUMERIC(10,2) NOT NULL,
                m3_hora NUMERIC(10,2) NOT NULL,
                m3_dia NUMERIC(10,2) NOT NULL,
                estado VARCHAR(20) NOT NULL
            );
        `);

        // Tabla de Pagos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pagos (
                id SERIAL PRIMARY KEY,
                cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                tipo VARCHAR(20) NOT NULL,
                numero VARCHAR(50) NOT NULL,
                concepto VARCHAR(200) NOT NULL,
                monto NUMERIC(10,2) NOT NULL CONSTRAINT chk_monto_positivo CHECK (monto >= 0)
            );
        `);

        // Inserciones por defecto
        await pool.query(`
            INSERT INTO usuarios (email, pass, nombre, rol) VALUES 
            ('chemo@utp.edu.pe', 'Chemo1234#', 'Carlos', 'admin'),
            ('Jamilmarcos@gmail.com', 'Jamil9876#', 'Jamil', 'admin')
            ON CONFLICT (email) DO NOTHING;
        `);

        await pool.query(`
            INSERT INTO clientes (tipo, documento, nombre, hectareas, ubicacion_sector, cultivo) VALUES 
            ('empresa', '20123456789', 'Fundo Santa Elena', 150.00, 'Chincha Alta', 'Espárragos'),
            ('empresa', '20567891234', 'Agrícola Don Ricardo', 85.00, 'Nazca Valle', 'Paltas Hass'),
            ('parcelero', '45678901', 'Juan Pérez Huamán', 4.50, 'Sector A Chincha', 'Maíz Chulpi')
            ON CONFLICT (documento) DO NOTHING;
        `);

        console.log("✅ Tablas listas y sincronizadas correctamente.");
    } catch (err) {
        console.error("❌ Error inicializando base de datos:", err.message);
    }
};

// 3. RUTAS DEL API (ENDPOINTS)

app.get('/api/admin/recaudacion-total', async (req, res) => {
    try {
        const result = await pool.query('SELECT SUM(monto) FROM pagos');
        const total = result.rows[0].sum || 0;
        res.json({ totalGlobal: parseFloat(total) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login-admin', async (req, res) => {
    const { email, pass } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = $1 AND pass = $2', [email.toLowerCase(), pass]);
        if (result.rows.length > 0) {
            res.json({ token: 'jwt_dummy_token_seguro', user: result.rows[0] });
        } else { res.status(401).json({ error: 'Credenciales administrativas incorrectas.' }); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login-cliente', async (req, res) => {
    const { documento } = req.body;
    try {
        const result = await pool.query('SELECT * FROM clientes WHERE documento = $1', [documento]);
        if (result.rows.length > 0) {
            res.json({ token: 'jwt_dummy_token_seguro', cliente: result.rows[0], user: result.rows[0] });
        } else { res.status(404).json({ error: 'El documento no figura en el padrón.' }); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clientes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clientes/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/caudal', async (req, res) => {
    const { cliente_id } = req.query;
    try {
        let query = `
            SELECT h.id, h.cliente_id, c.nombre as cliente_nombre, 
            TO_CHAR(h.fecha, 'YYYY-MM-DD HH24:MI') as fecha, h.lps, h.m3_hora, h.m3_dia, h.estado 
            FROM historial_caudal h 
            JOIN clientes c ON h.cliente_id = c.id
        `;
        const params = [];
        if (cliente_id) { query += " WHERE h.cliente_id = $1"; params.push(cliente_id); }
        query += " ORDER BY h.id DESC";
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/caudal', async (req, res) => {
    const { cliente_id, lps } = req.body;
    if (parseFloat(lps) <= 0) return res.status(400).json({ error: "El caudal debe ser un número positivo." });
    
    const m3_hora = parseFloat((lps * 3.6).toFixed(2));
    const m3_dia = parseFloat((m3_hora * 24).toFixed(2));
    const estado = lps >= 14 ? 'Óptimo' : 'Normal';
    try {
        const result = await pool.query(
            'INSERT INTO historial_caudal (cliente_id, lps, m3_hora, m3_dia, estado) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [cliente_id, lps, m3_hora, m3_dia, estado]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🌟 ENDPOINT DE PAGOS TOTALMENTE REFACTORIZADO CON TU NUEVA REGLA DE NEGOCIO
app.post('/api/pagos', async (req, res) => {
    const { cliente_id, tipo } = req.body;
    try {
        // 1. Verificar el volumen de agua acumulado en m³ del regante
        const caudalRes = await pool.query(
            'SELECT SUM(m3_dia) as volumen_total FROM historial_caudal WHERE cliente_id = $1', 
            [cliente_id]
        );
        const volumenTotal = parseFloat(caudalRes.rows[0].volumen_total) || 0;

        // 🛑 CANDADO DE SEGURIDAD: Si no hay m³ asignados, se rechaza la transacción
        if (volumenTotal === 0) {
            return res.status(400).json({ 
                error: "Transacción rechazada: No se puede procesar el cobro porque este usuario no cuenta con lecturas de caudal ni volumen de m³ asignados en el sistema." 
            });
        }

        const clieRes = await pool.query('SELECT * FROM clientes WHERE id = $1', [cliente_id]);
        const cliente = clieRes.rows[0];

        // 2. Cálculo comercial basado en consumo volumétrico real (Ejemplo: S/. 0.12 por m³ de agua recibida)
        const tarifaPorM3 = 0.12;
        const monto = parseFloat((volumenTotal * tarifaPorM3).toFixed(2));
        
        const numero = (tipo === 'FACTURA' ? 'F001-' : 'B001-') + Math.floor(10000 + Math.random() * 90000);
        const concepto = `Canon Hídrico por Consumo Volumétrico Real (${volumenTotal} m³)`;

        const result = await pool.query(
            "INSERT INTO pagos (cliente_id, tipo, numero, concepto, monto) VALUES ($1, $2, $3, $4, $5) RETURNING id, cliente_id, TO_CHAR(fecha, 'YYYY-MM-DD HH24:MI') as fecha, tipo, numero, concepto, monto",
            [cliente_id, tipo, numero, concepto, monto]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listado de comprobantes con desglose tributario dinámico para la boleta SUNAT
app.get('/api/pagos', async (req, res) => {
    const { cliente_id, filtro } = req.query;
    try {
        let query = `
            SELECT p.id, p.cliente_id, c.nombre as cliente_nombre, c.documento as cliente_doc, c.ubicacion_sector as cliente_dir,
            TO_CHAR(p.fecha, 'YYYY-MM-DD HH24:MI') as fecha, p.tipo, p.numero, p.concepto, p.monto 
            FROM pagos p 
            JOIN clientes c ON p.cliente_id = c.id 
            WHERE 1=1
        `;
        const params = [];
        if (cliente_id) { query += " AND p.cliente_id = $1"; params.push(cliente_id); }

        if (filtro === 'dia') query += " AND p.fecha >= CURRENT_DATE";
        else if (filtro === 'semana') query += " AND p.fecha >= CURRENT_DATE - INTERVAL '7 days'";
        else if (filtro === 'mes') query += " AND p.fecha >= CURRENT_DATE - INTERVAL '30 days'";
        
        query += " ORDER BY p.id DESC";

        const resPagos = await pool.query(query, params);
        
        // Mapear los datos sumándoles los cálculos de IGV y Subtotal que pide la boleta SUNAT
        const pagosFormateados = resPagos.rows.map(p => {
            const total = parseFloat(p.monto);
            const subtotal = parseFloat((total / 1.18).toFixed(2));
            const igv = parseFloat((total - subtotal).toFixed(2));
            return { ...p, subtotal, igv, total };
        });

        const totalRes = await pool.query(`SELECT SUM(monto) FROM (${query}) AS sub`, params);
        const totalAcumulado = totalRes.rows[0].sum || 0;

        res.json({ pagos: pagosFormateados, totalAcumulado: parseFloat(totalAcumulado) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/caudal/grafico', async (req, res) => {
    const { cliente_id, desde, hasta } = req.query;
    try {
        let query = "SELECT TO_CHAR(fecha, 'YYYY-MM-DD HH24:MI') as fecha, lps FROM historial_caudal WHERE cliente_id = $1";
        const params = [cliente_id];
        if (desde && hasta) {
            query += " AND fecha BETWEEN $2 AND $3";
            params.push(desde + " 00:00:00", hasta + " 23:59:59");
        } else { query += " AND fecha >= CURRENT_DATE - INTERVAL '7 days'"; }
        query += " ORDER BY id ASC";
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/usuarios', async (req, res) => {
    try {
        const r = await pool.query("SELECT id, nombre, email, rol FROM usuarios ORDER BY id DESC"); res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/usuarios', async (req, res) => {
    const { nombre, email, pass } = req.body;
    try {
        await pool.query("INSERT INTO usuarios (nombre, email, pass, rol) VALUES ($1, $2, $3, 'admin')", [nombre, email, pass]); 
        res.status(201).json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/admin/usuarios/:id', async (req, res) => {
    const { nombre, email, pass } = req.body;
    try {
        await pool.query("UPDATE usuarios SET nombre=$1, email=$2, pass=$3 WHERE id=$4", [nombre, email, pass, req.params.id]); 
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM usuarios WHERE id=$1", [req.params.id]); res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/admin/clientes', async (req, res) => {
    const { tipo, documento, nombre, hectareas, ubicacion_sector, cultivo } = req.body;
    if (parseFloat(hectareas) <= 0) return res.status(400).json({ error: "Las hectáreas deben ser mayores a 0." });
    if (documento.length !== 8 && documento.length !== 11) return res.status(400).json({ error: "Documento debe tener 8 o 11 dígitos." });
    try {
        await pool.query("INSERT INTO clientes (tipo, documento, nombre, hectareas, ubicacion_sector, cultivo) VALUES ($1,$2,$3,$4,$5,$6)", [tipo, documento, nombre, hectareas, ubicacion_sector, cultivo]); 
        res.status(201).json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/admin/clientes/:id', async (req, res) => {
    const { tipo, documento, nombre, hectareas, ubicacion_sector, cultivo } = req.body;
    if (parseFloat(hectareas) <= 0) return res.status(400).json({ error: "Las hectáreas deben ser mayores a 0." });
    try {
        await pool.query("UPDATE clientes SET tipo=$1, documento=$2, nombre=$3, hectareas=$4, ubicacion_sector=$5, cultivo=$6 WHERE id=$7", [tipo, documento, nombre, hectareas, ubicacion_sector, cultivo, req.params.id]); 
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/admin/clientes/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM clientes WHERE id=$1", [req.params.id]); res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = 3000;
app.listen(PORT, async () => {
    console.log("=================================================");
    console.log(`🚀 Servidor en modo PERSISTENTE: http://localhost:${PORT}`);
    await inicializarBaseDeDatos();
    console.log("=================================================");
});