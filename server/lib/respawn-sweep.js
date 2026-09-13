// server/lib/respawn-sweep.js
//
// Three things live here now:
//
// 1. startRespawnSweep() - fast, frequent (every 5 minutes). Only
//    respawns nodes that are already marked 'depleted' with a
//    respawnAtMs that's passed (set by node-manager.strikeNodeTx the
//    moment a node gets mined out). This is what makes a node you just
//    mined come back reasonably soon, instead of making you wait for the
//    full sweep below.
//
// 2. runSweepIfDue() - the actual "hourly cave refresh": pulls the live
//    `resources` value from the on-chain contract table (so e.g. voting
//    actually changes what can spawn, instead of sysdata/main.resources
//    being a number someone has to hand-edit in the Firestore console
//    forever), writes it into sysdata/main, then reconciles every
//    location against it (see node-manager.reconcileAllLocations - tops
//    locations up to NODE_SLOTS_PER_LOCATION, respawns anything due, and
//    rerolls any active node that's grown too valuable for the budget).
//
//    This does NOT run unconditionally - it first checks sysdata/main's
//    `lastSweep` timestamp and does nothing if less than SWEEP_HOURS has
//    passed. Both the interval loop below AND the client-facing
//    /runSweep endpoint (server/index.js) call this exact same function,
//    so "H:MM:SS until cave refresh" on the client and what the server
//    actually does are reading/driving the same clock instead of two
//    independent timers that can drift apart. The due-check + claiming
//    lastSweep happen inside one Firestore transaction, so two people
//    loading the game at the same moment the countdown hits zero can't
//    both trigger a full sweep.
//
// 3. startNodeReconcileSweep() - a lightweight backstop that just calls
//    runSweepIfDue() every few minutes, in case nobody's client happens
//    to be open right when the countdown expires. On a host that spins
//    down when idle (e.g. Render's free tier) this loop simply isn't
//    running while asleep - the /runSweep endpoint is what actually
//    guarantees a refresh happens promptly once someone visits again.

const { Timestamp } = require('firebase-admin/firestore');
const { LOCATIONS } = require('./ore-config');
const nodeManager = require('./node-manager');
const chain = require('./chain');

const FAST_SWEEP_INTERVAL_MS = 300000; // 5 minutes
const SWEEP_HOURS = 1; // "H:MM:SS until cave refresh" counts down from this
const SWEEP_INTERVAL_MS = SWEEP_HOURS * 3600000;
const BACKSTOP_CHECK_INTERVAL_MS = 300000; // how often the idle loop checks "is it due yet" - cheap, one doc read

function startRespawnSweep(db) {
  setInterval(async () => {
    const now = Date.now();
    for (const locationId of Object.keys(LOCATIONS)) {
      try {
        const snap = await nodeManager
          .nodesCollection(db, locationId)
          .where('state', '==', 'depleted')
          .where('respawnAtMs', '<=', now)
          .get();

        if (snap.empty) continue;

        const sysSnap = await db.collection('sysdata').doc('main').get();
        if (!sysSnap.exists) continue;
        const sysdata = sysSnap.data();

        await Promise.all(
          snap.docs.map((doc) => nodeManager.respawnNode(db, locationId, doc.id, sysdata))
        );
      } catch (err) {
        console.error(`respawn sweep failed for location ${locationId}:`, err.message);
      }
    }
  }, FAST_SWEEP_INTERVAL_MS);
}

/**
 * Runs the full hourly reconcile, but only if it's actually due - checked
 * and claimed atomically so concurrent callers (the backstop loop and any
 * number of clients whose countdown just hit zero) can't double-run it.
 * Returns { ran: boolean, nextSweepAtMs: number, resources?: number }.
 */
async function runSweepIfDue(db) {
  const sysdataRef = db.collection('sysdata').doc('main');

  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(sysdataRef);
    if (!snap.exists) return { due: false, missing: true };

    const sysdata = snap.data();
    const now = Date.now();
    const lastSweepMs = sysdata.lastSweep ? sysdata.lastSweep.toMillis() : 0;
    const dueAtMs = lastSweepMs + SWEEP_INTERVAL_MS;

    if (now < dueAtMs) return { due: false, dueAtMs };

    // Claim it immediately, before doing any of the (slower) chain RPC /
    // reconcile work below, so a second caller arriving a moment later
    // sees lastSweep already bumped and backs off.
    tx.update(sysdataRef, { lastSweep: Timestamp.now() });
    return { due: true, sysdata };
  });

  if (!claim.due) {
    return { ran: false, nextSweepAtMs: claim.dueAtMs ?? Date.now() };
  }

  // Pull the live economy number from the chain. If the RPC call fails
  // for any reason, fall back to whatever sysdata/main.resources already
  // said rather than aborting the whole sweep - a stale-but-known number
  // is better than skipping node reconciliation entirely.
  //
  // The contract's row field is called `treasury` (per its ABI -
  // sysdata_row = { treasury: int64 }), not `resources` - Firestore keeps
  // calling its mirror of it `resources` since that's the name the rest
  // of this codebase (computeNodeMax, etc.) already uses.
  let resources = claim.sysdata.resources;
  try {
    const row = await chain.getContractSysdata();
    if (row && row.treasury != null) {
      resources = Number(row.treasury);
      await sysdataRef.update({ resources });
    }
  } catch (err) {
    console.error('runSweepIfDue: chain sysdata fetch failed, using existing Firestore value:', err.message);
  }

  const freshSnap = await sysdataRef.get();
  await nodeManager.reconcileAllLocations(db, freshSnap.data());

  return { ran: true, nextSweepAtMs: Date.now() + SWEEP_INTERVAL_MS, resources };
}

function startNodeReconcileSweep(db) {
  async function tick() {
    try {
      await runSweepIfDue(db);
    } catch (err) {
      console.error('node reconcile sweep failed:', err.message);
    }
  }
  tick(); // don't make a fresh deploy wait for the first backstop check
  setInterval(tick, BACKSTOP_CHECK_INTERVAL_MS);
}

module.exports = { startRespawnSweep, startNodeReconcileSweep, runSweepIfDue, SWEEP_INTERVAL_MS };
