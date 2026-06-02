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
  let currentStatusFilter  = "all";   // "all" | "needs_review" | "dcr_pending" | "archived"
  let displaySessions      = [];      // filtered subset of `sessions`

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

  // Initial range state — used by the very first refresh() to query before
  // the user has touched any control. Defaults to today/today (Pacific).
  function ensureRangeInitialized() {
    if (rangeStart && rangeEnd) return;
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
    if (typeof s.work_minutes !== "number") return false;
    return s.work_minutes > budget + 15;
  }
  function offsiteFlag(s) {
    return s && (s.clock_in_geo_status === "offsite" || s.clock_out_geo_status === "offsite");
  }
  function adminRemovedFlag(s) { return s && s.admin_removed === true; }
  function forceClosedFlag(s) { return s && s.force_closed_by_admin === true; }

  // Phase 2A.4 — status filter. "all" excludes archived; "archived" shows
  // ONLY archived. The 0-of-3 non-archived filters share the
  // not-archived gate so admin never accidentally lumps archived rows
  // into the active review queue.
  function passesStatusFilter(s) {
    const isArchived = adminRemovedFlag(s);
    switch (currentStatusFilter) {
      case "archived":     return isArchived;
      case "needs_review": return !isArchived && needsReviewFlag(s);
      case "dcr_pending":  return !isArchived && dcrPendingFlag(s);
      case "all":
      default:             return !isArchived;
    }
  }
  function filterSessions(arr) { return (arr || []).filter(passesStatusFilter); }

  // Centralized re-derive of the filtered subset + downstream caches.
  // Called both at end of refresh() and on every status-filter click —
  // the click path skips Firestore entirely (data is already loaded).
  function recomputeDisplay() {
    displaySessions = filterSessions(sessions);
    totalsCache     = computeTotals(displaySessions);
    byEmployeeCache = groupByEmployee(displaySessions);
  }

  function computeTotals(arr) {
    const out = {
      totalWorked: 0, totalRunning: 0, needsReview: 0, dcrPending: 0,
      exceptions: { overBudget: 0, offsite: 0, adminRemoved: 0, forceClosed: 0 }
    };
    (arr || []).forEach(function (s) {
      const assignment = s.assignment_id ? assignmentsById[s.assignment_id] : null;
      if (isRunningSession(s)) {
        out.totalRunning += (liveElapsedMinutes(s.clock_in_at) || 0);
      } else if (typeof s.work_minutes === "number") {
        out.totalWorked += s.work_minutes;
      }
      if (needsReviewFlag(s))   out.needsReview += 1;
      if (dcrPendingFlag(s))    out.dcrPending  += 1;
      if (overBudgetFlag(s, assignment)) out.exceptions.overBudget   += 1;
      if (offsiteFlag(s))                out.exceptions.offsite      += 1;
      if (adminRemovedFlag(s))           out.exceptions.adminRemoved += 1;
      if (forceClosedFlag(s))            out.exceptions.forceClosed  += 1;
    });
    return out;
  }
  function groupByEmployee(arr) {
    const map = new Map();
    (arr || []).forEach(function (s) {
      const key = s.staff_uid || ("email:" + (s.staff_email || "")) || "(unknown)";
      if (!map.has(key)) {
        map.set(key, {
          staff_uid: s.staff_uid || "",
          staff_email: s.staff_email || "",
          name: techName(s.staff_email, s.staff_uid),
          sessions_count: 0,
          worked_minutes: 0,
          running_minutes: 0,
          needs_review: 0,
          dcr_pending: 0
        });
      }
      const row = map.get(key);
      row.sessions_count += 1;
      if (isRunningSession(s)) {
        row.running_minutes += (liveElapsedMinutes(s.clock_in_at) || 0);
      } else if (typeof s.work_minutes === "number") {
        row.worked_minutes += s.work_minutes;
      }
      if (needsReviewFlag(s)) row.needs_review += 1;
      if (dcrPendingFlag(s))  row.dcr_pending  += 1;
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
    renderTotals();
    renderActive();
    renderByEmployee();
    renderTable();
  }

  // Phase 2A.2 regression instrumentation — visible build marker so admin
  // can confirm in one glance which code path is actually rendering the
  // Labor panel. Bumped any time the table render path changes.
  const LABOR_BUILD_TAG = "Labor v2A.4-exceptions";

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
      '<span title="work_minutes > budget + 15">OB ' + ex.overBudget + '</span> · ' +
      '<span title="clock_in or clock_out offsite">OS ' + ex.offsite + '</span> · ' +
      '<span title="admin_removed = true">AR ' + ex.adminRemoved + '</span> · ' +
      '<span title="force_closed_by_admin">FC ' + ex.forceClosed + '</span>';
    wrap.innerHTML =
      tile("Sessions",     String(sessions.length), null) +
      tile("Worked",       fmtMinutes(t.totalWorked),  null) +
      tile("Running",      fmtMinutes(t.totalRunning), t.totalRunning > 0 ? '<span class="labor-tile-running-dot" aria-hidden="true">●</span> live' : null) +
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
      const totalMin = r.worked_minutes + r.running_minutes;
      const runningChip = r.running_minutes > 0
        ? ' <span class="labor-be-running">+ running ' + escapeHtml(fmtMinutes(r.running_minutes)) + '</span>'
        : '';
      const flags = [];
      if (r.needs_review > 0) flags.push('<span class="labor-be-flag is-review">' + r.needs_review + ' needs review</span>');
      if (r.dcr_pending  > 0) flags.push('<span class="labor-be-flag is-dcr">' + r.dcr_pending + ' DCR pending</span>');
      return (
        '<div class="labor-be-row">' +
          '<div class="labor-be-name">' + escapeHtml(r.name) + '</div>' +
          '<div class="labor-be-count">' + r.sessions_count + ' session' +
            (r.sessions_count === 1 ? "" : "s") + '</div>' +
          '<div class="labor-be-time">' +
            escapeHtml(fmtMinutes(r.worked_minutes)) + ' worked' + runningChip +
          '</div>' +
          '<div class="labor-be-flags">' + flags.join(" ") + '</div>' +
        '</div>'
      );
    }).join("");
  }

  function renderActive() {
    const list  = $("labor-active-list");
    const empty = $("labor-active-empty");
    if (!list || !empty) return;
    const uids = Object.keys(activeByUid);
    if (!uids.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
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
  function sessionStatusDisplay(s) {
    const base = statusChip(s.status, needsReviewFlag(s));
    return (s && s.admin_removed === true) ? (removedChip() + " " + base) : base;
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
      let workedLabel;
      let workedClass = "";
      if (isRunning) {
        workedLabel = "Running " + fmtMinutes(elapsed != null ? elapsed : 0);
      } else if (isPausedRow) {
        const fallback = (s.work_minutes != null) ? s.work_minutes : elapsed;
        workedLabel = "Paused " + fmtMinutes(fallback != null ? fallback : 0);
      } else if (isTerminalZero) {
        workedLabel = "Review Required";
        workedClass = " is-review-required";
      } else if (s.work_minutes != null) {
        workedLabel = fmtMinutes(s.work_minutes);
      } else {
        workedLabel = "—";
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
      const archiveBtn = (s.assignment_id && s.admin_removed !== true)
        ? '<button type="button" class="labor-btn labor-btn-remove" data-act="remove-from-ptc">Archive</button>'
        : '';
      const actionCellContent = (reviewBtn + linkDcrBtn + archiveBtn) ||
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
          '<div class="lr-col-date">' + escapeHtml(fmtServiceDate(s.service_date)) + '</div>' +
          '<div class="lr-col-emp">' + escapeHtml(techName(s.staff_email, s.staff_uid)) + '</div>' +
          '<div class="lr-col-cust">' + escapeHtml(customerLabel(s, assignment)) + '</div>' +
          '<div class="lr-col-status">' + sessionStatusDisplay(s) + '</div>' +
          '<div class="lr-col-in">' + escapeHtml(fmtTime(s.clock_in_at)) + '</div>' +
          '<div class="lr-col-out">' + escapeHtml(fmtTime(s.clock_out_at)) + '</div>' +
          '<div class="lr-col-wkd' + workedClass + '">' + escapeHtml(workedLabel) + '</div>' +
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
    await firebase.firestore().collection("pioneer_service_sessions").doc(sessionId).update({
      needs_review: false,
      reviewed_at:  firebase.firestore.FieldValue.serverTimestamp(),
      reviewed_by:  actor
    });
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
    });

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
        const startEl = $("labor-range-start"); if (startEl) startEl.value = rangeStart;
        const endEl   = $("labor-range-end");   if (endEl)   endEl.value   = rangeEnd;
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
        if (loaded) {
          recomputeDisplay();
          render();
        }
      });
    });
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
      refresh();
    });
  }

  /* ---------- export surface ---------- */

  function init() {
    wire();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.laborReview = {
    init:    init,
    refresh: refresh
  };
}());
