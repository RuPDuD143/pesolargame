// server/lib/respawn-sweep.js
//
// Replaces Cloud Tasks. On serverless Cloud Functions, a bare setTimeout
// couldn't be trusted to survive a cold shutdown - hence the original
// design scheduled a real Cloud Tasks HTTP call for "5s from now", which
// requires the paid Blaze plan.
//
// This server is a normal always-on Node process (not scale-to-zero
// serverless), so we don't need an external scheduler at all: every
// depleted node already has a `respawnAtMs` field (set by
// node-manager.strikeNodeTx), so a small poll loop that runs every
// second and respawns anything whose time has passed is just as
// reliable, and needs zero extra infrastructure or paid APIs.
//
// Note: on a free host that spins your service down after inactivity
// (e.g. Render's free tier), this loop simply isn't running while the
// service is asleep - respawns just resume on the next visit, same as
// depleted nodes staying un-minable in the meantime. Not a correctness
// problem, just a minor UX one that only matters on a free tier.

const { LOCATIONS } = require('./ore-config');
const nodeManager = require('./node-manager');

const SWEEP_INTERVAL_MS = 300000;

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
        const sysdata = sysSnap.data();

        await Promise.all(
          snap.docs.map((doc) => nodeManager.respawnNode(db, locationId, doc.id, sysdata))
        );
      } catch (err) {
        console.error(`respawn sweep failed for location ${locationId}:`, err.message);
      }
    }
  }, SWEEP_INTERVAL_MS);
}

module.exports = { startRespawnSweep };
