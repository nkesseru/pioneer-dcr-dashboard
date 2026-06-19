/* Pioneer DCR Hub — QuickBooks Online OAuth helpers.
 *
 * Phase Customer Economics v1 (foundation). Provides the OAuth 2 handshake
 * + token-refresh logic that the (future) syncFinancialPulseV1 will use to
 * authenticate QuickBooks Online API calls.
 *
 * Design choices:
 *   • Raw fetch — no `intuit-oauth` SDK. The OAuth flow is small enough
 *     (one authorize redirect, one token exchange, periodic refresh) that
 *     pulling in a dependency would cost more than it saves.
 *   • Refresh + access tokens live in Firestore (quickbooks_auth/connection)
 *     because they ROTATE on every refresh — Firebase Secrets are for
 *     static values. Client credentials (CLIENT_ID, CLIENT_SECRET) DO
 *     live in Firebase Secrets — they don't rotate.
 *   • State tokens for CSRF defense live in quickbooks_oauth_states/{state}
 *     with a 15-minute TTL. Consumed + deleted on callback success.
 *
 * Intuit OAuth endpoints (production):
 *   Authorize:  https://appcenter.intuit.com/connect/oauth2
 *   Token:      https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   API base:   https://quickbooks.api.intuit.com (production)
 *               https://sandbox-quickbooks.api.intuit.com (sandbox)
 *
 * Token lifetimes:
 *   access_token  ~3600s (1 hour)
 *   refresh_token ~100 days, ROTATES on each refresh call. We refresh
 *                 pre-emptively any time we touch an access_token < 10
 *                 minutes from expiry.
 */
"use strict";

const crypto = require("crypto");
const admin  = require("firebase-admin");

const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const INTUIT_TOKEN_URL     = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const INTUIT_REVOKE_URL    = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

const SCOPE = "com.intuit.quickbooks.accounting";
const AUTH_DOC_PATH = "quickbooks_auth/connection";
// Parallel "safe fields only" status doc that admins can READ from
// the /manager UI. Lives in a separate collection so the rules can
// allow admin reads without ever exposing the tokens, which live in
// AUTH_DOC_PATH (server-only).
const STATUS_DOC_PATH = "quickbooks_status/current";
const STATE_COLL    = "quickbooks_oauth_states";
const STATE_TTL_MS  = 15 * 60 * 1000;  // 15 minutes
const ACCESS_REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh if < 10 min remaining

function db() { return admin.firestore(); }

/* ----------------------------- State token ----------------------------- */

function generateState() {
  return crypto.randomBytes(24).toString("hex");
}

async function storeState(stateToken, createdBy) {
  const now = Date.now();
  await db().collection(STATE_COLL).doc(stateToken).set({
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    created_by: String(createdBy || "").toLowerCase(),
    expires_at_ms: now + STATE_TTL_MS
  });
}

// Consume returns true if the state was valid + unexpired. Deletes the
// doc atomically so a replay cannot re-use the same state.
async function consumeState(stateToken) {
  if (!stateToken) return { ok: false, reason: "missing_state" };
  const ref = db().collection(STATE_COLL).doc(stateToken);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "unknown_state" };
  const data = snap.data() || {};
  const now = Date.now();
  if (data.expires_at_ms && now > data.expires_at_ms) {
    // Stale state — clean up + reject.
    await ref.delete().catch(function () {});
    return { ok: false, reason: "expired_state" };
  }
  await ref.delete().catch(function () {});
  return { ok: true, created_by: data.created_by || "" };
}

/* ----------------------------- Authorize URL ----------------------------- */

function buildAuthorizeUrl(opts) {
  const params = new URLSearchParams();
  params.set("client_id",     opts.clientId);
  params.set("scope",         SCOPE);
  params.set("redirect_uri",  opts.redirectUri);
  params.set("response_type", "code");
  params.set("state",         opts.state);
  return INTUIT_AUTHORIZE_URL + "?" + params.toString();
}

/* ----------------------------- Token exchange ----------------------------- */

function basicAuthHeader(clientId, clientSecret) {
  const raw = String(clientId || "") + ":" + String(clientSecret || "");
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}

async function exchangeCodeForTokens(opts) {
  const body = new URLSearchParams();
  body.set("grant_type",   "authorization_code");
  body.set("code",         opts.code);
  body.set("redirect_uri", opts.redirectUri);
  const res = await fetch(INTUIT_TOKEN_URL, {
    method:  "POST",
    headers: {
      "Authorization": basicAuthHeader(opts.clientId, opts.clientSecret),
      "Accept":        "application/json",
      "Content-Type":  "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error("Intuit token exchange failed (HTTP " + res.status + "): " + txt.slice(0, 400));
  }
  return JSON.parse(txt);
}

async function refreshAccessToken(opts) {
  const body = new URLSearchParams();
  body.set("grant_type",    "refresh_token");
  body.set("refresh_token", opts.refreshToken);
  const res = await fetch(INTUIT_TOKEN_URL, {
    method:  "POST",
    headers: {
      "Authorization": basicAuthHeader(opts.clientId, opts.clientSecret),
      "Accept":        "application/json",
      "Content-Type":  "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error("Intuit token refresh failed (HTTP " + res.status + "): " + txt.slice(0, 400));
  }
  return JSON.parse(txt);
}

/* ----------------------------- Connection doc ----------------------------- */

function tokenExpiryFromNow(seconds) {
  const ms = (Number(seconds) || 0) * 1000;
  return admin.firestore.Timestamp.fromMillis(Date.now() + ms);
}

// Persist the initial connection (after callback) OR the refreshed token
// set. Refresh tokens ROTATE on every refresh call — always overwrite both.
//
// Two writes:
//   quickbooks_auth/connection  full doc including tokens; SERVER-ONLY.
//   quickbooks_status/current   safe fields only; admin-readable so the
//                               /manager UI can show connection status
//                               without ever exposing tokens.
async function saveConnection(opts) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    status:                "connected",
    realm_id:              String(opts.realmId || ""),
    access_token:          String(opts.tokens.access_token || ""),
    refresh_token:         String(opts.tokens.refresh_token || ""),
    token_type:            String(opts.tokens.token_type || "bearer"),
    scope:                 SCOPE,
    environment:           String(opts.environment || "production"),
    expires_at:            tokenExpiryFromNow(opts.tokens.expires_in),
    refresh_expires_at:    tokenExpiryFromNow(opts.tokens.x_refresh_token_expires_in),
    last_refreshed_at:     opts.isInitial ? null : now,
    updated_at:            now
  };
  if (opts.isInitial) {
    doc.connected_at = now;
    doc.connected_by = String(opts.connectedBy || "").toLowerCase();
  }
  await db().doc(AUTH_DOC_PATH).set(doc, { merge: true });

  // Mirror safe fields to status doc. NO tokens, NO secrets — explicit
  // allowlist of fields so a future schema change to the connection doc
  // can't accidentally leak a new sensitive field via this path.
  const statusDoc = {
    status:                "connected",
    realm_id:              doc.realm_id,
    environment:           doc.environment,
    expires_at:            doc.expires_at,
    refresh_expires_at:    doc.refresh_expires_at,
    last_refreshed_at:     doc.last_refreshed_at,
    updated_at:            now
  };
  if (opts.isInitial) {
    statusDoc.connected_at = now;
    statusDoc.connected_by = String(opts.connectedBy || "").toLowerCase();
  }
  await db().doc(STATUS_DOC_PATH).set(statusDoc, { merge: true });
}

async function loadConnection() {
  const snap = await db().doc(AUTH_DOC_PATH).get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

async function markDisconnected(reason) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = {
    status:            "disconnected",
    disconnect_reason: String(reason || "manual"),
    disconnected_at:   now,
    updated_at:        now
  };
  await db().doc(AUTH_DOC_PATH).set(patch, { merge: true });
  await db().doc(STATUS_DOC_PATH).set(patch, { merge: true });
}

// Calls Intuit's token revocation endpoint. Best-effort: if Intuit returns
// non-2xx (including the common "Token already invalid" / 400), we log it
// and continue — the local-side markDisconnected() always runs so the
// connection doc state is authoritative regardless of remote outcome.
// Returns { revoked: bool, http_status, message }.
async function revokeRefreshToken(opts) {
  const refreshToken = String((opts && opts.refreshToken) || "").trim();
  if (!refreshToken) return { revoked: false, http_status: 0, message: "No refresh_token to revoke." };
  const clientId     = String((opts && opts.clientId)     || "").trim();
  const clientSecret = String((opts && opts.clientSecret) || "").trim();
  if (!clientId || !clientSecret) {
    return { revoked: false, http_status: 0, message: "QBO client credentials missing." };
  }
  const basic = Buffer.from(clientId + ":" + clientSecret).toString("base64");
  try {
    const res = await fetch(INTUIT_REVOKE_URL, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + basic,
        "Accept":        "application/json",
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ token: refreshToken })
    });
    const txt = await res.text();
    return {
      revoked:     res.ok,
      http_status: res.status,
      message:     res.ok ? "Revoked at Intuit." : ("Intuit response: " + txt.slice(0, 300))
    };
  } catch (err) {
    return { revoked: false, http_status: 0, message: "Revoke call failed: " + ((err && err.message) || "unknown") };
  }
}

/* ----------------------------- Public API ----------------------------- */

// The headline helper future sync functions will call. Returns
// { access_token, realm_id, environment } ready for use against the QBO
// REST API. Auto-refreshes if the access_token is near expiry.
//
// Throws if the connection is missing OR the refresh fails — callers
// should surface the error to admins so they can re-authorize.
async function getValidAccessToken(opts) {
  const conn = await loadConnection();
  if (!conn || conn.status !== "connected") {
    throw new Error("QuickBooks not connected. Visit /manager → Connect QuickBooks to authorize.");
  }
  if (!conn.access_token || !conn.refresh_token) {
    throw new Error("QuickBooks connection doc is missing tokens. Re-authorize required.");
  }

  const expiresAtMs = (conn.expires_at && conn.expires_at.toMillis && conn.expires_at.toMillis()) || 0;
  const needsRefresh = !expiresAtMs || (expiresAtMs - Date.now() < ACCESS_REFRESH_BUFFER_MS);

  if (!needsRefresh) {
    return {
      access_token: conn.access_token,
      realm_id:     conn.realm_id,
      environment:  conn.environment || "production"
    };
  }

  // Refresh in place. The new refresh_token replaces the old one.
  const refreshed = await refreshAccessToken({
    clientId:     opts.clientId,
    clientSecret: opts.clientSecret,
    refreshToken: conn.refresh_token
  });
  await saveConnection({
    realmId:      conn.realm_id,
    tokens:       refreshed,
    environment:  conn.environment || "production",
    isInitial:    false
  });
  return {
    access_token: refreshed.access_token,
    realm_id:     conn.realm_id,
    environment:  conn.environment || "production"
  };
}

function qboApiBase(environment) {
  return String(environment || "production").toLowerCase() === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

module.exports = {
  SCOPE,
  AUTH_DOC_PATH,
  STATE_COLL,
  generateState,
  storeState,
  consumeState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  saveConnection,
  loadConnection,
  markDisconnected,
  revokeRefreshToken,
  getValidAccessToken,
  qboApiBase
};
