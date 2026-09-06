// functions/lib/node-manager.js
//
// Same spawn-roll / tier-downgrade math as the earlier in-memory version,
// but state now lives in Firestore so it's shared across Cloud Functions
// instances and survives cold starts. One doc per spawn point, always
// present - a "depleted" node just sits with state:'depleted' until a
// scheduled respawn (see respawn-tasks.js) rolls it fresh again.

const { LOCATIONS } = require('./ore-config');
const { ORE_TYPES } = require('./ore-types');

function nodeId(locationId, pointIndex) {
  return `loc${locationId}-pt${pointIndex}`;
}

function nodesCollection(db, locationId) {
  return db.collection('locations').doc(String(locationId)).collection('nodes');
}

/** floor((resources - mined_resources) / 100), per spec. */
function computeNodeMax(sysdata) {
  return Math.floor((sysdata.resources - sysdata.minedResources) / 100);
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
    return { state: 'depleted', x: point.x, y: point.y, respawnAtMs: Date.now() + 5000 };
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
        respawnAtMs: Date.now() + 5000
      });
      return { depleted: true, oreType: node.oreType, value: ORE_TYPES[node.oreType].value };
    }

    tx.update(ref, { strikesRemaining, lastHitBy: account });
    return { depleted: false, strikesRemaining };
  });
}

/** Called by the respawn task once respawnAtMs has passed. */
async function respawnNode(db, locationId, nId, sysdata) {
  const config = LOCATIONS[locationId];
  const pointIndex = Number(nId.split('-pt')[1]);
  const point = config.spawnPoints[pointIndex];
  const ref = nodesCollection(db, locationId).doc(nId);
  await ref.set(buildActiveNodeData(locationId, point, sysdata));
}

module.exports = {
  nodeId,
  nodesCollection,
  computeNodeMax,
  rollOreType,
  seedAllLocations,
  strikeNodeTx,
  respawnNode
};
