// server/lib/respawn-sweep.js
//
// Two separate loops, on purpose:
//
// 1. startRespawnSweep() - fast, frequent (every 5 minutes). Only
//    respawns nodes that are already marked 'depleted' with a
//    respawnAtMs that's passed (set by node-manager.strikeNodeTx the
//    moment a node gets mined out). This is what makes a node you just
//    mined come back reasonably soon, instead of making you wait for the
//    once-an-hour pass below.
//
// 2. startNodeReconcileSweep() - slow, thorough (every 1 hour). Runs
//    node-manager.reconcileAllLocations(), which does three things every
//    location doesn't already have exactly NODE_SLOTS_PER_LOCATION docs
//    (tops it up), catches any depleted node the fast sweep hasn't gotten
//    to yet, AND catches any currently-ACTIVE node whose ore is worth
//    more than the mine can currently afford - e.g. a diamond node that
//    spawned before sysdata/main.resources was lowered, or from the NaN
//    budget bug - and rerolls it. That last part is the piece the fast
//    sweep never did: it only ever looked at already-depleted nodes, so
//    an over-budget node that was still active just sat there forever.
//    Runs once immediately on boot too, not just after the first hour,
//    so a fresh deploy doesn't wait an hour to fix/populate anything.
//
// On serverless Cloud Functions a bare setInterval couldn't be trusted to
// survive a cold shutdown, which is why the original design used Cloud
// Tasks (paid Blaze plan). This server is a normal always-on Node
// process, so a couple of plain interval loops are just as reliable and
// need zero extra infrastructure.
//
// Note: on a free host that spins your service down after inactivity
// (e.g. Render's free tier), these loops simply aren't running while the
// service is asleep - both sweeps just resume on the next visit.

const { LOCATIONS } = require('./ore-config');
const nodeManager = require('./node-manager');

const FAST_SWEEP_INTERVAL_MS = 300000; // 5 minutes
const RECONCILE_INTERVAL_MS = 3600000; // 1 hour, per request

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

function startNodeReconcileSweep(db) {
  async function runOnce() {
    try {
      const sysSnap = await db.collection('sysdata').doc('main').get();
      if (!sysSnap.exists) {
        console.error('node reconcile sweep: sysdata/main doc missing - skipping this pass');
        return;
      }
      await nodeManager.reconcileAllLocations(db, sysSnap.data());
    } catch (err) {
      console.error('node reconcile sweep failed:', err.message);
    }
  }
  runOnce(); // don't make a fresh deploy wait a full hour for the first pass
  setInterval(runOnce, RECONCILE_INTERVAL_MS);
}

module.exports = { startRespawnSweep, startNodeReconcileSweep };
