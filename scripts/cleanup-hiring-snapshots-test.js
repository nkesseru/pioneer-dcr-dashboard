/* Pioneer DCR Hub — Phase 2A.1 hiring snapshot cleanup.
 *
 * Deletes every office_manager_hiring_snapshots doc whose snapshot_date
 * is within manager.js's 7-day "fresh" window. The Mission Control card
 * (/manager) treats any snapshot whose snapshot_date is within 7 days
 * of "now" as authoritative ("Live GHL"), so a one-day cleanup leaves
 * stale fixtures from earlier in the week blocking the manual fallback.
 *
 * Each delete is scoped to docs whose snapshot_date >= today - 7d. Docs
 * outside the window are left alone so an older real snapshot (if one
 * ever lands) is not touched.
 *
 * Usage:
 *   node scripts/cleanup-hiring-snapshots-test.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json")),
  });
}
const db = admin.firestore();

function pacificYMD(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

async function main() {
  const today = pacificYMD(new Date());
  const cutoff = pacificYMD(new Date(Date.now() - 7 * 86400000));

  console.log("[cleanup] hiring snapshots — keeping docs older than " + cutoff);
  console.log("[cleanup] window: " + cutoff + " .. " + today);

  const snap = await db.collection("office_manager_hiring_snapshots")
    .where("snapshot_date", ">=", cutoff)
    .get();

  if (snap.empty) {
    console.log("[cleanup] nothing in the 7-day window. Done.");
    return;
  }

  console.log("[cleanup] " + snap.size + " doc(s) to delete:");
  for (const d of snap.docs) {
    const data = d.data() || {};
    console.log("  - " + d.id + " (snapshot_date=" + data.snapshot_date + ")");
    await d.ref.delete();
  }
  console.log("[cleanup] done.");
}

main().then(() => process.exit(0)).catch(err => {
  console.error("[cleanup] FAILED:", err);
  process.exit(1);
});
