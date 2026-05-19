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

  // The DCR list cap doubles as our analytics window. 500 covers ~6 months
  // for a typical 80-clean-per-week org and lets us compute Last 7d / MTD /
  // "All-time" (defined as the loaded window) without any extra Firestore
  // reads. Future: replace with a server-aggregated `dcr_metrics_cache`
  // document once dataset growth makes 500-doc pulls expensive.
  const DCR_RECENT_LIMIT = 500;

  /* =====================================================================
     ADMIN ACCESS CONTROL — single-source-of-truth allowlist
     =====================================================================
     Add or remove emails here. Comparison is case-insensitive — the values
     below are normalised to lower-case on read. After editing, redeploy
     hosting (no function/rules redeploy needed).

     If you ever swap to a custom-claims auth model, this list becomes the
     seed for whoever runs `setCustomUserClaims({admin: true})` server-side.
     ===================================================================== */
  const ALLOWED_ADMIN_EMAILS = [
    "nick@pioneercomclean.com",
    "april@pioneercomclean.com",
    "kirby@pioneercomclean.com",
    "mgies@pioneercomclean.com"
  ];

  // Synchronous "root admin" check — for callers that need a snap
  // decision and are OK only matching the hardcoded list. Used as the
  // optimistic first-pass during auth state changes; full check goes
  // through resolveAdminStatus() below.
  function isRootAdmin(email) {
    if (!email) return false;
    const normalized = email.toLowerCase().trim();
    return ALLOWED_ADMIN_EMAILS.some(function (e) {
      return e.toLowerCase().trim() === normalized;
    });
  }

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

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatTimestamp(ts) {
    if (!ts) return "—";
    try {
      // Firestore Timestamp shape: { seconds, nanoseconds } OR a Timestamp obj.
      if (typeof ts.toDate === "function") return ts.toDate().toLocaleString();
      if (typeof ts === "object" && typeof ts.seconds === "number") {
        return new Date(ts.seconds * 1000).toLocaleString();
      }
      if (typeof ts === "string") return new Date(ts).toLocaleString();
    } catch (e) { /* fall through */ }
    return String(ts);
  }

  /* ---------- defensive field accessors ---------- */

  function getCustomerName(c)     { return c.customer_name  || c.name         || c.display_name || ""; }
  function getCustomerSlug(c)     { return c.customer_slug  || c.slug         || c.id          || ""; }
  function getCustomerEmail(c)    { return c.customer_email || c.email        || ""; }
  function getCustomerLocation(c) { return c.location_name  || c.location     || ""; }
  function getActive(c)           { return c.active !== false; }                  // default true
  function getDcrEnabled(c)       { return c.dcr_enabled !== false; }             // default true
  // Customer-only — controls customer-facing DCR EMAIL delivery downstream.
  // Distinct from getDcrEnabled (form visibility). Both default true when
  // the field is missing, preserving existing behaviour.
  function getDcrEmailEnabled(c)  { return c.dcr_email_enabled !== false; }       // default true

  function getTechName(t)         { return t.display_name || t.tech_display_name || t.name || ""; }
  function getTechSlug(t)         { return t.tech_slug    || t.slug              || t.id   || ""; }

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

  /* ---------- tab wiring ---------- */

  function wireTabs() {
    $$(".admin-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        const name = tab.dataset.tab;
        $$(".admin-tab").forEach(function (t) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        $$(".admin-panel").forEach(function (p) {
          p.hidden = p.dataset.panel !== name;
        });
      });
    });
  }

  /* ---------- shared panel state UI ---------- */

  function setStatus(panelKey, state, message) {
    ["loading", "error", "empty"].forEach(function (k) {
      const el = $(`${panelKey}-${k}`);
      if (el) el.hidden = k !== state;
    });
    if (state === "error" && message) {
      const errEl = $(`${panelKey}-error`);
      if (errEl) errEl.textContent = message;
    }
  }
  function hideAllStatuses(panelKey) {
    ["loading", "error", "empty"].forEach(function (k) {
      const el = $(`${panelKey}-${k}`);
      if (el) el.hidden = true;
    });
  }
  function showFatal(msg) {
    document.body.innerHTML =
      '<div class="admin-status admin-error" style="margin:40px auto;max-width:520px;">' +
        escapeHtml(msg) +
      '</div>';
  }

  /* ---------- badge helpers ---------- */

  function badge(cls, label) {
    return '<span class="badge ' + cls + '">' + escapeHtml(label) + '</span>';
  }
  function activeBadge(isActive)     { return isActive ? badge("is-on", "Active")      : badge("is-off", "Archived"); }
  function dcrEnabledBadge(enabled)  { return enabled  ? badge("is-on", "DCR enabled") : badge("is-off", "DCR off"); }
  // Three distinct states must be readable at a glance: Active/Archived,
  // DCR on/off (form visibility), DCR EMAIL on/off (customer-email delivery).
  // The badge label spells it out so the difference between DCR and DCR-email
  // is unambiguous to a sleep-deprived ops admin scanning the list.
  function dcrEmailBadge(enabled)    { return enabled  ? badge("is-on", "DCR email on") : badge("is-off", "DCR email off"); }

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

  function renderCustomers(list) {
    const root = $("customer-list");
    const cnt  = $("customer-count");
    if (!root) return;
    if (cnt)  cnt.textContent = list.length + ' customer' + (list.length === 1 ? '' : 's');
    root.innerHTML = list.map(customerCard).join("");
    if (list.length === 0 && customers.length === 0) setStatus("customer", "empty");
    else hideAllStatuses("customer");
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

    const badges =
      activeBadge(active) +
      dcrEnabledBadge(enabled) +
      (needsAssign ? badge("is-warn", "Needs assignments") : "") +
      budgetBadgeHtml;

    // Archive label flips for archived rows. (archiveExtraCls is no
    // longer needed — Archive lives inside the overflow menu now, and
    // .row-overflow-item-warn handles the color affordance.)
    const archiveLabel = active ? "Archive" : "Reactivate";

    // Account-status hint: when the last invite/reset was sent. Shows
    // "—" when never invited. Reinvite button appears only on active
    // techs with an email (no point resending to archived accounts or
    // rows missing the email field).
    const email     = (t.email || "").toLowerCase().trim();
    const lastSent  = t.last_invite_sent_at || t.last_reset_sent_at;
    const lastSentTxt = lastSent ? formatTimestamp(lastSent) : "—";
    const canResend = active && !!email;

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
        '<div class="row-primary">' +
          '<span class="row-name">' + escapeHtml(name) + '</span>' +
          '<span class="row-sub">'  + escapeHtml(slug || "—") + '</span>' +
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
          // Secondary action — only when actually possible.
          (canResend
            ? '<button class="row-btn row-btn-secondary" type="button" data-action="resend"' +
                ' title="Send a fresh password-reset email to this tech">Reinvite</button>'
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
      '<div class="admin-row" role="listitem">' +
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
     Phase 2 normalization: paints into the shared .kpi-card + .health-card
     foundation. Same set of in-memory caches as before — no new data
     loads on the critical path. The Zapier-failures signal moved out of
     the visible strip and into the Day Health checklist so the six KPI
     tiles match the normalized spec.

     Inspections-this-week is filled by loadInspectionsThisWeekCount()
     asynchronously after the page is interactive; until it lands, the
     tile shows "—" with the meta line "Last 7 days". */
  let inspectionsThisWeekCount = null;  // null = not yet loaded, number = resolved

  function refreshAttentionStrip() {
    function paintCount(id, n, tone) {
      const el = $(id);
      if (!el) return;
      el.textContent = String(n);
      // Apply tone to the surrounding .kpi-card so the left rail
      // reflects severity. The card uses data-tone, set on the
      // closest .kpi-card ancestor.
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
    const zFailed = dcrs.filter(function (d) {
      return d && d.zapier && d.zapier.status === "failed";
    }).length;
    const emailOff = customers.filter(function (c) {
      return getActive(c) && getDcrEmailEnabled(c) === false;
    }).length;
    const needsAssign = techs.filter(function (t) {
      const assigned = Array.isArray(t.assigned_customer_slugs) ? t.assigned_customer_slugs : [];
      return getActive(t) && assigned.length === 0;
    }).length;

    // -- Paint the 4 cache-driven KPIs --
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

    // -- Day Health card --
    refreshAdminDayHealth({
      newIssues:   newIssues,
      openSupply:  openSupply,
      zFailed:     zFailed,
      emailOff:    emailOff,
      needsAssign: needsAssign
    });
  }

  /* ---------- Day Health (admin) ----------
     Tone:
       healthy   — every operational signal is zero
       attention — any of newIssues / needsAssign / zFailed > 0
       healthy   — soft signals only (emailOff / openSupply > 0)
                   because those are routine ops, not red flags. */
  function refreshAdminDayHealth(c) {
    const card    = $("admin-day-health");
    const titleEl = $("admin-day-health-title");
    const sumEl   = $("admin-day-health-summary");
    if (!card || !titleEl || !sumEl) return;

    const totalSignals = c.newIssues + c.openSupply + c.zFailed + c.emailOff + c.needsAssign;
    let status, title;
    if (totalSignals === 0) {
      status = "healthy";
      title  = "Everything looks stable today.";
    } else if (c.zFailed > 0 || c.newIssues > 0 || c.needsAssign > 0) {
      status = "attention";
      const bits = [];
      if (c.newIssues   > 0) bits.push(c.newIssues   + " new issue"     + (c.newIssues   === 1 ? "" : "s"));
      if (c.zFailed     > 0) bits.push(c.zFailed     + " Zapier failure" + (c.zFailed    === 1 ? "" : "s"));
      if (c.needsAssign > 0) bits.push(c.needsAssign + " tech"           + (c.needsAssign === 1 ? "" : "s") + " unassigned");
      title = bits.slice(0, 2).join(" · ") + ((bits.length > 2) ? " · …" : ".");
    } else {
      status = "healthy";
      title  = "Day is on track — a few routine signals to review.";
    }
    card.setAttribute("data-status", status);
    titleEl.textContent = title;

    // Operational summary line — counts the user can confirm visually
    // against the KPI strip below.
    const sumBits = [];
    sumBits.push(customers.length + " customers");
    sumBits.push(techs.length + " techs");
    sumBits.push(dcrs.length + " DCRs in window");
    if (totalSignals === 0) sumBits.push("0 open signals");
    else                    sumBits.push(totalSignals + " open signals");
    sumEl.textContent = sumBits.join(" · ");

    // Checklist states.
    const liAssign = $("admin-day-health-li-assigned");
    const liDcr    = $("admin-day-health-li-dcr");
    const liIssues = $("admin-day-health-li-issues");
    if (liAssign) {
      liAssign.setAttribute("data-state", c.needsAssign === 0 ? "ok" : "watch");
      liAssign.textContent = c.needsAssign === 0
        ? "All active techs assigned"
        : (c.needsAssign + " active tech" + (c.needsAssign === 1 ? "" : "s") + " unassigned");
    }
    if (liDcr) {
      liDcr.setAttribute("data-state", c.zFailed === 0 ? "ok" : "block");
      liDcr.textContent = c.zFailed === 0
        ? "DCR delivery healthy"
        : (c.zFailed + " Zapier delivery failure" + (c.zFailed === 1 ? "" : "s"));
    }
    if (liIssues) {
      liIssues.setAttribute("data-state", c.newIssues === 0 ? "ok" : "watch");
      liIssues.textContent = c.newIssues === 0
        ? "No new operational issues"
        : (c.newIssues + " new operational issue" + (c.newIssues === 1 ? "" : "s") + " open");
    }
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

  /* =====================================================================
     Global search — proxies the active tab's per-tab .admin-search input
     =====================================================================
     Each major panel already owns a search input (#customer-search,
     #tech-search, #dcr-search, #issues-search, #supply-search,
     #recoveries-search, #notes-search, #announcements-search,
     #admins-search). The global input dispatches keystrokes onto
     whichever one matches the active tab — so every keystroke runs the
     same filter logic the per-tab box does, with no new code path.

     Tabs without a per-tab search (#suggestions / #feed / #training /
     #deputy) get a friendly hint and the input is disabled. */
  const GLOBAL_SEARCH_TARGETS = {
    customers:     { id: "customer-search",      label: "Customers" },
    techs:         { id: "tech-search",          label: "Cleaning Techs" },
    dcrs:          { id: "dcr-search",           label: "Recent DCRs" },
    issues:        { id: "issues-search",        label: "Issues" },
    supply:        { id: "supply-search",        label: "Supply Requests" },
    recoveries:    { id: "recoveries-search",    label: "Service Recoveries" },
    notes:         { id: "notes-search",         label: "Customer Notes" },
    announcements: { id: "announcements-search", label: "Announcements" },
    admins:        { id: "admins-search",        label: "Admins" }
  };

  function getActiveTabKey() {
    const t = document.querySelector(".admin-tab.is-active[data-tab]");
    return t ? t.dataset.tab : "customers";
  }

  function updateGlobalSearchHint() {
    const hintEl  = $("admin-global-search-hint");
    const inputEl = $("admin-global-search-input");
    if (!hintEl || !inputEl) return;
    const targetMeta = GLOBAL_SEARCH_TARGETS[getActiveTabKey()];
    if (targetMeta) {
      hintEl.textContent = "Filtering: " + targetMeta.label;
      inputEl.disabled = false;
      inputEl.placeholder = "Search " + targetMeta.label.toLowerCase() + "…";
    } else {
      hintEl.textContent = "No search on this tab";
      inputEl.disabled = true;
      inputEl.placeholder = "Search customers, techs, DCRs…";
    }
  }

  function wireGlobalSearch() {
    const inputEl = $("admin-global-search-input");
    if (!inputEl) return;
    inputEl.addEventListener("input", function () {
      const targetMeta = GLOBAL_SEARCH_TARGETS[getActiveTabKey()];
      if (!targetMeta) return;
      const target = $(targetMeta.id);
      if (!target) return;
      target.value = inputEl.value;
      // Dispatch a synthetic input event so the existing per-tab
      // listener (wireSearch / wireSupplyControls / etc.) runs.
      try { target.dispatchEvent(new Event("input", { bubbles: true })); }
      catch (_e) { /* old browsers fall back silently */ }
    });
    // Initial hint paint.
    updateGlobalSearchHint();
    // Update the hint whenever the user activates a different tab. We
    // hook into the existing tab click bar rather than introduce a new
    // observer — activateTab() already mutates the .is-active class on
    // the matching button.
    const tabsBar = document.querySelector(".admin-tabs-grouped");
    if (tabsBar) {
      tabsBar.addEventListener("click", function (ev) {
        if (!ev.target.closest(".admin-tab[data-tab]")) return;
        // tab classes flip synchronously; defer one tick to read post-flip.
        setTimeout(updateGlobalSearchHint, 0);
      });
    }
  }

  // Helper for programmatic tab activation. Mirrors the click handler
  // already wired by wireTabs() — toggles is-active + the panel hidden
  // attribute. Defensive null-checks so a missing tab is a no-op.
  function activateTab(tabKey) {
    const tabs   = document.querySelectorAll(".admin-tab[data-tab]");
    const panels = document.querySelectorAll(".admin-panel[data-panel]");
    tabs.forEach(function (t) {
      const on = (t.dataset.tab === tabKey);
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach(function (p) {
      p.hidden = (p.dataset.panel !== tabKey);
    });
    // First activation of the Operational Feed tab — mount the
    // shared renderer with admin permissions + status filter.
    if (tabKey === "feed")     mountOperationalFeedOnce();
    // Training reports are lazy-loaded on first tab open and refreshed
    // on the Refresh button. Idempotent.
    if (tabKey === "training") loadTrainingReport();
    // Keep the ops-overview global search hint synced with the
    // newly-active tab. No-op if wireGlobalSearch hasn't fired yet.
    if (typeof updateGlobalSearchHint === "function") updateGlobalSearchHint();
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
        '<div class="announcement-actions">' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          '<button class="row-btn" type="button" data-action="archive">' + archiveLabel + '</button>' +
        '</div>' +
      '</article>'
    );
  }

  function renderAnnouncements(list) {
    const root = $("announcements-list");
    const cnt  = $("announcements-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + " announcement" + (list.length === 1 ? "" : "s");
    root.innerHTML = list.map(announcementCardHtml).join("");
    if (list.length === 0 && announcements.length === 0) setStatus("announcements", "empty");
    else hideAllStatuses("announcements");
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
          audience_type:           "all_staff",
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
      });
    }
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

      // Server returned ok:true but sent:false means it didn't find a
      // Firebase Auth user for this email. That's a real failure in
      // the admin context — surface it actionably.
      if (body.sent === false) {
        const reason = body.reason || "unknown";
        const msg = "No Firebase Auth user exists for " + emailLower +
          " (reason: " + reason + "). " +
          "Open the tech / admin row and use 'Add tech / Login setup' (or 'Add admin') " +
          "to provision a Firebase Auth user first.";
        console.warn("sendPasswordResetV1 returned ok but sent:false", body);
        showToast("err", "Resend skipped — no Firebase Auth user for " + emailLower + ".");
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
      const msg = "Reset email sent to " + emailLower +
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

  // ---- Cleaning tech: archive / reactivate ----

  async function onTechArchive(t) {
    const name        = getTechName(t) || t.id;
    const isArchiving = getActive(t);
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
      await db.collection("cleaning_techs").doc(t.id).update(updates);
      const idx = techs.findIndex(function (x) { return x.id === t.id; });
      if (idx >= 0) {
        techs[idx] = Object.assign({}, techs[idx], updates, {
          updated_at:  new Date(),
          archived_at: isArchiving ? new Date() : null
        });
      }
      applyCurrentTechFilter();
      showToast("ok", isArchiving ? "Tech archived." : "Tech reactivated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "tech archive" });
    }
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
        if (action === "archive") onTechArchive(t);
        if (action === "delete")  onTechDelete(t);
        if (action === "resend") {
          const email = (t.email || "").toLowerCase().trim();
          if (email) sendResetInviteFor(email, null);
        }
        if (action === "promote") promoteTechToAdmin(t);
      });
    }

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
    wireSearch();
    wireGlobalSearch();
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
