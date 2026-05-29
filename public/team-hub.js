/* Pioneer DCR Hub — Team Hub page controller.
 *
 * Drives /team-hub.html: same staff-auth gate as the other staff pages,
 * plus the role-nav renderer. NO form logic, NO function calls — every
 * primary interaction on this page is an external link out (training
 * platform, form widgets, mailto). The page is purely a portal.
 *
 * Wiring at a glance:
 *   STAFF_AUTH.init()
 *     ↳ onChecking / onSignedOut / onDenied → toggle the auth-screen card
 *     ↳ onAuthorized(staff)                 → paint identity + nav, show content
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // KEEP IN SYNC across five files: app.js, tech.js, admin.js,
  // supply-station.js, team-hub.js. See app.js for the rationale on not
  // extracting this into a shared module.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",            roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                     roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",            roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html",  roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",        roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",        roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",     roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",                roles: ["admin"] }
  ];

  function withCurrentSearch(href) {
    const search = (typeof location !== "undefined" && location.search) || "";
    if (!search) return href;
    return href + (href.indexOf("?") >= 0 ? "&" + search.slice(1) : search);
  }

  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }
    const current = nav.dataset.currentPage || "";
    const items   = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = (i.key === current);
      const cls   = "role-nav-link" + (isActive ? " is-active" : "");
      const aria  = isActive ? ' aria-current="page"' : '';
      if (isActive) return '<span class="' + cls + '"' + aria + '>' + i.label + '</span>';
      return '<a class="' + cls + '" href="' + withCurrentSearch(i.href) + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  // Pioneer Team Hub unread-announcements badge — KEEP IN SYNC across
  // app.js / tech.js / admin.js / supply-station.js / team-hub.js.
  async function paintTeamHubUnreadBadge(staff) {
    if (!staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const db = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        db.collection("announcements").where("active", "==", true).get(),
        db.collection("announcement_reads").where("uid", "==", staff.uid).get()
      ]);
      const readIds = new Set();
      readsSnap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (data.announcement_id) readIds.add(data.announcement_id);
      });
      function toMs(ts) {
        if (!ts) return null;
        if (typeof ts === "number") return ts;
        if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
        if (typeof ts.toMillis === "function") return ts.toMillis();
        if (typeof ts.seconds === "number") return ts.seconds * 1000;
        return null;
      }
      const now = Date.now();
      let unread = 0;
      annsSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.archived_at) return;
        const s = toMs(a.starts_at);   if (s != null && s > now) return;
        const e = toMs(a.expires_at);  if (e != null && e <= now) return;
        if (!readIds.has(d.id)) unread += 1;
      });
      const pills = document.querySelectorAll(".role-nav-link");
      let target = null;
      pills.forEach(function (p) {
        if ((p.textContent || "").trim() === "Pioneer Team Hub") target = p;
      });
      if (!target) return;
      const old = target.querySelector(".role-nav-badge");
      if (old) old.remove();
      if (unread > 0) {
        const dot = document.createElement("span");
        dot.className = "role-nav-badge";
        dot.textContent = unread > 9 ? "9+" : String(unread);
        target.appendChild(dot);
      }
    } catch (err) {
      console.warn("paintTeamHubUnreadBadge failed", err && err.code);
    }
  }

  function paintStaffIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    const cached  = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
                      ? window.STAFF_AUTH.getCachedStaff() : null;
    const displayName =
      (staff && staff.tech && staff.tech.display_name) ||
      (cached && cached.display_name) ||
      "";
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
  }

  function setStaffAuthState(state) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("staff-auth-" + s);
      if (el) el.hidden = s !== state;
    });
    const content = $("staff-auth-content");
    if (content) content.hidden = state !== "content";

    const headerAccount = $("staff-header-account");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
    } else {
      if (headerAccount) headerAccount.hidden = true;
      const nav = $("role-nav");
      if (nav) { nav.hidden = true; nav.innerHTML = ""; }
    }

    document.body.classList.toggle("is-signing-in", state === "signin");

    if (state === "checking") {
      const checkingEl = $("staff-auth-checking");
      const titleEl    = checkingEl && checkingEl.querySelector(".staff-auth-title");
      const cached     = window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
                          ? window.STAFF_AUTH.getCachedStaff() : null;
      if (titleEl) {
        const name = cached && (cached.display_name || cached.email);
        titleEl.textContent = name ? ("Welcome back, " + name + "…") : "Checking access…";
      }
    }
  }

  function setStaffAuthInlineMsg(msg, kind) {
    const el = $("staff-auth-inline-msg");
    if (!el) return;
    if (!msg) {
      el.hidden = true; el.textContent = "";
      el.classList.remove("is-ok");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("is-ok", kind === "ok");
    el.hidden = false;
  }

  /* ---------- sign-in panel wiring (parallels app.js / tech.js / supply-station.js) ---------- */
  function wireSignInButton() {
    const btn = $("staff-signin-btn");
    if (btn) btn.addEventListener("click", async function () {
      if (!window.STAFF_AUTH) return;
      setStaffAuthInlineMsg("");
      btn.disabled = true;
      try {
        const result = await window.STAFF_AUTH.signIn();
        if (result && !result.ok && !result.cancelled) {
          setStaffAuthInlineMsg(result.message, "err");
        }
      } finally {
        btn.disabled = false;
      }
    });

    const form    = $("staff-password-form");
    const submit  = $("staff-password-submit");
    const emailEl = $("staff-email");
    const passEl  = $("staff-password");
    if (form && submit && emailEl && passEl) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        submit.disabled = true;
        const orig = submit.textContent;
        submit.textContent = "Signing in…";
        try {
          const result = await window.STAFF_AUTH.signInWithPassword(emailEl.value, passEl.value);
          if (!result.ok) {
            setStaffAuthInlineMsg(result.message, "err");
            passEl.value = "";
            passEl.focus();
          }
        } finally {
          submit.disabled = false;
          submit.textContent = orig;
        }
      });
    }

    const forgot = $("staff-forgot-link");
    if (forgot && emailEl) {
      forgot.addEventListener("click", async function () {
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        forgot.disabled = true;
        try {
          const result = await window.STAFF_AUTH.sendPasswordReset(emailEl.value);
          setStaffAuthInlineMsg(result.message, result.ok ? "ok" : "err");
        } finally {
          forgot.disabled = false;
        }
      });
    }
  }

  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
  }

  /* ---------- announcements (v1) ----------
   *
   * Reads the `announcements` collection (filtered to currently-active +
   * non-archived + within starts_at..expires_at) and the current user's
   * `announcement_reads` to compute unread state. Renders cards in the
   * top-of-page section. If any UNREAD mandatory announcement is in
   * the active set, opens a blocking modal that the user must clear
   * with "Mark as read" before continuing.
   *
   * v1 caveats:
   *   • Audience is hard-coded to "all_staff" — we don't filter by
   *     audience_type yet. Per-audience targeting comes in a later
   *     version; the field is already stored on the doc.
   *   • Re-reads are idempotent because doc id is `{ann}_{uid}`.
   *   • The unread badge on the Pioneer Team Hub nav pill across other
   *     pages lives in the page-specific JS (app.js / tech.js / etc.)
   *     and re-reads the same collections. The duplication is by design
   *     — see KEEP IN SYNC notes elsewhere.
   */
  const PRIORITY_LABELS = { normal: "Normal", important: "Important", urgent: "Urgent" };
  const PRIORITY_CLS    = { normal: "is-normal", important: "is-important", urgent: "is-urgent" };

  function annTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  function isAnnouncementActiveNow(a) {
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

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Render the "View attachment" anchor IF the announcement has a URL.
  // We trust the admin-side validator (https://-only). Re-checking here
  // adds defense-in-depth — any URL that doesn't start with https:// is
  // dropped so we can't render a javascript: link from a tampered doc.
  function attachmentLinkHtml(a) {
    const url = a && a.attachment_url ? String(a.attachment_url) : "";
    if (!/^https:\/\//i.test(url)) return "";
    const label = (a.attachment_name && String(a.attachment_name).trim()) || "View attachment";
    return '<a class="ann-attachment-btn" target="_blank" rel="noopener noreferrer" href="' +
             escapeHtml(url) + '">📎 ' + escapeHtml(label) + '</a>';
  }

  // Lightweight inline image preview — only emitted when the admin
  // tagged the attachment as `image`. Wrapped in an <a> so a tap on
  // the image opens the full file in a new tab (same behavior as the
  // text button). `loading="lazy"` defers fetch until the card scrolls
  // near the viewport. `onerror` removes the image silently — the
  // View-attachment button stays as the always-on fallback.
  function attachmentPreviewHtml(a) {
    if (!a || a.attachment_type !== "image") return "";
    const url = String(a.attachment_url || "");
    if (!/^https:\/\//i.test(url)) return "";
    const alt = (a.attachment_name && String(a.attachment_name).trim()) || "Attachment image";
    return '<a class="ann-attachment-preview" target="_blank" rel="noopener noreferrer" href="' +
             escapeHtml(url) + '">' +
             '<img loading="lazy" alt="' + escapeHtml(alt) + '" src="' + escapeHtml(url) + '" ' +
                  'onerror="this.closest(\'.ann-attachment-preview\').remove();" />' +
           '</a>';
  }

  // announcementCardHtml(a, isRead, opts?)
  //   opts.compact === true  → past-section variant: skip the big image
  //                            preview, tighter padding (via .is-compact).
  //                            Action row still renders if there's an
  //                            attachment link, so techs can still tap
  //                            through to a file from a past announcement.
  function announcementCardHtml(a, isRead, opts) {
    const compact = !!(opts && opts.compact);
    const priority = a.priority || "normal";
    const prCls    = PRIORITY_CLS[priority] || "is-normal";
    const prLabel  = PRIORITY_LABELS[priority] || priority;
    const pills    = [];
    pills.push('<span class="ann-pill ' + prCls + '">' + escapeHtml(prLabel) + '</span>');
    if (a.mandatory)              pills.push('<span class="ann-pill is-mandatory">Mandatory</span>');
    if (a.requireAcknowledgement) pills.push('<span class="ann-pill is-ackneeded">Acknowledge</span>');
    if (a.requireReply)           pills.push('<span class="ann-pill is-replyneeded">Reply required</span>');
    if (!isRead)                  pills.push('<span class="ann-pill is-unread">Unread</span>');

    // Compact (past) cards never render the big image preview — keeps
    // the collapsed section short even on image-heavy histories.
    const previewHtml    = compact ? "" : attachmentPreviewHtml(a);
    const attachmentHtml = attachmentLinkHtml(a);

    // V2 — acknowledge + reply controls. Hidden on compact (read) view.
    const stateBtns = compact ? "" : (
      '<div class="ann-card-state-btns">' +
        (a.requireAcknowledgement
          ? '<button class="ann-ack-btn" type="button" data-action="ack">Acknowledge</button>'
          : '') +
        '<button class="ann-reply-btn" type="button" data-action="toggle-reply">Reply</button>' +
      '</div>'
    );
    // Comments thread + reply textarea. Hidden by default; the toggle
    // button opens it. For requireReply we'd ideally auto-open, but
    // even then we want the user-initiated action to enter the textarea.
    const threadHtml = compact ? "" : (
      '<div class="ann-thread" data-thread-for="' + escapeHtml(a.id) + '" hidden>' +
        '<div class="ann-thread-comments" data-comments-for="' + escapeHtml(a.id) + '">Loading…</div>' +
        '<div class="ann-thread-replyform">' +
          '<textarea class="ann-thread-replybox" rows="2" maxlength="800" placeholder="Type your reply…"></textarea>' +
          '<button type="button" class="ann-thread-replybtn" data-action="submit-reply">Send reply</button>' +
        '</div>' +
      '</div>'
    );

    return (
      '<article class="ann-card' + (compact ? ' is-compact' : '') +
            (a.requireReply ? ' ann-replyrequired' : '') +
            '" data-id="' + escapeHtml(a.id) + '">' +
        '<div class="ann-card-head">' +
          '<span class="ann-card-title">' + escapeHtml(a.title || "(untitled)") + '</span>' +
          '<span class="ann-card-pills">' + pills.join("") + '</span>' +
        '</div>' +
        '<p class="ann-card-body">' + escapeHtml(a.message || "") + '</p>' +
        previewHtml +
        (attachmentHtml || !isRead
          ? '<div class="ann-card-actions">' +
              attachmentHtml +
              (!isRead
                ? '<button class="ann-mark-read-btn" type="button" data-action="mark-read">Mark as read</button>'
                : '') +
            '</div>'
          : '') +
        stateBtns +
        threadHtml +
      '</article>'
    );
  }

  // Module state for the announcement flow.
  let activeAnnouncements = [];           // currently-active announcements
  let readIds             = new Set();    // announcement IDs the user has read
  let mandatoryQueue      = [];           // unread mandatory announcements yet to acknowledge
  let mandatoryCurrent    = null;         // the one currently displayed in the modal

  // ---- Tech directory + avatar helpers --------------------------------
  // Lazily-loaded /cleaning_techs cache used to put a face on announcement
  // comments. Loaded once after auth; refreshed on demand. Pure read.
  let thTechDirByEmail = new Map();
  let thTechDirBySlug  = new Map();
  async function thLoadTechDir() {
    if (thTechDirByEmail.size > 0) return;
    try {
      const snap = await firebase.firestore().collection("cleaning_techs").get();
      snap.docs.forEach(function (d) {
        const data = d.data() || {};
        const slug = data.tech_slug || d.id;
        const email = String(data.email || "").toLowerCase().trim();
        thTechDirByEmail.set(email, Object.assign({ id: d.id, slug: slug }, data));
        thTechDirBySlug.set(slug, Object.assign({ id: d.id, slug: slug }, data));
      });
    } catch (err) {
      console.warn("[team-hub] tech-dir read failed", err);
    }
  }
  function thGetAvatarUrl(t) {
    if (!t) return "";
    return String(t.photoUrl || t.photo_url || t.avatarUrl || t.avatar_url || t.profilePhotoUrl || "").trim();
  }
  function thSlugToTitle(slug) {
    if (!slug) return "";
    return String(slug).split("-").map(function (p) {
      return p ? p.charAt(0).toUpperCase() + p.slice(1) : p;
    }).join(" ");
  }
  function thResolveCommenter(c) {
    const email = String((c.createdByEmail || "")).toLowerCase().trim();
    const isAdminish = ["admin", "manager", "office_manager"].indexOf(String(c.createdByRole || "")) >= 0;
    let t = null;
    if (email && thTechDirByEmail.has(email)) t = thTechDirByEmail.get(email);
    const fallbackName = c.createdByName || c.createdByEmail || (isAdminish ? "Admin" : "(team)");
    const name = (t && (t.display_name || t.name)) || fallbackName;
    const avatarUrl = thGetAvatarUrl(t);
    const initial = (name.charAt(0) || "P").toUpperCase();
    return { name: name, avatarUrl: avatarUrl, initial: initial, role: c.createdByRole || "", isAdmin: isAdminish };
  }
  function thRenderAvatar(resolved) {
    if (resolved.avatarUrl) {
      return '<span class="ann-thread-avatar"><img src="' + escapeHtml(resolved.avatarUrl) +
             '" alt="" loading="lazy" /></span>';
    }
    return '<span class="ann-thread-avatar ann-thread-avatar-fallback">' + escapeHtml(resolved.initial) + '</span>';
  }

  // V2 audience-match check. Defaults to "all" for pre-V2 docs so legacy
  // all-team announcements stay visible to every signed-in user.
  function announcementTargetsMe(a, staff) {
    if (!a) return false;
    const type = String(a.audienceType || "all");
    if (type === "all") return true;
    if (type !== "selected") return true; // unknown type — fail open
    const myUid   = staff && staff.uid;
    const myEmail = String((staff && staff.email) || "").toLowerCase().trim();
    const mySlug  = String((staff && staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "");
    if (Array.isArray(a.recipientUids) && myUid && a.recipientUids.indexOf(myUid) >= 0) return true;
    if (Array.isArray(a.recipientEmails) && myEmail && a.recipientEmails.indexOf(myEmail) >= 0) return true;
    if (Array.isArray(a.recipientTechSlugs) && mySlug && a.recipientTechSlugs.indexOf(mySlug) >= 0) return true;
    return false;
  }

  async function fetchActiveAnnouncements() {
    const db = firebase.firestore();
    // The Firestore rule rejects a tech reading announcements that don't
    // target them, so the `where("active","==",true)` query returns only
    // docs we're entitled to. We re-apply audience match locally because
    // pre-V2 docs (no audienceType field) are treated as "all" by both
    // the rule and this filter — keeps the semantics in sync.
    const staff = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
      ? window.STAFF_AUTH.getCachedStaff() : null;
    const snap = await db.collection("announcements")
      .where("active", "==", true)
      .get();
    return snap.docs
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(isAnnouncementActiveNow)
      .filter(function (a) { return announcementTargetsMe(a, staff); })
      .sort(function (a, b) {
        // Mandatory urgent first, then by created_at desc.
        const am = a.mandatory ? 0 : 1;
        const bm = b.mandatory ? 0 : 1;
        if (am !== bm) return am - bm;
        const at = annTsToMs(a.created_at) || 0;
        const bt = annTsToMs(b.created_at) || 0;
        return bt - at;
      });
  }

  async function fetchMyReads(uid) {
    const db = firebase.firestore();
    // Per-user reads. Doc id pattern is `{announcementId}_{uid}`. We query
    // by uid field for a single collection sweep — rule allows because
    // resource.data.uid matches request.auth.uid.
    const snap = await db.collection("announcement_reads")
      .where("uid", "==", uid)
      .get();
    const ids = new Set();
    snap.docs.forEach(function (d) {
      const data = d.data() || {};
      if (data.announcement_id) ids.add(data.announcement_id);
    });
    return ids;
  }

  async function markAnnouncementRead(announcementId, uid, email, version) {
    const db    = firebase.firestore();
    const docId = announcementId + "_" + uid;
    const ref   = db.collection("announcement_reads").doc(docId);
    const v     = Number(version) || 1;
    // V6 — also mirror to localStorage so a Firestore write failure
    // (rules glitch, offline) doesn't cause the announcement to
    // re-display on the next page load. Mirrors the cache mandatory-modal.js
    // writes; both use the key `pioneer.annRead.<uid>` JSON map.
    try {
      const key = "pioneer.annRead." + uid;
      const raw = localStorage.getItem(key);
      const map = raw ? (JSON.parse(raw) || {}) : {};
      map[announcementId] = { v: v, t: new Date().toISOString() };
      localStorage.setItem(key, JSON.stringify(map));
    } catch (_e) { /* private mode / quota — soft-fail */ }
    await ref.set({
      announcement_id: announcementId,
      uid:             uid,
      email:           email || "",
      version:         v,
      read_at:         firebase.firestore.FieldValue.serverTimestamp()
    });
    readIds.add(announcementId);
    try {
      console.info("[PioneerOps Announcement] team-hub markRead ok", {
        announcementId: announcementId, version: v, uid: uid
      });
    } catch (_e) {}
  }

  // Cap on the read-but-active "past" section so the collapsed list
  // doesn't grow unbounded on a long-running org.
  const PAST_ANNOUNCEMENT_LIMIT = 10;

  function renderAnnouncements() {
    const section     = $("team-hub-announcements-section");
    const list        = $("team-hub-announcement-list");
    const pastSection = $("team-hub-past-announcements-section");
    const pastList    = $("team-hub-past-announcement-list");
    const pastCount   = $("team-hub-past-announcements-count");
    if (!section || !list) return;

    // Partition: unread → top section (always visible); read → past
    // section (collapsed by default). activeAnnouncements is already
    // sorted (mandatory first, then created_at desc) by
    // fetchActiveAnnouncements, so both buckets preserve that order.
    const unread = [];
    const past   = [];
    activeAnnouncements.forEach(function (a) {
      if (readIds.has(a.id)) past.push(a);
      else                   unread.push(a);
    });

    // ---- Top section (unread only) ----
    if (unread.length === 0) {
      section.hidden = true;
      list.innerHTML = "";
    } else {
      section.hidden = false;
      list.innerHTML = unread
        .map(function (a) { return announcementCardHtml(a, false); })
        .join("");
    }

    // ---- Past section (read + cap) ----
    if (pastSection && pastList) {
      const capped = past.slice(0, PAST_ANNOUNCEMENT_LIMIT);
      if (capped.length === 0) {
        pastSection.hidden = true;
        pastList.innerHTML = "";
        if (pastCount) pastCount.textContent = "0";
      } else {
        pastSection.hidden = false;
        pastList.innerHTML = capped
          .map(function (a) { return announcementCardHtml(a, true, { compact: true }); })
          .join("");
        if (pastCount) pastCount.textContent = String(past.length);
      }
    }
  }

  function showMandatoryModal(a, indexLabel) {
    const modal      = $("mandatory-announcement-modal");
    const titleEl    = $("mandatory-modal-ann-title");
    const messageEl  = $("mandatory-modal-ann-message");
    const progressEl = $("mandatory-modal-progress");
    const errEl      = $("mandatory-modal-err");
    const attachEl   = $("mandatory-modal-ann-attachment");
    if (!modal || !titleEl || !messageEl) return;
    titleEl.textContent   = a.title || "(untitled)";
    messageEl.textContent = a.message || "";
    if (progressEl) progressEl.textContent = indexLabel || "";
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    // Render image preview (if any) + the View attachment anchor.
    // innerHTML is safe — both helpers only emit <a> / <img> tags whose
    // href/src they validated as https://.
    if (attachEl) attachEl.innerHTML = attachmentPreviewHtml(a) + attachmentLinkHtml(a);
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function hideMandatoryModal() {
    const modal = $("mandatory-announcement-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function processMandatoryQueue() {
    mandatoryCurrent = mandatoryQueue.shift();
    if (!mandatoryCurrent) { hideMandatoryModal(); return; }
    const totalRemaining = mandatoryQueue.length + 1;
    const progressLabel  = totalRemaining > 1
      ? "You have " + totalRemaining + " required announcements to acknowledge."
      : "You have 1 required announcement to acknowledge.";
    showMandatoryModal(mandatoryCurrent, progressLabel);
  }

  function wireMandatoryModal(staff) {
    const btn = $("mandatory-modal-mark-read");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      if (!mandatoryCurrent) { hideMandatoryModal(); return; }
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "Saving…";
      const errEl = $("mandatory-modal-err");
      if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
      try {
        await markAnnouncementRead(mandatoryCurrent.id, staff.uid, staff.email);
        renderAnnouncements();
        processMandatoryQueue();
      } catch (err) {
        console.error("mark-as-read failed", err);
        if (errEl) {
          errEl.textContent = "Couldn't save. Check your connection and try again.";
          errEl.hidden = false;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  }

  function wireInlineMarkRead(staff) {
    const list = $("team-hub-announcement-list");
    if (!list) return;
    list.addEventListener("click", async function (ev) {
      const actionEl = ev.target.closest("[data-action]");
      if (!actionEl) return;
      const card = actionEl.closest(".ann-card");
      if (!card) return;
      const annId = card.dataset.id;
      const action = actionEl.getAttribute("data-action");
      if (action === "mark-read") {
        actionEl.disabled = true;
        try {
          await markAnnouncementRead(annId, staff.uid, staff.email);
          renderAnnouncements();
        } catch (err) {
          console.error("inline mark-as-read failed", err);
          actionEl.disabled = false;
        }
        return;
      }
      if (action === "ack") {
        actionEl.disabled = true;
        actionEl.textContent = "Saving…";
        try {
          await writeRecipientStatus(annId, staff, "acknowledged");
          actionEl.textContent = "Acknowledged ✓";
        } catch (err) {
          console.error("acknowledge failed", err);
          actionEl.disabled = false;
          actionEl.textContent = "Acknowledge";
        }
        return;
      }
      if (action === "toggle-reply") {
        const thread = card.querySelector(".ann-thread");
        if (!thread) return;
        if (thread.hidden) {
          thread.hidden = false;
          // Lazy-load comments + write a "viewed" status the first time.
          // Also warm the tech directory so avatars resolve.
          thLoadTechDir();
          mountAnnouncementComments(annId, card, staff);
          writeRecipientStatus(annId, staff, "viewed").catch(function () {});
        } else {
          thread.hidden = true;
        }
        return;
      }
      if (action === "submit-reply") {
        const thread = card.querySelector(".ann-thread");
        const ta  = thread && thread.querySelector(".ann-thread-replybox");
        const body = String((ta && ta.value) || "").trim();
        if (!body) { if (ta) ta.focus(); return; }
        actionEl.disabled = true;
        actionEl.textContent = "Sending…";
        try {
          await firebase.firestore().collection("announcements").doc(annId)
            .collection("comments").add({
              body:           body,
              createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
              createdByUid:   staff.uid,
              createdByEmail: String(staff.email || "").toLowerCase(),
              createdByName:  staff.display_name || (staff.tech && staff.tech.display_name) || staff.email || "(tech)",
              createdByRole:  staff.role || "cleaning_tech",
              visibility:     "announcement_recipients",
              source:         "team_hub"
            });
          if (ta) ta.value = "";
          await writeRecipientStatus(annId, staff, "replied");
          // Re-render so the require-reply card sheds its "open" state.
          renderAnnouncements();
        } catch (err) {
          console.error("submit reply failed", err);
          alert("Couldn't send reply: " + (err && err.message));
          actionEl.disabled = false;
          actionEl.textContent = "Send reply";
        }
      }
    });
  }

  async function writeRecipientStatus(annId, staff, newStatus) {
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const update = {
      uid:         staff.uid,
      techSlug:    String((staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || ""),
      displayName: String((staff.display_name || (staff.tech && staff.tech.display_name) || staff.email) || ""),
      status:      newStatus,
      deliveredAt: sts
    };
    if (newStatus === "viewed")       update.viewedAt       = sts;
    if (newStatus === "acknowledged") update.acknowledgedAt = sts;
    if (newStatus === "replied")      update.repliedAt      = sts;
    await firebase.firestore().collection("announcements").doc(annId)
      .collection("recipient_status").doc(staff.uid)
      .set(update, { merge: true });
  }

  // Subscribe a card's comments thread to live updates. Idempotent —
  // a re-mount unsubs the prior listener for the same announcement.
  const _annCommentUnsubs = Object.create(null);
  function mountAnnouncementComments(annId, card, staff) {
    if (_annCommentUnsubs[annId]) return;
    const root = card.querySelector('.ann-thread-comments[data-comments-for="' + annId + '"]');
    if (!root) return;
    _annCommentUnsubs[annId] = firebase.firestore()
      .collection("announcements").doc(annId)
      .collection("comments")
      .orderBy("createdAt", "asc")
      .onSnapshot(function (snap) {
        renderTeamHubAnnouncementComments(root, snap.docs.map(function (d) {
          return Object.assign({ _id: d.id }, d.data());
        }));
      }, function (err) {
        root.innerHTML = '<div class="ann-thread-error">Couldn\'t load replies: ' + escapeHtml(err.message || "") + '</div>';
      });
  }
  function renderTeamHubAnnouncementComments(root, comments) {
    if (comments.length === 0) {
      root.innerHTML = '<div class="ann-thread-empty">No replies yet.</div>';
      return;
    }
    root.innerHTML = comments.map(function (c) {
      const resolved = thResolveCommenter(c);
      const when = c.createdAt && c.createdAt.toDate
        ? c.createdAt.toDate().toLocaleString("en-US", {
            month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true
          })
        : "";
      const roleChip = resolved.isAdmin
        ? '<span class="ann-thread-role">' + escapeHtml(resolved.role || "admin") + '</span>'
        : '';
      const avatarHtml = thRenderAvatar(resolved);
      return '<div class="ann-thread-comment ' + (resolved.isAdmin ? "is-admin" : "") + '">' +
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

  // Past announcements toggle — flips the list visibility + the button
  // label. Pure DOM, no Firestore reads. Wired once on boot.
  function wirePastAnnouncementsToggle() {
    const toggle = $("team-hub-past-announcements-toggle");
    const list   = $("team-hub-past-announcement-list");
    const label  = toggle && toggle.querySelector(".team-hub-past-label");
    if (!toggle || !list) return;
    toggle.addEventListener("click", function () {
      const wasExpanded = toggle.getAttribute("aria-expanded") === "true";
      const nowExpanded = !wasExpanded;
      toggle.setAttribute("aria-expanded", nowExpanded ? "true" : "false");
      list.hidden = !nowExpanded;
      if (label) {
        label.textContent = nowExpanded ? "Hide past announcements" : "Show past announcements";
      }
    });
  }

  /* Today's Work workflow lives on /work.html now — see today-work.js
     for the implementation. Removed from Team Hub so this page stays
     focused on training/forms/announcements. */
  /* end placeholder for removed workflow block */

  /* ====================================================================
     Pioneer Quality (public visibility on Team Hub)
     ====================================================================
     Reads pioneerQualityViewV1, which Admin-SDK-reads /inspections
     and returns a public-safe payload (rolling score + recent 5-star
     wins). NO inspector identity, NO per-area breakdown, NO low
     scores — morale surface only. Soft-fails to "Awaiting inspections"
     so a missing function URL or transient error never kills the
     rest of Team Hub.
     ==================================================================== */

  function thToneForScore(score) {
    const s = typeof score === "number" ? score : 3;
    if (s >= 4.5) return "tone-5";
    if (s >= 3.5) return "tone-4";
    if (s >= 2.5) return "tone-3";
    if (s >= 1.5) return "tone-2";
    return "tone-1";
  }
  function thLabelForScore(score) {
    if (score == null) return "Awaiting inspections";
    if (score >= 4.5) return "Excellent · " + score.toFixed(1);
    if (score >= 3.5) return "Great · " + score.toFixed(1);
    if (score >= 2.5) return "Acceptable · " + score.toFixed(1);
    if (score >= 1.5) return "Needs work · " + score.toFixed(1);
    return "Critical · " + score.toFixed(1);
  }
  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function thFormatDate(iso) {
    if (!iso) return "";
    try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)); }
    catch (e) { return ""; }
  }

  /* ---------- Upcoming Team Schedule (Deputy-powered snapshot) ----------
     Reads `published_team_schedule/current` AND `team_schedule/current`
     (PDF backup, now folded into this same card). Renders a compact
     teaser of the next few shifts grouped by day; the full filterable
     view lives at /team-schedule.html (the "View Full Schedule" button
     below opens it).

     Deferred-publish model: this is NOT a live view of Deputy. Admins
     publish via Admin → Schedule when ready.

     Phase 2 TODO (mirror admin.js + firestore.rules):
       • monthly calendar view + printable export
       • personal "my schedule" filtering for cleaning techs
       • shift swaps / PTO overlays / open-shift coverage
       • live vs deferred publish modes (currently always deferred)
       • "Open Deputy" deep-link per shift */
  function thEscapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function thFormatDateLabel(yyyymmdd) {
    if (!yyyymmdd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) {
      return yyyymmdd;
    }
  }

  function thFormatPublishedAt(ts) {
    if (!ts) return "Unknown";
    let ms = null;
    if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    else if (typeof ts === "number") ms = ts;
    else if (typeof ts === "string") { const t = Date.parse(ts); ms = isNaN(t) ? null : t; }
    if (ms == null) return "Unknown";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium", timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderPublishedSnapshotDays(shifts) {
    const container = $("th-published-days");
    if (!container) return;
    if (!Array.isArray(shifts) || shifts.length === 0) {
      container.innerHTML = "";
      container.hidden = true;
      return;
    }
    // Group by date in insertion order — admin.js already sorted by
    // (date asc, startMs asc, techName asc).
    const byDay = new Map();
    shifts.forEach(function (s) {
      const key = s.date || "";
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    });
    const blocks = [];
    byDay.forEach(function (rows, date) {
      const dayLabel = thFormatDateLabel(date);
      const rowsHtml = rows.map(function (s) {
        const techName    = thEscapeHtml(s.techName || "");
        const customer    = thEscapeHtml(thResolveDisplayName(s) || "Unassigned");
        const timeRange   = s.endTime
          ? (thEscapeHtml(s.startTime) + "–" + thEscapeHtml(s.endTime))
          :  thEscapeHtml(s.startTime);
        return (
          '<li class="th-published-row">' +
            '<span class="th-published-tech">'     + techName  + '</span>' +
            '<span class="th-published-sep" aria-hidden="true">·</span>' +
            '<span class="th-published-customer">' + customer  + '</span>' +
            '<span class="th-published-sep th-published-sep--time" aria-hidden="true">·</span>' +
            '<span class="th-published-time">'     + timeRange + '</span>' +
          '</li>'
        );
      }).join("");
      blocks.push(
        '<section class="th-published-day">' +
          '<h3 class="th-published-day-head">' + thEscapeHtml(dayLabel) + '</h3>' +
          '<ul class="th-published-rows">' + rowsHtml + '</ul>' +
        '</section>'
      );
    });
    container.innerHTML = blocks.join("");
    container.hidden = false;
  }

  // Compact teaser — render at most N upcoming shifts so Team Hub
  // stays scannable. The full schedule view (filters + week toggle)
  // lives on /team-schedule.html.
  const TEAM_HUB_TEASER_LIMIT = 5;

  // Customer-by-slug directory, used as a render-time fallback when the
  // snapshot was published before an admin edited /customers/{slug}.
  // Lets the helper override the snapshot's stale customerName without
  // requiring an admin to re-sync. Empty Map = pure snapshot rendering.
  let thCustomerDirectory = new Map();
  async function thLoadCustomerDirectory() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore().collection("customers").get();
      thCustomerDirectory = new Map();
      snap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (data.active === false) return;
        const slug = data.customer_slug || d.id;
        if (!slug) return;
        thCustomerDirectory.set(String(slug).trim(), Object.assign({ id: d.id }, data));
      });
    } catch (err) {
      console.warn("[team-hub] customer directory read failed", err);
      thCustomerDirectory = new Map();
    }
  }
  function thResolveDisplayName(s) {
    if (!s) return "";
    const slug = String(s.customerSlug || s.customer_slug || "").trim();
    if (slug && thCustomerDirectory.has(slug) && window.PioneerCustomerDisplay) {
      const helperName = window.PioneerCustomerDisplay.getCustomerDisplayName(thCustomerDirectory.get(slug));
      if (helperName) return helperName;
    }
    return String(s.customerName || s.customer_name || "").trim();
  }

  async function bootPublishedScheduleForStaff(staff) {
    const section = $("team-hub-published-schedule-section");
    if (!section || !staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;

    let pubSnap, pdfSnap;
    try {
      // Pull all three in parallel — pubSnap is the snapshot, pdfSnap is
      // the legacy PDF backup, and the customer directory powers the
      // render-time display-name fallback.
      const results = await Promise.all([
        firebase.firestore().collection("published_team_schedule").doc("current").get(),
        firebase.firestore().collection("team_schedule").doc("current").get(),
        thLoadCustomerDirectory()
      ]);
      pubSnap = results[0];
      pdfSnap = results[1];
    } catch (err) {
      console.warn("[team-hub] schedule read failed", err);
      return; // stay hidden — never show error on the morale surface
    }

    const data = (pubSnap && pubSnap.exists && pubSnap.data()) || null;
    const pdf  = (pdfSnap && pdfSnap.exists && pdfSnap.data()) || null;
    const hasPdf = !!(pdf && pdf.downloadUrl && pdf.active !== false);

    const metaEl     = $("th-published-meta");
    const rangeEl    = $("th-published-range");
    const whenEl     = $("th-published-when");
    const notesEl    = $("th-published-notes");
    const daysEl     = $("th-published-days");
    const emptyEl    = $("th-published-empty");
    const adminEmpty = $("th-published-admin-empty");
    const subEl      = $("th-published-sub");
    const actionsEl  = $("th-published-actions");
    const pdfViewEl  = $("th-published-pdf-link");
    const pdfDlEl    = $("th-published-pdf-download");
    const overflowEl = $("th-published-overflow");
    const overflowN  = $("th-published-overflow-count");

    // No snapshot AND no PDF — admins see a hint, techs see nothing.
    if (!data || data.active === false || !Array.isArray(data.shifts)) {
      if (staff.role === "admin" && adminEmpty) {
        adminEmpty.hidden = false;
        section.hidden    = false;
      }
      return;
    }

    if (rangeEl) {
      rangeEl.textContent =
        (data.startDate || "—") + " → " + (data.endDate || "—") +
        (data.viewRangeDays ? "  (" + data.viewRangeDays + " days)" : "");
    }
    if (whenEl)  whenEl.textContent  = "Published " + thFormatPublishedAt(data.publishedAt);
    if (metaEl)  metaEl.hidden = false;

    if (notesEl) {
      if (data.notes) { notesEl.textContent = data.notes; notesEl.hidden = false; }
      else            { notesEl.hidden = true; notesEl.textContent = ""; }
    }
    if (subEl) {
      subEl.textContent = data.shiftCount
        ? "Next " + Math.min(data.shiftCount, TEAM_HUB_TEASER_LIMIT) +
          " of " + data.shiftCount + " upcoming shifts. Open the full view below for filters."
        : "The published team schedule. Updated by an admin when ready.";
    }

    const allShifts = data.shifts || [];
    if (allShifts.length === 0) {
      if (daysEl)  { daysEl.innerHTML = ""; daysEl.hidden = true; }
      if (emptyEl) emptyEl.hidden = false;
      if (overflowEl) overflowEl.hidden = true;
    } else {
      const teaser = allShifts.slice(0, TEAM_HUB_TEASER_LIMIT);
      renderPublishedSnapshotDays(teaser);
      if (emptyEl) emptyEl.hidden = true;
      const overflow = allShifts.length - teaser.length;
      if (overflowEl) {
        if (overflow > 0) {
          if (overflowN) overflowN.textContent = String(overflow);
          overflowEl.hidden = false;
        } else {
          overflowEl.hidden = true;
        }
      }
    }

    // Actions row — "View Full Schedule" is always shown when a
    // snapshot exists. PDF buttons appear only when a PDF backup is
    // uploaded; this is how the separate Printable Schedule card got
    // folded into this one.
    if (pdfViewEl && pdfDlEl) {
      if (hasPdf) {
        pdfViewEl.href = pdf.downloadUrl;
        pdfDlEl.href   = pdf.downloadUrl;
        pdfDlEl.setAttribute("download", pdf.fileName || "team-schedule.pdf");
        pdfViewEl.hidden = false;
        pdfDlEl.hidden   = false;
      } else {
        pdfViewEl.hidden = true;
        pdfDlEl.hidden   = true;
      }
    }
    if (actionsEl) actionsEl.hidden = false;

    if (adminEmpty) adminEmpty.hidden = true;
    section.hidden = false;
  }

  async function bootQualityForStaff(staff) {
    const section = $("team-hub-quality-section");
    if (!section || !staff || !staff.uid) return;
    const url = (window.PIONEER_QUALITY_VIEW_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      // Mis-configured: stay hidden rather than show a placeholder.
      return;
    }

    section.hidden = false;
    let body = null;
    try {
      const idToken = (window.STAFF_AUTH && await window.STAFF_AUTH.getIdToken()) || null;
      if (!idToken) return;
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": "Bearer " + idToken }
      });
      body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body || !body.ok) {
        console.warn("[team-hub] pioneerQualityViewV1 returned", res.status, body);
        // Keep the section hidden if the call fails — morale-positive
        // default: don't show "error" on a public morale card.
        section.hidden = true;
        return;
      }
    } catch (err) {
      console.warn("[team-hub] pioneerQualityViewV1 fetch failed", err);
      section.hidden = true;
      return;
    }

    // Score card.
    const card  = $("th-quality-card");
    const value = $("th-quality-value");
    const label = $("th-quality-label");
    const sub   = $("th-quality-sub");
    const streakEl = $("th-quality-streak");
    const rolling = (typeof body.overall_score === "number") ? body.overall_score : null;
    if (value && label && sub && card) {
      if (rolling == null) {
        value.textContent = "—";
        label.textContent = "Awaiting inspections";
        sub.textContent   = "Rolling 30-day average · 0 inspections in window";
        card.setAttribute("data-tone", "tone-3");
      } else {
        value.textContent = rolling.toFixed(1);
        label.textContent = thLabelForScore(rolling);
        sub.textContent   = "Rolling " + (body.window_days || 30) + "-day average · " +
                            (body.count || 0) + " inspection" + ((body.count || 0) === 1 ? "" : "s");
        card.setAttribute("data-tone", thToneForScore(rolling));
      }
    }
    // Company streak chip — only renders when streak > 0.
    if (streakEl) {
      const streak = typeof body.company_streak === "number" ? body.company_streak : 0;
      if (streak > 0) {
        streakEl.hidden = false;
        const threshold = (typeof body.streak_threshold === "number") ? body.streak_threshold : 4.5;
        streakEl.innerHTML = '<span aria-hidden="true">🔥</span> ' +
          streak + ' in a row above ' + threshold.toFixed(1);
      } else {
        streakEl.hidden = true;
        streakEl.textContent = "";
      }
    }

    // 5-star wins.
    const wins   = Array.isArray(body.recent_five_star_wins) ? body.recent_five_star_wins : [];
    const winsEl = $("th-wins");
    const list   = $("th-wins-list");
    const empty  = $("th-wins-empty");
    if (wins.length > 0 && winsEl && list) {
      list.innerHTML = wins.map(function (w) {
        return (
          '<li class="th-wins-item">' +
            '<span class="th-wins-emoji" aria-hidden="true">🌟</span>' +
            '<div class="th-wins-text">' +
              '<strong class="th-wins-customer">' + escapeText(w.customer_name || w.location_name || "(customer)") + '</strong>' +
              '<span class="th-wins-meta">' +
                escapeText(thFormatDate(w.inspection_date)) +
                ' · ' + escapeText((typeof w.overall_score === "number") ? w.overall_score.toFixed(1) : "—") +
              '</span>' +
            '</div>' +
          '</li>'
        );
      }).join("");
      winsEl.hidden = false;
      if (empty) empty.hidden = true;
    } else if (rolling == null) {
      // No data at all — show the friendly empty line.
      if (winsEl) winsEl.hidden = true;
      if (empty)  empty.hidden  = false;
    } else {
      // We have inspections but nothing >= 4.8 in the window. Hide
      // the wins section quietly; the morale-card carries the day.
      if (winsEl) winsEl.hidden = true;
      if (empty)  empty.hidden  = true;
    }
  }

  async function bootAnnouncementsForStaff(staff) {
    if (!staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") {
      console.warn("[team-hub] firestore SDK not available — skipping announcements");
      return;
    }
    try {
      const [anns, myReads] = await Promise.all([
        fetchActiveAnnouncements(),
        fetchMyReads(staff.uid)
      ]);
      activeAnnouncements = anns;
      readIds             = myReads;
      renderAnnouncements();

      // Queue any unread mandatory announcements for the blocking modal.
      mandatoryQueue = activeAnnouncements.filter(function (a) {
        return a.mandatory && !readIds.has(a.id);
      });
      if (mandatoryQueue.length > 0) processMandatoryQueue();
    } catch (err) {
      console.error("announcements load failed", err);
      // Non-fatal — the rest of the Team Hub still works.
    }
  }

  /* ---------- Open Shifts badge ----------
     Count open_shift_requests with status="open" and surface the
     number on the Pick Up Open Shift card. Soft-fails silently;
     the card itself still works as a static link. */
  async function bootOpenShiftsBadge() {
    const badge = $("th-open-shifts-badge");
    if (!badge) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("open_shift_requests")
        .where("status", "==", "open")
        .limit(20).get();
      const n = snap.size;
      if (n > 0) {
        badge.textContent = n + " open · pick one up";
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (err) {
      console.warn("[team-hub] open shifts badge read failed", err);
    }
  }

  /* ---------- Rockstar Team Players this month ----------
     Reads rockstar_bonuses where monthKey = current Pacific YYYY-MM.
     Groups by techId; renders names + counts only (no dollar amounts
     in tech-facing view). Hidden when zero entries this month. */
  async function bootRockstarRecognition() {
    const section = $("team-hub-rockstar-section");
    const listEl  = $("th-rockstar-list");
    if (!section || !listEl) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;

    const monthKey = (function () {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit"
        }).format(new Date());
        return parts.slice(0, 7); // YYYY-MM
      } catch (_e) {
        return new Date().toISOString().slice(0, 7);
      }
    })();

    try {
      const snap = await firebase.firestore()
        .collection("rockstar_bonuses")
        .where("monthKey", "==", monthKey)
        .limit(200).get();
      if (snap.empty) { section.hidden = true; return; }

      // Group by techId (fallback to techName when slug missing).
      const byTech = new Map();
      snap.docs.forEach(function (d) {
        const x = d.data() || {};
        const key  = x.techId || x.techName || "tech";
        const name = x.techName || x.techId || "Tech";
        if (!byTech.has(key)) byTech.set(key, { name: name, count: 0 });
        byTech.get(key).count += 1;
      });
      const ranked = Array.from(byTech.values())
        .sort(function (a, b) { return b.count - a.count; });

      listEl.innerHTML = ranked.map(function (r) {
        return (
          '<li class="team-hub-rockstar-row">' +
            '<span class="team-hub-rockstar-name">' +
              String(r.name).replace(/[<>&]/g, function (c) {
                return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;";
              }) +
            '</span>' +
            '<span class="team-hub-rockstar-count">' +
              r.count + (r.count === 1 ? " covered shift" : " covered shifts") +
            '</span>' +
          '</li>'
        );
      }).join("");
      section.hidden = false;
    } catch (err) {
      // Index error on first run is fine; the section just stays hidden.
      console.warn("[team-hub] rockstar recognition read failed", err);
    }
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
    setStaffAuthState("checking");
    try {
      window.STAFF_AUTH.init({
        onChecking:   function () { setStaffAuthState("checking"); },
        onSignedOut:  function () { setStaffAuthState("signin"); },
        onDenied:     function (info) {
          setStaffAuthState("denied");
          const msgEl = $("staff-auth-denied-msg");
          if (msgEl && info && info.message) msgEl.textContent = info.message;
        },
        onAuthorized: function (staff) {
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);
          // Wire mandatory-modal Mark as Read + inline Mark as Read once
          // we know who the staff member is. Both close over `staff`.
          wireMandatoryModal(staff);
          wireInlineMarkRead(staff);
          // Past-announcements toggle doesn't need `staff` but it's
          // safe to wire here since the DOM is ready.
          wirePastAnnouncementsToggle();
          // Load announcements + reads, render, possibly pop modal.
          // Also paints the nav-pill badge after the data lands.
          bootAnnouncementsForStaff(staff).then(function () {
            paintTeamHubUnreadBadge(staff);
          });
          // Pioneer Quality (public-safe morale surface). Soft-fails;
          // doesn't block the rest of the page.
          bootQualityForStaff(staff);
          // Upcoming Team Schedule — Deputy-powered snapshot + folded
          // PDF backup links. Reads published_team_schedule/current
          // AND team_schedule/current in parallel. Soft-fails;
          // non-blocking.
          bootPublishedScheduleForStaff(staff);
          // Open-shifts badge on the Pick Up Open Shift card +
          // Rockstar Team Players recognition. Both soft-fail
          // independently. Today's Work lives on /work.html.
          bootOpenShiftsBadge();
          bootRockstarRecognition();
        }
      });
    } catch (err) {
      console.error("STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
      const msgEl = $("staff-auth-denied-msg");
      if (msgEl) msgEl.textContent = "Couldn't start sign-in. Hard-reload (Cmd+Shift+R).";
    }
  });
})();
