/* Pioneer DCR Hub — Admin Cleaning Techs tab (vanilla JS, no build).
 *
 * Cleaning Techs tab — list / search / create / edit / archive / delete.
 *
 * Owns the techs array. Other modules read it via
 *   window.__pioneerAdmin.deps.getTechs()
 * which admin.js boot wires through to this module's getTechs().
 *
 * Phase 16a SCOPE (this file): list rendering, tech-EDIT modal,
 * tech-CREATE modal, assignment checklist sub-module, ARCHIVE
 * (Firestore + active-staff index + Cloud Function auth disable),
 * DELETE (Cloud Function), search filter.
 *
 * Phase 16b (NOT YET): tech-MEDIA modal (photo + signature upload to
 * Firebase Storage + uploadTechMediaV1 Cloud Function) — STAYS in
 * admin.js for now. wireWriteControls' tech-row "media" action dispatch
 * still calls admin.js's openTechMediaModal directly.
 *
 * Surface lives at window.__pioneerAdmin.tabs.techs:
 *   {
 *     init,             // wires assignment-checklist listeners once
 *     refresh,          // loadTechs
 *     getTechs,         // () => techs
 *     applyFilter,      // applyCurrentTechFilter
 *     openCreateModal,  // openTechCreateModal
 *     openEditModal,    // openTechEditModal(t)
 *     onSaveCreate,     // onTechCreateSave (tech-create-save button)
 *     onSaveEdit,       // onTechEditSave (tech-edit-save button)
 *     onArchive,        // onTechArchive(t)
 *     onDelete          // onTechDelete(t)
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js + admin/_budget.js
 * and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getTechName, getTechSlug, getActive, getDcrEnabled,
 *     getCustomerName, getCustomerSlug, formatTimestamp, isRootAdmin
 *     from __pioneerAdmin.utils
 *   • setStatus, hideAllStatuses, badge, activeBadge, dcrEnabledBadge,
 *     openModal, closeModal, showToast from __pioneerAdmin.shell
 *   • computeBudgetStats, budgetRowBadge, budgetTooltipText
 *     from __pioneerAdmin.budget
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCustomers()      — for assignment checklist
 *       - getDcrs()           — for per-tech budget stats
 *       - getAdmins()         — NEW (Phase 16a). For techCard's
 *                               Promote-to-Admin gating
 *       - loadAdmins()        — NEW (Phase 16a). For onTechDelete's
 *                               post-success refresh
 *       - refreshAttentionStrip() — NEW (Phase 16a). For loadTechs'
 *                                   post-load refresh
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, saving)
 *   • window.firebase compat SDK (auth + firestore)
 *   • window.CREATE_CLEANING_TECH_LOGIN_URL (firebase-config.js)
 *   • window.DELETE_CLEANING_TECH_URL (firebase-config.js)
 *   • window.SET_TECH_AUTH_DISABLED_URL (firebase-config.js)
 *
 * No closure deps on admin.js beyond the bridge.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils
      || !window.__pioneerAdmin.shell || !window.__pioneerAdmin.budget) {
    throw new Error("admin/tab-techs.js: utils + shell + budget modules must load first");
  }
  const {
    escapeHtml,
    getTechName, getTechSlug, getCustomerName, getCustomerSlug,
    getActive, getDcrEnabled,
    formatTimestamp,
    isRootAdmin
  } = window.__pioneerAdmin.utils;
  const {
    setStatus, hideAllStatuses,
    badge, activeBadge, dcrEnabledBadge,
    openModal, closeModal, showToast
  } = window.__pioneerAdmin.shell;
  const {
    computeBudgetStats, budgetRowBadge, budgetTooltipText
  } = window.__pioneerAdmin.budget;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-techs: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCustomers           = () => depOrThrow("getCustomers")();
  const getDcrs                = () => depOrThrow("getDcrs")();
  const getAdmins              = () => depOrThrow("getAdmins")();
  const loadAdmins             = () => depOrThrow("loadAdmins")();
  const refreshAttentionStrip  = () => depOrThrow("refreshAttentionStrip")();
  const getCurrentAdminEmail   = window.__pioneerAdmin.shell.getCurrentAdminEmail;
  const handleAdminWriteError  = window.__pioneerAdmin.shell.handleAdminWriteError;
  const setModalError          = window.__pioneerAdmin.shell.setModalError;
  const setModalSaving         = window.__pioneerAdmin.shell.setModalSaving;

  function $(id) { return document.getElementById(id); }

  // Local slugify — preserves the server-side slugifyForTech() shape.
  // admin.js still has its own slugifyForTech for the customer auto-slug
  // wireup; this is the tab-module's private copy for onTechCreateSave.
  function slugifyTechCandidate(s) {
    return String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  /* ---------- module state ---------- */

  let techs = [];
  let pendingTechAssigned       = new Set();
  let pendingTechCreateAssigned = new Set();

  /* ---------- list rendering ---------- */

  function techThumb(t) {
    const photo = (t.photoUrl || t.profilePhotoUrl || "").trim();
    if (photo) {
      return '<span class="tech-row-thumb" aria-hidden="true">' +
               '<img src="' + escapeHtml(photo) + '" alt="" loading="lazy" />' +
             '</span>';
    }
    const initial = (getTechName(t) || "P").charAt(0).toUpperCase();
    return '<span class="tech-row-thumb is-missing" aria-hidden="true">' +
             escapeHtml(initial) +
           '</span>';
  }

  function techCard(t) {
    const name    = getTechName(t) || "(unnamed tech)";
    const slug    = getTechSlug(t);
    const active  = getActive(t);
    const enabled = getDcrEnabled(t);

    const assigned    = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
    const assignedN   = assigned.length;
    const assignedTxt = assignedN === 0 ? "None" : (assignedN + (assignedN === 1 ? " customer" : " customers"));
    const needsAssign = active && assignedN === 0;

    // Per-tech on-budget summary. dcrs lives in tab-recent-dcrs.js;
    // read via bridge.
    const dcrs = getDcrs();
    const budgetStats     = computeBudgetStats(dcrs, { kind: "tech", slug: slug });
    const budgetBadgeHtml = budgetRowBadge(budgetStats);
    const budgetTooltip   = budgetTooltipText(budgetStats);

    const hasPhoto = !!(t.photoUrl || t.profilePhotoUrl);
    const hasSig   = !!t.signatureUrl;
    let assetChips = "";
    if (active && !hasPhoto) {
      assetChips +=
        '<span class="tech-row-asset-chip tech-row-asset-chip-bad"' +
              ' title="Customer-facing DCR emails show initials instead of a real photo. Required for the trust promise.">' +
          'No photo' +
        '</span>';
    }
    if (active && !hasSig) {
      assetChips +=
        '<span class="tech-row-asset-chip"' +
              ' title="Tech signature missing — signed receipt area in the DCR email collapses.">' +
          'No signature' +
        '</span>';
    }

    let badges;
    if (active) {
      badges =
        assetChips +
        activeBadge(true) +
        dcrEnabledBadge(enabled) +
        (needsAssign ? badge("is-warn", "Needs assignments") : "") +
        budgetBadgeHtml;
    } else {
      badges =
        badge("is-off", "Archived") +
        badge("is-warn", "Access removed") +
        badge("is-muted", "Historical records preserved");
    }

    const archiveLabel = active ? "Archive" : "Reactivate";

    const email     = (t.email || "").toLowerCase().trim();
    const lastSent  = t.inviteSentAt || t.last_invite_sent_at || t.last_reset_sent_at;
    const lastSentTxt = lastSent ? formatTimestamp(lastSent) : "—";
    const canResend = active && !!email;
    const hasBeenInvited = !!lastSent;
    const inviteBtnLabel = hasBeenInvited ? "Reinvite" : "Send invite";
    const inviteBtnTitle = hasBeenInvited
      ? "Send a fresh password-reset email to this tech (re-uses the existing Firebase Auth user)"
      : "Send the first invite to this tech (password-reset link the recipient can use to set up access)";
    const inviteStatus = String(t.inviteStatus || "").toLowerCase();
    const inviteLastError = String(t.inviteLastError || "").trim();

    // "Promote to Admin" gate — admins now lives in admin.js's Admins
    // section (still); read via the deps bridge.
    const admins = getAdmins();
    const alreadyAdmin = email
      ? (isRootAdmin(email) ||
         admins.some(function (a) {
           return (a.email || a.id || "").toLowerCase() === email && a.active !== false;
         }))
      : false;
    const canPromote = active && !!email && !alreadyAdmin;

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(t.id) + '">' +
        '<div class="row-primary" style="display:flex;align-items:center;gap:10px;">' +
          techThumb(t) +
          '<div>' +
            '<span class="row-name">' + escapeHtml(name) + '</span>' +
            '<span class="row-sub">'  + escapeHtml(slug || "—") + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Experience</span>' + escapeHtml(t.experience_level || "—") +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Assigned</span>' + escapeHtml(assignedTxt) +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Invite sent</span>' + escapeHtml(lastSentTxt) +
        '</div>' +
        '<div class="row-actions"' + (budgetTooltip ? ' title="' + escapeHtml(budgetTooltip) + '"' : '') + '>' +
          '<div class="pill-badges">' + badges + '</div>' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          '<button class="row-btn row-btn-secondary" type="button" data-action="media"' +
            ' title="Upload or change this tech\'s profile photo and signature">Media</button>' +
          (canResend
            ? '<button class="row-btn row-btn-secondary" type="button" data-action="resend"' +
                ' title="' + escapeHtml(inviteBtnTitle) + '">' +
                escapeHtml(inviteBtnLabel) +
              '</button>'
            : "") +
          (canResend && inviteStatus === "error"
            ? '<span class="tech-row-asset-chip tech-row-asset-chip-bad"' +
                ' title="' + escapeHtml(inviteLastError || "Last invite attempt failed") + '">' +
                'Invite errored' +
              '</span>'
            : "") +
          '<div class="row-overflow" data-overflow>' +
            '<button class="row-btn row-btn-more" type="button" data-action="more"' +
              ' aria-haspopup="menu" aria-expanded="false" aria-label="More actions">' +
              'More <span aria-hidden="true">▾</span>' +
            '</button>' +
            '<div class="row-overflow-menu" role="menu" hidden>' +
              (canPromote
                ? '<button class="row-overflow-item" role="menuitem" type="button" data-action="promote">Promote to Admin</button>'
                : "") +
              '<button class="row-overflow-item row-overflow-item-warn" role="menuitem" type="button"' +
                ' data-action="archive">' + escapeHtml(archiveLabel) + '</button>' +
              '<div class="row-overflow-item-sep" aria-hidden="true"></div>' +
              '<button class="row-overflow-item row-overflow-item-danger" role="menuitem" type="button"' +
                ' data-action="delete"' +
                ' title="Permanently delete this tech. Only works for techs with no DCRs / supply / issues history.">' +
                'Delete' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTechs(list) {
    const root = $("tech-list");
    const cnt  = $("tech-count");
    if (!root) return;
    if (cnt)  cnt.textContent = list.length + ' tech' + (list.length === 1 ? '' : 's');
    root.innerHTML = list.map(techCard).join("");
    if (list.length === 0 && techs.length === 0) setStatus("tech", "empty");
    else hideAllStatuses("tech");
  }

  async function loadTechs() {
    setStatus("tech", "loading");
    try {
      const snap = await firebase.firestore().collection("cleaning_techs").get();
      techs = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      techs.sort(function (a, b) {
        return getTechName(a).localeCompare(getTechName(b));
      });
      renderTechs(techs);
      // Refresh the admin attention strip (techs-with-no-assignments count
      // is part of it). admin.js owns that helper for now.
      try { refreshAttentionStrip(); } catch (_e) {}
    } catch (err) {
      console.error("loadTechs failed", err);
      setStatus("tech", "error",
        "Couldn't load cleaning techs: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /cleaning_techs."
      );
    }
  }

  function applyCurrentTechFilter() {
    const ts = $("tech-search");
    const q = ts ? ts.value.trim().toLowerCase() : "";
    if (!q) return renderTechs(techs);
    const filtered = techs.filter(function (t) {
      return (
        getTechName(t).toLowerCase().includes(q) ||
        getTechSlug(t).toLowerCase().includes(q)
      );
    });
    renderTechs(filtered);
  }

  /* ---------- assignment checklist (shared by tech-edit + tech-create) ---------- */

  function renderAssignmentChecklist(opts) {
    const listEl   = opts && opts.listEl;
    const searchEl = opts && opts.searchEl;
    const countEl  = opts && opts.countEl;
    const staging  = opts && opts.staging;
    if (!listEl || !staging) return;

    const q = (searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : "");
    const customers = getCustomers();
    const active = customers.filter(function (c) { return getActive(c); });

    const rows = active.filter(function (c) {
      if (!q) return true;
      return (
        getCustomerName(c).toLowerCase().includes(q) ||
        getCustomerSlug(c).toLowerCase().includes(q)
      );
    });

    if (rows.length === 0) {
      listEl.innerHTML =
        '<p class="tech-assignments-empty">' +
          (q ? "No customers match your search." : "No active customers to assign yet.") +
        '</p>';
    } else {
      listEl.innerHTML = rows.map(function (c) {
        const slug    = getCustomerSlug(c);
        const name    = getCustomerName(c) || "(unnamed customer)";
        const checked = staging.has(slug) ? " checked" : "";
        return (
          '<label class="tech-assignments-row" role="listitem" data-slug="' + escapeHtml(slug) + '">' +
            '<input type="checkbox" data-assign-slug="' + escapeHtml(slug) + '"' + checked + ' />' +
            '<span class="row-name">' + escapeHtml(name) + '</span>' +
            '<span class="row-slug">' + escapeHtml(slug) + '</span>' +
          '</label>'
        );
      }).join("");
    }

    if (countEl) {
      countEl.textContent =
        staging.size + " of " + active.length +
        (active.length === 1 ? " customer assigned" : " customers assigned");
    }
  }

  function renderTechAssignments() {
    renderAssignmentChecklist({
      listEl:   $("tech-assignments-list"),
      searchEl: $("tech-assignments-search"),
      countEl:  $("tech-assignments-count"),
      staging:  pendingTechAssigned
    });
  }

  function renderTechCreateAssignments() {
    renderAssignmentChecklist({
      listEl:   $("tech-create-assignments-list"),
      searchEl: $("tech-create-assignments-search"),
      countEl:  $("tech-create-assignments-count"),
      staging:  pendingTechCreateAssigned
    });
  }

  // Wires the search input + checkbox-toggle delegated listeners for
  // one assignment checklist (tech-edit OR tech-create). Idempotent —
  // called only by the tab's init() so duplicate wires are not possible.
  function wireAssignmentChecklistFor(searchId, listId, countId, getStaging, reRender) {
    const search  = $(searchId);
    const list    = $(listId);
    if (search) {
      search.addEventListener("input", function () {
        try { reRender(); }
        catch (err) { console.error("assignments re-render failed", err); }
      });
    }
    if (list) {
      list.addEventListener("change", function (ev) {
        const cb = ev.target.closest('input[type="checkbox"][data-assign-slug]');
        if (!cb) return;
        const slug = (cb.dataset.assignSlug || "").toLowerCase().trim();
        if (!slug) return;
        const staging = getStaging();
        if (cb.checked) staging.add(slug);
        else            staging.delete(slug);
        const countEl = $(countId);
        if (countEl) {
          const total = getCustomers().filter(function (c) { return getActive(c); }).length;
          countEl.textContent =
            staging.size + " of " + total +
            (total === 1 ? " customer assigned" : " customers assigned");
        }
      });
    }
  }

  /* ---------- tech EDIT modal ---------- */

  function openTechEditModal(t) {
    $("tech-edit-id").value             = t.id;
    $("tech-edit-display-name").value   = getTechName(t);
    $("tech-edit-email").value          = t.email || "";
    $("tech-edit-phone").value          = t.phone || "";
    $("tech-edit-active").checked       = getActive(t);
    $("tech-edit-dcr-enabled").checked  = getDcrEnabled(t);
    $("tech-edit-notes").value          = t.notes || "";
    setModalError("tech-edit-modal", "");

    pendingTechAssigned = new Set();
    const existing = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
    for (let i = 0; i < existing.length; i++) {
      const s = String(existing[i] || "").toLowerCase().trim();
      if (s) pendingTechAssigned.add(s);
    }

    try {
      const searchEl = $("tech-assignments-search");
      if (searchEl) searchEl.value = "";
      renderTechAssignments(t);
    } catch (err) {
      console.error("renderTechAssignments failed (modal still opening)", err);
      const listEl = $("tech-assignments-list");
      if (listEl) {
        listEl.innerHTML =
          '<p class="tech-assignments-empty">' +
            "Couldn't load the customer list. You can still save other fields." +
          '</p>';
      }
    }

    openModal("tech-edit-modal");
  }

  async function onTechEditSave() {
    const id = $("tech-edit-id").value;
    if (!id) return;
    const idx = techs.findIndex(function (x) { return x.id === id; });
    if (idx < 0) {
      setModalError("tech-edit-modal", "Couldn't find this tech in the local cache. Refresh the page and try again.");
      return;
    }

    const displayName = $("tech-edit-display-name").value.trim();
    if (!displayName) {
      setModalError("tech-edit-modal", "Display name is required.");
      return;
    }

    const assignedSlugs = Array.from(pendingTechAssigned).sort();

    const updates = {
      display_name:            displayName,
      email:                   $("tech-edit-email").value.trim(),
      phone:                   $("tech-edit-phone").value.trim(),
      active:                  $("tech-edit-active").checked,
      dcr_enabled:             $("tech-edit-dcr-enabled").checked,
      notes:                   $("tech-edit-notes").value.trim(),
      assigned_customer_slugs: assignedSlugs,
      updated_at:              firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:              getCurrentAdminEmail()
    };

    setModalSaving("tech-edit-modal", true);
    setModalError("tech-edit-modal", "");
    try {
      await firebase.firestore().collection("cleaning_techs").doc(id).update(updates);
      techs[idx] = Object.assign({}, techs[idx], updates, { updated_at: new Date() });
      applyCurrentTechFilter();
      closeModal("tech-edit-modal");
      showToast("ok", "Tech updated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "tech save", modalId: "tech-edit-modal" });
    } finally {
      setModalSaving("tech-edit-modal", false);
    }
  }

  /* ---------- tech CREATE modal ---------- */

  function resetTechCreateModal() {
    $("tech-create-display-name").value = "";
    $("tech-create-email").value        = "";
    $("tech-create-phone").value        = "";
    $("tech-create-slug").value         = "";
    const search = $("tech-create-assignments-search");
    if (search) search.value = "";
    pendingTechCreateAssigned = new Set();

    const tempRadio = $("tech-create-mode-temp");
    if (tempRadio) tempRadio.checked = true;

    $("tech-create-form-pane").hidden    = false;
    $("tech-create-success-pane").hidden = true;
    $("tech-create-reset-block").hidden  = true;
    $("tech-create-temp-block").hidden   = true;
    $("tech-create-reset-link").value    = "";
    $("tech-create-temp-password").value = "";

    $("tech-create-save").hidden   = false;
    $("tech-create-cancel").hidden = false;
    $("tech-create-done").hidden   = true;

    setModalError("tech-create-modal", "");
    setModalSaving("tech-create-modal", false);
  }

  function openTechCreateModal() {
    resetTechCreateModal();

    try {
      renderTechCreateAssignments();
    } catch (err) {
      console.error("renderTechCreateAssignments failed (modal still opening)", err);
      const listEl = $("tech-create-assignments-list");
      if (listEl) {
        listEl.innerHTML =
          '<p class="tech-assignments-empty">' +
            "Couldn't load the customer list. You can still create the login." +
          '</p>';
      }
    }

    openModal("tech-create-modal");
  }

  async function onTechCreateSave() {
    const displayName = $("tech-create-display-name").value.trim();
    const email       = $("tech-create-email").value.trim();
    const phone       = $("tech-create-phone").value.trim();
    let   slug        = $("tech-create-slug").value.trim().toLowerCase();
    const sendReset   = $("tech-create-mode-reset").checked;

    if (!displayName) { setModalError("tech-create-modal", "Display name is required."); return; }
    if (!email)       { setModalError("tech-create-modal", "Email is required.");        return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setModalError("tech-create-modal", "That doesn't look like a valid email address.");
      return;
    }
    if (!slug) slug = slugifyTechCandidate(displayName);
    if (!slug) { setModalError("tech-create-modal", "Couldn't derive a tech slug from the display name."); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setModalError("tech-create-modal", "Tech slug must be lowercase letters, digits, and dashes only.");
      return;
    }

    const url = (window.CREATE_CLEANING_TECH_LOGIN_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      setModalError("tech-create-modal",
        "CREATE_CLEANING_TECH_LOGIN_URL is not configured in firebase-config.js. " +
        "Deploy the function and paste its URL into firebase-config.js.");
      return;
    }

    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (e) { /* swallowed */ }
    if (!idToken) {
      setModalError("tech-create-modal", "You appear to be signed out. Refresh the page and sign in again.");
      return;
    }

    const body = {
      display_name:            displayName,
      email:                   email,
      phone:                   phone,
      tech_slug:               slug,
      assigned_customer_slugs: Array.from(pendingTechCreateAssigned).sort(),
      send_password_reset:     !!sendReset
    };

    setModalSaving("tech-create-modal", true);
    setModalError("tech-create-modal", "");

    let result = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify(body)
      });
      result = await res.json().catch(function () { return {}; });
      if (!res.ok || !result.ok) {
        console.error("createCleaningTechLoginV1 returned an error", {
          http_status:  res.status,
          server_code:  result && result.code,
          server_error: result && result.error,
          details:      result && result.details,
          full_body:    result
        });
        const detailParts = (result && Array.isArray(result.details))
          ? result.details.join(" · ") : null;
        const codeSuffix = (result && result.code) ? " [" + result.code + "]" : "";
        const msg = (result && result.error)
          ? (result.error + (
              codeSuffix && result.error.indexOf(result.code) >= 0 ? "" : codeSuffix
            ))
          : (detailParts || ("Server returned " + res.status + codeSuffix));
        setModalError("tech-create-modal", msg);
        setModalSaving("tech-create-modal", false);
        return;
      }
    } catch (err) {
      console.error("createCleaningTechLoginV1 fetch failed", err);
      setModalError("tech-create-modal",
        "Couldn't reach the create-login service. Check your connection and try again.");
      setModalSaving("tech-create-modal", false);
      return;
    }

    // ---- Success path ----
    let clientResetEmailSent = false;
    if (sendReset) {
      try {
        await firebase.auth().sendPasswordResetEmail(email);
        clientResetEmailSent = true;
      } catch (err) {
        console.warn("sendPasswordResetEmail (client) failed; admin can share the backup link",
          err && err.code, err && err.message);
      }
    }

    // Refresh local techs cache so the new row appears immediately.
    try {
      const docSnap = await firebase.firestore().collection("cleaning_techs").doc(result.tech_slug).get();
      if (docSnap.exists) {
        const fresh = Object.assign({ id: docSnap.id }, docSnap.data());
        const idx = techs.findIndex(function (x) { return x.id === fresh.id; });
        if (idx >= 0) techs[idx] = fresh;
        else techs.push(fresh);
        techs.sort(function (a, b) { return getTechName(a).localeCompare(getTechName(b)); });
        applyCurrentTechFilter();
      }
    } catch (err) {
      console.warn("Post-create techs refresh failed (UI may be stale until reload)", err);
    }

    // Paint the success pane.
    $("tech-create-form-pane").hidden    = true;
    $("tech-create-success-pane").hidden = false;
    $("tech-create-save").hidden         = true;
    $("tech-create-cancel").hidden       = true;
    $("tech-create-done").hidden         = false;

    $("tech-create-success-title").textContent =
      result.auth_user_created ? "Login created." : "Login already existed — tech updated.";

    const subEl = $("tech-create-success-sub");
    const subParts = [];
    subParts.push("Tech slug: " + result.tech_slug);
    subParts.push("Email: " + (result.email || email));
    subEl.textContent = subParts.join(" · ");

    if (sendReset) {
      $("tech-create-reset-block").hidden = false;
      $("tech-create-reset-link").value   = result.reset_link || "";
      const noteEl = $("tech-create-success-note");
      if (clientResetEmailSent && result.reset_link) {
        noteEl.textContent =
          "Firebase has emailed the tech a reset link. The backup link above is yours to copy if needed.";
      } else if (clientResetEmailSent && !result.reset_link) {
        noteEl.textContent =
          "Firebase has emailed the tech a reset link. (Backup-link generation failed server-side — tell the tech to check their inbox/spam.)";
      } else if (!clientResetEmailSent && result.reset_link) {
        noteEl.textContent =
          "Firebase didn't accept the email send from this browser — copy the backup link above and share it manually.";
      } else {
        noteEl.textContent =
          "We couldn't email the tech automatically AND the backup link generation failed. Use the Forgot password flow on the sign-in page as a fallback.";
      }
    } else if (result.temporary_password) {
      $("tech-create-temp-block").hidden = false;
      $("tech-create-temp-password").value = result.temporary_password;
      $("tech-create-success-note").textContent =
        "Share this password privately — we will not show it again. The tech should change it on first sign-in.";
    } else {
      $("tech-create-success-note").textContent =
        "This email already had a Firebase Auth login — we reused it and updated the cleaning_techs doc. " +
        "The tech's existing password is unchanged.";
    }

    showToast("ok", "Tech login ready.");
    setModalSaving("tech-create-modal", false);
  }

  /* ---------- archive-confirm DOM modal ----------
   * window.confirm() is auto-cancelled by Chrome automation tooling.
   * This is a real in-page dialog that returns a Promise<boolean>.
   */
  let _archiveModalEl       = null;
  let _archiveModalResolver = null;
  function ensureArchiveConfirmMarkup() {
    if (_archiveModalEl) return _archiveModalEl;
    const overlay = document.createElement("div");
    overlay.id = "tech-archive-confirm";
    overlay.className = "tech-archive-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "tech-archive-title");
    overlay.innerHTML =
      '<div class="tech-archive-backdrop" data-archive-close></div>' +
      '<div class="tech-archive-sheet">' +
        '<button type="button" class="tech-archive-close" data-archive-close aria-label="Cancel">×</button>' +
        '<h2 class="tech-archive-title" id="tech-archive-title">Archive team member?</h2>' +
        '<p class="tech-archive-lede">' +
          'This will remove PioneerOps access for this team member.' +
        '</p>' +
        '<ul class="tech-archive-bullets">' +
          '<li>They will be signed out of the app on next page load.</li>' +
          '<li>They will not be able to start work, submit DCRs, send SOS alerts, or reply to announcements.</li>' +
          '<li>Their historical records stay intact.</li>' +
          '<li>You can reactivate them later.</li>' +
        '</ul>' +
        '<div class="tech-archive-actions">' +
          '<button type="button" class="tech-archive-btn tech-archive-btn-cancel" data-archive-cancel>Cancel</button>' +
          '<button type="button" class="tech-archive-btn tech-archive-btn-confirm" data-archive-confirm>Archive team member</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (ev) {
      const t = ev.target;
      if (!t) return;
      if (t.closest("[data-archive-confirm]")) { resolveArchiveModal(true);  return; }
      if (t.closest("[data-archive-cancel]"))  { resolveArchiveModal(false); return; }
      if (t.closest("[data-archive-close]"))   { resolveArchiveModal(false); return; }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && _archiveModalEl && !_archiveModalEl.hidden) resolveArchiveModal(false);
    });
    _archiveModalEl = overlay;
    return overlay;
  }
  function resolveArchiveModal(result) {
    if (_archiveModalEl) _archiveModalEl.hidden = true;
    if (_archiveModalResolver) {
      const r = _archiveModalResolver;
      _archiveModalResolver = null;
      r(!!result);
    }
  }
  function openArchiveConfirmModal(name) {
    const overlay = ensureArchiveConfirmMarkup();
    const titleEl = document.getElementById("tech-archive-title");
    if (titleEl) titleEl.textContent = "Archive " + (name || "this team member") + "?";
    overlay.hidden = false;
    const cancel = overlay.querySelector("[data-archive-cancel]");
    if (cancel) setTimeout(function () { try { cancel.focus(); } catch (_e) {} }, 30);
    return new Promise(function (resolve) {
      _archiveModalResolver = resolve;
    });
  }

  /* ---------- archive / reactivate ---------- */

  async function callDisableAuthUserForTech(email) {
    const url = window.SET_TECH_AUTH_DISABLED_URL;
    if (!url) {
      console.warn("[archive] SET_TECH_AUTH_DISABLED_URL not configured — skipping auth revoke");
      return false;
    }
    const u = firebase.auth().currentUser;
    if (!u) return false;
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + idToken,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ email: email, disabled: true })
    });
    const body = await res.json().catch(function () { return {}; });
    return !!(res.ok && body && body.ok);
  }
  async function callEnableAuthUserForTech(email) {
    const url = window.SET_TECH_AUTH_DISABLED_URL;
    if (!url) return false;
    const u = firebase.auth().currentUser;
    if (!u) return false;
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + idToken,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ email: email, disabled: false })
    });
    const body = await res.json().catch(function () { return {}; });
    return !!(res.ok && body && body.ok);
  }

  async function onTechArchive(t) {
    const name        = getTechName(t) || t.id;
    const isArchiving = getActive(t);
    const email       = String(t.email || "").toLowerCase().trim();
    if (isArchiving) {
      const confirmed = await openArchiveConfirmModal(name);
      if (!confirmed) return;
    } else {
      if (!window.confirm(
        "Reactivate " + name + "?\n\n" +
        "They'll regain PioneerOps access (assuming dcr_enabled stays on)."
      )) return;
    }

    const adminEmail = getCurrentAdminEmail();
    const db = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };

    try {
      await db.collection("cleaning_techs").doc(t.id).update(updates);

      if (email) {
        const idxRef = db.collection("active_techs_by_email").doc(email);
        try {
          if (isArchiving) {
            await idxRef.set({
              active:      false,
              slug:        t.id,
              email:       email,
              archived_at: sts,
              archived_by: adminEmail
            }, { merge: true });
          } else {
            await idxRef.set({
              active:        true,
              slug:          t.id,
              email:         email,
              reactivated_at: sts,
              reactivated_by: adminEmail
            }, { merge: true });
          }
        } catch (idxErr) {
          console.warn("[archive] active_techs_by_email update failed (non-fatal)", idxErr);
        }
      }

      let authRevoked = false;
      if (isArchiving && email) {
        try {
          authRevoked = await callDisableAuthUserForTech(email);
        } catch (revokeErr) {
          console.warn("[archive] auth revoke failed (non-fatal — rules still deny)", revokeErr);
        }
      } else if (!isArchiving && email) {
        try {
          await callEnableAuthUserForTech(email);
        } catch (revokeErr) {
          console.warn("[reactivate] auth re-enable failed (non-fatal)", revokeErr);
        }
      }

      const idx = techs.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) {
        techs[idx] = Object.assign({}, techs[idx], updates, {
          updated_at:  new Date(),
          archived_at: isArchiving ? new Date() : null
        });
      }
      applyCurrentTechFilter();
      if (isArchiving) {
        showToast("ok",
          authRevoked
            ? "Team member archived and PioneerOps access removed."
            : "Team member archived. PioneerOps writes are now denied; their auth account is still enabled (configure SET_TECH_AUTH_DISABLED_URL to fully sign them out)."
        );
      } else {
        showToast("ok", "Team member reactivated — PioneerOps access restored.");
      }
    } catch (err) {
      handleAdminWriteError(err, { context: "tech archive" });
    }
  }

  /* ---------- HARD delete ---------- */

  async function onTechDelete(t) {
    const name = getTechName(t) || t.id;
    if (!window.confirm(
      "PERMANENTLY DELETE " + name + "?\n\n" +
      "This removes the cleaning_techs doc and disables the Firebase Auth user " +
      "(unless they're also an admin).\n\n" +
      "Only works if this tech has no DCRs, supply requests, issues, or notifications. " +
      "Otherwise you'll need to archive instead.\n\n" +
      "This action cannot be undone."
    )) return;

    const url = (window.DELETE_CLEANING_TECH_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      showToast("err", "DELETE_CLEANING_TECH_URL isn't configured in firebase-config.js.");
      return;
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (e) { /* swallowed */ }
    if (!idToken) {
      showToast("err", "You appear to be signed out. Refresh and sign in again.");
      return;
    }

    let result = null;
    let httpStatus = 0;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ tech_slug: t.id })
      });
      httpStatus = res.status;
      result = await res.json().catch(function () { return {}; });
    } catch (err) {
      console.error("deleteCleaningTechV1 fetch failed", err);
      showToast("err", "Couldn't reach the delete service. Check your connection and try again.");
      return;
    }

    if (httpStatus === 409 && result && result.blocked) {
      const reasons = Array.isArray(result.reasons) ? result.reasons.join(", ") : "linked records";
      window.alert(
        "Cannot permanently delete — archive instead.\n\n" +
        name + " has linked records in: " + reasons + "."
      );
      showToast("err", "Delete blocked — archive instead. Linked: " + reasons + ".");
      return;
    }

    if (httpStatus !== 200 || !result || !result.ok) {
      console.error("deleteCleaningTechV1 returned an error", { status: httpStatus, body: result });
      const codeBit = (result && result.code) ? " [" + result.code + "]" : "";
      const msg = (result && result.error) || ("Server returned " + httpStatus + codeBit);
      showToast("err", "Delete failed: " + msg);
      return;
    }

    // ---- Success path ----
    techs = techs.filter(function (x) { return x.id !== t.id; });
    applyCurrentTechFilter();
    // admin doc might have cleaning_tech_slug cleared on the matching admin
    // doc — refresh via the bridge.
    try { await loadAdmins(); } catch (e) { /* non-fatal */ }

    const bits = [];
    bits.push("Cleaning tech " + name + " deleted.");
    if (result.is_also_admin) {
      bits.push("Firebase Auth user PRESERVED (still admin).");
    } else if (result.auth_user_disabled) {
      bits.push("Firebase Auth user disabled.");
    } else if (result.auth_user_disable_err) {
      bits.push("Auth user disable failed (" + result.auth_user_disable_err + ") — disable manually in Firebase Console.");
    }
    if (result.admin_doc_cleared) {
      bits.push("Cleared cleaning_tech_slug on the matching admin doc.");
    }
    showToast("ok", bits.join(" "));
  }

  /* ---------- media-modal cache patch helper ----------
   * Called by admin.js's still-resident tech-media modal flow
   * (Phase 16b) after a successful photo/signature upload to patch
   * the in-memory tech doc + repaint that row inline without losing
   * other admin state. Returns the patched tech (or null if not
   * found). Admin.js then calls its local paintTechMediaModal +
   * refreshAttentionStrip itself.
   */
  function applyPatch(techId, patch) {
    const idx = techs.findIndex(function (t) { return t.id === techId; });
    if (idx < 0) return null;
    techs[idx] = Object.assign({}, techs[idx], patch);
    const row = document.querySelector('#tech-list [data-id="' + String(techId).replace(/(["\\])/g, "\\$1") + '"]');
    if (row && row.parentElement) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = techCard(techs[idx]).trim();
      const next = wrapper.firstElementChild;
      if (next) row.parentElement.replaceChild(next, row);
    }
    return techs[idx];
  }

  /* ---------- Tech photo / signature manager (tech-media-modal) ----------
   * Phase 16b extraction. Calls uploadTechMediaV1 with a Firebase admin
   * ID token. The modal is wired once on first open; subsequent opens
   * just repopulate state from the latest `techs` cache entry.
   *
   * Per the spec:
   *   - Real photo is required for the customer-facing DCR trust
   *     promise; the initials bubble is an emergency fallback only.
   *   - Missing photo / signature is flagged in the modal and on the
   *     tech row chip.
   *
   * On every successful upload/clear/active flip, patchTechCacheAndRepaint
   * applies the patch to the local cache, repaints the modal, and asks
   * admin.js (via the deps bridge) to refresh the attention strip.
   */
  let _techMediaWired = false;
  let _techMediaCurrentId = null;

  function openTechMediaModal(t) {
    if (!t || !t.id) return;
    _techMediaCurrentId = t.id;
    const idInput = $("tech-media-id");
    if (idInput) idInput.value = t.id;

    wireTechMediaModalOnce();
    paintTechMediaModal(t);
    openModal("tech-media-modal");
  }

  function paintTechMediaModal(t) {
    const photoUrl = (t.photoUrl || t.profilePhotoUrl || "").trim();
    const sigUrl   = (t.signatureUrl || "").trim();
    const name     = getTechName(t) || "Your Pioneer tech";
    const initial  = (name || "P").charAt(0).toUpperCase();

    // ---- Photo zone ----
    const photoImg     = $("tech-media-photo-img");
    const photoInitial = $("tech-media-photo-initial");
    const photoMeta    = $("tech-media-photo-meta");
    const photoClear   = $("tech-media-photo-clear");
    if (photoImg && photoInitial) {
      if (photoUrl) {
        photoImg.src    = photoUrl;
        photoImg.hidden = false;
        photoInitial.hidden = true;
      } else {
        photoImg.removeAttribute("src");
        photoImg.hidden = true;
        photoInitial.textContent = initial;
        photoInitial.hidden = false;
      }
    }
    if (photoMeta) {
      photoMeta.textContent = photoUrl
        ? ("On file" + (t.photoSizeBytes ? (" · " + Math.round(t.photoSizeBytes / 1024) + " KB") : ""))
        : "No photo on file";
    }
    if (photoClear) photoClear.hidden = !photoUrl;

    // ---- Signature zone ----
    const sigImg   = $("tech-media-sig-img");
    const sigEmpty = $("tech-media-sig-empty");
    const sigMeta  = $("tech-media-sig-meta");
    const sigClear = $("tech-media-sig-clear");
    if (sigImg && sigEmpty) {
      if (sigUrl) {
        sigImg.src    = sigUrl;
        sigImg.hidden = false;
        sigEmpty.hidden = true;
      } else {
        sigImg.removeAttribute("src");
        sigImg.hidden = true;
        sigEmpty.hidden = false;
      }
    }
    if (sigMeta) {
      sigMeta.textContent = sigUrl
        ? ("On file" + (t.signatureSizeBytes ? (" · " + Math.round(t.signatureSizeBytes / 1024) + " KB") : ""))
        : "No signature on file";
    }
    if (sigClear) sigClear.hidden = !sigUrl;

    // ---- Active checkbox ----
    const activeEl = $("tech-media-active");
    if (activeEl) activeEl.checked = getActive(t);

    // ---- Warning strip ----
    const warnEl = $("tech-media-warnings");
    if (warnEl) {
      const missing = [];
      if (!photoUrl) missing.push("photo");
      if (!sigUrl)   missing.push("signature");
      if (missing.length === 0) {
        warnEl.hidden = true;
        warnEl.innerHTML = "";
      } else {
        warnEl.hidden = false;
        warnEl.innerHTML =
          '<strong>Heads up:</strong> this tech is missing a ' +
          missing.join(" and a ") +
          '. The DCR email will fall back to ' +
          (missing.indexOf("photo")     >= 0 ? 'an initials bubble' : '') +
          (missing.length === 2         ?     ' and ' : '') +
          (missing.indexOf("signature") >= 0 ? 'no signed-receipt area' : '') +
          '.';
      }
    }

    // ---- Customer-facing preview card ----
    const cName = $("tech-media-cust-name");
    if (cName) cName.textContent = name;
    const cSub  = $("tech-media-cust-sub");
    if (cSub) cSub.textContent = getActive(t)
      ? "regular Pioneer tech"
      : "tech is currently archived";

    const cPhotoImg     = $("tech-media-cust-photo-img");
    const cPhotoInitial = $("tech-media-cust-photo-initial");
    if (cPhotoImg && cPhotoInitial) {
      if (photoUrl) {
        cPhotoImg.src = photoUrl;
        cPhotoImg.hidden = false;
        cPhotoInitial.hidden = true;
      } else {
        cPhotoImg.removeAttribute("src");
        cPhotoImg.hidden = true;
        cPhotoInitial.textContent = initial;
        cPhotoInitial.hidden = false;
      }
    }
    const cSigImg   = $("tech-media-cust-sig-img");
    const cSigEmpty = $("tech-media-cust-sig-empty");
    if (cSigImg && cSigEmpty) {
      if (sigUrl) {
        cSigImg.src = sigUrl;
        cSigImg.hidden = false;
        cSigEmpty.hidden = true;
      } else {
        cSigImg.removeAttribute("src");
        cSigImg.hidden = true;
        cSigEmpty.hidden = false;
      }
    }
  }

  function wireTechMediaModalOnce() {
    if (_techMediaWired) return;
    _techMediaWired = true;

    // File inputs: read as base64, post to uploadTechMediaV1.
    const photoFile = $("tech-media-photo-file");
    if (photoFile) {
      photoFile.addEventListener("change", function () {
        const file = photoFile.files && photoFile.files[0];
        photoFile.value = "";                              // allow re-picking same file
        if (file) handleTechMediaUpload("photo", file);
      });
    }
    const sigFile = $("tech-media-sig-file");
    if (sigFile) {
      sigFile.addEventListener("change", function () {
        const file = sigFile.files && sigFile.files[0];
        sigFile.value = "";
        if (file) handleTechMediaUpload("signature", file);
      });
    }

    // Clear buttons.
    const photoClear = $("tech-media-photo-clear");
    if (photoClear) photoClear.addEventListener("click", function () {
      handleTechMediaClear("photo");
    });
    const sigClear = $("tech-media-sig-clear");
    if (sigClear) sigClear.addEventListener("click", function () {
      handleTechMediaClear("signature");
    });

    // Active toggle.
    const activeEl = $("tech-media-active");
    if (activeEl) activeEl.addEventListener("change", function () {
      handleTechMediaActiveFlip(activeEl.checked);
    });
  }

  // ---- Helpers shared by all media operations ----

  async function getAdminIdToken() {
    try {
      const u = firebase.auth().currentUser;
      if (u) return await u.getIdToken();
    } catch (_e) { /* swallow */ }
    return null;
  }

  function setTechMediaZoneError(kind, msg) {
    const errEl = $(kind === "photo" ? "tech-media-photo-error" : "tech-media-sig-error");
    if (!errEl) return;
    if (msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
    } else {
      errEl.textContent = "";
      errEl.hidden = true;
    }
  }
  function setTechMediaZoneProgress(kind, on) {
    const el = $(kind === "photo" ? "tech-media-photo-progress" : "tech-media-sig-progress");
    if (el) el.hidden = !on;
  }

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () {
        const dataUrl = String(fr.result || "");
        const idx     = dataUrl.indexOf(",");
        resolve({
          base64:      idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl,
          contentType: file.type || "image/jpeg",
          filename:    file.name || "upload"
        });
      };
      fr.onerror = function () { reject(fr.error || new Error("read failed")); };
      fr.readAsDataURL(file);
    });
  }

  // After every successful op, patch the local techs cache + repaint
  // the modal + the techs list row (so the thumbnail and chips refresh
  // without a full Firestore re-read). Internal — same-IIFE call to
  // applyPatch.
  function patchTechCacheAndRepaint(techId, patch) {
    const updated = applyPatch(techId, patch);
    if (!updated) return null;
    paintTechMediaModal(updated);
    // Refresh the admin attention strip — its needs-assign count + media
    // chip totals can change. admin.js owns that helper.
    try { refreshAttentionStrip(); } catch (_e) {}
    return updated;
  }

  async function handleTechMediaUpload(kind, file) {
    const techId = _techMediaCurrentId;
    if (!techId) return;
    setTechMediaZoneError(kind, "");

    if (!/^image\//i.test(file.type)) {
      setTechMediaZoneError(kind, "Please pick an image file.");
      return;
    }
    const maxBytes = kind === "photo" ? 5 * 1024 * 1024 : 1 * 1024 * 1024;
    if (file.size > maxBytes) {
      setTechMediaZoneError(kind, file.name + " is over " +
        Math.round(maxBytes / 1024 / 1024) + "MB.");
      return;
    }

    const url = (window.UPLOAD_TECH_MEDIA_URL || "").trim();
    if (!url) {
      setTechMediaZoneError(kind, "UPLOAD_TECH_MEDIA_URL not configured.");
      return;
    }
    const idToken = await getAdminIdToken();
    if (!idToken) {
      setTechMediaZoneError(kind, "You appear to be signed out. Refresh and sign in again.");
      return;
    }

    setTechMediaZoneProgress(kind, true);

    let payload;
    try {
      payload = await readFileAsBase64(file);
    } catch (e) {
      setTechMediaZoneProgress(kind, false);
      setTechMediaZoneError(kind, "Could not read the file.");
      return;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({
          techId:      techId,
          kind:        kind,
          filename:    payload.filename,
          contentType: payload.contentType,
          base64:      payload.base64
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        const err = (data && data.error) || ("HTTP " + res.status);
        setTechMediaZoneError(kind, err);
        return;
      }
      const patch = kind === "photo"
        ? {
            photoUrl:         data.url,
            profilePhotoUrl:  data.url,
            photoStoragePath: data.storagePath,
            photoSizeBytes:   data.size
          }
        : {
            signatureUrl:         data.url,
            signatureStoragePath: data.storagePath,
            signatureSizeBytes:   data.size
          };
      patchTechCacheAndRepaint(techId, patch);
    } catch (e) {
      setTechMediaZoneError(kind, String(e && e.message || e));
    } finally {
      setTechMediaZoneProgress(kind, false);
    }
  }

  async function handleTechMediaClear(kind) {
    const techId = _techMediaCurrentId;
    if (!techId) return;
    setTechMediaZoneError(kind, "");

    const label = kind === "photo" ? "profile photo" : "signature";
    if (!window.confirm(
      "Remove this tech's " + label + "?\n\n" +
      (kind === "photo"
        ? "The DCR email will fall back to an initials bubble until a new photo is uploaded."
        : "The DCR email signed-receipt area will collapse until a new signature is uploaded.")
    )) return;

    const url = (window.UPLOAD_TECH_MEDIA_URL || "").trim();
    if (!url) return setTechMediaZoneError(kind, "UPLOAD_TECH_MEDIA_URL not configured.");
    const idToken = await getAdminIdToken();
    if (!idToken) return setTechMediaZoneError(kind, "Signed out — refresh and sign in again.");

    setTechMediaZoneProgress(kind, true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ techId: techId, kind: kind, clear: true })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        setTechMediaZoneError(kind, (data && data.error) || ("HTTP " + res.status));
        return;
      }
      const patch = kind === "photo"
        ? { photoUrl: null, profilePhotoUrl: null, photoStoragePath: null, photoSizeBytes: null }
        : { signatureUrl: null, signatureStoragePath: null, signatureSizeBytes: null };
      patchTechCacheAndRepaint(techId, patch);
    } catch (e) {
      setTechMediaZoneError(kind, String(e && e.message || e));
    } finally {
      setTechMediaZoneProgress(kind, false);
    }
  }

  async function handleTechMediaActiveFlip(nextActive) {
    const techId = _techMediaCurrentId;
    if (!techId) return;
    const progressEl = $("tech-media-active-progress");
    if (progressEl) progressEl.hidden = false;

    const url = (window.UPLOAD_TECH_MEDIA_URL || "").trim();
    const idToken = await getAdminIdToken();
    if (!url || !idToken) {
      if (progressEl) progressEl.hidden = true;
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ techId: techId, action: "setActive", active: !!nextActive })
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        patchTechCacheAndRepaint(techId, { active: !!nextActive });
      } else {
        // Revert the checkbox visually so it reflects reality.
        const activeEl = $("tech-media-active");
        if (activeEl) activeEl.checked = !nextActive;
        const errEl = $("tech-media-err");
        if (errEl) {
          errEl.textContent = (data && data.error) || ("HTTP " + res.status);
          errEl.hidden = false;
        }
      }
    } catch (e) {
      const activeEl = $("tech-media-active");
      if (activeEl) activeEl.checked = !nextActive;
      const errEl = $("tech-media-err");
      if (errEl) { errEl.textContent = String(e && e.message || e); errEl.hidden = false; }
    } finally {
      if (progressEl) progressEl.hidden = true;
    }
  }

  /* ---------- init: wires the assignment checklists ---------- */

  function init() {
    wireAssignmentChecklistFor(
      "tech-assignments-search",
      "tech-assignments-list",
      "tech-assignments-count",
      function () { return pendingTechAssigned; },
      renderTechAssignments
    );
    wireAssignmentChecklistFor(
      "tech-create-assignments-search",
      "tech-create-assignments-list",
      "tech-create-assignments-count",
      function () { return pendingTechCreateAssigned; },
      renderTechCreateAssignments
    );
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.techs = {
    init:            init,
    refresh:         loadTechs,
    getTechs:        function () { return techs; },
    applyFilter:     applyCurrentTechFilter,
    openCreateModal: openTechCreateModal,
    openEditModal:   openTechEditModal,
    onSaveCreate:    onTechCreateSave,
    onSaveEdit:      onTechEditSave,
    onArchive:       onTechArchive,
    onDelete:        onTechDelete,
    openMediaModal:  openTechMediaModal,
    applyPatch:      applyPatch
  };
}());
