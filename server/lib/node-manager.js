// functions/lib/node-manager.js
//
// Same spawn-roll / tier-downgrade math as the earlier in-memory version,
// but state now lives in Firestore so it's shared across Cloud Functions
// instances and survives cold starts. One doc per spawn point, always
// present - a "depleted" node just sits with state:'depleted' until a
// scheduled respawn (see respawn-sweep.js) rolls it fresh again.

const { LOCATIONS, RESPAWN_DELAY_MS } = require('./ore-config');
const { ORE_TYPES } = require('./ore-types');

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

/**
 * floor((resources - mined_resources) / 100), per spec - how much ore
 * *value* the whole mine can currently afford spawning, in total.
 *
 * Both fields are coerced with a `|| 0` fallback on purpose: sysdata/main
 * is created by hand in the Firestore console (see server/index.js's
 * "create it first... with { resources: <int>, minedResources: 0 }"
 * message), so a doc that only has `resources` set - no `minedResources`
 * yet - used to compute `resources - undefined` = NaN. Every comparison
 * against NaN is false, so the `value > nodeMax` downgrade/reject check
 * in rollOreType() never triggered - the *unfiltered* weighted roll's
 * tier spawned regardless of how little `resources` actually was, which
 * is how e.g. diamond could show up with resources pinned to 5.
 */
function computeNodeMax(sysdata) {
  const resources = DEMO_MODE ? DEMO_RESOURCES : (Number(sysdata.resources) || 0);
  const minedResources = Number(sysdata.minedResources) || 0;
  return Math.floor((resources - minedResources) / 100);
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

function buildActiveNodeData(locationId, point, nodeMax) {
  const config = LOCATIONS[locationId];
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

/**
 * Same as buildActiveNodeData, but spends from a shared, mutable budget
 * across many calls instead of recomputing an independent ceiling each
 * time. `budget` is a plain `{ remaining: number }` object, mutated in
 * place - this is what lets reconcileAllLocations hand location 0 first
 * claim on the mine's total value headroom, and only let higher-numbered
 * locations spawn ore with whatever's left over, in priority order.
 */
function buildActiveNodeDataFromBudget(locationId, point, budget) {
  const node = buildActiveNodeData(locationId, point, budget.remaining);
  if (node.state === 'active') budget.remaining -= ORE_TYPES[node.oreType].value;
  return node;
}

/**
 * Ensures every location has exactly NODE_SLOTS_PER_LOCATION node docs
 * (creating whichever are missing), respawns any depleted node whose
 * respawnAtMs has passed, AND catches any currently-active node that's
 * worth more than the mine can currently afford (e.g. a diamond node left
 * over from before sysdata/main.resources was lowered, or from the NaN
 * budget bug) and rerolls it - previously an over-budget node just sat
 * there indefinitely once spawned, since only depleted nodes ever got
 * re-evaluated.
 *
 * Spends ONE shared budget across all locations in ascending id order
 * (location 0 first, then 1, 2, ... up through the highest id), so low
 * locations get first claim on the mine's value headroom and higher ones
 * only get ore if there's some left over. This is on top of, not a
 * replacement for, the per-node ceiling already enforced by
 * buildActiveNodeData/rollOreType.
 */
async function reconcileAllLocations(db, sysdata) {
  const budget = { remaining: computeNodeMax(sysdata) };
  const locationIds = Object.keys(LOCATIONS).map(Number).sort((a, b) => a - b);
  const now = Date.now();

  for (const locationId of locationIds) {
    const config = LOCATIONS[locationId];
    const col = nodesCollection(db, locationId);
    const existingSnap = await col.get();
    const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));

    const batch = db.batch();
    let writes = 0;

    config.spawnPoints.forEach((point, index) => {
      const id = nodeId(locationId, index);
      const current = existingById.get(id);

      const dueToRespawn = current && current.state === 'depleted'
        && current.respawnAtMs != null && current.respawnAtMs <= now;
      const overBudget = current && current.state === 'active'
        && ORE_TYPES[current.oreType].value > budget.remaining;

      if (!current || dueToRespawn || overBudget) {
        batch.set(col.doc(id), buildActiveNodeDataFromBudget(locationId, point, budget));
        writes++;
      } else if (current.state === 'active') {
        budget.remaining -= ORE_TYPES[current.oreType].value; // still reserved, just left as-is
      }
    });

    if (writes > 0) await batch.commit();
  }
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

/** Called by the fast per-node respawn sweep once respawnAtMs has passed. */
async function respawnNode(db, locationId, nId, sysdata) {
  const config = LOCATIONS[locationId];
  const pointIndex = Number(nId.split('-pt')[1]);
  const point = config.spawnPoints[pointIndex];
  const ref = nodesCollection(db, locationId).doc(nId);
  await ref.set(buildActiveNodeData(locationId, point, computeNodeMax(sysdata)));
}

module.exports = {
  nodeId,
  nodesCollection,
  computeNodeMax,
  rollOreType,
  reconcileAllLocations,
  strikeNodeTx,
  respawnNode
};
