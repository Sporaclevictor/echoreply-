require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { db, auth } = require('./firebase');
const wa = require('./whatsapp');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

const origins = (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!origins.length) console.warn('FRONTEND_ORIGIN is not set: browsers will be blocked by CORS.');
app.use(cors({ origin: origins, allowedHeaders: ['Authorization', 'Content-Type'], methods: ['GET', 'POST', 'DELETE'] }));

app.use(express.json({ limit: '50kb' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api', require('./routes'));
app.use('/api/admin', require('./admin'));
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Create (or repair) the admin account from environment variables.
// ADMIN_PASSWORD is the source of truth and is re-applied on every start.
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account created.');
  let rec;
  try {
    rec = await auth.getUserByEmail(email);
    await auth.updateUser(rec.uid, { password, disabled: false });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    rec = await auth.createUser({ email, password, displayName: 'Admin', emailVerified: true });
  }
  const ref = db.collection('users').doc(rec.uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ email, name: 'Admin', role: 'admin', plan: 'free', premium_until: 0, banned: false, ban_reason: null, created_at: Date.now() });
  } else if (snap.data().role !== 'admin' || snap.data().banned) {
    await ref.update({ role: 'admin', banned: false });
  }
  console.log('Admin ready:', email);
}

const port = process.env.PORT || 3000;
const server = app.listen(port, async () => {
  console.log(`Echoreply worker listening on :${port}`);
  try { await bootstrapAdmin(); } catch (e) { console.error('Admin setup failed:', e.message); }
  wa.restoreAll().catch((e) => console.error('restore failed', e.message));
});

const quit = async () => { await wa.shutdown(); server.close(() => process.exit(0)); };
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
