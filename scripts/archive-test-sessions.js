/* One-off — archive 5 specific test session IDs for Phase 28D QA.
 *
 * Sets admin_removed=true + audit fields on each session doc. Does NOT
 * cascade through assignment_id (avoids accidentally touching other
 * techs' sessions sharing an assignment). Does NOT hard delete.
 *
 * Defensive pre-checks:
 *   • Every target ID must exist.
 *   • If ANY target is already approved_for_payroll or exported, refuses
 *     (admin would have to void first).
 *   • Reports staff email + service_date for each so a misclick is obvious.
 *
 *   DRY_RUN=true  node scripts/archive-test-sessions.js   (default)
 *   DRY_RUN=false node scripts/archive-test-sessions.js   (commit)
 */
"use strict";
const admin = require("firebase-admin");

const DRY_RUN = process.env.DRY_RUN !== "false";
const TARGET_IDS = [
  "JWH9mZhiwd8NEgOfHIXw",
  "V0VMRoFllLz21IBuyb5p",
  "mFn8CmL1ieBeZaEQBDkV",
  "nMaoXtYS3nFaUUZF3Ixd",
  "qpPD2GiBHPFMmLvamFOd"
];
const REASON = "Admin test cleanup — zero-minute Cedar test sessions";
const ACTOR  = { uid: "archive-script", email: "archive-test-sessions.js", displayName: "archive-test-sessions" };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

(async () => {
  console.log("=== Archive 5 Cedar test sessions ===");
  console.log("DRY_RUN: " + DRY_RUN);
  console.log("Reason:  " + REASON);
  console.log("");

  // Read all targets first.
  const refs  = TARGET_IDS.map(id => db.collection("pioneer_service_sessions").doc(id));
  const snaps = await Promise.all(refs.map(r => r.get()));

  let blocked = false;
  const targets = [];
  for (let i = 0; i < snaps.length; i++) {
    const id  = TARGET_IDS[i];
    const snap = snaps[i];
    if (!snap.exists) {
      console.error("  ✗ MISSING: " + id);
      blocked = true;
      continue;
    }
    const d = snap.data();
    targets.push({ id, ref: refs[i], data: d });
    const ps = d.payroll_state || "(absent)";
    const ar = d.admin_removed === true ? " · already archived" : "";
    console.log("  • " + id);
    console.log("      staff_email: " + d.staff_email);
    console.log("      service_date: " + d.service_date);
    console.log("      work_minutes: " + d.work_minutes);
    console.log("      payroll_state: " + ps + ar);
    if (d.staff_email && /makaila/i.test(d.staff_email)) {
      console.error("      ✗ ABORT — Makaila's session detected in target list. Refusing.");
      blocked = true;
    }
    if (ps === "approved_for_payroll" || ps === "exported") {
      console.error("      ✗ ABORT — session is " + ps + ". Void/unapprove first.");
      blocked = true;
    }
  }

  if (blocked) {
    console.error("\nPre-check failed. No writes performed.");
    process.exit(2);
  }
  if (!targets.length) {
    console.log("No targets resolved — nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY-RUN — would archive " + targets.length + " session(s).");
    console.log("Re-run with DRY_RUN=false to commit.");
    return;
  }

  const sts = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  targets.forEach(t => {
    batch.update(t.ref, {
      admin_removed:  true,
      removed_reason: REASON,
      removed_by:     ACTOR,
      removed_at:     sts,
      needs_review:   true   // matches Phase 2A.2 cascade pattern; harmless for archived rows
    });
  });
  await batch.commit();
  console.log("\n✅ Archived " + targets.length + " session(s).");

  // Verify post-write.
  console.log("\n--- Post-write verification ---");
  const afterSnaps = await Promise.all(refs.map(r => r.get()));
  afterSnaps.forEach((s, i) => {
    const d = s.data() || {};
    console.log("  " + TARGET_IDS[i] + " · admin_removed=" + d.admin_removed +
      " · removed_reason=" + JSON.stringify(d.removed_reason));
  });
})().catch(err => { console.error(err); process.exit(1); });
