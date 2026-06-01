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

  /* ---------- auth resolution + first load ---------- */

  function bootWhenAuthReady() {
    // Poll for STAFF_AUTH to publish a signed-in tech. The existing work.html
    // pattern: staff-auth.js resolves auth, then today-work.js polls for
    // getCachedStaff. We use the same approach — no need to subscribe to
    // a new event.
    let attempts = 0;
    const interval = setInterval(function () {
      attempts += 1;
      const staff = window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
        ? window.STAFF_AUTH.getCachedStaff() : null;
      if (staff && staff.uid) {
        clearInterval(interval);
        currentStaff = staff;
        logSC("staff resolved", { uid: staff.uid, email: staff.email });
        initialLoad().catch(function (err) {
          warnSC("initial load failed", err && err.message);
          renderFatalError(err);
        });
        return;
      }
      if (attempts > 240) {  // ~60s @ 250ms — give up if no sign-in
        clearInterval(interval);
        logSC("no signed-in staff after 60s — service clock stays hidden");
      }
    }, 250);
  }

  async function initialLoad() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      throw new Error("Firebase Firestore SDK not loaded");
    }
    const db       = firebase.firestore();
    const todayPT  = pacificDateString();
    const periodId = getSemiMonthlyPeriod(todayPT).period_id;

    // Show the section frame immediately (with a loading state inside).
    showSection();
    setAssignmentsLoading();

    // Parallel reads. We catch the assignments query separately because
    // it's the one that needs a composite index — may fail with a
    // friendly "still building" error in the first few minutes after a
    // fresh deploy.
    const tasks = [
      db.collection("service_assignments")
        .where("staff_uid",    "==", currentStaff.uid)
        .where("service_date", "==", todayPT)
        .orderBy("service_date", "desc")
        .get()
        .then(function (snap) {
          assignments = snap.docs.map(function (d) {
            return Object.assign({ _id: d.id }, d.data());
          });
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
        .then(function (s) { balanceDoc = s.exists ? s.data() : null; })
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

    renderBalanceCard();
    renderAssignments();
  }

  /* ---------- render: balance card ---------- */

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
      root.innerHTML =
        '<div class="ptc-empty">' +
          '<p><strong>No Pioneer service stops assigned for today.</strong></p>' +
          '<p>Check the Deputy section below for any legacy shifts.</p>' +
        '</div>';
      return;
    }
    root.innerHTML = assignments.map(assignmentCard).join("");
  }

  // Compute live UI state from the active-session lookup (NOT from
  // assignment.status — that field is admin-managed and may lag).
  function deriveDisplayState(a) {
    if (activeSession && activeSession.assignment_id === a._id) return "in_progress";
    if (a.status === "completed") return "completed";
    if (a.status === "missed" || a.status === "canceled") return a.status;
    return "ready";
  }

  function statusChip(state) {
    const map = {
      "ready":       { cls: "is-ready",     label: "Ready" },
      "in_progress": { cls: "is-active",    label: "Clocked in" },
      "completed":   { cls: "is-done",      label: "Completed" },
      "missed":      { cls: "is-missed",    label: "Missed" },
      "canceled":    { cls: "is-canceled",  label: "Canceled" }
    };
    const m = map[state] || map.ready;
    return '<span class="ptc-status-chip ' + m.cls + '">' + m.label + '</span>';
  }

  function assignmentCard(a) {
    const state = deriveDisplayState(a);
    const blockedByOther = !!(activeSession && activeSession.assignment_id !== a._id);

    let ctaHtml;
    if (state === "in_progress") {
      ctaHtml = '<button type="button" class="ptc-btn ptc-btn-stop" ' +
                'data-action="clock-out" data-assignment-id="' + escapeHtml(a._id) + '">Clock Out</button>';
    } else if (state === "completed") {
      ctaHtml = '<button type="button" class="ptc-btn ptc-btn-done" disabled>Completed</button>';
    } else if (state === "missed" || state === "canceled") {
      ctaHtml = '<button type="button" class="ptc-btn ptc-btn-done" disabled>' +
                (state === "missed" ? "Missed" : "Canceled") + '</button>';
    } else if (blockedByOther) {
      ctaHtml = '<button type="button" class="ptc-btn ptc-btn-blocked" disabled ' +
                'title="You are already clocked into another stop">Clocked into another stop</button>';
    } else {
      ctaHtml = '<button type="button" class="ptc-btn ptc-btn-start" ' +
                'data-action="clock-in" data-assignment-id="' + escapeHtml(a._id) + '">Clock In</button>';
    }

    const deadline = a.service_deadline ? formatTimeShort(a.service_deadline) : "";
    const windowStart = a.service_window_start ? formatTimeShort(a.service_window_start) : "";

    return (
      '<article class="ptc-card" data-assignment-id="' + escapeHtml(a._id) + '">' +
        '<header class="ptc-card-head">' +
          '<span class="ptc-card-eyebrow">PIONEER · ' + escapeHtml(a.service_date) + '</span>' +
          statusChip(state) +
        '</header>' +
        '<h3 class="ptc-card-title">' +
          escapeHtml(a.customer_name || a.customer_id || "Customer") +
        '</h3>' +
        (a.location_name
          ? '<p class="ptc-card-loc">' + escapeHtml(a.location_name) + '</p>'
          : "") +
        '<dl class="ptc-card-meta">' +
          (windowStart ? '<div><dt>Window starts</dt><dd>' + escapeHtml(windowStart) + '</dd></div>' : '') +
          (deadline    ? '<div><dt>Deadline</dt><dd>' + escapeHtml(deadline) + '</dd></div>' : '') +
          (a.estimated_minutes ? '<div><dt>Estimated</dt><dd>' + escapeHtml(formatMinutesAsHm(a.estimated_minutes)) + '</dd></div>' : '') +
          (a.budget_minutes    ? '<div><dt>Budget</dt><dd>'    + escapeHtml(formatMinutesAsHm(a.budget_minutes))    + '</dd></div>' : '') +
        '</dl>' +
        '<div class="ptc-card-actions">' + ctaHtml + '</div>' +
      '</article>'
    );
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

      tx.set(sessionRef, {
        assignment_id:                 assignmentId,
        staff_uid:                     currentStaff.uid,
        staff_email:                   staffEmail,
        service_date:                  today,
        customer_id:                   a.customer_id  || null,
        customer_name:                 a.customer_name || null,
        location_id:                   a.location_id  || null,

        clock_in_at:                   sts,
        clock_in_lat:                  geo.lat,
        clock_in_lon:                  geo.lon,
        clock_in_accuracy_m:           geo.accuracy_m,
        clock_in_geofence:             "unknown",      // Phase 1b — not computed
        clock_in_gps_status:           geo.status,
        clock_in_source:               "work_html_phase_1b",

        clock_out_at:                  null,
        status:                        "active",
        break_minutes:                 0,
        work_minutes:                  0,
        paid_minutes:                  0,
        paid_drive_minutes:            0,
        sick_accrual_eligible_minutes: 0,
        needs_review:                  false,
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
        lat:           geo.lat,
        lon:           geo.lon,
        accuracy_m:    geo.accuracy_m,
        geofence_status: "unknown",
        gps_status:    geo.status,

        source:        "work_html_phase_1b",
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

      tx.update(sessionRef, {
        status:                        "completed",
        clock_out_at:                  sts,
        clock_out_lat:                 geo.lat,
        clock_out_lon:                 geo.lon,
        clock_out_accuracy_m:          geo.accuracy_m,
        clock_out_geofence:            "unknown",
        clock_out_gps_status:          geo.status,
        clock_out_source:              "work_html_phase_1b",
        work_minutes:                  workMinutes,
        paid_minutes:                  paidMinutes,
        paid_drive_minutes:            0,
        break_minutes:                 0,
        sick_accrual_eligible_minutes: accrualMinutes,
        needs_review:                  needsReview,
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
        lat:           geo.lat,
        lon:           geo.lon,
        accuracy_m:    geo.accuracy_m,
        geofence_status: "unknown",
        gps_status:    geo.status,

        source:        "work_html_phase_1b",
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

  /* ---------- UI utility states ---------- */

  function showSection() {
    const section = $("pioneer-time-clock-section");
    if (section) section.hidden = false;
  }

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
    root.innerHTML =
      '<div class="ptc-status ptc-status-error">' +
        '<p><strong>Couldn\'t load Pioneer Time Clock.</strong></p>' +
        '<p>' + escapeHtml(msg) + '</p>' +
        '<p>Deputy is still available below as a fallback.</p>' +
      '</div>';
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    wireClicks();
    bootWhenAuthReady();
  });
}());
