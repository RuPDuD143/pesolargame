// server/lib/quota-meter.js
//
// Counts how many Firestore reads/writes/deletes this server process has
// actually performed, so the in-game F3 overlay can answer the question
// that cost us a whole day of debugging: "is the game broken, or did I
// just burn through the free quota again?"
//
// WHY COUNT IT OURSELVES: Firestore has no API that reports your current
// quota usage. The Firebase Console's Usage tab is the only official
// view, and it's both delayed and impossible to query programmatically.
// So the only way to get a live number is to count every operation as we
// issue it, which is what this does.
//
// HOW: rather than hand-editing every call site (and inevitably missing
// one, or missing every future one), this patches the Admin SDK's own
// prototypes once at startup. Every .get()/.set()/.update()/.delete()
// in the entire codebase - including ones inside transactions, batches,
// and library code like node-manager/respawn-sweep - flows through these
// same methods, so they all get counted automatically with no further
// maintenance.
//
// WHAT IT CANNOT SEE (important, and surfaced in the overlay itself):
// the browser talks to Firestore DIRECTLY via onSnapshot listeners
// (public/js/mining.js attaches one to the whole 100-doc nodes
// collection every time you enter a cave, plus inventory.js and
// cave-refresh.js). Those reads never touch this server, so they're
// counted separately client-side (see public/js/quota-client.js) and
// shown as their own line. Reads from OTHER people's browsers aren't
// visible to either counter - with a couple of test accounts that's
// fine, but it does mean these numbers are a floor, not a total.
//
// Counts live in memory only. Persisting them to Firestore would itself
// cost writes against the very quota we're trying to measure, which is
// self-defeating for a debug tool, so a process restart (including
// Render's free-tier spin-down) resets them to zero - the overlay shows
// process uptime right next to the numbers so a suspiciously low count
// is obviously explained by a recent restart rather than looking like
// the quota magically cleared.

const admin = require('firebase-admin/firestore');

// Firestore's free (Spark) daily allowances, for the overlay's % display.
// These reset at midnight US/Pacific.
const FREE_DAILY = { reads: 50000, writes: 20000, deletes: 20000 };

const counts = { reads: 0, writes: 0, deletes: 0 };
let currentPacificDay = pacificDayString();
const startedAtMs = Date.now();

/** "2026-09-14" in US/Pacific - the day boundary Firestore's quota actually resets on. */
function pacificDayString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

/**
 * Zeroes the counters when the Pacific day rolls over, so the numbers
 * stay aligned with the real quota window instead of accumulating
 * forever across days.
 */
function rollDayIfNeeded() {
  const today = pacificDayString();
  if (today !== currentPacificDay) {
    currentPacificDay = today;
    counts.reads = 0;
    counts.writes = 0;
    counts.deletes = 0;
    console.log(`quota-meter: Pacific day rolled over to ${today} - counters reset`);
  }
}

function record(kind, n = 1) {
  rollDayIfNeeded();
  counts[kind] += n;
}

/**
 * Wraps a prototype method so the operation is counted, while leaving
 * its return value and behaviour completely untouched.
 *
 * `amount` can be a number (fixed cost, e.g. one doc write) or a
 * function receiving the method's resolved result (variable cost, e.g. a
 * query that returns however many docs it matched).
 */
function patch(Class, methodName, kind, amount) {
  if (!Class || !Class.prototype || typeof Class.prototype[methodName] !== 'function') return;
  const original = Class.prototype[methodName];
  if (original.__quotaMetered) return; // idempotent - safe if this module gets required twice
  function wrapped(...args) {
    const result = original.apply(this, args);
    if (typeof amount === 'function') {
      // Async op (get/getAll): count once it resolves, using the real
      // result size. Count nothing on rejection - a failed call that
      // returned no documents didn't bill for any.
      if (result && typeof result.then === 'function') {
        return result.then((value) => { record(kind, amount(value)); return value; });
      }
      return result;
    }
    // Sync op (batch/transaction enqueue): count immediately.
    record(kind, amount);
    return result;
  }
  wrapped.__quotaMetered = true;
  Class.prototype[methodName] = wrapped;
}

/** Firestore bills a query that matched nothing as one read, not zero. */
function querySize(snap) {
  return Math.max(1, snap && typeof snap.size === 'number' ? snap.size : 1);
}
function arraySize(docs) {
  return Math.max(1, Array.isArray(docs) ? docs.length : 1);
}

let installed = false;

/**
 * Patches the Admin SDK prototypes. Call once, as early as possible -
 * before any Firestore work happens - so nothing goes uncounted.
 */
function install() {
  if (installed) return;
  installed = true;

  const { DocumentReference, CollectionReference, Query, WriteBatch, Transaction, Firestore } = admin;

  // --- reads -------------------------------------------------------
  patch(DocumentReference, 'get', 'reads', () => 1);
  // CollectionReference extends Query, so this single patch covers both
  // `collection.get()` and any `.where(...).get()` chain off it.
  patch(Query, 'get', 'reads', querySize);
  patch(Firestore, 'getAll', 'reads', arraySize);
  patch(Transaction, 'get', 'reads', (result) => (
    // Transaction.get() takes either a DocumentReference (-> snapshot,
    // no .size) or a Query (-> QuerySnapshot, has .size).
    result && typeof result.size === 'number' ? Math.max(1, result.size) : 1
  ));
  patch(Transaction, 'getAll', 'reads', arraySize);
  // Metadata listings bill as reads too (one per document/collection
  // returned) - these are what debug-dump.js's full export leans on, so
  // a big dump showing up in the numbers is expected and correct.
  patch(CollectionReference, 'listDocuments', 'reads', arraySize);
  patch(DocumentReference, 'listCollections', 'reads', arraySize);
  patch(Firestore, 'listCollections', 'reads', arraySize);

  // --- writes ------------------------------------------------------
  patch(DocumentReference, 'set', 'writes', 1);
  patch(DocumentReference, 'update', 'writes', 1);
  patch(DocumentReference, 'create', 'writes', 1);
  // Batch/transaction writes are counted as they're enqueued rather than
  // at commit time: the enqueue call is where we know the op count, and
  // commit() itself is a single flush of whatever's already been counted
  // (counting commit too would double-count every batched write).
  patch(WriteBatch, 'set', 'writes', 1);
  patch(WriteBatch, 'update', 'writes', 1);
  patch(WriteBatch, 'create', 'writes', 1);
  patch(Transaction, 'set', 'writes', 1);
  patch(Transaction, 'update', 'writes', 1);
  patch(Transaction, 'create', 'writes', 1);

  // --- deletes -----------------------------------------------------
  patch(DocumentReference, 'delete', 'deletes', 1);
  patch(WriteBatch, 'delete', 'deletes', 1);
  patch(Transaction, 'delete', 'deletes', 1);

  console.log('quota-meter: Firestore operation counting installed');
}

/** Snapshot of current usage, for GET /debugQuota. */
function snapshot() {
  rollDayIfNeeded();
  return {
    pacificDay: currentPacificDay,
    serverStartedAtMs: startedAtMs,
    serverUptimeMs: Date.now() - startedAtMs,
    msUntilPacificMidnight: msUntilPacificMidnight(),
    limits: FREE_DAILY,
    counts: { ...counts }
  };
}

/** How long until the free quota resets, for the overlay's countdown. */
function msUntilPacificMidnight() {
  const now = new Date();
  // Current wall-clock time in Pacific, as reported by Intl.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // formatToParts can render midnight as hour 24 rather than 0.
  const hour = get('hour') % 24;
  const elapsedMs = ((hour * 60 + get('minute')) * 60 + get('second')) * 1000;
  return 86400000 - elapsedMs;
}

module.exports = { install, snapshot, FREE_DAILY };
