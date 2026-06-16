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
        .where("sync_date", "==", tomorrowPT).get()),
      // Phase 33A — noise control. Two collections of admin choices that
      // suppress matching alerts at render time. Soft-failing fallback
      // returns an empty list so a missing collection (first deploy)
      // doesn't break the panel.
      safe("dismissals", db.collection("mission_control_alert_dismissals").get()
        .catch(() => ({ docs: [] }))),
      safe("suppressions", db.collection("mission_control_alert_suppressions")
        .where("active", "==", true).get()
        .catch(() => ({ docs: [] })))
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
      dismissals:      docs(9)  || [],
      suppressions:    docs(10) || [],
      failedReads:     failures()
    };
  }

  /* ---------- Phase 33A — noise control filter ----------
   *
   * Active dismissal = doc whose id matches the item's alertKey AND
   * whose expires_at is null/missing OR > now. Snoozed dismissals get
   * an expires_at value; permanent dismissals leave it null.
   *
   * Active suppression = doc with active === true AND alert_type ==
   * item.category. For aggregate alerts (entityType === "aggregate")
   * the entity match is by-category alone. For per-instance alerts
   * (every other category), the entity_type + entity_id must also
   * match — that's how "Suppress similar for Gene F" cleanly hides
   * future bridge-skipped alerts for Gene F without nuking other
   * blocked-shift alerts. */

  function dismissalActiveFor(alertKey, dismissals, nowMs) {
    if (!alertKey) return null;
    for (let i = 0; i < dismissals.length; i++) {
      const d = dismissals[i];
      if (d._id !== alertKey) continue;
      const expiresMs = tsToMs(d.expires_at);
      if (!expiresMs) return d;            // permanent
      if (expiresMs > nowMs) return d;     // snoozed, still active
    }
    return null;
  }

  function suppressionActiveFor(item, suppressions) {
    if (!item || !suppressions || !suppressions.length) return null;
    for (let i = 0; i < suppressions.length; i++) {
      const sup = suppressions[i];
      if (sup.active === false) continue;
      if (sup.alert_type !== item.category) continue;
      if (item.entityType === "aggregate") return sup;          // category-only match
      if (sup.entity_type === item.entityType &&
          sup.entity_id   === item.entityId) return sup;
    }
    return null;
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
          actionRoute: "deputy",
          alertKey:   "unmapped_customer:" + (s.deputy_company_name || "") + ":" + (s.shift_id || ""),
          entityType: "deputy_company",
          entityId:   String(s.deputy_company_name || "(unknown)"),
          entityName: s.deputy_company_name || "(unknown company)"
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
          actionRoute: "deputy",
          alertKey:   "blocked_shift_noemail:" + (s.shift_id || "") + ":" + (s.deputy_employee_id || s.employee_display_name || ""),
          entityType: "deputy_employee",
          entityId:   String(s.deputy_employee_id || s.employee_display_name || "(unknown)"),
          entityName: techName
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
          actionRoute: "techs",
          alertKey:   "blocked_shift_no_tech_doc:" + (s.shift_id || "") + ":" + s.employee_email,
          entityType: "tech_email",
          entityId:   String(s.employee_email).toLowerCase(),
          entityName: techName
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
          actionRoute: "techs",
          alertKey:   "blocked_shift_tech_archived:" + (s.shift_id || "") + ":" + tech._id,
          entityType: "tech",
          entityId:   tech._id,
          entityName: tech.display_name || techName
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
          actionRoute: "techs",
          alertKey:   "blocked_shift_bridge_skipped:" + (s.shift_id || "") + ":" + tech._id,
          entityType: "tech",
          entityId:   tech._id,
          entityName: tech.display_name || techName
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
          actionRoute: "labor-review",
          alertKey:   "missed_shift:" + a._id,
          entityType: "tech",
          entityId:   String(a.staff_uid || a.staff_email || techName),
          entityName: techName
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
          actionRoute: "labor-review",
          alertKey:   "stuck_clock:" + a.staff_uid + ":" + inMs,
          entityType: "tech",
          entityId:   String(a.staff_uid || "(unknown)"),
          entityName: techName
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
        // Phase Timeclock Add-On — non-cleaning labor (inspection /
        // supply station) never produces a DCR. Don't flag those rows
        // as a missing-DCR alert. Absent labor_type defaults to
        // cleaning for back-compat with every legacy session.
        const isCleaning = !s.labor_type || s.labor_type === "cleaning";
        if (!isCleaning) return;
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
          actionRoute: "issues",
          alertKey:   "missing_dcr:" + s._id,
          entityType: "tech",
          entityId:   String(s.staff_uid || s.staff_email || techName),
          entityName: techName
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
          actionRoute: "labor-review",
          alertKey:   "paused_shift:" + s._id,
          entityType: "tech",
          entityId:   String(s.staff_uid || s.staff_email || techName),
          entityName: techName
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
          actionRoute: "payroll-exceptions",
          alertKey:   "time_adjustment:" + r._id,
          entityType: "tech",
          entityId:   String(r.employee_uid || r.employee_email || r.employee_name || "(unknown)"),
          entityName: r.employee_name || r.employee_email || "Tech"
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
          actionRoute: "customers",
          alertKey:   "customer_config_aggregate",
          entityType: "aggregate",
          entityId:   "customer-config",
          entityName: "Customer Config Gaps"
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
          actionRoute: "supply",
          alertKey:   "supply_backlog_aggregate",
          entityType: "aggregate",
          entityId:   "supply-backlog",
          entityName: "Supply Request Backlog"
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
      "#mission-control .mc-overflow{font-size:12px;color:#a8c0e1;margin-top:4px;font-style:italic;}",
      // Phase 33A — noise control buttons + suppressions section
      "#mission-control .mc-item-actions{flex-wrap:wrap;}",
      "#mission-control .mc-item-quiet{background:transparent;border:1px solid rgba(255,255,255,0.18);color:#cdd9ec;}",
      "#mission-control .mc-item-quiet:hover{background:rgba(255,255,255,0.10);border-color:rgba(255,255,255,0.32);color:#fff;}",
      "#mission-control .mc-item-quiet.is-danger{border-color:rgba(239,68,68,0.5);color:#fecaca;}",
      "#mission-control .mc-item-quiet.is-danger:hover{background:rgba(239,68,68,0.25);color:#fff;}",
      "#mission-control .mc-item-confirm-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;}",
      "#mission-control .mc-item-confirm-bar .mc-item-confirm-label{font-size:12.5px;color:#cdd9ec;margin-right:6px;}",
      "#mission-control .mc-action-banner-hidden{font-size:12px;font-weight:600;color:#94a3b8;}",
      "#mission-control .mc-suppressions{margin-top:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;}",
      "#mission-control .mc-suppressions summary{cursor:pointer;padding:10px 14px;font-size:12px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#a8c0e1;list-style:revert;}",
      "#mission-control .mc-suppressions .mc-supp-count{color:#7ea3d6;font-weight:600;margin-left:6px;}",
      "#mission-control .mc-suppressions[open] summary{border-bottom:1px solid rgba(255,255,255,0.08);}",
      "#mission-control .mc-supp-body{padding:10px 14px;}",
      "#mission-control .mc-supp-empty{margin:0;font-size:13px;color:#94a3b8;text-align:center;padding:14px;}",
      "#mission-control .mc-supp-table{width:100%;border-collapse:collapse;font-size:12.5px;color:#cdd9ec;}",
      "#mission-control .mc-supp-table th{text-align:left;padding:6px 8px;font-weight:700;color:#a8c0e1;letter-spacing:0.4px;text-transform:uppercase;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.10);}",
      "#mission-control .mc-supp-table td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);}",
      "#mission-control .mc-supp-reactivate{appearance:none;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.18);padding:5px 10px;border-radius:6px;font-size:11.5px;font-weight:600;cursor:pointer;}",
      "#mission-control .mc-supp-reactivate:hover{background:rgba(255,255,255,0.18);}",
      /* ---------- Phase 33C — Inbox mode ----------
       *
       * Severity sections (Critical / Attention / Healthy collapsible),
       * grouped inbox rows (one per category+entity), in-row Open +
       * Details buttons, expandable per-row details with subitems and
       * group-level actions. Replaces Phase 33B compact-card styles. */
      "#mission-control .mc-inbox-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:8px 0 12px;}",
      "#mission-control .mc-inbox-count{padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:2px;}",
      "#mission-control .mc-inbox-count[data-severity='RED']{border-left:3px solid #ef4444;}",
      "#mission-control .mc-inbox-count[data-severity='YELLOW']{border-left:3px solid #facc15;}",
      "#mission-control .mc-inbox-count[data-severity='GREEN']{border-left:3px solid #22c55e;}",
      "#mission-control .mc-inbox-count.is-dim{opacity:0.6;}",
      "#mission-control .mc-inbox-count-label{font-size:10.5px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#a8c0e1;}",
      "#mission-control .mc-inbox-count-value{font-size:22px;font-weight:800;color:#fff;line-height:1;}",
      "#mission-control .mc-inbox-priorities-wrap{margin:0 0 14px;padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;}",
      "#mission-control .mc-inbox-priorities-label{font-size:10.5px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#7ea3d6;margin-bottom:6px;}",
      "#mission-control .mc-inbox-priorities{margin:0;padding-left:20px;color:#e6edf7;font-size:13.5px;line-height:1.55;}",
      "#mission-control .mc-inbox-priorities li{margin:2px 0;}",
      "#mission-control .mc-inbox-priorities.is-clean{padding:0;list-style:none;color:#bbf7d0;font-size:13.5px;}",
      "#mission-control .mc-inbox-section{margin-bottom:10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;}",
      "#mission-control .mc-inbox-section summary{cursor:pointer;list-style:none;padding:8px 14px;display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.03);}",
      "#mission-control .mc-inbox-section summary::-webkit-details-marker{display:none;}",
      "#mission-control .mc-inbox-section summary::before{content:'▸';color:#7ea3d6;font-size:11px;margin-right:6px;transition:transform 120ms;}",
      "#mission-control .mc-inbox-section[open] summary::before{transform:rotate(90deg);}",
      "#mission-control .mc-inbox-sev-pill{font-size:10px;font-weight:800;letter-spacing:1px;padding:3px 8px;border-radius:999px;}",
      "#mission-control .mc-inbox-sev-pill[data-severity='RED']{background:rgba(239,68,68,0.22);color:#fecaca;border:1px solid rgba(239,68,68,0.45);}",
      "#mission-control .mc-inbox-sev-pill[data-severity='YELLOW']{background:rgba(250,204,21,0.18);color:#fde68a;border:1px solid rgba(250,204,21,0.40);}",
      "#mission-control .mc-inbox-sev-pill[data-severity='GREEN']{background:rgba(34,197,94,0.18);color:#bbf7d0;border:1px solid rgba(34,197,94,0.40);}",
      // V20260616 — operator-friendly bucket pills + Today's Operations + System Setup helper
      "#mission-control .mc-inbox-sev-pill[data-bucket='needs-action']{background:rgba(239,68,68,0.22);color:#fecaca;border:1px solid rgba(239,68,68,0.45);}",
      "#mission-control .mc-inbox-sev-pill[data-bucket='system-setup']{background:rgba(120,160,255,0.18);color:#c7d8f5;border:1px solid rgba(120,160,255,0.40);}",
      "#mission-control .mc-inbox-sev-pill[data-bucket='healthy-hidden']{background:rgba(148,163,184,0.18);color:#cbd5e1;border:1px solid rgba(148,163,184,0.40);}",
      "#mission-control .mc-inbox-section-helper{margin:8px 0 12px;padding:8px 12px;background:rgba(120,160,255,0.10);border-left:3px solid rgba(120,160,255,0.50);color:#c7d8f5;font-size:12.5px;border-radius:0 6px 6px 0;}",
      "#mission-control .mc-todays-ops{margin:0 0 16px;padding:14px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;}",
      "#mission-control .mc-todays-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;flex-wrap:wrap;gap:6px;}",
      "#mission-control .mc-todays-eyebrow{font-size:11px;font-weight:800;letter-spacing:0.6px;color:#7ea3d6;text-transform:uppercase;}",
      "#mission-control .mc-todays-sub{font-size:11px;color:#94a3b8;}",
      "#mission-control .mc-todays-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px;}",
      "#mission-control .mc-todays-tile{appearance:none;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 14px;background:rgba(255,255,255,0.06);color:#e6edf7;border:1px solid rgba(255,255,255,0.10);border-radius:8px;cursor:default;text-align:left;}",
      "#mission-control .mc-todays-tile.is-link{cursor:pointer;}",
      "#mission-control .mc-todays-tile.is-link:hover{background:rgba(255,255,255,0.10);border-color:rgba(255,255,255,0.18);}",
      "#mission-control .mc-todays-tile-value{font-size:24px;font-weight:800;line-height:1;color:#fff;}",
      "#mission-control .mc-todays-tile-label{font-size:11.5px;color:#a8c0e1;letter-spacing:0.3px;text-transform:uppercase;font-weight:600;}",
      "#mission-control .mc-healthy-hidden .mc-healthy-hidden-body{padding-top:8px;}",
      "#mission-control .mc-healthy-hidden-h{margin:10px 0 6px;font-size:12px;font-weight:700;color:#a8c0e1;text-transform:uppercase;letter-spacing:0.5px;}",
      "#mission-control .mc-inbox-count[data-bucket='needs-action'] .mc-inbox-count-value{color:#fecaca;}",
      "#mission-control .mc-inbox-count[data-bucket='system-setup'] .mc-inbox-count-value{color:#c7d8f5;}",
      "#mission-control .mc-inbox-count[data-bucket='healthy'] .mc-inbox-count-value{color:#bbf7d0;}",
      "@media (max-width:720px){#mission-control .mc-todays-grid{grid-template-columns:repeat(2,1fr);}#mission-control .mc-todays-tile-value{font-size:20px;}}",
      "#mission-control .mc-inbox-sev-count{font-size:11.5px;font-weight:600;color:#a8c0e1;}",
      "#mission-control .mc-inbox-empty{margin:10px 14px;font-size:12.5px;color:#a8c0e1;}",
      "#mission-control .mc-inbox-healthy{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;}",
      "#mission-control .mc-inbox-healthy-chip{font-size:11.5px;color:#bbf7d0;background:rgba(34,197,94,0.16);border:1px solid rgba(34,197,94,0.30);border-radius:999px;padding:3px 10px;}",
      /* ---- Inbox row ---- */
      "#mission-control .mc-inbox-row{padding:6px 14px;border-top:1px solid rgba(255,255,255,0.05);}",
      "#mission-control .mc-inbox-row:first-of-type{border-top:none;}",
      "#mission-control .mc-inbox-row-line{display:flex;align-items:center;gap:6px;min-width:0;font-size:13.5px;line-height:1.3;}",
      "#mission-control .mc-inbox-sev-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}",
      "#mission-control .mc-inbox-sev-dot[data-severity='RED']{background:#ef4444;}",
      "#mission-control .mc-inbox-sev-dot[data-severity='YELLOW']{background:#facc15;}",
      "#mission-control .mc-inbox-row-entity{font-weight:700;color:#fff;flex-shrink:0;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      "#mission-control .mc-inbox-row-headline{color:#cdd9ec;flex-shrink:0;}",
      "#mission-control .mc-inbox-row-headline strong{color:#fff;}",
      "#mission-control .mc-inbox-row-summary{color:#94a3b8;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;}",
      "#mission-control .mc-inbox-row-actions{display:flex;gap:4px;margin-left:auto;flex-shrink:0;}",
      /* ---- Buttons ---- */
      "#mission-control .mc-inbox-btn{appearance:none;background:transparent;border:1px solid rgba(255,255,255,0.18);color:#cdd9ec;padding:3px 9px;font-size:11.5px;font-weight:600;border-radius:6px;cursor:pointer;line-height:1.2;}",
      "#mission-control .mc-inbox-btn:hover{background:rgba(255,255,255,0.10);color:#fff;}",
      "#mission-control .mc-inbox-btn-primary{background:rgba(59,123,224,0.85);color:#fff;border-color:#3b7be0;}",
      "#mission-control .mc-inbox-btn-primary:hover{background:#3b7be0;}",
      "#mission-control .mc-inbox-btn-danger{border-color:rgba(239,68,68,0.5);color:#fecaca;background:rgba(239,68,68,0.18);}",
      "#mission-control .mc-inbox-btn-danger:hover{background:rgba(239,68,68,0.32);color:#fff;}",
      "#mission-control .mc-inbox-btn-suppress{border-color:rgba(250,204,21,0.40);color:#fde68a;}",
      "#mission-control .mc-inbox-btn-suppress:hover{background:rgba(250,204,21,0.18);color:#fff;}",
      "#mission-control .mc-inbox-btn-mini{padding:2px 7px;font-size:10.5px;}",
      "#mission-control .mc-inbox-row[data-expanded='true']{background:rgba(255,255,255,0.03);}",
      /* ---- Row details + subitems ---- */
      "#mission-control .mc-inbox-row-details{padding:10px 14px 14px;border-top:1px dashed rgba(255,255,255,0.10);margin-top:6px;}",
      "#mission-control .mc-inbox-row-details-intro{margin:0 0 8px;font-size:12px;color:#a8c0e1;font-style:italic;}",
      "#mission-control .mc-inbox-subitem{padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:8px;}",
      "#mission-control .mc-inbox-subitem:last-child{margin-bottom:8px;}",
      "#mission-control .mc-inbox-subitem-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      "#mission-control .mc-inbox-subitem-ctx{font-size:12.5px;color:#cdd9ec;font-weight:600;flex:1 1 auto;min-width:0;}",
      "#mission-control .mc-inbox-subitem-reason{margin:4px 0 0;font-size:12px;color:#a8c0e1;line-height:1.45;}",
      "#mission-control .mc-inbox-subitem-fix{margin:4px 0 0;font-size:12px;color:#e6edf7;}",
      "#mission-control .mc-inbox-fix-label{font-weight:800;letter-spacing:0.6px;color:#fde68a;margin-right:6px;font-size:10.5px;}",
      "#mission-control .mc-inbox-group-actions{display:flex;gap:6px;flex-wrap:wrap;padding-top:4px;margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);}",
      "#mission-control .mc-confirm-bar{margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}",
      "#mission-control .mc-confirm-label{font-size:12px;color:#cdd9ec;margin-right:4px;}",
      /* ---------- Phase 33D — hint chip + tighter spacing ---------- */
      "#mission-control{margin-bottom:8px;}",
      "#mission-control .mc-inbox-row-hint{margin:2px 0 4px 18px;font-size:11px;color:#7ea3d6;font-style:italic;letter-spacing:0.2px;}",
      "#mission-control .mc-inbox-details-toggle[data-mc-noise='toggle-details']{min-width:64px;text-align:center;}"
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

  /* ---------- Phase 33C — Inbox Mode helpers ---------- */

  // Group items by category + entity. A "group" is what the inbox row
  // represents — e.g., all 4 "blocked-shift-bridge-skipped" alerts for
  // Gene F. collapse into one row. Aggregate alerts (entityType ===
  // "aggregate") naturally collapse to a single-item group already.
  function groupByEntity(items) {
    const groupsByKey = {};
    const orderedKeys = [];
    items.forEach(it => {
      const key = it.category + "::" + (it.entityType || "any") + "::" + (it.entityId || "any");
      if (!groupsByKey[key]) {
        groupsByKey[key] = {
          groupKey:    key,
          severity:    it.severity,
          category:    it.category,
          title:       it.title,
          entityType:  it.entityType,
          entityId:    it.entityId,
          entityName:  it.entityName || it.subject || "(unknown)",
          actionLabel: it.actionLabel,
          actionRoute: it.actionRoute,
          items:       []
        };
        orderedKeys.push(key);
      }
      groupsByKey[key].items.push(it);
    });
    return orderedKeys.map(k => groupsByKey[k]);
  }

  // Derive top N priorities for the "Top priorities" banner. Sorts by
  // severity (RED first) then by group count desc. Returns formatted
  // human strings. Uses the existing category copy — no AI.
  function deriveTopPriorities(groups, max) {
    const sorted = groups.slice().sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "RED" ? -1 : 1;
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return 0;
    });
    return sorted.slice(0, max).map(g => formatPriorityLine(g));
  }
  function formatPriorityLine(g) {
    // Aggregate categories — their subject already reads naturally.
    if (g.entityType === "aggregate") {
      const first = g.items[0] || {};
      return first.title + (first.subject ? " — " + first.subject : "");
    }
    const n = g.items.length;
    const noun = humanCategoryNoun(g.category, n);
    return g.entityName + " has " + n + " " + noun + ".";
  }
  function humanCategoryNoun(category, count) {
    const map = {
      "blocked-shift-bridge-skipped": "blocked shift",
      "blocked-shift-noemail":        "blocked shift (missing email)",
      "blocked-shift-no-tech-doc":    "blocked shift (no tech record)",
      "blocked-shift-tech-archived":  "blocked shift (tech archived)",
      "unmapped-customer":            "unmapped customer shift",
      "missed-shift":                 "missed shift",
      "stuck-clock":                  "stuck clock-in",
      "missing-dcr":                  "missing DCR",
      "paused-shift":                 "paused shift",
      "time-adjustment":              "pending time-adjustment request"
    };
    const base = map[category] || category.replace(/-/g, " ");
    return count === 1 ? base : base + "s";
  }

  function summarizeGroupContexts(g, maxNames) {
    // For the collapsed inbox row, show a short comma list of context
    // markers (customer names / dates / etc.) to give scanability without
    // expanding. Aggregates use their subject text directly.
    if (g.entityType === "aggregate") {
      return (g.items[0] && g.items[0].subject) || "";
    }
    const ctx = g.items.map(it => extractRowSummary(it)).filter(Boolean);
    const cap = maxNames || 3;
    const head = ctx.slice(0, cap).join(", ");
    const rest = ctx.length - cap;
    return rest > 0 ? head + ", +" + rest + " more" : head;
  }
  function extractRowSummary(item) {
    // Prefer the customer-name slice from context ("Vehr's · Tonight 1:30 PM" → "Vehr's")
    if (item.context) {
      const firstSeg = String(item.context).split(" · ")[0];
      if (firstSeg) return firstSeg;
    }
    return item.subject || "";
  }

  // V20260616 — Operator-friendly bucket classifier.
  // Splits the existing alert categories into two operator-visible
  // sections per the redesign brief:
  //   "needs_action"  — real cleaning/customer/payroll items
  //   "system_setup"  — configuration / Deputy / data hygiene
  // No new alerts are introduced; this is a pure rebucketing pass over
  // existing model.items[].category values.
  function bucketForCategory(cat) {
    const c = String(cat || "").toLowerCase();
    if (c.indexOf("blocked-shift") === 0) return "system_setup";
    if (c === "unmapped-customer")       return "system_setup";
    if (c === "customer-config")         return "system_setup";
    return "needs_action";
  }

  // V20260616 — Today's Operations stat strip. Glanceable + neutral.
  // All values are derived from the existing snapshot — no new reads.
  // Office Messages is wired in via the deps bridge if the office
  // issues tab has populated; otherwise renders as "—".
  function buildTodaysOpsTiles(snap) {
    const todayPT = snap && snap.todayPT;
    const scheduled = (snap && snap.assignments)
      ? snap.assignments.filter(a => a && a.service_date === todayPT && !isQaTestAssignment(a)).length
      : 0;
    const clockedIn = (snap && snap.activeSess) ? snap.activeSess.length : 0;
    const completedToday = (snap && snap.sessions)
      ? snap.sessions.filter(s => s && s.service_date === todayPT && s.status === "completed" && !isQaTestSession(s)).length
      : 0;
    const supplyOpen = (snap && snap.supply)
      ? snap.supply.filter(s => {
          const st = String((s && s.status) || "").toLowerCase();
          return st && st !== "closed" && st !== "received" && st !== "denied" && st !== "fulfilled";
        }).length
      : 0;
    let openIssues = "—";
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      if (deps && typeof deps.getDcrIssues === "function") {
        const arr = deps.getDcrIssues() || [];
        openIssues = arr.filter(i => i && (i.status === "new" || !i.status)).length;
      }
    } catch (_e) {}
    let openOfficeMsg = "—";
    try {
      const tabs = window.__pioneerAdmin && window.__pioneerAdmin.tabs;
      if (tabs && tabs.officeIssues && typeof tabs.officeIssues.getCount === "function") {
        openOfficeMsg = tabs.officeIssues.getCount("open");
      }
    } catch (_e) {}

    function tile(label, value, tab, dataset) {
      const onclick = tab ? ' data-mc-action-route="' + escapeHtml(tab) + '"' : '';
      const cls = tab ? "mc-todays-tile is-link" : "mc-todays-tile";
      return '<button type="button" class="' + cls + '"' + onclick + ' data-mc-stat="' + escapeHtml(dataset || "") + '">' +
               '<span class="mc-todays-tile-value">' + escapeHtml(String(value)) + '</span>' +
               '<span class="mc-todays-tile-label">' + escapeHtml(label) + '</span>' +
             '</button>';
    }
    return '<div class="mc-todays-ops" aria-label="Today\'s Operations">' +
             '<header class="mc-todays-head">' +
               '<span class="mc-todays-eyebrow">1 · Today\'s Operations</span>' +
               '<span class="mc-todays-sub">Pacific calendar day, neutral status</span>' +
             '</header>' +
             '<div class="mc-todays-grid">' +
               tile("Scheduled shifts",  scheduled,      "yesterday",      "scheduled") +
               tile("Clocked in",        clockedIn,      "yesterday",      "clocked_in") +
               tile("Completed DCRs",    completedToday, "dcrs",           "completed_dcrs") +
               tile("Open issues",       openIssues,     "issues",         "open_issues") +
               tile("Supply requests",   supplyOpen,     "supply",         "supply_open") +
               tile("Office messages",   openOfficeMsg,  "office-issues",  "office_messages") +
             '</div>' +
           '</div>';
  }

  // Defensive QA-test filters for the snapshot tiles — same intent as
  // the existing isQaTestSession helper but covering assignments too.
  // Conservative: skip ONLY if the customer slug includes "test" or
  // assignment is_test flag set. The mission-control alert pipeline
  // already filters QA noise in its own paths.
  function isQaTestAssignment(a) {
    if (!a) return false;
    if (a.is_test === true) return true;
    const slug = String((a.customer_id || a.customer_slug || "")).toLowerCase();
    if (!slug) return false;
    return slug.indexOf("test") >= 0 && slug.indexOf("pioneer") >= 0;
  }

  function render(model, opsWindow, snap) {
    ensureStyles();
    const root = $("mission-control");
    if (!root) return;

    // ---- Phase 33A — noise control filter (unchanged) ----
    const dismissals  = (snap && snap.dismissals)   || [];
    const suppressions= (snap && snap.suppressions) || [];
    const nowMs = (snap && snap.now) || Date.now();
    const allItems = model.items.slice();
    const hiddenByDismissal = [];
    const hiddenBySuppression = [];
    const visibleAfterFilter = [];
    allItems.forEach(it => {
      const dis = dismissalActiveFor(it.alertKey, dismissals, nowMs);
      if (dis) { hiddenByDismissal.push({ item: it, dismissal: dis }); return; }
      const sup = suppressionActiveFor(it, suppressions);
      if (sup) { hiddenBySuppression.push({ item: it, suppression: sup }); return; }
      visibleAfterFilter.push(it);
    });

    const items = visibleAfterFilter.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "RED" ? -1 : 1;
      return String(a.category).localeCompare(String(b.category));
    });
    const totalAlerts  = items.length;
    const hiddenCount  = hiddenByDismissal.length + hiddenBySuppression.length;
    const healthyCount = (model.healthy || []).length;

    /* ---- V20260616 — group + bucket by operator-friendly category ----
     * Replaces the prior severity-only split. Same item bodies, same
     * dismiss/snooze/suppress wiring, same row HTML — just routed to
     * Needs Action vs System Setup based on bucketForCategory(). */
    const allGroups   = groupByEntity(items);
    const needsActionGroups = allGroups.filter(g => bucketForCategory(g.category) === "needs_action");
    const systemSetupGroups = allGroups.filter(g => bucketForCategory(g.category) === "system_setup");
    const topPriorities     = deriveTopPriorities(allGroups, 3);

    const needsActionCount = needsActionGroups.reduce((acc, g) => acc + g.items.length, 0);
    const systemSetupCount = systemSetupGroups.reduce((acc, g) => acc + g.items.length, 0);

    /* ---- V20260616 — operator-friendly summary ---- */
    const countTiles =
      '<div class="mc-inbox-summary">' +
        '<div class="mc-inbox-count" data-bucket="needs-action">' +
          '<span class="mc-inbox-count-label">Needs action</span>' +
          '<span class="mc-inbox-count-value">' + needsActionCount + '</span>' +
        '</div>' +
        '<div class="mc-inbox-count" data-bucket="system-setup">' +
          '<span class="mc-inbox-count-label">System setup</span>' +
          '<span class="mc-inbox-count-value">' + systemSetupCount + '</span>' +
        '</div>' +
        '<div class="mc-inbox-count" data-bucket="healthy">' +
          '<span class="mc-inbox-count-label">Healthy</span>' +
          '<span class="mc-inbox-count-value">' + healthyCount + '</span>' +
        '</div>' +
        (hiddenCount > 0
          ? '<div class="mc-inbox-count is-dim"><span class="mc-inbox-count-label">Hidden</span><span class="mc-inbox-count-value">' + hiddenCount + '</span></div>'
          : "") +
      '</div>';

    const priorityBlock = topPriorities.length === 0
      ? '<div class="mc-inbox-priorities is-clean">All clear — no priorities right now.</div>'
      : '<ol class="mc-inbox-priorities">' +
          topPriorities.map(p => '<li>' + escapeHtml(p) + '</li>').join("") +
        '</ol>';

    /* ---- Inbox row builder ---- */
    function rowHtml(g) {
      const summary = summarizeGroupContexts(g, 3);
      const countTag = g.items.length > 1 ? ' · <strong>' + g.items.length + '×</strong>' : "";
      const openBtn = g.actionRoute
        ? '<button type="button" class="mc-inbox-btn mc-inbox-btn-primary" data-mc-action-route="' +
          escapeHtml(g.actionRoute) + '">' + escapeHtml(g.actionLabel || "Open") + '</button>'
        : '';
      // Expanded subitems list — each row's context + reason/fix collapsed
      // into compact paragraphs. Per-item alertKeys ride along as data
      // attributes so per-row Dismiss/Snooze can target one instance.
      const subItems = g.items.map(it => {
        const k = escapeHtml(it.alertKey || "");
        return (
          '<div class="mc-inbox-subitem" data-key="' + k + '">' +
            '<div class="mc-inbox-subitem-head">' +
              (it.context ? '<span class="mc-inbox-subitem-ctx">' + escapeHtml(it.context) + '</span>' : '') +
              '<button type="button" class="mc-inbox-btn mc-inbox-btn-mini" data-mc-noise="dismiss-prompt" data-key="' + k + '">Dismiss</button>' +
              '<button type="button" class="mc-inbox-btn mc-inbox-btn-mini" data-mc-noise="snooze-prompt"  data-key="' + k + '">Snooze</button>' +
            '</div>' +
            (it.reason ? '<p class="mc-inbox-subitem-reason">' + escapeHtml(it.reason) + '</p>' : '') +
            (it.fix    ? '<p class="mc-inbox-subitem-fix"><span class="mc-inbox-fix-label">FIX</span>' + escapeHtml(it.fix) + '</p>' : '') +
          '</div>'
        );
      }).join("");
      // Group-level Suppress always points at the same (category, entity)
      // bucket — one click suppresses every row in this group.
      const firstKey = escapeHtml((g.items[0] && g.items[0].alertKey) || "");
      const groupActions =
        '<div class="mc-inbox-group-actions">' +
          '<button type="button" class="mc-inbox-btn mc-inbox-btn-suppress" data-mc-noise="suppress-prompt" data-key="' + firstKey + '">Suppress Similar</button>' +
          (g.items.length > 1
            ? '<button type="button" class="mc-inbox-btn" data-mc-group-action="dismiss-all-prompt" data-group-key="' + escapeHtml(g.groupKey) + '">Dismiss All</button>'
            : '') +
        '</div>';

      const expandHint = g.items.length > 1
        ? '<div class="mc-inbox-row-hint">' + g.items.length + ' alerts — expand to review all</div>'
        : '';
      return (
        '<article class="mc-inbox-row" data-severity="' + escapeHtml(g.severity) + '" data-group-key="' + escapeHtml(g.groupKey) + '" data-expanded="false">' +
          '<div class="mc-inbox-row-line">' +
            '<span class="mc-inbox-sev-dot" data-severity="' + escapeHtml(g.severity) + '" title="' + escapeHtml(g.severity) + '"></span>' +
            '<span class="mc-inbox-row-entity">' + escapeHtml(g.entityName) + '</span>' +
            '<span class="mc-inbox-row-headline"> · ' + escapeHtml(g.title) + countTag + '</span>' +
            (summary ? '<span class="mc-inbox-row-summary"> · ' + escapeHtml(summary) + '</span>' : '') +
            '<span class="mc-inbox-row-actions">' +
              openBtn +
              '<button type="button" class="mc-inbox-btn mc-inbox-details-toggle" data-mc-noise="toggle-details" data-key="' + firstKey + '" data-group-key="' + escapeHtml(g.groupKey) + '">Details</button>' +
            '</span>' +
          '</div>' +
          expandHint +
          '<div class="mc-inbox-row-details" hidden>' +
            (g.items.length > 1
              ? '<p class="mc-inbox-row-details-intro">' + g.items.length + ' alerts grouped by ' + escapeHtml(g.entityName) + '. Each can be dismissed individually, or use Suppress Similar to hide all matching alerts going forward.</p>'
              : '') +
            subItems +
            groupActions +
          '</div>' +
        '</article>'
      );
    }

    /* ---- V20260616 — 2 · NEEDS ACTION (customer-facing + payroll) ---- */
    const needsActionSection = needsActionGroups.length === 0
      ? '<details class="mc-inbox-section" data-bucket="needs-action" open>' +
          '<summary>' +
            '<span class="mc-inbox-sev-pill" data-bucket="needs-action">2 · NEEDS ACTION</span>' +
            '<span class="mc-inbox-sev-count">All clear</span>' +
          '</summary>' +
          '<p class="mc-inbox-empty">No customer or payroll-impacting items right now.</p>' +
        '</details>'
      : '<details class="mc-inbox-section" data-bucket="needs-action" open>' +
          '<summary>' +
            '<span class="mc-inbox-sev-pill" data-bucket="needs-action">2 · NEEDS ACTION</span>' +
            '<span class="mc-inbox-sev-count">' + needsActionGroups.length + ' · ' + needsActionCount + ' item' + (needsActionCount === 1 ? '' : 's') + '</span>' +
          '</summary>' +
          needsActionGroups.map(rowHtml).join("") +
        '</details>';

    /* ---- V20260616 — 3 · SYSTEM SETUP ISSUES (config / hygiene) ---- */
    const systemSetupSection = systemSetupGroups.length === 0
      ? '<details class="mc-inbox-section" data-bucket="system-setup">' +
          '<summary>' +
            '<span class="mc-inbox-sev-pill" data-bucket="system-setup">3 · SYSTEM SETUP ISSUES</span>' +
            '<span class="mc-inbox-sev-count">All clear</span>' +
          '</summary>' +
          '<p class="mc-inbox-section-helper">These are setup / configuration issues, not cleaning service issues.</p>' +
          '<p class="mc-inbox-empty">No setup gaps detected.</p>' +
        '</details>'
      : '<details class="mc-inbox-section" data-bucket="system-setup" open>' +
          '<summary>' +
            '<span class="mc-inbox-sev-pill" data-bucket="system-setup">3 · SYSTEM SETUP ISSUES</span>' +
            '<span class="mc-inbox-sev-count">' + systemSetupGroups.length + ' · ' + systemSetupCount + ' item' + (systemSetupCount === 1 ? '' : 's') + '</span>' +
          '</summary>' +
          '<p class="mc-inbox-section-helper">These are setup / configuration issues, not cleaning service issues.</p>' +
          systemSetupGroups.map(rowHtml).join("") +
        '</details>';

    const healthyChips = (model.healthy || []).length === 0
      ? '<p class="mc-inbox-empty">Nothing to celebrate yet.</p>'
      : '<div class="mc-inbox-healthy">' +
          model.healthy.map(h => '<span class="mc-inbox-healthy-chip">' + escapeHtml(h) + '</span>').join("") +
        '</div>';
    const healthySection =
      '<details class="mc-inbox-section" data-severity="GREEN"><summary><span class="mc-inbox-sev-pill" data-severity="GREEN">HEALTHY</span><span class="mc-inbox-sev-count">' + healthyCount + '</span></summary>' +
        healthyChips + '</details>';

    /* ---- Suppressed Alerts collapsible (unchanged) ---- */
    const suppRows = suppressions.filter(s => s.active !== false);
    const supHtml = suppRows.length === 0
      ? '<p class="mc-supp-empty">No active suppression rules.</p>'
      : '<table class="mc-supp-table"><thead><tr>' +
          '<th>Type</th><th>Entity</th><th>Suppressed by</th><th>Date</th><th>Reason</th><th></th>' +
        '</tr></thead><tbody>' +
        suppRows.map(s => {
          return '<tr>' +
            '<td>' + escapeHtml(String(s.alert_type || "").replace(/[-_]/g, " ")) + '</td>' +
            '<td>' + escapeHtml(s.entity_name || s.entity_id || "—") + '</td>' +
            '<td>' + escapeHtml(s.suppressed_by_email || "—") + '</td>' +
            '<td>' + escapeHtml(fmtSuppressionDate(s.suppressed_at)) + '</td>' +
            '<td>' + escapeHtml(s.reason || "") + '</td>' +
            '<td><button type="button" class="mc-supp-reactivate" data-mc-reactivate="' + escapeHtml(s._id) + '">Reactivate</button></td>' +
          '</tr>';
        }).join("") +
        '</tbody></table>';
    const suppressedSection =
      '<details class="mc-suppressions">' +
        '<summary>Suppressed Alerts <span class="mc-supp-count">(' + suppRows.length + ')</span></summary>' +
        '<div class="mc-supp-body">' + supHtml + '</div>' +
      '</details>';

    const warningsHtml = (model.failedReads && model.failedReads.length)
      ? '<div class="mc-warnings">⚠ ' + escapeHtml(model.failedReads.length + " read(s) failed: " + model.failedReads.join("; ")) + '</div>'
      : "";

    /* ---- V20260616 — 4 · HEALTHY / HIDDEN (collapsed by default) ---- */
    const healthyHiddenSection =
      '<details class="mc-inbox-section mc-healthy-hidden" data-bucket="healthy-hidden">' +
        '<summary>' +
          '<span class="mc-inbox-sev-pill" data-bucket="healthy-hidden">4 · HEALTHY / HIDDEN</span>' +
          '<span class="mc-inbox-sev-count">' +
            healthyCount + ' healthy' +
            (hiddenCount > 0 ? ' · ' + hiddenCount + ' hidden' : '') +
            ' · ' + suppRows.length + ' suppressed' +
          '</span>' +
        '</summary>' +
        '<div class="mc-healthy-hidden-body">' +
          '<h4 class="mc-healthy-hidden-h">Healthy checks</h4>' +
          healthyChips +
          '<h4 class="mc-healthy-hidden-h">Suppressed alerts</h4>' +
          '<div class="mc-supp-body">' + supHtml + '</div>' +
        '</div>' +
      '</details>';

    root.innerHTML =
      '<header class="mc-head">' +
        '<div>' +
          '<span class="mc-eyebrow">Mission Control</span>' +
          '<h2 class="mc-title">PioneerOps</h2>' +
          '<p class="mc-window">Ops Day · ' + escapeHtml(fmtOpsWindow(opsWindow)) + '</p>' +
        '</div>' +
        '<button type="button" class="mc-refresh" id="mission-control-refresh">Refresh</button>' +
      '</header>' +
      buildTodaysOpsTiles(snap) +
      countTiles +
      (topPriorities.length > 0
        ? '<div class="mc-inbox-priorities-wrap">' +
            '<div class="mc-inbox-priorities-label">Top priorities</div>' +
            priorityBlock +
          '</div>'
        : '') +
      needsActionSection +
      systemSetupSection +
      healthyHiddenSection +
      warningsHtml;
  }

  function fmtSuppressionDate(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
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

  // Hold the last snapshot's items + groups + lookup maps so action
  // handlers can find what they need without a re-fetch.
  let lastSnap = null;
  let lastItemsByKey = {};
  let lastGroupsByKey = {};

  async function refresh() {
    if (loading) return;
    loading = true;
    if (!loaded) renderLoading();
    try {
      const snap  = await loadSnapshot();
      const model = buildActionItems(snap);
      lastSnap = snap;
      lastItemsByKey = {};
      (model.items || []).forEach(it => { if (it.alertKey) lastItemsByKey[it.alertKey] = it; });
      lastGroupsByKey = {};
      groupByEntity((model.items || []).slice()).forEach(g => { lastGroupsByKey[g.groupKey] = g; });
      render(model, snap.opsWindow, snap);
      loaded = true;
    } catch (err) {
      console.error("[mission-control] load failed", err);
      renderError((err && err.message) || "unknown");
    } finally {
      loading = false;
    }
  }

  /* ---------- Phase 33A — noise-control click handlers ----------
   *
   * In-place inline confirmation. Avoids browser prompt() per spec
   * ("Do not use browser prompt() if avoidable"). Click flow:
   *
   *   Dismiss:           click Dismiss → confirm bar → confirm → write
   *   Snooze:            click Snooze  → duration bar (1d / 7d / 30d) → write
   *   Suppress Similar:  click Suppress → confirm bar (with entity) → confirm → write
   *
   * Each action writes Firestore, then triggers refresh() so the card
   * disappears immediately. All writes are best-effort; failures alert
   * the admin and leave the card visible.
   */

  /* ---------- Phase 33C inbox-mode confirm-bar helpers ---------- */

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/"/g,"&quot;");
  }
  function escText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function removeAnyConfirmBar(scope) {
    if (!scope) return;
    scope.querySelectorAll(".mc-confirm-bar").forEach(el => el.remove());
  }
  function appendConfirmBar(parentEl, html) {
    if (!parentEl) return null;
    // Only one confirm bar per parent at a time — replace if present.
    parentEl.querySelectorAll(":scope > .mc-confirm-bar").forEach(el => el.remove());
    const div = document.createElement("div");
    div.className = "mc-confirm-bar";
    div.innerHTML = html;
    parentEl.appendChild(div);
    return div;
  }

  function buildDismissBarItem(item) {
    return '<span class="mc-confirm-label">Dismiss this alert?</span>' +
      '<button type="button" class="mc-inbox-btn mc-inbox-btn-danger" data-mc-noise="dismiss-confirm" data-key="' + escAttr(item.alertKey) + '">Confirm</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="cancel" data-key="' + escAttr(item.alertKey) + '">Cancel</button>';
  }
  function buildSnoozeBarItem(item) {
    return '<span class="mc-confirm-label">Snooze for:</span>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="snooze-do" data-key="' + escAttr(item.alertKey) + '" data-days="1">1 day</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="snooze-do" data-key="' + escAttr(item.alertKey) + '" data-days="7">7 days</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="snooze-do" data-key="' + escAttr(item.alertKey) + '" data-days="30">30 days</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="cancel" data-key="' + escAttr(item.alertKey) + '">Cancel</button>';
  }
  function buildSuppressBarItem(item) {
    const scopeLabel = (item.entityType === "aggregate")
      ? 'all "' + (item.title || item.category) + '" alerts'
      : 'all "' + (item.title || item.category) + '" alerts for ' + (item.entityName || item.entityId || "this entity");
    return '<span class="mc-confirm-label">Suppress ' + escText(scopeLabel) + '?</span>' +
      '<button type="button" class="mc-inbox-btn mc-inbox-btn-danger" data-mc-noise="suppress-confirm" data-key="' + escAttr(item.alertKey) + '">Confirm</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-noise="cancel" data-key="' + escAttr(item.alertKey) + '">Cancel</button>';
  }
  function buildDismissAllBarGroup(group) {
    return '<span class="mc-confirm-label">Dismiss all ' + group.items.length + ' alerts in this group?</span>' +
      '<button type="button" class="mc-inbox-btn mc-inbox-btn-danger" data-mc-group-action="dismiss-all-confirm" data-group-key="' + escAttr(group.groupKey) + '">Confirm</button>' +
      '<button type="button" class="mc-inbox-btn" data-mc-group-action="cancel" data-group-key="' + escAttr(group.groupKey) + '">Cancel</button>';
  }

  async function applyDismissal(item, opts) {
    const db = firebase.firestore();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const expiresAt = (opts && opts.expiresMs)
      ? firebase.firestore.Timestamp.fromMillis(opts.expiresMs)
      : null;
    const me = firebase.auth().currentUser;
    await db.collection("mission_control_alert_dismissals").doc(item.alertKey).set({
      alert_key:        item.alertKey,
      alert_type:       item.category,
      entity_type:      item.entityType || null,
      entity_id:        item.entityId   || null,
      entity_name:      item.entityName || null,
      dismissed_by_uid:   me ? me.uid   : null,
      dismissed_by_email: me ? me.email : null,
      dismissed_at:     now,
      reason:           (opts && opts.reason) || null,
      expires_at:       expiresAt,
      snooze_days:      (opts && opts.days) || null
    });
  }
  async function applySuppression(item) {
    const db = firebase.firestore();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const me = firebase.auth().currentUser;
    // Doc id = alert_type + entity_type + entity_id so re-suppressing
    // the same scope upserts cleanly. Aggregates collapse to alert_type only.
    const id = item.entityType === "aggregate"
      ? "agg__" + item.category
      : item.category + "__" + (item.entityType || "any") + "__" + (item.entityId || "any");
    await db.collection("mission_control_alert_suppressions").doc(id).set({
      alert_type:         item.category,
      entity_type:        item.entityType || null,
      entity_id:          item.entityId   || null,
      entity_name:        item.entityName || null,
      suppressed_by_uid:   me ? me.uid   : null,
      suppressed_by_email: me ? me.email : null,
      suppressed_at:      now,
      reason:             null,
      active:             true
    }, { merge: true });
  }
  async function reactivateSuppression(suppId) {
    const db = firebase.firestore();
    await db.collection("mission_control_alert_suppressions").doc(suppId).update({
      active:           false,
      reactivated_at:   firebase.firestore.FieldValue.serverTimestamp(),
      reactivated_by_email: (firebase.auth().currentUser && firebase.auth().currentUser.email) || null
    });
  }

  // Phase 33C — group dismissal. Writes one dismissal doc per alertKey
  // in the group, batched. Used by the "Dismiss All" group action.
  async function applyDismissalGroup(group, opts) {
    if (!group || !group.items || !group.items.length) return;
    const db = firebase.firestore();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const expiresAt = (opts && opts.expiresMs)
      ? firebase.firestore.Timestamp.fromMillis(opts.expiresMs)
      : null;
    const me = firebase.auth().currentUser;
    const batch = db.batch();
    group.items.forEach(item => {
      if (!item.alertKey) return;
      const ref = db.collection("mission_control_alert_dismissals").doc(item.alertKey);
      batch.set(ref, {
        alert_key:          item.alertKey,
        alert_type:         item.category,
        entity_type:        item.entityType || null,
        entity_id:          item.entityId   || null,
        entity_name:        item.entityName || null,
        dismissed_by_uid:   me ? me.uid   : null,
        dismissed_by_email: me ? me.email : null,
        dismissed_at:       now,
        reason:             (opts && opts.reason) || null,
        expires_at:         expiresAt,
        snooze_days:        (opts && opts.days) || null,
        group_dismissal:    true
      });
    });
    await batch.commit();
  }

  function wireClicks() {
    document.addEventListener("click", async function (ev) {
      // Refresh
      const refreshBtn = ev.target.closest("#mission-control-refresh");
      if (refreshBtn) { refresh(); return; }

      // Re-activate a suppression
      const reactivateBtn = ev.target.closest("#mission-control [data-mc-reactivate]");
      if (reactivateBtn) {
        const id = reactivateBtn.getAttribute("data-mc-reactivate");
        if (!id) return;
        try { await reactivateSuppression(id); refresh(); }
        catch (err) { alert("Couldn't reactivate: " + (err.message || err)); }
        return;
      }

      /* -------- Group-level actions (dismiss-all, cancel on group bar) -------- */
      const groupBtn = ev.target.closest("#mission-control [data-mc-group-action]");
      if (groupBtn) {
        const action = groupBtn.getAttribute("data-mc-group-action");
        const groupKey = groupBtn.getAttribute("data-group-key");
        const group = lastGroupsByKey[groupKey];
        if (!group) return;
        try {
          if (action === "dismiss-all-prompt") {
            const groupActionsEl = groupBtn.closest(".mc-inbox-group-actions");
            appendConfirmBar(groupActionsEl, buildDismissAllBarGroup(group));
          } else if (action === "dismiss-all-confirm") {
            await applyDismissalGroup(group);
            refresh();
          } else if (action === "cancel") {
            const groupActionsEl = groupBtn.closest(".mc-inbox-group-actions");
            removeAnyConfirmBar(groupActionsEl);
          }
        } catch (err) {
          alert("Couldn't update: " + (err.message || err));
        }
        return;
      }

      /* -------- Per-item noise controls (Phase 33A buttons preserved) -------- */
      const noiseBtn = ev.target.closest("#mission-control [data-mc-noise]");
      if (noiseBtn) {
        const action = noiseBtn.getAttribute("data-mc-noise");
        const key    = noiseBtn.getAttribute("data-key");
        const row    = noiseBtn.closest(".mc-inbox-row");
        const subitem= noiseBtn.closest(".mc-inbox-subitem");
        const item   = key ? lastItemsByKey[key] : null;

        // Toggle Details — independent of any item key (works on group level)
        if (action === "toggle-details") {
          if (!row) return;
          const expanded = row.getAttribute("data-expanded") === "true";
          const nowExpanded = !expanded;
          row.setAttribute("data-expanded", nowExpanded ? "true" : "false");
          const panel = row.querySelector(".mc-inbox-row-details");
          if (panel) panel.hidden = !nowExpanded;
          // Phase 33D — flip the button label so the affordance is obvious.
          const toggleBtn = row.querySelector(".mc-inbox-details-toggle");
          if (toggleBtn) toggleBtn.textContent = nowExpanded ? "Hide Details" : "Details";
          // The hint chip is only useful while collapsed.
          const hint = row.querySelector(".mc-inbox-row-hint");
          if (hint) hint.hidden = nowExpanded;
          return;
        }
        // Cancel — remove the confirm bar from whichever scope hosts it.
        if (action === "cancel") {
          if (subitem) removeAnyConfirmBar(subitem);
          else if (row) removeAnyConfirmBar(row.querySelector(".mc-inbox-group-actions"));
          return;
        }
        if (!item) return;
        try {
          if (action === "dismiss-prompt") {
            appendConfirmBar(subitem, buildDismissBarItem(item));
          } else if (action === "dismiss-confirm") {
            await applyDismissal(item);
            refresh();
          } else if (action === "snooze-prompt") {
            appendConfirmBar(subitem, buildSnoozeBarItem(item));
          } else if (action === "snooze-do") {
            const days = parseInt(noiseBtn.getAttribute("data-days") || "0", 10);
            if (!days) return;
            await applyDismissal(item, { days: days, expiresMs: Date.now() + days * 86400000 });
            refresh();
          } else if (action === "suppress-prompt") {
            // Suppress lives at the group-actions level. The button is
            // wired with the first item's key (the group's category +
            // entity is what matters; any item in the group has the
            // same category+entity, so the first works fine).
            const groupActions = row && row.querySelector(".mc-inbox-group-actions");
            appendConfirmBar(groupActions, buildSuppressBarItem(item));
          } else if (action === "suppress-confirm") {
            await applySuppression(item);
            refresh();
          }
        } catch (err) {
          alert("Couldn't update: " + (err.message || err));
        }
        return;
      }

      // Route-to-tab buttons (existing behavior).
      // Kirby usability fix — Mission Control sits at the top of /admin
      // and the activated tab panel lives below the fold. The button
      // was firing correctly; the user just couldn't tell because the
      // visual change happened off-screen. Scroll the activated panel
      // into view so the action is visibly acknowledged. Silent catch
      // around activateTab replaced with a console.error so future
      // activation failures aren't hidden.
      const actionBtn = ev.target.closest("#mission-control [data-mc-action-route]");
      if (!actionBtn) return;
      const route = actionBtn.getAttribute("data-mc-action-route");
      if (!route) return;
      try {
        activateTab(route);
        const targetPanel = document.querySelector(
          '.admin-panel[data-panel="' + route + '"]'
        );
        if (targetPanel) {
          targetPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          console.warn('[mission-control] no panel found for route "' + route + '"');
        }
      } catch (err) {
        console.error('[mission-control] tab activation failed for "' + route + '"', err);
      }
    });
  }

  function init() { wireClicks(); }

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.missionControl = { init: init, refresh: refresh };
}());
