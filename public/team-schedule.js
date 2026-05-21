/* Pioneer DCR Hub — Full Team Schedule page controller.
 *
 * Drives /team-schedule.html. Reads `published_team_schedule/current`
 * (Deputy-powered snapshot the admin publishes from Admin → Schedule)
 * and renders it grouped by week → day → shift row, with filters for
 * range (1/2/3 weeks), team scope (all / mine), tech, and customer.
 *
 * Snapshot model is intentional: this view does NOT reflect live
 * Deputy edits. Admins publish when ready (see admin.js
 * onPublishScheduleSubmit + functions/refreshDeputyShiftsRangeV1).
 *
 * Phase 2 TODO:
 *   • monthly calendar view + printable / PDF export of the
 *     generated schedule (so we can stop depending on a manual PDF
 *     upload entirely)
 *   • "Changed since last publish" diff highlights — requires a
 *     per-publish history subcollection so we can compare snapshots
 *   • tentative-week labels (Week 3 is usually less certain than
 *     Weeks 1-2 because Deputy may still be finalizing)
 *   • open-shift coverage indicators + shift-swap request flow
 *   • auto-publish every Wednesday after Deputy update lands
 *   • "Open Deputy" deep-link per shift (deputyShiftUrl is already
 *     captured in the snapshot schema)
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // KEEP IN SYNC across pages — same nav appears on each staff
  // surface. The team-schedule page sits "underneath" Team Hub in the
  // information hierarchy so we don't add it to the top-level role
  // nav; users reach it via the View Full Schedule button on Team Hub.
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
      return '<a class="' + cls + '" href="' + i.href + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  /* ---------- auth-screen plumbing (same shape as team-hub.js) ---------- */
  function setStaffAuthState(state) {
    const ids = ["staff-auth-checking", "staff-auth-signin", "staff-auth-denied"];
    ids.forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.hidden = (state !== id.replace("staff-auth-", ""));
    });
    const content = $("staff-auth-content");
    const account = $("staff-header-account");
    if (state === "content") {
      if (content) content.hidden = false;
      if (account) account.hidden = false;
    } else {
      if (content) content.hidden = true;
      if (account) account.hidden = true;
    }
  }

  function paintStaffIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    if (nameEl)  nameEl.textContent  = (staff && (staff.display_name || (staff.tech && staff.tech.display_name))) || "";
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
  }

  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        try { firebase.auth().signOut(); } catch (e) { console.error(e); }
      });
    });
  }

  function wireSignInButton() {
    const btn = $("staff-signin-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        firebase.auth().signInWithPopup(provider).catch(function (err) {
          console.warn("[team-schedule] sign-in failed", err);
        });
      });
    }
  }

  /* ---------- snapshot state ---------- */
  let snapshot      = null;     // raw published_team_schedule/current data
  let pdfBackup     = null;     // raw team_schedule/current data (if any)
  let currentStaff  = null;
  let techDirectory = new Map(); // techSlug → { display_name, photo_url, color, email }
  let renderedShifts = [];      // filtered shifts in current view order

  // Filter state. View mode defaults to "assignment" (Pioneer-native
  // dispatch board) on first visit; existing localStorage preferences
  // are honored. The v2 storage key invalidates pre-Assignment-View
  // saved choices so the new default actually wins for pilot users.
  const VIEW_MODE_KEY = "pioneer.teamSchedule.viewMode.v2";
  // Single source of truth for valid view-mode values. Must stay in
  // sync with the data-view attributes in team-schedule.html and the
  // branches in renderShifts(). Adding a new view = update this
  // list, the toolbar HTML, and the renderShifts router.
  const ALLOWED_VIEW_MODES = ["assignment", "list", "calendar"];
  // Scope is persisted per-role so a tech who deliberately switches
  // to "All team" mid-shift sees the same view next time. A fresh
  // account (no saved scope) falls through to role-aware defaults:
  // techs → "mine", admins → "all".
  const SCOPE_KEY_PREFIX = "pioneer.teamSchedule.scope.";
  const state = {
    rangeWeeks: 2,
    scope:      "all",          // "all" | "mine" | "tech:<slug>"
    customer:   "all",
    viewMode:   "assignment",   // "assignment" | "list" | "calendar"
    // Open-week set drives the collapsible week sections in List +
    // Calendar modes. Default is Week 0 only.
    openWeeks:  new Set([0])
  };

  /* ---------- helpers ---------- */

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Deterministic color from a stable string. Mirrors the avatar
  // convention used across HR / scheduling tools — same person, same
  // accent, every time. Returns { bg, fg, ring } colors.
  function colorForSeed(seed) {
    const s = String(seed || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    const hue = Math.abs(h) % 360;
    return {
      bg:   "hsl(" + hue + " 70% 92%)",
      ring: "hsl(" + hue + " 55% 60%)",
      fg:   "hsl(" + hue + " 50% 28%)"
    };
  }

  function dateToMs(yyyymmdd) {
    if (!yyyymmdd) return null;
    return new Date(yyyymmdd + "T12:00:00Z").getTime();
  }
  function msToISODate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Pioneer workweek is Sun–Thu. Friday/Saturday are intentionally
  // hidden from the calendar grid to give 5 wider columns. This
  // helper snaps a YYYY-MM-DD to the Sunday on or before it, in
  // Pacific TZ. Implementation: the noon-UTC anchor we use elsewhere
  // gives the same getUTCDay() result as the Pacific weekday (since
  // Pacific is GMT-7/-8 and noon UTC = morning Pacific same day).
  function sundayOnOrBefore(yyyymmdd) {
    const ms = dateToMs(yyyymmdd);
    if (ms == null) return yyyymmdd;
    const weekday = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
    return msToISODate(ms - weekday * 86400000);
  }

  // Pioneer workweek = Sun(0), Mon(1), Tue(2), Wed(3), Thu(4)
  // Friday=5, Saturday=6 are excluded by default.
  const WORKWEEK_DAY_COUNT = 5;
  function isWeekendDay(yyyymmdd) {
    const ms = dateToMs(yyyymmdd);
    if (ms == null) return false;
    const w = new Date(ms).getUTCDay();
    return w === 5 || w === 6;
  }
  function formatWeekRangeLabel(startYmd, endYmd) {
    try {
      const startMs = dateToMs(startYmd);
      const endMs   = dateToMs(endYmd);
      const fmtMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "America/Los_Angeles" });
      const fmtDay   = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "America/Los_Angeles" });
      return fmtMonth.format(new Date(startMs)) + " " + fmtDay.format(new Date(startMs)) +
             " — " +
             fmtMonth.format(new Date(endMs))   + " " + fmtDay.format(new Date(endMs));
    } catch (_e) {
      return startYmd + " — " + endYmd;
    }
  }
  function formatDayLabel(yyyymmdd) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) {
      return yyyymmdd;
    }
  }
  function formatPublishedAt(ts) {
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

  /* ---------- load ---------- */
  async function loadSnapshot() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    const db = firebase.firestore();
    try {
      const [pubSnap, pdfSnap] = await Promise.all([
        db.collection("published_team_schedule").doc("current").get(),
        db.collection("team_schedule").doc("current").get()
      ]);
      snapshot  = (pubSnap && pubSnap.exists) ? pubSnap.data() : null;
      pdfBackup = (pdfSnap && pdfSnap.exists) ? pdfSnap.data() : null;
    } catch (err) {
      console.warn("[team-schedule] snapshot read failed", err);
      snapshot  = null;
      pdfBackup = null;
    }
  }

  async function loadTechDirectory() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore().collection("cleaning_techs").get();
      techDirectory = new Map();
      snap.docs.forEach(function (d) {
        const data = d.data() || {};
        const slug = d.id || data.slug || "";
        if (!slug) return;
        techDirectory.set(slug, {
          slug:         slug,
          display_name: data.display_name || data.name || slug,
          photo_url:    data.photoUrl || data.profilePhotoUrl || "",
          email:        (data.email || "").toLowerCase()
        });
      });
    } catch (err) {
      console.warn("[team-schedule] tech directory read failed", err);
      // Soft-fail — we can render without avatars/colors.
      techDirectory = new Map();
    }
  }

  /* ---------- range / filter helpers ---------- */
  function snapshotWeeks() {
    if (!snapshot || !snapshot.startDate || !snapshot.endDate) return 1;
    const span = (dateToMs(snapshot.endDate) - dateToMs(snapshot.startDate)) / 86400000 + 1;
    return Math.max(1, Math.min(3, Math.ceil(span / 7)));
  }

  function applyDefaultRange() {
    const weeks = snapshotWeeks();
    // Prefer the largest available, capped at 3 (mirrors the spec —
    // default 2 or 3 weeks if data exists).
    state.rangeWeeks = Math.min(3, weeks);
  }

  function applyDefaultViewMode() {
    // 1. Honor a remembered preference if it's a valid value.
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved && ALLOWED_VIEW_MODES.indexOf(saved) >= 0) {
        state.viewMode = saved;
        return;
      }
    } catch (_e) { /* private mode / quota — fall through */ }
    // 2. First visit: Assignment View. Pioneer-native dispatch board
    // is the right primary for cleaning ops; Calendar/List remain
    // available as supervisor / printable alternatives.
    state.viewMode = "assignment";
  }

  function persistViewMode() {
    try { localStorage.setItem(VIEW_MODE_KEY, state.viewMode); }
    catch (_e) { /* ignore — view mode is a UI preference, not data */ }
  }

  function scopeStorageKey() {
    const role = (currentStaff && currentStaff.role) || "anon";
    return SCOPE_KEY_PREFIX + role;
  }
  function readSavedScope() {
    try { return localStorage.getItem(scopeStorageKey()) || ""; }
    catch (_e) { return ""; }
  }
  function persistScope() {
    try { localStorage.setItem(scopeStorageKey(), state.scope); }
    catch (_e) { /* ignore */ }
  }
  // Tells us whether a stored scope value is meaningful for the
  // current snapshot. "all" and "mine" are always valid; "tech:slug"
  // is only valid if the snapshot contains that tech.
  function isScopeValid(scope, snapshotShifts) {
    if (!scope) return false;
    if (scope === "all" || scope === "mine") return true;
    if (scope.indexOf("tech:") === 0) {
      const slug = scope.slice(5);
      if (!slug) return false;
      return (snapshotShifts || []).some(function (s) { return (s.techSlug || "") === slug; });
    }
    return false;
  }

  function inMyShifts(shift) {
    if (!currentStaff) return false;
    const myEmail = String(currentStaff.email || "").toLowerCase();
    const mySlug  = String((currentStaff.tech && (currentStaff.tech.slug || currentStaff.tech.tech_slug)) || "").toLowerCase();
    const shiftSlug  = String(shift.techSlug || "").toLowerCase();
    const shiftEmail = ""; // techEmail not stored on shift — match by slug.
    if (mySlug && shiftSlug && mySlug === shiftSlug) return true;
    // Fallback by display name match against the tech directory entry
    // whose email matches the signed-in user.
    if (myEmail) {
      const entry = Array.from(techDirectory.values()).find(function (t) {
        return t.email && t.email === myEmail;
      });
      if (entry && entry.slug && shiftSlug && entry.slug === shiftSlug) return true;
    }
    return false;
  }

  function withinSelectedWindow(shift) {
    if (!snapshot || !snapshot.startDate) return true;
    const startMs = dateToMs(snapshot.startDate);
    const cutoff  = startMs + (state.rangeWeeks * 7 - 1) * 86400000;
    const shiftMs = dateToMs(shift.date);
    if (shiftMs == null) return false;
    return shiftMs >= startMs && shiftMs <= cutoff;
  }

  function applyFilters(shifts) {
    if (!Array.isArray(shifts)) return [];
    return shifts.filter(function (s) {
      if (!withinSelectedWindow(s)) return false;
      if (state.scope === "mine" && !inMyShifts(s)) return false;
      if (state.scope.indexOf("tech:") === 0) {
        const wanted = state.scope.slice(5);
        if ((s.techSlug || "") !== wanted) return false;
      }
      if (state.customer !== "all" && (s.customerSlug || s.customerName) !== state.customer) return false;
      return true;
    });
  }

  /* ---------- render ---------- */
  // Convert a Firestore timestamp / number / ISO string to a millis
  // epoch. Returns null on anything unparseable.
  function tsToMillis(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts === "number")            return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    return null;
  }

  function paintMetaCard() {
    const card = $("ts-meta-card");
    if (!card) return;
    if (!snapshot) {
      card.hidden = true;
      card.removeAttribute("data-freshness");
      return;
    }
    const rangeEl  = $("ts-meta-range");
    const whenEl   = $("ts-meta-when");
    const shiftsEl = $("ts-meta-shifts");
    if (rangeEl)  rangeEl.textContent  =
      (snapshot.startDate || "—") + " → " + (snapshot.endDate || "—") +
      (snapshot.viewRangeDays ? "  (" + snapshot.viewRangeDays + " days)" : "");

    // Snapshot freshness — color the "Published X" line based on
    // age. Fresh (0-2 days) reads normal; stale (3-6) reads amber;
    // very stale (7+) reads red. Pilot blocker fix #2 — operators
    // glancing at this page should never confuse last week's snapshot
    // for tonight's coverage.
    const publishedMs = tsToMillis(snapshot.publishedAt);
    let freshness = "fresh";
    let ageLabel  = "";
    if (publishedMs != null) {
      const ageDays = Math.floor((Date.now() - publishedMs) / 86400000);
      if      (ageDays >= 7) { freshness = "stale";    ageLabel = " · " + ageDays + " days old"; }
      else if (ageDays >= 3) { freshness = "aging";    ageLabel = " · " + ageDays + " days old"; }
      else if (ageDays >= 1) {                          ageLabel = " · " + ageDays + (ageDays === 1 ? " day ago" : " days ago"); }
    } else {
      freshness = "unknown";
    }
    card.setAttribute("data-freshness", freshness);
    if (whenEl) whenEl.textContent =
      "Published " + formatPublishedAt(snapshot.publishedAt) + ageLabel;

    if (shiftsEl) shiftsEl.textContent = (snapshot.shiftCount || (snapshot.shifts || []).length) + " shifts";

    const pdfEl = $("ts-pdf-link");
    if (pdfEl) {
      if (pdfBackup && pdfBackup.downloadUrl && pdfBackup.active !== false) {
        pdfEl.href = pdfBackup.downloadUrl;
        pdfEl.setAttribute("download", pdfBackup.fileName || "team-schedule.pdf");
        pdfEl.hidden = false;
      } else {
        pdfEl.hidden = true;
      }
    }
    card.hidden = false;
  }

  function populateFilterDropdowns() {
    if (!snapshot) return;
    const shifts = Array.isArray(snapshot.shifts) ? snapshot.shifts : [];

    const techMap = new Map();
    const custMap = new Map();
    shifts.forEach(function (s) {
      if (s.techSlug && !techMap.has(s.techSlug)) {
        techMap.set(s.techSlug, s.techName || s.techSlug);
      }
      const cKey = s.customerSlug || s.customerName || "";
      if (cKey && !custMap.has(cKey)) {
        custMap.set(cKey, s.customerName || cKey);
      }
    });

    // Scope dropdown folds in the tech filter as a "— Tech: …" group.
    // Default per role: techs → "mine", admins → "all". User's saved
    // scope (per-role, in localStorage) wins when it's still valid
    // for the current snapshot. Blocker fix #3.
    const scopeSel = $("ts-filter-scope");
    if (scopeSel) {
      const sortedTechs = Array.from(techMap.entries())
        .sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
      scopeSel.innerHTML =
        '<option value="all">All team</option>' +
        '<option value="mine">My schedule</option>' +
        '<optgroup label="Filter by tech">' +
          sortedTechs.map(function (kv) {
            return '<option value="tech:' + escapeHtml(kv[0]) + '">' + escapeHtml(kv[1]) + '</option>';
          }).join("") +
        '</optgroup>';

      const isCleaningTech = currentStaff && currentStaff.role === "cleaning_tech";
      const roleDefault    = isCleaningTech ? "mine" : "all";
      const saved          = readSavedScope();
      const chosen = isScopeValid(saved, snapshot.shifts) ? saved : roleDefault;
      scopeSel.value = chosen;
      state.scope    = chosen;
    }

    const custSel = $("ts-filter-customer");
    if (custSel) {
      const sortedCust = Array.from(custMap.entries())
        .sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
      custSel.innerHTML =
        '<option value="all">All customers</option>' +
        sortedCust.map(function (kv) {
          return '<option value="' + escapeHtml(kv[0]) + '">' + escapeHtml(kv[1]) + '</option>';
        }).join("");
    }
  }

  function paintRangePills() {
    const pills = document.querySelectorAll(".ts-filter-range .ts-pill");
    pills.forEach(function (p) {
      const active = String(p.dataset.range) === String(state.rangeWeeks);
      p.classList.toggle("is-active", active);
      p.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function paintViewModePills() {
    const pills = document.querySelectorAll(".ts-filter-view .ts-pill");
    pills.forEach(function (p) {
      const active = p.dataset.view === state.viewMode;
      p.classList.toggle("is-active", active);
      p.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  // Google-Calendar-style compact event pill. Customer-first, one
  // line, ~26px tall. Tech identity is conveyed by the avatar color/
  // photo (not by a text label) per the rule that the tech already
  // knows who they are — what they don't know at a glance is which
  // customer they're going to. Pills are informational (not clickable
  // in this pilot — the detail drawer was removed to fix a placeholder
  // bug). Hover surfaces the full tooltip with tech, customer, time,
  // and any notes.
  //
  // Note icon (📝) sits at the right edge between customer + time
  // when notes exist, so admins/techs scanning a busy day cell still
  // see "this shift has context to read".
  function calendarShiftPill(s, _idx) {
    const techName = s.techName || "Tech";
    const techDir  = techDirectory.get(s.techSlug) || null;
    const initial  = (techName.trim().charAt(0) || "?").toUpperCase();
    const color    = colorForSeed(s.techSlug || techName);
    const photoUrl = techDir ? techDir.photo_url : "";
    const avatar   = photoUrl
      ? '<span class="ts-cal-event-avatar"><img src="' + escapeHtml(photoUrl) + '" alt="" /></span>'
      : '<span class="ts-cal-event-avatar ts-cal-event-avatar--initial"' +
          ' style="background:' + color.bg + ';color:' + color.fg + ';border-color:' + color.ring + ';">' +
          escapeHtml(initial) +
        '</span>';

    const customerLabel = s.customerName || s.customerSlug || "Unassigned";
    const timeFull      = s.endTime
      ? (escapeHtml(s.startTime) + "–" + escapeHtml(s.endTime))
      :  escapeHtml(s.startTime);
    // Tooltip carries the full operational context — admins see it on
    // hover. The pill itself stays customer-first so a glance at the
    // grid reads as "which buildings tonight, who owns them" rather
    // than time-block coordinates.
    const tooltip = techName + " · " + customerLabel + " · " + timeFull +
      (s.notes ? "\n\nNotes: " + s.notes : "");
    const noteIcon = s.notes
      ? '<span class="ts-cal-event-note" aria-label="Has shift notes" title="Has shift notes">📝</span>'
      : '';

    return (
      '<li class="ts-cal-event"' +
        ' style="--tech-accent:' + color.ring + ';--tech-tint:' + color.bg + ';"' +
        ' title="' + escapeHtml(tooltip) + '">' +
        avatar +
        '<span class="ts-cal-event-customer">' + escapeHtml(customerLabel) + '</span>' +
        noteIcon +
      '</li>'
    );
  }

  /* ---------- Assignment View ----------
     Pioneer-native dispatch board. Grouped by day → tech → customer.
     The product question this view answers is "what buildings tonight,
     who owns them, what's unfinished" — NOT "what time-block does this
     shift occupy". So:
       • Customer/building name is the primary signal (large, bold)
       • Tech identity (avatar + name) is the secondary grouping
       • Time is shown but de-emphasized; flex-start workflows don't
         hinge on exact start times
       • Action buttons per assignment route to Customer Info Hub,
         the DCR form, and Supply Station with the slug prefilled

     Phase 2 TODO (mirror admin.html note):
       • per-shift status chips (Remaining / In Progress / Completed)
         once we have a write-back path from DCR submit
       • "open buildings without owners" supervisor surface
       • drag-to-reassign within a day (admins only)
  */
  function renderAssignmentView(shifts) {
    const container = $("ts-assignment");
    if (!container) return;
    if (!snapshot || !shifts.length) {
      container.innerHTML = "";
      container.hidden = true;
      return;
    }

    // Group by date in ascending order, then by tech (sorted by name
    // for stable scan rhythm; the tech accent color carries identity).
    const byDay = new Map();   // date → Map(techSlug → { tech, shifts[] })
    shifts.forEach(function (s) {
      if (!s.date) return;
      if (!byDay.has(s.date)) byDay.set(s.date, new Map());
      const techMap = byDay.get(s.date);
      const techKey = s.techSlug || s.techName || "(unassigned)";
      if (!techMap.has(techKey)) {
        techMap.set(techKey, {
          techSlug: s.techSlug || "",
          techName: s.techName || "Unassigned",
          shifts:   []
        });
      }
      techMap.get(techKey).shifts.push(s);
    });

    // Today-in-Pacific for the "Tonight" pill on the matching day.
    let todayIso;
    try {
      todayIso = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
    } catch (_e) { todayIso = new Date().toISOString().slice(0, 10); }

    const days = Array.from(byDay.keys()).sort();
    const blocks = days.map(function (date) {
      const techMap = byDay.get(date);
      const totalShifts = Array.from(techMap.values())
        .reduce(function (acc, t) { return acc + t.shifts.length; }, 0);

      const techBlocks = Array.from(techMap.values())
        .sort(function (a, b) {
          return String(a.techName || "").localeCompare(String(b.techName || ""));
        })
        .map(renderAssignmentTechBlock);

      const isTonight = (date === todayIso);
      const dayClass  = "ts-assn-day" + (isTonight ? " is-tonight" : "");
      const tonightChip = isTonight
        ? '<span class="ts-assn-tonight">Tonight</span>'
        : '';

      return (
        '<section class="' + dayClass + '">' +
          '<header class="ts-assn-day-head">' +
            '<h2 class="ts-assn-day-title">' + escapeHtml(formatDayLabel(date)) + '</h2>' +
            tonightChip +
            '<span class="ts-assn-day-count">' + totalShifts +
              (totalShifts === 1 ? ' building · ' : ' buildings · ') +
              techMap.size + (techMap.size === 1 ? ' tech' : ' techs') +
            '</span>' +
          '</header>' +
          techBlocks.join("") +
        '</section>'
      );
    });

    container.innerHTML = blocks.join("");
    container.hidden = false;
  }

  function renderAssignmentTechBlock(group) {
    const color    = colorForSeed(group.techSlug || group.techName);
    const techDir  = techDirectory.get(group.techSlug) || null;
    const photoUrl = techDir ? techDir.photo_url : "";
    const initial  = (String(group.techName || "?").trim().charAt(0) || "?").toUpperCase();
    const avatar   = photoUrl
      ? '<span class="ts-assn-avatar"><img src="' + escapeHtml(photoUrl) + '" alt="" /></span>'
      : '<span class="ts-assn-avatar ts-assn-avatar--initial"' +
          ' style="background:' + color.bg + ';color:' + color.fg + ';border-color:' + color.ring + ';">' +
          escapeHtml(initial) +
        '</span>';

    // Sort assignments within a tech by start time so the operational
    // run-of-show reads naturally.
    const cards = group.shifts.slice().sort(function (a, b) {
      return (a.startMs || 0) - (b.startMs || 0);
    }).map(renderAssignmentCard).join("");

    return (
      '<article class="ts-assn-tech" style="--tech-accent:' + color.ring + ';">' +
        '<header class="ts-assn-tech-head">' +
          avatar +
          '<h3 class="ts-assn-tech-name">' + escapeHtml(group.techName) + '</h3>' +
          '<span class="ts-assn-tech-count">' + group.shifts.length + '</span>' +
        '</header>' +
        '<ul class="ts-assn-list">' + cards + '</ul>' +
      '</article>'
    );
  }

  // Dispatch-board ownership row. Single-line, customer-first.
  // No giant action buttons — the row itself is a link to the
  // Customer Info Hub (which already exposes Info + Security + SOP).
  // Time is a small right-aligned subtitle. Tech identity is conveyed
  // by the tech-color bullet on the left + the surrounding tech
  // section header above.
  function renderAssignmentCard(s) {
    const customer  = s.customerName || s.customerSlug || "Unassigned building";
    const timeRange = s.endTime
      ? (escapeHtml(s.startTime) + "–" + escapeHtml(s.endTime))
      : (escapeHtml(s.startTime) || "");
    const noteIcon = s.notes
      ? ' <span class="ts-assn-note" title="' + escapeHtml(s.notes) + '">📝</span>'
      : '';
    const slug = s.customerSlug || "";

    // Whole row tap-target → Customer Info Hub when slug is present.
    // When unlinkable, render a static row (no anchor) so the user
    // doesn't get a dead-tap.
    const inner =
      '<span class="ts-assn-dot" aria-hidden="true"></span>' +
      '<span class="ts-assn-customer">' + escapeHtml(customer) + '</span>' +
      noteIcon +
      (timeRange
        ? '<span class="ts-assn-time">' + timeRange + '</span>'
        : '');

    return slug
      ? ('<li class="ts-assn-row"><a class="ts-assn-link" href="/tech.html?customer_slug=' +
          encodeURIComponent(slug) +
          '" title="Open customer info, security, SOP">' + inner + '</a></li>')
      : ('<li class="ts-assn-row is-unlinked">' + inner + '</li>');
  }

  // Pioneer workweek calendar — Sun–Thu only, 5 columns per row.
  // Anchored to the Sunday on or before snapshot.startDate so the
  // grid reads as full workweeks even when a publish straddles a
  // weekend boundary. Friday/Saturday shifts are intentionally
  // dropped from the grid (still visible in List view); a small
  // count is exposed via window.tsHiddenWeekendCount so the caller
  // can surface it in the summary chip.
  function renderCalendar(shifts) {
    const container = $("ts-calendar");
    if (!container) return;

    if (!snapshot || !shifts.length) {
      container.innerHTML = "";
      container.hidden = true;
      window.tsHiddenWeekendCount = 0;
      return;
    }

    const workweekAnchor   = sundayOnOrBefore(snapshot.startDate);
    const workweekAnchorMs = dateToMs(workweekAnchor);

    // Bucket by Pioneer-workweek index (0..rangeWeeks-1) → date map.
    // Fri/Sat shifts go to the "weekend" bucket and never render.
    const byWeek = new Map();
    let weekendHidden = 0;
    shifts.forEach(function (s) {
      const shiftMs = dateToMs(s.date);
      if (shiftMs == null) return;
      if (isWeekendDay(s.date)) { weekendHidden += 1; return; }
      const wIdx = Math.max(0, Math.floor((shiftMs - workweekAnchorMs) / 86400000 / 7));
      if (wIdx >= state.rangeWeeks) return;
      if (!byWeek.has(wIdx)) byWeek.set(wIdx, new Map());
      const dayMap = byWeek.get(wIdx);
      if (!dayMap.has(s.date)) dayMap.set(s.date, []);
      dayMap.get(s.date).push(s);
    });
    window.tsHiddenWeekendCount = weekendHidden;

    let nowDayIso;
    try {
      nowDayIso = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
    } catch (_e) { nowDayIso = new Date().toISOString().slice(0, 10); }

    const weekBlocks = [];
    for (let wIdx = 0; wIdx < state.rangeWeeks; wIdx++) {
      const dayMap = byWeek.get(wIdx) || new Map();
      const weekStartMs = workweekAnchorMs + wIdx * 7 * 86400000;
      const weekEndMs   = weekStartMs + (WORKWEEK_DAY_COUNT - 1) * 86400000;  // Thursday
      const weekLabel = "Week " + (wIdx + 1) + " · " +
        formatWeekRangeLabel(msToISODate(weekStartMs), msToISODate(weekEndMs));

      const dayCells = [];
      for (let dOffset = 0; dOffset < WORKWEEK_DAY_COUNT; dOffset++) {
        const dayMs   = weekStartMs + dOffset * 86400000;
        const dayIso  = msToISODate(dayMs);
        const dayShifts = (dayMap.get(dayIso) || [])
          .slice()
          .sort(function (a, b) {
            if (a.startMs !== b.startMs) return (a.startMs || 0) - (b.startMs || 0);
            return String(a.techName || "").localeCompare(String(b.techName || ""));
          });
        const dayDate = new Date(dayMs);
        let weekdayShort = "";
        let monthDay     = "";
        try {
          weekdayShort = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", weekday: "short"
          }).format(dayDate);
          monthDay = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", month: "short", day: "numeric"
          }).format(dayDate);
        } catch (_e) { weekdayShort = ""; monthDay = dayIso; }
        const isToday = (dayIso === nowDayIso);

        const cellHead =
          '<div class="ts-cal-day-head' + (isToday ? ' is-today' : '') + '">' +
            '<span class="ts-cal-weekday">' + escapeHtml(weekdayShort) + '</span>' +
            '<span class="ts-cal-monthday">' + escapeHtml(monthDay) + '</span>' +
          '</div>';
        const cellBody = dayShifts.length
          ? '<ul class="ts-cal-events">' + dayShifts.map(function (s) {
              return calendarShiftPill(s);
            }).join("") + '</ul>'
          : '<p class="ts-cal-empty">—</p>';
        dayCells.push(
          '<div class="ts-cal-day' + (dayShifts.length ? '' : ' is-empty') +
            (isToday ? ' is-today' : '') + '">' +
            cellHead + cellBody +
          '</div>'
        );
      }

      const weekShiftCount = Array.from(dayMap.values())
        .reduce(function (acc, arr) { return acc + arr.length; }, 0);

      weekBlocks.push(
        '<details class="ts-cal-week-block" data-week-idx="' + wIdx + '"' +
          (state.openWeeks.has(wIdx) ? ' open' : '') + '>' +
          '<summary class="ts-cal-week-head">' +
            '<span class="ts-cal-week-chevron" aria-hidden="true">▸</span>' +
            '<h2 class="ts-cal-week-title">' + escapeHtml(weekLabel) + '</h2>' +
            '<span class="ts-cal-week-count">' + weekShiftCount +
              (weekShiftCount === 1 ? ' shift' : ' shifts') + '</span>' +
          '</summary>' +
          '<div class="ts-cal-week">' + dayCells.join("") + '</div>' +
        '</details>'
      );
    }

    container.innerHTML = weekBlocks.join("");
    container.hidden = false;
    wireWeekToggle(container);
  }

  // Track open/closed week sections so renders preserve the user's
  // expanded set. Listens for the native `<details>` toggle event.
  function wireWeekToggle(container) {
    container.querySelectorAll("details[data-week-idx]").forEach(function (d) {
      d.addEventListener("toggle", function () {
        const idx = parseInt(d.dataset.weekIdx, 10);
        if (isNaN(idx)) return;
        if (d.open) state.openWeeks.add(idx);
        else        state.openWeeks.delete(idx);
      });
    });
  }

  function renderShifts() {
    paintRangePills();
    paintViewModePills();
    const listContainer = $("ts-weeks");
    const calContainer  = $("ts-calendar");
    const assnContainer = $("ts-assignment");
    const empty   = $("ts-empty");
    const noMatch = $("ts-no-matches");
    const summary = $("ts-filter-summary");
    if (!listContainer || !calContainer || !assnContainer || !empty || !noMatch || !summary) return;

    function hideAllViews() {
      listContainer.hidden = true;
      calContainer.hidden  = true;
      assnContainer.hidden = true;
    }
    function clearInactive(active) {
      if (active !== "list")       { listContainer.innerHTML = ""; listContainer.hidden = true; }
      if (active !== "calendar")   { calContainer.innerHTML  = ""; calContainer.hidden  = true; }
      if (active !== "assignment") { assnContainer.innerHTML = ""; assnContainer.hidden = true; }
    }

    if (!snapshot) {
      hideAllViews();
      noMatch.hidden = true;
      empty.hidden = false;
      summary.textContent = "—";
      return;
    }

    const shifts = applyFilters(snapshot.shifts || []);
    renderedShifts = shifts;
    window.tsHiddenWeekendCount = 0;
    const viewLabel = state.viewMode === "calendar"  ? "Coverage (Sun–Thu)"
                    : state.viewMode === "list"      ? "List"
                    :                                  "Assignments";
    // Soft summary chip — only mention the count delta when filters
    // actually reduced the set; otherwise just show the view label.
    // Hidden on mobile by the existing CSS rule.
    const total    = (snapshot.shifts || []).length;
    const filtered = shifts.length !== total;
    let baseSummary = filtered
      ? (shifts.length + " of " + total + " · " + viewLabel)
      : viewLabel;
    summary.textContent = baseSummary;

    if (shifts.length === 0) {
      hideAllViews();
      empty.hidden = true;
      noMatch.hidden = false;
      return;
    }
    empty.hidden = true;
    noMatch.hidden = true;

    // Route to the active renderer; empty the other two containers.
    if (state.viewMode === "assignment") {
      clearInactive("assignment");
      renderAssignmentView(shifts);
      return;
    }
    if (state.viewMode === "calendar") {
      clearInactive("calendar");
      renderCalendar(shifts);
      const hiddenWeekend = window.tsHiddenWeekendCount || 0;
      if (hiddenWeekend > 0) {
        summary.textContent = baseSummary + " · " + hiddenWeekend +
          " Fri/Sat hidden — switch to List";
      }
      return;
    }
    // List view — falls through to the existing renderer below.
    clearInactive("list");

    // Group by week (relative to snapshot.startDate), then by day.
    // Each shift carries its filtered-array index so the click handler
    // can fetch the full record from renderedShifts.
    const startMs = dateToMs(snapshot.startDate);
    const byWeek  = new Map();
    shifts.forEach(function (s, idx) {
      const shiftMs = dateToMs(s.date);
      if (shiftMs == null) return;
      const wIdx = Math.max(0, Math.floor((shiftMs - startMs) / 86400000 / 7));
      if (!byWeek.has(wIdx)) byWeek.set(wIdx, new Map());
      const dayMap = byWeek.get(wIdx);
      if (!dayMap.has(s.date)) dayMap.set(s.date, []);
      dayMap.get(s.date).push({ s: s, idx: idx });
    });

    // Sort weeks ascending.
    const weekIndexes = Array.from(byWeek.keys()).sort(function (a, b) { return a - b; });
    const blocks = weekIndexes.map(function (wIdx) {
      const dayMap = byWeek.get(wIdx);
      const days = Array.from(dayMap.keys()).sort();
      const weekStartMs = startMs + wIdx * 7 * 86400000;
      const weekEndMs   = weekStartMs + 6 * 86400000;
      const weekLabel = "Week " + (wIdx + 1) + " · " +
        formatWeekRangeLabel(msToISODate(weekStartMs), msToISODate(weekEndMs));
      const weekShiftCount = Array.from(dayMap.values())
        .reduce(function (acc, arr) { return acc + arr.length; }, 0);

      const dayBlocks = days.map(function (date) {
        const rows = dayMap.get(date).slice().sort(function (a, b) {
          const sa = a.s, sb = b.s;
          if (sa.startMs !== sb.startMs) return (sa.startMs || 0) - (sb.startMs || 0);
          return String(sa.techName || "").localeCompare(String(sb.techName || ""));
        }).map(function (entry) {
          const s  = entry.s;
          const techName = s.techName || "Tech";
          const techDir  = techDirectory.get(s.techSlug) || null;
          const initial  = (techName.trim().charAt(0) || "?").toUpperCase();
          const color    = colorForSeed(s.techSlug || techName);
          const photoUrl = techDir ? techDir.photo_url : "";
          const avatar   = photoUrl
            ? '<span class="ts-row-avatar"><img src="' + escapeHtml(photoUrl) + '" alt="" /></span>'
            : '<span class="ts-row-avatar ts-row-avatar--initial"' +
                ' style="background:' + color.bg + ';color:' + color.fg + ';border-color:' + color.ring + ';">' +
                escapeHtml(initial) +
              '</span>';
          const timeRange = s.endTime
            ? (escapeHtml(s.startTime) + "–" + escapeHtml(s.endTime))
            :  escapeHtml(s.startTime);
          const notesHtml = s.notes
            ? '<p class="ts-row-notes">' + escapeHtml(s.notes) + '</p>' : '';
          // Customer-first list rows. Primary line is the building
          // name (bold). Tech + time live on the secondary line as
          // operational context.
          const statusHtml = s.status && s.status !== "scheduled"
            ? '<span class="ts-row-status">' + escapeHtml(s.status) + '</span>'
            : '';
          return (
            '<li class="ts-row"' +
              ' style="--tech-accent:' + color.ring + ';">' +
              avatar +
              '<div class="ts-row-body">' +
                '<div class="ts-row-line">' +
                  '<span class="ts-row-customer">' + escapeHtml(s.customerName || "Unassigned") + '</span>' +
                  statusHtml +
                '</div>' +
                '<div class="ts-row-line ts-row-line--secondary">' +
                  '<span class="ts-row-tech">' + escapeHtml(techName) + '</span>' +
                  (timeRange
                    ? '<span class="ts-row-sep" aria-hidden="true">·</span>' +
                      '<span class="ts-row-time">' + timeRange + '</span>'
                    : '') +
                '</div>' +
                notesHtml +
              '</div>' +
            '</li>'
          );
        }).join("");
        return (
          '<section class="ts-day">' +
            '<h3 class="ts-day-head">' + escapeHtml(formatDayLabel(date)) + '</h3>' +
            '<ul class="ts-day-rows">' + rows + '</ul>' +
          '</section>'
        );
      }).join("");

      return (
        '<details class="ts-week" data-week-idx="' + wIdx + '"' +
          (state.openWeeks.has(wIdx) ? ' open' : '') + '>' +
          '<summary class="ts-week-head">' +
            '<span class="ts-week-chevron" aria-hidden="true">▸</span>' +
            '<h2 class="ts-week-title">' + escapeHtml(weekLabel) + '</h2>' +
            '<span class="ts-week-count">' + weekShiftCount +
              (weekShiftCount === 1 ? ' shift' : ' shifts') + '</span>' +
          '</summary>' +
          dayBlocks +
        '</details>'
      );
    });

    listContainer.innerHTML = blocks.join("");
    listContainer.hidden = false;
    wireWeekToggle(listContainer);
  }

  /* ---------- Shift detail drawer (DISABLED for pilot) ----------
     The previous implementation was opening with placeholder dashes
     in unusual edge cases (race / stale state / malformed shifts).
     Per pilot direction we disabled click-to-open entirely. Shift
     pills and list rows render as informational only; details surface
     via the existing tooltip on hover.

     Future re-enable should:
       1. Open ONLY with a guaranteed-populated shift record
       2. Require customerName, techName, date, and startTime all set
       3. Reset body scroll + close on every renderShifts() call so
          no stale modal can persist across filter changes / reload */

  function wireFilterControls() {
    const card = $("ts-filters-card");
    if (!card) return;
    // View-mode pills.
    card.querySelectorAll(".ts-filter-view .ts-pill").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const v = String(btn.dataset.view || "");
        try { console.info("[TeamSchedule] view tab clicked", { view: v }); } catch (_e) {}
        // ALLOWED_VIEW_MODES is the source of truth — must match
        // state.viewMode values + the data-view attributes in the
        // toolbar. Previously this guard was hardcoded to
        // ("calendar" | "list") which silently dropped "assignment"
        // taps and made the Assignments pill un-reselectable after
        // switching away. Reselecting the current view is a valid
        // no-op (we still call renderShifts so the user gets
        // immediate visual feedback).
        if (ALLOWED_VIEW_MODES.indexOf(v) < 0) {
          try { console.warn("[TeamSchedule] unknown view tab", { view: v }); } catch (_e) {}
          return;
        }
        const prev = state.viewMode;
        try { console.info("[TeamSchedule] setView", { oldView: prev, newView: v }); } catch (_e) {}
        state.viewMode = v;
        persistViewMode();
        renderShifts();
      });
    });
    // Range pills.
    card.querySelectorAll(".ts-filter-range .ts-pill").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const v = Number(btn.dataset.range);
        if (!v) return;
        state.rangeWeeks = Math.max(1, Math.min(3, v));
        // Reset open-weeks to "first one only" when the range changes,
        // so a fresh 3-week view doesn't carry stale Week 4 open state.
        state.openWeeks = new Set([0]);
        renderShifts();
      });
    });
    const scopeEl = $("ts-filter-scope");
    if (scopeEl) scopeEl.addEventListener("change", function () {
      state.scope = scopeEl.value || "all";
      persistScope();
      renderShifts();
    });
    const custEl = $("ts-filter-customer");
    if (custEl) custEl.addEventListener("change", function () {
      state.customer = custEl.value || "all";
      renderShifts();
    });
  }

  async function bootForStaff(staff) {
    currentStaff = staff;
    paintStaffIdentity(staff);
    renderRoleNav(staff && staff.role);
    setStaffAuthState("content");

    await Promise.all([loadSnapshot(), loadTechDirectory()]);
    applyDefaultRange();
    applyDefaultViewMode();
    paintMetaCard();
    populateFilterDropdowns();
    const filtersCard = $("ts-filters-card");
    if (filtersCard) filtersCard.hidden = !snapshot;
    wireFilterControls();
    renderShifts();
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
        onAuthorized: bootForStaff
      });
    } catch (err) {
      console.error("STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
    }
  });

  // bfcache safety net — when the page is restored from back/forward
  // cache (very common on mobile Safari + Chrome after navigating to
  // /tech.html via a customer link and tapping back), DOMContentLoaded
  // doesn't refire. The JS heap is preserved, so existing click
  // listeners still work — but the pill is-active states could
  // theoretically drift if state was mutated by another tab. Repaint
  // defensively so the UI reflects current state.viewMode.
  window.addEventListener("pageshow", function (ev) {
    if (ev.persisted) {
      try { console.info("[TeamSchedule] pageshow from bfcache"); } catch (_e) {}
      try {
        paintViewModePills();
        paintRangePills();
      } catch (_e) { /* page may not have booted yet — ignore */ }
    }
  });
})();
