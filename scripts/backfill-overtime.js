/* Pioneer DCR Hub — Phase 28B overtime backfill.
 *
 * One-shot script that stamps `workweek_id` + `regular_minutes` +
 * `overtime_minutes` + `payable_work_minutes` + audit fields on every
 * approved-or-exported `pioneer_service_sessions` doc that doesn't yet
 * have them. Default is DRY_RUN=true — set DRY_RUN=false to commit.
 *
 * Phase 28B scope decisions baked in:
 *   • Workweek = Sunday 00:00 Pacific through Saturday 23:59 Pacific.
 *   • Overtime trigger = 40 hours of worked time per workweek (2400 min).
 *   • Sick leave is EXCLUDED from the OT calculation per the confirmed
 *     Pioneer policy. Sick leave is paid time off (RCW 49.46.130 +
 *     ES.A.8.1 administrative policy reading); sick minutes never enter
 *     the workweek bucket.
 *   • Paid drive time is NOT included in the OT calculation in this
 *     phase. The `payable_work_minutes` field name is intentional —
 *     a future phase can add `payable_drive_minutes` alongside without
 *     renaming anything.
 *   • Only backfills sessions with payroll_state IN
 *     {"approved_for_payroll", "exported"}. Pending sessions get
 *     workweek_id stamped on their next state change.
 *   • Allocation is chronological by clock_in_at. Sessions with
 *     work_minutes <= 0 (or null) are kept in the bucket order but
 *     contribute 0 to the budget AND receive regular_minutes=0,
 *     overtime_minutes=0 — they still get workweek_id stamped.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-overtime.js   # default; reports planned writes
 *   DRY_RUN=false node scripts/backfill-overtime.js   # commits writes in batches
 *
 * Optional:
 *   STAFF_UID=...    — limit to one tech (useful for incremental tests)
 *   WORKWEEK_ID=...  — limit to one workweek
 *   MAX_GROUPS=N     — cap how many (tech, workweek) buckets to process
 */

"use strict";

const admin = require("firebase-admin");

const DRY_RUN     = process.env.DRY_RUN !== "false";
const STAFF_UID   = process.env.STAFF_UID   || null;
const WORKWEEK_ID = process.env.WORKWEEK_ID || null;
const MAX_GROUPS  = process.env.MAX_GROUPS ? parseInt(process.env.MAX_GROUPS, 10) : null;
const TIMEZONE    = "America/Los_Angeles";
const WEEKLY_REGULAR_CAP = 2400; // 40h × 60m
const BACKFILL_TAG = "backfill-28b";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

/* ---------- Pacific-safe date helpers (parallel to tab-labor-review.js) ---------- */

function pacificDateString(d) {
  // YYYY-MM-DD in Pacific.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d || new Date());
}
function pacificWeekday(date) {
  // 0=Sun ... 6=Sat in Pacific timezone.
  const wk = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const v = map[wk];
  return (v === undefined) ? null : v;
}
function addDaysPT(yyyymmdd, days) {
  const parts = String(yyyymmdd || "").split("-");
  if (parts.length !== 3) return yyyymmdd;
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function computeWorkweekId(serviceDatePT) {
  if (!serviceDatePT) return null;
  const probe = new Date(serviceDatePT + "T12:00:00Z");
  const wk = pacificWeekday(probe);
  if (wk == null) return serviceDatePT;
  if (wk === 0) return serviceDatePT;
  return addDaysPT(serviceDatePT, -wk);
}
function computeWorkweekLabel(workweekId) {
  if (!workweekId) return null;
  const endId = addDaysPT(workweekId, 6);
  try {
    const fmtMonthDay = function (id) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE, month: "short", day: "numeric"
      }).format(new Date(id + "T12:00:00Z"));
    };
    const year = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE, year: "numeric"
    }).format(new Date(endId + "T12:00:00Z"));
    return fmtMonthDay(workweekId) + " – " + fmtMonthDay(endId) + ", " + year;
  } catch (_e) { return workweekId + " → " + endId; }
}

/* ---------- chronological allocation (pure function) ---------- */

function allocateOvertime(sortedSessions) {
  // Mutates each session with { regular_minutes, overtime_minutes,
  // payable_work_minutes }. Returns the bucket cumulative regular total.
  let cumulativeRegular = 0;
  sortedSessions.forEach(function (s) {
    const total = (typeof s.work_minutes === "number" && s.work_minutes > 0) ? s.work_minutes : 0;
    const budget = Math.max(0, WEEKLY_REGULAR_CAP - cumulativeRegular);
    let regular, overtime;
    if (total <= budget) {
      regular = total; overtime = 0;
    } else {
      regular = budget; overtime = total - budget;
    }
    s.regular_minutes      = regular;
    s.overtime_minutes     = overtime;
    s.payable_work_minutes = total;
    cumulativeRegular += regular;
  });
  return cumulativeRegular;
}

/* ---------- main ---------- */

(async () => {
  console.log("--- Pioneer DCR Hub: Phase 28B overtime backfill ---");
  console.log("DRY_RUN:          ", DRY_RUN);
  console.log("STAFF_UID filter: ", STAFF_UID || "(none — all techs)");
  console.log("WORKWEEK_ID filter:", WORKWEEK_ID || "(none — all weeks)");
  console.log("MAX_GROUPS cap:   ", MAX_GROUPS || "(none)");
  console.log("Cap:              ", WEEKLY_REGULAR_CAP + " min (40h)");
  console.log("----------------------------------------------------");

  // Load all approved_for_payroll OR exported sessions WHERE
  // workweek_id is missing OR regular_minutes is missing.
  // Firestore doesn't allow OR queries server-side without a workaround,
  // so we run two queries and dedupe in memory. For the pilot scale
  // (~hundreds of sessions) this is fine.
  const states = ["approved_for_payroll", "exported"];
  const seen = new Map();
  for (const state of states) {
    let q = db.collection("pioneer_service_sessions").where("payroll_state", "==", state);
    if (STAFF_UID) q = q.where("staff_uid", "==", STAFF_UID);
    const snap = await q.get();
    snap.docs.forEach(function (d) {
      const data = d.data() || {};
      const needsBackfill = !data.workweek_id || (typeof data.regular_minutes !== "number");
      if (!needsBackfill) return;
      // Apply optional WORKWEEK_ID filter on the COMPUTED week id.
      const computed = computeWorkweekId(data.service_date);
      if (WORKWEEK_ID && computed !== WORKWEEK_ID) return;
      seen.set(d.id, Object.assign({ _id: d.id }, data));
    });
  }

  const candidates = Array.from(seen.values());
  if (!candidates.length) {
    console.log("\nNo sessions need backfill. Nothing to do.");
    return;
  }

  // Group by (staff_uid, workweek_id).
  // To produce a correct allocation, EACH bucket must include ALL
  // sessions in that workweek for that staff_uid — even the ones that
  // already have the fields filled in (so cumulative math reaches 40h).
  // We hydrate the bucket from a fresh per-bucket query.
  const groupKeys = new Map();
  candidates.forEach(function (s) {
    const wid = computeWorkweekId(s.service_date);
    if (!wid || !s.staff_uid) return;
    const key = s.staff_uid + "|" + wid;
    if (!groupKeys.has(key)) {
      groupKeys.set(key, { staff_uid: s.staff_uid, workweek_id: wid });
    }
  });

  let groupsProcessed = 0;
  let groupsHittingCap = 0;
  let docsToWrite = 0;
  let bucketsWithExportLocked = 0;
  let bucketsTotal = groupKeys.size;
  console.log("\nDiscovered " + bucketsTotal + " (staff_uid × workweek) bucket(s) needing recompute.\n");

  const groups = Array.from(groupKeys.values()).sort(function (a, b) {
    if (a.workweek_id !== b.workweek_id) return a.workweek_id.localeCompare(b.workweek_id);
    return a.staff_uid.localeCompare(b.staff_uid);
  });

  const sts = admin.firestore.FieldValue.serverTimestamp();

  for (const group of groups) {
    if (MAX_GROUPS && groupsProcessed >= MAX_GROUPS) break;

    // Hydrate the FULL bucket (all approved + exported sessions for this
    // tech in this workweek, regardless of whether they need backfill).
    // Falls back gracefully if the (staff_uid, workweek_id) composite
    // is still building — on FIRST backfill no session has workweek_id
    // set anyway, so the candidate path below picks up everything.
    let bucketFromIndex = [];
    try {
      const bucketSnap = await db.collection("pioneer_service_sessions")
        .where("staff_uid", "==", group.staff_uid)
        .where("workweek_id", "==", group.workweek_id)
        .get();
      bucketFromIndex = bucketSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id, _ref: d.ref }, d.data() || {});
      });
    } catch (err) {
      if (err && err.code === 9 /* FAILED_PRECONDITION */) {
        if (groupsProcessed === 0) {
          console.warn("[INFO] composite index (staff_uid, workweek_id) is still building — using candidate-only path. First backfill is safe; re-run after the index is READY for incremental backfills.");
        }
      } else {
        throw err;
      }
    }
    // Some of the bucket may not yet have workweek_id (because we're
    // backfilling). Pull them via the un-backfilled candidates too.
    const fromCandidates = candidates.filter(function (s) {
      return s.staff_uid === group.staff_uid &&
             computeWorkweekId(s.service_date) === group.workweek_id &&
             !bucketFromIndex.find(function (b) { return b._id === s._id; });
    });
    fromCandidates.forEach(function (s) {
      s._ref = db.collection("pioneer_service_sessions").doc(s._id);
    });

    const bucketAll = bucketFromIndex.concat(fromCandidates).filter(function (s) {
      // Exclude admin-removed sessions from the OT bucket. Their minutes
      // never count toward the 40h trigger.
      if (s.admin_removed === true) return false;
      // Approved-or-exported only.
      const ps = s.payroll_state || "pending_review";
      return ps === "approved_for_payroll" || ps === "exported";
    });

    if (!bucketAll.length) {
      groupsProcessed += 1;
      continue;
    }
    // Sort chronologically by clock_in_at; tie-break by doc id for
    // determinism. clock_in_at may be a Firestore Timestamp.
    bucketAll.sort(function (a, b) {
      const aMs = (a.clock_in_at && typeof a.clock_in_at.toMillis === "function") ? a.clock_in_at.toMillis() : 0;
      const bMs = (b.clock_in_at && typeof b.clock_in_at.toMillis === "function") ? b.clock_in_at.toMillis() : 0;
      if (aMs !== bMs) return aMs - bMs;
      return String(a._id).localeCompare(String(b._id));
    });

    // Detect locked workweeks. If any session is exported, the workweek
    // is locked — we still recompute (because that's a true-up) but the
    // backfill log calls it out so admin can spot anomalies.
    const hasExported = bucketAll.some(function (s) { return s.payroll_state === "exported"; });
    if (hasExported) bucketsWithExportLocked += 1;

    // Allocate.
    const cumulative = allocateOvertime(bucketAll);
    const overtimeTotal = bucketAll.reduce(function (acc, s) { return acc + (s.overtime_minutes || 0); }, 0);
    if (cumulative >= WEEKLY_REGULAR_CAP) groupsHittingCap += 1;

    const label = computeWorkweekLabel(group.workweek_id);

    // Per-session writes — only write rows whose stored values would
    // change. Idempotent on re-run.
    const writes = [];
    bucketAll.forEach(function (s) {
      const needs =
        (s.workweek_id !== group.workweek_id) ||
        (typeof s.regular_minutes !== "number") ||
        (typeof s.overtime_minutes !== "number") ||
        (s.regular_minutes !== s._allocated_regular_post ||
         s.overtime_minutes !== s._allocated_overtime_post);
      // Stash for the "needs" predicate below.
      s._allocated_regular_post  = s.regular_minutes;
      s._allocated_overtime_post = s.overtime_minutes;
      writes.push({
        ref: s._ref,
        update: {
          workweek_id:              group.workweek_id,
          workweek_label:           label,
          regular_minutes:          s.regular_minutes,
          overtime_minutes:         s.overtime_minutes,
          payable_work_minutes:     s.payable_work_minutes,
          overtime_computed_at:     sts,
          overtime_computed_by:     { uid: "backfill", email: BACKFILL_TAG, displayName: BACKFILL_TAG }
        }
      });
    });

    docsToWrite += writes.length;

    console.log(
      "[" + (DRY_RUN ? "DRY-RUN" : "COMMIT") + "] " +
      group.staff_uid.slice(0, 8) + "… · " + group.workweek_id +
      " · " + bucketAll.length + " session(s)" +
      " · cumulative " + cumulative + "m" +
      " · OT " + overtimeTotal + "m" +
      (hasExported ? " · contains EXPORTED (locked)" : "")
    );

    if (!DRY_RUN) {
      // Firestore batch supports up to 500 writes. Each bucket is small.
      const batch = db.batch();
      writes.forEach(function (w) { batch.update(w.ref, w.update); });
      await batch.commit();
    }
    groupsProcessed += 1;
  }

  console.log("\n--- Summary ---");
  console.log("Buckets discovered:               " + bucketsTotal);
  console.log("Buckets processed:                " + groupsProcessed);
  console.log("Buckets hitting 40h cap:          " + groupsHittingCap);
  console.log("Buckets containing exported docs: " + bucketsWithExportLocked);
  console.log("Total session docs " + (DRY_RUN ? "WOULD WRITE" : "WRITTEN") + ": " + docsToWrite);
  console.log(DRY_RUN
    ? "\nDry-run complete. Re-run with DRY_RUN=false to commit."
    : "\nBackfill complete.");
})().catch((err) => {
  console.error("backfill-overtime failed:", err);
  process.exit(1);
});
