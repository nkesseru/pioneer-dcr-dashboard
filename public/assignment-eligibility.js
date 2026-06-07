/* Pioneer — Assignment Eligibility (single source of truth).
 *
 * One rule, used everywhere. Replaces N inconsistent date filters
 * across service-clock.js, today-work.js, app.js, and any future
 * tech-facing surface. The same module decides whether a service
 * assignment is currently workable for:
 *
 *   • clock-in (Pioneer Time Clock on /work)
 *   • DCR submission (the customer/office list)
 *   • Today's Work or any "what's scheduled now" view
 *
 * Why this exists
 *   A real production incident: Drew tried to clock into DIVCO on
 *   Friday/Saturday for a Sunday job and could not. DIVCO did not
 *   appear in either the clock-in list or the DCR office list.
 *   Investigation found three different date-filter rules across
 *   the codebase; the legacy `isAvailableNow` fallback required
 *   service_date === today even when the flex policy said earlier
 *   work was allowed. This module consolidates every check.
 *
 * Pioneer work-week
 *   Sunday → Thursday (5 working days).
 *   Friday and Saturday are the inter-workweek gap. Friday and
 *   Saturday can be used for Sunday jobs when the assignment is
 *   flex-eligible (the default unless allows_flex_start === false).
 *
 * UMD-style export so the same file runs in the browser AND in a
 * Node test harness without modification.
 */
(function (root) {
  "use strict";

  var TZ = "America/Los_Angeles";

  /* ---------- Pacific date helpers ---------- */

  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year:  "numeric",
      month: "2-digit",
      day:   "2-digit"
    }).format(d || new Date());
  }

  function pacificWeekday(yyyymmdd) {
    if (!yyyymmdd) return null;
    // Anchor at noon UTC to dodge DST boundaries and timezone slippage.
    var dt = new Date(yyyymmdd + "T12:00:00Z");
    if (isNaN(dt.getTime())) return null;
    return dt.getUTCDay();   // 0=Sun ... 6=Sat (matches Pacific weekday for noon UTC)
  }

  function addDaysPacific(yyyymmdd, n) {
    var dt = new Date(yyyymmdd + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + n);
    return pacificDateString(dt);
  }

  /* ---------- Workweek window math ----------
   *
   * The Sunday that anchors the workweek containing a given date.
   *   For Sun-Thu service dates (weekdays 0-4): the prior Sunday OR
   *   today if it IS Sunday.
   *   For Fri/Sat service dates (weekdays 5-6): the NEXT Sunday,
   *   because Fri/Sat aren't part of the workweek — a Fri/Sat
   *   service_date would be unusual and is treated as the start of
   *   the following workweek.
   */
  function workweekSundayFor(yyyymmdd) {
    var dow = pacificWeekday(yyyymmdd);
    if (dow == null) return null;
    if (dow >= 0 && dow <= 4) return addDaysPacific(yyyymmdd, -dow);
    return addDaysPacific(yyyymmdd, 7 - dow);   // Fri/Sat → upcoming Sun
  }

  /* The workable window for an assignment's service_date:
   *   • Start: Friday before the workweek's Sunday (Sunday − 2 days).
   *   • End:   Thursday of the workweek           (Sunday + 4 days).
   *
   * So for a Sunday service_date, the window covers Fri-Sat-Sun-Mon-
   * Tue-Wed-Thu (7 calendar days). A tech can work Friday or Saturday
   * for the Sunday job (flex / early), Sunday on-time, or Mon-Thu late
   * completion — all in the same workweek frame.
   */
  function workableWindowFor(serviceDate) {
    var sun = workweekSundayFor(serviceDate);
    if (!sun) return null;
    return { start: addDaysPacific(sun, -2), end: addDaysPacific(sun, 4) };
  }

  /* ---------- Helpers ---------- */

  function tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return null;
  }

  function statusString(a) {
    return String((a && a.status) || "").toLowerCase();
  }

  /* ---------- The one rule ----------
   *
   * isWorkableNow(assignment, nowMs, todayPT)
   *
   *   Returns true if `assignment` should be visible/actionable for
   *   the signed-in tech right now. Used by clock-in lists, DCR launch
   *   surfaces, Today's Work, and any future "available shifts" view.
   *
   *   Inputs:
   *     assignment — a service_assignments doc (Firestore shape)
   *     nowMs      — current millis (number, Date, or omitted → Date.now())
   *     todayPT    — Pacific YYYY-MM-DD today (string; omitted → derived)
   *
   *   Resolution order:
   *     1. Terminal statuses (cancelled / removed) → false.
   *     2. Active workflow statuses (in_progress / paused / dcr_pending)
   *        → true. The tech is mid-shift; nothing else matters.
   *     3. Modern docs with both available_from + available_until →
   *        strict window check. This is the explicit-policy path used
   *        by the Deputy bridge with flex_start_policy set.
   *     4. Single-bound partial → honor the bound + workweek window
   *        on the other side.
   *     5. Legacy docs (no bounds) → workweek-aware fallback. If
   *        allows_flex_start === false, strict same-day. Otherwise
   *        the workable window covers Fri before through Thu of the
   *        service_date's workweek.
   */
  function isWorkableNow(assignment, nowMs, todayPT) {
    if (!assignment) return false;

    var s = statusString(assignment);

    // (1) Terminal — never workable.
    if (s === "canceled" || s === "cancelled" ||
        s === "canceled_by_deputy" || s === "admin_removed") return false;
    if (assignment.removed_from_ptc === true) return false;

    // (2) Active workflow — always workable. Covers post-clock-out
    // "dcr_pending" state so the assignment doesn't disappear before
    // the DCR is submitted.
    if (s === "active" || s === "paused" ||
        s === "in_progress" || s === "dcr_pending") return true;

    var ms = (typeof nowMs === "number") ? nowMs
           : (nowMs && nowMs.getTime ? nowMs.getTime() : Date.now());
    var today = todayPT || pacificDateString(new Date(ms));

    var fromMs  = tsToMs(assignment.available_from);
    var untilMs = tsToMs(assignment.available_until);

    // (3) Modern explicit window — the Deputy bridge applies flex
    // policy here and sets BOTH bounds. Trust the bounds.
    if (fromMs != null && untilMs != null) {
      return fromMs <= ms && ms <= untilMs;
    }

    // (4a) Single-bound (only available_from): honor the bound, then
    // fall back to the workweek window for the end side.
    if (fromMs != null && untilMs == null) {
      if (fromMs > ms) return false;
      if (!assignment.service_date) return true;
      var winA = workableWindowFor(assignment.service_date);
      return !!(winA && today >= winA.start && today <= winA.end);
    }

    // (4b) Single-bound (only available_until): honor the bound, then
    // fall back to the workweek window for the start side.
    if (fromMs == null && untilMs != null) {
      if (untilMs < ms) return false;
      if (!assignment.service_date) return true;
      var winB = workableWindowFor(assignment.service_date);
      return !!(winB && today >= winB.start && today <= winB.end);
    }

    // (5) Legacy doc — no explicit window. Workweek-aware fallback.
    if (!assignment.service_date) return false;
    if (assignment.allows_flex_start === false) {
      return assignment.service_date === today;
    }
    var winC = workableWindowFor(assignment.service_date);
    return !!(winC && today >= winC.start && today <= winC.end);
  }

  function workableAssignmentsFor(assignments, nowMs, todayPT) {
    if (!assignments || !assignments.length) return [];
    return assignments.filter(function (a) {
      return isWorkableNow(a, nowMs, todayPT);
    });
  }

  /* ---------- export (UMD) ---------- */

  var api = {
    isWorkableNow:             isWorkableNow,
    workableAssignmentsFor:    workableAssignmentsFor,
    workableWindowFor:         workableWindowFor,
    workweekSundayFor:         workweekSundayFor,
    pacificDateString:         pacificDateString,
    pacificWeekday:            pacificWeekday,
    addDaysPacific:            addDaysPacific,
    WORK_WEEK_DAYS:            ["Sun", "Mon", "Tue", "Wed", "Thu"],
    WORK_WEEK_DOWS:            [0, 1, 2, 3, 4]
  };

  if (typeof module === "object" && module && typeof module.exports === "object") {
    module.exports = api;
  }
  if (root) {
    root.PIONEER_ELIGIBILITY = api;
  }
}(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this)));
