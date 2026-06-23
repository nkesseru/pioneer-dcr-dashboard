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
  // Adding a new tab module? Add its path here and the loop below
  // gives you a consistent "must load before admin.js" diagnostic.
  // Format: "utils" / "shell" / "tabs.X" — kept short so the list
  // stays scannable. Path-to-filename mapping in the error message
  // strips the "tabs." prefix and prepends "tab-".
  const REQUIRED_PATHS = [
    "utils", "shell", "budget",
    "tabs.sos", "tabs.improvements", "tabs.customerNotes", "tabs.noteSuggestions",
    "tabs.serviceRecoveries", "tabs.training", "tabs.pilotReadiness",
    "tabs.feed", "tabs.recentDcrs", "tabs.dcrIssues", "tabs.techHealth",
    "tabs.yesterdaysWork", "tabs.customers", "tabs.techs", "tabs.admins",
    "tabs.supplyRequests", "tabs.dayHealth", "tabs.announcements",
    "tabs.dcrReview", "tabs.schedule", "tabs.attendance", "tabs.laborReview",
    "tabs.payroll", "tabs.sickLeave", "tabs.officeIssues"
    // tabs.deputyMapping has its own granular diagnostic — see below
  ];
  if (!window.__pioneerAdmin) {
    throw new Error("admin.js: admin/_utils.js must load before admin.js");
  }
  REQUIRED_PATHS.forEach(function (path) {
    const found = path.split(".").reduce(function (o, k) { return o && o[k]; }, window.__pioneerAdmin);
    if (found) return;
    const file = path.indexOf("tabs.") === 0
      ? "tab-" + path.slice(5).replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); })
      : "_" + path;
    throw new Error("admin.js: admin/" + file + ".js must load before admin.js");
  });
  // Deputy Mapping kept as a one-off after the loop — its error
  // message lists the four most-common failure modes and is
  // genuinely useful debugging text (Phase 22 incident postmortem).
  if (!window.__pioneerAdmin.tabs.deputyMapping) {
    throw new Error(
      "admin.js: window.__pioneerAdmin.tabs.deputyMapping is not registered. " +
      "Either the tab-deputy-mapping.js <script> tag is missing/misordered in admin.html, " +
      "or that file threw a runtime error during its IIFE (look earlier in the DevTools " +
      "console for the original error — common causes: Firebase SDK not initialized, " +
      "missing utils export, network failure on the script fetch)."
    );
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

  /* Cross-tab fan-out — wraps the Recent DCRs refresh with the three
     downstream repaints (customer rows + tech rows display per-doc
     budget stats derived from dcrs; day-health attention strip rolls
     up DCR-derived signals). admin.js owns this because no single tab
     module sits at the center of the fan-out. Boot, the DCR refresh
     button (tab-recent-dcrs), and the DCR review modal (tab-dcr-review)
     all call it via the deps bridge. */
  async function loadDcrsAndRerenderDependents() {
    await window.__pioneerAdmin.tabs.recentDcrs.refresh();
    window.__pioneerAdmin.tabs.customers.applyFilter();
    window.__pioneerAdmin.tabs.techs.applyFilter();
    window.__pioneerAdmin.tabs.dayHealth.refresh();
  }

  /* Search filters + DCR refresh button: all per-tab wiring moved to
     each owning module's init() (Customers: Phase 25c, Techs: Phase 25d,
     Recent DCRs: Phase 25e). admin.js no longer owns any search input
     or list refresh button. */

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
    { key: "office-issues",  label: "Message the Office",   href: "/office-issues.html",   roles: ["admin", "cleaning_tech"] },
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
      // V20260614c — inline targetsMe so badge count agrees with the
      // team-hub UI for admins (rule-bypass otherwise over-counts
      // audienceType="selected" announcements that don't target them).
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
        if (!targetsMe(a)) return;
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

  /* Phases 4b-25e extracted every per-tab subsystem out of this file —
     SOS, Improvements, Customer Notes, Service Recoveries, Customer
     Notes Suggestions, Training, Pilot Readiness, Feed, Recent DCRs,
     DCR Issues, Tech Health, Yesterday's Work, Customers, Techs,
     Tech Media, Admins, Supply Requests, Day Health, Announcements,
     DCR Review, Deputy Mapping, Schedule, Attendance/Open Shifts.
     Shell helpers (modals, toast, write-error, row overflow, modal
     close, copy clipboard) live in admin/_shell.js. Pure helpers live
     in admin/_utils.js. See git log for per-tab extraction history;
     this file is now the foundation layer only. */

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
    registerTabActivator("labor-review",    window.__pioneerAdmin.tabs.laborReview.refresh);
    registerTabActivator("payroll",         window.__pioneerAdmin.tabs.payroll.refresh);
    registerTabActivator("payroll-exceptions", window.__pioneerAdmin.tabs.payrollExceptions.refresh);
    registerTabActivator("sick-leave",      window.__pioneerAdmin.tabs.sickLeave.refresh);
    registerTabActivator("office-issues",   window.__pioneerAdmin.tabs.officeIssues.refresh);
    registerTabActivator("tech-health",     window.__pioneerAdmin.tabs.techHealth.refresh);
    registerTabActivator("pilot-readiness", window.__pioneerAdmin.tabs.pilotReadiness.init);
    registerTabActivator("yesterday",       window.__pioneerAdmin.tabs.yesterdaysWork.init);
    registerTabActivator("improvements",    window.__pioneerAdmin.tabs.improvements.init);
    registerTabActivator("sos",             window.__pioneerAdmin.tabs.sos.init);
    window.__pioneerAdmin.tabs.recentDcrs.init();
    window.__pioneerAdmin.tabs.supplyRequests.init();
    window.__pioneerAdmin.tabs.dcrIssues.init();
    window.__pioneerAdmin.tabs.dayHealth.init();
    window.__pioneerAdmin.tabs.announcements.init();
    window.__pioneerAdmin.tabs.admins.init();
    window.__pioneerAdmin.tabs.dcrReview.init();
    window.__pioneerAdmin.tabs.payrollExceptions.init();
    window.__pioneerAdmin.tabs.missionControl.init();
    // Phase 31 — Mission Control loads the top panel on auth-ready.
    // Fire-and-forget; its own loadSnapshot() handles parallel reads
    // and degrades to per-card "—" placeholders if any single read fails.
    window.__pioneerAdmin.tabs.missionControl.refresh();
    // Populate the deps bridge BEFORE any tab module's init/refresh
    // can read from it. Scaffolding for tab modules that still need
    // closure-local helpers from admin.js (customers array, modal
    // infra, admin-email, write-error handler). Goes away when those
    // are extracted in later phases.
    // Cross-tab data-read bridge — five live array getters consumed by
    // sibling tab modules, plus the cross-tab fan-out orchestrator owned
    // by admin.js. Phase 25a retired four shell-side helpers
    // (getCurrentAdminEmail, handleAdminWriteError, setModalError,
    // setModalSaving — tab modules now destructure those from
    // window.__pioneerAdmin.shell). Phase 25f retired five
    // module-aliases (loadAdmins, getAdmins, refreshAttentionStrip,
    // getOpsDayWindow, populateCustomerDeputyIntegration — consumers
    // now call the owning namespace or utils export directly).
    window.__pioneerAdmin.deps = {
      getCustomers:                  function () { return window.__pioneerAdmin.tabs.customers.getCustomers(); },
      getTechs:                      function () { return window.__pioneerAdmin.tabs.techs.getTechs(); },
      getDcrs:                       function () { return window.__pioneerAdmin.tabs.recentDcrs.getDcrs(); },
      getDcrIssues:                  function () { return window.__pioneerAdmin.tabs.dcrIssues.getDcrIssues(); },
      getSupplyRequests:             function () { return window.__pioneerAdmin.tabs.supplyRequests.getSupplyRequests(); },
      loadDcrsAndRerenderDependents: function () { return loadDcrsAndRerenderDependents(); }
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
    window.__pioneerAdmin.tabs.laborReview.init();
    window.__pioneerAdmin.tabs.payroll.init();
    window.__pioneerAdmin.tabs.sickLeave.init();
    window.__pioneerAdmin.tabs.techHealth.init();
    // V20260615b — Office Issues + Yesterday's Work boot init. Both tabs
    // were lazy-loaded via registerTabActivator only. The shell now
    // dispatches activators on pill click (see _shell.js wireTabs), so
    // these inits are belt-and-suspenders — they guarantee click-
    // delegation wires up before the first refresh AND cover the case
    // where the tab is the default (active on boot, never clicked).
    window.__pioneerAdmin.tabs.yesterdaysWork.init();
    window.__pioneerAdmin.tabs.officeIssues.init();
    installModalCloseAffordances();
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
