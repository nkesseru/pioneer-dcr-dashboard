/* Pioneer DCR Hub — Admin Payroll tab (Phase 28C: Summary + Verification Layer).
 *
 * Read-only summary surface over the existing approval workflow.
 * No writes. No new collections. No rule changes.
 *
 * Reads:
 *   • pioneer_service_sessions  — sessions in the selected period
 *   • sick_leave_ledger         — used entries in the selected period
 *   • cleaning_techs (via deps.getTechs()) — display names
 *   • payroll_exports           — placeholder text only in 28C
 *
 * Provides:
 *   • Period picker (last 6 semi-monthly periods + Custom range up to 31 days)
 *   • Verification Layer banner: PAYROLL READY (green) · BLOCKED (amber) ·
 *     NO APPROVED SESSIONS (grey)
 *   • Per-employee summary table with totals row (decimal hours)
 *   • "Open in Labor" deep-link buttons for each blocker line
 *   • Recent exports placeholder (Phase 28D content lands here)
 *   • Export button (disabled, "Coming in Phase 28D")
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * Exports window.__pioneerAdmin.tabs.payroll = { init, refresh }.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-payroll.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  // currentPeriod shape: { period_id, label, start_date, end_date, is_custom }
  let currentPeriod  = null;
  let periodOptions  = [];
  let sessions       = [];
  let sickEntries    = [];
  let techsByEmail   = {};
  let techsByUid     = {};
  let loaded         = false;
  let loading        = false;
  // Phase 28D — Recent Exports state. Loaded alongside sessions/sick.
  let recentExports  = [];      // last 10 docs, sorted by generated_at desc

  const PAYROLL_BUILD_TAG = "Payroll v28D-export";

  /* ---------- date + period helpers ---------- */

  function addDaysPT(yyyymmdd, days) {
    const parts = String(yyyymmdd || "").split("-");
    if (parts.length !== 3) return yyyymmdd;
    const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const sa = Date.parse(a + "T00:00:00Z");
    const sb = Date.parse(b + "T00:00:00Z");
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return NaN;
    return Math.round((sb - sa) / 86400000);
  }
  function lastDayOfMonth(yyyy, mm /* 1-12 */) {
    return new Date(yyyy, mm, 0).getDate();
  }
  function fmtMonthDay(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
  function fmtFullDate(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }

  // Semi-monthly periods (Phase 1a):
  //   Period A = 1–15 of month
  //   Period B = 16–EOM of month
  function getSemiMonthlyPeriodForDate(yyyymmdd) {
    const parts = String(yyyymmdd || "").split("-").map(Number);
    const y = parts[0], m = parts[1], d = parts[2];
    const mm = String(m).padStart(2, "0");
    let start, end, suffix;
    if (d <= 15) {
      start = y + "-" + mm + "-01";
      end   = y + "-" + mm + "-15";
      suffix = "A";
    } else {
      const eod = lastDayOfMonth(y, m);
      start = y + "-" + mm + "-16";
      end   = y + "-" + mm + "-" + String(eod).padStart(2, "0");
      suffix = "B";
    }
    return {
      period_id:  y + "-" + mm + "-" + suffix,
      label:      fmtMonthDay(start) + " – " + fmtMonthDay(end) + ", " + y,
      start_date: start,
      end_date:   end,
      is_custom:  false
    };
  }
  function getPriorPeriod(period) {
    // For Period B → prior is Period A of the same month.
    // For Period A → prior is Period B of the previous month.
    const startParts = period.start_date.split("-").map(Number);
    if (period.period_id.endsWith("-B")) {
      const y = startParts[0], m = startParts[1];
      return getSemiMonthlyPeriodForDate(y + "-" + String(m).padStart(2, "0") + "-01");
    }
    let prevY = startParts[0], prevM = startParts[1] - 1;
    if (prevM === 0) { prevY -= 1; prevM = 12; }
    const prevMm = String(prevM).padStart(2, "0");
    const eod = lastDayOfMonth(prevY, prevM);
    return getSemiMonthlyPeriodForDate(prevY + "-" + prevMm + "-" + String(eod).padStart(2, "0"));
  }
  function buildPeriodOptions() {
    const today = pacificDateString(new Date());
    let current = getSemiMonthlyPeriodForDate(today);
    const out = [current];
    for (let i = 0; i < 5; i++) {
      current = getPriorPeriod(current);
      out.push(current);
    }
    return out;
  }
  function validateCustomRange(start, end) {
    if (!start || !end) return "Pick both start and end dates.";
    if (start > end) return "End date is before start date.";
    const span = daysBetween(start, end);
    if (!Number.isFinite(span)) return "Invalid date.";
    if (span + 1 > 31) return "Range too wide — max 31 days.";
    return null;
  }
  // Phase 28D — overlap check for Recent Exports prioritization.
  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (!aStart || !aEnd || !bStart || !bEnd) return false;
    return !(aEnd < bStart || aStart > bEnd);
  }

  function ensurePeriodInitialized() {
    if (currentPeriod) return;
    const today = pacificDateString(new Date());
    currentPeriod = getSemiMonthlyPeriodForDate(today);
    periodOptions = buildPeriodOptions();
  }

  /* ---------- session + sick helpers (mirror Labor tab semantics) ---------- */

  function needsReviewFlag(s) { return s && s.needs_review === true; }
  function adminRemovedFlag(s) { return s && s.admin_removed === true; }
  function isActiveSession(s) { return s && (s.status === "active" || s.status === "paused"); }
  function dcrPendingFlag(s) {
    if (!s) return false;
    if (s.status === "dcr_pending") return true;
    if (s.status !== "completed") return false;
    const submitted = (s.dcr_status === "submitted") || !!s.dcr_id;
    return !submitted;
  }
  function missingClockoutFlag(s) {
    return s && s.status === "completed" && !s.clock_out_at;
  }
  function payrollState(s) { return (s && s.payroll_state) || "pending_review"; }
  function isApproved(s) {
    const ps = payrollState(s);
    return ps === "approved_for_payroll" || ps === "exported";
  }
  function isExported(s) { return payrollState(s) === "exported"; }
  function overBudgetFlag(s) {
    if (!s) return false;
    const budget = (typeof s.budget_minutes === "number") ? s.budget_minutes : null;
    if (budget == null || budget <= 0) return false;
    if (typeof s.work_minutes !== "number") return false;
    return s.work_minutes > budget + 15;
  }
  function offsiteFlag(s) {
    return s && (s.clock_in_geo_status === "offsite" || s.clock_out_geo_status === "offsite");
  }
  function forceClosedFlag(s) {
    return s && s.force_closed_by_admin === true;
  }

  function fmtHours(minutes) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "0.00";
    return (minutes / 60).toFixed(2);
  }

  /* ---------- tech maps ---------- */

  function hydrateTechMaps() {
    techsByEmail = {};
    techsByUid   = {};
    let list = [];
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      if (deps && typeof deps.getTechs === "function") list = deps.getTechs() || [];
    } catch (_e) { list = []; }
    list.forEach(function (t) {
      if (!t) return;
      if (t.email) techsByEmail[String(t.email).toLowerCase()] = t;
      if (t.uid)   techsByUid[t.uid] = t;
    });
  }
  function techName(email, uid) {
    const key = email ? String(email).toLowerCase() : "";
    const t = (key && techsByEmail[key]) || (uid && techsByUid[uid]);
    if (t) return t.display_name || t.first_name || t.email || email || uid || "Tech";
    return email || uid || "Tech";
  }

  /* ---------- loaders ---------- */

  function setState(state, message) {
    const loadingEl = $("payroll-loading");
    const errorEl   = $("payroll-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && message) errorEl.textContent = message;
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      hydrateTechMaps();
      ensurePeriodInitialized();
      const db = firebase.firestore();

      // Parallel reads. Sessions by service_date range; sick by
      // effective_date range (single-field range, no composite needed).
      // Sick entries are filtered to entry_type === "used" client-side
      // to avoid forcing a new composite index for the pilot scale.
      const [sessSnap, sickSnap, exportSnap] = await Promise.all([
        db.collection("pioneer_service_sessions")
          .where("service_date", ">=", currentPeriod.start_date)
          .where("service_date", "<=", currentPeriod.end_date)
          .get(),
        db.collection("sick_leave_ledger")
          .where("effective_date", ">=", currentPeriod.start_date)
          .where("effective_date", "<=", currentPeriod.end_date)
          .get(),
        // Phase 28D — Recent exports. Single-field orderBy keeps this
        // index-free. Show 10 most recent overall; client-side filter
        // surfaces the ones overlapping the current period first.
        db.collection("payroll_exports")
          .orderBy("generated_at", "desc")
          .limit(10)
          .get()
          .catch(function () { return null; })   // soft-fail if collection doesn't exist yet
      ]);

      sessions = sessSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      sickEntries = sickSnap.docs
        .map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (e) { return e.entry_type === "used"; });

      // Phase 28D — recent exports list. Sort with current-period
      // overlap first, then by generated_at desc.
      recentExports = exportSnap
        ? exportSnap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        : [];
      recentExports.sort(function (a, b) {
        const aOverlap = rangesOverlap(a.range_start, a.range_end, currentPeriod.start_date, currentPeriod.end_date) ? 1 : 0;
        const bOverlap = rangesOverlap(b.range_start, b.range_end, currentPeriod.start_date, currentPeriod.end_date) ? 1 : 0;
        if (aOverlap !== bOverlap) return bOverlap - aOverlap;
        const aMs = (a.generated_at && a.generated_at.toMillis) ? a.generated_at.toMillis() : 0;
        const bMs = (b.generated_at && b.generated_at.toMillis) ? b.generated_at.toMillis() : 0;
        return bMs - aMs;
      });

      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[payroll] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read on pioneer_service_sessions + sick_leave_ledger."
        : "Couldn't load payroll data: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- aggregations ---------- */

  function computeBlockers(arr) {
    const out = { needs_review: 0, active: 0, dcr_pending: 0, missing_clockout: 0 };
    (arr || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      if (needsReviewFlag(s))    out.needs_review     += 1;
      if (isActiveSession(s))    out.active           += 1;
      if (dcrPendingFlag(s))     out.dcr_pending      += 1;
      if (missingClockoutFlag(s))out.missing_clockout += 1;
    });
    return out;
  }

  function aggregateByEmployee(sessions, sickEntries) {
    const map = new Map();
    function getOrCreate(uid, email) {
      const key = uid || ("email:" + String(email || "").toLowerCase()) || "(unknown)";
      if (!map.has(key)) {
        map.set(key, {
          staff_uid:          uid || "",
          staff_email:        String(email || "").toLowerCase(),
          name:               techName(email, uid),
          worked_min:         0,
          overtime_min:       0,
          drive_min:          0,    // Phase 28C: always 0 (drive ships later)
          sick_min:           0,
          excpt_count:        0,
          dcr_pending:        0,
          needs_review:       0,
          total_sessions:     0,
          approved_sessions:  0,
          exported_sessions:  0
        });
      }
      return map.get(key);
    }
    (sessions || []).forEach(function (s) {
      if (adminRemovedFlag(s)) return;
      const row = getOrCreate(s.staff_uid, s.staff_email);
      if (typeof s.work_minutes === "number" && s.work_minutes > 0) {
        row.worked_min += s.work_minutes;
      }
      if (typeof s.overtime_minutes === "number" && s.overtime_minutes > 0) {
        row.overtime_min += s.overtime_minutes;
      }
      row.total_sessions += 1;
      if (isApproved(s)) row.approved_sessions += 1;
      if (isExported(s)) row.exported_sessions += 1;
      if (overBudgetFlag(s))    row.excpt_count   += 1;
      if (offsiteFlag(s))       row.excpt_count   += 1;
      if (forceClosedFlag(s))   row.excpt_count   += 1;
      if (dcrPendingFlag(s))    row.dcr_pending   += 1;
      if (needsReviewFlag(s))   row.needs_review  += 1;
    });
    // Sick — include techs with sick leave even if they have 0 sessions
    // this period. Sum of |minutes_delta| from "used" entries.
    (sickEntries || []).forEach(function (e) {
      const row = getOrCreate(e.staff_uid, e.staff_email);
      const m = Math.abs(Number(e.minutes_delta) || 0);
      if (m > 0) row.sick_min += m;
    });
    return Array.from(map.values()).sort(function (a, b) {
      const ta = a.worked_min + a.sick_min;
      const tb = b.worked_min + b.sick_min;
      if (tb !== ta) return tb - ta;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function computeGrandTotals(rows) {
    return (rows || []).reduce(function (acc, r) {
      acc.worked_min        += r.worked_min;
      acc.overtime_min      += r.overtime_min;
      acc.drive_min         += r.drive_min;
      acc.sick_min          += r.sick_min;
      acc.excpt_count       += r.excpt_count;
      acc.dcr_pending       += r.dcr_pending;
      acc.needs_review      += r.needs_review;
      acc.total_sessions    += r.total_sessions;
      acc.approved_sessions += r.approved_sessions;
      acc.exported_sessions += r.exported_sessions;
      return acc;
    }, {
      worked_min: 0, overtime_min: 0, drive_min: 0, sick_min: 0,
      excpt_count: 0, dcr_pending: 0, needs_review: 0,
      total_sessions: 0, approved_sessions: 0, exported_sessions: 0
    });
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderPeriodPicker();
    renderBanner();
    renderEmployeeTable();
    renderRecentExports();
  }

  function renderHeader() {
    const sub = $("payroll-sub");
    if (!sub) return;
    sub.textContent = currentPeriod.label + " · " + PAYROLL_BUILD_TAG;
  }

  function renderPeriodPicker() {
    const select = $("payroll-period-select");
    if (!select) return;
    const opts = periodOptions.map(function (p) {
      const sel = (!currentPeriod.is_custom && p.period_id === currentPeriod.period_id) ? " selected" : "";
      return '<option value="' + escapeHtml(p.period_id) + '"' + sel + '>' +
             escapeHtml(p.label) + '</option>';
    }).join("");
    select.innerHTML = opts + '<option value="__custom__"' +
      (currentPeriod.is_custom ? " selected" : "") + '>Custom range…</option>';

    const customRow = $("payroll-custom-row");
    if (customRow) customRow.hidden = !currentPeriod.is_custom;
    if (currentPeriod.is_custom) {
      const startEl = $("payroll-custom-start"); if (startEl) startEl.value = currentPeriod.start_date;
      const endEl   = $("payroll-custom-end");   if (endEl)   endEl.value   = currentPeriod.end_date;
    }
    const errEl = $("payroll-custom-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
  }

  function renderBanner() {
    const wrap = $("payroll-banner");
    if (!wrap) return;
    const blockers = computeBlockers(sessions);
    const totalBlockers = blockers.needs_review + blockers.active +
                          blockers.dcr_pending + blockers.missing_clockout;
    const nonArchived = sessions.filter(function (s) { return !adminRemovedFlag(s); });
    const approvedCount = nonArchived.filter(isApproved).length;

    if (totalBlockers === 0 && approvedCount > 0) {
      wrap.innerHTML =
        '<div class="payroll-banner is-ready">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">🟢</span>' +
            '<strong>PAYROLL READY</strong>' +
          '</div>' +
          '<p class="payroll-banner-msg"><strong>' + approvedCount +
            '</strong> of <strong>' + nonArchived.length +
            '</strong> session' + (nonArchived.length === 1 ? '' : 's') +
            ' approved · no blockers in this period.</p>' +
          '<div class="payroll-banner-actions">' +
            '<button type="button" class="payroll-export-btn is-ready" id="payroll-export-now" ' +
              'title="Generate CSV and lock these sessions as exported">' +
              'Export approved sessions →' +
            '</button>' +
            '<span class="payroll-export-note">7-day signed URL · audit trail in payroll_exports.</span>' +
          '</div>' +
        '</div>';
    } else if (totalBlockers > 0) {
      const lines = [];
      if (blockers.needs_review > 0) {
        lines.push({ key: "needs_review",
          text: blockers.needs_review + ' session' + (blockers.needs_review === 1 ? '' : 's') + ' need review' });
      }
      if (blockers.active > 0) {
        lines.push({ key: "active",
          text: blockers.active + ' active session' + (blockers.active === 1 ? '' : 's') });
      }
      if (blockers.dcr_pending > 0) {
        lines.push({ key: "dcr_pending",
          text: blockers.dcr_pending + ' session' + (blockers.dcr_pending === 1 ? '' : 's') + ' DCR pending' });
      }
      if (blockers.missing_clockout > 0) {
        lines.push({ key: "missing_clockout",
          text: blockers.missing_clockout + ' session' + (blockers.missing_clockout === 1 ? '' : 's') + ' missing clock-out' });
      }
      wrap.innerHTML =
        '<div class="payroll-banner is-blocked">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">🟡</span>' +
            '<strong>BLOCKED</strong>' +
          '</div>' +
          '<ul class="payroll-banner-list">' +
            lines.map(function (l) {
              return '<li><span class="payroll-banner-bullet">•</span> ' +
                escapeHtml(l.text) +
                ' <button type="button" class="payroll-link-btn" data-payroll-link="' +
                escapeHtml(l.key) + '">Open in Labor →</button></li>';
            }).join("") +
          '</ul>' +
          '<p class="payroll-banner-msg">Export disabled until resolved.</p>' +
        '</div>';
    } else {
      wrap.innerHTML =
        '<div class="payroll-banner is-empty">' +
          '<div class="payroll-banner-head">' +
            '<span class="payroll-banner-dot" aria-hidden="true">⚪</span>' +
            '<strong>NO APPROVED SESSIONS</strong>' +
          '</div>' +
          '<p class="payroll-banner-msg">' +
            'No sessions have been approved for payroll in this period yet. Open the Labor tab to review and approve.' +
          '</p>' +
        '</div>';
    }
  }

  function approvalChip(r) {
    if (r.total_sessions === 0) return '<span class="pr-apv pr-apv-zero">0/0</span>';
    if (r.exported_sessions === r.total_sessions) {
      return '<span class="pr-apv pr-apv-exported">🔒 ' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    if (r.approved_sessions === r.total_sessions) {
      return '<span class="pr-apv pr-apv-all">✓ ' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    if (r.approved_sessions > 0) {
      return '<span class="pr-apv pr-apv-partial">' +
             r.approved_sessions + '/' + r.total_sessions + '</span>';
    }
    return '<span class="pr-apv pr-apv-none">0/' + r.total_sessions + '</span>';
  }

  function renderEmployeeTable() {
    const wrap  = $("payroll-employee-table");
    const empty = $("payroll-employee-empty");
    if (!wrap || !empty) return;

    const rows = aggregateByEmployee(sessions, sickEntries);
    if (!rows.length) {
      wrap.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const totals = computeGrandTotals(rows);

    const headerHtml =
      '<div class="payroll-row payroll-row-head">' +
        '<div class="pr-col-emp">Employee</div>' +
        '<div class="pr-col-num">Worked</div>' +
        '<div class="pr-col-num">OT</div>' +
        '<div class="pr-col-num" title="Drive time integration ships after Phase 28D.">Drive</div>' +
        '<div class="pr-col-num">Sick</div>' +
        '<div class="pr-col-num pr-col-total">Total</div>' +
        '<div class="pr-col-num">Excpt</div>' +
        '<div class="pr-col-num">DCR</div>' +
        '<div class="pr-col-num">NR</div>' +
        '<div class="pr-col-apv">Approval</div>' +
      '</div>';

    const rowsHtml = rows.map(function (r) {
      // Total = work + drive + sick (OT already included in worked).
      const totalMin = r.worked_min + r.drive_min + r.sick_min;
      return (
        '<div class="payroll-row">' +
          '<div class="pr-col-emp">' + escapeHtml(r.name) + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.worked_min)   + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.overtime_min) + '</div>' +
          '<div class="pr-col-num pr-col-drive">' + fmtHours(r.drive_min) + '</div>' +
          '<div class="pr-col-num">' + fmtHours(r.sick_min) + '</div>' +
          '<div class="pr-col-num pr-col-total">' + fmtHours(totalMin) + '</div>' +
          '<div class="pr-col-num">' + r.excpt_count   + '</div>' +
          '<div class="pr-col-num">' + r.dcr_pending   + '</div>' +
          '<div class="pr-col-num">' + r.needs_review  + '</div>' +
          '<div class="pr-col-apv">' + approvalChip(r) + '</div>' +
        '</div>'
      );
    }).join("");

    const totalRowHtml =
      '<div class="payroll-row payroll-row-total">' +
        '<div class="pr-col-emp">TOTAL · ' + rows.length + ' employee' + (rows.length === 1 ? '' : 's') + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.worked_min)   + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.overtime_min) + '</div>' +
        '<div class="pr-col-num pr-col-drive">' + fmtHours(totals.drive_min) + '</div>' +
        '<div class="pr-col-num">' + fmtHours(totals.sick_min) + '</div>' +
        '<div class="pr-col-num pr-col-total">' +
          fmtHours(totals.worked_min + totals.drive_min + totals.sick_min) + '</div>' +
        '<div class="pr-col-num">' + totals.excpt_count  + '</div>' +
        '<div class="pr-col-num">' + totals.dcr_pending  + '</div>' +
        '<div class="pr-col-num">' + totals.needs_review + '</div>' +
        '<div class="pr-col-apv">' +
          totals.approved_sessions + '/' + totals.total_sessions +
          (totals.exported_sessions > 0 ? ' (🔒 ' + totals.exported_sessions + ')' : '') +
        '</div>' +
      '</div>';

    wrap.innerHTML = headerHtml + rowsHtml + totalRowHtml;
  }

  function renderRecentExports() {
    const wrap = $("payroll-recent-exports");
    if (!wrap) return;
    if (!recentExports.length) {
      wrap.innerHTML =
        '<div class="payroll-exports-placeholder">' +
          '<p><strong>No exports yet.</strong> Click <em>Export approved sessions</em> in the green banner above to generate the first CSV.</p>' +
        '</div>';
      return;
    }
    wrap.innerHTML = recentExports.map(function (e) {
      const overlap = rangesOverlap(e.range_start, e.range_end, currentPeriod.start_date, currentPeriod.end_date);
      const isVoided = (e.status === "voided");
      const genMs = (e.generated_at && e.generated_at.toMillis) ? e.generated_at.toMillis() : 0;
      const genStr = genMs ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(genMs)) : "—";
      const totalHours = (typeof e.total_paid_hours === "number") ? e.total_paid_hours.toFixed(2) : "—";
      const voidedLine = isVoided && e.voided_at
        ? '<p class="payroll-export-voided-line">Voided ' +
            escapeHtml(genStrFromTs(e.voided_at)) +
            ' by ' + escapeHtml((e.voided_by_email || (e.voided_by && e.voided_by.displayName)) || "admin") +
            (e.void_reason ? ' — ' + escapeHtml(e.void_reason) : '') +
          '</p>'
        : '';
      const downloadBtn = e.signed_url
        ? '<a class="payroll-export-download" href="' + escapeHtml(e.signed_url) +
          '" target="_blank" rel="noopener noreferrer">Download CSV ↗</a>'
        : '<span class="payroll-export-no-url">No download URL</span>';
      const voidBtn = !isVoided
        ? '<button type="button" class="payroll-export-void-btn" ' +
          'data-payroll-void-id="' + escapeHtml(e._id) +
          '" data-payroll-void-label="' + escapeHtml(e.period_label || (e.range_start + " → " + e.range_end)) + '">' +
          'Void this export…</button>'
        : '';
      const statusBadge = isVoided
        ? '<span class="payroll-export-badge is-voided">🚫 VOIDED</span>'
        : '<span class="payroll-export-badge is-active">✓ ACTIVE</span>';
      const overlapMark = overlap ? '<span class="payroll-export-overlap">in current period</span>' : '';
      return (
        '<div class="payroll-export-row' + (isVoided ? ' is-voided' : '') + '">' +
          '<div class="payroll-export-row-head">' +
            '<span class="payroll-export-date">' + escapeHtml(genStr) + '</span>' +
            '<span class="payroll-export-period">' + escapeHtml(e.period_label || (e.range_start + " → " + e.range_end)) + '</span>' +
            statusBadge + overlapMark +
          '</div>' +
          '<div class="payroll-export-row-meta">' +
            'Generated by ' + escapeHtml(e.generated_by_email || "admin") +
            ' · ' + totalHours + ' total paid hours' +
            ' · ' + (e.session_count || 0) + ' session' + ((e.session_count === 1) ? '' : 's') +
            ' · ' + (e.employee_count || 0) + ' employee' + ((e.employee_count === 1) ? '' : 's') +
          '</div>' +
          voidedLine +
          '<div class="payroll-export-row-actions">' +
            downloadBtn + voidBtn +
          '</div>' +
        '</div>'
      );
    }).join("");
  }
  function genStrFromTs(ts) {
    const ms = (ts && ts.toMillis) ? ts.toMillis() : 0;
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }

  /* ---------- Phase 28D — export + void writers ---------- */

  async function exportPayrollCsv() {
    const url = (window.EXPORT_PAYROLL_CSV_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("EXPORT_PAYROLL_CSV_URL is not configured in firebase-config.js.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        range_start:  currentPeriod.start_date,
        range_end:    currentPeriod.end_date,
        period_label: currentPeriod.label
      })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body;
      throw err;
    }
    return body;
  }
  async function voidPayrollExport(exportId, reason) {
    const url = (window.VOID_PAYROLL_EXPORT_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("VOID_PAYROLL_EXPORT_URL is not configured in firebase-config.js.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify({ export_id: exportId, void_reason: reason })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.body = body;
      throw err;
    }
    return body;
  }

  /* ---------- Phase 28D — modals ---------- */

  function openExportConfirmModal() {
    const modal = $("payroll-export-confirm-modal");
    if (!modal) return;
    const approvedCount = sessions.filter(function (s) {
      return !adminRemovedFlag(s) && isApproved(s);
    }).length;
    const sickCount = sickEntries.length;
    const sum = $("payroll-export-summary");
    if (sum) {
      sum.innerHTML =
        '<strong>' + currentPeriod.label + '</strong><br>' +
        approvedCount + ' approved session' + (approvedCount === 1 ? '' : 's') +
        ' · ' + sickCount + ' sick entr' + (sickCount === 1 ? 'y' : 'ies');
    }
    const err = $("payroll-export-err");
    if (err) { err.textContent = ""; err.hidden = true; }
    const dl = $("payroll-export-success-dl");
    if (dl) { dl.hidden = true; dl.removeAttribute("href"); }
    const successBlock = $("payroll-export-success");
    if (successBlock) successBlock.hidden = true;
    const confirmRow = $("payroll-export-confirm-row");
    if (confirmRow) confirmRow.hidden = false;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeExportConfirmModal() {
    const modal = $("payroll-export-confirm-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeExportConfirmModal; // closed by [data-modal-close]

  async function submitExportConfirm() {
    const err     = $("payroll-export-err");
    const saveBtn = $("payroll-export-save");
    function showErr(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Exporting…"; }
    try {
      const result = await exportPayrollCsv();
      // Flip modal into success state.
      const confirmRow = $("payroll-export-confirm-row");
      if (confirmRow) confirmRow.hidden = true;
      const successBlock = $("payroll-export-success");
      if (successBlock) successBlock.hidden = false;
      const dl = $("payroll-export-success-dl");
      if (dl) { dl.href = result.signed_url; dl.hidden = false; }
      const sumLine = $("payroll-export-success-summary");
      if (sumLine && result.summary) {
        sumLine.textContent =
          result.summary.session_count + " session(s) · " +
          result.summary.employee_count + " employee(s) · " +
          (result.summary.total_paid_hours || 0).toFixed(2) + " total paid hours";
      }
      // Refresh the Payroll tab in the background so banner + table + recent-exports update.
      refresh();
    } catch (e) {
      console.error("[payroll] export failed", e);
      let msg = (e && e.message) || "Export failed.";
      if (e && e.body && e.body.blockers) {
        const b = e.body.blockers;
        msg += " · Server saw: " + b.needs_review_count + " needs review, " +
               b.active_count + " active, " + b.dcr_pending_count + " DCR pending, " +
               b.missing_clockout_count + " missing clock-out.";
      }
      showErr(msg);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Confirm export"; }
    }
  }

  function openVoidModal(exportId, exportLabel) {
    const modal = $("payroll-void-modal");
    if (!modal) return;
    const idEl = $("payroll-void-id");        if (idEl) idEl.value = exportId || "";
    const sumEl = $("payroll-void-summary");  if (sumEl) sumEl.textContent = exportLabel || exportId || "—";
    const rEl = $("payroll-void-reason");     if (rEl) rEl.value = "";
    const eEl = $("payroll-void-err");        if (eEl) { eEl.textContent = ""; eEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }
  function closeVoidModal() {
    const modal = $("payroll-void-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }
  void closeVoidModal;

  async function submitVoid() {
    const idEl = $("payroll-void-id");
    const rEl  = $("payroll-void-reason");
    const err  = $("payroll-void-err");
    const saveBtn = $("payroll-void-save");
    function showErr(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
    const exportId = (idEl && idEl.value) || "";
    const reason = ((rEl && rEl.value) || "").trim();
    if (!exportId) { showErr("Missing export id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }
    if (saveBtn) saveBtn.disabled = true;
    try {
      await voidPayrollExport(exportId, reason);
      closeVoidModal();
      refresh();
    } catch (e) {
      console.error("[payroll] void failed", e);
      showErr((e && e.message) || "Void failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- deep-link "Open in Labor" ---------- */

  function openInLabor(blockerKey) {
    const labor = window.__pioneerAdmin && window.__pioneerAdmin.tabs && window.__pioneerAdmin.tabs.laborReview;
    // Map blocker key → Labor status filter. "active" and
    // "missing_clockout" don't have dedicated filters; fall back to
    // "all" (admin can scan the open-active block + the table).
    let statusFilter = "all";
    if (blockerKey === "needs_review") statusFilter = "needs_review";
    else if (blockerKey === "dcr_pending") statusFilter = "dcr_pending";
    if (labor && typeof labor.applyExternalFilter === "function") {
      labor.applyExternalFilter({
        rangeStart:   currentPeriod.start_date,
        rangeEnd:     currentPeriod.end_date,
        statusFilter: statusFilter
      });
    } else {
      try { console.warn("[payroll] laborReview.applyExternalFilter not available — Labor tab may be old"); } catch (_e) {}
    }
    const laborBtn = document.querySelector('.admin-tab[data-tab="labor-review"]');
    if (laborBtn) laborBtn.click();
  }

  /* ---------- wire-up ---------- */

  function wire() {
    const refreshBtn = $("payroll-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    const select = $("payroll-period-select");
    if (select) select.addEventListener("change", function () {
      const val = select.value;
      if (val === "__custom__") {
        // Switch to custom-range mode using current period's dates as
        // the starting point. Don't fetch yet — admin must click Apply.
        currentPeriod = Object.assign({}, currentPeriod, {
          is_custom: true, period_id: "custom",
          label: fmtFullDate(currentPeriod.start_date) + " – " + fmtFullDate(currentPeriod.end_date)
        });
        renderPeriodPicker();
        return;
      }
      const found = periodOptions.find(function (p) { return p.period_id === val; });
      if (found) {
        currentPeriod = found;
        refresh();
      }
    });

    const applyBtn = $("payroll-custom-apply");
    if (applyBtn) applyBtn.addEventListener("click", function () {
      const startEl = $("payroll-custom-start");
      const endEl   = $("payroll-custom-end");
      const start = (startEl && startEl.value) || "";
      const end   = (endEl && endEl.value) || "";
      const errMsg = validateCustomRange(start, end);
      const errEl = $("payroll-custom-err");
      if (errMsg) { if (errEl) { errEl.textContent = errMsg; errEl.hidden = false; } return; }
      if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
      currentPeriod = {
        period_id:  "custom",
        label:      fmtFullDate(start) + " – " + fmtFullDate(end),
        start_date: start,
        end_date:   end,
        is_custom:  true
      };
      refresh();
    });

    // Delegated click on the banner for "Open in Labor" deep-links.
    const banner = $("payroll-banner");
    if (banner) banner.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest("[data-payroll-link]");
      if (!btn) return;
      const key = btn.getAttribute("data-payroll-link");
      if (key) openInLabor(key);
    });

    // Phase 28D — Export button click (live) and Void button click
    // (delegated on Recent Exports rows).
    document.addEventListener("click", function (ev) {
      const exportBtn = ev.target.closest && ev.target.closest("#payroll-export-now");
      if (exportBtn) {
        ev.preventDefault();
        openExportConfirmModal();
        return;
      }
      const voidBtn = ev.target.closest && ev.target.closest("[data-payroll-void-id]");
      if (voidBtn) {
        ev.preventDefault();
        openVoidModal(voidBtn.getAttribute("data-payroll-void-id"),
                      voidBtn.getAttribute("data-payroll-void-label"));
        return;
      }
    });
    const exportSave = $("payroll-export-save");
    if (exportSave) exportSave.addEventListener("click", function () { submitExportConfirm(); });
    const voidSave = $("payroll-void-save");
    if (voidSave) voidSave.addEventListener("click", function () { submitVoid(); });
  }

  /* ---------- export surface ---------- */

  function init() { wire(); }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.payroll = {
    init:    init,
    refresh: refresh
  };
}());
