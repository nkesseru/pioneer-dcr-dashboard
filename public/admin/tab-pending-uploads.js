/* Pioneer DCR Hub — Admin Pending Uploads tab (Phase 31D, 2026-06-22).
 *
 * Read-only admin view of dcr_pending_uploads. One row per DCR that's
 * waiting in a tech's IndexedDB queue (or stuck mid-retry). The shadow
 * doc is created by the queue worker on enqueue (queue-worker.js
 * createShadowDoc) and deleted on terminal upload success.
 *
 * Status enum (from queue worker):
 *   queued             — never tried to upload yet
 *   uploading          — actively in flight
 *   failed_will_retry  — backoff scheduled; next_attempt_at populated
 *   failed_permanent   — exceeded MAX_ATTEMPTS; needs human attention
 *
 * NO ACTIONS in Phase 31D — pure visibility. Future phases may add:
 *   • "Mark stuck row resolved" (manual admin write — rules already allow)
 *   • "Text the tech" (Twilio outbound from sendTwilioMessageV1)
 *   • Auto-stale highlighting (> 6 hours queued = red)
 *
 * Surface lives at window.__pioneerAdmin.tabs.pendingUploads:
 *   { init: wirePendingUploadsControls, refresh: loadPendingUploads }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js, BEFORE admin.js.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-pending-uploads.js: utils + shell modules must load first");
  }
  const {
    escapeHtml,
    formatTimestamp,
    tsToMs
  } = window.__pioneerAdmin.utils;
  const { badge, setStatus, hideAllStatuses } = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }

  let pendingUploads = [];

  function fromNow(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 0)         return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60)           return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60)           return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24)           return h + "h ago";
    const d = Math.floor(h / 24);
    return d + "d ago";
  }

  function statusBadge(status) {
    switch (status) {
      case "queued":            return badge("is-neutral", "Queued");
      case "uploading":         return badge("is-warn",    "Uploading…");
      case "failed_will_retry": return badge("is-warn",    "Retry pending");
      case "failed_permanent":  return badge("is-err",     "Failed — needs human");
      default:                  return badge("is-neutral", "Unknown · " + (status || "?"));
    }
  }

  function pendingRow(d) {
    const submissionId = d.submission_id || d.id;
    const queuedMs     = tsToMs(d.queued_at);
    const lastAttemptMs = tsToMs(d.last_attempt_at);
    const nextAttemptMs = tsToMs(d.next_attempt_at);
    const customer     = d.customer_name || d.customer_slug || "—";
    const tech         = d.tech_display_name || d.tech_email || "—";
    const photoCount   = typeof d.photo_count === "number" ? d.photo_count : 0;
    const attemptCount = typeof d.attempt_count === "number" ? d.attempt_count : 0;
    const sig          = d.has_signature === false ? "no signature" : "signature ok";

    const errCode = d.last_error_code || "";
    const errMsg  = d.last_error_message || "";
    const errBlock = (errCode || errMsg)
      ? '<div class="pu-err">' +
          (errCode ? '<code class="pu-err-code">' + escapeHtml(errCode) + '</code> ' : '') +
          (errMsg  ? '<span class="pu-err-msg">'  + escapeHtml(errMsg)  + '</span>' : '') +
        '</div>'
      : '';

    const nextBlock = (d.status === "failed_will_retry" && nextAttemptMs)
      ? '<div class="pu-next">Next attempt in ~' + fromNow(nextAttemptMs).replace(" ago", "") + '</div>'
      : '';

    const deviceTag = d.device_id ? '<code class="pu-device">' + escapeHtml(String(d.device_id).slice(0, 8)) + '</code>' : '';

    return (
      '<div class="admin-row pu-row" role="listitem" data-id="' + escapeHtml(submissionId) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">' + escapeHtml(customer) + '</span>' +
          '<span class="row-sub">' + escapeHtml(tech) + ' · ' + (d.clean_date ? escapeHtml(d.clean_date) + ' · ' : '') + photoCount + ' photo' + (photoCount === 1 ? '' : 's') + ' · ' + escapeHtml(sig) + '</span>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Queued</span>' +
          escapeHtml(fromNow(queuedMs)) +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Attempts</span>' +
          attemptCount + (lastAttemptMs ? ' · last ' + escapeHtml(fromNow(lastAttemptMs)) : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<div class="pill-badges">' + statusBadge(d.status) + '</div>' +
          deviceTag +
        '</div>' +
        (errBlock || nextBlock
          ? '<div class="row-meta-2">' + errBlock + nextBlock + '</div>'
          : '') +
      '</div>'
    );
  }

  function renderPending(list) {
    const root = $("pending-uploads-list");
    const cnt  = $("pending-uploads-count");
    if (!root) return;
    if (cnt) {
      const total = list.length;
      cnt.textContent = total + ' pending upload' + (total === 1 ? '' : 's');
    }
    root.innerHTML = list.length
      ? list.map(pendingRow).join("")
      : '<p class="pu-empty">No pending DCR uploads. Every queued submission has either landed in <code>dcr_submissions</code> or is sitting on a tech\'s device waiting for signal.</p>';
    if (list.length === 0) setStatus("pending-uploads", "empty");
    else                   hideAllStatuses("pending-uploads");
  }

  async function loadPendingUploads() {
    setStatus("pending-uploads", "loading");
    try {
      const snap = await firebase.firestore().collection("dcr_pending_uploads")
        .orderBy("queued_at", "desc")
        .limit(200)
        .get();
      pendingUploads = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      renderPending(pendingUploads);
    } catch (err) {
      console.error("loadPendingUploads failed", err);
      setStatus("pending-uploads", "error",
        "Couldn't load pending uploads: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allows admin read on /dcr_pending_uploads (Phase B deploy 2026-06-22)." +
        "\nIf it says 'failed-precondition' or mentions an index, the composite index on [queued_at] should already exist — check firestore.indexes.json."
      );
    }
  }

  function wirePendingUploadsControls() {
    const btn = $("pending-uploads-refresh");
    if (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = "Refreshing…";
        loadPendingUploads().finally(function () {
          btn.disabled = false;
          btn.textContent = original;
        });
      });
    }
  }

  function init() { wirePendingUploadsControls(); }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.pendingUploads = {
    init:    init,
    refresh: loadPendingUploads,
    get:     function () { return pendingUploads; }
  };
}());
