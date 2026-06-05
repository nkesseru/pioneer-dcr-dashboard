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
      g.textContent = "Welcome, " + (first || "Manager") + ".";
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
    // ---- Same derived signals as before — UI shape is the only thing
    // changing in Phase 1A.1. ----
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

    const recentIssues = (snap.dcrIssues || []).filter(i =>
      tsToMs(i.created_at) >= snap.thirtyDaysAgo);
    const concernsByCustomer = {};
    recentIssues.forEach(i => {
      const key = i.customer_slug || i.customer_name || "(unknown)";
      concernsByCustomer[key] = (concernsByCustomer[key] || 0) + 1;
    });
    const repeatConcerns = Object.keys(concernsByCustomer).filter(k =>
      concernsByCustomer[k] >= 2);

    const todayKey = currentUser.uid + "__" + snap.todayPT;
    const todayBottleneck = (snap.omBottlenecks || []).find(b => b._id === todayKey);
    const todayReflection = (snap.omReflections || []).find(r => r._id === todayKey);

    // Items carry a `mission` verb-phrase so the Today's Mission
    // generator can rephrase the same signal as an imperative.
    const buckets = { critical: [], attention: [], healthy: [] };

    if (pendingTimeAdj.length > 0) {
      buckets.critical.push({
        tier: "critical",
        label: "Time adjustment requests waiting on you",
        count: pendingTimeAdj.length,
        link: "/admin",
        mission: "Review " + pendingTimeAdj.length + " pending payroll exception" + (pendingTimeAdj.length === 1 ? "" : "s")
      });
    }
    if (openCallOuts.length > 0) {
      buckets.critical.push({
        tier: "critical",
        label: "Recent call-outs not yet resolved",
        count: openCallOuts.length,
        link: "/admin",
        mission: "Resolve " + openCallOuts.length + " recent call-out" + (openCallOuts.length === 1 ? "" : "s")
      });
    }
    if (missingPunches.length > 0) {
      buckets.critical.push({
        tier: "critical",
        label: "Completed sessions missing a clock-out punch",
        count: missingPunches.length,
        link: "/admin",
        mission: "Fix " + missingPunches.length + " missing clock-out" + (missingPunches.length === 1 ? "" : "s")
      });
    }
    if (activePayrollExports.length > 0) {
      buckets.critical.push({
        tier: "critical",
        label: "Active payroll exports awaiting action",
        count: activePayrollExports.length,
        link: "/admin",
        mission: "Close out " + activePayrollExports.length + " active payroll export" + (activePayrollExports.length === 1 ? "" : "s")
      });
    }
    if (missingDcrSessions.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Completed shifts without a DCR",
        count: missingDcrSessions.length,
        link: "/admin",
        mission: "Chase " + missingDcrSessions.length + " missing DCR" + (missingDcrSessions.length === 1 ? "" : "s")
      });
    }
    if (openDcrIssues.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Open building concerns from DCRs",
        count: openDcrIssues.length,
        link: "/admin",
        mission: "Review " + openDcrIssues.length + " open building concern" + (openDcrIssues.length === 1 ? "" : "s")
      });
    }
    if (openSupply.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Open supply requests",
        count: openSupply.length,
        link: "/admin",
        mission: "Resolve " + openSupply.length + " open supply request" + (openSupply.length === 1 ? "" : "s")
      });
    }
    if (repeatConcerns.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Customers with repeat concerns (30d)",
        count: repeatConcerns.length,
        link: "/admin",
        mission: "Reach out to " + repeatConcerns.length + " customer" + (repeatConcerns.length === 1 ? "" : "s") + " with repeat issues"
      });
    }
    if (openShifts.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Open shifts on the board",
        count: openShifts.length,
        link: "/admin",
        mission: "Cover " + openShifts.length + " open shift" + (openShifts.length === 1 ? "" : "s")
      });
    }
    if (openEmployeeIssues.length > 0) {
      buckets.attention.push({
        tier: "attention",
        label: "Open employee concerns / improvements",
        count: openEmployeeIssues.length,
        link: "/admin",
        mission: "Triage " + openEmployeeIssues.length + " employee concern" + (openEmployeeIssues.length === 1 ? "" : "s")
      });
    }
    if (!todayBottleneck) {
      buckets.attention.push({
        tier: "attention",
        label: "Today's bottleneck — not recorded yet",
        count: 1,
        link: "#manager-bottlenecks",
        mission: "Record today's bottleneck"
      });
    }
    if (!todayReflection) {
      buckets.attention.push({
        tier: "attention",
        label: "Today's reflection — not submitted yet",
        count: 1,
        link: "#manager-reflection",
        mission: "Submit today's reflection"
      });
    }

    // Wins (Healthy)
    if (pendingTimeAdj.length === 0)         buckets.healthy.push({ label: "No payroll exceptions pending" });
    if (openCallOuts.length === 0)           buckets.healthy.push({ label: "No open call-outs in last 7 days" });
    if (missingPunches.length === 0)         buckets.healthy.push({ label: "All recent sessions clocked out" });
    if (missingDcrSessions.length === 0)     buckets.healthy.push({ label: "All completed shifts have DCRs" });
    if (openSupply.length === 0)             buckets.healthy.push({ label: "All supply requests closed" });
    if (openDcrIssues.length === 0)          buckets.healthy.push({ label: "No open building concerns" });
    if (openShifts.length === 0)             buckets.healthy.push({ label: "No open shifts on the board" });
    if (todayBottleneck && todayReflection)  buckets.healthy.push({ label: "Today's reflection submitted" });

    renderActionRequired(buckets);
    renderMission(buckets);
    renderWins(buckets.healthy);

    // Health cards (verdict-style)
    renderStaffingCard({
      openShifts:     openShifts.length,
      callOuts:       openCallOuts.length,
      missingPunches: missingPunches.length,
      pendingAdj:     pendingTimeAdj.length
    });
    renderCustomerCard({
      openConcerns: openDcrIssues.length,
      openSupply:   openSupply.length,
      repeatCount:  repeatConcerns.length,
      missingDcr:   missingDcrSessions.length
    });
    const onboardingProxy = (snap.techs || [])
      .filter(t => t.active !== false && !t.uid).length;
    renderAdminCard({
      activeExports:  activePayrollExports.length,
      pendingApprov:  pendingTimeAdj.length,
      onboardingTodo: onboardingProxy,
      employeeIssues: openEmployeeIssues.length
    });
    renderHiringCard(snap.omWeek);

    renderBottleneckHistory(snap.omBottlenecks || [], todayBottleneck);
    renderReflectionHistory(snap.omReflections || [], todayReflection);
    renderImprovementMetrics(snap.omImprovements || []);
    renderImprovementHistory(snap.omImprovements || []);

    if (snap.failedReads && snap.failedReads.length) {
      console.warn("[manager] read failures:", snap.failedReads);
    }
  }

  /* ---------- renderers (Phase 1A.1 cockpit) ---------- */

  // Big counter tiles + top-priorities list. The numbers up top are the
  // primary visual signal; the priorities list gives the manager the
  // next 5 actionable rows in priority order (Critical first, then
  // Attention).
  function renderActionRequired(buckets) {
    const counts = {
      critical:  buckets.critical.length,
      attention: buckets.attention.length,
      healthy:   buckets.healthy.length
    };
    $("mc-counter-critical").textContent  = String(counts.critical);
    $("mc-counter-attention").textContent = String(counts.attention);
    $("mc-counter-healthy").textContent   = String(counts.healthy);
    document.querySelector('.mc-counter[data-tier="critical"]').setAttribute("data-zero", counts.critical === 0 ? "true" : "false");
    document.querySelector('.mc-counter[data-tier="attention"]').setAttribute("data-zero", counts.attention === 0 ? "true" : "false");
    document.querySelector('.mc-counter[data-tier="healthy"]').setAttribute("data-zero", counts.healthy === 0 ? "true" : "false");

    const sub = $("manager-action-sub");
    if (counts.critical > 0) {
      sub.textContent = counts.critical + " critical signal" + (counts.critical === 1 ? "" : "s") + " demand action.";
    } else if (counts.attention > 0) {
      sub.textContent = "Nothing critical. Tighten the " + counts.attention + " attention item" + (counts.attention === 1 ? "" : "s") + ".";
    } else {
      sub.textContent = "All clear. Take the win.";
    }

    // Priorities = first 5 of Critical+Attention combined
    const priority = buckets.critical.concat(buckets.attention).slice(0, 5);
    const root = $("manager-action-list");
    if (priority.length === 0) {
      root.innerHTML = '<p class="mc-priorities-empty">Nothing requires attention right now.</p>';
      return;
    }
    root.innerHTML = priority.map(it => {
      const link = it.link ? '<a href="' + escapeHtml(it.link) + '">Open →</a>' : '';
      const count = (typeof it.count === "number" && it.count > 1)
        ? '<span class="mc-priority-count">' + escapeHtml(String(it.count)) + '</span>'
        : '';
      return (
        '<div class="mc-priority-item" data-tier="' + escapeHtml(it.tier) + '">' +
          '<span>' + escapeHtml(it.label) + '</span>' +
          '<span>' + count + link + '</span>' +
        '</div>'
      );
    }).join("");
  }

  // Today's Mission — rule-based generation from Action Required items.
  // Takes the top 3 Critical + Attention rows and renders them as a
  // numbered checklist. Always appends "Submit today's reflection" as
  // the final item when not already implicit, because reflection is the
  // success criterion the spec cares about.
  function renderMission(buckets) {
    const root  = $("manager-mission-list");
    const empty = $("manager-mission-empty");
    const items = buckets.critical.concat(buckets.attention).slice(0, 5);
    if (items.length === 0) {
      root.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    root.innerHTML = items.map(it => {
      return '<li>' + escapeHtml(it.mission || it.label) + '</li>';
    }).join("");
  }

  function renderWins(healthy) {
    const root  = $("manager-wins-list");
    const empty = $("manager-wins-empty");
    if (!healthy.length) {
      root.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    root.innerHTML = healthy.map(h =>
      '<li>' + escapeHtml(h.label) + '</li>'
    ).join("");
  }

  // ---- Health card renderer ---------------------------------------
  // Each card carries a status verdict (Stable / Attention / Action
  // Needed) + 3-4 short stat lines. Worst-of-stats wins the verdict
  // tier. Per-line `tier` colors the number for at-a-glance scanning.
  function verdictForStats(stats) {
    let tier = "healthy";
    stats.forEach(s => {
      if (s.tier === "critical") tier = "critical";
      else if (s.tier === "attention" && tier !== "critical") tier = "attention";
    });
    return tier;
  }
  function verdictLabel(tier) {
    if (tier === "critical")  return "Action Needed";
    if (tier === "attention") return "Attention";
    return "Stable";
  }
  function statTier(value, attentionThreshold, criticalThreshold) {
    if (criticalThreshold != null && value >= criticalThreshold) return "critical";
    if (attentionThreshold != null && value >= attentionThreshold) return "attention";
    return "healthy";
  }
  function renderHealthCard(rootId, stats) {
    const tier = verdictForStats(stats);
    const verdict =
      '<span class="mc-health-verdict" data-tier="' + tier + '"><span class="mc-dot"></span>' +
        escapeHtml(verdictLabel(tier)) + '</span>';
    const statsHtml =
      '<div class="mc-health-stats">' +
        stats.map(s =>
          '<div class="mc-health-stat" data-tier="' + escapeHtml(s.tier) + '">' +
            '<span>' + escapeHtml(s.label) + '</span>' +
            '<strong>' + escapeHtml(String(s.value)) + '</strong>' +
          '</div>'
        ).join("") +
      '</div>';
    $(rootId).innerHTML = verdict + statsHtml;
  }

  function renderStaffingCard(s) {
    renderHealthCard("manager-staffing-display", [
      { label: "Open shifts",            value: s.openShifts,     tier: statTier(s.openShifts, 1) },
      { label: "Recent call-outs",       value: s.callOuts,       tier: statTier(s.callOuts, 1) },
      { label: "Missed punches",         value: s.missingPunches, tier: statTier(s.missingPunches, 1, 1) },
      { label: "Pending corrections",    value: s.pendingAdj,     tier: statTier(s.pendingAdj, 1, 1) }
    ]);
  }
  function renderCustomerCard(c) {
    renderHealthCard("manager-customer-display", [
      { label: "Open concerns",          value: c.openConcerns,  tier: statTier(c.openConcerns, 1) },
      { label: "Open supply requests",   value: c.openSupply,    tier: statTier(c.openSupply, 6) },
      { label: "Repeat customers (30d)", value: c.repeatCount,   tier: statTier(c.repeatCount, 1) },
      { label: "Shifts w/o DCR",         value: c.missingDcr,    tier: statTier(c.missingDcr, 1) }
    ]);
  }
  function renderAdminCard(a) {
    renderHealthCard("manager-admin-display", [
      { label: "Active payroll exports", value: a.activeExports,  tier: statTier(a.activeExports, 1, 1) },
      { label: "Pending approvals",      value: a.pendingApprov,  tier: statTier(a.pendingApprov, 1, 1) },
      { label: "Onboarding incomplete",  value: a.onboardingTodo, tier: statTier(a.onboardingTodo, 1) },
      { label: "Employee concerns",      value: a.employeeIssues, tier: statTier(a.employeeIssues, 1) }
    ]);
  }
  function renderHiringCard(omWeek) {
    if (!omWeek || !omWeek.hiring) {
      $("hiring-applicants-7d").value = "";
      $("hiring-applicants-30d").value = "";
      $("hiring-interviews-sched").value = "";
      $("hiring-interviews-done").value = "";
      $("hiring-working-interviews").value = "";
      $("hiring-hires").value = "";
      $("manager-hiring-display").innerHTML =
        '<span class="mc-health-verdict" data-tier="attention"><span class="mc-dot"></span>No data yet</span>' +
        '<p class="mc-empty" style="margin:8px 0 0;">Open the form below to add this week\'s numbers.</p>';
      return;
    }
    const h = omWeek.hiring;
    $("hiring-applicants-7d").value         = h.applicants_7d ?? "";
    $("hiring-applicants-30d").value        = h.applicants_30d ?? "";
    $("hiring-interviews-sched").value      = h.interviews_scheduled ?? "";
    $("hiring-interviews-done").value       = h.interviews_completed ?? "";
    $("hiring-working-interviews").value    = h.working_interviews ?? "";
    $("hiring-hires").value                 = h.hires ?? "";
    // Verdict: healthy if hires > 0 OR working_interviews > 0; attention
    // if applicants logged but no movement; stable otherwise.
    const hires = Number(h.hires || 0);
    const working = Number(h.working_interviews || 0);
    const apps7 = Number(h.applicants_7d || 0);
    let tier = "healthy";
    if (hires === 0 && working === 0 && apps7 === 0) tier = "attention";
    renderHealthCard("manager-hiring-display", [
      { label: "Applicants (7d)",    value: h.applicants_7d ?? 0,    tier: statTier(h.applicants_7d ?? 0, null) },
      { label: "Interviews sched.",  value: h.interviews_scheduled ?? 0, tier: "healthy" },
      { label: "Working interviews", value: h.working_interviews ?? 0,   tier: "healthy" },
      { label: "Hires",              value: h.hires ?? 0,                tier: "healthy" }
    ]);
    // Force-replace verdict pill if hires move us positive — verdictForStats
    // above only knows about stat-level tiers; hiring deserves its own
    // positive verdict.
    const display = $("manager-hiring-display");
    const oldVerdict = display.querySelector(".mc-health-verdict");
    if (oldVerdict) {
      oldVerdict.setAttribute("data-tier", tier);
      oldVerdict.innerHTML = '<span class="mc-dot"></span>' +
        (tier === "healthy" ? "Filling pipeline" : "Needs entry");
    }
  }

  // ---- Your Improvements metrics --------------------------------
  function renderImprovementMetrics(list) {
    $("mc-im-submitted").textContent = String(list.length);
  }

  function renderBottleneckHistory(list, todayDoc) {
    const root = $("manager-bottleneck-history");
    if (!list.length) {
      root.innerHTML = '<p class="mc-history-title">History</p><p class="mc-empty">No bottlenecks recorded yet.</p>';
    } else {
      root.innerHTML = '<p class="mc-history-title">Last 14 bottlenecks</p>' + list.map(b => {
        const choiceLabel = ({
          april: "Waiting on April",
          customer: "Waiting on Customer",
          vendor: "Waiting on Vendor",
          nobody: "Waiting on Nobody"
        }[b.choice] || b.choice || "—");
        return (
          '<div class="mc-history-item">' +
            '<div class="mc-history-when">' + escapeHtml(fmtPacificDateTime(b.created_at)) +
              " · " + escapeHtml(b.created_by_email || "") + '</div>' +
            '<div><strong>' + escapeHtml(choiceLabel) + '</strong>' +
              (b.note ? ' — ' + escapeHtml(b.note) : '') + '</div>' +
          '</div>'
        );
      }).join("");
    }
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
      root.innerHTML = '<p class="mc-history-title">History</p><p class="mc-empty">No reflections submitted yet.</p>';
    } else {
      root.innerHTML = '<p class="mc-history-title">Last 14 reflections</p>' + list.map(r => {
        return (
          '<div class="mc-history-item">' +
            '<div class="mc-history-when">' + escapeHtml(fmtPacificDateTime(r.created_at)) +
              " · " + escapeHtml(r.created_by_email || "") + '</div>' +
            (r.what_noticed ? '<div><strong>Observation:</strong> ' + escapeHtml(r.what_noticed) + '</div>' : '') +
            (r.what_concerns ? '<div><strong>Concern:</strong> ' + escapeHtml(r.what_concerns) + '</div>' : '') +
            (r.what_improve  ? '<div><strong>Opportunity:</strong> '  + escapeHtml(r.what_improve)  + '</div>' : '') +
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
      sub.textContent = "Leadership thinking. Three minutes.";
      $("manager-reflection-submit").textContent = "Submit today's reflection";
    }
  }

  function renderImprovementHistory(list) {
    const root = $("manager-improvement-history");
    if (!list.length) {
      root.innerHTML = '<p class="mc-history-title">Recent ideas</p><p class="mc-empty">No improvement ideas yet. Drop one above.</p>';
      return;
    }
    root.innerHTML = '<p class="mc-history-title">Recent ideas</p>' + list.map(i => {
      return (
        '<div class="mc-history-item">' +
          '<div class="mc-history-when">' + escapeHtml(fmtPacificDateTime(i.created_at)) +
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
