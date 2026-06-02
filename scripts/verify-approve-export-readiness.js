/* Verification script — reads current state of Pioneer sessions and
 * reports what /admin → Labor and /admin → Payroll should show right
 * now. Not a write. Helps confirm Phase 2B took effect before clicking
 * Approve / Export in the UI.
 *
 *   node scripts/verify-approve-export-readiness.js
 */

"use strict";
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

const TZ = "America/Los_Angeles";

function pacificDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function currentPeriod(today) {
  const parts = today.split("-").map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const mm = String(m).padStart(2, "0");
  if (d <= 15) return { start: y + "-" + mm + "-01", end: y + "-" + mm + "-15", label: "Period A (" + y + "-" + mm + ")" };
  const eod = lastDay(y, m);
  return { start: y + "-" + mm + "-16", end: y + "-" + mm + "-" + String(eod).padStart(2, "0"), label: "Period B (" + y + "-" + mm + ")" };
}

function dcrPending(s) {
  if (s.status === "dcr_pending") return true;
  if (s.status !== "completed") return false;
  return !(s.dcr_status === "submitted" || !!s.dcr_id);
}
function approveGate(s) {
  const state = s.payroll_state || "pending_review";
  if (state !== "pending_review" && state !== "reviewed") return { pass: false, reason: "state=" + state };
  if (s.admin_removed === true) return { pass: false, reason: "admin_removed" };
  if (s.needs_review === true)  return { pass: false, reason: "needs_review" };
  if (s.status !== "completed") return { pass: false, reason: "status=" + s.status };
  if (!s.assignment_id)         return { pass: false, reason: "no assignment_id" };
  if (typeof s.work_minutes !== "number" || s.work_minutes <= 0) return { pass: false, reason: "work_minutes=" + s.work_minutes };
  if (!(s.dcr_status === "submitted" || !!s.dcr_id)) return { pass: false, reason: "dcr not submitted" };
  return { pass: true };
}

(async () => {
  const today = pacificDate();
  const period = currentPeriod(today);
  console.log("=== Phase 2B post-fix verification ===");
  console.log("Today (PT):       " + today);
  console.log("Current period:   " + period.label + " (" + period.start + " → " + period.end + ")");
  console.log("");

  // 1) The specific backfilled session
  const target = await db.collection("pioneer_service_sessions")
    .doc("dSYurQMoxs3cLLjHB9NI").get();
  console.log("--- 1. Backfilled session (Nick / 6817 Cedar) ---");
  if (!target.exists) {
    console.log("(doc not found)");
  } else {
    const d = target.data();
    console.log("doc id:            dSYurQMoxs3cLLjHB9NI");
    console.log("status:            " + d.status);
    console.log("dcr_id:            " + d.dcr_id);
    console.log("dcr_submission_id: " + d.dcr_submission_id);
    console.log("dcr_status:        " + d.dcr_status);
    console.log("dcr_submitted_at:  " + (d.dcr_submitted_at ? "set" : "absent"));
    console.log("work_minutes:      " + d.work_minutes);
    console.log("needs_review:      " + d.needs_review);
    console.log("payroll_state:     " + (d.payroll_state || "(absent — treated as pending_review)"));
    console.log("admin_removed:     " + (d.admin_removed === true ? "true" : "false"));
    console.log("assignment_id:     " + d.assignment_id);
    console.log("service_date:      " + d.service_date);
    const gate = approveGate(d);
    console.log("Approve gate:      " + (gate.pass ? "✅ PASSES — Approve button should appear" : "❌ blocked: " + gate.reason));
  }
  console.log("");

  // 2) All sessions in current pay period — Verification Layer simulation
  console.log("--- 2. Verification Layer simulation for " + period.label + " ---");
  const snap = await db.collection("pioneer_service_sessions")
    .where("service_date", ">=", period.start)
    .where("service_date", "<=", period.end)
    .get();
  const sessions = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
  const nonArchived = sessions.filter(s => s.admin_removed !== true);

  let needs_review = 0, active = 0, dcr_pending = 0, missing_clockout = 0;
  let approved = 0, exported = 0, pending = 0, reviewed = 0;
  const approvable = [];
  nonArchived.forEach(s => {
    if (s.needs_review === true) needs_review += 1;
    if (s.status === "active" || s.status === "paused") active += 1;
    if (dcrPending(s)) dcr_pending += 1;
    if (s.status === "completed" && !s.clock_out_at) missing_clockout += 1;
    const ps = s.payroll_state || "pending_review";
    if (ps === "approved_for_payroll") approved += 1;
    else if (ps === "exported") exported += 1;
    else if (ps === "reviewed") reviewed += 1;
    else pending += 1;
    const g = approveGate(s);
    if (g.pass) approvable.push(s._id);
  });

  console.log("Sessions in period (non-archived): " + nonArchived.length);
  console.log("Payroll states: pending=" + pending + ", reviewed=" + reviewed +
              ", approved=" + approved + ", exported=" + exported);
  console.log("");
  console.log("Blockers:");
  console.log("  needs_review:      " + needs_review);
  console.log("  active sessions:   " + active);
  console.log("  dcr_pending:       " + dcr_pending);
  console.log("  missing clock-out: " + missing_clockout);
  const totalBlockers = needs_review + active + dcr_pending + missing_clockout;
  console.log("");

  if (totalBlockers === 0 && approved > 0) {
    console.log(">>> Verification Banner: 🟢 PAYROLL READY (Export button enabled)");
  } else if (totalBlockers > 0) {
    console.log(">>> Verification Banner: 🟡 BLOCKED — Export disabled");
  } else if (approved === 0) {
    console.log(">>> Verification Banner: ⚪ NO APPROVED SESSIONS — click Approve in Labor first");
  }
  console.log("");
  console.log("Sessions whose Approve gate currently PASSES: " + approvable.length);
  if (approvable.length) {
    console.log("  IDs:");
    approvable.forEach(id => console.log("    - " + id));
  }
  console.log("");
  console.log("--- 3. Recent payroll_exports for this period ---");
  const exSnap = await db.collection("payroll_exports").orderBy("generated_at", "desc").limit(10).get().catch(() => null);
  if (!exSnap || exSnap.empty) {
    console.log("(none yet)");
  } else {
    exSnap.docs.forEach(d => {
      const e = d.data();
      console.log("  " + d.id + " · " + e.status + " · " +
        e.range_start + "→" + e.range_end + " · " +
        e.session_count + " sess · " + e.total_paid_hours + "h · by " + e.generated_by_email);
    });
  }
})().catch(err => { console.error(err); process.exit(1); });
