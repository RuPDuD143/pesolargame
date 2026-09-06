// functions/lib/nonces.js
//
// Short-lived, single-use nonces for the WAX login proof (see
// verify-signature.js for how they're consumed). Stored in Firestore so
// this works across multiple Cloud Functions instances.

const crypto = require('crypto');

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the login round trip

function nonceRef(db, account) {
  return db.collection('authNonces').doc(account);
}

async function issueNonce(db, account) {
  const nonce = crypto.randomBytes(16).toString('hex');
  await nonceRef(db, account).set({
    nonce,
    createdAtMs: Date.now(),
    used: false
  });
  return nonce;
}

/** Throws if the nonce doesn't match, is expired, or was already used. */
async function consumeNonce(db, account, providedNonce) {
  const ref = nonceRef(db, account);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('no_nonce_issued');
    const data = snap.data();
    if (data.used) throw new Error('nonce_already_used');
    if (Date.now() - data.createdAtMs > NONCE_TTL_MS) throw new Error('nonce_expired');
    if (data.nonce !== providedNonce) throw new Error('nonce_mismatch');
    tx.update(ref, { used: true });
  });
}

module.exports = { issueNonce, consumeNonce, NONCE_TTL_MS };
