// functions/index.js
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const chain = require('./lib/chain');
const { computeEnergyStatus } = require('./lib/energy');
const { requestLoginNonce, verifyLogin } = require('./lib/verify-signature');
const nodeManager = require('./lib/node-manager');
const { ORE_ASSET_IDS } = require('./lib/ore-asset-ids');
const { scheduleRespawn } = require('./lib/respawn-tasks');
const { LOCATIONS } = require('./lib/ore-config');

// ---------------------------------------------------------------------
// AUTH: WAX login proof -> Firebase custom token
// ---------------------------------------------------------------------

/** Step 1 of login: client asks for a nonce to sign. */
exports.requestNonce = onCall(async (request) => {
  const { account } = request.data || {};
  if (!account) throw new HttpsError('invalid-argument', 'account_required');
  const nonce = await requestLoginNonce(db, account);
  return { nonce };
});

/** Step 2 of login: client sends back the signed noop transaction. */
exports.verifyLoginAndMintToken = onCall(async (request) => {
  const { account, nonce, transaction, signatures, chainId } = request.data || {};
  try {
    await verifyLogin(db, { account, nonce, transaction, signatures, chainId });
  } catch (err) {
    console.error('login verification failed:', err.message);
    throw new HttpsError('permission-denied', 'signature_verification_failed');
  }
  const customToken = await admin.auth().createCustomToken(account);
  return { customToken };
});

/** Every other function calls this first - refuses to act on behalf of an unproven account. */
function requireAuthedAccount(request, claimedAccount) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'must_complete_login_proof_first');
  }
  if (request.auth.uid !== claimedAccount) {
    throw new HttpsError('permission-denied', 'account_mismatch');
  }
}

// ---------------------------------------------------------------------
// WORKER STATUS / REGISTRATION SYNC / WAKE
// ---------------------------------------------------------------------

exports.getWorkerStatus = onCall(async (request) => {
  const { account } = request.data || {};
  requireAuthedAccount(request, account);

  const contractRow = await chain.getContractWorker(account);
  if (!contractRow) return { registered: false };

  const energyMax = Number(contractRow.energy_max);
  const ref = db.collection('workers').doc(account);
  let snap = await ref.get();

  if (!snap.exists) {
    const fresh = {
      energy: energyMax,
      lastrest: admin.firestore.Timestamp.now(),
      isresting: false,
      coins: 0
    };
    await ref.set(fresh);
    snap = await ref.get();
  }

  const status = computeEnergyStatus(snap.data(), energyMax);
  return {
    registered: true,
    energyMax,
    isResting: status.isResting,
    currentEnergy: status.currentEnergy,
    secondsElapsed: status.secondsElapsed,
    coins: snap.data().coins
  };
});

exports.wakeWorker = onCall(async (request) => {
  const { account } = request.data || {};
  requireAuthedAccount(request, account);

  const contractRow = await chain.getContractWorker(account);
  if (!contractRow) throw new HttpsError('failed-precondition', 'not_registered');
  const energyMax = Number(contractRow.energy_max);

  const ref = db.collection('workers').doc(account);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'no_worker_row');

  const status = computeEnergyStatus(snap.data(), energyMax);
  await ref.update({ energy: status.currentEnergy, isresting: false, lastrest: admin.firestore.Timestamp.now() });

  return { registered: true, energyMax, isResting: false, currentEnergy: status.currentEnergy };
});

// ---------------------------------------------------------------------
// MINING: strike a node (replaces the old Socket.io 'throw-pickaxe' handler)
// ---------------------------------------------------------------------

const MAX_THROW_DISTANCE = 200; // px, unchanged from the socket version

exports.throwPickaxe = onCall(async (request) => {
  const { account, locationId, nodeId, charX, charY, targetX, targetY } = request.data || {};
  requireAuthedAccount(request, account);

  if (!(locationId in LOCATIONS)) throw new HttpsError('invalid-argument', 'bad_location');

  const dx = targetX - charX;
  const dy = targetY - charY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const clampedDist = Math.min(dist, MAX_THROW_DISTANCE);
  const angle = Math.atan2(dy, dx);
  const finalX = charX + Math.cos(angle) * clampedDist;
  const finalY = charY + Math.sin(angle) * clampedDist;

  // Broadcast the throw animation - clients listen for newly-added docs here.
  await db.collection('locations').doc(String(locationId)).collection('throws').add({
    account,
    fromX: charX,
    fromY: charY,
    toX: finalX,
    toY: finalY,
    nodeId: nodeId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  if (!nodeId) return { struck: false }; // empty-ground throw, animation only

  const result = await nodeManager.strikeNodeTx(db, locationId, nodeId, account);
  if (!result) return { struck: false }; // already depleted by someone else - not an error

  if (!result.depleted) {
    return { struck: true, depleted: false, strikesRemaining: result.strikesRemaining };
  }

  // Node depleted on this strike: credit the winner and bump world state.
  await db.runTransaction(async (tx) => {
    const sysdataRef = db.collection('sysdata').doc('main');
    const sysSnap = await tx.get(sysdataRef);
    tx.update(sysdataRef, {
      minedResources: (sysSnap.data().minedResources || 0) + result.value,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    const invRef = db.collection('workers').doc(account).collection('inventory').doc(result.oreType);
    const invSnap = await tx.get(invRef);
    const currentAmount = invSnap.exists ? invSnap.data().amount : 0;
    tx.set(invRef, {
      assetId: ORE_ASSET_IDS[result.oreType],
      itemName: result.oreType,
      classification: 'ores',
      amount: currentAmount + 1
    });
  });

  await scheduleRespawn({ locationId, nodeId, delayMs: 5000 });

  return { struck: true, depleted: true, oreType: result.oreType, value: result.value };
});

/** Invoked by Cloud Tasks ~5s after a depletion. Not client-callable (no auth check needed/possible on a task). */
exports.respawnNodeTask = onRequest(async (req, res) => {
  try {
    const { locationId, nodeId } = req.body || {};
    const sysSnap = await db.collection('sysdata').doc('main').get();
    await nodeManager.respawnNode(db, locationId, nodeId, sysSnap.data());
    res.status(200).send('ok');
  } catch (err) {
    console.error('respawnNodeTask failed:', err);
    res.status(500).send('error');
  }
});

// ---------------------------------------------------------------------
// MAINTENANCE: run once after first deploy (and once more per new location
// you add) to populate mining nodes. Call it manually - not on a schedule,
// since seedAllLocations is a no-op once nodes already exist.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// MAINTENANCE: visit this URL once in your browser after first deploy
// (and once more if you ever add a new location) to populate mining
// nodes. Safe to visit more than once - it's a no-op once nodes exist.
// Deliberately a plain HTTP endpoint (not an onCall) so it can be
// triggered by just pasting the URL into a browser address bar.
// ---------------------------------------------------------------------

exports.seedLocations = onRequest(async (req, res) => {
  const sysSnap = await db.collection('sysdata').doc('main').get();
  if (!sysSnap.exists) {
    res.status(412).send('sysdata/main doc missing - create it first in the Firestore console with { resources: <int>, minedResources: 0 }');
    return;
  }
  await nodeManager.seedAllLocations(db, sysSnap.data());
  res.status(200).send('ok - mining nodes seeded (or already existed)');
});
