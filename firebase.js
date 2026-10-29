const admin = require('firebase-admin');

function init() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const cred = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  } else {
    // Uses GOOGLE_APPLICATION_CREDENTIALS or the platform's default credentials
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}
init();

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { admin, db, auth: admin.auth(), FieldValue: admin.firestore.FieldValue };
