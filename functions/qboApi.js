/* Pioneer DCR Hub — QuickBooks Online REST helpers.
 *
 * Thin wrapper around the QBO v3 REST API. All callers get a valid access
 * token via qboAuth.getValidAccessToken() (which auto-refreshes); we
 * never read raw tokens from the connection doc directly.
 *
 * Endpoints we care about for Customer Economics v1:
 *   - GET  /v3/company/{realmId}/query?query=SELECT...   — SQL-like reads
 *   - Customer entity                                     — id, DisplayName, Active
 *   - Invoice entity                                      — TotalAmt, TxnDate, CustomerRef
 *
 * Pagination — QBO returns up to 1000 results per query. We use the
 * STARTPOSITION/MAXRESULTS clauses in the SQL-like syntax to page until
 * the page is < MAXRESULTS.
 *
 * No retry-on-401 logic here — getValidAccessToken already refreshes
 * pre-emptively when the token is < 10 minutes from expiry. A 401 at
 * runtime means the refresh_token itself is bad and the connection
 * needs to be re-authorized.
 */
"use strict";

const qboAuth = require("./qboAuth");

const QUERY_PATH = "/v3/company/{realmId}/query";
const MINOR_VERSION = "65";   // QBO API minor version (current as of 2026)
const PAGE_SIZE = 1000;

function buildUrl(base, realmId, sql) {
  const params = new URLSearchParams();
  params.set("query", sql);
  params.set("minorversion", MINOR_VERSION);
  return base + QUERY_PATH.replace("{realmId}", encodeURIComponent(realmId))
       + "?" + params.toString();
}

async function runQuery(opts, sql) {
  const token = await qboAuth.getValidAccessToken({
    clientId:     opts.clientId,
    clientSecret: opts.clientSecret
  });
  const url = buildUrl(qboAuth.qboApiBase(token.environment), token.realm_id, sql);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token.access_token,
      "Accept":        "application/json"
    }
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error("QBO query failed (HTTP " + res.status + "): " + txt.slice(0, 400));
  }
  let json;
  try { json = JSON.parse(txt); }
  catch (e) { throw new Error("QBO returned non-JSON: " + txt.slice(0, 200)); }
  return json;
}

// Paginates through every record matching `selectClause` (the part AFTER
// "SELECT * FROM X"). Caller supplies "Invoice", "Customer", etc. as
// entity. Returns a flat array of records.
async function fetchAll(opts, entity, whereClause) {
  const out = [];
  let start = 1;
  for (let page = 0; page < 100; page++) {  // safety cap
    const sql = "SELECT * FROM " + entity
      + (whereClause ? (" WHERE " + whereClause) : "")
      + " STARTPOSITION " + start
      + " MAXRESULTS " + PAGE_SIZE;
    const json = await runQuery(opts, sql);
    const resp = (json && json.QueryResponse) || {};
    const rows = resp[entity] || [];
    if (!rows.length) break;
    out.push.apply(out, rows);
    if (rows.length < PAGE_SIZE) break;
    start += rows.length;
  }
  return out;
}

/* ----------------------------- Entity helpers ----------------------------- */

// Active = true, all pages. Returns array of { Id, DisplayName, Active, ... }.
async function fetchActiveCustomers(opts) {
  return fetchAll(opts, "Customer", "Active = true");
}

// Invoices in a date range. QBO accepts ISO date strings (YYYY-MM-DD).
// Returns array of { Id, TxnDate, TotalAmt, CustomerRef: { value, name } }.
async function fetchInvoicesInWindow(opts, startDateYmd, endDateYmd) {
  const where = "TxnDate >= '" + startDateYmd + "' AND TxnDate <= '" + endDateYmd + "'";
  return fetchAll(opts, "Invoice", where);
}

/* ----------------------------- Connection probe ----------------------------- */

// Quick "are we alive?" call. Used by /manager status indicator + by the
// sync function's preflight check. Returns { connected: bool, error?: string }.
async function probeConnection(opts) {
  try {
    const token = await qboAuth.getValidAccessToken({
      clientId:     opts.clientId,
      clientSecret: opts.clientSecret
    });
    // CompanyInfo is the cheapest entity to query — single doc per realm.
    const url = buildUrl(qboAuth.qboApiBase(token.environment), token.realm_id, "SELECT * FROM CompanyInfo");
    const res = await fetch(url, {
      headers: {
        "Authorization": "Bearer " + token.access_token,
        "Accept":        "application/json"
      }
    });
    if (!res.ok) {
      const t = await res.text();
      return { connected: false, error: "HTTP " + res.status + ": " + t.slice(0, 200) };
    }
    return { connected: true };
  } catch (err) {
    return { connected: false, error: (err && err.message) || "unknown" };
  }
}

/* ----------------------------- Financial Pulse helpers (Phase 30) -----------------------------
 *
 * Read-only QBO calls added for the CEO Dashboard Financial Pulse card.
 * All use the existing `com.intuit.quickbooks.accounting` scope — no new
 * OAuth scope required.
 */

// Active bank accounts (AccountType="Bank"). The CEO surface sums their
// CurrentBalance for the "Cash Today" tile. Returns array of QBO Account
// rows with Id, Name, FullyQualifiedName, CurrentBalance, AccountType,
// AccountSubType, Active.
async function fetchBankAccounts(opts) {
  return fetchAll(opts, "Account", "Active = true AND AccountType = 'Bank'");
}

// All open invoices (Balance > 0). Caller filters overdue client-side
// (DueDate comparison) so we only pay for one query. Returns Invoice rows
// with Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef.
async function fetchOpenInvoices(opts) {
  return fetchAll(opts, "Invoice", "Balance > '0'");
}

// Payments received in window. Used for "paid last 30 days" metric. QBO
// Payment.TotalAmt is the cash applied to invoices on that date.
async function fetchPaymentsInWindow(opts, startDateYmd, endDateYmd) {
  const where = "TxnDate >= '" + startDateYmd + "' AND TxnDate <= '" + endDateYmd + "'";
  return fetchAll(opts, "Payment", where);
}

// QBO BalanceSheet Report. Hits a DIFFERENT endpoint shape than the entity
// query API — /reports/BalanceSheet with date params. Returns the full
// hierarchical report shape; caller (financialPulse.extractCashFromBalanceSheet)
// walks the tree.
//
// dateYmd is the "as of" date. accounting_method=Accrual matches what
// April sees in QB Online by default. summarize_column_by=Total emits a
// single column instead of period columns (smaller payload).
async function fetchBalanceSheetReport(opts, dateYmd) {
  const token = await qboAuth.getValidAccessToken({
    clientId:     opts.clientId,
    clientSecret: opts.clientSecret
  });
  const base = qboAuth.qboApiBase(token.environment);
  const path = "/v3/company/" + encodeURIComponent(token.realm_id) + "/reports/BalanceSheet";
  const params = new URLSearchParams();
  params.set("date",                dateYmd);
  params.set("accounting_method",   "Accrual");
  params.set("summarize_column_by", "Total");
  params.set("minorversion",        MINOR_VERSION);
  const url = base + path + "?" + params.toString();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token.access_token,
      "Accept":        "application/json"
    }
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error("BalanceSheet report HTTP " + res.status + ": " + txt.slice(0, 400));
  }
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (_e) {
    throw new Error("BalanceSheet report returned non-JSON body: " + txt.slice(0, 200));
  }
  return parsed;
}

module.exports = {
  runQuery,
  fetchAll,
  fetchActiveCustomers,
  fetchInvoicesInWindow,
  probeConnection,
  // Phase 30 — Financial Pulse
  fetchBankAccounts,
  fetchOpenInvoices,
  fetchPaymentsInWindow,
  fetchBalanceSheetReport
};
