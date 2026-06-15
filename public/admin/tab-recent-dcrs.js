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
    const zStatus    = (d.zapier && d.zapier.status) || "—";

    let problemBadge = "";
    if (hasProblem)      problemBadge = badge("is-err",  "Problem");
    else if (issues > 0) problemBadge = badge("is-warn", issues + " issue" + (issues === 1 ? "" : "s"));
    else                 problemBadge = badge("is-on",   "Clear");

    let zapBadge;
    if      (zStatus === "sent")           zapBadge = badge("is-on",   "Zapier: sent");
    else if (zStatus === "failed")         zapBadge = badge("is-err",  "Zapier: failed");
    else if (zStatus === "not_configured") zapBadge = badge("is-neutral", "Zapier: off");
    else                                   zapBadge = badge("is-neutral", "Zapier: —");

    const photoBadge = badge("is-photos", photoCount + ' photo' + (photoCount === 1 ? '' : 's'));

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
            photoBadge + problemBadge + zapBadge +
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
          // V6 — Review & Send opens the readiness modal for this DCR.
          // The modal calls getDcrEmailReadinessV1, renders blockers/
          // warnings, and only enables the actual Send button when
          // the DCR is ready (or the operator confirms a resend).
          '<button class="row-btn" type="button" data-action="review-send"' +
            ' title="Run the DCR email readiness check and send to the customer">' +
            'Review & Send' +
          '</button>' +
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
