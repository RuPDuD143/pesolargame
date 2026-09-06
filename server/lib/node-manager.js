// functions/lib/node-manager.js
//
// Same spawn-roll / tier-downgrade math as the earlier in-memory version,
// but state now lives in Firestore so it's shared across Cloud Functions
// instances and survives cold starts. One doc per spawn point, always
// present - a "depleted" node just sits with state:'depleted' until its
// one-shot respawn timer (scheduleRespawn, below) rolls it fresh again.

const { LOCATIONS, RESPAWN_DELAY_MS } = require('./ore-config');
const { ORE_TYPES } = require('./ore-types');

// In-memory timers keyed by node id, so a server restart (or a respawn that
// gets rescheduled - see respawnNodeAndReschedule) never double-books a
// timer for the same node. Nothing here is persisted; that's fine because
// respawnAtMs already lives in Firestore and catchUpPendingRespawns()
// rebuilds these from that on every boot.
const pendingTimers = new Map(); // nId -> Timeout

function nodeId(locationId, pointIndex) {
  return `loc${locationId}-pt${pointIndex}`;
}

function nodesCollection(db, locationId) {
  return db.collection('locations').doc(String(locationId)).collection('nodes');
}

// [TEMPORARY] DEMO MODE ---------------------------------------------
// Set DEMO_MODE=true in the environment (e.g. Render's dashboard) to
// pretend the world has 1,000,000 in-game resources, regardless of what
// sysdata/main.resources actually says in Firestore. This only affects
// the nodeMax calculation below (i.e. which ore tiers are allowed to
// spawn) - it never writes anything to Firestore, so turning DEMO_MODE
// back off restores the real economy exactly as it was. Remove this
// block (and the env var) once you no longer need to demo high-tier ore
// spawning on demand.
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const DEMO_RESOURCES = 1000000;
// ---------------------------------------------------------------------

/** floor((resources - mined_resources) / 100), per spec. */
function computeNodeMax(sysdata) {
  const resources = DEMO_MODE ? DEMO_RESOURCES : sysdata.resources;
  return Math.floor((resources - sysdata.minedResources) / 100);
}

/** Weighted-random tier pick, then downgrade-to-baseline (or no spawn) if too expensive. */
function rollOreType(locationConfig, nodeMax) {
  const roll = Math.random();
  let cumulative = 0;
  let chosen = locationConfig.tiers[locationConfig.tiers.length - 1].ore;

  for (const tier of locationConfig.tiers) {
    cumulative += tier.chance;
    if (roll <= cumulative) {
      chosen = tier.ore;
      break;
    }
  }

  if (ORE_TYPES[chosen].value > nodeMax) chosen = locationConfig.baseline;
  if (ORE_TYPES[chosen].value > nodeMax) return null; // even baseline too expensive

  return chosen;
}

function buildActiveNodeData(locationId, point, sysdata) {
  const config = LOCATIONS[locationId];
  const nodeMax = computeNodeMax(sysdata);
  const oreType = rollOreType(config, nodeMax);

  if (!oreType) {
    return { state: 'depleted', x: point.x, y: point.y, respawnAtMs: Date.now() + RESPAWN_DELAY_MS };
  }

  return {
    state: 'active',
    x: point.x,
    y: point.y,
    oreType,
    strikesRemaining: ORE_TYPES[oreType].strikes,
    maxStrikes: ORE_TYPES[oreType].strikes,
    lastHitBy: null,
    respawnAtMs: null
  };
}

/** Idempotent: only writes nodes that don't already exist. Safe to call on every cold start. */
async function seedLocationIfEmpty(db, locationId, sysdata) {
  const config = LOCATIONS[locationId];
  const col = nodesCollection(db, locationId);
  const existing = await col.limit(1).get();
  if (!existing.empty) return;

  const batch = db.batch();
  config.spawnPoints.forEach((point, i) => {
    batch.set(col.doc(nodeId(locationId, i)), buildActiveNodeData(locationId, point, sysdata));
  });
  await batch.commit();
}

async function seedAllLocations(db, sysdata) {
  await Promise.all(Object.keys(LOCATIONS).map((id) => seedLocationIfEmpty(db, Number(id), sysdata)));
}

/**
 * Applies one pickaxe strike inside a Firestore transaction.
 * Returns { depleted, oreType, value, strikesRemaining } or null if the
 * node doesn't exist / isn't currently active (already depleted by
 * someone else - normal in multiplayer, not an error).
 */
async function strikeNodeTx(db, locationId, nId, account) {
  const ref = nodesCollection(db, locationId).doc(nId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const node = snap.data();
    if (node.state !== 'active') return null;

    const strikesRemaining = node.strikesRemaining - 1;

    if (strikesRemaining <= 0) {
      tx.update(ref, {
        state: 'depleted',
        strikesRemaining: 0,
        lastHitBy: account,
        respawnAtMs: Date.now() + RESPAWN_DELAY_MS
      });
      return { depleted: true, oreType: node.oreType, value: ORE_TYPES[node.oreType].value };
    }

    tx.update(ref, { strikesRemaining, lastHitBy: account });
    return { depleted: false, strikesRemaining };
  });
}

/**
 * Rolls and writes a fresh node, fetching sysdata itself (fresh, not
 * reused from strike time - the world's resource totals may have moved on
 * in the meantime). If the roll still can't afford even the baseline ore
 * (rare - only when the world is nearly mined out), the node comes back
 * depleted with a new respawnAtMs, so we reschedule once more instead of
 * leaving it stuck forever. Either way this is exactly one Firestore read
 * (sysdata) + one write (the node) per call, and it's only ever called by
 * a timer that already knows it's due - never by a poll asking "is
 * anything due yet?".
 */
async function respawnNodeAndReschedule(db, locationId, nId) {
  pendingTimers.delete(nId);
  try {
    const sysSnap = await db.collection('sysdata').doc('main').get();
    const sysdata = sysSnap.data();
    const config = LOCATIONS[locationId];
    const pointIndex = Number(nId.split('-pt')[1]);
    const point = config.spawnPoints[pointIndex];
    const fresh = buildActiveNodeData(locationId, point, sysdata);
    await nodesCollection(db, locationId).doc(nId).set(fresh);

    if (fresh.state === 'depleted') {
      scheduleRespawn(db, locationId, nId, fresh.respawnAtMs - Date.now());
    }
  } catch (err) {
    console.error(`respawn failed for ${locationId}/${nId}:`, err.message);
    // Retry once more after the normal delay rather than leaving the node
    // stuck depleted forever because of one transient Firestore error.
    scheduleRespawn(db, locationId, nId, RESPAWN_DELAY_MS);
  }
}

/**
 * Books a single in-memory timer to respawn one node after delayMs - no
 * Firestore access happens until the timer actually fires. Safe to call
 * more than once for the same node (e.g. a retry racing a fresh strike);
 * the previous timer is cleared first so only one is ever pending.
 */
function scheduleRespawn(db, locationId, nId, delayMs) {
  const existing = pendingTimers.get(nId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => respawnNodeAndReschedule(db, locationId, nId), Math.max(0, delayMs));
  if (timer.unref) timer.unref(); // don't keep the process alive just for this
  pendingTimers.set(nId, timer);
}

/**
 * Run once at server boot. Because respawns are now scheduled by
 * setTimeout instead of polled, a server restart loses every pending
 * timer - this rebuilds them from what's already on each node's
 * respawnAtMs, so a restart mid-cooldown doesn't leave nodes stuck
 * depleted forever. One query per location, one time, not a recurring
 * poll.
 */
async function catchUpPendingRespawns(db) {
  await Promise.all(
    Object.keys(LOCATIONS).map(async (locationId) => {
      try {
        const snap = await nodesCollection(db, locationId).where('state', '==', 'depleted').get();
        snap.docs.forEach((doc) => {
          const respawnAtMs = doc.data().respawnAtMs || Date.now();
          scheduleRespawn(db, locationId, doc.id, respawnAtMs - Date.now());
        });
      } catch (err) {
        console.error(`catch-up respawn scan failed for location ${locationId}:`, err.message);
      }
    })
  );
}

module.exports = {
  nodeId,
  nodesCollection,
  computeNodeMax,
  rollOreType,
  seedAllLocations,
  strikeNodeTx,
  scheduleRespawn,
  catchUpPendingRespawns
};
