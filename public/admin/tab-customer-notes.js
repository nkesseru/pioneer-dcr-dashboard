/* Pioneer DCR Hub — Admin Customer Notes + Note Suggestions tabs
 * (vanilla JS, no build).
 *
 * Customer Notes — CRUD + review cadence
 * Note Suggestions — admin review queue
 *
 * Persistent operational notes per customer. Office maintains; techs
 * read through techHubViewV1 (server-gated by assigned_customer_slugs)
 * and submit suggestions via the Note Suggestions tab.
 *
 * Both modules share one IIFE because Suggestions reads Customer Notes'
 * `customerNotes` array (for the "linked note" preview) and calls
 * Customer Notes' openNoteEditModal / openNoteCreateModal (for the
 * "Apply to note…" flow). Shipping them together keeps the shared
 * state inside the IIFE closure — no namespace escape.
 *
 * Two namespaces registered:
 *   window.__pioneerAdmin.tabs.customerNotes  = { init, refresh }
 *   window.__pioneerAdmin.tabs.noteSuggestions = { init, refresh }
 *
 * External dependencies:
 *   • escapeHtml, cssEsc, getCustomerName, getCustomerSlug, getActive
 *     from __pioneerAdmin.utils
 *   • openModal, closeModal, showToast, setStatus, hideAllStatuses
 *     from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps (admin.js
 *     populates this bridge during boot — scaffolding until Customers
 *     + modal-infra are extracted):
 *       - getCustomers()             — returns the live customers array
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, saving)
 *   • window.firebase compat SDK (auth + firestore)
 *
 * No cross-tab state escape: customerNotes + noteSuggestions arrays live
 * inside this IIFE only. No other tab reads them.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-customer-notes.js: admin/_utils.js + admin/_shell.js must load first");
  }
  const {
    escapeHtml,
    getCustomerName,
    getCustomerSlug,
    getActive
  } = window.__pioneerAdmin.utils;
  const {
    openModal,
    closeModal,
    showToast,
    setStatus,
    hideAllStatuses
  } = window.__pioneerAdmin.shell;

  // Lazy resolvers — admin.js populates __pioneerAdmin.deps in boot,
  // which runs AFTER this module's script tag has executed. So we
  // resolve at call time, not at module-load time. Each helper throws
  // a clear error if the bridge isn't populated yet (shouldn't happen
  // post-boot).
  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-customer-notes: __pioneerAdmin.deps." + name + " not populated yet — boot order issue");
    }
    return deps[name];
  }
  const getCustomers          = () => depOrThrow("getCustomers")();
  const getCurrentAdminEmail  = () => depOrThrow("getCurrentAdminEmail")();
  const handleAdminWriteError = (err, opts) => depOrThrow("handleAdminWriteError")(err, opts);
  const setModalError         = (modalId, msg) => depOrThrow("setModalError")(modalId, msg);
  const setModalSaving        = (modalId, saving) => depOrThrow("setModalSaving")(modalId, saving);

  // DOM shorthand — same alias used elsewhere in admin.js, kept local
  // here so we don't pollute the global namespace.
  function $(id) { return document.getElementById(id); }

  /* ====================================================================
     Customer Notes — CRUD + review cadence
     ====================================================================
     Doc id is auto. Field set:
       customer_slug · title · body · category · active · review_due_at ·
       last_reviewed_at · last_reviewed_by · created_at · created_by ·
       updated_at · updated_by · archived_at · archived_by

     Review cadence: a note is "overdue" when last_reviewed_at (or
     updated_at if no review yet) is older than 60 days.
     ==================================================================== */

  const NOTE_CATEGORIES = [
    "Security", "Access", "Cleaning Preference",
    "Sensitive Area", "Equipment", "Customer Request", "Other"
  ];
  const NOTE_REVIEW_OVERDUE_MS = 60 * 24 * 60 * 60 * 1000;

  let customerNotes = [];

  // Notes-local tsToMillis — uses `0` as sentinel for null/error so the
  // sort + overdue chain treat unreadable timestamps as "never reviewed
  // / oldest possible". Distinct from the `null`-returning tsToMs in
  // __pioneerAdmin.utils — both semantics are needed and have different
  // call-site expectations.
  function tsToMillis(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function")   return ts.toDate().getTime();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts === "string")            { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function isNoteReviewOverdue(n) {
    if (!n || n.active === false) return false;
    const reviewMs = tsToMillis(n.last_reviewed_at) || tsToMillis(n.updated_at) || tsToMillis(n.created_at);
    if (!reviewMs) return true;   // never stamped → treat as needing review
    return (Date.now() - reviewMs) > NOTE_REVIEW_OVERDUE_MS;
  }

  function customerLabelForSlug(slug) {
    const customers = getCustomers();
    const c = customers.find(function (x) {
      return String(getCustomerSlug(x) || "").toLowerCase() === String(slug || "").toLowerCase();
    });
    return c ? (getCustomerName(c) || getCustomerSlug(c)) : (slug || "(unknown)");
  }

  function applyCurrentNotesFilter() {
    const root  = $("notes-list");
    const cnt   = $("notes-count");
    if (!root) return;

    const cust  = ($("notes-filter-customer") && $("notes-filter-customer").value) || "all";
    const cat   = ($("notes-filter-category") && $("notes-filter-category").value) || "all";
    const stat  = ($("notes-filter-status")   && $("notes-filter-status").value)   || "active";
    const q     = String(($("notes-search") && $("notes-search").value) || "").trim().toLowerCase();

    const filtered = customerNotes.filter(function (n) {
      if (cust !== "all" && String(n.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      if (cat  !== "all" && (n.category || "Other") !== cat) return false;
      if (stat === "active"   && n.active === false) return false;
      if (stat === "archived" && n.active !== false) return false;
      if (stat === "overdue"  && !isNoteReviewOverdue(n)) return false;
      if (q) {
        const hay = ((n.title || "") + " " + (n.body || "") + " " + (n.customer_slug || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + customerNotes.length + " note" + (customerNotes.length === 1 ? "" : "s");

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("notes", "empty");
      return;
    }
    hideAllStatuses("notes");
    root.innerHTML = filtered.map(noteRowHtml).join("");
  }

  function noteRowHtml(n) {
    const overdue = isNoteReviewOverdue(n);
    const archived = n.active === false;
    const updatedMs = tsToMillis(n.updated_at) || tsToMillis(n.created_at);
    const reviewedMs = tsToMillis(n.last_reviewed_at);
    const updatedTxt  = updatedMs  ? new Date(updatedMs).toLocaleDateString() : "—";
    const reviewedTxt = reviewedMs ? new Date(reviewedMs).toLocaleDateString() : "(never)";

    const cls = "note-row" + (archived ? " is-archived" : "");
    const overdueChip = (overdue && !archived)
      ? '<span class="note-overdue">Review needed</span>'
      : "";

    return (
      '<div class="' + cls + '" role="listitem" data-id="' + escapeHtml(n.id) + '">' +
        '<div class="note-title-block">' +
          '<p class="note-title">' + escapeHtml(n.title || "(untitled)") +
            '<span class="note-cat-pill">' + escapeHtml(n.category || "Other") + '</span>' +
          '</p>' +
          '<span class="note-customer">' + escapeHtml(customerLabelForSlug(n.customer_slug)) + '</span>' +
        '</div>' +
        '<div class="note-meta">' +
          '<span class="note-meta-line">Updated ' + escapeHtml(updatedTxt) +
            (n.updated_by ? ' by ' + escapeHtml(n.updated_by) : '') +
          '</span>' +
          '<span class="note-meta-line">Last reviewed: ' + escapeHtml(reviewedTxt) + '</span>' +
          overdueChip +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="row-btn" type="button" data-action="edit-note">Edit</button>' +
          (archived
            ? '<button class="row-btn row-btn-reactivate" type="button" data-action="reactivate-note">Reactivate</button>'
            : '<button class="row-btn" type="button" data-action="archive-note">Archive</button>') +
        '</div>' +
      '</div>'
    );
  }

  function renderNotesReviewReminder() {
    const banner = $("notes-review-reminder");
    const badge  = $("notes-overdue-badge");
    if (!banner) return;
    const overdueCount = customerNotes.filter(isNoteReviewOverdue).length;
    if (overdueCount === 0) {
      banner.hidden = true;
      banner.textContent = "";
      if (badge) { badge.hidden = true; badge.textContent = "0"; }
      return;
    }
    banner.hidden = false;
    banner.textContent =
      "⏰ Review customer notes — " + overdueCount + " note" +
      (overdueCount === 1 ? "" : "s") +
      " haven't been reviewed in over 60 days. Filter by Status → Review overdue to see them.";
    if (badge) {
      badge.hidden = false;
      badge.textContent = overdueCount > 9 ? "9+" : String(overdueCount);
    }
  }

  function populateNoteCustomerSelects() {
    const inSelects = [
      $("note-edit-customer"),
      $("notes-filter-customer"),
      $("suggestions-filter-customer")
    ];
    const opts = getCustomers()
      .filter(function (c) { return getActive(c); })
      .sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
    inSelects.forEach(function (sel) {
      if (!sel) return;
      const isFilter = sel.id !== "note-edit-customer";
      const preserved = isFilter
        ? '<option value="all">All customers</option>'
        : '<option value="" disabled selected>— Pick a customer —</option>';
      sel.innerHTML = preserved + opts.map(function (c) {
        const slug = getCustomerSlug(c);
        return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(getCustomerName(c) + " (" + slug + ")") + '</option>';
      }).join("");
    });
  }

  async function loadCustomerNotes() {
    setStatus("notes", "loading");
    try {
      const snap = await firebase.firestore().collection("customer_notes").get();
      customerNotes = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customerNotes.sort(function (a, b) {
        return (tsToMillis(b.updated_at) || 0) - (tsToMillis(a.updated_at) || 0);
      });
      populateNoteCustomerSelects();
      renderNotesReviewReminder();
      applyCurrentNotesFilter();
    } catch (err) {
      console.error("loadCustomerNotes failed", err);
      setStatus("notes", "error",
        "Couldn't load customer notes: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the customer_notes block."
      );
    }
  }

  /* ---------- Note create/edit modal ---------- */

  function openNoteCreateModal(prefill) {
    const modal = $("note-edit-modal");
    if (!modal) return;
    modal.dataset.mode = "create";
    $("note-modal-title").textContent = "New customer note";

    populateNoteCustomerSelects();
    $("note-edit-id").value          = "";
    $("note-edit-customer").value    = (prefill && prefill.customer_slug) || "";
    $("note-edit-customer").disabled = false;
    $("note-edit-title").value       = (prefill && prefill.title) || "";
    $("note-edit-category").value    = (prefill && prefill.category) || "Other";
    $("note-edit-body").value        = (prefill && prefill.body) || "";
    $("note-edit-active").checked    = true;
    $("note-edit-review-due").value  = "";
    $("note-edit-meta-line").textContent = "";
    $("note-edit-mark-reviewed").hidden  = true;
    setModalError("note-edit-modal", "");
    setModalSaving("note-edit-modal", false);
    openModal("note-edit-modal");
  }

  function openNoteEditModal(note) {
    const modal = $("note-edit-modal");
    if (!modal) return;
    modal.dataset.mode = "edit";
    $("note-modal-title").textContent = "Edit customer note";

    populateNoteCustomerSelects();
    $("note-edit-id").value          = note.id;
    $("note-edit-customer").value    = note.customer_slug || "";
    $("note-edit-customer").disabled = true;   // locked in edit mode
    $("note-edit-title").value       = note.title || "";
    $("note-edit-category").value    = note.category || "Other";
    $("note-edit-body").value        = note.body || "";
    $("note-edit-active").checked    = note.active !== false;

    const dueMs = tsToMillis(note.review_due_at);
    $("note-edit-review-due").value = dueMs
      ? new Date(dueMs).toISOString().slice(0, 10)
      : "";

    const updMs  = tsToMillis(note.updated_at) || tsToMillis(note.created_at);
    const revMs  = tsToMillis(note.last_reviewed_at);
    const updTxt = updMs ? new Date(updMs).toLocaleString() : "—";
    const revTxt = revMs ? new Date(revMs).toLocaleString() : "(never)";
    $("note-edit-meta-line").textContent =
      "Created by " + (note.created_by || "—") +
      " · Updated " + updTxt + (note.updated_by ? " by " + note.updated_by : "") +
      " · Last reviewed " + revTxt + (note.last_reviewed_by ? " by " + note.last_reviewed_by : "");

    $("note-edit-mark-reviewed").hidden = false;
    setModalError("note-edit-modal", "");
    setModalSaving("note-edit-modal", false);
    openModal("note-edit-modal");
  }

  async function onNoteSave() {
    const modal = $("note-edit-modal");
    const mode  = modal && modal.dataset.mode || "create";
    const id    = $("note-edit-id").value.trim();
    const slug  = $("note-edit-customer").value.trim();
    const title = $("note-edit-title").value.trim();
    const body  = $("note-edit-body").value.trim();
    const cat   = $("note-edit-category").value.trim();
    const active = !!$("note-edit-active").checked;
    const reviewDueStr = $("note-edit-review-due").value.trim();

    if (!slug)  { setModalError("note-edit-modal", "Pick a customer first."); return; }
    if (!title) { setModalError("note-edit-modal", "Title is required."); return; }
    if (!body)  { setModalError("note-edit-modal", "Body is required."); return; }
    if (NOTE_CATEGORIES.indexOf(cat) < 0) {
      setModalError("note-edit-modal", "Pick a valid category."); return;
    }
    if (title.length > 120) { setModalError("note-edit-modal", "Title is too long (max 120)."); return; }
    if (body.length > 4000) { setModalError("note-edit-modal", "Body is too long (max 4000)."); return; }

    setModalSaving("note-edit-modal", true);
    setModalError("note-edit-modal", "");

    const db  = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const reviewDueAt = reviewDueStr
      ? firebase.firestore.Timestamp.fromDate(new Date(reviewDueStr + "T00:00:00Z"))
      : null;
    const adminEmail = getCurrentAdminEmail();

    try {
      if (mode === "create") {
        await db.collection("customer_notes").add({
          customer_slug:     slug,
          title:             title,
          body:              body,
          category:          cat,
          active:            active,
          review_due_at:     reviewDueAt,
          last_reviewed_at:  null,
          last_reviewed_by:  null,
          created_at:        sts,
          created_by:        adminEmail,
          updated_at:        sts,
          updated_by:        adminEmail
        });
        showToast("ok", "Note created.");
      } else {
        await db.collection("customer_notes").doc(id).update({
          title:         title,
          body:          body,
          category:      cat,
          active:        active,
          review_due_at: reviewDueAt,
          updated_at:    sts,
          updated_by:    adminEmail
        });
        showToast("ok", "Note saved.");
      }
      closeModal("note-edit-modal");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note save", modalId: "note-edit-modal" });
    } finally {
      setModalSaving("note-edit-modal", false);
    }
  }

  async function onNoteMarkReviewed() {
    const id = $("note-edit-id").value.trim();
    if (!id) return;
    const adminEmail = getCurrentAdminEmail();
    const db  = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await db.collection("customer_notes").doc(id).update({
        last_reviewed_at: sts,
        last_reviewed_by: adminEmail,
        updated_at:       sts,
        updated_by:       adminEmail
      });
      showToast("ok", "Marked reviewed.");
      closeModal("note-edit-modal");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note mark-reviewed", modalId: "note-edit-modal" });
    }
  }

  async function onNoteArchiveToggle(note) {
    const isArchiving = note.active !== false;
    const verb = isArchiving ? "Archive" : "Reactivate";
    if (!window.confirm(verb + ' "' + (note.title || "this note") + '"?')) return;
    const db  = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const adminEmail = getCurrentAdminEmail();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };
    try {
      await db.collection("customer_notes").doc(note.id).update(updates);
      showToast("ok", isArchiving ? "Note archived." : "Note reactivated.");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note archive" });
    }
  }

  function wireNotesControls() {
    const list = $("notes-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const note = customerNotes.find(function (x) { return x.id === row.dataset.id; });
        if (!note) return;
        if (btn.dataset.action === "edit-note")        openNoteEditModal(note);
        if (btn.dataset.action === "archive-note")     onNoteArchiveToggle(note);
        if (btn.dataset.action === "reactivate-note")  onNoteArchiveToggle(note);
      });
    }
    const open = $("note-create-open");
    if (open) open.addEventListener("click", function () { openNoteCreateModal(); });
    const save = $("note-edit-save");
    if (save) save.addEventListener("click", onNoteSave);
    const review = $("note-edit-mark-reviewed");
    if (review) review.addEventListener("click", onNoteMarkReviewed);

    ["notes-filter-customer", "notes-filter-category", "notes-filter-status"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentNotesFilter);
    });
    const search = $("notes-search");
    if (search) search.addEventListener("input", applyCurrentNotesFilter);
  }

  /* ====================================================================
     Note Suggestions — admin review queue
     ====================================================================
     Reads /customer_note_suggestions. Admin can Approve, Reject, or
     "Apply to note…" which pre-fills the note editor with the tech's
     text so the admin can curate the final wording before saving as a
     real note. Approving/rejecting only updates the suggestion doc.
     ==================================================================== */

  let noteSuggestions = [];

  function suggestionRowHtml(s) {
    const status = String(s.status || "pending").toLowerCase();
    const statusCls = status === "approved" ? "is-approved"
                    : status === "rejected" ? "is-rejected"
                    : "is-pending";
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    const createdMs = tsToMillis(s.created_at);
    const createdTxt = createdMs ? new Date(createdMs).toLocaleString() : "—";
    const isPending = status === "pending";

    const linkedNote = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;

    const customerLine = customerLabelForSlug(s.customer_slug) +
      (linkedNote ? " · note: " + (linkedNote.title || "(untitled)") : "");

    return (
      '<div class="suggestion-row" role="listitem" data-id="' + escapeHtml(s.id) + '">' +
        '<div>' +
          '<div class="suggestion-status-pill ' + statusCls + '">' + escapeHtml(statusLabel) + '</div>' +
          '<p class="suggestion-customer">' + escapeHtml(customerLine) + '</p>' +
          '<pre class="suggestion-body-preview">' + escapeHtml(s.suggested_change || "") + '</pre>' +
        '</div>' +
        '<div class="suggestion-meta">' +
          '<div>From: ' + escapeHtml(s.suggested_by_display_name || s.suggested_by || "(unknown)") + '</div>' +
          '<div>Submitted: ' + escapeHtml(createdTxt) + '</div>' +
          (s.reviewed_by
            ? '<div>Reviewed by ' + escapeHtml(s.reviewed_by) + '</div>'
            : '') +
        '</div>' +
        '<div class="row-actions">' +
          (isPending
            ? '<button class="row-btn" type="button" data-action="review-suggestion">Review</button>'
            : '<button class="row-btn" type="button" data-action="review-suggestion">View</button>') +
        '</div>' +
      '</div>'
    );
  }

  function applyCurrentSuggestionsFilter() {
    const root  = $("suggestions-list");
    const cnt   = $("suggestions-count");
    const badge = $("suggestions-pending-badge");
    if (!root) return;

    const stat  = ($("suggestions-filter-status")   && $("suggestions-filter-status").value)   || "pending";
    const cust  = ($("suggestions-filter-customer") && $("suggestions-filter-customer").value) || "all";

    const filtered = noteSuggestions.filter(function (s) {
      if (stat !== "all" && String(s.status || "pending") !== stat) return false;
      if (cust !== "all" && String(s.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + noteSuggestions.length + " suggestion" + (noteSuggestions.length === 1 ? "" : "s");

    const pendingCount = noteSuggestions.filter(function (s) { return String(s.status || "pending") === "pending"; }).length;
    if (badge) {
      if (pendingCount > 0) { badge.hidden = false; badge.textContent = pendingCount > 9 ? "9+" : String(pendingCount); }
      else                  { badge.hidden = true;  badge.textContent = "0"; }
    }

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("suggestions", "empty");
      return;
    }
    hideAllStatuses("suggestions");
    root.innerHTML = filtered.map(suggestionRowHtml).join("");
  }

  async function loadNoteSuggestions() {
    setStatus("suggestions", "loading");
    try {
      const snap = await firebase.firestore().collection("customer_note_suggestions").get();
      noteSuggestions = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      noteSuggestions.sort(function (a, b) {
        return (tsToMillis(b.created_at) || 0) - (tsToMillis(a.created_at) || 0);
      });
      applyCurrentSuggestionsFilter();
    } catch (err) {
      console.error("loadNoteSuggestions failed", err);
      setStatus("suggestions", "error",
        "Couldn't load suggestions: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the customer_note_suggestions block."
      );
    }
  }

  function openSuggestionReviewModal(s) {
    const modal = $("suggestion-review-modal");
    if (!modal) return;
    $("suggestion-review-id").value = s.id;
    $("suggestion-review-customer").textContent = customerLabelForSlug(s.customer_slug);
    $("suggestion-review-body").textContent = s.suggested_change || "";
    $("suggestion-review-notes").value = s.review_notes || "";

    const linkedNote = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;
    const existingBlock = $("suggestion-review-existing-block");
    if (linkedNote) {
      existingBlock.hidden = false;
      $("suggestion-review-existing-title").textContent = linkedNote.title || "(untitled)";
      $("suggestion-review-existing-body").textContent  = linkedNote.body || "";
    } else {
      existingBlock.hidden = true;
    }

    const createdMs = tsToMillis(s.created_at);
    const createdTxt = createdMs ? new Date(createdMs).toLocaleString() : "—";
    $("suggestion-review-meta").textContent =
      "Submitted by " + (s.suggested_by_display_name || s.suggested_by || "(unknown)") +
      " on " + createdTxt + " · status: " + (s.status || "pending");

    // Action visibility — Approve/Reject/Apply only on pending; closed
    // suggestions are read-only.
    const isPending = String(s.status || "pending") === "pending";
    $("suggestion-approve").hidden = !isPending;
    $("suggestion-reject").hidden  = !isPending;
    $("suggestion-apply-to-note").hidden = !isPending;

    setModalError("suggestion-review-modal", "");
    openModal("suggestion-review-modal");
  }

  async function setSuggestionStatus(id, newStatus) {
    const adminEmail = getCurrentAdminEmail();
    const db  = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const notes = $("suggestion-review-notes").value.trim();
    try {
      await db.collection("customer_note_suggestions").doc(id).update({
        status:        newStatus,
        reviewed_by:   adminEmail,
        reviewed_at:   sts,
        review_notes:  notes || null
      });
      showToast("ok", "Suggestion " + newStatus + ".");
      closeModal("suggestion-review-modal");
      await loadNoteSuggestions();
    } catch (err) {
      handleAdminWriteError(err, { context: "suggestion review", modalId: "suggestion-review-modal" });
    }
  }

  function onSuggestionApplyToNote() {
    const id = $("suggestion-review-id").value.trim();
    const s  = noteSuggestions.find(function (x) { return x.id === id; });
    if (!s) return;
    // Pre-fill the note editor. If the suggestion targets an existing
    // note, open Edit mode pre-loaded with the existing note + a
    // synthetic title/body merging in the suggested text. Admin curates
    // before saving. Mark the suggestion approved after the note saves
    // (admin does this separately by reopening this modal).
    closeModal("suggestion-review-modal");
    const existing = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;
    if (existing) {
      // Open edit mode for the existing note; pre-append tech's
      // suggestion to the body so admin can edit before saving.
      const merged = Object.assign({}, existing, {
        body: (existing.body || "") +
              "\n\n--- Suggested by " + (s.suggested_by || "tech") + " ---\n" +
              (s.suggested_change || "")
      });
      openNoteEditModal(merged);
      showToast("ok", "Suggestion text appended — edit + save the note, then reopen the suggestion to approve.");
    } else {
      // Brand-new note. Pre-fill with suggested text in the body.
      openNoteCreateModal({
        customer_slug: s.customer_slug,
        title:         "",
        body:          s.suggested_change || "",
        category:      "Other"
      });
      showToast("ok", "New-note form pre-filled — fill in the title, then save.");
    }
  }

  function wireSuggestionsControls() {
    const list = $("suggestions-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const s = noteSuggestions.find(function (x) { return x.id === row.dataset.id; });
        if (!s) return;
        if (btn.dataset.action === "review-suggestion") openSuggestionReviewModal(s);
      });
    }
    const approve = $("suggestion-approve");
    if (approve) approve.addEventListener("click", function () {
      const id = $("suggestion-review-id").value;
      if (id) setSuggestionStatus(id, "approved");
    });
    const reject = $("suggestion-reject");
    if (reject) reject.addEventListener("click", function () {
      const id = $("suggestion-review-id").value;
      if (id) setSuggestionStatus(id, "rejected");
    });
    const apply = $("suggestion-apply-to-note");
    if (apply) apply.addEventListener("click", onSuggestionApplyToNote);

    const refresh = $("suggestions-refresh");
    if (refresh) refresh.addEventListener("click", loadNoteSuggestions);

    ["suggestions-filter-status", "suggestions-filter-customer"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentSuggestionsFilter);
    });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.customerNotes = {
    init:    wireNotesControls,
    refresh: loadCustomerNotes
  };
  window.__pioneerAdmin.tabs.noteSuggestions = {
    init:    wireSuggestionsControls,
    refresh: loadNoteSuggestions
  };
}());
