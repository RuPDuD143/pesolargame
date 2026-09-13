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
const debugDump = require('./lib/debug-dump');
const miningSession = require('./lib/mining-session');
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
// Firestore's Admin SDK defaults to gRPC, which needs long-lived HTTP/2
// streaming connections. A lot of non-Google-Cloud hosts (Render,
// Railway, Fly.io, etc.) sit behind a proxy/load-balancer that silently
// drops or never properly completes that kind of connection - with no
// error on either end, just an indefinite hang. That matches exactly
// what /startMining was doing: every await up to and including
// miningSession.startSession()'s single Firestore .set() logged fine,
// then nothing, forever - a plain write should never take that long on
// its own. Forcing REST here trades a little streaming efficiency for a
// transport that works reliably through arbitrary HTTP proxies, which is
// the right tradeoff for a low-throughput game backend like this one.
db.settings({ preferRest: true });
const auth = getAuth();

// [TEMPORARY] DEMO MODE - see the matching block in server/lib/node-manager.js.
if (process.env.DEMO_MODE === 'true') {
  console.warn('[DEMO MODE] resources pinned to 1,000,000 for node spawning - set DEMO_MODE=false (or unset it) to restore the real economy.');
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// Minimal request/response logging - there was previously NOTHING logging
// incoming requests at all (no morgan, nothing), so a handler that hung
// forever was completely invisible from Render's log dashboard: no way to
// tell "never arrived" from "arrived and is stuck" from "arrived, finished,
// but the client never saw it" without this. Logs on the way in (so a
// request that never even reaches here is obviously absent from the logs)
// and again on 'finish' (so a request that arrives but never gets a
// response is just as obviously missing its second line, and one that
// does respond shows exactly how long it took).
app.use((req, res, next) => {
  const startedAt = Date.now();
  console.log(`--> ${req.method} ${req.path}`);
  res.on('finish', () => {
    console.log(`<-- ${req.method} ${req.path} ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

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
    console.log('requireAuth: verifying token...');
    const decoded = await auth.verifyIdToken(idToken);
    console.log('requireAuth: token verified for', decoded.uid);
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
// MINING: orbit-swing model - the client plants the character and orbits
// a pickaxe locally, predicting each hit instantly instead of waiting on
// a round trip per click (see public/js/mining.js's file header for why
// that used to feel laggy under spam-clicking). /startMining opens a
// session and stamps a server-side start time; /mineNode is the single
// call a whole session makes, whenever it ends (finished or cancelled),
// carrying however many hits the client thinks landed - clamped against
// mining-session.js's own clock, not trusted outright. Replaces the old
// per-click /throwPickaxe entirely.
// ---------------------------------------------------------------------

app.post('/startMining', requireAuth, async (req, res) => {
  try {
    const { account, locationId, nodeId, charX, charY } = req.body || {};
    console.log('startMining: request body parsed', { account, locationId, nodeId });
    if (!requireClaimedAccount(req, res, account)) return;
    if (!(locationId in LOCATIONS)) return res.status(400).json({ error: 'bad_location' });

    console.log('startMining: fetching node doc...');
    const nodeSnap = await nodeManager.nodesCollection(db, locationId).doc(nodeId).get();
    console.log('startMining: node doc fetched', { exists: nodeSnap.exists, state: nodeSnap.exists ? nodeSnap.data().state : null });
    if (!nodeSnap.exists || nodeSnap.data().state !== 'active') {
      return res.status(400).json({ error: 'node_not_active' });
    }

    const node = nodeSnap.data();
    const dist = Math.hypot(node.x - charX, node.y - charY);
    if (dist > miningSession.MINING_RANGE) {
      return res.status(400).json({ error: 'out_of_range' });
    }

    console.log('startMining: starting session...');
    await miningSession.startSession(db, account, locationId, nodeId);
    console.log('startMining: session started');
    // Public broadcast so other clients can render your orbit/swing too -
    // see mining-session.js's file header. Best-effort: if this write
    // somehow fails, the session itself (already started above) still
    // works fine for you - you just won't be visible to others.
    try {
      console.log('startMining: writing broadcast...');
      await miningSession.startBroadcast(db, locationId, account, nodeId, charX, charY);
      console.log('startMining: broadcast written');
    } catch (err) {
      console.error('startBroadcast failed (non-fatal):', err);
    }
    console.log('startMining: sending response');
    res.json({ started: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/mineNode', requireAuth, async (req, res) => {
  try {
    const { account, locationId, nodeId, hitCount } = req.body || {};
    if (!requireClaimedAccount(req, res, account)) return;
    if (!(locationId in LOCATIONS)) return res.status(400).json({ error: 'bad_location' });

    const session = await miningSession.readAndClearSession(db, account);
    if (!session || session.locationId !== locationId || session.nodeId !== nodeId) {
      return res.status(400).json({ error: 'no_active_session' });
    }

    // From here on the session is genuinely ending (whatever the outcome),
    // so flip the public broadcast to "Validating..." for however long this
    // takes to resolve, and unconditionally clear it once we're done -
    // every return path below goes through the `finally` further down.
    await miningSession.markBroadcastValidating(db, locationId, account);

    try {
      const claimedHits = Math.max(0, Number(hitCount) || 0);
      const appliedHits = Math.min(claimedHits, miningSession.maxPlausibleHits(session));
      if (appliedHits <= 0) return res.json({ struck: false });

      // Energy is checked/spent inside strikeNodeTx itself, atomically with
      // the strike - see that function's comment on why: only a batch that
      // actually depletes the node (mines it out) costs energy, and if the
      // finishing batch lands with 0 energy it doesn't register at all
      // rather than wasting the node.
      const result = await nodeManager.strikeNodeTx(db, locationId, nodeId, account, appliedHits);
      if (!result) return res.json({ struck: false }); // node doc missing entirely - shouldn't normally happen
      if (result.blocked === 'already_depleted') {
        // Someone else's session on the same node finished first - tell
        // the loser who won instead of leaving them guessing why nothing
        // happened.
        return res.json({ struck: false, alreadyDepleted: true, wonBy: result.wonBy });
      }
      if (result.blocked === 'no_worker_row') return res.status(412).json({ error: 'no_worker_row' });
      if (result.blocked === 'no_energy') return res.status(400).json({ error: 'no_energy' });

      if (!result.depleted) {
        return res.json({ struck: true, depleted: false, strikesRemaining: result.strikesRemaining });
      }

      // Node depleted on this batch: credit the winner and bump world state.
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

      return res.json({ struck: true, depleted: true, oreType: result.oreType, value: result.value, energy: result.energy });
    } finally {
      // Whatever happened above - depleted, contested, out of energy, or
      // an outright error below - the session is over, so stop showing
      // this account as actively mining. Best-effort: a failure here
      // shouldn't turn a successful mine into a 500 for the player.
      try {
        await miningSession.clearBroadcast(db, locationId, account);
      } catch (err) {
        console.error('clearBroadcast failed (non-fatal):', err);
      }
    }
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

// ---------------------------------------------------------------------
// FULL DATABASE DUMP - backs public/debug.html's "download everything as
// JSON" button, since Firestore's own console has no built-in JSON
// export for a live Spark-plan project. Walks every collection,
// document, and subcollection via the Admin SDK (see lib/debug-dump.js)
// and returns it as one JSON blob.
//
// This is far more sensitive than the other /debug* endpoints above - it
// includes every worker account's coins/energy, live mining sessions, and
// in-flight login nonces - so it's gated behind a shared secret (the
// DEBUG_KEY env var) rather than left wide open like /debugSysdata.
// Set DEBUG_KEY in Render's dashboard before deploying this anywhere
// someone else could stumble onto the URL. If DEBUG_KEY isn't set, the
// endpoint still works (so local dev isn't blocked) but logs a loud
// warning on every hit so it doesn't stay silently wide open.
// ---------------------------------------------------------------------

app.get('/debugDump', async (req, res) => {
  try {
    if (process.env.DEBUG_KEY) {
      if (req.query.key !== process.env.DEBUG_KEY) {
        return res.status(403).json({ error: 'bad_or_missing_key' });
      }
    } else {
      console.warn(
        '/debugDump hit with no DEBUG_KEY env var set - anyone with this URL can read the entire ' +
        'database (accounts, coins, nonces, everything). Set DEBUG_KEY before deploying.'
      );
    }

    const data = await debugDump.dumpDatabase(db);
    res.json({ generatedAtMs: Date.now(), data });
  } catch (err) {
    console.error('debugDump failed:', err);
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
