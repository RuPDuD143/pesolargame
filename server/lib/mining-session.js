// server/lib/mining-session.js
//
// Backs the "orbit while immobile" mining flow: the client swings a
// pickaxe locally and predicts node HP instantly (see public/js/mining.js
// for why - waiting on a server round trip per hit felt laggy back when
// spam-clicking was how mining worked), then syncs the real hit count
// with the server exactly once, when it either finishes the node off or
// the player cancels. That means the server can't trust a client-claimed
// hit count on its own - a tampered client could just claim any number -
// so /startMining (server/index.js) stamps a server-side timestamp here,
// and /mineNode clamps whatever hitCount the client sends against how
// much real wall-clock time has actually passed since that timestamp,
// using this file's own clock rather than anything the client reports.
//
// MINE_ORBIT_PERIOD_MS must match ORBIT_PERIOD_MS in public/js/mining.js -
// it's how long one full swing/orbit takes, i.e. the fastest a hit can
// legitimately land. MINING_RANGE must match that file's MINING_RANGE too.
//
// This file also owns the *public* broadcast doc (locations/{id}/
// miningActivity/{account}) that lets OTHER players' clients render your
// orbit/swing too - separate from the private miningSessions/{account}
// doc above, which stays server-only (see firestore.rules). The broadcast
// carries charX/charY as they were at /startMining time (the character is
// frozen for the whole session - see mining.js's updateMovement - so a
// single snapshot is enough for the whole swing animation) plus a
// `validating` flag that flips true for the brief window /mineNode is
// actually processing the finishing batch, which is what lets a bystander
// (or another miner on the same node) see the "Validating..." label
// instead of a stale HP number.

const MINE_ORBIT_PERIOD_MS = 500;
const MINING_RANGE = 150; // world units

function sessionRef(db, account) {
  return db.collection('miningSessions').doc(account);
}

function broadcastRef(db, locationId, account) {
  return db.collection('locations').doc(String(locationId)).collection('miningActivity').doc(account);
}

/** Starts (or restarts) a session - overwrites any previous one for this account. */
async function startSession(db, account, locationId, nodeId) {
  await sessionRef(db, account).set({ locationId, nodeId, startedAtMs: Date.now() });
}

/** Reads the session and deletes it in one go - a session is always single-use. */
async function readAndClearSession(db, account) {
  const ref = sessionRef(db, account);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete();
  return snap.data();
}

/** How many hits a client could plausibly have landed by now, given the session's real (server-stamped) start time. */
function maxPlausibleHits(session) {
  const elapsedMs = Date.now() - session.startedAtMs;
  return Math.max(1, Math.floor(elapsedMs / MINE_ORBIT_PERIOD_MS) + 1);
}

/** Publishes "this account is now orbiting nodeId" for every other client to render. */
async function startBroadcast(db, locationId, account, nodeId, charX, charY) {
  await broadcastRef(db, locationId, account).set({
    nodeId, charX, charY, startedAtMs: Date.now(), validating: false
  });
}

/** Flips the broadcast into "Validating..." for however long /mineNode takes to resolve. */
async function markBroadcastValidating(db, locationId, account) {
  // Best-effort: if the account somehow has no broadcast doc (e.g. a
  // second, redundant /mineNode call arriving after the first already
  // cleared it - see readAndClearSession being single-use), don't let
  // that throw and abort the actual mining resolution.
  try {
    await broadcastRef(db, locationId, account).update({ validating: true });
  } catch (err) { /* no-op - doc may not exist, that's fine */ }
}

/** Session over (finished, cancelled, or rejected) - stop showing this account as mining. */
async function clearBroadcast(db, locationId, account) {
  await broadcastRef(db, locationId, account).delete();
}

module.exports = {
  startSession, readAndClearSession, maxPlausibleHits,
  startBroadcast, markBroadcastValidating, clearBroadcast,
  MINING_RANGE, MINE_ORBIT_PERIOD_MS
};
