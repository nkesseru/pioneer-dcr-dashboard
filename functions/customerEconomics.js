/* Pioneer DCR Hub — Customer Economics v1 (pure compute).
 *
 * Revenue Per Labor Hour (RPLH) for each active customer + company avg.
 * No I/O — caller hands in raw QB invoices, raw Pioneer sessions, and the
 * alias table; this module returns the snapshot doc ready to write to
 * Firestore.
 *
 * Hard rules (locked by Nick):
 *   • Labor sources INCLUDED:  cleaning (labor_type === 'cleaning' OR absent)
 *   • Labor sources EXCLUDED:  inspection, supply_station, hiring, training,
 *                              management (overhead — should not penalize
 *                              customer-level economics)
 *   • Minimum 10 labor hours / 30-day window. Below → excluded with
 *                              reason 'low_labor_signal'.
 *   • Up to 5 below-target recommendations, sorted by largest negative gap.
 *   • Target read from pioneer_config/customer_economics.target_rplh.
 *     If missing, fallback sentinel 62.
 *
 * Naming: ALWAYS "Customer Economics" + "Revenue Per Labor Hour".
 * NEVER "profitability" — overhead allocation is not included.
 */
"use strict";

const FALLBACK_TARGET_RPLH = 62;
const MIN_LABOR_HOURS      = 10;
const TOP_BOTTOM_COUNT     = 3;
const RECOMMENDATION_COUNT = 5;

/* ----------------------------- Helpers ----------------------------- */

// Normalize a customer-name-ish string into a stable key. Used both for
// QB customer matching and Pioneer customer matching, so the two sides
// land on the same key when names agree.
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function roundCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function roundHours(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/* ----------------------------- Aggregators ----------------------------- */

// Group QB invoices → revenue per customer. Returns map keyed by QBO
// customer id, with { qbo_id, qbo_name, normalized_name, revenue_30d }.
function aggregateRevenueByCustomer(invoices, customersById) {
  const out = {};
  (invoices || []).forEach(function (inv) {
    const ref = inv && inv.CustomerRef;
    const qboId = ref && (ref.value || ref.Value);
    if (!qboId) return;
    const amount = Number(inv.TotalAmt || 0);
    if (!Number.isFinite(amount)) return;
    const cust = customersById[qboId] || null;
    const name = (cust && (cust.DisplayName || cust.CompanyName)) || (ref && ref.name) || "";
    if (!out[qboId]) {
      out[qboId] = {
        qbo_id:          String(qboId),
        qbo_name:        String(name),
        normalized_name: normalizeName(name),
        revenue_30d:     0,
        invoice_count:   0
      };
    }
    out[qboId].revenue_30d += amount;
    out[qboId].invoice_count += 1;
  });
  return out;
}

// Group Pioneer sessions → labor hours per Pioneer customer_id (slug).
// Filters to cleaning labor only. Returns map keyed by customer_id with
// { pioneer_slug, pioneer_name, normalized_name, labor_hours_30d }.
function aggregateLaborByCustomer(sessions) {
  const out = {};
  (sessions || []).forEach(function (s) {
    if (!s) return;
    // Cleaning only — labor_type === 'cleaning' OR absent (legacy default).
    const lt = String(s.labor_type || "cleaning").toLowerCase();
    if (lt !== "cleaning") return;
    // Status must be completed (not active/paused/dcr_pending).
    if (s.status && s.status !== "completed") return;
    const cid = String(s.customer_id || "").trim();
    if (!cid) return;
    // Pioneer's canonical labor minutes field — fall back to work_minutes,
    // then to (clock_out_at − clock_in_at) if neither is set.
    let minutes = 0;
    if (typeof s.paid_minutes === "number" && s.paid_minutes > 0) {
      minutes = s.paid_minutes;
    } else if (typeof s.work_minutes === "number" && s.work_minutes > 0) {
      minutes = s.work_minutes;
    } else if (s.clock_in_at && s.clock_out_at) {
      const inMs  = s.clock_in_at.toMillis  ? s.clock_in_at.toMillis()  : 0;
      const outMs = s.clock_out_at.toMillis ? s.clock_out_at.toMillis() : 0;
      if (outMs > inMs) minutes = (outMs - inMs) / 60000;
    }
    if (!Number.isFinite(minutes) || minutes <= 0) return;

    if (!out[cid]) {
      const name = String(s.customer_name || cid);
      out[cid] = {
        pioneer_slug:    cid,
        pioneer_name:    name,
        normalized_name: normalizeName(name),
        labor_hours_30d: 0,
        session_count:   0
      };
    }
    out[cid].labor_hours_30d += minutes / 60;
    out[cid].session_count += 1;
  });
  return out;
}

/* ----------------------------- Join + match ----------------------------- */

// aliasMap shape (from customer_aliases collection): typically docs keyed
// by either Pioneer slug or QB name, with cross-links. We accept any of
// these field name patterns and build a unified lookup keyed by
// normalized name.
function buildAliasIndex(aliasDocs) {
  const byNormQbo = {};       // normalized QB name → pioneer_slug
  const byNormPioneer = {};   // normalized Pioneer name → qbo name
  (aliasDocs || []).forEach(function (a) {
    if (!a) return;
    const qboName    = a.qbo_name || a.qbo_display_name || a.quickbooks_name || "";
    const pioneerSlug = a.pioneer_slug || a.customer_slug || a.slug || a._id || "";
    const pioneerName = a.pioneer_name || a.customer_name || a.display_name || "";
    if (qboName && pioneerSlug) {
      byNormQbo[normalizeName(qboName)] = String(pioneerSlug);
    }
    if (pioneerName && qboName) {
      byNormPioneer[normalizeName(pioneerName)] = String(qboName);
    }
  });
  return { byNormQbo: byNormQbo, byNormPioneer: byNormPioneer };
}

// Match QB-revenue map to Pioneer-labor map. Each output entry is a
// merged "customer" record with both sides populated, or one side null
// when there's no match. The caller applies exclusion rules.
function joinRevenueAndLabor(revenueByQbo, laborBySlug, aliasIndex) {
  // Build by-normalized-name index over Pioneer labor map.
  const laborByNorm = {};
  Object.keys(laborBySlug).forEach(function (slug) {
    const row = laborBySlug[slug];
    laborByNorm[row.normalized_name] = row;
  });

  const matched = [];
  const usedSlugs = {};

  Object.keys(revenueByQbo).forEach(function (qboId) {
    const r = revenueByQbo[qboId];
    let labor = null;

    // 1. Direct normalized-name match.
    if (laborByNorm[r.normalized_name]) {
      labor = laborByNorm[r.normalized_name];
    }
    // 2. Alias: QB → Pioneer slug.
    if (!labor && aliasIndex.byNormQbo[r.normalized_name]) {
      const targetSlug = aliasIndex.byNormQbo[r.normalized_name];
      if (laborBySlug[targetSlug]) labor = laborBySlug[targetSlug];
    }

    if (labor) usedSlugs[labor.pioneer_slug] = true;

    matched.push({
      qbo_id:           r.qbo_id,
      qbo_name:         r.qbo_name,
      pioneer_slug:     labor ? labor.pioneer_slug : null,
      pioneer_name:     labor ? labor.pioneer_name : null,
      revenue_30d:      roundCents(r.revenue_30d),
      labor_hours_30d:  labor ? roundHours(labor.labor_hours_30d) : 0,
      invoice_count:    r.invoice_count,
      session_count:    labor ? labor.session_count : 0
    });
  });

  // Pioneer-only entries (have labor but no QB revenue — billing gap).
  Object.keys(laborBySlug).forEach(function (slug) {
    if (usedSlugs[slug]) return;
    const row = laborBySlug[slug];
    matched.push({
      qbo_id:          null,
      qbo_name:        null,
      pioneer_slug:    row.pioneer_slug,
      pioneer_name:    row.pioneer_name,
      revenue_30d:     0,
      labor_hours_30d: roundHours(row.labor_hours_30d),
      invoice_count:   0,
      session_count:   row.session_count
    });
  });

  return matched;
}

/* ----------------------------- Exclusions ----------------------------- */

// Apply exclusion rules. Returns { included, excluded } — each excluded
// entry has { name, reason, revenue_30d, labor_hours_30d }.
function applyExclusions(joined) {
  const included = [];
  const excluded = [];
  joined.forEach(function (c) {
    const name = c.qbo_name || c.pioneer_name || "(unknown)";
    if (!c.qbo_id) {
      excluded.push({
        name: name, reason: "no_qbo_mapping",
        revenue_30d: c.revenue_30d, labor_hours_30d: c.labor_hours_30d
      });
      return;
    }
    if (!c.pioneer_slug) {
      excluded.push({
        name: name, reason: "no_pioneer_mapping",
        revenue_30d: c.revenue_30d, labor_hours_30d: c.labor_hours_30d
      });
      return;
    }
    if (c.labor_hours_30d <= 0) {
      excluded.push({
        name: name, reason: "no_labor",
        revenue_30d: c.revenue_30d, labor_hours_30d: 0
      });
      return;
    }
    if (c.labor_hours_30d < MIN_LABOR_HOURS) {
      excluded.push({
        name: name, reason: "low_labor_signal",
        revenue_30d: c.revenue_30d, labor_hours_30d: c.labor_hours_30d
      });
      return;
    }
    if (c.revenue_30d <= 0) {
      excluded.push({
        name: name, reason: "unbilled",
        revenue_30d: 0, labor_hours_30d: c.labor_hours_30d
      });
      return;
    }
    included.push(c);
  });
  return { included: included, excluded: excluded };
}

/* ----------------------------- RPLH ----------------------------- */

function computeRplh(included, targetRplh) {
  return included.map(function (c) {
    const rplh = c.revenue_30d / c.labor_hours_30d;
    const gap = rplh - targetRplh;
    const requiredRevenue   = targetRplh * c.labor_hours_30d;
    const requiredHours     = c.revenue_30d / targetRplh;
    return Object.assign({}, c, {
      rplh:                       Math.round(rplh * 100) / 100,
      gap_to_target:              Math.round(gap * 100) / 100,
      required_monthly_increase:  gap >= 0 ? 0 : Math.round((requiredRevenue - c.revenue_30d) * 100) / 100,
      required_labor_reduction:   gap >= 0 ? 0 : Math.round((c.labor_hours_30d - requiredHours) * 10) / 10,
      status:                     gap >= 0 ? "at_or_above" : "below"
    });
  });
}

/* ----------------------------- Company summary ----------------------------- */

function computeCompanySummary(scored, targetRplh) {
  let totalRevenue = 0;
  let totalHours   = 0;
  let belowCount   = 0;
  let aboveCount   = 0;
  scored.forEach(function (c) {
    totalRevenue += c.revenue_30d;
    totalHours   += c.labor_hours_30d;
    if (c.status === "below") belowCount++; else aboveCount++;
  });
  const avgRplh = totalHours > 0 ? (totalRevenue / totalHours) : 0;
  const gap = avgRplh - targetRplh;

  // Improvement Summary — what would it take to lift the COMPANY average
  // to target? Two levers, same math as per-customer.
  const requiredRevenue = targetRplh * totalHours;
  const requiredHours   = totalRevenue / targetRplh;

  return {
    total_revenue:                roundCents(totalRevenue),
    total_labor_hours:            roundHours(totalHours),
    avg_rplh:                     Math.round(avgRplh * 100) / 100,
    gap_to_target:                Math.round(gap * 100) / 100,
    customers_below_target:       belowCount,
    customers_at_or_above_target: aboveCount,
    improvement_required_monthly_increase: gap >= 0 ? 0 : Math.round((requiredRevenue - totalRevenue) * 100) / 100,
    improvement_required_labor_reduction:  gap >= 0 ? 0 : Math.round((totalHours - requiredHours) * 10) / 10
  };
}

/* ----------------------------- Top / Bottom / Recommendations ----------------------------- */

function pickTopCustomers(scored, n) {
  return scored.slice().sort(function (a, b) { return b.rplh - a.rplh; }).slice(0, n);
}

function pickBottomCustomers(scored, n) {
  return scored.slice().sort(function (a, b) { return a.rplh - b.rplh; }).slice(0, n);
}

function pickRecommendations(scored, n) {
  // Below-target only, sorted by largest negative gap first.
  return scored
    .filter(function (c) { return c.status === "below"; })
    .sort(function (a, b) { return a.gap_to_target - b.gap_to_target; })
    .slice(0, n);
}

/* ----------------------------- Public API ----------------------------- */

// Build the full customer_economics/current doc shape, ready to write.
// Inputs:
//   • targetRplh             number — read from pioneer_config (or fallback)
//   • qboCustomers           array — QB Customer entities (Active = true)
//   • qboInvoices            array — QB Invoice entities (in window)
//   • pioneerSessions        array — pioneer_service_sessions docs (in window)
//   • aliasDocs              array — customer_aliases docs
//   • periodStartYmd, periodEndYmd  — strings "YYYY-MM-DD"
function buildSnapshot(opts) {
  const targetRplh = Number(opts.targetRplh) > 0 ? Number(opts.targetRplh) : FALLBACK_TARGET_RPLH;

  // Index QB customers by Id for revenue join.
  const customersById = {};
  (opts.qboCustomers || []).forEach(function (c) {
    if (c && c.Id) customersById[c.Id] = c;
  });

  const revenueByQbo = aggregateRevenueByCustomer(opts.qboInvoices || [], customersById);
  const laborBySlug  = aggregateLaborByCustomer(opts.pioneerSessions || []);
  const aliasIndex   = buildAliasIndex(opts.aliasDocs || []);

  const joined = joinRevenueAndLabor(revenueByQbo, laborBySlug, aliasIndex);
  const split  = applyExclusions(joined);
  const scored = computeRplh(split.included, targetRplh);
  const company = computeCompanySummary(scored, targetRplh);

  return {
    snapshot_date:       opts.periodEndYmd,
    period:              "trailing_30d",
    period_start:        opts.periodStartYmd,
    period_end:          opts.periodEndYmd,
    target_rplh:         targetRplh,
    overhead_included:   false,
    label:               "Customer Economics",
    subtitle:            "Revenue Per Labor Hour",
    disclosure:          "Not profitability. Overhead allocation not included.",

    company: company,

    top_customers:    pickTopCustomers(scored, TOP_BOTTOM_COUNT),
    bottom_customers: pickBottomCustomers(scored, TOP_BOTTOM_COUNT),
    recommendations:  pickRecommendations(scored, RECOMMENDATION_COUNT),

    customer_count_included: scored.length,
    customer_count_excluded: split.excluded.length,
    excluded_customers:      split.excluded,

    source_notes: {
      revenue_source:        "quickbooks_online_invoices",
      labor_source:          "pioneer_service_sessions",
      labor_types_included:  ["cleaning"],
      labor_types_excluded:  ["inspection", "supply_station", "hiring", "training", "management"],
      mapping_source:        "customer_aliases + normalized_name",
      minimum_labor_hours:   MIN_LABOR_HOURS,
      overhead_included:     false
    }
  };
}

module.exports = {
  FALLBACK_TARGET_RPLH,
  MIN_LABOR_HOURS,
  normalizeName,
  aggregateRevenueByCustomer,
  aggregateLaborByCustomer,
  buildAliasIndex,
  joinRevenueAndLabor,
  applyExclusions,
  computeRplh,
  computeCompanySummary,
  pickTopCustomers,
  pickBottomCustomers,
  pickRecommendations,
  buildSnapshot
};
