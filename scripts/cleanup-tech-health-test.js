/* Pioneer DCR Hub — Tech Health verification cleanup.
 *
 * Deletes the 6 specific test docs created by seed-tech-health-test.js.
 * Each delete is scoped to a hard-coded doc ID, then double-checked
 * against the `_testSeed: true` flag before issuing the delete. A doc
 * that DOESN'T carry the test flag is left alone — this script will
 * NOT delete anything that wasn't created by the seed.
 *
 * Usage:
 *   node scripts/cleanup-tech-health-test.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json")),
  });
}
const db = admin.firestore();

// Exact paths created by seed-tech-health-test.js. If you add more
// fixtures there, list them here too — this script only ever deletes
// what's in this list.
const TARGETS = [
  { coll: "call_outs",        id: "_test_health_callout_1" },
  { coll: "call_outs",        id: "_test_health_callout_2" },
  { coll: "call_outs",        id: "_test_health_callout_3" },
  { coll: "call_outs",        id: "_test_health_callout_4" },
  { coll: "dcr_submissions",  id: "_test_health_dcr_1" },
  { coll: "dcr_submissions",  id: "_test_health_dcr_2" }
];

async function main() {
  console.log("--- Tech Health TEST cleanup ---");
  console.log("");

  let deleted = 0, missing = 0, skipped = 0;
  for (const t of TARGETS) {
    const ref  = db.collection(t.coll).doc(t.id);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log("  [MISSING] " + t.coll + "/" + t.id + " — already gone");
      missing += 1;
      continue;
    }
    const data = snap.data() || {};
    if (data._testSeed !== true) {
      // Safety net: doc ID matched but the test flag is missing. Refuse
      // to delete — something unexpected lives at this ID.
      console.warn("  [SKIPPED] " + t.coll + "/" + t.id +
        " — exists but has no _testSeed flag. NOT deleting.");
      skipped += 1;
      continue;
    }
    await ref.delete();
    console.log("  [DELETED] " + t.coll + "/" + t.id);
    deleted += 1;
  }

  console.log("");
  console.log("Summary: " + deleted + " deleted · " + missing + " already missing · " + skipped + " skipped (no _testSeed flag).");
  console.log("");
  console.log("Real production data was not touched.");
}

main().catch(function (err) {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
