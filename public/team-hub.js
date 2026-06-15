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
  //
  // V20260614c — Audience filter inlined. Previously the badge trusted
  // the Firestore rule to filter audience-mismatched announcements, but
  // admins (isPioneerAdmin() rule-bypass) read EVERY active doc — so
  // admin badges over-counted by the number of audienceType="selected"
  // announcements that don't include them. The team-hub UI applies
  // announcementTargetsMe locally for exactly this reason; we mirror
  // it here so badge count === number of cards the hub would render.
  // Pass-through helper because each KEEP-IN-SYNC copy lives in its
  // own IIFE — no shared module yet.
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
      const myUid   = (staff && staff.uid) || null;
      const myEmail = String((staff && staff.email) || "").toLowerCase().trim();
      const mySlug  = String((staff && staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "");
      function targetsMe(a) {
        if (!a) return false;
        const type = String(a.audienceType || "all");
        if (type === "all") return true;
        if (type !== "selected") return true;  // unknown — fail open
        if (Array.isArray(a.recipientUids)      && myUid   && a.recipientUids.indexOf(myUid) >= 0) return true;
        if (Array.isArray(a.recipientEmails)    && myEmail && a.recipientEmails.indexOf(myEmail) >= 0) return true;
        if (Array.isArray(a.recipientTechSlugs) && mySlug  && a.recipientTechSlugs.indexOf(mySlug) >= 0) return true;
        return false;
      }
      const now = Date.now();
      let unread = 0;
      annsSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.archived_at) return;
        const s = toMs(a.starts_at);   if (s != null && s > now) return;
        const e = toMs(a.expires_at);  if (e != null && e <= now) return;
        if (!targetsMe(a)) return;                                     // V20260614c
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
        dot.setAttribute("aria-label", unread + " unread announcement" + (unread === 1 ? "" : "s"));
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
    // V20260614c — repaint the nav badge so the user sees the count
    // drop immediately. Without this the badge in role-nav stayed
    // at its page-load value until the next full navigation, which
    // looked like "I marked it read but the red dot is still there".
    try {
      const cached = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
        ? window.STAFF_AUTH.getCachedStaff() : null;
      paintTeamHubUnreadBadge(cached || { uid: uid, email: email });
    } catch (_e) { /* non-fatal */ }
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

  /* ---------- Phase 1C — Leadership Messages ----------
     One-way leadership notes from executives (April/Nick). Two queries
     in parallel: team broadcasts + this tech's personal messages. Show
     queued messages whose deliverAfter has passed; Acknowledge or
     Dismiss flips status to delivered/dismissed so they don't return.
     NOT chat, NOT inbox — there are no replies. */
  async function bootLeadershipMessagesForStaff(staff) {
    if (!staff) return;
    const section = $("team-hub-leadership-section");
    const list    = $("team-hub-leadership-list");
    if (!section || !list) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;

    const myEmail = String((staff.email || "")).toLowerCase().trim();
    const db      = firebase.firestore();
    const nowMs   = Date.now();

    try {
      const queries = [
        db.collection("leadership_messages")
          .where("recipientType", "==", "team")
          .where("status", "==", "queued")
          .limit(20).get()
      ];
      if (myEmail) {
        queries.push(
          db.collection("leadership_messages")
            .where("recipientType", "==", "employee")
            .where("recipientId",   "==", myEmail)
            .where("status",        "==", "queued")
            .limit(20).get()
        );
      }
      const snaps = await Promise.all(queries);
      const docsAll = [];
      snaps.forEach(function (snap) {
        snap.docs.forEach(function (d) {
          docsAll.push(Object.assign({ _id: d.id }, d.data() || {}));
        });
      });

      // Filter by deliverAfter (working-hours protection) + sort newest first.
      const ready = docsAll.filter(function (m) {
        const ms = leadershipTsToMs(m.deliverAfter);
        return !ms || ms <= nowMs;
      }).sort(function (a, b) {
        return leadershipTsToMs(b.createdAt) - leadershipTsToMs(a.createdAt);
      });

      if (!ready.length) { section.hidden = true; return; }

      list.innerHTML = ready.map(renderLeadershipCardHtml).join("");
      section.hidden = false;
      wireLeadershipButtons(staff);
    } catch (err) {
      console.warn("[team-hub] leadership messages read failed", err);
    }
  }

  function leadershipTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts === "string")            { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    return 0;
  }

  function leadershipEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderLeadershipCardHtml(m) {
    const typeLabel = m.messageType === "recognition" ? "Recognition"
                    : m.messageType === "coaching"    ? "A note for you"
                    : "From Leadership";
    const fromWho = m.createdBy ? "From " + m.createdBy.split("@")[0] : "From Leadership";
    return (
      '<article class="team-hub-leadership-card" data-msg-id="' + leadershipEscape(m._id) + '">' +
        '<header class="team-hub-leadership-head">' +
          '<span class="team-hub-leadership-type">' + leadershipEscape(typeLabel) + '</span>' +
          '<span class="team-hub-leadership-from">' + leadershipEscape(fromWho) + '</span>' +
        '</header>' +
        '<p class="team-hub-leadership-body">' + leadershipEscape(m.messageBody || "") + '</p>' +
        '<div class="team-hub-leadership-btns">' +
          '<button type="button" class="team-hub-leadership-ack" data-msg-action="ack">Acknowledge</button>' +
          '<button type="button" class="team-hub-leadership-dismiss" data-msg-action="dismiss">Dismiss</button>' +
        '</div>' +
        '<p class="team-hub-leadership-status" data-msg-status></p>' +
      '</article>'
    );
  }

  function wireLeadershipButtons(staff) {
    document.querySelectorAll(".team-hub-leadership-card").forEach(function (card) {
      card.querySelectorAll("[data-msg-action]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          handleLeadershipClick(card, btn, staff);
        });
      });
    });
  }

  async function handleLeadershipClick(card, btn, staff) {
    const msgId  = card.getAttribute("data-msg-id");
    const action = btn.getAttribute("data-msg-action");
    const status = card.querySelector("[data-msg-status]");
    if (!msgId) return;
    const nextStatus = action === "ack" ? "delivered" : "dismissed";
    btn.disabled = true;
    if (status) status.textContent = action === "ack" ? "Thank you." : "";
    try {
      await firebase.firestore().collection("leadership_messages").doc(msgId).update({
        status:       nextStatus,
        deliveredAt:  firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:   firebase.firestore.FieldValue.serverTimestamp()
      });
      // Remove the card with a soft fade
      card.style.transition = "opacity 0.3s ease";
      card.style.opacity = "0";
      setTimeout(function () {
        card.remove();
        const list = $("team-hub-leadership-list");
        if (list && !list.children.length) {
          const section = $("team-hub-leadership-section");
          if (section) section.hidden = true;
        }
      }, 320);
    } catch (err) {
      console.error("[team-hub] leadership message update failed", err);
      if (status) {
        status.textContent = "Couldn't save — try again.";
        status.setAttribute("data-tone", "error");
      }
      btn.disabled = false;
    }
  }

  /* ---------- Phase 3B — Messages from Pioneer (thread-based) ----------
     Reads communication_messages addressed to the tech (via recipient_id)
     OR team broadcasts. For each unique thread the tech is touched by,
     show the latest outbound message + a reply box. Reply writes an
     inbound message on the same thread via window.CommThreads.addMessage. */
  async function bootCommMessagesForStaff(staff) {
    if (!staff) return;
    if (!window.CommThreads) return;
    const section = $("team-hub-comm-section");
    const list    = $("team-hub-comm-list");
    if (!section || !list) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;

    const myEmail = String((staff.email || "")).toLowerCase().trim();
    if (!myEmail) return;
    const db = firebase.firestore();

    try {
      // Two parallel reads, mirroring the leadership-messages pattern.
      // We could query by thread participation directly, but going via
      // messages keeps the surface tied to "what was addressed to me"
      // rather than "every thread I'm in" — clearer for the tech.
      // Use the (recipient_type, recipient_id, status, deliver_after)
      // composite index without an explicit DESC orderBy so we don't
      // need a separate DESC variant. Sort client-side after fetch —
      // the per-tech result set is bounded enough that the limit is
      // unlikely to truncate meaningful unread traffic.
      const [personal, broadcast] = await Promise.all([
        db.collection("communication_messages")
          .where("recipient_type", "==", "employee")
          .where("recipient_id",   "==", myEmail)
          .where("status",         "==", "delivered")
          .limit(50).get()
          .catch(function () { return { docs: [] }; }),
        db.collection("communication_messages")
          .where("recipient_type", "==", "team")
          .where("status",         "==", "delivered")
          .limit(50).get()
          .catch(function () { return { docs: [] }; })
      ]);
      const docsAll = [];
      [personal, broadcast].forEach(function (snap) {
        snap.docs.forEach(function (d) {
          docsAll.push(Object.assign({ _id: d.id }, d.data() || {}));
        });
      });
      // Group by thread_id, keep latest message per thread that the tech
      // hasn't already read. Filter to outbound (admin → tech) so a
      // tech's own reply doesn't echo back as something to acknowledge.
      const byThread = new Map();
      docsAll.forEach(function (m) {
        if (m.direction !== "outbound") return;
        if (!m.thread_id) return;
        const existing = byThread.get(m.thread_id);
        if (!existing) { byThread.set(m.thread_id, m); return; }
        if (commTsToMs(m.created_at) > commTsToMs(existing.created_at)) {
          byThread.set(m.thread_id, m);
        }
      });
      const latestByThread = Array.from(byThread.values()).sort(function (a, b) {
        return commTsToMs(b.created_at) - commTsToMs(a.created_at);
      });

      if (!latestByThread.length) { section.hidden = true; return; }

      // For each thread, fetch the thread doc so we know the subject /
      // category / category-rail / participants. Done in parallel.
      const threadDocs = await Promise.all(latestByThread.map(function (m) {
        return window.CommThreads.findThreadById(m.thread_id).catch(function () { return null; });
      }));

      // Phase 3B.1 — only show threads where management is waiting on
      // the employee (or legacy 'open' status). After the tech replies,
      // addMessage flips the thread to waiting_on_management and the
      // card disappears from this inbox on the next reload. Resolved /
      // closed threads also drop off automatically.
      const VISIBLE_TO_TECH = ["waiting_on_employee", "open"];
      const cards = latestByThread.map(function (msg, i) {
        const thread = threadDocs[i];
        if (!thread) return "";
        const status = String(thread.status || "open");
        if (VISIBLE_TO_TECH.indexOf(status) < 0) return "";
        return renderCommCardHtml(thread, msg);
      }).filter(Boolean);

      if (!cards.length) { section.hidden = true; return; }

      list.innerHTML = cards.join("");
      section.hidden = false;
      wireCommCardButtons(staff);
    } catch (err) {
      console.warn("[team-hub] comm messages read failed", err);
    }
  }

  function renderCommCardHtml(thread, msg) {
    const cat = thread.category || "general";
    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
    const senderName = msg.sender_name || msg.sender_id || "Pioneer";
    // Phase 3B.1 — status badge. For techs viewing the card, the
    // status is always one of waiting_on_employee / open (we filtered
    // upstream), so this is informational rather than action-driving.
    const statusValue = String(thread.status || "open");
    const statusLabel = (window.CommThreads && window.CommThreads.STATUS_LABEL &&
                        window.CommThreads.STATUS_LABEL[statusValue]) || statusValue;
    // Phase 3B.2 — priority badge. Defaults to action_required for
    // legacy threads without the field set.
    const priorityValue = String(thread.priority || "action_required");
    const priorityLabel = (window.CommThreads && window.CommThreads.PRIORITY_LABEL &&
                           window.CommThreads.PRIORITY_LABEL[priorityValue]) || priorityValue;
    return (
      '<article class="team-hub-comm-card" data-thread-id="' + commEscape(thread._id) +
        '" data-msg-id="' + commEscape(msg._id) +
        '" data-category="' + commEscape(cat) + '"' +
        ' data-priority="' + commEscape(priorityValue) + '">' +
        '<header class="team-hub-comm-card-head">' +
          '<span class="team-hub-comm-card-subject">' + commEscape(thread.subject || "(no subject)") + '</span>' +
          '<span class="th-comm-priority-chip is-' + commEscape(priorityValue) + '">' +
            commEscape(priorityLabel) + '</span>' +
          '<span class="th-comm-status-chip is-' + commEscape(statusValue) + '">' +
            commEscape(statusLabel) + '</span>' +
          '<span class="team-hub-comm-card-meta">' + commEscape(catLabel) + '</span>' +
        '</header>' +
        '<p class="team-hub-comm-card-from">From ' + commEscape(senderName) + ' · ' +
          commEscape(commFmtAgoTH(commTsToMs(msg.created_at))) + '</p>' +
        '<p class="team-hub-comm-card-body">' + commEscape(msg.body || "") + '</p>' +
        '<div class="team-hub-comm-card-reply" hidden>' +
          '<textarea class="team-hub-comm-card-reply-input" maxlength="2000" placeholder="Type a reply…"></textarea>' +
        '</div>' +
        '<div class="team-hub-comm-card-btns">' +
          '<button type="button" class="team-hub-comm-btn team-hub-comm-btn-secondary" data-comm-action="reply-open">Reply</button>' +
          '<button type="button" class="team-hub-comm-btn team-hub-comm-btn-primary" data-comm-action="ack">Acknowledge</button>' +
        '</div>' +
        '<p class="team-hub-comm-card-status" data-comm-status></p>' +
      '</article>'
    );
  }

  function wireCommCardButtons(staff) {
    document.querySelectorAll(".team-hub-comm-card").forEach(function (card) {
      card.querySelectorAll("[data-comm-action]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          handleCommCardClick(card, btn, staff);
        });
      });
    });
  }

  async function handleCommCardClick(card, btn, staff) {
    const action = btn.getAttribute("data-comm-action");
    const status = card.querySelector("[data-comm-status]");

    if (action === "reply-open") {
      const replyBox = card.querySelector(".team-hub-comm-card-reply");
      const isHidden = replyBox.hidden;
      replyBox.hidden = !isHidden;
      if (isHidden) {
        // First open — swap button to "Send" + add a Cancel
        btn.setAttribute("data-comm-action", "reply-send");
        btn.textContent = "Send Reply";
        // Inject a Cancel button next to it if not already there
        if (!card.querySelector("[data-comm-action='reply-cancel']")) {
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "team-hub-comm-btn team-hub-comm-btn-secondary";
          cancel.setAttribute("data-comm-action", "reply-cancel");
          cancel.textContent = "Cancel";
          cancel.addEventListener("click", function () { handleCommCardClick(card, cancel, staff); });
          btn.parentElement.insertBefore(cancel, btn);
        }
        setTimeout(function () {
          card.querySelector(".team-hub-comm-card-reply-input").focus();
        }, 30);
      }
      return;
    }

    if (action === "reply-cancel") {
      card.querySelector(".team-hub-comm-card-reply").hidden = true;
      const sendBtn = card.querySelector("[data-comm-action='reply-send']");
      if (sendBtn) {
        sendBtn.setAttribute("data-comm-action", "reply-open");
        sendBtn.textContent = "Reply";
      }
      btn.remove();
      if (status) status.textContent = "";
      return;
    }

    if (action === "reply-send") {
      await sendCommReply(card, btn, staff, status);
      return;
    }

    if (action === "ack") {
      await ackCommCard(card, btn, status);
      return;
    }
  }

  async function sendCommReply(card, btn, staff, status) {
    const threadId = card.getAttribute("data-thread-id");
    const ta = card.querySelector(".team-hub-comm-card-reply-input");
    const body = (ta.value || "").trim();
    if (!body) {
      if (status) { status.textContent = "Type a reply before sending."; status.setAttribute("data-tone", "error"); }
      return;
    }
    const myEmail = String((staff.email || "")).toLowerCase();
    const myName  = (staff.tech && (staff.tech.display_name || staff.tech.tech_display_name)) || myEmail.split("@")[0];
    btn.disabled = true;
    if (status) { status.textContent = "Sending…"; status.removeAttribute("data-tone"); }
    try {
      const thread = await window.CommThreads.findThreadById(threadId);
      if (!thread) throw new Error("Thread not found");
      // Recipient = first participant whose id isn't me. Usually the
      // admin who started the thread.
      const other = (thread.participants || []).find(function (p) {
        return String(p.id || "").toLowerCase() !== myEmail;
      });
      const recipient_type = (other && other.type === "tech") ? "employee"
                           : (other && other.type === "team") ? "team"
                           : "admin";
      const recipient_id   = other ? String(other.id || "").toLowerCase() : "";
      const recipient_name = (other && other.name) || "";

      await window.CommThreads.addMessage(threadId, {
        channel:        window.CommThreads.CHANNELS.IN_APP,
        direction:      window.CommThreads.DIRECTIONS.INBOUND,
        status:         window.CommThreads.MESSAGE_STATUS.DELIVERED,
        sender_type:    "tech",
        sender_id:      myEmail,
        sender_name:    myName,
        recipient_type: recipient_type,
        recipient_id:   recipient_id,
        recipient_name: recipient_name,
        body:           body
      });
      if (status) { status.textContent = "Sent. Thank you."; status.setAttribute("data-tone", "ok"); }
      ta.value = "";
      // Remove the card from view — they replied, the loop is closed.
      setTimeout(function () { fadeAndRemoveCommCard(card); }, 700);
    } catch (err) {
      console.error("[team-hub] reply send failed", err);
      if (status) {
        status.textContent = "Send failed: " + (err.message || "unknown");
        status.setAttribute("data-tone", "error");
      }
      btn.disabled = false;
    }
  }

  async function ackCommCard(card, btn, status) {
    const msgId = card.getAttribute("data-msg-id");
    btn.disabled = true;
    if (status) { status.textContent = "Got it."; status.removeAttribute("data-tone"); }
    try {
      await firebase.firestore().collection("communication_messages").doc(msgId).update({
        read_at:    firebase.firestore.FieldValue.serverTimestamp(),
        updated_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      setTimeout(function () { fadeAndRemoveCommCard(card); }, 400);
    } catch (err) {
      console.error("[team-hub] ack failed", err);
      if (status) {
        status.textContent = "Couldn't save — try again.";
        status.setAttribute("data-tone", "error");
      }
      btn.disabled = false;
    }
  }

  function fadeAndRemoveCommCard(card) {
    card.style.transition = "opacity 0.3s ease";
    card.style.opacity = "0";
    setTimeout(function () {
      card.remove();
      const list = $("team-hub-comm-list");
      if (list && !list.children.length) {
        const section = $("team-hub-comm-section");
        if (section) section.hidden = true;
      }
    }, 320);
  }

  function commEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function commTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "string") { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    return 0;
  }
  function commFmtAgoTH(ms) {
    if (!ms) return "";
    const diff = Date.now() - ms;
    if (diff < 60000)    return "just now";
    if (diff < 3600000)  return Math.round(diff / 60000)   + " min ago";
    if (diff < 86400000) return Math.round(diff / 3600000) + " hr ago";
    const days = Math.round(diff / 86400000);
    if (days < 7)        return days + " d ago";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
  }

  /* ============================================================
   * Phase Employee Trust Layer — My Hours
   *
   * For the signed-in tech, surface the paid sessions inside the
   * current semi-monthly pay period (matches the function-side
   * derivation in functions/index.js Phase 29). Each row exposes an
   * "Adjust" button that opens the shared modal; the global Request
   * Adjustment button at the bottom opens the same modal with the
   * shift picker visible.
   *
   * Submission goes to window.CREATE_TIME_ADJUSTMENT_REQUEST_URL —
   * the existing Phase 29 Cloud Function that admin uses today via
   * the Payroll Exceptions tab. No new approval workflow.
   * ============================================================ */

  let myHoursStaff = null;
  let myHoursSessions = [];          // current-period sessions (status === 'completed' usable for requests)
  let myHoursPendingByKey = {};      // session_id → request doc
  let myHoursApprovedCount = 0;
  let myHoursModalShiftId = null;
  let myHoursExpanded = false;       // false = show only first 5 shifts
  const MY_HOURS_PREVIEW_LIMIT = 5;

  const MY_HOURS_REASON_LABEL = {
    forgot_clock_in:  'Forgot to clock in',
    forgot_clock_out: 'Forgot to clock out',
    phone_issue:      'Phone issue',
    other:            'Other'
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function todayPTDateString() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }
  function myHoursCurrentPeriod() {
    // Mirrors getSemiMonthlyPeriod in functions/index.js — 1-15 = half A,
    // 16-EOM = half B. All math in Pacific date space.
    const today = todayPTDateString();
    const parts = today.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    if (day <= 15) {
      return {
        start_date: year + '-' + pad2(month) + '-01',
        end_date:   year + '-' + pad2(month) + '-15',
        label:      monthNames[month - 1] + ' 1–15, ' + year,
        period_id:  year + '-' + pad2(month) + '-A'
      };
    }
    // Last day of the month
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      start_date: year + '-' + pad2(month) + '-16',
      end_date:   year + '-' + pad2(month) + '-' + pad2(lastDay),
      label:      monthNames[month - 1] + ' 16–' + lastDay + ', ' + year,
      period_id:  year + '-' + pad2(month) + '-B'
    };
  }

  function myHoursEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function myHoursTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.seconds === 'number')    return ts.seconds * 1000;
    if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    if (ts instanceof Date) return ts.getTime();
    return 0;
  }
  function myHoursFormatTime(ts) {
    const ms = myHoursTsToMs(ts);
    if (!ms) return '—';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date(ms));
  }
  function myHoursFormatDate(ymd) {
    if (!ymd) return '—';
    const parts = ymd.split('-');
    if (parts.length !== 3) return ymd;
    const d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short', month: 'short', day: 'numeric'
    }).format(d);
  }
  function myHoursFormatDuration(min) {
    const m = Math.max(0, Math.floor(min || 0));
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    if (hh === 0) return mm + 'm';
    if (mm === 0) return hh + 'h';
    return hh + 'h ' + pad2(mm) + 'm';
  }
  function myHoursToLocalDatetimeValue(ts) {
    // Convert a Firestore Timestamp to the local time string a
    // <input type="datetime-local"> expects (YYYY-MM-DDTHH:MM).
    // Pacific time so the value matches what the tech actually saw.
    const ms = myHoursTsToMs(ts);
    if (!ms) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(ms));
    const map = {};
    parts.forEach(function (p) { if (p.type !== 'literal') map[p.type] = p.value; });
    const hh = map.hour === '24' ? '00' : map.hour;
    return map.year + '-' + map.month + '-' + map.day + 'T' + hh + ':' + map.minute;
  }
  function myHoursDatetimeLocalToIso(dtLocal) {
    // The input gives us "YYYY-MM-DDTHH:MM" interpreted as the user's
    // local time. We want an ISO timestamp that matches Pacific
    // wallclock time. Append the right PT offset for that date.
    if (!dtLocal) return null;
    // Parse the date portion to pick the offset (PDT -07 or PST -08).
    const dateOnly = dtLocal.slice(0, 10);
    // Probe noon Pacific to find the offset for that date.
    const probe = new Date(dateOnly + 'T12:00:00Z');
    const tzShort = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', timeZoneName: 'short'
    }).formatToParts(probe).find(function (p) { return p.type === 'timeZoneName'; });
    const isPDT = (tzShort && tzShort.value === 'PDT');
    const offset = isPDT ? '-07:00' : '-08:00';
    return dtLocal + ':00' + offset;
  }
  function myHoursLaborChip(s) {
    const lt = s.labor_type || 'cleaning';
    const label = (lt === 'cleaning')      ? 'Cleaning'
                : (lt === 'inspection')    ? 'Inspection'
                : (lt === 'supply_station')? 'Supply Pickup'
                : lt.charAt(0).toUpperCase() + lt.slice(1);
    return '<span class="my-hours-chip my-hours-chip-' + myHoursEscape(lt) + '">' +
             myHoursEscape(label) +
           '</span>';
  }

  async function bootMyHoursForStaff(staff) {
    if (!staff || !staff.uid) return;
    const section = $('team-hub-my-hours-section');
    if (!section) return;
    if (!window.firebase || typeof firebase.firestore !== 'function') return;
    myHoursStaff = staff;
    section.hidden = false;
    wireMyHoursButtons();
    await reloadMyHours();
  }

  async function reloadMyHours() {
    if (!myHoursStaff) return;
    const period = myHoursCurrentPeriod();
    const db = firebase.firestore();
    try {
      // Sessions are owner-readable via the staff_uid match in the
      // pioneer_service_sessions rule. The (staff_uid, service_date)
      // composite index ships in firestore.indexes.json.
      const sessionSnap = await db.collection('pioneer_service_sessions')
        .where('staff_uid', '==', myHoursStaff.uid)
        .where('service_date', '>=', period.start_date)
        .where('service_date', '<=', period.end_date)
        .orderBy('service_date', 'desc')
        .limit(80).get();
      myHoursSessions = sessionSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });

      // Pending + approved adjustment requests for THIS employee.
      // Equality on employee_uid uses the auto-built single-field index;
      // shift-date filtering happens client-side so this works without
      // a new composite index deploy. Soft-fails — the requests UI
      // still works, you just won't see existing pending badges.
      myHoursPendingByKey = {};
      myHoursApprovedCount = 0;
      try {
        const reqSnap = await db.collection('time_adjustment_requests')
          .where('employee_uid', '==', myHoursStaff.uid)
          .limit(120).get();
        reqSnap.docs.forEach(function (d) {
          const r = d.data() || {};
          const sd = String(r.shift_date || '');
          if (sd < period.start_date || sd > period.end_date) return;
          const st = String(r.status || '').toLowerCase();
          if (st === 'pending' && r.service_session_id) {
            myHoursPendingByKey[r.service_session_id] = Object.assign({ _id: d.id }, r);
          } else if (st === 'approved') {
            myHoursApprovedCount++;
          }
        });
      } catch (reqErr) {
        console.warn('[team-hub] my-hours adjustments read failed (non-fatal)', reqErr);
      }

      renderMyHoursSummary(period);
      renderMyHoursShifts(period);
    } catch (err) {
      console.error('[team-hub] my-hours load failed', err);
      $('my-hours-summary').innerHTML =
        '<div class="my-hours-summary-empty">' +
          'Couldn\'t load your hours right now. Try refreshing.' +
        '</div>';
    }
  }

  function renderMyHoursSummary(period) {
    const root = $('my-hours-summary');
    if (!root) return;
    let totalMin = 0;
    myHoursSessions.forEach(function (s) {
      // Prefer effective_minutes (admin already approved a correction)
      // over paid_minutes, falling back to work_minutes.
      const m = (typeof s.effective_minutes === 'number') ? s.effective_minutes
              : (typeof s.paid_minutes === 'number')      ? s.paid_minutes
              : (typeof s.work_minutes === 'number')      ? s.work_minutes
              : 0;
      totalMin += Math.max(0, m);
    });
    const pendingCount = Object.keys(myHoursPendingByKey).length;
    const approvedCount = myHoursApprovedCount;
    // Confidence chip — green when no pending corrections, yellow when
    // any exist. Gives the tech the "is payroll right?" answer at a
    // glance before they read anything else.
    const confidenceChip = (pendingCount > 0)
      ? '<span class="my-hours-confidence my-hours-confidence-warn">' +
          '<span class="my-hours-confidence-icon" aria-hidden="true">⚠</span>' +
          'Pending correction' +
        '</span>'
      : '<span class="my-hours-confidence my-hours-confidence-ok">' +
          '<span class="my-hours-confidence-icon" aria-hidden="true">✓</span>' +
          'Hours look good' +
        '</span>';
    root.innerHTML =
      '<div>' +
        confidenceChip +
        '<p class="my-hours-summary-eyebrow">Your current payroll period</p>' +
        '<h3 class="my-hours-summary-period">' + myHoursEscape(period.label) + '</h3>' +
        '<p class="my-hours-summary-closes">Payroll closes: <strong>' +
          myHoursEscape(myHoursFormatDate(period.end_date)) + '</strong></p>' +
        '<div class="my-hours-summary-tiles">' +
          '<div class="my-hours-tile">' +
            '<span class="my-hours-tile-label">Total hours</span>' +
            '<span class="my-hours-tile-value">' + myHoursEscape(myHoursFormatDuration(totalMin)) + '</span>' +
            '<span class="my-hours-tile-value-small">' + myHoursSessions.length + ' shift' +
              (myHoursSessions.length === 1 ? '' : 's') + '</span>' +
          '</div>' +
          '<div class="my-hours-tile my-hours-tile-pending">' +
            '<span class="my-hours-tile-label">Pending corrections</span>' +
            '<span class="my-hours-tile-value">' + pendingCount + '</span>' +
            '<span class="my-hours-tile-value-small">awaiting Kirby</span>' +
          '</div>' +
          (approvedCount > 0
            ? '<div class="my-hours-tile my-hours-tile-approved">' +
                '<span class="my-hours-tile-label">Approved corrections</span>' +
                '<span class="my-hours-tile-value">' + approvedCount + '</span>' +
                '<span class="my-hours-tile-value-small">applied to your hours</span>' +
              '</div>'
            : '') +
        '</div>' +
      '</div>';
  }

  function renderMyHoursShifts(period) {
    const root = $('my-hours-shifts');
    if (!root) return;
    if (!myHoursSessions.length) {
      root.innerHTML =
        '<div class="my-hours-shifts-empty">' +
          'No shifts logged for this payroll period yet. They\'ll appear here after you clock out.' +
        '</div>';
      return;
    }
    // Default to the most recent 5 shifts. "View All" expands to show
    // every shift in the period. The expanded state is per-render —
    // a reload (e.g. after submitting a correction) resets to preview
    // mode, which is the right default UX.
    const total = myHoursSessions.length;
    const showAll = myHoursExpanded || total <= MY_HOURS_PREVIEW_LIMIT;
    const visible = showAll ? myHoursSessions : myHoursSessions.slice(0, MY_HOURS_PREVIEW_LIMIT);
    let html = visible.map(renderMyHoursShiftRow).join('');
    if (total > MY_HOURS_PREVIEW_LIMIT) {
      const hidden = total - MY_HOURS_PREVIEW_LIMIT;
      html += '<button type="button" class="my-hours-toggle-all" id="my-hours-toggle-all">' +
                (myHoursExpanded
                  ? 'Show Recent 5 ▲'
                  : 'View All Shifts (' + total + ') ▼') +
              '</button>';
      if (!myHoursExpanded) {
        // Hint just under the toggle in muted text so the user knows
        // what they'd be revealing.
        html += '<p class="my-hours-toggle-hint">' +
                  hidden + ' more shift' + (hidden === 1 ? '' : 's') +
                  ' in this payroll period.' +
                '</p>';
      }
    }
    root.innerHTML = html;
    document.querySelectorAll('[data-my-hours-shift-action="adjust"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openMyHoursModal(btn.getAttribute('data-shift-id'));
      });
    });
    const toggle = $('my-hours-toggle-all');
    if (toggle) {
      toggle.addEventListener('click', function () {
        myHoursExpanded = !myHoursExpanded;
        renderMyHoursShifts(period);
      });
    }
  }

  function renderMyHoursShiftRow(s) {
    const isActive = s.status === 'active' || s.status === 'paused';
    const pending = myHoursPendingByKey[s._id];
    const hasApprovedCorrection = s.has_approved_time_adjustment === true;
    const labor = s.labor_type || 'cleaning';
    const effectiveMin = (typeof s.effective_minutes === 'number') ? s.effective_minutes
                      : (typeof s.paid_minutes === 'number')      ? s.paid_minutes
                      : (typeof s.work_minutes === 'number')      ? s.work_minutes
                      : 0;
    const ci = s.effective_clock_in || s.clock_in_at;
    const co = s.effective_clock_out || s.clock_out_at;
    const customer = (labor === 'inspection' && s.customer_name) ? s.customer_name
                   : (labor === 'inspection' && s.customer_id)   ? s.customer_id
                   : (labor === 'supply_station')                ? 'Supply Station'
                   : (s.customer_name || s.customer_id || '');
    const driveChip = (typeof s.paid_drive_minutes === 'number' && s.paid_drive_minutes > 0)
      ? '<span class="my-hours-chip my-hours-chip-drive">+ ' +
          myHoursEscape(myHoursFormatDuration(s.paid_drive_minutes)) + ' drive</span>'
      : '';
    const statusChip = isActive
      ? '<span class="my-hours-chip my-hours-chip-active">On the clock</span>'
      : '';
    const pendingChip = pending
      ? '<span class="my-hours-chip my-hours-chip-pending">Correction pending</span>'
      : (hasApprovedCorrection
          ? '<span class="my-hours-chip my-hours-chip-approved">Correction applied</span>'
          : '');
    // Disable Adjust when active OR a pending request already exists OR
    // the session has no clock_out (can't request a clock-out time we
    // don't have yet; admin can still fix manually).
    const canAdjust = !isActive && !pending && !!s.clock_out_at;
    const btn = '<button type="button" class="my-hours-shift-btn"' +
                  ' data-my-hours-shift-action="adjust"' +
                  ' data-shift-id="' + myHoursEscape(s._id) + '"' +
                  (canAdjust ? '' : ' disabled') +
                  ' title="' + (canAdjust ? 'Request a correction' :
                                pending ? 'You already have a pending correction for this shift' :
                                isActive ? 'Clock out first before requesting' :
                                'Missing clock-out — Kirby will follow up') + '">Adjust</button>';
    return (
      '<div class="my-hours-shift-row"' +
        ' data-labor="' + myHoursEscape(labor) + '"' +
        ' data-status="' + myHoursEscape(s.status || 'completed') + '"' +
        ' data-pending="' + (!!pending) + '">' +
        '<div class="my-hours-shift-main">' +
          '<div class="my-hours-shift-top">' +
            '<span class="my-hours-shift-date">' + myHoursEscape(myHoursFormatDate(s.service_date)) + '</span>' +
            myHoursLaborChip(s) +
            driveChip +
            statusChip +
            pendingChip +
          '</div>' +
          '<div class="my-hours-shift-detail">' +
            (customer ? '<strong>' + myHoursEscape(customer) + '</strong> · ' : '') +
            myHoursEscape(myHoursFormatTime(ci)) + ' → ' +
            myHoursEscape(myHoursFormatTime(co)) + ' · ' +
            '<strong>' + myHoursEscape(myHoursFormatDuration(effectiveMin)) + '</strong>' +
          '</div>' +
        '</div>' +
        '<div class="my-hours-shift-actions">' + btn + '</div>' +
      '</div>'
    );
  }

  /* ---- Modal wiring ---- */

  function wireMyHoursButtons() {
    const requestBtn = $('my-hours-request-btn');
    if (requestBtn && !requestBtn.dataset.wired) {
      requestBtn.dataset.wired = '1';
      requestBtn.addEventListener('click', function () { openMyHoursModal(null); });
    }
    const closeBtn = $('my-hours-modal-close');
    if (closeBtn && !closeBtn.dataset.wired) {
      closeBtn.dataset.wired = '1';
      closeBtn.addEventListener('click', closeMyHoursModal);
    }
    const cancelBtn = $('my-hours-modal-cancel');
    if (cancelBtn && !cancelBtn.dataset.wired) {
      cancelBtn.dataset.wired = '1';
      cancelBtn.addEventListener('click', closeMyHoursModal);
    }
    const submitBtn = $('my-hours-modal-submit');
    if (submitBtn && !submitBtn.dataset.wired) {
      submitBtn.dataset.wired = '1';
      submitBtn.addEventListener('click', submitMyHoursAdjustment);
    }
    const shiftSel = $('my-hours-modal-shift');
    if (shiftSel && !shiftSel.dataset.wired) {
      shiftSel.dataset.wired = '1';
      shiftSel.addEventListener('change', function () {
        myHoursModalShiftId = shiftSel.value || null;
        applyMyHoursModalShift();
      });
    }
    const overlay = $('my-hours-modal-overlay');
    if (overlay && !overlay.dataset.wired) {
      overlay.dataset.wired = '1';
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closeMyHoursModal();
      });
    }
  }

  function eligibleSessionsForAdjustment() {
    return myHoursSessions.filter(function (s) {
      if (s.status !== 'completed') return false;
      if (!s.clock_out_at) return false;
      if (myHoursPendingByKey[s._id]) return false;
      // The function refuses if the session is in a locked payroll
      // state. Hide those so the tech doesn't get a confusing rejection.
      const lockedStates = ['approved_for_payroll', 'exported', 'workweek_locked_by_export'];
      if (lockedStates.indexOf(s.payroll_state) >= 0) return false;
      // The function also refuses if there's no assignment_id (non-
      // cleaning sessions today don't carry one). Surface only the
      // sessions that can actually be adjusted in V1.
      if (!s.assignment_id) return false;
      return true;
    });
  }

  function openMyHoursModal(prefillShiftId) {
    const overlay = $('my-hours-modal-overlay');
    if (!overlay) return;
    const eligible = eligibleSessionsForAdjustment();
    if (!eligible.length) {
      // No adjustable sessions this period — explain inline rather than
      // open an empty modal.
      const status = $('my-hours-modal-status');
      if (status) {
        status.textContent = 'No adjustable shifts in this payroll period.';
        status.setAttribute('data-tone', 'error');
      }
      return;
    }
    const sel = $('my-hours-modal-shift');
    sel.innerHTML = eligible.map(function (s) {
      const label = myHoursFormatDate(s.service_date) + ' · ' +
                    myHoursFormatTime(s.clock_in_at) + ' → ' +
                    myHoursFormatTime(s.clock_out_at);
      return '<option value="' + myHoursEscape(s._id) + '">' + myHoursEscape(label) + '</option>';
    }).join('');
    const chosen = (prefillShiftId && eligible.some(function (s) { return s._id === prefillShiftId; }))
      ? prefillShiftId : eligible[0]._id;
    sel.value = chosen;
    myHoursModalShiftId = chosen;
    sel.disabled = !!prefillShiftId;

    $('my-hours-modal-reason').selectedIndex = 0;
    $('my-hours-modal-notes').value = '';
    setMyHoursModalStatus('', null);
    applyMyHoursModalShift();

    overlay.hidden = false;
    setTimeout(function () { $('my-hours-modal-in').focus(); }, 50);
  }

  function applyMyHoursModalShift() {
    if (!myHoursModalShiftId) return;
    const s = myHoursSessions.find(function (x) { return x._id === myHoursModalShiftId; });
    if (!s) return;
    const inEl = $('my-hours-modal-in');
    const outEl = $('my-hours-modal-out');
    const inHint = $('my-hours-modal-in-hint');
    const outHint = $('my-hours-modal-out-hint');
    inEl.value = myHoursToLocalDatetimeValue(s.clock_in_at);
    outEl.value = myHoursToLocalDatetimeValue(s.clock_out_at);
    if (inHint)  inHint.textContent  = 'Logged: ' + myHoursFormatTime(s.clock_in_at);
    if (outHint) outHint.textContent = 'Logged: ' + myHoursFormatTime(s.clock_out_at);
  }

  function closeMyHoursModal() {
    const overlay = $('my-hours-modal-overlay');
    if (overlay) overlay.hidden = true;
    myHoursModalShiftId = null;
  }

  function setMyHoursModalStatus(msg, tone) {
    const el = $('my-hours-modal-status');
    if (!el) return;
    el.textContent = msg || '';
    if (tone) el.setAttribute('data-tone', tone);
    else el.removeAttribute('data-tone');
  }

  async function submitMyHoursAdjustment() {
    if (!myHoursStaff || !myHoursModalShiftId) return;
    const s = myHoursSessions.find(function (x) { return x._id === myHoursModalShiftId; });
    if (!s) return;

    const inLocal = $('my-hours-modal-in').value;
    const outLocal = $('my-hours-modal-out').value;
    const reasonSel = $('my-hours-modal-reason');
    const notesValue = ($('my-hours-modal-notes').value || '').trim();
    const reasonValue = reasonSel.value;
    const reasonDetail = reasonSel.options[reasonSel.selectedIndex].getAttribute('data-detail') || '';

    if (!inLocal || !outLocal) {
      setMyHoursModalStatus('Set both the requested clock-in and clock-out.', 'error');
      return;
    }
    if (!notesValue) {
      setMyHoursModalStatus('Add a quick note so Kirby can verify what happened.', 'error');
      return;
    }

    const inIso = myHoursDatetimeLocalToIso(inLocal);
    const outIso = myHoursDatetimeLocalToIso(outLocal);
    if (!inIso || !outIso) {
      setMyHoursModalStatus('Couldn\'t parse those times — please re-enter.', 'error');
      return;
    }
    if (new Date(outIso).getTime() <= new Date(inIso).getTime()) {
      setMyHoursModalStatus('Clock-out has to be after clock-in.', 'error');
      return;
    }

    // Notes carry the requested-detail (wrong time / wrong location) so
    // Kirby can see why "other" was chosen.
    const fullNotes = reasonDetail
      ? '[' + reasonDetail.replace(/_/g, ' ') + '] ' + notesValue
      : notesValue;

    const url = window.CREATE_TIME_ADJUSTMENT_REQUEST_URL;
    if (!url) {
      setMyHoursModalStatus('Adjustment endpoint not configured. Tell Nick.', 'error');
      return;
    }
    const submitBtn = $('my-hours-modal-submit');
    submitBtn.disabled = true;
    setMyHoursModalStatus('Submitting…', null);

    try {
      const idToken = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + idToken,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          assignment_id:      s.assignment_id,
          service_session_id: s._id,
          requested_clock_in:  inIso,
          requested_clock_out: outIso,
          reason: reasonValue,
          notes:  fullNotes
        })
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body || body.ok === false) {
        const msg = (body && (body.error || body.message)) ||
                    ('Server returned ' + res.status);
        throw new Error(msg);
      }
      setMyHoursModalStatus('Submitted — Kirby will review shortly.', 'ok');
      setTimeout(closeMyHoursModal, 1100);
      await reloadMyHours();
    } catch (err) {
      console.error('[team-hub] adjustment submit failed', err);
      setMyHoursModalStatus('Couldn\'t submit: ' + (err.message || 'try again'), 'error');
      submitBtn.disabled = false;
    }
  }

  /* ---------- debug panel (V20260614c) ---------------------------------
   * Activates when the URL has ?debug=announcements. Renders a fixed-
   * position panel with per-announcement diagnosis so we can spot WHY
   * the badge says N and the hub UI shows M cards.
   *
   * Read-only: same queries the badge already runs. No new write
   * surface. Self-contained — remove the maybeRunAnnouncementDebug
   * function + its single call site to retire.
   * --------------------------------------------------------------------- */
  function _annDebugToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return null;
  }
  function _annDebugFmtTs(ts) {
    const ms = _annDebugToMs(ts);
    if (ms == null) return "—";
    try {
      return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
    } catch (_e) { return String(ms); }
  }
  function _annDebugEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function maybeRunAnnouncementDebug(staff) {
    try {
      const qs = new URLSearchParams(window.location.search || "");
      if (qs.get("debug") !== "announcements") return;
      if (!staff || !staff.uid) return;
      if (!window.firebase || typeof firebase.firestore !== "function") return;

      const db = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        db.collection("announcements").where("active", "==", true).get(),
        db.collection("announcement_reads").where("uid", "==", staff.uid).get()
      ]);
      const readIds = new Set();
      const readMap = {};
      readsSnap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (data.announcement_id) {
          readIds.add(data.announcement_id);
          readMap[data.announcement_id] = data;
        }
      });

      const myUid   = (staff && staff.uid) || null;
      const myEmail = String((staff && staff.email) || "").toLowerCase().trim();
      const mySlug  = String((staff && staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "");
      function targetsMeDbg(a) {
        if (!a) return false;
        const type = String(a.audienceType || "all");
        if (type === "all") return true;
        if (type !== "selected") return true;
        if (Array.isArray(a.recipientUids)      && myUid   && a.recipientUids.indexOf(myUid) >= 0) return true;
        if (Array.isArray(a.recipientEmails)    && myEmail && a.recipientEmails.indexOf(myEmail) >= 0) return true;
        if (Array.isArray(a.recipientTechSlugs) && mySlug  && a.recipientTechSlugs.indexOf(mySlug) >= 0) return true;
        return false;
      }

      const now = Date.now();
      const rows = annsSnap.docs.map(function (d) {
        const a = d.data() || {};
        const archived = !!a.archived_at;
        const s = _annDebugToMs(a.starts_at);
        const e = _annDebugToMs(a.expires_at);
        const beforeStart = (s != null && s > now);
        const afterEnd    = (e != null && e <= now);
        const isActiveWindow = !archived && !beforeStart && !afterEnd;
        const inReads        = readIds.has(d.id);
        const targets        = targetsMeDbg(a);
        // Old badge logic = activeWindow && !inReads (no audience filter)
        const countedByOldBadge = isActiveWindow && !inReads;
        // New badge logic (this preview) = activeWindow && targetsMe && !inReads
        const countedByNewBadge = isActiveWindow && targets && !inReads;
        // Hub UI shows the card if: targetsMe && isActiveWindow && !inReads
        const renderedByHub     = isActiveWindow && targets && !inReads;
        return {
          id: d.id,
          title:        a.title || "(untitled)",
          audienceType: a.audienceType || "(undefined→all)",
          mandatory:    !!a.mandatory,
          archived:     archived,
          starts_at:    _annDebugFmtTs(a.starts_at),
          expires_at:   _annDebugFmtTs(a.expires_at),
          beforeStart:  beforeStart,
          afterEnd:     afterEnd,
          recipUids:    Array.isArray(a.recipientUids)      ? a.recipientUids.length      : 0,
          recipEmails:  Array.isArray(a.recipientEmails)    ? a.recipientEmails.length    : 0,
          recipSlugs:   Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs.length : 0,
          inReads:      inReads,
          targets:      targets,
          countedOld:   countedByOldBadge,
          countedNew:   countedByNewBadge,
          renderedHub:  renderedByHub
        };
      });

      const oldBadge = rows.reduce(function (n, r) { return n + (r.countedOld  ? 1 : 0); }, 0);
      const newBadge = rows.reduce(function (n, r) { return n + (r.countedNew  ? 1 : 0); }, 0);
      const hubCount = rows.reduce(function (n, r) { return n + (r.renderedHub ? 1 : 0); }, 0);

      const summaryHtml =
        '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:13px;">' +
          '<div><strong>Old badge (pre-fix)</strong>: ' + oldBadge + '</div>' +
          '<div><strong>New badge (this preview)</strong>: ' + newBadge + '</div>' +
          '<div><strong>Hub UI cards</strong>: ' + hubCount + '</div>' +
          '<div><strong>Reads on file</strong>: ' + readIds.size + '</div>' +
        '</div>';

      const authHtml =
        '<div style="font-family:monospace;font-size:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;margin-bottom:12px;">' +
          'uid: ' + _annDebugEsc(myUid || "(none)") +
          ' · email: ' + _annDebugEsc(myEmail || "(none)") +
          ' · tech_slug: ' + _annDebugEsc(mySlug || "(none)") +
        '</div>';

      const headerHtml =
        '<tr style="background:#1e293b;color:#fff;">' +
          ['Title','aud','Mand','Active','In reads','Targets me','Old badge','New badge','Hub card','starts_at','expires_at','recipUids/Emails/Slugs','Action']
            .map(function (h) { return '<th style="padding:6px 8px;text-align:left;font-weight:600;">' + h + '</th>'; })
            .join("") +
        '</tr>';

      function bool(v, goodTrue) {
        const yes = '<span style="color:#16a34a;font-weight:700;">YES</span>';
        const no  = '<span style="color:#dc2626;font-weight:700;">no</span>';
        return v ? yes : no;
      }
      function neutralBool(v) {
        return v
          ? '<span style="color:#0369a1;font-weight:700;">YES</span>'
          : '<span style="color:#64748b;">no</span>';
      }
      const bodyHtml = rows.map(function (r) {
        const activeWindow = !r.archived && !r.beforeStart && !r.afterEnd;
        const recipSummary = r.recipUids + ' / ' + r.recipEmails + ' / ' + r.recipSlugs;
        const action = r.countedNew
          ? '<button data-debug-mark-read="' + _annDebugEsc(r.id) + '" style="padding:4px 8px;background:#dc2626;color:#fff;border:0;border-radius:4px;cursor:pointer;">Force mark read</button>'
          : '<span style="color:#64748b;font-size:11px;">—</span>';
        return '<tr style="border-bottom:1px solid #e2e8f0;">' +
          '<td style="padding:6px 8px;max-width:240px;"><div style="font-weight:600;">' + _annDebugEsc(r.title) + '</div>' +
            '<div style="font-family:monospace;font-size:11px;color:#64748b;">' + _annDebugEsc(r.id) + '</div></td>' +
          '<td style="padding:6px 8px;font-family:monospace;font-size:11px;">' + _annDebugEsc(r.audienceType) + '</td>' +
          '<td style="padding:6px 8px;">' + neutralBool(r.mandatory) + '</td>' +
          '<td style="padding:6px 8px;">' + neutralBool(activeWindow) + '</td>' +
          '<td style="padding:6px 8px;">' + neutralBool(r.inReads) + '</td>' +
          '<td style="padding:6px 8px;">' + neutralBool(r.targets) + '</td>' +
          '<td style="padding:6px 8px;">' + bool(r.countedOld) + '</td>' +
          '<td style="padding:6px 8px;">' + bool(r.countedNew) + '</td>' +
          '<td style="padding:6px 8px;">' + bool(r.renderedHub) + '</td>' +
          '<td style="padding:6px 8px;font-family:monospace;font-size:11px;">' + _annDebugEsc(r.starts_at) + '</td>' +
          '<td style="padding:6px 8px;font-family:monospace;font-size:11px;">' + _annDebugEsc(r.expires_at) + '</td>' +
          '<td style="padding:6px 8px;font-family:monospace;font-size:11px;">' + _annDebugEsc(recipSummary) + '</td>' +
          '<td style="padding:6px 8px;">' + action + '</td>' +
        '</tr>';
      }).join("");

      const panel = document.createElement("section");
      panel.id = "team-hub-debug-panel";
      panel.style.cssText = "margin:16px;padding:16px;background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;font-family:-apple-system,sans-serif;";
      panel.innerHTML =
        '<h2 style="margin:0 0 12px;font-size:16px;color:#92400e;">🐛 Announcement Badge Debug (?debug=announcements)</h2>' +
        authHtml +
        summaryHtml +
        '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead>' + headerHtml + '</thead>' +
          '<tbody>' + bodyHtml + '</tbody>' +
        '</table></div>' +
        '<p style="margin:12px 0 0;font-size:11px;color:#92400e;">' +
          'Old badge = pre-fix count (no audience filter). New badge = this preview (audience-filtered).<br>' +
          'Hub UI cards = what /team-hub.html actually renders in the unread section.<br>' +
          'Force mark read writes announcement_reads/{annId}_{uid} for the current user.' +
        '</p>';

      const main = document.querySelector("main") || document.body;
      if (main) main.insertBefore(panel, main.firstChild);

      // Wire Force-mark-read buttons → call markAnnouncementRead → reload.
      panel.addEventListener("click", function (ev) {
        const btn = ev.target.closest && ev.target.closest("[data-debug-mark-read]");
        if (!btn) return;
        const annId = btn.getAttribute("data-debug-mark-read");
        if (!annId) return;
        btn.disabled = true; btn.textContent = "writing…";
        markAnnouncementRead(annId, staff.uid, staff.email || "", 1)
          .then(function () { window.location.reload(); })
          .catch(function (err) {
            console.error("[debug] force mark read failed", err);
            btn.disabled = false; btn.textContent = "FAILED — retry?";
          });
      });

      try { console.info("[announcement-debug]", { oldBadge: oldBadge, newBadge: newBadge, hubCount: hubCount, rows: rows }); } catch (_e) {}
    } catch (err) {
      console.error("[announcement-debug] failed", err);
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
            // V20260614c — show debug panel if ?debug=announcements.
            // Runs AFTER the regular boot so the panel reflects the
            // same data + reads the user sees in the hub.
            maybeRunAnnouncementDebug(staff);
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
          // Phase 1C — Leadership Messages. Reads queued messages
          // targeting this tech (employee) or the team broadcast.
          // Soft-fails; non-blocking.
          bootLeadershipMessagesForStaff(staff);
          // Phase 3B — Messages from Pioneer (thread-based). Reads
          // communication_messages addressed to this tech, lets them
          // acknowledge or reply inline. Soft-fails; non-blocking.
          bootCommMessagesForStaff(staff);
          // Phase Employee Trust Layer — My Hours. Surfaces this
          // employee's paid time for the current payroll period and
          // lets them request a correction. Routes to the existing
          // createTimeAdjustmentRequestV1 Cloud Function so admin
          // review is unchanged.
          bootMyHoursForStaff(staff);
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
