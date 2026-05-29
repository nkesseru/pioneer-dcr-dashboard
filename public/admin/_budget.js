/* Pioneer DCR Hub — Admin DCR budget analytics (vanilla JS, no build).
 *
 * Pure analytics over the in-memory `dcrs` cache. No DOM access except
 * via the shared badge() helper for the row pill. No Firestore reads.
 *
 *   • getOnBudget(doc)           — schema-tolerant on/over/unknown reader.
 *                                   Mirrors the same-name server helper in
 *                                   functions/index.js — admin and tech-hub
 *                                   metrics must agree on classification.
 *   • dcrTsToMs(ts)              — Firestore-tolerant timestamp → ms reader.
 *                                   Mirrors server twin.
 *   • emptyBucket()              — { on, over, total, unknown } skeleton.
 *   • computeBudgetStats(dcrs,
 *                       filter)  — slices the passed-in dcrs array (caller
 *                                   owns the cache) and returns the 4-window
 *                                   breakdown {last_clean, last_7d,
 *                                   this_month, all_time}. No async, no
 *                                   extra reads. Empty windows return null
 *                                   so the UI shows "—" instead of 0%.
 *   • budgetRowBadge(stats)      — compact MTD-on-budget pill markup.
 *   • budgetTooltipText(stats)   — plain-text 4-line summary for title="…".
 *
 * Surface lives at window.__pioneerAdmin.budget. Loaded AFTER admin/_utils.js
 * + admin/_shell.js and BEFORE admin.js.
 *
 * Note on the dcrs parameter:
 *   Pre-refactor, computeBudgetStats(filter) read an IIFE-closure `dcrs`
 *   array. That hidden state coupled this helper to admin.js's load order.
 *   The new signature passes dcrs explicitly so the helper is referentially
 *   transparent and testable in isolation.
 *
 * Future: when dcrs.length consistently exceeds the 500-doc cap, replace
 * this with a server-aggregated metrics doc + a single read at boot.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.shell) {
    throw new Error("admin/_budget.js: admin/_shell.js (and _utils.js) must load first");
  }
  const { badge } = window.__pioneerAdmin.shell;

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
  function computeBudgetStats(dcrs, filter) {
    if (!Array.isArray(dcrs) || dcrs.length === 0) {
      return { last_clean: null, last_7d: null, this_month: null, all_time: null };
    }
    const now = Date.now();
    const sevenAgo  = now - 7 * 24 * 60 * 60 * 1000;
    const monthStart = (function () {
      const d = new Date(now);
      // Local-month boundary so MTD lines up with how the office reads it.
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    })();

    const wantSlug = String((filter && filter.slug) || "").toLowerCase().trim();
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

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.budget = {
    getOnBudget: getOnBudget,
    dcrTsToMs: dcrTsToMs,
    emptyBucket: emptyBucket,
    computeBudgetStats: computeBudgetStats,
    budgetRowBadge: budgetRowBadge,
    budgetTooltipText: budgetTooltipText
  };
}());
