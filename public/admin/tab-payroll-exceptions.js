/* Pioneer DCR Hub — Admin Payroll Exceptions tab (Phase 29).
 *
 * Surface: review and act on employee-submitted time-adjustment requests
 * that replace the legacy Slack-based payroll correction loop. Three
 * status tabs (Pending / Approved / Denied). Pending rows expose
 * Approve and Deny buttons; both require explicit confirmation. The
 * underlying Cloud Functions enforce admin role, idempotency, and
 * locked-payroll-period safety — this tab is the user-facing routing
 * layer over them.
 *
 * Firestore I/O (admin-only — uses isPioneerAdmin() rule on
 * time_adjustment_requests):
 *   • time_adjustment_requests — single collection read; client-side
 *     splits into pending / approved / denied / canceled buckets.
 *
 * Cloud Function endpoints:
 *   • approveTimeAdjustmentRequestV1 — admin-only, batch updates the
 *     request doc AND the related pioneer_service_sessions doc with
 *     effective_clock_in/out/minutes + has_approved_time_adjustment +
 *     time_adjustment_request_id. Original clock data preserved.
 *   • denyTimeAdjustmentRequestV1 — admin-only, updates the request doc
 *     with status=denied + reviewer + denial_reason. Session untouched.
 *
 * Metrics:
 *   • 30-day request count per employee
 *   • 90-day request count per employee
 *   These are derived client-side from the loaded set so the surface
 *   stays read-light.
 *
 * Surface lives at window.__pioneerAdmin.tabs.payrollExceptions:
 *   { init, refresh }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-payroll-exceptions.js: utils + shell modules must load first");
  }
  const { escapeHtml, tsToMs } = window.__pioneerAdmin.utils;

  const REASON_LABELS = {
    forgot_clock_in:  "Forgot to clock in",
    forgot_clock_out: "Forgot to clock out",
    app_issue:        "App issue",
    phone_issue:      "Phone issue",
    no_internet:      "No internet",
    emergency:        "Emergency",
    other:            "Other"
  };

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let requests        = [];     // all time_adjustment_requests docs (latest 500 by created_at desc)
  let loaded          = false;
  let loading         = false;
  let activeSubTab    = "pending";

  /* ---------- helpers ---------- */

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

  function fmtPacificClock(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }

  function fmtShiftDate(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }

  function fmtDeltaMinutes(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : (n < 0 ? "−" : "");
    const abs  = Math.abs(n);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return sign + m + "m";
    if (m === 0) return sign + h + "h";
    return sign + h + "h " + m + "m";
  }

  function reasonLabel(key) {
    return REASON_LABELS[key] || key || "—";
  }

  // 30 / 90 day request counts for an employee, derived from the loaded
  // set. Counted by SUBMITTED time (covers pending + approved + denied
  // together — the office uses this as a pattern signal).
  function countRecent(empUid, days) {
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      if (r.employee_uid !== empUid) continue;
      const ms = tsToMs(r.submitted_at || r.created_at);
      if (ms && ms >= cutoff) n += 1;
    }
    return n;
  }

  /* ---------- loaders ---------- */

  function setState(state, message) {
    const loadingEl = $("payroll-exceptions-loading");
    const errorEl   = $("payroll-exceptions-error");
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
      const db = firebase.firestore();
      // Single collection read. orderBy created_at desc keeps the surface
      // index-free for V1; if the collection grows past ~1k rows we'd add
      // a status + submitted_at composite index and split queries.
      const snap = await db.collection("time_adjustment_requests")
        .orderBy("created_at", "desc")
        .limit(500)
        .get();
      requests = snap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[payroll-exceptions] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read on time_adjustment_requests."
        : "Couldn't load time adjustment requests: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- splitters ---------- */

  function bucketByStatus(arr) {
    const out = { pending: [], approved: [], denied: [], canceled: [] };
    arr.forEach(function (r) {
      const k = (r.status || "pending");
      if (out[k]) out[k].push(r);
    });
    return out;
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderSub();
    renderSubTabs();
    renderActiveList();
  }

  function renderSub() {
    const sub = $("payroll-exceptions-sub");
    if (!sub) return;
    const buckets = bucketByStatus(requests);
    sub.textContent =
      buckets.pending.length + " pending · " +
      buckets.approved.length + " approved · " +
      buckets.denied.length + " denied";
  }

  function renderSubTabs() {
    const buckets = bucketByStatus(requests);
    const counts = {
      pending:  buckets.pending.length,
      approved: buckets.approved.length,
      denied:   buckets.denied.length
    };
    ["pending", "approved", "denied"].forEach(function (k) {
      const btn = document.querySelector('[data-pe-subtab="' + k + '"]');
      if (!btn) return;
      btn.classList.toggle("is-active", k === activeSubTab);
      btn.setAttribute("aria-selected", k === activeSubTab ? "true" : "false");
      const cnt = btn.querySelector(".pe-subtab-count");
      if (cnt) cnt.textContent = counts[k] || 0;
    });
  }

  function renderActiveList() {
    const root = $("payroll-exceptions-list");
    if (!root) return;
    const buckets = bucketByStatus(requests);
    const list = buckets[activeSubTab] || [];
    if (!list.length) {
      root.innerHTML = '<p class="admin-status admin-empty">No ' +
        escapeHtml(activeSubTab) + ' time adjustment requests.</p>';
      return;
    }
    if (activeSubTab === "pending") {
      root.innerHTML = list.map(renderPendingCard).join("");
      return;
    }
    root.innerHTML = list.map(renderHistoryCard).join("");
  }

  function renderPendingCard(r) {
    const cnt30 = countRecent(r.employee_uid, 30);
    const cnt90 = countRecent(r.employee_uid, 90);
    const customer = r.customer_name
      ? (r.customer_name + (r.location_name ? " · " + r.location_name : ""))
      : (r.location_name || "—");
    return (
      '<article class="pe-card" data-pe-id="' + escapeHtml(r._id) + '">' +
        '<header class="pe-card-head">' +
          '<div>' +
            '<h3 class="pe-card-emp">' + escapeHtml(r.employee_name || r.employee_email || "Tech") + '</h3>' +
            '<p class="pe-card-sub">' + escapeHtml(customer) + ' · ' + escapeHtml(fmtShiftDate(r.shift_date)) + '</p>' +
          '</div>' +
          '<div class="pe-counts">' +
            '<span class="pe-count" title="Adjustment requests submitted in the last 30 days">30d: <strong>' + cnt30 + '</strong></span>' +
            '<span class="pe-count" title="Adjustment requests submitted in the last 90 days">90d: <strong>' + cnt90 + '</strong></span>' +
          '</div>' +
        '</header>' +
        '<div class="pe-times">' +
          '<div class="pe-time-block">' +
            '<p class="pe-time-label">Original</p>' +
            '<p class="pe-time-value">' + escapeHtml(fmtPacificClock(r.original_clock_in)) +
              ' → ' + escapeHtml(fmtPacificClock(r.original_clock_out)) + '</p>' +
            '<p class="pe-time-sub">' + (typeof r.original_minutes === "number" ? r.original_minutes + 'm' : '—') + '</p>' +
          '</div>' +
          '<div class="pe-arrow" aria-hidden="true">→</div>' +
          '<div class="pe-time-block is-requested">' +
            '<p class="pe-time-label">Requested</p>' +
            '<p class="pe-time-value">' + escapeHtml(fmtPacificClock(r.requested_clock_in)) +
              ' → ' + escapeHtml(fmtPacificClock(r.requested_clock_out)) + '</p>' +
            '<p class="pe-time-sub">' + (typeof r.requested_minutes === "number" ? r.requested_minutes + 'm' : '—') + '</p>' +
          '</div>' +
          '<div class="pe-delta ' + (r.delta_minutes > 0 ? 'is-pos' : (r.delta_minutes < 0 ? 'is-neg' : '')) + '">' +
            '<p class="pe-time-label">Delta</p>' +
            '<p class="pe-time-value">' + escapeHtml(fmtDeltaMinutes(r.delta_minutes)) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="pe-meta">' +
          '<p><strong>Reason:</strong> ' + escapeHtml(reasonLabel(r.reason)) + '</p>' +
          '<p><strong>Notes:</strong> ' + escapeHtml(r.notes || "") + '</p>' +
          '<p class="pe-sub-stamp"><strong>Submitted:</strong> ' + escapeHtml(fmtPacificDateTime(r.submitted_at)) + '</p>' +
        '</div>' +
        '<div class="pe-actions">' +
          '<button type="button" class="admin-btn admin-btn-secondary" data-pe-deny="' + escapeHtml(r._id) + '">Deny</button>' +
          '<button type="button" class="admin-btn admin-btn-primary"   data-pe-approve="' + escapeHtml(r._id) + '">Approve</button>' +
        '</div>' +
      '</article>'
    );
  }

  function renderHistoryCard(r) {
    const customer = r.customer_name
      ? (r.customer_name + (r.location_name ? " · " + r.location_name : ""))
      : (r.location_name || "—");
    const isApproved = (r.status === "approved");
    return (
      '<article class="pe-card pe-card-history">' +
        '<header class="pe-card-head">' +
          '<div>' +
            '<h3 class="pe-card-emp">' + escapeHtml(r.employee_name || r.employee_email || "Tech") + '</h3>' +
            '<p class="pe-card-sub">' + escapeHtml(customer) + ' · ' + escapeHtml(fmtShiftDate(r.shift_date)) + '</p>' +
          '</div>' +
          '<span class="pe-chip ' + (isApproved ? 'is-approved' : 'is-denied') + '">' +
            (isApproved ? 'Approved' : 'Denied') + '</span>' +
        '</header>' +
        '<div class="pe-meta">' +
          '<p><strong>Original:</strong> ' + escapeHtml(fmtPacificClock(r.original_clock_in)) +
            ' → ' + escapeHtml(fmtPacificClock(r.original_clock_out)) +
            ' (' + (typeof r.original_minutes === "number" ? r.original_minutes + 'm' : '—') + ')</p>' +
          '<p><strong>' + (isApproved ? 'Effective' : 'Requested') + ':</strong> ' +
            escapeHtml(fmtPacificClock(isApproved ? r.effective_clock_in : r.requested_clock_in)) +
            ' → ' + escapeHtml(fmtPacificClock(isApproved ? r.effective_clock_out : r.requested_clock_out)) +
            ' (' + (typeof (isApproved ? r.effective_minutes : r.requested_minutes) === "number"
                    ? (isApproved ? r.effective_minutes : r.requested_minutes) + 'm' : '—') + ')</p>' +
          '<p><strong>Delta:</strong> ' + escapeHtml(fmtDeltaMinutes(r.delta_minutes)) +
            ' · <strong>Reason:</strong> ' + escapeHtml(reasonLabel(r.reason)) + '</p>' +
          '<p><strong>Notes:</strong> ' + escapeHtml(r.notes || "") + '</p>' +
          (isApproved
            ? '<p class="pe-sub-stamp"><strong>Approved by:</strong> ' +
                escapeHtml(r.reviewed_by_name || "—") + ' · ' +
                escapeHtml(fmtPacificDateTime(r.reviewed_at)) + '</p>'
            : '<p class="pe-sub-stamp"><strong>Denied by:</strong> ' +
                escapeHtml(r.reviewed_by_name || "—") + ' · ' +
                escapeHtml(fmtPacificDateTime(r.reviewed_at)) +
                '<br><strong>Denial reason:</strong> ' + escapeHtml(r.denial_reason || "—") + '</p>') +
        '</div>' +
      '</article>'
    );
  }

  /* ---------- approve / deny ---------- */

  async function postWithAuth(url, payload) {
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      throw new Error((body && body.error) || ("HTTP " + res.status));
    }
    return body;
  }

  function findRequest(id) {
    for (let i = 0; i < requests.length; i++) {
      if (requests[i]._id === id) return requests[i];
    }
    return null;
  }

  async function approveRequest(id) {
    const r = findRequest(id);
    if (!r) return;
    const ok = window.confirm(
      "Approve time adjustment for " + (r.employee_name || r.employee_email || "this employee") +
      "?\n\nShift: " + (r.customer_name || "") + " · " + (r.shift_date || "") +
      "\nEffective clock: " + fmtPacificClock(r.requested_clock_in) +
      " → " + fmtPacificClock(r.requested_clock_out) +
      "\nDelta: " + fmtDeltaMinutes(r.delta_minutes) +
      "\n\nPayroll export will use these effective times. Original clock data stays preserved."
    );
    if (!ok) return;
    const url = (window.APPROVE_TIME_ADJUSTMENT_REQUEST_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      alert("APPROVE_TIME_ADJUSTMENT_REQUEST_URL is not configured in firebase-config.js.");
      return;
    }
    try {
      await postWithAuth(url, { request_id: id });
      await refresh();
    } catch (err) {
      alert("Approve failed: " + (err.message || "unknown error"));
    }
  }

  async function denyRequest(id) {
    const r = findRequest(id);
    if (!r) return;
    const reason = window.prompt(
      "Deny time adjustment for " + (r.employee_name || r.employee_email || "this employee") +
      ".\n\nEnter a denial reason (visible to employee):"
    );
    if (reason == null) return;             // user cancelled
    const trimmed = String(reason).trim();
    if (!trimmed) { alert("Denial reason is required."); return; }
    const url = (window.DENY_TIME_ADJUSTMENT_REQUEST_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      alert("DENY_TIME_ADJUSTMENT_REQUEST_URL is not configured in firebase-config.js.");
      return;
    }
    try {
      await postWithAuth(url, { request_id: id, denial_reason: trimmed });
      await refresh();
    } catch (err) {
      alert("Deny failed: " + (err.message || "unknown error"));
    }
  }

  /* ---------- click wiring ---------- */

  function wireClicks() {
    document.addEventListener("click", function (ev) {
      const subtabBtn = ev.target.closest("[data-pe-subtab]");
      if (subtabBtn) {
        activeSubTab = subtabBtn.getAttribute("data-pe-subtab");
        renderSubTabs();
        renderActiveList();
        return;
      }
      const approveBtn = ev.target.closest("[data-pe-approve]");
      if (approveBtn) {
        approveRequest(approveBtn.getAttribute("data-pe-approve"));
        return;
      }
      const denyBtn = ev.target.closest("[data-pe-deny]");
      if (denyBtn) {
        denyRequest(denyBtn.getAttribute("data-pe-deny"));
        return;
      }
    });
    const refreshBtn = $("payroll-exceptions-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });
  }

  /* ---------- init ---------- */

  function init() {
    wireClicks();
    ensureStyles();
  }

  function ensureStyles() {
    if (document.querySelector('[data-pioneer="payroll-exceptions-styles"]')) return;
    const css = [
      "#payroll-exceptions-subtabs{display:flex;gap:6px;margin-bottom:14px;}",
      "#payroll-exceptions-subtabs .pe-subtab{appearance:none;border:1px solid #c9d4ec;background:#f4f6fb;color:#1e293b;padding:8px 14px;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}",
      "#payroll-exceptions-subtabs .pe-subtab.is-active{background:#2f6dd6;color:#fff;border-color:#2f6dd6;}",
      "#payroll-exceptions-subtabs .pe-subtab-count{background:rgba(255,255,255,0.7);color:#1e293b;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:800;}",
      "#payroll-exceptions-subtabs .pe-subtab.is-active .pe-subtab-count{background:rgba(255,255,255,0.25);color:#fff;}",
      ".pe-card{background:#fff;border:1px solid #e2e6ee;border-radius:12px;padding:16px;margin-bottom:14px;}",
      ".pe-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;}",
      ".pe-card-emp{margin:0 0 4px;font-size:16px;font-weight:700;color:#0f172a;}",
      ".pe-card-sub{margin:0;font-size:13px;color:#64748b;}",
      ".pe-counts{display:flex;gap:8px;flex-shrink:0;}",
      ".pe-count{font-size:12px;color:#475569;background:#f4f6fb;padding:4px 10px;border-radius:999px;border:1px solid #e2e6ee;}",
      ".pe-times{display:grid;grid-template-columns:1fr auto 1fr auto;gap:10px;align-items:center;margin-bottom:14px;padding:12px;background:#f8fafc;border-radius:10px;}",
      ".pe-time-block{display:flex;flex-direction:column;}",
      ".pe-time-block.is-requested{color:#0f5132;}",
      ".pe-time-label{margin:0 0 2px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;}",
      ".pe-time-value{margin:0;font-size:14px;font-weight:700;color:#0f172a;}",
      ".pe-time-sub{margin:2px 0 0;font-size:12px;color:#64748b;}",
      ".pe-arrow{font-size:18px;color:#94a3b8;font-weight:700;}",
      ".pe-delta{display:flex;flex-direction:column;align-items:flex-end;padding-left:10px;border-left:1px solid #e2e6ee;}",
      ".pe-delta .pe-time-value{font-size:16px;}",
      ".pe-delta.is-pos .pe-time-value{color:#0f5132;}",
      ".pe-delta.is-neg .pe-time-value{color:#991b1b;}",
      ".pe-meta{font-size:13px;color:#334155;line-height:1.55;}",
      ".pe-meta p{margin:0 0 4px;}",
      ".pe-sub-stamp{color:#64748b;font-size:12px;}",
      ".pe-actions{display:flex;gap:10px;margin-top:14px;}",
      ".pe-actions .admin-btn{flex:1;}",
      ".pe-card-history{background:#fafbfd;}",
      ".pe-chip{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;flex-shrink:0;}",
      ".pe-chip.is-approved{background:#d1fae5;color:#065f46;}",
      ".pe-chip.is-denied{background:#fee2e2;color:#991b1b;}",
      "@media (max-width:640px){.pe-times{grid-template-columns:1fr;}.pe-arrow{display:none;}.pe-delta{border-left:none;border-top:1px solid #e2e6ee;padding:8px 0 0;align-items:flex-start;}}"
    ].join("\n");
    const style = document.createElement("style");
    style.setAttribute("data-pioneer", "payroll-exceptions-styles");
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- export ---------- */

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.payrollExceptions = {
    init:    init,
    refresh: refresh
  };
}());
