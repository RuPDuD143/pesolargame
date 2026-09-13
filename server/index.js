// server/index.js
//
// This is a plain always-on Express server that does exactly what
// functions/index.js used to do, minus anything that required the paid
// Blaze plan (Cloud Functions, Cloud Tasks). It talks to the same
// Firestore project via the Admin SDK, so nothing about your database,
// security rules, or game data changes - only where the backend code
// runs.
//
// Deploy this folder somewhere with a free tier for long-running Node
// servers (Render, Fly.io, Railway, etc.) - see the README for the
// exact click path on Render.

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const chain = require('./lib/chain');
const { computeEnergyStatus } = require('./lib/energy');
const { requestLoginNonce, verifyLogin } = require('./lib/verify-signature');
const nodeManager = require('./lib/node-manager');
const { ORE_ASSET_IDS } = require('./lib/ore-asset-ids');
const { LOCATIONS } = require('./lib/ore-config');
const { startRespawnSweep, startNodeReconcileSweep, runSweepIfDue } = require('./lib/respawn-sweep');

// ---------------------------------------------------------------------
// Firebase Admin init - reads the FULL service account JSON from an env
// var (paste it as-is in Render's dashboard), so there's no file to
// keep track of on disk.
//
// Note: firebase-admin v12+ dropped the old namespaced API
// (admin.credential.cert, admin.firestore(), admin.auth()) - this uses
// the current modular API instead.
// ---------------------------------------------------------------------

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_JSON env var - see server/.env.example');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({
  credential: cert(serviceAccount),
  projectId: serviceAccount.project_id
});
const db = getFirestore();
const auth = getAuth();

// [TEMPORARY] DEMO MODE - see the matching block in server/lib/node-manager.js.
if (process.env.DEMO_MODE === 'true') {
  console.warn('[DEMO MODE] resources pinned to 1,000,000 for node spawning - set DEMO_MODE=false (or unset it) to restore the real economy.');
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ---------------------------------------------------------------------
// Auth middleware: verifies a Firebase ID token (the client gets one
// automatically after signInWithCustomToken - see public/js/wallet.js).
// This replaces the automatic request.auth that onCall() used to give
// us for free.
// ---------------------------------------------------------------------

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'missing_id_token' });
    const decoded = await auth.verifyIdToken(idToken);
    req.account = decoded.uid; // uid === WAX account name (see verifyLoginAndMintToken below)
    next();
  } catch (err) {
    console.error('auth check failed:', err.message);
    res.status(401).json({ error: 'invalid_id_token' });
  }
}

/** Every protected route also checks the token owner matches the account it's acting on. */
function requireClaimedAccount(req, res, claimedAccount) {
  if (req.account !== claimedAccount) {
    res.status(403).json({ error: 'account_mismatch' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// AUTH: WAX login proof -> Firebase custom token
// ---------------------------------------------------------------------

app.post('/requestNonce', async (req, res) => {
  try {
    const { account } = req.body || {};
    if (!account) return res.status(400).json({ error: 'account_required' });
    const nonce = await requestLoginNonce(db, account);
    res.json({ nonce });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/verifyLoginAndMintToken', async (req, res) => {
  const { account, nonce, transaction, signatures, chainId } = req.body || {};
  try {
    await verifyLogin(db, { account, nonce, transaction, signatures, chainId });
  } catch (err) {
    console.error('login verification failed:', err.message);
    return res.status(403).json({ error: 'signature_verification_failed' });
  }
  try {
    const customToken = await auth.createCustomToken(account);
    res.json({ customToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------
// WORKER STATUS / WAKE
// ---------------------------------------------------------------------

app.get('/getWorkerStatus', requireAuth, async (req, res) => {
  try {
    const account = req.query.account;
    if (!requireClaimedAccount(req, res, account)) return;

    const contractRow = await chain.getContractWorker(account);
    if (!contractRow) return res.json({ registered: false });

    const energyMax = Number(contractRow.energy_max);
    const ref = db.collection('workers').doc(account);
    let snap = await ref.get();

    if (!snap.exists) {
      const fresh = {
        energy: energyMax,
        lastrest: Timestamp.now(),
        isresting: false,
        coins: 0
      };
      await ref.set(fresh);
      snap = await ref.get();
    }

    const status = computeEnergyStatus(snap.data(), energyMax);
    res.json({
      registered: true,
      energyMax,
      isResting: status.isResting,
      currentEnergy: status.currentEnergy,
      secondsElapsed: status.secondsElapsed,
      coins: snap.data().coins
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/wakeWorker', requireAuth, async (req, res) => {
  try {
    const { account } = req.body || {};
    if (!requireClaimedAccount(req, res, account)) return;

    const contractRow = await chain.getContractWorker(account);
    if (!contractRow) return res.status(412).json({ error: 'not_registered' });
    const energyMax = Number(contractRow.energy_max);

    const ref = db.collection('workers').doc(account);
    const snap = await ref.get();
    if (!snap.exists) return res.status(412).json({ error: 'no_worker_row' });

    const status = computeEnergyStatus(snap.data(), energyMax);
    await ref.update({
      energy: status.currentEnergy,
      isresting: false,
      lastrest: Timestamp.now()
    });

    res.json({ registered: true, energyMax, isResting: false, currentEnergy: status.currentEnergy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------
// MINING: strike a node
// ---------------------------------------------------------------------

const MAX_THROW_DISTANCE = 200; // px, unchanged

app.post('/throwPickaxe', requireAuth, async (req, res) => {
  try {
    const { account, locationId, nodeId, charX, charY, targetX, targetY } = req.body || {};
    if (!requireClaimedAccount(req, res, account)) return;
    if (!(locationId in LOCATIONS)) return res.status(400).json({ error: 'bad_location' });

    const dx = targetX - charX;
    const dy = targetY - charY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(dist, MAX_THROW_DISTANCE);
    const angle = Math.atan2(dy, dx);
    const finalX = charX + Math.cos(angle) * clampedDist;
    const finalY = charY + Math.sin(angle) * clampedDist;

    await db.collection('locations').doc(String(locationId)).collection('throws').add({
      account,
      fromX: charX,
      fromY: charY,
      toX: finalX,
      toY: finalY,
      nodeId: nodeId || null,
      createdAt: FieldValue.serverTimestamp()
    });

    if (!nodeId) return res.json({ struck: false }); // empty-ground throw, animation only - no energy spent

    // Every actual strike attempt costs 1 energy - this was previously
    // never deducted anywhere, so energy just sat frozen at whatever
    // getWorkerStatus/wakeWorker last wrote no matter how much mining
    // happened. Charged only once we know it's landing on a still-active
    // node (see the `!result` check below) - a miss on an already-mined
    // node shouldn't cost anything.
    const workerRef = db.collection('workers').doc(account);
    const workerSnap = await workerRef.get();
    if (!workerSnap.exists) return res.status(412).json({ error: 'no_worker_row' });
    const currentEnergy = workerSnap.data().energy || 0;
    if (currentEnergy <= 0) return res.status(400).json({ error: 'no_energy' });

    const result = await nodeManager.strikeNodeTx(db, locationId, nodeId, account);
    if (!result) return res.json({ struck: false }); // already depleted by someone else - no energy spent on a miss

    const newEnergy = currentEnergy - 1;
    await workerRef.update({ energy: FieldValue.increment(-1) });

    if (!result.depleted) {
      return res.json({ struck: true, depleted: false, strikesRemaining: result.strikesRemaining, energy: newEnergy });
    }

    // Node depleted on this strike: credit the winner and bump world state.
    await db.runTransaction(async (tx) => {
      const sysdataRef = db.collection('sysdata').doc('main');
      const invRef = db.collection('workers').doc(account).collection('inventory').doc(result.oreType);

      // Firestore transactions require ALL reads before ANY writes -
      // both gets have to happen first, then both writes below.
      const [sysSnap, invSnap] = await Promise.all([tx.get(sysdataRef), tx.get(invRef)]);

      tx.update(sysdataRef, {
        minedResources: (sysSnap.data().minedResources || 0) + result.value,
        lastUpdated: FieldValue.serverTimestamp()
      });

      const currentAmount = invSnap.exists ? invSnap.data().amount : 0;
      tx.set(invRef, {
        assetId: ORE_ASSET_IDS[result.oreType],
        itemName: result.oreType,
        classification: 'ores',
        amount: currentAmount + 1
      });
    });

    // No Cloud Tasks call needed here: strikeNodeTx already stamped
    // respawnAtMs on the node doc, and the always-on respawn sweep
    // (started below) picks it up within about 5 minutes.

    res.json({ struck: true, depleted: true, oreType: result.oreType, value: result.value, energy: newEnergy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------
// MAINTENANCE: visit this URL any time to (re)populate mining nodes -
// tops up any location short of NODE_SLOTS_PER_LOCATION nodes, respawns
// anything depleted and due, and rerolls any active node that's grown
// too valuable for the mine's current resources budget. Safe to visit as
// often as you like; the hourly sweep (below) also calls this same
// function automatically.
// ---------------------------------------------------------------------

app.get('/seedLocations', async (req, res) => {
  try {
    const sysSnap = await db.collection('sysdata').doc('main').get();
    if (!sysSnap.exists) {
      return res
        .status(412)
        .send('sysdata/main doc missing - create it first in the Firestore console with { resources: <int>, minedResources: 0 }');
    }
    await nodeManager.reconcileAllLocations(db, sysSnap.data());
    res.status(200).send('ok - mining nodes reconciled');
  } catch (err) {
    console.error(err);
    res.status(500).send('error');
  }
});

// ---------------------------------------------------------------------
// This is the "cave refresh" the client's H:MM:SS countdown is counting
// down to (see public/js/mining.js) - it reads sysdata/main.lastSweep and
// calls this the moment the countdown reaches zero. Unlike /seedLocations
// above (an unconditional manual admin override), this one only actually
// does anything once an hour has genuinely passed since the last sweep -
// see runSweepIfDue()'s Firestore transaction for how that's enforced
// even if several people's countdowns hit zero at once. Safe to expose
// publicly and to call as often as the client likes; it's a cheap no-op
// the rest of the time. Add ?force=true to bypass the due-check (still
// does the real chain-sync + reconcile) for testing without waiting an hour.
// ---------------------------------------------------------------------

app.post('/runSweep', async (req, res) => {
  try {
    const force = req.query.force === 'true' || (req.body && req.body.force === true);
    const result = await runSweepIfDue(db, { force });
    res.json(result);
  } catch (err) {
    console.error('runSweep failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET alias purely so you can trigger this by pasting a URL into a
// browser address bar while testing (a plain GET is what a browser does
// by default; the client always uses the POST above). Same handler,
// same ?force=true support.
app.get('/runSweep', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const result = await runSweepIfDue(db, { force });
    res.json(result);
  } catch (err) {
    console.error('runSweep failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------
// Read-only diagnostic - hit this in a browser or with curl any time to
// see, without waiting for a sweep or digging through Render's logs:
// what the chain RPC call for sysdata is actually returning right now,
// what table/scope/key it's using to ask (in case CONTRACT_SYSDATA_TABLE/
// SCOPE/KEY need adjusting), and what's currently sitting in Firestore.
// If chainRow comes back null with no chainError, the RPC call succeeded
// but found no row at that table/scope/key - the guessed scope/key in
// chain.js is wrong for this contract and needs an env var override.
// ---------------------------------------------------------------------

app.get('/debugSysdata', async (req, res) => {
  try {
    const sysSnap = await db.collection('sysdata').doc('main').get();
    const firestoreSysdata = sysSnap.exists ? sysSnap.data() : null;

    let chainRow = null;
    let chainError = null;
    try {
      chainRow = await chain.getContractSysdata();
    } catch (err) {
      chainError = err.message;
    }

    res.json({
      firestoreSysdata,
      chainRow,
      chainError,
      chainQuery: {
        code: chain.CONTRACT_NAME,
        table: chain.SYSDATA_TABLE,
        scope: chain.SYSDATA_SCOPE,
        keyCandidatesTried: chain.SYSDATA_KEY_CANDIDATES
      }
    });
  } catch (err) {
    console.error('debugSysdata failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/', (req, res) => res.send('Pesolar backend is running.'));

// Two always-on sweeps - replaces Cloud Tasks entirely (see
// lib/respawn-sweep.js for why this is fine on a persistent server, and
// for why there are two of them instead of one).
startRespawnSweep(db);
startNodeReconcileSweep(db);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pesolar backend listening on port ${PORT}`));
