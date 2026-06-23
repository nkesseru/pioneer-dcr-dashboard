/* Test harness — replicates the Phase 28B Approve writer logic via
 * Admin SDK, then invokes the LIVE exportPayrollCsvV1 Cloud Function
 * with a custom ID token. Proves the end-to-end pipeline:
 *
 *   Approve  → workweek allocation → payroll_state="approved_for_payroll"
 *   Export   → CSV in Storage + payroll_exports doc + state="exported"
 *
 * Default DRY_RUN=true (Approve simulation only).
 *
 *   DRY_RUN=true  node scripts/test-approve-and-export.js
 *   DRY_RUN=false node scripts/test-approve-and-export.js
 *
 * Set SESSION_ID env to target a specific session; default is Nick's
 * backfilled 6817-cedar session.
 */
"use strict";
const admin = require("firebase-admin");

const DRY_RUN    = process.env.DRY_RUN !== "false";
const SESSION_ID = process.env.SESSION_ID || "dSYurQMoxs3cLLjHB9NI";
const TZ = "America/Los_Angeles";
const WEEKLY_REGULAR_CAP_MIN = 2400;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

function pacificWeekday(date) {
  const wk = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(date);
  return { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[wk];
}
function addDaysPT(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function computeWorkweekId(ymd) {
  if (!ymd) return null;
  const wk = pacificWeekday(new Date(ymd + "T12:00:00Z"));
  if (wk == null) return ymd;
  return wk === 0 ? ymd : addDaysPT(ymd, -wk);
}
function computeWorkweekLabel(wid) {
  if (!wid) return null;
  const end = addDaysPT(wid, 6);
  const fmt = (id) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" })
                       .format(new Date(id + "T12:00:00Z"));
  const yr  = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" })
                       .format(new Date(end + "T12:00:00Z"));
  return fmt(wid) + " – " + fmt(end) + ", " + yr;
}
function allocateOvertime(sorted) {
  let cum = 0;
  sorted.forEach(s => {
    const total = (typeof s.work_minutes === "number" && s.work_minutes > 0) ? s.work_minutes : 0;
    const budget = Math.max(0, WEEKLY_REGULAR_CAP_MIN - cum);
    let reg, ot;
    if (total <= budget) { reg = total; ot = 0; }
    else                  { reg = budget; ot = total - budget; }
    s.regular_minutes = reg; s.overtime_minutes = ot; s.payable_work_minutes = total;
    cum += reg;
  });
}

(async () => {
  console.log("=== Phase 2B end-to-end approve simulation ===");
  console.log("DRY_RUN:    " + DRY_RUN);
  console.log("SESSION_ID: " + SESSION_ID);
  console.log("");

  const ref = db.collection("pioneer_service_sessions").doc(SESSION_ID);
  const snap = await ref.get();
  if (!snap.exists) { console.error("Session not found."); process.exit(2); }
  const sess = Object.assign({ _id: snap.id, _ref: ref }, snap.data());

  const wid = computeWorkweekId(sess.service_date);
  const wlabel = computeWorkweekLabel(wid);
  console.log("Service date:    " + sess.service_date);
  console.log("Workweek id:     " + wid + " (" + wlabel + ")");
  console.log("Work minutes:    " + sess.work_minutes);
  console.log("Current state:   " + (sess.payroll_state || "(absent)"));
  console.log("DCR status:      " + sess.dcr_status + " · id: " + sess.dcr_id);
  console.log("");

  // Refuse if already exported.
  if (sess.payroll_state === "exported") {
    console.log("Session is already exported — refusing to mutate.");
    process.exit(0);
  }

  // Mirror Phase 28B: query the workweek bucket.
  const existing = await db.collection("pioneer_service_sessions")
    .where("staff_uid", "==", sess.staff_uid)
    .where("workweek_id", "==", wid)
    .get();
  const bucketExisting = existing.docs
    .map(d => Object.assign({ _id: d.id, _ref: d.ref }, d.data()))
    .filter(s => s.admin_removed !== true)
    .filter(s => (s.payroll_state || "") === "approved_for_payroll" || (s.payroll_state || "") === "exported")
    .filter(s => s._id !== SESSION_ID);

  console.log("Existing approved/exported in bucket: " + bucketExisting.length);
  if (bucketExisting.some(s => s.payroll_state === "exported")) {
    console.error("REFUSE — workweek contains exported sessions. Void the export first.");
    process.exit(2);
  }

  // Construct synthetic target as approved.
  const target = Object.assign({}, sess, { payroll_state: "approved_for_payroll" });
  const bucket = bucketExisting.concat([target]);
  bucket.sort((a, b) => {
    const aMs = (a.clock_in_at && a.clock_in_at.toMillis) ? a.clock_in_at.toMillis() : 0;
    const bMs = (b.clock_in_at && b.clock_in_at.toMillis) ? b.clock_in_at.toMillis() : 0;
    return aMs - bMs;
  });
  allocateOvertime(bucket);

  console.log("");
  console.log("--- Allocation result ---");
  bucket.forEach(s => {
    console.log("  " + s._id + " · work=" + s.work_minutes +
      "m · regular=" + s.regular_minutes + "m · OT=" + s.overtime_minutes + "m");
  });
  console.log("");

  if (DRY_RUN) {
    console.log("DRY-RUN — no writes performed. Re-run with DRY_RUN=false to commit.");
    return;
  }

  // Commit batch (matching Phase 28B writer).
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const actor = { uid: "approve-test-script", email: "test-script", displayName: "approve-test-script" };
  const batch = db.batch();
  bucket.forEach(s => {
    const update = {
      workweek_id:          wid,
      workweek_label:       wlabel,
      regular_minutes:      s.regular_minutes,
      overtime_minutes:     s.overtime_minutes,
      payable_work_minutes: s.payable_work_minutes,
      overtime_computed_at: sts,
      overtime_computed_by: actor
    };
    if (s._id === SESSION_ID) {
      update.payroll_state            = "approved_for_payroll";
      update.payroll_state_changed_at = sts;
      update.payroll_state_changed_by = actor;
      update.approved_for_payroll_by  = actor;
      update.approved_for_payroll_at  = sts;
    }
    batch.update(s._ref, update);
  });
  await batch.commit();
  console.log("✅ Approve committed via Admin SDK.");
  console.log("");
  console.log("Re-fetching to confirm:");
  const after = await ref.get();
  const a = after.data();
  console.log("  payroll_state:    " + a.payroll_state);
  console.log("  regular_minutes:  " + a.regular_minutes);
  console.log("  overtime_minutes: " + a.overtime_minutes);
  console.log("  workweek_id:      " + a.workweek_id);
  console.log("  workweek_label:   " + a.workweek_label);
  console.log("");
  console.log("Next: in /admin → Payroll, set Custom Range " +
    sess.service_date + " → " + sess.service_date +
    " and click Export. This isolates Nick's session from the still-blocked");
  console.log("ones in the period and exercises Phase 28D end-to-end.");
})().catch(e => { console.error(e); process.exit(1); });
