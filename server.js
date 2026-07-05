const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // photos, base64-encoded, need real headroom over the 100kb default

const DATA_DIR = path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RESERVATIONS_FILE = path.join(DATA_DIR, 'reservations.json');

const CATEGORIES = ['General', 'Repairs and Maintenance', 'Service', 'Food and Beverage', 'Upcoming Events'];
const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const DIGEST_CRON = process.env.DIGEST_CRON || '0 0 * * *'; // default: midnight daily
const TZ = process.env.TZ || 'America/New_York';
const CLEAR_AFTER_SEND = (process.env.CLEAR_AFTER_SEND || 'true').toLowerCase() === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — auth will fail on every request.');
}
if (!ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY not set — reservation screenshot uploads will fail.');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]');
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ boardTitle: '620 NOTES' }, null, 2));
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Auth: verify the Supabase access token sent by the board, then look
// up the user's name + role from the `profiles` table (see README for the
// SQL that creates it). req.user is attached for downstream handlers.
async function authenticate(req, res, next) {
  const authHeader = req.header('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing login token — please sign in.' });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Your session has expired — please sign in again.' });
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('name, role, notifications_enabled')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || !profile) {
    return res.status(403).json({ error: 'No staff profile found for this account. Ask an admin to set one up.' });
  }

  req.user = {
    id: userData.user.id,
    email: userData.user.email,
    name: profile.name,
    role: profile.role,
    notifications_enabled: profile.notifications_enabled !== false
  };
  next();
}

// ---- Role gate: use after authenticate(). e.g. requireRole('manager') lets
// managers and admins through, blocks staff.
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole] || 999;
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user && req.user.role] || 0;
    if (rank < minRank) {
      return res.status(403).json({ error: `This requires ${minRole} access.` });
    }
    next();
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Lets the board fetch the logged-in user's name + role right after login.
app.get('/api/me', authenticate, (req, res) => {
  res.json(req.user);
});

// Lets a user toggle their own nightly digest preference — no admin needed.
app.patch('/api/me', authenticate, async (req, res) => {
  if (typeof req.body.notifications_enabled !== 'boolean') {
    return res.status(400).json({ error: 'notifications_enabled (boolean) is required.' });
  }
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ notifications_enabled: req.body.notifications_enabled })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  req.user.notifications_enabled = req.body.notifications_enabled;
  res.json(req.user);
});

// ---- Notes ----
app.get('/api/notes', authenticate, (req, res) => {
  res.json(readJSON(NOTES_FILE, []));
});

app.post('/api/notes', authenticate, (req, res) => {
  const { category, tag, message } = req.body || {};
  if (!message || !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'message and a valid category are required.' });
  }
  const notes = readJSON(NOTES_FILE, []);
  const note = {
    id: 'n' + Date.now() + Math.random().toString(36).slice(2, 7),
    authorId: req.user.id,
    author: req.user.name, // taken from the logged-in profile, never typed in
    category,
    tag: tag || 'Note',
    message: String(message).slice(0, 1000),
    pinned: false,
    ts: new Date().toISOString()
  };
  notes.push(note);
  writeJSON(NOTES_FILE, notes);
  res.status(201).json(note);
});

// Pinning is a moderation action — managers and admins only.
app.patch('/api/notes/:id', authenticate, requireRole('manager'), (req, res) => {
  const notes = readJSON(NOTES_FILE, []);
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  if (typeof req.body.pinned === 'boolean') {
    note.pinned = req.body.pinned;
  }
  writeJSON(NOTES_FILE, notes);
  res.json(note);
});

// Staff can delete their own notes; managers/admins can delete anyone's.
app.delete('/api/notes/:id', authenticate, (req, res) => {
  const notes = readJSON(NOTES_FILE, []);
  const note = notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  const isOwnNote = note.authorId === req.user.id;
  const canModerate = (ROLE_RANK[req.user.role] || 0) >= ROLE_RANK.manager;
  if (!isOwnNote && !canModerate) {
    return res.status(403).json({ error: 'You can only delete your own notes.' });
  }

  writeJSON(NOTES_FILE, notes.filter(n => n.id !== req.params.id));
  res.json({ ok: true });
});

// ---- Settings (board title only) — admin only to change ----
app.get('/api/settings', authenticate, (req, res) => {
  res.json(readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES' }));
});

app.post('/api/settings', authenticate, requireRole('admin'), (req, res) => {
  const { boardTitle } = req.body || {};
  const current = readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES' });
  const updated = {
    boardTitle: boardTitle !== undefined ? String(boardTitle).slice(0, 80) : current.boardTitle
  };
  writeJSON(SETTINGS_FILE, updated);
  res.json(updated);
});

// ---- Reservations (daily screenshot -> structured table) ----
function todayStr() {
  // YYYY-MM-DD in the restaurant's own timezone, so "today" matches what
  // staff actually mean, not the server's UTC day.
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function readReservations() {
  const data = readJSON(RESERVATIONS_FILE, { date: todayStr(), reservations: [] });
  // Roll over to a fresh empty list as soon as a new day starts, whether or
  // not anything else has touched the file yet.
  if (data.date !== todayStr()) {
    return { date: todayStr(), reservations: [] };
  }
  return data;
}

async function extractReservationsFromImage(imageBase64, mediaType) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the backend.');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: 'Extract every reservation visible in this restaurant reservations screenshot. ' +
              'Return ONLY a JSON array, no prose, no markdown code fences. Each item: ' +
              '{"time": string, "name": string, "partySize": number or null, "allergies": string, "specialInfo": string}. ' +
              '"allergies" is ONLY food allergies and dietary restrictions (e.g. "peanut allergy", "gluten-free", "vegan"). ' +
              '"specialInfo" is everything else worth knowing — special occasions, seating requests, VIP notes, server requests, etc. ' +
              'Use "" or null for anything not visible. Return [] if no reservations are visible.'
          }
        ]
      }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vision request failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text returned from the vision model.');

  const cleaned = textBlock.text.trim()
    .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { throw new Error('Could not read reservation data from that image — try a clearer screenshot.'); }
  if (!Array.isArray(parsed)) throw new Error('Unexpected response format from the vision model.');
  return parsed;
}

app.get('/api/reservations', authenticate, (req, res) => {
  res.json(readReservations());
});

// Managers and admins only — each upload is a paid API call, so this stays
// deliberate rather than something anyone can trigger repeatedly.
app.post('/api/reservations/upload', authenticate, requireRole('manager'), async (req, res) => {
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: 'imageBase64 and mediaType are required.' });
  }
  try {
    const extracted = await extractReservationsFromImage(imageBase64, mediaType);
    const current = readReservations();
    const withMeta = extracted.map(r => ({
      id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7),
      time: r.time || '',
      name: r.name || '',
      partySize: typeof r.partySize === 'number' ? r.partySize : null,
      allergies: r.allergies || '',
      specialInfo: r.specialInfo || '',
      uploadedBy: req.user.name,
      uploadedAt: new Date().toISOString()
    }));
    current.reservations = current.reservations.concat(withMeta);
    current.date = todayStr();
    writeJSON(RESERVATIONS_FILE, current);
    res.json(current);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Any signed-in staff can correct or add allergy/special-info details as
// they learn them through the shift — this isn't gated to managers since
// it's just editing text, not triggering a paid API call.
app.patch('/api/reservations/:id', authenticate, (req, res) => {
  const current = readReservations();
  const reservation = current.reservations.find(r => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found (it may have rolled over to a new day).' });

  if (typeof req.body.allergies === 'string') reservation.allergies = req.body.allergies.slice(0, 300);
  if (typeof req.body.specialInfo === 'string') reservation.specialInfo = req.body.specialInfo.slice(0, 300);

  writeJSON(RESERVATIONS_FILE, current);
  res.json(reservation);
});

app.delete('/api/reservations', authenticate, requireRole('admin'), (req, res) => {
  const cleared = { date: todayStr(), reservations: [] };
  writeJSON(RESERVATIONS_FILE, cleared);
  res.json(cleared);
});

// ---- Digest building + sending ----
const CATEGORY_COLORS = {
  'General': '#4C6B8A',
  'Repairs and Maintenance': '#B5592B',
  'Service': '#2F6F62',
  'Food and Beverage': '#B98A1F',
  'Upcoming Events': '#7A4B6B'
};

function sortForDigest(catNotes) {
  return catNotes.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return new Date(b.ts) - new Date(a.ts);
  });
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain-text fallback for email clients that don't render HTML.
function buildDigestText(notes, boardTitle) {
  const now = new Date();
  let out = `${boardTitle}\n`;
  out += `Nightly digest — ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}\n`;
  out += '='.repeat(40) + '\n\n';
  CATEGORIES.forEach(cat => {
    const catNotes = sortForDigest(notes.filter(n => n.category === cat));
    out += `${cat.toUpperCase()}\n${'-'.repeat(cat.length)}\n`;
    if (catNotes.length === 0) {
      out += 'No notes\n\n';
    } else {
      catNotes.forEach(n => {
        const t = new Date(n.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const pin = n.pinned ? '[PINNED] ' : '';
        out += `${pin}[${t}] ${n.author} (${n.tag}): ${n.message}\n`;
      });
      out += '\n';
    }
  });
  return out;
}

// HTML version — mirrors the board's category cards, using inline styles
// since most email clients strip <style> blocks.
function buildDigestHtml(notes, boardTitle) {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const categoryBlocks = CATEGORIES.map(cat => {
    const color = CATEGORY_COLORS[cat] || '#333333';
    const catNotes = sortForDigest(notes.filter(n => n.category === cat));

    const rows = catNotes.length === 0
      ? `<tr><td style="padding:14px;font-size:13px;color:#999999;font-style:italic;font-family:Arial,Helvetica,sans-serif;">No notes</td></tr>`
      : catNotes.map(n => {
          const t = new Date(n.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          const pin = n.pinned ? '📌 ' : '';
          const rowBg = n.pinned ? '#FBF6E9' : '#ffffff';
          const tagColor = n.tag === 'Urgent' ? '#A4302A' : n.tag === 'Resolved' ? '#5C6650' : color;
          return `
            <tr>
              <td style="padding:12px 14px;border-bottom:1px solid #eeeeee;background:${rowBg};font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:11px;color:#888888;margin-bottom:4px;">
                  ${pin}<strong style="color:#222222;">${esc(n.author)}</strong>
                  &nbsp;·&nbsp;
                  <span style="display:inline-block;padding:1px 7px;border-radius:20px;background:${tagColor};color:#ffffff;font-size:9.5px;text-transform:uppercase;letter-spacing:0.04em;">${esc(n.tag)}</span>
                  &nbsp;·&nbsp; ${t}
                </div>
                <div style="font-size:14px;color:#222222;line-height:1.45;">${esc(n.message)}</div>
              </td>
            </tr>`;
        }).join('');

    return `
      <tr><td style="padding:18px 0 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e2da;border-radius:4px;overflow:hidden;">
          <tr>
            <td style="background:${color};color:#ffffff;padding:9px 14px;font-family:Georgia,'Times New Roman',serif;font-size:16px;letter-spacing:0.02em;text-transform:uppercase;">
              ${esc(cat)}
            </td>
          </tr>
          ${rows}
        </table>
      </td></tr>`;
  }).join('');

  return `
<div style="background:#EDEAE2;padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:4px;overflow:hidden;border:1px solid #e5e2da;">
    <tr>
      <td style="background:#1F1E1B;color:#FBFAF6;padding:22px 24px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;letter-spacing:0.02em;">${esc(boardTitle)}</div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#C9C6BC;text-transform:uppercase;letter-spacing:0.06em;margin-top:3px;">Nightly Digest &middot; ${dateStr}</div>
      </td>
    </tr>
    <tr><td style="padding:4px 18px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${categoryBlocks}
      </table>
    </td></tr>
  </table>
</div>`;
}

async function sendViaResend(to, subject, html, text) {
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
      html,
      text
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

// Anyone with notifications on gets the digest — no admin-managed list needed.
async function getNotificationRecipients() {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('email')
    .eq('notifications_enabled', true);
  if (error) {
    console.error('[digest] could not load recipients from Supabase:', error.message);
    return [];
  }
  return (data || []).map(p => p.email).filter(Boolean);
}

async function runDigest() {
  const notes = readJSON(NOTES_FILE, []);
  const settings = readJSON(SETTINGS_FILE, { boardTitle: '620 NOTES' });
  const recipients = await getNotificationRecipients();
  const subject = `${settings.boardTitle} — Nightly Digest, ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const html = buildDigestHtml(notes, settings.boardTitle);
  const text = buildDigestText(notes, settings.boardTitle);

  const results = { sent: [], failed: [] };
  for (const to of recipients) {
    try {
      await sendViaResend(to, subject, html, text);
      results.sent.push(to);
    } catch (e) {
      results.failed.push({ to, error: e.message });
    }
  }

  if (results.sent.length > 0 && CLEAR_AFTER_SEND) {
    const archiveFile = path.join(DATA_DIR, `archive-${new Date().toISOString().slice(0, 10)}.json`);
    writeJSON(archiveFile, notes);
    // Pinned notes survive the nightly clear — they stay until someone unpins them.
    writeJSON(NOTES_FILE, notes.filter(n => n.pinned));
  }

  console.log(`[digest] sent to ${results.sent.length}, failed for ${results.failed.length}`);
  return results;
}

// Manual trigger — admin only, handy for testing before trusting the schedule.
app.post('/api/send-digest', authenticate, requireRole('admin'), async (req, res) => {
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
  console.log(`620 Notes backend running on port ${PORT}`);
  console.log(`Nightly digest scheduled: "${DIGEST_CRON}" (${TZ})`);
});
