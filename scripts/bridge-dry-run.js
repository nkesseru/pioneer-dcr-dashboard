/* Pioneer DCR Hub — Phase 2A.1 bridge dry-run.
 *
 * Standalone CLI that reads the same logic the Cloud Function uses, but
 * runs locally via the Admin SDK so you can verify mapping decisions
 * before hitting the HTTPS endpoint in production.
 *
 * Default behavior is DRY_RUN=true — no Firestore writes happen unless
 * you explicitly set DRY_RUN=false. Even then, the script does the same
 * idempotent operations the function does (so re-running is a no-op).
 *
 * Usage:
 *   node scripts/bridge-dry-run.js                            # dry-run, today (Pacific)
 *   SYNC_DATE=2026-06-01 node scripts/bridge-dry-run.js       # dry-run, specific date
 *   DAYS_FORWARD=2 node scripts/bridge-dry-run.js             # dry-run, today + 2 days
 *   DRY_RUN=false node scripts/bridge-dry-run.js              # commit writes
 *
 * Reuses scripts/lib/semi-monthly.js for the Pacific-date helper so the
 * weekday math matches the function exactly.
 */

"use strict";

const admin = require("firebase-admin");
const lib   = require("./lib/semi-monthly.js");

const TIMEZONE             = "America/Los_Angeles";
const BRIDGE_SOURCE_TAG    = "deputy_bridge_v1";
const BRIDGE_DOC_ID_PREFIX = "sa_deputy__";
const BRIDGE_LATE_STATUSES = ["in_progress", "paused", "dcr_pending", "completed"];
const BRIDGE_GRACE_HOURS   = 6;

const DRY_RUN      = process.env.DRY_RUN !== "false";
const SYNC_DATE    = process.env.SYNC_DATE || null;
const DAYS_FORWARD = Math.max(0, Math.min(30, parseInt(process.env.DAYS_FORWARD || "0", 10)));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

function pacificWeekday(date) {
  try {
    const wk = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(date);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wk];
  } catch (_e) { return null; }
}
function isoPacificDateAt17(yyyyMmDd) {
  const probe = new Date(yyyyMmDd + "T12:00:00Z");
  const pacificHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(probe), 10);
  const offsetHours = 12 - pacificHour;
  return yyyyMmDd + "T17:00:00-" + String(Math.abs(offsetHours)).padStart(2, "0") + ":00";
}
function addDays(yyyyMmDd, days) {
  const base = new Date(yyyyMmDd + "T12:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
function makeAssignmentId(shift) {
  const sid = shift.shift_id;
  if (sid !== undefined && sid !== null && String(sid).length > 0 && Number(sid) !== 0) {
    return BRIDGE_DOC_ID_PREFIX + String(sid);
  }
  const techKey = String(shift.employee_slug || shift.employee_email || "unknown_tech")
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const custKey = String(shift.customer_slug || "unknown_customer")
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return "sa__" + shift.sync_date + "__" + techKey + "__" + custKey;
}
async function resolveUid(email, cache) {
  if (!email) return null;
  const key = String(email).toLowerCase().trim();
  if (cache[key] !== undefined) return cache[key];
  try {
    const user = await admin.auth().getUserByEmail(key);
    cache[key] = user.uid;
    return user.uid;
  } catch (_e) { cache[key] = null; return null; }
}
async function hasLiveOrCompletedSession(assignmentId) {
  try {
    const snap = await db.collection("pioneer_service_sessions")
      .where("assignment_id", "==", assignmentId)
      .where("status", "in", BRIDGE_LATE_STATUSES)
      .limit(1).get();
    return !snap.empty;
  } catch (_e) { return true; }
}
function computeAvailableFrom(startTime, syncDate, flexPolicy) {
  if (!flexPolicy || !startTime) return startTime || null;
  let dt;
  try { dt = startTime.toDate ? startTime.toDate() : new Date(startTime); }
  catch (_e) { return startTime; }
  const wk = pacificWeekday(dt);
  if (wk == null) return startTime;
  if (flexPolicy === "sun_to_fri_evening" && wk === 0) {
    return admin.firestore.Timestamp.fromDate(new Date(isoPacificDateAt17(addDays(syncDate, -2))));
  }
  if (flexPolicy === "weekend_to_thu_evening" && (wk === 0 || wk === 6)) {
    const offset = (wk === 0) ? -3 : -2;
    return admin.firestore.Timestamp.fromDate(new Date(isoPacificDateAt17(addDays(syncDate, offset))));
  }
  return startTime;
}
function computeAvailableUntil(endTime) {
  if (!endTime) return null;
  let dt;
  try { dt = endTime.toDate ? endTime.toDate() : new Date(endTime); }
  catch (_e) { return endTime; }
  return admin.firestore.Timestamp.fromMillis(dt.getTime() + BRIDGE_GRACE_HOURS * 3600 * 1000);
}

(async () => {
  const startDate = SYNC_DATE || lib.pacificDateString();
  const dates = [];
  for (let i = 0; i <= DAYS_FORWARD; i++) dates.push(addDays(startDate, i));

  console.log("--- Pioneer DCR Hub: Deputy → service_assignments bridge (dry-run capable) ---");
  console.log("DRY_RUN:    ", DRY_RUN);
  console.log("SYNC_DATE:  ", startDate, DAYS_FORWARD ? "(+" + DAYS_FORWARD + " days)" : "");
  console.log("Dates:      ", dates.join(", "));
  console.log("------------------------------------------------------------------------------");

  const sts = admin.firestore.FieldValue.serverTimestamp();
  const uidCache = {};
  const custCache = {};

  const counts = {
    shifts_seen: 0, created: 0, updated_assigned: 0, refreshed_late: 0, cancelled: 0,
    customer_unresolved: 0, uid_unresolved: 0, no_email: 0,
    protected_session: 0, cancelled_no_doc: 0, cancelled_locked: 0
  };

  for (const date of dates) {
    const snap = await db.collection("deputy_shift_cache").where("sync_date", "==", date).get();
    const shifts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
    counts.shifts_seen += shifts.length;
    console.log("\n[" + date + "] " + shifts.length + " Deputy shift(s)");

    for (const shift of shifts) {
      const shiftIdStr = String(shift.shift_id || shift.id || "");
      const cancelled = String(shift.status || "") === "cancelled";

      if (!shift.customer_slug) {
        counts.customer_unresolved += 1;
        console.log("  [SKIP customer_unresolved] shift " + shiftIdStr + " (deputy_company_name=" + (shift.deputy_company_name || "—") + ")");
        continue;
      }
      if (!shift.employee_email) {
        counts.no_email += 1;
        console.log("  [SKIP no_email] shift " + shiftIdStr);
        continue;
      }

      const aid = makeAssignmentId(shift);
      const aref = db.collection("service_assignments").doc(aid);
      const existing = await aref.get();

      if (cancelled) {
        if (!existing.exists) { counts.cancelled_no_doc += 1; console.log("  [SKIP cancelled_no_doc] " + aid); continue; }
        const data = existing.data() || {};
        const lateStatus = BRIDGE_LATE_STATUSES.indexOf(data.status || "") >= 0;
        const hasLive = await hasLiveOrCompletedSession(aid);
        if (lateStatus || hasLive) { counts.cancelled_locked += 1; console.log("  [SKIP cancelled_locked] " + aid); continue; }
        if (!DRY_RUN) {
          await aref.update({
            status: "canceled_by_deputy",
            status_changed_at: sts, status_changed_by: BRIDGE_SOURCE_TAG,
            updated_at: sts, updated_by: BRIDGE_SOURCE_TAG
          });
        }
        counts.cancelled += 1;
        console.log("  [" + (DRY_RUN ? "DRY-RUN cancel" : "CANCEL") + "] " + aid);
        continue;
      }

      const uid = await resolveUid(shift.employee_email, uidCache);
      if (!uid) {
        counts.uid_unresolved += 1;
        console.log("  [SKIP uid_unresolved] " + shift.employee_email + " (shift " + shiftIdStr + ")");
        continue;
      }
      let cust = custCache[shift.customer_slug];
      if (cust === undefined) {
        const csn = await db.collection("customers").doc(shift.customer_slug).get();
        cust = csn.exists ? (csn.data() || {}) : null;
        custCache[shift.customer_slug] = cust;
      }
      const flex   = (cust && cust.flex_start_policy) || null;
      const budget = (cust && typeof cust.service_budget_minutes === "number") ? cust.service_budget_minutes : null;
      const start  = shift.start_time || null;
      const end    = shift.end_time || null;
      let est = null;
      if (start && end) {
        const sMs = start.toMillis ? start.toMillis() : new Date(start).getTime();
        const eMs = end.toMillis   ? end.toMillis()   : new Date(end).getTime();
        if (eMs > sMs) est = Math.round((eMs - sMs) / 60000);
      }
      if (est == null) est = 90;
      const availFrom  = computeAvailableFrom(start, date, flex);
      const availUntil = computeAvailableUntil(end);

      const mapping = {
        service_date:          date,
        staff_uid:             uid,
        staff_email:           String(shift.employee_email).toLowerCase().trim(),
        staff_display_name:    shift.employee_display_name || "",
        customer_id:           shift.customer_slug,
        customer_name:         shift.customer_name || "",
        location_id:           null, location_name: null, location_address: null,
        location_lat:          null, location_lon: null, location_geofence_radius_m: null,
        service_window_start:  start, service_deadline: end,
        estimated_minutes:     est, budget_minutes: budget,
        allows_flex_start:     true,
        available_from:        availFrom, available_until: availUntil,
        schedule_policy:       flex,
        deputy_shift_id:       Number(shift.shift_id) || null,
        source:                "deputy_bridge",
        updated_at:            sts, updated_by: BRIDGE_SOURCE_TAG
      };

      if (!existing.exists) {
        const payload = Object.assign({}, mapping, {
          assignment_id: aid, status: "assigned",
          status_changed_at: sts, status_changed_by: BRIDGE_SOURCE_TAG,
          session_id: null, dcr_submission_id: null,
          created_at: sts, created_by: BRIDGE_SOURCE_TAG, assigned_by: BRIDGE_SOURCE_TAG,
          notes: "Auto-created from Deputy shift " + shiftIdStr
        });
        if (!DRY_RUN) await aref.set(payload);
        counts.created += 1;
        console.log("  [" + (DRY_RUN ? "DRY-RUN create" : "CREATE") + "] " + aid + " — " +
          (shift.customer_name || shift.customer_slug) + " · uid=" + uid + " · est=" + est + "m · budget=" + (budget == null ? "null" : budget + "m"));
        continue;
      }
      const data = existing.data() || {};
      const lateStatus = BRIDGE_LATE_STATUSES.indexOf(data.status || "") >= 0;
      const hasLive = lateStatus ? true : await hasLiveOrCompletedSession(aid);
      if (lateStatus || hasLive) {
        const safe = Object.assign({}, mapping);
        delete safe.staff_uid; delete safe.service_date;
        if (!DRY_RUN) await aref.update(safe);
        counts.refreshed_late += 1;
        console.log("  [" + (DRY_RUN ? "DRY-RUN refresh-late" : "REFRESH-LATE") + "] " + aid + " (status=" + (data.status || "?") + ")");
        continue;
      }
      const patch = Object.assign({}, mapping, {
        status: "assigned",
        status_changed_at: (data.status === "assigned") ? (data.status_changed_at || sts) : sts,
        status_changed_by: (data.status === "assigned") ? (data.status_changed_by || BRIDGE_SOURCE_TAG) : BRIDGE_SOURCE_TAG
      });
      if (!DRY_RUN) await aref.update(patch);
      counts.updated_assigned += 1;
      console.log("  [" + (DRY_RUN ? "DRY-RUN update" : "UPDATE") + "] " + aid + " (was status=" + (data.status || "?") + ")");
    }
  }

  console.log("\n--- Summary ---");
  console.log(JSON.stringify(counts, null, 2));
  if (DRY_RUN) console.log("\nDry-run complete. Re-run with DRY_RUN=false to commit.");
})().catch((err) => { console.error("bridge-dry-run failed:", err); process.exit(1); });
