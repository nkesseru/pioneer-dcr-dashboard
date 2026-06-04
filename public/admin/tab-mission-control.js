/* Pioneer DCR Hub — Admin PioneerOps Mission Control (Phase 31).
 *
 * Replaces the leading-with-DCR-email-metrics design of the admin
 * landing page with a 6-card operational snapshot oriented around what
 * actually matters at shift-rollout time: shifts → DCRs → clock issues
 * → supply → readiness → payroll exceptions.
 *
 * Ops day window: Yesterday 4 PM → Today 4 PM Pacific (matches the
 * existing getOpsDayWindow() helper in admin/_utils.js so everything
 * lines up with the rest of the admin surface). 4 PM cutoff aligns
 * with Pioneer's night-shift cadence — most clock-ins happen after
 * 4 PM, so a midnight-to-midnight window would split tonight's work
 * across two reports.
 *
 * Read-only — never writes anywhere from this surface. Six parallel
 * Firestore reads, then client-side classification.
 *
 * Each card has three color states:
 *   GREEN  — clean (zero blockers)
 *   YELLOW — needs review but operations continue
 *   RED    — action required
 *
 * Cards click-through to the most relevant existing tab via
 * shell.activateTab(). When the right tab doesn't yet exist (Readiness
 * doesn't have a dedicated tab) the click routes to the closest
 * adjacent tab (Schedule, which carries the Deputy bridge controls).
 *
 * Exports window.__pioneerAdmin.tabs.missionControl: { init, refresh }.
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-mission-control.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString, addDaysPacific, getOpsDayWindow,
          getActive, getDcrEnabled, getDcrEmailEnabled } = window.__pioneerAdmin.utils;
  const { activateTab } = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let loading = false;
  let loaded  = false;
  let lastSnapshot = null;
  let stylesInjected = false;

  /* ---------- helpers ---------- */

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }

  function fmtOpsDayLabel(opsWindow) {
    if (!opsWindow) return "—";
    try {
      const startStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hour12: true
      }).format(new Date(opsWindow.currentOpsStart));
      const endStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hour12: true
      }).format(new Date(opsWindow.currentOpsEnd));
      return startStr + " → " + endStr + " Pacific";
    } catch (_e) {
      return opsWindow.opsDayLabel || "—";
    }
  }

  /* ---------- core read ---------- */

  // Single parallel fetch for the snapshot. Each piece is best-effort;
  // a single failed read degrades that one card to "—" rather than
  // breaking the whole panel.
  async function loadSnapshot() {
    const db = firebase.firestore();
    const now = Date.now();
    const opsWindow = getOpsDayWindow(new Date(now));
    const todayPT     = pacificDateString();
    const yesterdayPT = addDaysPacific(todayPT, -1);
    const tomorrowPT  = addDaysPacific(todayPT,  1);

    // Two-day calendar window for the ops day (covers the 4PM→4PM
    // split). Sessions / assignments are queried by service_date in
    // [yesterdayPT, todayPT]; we then filter client-side by timestamp
    // against opsWindow when needed.
    const opsDateLo = yesterdayPT;
    const opsDateHi = todayPT;

    function safe(label, p) {
      return p.then(
        (val) => ({ ok: true, val }),
        (err) => ({ ok: false, err: (err && err.message) || String(err), label: label })
      );
    }

    const reads = await Promise.all([
      // 0. service_assignments in ops-day calendar window
      safe("assignments", db.collection("service_assignments")
        .where("service_date", ">=", opsDateLo)
        .where("service_date", "<=", opsDateHi)
        .get()),
      // 1. pioneer_service_sessions in ops-day calendar window
      safe("sessions", db.collection("pioneer_service_sessions")
        .where("service_date", ">=", opsDateLo)
        .where("service_date", "<=", opsDateHi)
        .get()),
      // 2. ALL active sessions globally (very small collection)
      safe("active_sessions", db.collection("active_service_sessions").get()),
      // 3. supply_requests — full read, filter client-side (small set)
      safe("supply", db.collection("supply_requests").get()),
      // 4. customers — already cached but admin tab may not have hydrated yet
      safe("customers", db.collection("customers").get()),
      // 5. cleaning_techs — same
      safe("techs", db.collection("cleaning_techs").get()),
      // 6. time_adjustment_requests where status == "pending"
      safe("time_adj", db.collection("time_adjustment_requests")
        .where("status", "==", "pending").get()),
      // 7. deputy_shift_cache for tonight + tomorrow (Readiness card)
      safe("deputy_tonight", db.collection("deputy_shift_cache")
        .where("sync_date", "==", todayPT).get()),
      safe("deputy_tomorrow", db.collection("deputy_shift_cache")
        .where("sync_date", "==", tomorrowPT).get())
    ]);

    function docs(idx) {
      const r = reads[idx];
      if (!r.ok) return null;          // null signals "read failed"
      return r.val.docs.map(d => Object.assign({ _id: d.id }, d.data() || {}));
    }
    function failures() {
      return reads.filter(r => !r.ok).map(r => r.label + ": " + r.err);
    }

    return {
      now:           now,
      opsWindow:     opsWindow,
      todayPT:       todayPT,
      yesterdayPT:   yesterdayPT,
      tomorrowPT:    tomorrowPT,
      assignments:   docs(0),
      sessions:      docs(1),
      activeSess:    docs(2),
      supply:        docs(3),
      customers:     docs(4),
      techs:         docs(5),
      timeAdj:       docs(6),
      deputyTonight: docs(7),
      deputyTomorrow:docs(8),
      failedReads:   failures()
    };
  }

  /* ---------- classification ---------- */

  // Phase 29A QA filter — keeps seed records out of every card.
  function isQaTestSession(s) {
    return !!(s && (s.is_test === true ||
                    s.exclude_from_payroll_export === true ||
                    s.excluded_from_payroll === true));
  }
  function isQaTestAssignment(a) {
    return !!(a && (a.is_test === true || a.exclude_from_payroll_export === true));
  }

  function buildCards(snap) {
    const cards = {};

    /* ---- (a) Shift Coverage ---- */
    if (!snap.assignments || !snap.sessions) {
      cards.shifts = errorCard("Shifts", "Couldn't read assignments/sessions.");
    } else {
      const assignments = snap.assignments.filter(a => !isQaTestAssignment(a)
        && a.status !== "admin_removed" && a.removed_from_ptc !== true);
      const sessions = snap.sessions.filter(s => !isQaTestSession(s));
      // Group sessions by assignment_id
      const sessionsByAsgn = {};
      sessions.forEach(s => {
        if (!s.assignment_id) return;
        (sessionsByAsgn[s.assignment_id] = sessionsByAsgn[s.assignment_id] || []).push(s);
      });
      let started = 0, completed = 0, missed = 0;
      assignments.forEach(a => {
        const list = sessionsByAsgn[a._id] || [];
        if (list.some(s => s.status === "completed")) {
          completed++;
          started++;
        } else if (list.length > 0) {
          started++;
        } else if (a.service_date && a.service_date < snap.todayPT) {
          // Calendar date is in the past — and no sessions ever opened.
          missed++;
        }
      });
      const total = assignments.length;
      const severity = missed > 0 ? "RED" : (completed === total ? "GREEN" : "YELLOW");
      cards.shifts = {
        title:    "Shifts",
        primary:  total + " assigned",
        secondary: started + " started · " + completed + " completed" + (missed > 0 ? " · " + missed + " missed" : ""),
        severity: severity,
        route:    "labor-review"
      };
    }

    /* ---- (b) DCR Health (sessions side — submitted vs pending) ---- */
    if (!snap.sessions) {
      cards.dcrs = errorCard("DCRs", "Couldn't read sessions.");
    } else {
      const completedSessions = snap.sessions
        .filter(s => !isQaTestSession(s) && s.status === "completed");
      let submitted = 0, missing = 0;
      completedSessions.forEach(s => {
        const has = (s.dcr_status === "submitted") || !!s.dcr_id || !!s.dcr_submission_id;
        if (has) submitted++; else missing++;
      });
      const severity = missing > 0 ? "YELLOW" : (submitted === 0 ? "GREEN" : "GREEN");
      cards.dcrs = {
        title:    "DCRs",
        primary:  submitted + " submitted",
        secondary: missing > 0 ? (missing + " missing") : "0 missing",
        severity: severity,
        route:    "issues"
      };
    }

    /* ---- (c) Clock Issues (paused + stuck active sessions) ---- */
    if (!snap.sessions || !snap.activeSess) {
      cards.clockIssues = errorCard("Clock Issues", "Couldn't read sessions.");
    } else {
      // Stuck active: an active_service_sessions doc whose clock_in_at is
      // older than the ops-day start (i.e. been clocked in > ~24h).
      const opsStart = snap.opsWindow && snap.opsWindow.currentOpsStart;
      let paused = 0, stuckActive = 0;
      snap.sessions.forEach(s => {
        if (isQaTestSession(s)) return;
        if (s.status === "paused") paused++;
      });
      snap.activeSess.forEach(a => {
        const inMs = tsToMs(a.clock_in_at);
        if (inMs && opsStart && inMs < opsStart) stuckActive++;
      });
      const severity = stuckActive > 0 ? "RED" : (paused > 0 ? "YELLOW" : "GREEN");
      cards.clockIssues = {
        title:    "Clock Issues",
        primary:  (paused + stuckActive) + " issue" + ((paused + stuckActive) === 1 ? "" : "s"),
        secondary: paused + " paused · " + stuckActive + " stuck active",
        severity: severity,
        route:    "labor-review"
      };
    }

    /* ---- (d) Supply + Field Requests ---- */
    if (!snap.supply) {
      cards.supply = errorCard("Supply", "Couldn't read supply_requests.");
    } else {
      const open = snap.supply.filter(r => (r.status || "new") !== "closed");
      const opsStart = snap.opsWindow && snap.opsWindow.currentOpsStart;
      const opsEnd   = snap.opsWindow && snap.opsWindow.currentOpsEnd;
      const newInOpsDay = open.filter(r => {
        const ms = tsToMs(r.created_at || r.createdAt);
        return ms && opsStart && opsEnd && ms >= opsStart && ms <= opsEnd;
      });
      const severity = open.length === 0 ? "GREEN" : (open.length > 5 ? "YELLOW" : "GREEN");
      cards.supply = {
        title:    "Supply",
        primary:  open.length + " open",
        secondary: newInOpsDay.length + " new in ops day",
        severity: severity,
        route:    "supply"
      };
    }

    /* ---- (e) Tonight Readiness — count GREEN/YELLOW/RED for tonight+tmrw Deputy shifts ---- */
    if (!snap.deputyTonight || !snap.deputyTomorrow || !snap.assignments || !snap.customers || !snap.techs) {
      cards.readiness = errorCard("Readiness", "Couldn't compute readiness.");
    } else {
      const deputyShifts = (snap.deputyTonight || []).concat(snap.deputyTomorrow || []);
      const techsByEmail = {};
      snap.techs.forEach(t => { if (t.email) techsByEmail[String(t.email).toLowerCase()] = t; });
      const custsBySlug = {};
      snap.customers.forEach(c => { custsBySlug[c._id] = c; });
      const asgnById = {};
      snap.assignments.forEach(a => { asgnById[a._id] = a; });
      let green = 0, yellow = 0, red = 0;
      deputyShifts.forEach(s => {
        if (String(s.status || "").toLowerCase() === "cancelled") return;
        let severity = "GREEN";
        if (!s.customer_slug)            severity = "RED";
        else if (!s.employee_email)      severity = "RED";
        else {
          const tech = techsByEmail[String(s.employee_email).toLowerCase()];
          if (!tech || tech.active === false) severity = "RED";
          else {
            const aid = "sa_deputy__" + s.shift_id;
            const a = asgnById[aid];
            if (!a) severity = "RED";
            else if (a.removed_from_ptc === true || a.status === "admin_removed") severity = "YELLOW";
          }
        }
        if      (severity === "RED")    red++;
        else if (severity === "YELLOW") yellow++;
        else                            green++;
      });
      const overall = red > 0 ? "RED" : (yellow > 0 ? "YELLOW" : "GREEN");
      cards.readiness = {
        title:    "Readiness",
        primary:  green + " green",
        secondary: yellow + " yellow · " + red + " red",
        severity: overall,
        route:    "schedule"
      };
    }

    /* ---- (f) Payroll Exceptions (pending count) ---- */
    if (!snap.timeAdj) {
      cards.payrollExceptions = errorCard("Payroll Exceptions", "Couldn't read requests.");
    } else {
      const pending = snap.timeAdj.length;
      cards.payrollExceptions = {
        title:    "Payroll Exceptions",
        primary:  pending + " pending",
        secondary: pending === 0 ? "All clear" : "Awaiting review",
        severity: pending > 0 ? "YELLOW" : "GREEN",
        route:    "payroll-exceptions"
      };
    }

    /* ---- (g) Employee Exceptions side panel (techs missing uid / skipped bridge) ---- */
    let employeeNote = "";
    if (snap.techs && snap.assignments && snap.deputyTonight && snap.deputyTomorrow) {
      const activeNoUid = snap.techs.filter(t => t.active !== false && !t.uid).length;
      const deputyShifts = (snap.deputyTonight || []).concat(snap.deputyTomorrow || []);
      const asgnById = {};
      snap.assignments.forEach(a => { asgnById[a._id] = a; });
      const skipped = deputyShifts.filter(s => {
        if (String(s.status || "").toLowerCase() === "cancelled") return false;
        return !asgnById["sa_deputy__" + s.shift_id];
      }).length;
      employeeNote = activeNoUid + " active tech" + (activeNoUid === 1 ? "" : "s") +
                     " w/o sign-in · " + skipped + " Deputy bridge skip" + (skipped === 1 ? "" : "s");
    }

    /* ---- (h) Customer / Location readiness side note ---- */
    let customerNote = "";
    if (snap.customers) {
      const active = snap.customers.filter(c => getActive(c));
      const dcrOff = active.filter(c => getDcrEnabled(c) === false).length;
      const dcrMissing = active.filter(c => typeof c.dcr_enabled === "undefined").length;
      const noGeo = active.filter(c => c.location_lat == null || c.location_lon == null).length;
      customerNote = dcrOff + " DCR off · " + dcrMissing + " DCR flag unset · " + noGeo + " ungeofenced";
    }

    return {
      cards: cards,
      employeeNote: employeeNote,
      customerNote: customerNote,
      failedReads:  snap.failedReads
    };
  }

  function errorCard(title, msg) {
    return {
      title:    title,
      primary:  "—",
      secondary: msg,
      severity: "YELLOW",
      route:    null
    };
  }

  /* ---------- render ---------- */

  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = [
      "#mission-control{margin-bottom:18px;padding:18px 22px;background:linear-gradient(180deg,#0f172a 0%,#111c33 100%);color:#e6edf7;border-radius:14px;box-shadow:0 6px 24px rgba(15,23,42,0.18);}",
      "#mission-control .mc-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;gap:12px;flex-wrap:wrap;}",
      "#mission-control .mc-eyebrow{display:block;font-size:11.5px;font-weight:800;letter-spacing:0.6px;color:#7ea3d6;text-transform:uppercase;}",
      "#mission-control .mc-title{margin:2px 0 0;font-size:20px;font-weight:800;color:#fff;}",
      "#mission-control .mc-window{margin:4px 0 0;font-size:13px;color:#a8c0e1;}",
      "#mission-control .mc-refresh{appearance:none;background:rgba(255,255,255,0.08);color:#e6edf7;border:1px solid rgba(255,255,255,0.18);padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;}",
      "#mission-control .mc-refresh:hover{background:rgba(255,255,255,0.14);}",
      "#mission-control .mc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;}",
      "#mission-control .mc-card{appearance:none;text-align:left;display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:inherit;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,transform 90ms ease;font:inherit;}",
      "#mission-control .mc-card:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.18);}",
      "#mission-control .mc-card:active{transform:translateY(1px);}",
      "#mission-control .mc-card[data-route='']{cursor:default;}",
      "#mission-control .mc-card-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:middle;}",
      "#mission-control .mc-card[data-severity='GREEN']  .mc-card-dot{background:#22c55e;}",
      "#mission-control .mc-card[data-severity='YELLOW'] .mc-card-dot{background:#facc15;}",
      "#mission-control .mc-card[data-severity='RED']    .mc-card-dot{background:#ef4444;}",
      "#mission-control .mc-card[data-severity='GREEN']  {border-left:3px solid #22c55e;}",
      "#mission-control .mc-card[data-severity='YELLOW'] {border-left:3px solid #facc15;}",
      "#mission-control .mc-card[data-severity='RED']    {border-left:3px solid #ef4444;}",
      "#mission-control .mc-card-label{font-size:11.5px;font-weight:700;letter-spacing:0.5px;color:#a8c0e1;text-transform:uppercase;}",
      "#mission-control .mc-card-primary{font-size:18px;font-weight:800;color:#fff;}",
      "#mission-control .mc-card-secondary{font-size:12px;color:#cdd9ec;}",
      "#mission-control .mc-side-notes{display:flex;flex-wrap:wrap;gap:14px 22px;margin-top:12px;font-size:12px;color:#a8c0e1;}",
      "#mission-control .mc-side-note{display:flex;flex-direction:column;}",
      "#mission-control .mc-side-note-label{font-size:10.5px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#7ea3d6;}",
      "#mission-control .mc-side-note-value{color:#e6edf7;}",
      "#mission-control .mc-warnings{margin-top:10px;padding:8px 12px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.45);color:#fecaca;border-radius:8px;font-size:12px;}"
    ].join("\n");
    const tag = document.createElement("style");
    tag.setAttribute("data-pioneer", "mission-control-styles");
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function render(model) {
    ensureStyles();
    const root = $("mission-control");
    if (!root) return;
    const cards = model.cards;
    const order = ["shifts", "dcrs", "clockIssues", "supply", "readiness", "payrollExceptions"];

    const cardHtml = order.map(key => {
      const c = cards[key];
      if (!c) return "";
      return (
        '<button type="button" class="mc-card" ' +
          'data-severity="' + escapeHtml(c.severity) + '" ' +
          'data-route="' + escapeHtml(c.route || "") + '" ' +
          'data-mc-card="' + escapeHtml(key) + '">' +
          '<span class="mc-card-label"><span class="mc-card-dot"></span>' + escapeHtml(c.title) + '</span>' +
          '<span class="mc-card-primary">' + escapeHtml(c.primary) + '</span>' +
          '<span class="mc-card-secondary">' + escapeHtml(c.secondary) + '</span>' +
        '</button>'
      );
    }).join("");

    const sideNotes =
      (model.employeeNote ? renderSideNote("Employee Exceptions", model.employeeNote) : "") +
      (model.customerNote ? renderSideNote("Customer Readiness",   model.customerNote) : "");

    const warnings = (model.failedReads && model.failedReads.length)
      ? '<div class="mc-warnings">⚠ ' + escapeHtml(model.failedReads.length + " read(s) failed: " + model.failedReads.join("; ")) + '</div>'
      : "";

    root.innerHTML =
      '<header class="mc-head">' +
        '<div>' +
          '<span class="mc-eyebrow">Mission Control</span>' +
          '<h2 class="mc-title">PioneerOps</h2>' +
          '<p class="mc-window">Ops Day · ' + escapeHtml(fmtOpsDayLabel(lastSnapshot && lastSnapshot.opsWindow)) + '</p>' +
        '</div>' +
        '<button type="button" class="mc-refresh" id="mission-control-refresh">Refresh</button>' +
      '</header>' +
      '<div class="mc-grid">' + cardHtml + '</div>' +
      (sideNotes ? '<div class="mc-side-notes">' + sideNotes + '</div>' : "") +
      warnings;
  }

  function renderSideNote(label, value) {
    return (
      '<div class="mc-side-note">' +
        '<span class="mc-side-note-label">' + escapeHtml(label) + '</span>' +
        '<span class="mc-side-note-value">' + escapeHtml(value) + '</span>' +
      '</div>'
    );
  }

  function renderLoading() {
    ensureStyles();
    const root = $("mission-control");
    if (!root) return;
    root.innerHTML =
      '<header class="mc-head">' +
        '<div>' +
          '<span class="mc-eyebrow">Mission Control</span>' +
          '<h2 class="mc-title">PioneerOps</h2>' +
          '<p class="mc-window">Loading ops-day snapshot…</p>' +
        '</div>' +
      '</header>';
  }

  function renderError(err) {
    ensureStyles();
    const root = $("mission-control");
    if (!root) return;
    root.innerHTML =
      '<header class="mc-head">' +
        '<div>' +
          '<span class="mc-eyebrow">Mission Control</span>' +
          '<h2 class="mc-title">PioneerOps</h2>' +
          '<p class="mc-window">Couldn\'t load: ' + escapeHtml(err) + '</p>' +
        '</div>' +
        '<button type="button" class="mc-refresh" id="mission-control-refresh">Retry</button>' +
      '</header>';
  }

  /* ---------- public API ---------- */

  async function refresh() {
    if (loading) return;
    loading = true;
    if (!loaded) renderLoading();
    try {
      const snap = await loadSnapshot();
      lastSnapshot = snap;
      const model  = buildCards(snap);
      render(model);
      loaded = true;
    } catch (err) {
      console.error("[mission-control] load failed", err);
      renderError((err && err.message) || "unknown");
    } finally {
      loading = false;
    }
  }

  function wireClicks() {
    document.addEventListener("click", function (ev) {
      const refreshBtn = ev.target.closest("#mission-control-refresh");
      if (refreshBtn) { refresh(); return; }
      const card = ev.target.closest("#mission-control .mc-card");
      if (!card) return;
      const route = card.getAttribute("data-route");
      if (!route) return;
      try { activateTab(route); }
      catch (_e) { /* swallow — route may not exist yet */ }
    });
  }

  function init() {
    wireClicks();
  }

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.missionControl = {
    init:    init,
    refresh: refresh
  };
}());
