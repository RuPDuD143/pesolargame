// public/js/quota-client.js
//
// Counts the Firestore reads THIS BROWSER performs directly, which the
// server-side meter (server/lib/quota-meter.js) is structurally blind to.
//
// This matters more than it might sound: the browser doesn't route its
// game-state reads through the backend at all - it attaches onSnapshot
// listeners straight to Firestore. mining.js attaches one to the entire
// `nodes` collection (up to 100 documents) every single time you enter
// or travel between caves, and each of those initial documents bills as
// a read, plus one more per document that changes afterwards. Add
// inventory.js and cave-refresh.js on top. So on a normal play session
// the browser can easily out-read the whole server, and a meter that
// only showed server numbers would read reassuringly low right up until
// the quota ran out anyway.
//
// Counts are per-tab and in-memory: they start at zero on every page
// load, and other players' browsers are counted in their own tabs, not
// here. The overlay labels all of that so the numbers aren't mistaken
// for a project-wide total.

const counts = { reads: 0 };
const bySource = {};
const startedAtMs = Date.now();

/**
 * Record `n` document reads attributed to `source` (a short label like
 * 'nodes' or 'inventory', so the overlay can show which listener is the
 * expensive one - usually the answer is 'nodes').
 */
export function recordReads(source, n) {
  if (!n) return;
  counts.reads += n;
  bySource[source] = (bySource[source] || 0) + n;
}

/**
 * Convenience wrapper for an onSnapshot callback: every changed document
 * in a snapshot is one billed read, which is exactly snap.docChanges().length
 * (on the first callback that's the whole collection, which is the
 * expensive one).
 */
export function recordSnapshot(source, snap) {
  recordReads(source, snap.docChanges().length);
}

export function clientQuotaSnapshot() {
  return {
    reads: counts.reads,
    bySource: { ...bySource },
    sinceMs: Date.now() - startedAtMs
  };
}
