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
  const {
    DCR_RECENT_LIMIT,
    ALLOWED_ADMIN_EMAILS,
    isRootAdmin,
    escapeHtml,
    formatTimestamp,
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
    badge,
    activeBadge,
    dcrEnabledBadge,
    dcrEmailBadge,
    activateTab,
    registerTabActivator
  } = window.__pioneerAdmin.shell;

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

  let customers = [];
  let techs     = [];
  let dcrs      = [];

  // DCR-derived issues (admin-only collection, see firestore.rules).
  // Populated by loadDcrIssues() once auth resolves. Status workflow:
  //   new → reviewed → customer_contacted → resolved | closed_no_action
  // Server (submitDcrV1) materialises new issues on each submission via
  // createDcrIssuesForSubmission(); admin edits status/notes here.
  let dcrIssues = [];
  // Current filter for the Issues tab list. Mutated by the filter-pill
  // click handler; consumed by applyCurrentIssuesFilter().
  let currentIssueStatus = "all";

  // Announcements (v1). Admin-authored; visible to all signed-in staff.
  // Populated by loadAnnouncements() once admin auth resolves.
  let announcements = [];

  // Operational admins (Firestore-backed allowlist via /admins/{email}).
  // Doesn't include the hardcoded ALLOWED_ADMIN_EMAILS — those are
  // displayed in the panel separately, as a read-only "root admins"
  // section that explains where they're managed.
  let admins = [];

  // Edit-modal staging for cleaning_tech ↔ customer assignments. Lives at
  // module scope so the search filter can re-render the list without
  // losing checks made before the user typed. Reset on every modal open.
  let pendingTechAssigned = new Set();

  // Same idea for the Add/Login Setup modal — separate Set so opening
  // the create modal doesn't trample any in-progress edit modal state.
  let pendingTechCreateAssigned = new Set();

  /* wireTabs, setStatus, hideAllStatuses, showFatal, badge family, and
     activateTab moved to public/admin/_shell.js — imported via the
     top-of-IIFE destructure. Tab activators are registered in boot. */

  /* ---------- on-budget analytics (no extra Firestore reads) ----------
   *
   * Keep `getOnBudget()` in sync with the same-name helper in
   * functions/index.js — admin metrics and tech-hub metrics must agree on
   * which docs count as on/over/unknown. See server for the field-priority
   * rationale.
   *
   * `computeBudgetStats(opts)` slices the in-memory `dcrs` cache (which is
   * already loaded into module state by loadDcrs) and returns the 4-window
   * breakdown. No async work, no extra reads. Cached per (slug, kind) tuple
   * for the lifetime of the dcrs array — invalidated whenever loadDcrs
   * repopulates it. Empty/insufficient windows return null fields so the
   * UI renders "—" instead of a misleading 0%.
   *
   * Future: when dcrs.length consistently exceeds the 500-doc cap, replace
   * this with a server-aggregated metrics doc + a single read at boot.
   */
  function getOnBudget(doc) {
    if (!doc || typeof doc !== "object") return null;
    if (doc.time_budget && typeof doc.time_budget.on_budget === "boolean") {
      return doc.time_budget.on_budget;
    }
    const fd = doc.form_data || {};
    if (fd.time_budget && typeof fd.time_budget.on_budget === "boolean") {
      return fd.time_budget.on_budget;
    }
    if (typeof fd.on_time_budget === "boolean") return fd.on_time_budget;
    if (typeof fd.on_time_budget === "string") {
      const v = fd.on_time_budget.toLowerCase().trim();
      if (v === "no"  || v === "false") return false;
      if (v === "yes" || v === "true")  return true;
    }
    if (typeof doc.on_time_budget === "boolean") return doc.on_time_budget;
    return null;
  }

  // tsToMs — tolerant Firestore-timestamp / ISO / number reader. Matches
  // the server-side helper in functions/index.js.
  function dcrTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number")                      return ts;
    if (typeof ts === "string")                      { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function")           return ts.toMillis();
    if (typeof ts.seconds === "number")              return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  function emptyBucket() { return { on: 0, over: 0, total: 0, unknown: 0 }; }

  // Tally helper. Filter is one of:
  //   { kind: "customer", slug: "xxx" }
  //   { kind: "tech",     slug: "xxx" }
  // Returns:
  //   {
  //     last_clean: "on"|"over"|"unknown"|null,
  //     last_7d:    { on, over, total, pct } | null,
  //     this_month: { on, over, total, pct } | null,
  //     all_time:   { on, over, total, pct } | null  // = within loaded window
  //   }
  function computeBudgetStats(filter) {
    const now = Date.now();
    const sevenAgo  = now - 7 * 24 * 60 * 60 * 1000;
    const monthStart = (function () {
      const d = new Date(now);
      // Local-month boundary so MTD lines up with how the office reads it.
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    })();

    const wantSlug = String(filter.slug || "").toLowerCase().trim();
    if (!wantSlug) return { last_clean: null, last_7d: null, this_month: null, all_time: null };

    let last7   = emptyBucket();
    let mtd     = emptyBucket();
    let allWin  = emptyBucket();
    let newestMs = -1;
    let newestVal = null;

    for (let i = 0; i < dcrs.length; i++) {
      const d = dcrs[i];
      const docSlug = String(
        (filter.kind === "customer" ? d.customer_slug : d.tech_slug) || ""
      ).toLowerCase().trim();
      if (docSlug !== wantSlug) continue;

      const v = getOnBudget(d);
      const ms = dcrTsToMs(d.created_at);

      // "All time" within the loaded window — counts even when created_at
      // is unreadable, since we still loaded the doc deliberately.
      allWin.total += 1;
      if (v === true)       allWin.on   += 1;
      else if (v === false) allWin.over += 1;
      else                  allWin.unknown += 1;

      if (ms != null) {
        if (ms >= sevenAgo) {
          last7.total += 1;
          if (v === true)       last7.on   += 1;
          else if (v === false) last7.over += 1;
          else                  last7.unknown += 1;
        }
        if (ms >= monthStart) {
          mtd.total += 1;
          if (v === true)       mtd.on   += 1;
          else if (v === false) mtd.over += 1;
          else                  mtd.unknown += 1;
        }
        if (ms > newestMs) { newestMs = ms; newestVal = v; }
      }
    }

    function pack(b) {
      // Need at least one known-on/known-over doc for the % to be meaningful.
      const denom = b.on + b.over;
      if (denom === 0) return null;
      return { on: b.on, over: b.over, total: b.total, pct: Math.round((b.on / denom) * 100) };
    }

    return {
      last_clean: newestVal === true ? "on" : newestVal === false ? "over" : (newestMs < 0 ? null : "unknown"),
      last_7d:    pack(last7),
      this_month: pack(mtd),
      all_time:   pack(allWin)
    };
  }

  // Compact one-line badge for the row. Returns "" when no data so the
  // row doesn't shout empty values.
  function budgetRowBadge(stats) {
    if (!stats) return "";
    const mtd = stats.this_month;
    if (!mtd) {
      // Show "Last clean: On/Over" if we have NOTHING else.
      if (stats.last_clean === "on")   return badge("is-on",  "Last clean: On budget");
      if (stats.last_clean === "over") return badge("is-warn","Last clean: Over budget");
      return "";
    }
    // Color band: green ≥ 85, neutral 70–84, warn < 70.
    const cls = mtd.pct >= 85 ? "is-on" : mtd.pct >= 70 ? "is-neutral" : "is-warn";
    return badge(cls, "MTD " + mtd.pct + "% on budget");
  }

  // Tooltip text with all four windows. Plain text; lives in title="…".
  function budgetTooltipText(stats) {
    if (!stats) return "";
    const parts = [];
    parts.push("On-budget rate");
    function row(label, b) {
      if (!b) return "  " + label + ": —";
      return "  " + label + ": " + b.pct + "% (" + b.on + " on / " + b.over + " over)";
    }
    const lc =
      stats.last_clean === "on"   ? "On budget" :
      stats.last_clean === "over" ? "Over budget" :
      stats.last_clean === "unknown" ? "Unknown" : "—";
    parts.push("  Last clean: " + lc);
    parts.push(row("Last 7 days", stats.last_7d));
    parts.push(row("This month",  stats.this_month));
    parts.push(row("All-time (loaded window)", stats.all_time));
    return parts.join("\n");
  }

  /* ---------- customers ---------- */

  function customerCard(c) {
    const name         = getCustomerName(c) || "(unnamed customer)";
    const slug         = getCustomerSlug(c);
    const email        = getCustomerEmail(c);
    const location     = getCustomerLocation(c);
    const active       = getActive(c);
    const enabled      = getDcrEnabled(c);
    const emailEnabled = getDcrEmailEnabled(c);

    // Per-customer on-budget summary. Computed lazily here from the
    // in-memory dcrs cache — no extra Firestore reads. Returns "" when
    // we have no usable data for this customer.
    const budgetStats   = computeBudgetStats({ kind: "customer", slug: slug });
    const budgetBadgeHtml = budgetRowBadge(budgetStats);
    const budgetTooltip   = budgetTooltipText(budgetStats);

    // Operational metrics line — high-value, scan-friendly counts only.
    // Open issues / open supply / 30-day issue count / last clean / last
    // issue date / first open unresolved issue summary. Absent rows are
    // omitted to keep the line one row max even on dense customers.
    const cutoffMs30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const customerOpenIssues = dcrIssues.filter(function (it) {
      return it.customer_slug === slug &&
             (it.status || "new") !== "resolved" &&
             (it.status || "new") !== "closed_no_action";
    });
    const openIssues  = customerOpenIssues.length;
    const recentIssues = dcrIssues.filter(function (it) {
      if (it.customer_slug !== slug) return false;
      const ms = supplyTsToMs(it.created_at);
      return ms != null && ms >= cutoffMs30;
    }).length;
    // Reserved for the future `customer_complaints` collection. When
    // that ships, swap this constant for a count derived from a
    // module-scope `complaints` cache (same priority as issues —
    // admin-only, no tech leak).
    const recentComplaints = 0;
    const openSupply = supplyRequests.filter(function (r) {
      return r.customer_slug === slug && (r.status || "new") !== "closed";
    }).length;
    // Most recent issue date for this customer (any status).
    let lastIssueMs = null;
    let firstOpenIssueSummary = "";
    for (let i = 0; i < dcrIssues.length; i++) {
      const it = dcrIssues[i];
      if (it.customer_slug !== slug) continue;
      const ms = supplyTsToMs(it.created_at);
      if (ms != null && (lastIssueMs == null || ms > lastIssueMs)) lastIssueMs = ms;
    }
    if (customerOpenIssues.length > 0) {
      // Pick the newest open issue's summary as the customer's flagged
      // attention item. dcrIssues is loaded newest-first, so the first
      // open match is the newest. Truncate to keep the line readable.
      const s = customerOpenIssues[0].issue_summary || "";
      firstOpenIssueSummary = s.length > 80 ? s.slice(0, 77) + "…" : s;
    }
    let lastCleanDate = "";
    for (let i = 0; i < dcrs.length; i++) {
      if (dcrs[i].customer_slug === slug && dcrs[i].clean_date) {
        if (!lastCleanDate || dcrs[i].clean_date > lastCleanDate) lastCleanDate = dcrs[i].clean_date;
      }
    }
    const lastIssueLabel = lastIssueMs
      ? new Date(lastIssueMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";

    const metricsParts = [];
    if (openIssues       > 0) metricsParts.push(openIssues       + " open issue"   + (openIssues       === 1 ? "" : "s"));
    if (recentIssues     > 0) metricsParts.push(recentIssues     + " issue"        + (recentIssues     === 1 ? "" : "s") + " · 30d");
    if (recentComplaints > 0) metricsParts.push(recentComplaints + " complaint"    + (recentComplaints === 1 ? "" : "s") + " · 30d");
    if (openSupply       > 0) metricsParts.push(openSupply       + " open supply");
    if (lastIssueLabel)       metricsParts.push("Last issue " + lastIssueLabel);
    if (lastCleanDate)        metricsParts.push("Last clean " + lastCleanDate);
    const metricsLineHtml = metricsParts.length
      ? '<span class="row-metrics">' + escapeHtml(metricsParts.join(" · ")) + '</span>'
      : '';
    // Secondary single-line peek at the most actionable open-issue
    // summary. Only renders when there's at least one open issue.
    const issueSummaryHtml = firstOpenIssueSummary
      ? '<span class="row-metrics is-issue-summary" title="' +
          escapeHtml(customerOpenIssues[0].issue_summary || "") + '">⚠ ' +
          escapeHtml(firstOpenIssueSummary) + '</span>'
      : '';

    // High-value badges only. Hidden behind Edit: slug + email + slack
    // + review URLs (admin can drill in via Edit when they need them).
    // The "X open issues" warn pill is omitted when 0 to avoid the
    // green-everywhere noise the old layout suffered.
    const issuesBadgeHtml = openIssues > 0
      ? badge("is-warn", openIssues + " open issue" + (openIssues === 1 ? "" : "s"))
      : "";
    const openSupplyBadgeHtml = openSupply > 0
      ? badge("is-neutral", openSupply + " open supply")
      : "";
    // SOP status chip — read by window.CustomerSop.statusForCustomer
    // (loaded by admin.html via <script src="customer-sop.js">). Codes:
    //   has_sop       → green "Has SOP"
    //   no_sop        → gray "No SOP"
    //   needs_review  → amber "Needs Review"
    //   inactive      → gray "Inactive in Deputy"
    let sopBadgeHtml = "";
    if (window.CustomerSop && typeof window.CustomerSop.statusForCustomer === "function") {
      const st = window.CustomerSop.statusForCustomer(c);
      const cls = st.code === "has_sop"      ? "is-on"
                : st.code === "needs_review" ? "is-warn"
                : st.code === "inactive"     ? "is-off"
                : "is-neutral";
      sopBadgeHtml = badge(cls, "SOP: " + st.label);
    }

    const badges =
      activeBadge(active) +
      dcrEnabledBadge(enabled) +
      dcrEmailBadge(emailEnabled) +
      budgetBadgeHtml +
      issuesBadgeHtml +
      openSupplyBadgeHtml +
      sopBadgeHtml;

    const archiveLabel    = active ? "Archive" : "Reactivate";
    const archiveExtraCls = active ? ""        : " row-btn-reactivate";

    // Slug + email moved off the row to reduce visual clutter — both
    // remain editable in the Edit modal. The row name carries a
    // title="…" so admins who want the slug at a glance can hover.
    const rowTitle = "Slug: " + (slug || "—") + (email ? "\nEmail: " + email : "");

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(c.id) + '" title="' + escapeHtml(rowTitle) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">'  + escapeHtml(name) + '</span>' +
          '<span class="row-sub">'   + escapeHtml(location || "—") + '</span>' +
          metricsLineHtml +
          issueSummaryHtml +
        '</div>' +
        '<div class="row-actions"' + (budgetTooltip ? ' title="' + escapeHtml(budgetTooltip) + '"' : '') + '>' +
          '<div class="pill-badges">' + badges + '</div>' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          '<button class="row-btn' + archiveExtraCls + '" type="button" data-action="archive">' + archiveLabel + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  // V6 pilot fix — "No customers in Firestore yet" was sometimes
  // showing alongside populated customer cards because renderCustomers
  // can fire from the search filter BEFORE loadCustomers resolves
  // (race when the user types in the search box during load). The
  // empty-state should ONLY appear after the load completes AND the
  // resulting list is truly empty. customersLoaded becomes true on
  // the first successful loadCustomers run; until then, the empty
  // state stays suppressed.
  let customersLoaded = false;

  function renderCustomers(list) {
    const root = $("customer-list");
    const cnt  = $("customer-count");
    if (!root) return;
    if (cnt)  cnt.textContent = list.length + ' customer' + (list.length === 1 ? '' : 's');
    root.innerHTML = list.map(customerCard).join("");
    // Show "No customers in Firestore yet" ONLY when:
    //   • load has finished (customersLoaded === true),
    //   • the cache is genuinely empty (customers.length === 0),
    //   • and the current view list is empty.
    // A search-filter that returns zero is NOT empty — the cache has
    // customers; the user just filtered them out. That case lands
    // in `hideAllStatuses` below.
    if (list.length === 0 && customersLoaded && customers.length === 0) {
      setStatus("customer", "empty");
    } else {
      hideAllStatuses("customer");
    }
  }

  async function loadCustomers() {
    setStatus("customer", "loading");
    try {
      // Order client-side after fetch so docs with either `name` or
      // `customer_name` sort correctly.
      const snap = await db.collection("customers").get();
      customers = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customers.sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
      customersLoaded = true;
      renderCustomers(customers);
      refreshAttentionStrip();
    } catch (err) {
      console.error("loadCustomers failed", err);
      setStatus("customer", "error",
        "Couldn't load customers: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /customers."
      );
    }
  }

  /* ---------- cleaning techs ---------- */

  // Small avatar-strip thumbnail for the techs admin list. Mirrors the
  // customer-facing DCR-email identity bubble so admins notice at a
  // glance which techs still need a real photo. The .is-missing class
  // turns the chip red+warning so the eye catches it without having to
  // open the row.
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

    // Assignments summary. Replaces the prior metrics_cache cell — that
    // field was never populated in practice. "Needs assignments" is shown
    // only for active techs so archived rows don't shout for attention.
    const assigned    = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
    const assignedN   = assigned.length;
    const assignedTxt = assignedN === 0 ? "None" : (assignedN + (assignedN === 1 ? " customer" : " customers"));
    const needsAssign = active && assignedN === 0;

    // Per-tech on-budget summary. Admin-only — never surfaced to techs
    // themselves (see techHubViewV1 / tech.js — they get customer-level
    // budget info, not their own scoreboard).
    const budgetStats     = computeBudgetStats({ kind: "tech", slug: slug });
    const budgetBadgeHtml = budgetRowBadge(budgetStats);
    const budgetTooltip   = budgetTooltipText(budgetStats);

    // Photo/signature asset chips — surface missing media for active
    // techs (and only active techs; archived rows shouldn't shout).
    // The customer-facing DCR trust promise treats the photo as
    // required and the signature as strongly preferred.
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

    // Archived techs never show "DCR enabled"-style positive chrome.
    // The dcr_enabled flag stays stored unchanged (so reactivation
    // doesn't lose the prior config) but visually we replace the
    // active-tech chip set with a clear archived-state cluster.
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

    // Archive label flips for archived rows. (archiveExtraCls is no
    // longer needed — Archive lives inside the overflow menu now, and
    // .row-overflow-item-warn handles the color affordance.)
    const archiveLabel = active ? "Archive" : "Reactivate";

    // Account-status hint: when the last invite/reset was sent. Shows
    // "—" when never invited. The button label flips between
    // "Send invite" (no prior invite) and "Reinvite" (at least one
    // prior invite landed) based on the V6 inviteSentAt field, with
    // back-compat fallbacks to the legacy snake_case fields.
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

    // "Promote to Admin" — only visible for active techs with a real
    // email who DON'T already have admin access. We check both the
    // hardcoded root list and the loaded /admins cache. The button is
    // re-rendered after loadAdmins/loadTechs, so toggling admin status
    // refreshes the items on next paint.
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
          // Primary action.
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          // Photo + signature manager.
          '<button class="row-btn row-btn-secondary" type="button" data-action="media"' +
            ' title="Upload or change this tech\'s profile photo and signature">Media</button>' +
          // Secondary action — only when actually possible.
          (canResend
            ? '<button class="row-btn row-btn-secondary" type="button" data-action="resend"' +
                ' title="' + escapeHtml(inviteBtnTitle) + '">' +
                escapeHtml(inviteBtnLabel) +
              '</button>'
            : "") +
          // Surface a visible "Invite errored" chip when the last
          // attempt failed. The chip is non-interactive — admin
          // clicks the Reinvite button next to it to retry.
          (canResend && inviteStatus === "error"
            ? '<span class="tech-row-asset-chip tech-row-asset-chip-bad"' +
                ' title="' + escapeHtml(inviteLastError || "Last invite attempt failed") + '">' +
                'Invite errored' +
              '</span>'
            : "") +
          // Overflow menu — contains Promote / Archive(/Reactivate) / Delete.
          // The trigger button is .row-btn-more; the popover is a sibling
          // .row-overflow-menu that admin.js toggles via aria-expanded.
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
      const snap = await db.collection("cleaning_techs").get();
      techs = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      techs.sort(function (a, b) {
        return getTechName(a).localeCompare(getTechName(b));
      });
      renderTechs(techs);
      refreshAttentionStrip();
    } catch (err) {
      console.error("loadTechs failed", err);
      setStatus("tech", "error",
        "Couldn't load cleaning techs: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /cleaning_techs."
      );
    }
  }

  /* ---------- recent DCRs ---------- */

  function dcrIssueCount(dcr) {
    const sections = (dcr.form_data && dcr.form_data.checklist) || [];
    let count = 0;
    sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) {
        if (it && it.status === "issue") count += 1;
      });
    });
    return count;
  }

  function dcrCard(d) {
    const id        = d.submission_id || d.id;
    const cleanDate = d.clean_date || "—";
    const customer  = d.customer_name || "—";
    const tech      = d.tech_display_name || "—";
    const photoCount = Array.isArray(d.photo_urls) ? d.photo_urls.length :
                       Array.isArray(d.photos)     ? d.photos.length     : 0;
    const issues     = dcrIssueCount(d);
    const hasProblem = !!(d.form_data && d.form_data.has_problem);
    const zStatus    = (d.zapier && d.zapier.status) || "—";

    let problemBadge = "";
    if (hasProblem)      problemBadge = badge("is-err",  "Problem");
    else if (issues > 0) problemBadge = badge("is-warn", issues + " issue" + (issues === 1 ? "" : "s"));
    else                 problemBadge = badge("is-on",   "Clear");

    let zapBadge;
    if      (zStatus === "sent")           zapBadge = badge("is-on",   "Zapier: sent");
    else if (zStatus === "failed")         zapBadge = badge("is-err",  "Zapier: failed");
    else if (zStatus === "not_configured") zapBadge = badge("is-neutral", "Zapier: off");
    else                                   zapBadge = badge("is-neutral", "Zapier: —");

    const photoBadge = badge("is-photos", photoCount + ' photo' + (photoCount === 1 ? '' : 's'));

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(id) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">' + escapeHtml(customer) + '</span>' +
          '<span class="row-sub">'  + escapeHtml(cleanDate) + ' · ' + escapeHtml(tech) + '</span>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Submission</span>' +
          '<code style="font-size:11.5px;color:var(--pc-text-muted);">' + escapeHtml(id) + '</code>' +
        '</div>' +
        '<div class="row-cell">' +
          '<span class="cell-label">Created</span>' +
          escapeHtml(formatTimestamp(d.created_at)) +
        '</div>' +
        '<div class="row-actions">' +
          '<div class="pill-badges">' +
            photoBadge + problemBadge + zapBadge +
          '</div>' +
          // V6 — Review & Send opens the readiness modal for this DCR.
          // The modal calls getDcrEmailReadinessV1, renders blockers/
          // warnings, and only enables the actual Send button when
          // the DCR is ready (or the operator confirms a resend).
          '<button class="row-btn" type="button" data-action="review-send"' +
            ' title="Run the DCR email readiness check and send to the customer">' +
            'Review & Send' +
          '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderDcrs(list) {
    const root = $("dcr-list");
    const cnt  = $("dcr-count");
    if (!root) return;
    if (cnt) {
      const total = list.length;
      cnt.textContent =
        total + ' submission' + (total === 1 ? '' : 's') +
        ' (most recent first, capped at ' + DCR_RECENT_LIMIT + ')';
    }
    root.innerHTML = list.map(dcrCard).join("");
    if (list.length === 0 && dcrs.length === 0) setStatus("dcr", "empty");
    else hideAllStatuses("dcr");
  }

  async function loadDcrs() {
    setStatus("dcr", "loading");
    try {
      const snap = await db.collection("dcr_submissions")
        .orderBy("created_at", "desc")
        .limit(DCR_RECENT_LIMIT)
        .get();
      dcrs = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      renderDcrs(dcrs);
      // Re-render the customer + tech lists now that the analytics cache
      // (dcrs) is populated — those row renderers read budget stats from
      // this array. Safe no-ops if the lists haven't loaded yet (the
      // helpers check for the root element before painting).
      if (typeof applyCurrentCustomerFilter === "function") applyCurrentCustomerFilter();
      if (typeof applyCurrentTechFilter     === "function") applyCurrentTechFilter();
      refreshAttentionStrip();
    } catch (err) {
      console.error("loadDcrs failed", err);
      setStatus("dcr", "error",
        "Couldn't load DCR submissions: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /dcr_submissions." +
        "\nIf it says 'failed-precondition' or mentions an index, click the URL in the browser console to create the suggested composite index."
      );
    }
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

  /* =====================================================================
     DCR Issues — admin operational backlog
     =====================================================================
     The `dcr_issues` collection is auto-populated by submitDcrV1 each
     time a DCR contains checklist `issue` items or a problem-section
     report. This module manages the admin-side workflow: list, filter,
     status updates, admin_notes. Reads/writes are gated by
     firestore.rules → /dcr_issues/{id}: admin-only.
  */

  const ISSUE_STATUSES = ["new", "reviewed", "customer_contacted", "resolved", "closed_no_action"];
  const ISSUE_STATUS_LABELS = {
    new:                "New",
    reviewed:           "Reviewed",
    customer_contacted: "Customer contacted",
    resolved:           "Resolved",
    closed_no_action:   "Closed / No action"
  };
  const ISSUE_STATUS_BADGE_CLS = {
    new:                "is-warn",
    reviewed:           "is-neutral",
    customer_contacted: "is-neutral",
    resolved:           "is-on",
    closed_no_action:   "is-off"
  };

  async function loadDcrIssues() {
    setStatus("issues", "loading");
    try {
      // Order by created_at desc — most-recent issues bubble to the top.
      // Newer firestore SDKs sort nulls last so unstamped legacy docs
      // (if any) sink predictably.
      const snap = await db.collection("dcr_issues")
        .orderBy("created_at", "desc")
        .get();
      dcrIssues = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      refreshIssuesFilterOptions();
      applyCurrentIssuesFilter();
      refreshAttentionStrip();
      // Customer rows include open-issue counts — refresh them too once
      // the issues cache is hot.
      applyCurrentCustomerFilter();
    } catch (err) {
      console.error("loadDcrIssues failed", err);
      setStatus("issues", "error",
        "Couldn't load issues: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', confirm firestore.rules has " +
        "the /dcr_issues block deployed and you're signed in as an admin."
      );
    }
  }

  function dcrTsToFmt(ts) {
    // Reuse the supply timestamp helper — same Firestore Timestamp / ISO
    // shape variations.
    const ms = supplyTsToMs(ts);
    if (ms == null) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
           " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function issueCardHtml(it) {
    const status   = (it.status || "new");
    const statusCls = ISSUE_STATUS_BADGE_CLS[status] || "is-neutral";
    const statusOpts = ISSUE_STATUSES.map(function (s) {
      const sel = s === status ? " selected" : "";
      return '<option value="' + s + '"' + sel + '>' + ISSUE_STATUS_LABELS[s] + '</option>';
    }).join("");
    const stamps = [];
    if (it.reviewed_at)             stamps.push("Reviewed " + dcrTsToFmt(it.reviewed_at) + " by " + escapeHtml(it.reviewed_by || "?"));
    if (it.customer_contacted_at)   stamps.push("Customer contacted " + dcrTsToFmt(it.customer_contacted_at) + " by " + escapeHtml(it.customer_contacted_by || "?"));
    if (it.resolved_at)             stamps.push("Resolved " + dcrTsToFmt(it.resolved_at) + " by " + escapeHtml(it.resolved_by || "?"));
    if (it.updated_at)              stamps.push("Updated " + dcrTsToFmt(it.updated_at));

    const meta = [];
    if (it.clean_date)         meta.push("Clean date " + escapeHtml(it.clean_date));
    if (it.tech_display_name)  meta.push("Tech " + escapeHtml(it.tech_display_name));
    if (it.source)             meta.push("Source: " + escapeHtml(it.source));
    if (it.issue_type)         meta.push(escapeHtml(it.issue_type));

    return (
      '<article class="issue-card" data-issue-id="' + escapeHtml(it.id) + '">' +
        '<div class="issue-head">' +
          '<span class="issue-customer">' +
            escapeHtml(it.customer_name || it.customer_slug || "(unknown customer)") +
            (it.location_name && it.location_name !== it.customer_name
              ? ' <span class="issue-meta">· ' + escapeHtml(it.location_name) + '</span>' : '') +
          '</span>' +
          '<span class="pill-badges">' + badge(statusCls, ISSUE_STATUS_LABELS[status] || status) + '</span>' +
        '</div>' +
        '<div class="issue-meta">' + meta.map(escapeHtml).join(" · ").replace(/&amp;lt;|&amp;gt;|&amp;amp;/g, function (m) { return m; }) + '</div>' +
        '<p class="issue-summary">' + escapeHtml(it.issue_summary || "(no summary)") + '</p>' +
        '<div class="issue-actions">' +
          '<select class="issue-status-select" aria-label="Status">' + statusOpts + '</select>' +
          '<input type="text" class="issue-notes-input" placeholder="Admin notes…" value="' +
            escapeHtml(it.admin_notes || "") + '" />' +
          '<button class="issue-save-btn" type="button" data-action="save">Save</button>' +
          '<span class="issue-saved-hint" data-role="saved-hint" hidden>Saved.</span>' +
        '</div>' +
        (stamps.length
          ? '<div class="issue-stamps">' + stamps.join(" · ") + '</div>'
          : '') +
      '</article>'
    );
  }

  function renderIssues(list) {
    const root = $("issues-list");
    const cnt  = $("issues-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + ' issue' + (list.length === 1 ? '' : 's');

    // Refresh the per-status counts on the filter pills.
    const counts = { all: dcrIssues.length };
    ISSUE_STATUSES.forEach(function (s) { counts[s] = 0; });
    dcrIssues.forEach(function (it) {
      const s = (it.status || "new");
      if (counts[s] != null) counts[s] += 1;
    });
    Object.keys(counts).forEach(function (k) {
      const el = document.querySelector('.issues-filter-count[data-count-for="' + k + '"]');
      if (el) el.textContent = counts[k];
    });

    // Top-tab "New" badge.
    const tabBadge = $("issues-tab-badge");
    if (tabBadge) {
      if (counts.new > 0) {
        tabBadge.textContent = String(counts.new);
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }

    root.innerHTML = list.map(issueCardHtml).join("");
    if (list.length === 0 && dcrIssues.length === 0) setStatus("issues", "empty");
    else hideAllStatuses("issues");
  }

  function applyCurrentIssuesFilter() {
    const q = (($("issues-search") && $("issues-search").value) || "").trim().toLowerCase();

    // New compound filters: customer / tech / time window.
    const custSel = $("issues-filter-customer");
    const techSel = $("issues-filter-tech");
    const winSel  = $("issues-filter-window");
    const wantCust = custSel ? custSel.value : "all";
    const wantTech = techSel ? techSel.value : "all";
    const winKey   = winSel  ? winSel.value  : "all";

    let cutoffMs = null;
    if (winKey === "7")     cutoffMs = Date.now() - 7  * 24 * 3600 * 1000;
    else if (winKey === "30") cutoffMs = Date.now() - 30 * 24 * 3600 * 1000;
    else if (winKey === "month") {
      const d = new Date();
      cutoffMs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }

    const filtered = dcrIssues.filter(function (it) {
      if (currentIssueStatus !== "all" && (it.status || "new") !== currentIssueStatus) return false;
      if (wantCust !== "all" && (it.customer_slug || "") !== wantCust) return false;
      if (wantTech !== "all" && (it.tech_slug || "")     !== wantTech) return false;
      if (cutoffMs != null) {
        const ms = supplyTsToMs(it.created_at);
        if (ms == null || ms < cutoffMs) return false;
      }
      if (!q) return true;
      return (
        (it.customer_name || "").toLowerCase().includes(q) ||
        (it.location_name || "").toLowerCase().includes(q) ||
        (it.tech_display_name || "").toLowerCase().includes(q) ||
        (it.issue_summary || "").toLowerCase().includes(q) ||
        (it.issue_type    || "").toLowerCase().includes(q)
      );
    });
    renderIssues(filtered);
  }

  // Populate the Issues tab's customer + tech selects from the cached
  // dcrIssues collection. Called whenever the collection reloads.
  function refreshIssuesFilterOptions() {
    function uniqueOptions(arr, keyField, labelField) {
      const seen = {};
      arr.forEach(function (it) {
        const k = it[keyField];
        if (!k) return;
        if (!seen[k]) seen[k] = it[labelField] || k;
      });
      return Object.keys(seen).sort(function (a, b) {
        return String(seen[a]).localeCompare(String(seen[b]));
      }).map(function (k) {
        return '<option value="' + escapeHtml(k) + '">' + escapeHtml(seen[k]) + '</option>';
      }).join("");
    }
    const custSel = $("issues-filter-customer");
    const techSel = $("issues-filter-tech");
    if (custSel) {
      const cur = custSel.value;
      custSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(dcrIssues, "customer_slug", "customer_name");
      custSel.value = cur || "all";
    }
    if (techSel) {
      const cur = techSel.value;
      techSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(dcrIssues, "tech_slug", "tech_display_name");
      techSel.value = cur || "all";
    }
  }

  async function saveIssueRow(card) {
    if (!card) return;
    const issueId = card.dataset.issueId;
    if (!issueId) return;
    const idx = dcrIssues.findIndex(function (x) { return x.id === issueId; });
    if (idx < 0) return;

    const sel = card.querySelector(".issue-status-select");
    const inp = card.querySelector(".issue-notes-input");
    const btn = card.querySelector(".issue-save-btn");
    const hint = card.querySelector('[data-role="saved-hint"]');
    if (!sel || !inp || !btn) return;

    const prev      = dcrIssues[idx];
    const newStatus = sel.value || "new";
    const newNotes  = inp.value || "";

    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const update = {
      status:      newStatus,
      admin_notes: newNotes,
      updated_at:  sts,
      updated_by:  adminEmail
    };
    // Workflow stamps — only set the FIRST time we enter that status.
    if (newStatus === "reviewed" && !prev.reviewed_at) {
      update.reviewed_at = sts;
      update.reviewed_by = adminEmail;
    }
    if (newStatus === "customer_contacted" && !prev.customer_contacted_at) {
      update.customer_contacted_at = sts;
      update.customer_contacted_by = adminEmail;
    }
    if ((newStatus === "resolved" || newStatus === "closed_no_action") && !prev.resolved_at) {
      update.resolved_at = sts;
      update.resolved_by = adminEmail;
    }

    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Saving…";
    try {
      await db.collection("dcr_issues").doc(issueId).update(update);
      dcrIssues[idx] = Object.assign({}, prev, update, {
        updated_at: new Date(),
        reviewed_at:           update.reviewed_at           ? new Date() : prev.reviewed_at,
        customer_contacted_at: update.customer_contacted_at ? new Date() : prev.customer_contacted_at,
        resolved_at:           update.resolved_at           ? new Date() : prev.resolved_at
      });
      if (hint) { hint.hidden = false; setTimeout(function () { hint.hidden = true; }, 1600); }
      applyCurrentIssuesFilter();
      refreshAttentionStrip();
      // Open-issue counts on customer rows depend on this — refresh.
      applyCurrentCustomerFilter();
    } catch (err) {
      handleAdminWriteError(err, { context: "issue save" });
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }

  function wireIssuesControls() {
    const search = $("issues-search");
    if (search) search.addEventListener("input", applyCurrentIssuesFilter);

    // Compound filter selects — refilter in place, no reload.
    ["issues-filter-customer", "issues-filter-tech", "issues-filter-window"].forEach(function (id) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", applyCurrentIssuesFilter);
    });

    // Filter pills.
    const filter = $("issues-filter");
    if (filter) {
      filter.addEventListener("click", function (ev) {
        const btn = ev.target.closest(".issues-filter-pill");
        if (!btn) return;
        currentIssueStatus = btn.dataset.status || "all";
        filter.querySelectorAll(".issues-filter-pill").forEach(function (p) {
          p.classList.toggle("is-active", p === btn);
        });
        applyCurrentIssuesFilter();
      });
    }

    // Save delegation.
    const list = $("issues-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest('[data-action="save"]');
        if (!btn) return;
        const card = btn.closest(".issue-card");
        saveIssueRow(card);
      });
    }

    const refresh = $("issues-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      refresh.disabled = true;
      const original = refresh.textContent;
      refresh.textContent = "Refreshing…";
      loadDcrIssues().finally(function () {
        refresh.disabled = false;
        refresh.textContent = original;
      });
    });
  }

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
          currentIssueStatus = "new";
          const filter = $("issues-filter");
          if (filter) {
            filter.querySelectorAll(".issues-filter-pill").forEach(function (p) {
              p.classList.toggle("is-active", p.dataset.status === "new");
            });
          }
          applyCurrentIssuesFilter();
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

  /* --------------------------------------------------------------------
   * Pioneer SOS — admin review panel.
   *
   * Reads emergency_events (admin-only via Firestore rule). Real-time
   * snapshot listener so a new alert appears without manual refresh.
   * Each card shows severity, tech, location, time, details, geolocation
   * link (if available), and notification status. Resolve button writes
   * status=resolved + resolved_at + resolved_by + resolution_notes.
   * ------------------------------------------------------------------ */
  let sosWired = false;
  let sosFilter = "open";
  let sosUnsubscribe = null;
  let sosLastEvents = [];

  function initSosOnce() {
    if (sosWired) {
      sosStartListening();
      return;
    }
    sosWired = true;
    const refresh = document.getElementById("sos-refresh");
    if (refresh) refresh.addEventListener("click", function () { sosStartListening(true); });
    document.querySelectorAll(".sos-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sosFilter = btn.dataset.filter || "open";
        document.querySelectorAll(".sos-filter").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        renderSosList();
      });
    });
    sosStartListening();
  }

  function sosStartListening(forceRebind) {
    if (sosUnsubscribe && !forceRebind) return;
    if (sosUnsubscribe && forceRebind) {
      try { sosUnsubscribe(); } catch (_e) {}
      sosUnsubscribe = null;
    }
    const loading = document.getElementById("sos-loading");
    const errEl   = document.getElementById("sos-error");
    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden = true;
    try {
      sosUnsubscribe = firebase.firestore()
        .collection("emergency_events")
        .orderBy("createdAt", "desc")
        .limit(200)
        .onSnapshot(function (snap) {
          sosLastEvents = snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
          if (loading) loading.hidden = true;
          renderSosList();
          updateSosBadge();
        }, function (err) {
          console.error("[sos-admin] snapshot failed", err);
          if (loading) loading.hidden = true;
          if (errEl) { errEl.textContent = "Couldn't load SOS events: " + (err && err.message || "unknown"); errEl.hidden = false; }
        });
    } catch (err) {
      if (loading) loading.hidden = true;
      if (errEl) { errEl.textContent = "Couldn't open SOS listener: " + (err && err.message); errEl.hidden = false; }
    }
  }

  function updateSosBadge() {
    const badge = document.getElementById("sos-tab-badge");
    if (!badge) return;
    const open = sosLastEvents.filter(function (e) {
      return String(e.status || "open") !== "resolved";
    }).length;
    if (open > 0) { badge.textContent = String(open); badge.hidden = false; }
    else          { badge.textContent = "0";          badge.hidden = true;  }
  }

  function renderSosList() {
    const list  = document.getElementById("sos-list");
    const empty = document.getElementById("sos-empty");
    if (!list) return;
    const filtered = sosLastEvents.filter(function (e) {
      const s = String(e.status || "open");
      const sev = String(e.severity || "help_needed");
      if (sosFilter === "open")     return s !== "resolved";
      if (sosFilter === "critical") return sev === "critical";
      if (sosFilter === "resolved") return s === "resolved";
      return true;
    });
    if (filtered.length === 0) {
      list.innerHTML = "";
      if (empty) {
        empty.textContent = sosLastEvents.length === 0
          ? "No SOS events yet — quiet shift, good."
          : "Nothing matches this filter.";
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = filtered.map(renderSosCard).join("");
    list.querySelectorAll("button[data-sos-resolve]").forEach(function (btn) {
      btn.addEventListener("click", function () { resolveSosEvent(btn); });
    });
  }

  function renderSosCard(e) {
    const id       = e._id;
    const severity = String(e.severity || "help_needed");
    const status   = String(e.status || "open");
    const notif    = String(e.notificationStatus || "pending");
    const notified = e.notified || {};
    const created  = formatImprovementDate(e.createdAt);
    const techName = escapeHtml(e.techName || e.createdByEmail || "(unknown)");
    const customer = e.customerName || e.locationName || "";
    const customerLine = customer
      ? '<span class="sos-evt-customer">📍 ' + escapeHtml(customer) + '</span>'
      : '<span class="sos-evt-customer sos-evt-customer-empty">No shift in progress</span>';
    const details  = e.details ? escapeHtml(String(e.details)) : "";
    const detailsBlock = details
      ? '<p class="sos-evt-details">' + details.replace(/\n/g, "<br>") + '</p>'
      : '<p class="sos-evt-details sos-evt-details-empty">(no description provided)</p>';
    const geo = e.geolocation;
    const geoLine = (geo && geo.lat != null && geo.lng != null)
      ? '<a class="sos-evt-geo" href="https://maps.google.com/?q=' + Number(geo.lat) + ',' + Number(geo.lng) +
        '" target="_blank" rel="noopener noreferrer">📌 Open in Maps</a>'
      : '';
    const shiftRef = e.shiftId
      ? '<span class="sos-evt-meta-piece">Shift #' + escapeHtml(String(e.shiftId)) + '</span>'
      : '';

    const notifBits = [];
    notifBits.push((notified.april ? "✓ April" : "✗ April"));
    notifBits.push((notified.kirby ? "✓ Kirby" : "✗ Kirby"));
    notifBits.push((notified.nick  ? "✓ Nick"  : "✗ Nick"));
    let notifLabel;
    if (notif === "sent")                     notifLabel = "SMS sent · " + notifBits.join(" · ");
    else if (notif === "partial")             notifLabel = "Partial · " + notifBits.join(" · ");
    else if (notif === "sms_provider_missing")notifLabel = "SMS provider not configured · call manually";
    else if (notif === "failed")              notifLabel = "SMS dispatch failed · call manually";
    else                                       notifLabel = "Dispatching…";

    const resolutionBlock = status === "resolved"
      ? '<div class="sos-evt-resolution">' +
          '<p class="sos-evt-resolution-when">Resolved ' +
            escapeHtml(formatImprovementDate(e.resolved_at) || "") +
            (e.resolved_by && e.resolved_by.displayName
              ? ' by ' + escapeHtml(e.resolved_by.displayName) : '') +
          '</p>' +
          (e.resolution_notes
            ? '<p class="sos-evt-resolution-notes">' + escapeHtml(e.resolution_notes) + '</p>'
            : '') +
        '</div>'
      : '<div class="sos-evt-resolve">' +
          '<input type="text" class="sos-evt-notes" data-sos-notes="' + escapeHtml(id) + '"' +
            ' placeholder="Resolution notes (what happened, how it was handled)" maxlength="300" />' +
          '<button type="button" class="panel-action" data-sos-resolve="' + escapeHtml(id) + '">Mark resolved</button>' +
        '</div>';

    return '<article class="sos-evt sos-evt-' + escapeHtml(severity) + ' sos-evt-' + escapeHtml(status) + '" data-sos-id="' + escapeHtml(id) + '">' +
             '<header class="sos-evt-head">' +
               '<span class="sos-evt-sev sos-sev-' + escapeHtml(severity) + '">' +
                 (severity === "critical" ? "🚨 EMERGENCY" : "⚠ HELP NEEDED") +
               '</span>' +
               '<strong class="sos-evt-tech">' + techName + '</strong>' +
               '<span class="sos-evt-time">' + escapeHtml(created) + '</span>' +
             '</header>' +
             '<div class="sos-evt-meta">' +
               customerLine +
               (geoLine ? ' · ' + geoLine : '') +
               (shiftRef ? ' · ' + shiftRef : '') +
             '</div>' +
             detailsBlock +
             '<div class="sos-evt-notif">' + escapeHtml(notifLabel) + '</div>' +
             '<div class="sos-evt-callbar">' +
               '<a class="sos-evt-call-btn" href="tel:+15098283335">📞 Call April</a>' +
               '<a class="sos-evt-call-btn" href="tel:911">📞 911</a>' +
             '</div>' +
             resolutionBlock +
           '</article>';
  }

  async function resolveSosEvent(btn) {
    const id = btn.getAttribute("data-sos-resolve");
    if (!id) return;
    const notesEl = document.querySelector('input[data-sos-notes="' + cssEsc(id) + '"]');
    const notes = String((notesEl && notesEl.value) || "").trim();
    if (!notes) {
      alert("Add a one-line resolution note before marking resolved.");
      if (notesEl) notesEl.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const u = firebase.auth().currentUser;
      await firebase.firestore().collection("emergency_events").doc(id).set({
        status:            "resolved",
        resolution_notes:  notes,
        resolved_at:       firebase.firestore.FieldValue.serverTimestamp(),
        resolved_by: {
          uid:         (u && u.uid)         || null,
          email:       (u && u.email)       || null,
          displayName: (u && u.displayName) || (u && u.email) || "admin"
        }
      }, { merge: true });
    } catch (err) {
      console.error("[sos-admin] resolve failed", err);
      btn.disabled = false;
      btn.textContent = "Mark resolved";
      alert("Couldn't save: " + (err && err.message));
    }
  }

  /* --------------------------------------------------------------------
   * Help Improve Pioneer — admin review panel.
   * Reads pioneer_improvements (admin-only via Firestore rule). Lists
   * each submission with the 3 answers, optional category/photos, and
   * status workflow (submitted / reviewing / needs_clarification /
   * implemented / declined). Protected concerns get a distinct chrome
   * + an "Anonymous submission" tag (identity hidden in the card body
   * but still on the doc for serious-followup audit).
   * ------------------------------------------------------------------ */
  let improvementsWired = false;
  let improvementsCurrentFilter = "open";
  let improvementsLastDocs = [];

  const IMPROVEMENT_STATUSES = [
    { value: "submitted",           label: "New" },
    { value: "reviewing",           label: "Reviewing" },
    { value: "needs_clarification", label: "Needs clarification" },
    { value: "implemented",         label: "Implemented" },
    { value: "declined",            label: "Declined" }
  ];
  const IMPROVEMENT_CATEGORY_LABELS = {
    pioneerops_ux: "PioneerOps UX",
    customer:      "Customer issue",
    supplies:      "Supplies",
    scheduling:    "Scheduling",
    communication: "Communication",
    safety:        "Safety",
    operations:    "Operations",
    equipment:     "Equipment",
    other:         "Other",
    protected:     "Protected concern"
  };

  function initImprovementsOnce() {
    if (improvementsWired) {
      loadImprovements();
      return;
    }
    improvementsWired = true;
    const refresh = document.getElementById("improvements-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadImprovements(); });
    document.querySelectorAll(".improvements-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        improvementsCurrentFilter = btn.dataset.filter || "open";
        document.querySelectorAll(".improvements-filter").forEach(function (b) {
          b.classList.toggle("is-active", b === btn);
        });
        renderImprovements();
      });
    });
    loadImprovements();
  }

  async function loadImprovements() {
    const loading = document.getElementById("improvements-loading");
    const errEl   = document.getElementById("improvements-error");
    const empty   = document.getElementById("improvements-empty");
    const list    = document.getElementById("improvements-list");
    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden   = true;
    if (empty)   empty.hidden   = true;
    if (list)    list.innerHTML = "";
    try {
      const db   = firebase.firestore();
      const snap = await db.collection("pioneer_improvements")
        .orderBy("created_at", "desc")
        .limit(200)
        .get();
      improvementsLastDocs = snap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data());
      });
      renderImprovements();
      updateImprovementsBadge();
    } catch (err) {
      console.error("[improvements] load failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't load improvements: " + (err && err.message || "unknown");
        errEl.hidden = false;
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function updateImprovementsBadge() {
    const badge = document.getElementById("improvements-tab-badge");
    if (!badge) return;
    const openCount = improvementsLastDocs.filter(function (d) {
      const s = String(d.status || "submitted");
      return s === "submitted" || s === "needs_clarification";
    }).length;
    if (openCount > 0) { badge.textContent = String(openCount); badge.hidden = false; }
    else               { badge.textContent = "0"; badge.hidden = true; }
  }

  function renderImprovements() {
    const list  = document.getElementById("improvements-list");
    const empty = document.getElementById("improvements-empty");
    if (!list) return;
    const filtered = improvementsLastDocs.filter(function (d) {
      const s = String(d.status || "submitted");
      if (improvementsCurrentFilter === "open") {
        return s !== "implemented" && s !== "declined";
      }
      if (improvementsCurrentFilter === "implemented") return s === "implemented";
      if (improvementsCurrentFilter === "protected")   return d.is_protected === true;
      return true; // all
    });
    if (filtered.length === 0) {
      list.innerHTML = "";
      if (empty) {
        empty.textContent = improvementsLastDocs.length === 0
          ? "No submissions yet. Share the /improve.html link with the team."
          : "Nothing matches this filter. Try another one above.";
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = filtered.map(renderImprovementCard).join("");
    // Wire status-change selects + admin-note textareas.
    list.querySelectorAll("select[data-improvement-id]").forEach(function (sel) {
      sel.addEventListener("change", function () { updateImprovementStatus(sel); });
    });
    list.querySelectorAll("button[data-action='save-notes']").forEach(function (btn) {
      btn.addEventListener("click", function () { saveImprovementNotes(btn); });
    });
  }

  function renderImprovementCard(d) {
    const id = d._id || d.submission_id;
    const status = String(d.status || "submitted");
    const isProtected = d.is_protected === true;
    const anon = d.is_anonymous === true;
    const submitter = anon
      ? "Anonymous"
      : (escapeHtml(d.submitted_by_name || d.submitted_by_email || "(unknown)"));
    const submitterMeta = anon ? "" : (
      d.submitted_by_email ? ('<span class="impr-meta-email">' + escapeHtml(d.submitted_by_email) + '</span>') : ''
    );
    const categoryLabel = IMPROVEMENT_CATEGORY_LABELS[d.category] || (d.category || "—");
    const photos = Array.isArray(d.photo_urls) ? d.photo_urls : [];
    const photosHtml = photos.length === 0 ? "" :
      '<div class="impr-photos">' +
        photos.map(function (u, i) {
          return '<a class="impr-photo" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">' +
                   '<img src="' + escapeHtml(u) + '" alt="Screenshot ' + (i + 1) + '" />' +
                 '</a>';
        }).join("") +
      '</div>';
    const statusOptions = IMPROVEMENT_STATUSES.map(function (s) {
      return '<option value="' + s.value + '"' + (s.value === status ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>';
    }).join("");
    const createdAt = formatImprovementDate(d.created_at);
    const lastChangeAt = (d.last_status_change_at && tsToMs(d.last_status_change_at) !== tsToMs(d.created_at))
      ? formatImprovementDate(d.last_status_change_at)
      : "";

    const protectedBadge = isProtected
      ? '<span class="impr-tag impr-tag-protected">Protected</span>'
      : '';
    const anonBadge = anon
      ? '<span class="impr-tag impr-tag-anon">Anonymous</span>'
      : '';
    const pioneerOpsBadge = d.is_pioneerops_issue
      ? '<span class="impr-tag impr-tag-app">PioneerOps app</span>'
      : '';

    return '<article class="impr-card impr-status-' + status + (isProtected ? ' is-protected' : '') + '" data-id="' + escapeHtml(id) + '">' +
             '<header class="impr-card-head">' +
               '<div class="impr-card-titles">' +
                 '<strong class="impr-card-submitter">' + submitter + '</strong> ' +
                 (submitterMeta ? submitterMeta : '') +
                 '<div class="impr-card-meta">' +
                   '<span class="impr-meta-cat">' + escapeHtml(categoryLabel) + '</span> · ' +
                   '<span class="impr-meta-date">' + escapeHtml(createdAt) + '</span>' +
                   (lastChangeAt ? ' · <span class="impr-meta-changed">status changed ' + escapeHtml(lastChangeAt) + '</span>' : '') +
                 '</div>' +
               '</div>' +
               '<div class="impr-card-tags">' + protectedBadge + anonBadge + pioneerOpsBadge + '</div>' +
             '</header>' +
             '<dl class="impr-card-answers">' +
               '<div><dt>Problem</dt><dd>' + escapeHtml(d.problem || "—") + '</dd></div>' +
               '<div><dt>Why it matters</dt><dd>' + escapeHtml(d.why_matters || "—") + '</dd></div>' +
               '<div><dt>Suggested improvement</dt><dd>' + escapeHtml(d.suggested_improvement || "—") + '</dd></div>' +
             '</dl>' +
             photosHtml +
             '<div class="impr-card-admin">' +
               '<label class="impr-status-label">' +
                 '<span>Status</span>' +
                 '<select data-improvement-id="' + escapeHtml(id) + '">' + statusOptions + '</select>' +
               '</label>' +
               '<label class="impr-notes-label">' +
                 '<span>Admin notes (internal)</span>' +
                 '<textarea rows="2" data-improvement-id="' + escapeHtml(id) + '" data-field="admin_notes">' + escapeHtml(d.admin_notes || "") + '</textarea>' +
               '</label>' +
               '<button type="button" class="panel-action impr-save-notes" data-action="save-notes" data-improvement-id="' + escapeHtml(id) + '">Save notes</button>' +
             '</div>' +
           '</article>';
  }

  function formatImprovementDate(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }

  async function updateImprovementStatus(selectEl) {
    const id     = selectEl.getAttribute("data-improvement-id");
    const status = selectEl.value;
    if (!id || !status) return;
    selectEl.disabled = true;
    try {
      const db  = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const u   = firebase.auth().currentUser;
      const update = {
        status: status,
        updated_at: sts,
        last_status_change_at: sts,
        last_status_change_by: {
          uid:         (u && u.uid) || null,
          email:       (u && u.email) || null,
          displayName: (u && u.displayName) || (u && u.email) || "admin"
        }
      };
      if (status === "implemented") {
        update.implemented_at = sts;
      }
      await db.collection("pioneer_improvements").doc(id).set(update, { merge: true });
      const card = selectEl.closest(".impr-card");
      if (card) {
        IMPROVEMENT_STATUSES.forEach(function (s) {
          card.classList.remove("impr-status-" + s.value);
        });
        card.classList.add("impr-status-" + status);
      }
      // Reflect locally so the badge + filter update without a refetch.
      const local = improvementsLastDocs.find(function (d) { return (d._id || d.submission_id) === id; });
      if (local) local.status = status;
      updateImprovementsBadge();
    } catch (err) {
      console.error("[improvements] status update failed", err);
      alert("Couldn't update status: " + (err && err.message));
    } finally {
      selectEl.disabled = false;
    }
  }

  async function saveImprovementNotes(btn) {
    const id = btn.getAttribute("data-improvement-id");
    if (!id) return;
    const ta = document.querySelector(
      'textarea[data-improvement-id="' + cssEsc(id) + '"][data-field="admin_notes"]'
    );
    if (!ta) return;
    const value = String(ta.value || "").trim();
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Saving…";
    try {
      await firebase.firestore().collection("pioneer_improvements").doc(id).set({
        admin_notes: value,
        updated_at:  firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      btn.textContent = "Saved";
      setTimeout(function () { btn.textContent = origLabel; }, 1400);
    } catch (err) {
      console.error("[improvements] save notes failed", err);
      btn.textContent = origLabel;
      alert("Couldn't save notes: " + (err && err.message));
    } finally {
      btn.disabled = false;
    }
  }

  /* --------------------------------------------------------------------
   * Yesterday's Work / Nightly Recap — admin-only operational recap.
   *
   * Pure frontend. Admin reads cover every collection it needs:
   *   deputy_shift_cache · pioneer_work_sessions · dcr_submissions ·
   *   dcr_issues · cleaning_techs · customers.
   *
   * Matching shift → DCR runs strongest-first:
   *   1. dcr.pioneer_session_id === shift.shift_id
   *   2. dcr.deputy_shift_id    === shift.shift_id
   *   3. tech_slug + customer_slug + clean_date == sync_date
   *   4. tech_email + customer_slug + clean_date (final fallback)
   *
   * Email status comes from `emailStatus` on the dcr_submissions doc
   * (set by dcrEmail.js). Legacy `zapier.status` is shown only in the
   * debug payload — it is NOT used to decide GREEN/YELLOW/RED.
   *
   * Status traffic light:
   *   GREEN  — DCR submitted, no issue, native email sent or skipped
   *   YELLOW — DCR submitted but: issue flagged, OR email failed,
   *            OR has_problem on form
   *   RED    — scheduled/started but no DCR submitted, OR red-tier issue
   * ------------------------------------------------------------------ */
  let yesterdayWired = false;
  let yesterdayLastReport = null;

  function initYesterdayOnce() {
    if (yesterdayWired) {
      // Already wired — keep current date but re-fetch fresh data.
      loadYesterdayReport();
      return;
    }
    yesterdayWired = true;
    const dateEl  = document.getElementById("yesterday-date");
    const prevBtn = document.getElementById("yesterday-prev-day");
    const nextBtn = document.getElementById("yesterday-next-day");
    const refresh = document.getElementById("yesterday-refresh");
    if (dateEl) {
      dateEl.value = pacificYesterdayDate();
      dateEl.addEventListener("change", function () { loadYesterdayReport(); });
    }
    if (prevBtn) prevBtn.addEventListener("click", function () { shiftYesterdayDate(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { shiftYesterdayDate(1); });
    if (refresh) refresh.addEventListener("click", function () { loadYesterdayReport(); });
    loadYesterdayReport();
  }

  // YYYY-MM-DD in America/Los_Angeles for today and yesterday.
  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
  }
  function pacificTodayDate() { return pacificDateString(new Date()); }
  function pacificYesterdayDate() {
    return pacificDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }
  function shiftYesterdayDate(deltaDays) {
    const el = document.getElementById("yesterday-date");
    if (!el || !el.value) return;
    const [y, m, d] = el.value.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    base.setUTCDate(base.getUTCDate() + deltaDays);
    el.value = pacificDateString(base);
    loadYesterdayReport();
  }

  function nextDay(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    base.setUTCDate(base.getUTCDate() + 1);
    return pacificDateString(base);
  }

  // The ops window for a selected date = [selected 4pm PT, next 4pm PT).
  // Returns ISO strings for label rendering + millisecond bounds for
  // optional scheduled_start filtering (the primary key is sync_date).
  function opsWindowFor(selectedDate) {
    const start = new Date(selectedDate + "T16:00:00-07:00");
    const end   = new Date(nextDay(selectedDate) + "T16:00:00-07:00");
    // -07:00 is fine year-round here because PioneerOps is fixed Pacific
    // — DST jitter of one hour at the boundary doesn't change WHICH
    // shifts fall in the window, since deputy_shift_cache buckets by
    // sync_date.
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  function tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  function formatTimeRangePT(startMs, endMs) {
    function fmt(ms) {
      if (!ms) return "";
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric", minute: "2-digit", hour12: true
        }).format(new Date(ms));
      } catch (_e) { return ""; }
    }
    const s = fmt(startMs);
    const e = fmt(endMs);
    if (s && e) return s + " – " + e;
    return s || e || "";
  }

  function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }
  function normSlug(s)  { return String(s == null ? "" : s).trim().toLowerCase(); }

  async function loadYesterdayReport() {
    const dateEl  = document.getElementById("yesterday-date");
    const loading = document.getElementById("yesterday-loading");
    const errEl   = document.getElementById("yesterday-error");
    const sumEl   = document.getElementById("yesterday-summary");
    const techEl  = document.getElementById("yesterday-by-tech");
    const undcrEl = document.getElementById("yesterday-unmatched-dcrs");
    const unshEl  = document.getElementById("yesterday-unmatched-shifts");
    const emptyEl = document.getElementById("yesterday-empty");
    const labelEl = document.getElementById("yesterday-window-label");
    if (!dateEl) return;

    const selected = dateEl.value || pacificYesterdayDate();
    const nextDate = nextDay(selected);
    const opsWindow = opsWindowFor(selected);

    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden   = true;
    if (sumEl)   sumEl.hidden   = true;
    if (techEl)  techEl.innerHTML = "";
    if (undcrEl) undcrEl.hidden = true;
    if (unshEl)  unshEl.hidden  = true;
    if (emptyEl) emptyEl.hidden = true;
    if (labelEl) {
      labelEl.textContent = "Ops window · " + selected + " 4:00pm PT → " +
        nextDate + " 4:00pm PT";
    }

    try {
      const db = firebase.firestore();
      const dateRange = [selected, nextDate];

      const [shiftsSnap, sessionsSnap, dcrsSnap, issuesSnap, techsSnap, customersSnap] = await Promise.all([
        db.collection("deputy_shift_cache").where("sync_date", "in", dateRange).get(),
        db.collection("pioneer_work_sessions").where("sync_date", "in", dateRange).get(),
        db.collection("dcr_submissions").where("clean_date", "in", dateRange).get(),
        db.collection("dcr_issues").where("clean_date", "in", dateRange).get().catch(function () { return { docs: [] }; }),
        db.collection("cleaning_techs").get(),
        db.collection("customers").get()
      ]);

      const shifts    = shiftsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const sessions  = sessionsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const dcrs      = dcrsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const issues    = (issuesSnap.docs || []).map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const techs     = techsSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      const customers = customersSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

      // Optional finer filter: when a shift carries a scheduled_start
      // outside the 24h ops window, drop it. Shifts with no start time
      // fall back to sync_date attribution.
      const inWindow = function (shift) {
        const sMs = tsToMs(shift.start_time);
        if (sMs == null) return true;
        return sMs >= opsWindow.startMs && sMs < opsWindow.endMs;
      };
      const filteredShifts = shifts.filter(inWindow);

      const report = buildYesterdayReport({
        selected:   selected,
        shifts:     filteredShifts,
        sessions:   sessions,
        dcrs:       dcrs,
        issues:     issues,
        techs:      techs,
        customers:  customers
      });
      yesterdayLastReport = report;

      renderYesterdaySummary(report);
      renderYesterdayByTech(report);
      renderYesterdayUnmatched(report);

      if (report.summary.scheduled === 0 && report.summary.dcrs_submitted === 0) {
        if (emptyEl) emptyEl.hidden = false;
      }
    } catch (err) {
      console.error("yesterday: load failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't load: " + (err && err.message ? err.message : "unknown error");
        errEl.hidden = false;
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function buildYesterdayReport(ctx) {
    const sessionByShiftId = Object.create(null);
    ctx.sessions.forEach(function (s) {
      const k = String(s.deputy_shift_id || s.id);
      sessionByShiftId[k] = s;
    });
    const customerBySlug = Object.create(null);
    ctx.customers.forEach(function (c) {
      customerBySlug[normSlug(c.customer_slug || c.id)] = c;
    });
    const techBySlug = Object.create(null);
    const techByEmail = Object.create(null);
    ctx.techs.forEach(function (t) {
      techBySlug[normSlug(t.tech_slug || t.id)] = t;
      if (t.email) techByEmail[normEmail(t.email)] = t;
    });
    const issuesByDcrId = Object.create(null);
    ctx.issues.forEach(function (i) {
      const k = String(i.dcr_submission_id || i.submission_id || "");
      if (!k) return;
      if (!issuesByDcrId[k]) issuesByDcrId[k] = [];
      issuesByDcrId[k].push(i);
    });

    // Build the dcr-match index by every key we might match on.
    const dcrByPioneerSession = Object.create(null);
    const dcrByDeputyShift    = Object.create(null);
    const dcrByTripleKey      = Object.create(null); // techSlug|custSlug|cleanDate
    const dcrByEmailKey       = Object.create(null); // techEmail|custSlug|cleanDate
    ctx.dcrs.forEach(function (d) {
      const psid = String(d.pioneer_session_id || "").trim();
      if (psid) dcrByPioneerSession[psid] = d;
      const dsid = String(d.deputy_shift_id || "").trim();
      if (dsid) dcrByDeputyShift[dsid] = d;
      const triple = normSlug(d.tech_slug) + "|" + normSlug(d.customer_slug) + "|" + (d.clean_date || "");
      dcrByTripleKey[triple] = d;
      const emailKey = normEmail(d.submitted_by_email || d.tech_email) + "|" + normSlug(d.customer_slug) + "|" + (d.clean_date || "");
      dcrByEmailKey[emailKey] = d;
    });
    const matchedDcrIds = Object.create(null);

    function matchDcrForShift(shift, session) {
      const sid = String(shift.shift_id || shift.id);
      // 1. pioneer_session_id (set when DCR opened from Start Work)
      if (dcrByPioneerSession[sid]) {
        matchedDcrIds[dcrByPioneerSession[sid].submission_id] = true;
        return { dcr: dcrByPioneerSession[sid], match_path: "pioneer_session_id" };
      }
      // 2. deputy_shift_id (same value but stamped via the session writeback)
      if (dcrByDeputyShift[sid]) {
        matchedDcrIds[dcrByDeputyShift[sid].submission_id] = true;
        return { dcr: dcrByDeputyShift[sid], match_path: "deputy_shift_id" };
      }
      // 3. tech_slug + customer_slug + clean_date
      const techSlug   = normSlug(shift.employee_slug || (session && session.tech_slug));
      const custSlug   = normSlug(shift.customer_slug || (session && session.selected_customer_slug));
      const cleanDate  = shift.sync_date || (session && session.sync_date) || "";
      if (techSlug && custSlug && cleanDate) {
        const k = techSlug + "|" + custSlug + "|" + cleanDate;
        if (dcrByTripleKey[k]) {
          matchedDcrIds[dcrByTripleKey[k].submission_id] = true;
          return { dcr: dcrByTripleKey[k], match_path: "tech_slug+customer_slug+clean_date" };
        }
      }
      // 4. tech_email + customer_slug + clean_date (final fallback)
      const techEmail = normEmail(shift.employee_email || (session && session.tech_email));
      if (techEmail && custSlug && cleanDate) {
        const k = techEmail + "|" + custSlug + "|" + cleanDate;
        if (dcrByEmailKey[k]) {
          matchedDcrIds[dcrByEmailKey[k].submission_id] = true;
          return { dcr: dcrByEmailKey[k], match_path: "tech_email+customer_slug+clean_date" };
        }
      }
      return { dcr: null, match_path: null };
    }

    // Per-shift row.
    const rows = ctx.shifts.map(function (shift) {
      const sid = String(shift.shift_id || shift.id);
      const session = sessionByShiftId[sid] || null;
      const matched = matchDcrForShift(shift, session);
      const dcr = matched.dcr;

      const sessStatus = session ? String(session.status || "").toLowerCase() : "";
      const started   = !!session && sessStatus !== "not_started";
      const finished  = sessStatus === "finished" || sessStatus === "needs_finish" || !!dcr;

      // Email status (native). Ignore zapier.status — legacy.
      const emailStatus = dcr ? String(dcr.emailStatus || "").toLowerCase() : "";
      const emailError  = dcr ? (dcr.emailError || "") : "";
      const issueTier   = dcr
        ? String((dcr.issueRouting && dcr.issueRouting.tier) || dcr.issueTier || "").toLowerCase()
        : "";
      const hasProblem = !!(dcr && dcr.form_data && dcr.form_data.has_problem === true);
      const issueDocs  = dcr ? (issuesByDcrId[dcr.submission_id] || []) : [];

      // Traffic light.
      let status = "RED";
      let statusReason = "Scheduled but no DCR submitted";
      if (dcr) {
        if (issueTier === "red") {
          status = "RED"; statusReason = "DCR flagged red tier";
        } else if (issueTier === "yellow" || hasProblem) {
          status = "YELLOW"; statusReason = hasProblem
            ? "DCR notes a problem on this visit"
            : "DCR flagged yellow tier";
        } else if (emailStatus === "failed") {
          status = "YELLOW"; statusReason = "Customer email delivery failed";
        } else {
          status = "GREEN"; statusReason = "Submitted cleanly";
        }
      } else if (started && !dcr) {
        status = "RED"; statusReason = "Started but no DCR submitted";
      }

      const techSlug = normSlug(shift.employee_slug || (session && session.tech_slug));
      const techRecord = techBySlug[techSlug] ||
        techByEmail[normEmail(shift.employee_email)] ||
        null;
      const techDisplay = (techRecord && techRecord.display_name) ||
        shift.employee_display_name ||
        shift.employee_email || "(unknown tech)";

      const custSlug = normSlug(shift.customer_slug || (session && session.selected_customer_slug));
      const customer = customerBySlug[custSlug] || null;
      // Canonical helper — applies displayNameMode + customDisplayName
      // when the customer doc carries the new schema fields. Falls back
      // to the shift-level customer_name (Deputy sync output) when no
      // doc lookup is available.
      const customerName =
        (customer && window.PioneerCustomerDisplay
          && window.PioneerCustomerDisplay.getCustomerDisplayName(customer)) ||
        (customer && (customer.customer_name || customer.name)) ||
        shift.customer_name || "(no customer)";

      return {
        shift_id:        sid,
        tech_slug:       techSlug,
        tech_display:    techDisplay,
        tech_email:      normEmail(shift.employee_email || (techRecord && techRecord.email)),
        customer_slug:   custSlug,
        customer_name:   customerName,
        scheduled_start: tsToMs(shift.start_time),
        scheduled_end:   tsToMs(shift.end_time),
        sync_date:       shift.sync_date || "",
        session:         session,
        started:         started,
        finished:        finished,
        dcr:             dcr,
        match_path:      matched.match_path,
        email_status:    emailStatus || (dcr ? "(not run)" : ""),
        email_error:     emailError,
        issue_tier:      issueTier,
        has_problem:     hasProblem,
        issue_docs:      issueDocs,
        status:          status,
        status_reason:   statusReason
      };
    });

    // Aggregate per-tech.
    const byTechKey = Object.create(null);
    rows.forEach(function (r) {
      const k = r.tech_slug || r.tech_email || r.tech_display;
      if (!byTechKey[k]) {
        byTechKey[k] = {
          tech_slug:     r.tech_slug,
          tech_display:  r.tech_display,
          tech_email:    r.tech_email,
          rows:          [],
          counts: { scheduled: 0, started: 0, finished: 0, dcrs: 0, issues: 0,
                    emails_sent: 0, emails_failed: 0 }
        };
      }
      const bucket = byTechKey[k];
      bucket.rows.push(r);
      bucket.counts.scheduled++;
      if (r.started)  bucket.counts.started++;
      if (r.finished) bucket.counts.finished++;
      if (r.dcr)      bucket.counts.dcrs++;
      if (r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem) bucket.counts.issues++;
      if (r.email_status === "sent")   bucket.counts.emails_sent++;
      if (r.email_status === "failed") bucket.counts.emails_failed++;
    });
    const byTech = Object.keys(byTechKey).map(function (k) { return byTechKey[k]; });
    byTech.sort(function (a, b) {
      return String(a.tech_display || "").localeCompare(String(b.tech_display || ""));
    });

    // Unmatched DCRs (in window but didn't match any shift).
    const unmatchedDcrs = ctx.dcrs.filter(function (d) {
      return !matchedDcrIds[d.submission_id];
    });

    // Unmatched shifts (no DCR found).
    const unmatchedShifts = rows.filter(function (r) { return !r.dcr; });

    // Top-line counts.
    const summary = {
      window_start_date: ctx.selected,
      window_end_date:   nextDay(ctx.selected),
      scheduled:         rows.length,
      started:           rows.filter(function (r) { return r.started;  }).length,
      finished:          rows.filter(function (r) { return r.finished; }).length,
      dcrs_submitted:    ctx.dcrs.length,
      dcrs_missing:      unmatchedShifts.length,
      issues:            rows.filter(function (r) {
                           return r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem;
                         }).length,
      emails_sent:       rows.filter(function (r) { return r.email_status === "sent";   }).length,
      emails_failed:     rows.filter(function (r) { return r.email_status === "failed"; }).length
    };

    return {
      generated_at:      new Date().toISOString(),
      selected_date:     ctx.selected,
      summary:           summary,
      by_tech:           byTech,
      unmatched_dcrs:    unmatchedDcrs,
      unmatched_shifts: unmatchedShifts
    };
  }

  function renderYesterdaySummary(report) {
    const el = document.getElementById("yesterday-summary");
    if (!el) return;
    const s = report.summary;
    el.innerHTML =
      '<div class="ydw-stat"><span class="ydw-stat-label">Scheduled shifts</span><strong>'  + s.scheduled       + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Started</span><strong>'           + s.started         + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Finished</span><strong>'          + s.finished        + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">DCRs submitted</span><strong>'    + s.dcrs_submitted  + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-warn"><span class="ydw-stat-label">DCRs missing</span><strong>' + s.dcrs_missing + '</strong></div>' +
      '<div class="ydw-stat"><span class="ydw-stat-label">Issues</span><strong>'            + s.issues          + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-pass"><span class="ydw-stat-label">Emails sent</span><strong>' + s.emails_sent  + '</strong></div>' +
      '<div class="ydw-stat ydw-stat-fail"><span class="ydw-stat-label">Emails failed</span><strong>' + s.emails_failed + '</strong></div>';
    el.hidden = false;
  }

  function renderYesterdayByTech(report) {
    const el = document.getElementById("yesterday-by-tech");
    if (!el) return;
    if (report.by_tech.length === 0) {
      el.innerHTML = "";
      return;
    }
    const debug = isYesterdayDebug();
    el.innerHTML = report.by_tech.map(function (bucket) {
      const c = bucket.counts;
      const techHeader =
        '<header class="ydw-tech-head">' +
          '<strong class="ydw-tech-name">' + escapeHtml(bucket.tech_display || "(unknown)") + '</strong> ' +
          '<span class="ydw-tech-meta">' +
            escapeHtml(bucket.tech_slug || "") +
            (bucket.tech_email ? " · " + escapeHtml(bucket.tech_email) : "") +
          '</span>' +
          '<span class="ydw-tech-counts">' +
            c.scheduled + ' assigned · ' + c.started + ' started · ' + c.finished + ' finished · ' +
            c.dcrs + ' DCR' + (c.dcrs === 1 ? '' : 's') +
            (c.issues > 0 ? ' · <span class="ydw-tag warn">' + c.issues + ' issue' + (c.issues === 1 ? '' : 's') + '</span>' : '') +
            (c.emails_failed > 0 ? ' · <span class="ydw-tag fail">' + c.emails_failed + ' email failed</span>' : '') +
          '</span>' +
        '</header>';
      const rows = bucket.rows.map(function (r) { return renderYesterdayRow(r, debug); }).join("");
      return '<article class="ydw-tech">' + techHeader + '<ul class="ydw-row-list">' + rows + '</ul></article>';
    }).join("");
  }

  function renderYesterdayRow(r, debug) {
    const timeText = formatTimeRangePT(r.scheduled_start, r.scheduled_end) || "(no scheduled time)";
    const statusBadge = '<span class="ydw-status ydw-' + r.status + '">' + r.status + '</span>';
    const startedChip  = r.started  ? '<span class="ydw-chip">Started</span>'  : '';
    const finishedChip = r.finished ? '<span class="ydw-chip">Finished</span>' : '';
    const dcrChip = r.dcr
      ? '<span class="ydw-chip pass">DCR</span>'
      : '<span class="ydw-chip fail">No DCR</span>';
    const issueChip = (r.issue_tier === "yellow" || r.issue_tier === "red" || r.has_problem)
      ? '<span class="ydw-chip warn">Issue</span>'
      : '';
    let emailChip = '';
    if (r.dcr) {
      if (r.email_status === "sent")    emailChip = '<span class="ydw-chip pass">Email sent</span>';
      else if (r.email_status === "failed") emailChip = '<span class="ydw-chip fail" title="' + escapeHtml(r.email_error || "") + '">Email delivery failed</span>';
      else if (r.email_status === "skipped") emailChip = '<span class="ydw-chip">Email skipped (opt-out)</span>';
      else                              emailChip = '<span class="ydw-chip">Email not yet sent</span>';
    }
    const dcrLink = r.dcr
      ? '<a class="ydw-link" href="#" data-ydw-dcr="' + escapeHtml(r.dcr.submission_id) + '">View DCR</a>'
      : '';
    const reportLink = (r.dcr && r.dcr.report_url)
      ? ' · <a class="ydw-link" href="' + escapeHtml(r.dcr.report_url) + '" target="_blank" rel="noopener noreferrer">Customer report ↗</a>'
      : '';
    const viewCount = (r.dcr && Number(r.dcr.report_view_count) > 0)
      ? ('<span class="ydw-chip pass" title="Last viewed: ' +
          escapeHtml(formatReportViewedTime(r.dcr.last_report_viewed_at)) + '">' +
          'Customer viewed ' + Number(r.dcr.report_view_count) + 'x' +
        '</span>')
      : (r.dcr && r.dcr.report_url
          ? '<span class="ydw-chip" title="Customer has not opened the link yet">Customer report unread</span>'
          : '');
    const custLink = r.customer_slug
      ? '<a class="ydw-link" href="/admin?customer_slug=' + escapeHtml(r.customer_slug) + '#customer-' + escapeHtml(r.customer_slug) + '" target="_blank" rel="noopener">View customer</a>'
      : '';
    const reason  = '<span class="ydw-row-reason">' + escapeHtml(r.status_reason) + '</span>';
    const debugBlock = debug
      ? '<div class="ydw-debug">' +
          'shift_id=' + escapeHtml(r.shift_id) +
          (r.dcr ? ' · dcr=' + escapeHtml(r.dcr.submission_id) : '') +
          (r.match_path ? ' · matched_by=' + escapeHtml(r.match_path) : '') +
          (r.dcr && r.dcr.zapier && r.dcr.zapier.status
            ? ' · zapier=' + escapeHtml(String(r.dcr.zapier.status)) + ' (legacy)'
            : '') +
        '</div>'
      : '';
    return '<li class="ydw-row ydw-row-' + r.status + '">' +
             '<div class="ydw-row-head">' +
               statusBadge +
               '<strong class="ydw-row-customer">' + escapeHtml(r.customer_name) + '</strong>' +
               '<span class="ydw-row-time">' + escapeHtml(timeText) + '</span>' +
             '</div>' +
             '<div class="ydw-row-chips">' +
               startedChip + finishedChip + dcrChip + issueChip + emailChip + viewCount +
             '</div>' +
             reason +
             '<div class="ydw-row-actions">' + dcrLink + (dcrLink && custLink ? ' · ' : '') + custLink + reportLink + '</div>' +
             debugBlock +
           '</li>';
  }

  function renderYesterdayUnmatched(report) {
    const undcrEl     = document.getElementById("yesterday-unmatched-dcrs");
    const undcrListEl = document.getElementById("yesterday-unmatched-dcrs-list");
    const unshEl      = document.getElementById("yesterday-unmatched-shifts");
    const unshListEl  = document.getElementById("yesterday-unmatched-shifts-list");

    if (undcrEl && undcrListEl) {
      if (report.unmatched_dcrs.length === 0) {
        undcrEl.hidden = true;
      } else {
        undcrListEl.innerHTML = report.unmatched_dcrs.map(function (d) {
          return '<div class="ydw-unmatched-row">' +
                   '<strong>' + escapeHtml(d.customer_name || d.customer_slug || "(no customer)") + '</strong>' +
                   ' — ' + escapeHtml(d.tech_display_name || d.tech_slug || d.submitted_by_email || "") +
                   ' · ' + escapeHtml(d.clean_date || "") +
                   ' · ' + '<a class="ydw-link" href="#" data-ydw-dcr="' + escapeHtml(d.submission_id) + '">View DCR</a>' +
                 '</div>';
        }).join("");
        undcrEl.hidden = false;
      }
    }
    if (unshEl && unshListEl) {
      if (report.unmatched_shifts.length === 0) {
        unshEl.hidden = true;
      } else {
        unshListEl.innerHTML = report.unmatched_shifts.map(function (r) {
          return '<div class="ydw-unmatched-row">' +
                   '<strong>' + escapeHtml(r.customer_name) + '</strong>' +
                   ' — ' + escapeHtml(r.tech_display) +
                   ' · ' + escapeHtml(formatTimeRangePT(r.scheduled_start, r.scheduled_end) || r.sync_date) +
                   ' · <em>' + escapeHtml(r.status_reason) + '</em>' +
                 '</div>';
        }).join("");
        unshEl.hidden = false;
      }
    }
  }

  function formatReportViewedTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "(unknown)";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "(unknown)"; }
  }

  function isYesterdayDebug() {
    try {
      const u = new URLSearchParams(location.search || "");
      const v = u.get("debug_yesterday");
      return v === "1" || v === "true";
    } catch (_e) { return false; }
  }

  // "View DCR" anchor delegate — jumps to Recent DCRs tab and scrolls
  // the target row into view. Uses event delegation since each report
  // render replaces the DOM. Idempotent — re-binding the listener is
  // safe because once-only flag.
  let _ydwViewDcrWired = false;
  function wireYesterdayViewDcr() {
    if (_ydwViewDcrWired) return;
    _ydwViewDcrWired = true;
    document.addEventListener("click", function (ev) {
      const a = ev.target && ev.target.closest && ev.target.closest("[data-ydw-dcr]");
      if (!a) return;
      ev.preventDefault();
      const submissionId = a.getAttribute("data-ydw-dcr");
      if (!submissionId) return;
      activateTab("dcrs");
      // Defer the scroll-into-view a beat so the Recent DCRs panel has
      // a chance to render if it hadn't been opened yet.
      setTimeout(function () {
        const row = document.querySelector('#dcr-list [data-id="' + cssEsc(submissionId) + '"]');
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.add("admin-row-highlight");
          setTimeout(function () { row.classList.remove("admin-row-highlight"); }, 2000);
        }
      }, 250);
    });
  }
  // Wire on first init.
  (function () {
    const origInit = initYesterdayOnce;
    initYesterdayOnce = function () { wireYesterdayViewDcr(); origInit(); };
  })();

  /* --------------------------------------------------------------------
   * Pilot Readiness — admin-only pre-rollout audit panel.
   *
   * Calls `pilotReadinessCheckV1` (admin-gated HTTPS endpoint). Renders
   * the per-tech PASS/WARN/FAIL breakdown grouped by category. The Run
   * check button is the explicit trigger — we don't auto-run on tab
   * activate because the report touches Firebase Auth + Firestore for
   * every tech and we don't want a hot reload to thrash the API.
   * ------------------------------------------------------------------ */
  let pilotReadinessWired = false;
  let pilotReadinessLastReport = null;

  function initPilotReadinessOnce() {
    if (pilotReadinessWired) return;
    pilotReadinessWired = true;
    const runBtn     = document.getElementById("pilot-readiness-run");
    const refreshBtn = document.getElementById("pilot-readiness-refresh");
    const copyBtn    = document.getElementById("pilot-readiness-copy");
    if (runBtn)     runBtn.addEventListener("click", function () { runPilotReadiness(); });
    if (refreshBtn) refreshBtn.addEventListener("click", function () { runPilotReadiness(); });
    if (copyBtn)    copyBtn.addEventListener("click", function () { copyPilotReadinessReport(); });
  }

  async function runPilotReadiness() {
    const url = window.PILOT_READINESS_CHECK_URL;
    const loadingEl = document.getElementById("pilot-readiness-loading");
    const errEl     = document.getElementById("pilot-readiness-error");
    const summaryEl = document.getElementById("pilot-readiness-summary");
    const resultsEl = document.getElementById("pilot-readiness-results");
    const emptyEl   = document.getElementById("pilot-readiness-empty");
    const runBtn    = document.getElementById("pilot-readiness-run");
    const refreshBtn = document.getElementById("pilot-readiness-refresh");
    const copyBtn   = document.getElementById("pilot-readiness-copy");

    if (!url) {
      if (errEl) { errEl.textContent = "PILOT_READINESS_CHECK_URL not configured in firebase-config.js."; errEl.hidden = false; }
      return;
    }
    if (loadingEl) loadingEl.hidden = false;
    if (errEl)     errEl.hidden = true;
    if (summaryEl) summaryEl.hidden = true;
    if (resultsEl) resultsEl.hidden = true;
    if (emptyEl)   emptyEl.hidden = true;
    if (runBtn)    runBtn.disabled = true;

    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      if (errEl) { errEl.textContent = "You appear to be signed out. Refresh and sign in again."; errEl.hidden = false; }
      if (loadingEl) loadingEl.hidden = true;
      if (runBtn)    runBtn.disabled = false;
      return;
    }

    try {
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": "Bearer " + idToken }
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        const msg = (body && body.error) || ("Server returned " + res.status);
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      pilotReadinessLastReport = body.report;
      renderPilotReadinessReport(body.report);
      if (refreshBtn) refreshBtn.hidden = false;
      if (copyBtn)    copyBtn.hidden    = false;
      if (runBtn)     runBtn.hidden     = true;
    } catch (err) {
      console.error("pilotReadinessCheckV1 fetch failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't reach the readiness service. " + (err && err.message ? err.message : "Check your connection and try again.");
        errEl.hidden = false;
      }
    } finally {
      if (loadingEl) loadingEl.hidden = true;
      if (runBtn)    runBtn.disabled = false;
    }
  }

  function renderPilotReadinessReport(report) {
    const summaryEl = document.getElementById("pilot-readiness-summary");
    const resultsEl = document.getElementById("pilot-readiness-results");
    const emptyEl   = document.getElementById("pilot-readiness-empty");
    if (!report || !Array.isArray(report.techs)) return;
    if (report.techs.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    const s = report.summary || { tech_count: report.techs.length, pass: 0, warn: 0, fail: 0 };

    if (summaryEl) {
      summaryEl.innerHTML =
        '<div class="pr-summary-row">' +
          '<span class="pr-summary-stat pr-stat-total">' +
            '<strong>' + s.tech_count + '</strong> tech' + (s.tech_count === 1 ? "" : "s") + ' checked' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-pass">' +
            '<strong>' + s.pass + '</strong> PASS' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-warn">' +
            '<strong>' + s.warn + '</strong> WARN' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-fail">' +
            '<strong>' + s.fail + '</strong> FAIL' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-time">' +
            'Generated ' + escapeHtml(report.generated_at || "") +
          '</span>' +
        '</div>';
      summaryEl.hidden = false;
    }

    if (resultsEl) {
      resultsEl.innerHTML = report.techs.map(function (t) {
        const grouped = Object.create(null);
        (t.checks || []).forEach(function (c) {
          if (!grouped[c.category]) grouped[c.category] = [];
          grouped[c.category].push(c);
        });
        const groupHtml = Object.keys(grouped).map(function (cat) {
          const rows = grouped[cat].map(function (c) {
            return '<li class="pr-check pr-' + escapeHtml(c.level) + '">' +
                     '<span class="pr-check-badge">' + escapeHtml(c.level) + '</span> ' +
                     '<span class="pr-check-label">' + escapeHtml(c.label) + '</span>' +
                     (c.detail
                       ? '<div class="pr-check-detail">' + escapeHtml(c.detail) + '</div>'
                       : '') +
                   '</li>';
          }).join("");
          return '<div class="pr-category">' +
                   '<h4 class="pr-category-head">' + escapeHtml(cat) + '</h4>' +
                   '<ul class="pr-check-list">' + rows + '</ul>' +
                 '</div>';
        }).join("");
        return '<article class="pr-tech pr-tech-' + escapeHtml(t.overall) + '">' +
                 '<header class="pr-tech-head">' +
                   '<span class="pr-tech-badge">' + escapeHtml(t.overall) + '</span> ' +
                   '<strong class="pr-tech-name">' + escapeHtml(t.display_name || t.tech_slug) + '</strong> ' +
                   '<span class="pr-tech-meta">' + escapeHtml(t.tech_slug || "") +
                     (t.email ? ' · ' + escapeHtml(t.email) : '') +
                   '</span>' +
                 '</header>' +
                 groupHtml +
               '</article>';
      }).join("");
      resultsEl.hidden = false;
    }
  }

  function copyPilotReadinessReport() {
    if (!pilotReadinessLastReport) return;
    const r = pilotReadinessLastReport;
    const lines = [];
    lines.push("Pioneer DCR Hub — Pilot Readiness");
    lines.push("Generated " + (r.generated_at || ""));
    lines.push("Techs: " + r.summary.tech_count + " · PASS " + r.summary.pass +
               " · WARN " + r.summary.warn + " · FAIL " + r.summary.fail);
    lines.push("");
    (r.techs || []).forEach(function (t) {
      lines.push("[" + t.overall + "] " + (t.display_name || t.tech_slug) +
                 "  ·  " + t.tech_slug + (t.email ? " · " + t.email : ""));
      const grouped = Object.create(null);
      (t.checks || []).forEach(function (c) {
        if (!grouped[c.category]) grouped[c.category] = [];
        grouped[c.category].push(c);
      });
      Object.keys(grouped).forEach(function (cat) {
        lines.push("  [" + cat + "]");
        grouped[cat].forEach(function (c) {
          lines.push("    " + c.level + "  " + c.label);
          if (c.detail) lines.push("        " + c.detail);
        });
      });
      lines.push("");
    });
    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        const btn = document.getElementById("pilot-readiness-copy");
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(function () { btn.textContent = orig; }, 1500);
        }
      }).catch(function (e) {
        console.warn("clipboard write failed", e);
        window.prompt("Copy the report below:", text);
      });
    } else {
      window.prompt("Copy the report below:", text);
    }
  }

  // Idempotent mount: subsequent clicks on the Feed tab do nothing.
  let opFeedMounted = false;
  function mountOperationalFeedOnce() {
    if (opFeedMounted) return;
    if (!window.OpFeed || typeof window.OpFeed.mount !== "function") {
      console.warn("[admin] OpFeed module not loaded — operational-feed.js missing?");
      return;
    }
    const u = firebase.auth().currentUser;
    if (!u) return;
    window.OpFeed.mount({
      containerId: "op-feed-list",
      mode:        "admin",
      user: {
        uid:     u.uid,
        email:   u.email || "",
        name:    u.displayName || u.email || "admin",
        isAdmin: true
      },
      filterStatus: ($("op-feed-list-filter") && $("op-feed-list-filter").value) || "open"
    });
    opFeedMounted = true;
    wireOperationalFeedDemoButtons();
  }

  // Demo buttons — admin-only test docs that include the admin's own
  // uid in audience_user_ids so the admin can exercise the ack +
  // status flow end-to-end. Server-side wiring (supply request →
  // feed item) is the production path.
  function wireOperationalFeedDemoButtons() {
    const disclosure = $("op-feed-demo-disclosure");
    if (!disclosure || disclosure.dataset.wired) return;
    disclosure.dataset.wired = "1";
    const status = $("op-feed-demo-status");
    function setStatus(msg) { if (status) status.textContent = msg; }

    disclosure.addEventListener("click", async function (ev) {
      const btn = ev.target.closest("button[data-feed-demo]");
      if (!btn) return;
      const u = firebase.auth().currentUser;
      if (!u) { setStatus("Sign in first."); return; }
      const kind = btn.dataset.feedDemo;
      const adminName = u.displayName || u.email || "admin";
      let payload = null;
      if (kind === "recognition") {
        payload = {
          type:              "recognition",
          title:              "Demo: Nice work on the Tuesday close",
          body:               "Great attention to detail in the lobby — wanted to call it out.",
          severity:           "info",
          status:             "new",
          requires_ack:       false,
          audience_roles:     ["admin", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else if (kind === "scheduler_notice") {
        payload = {
          type:              "scheduler_notice",
          title:              "Demo: Schedule swap for tomorrow",
          body:               "Heads up — Drew is covering Maks's Tuesday morning shift.",
          severity:           "important",
          status:             "new",
          requires_ack:       false,
          audience_roles:     ["admin", "scheduler", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else if (kind === "safety_alert") {
        payload = {
          type:              "safety_alert",
          title:              "Demo: Slip hazard at NOTL east wing",
          body:               "Recent floor sealant means slow drying — wear non-slip and post the cone before entry.",
          severity:           "urgent",
          status:             "new",
          requires_ack:       true,
          audience_roles:     ["admin", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else {
        return;
      }
      btn.disabled = true;
      setStatus("Creating…");
      const id = await window.OpFeed.adminCreate(payload);
      btn.disabled = false;
      setStatus(id ? "Created. Look for it in the feed below." : "Failed — see console for details.");
    });
  }

  /* ---------- search filters ---------- */

  function wireSearch() {
    const cs = $("customer-search");
    const ts = $("tech-search");
    const ds = $("dcr-search");

    // Delegated to applyCurrentCustomerFilter / applyCurrentTechFilter so that
    // both the search-input handler AND the post-save row refresh use the same
    // filter logic (avoids "save → re-render → search query forgotten").
    if (cs) cs.addEventListener("input", applyCurrentCustomerFilter);
    if (ts) ts.addEventListener("input", applyCurrentTechFilter);

    if (ds) ds.addEventListener("input", function () {
      const q = ds.value.trim().toLowerCase();
      if (!q) return renderDcrs(dcrs);
      const filtered = dcrs.filter(function (d) {
        return (
          (d.customer_name      || "").toLowerCase().includes(q) ||
          (d.tech_display_name  || "").toLowerCase().includes(q) ||
          (d.submission_id      || "").toLowerCase().includes(q) ||
          (d.id                 || "").toLowerCase().includes(q)
        );
      });
      renderDcrs(filtered);
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
      loadDcrs().finally(function () {
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
      loadCustomers();
      loadTechs();
      loadDcrs();
      loadSupplyRequests();
      loadDcrIssues();
      loadAnnouncements();
      loadAdmins();
      loadCustomerNotes();
      loadNoteSuggestions();
      loadServiceRecoveries();
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
  function showToast(kind, msg) {
    const root = $("toast-container");
    if (!root) return;
    const t = document.createElement("div");
    t.className = "toast toast-" + kind;
    t.textContent = msg;
    root.appendChild(t);
    // Next-frame class flip so the CSS transition fires.
    requestAnimationFrame(function () { t.classList.add("is-shown"); });
    setTimeout(function () {
      t.classList.remove("is-shown");
      setTimeout(function () { t.remove(); }, 320);
    }, 3500);
  }

  // ---- Modal open/close helpers ----
  function openModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Focus the first text-like input for keyboard ergonomics.
    const firstInput = el.querySelector('input[type="text"], input[type="email"], input[type="url"], input[type="tel"], textarea');
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 60);
  }
  function closeModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    const errEl = el.querySelector(".admin-modal-err");
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
  }

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
    if (a.starts_at)   meta.push("Starts " + dcrTsToFmt(a.starts_at));
    if (a.expires_at)  meta.push("Expires " + dcrTsToFmt(a.expires_at));
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
      try { applyCurrentTechFilter(); } catch (e) { /* tech panel may not be rendered yet */ }
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
    try { applyCurrentTechFilter(); } catch (e) { /* non-fatal */ }
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

  function openCustomerEditModal(c) {
    // Switch the modal to edit mode — hides the slug row via the
    // [data-mode="edit"] CSS rule and resets the title/save labels.
    const modal = $("customer-edit-modal");
    if (modal) modal.dataset.mode = "edit";
    const title = $("customer-modal-title");
    if (title) title.textContent = "Edit customer";
    const save  = $("customer-edit-save");
    if (save) save.textContent = "Save";

    $("cust-edit-id").value                  = c.id;
    $("cust-edit-name").value                = getCustomerName(c);
    $("cust-edit-location").value            = getCustomerLocation(c);
    $("cust-edit-email").value               = getCustomerEmail(c);
    $("cust-edit-active").checked            = getActive(c);
    $("cust-edit-dcr-enabled").checked       = getDcrEnabled(c);
    $("cust-edit-dcr-email-enabled").checked = getDcrEmailEnabled(c);
    $("cust-edit-slack").value               = c.slack_channel || "";
    const rl = (c.review_links && typeof c.review_links === "object") ? c.review_links : {};
    $("cust-edit-five-star").value           = rl.five_star_url || "";
    $("cust-edit-issue-url").value           = rl.issue_url     || "";
    $("cust-edit-notes").value               = c.notes || "";
    // Populate the read-only Deputy Integration block.
    populateCustomerDeputyIntegration(c);
    // Populate the read-only SOP block (admin mode — shows raw notes).
    populateCustomerSopBlock(c);
    // Blank the create-only slug input to defend against stale carry-over.
    const slugEl = $("cust-create-slug");
    if (slugEl) { slugEl.value = ""; delete slugEl.dataset.touched; }
    setModalError("customer-edit-modal", "");
    openModal("customer-edit-modal");
  }

  // Read-only Deputy debugging panel on the customer edit modal.
  // Sources: c.deputy_company_id (stored), c.deputy_company_name
  // (stored), most recent shift in deputyMappingShifts whose
  // customer_slug equals this customer.
  // Render the SOP blocks inside the customer edit modal. Two
  // independent renders:
  //   • PUBLIC block — reads the flat sop* fields off the customer doc.
  //   • ADMIN-ONLY SECURE block — fetches customer_secure/{slug} live
  //     (firestore.rules denies non-admin reads). Empty state when no
  //     secure doc exists.
  async function populateCustomerSopBlock(c) {
    const publicBody = $("cust-edit-sop-body");
    const secureBody = $("cust-edit-secure-body");
    if (!c || !window.CustomerSop) {
      if (publicBody) publicBody.innerHTML = '<div class="sop-empty">customer-sop.js not loaded.</div>';
      if (secureBody) secureBody.innerHTML = '<div class="sop-empty">customer-sop.js not loaded.</div>';
      return;
    }
    // Public block — sync render from the customer doc fields.
    if (publicBody && typeof window.CustomerSop.renderPublic === "function") {
      window.CustomerSop.renderPublic(publicBody, c);
    }
    // Secure block — fetch the sibling customer_secure doc. The read
    // is gated by firestore.rules; this admin client has access. If
    // hasSecureSop is false we still attempt the read so we can
    // detect a stale "true" flag (cheap — single doc get).
    if (!secureBody) return;
    secureBody.innerHTML = '<div class="sop-empty">Loading secure ops…</div>';
    try {
      const slug = getCustomerSlug(c);
      const snap = await db.collection("customer_secure").doc(slug).get();
      if (snap.exists) {
        window.CustomerSop.renderSecure(secureBody, snap.data() || {});
      } else {
        secureBody.innerHTML =
          '<div class="sop-empty">No secure ops doc on file for this customer. ' +
          (c.hasSecureSop
            ? 'Customer doc has <code>hasSecureSop: true</code> but the secure doc is missing — re-run the seed parser to repair.'
            : 'No codes / contacts / raw Deputy notes detected during import.') +
          '</div>';
      }
    } catch (err) {
      console.warn("[admin] customer_secure read failed", err && err.code);
      secureBody.innerHTML =
        '<div class="sop-empty">Couldn\'t load secure ops: ' +
        escapeHtml(err && err.message || "unknown") +
        '. Confirm you\'re signed in as an admin and firestore.rules has the /customer_secure block deployed.</div>';
    }
  }

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

  /* ---- Customer: CREATE (Add customer) ----
   *
   * Writes a new customer doc keyed by the user-edited slug. The slug
   * input is auto-derived from the customer/location name (the admin
   * can override). On save:
   *   1. Validate required fields + slug shape.
   *   2. Check Firestore for an existing doc at customers/{slug}; reject
   *      if it exists to prevent silent overwrites.
   *   3. Use `.set()` (not `.update()`) so the create stamps fire and
   *      the doc is materialised even if no prior placeholder existed.
   *
   * Permission: gated by firestore.rules → isPioneerAdmin(). No new
   * rules required — the customers/{id} rule already allows create for
   * the admin allowlist.
   */
  function openCustomerCreateModal() {
    const modal = $("customer-edit-modal");
    if (modal) modal.dataset.mode = "create";
    const title = $("customer-modal-title");
    if (title) title.textContent = "Add customer";
    const save  = $("customer-edit-save");
    if (save) save.textContent = "Add customer";

    $("cust-edit-id").value                  = "";
    $("cust-edit-name").value                = "";
    $("cust-edit-location").value            = "";
    $("cust-edit-email").value               = "";
    $("cust-edit-active").checked            = true;       // sensible defaults
    $("cust-edit-dcr-enabled").checked       = true;
    $("cust-edit-dcr-email-enabled").checked = true;
    $("cust-edit-slack").value               = "";
    $("cust-edit-five-star").value           = "";
    $("cust-edit-issue-url").value           = "";
    $("cust-edit-notes").value               = "";

    const slugEl = $("cust-create-slug");
    if (slugEl) { slugEl.value = ""; delete slugEl.dataset.touched; }

    setModalError("customer-edit-modal", "");
    openModal("customer-edit-modal");
  }

  async function onCustomerCreateSave() {
    const name     = $("cust-edit-name").value.trim();
    const location = $("cust-edit-location").value.trim();
    const slugIn   = $("cust-create-slug").value.trim().toLowerCase();
    const slug     = slugIn || slugifyForTech(location || name);

    if (!name) {
      setModalError("customer-edit-modal", "Customer name is required.");
      return;
    }
    if (!location) {
      setModalError("customer-edit-modal", "Location name is required.");
      return;
    }
    if (!slug) {
      setModalError("customer-edit-modal", "Customer slug is required (couldn't derive one from the name).");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setModalError("customer-edit-modal", "Slug must be lowercase letters, digits, and dashes only.");
      return;
    }

    setModalSaving("customer-edit-modal", true);
    setModalError("customer-edit-modal", "");

    // Duplicate-slug guard. The doc ID IS the slug, so a get() suffices
    // — no compound index needed. We could race against a concurrent
    // create from another admin tab, but the second .set() would still
    // overwrite the first. Acceptable for two-admin-max usage; revisit
    // if we ever expose this to >5 concurrent writers.
    try {
      const existing = await db.collection("customers").doc(slug).get();
      if (existing.exists) {
        setModalError("customer-edit-modal",
          "A customer with slug '" + slug + "' already exists. Pick a different slug.");
        setModalSaving("customer-edit-modal", false);
        return;
      }
    } catch (err) {
      handleAdminWriteError(err, { context: "customer slug-uniqueness check", modalId: "customer-edit-modal" });
      setModalSaving("customer-edit-modal", false);
      return;
    }

    const adminEmail = getCurrentAdminEmail();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();
    const doc = {
      // Slug stored on the doc too (in addition to being the doc ID) so
      // existing helpers that prefer doc.customer_slug keep working.
      customer_slug:     slug,
      customer_name:     name,
      location_name:     location,
      customer_email:    $("cust-edit-email").value.trim(),
      active:            $("cust-edit-active").checked,
      dcr_enabled:       $("cust-edit-dcr-enabled").checked,
      dcr_email_enabled: $("cust-edit-dcr-email-enabled").checked,
      slack_channel:     $("cust-edit-slack").value.trim(),
      review_links: {
        five_star_url:   $("cust-edit-five-star").value.trim(),
        issue_url:       $("cust-edit-issue-url").value.trim()
      },
      notes:             $("cust-edit-notes").value.trim(),
      created_at:        sts,
      created_by:        adminEmail,
      updated_at:        sts,
      updated_by:        adminEmail
    };

    try {
      await db.collection("customers").doc(slug).set(doc);
      // Patch local cache + re-render. We push a hydrated copy with
      // client-side timestamps (display only) — the next loadCustomers
      // refresh will replace with the server values.
      const local = Object.assign({ id: slug }, doc, {
        created_at: new Date(),
        updated_at: new Date()
      });
      customers.push(local);
      customers.sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
      applyCurrentCustomerFilter();
      closeModal("customer-edit-modal");
      showToast("ok", "Customer added.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer create", modalId: "customer-edit-modal" });
    } finally {
      setModalSaving("customer-edit-modal", false);
    }
  }

  async function onCustomerEditSave() {
    const id = $("cust-edit-id").value;
    if (!id) return;
    const idx = customers.findIndex(function (x) { return x.id === id; });
    if (idx < 0) {
      setModalError("customer-edit-modal", "Couldn't find this customer in the local cache. Refresh the page and try again.");
      return;
    }

    const name = $("cust-edit-name").value.trim();
    if (!name) {
      setModalError("customer-edit-modal", "Customer name is required.");
      return;
    }

    const updates = {
      customer_name:     name,
      location_name:     $("cust-edit-location").value.trim(),
      customer_email:    $("cust-edit-email").value.trim(),
      active:            $("cust-edit-active").checked,
      dcr_enabled:       $("cust-edit-dcr-enabled").checked,
      dcr_email_enabled: $("cust-edit-dcr-email-enabled").checked,
      slack_channel:     $("cust-edit-slack").value.trim(),
      review_links: {
        five_star_url:   $("cust-edit-five-star").value.trim(),
        issue_url:       $("cust-edit-issue-url").value.trim()
      },
      notes:             $("cust-edit-notes").value.trim(),
      updated_at:        firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:        getCurrentAdminEmail()
    };

    setModalSaving("customer-edit-modal", true);
    setModalError("customer-edit-modal", "");
    try {
      await db.collection("customers").doc(id).update(updates);
      // Patch the local cache so the row reflects the new state immediately.
      customers[idx] = Object.assign({}, customers[idx], updates, {
        updated_at:   new Date(),
        review_links: updates.review_links  // overwrite (don't shallow-merge)
      });
      applyCurrentCustomerFilter();
      closeModal("customer-edit-modal");
      showToast("ok", "Customer updated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer save", modalId: "customer-edit-modal" });
    } finally {
      setModalSaving("customer-edit-modal", false);
    }
  }

  // ---- Customer: archive / reactivate ----

  async function onCustomerArchive(c) {
    const name        = getCustomerName(c) || c.id;
    const isArchiving = getActive(c);   // currently active → archiving
    const verb        = isArchiving ? "Archive" : "Reactivate";
    const summary     = isArchiving
      ? "They'll be hidden from the DCR form. No data is deleted — you can reactivate later."
      : "They'll reappear in the DCR form (assuming dcr_enabled stays on).";
    if (!window.confirm(verb + " " + name + "?\n\n" + summary)) return;

    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };

    try {
      await db.collection("customers").doc(c.id).update(updates);
      const idx = customers.findIndex(function (x) { return x.id === c.id; });
      if (idx >= 0) {
        customers[idx] = Object.assign({}, customers[idx], updates, {
          updated_at:  new Date(),
          archived_at: isArchiving ? new Date() : null
        });
      }
      applyCurrentCustomerFilter();
      showToast("ok", isArchiving ? "Customer archived." : "Customer reactivated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer archive" });
    }
  }

  // ---- Cleaning tech: edit ----

  // Renders a customer checklist into the given list/search/count elements.
  // Reads selection state from the supplied `staging` Set; toggling a row
  // updates the set, and a later re-render (e.g. on search input) preserves
  // selections. Defensive null-checks so a missing element is a no-op
  // rather than a throw that would block the modal from opening.
  //
  // Shared by the tech-EDIT modal (state = pendingTechAssigned) and the
  // tech-CREATE modal (state = pendingTechCreateAssigned).
  function renderAssignmentChecklist(opts) {
    const listEl   = opts && opts.listEl;
    const searchEl = opts && opts.searchEl;
    const countEl  = opts && opts.countEl;
    const staging  = opts && opts.staging;
    if (!listEl || !staging) return;

    const q = (searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : "");
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

  function openTechEditModal(t) {
    $("tech-edit-id").value             = t.id;
    $("tech-edit-display-name").value   = getTechName(t);
    $("tech-edit-email").value          = t.email || "";
    $("tech-edit-phone").value          = t.phone || "";
    $("tech-edit-active").checked       = getActive(t);
    $("tech-edit-dcr-enabled").checked  = getDcrEnabled(t);
    $("tech-edit-notes").value          = t.notes || "";
    setModalError("tech-edit-modal", "");

    // Seed the staging set from the doc. Lowercase + trim defends against
    // stray casing from older writes. The Set dedupes naturally.
    pendingTechAssigned = new Set();
    const existing = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
    for (let i = 0; i < existing.length; i++) {
      const s = String(existing[i] || "").toLowerCase().trim();
      if (s) pendingTechAssigned.add(s);
    }

    // Wrapped so a thrown error inside the assignment renderer never
    // prevents the modal from opening. A missing customers cache, a stale
    // DOM, or a partial deploy should degrade to "modal opens, list shows
    // an error in console" instead of "Edit button does nothing".
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

    // Sorted + deduped slug list. Sorting keeps Firestore diffs stable
    // across saves (saves bandwidth on the listener path and keeps the
    // doc readable in the console).
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
      await db.collection("cleaning_techs").doc(id).update(updates);
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

  // ---- Cleaning tech: CREATE / login setup ----

  function renderTechCreateAssignments() {
    renderAssignmentChecklist({
      listEl:   $("tech-create-assignments-list"),
      searchEl: $("tech-create-assignments-search"),
      countEl:  $("tech-create-assignments-count"),
      staging:  pendingTechCreateAssigned
    });
  }

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

  function resetTechCreateModal() {
    $("tech-create-display-name").value = "";
    $("tech-create-email").value        = "";
    $("tech-create-phone").value        = "";
    $("tech-create-slug").value         = "";
    const search = $("tech-create-assignments-search");
    if (search) search.value = "";
    pendingTechCreateAssigned = new Set();

    // Reset radio choice to the recommended default. For pilot we lead
    // with the temporary-password flow — it doesn't depend on email
    // delivery and works on Safari without the reset-link handoff.
    const tempRadio = $("tech-create-mode-temp");
    if (tempRadio) tempRadio.checked = true;

    // Hide success pane, show form pane.
    $("tech-create-form-pane").hidden    = false;
    $("tech-create-success-pane").hidden = true;
    $("tech-create-reset-block").hidden  = true;
    $("tech-create-temp-block").hidden   = true;
    $("tech-create-reset-link").value    = "";
    $("tech-create-temp-password").value = "";

    // Save/cancel/done button states.
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
    if (!slug) slug = slugifyForTech(displayName);
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

    // ID token of the signed-in admin. The function verifies admin role
    // server-side; this is just the credential, not the authorization.
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (e) { /* swallowed; null token → 401 below */ }
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
        // Log the full server response to the browser console so the
        // developer can see the underlying auth/* code (e.g.
        // auth/insufficient-permission, auth/operation-not-allowed)
        // even when the friendly toast text is more concise.
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
              // If the server already embedded the code in the error text,
              // don't double-print it. Otherwise append the bracketed code
              // so support can pattern-match the failure quickly.
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
    //
    // Server has created/updated the Firebase Auth user AND the
    // cleaning_techs doc. If the admin chose "send reset email", we ALSO
    // trigger Firebase's hosted reset email from the client so the tech
    // gets a real email (the server returned a backup link too). The
    // client-triggered email is best-effort — a failure just means the
    // tech relies on the backup link.
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
      const docSnap = await db.collection("cleaning_techs").doc(result.tech_slug).get();
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
      // Reset wasn't requested AND no temp password was returned — that
      // happens when the email already had a Firebase Auth user
      // (idempotent reuse). Nothing to share; the existing password is
      // unchanged.
      $("tech-create-success-note").textContent =
        "This email already had a Firebase Auth login — we reused it and updated the cleaning_techs doc. " +
        "The tech's existing password is unchanged.";
    }

    showToast("ok", "Tech login ready.");
    setModalSaving("tech-create-modal", false);
  }

  // Copy-to-clipboard for the success pane. Falls back to selecting the
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
      loadDcrs().catch(function () { /* non-fatal */ });
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
    const idx = techs.findIndex(function (t) { return t.id === techId; });
    if (idx < 0) return null;
    techs[idx] = Object.assign({}, techs[idx], patch);
    // Repaint just this row in place to avoid losing other admin state.
    const row = document.querySelector('#tech-list [data-id="' + cssEsc(techId) + '"]');
    if (row && row.parentElement) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = techCard(techs[idx]).trim();
      const next = wrapper.firstElementChild;
      if (next) row.parentElement.replaceChild(next, row);
    }
    paintTechMediaModal(techs[idx]);
    if (typeof refreshAttentionStrip === "function") refreshAttentionStrip();
    return techs[idx];
  }
  function cssEsc(s) {
    return String(s == null ? "" : s).replace(/(["\\])/g, "\\$1");
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

  /* --------------------------------------------------------------------
   * Archive-confirm DOM modal.
   *
   * window.confirm() is auto-cancelled by Chrome automation tooling
   * (and accidentally easy to accept on iPad-style devices). This is
   * a real in-page dialog that returns a Promise<boolean>. Resolved
   * true on the destructive button, false on Cancel / backdrop / Esc.
   *
   * Injected once on first call; reused thereafter.
   * ------------------------------------------------------------------ */
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
    // Focus the Cancel button so a quick Enter doesn't accidentally
    // confirm a destructive action.
    const cancel = overlay.querySelector("[data-archive-cancel]");
    if (cancel) setTimeout(function () { try { cancel.focus(); } catch (_e) {} }, 30);
    return new Promise(function (resolve) {
      _archiveModalResolver = resolve;
    });
  }

  // ---- Cleaning tech: archive / reactivate ----

  async function onTechArchive(t) {
    const name        = getTechName(t) || t.id;
    const isArchiving = getActive(t);
    const email       = String(t.email || "").toLowerCase().trim();
    if (isArchiving) {
      // Real DOM modal — window.confirm is auto-dismissed by Chrome
      // automation tooling and felt too easy to accept accidentally.
      const confirmed = await openArchiveConfirmModal(name);
      if (!confirmed) return;
    } else {
      // Reactivate is calmer; a single Continue prompt is enough.
      if (!window.confirm(
        "Reactivate " + name + "?\n\n" +
        "They'll regain PioneerOps access (assuming dcr_enabled stays on)."
      )) return;
    }

    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };

    try {
      // 1. Flip the tech doc.
      await db.collection("cleaning_techs").doc(t.id).update(updates);

      // 2. Update the active-staff index (this is the rule's gate). On
      //    reactivate we re-write the doc; on archive we either flip
      //    active=false on the existing index doc OR delete it. We
      //    keep the doc for audit but set active=false so the rule
      //    helper denies on `active == true`.
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

      // 3. On archive, ask the Cloud Function to disable the auth user
      //    + revoke refresh tokens. Non-fatal — even if this fails,
      //    Firestore rules already deny field-tech writes.
      let authRevoked = false;
      if (isArchiving && email) {
        try {
          authRevoked = await callDisableAuthUserForTech(email);
        } catch (revokeErr) {
          console.warn("[archive] auth revoke failed (non-fatal — rules still deny)", revokeErr);
        }
      } else if (!isArchiving && email) {
        // Reactivate path — re-enable the auth user if it was disabled.
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

  // Calls the Cloud Function that disables the Firebase Auth user +
  // revokes refresh tokens. Returns true on success, false otherwise.
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

  /* ---------- HARD delete a cleaning tech ----------
     Calls deleteCleaningTechV1. The server is the source of truth on
     whether the delete is allowed — the client just renders whatever
     came back. Two known refusal cases:
       • HTTP 409 with body.blocked === true → operational history
         exists. We surface the server's `reasons[]` list verbatim so
         the admin knows what to clean up first (typically: archive
         instead).
       • Any other non-200 / body.ok === false → surface the server
         error code so support can pattern-match. */
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

    // 409 = blocked by history. Surface the reasons so the admin knows.
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
    // Remove the tech from the local cache + re-render. Also refresh
    // admins so the "promoted from this tech" admin doc (if any) shows
    // its cleaning_tech_slug cleared in the next paint.
    techs = techs.filter(function (x) { return x.id !== t.id; });
    applyCurrentTechFilter();
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

  // ---- Filter helpers extracted so saves can re-render with the active search ----

  function applyCurrentCustomerFilter() {
    const cs = $("customer-search");
    const q = cs ? cs.value.trim().toLowerCase() : "";
    if (!q) return renderCustomers(customers);
    const filtered = customers.filter(function (c) {
      return (
        getCustomerName(c).toLowerCase().includes(q) ||
        getCustomerSlug(c).toLowerCase().includes(q) ||
        getCustomerEmail(c).toLowerCase().includes(q) ||
        getCustomerLocation(c).toLowerCase().includes(q)
      );
    });
    renderCustomers(filtered);
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

  /* ====================================================================
     Customer Notes — CRUD + review cadence
     ====================================================================
     Persistent operational notes per customer. Office maintains; techs
     read through techHubViewV1 (server-gated by assigned_customer_slugs)
     and submit suggestions via the Note Suggestions tab below.

     Doc id is auto. Field set:
       customer_slug · title · body · category · active · review_due_at ·
       last_reviewed_at · last_reviewed_by · created_at · created_by ·
       updated_at · updated_by · archived_at · archived_by

     Review cadence: a note is "overdue" when last_reviewed_at (or
     updated_at if no review yet) is older than 60 days.
     ==================================================================== */

  const NOTE_CATEGORIES = [
    "Security", "Access", "Cleaning Preference",
    "Sensitive Area", "Equipment", "Customer Request", "Other"
  ];
  const NOTE_REVIEW_OVERDUE_MS = 60 * 24 * 60 * 60 * 1000;

  let customerNotes = [];

  function tsToMillis(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function")   return ts.toDate().getTime();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts === "string")            { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function isNoteReviewOverdue(n) {
    if (!n || n.active === false) return false;
    const reviewMs = tsToMillis(n.last_reviewed_at) || tsToMillis(n.updated_at) || tsToMillis(n.created_at);
    if (!reviewMs) return true;   // never stamped → treat as needing review
    return (Date.now() - reviewMs) > NOTE_REVIEW_OVERDUE_MS;
  }

  function customerLabelForSlug(slug) {
    const c = customers.find(function (x) {
      return String(getCustomerSlug(x) || "").toLowerCase() === String(slug || "").toLowerCase();
    });
    return c ? (getCustomerName(c) || getCustomerSlug(c)) : (slug || "(unknown)");
  }

  function applyCurrentNotesFilter() {
    const root  = $("notes-list");
    const cnt   = $("notes-count");
    if (!root) return;

    const cust  = ($("notes-filter-customer") && $("notes-filter-customer").value) || "all";
    const cat   = ($("notes-filter-category") && $("notes-filter-category").value) || "all";
    const stat  = ($("notes-filter-status")   && $("notes-filter-status").value)   || "active";
    const q     = String(($("notes-search") && $("notes-search").value) || "").trim().toLowerCase();

    const filtered = customerNotes.filter(function (n) {
      if (cust !== "all" && String(n.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      if (cat  !== "all" && (n.category || "Other") !== cat) return false;
      if (stat === "active"   && n.active === false) return false;
      if (stat === "archived" && n.active !== false) return false;
      if (stat === "overdue"  && !isNoteReviewOverdue(n)) return false;
      if (q) {
        const hay = ((n.title || "") + " " + (n.body || "") + " " + (n.customer_slug || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + customerNotes.length + " note" + (customerNotes.length === 1 ? "" : "s");

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("notes", "empty");
      return;
    }
    hideAllStatuses("notes");
    root.innerHTML = filtered.map(noteRowHtml).join("");
  }

  function noteRowHtml(n) {
    const overdue = isNoteReviewOverdue(n);
    const archived = n.active === false;
    const updatedMs = tsToMillis(n.updated_at) || tsToMillis(n.created_at);
    const reviewedMs = tsToMillis(n.last_reviewed_at);
    const updatedTxt  = updatedMs  ? new Date(updatedMs).toLocaleDateString() : "—";
    const reviewedTxt = reviewedMs ? new Date(reviewedMs).toLocaleDateString() : "(never)";

    const cls = "note-row" + (archived ? " is-archived" : "");
    const overdueChip = (overdue && !archived)
      ? '<span class="note-overdue">Review needed</span>'
      : "";

    return (
      '<div class="' + cls + '" role="listitem" data-id="' + escapeHtml(n.id) + '">' +
        '<div class="note-title-block">' +
          '<p class="note-title">' + escapeHtml(n.title || "(untitled)") +
            '<span class="note-cat-pill">' + escapeHtml(n.category || "Other") + '</span>' +
          '</p>' +
          '<span class="note-customer">' + escapeHtml(customerLabelForSlug(n.customer_slug)) + '</span>' +
        '</div>' +
        '<div class="note-meta">' +
          '<span class="note-meta-line">Updated ' + escapeHtml(updatedTxt) +
            (n.updated_by ? ' by ' + escapeHtml(n.updated_by) : '') +
          '</span>' +
          '<span class="note-meta-line">Last reviewed: ' + escapeHtml(reviewedTxt) + '</span>' +
          overdueChip +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="row-btn" type="button" data-action="edit-note">Edit</button>' +
          (archived
            ? '<button class="row-btn row-btn-reactivate" type="button" data-action="reactivate-note">Reactivate</button>'
            : '<button class="row-btn" type="button" data-action="archive-note">Archive</button>') +
        '</div>' +
      '</div>'
    );
  }

  function renderNotesReviewReminder() {
    const banner = $("notes-review-reminder");
    const badge  = $("notes-overdue-badge");
    if (!banner) return;
    const overdueCount = customerNotes.filter(isNoteReviewOverdue).length;
    if (overdueCount === 0) {
      banner.hidden = true;
      banner.textContent = "";
      if (badge) { badge.hidden = true; badge.textContent = "0"; }
      return;
    }
    banner.hidden = false;
    banner.textContent =
      "⏰ Review customer notes — " + overdueCount + " note" +
      (overdueCount === 1 ? "" : "s") +
      " haven't been reviewed in over 60 days. Filter by Status → Review overdue to see them.";
    if (badge) {
      badge.hidden = false;
      badge.textContent = overdueCount > 9 ? "9+" : String(overdueCount);
    }
  }

  function populateNoteCustomerSelects() {
    const inSelects = [
      $("note-edit-customer"),
      $("notes-filter-customer"),
      $("suggestions-filter-customer")
    ];
    const opts = customers
      .filter(function (c) { return getActive(c); })
      .sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
    inSelects.forEach(function (sel) {
      if (!sel) return;
      const isFilter = sel.id !== "note-edit-customer";
      const preserved = isFilter
        ? '<option value="all">All customers</option>'
        : '<option value="" disabled selected>— Pick a customer —</option>';
      sel.innerHTML = preserved + opts.map(function (c) {
        const slug = getCustomerSlug(c);
        return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(getCustomerName(c) + " (" + slug + ")") + '</option>';
      }).join("");
    });
  }

  async function loadCustomerNotes() {
    setStatus("notes", "loading");
    try {
      const snap = await db.collection("customer_notes").get();
      customerNotes = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customerNotes.sort(function (a, b) {
        return (tsToMillis(b.updated_at) || 0) - (tsToMillis(a.updated_at) || 0);
      });
      populateNoteCustomerSelects();
      renderNotesReviewReminder();
      applyCurrentNotesFilter();
    } catch (err) {
      console.error("loadCustomerNotes failed", err);
      setStatus("notes", "error",
        "Couldn't load customer notes: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the customer_notes block."
      );
    }
  }

  /* ---------- Note create/edit modal ---------- */

  function openNoteCreateModal(prefill) {
    const modal = $("note-edit-modal");
    if (!modal) return;
    modal.dataset.mode = "create";
    $("note-modal-title").textContent = "New customer note";

    populateNoteCustomerSelects();
    $("note-edit-id").value          = "";
    $("note-edit-customer").value    = (prefill && prefill.customer_slug) || "";
    $("note-edit-customer").disabled = false;
    $("note-edit-title").value       = (prefill && prefill.title) || "";
    $("note-edit-category").value    = (prefill && prefill.category) || "Other";
    $("note-edit-body").value        = (prefill && prefill.body) || "";
    $("note-edit-active").checked    = true;
    $("note-edit-review-due").value  = "";
    $("note-edit-meta-line").textContent = "";
    $("note-edit-mark-reviewed").hidden  = true;
    setModalError("note-edit-modal", "");
    setModalSaving("note-edit-modal", false);
    openModal("note-edit-modal");
  }

  function openNoteEditModal(note) {
    const modal = $("note-edit-modal");
    if (!modal) return;
    modal.dataset.mode = "edit";
    $("note-modal-title").textContent = "Edit customer note";

    populateNoteCustomerSelects();
    $("note-edit-id").value          = note.id;
    $("note-edit-customer").value    = note.customer_slug || "";
    $("note-edit-customer").disabled = true;   // locked in edit mode
    $("note-edit-title").value       = note.title || "";
    $("note-edit-category").value    = note.category || "Other";
    $("note-edit-body").value        = note.body || "";
    $("note-edit-active").checked    = note.active !== false;

    const dueMs = tsToMillis(note.review_due_at);
    $("note-edit-review-due").value = dueMs
      ? new Date(dueMs).toISOString().slice(0, 10)
      : "";

    const updMs  = tsToMillis(note.updated_at) || tsToMillis(note.created_at);
    const revMs  = tsToMillis(note.last_reviewed_at);
    const updTxt = updMs ? new Date(updMs).toLocaleString() : "—";
    const revTxt = revMs ? new Date(revMs).toLocaleString() : "(never)";
    $("note-edit-meta-line").textContent =
      "Created by " + (note.created_by || "—") +
      " · Updated " + updTxt + (note.updated_by ? " by " + note.updated_by : "") +
      " · Last reviewed " + revTxt + (note.last_reviewed_by ? " by " + note.last_reviewed_by : "");

    $("note-edit-mark-reviewed").hidden = false;
    setModalError("note-edit-modal", "");
    setModalSaving("note-edit-modal", false);
    openModal("note-edit-modal");
  }

  async function onNoteSave() {
    const modal = $("note-edit-modal");
    const mode  = modal && modal.dataset.mode || "create";
    const id    = $("note-edit-id").value.trim();
    const slug  = $("note-edit-customer").value.trim();
    const title = $("note-edit-title").value.trim();
    const body  = $("note-edit-body").value.trim();
    const cat   = $("note-edit-category").value.trim();
    const active = !!$("note-edit-active").checked;
    const reviewDueStr = $("note-edit-review-due").value.trim();

    if (!slug)  { setModalError("note-edit-modal", "Pick a customer first."); return; }
    if (!title) { setModalError("note-edit-modal", "Title is required."); return; }
    if (!body)  { setModalError("note-edit-modal", "Body is required."); return; }
    if (NOTE_CATEGORIES.indexOf(cat) < 0) {
      setModalError("note-edit-modal", "Pick a valid category."); return;
    }
    if (title.length > 120) { setModalError("note-edit-modal", "Title is too long (max 120)."); return; }
    if (body.length > 4000) { setModalError("note-edit-modal", "Body is too long (max 4000)."); return; }

    setModalSaving("note-edit-modal", true);
    setModalError("note-edit-modal", "");

    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const reviewDueAt = reviewDueStr
      ? firebase.firestore.Timestamp.fromDate(new Date(reviewDueStr + "T00:00:00Z"))
      : null;
    const adminEmail = getCurrentAdminEmail();

    try {
      if (mode === "create") {
        await db.collection("customer_notes").add({
          customer_slug:     slug,
          title:             title,
          body:              body,
          category:          cat,
          active:            active,
          review_due_at:     reviewDueAt,
          last_reviewed_at:  null,
          last_reviewed_by:  null,
          created_at:        sts,
          created_by:        adminEmail,
          updated_at:        sts,
          updated_by:        adminEmail
        });
        showToast("ok", "Note created.");
      } else {
        await db.collection("customer_notes").doc(id).update({
          title:         title,
          body:          body,
          category:      cat,
          active:        active,
          review_due_at: reviewDueAt,
          updated_at:    sts,
          updated_by:    adminEmail
        });
        showToast("ok", "Note saved.");
      }
      closeModal("note-edit-modal");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note save", modalId: "note-edit-modal" });
    } finally {
      setModalSaving("note-edit-modal", false);
    }
  }

  async function onNoteMarkReviewed() {
    const id = $("note-edit-id").value.trim();
    if (!id) return;
    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await db.collection("customer_notes").doc(id).update({
        last_reviewed_at: sts,
        last_reviewed_by: adminEmail,
        updated_at:       sts,
        updated_by:       adminEmail
      });
      showToast("ok", "Marked reviewed.");
      closeModal("note-edit-modal");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note mark-reviewed", modalId: "note-edit-modal" });
    }
  }

  async function onNoteArchiveToggle(note) {
    const isArchiving = note.active !== false;
    const verb = isArchiving ? "Archive" : "Reactivate";
    if (!window.confirm(verb + ' "' + (note.title || "this note") + '"?')) return;
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const adminEmail = getCurrentAdminEmail();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };
    try {
      await db.collection("customer_notes").doc(note.id).update(updates);
      showToast("ok", isArchiving ? "Note archived." : "Note reactivated.");
      await loadCustomerNotes();
    } catch (err) {
      handleAdminWriteError(err, { context: "note archive" });
    }
  }

  function wireNotesControls() {
    const list = $("notes-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const note = customerNotes.find(function (x) { return x.id === row.dataset.id; });
        if (!note) return;
        if (btn.dataset.action === "edit-note")        openNoteEditModal(note);
        if (btn.dataset.action === "archive-note")     onNoteArchiveToggle(note);
        if (btn.dataset.action === "reactivate-note")  onNoteArchiveToggle(note);
      });
    }
    const open = $("note-create-open");
    if (open) open.addEventListener("click", function () { openNoteCreateModal(); });
    const save = $("note-edit-save");
    if (save) save.addEventListener("click", onNoteSave);
    const review = $("note-edit-mark-reviewed");
    if (review) review.addEventListener("click", onNoteMarkReviewed);

    ["notes-filter-customer", "notes-filter-category", "notes-filter-status"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentNotesFilter);
    });
    const search = $("notes-search");
    if (search) search.addEventListener("input", applyCurrentNotesFilter);
  }

  /* ====================================================================
     Note Suggestions — admin review queue
     ====================================================================
     Reads /customer_note_suggestions. Admin can Approve, Reject, or
     "Apply to note…" which pre-fills the note editor with the tech's
     text so the admin can curate the final wording before saving as a
     real note. Approving/rejecting only updates the suggestion doc.
     ==================================================================== */

  let noteSuggestions = [];

  function suggestionRowHtml(s) {
    const status = String(s.status || "pending").toLowerCase();
    const statusCls = status === "approved" ? "is-approved"
                    : status === "rejected" ? "is-rejected"
                    : "is-pending";
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    const createdMs = tsToMillis(s.created_at);
    const createdTxt = createdMs ? new Date(createdMs).toLocaleString() : "—";
    const isPending = status === "pending";

    const linkedNote = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;

    const customerLine = customerLabelForSlug(s.customer_slug) +
      (linkedNote ? " · note: " + (linkedNote.title || "(untitled)") : "");

    return (
      '<div class="suggestion-row" role="listitem" data-id="' + escapeHtml(s.id) + '">' +
        '<div>' +
          '<div class="suggestion-status-pill ' + statusCls + '">' + escapeHtml(statusLabel) + '</div>' +
          '<p class="suggestion-customer">' + escapeHtml(customerLine) + '</p>' +
          '<pre class="suggestion-body-preview">' + escapeHtml(s.suggested_change || "") + '</pre>' +
        '</div>' +
        '<div class="suggestion-meta">' +
          '<div>From: ' + escapeHtml(s.suggested_by_display_name || s.suggested_by || "(unknown)") + '</div>' +
          '<div>Submitted: ' + escapeHtml(createdTxt) + '</div>' +
          (s.reviewed_by
            ? '<div>Reviewed by ' + escapeHtml(s.reviewed_by) + '</div>'
            : '') +
        '</div>' +
        '<div class="row-actions">' +
          (isPending
            ? '<button class="row-btn" type="button" data-action="review-suggestion">Review</button>'
            : '<button class="row-btn" type="button" data-action="review-suggestion">View</button>') +
        '</div>' +
      '</div>'
    );
  }

  function applyCurrentSuggestionsFilter() {
    const root  = $("suggestions-list");
    const cnt   = $("suggestions-count");
    const badge = $("suggestions-pending-badge");
    if (!root) return;

    const stat  = ($("suggestions-filter-status")   && $("suggestions-filter-status").value)   || "pending";
    const cust  = ($("suggestions-filter-customer") && $("suggestions-filter-customer").value) || "all";

    const filtered = noteSuggestions.filter(function (s) {
      if (stat !== "all" && String(s.status || "pending") !== stat) return false;
      if (cust !== "all" && String(s.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + noteSuggestions.length + " suggestion" + (noteSuggestions.length === 1 ? "" : "s");

    const pendingCount = noteSuggestions.filter(function (s) { return String(s.status || "pending") === "pending"; }).length;
    if (badge) {
      if (pendingCount > 0) { badge.hidden = false; badge.textContent = pendingCount > 9 ? "9+" : String(pendingCount); }
      else                  { badge.hidden = true;  badge.textContent = "0"; }
    }

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("suggestions", "empty");
      return;
    }
    hideAllStatuses("suggestions");
    root.innerHTML = filtered.map(suggestionRowHtml).join("");
  }

  async function loadNoteSuggestions() {
    setStatus("suggestions", "loading");
    try {
      const snap = await db.collection("customer_note_suggestions").get();
      noteSuggestions = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      noteSuggestions.sort(function (a, b) {
        return (tsToMillis(b.created_at) || 0) - (tsToMillis(a.created_at) || 0);
      });
      applyCurrentSuggestionsFilter();
    } catch (err) {
      console.error("loadNoteSuggestions failed", err);
      setStatus("suggestions", "error",
        "Couldn't load suggestions: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the customer_note_suggestions block."
      );
    }
  }

  function openSuggestionReviewModal(s) {
    const modal = $("suggestion-review-modal");
    if (!modal) return;
    $("suggestion-review-id").value = s.id;
    $("suggestion-review-customer").textContent = customerLabelForSlug(s.customer_slug);
    $("suggestion-review-body").textContent = s.suggested_change || "";
    $("suggestion-review-notes").value = s.review_notes || "";

    const linkedNote = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;
    const existingBlock = $("suggestion-review-existing-block");
    if (linkedNote) {
      existingBlock.hidden = false;
      $("suggestion-review-existing-title").textContent = linkedNote.title || "(untitled)";
      $("suggestion-review-existing-body").textContent  = linkedNote.body || "";
    } else {
      existingBlock.hidden = true;
    }

    const createdMs = tsToMillis(s.created_at);
    const createdTxt = createdMs ? new Date(createdMs).toLocaleString() : "—";
    $("suggestion-review-meta").textContent =
      "Submitted by " + (s.suggested_by_display_name || s.suggested_by || "(unknown)") +
      " on " + createdTxt + " · status: " + (s.status || "pending");

    // Action visibility — Approve/Reject/Apply only on pending; closed
    // suggestions are read-only.
    const isPending = String(s.status || "pending") === "pending";
    $("suggestion-approve").hidden = !isPending;
    $("suggestion-reject").hidden  = !isPending;
    $("suggestion-apply-to-note").hidden = !isPending;

    setModalError("suggestion-review-modal", "");
    openModal("suggestion-review-modal");
  }

  async function setSuggestionStatus(id, newStatus) {
    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const notes = $("suggestion-review-notes").value.trim();
    try {
      await db.collection("customer_note_suggestions").doc(id).update({
        status:        newStatus,
        reviewed_by:   adminEmail,
        reviewed_at:   sts,
        review_notes:  notes || null
      });
      showToast("ok", "Suggestion " + newStatus + ".");
      closeModal("suggestion-review-modal");
      await loadNoteSuggestions();
    } catch (err) {
      handleAdminWriteError(err, { context: "suggestion review", modalId: "suggestion-review-modal" });
    }
  }

  function onSuggestionApplyToNote() {
    const id = $("suggestion-review-id").value.trim();
    const s  = noteSuggestions.find(function (x) { return x.id === id; });
    if (!s) return;
    // Pre-fill the note editor. If the suggestion targets an existing
    // note, open Edit mode pre-loaded with the existing note + a
    // synthetic title/body merging in the suggested text. Admin curates
    // before saving. Mark the suggestion approved after the note saves
    // (admin does this separately by reopening this modal).
    closeModal("suggestion-review-modal");
    const existing = s.existing_note_id
      ? customerNotes.find(function (n) { return n.id === s.existing_note_id; })
      : null;
    if (existing) {
      // Open edit mode for the existing note; pre-append tech's
      // suggestion to the body so admin can edit before saving.
      const merged = Object.assign({}, existing, {
        body: (existing.body || "") +
              "\n\n--- Suggested by " + (s.suggested_by || "tech") + " ---\n" +
              (s.suggested_change || "")
      });
      openNoteEditModal(merged);
      showToast("ok", "Suggestion text appended — edit + save the note, then reopen the suggestion to approve.");
    } else {
      // Brand-new note. Pre-fill with suggested text in the body.
      openNoteCreateModal({
        customer_slug: s.customer_slug,
        title:         "",
        body:          s.suggested_change || "",
        category:      "Other"
      });
      showToast("ok", "New-note form pre-filled — fill in the title, then save.");
    }
  }

  function wireSuggestionsControls() {
    const list = $("suggestions-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const s = noteSuggestions.find(function (x) { return x.id === row.dataset.id; });
        if (!s) return;
        if (btn.dataset.action === "review-suggestion") openSuggestionReviewModal(s);
      });
    }
    const approve = $("suggestion-approve");
    if (approve) approve.addEventListener("click", function () {
      const id = $("suggestion-review-id").value;
      if (id) setSuggestionStatus(id, "approved");
    });
    const reject = $("suggestion-reject");
    if (reject) reject.addEventListener("click", function () {
      const id = $("suggestion-review-id").value;
      if (id) setSuggestionStatus(id, "rejected");
    });
    const apply = $("suggestion-apply-to-note");
    if (apply) apply.addEventListener("click", onSuggestionApplyToNote);

    const refresh = $("suggestions-refresh");
    if (refresh) refresh.addEventListener("click", loadNoteSuggestions);

    ["suggestions-filter-status", "suggestions-filter-customer"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentSuggestionsFilter);
    });
  }

  /* ====================================================================
     Service Recoveries — admin coaching board
     ====================================================================
     Reads /service_recoveries. Admin can edit status / assignment /
     resolution. "Mark resolved" stamps resolved_at + resolved_by in
     one click. Customer + linked inspection_id are immutable after
     create. Soft-delete only — workflow is "resolved", not "deleted".
     ==================================================================== */

  let serviceRecoveries = [];
  const RECOVERY_STATUSES = ["open", "in_progress", "resolved", "cannot_resolve"];

  function recoveryRowHtml(r) {
    const status = String(r.status || "open").toLowerCase();
    const sev    = String(r.severity || "low").toLowerCase();
    const created = r.created_at ? new Date(tsToMillis(r.created_at)).toLocaleDateString() : "—";
    const due     = r.due_date    || "";
    const overdue = due && status !== "resolved" && status !== "cannot_resolve" &&
                    Date.parse(due + "T23:59:59Z") < Date.now();
    const customer = customerLabelForSlug(r.customer_slug);
    const assignee = r.assigned_to_display_name || (r.assigned_to_email ? r.assigned_to_email : "Unassigned");

    return (
      '<div class="recovery-row" role="listitem" data-id="' + escapeHtml(r.id) + '">' +
        '<div>' +
          '<p class="recovery-customer">' + escapeHtml(customer) + '</p>' +
          '<span class="recovery-pill is-' + escapeHtml(status) + '">' + escapeHtml(status.replace("_", " ")) + '</span>' +
          '<span class="recovery-pill sev-' + escapeHtml(sev) + '">' + escapeHtml(sev) + '</span>' +
          (overdue ? '<span class="recovery-overdue">Overdue</span>' : '') +
          '<pre class="recovery-desc">' + escapeHtml(r.description || "") + '</pre>' +
        '</div>' +
        '<div class="recovery-meta">' +
          '<span class="recovery-meta-line">Assigned: ' + escapeHtml(assignee) + '</span>' +
          '<span class="recovery-meta-line">Area: ' + escapeHtml(r.area || "—") + '</span>' +
          '<span class="recovery-meta-line">Due: ' + escapeHtml(due || "—") + '</span>' +
          '<span class="recovery-meta-line">Created: ' + escapeHtml(created) +
            (r.created_by ? ' by ' + escapeHtml(r.created_by) : '') +
          '</span>' +
          (r.resolved_at
            ? '<span class="recovery-meta-line">Resolved ' +
                escapeHtml(new Date(tsToMillis(r.resolved_at)).toLocaleDateString()) +
                (r.resolved_by ? ' by ' + escapeHtml(r.resolved_by) : '') +
              '</span>'
            : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="row-btn" type="button" data-action="edit-recovery">Edit</button>' +
        '</div>' +
      '</div>'
    );
  }

  function populateRecoveryAssignedDropdown(selId) {
    const sel = $(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">— Unassigned —</option>';
    const activeTechs = techs
      .filter(function (t) { return getActive(t); })
      .sort(function (a, b) { return getTechName(a).localeCompare(getTechName(b)); });
    activeTechs.forEach(function (t) {
      const slug  = getTechSlug(t);
      const email = (t.email || "").toLowerCase().trim();
      const name  = getTechName(t) || slug;
      const opt = document.createElement("option");
      opt.value = slug;
      opt.dataset.email = email;
      opt.dataset.name  = name;
      opt.textContent = name + (email ? " (" + email + ")" : "");
      sel.appendChild(opt);
    });
  }

  function applyCurrentRecoveriesFilter() {
    const root  = $("recoveries-list");
    const cnt   = $("recoveries-count");
    const badge = $("recoveries-open-badge");
    if (!root) return;

    const stat  = ($("recoveries-filter-status")   && $("recoveries-filter-status").value)   || "open";
    const cust  = ($("recoveries-filter-customer") && $("recoveries-filter-customer").value) || "all";
    const sev   = ($("recoveries-filter-severity") && $("recoveries-filter-severity").value) || "all";
    const q     = String(($("recoveries-search") && $("recoveries-search").value) || "").trim().toLowerCase();

    const filtered = serviceRecoveries.filter(function (r) {
      const s = String(r.status || "open").toLowerCase();
      if (stat === "active") { if (s !== "open" && s !== "in_progress") return false; }
      else if (stat !== "all" && s !== stat) return false;
      if (cust !== "all" && String(r.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      if (sev !== "all" && String(r.severity || "").toLowerCase() !== sev) return false;
      if (q) {
        const hay = [
          r.description, r.customer_slug, customerLabelForSlug(r.customer_slug),
          r.assigned_to_display_name, r.assigned_to_email, r.area
        ].filter(Boolean).join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + serviceRecoveries.length + " recovery" + (serviceRecoveries.length === 1 ? "" : "ies");

    // Open badge count (top-level open + in_progress, irrespective of filters).
    if (badge) {
      const openCount = serviceRecoveries.filter(function (r) {
        const s = String(r.status || "open").toLowerCase();
        return s === "open" || s === "in_progress";
      }).length;
      if (openCount > 0) { badge.hidden = false; badge.textContent = openCount > 9 ? "9+" : String(openCount); }
      else                { badge.hidden = true;  badge.textContent = "0"; }
    }

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("recoveries", "empty");
      return;
    }
    hideAllStatuses("recoveries");
    root.innerHTML = filtered.map(recoveryRowHtml).join("");
  }

  async function loadServiceRecoveries() {
    setStatus("recoveries", "loading");
    try {
      const snap = await db.collection("service_recoveries").get();
      serviceRecoveries = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      serviceRecoveries.sort(function (a, b) {
        // Open / in_progress first; resolved/cannot_resolve last; tie-break by created desc.
        function rank(r) {
          const s = String(r.status || "open").toLowerCase();
          if (s === "open")           return 0;
          if (s === "in_progress")    return 1;
          if (s === "cannot_resolve") return 2;
          if (s === "resolved")       return 3;
          return 4;
        }
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return (tsToMillis(b.created_at) || 0) - (tsToMillis(a.created_at) || 0);
      });
      // Populate customer filter dropdown (reuses the customers cache).
      const sel = $("recoveries-filter-customer");
      if (sel) {
        const preserved = sel.value || "all";
        const opts = customers
          .filter(function (c) { return getActive(c); })
          .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); });
        sel.innerHTML = '<option value="all">All customers</option>' + opts.map(function (c) {
          const slug = getCustomerSlug(c);
          return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(getCustomerName(c)) + '</option>';
        }).join("");
        sel.value = preserved;
      }
      applyCurrentRecoveriesFilter();
    } catch (err) {
      console.error("loadServiceRecoveries failed", err);
      setStatus("recoveries", "error",
        "Couldn't load service recoveries: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the service_recoveries block."
      );
    }
  }

  function openRecoveryEditModal(r) {
    if (!r) return;
    $("recovery-edit-id").value = r.id;
    $("recovery-edit-title").textContent = "Service Recovery · " + customerLabelForSlug(r.customer_slug);
    $("recovery-edit-desc").textContent = r.description || "";
    $("recovery-edit-status").value = r.status || "open";
    $("recovery-edit-due").value = r.due_date || "";
    $("recovery-edit-resolution").value = r.resolution_notes || "";

    populateRecoveryAssignedDropdown("recovery-edit-assigned");
    const sel = $("recovery-edit-assigned");
    if (sel) sel.value = r.assigned_to || "";

    const meta = [];
    if (r.area) meta.push("Area: " + r.area);
    if (r.severity) meta.push("Severity: " + r.severity);
    if (r.inspection_id) meta.push("Linked inspection: " + r.inspection_id);
    if (r.created_at) meta.push("Created " + new Date(tsToMillis(r.created_at)).toLocaleString());
    $("recovery-edit-meta").textContent = meta.join(" · ");

    setModalError("recovery-edit-modal", "");
    setModalSaving("recovery-edit-modal", false);
    openModal("recovery-edit-modal");
  }

  async function onRecoverySave() {
    const id = $("recovery-edit-id").value.trim();
    if (!id) return;
    const status = $("recovery-edit-status").value;
    const due    = $("recovery-edit-due").value.trim();
    const resolution = $("recovery-edit-resolution").value.trim();
    const sel = $("recovery-edit-assigned");
    const opt = sel ? sel.options[sel.selectedIndex] : null;
    const assignedTo    = (sel && sel.value) || null;
    const assignedEmail = (opt && opt.dataset && opt.dataset.email) || null;
    const assignedName  = (opt && opt.dataset && opt.dataset.name)  || null;

    if (RECOVERY_STATUSES.indexOf(status) < 0) {
      setModalError("recovery-edit-modal", "Pick a valid status."); return;
    }

    setModalSaving("recovery-edit-modal", true);
    setModalError("recovery-edit-modal", "");

    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const adminEmail = getCurrentAdminEmail();
    const updates = {
      status:                      status,
      assigned_to:                 assignedTo,
      assigned_to_email:           assignedEmail,
      assigned_to_display_name:    assignedName,
      due_date:                    due || null,
      resolution_notes:            resolution || null,
      updated_at:                  sts,
      updated_by:                  adminEmail
    };
    if (status === "resolved" || status === "cannot_resolve") {
      updates.resolved_at = sts;
      updates.resolved_by = adminEmail;
    } else {
      // If status moves back from resolved, clear the resolved stamp.
      updates.resolved_at = null;
      updates.resolved_by = null;
    }

    try {
      await db.collection("service_recoveries").doc(id).update(updates);
      showToast("ok", "Service Recovery updated.");
      closeModal("recovery-edit-modal");
      await loadServiceRecoveries();
    } catch (err) {
      handleAdminWriteError(err, { context: "recovery save", modalId: "recovery-edit-modal" });
    } finally {
      setModalSaving("recovery-edit-modal", false);
    }
  }

  async function onRecoveryMarkResolved() {
    // Force status → resolved + stamp resolved_*. Reads any in-flight
    // resolution text and assignee from the open modal.
    $("recovery-edit-status").value = "resolved";
    await onRecoverySave();
  }

  function wireRecoveriesControls() {
    const list = $("recoveries-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const r = serviceRecoveries.find(function (x) { return x.id === row.dataset.id; });
        if (!r) return;
        if (btn.dataset.action === "edit-recovery") openRecoveryEditModal(r);
      });
    }
    const refresh = $("recoveries-refresh");
    if (refresh) refresh.addEventListener("click", loadServiceRecoveries);
    const save = $("recovery-edit-save");
    if (save) save.addEventListener("click", onRecoverySave);
    const markResolved = $("recovery-mark-resolved");
    if (markResolved) markResolved.addEventListener("click", onRecoveryMarkResolved);

    ["recoveries-filter-status", "recoveries-filter-customer", "recoveries-filter-severity"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentRecoveriesFilter);
    });
    const search = $("recoveries-search");
    if (search) search.addEventListener("input", applyCurrentRecoveriesFilter);
  }

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
    const targetCustomer = customers.find(function (c) { return getCustomerSlug(c) === slug; });
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
      await loadCustomers();
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
    const customer = customers.find(function (c) { return getCustomerSlug(c) === slug; });
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
      await loadCustomers();
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
    const claimants = customers.filter(function (c) {
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
      await loadCustomers();
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
      await loadCustomers();
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
    const customer = customers.find(function (c) { return getCustomerSlug(c) === slug; });
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
    customers.forEach(function (c) {
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
      await loadTechs();
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
    const custRoot = $("customer-list");
    if (custRoot) {
      custRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const c = customers.find(function (x) { return x.id === row.dataset.id; });
        if (!c) return;
        if (btn.dataset.action === "edit")    openCustomerEditModal(c);
        if (btn.dataset.action === "archive") onCustomerArchive(c);
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

        if (action === "edit")    openTechEditModal(t);
        if (action === "media")   openTechMediaModal(t);
        if (action === "archive") onTechArchive(t);
        if (action === "delete")  onTechDelete(t);
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
      const modal = $("customer-edit-modal");
      const mode  = modal ? (modal.dataset.mode || "edit") : "edit";
      if (mode === "create") onCustomerCreateSave();
      else                   onCustomerEditSave();
    });
    const techSave = $("tech-edit-save");
    if (techSave) techSave.addEventListener("click", onTechEditSave);
    const techCreateSave = $("tech-create-save");
    if (techCreateSave) techCreateSave.addEventListener("click", onTechCreateSave);

    // "+ Add customer" button → opens the customer modal in create mode.
    const custCreateOpen = $("customer-create-open");
    if (custCreateOpen) custCreateOpen.addEventListener("click", openCustomerCreateModal);

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
    if (techCreateOpen) techCreateOpen.addEventListener("click", openTechCreateModal);

    // Generic helper: wire one assignments checklist (search + delegated
    // checkbox toggles) to its staging Set. Shared by edit + create.
    function wireAssignmentChecklist(opts) {
      const search  = $(opts.searchId);
      const list    = $(opts.listId);
      const countId = opts.countId;
      const staging = opts.staging;
      const reRender = opts.reRender;
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
          if (cb.checked) staging().add(slug);
          else            staging().delete(slug);
          const countEl = $(countId);
          if (countEl) {
            const total = customers.filter(function (c) { return getActive(c); }).length;
            countEl.textContent =
              staging().size + " of " + total +
              (total === 1 ? " customer assigned" : " customers assigned");
          }
        });
      }
    }

    wireAssignmentChecklist({
      searchId: "tech-assignments-search",
      listId:   "tech-assignments-list",
      countId:  "tech-assignments-count",
      staging:  function () { return pendingTechAssigned; },
      reRender: renderTechAssignments
    });
    wireAssignmentChecklist({
      searchId: "tech-create-assignments-search",
      listId:   "tech-create-assignments-list",
      countId:  "tech-create-assignments-count",
      staging:  function () { return pendingTechCreateAssigned; },
      reRender: renderTechCreateAssignments
    });

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

  /* ====================================================================
     Tech Health — operational support dashboard (admin-only)
     ====================================================================
     NOT surveillance. NOT a public ranking. The intent is to surface
     early signals so admins can check in with a tech who might need
     support — and to celebrate techs who are reliably showing up +
     helping the team.

     Last-30-day window over existing PioneerOps signals:
       Positive: DCRs submitted, open-shift pickups, Rockstar bonuses,
                 5-star inspections
       Watch:    call-outs, over-budget DCRs, open inspection
                 follow-ups

     Status thresholds (documented inline so the rationale is visible
     when an admin clicks "Why?"):
       needs-support : ≥ 4 call-outs in last 30d
       watch         : ≥ 2 call-outs OR ≥ 2 over-budget DCRs
       stable        : default

     Phase 2 TODO:
       • midnight cron: incomplete shifts (Deputy ended, no DCR)
       • complaint/compliment linkage via dcrId
       • customer continuity score
       • trend deltas vs prior 30 days
       • "support check-in" workflow with manager notes */

  const TECH_HEALTH_WINDOW_DAYS = 30;

  let techHealthState  = [];      // computed per-tech metrics
  let techHealthFilter = "all";

  function techHealthMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds  === "number")   return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function techHealthSetState(state, msg) {
    const ids = { loading: "tech-health-loading", error: "tech-health-error", empty: "tech-health-empty" };
    Object.keys(ids).forEach(function (k) {
      const el = $(ids[k]);
      if (el) el.hidden = (k !== state);
    });
    if (state === "error" && msg) {
      const el = $("tech-health-error");
      if (el) el.textContent = msg;
    }
  }

  async function loadTechHealth() {
    techHealthSetState("loading");
    try {
      const db = firebase.firestore();
      const sinceMs = Date.now() - TECH_HEALTH_WINDOW_DAYS * 86400000;
      const sinceTs = firebase.firestore.Timestamp.fromMillis(sinceMs);

      // Parallel queries. Each is capped so a runaway collection
      // can't blow up the dashboard.
      const [coSnap, osSnap, rbSnap, inspSnap] = await Promise.all([
        db.collection("call_outs")
          .where("submittedAt", ">=", sinceTs)
          .limit(500).get()
          .catch(function (err) { console.warn("[tech-health] call_outs read failed", err); return { docs: [] }; }),
        db.collection("open_shift_requests")
          .where("status", "==", "confirmed")
          .where("confirmedAt", ">=", sinceTs)
          .limit(300).get()
          .catch(function (err) { console.warn("[tech-health] open_shift_requests read failed", err); return { docs: [] }; }),
        db.collection("rockstar_bonuses")
          .where("earnedAt", ">=", sinceTs)
          .limit(300).get()
          .catch(function (err) { console.warn("[tech-health] rockstar_bonuses read failed", err); return { docs: [] }; }),
        db.collection("inspections")
          .where("inspected_at", ">=", sinceTs)
          .limit(500).get()
          .catch(function (err) { console.warn("[tech-health] inspections read failed", err); return { docs: [] }; })
      ]);

      // Bucket each signal by techSlug. Some signals expose techId
      // (call_outs, rockstar_bonuses, open_shift_requests) — those
      // all use the cleaning_techs slug as the ID. inspections use
      // credited_cleaning_tech_slug. DCRs come from the in-memory
      // `dcrs` cache.
      function bucket(snap, getKey, cb) {
        const m = new Map();
        (snap.docs || []).forEach(function (d) {
          const data = d.data ? (d.data() || {}) : {};
          const key  = getKey(data);
          if (!key) return;
          if (!m.has(key)) m.set(key, { count: 0, fiveStar: 0 });
          m.get(key).count += 1;
          if (typeof cb === "function") cb(data, m.get(key));
        });
        return m;
      }
      const callOutsByTech    = bucket(coSnap,   function (d) { return d.techId; });
      const pickupsByTech     = bucket(osSnap,   function (d) { return d.acceptedByTechId; });
      const bonusesByTech     = bucket(rbSnap,   function (d) { return d.techId; });
      const inspectionsByTech = bucket(inspSnap, function (d) { return d.credited_cleaning_tech_slug || d.credited_tech_slug; }, function (d, b) {
        const score = Number(d.overall_score);
        if (!isNaN(score) && score >= 4.8) b.fiveStar += 1;
      });

      // DCRs from cache. Production over-budget signal is
      // `d.timeBudget.withinBudget === false` (set by app.js when the
      // tech reports the shift went over budget). Legacy field
      // variants are checked as fallbacks for any prior-schema docs.
      const dcrsByTech = new Map();
      (Array.isArray(dcrs) ? dcrs : []).forEach(function (d) {
        const ts = techHealthMs(d.submittedAt || d.submitted_at || d.createdAt);
        if (!ts || ts < sinceMs) return;
        const slug = d.tech_slug || d.techSlug || "";
        if (!slug) return;
        if (!dcrsByTech.has(slug)) dcrsByTech.set(slug, { count: 0, overBudget: 0 });
        const b = dcrsByTech.get(slug);
        b.count += 1;
        // Primary: the nested timeBudget shape app.js writes today.
        // Secondary: legacy / mirror fields the form has used.
        const overBudget =
             (d.timeBudget && d.timeBudget.withinBudget === false)
          || (d.time_budget && d.time_budget.within_budget === false)
          || d.overtimeOrOverBudget === true
          || d.overtime_or_over_budget === true
          || !!(d.overBudgetReason || d.over_budget_reason)
          || !!(d.overtimeOrOverBudgetReason || d.overtime_or_over_budget_reason);
        if (overBudget) b.overBudget += 1;
      });

      // Stitch per-tech rows. Only active techs render — archived
      // techs would otherwise add noise.
      techHealthState = (techs || [])
        .filter(function (t) { return t.active !== false; })
        .map(function (t) {
          const slug = t.tech_slug || t.slug || t.id || "";
          const co   = callOutsByTech.get(slug)    || { count: 0 };
          const pu   = pickupsByTech.get(slug)     || { count: 0 };
          const rb   = bonusesByTech.get(slug)     || { count: 0 };
          const insp = inspectionsByTech.get(slug) || { count: 0, fiveStar: 0 };
          const dcr  = dcrsByTech.get(slug)        || { count: 0, overBudget: 0 };

          let status   = "stable";
          const reasons = [];
          if (co.count >= 4) {
            status = "needs-support";
            reasons.push(co.count + " call-outs in last 30 days");
          } else if (co.count >= 2) {
            status = "watch";
            reasons.push(co.count + " call-outs in last 30 days");
          }
          if (dcr.overBudget >= 2 && status === "stable") {
            status = "watch";
            reasons.push(dcr.overBudget + " over-budget DCRs in last 30 days");
          } else if (dcr.overBudget >= 2 && status === "watch") {
            reasons.push(dcr.overBudget + " over-budget DCRs in last 30 days");
          }

          return {
            tech: t,
            slug: slug,
            display_name: t.display_name || t.name || slug,
            status: status,
            reasons: reasons,
            metrics: {
              dcrs:        dcr.count,
              overBudget:  dcr.overBudget,
              callOuts:    co.count,
              pickups:     pu.count,
              rockstars:   rb.count,
              inspections: insp.count,
              fiveStar:    insp.fiveStar
            }
          };
        })
        // Sort: needs-support first, then watch, then stable. Within
        // each tier, alphabetical by display_name.
        .sort(function (a, b) {
          const order = { "needs-support": 0, "watch": 1, "stable": 2 };
          const oa = order[a.status] == null ? 3 : order[a.status];
          const ob = order[b.status] == null ? 3 : order[b.status];
          if (oa !== ob) return oa - ob;
          return String(a.display_name).localeCompare(String(b.display_name));
        });

      techHealthSetState(null);
      renderTechHealth();
    } catch (err) {
      console.error("[tech-health] load failed", err);
      techHealthSetState("error",
        err && err.code === "permission-denied"
          ? "Permission denied. Confirm you're signed in as an admin."
          : "Couldn't load tech health: " + (err && (err.message || err.code) || "unknown"));
    }
  }

  function techHealthEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderTechHealth() {
    const listEl    = $("tech-health-list");
    const emptyEl   = $("tech-health-empty");
    const loadingEl = $("tech-health-loading");
    const errorEl   = $("tech-health-error");
    if (!listEl || !emptyEl) return;

    // Always sync the tab badge with the current flagged count.
    // Running it here (not just inside loadTechHealth) keeps the
    // badge correct after filter clicks and any future re-render,
    // and survives any stale-paint scenario from earlier turns.
    try {
      const flagged = techHealthState.filter(function (x) {
        return x.status === "watch" || x.status === "needs-support";
      }).length;
      const badge = $("tech-health-tab-badge");
      if (badge) {
        if (flagged > 0) {
          badge.textContent = String(flagged);
          badge.hidden = false;
          badge.removeAttribute("hidden");      // belt+suspenders for any older paint that left `hidden` attr stuck
        } else {
          badge.hidden = true;
          badge.setAttribute("hidden", "");
        }
      }
    } catch (_e) { /* badge is decorative; never fail render over it */ }

    // Hard-reset transient state surfaces. Defensive — every render
    // takes responsibility for hiding loading/error so a prior
    // render's loading text can never stack with the card list.
    if (loadingEl) loadingEl.hidden = true;
    if (errorEl)   errorEl.hidden   = true;

    const rows = techHealthState.filter(function (x) {
      if (techHealthFilter === "all") return true;
      return x.status === techHealthFilter;
    });

    if (!rows.length) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = techHealthFilter === "all"
        ? "No active techs to display."
        : "No techs in this status. Nice.";
      return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = rows.map(function (r) {
      const statusLabel = r.status === "needs-support" ? "Needs Support"
                        : r.status === "watch"         ? "Watch"
                        :                                "Stable";
      const statusChip =
        '<span class="th-status-chip th-status-chip--' + r.status + '">' + statusLabel + '</span>';

      // Tech avatar — photo if cleaning_techs has photoUrl, otherwise
      // a colored initial. Reuse the existing colorForSeed pattern by
      // computing here (admin.js doesn't expose colorForSeed; do a
      // tiny inline HSL hash so we get the same per-tech identity
      // color the schedule page uses).
      function colorForSlug(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
        const hue = Math.abs(h) % 360;
        return { bg: "hsl(" + hue + " 70% 92%)", ring: "hsl(" + hue + " 55% 60%)", fg: "hsl(" + hue + " 50% 28%)" };
      }
      const c = colorForSlug(r.slug || r.display_name);
      const photoUrl = (r.tech && (r.tech.photoUrl || r.tech.profilePhotoUrl)) || "";
      const initial  = (String(r.display_name).trim().charAt(0) || "?").toUpperCase();
      const avatar = photoUrl
        ? '<span class="th-avatar"><img src="' + techHealthEscape(photoUrl) + '" alt="" /></span>'
        : '<span class="th-avatar th-avatar--initial"' +
            ' style="background:' + c.bg + ';color:' + c.fg + ';border-color:' + c.ring + ';">' +
            techHealthEscape(initial) +
          '</span>';

      // Positive-first metric row. Reasons (Watch/NeedsSupport) live
      // below in a separate "what we're watching" block.
      const metricsHtml =
        '<dl class="th-metrics">' +
          '<div><dt>DCRs</dt><dd>' + r.metrics.dcrs + '</dd></div>' +
          '<div><dt>Pickups</dt><dd>' + r.metrics.pickups + '</dd></div>' +
          '<div><dt>Rockstars</dt><dd>' + r.metrics.rockstars + '</dd></div>' +
          '<div><dt>5★ insp.</dt><dd>' + r.metrics.fiveStar + '</dd></div>' +
        '</dl>';

      const watchHtml = r.reasons.length
        ? '<div class="th-watch"><span class="th-watch-label">What we\'re watching:</span> ' +
          r.reasons.map(techHealthEscape).join(" · ") +
          ' <span class="th-watch-cta">A supportive check-in might help.</span></div>'
        : '';

      return (
        '<article class="th-card th-card--' + r.status + '" role="listitem">' +
          '<header class="th-head">' +
            avatar +
            '<h3 class="th-name">' + techHealthEscape(r.display_name) + '</h3>' +
            statusChip +
          '</header>' +
          metricsHtml +
          watchHtml +
        '</article>'
      );
    }).join("");
  }

  function wireTechHealthControls() {
    document.querySelectorAll(".tech-health-pill[data-th-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        techHealthFilter = btn.dataset.thFilter || "all";
        document.querySelectorAll(".tech-health-pill").forEach(function (b) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        renderTechHealth();
      });
    });
    const refresh = $("tech-health-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadTechHealth(); });
  }

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
    registerTabActivator("feed",            mountOperationalFeedOnce);
    registerTabActivator("training",        loadTrainingReport);
    registerTabActivator("schedule",        function () {
      loadTeamSchedule();
      loadPublishedSnapshot();
      loadScheduleDraft();
    });
    registerTabActivator("attendance",      loadAttendance);
    registerTabActivator("tech-health",     loadTechHealth);
    registerTabActivator("pilot-readiness", initPilotReadinessOnce);
    registerTabActivator("yesterday",       initYesterdayOnce);
    registerTabActivator("improvements",    initImprovementsOnce);
    registerTabActivator("sos",             initSosOnce);
    wireSearch();
    wireRefresh();
    wireSupplyControls();
    wireIssuesControls();
    wireAttentionStrip();
    wireAnnouncementsControls();
    wireAdminsControls();
    wireNotesControls();
    wireSuggestionsControls();
    wireRecoveriesControls();
    wireDeputyMappingControls();
    wireScheduleControls();
    wireScheduleImportControls();
    wireAttendanceControls();
    wireOpenShiftsControls();
    wireTechHealthControls();
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

  /* ====================================================================
   * Training Reports (System tab → Training)
   *
   * Reads safety-training completion progress across every user via a
   * collectionGroup("training_progress") query. firestore.rules gates
   * that pattern to admins only (see the
   * `match /{path=**}/training_progress/{lessonId}` block).
   *
   * Lessons come from /data/training-lessons.json — the same static
   * file the tech viewer (training.js) uses. We don't store lesson
   * metadata in Firestore so admins can hand-edit the catalog without
   * a Firestore write path.
   * ================================================================== */
  let trainingReportLoaded = false;

  async function fetchLessonCatalog() {
    try {
      const res = await fetch("data/training-lessons.json", { credentials: "same-origin" });
      if (!res.ok) throw new Error("catalog " + res.status);
      const json = await res.json();
      return (json && Array.isArray(json.lessons)) ? json.lessons : [];
    } catch (err) {
      console.warn("[admin/training] catalog fetch failed", err && err.message || err);
      return [];
    }
  }

  function statusPillHtml(status) {
    if (status === "completed")   return '<span class="training-report-cell-pill is-done">Completed</span>';
    if (status === "in_progress") return '<span class="training-report-cell-pill is-mid">In progress</span>';
    return '<span class="training-report-cell-pill is-new">' + escapeHtml(status || "—") + '</span>';
  }

  function fmtCompletedAt(row) {
    const ts = row.completedAt || row.acknowledgmentSignedAt || row.updatedAt;
    if (!ts) return "—";
    try {
      const d = ts.toDate ? ts.toDate() : (typeof ts === "string" ? new Date(ts) : null);
      if (!d || isNaN(d.getTime())) return "—";
      return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    } catch (_e) { return "—"; }
  }

  async function loadTrainingReport() {
    const loadingEl = $("training-report-loading");
    const errorEl   = $("training-report-error");
    const emptyEl   = $("training-report-empty");
    const wrapEl    = $("training-report-wrap");
    const tbodyEl   = $("training-report-tbody");
    const subEl     = $("training-report-sub");
    if (!tbodyEl) return;
    [loadingEl, errorEl, emptyEl, wrapEl].forEach(function (el) { if (el) el.hidden = true; });
    if (loadingEl) loadingEl.hidden = false;

    try {
      const [lessons, progressSnap] = await Promise.all([
        fetchLessonCatalog(),
        firebase.firestore().collectionGroup("training_progress").get()
      ]);
      const titleById = {};
      lessons.forEach(function (l) { titleById[l.id] = l.title || l.id; });

      const rows = progressSnap.docs.map(function (d) {
        const data = d.data() || {};
        const path = d.ref.path; // users/{uid}/training_progress/{lessonId}
        const m = path.match(/^users\/([^/]+)\/training_progress\/([^/]+)$/);
        const uid      = (m && m[1]) || "";
        const lessonId = (m && m[2]) || d.id;
        return {
          uid:           uid,
          lessonId:      lessonId,
          lessonTitle:   titleById[lessonId] || lessonId,
          status:        data.status || "in_progress",
          score:         (data.score == null) ? null : data.score,
          completedAt:   data.completedAt,
          acknowledgmentSignedAt: data.acknowledgmentSignedAt,
          updatedAt:     data.updatedAt,
          email:         data.email || "",
          displayName:   data.displayName || data.signedName || "",
          raw:           data
        };
      });
      // Sort: most recent first.
      rows.sort(function (a, b) {
        const ax = (a.completedAt && a.completedAt.toMillis && a.completedAt.toMillis()) ||
                   (a.updatedAt   && a.updatedAt.toMillis   && a.updatedAt.toMillis())   || 0;
        const bx = (b.completedAt && b.completedAt.toMillis && b.completedAt.toMillis()) ||
                   (b.updatedAt   && b.updatedAt.toMillis   && b.updatedAt.toMillis())   || 0;
        return bx - ax;
      });

      if (loadingEl) loadingEl.hidden = true;
      if (subEl) {
        const total     = rows.length;
        const completed = rows.filter(function (r) { return r.status === "completed"; }).length;
        subEl.textContent = total + " progress record" + (total === 1 ? "" : "s") +
                            " · " + completed + " completed";
      }
      if (!rows.length) {
        if (emptyEl) emptyEl.hidden = false;
        return;
      }

      tbodyEl.innerHTML = rows.map(function (r) {
        const who   = r.displayName ? (escapeHtml(r.displayName) + '<span class="training-report-meta">' + escapeHtml(r.email || r.uid) + '</span>')
                                    : escapeHtml(r.email || r.uid);
        const score = (r.score == null) ? "—" : (escapeHtml(String(r.score)) + "%");
        return (
          '<tr>' +
            '<td>' + who + '</td>' +
            '<td>' + escapeHtml(r.lessonTitle) +
              '<span class="training-report-meta">' + escapeHtml(r.lessonId) + '</span></td>' +
            '<td>' + statusPillHtml(r.status) + '</td>' +
            '<td>' + score + '</td>' +
            '<td>' + escapeHtml(fmtCompletedAt(r)) + '</td>' +
          '</tr>'
        );
      }).join("");
      if (wrapEl) wrapEl.hidden = false;
      trainingReportLoaded = true;
    } catch (err) {
      console.error("[admin/training] load failed", err);
      if (loadingEl) loadingEl.hidden = true;
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = (err && err.code === "permission-denied")
          ? "Permission denied. You need an admin account to view training reports."
          : ("Couldn't load training progress: " + ((err && err.message) || "unknown error"));
      }
    }
  }

  // Refresh button — re-fetches even after first paint.
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("training-report-refresh");
    if (btn) btn.addEventListener("click", function () { loadTrainingReport(); });
  });
  // Acknowledge so the IIFE-scoped flag isn't reported as unused —
  // future code may check trainingReportLoaded to skip the auto-load
  // on subsequent tab clicks.
  void trainingReportLoaded;
})();
