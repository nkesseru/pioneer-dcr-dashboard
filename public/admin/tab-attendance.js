/* Pioneer DCR Hub — Admin Attendance + Open Shifts tab (vanilla JS, no build).
 *
 * One panel, FIVE sub-tabs:
 *   1. Pending Time-Off  — approve / deny
 *   2. Approved Time-Off — reviewed history
 *   3. Call-Outs         — acknowledge / mark resolved
 *   4. Calendar          — 60-day heatmap of approved + pending overlap
 *   5. Open Shifts       — Rockstar Coverage admin CRUD
 *
 * Firestore I/O (pure CRUD, no Cloud Functions):
 *   • time_off_requests       — read all, patch status/reviewedAt/reviewedBy/managerNote
 *   • call_outs               — read all, patch status/acknowledgedAt/acknowledgedBy/
 *                                          resolvedAt/resolvedBy/coverageNote
 *   • open_shift_requests     — read where status in ["open","accepted"], CRUD
 *   • rockstar_bonuses        — write on confirm-coverage (atomic batch with open_shift status flip)
 *
 * Phase 2 TODO (preserved from inline comments):
 *   • Cloud Function on create → email Kirby (replaces the in-app notification doc)
 *   • Notify tech back when status flips
 *   • Blackout windows + max-people-off-per-day rule
 *   • Conflict overlay on the Team Schedule calendar
 *   • Trigger function on open-shift confirm → email tech "$25 Rockstar bonus confirmed"
 *   • Auto-cancel + Kirby alert when an open shift remains unclaimed past shiftDate
 *
 * Surface lives at window.__pioneerAdmin.tabs.attendance:
 *   {
 *     init,     // wireAttendanceControls + wireOpenShiftsControls
 *     refresh   // loadAttendance — the registerTabActivator target
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • pacificDateString, addDaysPacific from __pioneerAdmin.utils
 *   • No shell deps (this module ships its own attendanceEscapeHtml +
 *     attendanceChip pills, and uses direct DOM for status banners)
 *   • No __pioneerAdmin.deps required — Attendance reads its own three
 *     Firestore collections; doesn't touch customers/techs caches
 *   • window.firebase compat SDK (auth + firestore)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-attendance.js: utils + shell modules must load first");
  }
  const { pacificDateString, addDaysPacific } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ====================================================================
     Sub-module 1-4: Attendance — Time-Off + Call-Outs admin panel
     ==================================================================== */

  let attendanceTimeOff   = [];   // array of {id, ...data}
  let attendanceCallOuts  = [];
  let attendanceActiveSub = "pending";
  void attendanceActiveSub;  // tracked for parity with original; UI reads from DOM state
  // False until the first loadAttendance() fetch resolves. While false,
  // the per-sub-tab renderers skip the empty-state path so the global
  // #attendance-loading banner is the single "loading" signal. Without
  // this guard, clicking Approved/Call-Outs during the initial fetch
  // surfaced "No …" alongside the banner (Phase 24 QA).
  let attendanceLoaded    = false;

  function setAttendanceState(state) {
    const map = {
      loading: "attendance-loading",
      error:   "attendance-error"
    };
    Object.keys(map).forEach(function (k) {
      const el = $(map[k]);
      if (el) el.hidden = (k !== state);
    });
  }

  function attendanceTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function attendanceFmtTs(ts) {
    const ms = attendanceTsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) { return new Date(ms).toLocaleString(); }
  }
  function attendanceEscapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attendanceTypeLabel(v) {
    switch (v) {
      case "vacation":     return "Vacation";
      case "personal_day": return "Personal day";
      case "appointment":  return "Appointment";
      case "family_event": return "Family event";
      case "other":        return "Other";
      default:             return v || "—";
    }
  }
  function attendanceReasonLabel(v) {
    switch (v) {
      case "sick":           return "Sick";
      case "emergency":      return "Emergency";
      case "transportation": return "Transportation issue";
      case "family":         return "Family issue";
      case "running_late":   return "Running late";
      case "other":          return "Other";
      default:               return v || "—";
    }
  }
  function attendanceChip(s) {
    const map = {
      new: "New", acknowledged: "Acknowledged", resolved: "Resolved",
      pending: "Pending", approved: "Approved", denied: "Denied"
    };
    const label = map[s] || s || "—";
    return '<span class="attendance-chip attendance-chip--' + (s || "pending") + '">' + label + '</span>';
  }
  function attendanceRangeLabel(start, end) {
    if (!start) return "—";
    if (!end || end === start) return start;
    return start + " → " + end;
  }

  async function loadAttendance() {
    setAttendanceState("loading");
    try {
      const db = firebase.firestore();
      const [toSnap, coSnap] = await Promise.all([
        db.collection("time_off_requests").orderBy("submittedAt", "desc").limit(200).get(),
        db.collection("call_outs").orderBy("submittedAt", "desc").limit(200).get()
      ]);
      attendanceTimeOff = toSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      attendanceCallOuts = coSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      attendanceLoaded = true;
      setAttendanceState(null);
      renderAttendance();
      updateAttendanceBadges();
    } catch (err) {
      console.error("[attendance] load failed", err);
      const el = $("attendance-error");
      if (el) {
        el.textContent =
          err && err.code === "permission-denied"
            ? "Permission denied. Confirm firestore.rules has the call_outs + time_off_requests blocks deployed."
            : ("Couldn't load attendance: " + (err && (err.message || err.code)) || "unknown");
      }
      setAttendanceState("error");
    }
  }

  function updateAttendanceBadges() {
    const pending = attendanceTimeOff.filter(function (x) { return x.status === "pending"; }).length;
    const newCallOuts = attendanceCallOuts.filter(function (x) { return x.status === "new"; }).length;
    const total = pending + newCallOuts;

    const tabBadge = $("attendance-tab-badge");
    if (tabBadge) {
      if (total > 0) {
        tabBadge.textContent = total > 99 ? "99+" : String(total);
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }
    const pendingChip = $("attn-pending-count");
    if (pendingChip) {
      if (pending > 0) { pendingChip.textContent = String(pending); pendingChip.hidden = false; }
      else             { pendingChip.hidden = true; }
    }
    const calloutsChip = $("attn-callouts-count");
    if (calloutsChip) {
      if (newCallOuts > 0) { calloutsChip.textContent = String(newCallOuts); calloutsChip.hidden = false; }
      else                 { calloutsChip.hidden = true; }
    }
  }

  function renderAttendance() {
    renderAttendancePending();
    renderAttendanceApproved();
    renderAttendanceCallouts();
    renderAttendanceCalendar();
  }

  function renderAttendancePending() {
    const list  = $("attn-pending-list");
    const empty = $("attn-pending-empty");
    if (!list || !empty) return;
    if (!attendanceLoaded) { list.innerHTML = ""; empty.hidden = true; return; }
    const items = attendanceTimeOff.filter(function (x) { return x.status === "pending"; });
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="to">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceTypeLabel(x.requestType)) +
                ' · ' + attendanceEscapeHtml(attendanceRangeLabel(x.startDate, x.endDate)) + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.note
            ? '<p class="attn-card-note"><strong>Tech note:</strong> ' + attendanceEscapeHtml(x.note) + '</p>'
            : '') +
          '<div class="attn-card-meta">Submitted ' + attendanceFmtTs(x.submittedAt) + '</div>' +
          '<div class="attn-card-actions">' +
            '<input type="text" class="attn-mgr-note" placeholder="Manager note (optional)" maxlength="280" />' +
            '<button type="button" class="attn-btn attn-btn-deny"    data-act="deny">Deny</button>' +
            '<button type="button" class="attn-btn attn-btn-approve" data-act="approve">Approve</button>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function renderAttendanceApproved() {
    const list  = $("attn-approved-list");
    const empty = $("attn-approved-empty");
    if (!list || !empty) return;
    if (!attendanceLoaded) { list.innerHTML = ""; empty.hidden = true; return; }
    const items = attendanceTimeOff.filter(function (x) {
      return x.status === "approved" || x.status === "denied";
    });
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card attn-card--review" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="to">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceTypeLabel(x.requestType)) +
                ' · ' + attendanceEscapeHtml(attendanceRangeLabel(x.startDate, x.endDate)) + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.managerNote
            ? '<p class="attn-card-note"><strong>Manager:</strong> ' + attendanceEscapeHtml(x.managerNote) + '</p>'
            : '') +
          '<div class="attn-card-meta">Reviewed ' + attendanceFmtTs(x.reviewedAt) +
            (x.reviewedBy ? ' by ' + attendanceEscapeHtml(x.reviewedBy.displayName || x.reviewedBy.email || "admin") : '') +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function renderAttendanceCallouts() {
    const list  = $("attn-callouts-list");
    const empty = $("attn-callouts-empty");
    if (!list || !empty) return;
    if (!attendanceLoaded) { list.innerHTML = ""; empty.hidden = true; return; }
    const items = attendanceCallOuts;
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="co">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceReasonLabel(x.reason)) +
                ' · ' + attendanceEscapeHtml(x.date || "—") +
                (x.shiftCustomer ? ' · ' + attendanceEscapeHtml(x.shiftCustomer) : '') + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.note
            ? '<p class="attn-card-note"><strong>Tech note:</strong> ' + attendanceEscapeHtml(x.note) + '</p>'
            : '') +
          (x.coverageNote
            ? '<p class="attn-card-note"><strong>Coverage:</strong> ' + attendanceEscapeHtml(x.coverageNote) + '</p>'
            : '') +
          '<div class="attn-card-meta">Submitted ' + attendanceFmtTs(x.submittedAt) + '</div>' +
          (x.status !== "resolved"
            ? '<div class="attn-card-actions">' +
                '<input type="text" class="attn-coverage-note" placeholder="Coverage note (optional)" maxlength="280" />' +
                (x.status === "new"
                  ? '<button type="button" class="attn-btn" data-act="ack">Acknowledge</button>'
                  : '') +
                '<button type="button" class="attn-btn attn-btn-approve" data-act="resolve">Mark resolved</button>' +
              '</div>'
            : '') +
        '</article>'
      );
    }).join("");
  }

  // Calendar heatmap — flat grid of upcoming dates (today to today+60),
  // each cell colored by the count of (approved + pending) time-off
  // requests covering it. Names listed inline so Kirby sees who.
  function renderAttendanceCalendar() {
    try { console.info("[AttendanceCalendar] rendering"); } catch (_e) {}
    const root = $("attn-calendar");
    if (!root) {
      try { console.warn("[AttendanceCalendar] target #attn-calendar not found"); } catch (_e) {}
      return;
    }
    try { console.info("[AttendanceCalendar] target found", { node: root.tagName }); } catch (_e) {}

    let today, dates;
    try {
      today = pacificDateString(new Date());
      const horizonDays = 60;
      dates = [];
      for (let i = 0; i < horizonDays; i++) dates.push(addDaysPacific(today, i));
    } catch (err) {
      try { console.error("[AttendanceCalendar] date helpers failed", err); } catch (_e) {}
      // Fall back to a bare 60-day UTC range so the grid still renders.
      const startMs = Date.now();
      today = new Date(startMs).toISOString().slice(0, 10);
      dates = [];
      for (let i = 0; i < 60; i++) {
        dates.push(new Date(startMs + i * 86400000).toISOString().slice(0, 10));
      }
    }

    // Build date → list of { name, status }
    const byDate = new Map();
    dates.forEach(function (d) { byDate.set(d, []); });
    try { console.info("[AttendanceCalendar] entries loaded", {
      requests: attendanceTimeOff.length, dates: dates.length
    }); } catch (_e) {}
    attendanceTimeOff.forEach(function (x) {
      if (x.status !== "approved" && x.status !== "pending") return;
      if (!x.startDate) return;
      const endDate = x.endDate || x.startDate;
      // Walk every day in the request range that falls inside our horizon.
      let cur = x.startDate;
      let safety = 0;
      while (cur <= endDate && safety < 120) {
        if (byDate.has(cur)) {
          byDate.get(cur).push({
            name: x.techName || x.techEmail || "Tech",
            status: x.status
          });
        }
        try {
          cur = addDaysPacific(cur, 1);
        } catch (_e) {
          // Defensive: a malformed startDate could throw. Bail this row.
          break;
        }
        safety += 1;
      }
    });

    const cellsHtml = dates.map(function (d) {
      const entries = byDate.get(d) || [];
      const count = entries.length;
      let level = "none";
      if      (count >= 3) level = "red";
      else if (count === 2) level = "orange";
      else if (count === 1) level = "yellow";

      const isToday = (d === today);
      const wkday = (function () {
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", weekday: "short"
          }).format(new Date(d + "T12:00:00Z"));
        } catch (_e) { return ""; }
      })();
      const dayLabel = (function () {
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", month: "short", day: "numeric"
          }).format(new Date(d + "T12:00:00Z"));
        } catch (_e) { return d; }
      })();
      const namesHtml = entries.length
        ? '<ul class="attn-cal-names">' +
            entries.map(function (e) {
              return '<li class="attn-cal-name attn-cal-name--' + e.status + '">' +
                attendanceEscapeHtml(e.name) +
                (e.status === "pending" ? ' <em>(pending)</em>' : '') +
                '</li>';
            }).join("") +
          '</ul>'
        : '';
      // Critical hint on red cells — operational visibility, not a
      // hard block. Admins still approve/deny on their own judgment.
      const criticalHint = (level === "red")
        ? '<p class="attn-cal-critical">3+ people already off — additional requests may be difficult to approve.</p>'
        : '';
      const tooltipParts = [];
      if (count > 0) {
        tooltipParts.push(count + (count === 1 ? " person" : " people") + " requested off");
        entries.forEach(function (e) {
          tooltipParts.push("· " + e.name + (e.status === "pending" ? " (pending)" : ""));
        });
      } else {
        tooltipParts.push("No requests off");
      }
      const tooltip = tooltipParts.join("\n");
      return (
        '<div class="attn-cal-cell attn-cal-cell--' + level +
          (isToday ? ' is-today' : '') + '"' +
          ' title="' + attendanceEscapeHtml(tooltip) + '">' +
          '<div class="attn-cal-head">' +
            '<span class="attn-cal-wkday">' + attendanceEscapeHtml(wkday) + '</span>' +
            '<span class="attn-cal-date">' + attendanceEscapeHtml(dayLabel) + '</span>' +
            (count > 0 ? '<span class="attn-cal-count">' + count + '</span>' : '') +
          '</div>' +
          namesHtml +
          criticalHint +
        '</div>'
      );
    }).join("");

    // Atomic write — replace innerHTML in one operation so a half-
    // rendered grid never flickers in. The renderer is idempotent;
    // calling it on every sub-tab activation is fine.
    root.innerHTML = cellsHtml;
    try { console.info("[AttendanceCalendar] rendered cells count", {
      cells: dates.length, requests_used: attendanceTimeOff.length
    }); } catch (_e) {}
  }

  function setAttendanceSubTab(name) {
    attendanceActiveSub = name;
    document.querySelectorAll(".attendance-subtab").forEach(function (b) {
      const active = (b.dataset.attnTab === name);
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".attendance-subpanel").forEach(function (p) {
      const active = (p.dataset.attnPanel === name);
      p.hidden = !active;
      p.classList.toggle("is-active", active);
    });
    // Re-render the activated panel so a stale grid (or one rendered
    // while the panel was hidden) never persists.
    try {
      if (name === "calendar")        renderAttendanceCalendar();
      else if (name === "pending")    renderAttendancePending();
      else if (name === "approved")   renderAttendanceApproved();
      else if (name === "callouts")   renderAttendanceCallouts();
      else if (name === "openshifts") loadOpenShifts();
    } catch (err) {
      try { console.error("[AttendanceCalendar] sub-tab re-render failed", { name: name, error: err && err.message }); } catch (_e) {}
    }
  }

  /* ====================================================================
     Sub-module 5: Open Shifts (Rockstar Coverage) — admin CRUD

     Lives inside the Attendance panel as a 5th sub-tab. Admins create
     open_shift_requests when a call-out leaves a shift uncovered;
     techs accept via /open-shifts.html (rule-enforced atomic claim);
     admin "Confirm coverage" flips status to "confirmed" AND creates
     a rockstar_bonuses doc in a single Firestore batch.
     ==================================================================== */

  let openShiftsState = [];

  async function loadOpenShifts() {
    const list  = $("attn-os-list");
    const empty = $("attn-os-empty");
    if (!list || !empty) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("open_shift_requests")
        .where("status", "in", ["open", "accepted"])
        .orderBy("shiftDate", "asc")
        .limit(100).get();
      openShiftsState = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      const openCount = openShiftsState.filter(function (x) { return x.status === "open"; }).length;
      const badge = $("attn-openshifts-count");
      if (badge) {
        if (openCount > 0) { badge.textContent = String(openCount); badge.hidden = false; }
        else               { badge.hidden = true; }
      }
      renderOpenShifts();
    } catch (err) {
      console.error("[openshifts] load failed", err);
      list.innerHTML =
        '<div class="admin-status admin-error">Couldn\'t load open shifts: ' +
        attendanceEscapeHtml((err && err.message) || "unknown") + '</div>';
    }
  }

  function renderOpenShifts() {
    const list  = $("attn-os-list");
    const empty = $("attn-os-empty");
    if (!list || !empty) return;
    if (!openShiftsState.length) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = openShiftsState.map(function (x) {
      const dateLabel = (function () {
        if (!x.shiftDate) return "—";
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "short", month: "short", day: "numeric"
          }).format(new Date(x.shiftDate + "T12:00:00Z"));
        } catch (_e) { return x.shiftDate; }
      })();
      const statusChip = x.status === "accepted"
        ? '<span class="attn-os-chip is-accepted">Accepted</span>'
        : '<span class="attn-os-chip is-open">Open</span>';

      let actions = "";
      if (x.status === "open") {
        actions =
          '<button type="button" class="attn-btn attn-btn-deny" data-act="cancel">Cancel</button>';
      } else if (x.status === "accepted") {
        actions =
          '<button type="button" class="attn-btn attn-btn-deny"    data-act="cancel">Cancel</button>' +
          '<button type="button" class="attn-btn attn-btn-approve" data-act="confirm">Confirm coverage</button>';
      }

      return (
        '<article class="attn-os-card" data-os-id="' + attendanceEscapeHtml(x.id) + '">' +
          '<header class="attn-os-card-head">' +
            '<div>' +
              '<div class="attn-os-card-title">' + attendanceEscapeHtml(x.customerName || "Customer") + '</div>' +
              '<div class="attn-os-card-meta">' + attendanceEscapeHtml(dateLabel) +
                (x.shiftTime ? ' · ' + attendanceEscapeHtml(x.shiftTime) : '') +
                '</div>' +
            '</div>' +
            statusChip +
          '</header>' +
          (x.notes ? '<p class="attn-os-card-notes">' + attendanceEscapeHtml(x.notes) + '</p>' : '') +
          (x.acceptedByTechName
            ? '<p class="attn-os-card-accepted"><strong>Accepted by:</strong> ' +
                attendanceEscapeHtml(x.acceptedByTechName) +
                ' · <span class="attn-os-bonus-pill">$25 Rockstar bonus pending confirmation</span></p>'
            : '') +
          '<div class="attn-os-card-actions">' + actions + '</div>' +
        '</article>'
      );
    }).join("");
  }

  async function createOpenShift(payload) {
    const u = firebase.auth().currentUser;
    const openedBy = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("open_shift_requests").add({
      source:               "admin",
      originalShiftId:      null,
      customerName:         payload.customerName,
      customerSlug:         payload.customerSlug || null,
      shiftDate:            payload.shiftDate,
      shiftTime:            payload.shiftTime || null,
      notes:                payload.notes || null,
      openedBy:             openedBy,
      openedAt:             firebase.firestore.FieldValue.serverTimestamp(),
      status:               "open",
      acceptedByTechUid:    null,
      acceptedByTechId:     null,
      acceptedByTechName:   null,
      acceptedAt:           null,
      confirmedBy:          null,
      confirmedAt:          null,
      rockstarBonusAmount:  25,
      rockstarBonusStatus:  "pending"
    });
  }

  async function cancelOpenShift(id) {
    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("open_shift_requests").doc(id).update({
      status:      "cancelled",
      confirmedBy: actor,
      confirmedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Confirm coverage = mark the open shift confirmed AND create the
  // matching rockstar_bonuses doc. Wrapped in a Firestore batch so
  // both writes succeed together (or neither does).
  async function confirmOpenShiftCoverage(id) {
    const item = openShiftsState.find(function (x) { return x.id === id; });
    if (!item) throw new Error("Open shift not found in local state");
    if (item.status !== "accepted") throw new Error("Shift must be accepted before confirming");

    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;

    const db    = firebase.firestore();
    const batch = db.batch();
    const osRef = db.collection("open_shift_requests").doc(id);
    const rbRef = db.collection("rockstar_bonuses").doc();

    const monthKey = (function () {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit"
        }).format(new Date()).slice(0, 7);
      } catch (_e) { return new Date().toISOString().slice(0, 7); }
    })();

    batch.update(osRef, {
      status:              "confirmed",
      confirmedBy:         actor,
      confirmedAt:         firebase.firestore.FieldValue.serverTimestamp(),
      rockstarBonusStatus: "pending"
    });
    batch.set(rbRef, {
      techId:             item.acceptedByTechId || "",
      techName:           item.acceptedByTechName || "",
      techUid:            item.acceptedByTechUid || "",
      sourceOpenShiftId:  id,
      amount:             25,
      earnedAt:           firebase.firestore.FieldValue.serverTimestamp(),
      monthKey:           monthKey,
      status:             "pending",
      confirmedBy:        actor
    });
    await batch.commit();
  }

  function wireOpenShiftsControls() {
    const newBtn  = $("attn-os-new-btn");
    const form    = $("attn-os-form");
    const cancel  = $("attn-os-form-cancel");
    if (newBtn && form) {
      newBtn.addEventListener("click", function () {
        form.hidden = false;
        const dateEl = $("attn-os-shift-date");
        if (dateEl && !dateEl.value) dateEl.value = pacificDateString(new Date());
        const nameEl = $("attn-os-customer-name");
        if (nameEl) nameEl.focus();
      });
    }
    if (cancel && form) {
      cancel.addEventListener("click", function () {
        form.hidden = true;
        const status = $("attn-os-form-status");
        if (status) status.textContent = "";
      });
    }
    if (form) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        const status = $("attn-os-form-status");
        const submitBtn = $("attn-os-form-submit");
        if (submitBtn) submitBtn.disabled = true;
        const payload = {
          customerName: ($("attn-os-customer-name") && $("attn-os-customer-name").value || "").trim(),
          customerSlug: ($("attn-os-customer-slug") && $("attn-os-customer-slug").value || "").trim(),
          shiftDate:    ($("attn-os-shift-date")    && $("attn-os-shift-date").value    || "").trim(),
          shiftTime:    ($("attn-os-shift-time")    && $("attn-os-shift-time").value    || "").trim(),
          notes:        ($("attn-os-notes")         && $("attn-os-notes").value         || "").trim()
        };
        if (!payload.customerName || !payload.shiftDate) {
          if (status) status.textContent = "Customer + shift date are required.";
          if (submitBtn) submitBtn.disabled = false;
          return;
        }
        try {
          if (status) status.textContent = "Creating…";
          await createOpenShift(payload);
          if (status) status.textContent = "Open shift created.";
          // Reset + hide form
          form.reset();
          form.hidden = true;
          if ($("attn-os-shift-date")) $("attn-os-shift-date").value = pacificDateString(new Date());
          loadOpenShifts();
        } catch (err) {
          console.error("[openshifts] create failed", err);
          if (status) status.textContent =
            "Create failed: " + ((err && (err.message || err.code)) || "unknown");
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
    // Delegated action clicks on cards.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest(".attn-os-card .attn-btn[data-act]");
      if (!btn) return;
      const card = btn.closest("[data-os-id]");
      if (!card) return;
      const id  = card.dataset.osId;
      const act = btn.dataset.act;
      btn.disabled = true;
      const done = function () { btn.disabled = false; loadOpenShifts(); };
      const fail = function (err) {
        console.error("[openshifts] action failed", err);
        alert((err && (err.message || err.code)) || "Action failed");
        btn.disabled = false;
      };
      if      (act === "cancel")  cancelOpenShift(id).then(done).catch(fail);
      else if (act === "confirm") confirmOpenShiftCoverage(id).then(done).catch(fail);
    });
  }

  /* ====================================================================
     Cross-cutting writers + master wire-up
     ==================================================================== */

  async function updateTimeOffStatus(id, newStatus, managerNote) {
    const u = firebase.auth().currentUser;
    const reviewedBy = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("time_off_requests").doc(id).update({
      status:      newStatus,
      reviewedAt:  firebase.firestore.FieldValue.serverTimestamp(),
      reviewedBy:  reviewedBy,
      managerNote: managerNote || null
    });
  }
  async function updateCallOutStatus(id, newStatus, coverageNote) {
    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    const patch = { coverageNote: coverageNote || null };
    if (newStatus === "acknowledged") {
      patch.status         = "acknowledged";
      patch.acknowledgedAt = firebase.firestore.FieldValue.serverTimestamp();
      patch.acknowledgedBy = actor;
    } else if (newStatus === "resolved") {
      patch.status     = "resolved";
      patch.resolvedAt = firebase.firestore.FieldValue.serverTimestamp();
      patch.resolvedBy = actor;
    }
    await firebase.firestore().collection("call_outs").doc(id).update(patch);
  }

  function wireAttendanceControls() {
    // Sub-tab switching.
    document.querySelectorAll(".attendance-subtab").forEach(function (b) {
      b.addEventListener("click", function () {
        const n = b.dataset.attnTab;
        if (n) setAttendanceSubTab(n);
      });
    });
    // Refresh button.
    const refresh = $("attendance-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadAttendance(); });

    // Delegated action clicks on attn-card buttons.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest(".attn-btn[data-act]");
      if (!btn) return;
      const card = btn.closest("[data-attn-id]");
      if (!card) return;
      const id   = card.dataset.attnId;
      const kind = card.dataset.attnKind;
      const act  = btn.dataset.act;
      btn.disabled = true;

      if (kind === "to") {
        const noteEl = card.querySelector(".attn-mgr-note");
        const note   = (noteEl && noteEl.value || "").trim();
        const newStatus = (act === "approve") ? "approved" : "denied";
        updateTimeOffStatus(id, newStatus, note)
          .then(loadAttendance)
          .catch(function (err) {
            console.error("[attendance] time-off update failed", err);
            alert("Update failed: " + (err && err.message || err));
            btn.disabled = false;
          });
      } else if (kind === "co") {
        const noteEl = card.querySelector(".attn-coverage-note");
        const note   = (noteEl && noteEl.value || "").trim();
        const newStatus = (act === "ack") ? "acknowledged"
                        : (act === "resolve") ? "resolved" : null;
        if (!newStatus) { btn.disabled = false; return; }
        updateCallOutStatus(id, newStatus, note)
          .then(loadAttendance)
          .catch(function (err) {
            console.error("[attendance] call-out update failed", err);
            alert("Update failed: " + (err && err.message || err));
            btn.disabled = false;
          });
      }
    });
  }

  /* ---------- export surface ---------- */

  function init() {
    wireAttendanceControls();
    wireOpenShiftsControls();
  }

  // refresh() preserves the EXACT original activator behavior:
  // registerTabActivator("attendance", loadAttendance) used to fire
  // ONLY loadAttendance. Open Shifts loads lazily when the user
  // clicks its sub-tab (via setAttendanceSubTab("openshifts") →
  // loadOpenShifts). Keeping that lazy pattern.
  function refresh() {
    loadAttendance();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.attendance = {
    init:    init,
    refresh: refresh
  };
}());
