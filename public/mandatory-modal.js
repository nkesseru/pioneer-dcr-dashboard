/* Pioneer DCR Hub — Mandatory Announcement blocking modal (shared).
 *
 * Loaded on every staff-facing page EXCEPT /team-hub.html, which has its
 * own equivalent implementation inside team-hub.js. Two implementations
 * never run on the same page, so they can't conflict.
 *
 * Pages that load this:
 *   • /            (index.html)
 *   • /tech.html
 *   • /supply-station.html
 *   • /admin       (admin.html)
 *
 * Public API exposed on window.MANDATORY_ANN:
 *   check(staff): Promise<void>
 *     Fetches active announcements + the user's announcement_reads, then
 *     opens a blocking modal for each unread mandatory announcement.
 *     Resolves when all mandatory reads are acknowledged (or when there
 *     are none, or on transient error). Caller should re-paint the nav
 *     badge after the Promise resolves.
 *
 *   • `staff` must have { uid, email }. uid is required; email is used
 *     only for the read-receipt doc body (cosmetic).
 *
 * Hard rules baked into the modal:
 *   • No backdrop dismiss (backdrop has NO data-modal-close).
 *   • No close X.
 *   • Escape key does not bypass it (no global Esc listener wired here;
 *     other pages' Esc handlers only close specific known modal IDs).
 *   • Modal blocks scrolling via body.style.overflow = "hidden".
 *
 * Failure mode: if firestore is unreachable, check() logs and resolves
 * silently. The user is NOT blocked by a network failure. This is
 * acceptable for v1 because client-side enforcement is always
 * defeatable in DevTools anyway — the canonical record lives in
 * Firestore.
 *
 * KEEP IN SYNC: team-hub.js has a parallel implementation. If you
 * change the modal copy / button label / queue behavior here, mirror it
 * there too.
 */
(function () {
  "use strict";

  const MODAL_ID    = "mandatory-announcement-modal";
  const TITLE_TEXT  = "Required Announcement";
  const BUTTON_TEXT = "Mark as read and continue";

  // V6 pilot — localStorage belt to the Firestore suspenders.
  // If a per-tech `announcement_reads/{annId_uid}` write fails (rules
  // glitch, offline, transient 500), the next page load shouldn't
  // loop the same modal at the same tech forever. We mirror every
  // successful Firestore mark-as-read to localStorage AND treat the
  // local cache as authoritative for "already seen, don't reshow"
  // even when the Firestore read returns stale.
  //
  // Storage shape:
  //   key:   pioneer.annRead.<uid>
  //   value: JSON map { <annId>: { v: <version|1>, t: <ISO ts> } }
  //
  // Version awareness: announcement docs MAY carry a `version` (or
  // `revision`) number. When it bumps, the local cache + Firestore
  // read shows the prior read as stale and the modal re-appears.
  // Announcements without a version field are treated as v1.
  const LOCAL_CACHE_PREFIX = "pioneer.annRead.";

  function log(msg, meta) {
    try { console.info("[PioneerOps Announcement] " + msg, meta || ""); }
    catch (_e) { /* console suppressed */ }
  }
  function warn(msg, meta) {
    try { console.warn("[PioneerOps Announcement] " + msg, meta || ""); }
    catch (_e) { /* console suppressed */ }
  }

  function announcementVersion(a) {
    if (!a) return 1;
    const v = (a.version != null ? a.version : a.revision);
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? n : 1;
  }

  function loadLocalReads(uid) {
    if (!uid) return {};
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + uid);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (_e) { return {}; }
  }
  function saveLocalRead(uid, announcementId, version) {
    if (!uid || !announcementId) return;
    try {
      const map = loadLocalReads(uid);
      map[announcementId] = { v: Number(version) || 1, t: new Date().toISOString() };
      localStorage.setItem(LOCAL_CACHE_PREFIX + uid, JSON.stringify(map));
    } catch (_e) { /* private mode, quota — soft-fail */ }
  }
  function localHasReadAtVersion(uid, announcementId, version) {
    const map = loadLocalReads(uid);
    const entry = map[announcementId];
    if (!entry) return false;
    return Number(entry.v) >= Number(version);
  }

  let injected      = false;
  let modalEl       = null;
  let titleEl       = null;
  let messageEl     = null;
  let attachEl      = null;
  let progressEl    = null;
  let errEl         = null;
  let buttonEl      = null;
  let currentClick  = null;   // active button-click handler (per-queue-entry)

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function injectMarkup() {
    if (injected) return;
    injected = true;
    if (document.getElementById(MODAL_ID)) {
      // A page (e.g. team-hub.html) might already have the modal
      // markup. Bind to it and skip injection.
      bindRefs();
      return;
    }
    const wrap = document.createElement("div");
    wrap.innerHTML =
      '<div id="' + MODAL_ID + '" class="admin-modal" hidden aria-hidden="true">' +
        '<div class="admin-modal-backdrop"></div>' +   // no data-modal-close — backdrop is non-dismissable
        '<div class="admin-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="mandatory-modal-title">' +
          '<header class="admin-modal-header">' +
            '<h2 id="mandatory-modal-title">📣 ' + escapeHtml(TITLE_TEXT) + '</h2>' +
          '</header>' +
          '<div class="admin-modal-body">' +
            '<p id="mandatory-modal-progress" class="staff-auth-sub" style="text-align:left;margin-bottom:6px;"></p>' +
            '<h3 id="mandatory-modal-ann-title" style="font-size:17px;font-weight:800;margin:6px 0 8px;"></h3>' +
            '<p id="mandatory-modal-ann-message" style="white-space:pre-wrap;line-height:1.55;font-size:14px;"></p>' +
            '<p id="mandatory-modal-ann-attachment" style="margin-top:10px;"></p>' +
          '</div>' +
          '<footer class="admin-modal-footer">' +
            '<div class="admin-modal-err" id="mandatory-modal-err" hidden></div>' +
            '<button type="button" class="modal-btn-save" id="mandatory-modal-mark-read">' + escapeHtml(BUTTON_TEXT) + '</button>' +
          '</footer>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap.firstElementChild);
    bindRefs();
  }

  function bindRefs() {
    modalEl    = document.getElementById(MODAL_ID);
    titleEl    = document.getElementById("mandatory-modal-ann-title");
    messageEl  = document.getElementById("mandatory-modal-ann-message");
    attachEl   = document.getElementById("mandatory-modal-ann-attachment");
    progressEl = document.getElementById("mandatory-modal-progress");
    errEl      = document.getElementById("mandatory-modal-err");
    buttonEl   = document.getElementById("mandatory-modal-mark-read");
    if (buttonEl) {
      // Single delegated listener — currentClick captures the per-entry
      // handler that resolves the queue's "next" callback. Reassigning
      // currentClick between entries avoids stacking listeners.
      buttonEl.addEventListener("click", function () {
        if (typeof currentClick === "function") currentClick();
      });
    }
  }

  // Build the "View attachment" anchor for the modal. Defense in depth:
  // even if a tampered doc carries a non-https URL, we drop it here so
  // we never render javascript: / data: hrefs from inside the modal.
  function attachmentLinkHtml(entry) {
    const url = entry && entry.attachment_url ? String(entry.attachment_url) : "";
    if (!/^https:\/\//i.test(url)) return "";
    const label = (entry.attachment_name && String(entry.attachment_name).trim()) || "View attachment";
    return '<a class="ann-attachment-btn" target="_blank" rel="noopener noreferrer" href="' +
             escapeHtml(url) + '">📎 ' + escapeHtml(label) + '</a>';
  }

  // Lightweight inline preview for image-typed attachments only. Same
  // contract as the staff-card preview in team-hub.js — see that file
  // for rationale. Tap the image to open the full file in a new tab;
  // broken images remove themselves so the View-attachment button is
  // the always-on fallback.
  function attachmentPreviewHtml(entry) {
    if (!entry || entry.attachment_type !== "image") return "";
    const url = String(entry.attachment_url || "");
    if (!/^https:\/\//i.test(url)) return "";
    const alt = (entry.attachment_name && String(entry.attachment_name).trim()) || "Attachment image";
    return '<a class="ann-attachment-preview" target="_blank" rel="noopener noreferrer" href="' +
             escapeHtml(url) + '">' +
             '<img loading="lazy" alt="' + escapeHtml(alt) + '" src="' + escapeHtml(url) + '" ' +
                  'onerror="this.closest(\'.ann-attachment-preview\').remove();" />' +
           '</a>';
  }

  function showModalForEntry(entry, queueIndex, queueTotal, onMarkRead) {
    injectMarkup();
    if (!modalEl) return;
    if (titleEl)    titleEl.textContent   = entry.title || "(untitled)";
    if (messageEl)  messageEl.textContent = entry.message || "";
    // innerHTML is safe — both helpers escape inputs and refuse
    // anything other than https://. Preview first (visual anchor), then
    // the persistent View-attachment button below it.
    if (attachEl)   attachEl.innerHTML    = attachmentPreviewHtml(entry) + attachmentLinkHtml(entry);
    if (progressEl) {
      const remaining = queueTotal - queueIndex;
      progressEl.textContent = remaining > 1
        ? "You have " + remaining + " required announcements to acknowledge."
        : "You have 1 required announcement to acknowledge.";
    }
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = BUTTON_TEXT; }
    currentClick = onMarkRead;
    modalEl.hidden = false;
    modalEl.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function hideModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    modalEl.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    currentClick = null;
  }

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg || "Couldn't save. Check your connection and try again.";
    errEl.hidden = false;
  }

  function setButtonSaving(saving) {
    if (!buttonEl) return;
    buttonEl.disabled = !!saving;
    buttonEl.textContent = saving ? "Saving…" : BUTTON_TEXT;
  }

  function annTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  function isActiveNow(a) {
    if (!a) return false;
    if (a.archived_at) return false;
    if (a.active === false) return false;
    const now = Date.now();
    const startsMs = annTsToMs(a.starts_at);
    if (startsMs != null && startsMs > now) return false;
    const expiresMs = annTsToMs(a.expires_at);
    if (expiresMs != null && expiresMs <= now) return false;
    return true;
  }

  async function markRead(db, announcementId, version, staff) {
    const docId = announcementId + "_" + staff.uid;
    const payload = {
      announcement_id: announcementId,
      uid:             staff.uid,
      email:           staff.email || "",
      version:         Number(version) || 1,
      read_at:         firebase.firestore.FieldValue.serverTimestamp()
    };
    // Always update the local cache FIRST. Even if the Firestore
    // write below fails (rules glitch, offline, transient 500), the
    // user's session won't loop the same modal on every page load.
    // The local cache is per-uid and per-version, so a republished
    // announcement (version bump) still re-shows correctly.
    saveLocalRead(staff.uid, announcementId, payload.version);
    try {
      await db.collection("announcement_reads").doc(docId).set(payload);
      log("markRead ok", { announcementId: announcementId, version: payload.version, uid: staff.uid });
    } catch (err) {
      // Don't swallow — let the caller surface the error in the modal
      // UI. But the local cache is already updated, so the next page
      // load won't re-display this announcement at this tech.
      warn("markRead Firestore write failed (local cache still updated)", {
        announcementId: announcementId, code: err && err.code, message: err && err.message
      });
      throw err;
    }
  }

  // Process the queue sequentially. Each entry shows the modal and
  // resolves the outer Promise only after the user successfully marks
  // it read. Errors leave the modal open with the error banner.
  function processQueue(db, queue, staff) {
    return new Promise(function (resolve) {
      let i = 0;
      function next() {
        if (i >= queue.length) {
          hideModal();
          resolve();
          return;
        }
        const entry = queue[i];
        const version = announcementVersion(entry);
        showModalForEntry(entry, i, queue.length, async function onClick() {
          if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
          setButtonSaving(true);
          try {
            await markRead(db, entry.id, version, staff);
            setButtonSaving(false);
            i += 1;
            next();
          } catch (err) {
            // Even if the Firestore write failed, the local cache
            // was updated by markRead before the throw — so the
            // user won't see this announcement again on next page
            // load. We still surface the error so they can retry.
            warn("mark-as-read Firestore write failed", { code: err && err.code, message: err && err.message });
            setButtonSaving(false);
            showError("Couldn't save to Firestore. We've recorded it locally so you won't see this again — but please retry to sync.");
            // Stay on this entry. User can retry by clicking the button.
          }
        });
      }
      next();
    });
  }

  async function check(staff) {
    // Safe fallback if user/tech identity missing — silently skip the
    // check rather than block the page. Per the V6 pilot spec.
    if (!staff || !staff.uid) {
      log("check skipped — missing staff.uid");
      return;
    }
    if (!window.firebase || typeof firebase.firestore !== "function") {
      warn("firestore SDK unavailable — skipping check");
      return;
    }
    try {
      const db = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        db.collection("announcements").where("active", "==", true).get(),
        db.collection("announcement_reads").where("uid", "==", staff.uid).get()
      ]);
      // Firestore-side read map: announcement_id → read version (or 1
      // for legacy reads written before V6 added the version field).
      const firestoreReadVersions = Object.create(null);
      readsSnap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (!data.announcement_id) return;
        firestoreReadVersions[data.announcement_id] = Number(data.version) || 1;
      });
      const allActive = annsSnap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(isActiveNow)
        .filter(function (a) { return !!a.mandatory; });

      // Bucket each mandatory announcement. An item is queued ONLY if
      // NEITHER Firestore NOR localStorage shows the user has read it
      // at the current version. Firestore is authoritative on first
      // run; localStorage is the belt that prevents a Firestore-write
      // hiccup from looping the modal forever.
      const queue = [];
      const skipped = [];
      allActive.forEach(function (a) {
        const v = announcementVersion(a);
        const fsRead = (firestoreReadVersions[a.id] || 0) >= v;
        const localRead = localHasReadAtVersion(staff.uid, a.id, v);
        if (fsRead || localRead) {
          skipped.push({ id: a.id, v: v, fsRead: fsRead, localRead: localRead });
          return;
        }
        queue.push(a);
      });
      queue.sort(function (a, b) {
        // Urgent first, then created_at desc.
        const pa = a.priority === "urgent" ? 0 : 1;
        const pb = b.priority === "urgent" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const at = annTsToMs(a.created_at) || 0;
        const bt = annTsToMs(b.created_at) || 0;
        return bt - at;
      });

      log("check completed", {
        uid:               staff.uid,
        active_mandatory:  allActive.length,
        skipped_already_read: skipped.length,
        queue_count:       queue.length,
        queue_ids:         queue.map(function (a) { return a.id; })
      });

      if (queue.length === 0) return;
      await processQueue(db, queue, staff);
    } catch (err) {
      // Network / permissions / SDK error — don't block the page.
      warn("check failed; not blocking page", { code: err && err.code, message: err && err.message });
    }
  }

  window.MANDATORY_ANN = { check: check };
})();
