const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { db } = require('./firebase');
const ai = require('./ai');
const { isPremium, getSettings, activeConsent, repliesToday, incrementReplies, getUser } = require('./util');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const WA_DIR = path.join(DATA_DIR, 'wa');
fs.mkdirSync(WA_DIR, { recursive: true });

const HASH_SECRET = process.env.HASH_SECRET;
if (!HASH_SECRET || HASH_SECRET.length < 16) {
  console.error('FATAL: set HASH_SECRET (16+ characters) in your environment.');
  process.exit(1);
}

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10', 10);
const sessions = new Map(); // uid -> { status, qr, error, client }
const cooldown = new Map(); // `${uid}:${contactHash}` -> { last, hourStart, hourCount, disclosedAt }

const accRef = (uid) => db.collection('wa_accounts').doc(uid);
const optRef = (uid, contact) => db.collection('optouts').doc(`${uid}_${contact}`);
const DEFAULT_ACC = { phone: null, status: 'idle', auto_reply: true, disclosure: true, persona: '', style_samples: [], connected_at: null };

const hash = (uid, jid) => crypto.createHash('sha256').update(HASH_SECRET + ':' + uid + ':' + jid).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureAccount(uid) {
  const s = await accRef(uid).get();
  if (!s.exists) await accRef(uid).set(DEFAULT_ACC);
}

async function setStatus(uid, status, phone) {
  await ensureAccount(uid);
  const data = { status };
  if (phone !== undefined) { data.phone = phone; data.connected_at = status === 'connected' ? Date.now() : null; }
  await accRef(uid).update(data);
}

function state(uid) {
  const s = sessions.get(uid);
  return s ? { status: s.status, qr: s.qr, error: s.error || null } : { status: 'idle', qr: null, error: null };
}

async function start(uid) {
  const existing = sessions.get(uid);
  if (existing && existing.status !== 'error') return;
  if (existing) await stop(uid);
  if (sessions.size >= MAX_SESSIONS) throw new Error('The service is at capacity right now. Please try again later.');

  const s = { status: 'starting', qr: null, error: null, client: null };
  sessions.set(uid, s);
  await setStatus(uid, 'starting');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'u' + uid, dataPath: WA_DIR }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });
  s.client = client;

  client.on('qr', async (qr) => { s.status = 'qr'; s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); });
  client.on('authenticated', () => { s.status = 'starting'; s.qr = null; });
  client.on('auth_failure', () => { s.status = 'error'; s.error = 'WhatsApp rejected the login. Please try again.'; });
  client.on('ready', async () => {
    s.status = 'connected';
    s.qr = null;
    const phone = client.info && client.info.wid ? client.info.wid.user : null;
    await setStatus(uid, 'connected', phone);
    const acc = (await accRef(uid).get()).data();
    if (!acc.style_samples || acc.style_samples.length === 0) learn(uid).catch(() => {});
  });
  client.on('disconnected', async () => {
    sessions.delete(uid);
    await setStatus(uid, 'idle', null).catch(() => {});
    client.destroy().catch(() => {});
  });
  client.on('message', (msg) => onMessage(uid, client, msg).catch((e) => console.error('[wa]', uid, e.message)));

  client.initialize().catch((e) => {
    console.error('[wa] init failed', uid, e.message);
    s.status = 'error';
    s.error = 'Could not start the WhatsApp session. Please try again.';
  });
}

async function stop(uid, { logout = false, wipe = false } = {}) {
  const s = sessions.get(uid);
  sessions.delete(uid);
  if (s && s.client) {
    try { if (logout && s.status === 'connected') await s.client.logout(); } catch {}
    try { await s.client.destroy(); } catch {}
  }
  if (wipe) fs.rmSync(path.join(WA_DIR, 'session-u' + uid), { recursive: true, force: true });
  if (await getUser(uid)) await setStatus(uid, 'idle', null);
}

/** Reads messages the owner wrote in recent chats, to learn their texting style. */
async function learn(uid) {
  const s = sessions.get(uid);
  if (!s || s.status !== 'connected') throw new Error('Connect WhatsApp first.');
  if (!(await activeConsent(uid))) throw new Error('Consent is required.');
  const chats = (await s.client.getChats()).filter((c) => !c.isGroup).slice(0, 15);
  const samples = [];
  for (const chat of chats) {
    try {
      const msgs = await chat.fetchMessages({ limit: 30 });
      for (const m of msgs) {
        if (m.fromMe && m.type === 'chat' && m.body && m.body.length > 1 && m.body.length < 300) samples.push(m.body);
      }
    } catch {}
    if (samples.length >= 120) break;
  }
  const unique = [...new Set(samples)].slice(-100);
  await ensureAccount(uid);
  await accRef(uid).update({ style_samples: unique });
  return unique.length;
}

async function onMessage(uid, client, msg) {
  if (msg.fromMe || msg.isStatus || msg.type !== 'chat' || !msg.body) return;
  if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;

  const [user, accSnap] = await Promise.all([getUser(uid), accRef(uid).get()]);
  if (!user || user.banned || !accSnap.exists) return;
  const acc = accSnap.data();
  if (!acc.auto_reply) return;
  if (!(await activeConsent(uid))) return;

  const premium = isPremium(user);
  const cfg = await getSettings();
  if (!premium && (await repliesToday(uid)) >= parseInt(cfg.free_daily_limit, 10)) return;

  const contact = hash(uid, msg.from);
  const lower = msg.body.trim().toLowerCase();

  if (lower === 'start') await optRef(uid, contact).delete();
  if (lower === 'stop') {
    await optRef(uid, contact).set({ user_id: uid, created_at: Date.now() });
    await client.sendMessage(msg.from, 'Got it. You will no longer get automatic replies here. Send START to turn them back on.');
    return;
  }
  if ((await optRef(uid, contact).get()).exists) return;

  // Per-contact throttling keeps the account behaving like a human.
  const key = uid + ':' + contact;
  const now = Date.now();
  const c = cooldown.get(key) || { last: 0, hourStart: now, hourCount: 0, disclosedAt: 0 };
  if (now - c.hourStart > 3600e3) { c.hourStart = now; c.hourCount = 0; }
  if (now - c.last < 8000 || c.hourCount >= 12) return;
  c.last = now; c.hourCount++;
  cooldown.set(key, c);

  const chat = await msg.getChat();
  const history = await chat.fetchMessages({ limit: premium ? 30 : 15 });
  const convo = history
    .filter((m) => m.type === 'chat' && m.body)
    .map((m) => ({ fromMe: m.fromMe, text: m.body.slice(0, 500) }));
  if (!convo.length) return;

  const reply = await ai.generateReply({
    ownerName: user.name,
    persona: premium ? acc.persona : '',
    samples: acc.style_samples || [],
    convo,
    premium
  });
  if (!reply) return;

  await chat.sendStateTyping();
  await sleep(2500 + Math.random() * 4500);

  let out = reply;
  if ((!premium || acc.disclosure) && now - c.disclosedAt > 24 * 3600e3) {
    out += `\n\n(Automated reply sent on behalf of ${user.name}. Send STOP to opt out.)`;
    c.disclosedAt = now;
  }
  await client.sendMessage(msg.from, out);
  await incrementReplies(uid);
}

/** Restores sessions that were connected before the worker restarted. */
async function restoreAll() {
  const snap = await db.collection('wa_accounts').where('status', 'in', ['connected', 'starting']).get();
  for (const d of snap.docs) {
    const uid = d.id;
    const u = await getUser(uid);
    if (!u || u.banned || !(await activeConsent(uid))) { await setStatus(uid, 'idle', null); continue; }
    start(uid).catch(() => {});
    await sleep(4000);
  }
}

async function shutdown() {
  for (const [, s] of sessions) { try { await s.client.destroy(); } catch {} }
}

module.exports = { start, stop, state, learn, restoreAll, shutdown };
