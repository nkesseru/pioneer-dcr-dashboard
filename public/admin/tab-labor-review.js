/* Pioneer DCR Hub — Admin Labor Review Lite tab (Phase 1e Lite, Path A).
 *
 * Surface: today's Pioneer Time Clock sessions for admin review.
 *
 * Two render blocks inside the #labor-review panel:
 *   1. "Open Active Sessions" — techs currently clocked in (active_service_sessions).
 *      Each card supports "Force close…" → opens #labor-force-close-modal.
 *   2. "Today's Sessions" — every pioneer_service_sessions doc where
 *      service_date == today (Pacific). Each row shows employee / customer /
 *      status / clock in/out / worked / budget / geo / DCR / needs_review
 *      and exposes a "Review" button when needs_review === true.
 *
 * Firestore I/O (admin-allowlist reads, isPioneerAdmin() updates — no rule
 * changes required by Phase 1e Lite):
 *   • pioneer_service_sessions  — read (service_date == today, client sort);
 *                                 update on Mark Reviewed + Force Close
 *   • active_service_sessions   — read (whole collection, small);
 *                                 delete on Force Close
 *   • service_assignments       — read by doc-id (budget_minutes, customer)
 *   • cleaning_techs            — read via __pioneerAdmin.deps.getTechs() cache
 *
 * Path A trade-off (per Phase 1e plan): admin force-close updates the session
 * doc and deletes the active-singleton, but does NOT write a time_punches
 * doc. The session metadata documents the override: force_closed_by_admin,
 * force_close_reason, force_closed_by, force_closed_at. Path B (proper
 * punch write with rule exemption) is deferred.
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * Exports window.__pioneerAdmin.tabs.laborReview = { init, refresh }.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-labor-review.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ---------- state ---------- */

  let sessions          = [];   // pioneer_service_sessions in range (sorted by service_date desc, clock_in desc)
  let activeByUid       = {};   // doc-id → active_service_sessions data
  let assignmentsById   = {};   // assignment_id → service_assignments data
  let techsByEmail      = {};   // staff_email → cleaning_techs row
  let techsByUid        = {};   // staff_uid   → cleaning_techs row
  let loaded            = false;
  let loading           = false;

  // Phase 2A.3 — range state. Default = today (today-only).
  // currentQuickFilter is "today" | "yesterday" | "last_7" | "last_30" |
  // "pay_period" | "custom" | null (initial). Drives the active-button
  // highlight; null on first paint means the buttons all show inactive.
  let rangeStart           = "";   // YYYY-MM-DD (Pacific)
  let rangeEnd             = "";
  let currentQuickFilter   = "today";
  let totalsCache          = null; // { totalWorked, totalRunning, needsReview, dcrPending, exceptions: { overBudget, offsite, adminRemoved, forceClosed } }
  let byEmployeeCache      = [];

  // Phase 2A.4 — status filter. Applied AFTER the Firestore range query,
  // BEFORE totals + by-employee + table render. Default "all" hides
  // archived sessions; "archived" is the only way to see them.
  // The Firestore field name for "archived" is `admin_removed: true`,
  // unchanged from Phase 2A.2 (the audit fields stay; only UI label flips
  // from "Removed" to "Archived" in Phase 2A.4).
  //
  // Phase 28A — payroll-state filters expand the set to 8. Filter value
  // "approved" maps to the Firestore field value "approved_for_payroll"
  // (filter string is shorter for the chip label).
  let currentStatusFilter  = "all";   // "all" | "needs_review" | "dcr_pending" | "archived"
                                       // | "pending_review" | "reviewed" | "approved" | "exported"
  let displaySessions      = [];      // filtered subset of `sessions`

  // Phase 29B — investigation filters. All four are pure client-side
  // after the Firestore range query. They compose with currentStatusFilter
  // multiplicatively. Persisted in sessionStorage so a tab round-trip
  // (e.g. Labor → Payroll → Labor) keeps the working set.
  let currentEmployeeFilter = "";   // "" = all; otherwise staff_uid OR "email:foo@bar"
  let currentSearchTerm     = "";   // case-insensitive substring
  let currentPayPeriodId    = "";   // "" = not driven by pay-period picker
  let payPeriodOptions      = [];   // [{ period_id, label, start_date, end_date }]
  const FILTERS_STORAGE_KEY = "labor-review.filters.v1";

  /* ---------- helpers ---------- */

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function fmtTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtDateTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtMinutes(m) {
    if (m == null || isNaN(m)) return "—";
    const n = Math.round(m);
    if (n <= 0) return "0m";
    const h = Math.floor(n / 60);
    const r = n % 60;
    if (h === 0) return r + "m";
    if (r === 0) return h + "h";
    return h + "h " + r + "m";
  }
  function liveElapsedMinutes(clockInAt) {
    const ms = tsToMs(clockInAt);
    if (!ms) return null;
    return Math.max(0, Math.round((Date.now() - ms) / 60000));
  }

  function techName(email, uid) {
    const t = (email && techsByEmail[email]) || (uid && techsByUid[uid]);
    if (t) {
      return t.display_name || t.first_name || t.email || email || uid || "Tech";
    }
    return email || uid || "Tech";
  }
  function customerLabel(session, assignment) {
    // Phase Timeclock Add-On — non-cleaning labor (inspection / supply
    // station) typically has no assigned customer. Render a friendly
    // label so the row doesn't show "—" and admin can tell at a glance
    // what kind of paid time it is.
    const lt = session && session.labor_type;
    if (lt === "supply_station") {
      return "Supply Pickup";
    }
    if (lt === "inspection") {
      const c = (session.customer_name || session.customer_slug || "").trim();
      return c ? "Inspection · " + c : "Inspection";
    }
    const name = (assignment && (assignment.customer_name || assignment.customer_slug))
              || session.customer_name
              || session.customer_slug
              || "—";
    const addr = (assignment && assignment.location_address) || session.location_address || "";
    if (addr) return name + " · " + addr;
    return name;
  }

  function statusChip(s, needsReview) {
    if (needsReview) {
      return '<span class="lr-chip is-review">Needs review</span>';
    }
    switch (s) {
      case "active":      return '<span class="lr-chip is-active">Active</span>';
      case "paused":      return '<span class="lr-chip is-paused">Paused</span>';
      case "dcr_pending": return '<span class="lr-chip is-dcr">DCR pending</span>';
      case "completed":   return '<span class="lr-chip is-complete">Complete</span>';
      case "canceled":    return '<span class="lr-chip is-canceled">Canceled</span>';
      case "missed":      return '<span class="lr-chip is-missed">Missed</span>';
      default:            return '<span class="lr-chip">' + escapeHtml(s || "—") + '</span>';
    }
  }
  // Phase 2A.2 — small chip rendered on rows whose underlying assignment
  // (or session) was admin-removed from PTC. Keeps the row visible for
  // audit but signals "no longer in the tech-facing PTC list."
  // Phase 2A.4 — "Removed from PTC" relabeled to "Archived" in the
  // admin UI. The underlying Firestore field (`admin_removed: true`) is
  // unchanged to preserve back-compat with Phase 2A.2 audit data.
  function removedChip() {
    return '<span class="lr-chip is-removed" title="Hidden from Pioneer Time Clock for the assigned tech">Archived</span>';
  }
  function geoChip(g) {
    if (!g) return "—";
    if (g === "onsite")  return '<span class="lr-geo is-onsite">Onsite</span>';
    if (g === "nearby")  return '<span class="lr-geo is-nearby">Nearby</span>';
    if (g === "offsite") return '<span class="lr-geo is-offsite">Offsite</span>';
    if (/^unknown/.test(g)) {
      return '<span class="lr-geo is-unknown" title="' + escapeHtml(g.replace(/_/g, " ")) +
        '">Unavailable</span>';
    }
    return escapeHtml(g);
  }
  function dcrChip(session) {
    const status = session.dcr_status || (session.dcr_id ? "submitted" : null);
    if (status === "submitted") return '<span class="lr-dcr is-submitted">DCR ✓</span>';
    if (status === "pending")   return '<span class="lr-dcr is-pending">DCR pending</span>';
    return '<span class="lr-dcr is-none">—</span>';
  }
  function needsReviewFlag(session) {
    return session.needs_review === true;
  }

  /* ---------- Phase 2A.3: range helpers ---------- */

  // Add or subtract whole days from a Pacific YYYY-MM-DD string. Uses UTC
  // arithmetic on noon-UTC anchored Dates to sidestep DST entirely.
  function addDaysPT(yyyymmdd, days) {
    const parts = String(yyyymmdd || "").split("-");
    if (parts.length !== 3) return yyyymmdd;
    const y = Number(parts[0]); const m = Number(parts[1]) - 1; const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m, d));
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
    // Day 0 of month+1 is the last day of month — locale-safe day-of-month.
    return new Date(yyyy, mm, 0).getDate();
  }
  // Semi-monthly pay periods per Phase 1a: A = 1–15, B = 16–EOM.
  // "Current Pay Period" returns the start of the period containing
  // today through TODAY (not the period close — admin wants progress).
  function getSemiMonthlyPeriodRange(todayPT) {
    const parts = String(todayPT || "").split("-");
    const y = Number(parts[0]); const m = Number(parts[1]); const d = Number(parts[2]);
    const mm = String(m).padStart(2, "0");
    if (d <= 15) {
      return { start_date: y + "-" + mm + "-01", end_date: todayPT };
    }
    return { start_date: y + "-" + mm + "-16", end_date: todayPT };
    // (period close for B is `lastDayOfMonth(y,m)`; not used here.)
  }
  function getQuickFilterRange(key, todayPT) {
    switch (key) {
      case "today":      return { start_date: todayPT, end_date: todayPT };
      case "yesterday":  { const y = addDaysPT(todayPT, -1); return { start_date: y, end_date: y }; }
      case "last_7":     return { start_date: addDaysPT(todayPT, -6),  end_date: todayPT };
      case "last_30":    return { start_date: addDaysPT(todayPT, -29), end_date: todayPT };
      case "pay_period": return getSemiMonthlyPeriodRange(todayPT);
      default:           return { start_date: todayPT, end_date: todayPT };
    }
  }

  // Phase 29B — semi-monthly pay-period option builder. Mirrors the
  // identical helper in tab-payroll.js so the two surfaces always agree
  // on which periods exist and what their labels are. Period A = 1–15,
  // Period B = 16–EOM. Returns 6 most recent periods (current + 5 prior).
  function fmtMonthDayShort(yyyymmdd) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
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
      label:      fmtMonthDayShort(start) + " – " + fmtMonthDayShort(end) + ", " + y,
      start_date: start,
      end_date:   end
    };
  }
  function getPriorSemiMonthlyPeriod(period) {
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
  function buildPayPeriodOptions(todayPT) {
    let cur = getSemiMonthlyPeriodForDate(todayPT);
    const out = [cur];
    for (let i = 0; i < 5; i++) {
      cur = getPriorSemiMonthlyPeriod(cur);
      out.push(cur);
    }
    return out;
  }

  // Phase 29B — sessionStorage persistence so tab nav round-trips don't
  // wipe the working set. Hard reload still resets (sessionStorage clears
  // with the tab). Keyed v1 so a future schema bump is uneventful.
  function saveFilterState() {
    try {
      const payload = {
        rangeStart: rangeStart, rangeEnd: rangeEnd,
        currentQuickFilter: currentQuickFilter,
        currentStatusFilter: currentStatusFilter,
        currentEmployeeFilter: currentEmployeeFilter,
        currentSearchTerm: currentSearchTerm,
        currentPayPeriodId: currentPayPeriodId
      };
      window.sessionStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch (_e) { /* sessionStorage may be unavailable in private mode — ignore */ }
  }
  function loadFilterState() {
    try {
      const raw = window.sessionStorage.getItem(FILTERS_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) || null;
    } catch (_e) { return null; }
  }
  function validateRange(start, end) {
    if (!start || !end) return "Pick both start and end dates.";
    if (start > end) return "End date is before start date.";
    const span = daysBetween(start, end);
    if (!Number.isFinite(span)) return "Invalid date.";
    if (span + 1 > 31) return "Range too wide — max 31 days. Try Last 30 Days.";
    return null;
  }
  function fmtServiceDate(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
  function fmtServiceDateLong(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "long", day: "numeric", year: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }

  /* ---------- Phase 28B: workweek + overtime allocation helpers ----------
   *
   * WASHINGTON WORKWEEK POLICY (confirmed):
   *   • Workweek = Sunday 00:00 → Saturday 23:59 Pacific.
   *   • Overtime trigger = 40 hours of worked time per workweek (2400 min).
   *   • Sick leave is EXCLUDED from the worked-hours bucket (paid leave,
   *     not hours worked — WA RCW 49.46.130 + ES.A.8.1 policy reading).
   *   • Paid drive time is NOT in the bucket yet. Field name
   *     `payable_work_minutes` (separate from a future `payable_drive_minutes`)
   *     signals this is the work-only sum today.
   *
   * The runtime engine fires on every Approve / Unapprove / Bulk Approve
   * action. It re-queries the (staff_uid, workweek_id) bucket from
   * Firestore (needs the new composite index), allocates regular/OT
   * chronologically by clock_in_at, and batch-writes the split to every
   * session in the bucket. Single source of truth at any moment.
   */
  const WEEKLY_REGULAR_CAP_MINUTES = 2400;   // 40h × 60m

  function pacificWeekday(date) {
    // 0 = Sunday ... 6 = Saturday in Pacific timezone.
    try {
      const wk = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short"
      }).format(date);
      const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const v = map[wk];
      return (v === undefined) ? null : v;
    } catch (_e) { return null; }
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
          timeZone: "America/Los_Angeles", month: "short", day: "numeric"
        }).format(new Date(id + "T12:00:00Z"));
      };
      const year = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", year: "numeric"
      }).format(new Date(endId + "T12:00:00Z"));
      return fmtMonthDay(workweekId) + " – " + fmtMonthDay(endId) + ", " + year;
    } catch (_e) { return workweekId + " → " + endId; }
  }

  // Phase 29A — payroll-facing minutes per session. Returns effective_minutes
  // when an approved time adjustment exists, otherwise the stored
  // work_minutes. Original session timestamps (clock_in_at / clock_out_at /
  // work_minutes) are never overwritten on approve, so this is the only
  // accessor that surfaces the adjusted total at read time. Mirrors the
  // helper of the same name in tab-payroll.js so summary totals across the
  // two surfaces agree to the minute.
  function effectiveWorkMinutes(s) {
    if (!s) return 0;
    if (s.has_approved_time_adjustment === true &&
        typeof s.effective_minutes === "number") {
      return s.effective_minutes;
    }
    return (typeof s.work_minutes === "number" && s.work_minutes > 0) ? s.work_minutes : 0;
  }

  // Pure allocation function — mutates each session with regular_minutes,
  // overtime_minutes, payable_work_minutes. Order of input array IS the
  // chronological order; caller must sort by clock_in_at ascending first.
  function allocateOvertime(sortedSessions) {
    let cumulativeRegular = 0;
    (sortedSessions || []).forEach(function (s) {
      const total = effectiveWorkMinutes(s);
      const budget = Math.max(0, WEEKLY_REGULAR_CAP_MINUTES - cumulativeRegular);
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

  // Initial range state — used by the very first refresh() to query before
  // the user has touched any control. Phase 29B: restores any filter set
  // saved in sessionStorage from a prior visit during this browser session.
  // Defaults to today/today (Pacific) when nothing is persisted.
  function ensureRangeInitialized() {
    if (rangeStart && rangeEnd) return;
    const saved = loadFilterState();
    if (saved && saved.rangeStart && saved.rangeEnd) {
      rangeStart            = saved.rangeStart;
      rangeEnd              = saved.rangeEnd;
      currentQuickFilter    = saved.currentQuickFilter    || "custom";
      currentStatusFilter   = saved.currentStatusFilter   || "all";
      currentEmployeeFilter = saved.currentEmployeeFilter || "";
      currentSearchTerm     = saved.currentSearchTerm     || "";
      currentPayPeriodId    = saved.currentPayPeriodId    || "";
      return;
    }
    const today = pacificDateString(new Date());
    const r = getQuickFilterRange("today", today);
    rangeStart = r.start_date;
    rangeEnd   = r.end_date;
    currentQuickFilter = "today";
  }

  /* ---------- Phase 2A.3: totals + by-employee ---------- */

  function isRunningSession(s) {
    return (s && s.status === "active") && !s.clock_out_at;
  }
  function isPausedSession(s) {
    return (s && s.status === "paused") && !s.clock_out_at;
  }
  function dcrPendingFlag(s) {
    if (!s) return false;
    // Phase Timeclock Add-On — DCR requirement applies only to cleaning
    // labor. Inspection / supply station sessions never produce a DCR
    // and must not be flagged as pending. Absent labor_type defaults to
    // cleaning for back-compat with every session written before the
    // field existed.
    const isCleaning = !s.labor_type || s.labor_type === "cleaning";
    if (!isCleaning) return false;
    if (s.status === "dcr_pending") return true;
    if (s.status !== "completed") return false;
    const submitted = (s.dcr_status === "submitted") || !!s.dcr_id;
    return !submitted;
  }
  // Phase 1e.2 set the over-budget threshold at +15 min. Reusing the
  // same threshold here keeps "over budget" consistent across DCR + admin.
  function overBudgetFlag(s, assignment) {
    const budget = (s && typeof s.budget_minutes === "number")
      ? s.budget_minutes
      : (assignment && typeof assignment.budget_minutes === "number"
          ? assignment.budget_minutes : null);
    if (budget == null || budget <= 0) return false;
    // Phase 29A — over-budget is a payroll signal, so compare against the
    // post-adjustment total. Falls back to work_minutes when no adjustment.
    const total = effectiveWorkMinutes(s);
    if (!(total > 0)) return false;
    return total > budget + 15;
  }
  function offsiteFlag(s) {
    return s && (s.clock_in_geo_status === "offsite" || s.clock_out_geo_status === "offsite");
  }
  function adminRemovedFlag(s) { return s && s.admin_removed === true; }
  function forceClosedFlag(s) { return s && s.force_closed_by_admin === true; }

  /* ---------- Phase 28A: payroll state + approval gates ---------- */

  // Absent payroll_state field → treat as "pending_review" per the
  // Phase 28 plan decision (no backfill on historical docs).
  function payrollState(s) {
    return (s && s.payroll_state) || "pending_review";
  }
  function payrollStateLabel(state) {
    switch (state) {
      case "pending_review":       return "Pending review";
      case "reviewed":             return "Reviewed";
      case "approved_for_payroll": return "Approved";
      case "exported":             return "Exported";
      default:                     return state || "—";
    }
  }
  function payrollChip(s) {
    const state = payrollState(s);
    const cls = "is-" + state.replace(/_/g, "-");
    const label = payrollStateLabel(state);
    const lockSuffix = (state === "exported") ? " 🔒" : "";
    return '<span class="lr-payroll-chip ' + cls + '">' +
           escapeHtml(label) + lockSuffix + '</span>';
  }
  // Phase 28B — small amber OT chip rendered next to the payroll chip
  // when a session has any overtime allocated. Helps admin visually scan
  // for OT incidence at a glance.
  function overtimeChip(s) {
    if (!s || !(typeof s.overtime_minutes === "number") || s.overtime_minutes <= 0) return "";
    return '<span class="lr-ot-chip" title="' +
           escapeHtml(fmtMinutes(s.overtime_minutes)) + ' overtime this session">OT</span>';
  }
  // Approve gate: row can move pending_review|reviewed → approved_for_payroll.
  // Refuses if any signal says "not clean payroll data."
  function approveGatePasses(s) {
    if (!s) return false;
    const state = payrollState(s);
    if (state !== "pending_review" && state !== "reviewed") return false;
    if (s.admin_removed === true) return false;
    if (s.needs_review === true) return false;
    if (s.status !== "completed") return false;     // active/paused/dcr_pending blocked
    if (typeof s.work_minutes !== "number" || s.work_minutes <= 0) return false;
    // Phase Timeclock Add-On — non-cleaning labor (inspection / supply
    // station) has no assignment_id and no DCR. Skip both checks for
    // those rows; cleaning sessions still require both.
    const isCleaning = !s.labor_type || s.labor_type === "cleaning";
    if (isCleaning) {
      if (!s.assignment_id) return false;
      const dcrSubmitted = (s.dcr_status === "submitted") || !!s.dcr_id;
      if (!dcrSubmitted) return false;
    }
    return true;
  }
  // Unapprove gate: row can move approved_for_payroll → reviewed, but only
  // if it hasn't been exported yet (exported sessions are locked; admin
  // must Void the export first — Phase 28D).
  function unapproveGatePasses(s) {
    if (!s) return false;
    if (payrollState(s) !== "approved_for_payroll") return false;
    if (s.payroll_export_id) return false;
    if (s.admin_removed === true) return false;
    return true;
  }

  // Phase 2A.4 — status filter. "all" excludes archived; "archived" shows
  // ONLY archived. The 0-of-3 non-archived filters share the
  // not-archived gate so admin never accidentally lumps archived rows
  // into the active review queue.
  function passesStatusFilter(s) {
    const isArchived = adminRemovedFlag(s);
    const state = payrollState(s);
    switch (currentStatusFilter) {
      case "archived":       return isArchived;
      case "needs_review":   return !isArchived && needsReviewFlag(s);
      case "dcr_pending":    return !isArchived && dcrPendingFlag(s);
      // Phase 28A — payroll-state filters. All four exclude archived rows.
      case "pending_review": return !isArchived && state === "pending_review";
      case "reviewed":       return !isArchived && state === "reviewed";
      case "approved":       return !isArchived && state === "approved_for_payroll";
      case "exported":       return !isArchived && state === "exported";
      case "all":
      default:               return !isArchived;
    }
  }
  // Phase 29B — employee key for a session. Matches the key shape used
  // by groupByEmployee so the same string drives the dropdown, the card
  // selection state, and the filter predicate.
  function employeeKeyFor(s) {
    if (!s) return "";
    if (s.staff_uid) return s.staff_uid;
    if (s.staff_email) return "email:" + s.staff_email;
    return "";
  }
  function passesEmployeeFilter(s) {
    if (!currentEmployeeFilter) return true;
    return employeeKeyFor(s) === currentEmployeeFilter;
  }
  // Phase 29B — search across tech display name, tech email, customer
  // name, location name + address, and the two admin-write reason
  // fields. Case-insensitive substring. Empty term → pass-through.
  function passesSearchFilter(s) {
    const term = (currentSearchTerm || "").trim().toLowerCase();
    if (!term) return true;
    const a = s && s.assignment_id ? assignmentsById[s.assignment_id] : null;
    const techNm = techName(s.staff_email, s.staff_uid);
    const haystack = [
      techNm,
      s.staff_email,
      (a && a.customer_name) || s.customer_name,
      (a && a.customer_slug) || s.customer_slug,
      (a && a.location_name) || s.location_name,
      (a && a.location_address) || s.location_address,
      s.force_close_reason,
      s.removed_reason
    ].filter(Boolean).join("  ").toLowerCase();
    return haystack.indexOf(term) !== -1;
  }
  function filterSessions(arr) {
    return (arr || []).filter(function (s) {
      return passesStatusFilter(s) && passesEmployeeFilter(s) && passesSearchFilter(s);
    });
  }

  // Centralized re-derive of the filtered subset + downstream caches.
  // Called both at end of refresh() and on every filter change — the
  // click path skips Firestore entirely (data is already loaded).
  //
  // Phase 29B — `byEmployeeSource` is the status + search filter result
  // WITHOUT the employee filter, so the By Employee cards always show the
  // full roster scoped to the current view. That lets admin switch the
  // selected employee with one click. The Sessions table itself
  // ("displaySessions") respects all four filters.
  function recomputeDisplay() {
    const statusAndSearch = (sessions || []).filter(function (s) {
      return passesStatusFilter(s) && passesSearchFilter(s);
    });
    displaySessions = statusAndSearch.filter(passesEmployeeFilter);
    totalsCache     = computeTotals(displaySessions);
    byEmployeeCache = groupByEmployee(statusAndSearch);
  }

  function computeTotals(arr) {
    const out = {
      totalWorked: 0, totalRunning: 0, needsReview: 0, dcrPending: 0,
      // Phase 28B — totalOvertime is the sum of overtime_minutes across
      // approved/exported sessions in the filtered set. otTechsCount is
      // the number of distinct techs with any OT.
      totalOvertime: 0, otTechsCount: 0,
      exceptions: { overBudget: 0, offsite: 0, adminRemoved: 0, forceClosed: 0 }
    };
    const techsWithOt = new Set();
    (arr || []).forEach(function (s) {
      const assignment = s.assignment_id ? assignmentsById[s.assignment_id] : null;
      if (isRunningSession(s)) {
        out.totalRunning += (liveElapsedMinutes(s.clock_in_at) || 0);
      } else {
        // Phase 29A — totalWorked must reflect approved adjustments so the
        // Labor Review header matches Payroll Summary and the CSV.
        out.totalWorked += effectiveWorkMinutes(s);
      }
      if (typeof s.overtime_minutes === "number" && s.overtime_minutes > 0) {
        out.totalOvertime += s.overtime_minutes;
        if (s.staff_uid) techsWithOt.add(s.staff_uid);
      }
      if (needsReviewFlag(s))   out.needsReview += 1;
      if (dcrPendingFlag(s))    out.dcrPending  += 1;
      if (overBudgetFlag(s, assignment)) out.exceptions.overBudget   += 1;
      if (offsiteFlag(s))                out.exceptions.offsite      += 1;
      if (adminRemovedFlag(s))           out.exceptions.adminRemoved += 1;
      if (forceClosedFlag(s))            out.exceptions.forceClosed  += 1;
    });
    out.otTechsCount = techsWithOt.size;
    return out;
  }
  function groupByEmployee(arr) {
    const map = new Map();
    (arr || []).forEach(function (s) {
      const key = employeeKeyFor(s) || "(unknown)";
      if (!map.has(key)) {
        map.set(key, {
          key:             key,
          staff_uid:       s.staff_uid || "",
          staff_email:     s.staff_email || "",
          name:            techName(s.staff_email, s.staff_uid),
          sessions_count:  0,
          worked_minutes:  0,
          running_minutes: 0,
          overtime_minutes: 0,   // Phase 28B
          needs_review:    0,
          dcr_pending:     0,
          // Phase 29B — investigation counts on the card.
          adjusted_count:   0,    // sessions with has_approved_time_adjustment === true
          exception_count:  0     // unresolved exceptions (see definition below)
        });
      }
      const row = map.get(key);
      row.sessions_count += 1;
      if (isRunningSession(s)) {
        row.running_minutes += (liveElapsedMinutes(s.clock_in_at) || 0);
      } else {
        // Phase 29A — per-employee aggregate must match Payroll Summary.
        row.worked_minutes += effectiveWorkMinutes(s);
      }
      if (typeof s.overtime_minutes === "number" && s.overtime_minutes > 0) {
        row.overtime_minutes += s.overtime_minutes;
      }
      if (needsReviewFlag(s)) row.needs_review += 1;
      if (dcrPendingFlag(s))  row.dcr_pending  += 1;
      if (s.has_approved_time_adjustment === true) row.adjusted_count += 1;
      // Phase 29B exception definition: any of needs_review, dcr_pending,
      // over_budget (effective > budget+15), offsite, force_closed.
      // Excludes admin_removed — those are archived and live under the
      // "Archived" status filter, not the unresolved-exception bucket.
      const assignment = s.assignment_id ? assignmentsById[s.assignment_id] : null;
      if (needsReviewFlag(s) ||
          dcrPendingFlag(s) ||
          overBudgetFlag(s, assignment) ||
          offsiteFlag(s) ||
          forceClosedFlag(s)) {
        row.exception_count += 1;
      }
    });
    return Array.from(map.values()).sort(function (a, b) {
      const ta = a.worked_minutes + a.running_minutes;
      const tb = b.worked_minutes + b.running_minutes;
      if (tb !== ta) return tb - ta;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  /* ---------- loaders ---------- */

  function setState(state, message) {
    const loadingEl = $("labor-loading");
    const errorEl   = $("labor-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && message) errorEl.textContent = message;
    }
  }

  async function loadAssignmentsByIds(ids) {
    const db = firebase.firestore();
    const unique = Array.from(new Set(ids.filter(Boolean)));
    const need = unique.filter(function (id) { return !assignmentsById[id]; });
    if (!need.length) return;
    const snaps = await Promise.all(need.map(function (id) {
      return db.collection("service_assignments").doc(id).get().catch(function () { return null; });
    }));
    snaps.forEach(function (s, i) {
      if (s && s.exists) {
        assignmentsById[need[i]] = Object.assign({ _id: s.id }, s.data() || {});
      } else {
        assignmentsById[need[i]] = null;
      }
    });
  }

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
      if (t.email) techsByEmail[t.email.toLowerCase()] = t;
      if (t.uid)   techsByUid[t.uid] = t;
    });
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      hydrateTechMaps();
      ensureRangeInitialized();
      const db = firebase.firestore();

      // Phase 2A.3 — pioneer_service_sessions query now spans a date range.
      // Single-field equality+range; no composite index needed. Admin scope
      // by rule isPioneerAdmin(). active_service_sessions stays
      // date-agnostic (always "who is clocked in right now").
      const [sessSnap, activeSnap] = await Promise.all([
        db.collection("pioneer_service_sessions")
          .where("service_date", ">=", rangeStart)
          .where("service_date", "<=", rangeEnd)
          .get(),
        db.collection("active_service_sessions").get()
      ]);

      sessions = sessSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      // Sort by service_date desc, then clock_in desc within a date.
      sessions.sort(function (a, b) {
        const sd = String(b.service_date || "").localeCompare(String(a.service_date || ""));
        if (sd !== 0) return sd;
        return tsToMs(b.clock_in_at) - tsToMs(a.clock_in_at);
      });

      activeByUid = {};
      activeSnap.docs.forEach(function (d) {
        activeByUid[d.id] = Object.assign({ _id: d.id }, d.data() || {});
      });

      // Hydrate assignments referenced by either source.
      const ids = [];
      sessions.forEach(function (s) { if (s.assignment_id) ids.push(s.assignment_id); });
      Object.keys(activeByUid).forEach(function (uid) {
        const a = activeByUid[uid];
        if (a && a.assignment_id) ids.push(a.assignment_id);
      });
      await loadAssignmentsByIds(ids);

      // Phase 2A.4 — apply the active status filter to derive what
      // the panel actually shows. Totals + By Employee follow the
      // filter so admin can answer "how many bad sessions this period?"
      // with one click on Archived.
      recomputeDisplay();

      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[labor-review] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read access to pioneer_service_sessions + active_service_sessions."
        : "Couldn't load labor data: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderRangeControlsState();
    renderPayPeriodPicker();
    renderEmployeePicker();
    renderSearchInputState();
    renderActiveFilterChips();
    renderTotals();
    renderActive();
    renderByEmployee();
    renderTable();
    renderSessionsCount();
    renderBulkApproveBar();
  }

  // Phase 29B — keep the search input in sync with state (e.g. on
  // navigation-restore or after a chip × clears the term).
  function renderSearchInputState() {
    const el = $("labor-search-input");
    if (el && el.value !== currentSearchTerm) el.value = currentSearchTerm || "";
  }
  // Phase 29B — "Sessions (showing X of Y · {scope})" header. Y = total
  // sessions in the Firestore range; X = sessions after all filters.
  // Scope describes the non-default filters at a glance.
  function renderSessionsCount() {
    const el = $("labor-sessions-count");
    if (!el) return;
    const y = sessions.length;
    const x = displaySessions.length;
    const scopeParts = [];
    if (currentStatusFilter && currentStatusFilter !== "all") scopeParts.push(currentStatusFilter.replace(/_/g, " "));
    if (currentEmployeeFilter) {
      const found = (byEmployeeCache || []).find(function (r) { return r.key === currentEmployeeFilter; });
      scopeParts.push(found ? found.name : "1 employee");
    }
    if (currentSearchTerm && currentSearchTerm.trim()) scopeParts.push('"' + currentSearchTerm.trim() + '"');
    const scope = scopeParts.length ? (" · " + scopeParts.join(" · ")) : "";
    el.textContent = "(showing " + x + " of " + y + scope + ")";
  }

  // Phase 28A — Bulk Approve bar above the Sessions table. Visible
  // whenever there's at least one approvable row in the current view.
  // Click → confirmation modal (which respects the 50-session cap).
  function renderBulkApproveBar() {
    const wrap = $("labor-bulk-bar");
    if (!wrap) return;
    const ready = approvableInCurrentView();
    if (!ready.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
    wrap.hidden = false;
    const capped = (ready.length > BULK_APPROVE_CAP);
    const label = capped
      ? "Approve first " + BULK_APPROVE_CAP + " of " + ready.length + " ready sessions"
      : "Approve all " + ready.length + " ready session" + (ready.length === 1 ? "" : "s");
    wrap.innerHTML =
      '<div class="labor-bulk-msg">' +
        '<strong>' + ready.length + '</strong> session' + (ready.length === 1 ? "" : "s") +
        ' in this view pass all payroll gates.' +
        (capped ? ' <span class="labor-bulk-cap">(cap: ' + BULK_APPROVE_CAP + ' per click)</span>' : '') +
      '</div>' +
      '<button type="button" class="labor-bulk-btn" id="labor-bulk-open">' +
        escapeHtml(label) +
      '</button>';
  }

  // Phase 2A.2 regression instrumentation — visible build marker so admin
  // can confirm in one glance which code path is actually rendering the
  // Labor panel. Bumped any time the table render path changes.
  const LABOR_BUILD_TAG = "Labor v29B-investigation";

  function renderHeader() {
    const sub = $("labor-sub");
    if (!sub) return;
    let label;
    if (rangeStart && rangeEnd && rangeStart === rangeEnd) {
      label = fmtServiceDateLong(rangeStart);
    } else if (rangeStart && rangeEnd) {
      const days = daysBetween(rangeStart, rangeEnd) + 1;
      label = fmtServiceDate(rangeStart) + " → " + fmtServiceDate(rangeEnd) +
              " (" + days + " day" + (days === 1 ? "" : "s") + ")";
    } else {
      label = "Today";
    }
    const activeCount = Object.keys(activeByUid).length;
    const needsReviewCount = sessions.filter(needsReviewFlag).length;
    // Visible build tag (last segment) confirms which JS is rendering.
    sub.textContent = label + " · " + sessions.length + " session" +
      (sessions.length === 1 ? "" : "s") +
      " · " + activeCount + " open · " + needsReviewCount + " needs review" +
      " · " + LABOR_BUILD_TAG;
  }

  // Phase 2A.3 — sync the date inputs + quick-filter button highlight to
  // current range state. Called each render so the controls match the
  // data shown below. Defensive on missing DOM (admin.html may not have
  // shipped the controls in older deploys).
  function renderRangeControlsState() {
    const startEl = $("labor-range-start");
    const endEl   = $("labor-range-end");
    if (startEl && rangeStart) startEl.value = rangeStart;
    if (endEl   && rangeEnd)   endEl.value   = rangeEnd;

    document.querySelectorAll("[data-labor-quick]").forEach(function (b) {
      const key = b.getAttribute("data-labor-quick");
      const active = (key === currentQuickFilter);
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });

    // Phase 2A.4 — status filter chip highlight.
    document.querySelectorAll("[data-labor-status]").forEach(function (b) {
      const key = b.getAttribute("data-labor-status");
      const active = (key === currentStatusFilter);
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });

    // Range error banner — cleared by default; set when validate fails.
    const errEl = $("labor-range-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
  }

  function renderTotals() {
    const wrap = $("labor-totals");
    if (!wrap) return;
    const t = totalsCache || computeTotals(sessions);
    const ex = t.exceptions || { overBudget: 0, offsite: 0, adminRemoved: 0, forceClosed: 0 };
    const exTotal = ex.overBudget + ex.offsite + ex.adminRemoved + ex.forceClosed;
    function tile(label, value, sub) {
      return '<div class="labor-tile">' +
               '<div class="labor-tile-label">' + escapeHtml(label) + '</div>' +
               '<div class="labor-tile-value">' + escapeHtml(value) + '</div>' +
               (sub ? '<div class="labor-tile-sub">' + sub + '</div>' : '') +
             '</div>';
    }
    const exSubLines =
      '<span title="effective minutes (post-adjustment) > budget + 15">OB ' + ex.overBudget + '</span> · ' +
      '<span title="clock_in or clock_out offsite">OS ' + ex.offsite + '</span> · ' +
      '<span title="admin_removed = true">AR ' + ex.adminRemoved + '</span> · ' +
      '<span title="force_closed_by_admin">FC ' + ex.forceClosed + '</span>';
    // Phase 28B — Overtime tile. Sub-line shows distinct techs with OT.
    const otSub = (t.totalOvertime > 0)
      ? (t.otTechsCount + ' tech' + (t.otTechsCount === 1 ? '' : 's') + ' with OT')
      : 'No OT in this view';
    wrap.innerHTML =
      tile("Sessions",     String(sessions.length), null) +
      tile("Worked",       fmtMinutes(t.totalWorked),  null) +
      tile("Running",      fmtMinutes(t.totalRunning), t.totalRunning > 0 ? '<span class="labor-tile-running-dot" aria-hidden="true">●</span> live' : null) +
      tile("Overtime",     fmtMinutes(t.totalOvertime), otSub) +
      tile("Needs review", String(t.needsReview),   null) +
      tile("DCR pending",  String(t.dcrPending),    null) +
      tile("Exceptions",   String(exTotal),         exSubLines);
  }

  function renderByEmployee() {
    const wrap = $("labor-by-employee-list");
    const empty = $("labor-by-employee-empty");
    if (!wrap || !empty) return;
    const rows = byEmployeeCache || groupByEmployee(sessions);
    if (!rows.length) { wrap.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    wrap.innerHTML = rows.map(function (r) {
      const runningChip = r.running_minutes > 0
        ? ' <span class="labor-be-running">+ running ' + escapeHtml(fmtMinutes(r.running_minutes)) + '</span>'
        : '';
      // Phase 28B — inline OT chip on the time line when this tech has OT.
      const otChip = r.overtime_minutes > 0
        ? ' <span class="labor-be-ot">incl. ' + escapeHtml(fmtMinutes(r.overtime_minutes)) + ' OT</span>'
        : '';
      // Phase 29B — Adj ✓ count + unresolved-exception count as
      // dedicated card stats; the long flag chips below show what KIND
      // of exception (review vs DCR pending) for quick recognition.
      const adjChip = '<span class="labor-be-adj' + (r.adjusted_count > 0 ? ' has-count' : '') +
        '">Adj ✓ ' + r.adjusted_count + '</span>';
      const excChip = '<span class="labor-be-exc' + (r.exception_count > 0 ? ' has-count' : '') +
        '">⚠ ' + r.exception_count + ' exception' + (r.exception_count === 1 ? '' : 's') + '</span>';
      const flags = [];
      if (r.needs_review > 0) flags.push('<span class="labor-be-flag is-review">' + r.needs_review + ' needs review</span>');
      if (r.dcr_pending  > 0) flags.push('<span class="labor-be-flag is-dcr">' + r.dcr_pending + ' DCR pending</span>');
      const isSelected = (currentEmployeeFilter && currentEmployeeFilter === r.key);
      const selectedMark = isSelected
        ? '<span class="labor-be-check" aria-label="Filter active">✓</span>'
        : '';
      return (
        '<div class="labor-be-row' + (isSelected ? ' is-selected' : '') + '"' +
            ' data-employee-key="' + escapeHtml(r.key) + '"' +
            ' role="button" tabindex="0"' +
            ' aria-pressed="' + (isSelected ? 'true' : 'false') + '"' +
            ' title="Click to filter Sessions to ' + escapeHtml(r.name) + '">' +
          '<div class="labor-be-name">' + escapeHtml(r.name) + selectedMark + '</div>' +
          '<div class="labor-be-count">' + r.sessions_count + ' session' +
            (r.sessions_count === 1 ? "" : "s") + '</div>' +
          '<div class="labor-be-time">' +
            escapeHtml(fmtMinutes(r.worked_minutes)) + ' worked' + otChip + runningChip +
          '</div>' +
          '<div class="labor-be-stats">' + adjChip + ' · ' + excChip + '</div>' +
          '<div class="labor-be-flags">' + flags.join(" ") + '</div>' +
        '</div>'
      );
    }).join("");
  }

  // Phase 29B — Pay-period dropdown. First option is current period
  // (live since admin most often investigates the current bucket), then
  // 5 prior periods. Final option is a Custom sentinel that just clears
  // the pay-period filter and surfaces the date inputs.
  function renderPayPeriodPicker() {
    const sel = $("labor-pay-period-select");
    if (!sel) return;
    if (!payPeriodOptions.length) {
      payPeriodOptions = buildPayPeriodOptions(pacificDateString(new Date()));
    }
    const opts = payPeriodOptions.map(function (p, i) {
      const prefix = (i === 0) ? "Current · " : "";
      const selected = (p.period_id === currentPayPeriodId) ? " selected" : "";
      return '<option value="' + escapeHtml(p.period_id) + '"' + selected + '>' +
             escapeHtml(prefix + p.label) + '</option>';
    }).join("");
    const customSelected = currentPayPeriodId === "" ? " selected" : "";
    sel.innerHTML =
      '<option value=""' + customSelected + '>— Not pay-period scoped —</option>' +
      opts;
  }

  // Phase 29B — Employee dropdown. Union of (a) the techs roster
  // (so techs with no sessions in range still appear and can be picked)
  // and (b) any staff_uid/email present in the loaded sessions (covers
  // historical sessions whose staff was archived from the roster).
  // Single-select; "All employees" is the default.
  function renderEmployeePicker() {
    const sel = $("labor-employee-select");
    if (!sel) return;
    const seen = new Map();
    function add(key, name) {
      if (!key) return;
      if (!seen.has(key)) seen.set(key, name || key);
    }
    // Roster.
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      const list = (deps && typeof deps.getTechs === "function") ? (deps.getTechs() || []) : [];
      list.forEach(function (t) {
        if (!t) return;
        const key = t.uid ? t.uid : (t.email ? "email:" + t.email : "");
        add(key, t.display_name || t.first_name || t.email || "Tech");
      });
    } catch (_e) { /* roster optional */ }
    // Sessions in the current Firestore range.
    (sessions || []).forEach(function (s) {
      add(employeeKeyFor(s), techName(s.staff_email, s.staff_uid));
    });
    const rows = Array.from(seen.entries()).map(function (e) {
      return { key: e[0], name: e[1] };
    });
    rows.sort(function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    const allSelected = currentEmployeeFilter === "" ? " selected" : "";
    const opts = rows.map(function (r) {
      const selected = (r.key === currentEmployeeFilter) ? " selected" : "";
      return '<option value="' + escapeHtml(r.key) + '"' + selected + '>' +
             escapeHtml(r.name) + '</option>';
    }).join("");
    sel.innerHTML =
      '<option value=""' + allSelected + '>All employees (' + rows.length + ')</option>' +
      opts;
  }

  // Phase 29B — Active-filter chip strip beneath the filter controls.
  // Shows every NON-DEFAULT filter as a removable chip so admin can see
  // at a glance why the table is scoped the way it is. Date range is
  // intentionally excluded — the date controls themselves are visible.
  function renderActiveFilterChips() {
    const wrap = $("labor-active-filters");
    if (!wrap) return;
    const chips = [];
    if (currentStatusFilter && currentStatusFilter !== "all") {
      const label = ({
        needs_review:  "Needs Review",
        dcr_pending:   "DCR Pending",
        archived:      "Archived",
        pending_review:"Pending Review",
        reviewed:      "Reviewed",
        approved:      "Approved",
        exported:      "Exported"
      })[currentStatusFilter] || currentStatusFilter;
      chips.push(
        '<button type="button" class="labor-active-chip" data-clear="status" ' +
          'aria-label="Clear status filter">' +
          'Status: ' + escapeHtml(label) +
          ' <span aria-hidden="true">×</span>' +
        '</button>'
      );
    }
    if (currentEmployeeFilter) {
      const found = (byEmployeeCache || []).find(function (r) { return r.key === currentEmployeeFilter; });
      const label = found ? found.name : currentEmployeeFilter;
      chips.push(
        '<button type="button" class="labor-active-chip" data-clear="employee" ' +
          'aria-label="Clear employee filter">' +
          escapeHtml(label) +
          ' <span aria-hidden="true">×</span>' +
        '</button>'
      );
    }
    if (currentSearchTerm && currentSearchTerm.trim()) {
      chips.push(
        '<button type="button" class="labor-active-chip" data-clear="search" ' +
          'aria-label="Clear search">' +
          '🔍 ' + escapeHtml(currentSearchTerm.trim()) +
          ' <span aria-hidden="true">×</span>' +
        '</button>'
      );
    }
    if (currentPayPeriodId) {
      const p = payPeriodOptions.find(function (x) { return x.period_id === currentPayPeriodId; });
      if (p) {
        chips.push(
          '<button type="button" class="labor-active-chip" data-clear="payperiod" ' +
            'aria-label="Clear pay period">' +
            'Pay period: ' + escapeHtml(p.label) +
            ' <span aria-hidden="true">×</span>' +
          '</button>'
        );
      }
    }
    if (!chips.length) {
      wrap.innerHTML = ""; wrap.hidden = true; return;
    }
    wrap.hidden = false;
    wrap.innerHTML =
      chips.join("") +
      '<button type="button" class="labor-active-clear" data-clear="all">Clear all</button>';
  }

  function renderActive() {
    const section = $("labor-active-section");
    const list  = $("labor-active-list");
    const empty = $("labor-active-empty");
    if (!list || !empty) return;
    const uids = Object.keys(activeByUid);
    // Phase 29B — when zero active sessions, hide the entire section
    // (heading + sub + empty placeholder). The empty <p> is left in the
    // DOM for code symmetry but is unreachable.
    if (!uids.length) {
      list.innerHTML = ""; empty.hidden = false;
      if (section) section.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    empty.hidden = true;
    // Sort by most recent clock-in first.
    uids.sort(function (a, b) {
      return tsToMs(activeByUid[b].clock_in_at) - tsToMs(activeByUid[a].clock_in_at);
    });
    list.innerHTML = uids.map(function (uid) {
      const a = activeByUid[uid];
      const sid = a.session_id || a.pioneer_session_id || a.pioneer_service_session_id || "";
      const sess = sessions.find(function (s) { return s._id === sid; }) || null;
      const assignment = a.assignment_id ? assignmentsById[a.assignment_id] : null;
      const elapsed = liveElapsedMinutes(a.clock_in_at);
      const tech = techName(a.staff_email, uid);
      const cust = customerLabel(sess || a, assignment);
      const stat = (sess && sess.status) || "active";
      return (
        '<article class="labor-active-card" data-session-id="' + escapeHtml(sid) + '" ' +
                  'data-active-uid="' + escapeHtml(uid) + '">' +
          '<header class="labor-active-head">' +
            '<div class="labor-active-who">' +
              '<div class="labor-active-name">' + escapeHtml(tech) + '</div>' +
              '<div class="labor-active-sub">' + escapeHtml(cust) + '</div>' +
            '</div>' +
            statusChip(stat, sess && needsReviewFlag(sess)) +
          '</header>' +
          '<div class="labor-active-meta">' +
            '<span>Clocked in <strong>' + escapeHtml(fmtTime(a.clock_in_at)) + '</strong></span>' +
            (elapsed != null ? '<span>· ' + escapeHtml(fmtMinutes(elapsed)) + ' running</span>' : '') +
            (sess && sess.clock_in_geo_status
              ? '<span>· ' + geoChip(sess.clock_in_geo_status) + '</span>'
              : '') +
          '</div>' +
          '<div class="labor-active-actions">' +
            '<button type="button" class="labor-btn labor-btn-danger" data-act="force-close">' +
              'Force close…</button>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  // Phase 2A.2 — combined status display (legacy chip + optional
  // "Removed from PTC" chip when the session was admin-removed).
  // Phase 28A — append the payroll-state chip so admin sees both bits
  // at a glance.
  // Phase 28B — also append the OT chip when overtime_minutes > 0.
  function sessionStatusDisplay(s) {
    const base = statusChip(s.status, needsReviewFlag(s));
    const archivedPrefix = (s && s.admin_removed === true) ? (removedChip() + " ") : "";
    const payrollSuffix  = " " + payrollChip(s);
    const otSuffix       = overtimeChip(s) ? (" " + overtimeChip(s)) : "";
    return archivedPrefix + base + payrollSuffix + otSuffix;
  }
  function removedMetaLine(s) {
    if (!s || s.admin_removed !== true) return "";
    const who = (s.removed_by && (s.removed_by.displayName || s.removed_by.email)) || "admin";
    const when = s.removed_at ? fmtDateTime(s.removed_at) : "";
    const reason = s.removed_reason ? " — " + s.removed_reason : "";
    return '<div class="lr-removed-meta">Archived' +
           (when ? ' ' + escapeHtml(when) : '') +
           ' by ' + escapeHtml(who) +
           escapeHtml(reason) +
           '</div>';
  }

  function renderTable() {
    try { return renderTableInner(); }
    catch (err) {
      try { console.error("[labor-review] renderTable threw", err); } catch (_e) {}
      const wrap = $("labor-table");
      if (wrap) {
        wrap.innerHTML =
          '<div class="admin-status admin-error">renderTable failed: ' +
          escapeHtml((err && err.message) || "unknown") +
          ' (build: ' + LABOR_BUILD_TAG + ')</div>';
      }
    }
  }
  function renderTableInner() {
    const wrap = $("labor-table");
    const empty = $("labor-table-empty");
    if (!wrap || !empty) return;
    // Phase 2A.4 — table renders the filtered subset. Empty-state message
    // reflects whether the filter scoped everything out vs the range
    // having no sessions at all.
    const shown = displaySessions || [];
    if (!shown.length) {
      wrap.innerHTML = "";
      if (sessions.length > 0 && currentStatusFilter !== "all") {
        empty.textContent = "No sessions match the " +
          (currentStatusFilter === "needs_review" ? "Needs Review"
            : currentStatusFilter === "dcr_pending" ? "DCR Pending"
            : currentStatusFilter === "archived"   ? "Archived" : "current") +
          " filter in this range.";
      } else {
        empty.textContent = "No Pioneer Time Clock sessions in this range.";
      }
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const headerHtml =
      '<div class="labor-row labor-row-head">' +
        '<div class="lr-col-date">Date</div>' +
        '<div class="lr-col-emp">Employee</div>' +
        '<div class="lr-col-cust">Customer</div>' +
        '<div class="lr-col-status">Status</div>' +
        '<div class="lr-col-in">In</div>' +
        '<div class="lr-col-out">Out</div>' +
        '<div class="lr-col-wkd">Worked</div>' +
        '<div class="lr-col-bgt">Budget</div>' +
        '<div class="lr-col-geo">Geo (in/out)</div>' +
        '<div class="lr-col-dcr">DCR</div>' +
        '<div class="lr-col-act">Actions</div>' +
      '</div>';
    // Phase 2A.2 regression — pin the render-version on the wrap so a
    // DevTools inspector can confirm in one click which code rendered
    // the current table. Survives across refresh cycles since render
    // overwrites this attribute every time.
    try { wrap.setAttribute("data-render-version", LABOR_BUILD_TAG); } catch (_e) {}

    const rowsHtml = shown.map(function (s) {
      const assignment = s.assignment_id ? assignmentsById[s.assignment_id] : null;
      const budget = (s.budget_minutes != null ? s.budget_minutes
                  : (assignment && assignment.budget_minutes != null ? assignment.budget_minutes
                  : null));
      // Phase 2A.2 regression — Worked label rewrite for active/paused
      // rows. Prior code returned `s.work_minutes` whenever it was non-
      // null, which surfaced 0m on active sessions because work_minutes
      // is initialized to 0 on clock-in (only filled in on clock-out).
      // New precedence: if the row is currently running (no clock_out_at),
      // ignore work_minutes entirely and show the live elapsed time as
      // "Running Xh Ym". Paused rows get a "Paused Xh Ym" treatment.
      const isRunning = (s.status === "active") && !s.clock_out_at;
      const isPausedRow = (s.status === "paused") && !s.clock_out_at;
      const elapsed = liveElapsedMinutes(s.clock_in_at);
      // Phase 2A.4 — completed / dcr_pending rows with work_minutes === 0
      // (or null) are suspicious. Show "Review Required" instead of an
      // authoritative "0m" so admin doesn't gloss over a likely-bad clean.
      const isTerminalZero =
        (s.status === "completed" || s.status === "dcr_pending") &&
        (s.work_minutes === 0 || s.work_minutes == null);
      // Phase 28B — workedHtml is the (potentially HTML-containing)
      // rendering for the Worked column. Replaces the legacy escapeHtml
      // wrap so we can inject the amber OT line. All text branches
      // explicitly escapeHtml their content.
      let workedHtml;
      let workedClass = "";
      if (isRunning) {
        workedHtml = escapeHtml("Running " + fmtMinutes(elapsed != null ? elapsed : 0));
      } else if (isPausedRow) {
        const fallback = (s.work_minutes != null) ? s.work_minutes : elapsed;
        workedHtml = escapeHtml("Paused " + fmtMinutes(fallback != null ? fallback : 0));
      } else if (isTerminalZero) {
        workedHtml = escapeHtml("Review Required");
        workedClass = " is-review-required";
      } else if (s.work_minutes != null) {
        // Phase 29A — adjusted sessions render Final (effective) on the
        // primary line plus an Original / +adj subline. Original session
        // timestamps and work_minutes are never overwritten on approve, so
        // this is purely a read-time presentation layer.
        const adjusted = (s.has_approved_time_adjustment === true &&
                         typeof s.effective_minutes === "number");
        const finalMin = adjusted ? s.effective_minutes : s.work_minutes;
        const hasOt = (typeof s.overtime_minutes === "number" && s.overtime_minutes > 0);
        if (hasOt) {
          const reg = (typeof s.regular_minutes === "number") ? s.regular_minutes : finalMin;
          workedHtml = escapeHtml(fmtMinutes(reg)) +
            '<span class="lr-ot-line"> + ' + escapeHtml(fmtMinutes(s.overtime_minutes)) + ' OT</span>';
        } else {
          workedHtml = escapeHtml(fmtMinutes(finalMin));
        }
        if (adjusted) {
          const delta = (typeof s.effective_minutes === "number" &&
                         typeof s.work_minutes === "number")
            ? (s.effective_minutes - s.work_minutes) : 0;
          const sign = delta > 0 ? "+" : (delta < 0 ? "−" : "±");
          const deltaMag = Math.abs(delta);
          workedHtml +=
            '<div class="lr-adj-line">' +
              'Original ' + escapeHtml(fmtMinutes(s.work_minutes)) +
              ' · <span class="lr-adj-delta">' + sign +
                escapeHtml(fmtMinutes(deltaMag)) + ' adj</span>' +
              ' <span class="lr-adj-chip" title="Time adjustment approved">Adj ✓</span>' +
            '</div>';
        }
      } else {
        workedHtml = "—";
      }
      const reviewBtn = needsReviewFlag(s)
        ? '<button type="button" class="labor-btn labor-btn-review" data-act="mark-reviewed">Review</button>'
        : '';
      // Phase 2A.4 — Link DCR placeholder. Visible per row when DCR is
      // pending and the row isn't archived. Click opens a "Coming in
      // Phase 2B" modal — no write path yet.
      const linkDcrBtn = (dcrPendingFlag(s) && !adminRemovedFlag(s))
        ? '<button type="button" class="labor-btn labor-btn-linkdcr" data-act="link-dcr">Link DCR</button>'
        : '';
      // Phase 2A.2 — Remove button is available on rows that have an
      // assignment_id and aren't already admin-removed. Admin can stack
      // it with Review when both apply.
      // Phase 2A.4 — relabeled "Remove…" → "Archive" (same write path).
      // Phase 2A.2 regression note — if a session lacks assignment_id
      // (historical or legacy doc), Archive can't write because the
      // batch needs to load service_assignments/{id}. Log to console so
      // admin can spot it in DevTools, and render a small hint in the
      // action cell instead of a blank.
      if (!s.assignment_id) {
        try { console.warn("[labor-review] session has no assignment_id — Archive disabled for this row", { id: s._id }); } catch (_e) {}
      }
      const archiveBtn = (s.assignment_id && s.admin_removed !== true && payrollState(s) !== "exported")
        ? '<button type="button" class="labor-btn labor-btn-remove" data-act="remove-from-ptc">Archive</button>'
        : '';
      // Phase 28A — Approve / Unapprove buttons. Approve visible only
      // when the row passes all payroll gates. Unapprove visible only on
      // approved-but-not-yet-exported rows. Both are single-click writes;
      // bulk Approve has its own modal-confirmed path above the table.
      const approveBtn = approveGatePasses(s)
        ? '<button type="button" class="labor-btn labor-btn-approve" data-act="approve-session" title="Mark approved for payroll">Approve</button>'
        : '';
      const unapproveBtn = unapproveGatePasses(s)
        ? '<button type="button" class="labor-btn labor-btn-unapprove" data-act="unapprove-session" title="Revert approval (only allowed before export)">Unapprove</button>'
        : '';
      const actionCellContent = (reviewBtn + linkDcrBtn + approveBtn + unapproveBtn + archiveBtn) ||
        (s.assignment_id
          ? '<span class="lr-no-actions">—</span>'
          : '<span class="lr-no-actions" title="Session has no assignment_id — cannot archive">no asgn id</span>');
      const reviewedMeta = (s.reviewed_by && s.reviewed_at)
        ? '<div class="lr-reviewed-meta">Reviewed ' + escapeHtml(fmtDateTime(s.reviewed_at)) +
            ' by ' + escapeHtml(s.reviewed_by.displayName || s.reviewed_by.email || "admin") +
          '</div>'
        : '';
      const forceClosedMeta = (s.force_closed_by_admin && s.force_closed_by)
        ? '<div class="lr-forceclosed-meta">Force-closed by ' +
            escapeHtml(s.force_closed_by.displayName || s.force_closed_by.email || "admin") +
            (s.force_close_reason ? ' — ' + escapeHtml(s.force_close_reason) : '') +
          '</div>'
        : '';
      const removedMeta = removedMetaLine(s);
      const summary = techName(s.staff_email, s.staff_uid) + " · " + customerLabel(s, assignment);
      return (
        '<div class="labor-row" data-session-id="' + escapeHtml(s._id) + '"' +
            ' data-assignment-id="' + escapeHtml(s.assignment_id || "") + '"' +
            ' data-summary="' + escapeHtml(summary) + '">' +
          '<div class="lr-col-date"' +
              (s.workweek_label ? ' title="' + escapeHtml("Workweek: " + s.workweek_label) + '"' : '') +
              '>' + escapeHtml(fmtServiceDate(s.service_date)) + '</div>' +
          '<div class="lr-col-emp">' + escapeHtml(techName(s.staff_email, s.staff_uid)) + '</div>' +
          '<div class="lr-col-cust">' + escapeHtml(customerLabel(s, assignment)) + '</div>' +
          '<div class="lr-col-status">' + sessionStatusDisplay(s) + '</div>' +
          '<div class="lr-col-in">' + escapeHtml(fmtTime(s.clock_in_at)) + '</div>' +
          '<div class="lr-col-out">' + escapeHtml(fmtTime(s.clock_out_at)) + '</div>' +
          '<div class="lr-col-wkd' + workedClass + '">' + workedHtml + '</div>' +
          '<div class="lr-col-bgt">' + escapeHtml(fmtMinutes(budget)) + '</div>' +
          '<div class="lr-col-geo">' + geoChip(s.clock_in_geo_status) +
              ' / ' + geoChip(s.clock_out_geo_status) + '</div>' +
          '<div class="lr-col-dcr">' + dcrChip(s) + '</div>' +
          '<div class="lr-col-act">' + actionCellContent + '</div>' +
          (reviewedMeta || forceClosedMeta || removedMeta
            ? '<div class="lr-row-meta">' + reviewedMeta + forceClosedMeta + removedMeta + '</div>'
            : '') +
        '</div>'
      );
    }).join("");
    wrap.innerHTML = headerHtml + rowsHtml;
  }

  /* ---------- writers ---------- */

  function currentActor() {
    const u = firebase.auth().currentUser;
    return u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
  }

  async function markReviewed(sessionId) {
    const actor = currentActor();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    // Phase 28A — Mark Reviewed now ALSO bumps payroll_state from
    // pending_review → reviewed. If the session is already reviewed/
    // approved/exported, we don't downgrade — only clear needs_review +
    // stamp the reviewer fields.
    const sess = sessions.find(function (s) { return s._id === sessionId; });
    const currentState = payrollState(sess);
    const patch = {
      needs_review: false,
      reviewed_at:  sts,
      reviewed_by:  actor
    };
    if (currentState === "pending_review") {
      patch.payroll_state             = "reviewed";
      patch.payroll_state_changed_at  = sts;
      patch.payroll_state_changed_by  = actor;
    }
    await firebase.firestore().collection("pioneer_service_sessions").doc(sessionId).update(patch);
  }

  /* ---------- Phase 28A → 28B: approval writers with OT recompute ----------
   *
   * Each approve / unapprove triggers a workweek-scoped recompute that:
   *   1. Queries every existing approved_for_payroll + exported session
   *      for that (staff_uid, workweek_id) bucket from Firestore.
   *   2. Adds/removes the target session in the bucket per action.
   *   3. Refuses if any bucket member is "exported" — admin must Void
   *      the export first (Phase 28D).
   *   4. Sorts chronologically by clock_in_at.
   *   5. Allocates regular/overtime via allocateOvertime().
   *   6. Batch-writes the state change AND the new split to every
   *      affected session atomically.
   *
   * The query requires the (staff_uid, workweek_id) composite index
   * deployed earlier in Phase 28B. If the index is still building, the
   * write throws FAILED_PRECONDITION — caller surfaces a friendly error.
   */

  // Load workweek bucket. Returns sessions sorted chronologically with
  // _ref (DocumentReference) attached for batch writes.
  async function loadWorkweekBucket(staff_uid, workweek_id) {
    const db = firebase.firestore();
    const snap = await db.collection("pioneer_service_sessions")
      .where("staff_uid",   "==", staff_uid)
      .where("workweek_id", "==", workweek_id)
      .get();
    return snap.docs
      .map(function (d) {
        return Object.assign({ _id: d.id, _ref: d.ref }, d.data() || {});
      })
      .filter(function (s) {
        if (s.admin_removed === true) return false;
        const ps = s.payroll_state || "pending_review";
        return ps === "approved_for_payroll" || ps === "exported";
      });
  }
  function sortByClockInAsc(bucket) {
    bucket.sort(function (a, b) {
      const aMs = tsToMs(a.clock_in_at);
      const bMs = tsToMs(b.clock_in_at);
      if (aMs !== bMs) return aMs - bMs;
      return String(a._id).localeCompare(String(b._id));
    });
  }
  function bucketContainsLockedExport(bucket) {
    return (bucket || []).some(function (s) { return s.payroll_state === "exported"; });
  }
  function lockedExportError(workweekId) {
    return new Error(
      "Workweek " + workweekId + " contains exported sessions. " +
      "Void the export first, then retry."
    );
  }

  async function approveSession(sessionId) {
    const sess = sessions.find(function (s) { return s._id === sessionId; });
    if (!sess) throw new Error("Session not in current view — refresh and retry.");
    if (!sess.service_date) throw new Error("Session has no service_date — cannot determine workweek.");
    if (!sess.staff_uid) throw new Error("Session has no staff_uid.");
    const wid = computeWorkweekId(sess.service_date);
    if (!wid) throw new Error("Could not compute workweek_id from service_date.");
    const actor = currentActor();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const db = firebase.firestore();

    const existing = await loadWorkweekBucket(sess.staff_uid, wid);
    if (bucketContainsLockedExport(existing)) throw lockedExportError(wid);

    // Build the target's synthetic representation as approved.
    const targetRef = db.collection("pioneer_service_sessions").doc(sessionId);
    const targetEntry = Object.assign({}, sess, {
      _id: sessionId,
      _ref: targetRef,
      payroll_state: "approved_for_payroll"
    });
    // Bucket = existing (minus target if it's there) + target.
    const bucket = existing
      .filter(function (s) { return s._id !== sessionId; })
      .concat([targetEntry]);
    sortByClockInAsc(bucket);

    allocateOvertime(bucket);
    const wlabel = computeWorkweekLabel(wid);

    const batch = db.batch();
    bucket.forEach(function (s) {
      const update = {
        workweek_id:          wid,
        workweek_label:       wlabel,
        regular_minutes:      s.regular_minutes,
        overtime_minutes:     s.overtime_minutes,
        payable_work_minutes: s.payable_work_minutes,
        overtime_computed_at: sts,
        overtime_computed_by: actor
      };
      if (s._id === sessionId) {
        update.payroll_state            = "approved_for_payroll";
        update.payroll_state_changed_at = sts;
        update.payroll_state_changed_by = actor;
        update.approved_for_payroll_by  = actor;
        update.approved_for_payroll_at  = sts;
      }
      batch.update(s._ref, update);
    });
    await batch.commit();
  }

  async function unapproveSession(sessionId) {
    const sess = sessions.find(function (s) { return s._id === sessionId; });
    if (!sess) throw new Error("Session not in current view — refresh and retry.");
    const wid = sess.workweek_id || computeWorkweekId(sess.service_date);
    if (!wid) throw new Error("Could not determine workweek_id.");
    const actor = currentActor();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const db = firebase.firestore();

    const existing = await loadWorkweekBucket(sess.staff_uid, wid);
    if (bucketContainsLockedExport(existing)) throw lockedExportError(wid);

    // Remove target from the bucket for the recompute. Target's own row
    // gets the cleared fields written in the same batch.
    const targetRef = db.collection("pioneer_service_sessions").doc(sessionId);
    const bucket = existing.filter(function (s) { return s._id !== sessionId; });
    sortByClockInAsc(bucket);
    allocateOvertime(bucket);

    const batch = db.batch();
    bucket.forEach(function (s) {
      batch.update(s._ref, {
        regular_minutes:      s.regular_minutes,
        overtime_minutes:     s.overtime_minutes,
        payable_work_minutes: s.payable_work_minutes,
        overtime_computed_at: sts,
        overtime_computed_by: actor
      });
    });
    // Target: clear approval fields + split. State flips to reviewed.
    batch.update(targetRef, {
      payroll_state:            "reviewed",
      payroll_state_changed_at: sts,
      payroll_state_changed_by: actor,
      approved_for_payroll_by:  firebase.firestore.FieldValue.delete(),
      approved_for_payroll_at:  firebase.firestore.FieldValue.delete(),
      regular_minutes:          firebase.firestore.FieldValue.delete(),
      overtime_minutes:         firebase.firestore.FieldValue.delete(),
      payable_work_minutes:     firebase.firestore.FieldValue.delete(),
      overtime_computed_at:     firebase.firestore.FieldValue.delete(),
      overtime_computed_by:     firebase.firestore.FieldValue.delete()
    });
    await batch.commit();
  }

  // Bulk Approve — caps at 50 sessions per click per Phase 28A decision.
  // Phase 28B: groups targets by (staff_uid, workweek_id) so each
  // workweek is recomputed exactly once. Per-bucket batches commit
  // sequentially — first locked-export bucket throws and remaining
  // buckets are not processed.
  async function bulkApproveSessions(sessionIds) {
    const actor = currentActor();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const db = firebase.firestore();

    // Group targets.
    const byBucket = new Map();
    sessionIds.forEach(function (sid) {
      const s = sessions.find(function (x) { return x._id === sid; });
      if (!s || !s.service_date || !s.staff_uid) return;
      const wid = computeWorkweekId(s.service_date);
      if (!wid) return;
      const key = s.staff_uid + "|" + wid;
      if (!byBucket.has(key)) {
        byBucket.set(key, { staff_uid: s.staff_uid, workweek_id: wid, targets: [] });
      }
      byBucket.get(key).targets.push(s);
    });

    let approvedCount = 0;
    for (const [, group] of byBucket) {
      const existing = await loadWorkweekBucket(group.staff_uid, group.workweek_id);
      if (bucketContainsLockedExport(existing)) throw lockedExportError(group.workweek_id);

      const targetIdSet = new Set(group.targets.map(function (t) { return t._id; }));
      const targetEntries = group.targets.map(function (t) {
        return Object.assign({}, t, {
          _ref: db.collection("pioneer_service_sessions").doc(t._id),
          payroll_state: "approved_for_payroll"
        });
      });
      const bucket = existing
        .filter(function (s) { return !targetIdSet.has(s._id); })
        .concat(targetEntries);
      sortByClockInAsc(bucket);
      allocateOvertime(bucket);
      const wlabel = computeWorkweekLabel(group.workweek_id);

      const batch = db.batch();
      bucket.forEach(function (s) {
        const update = {
          workweek_id:          group.workweek_id,
          workweek_label:       wlabel,
          regular_minutes:      s.regular_minutes,
          overtime_minutes:     s.overtime_minutes,
          payable_work_minutes: s.payable_work_minutes,
          overtime_computed_at: sts,
          overtime_computed_by: actor
        };
        if (targetIdSet.has(s._id)) {
          update.payroll_state            = "approved_for_payroll";
          update.payroll_state_changed_at = sts;
          update.payroll_state_changed_by = actor;
          update.approved_for_payroll_by  = actor;
          update.approved_for_payroll_at  = sts;
        }
        batch.update(s._ref, update);
      });
      await batch.commit();
      approvedCount += group.targets.length;
    }
    return approvedCount;
  }
  const BULK_APPROVE_CAP = 50;
  function approvableInCurrentView() {
    return (displaySessions || []).filter(approveGatePasses);
  }

  // Path A force-close: transactional update of session + delete of the
  // active-singleton. No time_punches write. Audit metadata lives on the
  // session doc.
  async function forceCloseSession(opts) {
    const sessionId  = opts.sessionId;
    const activeUid  = opts.activeUid;
    const clockOutAt = opts.clockOutAt;  // Firestore Timestamp OR null → serverTimestamp
    const reason     = opts.reason;
    const actor      = currentActor();
    const db         = firebase.firestore();

    await db.runTransaction(async function (tx) {
      const sessRef = db.collection("pioneer_service_sessions").doc(sessionId);
      const sessSnap = await tx.get(sessRef);
      if (!sessSnap.exists) throw new Error("Session no longer exists");
      const sess = sessSnap.data() || {};

      // Phase 28D gate hardening — refuse force-close on exported sessions.
      // Once a session is in a CSV export it must be voided before any
      // mutation; otherwise the audit chain breaks.
      if (sess.payroll_state === "exported") {
        throw new Error(
          "Cannot force-close an exported session. " +
          "Void the payroll export in Payroll → Recent Exports first."
        );
      }

      const clockInMs = tsToMs(sess.clock_in_at);
      const outMs     = tsToMs(clockOutAt) || Date.now();
      const workMin   = clockInMs ? Math.max(0, Math.round((outMs - clockInMs) / 60000)) : null;

      const patch = {
        status:                  "completed",
        clock_out_at:            clockOutAt || firebase.firestore.FieldValue.serverTimestamp(),
        work_minutes:            workMin,
        force_closed_by_admin:   true,
        force_close_reason:      reason,
        force_closed_by:         actor,
        force_closed_at:         firebase.firestore.FieldValue.serverTimestamp(),
        needs_review:            true
      };
      tx.update(sessRef, patch);

      if (activeUid) {
        const activeRef = db.collection("active_service_sessions").doc(activeUid);
        tx.delete(activeRef);
      }
    });
  }

  /* ---------- modal ---------- */

  function openForceCloseModal(sessionId, activeUid) {
    const modal = $("labor-force-close-modal");
    if (!modal) return;
    const sess = sessions.find(function (s) { return s._id === sessionId; }) || activeByUid[activeUid] || {};
    const tech = techName(sess.staff_email, sess.staff_uid || activeUid);
    const assignment = sess.assignment_id ? assignmentsById[sess.assignment_id] : null;
    const cust = customerLabel(sess, assignment);

    const sidEl = $("labor-fc-session-id");   if (sidEl) sidEl.value = sessionId || "";
    const uidEl = $("labor-fc-active-uid");   if (uidEl) uidEl.value = activeUid || "";
    const sumEl = $("labor-fc-summary");
    if (sumEl) sumEl.textContent = tech + " · " + cust + " · clocked in " + fmtDateTime(sess.clock_in_at);

    const tEl = $("labor-fc-clock-out-time");
    if (tEl) {
      // Default to "now" rendered as a local datetime-local string.
      const d = new Date();
      const pad = function (n) { return String(n).padStart(2, "0"); };
      tEl.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
                  "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    const rEl = $("labor-fc-reason");  if (rEl) rEl.value = "";
    const eEl = $("labor-fc-err");     if (eEl) { eEl.textContent = ""; eEl.hidden = true; }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeForceCloseModal() {
    const modal = $("labor-force-close-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function submitForceClose() {
    const sessionId = ($("labor-fc-session-id") && $("labor-fc-session-id").value) || "";
    const activeUid = ($("labor-fc-active-uid") && $("labor-fc-active-uid").value) || "";
    const reason    = (($("labor-fc-reason") && $("labor-fc-reason").value) || "").trim();
    const timeStr   = ($("labor-fc-clock-out-time") && $("labor-fc-clock-out-time").value) || "";
    const errEl     = $("labor-fc-err");
    const saveBtn   = $("labor-fc-save");

    function showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    }

    if (!sessionId) { showErr("Missing session id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }

    let clockOutAt = null;
    if (timeStr) {
      const ms = Date.parse(timeStr);
      if (isNaN(ms)) { showErr("Invalid clock-out time."); return; }
      if (ms > Date.now() + 60000) { showErr("Clock-out time can't be in the future."); return; }
      clockOutAt = firebase.firestore.Timestamp.fromMillis(ms);
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
      await forceCloseSession({
        sessionId:  sessionId,
        activeUid:  activeUid || null,
        clockOutAt: clockOutAt,
        reason:     reason
      });
      closeForceCloseModal();
      refresh();
    } catch (err) {
      console.error("[labor-review] force close failed", err);
      showErr((err && (err.message || err.code)) || "Force-close failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- Phase 2A.2: Remove assignment from PTC ----------
   *
   * Reads service_assignments/{id}, blocks if an active_service_session
   * points at this assignment (force-close first per spec), then in one
   * batch:
   *   • service_assignments/{id}.update({ status: "admin_removed",
   *       removed_from_ptc: true, removed_reason, removed_by, removed_at })
   *   • for each pioneer_service_sessions where assignment_id == id:
   *       .update({ admin_removed: true, removed_reason, removed_by,
   *                 removed_at, needs_review: true })
   *
   * NEVER deletes any doc. Audit trail preserved. /work hides assignments
   * whose status === "admin_removed" OR removed_from_ptc === true
   * (service-clock.js filter, Phase 2A.2).
   */
  async function removeAssignmentFromPtc(opts) {
    const assignmentId = opts.assignmentId;
    const reason       = opts.reason;
    const actor        = currentActor();
    const db           = firebase.firestore();
    const sts          = firebase.firestore.FieldValue.serverTimestamp();

    if (!assignmentId) throw new Error("Missing assignment id.");

    // Phase 28D gate hardening — refuse to archive if any related
    // session is already exported. Admin must Void the export first to
    // unlock the audit chain.
    const lockedSnap = await db.collection("pioneer_service_sessions")
      .where("assignment_id", "==", assignmentId)
      .where("payroll_state", "==", "exported")
      .limit(1)
      .get();
    if (!lockedSnap.empty) {
      throw new Error(
        "Cannot archive — one or more related sessions are already exported (payroll_state=\"exported\"). " +
        "Void the export in Payroll → Recent Exports first, then retry."
      );
    }

    const assignRef  = db.collection("service_assignments").doc(assignmentId);
    const assignSnap = await assignRef.get();
    if (!assignSnap.exists) throw new Error("Assignment not found: " + assignmentId);
    const assignData = assignSnap.data() || {};
    const staffUid   = assignData.staff_uid || "";

    // Block if the assigned tech is actively clocked into this assignment.
    if (staffUid) {
      const activeSnap = await db.collection("active_service_sessions")
        .doc(staffUid).get();
      if (activeSnap.exists) {
        const active = activeSnap.data() || {};
        if (active.assignment_id === assignmentId) {
          throw new Error(
            "Tech is currently clocked into this assignment. " +
            "Use Force close in the Open Active Sessions block first, then Remove."
          );
        }
      }
    }

    // Fetch every pioneer_service_sessions doc that points at this
    // assignment. Each gets the admin_removed audit fields. Sessions
    // are NOT deleted; work_minutes / clock-in / clock-out preserved.
    const sessionsSnap = await db.collection("pioneer_service_sessions")
      .where("assignment_id", "==", assignmentId)
      .get();

    const batch = db.batch();
    batch.update(assignRef, {
      status:           "admin_removed",
      removed_from_ptc: true,
      removed_reason:   reason,
      removed_by:       actor,
      removed_at:       sts,
      updated_at:       sts,
      updated_by:       actor
    });
    sessionsSnap.docs.forEach(function (d) {
      batch.update(d.ref, {
        admin_removed: true,
        removed_reason: reason,
        removed_by:    actor,
        removed_at:    sts,
        needs_review:  true
      });
    });
    await batch.commit();
    return { affected_sessions: sessionsSnap.size };
  }

  function openRemoveModal(assignmentId, summary) {
    const modal = $("labor-remove-modal");
    if (!modal) return;
    const idEl = $("labor-rm-assignment-id"); if (idEl) idEl.value = assignmentId || "";
    const sEl  = $("labor-rm-summary");       if (sEl)  sEl.textContent = summary || "—";
    const rEl  = $("labor-rm-reason");        if (rEl)  rEl.value = "";
    const eEl  = $("labor-rm-err");           if (eEl)  { eEl.textContent = ""; eEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setTimeout(function () { const r = $("labor-rm-reason"); if (r) r.focus(); }, 60);
  }

  // Phase 2A.4 — Link DCR placeholder. Real wire-up ships in Phase 2B
  // (admin pastes a DCR submission id + reason; batch writes
  // pioneer_service_sessions.{dcr_id, dcr_status, dcr_linked_by, …}).
  // This phase only renders the affordance + an explainer modal so admin
  // sees the button is coming without thinking it's broken.
  function openLinkDcrModal(summary) {
    const modal = $("labor-linkdcr-modal");
    if (!modal) return;
    const sEl = $("labor-linkdcr-summary");
    if (sEl) sEl.textContent = summary || "—";
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeLinkDcrModal() {
    const modal = $("labor-linkdcr-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeLinkDcrModal; // closed via [data-modal-close] from the shell

  /* ---------- Phase 28A: Bulk Approve modal ---------- */

  function openBulkApproveModal() {
    const modal = $("labor-bulk-approve-modal");
    if (!modal) return;
    const ready = approvableInCurrentView();
    const willApprove = Math.min(ready.length, BULK_APPROVE_CAP);
    const capped = (ready.length > BULK_APPROVE_CAP);
    const sumEl = $("labor-bulk-summary");
    if (sumEl) {
      sumEl.innerHTML =
        '<strong>' + willApprove + '</strong> session' + (willApprove === 1 ? "" : "s") +
        ' will be approved for payroll.' +
        (capped
          ? ' <span class="labor-bulk-cap">' + (ready.length - willApprove) +
            ' more remain — click again after refresh to handle them.</span>'
          : '');
    }
    const saveBtn = $("labor-bulk-save");
    if (saveBtn) {
      saveBtn.textContent = "Approve " + willApprove + " session" + (willApprove === 1 ? "" : "s");
      saveBtn.disabled = (willApprove === 0);
    }
    const errEl = $("labor-bulk-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeBulkApproveModal() {
    const modal = $("labor-bulk-approve-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeBulkApproveModal; // closed via [data-modal-close] from the shell

  async function submitBulkApprove() {
    const errEl   = $("labor-bulk-err");
    const saveBtn = $("labor-bulk-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }
    const ready = approvableInCurrentView();
    if (!ready.length) { showErr("No approvable sessions in this view."); return; }
    const slice = ready.slice(0, BULK_APPROVE_CAP);
    const ids = slice.map(function (s) { return s._id; });
    if (saveBtn) saveBtn.disabled = true;
    try {
      await bulkApproveSessions(ids);
      try { console.info("[labor-review] bulk approved", { count: ids.length }); } catch (_e) {}
      closeBulkApproveModal();
      refresh();
    } catch (err) {
      console.error("[labor-review] bulk approve failed", err);
      showErr((err && (err.message || err.code)) || "Bulk approve failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function closeRemoveModal() {
    const modal = $("labor-remove-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function submitRemove() {
    const assignmentId = ($("labor-rm-assignment-id") && $("labor-rm-assignment-id").value) || "";
    const reason       = (($("labor-rm-reason") && $("labor-rm-reason").value) || "").trim();
    const errEl        = $("labor-rm-err");
    const saveBtn      = $("labor-rm-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    if (!assignmentId) { showErr("Missing assignment id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }

    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await removeAssignmentFromPtc({ assignmentId: assignmentId, reason: reason });
      closeRemoveModal();
      refresh();
      try {
        console.info("[labor-review] removed assignment from PTC", {
          assignment_id: assignmentId, affected_sessions: r.affected_sessions
        });
      } catch (_e) {}
    } catch (err) {
      console.error("[labor-review] remove failed", err);
      showErr((err && (err.message || err.code)) || "Remove failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- wire-up ---------- */

  function wire() {
    const refreshBtn = $("labor-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    // Delegated clicks for both blocks.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest('.labor-btn[data-act]');
      if (!btn) return;

      // Force close
      if (btn.dataset.act === "force-close") {
        const card = btn.closest("[data-active-uid]");
        if (!card) return;
        openForceCloseModal(card.dataset.sessionId || null, card.dataset.activeUid);
        return;
      }
      // Mark reviewed
      if (btn.dataset.act === "mark-reviewed") {
        const row = btn.closest("[data-session-id]");
        if (!row) return;
        const sid = row.dataset.sessionId;
        btn.disabled = true;
        markReviewed(sid)
          .then(refresh)
          .catch(function (err) {
            console.error("[labor-review] mark reviewed failed", err);
            alert((err && (err.message || err.code)) || "Mark reviewed failed.");
            btn.disabled = false;
          });
        return;
      }
      // Phase 2A.2 — Archive Assignment (was "Remove from PTC" in 2A.2).
      // Same data-act keeps the existing batch writer unchanged.
      if (btn.dataset.act === "remove-from-ptc") {
        const row = btn.closest("[data-assignment-id]");
        if (!row) return;
        const aid = row.dataset.assignmentId;
        if (!aid) {
          alert("This row has no assignment_id — cannot archive. (Older session docs may lack the field; refresh and try again.)");
          return;
        }
        const summary = row.dataset.summary || "";
        openRemoveModal(aid, summary);
        return;
      }
      // Phase 2A.4 — Link DCR placeholder. Opens an info modal explaining
      // the feature ships in Phase 2B. No write path.
      if (btn.dataset.act === "link-dcr") {
        const row = btn.closest("[data-session-id]");
        if (!row) return;
        const summary = (row.dataset.summary) || "";
        openLinkDcrModal(summary);
        return;
      }
      // Phase 28A — Approve / Unapprove. Single-click writes; admin can
      // immediately revert via Unapprove if mis-clicked. No modal.
      if (btn.dataset.act === "approve-session") {
        const row = btn.closest("[data-session-id]");
        if (!row) return;
        const sid = row.dataset.sessionId;
        btn.disabled = true;
        approveSession(sid).then(refresh).catch(function (err) {
          console.error("[labor-review] approve failed", err);
          alert((err && (err.message || err.code)) || "Approve failed.");
          btn.disabled = false;
        });
        return;
      }
      if (btn.dataset.act === "unapprove-session") {
        const row = btn.closest("[data-session-id]");
        if (!row) return;
        const sid = row.dataset.sessionId;
        btn.disabled = true;
        unapproveSession(sid).then(refresh).catch(function (err) {
          console.error("[labor-review] unapprove failed", err);
          alert((err && (err.message || err.code)) || "Unapprove failed.");
          btn.disabled = false;
        });
        return;
      }
    });

    // Phase 28A — Bulk Approve open button is rendered into
    // #labor-bulk-bar by renderBulkApproveBar; the bar's contents are
    // regenerated each render so a direct addEventListener on the
    // button would be lost. Use a delegated click on the wrap instead.
    const bulkBar = $("labor-bulk-bar");
    if (bulkBar) bulkBar.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest("#labor-bulk-open");
      if (!btn) return;
      openBulkApproveModal();
    });
    const bulkSave = $("labor-bulk-save");
    if (bulkSave) bulkSave.addEventListener("click", function () { submitBulkApprove(); });

    // Force-close modal save + cancel (X / backdrop / Cancel use [data-modal-close]
    // which the shell wires globally).
    const fcSaveBtn = $("labor-fc-save");
    if (fcSaveBtn) fcSaveBtn.addEventListener("click", function () { submitForceClose(); });
    // Remove modal save (Phase 2A.2).
    const rmSaveBtn = $("labor-rm-save");
    if (rmSaveBtn) rmSaveBtn.addEventListener("click", function () { submitRemove(); });

    // Phase 2A.3 — Range controls.
    document.querySelectorAll("[data-labor-quick]").forEach(function (b) {
      b.addEventListener("click", function () {
        const key = b.getAttribute("data-labor-quick");
        if (!key) return;
        const today = pacificDateString(new Date());
        const r = getQuickFilterRange(key, today);
        rangeStart = r.start_date;
        rangeEnd   = r.end_date;
        currentQuickFilter = key;
        // Phase 29B — using a date quick button clears the pay-period
        // chip (different way of selecting a range).
        currentPayPeriodId = "";
        const startEl = $("labor-range-start"); if (startEl) startEl.value = rangeStart;
        const endEl   = $("labor-range-end");   if (endEl)   endEl.value   = rangeEnd;
        saveFilterState();
        refresh();
      });
    });
    // Phase 2A.4 — Status filter chips. Pure client-side filter; no
    // Firestore round trip. Totals + By Employee + Sessions table all
    // recompute from the filtered subset.
    document.querySelectorAll("[data-labor-status]").forEach(function (b) {
      b.addEventListener("click", function () {
        const key = b.getAttribute("data-labor-status");
        if (!key) return;
        currentStatusFilter = key;
        saveFilterState();
        if (loaded) {
          recomputeDisplay();
          render();
        }
      });
    });

    // Phase 29B — Pay-period dropdown. Selecting a period overrides the
    // date range and re-fetches Firestore. Selecting the "" sentinel
    // simply clears the pay-period chip without touching the range
    // (admin can keep using the date quick buttons).
    const periodSel = $("labor-pay-period-select");
    if (periodSel) periodSel.addEventListener("change", function () {
      const val = periodSel.value || "";
      currentPayPeriodId = val;
      if (val) {
        const p = (payPeriodOptions || []).find(function (x) { return x.period_id === val; });
        if (p) {
          rangeStart = p.start_date;
          rangeEnd   = p.end_date;
          currentQuickFilter = "custom";   // none of the quick buttons matches a semi-monthly period
          saveFilterState();
          refresh();
          return;
        }
      }
      // "" sentinel — clear pay-period chip; don't reload.
      saveFilterState();
      if (loaded) { recomputeDisplay(); render(); }
    });

    // Phase 29B — Employee dropdown. Pure client-side filter; no
    // Firestore round trip. Sessions table + totals scope to the
    // selection; By Employee cards stay full so admin can switch.
    const empSel = $("labor-employee-select");
    if (empSel) empSel.addEventListener("change", function () {
      currentEmployeeFilter = empSel.value || "";
      saveFilterState();
      if (loaded) { recomputeDisplay(); render(); }
    });

    // Phase 29B — Search input. Debounced 150ms so each keystroke
    // doesn't re-render the table. Pure substring match; no fetch.
    const searchEl = $("labor-search-input");
    if (searchEl) {
      let searchTimer = null;
      searchEl.addEventListener("input", function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          currentSearchTerm = searchEl.value || "";
          saveFilterState();
          if (loaded) { recomputeDisplay(); render(); }
        }, 150);
      });
    }

    // Phase 29B — Active-filter chip strip × clicks. data-clear says
    // which filter to drop. "all" clears every non-date filter.
    const chipWrap = $("labor-active-filters");
    if (chipWrap) chipWrap.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest("[data-clear]");
      if (!btn) return;
      const which = btn.getAttribute("data-clear");
      if (which === "status")    currentStatusFilter = "all";
      if (which === "employee")  currentEmployeeFilter = "";
      if (which === "search")    currentSearchTerm = "";
      if (which === "payperiod") currentPayPeriodId = "";
      if (which === "all") {
        currentStatusFilter   = "all";
        currentEmployeeFilter = "";
        currentSearchTerm     = "";
        currentPayPeriodId    = "";
      }
      saveFilterState();
      if (loaded) { recomputeDisplay(); render(); }
    });

    // Phase 29B — By Employee card click toggles the employee filter.
    // Click on the selected card again to clear. Keyboard support via
    // Enter / Space on the role="button" element.
    const byEmpWrap = $("labor-by-employee-list");
    function handleCardActivate(card) {
      const key = card.getAttribute("data-employee-key");
      if (!key) return;
      currentEmployeeFilter = (currentEmployeeFilter === key) ? "" : key;
      saveFilterState();
      if (loaded) { recomputeDisplay(); render(); }
    }
    if (byEmpWrap) {
      byEmpWrap.addEventListener("click", function (ev) {
        const card = ev.target.closest && ev.target.closest("[data-employee-key]");
        if (!card) return;
        handleCardActivate(card);
      });
      byEmpWrap.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const card = ev.target.closest && ev.target.closest("[data-employee-key]");
        if (!card) return;
        ev.preventDefault();
        handleCardActivate(card);
      });
    }
    const applyBtn = $("labor-range-apply");
    if (applyBtn) applyBtn.addEventListener("click", function () {
      const startEl = $("labor-range-start");
      const endEl   = $("labor-range-end");
      const start = (startEl && startEl.value) || "";
      const end   = (endEl && endEl.value) || "";
      const err = validateRange(start, end);
      const errEl = $("labor-range-err");
      if (err) {
        if (errEl) { errEl.textContent = err; errEl.hidden = false; }
        return;
      }
      if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
      rangeStart = start;
      rangeEnd   = end;
      // If the typed range happens to match a known quick filter, light
      // it up; otherwise mark as "custom" so no button is highlighted.
      const today = pacificDateString(new Date());
      const candidates = ["today", "yesterday", "last_7", "last_30", "pay_period"];
      let matched = null;
      for (let i = 0; i < candidates.length; i++) {
        const cand = getQuickFilterRange(candidates[i], today);
        if (cand.start_date === start && cand.end_date === end) { matched = candidates[i]; break; }
      }
      currentQuickFilter = matched || "custom";
      // Phase 29B — manual date range overrides any pay-period chip.
      currentPayPeriodId = "";
      saveFilterState();
      refresh();
    });
  }

  /* ---------- export surface ---------- */

  function init() {
    wire();
  }

  // Phase 28C — external deep-link entry point. Called by tab-payroll.js
  // when admin clicks "Open in Labor" on a blocker line. Sets range +
  // status filter in one shot and runs refresh. Quick-filter chip
  // highlight is set to "custom" since the inbound range may not match
  // any known preset.
  function applyExternalFilter(opts) {
    opts = opts || {};
    if (opts.rangeStart) rangeStart = opts.rangeStart;
    if (opts.rangeEnd)   rangeEnd   = opts.rangeEnd;
    if (opts.rangeStart || opts.rangeEnd) currentQuickFilter = "custom";
    if (opts.statusFilter) currentStatusFilter = opts.statusFilter;
    refresh();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.laborReview = {
    init:                init,
    refresh:             refresh,
    applyExternalFilter: applyExternalFilter
  };
}());
