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
const nodemailer = require('nodemailer');
const { SocksProxyAgent } = require('socks-proxy-agent');
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

const JWT_SECRET = process.env.JWT_SECRET || "komal_super_secret_key_9988";

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

// ======= AUTO CLOUD-PROXY DISPATCH ENGINE (Runs every 20 seconds) =======
setInterval(async () => {
    try {
        const mbRes = await pool.query(`SELECT * FROM mailboxes WHERE status = 'active' AND send_mode = 'cloud_proxy' AND sent_today < daily_limit LIMIT 1`);
        if (mbRes.rows.length === 0) return;
        const mailbox = mbRes.rows;

        const leadRes = await pool.query(`SELECT * FROM leads WHERE status = 'pending' AND bounced = false AND opt_out = false LIMIT 1`);
        if (leadRes.rows.length === 0) return;
        const lead = leadRes.rows;

        await pool.query(`UPDATE leads SET status = 'sending' WHERE id = $1`, [lead.id]);

        let transportOpts = {
            host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: mailbox.email, pass: mailbox.app_password }
        };

        if (mailbox.proxy_url && mailbox.proxy_url.includes('socks5')) {
            transportOpts.agent = new SocksProxyAgent(mailbox.proxy_url);
        }

        const transporter = nodemailer.createTransport(transportOpts);
        await transporter.sendMail({
            from: `"${mailbox.email.split('@')}" <${mailbox.email}>`,
            to: lead.recipient_email,
            subject: lead.subject,
            html: lead.body
        });

        await pool.query(`UPDATE leads SET status = 'sent' WHERE id = $1`, [lead.id]);
        await pool.query(`UPDATE mailboxes SET sent_today = sent_today + 1, last_sent_date = CURRENT_DATE, fail_count = 0, inbox_auth_status = 'verified' WHERE email = $1`, [mailbox.email]);
        await pool.query(`UPDATE campaigns SET sent = sent + 1, pending = pending - 1 WHERE id = $1`, [lead.campaign_id]);
        console.log(`☁️ [Cloud Engine] Sent to ${lead.recipient_email} via Proxy: ${mailbox.proxy_url || 'Direct IP'}`);

    } catch (err) { 
        console.log(`☁️ [Cloud Silent Retry]:`, err.message); 
    }
}, 20000);

// ======= AUTH ROUTES =======
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(password, salt);
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashed]);
        res.json({ message: "User registered!" });
    } catch (err) { res.status(500).json({ error: "Email already exists" }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: "Wrong credentials" });
        const validPass = await bcrypt.compare(password, userRes.rows.password);
        if (!validPass) return res.status(400).json({ error: "Wrong credentials" });
        const token = jwt.sign({ id: userRes.rows.id, email }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true, secure: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logout', (req, res) => { res.clearCookie('token'); res.redirect('/login.html'); });

// ======= PAGE ROUTES =======
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mailboxes.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mailboxes.html')));

// ======= STATS API =======
app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const loaded = await pool.query('SELECT COUNT(*) FROM leads');
        const sent = await pool.query("SELECT COUNT(*) FROM leads WHERE status = 'sent'");
        const replies = await pool.query('SELECT COUNT(*) FROM replies');
        const camps = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
        const rep = await pool.query('SELECT * FROM replies ORDER BY received_at DESC LIMIT 10');
        const rate = loaded.rows.count > 0 ? ((replies.rows.count / loaded.rows.count) * 100).toFixed(1) : 0;
        res.json({ total_loaded: loaded.rows.count, sent: sent.rows.count, replies: replies.rows.count, reply_rate: rate, campaigns: camps.rows, recent_replies: rep.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= BULLETPROOF CSV UPLOADERS (Auto-Trims spaces & capitals) =======
app.post('/api/campaigns/upload-csv', checkAuth, upload.single('file'), async (req, res) => {
    const { campaign_name, subject, body } = req.body;
    try {
        const camp = await pool.query('INSERT INTO campaigns (name, status, loaded, pending) VALUES ($1, $2, $3, $3) RETURNING *', [campaign_name, 'draft', 0]);
        const campId = camp.rows.id;
        const results = [];
        fs.createReadStream(req.file.path)
          .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
          .on('data', (data) => results.push(data)).on('end', async () => {
            for (let row of results) {
                const fSub = processText(subject, row);
                const fBody = processText(body, row);
                await pool.query('INSERT INTO leads (campaign_id, recipient_email, name, website, subject, body, status) VALUES ($1, $2, $3, $4, $5, $6, $7)', [campId, row.email, row.name, row.website, fSub, fBody, 'pending']);
            }
            await pool.query('UPDATE campaigns SET loaded = $1, pending = $1 WHERE id = $2', [results.length, campId]);
            fs.unlinkSync(req.file.path);
            res.json({ message: `Campaign created with ${results.length} leads!` });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/upload-csv', checkAuth, upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/ /g, '_') }))
      .on('data', (data) => results.push(data)).on('end', async () => {
        try {
            for (let row of results) {
                if(row.email && row.app_password) {
                    await pool.query('INSERT INTO mailboxes (email, app_password, daily_limit) VALUES ($1, $2, 30) ON CONFLICT (email) DO NOTHING', [row.email, row.app_password]);
                }
            }
            fs.unlinkSync(req.file.path);
            res.json({ message: `${results.length} Mailboxes Added!` });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
});

// ======= MAILBOX MANAGERS (Pillar 3) =======
app.get('/api/mailboxes', checkAuth, async (req, res) => {
    try {
        const mb = await pool.query('SELECT id, email, status, sent_today, daily_limit, proxy_url, send_mode, inbox_auth_status FROM mailboxes ORDER BY id ASC');
        res.json(mb.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/verify-auth', checkAuth, async (req, res) => {
    const { email } = req.body;
    try {
        const mbRes = await pool.query('SELECT * FROM mailboxes WHERE email = $1', [email]);
        if (mbRes.rows.length === 0) return res.status(404).json({ error: "Not found" });
        const mb = mbRes.rows;

        let opts = { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: mb.email, pass: mb.app_password } };
        if (mb.proxy_url && mb.proxy_url.includes('socks5')) opts.agent = new SocksProxyAgent(mb.proxy_url);

        const transporter = nodemailer.createTransport(opts);
        await transporter.verify();

        await pool.query(`UPDATE mailboxes SET inbox_auth_status = 'verified', status = 'active' WHERE email = $1`, [email]);
        res.json({ success: true, message: "Auth Verified ✅" });
    } catch (err) {
        await pool.query(`UPDATE mailboxes SET inbox_auth_status = 'failed', status = 'paused' WHERE email = $1`, [email]);
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/mailboxes/update-mode', checkAuth, async (req, res) => {
    const { email, send_mode, proxy_url } = req.body;
    try {
        await pool.query('UPDATE mailboxes SET send_mode = $1, proxy_url = $2 WHERE email = $3', [send_mode, proxy_url, email]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======= LOCAL PC DISPATCH ENGINE (Pillar 2) =======
app.get('/api/agent/get-job', async (req, res) => {
    try {
        await pool.query(`UPDATE mailboxes SET sent_today = 0 WHERE last_sent_date < CURRENT_DATE`);
        const activeMb = await pool.query(`SELECT * FROM mailboxes WHERE status = 'active' AND send_mode = 'local_computer' AND sent_today < daily_limit ORDER BY last_sent_date ASC NULLS FIRST LIMIT 1`);
        if (activeMb.rows.length === 0) return res.json({ job: null });
        const mailbox = activeMb.rows;

        const pendingLead = await pool.query("SELECT * FROM leads WHERE status = 'pending' AND bounced = false AND opt_out = false LIMIT 1");
        if (pendingLead.rows.length === 0) return res.json({ job: null });
        const lead = pendingLead.rows;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SaaS Dual-Engine active on port ${PORT}`));
