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

module.exports = {
  runQuery,
  fetchAll,
  fetchActiveCustomers,
  fetchInvoicesInWindow,
  probeConnection
};
