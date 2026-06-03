/* Phase 29A retest — A (approved → payroll +30m) + B (denied → unchanged) +
 * C (direct client write to status fails with permission-denied).
 *
 * Reuses Nick's admin token for create / approve / deny. For Test C, we
 * exchange Nick's custom token to get an actual Firebase Web SDK session
 * (admin role), then attempt a direct doc update — should be denied by
 * the new rule (`allow update: if false`).
 *
 * After each leg, the script re-seeds a clean Phase 29 QA session via
 * scripts/seed-phase29-qa-shift.js so the next leg starts from a known
 * baseline (work_minutes=60, no adjustment).
 *
 *   node scripts/retest-phase29a.js
 */
"use strict";
const admin = require("firebase-admin");
const { execSync } = require("child_process");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();

const API_KEY      = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL  = "nick@pioneercomclean.com";
const CREATE_URL   = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/createTimeAdjustmentRequestV1";
const APPROVE_URL  = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/approveTimeAdjustmentRequestV1";
const DENY_URL     = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/denyTimeAdjustmentRequestV1";

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}

async function getAdminIdToken() {
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(u.uid);
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY,
    { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const b = await r.json();
  if (!r.ok || !b.idToken) throw new Error("Token exchange failed: " + JSON.stringify(b));
  return { idToken: b.idToken, refreshToken: b.refreshToken, uid: u.uid };
}

function reseed() {
  execSync("node scripts/seed-phase29-qa-shift.js", { stdio: "inherit" });
}

async function totalMinutesForNickToday() {
  // Sum effective_minutes-aware total for Nick today, EXCLUDING is_test.
  // Mirrors the Phase 29A summary logic to prove the read-time math.
  const day = todayPT();
  const snap = await db.collection("pioneer_service_sessions")
    .where("staff_uid", "==", "5iCiuypPKFWqzdzxUF3SLh2Uf9t2")
    .where("service_date", "==", day)
    .get();
  let totalIncl = 0, totalExcl = 0;
  snap.docs.forEach(d => {
    const s = d.data();
    const mins = (s.has_approved_time_adjustment === true && typeof s.effective_minutes === "number")
      ? s.effective_minutes
      : (typeof s.work_minutes === "number" ? s.work_minutes : 0);
    totalIncl += mins;
    if (s.is_test === true || s.exclude_from_payroll_export === true) return;
    totalExcl += mins;
  });
  return { totalIncludingQa: totalIncl, totalExcludingQa: totalExcl };
}

(async () => {
  console.log("================================================================");
  console.log("Phase 29A retest");
  console.log("================================================================");

  const today = todayPT();
  console.log("Today PT: " + today);

  /* ---------- TEST A — approved request shifts payroll totals ---------- */
  console.log("\n=== TEST A — approved request +30m moves total from 60→90 ===");
  reseed();
  const sessId = "sess__phase29_qa__" + today.replace(/-/g, "_");
  const asgnId = "sa__phase29_qa__"   + today.replace(/-/g, "_");

  // Clear the is_test marker on the seed so the read-time summary sees it.
  // (The real QA flow reads the QA session — for the retest we have to flip
  // is_test off so the summary doesn't auto-skip it.)
  await db.collection("pioneer_service_sessions").doc(sessId).update({
    is_test: false, exclude_from_payroll_export: false
  });

  const beforeA = await totalMinutesForNickToday();
  console.log("Baseline minutes (effective-aware, excluding QA-tagged): " + beforeA.totalExcludingQa);

  const { idToken } = await getAdminIdToken();
  // Build clock times for the existing session
  const sessSnap = await db.collection("pioneer_service_sessions").doc(sessId).get();
  const s = sessSnap.data();
  const origIn  = s.clock_in_at.toMillis();
  const reqInMs  = origIn;
  const reqOutMs = origIn + 90 * 60 * 1000;   // +30 min on top of the 60m baseline = 90m total

  const cRes = await fetch(CREATE_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idToken,"Content-Type":"application/json"},
    body: JSON.stringify({
      assignment_id:        asgnId,
      service_session_id:   sessId,
      requested_clock_in:   new Date(reqInMs).toISOString(),
      requested_clock_out:  new Date(reqOutMs).toISOString(),
      reason:               "forgot_clock_out",
      notes:                "Phase 29A retest A — approved adjustment to 90 minutes."
    })
  });
  const cBody = await cRes.json();
  if (!cRes.ok) { console.error("CREATE A failed: " + JSON.stringify(cBody)); process.exit(2); }
  const reqId = cBody.request_id;
  console.log("Created request: " + reqId);

  const aRes = await fetch(APPROVE_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idToken,"Content-Type":"application/json"},
    body: JSON.stringify({ request_id: reqId })
  });
  const aBody = await aRes.json();
  if (!aRes.ok) { console.error("APPROVE A failed: " + JSON.stringify(aBody)); process.exit(3); }
  console.log("Approved · effective_minutes = " + aBody.effective_minutes);

  const afterA = await totalMinutesForNickToday();
  console.log("After approve (effective-aware, excluding QA-tagged): " + afterA.totalExcludingQa);
  const passA = (afterA.totalExcludingQa - beforeA.totalExcludingQa) === 30 && afterA.totalExcludingQa === 90;
  console.log(passA ? "✔ TEST A PASSED" : "✖ TEST A FAILED");

  // Also verify originals preserved on session
  const sAfter = (await db.collection("pioneer_service_sessions").doc(sessId).get()).data();
  console.log("  preserved work_minutes:  " + sAfter.work_minutes  + " (must be 60)");
  console.log("  preserved clock_in_at:   " + new Date(sAfter.clock_in_at.toMillis()).toISOString());
  console.log("  preserved clock_out_at:  " + new Date(sAfter.clock_out_at.toMillis()).toISOString());
  console.log("  effective_minutes:       " + sAfter.effective_minutes + " (must be 90)");
  const passAOriginals = sAfter.work_minutes === 60 && sAfter.effective_minutes === 90;
  console.log(passAOriginals ? "  ✔ originals preserved" : "  ✖ originals broken");

  /* ---------- TEST B — denied request doesn't affect payroll ---------- */
  console.log("\n=== TEST B — denied request leaves total at 60 ===");
  reseed();
  await db.collection("pioneer_service_sessions").doc(sessId).update({
    is_test: false, exclude_from_payroll_export: false
  });
  const beforeB = await totalMinutesForNickToday();
  console.log("Baseline minutes: " + beforeB.totalExcludingQa);

  const { idToken: idTokenB } = await getAdminIdToken();
  const sB = (await db.collection("pioneer_service_sessions").doc(sessId).get()).data();
  const origInB = sB.clock_in_at.toMillis();
  const cResB = await fetch(CREATE_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idTokenB,"Content-Type":"application/json"},
    body: JSON.stringify({
      assignment_id:        asgnId,
      service_session_id:   sessId,
      requested_clock_in:   new Date(origInB).toISOString(),
      requested_clock_out:  new Date(origInB + 120 * 60 * 1000).toISOString(),  // request 120m (huge bump)
      reason:               "other",
      notes:                "Phase 29A retest B — request to be denied."
    })
  });
  const cBodyB = await cResB.json();
  if (!cResB.ok) { console.error("CREATE B failed: " + JSON.stringify(cBodyB)); process.exit(4); }
  console.log("Created request: " + cBodyB.request_id);

  const dRes = await fetch(DENY_URL, {
    method:"POST",
    headers:{"Authorization":"Bearer "+idTokenB,"Content-Type":"application/json"},
    body: JSON.stringify({ request_id: cBodyB.request_id, denial_reason: "Phase 29A retest — denial test." })
  });
  const dBody = await dRes.json();
  if (!dRes.ok) { console.error("DENY failed: " + JSON.stringify(dBody)); process.exit(5); }
  console.log("Denied.");

  const afterB = await totalMinutesForNickToday();
  console.log("After deny: " + afterB.totalExcludingQa);
  const passB = afterB.totalExcludingQa === beforeB.totalExcludingQa && afterB.totalExcludingQa === 60;
  console.log(passB ? "✔ TEST B PASSED" : "✖ TEST B FAILED");

  // Verify session is clean
  const sAfterB = (await db.collection("pioneer_service_sessions").doc(sessId).get()).data();
  const passBClean =
    !sAfterB.has_approved_time_adjustment && !sAfterB.effective_minutes;
  console.log(passBClean ? "  ✔ session not stamped with effective_*" : "  ✖ session was contaminated by denied request");

  /* ---------- TEST C — direct client write to status is denied ---------- */
  console.log("\n=== TEST C — direct client update to status FAILS ===");
  // Use Nick's admin web-SDK token to attempt a direct REST update.
  const { idToken: idTokenC } = await getAdminIdToken();
  // Pick an existing request id — the retained QA approved one is fine.
  const targetId = "fvgOBLTan7t3vYVab0LH";
  // Firestore REST patch URL — equivalent to client SDK `.update()`.
  const patchUrl = "https://firestore.googleapis.com/v1/projects/pioneer-dcr-hub/databases/(default)/documents/time_adjustment_requests/" +
                   targetId + "?updateMask.fieldPaths=status";
  const patchRes = await fetch(patchUrl, {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + idTokenC, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { status: { stringValue: "approved" } } })
  });
  const patchBody = await patchRes.json().catch(() => ({}));
  console.log("PATCH HTTP " + patchRes.status);
  console.log("body: " + JSON.stringify(patchBody).slice(0, 280));
  const passC = patchRes.status === 403 ||
                (patchBody && patchBody.error && /permission|denied/i.test(JSON.stringify(patchBody.error)));
  console.log(passC ? "✔ TEST C PASSED (permission-denied as expected)" : "✖ TEST C FAILED (write was accepted!)");

  /* ---------- Cleanup ---------- */
  // Re-stamp the seed session as a QA session so it stays out of payroll.
  await db.collection("pioneer_service_sessions").doc(sessId).update({
    is_test: true, exclude_from_payroll_export: true,
    has_approved_time_adjustment: false,
    effective_clock_in: null, effective_clock_out: null,
    effective_minutes: null, time_adjustment_request_id: null
  });
  console.log("\nReset QA session to is_test=true (kept retained_for_audit).");

  /* ---------- Summary ---------- */
  console.log("\n================================================================");
  console.log("TEST A (approved → payroll +30m):       " + (passA && passAOriginals ? "✔ PASS" : "✖ FAIL"));
  console.log("TEST B (denied  → payroll unchanged):   " + (passB && passBClean    ? "✔ PASS" : "✖ FAIL"));
  console.log("TEST C (direct client write denied):    " + (passC                  ? "✔ PASS" : "✖ FAIL"));
  console.log("================================================================");
  process.exit((passA && passAOriginals && passB && passBClean && passC) ? 0 : 1);
})().catch(e => { console.error("Retest threw:", e); process.exit(1); });
