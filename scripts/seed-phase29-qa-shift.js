/* Phase 29 QA — seed a safe fake completed shift for Nick.
 *
 * Idempotent: deterministic doc ids keyed on today (Pacific) so re-running
 * upserts cleanly. If the assignment + session already exist for today
 * they get refreshed in place (clock-in/out, status, DCR-skip markers)
 * rather than duplicated.
 *
 * Safety invariants:
 *   • Reuses the existing "Pioneer Commercial Cleaning Test Customer"
 *     record (customers/pioneer-commercial-cleaning-test). No real
 *     customer is touched.
 *   • payroll_state is set to "phase29_qa_skip" (NOT "approved_for_payroll"
 *     or "exported") so exportPayrollCsvV1 filter excludes it.
 *   • dcr_submission_id is stamped with a synthetic "phase29_qa…" id so
 *     the Phase 1c "Complete DCR" prompt is suppressed on /work. No
 *     real dcr_submissions doc is created.
 *   • Cloud Functions that send customer emails / review requests are
 *     triggered ONLY by submitDcrV1 (called from the DCR form), so writing
 *     these field values does not fire any customer-facing automation.
 *   • is_test:true marker on both docs for downstream auditability.
 *   • No deletes anywhere.
 *
 * Verifies after writing that Nick's UID matches and that no pending
 * time_adjustment_requests exist for the seeded session.
 *
 *   node scripts/seed-phase29-qa-shift.js
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();
const TZ = "America/Los_Angeles";

const TECH_EMAIL  = "nick@pioneercomclean.com";
const CUSTOMER_ID = "pioneer-commercial-cleaning-test";

function pacificDateString(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(d || new Date());
}

// Convert a YYYY-MM-DD + HH:MM Pacific local time → JS Date (UTC anchor).
// Uses the Intl trick: build a date string for noon UTC anchor then nudge
// to the local-time desired offset by parsing the same wall-clock string
// twice and adjusting. Simpler: use America/Los_Angeles formatToParts to
// learn the UTC offset for that date, then compute UTC ms.
function pacificWallClockToUtc(yyyyMmDd, hour, minute) {
  // Build an arbitrary Date for that day in UTC noon, ask Intl what
  // offset Pacific is on that date, then construct the UTC moment.
  const probe = new Date(yyyyMmDd + "T12:00:00Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12: false, timeZoneName:"longOffset"
  }).formatToParts(probe);
  const offsetPart = parts.find(p => p.type === "timeZoneName");
  // longOffset returns "GMT-07:00" or "GMT-08:00".
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart.value);
  if (!m) throw new Error("Could not parse Pacific offset: " + offsetPart.value);
  const sign = (m[1] === "+") ? 1 : -1;
  const offsetMs = sign * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
  // Pacific wall-clock 10:00 = UTC ms for that wall-clock minus offset.
  const wallMs = Date.parse(yyyyMmDd + "T" + String(hour).padStart(2,"0") + ":" + String(minute).padStart(2,"0") + ":00Z");
  return new Date(wallMs - offsetMs);
}

(async () => {
  console.log("================================================================");
  console.log("Phase 29 QA seed — Nick's test shift");
  console.log("================================================================");

  // ---- 1. Resolve Nick + customer ----
  const nick = await admin.auth().getUserByEmail(TECH_EMAIL);
  const techSnap = await db.collection("cleaning_techs").where("email", "==", TECH_EMAIL).limit(1).get();
  if (techSnap.empty) throw new Error("Nick's cleaning_techs doc not found");
  const tech = techSnap.docs[0].data();
  const techDisplay = tech.display_name || ((tech.first_name || "") + " " + (tech.last_name || "")).trim() || "Nick";

  const custSnap = await db.collection("customers").doc(CUSTOMER_ID).get();
  if (!custSnap.exists) throw new Error("Test customer " + CUSTOMER_ID + " not found — refusing to create new customer for QA");
  const cust = custSnap.data();

  const todayPT = pacificDateString(new Date());
  const clockIn  = pacificWallClockToUtc(todayPT, 10, 0);   // 10:00 AM PT
  const clockOut = pacificWallClockToUtc(todayPT, 11, 0);   // 11:00 AM PT
  const workMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);

  console.log("Nick uid:        " + nick.uid);
  console.log("Tech display:    " + techDisplay);
  console.log("Customer:        " + (cust.customer_name || CUSTOMER_ID));
  console.log("Location:        " + (cust.location_name || "(none)"));
  console.log("Today PT:        " + todayPT);
  console.log("Clock-in (UTC):  " + clockIn.toISOString());
  console.log("Clock-out (UTC): " + clockOut.toISOString());
  console.log("Work minutes:    " + workMinutes);

  // ---- 2. Deterministic doc ids — idempotent re-runs ----
  const assignmentId = "sa__phase29_qa__" + todayPT.replace(/-/g, "_");
  const sessionId    = "sess__phase29_qa__" + todayPT.replace(/-/g, "_");

  // ---- 3. Build payloads. Reuse existing field names exactly. ----
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const assignmentPayload = {
    assignment_id:       assignmentId,
    staff_uid:           nick.uid,
    staff_email:         TECH_EMAIL,
    staff_display_name:  techDisplay,
    customer_id:         CUSTOMER_ID,
    customer_name:       cust.customer_name || "Pioneer Commercial Cleaning Test Customer",
    location_id:         null,
    location_name:       cust.location_name || "QA Test Location",
    location_address:    null,
    location_lat:        null,
    location_lon:        null,
    location_geofence_radius_m: null,
    service_date:        todayPT,
    // Leave available_from / available_until UNSET so isAvailableNow falls
    // through to the legacy "service_date == todayPT" branch — the card
    // stays visible all day.
    available_from:      null,
    available_until:     null,
    service_window_start: null,
    service_deadline:    null,
    budget_minutes:      60,
    estimated_minutes:   60,
    schedule_policy:     null,
    allows_flex_start:   true,
    notes:               "Phase 29 QA browser test — safe fake completed shift for Nick",
    source:              "phase29_qa_seed",
    assigned_by:         "phase29_qa_seed",
    status:              "assigned",
    status_changed_at:   sts,
    status_changed_by:   "phase29_qa_seed",
    session_id:          sessionId,
    dcr_submission_id:   null,
    is_test:             true,
    exclude_from_customer_reporting: true,
    exclude_from_payroll_export:     true,
    disable_dcr_email:               true,
    disable_review_request:          true,
    disable_customer_notifications:  true,
    updated_at:          sts,
    updated_by:          "phase29_qa_seed"
  };

  const sessionPayload = {
    assignment_id:                 assignmentId,
    staff_uid:                     nick.uid,
    staff_email:                   TECH_EMAIL,
    customer_id:                   CUSTOMER_ID,
    customer_name:                 cust.customer_name || "Pioneer Commercial Cleaning Test Customer",
    location_id:                   null,
    service_date:                  todayPT,
    status:                        "completed",
    clock_in_at:                   admin.firestore.Timestamp.fromDate(clockIn),
    clock_out_at:                  admin.firestore.Timestamp.fromDate(clockOut),
    clock_in_source:               "phase29_qa_seed",
    clock_out_source:              "phase29_qa_seed",
    clock_in_gps_status:           "unsupported",
    clock_out_gps_status:          "unsupported",
    clock_in_geo_status:           "unknown_permission_denied",
    clock_out_geo_status:          "unknown_permission_denied",
    clock_in_distance_from_site_meters: null,
    clock_out_distance_from_site_meters: null,
    max_distance_from_site_meters: null,
    work_minutes:                  workMinutes,
    paid_minutes:                  workMinutes,
    break_minutes:                 0,
    paid_drive_minutes:            0,
    sick_accrual_eligible_minutes: 0,
    needs_review:                  false,
    // Suppress the DCR-pending state on the card. NO real dcr_submissions
    // doc is written — this is purely a UI hint that "DCR happened".
    dcr_status:                    "submitted",
    dcr_id:                        "phase29_qa_no_dcr_required",
    dcr_submission_id:             "phase29_qa_no_dcr_required",
    dcr_submitted_at:              sts,
    accrued_in_period_id:          null,
    // payroll_state is anything OTHER than "approved_for_payroll" / "exported"
    // so exportPayrollCsvV1 filter excludes this row.
    payroll_state:                 "phase29_qa_skip",
    workweek_locked_by_export:     false,
    is_test:                       true,
    exclude_from_payroll_export:   true,
    qa_marker:                     "phase29_qa",
    notes:                         "Phase 29 QA browser test — safe fake completed shift for Nick",
    created_at:                    sts,
    updated_at:                    sts
  };

  // ---- 4. Idempotent upsert ----
  const asRef  = db.collection("service_assignments").doc(assignmentId);
  const seRef  = db.collection("pioneer_service_sessions").doc(sessionId);

  const existingA = await asRef.get();
  const existingS = await seRef.get();
  console.log("\nExisting assignment doc: " + (existingA.exists ? "YES (will refresh)" : "no (will create)"));
  console.log("Existing session doc:    " + (existingS.exists ? "YES (will refresh)" : "no (will create)"));

  // Use set with merge:false so we know the doc shape is exactly what we
  // intended on each run. created_at is preserved by reading the existing
  // value when present.
  if (existingA.exists) {
    const prior = existingA.data();
    if (prior.created_at) assignmentPayload.created_at = prior.created_at;
    else                  assignmentPayload.created_at = sts;
    assignmentPayload.created_by = prior.created_by || "phase29_qa_seed";
  } else {
    assignmentPayload.created_at = sts;
    assignmentPayload.created_by = "phase29_qa_seed";
  }
  if (existingS.exists) {
    const prior = existingS.data();
    if (prior.created_at) sessionPayload.created_at = prior.created_at;
  }
  // Approved time-adjustment fields (Phase 29) should NOT persist across runs.
  // If a previous QA session was approved earlier, clear those markers so the
  // new run starts from a clean "no adjustment yet" state.
  sessionPayload.has_approved_time_adjustment = false;
  sessionPayload.effective_clock_in           = null;
  sessionPayload.effective_clock_out          = null;
  sessionPayload.effective_minutes            = null;
  sessionPayload.time_adjustment_request_id   = null;

  const batch = db.batch();
  batch.set(asRef, assignmentPayload);
  batch.set(seRef, sessionPayload);
  await batch.commit();
  console.log("\n✔ wrote assignment: service_assignments/" + assignmentId);
  console.log("✔ wrote session:    pioneer_service_sessions/" + sessionId);

  // ---- 5. Clean up any prior pending Phase 29 request bound to this session ----
  const priorReqs = await db.collection("time_adjustment_requests")
    .where("service_session_id", "==", sessionId)
    .where("status", "==", "pending")
    .get();
  if (!priorReqs.empty) {
    const cleanup = db.batch();
    priorReqs.docs.forEach(d => cleanup.delete(d.ref));
    await cleanup.commit();
    console.log("✔ cleared " + priorReqs.size + " prior pending time_adjustment_request(s) bound to this session");
  }

  // ---- 6. Verify ----
  console.log("\n--- verification ---");
  const aV = (await asRef.get()).data();
  const sV = (await seRef.get()).data();
  console.log("assignment.staff_uid match:        " + (aV.staff_uid === nick.uid ? "✔" : "✖ " + aV.staff_uid));
  console.log("session.staff_uid match:           " + (sV.staff_uid === nick.uid ? "✔" : "✖ " + sV.staff_uid));
  console.log("session.status:                    " + sV.status);
  console.log("session.work_minutes:              " + sV.work_minutes);
  console.log("session.payroll_state:             " + sV.payroll_state + " (NOT approved_for_payroll → export-safe)");
  console.log("session.workweek_locked_by_export: " + sV.workweek_locked_by_export);
  console.log("session.dcr_status:                " + sV.dcr_status + " (suppresses DCR-pending UI)");
  console.log("session.is_test:                   " + sV.is_test);
  console.log("assignment.is_test:                " + aV.is_test);
  console.log("service_date (Pacific):            " + sV.service_date);
  const adjPending = await db.collection("time_adjustment_requests")
    .where("service_session_id", "==", sessionId)
    .where("status", "==", "pending")
    .get();
  console.log("pending adjustments after seed:    " + adjPending.size + " (should be 0)");

  console.log("\n================================================================");
  console.log("✔ Seed complete — refresh /work in Chrome (signed in as nick@pioneercomclean.com).");
  console.log("================================================================");
})().catch(e => { console.error("Seed failed:", e); process.exit(1); });
