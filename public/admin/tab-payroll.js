/* Pioneer DCR Hub — Admin Payroll tab (Phase 28C: Summary + Verification Layer).
 *
 * Read-only summary surface over the existing approval workflow.
 * No writes. No new collections. No rule changes.
 *
 * Reads:
 *   • pioneer_service_sessions  — sessions in the selected period
 *   • sick_leave_ledger         — used entries in the selected period
 *   • cleaning_techs (via deps.getTechs()) — display names
 *   • payroll_exports           — placeholder text only in 28C
 *
 * Provides:
 *   • Period picker (last 6 semi-monthly periods + Custom range up to 31 days)
 *   • Verification Layer banner: PAYROLL READY (green) · BLOCKED (amber) ·
 *     NO APPROVED SESSIONS (grey)
 *   • Per-employee summary table with totals row (decimal hours)
 *   • "Open in Labor" deep-link buttons for each blocker line
 *   • Recent exports placeholder (Phase 28D content lands here)
 *   • Export button (disabled, "Coming in Phase 28D")
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * Exports window.__pioneerAdmin.tabs.payroll = { init, refresh }.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-payroll.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  // currentPeriod shape: { period_id, label, start_date, end_date, is_custom }
  let currentPeriod  = null;
  let periodOptions  = [];
  let sessions       = [];
  let sickEntries    = [];
  let techsByEmail   = {};
  let techsByUid     = {};
  let loaded         = false;
  let loading        = false;
  // Phase 28D — Recent Exports state. Loaded alongside sessions/sick.
  let recentExports  = [];      // last 10 docs, sorted by generated_at desc
  // Phase 29C — time-adjustment requests overlapping the selected period.
  // Single-field range query on shift_date; no composite index needed.
  // Loaded alongside sessions/sick in refresh(). Used by the Readiness
  // card to surface "N pending requests" without forcing admin to click
  // into the Payroll Exceptions tab.
  let adjustmentRequests = [];  // [{ _id, status, shift_date, ... }]
  // Phase 29D — employee review acknowledgments for the selected period.
  // Loaded alongside the other reads. Each doc id =
  // `<period_id>__<staff_uid>`. Absence of a doc for a staff with
  // sessions in the period is meaningful — "not reviewed."
  let reviewAcks = [];          // [{ _id, status, staff_uid, ... }]
  // Phase 29E-A — payroll_periods doc for the current period. Today
  // nothing writes this collection, so the doc usually doesn't exist;
  // we soft-fail and treat absence as `unlocked`. Phase B will start
  // writing it via lockPayrollPeriodV1 / unlockPayrollPeriodV1.
  let currentPeriodDoc = null;  // { lock_status, locked_at, locked_by, ... } | null

  const PAYROLL_BUILD_TAG = "Payroll v29E-lock-workflow-B";

  /* ---------- date + period helpers ---------- */

  function addDaysPT(yyyymmdd, days) {
    const parts = String(yyyymmdd || "").split("-");
    if (parts.length !== 3) return yyyymmdd;
    const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const sa = Date.parse(a + "T00:00:00Z");
    const sb = Date.parse(b + "T00:00:00Z");
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return NaN;
    return Math.round((sb - sa) / 86400000);
  }
  function lastDayOfMonth(yyyy, mm /* 1-12 */) {
    return new Date(yyyy, mm, 0).getDate();
  }
  function fmtMonthDay(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
  function fmtFullDate(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }

  // Semi-monthly periods (Phase 1a):
  //   Period A = 1–15 of month
  //   Period B = 16–EOM of month
  function getSemiMonthlyPeriodForDate(yyyymmdd) {
    const parts = String(yyyymmdd || "").split("-").map(Number);
    const y = parts[0], m = parts[1], d = parts[2];
    const mm = String(m).padStart(2, "0");
    let start, end, suffix;
    if (d <= 15) {
      start = y + "-" + mm + "-01";
      end   = y + "-" + mm + "-15";
      suffix = "A";
    } else {
      const eod = lastDayOfMonth(y, m);
      start = y + "-" + mm + "-16";
      end   = y + "-" + mm + "-" + String(eod).padStart(2, "0");
      suffix = "B";
    }
    return {
      period_id:  y + "-" + mm + "-" + suffix,
      label:      fmtMonthDay(start) + " – " + fmtMonthDay(end) + ", " + y,
      start_date: start,
      end_date:   end,
      is_custom:  false
    };
  }
  function getPriorPeriod(period) {
    // For Period B → prior is Period A of the same month.
    // For Period A → prior is Period B of the previous month.
    const startParts = period.start_date.split("-").map(Number);
    if (period.period_id.endsWith("-B")) {
      const y = startParts[0], m = startParts[1];
      return getSemiMonthlyPeriodForDate(y + "-" + String(m).padStart(2, "0") + "-01");
    }
    let prevY = startParts[0], prevM = startParts[1] - 1;
    if (prevM === 0) { prevY -= 1; prevM = 12; }
    const prevMm = String(prevM).padStart(2, "0");
    const eod = lastDayOfMonth(prevY, prevM);
    return getSemiMonthlyPeriodForDate(prevY + "-" + prevMm + "-" + String(eod).padStart(2, "0"));
  }
  function buildPeriodOptions() {
    const today = pacificDateString(new Date());
    let current = getSemiMonthlyPeriodForDate(today);
    const out = [current];
    for (let i = 0; i < 5; i++) {
      current = getPriorPeriod(current);
      out.push(current);
    }
    return out;
  }
  function validateCustomRange(start, end) {
    if (!start || !end) return "Pick both start and end dates.";
    if (start > end) return "End date is before start date.";
    const span = daysBetween(start, end);
    if (!Number.isFinite(span)) return "Invalid date.";
    if (span + 1 > 31) return "Range too wide — max 31 days.";
    return null;
  }
  // Phase 28D — overlap check for Recent Exports prioritization.
  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (!aStart || !aEnd || !bStart || !bEnd) return false;
    return !(aEnd < bStart || aStart > bEnd);
  }

  function ensurePeriodInitialized() {
    if (currentPeriod) return;
    const today = pacificDateString(new Date());
    currentPeriod = getSemiMonthlyPeriodForDate(today);
    periodOptions = buildPeriodOptions();
  }

  /* ---------- session + sick helpers (mirror Labor tab semantics) ---------- */

  function needsReviewFlag(s) { return s && s.needs_review === true; }
  function adminRemovedFlag(s) { return s && s.admin_removed === true; }
  function isActiveSession(s) { return s && (s.status === "active" || s.status === "paused"); }
  function dcrPendingFlag(s) {
    if (!s) return false;
    // Phase Timeclock Add-On — DCR requirement applies only to cleaning
    // labor; inspection / supply-station sessions are pre-approved on
    // the DCR axis. Absent labor_type defaults to cleaning.
    const isCleaning = !s.labor_type || s.labor_type === "cleaning";
    if (!isCleaning) return false;
    if (s.status === "dcr_pending") return true;
    if (s.status !== "completed") return false;
    const submitted = (s.dcr_status === "submitted") || s.dcr_status === "waived" || !!s.dcr_id;
    return !submitted;
  }
  function missingClockoutFlag(s) {
    return s && s.status === "completed" && !s.clock_out_at;
  }
  function payrollState(s) { return (s && s.payroll_state) || "pending_review"; }
  function isApproved(s) {
    const ps = payrollState(s);
    return ps === "approved_for_payroll" || ps === "exported";
  }
  function isExported(s) { return payrollState(s) === "exported"; }
  function overBudgetFlag(s) {
    if (!s) return false;
    const budget = (typeof s.budget_minutes === "number") ? s.budget_minutes : null;
    if (budget == null || budget <= 0) return false;
    if (typeof s.work_minutes !== "number") return false;
    return s.work_minutes > budget + 15;
  }
  function offsiteFlag(s) {
    return s && (s.clock_in_geo_status === "offsite" || s.clock_out_geo_status === "offsite");
  }
  function forceClosedFlag(s) {
    return s && s.force_closed_by_admin === true;
  }

  function fmtHours(minutes) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "0.00";
    return (minutes / 60).toFixed(2);
  }

  /* ---------- tech maps ---------- */

  function hydrateTechMaps() {
    techsByEmail = {};
    techsByUid   = {};
    let list = [];
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      if (deps && typeof deps.getTechs === "function") list = deps.getTechs() || [];
    } catch (_e) { list = []; }
    list.forEach(function (t) {
      if (!t) return;
      if (t.email) techsByEmail[String(t.email).toLowerCase()] = t;
      if (t.uid)   techsByUid[t.uid] = t;
    });
  }
  function techName(email, uid) {
    const key = email ? String(email).toLowerCase() : "";
    const t = (key && techsByEmail[key]) || (uid && techsByUid[uid]);
    if (t) return t.display_name || t.first_name || t.email || email || uid || "Tech";
    return email || uid || "Tech";
  }

  /* ---------- loaders ---------- */

  function setState(state, message) {
    const loadingEl = $("payroll-loading");
    const errorEl   = $("payroll-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && message) errorEl.textContent = message;
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      hydrateTechMaps();
      ensurePeriodInitialized();
      const db = firebase.firestore();

      // Parallel reads. Sessions by service_date range; sick by
      // effective_date range (single-field range, no composite needed).
      // Sick entries are filtered to entry_type === "used" client-side
      // to avoid forcing a new composite index for the pilot scale.
      const [sessSnap, sickSnap, exportSnap, adjSnap, ackSnap, periodDocSnap] = await Promise.all([
        db.collection("pioneer_service_sessions")
          .where("service_date", ">=", currentPeriod.start_date)
          .where("service_date", "<=", currentPeriod.end_date)
          .get(),
        db.collection("sick_leave_ledger")
          .where("effective_date", ">=", currentPeriod.start_date)
          .where("effective_date", "<=", currentPeriod.end_date)
          .get(),
        // Phase 28D — Recent exports. Single-field orderBy keeps this
        // index-free. Show 10 most recent overall; client-side filter
        // surfaces the ones overlapping the current period first.
        db.collection("payroll_exports")
          .orderBy("generated_at", "desc")
          .limit(10)
          .get()
          .catch(function () { return null; }),  // soft-fail if collection doesn't exist yet
        // Phase 29C — Time-adjustment requests overlapping the selected
        // period. Single-field range; no composite index needed. Soft-
        // fail so a permission hiccup doesn't blow up the entire tab.
        db.collection("time_adjustment_requests")
          .where("shift_date", ">=", currentPeriod.start_date)
          .where("shift_date", "<=", currentPeriod.end_date)
          .get()
          .catch(function () { return null; }),
        // Phase 29D — Employee review acknowledgments scoped to this
        // period. Single-field equality on period_id (auto-indexed).
        // Skipped for custom ranges since custom doesn't have a stable
        // period_id; the readiness tile then renders "—" for review.
        (currentPeriod.is_custom)
          ? Promise.resolve(null)
          : db.collection("payroll_review_acknowledgments")
              .where("period_id", "==", currentPeriod.period_id)
              .get()
              .catch(function () { return null; }),
        // Phase 29E-A — workflow bar reads payroll_periods/{id} for
        // lock_status. Skipped for custom ranges (no stable period_id).
        // Soft-fail: the bar reasons about absent docs as `unlocked`.
        (currentPeriod.is_custom)
          ? Promise.resolve(null)
          : db.collection("payroll_periods")
              .doc(currentPeriod.period_id)
              .get()
              .catch(function () { return null; })
      ]);

      sessions = sessSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      sickEntries = sickSnap.docs
        .map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (e) { return e.entry_type === "used"; });

      // Phase 28D — recent exports list. Sort with current-period
      // overlap first, then by generated_at desc.
      recentExports = exportSnap
        ? exportSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        : [];
      // Phase 29C — adjustment requests in period.
      adjustmentRequests = adjSnap
        ? adjSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        : [];

      // Phase 29D — review acknowledgments scoped to this period.
      reviewAcks = ackSnap
        ? ackSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        : [];

      // Phase 29E-A — period doc (or null when not yet written).
      currentPeriodDoc = (periodDocSnap && periodDocSnap.exists)
        ? Object.assign({ _id: periodDocSnap.id }, periodDocSnap.data() || {})
        : null;

      recentExports.sort(function (a, b) {
        const aOverlap = rangesOverlap(a.range_start, a.range_end, currentPeriod.start_date, currentPeriod.end_date) ? 1 : 0;
        const bOverlap = rangesOverlap(b.range_start, b.range_end, currentPeriod.start_date, currentPeriod.end_date) ? 1 : 0;
        if (aOverlap !== bOverlap) return bOverlap - aOverlap;
        const aMs = (a.generated_at && a.generated_at.toMillis) ? a.generated_at.toMillis() : 0;
        const bMs = (b.generated_at && b.generated_at.toMillis) ? b.generated_at.toMillis() : 0;
        return bMs - aMs;
      });

      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[payroll] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read on pioneer_service_sessions + sick_leave_ledger."
        : "Couldn't load payroll data: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- aggregations ---------- */

  // Phase 29A — QA / test sessions are excluded from every payroll-facing
  // surface so seed data can't bleed into totals, blockers, or the
  // Verification banner. The CSV export already filters on payroll_state;
  // this is the summary-tab equivalent.
  function isQaTestSession(s) {
    return !!(s && (s.is_test === true || s.exclude_from_payroll_export === true));
  }

  // Phase 29A — single source of truth for "what minutes does this session
  // contribute to payroll." When has_approved_time_adjustment is true and
  // effective_minutes is present, return that; otherwise fall back to
  // work_minutes. Original clock_in_at / clock_out_at / work_minutes are
  // never overwritten on the session itself — this just gives the summary
  // the right answer at read time.
  function effectiveWorkMinutes(s) {
    if (!s) return 0;
    if (s.has_approved_time_adjustment === true &&
        typeof s.effective_minutes === "number") {
      return s.effective_minutes;
    }
    return (typeof s.work_minutes === "number" && s.work_minutes > 0) ? s.work_minutes : 0;
  }

  function computeBlockers(arr) {
    const out = { needs_review: 0, active: 0, dcr_pending: 0, missing_clockout: 0 };
    (arr || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      if (isQaTestSession(s))  return;     // Phase 29A
      if (needsReviewFlag(s))    out.needs_review     += 1;
      if (isActiveSession(s))    out.active           += 1;
      if (dcrPendingFlag(s))     out.dcr_pending      += 1;
      if (missingClockoutFlag(s))out.missing_clockout += 1;
    });
    return out;
  }

  function aggregateByEmployee(sessions, sickEntries) {
    const map = new Map();
    function getOrCreate(uid, email) {
      const key = uid || ("email:" + String(email || "").toLowerCase()) || "(unknown)";
      if (!map.has(key)) {
        map.set(key, {
          staff_uid:          uid || "",
          staff_email:        String(email || "").toLowerCase(),
          name:               techName(email, uid),
          worked_min:         0,
          overtime_min:       0,
          drive_min:          0,    // Phase 28C: always 0 (drive ships later)
          sick_min:           0,
          excpt_count:        0,
          dcr_pending:        0,
          needs_review:       0,
          total_sessions:     0,
          approved_sessions:  0,
          exported_sessions:  0
        });
      }
      return map.get(key);
    }
    (sessions || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      if (isQaTestSession(s))  return;     // Phase 29A — QA seed never counts toward payroll
      const row = getOrCreate(s.staff_uid, s.staff_email);
      // Phase 29A — when an approved time adjustment exists, effective_minutes
      // is the payroll-facing total. Otherwise the stored work_minutes wins.
      const workMin = effectiveWorkMinutes(s);
      if (workMin > 0) row.worked_min += workMin;
      if (typeof s.overtime_minutes === "number" && s.overtime_minutes > 0) {
        row.overtime_min += s.overtime_minutes;
      }
      row.total_sessions += 1;
      if (isApproved(s)) row.approved_sessions += 1;
      if (isExported(s)) row.exported_sessions += 1;
      if (overBudgetFlag(s))    row.excpt_count   += 1;
      if (offsiteFlag(s))       row.excpt_count   += 1;
      if (forceClosedFlag(s))   row.excpt_count   += 1;
      if (dcrPendingFlag(s))    row.dcr_pending   += 1;
      if (needsReviewFlag(s))   row.needs_review  += 1;
    });
    // Sick — include techs with sick leave even if they have 0 sessions
    // this period. Sum of |minutes_delta| from "used" entries.
    (sickEntries || []).forEach(function (e) {
      const row = getOrCreate(e.staff_uid, e.staff_email);
      const m = Math.abs(Number(e.minutes_delta) || 0);
      if (m > 0) row.sick_min += m;
    });
    return Array.from(map.values()).sort(function (a, b) {
      const ta = a.worked_min + a.sick_min;
      const tb = b.worked_min + b.sick_min;
      if (tb !== ta) return tb - ta;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function computeGrandTotals(rows) {
    return (rows || []).reduce(function (acc, r) {
      acc.worked_min        += r.worked_min;
      acc.overtime_min      += r.overtime_min;
      acc.drive_min         += r.drive_min;
      acc.sick_min          += r.sick_min;
      acc.excpt_count       += r.excpt_count;
      acc.dcr_pending       += r.dcr_pending;
      acc.needs_review      += r.needs_review;
      acc.total_sessions    += r.total_sessions;
      acc.approved_sessions += r.approved_sessions;
      acc.exported_sessions += r.exported_sessions;
      return acc;
    }, {
      worked_min: 0, overtime_min: 0, drive_min: 0, sick_min: 0,
      excpt_count: 0, dcr_pending: 0, needs_review: 0,
      total_sessions: 0, approved_sessions: 0, exported_sessions: 0
    });
  }

  /* ---------- Phase 29C — Payroll Readiness computations ----------
   *
   * All numbers come from data already loaded by refresh():
   *   sessions, sickEntries, recentExports, adjustmentRequests, currentPeriod.
   * No additional Firestore reads here — render path stays cheap.
   *
   * Definitions:
   *   • Original hours        = sum of work_minutes across non-archived,
   *                             non-QA sessions in period. Pre-adjustment.
   *   • Approved-adjustment Δ = sum of (effective_minutes − work_minutes)
   *                             for sessions with has_approved_time_adjustment
   *                             === true. By construction this also equals
   *                             Final − Original.
   *   • Final payroll hours   = sum of effectiveWorkMinutes across the same
   *                             session set (matches per-employee table).
   *   • Unresolved exceptions = Phase 29B 5-flag definition:
   *                             needs_review || dcr_pending || over_budget
   *                             || offsite || force_closed_by_admin.
   *                             Counted per-session, not per-flag (one
   *                             session with two flags counts once).
   *   • Pending adj requests  = adjustmentRequests where status === "pending".
   *   • Locked sessions       = count where workweek_locked_by_export === true.
   *   • Active export         = recentExports.find(... status==="active" ...
   *                             && rangesOverlap with currentPeriod).
   */
  function computePayrollReadiness() {
    let totalOriginalMin = 0;
    let totalFinalMin    = 0;
    let exceptionCount   = 0;
    let lockedCount      = 0;
    let countedSessions  = 0;     // non-archived, non-QA sessions counted
    (sessions || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      if (isQaTestSession(s))  return;
      countedSessions += 1;
      const orig = (typeof s.work_minutes === "number" && s.work_minutes > 0) ? s.work_minutes : 0;
      const fin  = effectiveWorkMinutes(s);
      totalOriginalMin += orig;
      totalFinalMin    += fin;
      // 5-flag exception count — any of the five fires this session once.
      if (needsReviewFlag(s) || dcrPendingFlag(s) ||
          overBudgetFlag(s)  || offsiteFlag(s)    || forceClosedFlag(s)) {
        exceptionCount += 1;
      }
      if (s.workweek_locked_by_export === true) lockedCount += 1;
    });
    const totalAdjDeltaMin = totalFinalMin - totalOriginalMin;

    const pendingAdjCount = (adjustmentRequests || []).filter(function (r) {
      return r && r.status === "pending";
    }).length;

    const activeExportForPeriod = (recentExports || []).find(function (e) {
      return e && e.status === "active" &&
             rangesOverlap(e.range_start, e.range_end,
                           currentPeriod.start_date, currentPeriod.end_date);
    }) || null;

    // Phase 29D — Employee review bucket counts.
    //
    // Universe = every distinct staff_uid with ≥1 counted session in the
    // period (matches the auto-finalize sweep semantics we'll add in
    // Step 4 — sick-leave-only techs don't appear).
    //
    // Mapping:
    //   reviewed             = ack.status === "looks_good"
    //   correctionRequested  = ack.status === "correction_requested"
    //   autoFinalized        = ack.status === "auto_finalized" (Step 4 fills this)
    //   notReviewed          = universe size − the three counts above
    //                          (no ack OR ack for a uid we don't know about)
    //
    // Custom range → no period_id → reviewAcks is empty by construction;
    // tile renders "—" and lets admin know review counts don't apply.
    const sessionStaffUids = new Set();
    (sessions || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      if (isQaTestSession(s))  return;
      if (s.staff_uid) sessionStaffUids.add(s.staff_uid);
    });
    let reviewedCount = 0, correctionCount = 0, autoFinalizedCount = 0;
    (reviewAcks || []).forEach(function (a) {
      if (!a || !a.staff_uid) return;
      if (!sessionStaffUids.has(a.staff_uid)) return;   // ack for a uid not in this period
      if (a.status === "looks_good")            reviewedCount      += 1;
      else if (a.status === "correction_requested") correctionCount    += 1;
      else if (a.status === "auto_finalized")   autoFinalizedCount += 1;
    });
    const universeSize = sessionStaffUids.size;
    const notReviewedCount = Math.max(
      0, universeSize - reviewedCount - correctionCount - autoFinalizedCount
    );

    return {
      totalOriginalMin:     totalOriginalMin,
      totalAdjDeltaMin:     totalAdjDeltaMin,
      totalFinalMin:        totalFinalMin,
      exceptionCount:       exceptionCount,
      pendingAdjCount:      pendingAdjCount,
      lockedCount:          lockedCount,
      countedSessions:      countedSessions,
      activeExportForPeriod: activeExportForPeriod,
      reviewUniverse:       universeSize,
      reviewedCount:        reviewedCount,
      correctionCount:      correctionCount,
      autoFinalizedCount:   autoFinalizedCount,
      notReviewedCount:     notReviewedCount,
      reviewIsCustomRange:  !!currentPeriod.is_custom
    };
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderPeriodPicker();
    renderWorkflowBar();
    renderPayrollReadiness();
    renderBanner();
    renderEmployeeTable();
    renderRecentExports();
  }

  function renderHeader() {
    const sub = $("payroll-sub");
    if (!sub) return;
    sub.textContent = currentPeriod.label + " · " + PAYROLL_BUILD_TAG;
  }

  function renderPeriodPicker() {
    const select = $("payroll-period-select");
    if (!select) return;
    const opts = periodOptions.map(function (p) {
      const sel = (!currentPeriod.is_custom && p.period_id === currentPeriod.period_id) ? " selected" : "";
      return '<option value="' + escapeHtml(p.period_id) + '"' + sel + '>' +
             escapeHtml(p.label) + '</option>';
    }).join("");
    select.innerHTML = opts + '<option value="__custom__"' +
      (currentPeriod.is_custom ? " selected" : "") + '>Custom range…</option>';

    const customRow = $("payroll-custom-row");
    if (customRow) customRow.hidden = !currentPeriod.is_custom;
    if (currentPeriod.is_custom) {
      const startEl = $("payroll-custom-start"); if (startEl) startEl.value = currentPeriod.start_date;
      const endEl   = $("payroll-custom-end");   if (endEl)   endEl.value   = currentPeriod.end_date;
    }
    const errEl = $("payroll-custom-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
  }

  /* ---------- Phase 29E-A — Payroll Workflow bar (UI scaffolding) ----------
   *
   * Five-stage progression: Review → Ready → Lock → Export → History.
   * Phase A renders the bar from existing Firestore data only — no writes,
   * no live Lock/Unlock actions. Phase B adds the backend.
   *
   * State precedence (highest wins):
   *   exported            — any non-archived session has payroll_state
   *                         "exported", OR an active export covers the period
   *   locked              — currentPeriodDoc.lock_status === "locked"
   *                         AND not exported
   *   blocked             — totalBlockers > 0
   *   ready               — 0 blockers AND ≥1 approved session
   *   review_in_progress  — sessions exist but none approved yet
   *   empty               — no sessions in period
   */
  function computeWorkflowState() {
    const blockers = computeBlockers(sessions);
    // Payroll Gate V2 (2026-07-01) — DCR is recovery work, NOT a payroll
    // blocker. Only labor-integrity signals gate workflow progression.
    // blockers.dcr_pending is still counted for the recovery-view
    // display but excluded from totalBlockers.
    const totalBlockers = blockers.needs_review + blockers.active +
                          blockers.missing_clockout;
    const nonArchived = (sessions || []).filter(function (s) {
      return !adminRemovedFlag(s) && !isQaTestSession(s);
    });
    const approvedCount = nonArchived.filter(isApproved).length;
    const exportedCount = nonArchived.filter(isExported).length;
    const activeExport = (recentExports || []).find(function (e) {
      return e && e.status === "active" &&
             rangesOverlap(e.range_start, e.range_end,
                           currentPeriod.start_date, currentPeriod.end_date);
    }) || null;
    const isLocked = !!(currentPeriodDoc && currentPeriodDoc.lock_status === "locked");

    let stage;
    if (activeExport || exportedCount > 0) stage = "exported";
    else if (isLocked)                     stage = "locked";
    else if (totalBlockers > 0)            stage = "blocked";
    else if (approvedCount > 0)            stage = "ready";
    else if (nonArchived.length > 0)       stage = "review_in_progress";
    else                                   stage = "empty";

    return {
      stage:               stage,
      blockers:            blockers,
      totalBlockers:       totalBlockers,
      sessionCount:        nonArchived.length,
      approvedCount:       approvedCount,
      exportedCount:       exportedCount,
      activeExport:        activeExport,
      isLocked:            isLocked,
      lockedAt:            currentPeriodDoc && currentPeriodDoc.locked_at || null,
      lockedBy:            currentPeriodDoc && currentPeriodDoc.locked_by || null,
      hasRecentExports:    (recentExports || []).length > 0
    };
  }

  // Map each of the 5 stages to its visual state in the current workflow.
  // Returns one of: "done" | "now" | "blocked" | "future" | "locked".
  function stageStateFor(stageName, w) {
    switch (stageName) {
      case "review":
        // Review is "done" as soon as the period has sessions OR is past.
        // For an empty period it stays "now" so admin sees something to act on.
        return (w.sessionCount > 0) ? "done" : "now";
      case "ready":
        if (w.stage === "blocked")            return "blocked";
        if (w.stage === "review_in_progress") return "future";
        if (w.stage === "empty")              return "future";
        return "done";
      case "lock":
        if (w.stage === "exported") return "locked";   // 🔒 icon, past tense
        if (w.stage === "locked")   return "locked";
        if (w.stage === "ready")    return "now";
        return "future";
      case "export":
        if (w.stage === "exported") return "done";
        if (w.stage === "locked")   return "now";
        return "future";
      case "history":
        return w.hasRecentExports ? "done" : "future";
    }
    return "future";
  }

  function workflowStageIcon(state) {
    switch (state) {
      case "done":    return "✓";
      case "now":     return "◌";
      case "blocked": return "🔴";
      case "locked":  return "🔒";
      case "future":
      default:        return "⚪";
    }
  }
  function workflowStageSub(state) {
    switch (state) {
      case "done":    return "done";
      case "now":     return "NOW";
      case "blocked": return "BLOCKED";
      case "locked":  return "LOCKED";
      case "future":
      default:        return "waiting";
    }
  }

  function fmtPacificDateTimeShort(ts) {
    if (!ts) return "—";
    const ms = (ts && ts.toMillis) ? ts.toMillis()
             : (ts && ts.seconds) ? ts.seconds * 1000 : 0;
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms)) + " PT";
    } catch (_e) { return "—"; }
  }

  function renderWorkflowBar() {
    const wrap = $("payroll-workflow-bar");
    if (!wrap) return;

    // Custom date range has no period_id, no payroll_periods doc, no
    // committed workflow concept. Show a single-line explainer so the
    // admin still sees the tab is wired but doesn't expect Lock/Export.
    if (currentPeriod.is_custom) {
      wrap.innerHTML =
        '<div class="payroll-workflow-bar is-custom">' +
          '<div class="payroll-workflow-custom-note">' +
            '<strong>Workflow not available for custom ranges.</strong> ' +
            'Pick a semi-monthly period to lock and export.' +
          '</div>' +
        '</div>';
      return;
    }

    const w = computeWorkflowState();

    const stages = [
      { key: "review",  label: "Review" },
      { key: "ready",   label: "Ready"  },
      { key: "lock",    label: "Lock"   },
      { key: "export",  label: "Export" },
      { key: "history", label: "History"}
    ];
    const stagesHtml = stages.map(function (s, i) {
      const state = stageStateFor(s.key, w);
      const connector = (i < stages.length - 1)
        ? '<span class="payroll-workflow-connector is-' + escapeHtml(state) +
            '" aria-hidden="true"></span>'
        : '';
      return (
        '<div class="payroll-workflow-stage is-' + escapeHtml(state) + '" ' +
              'data-stage="' + escapeHtml(s.key) + '">' +
          '<div class="payroll-workflow-stage-label">' + escapeHtml(s.label) + '</div>' +
          '<div class="payroll-workflow-stage-icon" aria-hidden="true">' +
            workflowStageIcon(state) +
          '</div>' +
          '<div class="payroll-workflow-stage-sub">' + escapeHtml(workflowStageSub(state)) + '</div>' +
        '</div>' +
        connector
      );
    }).join("");

    wrap.innerHTML =
      '<div class="payroll-workflow-bar is-' + escapeHtml(w.stage) + '">' +
        '<div class="payroll-workflow-head">' +
          '<h3 class="payroll-workflow-title">Payroll Workflow</h3>' +
          '<span class="payroll-workflow-period">' + escapeHtml(currentPeriod.label) + '</span>' +
        '</div>' +
        '<div class="payroll-workflow-stages">' + stagesHtml + '</div>' +
        renderWorkflowPanel(w) +
      '</div>';
  }

  function renderWorkflowPanel(w) {
    if (w.stage === "blocked") {
      const lines = [];
      if (w.blockers.needs_review > 0) lines.push({
        key: "needs_review",
        text: w.blockers.needs_review + ' session' + (w.blockers.needs_review === 1 ? '' : 's') + ' need review'
      });
      // Payroll Gate V2 — DCR pending is NOT a payroll blocker.
      // Surfaces via the Recovery card/filter, not as a workflow gate.
      if (w.blockers.active > 0) lines.push({
        key: "active",
        text: w.blockers.active + ' active session' + (w.blockers.active === 1 ? '' : 's')
      });
      if (w.blockers.missing_clockout > 0) lines.push({
        key: "missing_clockout",
        text: w.blockers.missing_clockout + ' session' + (w.blockers.missing_clockout === 1 ? '' : 's') + ' missing clock-out'
      });
      return (
        '<div class="payroll-workflow-panel is-blocked">' +
          '<div class="payroll-workflow-panel-head">' +
            '<span class="payroll-workflow-panel-icon" aria-hidden="true">🔴</span>' +
            '<strong>' + w.totalBlockers + ' blocker' +
            (w.totalBlockers === 1 ? '' : 's') + ' — fix in Labor to move forward</strong>' +
          '</div>' +
          '<ul class="payroll-workflow-bullets">' +
            lines.map(function (l) {
              return '<li>• ' + escapeHtml(l.text) +
                ' <button type="button" class="payroll-link-btn" data-payroll-link="' +
                escapeHtml(l.key) + '">Open in Labor →</button></li>';
            }).join("") +
          '</ul>' +
          '<p class="payroll-workflow-panel-sub">' +
            w.approvedCount + ' of ' + w.sessionCount + ' session' +
            (w.sessionCount === 1 ? '' : 's') +
            ' approved · Lock unavailable until 0 blockers' +
          '</p>' +
        '</div>'
      );
    }

    if (w.stage === "ready") {
      return (
        '<div class="payroll-workflow-panel is-ready">' +
          '<div class="payroll-workflow-panel-head">' +
            '<strong>Period is READY to lock</strong>' +
          '</div>' +
          '<p class="payroll-workflow-panel-stats">' +
            w.approvedCount + ' of ' + w.sessionCount + ' sessions approved · 0 blockers' +
          '</p>' +
          '<div class="payroll-workflow-cta">' +
            '<button type="button" class="payroll-workflow-btn is-lock" id="payroll-workflow-lock-btn" ' +
              'title="Lock the period and auto-finalize un-reviewed acknowledgments">' +
              '🔒 Lock period for export →' +
            '</button>' +
            '<span class="payroll-workflow-status-msg" id="payroll-workflow-status-msg"></span>' +
          '</div>' +
          '<ul class="payroll-workflow-explainer">' +
            '<li>Mark the period committed</li>' +
            '<li>Prevent Approve / Unapprove / Archive in Labor</li>' +
            '<li>Auto-finalize un-reviewed employee acknowledgments</li>' +
            '<li>Enable the Export button below</li>' +
          '</ul>' +
          '<p class="payroll-workflow-panel-sub">Unlock will be allowed any time before Export.</p>' +
        '</div>'
      );
    }

    if (w.stage === "locked") {
      const byEmail = (w.lockedBy && (w.lockedBy.email || w.lockedBy.displayName)) || "admin";
      const whenStr = fmtPacificDateTimeShort(w.lockedAt);
      return (
        '<div class="payroll-workflow-panel is-locked">' +
          '<div class="payroll-workflow-panel-head">' +
            '<span class="payroll-workflow-panel-icon" aria-hidden="true">🔒</span>' +
            '<strong>Period is LOCKED</strong>' +
          '</div>' +
          '<p class="payroll-workflow-panel-meta">' +
            'Committed by ' + escapeHtml(byEmail) + ' · ' + escapeHtml(whenStr) +
          '</p>' +
          '<p class="payroll-workflow-panel-stats">' +
            w.approvedCount + ' session' + (w.approvedCount === 1 ? '' : 's') +
            ' ready to export' +
          '</p>' +
          '<div class="payroll-workflow-cta">' +
            '<button type="button" class="payroll-workflow-btn is-continue" id="payroll-workflow-continue-btn">' +
              'Continue to Export →' +
            '</button>' +
            '<button type="button" class="payroll-workflow-btn is-unlock" id="payroll-workflow-unlock-btn">' +
              'Unlock period' +
            '</button>' +
            '<span class="payroll-workflow-status-msg" id="payroll-workflow-status-msg"></span>' +
          '</div>' +
          '<p class="payroll-workflow-panel-sub">' +
            'Approve / Unapprove / Archive in Labor will be blocked until you unlock.' +
          '</p>' +
        '</div>'
      );
    }

    if (w.stage === "exported") {
      const exp = w.activeExport || {};
      const hours = (typeof exp.total_paid_hours === "number") ? exp.total_paid_hours.toFixed(2) : '—';
      const emp = exp.employee_count || 0;
      const sess = exp.session_count || w.exportedCount || 0;
      const expId = exp.export_id || exp._id || '—';
      return (
        '<div class="payroll-workflow-panel is-exported">' +
          '<div class="payroll-workflow-panel-head">' +
            '<span class="payroll-workflow-panel-icon" aria-hidden="true">✓</span>' +
            '<strong>Period EXPORTED</strong>' +
          '</div>' +
          '<p class="payroll-workflow-panel-meta">Export ID: ' +
            '<code>' + escapeHtml(expId) + '</code></p>' +
          '<p class="payroll-workflow-panel-stats">' +
            hours + ' paid hrs · ' + sess + ' session' + (sess === 1 ? '' : 's') +
            ' · ' + emp + ' employee' + (emp === 1 ? '' : 's') +
          '</p>' +
          '<p class="payroll-workflow-panel-sub">' +
            'To re-edit this period: Void the export in Recent Exports below, then Unlock here.' +
          '</p>' +
        '</div>'
      );
    }

    if (w.stage === "review_in_progress") {
      return (
        '<div class="payroll-workflow-panel is-review">' +
          '<div class="payroll-workflow-panel-head">' +
            '<strong>Review in progress</strong>' +
          '</div>' +
          '<p class="payroll-workflow-panel-sub">' +
            w.sessionCount + ' session' + (w.sessionCount === 1 ? '' : 's') +
            ' in this period · none approved yet · approve in Labor to advance to Ready.' +
          '</p>' +
        '</div>'
      );
    }

    // empty
    return (
      '<div class="payroll-workflow-panel is-empty">' +
        '<div class="payroll-workflow-panel-head">' +
          '<strong>No sessions in this period yet</strong>' +
        '</div>' +
        '<p class="payroll-workflow-panel-sub">' +
          'The workflow stages light up as sessions land and get approved.' +
        '</p>' +
      '</div>'
    );
  }

  // Phase 29D — Employee review line. Replaces the disabled "n/a" tile
  // shipped in Phase 29C. Renders the 3 buckets (Reviewed / Correction
  // Requested / Not Reviewed) once Step 3 ships. Auto-finalized count is
  // shown only when non-zero (Step 4 will populate it). Custom date
  // ranges have no period_id so we render an explanatory dash.
  function renderEmployeeReviewLine(r) {
    if (r.reviewIsCustomRange) {
      return (
        '<li class="payroll-ready-item is-disabled">' +
          '<span class="payroll-ready-dot" aria-hidden="true"></span>' +
          '<span class="payroll-ready-item-body">' +
            '<strong>Employee review:</strong> ' +
            '<span class="payroll-ready-na">' +
              'select a semi-monthly period to see review counts (custom ranges aren\'t reviewable)' +
            '</span>' +
          '</span>' +
        '</li>'
      );
    }
    if (r.reviewUniverse === 0) {
      return (
        '<li class="payroll-ready-item is-zero">' +
          '<span class="payroll-ready-dot" aria-hidden="true"></span>' +
          '<span class="payroll-ready-item-body">' +
            '<strong>Employee review:</strong> ' +
            '<span class="payroll-ready-ok">no employees with sessions in this period yet</span>' +
          '</span>' +
        '</li>'
      );
    }
    const parts = [];
    parts.push(
      '<span class="payroll-ready-review-bucket is-reviewed" ' +
        'title="Tech clicked Looks Good">' +
        '<span class="payroll-ready-review-icon" aria-hidden="true">✓</span> ' +
        '<strong>' + r.reviewedCount + '</strong> reviewed' +
      '</span>'
    );
    parts.push(
      '<span class="payroll-ready-review-bucket' +
        (r.correctionCount > 0 ? ' has-count' : '') +
        '" title="Tech requested a correction">' +
        '<span class="payroll-ready-review-icon" aria-hidden="true">⚠</span> ' +
        '<strong>' + r.correctionCount + '</strong> correction' +
        (r.correctionCount === 1 ? '' : 's') +
      '</span>'
    );
    parts.push(
      '<span class="payroll-ready-review-bucket' +
        (r.notReviewedCount > 0 ? ' is-pending' : '') +
        '" title="No acknowledgment yet">' +
        '<span class="payroll-ready-review-icon" aria-hidden="true">◌</span> ' +
        '<strong>' + r.notReviewedCount + '</strong> not yet reviewed' +
      '</span>'
    );
    if (r.autoFinalizedCount > 0) {
      parts.push(
        '<span class="payroll-ready-review-bucket is-auto" ' +
          'title="Auto-finalized at export">' +
          '<span class="payroll-ready-review-icon" aria-hidden="true">🔒</span> ' +
          '<strong>' + r.autoFinalizedCount + '</strong> auto-finalized' +
        '</span>'
      );
    }
    const link = r.correctionCount > 0
      ? ' <button type="button" class="payroll-ready-link-btn" data-ready-link="payroll-exceptions">' +
          'Open Exceptions →</button>'
      : '';
    const dotClass = (r.correctionCount > 0 || r.notReviewedCount > 0) ? 'has-count' : 'is-zero';
    return (
      '<li class="payroll-ready-item ' + dotClass + '">' +
        '<span class="payroll-ready-dot" aria-hidden="true"></span>' +
        '<span class="payroll-ready-item-body">' +
          '<strong>Employee review:</strong> ' +
          '<span class="payroll-ready-review-buckets">' + parts.join('') + '</span>' +
          '<div class="payroll-ready-review-sub">' +
            r.reviewUniverse + ' employee' + (r.reviewUniverse === 1 ? '' : 's') +
            ' with sessions in this period · acknowledgment is optional and does not block payroll' +
          '</div>' +
        '</span>' +
        link +
      '</li>'
    );
  }

  // Phase 29C — Payroll Readiness card. Sits above the existing
  // Verification banner. Read-only — does NOT gate the export. The
  // banner below still owns the BLOCKED/READY decision.
  function renderPayrollReadiness() {
    const wrap = $("payroll-readiness-card");
    if (!wrap) return;
    const r = computePayrollReadiness();

    // --- Hours tiles (Original / +Adj / Final) ---
    const deltaSign = r.totalAdjDeltaMin > 0 ? "+" : (r.totalAdjDeltaMin < 0 ? "−" : "±");
    const deltaAbs  = Math.abs(r.totalAdjDeltaMin);
    const deltaClass =
      r.totalAdjDeltaMin > 0 ? " is-positive" :
      r.totalAdjDeltaMin < 0 ? " is-negative" : "";
    const hoursTiles =
      '<div class="payroll-ready-tiles">' +
        '<div class="payroll-ready-tile">' +
          '<div class="payroll-ready-tile-label">Original hours</div>' +
          '<div class="payroll-ready-tile-value">' + fmtHours(r.totalOriginalMin) + '</div>' +
          '<div class="payroll-ready-tile-sub">pre-adjustment</div>' +
        '</div>' +
        '<div class="payroll-ready-tile' + deltaClass + '">' +
          '<div class="payroll-ready-tile-label">Approved adjustments</div>' +
          '<div class="payroll-ready-tile-value">' + deltaSign + ' ' + fmtHours(deltaAbs) + '</div>' +
          '<div class="payroll-ready-tile-sub">net Δ from approvals</div>' +
        '</div>' +
        '<div class="payroll-ready-tile is-final">' +
          '<div class="payroll-ready-tile-label">Final payroll hours</div>' +
          '<div class="payroll-ready-tile-value">' + fmtHours(r.totalFinalMin) + '</div>' +
          '<div class="payroll-ready-tile-sub">matches CSV total</div>' +
        '</div>' +
      '</div>';

    // --- Lock status row ---
    let lockIcon, lockLabel, lockDetail;
    if (r.activeExportForPeriod) {
      lockIcon   = '🔒';
      lockLabel  = 'LOCKED BY EXPORT';
      lockDetail = escapeHtml(r.activeExportForPeriod.export_id || r.activeExportForPeriod._id);
    } else if (r.lockedCount > 0) {
      // Sessions still carry workweek_locked_by_export but no active
      // export covers the period — i.e. the export was voided after the
      // fact. voidPayrollExportV1 clears the flag, so seeing it here
      // usually means a partial state (one workweek touched another).
      lockIcon   = '🟡';
      lockLabel  = 'PARTIALLY LOCKED';
      lockDetail = 'last export voided';
    } else {
      lockIcon   = '🟢';
      lockLabel  = 'NOT YET LOCKED';
      lockDetail = 'ready for export';
    }
    const lockRow =
      '<div class="payroll-ready-status payroll-ready-lock">' +
        '<span class="payroll-ready-status-icon" aria-hidden="true">' + lockIcon + '</span>' +
        '<div class="payroll-ready-status-body">' +
          '<div class="payroll-ready-status-label">Lock status: ' + escapeHtml(lockLabel) + '</div>' +
          '<div class="payroll-ready-status-sub">' +
            r.lockedCount + ' of ' + r.countedSessions + ' session' +
            (r.countedSessions === 1 ? '' : 's') + ' locked · ' + escapeHtml(lockDetail) +
          '</div>' +
        '</div>' +
      '</div>';

    // --- Export status row ---
    let expIcon, expLabel, expSub;
    if (r.activeExportForPeriod) {
      const e = r.activeExportForPeriod;
      expIcon  = '✓';
      expLabel = 'ACTIVE EXPORT';
      const totHrs = (typeof e.total_paid_hours === "number") ? e.total_paid_hours.toFixed(2) : '—';
      expSub   = totHrs + ' paid hrs · ' + (e.employee_count || 0) + ' employee' +
                 (e.employee_count === 1 ? '' : 's') + ' · ' + (e.session_count || 0) + ' session' +
                 (e.session_count === 1 ? '' : 's');
    } else {
      expIcon  = '⚪';
      expLabel = 'NO EXPORT YET';
      expSub   = 'use the green banner below to generate the first CSV';
    }
    const exportRow =
      '<div class="payroll-ready-status payroll-ready-export">' +
        '<span class="payroll-ready-status-icon" aria-hidden="true">' + expIcon + '</span>' +
        '<div class="payroll-ready-status-body">' +
          '<div class="payroll-ready-status-label">Export status: ' + escapeHtml(expLabel) + '</div>' +
          '<div class="payroll-ready-status-sub">' + escapeHtml(expSub) + '</div>' +
        '</div>' +
      '</div>';

    // --- Unresolved items ---
    function unresolvedLine(opts) {
      const dotClass = opts.count > 0 ? 'has-count' : 'is-zero';
      const linkHtml = opts.linkLabel
        ? ' <button type="button" class="payroll-ready-link-btn" data-ready-link="' +
            escapeHtml(opts.linkKey) + '">' + escapeHtml(opts.linkLabel) + ' →</button>'
        : '';
      return (
        '<li class="payroll-ready-item ' + dotClass + (opts.disabled ? ' is-disabled' : '') + '">' +
          '<span class="payroll-ready-dot" aria-hidden="true"></span>' +
          '<span class="payroll-ready-item-body">' +
            '<strong>' + escapeHtml(opts.title) + '</strong>: ' + opts.body +
          '</span>' +
          linkHtml +
        '</li>'
      );
    }
    const itemsList =
      '<ul class="payroll-ready-items">' +
        unresolvedLine({
          title:     'Unresolved exceptions',
          body:      r.exceptionCount > 0
                       ? '<strong>' + r.exceptionCount + '</strong> session' +
                         (r.exceptionCount === 1 ? '' : 's') +
                         ' (needs review · DCR pending · over budget · offsite · force-closed)'
                       : '<span class="payroll-ready-ok">none</span>',
          linkKey:   'labor-exceptions',
          linkLabel: r.exceptionCount > 0 ? 'Open in Labor' : ''
        }) +
        unresolvedLine({
          title:     'Pending adjustment requests',
          body:      r.pendingAdjCount > 0
                       ? '<strong>' + r.pendingAdjCount + '</strong> request' +
                         (r.pendingAdjCount === 1 ? '' : 's') + ' awaiting review'
                       : '<span class="payroll-ready-ok">none</span>',
          linkKey:   'payroll-exceptions',
          linkLabel: r.pendingAdjCount > 0 ? 'Open Exceptions' : ''
        }) +
        renderEmployeeReviewLine(r) +
      '</ul>';

    wrap.innerHTML =
      '<div class="payroll-readiness-card">' +
        '<header class="payroll-readiness-head">' +
          '<h3 class="payroll-readiness-title">Payroll Readiness</h3>' +
          '<span class="payroll-readiness-period">' + escapeHtml(currentPeriod.label) + '</span>' +
        '</header>' +
        hoursTiles +
        '<div class="payroll-ready-status-block">' +
          lockRow +
          exportRow +
        '</div>' +
        '<div class="payroll-ready-items-block">' +
          '<div class="payroll-ready-items-title">Unresolved items</div>' +
          itemsList +
        '</div>' +
      '</div>';
  }

  function renderBanner() {
    const wrap = $("payroll-banner");
    if (!wrap) return;
    const blockers = computeBlockers(sessions);
    // Payroll Gate V2 — DCR is recovery work, NOT a payroll blocker.
    const totalBlockers = blockers.needs_review + blockers.active +
                          blockers.missing_clockout;
    const nonArchived = sessions.filter(function (s) { return !adminRemovedFlag(s); });
    const approvedCount = nonArchived.filter(isApproved).length;

    if (totalBlockers === 0 && approvedCount > 0) {
      wrap.innerHTML =
        '<div class="payroll-banner is-ready">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">🟢</span>' +
            '<strong>PAYROLL READY</strong>' +
          '</div>' +
          '<p class="payroll-banner-msg"><strong>' + approvedCount +
            '</strong> of <strong>' + nonArchived.length +
            '</strong> session' + (nonArchived.length === 1 ? '' : 's') +
            ' approved · no blockers in this period.</p>' +
          '<div class="payroll-banner-actions">' +
            '<button type="button" class="payroll-export-btn is-ready" id="payroll-export-now" ' +
              'title="Generate CSV and lock these sessions as exported">' +
              'Export approved sessions →' +
            '</button>' +
            '<span class="payroll-export-note">Server-side admin-auth download · audit trail in payroll_exports.</span>' +
          '</div>' +
        '</div>';
    } else if (totalBlockers > 0) {
      const lines = [];
      if (blockers.needs_review > 0) {
        lines.push({ key: "needs_review",
          text: blockers.needs_review + ' session' + (blockers.needs_review === 1 ? '' : 's') + ' need review' });
      }
      if (blockers.active > 0) {
        lines.push({ key: "active",
          text: blockers.active + ' active session' + (blockers.active === 1 ? '' : 's') });
      }
      // Payroll Gate V2 — DCR pending is surfaced elsewhere (Recovery
      // view / filter), not as a payroll banner blocker.
      if (blockers.missing_clockout > 0) {
        lines.push({ key: "missing_clockout",
          text: blockers.missing_clockout + ' session' + (blockers.missing_clockout === 1 ? '' : 's') + ' missing clock-out' });
      }
      wrap.innerHTML =
        '<div class="payroll-banner is-blocked">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">🟡</span>' +
            '<strong>BLOCKED</strong>' +
          '</div>' +
          '<ul class="payroll-banner-list">' +
            lines.map(function (l) {
              return '<li><span class="payroll-banner-bullet">•</span> ' +
                escapeHtml(l.text) +
                ' <button type="button" class="payroll-link-btn" data-payroll-link="' +
                escapeHtml(l.key) + '">Open in Labor →</button></li>';
            }).join("") +
          '</ul>' +
          '<p class="payroll-banner-msg">Export disabled until resolved.</p>' +
        '</div>';
    } else {
      wrap.innerHTML =
        '<div class="payroll-banner is-empty">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">⚪</span>' +
            '<strong>NO APPROVED SESSIONS</strong>' +
          '</div>' +
          '<p class="payroll-banner-msg">' +
            'No sessions have been approved for payroll in this period yet. Open the Labor tab to review and approve.' +
          '</p>' +
        '</div>';
    }
  }

  function approvalChip(r) {
    if (r.total_sessions === 0) return '<span class="pr-apv pr-apv-zero">0/0</span>';
    if (r.exported_sessions === r.total_sessions) {
      return '<span class="pr-apv pr-apv-exported">🔒 ' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    if (r.approved_sessions === r.total_sessions) {
      return '<span class="pr-apv pr-apv-all">✓ ' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    if (r.approved_sessions > 0) {
      return '<span class="pr-apv pr-apv-partial">' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    return '<span class="pr-apv pr-apv-none">0/' + r.total_sessions + '</span>';
  }

  function renderEmployeeTable() {
    const wrap  = $("payroll-employee-table");
    const empty = $("payroll-employee-empty");
    if (!wrap || !empty) return;

    const rows = aggregateByEmployee(sessions, sickEntries);
    if (!rows.length) {
      wrap.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const totals = computeGrandTotals(rows);

    const headerHtml =
      '<div class="payroll-row payroll-row-head">' +
        '<div class="pr-col-emp">Employee</div>' +
        '<div class="pr-col-num">Worked</div>' +
        '<div class="pr-col-num">OT</div>' +
        '<div class="pr-col-num" title="Drive time integration ships after Phase 28D.">Drive</div>' +
        '<div class="pr-col-num">Sick</div>' +
        '<div class="pr-col-num pr-col-total">Total</div>' +
        '<div class="pr-col-num">Excpt</div>' +
        '<div class="pr-col-num">DCR</div>' +
        '<div class="pr-col-num">NR</div>' +
        '<div class="pr-col-apv">Approval</div>' +
      '</div>';

    const rowsHtml = rows.map(function (r) {
      // Total = work + drive + sick (OT already included in worked).
      const totalMin = r.worked_min + r.drive_min + r.sick_min;
      return (
        '<div class="payroll-row">' +
          '<div class="pr-col-emp">' + escapeHtml(r.name) + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.worked_min)   + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.overtime_min) + '</div>' +
          '<div class="pr-col-num pr-col-drive">' + fmtHours(r.drive_min) + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.sick_min) + '</div>' +
          '<div class="pr-col-num pr-col-total">' + fmtHours(totalMin) + '</div>' +
          '<div class="pr-col-num">' + r.excpt_count   + '</div>' +
          '<div class="pr-col-num">' + r.dcr_pending   + '</div>' +
          '<div class="pr-col-num">' + r.needs_review  + '</div>' +
          '<div class="pr-col-apv">' + approvalChip(r) + '</div>' +
        '</div>'
      );
    }).join("");

    const totalRowHtml =
      '<div class="payroll-row payroll-row-total">' +
        '<div class="pr-col-emp">TOTAL · ' + rows.length + ' employee' + (rows.length === 1 ? '' : 's') + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.worked_min)   + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.overtime_min) + '</div>' +
        '<div class="pr-col-num pr-col-drive">' + fmtHours(totals.drive_min) + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.sick_min) + '</div>' +
        '<div class="pr-col-num pr-col-total">' +
          fmtHours(totals.worked_min + totals.drive_min + totals.sick_min) + '</div>' +
        '<div class="pr-col-num">' + totals.excpt_count  + '</div>' +
        '<div class="pr-col-num">' + totals.dcr_pending  + '</div>' +
        '<div class="pr-col-num">' + totals.needs_review + '</div>' +
        '<div class="pr-col-apv">' +
          totals.approved_sessions + '/' + totals.total_sessions +
          (totals.exported_sessions > 0 ? ' (🔒 ' + totals.exported_sessions + ')' : '') +
        '</div>' +
      '</div>';

    wrap.innerHTML = headerHtml + rowsHtml + totalRowHtml;
  }

  function renderRecentExports() {
    const wrap = $("payroll-recent-exports");
    if (!wrap) return;
    if (!recentExports.length) {
      wrap.innerHTML =
        '<div class="payroll-exports-placeholder">' +
          '<p><strong>No exports yet.</strong> Click <em>Export approved sessions</em> in the green banner above to generate the first CSV.</p>' +
        '</div>';
      return;
    }
    wrap.innerHTML = recentExports.map(function (e) {
      const overlap = rangesOverlap(e.range_start, e.range_end, currentPeriod.start_date, currentPeriod.end_date);
      const isVoided = (e.status === "voided");
      const genMs = (e.generated_at && e.generated_at.toMillis) ? e.generated_at.toMillis() : 0;
      const genStr = genMs ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(genMs)) : "—";
      const totalHours = (typeof e.total_paid_hours === "number") ? e.total_paid_hours.toFixed(2) : "—";
      const voidedLine = isVoided && e.voided_at
        ? '<p class="payroll-export-voided-line">Voided ' +
            escapeHtml(genStrFromTs(e.voided_at)) +
            ' by ' + escapeHtml((e.voided_by_email || (e.voided_by && e.voided_by.displayName)) || "admin") +
            (e.void_reason ? ' — ' + escapeHtml(e.void_reason) : '') +
          '</p>'
        : '';
      // Phase 28D revision (v3) — Download CSV goes through the
      // authenticated streaming endpoint. Render as a <button> with a
      // data attribute carrying the export_id; the wire-up handler
      // calls downloadCsvViaAuthenticatedFetch() with the user's
      // current ID token.
      const downloadBtn = e.storage_path
        ? '<button type="button" class="payroll-export-download" ' +
          'data-payroll-download-id="' + escapeHtml(e._id) + '">Download CSV ↗</button>'
        : '<span class="payroll-export-no-url">No CSV in Storage</span>';
      const voidBtn = !isVoided
        ? '<button type="button" class="payroll-export-void-btn" ' +
          'data-payroll-void-id="' + escapeHtml(e._id) +
          '" data-payroll-void-label="' + escapeHtml(e.period_label || (e.range_start + " → " + e.range_end)) + '">' +
          'Void this export…</button>'
        : '';
      const statusBadge = isVoided
        ? '<span class="payroll-export-badge is-voided">🚫 VOIDED</span>'
        : '<span class="payroll-export-badge is-active">✓ ACTIVE</span>';
      const overlapMark = overlap ? '<span class="payroll-export-overlap">in current period</span>' : '';
      return (
        '<div class="payroll-export-row' + (isVoided ? ' is-voided' : '') + '">' +
          '<div class="payroll-export-row-head">' +
            '<span class="payroll-export-date">' + escapeHtml(genStr) + '</span>' +
            '<span class="payroll-export-period">' + escapeHtml(e.period_label || (e.range_start + " → " + e.range_end)) + '</span>' +
            statusBadge + overlapMark +
          '</div>' +
          '<div class="payroll-export-row-meta">' +
            'Generated by ' + escapeHtml(e.generated_by_email || "admin") +
            ' · ' + totalHours + ' total paid hours' +
            ' · ' + (e.session_count || 0) + ' session' + ((e.session_count === 1) ? '' : 's') +
            ' · ' + (e.employee_count || 0) + ' employee' + ((e.employee_count === 1) ? '' : 's') +
          '</div>' +
          voidedLine +
          '<div class="payroll-export-row-actions">' +
            downloadBtn + voidBtn +
          '</div>' +
        '</div>'
      );
    }).join("");
  }
  function genStrFromTs(ts) {
    const ms = (ts && ts.toMillis) ? ts.toMillis() : 0;
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }

  /* ---------- Phase 28D — authenticated download ----------
   *
   * The download endpoint requires a Firebase ID token in the
   * Authorization header. Browsers can't attach that to a plain
   * <a href> click, so we fetch the URL with the bearer token, get
   * the response body as a Blob, and trigger the download client-side
   * via a synthetic anchor + URL.createObjectURL. Filename is parsed
   * from the Content-Disposition header so the function stays the
   * source of truth for naming.
   */
  async function downloadCsvViaAuthenticatedFetch(exportId, fallbackFilename) {
    const base = (window.DOWNLOAD_PAYROLL_EXPORT_CSV_URL || "").trim();
    if (!base) throw new Error("DOWNLOAD_PAYROLL_EXPORT_CSV_URL not configured.");
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const url = base + "?export_id=" + encodeURIComponent(exportId);
    const res = await fetch(url, {
      method:  "GET",
      headers: { "Authorization": "Bearer " + idToken }
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_e) {
        try { detail = await res.text(); } catch (__e) {}
      }
      throw new Error("HTTP " + res.status + (detail ? ": " + detail : ""));
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const filename = (m && m[1]) || fallbackFilename || "payroll-export.csv";
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
  }

  /* ---------- Phase 28D — export + void writers ---------- */

  async function exportPayrollCsv() {
    const url = (window.EXPORT_PAYROLL_CSV_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("EXPORT_PAYROLL_CSV_URL is not configured in firebase-config.js.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        range_start:  currentPeriod.start_date,
        range_end:    currentPeriod.end_date,
        period_label: currentPeriod.label
      })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body;
      throw err;
    }
    return body;
  }
  async function voidPayrollExport(exportId, reason) {
    const url = (window.VOID_PAYROLL_EXPORT_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("VOID_PAYROLL_EXPORT_URL is not configured in firebase-config.js.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({ export_id: exportId, void_reason: reason })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body;
      throw err;
    }
    return body;
  }

  /* ---------- Phase 29E-B — Lock / Unlock writers ---------- */

  async function lockPayrollPeriodCall(periodId) {
    const url = (window.LOCK_PAYROLL_PERIOD_URL || "").trim();
    if (!url) throw new Error("LOCK_PAYROLL_PERIOD_URL is not configured in firebase-config.js.");
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({ period_id: periodId })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body; err.status = res.status;
      throw err;
    }
    return body;
  }
  async function unlockPayrollPeriodCall(periodId) {
    const url = (window.UNLOCK_PAYROLL_PERIOD_URL || "").trim();
    if (!url) throw new Error("UNLOCK_PAYROLL_PERIOD_URL is not configured in firebase-config.js.");
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({ period_id: periodId })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body; err.status = res.status;
      throw err;
    }
    return body;
  }

  function setWorkflowStatusMsg(msg, tone) {
    const el = $("payroll-workflow-status-msg");
    if (!el) return;
    el.textContent = msg || "";
    if (tone) el.setAttribute("data-tone", tone);
    else      el.removeAttribute("data-tone");
  }

  async function lockCurrentPayrollPeriod() {
    if (!currentPeriod || currentPeriod.is_custom) {
      alert("Custom date ranges can't be locked. Pick a semi-monthly period.");
      return;
    }
    const lockBtn = $("payroll-workflow-lock-btn");
    if (lockBtn) lockBtn.disabled = true;
    setWorkflowStatusMsg("Locking…", null);
    try {
      const result = await lockPayrollPeriodCall(currentPeriod.period_id);
      setWorkflowStatusMsg(
        "Locked · " + (result.auto_finalized_count || 0) + " auto-finalized",
        "ok"
      );
      await refresh();
    } catch (err) {
      console.error("[payroll] lock failed", err);
      setWorkflowStatusMsg((err && err.message) || "Lock failed", "error");
      if (lockBtn) lockBtn.disabled = false;
    }
  }

  async function unlockCurrentPayrollPeriod() {
    if (!currentPeriod || currentPeriod.is_custom) {
      alert("Custom date ranges can't be unlocked.");
      return;
    }
    if (!confirm("Unlock this period? Auto-finalized employee acknowledgments will be removed; manual Looks Good / Correction acks are preserved.")) {
      return;
    }
    const unlockBtn = $("payroll-workflow-unlock-btn");
    if (unlockBtn) unlockBtn.disabled = true;
    setWorkflowStatusMsg("Unlocking…", null);
    try {
      const result = await unlockPayrollPeriodCall(currentPeriod.period_id);
      setWorkflowStatusMsg(
        "Unlocked · " + (result.reverted_ack_count || 0) + " auto-finalized ack(s) removed",
        "ok"
      );
      await refresh();
    } catch (err) {
      console.error("[payroll] unlock failed", err);
      setWorkflowStatusMsg((err && err.message) || "Unlock failed", "error");
      if (unlockBtn) unlockBtn.disabled = false;
    }
  }

  /* ---------- Phase 28D — modals ---------- */

  function openExportConfirmModal() {
    const modal = $("payroll-export-confirm-modal");
    if (!modal) return;
    const approvedCount = sessions.filter(function (s) {
      return !adminRemovedFlag(s) && isApproved(s);
    }).length;
    const sickCount = sickEntries.length;
    const sum = $("payroll-export-summary");
    if (sum) {
      sum.innerHTML =
        '<strong>' + currentPeriod.label + '</strong><br>' +
        approvedCount + ' approved session' + (approvedCount === 1 ? '' : 's') +
        ' · ' + sickCount + ' sick entr' + (sickCount === 1 ? 'y' : 'ies');
    }
    const err = $("payroll-export-err");
    if (err) { err.textContent = ""; err.hidden = true; }
    const dl = $("payroll-export-success-dl");
    if (dl) { dl.hidden = true; dl.removeAttribute("href"); }
    const successBlock = $("payroll-export-success");
    if (successBlock) successBlock.hidden = true;
    const confirmRow = $("payroll-export-confirm-row");
    if (confirmRow) confirmRow.hidden = false;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeExportConfirmModal() {
    const modal = $("payroll-export-confirm-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeExportConfirmModal; // closed by [data-modal-close]

  async function submitExportConfirm() {
    const err     = $("payroll-export-err");
    const saveBtn = $("payroll-export-save");
    function showErr(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Exporting…"; }
    try {
      const result = await exportPayrollCsv();
      // Flip modal into success state.
      const confirmRow = $("payroll-export-confirm-row");
      if (confirmRow) confirmRow.hidden = true;
      const successBlock = $("payroll-export-success");
      if (successBlock) successBlock.hidden = false;
      const dl = $("payroll-export-success-dl");
      // Phase 28D revision (v3) — success-modal download triggers an
      // authenticated fetch + blob save. The success-anchor is repurposed
      // as a button (still styled as a link); attach the export_id so the
      // global delegated handler routes to downloadCsvViaAuthenticatedFetch.
      if (dl) {
        dl.removeAttribute("href");
        dl.setAttribute("data-payroll-download-id", result.export_id);
        dl.hidden = false;
      }
      const sumLine = $("payroll-export-success-summary");
      if (sumLine && result.summary) {
        sumLine.textContent =
          result.summary.session_count + " session(s) · " +
          result.summary.employee_count + " employee(s) · " +
          (result.summary.total_paid_hours || 0).toFixed(2) + " total paid hours";
      }
      // Refresh the Payroll tab in the background so banner + table + recent-exports update.
      refresh();
    } catch (e) {
      console.error("[payroll] export failed", e);
      let msg = (e && e.message) || "Export failed.";
      if (e && e.body && e.body.blockers) {
        const b = e.body.blockers;
        msg += " · Server saw: " + b.needs_review_count + " needs review, " +
               b.active_count + " active, " + b.dcr_pending_count + " DCR pending, " +
               b.missing_clockout_count + " missing clock-out.";
      }
      showErr(msg);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Confirm export"; }
    }
  }

  function openVoidModal(exportId, exportLabel) {
    const modal = $("payroll-void-modal");
    if (!modal) return;
    const idEl = $("payroll-void-id");        if (idEl) idEl.value = exportId || "";
    const sumEl = $("payroll-void-summary");  if (sumEl) sumEl.textContent = exportLabel || exportId || "—";
    const rEl = $("payroll-void-reason");     if (rEl) rEl.value = "";
    const eEl = $("payroll-void-err");        if (eEl) { eEl.textContent = ""; eEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeVoidModal() {
    const modal = $("payroll-void-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeVoidModal;

  async function submitVoid() {
    const idEl = $("payroll-void-id");
    const rEl  = $("payroll-void-reason");
    const err  = $("payroll-void-err");
    const saveBtn = $("payroll-void-save");
    function showErr(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
    const exportId = (idEl && idEl.value) || "";
    const reason = ((rEl && rEl.value) || "").trim();
    if (!exportId) { showErr("Missing export id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }
    if (saveBtn) saveBtn.disabled = true;
    try {
      await voidPayrollExport(exportId, reason);
      closeVoidModal();
      refresh();
    } catch (e) {
      console.error("[payroll] void failed", e);
      showErr((e && e.message) || "Void failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- deep-link "Open in Labor" ---------- */

  function openInLabor(blockerKey) {
    const labor = window.__pioneerAdmin && window.__pioneerAdmin.tabs && window.__pioneerAdmin.tabs.laborReview;
    // Map blocker key → Labor status filter. "active" and
    // "missing_clockout" don't have dedicated filters; fall back to
    // "all" (admin can scan the open-active block + the table).
    let statusFilter = "all";
    if (blockerKey === "needs_review") statusFilter = "needs_review";
    else if (blockerKey === "dcr_pending") statusFilter = "dcr_pending";
    if (labor && typeof labor.applyExternalFilter === "function") {
      labor.applyExternalFilter({
        rangeStart:   currentPeriod.start_date,
        rangeEnd:     currentPeriod.end_date,
        statusFilter: statusFilter
      });
    } else {
      try { console.warn("[payroll] laborReview.applyExternalFilter not available — Labor tab may be old"); } catch (_e) {}
    }
    const laborBtn = document.querySelector('.admin-tab[data-tab="labor-review"]');
    if (laborBtn) laborBtn.click();
  }

  /* ---------- wire-up ---------- */

  function wire() {
    const refreshBtn = $("payroll-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    const select = $("payroll-period-select");
    if (select) select.addEventListener("change", function () {
      const val = select.value;
      if (val === "__custom__") {
        // Switch to custom-range mode using current period's dates as
        // the starting point. Don't fetch yet — admin must click Apply.
        currentPeriod = Object.assign({}, currentPeriod, {
          is_custom: true, period_id: "custom",
          label: fmtFullDate(currentPeriod.start_date) + " – " + fmtFullDate(currentPeriod.end_date)
        });
        renderPeriodPicker();
        return;
      }
      const found = periodOptions.find(function (p) { return p.period_id === val; });
      if (found) {
        currentPeriod = found;
        refresh();
      }
    });

    const applyBtn = $("payroll-custom-apply");
    if (applyBtn) applyBtn.addEventListener("click", function () {
      const startEl = $("payroll-custom-start");
      const endEl   = $("payroll-custom-end");
      const start = (startEl && startEl.value) || "";
      const end   = (endEl && endEl.value) || "";
      const errMsg = validateCustomRange(start, end);
      const errEl = $("payroll-custom-err");
      if (errMsg) { if (errEl) { errEl.textContent = errMsg; errEl.hidden = false; } return; }
      if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
      currentPeriod = {
        period_id:  "custom",
        label:      fmtFullDate(start) + " – " + fmtFullDate(end),
        start_date: start,
        end_date:   end,
        is_custom:  true
      };
      refresh();
    });

    // Delegated click on the banner for "Open in Labor" deep-links.
    const banner = $("payroll-banner");
    if (banner) banner.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest("[data-payroll-link]");
      if (!btn) return;
      const key = btn.getAttribute("data-payroll-link");
      if (key) openInLabor(key);
    });

    // Phase 29C — Payroll Readiness card deep links. "labor-exceptions"
    // opens the Labor tab scoped to the current period with the
    // needs_review status filter (most common single click for the
    // exception bucket). "payroll-exceptions" jumps to the Payroll
    // Exceptions tab. Both expect the target tab to be wired in the
    // shell's data-tab routing.
    const readiness = $("payroll-readiness-card");
    if (readiness) readiness.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest("[data-ready-link]");
      if (!btn) return;
      const key = btn.getAttribute("data-ready-link");
      if (key === "labor-exceptions") {
        // Reuse the Labor deep-link helper; "needs_review" is a
        // reasonable default landing filter even though the readiness
        // count spans 5 flags. Admin can clear it from the chip strip
        // in the new Phase 29B Sessions filter row.
        openInLabor("needs_review");
        return;
      }
      if (key === "payroll-exceptions") {
        const tabBtn = document.querySelector('.admin-tab[data-tab="payroll-exceptions"]');
        if (tabBtn) tabBtn.click();
        return;
      }
    });

    // Phase 28D — Export button click (live) and Void button click
    // (delegated on Recent Exports rows).
    document.addEventListener("click", function (ev) {
      const exportBtn = ev.target.closest && ev.target.closest("#payroll-export-now");
      if (exportBtn) {
        ev.preventDefault();
        openExportConfirmModal();
        return;
      }
      // Phase 29E-B — Workflow bar buttons.
      const lockBtn = ev.target.closest && ev.target.closest("#payroll-workflow-lock-btn");
      if (lockBtn) {
        ev.preventDefault();
        lockCurrentPayrollPeriod();
        return;
      }
      const continueBtn = ev.target.closest && ev.target.closest("#payroll-workflow-continue-btn");
      if (continueBtn) {
        ev.preventDefault();
        openExportConfirmModal();
        return;
      }
      const unlockBtn = ev.target.closest && ev.target.closest("#payroll-workflow-unlock-btn");
      if (unlockBtn) {
        ev.preventDefault();
        unlockCurrentPayrollPeriod();
        return;
      }
      const voidBtn = ev.target.closest && ev.target.closest("[data-payroll-void-id]");
      if (voidBtn) {
        ev.preventDefault();
        openVoidModal(voidBtn.getAttribute("data-payroll-void-id"),
                      voidBtn.getAttribute("data-payroll-void-label"));
        return;
      }
      // Phase 28D v3 — authenticated download.
      const dlBtn = ev.target.closest && ev.target.closest("[data-payroll-download-id]");
      if (dlBtn) {
        ev.preventDefault();
        const exportId = dlBtn.getAttribute("data-payroll-download-id");
        const original = dlBtn.textContent;
        dlBtn.disabled = true;
        dlBtn.textContent = "Downloading…";
        downloadCsvViaAuthenticatedFetch(exportId)
          .catch(function (err) {
            console.error("[payroll] download failed", err);
            alert("Download failed: " + ((err && err.message) || "unknown"));
          })
          .finally(function () {
            dlBtn.disabled = false;
            dlBtn.textContent = original;
          });
        return;
      }
    });
    const exportSave = $("payroll-export-save");
    if (exportSave) exportSave.addEventListener("click", function () { submitExportConfirm(); });
    const voidSave = $("payroll-void-save");
    if (voidSave) voidSave.addEventListener("click", function () { submitVoid(); });
  }

  /* ---------- export surface ---------- */

  function init() { wire(); }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.payroll = {
    init:    init,
    refresh: refresh
  };
}());
