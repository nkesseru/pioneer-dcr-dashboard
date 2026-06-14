/* Pioneer DCR Hub — Service-Assignment Time Clock (Phase 1b).
 *
 * Employee-facing clock-in / clock-out UI for the new
 * service_assignments → pioneer_service_sessions → time_punches model.
 * Renders into #pioneer-time-clock-section in /work.html.
 * Coexists with the legacy Deputy "Today's Work" section beneath it.
 *
 * Reads:
 *   • service_assignments WHERE staff_uid==own AND service_date==today
 *   • active_service_sessions/{own_uid}              (singleton lookup)
 *   • payroll_periods/{current_period_id}            (doc-id read)
 *   • staff_labor_balances/{own_uid}                 (doc-id read)
 *
 * Writes (atomic transactions):
 *   • pioneer_service_sessions  (create on clock-in; update on clock-out)
 *   • active_service_sessions/{own_uid}  (create on clock-in; delete on clock-out)
 *   • time_punches              (one create per clock-in or clock-out)
 *
 * Does NOT write:
 *   • service_assignments       (admin-only per rules; tech reads only)
 *   • staff_labor_balances      (admin-only per rules; tech reads only)
 *
 * UI live-state model:
 *   service_assignments are the planned record. Operational state
 *   (in-progress vs ready vs completed) is DERIVED from
 *   active_service_sessions + pioneer_service_sessions, NEVER from the
 *   assignment's .status field. The assignment's .status field is
 *   admin-managed in Phase 1c.
 *
 * Loaded on /work.html AFTER staff-auth.js + today-work.js.
 */

(function () {
  "use strict";

  // V20260614 — Production marker. The /work route loads
  // service-clock.js (today-work.js is commented out in work.html).
  // The multi-shift build removes the isAvailableNow() filter so every
  // assigned stop for the day is visible regardless of window state.
  try {
    console.log("[PIONEER DEBUG] SERVICE CLOCK MULTI-SHIFT BUILD ACTIVE", {
      file:           "service-clock.js",
      build_marker:   "V20260614-multishift — visibility is day-based, not time-window-based",
      url:            location.href,
      search:         location.search,
      debug_param:    new URLSearchParams(location.search || "").get("debug")
    });
  } catch (_e) {}

  // Module-load breadcrumb so future debug doesn't have to guess whether
  // the script tag fired. Visible in DevTools console immediately on
  // page parse, before any auth resolution.
  try { console.info("[service-clock] script loaded — waiting for firebase.auth onAuthStateChanged"); } catch (_e) {}

  /* ---------- helpers (local; no shared-module deps) ---------- */

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function logSC(msg, meta) {
    try { console.info("[service-clock] " + msg, meta || ""); } catch (_e) {}
  }
  function warnSC(msg, meta) {
    try { console.warn("[service-clock] " + msg, meta || ""); } catch (_e) {}
  }

  // Pacific YYYY-MM-DD for "today" or a given Date.
  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d || new Date());
  }

  // Integer minutes → "Xh Ym" display string. Mirrors admin/_utils.js.
  function formatMinutesAsHm(minutes) {
    const n = Math.round(Number(minutes) || 0);
    const sign = n < 0 ? "-" : "";
    const abs  = Math.abs(n);
    return sign + Math.floor(abs / 60) + "h " + (abs % 60) + "m";
  }

  // Semi-monthly period for a given Pacific YYYY-MM-DD.
  // Mirror of admin/_utils.js + scripts/lib/semi-monthly.js. Small enough
  // to duplicate vs adding a shared browser module + extra script tag.
  function getEndOfMonth(yyyyMmDd) {
    const parts = String(yyyyMmDd).split("-");
    const year  = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return parts[0] + "-" + parts[1] + "-" + String(lastDay).padStart(2, "0");
  }
  function getSemiMonthlyPeriod(yyyyMmDd) {
    const parts = String(yyyyMmDd).split("-");
    const year  = parts[0], month = parts[1];
    const day   = parseInt(parts[2], 10);
    const half  = (day <= 15) ? "A" : "B";
    return {
      period_id: year + "-" + month + "-" + half,
      half:      half,
      month:     year + "-" + month,
      end_date:  (half === "A") ? (year + "-" + month + "-15") : getEndOfMonth(yyyyMmDd)
    };
  }

  // Add `days` to a Pacific YYYY-MM-DD string. Same UTC-noon anchor
  // pattern used elsewhere in the codebase (today-work.js / _utils.js)
  // to avoid DST drift across short windows.
  function addDaysPT(yyyyMmDd, days) {
    const base = new Date(yyyyMmDd + "T12:00:00Z");
    base.setUTCDate(base.getUTCDate() + days);
    return pacificDateString(base);
  }

  // "2026-06-07" → "Sunday, Jun 7" in Pacific. Noon-UTC anchor avoids
  // off-by-one for users in non-Pacific browser zones.
  function formatServiceDateLong(yyyyMmDd) {
    if (!yyyyMmDd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "short", day: "numeric"
      }).format(new Date(yyyyMmDd + "T12:00:00Z"));
    } catch (_e) { return yyyyMmDd; }
  }

  // Assignment eligibility — delegated to the shared module so /work,
  // /index (DCR form), and any future tech surface use the same rule.
  // Function name preserved so existing call sites stay unchanged. See
  // public/assignment-eligibility.js for the single source of truth.
  //
  // The shared module's workweek-aware fallback fixes the original
  // bug here (Sunday flex jobs invisible Friday/Saturday) because the
  // legacy path required service_date === todayPT even when the flex
  // policy said earlier work was allowed.
  function isAvailableNow(a, todayPT, nowMs) {
    if (window.PIONEER_ELIGIBILITY && window.PIONEER_ELIGIBILITY.isWorkableNow) {
      return window.PIONEER_ELIGIBILITY.isWorkableNow(a, nowMs, todayPT);
    }
    // Defensive fallback if the shared module failed to load — keep
    // the original strict behavior rather than crash. logged in the
    // console so the missing script tag is obvious.
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[service-clock] PIONEER_ELIGIBILITY missing; falling back to legacy isAvailableNow");
    }
    var hasFrom  = !!(a.available_from  && typeof a.available_from.toMillis  === "function");
    var hasUntil = !!(a.available_until && typeof a.available_until.toMillis === "function");
    if (hasFrom && hasUntil) {
      return a.available_from.toMillis()  <= nowMs &&
             a.available_until.toMillis() >= nowMs;
    }
    if (hasFrom && !hasUntil) {
      return a.available_from.toMillis() <= nowMs && a.service_date === todayPT;
    }
    if (!hasFrom && hasUntil) {
      return a.available_until.toMillis() >= nowMs && a.service_date === todayPT;
    }
    return a.service_date === todayPT;
  }

  // Phase 1c.1 — hero greeting card helpers.
  //
  // First-name extraction: take the first word of the display name and
  // strip a trailing period ("Nick K." → "Nick"). Falls back to the
  // email local-part if no display name is set.
  function firstName(staff) {
    const raw = String((staff && staff.displayName) || "").trim();
    if (raw) {
      const first = raw.split(/\s+/)[0] || "";
      const cleaned = first.replace(/\.+$/, "");
      if (cleaned) return cleaned;
    }
    const email = String((staff && staff.email) || "");
    const local = email.split("@")[0] || "";
    if (!local) return "";
    return local.charAt(0).toUpperCase() + local.slice(1);
  }

  // Time-of-day greeting in Pacific. Four buckets per Phase 1c plan.
  // Apple-style title case ("Good Morning", not "Good morning").
  function timeOfDayGreeting() {
    let hour;
    try {
      hour = parseInt(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        hourCycle: "h23"
      }).format(new Date()), 10);
    } catch (_e) { hour = new Date().getHours(); }
    if (hour >= 5  && hour < 12) return "Good Morning";
    if (hour >= 12 && hour < 17) return "Good Afternoon";
    if (hour >= 17 && hour < 22) return "Good Evening";
    return "Working Late";
  }

  // Long-format Pacific date ("Monday, June 1").
  function formatHeroDate() {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long",
        month: "long",
        day: "numeric"
      }).format(new Date());
    } catch (_e) { return ""; }
  }

  // "Jun 20" from "2026-06-20" — for Next Payday stat card.
  function formatPaydayShort(yyyyMmDd) {
    if (!yyyyMmDd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day:   "numeric"
      }).format(new Date(yyyyMmDd + "T12:00:00Z"));
    } catch (_e) { return yyyyMmDd; }
  }

  // Count of today's assignments that count as "completed" — DCR
  // submitted OR admin set status=completed. Matches the user's
  // mental model of "done."
  function completedStopsCount() {
    return assignments.filter(function (a) {
      if (a.status === "completed") return true;
      return dcrStatusForAssignment(a._id) === "submitted";
    }).length;
  }

  // Apple-restraint motivational line — confident statements that
  // describe the day, not pep talks. Eight deterministic branches.
  function motivationalLine() {
    const total     = assignments.length;
    const done      = completedStopsCount();
    const isActive  = !!activeSession;
    if (total === 0) return "No stops today.";
    if (done === total) {
      // Check whether all completed stops have DCRs in.
      const allDcrIn = assignments.every(function (a) {
        return dcrStatusForAssignment(a._id) === "submitted";
      });
      return allDcrIn ? "Day complete." : "Complete the DCRs.";
    }
    if (isActive) {
      // On-pace logic — based on the current stop's worked vs. budget.
      const a = assignments.find(function (x) {
        return activeSession.assignment_id === x._id;
      });
      if (a && a.budget_minutes) {
        const worked = cumulativeWorkedMinutes(a._id);
        if (worked > a.budget_minutes) return "Over budget — keep going.";
        if (worked < a.budget_minutes * 0.5) return "Ahead of schedule.";
      }
      return "On pace.";
    }
    if (done === 0) {
      let hour;
      try {
        hour = parseInt(new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric", hourCycle: "h23"
        }).format(new Date()), 10);
      } catch (_e) { hour = new Date().getHours(); }
      if (hour < 12) return "Ready to start.";
      return "Ready when you are.";
    }
    return "Keep moving.";
  }

  // Sum of paid_minutes across all sessions for today, PLUS live
  // elapsed for the active session if it belongs to today's
  // service_date. Used by the Hours Today stat card.
  function hoursTodayMinutes() {
    const todayPT = pacificDateString();
    let total = 0;
    Object.keys(sessionsByAssignment).forEach(function (aid) {
      const list = sessionsByAssignment[aid] || [];
      list.forEach(function (s) {
        if (s.service_date !== todayPT) return;
        if (s.status === "completed" && typeof s.paid_minutes === "number") {
          total += s.paid_minutes;
        }
      });
    });
    if (activeSession &&
        activeSession.service_date === todayPT &&
        activeSession.clock_in_at &&
        typeof activeSession.clock_in_at.toMillis === "function") {
      const liveMs = Date.now() - activeSession.clock_in_at.toMillis();
      if (liveMs > 0) total += Math.floor(liveMs / 60000);
    }
    return total;
  }

  // Phase 1b.4 — derive DCR status for an assignment from its sessions.
  // "submitted" — at least one session has dcr_submission_id set
  //               (the Cloud Function back-stamps this on DCR submit).
  // "pending"   — at least one completed session exists, no DCR yet.
  // "none"      — no completed sessions yet (Clocked-in or never worked).
  function dcrStatusForAssignment(assignmentId) {
    const list = sessionsByAssignment[assignmentId] || [];
    if (!list.length) return "none";
    let hasCompleted = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].dcr_submission_id) return "submitted";
      if (list[i].status === "completed") hasCompleted = true;
    }
    return hasCompleted ? "pending" : "none";
  }

  // Latest session for an assignment — used to populate
  // pioneer_service_session_id in the Complete DCR URL so the Cloud
  // Function knows which session to back-stamp dcr_submission_id onto.
  function latestSessionIdForAssignment(assignmentId) {
    const list = sessionsByAssignment[assignmentId] || [];
    if (!list.length) return "";
    // Sort by clock_in_at desc — most recent first.
    const sorted = list.slice().sort(function (a, b) {
      const am = (a.clock_in_at && typeof a.clock_in_at.toMillis === "function") ? a.clock_in_at.toMillis() : 0;
      const bm = (b.clock_in_at && typeof b.clock_in_at.toMillis === "function") ? b.clock_in_at.toMillis() : 0;
      return bm - am;
    });
    return sorted[0]._id || "";
  }

  // Phase 29 — latest COMPLETED session for an assignment. The Request Time
  // Adjustment flow targets a completed session (clock-in + clock-out present).
  // Returns the full session record, or null if none.
  function latestCompletedSessionForAssignment(assignmentId) {
    const list = sessionsByAssignment[assignmentId] || [];
    const completed = list.filter(function (s) { return s.status === "completed"; });
    if (!completed.length) return null;
    completed.sort(function (a, b) {
      const am = (a.clock_in_at && typeof a.clock_in_at.toMillis === "function") ? a.clock_in_at.toMillis() : 0;
      const bm = (b.clock_in_at && typeof b.clock_in_at.toMillis === "function") ? b.clock_in_at.toMillis() : 0;
      return bm - am;
    });
    return completed[0];
  }

  // Phase 1b.3 — cumulative worked minutes for an assignment.
  // Sums work_minutes across all completed sessions tied to assignment_id
  // for this tech, PLUS live elapsed for the active session if any
  // currently points at this assignment.
  function cumulativeWorkedMinutes(assignmentId) {
    let total = 0;
    const list = sessionsByAssignment[assignmentId] || [];
    list.forEach(function (s) {
      if (s.status === "completed" && typeof s.work_minutes === "number") {
        total += s.work_minutes;
      }
    });
    // Live elapsed for the currently-active session, if it belongs to us.
    if (activeSession && activeSession.assignment_id === assignmentId &&
        activeSession.clock_in_at && typeof activeSession.clock_in_at.toMillis === "function") {
      const liveMs = Date.now() - activeSession.clock_in_at.toMillis();
      if (liveMs > 0) total += Math.floor(liveMs / 60000);
    }
    return total;
  }

  // Format a Firestore Timestamp / Date / ms / ISO → "h:mm AM/PM" PT.
  function formatTimeShort(ts) {
    let ms = null;
    if (!ts) return "";
    if (typeof ts === "number") ms = ts;
    else if (typeof ts === "string") { const t = Date.parse(ts); if (!isNaN(t)) ms = t; }
    else if (ts.toDate && typeof ts.toDate === "function") ms = ts.toDate().getTime();
    else if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    if (ms == null) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return ""; }
  }

  /* ---------- module state ---------- */

  let currentStaff      = null;
  let assignments       = [];      // today's service_assignments docs (raw + _id)
  let activeSession     = null;    // active_service_sessions/{uid} data or null
  let currentPeriodDoc  = null;    // payroll_periods/{current} data or null
  let balanceDoc        = null;    // staff_labor_balances/{uid} data or null
  let clicksWired       = false;
  // Phase 1b.3 — multiple sessions per assignment (Resume Work flow).
  // sessionsByAssignment maps assignment_id → array of completed/active
  // pioneer_service_sessions docs (raw + _id), used to compute
  // cumulative worked_minutes per card.
  let sessionsByAssignment = {};
  // Phase 29 — pending time-adjustment requests for this tech, keyed by
  // "assignment_id|service_session_id". Used to suppress the Request
  // Adjustment button so we don't render a duplicate-submit affordance.
  let pendingAdjustmentKeys = {};
  // Re-render the cards every 30 s while a session is active so the
  // "Worked: Xh Ym (currently working…)" timer text stays current.
  let timerInterval     = null;

  /* ---------- auth resolution + first load ---------- */

  function bootWhenAuthReady() {
    // BOOT-ORDER RACE: work.js registers a DOMContentLoaded handler that
    // calls STAFF_AUTH.init() → firebase.initializeApp(). That handler
    // is registered AFTER ours (work.js loads after service-clock.js),
    // so DOMContentLoaded fires our listener FIRST, at which point
    // firebase.apps.length === 0 and calling firebase.auth() throws
    // "No Firebase App '[DEFAULT]' has been created". The earlier
    // implementation hit that throw and silently kept the section
    // hidden. Poll for initialization, then subscribe.
    if (!window.firebase || typeof firebase.auth !== "function") {
      warnSC("Firebase SDK not loaded; service clock stays hidden");
      return;
    }
    logSC("waiting for firebase.initializeApp (work.js's DOMContentLoaded handler runs after ours)");
    let attempts = 0;
    const interval = setInterval(function () {
      attempts += 1;
      if (firebase.apps && firebase.apps.length > 0) {
        clearInterval(interval);
        logSC("firebase initialized — subscribing to auth state");
        attachAuthListener();
        return;
      }
      if (attempts > 120) {  // ~30s @ 250ms — generous; in practice <1 tick
        clearInterval(interval);
        warnSC("firebase.initializeApp never ran; service clock stays hidden");
      }
    }, 250);
  }

  function attachAuthListener() {
    // STAFF_AUTH.getCachedStaff() intentionally returns a localStorage
    // "lite" version of staff WITHOUT uid (see staff-auth.js
    // writeCachedStaff). firebase.auth().currentUser is the canonical
    // uid source. Multiple subscribers are supported — this doesn't
    // conflict with staff-auth.js's own onAuthStateChanged handler.
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) {
        logSC("no signed-in user; service clock stays hidden");
        return;
      }
      const cached = window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
        ? window.STAFF_AUTH.getCachedStaff() : null;
      currentStaff = {
        uid:         user.uid,
        email:       user.email || (cached && cached.email) || "",
        displayName: user.displayName || (cached && cached.display_name) || ""
      };
      logSC("staff resolved via firebase.auth", { uid: currentStaff.uid, email: currentStaff.email });
      initialLoad().catch(function (err) {
        warnSC("initial load failed", err && err.message);
        renderFatalError(err);
      });
    });
  }

  async function initialLoad() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      throw new Error("Firebase Firestore SDK not loaded");
    }
    const db       = firebase.firestore();
    const todayPT  = pacificDateString();
    const periodId = getSemiMonthlyPeriod(todayPT).period_id;
    // Phase 1b.2 — fetch a small window of assignments around today so
    // early-work (Sunday assignments worked Friday/Saturday) and same-day
    // late-completion both surface. Client-side isAvailableNow() does the
    // final filter. Window today−1 to today+3 covers Pioneer's current
    // Sun-Thu workweek + Fri/Sat early-work scenarios.
    const lookbackPT  = addDaysPT(todayPT, -1);
    const lookaheadPT = addDaysPT(todayPT,  3);
    const nowMs       = Date.now();

    // Show the section frame immediately (with a loading state inside).
    showSection();
    setAssignmentsLoading();

    // Parallel reads. We catch the assignments query separately because
    // it's the one that needs a composite index — may fail with a
    // friendly "still building" error in the first few minutes after a
    // fresh deploy. Range + orderBy uses the existing
    // (staff_uid asc, service_date desc) composite from Phase 1a.
    const tasks = [
      db.collection("service_assignments")
        .where("staff_uid",    "==", currentStaff.uid)
        .where("service_date", ">=", lookbackPT)
        .where("service_date", "<=", lookaheadPT)
        .orderBy("service_date", "desc")
        .get()
        .then(function (snap) {
          const raw = snap.docs.map(function (d) {
            return Object.assign({ _id: d.id }, d.data());
          });

          // V20260614 — Multi-shift visibility. Show every assignment
          // for the workday whose document isn't structurally invalid.
          // Removed: the prior isAvailableNow() filter that hid future
          // shifts whose available_from > now. Pioneer policy is
          // flex-order cleaning — techs may complete stops in any
          // order — so visibility is day-based, not time-window-based.
          // Eligibility is no longer a visibility gate; it could be a
          // button-enable hint in the future if desired.
          //
          // "Truly invalid" = removed_from_ptc, admin_removed, or any
          // cancellation/deletion status.
          const TERMINAL_INVALID_STATUSES = {
            "admin_removed":       1,
            "cancelled":           1,
            "canceled":            1,
            "canceled_by_deputy":  1,
            "deleted":             1
          };
          const excludedAssignments = [];
          const visible = raw.filter(function (a) {
            if (!a) {
              excludedAssignments.push({ id: "(null doc)", reason: "null assignment" });
              return false;
            }
            if (a.removed_from_ptc === true) {
              excludedAssignments.push({ id: a._id, reason: "removed_from_ptc=true" });
              return false;
            }
            const s = String(a.status || "").toLowerCase();
            if (TERMINAL_INVALID_STATUSES[s]) {
              excludedAssignments.push({ id: a._id, reason: "status=" + s });
              return false;
            }
            return true;
          });

          // Sort by scheduled start time, ascending. Prefer
          // service_window_start (timestamp), then scheduled_start,
          // then service_date + "00:00" fallback. Stable so two stops
          // with the same start time keep their Firestore order.
          function startMs(a) {
            const t = a.service_window_start || a.scheduled_start || a.start_time;
            if (t && typeof t.toMillis === "function") return t.toMillis();
            if (t && typeof t.seconds === "number")    return t.seconds * 1000;
            if (typeof t === "number")                 return t;
            if (typeof t === "string") {
              const p = Date.parse(t);
              if (!isNaN(p)) return p;
            }
            if (a.service_date) {
              const p2 = Date.parse(a.service_date + "T00:00:00");
              if (!isNaN(p2)) return p2;
            }
            return Number.MAX_SAFE_INTEGER;
          }
          visible.sort(function (a, b) {
            const ma = startMs(a), mb = startMs(b);
            return ma - mb;
          });

          // Hand the whole day's list to render. NO isAvailableNow
          // filter. The active-session check inside assignmentCard
          // drives button enable/disable; visibility is day-based.
          assignments = visible;

          const debugTrace = (function () {
            try { return new URLSearchParams(location.search || "").get("debug") === "1"; }
            catch (_e) { return false; }
          })();
          if (debugTrace) {
            function dumpTs(v) {
              if (!v) return "(null/undef)";
              if (typeof v === "number") return v + " (ms)";
              if (v.toMillis) return v.toMillis() + " (ts→ms)";
              if (v.seconds) return (v.seconds * 1000) + " (s*1000)";
              return JSON.stringify(v);
            }
            console.log("[PIONEER DEBUG] service_assignments raw result", {
              query_filter:    'staff_uid=="' + currentStaff.uid + '" AND service_date BETWEEN "' + lookbackPT + '" AND "' + lookaheadPT + '"',
              raw_count:       raw.length,
              raw_ids:         raw.map(function (a) { return a._id; }),
              now_ms:          nowMs,
              today_pt:        todayPT,
              lookback_pt:     lookbackPT,
              lookahead_pt:    lookaheadPT
            });
            console.log("[PIONEER DEBUG] visible after structural-invalid filter (rendered list)", {
              raw_count:           raw.length,
              visible_day_count:   visible.length,
              rendered_count:      assignments.length,
              excluded_assignments: excludedAssignments,
              rendered_in_order:   assignments.map(function (a) {
                return {
                  id:                a._id,
                  customer:          a.customer_name || a.customer_id,
                  service_date:      a.service_date,
                  status:            a.status,
                  scheduled_start:   dumpTs(a.service_window_start || a.scheduled_start || a.start_time),
                  scheduled_end:     dumpTs(a.service_deadline    || a.scheduled_end   || a.end_time),
                  isAvailableNow:    (window.PIONEER_ELIGIBILITY && window.PIONEER_ELIGIBILITY.isWorkableNow)
                                       ? window.PIONEER_ELIGIBILITY.isWorkableNow(a, nowMs, todayPT)
                                       : null
                };
              })
            });
            try {
              window.__pioneerWorkDebug = {
                build_marker:        "service-clock.js V20260614-multishift",
                staff_uid:           currentStaff.uid,
                staff_email:         currentStaff.email,
                today_pt:            todayPT,
                now_ms:              nowMs,
                lookback_pt:         lookbackPT,
                lookahead_pt:        lookaheadPT,
                raw_assignments:     raw,
                excluded_assignments: excludedAssignments,
                rendered_assignments: assignments,
                active_assignment_id: null   // populated after activeSession resolves
              };
              console.log("[PIONEER DEBUG] window.__pioneerWorkDebug populated for inspection");
            } catch (_e) {}
          }
          return { ok: true };
        })
        .catch(function (err) {
          return { ok: false, err: err };
        }),
      db.collection("active_service_sessions").doc(currentStaff.uid).get()
        .then(function (s) { activeSession = s.exists ? s.data() : null; }),
      db.collection("payroll_periods").doc(periodId).get()
        .then(function (s) { currentPeriodDoc = s.exists ? s.data() : null; }),
      db.collection("staff_labor_balances").doc(currentStaff.uid).get()
        .then(function (s) { balanceDoc = s.exists ? s.data() : null; }),
      // Phase 1b.3 — fetch the tech's sessions in the same date window
      // so we can compute cumulative worked_minutes per assignment AND
      // derive the "paused" state. Reuses the existing
      // (staff_uid asc, service_date desc) index.
      db.collection("pioneer_service_sessions")
        .where("staff_uid",    "==", currentStaff.uid)
        .where("service_date", ">=", lookbackPT)
        .where("service_date", "<=", lookaheadPT)
        .orderBy("service_date", "desc")
        .get()
        .then(function (snap) {
          sessionsByAssignment = {};
          snap.docs.forEach(function (d) {
            const s = Object.assign({ _id: d.id }, d.data());
            if (s.status === "canceled") return;  // exclude canceled
            const key = s.assignment_id;
            if (!key) return;
            if (!sessionsByAssignment[key]) sessionsByAssignment[key] = [];
            sessionsByAssignment[key].push(s);
          });
        })
        .catch(function (err) {
          warnSC("sessions query failed (non-fatal — cumulative totals unavailable)", err && err.code);
          sessionsByAssignment = {};
        }),
      // Phase 29 — pending time-adjustment requests for this tech. Single
      // equality query (no composite index needed). Used to hide the
      // Request Adjustment button on cards that already have one pending.
      db.collection("time_adjustment_requests")
        .where("employee_uid", "==", currentStaff.uid)
        .where("status",       "==", "pending")
        .get()
        .then(function (snap) {
          pendingAdjustmentKeys = {};
          snap.docs.forEach(function (d) {
            const r = d.data() || {};
            const k = String(r.assignment_id || "") + "|" + String(r.service_session_id || "");
            pendingAdjustmentKeys[k] = d.id;
          });
        })
        .catch(function (err) {
          warnSC("pending adjustments query failed (non-fatal)", err && err.code);
          pendingAdjustmentKeys = {};
        })
    ];
    const [assignResult] = await Promise.all(tasks);

    if (!assignResult.ok) {
      // Composite-index-building is the canonical first-deploy failure.
      const code = assignResult.err && assignResult.err.code;
      if (code === "failed-precondition") {
        renderIndexBuildingError();
      } else {
        renderFatalError(assignResult.err);
      }
      return;
    }

    // V20260614 — final pre-render debug summary (with activeSession
    // now resolved). Activated only by ?debug=1.
    try {
      const debugTrace = new URLSearchParams(location.search || "").get("debug") === "1";
      if (debugTrace) {
        if (window.__pioneerWorkDebug) {
          window.__pioneerWorkDebug.active_assignment_id =
            (activeSession && activeSession.assignment_id) || null;
        }
        console.log("[PIONEER DEBUG] pre-render summary", {
          rendered_count:        assignments.length,
          rendered_ids:          assignments.map(function (a) { return a._id; }),
          active_assignment_id:  (activeSession && activeSession.assignment_id) || null,
          will_block_others:     !!(activeSession && activeSession.assignment_id)
        });
      }
    } catch (_e) {}

    // Phase 1c.1 — Hero greeting card + 4 stat cards above the
    // assignment list. The hero takes over the section's identity
    // (the old "⏱ Pioneer Time Clock" header was removed in 1c.1).
    renderHero();
    renderStats();
    renderAssignments();
    // Phase 1b.3 — keep the "currently working" timer text fresh while
    // a session is active. Cheap re-render every 30s; stops on
    // clock-out / initial-load tear-down.
    if (activeSession) startTimer();
    else stopTimer();
  }

  function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(function () {
      try { renderAssignments(); } catch (_e) {}
    }, 30000);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  /* ---------- Phase 1c.1: hero + stat cards ---------- */

  function renderHero() {
    const root = $("ptc-hero");
    if (!root) return;
    const name        = firstName(currentStaff);
    const greetingLine= timeOfDayGreeting() + (name ? ", " + name : "");
    const dateLine    = formatHeroDate();
    const total       = assignments.length;
    const done        = completedStopsCount();
    const pct         = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const progressLine = total
      ? (done + " of " + total + " stops completed")
      : "No stops scheduled today";
    const status      = motivationalLine();

    root.innerHTML =
      '<h1 class="ptc-hero-greeting">' + escapeHtml(greetingLine) + '</h1>' +
      '<p class="ptc-hero-date">'      + escapeHtml(dateLine)     + '</p>' +
      (total
        ? '<p class="ptc-hero-progress-line">' + escapeHtml(progressLine) + '</p>' +
          '<div class="ptc-hero-progress-bar" role="progressbar" ' +
              'aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
            '<div class="ptc-hero-progress-fill" style="width:' + pct + '%"></div>' +
          '</div>'
        : '<p class="ptc-hero-progress-line">' + escapeHtml(progressLine) + '</p>') +
      '<p class="ptc-hero-status">' + escapeHtml(status) + '</p>';
    root.hidden = false;
  }

  function renderStats() {
    const root = $("ptc-stats");
    if (!root) return;
    const todayMin     = hoursTodayMinutes();
    const periodMin    = (balanceDoc && balanceDoc.current_period_paid_minutes) || 0;
    const sickMin      = (balanceDoc && typeof balanceDoc.sick_leave_balance_minutes === "number")
                           ? balanceDoc.sick_leave_balance_minutes
                           : null;
    const payday       = (currentPeriodDoc && currentPeriodDoc.payday) || null;
    const todayActive  = !!activeSession;

    // Phase 1c.2.1 polish — `kind` class drives a small accent strip
    // + tinted gradient per card type. Pure visual; no behavior change.
    function card(kind, value, label, caption) {
      const captionHtml = caption
        ? '<p class="ptc-stat-caption">' + escapeHtml(caption) + '</p>'
        : '';
      return '<div class="ptc-stat-card ptc-stat-card--' + kind + '">' +
               '<p class="ptc-stat-value">' + escapeHtml(value) + '</p>' +
               '<p class="ptc-stat-label">' + escapeHtml(label) + '</p>' +
               captionHtml +
             '</div>';
    }

    root.innerHTML =
      card("today",
        todayMin > 0 ? formatMinutesAsHm(todayMin) : "0h 0m",
        "Today",
        todayActive ? "currently working" : ""
      ) +
      card("period",
        formatMinutesAsHm(periodMin),
        "Period",
        periodMin === 0 ? "updates after period close" : ""
      ) +
      card("sick",
        sickMin == null ? "—" : formatMinutesAsHm(sickMin),
        "Sick Leave",
        sickMin == null ? "ask manager" : ""
      ) +
      card("payday",
        payday ? formatPaydayShort(payday) : "—",
        "Payday",
        ""
      );
    root.hidden = false;
  }

  /* ---------- render: balance card (Phase 1b — superseded by stat cards in 1c.1) ---------- */

  function renderBalanceCard() {
    const root = $("ptc-balance-card");
    if (!root) return;
    if (!balanceDoc) {
      root.innerHTML =
        '<div class="ptc-balance-empty">' +
          '<strong>Time + Sick Leave</strong>' +
          '<p>Balance not set up yet — talk to your manager.</p>' +
        '</div>';
      root.hidden = false;
      return;
    }
    const periodPaidMin = balanceDoc.current_period_paid_minutes || 0;
    const balanceMin    = balanceDoc.sick_leave_balance_minutes  || 0;
    const earnedEstMin  = balanceDoc.current_period_sick_accrual_estimated_minutes || 0;
    const periodLabel   = currentPeriodDoc && currentPeriodDoc.period_label
      ? currentPeriodDoc.period_label : "Current period";
    root.innerHTML =
      '<div class="ptc-balance-head">' +
        '<span class="ptc-balance-eyebrow">' + escapeHtml(periodLabel) + '</span>' +
      '</div>' +
      '<dl class="ptc-balance-list">' +
        '<div class="ptc-balance-row">' +
          '<dt>Paid hours this period</dt>' +
          '<dd>' + escapeHtml(formatMinutesAsHm(periodPaidMin)) + '</dd>' +
        '</div>' +
        '<div class="ptc-balance-row">' +
          '<dt>Banked sick leave</dt>' +
          '<dd>' + escapeHtml(formatMinutesAsHm(balanceMin)) + '</dd>' +
        '</div>' +
        '<div class="ptc-balance-row ptc-balance-row--preliminary">' +
          '<dt>Earned this period <em>(preliminary)</em></dt>' +
          '<dd>' + escapeHtml(formatMinutesAsHm(earnedEstMin)) + '</dd>' +
        '</div>' +
      '</dl>';
    root.hidden = false;
  }

  /* ---------- render: assignment cards ---------- */

  function setAssignmentsLoading() {
    const root = $("ptc-assignments");
    if (root) root.innerHTML = '<p class="ptc-status ptc-status-loading">Loading today\'s service stops…</p>';
  }

  function renderAssignments() {
    const root = $("ptc-assignments");
    if (!root) return;
    if (!assignments.length) {
      // UI cleanup 2026-06-02 — legacy Today's Work fallback removed.
      // Copy updated: previously directed techs to "Start Work below" in
      // the duplicate section. With that section gone, the actionable
      // path when a tech has no Pioneer assignment is to contact the
      // office to seed/bridge their assignment.
      root.innerHTML =
        '<div class="ptc-empty">' +
          '<p><strong>No Pioneer Time Clock assignments for this shift.</strong></p>' +
          '<p>Contact the office so your shift can be added to Pioneer Time Clock.</p>' +
        '</div>';
      return;
    }
    // Phase 1b.4 — "Next Step: Complete DCR" banner. Shows when at
    // least one paused assignment is missing a DCR AND the tech isn't
    // currently clocked into anything. Points at the first such
    // assignment by customer name for quick orientation.
    let nextStepHtml = "";
    if (!activeSession) {
      const needsDcr = assignments.filter(function (a) {
        return dcrStatusForAssignment(a._id) === "pending";
      });
      if (needsDcr.length === 1) {
        nextStepHtml =
          '<div class="ptc-next-step">' +
            '<strong>Next step:</strong> Complete the DCR for ' +
            escapeHtml(needsDcr[0].customer_name || needsDcr[0].customer_id || "this stop") + '.' +
          '</div>';
      } else if (needsDcr.length > 1) {
        nextStepHtml =
          '<div class="ptc-next-step">' +
            '<strong>Next step:</strong> Complete ' + needsDcr.length + ' DCRs from today.' +
          '</div>';
      }
    }
    root.innerHTML = nextStepHtml + assignments.map(assignmentCard).join("");
  }

  // Compute live UI state from sessions + DCR status (NOT from
  // assignment.status — admin-managed and may lag).
  // Phase 1c.2 — five clean states: ready / working / paused /
  // dcr_pending / complete (+ missed / canceled terminals).
  // Paused = work done AND DCR submitted (waiting on admin or another cycle).
  // DCR Pending = work done AND no DCR yet (next action is Complete DCR).
  function deriveDisplayState(a) {
    if (activeSession && activeSession.assignment_id === a._id) return "working";
    if (a.status === "completed") return "complete";
    if (a.status === "missed" || a.status === "canceled") return a.status;
    const prior = sessionsByAssignment[a._id] || [];
    const hasCompleted = prior.some(function (s) { return s.status === "completed"; });
    if (hasCompleted) {
      const dcr = dcrStatusForAssignment(a._id);
      return (dcr === "submitted") ? "paused" : "dcr_pending";
    }
    return "ready";
  }

  function statusChip(state) {
    const map = {
      "ready":       { cls: "is-ready",    label: "Ready" },
      "working":     { cls: "is-working",  label: "Working" },
      "paused":      { cls: "is-paused",   label: "Paused" },
      "dcr_pending": { cls: "is-dcr",      label: "DCR Pending" },
      "complete":    { cls: "is-complete", label: "Complete" },
      "missed":      { cls: "is-missed",   label: "Missed" },
      "canceled":    { cls: "is-canceled", label: "Canceled" }
    };
    const m = map[state] || map.ready;
    return '<span class="ptc-status-chip ' + m.cls + '">' + m.label + '</span>';
  }

  function assignmentCard(a) {
    const state    = deriveDisplayState(a);
    const blockedByOther = !!(activeSession && activeSession.assignment_id !== a._id);
    const id       = escapeHtml(a._id);
    const todayPT  = pacificDateString();

    // ---- Metadata strip (service date + optional deadline / window) ----
    const dateLabel    = a.service_date ? formatServiceDateLong(a.service_date) : "";
    const deadline     = a.service_deadline ? formatTimeShort(a.service_deadline) : "";
    const windowStart  = a.service_window_start ? formatTimeShort(a.service_window_start) : "";
    let availabilityNote = "";
    if (a.service_date && a.service_date !== todayPT) {
      availabilityNote = (a.service_date > todayPT) ? "Available Early" : "Late Completion";
    }
    // Phase 1d Lite — small geo chip showing the worst geo_status
    // across this assignment's sessions. Falls back to nothing when
    // no session has recorded a geo status yet (Ready state).
    const geoStatus = worstGeoStatusForAssignment(a._id);
    let geoChipHtml = "";
    if (geoStatus === "onsite") {
      geoChipHtml = '<span class="ptc-geo-chip is-onsite">Onsite</span>';
    } else if (geoStatus === "nearby") {
      geoChipHtml = '<span class="ptc-geo-chip is-nearby">Nearby</span>';
    } else if (geoStatus === "offsite") {
      geoChipHtml = '<span class="ptc-geo-chip is-offsite">Offsite — review</span>';
    } else if (geoStatus === "unknown_no_site_coordinates") {
      // Customer doc has no location_lat / location_lon — the site
      // isn't geofenced. Not a tech problem, not a clock-in blocker.
      geoChipHtml = '<span class="ptc-geo-chip is-unknown" title="' +
        escapeHtml(geoStatus.replace(/_/g, " ")) + '">Site not geofenced</span>';
    } else if (geoStatus && /^unknown/.test(geoStatus)) {
      // Phone-side GPS state (permission denied, unsupported, timeout).
      // Still not a clock-in blocker — Phase 1d Lite is informational.
      geoChipHtml = '<span class="ptc-geo-chip is-unknown" title="' +
        escapeHtml(geoStatus.replace(/_/g, " ")) + '">GPS unavailable</span>';
    }

    const metaParts = [];
    if (dateLabel)       metaParts.push(escapeHtml(dateLabel));
    if (availabilityNote) metaParts.push('<span class="ptc-card-meta-tag is-' +
      (a.service_date > todayPT ? 'early' : 'late') + '">' + escapeHtml(availabilityNote) + '</span>');
    if (windowStart)     metaParts.push("from " + escapeHtml(windowStart));
    if (deadline)        metaParts.push("by "   + escapeHtml(deadline));
    if (geoChipHtml)     metaParts.push(geoChipHtml);
    const metaStripHtml = metaParts.length
      ? '<p class="ptc-card-meta-strip">' + metaParts.join(' <span class="ptc-card-meta-sep">·</span> ') + '</p>'
      : '';

    // ---- Scorecard (Worked / Budget / Remaining) ----
    const workedMin = cumulativeWorkedMinutes(a._id);
    const budgetMin = (typeof a.budget_minutes === "number") ? a.budget_minutes : null;
    const isActiveHere = (state === "working");

    let remainingHtml = '';
    let progressPct   = 0;
    let progressTier  = "is-cool";   // 0-79%
    let progressLabel = "";
    if (budgetMin && budgetMin > 0) {
      const remaining = budgetMin - workedMin;
      progressPct = Math.min(120, Math.round((workedMin / budgetMin) * 100));
      if (workedMin >= budgetMin) {
        progressTier  = "is-hot";
        progressLabel = "Over budget by " + formatMinutesAsHm(Math.abs(remaining));
      } else if (progressPct >= 80) {
        progressTier  = "is-warn";
      }
      remainingHtml = (remaining >= 0)
        ? '<div class="ptc-score-cell"><p class="ptc-score-value">' + escapeHtml(formatMinutesAsHm(remaining)) +
            '</p><p class="ptc-score-label">Remaining</p></div>'
        : '<div class="ptc-score-cell is-over"><p class="ptc-score-value">' + escapeHtml(formatMinutesAsHm(Math.abs(remaining))) +
            '</p><p class="ptc-score-label">Over</p></div>';
    }
    // "Complete" state — collapse Remaining; just show Worked + Budget.
    if (state === "complete") {
      remainingHtml = '';
      progressTier  = "is-done";
      progressPct   = 100;
      progressLabel = "Done";
    }
    const scoreHtml =
      '<div class="ptc-scorecard">' +
        '<div class="ptc-score-cell' + (isActiveHere ? ' is-active' : '') + '">' +
          '<p class="ptc-score-value">' + escapeHtml(formatMinutesAsHm(workedMin)) + '</p>' +
          '<p class="ptc-score-label">Worked</p>' +
        '</div>' +
        (budgetMin
          ? '<div class="ptc-score-cell"><p class="ptc-score-value">' +
              escapeHtml(formatMinutesAsHm(budgetMin)) +
            '</p><p class="ptc-score-label">Budget</p></div>'
          : '') +
        remainingHtml +
      '</div>';

    // ---- Progress bar (under scorecard) ----
    let progressHtml = '';
    if (budgetMin || state === "complete") {
      progressHtml =
        '<div class="ptc-progress ' + progressTier + '" role="progressbar" ' +
            'aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progressPct + '">' +
          '<div class="ptc-progress-fill" style="width:' + Math.min(100, progressPct) + '%"></div>' +
          (progressLabel
            ? '<span class="ptc-progress-label">' + escapeHtml(progressLabel) + '</span>'
            : '') +
        '</div>';
    }

    // ---- Live "currently working" caption under the bar ----
    let liveHtml = '';
    if (isActiveHere && activeSession && activeSession.clock_in_at) {
      liveHtml = '<p class="ptc-live-line">Currently working — started ' +
        escapeHtml(formatTimeShort(activeSession.clock_in_at)) + '</p>';
    }

    // ---- Completion summary (state === "complete") ----
    // V20260614 — Multi-shift: explicit "✅ Shift Completed" with
    // clocked-out time + DCR status so a finished shift can never be
    // mistaken for a ready one in a long list of stops.
    let completionSummaryHtml = '';
    if (state === "complete") {
      const lastSession = latestCompletedSessionForAssignment(a._id);
      const clockOutTime = lastSession && lastSession.clock_out_at
        ? formatTimeShort(lastSession.clock_out_at)
        : "";
      const dcrStat = dcrStatusForAssignment(a._id);
      const dcrLabel = dcrStat === "submitted"
        ? '<span class="ptc-dcr-pill is-ok">DCR submitted</span>'
        : dcrStat === "pending"
          ? '<span class="ptc-dcr-pill is-warn">DCR pending</span>'
          : '<span class="ptc-dcr-pill is-warn">DCR missing</span>';
      completionSummaryHtml =
        '<div class="ptc-completion-summary">' +
          '<div class="ptc-completion-banner">' +
            '<span aria-hidden="true">✅</span> Shift Completed' +
          '</div>' +
          '<div class="ptc-completion-grid">' +
            (clockOutTime
              ? '<div><span class="ptc-completion-label">Clocked out at</span> ' +
                  '<strong>' + escapeHtml(clockOutTime) + '</strong>' +
                '</div>'
              : '') +
            '<div><span class="ptc-completion-label">Total time</span> ' +
              '<strong>' + escapeHtml(formatMinutesAsHm(workedMin)) + '</strong>' +
            '</div>' +
            '<div>' + dcrLabel + '</div>' +
          '</div>' +
        '</div>';
    }

    // ---- Buttons. One primary CTA per state; Complete DCR escalates
    // to primary in dcr_pending. Secondary actions stack below. ----
    const latestSession = latestSessionIdForAssignment(a._id);
    function dcrHref() {
      const params = new URLSearchParams();
      params.set("pioneer_assignment_id", a._id);
      if (latestSession)   params.set("pioneer_service_session_id", latestSession);
      if (a.customer_id)   params.set("customer_slug", a.customer_id);
      if (a.customer_name) params.set("customer_name", a.customer_name);
      if (a.service_date)  params.set("sync_date", a.service_date);
      return "/?" + params.toString();
    }

    let buttonsHtml = '';
    if (state === "working") {
      buttonsHtml =
        '<button type="button" class="ptc-btn ptc-btn-primary ptc-btn-stop" ' +
          'data-action="clock-out" data-assignment-id="' + id + '">Clock Out</button>';
    } else if (state === "dcr_pending") {
      buttonsHtml =
        '<a class="ptc-btn ptc-btn-primary ptc-btn-dcr" href="' + escapeHtml(dcrHref()) + '" ' +
          'data-action="complete-dcr">Complete DCR</a>' +
        '<button type="button" class="ptc-btn ptc-btn-secondary" ' +
          'data-action="clock-in" data-assignment-id="' + id + '">Resume Work</button>';
    } else if (state === "paused") {
      buttonsHtml =
        '<button type="button" class="ptc-btn ptc-btn-primary ptc-btn-start" ' +
          'data-action="clock-in" data-assignment-id="' + id + '">Resume Work</button>';
    } else if (state === "complete") {
      // No button — the state chip says it all. Apple-restraint.
      buttonsHtml = '';
    } else if (state === "missed" || state === "canceled") {
      buttonsHtml = '';
    } else if (blockedByOther) {
      // V20260614 — Multi-shift: all not-started shifts stay visible
      // while one is active. The Start button is rendered disabled
      // with the friendly explanation right under it so the tech
      // never wonders why it won't respond.
      buttonsHtml =
        '<button type="button" class="ptc-btn ptc-btn-disabled" disabled ' +
          'aria-disabled="true">Start This Shift</button>' +
        '<p class="ptc-card-blocked-msg">' +
          'Clock out of your current shift before starting another.' +
        '</p>';
    } else {
      // ready
      buttonsHtml =
        '<button type="button" class="ptc-btn ptc-btn-primary ptc-btn-start" ' +
          'data-action="clock-in" data-assignment-id="' + id + '">Start This Shift</button>';
    }

    // Phase 29 — Request Time Adjustment. Available once a session for this
    // assignment is COMPLETED, the shift_date is in the allowed window, the
    // session isn't payroll-locked, and no pending request already exists.
    // Rendered as a tertiary affordance under the primary CTA so it doesn't
    // crowd the main flow.
    const adjEligibility = adjustmentEligibility(a);
    if (adjEligibility.eligible) {
      buttonsHtml +=
        '<button type="button" class="ptc-btn ptc-btn-tertiary" ' +
          'data-action="request-time-adjustment" data-assignment-id="' + id +
          '" data-session-id="' + escapeHtml(adjEligibility.sessionId) +
          '">Request Time Adjustment</button>';
    } else if (adjEligibility.reasonChip) {
      buttonsHtml +=
        '<p class="ptc-adjustment-note">' + escapeHtml(adjEligibility.reasonChip) + '</p>';
    }

    return (
      '<article class="ptc-card" data-assignment-id="' + id + '" data-state="' + state + '">' +
        '<header class="ptc-card-head">' +
          '<span class="ptc-card-eyebrow">PIONEER</span>' +
          statusChip(state) +
        '</header>' +
        '<h3 class="ptc-card-title">' +
          escapeHtml(a.customer_name || a.customer_id || "Customer") +
        '</h3>' +
        (a.location_name
          ? '<p class="ptc-card-loc">' + escapeHtml(a.location_name) + '</p>'
          : "") +
        metaStripHtml +
        scoreHtml +
        progressHtml +
        liveHtml +
        completionSummaryHtml +
        (buttonsHtml
          ? '<div class="ptc-card-actions">' + buttonsHtml + '</div>'
          : '') +
      '</article>'
    );
  }

  /* ---------- Phase 1d Lite — geofence / distance helpers ----------
   * Pure math + status enums. No Firestore, no GPS calls. */

  // Haversine — distance in meters between two lat/lng points.
  function haversineMeters(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    const R = 6371000;  // Earth radius in meters
    const toRad = function (deg) { return deg * Math.PI / 180; };
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  // Compute geo_status enum + distance from the captured GPS + the
  // assignment's site coordinates. Implements the user's banded
  // tiers (<=200m onsite, 200-500m nearby, >500m offsite).
  function computeGeoStatus(geo, siteLat, siteLng) {
    if (!geo || geo.status === "denied") {
      return { geo_status: "unknown_permission_denied", distance_m: null };
    }
    if (geo.lat == null || geo.lon == null) {
      return { geo_status: "unknown_gps_unavailable", distance_m: null };
    }
    if (siteLat == null || siteLng == null) {
      return { geo_status: "unknown_no_site_coordinates", distance_m: null };
    }
    const d = haversineMeters(geo.lat, geo.lon, siteLat, siteLng);
    if (d == null) return { geo_status: "unknown_gps_unavailable", distance_m: null };
    if (d <= 200)  return { geo_status: "onsite",  distance_m: d };
    if (d <= 500)  return { geo_status: "nearby",  distance_m: d };
    return         { geo_status: "offsite", distance_m: d };
  }

  // Worst geo_status across an assignment's sessions — used for the
  // card chip when paused or complete. Rank: offsite > nearby > onsite
  // > unknown_*. Returns null when no session yet recorded one.
  function worstGeoStatusForAssignment(assignmentId) {
    const list = sessionsByAssignment[assignmentId] || [];
    if (!list.length) return null;
    const rank = { offsite: 4, nearby: 3, onsite: 2 };
    let worst = null;
    list.forEach(function (s) {
      [s.clock_in_geo_status, s.clock_out_geo_status].forEach(function (g) {
        if (!g) return;
        if (worst == null) { worst = g; return; }
        const r1 = rank[g] || 1;          // unknown_* → 1
        const r2 = rank[worst] || 1;
        if (r1 > r2) worst = g;
      });
    });
    return worst;
  }

  /* ---------- GPS capture (best-effort, non-blocking) ---------- */

  function captureGeo() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) {
        resolve({ lat: null, lon: null, accuracy_m: null, status: "unsupported" });
        return;
      }
      const timer = setTimeout(function () {
        resolve({ lat: null, lon: null, accuracy_m: null, status: "timeout" });
      }, 5500);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          clearTimeout(timer);
          resolve({
            lat:        pos.coords.latitude,
            lon:        pos.coords.longitude,
            accuracy_m: Math.round(pos.coords.accuracy || 0),
            status:     "ok"
          });
        },
        function (err) {
          clearTimeout(timer);
          const code = err && err.code;
          const status = code === 1 ? "denied"
                       : code === 2 ? "unavailable"
                       : code === 3 ? "timeout"
                       : "error";
          resolve({ lat: null, lon: null, accuracy_m: null, status: status });
        },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
      );
    });
  }

  /* ---------- clock-in transaction ---------- */

  async function clockIn(assignmentId) {
    const db   = firebase.firestore();
    const geo  = await captureGeo();
    const today = pacificDateString();
    const staffEmail = String((currentStaff && currentStaff.email) || "").toLowerCase().trim();

    const sessionRef = db.collection("pioneer_service_sessions").doc();
    const activeRef  = db.collection("active_service_sessions").doc(currentStaff.uid);
    const assignRef  = db.collection("service_assignments").doc(assignmentId);
    const punchRef   = db.collection("time_punches").doc();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();

    await db.runTransaction(async function (tx) {
      const activeSnap = await tx.get(activeRef);
      if (activeSnap.exists) {
        const ex = activeSnap.data();
        throw new Error("Already clocked in to another stop (" + (ex.customer_id || ex.assignment_id) + "). Clock out first.");
      }
      const assignSnap = await tx.get(assignRef);
      if (!assignSnap.exists) throw new Error("Assignment not found.");
      const a = assignSnap.data();
      if (a.staff_uid !== currentStaff.uid) throw new Error("This assignment is not yours.");
      if (a.status === "completed" || a.status === "missed" || a.status === "canceled") {
        throw new Error("This assignment is " + a.status + " and cannot be clocked into.");
      }

      // Phase 1d Lite — compute geo_status against the assignment's
      // stored coordinates. Falls back to unknown_no_site_coordinates
      // when the assignment has no lat/lng (every assignment today —
      // see Phase 1d Lite report). Never blocks clock-in regardless.
      const siteLat   = (typeof a.location_lat === "number") ? a.location_lat : null;
      const siteLng   = (typeof a.location_lon === "number") ? a.location_lon : null;
      const geoEval   = computeGeoStatus(geo, siteLat, siteLng);
      const offsite   = (geoEval.geo_status === "offsite");

      tx.set(sessionRef, {
        assignment_id:                 assignmentId,
        staff_uid:                     currentStaff.uid,
        staff_email:                   staffEmail,
        service_date:                  today,
        customer_id:                   a.customer_id  || null,
        customer_name:                 a.customer_name || null,
        location_id:                   a.location_id  || null,

        clock_in_at:                   sts,
        clock_in_gps_status:           geo.status,
        clock_in_geo_status:           geoEval.geo_status,
        clock_in_distance_from_site_meters: geoEval.distance_m,
        clock_in_source:               "work_html_phase_1d_lite",

        clock_out_at:                  null,
        status:                        "active",
        break_minutes:                 0,
        work_minutes:                  0,
        paid_minutes:                  0,
        paid_drive_minutes:            0,
        sick_accrual_eligible_minutes: 0,
        needs_review:                  offsite,
        max_distance_from_site_meters: geoEval.distance_m,
        accrued_in_period_id:          null,
        dcr_submission_id:             null,

        created_at:                    sts,
        updated_at:                    sts
      });

      tx.set(activeRef, {
        staff_uid:     currentStaff.uid,
        session_id:    sessionRef.id,
        assignment_id: assignmentId,
        customer_id:   a.customer_id || null,
        clock_in_at:   sts,
        service_date:  today
      });

      tx.set(punchRef, {
        punch_type:    "clock_in",
        staff_uid:     currentStaff.uid,
        staff_email:   staffEmail,
        service_date:  today,
        assignment_id: assignmentId,
        session_id:    sessionRef.id,
        customer_id:   a.customer_id || null,
        location_id:   a.location_id || null,

        punch_at:      sts,
        client_ts:     Date.now(),
        gps: {
          lat:              geo.lat,
          lng:              geo.lon,
          accuracy_meters:  geo.accuracy_m
        },
        site: {
          lat: siteLat,
          lng: siteLng
        },
        distance_from_site_meters: geoEval.distance_m,
        gps_status:    geo.status,
        geo_status:    geoEval.geo_status,

        source:        "work_html_phase_1d_lite",
        user_agent:    (typeof navigator !== "undefined" && navigator.userAgent) || ""
      });
    });

    logSC("clock-in OK", { assignment: assignmentId });
    await initialLoad();
  }

  /* ---------- clock-out transaction ---------- */

  async function clockOut(assignmentId) {
    if (!activeSession || activeSession.assignment_id !== assignmentId) {
      throw new Error("You're not currently clocked into this stop.");
    }
    const db    = firebase.firestore();
    const geo   = await captureGeo();
    const today = pacificDateString();
    const sessionId  = activeSession.session_id;
    const sessionRef = db.collection("pioneer_service_sessions").doc(sessionId);
    const activeRef  = db.collection("active_service_sessions").doc(currentStaff.uid);
    const punchRef   = db.collection("time_punches").doc();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();
    const staffEmail = String((currentStaff && currentStaff.email) || "").toLowerCase().trim();

    await db.runTransaction(async function (tx) {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists) throw new Error("Session not found.");
      const s = sessionSnap.data();
      if (s.staff_uid !== currentStaff.uid) throw new Error("This session is not yours.");
      if (s.status !== "active") throw new Error("Session is no longer active.");

      // Compute work_minutes from server-stamped clock_in_at and client now.
      // Client-clock drift is typically small but unbounded; mark needs_review
      // for implausible values.
      let workMinutes = 0;
      let needsReview = false;
      if (s.clock_in_at && typeof s.clock_in_at.toMillis === "function") {
        const elapsedMs = Date.now() - s.clock_in_at.toMillis();
        workMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
        if (workMinutes < 1 || workMinutes > 14 * 60) needsReview = true;
      } else {
        needsReview = true;
      }
      const paidMinutes = workMinutes;  // no drive in Phase 1b
      const accrualMinutes = paidMinutes;  // no exclusions in Phase 1b

      // Phase 1d Lite — geo_status for clock-out + roll up
      // max_distance_from_site_meters across both punches of this
      // session. needs_review fires if either punch is offsite OR if
      // work_minutes calc was implausible.
      // Site coords are re-read from the assignment (cached on the
      // session at clock-in time is also possible but we want the
      // current admin-edited value if any).
      const a            = assignments.find(function (x) { return x._id === s.assignment_id; }) || {};
      const siteLat      = (typeof a.location_lat === "number") ? a.location_lat
                            : ((typeof s.site_lat === "number") ? s.site_lat : null);
      const siteLng      = (typeof a.location_lon === "number") ? a.location_lon
                            : ((typeof s.site_lng === "number") ? s.site_lng : null);
      const geoOutEval   = computeGeoStatus(geo, siteLat, siteLng);
      const inDist       = (typeof s.clock_in_distance_from_site_meters === "number")
                              ? s.clock_in_distance_from_site_meters : null;
      const outDist      = geoOutEval.distance_m;
      const maxDist      = [inDist, outDist].filter(function (n) { return typeof n === "number"; })
                              .reduce(function (m, v) { return v > m ? v : m; }, 0) || null;
      const offsiteFlag  = (s.clock_in_geo_status === "offsite") ||
                           (geoOutEval.geo_status === "offsite");

      tx.update(sessionRef, {
        status:                        "completed",
        clock_out_at:                  sts,
        clock_out_gps_status:          geo.status,
        clock_out_geo_status:          geoOutEval.geo_status,
        clock_out_distance_from_site_meters: geoOutEval.distance_m,
        clock_out_source:              "work_html_phase_1d_lite",
        max_distance_from_site_meters: maxDist,
        work_minutes:                  workMinutes,
        paid_minutes:                  paidMinutes,
        paid_drive_minutes:            0,
        break_minutes:                 0,
        sick_accrual_eligible_minutes: accrualMinutes,
        needs_review:                  needsReview || offsiteFlag,
        updated_at:                    sts
      });

      tx.delete(activeRef);

      tx.set(punchRef, {
        punch_type:    "clock_out",
        staff_uid:     currentStaff.uid,
        staff_email:   staffEmail,
        service_date:  s.service_date || today,
        assignment_id: s.assignment_id,
        session_id:    sessionId,
        customer_id:   s.customer_id || null,
        location_id:   s.location_id || null,

        punch_at:      sts,
        client_ts:     Date.now(),
        gps: {
          lat:              geo.lat,
          lng:              geo.lon,
          accuracy_meters:  geo.accuracy_m
        },
        site: {
          lat: siteLat,
          lng: siteLng
        },
        distance_from_site_meters: geoOutEval.distance_m,
        gps_status:    geo.status,
        geo_status:    geoOutEval.geo_status,

        source:        "work_html_phase_1d_lite",
        user_agent:    (typeof navigator !== "undefined" && navigator.userAgent) || ""
      });
    });

    logSC("clock-out OK", { assignment: assignmentId, session: sessionId });
    await initialLoad();
  }

  /* ---------- click wiring ---------- */

  function wireClicks() {
    if (clicksWired) return;
    const root = $("ptc-assignments");
    if (!root) return;
    root.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;

      // Phase 29 — Request Time Adjustment opens a modal; no inline
      // mutation, so handle it before the clock-in/out fast path.
      if (action === "request-time-adjustment") {
        const aid = btn.dataset.assignmentId;
        const sid = btn.dataset.sessionId;
        if (aid && sid) openTimeAdjustmentModal(aid, sid);
        return;
      }

      const assignmentId = btn.dataset.assignmentId;
      if (!assignmentId) return;
      if (btn.disabled) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = (action === "clock-in") ? "Clocking in…" : "Clocking out…";
      const promise = (action === "clock-in") ? clockIn(assignmentId) : clockOut(assignmentId);
      promise.catch(function (err) {
        warnSC(action + " failed", err && err.message);
        alert(err.message || (action === "clock-in" ? "Clock-in failed." : "Clock-out failed."));
        btn.disabled = false;
        btn.textContent = original;
      });
    });
    clicksWired = true;
  }

  /* ---------- Phase 29 — Time Adjustment Request ---------- */

  // Phase 29A — gating flag. While the office finishes QA, the Request
  // Time Adjustment button only renders for admins/testers. To open it
  // up to all techs: set window.PHASE29_TIME_ADJUSTMENTS_ENABLED = true
  // in firebase-config.js. Admin / tester emails always see the button
  // for ongoing QA regardless of the flag.
  const PHASE29_TESTER_EMAILS = [
    "nick@pioneercomclean.com",
    "april@pioneercomclean.com",
    "kirby@pioneercomclean.com",
    "mgies@pioneercomclean.com"
  ];
  function phase29ButtonVisibleForCurrentStaff() {
    const email = String((currentStaff && currentStaff.email) || "").toLowerCase().trim();
    if (email && PHASE29_TESTER_EMAILS.indexOf(email) >= 0) return true;
    return window.PHASE29_TIME_ADJUSTMENTS_ENABLED === true;
  }

  // Returns { eligible, sessionId, reasonChip } for the assignment card. The
  // reasonChip is shown when the shift COULD have requested an adjustment but
  // one is already pending (we don't render a chip when there's simply no
  // completed session — that path is the normal Ready/Working state).
  function adjustmentEligibility(a) {
    // Phase 29A — feature flag gate. Non-tester employees see no button
    // and no "pending review" note until the office flips the flag.
    if (!phase29ButtonVisibleForCurrentStaff()) {
      return { eligible: false, sessionId: "", reasonChip: "" };
    }
    const completed = latestCompletedSessionForAssignment(a._id);
    if (!completed) return { eligible: false, sessionId: "", reasonChip: "" };
    // Payroll-locked sessions are off-limits to this V1 flow.
    if (completed.payroll_state === "approved_for_payroll" ||
        completed.payroll_state === "exported" ||
        completed.workweek_locked_by_export === true) {
      return { eligible: false, sessionId: completed._id,
               reasonChip: "Payroll already locked — ask office." };
    }
    // Shift_date must be within today / yesterday / current pay period.
    const shiftDate = String(completed.service_date || a.service_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      return { eligible: false, sessionId: completed._id, reasonChip: "" };
    }
    const todayPT     = pacificDateString();
    const yesterdayPT = addDaysPT(todayPT, -1);
    const period      = getSemiMonthlyPeriod(todayPT);
    const periodStart = period.period_id.endsWith("-A")
      ? (period.month + "-01")
      : (period.month + "-16");
    const allowedStart = (yesterdayPT < periodStart) ? yesterdayPT : periodStart;
    if (shiftDate < allowedStart || shiftDate > todayPT) {
      return { eligible: false, sessionId: completed._id, reasonChip: "" };
    }
    // Already pending request for this shift?
    const key = a._id + "|" + completed._id;
    if (pendingAdjustmentKeys[key]) {
      return { eligible: false, sessionId: completed._id,
               reasonChip: "Time adjustment request pending review." };
    }
    return { eligible: true, sessionId: completed._id, reasonChip: "" };
  }

  // One-time CSS injection. The modal sits above the PTC cards via a
  // fixed overlay; reuses the .ptc-btn typography so it looks at home.
  let timeAdjustmentStylesInjected = false;
  function ensureTimeAdjustmentStyles() {
    if (timeAdjustmentStylesInjected) return;
    timeAdjustmentStylesInjected = true;
    const css = [
      ".ptc-btn-tertiary{background:transparent;color:#2f6dd6;border:1px solid #c9d4ec;box-shadow:none;}",
      ".ptc-btn-tertiary:hover{background:#eef3fb;}",
      ".ptc-adjustment-note{margin:0;padding:8px 12px;font-size:12px;color:#555;background:#f4f6fb;border:1px solid #e2e6ee;border-radius:8px;text-align:center;}",
      ".ptc-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;}",
      ".ptc-modal{background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 30px 60px rgba(0,0,0,0.25);max-height:92vh;display:flex;flex-direction:column;}",
      ".ptc-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #e2e6ee;}",
      ".ptc-modal-head h3{margin:0;font-size:18px;font-weight:700;color:#0f172a;}",
      ".ptc-modal-close{appearance:none;border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#475569;padding:4px 10px;border-radius:8px;}",
      ".ptc-modal-close:hover{background:#f4f6fb;color:#0f172a;}",
      ".ptc-modal-body{padding:18px 22px;overflow:auto;}",
      ".ptc-modal-meta{margin:0 0 14px;font-size:13px;color:#475569;}",
      ".ptc-modal-current{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;background:#f4f6fb;border:1px solid #e2e6ee;border-radius:10px;padding:12px;margin-bottom:18px;}",
      ".ptc-modal-current .cell{display:flex;flex-direction:column;}",
      ".ptc-modal-current .cell label{font-size:11px;font-weight:700;letter-spacing:0.4px;color:#64748b;text-transform:uppercase;}",
      ".ptc-modal-current .cell span{font-size:15px;font-weight:700;color:#0f172a;margin-top:2px;}",
      ".ptc-modal-field{display:flex;flex-direction:column;margin-bottom:14px;}",
      ".ptc-modal-field label{font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;}",
      ".ptc-modal-field input,.ptc-modal-field select,.ptc-modal-field textarea{font:inherit;font-size:15px;padding:10px 12px;border:1px solid #c9d4ec;border-radius:10px;background:#fff;color:#0f172a;width:100%;}",
      ".ptc-modal-field textarea{min-height:80px;resize:vertical;}",
      ".ptc-modal-err{margin:0 0 10px;padding:10px 12px;background:#fee2e2;color:#991b1b;border-radius:10px;font-size:13px;}",
      ".ptc-modal-actions{display:flex;gap:10px;padding:14px 22px 18px;border-top:1px solid #e2e6ee;}",
      ".ptc-modal-actions .ptc-btn{flex:1;}",
      "@media (max-width:480px){.ptc-modal-current{grid-template-columns:1fr 1fr;}.ptc-modal-current .cell:last-child{grid-column:span 2;}}"
    ].join("\n");
    const style = document.createElement("style");
    style.setAttribute("data-pioneer", "time-adjustment-styles");
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Convert a Firestore Timestamp / Date / ms → "YYYY-MM-DDTHH:MM" suitable
  // for an <input type="datetime-local"> default value. Uses the BROWSER's
  // local zone — the Pioneer office is in Pacific so this matches what the
  // tech sees on the card. Returns "" on missing input.
  function tsToLocalInputValue(ts) {
    let ms = null;
    if (!ts) return "";
    if (typeof ts === "number") ms = ts;
    else if (ts.toMillis && typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (ts.seconds != null) ms = ts.seconds * 1000;
    if (ms == null) return "";
    const dt = new Date(ms);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()) +
           "T" + pad(dt.getHours()) + ":" + pad(dt.getMinutes());
  }

  function findSessionInState(assignmentId, sessionId) {
    const list = sessionsByAssignment[assignmentId] || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i]._id === sessionId) return list[i];
    }
    return null;
  }

  function openTimeAdjustmentModal(assignmentId, sessionId) {
    const session = findSessionInState(assignmentId, sessionId);
    if (!session) { alert("Couldn't find that session — refresh and try again."); return; }
    const assignment = assignments.find(function (a) { return a._id === assignmentId; }) || {};
    ensureTimeAdjustmentStyles();

    const currentInStr  = formatTimeShort(session.clock_in_at)  || "—";
    const currentOutStr = formatTimeShort(session.clock_out_at) || "—";
    const currentMin = (typeof session.work_minutes === "number") ? session.work_minutes
      : (session.clock_in_at && session.clock_out_at &&
         session.clock_in_at.toMillis && session.clock_out_at.toMillis
         ? Math.round((session.clock_out_at.toMillis() - session.clock_in_at.toMillis()) / 60000)
         : null);
    const currentTotalStr = (currentMin != null) ? formatMinutesAsHm(currentMin) : "—";

    const customerLabel = assignment.customer_name || session.customer_name || assignment.customer_id || "Customer";
    const locationLabel = assignment.location_name || session.location_address || "";
    const dateLabel     = formatServiceDateLong(session.service_date || assignment.service_date || "");

    const reasonOptions = [
      ["", "Select a reason"],
      ["forgot_clock_in",  "Forgot to clock in"],
      ["forgot_clock_out", "Forgot to clock out"],
      ["app_issue",        "App issue"],
      ["phone_issue",      "Phone issue"],
      ["no_internet",      "No internet"],
      ["emergency",        "Emergency"],
      ["other",            "Other"]
    ];

    const overlay = document.createElement("div");
    overlay.className = "ptc-modal-overlay";
    overlay.setAttribute("data-time-adjustment-modal", "1");
    overlay.innerHTML =
      '<div class="ptc-modal" role="dialog" aria-modal="true" aria-labelledby="ptc-time-adj-title">' +
        '<header class="ptc-modal-head">' +
          '<h3 id="ptc-time-adj-title">Request Time Adjustment</h3>' +
          '<button type="button" class="ptc-modal-close" data-time-adj-close="1" aria-label="Close">×</button>' +
        '</header>' +
        '<div class="ptc-modal-body">' +
          '<p class="ptc-modal-meta">' + escapeHtml(customerLabel) +
            (locationLabel ? ' · ' + escapeHtml(locationLabel) : '') +
            (dateLabel ? ' · ' + escapeHtml(dateLabel) : '') + '</p>' +
          '<div class="ptc-modal-current">' +
            '<div class="cell"><label>Current Clock In</label><span>' + escapeHtml(currentInStr) + '</span></div>' +
            '<div class="cell"><label>Current Clock Out</label><span>' + escapeHtml(currentOutStr) + '</span></div>' +
            '<div class="cell"><label>Current Total</label><span>' + escapeHtml(currentTotalStr) + '</span></div>' +
          '</div>' +
          '<p class="ptc-modal-err" data-time-adj-err hidden></p>' +
          '<div class="ptc-modal-field">' +
            '<label for="ptc-time-adj-in">Requested Clock In</label>' +
            '<input type="datetime-local" id="ptc-time-adj-in" data-time-adj-in required>' +
          '</div>' +
          '<div class="ptc-modal-field">' +
            '<label for="ptc-time-adj-out">Requested Clock Out</label>' +
            '<input type="datetime-local" id="ptc-time-adj-out" data-time-adj-out required>' +
          '</div>' +
          '<div class="ptc-modal-field">' +
            '<label for="ptc-time-adj-reason">Reason</label>' +
            '<select id="ptc-time-adj-reason" data-time-adj-reason required>' +
              reasonOptions.map(function (pair) {
                return '<option value="' + escapeHtml(pair[0]) + '">' + escapeHtml(pair[1]) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="ptc-modal-field">' +
            '<label for="ptc-time-adj-notes">Notes (required)</label>' +
            '<textarea id="ptc-time-adj-notes" data-time-adj-notes required placeholder="What happened? Office uses this to verify."></textarea>' +
          '</div>' +
        '</div>' +
        '<div class="ptc-modal-actions">' +
          '<button type="button" class="ptc-btn ptc-btn-secondary" data-time-adj-close="1">Cancel</button>' +
          '<button type="button" class="ptc-btn ptc-btn-primary" data-time-adj-submit="1">Submit Request</button>' +
        '</div>' +
      '</div>';

    overlay.querySelector("[data-time-adj-in]").value  = tsToLocalInputValue(session.clock_in_at);
    overlay.querySelector("[data-time-adj-out]").value = tsToLocalInputValue(session.clock_out_at);

    // Close on backdrop click or X / Cancel button.
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay || ev.target.closest("[data-time-adj-close]")) {
        document.body.removeChild(overlay);
      }
    });
    overlay.querySelector("[data-time-adj-submit]").addEventListener("click", function () {
      submitTimeAdjustmentFromModal(overlay, assignmentId, sessionId);
    });

    document.body.appendChild(overlay);
    setTimeout(function () { overlay.querySelector("[data-time-adj-in]").focus(); }, 50);
  }

  function showAdjustmentError(overlay, msg) {
    const errEl = overlay.querySelector("[data-time-adj-err]");
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  async function submitTimeAdjustmentFromModal(overlay, assignmentId, sessionId) {
    const submitBtn = overlay.querySelector("[data-time-adj-submit]");
    const errEl = overlay.querySelector("[data-time-adj-err]");
    errEl.hidden = true;

    const inVal     = overlay.querySelector("[data-time-adj-in]").value;
    const outVal    = overlay.querySelector("[data-time-adj-out]").value;
    const reasonVal = overlay.querySelector("[data-time-adj-reason]").value;
    const notesVal  = overlay.querySelector("[data-time-adj-notes]").value.trim();

    if (!inVal || !outVal) { showAdjustmentError(overlay, "Both requested clock-in and clock-out are required."); return; }
    if (!reasonVal)        { showAdjustmentError(overlay, "Pick a reason from the dropdown."); return; }
    if (!notesVal)         { showAdjustmentError(overlay, "Notes are required — tell the office what happened."); return; }

    const inMs  = new Date(inVal).getTime();
    const outMs = new Date(outVal).getTime();
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
      showAdjustmentError(overlay, "Requested clock times are invalid."); return;
    }
    if (outMs <= inMs) {
      showAdjustmentError(overlay, "Requested clock out must be after requested clock in."); return;
    }

    const url = (window.CREATE_TIME_ADJUSTMENT_REQUEST_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      showAdjustmentError(overlay, "CREATE_TIME_ADJUSTMENT_REQUEST_URL is not configured. Contact the office.");
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Submitting…";
    try {
      const user = firebase.auth().currentUser;
      if (!user) throw new Error("Not signed in.");
      const idToken = await user.getIdToken();
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id:        assignmentId,
          service_session_id:   sessionId,
          requested_clock_in:   new Date(inMs).toISOString(),
          requested_clock_out:  new Date(outMs).toISOString(),
          reason:               reasonVal,
          notes:                notesVal
        })
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body || !body.ok) {
        throw new Error((body && body.error) || ("HTTP " + res.status));
      }
      // Mark this key as blocked so the button hides without a full reload,
      // then close the modal and re-render cards.
      pendingAdjustmentKeys[assignmentId + "|" + sessionId] = body.request_id || "pending";
      document.body.removeChild(overlay);
      renderAssignments();
      alert("Time adjustment request submitted. The office will review it.");
    } catch (err) {
      warnSC("submitTimeAdjustment failed", err && err.message);
      showAdjustmentError(overlay, (err && err.message) || "Submit failed.");
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  /* ---------- UI utility states ---------- */

  function showSection() {
    const section = $("pioneer-time-clock-section");
    if (section) section.hidden = false;
  }

  // UI cleanup 2026-06-02 — toggleLegacyFallbackBanner() removed.
  // The #ptc-legacy-fallback-banner DOM was inside the deleted
  // legacy Today's Work section in work.html, and the banner's
  // "use Start Work below" instruction no longer has a target.

  function renderIndexBuildingError() {
    const root = $("ptc-assignments");
    if (!root) return;
    root.innerHTML =
      '<div class="ptc-status ptc-status-warn">' +
        '<p><strong>Pioneer Time Clock is finalizing setup.</strong></p>' +
        '<p>Refresh in a moment. (Firestore indexes still building.)</p>' +
      '</div>';
  }

  function renderFatalError(err) {
    const root = $("ptc-assignments");
    if (!root) return;
    const msg = (err && err.message) || (err && String(err)) || "Unknown error";
    // UI cleanup 2026-06-02 — legacy Today's Work fallback removed;
    // error copy points techs to office support instead of "Deputy
    // below".
    root.innerHTML =
      '<div class="ptc-status ptc-status-error">' +
        '<p><strong>Couldn\'t load Pioneer Time Clock.</strong></p>' +
        '<p>' + escapeHtml(msg) + '</p>' +
        '<p>Hard-reload (Cmd+Shift+R). If it persists, contact the office.</p>' +
      '</div>';
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    wireClicks();
    bootWhenAuthReady();
  });
}());
