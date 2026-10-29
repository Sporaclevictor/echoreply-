const express = require('express');
const { db } = require('./firebase');
const wa = require('./whatsapp');
const { requireToken, requireAuth } = require('./auth');
const { removeUser } = require('./users');
const U = require('./util');

const r = express.Router();
const ah = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message || 'Request failed.' }));
const fail = (msg) => { throw new Error(msg); };
const accRef = (uid) => db.collection('wa_accounts').doc(uid);
const DEFAULT_ACC = { phone: null, status: 'idle', auto_reply: true, disclosure: true, persona: '', style_samples: [], connected_at: null };

async function ensureAccount(uid) {
  const s = await accRef(uid).get();
  if (!s.exists) await accRef(uid).set(DEFAULT_ACC);
}

/* ---------- public ---------- */
r.get('/config', ah(async (req, res) => {
  const s = await U.getSettings();
  res.json({
    price: Number(s.price), currency: s.currency, premium_days: Number(s.premium_days),
    free_daily_limit: Number(s.free_daily_limit), consent_version: U.CONSENT_VERSION,
    app_name: 'Echoreply'
  });
}));

/* ---------- account creation (after Firebase Auth sign-up) ---------- */
r.post('/auth/init', requireToken, ah(async (req, res) => {
  const { uid, email } = req.fb;
  if (!email) fail('Your sign-in has no email address.');
  if (!req.body.accept_terms) fail('Accept the Terms and Privacy Policy to continue.');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) fail('Enter your name.');
  const ref = db.collection('users').doc(uid);
  if (!(await ref.get()).exists) {
    // Role is never taken from the client: everyone starts as a regular user.
    await ref.set({ email: email.toLowerCase(), name, role: 'user', plan: 'free', premium_until: 0, banned: false, ban_reason: null, created_at: Date.now(), terms_accepted_at: Date.now() });
  }
  res.json({ ok: true });
}));

/* ---------- everything below needs a signed-in, non-banned user ---------- */
r.use(requireAuth);

r.get('/me', ah(async (req, res) => {
  const u = req.user;
  const [accSnap, s, consent, today] = await Promise.all([accRef(u.id).get(), U.getSettings(), U.activeConsent(u.id), U.repliesToday(u.id)]);
  const acc = accSnap.exists ? accSnap.data() : DEFAULT_ACC;
  res.json({
    user: U.publicUser(u),
    consent: !!consent,
    wa: {
      ...wa.state(u.id),
      phone: acc.phone,
      auto_reply: !!acc.auto_reply,
      disclosure: !!acc.disclosure,
      persona: acc.persona || '',
      samples: (acc.style_samples || []).length
    },
    usage: { replies_today: today, free_daily_limit: Number(s.free_daily_limit) }
  });
}));

r.post('/consent', ah(async (req, res) => {
  const accepted = Array.isArray(req.body.items) ? req.body.items : [];
  if (!U.CONSENT_ITEMS.every((i) => accepted.includes(i))) fail('Please tick every box to give your consent.');
  if (req.body.version !== U.CONSENT_VERSION) fail('The consent text changed. Reload the page and try again.');
  await db.collection('consents').add({
    user_id: req.user.id, version: U.CONSENT_VERSION, items: U.CONSENT_ITEMS,
    ip: req.ip, user_agent: String(req.get('user-agent') || '').slice(0, 250),
    created_at: Date.now(), revoked_at: null
  });
  res.json({ ok: true });
}));

// Withdrawing consent disconnects WhatsApp and deletes the stored session and style data.
r.delete('/consent', ah(async (req, res) => {
  const snap = await db.collection('consents').where('user_id', '==', req.user.id).where('revoked_at', '==', null).get();
  await Promise.all(snap.docs.map((d) => d.ref.update({ revoked_at: Date.now() })));
  await wa.stop(req.user.id, { logout: true, wipe: true });
  await ensureAccount(req.user.id);
  await accRef(req.user.id).update({ style_samples: [], phone: null });
  res.json({ ok: true });
}));

/* ---------- WhatsApp ---------- */
r.post('/wa/connect', ah(async (req, res) => {
  if (!(await U.activeConsent(req.user.id))) fail('Give your consent before connecting WhatsApp.');
  await wa.start(req.user.id);
  res.json({ ok: true });
}));

r.post('/wa/disconnect', ah(async (req, res) => {
  await wa.stop(req.user.id, { logout: true, wipe: true });
  res.json({ ok: true });
}));

r.post('/wa/learn', ah(async (req, res) => {
  res.json({ samples: await wa.learn(req.user.id) });
}));

r.post('/wa/settings', ah(async (req, res) => {
  const premium = U.isPremium(req.user);
  await ensureAccount(req.user.id);
  const update = {};
  if ('auto_reply' in req.body) update.auto_reply = !!req.body.auto_reply;
  if ('persona' in req.body) {
    if (!premium) fail('Custom instructions are a Premium feature.');
    update.persona = String(req.body.persona).slice(0, 800);
  }
  if ('disclosure' in req.body) {
    if (!premium && !req.body.disclosure) fail('Turning off the automated-reply notice is a Premium feature.');
    update.disclosure = !!req.body.disclosure;
  }
  if (Object.keys(update).length) await accRef(req.user.id).update(update);
  res.json({ ok: true });
}));

/* ---------- payments (manual bank transfer) ---------- */
r.get('/payment-info', ah(async (req, res) => {
  const s = await U.getSettings();
  res.json({
    price: Number(s.price), currency: s.currency, premium_days: Number(s.premium_days),
    bank_name: s.bank_name, account_number: s.account_number, account_name: s.account_name,
    instructions: s.payment_instructions
  });
}));

async function userPayments(uid) {
  const snap = await db.collection('payments').where('user_id', '==', uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.created_at - a.created_at);
}

r.get('/payments', ah(async (req, res) => {
  const rows = await userPayments(req.user.id);
  res.json(rows.slice(0, 20).map(({ id, amount, currency, reference, status, created_at }) => ({ id, amount, currency, reference, status, created_at })));
}));

r.post('/payments', ah(async (req, res) => {
  const reference = String(req.body.reference || '').trim().slice(0, 80);
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (reference.length < 3) fail('Enter the transaction reference from your bank.');
  const mine = await userPayments(req.user.id);
  if (mine.filter((p) => p.status === 'pending').length >= 3) fail('You already have pending payments. Please wait for confirmation.');
  const s = await U.getSettings();
  await db.collection('payments').add({
    user_id: req.user.id, amount: Number(s.price), currency: s.currency,
    reference, note, status: 'pending', created_at: Date.now(), decided_at: null
  });
  res.json({ ok: true });
}));

/* ---------- account ---------- */
r.delete('/account', ah(async (req, res) => {
  if (req.user.role === 'admin') fail('Admin accounts cannot be deleted here.');
  await removeUser(req.user.id);
  res.json({ ok: true });
}));

module.exports = r;
