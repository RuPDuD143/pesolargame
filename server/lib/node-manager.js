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
 * The mine's raw resource pool - (resources - minedResources), NOT
 * divided by 100. See nodeMaxForLocation for how a location's actual
 * per-node ceiling is derived from this.
 *
 * Both fields are coerced with a `|| 0` fallback on purpose: sysdata/main
 * is created by hand in the Firestore console (see server/index.js's
 * "create it first... with { resources: <int>, minedResources: 0 }"
 * message), so a doc that only has `resources` set - no `minedResources`
 * yet - used to compute `resources - undefined` = NaN, silently
 * disabling every downstream affordability check.
 */
function computeRawRemaining(sysdata) {
  const resources = DEMO_MODE ? DEMO_RESOURCES : (Number(sysdata.resources) || 0);
  const minedResources = Number(sysdata.minedResources) || 0;
  return Math.max(0, resources - minedResources);
}

/**
 * A location's nodeMax is a single ceiling - the most *value* any one of
 * its node slots may be worth - shared uniformly by every slot in that
 * location. It is NOT reduced node-by-node as that location's own nodes
 * get rolled; it only depends on how much of the mine's total resource
 * pool has already been spoken for by EARLIER (lower-id) locations.
 *
 * Worked example (this is the actual intended behavior, not an
 * approximation of it): resources=3404, minedResources=59 ->
 * rawRemaining=3345. Location 0's nodeMax = floor(3345/100) = 33
 * (permits anything up to gold's value of 25). Say location 0 ends up
 * rolling 65 stone + 25 iron + 10 gold = 440 total value - that 440 is
 * subtracted ONCE, after all of location 0's 100 nodes are decided, not
 * per-node while rolling them. Location 1's nodeMax is then
 * floor((3345-440)/100) = floor(2905/100) = 29 - still permits gold. If
 * location 1 commits 700, location 2's nodeMax becomes
 * floor((2905-700)/100) = 22, which is below location 2's baseline ore
 * value, so location 2 (and, since nothing is ever spent there, every
 * location after it) spawns no active nodes at all until the pool grows.
 *
 * `committedByLowerLocations` is the sum of committed value across every
 * location with a strictly smaller id than the one being computed for -
 * see computeCommittedValueByLocation.
 */
function nodeMaxForLocation(rawRemaining, committedByLowerLocations) {
  return Math.floor(Math.max(0, rawRemaining - committedByLowerLocations) / 100);
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
 * Sums the *value* of every currently-active node, broken down per
 * location - i.e. how much of the mine's total resource pool is already
 * spoken for by nodes nobody has mined out yet. nodeMaxForLocation needs
 * the running total of every EARLIER location to compute a given
 * location's ceiling; this is what supplies that (used by the fast
 * per-node respawn sweep - reconcileAllLocations tracks its own running
 * total as it goes, in one pass, since it visits every location anyway).
 *
 * Deliberately recomputed from the node docs themselves (ground truth)
 * rather than maintained as a running counter on sysdata/main - a counter
 * would need every single write path that flips a node active/depleted to
 * remember to keep it in sync (including hand-edits, future code, etc.),
 * and would silently drift if any of them ever forgot. Six locations of at
 * most 100 nodes each is cheap enough to just re-read whenever it's needed.
 */
async function computeCommittedValueByLocation(db) {
  const locationIds = Object.keys(LOCATIONS).map(Number).sort((a, b) => a - b);
  const committed = {};

  for (const locationId of locationIds) {
    const snap = await nodesCollection(db, locationId).where('state', '==', 'active').get();
    let total = 0;
    snap.forEach((doc) => { total += ORE_TYPES[doc.data().oreType].value; });
    committed[locationId] = total;
  }

  return committed;
}

/**
 * Ensures every location has exactly NODE_SLOTS_PER_LOCATION node docs
 * (creating whichever are missing), respawns any depleted node whose
 * respawnAtMs has passed, AND catches any currently-active node that's
 * worth more than its location can currently afford (e.g. a diamond node
 * left over from before sysdata/main.resources was lowered) and rerolls
 * it - previously an over-budget node just sat there indefinitely once
 * spawned, since only depleted nodes ever got re-evaluated.
 *
 * Processes locations in ascending id order. Each location's nodeMax is
 * fixed for that location's *entire* batch of slots (see
 * nodeMaxForLocation's doc comment for why, and a worked example) - low-id
 * locations get first claim on the mine's total resource pool, and only
 * the leftover after ALL of a location's actual rolled value is tallied
 * flows into the next location's ceiling.
 */
async function reconcileAllLocations(db, sysdata) {
  const rawRemaining = computeRawRemaining(sysdata);
  const locationIds = Object.keys(LOCATIONS).map(Number).sort((a, b) => a - b);
  const now = Date.now();
  let committedSoFar = 0; // running total of every earlier location's final committed value

  for (const locationId of locationIds) {
    const config = LOCATIONS[locationId];
    const nodeMax = nodeMaxForLocation(rawRemaining, committedSoFar); // fixed for this location's whole batch
    const col = nodesCollection(db, locationId);
    const existingSnap = await col.get();
    const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));

    const batch = db.batch();
    let writes = 0;
    let locationCommitted = 0;

    config.spawnPoints.forEach((point, index) => {
      const id = nodeId(locationId, index);
      const current = existingById.get(id);

      const dueToRespawn = current && current.state === 'depleted'
        && current.respawnAtMs != null && current.respawnAtMs <= now;
      const overBudget = current && current.state === 'active'
        && ORE_TYPES[current.oreType].value > nodeMax;

      if (!current || dueToRespawn || overBudget) {
        const node = buildActiveNodeData(locationId, point, nodeMax);
        batch.set(col.doc(id), node);
        writes++;
        if (node.state === 'active') locationCommitted += ORE_TYPES[node.oreType].value;
      } else if (current.state === 'active') {
        locationCommitted += ORE_TYPES[current.oreType].value; // kept as-is, still counts against the pool
      }
    });

    if (writes > 0) await batch.commit();
    committedSoFar += locationCommitted;
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
 *   null                                        - node doc doesn't exist at all (shouldn't normally happen)
 *   { blocked: 'already_depleted', wonBy }       - node exists but someone else's batch already mined it out first (wonBy is that account, from the node's lastHitBy - may be null if somehow unset)
 *   { blocked: 'no_worker_row' }                 - no workers/{account} doc (shouldn't normally happen - defensive)
 *   { blocked: 'no_energy' }                     - this batch would deplete the node, but energy is 0
 *   { depleted: false, strikesRemaining }
 *   { depleted: true, oreType, value, energy }   - energy is the balance *after* this batch
 */
async function strikeNodeTx(db, locationId, nId, account, hitCount = 1) {
  const nodeRef = nodesCollection(db, locationId).doc(nId);
  const workerRef = db.collection('workers').doc(account);

  return db.runTransaction(async (tx) => {
    const [nodeSnap, workerSnap] = await Promise.all([tx.get(nodeRef), tx.get(workerRef)]);
    if (!nodeSnap.exists) return null;
    const node = nodeSnap.data();
    // Someone else's batch (very likely a concurrent miner on the same
    // node) already finished it off before this one landed - surface who,
    // so the loser's client can show a "beat you to it" message instead
    // of silently doing nothing.
    if (node.state !== 'active') return { blocked: 'already_depleted', wonBy: node.lastHitBy || null };

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

/**
 * Called by the fast per-node respawn sweep once respawnAtMs has passed.
 * Takes a pre-computed `nodeMax` directly (see respawn-sweep.js), not raw
 * sysdata - the right ceiling for a node depends on what every strictly
 * earlier location has already committed, not just computeRawRemaining()
 * in isolation, and computing that per-location breakdown is the caller's
 * job (computeCommittedValueByLocation) since it only needs to happen
 * once per sweep tick, not once per due node.
 */
async function respawnNode(db, locationId, nId, nodeMax) {
  const config = LOCATIONS[locationId];
  const pointIndex = Number(nId.split('-pt')[1]);
  const point = config.spawnPoints[pointIndex];
  const ref = nodesCollection(db, locationId).doc(nId);
  await ref.set(buildActiveNodeData(locationId, point, nodeMax));
}

module.exports = {
  nodeId,
  nodesCollection,
  computeRawRemaining,
  nodeMaxForLocation,
  computeCommittedValueByLocation,
  rollOreType,
  reconcileAllLocations,
  strikeNodeTx,
  respawnNode
};
