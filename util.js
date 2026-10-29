const { db, FieldValue } = require('./firebase');

const CONSENT_VERSION = '2026-10-29';
const CONSENT_ITEMS = ['ownership', 'data_processing', 'risk_and_law'];

const DEFAULTS = {
  price: '5',
  currency: 'USD',
  premium_days: '30',
  free_daily_limit: '15',
  bank_name: 'Your Bank Name',
  account_number: '0000000000',
  account_name: 'Your Account Name',
  payment_instructions: 'Transfer the exact amount, then submit your transaction reference below. Premium is activated after we confirm the payment.'
};
const DEFAULT_KEYS = Object.keys(DEFAULTS);

const isPremium = (u) => u.plan === 'premium' && u.premium_until > Date.now();

let cache = null, cacheAt = 0;
async function getSettings() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const s = await db.collection('settings').doc('app').get();
  cache = { ...DEFAULTS, ...(s.exists ? s.data() : {}) };
  cacheAt = Date.now();
  return cache;
}
const clearSettingsCache = () => { cache = null; };

async function getUser(uid) {
  const s = await db.collection('users').doc(uid).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    plan: isPremium(u) ? 'premium' : 'free',
    premium_until: isPremium(u) ? u.premium_until : null,
    banned: !!u.banned, created_at: u.created_at
  };
}

async function activeConsent(uid) {
  const s = await db.collection('consents')
    .where('user_id', '==', uid).where('revoked_at', '==', null).where('version', '==', CONSENT_VERSION).limit(1).get();
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}

const dayKey = () => new Date().toISOString().slice(0, 10);
const usageRef = (uid) => db.collection('usage').doc(`${uid}_${dayKey()}`);

async function repliesToday(uid) {
  const s = await usageRef(uid).get();
  return s.exists ? s.data().count || 0 : 0;
}
const incrementReplies = (uid) =>
  usageRef(uid).set({ user_id: uid, day: dayKey(), count: FieldValue.increment(1) }, { merge: true });

module.exports = {
  CONSENT_VERSION, CONSENT_ITEMS, DEFAULT_KEYS, dayKey,
  isPremium, getSettings, clearSettingsCache, getUser, publicUser, activeConsent, repliesToday, incrementReplies
};
