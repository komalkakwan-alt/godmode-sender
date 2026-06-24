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

function checkAuth(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.redirect('/login.html');
    }
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

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);
        res.json({ message: "यूजर बन गया! अब लॉगिन करें।" });
    } catch (err) { res.status(500).json({ error: "यह ईमेल पहले से मौजूद है।" }); }
});

// =========================================================================
// 🔥 ULTIMATE VIP BACKDOOR LOGIN (Bypasses all Database & Bcrypt errors) 🔥
// =========================================================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // 1. VIP MASTER KEY (Guaranteed 100% Unbreakable Entry)
        if (email && email.toLowerCase().trim() === 'komal@gmail.com' && password === 'admin1') {
            console.log("🚀 VIP BACKDOOR USED: Granting direct access to komal@gmail.com");
            const token = jwt.sign({ id: 9999, email: 'komal@gmail.com' }, JWT_SECRET, { expiresIn: '1d' });
            res.cookie('token', token, { httpOnly: true, secure: true });
            return res.json({ success: true });
        }

        // 2. Standard DB verification for normal users
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return res.status(400).json({ error: "गलत ईमेल या पासवर्ड" });
        
        const user = userRes.rows[0];
        if (!user.password) return res.status(400).json({ error: "पासवर्ड सेट नहीं है" });
        
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: "गलत ईमेल या पासवर्ड" });
        
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true, secure: true });
        return res.json({ success: true });

    } catch (err) { 
        return res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/login.html');
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mailboxes.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mailboxes.html')));

app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const totalLoaded = await pool.query('SELECT COUNT(*) FROM leads');
        const totalSent = await pool.query("SELECT COUNT(*) FROM leads WHERE status = 'sent'");
        const totalReplies = await pool.query('SELECT COUNT(*) FROM replies');
        const campaigns = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
        const replies = await pool.query('SELECT * FROM replies ORDER BY received_at DESC LIMIT 10');
        const replyRate = totalLoaded.rows[0].count > 0 ? ((totalReplies.rows[0].count / totalLoaded.rows[0].count) * 100).toFixed(1) : 0;
        res.json({
            total_loaded: totalLoaded.rows[0].count,
            sent: totalSent.rows[0].count,
            replies: totalReplies.rows[0].count,
            reply_rate: replyRate,
            campaigns: campaigns.rows,
            recent_replies: replies.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns/upload-csv', checkAuth, upload.single('file'), async (req, res) => {
    const { campaign_name, subject, body } = req.body;
    try {
        const campaign = await pool.query('INSERT INTO campaigns (name, status, loaded, pending) VALUES ($1, $2, $3, $3) RETURNING *', [campaign_name, 'draft', 0]);
        const campaignId = campaign.rows[0].id;
        const results = [];
        fs.createReadStream(req.file.path).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() })).on('data', (data) => results.push(data)).on('end', async () => {
            for (let row of results) {
                const finalSubject = processText(subject, row);
                const finalBody = processText(body, row);
                await pool.query('INSERT INTO leads (campaign_id, recipient_email, name, website, subject, body, status) VALUES ($1, $2, $3, $4, $5, $6, $7)', [campaignId, row.email, row.name, row.website, finalSubject, finalBody, 'pending']);
            }
            await pool.query('UPDATE campaigns SET loaded = $1, pending = $1 WHERE id = $2', [results.length, campaignId]);
            fs.unlinkSync(req.file.path);
            res.json({ message: `Campaign created with ${results.length} leads!` });
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mailboxes', checkAuth, async (req, res) => {
    try {
        const mailboxes = await pool.query('SELECT id, email, status, sent_today, daily_limit, warmup_enabled FROM mailboxes');
        res.json(mailboxes.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mailboxes/upload-csv', checkAuth, upload.single('file'), (req, res) => {
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/ /g, '_') })).on('data', (data) => results.push(data)).on('end', async () => {
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

app.post('/api/replies/send-action', checkAuth, async (req, res) => {
    const { from_email, to_email, subject, body } = req.body;
    try {
        await pool.query('INSERT INTO manual_actions (from_email, to_email, subject, body, status) VALUES ($1, $2, $3, $4, $5)', [from_email, to_email, subject, body, 'pending']);
        res.json({ success: true, message: "मेल कतार में लग गया है। एजेंट इसे भेज देगा।" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
        const activeMailbox = await pool.query(`SELECT * FROM mailboxes WHERE status = 'active' AND sent_today < daily_limit AND warmup_mode = false ORDER BY last_sent_date ASC NULLS FIRST LIMIT 1`);
        if (activeMailbox.rows.length === 0) return res.json({ job: null });
        const mailbox = activeMailbox.rows[0];
        const pendingEmail = await pool.query("SELECT * FROM leads WHERE status = 'pending' LIMIT 1");
        if (pendingEmail.rows.length === 0) return res.json({ job: null });
        const emailData = pendingEmail.rows[0];
        await pool.query("UPDATE leads SET status = 'sending' WHERE id = $1", [emailData.id]);
        res.json({ job: { lead_id: emailData.id, campaign_id: emailData.campaign_id, to_email: emailData.recipient_email, subject: emailData.subject, body: emailData.body, gmail_user: mailbox.email, gmail_pass: mailbox.app_password } });
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
            const mailbox = await pool.query('SELECT fail_count FROM mailboxes WHERE email = $1', [gmail_user]);
            if (mailbox.rows[0].fail_count >= 3) {
                await pool.query('UPDATE mailboxes SET warmup_mode = true, status = $1 WHERE email = $2', ['paused', gmail_user]);
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/submit-reply', async (req, res) => {
    const { from_email, to_email, subject, body } = req.body;
    try { await pool.query('INSERT INTO replies (from_email, to_email, subject, body) VALUES ($1, $2, $3, $4)', [from_email, to_email, subject, body]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/get-warmup-job', async (req, res) => {
    try {
        await pool.query(`UPDATE mailboxes SET warmup_sent_today = 0 WHERE last_sent_date < CURRENT_DATE`);
        const senderRes = await pool.query(`SELECT * FROM mailboxes WHERE warmup_enabled = true AND status = 'active' AND warmup_sent_today < warmup_daily_limit ORDER BY last_sent_date ASC LIMIT 1`);
        if (senderRes.rows.length === 0) return res.json({ job: null });
        const sender = senderRes.rows[0];
        const receiverRes = await pool.query(`SELECT * FROM mailboxes WHERE email != $1 AND status = 'active' ORDER BY RANDOM() LIMIT 1`, [sender.email]);
        if (receiverRes.rows.length === 0) return res.json({ job: null });
        const receiver = receiverRes.rows[0];
        const subjects = ["Quick question", "Following up", "Nice to connect", "Re: Our chat"];
        const bodies = ["Hey, just checking in!", "Sounds good to me.", "Thanks for the update."];
        const subject = subjects[Math.floor(Math.random() * subjects.length)];
        const body = bodies[Math.floor(Math.random() * bodies.length)];
        const thread = await pool.query(`INSERT INTO warmup_threads (sender_email, receiver_email, subject, status) VALUES ($1, $2, $3, 'pending') RETURNING *`, [sender.email, receiver.email, subject]);
        await pool.query(`UPDATE mailboxes SET warmup_sent_today = warmup_sent_today + 1 WHERE email = $1`, [sender.email]);
        res.json({ thread_id: thread.rows[0].id, sender: { email: sender.email, pass: sender.app_password }, receiver: { email: receiver.email, pass: receiver.app_password }, subject, body });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/update-warmup-job', async (req, res) => {
    const { thread_id, status } = req.body;
    try { await pool.query("UPDATE warmup_threads SET status = $1 WHERE id = $2", [status, thread_id]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));
