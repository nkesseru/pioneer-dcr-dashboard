/* Pioneer Office Manager Mission Control — Phase 1A.
 *
 * Standalone management dashboard. Desktop-first. Read-only over five
 * existing PioneerOps collections + four new "office_manager_*"
 * collections for management observations.
 *
 * Auth gate: any admin (root allowlist OR /admins/{email} Firestore
 * row with active != false). Mirrors admin.html's auth pattern so
 * adding/removing managers in /admin → Admins also gates this surface.
 *
 * Reads (live, on load + on user refresh):
 *   STAFFING HEALTH
 *     • open_shifts                        — where status != "closed"
 *     • call_outs                          — where status not in
 *                                            ["resolved", "closed"] OR
 *                                            created in last 7 days
 *     • pioneer_service_sessions           — "missed punches" = completed
 *                                            with no clock_out_at
 *     • time_adjustment_requests           — where status == "pending"
 *   CUSTOMER HEALTH
 *     • dcr_issues                         — where status != "closed"
 *                                            (open building concerns);
 *                                            repeat = same customer_slug
 *                                            appearing >= 2 times in 30 d
 *     • supply_requests                    — where status != "closed"
 *     • pioneer_service_sessions           — "missing DCRs" = status =
 *                                            completed AND no dcr_id /
 *                                            dcr_submission_id
 *   ADMIN HEALTH
 *     • payroll_exports                    — active count
 *     • time_adjustment_requests           — pending (also feeds staffing)
 *     • cleaning_techs                     — onboarding-incomplete proxy
 *     • pioneer_improvements               — open employee concerns
 *
 * Writes (admin-only via Firestore rules):
 *   • office_manager_reflections           — doc id <uid>__<YYYY-MM-DD>
 *   • office_manager_bottlenecks           — doc id <uid>__<YYYY-MM-DD>
 *   • office_manager_weekly_reviews        — doc id `<YYYY>-W<WW>`
 *   • office_manager_improvements          — auto-id
 *
 * No AI. No GHL. No QuickBooks. Hooks for future expansion are the
 * collection schemas + the section data shapes, which are deliberately
 * simple so a future agent can extend without restructuring.
 */
(function () {
  "use strict";

  /* ---------- auth allowlist (mirrors firestore.rules + admin.js) ---------- */

  const ROOT_ADMIN_EMAILS = [
    "nick@pioneercomclean.com",
    "april@pioneercomclean.com",
    "kirby@pioneercomclean.com",
    "mgies@pioneercomclean.com"
  ];

  /* ---------- helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return Number(ts) || 0;
  }
  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit"
    }).format(d || new Date());
  }
  function fmtPacificDateTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtTodayLong() {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "long", day: "numeric"
      }).format(new Date());
    } catch (_e) { return ""; }
  }
  // ISO week id "YYYY-WNN" anchored on the Pacific date. Used as the doc
  // id for office_manager_weekly_reviews so re-saving the same week
  // upserts rather than duplicating.
  function isoWeekId(yyyymmdd) {
    const parts = String(yyyymmdd).split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);              // Thursday of the week
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
  }

  /* ---------- auth screen ---------- */

  function showAuthState(state, opts) {
    ["checking", "signin", "denied", "content"].forEach(function (s) {
      const el = $("auth-" + s);
      if (!el) return;
      el.hidden = s !== state;
    });
    if (state === "denied") {
      const denied = $("auth-denied-email");
      if (denied && opts && opts.email) denied.textContent = opts.email;
    }
  }

  function isRootAdmin(email) {
    if (!email) return false;
    const lc = String(email).toLowerCase().trim();
    return ROOT_ADMIN_EMAILS.indexOf(lc) >= 0;
  }
  async function resolveAdminStatus(email) {
    if (isRootAdmin(email)) return { ok: true };
    try {
      const lc = String(email).toLowerCase().trim();
      const snap = await firebase.firestore().collection("admins").doc(lc).get();
      if (snap.exists && snap.data() && snap.data().active !== false) return { ok: true };
    } catch (err) {
      console.warn("admins lookup failed", err && err.code);
    }
    return { ok: false };
  }

  let currentUser = null;
  async function handleAuthChange(user) {
    if (!user) {
      currentUser = null;
      showAuthState("signin");
      return;
    }
    const status = await resolveAdminStatus(user.email || "");
    if (!status.ok) {
      currentUser = null;
      showAuthState("denied", { email: user.email || "(no email)" });
      return;
    }
    currentUser = user;
    showAuthState("content");
    paintHero();
    refreshAll();
  }

  function paintHero() {
    const g = $("manager-greeting");
    if (g) {
      const first = (currentUser.displayName || "").split(/\s+/)[0] || (currentUser.email || "").split("@")[0];
      g.textContent = "Hi, " + (first || "Manager");
    }
    const today = $("manager-today-label");
    if (today) today.textContent = fmtTodayLong();
  }

  /* ---------- data fetches ---------- */

  async function loadEverything() {
    const db = firebase.firestore();
    const todayPT     = pacificDateString();
    const yesterdayPT = (function () {
      const d = new Date(todayPT + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }());
    const sevenDaysAgo  = Date.now() - 7 * 86400000;
    const thirtyDaysAgo = Date.now() - 30 * 86400000;

    function safe(label, p) {
      return p.then(
        (val) => ({ ok: true, val }),
        (err) => ({ ok: false, err: (err && err.message) || String(err), label })
      );
    }

    const reads = await Promise.all([
      // 0. open_shifts
      safe("open_shifts", db.collection("open_shifts").get()),
      // 1. call_outs (recent + open)
      safe("call_outs", db.collection("call_outs").orderBy("created_at", "desc").limit(50).get()),
      // 2. pioneer_service_sessions for last 7 days
      safe("sessions", db.collection("pioneer_service_sessions")
        .where("service_date", ">=", new Date(sevenDaysAgo).toISOString().slice(0,10))
        .where("service_date", "<=", todayPT).get()),
      // 3. time_adjustment_requests pending
      safe("time_adj", db.collection("time_adjustment_requests")
        .where("status", "==", "pending").get()),
      // 4. dcr_issues recent (last 30d) for repeats + open count
      safe("dcr_issues", db.collection("dcr_issues").orderBy("created_at", "desc").limit(200).get()),
      // 5. supply_requests (all — small set)
      safe("supply", db.collection("supply_requests").get()),
      // 6. cleaning_techs (onboarding proxy)
      safe("techs", db.collection("cleaning_techs").get()),
      // 7. payroll_exports active
      safe("payroll_exports", db.collection("payroll_exports").where("status","==","active").get()),
      // 8. pioneer_improvements (employee concerns channel)
      safe("improvements", db.collection("pioneer_improvements")
        .orderBy("created_at", "desc").limit(50).get()),
      // 9. office_manager_reflections — recent history (last 14)
      safe("om_reflections", db.collection("office_manager_reflections")
        .orderBy("created_at", "desc").limit(14).get()),
      // 10. office_manager_bottlenecks — recent
      safe("om_bottlenecks", db.collection("office_manager_bottlenecks")
        .orderBy("created_at", "desc").limit(14).get()),
      // 11. office_manager_improvements — recent
      safe("om_improvements", db.collection("office_manager_improvements")
        .orderBy("created_at", "desc").limit(14).get()),
      // 12. current week's office_manager_weekly_reviews doc
      safe("om_week", db.collection("office_manager_weekly_reviews")
        .doc(isoWeekId(todayPT)).get())
    ]);

    function docs(idx) {
      const r = reads[idx];
      if (!r.ok) return null;
      if (r.val.docs) return r.val.docs.map(d => Object.assign({ _id: d.id }, d.data() || {}));
      // Single doc.get()
      return r.val.exists ? Object.assign({ _id: r.val.id }, r.val.data() || {}) : null;
    }

    return {
      todayPT, yesterdayPT, sevenDaysAgo, thirtyDaysAgo,
      weekId:           isoWeekId(todayPT),
      openShifts:       docs(0),
      callOuts:         docs(1),
      sessions:         docs(2),
      timeAdj:          docs(3),
      dcrIssues:        docs(4),
      supply:           docs(5),
      techs:            docs(6),
      payrollExports:   docs(7),
      pioneerImprovements: docs(8),
      omReflections:    docs(9),
      omBottlenecks:    docs(10),
      omImprovements:   docs(11),
      omWeek:           docs(12),
      failedReads:      reads.filter(r => !r.ok).map(r => r.label + ": " + r.err)
    };
  }

  /* ---------- classification + render ---------- */

  function isQaTestSession(s) {
    return !!(s && (s.is_test === true ||
                    s.exclude_from_payroll_export === true ||
                    s.excluded_from_payroll === true));
  }

  function classifyAndRender(snap) {
    // ---- ACTION REQUIRED ----
    const sessions = (snap.sessions || []).filter(s => !isQaTestSession(s));
    const openShifts = (snap.openShifts || []).filter(s => (s.status || "open") !== "closed");
    const openCallOuts = (snap.callOuts || []).filter(c => {
      const status = String(c.status || "open").toLowerCase();
      const recent = tsToMs(c.created_at) >= snap.sevenDaysAgo;
      return recent && status !== "resolved" && status !== "closed";
    });
    const pendingTimeAdj = snap.timeAdj || [];
    const missingDcrSessions = sessions.filter(s =>
      s.status === "completed" && !s.dcr_id && !s.dcr_submission_id);
    const missingPunches = sessions.filter(s =>
      s.status === "completed" && !s.clock_out_at);
    const openDcrIssues = (snap.dcrIssues || []).filter(i => {
      const status = String(i.status || "open").toLowerCase();
      return status !== "closed" && status !== "resolved";
    });
    const openSupply = (snap.supply || []).filter(r =>
      (r.status || "new") !== "closed");
    const activePayrollExports = snap.payrollExports || [];
    const openEmployeeIssues = (snap.pioneerImprovements || []).filter(p => {
      const status = String(p.status || "submitted").toLowerCase();
      return status !== "closed" && status !== "resolved";
    });

    // Repeat customer concerns — same customer_slug with >= 2 dcr_issues
    // in the last 30 days.
    const recentIssues = (snap.dcrIssues || []).filter(i =>
      tsToMs(i.created_at) >= snap.thirtyDaysAgo);
    const concernsByCustomer = {};
    recentIssues.forEach(i => {
      const key = i.customer_slug || i.customer_name || "(unknown)";
      concernsByCustomer[key] = (concernsByCustomer[key] || 0) + 1;
    });
    const repeatConcerns = Object.keys(concernsByCustomer).filter(k =>
      concernsByCustomer[k] >= 2);

    // Today's bottleneck / reflection completion status
    const todayKey = currentUser.uid + "__" + snap.todayPT;
    const todayBottleneck = (snap.omBottlenecks || []).find(b => b._id === todayKey);
    const todayReflection = (snap.omReflections || []).find(r => r._id === todayKey);

    const buckets = { critical: [], attention: [], healthy: [] };

    // Critical
    if (pendingTimeAdj.length > 0) {
      buckets.critical.push({
        label: "Time adjustment requests waiting on you",
        count: pendingTimeAdj.length,
        link: "/admin"
      });
    }
    if (openCallOuts.length > 0) {
      buckets.critical.push({
        label: "Recent call-outs not yet resolved",
        count: openCallOuts.length,
        link: "/admin"
      });
    }
    if (missingPunches.length > 0) {
      buckets.critical.push({
        label: "Completed sessions missing a clock-out punch",
        count: missingPunches.length,
        link: "/admin"
      });
    }
    if (activePayrollExports.length > 0) {
      buckets.critical.push({
        label: "Active payroll exports awaiting action",
        count: activePayrollExports.length,
        link: "/admin"
      });
    }

    // Attention
    if (missingDcrSessions.length > 0) {
      buckets.attention.push({
        label: "Completed shifts without a DCR",
        count: missingDcrSessions.length,
        link: "/admin"
      });
    }
    if (openDcrIssues.length > 0) {
      buckets.attention.push({
        label: "Open building concerns from DCRs",
        count: openDcrIssues.length,
        link: "/admin"
      });
    }
    if (openSupply.length > 0) {
      buckets.attention.push({
        label: "Open supply requests",
        count: openSupply.length,
        link: "/admin"
      });
    }
    if (repeatConcerns.length > 0) {
      buckets.attention.push({
        label: "Customers with repeat concerns (30 d)",
        count: repeatConcerns.length,
        link: "/admin"
      });
    }
    if (openShifts.length > 0) {
      buckets.attention.push({
        label: "Open shifts on the board",
        count: openShifts.length,
        link: "/admin"
      });
    }
    if (openEmployeeIssues.length > 0) {
      buckets.attention.push({
        label: "Open employee concerns / improvements",
        count: openEmployeeIssues.length,
        link: "/admin"
      });
    }
    if (!todayBottleneck) {
      buckets.attention.push({
        label: "Today's bottleneck — not recorded yet",
        count: 1,
        link: "#manager-bottlenecks"
      });
    }
    if (!todayReflection) {
      buckets.attention.push({
        label: "Today's reflection — not submitted yet",
        count: 1,
        link: "#manager-reflection"
      });
    }

    // Healthy ribbon (just what's clean)
    if (pendingTimeAdj.length === 0)         buckets.healthy.push({ label: "No payroll exceptions pending" });
    if (openCallOuts.length === 0)           buckets.healthy.push({ label: "No open call-outs in last 7 days" });
    if (missingPunches.length === 0)         buckets.healthy.push({ label: "All recent sessions clocked out" });
    if (missingDcrSessions.length === 0)     buckets.healthy.push({ label: "All completed shifts have DCRs" });
    if (openSupply.length === 0)             buckets.healthy.push({ label: "All supply requests closed" });
    if (openDcrIssues.length === 0)          buckets.healthy.push({ label: "No open building concerns" });
    if (todayBottleneck && todayReflection)  buckets.healthy.push({ label: "Today's reflection submitted" });

    renderActionRequired(buckets);

    // ---- HIRING HEALTH ----
    renderHiring(snap.omWeek);

    // ---- STAFFING HEALTH ----
    renderStaffing({
      openShifts:     openShifts.length,
      callOuts:       openCallOuts.length,
      missingPunches: missingPunches.length,
      pendingAdj:     pendingTimeAdj.length
    });

    // ---- CUSTOMER HEALTH ----
    renderCustomer({
      openConcerns: openDcrIssues.length,
      openSupply:   openSupply.length,
      repeatCount:  repeatConcerns.length,
      missingDcr:   missingDcrSessions.length
    });

    // ---- ADMIN HEALTH ----
    const onboardingProxy = (snap.techs || [])
      .filter(t => t.active !== false && !t.uid).length;
    renderAdmin({
      activeExports:  activePayrollExports.length,
      pendingApprov:  pendingTimeAdj.length,
      onboardingTodo: onboardingProxy,
      employeeIssues: openEmployeeIssues.length
    });

    // ---- BOTTLENECK history ----
    renderBottleneckHistory(snap.omBottlenecks || [], todayBottleneck);

    // ---- REFLECTION history ----
    renderReflectionHistory(snap.omReflections || [], todayReflection);

    // ---- IMPROVEMENTS history ----
    renderImprovementHistory(snap.omImprovements || []);

    // ---- Failed-read warnings (silent — only logged) ----
    if (snap.failedReads && snap.failedReads.length) {
      console.warn("[manager] read failures:", snap.failedReads);
    }
  }

  /* ---------- renderers ---------- */

  function renderActionRequired(buckets) {
    const root = $("manager-action-list");
    const sub  = $("manager-action-sub");
    const counts = {
      critical:  buckets.critical.length,
      attention: buckets.attention.length,
      healthy:   buckets.healthy.length
    };
    sub.textContent = counts.critical + " critical · " + counts.attention + " attention · " + counts.healthy + " healthy";
    if (counts.critical + counts.attention + counts.healthy === 0) {
      root.innerHTML = '<p class="mgr-empty">All clear — no signals to surface.</p>';
      return;
    }
    function renderBucket(tier, label, items) {
      if (!items.length) return "";
      const itemsHtml = items.map(it => {
        const linkHtml = it.link
          ? '<a href="' + escapeHtml(it.link) + '">Open →</a>'
          : '';
        const countHtml = (typeof it.count === "number" && it.count > 1)
          ? '<span class="mgr-action-count">' + escapeHtml(String(it.count)) + '</span>'
          : '';
        return (
          '<div class="mgr-action-item" data-tier="' + tier + '">' +
            '<span class="mgr-action-label">' + escapeHtml(it.label) + '</span>' +
            '<span>' + countHtml + linkHtml + '</span>' +
          '</div>'
        );
      }).join("");
      return (
        '<div class="mgr-action-bucket" data-tier="' + tier + '">' +
          '<div class="mgr-action-bucket-head"><span class="mgr-action-dot"></span>' + escapeHtml(label) + '</div>' +
          itemsHtml +
        '</div>'
      );
    }
    root.innerHTML =
      renderBucket("critical",  "Critical",       buckets.critical) +
      renderBucket("attention", "Attention Needed", buckets.attention) +
      renderBucket("healthy",   "Healthy",        buckets.healthy);
  }

  function renderHiring(omWeek) {
    const root = $("manager-hiring-display");
    if (!omWeek || !omWeek.hiring) {
      root.innerHTML = '<p class="mgr-empty">No hiring numbers recorded for this week yet. Expand the form below to add them.</p>';
      // Clear form
      $("hiring-applicants-7d").value = "";
      $("hiring-applicants-30d").value = "";
      $("hiring-interviews-sched").value = "";
      $("hiring-interviews-done").value = "";
      $("hiring-working-interviews").value = "";
      $("hiring-hires").value = "";
      return;
    }
    const h = omWeek.hiring;
    // Pre-populate form
    $("hiring-applicants-7d").value         = h.applicants_7d ?? "";
    $("hiring-applicants-30d").value        = h.applicants_30d ?? "";
    $("hiring-interviews-sched").value      = h.interviews_scheduled ?? "";
    $("hiring-interviews-done").value       = h.interviews_completed ?? "";
    $("hiring-working-interviews").value    = h.working_interviews ?? "";
    $("hiring-hires").value                 = h.hires ?? "";
    root.innerHTML =
      '<div class="mgr-metric-grid">' +
        metricHtml("Applicants (7d)",   h.applicants_7d) +
        metricHtml("Applicants (30d)",  h.applicants_30d) +
        metricHtml("Interviews scheduled", h.interviews_scheduled) +
        metricHtml("Interviews completed", h.interviews_completed) +
        metricHtml("Working interviews",   h.working_interviews) +
        metricHtml("Hires",                h.hires, h.hires > 0 ? "healthy" : null) +
      '</div>' +
      '<p style="margin:10px 0 0;font-size:11.5px;color:#64748b;">Saved by ' +
        escapeHtml(omWeek.updated_by_email || "—") + ' · ' +
        escapeHtml(fmtPacificDateTime(omWeek.updated_at)) + '</p>';
  }

  function renderStaffing(s) {
    $("manager-staffing-display").innerHTML =
      '<div class="mgr-metric-grid">' +
        metricHtml("Open shifts",            s.openShifts,     s.openShifts > 0  ? "attention" : "healthy") +
        metricHtml("Recent call-outs",       s.callOuts,       s.callOuts > 0    ? "attention" : "healthy") +
        metricHtml("Missed punches",         s.missingPunches, s.missingPunches > 0 ? "critical" : "healthy") +
        metricHtml("Pending time corrections", s.pendingAdj,   s.pendingAdj > 0  ? "critical" : "healthy") +
      '</div>';
  }

  function renderCustomer(c) {
    $("manager-customer-display").innerHTML =
      '<div class="mgr-metric-grid">' +
        metricHtml("Open building concerns", c.openConcerns,  c.openConcerns > 0 ? "attention" : "healthy") +
        metricHtml("Open supply requests",   c.openSupply,    c.openSupply > 5   ? "attention" : (c.openSupply > 0 ? null : "healthy")) +
        metricHtml("Customers w/ repeat concerns (30d)", c.repeatCount, c.repeatCount > 0 ? "attention" : "healthy") +
        metricHtml("Completed shifts w/o DCR", c.missingDcr,  c.missingDcr > 0   ? "attention" : "healthy") +
      '</div>';
  }

  function renderAdmin(a) {
    $("manager-admin-display").innerHTML =
      '<div class="mgr-metric-grid">' +
        metricHtml("Active payroll exports", a.activeExports, a.activeExports > 0 ? "critical" : "healthy") +
        metricHtml("Pending approvals",      a.pendingApprov, a.pendingApprov > 0 ? "critical" : "healthy") +
        metricHtml("Onboarding incomplete (techs w/o sign-in)", a.onboardingTodo,
          a.onboardingTodo > 0 ? "attention" : "healthy") +
        metricHtml("Open employee concerns", a.employeeIssues, a.employeeIssues > 0 ? "attention" : "healthy") +
      '</div>';
  }

  function metricHtml(label, value, tone) {
    const v = (value == null) ? "—" : String(value);
    const cls = tone ? (" is-" + tone) : "";
    return (
      '<div class="mgr-metric' + cls + '">' +
        '<span class="mgr-metric-label">' + escapeHtml(label) + '</span>' +
        '<span class="mgr-metric-value">' + escapeHtml(v) + '</span>' +
      '</div>'
    );
  }

  function renderBottleneckHistory(list, todayDoc) {
    const root = $("manager-bottleneck-history");
    if (!list.length) {
      root.innerHTML = '<h3>History</h3><p class="mgr-empty">No bottlenecks recorded yet.</p>';
    } else {
      root.innerHTML = '<h3>Last 14 bottlenecks</h3>' + list.map(b => {
        const choiceLabel = ({
          april: "Waiting on April",
          customer: "Waiting on Customer",
          vendor: "Waiting on Vendor",
          nobody: "Waiting on Nobody"
        }[b.choice] || b.choice || "—");
        return (
          '<div class="mgr-history-item">' +
            '<div class="mgr-history-when">' + escapeHtml(fmtPacificDateTime(b.created_at)) +
              " · " + escapeHtml(b.created_by_email || "") + '</div>' +
            '<div><strong>' + escapeHtml(choiceLabel) + '</strong>' +
              (b.note ? ' — ' + escapeHtml(b.note) : '') + '</div>' +
          '</div>'
        );
      }).join("");
    }
    // Highlight today's choice if any
    if (todayDoc) {
      document.querySelectorAll("[data-bottleneck]").forEach(btn => {
        btn.classList.toggle("is-active", btn.getAttribute("data-bottleneck") === todayDoc.choice);
      });
      $("manager-bottleneck-note").value = todayDoc.note || "";
      $("manager-bottleneck-submit").textContent = "Update today's bottleneck";
    } else {
      document.querySelectorAll("[data-bottleneck]").forEach(btn => btn.classList.remove("is-active"));
      $("manager-bottleneck-submit").textContent = "Record today's bottleneck";
    }
  }

  function renderReflectionHistory(list, todayDoc) {
    const root = $("manager-reflection-history");
    const sub  = $("manager-reflection-sub");
    if (!list.length) {
      root.innerHTML = '<h3>History</h3><p class="mgr-empty">No reflections submitted yet.</p>';
    } else {
      root.innerHTML = '<h3>Last 14 reflections</h3>' + list.map(r => {
        return (
          '<div class="mgr-history-item">' +
            '<div class="mgr-history-when">' + escapeHtml(fmtPacificDateTime(r.created_at)) +
              " · " + escapeHtml(r.created_by_email || "") + '</div>' +
            (r.what_noticed ? '<div><strong>Noticed:</strong> ' + escapeHtml(r.what_noticed) + '</div>' : '') +
            (r.what_concerns ? '<div><strong>Concerns:</strong> ' + escapeHtml(r.what_concerns) + '</div>' : '') +
            (r.what_improve  ? '<div><strong>Improve:</strong> '  + escapeHtml(r.what_improve)  + '</div>' : '') +
          '</div>'
        );
      }).join("");
    }
    if (todayDoc) {
      sub.textContent = "Submitted today · " + fmtPacificDateTime(todayDoc.created_at);
      $("reflection-noticed").value  = todayDoc.what_noticed  || "";
      $("reflection-concerns").value = todayDoc.what_concerns || "";
      $("reflection-improve").value  = todayDoc.what_improve  || "";
      $("manager-reflection-submit").textContent = "Update today's reflection";
    } else {
      sub.textContent = "Required before end of day";
      $("manager-reflection-submit").textContent = "Submit today's reflection";
    }
  }

  function renderImprovementHistory(list) {
    const root = $("manager-improvement-history");
    if (!list.length) {
      root.innerHTML = '<h3>Recent ideas</h3><p class="mgr-empty">No improvement ideas yet.</p>';
      return;
    }
    root.innerHTML = '<h3>Recent ideas</h3>' + list.map(i => {
      return (
        '<div class="mgr-history-item">' +
          '<div class="mgr-history-when">' + escapeHtml(fmtPacificDateTime(i.created_at)) +
            " · " + escapeHtml(i.created_by_email || "") + '</div>' +
          '<div>' + escapeHtml(i.idea || "") + '</div>' +
        '</div>'
      );
    }).join("");
  }

  /* ---------- form handlers ---------- */

  let selectedBottleneck = null;

  function wireBottleneckChoices() {
    document.querySelectorAll("[data-bottleneck]").forEach(btn => {
      btn.addEventListener("click", function () {
        selectedBottleneck = btn.getAttribute("data-bottleneck");
        document.querySelectorAll("[data-bottleneck]").forEach(b =>
          b.classList.toggle("is-active", b === btn));
      });
    });
  }

  async function submitBottleneck(ev) {
    ev.preventDefault();
    const errEl = $("manager-bottleneck-err");
    const okEl  = $("manager-bottleneck-ok");
    errEl.hidden = true; okEl.hidden = true;
    // If user hasn't clicked an option but there's an active state from
    // a prior render, use that.
    if (!selectedBottleneck) {
      const active = document.querySelector("[data-bottleneck].is-active");
      if (active) selectedBottleneck = active.getAttribute("data-bottleneck");
    }
    if (!selectedBottleneck) {
      errEl.textContent = "Pick one of the four options first.";
      errEl.hidden = false;
      return;
    }
    const note = $("manager-bottleneck-note").value.trim();
    const db = firebase.firestore();
    const todayPT = pacificDateString();
    const docId = currentUser.uid + "__" + todayPT;
    try {
      await db.collection("office_manager_bottlenecks").doc(docId).set({
        choice:           selectedBottleneck,
        note:             note || null,
        shift_date:       todayPT,
        created_by_uid:   currentUser.uid,
        created_by_email: currentUser.email,
        created_at:       firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:       firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      okEl.textContent = "Recorded.";
      okEl.hidden = false;
      refreshAll();
    } catch (err) {
      errEl.textContent = "Couldn't save: " + (err.message || err);
      errEl.hidden = false;
    }
  }

  async function submitReflection(ev) {
    ev.preventDefault();
    const errEl = $("manager-reflection-err");
    const okEl  = $("manager-reflection-ok");
    errEl.hidden = true; okEl.hidden = true;
    const noticed  = $("reflection-noticed").value.trim();
    const concerns = $("reflection-concerns").value.trim();
    const improve  = $("reflection-improve").value.trim();
    if (!noticed || !concerns || !improve) {
      errEl.textContent = "All three fields are required.";
      errEl.hidden = false;
      return;
    }
    const db = firebase.firestore();
    const todayPT = pacificDateString();
    const docId = currentUser.uid + "__" + todayPT;
    try {
      await db.collection("office_manager_reflections").doc(docId).set({
        what_noticed:     noticed,
        what_concerns:    concerns,
        what_improve:     improve,
        shift_date:       todayPT,
        created_by_uid:   currentUser.uid,
        created_by_email: currentUser.email,
        created_at:       firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:       firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      okEl.textContent = "Saved.";
      okEl.hidden = false;
      refreshAll();
    } catch (err) {
      errEl.textContent = "Couldn't save: " + (err.message || err);
      errEl.hidden = false;
    }
  }

  async function submitImprovement(ev) {
    ev.preventDefault();
    const errEl = $("manager-improvement-err");
    const okEl  = $("manager-improvement-ok");
    errEl.hidden = true; okEl.hidden = true;
    const idea = $("improvement-idea").value.trim();
    if (!idea) {
      errEl.textContent = "Idea text is required.";
      errEl.hidden = false;
      return;
    }
    const db = firebase.firestore();
    try {
      await db.collection("office_manager_improvements").add({
        idea:             idea,
        status:           "new",
        created_by_uid:   currentUser.uid,
        created_by_email: currentUser.email,
        created_at:       firebase.firestore.FieldValue.serverTimestamp()
      });
      okEl.textContent = "Saved.";
      okEl.hidden = false;
      $("improvement-idea").value = "";
      refreshAll();
    } catch (err) {
      errEl.textContent = "Couldn't save: " + (err.message || err);
      errEl.hidden = false;
    }
  }

  async function submitHiring(ev) {
    ev.preventDefault();
    const errEl = $("manager-hiring-err");
    const okEl  = $("manager-hiring-ok");
    errEl.hidden = true; okEl.hidden = true;
    function num(id) {
      const v = $(id).value;
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }
    const hiring = {
      applicants_7d:        num("hiring-applicants-7d"),
      applicants_30d:       num("hiring-applicants-30d"),
      interviews_scheduled: num("hiring-interviews-sched"),
      interviews_completed: num("hiring-interviews-done"),
      working_interviews:   num("hiring-working-interviews"),
      hires:                num("hiring-hires")
    };
    if (Object.values(hiring).every(v => v == null)) {
      errEl.textContent = "Enter at least one number.";
      errEl.hidden = false;
      return;
    }
    const db = firebase.firestore();
    const todayPT = pacificDateString();
    const weekId = isoWeekId(todayPT);
    try {
      await db.collection("office_manager_weekly_reviews").doc(weekId).set({
        week_id:          weekId,
        hiring:           hiring,
        updated_by_uid:   currentUser.uid,
        updated_by_email: currentUser.email,
        updated_at:       firebase.firestore.FieldValue.serverTimestamp(),
        // Set created_* only when missing (merge:true preserves existing).
        created_at:       firebase.firestore.FieldValue.serverTimestamp(),
        created_by_uid:   currentUser.uid,
        created_by_email: currentUser.email
      }, { merge: true });
      okEl.textContent = "Saved.";
      okEl.hidden = false;
      refreshAll();
    } catch (err) {
      errEl.textContent = "Couldn't save: " + (err.message || err);
      errEl.hidden = false;
    }
  }

  /* ---------- refresh + wire ---------- */

  let refreshing = false;
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      const snap = await loadEverything();
      classifyAndRender(snap);
    } catch (err) {
      console.error("[manager] refresh failed", err);
    } finally {
      refreshing = false;
    }
  }

  function wireForms() {
    $("manager-bottleneck-form").addEventListener("submit", submitBottleneck);
    $("manager-reflection-form").addEventListener("submit", submitReflection);
    $("manager-improvement-form").addEventListener("submit", submitImprovement);
    $("manager-hiring-form").addEventListener("submit", submitHiring);
    wireBottleneckChoices();
  }

  function wireSignIn() {
    const btn = $("signin-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await firebase.auth().signInWithPopup(provider);
      } catch (err) {
        console.error("Sign-in failed", err);
        const code = err && err.code;
        if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
          alert("Sign-in failed: " + (err.message || code || err));
        }
      } finally {
        btn.disabled = false;
      }
    });
  }
  function wireSignOut() {
    document.querySelectorAll("[data-signout]").forEach(btn => {
      btn.addEventListener("click", function () {
        firebase.auth().signOut().catch(err => console.error("Sign-out failed", err));
      });
    });
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.firebase || !window.FIREBASE_CONFIG) {
      console.error("Firebase SDK or config missing");
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    wireSignIn();
    wireSignOut();
    wireForms();
    showAuthState("checking");
    firebase.auth().onAuthStateChanged(handleAuthChange);
  });
}());
