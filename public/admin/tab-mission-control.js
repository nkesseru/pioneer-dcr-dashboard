/* Pioneer DCR Hub — Admin PioneerOps Mission Control V2 (Phase 31.2).
 *
 * Action-first. Replaces V1's six abstract metric cards with concrete
 * task cards: each RED/YELLOW condition becomes one card that says
 * what happened, who's affected, the customer/location, the reason,
 * and a direct button to open the relevant tab where it can be fixed.
 *
 * Mission Control answers three questions at a glance:
 *   1. What needs attention?
 *   2. Why?
 *   3. What do I click to fix it?
 *
 * Healthy categories are summarized in a small ribbon below the action
 * list — never compete for attention.
 *
 * Ops day window: yesterday 4 PM → today 4 PM Pacific via
 * getOpsDayWindow(). Read-only. Single Promise.all over 9 collection
 * reads; per-read soft-fail surfaces a small warning rather than
 * breaking the panel.
 *
 * Exports window.__pioneerAdmin.tabs.missionControl: { init, refresh }.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-mission-control.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString, addDaysPacific, getOpsDayWindow,
          getActive, getDcrEnabled } = window.__pioneerAdmin.utils;
  const { activateTab } = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }
  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function fmtTimePT(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtShiftDate(yyyymmdd, todayPT, tomorrowPT, yesterdayPT) {
    if (!yyyymmdd) return "—";
    if (yyyymmdd === todayPT) return "Tonight";
    if (yyyymmdd === tomorrowPT) return "Tomorrow";
    if (yyyymmdd === yesterdayPT) return "Yesterday";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
  function fmtElapsed(ms, nowMs) {
    if (!ms) return "—";
    const diffMin = Math.round((nowMs - ms) / 60000);
    if (diffMin < 60) return diffMin + " min ago";
    const hrs = Math.round(diffMin / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.round(hrs / 24);
    return days + "d ago";
  }

  /* ---------- module state ---------- */

  let loading = false;
  let loaded  = false;
  let stylesInjected = false;

  /* ---------- core read (mirrors V1) ---------- */

  async function loadSnapshot() {
    const db = firebase.firestore();
    const now = Date.now();
    const opsWindow = getOpsDayWindow(new Date(now));
    const todayPT     = pacificDateString();
    const yesterdayPT = addDaysPacific(todayPT, -1);
    const tomorrowPT  = addDaysPacific(todayPT,  1);

    function safe(label, p) {
      return p.then(
        (val) => ({ ok: true, val }),
        (err) => ({ ok: false, err: (err && err.message) || String(err), label: label })
      );
    }

    const reads = await Promise.all([
      safe("assignments", db.collection("service_assignments")
        .where("service_date", ">=", yesterdayPT)
        .where("service_date", "<=", tomorrowPT)
        .get()),
      safe("sessions", db.collection("pioneer_service_sessions")
        .where("service_date", ">=", yesterdayPT)
        .where("service_date", "<=", tomorrowPT)
        .get()),
      safe("active_sessions", db.collection("active_service_sessions").get()),
      safe("supply", db.collection("supply_requests").get()),
      safe("customers", db.collection("customers").get()),
      safe("techs", db.collection("cleaning_techs").get()),
      safe("time_adj", db.collection("time_adjustment_requests")
        .where("status", "==", "pending").get()),
      safe("deputy_tonight", db.collection("deputy_shift_cache")
        .where("sync_date", "==", todayPT).get()),
      safe("deputy_tomorrow", db.collection("deputy_shift_cache")
        .where("sync_date", "==", tomorrowPT).get())
    ]);

    function docs(idx) {
      const r = reads[idx];
      if (!r.ok) return null;
      return r.val.docs.map(d => Object.assign({ _id: d.id }, d.data() || {}));
    }
    function failures() {
      return reads.filter(r => !r.ok).map(r => r.label + ": " + r.err);
    }

    return {
      now:             now,
      opsWindow:       opsWindow,
      todayPT:         todayPT,
      yesterdayPT:     yesterdayPT,
      tomorrowPT:      tomorrowPT,
      assignments:     docs(0),
      sessions:        docs(1),
      activeSess:      docs(2),
      supply:          docs(3),
      customers:       docs(4),
      techs:           docs(5),
      timeAdj:         docs(6),
      deputyTonight:   docs(7),
      deputyTomorrow:  docs(8),
      failedReads:     failures()
    };
  }

  /* ---------- Phase 29A QA filter ---------- */

  function isQaTestSession(s) {
    return !!(s && (s.is_test === true ||
                    s.exclude_from_payroll_export === true ||
                    s.excluded_from_payroll === true));
  }
  function isQaTestAssignment(a) {
    return !!(a && (a.is_test === true || a.exclude_from_payroll_export === true));
  }

  /* ---------- action item generation ----------
   * Each function appends zero or more action items to `items`. Order
   * within a function is RED-first then YELLOW, but the final list is
   * sorted again at render time so additions in any order are safe. */

  function buildActionItems(snap) {
    const items = [];
    const healthy = [];   // categories that produced zero items — surfaced in the healthy ribbon
    const note = (msg) => null;   // (reserved for future telemetry)

    const techsByEmail = {};
    if (snap.techs) snap.techs.forEach(t => {
      if (t.email) techsByEmail[String(t.email).toLowerCase()] = t;
    });
    const custsBySlug = {};
    if (snap.customers) snap.customers.forEach(c => { custsBySlug[c._id] = c; });
    const asgnById = {};
    if (snap.assignments) snap.assignments.forEach(a => { asgnById[a._id] = a; });

    const sessionsByAsgn = {};
    if (snap.sessions) snap.sessions.forEach(s => {
      if (isQaTestSession(s)) return;
      if (!s.assignment_id) return;
      (sessionsByAsgn[s.assignment_id] = sessionsByAsgn[s.assignment_id] || []).push(s);
    });

    /* ---- 1. RED — Blocked tonight/tomorrow shifts ---- */
    const deputyShifts = ((snap.deputyTonight || []).concat(snap.deputyTomorrow || []))
      .filter(s => String(s.status || "").toLowerCase() !== "cancelled");

    let blockedCount = 0, unmappedCustomerCount = 0;
    deputyShifts.forEach(s => {
      const dateLabel = fmtShiftDate(s.sync_date, snap.todayPT, snap.tomorrowPT, snap.yesterdayPT);
      const time      = fmtTimePT(s.start_time);
      const customerName = s.customer_name || s.deputy_company_name || "?";
      const techName     = s.employee_display_name || s.employee_slug || s.employee_email || "?";

      if (!s.customer_slug) {
        unmappedCustomerCount += 1;
        items.push({
          severity: "RED",
          category: "unmapped-customer",
          title:   "Unmapped Customer",
          subject: customerName,
          context: dateLabel + " " + time + " · " + techName,
          reason:  'Deputy company "' + (s.deputy_company_name || "?") + '" has no PioneerOps customer mapping.',
          fix:     "Add a customer alias in Deputy Mapping.",
          actionLabel: "Open Deputy Mapping",
          actionRoute: "deputy"
        });
        return;
      }
      if (!s.employee_email) {
        blockedCount += 1;
        items.push({
          severity: "RED",
          category: "blocked-shift-noemail",
          title:   "Blocked Shift — Deputy email missing",
          subject: techName,
          context: customerName + " · " + dateLabel + " " + time,
          reason:  "Deputy profile has no email, so the bridge can't link this shift to a Firebase user.",
          fix:     "Add the tech's email to their Deputy employee profile, OR add a manual alias.",
          actionLabel: "Open Deputy Mapping",
          actionRoute: "deputy"
        });
        return;
      }
      const tech = techsByEmail[String(s.employee_email).toLowerCase()];
      if (!tech) {
        blockedCount += 1;
        items.push({
          severity: "RED",
          category: "blocked-shift-no-tech-doc",
          title:   "Blocked Shift — no PioneerOps tech",
          subject: techName,
          context: customerName + " · " + dateLabel + " " + time,
          reason:  "Deputy email " + s.employee_email + " has no cleaning_techs record.",
          fix:     "Add the tech in Cleaning Techs and invite them to sign in.",
          actionLabel: "Open Cleaning Techs",
          actionRoute: "techs"
        });
        return;
      }
      if (tech.active === false) {
        blockedCount += 1;
        items.push({
          severity: "RED",
          category: "blocked-shift-tech-archived",
          title:   "Blocked Shift — tech archived",
          subject: tech.display_name || techName,
          context: customerName + " · " + dateLabel + " " + time,
          reason:  "cleaning_techs/" + tech._id + " is archived but Deputy still has them scheduled.",
          fix:     "Either reactivate the tech, or remove the shift in Deputy.",
          actionLabel: "Open Cleaning Techs",
          actionRoute: "techs"
        });
        return;
      }
      // Bridge-side check. We can't reliably detect "tech hasn't signed in"
      // from the browser (cleaning_techs.uid is populated by Firebase Auth
      // lookup at bridge time, not stored on the doc), so we infer from the
      // bridge result: if the tech doc looks complete but the bridge still
      // hasn't created a service_assignment, the most likely cause is
      // uid_unresolved (tech has not signed into /work yet). The
      // night-shift-readiness-audit script confirms via admin.auth() — if
      // the office wants a definitive answer, they can run that.
      const aid = "sa_deputy__" + s.shift_id;
      if (!asgnById[aid]) {
        blockedCount += 1;
        items.push({
          severity: "RED",
          category: "blocked-shift-bridge-skipped",
          title:   "Blocked Shift — bridge skipped",
          subject: tech.display_name || techName,
          context: customerName + " · " + dateLabel + " " + time,
          reason:  "Deputy shift " + s.shift_id + " has not been bridged to service_assignments. " +
                   "Usually means the tech hasn't signed into /work yet (so Firebase Auth has no UID to attach).",
          fix:     "Send the tech the /work link and ask them to sign in once. The scheduled bridge picks it up within 10 minutes.",
          actionLabel: "Open Cleaning Techs",
          actionRoute: "techs"
        });
      }
    });
    if (blockedCount === 0 && unmappedCustomerCount === 0) {
      healthy.push("Readiness · " + deputyShifts.length + " shift" + (deputyShifts.length === 1 ? "" : "s") + " tonight/tomorrow all bridged");
    }

    /* ---- 2. RED — Missed shifts (yesterday assignment, no session) ---- */
    let missedCount = 0;
    if (snap.assignments) {
      snap.assignments.forEach(a => {
        if (isQaTestAssignment(a)) return;
        if (a.status === "admin_removed" || a.removed_from_ptc === true) return;
        if (a.service_date !== snap.yesterdayPT) return;     // only yesterday counts as "missed"
        const sess = sessionsByAsgn[a._id] || [];
        if (sess.length > 0) return;
        missedCount += 1;
        const techName = a.staff_display_name || a.staff_email || "?";
        const customerName = a.customer_name || a.customer_id || "?";
        items.push({
          severity: "RED",
          category: "missed-shift",
          title:   "Missed Shift",
          subject: techName,
          context: customerName + " · Yesterday",
          reason:  "Assignment existed but no clock-in was ever recorded.",
          fix:     "Confirm with the tech, then either submit a time adjustment or mark the shift as a no-show in Labor.",
          actionLabel: "Open Labor",
          actionRoute: "labor-review"
        });
      });
    }

    /* ---- 3. RED — Stuck active sessions (clocked in but ops day rolled over) ---- */
    let stuckCount = 0;
    if (snap.activeSess) {
      const opsStart = snap.opsWindow && snap.opsWindow.currentOpsStart;
      snap.activeSess.forEach(a => {
        const inMs = tsToMs(a.clock_in_at);
        if (!inMs || !opsStart) return;
        if (inMs >= opsStart) return;                       // still within current ops day — fine
        stuckCount += 1;
        const techDoc = (snap.techs || []).find(t => t.uid === a.staff_uid);
        const techName = (techDoc && techDoc.display_name) || a.staff_email || a.staff_uid || "?";
        items.push({
          severity: "RED",
          category: "stuck-clock",
          title:   "Stuck Clock-In",
          subject: techName,
          context: (a.customer_name || a.customer_id || "?") + " · clocked in " + fmtElapsed(inMs, snap.now),
          reason:  "Tech is still clocked in from an older ops day. Likely forgot to clock out.",
          fix:     "Force-close the session in Labor Review, then ask the tech to submit a time adjustment if needed.",
          actionLabel: "Open Labor",
          actionRoute: "labor-review"
        });
      });
    }
    if (stuckCount === 0) healthy.push("Clock · 0 stuck active sessions");

    /* ---- 4. YELLOW — Missing DCRs (completed session, no DCR submission) ---- */
    let missingDcrCount = 0;
    if (snap.sessions) {
      snap.sessions.forEach(s => {
        if (isQaTestSession(s)) return;
        if (s.status !== "completed") return;
        const hasDcr = (s.dcr_status === "submitted") || !!s.dcr_id || !!s.dcr_submission_id;
        if (hasDcr) return;
        missingDcrCount += 1;
        const techDoc = (snap.techs || []).find(t => t.uid === s.staff_uid);
        const techName = (techDoc && techDoc.display_name) || s.staff_email || "?";
        items.push({
          severity: "YELLOW",
          category: "missing-dcr",
          title:   "DCR Missing",
          subject: techName,
          context: (s.customer_name || s.customer_id || "?") + " · " +
                   fmtShiftDate(s.service_date, snap.todayPT, snap.tomorrowPT, snap.yesterdayPT),
          reason:  "Shift is clocked out but no DCR was submitted yet.",
          fix:     "Have the tech submit the DCR, or follow up via DCR Issues.",
          actionLabel: "Open DCR Issues",
          actionRoute: "issues"
        });
      });
    }
    if (missingDcrCount === 0) healthy.push("DCRs · all completed shifts submitted");

    /* ---- 5. YELLOW — Paused sessions still open in ops day ---- */
    let pausedCount = 0;
    if (snap.sessions) {
      snap.sessions.forEach(s => {
        if (isQaTestSession(s)) return;
        if (s.status !== "paused") return;
        pausedCount += 1;
        const techDoc = (snap.techs || []).find(t => t.uid === s.staff_uid);
        const techName = (techDoc && techDoc.display_name) || s.staff_email || "?";
        items.push({
          severity: "YELLOW",
          category: "paused-shift",
          title:   "Paused Shift",
          subject: techName,
          context: (s.customer_name || s.customer_id || "?") + " · " +
                   fmtShiftDate(s.service_date, snap.todayPT, snap.tomorrowPT, snap.yesterdayPT),
          reason:  "Session is paused — tech may have walked off or forgotten to resume.",
          fix:     "Check in with the tech; force-close if confirmed.",
          actionLabel: "Open Labor",
          actionRoute: "labor-review"
        });
      });
    }

    /* ---- 6. YELLOW — Pending time-adjustment requests ---- */
    let pendingAdjCount = 0;
    if (snap.timeAdj) {
      snap.timeAdj.forEach(r => {
        pendingAdjCount += 1;
        const delta = (typeof r.delta_minutes === "number")
          ? (r.delta_minutes > 0 ? "+" : "") + r.delta_minutes + " min"
          : "delta unknown";
        items.push({
          severity: "YELLOW",
          category: "time-adjustment",
          title:   "Time Adjustment Request",
          subject: r.employee_name || r.employee_email || "Tech",
          context: (r.customer_name || "?") + " · " +
                   fmtShiftDate(r.shift_date, snap.todayPT, snap.tomorrowPT, snap.yesterdayPT) +
                   " · " + delta,
          reason:  (r.reason || "—") + (r.notes ? " — " + r.notes : ""),
          fix:     "Review and approve / deny in Payroll Exceptions.",
          actionLabel: "Open Payroll Exceptions",
          actionRoute: "payroll-exceptions"
        });
      });
    }
    if (pendingAdjCount === 0) healthy.push("Payroll Exceptions · 0 pending");

    /* ---- 7. YELLOW — Customer config gaps (aggregated to keep noise down) ---- */
    if (snap.customers) {
      const active = snap.customers.filter(c => getActive(c));
      const dcrOff = active.filter(c => getDcrEnabled(c) === false);
      const dcrUnset = active.filter(c => typeof c.dcr_enabled === "undefined");
      const noGeo = active.filter(c => c.location_lat == null || c.location_lon == null);
      if (dcrOff.length + dcrUnset.length + noGeo.length > 0) {
        const bits = [];
        if (dcrOff.length) bits.push(dcrOff.length + " DCR-disabled");
        if (dcrUnset.length) bits.push(dcrUnset.length + " DCR flag unset");
        if (noGeo.length) bits.push(noGeo.length + " ungeofenced");
        items.push({
          severity: "YELLOW",
          category: "customer-config",
          title:   "Customer Config Gaps",
          subject: bits.join(" · "),
          context: active.length + " active customers in catalog",
          reason:  "Some customers are missing DCR or geofence config.",
          fix:     "Visit Customers, expand each flagged row, and fix dcr_enabled / location_lat / location_lon.",
          actionLabel: "Open Customers",
          actionRoute: "customers"
        });
      } else {
        healthy.push("Customer config · all active customers configured");
      }
    }

    /* ---- 8. Active techs without sign-in — INTENTIONALLY OMITTED ----
     * cleaning_techs.uid isn't reliably populated even for techs who have
     * signed in (it's resolved via admin.auth() at bridge time, not
     * persisted), so a client-side "no uid" check produces false positives
     * for every signed-in tech. The actionable signal — a SCHEDULED tech
     * whose Deputy shift hasn't bridged — is already surfaced per shift
     * above as "Blocked Shift — bridge skipped". For unscheduled-tech
     * sign-in status, run scripts/night-shift-readiness-audit.js which
     * resolves UIDs via the Admin SDK. */

    /* ---- Supply (informational — only shows when piling up) ---- */
    if (snap.supply) {
      const open = snap.supply.filter(r => (r.status || "new") !== "closed");
      if (open.length > 5) {
        items.push({
          severity: "YELLOW",
          category: "supply-backlog",
          title:   "Supply Request Backlog",
          subject: open.length + " open requests",
          context: "Some have been sitting unattended.",
          reason:  "Open supply requests count exceeds 5.",
          fix:     "Triage in the Supply tab.",
          actionLabel: "Open Supply",
          actionRoute: "supply"
        });
      } else {
        healthy.push("Supply · " + open.length + " open" + (open.length === 1 ? "" : "s"));
      }
    }

    return { items: items, healthy: healthy, failedReads: snap.failedReads };
  }

  /* ---------- render ---------- */

  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = [
      "#mission-control{margin-bottom:18px;padding:18px 22px;background:linear-gradient(180deg,#0f172a 0%,#111c33 100%);color:#e6edf7;border-radius:14px;box-shadow:0 6px 24px rgba(15,23,42,0.18);}",
      "#mission-control .mc-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;gap:12px;flex-wrap:wrap;}",
      "#mission-control .mc-eyebrow{display:block;font-size:11.5px;font-weight:800;letter-spacing:0.6px;color:#7ea3d6;text-transform:uppercase;}",
      "#mission-control .mc-title{margin:2px 0 0;font-size:22px;font-weight:800;color:#fff;}",
      "#mission-control .mc-window{margin:4px 0 0;font-size:13px;color:#a8c0e1;}",
      "#mission-control .mc-refresh{appearance:none;background:rgba(255,255,255,0.08);color:#e6edf7;border:1px solid rgba(255,255,255,0.18);padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;}",
      "#mission-control .mc-refresh:hover{background:rgba(255,255,255,0.14);}",
      // Action list
      "#mission-control .mc-action-banner{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 14px;background:rgba(255,255,255,0.06);border-radius:10px;font-size:14px;font-weight:600;}",
      "#mission-control .mc-action-banner.is-clean{background:rgba(34,197,94,0.16);border:1px solid rgba(34,197,94,0.4);color:#bbf7d0;}",
      "#mission-control .mc-action-banner.is-attn{background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.45);color:#fecaca;}",
      "#mission-control .mc-action-banner-count{font-size:22px;font-weight:800;}",
      "#mission-control .mc-items{display:flex;flex-direction:column;gap:10px;}",
      "#mission-control .mc-item{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;}",
      "#mission-control .mc-item[data-severity='RED']    {border-left:4px solid #ef4444;}",
      "#mission-control .mc-item[data-severity='YELLOW'] {border-left:4px solid #facc15;}",
      "#mission-control .mc-item-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}",
      "#mission-control .mc-item-title{font-size:12px;font-weight:800;letter-spacing:0.4px;text-transform:uppercase;color:#fecaca;}",
      "#mission-control .mc-item[data-severity='YELLOW'] .mc-item-title{color:#fde68a;}",
      "#mission-control .mc-item-subject{margin:0;font-size:16px;font-weight:700;color:#fff;}",
      "#mission-control .mc-item-context{margin:0;font-size:13px;color:#cdd9ec;}",
      "#mission-control .mc-item-reason{margin:2px 0 0;font-size:13px;color:#a8c0e1;line-height:1.5;}",
      "#mission-control .mc-item-fix{margin:4px 0 0;font-size:13px;color:#e6edf7;}",
      "#mission-control .mc-item-fix-label{font-weight:700;color:#7ea3d6;text-transform:uppercase;font-size:11px;letter-spacing:0.4px;margin-right:6px;}",
      "#mission-control .mc-item-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}",
      "#mission-control .mc-item-btn{appearance:none;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#fff;padding:7px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;}",
      "#mission-control .mc-item-btn:hover{background:rgba(255,255,255,0.18);}",
      "#mission-control .mc-item-btn-primary{background:rgba(59,123,224,0.85);border-color:#3b7be0;}",
      "#mission-control .mc-item-btn-primary:hover{background:#3b7be0;}",
      // Empty / healthy
      "#mission-control .mc-empty{display:flex;align-items:center;gap:10px;padding:16px;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.4);border-radius:10px;color:#bbf7d0;font-size:14px;}",
      "#mission-control .mc-empty strong{color:#fff;}",
      "#mission-control .mc-healthy{margin-top:14px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-size:12px;color:#a8c0e1;line-height:1.6;}",
      "#mission-control .mc-healthy-label{font-weight:800;color:#7ea3d6;text-transform:uppercase;letter-spacing:0.4px;font-size:11px;margin-right:6px;}",
      "#mission-control .mc-healthy-item{display:inline-block;padding:2px 8px;background:rgba(34,197,94,0.18);color:#bbf7d0;border-radius:999px;margin:2px 6px 2px 0;}",
      "#mission-control .mc-warnings{margin-top:10px;padding:8px 12px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.45);color:#fecaca;border-radius:8px;font-size:12px;}",
      "#mission-control .mc-collapse{cursor:pointer;color:#7ea3d6;font-size:12px;text-decoration:underline;margin-top:6px;display:inline-block;}",
      "#mission-control .mc-collapse:hover{color:#a8c0e1;}",
      "#mission-control .mc-overflow{font-size:12px;color:#a8c0e1;margin-top:4px;font-style:italic;}"
    ].join("\n");
    const tag = document.createElement("style");
    tag.setAttribute("data-pioneer", "mission-control-styles");
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function fmtOpsWindow(opsWindow) {
    if (!opsWindow) return "—";
    try {
      const startStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hour12: true
      }).format(new Date(opsWindow.currentOpsStart));
      const endStr = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hour12: true
      }).format(new Date(opsWindow.currentOpsEnd));
      return startStr + " → " + endStr + " Pacific";
    } catch (_e) { return "—"; }
  }

  // Per-category max visible items (the rest collapse into "and N more").
  const CATEGORY_CAP = {
    "blocked-shift-noemail":        6,
    "blocked-shift-no-tech-doc":    4,
    "blocked-shift-tech-archived":  4,
    "blocked-shift-bridge-skipped": 8,
    "unmapped-customer":            4,
    "missed-shift":                 6,
    "stuck-clock":                  6,
    "missing-dcr":                  8,
    "paused-shift":                 6,
    "time-adjustment":              8
  };

  function render(model, opsWindow) {
    ensureStyles();
    const root = $("mission-control");
    if (!root) return;

    const items = model.items.slice().sort((a, b) => {
      // RED first, then YELLOW. Within severity, stable category sort.
      if (a.severity !== b.severity) return a.severity === "RED" ? -1 : 1;
      return String(a.category).localeCompare(String(b.category));
    });
    const redCount = items.filter(i => i.severity === "RED").length;
    const yellowCount = items.filter(i => i.severity === "YELLOW").length;
    const totalActions = items.length;

    // Group by category so caps + "and N more" work.
    const byCategory = {};
    items.forEach(i => {
      (byCategory[i.category] = byCategory[i.category] || []).push(i);
    });
    // Preserve sort order — iterate items, take the first N per category.
    const renderedKeys = {};
    const overflow = {};
    const visibleItems = [];
    items.forEach(i => {
      const cap = CATEGORY_CAP[i.category] || 100;
      const shown = renderedKeys[i.category] || 0;
      if (shown < cap) {
        visibleItems.push(i);
        renderedKeys[i.category] = shown + 1;
      } else {
        overflow[i.category] = (overflow[i.category] || 0) + 1;
      }
    });

    const banner = totalActions === 0
      ? '<div class="mc-action-banner is-clean">✓&nbsp;<span>All clear — no action items.</span></div>'
      : '<div class="mc-action-banner is-attn"><span class="mc-action-banner-count">' + totalActions + '</span>'
        + '<span>Action Required · ' + redCount + ' red, ' + yellowCount + ' yellow</span></div>';

    const overflowNotes = Object.keys(overflow).map(cat => {
      return '<p class="mc-overflow">+ ' + overflow[cat] + ' more ' + escapeHtml(cat.replace(/-/g, " ")) + '</p>';
    }).join("");

    const itemsHtml = visibleItems.map(it => {
      return (
        '<article class="mc-item" data-severity="' + escapeHtml(it.severity) + '">' +
          '<div class="mc-item-head">' +
            '<span class="mc-item-title">' + escapeHtml(it.title) + '</span>' +
            (it.severity === "RED"
              ? '<span class="mc-item-title" style="color:#fecaca">● RED</span>'
              : '<span class="mc-item-title" style="color:#fde68a">● YELLOW</span>') +
          '</div>' +
          '<p class="mc-item-subject">' + escapeHtml(it.subject) + '</p>' +
          (it.context ? '<p class="mc-item-context">' + escapeHtml(it.context) + '</p>' : '') +
          (it.reason  ? '<p class="mc-item-reason">' + escapeHtml(it.reason) + '</p>' : '') +
          (it.fix     ? '<p class="mc-item-fix"><span class="mc-item-fix-label">Fix</span>' + escapeHtml(it.fix) + '</p>' : '') +
          '<div class="mc-item-actions">' +
            (it.actionRoute
              ? '<button type="button" class="mc-item-btn mc-item-btn-primary" data-mc-action-route="' +
                escapeHtml(it.actionRoute) + '">' + escapeHtml(it.actionLabel || "Open") + '</button>'
              : '') +
          '</div>' +
        '</article>'
      );
    }).join("") + overflowNotes;

    const healthyHtml = (model.healthy && model.healthy.length)
      ? '<div class="mc-healthy"><span class="mc-healthy-label">Healthy</span>' +
        model.healthy.map(h => '<span class="mc-healthy-item">' + escapeHtml(h) + '</span>').join("") +
        '</div>'
      : "";

    const warningsHtml = (model.failedReads && model.failedReads.length)
      ? '<div class="mc-warnings">⚠ ' + escapeHtml(model.failedReads.length + " read(s) failed: " + model.failedReads.join("; ")) + '</div>'
      : "";

    root.innerHTML =
      '<header class="mc-head">' +
        '<div>' +
          '<span class="mc-eyebrow">Mission Control</span>' +
          '<h2 class="mc-title">PioneerOps</h2>' +
          '<p class="mc-window">Ops Day · ' + escapeHtml(fmtOpsWindow(opsWindow)) + '</p>' +
        '</div>' +
        '<button type="button" class="mc-refresh" id="mission-control-refresh">Refresh</button>' +
      '</header>' +
      banner +
      (totalActions > 0 ? '<div class="mc-items">' + itemsHtml + '</div>' : "") +
      healthyHtml +
      warningsHtml;
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
      const snap  = await loadSnapshot();
      const model = buildActionItems(snap);
      render(model, snap.opsWindow);
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
      const actionBtn = ev.target.closest("#mission-control [data-mc-action-route]");
      if (!actionBtn) return;
      const route = actionBtn.getAttribute("data-mc-action-route");
      if (!route) return;
      try { activateTab(route); }
      catch (_e) { /* tab may not exist */ }
    });
  }

  function init() { wireClicks(); }

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.missionControl = { init: init, refresh: refresh };
}());
