// server/lib/debug-dump.js
//
// Full read-only snapshot of every collection/document/subcollection in
// Firestore, for the /debugDump endpoint + public/debug.html admin page.
// There's no built-in "export to JSON" button for a live project on the
// Spark plan - the usual answer (gcloud firestore export) writes to a GCS
// bucket rather than handing you a file you can just download - so this
// walks the tree with the Admin SDK instead, which needs nothing beyond
// what's already deployed.
//
// Admin SDK's listCollections() is what makes this possible without
// hardcoding collection names anywhere: db.listCollections() lists every
// ROOT collection, and docRef.listCollections() lists whatever
// subcollections that specific document happens to have (nodes/
// miningActivity under locations/{id}, inventory under workers/{account},
// etc.) - so this stays correct even if a future feature adds a new
// subcollection and nobody remembers to update a hardcoded list here.

const { Timestamp } = require('firebase-admin/firestore');

/**
 * Recursively replaces Firestore Timestamps with ISO strings so
 * JSON.stringify produces readable dates instead of raw
 * {_seconds, _nanoseconds} internals.
 */
function serializeValue(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = serializeValue(v);
    return out;
  }
  return value;
}

/** Dumps one collection (and everything under it) into { docId: {...fields, _subcollections?} }. */
async function dumpCollection(collectionRef) {
  const snap = await collectionRef.get();
  const out = {};

  for (const doc of snap.docs) {
    const fields = serializeValue(doc.data());
    const subcollections = await doc.ref.listCollections();

    if (subcollections.length === 0) {
      out[doc.id] = fields;
      continue;
    }

    // A doc can have BOTH its own fields and subcollections at once
    // (e.g. workers/{account} has energy/coins fields AND an inventory/
    // subcollection) - keep both rather than picking one.
    const nested = {};
    for (const sub of subcollections) {
      nested[sub.id] = await dumpCollection(sub);
    }
    out[doc.id] = { ...fields, _subcollections: nested };
  }

  return out;
}

/** Full dump: { collectionName: { docId: {...} } } for every root collection in the project. */
async function dumpDatabase(db) {
  const rootCollections = await db.listCollections();
  const dump = {};
  for (const col of rootCollections) {
    dump[col.id] = await dumpCollection(col);
  }
  return dump;
}

module.exports = { dumpDatabase };
