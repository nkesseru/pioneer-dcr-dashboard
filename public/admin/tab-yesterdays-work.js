/* Pioneer DCR Hub — Admin Yesterday's Work tab.
 *
 * Yesterday's Work / Nightly Recap — admin-only operational recap.
 *
 * V20260615 — Pioneer Time Clock cutover. The prior implementation
 * read deputy_shift_cache + pioneer_work_sessions; pioneer_work_sessions
 * has not been written to since today-work.js was retired in early
 * June and the tab silently returned "no data" for every selected
 * date. This rewrite uses the current source of truth:
 *
 *   service_assignments        — one row per scheduled stop
 *   pioneer_service_sessions   — the clock-in/clock-out records
 *   dcr_submissions            — joined by pioneer_service_session_id
 *
 * Iteration unit is service_assignment (not Deputy shift). One
 * assignment can spawn zero, one, or many sessions (Phase 1b.3 resume
 * flow); we report on the latest completed session. Assignments with
 * no completed session render as "Started" / "Scheduled" / "Missed"
 * per assignment.status.
 *
 * Window:
 *   service_date == selected   (calendar day; no 4pm cutoff)
 *   clean_date   == selected   (DCRs use the form's clean_date)
 *
 * DCR match (single tier — no more guess-and-pray):
 *   dcr.pioneer_service_session_id === session._id
 *
 * Status traffic light:
 *   GREEN  — completed session + DCR submitted with no issue,
 *            email sent or skipped (customer opt-out), OR session
 *            was cleanly waived ("No DCR Needed")
 *   YELLOW — DCR submitted but: issue flagged, OR email failed,
 *            OR has_problem on form
 *   RED    — completed session but no DCR (and not waived), OR
 *            DCR with red-tier issue, OR assignment.status in
 *            {missed, canceled}
 *
 * Surface lives at window.__pioneerAdmin.tabs.yesterdaysWork:
 *   { init: initYesterdayOnce }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 */
(function () {
  "use strict";

  // V20260615 — Temporary boot diagnostic. Remove after confirming
  // init wiring lands cleanly on production.
  try { console.info("[ydw] tab module loaded"); } catch (_e) {}

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-yesterdays-work.js: admin/_utils.js + admin/_shell.js must load first");
  }
  const { escapeHtml, tsToMs, cssEsc } = window.__pioneerAdmin.utils;
  const { activateTab } = window.__pioneerAdmin.shell;

  /* ---------- module state ---------- */

  let yesterdayWired = false;
  let yesterdayLastReport = null;
  let _ydwViewDcrWired = false;

  function initYesterdayOnce() {
    try { console.info("[ydw] init called", { wired: yesterdayWired }); } catch (_e) {}
    wireYesterdayViewDcr();
    if (yesterdayWired) {
      loadYesterdayReport();
      return;
    }
    yesterdayWired = true;
    const dateEl  = document.getElementById("yesterday-date");
    const prevBtn = document.getElementById("yesterday-prev-day");
    const nextBtn = document.getElementById("yesterday-next-day");
    const refresh = document.getElementById("yesterday-refresh");
    try {
      console.info("[ydw] DOM lookups", {
        dateEl: !!dateEl, prevBtn: !!prevBtn, nextBtn: !!nextBtn, refresh: !!refresh
      });
    } catch (_e) {}
    if (dateEl) {
      dateEl.value = pacificYesterdayDate();
      try { console.info("[ydw] default date set:", dateEl.value); } catch (_e) {}
      dateEl.addEventListener("change", function () { loadYesterdayReport(); });
    }
    if (prevBtn) prevBtn.addEventListener("click", function () { shiftYesterdayDate(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { shiftYesterdayDate(1); });
    if (refresh) {
      try { console.info("[ydw] refresh listener attached"); } catch (_e) {}
      refresh.addEventListener("click", function () {
        try { console.info("[ydw] refresh clicked"); } catch (_e) {}
        loadYesterdayReport();
      });
    }
    loadYesterdayReport();
  }

  /* ---------- date helpers ---------- */

  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
  }
  function pacificYesterdayDate() {
    return pacificDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }
  function shiftYesterdayDate(deltaDays) {
    const el = document.getElementById("yesterday-date");
    if (!el || !el.value) return;
    const [y, m, d] = el.value.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    base.setUTCDate(base.getUTCDate() + deltaDays);
    el.value = pacificDateString(base);
    loadYesterdayReport();
  }

  function formatTimeRangePT(startMs, endMs) {
    function fmt(ms) {
      if (!ms) return "";
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric", minute: "2-digit", hour12: true
        }).format(new Date(ms));
      } catch (_e) { return ""; }
    }
    const s = fmt(startMs);
    const e = fmt(endMs);
    if (s && e) return s + " – " + e;
    return s || e || "";
  }
  function formatMinutes(m) {
    if (m == null || !isFinite(m)) return "";
    const n = Math.round(m);
    if (n === 0) return "0m";
    const h = Math.floor(n / 60);
    const r = n % 60;
    if (h === 0) return r + "m";
    if (r === 0) return h + "h";
    return h + "h " + r + "m";
  }

  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }
  function normSlug(s)  { return String(s == null ? "" : s).trim().toLowerCase(); }

  /* ---------- load + build ---------- */

  async function loadYesterdayReport() {
    const dateEl  = document.getElementById("yesterday-date");
    const loading = document.getElementById("yesterday-loading");
    const errEl   = document.getElementById("yesterday-error");
    const sumEl   = document.getElementById("yesterday-summary");
    const techEl  = document.getElementById("yesterday-by-tech");
    const undcrEl = document.getElementById("yesterday-unmatched-dcrs");
    const unshEl  = document.getElementById("yesterday-unmatched-shifts");
    const emptyEl = document.getElementById("yesterday-empty");
    const labelEl = document.getElementById("yesterday-window-label");
    if (!dateEl) return;

    const selected = dateEl.value || pacificYesterdayDate();

    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden   = true;
    if (sumEl)   sumEl.hidden   = true;
    if (techEl)  techEl.innerHTML = "";
    if (undcrEl) undcrEl.hidden = true;
    if (unshEl)  unshEl.hidden  = true;
    if (emptyEl) emptyEl.hidden = true;
    if (labelEl) {
      labelEl.textContent = "Pioneer Time Clock · service date " + selected;
    }

    try {
      try { console.info("[ydw] query starting for service_date =", selected); } catch (_e) {}
      const db = firebase.firestore();

      const [assignmentsSnap, sessionsSnap, dcrsSnap, issuesSnap, techsSnap, customersSnap] = await Promise.all([
        db.collection("service_assignments").where("service_date", "==", selected).get(),
        db.collection("pioneer_service_sessions").where("service_date", "==", selected).get(),
        db.collection("dcr_submissions").where("clean_date", "==", selected).get(),
        db.collection("dcr_issues").where("clean_date", "==", selected).get().catch(function () { return { docs: [] }; }),
        db.collection("cleaning_techs").get(),
        db.collection("customers").get()
      ]);

      const assignments = assignmentsSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
      const sessions    = sessionsSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
      const dcrs        = dcrsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const issues      = (issuesSnap.docs || []).map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const techs       = techsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const customers   = customersSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

      const report = buildYesterdayReport({
        selected:    selected,
        assignments: assignments,
        sessions:    sessions,
        dcrs:        dcrs,
        issues:      issues,
        techs:       techs,
        customers:   customers
      });
      yesterdayLastReport = report;

      renderYesterdaySummary(report);
      renderYesterdayByTech(report);
      renderYesterdayUnmatched(report);

      if (report.summary.scheduled === 0 && report.summary.dcrs_submitted === 0) {
        if (emptyEl) emptyEl.hidden = false;
      }
    } catch (err) {
      console.error("yesterday: load failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't load: " + (err && err.message ? err.message : "unknown error");
        errEl.hidden = false;
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function buildYesterdayReport(ctx) {
    // Index sessions by assignment_id (one assignment → many sessions
    // possible with the resume flow; we surface the latest completed
    // one per assignment).
    const sessionsByAssignment = Object.create(null);
    ctx.sessions.forEach(function (s) {
      const k = String(s.assignment_id || "");
      if (!k) return;
      if (!sessionsByAssignment[k]) sessionsByAssignment[k] = [];
      sessionsByAssignment[k].push(s);
    });
    function latestCompleted(list) {
      if (!list || !list.length) return null;
      const done = list.filter(function (s) { return s.status === "completed"; });
      if (!done.length) return null;
      done.sort(function (a, b) {
        return (tsToMs(b.clock_out_at) || 0) - (tsToMs(a.clock_out_at) || 0);
      });
      return done[0];
    }
    function anyStartedOrActive(list) {
      if (!list || !list.length) return false;
      return list.some(function (s) {
        const st = String(s.status || "").toLowerCase();
        return st === "active" || st === "paused" || st === "completed";
      });
    }

    // DCR match: single key by pioneer_service_session_id. Built once
    // per render; no fallback chain (the rewrite's whole point is that
    // we no longer need to guess which Deputy/Pioneer id pairs up).
    const dcrBySessionId = Object.create(null);
    ctx.dcrs.forEach(function (d) {
      const sid = String(d.pioneer_service_session_id || "").trim();
      if (sid) dcrBySessionId[sid] = d;
    });

    // Lookup tables.
    const customerBySlug = Object.create(null);
    ctx.customers.forEach(function (c) {
      customerBySlug[normSlug(c.customer_slug || c.id)] = c;
    });
    const techByUid   = Object.create(null);
    const techBySlug  = Object.create(null);
    const techByEmail = Object.create(null);
    ctx.techs.forEach(function (t) {
      if (t.auth_uid) techByUid[String(t.auth_uid)] = t;
      if (t.uid)      techByUid[String(t.uid)]      = t;
      techBySlug[normSlug(t.tech_slug || t.id)] = t;
      if (t.email) techByEmail[normEmail(t.email)] = t;
    });
    const issuesByDcrId = Object.create(null);
    ctx.issues.forEach(function (i) {
      const k = String(i.dcr_submission_id || i.submission_id || "");
      if (!k) return;
      if (!issuesByDcrId[k]) issuesByDcrId[k] = [];
      issuesByDcrId[k].push(i);
    });

    const matchedDcrIds = Object.create(null);

    // One row per assignment.
    const rows = ctx.assignments.map(function (a) {
      const sessList    = sessionsByAssignment[a._id] || [];
      const completed   = latestCompleted(sessList);
      const startedAny  = anyStartedOrActive(sessList);
      const dcr         = completed ? (dcrBySessionId[completed._id] || null) : null;
      if (dcr) matchedDcrIds[dcr.submission_id] = true;

      const assignStatus = String(a.status || "").toLowerCase();
      const sessStatus   = completed ? "completed"
                          : (sessList.length ? String(sessList[sessList.length - 1].status || "").toLowerCase() : "");

      // Waived = the session itself was marked dcr_status:"waived" via
      // the "No DCR Needed" button. Mirrored on the assignment doc too.
      const waived = !!(
        (completed && completed.dcr_status === "waived") ||
        a.dcr_waived === true ||
        a.dcr_status === "waived"
      );

      const emailStatus = dcr ? String(dcr.emailStatus || "").toLowerCase() : "";
      const emailError  = dcr ? (dcr.emailError || "") : "";
      const issueTier   = dcr
        ? String((dcr.issueRouting && dcr.issueRouting.tier) || dcr.issueTier || "").toLowerCase()
        : "";
      const hasProblem = !!(dcr && dcr.form_data && dcr.form_data.has_problem === true);
      const issueDocs  = dcr ? (issuesByDcrId[dcr.submission_id] || []) : [];

      // Traffic light.
      let status = "RED";
      let statusReason = "Scheduled but no clock-in";
      if (dcr) {
        if (issueTier === "red") {
          status = "RED"; statusReason = "DCR flagged red tier";
        } else if (issueTier === "yellow" || hasProblem) {
          status = "YELLOW";
          statusReason = hasProblem ? "DCR notes a problem on this visit" : "DCR flagged yellow tier";
        } else if (emailStatus === "failed") {
          status = "YELLOW"; statusReason = "Customer email delivery failed";
        } else {
          status = "GREEN"; statusReason = "Submitted cleanly";
        }
      } else if (waived) {
        status = "GREEN"; statusReason = "Marked No DCR Needed";
      } else if (assignStatus === "missed" || assignStatus === "canceled") {
        status = "RED"; statusReason = "Shift " + assignStatus;
      } else if (completed) {
        status = "RED"; statusReason = "Clocked out but no DCR";
      } else if (startedAny) {
        status = "YELLOW"; statusReason = "Started but not finished";
      }

      // Tech identity.
      const techRecord = (a.staff_uid && techByUid[String(a.staff_uid)]) ||
                         techByEmail[normEmail(a.staff_email)] ||
                         null;
      const techDisplay = a.staff_display_name ||
                         (techRecord && techRecord.display_name) ||
                         a.staff_email || "(unknown tech)";
      const techSlug    = normSlug((techRecord && (techRecord.tech_slug || techRecord.id)) || "");

      // Customer display.
      const custSlug = normSlug(a.customer_id || (dcr && dcr.customer_slug));
      const customer = customerBySlug[custSlug] || null;
      const customerName =
        (customer && window.PioneerCustomerDisplay
          && window.PioneerCustomerDisplay.getCustomerDisplayName(customer)) ||
        (customer && (customer.customer_name || customer.name)) ||
        a.customer_name || "(no customer)";

      // Times — scheduled from the assignment, actual from the
      // completed session (when present).
      const scheduledStart = tsToMs(a.service_window_start) || tsToMs(a.available_from);
      const scheduledEnd   = tsToMs(a.service_deadline)     || tsToMs(a.available_until);
      const actualStart    = completed ? tsToMs(completed.clock_in_at)  : null;
      const actualEnd      = completed ? tsToMs(completed.clock_out_at) : null;
      const paidMinutes    = completed ? Number(completed.paid_minutes || 0) : 0;

      return {
        assignment_id:   a._id,
        session_id:      completed ? completed._id : null,
        tech_slug:       techSlug,
        tech_display:    techDisplay,
        tech_email:      normEmail(a.staff_email),
        tech_uid:        String(a.staff_uid || ""),
        customer_slug:   custSlug,
        customer_name:   customerName,
        scheduled_start: scheduledStart,
        scheduled_end:   scheduledEnd,
        actual_start:    actualStart,
        actual_end:      actualEnd,
        paid_minutes:    paidMinutes,
        service_date:    a.service_date || "",
        assignment_status: assignStatus,
        session_status:  sessStatus,
        started:         startedAny,
        finished:        !!completed,
        waived:          waived,
        dcr:             dcr,
        match_path:      dcr ? "pioneer_service_session_id" : null,
        email_status:    emailStatus || (dcr ? "(not run)" : ""),
        email_error:     emailError,
        issue_tier:      issueTier,
        has_problem:     hasProblem,
        issue_docs:      issueDocs,
        status:          status,
        status_reason:   statusReason
      };
    });

    // Group by tech.
    const byTechKey = Object.create(null);
    rows.forEach(function (r) {
      const k = r.tech_uid || r.tech_slug || r.tech_email || r.tech_display;
      if (!byTechKey[k]) {
        byTechKey[k] = {
          tech_uid:      r.tech_uid,
          tech_slug:     r.tech_slug,
          tech_display:  r.tech_display,
          tech_email:    r.tech_email,
          rows:          [],
          counts: { scheduled: 0, started: 0, finished: 0, dcrs: 0, waived: 0,
                    issues: 0, emails_sent: 0, emails_failed: 0,
                    paid_minutes: 0 }
        };
      }
      const bucket = byTechKey[k];
      bucket.rows.push(r);
      bucket.counts.scheduled++;
      if (r.started)        bucket.counts.started++;
      if (r.finished)       bucket.counts.finished++;
      if (r.dcr)            bucket.counts.dcrs++;
      if (r.waived)         bucket.counts.waived++;
      if (r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem) bucket.counts.issues++;
      if (r.email_status === "sent")   bucket.counts.emails_sent++;
      if (r.email_status === "failed") bucket.counts.emails_failed++;
      bucket.counts.paid_minutes += r.paid_minutes || 0;
    });
    const byTech = Object.keys(byTechKey).map(function (k) { return byTechKey[k]; });
    byTech.sort(function (a, b) {
      return String(a.tech_display || "").localeCompare(String(b.tech_display || ""));
    });

    // Unmatched DCRs (clean_date == selected but no session link).
    const unmatchedDcrs = ctx.dcrs.filter(function (d) {
      return !matchedDcrIds[d.submission_id];
    });

    // Unmatched assignments = finished sessions with no DCR AND not waived,
    // plus missed/canceled assignments. Surface them so admins see what
    // needs follow-up.
    const unmatchedShifts = rows.filter(function (r) {
      return !r.dcr && !r.waived;
    });

    // Summary.
    const summary = {
      window_start_date: ctx.selected,
      window_end_date:   ctx.selected,
      scheduled:         rows.length,
      started:           rows.filter(function (r) { return r.started;  }).length,
      finished:          rows.filter(function (r) { return r.finished; }).length,
      waived:            rows.filter(function (r) { return r.waived;   }).length,
      dcrs_submitted:    ctx.dcrs.length,
      dcrs_missing:      unmatchedShifts.length,
      issues:            rows.filter(function (r) {
                           return r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem;
                         }).length,
      emails_sent:       rows.filter(function (r) { return r.email_status === "sent";   }).length,
      emails_failed:     rows.filter(function (r) { return r.email_status === "failed"; }).length,
      paid_minutes:      rows.reduce(function (sum, r) { return sum + (r.paid_minutes || 0); }, 0)
    };

    return {
      generated_at:      new Date().toISOString(),
      selected_date:     ctx.selected,
      summary:           summary,
      by_tech:           byTech,
      unmatched_dcrs:    unmatchedDcrs,
      unmatched_shifts: unmatchedShifts
    };
  }

  /* ---------- render ---------- */

  function renderYesterdaySummary(report) {
    const el = document.getElementById("yesterday-summary");
    if (!el) return;
    const s = report.summary;
    el.innerHTML =
      '<div class="ydw-stat"><span class="ydw-stat-label">Scheduled stops</span><strong>'  + s.scheduled       + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Started</span><strong>'          + s.started         + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Finished</span><strong>'         + s.finished        + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Paid time</span><strong>'        + escapeHtml(formatMinutes(s.paid_minutes) || "—") + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">DCRs submitted</span><strong>'   + s.dcrs_submitted  + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Waived</span><strong>'           + s.waived          + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-warn"><span class="ydw-stat-label">DCRs missing</span><strong>' + s.dcrs_missing + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Issues</span><strong>'           + s.issues          + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-pass"><span class="ydw-stat-label">Emails sent</span><strong>' + s.emails_sent  + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-fail"><span class="ydw-stat-label">Emails failed</span><strong>' + s.emails_failed + '</strong></div>';
    el.hidden = false;
  }

  function renderYesterdayByTech(report) {
    const el = document.getElementById("yesterday-by-tech");
    if (!el) return;
    if (report.by_tech.length === 0) {
      el.innerHTML = "";
      return;
    }
    const debug = isYesterdayDebug();
    el.innerHTML = report.by_tech.map(function (bucket) {
      const c = bucket.counts;
      const paidLabel = c.paid_minutes ? ' · ' + escapeHtml(formatMinutes(c.paid_minutes)) + ' paid' : '';
      const techHeader =
        '<header class="ydw-tech-head">' +
          '<strong class="ydw-tech-name">' + escapeHtml(bucket.tech_display || "(unknown)") + '</strong> ' +
          '<span class="ydw-tech-meta">' +
            escapeHtml(bucket.tech_email || "") +
          '</span>' +
          '<span class="ydw-tech-counts">' +
            c.scheduled + ' assigned · ' + c.started + ' started · ' + c.finished + ' finished' + paidLabel + ' · ' +
            c.dcrs + ' DCR' + (c.dcrs === 1 ? '' : 's') +
            (c.waived > 0 ? ' · ' + c.waived + ' waived' : '') +
            (c.issues > 0 ? ' · <span class="ydw-tag warn">' + c.issues + ' issue' + (c.issues === 1 ? '' : 's') + '</span>' : '') +
            (c.emails_failed > 0 ? ' · <span class="ydw-tag fail">' + c.emails_failed + ' email failed</span>' : '') +
          '</span>' +
        '</header>';
      const rows = bucket.rows.map(function (r) { return renderYesterdayRow(r, debug); }).join("");
      return '<article class="ydw-tech">' + techHeader + '<ul class="ydw-row-list">' + rows + '</ul></article>';
    }).join("");
  }

  function renderYesterdayRow(r, debug) {
    const schedText = formatTimeRangePT(r.scheduled_start, r.scheduled_end);
    const actText   = formatTimeRangePT(r.actual_start,    r.actual_end);
    const timeText  = actText || schedText || "(no time)";
    const statusBadge = '<span class="ydw-status ydw-' + r.status + '">' + r.status + '</span>';
    const startedChip  = r.started  ? '<span class="ydw-chip">Started</span>'  : '';
    const finishedChip = r.finished ? '<span class="ydw-chip">Finished</span>' : '';
    const paidChip = r.paid_minutes
      ? '<span class="ydw-chip">' + escapeHtml(formatMinutes(r.paid_minutes)) + ' paid</span>'
      : '';
    let dcrChip;
    if (r.dcr)              dcrChip = '<span class="ydw-chip pass">DCR</span>';
    else if (r.waived)      dcrChip = '<span class="ydw-chip">DCR waived</span>';
    else if (r.finished)    dcrChip = '<span class="ydw-chip fail">No DCR</span>';
    else                    dcrChip = '';
    const issueChip = (r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem)
      ? '<span class="ydw-chip warn">Issue</span>'
      : '';
    let emailChip = '';
    if (r.dcr) {
      if (r.email_status === "sent")    emailChip = '<span class="ydw-chip pass">Email sent</span>';
      else if (r.email_status === "failed") emailChip = '<span class="ydw-chip fail" title="' + escapeHtml(r.email_error || "") + '">Email delivery failed</span>';
      else if (r.email_status === "skipped") emailChip = '<span class="ydw-chip">Email skipped (opt-out)</span>';
      else                              emailChip = '<span class="ydw-chip">Email not yet sent</span>';
    }
    const dcrLink = r.dcr
      ? '<a class="ydw-link" href="#" data-ydw-dcr="' + escapeHtml(r.dcr.submission_id) + '">View DCR</a>'
      : '';
    const reportLink = (r.dcr && r.dcr.report_url)
      ? ' · <a class="ydw-link" href="' + escapeHtml(r.dcr.report_url) + '" target="_blank" rel="noopener noreferrer">Customer report ↗</a>'
      : '';
    const viewCount = (r.dcr && Number(r.dcr.report_view_count) > 0)
      ? ('<span class="ydw-chip pass" title="Last viewed: ' +
          escapeHtml(formatReportViewedTime(r.dcr.last_report_viewed_at)) + '">' +
          'Customer viewed ' + Number(r.dcr.report_view_count) + 'x' +
        '</span>')
      : (r.dcr && r.dcr.report_url
          ? '<span class="ydw-chip" title="Customer has not opened the link yet">Customer report unread</span>'
          : '');
    const custLink = r.customer_slug
      ? '<a class="ydw-link" href="/admin?customer_slug=' + escapeHtml(r.customer_slug) + '#customer-' + escapeHtml(r.customer_slug) + '" target="_blank" rel="noopener">View customer</a>'
      : '';
    const reason  = '<span class="ydw-row-reason">' + escapeHtml(r.status_reason) + '</span>';
    const debugBlock = debug
      ? '<div class="ydw-debug">' +
          'assignment=' + escapeHtml(r.assignment_id) +
          (r.session_id ? ' · session=' + escapeHtml(r.session_id) : '') +
          (r.dcr ? ' · dcr=' + escapeHtml(r.dcr.submission_id) : '') +
          (r.match_path ? ' · matched_by=' + escapeHtml(r.match_path) : '') +
        '</div>'
      : '';
    return '<li class="ydw-row ydw-row-' + r.status + '">' +
             '<div class="ydw-row-head">' +
               statusBadge +
               '<strong class="ydw-row-customer">' + escapeHtml(r.customer_name) + '</strong>' +
               '<span class="ydw-row-time">' + escapeHtml(timeText) + '</span>' +
             '</div>' +
             '<div class="ydw-row-chips">' +
               startedChip + finishedChip + paidChip + dcrChip + issueChip + emailChip + viewCount +
             '</div>' +
             reason +
             '<div class="ydw-row-actions">' + dcrLink + (dcrLink && custLink ? ' · ' : '') + custLink + reportLink + '</div>' +
             debugBlock +
           '</li>';
  }

  function renderYesterdayUnmatched(report) {
    const undcrEl     = document.getElementById("yesterday-unmatched-dcrs");
    const undcrListEl = document.getElementById("yesterday-unmatched-dcrs-list");
    const unshEl      = document.getElementById("yesterday-unmatched-shifts");
    const unshListEl  = document.getElementById("yesterday-unmatched-shifts-list");

    if (undcrEl && undcrListEl) {
      if (report.unmatched_dcrs.length === 0) {
        undcrEl.hidden = true;
      } else {
        undcrListEl.innerHTML = report.unmatched_dcrs.map(function (d) {
          return '<div class="ydw-unmatched-row">' +
                   '<strong>' + escapeHtml(d.customer_name || d.customer_slug || "(no customer)") + '</strong>' +
                   ' — ' + escapeHtml(d.tech_display_name || d.tech_slug || d.submitted_by_email || "") +
                   ' · ' + escapeHtml(d.clean_date || "") +
                   ' · ' + '<a class="ydw-link" href="#" data-ydw-dcr="' + escapeHtml(d.submission_id) + '">View DCR</a>' +
                 '</div>';
        }).join("");
        undcrEl.hidden = false;
      }
    }
    if (unshEl && unshListEl) {
      if (report.unmatched_shifts.length === 0) {
        unshEl.hidden = true;
      } else {
        unshListEl.innerHTML = report.unmatched_shifts.map(function (r) {
          return '<div class="ydw-unmatched-row">' +
                   '<strong>' + escapeHtml(r.customer_name) + '</strong>' +
                   ' — ' + escapeHtml(r.tech_display) +
                   ' · ' + escapeHtml(formatTimeRangePT(r.scheduled_start, r.scheduled_end) || r.service_date) +
                   ' · <em>' + escapeHtml(r.status_reason) + '</em>' +
                 '</div>';
        }).join("");
        unshEl.hidden = false;
      }
    }
  }

  function formatReportViewedTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "(unknown)";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "(unknown)"; }
  }

  function isYesterdayDebug() {
    try {
      const u = new URLSearchParams(location.search || "");
      const v = u.get("debug_yesterday");
      return v === "1" || v === "true";
    } catch (_e) { return false; }
  }

  // "View DCR" anchor delegate — jumps to Recent DCRs tab and scrolls
  // the target row into view. Uses event delegation since each report
  // render replaces the DOM. Idempotent — re-binding the listener is
  // safe because of the once-only flag.
  function wireYesterdayViewDcr() {
    if (_ydwViewDcrWired) return;
    _ydwViewDcrWired = true;
    document.addEventListener("click", function (ev) {
      const a = ev.target && ev.target.closest && ev.target.closest("[data-ydw-dcr]");
      if (!a) return;
      ev.preventDefault();
      const submissionId = a.getAttribute("data-ydw-dcr");
      if (!submissionId) return;
      activateTab("dcrs");
      setTimeout(function () {
        const row = document.querySelector('#dcr-list [data-id="' + cssEsc(submissionId) + '"]');
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.add("admin-row-highlight");
          setTimeout(function () { row.classList.remove("admin-row-highlight"); }, 2000);
        }
      }, 250);
    });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.yesterdaysWork = {
    init: initYesterdayOnce
  };
}());
