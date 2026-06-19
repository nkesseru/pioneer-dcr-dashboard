/* Pioneer DCR Hub — Admin Recent DCRs tab (vanilla JS, no build).
 *
 * Recent DCRs list — the most-recent N submissions from dcr_submissions,
 * ordered created_at desc. N = DCR_RECENT_LIMIT (500, defined in utils).
 *
 * This module OWNS the dcrs array. Other admin tabs that need to read
 * DCRs (Customers + Techs for budget stats, the DCR review modal, the
 * Yesterday's Work cross-reference, etc.) read via
 *   window.__pioneerAdmin.deps.getDcrs()
 * which the admin.js boot wires through to this module's getDcrs.
 *
 * Surface lives at window.__pioneerAdmin.tabs.recentDcrs:
 *   {
 *     refresh:        loadDcrs,
 *     getDcrs:        () => dcrs,
 *     renderFiltered: (query) => …      // used by the search input
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js + admin/_budget.js
 * and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, formatTimestamp, DCR_RECENT_LIMIT from __pioneerAdmin.utils
 *   • badge, setStatus, hideAllStatuses from __pioneerAdmin.shell
 *   • window.firebase compat SDK (firestore)
 *
 * No closure deps on admin.js. No cross-tab state escape (dcrs lives
 * here; consumers read via deps.getDcrs()).
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-recent-dcrs.js: admin/_utils.js + admin/_shell.js must load first");
  }
  const {
    escapeHtml,
    formatTimestamp,
    tsToMs,
    DCR_RECENT_LIMIT
  } = window.__pioneerAdmin.utils;
  const {
    badge,
    setStatus,
    hideAllStatuses
  } = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let dcrs = [];

  /* ----------------------------------------------------------------------
   * 2026-06-19 — Five-state DCR email delivery mapping.
   *
   * Source of truth: dcr_submissions.native_email.status (Phase 32+).
   * Legacy emailStatus is consulted as a fallback for pre-Phase-32 DCRs
   * so old delivered records don't look "unsent" forever, but no legacy
   * writes are touched (drift cleanup is deferred).
   *
   * States (5):
   *   delivered           — green pill "✓ Sent · {rel}". No primary button;
   *                         small overflow "⋯ Resend" link (still routes to
   *                         the existing review modal, which detects already-
   *                         sent and switches to resend mode).
   *   failed              — red pill "Failed · {code}". Primary button:
   *                         "Retry Send" — routes through the same modal,
   *                         which re-runs sendNativeDcrEmailForSubmission.
   *   needs_review        — amber pill "Needs review". Primary button:
   *                         "Review & Send" (unchanged for this case).
   *   incomplete          — stone pill "Incomplete · {top blocker}". Primary
   *                         button: "Open review" so the operator sees the
   *                         actual blocker list before sending becomes possible.
   *                         v1 only detects "no customer email" client-side;
   *                         the modal surfaces the rest.
   *   skipped             — stone pill, reason-specific copy:
   *                           customer_dcr_email_disabled    → "Opted out"
   *                           customer_email_suppressed      → "Suppressed"
   *                           dcr_waived                     → "Waived"
   *                           customer_is_test               → "Internal"
   *                           exclude_from_customer_reporting → "Internal"
   *                           anything else                  → "Skipped · {reason}"
   *                         No action button.
   *
   * Dispatcher unchanged: every button still emits data-action="review-send"
   * so the existing modal opens for every state. Different data-variant
   * values just drive CSS for the visual distinction (red/teal/stone/overflow).
   */

  const SKIPPED_REASON_LABELS = {
    customer_dcr_email_disabled:     { label: "Opted out",  tip: "Customer has DCR emails disabled in their config." },
    customer_email_suppressed:       { label: "Suppressed", tip: "DCR email manually suppressed for this customer." },
    dcr_waived:                      { label: "Waived",     tip: "DCR was waived by the tech — no email triggered." },
    customer_is_test:                { label: "Internal",   tip: "Internal/test customer — DCR emails are never sent." },
    exclude_from_customer_reporting: { label: "Internal",   tip: "Customer excluded from customer-facing reporting." }
  };

  function fromNow(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 0)         return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60)           return "just now";
    const m = Math.floor(s / 60);
    if (m < 60)           return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24)           return h + "h ago";
    const d = Math.floor(h / 24);
    if (d < 30)           return d + "d ago";
    return formatTimestamp(ms);
  }

  function classifyEmailState(d) {
    const ne = d.native_email || null;

    // Priority 1 — native_email.status (Phase 32+ source of truth).
    if (ne && typeof ne.status === "string") {
      if (ne.status === "sent") {
        const sentMs = tsToMs(ne.sentAt) || tsToMs(d.created_at);
        return {
          state:    "delivered",
          pillCls:  "is-on",
          pillText: "✓ Sent · " + fromNow(sentMs),
          pillTip:  ne.recipient ? ("Sent to " + ne.recipient) : "DCR email delivered.",
          action:   "delivered"
        };
      }
      if (ne.status === "failed") {
        const code = ne.code || ne.reason || "unknown";
        return {
          state:    "failed",
          pillCls:  "is-err",
          pillText: "Failed · " + code,
          pillTip:  ne.reason || "DCR email delivery failed. Click Retry Send to try again.",
          action:   "retry-send"
        };
      }
      if (ne.status === "skipped") {
        const reason = ne.reason || "unknown";
        const meta   = SKIPPED_REASON_LABELS[reason]
                    || { label: "Skipped · " + reason, tip: "DCR email was not sent for this submission." };
        return {
          state:    "skipped",
          pillCls:  "is-neutral",
          pillText: meta.label,
          pillTip:  meta.tip,
          action:   "none"
        };
      }
    }

    // Priority 2 — legacy emailStatus (pre-Phase-32 DCRs). Read-only fallback.
    if (typeof d.emailStatus === "string") {
      if (d.emailStatus === "sent") {
        return {
          state:    "delivered",
          pillCls:  "is-on",
          pillText: "✓ Sent · " + fromNow(tsToMs(d.created_at)),
          pillTip:  "Delivered (legacy record — exact sent timestamp unavailable).",
          action:   "delivered"
        };
      }
      if (d.emailStatus === "failed") {
        return {
          state:    "failed",
          pillCls:  "is-err",
          pillText: "Failed",
          pillTip:  "DCR email delivery failed (legacy record). Click Retry Send to try again.",
          action:   "retry-send"
        };
      }
    }

    // Priority 3 — unsent. Pick incomplete vs needs_review from cheap client signals.
    // Only one Incomplete signal in v1: customer has no email on file. The modal
    // surfaces every other readiness blocker.
    const customerEmail = d.customer_email
                       || (d.customer && d.customer.email)
                       || (d.delivery && d.delivery.customer_email)
                       || null;
    if (!customerEmail) {
      return {
        state:    "incomplete",
        pillCls:  "is-neutral",
        pillText: "Incomplete · no email",
        pillTip:  "Customer has no email on file. Add one in the customer config before sending.",
        action:   "open-review"
      };
    }

    return {
      state:    "needs_review",
      pillCls:  "is-warn",
      pillText: "Needs review",
      pillTip:  "DCR ready. Open the review modal to verify and send.",
      action:   "review-send"
    };
  }

  function renderEmailActionButton(state) {
    // All buttons route to data-action="review-send" so the existing dispatcher
    // is unchanged. data-variant drives the visual treatment.
    if (state.action === "delivered") {
      return (
        '<button class="row-btn row-btn-resend-overflow" type="button" data-action="review-send" data-variant="resend-overflow" ' +
          'title="Resend this email">⋯ Resend</button>'
      );
    }
    if (state.action === "retry-send") {
      return (
        '<button class="row-btn row-btn-retry" type="button" data-action="review-send" data-variant="retry" ' +
          'title="Retry sending the DCR email">Retry Send</button>'
      );
    }
    if (state.action === "review-send") {
      return (
        '<button class="row-btn row-btn-review" type="button" data-action="review-send" data-variant="review" ' +
          'title="Run the DCR email readiness check and send to the customer">Review &amp; Send</button>'
      );
    }
    if (state.action === "open-review") {
      return (
        '<button class="row-btn row-btn-incomplete" type="button" data-action="review-send" data-variant="incomplete" ' +
          'title="Open the review modal to see what is missing">Open review</button>'
      );
    }
    return ""; // "none" — skipped variants get no button.
  }

  function dcrIssueCount(dcr) {
    const sections = (dcr.form_data && dcr.form_data.checklist) || [];
    let count = 0;
    sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) {
        if (it && it.status === "issue") count += 1;
      });
    });
    return count;
  }

  function dcrCard(d) {
    const id        = d.submission_id || d.id;
    const cleanDate = d.clean_date || "—";
    const customer  = d.customer_name || "—";
    const tech      = d.tech_display_name || "—";
    const photoCount = Array.isArray(d.photo_urls) ? d.photo_urls.length :
                       Array.isArray(d.photos)     ? d.photos.length     : 0;
    const issues     = dcrIssueCount(d);
    const hasProblem = !!(d.form_data && d.form_data.has_problem);

    let problemBadge = "";
    if (hasProblem)      problemBadge = badge("is-err",  "Problem");
    else if (issues > 0) problemBadge = badge("is-warn", issues + " issue" + (issues === 1 ? "" : "s"));
    else                 problemBadge = badge("is-on",   "Clear");

    const photoBadge = badge("is-photos", photoCount + ' photo' + (photoCount === 1 ? '' : 's'));

    // 2026-06-19 — Email delivery state pill replaces the old Zapier badge.
    // Zapier was superseded by the native DCR email path in Phase 32; this
    // row uses native_email.status (Phase 32+) as the source of truth, with
    // a read-only fallback to legacy emailStatus for older records. See
    // classifyEmailState above for the full state machine.
    const emailState = classifyEmailState(d);
    const emailBadge = '<span class="badge ' + emailState.pillCls +
                      ' dcr-email-pill" title="' + escapeHtml(emailState.pillTip) +
                      '" data-state="' + escapeHtml(emailState.state) + '">' +
                        escapeHtml(emailState.pillText) +
                      '</span>';
    const emailActionBtn = renderEmailActionButton(emailState);

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(id) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">' + escapeHtml(customer) + '</span>' +
          '<span class="row-sub">'  + escapeHtml(cleanDate) + ' · ' + escapeHtml(tech) + '</span>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Submission</span>' +
          '<code style="font-size:11.5px;color:var(--pc-text-muted);">' + escapeHtml(id) + '</code>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Created</span>' +
          escapeHtml(formatTimestamp(d.created_at)) +
        '</div>' +
        '<div class="row-actions">' +
          '<div class="pill-badges">' +
            photoBadge + problemBadge + emailBadge +
          '</div>' +
          // V20260615b — View photos opens the shared dcr-photos-modal.
          // Always shown so the operator has a one-click path to the
          // images regardless of DCR email state.
          (photoCount > 0
            ? '<button class="dcr-view-photos-btn" type="button" data-action="view-photos" ' +
                'title="View the ' + photoCount + ' photo' + (photoCount === 1 ? '' : 's') + ' on this DCR">' +
                'View ' + photoCount + ' photo' + (photoCount === 1 ? '' : 's') +
              '</button>'
            : '') +
          // 2026-06-19 — Action button is now state-driven (see
          // renderEmailActionButton). Delivered rows get a small overflow
          // Resend link; failed rows get Retry Send; needs-review gets the
          // classic Review & Send; incomplete gets Open review; skipped
          // variants get no button. All variants still route to
          // data-action="review-send" so the dispatcher below is unchanged.
          emailActionBtn +
        '</div>' +
      '</div>'
    );
  }

  function renderDcrs(list) {
    const root = $("dcr-list");
    const cnt  = $("dcr-count");
    if (!root) return;
    if (cnt) {
      const total = list.length;
      cnt.textContent =
        total + ' submission' + (total === 1 ? '' : 's') +
        ' (most recent first, capped at ' + DCR_RECENT_LIMIT + ')';
    }
    root.innerHTML = list.map(dcrCard).join("");
    if (list.length === 0 && dcrs.length === 0) setStatus("dcr", "empty");
    else hideAllStatuses("dcr");
  }

  // Filter + render in one call — used by the search input handler that
  // admin.js keeps in wireSearch (alongside Customers + Techs searches).
  function renderFiltered(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) { renderDcrs(dcrs); return; }
    const filtered = dcrs.filter(function (d) {
      return (
        (d.customer_name      || "").toLowerCase().includes(q) ||
        (d.tech_display_name  || "").toLowerCase().includes(q) ||
        (d.submission_id      || "").toLowerCase().includes(q) ||
        (d.id                 || "").toLowerCase().includes(q)
      );
    });
    renderDcrs(filtered);
  }

  async function loadDcrs() {
    setStatus("dcr", "loading");
    try {
      const snap = await firebase.firestore().collection("dcr_submissions")
        .orderBy("created_at", "desc")
        .limit(DCR_RECENT_LIMIT)
        .get();
      dcrs = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      renderDcrs(dcrs);
    } catch (err) {
      console.error("loadDcrs failed", err);
      setStatus("dcr", "error",
        "Couldn't load DCR submissions: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /dcr_submissions." +
        "\nIf it says 'failed-precondition' or mentions an index, click the URL in the browser console to create the suggested composite index."
      );
    }
  }

  /* ---------- one-time wiring ----------
   * Phase 25e: search input + refresh button + list event delegation
   * moved from admin.js (wireSearch + wireRefresh + wireWriteControls)
   * into this module. The dcrs array lives here, so the list-delegation
   * reads it directly. The Refresh button reaches the cross-tab
   * orchestrator (loadDcrsAndRerenderDependents) through the deps bridge
   * because admin.js still owns it — it fans out to customers + techs +
   * day-health repaints, which is shell-level orchestration. Boot calls
   * tabs.recentDcrs.init().
   */
  function wireRecentDcrsControls() {
    // Search input — filter the local dcrs array.
    const ds = $("dcr-search");
    if (ds) ds.addEventListener("input", function () { renderFiltered(ds.value); });

    // Refresh button — disables itself + flips label while reloading,
    // clears the search input after. Same behavior as the original
    // wireRefresh in admin.js.
    const btn = $("dcr-refresh");
    if (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = "Refreshing…";
        window.__pioneerAdmin.deps.loadDcrsAndRerenderDependents().finally(function () {
          btn.disabled = false;
          btn.textContent = original;
          const search = $("dcr-search");
          if (search) search.value = "";
        });
      });
    }

    // List event delegation — V6 review/send dispatcher. Each DCR row
    // has a [data-action="review-send"] button; clicking opens the
    // readiness modal pre-loaded against that DCR.
    const dcrRoot = $("dcr-list");
    if (dcrRoot) {
      dcrRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const d = dcrs.find(function (x) {
          return (x.submission_id || x.id) === row.dataset.id;
        });
        if (!d) return;
        if (btn.dataset.action === "review-send") {
          window.__pioneerAdmin.tabs.dcrReview.openModal(d);
        } else if (btn.dataset.action === "view-photos") {
          // V20260615b — shared shell modal; resolver handles all
          // photo field-name variants (photos[] / photo_urls[] /
          // after_photos / before_photos / issue_photos /
          // evidencePhotos / evidence_photos / attachments).
          const shell = window.__pioneerAdmin && window.__pioneerAdmin.shell;
          if (shell && typeof shell.openDcrPhotosModal === "function") {
            shell.openDcrPhotosModal({
              submissionId: d.submission_id || d.id,
              customerName: d.customer_name || "",
              location:     d.location_name || "",
              cleanDate:    d.clean_date || "",
              techName:     d.tech_display_name || ""
            });
          }
        }
      });
    }
  }

  function init() {
    wireRecentDcrsControls();
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.recentDcrs = {
    init:           init,
    refresh:        loadDcrs,
    getDcrs:        function () { return dcrs; },
    renderFiltered: renderFiltered
  };
}());
