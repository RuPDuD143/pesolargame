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

/**
 * Dumps one collection (and everything under it) into
 * { docId: {...fields, _subcollections?} }.
 *
 * Uses listDocuments() rather than get(). get() runs a query, and
 * Firestore queries only return documents that actually have field
 * data - a document that exists solely as the parent of a subcollection
 * (e.g. locations/{id} here, which nothing ever .set()s directly - only
 * locations/{id}/nodes/{n} gets written to) has no fields of its own and
 * is silently excluded from a get() on its parent collection, even
 * though its subcollection is very much real. listDocuments() instead
 * lists every document reference that exists in any sense (own data,
 * subcollections, or both), which is what a "dump everything" tool
 * actually needs.
 */
async function dumpCollection(collectionRef) {
  const docRefs = await collectionRef.listDocuments();
  const out = {};

  for (const docRef of docRefs) {
    const [snap, subcollections] = await Promise.all([docRef.get(), docRef.listCollections()]);
    const fields = snap.exists ? serializeValue(snap.data()) : {};

    if (subcollections.length === 0) {
      out[docRef.id] = fields;
      continue;
    }

    // A doc can have BOTH its own fields and subcollections at once
    // (e.g. workers/{account} has energy/coins fields AND an inventory/
    // subcollection), or ONLY subcollections and no fields at all (e.g.
    // locations/{id} - see the comment above) - keep whatever's there
    // rather than assuming one or the other.
    const nested = {};
    for (const sub of subcollections) {
      nested[sub.id] = await dumpCollection(sub);
    }
    out[docRef.id] = { ...fields, _subcollections: nested };
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
