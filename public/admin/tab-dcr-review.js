/* Pioneer DCR Hub — Admin DCR email Review & Send modal (vanilla JS, no build).
 *
 * V6 pilot. Calls getDcrEmailReadinessV1 with an admin ID token,
 * renders blockers/warnings + a readiness checklist, and enables
 * the Send button only when the DCR is ready (or the operator
 * clicks Resend on an already-sent DCR).
 *
 * Send button hits the same generateAndSendDcrEmailV1 endpoint the
 * old token-based test loop used; that endpoint now ALSO runs the
 * readiness check server-side, so even a stale UI can't push a
 * not-ready DCR through.
 *
 * Surface lives at window.__pioneerAdmin.tabs.dcrReview:
 *   {
 *     init,       // wireDcrReviewControls — binds Send + Resend buttons
 *     openModal   // openDcrReviewModal(dcr) — entry point from DCR list
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml from __pioneerAdmin.utils
 *   • openModal from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - loadDcrsAndRerenderDependents()
 *   • window.firebase compat SDK (auth)
 *   • window.GET_DCR_EMAIL_READINESS_URL + window.GENERATE_AND_SEND_DCR_EMAIL_URL
 *     (firebase-config.js)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-dcr-review.js: utils + shell modules must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;
  const { openModal }  = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-dcr-review: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const loadDcrsAndRerenderDependents = () => depOrThrow("loadDcrsAndRerenderDependents")();

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let _dcrReviewCurrentDcrId = null;
  let _dcrReviewLastReadiness = null;

  /* ---------- entry point ---------- */

  async function openDcrReviewModal(dcr) {
    if (!dcr) return;
    const dcrId = dcr.submission_id || dcr.id;
    _dcrReviewCurrentDcrId  = dcrId;
    _dcrReviewLastReadiness = null;

    // Reset the modal to a loading state every time it opens. Avoids
    // showing stale data from the previous DCR while the new readiness
    // check is in flight.
    const titleEl   = $("dcr-review-title");
    const subTextEl = $("dcr-review-subtitle");
    if (titleEl)   titleEl.textContent   = "Review DCR email";
    if (subTextEl) subTextEl.textContent = (dcr.customer_name || "—") + " · " +
                                           (dcr.tech_display_name || "—") + " · " +
                                           (dcr.clean_date || "");
    setDcrReviewBody('<p class="dcr-review-loading">Running readiness check…</p>');
    setDcrReviewError("");
    setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: true });
    setDcrReviewResendButton({ disabled: true, visible: false });
    openModal("dcr-email-review-modal");

    await refreshDcrReviewReadiness("send");
  }

  /* ---------- readiness check ---------- */

  async function refreshDcrReviewReadiness(mode) {
    const dcrId = _dcrReviewCurrentDcrId;
    if (!dcrId) return;
    const url = (window.GET_DCR_EMAIL_READINESS_URL || "").trim();
    if (!url) {
      setDcrReviewError("GET_DCR_EMAIL_READINESS_URL not configured in firebase-config.js.");
      return;
    }
    let idToken;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      setDcrReviewError("You appear to be signed out. Refresh and sign in again.");
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body:   JSON.stringify({ dcrId: dcrId, mode: mode || "send" })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        setDcrReviewError((data && data.error) || ("HTTP " + res.status));
        return;
      }
      _dcrReviewLastReadiness = data;
      renderDcrReviewReadiness(data);
    } catch (e) {
      setDcrReviewError(String(e && e.message || e));
    }
  }

  function renderDcrReviewReadiness(r) {
    // The readiness JSON has the shape:
    //   { ready, blockers[], warnings[], resolved }
    // We turn it into a labeled checklist + blocker/warning lists +
    // a "what the customer will see" summary block. The Send button
    // is only enabled when ready === true. When the only blocker is
    // already_sent, the Resend button replaces Send.
    const resolved = r.resolved || {};
    const blockers = Array.isArray(r.blockers) ? r.blockers : [];
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    const ready    = !!r.ready;

    const checkItem = function (ok, label, detail) {
      const icon = ok ? '✓' : '○';
      const cls  = ok ? 'dcr-review-check-ok' : 'dcr-review-check-pending';
      return (
        '<li class="' + cls + '">' +
          '<span class="dcr-review-check-icon">' + icon + '</span>' +
          '<span class="dcr-review-check-label">' + escapeHtml(label) + '</span>' +
          (detail ? ('<span class="dcr-review-check-detail">' + escapeHtml(detail) + '</span>') : '') +
        '</li>'
      );
    };

    const recipients = Array.isArray(resolved.emailRecipients) ? resolved.emailRecipients : [];
    const recipientsLine = recipients.length
      ? recipients.join(", ")
      : "(none on file)";

    const checklistHtml =
      '<ul class="dcr-review-checklist" role="list">' +
        checkItem(!!resolved.customerId,          "Customer resolved",        resolved.customerName || "") +
        checkItem(recipients.length > 0,          "Email recipient(s)",        recipientsLine) +
        checkItem(!!resolved.techId,              "Tech resolved",             resolved.techName || "") +
        checkItem(!!resolved.hasTechPhoto,        "Tech profile photo",        resolved.hasTechPhoto ? "on file" : "missing — initials fallback") +
        checkItem(!!resolved.hasSignature,        "Off-site signature",        resolved.hasSignature ? "captured" : "missing") +
        checkItem(resolved.photoCount > 0,        "After photos",              (resolved.photoCount || 0) + " on file") +
        checkItem(true,                            "Issue tier",                String(resolved.issueTier || "green").toUpperCase()) +
      '</ul>';

    let blockersHtml = "";
    if (blockers.length) {
      blockersHtml =
        '<div class="dcr-review-issues dcr-review-issues-block">' +
          '<div class="dcr-review-issues-title">Blockers — must resolve before send</div>' +
          '<ul>' +
            blockers.map(function (b) {
              return '<li><strong>' + escapeHtml(b.code) + '</strong>: ' + escapeHtml(b.message) + '</li>';
            }).join("") +
          '</ul>' +
        '</div>';
    }
    let warningsHtml = "";
    if (warnings.length) {
      warningsHtml =
        '<div class="dcr-review-issues dcr-review-issues-warn">' +
          '<div class="dcr-review-issues-title">Warnings — send anyway is OK</div>' +
          '<ul>' +
            warnings.map(function (w) {
              return '<li><strong>' + escapeHtml(w.code) + '</strong>: ' + escapeHtml(w.message) + '</li>';
            }).join("") +
          '</ul>' +
        '</div>';
    }

    let alreadySentHtml = "";
    if (resolved.emailStatus === "sent") {
      alreadySentHtml =
        '<div class="dcr-review-already-sent">' +
          '<div class="dcr-review-issues-title">Previously sent</div>' +
          '<div>' + escapeHtml(resolved.lastSentAt || "") + '</div>' +
          (resolved.lastSentTo ? ('<div style="margin-top:4px;color:var(--pc-text-muted);">To: ' + escapeHtml(resolved.lastSentTo) + '</div>') : '') +
        '</div>';
    }

    setDcrReviewBody(checklistHtml + blockersHtml + warningsHtml + alreadySentHtml);

    // Send/Resend button state. Three cases:
    //   1. ready          → Send enabled, Resend hidden
    //   2. only blocker is already_sent → Send hidden, Resend enabled
    //   3. other blockers → Send disabled, Resend hidden
    const onlyAlreadySentBlocker = blockers.length === 1 && blockers[0].code === "already_sent";
    if (ready) {
      setDcrReviewSendButton({ disabled: false, label: "Send Customer DCR Email", visible: true });
      setDcrReviewResendButton({ disabled: true, visible: false });
    } else if (onlyAlreadySentBlocker) {
      setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: false });
      setDcrReviewResendButton({ disabled: false, visible: true });
    } else {
      setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: true });
      setDcrReviewResendButton({ disabled: true, visible: false });
    }
  }

  /* ---------- modal body / button setters ---------- */

  function setDcrReviewBody(html) {
    const el = $("dcr-review-body");
    if (el) el.innerHTML = html;
  }
  function setDcrReviewError(msg) {
    const el = $("dcr-review-err");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = ""; el.hidden = true; }
  }
  function setDcrReviewSendButton(opts) {
    const el = $("dcr-review-send");
    if (!el) return;
    el.disabled = !!opts.disabled;
    el.hidden   = !opts.visible;
    if (opts.label) el.textContent = opts.label;
  }
  function setDcrReviewResendButton(opts) {
    const el = $("dcr-review-resend");
    if (!el) return;
    el.disabled = !!opts.disabled;
    el.hidden   = !opts.visible;
  }

  /* ---------- send / resend ---------- */

  async function performDcrSend(confirmResend) {
    const dcrId = _dcrReviewCurrentDcrId;
    if (!dcrId) return;
    const url = (window.GENERATE_AND_SEND_DCR_EMAIL_URL || "").trim();
    if (!url) {
      setDcrReviewError("GENERATE_AND_SEND_DCR_EMAIL_URL not configured in firebase-config.js.");
      return;
    }
    let idToken;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      setDcrReviewError("You appear to be signed out. Refresh and sign in again.");
      return;
    }

    setDcrReviewError("");
    setDcrReviewSendButton({ disabled: true, label: "Sending…", visible: true });
    setDcrReviewResendButton({ disabled: true, visible: !!confirmResend });

    // Re-derive customerId from the readiness response. The handler
    // wants both dcrId and customerId; the readiness response is the
    // most reliable source for the customer slug.
    const customerId = (_dcrReviewLastReadiness && _dcrReviewLastReadiness.resolved &&
                        _dcrReviewLastReadiness.resolved.customerId) || "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body:   JSON.stringify({ dcrId: dcrId, customerId: customerId, confirmResend: !!confirmResend })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        setDcrReviewSendButton({ disabled: false, label: confirmResend ? "Send Customer DCR Email" : "Send Customer DCR Email", visible: !confirmResend });
        setDcrReviewResendButton({ disabled: false, visible: !!confirmResend });
        const err = (data && (data.error || (data.blockers && data.blockers.map(function (b) { return b.code; }).join(", ")))) || ("HTTP " + res.status);
        setDcrReviewError(err);
        return;
      }
      // Success — replace the body with a confirmation block.
      setDcrReviewBody(
        '<div class="dcr-review-success">' +
          '<div class="dcr-review-success-title">' +
            (data.status === "skipped" ? "Skipped — customer email disabled" : "Email sent ✓") +
          '</div>' +
          '<div><strong>To:</strong> ' + escapeHtml(data.to || "") + '</div>' +
          '<div><strong>Subject:</strong> ' + escapeHtml(data.subject || "") + '</div>' +
          (data.messageId
            ? ('<div><strong>Gmail message ID:</strong> <code>' + escapeHtml(data.messageId) + '</code></div>')
            : '') +
          (data.promptVersion ? ('<div style="color:var(--pc-text-muted);margin-top:6px;">promptVersion: ' + escapeHtml(data.promptVersion) + '</div>') : '') +
          (data.emailTemplate ? ('<div style="color:var(--pc-text-muted);">emailTemplate: ' + escapeHtml(data.emailTemplate) + '</div>') : '') +
        '</div>'
      );
      setDcrReviewSendButton({ disabled: true, label: "Sent", visible: !confirmResend });
      setDcrReviewResendButton({ disabled: true, visible: !!confirmResend });
      // Refresh the DCRs list so the row reflects the new status.
      // loadDcrsAndRerenderDependents is the admin.js cross-tab
      // orchestrator (Recent DCRs reload → Customers + Techs filter
      // refresh → Day Health repaint). Stays in admin.js until the
      // final glue sweep; reached here via the deps bridge.
      loadDcrsAndRerenderDependents().catch(function () { /* non-fatal */ });
    } catch (e) {
      setDcrReviewSendButton({ disabled: false, label: "Send Customer DCR Email", visible: !confirmResend });
      setDcrReviewResendButton({ disabled: false, visible: !!confirmResend });
      setDcrReviewError(String(e && e.message || e));
    }
  }

  /* ---------- wire DOM ---------- */

  function wireDcrReviewControls() {
    const sendBtn = $("dcr-review-send");
    if (sendBtn) sendBtn.addEventListener("click", function () { performDcrSend(false); });
    const resendBtn = $("dcr-review-resend");
    if (resendBtn) resendBtn.addEventListener("click", function () {
      if (window.confirm("Resend the DCR email to the customer? They'll get a second copy.")) {
        performDcrSend(true);
      }
    });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.dcrReview = {
    init:      wireDcrReviewControls,
    openModal: openDcrReviewModal
  };
}());
