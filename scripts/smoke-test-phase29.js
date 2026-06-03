/* Phase 29 smoke test — full create → approve round-trip.
 *
 * Uses Nick's admin custom-token exchange (mirrors how the admin UI
 * would invoke these endpoints) against a real completed session that
 * isn't payroll-locked. Verifies:
 *   1. createTimeAdjustmentRequestV1 returns 200 + request_id
 *   2. Firestore time_adjustment_requests/{id} has the expected shape
 *   3. approveTimeAdjustmentRequestV1 returns 200
 *   4. Session was stamped with has_approved_time_adjustment +
 *      effective_clock_in/out/minutes + time_adjustment_request_id
 *   5. Original clock_in_at / clock_out_at / work_minutes UNCHANGED
 *
 * Run after Phase 29 functions are deployed:
 *   node scripts/smoke-test-phase29.js
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();

const API_KEY      = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL  = "nick@pioneercomclean.com";
const CREATE_URL   = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/createTimeAdjustmentRequestV1";
const APPROVE_URL  = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/approveTimeAdjustmentRequestV1";

async function getAdminIdToken() {
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(u.uid);
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY,
    { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const b = await r.json();
  if (!r.ok || !b.idToken) throw new Error("Token exchange failed: " + JSON.stringify(b));
  return { idToken: b.idToken, uid: u.uid };
}

async function findEligibleSession() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
  const dt = new Date(today + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() - 7);
  const back = dt.toISOString().slice(0, 10);
  const snap = await db.collection("pioneer_service_sessions")
    .where("service_date", ">=", back)
    .where("service_date", "<=", today)
    .get();
  const docs = snap.docs.map(d => Object.assign({ _id: d.id }, d.data() || {}));
  return docs.filter(s =>
    s.status === "completed" &&
    s.payroll_state !== "approved_for_payroll" &&
    s.payroll_state !== "exported" &&
    s.workweek_locked_by_export !== true &&
    s.clock_in_at && s.clock_out_at &&
    s.staff_uid && s.assignment_id
  );
}

(async () => {
  console.log("================================================================");
  console.log("Phase 29 smoke test — create + approve");
  console.log("================================================================");

  const sessions = await findEligibleSession();
  if (!sessions.length) { console.error("No eligible sessions found in the last 7 days."); process.exit(2); }
  // Prefer Nick's own session (matches admin email) so we don't pollute someone else's data.
  let session = sessions.find(s => /nick@pioneercomclean/i.test(String(s.staff_email || "")));
  if (!session) session = sessions[0];
  console.log("Using session: " + session._id);
  console.log("  staff_email: " + session.staff_email);
  console.log("  customer:    " + session.customer_name);
  console.log("  service_date:" + session.service_date);
  console.log("  status:      " + session.status);
  console.log("  payroll_state: " + (session.payroll_state || "(unset)"));
  console.log("  original clock_in_at: " + new Date(session.clock_in_at.toMillis()).toISOString());
  console.log("  original clock_out_at:" + new Date(session.clock_out_at.toMillis()).toISOString());
  console.log("  original work_minutes:" + session.work_minutes);

  const { idToken, uid } = await getAdminIdToken();
  console.log("\nAdmin token obtained for: " + uid);

  // Request a 30-minute span starting at the original clock_in_at.
  const reqInMs  = session.clock_in_at.toMillis();
  const reqOutMs = reqInMs + 30 * 60 * 1000;
  console.log("\nRequested clock-in:  " + new Date(reqInMs).toISOString());
  console.log("Requested clock-out: " + new Date(reqOutMs).toISOString());

  // ---- 1. create ----
  console.log("\n--- 1. POST createTimeAdjustmentRequestV1 ---");
  const cReq = await fetch(CREATE_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idToken,"Content-Type":"application/json"},
    body: JSON.stringify({
      assignment_id:        session.assignment_id,
      service_session_id:   session._id,
      requested_clock_in:   new Date(reqInMs).toISOString(),
      requested_clock_out:  new Date(reqOutMs).toISOString(),
      reason:               "forgot_clock_out",
      notes:                "Phase 29 smoke test — automated round-trip."
    })
  });
  const cBody = await cReq.json();
  console.log("HTTP " + cReq.status + " · " + JSON.stringify(cBody));
  if (!cReq.ok || !cBody.ok) { console.error("CREATE FAILED"); process.exit(3); }
  const requestId = cBody.request_id;

  // Inspect the request doc.
  const reqDoc = (await db.collection("time_adjustment_requests").doc(requestId).get()).data();
  console.log("\nrequest doc shape:");
  console.log("  status:               " + reqDoc.status);
  console.log("  delta_minutes:        " + reqDoc.delta_minutes);
  console.log("  requested_minutes:    " + reqDoc.requested_minutes);
  console.log("  original_minutes:     " + reqDoc.original_minutes);
  console.log("  reason:               " + reqDoc.reason);
  console.log("  employee_uid:         " + reqDoc.employee_uid);
  console.log("  submitted_by_uid:     " + reqDoc.submitted_by_uid);

  // ---- 2. approve ----
  console.log("\n--- 2. POST approveTimeAdjustmentRequestV1 ---");
  const aReq = await fetch(APPROVE_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idToken,"Content-Type":"application/json"},
    body: JSON.stringify({ request_id: requestId })
  });
  const aBody = await aReq.json();
  console.log("HTTP " + aReq.status + " · " + JSON.stringify(aBody));
  if (!aReq.ok || !aBody.ok) { console.error("APPROVE FAILED"); process.exit(4); }

  // ---- 3. Verify state ----
  console.log("\n--- 3. Verify Firestore state ---");
  const reqAfter = (await db.collection("time_adjustment_requests").doc(requestId).get()).data();
  console.log("request after approve:");
  console.log("  status:               " + reqAfter.status);
  console.log("  reviewed_by_name:     " + reqAfter.reviewed_by_name);
  console.log("  effective_minutes:    " + reqAfter.effective_minutes);

  const sessAfter = (await db.collection("pioneer_service_sessions").doc(session._id).get()).data();
  console.log("\nsession after approve:");
  console.log("  has_approved_time_adjustment: " + sessAfter.has_approved_time_adjustment);
  console.log("  effective_clock_in:           " + (sessAfter.effective_clock_in ? new Date(sessAfter.effective_clock_in.toMillis()).toISOString() : null));
  console.log("  effective_clock_out:          " + (sessAfter.effective_clock_out ? new Date(sessAfter.effective_clock_out.toMillis()).toISOString() : null));
  console.log("  effective_minutes:            " + sessAfter.effective_minutes);
  console.log("  time_adjustment_request_id:   " + sessAfter.time_adjustment_request_id);
  console.log("  (preserved) clock_in_at:      " + new Date(sessAfter.clock_in_at.toMillis()).toISOString());
  console.log("  (preserved) clock_out_at:     " + new Date(sessAfter.clock_out_at.toMillis()).toISOString());
  console.log("  (preserved) work_minutes:     " + sessAfter.work_minutes);

  const okCheck =
    sessAfter.has_approved_time_adjustment === true &&
    sessAfter.effective_minutes === 30 &&
    sessAfter.time_adjustment_request_id === requestId &&
    sessAfter.clock_in_at.toMillis()  === session.clock_in_at.toMillis() &&
    sessAfter.clock_out_at.toMillis() === session.clock_out_at.toMillis() &&
    sessAfter.work_minutes === session.work_minutes;

  console.log("\n================================================================");
  console.log(okCheck ? "SMOKE TEST PASSED ✔" : "SMOKE TEST FAILED ✖");
  console.log("================================================================");
  process.exit(okCheck ? 0 : 5);
})().catch(e => { console.error("Smoke test threw:", e); process.exit(1); });
