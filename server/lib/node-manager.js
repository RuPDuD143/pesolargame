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
 * Applies `hitCount` pickaxe strikes inside a Firestore transaction.
 *
 * Energy is only spent - and only required - on the batch that actually
 * depletes the node (i.e. mines it out), not per individual hit within
 * it. That check has to live in the same transaction as the strike
 * itself: if we checked energy beforehand and deducted it afterward as
 * two separate steps, a player who hits 0 energy exactly on what would've
 * been the finishing blow could either get a free ore (checked-then-
 * someone-else's-strike-lands-first race) or, worse, have the node
 * silently consumed with no one credited. Doing it all in one transaction
 * means: if this batch would deplete the node but there's no energy for
 * it, the batch simply doesn't apply at all - strikesRemaining stays
 * exactly where it was, and the node is still there once the player has
 * rested.
 *
 * hitCount comes from server/index.js's /mineNode, which itself clamps
 * whatever the client claims against mining-session.js's real,
 * server-timestamped elapsed time - see that file for why a client-
 * reported hit count can't be trusted outright.
 *
 * Returns one of:
 *   null                              - node doesn't exist / not active (already depleted by someone else)
 *   { blocked: 'no_worker_row' }      - no workers/{account} doc (shouldn't normally happen - defensive)
 *   { blocked: 'no_energy' }          - this batch would deplete the node, but energy is 0
 *   { depleted: false, strikesRemaining }
 *   { depleted: true, oreType, value, energy } - energy is the balance *after* this batch
 */
async function strikeNodeTx(db, locationId, nId, account, hitCount = 1) {
  const nodeRef = nodesCollection(db, locationId).doc(nId);
  const workerRef = db.collection('workers').doc(account);

  return db.runTransaction(async (tx) => {
    const [nodeSnap, workerSnap] = await Promise.all([tx.get(nodeRef), tx.get(workerRef)]);
    if (!nodeSnap.exists) return null;
    const node = nodeSnap.data();
    if (node.state !== 'active') return null;

    const strikesRemaining = Math.max(0, node.strikesRemaining - hitCount);
    const wouldDeplete = strikesRemaining <= 0;

    if (!wouldDeplete) {
      // A batch that doesn't finish the node off - free, no energy or
      // worker-row check needed.
      tx.update(nodeRef, { strikesRemaining, lastHitBy: account });
      return { depleted: false, strikesRemaining };
    }

    if (!workerSnap.exists) return { blocked: 'no_worker_row' };
    const currentEnergy = workerSnap.data().energy || 0;
    if (currentEnergy <= 0) return { blocked: 'no_energy' };

    const newEnergy = currentEnergy - 1;
    tx.update(nodeRef, {
      state: 'depleted',
      strikesRemaining: 0,
      lastHitBy: account,
      respawnAtMs: Date.now() + RESPAWN_DELAY_MS
    });
    tx.update(workerRef, { energy: newEnergy });

    return { depleted: true, oreType: node.oreType, value: ORE_TYPES[node.oreType].value, energy: newEnergy };
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
