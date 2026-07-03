const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const CATEGORIES = ['General', 'Repairs and Maintenance', 'Service', 'Food and Beverage', 'Upcoming Events'];

const BOARD_KEY = process.env.BOARD_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const DIGEST_CRON = process.env.DIGEST_CRON || '0 23 * * *'; // default: 11:00 PM daily
const TZ = process.env.TZ || 'America/New_York';
const CLEAR_AFTER_SEND = (process.env.CLEAR_AFTER_SEND || 'true').toLowerCase() === 'true';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]');
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ boardTitle: '620 NOTES', recipients: [] }, null, 2));
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Require a shared key for anything that writes data, so randoms on the
// internet can't post to or wipe your board. Staff just need this one
// passphrase, entered once in the board's Email settings panel.
function requireKey(req, res, next) {
  if (!BOARD_KEY) return next(); // no key configured yet -> open (fine for local testing only)
  const provided = req.header('x-board-key');
  if (provided !== BOARD_KEY) {
    return res.status(401).json({ error: 'Missing or incorrect board key.' });
  }
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Notes ----
app.get('/api/notes', (req, res) => {
  res.json(readJSON(NOTES_FILE, []));
});

app.post('/api/notes', requireKey, (req, res) => {
  const { author, category, tag, message } = req.body || {};
  if (!author || !message || !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'author, message, and a valid category are required.' });
  }
  const notes = readJSON(NOTES_FILE, []);
  const note = {
    id: 'n' + Date.now() + Math.random().toString(36).slice(2, 7),
    author: String(author).slice(0, 60),
    category,
    tag: tag || 'Note',
    message: String(message).slice(0, 1000),
    ts: new Date().toISOString()
  };
  notes.push(note);
  writeJSON(NOTES_FILE, notes);
  res.status(201).json(note);
});

app.delete('/api/notes/:id', requireKey, (req, res) => {
  const notes = readJSON(NOTES_FILE, []);
  const filtered = notes.filter(n => n.id !== req.params.id);
  writeJSON(NOTES_FILE, filtered);
  res.json({ ok: true });
});

// ---- Settings (board title + recipient list) ----
app.get('/api/settings', (req, res) => {
  res.json(readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES', recipients: [] }));
});

app.post('/api/settings', requireKey, (req, res) => {
  const { boardTitle, recipients } = req.body || {};
  const current = readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES', recipients: [] });
  const updated = {
    boardTitle: boardTitle !== undefined ? String(boardTitle).slice(0, 80) : current.boardTitle,
    recipients: Array.isArray(recipients) ? recipients.map(r => String(r).trim()).filter(Boolean) : current.recipients
  };
  writeJSON(SETTINGS_FILE, updated);
  res.json(updated);
});

// ---- Digest building + sending ----
function buildDigestText(notes, boardTitle) {
  const now = new Date();
  let out = `${boardTitle}\n`;
  out += `Nightly digest — ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}\n`;
  out += '='.repeat(40) + '\n\n';
  CATEGORIES.forEach(cat => {
    const catNotes = notes.filter(n => n.category === cat).sort((a, b) => new Date(b.ts) - new Date(a.ts));
    out += `${cat.toUpperCase()}\n${'-'.repeat(cat.length)}\n`;
    if (catNotes.length === 0) {
      out += 'No notes\n\n';
    } else {
      catNotes.forEach(n => {
        const t = new Date(n.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        out += `[${t}] ${n.author} (${n.tag}): ${n.message}\n`;
      });
      out += '\n';
    }
  });
  return out;
}

async function sendViaResend(to, subject, text) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      text
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

async function runDigest() {
  const notes = readJSON(NOTES_FILE, []);
  const settings = readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES', recipients: [] });
  const subject = `${settings.boardTitle} — Nightly Digest, ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const text = buildDigestText(notes, settings.boardTitle);

  const results = { sent: [], failed: [] };
  for (const to of settings.recipients) {
    try {
      await sendViaResend(to, subject, text);
      results.sent.push(to);
    } catch (e) {
      results.failed.push({ to, error: e.message });
    }
  }

  if (results.sent.length > 0 && CLEAR_AFTER_SEND) {
    const archiveFile = path.join(DATA_DIR, `archive-${new Date().toISOString().slice(0, 10)}.json`);
    writeJSON(archiveFile, notes);
    writeJSON(NOTES_FILE, []);
  }

  console.log(`[digest] sent to ${results.sent.length}, failed for ${results.failed.length}`);
  return results;
}

// Manual trigger — handy for testing before you trust the schedule.
app.post('/api/send-digest', requireKey, async (req, res) => {
  try {
    const results = await runDigest();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cron.schedule(DIGEST_CRON, () => {
  runDigest().catch(e => console.error('[digest] scheduled run failed:', e.message));
}, { timezone: TZ });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bar Miller backend running on port ${PORT}`);
  console.log(`Nightly digest scheduled: "${DIGEST_CRON}" (${TZ})`);
});
