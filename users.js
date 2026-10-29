const { db, auth } = require('./firebase');
const wa = require('./whatsapp');

async function deleteWhere(col, uid) {
  const s = await db.collection(col).where('user_id', '==', uid).get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
}

/** Removes a user and everything stored about them. */
async function removeUser(uid) {
  await wa.stop(uid, { logout: true, wipe: true });
  for (const col of ['consents', 'payments', 'usage', 'optouts']) await deleteWhere(col, uid);
  await db.collection('wa_accounts').doc(uid).delete();
  await db.collection('users').doc(uid).delete();
  try { await auth.deleteUser(uid); } catch {}
}

module.exports = { removeUser };
