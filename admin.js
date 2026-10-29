const express = require('express');
const { db, auth } = require('./firebase');
const wa = require('./whatsapp');
const { requireAuth, requireAdmin } = require('./auth');
const { removeUser } = require('./users');
const U = require('./util');

const r = express.Router();
r.use(requireAuth, requireAdmin);
const ah = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message || 'Request failed.' }));
const fail = (m) => { throw new Error(m); };
const DAY = 86400e3;

async function target(req) {
  const u = await U.getUser(req.params.id);
  if (!u) fail('User not found.');
  return u;
}
const count = async (q) => (await q.count().get()).data().count;

r.get('/stats', ah(async (req, res) => {
  const now = Date.now();
  const [users, premium, banned, connected, pending, todaySnap, paidSnap] = await Promise.all([
    count(db.collection('users')),
    count(db.collection('users').where('premium_until', '>', now)),
    count(db.collection('users').where('banned', '==', true)),
    count(db.collection('wa_accounts').where('status', '==', 'connected')),
    count(db.collection('payments').where('status', '==', 'pending')),
    db.collection('usage').where('day', '==', U.dayKey()).get(),
    db.collection('payments').where('status', '==', 'confirmed').get()
  ]);
  const revenue = {};
  paidSnap.forEach((d) => { const p = d.data(); revenue[p.currency] = (revenue[p.currency] || 0) + p.amount; });
  res.json({
    users, premium, banned, connected, pending_payments: pending,
    replies_today: todaySnap.docs.reduce((n, d) => n + (d.data().count || 0), 0),
    revenue: Object.entries(revenue).map(([currency, total]) => ({ currency, total }))
  });
}));

r.get('/users', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const snap = await db.collection('users').orderBy('created_at', 'desc').limit(500).get();
  const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((u) => !q || u.email.includes(q) || (u.name || '').toLowerCase().includes(q)).slice(0, 200);
  const accs = users.length ? await db.getAll(...users.map((u) => db.collection('wa_accounts').doc(u.id))) : [];
  res.json(users.map((u, i) => {
    const a = accs[i].exists ? accs[i].data() : {};
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, plan: U.isPremium(u) ? 'premium' : 'free',
      premium_until: u.premium_until, banned: !!u.banned, ban_reason: u.ban_reason, created_at: u.created_at,
      wa_status: a.status || 'idle', phone: a.phone || null
    };
  }));
}));

r.post('/users/:id/ban', ah(async (req, res) => {
  const u = await target(req);
  if (u.role === 'admin') fail('You cannot ban an admin.');
  const banned = !!req.body.banned;
  await db.collection('users').doc(u.id).update({ banned, ban_reason: banned ? String(req.body.reason || '').slice(0, 200) : null });
  try {
    await auth.updateUser(u.id, { disabled: banned });
    if (banned) await auth.revokeRefreshTokens(u.id);
  } catch {}
  if (banned) await wa.stop(u.id); // stop replying immediately
  res.json({ ok: true });
}));

r.post('/users/:id/plan', ah(async (req, res) => {
  const u = await target(req);
  const ref = db.collection('users').doc(u.id);
  if (req.body.plan === 'premium') {
    const days = Math.max(1, Math.min(3650, parseInt(req.body.days, 10) || 30));
    const base = Math.max(Date.now(), u.premium_until || 0);
    await ref.update({ plan: 'premium', premium_until: base + days * DAY });
  } else {
    await ref.update({ plan: 'free', premium_until: 0 });
  }
  res.json({ ok: true });
}));

r.post('/users/:id/disconnect', ah(async (req, res) => {
  const u = await target(req);
  await wa.stop(u.id, { logout: true, wipe: true });
  res.json({ ok: true });
}));

r.delete('/users/:id', ah(async (req, res) => {
  const u = await target(req);
  if (u.role === 'admin') fail('You cannot delete an admin.');
  await removeUser(u.id);
  res.json({ ok: true });
}));

r.get('/payments', ah(async (req, res) => {
  const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const snap = await (status ? db.collection('payments').where('status', '==', status) : db.collection('payments')).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.created_at - a.created_at).slice(0, 200);
  const ids = [...new Set(rows.map((p) => p.user_id))];
  const users = ids.length ? await db.getAll(...ids.map((id) => db.collection('users').doc(id))) : [];
  const byId = Object.fromEntries(users.filter((d) => d.exists).map((d) => [d.id, d.data()]));
  res.json(rows.map((p) => ({ ...p, email: (byId[p.user_id] || {}).email || '(deleted)', name: (byId[p.user_id] || {}).name || '' })));
}));

r.post('/payments/:id/confirm', ah(async (req, res) => {
  const days = parseInt((await U.getSettings()).premium_days, 10) || 30;
  const pRef = db.collection('payments').doc(req.params.id);
  await db.runTransaction(async (t) => {
    const p = await t.get(pRef);
    if (!p.exists) fail('Payment not found.');
    if (p.data().status !== 'pending') fail('This payment was already handled.');
    const uRef = db.collection('users').doc(p.data().user_id);
    const u = await t.get(uRef);
    if (!u.exists) fail('The user no longer exists.');
    const base = Math.max(Date.now(), u.data().premium_until || 0);
    t.update(uRef, { plan: 'premium', premium_until: base + days * DAY });
    t.update(pRef, { status: 'confirmed', decided_at: Date.now() });
  });
  res.json({ ok: true });
}));

r.post('/payments/:id/reject', ah(async (req, res) => {
  const ref = db.collection('payments').doc(req.params.id);
  const p = await ref.get();
  if (!p.exists || p.data().status !== 'pending') fail('Payment not found or already handled.');
  await ref.update({ status: 'rejected', decided_at: Date.now() });
  res.json({ ok: true });
}));

r.get('/settings', ah(async (req, res) => res.json(await U.getSettings())));

r.post('/settings', ah(async (req, res) => {
  const update = {};
  for (const k of U.DEFAULT_KEYS) {
    if (!(k in req.body)) continue;
    let v = String(req.body[k]).trim().slice(0, 500);
    if (['price', 'premium_days', 'free_daily_limit'].includes(k) && (v === '' || !(Number(v) >= 0))) fail(`"${k}" must be a number.`);
    if (k === 'currency') v = v.toUpperCase().slice(0, 5);
    update[k] = v;
  }
  await db.collection('settings').doc('app').set(update, { merge: true });
  U.clearSettingsCache();
  res.json({ ok: true });
}));

module.exports = r;
