/* Pioneer DCR Hub — Admin utility helpers (vanilla JS, no build).
 *
 * Pure, side-effect-free helpers shared by every admin tab module.
 *
 *   • DCR_RECENT_LIMIT          — analytics window (Last 7d / MTD / All-time)
 *   • ALLOWED_ADMIN_EMAILS      — single-source-of-truth allowlist
 *   • isRootAdmin(email)        — sync allowlist check
 *   • escapeHtml(s)             — HTML-entity escape
 *   • formatTimestamp(ts)       — Firestore-tolerant date formatter
 *   • getCustomer*(c) / getTech*(t) — schema-tolerant field accessors
 *
 * Surface lives at window.__pioneerAdmin.utils. Loaded BEFORE admin.js
 * by admin.html so admin.js can destructure at the top of its IIFE.
 *
 * Constraints:
 *   • No DOM access.
 *   • No Firebase access (resolveAdminStatus() stays in admin.js because
 *     it depends on the `db` closure variable).
 *   • Pure functions only.
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
  // through resolveAdminStatus() (which stays in admin.js because it
  // depends on the Firestore handle).
  function isRootAdmin(email) {
    if (!email) return false;
    const normalized = email.toLowerCase().trim();
    return ALLOWED_ADMIN_EMAILS.some(function (e) {
      return e.toLowerCase().trim() === normalized;
    });
  }

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

  /* ---------- export surface ---------- */

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.utils = {
    DCR_RECENT_LIMIT: DCR_RECENT_LIMIT,
    ALLOWED_ADMIN_EMAILS: ALLOWED_ADMIN_EMAILS,
    isRootAdmin: isRootAdmin,
    escapeHtml: escapeHtml,
    formatTimestamp: formatTimestamp,
    getCustomerName: getCustomerName,
    getCustomerSlug: getCustomerSlug,
    getCustomerEmail: getCustomerEmail,
    getCustomerLocation: getCustomerLocation,
    getActive: getActive,
    getDcrEnabled: getDcrEnabled,
    getDcrEmailEnabled: getDcrEmailEnabled,
    getTechName: getTechName,
    getTechSlug: getTechSlug
  };
}());
