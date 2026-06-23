/* Phase 29A spot-check — real CSV export against this week.
 *
 * Runs three back-to-back checks against the deployed payroll system:
 *
 *   1. QA-only range (today single-day) — expects "Nothing to export"
 *      so the is_test / exclude_from_payroll_export filter is proven
 *      against the live function (not just the read-time summary).
 *
 *   2. Range that includes a real blocker (needs_review) — expects
 *      HTTP 412 so the blocker guard is proven still alive after
 *      the Phase 29A payrollIsBlocker() update.
 *
 *   3. Single-day range with one real approved session — generates
 *      a real CSV, downloads + inspects it, then VOIDS immediately
 *      so the included session(s) revert to approved_for_payroll
 *      and the workweek lock comes off. Net state change: one
 *      payroll_exports audit doc lands with status="voided"; no
 *      session is permanently flipped to "exported".
 *
 * No QA records are flipped to is_test=false at any point. The QA
 * session stays out of payroll throughout.
 *
 *   node scripts/spot-check-phase29a-export.js
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();

const API_KEY      = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL  = "nick@pioneercomclean.com";
const EXPORT_URL   = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/exportPayrollCsvV1";
const VOID_URL     = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/voidPayrollExportV1";
const DOWNLOAD_URL = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/downloadPayrollExportCsvV1";

async function adminIdToken() {
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(u.uid);
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY,
    { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const b = await r.json();
  if (!r.ok || !b.idToken) throw new Error("Token exchange failed: " + JSON.stringify(b));
  return b.idToken;
}

async function postJSON(url, idToken, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

(async () => {
  console.log("================================================================");
  console.log("Phase 29A spot-check — real CSV export");
  console.log("================================================================");

  const idToken = await adminIdToken();

  /* ---------- CHECK 1 — QA-only range expects "Nothing to export" ---------- */
  console.log("\n=== CHECK 1: range 2026-06-03 to 2026-06-03 (only QA session present) ===");
  const r1 = await postJSON(EXPORT_URL, idToken, {
    range_start:  "2026-06-03",
    range_end:    "2026-06-03",
    period_label: "QA-exclusion spot-check"
  });
  console.log("HTTP " + r1.status + " · " + JSON.stringify(r1.body).slice(0, 200));
  const pass1 = r1.status === 400 && /Nothing to export/i.test(JSON.stringify(r1.body));
  console.log(pass1 ? "✔ PASS — QA session was excluded by the live filter" : "✖ FAIL — expected 400 Nothing to export");

  /* ---------- CHECK 2 — range with a real blocker expects 412 ---------- */
  console.log("\n=== CHECK 2: range 2026-06-01 to 2026-06-03 (2 needs_review blockers in range) ===");
  const r2 = await postJSON(EXPORT_URL, idToken, {
    range_start:  "2026-06-01",
    range_end:    "2026-06-03",
    period_label: "Blocker guard spot-check"
  });
  console.log("HTTP " + r2.status + " · " + JSON.stringify(r2.body).slice(0, 250));
  const pass2 = r2.status === 412 &&
                r2.body && r2.body.blockers &&
                r2.body.blockers.needs_review_count >= 2;
  console.log(pass2 ? "✔ PASS — blocker guard refused export with needs_review_count=" + r2.body.blockers.needs_review_count
                    : "✖ FAIL — expected 412 with needs_review_count ≥ 2");

  /* ---------- CHECK 3 — real single-day, generate CSV, then void ---------- */
  console.log("\n=== CHECK 3: range 2026-06-01 to 2026-06-01 (1 real approved session) ===");
  const r3 = await postJSON(EXPORT_URL, idToken, {
    range_start:  "2026-06-01",
    range_end:    "2026-06-01",
    period_label: "Phase 29A spot-check (will be voided)"
  });
  console.log("HTTP " + r3.status + " · " + JSON.stringify(r3.body).slice(0, 350));
  const exportId = r3.body && r3.body.export_id;
  if (r3.status !== 200 || !exportId) {
    console.error("✖ CSV generation failed — aborting check 3.");
    process.exit(3);
  }
  console.log("Generated export_id: " + exportId);

  // Download the CSV.
  const dlRes = await fetch(DOWNLOAD_URL + "?export_id=" + encodeURIComponent(exportId), {
    headers: { "Authorization": "Bearer " + idToken }
  });
  const csv = await dlRes.text();
  console.log("\n--- CSV preview (first 35 lines) ---");
  csv.split(/\r?\n/).slice(0, 35).forEach((ln, i) => console.log(String(i+1).padStart(3) + " | " + ln));
  console.log("...");

  // Validations:
  const hasAuditHeaders = /Time Adjusted\?/.test(csv) &&
                         /Original Clock In/.test(csv) &&
                         /Original Clock Out/.test(csv) &&
                         /Adjustment Minutes/.test(csv) &&
                         /Adjustment Reason/.test(csv) &&
                         /Approved By/.test(csv) &&
                         /Approved At/.test(csv);
  const sessionLineMatch = csv.split(/\r?\n/).find(l => /^[^,]+,makaila\.ann@live\.com/.test(l));
  const hasMakailaRow = !!sessionLineMatch;
  const noQaRow = !/phase29_qa|is_test|QA Test Location/i.test(csv);
  const includesGrandTotal = /Grand Total Paid Hours/.test(csv);

  console.log("\n--- validations ---");
  console.log("Has 7 Phase 29 audit headers:        " + (hasAuditHeaders ? "✔" : "✖"));
  console.log("Real Makaila row present:            " + (hasMakailaRow ? "✔" : "✖"));
  console.log("No QA / test rows in CSV:            " + (noQaRow ? "✔" : "✖"));
  console.log("Grand totals block emitted:          " + (includesGrandTotal ? "✔" : "✖"));
  if (hasMakailaRow) {
    console.log("Makaila row:");
    console.log("  " + sessionLineMatch);
  }

  // Now VOID immediately so Makaila's session reverts to approved_for_payroll.
  console.log("\n--- voiding export (state revert) ---");
  const vRes = await postJSON(VOID_URL, idToken, {
    export_id:   exportId,
    void_reason: "Phase 29A spot-check — automated immediate void to revert session state."
  });
  console.log("VOID HTTP " + vRes.status + " · " + JSON.stringify(vRes.body).slice(0, 200));

  // Re-read Makaila's session to confirm revert.
  const makailaSnap = await db.collection("pioneer_service_sessions").doc("dSYurQMoxs3cLLjHB9NI").get();
  const m = makailaSnap.data() || {};
  console.log("Makaila session after void:");
  console.log("  payroll_state:             " + m.payroll_state);
  console.log("  workweek_locked_by_export: " + m.workweek_locked_by_export);
  const reverted = m.payroll_state === "approved_for_payroll" &&
                   (m.workweek_locked_by_export === false || m.workweek_locked_by_export === undefined);
  console.log(reverted ? "✔ session state reverted cleanly" : "✖ session state NOT reverted — needs manual fix");

  const pass3 = r3.status === 200 && hasAuditHeaders && hasMakailaRow && noQaRow && includesGrandTotal &&
                vRes.status === 200 && vRes.body && vRes.body.ok && reverted;
  console.log("\n" + (pass3 ? "✔ CHECK 3 PASSED" : "✖ CHECK 3 FAILED"));

  console.log("\n================================================================");
  console.log("CHECK 1 (QA-only → Nothing to export):       " + (pass1 ? "✔ PASS" : "✖ FAIL"));
  console.log("CHECK 2 (range with blockers → HTTP 412):    " + (pass2 ? "✔ PASS" : "✖ FAIL"));
  console.log("CHECK 3 (real CSV + voided cleanly):         " + (pass3 ? "✔ PASS" : "✖ FAIL"));
  console.log("================================================================");
  process.exit((pass1 && pass2 && pass3) ? 0 : 1);
})().catch(e => { console.error("Spot-check threw:", e); process.exit(1); });
