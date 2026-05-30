/* Pioneer DCR Hub — Admin Announcements tab (vanilla JS, no build).
 *
 * Announcements (v1) — admin CRUD over the `announcements` collection.
 * Admins compose / edit / archive. Staff read via Pioneer Team Hub
 * (team-hub.js handles the staff side + the mandatory-modal pop).
 * Reads are tracked in announcement_reads keyed
 * `{announcementId}_{uid}`.
 *
 * Architecture:
 *   • One Firestore root collection `announcements`.
 *   • Two subcollections per doc: `recipient_status` (per-user state)
 *     and `comments` (thread).
 *   • One Firebase Storage path: `announcements/{id}/attachments/{filename}`.
 *
 * Phase 20 also fixes a latent bug: the recipient picker and several
 * inline helpers previously referenced a bare `techs` array that
 * stopped existing in admin.js's IIFE scope when Phase 16a moved
 * `techs` into tab-techs.js. The `(techs || [])` pattern would have
 * thrown a strict-mode ReferenceError on first read; in practice the
 * recipient picker would have been silently broken (no rows). Every
 * caller now resolves `techs` through `getTechs()` (deps bridge),
 * which always returns an array.
 *
 * Surface lives at window.__pioneerAdmin.tabs.announcements:
 *   {
 *     init,             // wireAnnouncementsControls — DOM event wiring
 *     refresh,          // loadAnnouncements — Firestore reload + repaint
 *     getAnnouncements, // () => announcements
 *     applyFilter,      // applyCurrentAnnouncementsFilter — search box filter
 *     openCreateModal,  // openAnnouncementCreateModal
 *     openEditModal,    // openAnnouncementEditModal(a)
 *     onSave,           // onAnnouncementSave
 *     onArchive         // onAnnouncementArchive(a)
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, cssEsc, tsToMs, formatImprovementDate, getTechName
 *     from __pioneerAdmin.utils
 *   • setStatus, hideAllStatuses, badge, openModal, closeModal,
 *     showToast from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getTechs()
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, on)
 *   • window.firebase compat SDK (auth + firestore + storage)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-announcements.js: utils + shell modules must load first");
  }
  const {
    escapeHtml, cssEsc, tsToMs,
    formatImprovementDate, getTechName
  } = window.__pioneerAdmin.utils;
  const {
    setStatus, hideAllStatuses,
    badge,
    openModal, closeModal, showToast
  } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-announcements: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getTechs              = () => depOrThrow("getTechs")();
  const getCurrentAdminEmail  = () => depOrThrow("getCurrentAdminEmail")();
  const handleAdminWriteError = (err, opts) => depOrThrow("handleAdminWriteError")(err, opts);
  const setModalError         = (modalId, msg) => depOrThrow("setModalError")(modalId, msg);
  const setModalSaving        = (modalId, on) => depOrThrow("setModalSaving")(modalId, on);

  function $(id) { return document.getElementById(id); }

  // Tolerant timestamp reader (Firestore Timestamp / ISO string /
  // number-ms / Date / { seconds }). Used only by tsToLocalInputValue
  // below. Carried in from admin.js's Phase-18 temporary `supplyTsToMs`
  // (which is now retired since this was its sole caller).
  function _tsToMillis(ts) {
    if (!ts) return null;
    if (typeof ts === "number")              return ts;
    if (typeof ts === "string")              { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function")   return ts.toMillis();
    if (typeof ts.seconds === "number")      return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  /* ---------- constants ---------- */

  const ANNOUNCEMENT_PRIORITIES = ["normal", "important", "urgent"];
  const ANNOUNCEMENT_PRIORITY_LABELS = {
    normal:    "Normal",
    important: "Important",
    urgent:    "Urgent"
  };
  const ANNOUNCEMENT_PRIORITY_BADGE_CLS = {
    normal:    "is-neutral",
    important: "is-warn",
    urgent:    "is-err"
  };

  // Allowed `attachment_type` values stored on the doc. Empty string is
  // also valid (means "no type specified"). Keep in sync with the
  // <select> options in admin.html and any reader that buckets/icons by
  // type.
  const ANNOUNCEMENT_ATTACHMENT_TYPES = ["pdf", "image", "schedule", "safety", "other"];

  // Whitelisted upload content types (mirrors storage.rules; client-side
  // check is for UX — Storage rules are the security boundary).
  const ATTACHMENT_ALLOWED_MIME = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ];
  // Extension fallback when contentType comes back as empty/octet-stream
  // (some browsers do this for DOCX). Match by lowercased extension.
  const ATTACHMENT_ALLOWED_EXT = ["pdf", "png", "jpg", "jpeg", "webp", "doc", "docx"];
  const ATTACHMENT_MAX_BYTES   = 10 * 1024 * 1024;

  /* ---------- module state ---------- */

  let announcements = [];

  // Track the currently-uploaded file's storage path so a subsequent
  // Remove or replace can delete the previous blob. Reset on modal open.
  let pendingAttachmentStoragePath = "";
  // Pre-allocated announcement doc ID for CREATE mode. Needed before
  // any upload so the storage path can include it. For EDIT mode this
  // is the existing announcement ID, set when the modal opens.
  let pendingAnnouncementId = "";

  // Recipient-picker state.
  let _annTechBySlug = Object.create(null);
  let _annSelectedSlugs = new Set();

  // Thread-panel unsubscribes (real-time comments listener) keyed by
  // announcement id. Released when the panel collapses or the page
  // unloads.
  const _annThreadUnsubs = Object.create(null);

  /* ---------- helpers ---------- */

  // Local Pacific-style timestamp formatter for announcement starts/expires
  // meta.
  function announcementTsToFmt(ts) {
    const ms = tsToMs(ts);
    if (ms == null) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
           " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // Convert a Firestore Timestamp / Date / ISO string to YYYY-MM-DDTHH:mm
  // for <input type="datetime-local">. Returns "" for null/missing.
  function tsToLocalInputValue(ts) {
    const ms = _tsToMillis(ts);
    if (ms == null) return "";
    const d = new Date(ms);
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---------- list rendering ---------- */

  async function loadAnnouncements() {
    setStatus("announcements", "loading");
    try {
      const snap = await firebase.firestore().collection("announcements")
        .orderBy("created_at", "desc")
        .get();
      announcements = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      applyCurrentAnnouncementsFilter();
    } catch (err) {
      console.error("loadAnnouncements failed", err);
      setStatus("announcements", "error",
        "Couldn't load announcements: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the announcements block."
      );
    }
  }

  function announcementCardHtml(a) {
    const archived = !!a.archived_at;
    const active   = a.active !== false && !archived;
    const priority = a.priority || "normal";
    const prCls    = ANNOUNCEMENT_PRIORITY_BADGE_CLS[priority] || "is-neutral";
    const prLabel  = ANNOUNCEMENT_PRIORITY_LABELS[priority] || priority;

    const statusBits = [];
    statusBits.push(archived
      ? badge("is-off", "Archived")
      : (active ? badge("is-on", "Active") : badge("is-off", "Inactive")));
    statusBits.push(badge(prCls, prLabel));
    if (a.mandatory) statusBits.push(badge("is-warn", "Mandatory"));

    const meta = [];
    if (a.starts_at)   meta.push("Starts " + announcementTsToFmt(a.starts_at));
    if (a.expires_at)  meta.push("Expires " + announcementTsToFmt(a.expires_at));
    if (a.created_by)  meta.push("By " + a.created_by);

    // Attachment chip — admin-side preview that links straight out so
    // the office can sanity-check the URL after composing. Image-typed
    // attachments also get a tiny inline thumbnail so admins can spot
    // the wrong-file-uploaded case at a glance.
    let attachmentHtml = "";
    if (a.attachment_url && /^https:\/\//i.test(a.attachment_url)) {
      const label = a.attachment_name || "View attachment";
      const typeBit = a.attachment_type ? " · " + a.attachment_type : "";
      const isImage = a.attachment_type === "image";
      const thumb = isImage
        ? '<img class="announcement-attachment-thumb" loading="lazy" alt="" src="' +
            escapeHtml(a.attachment_url) + '" ' +
            'onerror="this.style.display=\'none\';" />'
        : "";
      attachmentHtml =
        '<div class="announcement-attachment">' +
          thumb +
          '<a href="' + escapeHtml(a.attachment_url) + '" target="_blank" rel="noopener noreferrer">' +
            '📎 ' + escapeHtml(label) +
          '</a>' +
          '<span class="announcement-attachment-meta">' + escapeHtml(typeBit) + '</span>' +
        '</div>';
    }

    const archiveLabel = archived ? "Reactivate" : "Archive";

    return (
      '<article class="announcement-card" data-id="' + escapeHtml(a.id) + '">' +
        '<div class="announcement-head">' +
          '<span class="announcement-title">' + escapeHtml(a.title || "(untitled)") + '</span>' +
          '<div class="pill-badges">' + statusBits.join("") + '</div>' +
        '</div>' +
        '<p class="announcement-body">' + escapeHtml(a.message || "") + '</p>' +
        attachmentHtml +
        (meta.length ? '<div class="announcement-meta">' + escapeHtml(meta.join(" · ")) + '</div>' : '') +
        // Audience summary inline so admins can see at a glance who
        // a given announcement targets.
        renderAnnouncementAudienceSummary(a) +
        // At-a-glance recipient status line (loaded async after render).
        renderAnnouncementStatusSummary(a) +
        '<div class="announcement-actions">' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          '<button class="row-btn" type="button" data-action="thread">View thread</button>' +
          '<button class="row-btn" type="button" data-action="archive">' + archiveLabel + '</button>' +
        '</div>' +
        '<div class="announcement-thread-panel" data-thread-for="' + escapeHtml(a.id) + '" hidden></div>' +
      '</article>'
    );
  }

  /* ---- Tech name + avatar helpers --------------------------------- */

  // Returns the photoURL on a cleaning_techs doc, walking the known
  // field aliases. Empty string when none. Single source of truth — do
  // not duplicate this lookup elsewhere.
  function getTechAvatarUrl(t) {
    if (!t) return "";
    return String(
      t.photoUrl       || t.photo_url       ||
      t.avatarUrl      || t.avatar_url      ||
      t.profilePhotoUrl|| ""
    ).trim();
  }
  function getTechBySlug(slug) {
    if (!slug) return null;
    const s = String(slug).trim();
    const techs = getTechs();
    for (let i = 0; i < techs.length; i++) {
      const t = techs[i];
      const candidate = t.tech_slug || t.id;
      if (candidate === s) return t;
    }
    return null;
  }
  // Title-case a slug as a last-resort display name. "april-k" → "April K"
  // so the UI never has to surface raw kebab-case.
  function slugToTitleCase(slug) {
    if (!slug) return "";
    return String(slug).split("-").map(function (p) {
      if (!p) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(" ");
  }
  // Resolve a recipient slug → { name, avatarUrl, initial } object.
  // Always returns SOMETHING — never the raw slug.
  function resolveTechByAnyRef(ref) {
    let t = null;
    if (typeof ref === "string") {
      t = getTechBySlug(ref);
      if (!t) {
        // Try matching by email field on the techs cache.
        const emailLc = ref.toLowerCase();
        const techs = getTechs();
        for (let i = 0; i < techs.length; i++) {
          if (String(techs[i].email || "").toLowerCase() === emailLc) { t = techs[i]; break; }
        }
      }
    } else if (ref && typeof ref === "object") {
      t = ref;
    }
    const name = (t && getTechName(t)) || slugToTitleCase(typeof ref === "string" ? ref : "") || "(unknown)";
    const avatarUrl = getTechAvatarUrl(t);
    const initial = (name.charAt(0) || "P").toUpperCase();
    return { name: name, avatarUrl: avatarUrl, initial: initial, doc: t };
  }
  // Compact <img> or initial-circle. size: "sm" | "md" (default md).
  function renderTechAvatarHtml(resolved, sizeCls) {
    const cls = "ann-avatar" + (sizeCls === "sm" ? " ann-avatar-sm" : "");
    if (resolved.avatarUrl) {
      return '<span class="' + cls + '"><img src="' + escapeHtml(resolved.avatarUrl) +
             '" alt="" loading="lazy" /></span>';
    }
    return '<span class="' + cls + ' ann-avatar-fallback">' + escapeHtml(resolved.initial) + '</span>';
  }

  function renderAnnouncementAudienceSummary(a) {
    const type = String(a.audienceType || "all");
    if (type === "all") {
      return '<div class="announcement-audience-summary">📣 Sent to all active staff</div>';
    }
    const slugs = Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs : [];
    if (slugs.length === 0) {
      return '<div class="announcement-audience-summary announcement-audience-selected">👥 Sent to (no recipients)</div>';
    }
    const names = slugs.map(function (s) { return resolveTechByAnyRef(s).name; });
    const titleAttr = ' title="' + escapeHtml(names.join(", ")) + '"';
    let label;
    if (names.length === 1)      label = "Sent to: " + names[0];
    else if (names.length <= 4)  label = "Sent to: " + names.join(", ");
    else                         label = "Sent to: " + names.length + " team members";
    return '<div class="announcement-audience-summary announcement-audience-selected"' + titleAttr + '>' +
             '👥 ' + escapeHtml(label) +
           '</div>';
  }

  // At-a-glance recipient status line. Populated lazily after the card
  // renders (see refreshAnnouncementStatusSummaries). For now, render a
  // muted placeholder; the post-render loader updates it in place.
  function renderAnnouncementStatusSummary(a) {
    return '<div class="announcement-status-summary" data-status-for="' + escapeHtml(a.id) + '">' +
             '<span class="ann-status-loading">Loading status…</span>' +
           '</div>';
  }

  function renderAnnouncements(list) {
    const root = $("announcements-list");
    const cnt  = $("announcements-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + " announcement" + (list.length === 1 ? "" : "s");
    root.innerHTML = list.map(announcementCardHtml).join("");
    if (list.length === 0 && announcements.length === 0) setStatus("announcements", "empty");
    else hideAllStatuses("announcements");
    // Lazy-load recipient_status counts so the status line updates in
    // place without blocking the initial render.
    refreshAnnouncementStatusSummaries(list);
  }

  // For each rendered announcement, fetch its recipient_status counts
  // and update the inline status line. Per-card reads run in parallel
  // (small N — typically < 30 announcements visible at a time).
  function refreshAnnouncementStatusSummaries(list) {
    const db = firebase.firestore();
    (list || []).forEach(function (a) {
      const el = document.querySelector('[data-status-for="' + cssEsc(a.id) + '"]');
      if (!el) return;
      db.collection("announcements").doc(a.id).collection("recipient_status").get()
        .then(function (snap) {
          const docs = snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
          el.outerHTML = renderAnnouncementStatusSummaryHtml(a, docs);
        })
        .catch(function (err) {
          console.warn("[ann-status] subcollection read failed for " + a.id, err);
          if (el) el.innerHTML = '<span class="ann-status-error">Couldn\'t load status</span>';
        });
    });
  }

  function renderAnnouncementStatusSummaryHtml(a, statusDocs) {
    const type = String(a.audienceType || "all");
    const techs = getTechs();
    const expected = type === "selected"
      ? (Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs.length : 0)
      : techs.filter(function (t) { return t.active !== false; }).length;

    const counts = { unread: 0, viewed: 0, acknowledged: 0, replied: 0 };
    statusDocs.forEach(function (s) {
      const st = String(s.status || "unread");
      if (counts[st] != null) counts[st] += 1;
    });
    const stillUnread = Math.max(0, expected - statusDocs.length) + counts.unread;

    // Completeness badges. Only show "Awaiting reply" if requireReply
    // is set AND not every recipient has replied; same for ack.
    const ackReady   = !a.requireAcknowledgement || (counts.acknowledged + counts.replied >= expected);
    const replyReady = !a.requireReply           || (counts.replied >= expected);
    let statusBadge = "";
    if (!ackReady) {
      statusBadge = '<span class="ann-status-badge ann-status-badge-await">Awaiting acknowledgement</span>';
    } else if (!replyReady) {
      statusBadge = '<span class="ann-status-badge ann-status-badge-await">Awaiting reply</span>';
    } else if (a.requireAcknowledgement || a.requireReply) {
      statusBadge = '<span class="ann-status-badge ann-status-badge-done">All responses complete</span>';
    }

    return '<div class="announcement-status-summary" data-status-for="' + escapeHtml(a.id) + '">' +
             '<span class="ann-status-counts">' +
               'Status: ' +
               '<strong>' + stillUnread + '</strong> unread &middot; ' +
               '<strong>' + counts.viewed + '</strong> viewed &middot; ' +
               '<strong>' + counts.acknowledged + '</strong> acknowledged &middot; ' +
               '<strong>' + counts.replied + '</strong> replied' +
             '</span>' +
             statusBadge +
           '</div>';
  }

  function applyCurrentAnnouncementsFilter() {
    const q = (($("announcements-search") && $("announcements-search").value) || "").trim().toLowerCase();
    if (!q) return renderAnnouncements(announcements);
    const filtered = announcements.filter(function (a) {
      return (
        (a.title   || "").toLowerCase().includes(q) ||
        (a.message || "").toLowerCase().includes(q)
      );
    });
    renderAnnouncements(filtered);
  }

  /* ---- Attachment upload (Firebase Storage) ----------------------- */

  // Map an uploaded file's content-type/name to one of our enum values.
  function inferAttachmentType(file) {
    const ct = (file && file.type || "").toLowerCase();
    if (ct === "application/pdf") return "pdf";
    if (ct.indexOf("image/") === 0) return "image";
    // Office docs + everything else → "other" (admin can change in the
    // dropdown if they want to tag a schedule/safety doc explicitly).
    return "other";
  }

  function setAttachmentStatusText(text) {
    const el = $("announcement-edit-attachment-status");
    if (el) el.textContent = text;
  }
  function setAttachmentRemoveVisible(visible) {
    const btn = $("announcement-edit-attachment-remove");
    if (btn) btn.hidden = !visible;
  }
  function clearAttachmentFormFields() {
    $("announcement-edit-attachment-name").value         = "";
    $("announcement-edit-attachment-url").value          = "";
    $("announcement-edit-attachment-type").value         = "";
    $("announcement-edit-attachment-storage-path").value = "";
    pendingAttachmentStoragePath = "";
    setAttachmentStatusText("No file uploaded.");
    setAttachmentRemoveVisible(false);
  }

  // Validate file BEFORE upload. The Storage rules also enforce these,
  // but a client-side reject keeps the UX friendly + saves a network
  // round-trip on obvious failures.
  function validateAttachmentFile(file) {
    if (!file) return "No file selected.";
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return "File is too large (" +
        Math.ceil(file.size / (1024 * 1024)) +
        " MB). Max 10 MB.";
    }
    const ct = (file.type || "").toLowerCase();
    if (ct && ATTACHMENT_ALLOWED_MIME.indexOf(ct) >= 0) return "";
    // Fall back to extension if browser gave us a vague content type.
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
    if (ATTACHMENT_ALLOWED_EXT.indexOf(ext) >= 0) return "";
    return "Unsupported file type. Allowed: PDF, PNG, JPG, WEBP, DOC, DOCX.";
  }

  // Sanitize a filename for storage. Lowercase, drop unsafe characters,
  // keep one dot for the extension. Timestamp prefix avoids collisions.
  function makeStorageFilename(file) {
    const safe = (file.name || "file")
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return Date.now() + "-" + (safe || "file");
  }

  // Delete a previously-uploaded attachment from Storage. Non-fatal —
  // failures are logged but never block the surrounding workflow.
  async function deleteAttachmentBlob(storagePath) {
    if (!storagePath) return;
    if (!window.firebase || typeof firebase.storage !== "function") return;
    try {
      await firebase.storage().ref(storagePath).delete();
    } catch (err) {
      // Most common cause: file already deleted (e.g. orphan cleanup
      // race, or admin's first save after a refresh that lost the
      // ephemeral path). Safe to ignore.
      console.warn("deleteAttachmentBlob failed (non-fatal)", storagePath, err && err.code);
    }
  }

  async function onAttachmentFilePicked(file) {
    setModalError("announcement-edit-modal", "");
    const validationErr = validateAttachmentFile(file);
    if (validationErr) {
      setModalError("announcement-edit-modal", validationErr);
      // Reset the input so the same file can be re-picked after a fix.
      const input = $("announcement-edit-attachment-file");
      if (input) input.value = "";
      return;
    }
    if (!pendingAnnouncementId) {
      setModalError("announcement-edit-modal",
        "Couldn't allocate an upload path. Close and reopen the modal.");
      return;
    }
    if (!window.firebase || typeof firebase.storage !== "function") {
      setModalError("announcement-edit-modal",
        "Storage SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    // If a previous upload exists, delete it BEFORE we replace it.
    // We optimistically delete; if the upload fails we still leave the
    // form clean and an orphan-cleanup job (future) handles strays.
    if (pendingAttachmentStoragePath) {
      await deleteAttachmentBlob(pendingAttachmentStoragePath);
      pendingAttachmentStoragePath = "";
    }

    setAttachmentStatusText("Uploading " + file.name + "…");
    setAttachmentRemoveVisible(false);

    const filename    = makeStorageFilename(file);
    const storagePath = "announcements/" + pendingAnnouncementId + "/attachments/" + filename;
    const ref         = firebase.storage().ref(storagePath);

    try {
      const snap        = await ref.put(file, { contentType: file.type || undefined });
      const downloadUrl = await snap.ref.getDownloadURL();
      // Auto-fill the visible fields. Admin can still edit them.
      const friendlyName = file.name || "Attachment";
      $("announcement-edit-attachment-url").value          = downloadUrl;
      $("announcement-edit-attachment-name").value         = friendlyName;
      $("announcement-edit-attachment-type").value         = inferAttachmentType(file);
      $("announcement-edit-attachment-storage-path").value = storagePath;
      pendingAttachmentStoragePath                          = storagePath;
      setAttachmentStatusText("Uploaded: " + friendlyName);
      setAttachmentRemoveVisible(true);
    } catch (err) {
      console.error("attachment upload failed", err);
      const friendly = (err && err.code === "storage/unauthorized")
        ? "Upload denied. Confirm you're signed in as an admin and storage.rules has the announcements block deployed."
        : "Upload failed: " + ((err && err.message) || (err && err.code) || "unknown");
      setModalError("announcement-edit-modal", friendly);
      setAttachmentStatusText("Upload failed. Try a different file.");
    } finally {
      const input = $("announcement-edit-attachment-file");
      if (input) input.value = "";
    }
  }

  async function onAttachmentRemove() {
    setModalError("announcement-edit-modal", "");
    const storagePath = pendingAttachmentStoragePath ||
                        $("announcement-edit-attachment-storage-path").value;
    if (storagePath) await deleteAttachmentBlob(storagePath);
    clearAttachmentFormFields();
  }

  /* ---- Create / Edit modal --------------------------------------- */

  function openAnnouncementCreateModal() {
    const modal = $("announcement-edit-modal");
    if (modal) modal.dataset.mode = "create";
    const title = $("announcement-modal-title");
    if (title) title.textContent = "New announcement";

    // Pre-allocate a Firestore ID so attachment uploads can use a stable
    // storage path BEFORE the admin clicks Save. If they cancel without
    // saving, any uploaded file becomes an orphan — acceptable for v1.
    pendingAnnouncementId = firebase.firestore().collection("announcements").doc().id;
    pendingAttachmentStoragePath = "";

    $("announcement-edit-id").value                  = pendingAnnouncementId;
    $("announcement-edit-title").value               = "";
    $("announcement-edit-message").value             = "";
    $("announcement-edit-priority").value            = "normal";
    $("announcement-edit-active").checked            = true;
    $("announcement-edit-mandatory").checked         = false;
    $("announcement-edit-require-ack").checked       = false;
    $("announcement-edit-require-reply").checked     = false;
    $("announcement-audience-all").checked           = true;
    $("announcement-audience-selected").checked      = false;
    resetAnnouncementRecipientPicker();
    $("announcement-edit-starts-at").value           = "";
    $("announcement-edit-expires-at").value          = "";
    clearAttachmentFormFields();
    setModalError("announcement-edit-modal", "");
    openModal("announcement-edit-modal");
  }

  function openAnnouncementEditModal(a) {
    const modal = $("announcement-edit-modal");
    if (modal) modal.dataset.mode = "edit";
    const title = $("announcement-modal-title");
    if (title) title.textContent = "Edit announcement";

    pendingAnnouncementId        = a.id;
    pendingAttachmentStoragePath = a.attachment_storage_path || "";

    $("announcement-edit-id").value                  = a.id;
    $("announcement-edit-title").value               = a.title || "";
    $("announcement-edit-message").value             = a.message || "";
    $("announcement-edit-priority").value            = a.priority || "normal";
    $("announcement-edit-active").checked            = a.active !== false;
    $("announcement-edit-mandatory").checked         = !!a.mandatory;
    $("announcement-edit-require-ack").checked       = !!a.requireAcknowledgement;
    $("announcement-edit-require-reply").checked     = !!a.requireReply;
    const audienceType = String(a.audienceType || "all");
    if (audienceType === "selected") {
      $("announcement-audience-all").checked      = false;
      $("announcement-audience-selected").checked = true;
    } else {
      $("announcement-audience-all").checked      = true;
      $("announcement-audience-selected").checked = false;
    }
    resetAnnouncementRecipientPicker(Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs : []);
    $("announcement-edit-starts-at").value           = tsToLocalInputValue(a.starts_at);
    $("announcement-edit-expires-at").value          = tsToLocalInputValue(a.expires_at);
    $("announcement-edit-attachment-name").value         = a.attachment_name || "";
    $("announcement-edit-attachment-url").value          = a.attachment_url  || "";
    $("announcement-edit-attachment-type").value         = a.attachment_type || "";
    $("announcement-edit-attachment-storage-path").value = a.attachment_storage_path || "";
    if (a.attachment_storage_path) {
      setAttachmentStatusText("Uploaded: " + (a.attachment_name || "(file)"));
      setAttachmentRemoveVisible(true);
    } else if (a.attachment_url) {
      setAttachmentStatusText("External URL (no uploaded file).");
      setAttachmentRemoveVisible(false);
    } else {
      setAttachmentStatusText("No file uploaded.");
      setAttachmentRemoveVisible(false);
    }
    setModalError("announcement-edit-modal", "");
    openModal("announcement-edit-modal");
  }

  async function onAnnouncementSave() {
    const modal = $("announcement-edit-modal");
    const mode  = (modal && modal.dataset.mode) || "create";
    const id    = $("announcement-edit-id").value;

    const title    = $("announcement-edit-title").value.trim();
    const message  = $("announcement-edit-message").value.trim();
    const priority = $("announcement-edit-priority").value || "normal";
    const active   = $("announcement-edit-active").checked;
    const mandatory= $("announcement-edit-mandatory").checked;
    const requireAck   = $("announcement-edit-require-ack").checked;
    const requireReply = $("announcement-edit-require-reply").checked;
    const audienceType = $("announcement-audience-selected").checked ? "selected" : "all";
    const selectedTechSlugs = collectSelectedRecipientTechSlugs();
    const recipientEmails   = audienceType === "selected"
      ? selectedTechSlugs.map(function (s) {
          const t = _annTechBySlug[s];
          return t && t.email ? String(t.email).toLowerCase().trim() : "";
        }).filter(Boolean)
      : [];
    if (audienceType === "selected" && selectedTechSlugs.length === 0) {
      setModalError("announcement-edit-modal", "Pick at least one team member, or switch to All active staff.");
      return;
    }
    const startsAtRaw = $("announcement-edit-starts-at").value;
    const expiresAtRaw= $("announcement-edit-expires-at").value;
    const attachmentName = $("announcement-edit-attachment-name").value.trim();
    const attachmentUrl  = $("announcement-edit-attachment-url").value.trim();
    const attachmentType = $("announcement-edit-attachment-type").value;

    if (!title)   { setModalError("announcement-edit-modal", "Title is required."); return; }
    if (!message) { setModalError("announcement-edit-modal", "Message is required."); return; }
    if (ANNOUNCEMENT_PRIORITIES.indexOf(priority) < 0) {
      setModalError("announcement-edit-modal", "Pick a valid priority.");
      return;
    }
    if (title.length > 120)    { setModalError("announcement-edit-modal", "Title is too long (max 120).");   return; }
    if (message.length > 2000) { setModalError("announcement-edit-modal", "Message is too long (max 2000)."); return; }

    // Attachment validation. URL is optional — but when present it must
    // be https:// (refuse http:// to keep us off mixed-content warnings
    // and javascript:/data: to keep us off XSS). Name + type are
    // cosmetic and unvalidated beyond length.
    if (attachmentUrl) {
      if (!/^https:\/\//i.test(attachmentUrl)) {
        setModalError("announcement-edit-modal", "Attachment URL must start with https://");
        return;
      }
      if (attachmentUrl.length > 2048) {
        setModalError("announcement-edit-modal", "Attachment URL is too long (max 2048).");
        return;
      }
    }
    if (attachmentName.length > 120) {
      setModalError("announcement-edit-modal", "Attachment name is too long (max 120).");
      return;
    }
    if (attachmentType && ANNOUNCEMENT_ATTACHMENT_TYPES.indexOf(attachmentType) < 0) {
      setModalError("announcement-edit-modal", "Pick a valid attachment type.");
      return;
    }
    // Empty string for the URL means "no attachment" — clear the
    // companion fields too so a stale name/type/storage_path doesn't
    // linger on the doc after an admin removed the URL.
    const attachmentStoragePathRaw = $("announcement-edit-attachment-storage-path").value || "";
    const finalAttachmentName        = attachmentUrl ? attachmentName : "";
    const finalAttachmentType        = attachmentUrl ? attachmentType : "";
    const finalAttachmentStoragePath = attachmentUrl ? attachmentStoragePathRaw : "";

    const db         = firebase.firestore();
    const adminEmail = getCurrentAdminEmail();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();
    const startsAt   = startsAtRaw  ? new Date(startsAtRaw)  : null;
    const expiresAt  = expiresAtRaw ? new Date(expiresAtRaw) : null;

    setModalSaving("announcement-edit-modal", true);
    setModalError("announcement-edit-modal", "");

    try {
      if (mode === "create") {
        // Use the pre-allocated ID so any file uploaded into
        // announcements/{thisId}/attachments/ is correctly parented.
        const createId = id || pendingAnnouncementId ||
                         db.collection("announcements").doc().id;
        await db.collection("announcements").doc(createId).set({
          title:                   title,
          message:                 message,
          active:                  active,
          priority:                priority,
          mandatory:               mandatory,
          // V2 targeting fields. Legacy `audience_type: "all_staff"` is
          // kept for back-compat with the older modal code paths; the
          // new `audienceType` is the canonical V2 source.
          audience_type:           "all_staff",
          audienceType:            audienceType,
          recipientTechSlugs:      audienceType === "selected" ? selectedTechSlugs : [],
          recipientEmails:         audienceType === "selected" ? recipientEmails : [],
          recipientUids:           [],
          recipientRoles:          [],
          requireAcknowledgement:  requireAck,
          requireReply:            requireReply,
          starts_at:               startsAt,
          expires_at:              expiresAt,
          attachment_url:          attachmentUrl || "",
          attachment_name:         finalAttachmentName,
          attachment_type:         finalAttachmentType,
          attachment_storage_path: finalAttachmentStoragePath,
          attachment_uploaded_at:  finalAttachmentStoragePath ? sts : null,
          attachment_uploaded_by:  finalAttachmentStoragePath ? adminEmail : "",
          created_by:              adminEmail,
          created_at:              sts,
          updated_by:              adminEmail,
          updated_at:              sts,
          archived_at:             null
        });
        showToast("ok", "Announcement created.");
      } else {
        if (!id) {
          setModalError("announcement-edit-modal", "Lost the announcement ID — refresh and try again.");
          setModalSaving("announcement-edit-modal", false);
          return;
        }
        const updates = {
          title:                   title,
          message:                 message,
          active:                  active,
          priority:                priority,
          mandatory:               mandatory,
          audienceType:            audienceType,
          recipientTechSlugs:      audienceType === "selected" ? selectedTechSlugs : [],
          recipientEmails:         audienceType === "selected" ? recipientEmails : [],
          requireAcknowledgement:  requireAck,
          requireReply:            requireReply,
          starts_at:               startsAt,
          expires_at:              expiresAt,
          attachment_url:          attachmentUrl || "",
          attachment_name:         finalAttachmentName,
          attachment_type:         finalAttachmentType,
          attachment_storage_path: finalAttachmentStoragePath,
          updated_by:              adminEmail,
          updated_at:              sts
        };
        // Only stamp upload audit when a NEW storage_path appears.
        // Replacing one upload with another still updates the audit.
        if (finalAttachmentStoragePath) {
          updates.attachment_uploaded_at = sts;
          updates.attachment_uploaded_by = adminEmail;
        } else {
          // Cleared attachment — null out the audit stamps too.
          updates.attachment_uploaded_at = null;
          updates.attachment_uploaded_by = "";
        }
        await db.collection("announcements").doc(id).update(updates);
        showToast("ok", "Announcement updated.");
      }
      // Reset the pending-upload state now that the doc owns it.
      pendingAttachmentStoragePath = "";
      pendingAnnouncementId        = "";
      closeModal("announcement-edit-modal");
      await loadAnnouncements();
    } catch (err) {
      handleAdminWriteError(err, { context: "announcement save", modalId: "announcement-edit-modal" });
    } finally {
      setModalSaving("announcement-edit-modal", false);
    }
  }

  async function onAnnouncementArchive(a) {
    const isArchiving = !a.archived_at;
    const verb        = isArchiving ? "Archive" : "Reactivate";
    const summary     = isArchiving
      ? "Staff will no longer see it. No data is deleted — you can reactivate later."
      : "Staff will see it again (assuming Active is still on).";
    if (!window.confirm(verb + ' "' + (a.title || a.id) + '"?\n\n' + summary)) return;

    const adminEmail = getCurrentAdminEmail();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();
    const updates = isArchiving
      ? { archived_at: sts,  active: false, updated_at: sts, updated_by: adminEmail }
      : { archived_at: null,                updated_at: sts, updated_by: adminEmail };

    try {
      await firebase.firestore().collection("announcements").doc(a.id).update(updates);
      showToast("ok", isArchiving ? "Announcement archived." : "Announcement reactivated.");
      await loadAnnouncements();
    } catch (err) {
      handleAdminWriteError(err, { context: "announcement archive" });
    }
  }

  /* --------------------------------------------------------------------
   * Targeted-announcement helpers (recipient picker + thread panel)
   * ------------------------------------------------------------------ */

  function resetAnnouncementRecipientPicker(initialSlugs) {
    _annSelectedSlugs = new Set(Array.isArray(initialSlugs) ? initialSlugs : []);
    // Refresh tech directory from the live deps bridge (Phase 16a moved
    // techs into tab-techs.js).
    _annTechBySlug = Object.create(null);
    getTechs().forEach(function (t) {
      if (t && (t.tech_slug || t.id)) {
        const slug = t.tech_slug || t.id;
        _annTechBySlug[slug] = t;
      }
    });
    const search = $("announcement-recipient-search");
    if (search) search.value = "";
    const picker = $("announcement-recipient-picker");
    if (picker) picker.hidden = $("announcement-audience-selected").checked ? false : true;
    renderAnnouncementRecipientList("");
  }

  function renderAnnouncementRecipientList(query) {
    const list = $("announcement-recipient-list");
    if (!list) return;
    const q = String(query || "").toLowerCase().trim();
    const items = getTechs()
      .filter(function (t) {
        if (t.active === false) return false;
        if (!q) return true;
        const blob = ((t.display_name || "") + " " + (t.email || "") + " " + (t.tech_slug || t.id || "")).toLowerCase();
        return blob.indexOf(q) >= 0;
      })
      .sort(function (a, b) {
        return String(a.display_name || a.tech_slug || a.id || "").localeCompare(
          String(b.display_name || b.tech_slug || b.id || ""));
      });
    list.innerHTML = items.map(function (t) {
      const slug = t.tech_slug || t.id;
      const checked = _annSelectedSlugs.has(slug) ? " checked" : "";
      const resolved = resolveTechByAnyRef(t);
      const avatarHtml = renderTechAvatarHtml(resolved, "sm");
      return '<label class="ann-recipient-row">' +
               '<input type="checkbox" data-recipient-slug="' + escapeHtml(slug) + '"' + checked + ' />' +
               avatarHtml +
               '<span class="ann-recipient-text">' +
                 '<span class="ann-recipient-name">' + escapeHtml(resolved.name) + '</span>' +
                 '<span class="ann-recipient-email">' + escapeHtml(t.email || "") + '</span>' +
               '</span>' +
             '</label>';
    }).join("");
    list.querySelectorAll('input[data-recipient-slug]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        const slug = cb.getAttribute("data-recipient-slug");
        if (cb.checked) _annSelectedSlugs.add(slug);
        else            _annSelectedSlugs.delete(slug);
        const counter = $("announcement-recipient-counter");
        if (counter) counter.textContent = _annSelectedSlugs.size + " selected";
      });
    });
    const counter = $("announcement-recipient-counter");
    if (counter) counter.textContent = _annSelectedSlugs.size + " selected";
  }

  function collectSelectedRecipientTechSlugs() {
    return Array.from(_annSelectedSlugs);
  }

  /* ---- Thread panel (recipient status + comments) ----------------- */

  async function toggleAnnouncementThread(a, cardEl) {
    const panel = cardEl.querySelector(".announcement-thread-panel");
    if (!panel) return;
    if (!panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = "";
      if (_annThreadUnsubs[a.id]) { try { _annThreadUnsubs[a.id](); } catch (_e) {} delete _annThreadUnsubs[a.id]; }
      return;
    }
    panel.hidden = false;
    panel.innerHTML =
      '<div class="ann-thread-loading">Loading thread…</div>';
    // Load recipient_status counts + comments thread in parallel.
    const annRef = firebase.firestore().collection("announcements").doc(a.id);
    let statusDocs = [];
    try {
      const snap = await annRef.collection("recipient_status").get();
      statusDocs = snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
    } catch (err) {
      console.warn("[ann-thread] recipient_status read failed", err);
    }
    renderAnnouncementThreadHeader(panel, a, statusDocs);

    const commentsRoot = document.createElement("div");
    commentsRoot.className = "ann-thread-comments";
    panel.appendChild(commentsRoot);
    const replyForm = document.createElement("div");
    replyForm.className = "ann-thread-replyform";
    replyForm.innerHTML =
      '<textarea class="ann-thread-replybox" rows="2" maxlength="800" placeholder="Reply as admin…"></textarea>' +
      '<button type="button" class="panel-action ann-thread-replybtn">Send reply</button>';
    panel.appendChild(replyForm);
    replyForm.querySelector(".ann-thread-replybtn").addEventListener("click", function () {
      submitAdminAnnouncementReply(a, replyForm);
    });

    // Subscribe to comments in real time.
    _annThreadUnsubs[a.id] = annRef.collection("comments")
      .orderBy("createdAt", "asc")
      .onSnapshot(function (snap) {
        renderAnnouncementComments(commentsRoot, snap.docs.map(function (d) {
          return Object.assign({ _id: d.id }, d.data());
        }));
      }, function (err) {
        commentsRoot.innerHTML = '<div class="ann-thread-error">Couldn\'t load comments: ' + escapeHtml(err.message || "") + '</div>';
      });
  }

  function renderAnnouncementThreadHeader(panel, a, statusDocs) {
    panel.querySelector(".ann-thread-loading") && panel.querySelector(".ann-thread-loading").remove();
    const audienceType = String(a.audienceType || "all");
    const targets = audienceType === "selected"
      ? (Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs : [])
      : getTechs().filter(function (t) { return t.active !== false; }).map(function (t) { return t.tech_slug || t.id; });
    const totals = { unread: 0, viewed: 0, acknowledged: 0, replied: 0 };
    const byUid = Object.create(null);
    statusDocs.forEach(function (s) { byUid[s.uid] = s; });
    // The map keyed by uid isn't useful for "unread" until we know the
    // expected uid set. We instead infer status counts from the recorded
    // status docs and treat any expected recipient with no doc as "unread".
    statusDocs.forEach(function (s) {
      const st = String(s.status || "unread");
      if (totals[st] != null) totals[st] += 1;
    });
    const totalExpected = targets.length || statusDocs.length;
    const totalKnown    = statusDocs.length;
    const stillUnread   = Math.max(0, totalExpected - totalKnown) + totals.unread;
    const header = document.createElement("div");
    header.className = "ann-thread-header";
    header.innerHTML =
      '<div class="ann-thread-counts">' +
        '<span class="ann-thread-count">' + stillUnread + ' unread</span>' +
        '<span class="ann-thread-count">' + totals.viewed + ' viewed</span>' +
        '<span class="ann-thread-count ann-thread-count-ack">' + totals.acknowledged + ' acknowledged</span>' +
        '<span class="ann-thread-count ann-thread-count-rep">' + totals.replied + ' replied</span>' +
      '</div>';
    // Per-recipient list (collapsible). Avatars + humanized name; no
    // raw slug, never. Status pill stays at the right.
    if (audienceType === "selected" && targets.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "ann-thread-recipients";
      targets.forEach(function (slug) {
        const resolved = resolveTechByAnyRef(slug);
        const sd = statusDocs.find(function (s) { return s.techSlug === slug; });
        const st = sd ? String(sd.status || "unread") : "unread";
        const cls = "ann-thread-recipient-status ann-thread-recipient-status-" + st;
        const avatarHtml = renderTechAvatarHtml(resolved, "sm");
        ul.innerHTML += '<li>' +
                          avatarHtml +
                          '<span class="ann-thread-recipient-name">' + escapeHtml(resolved.name) + '</span>' +
                          '<span class="' + cls + '">' + escapeHtml(st.toUpperCase()) + '</span>' +
                        '</li>';
      });
      header.appendChild(ul);
    }
    panel.appendChild(header);
    void byUid;  // computed for side-effects (could surface per-uid status in a future view)
  }

  function renderAnnouncementComments(root, comments) {
    if (comments.length === 0) {
      root.innerHTML = '<div class="ann-thread-empty">No replies yet.</div>';
      return;
    }
    root.innerHTML = comments.map(function (c) {
      const when = formatImprovementDate(c.createdAt);
      const role = String(c.createdByRole || "").trim();
      const isAdmin = role === "admin" || role === "manager" || role === "office_manager";
      const roleChip = isAdmin
        ? '<span class="ann-thread-role">' + escapeHtml(role) + '</span>'
        : '';
      // Resolve avatar: prefer matching cleaning_techs by email; admin
      // commenters typically aren't in cleaning_techs so they get the
      // initial-fallback chip.
      let resolved;
      if (isAdmin) {
        resolved = {
          name:      c.createdByName || c.createdByEmail || "Admin",
          avatarUrl: "",
          initial:   (c.createdByName || c.createdByEmail || "A").charAt(0).toUpperCase()
        };
      } else {
        resolved = resolveTechByAnyRef(c.createdByEmail || c.createdByName);
        // Fall back to the comment's own name when no tech doc matched.
        if (!resolved.doc && c.createdByName) resolved.name = c.createdByName;
      }
      const avatarHtml = renderTechAvatarHtml(resolved, "sm");
      return '<div class="ann-thread-comment ' + (isAdmin ? "is-admin" : "") + '">' +
               avatarHtml +
               '<div class="ann-thread-comment-text">' +
                 '<div class="ann-thread-comment-head">' +
                   '<strong>' + escapeHtml(resolved.name) + '</strong> ' +
                   roleChip +
                   '<span class="ann-thread-comment-when">' + escapeHtml(when) + '</span>' +
                 '</div>' +
                 '<p class="ann-thread-comment-body">' + escapeHtml(c.body || "").replace(/\n/g, "<br>") + '</p>' +
               '</div>' +
             '</div>';
    }).join("");
  }

  async function submitAdminAnnouncementReply(a, form) {
    const ta  = form.querySelector(".ann-thread-replybox");
    const btn = form.querySelector(".ann-thread-replybtn");
    const body = String(ta.value || "").trim();
    if (!body) { ta.focus(); return; }
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const u = firebase.auth().currentUser;
      await firebase.firestore().collection("announcements").doc(a.id).collection("comments").add({
        body:            body,
        createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
        createdByUid:    u.uid,
        createdByEmail:  String(u.email || "").toLowerCase(),
        createdByName:   u.displayName || u.email || "admin",
        createdByRole:   "admin",
        visibility:      "announcement_recipients",
        source:          "admin"
      });
      ta.value = "";
    } catch (err) {
      alert("Couldn't send reply: " + (err && err.message));
    } finally {
      btn.disabled = false; btn.textContent = "Send reply";
    }
  }

  /* ---------- wire DOM ---------- */

  function wireAnnouncementsControls() {
    const list = $("announcements-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const card = btn.closest(".announcement-card");
        if (!card) return;
        const a = announcements.find(function (x) { return x.id === card.dataset.id; });
        if (!a) return;
        if (btn.dataset.action === "edit")    openAnnouncementEditModal(a);
        if (btn.dataset.action === "archive") onAnnouncementArchive(a);
        if (btn.dataset.action === "thread")  toggleAnnouncementThread(a, card);
      });
    }
    // Audience radio toggles the recipient picker visibility.
    document.querySelectorAll('input[name="announcement-audience"]').forEach(function (r) {
      r.addEventListener("change", function () {
        const picker = $("announcement-recipient-picker");
        if (picker) picker.hidden = $("announcement-audience-selected").checked ? false : true;
      });
    });
    const recipSearch = $("announcement-recipient-search");
    if (recipSearch) recipSearch.addEventListener("input", function () { renderAnnouncementRecipientList(recipSearch.value); });
    const search = $("announcements-search");
    if (search) search.addEventListener("input", applyCurrentAnnouncementsFilter);
    const openBtn = $("announcements-create-open");
    if (openBtn) openBtn.addEventListener("click", openAnnouncementCreateModal);
    const saveBtn = $("announcement-edit-save");
    if (saveBtn) saveBtn.addEventListener("click", onAnnouncementSave);

    // Attachment upload UI — file picker proxy + hidden input + Remove.
    const pickBtn   = $("announcement-edit-attachment-pick");
    const fileInput = $("announcement-edit-attachment-file");
    const removeBtn = $("announcement-edit-attachment-remove");
    if (pickBtn && fileInput) {
      // Proxy click — hide the ugly default <input type="file"> chrome.
      pickBtn.addEventListener("click", function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener("change", function (ev) {
        const file = ev.target && ev.target.files && ev.target.files[0];
        if (file) onAttachmentFilePicked(file);
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener("click", onAttachmentRemove);
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.announcements = {
    init:             wireAnnouncementsControls,
    refresh:          loadAnnouncements,
    getAnnouncements: function () { return announcements; },
    applyFilter:      applyCurrentAnnouncementsFilter,
    openCreateModal:  openAnnouncementCreateModal,
    openEditModal:    openAnnouncementEditModal,
    onSave:           onAnnouncementSave,
    onArchive:        onAnnouncementArchive
  };
}());
