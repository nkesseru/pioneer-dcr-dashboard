/* Pioneer DCR Hub — Admin DCR Issues tab (vanilla JS, no build).
 *
 * DCR Issues — admin operational backlog
 *
 * The `dcr_issues` collection is auto-populated by submitDcrV1 each
 * time a DCR contains checklist `issue` items or a problem-section
 * report. This module manages the admin-side workflow: list, filter,
 * status updates, admin_notes. Reads/writes are gated by
 * firestore.rules → /dcr_issues/{id}: admin-only.
 *
 * This module OWNS the dcrIssues array. Other admin tabs that need
 * to read it (Customers' customerCard for open-issue counts, the
 * attention strip + day-health KPIs) read via
 *   window.__pioneerAdmin.deps.getDcrIssues()
 * which admin.js boot wires through to this module's getDcrIssues.
 *
 * Surface lives at window.__pioneerAdmin.tabs.dcrIssues:
 *   {
 *     init:         wireIssuesControls,
 *     refresh:      loadDcrIssues,
 *     getDcrIssues: () => dcrIssues,
 *     onChange:     (fn) => …    // admin.js registers post-load /
 *                                // post-save side-effect callbacks
 *                                // (applyCurrentCustomerFilter +
 *                                // refreshAttentionStrip)
 *   }
 *
 * External dependencies:
 *   • escapeHtml, tsToMs from __pioneerAdmin.utils
 *   • badge, setStatus, hideAllStatuses from __pioneerAdmin.shell
 *   • getCurrentAdminEmail, handleAdminWriteError from
 *     __pioneerAdmin.deps (lazy-resolved at call time)
 *   • window.firebase compat SDK (firestore)
 *
 * No closure deps on admin.js. No cross-tab state escape (dcrIssues
 * lives here; consumers read via deps.getDcrIssues()).
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-dcr-issues.js: admin/_utils.js + admin/_shell.js must load first");
  }
  const { escapeHtml, tsToMs } = window.__pioneerAdmin.utils;
  const { badge, setStatus, hideAllStatuses } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-dcr-issues: __pioneerAdmin.deps." + name + " not populated yet — boot order issue");
    }
    return deps[name];
  }
  const getCurrentAdminEmail  = window.__pioneerAdmin.shell.getCurrentAdminEmail;
  const handleAdminWriteError = window.__pioneerAdmin.shell.handleAdminWriteError;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let dcrIssues = [];
  let currentIssueStatus = "all";

  const ISSUE_STATUSES = ["new", "reviewed", "customer_contacted", "resolved", "closed_no_action"];
  const ISSUE_STATUS_LABELS = {
    new:                "New",
    reviewed:           "Reviewed",
    customer_contacted: "Customer contacted",
    resolved:           "Resolved",
    closed_no_action:   "Closed / No action"
  };
  const ISSUE_STATUS_BADGE_CLS = {
    new:                "is-warn",
    reviewed:           "is-neutral",
    customer_contacted: "is-neutral",
    resolved:           "is-on",
    closed_no_action:   "is-off"
  };

  /* ---------- post-load / post-save side-effect bridge ---------- */

  const onChangeCallbacks = [];
  function fireOnChange() {
    onChangeCallbacks.forEach(function (fn) {
      try { fn(); }
      catch (e) { console.warn("[dcr-issues] onChange callback failed", e); }
    });
  }

  async function loadDcrIssues() {
    setStatus("issues", "loading");
    try {
      // Order by created_at desc — most-recent issues bubble to the top.
      // Newer firestore SDKs sort nulls last so unstamped legacy docs
      // (if any) sink predictably.
      const snap = await firebase.firestore().collection("dcr_issues")
        .orderBy("created_at", "desc")
        .get();
      dcrIssues = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      refreshIssuesFilterOptions();
      applyCurrentIssuesFilter();
      // Admin.js side-effects: refresh attention strip + customer rows
      // (which display open-issue counts).
      fireOnChange();
    } catch (err) {
      console.error("loadDcrIssues failed", err);
      setStatus("issues", "error",
        "Couldn't load issues: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', confirm firestore.rules has " +
        "the /dcr_issues block deployed and you're signed in as an admin."
      );
    }
  }

  function dcrTsToFmt(ts) {
    // Reuse the canonical Firestore Timestamp / ISO reader from utils.
    const ms = tsToMs(ts);
    if (ms == null) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
           " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function issueCardHtml(it) {
    const status   = (it.status || "new");
    const statusCls = ISSUE_STATUS_BADGE_CLS[status] || "is-neutral";
    const statusOpts = ISSUE_STATUSES.map(function (s) {
      const sel = s === status ? " selected" : "";
      return '<option value="' + s + '"' + sel + '>' + ISSUE_STATUS_LABELS[s] + '</option>';
    }).join("");
    const stamps = [];
    if (it.reviewed_at)             stamps.push("Reviewed " + dcrTsToFmt(it.reviewed_at) + " by " + escapeHtml(it.reviewed_by || "?"));
    if (it.customer_contacted_at)   stamps.push("Customer contacted " + dcrTsToFmt(it.customer_contacted_at) + " by " + escapeHtml(it.customer_contacted_by || "?"));
    if (it.resolved_at)             stamps.push("Resolved " + dcrTsToFmt(it.resolved_at) + " by " + escapeHtml(it.resolved_by || "?"));
    if (it.updated_at)              stamps.push("Updated " + dcrTsToFmt(it.updated_at));

    const meta = [];
    if (it.clean_date)         meta.push("Clean date " + escapeHtml(it.clean_date));
    if (it.tech_display_name)  meta.push("Tech " + escapeHtml(it.tech_display_name));
    if (it.source)             meta.push("Source: " + escapeHtml(it.source));
    if (it.issue_type)         meta.push(escapeHtml(it.issue_type));

    // V20260615 — "View details" link surfaces the issue detail modal
    // (customer + tech + photos from the linked dcr_submission). Photos
    // live on the parent DCR, not the issue doc; the modal fetches them
    // lazily on open.
    const detailLink = it.submission_id
      ? '<button class="issue-detail-btn" type="button" data-action="view-detail" ' +
          'data-issue-id="' + escapeHtml(it.id) + '" ' +
          'data-submission-id="' + escapeHtml(it.submission_id) + '">' +
          'View details &amp; photos' +
        '</button>'
      : '';

    return (
      '<article class="issue-card" data-issue-id="' + escapeHtml(it.id) + '">' +
        '<div class="issue-head">' +
          '<span class="issue-customer">' +
            escapeHtml(it.customer_name || it.customer_slug || "(unknown customer)") +
            (it.location_name && it.location_name !== it.customer_name
              ? ' <span class="issue-meta">· ' + escapeHtml(it.location_name) + '</span>' : '') +
          '</span>' +
          '<span class="pill-badges">' + badge(statusCls, ISSUE_STATUS_LABELS[status] || status) + '</span>' +
        '</div>' +
        '<div class="issue-meta">' + meta.map(escapeHtml).join(" · ").replace(/&amp;lt;|&amp;gt;|&amp;amp;/g, function (m) { return m; }) + '</div>' +
        '<p class="issue-summary">' + escapeHtml(it.issue_summary || "(no summary)") + '</p>' +
        '<div class="issue-actions">' +
          '<select class="issue-status-select" aria-label="Status">' + statusOpts + '</select>' +
          '<input type="text" class="issue-notes-input" placeholder="Admin notes…" value="' +
            escapeHtml(it.admin_notes || "") + '" />' +
          '<button class="issue-save-btn" type="button" data-action="save">Save</button>' +
          detailLink +
          '<span class="issue-saved-hint" data-role="saved-hint" hidden>Saved.</span>' +
        '</div>' +
        (stamps.length
          ? '<div class="issue-stamps">' + stamps.join(" · ") + '</div>'
          : '') +
      '</article>'
    );
  }

  /* ---------- V20260615 — Issue detail modal + photo resolver ----------
   * Photos live on the parent dcr_submissions doc (see writer comment in
   * functions/index.js createDcrIssuesForSubmission — the issue doc
   * itself carries only text + workflow fields). On modal open we fetch
   * the linked DCR by submission_id and resolve photo URLs defensively
   * across the canonical field (photos[]) plus the fallback names
   * surfaced in the Phase 1 audit (photo_urls / after_photos /
   * before_photos / issue_photos / evidencePhotos).
   *
   * The fetch is admin-gated by the existing /dcr_submissions rule;
   * no rule change required.
   * --------------------------------------------------------------------- */

  function _normalizePhotoItem(p) {
    if (!p) return null;
    if (typeof p === "string") return { url: p, alt: "" };
    if (typeof p !== "object") return null;
    const url = p.download_url || p.downloadURL || p.url || "";
    if (!url) return null;
    return {
      url: url,
      alt: p.caption || p.tag || p.id || ""
    };
  }
  function _collectPhotosFromDcr(dcr) {
    if (!dcr) return [];
    const out = [];
    const seen = new Set();
    function push(p) {
      const n = _normalizePhotoItem(p);
      if (!n || seen.has(n.url)) return;
      seen.add(n.url);
      out.push(n);
    }
    // Canonical: photos[] with {download_url}
    if (Array.isArray(dcr.photos)) dcr.photos.forEach(push);
    // Flat URL list (Zapier convenience)
    if (Array.isArray(dcr.photo_urls)) dcr.photo_urls.forEach(push);
    // Defensive fallback field names per Phase 1 spec.
    ["after_photos","before_photos","issue_photos","evidencePhotos","evidence_photos","attachments"]
      .forEach(function (k) { if (Array.isArray(dcr[k])) dcr[k].forEach(push); });
    return out;
  }

  let _currentDetailIssueId = null;

  async function openIssueDetailModal(issueId, submissionId) {
    _currentDetailIssueId = issueId;
    const modal = $("dcr-issue-detail-modal");
    if (!modal) return;
    const it = dcrIssues.find(function (x) { return x.id === issueId; });
    if (!it) return;

    // Static fields from the issue doc (no fetch needed).
    const titleEl = $("dcr-issue-detail-title");
    if (titleEl) titleEl.textContent = it.customer_name || it.customer_slug || "Issue";

    const metaParts = [];
    if (it.location_name && it.location_name !== it.customer_name) metaParts.push(it.location_name);
    if (it.clean_date)         metaParts.push("Clean date " + it.clean_date);
    if (it.tech_display_name)  metaParts.push("Tech: " + it.tech_display_name);
    if (it.source)             metaParts.push("Source: " + it.source);
    if (it.issue_type)         metaParts.push(it.issue_type);
    if (it.status)             metaParts.push("Status: " + (ISSUE_STATUS_LABELS[it.status] || it.status));
    const metaEl = $("dcr-issue-detail-meta");
    if (metaEl) metaEl.textContent = metaParts.join(" · ");

    const sumEl = $("dcr-issue-detail-summary");
    if (sumEl) sumEl.textContent = it.issue_summary || "(no summary)";

    const notesEl = $("dcr-issue-detail-notes");
    if (notesEl) notesEl.textContent = it.admin_notes || "(no admin notes yet)";

    const subIdEl = $("dcr-issue-detail-submission-id");
    if (subIdEl) subIdEl.textContent = submissionId || "—";

    const photosEl = $("dcr-issue-detail-photos");
    const photoStatusEl = $("dcr-issue-detail-photos-status");
    if (photosEl) photosEl.innerHTML = "";
    if (photoStatusEl) {
      photoStatusEl.hidden = false;
      photoStatusEl.textContent = "Loading photos…";
    }

    // Show the modal now; photos populate when the fetch returns.
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    if (!submissionId) {
      if (photoStatusEl) photoStatusEl.textContent = "No linked DCR submission on this issue — no photos available.";
      return;
    }

    try {
      const snap = await firebase.firestore().collection("dcr_submissions").doc(submissionId).get();
      if (_currentDetailIssueId !== issueId) return;  // user closed/switched
      if (!snap.exists) {
        if (photoStatusEl) photoStatusEl.textContent = "Parent DCR submission not found (submission_id: " + submissionId + ").";
        return;
      }
      const dcr = snap.data() || {};
      const photos = _collectPhotosFromDcr(dcr);
      if (!photos.length) {
        if (photoStatusEl) photoStatusEl.textContent = "No photos attached to the linked DCR.";
        return;
      }
      if (photoStatusEl) photoStatusEl.hidden = true;
      if (photosEl) {
        photosEl.innerHTML = photos.map(function (p) {
          const safeUrl = escapeHtml(p.url);
          const safeAlt = escapeHtml(p.alt || "DCR photo");
          return '<a class="issue-photo-thumb" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" title="Open original (new tab)">' +
                   '<img src="' + safeUrl + '" alt="' + safeAlt + '" loading="lazy" />' +
                 '</a>';
        }).join("");
      }
    } catch (err) {
      console.error("[dcr-issues] photo fetch failed", err);
      if (photoStatusEl) {
        photoStatusEl.hidden = false;
        photoStatusEl.textContent = "Couldn't load photos: " + (err && err.message ? err.message : err);
      }
    }
  }

  function closeIssueDetailModal() {
    const modal = $("dcr-issue-detail-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    _currentDetailIssueId = null;
  }

  function renderIssues(list) {
    const root = $("issues-list");
    const cnt  = $("issues-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + ' issue' + (list.length === 1 ? '' : 's');

    // Refresh the per-status counts on the filter pills.
    const counts = { all: dcrIssues.length };
    ISSUE_STATUSES.forEach(function (s) { counts[s] = 0; });
    dcrIssues.forEach(function (it) {
      const s = (it.status || "new");
      if (counts[s] != null) counts[s] += 1;
    });
    Object.keys(counts).forEach(function (k) {
      const el = document.querySelector('.issues-filter-count[data-count-for="' + k + '"]');
      if (el) el.textContent = counts[k];
    });

    // Top-tab "New" badge.
    const tabBadge = $("issues-tab-badge");
    if (tabBadge) {
      if (counts.new > 0) {
        tabBadge.textContent = String(counts.new);
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }

    root.innerHTML = list.map(issueCardHtml).join("");
    if (list.length === 0 && dcrIssues.length === 0) setStatus("issues", "empty");
    else hideAllStatuses("issues");
  }

  function applyCurrentIssuesFilter() {
    const q = (($("issues-search") && $("issues-search").value) || "").trim().toLowerCase();

    // New compound filters: customer / tech / time window.
    const custSel = $("issues-filter-customer");
    const techSel = $("issues-filter-tech");
    const winSel  = $("issues-filter-window");
    const wantCust = custSel ? custSel.value : "all";
    const wantTech = techSel ? techSel.value : "all";
    const winKey   = winSel  ? winSel.value  : "all";

    let cutoffMs = null;
    if (winKey === "7")     cutoffMs = Date.now() - 7  * 24 * 3600 * 1000;
    else if (winKey === "30") cutoffMs = Date.now() - 30 * 24 * 3600 * 1000;
    else if (winKey === "month") {
      const d = new Date();
      cutoffMs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }

    const filtered = dcrIssues.filter(function (it) {
      if (currentIssueStatus !== "all" && (it.status || "new") !== currentIssueStatus) return false;
      if (wantCust !== "all" && (it.customer_slug || "") !== wantCust) return false;
      if (wantTech !== "all" && (it.tech_slug || "")     !== wantTech) return false;
      if (cutoffMs != null) {
        const ms = tsToMs(it.created_at);
        if (ms == null || ms < cutoffMs) return false;
      }
      if (!q) return true;
      return (
        (it.customer_name || "").toLowerCase().includes(q) ||
        (it.location_name || "").toLowerCase().includes(q) ||
        (it.tech_display_name || "").toLowerCase().includes(q) ||
        (it.issue_summary || "").toLowerCase().includes(q) ||
        (it.issue_type    || "").toLowerCase().includes(q)
      );
    });
    renderIssues(filtered);
  }

  // Populate the Issues tab's customer + tech selects from the cached
  // dcrIssues collection. Called whenever the collection reloads.
  function refreshIssuesFilterOptions() {
    function uniqueOptions(arr, keyField, labelField) {
      const seen = {};
      arr.forEach(function (it) {
        const k = it[keyField];
        if (!k) return;
        if (!seen[k]) seen[k] = it[labelField] || k;
      });
      return Object.keys(seen).sort(function (a, b) {
        return String(seen[a]).localeCompare(String(seen[b]));
      }).map(function (k) {
        return '<option value="' + escapeHtml(k) + '">' + escapeHtml(seen[k]) + '</option>';
      }).join("");
    }
    const custSel = $("issues-filter-customer");
    const techSel = $("issues-filter-tech");
    if (custSel) {
      const cur = custSel.value;
      custSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(dcrIssues, "customer_slug", "customer_name");
      custSel.value = cur || "all";
    }
    if (techSel) {
      const cur = techSel.value;
      techSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(dcrIssues, "tech_slug", "tech_display_name");
      techSel.value = cur || "all";
    }
  }

  async function saveIssueRow(card) {
    if (!card) return;
    const issueId = card.dataset.issueId;
    if (!issueId) return;
    const idx = dcrIssues.findIndex(function (x) { return x.id === issueId; });
    if (idx < 0) return;

    const sel = card.querySelector(".issue-status-select");
    const inp = card.querySelector(".issue-notes-input");
    const btn = card.querySelector(".issue-save-btn");
    const hint = card.querySelector('[data-role="saved-hint"]');
    if (!sel || !inp || !btn) return;

    const prev      = dcrIssues[idx];
    const newStatus = sel.value || "new";
    const newNotes  = inp.value || "";

    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const update = {
      status:      newStatus,
      admin_notes: newNotes,
      updated_at:  sts,
      updated_by:  adminEmail
    };
    // Workflow stamps — only set the FIRST time we enter that status.
    if (newStatus === "reviewed" && !prev.reviewed_at) {
      update.reviewed_at = sts;
      update.reviewed_by = adminEmail;
    }
    if (newStatus === "customer_contacted" && !prev.customer_contacted_at) {
      update.customer_contacted_at = sts;
      update.customer_contacted_by = adminEmail;
    }
    if ((newStatus === "resolved" || newStatus === "closed_no_action") && !prev.resolved_at) {
      update.resolved_at = sts;
      update.resolved_by = adminEmail;
    }

    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Saving…";
    try {
      await firebase.firestore().collection("dcr_issues").doc(issueId).update(update);
      dcrIssues[idx] = Object.assign({}, prev, update, {
        updated_at: new Date(),
        reviewed_at:           update.reviewed_at           ? new Date() : prev.reviewed_at,
        customer_contacted_at: update.customer_contacted_at ? new Date() : prev.customer_contacted_at,
        resolved_at:           update.resolved_at           ? new Date() : prev.resolved_at
      });
      if (hint) { hint.hidden = false; setTimeout(function () { hint.hidden = true; }, 1600); }
      applyCurrentIssuesFilter();
      // Admin.js side-effects: refresh attention strip + customer rows.
      fireOnChange();
    } catch (err) {
      handleAdminWriteError(err, { context: "issue save" });
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }

  function wireIssuesControls() {
    const search = $("issues-search");
    if (search) search.addEventListener("input", applyCurrentIssuesFilter);

    // Compound filter selects — refilter in place, no reload.
    ["issues-filter-customer", "issues-filter-tech", "issues-filter-window"].forEach(function (id) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", applyCurrentIssuesFilter);
    });

    // Filter pills.
    const filter = $("issues-filter");
    if (filter) {
      filter.addEventListener("click", function (ev) {
        const btn = ev.target.closest(".issues-filter-pill");
        if (!btn) return;
        currentIssueStatus = btn.dataset.status || "all";
        filter.querySelectorAll(".issues-filter-pill").forEach(function (p) {
          p.classList.toggle("is-active", p === btn);
        });
        applyCurrentIssuesFilter();
      });
    }

    // Save + View-detail delegation.
    const list = $("issues-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const saveBtn = ev.target.closest('[data-action="save"]');
        if (saveBtn) {
          const card = saveBtn.closest(".issue-card");
          saveIssueRow(card);
          return;
        }
        const detailBtn = ev.target.closest('[data-action="view-detail"]');
        if (detailBtn) {
          const issueId = detailBtn.dataset.issueId;
          const subId   = detailBtn.dataset.submissionId;
          openIssueDetailModal(issueId, subId);
          return;
        }
      });
    }

    // V20260615 — Issue detail modal close affordances.
    const modal = $("dcr-issue-detail-modal");
    if (modal) {
      modal.addEventListener("click", function (ev) {
        if (ev.target.closest && ev.target.closest("[data-modal-close]")) closeIssueDetailModal();
      });
    }

    const refresh = $("issues-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      refresh.disabled = true;
      const original = refresh.textContent;
      refresh.textContent = "Refreshing…";
      loadDcrIssues().finally(function () {
        refresh.disabled = false;
        refresh.textContent = original;
      });
    });
  }

  // setFilter — used by the attention-strip click delegator in admin.js
  // when the user clicks the "New Issues" KPI tile. Sets the filter state,
  // updates the pill DOM classes, and re-renders. Same behavior as the
  // attention-strip code in pre-Phase-12 admin.js, just relocated.
  function setFilter(status) {
    currentIssueStatus = status || "all";
    const filter = $("issues-filter");
    if (filter) {
      filter.querySelectorAll(".issues-filter-pill").forEach(function (p) {
        p.classList.toggle("is-active", p.dataset.status === currentIssueStatus);
      });
    }
    applyCurrentIssuesFilter();
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.dcrIssues = {
    init:         wireIssuesControls,
    refresh:      loadDcrIssues,
    getDcrIssues: function () { return dcrIssues; },
    onChange:     function (fn) { if (typeof fn === "function") onChangeCallbacks.push(fn); },
    setFilter:    setFilter
  };
}());
