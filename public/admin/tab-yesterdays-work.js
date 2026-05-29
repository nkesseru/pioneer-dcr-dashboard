/* Pioneer DCR Hub — Admin Yesterday's Work tab (vanilla JS, no build).
 *
 * Yesterday's Work / Nightly Recap — admin-only operational recap.
 *
 * Pure frontend. Admin reads cover every collection it needs:
 *   deputy_shift_cache · pioneer_work_sessions · dcr_submissions ·
 *   dcr_issues · cleaning_techs · customers.
 *
 * The selected ops day window = [selected date 4:00pm PT,
 *                                next date  4:00pm PT).
 * Pacific 4pm cutoff is the operational close-of-day for PioneerOps.
 *
 * Matching shift → DCR runs strongest-first:
 *   1. dcr.pioneer_session_id === shift.shift_id
 *   2. dcr.deputy_shift_id    === shift.shift_id
 *   3. tech_slug + customer_slug + clean_date == sync_date
 *   4. tech_email + customer_slug + clean_date (final fallback)
 *
 * Email status comes from `emailStatus` on the dcr_submissions doc
 * (set by dcrEmail.js). Legacy `zapier.status` is shown only in the
 * debug payload — it is NOT used to decide GREEN/YELLOW/RED.
 *
 * Status traffic light:
 *   GREEN  — DCR submitted, no issue, native email sent or skipped
 *   YELLOW — DCR submitted but: issue flagged, OR email failed,
 *            OR has_problem on form
 *   RED    — scheduled/started but no DCR submitted, OR red-tier issue
 *
 * Surface lives at window.__pioneerAdmin.tabs.yesterdaysWork:
 *   { init: initYesterdayOnce }
 *
 * Idempotent init wires the date selector, prev/next-day buttons,
 * refresh button, and the global "View DCR" click delegator. Each
 * subsequent activation re-fetches via loadYesterdayReport without
 * re-wiring.
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, tsToMs, cssEsc from __pioneerAdmin.utils
 *   • activateTab from __pioneerAdmin.shell (used by the "View DCR"
 *     click delegator to jump to the Recent DCRs tab)
 *   • window.firebase compat SDK (firestore)
 *   • window.PioneerCustomerDisplay (from public/customer-display.js)
 *
 * No closure deps on admin.js. No cross-tab state escape — the report
 * cache and once-wired flag live inside this IIFE.
 */
(function () {
  "use strict";

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
    // First call wires the document-level "View DCR" click delegator —
    // idempotent via its own once-only flag. Subsequent re-activations
    // re-fetch only.
    wireYesterdayViewDcr();
    if (yesterdayWired) {
      // Already wired — keep current date but re-fetch fresh data.
      loadYesterdayReport();
      return;
    }
    yesterdayWired = true;
    const dateEl  = document.getElementById("yesterday-date");
    const prevBtn = document.getElementById("yesterday-prev-day");
    const nextBtn = document.getElementById("yesterday-next-day");
    const refresh = document.getElementById("yesterday-refresh");
    if (dateEl) {
      dateEl.value = pacificYesterdayDate();
      dateEl.addEventListener("change", function () { loadYesterdayReport(); });
    }
    if (prevBtn) prevBtn.addEventListener("click", function () { shiftYesterdayDate(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { shiftYesterdayDate(1); });
    if (refresh) refresh.addEventListener("click", function () { loadYesterdayReport(); });
    loadYesterdayReport();
  }

  // YYYY-MM-DD in America/Los_Angeles for today and yesterday.
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

  function nextDay(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    base.setUTCDate(base.getUTCDate() + 1);
    return pacificDateString(base);
  }

  // The ops window for a selected date = [selected 4pm PT, next 4pm PT).
  // Returns ISO strings for label rendering + millisecond bounds for
  // optional scheduled_start filtering (the primary key is sync_date).
  function opsWindowFor(selectedDate) {
    const start = new Date(selectedDate + "T16:00:00-07:00");
    const end   = new Date(nextDay(selectedDate) + "T16:00:00-07:00");
    // -07:00 is fine year-round here because PioneerOps is fixed Pacific
    // — DST jitter of one hour at the boundary doesn't change WHICH
    // shifts fall in the window, since deputy_shift_cache buckets by
    // sync_date.
    return { startMs: start.getTime(), endMs: end.getTime() };
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

  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }
  function normSlug(s)  { return String(s == null ? "" : s).trim().toLowerCase(); }

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
    const nextDate = nextDay(selected);
    const opsWindow = opsWindowFor(selected);

    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden   = true;
    if (sumEl)   sumEl.hidden   = true;
    if (techEl)  techEl.innerHTML = "";
    if (undcrEl) undcrEl.hidden = true;
    if (unshEl)  unshEl.hidden  = true;
    if (emptyEl) emptyEl.hidden = true;
    if (labelEl) {
      labelEl.textContent = "Ops window · " + selected + " 4:00pm PT → " +
        nextDate + " 4:00pm PT";
    }

    try {
      const db = firebase.firestore();
      const dateRange = [selected, nextDate];

      const [shiftsSnap, sessionsSnap, dcrsSnap, issuesSnap, techsSnap, customersSnap] = await Promise.all([
        db.collection("deputy_shift_cache").where("sync_date", "in", dateRange).get(),
        db.collection("pioneer_work_sessions").where("sync_date", "in", dateRange).get(),
        db.collection("dcr_submissions").where("clean_date", "in", dateRange).get(),
        db.collection("dcr_issues").where("clean_date", "in", dateRange).get().catch(function () { return { docs: [] }; }),
        db.collection("cleaning_techs").get(),
        db.collection("customers").get()
      ]);

      const shifts    = shiftsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const sessions  = sessionsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const dcrs      = dcrsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const issues    = (issuesSnap.docs || []).map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const techs     = techsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const customers = customersSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

      // Optional finer filter: when a shift carries a scheduled_start
      // outside the 24h ops window, drop it. Shifts with no start time
      // fall back to sync_date attribution.
      const inWindow = function (shift) {
        const sMs = tsToMs(shift.start_time);
        if (sMs == null) return true;
        return sMs >= opsWindow.startMs && sMs < opsWindow.endMs;
      };
      const filteredShifts = shifts.filter(inWindow);

      const report = buildYesterdayReport({
        selected:   selected,
        shifts:     filteredShifts,
        sessions:   sessions,
        dcrs:       dcrs,
        issues:     issues,
        techs:      techs,
        customers:  customers
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
    const sessionByShiftId = Object.create(null);
    ctx.sessions.forEach(function (s) {
      const k = String(s.deputy_shift_id || s.id);
      sessionByShiftId[k] = s;
    });
    const customerBySlug = Object.create(null);
    ctx.customers.forEach(function (c) {
      customerBySlug[normSlug(c.customer_slug || c.id)] = c;
    });
    const techBySlug = Object.create(null);
    const techByEmail = Object.create(null);
    ctx.techs.forEach(function (t) {
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

    // Build the dcr-match index by every key we might match on.
    const dcrByPioneerSession = Object.create(null);
    const dcrByDeputyShift    = Object.create(null);
    const dcrByTripleKey      = Object.create(null); // techSlug|custSlug|cleanDate
    const dcrByEmailKey       = Object.create(null); // techEmail|custSlug|cleanDate
    ctx.dcrs.forEach(function (d) {
      const psid = String(d.pioneer_session_id || "").trim();
      if (psid) dcrByPioneerSession[psid] = d;
      const dsid = String(d.deputy_shift_id || "").trim();
      if (dsid) dcrByDeputyShift[dsid] = d;
      const triple = normSlug(d.tech_slug) + "|" + normSlug(d.customer_slug) + "|" + (d.clean_date || "");
      dcrByTripleKey[triple] = d;
      const emailKey = normEmail(d.submitted_by_email || d.tech_email) + "|" + normSlug(d.customer_slug) + "|" + (d.clean_date || "");
      dcrByEmailKey[emailKey] = d;
    });
    const matchedDcrIds = Object.create(null);

    function matchDcrForShift(shift, session) {
      const sid = String(shift.shift_id || shift.id);
      // 1. pioneer_session_id (set when DCR opened from Start Work)
      if (dcrByPioneerSession[sid]) {
        matchedDcrIds[dcrByPioneerSession[sid].submission_id] = true;
        return { dcr: dcrByPioneerSession[sid], match_path: "pioneer_session_id" };
      }
      // 2. deputy_shift_id (same value but stamped via the session writeback)
      if (dcrByDeputyShift[sid]) {
        matchedDcrIds[dcrByDeputyShift[sid].submission_id] = true;
        return { dcr: dcrByDeputyShift[sid], match_path: "deputy_shift_id" };
      }
      // 3. tech_slug + customer_slug + clean_date
      const techSlug   = normSlug(shift.employee_slug || (session && session.tech_slug));
      const custSlug   = normSlug(shift.customer_slug || (session && session.selected_customer_slug));
      const cleanDate  = shift.sync_date || (session && session.sync_date) || "";
      if (techSlug && custSlug && cleanDate) {
        const k = techSlug + "|" + custSlug + "|" + cleanDate;
        if (dcrByTripleKey[k]) {
          matchedDcrIds[dcrByTripleKey[k].submission_id] = true;
          return { dcr: dcrByTripleKey[k], match_path: "tech_slug+customer_slug+clean_date" };
        }
      }
      // 4. tech_email + customer_slug + clean_date (final fallback)
      const techEmail = normEmail(shift.employee_email || (session && session.tech_email));
      if (techEmail && custSlug && cleanDate) {
        const k = techEmail + "|" + custSlug + "|" + cleanDate;
        if (dcrByEmailKey[k]) {
          matchedDcrIds[dcrByEmailKey[k].submission_id] = true;
          return { dcr: dcrByEmailKey[k], match_path: "tech_email+customer_slug+clean_date" };
        }
      }
      return { dcr: null, match_path: null };
    }

    // Per-shift row.
    const rows = ctx.shifts.map(function (shift) {
      const sid = String(shift.shift_id || shift.id);
      const session = sessionByShiftId[sid] || null;
      const matched = matchDcrForShift(shift, session);
      const dcr = matched.dcr;

      const sessStatus = session ? String(session.status || "").toLowerCase() : "";
      const started   = !!session && sessStatus !== "not_started";
      const finished  = sessStatus === "finished" || sessStatus === "needs_finish" || !!dcr;

      // Email status (native). Ignore zapier.status — legacy.
      const emailStatus = dcr ? String(dcr.emailStatus || "").toLowerCase() : "";
      const emailError  = dcr ? (dcr.emailError || "") : "";
      const issueTier   = dcr
        ? String((dcr.issueRouting && dcr.issueRouting.tier) || dcr.issueTier || "").toLowerCase()
        : "";
      const hasProblem = !!(dcr && dcr.form_data && dcr.form_data.has_problem === true);
      const issueDocs  = dcr ? (issuesByDcrId[dcr.submission_id] || []) : [];

      // Traffic light.
      let status = "RED";
      let statusReason = "Scheduled but no DCR submitted";
      if (dcr) {
        if (issueTier === "red") {
          status = "RED"; statusReason = "DCR flagged red tier";
        } else if (issueTier === "yellow" || hasProblem) {
          status = "YELLOW"; statusReason = hasProblem
            ? "DCR notes a problem on this visit"
            : "DCR flagged yellow tier";
        } else if (emailStatus === "failed") {
          status = "YELLOW"; statusReason = "Customer email delivery failed";
        } else {
          status = "GREEN"; statusReason = "Submitted cleanly";
        }
      } else if (started && !dcr) {
        status = "RED"; statusReason = "Started but no DCR submitted";
      }

      const techSlug = normSlug(shift.employee_slug || (session && session.tech_slug));
      const techRecord = techBySlug[techSlug] ||
        techByEmail[normEmail(shift.employee_email)] ||
        null;
      const techDisplay = (techRecord && techRecord.display_name) ||
        shift.employee_display_name ||
        shift.employee_email || "(unknown tech)";

      const custSlug = normSlug(shift.customer_slug || (session && session.selected_customer_slug));
      const customer = customerBySlug[custSlug] || null;
      // Canonical helper — applies displayNameMode + customDisplayName
      // when the customer doc carries the new schema fields. Falls back
      // to the shift-level customer_name (Deputy sync output) when no
      // doc lookup is available.
      const customerName =
        (customer && window.PioneerCustomerDisplay
          && window.PioneerCustomerDisplay.getCustomerDisplayName(customer)) ||
        (customer && (customer.customer_name || customer.name)) ||
        shift.customer_name || "(no customer)";

      return {
        shift_id:        sid,
        tech_slug:       techSlug,
        tech_display:    techDisplay,
        tech_email:      normEmail(shift.employee_email || (techRecord && techRecord.email)),
        customer_slug:   custSlug,
        customer_name:   customerName,
        scheduled_start: tsToMs(shift.start_time),
        scheduled_end:   tsToMs(shift.end_time),
        sync_date:       shift.sync_date || "",
        session:         session,
        started:         started,
        finished:        finished,
        dcr:             dcr,
        match_path:      matched.match_path,
        email_status:    emailStatus || (dcr ? "(not run)" : ""),
        email_error:     emailError,
        issue_tier:      issueTier,
        has_problem:     hasProblem,
        issue_docs:      issueDocs,
        status:          status,
        status_reason:   statusReason
      };
    });

    // Aggregate per-tech.
    const byTechKey = Object.create(null);
    rows.forEach(function (r) {
      const k = r.tech_slug || r.tech_email || r.tech_display;
      if (!byTechKey[k]) {
        byTechKey[k] = {
          tech_slug:     r.tech_slug,
          tech_display:  r.tech_display,
          tech_email:    r.tech_email,
          rows:          [],
          counts: { scheduled: 0, started: 0, finished: 0, dcrs: 0, issues: 0,
                    emails_sent: 0, emails_failed: 0 }
        };
      }
      const bucket = byTechKey[k];
      bucket.rows.push(r);
      bucket.counts.scheduled++;
      if (r.started)  bucket.counts.started++;
      if (r.finished) bucket.counts.finished++;
      if (r.dcr)      bucket.counts.dcrs++;
      if (r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem) bucket.counts.issues++;
      if (r.email_status === "sent")   bucket.counts.emails_sent++;
      if (r.email_status === "failed") bucket.counts.emails_failed++;
    });
    const byTech = Object.keys(byTechKey).map(function (k) { return byTechKey[k]; });
    byTech.sort(function (a, b) {
      return String(a.tech_display || "").localeCompare(String(b.tech_display || ""));
    });

    // Unmatched DCRs (in window but didn't match any shift).
    const unmatchedDcrs = ctx.dcrs.filter(function (d) {
      return !matchedDcrIds[d.submission_id];
    });

    // Unmatched shifts (no DCR found).
    const unmatchedShifts = rows.filter(function (r) { return !r.dcr; });

    // Top-line counts.
    const summary = {
      window_start_date: ctx.selected,
      window_end_date:   nextDay(ctx.selected),
      scheduled:         rows.length,
      started:           rows.filter(function (r) { return r.started;  }).length,
      finished:          rows.filter(function (r) { return r.finished; }).length,
      dcrs_submitted:    ctx.dcrs.length,
      dcrs_missing:      unmatchedShifts.length,
      issues:            rows.filter(function (r) {
                           return r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem;
                         }).length,
      emails_sent:       rows.filter(function (r) { return r.email_status === "sent";   }).length,
      emails_failed:     rows.filter(function (r) { return r.email_status === "failed"; }).length
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

  function renderYesterdaySummary(report) {
    const el = document.getElementById("yesterday-summary");
    if (!el) return;
    const s = report.summary;
    el.innerHTML =
      '<div class="ydw-stat"><span class="ydw-stat-label">Scheduled shifts</span><strong>'  + s.scheduled       + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Started</span><strong>'           + s.started         + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Finished</span><strong>'          + s.finished        + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">DCRs submitted</span><strong>'    + s.dcrs_submitted  + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-warn"><span class="ydw-stat-label">DCRs missing</span><strong>' + s.dcrs_missing + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Issues</span><strong>'            + s.issues          + '</strong></div>' +
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
      const techHeader =
        '<header class="ydw-tech-head">' +
          '<strong class="ydw-tech-name">' + escapeHtml(bucket.tech_display || "(unknown)") + '</strong> ' +
          '<span class="ydw-tech-meta">' +
            escapeHtml(bucket.tech_slug || "") +
            (bucket.tech_email ? " · " + escapeHtml(bucket.tech_email) : "") +
          '</span>' +
          '<span class="ydw-tech-counts">' +
            c.scheduled + ' assigned · ' + c.started + ' started · ' + c.finished + ' finished · ' +
            c.dcrs + ' DCR' + (c.dcrs === 1 ? '' : 's') +
            (c.issues > 0 ? ' · <span class="ydw-tag warn">' + c.issues + ' issue' + (c.issues === 1 ? '' : 's') + '</span>' : '') +
            (c.emails_failed > 0 ? ' · <span class="ydw-tag fail">' + c.emails_failed + ' email failed</span>' : '') +
          '</span>' +
        '</header>';
      const rows = bucket.rows.map(function (r) { return renderYesterdayRow(r, debug); }).join("");
      return '<article class="ydw-tech">' + techHeader + '<ul class="ydw-row-list">' + rows + '</ul></article>';
    }).join("");
  }

  function renderYesterdayRow(r, debug) {
    const timeText = formatTimeRangePT(r.scheduled_start, r.scheduled_end) || "(no scheduled time)";
    const statusBadge = '<span class="ydw-status ydw-' + r.status + '">' + r.status + '</span>';
    const startedChip  = r.started  ? '<span class="ydw-chip">Started</span>'  : '';
    const finishedChip = r.finished ? '<span class="ydw-chip">Finished</span>' : '';
    const dcrChip = r.dcr
      ? '<span class="ydw-chip pass">DCR</span>'
      : '<span class="ydw-chip fail">No DCR</span>';
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
          'shift_id=' + escapeHtml(r.shift_id) +
          (r.dcr ? ' · dcr=' + escapeHtml(r.dcr.submission_id) : '') +
          (r.match_path ? ' · matched_by=' + escapeHtml(r.match_path) : '') +
          (r.dcr && r.dcr.zapier && r.dcr.zapier.status
            ? ' · zapier=' + escapeHtml(String(r.dcr.zapier.status)) + ' (legacy)'
            : '') +
        '</div>'
      : '';
    return '<li class="ydw-row ydw-row-' + r.status + '">' +
             '<div class="ydw-row-head">' +
               statusBadge +
               '<strong class="ydw-row-customer">' + escapeHtml(r.customer_name) + '</strong>' +
               '<span class="ydw-row-time">' + escapeHtml(timeText) + '</span>' +
             '</div>' +
             '<div class="ydw-row-chips">' +
               startedChip + finishedChip + dcrChip + issueChip + emailChip + viewCount +
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
                   ' · ' + escapeHtml(formatTimeRangePT(r.scheduled_start, r.scheduled_end) || r.sync_date) +
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
      // Defer the scroll-into-view a beat so the Recent DCRs panel has
      // a chance to render if it hadn't been opened yet.
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
