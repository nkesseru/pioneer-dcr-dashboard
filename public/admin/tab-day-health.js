/* Pioneer DCR Hub — Admin Day Health / Attention Strip / Today's Ops module
 * (vanilla JS, no build).
 *
 * V6 native PioneerOps rewrite. "Today's Operations" now reads from the
 * native DCR pipeline (dcr_email_payloads + customer_feedback +
 * customer_complaints) instead of the dead Zapier delivery layer.
 *
 * Counts on the bottom KPI strip still come from the existing in-memory
 * caches (customers, techs, dcrs, supplyRequests, dcrIssues) read via
 * the __pioneerAdmin.deps bridge — no critical-path query change. The
 * Today's Operations card adds two lightweight ops-day-window queries,
 * soft-failed.
 *
 * ────────────────────────────────────────────────────────────────────
 * TODO — future signal sources for this card:
 *   • Email opens          tracking pixel on dcr_email_payloads → bump
 *                          a `openCount` field on the doc; render as
 *                          "Opens · 24h" + open-rate %.
 *   • Feedback CTA clicks  log a click event when feedback-compliment
 *                          / feedback-issue pages load with a dcrId.
 *                          Surface as "Feedback CTA clicks · 24h".
 *   • Portal link clicks   when the customer-facing portal lands,
 *                          count "View full report →" clicks
 *                          from the email footer.
 * Until those land, the card intentionally OMITS open-rate so we don't
 * display a misleading "0% open rate" when we're just not tracking
 * opens. Per the spec: "If we do not currently track opens, do NOT
 * fake it."
 *
 * Surface lives at window.__pioneerAdmin.tabs.dayHealth:
 *   {
 *     init,                     // wireAttentionStrip — clickable KPI tile dispatch
 *     refresh,                  // refreshAttentionStrip — sync repaint of KPI strip + day-health card
 *     refreshMetrics,           // refreshDayHealthMetricsOpsDay — async Firestore fetch + repaint
 *     loadInspectionsThisWeek   // loadInspectionsThisWeekCount — async one-shot KPI fetch + repaint
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getActive, getDcrEmailEnabled from __pioneerAdmin.utils
 *   • activateTab from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCustomers()
 *       - getTechs()
 *       - getDcrs()
 *       - getDcrIssues()
 *       - getSupplyRequests()
 *       - getOpsDayWindow(now, cutoffHour?, timezone?)  ← NEW bridge entry
 *   • window.firebase compat SDK (firestore)
 *
 * Consumers of this module:
 *   • admin.js loadDcrsAndRerenderDependents → tabs.dayHealth.refresh()
 *   • admin.js boot (auth-state-change) → loadInspectionsThisWeek + refreshMetrics
 *   • admin.js boot (DOMContentLoaded)  → init()
 *   • tabs.dcrIssues.onChange → deps.refreshAttentionStrip() → tabs.dayHealth.refresh()
 *   • Any other tab that mutates dcrs/customers/techs/supply/issues caches
 *     can call deps.refreshAttentionStrip() to repaint the dashboard.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-day-health.js: utils + shell modules must load first");
  }
  const { escapeHtml, getActive, getDcrEmailEnabled } = window.__pioneerAdmin.utils;
  const { activateTab } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-day-health: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCustomers       = () => depOrThrow("getCustomers")();
  const getTechs           = () => depOrThrow("getTechs")();
  const getDcrs            = () => depOrThrow("getDcrs")();
  const getDcrIssues       = () => depOrThrow("getDcrIssues")();
  const getSupplyRequests  = () => depOrThrow("getSupplyRequests")();
  const getOpsDayWindow    = window.__pioneerAdmin.utils.getOpsDayWindow;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let inspectionsThisWeekCount = null;  // null = not yet loaded, number = resolved

  // Ops-day-window metrics for the Today's Operations card. Replaces
  // the prior rolling-24h window with a Pioneer ops-day window that
  // resets at 4 PM Pacific (see getOpsDayWindow in admin.js). Queries
  // fetch BOTH the current ops day AND the previous one in a single
  // sweep: we ask Firestore for everything `>= previousOpsStart` and
  // bucket in memory, so we get the "Yesterday Review" counts for
  // free.
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
  // Legacy alias state — written but never read in the current codebase.
  // Preserved on purpose so any future caller that re-introduces
  // "dayHealth24h" sees the same shape it used to. Cheap, no behavior
  // change. Safe to remove later if confirmed unused.
  let dayHealth24h = {
    loaded:           false,
    emailsSent:       0,
    emailsFailed:     0,
    feedbackReceived: 0,
    queryError:       null
  };
  // Suppress no-unused-vars complaints by exposing for debug. Internal-only.
  void dayHealth24h;

  /* ---------- async Firestore metrics fetch ---------- */

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
  void refreshDayHealthMetrics24h;  // not exported by namespace; kept for callers via deps if ever needed

  /* ---------- Attention Strip — top-of-page KPI cards ---------- */

  function refreshAttentionStrip() {
    function paintCount(id, n, tone) {
      const el = $(id);
      if (!el) return;
      el.textContent = String(n);
      const card = el.closest(".kpi-card");
      if (card) card.setAttribute("data-tone", tone);
    }

    // -- Compute counts from in-memory caches --
    // dcrIssues       lives in tab-dcr-issues.js      (Phase 12); read via bridge.
    // customers       lives in tab-customers.js       (Phase 15); read via bridge.
    // techs           lives in tab-techs.js           (Phase 16a); read via bridge.
    // supplyRequests  lives in tab-supply-requests.js (Phase 18); read via bridge.
    const dcrIssues      = getDcrIssues();
    const customers      = getCustomers();
    const techs          = getTechs();
    const supplyRequests = getSupplyRequests();
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
    // enabled (the default unless an admin flipped it off). Mirrors
    // the same predicate the Customers tab uses for its row dim, so the
    // KPI number always matches what the office can see in the list.
    const linksActive = customers.filter(function (c) {
      if (!getActive(c))                  return false;
      if (getDcrEmailEnabled(c) === false) return false;
      return true;
    }).length;

    paintCount("kpi-new-issues",   newIssues,   newIssues   > 0 ? "attention" : "neutral");
    paintCount("kpi-open-supply",  openSupply,  openSupply  > 0 ? "attention" : "neutral");
    paintCount("kpi-email-off",    emailOff,    emailOff    > 0 ? "attention" : "neutral");
    paintCount("kpi-needs-assign", needsAssign, needsAssign > 0 ? "attention" : "neutral");

    // Inspections this week — async-loaded; show "—" while pending.
    const inspEl = $("kpi-inspections-week");
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

    // Ops-day-window snapshot for refreshAdminDayHealth. Computed each
    // refresh so the previous-ops-day comparison line stays accurate
    // even as the page sits open across the 4 PM cutoff. Counts here
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

      // Ops-day metrics from refreshDayHealthMetricsOpsDay (async):
      metricsLoaded:    dayHealthOps.loaded,
      metricsError:     dayHealthOps.queryError,
      window:           dayHealthOps.window,
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
      // Legacy fields — kept here so we don't need to fan out into
      // refreshAdminDayHealth — preserves call-site stability.
      emailsSent24h:    dayHealthOps.current.emailsSent,
      emailsFailed24h:  dayHealthOps.current.emailsFailed,
      feedback24h:      dayHealthOps.current.feedback,

      // Sumamry fields used by tone selector + headline:
      newIssues:        newIssues
    });
  }

  /* ---------- Today's Operations card painter ----------
   * V6 — native PioneerOps DCR pipeline metrics, no Zapier. Headline
   * stat row + four operational bullets. Card tone:
   *   healthy   — emails sent today, no failures, no new issues
   *   attention — any DCR email failure in the last 24h OR new issues
   *   neutral   — first paint before the 24h metrics finish loading. */
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
    void escapeHtml;  // utils import retained for parity with prior phases; not used by this painter
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

  /* ---------- Attention Strip — click dispatcher ---------- */

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

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.dayHealth = {
    init:                    wireAttentionStrip,
    refresh:                 refreshAttentionStrip,
    refreshMetrics:          refreshDayHealthMetricsOpsDay,
    loadInspectionsThisWeek: loadInspectionsThisWeekCount
  };
}());
