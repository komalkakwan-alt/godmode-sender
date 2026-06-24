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

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const upload = multer({ dest: UPLOADS_DIR });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || "my_super_secret_key_123";

// --- 🛡️ IMMORTAL DATABASE SETUP ---
async function setupImmortalDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            );
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
            CREATE TABLE IF NOT EXISTS campaigns (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'draft',
                loaded INT DEFAULT 0,
                sent INT DEFAULT 0,
                pending INT DEFAULT 0,
                bounced INT DEFAULT 0,
                failed INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                campaign_id INT REFERENCES campaigns(id) ON DELETE CASCADE,
                recipient_email VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                website VARCHAR(255),
                subject TEXT,
                body TEXT,
                status VARCHAR(50) DEFAULT 'staged',
                bounced BOOLEAN DEFAULT false,
                opt_out BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS replies (
                id SERIAL PRIMARY KEY,
                from_email VARCHAR(255),
                to_email VARCHAR(255),
                subject TEXT,
                body TEXT,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS manual_actions (
                id SERIAL PRIMARY KEY,
                from_email VARCHAR(255),
                to_email VARCHAR(255),
                subject TEXT,
                body TEXT,
                status VARCHAR(50) DEFAULT 'pending'
            );
        `);
        console.log("🛡️ Master DB Check: All tables are immortal & persistent!");
    } catch (e) { console.error("DB Immortal Setup Error:", e.message); } 
    finally { client.release(); }
}
setupImmortalDatabase();

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

function checkAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');
    try { req.user = jwt.verify(token, JWT_SECRET); next(); } 
    catch (err) { res.redirect('/login.html'); }
}

function processText(text, lead) {
    if (!text) return "";
    text = text.replace(/\{([^{}]+)\}/g, (match, content) => {
        if (content.includes('|')) {
            const options = content.split('|');
            return options[Math.floor(Math.random() * options.length)];
        }
        return match;
    });
    text = text.replace(/{name}/gi, lead.name || 'there');
    text = text.replace(/{website}/gi, lead.website || 'your website');
    text = text.replace(/{email}/gi, lead.email || '');
    return text;
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

// ======= STATIC PAGES =======
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mailboxes.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mailboxes.html')));

// ======= STATS API =======
app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const loadedRes = await pool.query("SELECT COUNT(*) FROM leads");
        const sentRes = await pool.query("SELECT COUNT(*) FROM leads WHERE status = 'sent'");
        const repliesRes = await pool.query("SELECT COUNT(*) FROM replies");
        const camps = await pool.query("SELECT * FROM campaigns ORDER BY created_at DESC");
        const rep = await pool.query("SELECT * FROM replies ORDER BY received_at DESC LIMIT 10");
        
        const totalLoaded = parseInt(loadedRes.rows[0].count) || 0;
        const totalSent = parseInt(sentRes.rows[0].count) || 0;
        const totalReplies = parseInt(repliesRes.rows[0].count) || 0;
        const rate = totalLoaded > 0 ? ((totalReplies / totalLoaded) * 100).toFixed(1) : 0;

        res.json({ total_loaded: totalLoaded, sent: totalSent, replies: totalReplies, reply_rate: rate, campaigns: camps.rows, recent_replies: rep.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= BULK CSV INGESTION =======
app.post('/api/campaigns/upload-csv', checkAuth, upload.single('file'), async (req, res) => {
    const { campaign_name, subject, body } = req.body;
    const results = [];
    
    fs.createReadStream(req.file.path)
      .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
      .on('data', (data) => results.push(data))
      .on('end', async () => {
          const client = await pool.connect();
          try {
              await client.query('BEGIN');
              const campRes = await client.query(
                  "INSERT INTO campaigns (name, status, loaded, pending) VALUES ($1, 'draft', $2, $2) RETURNING id",
                  [campaign_name, results.length]
              );
              const campId = campRes.rows[0].id;

              const batches = chunkArray(results, 1000);
              for (let batch of batches) {
                  const placeholders = []; const values = []; let pIdx = 1;
                  batch.forEach(row => {
                      const email = (row.email || row.Email || '').trim();
                      if (email) {
                          const fSub = processText(subject, row); const fBody = processText(body, row);
                          placeholders.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5}, 'staged')`);
                          values.push(campId, email, row.name || '', row.website || '', fSub, fBody);
                          pIdx += 6;
                      }
                  });
                  if (placeholders.length > 0) {
                      await client.query(`INSERT INTO leads (campaign_id, recipient_email, name, website, subject, body, status) VALUES ${placeholders.join(', ')}`, values);
                  }
              }
              await client.query('COMMIT');
              if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
              res.json({ message: `🟢 Campaign '${campaign_name}' (${results.length} leads) 100% सेव हो गया!` });
          } catch (e) {
              await client.query('ROLLBACK'); res.status(500).json({ error: "CSV Save Error: " + e.message });
          } finally { client.release(); }
      });
});

// ======= STAGED DISPATCH TRIGGER =======
app.post('/api/campaigns/:id/toggle-send', checkAuth, async (req, res) => {
    const { action } = req.body; const campId = req.params.id;
    try {
        if (action === 'start') {
            await pool.query("UPDATE campaigns SET status = 'active' WHERE id = $1", [campId]);
            await pool.query("UPDATE leads SET status = 'pending' WHERE campaign_id = $1 AND status = 'staged'", [campId]);
            res.json({ message: "🟢 Campaign DISPATCHED! सेंडिंग चालू हो गई है।" });
        } else {
            await pool.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [campId]);
            await pool.query("UPDATE leads SET status = 'staged' WHERE campaign_id = $1 AND status = 'pending'", [campId]);
            res.json({ message: "🟡 Campaign PAUSED! सेंडिंग रोक दी गई है।" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= 🗑️ NEW: INDIVIDUAL CAMPAIGN DELETE API (CASCADES LEADS) =======
app.delete('/api/campaigns/:id', checkAuth, async (req, res) => {
    try {
        await pool.query("DELETE FROM campaigns WHERE id = $1", [req.params.id]);
        res.json({ success: true, message: "🗑️ Campaign और उसकी सारी Leads हमेशा के लिए डिलीट हो गईं!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= MAILBOX MANAGERS =======
app.get('/api/mailboxes', checkAuth, async (req, res) => {
    try { const m = await pool.query('SELECT * FROM mailboxes ORDER BY id ASC'); res.json(m.rows); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/upload-csv', checkAuth, upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/ /g, '_') }))
    .on('data', (data) => results.push(data)).on('end', async () => {
        try {
            for (let r of results) {
                if(r.email && r.app_password) await pool.query('INSERT INTO mailboxes (email, app_password, dispatch_mode) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING', [r.email, r.app_password, 'local']);
            }
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.json({ message: `${results.length} Mailboxes Added as Local PC Engine!` });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
});

app.post('/api/mailboxes/bulk-mode-local', checkAuth, async (req, res) => {
    try { await pool.query("UPDATE mailboxes SET dispatch_mode = 'local', proxy_url = NULL"); res.json({ success: true, message: "🖥️ सभी Gmails को Local PC मोड पर सेट किया गया!" }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/bulk-distribute-proxies', checkAuth, async (req, res) => {
    const { proxies } = req.body;
    if (!proxies || proxies.length === 0) return res.status(400).json({ error: "प्रॉक्सी लिस्ट खाली है!" });
    try {
        const mailboxes = await pool.query("SELECT id FROM mailboxes");
        if (mailboxes.rows.length === 0) return res.status(400).json({ error: "पहले Gmails अपलोड करें!" });
        for (let mb of mailboxes.rows) {
            const randomProxy = proxies[Math.floor(Math.random() * proxies.length)].trim();
            await pool.query("UPDATE mailboxes SET dispatch_mode = 'cloud', proxy_url = $1 WHERE id = $2", [randomProxy, mb.id]);
        }
        res.json({ success: true, message: `☁️ Proxies को ${mailboxes.rows.length} Gmails पर अप्लाई कर दिया गया!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mailboxes/:id', checkAuth, async (req, res) => {
    try { await pool.query("DELETE FROM mailboxes WHERE id = $1", [req.params.id]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaigns/nuke-leads', checkAuth, async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE leads RESTART IDENTITY CASCADE;");
        await pool.query("UPDATE campaigns SET loaded = 0, pending = 0, sent = 0, failed = 0;");
        res.json({ success: true, message: "🗑️ डेटाबेस से पुरानी CSV Leads साफ कर दी गईं!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= CRM MANUAL ACTIONS =======
app.post('/api/replies/send-action', checkAuth, async (req, res) => {
    const { from_email, to_email, subject, body } = req.body;
    try {
        await pool.query('INSERT INTO manual_actions (from_email, to_email, subject, body, status) VALUES ($1, $2, $3, $4, $5)', [from_email, to_email, subject, body, 'pending']);
        res.json({ success: true, message: "Action queued to local Python worker!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= PYTHON AGENT ENDPOINTS =======
app.get('/api/agent/get-manual-job', async (req, res) => {
    try {
        const jobRes = await pool.query(`SELECT ma.id as job_id, ma.to_email, ma.subject, ma.body, m.email as from_email, m.app_password as from_pass FROM manual_actions ma JOIN mailboxes m ON ma.from_email = m.email WHERE ma.status = 'pending' LIMIT 1`);
        if (jobRes.rows.length === 0) return res.json({ job: null });
        const job = jobRes.rows[0];
        await pool.query("UPDATE manual_actions SET status = 'sending' WHERE id = $1", [job.job_id]);
        res.json({ job });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/update-manual-job', async (req, res) => {
    const { job_id, status } = req.body;
    try { await pool.query("UPDATE manual_actions SET status = $1 WHERE id = $2", [status, job_id]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/get-job', async (req, res) => {
    try {
        await pool.query(`UPDATE mailboxes SET sent_today = 0 WHERE last_sent_date < CURRENT_DATE`);
        const activeMb = await pool.query(`SELECT * FROM mailboxes WHERE status = 'active' AND sent_today < daily_limit ORDER BY last_sent_date ASC NULLS FIRST LIMIT 1`);
        if (activeMb.rows.length === 0) return res.json({ job: null });
        const mailbox = activeMb.rows[0];

        const pendingLead = await pool.query("SELECT * FROM leads WHERE status = 'pending' LIMIT 1");
        if (pendingLead.rows.length === 0) return res.json({ job: null });
        const lead = pendingLead.rows[0];

        await pool.query("UPDATE leads SET status = 'sending' WHERE id = $1", [lead.id]);
        res.json({ job: { lead_id: lead.id, campaign_id: lead.campaign_id, to_email: lead.recipient_email, subject: lead.subject, body: lead.body, gmail_user: mailbox.email, gmail_pass: mailbox.app_password } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/update-job', async (req, res) => {
    const { lead_id, campaign_id, gmail_user, status } = req.body;
    try {
        await pool.query("UPDATE leads SET status = $1 WHERE id = $2", [status, lead_id]);
        if (status === 'sent') {
            await pool.query(`UPDATE mailboxes SET sent_today = sent_today + 1, last_sent_date = CURRENT_DATE, fail_count = 0 WHERE email = $1`, [gmail_user]);
            await pool.query("UPDATE campaigns SET sent = sent + 1, pending = pending - 1 WHERE id = $1", [campaign_id]);
        } else {
            await pool.query("UPDATE campaigns SET failed = failed + 1, pending = pending - 1 WHERE id = $1", [campaign_id]);
            await pool.query(`UPDATE mailboxes SET fail_count = fail_count + 1 WHERE email = $1`, [gmail_user]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/submit-reply', async (req, res) => {
    const { from_email, to_email, subject, body } = req.body;
    try { await pool.query('INSERT INTO replies (from_email, to_email, subject, body) VALUES ($1, $2, $3, $4)', [from_email, to_email, subject, body]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Master Server Live on port ${PORT}`));
