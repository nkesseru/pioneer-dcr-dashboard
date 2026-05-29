/* Pioneer DCR Hub — Admin Admins tab (vanilla JS, no build).
 *
 * Admins module — runtime-editable allowlist (/admins/{email})
 *
 * The four hardcoded root admins in ALLOWED_ADMIN_EMAILS (utils) still
 * always have access (firestore.rules + verifyStaffOrReject() consult
 * them first). This panel manages OPERATIONAL admins added by a root
 * admin — without a code/rules redeploy.
 *
 * Server-side createAdminLoginV1 creates the Firebase Auth user AND
 * writes /admins/{email}. Edit and reactivate paths write directly to
 * Firestore (gated by isPioneerAdmin() in rules). Resend invite calls
 * sendPasswordResetV1.
 *
 * Phase 17 also relocates two cross-tab helpers that previously lived
 * in admin.js:
 *   • sendResetInviteFor — used by tech-row "Resend invite" + admin-row
 *     "Resend invite" buttons. Tech-row caller (wireWriteControls in
 *     admin.js) reaches it via window.__pioneerAdmin.tabs.admins.
 *   • promoteTechToAdmin — used by the tech-row "Promote to Admin"
 *     overflow action. Same dispatch pattern.
 *
 * Surface lives at window.__pioneerAdmin.tabs.admins:
 *   {
 *     init,                 // wireAdminsControls
 *     refresh,              // loadAdmins
 *     getAdmins,            // () => admins
 *     applyFilter,          // applyCurrentAdminsFilter
 *     openCreateModal,      // openAdminCreateModal
 *     openEditModal,        // openAdminEditModal(a)
 *     onSaveCreate,         // onAdminCreateSave
 *     onSaveEdit,           // onAdminEditSave
 *     promoteTechToAdmin,   // (tech) — tech-row promote-action dispatch target
 *     sendResetInviteFor    // (emailLower, feedbackEl) — tech-row + admin-row resend
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, formatTimestamp, isRootAdmin, ALLOWED_ADMIN_EMAILS,
 *     getTechName from __pioneerAdmin.utils
 *   • setStatus, hideAllStatuses, badge, openModal, closeModal,
 *     showToast from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, saving)
 *   • window.firebase compat SDK (auth + firestore)
 *   • window.CREATE_ADMIN_LOGIN_URL + window.SEND_PASSWORD_RESET_URL
 *     (firebase-config.js)
 *
 * promoteTechToAdmin also calls window.__pioneerAdmin.tabs.techs.applyFilter()
 * after success so the tech row's "Promote to Admin" button hides
 * without a full reload.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-admins.js: utils + shell modules must load first");
  }
  const {
    escapeHtml, formatTimestamp,
    isRootAdmin, ALLOWED_ADMIN_EMAILS,
    getTechName
  } = window.__pioneerAdmin.utils;
  const {
    setStatus, hideAllStatuses,
    badge,
    openModal, closeModal, showToast
  } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-admins: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCurrentAdminEmail  = () => depOrThrow("getCurrentAdminEmail")();
  const handleAdminWriteError = (err, opts) => depOrThrow("handleAdminWriteError")(err, opts);
  const setModalError         = (modalId, msg) => depOrThrow("setModalError")(modalId, msg);
  const setModalSaving        = (modalId, on) => depOrThrow("setModalSaving")(modalId, on);

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let admins = [];

  function getAdminDisplayName(a) {
    return a.display_name || a.email || a.id || "(unnamed)";
  }

  function adminCard(a) {
    const email     = a.email || a.id;
    const isRoot    = isRootAdmin(email);
    const active    = a.active !== false;
    const name      = getAdminDisplayName(a);
    const phone     = a.phone || "";
    const lastSent  = a.last_invite_sent_at || a.last_reset_sent_at;
    const lastSentTxt = lastSent ? formatTimestamp(lastSent) : "—";
    const createdBy = a.created_by || "—";

    const badges =
      (isRoot ? badge("is-on", "Root admin") : "") +
      (active ? badge("is-on", "Active") : badge("is-off", "Inactive"));

    const actionsHtml = isRoot
      ? '<span class="row-sub" style="font-size:11px;color:var(--pc-text-muted);">Managed in source (ALLOWED_ADMIN_EMAILS)</span>'
      : (
          '<button class="row-btn" type="button" data-action="resend"' +
            ' title="Send a fresh password-reset email to this admin">Resend invite</button>' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>'
        );

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(a.id || email) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">' + escapeHtml(name) + '</span>' +
          '<span class="row-sub">'  + escapeHtml(email) + '</span>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Phone</span>' + escapeHtml(phone || "—") +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Invite sent</span>' + escapeHtml(lastSentTxt) +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Added by</span>' + escapeHtml(createdBy) +
        '</div>' +
        '<div class="row-actions">' +
          '<div class="pill-badges">' + badges + '</div>' +
          actionsHtml +
        '</div>' +
      '</div>'
    );
  }

  function renderAdmins(list) {
    const root = $("admins-list");
    const cnt  = $("admins-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + " admin" + (list.length === 1 ? "" : "s");

    // Synthesize stub rows for the hardcoded root admins so the panel
    // shows the full picture (root + operational) without needing them
    // in Firestore. Stub `id` is "root:<email>" so it never collides
    // with a real /admins doc id.
    const rootStubs = ALLOWED_ADMIN_EMAILS.map(function (email) {
      return {
        id:           "root:" + email,
        email:        email,
        display_name: email.split("@")[0],
        active:       true,
        created_by:   "(hardcoded)"
      };
    });
    const firestoreEmails = new Set(list.map(function (a) { return (a.email || a.id || "").toLowerCase(); }));
    const filteredRootStubs = rootStubs.filter(function (s) {
      return !firestoreEmails.has(s.email.toLowerCase());
    });
    const combined = filteredRootStubs.concat(list);

    root.innerHTML = combined.map(adminCard).join("");
    if (list.length === 0) setStatus("admins", "empty");
    else hideAllStatuses("admins");
  }

  async function loadAdmins() {
    setStatus("admins", "loading");
    try {
      const snap = await firebase.firestore().collection("admins").get();
      admins = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      admins.sort(function (a, b) {
        return getAdminDisplayName(a).localeCompare(getAdminDisplayName(b));
      });
      applyCurrentAdminsFilter();
      // Tech cards consult `admins` to decide whether to show the
      // "Promote to Admin" button. Repaint techs whenever the admins
      // cache changes so the button disappears the moment a tech
      // becomes an admin (and reappears if they're deactivated).
      try { window.__pioneerAdmin.tabs.techs.applyFilter(); } catch (e) { /* tech panel may not be rendered yet */ }
    } catch (err) {
      console.error("loadAdmins failed", err);
      setStatus("admins", "error",
        "Couldn't load admins: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the admins block."
      );
    }
  }

  function applyCurrentAdminsFilter() {
    const q = (($("admins-search") && $("admins-search").value) || "").trim().toLowerCase();
    if (!q) return renderAdmins(admins);
    const filtered = admins.filter(function (a) {
      return (
        ((a.display_name || "") + " " + (a.email || a.id || "") + " " + (a.phone || ""))
          .toLowerCase().indexOf(q) >= 0
      );
    });
    renderAdmins(filtered);
  }

  /* ---------- Admin CREATE modal ---------- */

  function resetAdminCreateModal() {
    $("admin-create-display-name").value = "";
    $("admin-create-email").value        = "";
    $("admin-create-phone").value        = "";
    $("admin-create-active").checked     = true;
    $("admin-create-form-pane").hidden    = false;
    $("admin-create-success-pane").hidden = true;
    $("admin-create-reset-block").hidden  = true;
    $("admin-create-reset-link").value    = "";
    $("admin-create-save").hidden   = false;
    $("admin-create-cancel").hidden = false;
    $("admin-create-done").hidden   = true;
    setModalError("admin-create-modal", "");
    setModalSaving("admin-create-modal", false);
  }

  function openAdminCreateModal() {
    resetAdminCreateModal();
    openModal("admin-create-modal");
  }

  async function onAdminCreateSave() {
    const displayName = $("admin-create-display-name").value.trim();
    const emailRaw    = $("admin-create-email").value.trim();
    const email       = emailRaw.toLowerCase();
    const phone       = $("admin-create-phone").value.trim();
    const active      = !!$("admin-create-active").checked;

    if (!displayName) { setModalError("admin-create-modal", "Display name is required."); return; }
    if (!emailRaw)    { setModalError("admin-create-modal", "Email is required.");        return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      setModalError("admin-create-modal", "That doesn't look like a valid email address.");
      return;
    }

    const url = (window.CREATE_ADMIN_LOGIN_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      setModalError("admin-create-modal",
        "CREATE_ADMIN_LOGIN_URL is not configured in firebase-config.js. " +
        "Deploy the function and paste its URL into firebase-config.js.");
      return;
    }

    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (e) { /* swallowed */ }
    if (!idToken) {
      setModalError("admin-create-modal", "You appear to be signed out. Refresh and sign in again.");
      return;
    }

    setModalSaving("admin-create-modal", true);
    setModalError("admin-create-modal", "");

    let result = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({
          display_name: displayName,
          email:        email,
          phone:        phone,
          active:       active
        })
      });
      result = await res.json().catch(function () { return {}; });
      if (!res.ok || !result.ok) {
        console.error("createAdminLoginV1 returned an error", {
          http_status: res.status, server_body: result
        });
        const codeSuffix = (result && result.code) ? " [" + result.code + "]" : "";
        const msg = (result && result.error)
          ? (result.error + codeSuffix)
          : ("Server returned " + res.status + codeSuffix);
        setModalError("admin-create-modal", msg);
        setModalSaving("admin-create-modal", false);
        return;
      }
    } catch (err) {
      console.error("createAdminLoginV1 fetch failed", err);
      setModalError("admin-create-modal",
        "Couldn't reach the create-admin service. Check your connection and try again.");
      setModalSaving("admin-create-modal", false);
      return;
    }

    // Client-side trigger of the Firebase reset email so the new admin
    // actually receives it (server returned a backup link too).
    let clientResetEmailSent = false;
    try {
      await firebase.auth().sendPasswordResetEmail(email);
      clientResetEmailSent = true;
    } catch (err) {
      console.warn("sendPasswordResetEmail (client) failed for new admin", err && err.code);
    }

    // Refresh local admins cache so the new row appears immediately.
    try { await loadAdmins(); } catch (e) { /* non-fatal */ }

    // Paint the success pane.
    $("admin-create-form-pane").hidden    = true;
    $("admin-create-success-pane").hidden = false;
    $("admin-create-save").hidden         = true;
    $("admin-create-cancel").hidden       = true;
    $("admin-create-done").hidden         = false;

    $("admin-create-success-title").textContent =
      result.auth_user_created ? "Admin created." : "Admin login already existed — record updated.";
    $("admin-create-success-sub").textContent =
      "Email: " + (result.email || email);

    if (result.reset_link) {
      $("admin-create-reset-block").hidden = false;
      $("admin-create-reset-link").value   = result.reset_link;
    }

    const noteEl = $("admin-create-success-note");
    if (clientResetEmailSent && result.reset_link) {
      noteEl.textContent =
        "Firebase has emailed the new admin a password-reset link. The backup link above is yours to copy if needed.";
    } else if (clientResetEmailSent) {
      noteEl.textContent =
        "Firebase has emailed the new admin a password-reset link. (Backup-link generation failed server-side.)";
    } else if (result.reset_link) {
      noteEl.textContent =
        "Firebase didn't accept the email send from this browser — copy the backup link above and share it manually.";
    } else {
      noteEl.textContent =
        "Couldn't send a password-reset email AND no backup link is available. Use Resend invite to retry.";
    }

    setModalSaving("admin-create-modal", false);
  }

  /* ---------- Admin EDIT modal ---------- */

  function openAdminEditModal(a) {
    setModalError("admin-edit-modal", "");
    $("admin-edit-doc-id").value          = a.id || a.email;
    $("admin-edit-email").value           = a.email || a.id || "";
    $("admin-edit-display-name").value    = a.display_name || "";
    $("admin-edit-phone").value           = a.phone || "";
    $("admin-edit-active").checked        = a.active !== false;

    const lastSent = a.last_invite_sent_at || a.last_reset_sent_at;
    const bits = [];
    if (a.created_at)  bits.push("Added " + formatTimestamp(a.created_at));
    if (a.created_by)  bits.push("by " + a.created_by);
    if (lastSent)      bits.push("Last invite/reset " + formatTimestamp(lastSent));
    $("admin-edit-status-summary").textContent = bits.length ? bits.join(" · ") : "—";

    const feedback = $("admin-edit-resend-feedback");
    if (feedback) { feedback.hidden = true; feedback.textContent = ""; }

    openModal("admin-edit-modal");
  }

  async function onAdminEditSave() {
    const id           = $("admin-edit-doc-id").value;
    const displayName  = $("admin-edit-display-name").value.trim();
    const phone        = $("admin-edit-phone").value.trim();
    const active       = !!$("admin-edit-active").checked;

    if (!id) { setModalError("admin-edit-modal", "Missing doc ID."); return; }
    if (!displayName) { setModalError("admin-edit-modal", "Display name is required."); return; }

    setModalSaving("admin-edit-modal", true);
    setModalError("admin-edit-modal", "");

    try {
      await firebase.firestore().collection("admins").doc(id).update({
        display_name: displayName,
        phone:        phone,
        active:       active,
        updated_at:   firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:   getCurrentAdminEmail()
      });
      showToast("ok", "Admin updated.");
      closeModal("admin-edit-modal");
      await loadAdmins();
    } catch (err) {
      handleAdminWriteError(err, { context: "admin edit save", modalId: "admin-edit-modal" });
    } finally {
      setModalSaving("admin-edit-modal", false);
    }
  }

  /* ---------- Promote tech to admin ----------
   *
   * Triggered from the "Promote to Admin" button on a cleaning-tech row.
   * Confirms with the office, calls createAdminLoginV1 with the tech's
   * display_name/email/phone and provenance flags, fires the client-side
   * Firebase reset email for reliable delivery, and refreshes the
   * Admins tab. The cleaning_techs doc is NOT touched — the user keeps
   * both roles unless an admin later archives the tech.
   *
   * admin.js's wireWriteControls tech-row delegator dispatches the
   * "promote" action to this function via the tab namespace.
   */
  async function promoteTechToAdmin(tech) {
    const email = (tech.email || "").toLowerCase().trim();
    const name  = getTechName(tech) || email || "this tech";
    if (!email) {
      showToast("err", "Can't promote — this tech has no email on file.");
      return;
    }
    if (!window.confirm("Grant admin access to " + name + "?")) return;

    const url = (window.CREATE_ADMIN_LOGIN_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      showToast("err", "CREATE_ADMIN_LOGIN_URL isn't configured in firebase-config.js.");
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

    const techSlug = tech.tech_slug || tech.slug || tech.id || "";
    let result = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({
          display_name:        name,
          email:               email,
          phone:               tech.phone || "",
          active:              true,
          source:              "promoted_from_cleaning_tech",
          cleaning_tech_slug:  techSlug
        })
      });
      result = await res.json().catch(function () { return {}; });
      if (!res.ok || !result.ok) {
        console.error("promoteTechToAdmin: createAdminLoginV1 returned an error", {
          http_status: res.status, body: result
        });
        const msg = (result && result.error) || ("Server returned " + res.status);
        showToast("err", "Promote failed: " + msg);
        return;
      }
    } catch (err) {
      console.error("promoteTechToAdmin: fetch failed", err);
      showToast("err", "Couldn't reach the promote service.");
      return;
    }

    // Best-effort: fire the client-side Firebase reset email so the
    // promoted user actually receives the password-setup email (server
    // returned a backup link too).
    try { await firebase.auth().sendPasswordResetEmail(email); }
    catch (err) {
      console.warn("promoteTechToAdmin: client reset email failed (server-side link still available)",
        err && err.code);
    }

    showToast("ok",
      result.auth_user_created
        ? name + " promoted to admin. A password-setup email has been sent."
        : name + " promoted to admin. A password-reset email has been sent so they can sign in to /admin.");

    // Refresh both caches so the row repaints without the Promote
    // button and the Admins tab shows the new doc.
    try { await loadAdmins(); } catch (e) { /* non-fatal */ }
    try { window.__pioneerAdmin.tabs.techs.applyFilter(); } catch (e) { /* non-fatal */ }
  }

  /* ---------- Resend invite (admin row + tech row) ----------
   *
   * Calls sendPasswordResetV1. emailLower is the lowercased email of the
   * user receiving the reset. `feedbackEl` is an optional element to
   * display the inline message.
   *
   * Admin-context behavior (NOT anti-enumerated). The Forgot-password
   * flow on the public sign-in pages is anti-enumerated server-side —
   * that's where the security boundary matters. Here, an admin clicked
   * Resend on a known row and needs to know if the action actually
   * worked. Then we fire firebase.auth().sendPasswordResetEmail() from
   * the browser too — the Web SDK is what actually triggers the hosted
   * Firebase email.
   *
   * admin.js's wireWriteControls tech-row delegator dispatches the
   * "resend" action to this function via the tab namespace.
   */
  async function sendResetInviteFor(emailLower, feedbackEl) {
    const setFeedback = function (msg) {
      if (!feedbackEl) return;
      feedbackEl.hidden = false;
      feedbackEl.textContent = msg;
    };

    const url = (window.SEND_PASSWORD_RESET_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      const msg = "SEND_PASSWORD_RESET_URL isn't configured in firebase-config.js.";
      showToast("err", msg);
      setFeedback(msg);
      return { ok: false };
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (e) { /* swallowed */ }
    if (!idToken) {
      const msg = "You appear to be signed out. Refresh and sign in again.";
      showToast("err", msg);
      setFeedback(msg);
      return { ok: false };
    }

    setFeedback("Sending…");

    let body = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ email: emailLower })
      });
      body = await res.json().catch(function () { return {}; });

      if (!res.ok || !body.ok) {
        console.error("sendPasswordResetV1 returned an error", {
          http_status: res.status, body: body
        });
        const codeBit = (body && body.code) ? " [" + body.code + "]" : "";
        const msg = "Resend failed: " +
          ((body && body.error) || ("Server returned " + res.status)) + codeBit;
        showToast("err", msg);
        setFeedback(msg);
        return { ok: false, code: body && body.code, status: res.status };
      }

      if (body.sent === false) {
        const reason = body.reason || "unknown";
        const msg = "Invite skipped for " + emailLower +
          " (reason: " + reason + "). " +
          "If this keeps happening, the server-side createUser path may have changed — check Cloud Functions logs.";
        console.warn("sendPasswordResetV1 returned ok but sent:false", body);
        showToast("err", "Invite skipped — see admin row error chip.");
        setFeedback(msg);
        return { ok: false, code: "no_auth_user", status: 200 };
      }
    } catch (err) {
      console.error("sendPasswordResetV1 fetch failed", err);
      const msg = "Couldn't reach the resend service. Check your connection and try again.";
      showToast("err", msg);
      setFeedback(msg);
      return { ok: false, code: "network_error", status: 0 };
    }

    let clientEmailOk = false;
    let clientErrCode = "";
    try {
      await firebase.auth().sendPasswordResetEmail(emailLower);
      clientEmailOk = true;
    } catch (err) {
      clientErrCode = (err && err.code) || "unknown";
      console.warn("sendPasswordResetEmail (client) failed; server backup link is still available",
        clientErrCode, err && err.message);
    }

    if (clientEmailOk) {
      const verb = (body && body.created_auth_user)
        ? "Invite created — reset email sent to "
        : "Reset email sent to ";
      const msg = verb + emailLower +
        ". Tell them to check inbox + spam. Last-invite timestamp updated.";
      showToast("ok", msg);
      setFeedback(msg);
    } else {
      const backup = (body && body.reset_link) ? " A backup reset link is available — copy from the server response in DevTools and share manually." : "";
      const msg = "Server logged the resend, but the browser couldn't trigger the Firebase email (" +
        clientErrCode + ")." + backup;
      showToast("err", msg);
      setFeedback(msg);
      return { ok: false, code: "client_email_failed", reset_link: body && body.reset_link };
    }
    return { ok: true, reset_link: body && body.reset_link };
  }

  function wireAdminsControls() {
    const list = $("admins-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest(".admin-row");
        if (!row) return;
        const id = row.dataset.id;
        // Root stub rows have id "root:<email>" — skip (no actions on them).
        if (!id || id.indexOf("root:") === 0) return;
        const a = admins.find(function (x) { return x.id === id; });
        if (!a) return;
        if (btn.dataset.action === "edit")   openAdminEditModal(a);
        if (btn.dataset.action === "resend") sendResetInviteFor((a.email || a.id).toLowerCase(), null);
      });
    }

    const search = $("admins-search");
    if (search) search.addEventListener("input", applyCurrentAdminsFilter);

    const openBtn = $("admin-create-open");
    if (openBtn) openBtn.addEventListener("click", openAdminCreateModal);

    const saveCreateBtn = $("admin-create-save");
    if (saveCreateBtn) saveCreateBtn.addEventListener("click", onAdminCreateSave);

    const saveEditBtn = $("admin-edit-save");
    if (saveEditBtn) saveEditBtn.addEventListener("click", onAdminEditSave);

    const copyResetBtn = $("admin-create-copy-reset");
    if (copyResetBtn) {
      copyResetBtn.addEventListener("click", function () {
        const input = $("admin-create-reset-link");
        if (!input) return;
        input.select();
        try { document.execCommand("copy"); showToast("ok", "Reset link copied."); }
        catch (e) { showToast("err", "Couldn't copy — select the text manually."); }
      });
    }

    const resendBtn = $("admin-edit-resend");
    if (resendBtn) {
      resendBtn.addEventListener("click", async function () {
        const email = ($("admin-edit-email").value || "").toLowerCase().trim();
        if (!email) return;
        await sendResetInviteFor(email, $("admin-edit-resend-feedback"));
      });
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.admins = {
    init:               wireAdminsControls,
    refresh:            loadAdmins,
    getAdmins:          function () { return admins; },
    applyFilter:        applyCurrentAdminsFilter,
    openCreateModal:    openAdminCreateModal,
    openEditModal:      openAdminEditModal,
    onSaveCreate:       onAdminCreateSave,
    onSaveEdit:         onAdminEditSave,
    promoteTechToAdmin: promoteTechToAdmin,
    sendResetInviteFor: sendResetInviteFor
  };
}());
