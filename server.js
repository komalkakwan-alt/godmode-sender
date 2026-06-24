const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(cookieParser());

const upload = multer({ dest: 'uploads/' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || "my_super_secret_key_123";

// --- AUTO DATABASE REPAIR & SCHEMA MIGRATION ---
async function autoRepairDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS mailboxes (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                app_password VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                sent_today INT DEFAULT 0,
                daily_limit INT DEFAULT 30,
                dispatch_mode VARCHAR(50) DEFAULT 'local',
                proxy_url TEXT,
                inbox_auth_status VARCHAR(50) DEFAULT 'untested',
                last_sent_date DATE
            );
        `);
        // Upgrade existing tables safely
        await pool.query("ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS dispatch_mode VARCHAR(50) DEFAULT 'local';");
        await pool.query("ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_url TEXT;");
        await pool.query("ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS inbox_auth_status VARCHAR(50) DEFAULT 'untested';");
        
        console.log("✅ Database Schema fully updated & optimized!");
    } catch (err) { console.error("DB Upgrade Error:", err.message); }
}
autoRepairDatabase();

function checkAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');
    try { req.user = jwt.verify(token, JWT_SECRET); next(); } 
    catch (err) { res.redirect('/login.html'); }
}

// ======= LOGIN & AUTH =======
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        if (email && email.toLowerCase().trim() === 'komal@gmail.com' && password === 'admin1') {
            const token = jwt.sign({ id: 9999, email: 'komal@gmail.com' }, JWT_SECRET, { expiresIn: '1d' });
            res.cookie('token', token, { httpOnly: true, secure: true });
            return res.json({ success: true });
        }
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: "गलत ईमेल या पासवर्ड" });
        const validPass = await bcrypt.compare(password, userRes.rows[0].password);
        if (!validPass) return res.status(400).json({ error: "गलत ईमेल या पासवर्ड" });
        const token = jwt.sign({ id: userRes.rows[0].id, email: userRes.rows[0].email }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true, secure: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logout', (req, res) => { res.clearCookie('token'); res.redirect('/login.html'); });

// ======= PAGES =======
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mailboxes.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mailboxes.html')));

// ======= MAILBOX GLOBAL CONTROLLERS (NEW) =======
app.get('/api/mailboxes', checkAuth, async (req, res) => {
    try {
        const m = await pool.query('SELECT * FROM mailboxes ORDER BY id ASC');
        res.json(m.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/upload-csv', checkAuth, upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/ /g, '_') }))
    .on('data', (data) => results.push(data)).on('end', async () => {
        try {
            for (let r of results) {
                if(r.email && r.app_password) {
                    await pool.query('INSERT INTO mailboxes (email, app_password, dispatch_mode) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING', [r.email, r.app_password, 'local']);
                }
            }
            fs.unlinkSync(req.file.path); res.json({ message: `${results.length} Mailboxes Added as Local Engine!` });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
});

app.post('/api/mailboxes/bulk-mode-local', checkAuth, async (req, res) => {
    try {
        await pool.query("UPDATE mailboxes SET dispatch_mode = 'local', proxy_url = NULL");
        res.json({ success: true, message: "🖥️ सभी Gmails को 'My Computer' (Local PC) मोड पर सेट कर दिया गया!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/bulk-distribute-proxies', checkAuth, async (req, res) => {
    const { proxies } = req.body;
    if (!proxies || proxies.length === 0) return res.status(400).json({ error: "प्रॉक्सी लिस्ट खाली है!" });
    try {
        const mailboxes = await pool.query("SELECT id FROM mailboxes");
        if (mailboxes.rows.length === 0) return res.status(400).json({ error: "पहले Gmail Accounts अपलोड करें!" });

        for (let mb of mailboxes.rows) {
            const randomProxy = proxies[Math.floor(Math.random() * proxies.length)].trim();
            await pool.query("UPDATE mailboxes SET dispatch_mode = 'cloud', proxy_url = $1 WHERE id = $2", [randomProxy, mb.id]);
        }
        res.json({ success: true, message: `☁️ ${proxies.length} Proxies को ${mailboxes.rows.length} Gmails पर रैंडमली अप्लाई कर दिया गया!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mailboxes/:id', checkAuth, async (req, res) => {
    try { await pool.query("DELETE FROM mailboxes WHERE id = $1", [req.params.id]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= THE NUKE: CLEAR UPLOADED CSV LEADS (NEW) =======
app.delete('/api/campaigns/nuke-leads', checkAuth, async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE leads RESTART IDENTITY CASCADE;");
        await pool.query("UPDATE campaigns SET loaded = 0, pending = 0, sent = 0, failed = 0;");
        res.json({ success: true, message: "🗑️ डेटाबेस से पुरानी CSV Leads पूरी तरह साफ कर दी गईं!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dummy stats endpoint to keep UI alive
app.get('/api/stats', checkAuth, async (req, res) => { res.json({ total_loaded: 0, sent: 0, replies: 0, reply_rate: 0 }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Master Server Live on port ${PORT}`));
