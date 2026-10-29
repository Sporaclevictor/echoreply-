const { auth } = require('./firebase');
const { getUser } = require('./util');

async function requireToken(req, res, next) {
  try {
    const h = req.get('Authorization') || '';
    if (!h.startsWith('Bearer ')) throw new Error('no token');
    req.fb = await auth.verifyIdToken(h.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in.' });
  }
}

// Loads the profile on every request, so bans and plan changes apply instantly.
async function requireAuth(req, res, next) {
  requireToken(req, res, async () => {
    try {
      const user = await getUser(req.fb.uid);
      if (!user) return res.status(401).json({ error: 'Your account setup was not finished. Please register again.', code: 'no_profile' });
      if (user.banned) return res.status(403).json({ error: 'Your account has been suspended.' + (user.ban_reason ? ' Reason: ' + user.ban_reason : '') });
      req.user = user;
      next();
    } catch (e) {
      res.status(500).json({ error: 'Server error.' });
    }
  });
}

const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });

module.exports = { requireToken, requireAuth, requireAdmin };
