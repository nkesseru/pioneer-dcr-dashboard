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
    getTechSlug
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
    registerTabActivator
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

  // Announcements (v1). Admin-authored; visible to all signed-in staff.
  // Populated by loadAnnouncements() once admin auth resolves.
  let announcements = [];

  // Operational admins (Firestore-backed allowlist via /admins/{email}).
  // Doesn't include the hardcoded ALLOWED_ADMIN_EMAILS — those are
  // displayed in the panel separately, as a read-only "root admins"
  // section that explains where they're managed.
  let admins = [];

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
    if (typeof refreshAttentionStrip      === "function") refreshAttentionStrip();
  }

  /* ---------- supply requests ---------- */

  // Internal status VALUES are unchanged — Firestore docs and audit fields
  // (reviewed_at, customer_contacted_at, ordered_at) keep working without
  // migration. Display ORDER and LABELS are the only things that move.
  //
  // Workflow order per spec (new → reviewed → customer-notified → ordered → closed):
  const SUPPLY_STATUSES = ["new", "reviewed", "customer_contacted", "ordered", "closed"];
  // The status KEY `ordered` is kept stable for back-compat with every
  // historical supply_requests doc; only the LABEL changes. The new
  // label intentionally drops the past-tense "Ordered" — at this status
  // the order is queued for April to place, not yet placed.
  const STATUS_LABELS = {
    new:                "New",
    reviewed:           "Reviewed by PCC",
    customer_contacted: "Customer Notified",
    ordered:            "Pioneer Commercial Cleaning will order",
    closed:             "Closed / Received"
  };

  /* April supply-order notification target.
   *
   * Stored in admin.js (which Firebase Hosting serves publicly, so anyone
   * who scrapes /admin.js sees the phone). That trade-off was accepted
   * by the office — the contact info is internal-public, not a secret.
   * The Firestore collection `supply_notifications` is admin-only via
   * rules and is NEVER read by tech.js / app.js / techHubViewV1, so the
   * phone does not leak through any tech-facing surface.
   *
   * To rotate the contact: edit this object + redeploy hosting. No
   * Firestore migration is required — only future notifications get the
   * new values; historical docs preserve the values at create time. */
  const APRIL_NOTIFY = {
    name:                    "April Kesseru",
    phone:                   "5098283335",
    slack:                   true,
    reminder_interval_hours: 48
  };
  // Groups that start expanded — the active workflow stages. Closed stays
  // collapsed so it doesn't crowd the day-to-day view.
  const GROUPS_OPEN_BY_DEFAULT = { new: true, reviewed: true, ordered: true, customer_contacted: true, closed: false };

  let supplyRequests = [];

  function isToday(ts) {
    if (!ts) return false;
    let date;
    try {
      if (typeof ts.toDate === "function") date = ts.toDate();
      else if (typeof ts === "object" && typeof ts.seconds === "number") date = new Date(ts.seconds * 1000);
      else if (typeof ts === "string") date = new Date(ts);
      else return false;
    } catch (e) { return false; }
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
  }

  function updateSupplyMetrics(list) {
    let newCount = 0, orderedToday = 0, openCount = 0;
    list.forEach(function (r) {
      const status = r.status || "new";
      if (status === "new")     newCount += 1;
      if (status !== "closed")  openCount += 1;
      if (status === "ordered" && isToday(r.ordered_at)) orderedToday += 1;
    });
    const mN = $("metric-new");          if (mN) mN.textContent = newCount;
    const mT = $("metric-ordered-today"); if (mT) mT.textContent = orderedToday;
    const mO = $("metric-open");         if (mO) mO.textContent = openCount;

    // The tab badge now mirrors the OPEN count — every request that isn't
    // Closed / Received. Same number as the "Open" metric card, so the
    // top-of-tab badge and the in-tab card always agree. Previously it
    // showed the New count, which conflicted with the "Open" card and made
    // the badge's meaning ambiguous. Open is also the more actionable
    // signal for "how many supply tickets still need office work".
    const tabBadge = $("supply-tab-badge");
    if (tabBadge) {
      if (openCount > 0) {
        tabBadge.textContent = openCount;
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }
  }

  // Build an aging chip for a supply request. The chip shows "Xd open"
  // (or "Xh open" for under-24h items) plus a warn/danger color tier:
  //   • >48h open AND status === "new"           → danger (stale entry)
  //   • >24h reviewed but not ordered/contacted  → warn (follow-up overdue)
  //   • everything else                          → neutral
  // Returns the HTML string or "" when no meaningful chip applies.
  function supplyAgingChipHtml(r) {
    const createdMs  = supplyTsToMs(r.created_at);
    const reviewedMs = supplyTsToMs(r.reviewed_at);
    const status     = r.status || "new";
    if (createdMs == null) return "";
    const ageMs = Date.now() - createdMs;
    const ageHr = ageMs / 3600000;
    const ageDay = ageMs / 86400000;
    const ageLabel = ageHr < 24
      ? Math.max(0, Math.round(ageHr)) + "h open"
      : Math.max(1, Math.round(ageDay)) + "d open";
    let cls = "";
    // Stale "new" — sitting unreviewed for more than 48 hours.
    if (status === "new" && ageMs > 48 * 3600000) cls = " is-danger";
    // Reviewed but no forward motion for 24h+ → follow-up overdue.
    else if (status === "reviewed" && reviewedMs != null &&
             (Date.now() - reviewedMs) > 24 * 3600000) cls = " is-warn";
    return '<span class="supply-aging-chip' + cls + '">' + escapeHtml(ageLabel) + '</span>';
  }

  // Source discriminator. Default to "customer_supply" for any legacy
  // doc that pre-dates the source field — those all originated from
  // submitDcrV1's auto-create path, which was customer-driven.
  function getSupplyRowSource(r) {
    const s = (r && r.source) || "";
    return s === "supply_station" ? "supply_station" : "customer_supply";
  }

  // Build the head + body of one supply-request card. innerHTML is safe here —
  // every dynamic value passes through escapeHtml().
  function supplyRowMarkup(r) {
    const source       = getSupplyRowSource(r);
    const isStation    = source === "supply_station";
    // Heading line — different defaults per source. Customer requests
    // anchor on the customer name; supply-station orders anchor on the
    // requester's name since there's no customer.
    const headlineRaw  = isStation
      ? (r.tech_display_name || r.requested_by_email || "Supply station order")
      : (r.customer_name || "(no customer)");
    const headline     = escapeHtml(headlineRaw);
    // Sublines: customer rows show "location · clean_date · tech";
    // supply-station rows show "Priority · Categories · requested_by".
    // Empty pieces are dropped (per spec: "gracefully hide if blank").
    let subLineHtml    = "";
    if (isStation) {
      const subParts = [];
      if (r.priority)                     subParts.push("Priority: " + r.priority);
      if (Array.isArray(r.categories) && r.categories.length) {
        subParts.push("Categories: " + r.categories.join(", "));
      }
      if (r.requested_by_email)           subParts.push(r.requested_by_email);
      subLineHtml = '<div class="supply-row-sub">' + escapeHtml(subParts.join(" · ")) + '</div>';
    } else {
      const cleanDate = r.clean_date || "";
      const tech      = r.tech_display_name || "";
      const location  = r.location_name || "";
      const subParts  = [];
      if (location)  subParts.push(location);
      if (cleanDate) subParts.push(cleanDate);
      if (tech)      subParts.push(tech);
      subLineHtml = '<div class="supply-row-sub">' + escapeHtml(subParts.join(" · ") || "—") + '</div>';
    }

    const items    = escapeHtml(r.requested_items || "(no items listed)");
    const vendor   = escapeHtml(r.vendor || "—");
    const order    = escapeHtml(r.order_number || "—");
    const status   = r.status || "new";
    const statusLabel = STATUS_LABELS[status] || status;
    const agingHtml   = supplyAgingChipHtml(r);

    // Source badge — visually distinct so the office can scan the queue
    // and immediately tell which kind of request is in front of them.
    const sourceBadge = isStation
      ? badge("is-station", "🧺 Supply Station")
      : badge("is-neutral", "Customer Supply");

    // Status-select options — current value pre-selected.
    const statusOptions = SUPPLY_STATUSES.map(function (s) {
      const sel = s === status ? " selected" : "";
      return '<option value="' + s + '"' + sel + '>' + STATUS_LABELS[s] + '</option>';
    }).join("");

    // Optional supply-station meta line shown above the items text.
    // Only renders if there's anything to say (note + priority were
    // already in subLineHtml; this line adds "Note: …" if present).
    const stationNoteHtml = (isStation && r.note)
      ? '<p class="supply-row-note"><strong>Note:</strong> ' + escapeHtml(r.note) + '</p>'
      : '';

    // Assignment chip + Mark Fulfilled quick action. The full status
    // workflow (new → reviewed → ordered → closed) is still available
    // inside Edit; Mark Fulfilled is the one-click "this is done"
    // shortcut and stamps fulfilled_at + fulfilled_by.
    const assignedName  = r.assigned_to_name || r.assigned_to ||
                            (r.fulfilled_at ? "" : "Kirby");
    const assignedChip  = assignedName
      ? '<span class="badge is-assigned">Assigned: ' + escapeHtml(assignedName) + '</span>'
      : '';
    const isClosed      = status === "closed";
    const markFulfilledBtn = isClosed
      ? ''
      : '<button class="supply-row-edit" type="button" data-action="mark-fulfilled">Mark Fulfilled</button>';
    const fulfilledMeta = r.fulfilled_at
      ? '<div class="supply-row-fulfilled">Fulfilled' +
          (r.fulfilled_by ? ' by ' + escapeHtml(r.fulfilled_by) : '') +
          (r.fulfilled_at && r.fulfilled_at.toDate
            ? ' at ' + escapeHtml(r.fulfilled_at.toDate().toLocaleString())
            : '') +
        '</div>'
      : '';

    return (
      '<article class="supply-row" data-request-id="' + escapeHtml(r.request_id || r.id) + '" data-status="' + status + '" data-source="' + source + '">' +
        '<header class="supply-row-head">' +
          '<div style="min-width:0;flex:1 1 auto;">' +
            '<div class="supply-row-name">' + headline + '</div>' +
            subLineHtml +
          '</div>' +
          sourceBadge +
          '<span class="badge status-' + status + '">' + escapeHtml(statusLabel) + '</span>' +
          assignedChip +
          agingHtml +
          markFulfilledBtn +
          '<button class="supply-row-edit" type="button" data-action="edit">Edit</button>' +
        '</header>' +
        '<p class="supply-row-items">' + items + '</p>' +
        stationNoteHtml +
        fulfilledMeta +
        '<div class="supply-row-meta">' +
          '<span><strong>Vendor:</strong> ' + vendor + '</span>' +
          '<span><strong>Order #:</strong> ' + order + '</span>' +
        '</div>' +

        '<div class="supply-edit">' +
          '<div class="field-row"><label>Status</label>' +
            '<select class="supply-status-select">' + statusOptions + '</select>' +
          '</div>' +
          '<div class="field-row"><label>Vendor</label>' +
            '<input type="text" class="supply-vendor-input" value="' + escapeHtml(r.vendor || "") + '" placeholder="e.g. Costco" />' +
          '</div>' +
          '<div class="field-row"><label>Order #</label>' +
            '<input type="text" class="supply-order-input" value="' + escapeHtml(r.order_number || "") + '" placeholder="Vendor order number" />' +
          '</div>' +
          '<div class="field-row"><label>Admin notes</label>' +
            // `admin_notes` is the canonical office-side log. Fall back to
            // BOTH legacy fields (`notes` and `request_notes`) for docs that
            // pre-date the rename — read-only fallback, neither field is
            // written here anymore. Next save migrates the text into
            // admin_notes; the legacy fields freeze where they are on the
            // doc and stop affecting display.
            '<textarea class="supply-admin-notes-input" placeholder="Office notes — vendor confirmation, ETA, follow-ups…">' +
              escapeHtml(r.admin_notes || r.notes || r.request_notes || "") +
            '</textarea>' +
          '</div>' +
          '<div class="supply-save-error"></div>' +
          '<div class="supply-edit-actions">' +
            '<button class="supply-cancel" type="button" data-action="cancel">Cancel</button>' +
            '<button class="supply-save"   type="button" data-action="save">Save</button>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  // Render all supply requests grouped by status, in the SUPPLY_STATUSES order.
  function renderSupplyRequests(list) {
    const root = $("supply-list");
    const cnt  = $("supply-count");
    if (!root) return;

    if (cnt) {
      cnt.textContent = list.length + ' request' + (list.length === 1 ? '' : 's');
    }

    if (list.length === 0 && supplyRequests.length === 0) {
      setStatus("supply", "empty");
      root.innerHTML = "";
      updateSupplyMetrics([]);
      return;
    }
    hideAllStatuses("supply");

    // Bucket by status.
    const byStatus = {};
    SUPPLY_STATUSES.forEach(function (s) { byStatus[s] = []; });
    list.forEach(function (r) {
      const s = SUPPLY_STATUSES.indexOf(r.status) >= 0 ? r.status : "new";
      byStatus[s].push(r);
    });

    // Within each bucket, newest first.
    SUPPLY_STATUSES.forEach(function (s) {
      byStatus[s].sort(function (a, b) {
        const at = (a.created_at && a.created_at.seconds) || 0;
        const bt = (b.created_at && b.created_at.seconds) || 0;
        return bt - at;
      });
    });

    root.innerHTML = SUPPLY_STATUSES.map(function (s) {
      const rows = byStatus[s];
      if (!rows.length) return "";
      const isOpen = GROUPS_OPEN_BY_DEFAULT[s] ? " open" : "";
      return (
        '<details class="supply-group" data-status="' + s + '"' + isOpen + '>' +
          '<summary class="supply-group-summary">' +
            '<span class="badge status-' + s + '">' + escapeHtml(STATUS_LABELS[s]) + '</span>' +
            '<span class="supply-group-count">' +
              rows.length + ' request' + (rows.length === 1 ? '' : 's') +
            '</span>' +
          '</summary>' +
          '<div class="supply-group-rows">' +
            rows.map(supplyRowMarkup).join("") +
          '</div>' +
        '</details>'
      );
    }).join("");

    // (Re-)wire the edit/save/cancel handlers on the freshly-rendered DOM.
    wireSupplyRowActions(root);

    // Update metrics + tab badge from the *unfiltered* list, so the numbers
    // don't drop when the user searches.
    updateSupplyMetrics(supplyRequests);
  }

  function wireSupplyRowActions(root) {
    $$(".supply-row", root).forEach(function (row) {
      const editBtn      = row.querySelector('[data-action="edit"]');
      const cancelBtn    = row.querySelector('[data-action="cancel"]');
      const saveBtn      = row.querySelector('[data-action="save"]');
      const fulfillBtn   = row.querySelector('[data-action="mark-fulfilled"]');
      if (editBtn)   editBtn.addEventListener("click",   function () { row.classList.add("is-editing"); });
      if (cancelBtn) cancelBtn.addEventListener("click", function () {
        row.classList.remove("is-editing", "has-save-error");
      });
      if (saveBtn)   saveBtn.addEventListener("click",   function () { onSupplySave(row); });
      if (fulfillBtn) fulfillBtn.addEventListener("click", function () { onSupplyMarkFulfilled(row); });
    });
  }

  // Quick-action: flip a supply request to status:"closed" + stamp
  // fulfilled_at + fulfilled_by. Skips the full Edit drawer for the
  // common "this is done" case. Keeps the supply_notifications
  // close-out write in sync via the same statusAuditUpdates path.
  async function onSupplyMarkFulfilled(row) {
    const id = row.getAttribute("data-request-id");
    if (!id) return;
    const prior = supplyRequests.find(function (r) { return (r.request_id || r.id) === id; });
    if (!prior) return;
    if (!window.confirm(
      "Mark this supply request as fulfilled?\n\n" +
      "Items: " + (prior.requested_items || "(none)") + "\n\n" +
      "Status will flip to Closed and Kirby will be stamped as the fulfiller."
    )) return;
    const me = getCurrentAdminEmail();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const updates = Object.assign(
      {
        status:       "closed",
        fulfilled_at: now,
        fulfilled_by: me || "admin",
        closed_at:    now,
        closed_by:    me || "admin",
        updated_at:   now,
        updated_by:   me || "admin"
      },
      statusAuditUpdates(prior, "closed", me)
    );
    try {
      await db.collection("supply_requests").doc(id).update(updates);
      showToast("ok", "Supply request marked fulfilled.");
      // Best-effort close-out of the matching supply_notifications doc.
      try {
        await db.collection("supply_notifications").doc(id).set({
          notification_status: "resolved",
          resolved_at:         now,
          resolved_by:         me || "admin"
        }, { merge: true });
      } catch (_e) { /* swallow — supply_notifications may not exist */ }
      // Reload supply list to refresh the metrics + filters.
      await loadSupplyRequests();
    } catch (err) {
      handleAdminWriteError(err, { context: "mark supply request fulfilled" });
    }
  }

  // Compute audit-field updates triggered by a status change. First-time set
  // only — a status that's been hit before keeps its original by/at pair so
  // the audit trail is preserved through workflow ping-pong.
  function statusAuditUpdates(prev, newStatus, currentEmail) {
    const updates = {};
    const now = firebase.firestore.FieldValue.serverTimestamp();
    if (newStatus === "reviewed" && !prev.reviewed_at) {
      updates.reviewed_by = currentEmail;
      updates.reviewed_at = now;
    }
    if (newStatus === "ordered" && !prev.ordered_at) {
      updates.ordered_by = currentEmail;
      updates.ordered_at = now;
    }
    if (newStatus === "customer_contacted" && !prev.customer_contacted_at) {
      updates.customer_contacted_by = currentEmail;
      updates.customer_contacted_at = now;
    }
    return updates;
  }

  /* April supply-order notification flow.
   *
   * Lifecycle:
   *   • Supply status transitions INTO "ordered" for the first time
   *     → create supply_notifications/{request_id} with notification_status
   *       "pending", reminder_count=0, next_reminder_at = now + 48h.
   *   • Supply status transitions to "closed"
   *     → update the same notification doc: resolved_at = now,
   *       notification_status = "resolved".
   *
   * Reminders are NOT driven by this client — see the README block in
   * the head of this file for Zapier polling instructions. The admin
   * client only writes the trigger record and resolves it on close.
   *
   * v1 Zap contract (in production as of 2026-05-14):
   *   • Trigger: Firestore new-document on supply_notifications.
   *   • Filter: notification_status === "pending" AND (
   *               type === "supply_station_order"
   *               OR (supply_request_id exists AND status === "ordered")
   *             ).
   *   • Action: Slack DM to April + Slack DM to Kirby.
   *   • Final: Firestore PATCH on same doc → notification_status="sent",
   *            last_notified_at=now, sent_channels="slack_april,slack_kirby".
   *   • Reminders: intentionally deferred — there is no Zap polling
   *     next_reminder_at in v1. The doc's next_reminder_at field is
   *     written but not consumed. Build a scheduled Zap later if needed.
   *   • Failure path: intentionally deferred — Slack delivery failures
   *     leave the doc in "pending"; office sees the held Zap run and
   *     retries from the Zapier history UI.
   *   • Firestore PATCH (not full set) with explicit updateMask is
   *     intentional — preserves reminder_count + next_reminder_at so a
   *     future reminder Zap can resume cleanly.
   *   • sent_channels tracks ACTUALLY delivered channels (comma-joined).
   *     If a future Zap stage adds e.g. email or webhook, append it to
   *     the string rather than overwriting.
   *
   * OPERATOR NOTE: any held Zap runs from pre-v2 testing (April-phone
   * variant, SMS attempts, mis-triggered DCR notifications) can be
   * safely ignored or bulk-dismissed in the Zapier task history. They
   * predate the current filter and won't re-fire under the new rules.
   *
   * Idempotency: the supply_request_id is the notification doc ID. If
   * the same supply hits "ordered" twice (e.g. admin reverts then
   * re-promotes), the second write is a no-op against any existing
   * pending doc — we explicitly check for an existing doc first so a
   * Zapier-side reminder cycle in flight is not reset.
   *
   * Failure handling: a Firestore write failure here does NOT roll back
   * the supply_requests update — the status change is still valid; the
   * admin just sees a warning toast and can retry the notification
   * manually if needed. */
  async function createAprilSupplyNotification(supplyRequest) {
    if (!supplyRequest) return;
    const id = supplyRequest.request_id || supplyRequest.id;
    if (!id) return;

    const ref = db.collection("supply_notifications").doc(id);
    let existing = null;
    try {
      const snap = await ref.get();
      if (snap.exists) existing = snap.data();
    } catch (err) {
      console.warn("createAprilSupplyNotification: read failed (will still try to write)", err && err.code);
    }
    // Don't reset an active reminder cycle by re-creating from scratch.
    if (existing && existing.notification_status === "pending") return;

    // We write Firestore Timestamp values for our own timestamps (sts +
    // nextReminderAt). The Zap that updates last_notified_at on send
    // currently writes a stringValue via Zapier's Firestore connector —
    // workable for v1 but inconsistent with this side of the contract.
    // Follow-up: migrate the Zap to set last_notified_at as a real
    // Firestore Timestamp (Zapier Code-step or Custom Action format).
    // Until then, any consumer that reads last_notified_at must accept
    // BOTH shapes — see supplyTsToMs() in this file for the reader
    // that already handles strings, numbers, and Timestamps.
    const sts            = firebase.firestore.FieldValue.serverTimestamp();
    const nextReminderAt = new Date(Date.now() + APRIL_NOTIFY.reminder_interval_hours * 3600 * 1000);
    const doc = {
      supply_request_id:       id,
      customer_slug:           supplyRequest.customer_slug   || "",
      customer_name:           supplyRequest.customer_name   || "",
      location_name:           supplyRequest.location_name   || "",
      requested_items:         supplyRequest.requested_items || "",
      requested_by_tech:       supplyRequest.tech_display_name || supplyRequest.tech_slug || "",
      clean_date:              supplyRequest.clean_date      || "",
      status:                  "ordered",
      created_at:              sts,
      created_by:              getCurrentAdminEmail(),
      notify_to_name:          APRIL_NOTIFY.name,
      notify_to_phone:         APRIL_NOTIFY.phone,
      notify_to_slack:         APRIL_NOTIFY.slack,
      notification_status:     "pending",
      last_notified_at:        null,
      next_reminder_at:        nextReminderAt,
      reminder_interval_hours: APRIL_NOTIFY.reminder_interval_hours,
      reminder_count:          0,
      resolved_at:             null,
      // Message Zapier can use verbatim for the SMS / Slack body. Built
      // here so the Zap doesn't need template logic.
      message_summary: [
        "Supply order ready to place:",
        supplyRequest.customer_name || supplyRequest.customer_slug || "(unknown customer)",
        supplyRequest.location_name ? " — " + supplyRequest.location_name : "",
        "\nItems: " + (supplyRequest.requested_items || "(none listed)"),
        "\nRequested by: " + (supplyRequest.tech_display_name || "(unknown tech)"),
        "\nClean date: " + (supplyRequest.clean_date || "—"),
        "\nStatus: Pioneer Commercial Cleaning will order"
      ].join("")
    };
    try {
      await ref.set(doc, { merge: false });
      showToast("ok", "Notification queued for " + APRIL_NOTIFY.name + ".");
    } catch (err) {
      console.error("createAprilSupplyNotification: write failed", err);
      handleAdminWriteError(err, { context: "april notification" });
    }
  }

  async function resolveAprilSupplyNotification(supplyRequest) {
    if (!supplyRequest) return;
    const id = supplyRequest.request_id || supplyRequest.id;
    if (!id) return;
    const ref = db.collection("supply_notifications").doc(id);
    try {
      // Only touch the doc if it actually exists — avoids accidentally
      // creating a "resolved" notification for a supply that never went
      // through the "ordered" stage in the first place.
      const snap = await ref.get();
      if (!snap.exists) return;
      await ref.update({
        notification_status: "resolved",
        resolved_at:         firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:          firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:          getCurrentAdminEmail()
      });
    } catch (err) {
      console.warn("resolveAprilSupplyNotification failed (non-fatal)", err && err.code);
    }
  }

  async function onSupplySave(row) {
    const id = row.dataset.requestId;
    if (!id) return;

    const prev = supplyRequests.find(function (r) { return (r.request_id || r.id) === id; }) || {};
    const newStatus  = row.querySelector(".supply-status-select").value;
    const vendor     = row.querySelector(".supply-vendor-input").value.trim();
    const orderNum   = row.querySelector(".supply-order-input").value.trim();
    const adminNotes = row.querySelector(".supply-admin-notes-input").value;

    const currentEmail = (firebase.auth().currentUser && firebase.auth().currentUser.email) || null;

    const updates = Object.assign({
      status:       newStatus,
      vendor:       vendor,
      order_number: orderNum,
      // `admin_notes` is the renamed office-log field. Writing it here
      // doesn't touch the legacy `notes` on existing docs — `notes` simply
      // becomes a frozen historical field on those records.
      admin_notes:  adminNotes,
      updated_at:   firebase.firestore.FieldValue.serverTimestamp(),
      // Audit who made the change. Mirrors the customer / tech save paths
      // so every write across all three admin collections is attributable.
      updated_by:   currentEmail || "unknown"
    }, statusAuditUpdates(prev, newStatus, currentEmail));

    const saveBtn = row.querySelector('[data-action="save"]');
    const errEl   = row.querySelector(".supply-save-error");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    row.classList.remove("has-save-error");
    if (errEl) errEl.textContent = "";

    try {
      await db.collection("supply_requests").doc(id).update(updates);
      // Local cache update so the next render shows fresh values without a
      // second round-trip. Server timestamps stay as the local ISO until the
      // next refresh; that's fine for the immediate-feedback UI.
      const idx = supplyRequests.findIndex(function (r) { return (r.request_id || r.id) === id; });
      if (idx >= 0) {
        const merged = Object.assign({}, supplyRequests[idx], updates);
        // Replace the FieldValue sentinels with a JS Date so the local
        // metrics/format helpers don't choke.
        if (updates.reviewed_at)            merged.reviewed_at           = new Date();
        if (updates.ordered_at)             merged.ordered_at            = new Date();
        if (updates.customer_contacted_at)  merged.customer_contacted_at = new Date();
        merged.updated_at = new Date();
        supplyRequests[idx] = merged;
      }
      row.classList.remove("is-editing");
      // Full list re-render — innerHTML is replaced, so every row
      // (including this one, plus the destination row in the new status
      // group if status changed) is rebuilt fresh from the patched cache.
      // No stale vendor / order / admin_notes / status values can persist
      // because the originating DOM is discarded.
      applyCurrentSupplyFilter();
      showToast("ok", "Supply request updated.");

      // April notification side effects (best-effort, non-blocking).
      //
      //   • Transition INTO "ordered" → queue April notification.
      //   • Transition INTO "closed" → mark any existing notification
      //     resolved so Zapier stops the reminder loop.
      //
      // Awaited so any error toasts render in the same user-perceived
      // action. Failures here do not roll back the supply save.
      const prevStatus = (prev && prev.status) || "new";
      const merged     = (idx >= 0) ? supplyRequests[idx] : Object.assign({}, prev, updates);
      if (newStatus === "ordered" && prevStatus !== "ordered") {
        await createAprilSupplyNotification(merged);
      } else if (newStatus === "closed" && prevStatus !== "closed") {
        await resolveAprilSupplyNotification(merged);
      }
    } catch (err) {
      console.error("supply update failed", err);
      const msg = (err && (err.message || err.code)) || String(err);
      row.classList.add("has-save-error");
      if (errEl) errEl.textContent = "Couldn't save: " + msg;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  }

  async function loadSupplyRequests() {
    setStatus("supply", "loading");
    try {
      const snap = await db.collection("supply_requests")
        .orderBy("created_at", "desc")
        .get();
      supplyRequests = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      refreshSupplyFilterOptions();
      // Apply current filters (no-op selects → unfiltered render).
      applyCurrentSupplyFilter();
      refreshAttentionStrip();
      // Load + render the admin-only Supply Notices disclosure.
      loadSupplyNotices();
    } catch (err) {
      console.error("loadSupplyRequests failed", err);
      setStatus("supply", "error",
        "Couldn't load supply requests: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', confirm:" +
        "\n  • You're signed in as one of the four Pioneer admin emails." +
        "\n  • firestore.rules has the /supply_requests block deployed."
      );
    }
  }

  // ---- Supply Notices (admin-only awareness layer) ------------------
  // Read /supply_notices, sort newest first, cap at most-recent-14-days
  // for display. The collection itself is admin-only by firestore rule.
  async function loadSupplyNotices() {
    const root    = $("supply-notices-list");
    const counter = $("supply-notices-counter");
    if (!root) return;
    try {
      const cutoffMs = Date.now() - 14 * 24 * 3600 * 1000;
      const snap = await db.collection("supply_notices")
        .orderBy("created_at", "desc")
        .limit(50)
        .get();
      const notices = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      }).filter(function (n) {
        const t = n.created_at && n.created_at.toMillis ? n.created_at.toMillis() : 0;
        return t >= cutoffMs;
      });
      if (counter) counter.textContent = String(notices.length);
      if (notices.length === 0) {
        root.innerHTML = '<p class="dm-empty-state">No new supply notices in the last 14 days.</p>';
        return;
      }
      root.innerHTML = notices.map(function (n) {
        const when = n.created_at && n.created_at.toDate
                       ? n.created_at.toDate().toLocaleString()
                       : "";
        return (
          '<div class="supply-notice-row" role="listitem">' +
            '<div class="supply-notice-head">' +
              '<strong>' + escapeHtml(n.title || "New supply request") + '</strong>' +
              '<span class="badge is-neutral">' + escapeHtml(n.source || "dcr") + '</span>' +
              '<span class="badge is-assigned">' + escapeHtml(n.assigned_to_name || "Kirby") + '</span>' +
            '</div>' +
            '<div class="supply-notice-body">' + escapeHtml(n.body || "") + '</div>' +
            '<div class="supply-notice-meta">' +
              (when ? escapeHtml(when) + ' · ' : '') +
              'order <code>' + escapeHtml(n.linked_supply_order_id || "") + '</code>' +
            '</div>' +
          '</div>'
        );
      }).join("");
    } catch (err) {
      // Soft-fail — the notice disclosure is informational; the
      // supply_requests list below is the operational source of truth.
      console.warn("[supply-notices] load failed", err && err.code);
      if (counter) counter.textContent = "?";
      root.innerHTML = '<p class="dm-empty-state">Couldn\'t load notices: ' +
                       escapeHtml(err && err.message || "unknown") + '</p>';
    }
  }

  // Pulled out so save / search both re-apply the same active filter without
  // duplicating the matching logic. Honors text search AND the compound
  // status/customer/tech/window selects added to the supply panel.
  function applyCurrentSupplyFilter() {
    const ds = $("supply-search");
    const q  = ds ? ds.value.trim().toLowerCase() : "";

    const sourceSel   = $("supply-filter-source");
    const statusSel   = $("supply-filter-status");
    const customerSel = $("supply-filter-customer");
    const techSel     = $("supply-filter-tech");
    const windowSel   = $("supply-filter-window");
    const wantSource = sourceSel   ? sourceSel.value   : "all";
    const status     = statusSel   ? statusSel.value   : "all";
    const cust       = customerSel ? customerSel.value : "all";
    const tech       = techSel     ? techSel.value     : "all";
    const winDays    = windowSel   ? parseInt(windowSel.value, 10) : NaN;
    const cutoffMs   = isNaN(winDays) ? null : Date.now() - winDays * 24 * 60 * 60 * 1000;

    const filtered = supplyRequests.filter(function (r) {
      // Source filter — defaults to "customer_supply" for legacy docs
      // that don't have an explicit source field.
      if (wantSource !== "all" && getSupplyRowSource(r) !== wantSource) return false;
      // Status filter — "open" is a pseudo-status meaning "anything not
      // closed". The dropdown lets the office filter to the actionable
      // queue without committing to one specific stage.
      const rowStatus = r.status || "new";
      if (status === "open" && rowStatus === "closed") return false;
      if (status !== "all" && status !== "open" && rowStatus !== status) return false;
      if (cust   !== "all" && (r.customer_slug || "")  !== cust) return false;
      if (tech   !== "all" && (r.tech_slug || "")      !== tech) return false;
      if (cutoffMs != null) {
        const ms = supplyTsToMs(r.created_at);
        if (ms == null || ms < cutoffMs) return false;
      }
      if (q) {
        return (
          (r.customer_name      || "").toLowerCase().includes(q) ||
          (r.location_name      || "").toLowerCase().includes(q) ||
          (r.tech_display_name  || "").toLowerCase().includes(q) ||
          (r.requested_items    || "").toLowerCase().includes(q) ||
          (r.requested_by_email || "").toLowerCase().includes(q) ||
          (r.note               || "").toLowerCase().includes(q) ||
          (r.vendor             || "").toLowerCase().includes(q) ||
          (r.order_number       || "").toLowerCase().includes(q) ||
          (r.status             || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
    renderSupplyRequests(filtered);
  }

  // Tolerant timestamp reader for supply-request created_at (Firestore
  // Timestamp / ISO string / number-ms). Shared by the filter window
  // logic and the aging-chip computation.
  function supplyTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number")              return ts;
    if (typeof ts === "string")              { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function")   return ts.toMillis();
    if (typeof ts.seconds === "number")      return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  // Populates the customer + tech filter dropdowns from the loaded
  // supplyRequests list. Called whenever the cache repopulates.
  function refreshSupplyFilterOptions() {
    const custSel = $("supply-filter-customer");
    const techSel = $("supply-filter-tech");
    if (!custSel && !techSel) return;
    function uniqueOptions(arr, keyField, labelField) {
      const seen = {};
      arr.forEach(function (r) {
        const k = r[keyField];
        if (!k) return;
        if (!seen[k]) seen[k] = r[labelField] || k;
      });
      return Object.keys(seen).sort(function (a, b) {
        return String(seen[a]).localeCompare(String(seen[b]));
      }).map(function (k) {
        return '<option value="' + escapeHtml(k) + '">' + escapeHtml(seen[k]) + '</option>';
      }).join("");
    }
    if (custSel) {
      const cur = custSel.value;
      custSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(supplyRequests, "customer_slug", "customer_name");
      custSel.value = cur || "all";
    }
    if (techSel) {
      const cur = techSel.value;
      techSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(supplyRequests, "tech_slug", "tech_display_name");
      techSel.value = cur || "all";
    }
  }

  function wireSupplyControls() {
    const ds = $("supply-search");
    if (ds) ds.addEventListener("input", applyCurrentSupplyFilter);

    // Compound filter selects — each refilters in place. No reload of
    // the underlying data; the cache stays intact and we just re-render.
    ["supply-filter-source", "supply-filter-status", "supply-filter-customer",
     "supply-filter-tech",   "supply-filter-window"
    ].forEach(function (id) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", applyCurrentSupplyFilter);
    });

    const refresh = $("supply-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      refresh.disabled = true;
      const original = refresh.textContent;
      refresh.textContent = "Refreshing…";
      loadSupplyRequests().finally(function () {
        refresh.disabled = false;
        refresh.textContent = original;
        const ds2 = $("supply-search");
        if (ds2) ds2.value = "";
      });
    });
  }


  /* DCR Issues tab moved to public/admin/tab-dcr-issues.js (Phase 12).
     The dcrIssues array now lives there; admin-side modules read via
     window.__pioneerAdmin.deps.getDcrIssues(). Post-load and post-save
     side-effects (refreshAttentionStrip + applyCurrentCustomerFilter)
     are wired via tabs.dcrIssues.onChange() in boot. */

  /* =====================================================================
     Admin Ops Overview — top-of-page command center
     =====================================================================
     V6 native PioneerOps rewrite. "Today's Operations" now reads from
     the native DCR pipeline (dcr_email_payloads + customer_feedback +
     customer_complaints) instead of the dead Zapier delivery layer.

     Counts on the bottom KPI strip still come from the existing
     in-memory caches (customers, techs, dcrs, supplyRequests,
     dcrIssues) — no critical-path query change. The Today's Operations
     card adds two lightweight 24h-window queries, soft-failed.

     ────────────────────────────────────────────────────────────────────
     TODO — future signal sources for this card:
       • Email opens          tracking pixel on dcr_email_payloads → bump
                              a `openCount` field on the doc; render as
                              "Opens · 24h" + open-rate %.
       • Feedback CTA clicks  log a click event when feedback-compliment
                              / feedback-issue pages load with a dcrId.
                              Surface as "Feedback CTA clicks · 24h".
       • Portal link clicks   when the customer-facing portal lands,
                              count "View full report →" clicks
                              from the email footer.
     Until those land, the card intentionally OMITS open-rate so we
     don't display a misleading "0% open rate" when we're just not
     tracking opens. Per the spec: "If we do not currently track opens,
     do NOT fake it." */
  let inspectionsThisWeekCount = null;  // null = not yet loaded, number = resolved

  // Ops-day-window metrics for the Today's Operations card. Replaces
  // the prior rolling-24h window with a Pioneer ops-day window that
  // resets at 4 PM Pacific (see getOpsDayWindow above). Queries fetch
  // BOTH the current ops day AND the previous one in a single sweep:
  // we ask Firestore for everything `>= previousOpsStart` and bucket
  // in memory, so we get the "Yesterday Review" counts for free.
  //
  // Caps each read at 400 docs (twice the old 200 since the window
  // is twice as wide).
  let dayHealthOps = {
    loaded:    false,
    queryError: null,
    window:    null,           // { current{Start,End}, previous{Start,End}, opsDayLabel }
    current:   { emailsSent: 0, emailsFailed: 0, feedback: 0, callOuts: 0 },
    previous:  { emailsSent: 0, emailsFailed: 0, feedback: 0, callOuts: 0 }
  };
  // Old global name kept as an alias to avoid churn in callers that
  // read .emailsSent / .emailsFailed / .feedbackReceived during the
  // transition. Set by refreshDayHealthMetricsOpsDay().
  let dayHealth24h = {
    loaded:           false,
    emailsSent:       0,
    emailsFailed:     0,
    feedbackReceived: 0,
    queryError:       null
  };

  async function refreshDayHealthMetricsOpsDay() {
    const win = getOpsDayWindow(new Date());
    try { console.info("[OpsDay] current window",  { start: win.currentOpsStart.toISOString(),  end: win.currentOpsEnd.toISOString() }); } catch (_e) {}
    try { console.info("[OpsDay] previous window", { start: win.previousOpsStart.toISOString(), end: win.previousOpsEnd.toISOString() }); } catch (_e) {}

    try {
      const db = firebase.firestore();
      const prevStartTs = firebase.firestore.Timestamp.fromDate(win.previousOpsStart);

      // Pull everything since the START of the previous ops day in a
      // single shot per collection. We bucket into current vs previous
      // client-side using JS timestamp compares.
      const [payloadsSnap, feedbackSnap, callOutsSnap] = await Promise.all([
        db.collection("dcr_email_payloads")
          .where("createdAt", ">=", prevStartTs)
          .limit(400).get(),
        db.collection("customer_feedback")
          .where("createdAt", ">=", prevStartTs)
          .limit(400).get(),
        db.collection("call_outs")
          .where("submittedAt", ">=", prevStartTs)
          .limit(400).get()
          // Call-outs collection didn't exist when this metric set was
          // first wired. We catch a possible missing-collection / rules
          // error below so the whole refresh doesn't blow up if it's
          // empty.
          .catch(function (err) {
            console.warn("[OpsDay] call_outs query failed (soft)", err && err.message);
            return { docs: [] };
          })
      ]);

      function tsMs(t) {
        if (!t) return 0;
        if (typeof t.toMillis === "function") return t.toMillis();
        if (typeof t.seconds  === "number")   return t.seconds * 1000;
        return 0;
      }
      function bucketBy(snap, getTs, bucket) {
        (snap.docs || []).forEach(function (d) {
          const data = d.data ? (d.data() || {}) : {};
          const ms   = tsMs(getTs(data));
          if (!ms) return;
          if      (ms >= win.currentOpsStart.getTime()  && ms < win.currentOpsEnd.getTime())  bucket.current(data);
          else if (ms >= win.previousOpsStart.getTime() && ms < win.previousOpsEnd.getTime()) bucket.previous(data);
        });
      }

      const counts = {
        current:  { emailsSent: 0, emailsFailed: 0, feedback: 0, callOuts: 0 },
        previous: { emailsSent: 0, emailsFailed: 0, feedback: 0, callOuts: 0 }
      };
      bucketBy(payloadsSnap, function (d) { return d.createdAt; }, {
        current:  function (d) { if (d.sentAt) counts.current.emailsSent  += 1; else counts.current.emailsFailed  += 1; },
        previous: function (d) { if (d.sentAt) counts.previous.emailsSent += 1; else counts.previous.emailsFailed += 1; }
      });
      bucketBy(feedbackSnap, function (d) { return d.createdAt; }, {
        current:  function () { counts.current.feedback  += 1; },
        previous: function () { counts.previous.feedback += 1; }
      });
      bucketBy(callOutsSnap, function (d) { return d.submittedAt; }, {
        current:  function () { counts.current.callOuts  += 1; },
        previous: function () { counts.previous.callOuts += 1; }
      });

      dayHealthOps = {
        loaded:    true,
        queryError: null,
        window:    win,
        current:   counts.current,
        previous:  counts.previous
      };
      // Legacy alias for callers still reading dayHealth24h. Maps to
      // the CURRENT ops-day numbers (which is what "today" means now).
      dayHealth24h = {
        loaded:           true,
        emailsSent:       counts.current.emailsSent,
        emailsFailed:     counts.current.emailsFailed,
        feedbackReceived: counts.current.feedback,
        queryError:       null
      };
    } catch (err) {
      console.warn("refreshDayHealthMetricsOpsDay failed (soft)", err && err.message);
      dayHealthOps = Object.assign({}, dayHealthOps, {
        loaded:     true,
        window:     win,
        queryError: String(err && err.message || err)
      });
      dayHealth24h = Object.assign({}, dayHealth24h, {
        loaded:     true,
        queryError: String(err && err.message || err)
      });
    }
    refreshAttentionStrip();
  }
  // Keep the old name as an alias so any unconverted caller still
  // triggers the refresh. Cheap, no behavior change.
  const refreshDayHealthMetrics24h = refreshDayHealthMetricsOpsDay;

  function refreshAttentionStrip() {
    function paintCount(id, n, tone) {
      const el = $(id);
      if (!el) return;
      el.textContent = String(n);
      const card = el.closest(".kpi-card");
      if (card) card.setAttribute("data-tone", tone);
    }

    // -- Compute counts from in-memory caches --
    // dcrIssues now lives in tab-dcr-issues.js (Phase 12); read via bridge.
    // customers now lives in tab-customers.js (Phase 15); read via bridge.
    // techs     now lives in tab-techs.js     (Phase 16a); read via bridge.
    const dcrIssues = window.__pioneerAdmin.deps.getDcrIssues();
    const customers = window.__pioneerAdmin.deps.getCustomers();
    const techs     = window.__pioneerAdmin.deps.getTechs();
    const newIssues = dcrIssues.filter(function (it) {
      return (it.status || "new") === "new";
    }).length;
    const openSupply = supplyRequests.filter(function (r) {
      return (r.status || "new") !== "closed";
    }).length;
    const emailOff = customers.filter(function (c) {
      return getActive(c) && getDcrEmailEnabled(c) === false;
    }).length;
    const needsAssign = techs.filter(function (t) {
      const assigned = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
      return getActive(t) && assigned.length === 0;
    }).length;

    // "Customer links active" = active customers with DCR email
    // enabled AND at least one recipient configured. This is the
    // count of customers we're actually able to deliver to. Failing
    // either gate (opt-out OR no recipient) drops them from the
    // active count.
    const linksActive = customers.filter(function (c) {
      if (!getActive(c))                  return false;
      if (getDcrEmailEnabled(c) === false) return false;
      const recipients = Array.isArray(c.dcrEmailRecipients)
        ? c.dcrEmailRecipients
        : (Array.isArray(c.dcr_email_recipients) ? c.dcr_email_recipients : []);
      if (recipients.some(function (e) { return typeof e === "string" && e.trim(); })) return true;
      const single = c.customer_email || c.primaryEmail || c.primary_email || c.email || "";
      return !!String(single || "").trim();
    }).length;

    // -- Paint the 4 cache-driven KPIs (lower strip, unchanged) --
    paintCount("attn-new-issues",   newIssues,   newIssues   > 0 ? "attention" : "positive");
    paintCount("attn-open-supply",  openSupply,  openSupply  > 0 ? "attention" : "positive");
    paintCount("attn-email-off",    emailOff,    emailOff    > 0 ? "attention" : "positive");
    paintCount("attn-needs-assign", needsAssign, needsAssign > 0 ? "attention" : "positive");

    // -- Paint Inspections This Week (async-loaded; render whatever we know) --
    const inspEl = $("attn-inspections-week");
    if (inspEl) {
      if (inspectionsThisWeekCount == null) {
        inspEl.textContent = "—";
        const card = inspEl.closest(".kpi-card");
        if (card) card.setAttribute("data-tone", "neutral");
      } else {
        inspEl.textContent = String(inspectionsThisWeekCount);
        const card = inspEl.closest(".kpi-card");
        if (card) card.setAttribute("data-tone",
          inspectionsThisWeekCount > 0 ? "positive" : "neutral");
      }
    }

    // -- Today's Operations card --
    // Compute ops-day-windowed counts from in-memory caches. These
    // sit alongside the Firestore-derived counts in dayHealthOps.
    function tsMs(t) {
      if (!t) return 0;
      if (typeof t.toMillis === "function") return t.toMillis();
      if (typeof t.seconds  === "number")   return t.seconds * 1000;
      if (typeof t === "number") return t;
      if (typeof t === "string") { const x = Date.parse(t); return isNaN(x) ? 0 : x; }
      return 0;
    }
    function inWindow(ms, startMs, endMs) {
      return ms >= startMs && ms < endMs;
    }
    const win = (dayHealthOps && dayHealthOps.window) || getOpsDayWindow(new Date());
    const cs = win.currentOpsStart.getTime(),  ce = win.currentOpsEnd.getTime();
    const ps = win.previousOpsStart.getTime(), pe = win.previousOpsEnd.getTime();

    // dcrIssues was already locally rebound at the top of refreshAttentionStrip;
    // reused here in the same function scope.
    const newIssuesCurrent  = dcrIssues.filter(function (it) { return inWindow(tsMs(it.createdAt), cs, ce); }).length;
    const newIssuesPrevious = dcrIssues.filter(function (it) { return inWindow(tsMs(it.createdAt), ps, pe); }).length;
    const supplyCurrent     = supplyRequests.filter(function (r) { return inWindow(tsMs(r.createdAt), cs, ce); }).length;
    const supplyPrevious    = supplyRequests.filter(function (r) { return inWindow(tsMs(r.createdAt), ps, pe); }).length;

    refreshAdminDayHealth({
      // Cache-derived attention KPIs (cumulative, unchanged):
      openSupply:       openSupply,
      emailOff:         emailOff,
      needsAssign:      needsAssign,
      linksActive:      linksActive,
      // Ops-day-windowed counters:
      window:           win,
      metricsLoaded:    dayHealthOps.loaded,
      metricsError:     dayHealthOps.queryError,
      newIssues:        newIssuesCurrent,
      current: {
        newIssues:    newIssuesCurrent,
        emailsSent:   dayHealthOps.current.emailsSent,
        emailsFailed: dayHealthOps.current.emailsFailed,
        feedback:     dayHealthOps.current.feedback,
        callOuts:     dayHealthOps.current.callOuts,
        supply:       supplyCurrent
      },
      previous: {
        newIssues:    newIssuesPrevious,
        emailsSent:   dayHealthOps.previous.emailsSent,
        emailsFailed: dayHealthOps.previous.emailsFailed,
        feedback:     dayHealthOps.previous.feedback,
        callOuts:     dayHealthOps.previous.callOuts,
        supply:       supplyPrevious
      },
      // Legacy aliases for the existing render code paths in
      // refreshAdminDayHealth — preserves call-site stability.
      emailsSent24h:    dayHealthOps.current.emailsSent,
      emailsFailed24h:  dayHealthOps.current.emailsFailed,
      feedback24h:      dayHealthOps.current.feedback
    });
  }

  /* ---------- Today's Operations card ----------
     V6 — native PioneerOps DCR pipeline metrics, no Zapier. Headline
     stat row + four operational bullets. Card tone:
       healthy   — emails sent today, no failures, no new issues
       attention — any DCR email failure in the last 24h OR new issues
       neutral   — first paint before the 24h metrics finish loading. */
  function refreshAdminDayHealth(c) {
    const card    = $("admin-day-health");
    const titleEl = $("admin-day-health-title");
    if (!card || !titleEl) return;

    // ---- Card tone + headline ----
    let status, title;
    if (!c.metricsLoaded) {
      status = "neutral";
      title  = "Loading today's DCR pipeline metrics…";
    } else if (c.emailsFailed24h > 0) {
      status = "attention";
      title  = c.emailsFailed24h + " DCR email " +
               (c.emailsFailed24h === 1 ? "failure" : "failures") +
               " in the last 24h — review the Recent DCRs tab.";
    } else if (c.newIssues > 0 || c.needsAssign > 0) {
      status = "attention";
      const bits = [];
      if (c.newIssues   > 0) bits.push(c.newIssues + " new issue"   + (c.newIssues   === 1 ? "" : "s"));
      if (c.needsAssign > 0) bits.push(c.needsAssign + " tech"      + (c.needsAssign === 1 ? "" : "s") + " unassigned");
      title = bits.join(" · ");
    } else if (c.emailsSent24h > 0) {
      status = "healthy";
      title  = "DCR pipeline healthy — " + c.emailsSent24h + " " +
               (c.emailsSent24h === 1 ? "email" : "emails") +
               " delivered in the last 24h.";
    } else {
      status = "healthy";
      title  = "DCR pipeline standing by — no sends in the last 24h.";
    }
    card.setAttribute("data-status", status);
    titleEl.textContent = title;

    // ---- Headline stat row ----
    setText("admin-day-health-stat-new-issues",  c.newIssues);
    setText("admin-day-health-stat-emails-sent", c.metricsLoaded ? c.emailsSent24h : "—");
    // Failures tile: only unhide when we have a non-zero count. The
    // empty state of this card should read calm.
    const failWrap  = $("admin-day-health-stat-failures-wrap");
    const failValEl = $("admin-day-health-stat-failures");
    if (failWrap && failValEl) {
      if (c.metricsLoaded && c.emailsFailed24h > 0) {
        failValEl.textContent = String(c.emailsFailed24h);
        failWrap.hidden = false;
      } else {
        failWrap.hidden = true;
      }
    }

    // ---- Dashboard bullets ----
    const liLinks     = $("admin-day-health-li-links");
    const liDelivered = $("admin-day-health-li-delivered");
    const liFailures  = $("admin-day-health-li-failures");
    const liFeedback  = $("admin-day-health-li-feedback");

    if (liLinks) {
      liLinks.setAttribute("data-state", c.linksActive > 0 ? "ok" : "watch");
      liLinks.textContent = c.linksActive + " customer link" +
        (c.linksActive === 1 ? "" : "s") + " active";
    }
    if (liDelivered) {
      liDelivered.setAttribute("data-state",
        c.metricsLoaded ? (c.emailsSent24h > 0 ? "ok" : "neutral") : "neutral");
      liDelivered.textContent = (c.metricsLoaded ? c.emailsSent24h : "—") +
        " DCR email" + (c.emailsSent24h === 1 ? "" : "s") + " delivered · 24h";
    }
    if (liFailures) {
      liFailures.setAttribute("data-state",
        c.metricsLoaded ? (c.emailsFailed24h === 0 ? "ok" : "block") : "neutral");
      liFailures.textContent = (c.metricsLoaded ? c.emailsFailed24h : "—") +
        " DCR email failure" + (c.emailsFailed24h === 1 ? "" : "s") + " · 24h";
    }
    if (liFeedback) {
      liFeedback.setAttribute("data-state",
        c.metricsLoaded ? "ok" : "neutral");
      liFeedback.textContent = (c.metricsLoaded ? c.feedback24h : "—") +
        " customer feedback message" + (c.feedback24h === 1 ? "" : "s") + " · ops day";
    }
    if (liDelivered) {
      // Update label wording from "· 24h" → "· ops day" so it reflects
      // the new window. (Re-run after the original assignment above so
      // the suffix sticks no matter which branch set the count.)
      liDelivered.textContent = (c.metricsLoaded ? c.emailsSent24h : "—") +
        " DCR email" + (c.emailsSent24h === 1 ? "" : "s") + " delivered · ops day";
    }
    if (liFailures) {
      liFailures.textContent = (c.metricsLoaded ? c.emailsFailed24h : "—") +
        " DCR email failure" + (c.emailsFailed24h === 1 ? "" : "s") + " · ops day";
    }

    // ---- Ops-day window caption ----
    const capEl = $("admin-day-health-window");
    if (capEl) {
      const lbl = c.window && c.window.opsDayLabel;
      capEl.textContent = lbl || "";
      capEl.hidden = !lbl;
    }

    // ---- Previous Ops Day summary row ----
    // Small muted strip beneath the bullets. Hidden until metrics
    // load so we don't show a placeholder "Yesterday: 0 / 0 / 0 ..."
    // line at first paint. The <details> wrapper keeps the dashboard
    // compact — admins expand when they want to compare.
    const prevDetails = $("admin-day-health-prev");
    const prevSummary = $("admin-day-health-prev-summary");
    if (prevDetails && prevSummary && c.metricsLoaded && c.previous) {
      const p = c.previous;
      prevSummary.textContent =
        p.newIssues   + (p.newIssues   === 1 ? " issue · "    : " issues · ") +
        p.emailsSent  + (p.emailsSent  === 1 ? " DCR · "      : " DCRs · ") +
        p.emailsFailed + (p.emailsFailed === 1 ? " failure · " : " failures · ") +
        p.callOuts    + (p.callOuts    === 1 ? " call-out · " : " call-outs · ") +
        p.feedback    + (p.feedback    === 1 ? " feedback · " : " feedback · ") +
        p.supply      + (p.supply      === 1 ? " supply request" : " supply requests");
      prevDetails.hidden = false;
    } else if (prevDetails) {
      prevDetails.hidden = true;
    }
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  /* ---------- Inspections this week (lightweight async load) ----------
     One-shot count of inspections.inspected_at >= 7 days ago. Cached for
     the page lifetime; doesn't refresh on each tab change. Soft-fails
     so the rest of the admin keeps working even if this query is
     rejected by rules in some future change. */
  async function loadInspectionsThisWeekCount() {
    try {
      const db = firebase.firestore();
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const ts = firebase.firestore.Timestamp.fromDate(weekAgo);
      // .limit(500) caps the read cost on high-volume orgs; even at
      // 500 inspections/week the .size count is accurate.
      const snap = await db.collection("inspections")
        .where("inspected_at", ">=", ts)
        .limit(500)
        .get();
      inspectionsThisWeekCount = snap.size;
    } catch (err) {
      console.warn("[admin/ops] inspections-this-week query failed", err && err.code || err);
      inspectionsThisWeekCount = 0;
    }
    refreshAttentionStrip();
  }

  function wireAttentionStrip() {
    const strip = $("attention-strip");
    if (!strip) return;
    strip.addEventListener("click", function (ev) {
      // Find the closest interactive KPI card. `inspections-week` is an
      // <a href="/inspections.html"> — let the default navigation happen
      // (no preventDefault). Buttons use data-attention to drive
      // activateTab and inline filters.
      const tile = ev.target.closest(".kpi-card[data-attention]");
      if (!tile) return;
      if (tile.tagName === "A") return;   // anchor → let browser navigate
      const which = tile.dataset.attention;
      switch (which) {
        case "new-issues":
          activateTab("issues");
          // Issues tab now owns its filter state — Phase 12.
          window.__pioneerAdmin.tabs.dcrIssues.setFilter("new");
          break;
        case "open-supply":
          activateTab("supply");
          break;
        case "email-off":
          activateTab("customers");
          break;
        case "needs-assign":
          activateTab("techs");
          break;
      }
    });
  }

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
    const cs = $("customer-search");
    const ts = $("tech-search");
    const ds = $("dcr-search");

    // Delegated to applyCurrentCustomerFilter / applyCurrentTechFilter so that
    // both the search-input handler AND the post-save row refresh use the same
    // filter logic (avoids "save → re-render → search query forgotten").
    if (cs) cs.addEventListener("input", function () { window.__pioneerAdmin.tabs.customers.applyFilter(); });
    if (ts) ts.addEventListener("input", function () { window.__pioneerAdmin.tabs.techs.applyFilter(); });

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
      loadSupplyRequests();
      window.__pioneerAdmin.tabs.dcrIssues.refresh();
      loadAnnouncements();
      loadAdmins();
      window.__pioneerAdmin.tabs.customerNotes.refresh();
      window.__pioneerAdmin.tabs.noteSuggestions.refresh();
      window.__pioneerAdmin.tabs.serviceRecoveries.refresh();
      // Phase 2 ops overview — single async count for the
      // "Inspections This Week" KPI. Soft-fails; doesn't block.
      loadInspectionsThisWeekCount();
      // V6 — Today's Operations card. Two parallel queries against
      // dcr_email_payloads + customer_feedback for the 24h window.
      // Soft-fails; the card stays in its "loading" / "—" state if
      // the query is rejected.
      refreshDayHealthMetrics24h();
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

  function getCurrentAdminEmail() {
    const u = firebase.auth().currentUser;
    return (u && u.email) || "unknown";
  }

  // ---- Admin-write error handling ----
  //
  // Centralized so the four catch blocks (customer save, customer archive,
  // tech save, tech archive) all produce:
  //   • a console.error with the full err + the code + the message broken
  //     out so devs can read it without expanding the object,
  //   • an actionable user-facing message — `permission-denied` specifically
  //     calls out the most common cause (rules not redeployed since the
  //     admin-write block was added),
  //   • a modal error string (when an editing modal is open),
  //   • a toast on top of everything else so the failure is unmissable.
  function handleAdminWriteError(err, opts) {
    opts = opts || {};
    const code    = (err && err.code)    || "";
    const message = (err && err.message) || (err && String(err)) || "Unknown error";

    // Log every shape of the error so DevTools shows them at a glance.
    console.error("[admin write failed]", opts.context || "", err);
    if (code)    console.error("  • Firebase code:   ", code);
    if (message) console.error("  • Firebase message:", message);

    let friendly = message;
    if (code === "permission-denied") {
      friendly =
        "Permission denied. Two common causes:\n" +
        "  1. firestore.rules wasn't redeployed since the admin-write rules " +
        "were added. Run `firebase deploy --only firestore:rules`.\n" +
        "  2. Your signed-in email isn't on the allowlist in " +
        "isPioneerAdmin() inside firestore.rules.";
    } else if (code === "not-found") {
      friendly = "Doc not found — refresh the page and try again.";
    } else if (code === "unauthenticated") {
      friendly = "Sign-in expired — sign out and back in.";
    } else if (code === "failed-precondition") {
      friendly = "Save rejected: " + message + " (Firestore: " + code + ").";
    }

    if (opts.modalId) setModalError(opts.modalId, friendly);
    showToast("err", "Save failed" + (code ? " — " + code : "") + ". See console for details.");
    return friendly;
  }

  // ---- Toast ----
  /* openModal, closeModal, showToast moved to public/admin/_shell.js
     (Phase 6a) — imported via the top-of-IIFE shell destructure. */

  /* ---------- Row overflow menu (action-rail popover) ----------
     Used by cleaning_tech rows to collapse Promote / Archive / Delete
     into a single [More ▾] trigger. State lives entirely in the DOM —
     `aria-expanded` on the trigger + `hidden` on the menu — so the
     toggle is idempotent regardless of which row repainted last. */
  function closeAllRowOverflowMenus(exceptTrigger) {
    document.querySelectorAll(".row-overflow").forEach(function (wrap) {
      const trigger = wrap.querySelector(".row-btn-more");
      const menu    = wrap.querySelector(".row-overflow-menu");
      if (!trigger || !menu) return;
      if (exceptTrigger && trigger === exceptTrigger) return;
      trigger.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    });
  }
  function toggleRowOverflow(triggerBtn) {
    const wrap = triggerBtn.closest(".row-overflow");
    if (!wrap) return;
    const menu = wrap.querySelector(".row-overflow-menu");
    if (!menu) return;
    const open = triggerBtn.getAttribute("aria-expanded") === "true";
    // Close any others first so only one popover is open at a time.
    closeAllRowOverflowMenus(triggerBtn);
    triggerBtn.setAttribute("aria-expanded", open ? "false" : "true");
    menu.hidden = open;
  }
  // Install once at boot. Captures outside-clicks AND the Escape key.
  function installOverflowMenuOutsideClose() {
    document.addEventListener("click", function (ev) {
      // If the click landed inside a .row-overflow, leave it alone —
      // the row-list delegator handles toggling/closing.
      if (ev.target.closest && ev.target.closest(".row-overflow")) return;
      closeAllRowOverflowMenus();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeAllRowOverflowMenus();
    });
  }

  // Per-modal save button + error element IDs. Keyed by the modal's
  /* =====================================================================
     Announcements (v1) — admin CRUD
     =====================================================================
     Single collection `announcements`. Admins compose / edit / archive.
     Staff read via Pioneer Team Hub (team-hub.js handles the staff side
     + the mandatory-modal pop). Reads are tracked in announcement_reads
     keyed `{announcementId}_{uid}`. */

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

  // Local Pacific-style timestamp formatter for announcement starts/expires
  // meta. The original dcrTsToFmt now lives inside tab-dcr-issues.js
  // (Phase 12); this is a private copy used only by the Announcements
  // module (still in admin.js). Same shape — promoted to utils when
  // Announcements is extracted.
  function announcementTsToFmt(ts) {
    const ms = tsToMs(ts);
    if (ms == null) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
           " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  async function loadAnnouncements() {
    setStatus("announcements", "loading");
    try {
      const snap = await db.collection("announcements")
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

  // Convert a Firestore Timestamp / Date / ISO string to YYYY-MM-DDTHH:mm
  // for <input type="datetime-local">. Returns "" for null/missing.
  function tsToLocalInputValue(ts) {
    const ms = supplyTsToMs(ts);
    if (ms == null) return "";
    const d = new Date(ms);
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
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
    for (let i = 0; i < (techs || []).length; i++) {
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
        for (let i = 0; i < (techs || []).length; i++) {
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
    const expected = type === "selected"
      ? (Array.isArray(a.recipientTechSlugs) ? a.recipientTechSlugs.length : 0)
      : (techs || []).filter(function (t) { return t.active !== false; }).length;

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
    let badge = "";
    if (!ackReady) {
      badge = '<span class="ann-status-badge ann-status-badge-await">Awaiting acknowledgement</span>';
    } else if (!replyReady) {
      badge = '<span class="ann-status-badge ann-status-badge-await">Awaiting reply</span>';
    } else if (a.requireAcknowledgement || a.requireReply) {
      badge = '<span class="ann-status-badge ann-status-badge-done">All responses complete</span>';
    }

    return '<div class="announcement-status-summary" data-status-for="' + escapeHtml(a.id) + '">' +
             '<span class="ann-status-counts">' +
               'Status: ' +
               '<strong>' + stillUnread + '</strong> unread &middot; ' +
               '<strong>' + counts.viewed + '</strong> viewed &middot; ' +
               '<strong>' + counts.acknowledged + '</strong> acknowledged &middot; ' +
               '<strong>' + counts.replied + '</strong> replied' +
             '</span>' +
             badge +
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

  // Map an uploaded file's content-type/name to one of our enum values.
  function inferAttachmentType(file) {
    const ct = (file && file.type || "").toLowerCase();
    if (ct === "application/pdf") return "pdf";
    if (ct.indexOf("image/") === 0) return "image";
    // Office docs + everything else → "other" (admin can change in the
    // dropdown if they want to tag a schedule/safety doc explicitly).
    return "other";
  }

  // Track the currently-uploaded file's storage path so a subsequent
  // Remove or replace can delete the previous blob. Reset on modal open.
  let pendingAttachmentStoragePath = "";
  // Pre-allocated announcement doc ID for CREATE mode. Needed before
  // any upload so the storage path can include it. For EDIT mode this
  // is the existing announcement ID, set when the modal opens.
  let pendingAnnouncementId = "";

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

  function openAnnouncementCreateModal() {
    const modal = $("announcement-edit-modal");
    if (modal) modal.dataset.mode = "create";
    const title = $("announcement-modal-title");
    if (title) title.textContent = "New announcement";

    // Pre-allocate a Firestore ID so attachment uploads can use a stable
    // storage path BEFORE the admin clicks Save. If they cancel without
    // saving, any uploaded file becomes an orphan — acceptable for v1.
    pendingAnnouncementId = db.collection("announcements").doc().id;
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
      await db.collection("announcements").doc(a.id).update(updates);
      showToast("ok", isArchiving ? "Announcement archived." : "Announcement reactivated.");
      await loadAnnouncements();
    } catch (err) {
      handleAdminWriteError(err, { context: "announcement archive" });
    }
  }

  /* --------------------------------------------------------------------
   * Targeted-announcement helpers (recipient picker + thread panel)
   * ------------------------------------------------------------------ */
  let _annTechBySlug = Object.create(null);
  let _annSelectedSlugs = new Set();

  function resetAnnouncementRecipientPicker(initialSlugs) {
    _annSelectedSlugs = new Set(Array.isArray(initialSlugs) ? initialSlugs : []);
    // Refresh tech directory from the existing admin-page cache.
    _annTechBySlug = Object.create(null);
    (techs || []).forEach(function (t) {
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
    const items = (techs || [])
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

  const _annThreadUnsubs = Object.create(null);
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
    const annRef = db.collection("announcements").doc(a.id);
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
      : (techs || []).filter(function (t) { return t.active !== false; }).map(function (t) { return t.tech_slug || t.id; });
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
      await db.collection("announcements").doc(a.id).collection("comments").add({
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

  /* ===================================================================
     Admins module — runtime-editable allowlist (/admins/{email})
     ===================================================================
     The four hardcoded root admins in ALLOWED_ADMIN_EMAILS still always
     have access (firestore.rules + verifyStaffOrReject() both consult
     them first). This panel manages OPERATIONAL admins added by a root
     admin — without a code/rules redeploy.

     Server-side createAdminLoginV1 creates the Firebase Auth user AND
     writes /admins/{email}. Edit and reactivate paths write directly
     to Firestore (gated by isPioneerAdmin() in rules). Resend invite
     calls sendPasswordResetV1.
     =================================================================== */

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

    // Root admins are read-only from this panel (they're managed in
    // ALLOWED_ADMIN_EMAILS source). Operational admins get Edit + Resend.
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
    // Suppress a root stub if the same email already has a Firestore
    // /admins doc — avoid double-listing.
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
      const snap = await db.collection("admins").get();
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
      await db.collection("admins").doc(id).update({
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

  /* ---------- Promote tech to admin ---------- */

  // Triggered from the "Promote to Admin" button on a cleaning-tech
  // row. Confirms with the office, calls createAdminLoginV1 with the
  // tech's display_name/email/phone and provenance flags, fires the
  // client-side Firebase reset email for reliable delivery, and
  // refreshes the Admins tab. The cleaning_techs doc is NOT touched —
  // the user keeps both roles unless an admin later archives the tech.
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

  /* ---------- Resend invite (admin row + tech row) ---------- */

  // Calls sendPasswordResetV1. emailLower is the lowercased email of the
  // user receiving the reset. `feedbackEl` is an optional element to
  // display the inline message.
  //
  // Admin-context behavior (NOT anti-enumerated). The Forgot-password
  // flow on the public sign-in pages is anti-enumerated server-side —
  // that's where the security boundary matters. Here, an admin clicked
  // Resend on a known row and needs to know if the action actually
  // worked. We distinguish:
  //   • server { ok:true, sent:true }  → success — reset email sent
  //   • server { ok:true, sent:false } → blocked (no Firebase Auth user
  //     for this email yet; admin needs the Add tech / Login setup flow)
  //   • server { ok:false } or fetch error → surface the server code so
  //     support can pattern-match.
  // Then we fire firebase.auth().sendPasswordResetEmail() from the
  // browser too — the Web SDK is what actually triggers the hosted
  // Firebase email. The server's generatePasswordResetLink() only
  // returns a link; it doesn't deliver mail. If the Web SDK send fails
  // we warn but don't error-out, since the server-returned reset_link
  // is a usable backup the admin can copy/share.
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
    let httpStatus = 0;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ email: emailLower })
      });
      httpStatus = res.status;
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

      // V6 — the server now AUTO-CREATES the Auth user when missing,
      // so the `sent: false, reason: "no_auth_user"` branch is no
      // longer expected on the happy path. Kept as a safety net so a
      // future server change that returns it still surfaces cleanly.
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

    // Fire the Web SDK email — this is the path that actually triggers
    // Firebase's hosted template email. Track it explicitly so we can
    // tell the admin if it failed AND they should fall back to the
    // server-returned backup link.
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
      // V6 — different wording for first-time invite vs reinvite.
      // body.created_auth_user is true when the server just provisioned
      // a new Firebase Auth user for this email; otherwise the user
      // already existed and we just nudged a fresh reset link.
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

  // outer element ID. Adding a new modal? Add an entry here and the
  // generic helpers below work without further branching.
  const MODAL_REGISTRY = {
    "customer-edit-modal":      { saveBtnId: "customer-edit-save",      errId: "customer-edit-err",      savingLabel: "Saving…",   defaultLabel: "Save" },
    "tech-edit-modal":          { saveBtnId: "tech-edit-save",          errId: "tech-edit-err",          savingLabel: "Saving…",   defaultLabel: "Save" },
    "tech-create-modal":        { saveBtnId: "tech-create-save",        errId: "tech-create-err",        savingLabel: "Creating…", defaultLabel: "Create login" },
    "announcement-edit-modal":  { saveBtnId: "announcement-edit-save",  errId: "announcement-edit-err",  savingLabel: "Saving…",   defaultLabel: "Save" },
    "admin-create-modal":       { saveBtnId: "admin-create-save",       errId: "admin-create-err",       savingLabel: "Creating…", defaultLabel: "Create admin login" },
    "admin-edit-modal":         { saveBtnId: "admin-edit-save",         errId: "admin-edit-err",         savingLabel: "Saving…",   defaultLabel: "Save changes" },
    "note-edit-modal":          { saveBtnId: "note-edit-save",          errId: "note-edit-err",          savingLabel: "Saving…",   defaultLabel: "Save" },
    "suggestion-review-modal":  { saveBtnId: "suggestion-approve",      errId: "suggestion-review-err",  savingLabel: "Saving…",   defaultLabel: "Approve" },
    "recovery-edit-modal":      { saveBtnId: "recovery-edit-save",      errId: "recovery-edit-err",      savingLabel: "Saving…",   defaultLabel: "Save" }
  };

  function setModalSaving(modalId, saving) {
    const reg = MODAL_REGISTRY[modalId];
    if (!reg) return;
    const btn = $(reg.saveBtnId);
    if (!btn) return;
    btn.disabled = saving;
    btn.textContent = saving ? reg.savingLabel : reg.defaultLabel;
  }
  function setModalError(modalId, msg) {
    const reg = MODAL_REGISTRY[modalId];
    if (!reg) return;
    const errEl = $(reg.errId);
    if (!errEl) return;
    if (msg) { errEl.textContent = msg; errEl.hidden = false; }
    else     { errEl.hidden = true; errEl.textContent = ""; }
  }

  // ---- Customer: edit ----

  /* openCustomerEditModal + populateCustomerSopBlock moved to
     public/admin/tab-customers.js (Phase 15). populateCustomerDeputyIntegration
     below STAYS in admin.js because it reads deputyMappingShifts +
     toMillis + fmtLastSeenPT from the still-in-admin Deputy module;
     the tab module reaches it via the deps bridge entry
     populateCustomerDeputyIntegration. */

  function populateCustomerDeputyIntegration(c) {
    const slug    = getCustomerSlug(c);
    const cid     = c.deputy_company_id != null && c.deputy_company_id !== ""
                      ? c.deputy_company_id
                      : c.deputy_location_id;
    const stored  = String(c.deputy_company_name || "").trim();
    const nameEl   = $("cust-edit-deputy-name");
    const idEl     = $("cust-edit-deputy-id");
    const lastEl   = $("cust-edit-deputy-last-shift");
    const srcEl    = $("cust-edit-deputy-match-source");
    const healthEl = $("cust-edit-deputy-health");
    const helpEl   = $("cust-edit-deputy-help");

    if (nameEl) nameEl.textContent = stored || "—";
    if (idEl)   idEl.textContent   = (cid != null && cid !== "") ? String(cid) : "—";

    // Walk recent cache for the most-recent shift assigned to this slug
    // (when mapping is current) OR carrying the stored Company.Id
    // (covers cases where the cache hasn't refreshed yet).
    let mostRecent = null;
    deputyMappingShifts.forEach(function (s) {
      const matches =
        (slug && s.customer_slug === slug) ||
        (cid != null && String(s.deputy_company_id || "") === String(cid));
      if (!matches) return;
      const t = toMillis(s.start_time);
      if (!mostRecent || t > (mostRecent._t || 0)) {
        mostRecent = Object.assign({ _t: t }, s);
      }
    });
    if (lastEl) {
      lastEl.textContent = mostRecent
        ? fmtLastSeenPT(mostRecent._t) +
            (mostRecent.deputy_company_name ? " · " + mostRecent.deputy_company_name : "")
        : "Not seen in last " + DEPUTY_MAPPING_LOOKBACK_DAYS + " days";
    }
    if (srcEl) {
      srcEl.textContent = mostRecent
        ? (String(mostRecent.match_source || "") +
           (mostRecent.match_confidence ? " (" + mostRecent.match_confidence + ")" : ""))
        : "—";
    }
    // Health classification mirrors the Deputy Companies pills.
    let healthLabel = "—";
    let healthClass = "";
    if (cid == null || cid === "") {
      healthLabel = "Not linked to a Deputy company";
    } else if (!getActive(c)) {
      healthLabel = "Inactive Pioneer customer";
      healthClass = "is-inactive";
    } else {
      // Look for duplicates: another active customer with same cid.
      // customers now lives in tab-customers.js (Phase 15); read via bridge.
      const customers = window.__pioneerAdmin.deps.getCustomers();
      const dupes = customers.filter(function (other) {
        if (getCustomerSlug(other) === slug) return false;
        if (!getActive(other)) return false;
        const otherCid = other.deputy_company_id != null && other.deputy_company_id !== ""
                           ? other.deputy_company_id
                           : other.deputy_location_id;
        return otherCid != null && String(otherCid) === String(cid);
      });
      if (dupes.length > 0) {
        healthLabel = "Duplicate — also claimed by " + dupes.length + " other customer" +
                      (dupes.length === 1 ? "" : "s");
        healthClass = "is-duplicate";
      } else {
        healthLabel = "Mapped (Company.Id canonical)";
        healthClass = "is-mapped";
      }
    }
    if (healthEl) {
      healthEl.innerHTML = '<span class="mapping-pill ' + escapeHtml(healthClass) + '">' +
                            escapeHtml(healthLabel) + '</span>';
    }
    // Rename note: stored name vs latest seen name.
    if (helpEl) {
      if (mostRecent && mostRecent.deputy_company_name && stored &&
          String(mostRecent.deputy_company_name).trim() !== stored) {
        helpEl.textContent = "Deputy currently sends this company as '" +
                             mostRecent.deputy_company_name +
                             "'. Matching uses Company.Id — the rename is cosmetic.";
        helpEl.hidden = false;
      } else if (cid != null && cid !== "") {
        helpEl.textContent = "Matching is keyed on Deputy Company.Id. Renaming the company in Deputy does not break this link.";
        helpEl.hidden = false;
      } else {
        helpEl.textContent = "No Deputy company linked yet. Map this customer from Admin → Deputy → Deputy Companies.";
        helpEl.hidden = false;
      }
    }
  }

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

  // Slug derived from the display name field. Matches the server-side
  // slugifyForTech() shape so the field acts as a true preview.
  function slugifyForTech(s) {
    return String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  /* resetTechCreateModal + openTechCreateModal + onTechCreateSave moved
     to public/admin/tab-techs.js (Phase 16a). Callers use
     window.__pioneerAdmin.tabs.techs.openCreateModal /
     onSaveCreate. */
  // input if the Clipboard API isn't available (e.g. older Safari).
  async function copyInputValue(inputId, btnId) {
    const input = $(inputId);
    const btn   = $(btnId);
    if (!input) return;
    const val = input.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(val);
      } else {
        input.focus();
        input.select();
        document.execCommand && document.execCommand("copy");
      }
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = orig; }, 1500);
      }
    } catch (e) {
      console.warn("clipboard write failed", e);
      input.focus(); input.select();
    }
  }

  /* ---------- DCR email Review & Send (dcr-email-review-modal) ----------
   *
   * V6 pilot. Calls getDcrEmailReadinessV1 with an admin ID token,
   * renders blockers/warnings + a readiness checklist, and enables
   * the Send button only when the DCR is ready (or the operator
   * clicks Resend on an already-sent DCR).
   *
   * Send button hits the same generateAndSendDcrEmailV1 endpoint the
   * old token-based test loop used; that endpoint now ALSO runs the
   * readiness check server-side, so even a stale UI can't push a
   * not-ready DCR through.
   */
  let _dcrReviewCurrentDcrId = null;
  let _dcrReviewLastReadiness = null;

  async function openDcrReviewModal(dcr) {
    if (!dcr) return;
    const dcrId = dcr.submission_id || dcr.id;
    _dcrReviewCurrentDcrId  = dcrId;
    _dcrReviewLastReadiness = null;

    // Reset the modal to a loading state every time it opens. Avoids
    // showing stale data from the previous DCR while the new readiness
    // check is in flight.
    const titleEl   = $("dcr-review-title");
    const subTextEl = $("dcr-review-subtitle");
    if (titleEl)   titleEl.textContent   = "Review DCR email";
    if (subTextEl) subTextEl.textContent = (dcr.customer_name || "—") + " · " +
                                           (dcr.tech_display_name || "—") + " · " +
                                           (dcr.clean_date || "");
    setDcrReviewBody('<p class="dcr-review-loading">Running readiness check…</p>');
    setDcrReviewError("");
    setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: true });
    setDcrReviewResendButton({ disabled: true, visible: false });
    openModal("dcr-email-review-modal");

    await refreshDcrReviewReadiness("send");
  }

  async function refreshDcrReviewReadiness(mode) {
    const dcrId = _dcrReviewCurrentDcrId;
    if (!dcrId) return;
    const url = (window.GET_DCR_EMAIL_READINESS_URL || "").trim();
    if (!url) {
      setDcrReviewError("GET_DCR_EMAIL_READINESS_URL not configured in firebase-config.js.");
      return;
    }
    let idToken;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      setDcrReviewError("You appear to be signed out. Refresh and sign in again.");
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body:   JSON.stringify({ dcrId: dcrId, mode: mode || "send" })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        setDcrReviewError((data && data.error) || ("HTTP " + res.status));
        return;
      }
      _dcrReviewLastReadiness = data;
      renderDcrReviewReadiness(data);
    } catch (e) {
      setDcrReviewError(String(e && e.message || e));
    }
  }

  function renderDcrReviewReadiness(r) {
    // The readiness JSON has the shape:
    //   { ready, blockers[], warnings[], resolved }
    // We turn it into a labeled checklist + blocker/warning lists +
    // a "what the customer will see" summary block. The Send button
    // is only enabled when ready === true. When the only blocker is
    // already_sent, the Resend button replaces Send.
    const resolved = r.resolved || {};
    const blockers = Array.isArray(r.blockers) ? r.blockers : [];
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    const ready    = !!r.ready;

    const checkItem = function (ok, label, detail) {
      const icon = ok ? '✓' : '○';
      const cls  = ok ? 'dcr-review-check-ok' : 'dcr-review-check-pending';
      return (
        '<li class="' + cls + '">' +
          '<span class="dcr-review-check-icon">' + icon + '</span>' +
          '<span class="dcr-review-check-label">' + escapeHtml(label) + '</span>' +
          (detail ? ('<span class="dcr-review-check-detail">' + escapeHtml(detail) + '</span>') : '') +
        '</li>'
      );
    };

    const recipients = Array.isArray(resolved.emailRecipients) ? resolved.emailRecipients : [];
    const recipientsLine = recipients.length
      ? recipients.join(", ")
      : "(none on file)";

    const checklistHtml =
      '<ul class="dcr-review-checklist" role="list">' +
        checkItem(!!resolved.customerId,          "Customer resolved",        resolved.customerName || "") +
        checkItem(recipients.length > 0,          "Email recipient(s)",        recipientsLine) +
        checkItem(!!resolved.techId,              "Tech resolved",             resolved.techName || "") +
        checkItem(!!resolved.hasTechPhoto,        "Tech profile photo",        resolved.hasTechPhoto ? "on file" : "missing — initials fallback") +
        checkItem(!!resolved.hasSignature,        "Off-site signature",        resolved.hasSignature ? "captured" : "missing") +
        checkItem(resolved.photoCount > 0,        "After photos",              (resolved.photoCount || 0) + " on file") +
        checkItem(true,                            "Issue tier",                String(resolved.issueTier || "green").toUpperCase()) +
      '</ul>';

    let blockersHtml = "";
    if (blockers.length) {
      blockersHtml =
        '<div class="dcr-review-issues dcr-review-issues-block">' +
          '<div class="dcr-review-issues-title">Blockers — must resolve before send</div>' +
          '<ul>' +
            blockers.map(function (b) {
              return '<li><strong>' + escapeHtml(b.code) + '</strong>: ' + escapeHtml(b.message) + '</li>';
            }).join("") +
          '</ul>' +
        '</div>';
    }
    let warningsHtml = "";
    if (warnings.length) {
      warningsHtml =
        '<div class="dcr-review-issues dcr-review-issues-warn">' +
          '<div class="dcr-review-issues-title">Warnings — send anyway is OK</div>' +
          '<ul>' +
            warnings.map(function (w) {
              return '<li><strong>' + escapeHtml(w.code) + '</strong>: ' + escapeHtml(w.message) + '</li>';
            }).join("") +
          '</ul>' +
        '</div>';
    }

    let alreadySentHtml = "";
    if (resolved.emailStatus === "sent") {
      alreadySentHtml =
        '<div class="dcr-review-already-sent">' +
          '<div class="dcr-review-issues-title">Previously sent</div>' +
          '<div>' + escapeHtml(resolved.lastSentAt || "") + '</div>' +
          (resolved.lastSentTo ? ('<div style="margin-top:4px;color:var(--pc-text-muted);">To: ' + escapeHtml(resolved.lastSentTo) + '</div>') : '') +
        '</div>';
    }

    setDcrReviewBody(checklistHtml + blockersHtml + warningsHtml + alreadySentHtml);

    // Send/Resend button state. Three cases:
    //   1. ready          → Send enabled, Resend hidden
    //   2. only blocker is already_sent → Send hidden, Resend enabled
    //   3. other blockers → Send disabled, Resend hidden
    const onlyAlreadySentBlocker = blockers.length === 1 && blockers[0].code === "already_sent";
    if (ready) {
      setDcrReviewSendButton({ disabled: false, label: "Send Customer DCR Email", visible: true });
      setDcrReviewResendButton({ disabled: true, visible: false });
    } else if (onlyAlreadySentBlocker) {
      setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: false });
      setDcrReviewResendButton({ disabled: false, visible: true });
    } else {
      setDcrReviewSendButton({ disabled: true, label: "Send Customer DCR Email", visible: true });
      setDcrReviewResendButton({ disabled: true, visible: false });
    }
  }

  function setDcrReviewBody(html) {
    const el = $("dcr-review-body");
    if (el) el.innerHTML = html;
  }
  function setDcrReviewError(msg) {
    const el = $("dcr-review-err");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = ""; el.hidden = true; }
  }
  function setDcrReviewSendButton(opts) {
    const el = $("dcr-review-send");
    if (!el) return;
    el.disabled = !!opts.disabled;
    el.hidden   = !opts.visible;
    if (opts.label) el.textContent = opts.label;
  }
  function setDcrReviewResendButton(opts) {
    const el = $("dcr-review-resend");
    if (!el) return;
    el.disabled = !!opts.disabled;
    el.hidden   = !opts.visible;
  }

  async function performDcrSend(confirmResend) {
    const dcrId = _dcrReviewCurrentDcrId;
    if (!dcrId) return;
    const url = (window.GENERATE_AND_SEND_DCR_EMAIL_URL || "").trim();
    if (!url) {
      setDcrReviewError("GENERATE_AND_SEND_DCR_EMAIL_URL not configured in firebase-config.js.");
      return;
    }
    let idToken;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      setDcrReviewError("You appear to be signed out. Refresh and sign in again.");
      return;
    }

    setDcrReviewError("");
    setDcrReviewSendButton({ disabled: true, label: "Sending…", visible: true });
    setDcrReviewResendButton({ disabled: true, visible: !!confirmResend });

    // Re-derive customerId from the readiness response. The handler
    // wants both dcrId and customerId; the readiness response is the
    // most reliable source for the customer slug.
    const customerId = (_dcrReviewLastReadiness && _dcrReviewLastReadiness.resolved &&
                        _dcrReviewLastReadiness.resolved.customerId) || "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body:   JSON.stringify({ dcrId: dcrId, customerId: customerId, confirmResend: !!confirmResend })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        setDcrReviewSendButton({ disabled: false, label: confirmResend ? "Send Customer DCR Email" : "Send Customer DCR Email", visible: !confirmResend });
        setDcrReviewResendButton({ disabled: false, visible: !!confirmResend });
        const err = (data && (data.error || (data.blockers && data.blockers.map(function (b) { return b.code; }).join(", ")))) || ("HTTP " + res.status);
        setDcrReviewError(err);
        return;
      }
      // Success — replace the body with a confirmation block.
      setDcrReviewBody(
        '<div class="dcr-review-success">' +
          '<div class="dcr-review-success-title">' +
            (data.status === "skipped" ? "Skipped — customer email disabled" : "Email sent ✓") +
          '</div>' +
          '<div><strong>To:</strong> ' + escapeHtml(data.to || "") + '</div>' +
          '<div><strong>Subject:</strong> ' + escapeHtml(data.subject || "") + '</div>' +
          (data.messageId
            ? ('<div><strong>Gmail message ID:</strong> <code>' + escapeHtml(data.messageId) + '</code></div>')
            : '') +
          (data.promptVersion ? ('<div style="color:var(--pc-text-muted);margin-top:6px;">promptVersion: ' + escapeHtml(data.promptVersion) + '</div>') : '') +
          (data.emailTemplate ? ('<div style="color:var(--pc-text-muted);">emailTemplate: ' + escapeHtml(data.emailTemplate) + '</div>') : '') +
        '</div>'
      );
      setDcrReviewSendButton({ disabled: true, label: "Sent", visible: !confirmResend });
      setDcrReviewResendButton({ disabled: true, visible: !!confirmResend });
      // Refresh the DCRs list so the row reflects the new status.
      loadDcrsAndRerenderDependents().catch(function () { /* non-fatal */ });
    } catch (e) {
      setDcrReviewSendButton({ disabled: false, label: "Send Customer DCR Email", visible: !confirmResend });
      setDcrReviewResendButton({ disabled: false, visible: !!confirmResend });
      setDcrReviewError(String(e && e.message || e));
    }
  }

  /* ---------- Tech photo / signature manager (tech-media-modal) ----------
   *
   * Calls uploadTechMediaV1 with a Firebase admin ID token. The modal
   * is wired once on first open; subsequent opens just repopulate
   * state from the latest `techs` cache entry.
   *
   * Per the spec:
   *   - Real photo is required for the customer-facing DCR trust
   *     promise; the initials bubble is an emergency fallback only.
   *   - Missing photo / signature is flagged in the modal and on the
   *     tech row chip.
   *
   * On every successful upload/clear/active flip, we patch the local
   * `techs` cache so the row, attention strip, and preview update
   * without a full Firestore re-read.
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

  // Repaint EVERY surface in the modal from a fresh tech doc. Called
  // after every successful upload/clear so the previews + chips match
  // what's actually on the cleaning_techs doc.
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
  // without a full Firestore re-read).
  function patchTechCacheAndRepaint(techId, patch) {
    // techs + techCard live in tab-techs.js (Phase 16a). The tab module
    // exposes applyPatch which patches the cache + re-renders the row.
    // The local media-modal paint + attention-strip refresh stay here.
    const updated = window.__pioneerAdmin.tabs.techs.applyPatch(techId, patch);
    if (!updated) return null;
    paintTechMediaModal(updated);
    if (typeof refreshAttentionStrip === "function") refreshAttentionStrip();
    return updated;
  }
  /* cssEsc moved to public/admin/_utils.js (Phase 4a) — imported via
     the top-of-IIFE destructure. */

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

  /* ====================================================================
     Deputy Mapping — read-only diagnostic
     ====================================================================
     Compares deputy_shift_cache for a chosen sync_date against the
     active cleaning_techs + customers caches and surfaces unmapped
     employees/locations. Suggestions are derived from normalized-name
     equality only (case-insensitive, whitespace-collapsed, ASCII-only
     alpha+digits). Nothing is auto-applied — the admin still edits the
     cleaning_techs or customers row to align.

     Loaded by admin.js when the Deputy tab opens. Reads:
       - deputy_shift_cache   (admin role-gated, full collection)
       - cleaning_techs       (already cached in module-level `techs`)
       - customers            (already cached in module-level `customers`)
     ==================================================================== */

  let deputyMappingShifts = [];
  let customerAliases     = [];   // cached /customer_aliases docs
  let showInactiveInCustomerPicker = false;   // toggled by "Show inactive" button

  // Normalize an alias for indexing + doc-id derivation. Mirrors the
  // normalizeKeySuggest() helper on the backend so the two sides
  // produce identical keys for the same input.
  function normalizeAlias(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function setDeputyMappingState(state, msg) {
    const loadEl    = $("deputy-mapping-loading");
    const errEl     = $("deputy-mapping-error");
    const emptyEl   = $("deputy-mapping-empty");
    const contentEl = $("deputy-mapping-content");
    if (loadEl)    loadEl.hidden    = state !== "loading";
    if (errEl)     errEl.hidden     = state !== "error";
    if (emptyEl)   emptyEl.hidden   = state !== "empty";
    if (contentEl) contentEl.hidden = state !== "content";
    if (state === "error" && errEl && msg) errEl.textContent = msg;
  }

  // Normalize signal slightly stronger than before: strip trailing
  // "s" so "Cleaning Tech" and "Cleaning Techs" collapse. KEEP IN SYNC
  // with normalizeKey() in functions/index.js syncDeputyShiftsCore.
  function normalizeMatchKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/s$/, "");
  }

  // ====================================================================
  // EMPLOYEE-ONLY MAPPING ARCHITECTURE
  // ====================================================================
  //
  // Deputy = who + when + official shift link.
  // PioneerOps = customer/location truth.
  //
  // The admin's only Deputy job here is to link each Deputy person
  // to a Pioneer cleaning tech (cleaning_techs.deputy_employee_*).
  // Customer mapping was removed from Deputy for the pilot: Deputy's
  // operational-unit names are unreliable ("Cleaning Techs"), so the
  // tech picks the customer on the DCR and submitDcrV1 writes
  // selected_customer_{slug,name} back onto pioneer_work_sessions.

  // Build all the indexes the renderers need, in one pass each.
  function buildMappingIndexes() {
    // techs now lives in tab-techs.js (Phase 16a); read via bridge.
    const techs = window.__pioneerAdmin.deps.getTechs();
    const techsByDeputyId           = {};
    const techsByDeputyEmail        = {};
    const techsByEmailKey           = {};
    const techsByExplicitDeputyName = {};
    const techsByDisplayNameKey     = {};
    techs.forEach(function (t) {
      if (!getActive(t)) return;
      if (t.deputy_employee_id != null && t.deputy_employee_id !== "") {
        techsByDeputyId[String(t.deputy_employee_id)] = t;
      }
      const de = String(t.deputy_employee_email || "").toLowerCase().trim();
      if (de) techsByDeputyEmail[de] = t;
      const e = String(t.email || "").toLowerCase().trim();
      if (e) techsByEmailKey[e] = t;
      const explicit = normalizeMatchKey(t.deputy_employee_name);
      if (explicit && !techsByExplicitDeputyName[explicit]) techsByExplicitDeputyName[explicit] = t;
      const display = normalizeMatchKey(getTechName(t));
      if (display && !techsByDisplayNameKey[display]) techsByDisplayNameKey[display] = t;
    });

    return {
      techsByDeputyId, techsByDeputyEmail, techsByEmailKey,
      techsByExplicitDeputyName, techsByDisplayNameKey
    };
  }

  // Resolve a single Deputy person against the current tech mappings.
  // Returns {ref, via} when mapped, null when unmapped.
  function resolveDeputyPerson(p, ix) {
    if (p.deputy_employee_id != null && ix.techsByDeputyId[String(p.deputy_employee_id)]) {
      return { ref: ix.techsByDeputyId[String(p.deputy_employee_id)], via: "id" };
    }
    const emailKey = String(p.employee_email || "").toLowerCase().trim();
    if (emailKey && ix.techsByDeputyEmail[emailKey]) return { ref: ix.techsByDeputyEmail[emailKey], via: "deputy_email" };
    if (emailKey && ix.techsByEmailKey[emailKey])    return { ref: ix.techsByEmailKey[emailKey], via: "email" };
    const nameKey = normalizeMatchKey(p.employee_display_name);
    if (nameKey && ix.techsByExplicitDeputyName[nameKey]) return { ref: ix.techsByExplicitDeputyName[nameKey], via: "deputy_name" };
    return null;
  }

  // Aggregate distinct Deputy persons seen across the loaded shifts.
  function aggregateDeputyPeople() {
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      const id = (s.deputy_employee_id != null && s.deputy_employee_id !== "")
                    ? String(s.deputy_employee_id) : "";
      const nameKey = normalizeMatchKey(s.employee_display_name);
      const key = id ? "id:" + id : (nameKey ? "name:" + nameKey : "");
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key:                       key,
          deputy_employee_id:        id ? Number(id) : null,
          employee_display_name:     s.employee_display_name || "",
          employee_email:            s.employee_email_deputy || s.employee_email || "",
          shift_count:               0,
          last_seen:                 null,
          sample_shift_url:          ""
        });
      }
      const g = byKey.get(key);
      g.shift_count += 1;
      const t = toMillis(s.start_time);
      if (t > (g.last_seen || 0)) g.last_seen = t;
      if (!g.sample_shift_url && s.deputy_shift_url) g.sample_shift_url = s.deputy_shift_url;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return (a.employee_display_name || "").localeCompare(b.employee_display_name || "");
    });
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    if (ts.toMillis) return ts.toMillis();
    if (ts.toDate)   return ts.toDate().getTime();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return 0;
  }

  function fmtLastSeenPT(ms) {
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric"
      }).format(new Date(ms));
    } catch (e) { return ""; }
  }

  // ============= Renderers =============

  function renderDeputyMappingEmployees() {
    const root = $("deputy-mapping-employees");
    if (!root) return;
    const ix = buildMappingIndexes();
    const people = aggregateDeputyPeople();
    const unmapped = people.filter(function (p) { return !resolveDeputyPerson(p, ix); });

    const totalEl = $("deputy-mapping-employees-total");
    if (totalEl) {
      totalEl.textContent = unmapped.length + " unmapped · " + people.length + " seen total";
    }

    if (unmapped.length === 0) {
      root.innerHTML =
        '<div class="dm-empty-state">' +
          '<strong>Every Deputy person seen in the last ' + DEPUTY_MAPPING_LOOKBACK_DAYS + ' days is mapped.</strong>' +
          ' New people will appear here automatically on their first shift.' +
        '</div>';
      return;
    }

    const techOptionsHtml = techs
      .filter(function (t) { return getActive(t); })
      .sort(function (a, b) { return getTechName(a).localeCompare(getTechName(b)); })
      .map(function (t) {
        return '<option value="' + escapeHtml(getTechSlug(t)) + '">' +
                 escapeHtml(getTechName(t)) +
                 (t.email ? " (" + escapeHtml(t.email) + ")" : "") +
               '</option>';
      }).join("");

    root.innerHTML = unmapped.map(function (p) {
      const nameKey   = normalizeMatchKey(p.employee_display_name);
      const suggested = nameKey ? ix.techsByDisplayNameKey[nameKey] : null;

      const dataAttrs =
        ' data-deputy-id="' + escapeHtml(p.deputy_employee_id != null ? String(p.deputy_employee_id) : "") + '"' +
        ' data-deputy-name="' + escapeHtml(p.employee_display_name || "") + '"' +
        ' data-deputy-email="' + escapeHtml(p.employee_email || "") + '"';

      const lastSeen = fmtLastSeenPT(p.last_seen);
      const openLink = p.sample_shift_url
        ? '<a class="deputy-open-link" href="' + escapeHtml(p.sample_shift_url) +
          '" target="_blank" rel="noopener">Open in Deputy ↗</a>'
        : '';

      let suggestionBlk = "";
      if (suggested) {
        suggestionBlk =
          '<div class="dm-suggestion">' +
            '<div class="dm-suggestion-text">' +
              'Suggested: <strong>' + escapeHtml(getTechName(suggested)) + '</strong> (display-name match)' +
            '</div>' +
            '<button class="dm-btn dm-btn-primary" type="button"' +
              ' data-action="apply-emp"' +
              ' data-tech-slug="' + escapeHtml(getTechSlug(suggested)) + '"' +
              dataAttrs + '>Accept suggestion</button>' +
          '</div>';
      }

      const pickerBlk =
        '<div class="dm-picker">' +
          '<label class="dm-picker-label">Map this Deputy person to a Pioneer tech (one-time):</label>' +
          '<div class="dm-picker-row">' +
            '<select class="dm-select" data-pick="emp"' + dataAttrs + '>' +
              '<option value="">— Pick a tech —</option>' + techOptionsHtml +
            '</select>' +
            '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
              ' data-action="apply-emp-pick"' +
              dataAttrs + ' disabled>Pick tech first</button>' +
          '</div>' +
        '</div>';

      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              escapeHtml(p.employee_display_name || "(no name)") +
            '</div>' +
            '<span class="mapping-pill is-unmapped">Needs mapping</span>' +
          '</div>' +
          '<div class="dm-deputy-shows">' +
            '<span class="dm-label">Deputy person:</span> ' +
            escapeHtml(p.employee_display_name || "(no name)") +
            (p.employee_email ? ' · ' + escapeHtml(p.employee_email) : '') +
          '</div>' +
          '<div class="dm-footnote">' +
            (p.deputy_employee_id != null ? 'Deputy employee ID ' + escapeHtml(String(p.deputy_employee_id)) + ' · ' : '') +
            'seen in ' + p.shift_count + ' shift' + (p.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
          '</div>' +
          (openLink ? '<div class="dm-open">' + openLink + '</div>' : '') +
          suggestionBlk +
          pickerBlk +
        '</div>'
      );
    }).join("");
  }

  // Sync status / raw diagnostics summary shown in the collapsed
  // disclosure on the admin Deputy tab. Pulls the latest last_synced_at
  // across the loaded window so admin can confirm Deputy data is fresh.
  function renderDeputyMappingSummary() {
    const el = $("deputy-mapping-summary");
    if (!el) return;
    let latest = 0;
    deputyMappingShifts.forEach(function (s) {
      const t = toMillis(s.last_synced_at);
      if (t > latest) latest = t;
    });
    const lastSync = latest
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          dateStyle: "medium", timeStyle: "short"
        }).format(new Date(latest))
      : "unknown";
    el.textContent =
      "Lookback: last " + DEPUTY_MAPPING_LOOKBACK_DAYS + " days of cached shifts " +
      "(" + deputyMappingShifts.length + " shift" + (deputyMappingShifts.length === 1 ? "" : "s") + "). " +
      "Last sync: " + lastSync + " PT. " +
      "Customer mapping was removed from Deputy for the pilot — techs pick customer on the DCR.";
  }

  const DEPUTY_MAPPING_LOOKBACK_DAYS = 14;

  async function loadDeputyMapping() {
    setDeputyMappingState("loading");
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - DEPUTY_MAPPING_LOOKBACK_DAYS);
      const cutoffDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(cutoff);
      const [shiftsSnap, aliasesSnap] = await Promise.all([
        db.collection("deputy_shift_cache")
          .where("sync_date", ">=", cutoffDate)
          .get(),
        db.collection("customer_aliases").get()
      ]);
      deputyMappingShifts = shiftsSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customerAliases = aliasesSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      // We always render — even when no Deputy shifts exist the
      // alias manager is still useful for admin curation.
      renderDeputyMappingSummary();
      renderDeputyMappingEmployees();
      renderDeputyConnectionHealth();
      renderDeputyCompanies();
      renderAliasManager();
      renderUnmappedDeputyLocations();
      if (deputyMappingShifts.length === 0 && customerAliases.length === 0) {
        setDeputyMappingState("empty");
      } else {
        setDeputyMappingState("content");
      }
    } catch (err) {
      console.error("[deputy-mapping] load failed", err);
      const msg = (err && err.code === "permission-denied")
        ? "Permission denied — only admins can read Deputy mapping data."
        : ("Couldn't load Deputy data: " + (err && err.message || "unknown"));
      setDeputyMappingState("error", msg);
    }
  }

  // ===================================================================
  // CUSTOMER ALIAS MANAGER
  // ===================================================================
  // Tally how many cached shifts in the lookback window cite a given
  // alias (via suggested_customer_source). Cheap O(N) scan since the
  // cache window is already loaded.
  function countAliasUsage(alias) {
    const normalized = normalizeAlias(alias.alias);
    const slug = String(alias.customer_slug || "").trim();
    let count = 0;
    deputyMappingShifts.forEach(function (s) {
      if (!s.suggested_customer_slug || s.suggested_customer_slug !== slug) return;
      // Source format: "code:NOTL" / "name_match:instructions" / "alias_match:location_name".
      // The bracket code path embeds the code itself in the source string;
      // text-match paths attribute by field name only. Count any source
      // where the resolved slug matches this alias's slug AND either:
      //   - the source carries the alias verbatim (code:NOTL), or
      //   - the alias is one of the customer's known keys (we accept
      //     any same-slug suggestion as "this alias contributed").
      const src = String(s.suggested_customer_source || "");
      if (!src) return;
      if (src.startsWith("code:")) {
        if (src.slice(5).toUpperCase() === String(alias.alias).toUpperCase()) {
          count += 1;
          return;
        }
      } else {
        // Text-match path — accept if the alias appears as a normalized
        // substring of any shift text field.
        const fields = [s.instructions, s.memo, s.operational_unit_memo, s.location_name, s.company_name];
        for (let i = 0; i < fields.length; i++) {
          if (normalizeAlias(fields[i]).indexOf(normalized) !== -1) { count += 1; return; }
        }
      }
    });
    return count;
  }

  // ===================================================================
  // DEPUTY COMPANIES → PIONEER CUSTOMERS (primary mapping)
  // ===================================================================
  // Aggregates distinct (deputy_company_id, deputy_company_name) pairs
  // observed on recent cache docs. For each unique Deputy company we
  // show: the Pioneer customer it's currently mapped to (via
  // customers.deputy_company_id), or an Unmapped pill + picker to map
  // it once. Mapping writes deputy_company_id + deputy_company_name
  // to the chosen customer doc; next sync auto-resolves every shift
  // for that company at matchSource="deputy_company_id", confidence="exact".

  function aggregateDeputyCompanies() {
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      const id   = (typeof s.deputy_company_id === "number" && s.deputy_company_id > 0)
                     ? s.deputy_company_id
                     : null;
      const name = String(s.deputy_company_name || "").trim();
      // Key by id when present (most stable); else by normalized name.
      const key = id != null
                    ? "id:" + id
                    : (name ? "name:" + normalizeAlias(name) : "");
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key:                  key,
          deputy_company_id:    id,
          deputy_company_name:  name,
          deputy_company_code:  String(s.deputy_company_code || "").trim(),
          deputy_label:         String(s.deputy_label_with_company || "").trim(),
          shift_count:          0,
          last_seen:            null,
          sample_employee:      "",
          sample_url:           "",
          // The match the sync produced. When match_source is
          // "deputy_company_id" the row is already mapped via the
          // canonical field; otherwise admin should map it here.
          last_match_source:    String(s.match_source || ""),
          last_customer_slug:   String(s.customer_slug || ""),
          last_customer_name:   String(s.customer_name || "")
        });
      }
      const g = byKey.get(key);
      g.shift_count += 1;
      const t = toMillis(s.start_time);
      if (t > (g.last_seen || 0)) g.last_seen = t;
      if (!g.sample_employee && s.employee_display_name) g.sample_employee = s.employee_display_name;
      if (!g.sample_url      && s.deputy_shift_url)      g.sample_url      = s.deputy_shift_url;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return (a.deputy_company_name || "").localeCompare(b.deputy_company_name || "");
    });
  }

  // Build customer lookups by Deputy Company.Id. Two separate indexes:
  //   • activeByCompanyId — active customers only
  //   • inactiveByCompanyId — inactive customers only (for warning state)
  //   • duplicateActiveByCompanyId — companyId → [activeCustomer,...]
  //     populated when two-plus active customers share the same id
  function buildCustomerByDeputyCompanyIndex() {
    // customers now lives in tab-customers.js (Phase 15); read via bridge.
    const customers = window.__pioneerAdmin.deps.getCustomers();
    const activeByCompanyId    = {};
    const inactiveByCompanyId  = {};
    const duplicateActiveByCompanyId = {};
    customers.forEach(function (c) {
      const cid = c.deputy_company_id != null && c.deputy_company_id !== ""
                    ? c.deputy_company_id
                    : c.deputy_location_id;
      if (cid == null || cid === "") return;
      const key = String(cid);
      if (!getActive(c)) {
        if (!inactiveByCompanyId[key]) inactiveByCompanyId[key] = c;
        return;
      }
      if (activeByCompanyId[key]) {
        if (!duplicateActiveByCompanyId[key]) {
          duplicateActiveByCompanyId[key] = [activeByCompanyId[key]];
        }
        duplicateActiveByCompanyId[key].push(c);
      } else {
        activeByCompanyId[key] = c;
      }
    });
    return {
      active:    activeByCompanyId,
      inactive:  inactiveByCompanyId,
      duplicate: duplicateActiveByCompanyId
    };
  }

  // Compute the single status that applies to a given Deputy company.
  // Priority: Duplicate > Inactive > No Company ID > Mapped > Alias Fallback > Needs Mapping.
  function deputyCompanyStatus(g, idx) {
    const cid = g.deputy_company_id;
    if (cid == null || cid === "") {
      return { code: "no_id",        label: "No Company ID" };
    }
    const key = String(cid);
    if (idx.duplicate[key]) {
      return {
        code: "duplicate",
        label: "Duplicate Mapping",
        offending: idx.duplicate[key]
      };
    }
    if (idx.active[key]) {
      return { code: "mapped", label: "Mapped", customer: idx.active[key] };
    }
    if (idx.inactive[key]) {
      return { code: "inactive", label: "Inactive Customer", customer: idx.inactive[key] };
    }
    // No customer claims this Company.Id. If the sync is currently
    // resolving these shifts via the alias path, surface that.
    if (g.last_match_source === "alias") {
      return { code: "alias_fallback", label: "Alias Fallback" };
    }
    return { code: "needs_mapping", label: "Needs Mapping" };
  }

  function renderDeputyCompanies() {
    const root    = $("deputy-companies-list");
    const totalEl = $("deputy-companies-total");
    if (!root) return;
    const rows = aggregateDeputyCompanies();
    const idx  = buildCustomerByDeputyCompanyIndex();

    let mapped = 0, needs = 0, dupes = 0, inactive = 0, fallback = 0, noid = 0;
    rows.forEach(function (g) {
      const st = deputyCompanyStatus(g, idx);
      if (st.code === "mapped")         mapped   += 1;
      else if (st.code === "duplicate") dupes    += 1;
      else if (st.code === "inactive")  inactive += 1;
      else if (st.code === "no_id")     noid     += 1;
      else if (st.code === "alias_fallback") fallback += 1;
      else                              needs    += 1;
    });
    if (totalEl) {
      totalEl.textContent =
        mapped + " mapped · " +
        needs + " needs mapping" +
        (dupes    ? " · " + dupes + " duplicate"     : "") +
        (inactive ? " · " + inactive + " inactive"   : "") +
        (fallback ? " · " + fallback + " via alias"  : "") +
        (noid     ? " · " + noid + " no id"          : "");
    }
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No Deputy companies in the recent shift cache.</strong> ' +
          'Wait for the next scheduled sync (every 10 min), then refresh.' +
        '</p>';
      return;
    }
    // Customer picker options. Inactive customers are HIDDEN by default
    // (safety — prevents mapping a Deputy company to an archived
    // customer). Admin can toggle "Show inactive" to surface them with
    // a visible marker.
    const customerOptionsHtml = customers
      .filter(function (c) { return showInactiveInCustomerPicker || getActive(c); })
      .sort(function (a, b) {
        // Active first, then alphabetical.
        const ai = getActive(a) ? 0 : 1;
        const bi = getActive(b) ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return getCustomerName(a).localeCompare(getCustomerName(b));
      })
      .map(function (c) {
        const inactive = !getActive(c);
        return '<option value="' + escapeHtml(getCustomerSlug(c)) + '"' +
                 (inactive ? ' data-inactive="true"' : '') + '>' +
                 escapeHtml(getCustomerName(c)) +
                 (inactive ? "  (inactive)" : "") +
               '</option>';
      }).join("");
    // "Show inactive" toggle row, rendered once at the top of the list.
    const showInactiveToggleHtml =
      '<div class="dm-show-inactive-row">' +
        '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
          ' data-action="toggle-show-inactive">' +
          (showInactiveInCustomerPicker
            ? "Hide inactive customers"
            : "Show inactive customers in picker") +
        '</button>' +
        (showInactiveInCustomerPicker
          ? '<span class="dm-show-inactive-note">Inactive customers visible (use with care).</span>'
          : '') +
      '</div>';
    root.innerHTML = rows.map(function (g) {
      const cid = g.deputy_company_id;
      const lastSeen = fmtLastSeenPT(g.last_seen);
      const status = deputyCompanyStatus(g, idx);
      const pillClass = ({
        mapped:         "is-mapped",
        needs_mapping:  "is-unmapped",
        duplicate:      "is-duplicate",
        inactive:       "is-inactive",
        no_id:          "is-unmapped",
        alias_fallback: "is-suggestion"
      })[status.code] || "is-unmapped";

      // Rename-safe display: if the mapped customer's stored
      // deputy_company_name differs from the live name we see in
      // recent cache, surface both so admin notices the rename.
      let renameNote = "";
      if (status.customer && status.customer.deputy_company_name &&
          g.deputy_company_name &&
          String(status.customer.deputy_company_name).trim() !==
          String(g.deputy_company_name).trim()) {
        renameNote =
          '<div class="dm-rename-note">' +
            'Stored on customer doc as <em>' + escapeHtml(status.customer.deputy_company_name) + '</em>; ' +
            'currently named in Deputy as <strong>' + escapeHtml(g.deputy_company_name) + '</strong>. ' +
            'Matching still works via Company.Id — no action needed.' +
          '</div>';
      }

      // Duplicate detail panel — list every offending Pioneer customer.
      // Each entry gets a "Keep this mapping" button that promotes one
      // customer as the owner and removes deputy_company_id from the
      // others in one batch.
      let duplicateDetail = "";
      if (status.code === "duplicate" && Array.isArray(status.offending)) {
        duplicateDetail =
          '<div class="dm-warning-detail">' +
            '<strong>Duplicate Deputy company mapping.</strong> ' +
            String(status.offending.length) + ' Pioneer customers claim Deputy Company ID ' +
            escapeHtml(String(cid)) + '. Today\'s Work will <strong>not</strong> auto-resolve ' +
            'these shifts until you pick one. The first customer alphabetically is the ' +
            'current "owner" of the mapping in the index — but the resolver does not ' +
            'auto-pick because of this ambiguity.' +
            '<ul class="dm-duplicate-list">' +
              status.offending.map(function (c) {
                return '<li>' +
                  '<span class="dm-duplicate-name">' +
                    escapeHtml(getCustomerName(c)) +
                    ' <code>' + escapeHtml(getCustomerSlug(c)) + '</code>' +
                  '</span>' +
                  '<button class="dm-btn dm-btn-primary dm-btn-sm" type="button"' +
                    ' data-action="keep-duplicate-mapping"' +
                    ' data-keep-slug="' + escapeHtml(getCustomerSlug(c)) + '"' +
                    ' data-deputy-company-id="' + escapeHtml(String(cid)) + '"' +
                    '>Keep this mapping</button>' +
                '</li>';
              }).join("") +
            '</ul>' +
          '</div>';
      }

      // Inactive detail panel.
      let inactiveDetail = "";
      if (status.code === "inactive" && status.customer) {
        inactiveDetail =
          '<div class="dm-warning-detail">' +
            '<strong>Mapped to inactive customer.</strong> ' +
            'Deputy Company ID ' + escapeHtml(String(cid)) + ' is currently mapped to ' +
            '<em>' + escapeHtml(getCustomerName(status.customer)) + '</em>, which is archived. ' +
            'Shifts for this company stay <strong>unresolved</strong> on Today\'s Work; ' +
            'either reactivate the customer or remap to a different one below.' +
          '</div>';
      }

      const dataAttrs =
        ' data-deputy-company-id="' + escapeHtml(cid != null ? String(cid) : "") + '"' +
        ' data-deputy-company-name="' + escapeHtml(g.deputy_company_name || "") + '"';

      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              escapeHtml(g.deputy_company_name || "(unnamed Deputy company)") +
            '</div>' +
            '<span class="mapping-pill ' + pillClass + '">' + escapeHtml(status.label) +
              (status.code === "mapped" && status.customer
                ? ' → ' + escapeHtml(getCustomerName(status.customer))
                : '') +
            '</span>' +
          '</div>' +
          '<div class="dm-footnote">' +
            (cid != null ? 'Deputy Company ID ' + escapeHtml(String(cid)) + ' · ' : '') +
            (g.deputy_company_code ? 'Code <code>' + escapeHtml(g.deputy_company_code) + '</code> · ' : '') +
            'Seen in ' + g.shift_count + ' shift' + (g.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
          '</div>' +
          (g.sample_url
            ? '<div class="dm-open"><a class="deputy-open-link" href="' + escapeHtml(g.sample_url) +
              '" target="_blank" rel="noopener">Open in Deputy ↗</a></div>'
            : '') +
          renameNote +
          duplicateDetail +
          inactiveDetail +
          (status.code === "mapped" && status.customer
            ? '<div class="dm-mapped-detail">' +
                'Linked to <strong>' + escapeHtml(getCustomerName(status.customer)) + '</strong> ' +
                '(<code>' + escapeHtml(getCustomerSlug(status.customer)) + '</code>) via ' +
                '<code>customers.deputy_company_id</code>.' +
                ' <button class="dm-btn dm-btn-secondary dm-btn-sm" type="button"' +
                  ' data-action="remove-deputy-company-mapping"' +
                  ' data-keep-slug="' + escapeHtml(getCustomerSlug(status.customer)) + '"' +
                  ' data-deputy-company-id="' + escapeHtml(String(cid)) + '">' +
                  'Remove mapping</button>' +
              '</div>'
            : '') +
          (cid != null
            ? '<div class="dm-picker">' +
                '<label class="dm-picker-label">' +
                  (status.code === "mapped"
                    ? 'Change mapping to a different Pioneer customer:'
                    : 'Map this Deputy company to a Pioneer customer (one-time):') +
                '</label>' +
                '<div class="dm-picker-row">' +
                  '<select class="dm-select" data-pick="deputy-company"' + dataAttrs + '>' +
                    '<option value="">— Pick a Pioneer customer —</option>' + customerOptionsHtml +
                  '</select>' +
                  '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
                    ' data-action="map-deputy-company"' +
                    dataAttrs + ' disabled>Pick customer first</button>' +
                '</div>' +
              '</div>'
            : '') +
        '</div>'
      );
    }).join("");
    // Inject the "Show inactive" toggle row at the top of the list.
    root.innerHTML = showInactiveToggleHtml + root.innerHTML;
  }

  // Connection Health — top-of-panel status banner. Reads from the
  // already-loaded shift cache + alias collection, no extra round trips.
  function renderDeputyConnectionHealth() {
    const root        = $("deputy-health-stats");
    const summaryEl   = $("deputy-health-summary");
    const warningsEl  = $("deputy-health-warnings");
    if (!root) return;

    const idx = buildCustomerByDeputyCompanyIndex();
    // Aggregate match-source counts across the loaded shifts.
    const counts = {
      total:               deputyMappingShifts.length,
      by_deputy_company_id:  0,
      by_deputy_company_name: 0,
      by_alias:              0,
      duplicate:             0,
      inactive:              0,
      none:                  0
    };
    let latestSyncMs = 0;
    deputyMappingShifts.forEach(function (s) {
      const t = toMillis(s.last_synced_at);
      if (t > latestSyncMs) latestSyncMs = t;
      const src = String(s.match_source || "");
      if (s.duplicate_mapping)                   counts.duplicate += 1;
      else if (s.inactive_customer)              counts.inactive += 1;
      else if (src === "deputy_company_id")      counts.by_deputy_company_id += 1;
      else if (src === "deputy_company_name")    counts.by_deputy_company_name += 1;
      else if (src === "alias")                  counts.by_alias += 1;
      else                                       counts.none += 1;
    });

    const lastSyncLabel = latestSyncMs
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          dateStyle: "medium", timeStyle: "short"
        }).format(new Date(latestSyncMs))
      : "unknown";

    if (summaryEl) {
      summaryEl.textContent = counts.total + " shift" + (counts.total === 1 ? "" : "s") +
        " · last sync " + lastSyncLabel + " PT";
    }

    // Build warning banners for any Pioneer-side duplicates / inactive
    // mappings discovered while indexing customers (covers cases where
    // no shifts have hit them yet).
    const warnings = [];
    Object.keys(idx.duplicate).forEach(function (cid) {
      const dupes = idx.duplicate[cid] || [];
      warnings.push({
        kind:  "duplicate",
        label: "Duplicate Deputy company mapping",
        body:  "Deputy Company ID " + cid + " is claimed by " + dupes.length +
               " Pioneer customers: " + dupes.map(function (c) { return getCustomerName(c); }).join(", ") + "."
      });
    });
    Object.keys(idx.inactive).forEach(function (cid) {
      const c = idx.inactive[cid];
      // Only warn when this inactive mapping is actually causing
      // unresolved shifts (i.e. there's no active customer with the
      // same id AND the sync flagged inactive_customer).
      if (idx.active[cid]) return;
      const usedOnShift = deputyMappingShifts.some(function (s) {
        return String(s.deputy_company_id || "") === cid && s.inactive_customer;
      });
      if (!usedOnShift) return;
      warnings.push({
        kind:  "inactive",
        label: "Inactive customer holds Deputy company mapping",
        body:  "Deputy Company ID " + cid + " is mapped to inactive customer " +
               getCustomerName(c) + ". Shifts stay unresolved until you reactivate or remap."
      });
    });

    if (warningsEl) {
      warningsEl.innerHTML = warnings.map(function (w) {
        return '<div class="dm-health-warning is-' + w.kind + '">' +
                 '<strong>' + escapeHtml(w.label) + '.</strong> ' +
                 escapeHtml(w.body) +
               '</div>';
      }).join("");
    }

    // ---- Top-line Mapping Health banner ----
    // Roll up the per-shift counts into per-company counts: distinct
    // Deputy companies (across loaded shifts) classified into mapped,
    // duplicate, unmapped (no Pioneer customer claims the id), or
    // inactive-conflict (only an inactive customer claims it). Banner
    // color: GREEN when zero issues, AMBER when only unmapped, RED
    // when duplicates exist.
    const companyStats = (function () {
      const rowsAgg = aggregateDeputyCompanies();
      const out = { mapped: 0, duplicate: 0, unmapped: 0, inactive: 0, no_id: 0 };
      rowsAgg.forEach(function (g) {
        const st = deputyCompanyStatus(g, idx);
        if (st.code === "mapped")         out.mapped   += 1;
        else if (st.code === "duplicate") out.duplicate += 1;
        else if (st.code === "inactive")  out.inactive  += 1;
        else if (st.code === "no_id")     out.no_id     += 1;
        else                              out.unmapped  += 1;
      });
      return out;
    })();
    const healthLevel = companyStats.duplicate > 0
                          ? "red"
                          : (companyStats.unmapped > 0 || companyStats.inactive > 0
                              ? "amber"
                              : "green");
    const healthBannerHtml =
      '<div class="dm-health-banner is-' + healthLevel + '">' +
        '<div class="dm-health-banner-title">' +
          'Mapping Health ' +
          '<span class="dm-health-banner-pill">' +
            (healthLevel === "green" ? "All clear"
              : healthLevel === "amber" ? "Action recommended"
              : "Action required") +
          '</span>' +
        '</div>' +
        '<ul class="dm-health-banner-list">' +
          '<li>' + companyStats.mapped + ' mapped</li>' +
          '<li>' + companyStats.duplicate + ' duplicate' + (companyStats.duplicate === 1 ? "" : "s") + '</li>' +
          '<li>' + companyStats.unmapped + ' unmapped</li>' +
          '<li>' + companyStats.inactive + ' inactive conflict' + (companyStats.inactive === 1 ? "" : "s") + '</li>' +
        '</ul>' +
      '</div>';

    root.innerHTML =
      healthBannerHtml +
      '<div class="dm-health-grid">' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_deputy_company_id + '</span><span class="dm-health-label">via Company ID</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_deputy_company_name + '</span><span class="dm-health-label">via Company name</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_alias + '</span><span class="dm-health-label">via alias</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.duplicate + '</span><span class="dm-health-label">duplicate</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.inactive + '</span><span class="dm-health-label">inactive</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.none + '</span><span class="dm-health-label">unmapped</span></div>' +
      '</div>';
  }

  async function mapDeputyCompanyToCustomer(opts) {
    const slug = opts.customer_slug;
    const cid  = opts.deputy_company_id;
    const name = opts.deputy_company_name || "";
    if (!slug)              { showToast("err", "Pick a customer first."); return; }
    if (cid == null || cid === "") { showToast("err", "Missing Deputy Company ID."); return; }
    // Safety: refuse to map to an inactive customer unless the picker
    // is in "show inactive" mode AND admin really meant it. We can't
    // tell which here, so just block silently — the inactive option
    // in the picker is already labeled "(inactive)".
    const targetCustomer = window.__pioneerAdmin.deps.getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (targetCustomer && !getActive(targetCustomer) && !showInactiveInCustomerPicker) {
      showToast("err", "That customer is inactive. Toggle 'Show inactive' first if you really want to map it.");
      return;
    }
    try {
      await db.collection("customers").doc(slug).update({
        deputy_company_id:    Number(cid) || cid,
        deputy_company_name:  name,
        updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:           getCurrentAdminEmail()
      });
      showToast("ok", "Mapped Deputy company to customer. Next sync auto-resolves every matching shift.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "map deputy company to customer" });
    }
  }

  // Remove the Deputy company mapping from a customer doc. Preserves
  // every other field (including aliases) so the customer keeps
  // working normally — just no longer auto-resolves Deputy shifts.
  async function removeCompanyMapping(slug, cid) {
    if (!slug) { showToast("err", "Missing customer slug."); return; }
    const customer = window.__pioneerAdmin.deps.getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (!customer) { showToast("err", "Couldn't find that customer."); return; }
    const msg = "Remove Deputy company mapping from this customer?\n\n" +
                'Customer: ' + getCustomerName(customer) + '\n' +
                'Deputy Company ID: ' + cid + '\n\n' +
                "The customer stays active — only the Deputy link is removed. " +
                "Aliases and all other settings are preserved.";
    if (!window.confirm(msg)) return;
    try {
      await db.collection("customers").doc(slug).update({
        deputy_company_id:    firebase.firestore.FieldValue.delete(),
        deputy_company_name:  firebase.firestore.FieldValue.delete(),
        updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:           getCurrentAdminEmail()
      });
      showToast("ok", "Deputy company mapping removed.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "remove deputy company mapping" });
    }
  }

  // Resolve a duplicate-mapping conflict: keep the chosen customer's
  // deputy_company_id, remove it from every other customer that
  // claimed the same id. Atomic per-customer writes; toast on success.
  async function keepDuplicateMapping(keepSlug, cid) {
    if (!keepSlug)          { showToast("err", "Missing customer slug."); return; }
    if (cid == null || cid === "") { showToast("err", "Missing Deputy Company ID."); return; }
    const cidStr = String(cid);
    // Find every customer currently claiming this Company.Id.
    const claimants = window.__pioneerAdmin.deps.getCustomers().filter(function (c) {
      const ccid = c.deputy_company_id != null && c.deputy_company_id !== ""
                     ? c.deputy_company_id
                     : c.deputy_location_id;
      return ccid != null && String(ccid) === cidStr;
    });
    const keepCustomer = claimants.find(function (c) { return getCustomerSlug(c) === keepSlug; });
    if (!keepCustomer) {
      showToast("err", "The customer you chose isn't in the duplicate set anymore. Refresh and retry.");
      return;
    }
    const toRemove = claimants.filter(function (c) { return getCustomerSlug(c) !== keepSlug; });
    if (toRemove.length === 0) {
      showToast("ok", "Already resolved — no other claimants found.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
      return;
    }
    const msg = "Keep Deputy Company ID " + cidStr + " on " +
                getCustomerName(keepCustomer) + " and remove it from " +
                toRemove.length + " other customer" +
                (toRemove.length === 1 ? "" : "s") + "?\n\n" +
                toRemove.map(function (c) { return "  • " + getCustomerName(c); }).join("\n");
    if (!window.confirm(msg)) return;
    try {
      const batch = db.batch();
      toRemove.forEach(function (c) {
        const ref = db.collection("customers").doc(getCustomerSlug(c));
        batch.update(ref, {
          deputy_company_id:    firebase.firestore.FieldValue.delete(),
          deputy_company_name:  firebase.firestore.FieldValue.delete(),
          updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
          updated_by:           getCurrentAdminEmail()
        });
      });
      await batch.commit();
      showToast("ok", "Duplicate resolved.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "resolve duplicate company mapping" });
    }
  }

  // ===================================================================
  // ALIAS AUDIT — surface flagged aliases for admin review.
  // ===================================================================
  // Reasons we flag:
  //   • conflict      — same normalized form points at 2+ customers
  //   • duplicate     — same normalized form, same customer, multiple docs
  //   • too_short     — normalized length < 5 (inert at suggestion time)
  //   • generic_word  — normalized form is in SUGGEST_DENY
  //   • unusual_match — alias and customer name share no substring overlap
  //                     AND alias doesn't look like a shorthand code
  //   • disabled      — already inactive (informational)
  //
  // Auto-classified kinds (when alias_kind is unset):
  //   • shorthand_code         — 2-8 char all-caps token
  //   • deputy_location_name   — alias exactly equals customer name
  //   • normalized_customer_name — alias is a substring of customer name (or vice versa)
  //   • manual                 — falls through

  // Mirror of the backend SUGGEST_DENY list — kept in sync by inspection.
  const ALIAS_AUDIT_DENY = new Set([
    "pioneer", "pioneercommercialcleaning", "commercialcleaning",
    "cleaningtech", "technician", "admin", "office", "route",
    "shift", "coverage", "floater", "training"
  ]);
  const ALIAS_AUDIT_MIN_LEN = 5;

  function isShorthandPattern(text) {
    const s = String(text || "").trim();
    return /^[A-Z0-9][A-Z0-9 ]{1,7}$/.test(s);
  }

  function classifyAliasKind(a) {
    if (a.alias_kind && typeof a.alias_kind === "string") return a.alias_kind;
    const alias = String(a.alias || "");
    const cname = String(a.customer_name || "");
    if (isShorthandPattern(alias)) return "shorthand_code";
    if (alias && cname && alias.trim().toLowerCase() === cname.trim().toLowerCase()) {
      return "deputy_location_name";
    }
    const an = normalizeAlias(alias);
    const cn = normalizeAlias(cname);
    if (an && cn && an.length >= 4 &&
        (cn.indexOf(an) !== -1 || an.indexOf(cn) !== -1)) {
      return "normalized_customer_name";
    }
    return "manual";
  }

  function computeAliasAudit() {
    const byNorm = new Map();   // normalized → [aliasDoc...]
    customerAliases.forEach(function (a) {
      const norm = String(a.normalized_alias || normalizeAlias(a.alias) || "");
      if (!norm) return;
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(a);
    });
    const flagged = [];
    customerAliases.forEach(function (a) {
      const norm = String(a.normalized_alias || normalizeAlias(a.alias) || "");
      const reasons = [];
      const sameNorm = byNorm.get(norm) || [];
      const distinctSlugs = new Set(sameNorm.map(function (x) { return String(x.customer_slug || ""); }));
      if (norm.length < ALIAS_AUDIT_MIN_LEN) reasons.push("too_short");
      if (norm && ALIAS_AUDIT_DENY.has(norm)) reasons.push("generic_word");
      if (distinctSlugs.size > 1) reasons.push("conflict");
      if (sameNorm.length > 1 && distinctSlugs.size === 1) reasons.push("duplicate");
      const cn = normalizeAlias(a.customer_name || "");
      if (norm && cn && norm.length >= 4 &&
          cn.indexOf(norm) === -1 && norm.indexOf(cn) === -1 &&
          !isShorthandPattern(a.alias)) {
        reasons.push("unusual_match");
      }
      if (reasons.length) {
        flagged.push({
          doc: a,
          normalized: norm,
          reasons: reasons,
          kind: classifyAliasKind(a),
          conflict_slugs: Array.from(distinctSlugs)
        });
      }
    });
    return {
      flagged:     flagged,
      conflictCount: flagged.filter(function (f) { return f.reasons.indexOf("conflict") !== -1; }).length,
      activeCount:  customerAliases.filter(function (a) { return a.active !== false; }).length,
      disabledCount: customerAliases.filter(function (a) { return a.active === false; }).length
    };
  }

  function renderAliasAudit() {
    const root      = $("alias-audit-list");
    const summaryEl = $("alias-audit-summary");
    const actionBtn = $("alias-audit-disable-conflicts");
    if (!root || !summaryEl) return;
    const audit = computeAliasAudit();
    summaryEl.textContent =
      audit.activeCount + " active · " +
      audit.disabledCount + " disabled · " +
      audit.conflictCount + " conflict" + (audit.conflictCount === 1 ? "" : "s");
    // Action button only when there ARE conflicts to act on.
    if (actionBtn) {
      const conflictsActive = audit.flagged.some(function (f) {
        return f.reasons.indexOf("conflict") !== -1 && f.doc.active !== false;
      });
      actionBtn.hidden = !conflictsActive;
    }
    if (audit.flagged.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No flagged aliases.</strong> ' +
          'Audit passes — every alias is unambiguous, has min-length, and is not in the deny-list.' +
        '</p>';
      return;
    }
    // Sort: conflicts first, then generic, then duplicate, then short, then unusual.
    const order = { conflict: 0, generic_word: 1, duplicate: 2, too_short: 3, unusual_match: 4 };
    function reasonRank(reasons) {
      let best = 99;
      reasons.forEach(function (r) { if (order[r] < best) best = order[r]; });
      return best;
    }
    const rows = audit.flagged.slice().sort(function (a, b) {
      return reasonRank(a.reasons) - reasonRank(b.reasons);
    });
    const reasonLabel = {
      conflict:      "conflict",
      duplicate:     "duplicate",
      too_short:     "too short",
      generic_word:  "generic word",
      unusual_match: "unusual mapping"
    };
    root.innerHTML = rows.map(function (f) {
      const a = f.doc;
      const isActive = a.active !== false;
      const reasonChips = f.reasons.map(function (r) {
        const cls = "dm-flag-chip is-" + r.replace(/_/g, "-");
        return '<span class="' + cls + '">' + escapeHtml(reasonLabel[r] || r) + '</span>';
      }).join(" ");
      return (
        '<div class="alias-audit-row' + (isActive ? '' : ' is-inactive') + '"' +
          ' data-alias-id="' + escapeHtml(a.id || "") + '"' +
          ' role="listitem">' +
          '<div class="alias-audit-alias">' +
            '<code>' + escapeHtml(a.alias || "") + '</code>' +
            '<span class="alias-row-source">' + escapeHtml(f.kind) + '</span>' +
          '</div>' +
          '<div class="alias-row-arrow" aria-hidden="true">→</div>' +
          '<div class="alias-audit-customer">' +
            escapeHtml(a.customer_name || a.customer_slug || "?") +
          '</div>' +
          '<div class="alias-audit-reasons">' + reasonChips + '</div>' +
          '<div class="alias-row-actions">' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-toggle">' +
              (isActive ? 'Disable' : 'Enable') +
            '</button>' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-delete">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  // Batch-disable every alias that's flagged as a conflict AND still active.
  async function disableFlaggedConflicts() {
    const audit = computeAliasAudit();
    const targets = audit.flagged.filter(function (f) {
      return f.reasons.indexOf("conflict") !== -1 && f.doc.active !== false;
    });
    if (targets.length === 0) {
      showToast("ok", "No active conflicts to disable.");
      return;
    }
    if (!confirm("Disable " + targets.length + " conflicting alias" +
                 (targets.length === 1 ? "" : "es") +
                 "? They'll stay in the table for audit; you can re-enable individually.")) {
      return;
    }
    try {
      // Batched commits — stay under the 500-write limit per batch.
      for (let i = 0; i < targets.length; i += 400) {
        const batch = db.batch();
        targets.slice(i, i + 400).forEach(function (f) {
          const ref = db.collection("customer_aliases").doc(f.doc.id);
          batch.set(ref, {
            customer_slug:    f.doc.customer_slug || "",
            customer_name:    f.doc.customer_name || "",
            active:           false,
            flagged_reasons:  f.reasons,
            updated_at:       firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }
      showToast("ok", "Disabled " + targets.length + " conflicting alias" +
                       (targets.length === 1 ? "" : "es") + ".");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "disable conflicting aliases" });
    }
  }

  function renderAliasManager() {
    populateAliasCreateCustomerOptions();
    renderAliasAudit();
    const root = $("alias-list");
    const totalEl = $("alias-manager-total");
    if (totalEl) {
      const active = customerAliases.filter(function (a) { return a.active !== false; }).length;
      totalEl.textContent = active + " active · " + customerAliases.length + " total";
    }
    if (!root) return;
    if (customerAliases.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No aliases yet.</strong> Use the form above to add the first one, ' +
          'or use "Seed from existing customer fields" below to import known codes from <code>customers</code>.' +
        '</p>';
      return;
    }
    const rows = customerAliases.slice().sort(function (a, b) {
      const ai = a.active === false ? 1 : 0;
      const bi = b.active === false ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return String(a.alias || "").localeCompare(String(b.alias || ""));
    });
    root.innerHTML = rows.map(function (a) {
      const used = countAliasUsage(a);
      const sourceLabel = a.source === "manual_seed"   ? "seeded"
                       : a.source === "admin_created"  ? "manual"
                       : a.source === "learned"        ? "learned"
                       : (a.source || "unknown");
      const kind = classifyAliasKind(a);
      const isActive = a.active !== false;
      return (
        '<div class="alias-row' + (isActive ? '' : ' is-inactive') + '" role="listitem"' +
          ' data-alias-id="' + escapeHtml(a.id || "") + '">' +
          '<div class="alias-row-alias">' +
            '<code>' + escapeHtml(a.alias || "") + '</code>' +
            '<span class="alias-row-source">' + escapeHtml(kind) +
              ' · ' + escapeHtml(sourceLabel) + '</span>' +
          '</div>' +
          '<div class="alias-row-arrow" aria-hidden="true">→</div>' +
          '<div class="alias-row-customer">' +
            escapeHtml(a.customer_name || a.customer_slug || "?") +
            '<span class="alias-row-slug">' + escapeHtml(a.customer_slug || "") + '</span>' +
          '</div>' +
          '<div class="alias-row-usage" title="Shifts in the last ' + DEPUTY_MAPPING_LOOKBACK_DAYS + ' days that cited this alias">' +
            (used > 0 ? used + ' recent shift' + (used === 1 ? '' : 's') : '<em>not seen recently</em>') +
          '</div>' +
          '<div class="alias-row-actions">' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-toggle">' +
              (isActive ? 'Disable' : 'Enable') +
            '</button>' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-delete">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  // Aggregate distinct UNMAPPED Deputy location names seen on recent
  // shifts. Each row in the rendered list is one click away from
  // creating an alias. "Unmapped" means: no customer_aliases entry
  // currently matches AND the sync produced no suggested_customer_*.
  function aggregateUnmappedDeputyLocations() {
    const aliasNormSet = new Set();
    customerAliases.forEach(function (a) {
      if (a.active === false) return;
      const n = String(a.normalized_alias || normalizeAlias(a.alias));
      if (n) aliasNormSet.add(n);
    });
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      // Prefer Deputy's Company name (=deputy_location_name). Only
      // fall through to OperationalUnitName when no company is set —
      // it's usually a generic team label.
      const primary  = s.deputy_location_name || s.company_name || "";
      const fallback = s.deputy_operational_unit_name || s.location_name || "";
      const candidates = [];
      if (primary)  candidates.push({ text: primary,  source: "deputy_location_name" });
      if (fallback && fallback !== primary) {
        candidates.push({ text: fallback, source: "deputy_operational_unit_name" });
      }
      candidates.forEach(function (cand) {
        const text = String(cand.text || "").trim();
        if (!text) return;
        const norm = normalizeAlias(text);
        if (!norm) return;
        // Skip if there's already an alias entry covering this string.
        if (aliasNormSet.has(norm)) return;
        // Skip if the sync already produced a suggested customer for
        // this exact shift via some other path — admin doesn't need
        // to map it explicitly. (We still surface it if the same
        // location text appears on OTHER shifts without a suggestion.)
        const key = norm;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key:           key,
            display:       text,
            source:        cand.source,
            shift_count:   0,
            last_seen:     null,
            sample_employee: "",
            sample_url:    ""
          });
        }
        const g = byKey.get(key);
        g.shift_count += 1;
        const t = toMillis(s.start_time);
        if (t > (g.last_seen || 0)) g.last_seen = t;
        if (!g.sample_employee && s.employee_display_name) g.sample_employee = s.employee_display_name;
        if (!g.sample_url      && s.deputy_shift_url)      g.sample_url = s.deputy_shift_url;
      });
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return b.shift_count - a.shift_count;
    });
  }

  function renderUnmappedDeputyLocations() {
    const root = $("unmapped-deputy-locations");
    const totalEl = $("unmapped-deputy-locations-total");
    if (!root) return;
    const rows = aggregateUnmappedDeputyLocations();
    if (totalEl) totalEl.textContent = rows.length + " unmapped";
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>Every Deputy location seen recently is already mapped.</strong> ' +
          'New names will appear here automatically as future shifts sync.' +
        '</p>';
      return;
    }
    const customerOptionsHtml = customers
      .filter(function (c) { return getActive(c); })
      .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); })
      .map(function (c) {
        return '<option value="' + escapeHtml(getCustomerSlug(c)) + '">' +
                 escapeHtml(getCustomerName(c)) +
               '</option>';
      }).join("");
    root.innerHTML = rows.map(function (g) {
      const lastSeen = fmtLastSeenPT(g.last_seen);
      const sourceLabel = g.source === "deputy_location_name"
        ? "Deputy location"
        : "Deputy operational unit";
      const dataAttrs =
        ' data-deputy-location-text="' + escapeHtml(g.display) + '"';
      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              '<span class="dm-type-chip">' + escapeHtml(sourceLabel) + '</span> ' +
              escapeHtml(g.display) +
            '</div>' +
            '<span class="mapping-pill is-unmapped">Needs mapping</span>' +
          '</div>' +
          '<div class="dm-footnote">' +
            'Seen in ' + g.shift_count + ' shift' + (g.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
            (g.sample_employee ? ' · ' + escapeHtml(g.sample_employee) : '') +
          '</div>' +
          (g.sample_url
            ? '<div class="dm-open"><a class="deputy-open-link" href="' + escapeHtml(g.sample_url) +
              '" target="_blank" rel="noopener">Open in Deputy ↗</a></div>'
            : '') +
          '<div class="dm-picker">' +
            '<label class="dm-picker-label">Map this Deputy location to a Pioneer customer (one-time):</label>' +
            '<div class="dm-picker-row">' +
              '<select class="dm-select" data-pick="deputy-loc"' + dataAttrs + '>' +
                '<option value="">— Pick a Pioneer customer —</option>' + customerOptionsHtml +
              '</select>' +
              '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
                ' data-action="map-deputy-loc"' +
                dataAttrs + ' disabled>Pick customer first</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  function populateAliasCreateCustomerOptions() {
    const sel = $("alias-create-customer");
    if (!sel) return;
    const currentValue = sel.value;
    const html = ['<option value="">— Pick a Pioneer customer —</option>']
      .concat(customers
        .filter(function (c) { return getActive(c); })
        .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); })
        .map(function (c) {
          return '<option value="' + escapeHtml(getCustomerSlug(c)) + '">' +
                   escapeHtml(getCustomerName(c)) +
                 '</option>';
        })).join("");
    sel.innerHTML = html;
    if (currentValue) sel.value = currentValue;
  }

  // Build the doc id we'll use for a given alias. Stable per
  // normalized alias text, so re-adding the same alias is a no-op
  // (and matches the backend's lookup).
  function aliasDocId(aliasText) {
    const norm = normalizeAlias(aliasText);
    return norm || "blank-" + Date.now();
  }

  async function createAlias(aliasText, customerSlug) {
    const alias = String(aliasText || "").trim();
    const slug  = String(customerSlug || "").trim();
    if (!alias) { showToast("err", "Enter an alias first."); return; }
    if (!slug)  { showToast("err", "Pick a Pioneer customer first."); return; }
    const customer = window.__pioneerAdmin.deps.getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (!customer) { showToast("err", "Couldn't find that customer."); return; }

    const docId = aliasDocId(alias);
    const payload = {
      alias:                  alias,
      normalized_alias:       normalizeAlias(alias),
      customer_slug:          slug,
      customer_name:          getCustomerName(customer),
      active:                 true,
      source:                 "admin_created",
      confidence:             "high",
      learned_from_dcr:       false,
      learned_from_dcr_count: 0,
      last_learned_at:        null,
      created_at:             firebase.firestore.FieldValue.serverTimestamp(),
      updated_at:             firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      await db.collection("customer_aliases").doc(docId).set(payload, { merge: true });
      showToast("ok", "Alias saved. Future shifts auto-suggest this customer.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "create customer_alias" });
    }
  }

  async function toggleAliasActive(docId) {
    if (!docId) return;
    const current = customerAliases.find(function (a) { return a.id === docId; });
    if (!current) return;
    const nextActive = current.active === false;
    try {
      // The firestore rule requires customer_slug + customer_name + active
      // to stay on the doc, so use merge:true + the fields we already have.
      await db.collection("customer_aliases").doc(docId).set({
        customer_slug: current.customer_slug || "",
        customer_name: current.customer_name || "",
        active:        nextActive,
        updated_at:    firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      showToast("ok", nextActive ? "Alias enabled." : "Alias disabled.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "toggle customer_alias" });
    }
  }

  async function deleteAlias(docId) {
    if (!docId) return;
    if (!confirm("Delete this alias? Future shifts carrying it will stop auto-suggesting a customer.")) return;
    try {
      await db.collection("customer_aliases").doc(docId).delete();
      showToast("ok", "Alias deleted.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "delete customer_alias" });
    }
  }

  async function reloadAliases() {
    const snap = await db.collection("customer_aliases").get();
    customerAliases = snap.docs.map(function (d) {
      return Object.assign({ id: d.id }, d.data());
    });
    renderAliasManager();
    renderUnmappedDeputyLocations();
  }

  // Pilot seed — calls the server-side Cloud Function that knows the
  // curated Pioneer alias list. We never embed the alias list in
  // frontend JS: the list lives in functions/index.js and updates
  // via redeploy.
  async function seedPilotAliases() {
    const url = (window.SEED_PILOT_CUSTOMER_ALIASES_URL || "").trim();
    const statusEl = $("alias-seed-status");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    if (!url || /REPLACE_WITH/.test(url)) {
      status("SEED_PILOT_CUSTOMER_ALIASES_URL is not configured in firebase-config.js.");
      showToast("err", "Pilot seed URL missing — check firebase-config.js.");
      return;
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) { /* swallow */ }
    if (!idToken) {
      showToast("err", "You appear to be signed out. Refresh and sign in again.");
      return;
    }
    status("Calling server-side seed…");
    let result = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: "{}"
      });
      result = await res.json().catch(function () { return {}; });
      if (!res.ok || !result.ok) {
        const msg = (result && result.error) ? result.error : ("Server returned " + res.status);
        status("Seed failed: " + msg);
        showToast("err", "Pilot seed failed: " + msg);
        return;
      }
    } catch (err) {
      status("Seed failed: " + (err && err.message || "network error"));
      showToast("err", "Pilot seed network error.");
      return;
    }
    const seededN  = result.seeded_count  || 0;
    const skippedN = result.skipped_count || 0;
    const missingN = (result.missing_customers || []).length;
    let detail = "Seed successful — " + seededN + " new alias" + (seededN === 1 ? "" : "es");
    if (skippedN)  detail += ", " + skippedN + " already existed";
    if (missingN)  detail += ", " + missingN + " seed entr" + (missingN === 1 ? "y" : "ies") + " skipped (no matching Pioneer customer)";
    detail += ".";
    status(detail);
    showToast("ok", "Seed successful — " + seededN + " new alias" + (seededN === 1 ? "" : "es") + ".");
    if (missingN && Array.isArray(result.missing_customers)) {
      console.warn("[seed] missing Pioneer customers for these seed entries:", result.missing_customers);
    }
    await reloadAliases();
  }

  // Diagnostic — hits Deputy's API via the admin-only probe Cloud
  // Function and dumps the JSON into the disclosure on the admin page.
  // Pure read-only: nothing is written, nothing is auto-mapped.
  async function runDeputyApiProbe(resource) {
    const url = (window.DEPUTY_API_DIAGNOSTIC_URL || "").trim();
    const statusEl = $("deputy-api-probe-status");
    const outEl    = $("deputy-api-probe-output");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    function output(obj) {
      if (!outEl) return;
      try {
        outEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      } catch (_e) {
        outEl.textContent = String(obj);
      }
    }
    if (!url || /REPLACE_WITH/.test(url)) {
      status("DEPUTY_API_DIAGNOSTIC_URL is not configured in firebase-config.js.");
      return;
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) { /* swallow */ }
    if (!idToken) {
      status("You appear to be signed out. Refresh and sign in again.");
      return;
    }
    status("Calling Deputy " + resource + " endpoint…");
    output("");
    let result = null;
    let httpStatus = 0;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ resource: resource })
      });
      httpStatus = res.status;
      result = await res.json().catch(function () { return {}; });
    } catch (err) {
      status("Probe failed: " + (err && err.message || "network error"));
      return;
    }
    if (!result || result.ok !== true) {
      const msg = (result && result.error) ? result.error : ("HTTP " + httpStatus);
      status("Probe failed: " + msg);
      output(result || { error: "no response body" });
      return;
    }
    status(
      "OK — " + resource + " · " +
      result.count + " row" + (result.count === 1 ? "" : "s") +
      " (showing first " + (result.capped_to || 0) + ") · " +
      "endpoint " + result.endpoint_called + " · " +
      "token " + result.token_source
    );
    output(result);
  }

  // One-click migration: harvests every entry from customers[].aliases[]
  // and customers[].deputy_customer_codes[] and creates a corresponding
  // /customer_aliases doc with source="manual_seed". Idempotent — skips
  // anything that already has a doc id collision.
  async function seedAliasesFromCustomers() {
    const statusEl = $("alias-seed-status");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    status("Reading customer fields…");
    const existingIds = new Set(customerAliases.map(function (a) { return a.id; }));
    const writes = [];
    window.__pioneerAdmin.deps.getCustomers().forEach(function (c) {
      if (!getActive(c)) return;
      const slug = getCustomerSlug(c);
      if (!slug) return;
      const name = getCustomerName(c) || "";
      const fromAliases = Array.isArray(c.aliases) ? c.aliases : [];
      const fromCodes   = Array.isArray(c.deputy_customer_codes) ? c.deputy_customer_codes : [];
      fromAliases.concat(fromCodes).forEach(function (raw) {
        const aliasText = String(raw || "").trim();
        if (!aliasText) return;
        const id = aliasDocId(aliasText);
        if (existingIds.has(id)) return;
        existingIds.add(id);  // de-dup within this run
        writes.push({
          id: id,
          payload: {
            alias:                  aliasText,
            normalized_alias:       normalizeAlias(aliasText),
            customer_slug:          slug,
            customer_name:          name,
            active:                 true,
            source:                 "manual_seed",
            confidence:             "high",
            learned_from_dcr:       false,
            learned_from_dcr_count: 0,
            last_learned_at:        null,
            created_at:             firebase.firestore.FieldValue.serverTimestamp(),
            updated_at:             firebase.firestore.FieldValue.serverTimestamp()
          }
        });
      });
    });
    if (writes.length === 0) {
      status("Nothing to seed — every alias on customer docs is already in customer_aliases.");
      return;
    }
    status("Writing " + writes.length + " alias" + (writes.length === 1 ? "" : "es") + "…");
    try {
      // Write in batches of 400 to stay under the 500-write batch limit.
      for (let i = 0; i < writes.length; i += 400) {
        const batch = db.batch();
        writes.slice(i, i + 400).forEach(function (w) {
          batch.set(db.collection("customer_aliases").doc(w.id), w.payload, { merge: false });
        });
        await batch.commit();
      }
      status("Seeded " + writes.length + " alias" + (writes.length === 1 ? "" : "es") + ".");
      showToast("ok", "Seeded " + writes.length + " aliases from customer fields.");
      await reloadAliases();
    } catch (err) {
      status("Seed failed: " + (err && err.message || "unknown error"));
      handleAdminWriteError(err, { context: "seed customer_aliases" });
    }
  }


  // ============= Writers =============

  async function applyEmployeeMapping(opts) {
    const slug = opts.tech_slug;
    if (!slug) { showToast("err", "Missing tech slug — refresh and try again."); return; }
    const update = {
      updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:           getCurrentAdminEmail(),
      deputy_employee_name: opts.deputy_name || ""
    };
    if (opts.deputy_id)    update.deputy_employee_id    = Number(opts.deputy_id) || opts.deputy_id;
    if (opts.deputy_email) update.deputy_employee_email = String(opts.deputy_email).toLowerCase().trim();
    try {
      await db.collection("cleaning_techs").doc(slug).update(update);
      showToast("ok", "Tech mapping saved. Applies to all future shifts.");
      await window.__pioneerAdmin.tabs.techs.refresh();
      renderDeputyMappingEmployees();
    } catch (err) {
      handleAdminWriteError(err, { context: "deputy employee mapping" });
    }
  }


  function wireDeputyMappingControls() {
    const refreshBtn  = $("deputy-mapping-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () { loadDeputyMapping(); });
    }

    // Auto-load when the Deputy tab is first activated.
    const tabBtn = document.querySelector('.admin-tab[data-tab="deputy"]');
    let firstActivation = true;
    if (tabBtn) {
      tabBtn.addEventListener("click", function () {
        if (!firstActivation) return;
        firstActivation = false;
        loadDeputyMapping();
      });
    }

    // Helper — flip the picker-button state when the dropdown changes.
    function updatePickButtonState(sel) {
      if (!sel) return;
      const card = sel.closest(".dm-card");
      if (!card) return;
      const btn = card.querySelector('button[data-action="apply-emp-pick"]');
      if (!btn) return;
      const hasValue = !!sel.value;
      btn.disabled = !hasValue;
      btn.classList.toggle("is-disabled", !hasValue);
      btn.textContent = hasValue ? "Map this" : "Pick tech first";
    }

    // Employees panel.
    const empRoot = $("deputy-mapping-employees");
    if (empRoot) {
      empRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="emp"]');
        if (sel) updatePickButtonState(sel);
      });
      empRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === "apply-emp") {
          applyEmployeeMapping({
            tech_slug:     btn.dataset.techSlug,
            deputy_id:     btn.dataset.deputyId,
            deputy_name:   btn.dataset.deputyName,
            deputy_email:  btn.dataset.deputyEmail
          });
        } else if (action === "apply-emp-pick") {
          const card = btn.closest(".dm-card");
          const sel  = card && card.querySelector('select[data-pick="emp"]');
          const techSlug = sel && sel.value;
          if (!techSlug) { showToast("err", "Pick a tech first."); return; }
          applyEmployeeMapping({
            tech_slug:     techSlug,
            deputy_id:     btn.dataset.deputyId,
            deputy_name:   btn.dataset.deputyName,
            deputy_email:  btn.dataset.deputyEmail
          });
        }
      });
    }

    // Customer Alias Manager — create form.
    const createForm = $("alias-create-form");
    if (createForm) {
      createForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        const aliasInput = $("alias-create-alias");
        const custSelect = $("alias-create-customer");
        const aliasText  = aliasInput ? aliasInput.value : "";
        const slug       = custSelect ? custSelect.value : "";
        createAlias(aliasText, slug).then(function () {
          if (aliasInput) aliasInput.value = "";
          if (custSelect) custSelect.value = "";
        });
      });
    }

    // Customer Alias Manager — per-row toggle/delete. Same handler
    // covers the audit list (.alias-audit-row) by walking either
    // parent class up to data-alias-id.
    function bindAliasActions(rootEl) {
      if (!rootEl) return;
      rootEl.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-alias-id]");
        const id  = row && row.dataset.aliasId;
        if (!id) return;
        if (btn.dataset.action === "alias-toggle") toggleAliasActive(id);
        if (btn.dataset.action === "alias-delete") deleteAlias(id);
      });
    }
    bindAliasActions($("alias-list"));
    bindAliasActions($("alias-audit-list"));

    // "Disable all flagged conflicts" — batch action on the audit panel.
    const disableConflictsBtn = $("alias-audit-disable-conflicts");
    if (disableConflictsBtn) {
      disableConflictsBtn.addEventListener("click", function () { disableFlaggedConflicts(); });
    }

    // Pilot seed button — server-side function call.
    const pilotBtn = $("alias-seed-pilot");
    if (pilotBtn) {
      pilotBtn.addEventListener("click", function () { seedPilotAliases(); });
    }

    // Deputy API probe — three buttons, one output area. Diagnostic only.
    const probeRoot = $("deputy-api-probe");
    if (probeRoot) {
      probeRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("button[data-probe]");
        if (!btn) return;
        const resource = btn.dataset.probe;
        if (!resource) return;
        runDeputyApiProbe(resource);
      });
    }
    // Legacy seed-from-customers button — frontend-driven harvest.
    const seedBtn = $("alias-seed-run");
    if (seedBtn) {
      seedBtn.addEventListener("click", function () { seedAliasesFromCustomers(); });
    }

    // Deputy Companies — primary mapping panel.
    const companiesRoot = $("deputy-companies-list");
    if (companiesRoot) {
      companiesRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="deputy-company"]');
        if (!sel) return;
        const card = sel.closest(".dm-card");
        const btn  = card && card.querySelector('button[data-action="map-deputy-company"]');
        if (!btn) return;
        const hasValue = !!sel.value;
        btn.disabled = !hasValue;
        btn.classList.toggle("is-disabled", !hasValue);
        btn.textContent = hasValue ? "Map this company" : "Pick customer first";
      });
      companiesRoot.addEventListener("click", function (ev) {
        const mapBtn = ev.target.closest('button[data-action="map-deputy-company"]');
        if (mapBtn) {
          const card = mapBtn.closest(".dm-card");
          const sel  = card && card.querySelector('select[data-pick="deputy-company"]');
          const slug = sel && sel.value;
          if (!slug) { showToast("err", "Pick a customer first."); return; }
          mapDeputyCompanyToCustomer({
            customer_slug:       slug,
            deputy_company_id:   mapBtn.dataset.deputyCompanyId,
            deputy_company_name: mapBtn.dataset.deputyCompanyName
          });
          return;
        }
        const removeBtn = ev.target.closest('button[data-action="remove-deputy-company-mapping"]');
        if (removeBtn) {
          removeCompanyMapping(removeBtn.dataset.keepSlug, removeBtn.dataset.deputyCompanyId);
          return;
        }
        const keepBtn = ev.target.closest('button[data-action="keep-duplicate-mapping"]');
        if (keepBtn) {
          keepDuplicateMapping(keepBtn.dataset.keepSlug, keepBtn.dataset.deputyCompanyId);
          return;
        }
        const toggleBtn = ev.target.closest('button[data-action="toggle-show-inactive"]');
        if (toggleBtn) {
          showInactiveInCustomerPicker = !showInactiveInCustomerPicker;
          renderDeputyCompanies();
          return;
        }
      });
    }

    // Unmapped-Deputy-locations panel (legacy, lives under the
    // collapsed Fallback Aliases disclosure).
    const unmappedRoot = $("unmapped-deputy-locations");
    if (unmappedRoot) {
      unmappedRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="deputy-loc"]');
        if (!sel) return;
        const card = sel.closest(".dm-card");
        const btn  = card && card.querySelector('button[data-action="map-deputy-loc"]');
        if (!btn) return;
        const hasValue = !!sel.value;
        btn.disabled = !hasValue;
        btn.classList.toggle("is-disabled", !hasValue);
        btn.textContent = hasValue ? "Map this location" : "Pick customer first";
      });
      unmappedRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest('button[data-action="map-deputy-loc"]');
        if (!btn) return;
        const card = btn.closest(".dm-card");
        const sel  = card && card.querySelector('select[data-pick="deputy-loc"]');
        const slug = sel && sel.value;
        const text = btn.dataset.deputyLocationText || "";
        if (!slug) { showToast("err", "Pick a customer first."); return; }
        if (!text) { showToast("err", "Missing Deputy location text."); return; }
        // Re-uses the manual createAlias path so all alias docs share
        // a schema. The "alias" is the verbatim Deputy location name.
        createAlias(text, slug).then(function () {
          renderUnmappedDeputyLocations();
        });
      });
    }
  }

  // ---- One-time wiring: event delegation + modal close/save buttons + Esc ----

  function wireWriteControls() {
    // Customer list — event-delegated Edit / Archive clicks.
    // customers array now lives in tab-customers.js (Phase 15); read via bridge.
    const custRoot = $("customer-list");
    if (custRoot) {
      custRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const customers = window.__pioneerAdmin.deps.getCustomers();
        const c = customers.find(function (x) { return x.id === row.dataset.id; });
        if (!c) return;
        if (btn.dataset.action === "edit")    window.__pioneerAdmin.tabs.customers.openEditModal(c);
        if (btn.dataset.action === "archive") window.__pioneerAdmin.tabs.customers.onArchive(c);
      });
    }
    // Tech list — same pattern, plus overflow-menu toggling.
    //
    // The row markup contains a [data-action="more"] trigger and a
    // sibling .row-overflow-menu popover with the lower-priority
    // actions (Promote / Archive / Delete). Clicking the trigger
    // toggles the popover; clicking any menu item closes the popover
    // and dispatches the action. Outside-clicks close every open
    // popover (see installOverflowMenuOutsideClose).
    const techRoot = $("tech-list");
    if (techRoot) {
      techRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        // techs now lives in tab-techs.js (Phase 16a); read via bridge.
        const techs = window.__pioneerAdmin.deps.getTechs();
        const t = techs.find(function (x) { return x.id === row.dataset.id; });
        if (!t) return;

        const action = btn.dataset.action;

        // Overflow trigger: toggle the menu and stop here. We don't
        // dispatch an action for "more" itself.
        if (action === "more") {
          toggleRowOverflow(btn);
          return;
        }

        // Any other action — close the menu if it was open, then run.
        // closing first means the popover doesn't linger over a confirm
        // dialog or modal.
        closeAllRowOverflowMenus();

        if (action === "edit")    window.__pioneerAdmin.tabs.techs.openEditModal(t);
        if (action === "media")   openTechMediaModal(t);  // stays in admin.js (Phase 16b)
        if (action === "archive") window.__pioneerAdmin.tabs.techs.onArchive(t);
        if (action === "delete")  window.__pioneerAdmin.tabs.techs.onDelete(t);
        if (action === "resend") {
          const email = (t.email || "").toLowerCase().trim();
          if (email) sendResetInviteFor(email, null);
        }
        if (action === "promote") promoteTechToAdmin(t);
      });
    }

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
        if (btn.dataset.action === "review-send") openDcrReviewModal(d);
      });
    }

    // DCR review modal — Send + Resend buttons.
    const dcrSendBtn = $("dcr-review-send");
    if (dcrSendBtn) dcrSendBtn.addEventListener("click", function () { performDcrSend(false); });
    const dcrResendBtn = $("dcr-review-resend");
    if (dcrResendBtn) dcrResendBtn.addEventListener("click", function () {
      if (window.confirm("Resend the DCR email to the customer? They'll get a second copy.")) {
        performDcrSend(true);
      }
    });

    // Modal Save buttons.
    //
    // The customer save button serves BOTH edit and create modes — we
    // dispatch on the modal's data-mode attribute. Tech edit/create
    // remain on separate buttons since they live in two different
    // modals (tech-edit-modal vs tech-create-modal).
    const custSave = $("customer-edit-save");
    if (custSave) custSave.addEventListener("click", function () {
      window.__pioneerAdmin.tabs.customers.onSave();
    });
    const techSave = $("tech-edit-save");
    if (techSave) techSave.addEventListener("click", function () { window.__pioneerAdmin.tabs.techs.onSaveEdit(); });
    const techCreateSave = $("tech-create-save");
    if (techCreateSave) techCreateSave.addEventListener("click", function () { window.__pioneerAdmin.tabs.techs.onSaveCreate(); });

    // "+ Add customer" button → opens the customer modal in create mode.
    const custCreateOpen = $("customer-create-open");
    if (custCreateOpen) custCreateOpen.addEventListener("click", function () {
      window.__pioneerAdmin.tabs.customers.openCreateModal();
    });

    // Auto-slug on the customer-create modal — derive from location_name
    // (preferred) or customer_name as the admin types, until the admin
    // touches the slug field themselves. Same pattern as the tech-create
    // modal's slug auto-fill.
    const custNameEl     = $("cust-edit-name");
    const custLocationEl = $("cust-edit-location");
    const custSlugEl     = $("cust-create-slug");
    function refreshAutoCustSlug() {
      const modal = $("customer-edit-modal");
      if (!modal || modal.dataset.mode !== "create") return;
      if (!custSlugEl) return;
      if (custSlugEl.dataset.touched === "1") return;
      const src = (custLocationEl && custLocationEl.value.trim()) ||
                  (custNameEl     && custNameEl.value.trim())     || "";
      custSlugEl.value = slugifyForTech(src);
    }
    if (custSlugEl) {
      custSlugEl.addEventListener("input", function () { custSlugEl.dataset.touched = "1"; });
    }
    if (custNameEl)     custNameEl.addEventListener("input",     refreshAutoCustSlug);
    if (custLocationEl) custLocationEl.addEventListener("input", refreshAutoCustSlug);

    // "+ Add tech / Login setup" button — opens the create modal.
    const techCreateOpen = $("tech-create-open");
    if (techCreateOpen) techCreateOpen.addEventListener("click", function () { window.__pioneerAdmin.tabs.techs.openCreateModal(); });

    // Assignment checklist wiring moved to tab-techs.js (Phase 16a).
    // Its init() — called from boot — wires both checklists.

    // Tech-create modal — auto-derive slug from display name as the admin
    // types. We do NOT overwrite the slug field once the admin has typed
    // their own value (track via a `data-touched` flag).
    const createNameEl = $("tech-create-display-name");
    const createSlugEl = $("tech-create-slug");
    if (createNameEl && createSlugEl) {
      createSlugEl.addEventListener("input", function () { createSlugEl.dataset.touched = "1"; });
      createNameEl.addEventListener("input", function () {
        if (createSlugEl.dataset.touched === "1") return;
        createSlugEl.value = slugifyForTech(createNameEl.value);
      });
      // Reset the touched flag whenever the modal opens (resetTechCreateModal
      // already blanks the value; this drops the sticky flag too).
      const observer = function () { delete createSlugEl.dataset.touched; };
      const openBtn = $("tech-create-open");
      if (openBtn) openBtn.addEventListener("click", observer);
    }

    // Copy buttons on the create-modal success pane.
    const copyResetBtn = $("tech-create-copy-reset");
    if (copyResetBtn) copyResetBtn.addEventListener("click", function () {
      copyInputValue("tech-create-reset-link", "tech-create-copy-reset");
    });
    const copyTempBtn = $("tech-create-copy-temp");
    if (copyTempBtn) copyTempBtn.addEventListener("click", function () {
      copyInputValue("tech-create-temp-password", "tech-create-copy-temp");
    });

    // Modal Close affordances — backdrop, X button, Cancel button. Anything
    // with [data-modal-close] inside a .admin-modal closes its modal.
    $$("[data-modal-close]").forEach(function (el) {
      el.addEventListener("click", function () {
        const modal = el.closest(".admin-modal");
        if (modal) closeModal(modal.id);
      });
    });

    // Esc to close whichever modal is open.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("customer-edit-modal").hidden) closeModal("customer-edit-modal");
      if (!$("tech-edit-modal").hidden)     closeModal("tech-edit-modal");
      if (!$("tech-create-modal").hidden)   closeModal("tech-create-modal");
    });
  }

  /* ====================================================================
     Team Schedule — admin upload + current-schedule summary
     ====================================================================
     Single source of truth lives in `team_schedule/current` (Firestore)
     and the blob in `team-schedules/{yyyymm}/{ts}-{filename}` (Storage).
     Each upload OVERWRITES the doc; there is no per-upload history
     collection yet (see Phase 2 TODO in admin.html and firestore.rules).

     The Team Hub side (team-hub.js) reads the same doc and renders the
     "View / Download" buttons for cleaning techs. */
  const TEAM_SCHEDULE_DOC_ID         = "current";
  const TEAM_SCHEDULE_MAX_BYTES      = 10 * 1024 * 1024;
  const TEAM_SCHEDULE_ALLOWED_MIME   = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp"
  ];
  const TEAM_SCHEDULE_ALLOWED_EXT    = ["pdf", "png", "jpg", "jpeg", "webp"];

  let teamScheduleLoaded = false;

  function setScheduleStatus(state) {
    const ids = ["schedule-loading", "schedule-error", "schedule-empty", "schedule-current"];
    ids.forEach(function (id) {
      const el = $(id);
      if (el) el.hidden = true;
    });
    if (state) {
      const target = $("schedule-" + state);
      if (target) target.hidden = false;
    }
  }

  function setScheduleError(message) {
    const el = $("schedule-error");
    if (!el) return;
    el.textContent = message || "Couldn't load the current schedule.";
    setScheduleStatus("error");
  }

  function setScheduleUploadError(message) {
    const el = $("schedule-upload-error");
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function setScheduleUploadStatus(text) {
    const el = $("schedule-upload-status");
    if (el) el.textContent = text || "";
  }

  function formatScheduleUploadedAt(ts) {
    if (!ts) return "Unknown upload time";
    let ms = null;
    if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    else if (typeof ts === "number") ms = ts;
    else if (typeof ts === "string") { const t = Date.parse(ts); ms = isNaN(t) ? null : t; }
    if (ms == null) return "Unknown upload time";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderTeamSchedule(doc) {
    const data = (doc && doc.data && doc.data()) || null;
    // Reflect the current-PDF state onto the Extract button. Clean
    // disabled state with a hovertip beats a click that surfaces
    // "No PDF backup uploaded yet" as a red error banner.
    syncExtractButtonState(data);
    if (!data || data.active === false || !data.downloadUrl) {
      setScheduleStatus("empty");
      return;
    }
    const filenameEl = $("schedule-current-filename");
    const uploadedEl = $("schedule-current-uploaded");
    const notesEl    = $("schedule-current-notes");
    const viewBtn    = $("schedule-current-view");
    const dlBtn      = $("schedule-current-download");
    if (filenameEl) filenameEl.textContent = data.fileName || "Schedule file";
    if (uploadedEl) {
      const byName = (data.uploadedBy && (data.uploadedBy.displayName || data.uploadedBy.email)) || "an admin";
      const effective = data.effectiveMonth ? " · Effective " + data.effectiveMonth : "";
      uploadedEl.textContent =
        "Uploaded " + formatScheduleUploadedAt(data.uploadedAt) +
        " by " + byName + effective;
    }
    if (notesEl) {
      if (data.notes) {
        notesEl.textContent = data.notes;
        notesEl.hidden = false;
      } else {
        notesEl.hidden = true;
        notesEl.textContent = "";
      }
    }
    if (viewBtn) {
      viewBtn.href   = data.downloadUrl;
      viewBtn.target = "_blank";
      viewBtn.rel    = "noopener noreferrer";
    }
    if (dlBtn) {
      // Append a download hint to nudge the browser to save rather than
      // navigate. The query string is harmless to Firebase Storage.
      dlBtn.href = data.downloadUrl;
      dlBtn.setAttribute("download", data.fileName || "team-schedule.pdf");
    }
    setScheduleStatus("current");
  }

  async function loadTeamSchedule() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setScheduleError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }
    setScheduleStatus("loading");
    try {
      const snap = await firebase.firestore()
        .collection("team_schedule").doc(TEAM_SCHEDULE_DOC_ID).get();
      teamScheduleLoaded = true;
      if (!snap.exists) { setScheduleStatus("empty"); return; }
      renderTeamSchedule(snap);
    } catch (err) {
      console.error("loadTeamSchedule failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm firestore.rules has the team_schedule block deployed."
        : ("Couldn't load the schedule: " + (err && (err.message || err.code)) || "unknown error");
      setScheduleError(friendly);
    }
  }

  function validateScheduleFile(file) {
    if (!file) return "Pick a schedule file first.";
    if (file.size > TEAM_SCHEDULE_MAX_BYTES) {
      return "File is too large (" +
        Math.ceil(file.size / (1024 * 1024)) +
        " MB). Max 10 MB.";
    }
    const ct = (file.type || "").toLowerCase();
    if (ct && TEAM_SCHEDULE_ALLOWED_MIME.indexOf(ct) >= 0) return "";
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
    if (TEAM_SCHEDULE_ALLOWED_EXT.indexOf(ext) >= 0) return "";
    return "Unsupported file type. Allowed: PDF, PNG, JPG, WEBP.";
  }

  function makeScheduleStoragePath(file) {
    const now = new Date();
    const ym  = now.getFullYear() + "-" +
                String(now.getMonth() + 1).padStart(2, "0");
    const safe = (file.name || "schedule")
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return "team-schedules/" + ym + "/" + Date.now() + "-" + (safe || "schedule");
  }

  async function onScheduleUploadSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setScheduleUploadError("");

    const fileInput = $("schedule-upload-file");
    const file      = (fileInput && fileInput.files && fileInput.files[0]) || null;
    const validationErr = validateScheduleFile(file);
    if (validationErr) {
      setScheduleUploadError(validationErr);
      return;
    }

    if (!window.firebase ||
        typeof firebase.storage !== "function" ||
        typeof firebase.firestore !== "function") {
      setScheduleUploadError("Storage / Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    const submitBtn = $("schedule-upload-submit");
    if (submitBtn) submitBtn.disabled = true;

    const storagePath = makeScheduleStoragePath(file);
    const ref         = firebase.storage().ref(storagePath);

    try {
      setScheduleUploadStatus("Uploading " + file.name + "…");
      const snap        = await ref.put(file, { contentType: file.type || undefined });
      const downloadUrl = await snap.ref.getDownloadURL();

      const effectiveMonthEl = $("schedule-upload-effective-month");
      const notesEl          = $("schedule-upload-notes");
      const effectiveMonth   = (effectiveMonthEl && effectiveMonthEl.value) || "";
      const notes            = (notesEl && notesEl.value || "").trim();

      const u = firebase.auth().currentUser;
      const uploadedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };

      setScheduleUploadStatus("Saving to Firestore…");
      await firebase.firestore().collection("team_schedule").doc(TEAM_SCHEDULE_DOC_ID).set({
        fileName:       file.name || "team-schedule",
        storagePath:    storagePath,
        downloadUrl:    downloadUrl,
        contentType:    file.type || "application/octet-stream",
        byteSize:       file.size || 0,
        uploadedAt:     firebase.firestore.FieldValue.serverTimestamp(),
        uploadedBy:     uploadedBy,
        effectiveMonth: effectiveMonth || null,
        notes:          notes || null,
        active:         true
      }, { merge: false });

      // Reset the form and refresh the summary card.
      if (fileInput)        fileInput.value = "";
      if (notesEl)          notesEl.value   = "";
      // Leave effectiveMonth as-is — admins often upload the same month twice.
      setScheduleUploadStatus("Published. Team Hub will pick this up on next page load.");
      await loadTeamSchedule();
    } catch (err) {
      console.error("schedule upload failed", err);
      const friendly = (err && err.code === "storage/unauthorized")
        ? "Upload denied by Storage rules. Confirm you're signed in as an admin and storage.rules has the team-schedules block deployed."
        : (err && err.code === "permission-denied")
        ? "Firestore write denied. Confirm firestore.rules has the team_schedule block deployed."
        : ("Upload failed: " + (err && (err.message || err.code)) || "unknown error");
      setScheduleUploadError(friendly);
      setScheduleUploadStatus("");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ====================================================================
     Published Team Schedule (Deputy-powered)
     ====================================================================
     Snapshot model — admins publish on demand by reading the next 14
     days from `deputy_shift_cache` and writing a normalized snapshot to
     `published_team_schedule/current`. Team Hub reads that doc only;
     it does NOT reflect live Deputy edits.

     The Deputy scheduled sync only writes TODAY's shifts (every 10 min),
     so future days only appear in cache after an admin runs
     `refreshDeputyShiftsV1` for each future date — that loop is a
     Phase 2 follow-up (auto-sync future days as part of publish).

     Phase 2 TODOs (mirror admin.html + firestore.rules):
       • monthly calendar view + printable export
       • personal "my schedule" filtering on the tech side
       • shift swaps / PTO overlays / open-shift coverage
       • live vs deferred publish modes (currently always deferred)
       • auto-sync future Deputy days as part of publish
       • server-side publish (Cloud Function) so a scheduled job can
         re-publish nightly without an admin browser open */
  const PUBLISHED_SCHEDULE_DOC_ID    = "current";
  const PUBLISHED_SCHEDULE_HORIZONS  = [7, 14, 21];  // allowed values
  const PUBLISHED_SCHEDULE_DEFAULT   = 21;
  const PUBLISHED_SCHEDULE_MAX_SHIFTS = 1200;        // safety cap (21d × ~50 shifts/day)

  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year:  "numeric", month: "2-digit", day:   "2-digit"
    }).format(d);
  }

  /* --------------------------------------------------------------------
   * getOpsDayWindow — Pioneer operational day boundaries.
   *
   * The "operational day" begins at 4 PM Pacific (office staff close
   * out the previous workday) and ends at 4 PM the next day. Midnight-
   * to-midnight stats are less useful because cleaning techs work
   * overnight and the office wants their morning view to STILL reflect
   * last night's work.
   *
   * Returns the current ops-day window + the previous one + a human
   * label describing which physical hours the current window covers.
   *
   * Pure date math. No Firestore. No network.
   * ------------------------------------------------------------------ */
  function getOpsDayWindow(now, cutoffHour, timezone) {
    now         = now         || new Date();
    cutoffHour  = (cutoffHour  != null) ? cutoffHour  : 16;
    timezone    = timezone     || "America/Los_Angeles";

    // What's the Pacific wall-clock hour:minute:second right now?
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
    function partVal(name) {
      const p = parts.find(function (x) { return x.type === name; });
      return p ? parseInt(p.value, 10) : 0;
    }
    const h = partVal("hour");
    const m = partVal("minute");
    const s = partVal("second");

    // How many ms have elapsed since the most recent 4 PM Pacific
    // boundary? If we're past today's cutoff, that boundary was today
    // at the cutoff hour; otherwise it was yesterday at the cutoff hour.
    const isPastCutoff = (h >= cutoffHour);
    const hoursSince = isPastCutoff
      ? (h - cutoffHour)
      : (h + (24 - cutoffHour));
    const msSince = (hoursSince * 3600 + m * 60 + s) * 1000;

    // Anchor to the boundary by subtracting the elapsed ms from `now`.
    // This sidesteps DST gotchas: we're stepping back a wall-clock
    // duration that's already in the Pacific frame.
    const currentOpsStart  = new Date(now.getTime() - msSince);
    const currentOpsEnd    = new Date(currentOpsStart.getTime() + 86400000);
    const previousOpsStart = new Date(currentOpsStart.getTime() - 86400000);
    const previousOpsEnd   = new Date(currentOpsStart.getTime());

    const opsDayLabel = isPastCutoff
      ? "Today 4 PM → Tomorrow 4 PM"
      : "Yesterday 4 PM → Today 4 PM";

    return {
      currentOpsStart:  currentOpsStart,
      currentOpsEnd:    currentOpsEnd,
      previousOpsStart: previousOpsStart,
      previousOpsEnd:   previousOpsEnd,
      opsDayLabel:      opsDayLabel
    };
  }

  function addDaysPacific(yyyymmdd, days) {
    // Add `days` to a YYYY-MM-DD string, working in UTC to avoid DST
    // drift, then re-format in Pacific. Sufficient for a 14-day window.
    const base = new Date(yyyymmdd + "T12:00:00Z");
    base.setUTCDate(base.getUTCDate() + days);
    return pacificDateString(base);
  }

  function tsToMillis(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts.toDate   === "function") return ts.toDate().getTime();
    return null;
  }

  function formatPacificTimeOfDay(ms) {
    if (ms == null) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms)).replace(/\s+/g, "").toLowerCase();
    } catch (_e) {
      return "";
    }
  }

  function weekdayLabelFromDate(yyyymmdd) {
    if (!yyyymmdd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) {
      return "";
    }
  }

  function setPublishedStatus(state) {
    const ids = [
      "schedule-published-loading",
      "schedule-published-error",
      "schedule-published-empty",
      "schedule-published-summary"
    ];
    ids.forEach(function (id) { const el = $(id); if (el) el.hidden = true; });
    if (state) {
      const target = $("schedule-published-" + state);
      if (target) target.hidden = false;
    }
  }

  function setPublishedError(message) {
    const el = $("schedule-published-error");
    if (!el) return;
    el.textContent = message || "Couldn't load the published snapshot.";
    setPublishedStatus("error");
  }

  function setPublishStatus(text) {
    const el = $("schedule-publish-status");
    if (el) el.textContent = text || "";
  }

  function setPublishError(message) {
    const el = $("schedule-publish-error");
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function formatPublishedAt(ts) {
    if (!ts) return "Unknown";
    const ms = tsToMillis(ts);
    if (ms == null) return "Unknown";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderPublishedSnapshot(doc) {
    const data = (doc && doc.data && doc.data()) || null;
    const metaSub = $("schedule-published-meta");
    if (!data || data.active === false) {
      if (metaSub) metaSub.textContent = "Nothing published yet.";
      setPublishedStatus("empty");
      return;
    }
    const whenEl    = $("schedule-published-when");
    const rangeEl   = $("schedule-published-range");
    const countEl   = $("schedule-published-count");
    const techsEl   = $("schedule-published-techs");
    const notesEl   = $("schedule-published-notes");
    if (whenEl)  whenEl.textContent  = formatPublishedAt(data.publishedAt) + " by " +
      ((data.publishedBy && (data.publishedBy.displayName || data.publishedBy.email)) || "an admin");
    if (rangeEl) rangeEl.textContent = (data.startDate || "—") + " → " + (data.endDate || "—");
    if (countEl) countEl.textContent = String(data.shiftCount || (Array.isArray(data.shifts) ? data.shifts.length : 0));
    if (techsEl) {
      const techSet = new Set();
      (data.shifts || []).forEach(function (s) {
        const name = (s.techName || "").trim();
        if (name) techSet.add(name);
      });
      techsEl.textContent = String(techSet.size);
    }
    if (notesEl) {
      if (data.notes) { notesEl.textContent = data.notes; notesEl.hidden = false; }
      else            { notesEl.hidden = true; notesEl.textContent = ""; }
    }
    if (metaSub) {
      metaSub.textContent =
        "Last published " + formatPublishedAt(data.publishedAt) +
        " · " + (data.shiftCount || 0) + " shifts · range " +
        (data.startDate || "—") + " → " + (data.endDate || "—");
    }
    setPublishedStatus("summary");
  }

  async function loadPublishedSnapshot() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setPublishedError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }
    setPublishedStatus("loading");
    try {
      const snap = await firebase.firestore()
        .collection("published_team_schedule").doc(PUBLISHED_SCHEDULE_DOC_ID).get();
      if (!snap.exists) { setPublishedStatus("empty"); return; }
      renderPublishedSnapshot(snap);
    } catch (err) {
      console.error("loadPublishedSnapshot failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm firestore.rules has the published_team_schedule block deployed."
        : ("Couldn't load the published snapshot: " + (err && (err.message || err.code)) || "unknown error");
      setPublishedError(friendly);
    }
  }

  // Build a normalized shift record from a raw deputy_shift_cache doc.
  // Drops shifts with no start_time or no employee match — those are
  // not actionable on the published schedule.
  // customer-by-slug lookup populated by buildCustomerLookupForPublish()
  // before each publish run. Empty by default; normalizeDeputyShift only
  // applies the canonical helper when this is populated.
  let _publishCustomerBySlug = Object.create(null);

  function buildCustomerLookupForPublish(customerDocs) {
    const map = Object.create(null);
    (customerDocs || []).forEach(function (c) {
      const slug = String((c && (c.customer_slug || c.slug || c.id)) || "").trim();
      if (slug) map[slug] = c;
    });
    _publishCustomerBySlug = map;
  }

  function normalizeDeputyShift(raw) {
    const startMs = tsToMillis(raw.start_time);
    const endMs   = tsToMillis(raw.end_time);
    if (startMs == null) return null;
    const techName     = String(raw.employee_display_name || "").trim() ||
                         String(raw.employee_email || "").trim();
    if (!techName) return null;
    // Customer name precedence — match today-work.js conventions:
    //   1. sync-resolved (deputy_company_id → customers.customer_slug)
    //   2. high-confidence suggested alias
    //   3. raw Deputy location/company name (unresolved, marked as such)
    let customerName = String(raw.customer_name || "").trim();
    let customerSlug = String(raw.customer_slug || "").trim();
    if (!customerName) {
      const sugg = String(raw.suggested_customer_name || "").trim();
      if (sugg) { customerName = sugg; customerSlug = String(raw.suggested_customer_slug || "").trim(); }
    }
    if (!customerName) {
      customerName = String(raw.company_name || raw.deputy_location_name || "Unassigned").trim();
    }

    // Canonical display via the helper — when the customer slug resolves
    // to a doc we have, apply displayNameMode + customDisplayName so the
    // published snapshot shows the same string Team Hub / Team Schedule
    // and every other surface uses. Logs at [DisplayNamePublish] for
    // each row so the office can confirm matching during a publish.
    const rawCustomerName = customerName;
    const matchedDoc = customerSlug ? _publishCustomerBySlug[customerSlug] : null;
    if (matchedDoc && window.PioneerCustomerDisplay) {
      const helperName = window.PioneerCustomerDisplay.getCustomerDisplayName(matchedDoc);
      if (helperName) customerName = helperName;
    }
    try {
      console.info("[DisplayNamePublish]", {
        rawCustomerName:    rawCustomerName,
        customerSlug:       customerSlug || "(none)",
        matchedCustomerDoc: matchedDoc ? (matchedDoc.id || matchedDoc.customer_slug || "(no-id)") : null,
        displayNameMode:    matchedDoc ? (matchedDoc.displayNameMode || matchedDoc.display_name_mode || "(unset)") : null,
        customDisplayName:  matchedDoc ? (matchedDoc.customDisplayName || matchedDoc.custom_display_name || "(unset)") : null,
        location_name:      matchedDoc ? (matchedDoc.location_name || "(unset)") : null,
        finalDisplayName:   customerName
      });
    } catch (_e) {}

    return {
      date:           String(raw.sync_date || ""),
      weekday:        weekdayLabelFromDate(raw.sync_date),
      startTime:      formatPacificTimeOfDay(startMs),
      endTime:        endMs == null ? "" : formatPacificTimeOfDay(endMs),
      startMs:        startMs,
      endMs:          endMs,
      techName:       techName,
      techSlug:       String(raw.employee_slug || "").trim(),
      customerName:   customerName,
      customerSlug:   customerSlug,
      status:         String(raw.status || "scheduled"),
      deputyShiftUrl: String(raw.deputy_shift_url || "")
    };
  }

  function readPublishHorizon() {
    const checked = document.querySelector("input[name='schedule-publish-horizon']:checked");
    const raw = checked && Number(checked.value);
    if (PUBLISHED_SCHEDULE_HORIZONS.indexOf(raw) >= 0) return raw;
    return PUBLISHED_SCHEDULE_DEFAULT;
  }

  async function syncDeputyRangeBeforePublish(today, endDay) {
    const url = (window.REFRESH_DEPUTY_SHIFTS_RANGE_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("REFRESH_DEPUTY_SHIFTS_RANGE_URL is not configured.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + idToken,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ start_date: today, end_date: endDay })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      throw new Error((body && body.error) || ("HTTP " + res.status));
    }
    return body;
  }

  // Render the per-day publish breakdown into the <details> panel
  // below the form. Lists every date in the horizon with: Deputy
  // fetch count (from the range-refresh result, if it ran) and
  // cache-doc count (from the read we did to build the snapshot).
  // Zero-shift dates get a "0 shifts" visual treatment so admins
  // immediately see which days are thin in Deputy.
  function renderPublishDebug(data) {
    const root = $("schedule-publish-debug");
    const body = $("schedule-publish-debug-body");
    if (!root || !body) return;
    if (!data) { root.hidden = true; body.innerHTML = ""; return; }

    const dateList = data.dates || [];
    const syncMap  = data.sync_per_day || {};   // date → {upserted, fetched, ok, error}
    const cacheMap = data.cache_per_day || {};  // date → count (after filter)

    const rows = dateList.map(function (d) {
      const sync = syncMap[d] || null;
      const c    = (typeof cacheMap[d] === "number") ? cacheMap[d] : 0;
      const syncCell = sync
        ? (sync.ok
            ? ('Deputy: ' + (sync.upserted_count || 0) + ' upserted (' + (sync.fetched_count || 0) + ' fetched)')
            : ('<span class="schedule-publish-debug-fail">Deputy sync failed: ' + escapeHtmlForDebug(sync.error || 'unknown') + '</span>'))
        : '<span class="schedule-publish-debug-muted">Deputy sync skipped</span>';
      const cacheCell = c === 0
        ? '<span class="schedule-publish-debug-zero">0 shifts</span>'
        : (c + ' shift' + (c === 1 ? '' : 's'));
      return (
        '<tr>' +
          '<td>' + escapeHtmlForDebug(d) + '</td>' +
          '<td>' + syncCell + '</td>' +
          '<td>' + cacheCell + '</td>' +
        '</tr>'
      );
    }).join("");

    const zeroDates = dateList.filter(function (d) { return !cacheMap[d]; });
    const zeroSummary = zeroDates.length
      ? ('<p class="schedule-publish-debug-zero-summary"><strong>' +
         zeroDates.length + ' of ' + dateList.length + ' day(s)</strong> ended with zero shifts in cache: ' +
         zeroDates.map(escapeHtmlForDebug).join(', ') + '</p>')
      : '<p class="schedule-publish-debug-zero-summary">Every day in the horizon has at least one cached shift.</p>';

    body.innerHTML =
      '<p class="schedule-publish-debug-range"><strong>Requested range:</strong> ' +
        escapeHtmlForDebug(data.start_date) + ' → ' + escapeHtmlForDebug(data.end_date) +
        ' (' + dateList.length + ' days)</p>' +
      '<p><strong>Total shifts published:</strong> ' + (data.total_published || 0) + '</p>' +
      zeroSummary +
      '<table class="schedule-publish-debug-table">' +
        '<thead><tr><th>Date</th><th>Deputy sync</th><th>Cache after sync</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';

    root.hidden = false;
    // Auto-open the details so the admin sees the result without
    // having to click the disclosure.
    root.open = true;
  }

  function escapeHtmlForDebug(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function onPublishScheduleSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setPublishError("");
    setPublishStatus("");
    renderPublishDebug(null);

    if (!window.firebase || typeof firebase.firestore !== "function") {
      setPublishError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    const submitBtn = $("schedule-publish-submit");
    if (submitBtn) submitBtn.disabled = true;

    try {
      const horizon = readPublishHorizon();
      const today   = pacificDateString(new Date());
      const endDay  = addDaysPacific(today, horizon - 1);

      // Build the full date list for the per-day debug output.
      const allDates = [];
      for (let i = 0; i < horizon; i++) allDates.push(addDaysPacific(today, i));
      const syncPerDay = {};

      // Step 1 (optional, default ON): server-side Deputy refresh for
      // every day in the horizon. Without this, the published snapshot
      // would reflect only today's shifts (the scheduled sync only
      // covers today). See `refreshDeputyShiftsRangeV1` in functions/.
      const syncFirstEl = $("schedule-publish-sync-first");
      const syncFirst   = !syncFirstEl || syncFirstEl.checked !== false;
      if (syncFirst) {
        setPublishStatus(
          "Syncing Deputy for " + today + " → " + endDay + " (" + horizon + " days) — this can take 20–60s…"
        );
        try {
          const syncBody = await syncDeputyRangeBeforePublish(today, endDay);
          const agg      = (syncBody && syncBody.aggregate) || {};
          (syncBody && Array.isArray(syncBody.per_day) ? syncBody.per_day : []).forEach(function (d) {
            if (d && d.sync_date) syncPerDay[d.sync_date] = d;
          });
          setPublishStatus(
            "Deputy sync complete: " + (agg.upserted_count || 0) + " shifts upserted across " +
            ((syncBody && syncBody.days) || horizon) + " day(s), " +
            (agg.failed_days || 0) + " failed. Building snapshot…"
          );
        } catch (syncErr) {
          // Surface but don't abort — admin can still publish whatever
          // is currently in cache. Don't silently move on; record the
          // failure so the debug panel makes it obvious.
          allDates.forEach(function (d) {
            syncPerDay[d] = { sync_date: d, ok: false, error: (syncErr && syncErr.message) || String(syncErr) };
          });
          setPublishStatus(
            "Deputy sync failed (continuing with cached data): " +
            (syncErr && syncErr.message || syncErr) + ". Building snapshot…"
          );
        }
      } else {
        setPublishStatus("Reading Deputy shifts " + today + " → " + endDay + "…");
      }

      // Single inequality on sync_date keeps us inside a single-field
      // index. We filter the upper bound + status in memory.
      const snap = await firebase.firestore()
        .collection("deputy_shift_cache")
        .where("sync_date", ">=", today)
        .get();

      const rawDocs = snap.docs.map(function (d) { return d.data() || {}; });
      const horizonRaw = rawDocs.filter(function (raw) {
        const sd = String(raw.sync_date || "");
        if (!sd || sd > endDay) return false;
        if ((raw.status || "scheduled") === "cancelled") return false;
        return true;
      });

      // Build per-day cache counts for the debug panel.
      const cachePerDay = {};
      allDates.forEach(function (d) { cachePerDay[d] = 0; });
      horizonRaw.forEach(function (raw) {
        const d = String(raw.sync_date || "");
        if (cachePerDay[d] == null) cachePerDay[d] = 0;
        cachePerDay[d] += 1;
      });

      // Populate the customer-by-slug lookup so normalizeDeputyShift can
      // apply the canonical display helper. One-shot read; cached in
      // _publishCustomerBySlug for the duration of this publish call.
      try {
        const custSnap = await firebase.firestore().collection("customers").get();
        const customerDocs = custSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        buildCustomerLookupForPublish(customerDocs);
      } catch (_e) { buildCustomerLookupForPublish([]); }

      let shifts = horizonRaw
        .map(normalizeDeputyShift)
        .filter(function (x) { return !!x; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          if (a.startMs !== b.startMs) return a.startMs - b.startMs;
          return a.techName.localeCompare(b.techName);
        });

      if (shifts.length > PUBLISHED_SCHEDULE_MAX_SHIFTS) {
        shifts = shifts.slice(0, PUBLISHED_SCHEDULE_MAX_SHIFTS);
      }

      const notesEl = $("schedule-publish-notes");
      const notes   = (notesEl && notesEl.value || "").trim();
      const u       = firebase.auth().currentUser;
      const publishedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };

      setPublishStatus("Writing snapshot (" + shifts.length + " shifts)…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID).set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy:       publishedBy,
          startDate:         today,
          endDate:           endDay,
          viewRangeDays:     horizon,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             notes || null,
          active:            true
        }, { merge: false });

      // Clear notes; leave the form open so the admin sees the
      // refreshed summary.
      if (notesEl) notesEl.value = "";

      if (shifts.length === 0) {
        setPublishStatus(
          "Published. 0 shifts in cache for " + today + " → " + endDay + " " +
          "(" + horizon + " days). See the per-day breakdown below — if Deputy " +
          "returned shifts but nothing landed in the cache, that's a sync issue. " +
          "If both columns read 0, Deputy genuinely has no shifts in that range."
        );
      } else {
        setPublishStatus(
          "Published " + shifts.length + " shifts over " + horizon + " days " +
          "(" + today + " → " + endDay + "). Team Hub will pick this up on next page load."
        );
      }

      // Always render the debug breakdown — even on success — so
      // admins can spot zero-shift dates and act on them.
      renderPublishDebug({
        start_date:      today,
        end_date:        endDay,
        dates:           allDates,
        sync_per_day:    syncPerDay,
        cache_per_day:   cachePerDay,
        total_published: shifts.length
      });
      await loadPublishedSnapshot();
    } catch (err) {
      console.error("publishTeamSchedule failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm you're signed in as an admin and firestore.rules has the published_team_schedule + deputy_shift_cache blocks deployed."
        : ("Publish failed: " + (err && (err.message || err.code)) || "unknown error");
      setPublishError(friendly);
      setPublishStatus("");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ====================================================================
     Primary "Sync next N days from Deputy" workflow.

     Same pipeline as onPublishScheduleSubmit (Deputy range refresh →
     read deputy_shift_cache → write published_team_schedule/current)
     but driven by a single button with hardcoded sensible defaults
     (21-day horizon, sync-first ON, no notes). The advanced publish
     form below remains for fine-grained control.
     ==================================================================== */
  function setSyncStatus(text) {
    const el = $("schedule-sync-status");
    if (!el) return;
    if (text) { el.textContent = text; el.hidden = false; }
    else      { el.textContent = "";   el.hidden = true; }
  }
  function setSyncError(msg) {
    const el = $("schedule-sync-error");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = "";  el.hidden = true; }
  }
  function setSyncSuccess(payload) {
    const card = $("schedule-sync-success");
    if (!card) return;
    if (!payload) { card.hidden = true; return; }
    const sh = $("schedule-sync-success-shifts");
    const rn = $("schedule-sync-success-range");
    const wh = $("schedule-sync-success-when");
    if (sh) sh.textContent = String(payload.shiftCount) +
                             (payload.shiftCount === 1 ? " shift" : " shifts");
    if (rn) rn.textContent = formatRangeHuman(payload.startDate, payload.endDate);
    if (wh) wh.textContent = formatSyncWhen(payload.publishedAtMs);
    card.hidden = false;
  }
  function formatRangeHuman(startYmd, endYmd) {
    function fmt(ymd) {
      if (!ymd) return "";
      try {
        const d = new Date(ymd + "T12:00:00-07:00");
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles", month: "short", day: "numeric"
        }).format(d);
      } catch (_e) { return ymd; }
    }
    const s = fmt(startYmd);
    const e = fmt(endYmd);
    return s && e ? (s + " – " + e) : (s || e || "—");
  }
  function formatSyncWhen(ms) {
    if (!ms) return "just now";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "just now"; }
  }

  async function onSyncFromDeputyClick() {
    const SYNC_DAYS = 21;
    const btn = $("schedule-sync-now-btn");
    setSyncError("");
    setSyncSuccess(null);

    if (!window.firebase || typeof firebase.firestore !== "function") {
      setSyncError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.textContent   = "Syncing…";
    }
    setSyncStatus("Pulling the next " + SYNC_DAYS + " days from Deputy — this can take 20–60 seconds.");

    const today  = pacificDateString(new Date());
    const endDay = addDaysPacific(today, SYNC_DAYS - 1);

    // For the per-day breakdown panel (kept available under a disclosure
    // for the office that wants to triage zero-shift days).
    const allDates = [];
    for (let i = 0; i < SYNC_DAYS; i++) allDates.push(addDaysPacific(today, i));
    const syncPerDay = {};

    try {
      // 1. Refresh deputy_shift_cache for every day in the range.
      let deputyOk = true;
      try {
        const syncBody = await syncDeputyRangeBeforePublish(today, endDay);
        (syncBody && Array.isArray(syncBody.per_day) ? syncBody.per_day : []).forEach(function (d) {
          if (d && d.sync_date) syncPerDay[d.sync_date] = d;
        });
      } catch (syncErr) {
        deputyOk = false;
        allDates.forEach(function (d) {
          syncPerDay[d] = { sync_date: d, ok: false, error: (syncErr && syncErr.message) || String(syncErr) };
        });
        // Don't abort — we can still publish from whatever's already in
        // the cache. Note it on the error banner so the office knows
        // the data may not be fresh.
        console.warn("[schedule-sync] Deputy refresh failed; publishing from cache", syncErr);
      }

      // 2. Read the post-refresh cache for the horizon.
      setSyncStatus("Reading Deputy shifts and building snapshot…");
      const snap = await firebase.firestore()
        .collection("deputy_shift_cache")
        .where("sync_date", ">=", today)
        .get();
      const rawDocs = snap.docs.map(function (d) { return d.data() || {}; });
      const horizonRaw = rawDocs.filter(function (raw) {
        const sd = String(raw.sync_date || "");
        if (!sd || sd > endDay) return false;
        if ((raw.status || "scheduled") === "cancelled") return false;
        return true;
      });
      const cachePerDay = {};
      allDates.forEach(function (d) { cachePerDay[d] = 0; });
      horizonRaw.forEach(function (raw) {
        const d = String(raw.sync_date || "");
        if (cachePerDay[d] == null) cachePerDay[d] = 0;
        cachePerDay[d] += 1;
      });

      // 3. Populate customer lookup so the helper applies inside
      //    normalizeDeputyShift. One-shot per sync run.
      try {
        const custSnap = await firebase.firestore().collection("customers").get();
        const customerDocs = custSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        buildCustomerLookupForPublish(customerDocs);
      } catch (_e) { buildCustomerLookupForPublish([]); }

      // 4. Normalize + sort.
      let shifts = horizonRaw
        .map(normalizeDeputyShift)
        .filter(function (x) { return !!x; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          if (a.startMs !== b.startMs) return a.startMs - b.startMs;
          return a.techName.localeCompare(b.techName);
        });
      if (shifts.length > PUBLISHED_SCHEDULE_MAX_SHIFTS) {
        shifts = shifts.slice(0, PUBLISHED_SCHEDULE_MAX_SHIFTS);
      }

      // 4. Write the snapshot.
      const u = firebase.auth().currentUser;
      const publishedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };
      const nowMs = Date.now();
      await firebase.firestore()
        .collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID)
        .set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy:       publishedBy,
          startDate:         today,
          endDate:           endDay,
          viewRangeDays:     SYNC_DAYS,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             null,
          source:            "deputy_sync",
          active:            true
        }, { merge: false });

      // 5. Show success summary + render the per-day breakdown for
      //    anyone who opens the disclosure.
      setSyncStatus("");
      setSyncSuccess({
        shiftCount:    shifts.length,
        startDate:     today,
        endDate:       endDay,
        publishedAtMs: nowMs
      });
      renderSyncDebug({
        dates:           allDates,
        sync_per_day:    syncPerDay,
        cache_per_day:   cachePerDay,
        total_published: shifts.length
      });

      // 6. Refresh the published-snapshot summary card so the existing
      //    "current snapshot" panel reflects the new state too.
      try { await loadPublishedSnapshot(); } catch (_e) {}

      // 7. Tasteful celebration — schedule publish is a milestone moment.
      try { if (window.PioneerCelebrate) window.PioneerCelebrate.fire({ intensity: "medium" }); } catch (_e) {}

      // 8. Soft-warn if Deputy was unreachable but we published from cache.
      if (!deputyOk) {
        setSyncError(
          "Deputy was unreachable, so we published the most recent cached shifts. " +
          "Try Sync again in a few minutes if you suspect the schedule has changed."
        );
      }
    } catch (err) {
      console.error("[schedule-sync] failed", err);
      // Friendly first; technical detail goes in the console for Nick.
      const code    = err && err.code;
      const message = err && err.message;
      let friendly;
      if (code === "permission-denied") {
        friendly = "Access denied. You may need to sign out and back in as an admin.";
      } else if (/Deputy|sync|429|HTTP/i.test(String(message || ""))) {
        friendly = "We could not reach Deputy. Try again in a few minutes or ask Nick.";
      } else {
        friendly = "Schedule sync didn't complete. Try again in a few minutes or ask Nick.";
      }
      setSyncError(friendly);
      setSyncStatus("");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.label || "Sync next 21 days from Deputy";
      }
    }
  }

  // Per-day breakdown rendered into the disclosure under the success card.
  // Same shape as the advanced publish-form debug panel.
  function renderSyncDebug(data) {
    const root = $("schedule-sync-debug");
    const body = $("schedule-sync-debug-body");
    if (!root || !body) return;
    if (!data) { root.hidden = true; body.innerHTML = ""; return; }
    const dateList = data.dates || [];
    const syncMap  = data.sync_per_day || {};
    const cacheMap = data.cache_per_day || {};
    const rows = dateList.map(function (d) {
      const sync = syncMap[d] || null;
      const c    = (typeof cacheMap[d] === "number") ? cacheMap[d] : 0;
      const syncCell = sync
        ? (sync.ok
            ? ('Deputy: ' + (sync.upserted_count || 0) + ' upserted')
            : ('<span class="schedule-publish-debug-fail">Deputy sync failed: ' + escapeHtmlForDebug(sync.error || 'unknown') + '</span>'))
        : '<span class="schedule-publish-debug-muted">Deputy sync skipped</span>';
      return '<tr><td>' + escapeHtmlForDebug(d) + '</td>' +
             '<td>' + syncCell + '</td>' +
             '<td>' + c + ' in cache</td></tr>';
    }).join("");
    body.innerHTML =
      '<table class="schedule-publish-debug-table"><thead>' +
        '<tr><th>Date</th><th>Deputy sync</th><th>Cache</th></tr>' +
      '</thead><tbody>' + rows + '</tbody></table>' +
      '<p class="schedule-publish-debug-foot">Published ' + (data.total_published || 0) + ' shift(s) across ' + dateList.length + ' day(s).</p>';
    root.hidden = false;
  }

  /* ====================================================================
     Schedule Import V1 — paste/PDF → draft → publish
     ====================================================================
     Primary path while Deputy's future-day API is unreliable.
     Pipeline:
       1. Admin pastes text (or clicks "Extract from current PDF" — PDF.js
          loaded lazily from CDN).
       2. parseScheduleText() runs a line-based heuristic parser against
          the cleaning_techs + customers caches. Each output shift gets
          a `source: "pdf_import" | "manual"` stamp and a 0..1
          confidence score.
       3. Draft is rendered as an editable table; admin fixes
          mismatches, adds/removes rows.
       4. "Publish from draft" normalizes the rows into the same shape
          `published_team_schedule/current` already uses (date, startMs,
          endMs, techSlug, customerSlug, …) and overwrites the doc.
          The existing Team Hub + /team-schedule renderers pick it up
          without any further change.

     Phase 2 TODO (mirror admin.html):
       • improve parser heuristics with sample real-world PDFs
       • sync direct from Deputy when range API is reliable
       • detect changes week-to-week (diff vs previous draft)
       • auto-highlight updated shifts in the editor
       • OCR fallback for image-only PDFs
       • per-tech color preview in the editor table */

  const SCHEDULE_DRAFT_DOC_ID    = "draft";
  const SCHEDULE_PARSER_VERSION  = "v1";
  // Bumping the rev forces stale rendered rows to invalidate when the
  // admin re-parses without leaving the page. The rev is used as the
  // key prefix for row ids.
  let scheduleDraftRev = 0;
  let scheduleDraftRows = [];     // in-memory editable rows

  function setImportStatus(text) {
    const el = $("schedule-import-status");
    if (el) el.textContent = text || "";
  }
  function setImportError(msg) {
    const el = $("schedule-import-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg; el.hidden = false;
  }
  function setDraftStatus(text) {
    const el = $("schedule-draft-status");
    if (el) el.textContent = text || "";
  }
  function setDraftError(msg) {
    const el = $("schedule-draft-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg; el.hidden = false;
  }

  /* ---------- PDF.js lazy loader ---------- */
  let pdfJsLoading = null;
  function loadPdfJsOnce() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsLoading) return pdfJsLoading;
    pdfJsLoading = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload  = function () {
        if (!window.pdfjsLib) { reject(new Error("PDF.js loaded but global missing")); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error("PDF.js failed to load from CDN")); };
      document.head.appendChild(s);
    });
    return pdfJsLoading;
  }
  async function extractPdfText(url) {
    const pdfjs = await loadPdfJsOnce();
    scheduleExtractLog("pdfjs loaded", { version: pdfjs && pdfjs.version });
    const loadingTask = pdfjs.getDocument(url);
    const pdf = await loadingTask.promise;
    scheduleExtractLog("pdf opened", { numPages: pdf.numPages });
    let lines = [];
    let perPageCounts = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // PDF.js gives us items with `str` + positional metadata. The
      // positional data could be used to reconstruct columns, but the
      // line-based parser works fine on a flat newline-joined dump
      // for most Pioneer-style schedules.
      const pageText = content.items.map(function (i) { return i.str; }).join("\n");
      lines.push(pageText);
      perPageCounts.push(pageText.length);
    }
    scheduleExtractLog("text extracted", { perPageCounts: perPageCounts });
    return lines.join("\n\n");
  }

  // Always-on diagnostic prefix for the PDF extract flow. Pure client
  // side — no Cloud Function involved — so the trace lives in the
  // admin's own console. Failures bubble through here on every step.
  function scheduleExtractLog(label, meta) {
    try { console.info("[ScheduleExtract] " + label, meta || ""); }
    catch (_e) {}
  }
  function scheduleExtractWarn(label, meta) {
    try { console.warn("[ScheduleExtract] " + label, meta || ""); }
    catch (_e) {}
  }

  // Pre-flight reachability check. Fired before PDF.js so we can give
  // a specific error instead of the generic "Failed to fetch" the
  // library throws when the URL can't be reached. Range: 0-1023 bytes
  // is enough to confirm CORS + reachability without downloading the
  // whole PDF; if the host doesn't support Range, that's also a clear
  // signal we surface in the error path.
  async function pdfUrlIsReachable(url) {
    try {
      const ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      const timeoutMs = 8000;
      const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      const res = await fetch(url, {
        method:  "GET",
        mode:    "cors",
        cache:   "no-store",
        headers: { "Range": "bytes=0-1023" },
        signal:  ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      const ctype = res.headers.get("content-type") || "";
      const status = res.status;
      scheduleExtractLog("preflight result", {
        status:        status,
        ok:            res.ok,
        content_type:  ctype || "(unset)",
        accept_ranges: res.headers.get("accept-ranges") || "(unset)"
      });
      // 200 (full) or 206 (partial) both confirm reachability. Anything
      // else is a hosting/storage problem we should report cleanly.
      if (status !== 200 && status !== 206) {
        return { ok: false, code: "bad_status", status: status, ctype: ctype };
      }
      return { ok: true, status: status, ctype: ctype };
    } catch (err) {
      const name = err && err.name;
      const msg  = (err && err.message) || String(err);
      scheduleExtractWarn("preflight failed", { name: name, message: msg });
      if (name === "AbortError") {
        return { ok: false, code: "timeout", message: msg };
      }
      return { ok: false, code: "network", message: msg };
    }
  }

  /* ---------- Parser ---------- */
  // Build lookup maps from the loaded admin caches. Used by the parser
  // to match free-text "Bonnie" or "baker construction" to canonical
  // cleaning_techs / customers docs.
  function buildSchedulePeopleIndex() {
    const techByKey = new Map();     // lowercased token → tech doc
    const custByKey = new Map();     // lowercased token → customer doc
    (techs || []).forEach(function (t) {
      const name = String(t.display_name || t.name || "").trim();
      if (!name) return;
      techByKey.set(name.toLowerCase(), t);
      // First-name key for casual schedule prose ("Bonnie", "April").
      const first = name.split(/\s+/)[0];
      if (first) techByKey.set(first.toLowerCase(), t);
    });
    (customers || []).forEach(function (c) {
      const name = String(c.customer_name || c.name || c.display_name || "").trim();
      if (!name) return;
      custByKey.set(name.toLowerCase(), c);
      // Each word ≥ 4 chars is a potential keyword match.
      name.split(/\s+/).forEach(function (w) {
        if (w.length >= 4) custByKey.set(w.toLowerCase(), c);
      });
    });
    return { techByKey: techByKey, custByKey: custByKey };
  }

  function matchTechInLine(line, idx) {
    const lower = line.toLowerCase();
    let best = null;
    let bestLen = 0;
    idx.techByKey.forEach(function (tech, key) {
      if (key.length < 2) return;
      if (lower.indexOf(key) >= 0 && key.length > bestLen) {
        best = tech;
        bestLen = key.length;
      }
    });
    return best;
  }
  function matchCustomerInLine(line, idx) {
    const lower = line.toLowerCase();
    let best = null;
    let bestLen = 0;
    idx.custByKey.forEach(function (cust, key) {
      if (key.length < 4) return;
      if (lower.indexOf(key) >= 0 && key.length > bestLen) {
        best = cust;
        bestLen = key.length;
      }
    });
    return best;
  }

  // Parse a date-heading line, e.g. "Wednesday, May 20" / "5/20" /
  // "5/20/2026" / "May 20, 2026". Returns YYYY-MM-DD or null.
  const MONTH_MAP = {
    jan: 1,  january: 1,
    feb: 2,  february: 2,
    mar: 3,  march: 3,
    apr: 4,  april: 4,
    may: 5,
    jun: 6,  june: 6,
    jul: 7,  july: 7,
    aug: 8,  august: 8,
    sep: 9,  september: 9, sept: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };
  function tryParseDate(line, defaultYear) {
    if (!line) return null;
    const cleaned = line.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
    // "May 20" / "May 20 2026"
    const mWord = cleaned.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/);
    if (mWord) {
      const monthKey = mWord[1].toLowerCase();
      const m = MONTH_MAP[monthKey];
      if (m) {
        const d = parseInt(mWord[2], 10);
        let y = mWord[3] ? parseInt(mWord[3], 10) : defaultYear;
        if (y < 100) y += 2000;
        if (d >= 1 && d <= 31) {
          return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        }
      }
    }
    // "5/20" or "5/20/2026" or "5/20/26"
    const mSlash = cleaned.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (mSlash) {
      const m = parseInt(mSlash[1], 10);
      const d = parseInt(mSlash[2], 10);
      let y = mSlash[3] ? parseInt(mSlash[3], 10) : defaultYear;
      if (y < 100) y += 2000;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      }
    }
    // ISO "2026-05-20"
    const mIso = cleaned.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (mIso) return mIso[1] + "-" + mIso[2] + "-" + mIso[3];
    return null;
  }

  // Returns { start24: "HH:MM", end24: "HH:MM" | null } or null.
  function tryParseTimeRange(line) {
    // Tolerant: 5, 5:00, 5am, 5:00am, with optional separator – - to ~
    const re = /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?\s*[-–—~to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?/i;
    const m = line.match(re);
    if (!m) {
      // Try single-time fallback: "5:00am" with no range
      const m1 = line.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)/i);
      if (!m1) return null;
      const startStr = normalizeTime(m1[1], m1[2], m1[3], null);
      return startStr ? { start24: startStr, end24: null } : null;
    }
    // Disambiguate: if only the END has am/pm, infer the start ampm
    // from the end (common in schedules: "5-8:30am").
    const startAm = m[3] || m[6] || null;
    const endAm   = m[6] || m[3] || null;
    const start24 = normalizeTime(m[1], m[2], startAm, "start");
    const end24   = normalizeTime(m[4], m[5], endAm,   "end");
    if (!start24) return null;
    return { start24: start24, end24: end24 };
  }
  function normalizeTime(hh, mm, ampm, position) {
    let h = parseInt(hh, 10);
    if (isNaN(h) || h < 0 || h > 23) return null;
    let m = mm ? parseInt(mm, 10) : 0;
    if (isNaN(m) || m < 0 || m > 59) m = 0;
    const ap = (ampm || "").toLowerCase().replace(/\./g, "")[0]; // "a"|"p"|""
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    // No am/pm at all: leave as-is (assume 24h or admin will fix).
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  function buildLocalTimestamp(yyyymmdd, hhmm) {
    if (!yyyymmdd || !hhmm) return null;
    // Pacific time anchor — uses a fixed -07:00/-08:00 offset by way
    // of `Date.UTC` plus offset calc. To keep this simple + correct
    // across DST we anchor at the wall-clock representation in
    // Pacific via Intl and then re-parse. For pilot precision, we
    // accept that DST boundary days might land off by an hour; the
    // admin can correct in the editor if needed.
    const [h, m] = hhmm.split(":").map(function (s) { return parseInt(s, 10); });
    const [yy, mm, dd] = yyyymmdd.split("-").map(function (s) { return parseInt(s, 10); });
    // Build a "noon-of-day-in-UTC" anchor, then compute Pacific
    // offset for that date, then subtract that offset.
    const noonUTC = Date.UTC(yy, mm - 1, dd, 12, 0, 0);
    const pacificParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", timeZoneName: "shortOffset"
    }).formatToParts(new Date(noonUTC));
    const offsetPart = pacificParts.find(function (p) { return p.type === "timeZoneName"; });
    // offsetPart.value like "GMT-7" or "GMT-8"
    let offsetHours = -8;
    if (offsetPart && offsetPart.value) {
      const m2 = offsetPart.value.match(/GMT([+-]\d{1,2})/);
      if (m2) offsetHours = parseInt(m2[1], 10);
    }
    return Date.UTC(yy, mm - 1, dd, h - offsetHours, m, 0);
  }

  function format12HourTime(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(function (s) { return parseInt(s, 10); });
    if (isNaN(h)) return "";
    const ap = h >= 12 ? "pm" : "am";
    const h12 = h % 12 || 12;
    return h12 + ":" + String(m || 0).padStart(2, "0") + ap;
  }
  function weekdayLabel(yyyymmdd) {
    if (!yyyymmdd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "long"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return ""; }
  }

  function parseScheduleText(text, opts) {
    opts = opts || {};
    const defaultYear = Number(opts.defaultYear) || new Date().getFullYear();
    const idx = buildSchedulePeopleIndex();
    const rawLines = String(text || "").split(/\r?\n/);
    const lines = rawLines.map(function (l) { return l.replace(/\s+/g, " ").trim(); });

    const out = [];
    let currentDate = null;
    lines.forEach(function (line) {
      if (!line) return;

      // 1. Is this a date heading? If the line has a date but NO time
      //    range, treat it as a heading.
      const dateGuess = tryParseDate(line, defaultYear);
      const timeGuess = tryParseTimeRange(line);
      if (dateGuess && !timeGuess) {
        currentDate = dateGuess;
        return;
      }

      // 2. Otherwise look for a shift row. Must have a time range.
      if (!timeGuess) return;

      // 3. Date precedence: inline date on this row wins; otherwise
      //    use the current heading date.
      const shiftDate = dateGuess || currentDate;
      if (!shiftDate) return; // can't place this row in time

      // 4. Match tech + customer.
      const tech     = matchTechInLine(line, idx);
      const customer = matchCustomerInLine(line, idx);

      // 5. Extract leftover text as notes. Strip the matched tokens
      //    + the time range + any date so the admin sees just the
      //    "extra" parts.
      let notes = line;
      // Strip time range
      notes = notes.replace(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?\s*[-–—~to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?/i, "");
      if (dateGuess) {
        notes = notes
          .replace(/\b([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/, "")
          .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, "")
          .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/, "");
      }
      if (tech) {
        const techName = String(tech.display_name || tech.name || "").trim();
        if (techName) {
          notes = notes.replace(new RegExp(escapeRegex(techName), "ig"), "");
          const first = techName.split(/\s+/)[0];
          if (first) notes = notes.replace(new RegExp("\\b" + escapeRegex(first) + "\\b", "ig"), "");
        }
      }
      if (customer) {
        const custName = String(customer.customer_name || customer.name || "").trim();
        if (custName) notes = notes.replace(new RegExp(escapeRegex(custName), "ig"), "");
      }
      notes = notes.replace(/[-–—|·,:]+/g, " ").replace(/\s+/g, " ").trim();
      // Drop trivial residue
      if (notes.length <= 1) notes = "";

      // Confidence scoring — 0.2 per matched component.
      let conf = 0.2;                  // base (we have a time)
      if (shiftDate) conf += 0.2;
      if (tech)      conf += 0.3;
      if (customer)  conf += 0.2;
      if (timeGuess.end24) conf += 0.1;
      if (conf > 1) conf = 1;

      out.push({
        date:         shiftDate,
        startTime24:  timeGuess.start24,
        endTime24:    timeGuess.end24 || "",
        techSlug:     tech     ? (tech.tech_slug || tech.id || "")     : "",
        techName:     tech     ? (tech.display_name || tech.name || "") : "",
        customerSlug: customer ? (customer.customer_slug || customer.id || "") : "",
        customerName: customer ? (customer.customer_name || customer.name || "") : "",
        notes:        notes,
        source:       opts.source || "manual",
        confidence:   conf
      });
    });

    // Sort by date then time so the editor reads in calendar order.
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime24 || "").localeCompare(b.startTime24 || "");
    });
    return out;
  }
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* ---------- Draft editor ---------- */
  function renderDraftEditor(rows, meta) {
    scheduleDraftRev += 1;
    scheduleDraftRows = (rows || []).slice();
    const block = $("schedule-draft-block");
    const body  = $("schedule-draft-rows");
    const metaEl = $("schedule-draft-meta");
    if (!block || !body) return;

    if (!scheduleDraftRows.length) {
      block.hidden = true;
      body.innerHTML = "";
      return;
    }
    block.hidden = false;
    if (metaEl) {
      const dates = scheduleDraftRows.map(function (r) { return r.date; }).filter(Boolean).sort();
      const minD = dates[0] || "—";
      const maxD = dates[dates.length - 1] || "—";
      const techSet = new Set(scheduleDraftRows.map(function (r) { return r.techSlug || r.techName || ""; }).filter(Boolean));
      const src = (meta && meta.source) || (scheduleDraftRows[0] && scheduleDraftRows[0].source) || "manual";
      metaEl.textContent = scheduleDraftRows.length + " shifts · " + techSet.size + " techs · " +
        minD + " → " + maxD + " · source: " + src;
    }

    const techOptions = (techs || [])
      .filter(function (t) { return (t.display_name || t.name); })
      .sort(function (a, b) {
        return String(a.display_name || a.name).localeCompare(String(b.display_name || b.name));
      })
      .map(function (t) {
        const slug = t.tech_slug || t.id;
        const name = t.display_name || t.name;
        return '<option value="' + escapeAttr(slug) + '">' + escapeHtmlForDebug(name) + '</option>';
      }).join("");
    const custOptions = (customers || [])
      .filter(function (c) { return (c.customer_name || c.name); })
      .sort(function (a, b) {
        return String(a.customer_name || a.name).localeCompare(String(b.customer_name || b.name));
      })
      .map(function (c) {
        const slug = c.customer_slug || c.id;
        const name = c.customer_name || c.name;
        return '<option value="' + escapeAttr(slug) + '">' + escapeHtmlForDebug(name) + '</option>';
      }).join("");

    body.innerHTML = scheduleDraftRows.map(function (r, idx) {
      const conf  = typeof r.confidence === "number" ? r.confidence : 1;
      const isLow = conf < 0.7;
      const confText = Math.round(conf * 100) + "%";
      return (
        '<tr class="schedule-draft-row' + (isLow ? ' is-low-conf' : '') + '" data-idx="' + idx + '">' +
          '<td><input type="date"  data-field="date"        value="' + escapeAttr(r.date || "") + '" /></td>' +
          '<td>' +
            '<select data-field="techSlug">' +
              '<option value="">— pick tech —</option>' +
              techOptions +
            '</select>' +
          '</td>' +
          '<td>' +
            '<select data-field="customerSlug">' +
              '<option value="">— pick customer —</option>' +
              custOptions +
            '</select>' +
          '</td>' +
          '<td><input type="time"  data-field="startTime24" value="' + escapeAttr(r.startTime24 || "") + '" /></td>' +
          '<td><input type="time"  data-field="endTime24"   value="' + escapeAttr(r.endTime24   || "") + '" /></td>' +
          '<td><input type="text"  data-field="notes"       value="' + escapeAttr(r.notes || "") + '" placeholder="optional notes" /></td>' +
          '<td><span class="schedule-draft-conf' + (isLow ? ' is-low' : '') + '">' + confText + '</span></td>' +
          '<td><button type="button" class="schedule-draft-del" data-act="delete">✕</button></td>' +
        '</tr>'
      );
    }).join("");

    // Set initial select values (innerHTML doesn't apply selected for
    // option matching by attribute alone after we built the option
    // list dynamically — set programmatically for reliability).
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      const idx = parseInt(tr.dataset.idx, 10);
      const r = scheduleDraftRows[idx];
      const techSel = tr.querySelector("select[data-field='techSlug']");
      const custSel = tr.querySelector("select[data-field='customerSlug']");
      if (techSel) techSel.value = r.techSlug || "";
      if (custSel) custSel.value = r.customerSlug || "";
    });

    setDraftStatus("");
    setDraftError("");
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Read the table back into the in-memory rows array. Called before
  // save + publish so any pending edits are captured.
  function syncDraftRowsFromTable() {
    const body = $("schedule-draft-rows");
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      const idx = parseInt(tr.dataset.idx, 10);
      if (isNaN(idx)) return;
      const row = scheduleDraftRows[idx];
      if (!row) return;
      Array.prototype.forEach.call(tr.querySelectorAll("[data-field]"), function (el) {
        const field = el.dataset.field;
        row[field] = el.value;
      });
      // Refresh derived fields from the picked slug.
      if (row.techSlug) {
        const t = (techs || []).find(function (x) { return (x.tech_slug || x.id) === row.techSlug; });
        if (t) row.techName = t.display_name || t.name || row.techName || "";
      } else {
        row.techName = "";
      }
      if (row.customerSlug) {
        const c = (customers || []).find(function (x) { return (x.customer_slug || x.id) === row.customerSlug; });
        if (c) row.customerName = c.customer_name || c.name || row.customerName || "";
      } else {
        row.customerName = "";
      }
    });
  }

  function addEmptyDraftRow() {
    syncDraftRowsFromTable();
    const today = pacificDateString(new Date());
    scheduleDraftRows.push({
      date:         today,
      startTime24:  "",
      endTime24:    "",
      techSlug:     "",
      techName:     "",
      customerSlug: "",
      customerName: "",
      notes:        "",
      source:       "manual",
      confidence:   1
    });
    renderDraftEditor(scheduleDraftRows);
  }
  function deleteDraftRow(idx) {
    syncDraftRowsFromTable();
    if (idx < 0 || idx >= scheduleDraftRows.length) return;
    scheduleDraftRows.splice(idx, 1);
    renderDraftEditor(scheduleDraftRows);
  }

  /* ---------- Firestore load/save ---------- */
  async function loadScheduleDraft() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("published_team_schedule").doc(SCHEDULE_DRAFT_DOC_ID).get();
      if (!snap.exists) {
        // Hide the editor when no draft exists.
        scheduleDraftRows = [];
        renderDraftEditor([]);
        return;
      }
      const data = snap.data() || {};
      // Normalize loaded shifts into the editor shape. The doc stores
      // canonical shift records (startMs/endMs); the editor uses
      // startTime24/endTime24, which we derive from the canonical
      // record when present, or fall back to the parser-shaped fields.
      const rows = (data.shifts || []).map(function (s) {
        return {
          date:         s.date || "",
          startTime24:  s.startTime24 || timeFromMs(s.startMs, s.date) || "",
          endTime24:    s.endTime24   || timeFromMs(s.endMs,   s.date) || "",
          techSlug:     s.techSlug     || "",
          techName:     s.techName     || "",
          customerSlug: s.customerSlug || "",
          customerName: s.customerName || "",
          notes:        s.notes        || "",
          source:       s.source       || "manual",
          confidence:   typeof s.confidence === "number" ? s.confidence : 1
        };
      });
      renderDraftEditor(rows, { source: data.source });
    } catch (err) {
      console.error("loadScheduleDraft failed", err);
    }
  }
  function timeFromMs(ms, yyyymmdd) {
    if (!ms || !yyyymmdd) return "";
    try {
      // Format in Pacific
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Los_Angeles",
        hour12: false, hour: "2-digit", minute: "2-digit"
      }).formatToParts(new Date(ms));
      const h = parts.find(function (p) { return p.type === "hour"; });
      const m = parts.find(function (p) { return p.type === "minute"; });
      if (!h || !m) return "";
      return h.value + ":" + m.value;
    } catch (_e) { return ""; }
  }

  async function saveScheduleDraft() {
    syncDraftRowsFromTable();
    setDraftError("");
    if (!scheduleDraftRows.length) {
      setDraftError("Nothing to save — the draft is empty.");
      return;
    }
    const u = firebase.auth().currentUser;
    try {
      setDraftStatus("Saving draft…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(SCHEDULE_DRAFT_DOC_ID).set({
          parsedAt:      firebase.firestore.FieldValue.serverTimestamp(),
          parsedBy: {
            uid:         (u && u.uid) || null,
            email:       (u && u.email) || null,
            displayName: (u && u.displayName) || (u && u.email) || "admin"
          },
          parserVersion: SCHEDULE_PARSER_VERSION,
          source:        "draft",
          shiftCount:    scheduleDraftRows.length,
          shifts:        scheduleDraftRows.slice(),
          active:        false
        }, { merge: false });
      setDraftStatus("Draft saved. Reload won't lose your edits.");
    } catch (err) {
      console.error("saveScheduleDraft failed", err);
      setDraftError("Save failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }

  async function discardScheduleDraft() {
    if (!confirm("Discard the current draft? This cannot be undone.")) return;
    setDraftError("");
    try {
      setDraftStatus("Discarding draft…");
      // Overwrite with a tombstone (cheaper than delete since rules
      // already allow update). active:false + empty shifts means "no
      // draft" from the editor's perspective.
      await firebase.firestore().collection("published_team_schedule")
        .doc(SCHEDULE_DRAFT_DOC_ID).set({
          discardedAt:  firebase.firestore.FieldValue.serverTimestamp(),
          shiftCount:   0,
          shifts:       [],
          active:       false,
          source:       "discarded"
        }, { merge: false });
      scheduleDraftRows = [];
      renderDraftEditor([]);
      setDraftStatus("Draft discarded.");
    } catch (err) {
      console.error("discardScheduleDraft failed", err);
      setDraftError("Discard failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }

  async function publishFromDraft() {
    syncDraftRowsFromTable();
    setDraftError("");
    if (!scheduleDraftRows.length) {
      setDraftError("Nothing to publish — the draft is empty.");
      return;
    }
    // Build canonical shift records matching the schema Team Hub +
    // /team-schedule already render.
    const shifts = [];
    const problems = [];
    scheduleDraftRows.forEach(function (r, i) {
      if (!r.date)        { problems.push("Row " + (i + 1) + ": missing date"); return; }
      if (!r.startTime24) { problems.push("Row " + (i + 1) + ": missing start time"); return; }
      const startMs = buildLocalTimestamp(r.date, r.startTime24);
      const endMs   = r.endTime24 ? buildLocalTimestamp(r.date, r.endTime24) : null;
      shifts.push({
        date:           r.date,
        weekday:        weekdayLabel(r.date),
        startTime:      format12HourTime(r.startTime24),
        endTime:        r.endTime24 ? format12HourTime(r.endTime24) : "",
        startMs:        startMs,
        endMs:          endMs,
        techName:       r.techName     || "",
        techSlug:       r.techSlug     || "",
        customerName:   r.customerName || "",
        customerSlug:   r.customerSlug || "",
        status:         "scheduled",
        deputyShiftUrl: "",
        notes:          r.notes        || "",
        source:         r.source       || "manual",
        confidence:     typeof r.confidence === "number" ? r.confidence : 1
      });
    });
    if (problems.length) {
      setDraftError("Can't publish — " + problems.length + " row(s) need attention:\n" + problems.join("\n"));
      return;
    }
    shifts.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startMs || 0) - (b.startMs || 0);
    });

    const dates    = shifts.map(function (s) { return s.date; }).sort();
    const startDate = dates[0];
    const endDate   = dates[dates.length - 1];
    const days = Math.round((dateToMillisLocal(endDate) - dateToMillisLocal(startDate)) / 86400000) + 1;
    const viewRangeDays = days <= 7 ? 7 : (days <= 14 ? 14 : 21);

    const u = firebase.auth().currentUser;
    try {
      setDraftStatus("Publishing " + shifts.length + " shifts to Team Hub…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID).set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy: {
            uid:         (u && u.uid) || null,
            email:       (u && u.email) || null,
            displayName: (u && u.displayName) || (u && u.email) || "admin"
          },
          startDate:         startDate,
          endDate:           endDate,
          viewRangeDays:     viewRangeDays,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             null,
          source:            "import",
          active:            true
        }, { merge: false });
      setDraftStatus("Published " + shifts.length + " shifts (" + startDate + " → " + endDate + "). Team Hub will pick this up on next page load.");
      // Small celebration — schedule publish is a real milestone moment
      // for the office. Confetti only, no sound (admin pages stay quiet).
      try {
        if (window.PioneerCelebrate) window.PioneerCelebrate.fire({ intensity: "medium" });
      } catch (_e) {}
      // Refresh the published-snapshot summary so the admin sees the
      // up-to-date counts in the section below.
      loadPublishedSnapshot();
    } catch (err) {
      console.error("publishFromDraft failed", err);
      setDraftError("Publish failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }
  function dateToMillisLocal(yyyymmdd) {
    return new Date(yyyymmdd + "T12:00:00Z").getTime();
  }

  // Reflect "is there a PDF I can extract from?" onto the button so
  // admins see the actionability at a glance. Disabled state keeps the
  // button visible (cheaper than hiding it entirely — admins know the
  // feature exists) but unclickable, with a hovertip explaining why.
  function syncExtractButtonState(scheduleDoc) {
    const btn = document.getElementById("schedule-import-from-pdf");
    if (!btn) return;
    const hasPdf = !!(scheduleDoc && scheduleDoc.active !== false && scheduleDoc.downloadUrl);
    btn.disabled = !hasPdf;
    if (hasPdf) {
      btn.title = "Pull the schedule out of the currently uploaded PDF";
    } else {
      btn.title = "Upload the Deputy schedule PDF below first.";
    }
  }

  /* ---------- Import controls wiring ---------- */
  async function onExtractFromPdfClick() {
    setImportError("");
    setImportStatus("Reading current PDF backup…");
    scheduleExtractLog("click", { now: new Date().toISOString() });
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setImportError("Firestore SDK isn't loaded.");
      return;
    }
    let pdfDoc;
    try {
      pdfDoc = await firebase.firestore().collection("team_schedule").doc("current").get();
    } catch (err) {
      setImportError("Couldn't read team_schedule/current: " + (err && err.message || err));
      setImportStatus("");
      return;
    }
    const data = pdfDoc.exists ? pdfDoc.data() : null;
    if (!data || !data.downloadUrl) {
      setImportError("No schedule PDF uploaded yet. Upload the Deputy PDF in the section below, then click Extract again.");
      setImportStatus("");
      return;
    }
    // Pre-flight reachability — turns the generic "Failed to fetch"
    // PDF.js throws into a specific, actionable error.
    scheduleExtractLog("pdfUrl", { url: data.downloadUrl });
    setImportStatus("Checking PDF reachability…");
    const reach = await pdfUrlIsReachable(data.downloadUrl);
    if (!reach.ok) {
      let msg;
      if (reach.code === "timeout") {
        msg = "The schedule PDF didn't load in time. Try Extract again in a minute. " +
              "If it keeps failing, ask Nick to help import this schedule manually.";
      } else if (reach.code === "bad_status") {
        msg = "The schedule PDF storage URL returned HTTP " + reach.status + ". " +
              "The file may have been moved or replaced. Re-upload the PDF below, " +
              "or ask Nick to help import this schedule manually.";
      } else {
        msg = "We couldn't reach the schedule PDF (" + (reach.message || "network error") + "). " +
              "An ad blocker or browser extension may be blocking it. " +
              "Try a different browser, or ask Nick to help import this schedule manually.";
      }
      setImportError(msg);
      setImportStatus("");
      return;
    }

    try {
      setImportStatus("Reading the schedule from the PDF…");
      scheduleExtractLog("extract start", { url: data.downloadUrl });
      const text = await extractPdfText(data.downloadUrl);
      const ta = $("schedule-import-text");
      const len = (text || "").trim().length;
      scheduleExtractLog("extract done", { length: len });
      if (!len) {
        // Reachability OK, library OK, but no text — almost always means
        // the PDF is image-only (scanned/exported as raster). Be specific.
        if (ta) ta.value = "";
        setImportError(
          "We couldn't read any text from that PDF — it looks image-only (scanned or rasterized). " +
          "Re-export from Deputy as a text PDF and try again, or ask Nick to help import this schedule manually."
        );
        setImportStatus("");
        return;
      }
      if (ta) ta.value = text;
      // Auto-convert the extracted text into a draft so the office never
      // has to know "Convert" exists. The Advanced panel still has the
      // button for hand-edited imports.
      setImportStatus("Building the schedule draft…");
      try {
        await onParseImportClick();
        setImportStatus("Schedule draft ready below. Review it, then publish to Team Hub.");
      } catch (parseErr) {
        scheduleExtractWarn("auto-parse failed", { error: parseErr && parseErr.message });
        // Surface the textarea + Advanced panel so the office can adjust.
        const adv = document.getElementById("schedule-import-advanced");
        if (adv) adv.open = true;
        setImportError(
          "We read the PDF but couldn't turn it into a schedule draft automatically. " +
          "Open the Advanced panel below to review the text, or ask Nick to help import this schedule manually."
        );
        setImportStatus("");
      }
    } catch (err) {
      const msg  = (err && err.message) || String(err);
      const name = err && err.name;
      scheduleExtractWarn("extract failed", { name: name, message: msg });
      // Categorize the failure. All branches end with the "Nick can help"
      // escape hatch so the admin never feels stranded.
      let friendly;
      if (/Failed to fetch|NetworkError|network/i.test(msg)) {
        friendly = "The PDF download was interrupted (" + msg + "). " +
                   "Try Extract again. If it keeps failing, ask Nick to help import this schedule manually.";
      } else if (/Invalid PDF|UnknownErrorException|InvalidPDFException/i.test(msg)) {
        friendly = "That PDF couldn't be opened — the file looks corrupt or isn't a valid PDF. " +
                   "Re-upload the PDF below, or ask Nick to help import this schedule manually.";
      } else if (/Password|encrypted/i.test(msg)) {
        friendly = "That PDF is password-protected. Save an unprotected copy and re-upload, " +
                   "or ask Nick to help import this schedule manually.";
      } else if (/PDF\.js/i.test(msg)) {
        friendly = "PDF extraction is temporarily unavailable. " +
                   "Try again in a minute. If it keeps failing, ask Nick to help import this schedule manually.";
      } else {
        friendly = "PDF extraction didn't work (" + msg + "). " +
                   "Nick can help import this schedule manually.";
      }
      setImportError(friendly);
      setImportStatus("");
    }
  }

  function onClearImportClick() {
    const ta = $("schedule-import-text");
    if (ta) ta.value = "";
    setImportStatus("");
    setImportError("");
  }

  async function onParseImportClick() {
    setImportError("");
    const ta = $("schedule-import-text");
    const text = ta ? ta.value : "";
    if (!text || text.trim().length < 8) {
      setImportError("Paste some schedule text first (or extract from the current PDF).");
      return;
    }
    const yearEl = $("schedule-import-year");
    const defaultYear = (yearEl && Number(yearEl.value)) || new Date().getFullYear();
    setImportStatus("Parsing…");
    let rows;
    try {
      rows = parseScheduleText(text, { defaultYear: defaultYear, source: "pdf_import" });
    } catch (err) {
      setImportError("Parser threw an error: " + (err && err.message || err));
      setImportStatus("");
      return;
    }
    if (!rows.length) {
      setImportError(
        "No shifts found in the pasted text. Check: each row needs a recognizable time " +
        "range (e.g., 5:00-8:30) and at least one tech / customer hint."
      );
      setImportStatus("");
      return;
    }
    const lowConf = rows.filter(function (r) { return r.confidence < 0.7; }).length;
    setImportStatus(
      "Parsed " + rows.length + " shifts. " +
      (lowConf ? lowConf + " row(s) low-confidence — review highlighted rows below." : "All rows look good — review below.")
    );
    renderDraftEditor(rows, { source: "pdf_import" });
  }

  function wireScheduleImportControls() {
    const yearEl = $("schedule-import-year");
    if (yearEl && !yearEl.value) yearEl.value = String(new Date().getFullYear());

    const ext = $("schedule-import-from-pdf");
    if (ext) ext.addEventListener("click", onExtractFromPdfClick);
    const clr = $("schedule-import-clear");
    if (clr) clr.addEventListener("click", onClearImportClick);
    const parseBtn = $("schedule-import-parse");
    if (parseBtn) parseBtn.addEventListener("click", onParseImportClick);

    const addRow = $("schedule-draft-add-row");
    if (addRow) addRow.addEventListener("click", addEmptyDraftRow);
    const saveBtn = $("schedule-draft-save");
    if (saveBtn) saveBtn.addEventListener("click", saveScheduleDraft);
    const discardBtn = $("schedule-draft-discard");
    if (discardBtn) discardBtn.addEventListener("click", discardScheduleDraft);
    const publishBtn = $("schedule-draft-publish");
    if (publishBtn) publishBtn.addEventListener("click", publishFromDraft);

    // Delegated click for per-row delete buttons.
    const body = $("schedule-draft-rows");
    if (body) {
      body.addEventListener("click", function (ev) {
        const btn = ev.target.closest && ev.target.closest("[data-act='delete']");
        if (!btn) return;
        const tr = btn.closest("tr");
        if (!tr) return;
        const idx = parseInt(tr.dataset.idx, 10);
        if (!isNaN(idx)) deleteDraftRow(idx);
      });
    }
  }

  function wireScheduleControls() {
    const form = $("schedule-upload-form");
    if (form) form.addEventListener("submit", onScheduleUploadSubmit);
    const publishForm = $("schedule-publish-form");
    if (publishForm) publishForm.addEventListener("submit", onPublishScheduleSubmit);
    const syncNowBtn = $("schedule-sync-now-btn");
    if (syncNowBtn) syncNowBtn.addEventListener("click", onSyncFromDeputyClick);
    const refresh = $("schedule-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      loadTeamSchedule();
      loadPublishedSnapshot();
    });
    // Clear inline upload errors as soon as the user picks a new file.
    const fileInput = $("schedule-upload-file");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        setScheduleUploadError("");
        setScheduleUploadStatus("");
      });
    }
  }

  /* ====================================================================
     Attendance — Time-Off + Call-Outs admin panel
     ====================================================================
     One panel, four sub-tabs (Pending TO / Approved TO / Call-Outs /
     Calendar). Reads from `time_off_requests` + `call_outs`. Admin
     can approve/deny/acknowledge/resolve inline.

     Phase 2 TODO:
       • Cloud Function on create → email Kirby (replaces the in-app
         notification doc)
       • Notify tech back when status flips
       • Blackout windows + max-people-off-per-day rule
       • Conflict overlay on the Team Schedule calendar */
  let attendanceTimeOff   = [];   // array of {id, ...data}
  let attendanceCallOuts  = [];
  let attendanceActiveSub = "pending";

  function setAttendanceState(state) {
    const map = {
      loading: "attendance-loading",
      error:   "attendance-error"
    };
    Object.keys(map).forEach(function (k) {
      const el = $(map[k]);
      if (el) el.hidden = (k !== state);
    });
  }

  function attendanceTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function attendanceFmtTs(ts) {
    const ms = attendanceTsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) { return new Date(ms).toLocaleString(); }
  }
  function attendanceEscapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function attendanceTypeLabel(v) {
    switch (v) {
      case "vacation":     return "Vacation";
      case "personal_day": return "Personal day";
      case "appointment":  return "Appointment";
      case "family_event": return "Family event";
      case "other":        return "Other";
      default:             return v || "—";
    }
  }
  function attendanceReasonLabel(v) {
    switch (v) {
      case "sick":           return "Sick";
      case "emergency":      return "Emergency";
      case "transportation": return "Transportation issue";
      case "family":         return "Family issue";
      case "running_late":   return "Running late";
      case "other":          return "Other";
      default:               return v || "—";
    }
  }
  function attendanceChip(s) {
    const map = {
      new: "New", acknowledged: "Acknowledged", resolved: "Resolved",
      pending: "Pending", approved: "Approved", denied: "Denied"
    };
    const label = map[s] || s || "—";
    return '<span class="attendance-chip attendance-chip--' + (s || "pending") + '">' + label + '</span>';
  }
  function attendanceRangeLabel(start, end) {
    if (!start) return "—";
    if (!end || end === start) return start;
    return start + " → " + end;
  }

  async function loadAttendance() {
    setAttendanceState("loading");
    try {
      const db = firebase.firestore();
      const [toSnap, coSnap] = await Promise.all([
        db.collection("time_off_requests").orderBy("submittedAt", "desc").limit(200).get(),
        db.collection("call_outs").orderBy("submittedAt", "desc").limit(200).get()
      ]);
      attendanceTimeOff = toSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      attendanceCallOuts = coSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      setAttendanceState(null);
      renderAttendance();
      updateAttendanceBadges();
    } catch (err) {
      console.error("[attendance] load failed", err);
      const el = $("attendance-error");
      if (el) {
        el.textContent =
          err && err.code === "permission-denied"
            ? "Permission denied. Confirm firestore.rules has the call_outs + time_off_requests blocks deployed."
            : ("Couldn't load attendance: " + (err && (err.message || err.code)) || "unknown");
      }
      setAttendanceState("error");
    }
  }

  function updateAttendanceBadges() {
    const pending = attendanceTimeOff.filter(function (x) { return x.status === "pending"; }).length;
    const newCallOuts = attendanceCallOuts.filter(function (x) { return x.status === "new"; }).length;
    const total = pending + newCallOuts;

    const tabBadge = $("attendance-tab-badge");
    if (tabBadge) {
      if (total > 0) {
        tabBadge.textContent = total > 99 ? "99+" : String(total);
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }
    const pendingChip = $("attn-pending-count");
    if (pendingChip) {
      if (pending > 0) { pendingChip.textContent = String(pending); pendingChip.hidden = false; }
      else             { pendingChip.hidden = true; }
    }
    const calloutsChip = $("attn-callouts-count");
    if (calloutsChip) {
      if (newCallOuts > 0) { calloutsChip.textContent = String(newCallOuts); calloutsChip.hidden = false; }
      else                 { calloutsChip.hidden = true; }
    }
  }

  function renderAttendance() {
    renderAttendancePending();
    renderAttendanceApproved();
    renderAttendanceCallouts();
    renderAttendanceCalendar();
  }

  function renderAttendancePending() {
    const list  = $("attn-pending-list");
    const empty = $("attn-pending-empty");
    if (!list || !empty) return;
    const items = attendanceTimeOff.filter(function (x) { return x.status === "pending"; });
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="to">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceTypeLabel(x.requestType)) +
                ' · ' + attendanceEscapeHtml(attendanceRangeLabel(x.startDate, x.endDate)) + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.note
            ? '<p class="attn-card-note"><strong>Tech note:</strong> ' + attendanceEscapeHtml(x.note) + '</p>'
            : '') +
          '<div class="attn-card-meta">Submitted ' + attendanceFmtTs(x.submittedAt) + '</div>' +
          '<div class="attn-card-actions">' +
            '<input type="text" class="attn-mgr-note" placeholder="Manager note (optional)" maxlength="280" />' +
            '<button type="button" class="attn-btn attn-btn-deny"    data-act="deny">Deny</button>' +
            '<button type="button" class="attn-btn attn-btn-approve" data-act="approve">Approve</button>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function renderAttendanceApproved() {
    const list  = $("attn-approved-list");
    const empty = $("attn-approved-empty");
    if (!list || !empty) return;
    const items = attendanceTimeOff.filter(function (x) {
      return x.status === "approved" || x.status === "denied";
    });
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card attn-card--review" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="to">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceTypeLabel(x.requestType)) +
                ' · ' + attendanceEscapeHtml(attendanceRangeLabel(x.startDate, x.endDate)) + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.managerNote
            ? '<p class="attn-card-note"><strong>Manager:</strong> ' + attendanceEscapeHtml(x.managerNote) + '</p>'
            : '') +
          '<div class="attn-card-meta">Reviewed ' + attendanceFmtTs(x.reviewedAt) +
            (x.reviewedBy ? ' by ' + attendanceEscapeHtml(x.reviewedBy.displayName || x.reviewedBy.email || "admin") : '') +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function renderAttendanceCallouts() {
    const list  = $("attn-callouts-list");
    const empty = $("attn-callouts-empty");
    if (!list || !empty) return;
    const items = attendanceCallOuts;
    if (!items.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(function (x) {
      return (
        '<article class="attn-card" data-attn-id="' + attendanceEscapeHtml(x.id) + '" data-attn-kind="co">' +
          '<header class="attn-card-head">' +
            '<div class="attn-card-who">' +
              '<div class="attn-card-name">' + attendanceEscapeHtml(x.techName || x.techEmail || "Tech") + '</div>' +
              '<div class="attn-card-sub">' + attendanceEscapeHtml(attendanceReasonLabel(x.reason)) +
                ' · ' + attendanceEscapeHtml(x.date || "—") +
                (x.shiftCustomer ? ' · ' + attendanceEscapeHtml(x.shiftCustomer) : '') + '</div>' +
            '</div>' +
            attendanceChip(x.status) +
          '</header>' +
          (x.note
            ? '<p class="attn-card-note"><strong>Tech note:</strong> ' + attendanceEscapeHtml(x.note) + '</p>'
            : '') +
          (x.coverageNote
            ? '<p class="attn-card-note"><strong>Coverage:</strong> ' + attendanceEscapeHtml(x.coverageNote) + '</p>'
            : '') +
          '<div class="attn-card-meta">Submitted ' + attendanceFmtTs(x.submittedAt) + '</div>' +
          (x.status !== "resolved"
            ? '<div class="attn-card-actions">' +
                '<input type="text" class="attn-coverage-note" placeholder="Coverage note (optional)" maxlength="280" />' +
                (x.status === "new"
                  ? '<button type="button" class="attn-btn" data-act="ack">Acknowledge</button>'
                  : '') +
                '<button type="button" class="attn-btn attn-btn-approve" data-act="resolve">Mark resolved</button>' +
              '</div>'
            : '') +
        '</article>'
      );
    }).join("");
  }

  // Calendar heatmap — flat grid of upcoming dates (today to today+60),
  // each cell colored by the count of (approved + pending) time-off
  // requests covering it. Names listed inline so Kirby sees who.
  function renderAttendanceCalendar() {
    try { console.info("[AttendanceCalendar] rendering"); } catch (_e) {}
    const root = $("attn-calendar");
    if (!root) {
      try { console.warn("[AttendanceCalendar] target #attn-calendar not found"); } catch (_e) {}
      return;
    }
    try { console.info("[AttendanceCalendar] target found", { node: root.tagName }); } catch (_e) {}

    let today, dates;
    try {
      today = pacificDateString(new Date());
      const horizonDays = 60;
      dates = [];
      for (let i = 0; i < horizonDays; i++) dates.push(addDaysPacific(today, i));
    } catch (err) {
      try { console.error("[AttendanceCalendar] date helpers failed", err); } catch (_e) {}
      // Fall back to a bare 60-day UTC range so the grid still renders.
      const startMs = Date.now();
      today = new Date(startMs).toISOString().slice(0, 10);
      dates = [];
      for (let i = 0; i < 60; i++) {
        dates.push(new Date(startMs + i * 86400000).toISOString().slice(0, 10));
      }
    }

    // Build date → list of { name, status }
    const byDate = new Map();
    dates.forEach(function (d) { byDate.set(d, []); });
    try { console.info("[AttendanceCalendar] entries loaded", {
      requests: attendanceTimeOff.length, dates: dates.length
    }); } catch (_e) {}
    attendanceTimeOff.forEach(function (x) {
      if (x.status !== "approved" && x.status !== "pending") return;
      if (!x.startDate) return;
      const endDate = x.endDate || x.startDate;
      // Walk every day in the request range that falls inside our horizon.
      let cur = x.startDate;
      let safety = 0;
      while (cur <= endDate && safety < 120) {
        if (byDate.has(cur)) {
          byDate.get(cur).push({
            name: x.techName || x.techEmail || "Tech",
            status: x.status
          });
        }
        try {
          cur = addDaysPacific(cur, 1);
        } catch (_e) {
          // Defensive: a malformed startDate could throw. Bail this row.
          break;
        }
        safety += 1;
      }
    });

    const cellsHtml = dates.map(function (d) {
      const entries = byDate.get(d) || [];
      const count = entries.length;
      let level = "none";
      if      (count >= 3) level = "red";
      else if (count === 2) level = "orange";
      else if (count === 1) level = "yellow";

      const isToday = (d === today);
      const wkday = (function () {
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", weekday: "short"
          }).format(new Date(d + "T12:00:00Z"));
        } catch (_e) { return ""; }
      })();
      const dayLabel = (function () {
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", month: "short", day: "numeric"
          }).format(new Date(d + "T12:00:00Z"));
        } catch (_e) { return d; }
      })();
      const namesHtml = entries.length
        ? '<ul class="attn-cal-names">' +
            entries.map(function (e) {
              return '<li class="attn-cal-name attn-cal-name--' + e.status + '">' +
                attendanceEscapeHtml(e.name) +
                (e.status === "pending" ? ' <em>(pending)</em>' : '') +
                '</li>';
            }).join("") +
          '</ul>'
        : '';
      // Critical hint on red cells — operational visibility, not a
      // hard block. Admins still approve/deny on their own judgment.
      const criticalHint = (level === "red")
        ? '<p class="attn-cal-critical">3+ people already off — additional requests may be difficult to approve.</p>'
        : '';
      const tooltipParts = [];
      if (count > 0) {
        tooltipParts.push(count + (count === 1 ? " person" : " people") + " requested off");
        entries.forEach(function (e) {
          tooltipParts.push("· " + e.name + (e.status === "pending" ? " (pending)" : ""));
        });
      } else {
        tooltipParts.push("No requests off");
      }
      const tooltip = tooltipParts.join("\n");
      return (
        '<div class="attn-cal-cell attn-cal-cell--' + level +
          (isToday ? ' is-today' : '') + '"' +
          ' title="' + attendanceEscapeHtml(tooltip) + '">' +
          '<div class="attn-cal-head">' +
            '<span class="attn-cal-wkday">' + attendanceEscapeHtml(wkday) + '</span>' +
            '<span class="attn-cal-date">' + attendanceEscapeHtml(dayLabel) + '</span>' +
            (count > 0 ? '<span class="attn-cal-count">' + count + '</span>' : '') +
          '</div>' +
          namesHtml +
          criticalHint +
        '</div>'
      );
    }).join("");

    // Atomic write — replace innerHTML in one operation so a half-
    // rendered grid never flickers in. The renderer is idempotent;
    // calling it on every sub-tab activation is fine.
    root.innerHTML = cellsHtml;
    try { console.info("[AttendanceCalendar] rendered cells count", {
      cells: dates.length, requests_used: attendanceTimeOff.length
    }); } catch (_e) {}
  }

  function setAttendanceSubTab(name) {
    attendanceActiveSub = name;
    document.querySelectorAll(".attendance-subtab").forEach(function (b) {
      const active = (b.dataset.attnTab === name);
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".attendance-subpanel").forEach(function (p) {
      const active = (p.dataset.attnPanel === name);
      p.hidden = !active;
      p.classList.toggle("is-active", active);
    });
    // Re-render the activated panel so a stale grid (or one rendered
    // while the panel was hidden) never persists.
    try {
      if (name === "calendar")        renderAttendanceCalendar();
      else if (name === "pending")    renderAttendancePending();
      else if (name === "approved")   renderAttendanceApproved();
      else if (name === "callouts")   renderAttendanceCallouts();
      else if (name === "openshifts") loadOpenShifts();
    } catch (err) {
      try { console.error("[AttendanceCalendar] sub-tab re-render failed", { name: name, error: err && err.message }); } catch (_e) {}
    }
  }

  /* ====================================================================
     Open Shifts (Rockstar Coverage) — admin CRUD
     ====================================================================
     Lives inside the Attendance panel as a 5th sub-tab. Admins create
     open_shift_requests when a call-out leaves a shift uncovered;
     techs accept via /open-shifts.html (rule-enforced atomic claim);
     admin "Confirm coverage" flips status to "confirmed" AND creates
     a rockstar_bonuses doc in a single Firestore batch.

     Phase 2 TODO:
       • Trigger function on confirm → email tech "$25 Rockstar bonus
         confirmed"
       • Auto-cancel + Kirby alert when an open shift remains
         unclaimed past shiftDate */
  let openShiftsState = [];

  async function loadOpenShifts() {
    const list  = $("attn-os-list");
    const empty = $("attn-os-empty");
    if (!list || !empty) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("open_shift_requests")
        .where("status", "in", ["open", "accepted"])
        .orderBy("shiftDate", "asc")
        .limit(100).get();
      openShiftsState = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
      const openCount = openShiftsState.filter(function (x) { return x.status === "open"; }).length;
      const badge = $("attn-openshifts-count");
      if (badge) {
        if (openCount > 0) { badge.textContent = String(openCount); badge.hidden = false; }
        else               { badge.hidden = true; }
      }
      renderOpenShifts();
    } catch (err) {
      console.error("[openshifts] load failed", err);
      list.innerHTML =
        '<div class="admin-status admin-error">Couldn\'t load open shifts: ' +
        attendanceEscapeHtml((err && err.message) || "unknown") + '</div>';
    }
  }

  function renderOpenShifts() {
    const list  = $("attn-os-list");
    const empty = $("attn-os-empty");
    if (!list || !empty) return;
    if (!openShiftsState.length) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = openShiftsState.map(function (x) {
      const dateLabel = (function () {
        if (!x.shiftDate) return "—";
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "short", month: "short", day: "numeric"
          }).format(new Date(x.shiftDate + "T12:00:00Z"));
        } catch (_e) { return x.shiftDate; }
      })();
      const statusChip = x.status === "accepted"
        ? '<span class="attn-os-chip is-accepted">Accepted</span>'
        : '<span class="attn-os-chip is-open">Open</span>';

      let actions = "";
      if (x.status === "open") {
        actions =
          '<button type="button" class="attn-btn attn-btn-deny" data-act="cancel">Cancel</button>';
      } else if (x.status === "accepted") {
        actions =
          '<button type="button" class="attn-btn attn-btn-deny"    data-act="cancel">Cancel</button>' +
          '<button type="button" class="attn-btn attn-btn-approve" data-act="confirm">Confirm coverage</button>';
      }

      return (
        '<article class="attn-os-card" data-os-id="' + attendanceEscapeHtml(x.id) + '">' +
          '<header class="attn-os-card-head">' +
            '<div>' +
              '<div class="attn-os-card-title">' + attendanceEscapeHtml(x.customerName || "Customer") + '</div>' +
              '<div class="attn-os-card-meta">' + attendanceEscapeHtml(dateLabel) +
                (x.shiftTime ? ' · ' + attendanceEscapeHtml(x.shiftTime) : '') +
                '</div>' +
            '</div>' +
            statusChip +
          '</header>' +
          (x.notes ? '<p class="attn-os-card-notes">' + attendanceEscapeHtml(x.notes) + '</p>' : '') +
          (x.acceptedByTechName
            ? '<p class="attn-os-card-accepted"><strong>Accepted by:</strong> ' +
                attendanceEscapeHtml(x.acceptedByTechName) +
                ' · <span class="attn-os-bonus-pill">$25 Rockstar bonus pending confirmation</span></p>'
            : '') +
          '<div class="attn-os-card-actions">' + actions + '</div>' +
        '</article>'
      );
    }).join("");
  }

  async function createOpenShift(payload) {
    const u = firebase.auth().currentUser;
    const openedBy = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("open_shift_requests").add({
      source:               "admin",
      originalShiftId:      null,
      customerName:         payload.customerName,
      customerSlug:         payload.customerSlug || null,
      shiftDate:            payload.shiftDate,
      shiftTime:            payload.shiftTime || null,
      notes:                payload.notes || null,
      openedBy:             openedBy,
      openedAt:             firebase.firestore.FieldValue.serverTimestamp(),
      status:               "open",
      acceptedByTechUid:    null,
      acceptedByTechId:     null,
      acceptedByTechName:   null,
      acceptedAt:           null,
      confirmedBy:          null,
      confirmedAt:          null,
      rockstarBonusAmount:  25,
      rockstarBonusStatus:  "pending"
    });
  }

  async function cancelOpenShift(id) {
    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("open_shift_requests").doc(id).update({
      status:      "cancelled",
      confirmedBy: actor,
      confirmedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Confirm coverage = mark the open shift confirmed AND create the
  // matching rockstar_bonuses doc. Wrapped in a Firestore batch so
  // both writes succeed together (or neither does).
  async function confirmOpenShiftCoverage(id) {
    const item = openShiftsState.find(function (x) { return x.id === id; });
    if (!item) throw new Error("Open shift not found in local state");
    if (item.status !== "accepted") throw new Error("Shift must be accepted before confirming");

    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;

    const db    = firebase.firestore();
    const batch = db.batch();
    const osRef = db.collection("open_shift_requests").doc(id);
    const rbRef = db.collection("rockstar_bonuses").doc();

    const monthKey = (function () {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit"
        }).format(new Date()).slice(0, 7);
      } catch (_e) { return new Date().toISOString().slice(0, 7); }
    })();

    batch.update(osRef, {
      status:              "confirmed",
      confirmedBy:         actor,
      confirmedAt:         firebase.firestore.FieldValue.serverTimestamp(),
      rockstarBonusStatus: "pending"
    });
    batch.set(rbRef, {
      techId:             item.acceptedByTechId || "",
      techName:           item.acceptedByTechName || "",
      techUid:            item.acceptedByTechUid || "",
      sourceOpenShiftId:  id,
      amount:             25,
      earnedAt:           firebase.firestore.FieldValue.serverTimestamp(),
      monthKey:           monthKey,
      status:             "pending",
      confirmedBy:        actor
    });
    await batch.commit();
  }

  function wireOpenShiftsControls() {
    const newBtn  = $("attn-os-new-btn");
    const form    = $("attn-os-form");
    const cancel  = $("attn-os-form-cancel");
    if (newBtn && form) {
      newBtn.addEventListener("click", function () {
        form.hidden = false;
        const dateEl = $("attn-os-shift-date");
        if (dateEl && !dateEl.value) dateEl.value = pacificDateString(new Date());
        const nameEl = $("attn-os-customer-name");
        if (nameEl) nameEl.focus();
      });
    }
    if (cancel && form) {
      cancel.addEventListener("click", function () {
        form.hidden = true;
        const status = $("attn-os-form-status");
        if (status) status.textContent = "";
      });
    }
    if (form) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        const status = $("attn-os-form-status");
        const submitBtn = $("attn-os-form-submit");
        if (submitBtn) submitBtn.disabled = true;
        const payload = {
          customerName: ($("attn-os-customer-name") && $("attn-os-customer-name").value || "").trim(),
          customerSlug: ($("attn-os-customer-slug") && $("attn-os-customer-slug").value || "").trim(),
          shiftDate:    ($("attn-os-shift-date")    && $("attn-os-shift-date").value    || "").trim(),
          shiftTime:    ($("attn-os-shift-time")    && $("attn-os-shift-time").value    || "").trim(),
          notes:        ($("attn-os-notes")         && $("attn-os-notes").value         || "").trim()
        };
        if (!payload.customerName || !payload.shiftDate) {
          if (status) status.textContent = "Customer + shift date are required.";
          if (submitBtn) submitBtn.disabled = false;
          return;
        }
        try {
          if (status) status.textContent = "Creating…";
          await createOpenShift(payload);
          if (status) status.textContent = "Open shift created.";
          // Reset + hide form
          form.reset();
          form.hidden = true;
          if ($("attn-os-shift-date")) $("attn-os-shift-date").value = pacificDateString(new Date());
          loadOpenShifts();
        } catch (err) {
          console.error("[openshifts] create failed", err);
          if (status) status.textContent =
            "Create failed: " + ((err && (err.message || err.code)) || "unknown");
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
    // Delegated action clicks on cards.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest(".attn-os-card .attn-btn[data-act]");
      if (!btn) return;
      const card = btn.closest("[data-os-id]");
      if (!card) return;
      const id  = card.dataset.osId;
      const act = btn.dataset.act;
      btn.disabled = true;
      const done = function () { btn.disabled = false; loadOpenShifts(); };
      const fail = function (err) {
        console.error("[openshifts] action failed", err);
        alert((err && (err.message || err.code)) || "Action failed");
        btn.disabled = false;
      };
      if      (act === "cancel")  cancelOpenShift(id).then(done).catch(fail);
      else if (act === "confirm") confirmOpenShiftCoverage(id).then(done).catch(fail);
    });
  }

  async function updateTimeOffStatus(id, newStatus, managerNote) {
    const u = firebase.auth().currentUser;
    const reviewedBy = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    await firebase.firestore().collection("time_off_requests").doc(id).update({
      status:      newStatus,
      reviewedAt:  firebase.firestore.FieldValue.serverTimestamp(),
      reviewedBy:  reviewedBy,
      managerNote: managerNote || null
    });
  }
  async function updateCallOutStatus(id, newStatus, coverageNote) {
    const u = firebase.auth().currentUser;
    const actor = u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
    const patch = { coverageNote: coverageNote || null };
    if (newStatus === "acknowledged") {
      patch.status         = "acknowledged";
      patch.acknowledgedAt = firebase.firestore.FieldValue.serverTimestamp();
      patch.acknowledgedBy = actor;
    } else if (newStatus === "resolved") {
      patch.status     = "resolved";
      patch.resolvedAt = firebase.firestore.FieldValue.serverTimestamp();
      patch.resolvedBy = actor;
    }
    await firebase.firestore().collection("call_outs").doc(id).update(patch);
  }

  function wireAttendanceControls() {
    // Sub-tab switching.
    document.querySelectorAll(".attendance-subtab").forEach(function (b) {
      b.addEventListener("click", function () {
        const n = b.dataset.attnTab;
        if (n) setAttendanceSubTab(n);
      });
    });
    // Refresh button.
    const refresh = $("attendance-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadAttendance(); });

    // Delegated action clicks on attn-card buttons.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest(".attn-btn[data-act]");
      if (!btn) return;
      const card = btn.closest("[data-attn-id]");
      if (!card) return;
      const id   = card.dataset.attnId;
      const kind = card.dataset.attnKind;
      const act  = btn.dataset.act;
      btn.disabled = true;

      if (kind === "to") {
        const noteEl = card.querySelector(".attn-mgr-note");
        const note   = (noteEl && noteEl.value || "").trim();
        const newStatus = (act === "approve") ? "approved" : "denied";
        updateTimeOffStatus(id, newStatus, note)
          .then(loadAttendance)
          .catch(function (err) {
            console.error("[attendance] time-off update failed", err);
            alert("Update failed: " + (err && err.message || err));
            btn.disabled = false;
          });
      } else if (kind === "co") {
        const noteEl = card.querySelector(".attn-coverage-note");
        const note   = (noteEl && noteEl.value || "").trim();
        const newStatus = (act === "ack") ? "acknowledged"
                        : (act === "resolve") ? "resolved" : null;
        if (!newStatus) { btn.disabled = false; return; }
        updateCallOutStatus(id, newStatus, note)
          .then(loadAttendance)
          .catch(function (err) {
            console.error("[attendance] call-out update failed", err);
            alert("Update failed: " + (err && err.message || err));
            btn.disabled = false;
          });
      }
    });
  }


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
    registerTabActivator("schedule",        function () {
      loadTeamSchedule();
      loadPublishedSnapshot();
      loadScheduleDraft();
    });
    registerTabActivator("attendance",      loadAttendance);
    registerTabActivator("tech-health",     window.__pioneerAdmin.tabs.techHealth.refresh);
    registerTabActivator("pilot-readiness", window.__pioneerAdmin.tabs.pilotReadiness.init);
    registerTabActivator("yesterday",       window.__pioneerAdmin.tabs.yesterdaysWork.init);
    registerTabActivator("improvements",    window.__pioneerAdmin.tabs.improvements.init);
    registerTabActivator("sos",             window.__pioneerAdmin.tabs.sos.init);
    wireSearch();
    wireRefresh();
    wireSupplyControls();
    window.__pioneerAdmin.tabs.dcrIssues.init();
    wireAttentionStrip();
    wireAnnouncementsControls();
    wireAdminsControls();
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
      getSupplyRequests:     function () { return supplyRequests; },
      getAdmins:             function () { return admins; },
      loadAdmins:            function () { return loadAdmins(); },
      refreshAttentionStrip: function () { return refreshAttentionStrip(); },
      getCurrentAdminEmail:  getCurrentAdminEmail,
      handleAdminWriteError: handleAdminWriteError,
      setModalError:         setModalError,
      setModalSaving:        setModalSaving,
      populateCustomerDeputyIntegration: populateCustomerDeputyIntegration
    };
    // DCR Issues tab fires onChange after every load + save so admin.js
    // can refresh the attention strip + customer rows (which display
    // open-issue counts derived from the dcrIssues array).
    window.__pioneerAdmin.tabs.dcrIssues.onChange(function () {
      if (typeof refreshAttentionStrip      === "function") refreshAttentionStrip();
      window.__pioneerAdmin.tabs.customers.applyFilter();
    });
    window.__pioneerAdmin.tabs.customerNotes.init();
    window.__pioneerAdmin.tabs.noteSuggestions.init();
    window.__pioneerAdmin.tabs.serviceRecoveries.init();
    window.__pioneerAdmin.tabs.training.init();
    window.__pioneerAdmin.tabs.techs.init();
    wireDeputyMappingControls();
    wireScheduleControls();
    wireScheduleImportControls();
    wireAttendanceControls();
    wireOpenShiftsControls();
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
