/* ============================================================================
 * financialPulse.js — pure functions that turn raw QBO + Pioneer data into
 * the CEO Dashboard's Financial Pulse snapshot.
 *
 * No I/O. Caller hands in:
 *   - bank accounts (QBO Account entity, AccountType="Bank")
 *   - balance sheet reports for today / 30d ago / 90d ago
 *   - open + overdue invoice rows
 *   - paid-in-window payment rows
 *   - last 2 Pioneer payroll_exports docs
 *   - today's date (YYYY-MM-DD, PT)
 *
 * Returns the snapshot doc shape consumed by ceo.js renderFinancialPulse().
 *
 * Design intent (CEO 30-second read):
 *   Q1 Are we safe?          → cash_today + cash_runway
 *   Q2 Are we growing?       → trend_30d + trend_90d
 *   Q3 Is ops healthy?       → existing Customer Economics card (separate)
 *   Q4 Is payroll safe?      → payroll snapshot
 *   Q5 What needs attention? → needs_nick (rule-derived)
 * ============================================================================ */

const COLLECTIONS_WATCH_LIMIT = 5;
const NEEDS_NICK_LIMIT        = 4;

// Bound the runway calc so a near-flat 90d delta doesn't produce a runway
// of "1,247 months." Anything over 24 months reads as "comfortable" to a
// CEO — the precision doesn't matter.
const RUNWAY_CEILING_MONTHS   = 24;

// Runway "burn" threshold — if monthly net is within +/- this many dollars
// of zero, we report runway as "stable" rather than computing a misleading
// large number.
const RUNWAY_FLAT_DOLLAR_BAND = 250;

// "Needs Nick" rule thresholds. Tunable here so future operators can shift
// them without changing rule code.
const NEEDS_NICK_RULES = {
  runway_low_months:           6,    // months — runway under this → flag
  overdue_alarm_dollars:       2500, // $ — single overdue >= this → flag the customer
  overdue_alarm_days:          30,   // days — any overdue >= this → flag
  payroll_close_warning_days:  5,    // days until cycle close → flag if blockers > 0
  stale_sync_hours:            36    // hours since last sync → flag staleness
};

/* ----------------------------- Small utilities ----------------------------- */

function toNum(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function ymdToDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return null;
  return new Date(ymd + "T12:00:00Z");
}
function daysBetweenYmd(earlier, later) {
  const a = ymdToDate(earlier);
  const b = ymdToDate(later);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function fmtSign(n) { return n > 0 ? "up" : (n < 0 ? "down" : "flat"); }

/* ----------------------------- BalanceSheet parser ----------------------------- */

// QBO BalanceSheet Report returns a hierarchical Rows.Row structure. The
// "Bank Accounts" total typically lives under ASSETS → Current Assets →
// Bank Accounts → Summary. Different QB Online accounts shape this slightly
// differently, so we walk the whole tree looking for the deepest summary
// that mentions "Bank" in its label and emit that value. If we can't find
// a bank-specific summary, fall back to summing all rows whose label
// contains "Bank" or "Cash". Defensive — Report API formats drift.
function extractCashFromBalanceSheet(report) {
  if (!report || !report.Rows) return null;
  // Walk every Row looking for a "Bank Accounts" / "Cash" summary line.
  // Each Row may have ColData (leaf), Summary (total), and Rows (children).
  let bestBankTotal = null;

  function walk(rowGroup) {
    if (!rowGroup || !rowGroup.Row) return;
    rowGroup.Row.forEach(function (r) {
      // Inspect summary line for this group, if any.
      if (r.Summary && r.Summary.ColData && r.Summary.ColData.length) {
        const label = String((r.Summary.ColData[0] || {}).value || "").toLowerCase();
        const last  = r.Summary.ColData[r.Summary.ColData.length - 1] || {};
        const amt   = toNum(last.value);
        if (label.indexOf("bank account") >= 0 ||
            label === "total bank accounts" ||
            label === "total cash" ||
            label.indexOf("bank") === 0) {
          // Prefer the first bank-specific summary we hit (depth-first
          // priority); QBO usually emits "Bank Accounts" before broader
          // asset totals.
          if (bestBankTotal == null) bestBankTotal = amt;
        }
      }
      if (r.Rows) walk(r.Rows);
    });
  }
  walk(report.Rows);
  return bestBankTotal;
}

/* ----------------------------- Bank accounts ----------------------------- */

function buildCashToday(bankAccounts, asOfYmd) {
  const list = (bankAccounts || []).map(function (a) {
    return {
      name:             String(a.Name || a.FullyQualifiedName || "Account"),
      current_balance:  toNum(a.CurrentBalance),
      account_type:     String(a.AccountType || ""),
      account_subtype:  String(a.AccountSubType || "")
    };
  });
  const total = list.reduce(function (acc, a) { return acc + a.current_balance; }, 0);
  return {
    accounts:           list,
    total_cash_on_hand: total,
    as_of_ymd:          asOfYmd,
    disclosure:         "QuickBooks ledger balance · not live bank-feed balance"
  };
}

/* ----------------------------- Cash trends ----------------------------- */

function buildTrend(currentTotal, priorTotal, currentYmd, priorYmd, includePercent) {
  if (priorTotal == null || !Number.isFinite(priorTotal)) {
    return {
      available:        false,
      delta_dollars:    null,
      delta_percent:    includePercent ? null : undefined,
      direction:        null,
      comparison_date:  priorYmd,
      reason:           "QuickBooks history unavailable for that date"
    };
  }
  const delta = currentTotal - priorTotal;
  const out = {
    available:        true,
    delta_dollars:    Math.round(delta * 100) / 100,
    direction:        fmtSign(delta),
    comparison_date:  priorYmd,
    source:           "qbo_balancesheet_report"
  };
  if (includePercent) {
    out.delta_percent = (priorTotal !== 0)
      ? Math.round((delta / priorTotal) * 1000) / 10
      : null;
  }
  return out;
}

/* ----------------------------- Cash runway ----------------------------- */

// Runway = current_cash / monthly_burn_rate.
// Monthly burn is derived from 90-day cash change:
//   monthly_net = (cash_today - cash_90d_ago) / 3
//   monthly_burn = max(0, -monthly_net)   // burn is only outflow
// Edge cases:
//   - 90d data missing → can't compute, return state "unknown"
//   - growing (net positive beyond band) → state "growing", months null
//   - near-flat (within band) → state "stable", months null
//   - burning → state "burning", months = current_cash / monthly_burn,
//     capped at RUNWAY_CEILING_MONTHS for display sanity
function buildCashRunway(cashToday, trend90d) {
  if (!trend90d.available || trend90d.delta_dollars == null) {
    return {
      months_remaining:    null,
      monthly_burn_rate:   null,
      monthly_net_change:  null,
      state:               "unknown",
      disclosure:          "Estimated from 90-day cash change. Insufficient history."
    };
  }
  const monthlyNet = trend90d.delta_dollars / 3;
  if (Math.abs(monthlyNet) < RUNWAY_FLAT_DOLLAR_BAND) {
    return {
      months_remaining:    null,
      monthly_burn_rate:   0,
      monthly_net_change:  Math.round(monthlyNet * 100) / 100,
      state:               "stable",
      disclosure:          "Estimated from 90-day cash change. Cash holding steady."
    };
  }
  if (monthlyNet > 0) {
    return {
      months_remaining:    null,
      monthly_burn_rate:   0,
      monthly_net_change:  Math.round(monthlyNet * 100) / 100,
      state:               "growing",
      disclosure:          "Estimated from 90-day cash change. Cash growing."
    };
  }
  const burn = -monthlyNet;
  let months = cashToday > 0 ? (cashToday / burn) : 0;
  let capped = false;
  if (months > RUNWAY_CEILING_MONTHS) { months = RUNWAY_CEILING_MONTHS; capped = true; }
  return {
    months_remaining:    Math.round(months * 10) / 10,
    months_capped:       capped,
    monthly_burn_rate:   Math.round(burn * 100) / 100,
    monthly_net_change:  Math.round(monthlyNet * 100) / 100,
    state:               "burning",
    disclosure:          "Estimated from 90-day cash change. " +
                         (capped ? "Runway exceeds 24 months — comfortable." : "")
  };
}

/* ----------------------------- Invoices ----------------------------- */

function isOverdue(invoice, todayYmd) {
  if (toNum(invoice.Balance) <= 0) return false;
  const due = String(invoice.DueDate || "");
  if (!due) return false;
  return due < todayYmd;
}
function daysOverdue(invoice, todayYmd) {
  const due = String(invoice.DueDate || "");
  if (!due) return null;
  return daysBetweenYmd(due, todayYmd);
}
function buildInvoiceSummary(openInvoices, paidPayments, todayYmd) {
  const open = (openInvoices || []).filter(function (i) { return toNum(i.Balance) > 0; });
  const overdue = open.filter(function (i) { return isOverdue(i, todayYmd); });
  const openTotal    = open.reduce(function (a, i) { return a + toNum(i.Balance); }, 0);
  const overdueTotal = overdue.reduce(function (a, i) { return a + toNum(i.Balance); }, 0);
  const paidTotal    = (paidPayments || []).reduce(function (a, p) { return a + toNum(p.TotalAmt); }, 0);
  let oldestOverdueDays = null;
  overdue.forEach(function (i) {
    const d = daysOverdue(i, todayYmd);
    if (d != null && (oldestOverdueDays == null || d > oldestOverdueDays)) {
      oldestOverdueDays = d;
    }
  });
  return {
    open_total_amount:     Math.round(openTotal * 100) / 100,
    open_count:            open.length,
    overdue_total_amount:  Math.round(overdueTotal * 100) / 100,
    overdue_count:         overdue.length,
    oldest_overdue_days:   oldestOverdueDays,
    paid_last_30d_amount:  Math.round(paidTotal * 100) / 100,
    paid_last_30d_count:   (paidPayments || []).length
  };
}

/* ----------------------------- Collections Watch ----------------------------- */

// Top N overdue invoices sorted by days_overdue DESC (most urgent first),
// breaking ties by amount_outstanding DESC. The CEO surface uses this as
// "who needs a phone call today."
function buildCollectionsWatch(openInvoices, todayYmd) {
  const list = (openInvoices || [])
    .filter(function (i) { return isOverdue(i, todayYmd); })
    .map(function (i) {
      const cust = i.CustomerRef || {};
      return {
        invoice_id:         String(i.Id || ""),
        doc_number:         String(i.DocNumber || ""),
        customer_name:      String(cust.name || cust.value || "(unknown customer)"),
        customer_qbo_id:    String(cust.value || ""),
        amount_outstanding: Math.round(toNum(i.Balance) * 100) / 100,
        amount_total:       Math.round(toNum(i.TotalAmt) * 100) / 100,
        days_overdue:       daysOverdue(i, todayYmd),
        due_date:           String(i.DueDate || ""),
        txn_date:           String(i.TxnDate || "")
      };
    });
  list.sort(function (a, b) {
    if ((b.days_overdue || 0) !== (a.days_overdue || 0)) {
      return (b.days_overdue || 0) - (a.days_overdue || 0);
    }
    return b.amount_outstanding - a.amount_outstanding;
  });
  return list.slice(0, COLLECTIONS_WATCH_LIMIT);
}

/* ----------------------------- Payroll snapshot ----------------------------- */

// Reads from Pioneer payroll_exports docs only — no QBO involvement.
// Caller supplies the last 2 exports (latest + prior, both status="active")
// so we can render the current cycle's totals + a trend chip vs prior.
function buildPayrollSnapshot(exportsList) {
  const sorted = (exportsList || []).slice().sort(function (a, b) {
    const am = a.generated_at && a.generated_at.toMillis ? a.generated_at.toMillis() : 0;
    const bm = b.generated_at && b.generated_at.toMillis ? b.generated_at.toMillis() : 0;
    return bm - am;
  });
  if (!sorted.length) {
    return {
      available:        false,
      last_export_id:   null,
      reason:           "No payroll exports on file."
    };
  }
  const latest = sorted[0];
  const prior  = sorted[1] || null;
  const out = {
    available:                          true,
    last_export_id:                     String(latest._id || latest.export_id || ""),
    last_export_period:                 String(latest.period_label || ""),
    last_export_total_paid_hours:       toNum(latest.total_paid_hours),
    last_export_employee_count:         toNum(latest.employee_count),
    last_export_session_count:          toNum(latest.session_count),
    last_export_generated_at:           latest.generated_at || null
  };
  if (prior) {
    const dh = toNum(latest.total_paid_hours) - toNum(prior.total_paid_hours);
    out.trend = {
      prior_export_period:            String(prior.period_label || ""),
      prior_export_total_paid_hours:  toNum(prior.total_paid_hours),
      delta_hours:                    Math.round(dh * 100) / 100,
      direction:                      fmtSign(dh)
    };
  }
  return out;
}

/* ----------------------------- Needs Nick (rule engine) ----------------------------- */

// Computes the 30-second "what specifically needs Nick's attention" list.
// Rules are deterministic + explainable. Each rule emits at most one item
// (no duplicates per category). Output sorted by severity (high → medium →
// low) and capped at NEEDS_NICK_LIMIT items.
function buildNeedsNick(parts) {
  const items = [];

  // Rule: QBO not connected → highest priority. Without this, every other
  // number on the card is stale or absent.
  if (parts.qboStatus === "not_connected") {
    items.push({
      severity: "high",
      category: "connection",
      title:    "QuickBooks not connected",
      message:  "Connect from /manager to enable the Financial Pulse card.",
      action_url: "/manager"
    });
  } else if (parts.qboStatus === "error") {
    items.push({
      severity: "high",
      category: "connection",
      title:    "QuickBooks sync error",
      message:  parts.qboErrorMessage || "Sync failed. Retry from the refresh button.",
      action_url: null
    });
  }

  // Rule: stale data → medium. Even a connected sync goes stale if scheduled
  // job didn't run for a day.
  if (parts.hoursSinceLastSync != null && parts.hoursSinceLastSync > NEEDS_NICK_RULES.stale_sync_hours) {
    items.push({
      severity: "medium",
      category: "stale_data",
      title:    "Financial data is stale",
      message:  "Last refresh " + Math.round(parts.hoursSinceLastSync) + " hours ago. Click refresh on the card.",
      action_url: null
    });
  }

  // Rule: cash runway under N months → high (alongside connection issues
  // this is the only other high-severity rule).
  if (parts.cashRunway && parts.cashRunway.state === "burning"
      && parts.cashRunway.months_remaining != null
      && parts.cashRunway.months_remaining < NEEDS_NICK_RULES.runway_low_months) {
    items.push({
      severity: "high",
      category: "cash_runway",
      title:    "Cash runway under " + NEEDS_NICK_RULES.runway_low_months + " months",
      message:  parts.cashRunway.months_remaining.toFixed(1) +
                " months at current burn rate ($" +
                Math.round(parts.cashRunway.monthly_burn_rate).toLocaleString() +
                "/mo net out). Review spend.",
      action_url: null
    });
  }

  // Rule: any single overdue invoice over $threshold OR over N days → medium.
  // We only flag the worst one to keep the list short.
  const worst = (parts.collectionsWatch || [])[0];
  if (worst) {
    const bigAmount = worst.amount_outstanding >= NEEDS_NICK_RULES.overdue_alarm_dollars;
    const oldDays   = (worst.days_overdue || 0) >= NEEDS_NICK_RULES.overdue_alarm_days;
    if (bigAmount || oldDays) {
      items.push({
        severity: "medium",
        category: "overdue",
        title:    "Overdue invoice needs follow-up",
        message:  "$" + worst.amount_outstanding.toLocaleString() +
                  " owed by " + worst.customer_name +
                  ", " + (worst.days_overdue != null ? worst.days_overdue + " days overdue" : "no due date") +
                  (worst.doc_number ? " (Inv #" + worst.doc_number + ")" : "") + ".",
        action_url: null
      });
    }
  }

  // Rule: payroll close imminent + blockers > 0 → high. Caller supplies the
  // computed days-until-payroll-close + blocker count (both already known
  // by the time the snapshot is built).
  if (parts.payrollCycle
      && parts.payrollCycle.days_until_close != null
      && parts.payrollCycle.days_until_close <= NEEDS_NICK_RULES.payroll_close_warning_days
      && parts.payrollCycle.blocker_count > 0) {
    items.push({
      severity: "high",
      category: "payroll_cycle",
      title:    "Payroll close approaching with blockers",
      message:  parts.payrollCycle.blocker_count + " blocker" +
                (parts.payrollCycle.blocker_count === 1 ? "" : "s") +
                " · payroll " + parts.payrollCycle.period_label +
                " closes in " + parts.payrollCycle.days_until_close + " day" +
                (parts.payrollCycle.days_until_close === 1 ? "" : "s") + ".",
      action_url: "/admin?tab=payroll"
    });
  }

  // Sort + cap.
  const sevRank = { high: 0, medium: 1, low: 2 };
  items.sort(function (a, b) {
    return (sevRank[a.severity] || 9) - (sevRank[b.severity] || 9);
  });
  return items.slice(0, NEEDS_NICK_LIMIT);
}

/* ----------------------------- buildSnapshot ----------------------------- */

// The full snapshot builder. Caller passes everything already fetched.
// Pure: no I/O, no logging, no side effects.
function buildSnapshot(opts) {
  const todayYmd = String(opts.todayYmd || "");
  const day30Ymd = String(opts.day30Ymd || "");
  const day90Ymd = String(opts.day90Ymd || "");

  const cashToday = buildCashToday(opts.bankAccounts, todayYmd);

  // Today's total: prefer the BalanceSheet today total (matches what April
  // sees in QB UI). Fall back to summed CurrentBalance from Account entities
  // if Reports endpoint returned no value.
  const todayBsTotal = extractCashFromBalanceSheet(opts.balanceSheetToday);
  const finalTodayTotal = (todayBsTotal != null && todayBsTotal !== 0)
    ? todayBsTotal
    : cashToday.total_cash_on_hand;
  cashToday.balance_sheet_total = todayBsTotal;
  cashToday.total_cash_on_hand  = Math.round(finalTodayTotal * 100) / 100;

  const total30 = extractCashFromBalanceSheet(opts.balanceSheet30);
  const total90 = extractCashFromBalanceSheet(opts.balanceSheet90);

  const trend30 = buildTrend(finalTodayTotal, total30, todayYmd, day30Ymd, true);
  const trend90 = buildTrend(finalTodayTotal, total90, todayYmd, day90Ymd, true);

  const runway = buildCashRunway(finalTodayTotal, trend90);

  const invoices         = buildInvoiceSummary(opts.openInvoices, opts.paidPayments, todayYmd);
  const collectionsWatch = buildCollectionsWatch(opts.openInvoices, todayYmd);
  const payroll          = buildPayrollSnapshot(opts.payrollExports);

  const needsNick = buildNeedsNick({
    qboStatus:          opts.qboStatus || "fresh",
    qboErrorMessage:    opts.qboErrorMessage || null,
    hoursSinceLastSync: opts.hoursSinceLastSync != null ? opts.hoursSinceLastSync : 0,
    cashRunway:         runway,
    collectionsWatch:   collectionsWatch,
    payrollCycle:       opts.payrollCycle || null
  });

  return {
    snapshot_date:      todayYmd,
    period:             "current",
    status:             opts.qboStatus || "fresh",
    error_message:      opts.qboErrorMessage || null,
    label:              "Financial Pulse",
    subtitle:           "Cash · Trends · Invoices · Collections · Payroll",
    cash_today:         cashToday,
    trend_30d:          trend30,
    trend_90d:          trend90,
    cash_runway:        runway,
    invoices:           invoices,
    collections_watch:  collectionsWatch,
    payroll:            payroll,
    needs_nick:         needsNick
  };
}

function buildNotConnectedSnapshot(reason, todayYmd) {
  return {
    snapshot_date:     String(todayYmd || ""),
    period:            "current",
    status:            "not_connected",
    error_message:     String(reason || "QuickBooks not connected."),
    label:             "Financial Pulse",
    subtitle:          "Cash · Trends · Invoices · Collections · Payroll",
    cash_today:        null,
    trend_30d:         { available: false, reason: "QuickBooks not connected." },
    trend_90d:         { available: false, reason: "QuickBooks not connected." },
    cash_runway:       { state: "unknown", months_remaining: null, monthly_burn_rate: null },
    invoices:          null,
    collections_watch: [],
    payroll:           null,
    needs_nick:        [
      {
        severity:   "high",
        category:   "connection",
        title:      "QuickBooks not connected",
        message:    "Connect from /manager to enable the Financial Pulse card.",
        action_url: "/manager"
      }
    ]
  };
}

module.exports = {
  buildSnapshot,
  buildNotConnectedSnapshot,
  extractCashFromBalanceSheet,
  buildCollectionsWatch,
  buildNeedsNick,
  COLLECTIONS_WATCH_LIMIT,
  NEEDS_NICK_LIMIT,
  NEEDS_NICK_RULES
};
