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
 *     • open_shift_requests                — where status == "open"
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
    bootLeadershipMessages();
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
      // 0. open_shift_requests — unclaimed coverage requests. Filter
      // server-side to status="open" so the read stays small.
      safe("open_shifts", db.collection("open_shift_requests")
        .where("status", "==", "open").get()),
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
      // 11. office_manager_improvements — full pipeline read (cap 200 so
      // a runaway collection doesn't burn the page; in practice this is
      // a small set even after a year).
      safe("om_improvements", db.collection("office_manager_improvements")
        .orderBy("created_at", "desc").limit(200).get()),
      // 12. current week's office_manager_weekly_reviews doc (hiring +
      // Phase 1B review fields share this doc — Phase 1A wrote hiring,
      // Phase 1B writes the review prompts as additional top-level fields).
      safe("om_week", db.collection("office_manager_weekly_reviews")
        .doc(isoWeekId(todayPT)).get()),
      // 13. office_manager_weekly_reviews — recent 12 entries (newest first
      // by updated_at; week_ending used only for display label).
      safe("om_weeks", db.collection("office_manager_weekly_reviews")
        .orderBy("updated_at", "desc").limit(12).get()),
      // 14. Phase 2A.1 — office_manager_hiring_snapshots — most recent
      // 30 snapshot docs. Each doc is a rollup for a snapshotDate. Read
      // is single-field-indexed (snapshot_date desc) so it stays
      // index-free. Collection may be empty for the entire Phase 2A.1
      // window — that's fine; manager.js falls back to manual entry.
      safe("om_hiring_snapshots", db.collection("office_manager_hiring_snapshots")
        .orderBy("snapshot_date", "desc").limit(30).get()
        .catch(() => ({ docs: [] })))
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
      omWeeks:          docs(13),
      omHiringSnapshots:docs(14) || [],
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
    const openShifts = (snap.openShifts || []).filter(s => (s.status || "open") === "open");
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
    // Phase 2A.1 — pick hiring source (live GHL snapshot or manual fallback)
    // once so both the card AND the scorecard verdict use the same data.
    const pickedHiring = pickHiringSource(snap.omHiringSnapshots || [], snap.omWeek);
    renderHiringCard(pickedHiring);

    renderBottleneckHistory(snap.omBottlenecks || [], todayBottleneck);
    renderReflectionHistory(snap.omReflections || [], todayReflection);

    // ---- Phase 1B — Improvement Pipeline + metrics + Scorecard + Weekly Review ----
    const improvements = normalizeImprovements(snap.omImprovements || []);
    renderImprovementMetrics(improvements);
    renderImprovementPipeline(improvements);
    renderScorecard({
      // Phase 2A.1 — Hiring scorecard verdict now uses the real
      // hiringVerdict() logic against whichever source pickHiringSource
      // resolved (live GHL when available; manual fallback otherwise).
      hiring:    hiringVerdict(pickedHiring),
      staffing:  worstStaffingTier({
        openShifts: openShifts.length, callOuts: openCallOuts.length,
        missingPunches: missingPunches.length, pendingAdj: pendingTimeAdj.length
      }),
      customer:  worstCustomerTier({
        openConcerns: openDcrIssues.length, openSupply: openSupply.length,
        repeatCount: repeatConcerns.length, missingDcr: missingDcrSessions.length
      }),
      admin:     worstAdminTier({
        activeExports: activePayrollExports.length, pendingApprov: pendingTimeAdj.length,
        onboardingTodo: (snap.techs || []).filter(t => t.active !== false && !t.uid).length,
        employeeIssues: openEmployeeIssues.length
      }),
      improvement: improvementActivityTier(improvements)
    });
    renderWeeklyReview(snap.omWeek, snap.omWeeks || [], snap.todayPT);

    if (snap.failedReads && snap.failedReads.length) {
      console.warn("[manager] read failures:", snap.failedReads);
    }
  }

  /* ---------- Phase 1B — pipeline + scorecard + weekly review ---------- */

  // Normalize legacy + new improvement docs into a single shape so the
  // pipeline renderer doesn't have to branch on schema versions.
  function normalizeImprovements(list) {
    return list.map(d => {
      const status = mapLegacyStatus(d.status || "submitted");
      const title = d.title || (d.idea ? String(d.idea).slice(0, 80) : "(untitled)");
      const description = d.description || d.idea || "";
      return {
        _id:               d._id,
        title:             title,
        description:       description,
        status:            status,
        owner_uid:         d.owner_uid || null,
        owner_name:        d.owner_name || null,
        due_date:          d.due_date || null,
        approved_at:       d.approved_at || null,
        approved_by_name:  d.approved_by_name || null,
        implemented_at:    d.implemented_at || null,
        implemented_by_name: d.implemented_by_name || null,
        rejected_at:       d.rejected_at || null,
        rejected_reason:   d.rejected_reason || null,
        impact_notes:      d.impact_notes || null,
        submitted_by_name: d.submitted_by_name || d.created_by_email || null,
        submitted_by_email:d.submitted_by_email || d.created_by_email || null,
        submitted_at:      d.submitted_at || d.created_at || null,
        created_at:        d.created_at,
        updated_at:        d.updated_at
      };
    });
  }
  function mapLegacyStatus(s) {
    const lc = String(s || "").toLowerCase();
    if (lc === "new") return "submitted";
    if (["submitted","approved","in_progress","implemented","rejected"].indexOf(lc) >= 0) return lc;
    return "submitted";
  }

  // Phase 2A.1 cleanup — Implementation Rate uses cumulative "ever-approved"
  // denominator (approved + in_progress + implemented) so the rate keeps
  // calculating after items move past the approved column. Per-status
  // count tiles still show the current-column counts.
  function renderImprovementMetrics(items) {
    const submitted   = items.filter(i => i.status === "submitted").length;
    const approved    = items.filter(i => i.status === "approved").length;
    const inProgress  = items.filter(i => i.status === "in_progress").length;
    const implemented = items.filter(i => i.status === "implemented").length;
    const everApproved = approved + inProgress + implemented;
    const rate = everApproved > 0
      ? Math.round((implemented / everApproved) * 100)
      : null;
    $("mc-im-submitted").textContent   = String(submitted);
    $("mc-im-approved").textContent    = String(approved);
    $("mc-im-implemented").textContent = String(implemented);
    $("mc-im-rate").textContent        = (rate == null) ? "—" : (rate + "%");
  }

  function renderImprovementPipeline(items) {
    const groups = { submitted: [], approved: [], in_progress: [], implemented: [], rejected: [] };
    items.forEach(i => { (groups[i.status] || groups.submitted).push(i); });
    // Update counts strip
    Object.keys(groups).forEach(status => {
      const cntEl = $("mc-pipe-count-" + status);
      const hdrEl = $("mc-pipe-h-" + status);
      if (cntEl) cntEl.textContent = String(groups[status].length);
      if (hdrEl) hdrEl.textContent = String(groups[status].length);
      const target = $("mc-pipe-cards-" + status);
      if (!target) return;
      if (groups[status].length === 0) {
        target.innerHTML = '<p class="mc-empty">Nothing here.</p>';
        return;
      }
      target.innerHTML = groups[status].map(renderImprovementCard).join("");
    });
  }

  function renderImprovementCard(it) {
    const submittedLine = '<div class="mc-card-meta">' +
      '<span><span class="mc-card-meta-label">Submitted by</span>' + escapeHtml(it.submitted_by_email || "—") + '</span>' +
      '<span><span class="mc-card-meta-label">Submitted</span>' + escapeHtml(fmtPacificDateTime(it.submitted_at)) + '</span>' +
      (it.owner_name ? '<span><span class="mc-card-meta-label">Owner</span>' + escapeHtml(it.owner_name) + '</span>' : '') +
      (it.due_date   ? '<span><span class="mc-card-meta-label">Due</span>'   + escapeHtml(it.due_date) + '</span>' : '') +
      (it.approved_at   ? '<span><span class="mc-card-meta-label">Approved</span>'   + escapeHtml(fmtPacificDateTime(it.approved_at)) + '</span>' : '') +
      (it.implemented_at? '<span><span class="mc-card-meta-label">Implemented</span>'+ escapeHtml(fmtPacificDateTime(it.implemented_at)) + '</span>' : '') +
      '</div>';
    const impactHtml = it.impact_notes
      ? '<div class="mc-card-impact"><strong>Impact</strong>' + escapeHtml(it.impact_notes) + '</div>'
      : '';
    const rejectionHtml = (it.status === "rejected" && it.rejected_reason)
      ? '<div class="mc-card-impact" style="background:var(--mc-critical-soft);border-left-color:var(--mc-critical);"><strong style="color:var(--mc-critical);">Reason</strong>' +
        escapeHtml(it.rejected_reason) + '</div>'
      : '';
    const actions = renderImprovementActions(it);
    return (
      '<article class="mc-card" data-improvement-id="' + escapeHtml(it._id) + '">' +
        '<h4 class="mc-card-title">' + escapeHtml(it.title) + '</h4>' +
        (it.description && it.description !== it.title
          ? '<p class="mc-card-desc">' + escapeHtml(it.description) + '</p>'
          : '') +
        submittedLine +
        impactHtml +
        rejectionHtml +
        (actions ? '<div class="mc-card-actions">' + actions + '</div>' : '') +
      '</article>'
    );
  }

  function renderImprovementActions(it) {
    const buttons = [];
    const isTerminal = it.status === "implemented" || it.status === "rejected";
    if (it.status === "submitted") {
      buttons.push(actionButtonHtml(it._id, "approve",   "Approve",     "is-success"));
      buttons.push(actionButtonHtml(it._id, "reject",    "Reject",      "is-danger"));
    } else if (it.status === "approved") {
      buttons.push(actionButtonHtml(it._id, "in_progress", "Move to In Progress", "is-primary"));
      buttons.push(actionButtonHtml(it._id, "reject",      "Reject",              "is-danger"));
    } else if (it.status === "in_progress") {
      buttons.push(actionButtonHtml(it._id, "implement", "Mark Implemented", "is-success"));
    }
    if (!isTerminal) {
      buttons.push(actionButtonHtml(it._id, "owner",   it.owner_name ? "Change Owner" : "Assign Owner"));
      buttons.push(actionButtonHtml(it._id, "due",     it.due_date    ? "Change Due Date" : "Set Due Date"));
      buttons.push(actionButtonHtml(it._id, "impact",  it.impact_notes ? "Update Impact" : "Add Impact Notes"));
    } else if (it.status === "implemented") {
      buttons.push(actionButtonHtml(it._id, "impact",  it.impact_notes ? "Update Impact" : "Add Impact Notes"));
    }
    return buttons.join("");
  }
  function actionButtonHtml(id, action, label, extraCls) {
    return '<button type="button" class="mc-card-action' + (extraCls ? " " + extraCls : "") +
           '" data-improvement-action="' + escapeHtml(action) + '" data-id="' + escapeHtml(id) + '">' +
           escapeHtml(label) + '</button>';
  }

  // ---- Action handlers (per status transition) ----
  async function applyImprovementAction(id, action) {
    const db = firebase.firestore();
    const ref = db.collection("office_manager_improvements").doc(id);
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const baseStamp = {
      updated_at:       sts,
      updated_by_uid:   currentUser.uid,
      updated_by_email: currentUser.email
    };
    try {
      if (action === "approve") {
        await ref.update(Object.assign(baseStamp, {
          status:              "approved",
          approved_at:         sts,
          approved_by_uid:     currentUser.uid,
          approved_by_email:   currentUser.email,
          approved_by_name:    currentUser.displayName || currentUser.email
        }));
      } else if (action === "reject") {
        const reason = window.prompt("Reason for rejection (visible in history):");
        if (reason == null) return;
        const r = String(reason).trim();
        if (!r) { alert("A reason is required to reject."); return; }
        await ref.update(Object.assign(baseStamp, {
          status:              "rejected",
          rejected_at:         sts,
          rejected_by_uid:     currentUser.uid,
          rejected_by_email:   currentUser.email,
          rejected_reason:     r
        }));
      } else if (action === "in_progress") {
        await ref.update(Object.assign(baseStamp, {
          status:              "in_progress",
          in_progress_at:      sts
        }));
      } else if (action === "implement") {
        const notes = window.prompt("Implementation impact (what changed? what's the result?):");
        if (notes == null) return;
        const n = String(notes).trim();
        await ref.update(Object.assign(baseStamp, {
          status:              "implemented",
          implemented_at:      sts,
          implemented_by_uid:  currentUser.uid,
          implemented_by_email:currentUser.email,
          implemented_by_name: currentUser.displayName || currentUser.email,
          impact_notes:        n || null
        }));
      } else if (action === "owner") {
        const name = window.prompt("Owner name (who's accountable?):");
        if (name == null) return;
        const n = String(name).trim();
        await ref.update(Object.assign(baseStamp, {
          owner_name:  n || null,
          owner_uid:   null   // V1 — name-only; uid resolution comes later
        }));
      } else if (action === "due") {
        const due = window.prompt("Due date (YYYY-MM-DD):");
        if (due == null) return;
        const d = String(due).trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert("Format must be YYYY-MM-DD."); return; }
        await ref.update(Object.assign(baseStamp, {
          due_date: d || null
        }));
      } else if (action === "impact") {
        const notes = window.prompt("Impact notes:", "");
        if (notes == null) return;
        await ref.update(Object.assign(baseStamp, {
          impact_notes: String(notes).trim() || null
        }));
      } else {
        return;
      }
      refreshAll();
    } catch (err) {
      console.error("[manager] improvement action failed", err);
      alert("Couldn't update: " + (err.message || err));
    }
  }

  /* ---------- Scorecard ---------- */

  function worstStaffingTier(s) {
    if (s.missingPunches > 0 || s.pendingAdj > 0) return "critical";
    if (s.openShifts > 0 || s.callOuts > 0)       return "attention";
    return "healthy";
  }
  function worstCustomerTier(c) {
    if (c.openConcerns > 0 || c.repeatCount > 0 || c.missingDcr > 0) return "attention";
    if (c.openSupply > 5) return "attention";
    return "healthy";
  }
  function worstAdminTier(a) {
    if (a.activeExports > 0 || a.pendingApprov > 0) return "critical";
    if (a.onboardingTodo > 0 || a.employeeIssues > 0) return "attention";
    return "healthy";
  }
  // Improvement Activity: green if anything implemented in last 30 days,
  // attention if there's a pipeline but nothing implemented recently, red
  // if the pipeline is empty entirely (no signal of management thinking).
  function improvementActivityTier(items) {
    if (!items.length) return "critical";
    const thirty = Date.now() - 30 * 86400000;
    const recentImpl = items.filter(i => i.status === "implemented" &&
      tsToMs(i.implemented_at) >= thirty).length;
    if (recentImpl > 0) return "healthy";
    return "attention";
  }
  function tierLabel(tier) {
    if (tier === "healthy")   return "Healthy";
    if (tier === "attention") return "Attention";
    if (tier === "critical")  return "Action Needed";
    return "—";
  }
  function renderScorecard(verdicts) {
    ["hiring", "staffing", "customer", "admin", "improvement"].forEach(key => {
      const pill = document.querySelector('[data-scorecard="' + key + '"]');
      if (!pill) return;
      const tier = verdicts[key] || "attention";
      pill.setAttribute("data-tier", tier);
      const lbl = pill.querySelector(".mc-scorecard-label");
      if (lbl) lbl.textContent = tierLabel(tier);
    });
  }

  /* ---------- Weekly Review ---------- */

  // Friday in Pacific. We use Pacific date math because the weekly
  // cadence is anchored to Pioneer's local week.
  function isPacificFriday() {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" })
        .format(new Date()) === "Fri";
    } catch (_e) { return false; }
  }
  // Compute the Friday of the ISO week that contains the given Pacific
  // date. Used as week_ending so older reviews sort/display naturally.
  function fridayOfWeek(yyyymmdd) {
    const parts = String(yyyymmdd).split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const day = dt.getUTCDay() || 7;   // Mon=1 … Sun=7
    // Friday = day 5
    dt.setUTCDate(dt.getUTCDate() + (5 - day));
    return dt.toISOString().slice(0, 10);
  }

  function renderWeeklyReview(omWeek, omWeeks, todayPT) {
    const banner = $("manager-weekly-banner");
    const todayIsFriday = isPacificFriday();
    banner.hidden = !todayIsFriday;

    // Pre-populate the form with this week's review if one exists.
    const hasThisWeek = omWeek && (omWeek.biggest_win || omWeek.biggest_risk ||
                                   omWeek.trend_observed || omWeek.improvement_proposal ||
                                   omWeek.where_stuck);
    if (hasThisWeek) {
      $("weekly-biggest-win").value  = omWeek.biggest_win || "";
      $("weekly-biggest-risk").value = omWeek.biggest_risk || "";
      $("weekly-trend").value        = omWeek.trend_observed || "";
      $("weekly-proposal").value     = omWeek.improvement_proposal || "";
      $("weekly-stuck").value        = omWeek.where_stuck || "";
      $("manager-weekly-submit").textContent = "Update this week's review";
    } else {
      $("weekly-biggest-win").value  = "";
      $("weekly-biggest-risk").value = "";
      $("weekly-trend").value        = "";
      $("weekly-proposal").value     = "";
      $("weekly-stuck").value        = "";
      $("manager-weekly-submit").textContent = "Save this week's review";
    }

    // History — only entries with at least one review field populated.
    const reviews = (omWeeks || []).filter(w =>
      w.biggest_win || w.biggest_risk || w.trend_observed ||
      w.improvement_proposal || w.where_stuck);
    const root = $("manager-weekly-history");
    if (!reviews.length) {
      root.innerHTML = '<p class="mc-history-title">History</p><p class="mc-empty">No weekly reviews yet.</p>';
      return;
    }
    root.innerHTML = '<p class="mc-history-title">Past reviews · newest first</p>' + reviews.map(r => {
      const weekLabel = r.week_ending ? "Week ending " + r.week_ending : (r._id || "Week");
      return (
        '<div class="mc-history-item">' +
          '<div class="mc-history-when">' + escapeHtml(weekLabel) +
            (r.updated_by_email ? " · " + escapeHtml(r.updated_by_email) : "") + '</div>' +
          (r.biggest_win  ? '<div><strong>Biggest Win:</strong> '   + escapeHtml(r.biggest_win)  + '</div>' : '') +
          (r.biggest_risk ? '<div><strong>Biggest Risk:</strong> '  + escapeHtml(r.biggest_risk) + '</div>' : '') +
          (r.trend_observed ? '<div><strong>Trend:</strong> '       + escapeHtml(r.trend_observed) + '</div>' : '') +
          (r.improvement_proposal ? '<div><strong>Proposal:</strong> ' + escapeHtml(r.improvement_proposal) + '</div>' : '') +
          (r.where_stuck ? '<div><strong>Stuck on:</strong> '       + escapeHtml(r.where_stuck) + '</div>' : '') +
        '</div>'
      );
    }).join("");
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
  // ============================================================
  // Phase 2A.1 — Hiring funnel source selection + verdict + conversions
  // ============================================================
  // The Hiring Health card now consumes either a snapshot doc from
  // office_manager_hiring_snapshots (Phase 2A.2 will populate this via
  // a GHL scheduled sync) OR the legacy manual-entry object on
  // office_manager_weekly_reviews/{isoWeek}.hiring. Snapshot wins when
  // a fresh one (≤ 7 days old) exists. Manual entry remains the
  // fallback and is never disabled by this change.

  // Returns { source, data, asOf, sourceLabel } where:
  //   source      = "live_ghl" | "manual" | "none"
  //   data        = normalized 6-field hiring object (or null when none)
  //   asOf        = ISO date string of the underlying record, or null
  //   sourceLabel = display string for the data-source pill
  function pickHiringSource(snapshots, omWeek) {
    const fresh = (snapshots || []).find(s => {
      // snapshot_date is YYYY-MM-DD; consider any snapshot within 7 days
      // of today "fresh enough" to outrank manual entry.
      const d = s && s.snapshot_date;
      if (!d) return false;
      const ms = Date.parse(d + "T00:00:00Z");
      if (!Number.isFinite(ms)) return false;
      return (Date.now() - ms) <= 7 * 86400000;
    });
    if (fresh) {
      return {
        source:      "live_ghl",
        data:        normalizeHiringSnapshot(fresh),
        asOf:        fresh.snapshot_date,
        sourceLabel: "Live GHL"
      };
    }
    if (omWeek && omWeek.hiring) {
      return {
        source:      "manual",
        data:        normalizeHiringManual(omWeek.hiring),
        asOf:        omWeek.week_id || null,
        sourceLabel: "Manual"
      };
    }
    return { source: "none", data: null, asOf: null, sourceLabel: "No data yet" };
  }

  function normalizeHiringSnapshot(s) {
    return {
      applicants_7d:        numOrNull(s.applicants_7d),
      applicants_30d:       numOrNull(s.applicants_30d ?? s.applicants),
      interviews_scheduled: numOrNull(s.interviews_scheduled),
      interviews_completed: numOrNull(s.interviews_completed),
      working_interviews:   numOrNull(s.working_interviews),
      hires:                numOrNull(s.hires)
    };
  }
  function normalizeHiringManual(h) {
    return {
      applicants_7d:        numOrNull(h.applicants_7d),
      applicants_30d:       numOrNull(h.applicants_30d),
      interviews_scheduled: numOrNull(h.interviews_scheduled),
      interviews_completed: numOrNull(h.interviews_completed),
      working_interviews:   numOrNull(h.working_interviews),
      hires:                numOrNull(h.hires)
    };
  }
  function numOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function pctOrDash(numerator, denominator) {
    if (!denominator || denominator <= 0) return "—";
    if (numerator == null) return "—";
    return Math.round((numerator / denominator) * 100) + "%";
  }

  // Verdict rules — per Phase 2A.1 spec:
  //   RED      — critically low applicant flow (7d == 0) OR zero working
  //              interviews when hires are also zero (funnel dead).
  //   YELLOW   — slightly below target: applicants_7d < 3, OR working
  //              interviews drop to zero while hires are zero, OR no
  //              hires landed in the current window.
  //   GREEN    — applicants_7d ≥ 3 AND working_interviews ≥ 1 (active
  //              funnel that's moving).
  // Targets are conservative defaults; can be tuned when targets are
  // formally defined.
  function hiringVerdict(picked) {
    if (!picked || picked.source === "none" || !picked.data) return "attention";
    const h = picked.data;
    const apps7   = h.applicants_7d   == null ? 0 : h.applicants_7d;
    const working = h.working_interviews == null ? 0 : h.working_interviews;
    const hires   = h.hires           == null ? 0 : h.hires;
    if (apps7 === 0) return "critical";
    if (working === 0 && hires === 0) return "critical";
    if (apps7 < 3) return "attention";
    if (working === 0 && hires < 1) return "attention";
    if (hires === 0 && working === 0) return "attention";
    return "healthy";
  }
  function hiringVerdictLabel(tier) {
    if (tier === "healthy")   return "Filling pipeline";
    if (tier === "attention") return "Needs attention";
    if (tier === "critical")  return "Critically low";
    return "—";
  }

  function renderHiringCard(picked) {
    const tier = hiringVerdict(picked);
    const h = picked.data;

    // Always pre-populate the manual entry form when data is from manual
    // entry (so an admin can edit), and ALSO pre-populate when source is
    // "live_ghl" so the office can override with manual numbers if the
    // sync ever ships bad data. Form remains the fallback regardless.
    $("hiring-applicants-7d").value      = (h && h.applicants_7d        != null) ? h.applicants_7d : "";
    $("hiring-applicants-30d").value     = (h && h.applicants_30d       != null) ? h.applicants_30d : "";
    $("hiring-interviews-sched").value   = (h && h.interviews_scheduled != null) ? h.interviews_scheduled : "";
    $("hiring-interviews-done").value    = (h && h.interviews_completed != null) ? h.interviews_completed : "";
    $("hiring-working-interviews").value = (h && h.working_interviews   != null) ? h.working_interviews : "";
    $("hiring-hires").value              = (h && h.hires                != null) ? h.hires : "";

    if (picked.source === "none") {
      $("manager-hiring-display").innerHTML =
        sourcePillHtml(picked) +
        '<span class="mc-health-verdict" data-tier="attention" style="margin-top:8px;"><span class="mc-dot"></span>' +
          hiringVerdictLabel("attention") + '</span>' +
        '<p class="mc-empty" style="margin:8px 0 0;">Open the form below to add this week\'s numbers.</p>';
      return;
    }

    // Stats — show all 6 metrics from the spec.
    const stats = [
      { label: "Applicants (7d)",      value: h.applicants_7d        ?? 0 },
      { label: "Applicants (30d)",     value: h.applicants_30d       ?? 0 },
      { label: "Interviews scheduled", value: h.interviews_scheduled ?? 0 },
      { label: "Interviews completed", value: h.interviews_completed ?? 0 },
      { label: "Working interviews",   value: h.working_interviews   ?? 0 },
      { label: "Hires",                value: h.hires                ?? 0 }
    ];
    const conversions = [
      { label: "Applicant → Interview",         value: pctOrDash(h.interviews_scheduled, h.applicants_30d) },
      { label: "Interview → Working Interview", value: pctOrDash(h.working_interviews, h.interviews_completed) },
      { label: "Working Interview → Hire",      value: pctOrDash(h.hires, h.working_interviews) }
    ];

    const statsHtml =
      '<div class="mc-health-stats">' +
        stats.map(s =>
          '<div class="mc-health-stat">' +
            '<span>' + escapeHtml(s.label) + '</span>' +
            '<strong>' + escapeHtml(String(s.value)) + '</strong>' +
          '</div>'
        ).join("") +
      '</div>';

    const convHtml =
      '<div class="mc-conversions">' +
        '<div class="mc-conversions-title">Conversions</div>' +
        conversions.map(c =>
          '<div class="mc-health-stat">' +
            '<span>' + escapeHtml(c.label) + '</span>' +
            '<strong>' + escapeHtml(c.value) + '</strong>' +
          '</div>'
        ).join("") +
      '</div>';

    $("manager-hiring-display").innerHTML =
      sourcePillHtml(picked) +
      '<span class="mc-health-verdict" data-tier="' + tier + '" style="margin-top:8px;">' +
        '<span class="mc-dot"></span>' + escapeHtml(hiringVerdictLabel(tier)) +
      '</span>' +
      statsHtml +
      convHtml;
  }

  function sourcePillHtml(picked) {
    return '<span class="mc-source-pill" data-source="' + escapeHtml(picked.source) + '">' +
             '<span class="mc-source-dot"></span>' +
             '<span class="mc-source-label">' + escapeHtml(picked.sourceLabel) + '</span>' +
             (picked.asOf ? '<span class="mc-source-asof"> · ' + escapeHtml(picked.asOf) + '</span>' : '') +
           '</span>';
  }

  // (Phase 1A.1 placeholder renderImprovementMetrics stub removed in
  // Phase 1B hotfix — the full-featured version lives above the
  // Pipeline renderer and was being overwritten by this duplicate
  // declaration, leaving the Approved / Implemented / Rate tiles dark.)

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
    const title = $("improvement-title").value.trim();
    const desc  = $("improvement-idea").value.trim();
    if (!title) { errEl.textContent = "Title is required."; errEl.hidden = false; return; }
    if (!desc)  { errEl.textContent = "Description is required."; errEl.hidden = false; return; }
    const db = firebase.firestore();
    try {
      await db.collection("office_manager_improvements").add({
        title:               title,
        description:         desc,
        idea:                desc,                                                                                     // legacy field for backward compat
        status:              "submitted",
        owner_uid:           null,
        owner_name:          null,
        due_date:            null,
        approved_at:         null,
        implemented_at:      null,
        impact_notes:        null,
        submitted_by_uid:    currentUser.uid,
        submitted_by_email:  currentUser.email,
        submitted_by_name:   currentUser.displayName || currentUser.email,
        submitted_at:        firebase.firestore.FieldValue.serverTimestamp(),
        created_by_uid:      currentUser.uid,
        created_by_email:    currentUser.email,
        created_at:          firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:          firebase.firestore.FieldValue.serverTimestamp()
      });
      okEl.textContent = "Submitted to the pipeline.";
      okEl.hidden = false;
      $("improvement-title").value = "";
      $("improvement-idea").value = "";
      refreshAll();
    } catch (err) {
      errEl.textContent = "Couldn't save: " + (err.message || err);
      errEl.hidden = false;
    }
  }

  /* Phase 1B — Weekly Review submission. Same doc as hiring metrics
   * (office_manager_weekly_reviews/<isoWeekId>) — merge:true preserves
   * any hiring data already in the doc and stamps the new review fields
   * alongside it. */
  async function submitWeeklyReview(ev) {
    ev.preventDefault();
    const errEl = $("manager-weekly-err");
    const okEl  = $("manager-weekly-ok");
    errEl.hidden = true; okEl.hidden = true;
    const fields = {
      biggest_win:          $("weekly-biggest-win").value.trim(),
      biggest_risk:         $("weekly-biggest-risk").value.trim(),
      trend_observed:       $("weekly-trend").value.trim(),
      improvement_proposal: $("weekly-proposal").value.trim(),
      where_stuck:          $("weekly-stuck").value.trim()
    };
    if (Object.values(fields).some(v => !v)) {
      errEl.textContent = "All five prompts are required.";
      errEl.hidden = false;
      return;
    }
    const db = firebase.firestore();
    const todayPT = pacificDateString();
    const weekId = isoWeekId(todayPT);
    try {
      await db.collection("office_manager_weekly_reviews").doc(weekId).set(Object.assign({
        week_id:             weekId,
        week_ending:         fridayOfWeek(todayPT),
        updated_at:          firebase.firestore.FieldValue.serverTimestamp(),
        updated_by_uid:      currentUser.uid,
        updated_by_email:    currentUser.email,
        // First-write timestamps preserved by merge:true if already set.
        created_at:          firebase.firestore.FieldValue.serverTimestamp(),
        created_by_uid:      currentUser.uid,
        created_by_email:    currentUser.email
      }, fields), { merge: true });
      okEl.textContent = "Saved.";
      okEl.hidden = false;
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

  // Phase 2A.2 — admin-only manual trigger for the GHL hiring sync.
  // Calls refreshGhlHiringV1 with the signed-in admin's Firebase ID
  // token. The endpoint server-side re-validates admin role, so this
  // button is safe even if the /manager auth gate is ever loosened.
  function wireHiringRefresh() {
    const btn    = $("manager-hiring-refresh");
    const status = $("manager-hiring-refresh-status");
    if (!btn || !status) return;

    btn.addEventListener("click", async function () {
      if (!currentUser) {
        status.hidden = false;
        status.textContent = "Not signed in.";
        status.style.color = "var(--mc-critical, #b00020)";
        return;
      }
      const url = window.REFRESH_GHL_HIRING_URL;
      if (!url) {
        status.hidden = false;
        status.textContent = "Refresh URL not configured.";
        status.style.color = "var(--mc-critical, #b00020)";
        return;
      }

      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = "Refreshing…";
      status.hidden = false;
      status.textContent = "Pulling latest from GHL…";
      status.style.color = "var(--mc-ink-soft)";

      try {
        const idToken = await currentUser.getIdToken();
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + idToken,
            "Content-Type":  "application/json"
          },
          body: "{}"
        });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok || !body.ok) {
          const msg = (body && body.error) || ("HTTP " + res.status);
          throw new Error(msg);
        }
        const counts = (body.result && body.result.counts) || {};
        status.textContent =
          "Synced · applicants " + (counts.applicants_30d != null ? counts.applicants_30d : "?") +
          " · hires " + (counts.hires != null ? counts.hires : "?");
        status.style.color = "var(--mc-good, #1d7d3a)";

        // Reload the Hiring Health snapshot (re-fetches the just-written doc).
        await refreshAll();
      } catch (err) {
        console.error("[manager] GHL refresh failed", err);
        status.textContent = "Failed: " + ((err && err.message) || "unknown");
        status.style.color = "var(--mc-critical, #b00020)";
      } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  }

  /* ---- Phase 1C — Leadership Messages (office_manager inbox) ----
     CEO-composed notes for the office manager role. Filtered to:
       recipientType === "office_manager"
       status === "queued"
       deliverAfter <= now
       createdBy !== current user (no self-echo for April)
     Acknowledge or Dismiss flips status. Reuses team-hub-leadership-*
     card markup + styles so the visual is consistent across surfaces. */
  async function bootLeadershipMessages() {
    if (!currentUser) return;
    const section = $("manager-leadership-section");
    const list    = $("manager-leadership-list");
    if (!section || !list) return;
    const db = firebase.firestore();
    const myEmail = String((currentUser.email || "")).toLowerCase().trim();
    const nowMs   = Date.now();
    try {
      const snap = await db.collection("leadership_messages")
        .where("recipientType", "==", "office_manager")
        .where("status",        "==", "queued")
        .limit(20).get();
      const ready = snap.docs
        .map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (m) {
          const ms = leadershipTsToMs(m.deliverAfter);
          return (!ms || ms <= nowMs) && (m.createdBy || "").toLowerCase() !== myEmail;
        })
        .sort(function (a, b) {
          return leadershipTsToMs(b.createdAt) - leadershipTsToMs(a.createdAt);
        });
      if (!ready.length) { section.hidden = true; return; }
      list.innerHTML = ready.map(renderLeadershipCardHtml).join("");
      section.hidden = false;
      wireLeadershipButtons();
    } catch (err) {
      console.warn("[manager] leadership messages read failed", err);
    }
  }

  function leadershipTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts === "string") { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    return 0;
  }
  function leadershipEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function renderLeadershipCardHtml(m) {
    const typeLabel = m.messageType === "recognition" ? "Recognition"
                    : m.messageType === "coaching"    ? "Note from leadership"
                    : "Leadership Update";
    const fromWho = m.createdBy ? "From " + m.createdBy.split("@")[0] : "From Leadership";
    return (
      '<article class="team-hub-leadership-card" data-msg-id="' + leadershipEscape(m._id) + '">' +
        '<header class="team-hub-leadership-head">' +
          '<span class="team-hub-leadership-type">' + leadershipEscape(typeLabel) + '</span>' +
          '<span class="team-hub-leadership-from">' + leadershipEscape(fromWho) + '</span>' +
        '</header>' +
        '<p class="team-hub-leadership-body">' + leadershipEscape(m.messageBody || "") + '</p>' +
        '<div class="team-hub-leadership-btns">' +
          '<button type="button" class="team-hub-leadership-ack"     data-msg-action="ack">Acknowledge</button>' +
          '<button type="button" class="team-hub-leadership-dismiss" data-msg-action="dismiss">Dismiss</button>' +
        '</div>' +
        '<p class="team-hub-leadership-status" data-msg-status></p>' +
      '</article>'
    );
  }
  function wireLeadershipButtons() {
    document.querySelectorAll("#manager-leadership-list .team-hub-leadership-card")
      .forEach(function (card) {
        card.querySelectorAll("[data-msg-action]").forEach(function (btn) {
          btn.addEventListener("click", function () { handleLeadershipClick(card, btn); });
        });
      });
  }
  async function handleLeadershipClick(card, btn) {
    const msgId  = card.getAttribute("data-msg-id");
    const action = btn.getAttribute("data-msg-action");
    const status = card.querySelector("[data-msg-status]");
    if (!msgId) return;
    const nextStatus = action === "ack" ? "delivered" : "dismissed";
    btn.disabled = true;
    if (status) status.textContent = action === "ack" ? "Got it." : "";
    try {
      await firebase.firestore().collection("leadership_messages").doc(msgId).update({
        status:      nextStatus,
        deliveredAt: firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:  firebase.firestore.FieldValue.serverTimestamp()
      });
      card.style.transition = "opacity 0.3s ease";
      card.style.opacity = "0";
      setTimeout(function () {
        card.remove();
        const list = $("manager-leadership-list");
        if (list && !list.children.length) {
          const section = $("manager-leadership-section");
          if (section) section.hidden = true;
        }
      }, 320);
    } catch (err) {
      console.error("[manager] leadership message update failed", err);
      if (status) {
        status.textContent = "Couldn't save — try again.";
        status.setAttribute("data-tone", "error");
      }
      btn.disabled = false;
    }
  }

  function wireForms() {
    $("manager-bottleneck-form").addEventListener("submit", submitBottleneck);
    $("manager-reflection-form").addEventListener("submit", submitReflection);
    $("manager-improvement-form").addEventListener("submit", submitImprovement);
    $("manager-hiring-form").addEventListener("submit", submitHiring);
    const weeklyForm = $("manager-weekly-form");
    if (weeklyForm) weeklyForm.addEventListener("submit", submitWeeklyReview);
    wireBottleneckChoices();
    wireHiringRefresh();

    // Phase 1B — pipeline action delegation. One listener on the
    // pipeline section catches every per-card button click and routes
    // to applyImprovementAction(id, action).
    const pipeline = $("manager-improvements");
    if (pipeline) {
      pipeline.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-improvement-action]");
        if (!btn) return;
        const id     = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-improvement-action");
        if (!id || !action) return;
        applyImprovementAction(id, action);
      });
    }
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
