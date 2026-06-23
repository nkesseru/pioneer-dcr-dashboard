/* Pioneer DCR Hub — Phase 2B DCR↔Session linkage backfill.
 *
 * One-shot script. Finds pioneer_service_sessions with a non-null
 * dcr_submission_id but missing dcr_id / dcr_status, and stamps the
 * missing fields so Phase 28A's approveGatePasses() recognizes them
 * as DCR-complete.
 *
 * Why this exists:
 *   Pre-Phase 2B, submitDcrV1 wrote only dcr_submission_id +
 *   dcr_submitted_at to the linked session. The Phase 28A approve gate
 *   reads dcr_id OR dcr_status === "submitted", so sessions with
 *   submitted DCRs still showed "DCR Pending" forever and blocked
 *   payroll export. This script catches up the historical data;
 *   submitDcrV1 going forward writes all four fields.
 *
 * Default is DRY_RUN=true. Set DRY_RUN=false to commit.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-dcr-linkage.js
 *   DRY_RUN=false node scripts/backfill-dcr-linkage.js
 *
 * Optional:
 *   MAX_DOCS=N  — cap how many sessions to write (smoke-test mode)
 */

"use strict";

const admin = require("firebase-admin");

const DRY_RUN  = process.env.DRY_RUN !== "false";
const MAX_DOCS = process.env.MAX_DOCS ? parseInt(process.env.MAX_DOCS, 10) : null;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

(async () => {
  console.log("--- Pioneer DCR Hub: Phase 2B DCR↔Session linkage backfill ---");
  console.log("DRY_RUN: ", DRY_RUN);
  console.log("MAX_DOCS:", MAX_DOCS || "(no cap)");
  console.log("--------------------------------------------------------------");

  // Single full-collection scan. Pilot scale is small (hundreds), so
  // an in-memory filter is fine. For larger scale, swap to a
  // dcr_submission_id != null query (needs `!=` index).
  const snap = await db.collection("pioneer_service_sessions").get();
  console.log("Scanned " + snap.size + " session(s).");

  const candidates = [];
  snap.docs.forEach(function (d) {
    const data = d.data() || {};
    if (!data.dcr_submission_id) return;             // no DCR to link
    if (data.dcr_status === "submitted") return;     // already linked (post-2B)
    if (data.dcr_id) return;                         // already linked (alt field)
    candidates.push({ _id: d.id, _ref: d.ref, data: data });
  });

  console.log("Found " + candidates.length + " session(s) needing backfill.");
  if (!candidates.length) {
    console.log("Nothing to do.");
    return;
  }

  const sts = admin.firestore.FieldValue.serverTimestamp();
  let processed = 0;

  // Write in batches of 400 (Firestore limit 500; leave headroom).
  const BATCH = 400;
  for (let i = 0; i < candidates.length; i += BATCH) {
    if (MAX_DOCS && processed >= MAX_DOCS) break;
    const slice = candidates.slice(i, i + BATCH);
    if (MAX_DOCS) slice.length = Math.min(slice.length, MAX_DOCS - processed);

    if (DRY_RUN) {
      slice.forEach(function (c) {
        console.log("[DRY-RUN backfill] session " + c._id +
          " · dcr_submission_id=" + c.data.dcr_submission_id +
          " · existing dcr_submitted_at=" + (c.data.dcr_submitted_at ? "set" : "absent"));
      });
    } else {
      const batch = db.batch();
      slice.forEach(function (c) {
        const update = {
          dcr_id:     c.data.dcr_submission_id,
          dcr_status: "submitted"
        };
        // Only stamp dcr_submitted_at if it isn't already on the doc —
        // preserves the original submission timestamp.
        if (!c.data.dcr_submitted_at) {
          update.dcr_submitted_at = sts;
        }
        batch.update(c._ref, update);
      });
      await batch.commit();
    }
    processed += slice.length;
    console.log((DRY_RUN ? "[DRY-RUN] " : "[WROTE] ") + processed + " / " + candidates.length);
  }

  console.log("\n--- Summary ---");
  console.log("Sessions " + (DRY_RUN ? "would be" : "were") + " backfilled: " + processed);
  console.log(DRY_RUN
    ? "\nDry-run complete. Re-run with DRY_RUN=false to commit."
    : "\nBackfill complete.");
})().catch((err) => {
  console.error("backfill-dcr-linkage failed:", err);
  process.exit(1);
});
