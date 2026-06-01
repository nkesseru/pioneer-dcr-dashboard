/* Pioneer DCR Hub — Admin page glue (vanilla JS, no build).
 *
 * Responsibilities
 * ----------------
 *   • Initialize Firebase (app + firestore).
 *   • Fetch & render three collections READ-ONLY:
 *       customers       (by name)
 *       cleaning_techs  (by display_name)
 *       dcr_submissions (most recent N by created_at)
 *   • Provide a tiny in-memory search filter per panel.
 *   • Keep all write actions VISIBLY STUBBED — buttons stay disabled with a
 *     tooltip pointing at the secure Cloud Function that should own that op.
 *
 * Write controls (LIVE — gated by firestore.rules → isPioneerAdmin()):
 *   • Edit modal for customers      (customer name, location, email, active,
 *                                    dcr_enabled, dcr_email_enabled,
 *                                    slack_channel, review_links, notes)
 *   • Edit modal for cleaning techs (display_name, email, phone, active,
 *                                    dcr_enabled, notes)
 *   • Archive / Reactivate          (sets active + archived_at + archived_by;
 *                                    NEVER deletes — rules deny delete)
 *
 * Every write stamps updated_at + updated_by. Deletes remain server-denied.
 * If you need to truly destroy a record, do it via Firebase Console (server-
 * side, Admin-SDK-only).
 *
 * Schema-tolerance
 * ----------------
 * The customer / tech docs in Firestore may use either the canonical field
 * names from FIRESTORE_SCHEMA.md (`name`, `slug`, `email`, …) OR the
 * denormalized names that downstream payloads use (`customer_name`,
 * `customer_slug`, `customer_email`, …). The `get…()` helpers below check
 * both so this page works regardless of which seed convention was used.
 */
(function () {
  "use strict";

  /* ---------- Pure helpers (moved to admin/_utils.js) ----------
   * See public/admin/_utils.js for definitions. Destructuring here so
   * the rest of admin.js can reference them unchanged. If __pioneerAdmin
   * is missing, _utils.js failed to load — fail loudly rather than
   * silently degrade.
   */
  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin.js: admin/_utils.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.shell) {
    throw new Error("admin.js: admin/_shell.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.budget) {
    throw new Error("admin.js: admin/_budget.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs || !window.__pioneerAdmin.tabs.sos) {
    throw new Error("admin.js: admin/tab-sos.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.improvements) {
    throw new Error("admin.js: admin/tab-improvements.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.customerNotes || !window.__pioneerAdmin.tabs.noteSuggestions) {
    throw new Error("admin.js: admin/tab-customer-notes.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.serviceRecoveries) {
    throw new Error("admin.js: admin/tab-service-recoveries.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.training) {
    throw new Error("admin.js: admin/tab-training.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.pilotReadiness) {
    throw new Error("admin.js: admin/tab-pilot-readiness.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.feed) {
    throw new Error("admin.js: admin/tab-feed.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.recentDcrs) {
    throw new Error("admin.js: admin/tab-recent-dcrs.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.dcrIssues) {
    throw new Error("admin.js: admin/tab-dcr-issues.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.techHealth) {
    throw new Error("admin.js: admin/tab-tech-health.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.yesterdaysWork) {
    throw new Error("admin.js: admin/tab-yesterdays-work.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.customers) {
    throw new Error("admin.js: admin/tab-customers.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.techs) {
    throw new Error("admin.js: admin/tab-techs.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.admins) {
    throw new Error("admin.js: admin/tab-admins.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.supplyRequests) {
    throw new Error("admin.js: admin/tab-supply-requests.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.dayHealth) {
    throw new Error("admin.js: admin/tab-day-health.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.announcements) {
    throw new Error("admin.js: admin/tab-announcements.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.dcrReview) {
    throw new Error("admin.js: admin/tab-dcr-review.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.deputyMapping) {
    throw new Error(
      "admin.js: window.__pioneerAdmin.tabs.deputyMapping is not registered. " +
      "Either the tab-deputy-mapping.js <script> tag is missing/misordered in admin.html, " +
      "or that file threw a runtime error during its IIFE (look earlier in the DevTools " +
      "console for the original error — common causes: Firebase SDK not initialized, " +
      "missing utils export, network failure on the script fetch)."
    );
  }
  if (!window.__pioneerAdmin.tabs.schedule) {
    throw new Error("admin.js: admin/tab-schedule.js must load before admin.js");
  }
  if (!window.__pioneerAdmin.tabs.attendance) {
    throw new Error("admin.js: admin/tab-attendance.js must load before admin.js");
  }
  const {
    DCR_RECENT_LIMIT,
    ALLOWED_ADMIN_EMAILS,
    isRootAdmin,
    escapeHtml,
    cssEsc,
    formatTimestamp,
    tsToMs,
    formatImprovementDate,
    getCustomerName,
    getCustomerSlug,
    getCustomerEmail,
    getCustomerLocation,
    getActive,
    getDcrEnabled,
    getDcrEmailEnabled,
    getTechName,
    getTechSlug,
    pacificDateString,
    addDaysPacific,
    getOpsDayWindow
  } = window.__pioneerAdmin.utils;
  const {
    wireTabs,
    setStatus,
    hideAllStatuses,
    showFatal,
    openModal,
    closeModal,
    showToast,
    badge,
    activeBadge,
    dcrEnabledBadge,
    dcrEmailBadge,
    activateTab,
    registerTabActivator,
    // Phase 25a — moved from admin.js into _shell.js.
    setModalSaving,
    setModalError,
    handleAdminWriteError,
    getCurrentAdminEmail,
    copyInputValue,
    installModalCloseAffordances,
    // Phase 25b — row overflow menu trio moved from admin.js into _shell.js.
    closeAllRowOverflowMenus,
    toggleRowOverflow,
    installOverflowMenuOutsideClose
  } = window.__pioneerAdmin.shell;
  const {
    getOnBudget,
    dcrTsToMs,
    emptyBucket,
    computeBudgetStats,
    budgetRowBadge,
    budgetTooltipText
  } = window.__pioneerAdmin.budget;

  // Two-tier admin check mirroring isPioneerAdmin() in firestore.rules
  // and verifyStaffOrReject() in functions/index.js:
  //   1. hardcoded ALLOWED_ADMIN_EMAILS — root admins, survives Firestore
  //      outages, always works.
  //   2. /admins/{lowercased-email} doc with active != false — operational
  //      admins added via the Admins tab without a code deploy.
  // Returns {ok: boolean, source: "root" | "firestore" | "none"}.
  async function resolveAdminStatus(email) {
    if (!email) return { ok: false, source: "none" };
    const normalized = email.toLowerCase().trim();
    if (isRootAdmin(normalized)) return { ok: true, source: "root" };
    try {
      const snap = await db.collection("admins").doc(normalized).get();
      if (snap.exists && snap.data() && snap.data().active !== false) {
        return { ok: true, source: "firestore" };
      }
      return { ok: false, source: "none" };
    } catch (err) {
      console.warn("[admin] resolveAdminStatus: /admins lookup failed (non-fatal)", err);
      return { ok: false, source: "none" };
    }
  }

  /* ---------- DOM helpers ---------- */

  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* escapeHtml, formatTimestamp, getCustomer*, getTech* moved to
     public/admin/_utils.js — imported via the top-of-IIFE destructure. */

  /* ---------- Firebase SDK presence check (granular) ----------
     Each compat module must be loaded BEFORE admin.js. The previous "is
     `window.firebase` defined?" guard only caught the case where the App
     SDK itself failed — if firebase-auth-compat.js silently failed to
     load (stale cache / ad blocker / 404), the App SDK still exists and
     this check would have passed, only to blow up later inside the
     onAuthStateChanged call with the generic "Firebase Auth isn't
     initialized correctly" message. Be specific instead. */
  const sdkChecks = [
    {
      label: "Firebase App SDK (firebase-app-compat.js)",
      ok:    function () { return typeof window.firebase !== "undefined"; }
    },
    {
      label: "Firebase Auth SDK (firebase-auth-compat.js)",
      ok:    function () { return typeof window.firebase !== "undefined" &&
                                  typeof window.firebase.auth === "function"; }
    },
    {
      label: "Firebase Firestore SDK (firebase-firestore-compat.js)",
      ok:    function () { return typeof window.firebase !== "undefined" &&
                                  typeof window.firebase.firestore === "function"; }
    },
    {
      label: "Firebase config (firebase-config.js — window.FIREBASE_CONFIG)",
      ok:    function () { return !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey); }
    }
  ];
  const missingSdk = sdkChecks.filter(function (c) { return !c.ok(); });
  if (missingSdk.length) {
    const names = missingSdk.map(function (c) { return "• " + c.label; }).join("\n");
    showFatal(
      "Couldn't initialize the Pioneer admin page — these pieces failed to load:\n\n" +
      names + "\n\n" +
      "Most common cause is a stale browser cache — hard-reload with " +
      "Cmd+Shift+R (Mac) / Ctrl+Shift+R (Win). If that doesn't fix it, open " +
      "DevTools → Network tab and reload to confirm each script returns 200 OK."
    );
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const db = firebase.firestore();

  /* ---------- state ---------- */

  // customers moved to tab-customers.js (Phase 15). Consumers read via
  // window.__pioneerAdmin.deps.getCustomers().
  // techs moved to tab-techs.js (Phase 16a). Consumers read via
  // window.__pioneerAdmin.deps.getTechs().
  // dcrs moved to tab-recent-dcrs.js (Phase 11). Consumers read via
  // window.__pioneerAdmin.deps.getDcrs().

  // DCR-derived issues + the Issues-tab filter state both moved to
  // tab-dcr-issues.js (Phase 12). Consumers read the array via
  // window.__pioneerAdmin.deps.getDcrIssues().

  // `announcements` state moved to tab-announcements.js (Phase 20).
  // Consumers reach it via window.__pioneerAdmin.tabs.announcements.getAnnouncements().

  // `admins` state moved to tab-admins.js (Phase 17). Consumers reach
  // it via window.__pioneerAdmin.tabs.admins.getAdmins() or, for
  // back-compat code paths, deps.getAdmins().

  // pendingTechAssigned + pendingTechCreateAssigned moved to
  // tab-techs.js (Phase 16a). Both staging sets are owned by the tab.

  /* wireTabs, setStatus, hideAllStatuses, showFatal, badge family, and
     activateTab moved to public/admin/_shell.js — imported via the
     top-of-IIFE destructure. Tab activators are registered in boot. */

  /* on-budget analytics moved to public/admin/_budget.js — imported via
     the top-of-IIFE destructure. computeBudgetStats now takes the dcrs
     array as its first parameter; callers below pass it explicitly. */


  /* Customers tab moved to public/admin/tab-customers.js (Phase 15).
     Owns the customers array; admin-side modules read it via
     window.__pioneerAdmin.deps.getCustomers(). The tab also exposes
     applyFilter / openCreateModal / openEditModal / onArchive /
     onSave methods that admin.js wire helpers (wireSearch +
     wireWriteControls) call through the namespace. */


  /* Cleaning Techs core (techThumb + techCard + renderTechs + loadTechs)
     moved to public/admin/tab-techs.js (Phase 16a). Boot rewires
     auth-state-change loadTechs() → tabs.techs.refresh(). Other modules
     read techs via window.__pioneerAdmin.deps.getTechs(). */


  /* Recent DCRs tab moved to public/admin/tab-recent-dcrs.js (Phase 11).
     The dcrs array now lives there; admin-side modules read it via
     window.__pioneerAdmin.deps.getDcrs(). The wrapper below preserves
     the post-load side-effects that the original loadDcrs() had inline
     (re-render Customers + Techs because their cards display per-doc
     budget stats; refresh the attention strip). Boot, the refresh
     button, and the DCR review modal success-path all call this
     wrapper. */
  async function loadDcrsAndRerenderDependents() {
    await window.__pioneerAdmin.tabs.recentDcrs.refresh();
    window.__pioneerAdmin.tabs.customers.applyFilter();
    window.__pioneerAdmin.tabs.techs.applyFilter();
    window.__pioneerAdmin.tabs.dayHealth.refresh();
  }

  /* Supply Requests module relocated to public/admin/tab-supply-requests.js
     (Phase 18). Public surface: window.__pioneerAdmin.tabs.supplyRequests. */


  /* DCR Issues tab moved to public/admin/tab-dcr-issues.js (Phase 12).
     The dcrIssues array now lives there; admin-side modules read via
     window.__pioneerAdmin.deps.getDcrIssues(). Post-load and post-save
     side-effects (refreshAttentionStrip + applyCurrentCustomerFilter)
     are wired via tabs.dcrIssues.onChange() in boot. */

  /* Day Health / Attention Strip / Today's Ops module relocated to
     public/admin/tab-day-health.js (Phase 19).
     Public surface: window.__pioneerAdmin.tabs.dayHealth. */

  /* activateTab moved to public/admin/_shell.js. Tab-specific lazy-load
     callbacks are registered with registerTabActivator() in boot below
     so the shell remains decoupled from tab implementations. */

  /* SOS Events tab moved to public/admin/tab-sos.js (Phase 4b) —
     boot registers it via window.__pioneerAdmin.tabs.sos.init below. */

  /* Help Improve Pioneer tab moved to public/admin/tab-improvements.js
     (Phase 5) — boot registers it via
     window.__pioneerAdmin.tabs.improvements.init below. */


  /* Yesterday's Work / Nightly Recap tab moved to
     public/admin/tab-yesterdays-work.js (Phase 14). Read-only module —
     fetches its own data each tab activation; no caches read or written
     through the deps bridge. Boot wires the activator via
     window.__pioneerAdmin.tabs.yesterdaysWork.init. */


  /* Pilot Readiness tab moved to public/admin/tab-pilot-readiness.js
     (Phase 9). Boot wires the activator via
     window.__pioneerAdmin.tabs.pilotReadiness.init. No auto-refresh —
     the report only runs on explicit Run / Refresh button clicks. */


  /* Operational Feed mount + demo-button wiring moved to
     public/admin/tab-feed.js (Phase 10). Boot wires the activator via
     window.__pioneerAdmin.tabs.feed.init. Mount is idempotent; demo
     buttons remain admin-only test docs. */

  /* ---------- search filters ---------- */

  function wireSearch() {
    // Customer search moved to tabs.customers.init() in Phase 25c.
    // Tech search moved to tabs.techs.init() in Phase 25d.
    const ds = $("dcr-search");

    if (ds) ds.addEventListener("input", function () {
      window.__pioneerAdmin.tabs.recentDcrs.renderFiltered(ds.value);
    });
  }

  /* ---------- refresh button (DCRs only — customers/techs change rarely) ---------- */

  function wireRefresh() {
    const btn = $("dcr-refresh");
    if (!btn) return;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Refreshing…";
      loadDcrsAndRerenderDependents().finally(function () {
        btn.disabled = false;
        btn.textContent = original;
        const ds = $("dcr-search");
        if (ds) ds.value = "";
      });
    });
  }

  /* ===================================================================
     Auth state controller
     ===================================================================
     Four mutually exclusive views — `checking` / `signin` / `denied` /
     `content`. `showAuthState()` is the only place that toggles `hidden`
     on the wrappers, so every code path that changes auth state funnels
     through here. Header account chip + denied-email text update too. */

  /* Role-aware nav — same renderer as app.js / tech.js. The admin page
     is already gated by the admin allowlist, so we always render the
     admin variant when the user reaches the "content" state. Convenience
     navigation only; security is the firestore.rules + admin allowlist. */
  // KEEP IN SYNC across five files: app.js, tech.js, admin.js,
  // supply-station.js, team-hub.js. See app.js for the rationale on not
  // extracting.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",           roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                    roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",           roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html", roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",       roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",       roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",    roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",               roles: ["admin"] }
    // Future placeholders:
    //   Announcements, Company Updates
  ];

  // Preserve any cache-buster (?v=2600, etc.) on nav hops.
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
      if (isActive) return '<span class="' + cls + '"' + aria + '>' + escapeHtml(i.label) + '</span>';
      return '<a class="' + cls + '" href="' + withCurrentSearch(i.href) + '">' + escapeHtml(i.label) + '</a>';
    }).join("");
    nav.hidden = false;
  }

  // Pioneer Team Hub unread-announcements badge — KEEP IN SYNC across
  // app.js / tech.js / admin.js / supply-station.js / team-hub.js.
  async function paintTeamHubUnreadBadge(staff) {
    if (!staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const fdb = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        fdb.collection("announcements").where("active", "==", true).get(),
        fdb.collection("announcement_reads").where("uid", "==", staff.uid).get()
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

  function showAuthState(state, opts) {
    ["checking", "signin", "denied", "content"].forEach(function (s) {
      const el = $("auth-" + s);
      if (!el) return;
      el.hidden = s !== state;
    });
    const headerAccount = $("header-account");
    const headerEmail   = $("header-account-email");
    const headerName    = $("header-account-name");
    const nav           = $("role-nav");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
      if (headerEmail && opts && opts.email) headerEmail.textContent = opts.email;
      if (headerName)    headerName.textContent = (opts && opts.displayName) || "";
      renderRoleNav("admin");
    } else {
      // Hide AND clear. Without clearing, the previous user's email
      // lingers in the DOM and flashes briefly if the chip is shown
      // again on the next sign-in. Wipe it on every non-content state.
      if (headerAccount) headerAccount.hidden = true;
      if (headerEmail)   headerEmail.textContent = "";
      if (headerName)    headerName.textContent = "";
      if (nav) { nav.hidden = true; nav.innerHTML = ""; }
    }
    if (state === "denied") {
      const deniedEmail = $("auth-denied-email");
      if (deniedEmail && opts && opts.email) deniedEmail.textContent = opts.email;
    }
  }

  // Track the currently-authorized email so the (potentially re-firing)
  // onAuthStateChanged listener only re-runs the data loaders when the
  // user actually changes.
  let currentAuthEmail = null;

  async function handleAuthChange(user) {
    if (!user) {
      currentAuthEmail = null;
      showAuthState("signin");
      return;
    }
    const email = (user.email || "").toLowerCase();

    // Two-tier check: root admin (hardcoded) gets through instantly so
    // the page paints without a Firestore round-trip. Operational
    // admins (added via the Admins tab) are resolved by an /admins
    // lookup. While that request is in flight, we show the "checking"
    // state to avoid a flash of the denied screen.
    if (isRootAdmin(email)) {
      // fall through to content
    } else {
      // Optimistic UI: keep current state while we resolve. If this is
      // the user's first auth check, showAuthState("checking") is the
      // current default, which is fine.
      const status = await resolveAdminStatus(email);
      if (!status.ok) {
        currentAuthEmail = null;
        showAuthState("denied", { email: user.email || "(no email on this account)" });
        return;
      }
    }

    showAuthState("content", { email: user.email, displayName: user.displayName || "" });
    if (currentAuthEmail !== email) {
      currentAuthEmail = email;
      window.__pioneerAdmin.tabs.customers.refresh();
      window.__pioneerAdmin.tabs.techs.refresh();
      loadDcrsAndRerenderDependents();
      window.__pioneerAdmin.tabs.supplyRequests.refresh();
      window.__pioneerAdmin.tabs.dcrIssues.refresh();
      window.__pioneerAdmin.tabs.announcements.refresh();
      window.__pioneerAdmin.tabs.admins.refresh();
      window.__pioneerAdmin.tabs.customerNotes.refresh();
      window.__pioneerAdmin.tabs.noteSuggestions.refresh();
      window.__pioneerAdmin.tabs.serviceRecoveries.refresh();
      // Phase 2 ops overview — single async count for the
      // "Inspections This Week" KPI. Soft-fails; doesn't block.
      window.__pioneerAdmin.tabs.dayHealth.loadInspectionsThisWeek();
      // V6 — Today's Operations card. Two parallel queries against
      // dcr_email_payloads + customer_feedback for the 24h window.
      // Soft-fails; the card stays in its "loading" / "—" state if
      // the query is rejected.
      window.__pioneerAdmin.tabs.dayHealth.refreshMetrics();
      const staffShape = { uid: user.uid, email: user.email };
      paintTeamHubUnreadBadge(staffShape);
      // Mandatory-announcement gate — admins get the same blocking
      // modal as staff. Easy and consistent: admins should see
      // company-wide announcements too. After ack, refresh the badge.
      if (window.MANDATORY_ANN && typeof window.MANDATORY_ANN.check === "function") {
        window.MANDATORY_ANN.check(staffShape).then(function () {
          paintTeamHubUnreadBadge(staffShape);
        });
      }
    }
  }

  /* ===================================================================
     Write controls — toast, modals, save, archive
     ===================================================================
     The four admin emails in ALLOWED_ADMIN_EMAILS can edit + archive
     customers and cleaning techs from inside this page. Every write goes
     through Firestore directly (gated server-side by isPioneerAdmin() in
     firestore.rules) and stamps updated_at + updated_by automatically.
     Archives are soft — active=false + archived_at + archived_by; rules
     deny delete entirely. */

  /* getCurrentAdminEmail + handleAdminWriteError moved to admin/_shell.js
     (Phase 25a) — imported via the top-of-IIFE shell destructure. The
     six tab modules that consume them via the deps bridge now read
     from window.__pioneerAdmin.shell directly. */

  // ---- Toast ----
  /* openModal, closeModal, showToast moved to public/admin/_shell.js
     (Phase 6a) — imported via the top-of-IIFE shell destructure. */

  /* Row overflow menu trio (closeAllRowOverflowMenus, toggleRowOverflow,
     installOverflowMenuOutsideClose) moved to admin/_shell.js
     (Phase 25b) — imported via the top-of-IIFE shell destructure.
     Tech-list dispatch in wireWriteControls still owns the click that
     calls toggleRowOverflow; boot still calls installOverflowMenuOutsideClose. */

  /* Announcements module relocated to public/admin/tab-announcements.js
     (Phase 20). Public surface: window.__pioneerAdmin.tabs.announcements.

     Phase 20 also retired the temporary supplyTsToMs that lived above —
     it was only ever called by Announcements's tsToLocalInputValue, which
     moved with this extraction. */

  /* Admins module relocated to public/admin/tab-admins.js (Phase 17).
     Public surface: window.__pioneerAdmin.tabs.admins. */

  /* MODAL_REGISTRY + setModalSaving + setModalError moved to
     admin/_shell.js (Phase 25a) — imported via the top-of-IIFE shell
     destructure. Tab modules read them from
     window.__pioneerAdmin.shell directly; the four deps-bridge entries
     (handleAdminWriteError, setModalError, setModalSaving,
     getCurrentAdminEmail) were retired in the same phase. */

  // ---- Customer: edit ----

  /* populateCustomerDeputyIntegration relocated to public/admin/tab-deputy-mapping.js
     (Phase 22). tab-customers.js still reaches it via the existing deps bridge
     entry, which now points at the deputy namespace. */

  /* Customer CREATE / EDIT / ARCHIVE modal functions moved to
     public/admin/tab-customers.js (Phase 15). admin.js boot wires
     the customer-edit-save / customer-create-open buttons to the
     tab namespace methods via wireWriteControls. */

  // ---- Cleaning tech: edit ----

  // Renders a customer checklist into the given list/search/count elements.
  // Reads selection state from the supplied `staging` Set; toggling a row
  // updates the set, and a later re-render (e.g. on search input) preserves
  // selections. Defensive null-checks so a missing element is a no-op
  // rather than a throw that would block the modal from opening.
  //
  // Shared by the tech-EDIT modal (state = pendingTechAssigned) and the
  // tech-CREATE modal (state = pendingTechCreateAssigned).
  /* renderAssignmentChecklist + renderTechAssignments + openTechEditModal
     + onTechEditSave + renderTechCreateAssignments moved to
     public/admin/tab-techs.js (Phase 16a). The tab init() wires the
     assignment checklist listeners; admin.js wireWriteControls calls
     window.__pioneerAdmin.tabs.techs.{openEditModal, onSaveEdit}. */

  /* slugifyForTech moved to tab-techs.js (Phase 25d) as the local
     slugifyTechCandidate (already present there). The tab-customers.js
     auto-slug uses its own local slugifyCustomerCandidate copy (Phase 25c). */

  /* resetTechCreateModal + openTechCreateModal + onTechCreateSave moved
     to public/admin/tab-techs.js (Phase 16a). Callers use
     window.__pioneerAdmin.tabs.techs.openCreateModal /
     onSaveCreate. */

  /* DCR email Review & Send modal relocated to public/admin/tab-dcr-review.js
     (Phase 21). Public surface: window.__pioneerAdmin.tabs.dcrReview.
     Reaches loadDcrsAndRerenderDependents (this file) via deps bridge
     so the post-send DCR list / customer / tech / day-health repaint
     keeps working. */

  /* Tech photo/signature manager (tech-media-modal) moved to
     public/admin/tab-techs.js (Phase 16b). Boot wires nothing here —
     the tab module wires the modal on first open via its own
     wireTechMediaModalOnce. wireWriteControls dispatches the "media"
     tech-row action to window.__pioneerAdmin.tabs.techs.openMediaModal. */


  /* Tech archive-confirm modal + onTechArchive + auth-disable/enable
     helpers + onTechDelete + applyCurrentTechFilter moved to
     public/admin/tab-techs.js (Phase 16a). Callers in admin.js use
     window.__pioneerAdmin.tabs.techs.{onArchive, onDelete, applyFilter}
     and the deps bridge for cross-tab reads. */


  /* Customer Notes + Note Suggestions tabs moved to
     public/admin/tab-customer-notes.js (Phase 6).
     Service Recoveries tab moved to
     public/admin/tab-service-recoveries.js (Phase 7).
     Boot wires each via window.__pioneerAdmin.tabs.{customerNotes,
     noteSuggestions, serviceRecoveries}.init(). The auth-state
     change handler calls .refresh() on each. customerLabelForSlug
     now lives inside tab-service-recoveries.js (its sole caller). */

  /* Deputy Mapping module relocated to public/admin/tab-deputy-mapping.js
     (Phase 22). Public surface: window.__pioneerAdmin.tabs.deputyMapping.
     populateCustomerDeputyIntegration moved with it — customer edit modal
     reaches it via deps.populateCustomerDeputyIntegration → namespace. */

  // ---- One-time wiring: event delegation + modal close/save buttons + Esc ----

  function wireWriteControls() {
    // Customer list event delegation moved to tabs.customers.init()
    // in Phase 25c.

    // Tech list event delegation (edit / media / archive / delete /
    // resend / promote / more) moved to tabs.techs.init() in Phase 25d.

    // DCR list — V6 review/send dispatcher. Each DCR row has a
    // [data-action="review-send"] button; clicking opens the readiness
    // modal pre-loaded against that DCR. No other actions today.
    const dcrRoot = $("dcr-list");
    if (dcrRoot) {
      dcrRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        // dcrs lives in tab-recent-dcrs.js (Phase 11); read via deps bridge.
        const dcrs = window.__pioneerAdmin.deps.getDcrs();
        const d = dcrs.find(function (x) {
          return (x.submission_id || x.id) === row.dataset.id;
        });
        if (!d) return;
        if (btn.dataset.action === "review-send") window.__pioneerAdmin.tabs.dcrReview.openModal(d);
      });
    }

    // DCR review modal Send + Resend buttons are wired by
    // tabs.dcrReview.init() (Phase 21).

    // Tech edit/create save buttons + "+ Add tech" + auto-slug + copy
    // buttons moved to tabs.techs.init() in Phase 25d. Assignment
    // checklists were already wired by tabs.techs.init() (Phase 16a).

    // Modal close affordances ([data-modal-close] backdrop/X/Cancel + Esc
    // for the three core editor modals) moved to admin/_shell.js as
    // installModalCloseAffordances (Phase 25a).
    installModalCloseAffordances();
  }

  /* Schedule subsystem (Team Schedule legacy upload + Published Team Schedule
     Deputy snapshot + Sync From Deputy + Schedule Import V1) relocated to
     public/admin/tab-schedule.js (Phase 23). Public surface:
     window.__pioneerAdmin.tabs.schedule. The date helpers
     pacificDateString, addDaysPacific, and getOpsDayWindow moved to
     admin/_utils.js so Attendance + Day Health can keep reading them. */

  /* Attendance + Open Shifts module relocated to public/admin/tab-attendance.js
     (Phase 24). Public surface: window.__pioneerAdmin.tabs.attendance.
     Reads its own three Firestore collections (time_off_requests,
     call_outs, open_shift_requests); does not touch customers/techs.
     refresh() preserves original lazy-load behavior — Open Shifts loads
     when the user clicks that sub-tab, not on attendance refresh. */


  /* Tech Health tab moved to public/admin/tab-tech-health.js (Phase 13).
     Reads techs + dcrs via the existing __pioneerAdmin.deps bridge
     (no new bridge entries needed). Boot wires the activator via
     window.__pioneerAdmin.tabs.techHealth.refresh and the init via
     tabs.techHealth.init(). */

  function wireSignIn() {
    const btn = $("signin-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        // Always show the account chooser so multi-account users don't get
        // auto-signed-in to the wrong identity.
        provider.setCustomParameters({ prompt: "select_account" });
        // Admin page: popup-only, never signInWithRedirect. Safari's
        // storage partitioning has been known to strip the redirect
        // handshake. The admin page has no email/password fallback path
        // (admin sign-in is Google-only by design), so popup reliability
        // matters even more here than on the staff pages. See
        // staff-auth.js for the matching policy on /index.html and
        // /tech.html.
        await firebase.auth().signInWithPopup(provider);
        // onAuthStateChanged takes it from here.
      } catch (err) {
        console.error("Sign-in failed", err);
        const code = err && err.code;
        // User-cancelled popups are normal; don't alarm.
        if (code !== "auth/popup-closed-by-user" &&
            code !== "auth/cancelled-popup-request") {
          if (code === "auth/configuration-not-found") {
            alert(
              "Google sign-in isn't enabled on this Firebase project yet.\n\n" +
              "Enable it: Firebase Console → Authentication → Sign-in method → Google → Enable."
            );
          } else if (code === "auth/unauthorized-domain") {
            alert(
              "This domain isn't in Firebase Auth's authorized domains list.\n\n" +
              "Add it: Firebase Console → Authentication → Settings → Authorized domains."
            );
          } else {
            alert("Sign-in failed: " + (err.message || code || err));
          }
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireSignOut() {
    $$('[data-signout]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        firebase.auth().signOut().catch(function (err) {
          console.error("Sign-out failed", err);
        });
      });
    });
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    wireTabs();
    // Register on-activate lazy-load callbacks. Behavior matches the
    // original inline activateTab dispatch: feed mounts the shared
    // renderer; training, schedule (3 loaders), attendance, tech-health
    // are idempotent re-reads on each open; pilot-readiness, yesterday,
    // improvements, and sos are once-only initializers gated by their
    // own wired flags.
    registerTabActivator("feed",            window.__pioneerAdmin.tabs.feed.init);
    registerTabActivator("training",        window.__pioneerAdmin.tabs.training.refresh);
    registerTabActivator("schedule",        window.__pioneerAdmin.tabs.schedule.refresh);
    registerTabActivator("attendance",      window.__pioneerAdmin.tabs.attendance.refresh);
    registerTabActivator("tech-health",     window.__pioneerAdmin.tabs.techHealth.refresh);
    registerTabActivator("pilot-readiness", window.__pioneerAdmin.tabs.pilotReadiness.init);
    registerTabActivator("yesterday",       window.__pioneerAdmin.tabs.yesterdaysWork.init);
    registerTabActivator("improvements",    window.__pioneerAdmin.tabs.improvements.init);
    registerTabActivator("sos",             window.__pioneerAdmin.tabs.sos.init);
    wireSearch();
    wireRefresh();
    window.__pioneerAdmin.tabs.supplyRequests.init();
    window.__pioneerAdmin.tabs.dcrIssues.init();
    window.__pioneerAdmin.tabs.dayHealth.init();
    window.__pioneerAdmin.tabs.announcements.init();
    window.__pioneerAdmin.tabs.admins.init();
    window.__pioneerAdmin.tabs.dcrReview.init();
    // Populate the deps bridge BEFORE any tab module's init/refresh
    // can read from it. Scaffolding for tab modules that still need
    // closure-local helpers from admin.js (customers array, modal
    // infra, admin-email, write-error handler). Goes away when those
    // are extracted in later phases.
    window.__pioneerAdmin.deps = {
      getCustomers:          function () { return window.__pioneerAdmin.tabs.customers.getCustomers(); },
      getTechs:              function () { return window.__pioneerAdmin.tabs.techs.getTechs(); },
      getDcrs:               function () { return window.__pioneerAdmin.tabs.recentDcrs.getDcrs(); },
      getDcrIssues:          function () { return window.__pioneerAdmin.tabs.dcrIssues.getDcrIssues(); },
      getSupplyRequests:     function () { return window.__pioneerAdmin.tabs.supplyRequests.getSupplyRequests(); },
      getAdmins:             function () { return window.__pioneerAdmin.tabs.admins.getAdmins(); },
      loadAdmins:            function () { return window.__pioneerAdmin.tabs.admins.refresh(); },
      refreshAttentionStrip: function () { return window.__pioneerAdmin.tabs.dayHealth.refresh(); },
      getOpsDayWindow:       function (now, cutoffHour, timezone) { return getOpsDayWindow(now, cutoffHour, timezone); },
      loadDcrsAndRerenderDependents: function () { return loadDcrsAndRerenderDependents(); },
      // Phase 25a retired: getCurrentAdminEmail, handleAdminWriteError,
      // setModalError, setModalSaving. Tab modules now destructure
      // those four from window.__pioneerAdmin.shell directly.
      populateCustomerDeputyIntegration: function (c) { return window.__pioneerAdmin.tabs.deputyMapping.populateCustomerIntegration(c); }
    };
    // DCR Issues tab fires onChange after every load + save so admin.js
    // can refresh the attention strip + customer rows (which display
    // open-issue counts derived from the dcrIssues array).
    window.__pioneerAdmin.tabs.dcrIssues.onChange(function () {
      window.__pioneerAdmin.tabs.dayHealth.refresh();
      window.__pioneerAdmin.tabs.customers.applyFilter();
    });
    window.__pioneerAdmin.tabs.customerNotes.init();
    window.__pioneerAdmin.tabs.noteSuggestions.init();
    window.__pioneerAdmin.tabs.serviceRecoveries.init();
    window.__pioneerAdmin.tabs.training.init();
    window.__pioneerAdmin.tabs.customers.init();
    window.__pioneerAdmin.tabs.techs.init();
    window.__pioneerAdmin.tabs.deputyMapping.init();
    window.__pioneerAdmin.tabs.schedule.init();
    window.__pioneerAdmin.tabs.attendance.init();
    window.__pioneerAdmin.tabs.techHealth.init();
    wireWriteControls();
    installOverflowMenuOutsideClose();
    wireSignIn();
    wireSignOut();
    // Start in the "checking" state so the page doesn't flash sign-in for
    // already-authenticated returning admins. onAuthStateChanged resolves
    // quickly and re-routes to the correct view.
    showAuthState("checking");
    try {
      firebase.auth().onAuthStateChanged(handleAuthChange);
    } catch (err) {
      // Surface the actual underlying error to the user + the two concrete
      // fixes ranked by likelihood. The granular SDK check earlier in this
      // file should have caught the stale-cache case already; if we land
      // here, it's most likely a Firebase-Console-side gap.
      console.error("Firebase Auth init failed", err);
      const errMsg = (err && (err.message || err.code)) || String(err);
      showFatal(
        "Couldn't start Firebase Auth on this page.\n\n" +
        "Error: " + errMsg + "\n\n" +
        "Two things to check, in order:\n" +
        "1. Hard-reload the page (Cmd+Shift+R / Ctrl+Shift+R) to flush any " +
        "stale cached admin.html that's missing the firebase-auth-compat.js " +
        "script tag.\n" +
        "2. Enable Authentication in the Firebase Console:\n" +
        "   • Firebase Console → Authentication → Get started\n" +
        "   • Sign-in method tab → Google → Enable → Save\n" +
        "   • Confirm pioneer-dcr-hub.web.app is in Authentication → " +
        "Settings → Authorized domains."
      );
    }
  });


  /* Training Reports tab moved to public/admin/tab-training.js
     (Phase 8). Boot wires it via window.__pioneerAdmin.tabs.training
     .init(); tab activation calls .refresh(). */
})();
