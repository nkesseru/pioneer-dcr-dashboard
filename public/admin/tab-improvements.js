/* Pioneer DCR Hub — Admin Help Improve Pioneer tab (vanilla JS, no build).
 *
 * Help Improve Pioneer — admin review panel.
 * Reads pioneer_improvements (admin-only via Firestore rule). Lists
 * each submission with the 3 answers, optional category/photos, and
 * status workflow (submitted / reviewing / needs_clarification /
 * implemented / declined). Protected concerns get a distinct chrome
 * + an "Anonymous submission" tag (identity hidden in the card body
 * but still on the doc for serious-followup audit).
 *
 * Per-card admin controls:
 *   • Status select  → writes status + last_status_change_at +
 *                      last_status_change_by; implemented also stamps
 *                      implemented_at.
 *   • Admin notes textarea + Save notes button → writes admin_notes
 *                      (internal — never surfaced to the tech UI).
 *
 * Surface lives at window.__pioneerAdmin.tabs.improvements. Only `init`
 * is exported — internal functions stay private. Loaded AFTER
 * admin/_utils.js + admin/_shell.js + admin/_budget.js and BEFORE
 * admin.js. The boot in admin.js wires
 *   registerTabActivator("improvements", window.__pioneerAdmin.tabs.improvements.init);
 *
 * External dependencies:
 *   • escapeHtml, cssEsc, formatImprovementDate, tsToMs
 *     from __pioneerAdmin.utils
 *   • window.firebase compat SDK (auth + firestore)
 *
 * No closure deps on admin.js — this module is self-contained.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin/tab-improvements.js: admin/_utils.js must load first");
  }
  const {
    escapeHtml,
    cssEsc,
    formatImprovementDate,
    tsToMs
  } = window.__pioneerAdmin.utils;

  /* ---------- module state ---------- */

  let improvementsWired = false;
  let improvementsCurrentFilter = "open";
  let improvementsLastDocs = [];

  const IMPROVEMENT_STATUSES = [
    { value: "submitted",           label: "New" },
    { value: "reviewing",           label: "Reviewing" },
    { value: "needs_clarification", label: "Needs clarification" },
    { value: "implemented",         label: "Implemented" },
    { value: "declined",            label: "Declined" }
  ];
  const IMPROVEMENT_CATEGORY_LABELS = {
    pioneerops_ux: "PioneerOps UX",
    customer:      "Customer issue",
    supplies:      "Supplies",
    scheduling:    "Scheduling",
    communication: "Communication",
    safety:        "Safety",
    operations:    "Operations",
    equipment:     "Equipment",
    other:         "Other",
    protected:     "Protected concern"
  };

  function initImprovementsOnce() {
    if (improvementsWired) {
      loadImprovements();
      return;
    }
    improvementsWired = true;
    const refresh = document.getElementById("improvements-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadImprovements(); });
    document.querySelectorAll(".improvements-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        improvementsCurrentFilter = btn.dataset.filter || "open";
        document.querySelectorAll(".improvements-filter").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        renderImprovements();
      });
    });
    loadImprovements();
  }

  async function loadImprovements() {
    const loading = document.getElementById("improvements-loading");
    const errEl   = document.getElementById("improvements-error");
    const empty   = document.getElementById("improvements-empty");
    const list    = document.getElementById("improvements-list");
    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden   = true;
    if (empty)   empty.hidden   = true;
    if (list)    list.innerHTML = "";
    try {
      const db   = firebase.firestore();
      const snap = await db.collection("pioneer_improvements")
        .orderBy("created_at", "desc")
        .limit(200)
        .get();
      improvementsLastDocs = snap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data());
      });
      renderImprovements();
      updateImprovementsBadge();
    } catch (err) {
      console.error("[improvements] load failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't load improvements: " + (err && err.message || "unknown");
        errEl.hidden = false;
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function updateImprovementsBadge() {
    const badge = document.getElementById("improvements-tab-badge");
    if (!badge) return;
    const openCount = improvementsLastDocs.filter(function (d) {
      const s = String(d.status || "submitted");
      return s === "submitted" || s === "needs_clarification";
    }).length;
    if (openCount > 0) { badge.textContent = String(openCount); badge.hidden = false; }
    else               { badge.textContent = "0"; badge.hidden = true; }
  }

  function renderImprovements() {
    const list  = document.getElementById("improvements-list");
    const empty = document.getElementById("improvements-empty");
    if (!list) return;
    const filtered = improvementsLastDocs.filter(function (d) {
      const s = String(d.status || "submitted");
      if (improvementsCurrentFilter === "open") {
        return s !== "implemented" && s !== "declined";
      }
      if (improvementsCurrentFilter === "implemented") return s === "implemented";
      if (improvementsCurrentFilter === "protected")   return d.is_protected === true;
      return true; // all
    });
    if (filtered.length === 0) {
      list.innerHTML = "";
      if (empty) {
        empty.textContent = improvementsLastDocs.length === 0
          ? "No submissions yet. Share the /improve.html link with the team."
          : "Nothing matches this filter. Try another one above.";
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = filtered.map(renderImprovementCard).join("");
    // Wire status-change selects + admin-note textareas.
    list.querySelectorAll("select[data-improvement-id]").forEach(function (sel) {
      sel.addEventListener("change", function () { updateImprovementStatus(sel); });
    });
    list.querySelectorAll("button[data-action='save-notes']").forEach(function (btn) {
      btn.addEventListener("click", function () { saveImprovementNotes(btn); });
    });
  }

  function renderImprovementCard(d) {
    const id = d._id || d.submission_id;
    const status = String(d.status || "submitted");
    const isProtected = d.is_protected === true;
    const anon = d.is_anonymous === true;
    const submitter = anon
      ? "Anonymous"
      : (escapeHtml(d.submitted_by_name || d.submitted_by_email || "(unknown)"));
    const submitterMeta = anon ? "" : (
      d.submitted_by_email ? ('<span class="impr-meta-email">' + escapeHtml(d.submitted_by_email) + '</span>') : ''
    );
    const categoryLabel = IMPROVEMENT_CATEGORY_LABELS[d.category] || (d.category || "—");
    const photos = Array.isArray(d.photo_urls) ? d.photo_urls : [];
    const photosHtml = photos.length === 0 ? "" :
      '<div class="impr-photos">' +
        photos.map(function (u, i) {
          return '<a class="impr-photo" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">' +
                   '<img src="' + escapeHtml(u) + '" alt="Screenshot ' + (i + 1) + '" />' +
                 '</a>';
        }).join("") +
      '</div>';
    const statusOptions = IMPROVEMENT_STATUSES.map(function (s) {
      return '<option value="' + s.value + '"' + (s.value === status ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>';
    }).join("");
    const createdAt = formatImprovementDate(d.created_at);
    const lastChangeAt = (d.last_status_change_at && tsToMs(d.last_status_change_at) !== tsToMs(d.created_at))
      ? formatImprovementDate(d.last_status_change_at)
      : "";

    const protectedBadge = isProtected
      ? '<span class="impr-tag impr-tag-protected">Protected</span>'
      : '';
    const anonBadge = anon
      ? '<span class="impr-tag impr-tag-anon">Anonymous</span>'
      : '';
    const pioneerOpsBadge = d.is_pioneerops_issue
      ? '<span class="impr-tag impr-tag-app">PioneerOps app</span>'
      : '';

    return '<article class="impr-card impr-status-' + status + (isProtected ? ' is-protected' : '') + '" data-id="' + escapeHtml(id) + '">' +
             '<header class="impr-card-head">' +
               '<div class="impr-card-titles">' +
                 '<strong class="impr-card-submitter">' + submitter + '</strong> ' +
                 (submitterMeta ? submitterMeta : '') +
                 '<div class="impr-card-meta">' +
                   '<span class="impr-meta-cat">' + escapeHtml(categoryLabel) + '</span> · ' +
                   '<span class="impr-meta-date">' + escapeHtml(createdAt) + '</span>' +
                   (lastChangeAt ? ' · <span class="impr-meta-changed">status changed ' + escapeHtml(lastChangeAt) + '</span>' : '') +
                 '</div>' +
               '</div>' +
               '<div class="impr-card-tags">' + protectedBadge + anonBadge + pioneerOpsBadge + '</div>' +
             '</header>' +
             '<dl class="impr-card-answers">' +
               '<div><dt>Problem</dt><dd>' + escapeHtml(d.problem || "—") + '</dd></div>' +
               '<div><dt>Why it matters</dt><dd>' + escapeHtml(d.why_matters || "—") + '</dd></div>' +
               '<div><dt>Suggested improvement</dt><dd>' + escapeHtml(d.suggested_improvement || "—") + '</dd></div>' +
             '</dl>' +
             photosHtml +
             '<div class="impr-card-admin">' +
               '<label class="impr-status-label">' +
                 '<span>Status</span>' +
                 '<select data-improvement-id="' + escapeHtml(id) + '">' + statusOptions + '</select>' +
               '</label>' +
               '<label class="impr-notes-label">' +
                 '<span>Admin notes (internal)</span>' +
                 '<textarea rows="2" data-improvement-id="' + escapeHtml(id) + '" data-field="admin_notes">' + escapeHtml(d.admin_notes || "") + '</textarea>' +
               '</label>' +
               '<button type="button" class="panel-action impr-save-notes" data-action="save-notes" data-improvement-id="' + escapeHtml(id) + '">Save notes</button>' +
             '</div>' +
           '</article>';
  }

  async function updateImprovementStatus(selectEl) {
    const id     = selectEl.getAttribute("data-improvement-id");
    const status = selectEl.value;
    if (!id || !status) return;
    selectEl.disabled = true;
    try {
      const db  = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const u   = firebase.auth().currentUser;
      const update = {
        status: status,
        updated_at: sts,
        last_status_change_at: sts,
        last_status_change_by: {
          uid:         (u && u.uid) || null,
          email:       (u && u.email) || null,
          displayName: (u && u.displayName) || (u && u.email) || "admin"
        }
      };
      if (status === "implemented") {
        update.implemented_at = sts;
      }
      await db.collection("pioneer_improvements").doc(id).set(update, { merge: true });
      const card = selectEl.closest(".impr-card");
      if (card) {
        IMPROVEMENT_STATUSES.forEach(function (s) {
          card.classList.remove("impr-status-" + s.value);
        });
        card.classList.add("impr-status-" + status);
      }
      // Reflect locally so the badge + filter update without a refetch.
      const local = improvementsLastDocs.find(function (d) { return (d._id || d.submission_id) === id; });
      if (local) local.status = status;
      updateImprovementsBadge();
    } catch (err) {
      console.error("[improvements] status update failed", err);
      alert("Couldn't update status: " + (err && err.message));
    } finally {
      selectEl.disabled = false;
    }
  }

  async function saveImprovementNotes(btn) {
    const id = btn.getAttribute("data-improvement-id");
    if (!id) return;
    const ta = document.querySelector(
      'textarea[data-improvement-id="' + cssEsc(id) + '"][data-field="admin_notes"]'
    );
    if (!ta) return;
    const value = String(ta.value || "").trim();
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Saving…";
    try {
      await firebase.firestore().collection("pioneer_improvements").doc(id).set({
        admin_notes: value,
        updated_at:  firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      btn.textContent = "Saved";
      setTimeout(function () { btn.textContent = origLabel; }, 1400);
    } catch (err) {
      console.error("[improvements] save notes failed", err);
      btn.textContent = origLabel;
      alert("Couldn't save notes: " + (err && err.message));
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.improvements = {
    init: initImprovementsOnce
  };
}());
