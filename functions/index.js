/* Pioneer DCR Hub — Cloud Functions (v2).
 *
 * Exports:
 *   submitDcrV1 — HTTPS function. Accepts a v1 DCR payload, validates,
 *                 writes to Firestore, then POSTs a clean payload to Zapier
 *                 (if ZAPIER_DCR_WEBHOOK_URL is configured).
 *
 * Phase 1 scope:
 *   - No auth (intentional — open POST endpoint, locked down by validation + rules).
 *   - Zapier integration is best-effort: if not configured or it fails, we still
 *     return success to the browser; the Firestore doc records the zapier status.
 *   - CORS open to any origin (we serve the form from Firebase Hosting on the same
 *     project, but we also want to allow tests from other origins during Phase 1).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

// Native DCR email pipeline (Phase 1 — replaces the Zapier-based DCR
// email path). All helpers + handler logic live in ./dcrEmail; this file
// only declares the secrets + wraps it in an onRequest endpoint at the
// bottom of the file (search "generateAndSendDcrEmailV1").
const dcrEmail = require("./dcrEmail");
const ghlHiringSync = require("./ghlHiringSync");
const twilioMessaging = require("./twilioMessaging");
const qboAuth = require("./qboAuth");
const qboApi  = require("./qboApi");
const customerEconomics = require("./customerEconomics");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const SCHEMA_VERSION = "dcr.v1";
const ALLOWED_SOURCES = new Set(["web_form", "ghl", "api"]);
const FIRESTORE_COLLECTION = "dcr_submissions";
const SUPPLY_COLLECTION    = "supply_requests";
const SUPPLY_NOTICES_COLL  = "supply_notices";
const OPERATIONAL_FEED_COLL = "operational_feed";

// Allowed values per the Phase 1 spec. Out-of-list values are silently
// coerced to safe defaults so a typo never produces an unreadable doc.
const FEED_TYPES = [
  "announcement", "issue", "shift_note", "inspection_note",
  "recognition", "safety_alert", "scheduler_notice", "hiring_notice",
  "training_update", "policy_update"
];
const FEED_SEVERITIES = ["info", "important", "urgent"];
const FEED_STATUSES   = ["new", "seen", "im_on_it", "waiting", "resolved", "archived"];
const FEED_ROLES      = [
  "admin", "tech", "office_manager", "scheduler", "hiring",
  "supply_manager", "quality_manager"
];

// Server-side helper. Writes a structured /operational_feed doc with
// safe defaults + AI-ready placeholder fields. Returns the doc id.
// Fire-and-forget callers should `.catch()` — failures here must
// never break the upstream operational action.
async function createOperationalFeedItem(data) {
  const safe = data && typeof data === "object" ? data : {};
  const type     = FEED_TYPES.indexOf(safe.type)     >= 0 ? safe.type     : "announcement";
  const severity = FEED_SEVERITIES.indexOf(safe.severity) >= 0 ? safe.severity : "info";
  const status   = FEED_STATUSES.indexOf(safe.status) >= 0 ? safe.status   : "new";
  const audienceRoles = Array.isArray(safe.audience_roles)
    ? safe.audience_roles
        .map(function (r) { return String(r || "").trim(); })
        .filter(function (r) { return FEED_ROLES.indexOf(r) >= 0; })
    : [];
  const audienceUserIds = Array.isArray(safe.audience_user_ids)
    ? safe.audience_user_ids
        .map(function (u) { return String(u || "").trim(); })
        .filter(Boolean)
    : [];
  const acknowledgedBy = Array.isArray(safe.acknowledged_by) ? safe.acknowledged_by : [];

  const doc = {
    type:               type,
    title:              String(safe.title || "").trim().slice(0, 200),
    body:               String(safe.body || "").trim().slice(0, 4000),
    severity:           severity,
    status:             status,
    customer_slug:      safe.customer_slug || null,
    customer_name:      safe.customer_name || null,
    shift_id:           safe.shift_id || null,
    inspection_id:      safe.inspection_id || null,
    dcr_submission_id:  safe.dcr_submission_id || null,
    supply_request_id:  safe.supply_request_id || null,
    created_by_uid:     String(safe.created_by_uid || ""),
    created_by_name:    String(safe.created_by_name || "system"),
    created_at:         admin.firestore.FieldValue.serverTimestamp(),
    updated_at:         admin.firestore.FieldValue.serverTimestamp(),
    resolved_at:        null,
    expires_at:         safe.expires_at || null,
    audience_roles:     audienceRoles,
    audience_user_ids:  audienceUserIds,
    requires_ack:       safe.requires_ack === true,
    acknowledged_by:    acknowledgedBy,
    ai_ready: {
      allow_ai_summary:     safe.ai_ready && safe.ai_ready.allow_ai_summary     !== false,
      allow_ai_sentiment:   safe.ai_ready && safe.ai_ready.allow_ai_sentiment   !== false,
      allow_ai_recognition: safe.ai_ready && safe.ai_ready.allow_ai_recognition !== false,
      ai_handled:           false,
      ai_notes:             ""
    }
  };

  try {
    const ref = await db.collection(OPERATIONAL_FEED_COLL).add(doc);
    logger.info("operational_feed created", {
      feed_id:           ref.id,
      type:              type,
      severity:          severity,
      audience_roles:    audienceRoles,
      supply_request_id: doc.supply_request_id
    });
    return ref.id;
  } catch (err) {
    logger.warn("operational_feed write failed (non-fatal)", {
      error: err && err.message,
      type:  type,
      title: doc.title
    });
    return null;
  }
}

// Default assignee for new supply orders. Kirby owns supply
// fulfillment for the pilot; if his admin doc ever moves, the
// canonical reference is here so a single rename ripples through
// every create path. Email is lower-cased to match firestore.rules
// admin allowlist.
const SUPPLY_ASSIGNED_TO       = "kirby";
const SUPPLY_ASSIGNED_TO_NAME  = "Kirby";
const SUPPLY_ASSIGNED_TO_EMAIL = "kirby@pioneercomclean.com";

// Fire-and-forget admin notice for the Supply Notices admin surface.
// Audience is intentionally "admin" — techs do NOT see these, and the
// content is NEVER part of any customer-facing email path.
//
// Also fans out a corresponding /operational_feed item so the broader
// PioneerOps feed surface (admin Feed tab + tech-visible feed section)
// shows this signal alongside other operational events. The feed item
// is a separate doc — supply_notices keeps the focused admin queue,
// operational_feed is the aggregated stream.
async function createSupplyNotice(opts) {
  // Operational feed entry — independent of the supply_notices write
  // below so a feed failure doesn't block the notice (and vice versa).
  try {
    await createOperationalFeedItem({
      type:              "issue",
      title:             "New supply request",
      body:              String(opts.body || ""),
      severity:          "info",
      status:            "new",
      audience_roles:    ["admin", "supply_manager"],
      audience_user_ids: [],
      requires_ack:      false,
      supply_request_id: String(opts.supply_request_id || ""),
      customer_slug:     opts.customer_slug || null,
      customer_name:     opts.customer_name || null,
      created_by_uid:    "",                          // server-side path
      created_by_name:   opts.tech_name || "system"
    });
  } catch (_e) { /* helper already logs */ }

  try {
    const ref = db.collection(SUPPLY_NOTICES_COLL).doc();
    await ref.set({
      type:                   "supply_order",
      audience:               "admin",
      title:                  "New supply request",
      body:                   String(opts.body || ""),
      linked_supply_order_id: String(opts.supply_request_id || ""),
      source:                 String(opts.source || "dcr"),
      tech_slug:              String(opts.tech_slug || ""),
      tech_name:              String(opts.tech_name || ""),
      customer_slug:          String(opts.customer_slug || ""),
      customer_name:          String(opts.customer_name || ""),
      assigned_to:            SUPPLY_ASSIGNED_TO,
      assigned_to_name:       SUPPLY_ASSIGNED_TO_NAME,
      assigned_to_email:      SUPPLY_ASSIGNED_TO_EMAIL,
      active:                 true,
      created_at:             admin.firestore.FieldValue.serverTimestamp()
    });
    logger.info("supply_notices created", {
      linked_supply_order_id: opts.supply_request_id,
      source:                 opts.source
    });
  } catch (err) {
    logger.warn("supply_notices write failed (non-fatal)", {
      error: err && err.message,
      linked_supply_order_id: opts.supply_request_id
    });
  }
}
const TECHS_COLLECTION     = "cleaning_techs";
const ISSUES_COLLECTION    = "dcr_issues";
const ZAPIER_TIMEOUT_MS = 10000;

// Where Firebase sends users AFTER they complete a password-reset
// link. Without this `actionCodeSettings.url`, Firebase shows its
// stock "password updated" page with a dead "Continue" button — the
// exact dead-end Makaila hit during pilot prep. Pointing the
// continueUrl at /login.html means: tech clicks reset link → sets
// new password → Firebase redirects → /login.html → tech taps Sign
// In → lands on Team Hub. Single canonical entry point. Must be
// registered as an Authorized domain in Firebase Auth settings
// (pioneer-dcr-hub.web.app already is).
const INVITE_CONTINUE_URL = "https://pioneer-dcr-hub.web.app/login.html";
const INVITE_ACTION_CODE_SETTINGS = {
  url:               INVITE_CONTINUE_URL,
  handleCodeInApp:   false   // browser-based reset; no app intent capture
};

// Role hierarchy (mirror of firestore.rules and public/staff-auth.js).
// Hierarchical: owner > executive > admin > tech. Higher roles inherit
// all lower-role capabilities.
//   owner       — full access incl. pay-rate + financial data.
//   executive   — CEO Mission Control + (future) Financial Pulse.
//   admin       — Office Manager Mission Control + admin CRUD.
//   tech        — operational surfaces only.
//
// Keep these three lists in sync with the matching consts in
// public/staff-auth.js and the helpers in firestore.rules.
const ALLOWED_OWNER_EMAILS = [
  "nick@pioneercomclean.com",
  "april@pioneercomclean.com"
];
const ALLOWED_EXECUTIVE_EMAILS = [
  "april@pioneercomclean.com"
];
const ALLOWED_ADMIN_EMAILS = [
  "nick@pioneercomclean.com",
  "april@pioneercomclean.com",
  "kirby@pioneercomclean.com",
  "mgies@pioneercomclean.com"
];

function roleForEmail(email) {
  const lc = String(email || "").toLowerCase().trim();
  if (!lc) return null;
  if (ALLOWED_OWNER_EMAILS.indexOf(lc) >= 0)     return "owner";
  if (ALLOWED_EXECUTIVE_EMAILS.indexOf(lc) >= 0) return "executive";
  if (ALLOWED_ADMIN_EMAILS.indexOf(lc) >= 0)     return "admin";
  return null;
}

function emailHasOwnerAccess(email)     { const r = roleForEmail(email); return r === "owner"; }
function emailHasExecutiveAccess(email) { const r = roleForEmail(email); return r === "owner" || r === "executive"; }
function emailHasAdminAccess(email)     { const r = roleForEmail(email); return r === "owner" || r === "executive" || r === "admin"; }

/* ----------------------------- Staff auth (shared helper) ----------------------------- */

// Verifies the Firebase ID token in `Authorization: Bearer <token>` and
// resolves the caller's role:
//   • admin          — email is in ALLOWED_ADMIN_EMAILS
//   • cleaning_tech  — email matches a cleaning_techs doc where
//                      active !== false AND dcr_enabled !== false
//   • denied         — anyone else
//
// On success returns { decoded, email, uid, role, tech, isAdmin }.
// On failure writes a 401/403 response and returns null — callers should
// `return` immediately if the result is null.
async function verifyStaffOrReject(req, res) {
  const authHeader = req.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "Sign-in required (missing Authorization header)" });
    return null;
  }
  const idToken = authHeader.substring(7).trim();
  if (!idToken) {
    res.status(401).json({ ok: false, error: "Sign-in required (empty token)" });
    return null;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    logger.warn("verifyStaff: ID token verification failed", { error: err && err.message });
    res.status(401).json({ ok: false, error: "Invalid or expired sign-in. Please sign in again." });
    return null;
  }

  const email = ((decoded.email || "") + "").toLowerCase().trim();
  const uid   = decoded.uid;

  // Two-tier admin check: hardcoded root list first (fast, survives
  // Firestore outages), then Firestore admins collection for runtime-
  // added admins. Keep both in sync via the admin invite flow.
  let isAdmin = ALLOWED_ADMIN_EMAILS.some(function (e) {
    return e.toLowerCase().trim() === email;
  });
  if (!isAdmin && email) {
    try {
      const adminSnap = await db.collection("admins").doc(email).get();
      if (adminSnap.exists && adminSnap.data().active !== false) {
        isAdmin = true;
      }
    } catch (err) {
      logger.warn("verifyStaff: admins lookup failed (non-fatal)", {
        error: err && err.message, email: email
      });
    }
  }

  let tech = null;
  if (!isAdmin && email) {
    try {
      const snap = await db.collection(TECHS_COLLECTION)
        .where("email", "==", email)
        .limit(1)
        .get();
      if (!snap.empty) {
        const d = snap.docs[0];
        tech = Object.assign({ id: d.id }, d.data());
      }
    } catch (err) {
      logger.error("verifyStaff: cleaning_techs lookup failed", { error: err && err.message, email: email });
    }
  }

  let role = null;
  let allowed = false;
  if (isAdmin) {
    role = "admin";
    allowed = true;
  } else if (tech) {
    const isActive = tech.active !== false;
    const isDcrEnabled = tech.dcr_enabled !== false;
    if (isActive && isDcrEnabled) {
      role = "cleaning_tech";
      allowed = true;
    }
  }

  if (!allowed) {
    res.status(403).json({
      ok: false,
      error: "Your account is not currently enabled for Pioneer DCR access. Please contact the office.",
      reason: tech
        ? (tech.active === false ? "archived" : "dcr_disabled")
        : "not_on_staff_list"
    });
    return null;
  }

  return { decoded: decoded, email: email, uid: uid, role: role, tech: tech, isAdmin: isAdmin };
}

/* ----------------------------- whoAmIV1 ----------------------------- */

// Identity check used by the form + tech hub on boot. Always returns 200 with
// {allowed, role, reason, tech} when the ID token is valid (even if denied) —
// the client renders the appropriate UI. Token-invalid + missing-token are
// still 401 so the client knows to re-prompt sign-in.
exports.whoAmIV1 = onRequest({ cors: false, timeoutSeconds: 15 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const authHeader = req.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "Sign-in required" });
    return;
  }
  const idToken = authHeader.substring(7).trim();

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    logger.warn("whoAmIV1: token verification failed", { error: err && err.message });
    res.status(401).json({ ok: false, error: "Invalid or expired sign-in" });
    return;
  }

  const email = ((decoded.email || "") + "").toLowerCase().trim();
  const uid   = decoded.uid;

  // Two-tier admin check — hardcoded root list, then Firestore admins
  // collection (same logic as verifyStaffOrReject).
  let isAdmin = ALLOWED_ADMIN_EMAILS.some(function (e) {
    return e.toLowerCase().trim() === email;
  });
  if (!isAdmin && email) {
    try {
      const adminSnap = await db.collection("admins").doc(email).get();
      if (adminSnap.exists && adminSnap.data().active !== false) {
        isAdmin = true;
      }
    } catch (err) {
      logger.warn("whoAmIV1: admins lookup failed (non-fatal)", {
        error: err && err.message
      });
    }
  }

  let tech = null;
  if (email) {
    try {
      const snap = await db.collection(TECHS_COLLECTION)
        .where("email", "==", email)
        .limit(1)
        .get();
      if (!snap.empty) {
        const d = snap.docs[0];
        tech = Object.assign({ id: d.id }, d.data());
      }
    } catch (err) {
      logger.error("whoAmIV1: cleaning_techs lookup failed", { error: err && err.message });
    }
  }

  let role = "denied";
  let allowed = false;
  let reason = "not_on_staff_list";
  if (isAdmin) {
    role = "admin"; allowed = true; reason = null;
  } else if (tech) {
    const isActive = tech.active !== false;
    const isDcrEnabled = tech.dcr_enabled !== false;
    if (isActive && isDcrEnabled) {
      role = "cleaning_tech"; allowed = true; reason = null;
    } else {
      reason = isActive ? "dcr_disabled" : "archived";
    }
  }

  return res.status(200).json({
    ok:      true,
    allowed: allowed,
    role:    role,
    email:   email,
    uid:     uid,
    reason:  reason,
    tech:    tech ? {
      slug:                    tech.tech_slug || tech.slug || tech.id,
      display_name:            tech.display_name || tech.tech_display_name || "",
      experience_level:        tech.experience_level || "standard",
      // List of customer slugs this tech is permitted to submit DCRs for
      // and see in the Tech Hub. Empty array = no assignments yet → form
      // and tech hub show "No assigned locations yet" empty state.
      assigned_customer_slugs: Array.isArray(tech.assigned_customer_slugs) ? tech.assigned_customer_slugs : []
    } : null
  });
});

/* ----------------------------- createCleaningTechLoginV1 ----------------------------- */

// Admin-only HTTPS function that provisions both halves of a tech's login:
//
//   1. Firebase Auth user (if one doesn't already exist for the email)
//   2. cleaning_techs/{tech_slug} doc with the matching email, assignments,
//      and active/dcr_enabled flags
//
// Idempotent by design — calling it again for an existing email reuses the
// Auth UID and updates the cleaning_techs doc. That lets the same admin
// modal serve "new tech" and "repair tech" without two code paths.
//
// Passwords are NEVER stored in Firestore. Two delivery modes:
//   • send_password_reset = true (default): server generates a
//     password-reset link (admin.auth().generatePasswordResetLink) and
//     returns it. The admin client ALSO triggers
//     firebase.auth().sendPasswordResetEmail so the tech gets Firebase's
//     hosted email automatically. The returned link is a manual backup.
//   • send_password_reset = false: server creates the Auth user with a
//     random strong temporary password and returns it (one-time). Admin
//     shares it privately. New users get prompted to change it on first
//     sign-in via Firebase's standard flow.
//
// Returns 401/403 on auth failure, 400 on validation failure, 500 on
// admin-SDK errors. Success is 200 + JSON envelope.
function makeTempPassword() {
  // 16 chars from a URL-safe alphabet — enough entropy that the temp
  // password is fine to share verbally, and short enough to type.
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const buf = require("crypto").randomBytes(16);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += alpha[buf[i] % alpha.length];
  return out;
}

function slugifyForTech(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isValidEmailShape(s) {
  // Very permissive — Firebase Auth does the real validation. This is
  // just a sanity gate so we don't waste an admin-SDK round-trip on
  // obvious garbage.
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

exports.createCleaningTechLoginV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // ---- Admin-only gate ----
  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("createCleaningTechLoginV1: non-admin attempted to provision tech", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};

  // ---- Validation ----
  const displayName = String(body.display_name || "").trim();
  const emailRaw    = String(body.email        || "").trim();
  const email       = emailRaw.toLowerCase();
  const phone       = String(body.phone        || "").trim();
  const notes       = String(body.notes        || "").trim();
  const experienceLevel = String(body.experience_level || "standard").trim() || "standard";
  let   techSlug    = String(body.tech_slug    || "").trim().toLowerCase();
  const assignedRaw = Array.isArray(body.assigned_customer_slugs) ? body.assigned_customer_slugs : [];
  const sendReset   = body.send_password_reset !== false; // default true

  const errs = [];
  if (!displayName)                errs.push("display_name is required");
  if (!emailRaw)                   errs.push("email is required");
  else if (!isValidEmailShape(emailRaw)) errs.push("email is not in a valid format");
  if (!techSlug) techSlug = slugifyForTech(displayName);
  if (!techSlug)                   errs.push("tech_slug could not be derived — provide display_name or tech_slug");
  if (techSlug && !/^[a-z0-9-]+$/.test(techSlug)) {
    errs.push("tech_slug must be lowercase alphanumeric + dashes only");
  }

  if (errs.length) {
    res.status(400).json({ ok: false, error: "Validation failed", details: errs });
    return;
  }

  const assigned = assignedRaw
    .map(function (s) { return String(s || "").toLowerCase().trim(); })
    .filter(Boolean);
  // Deduplicate + sort so the Firestore diff is stable across re-saves.
  const assignedSorted = Array.from(new Set(assigned)).sort();

  // ---- Auth user: reuse if exists, otherwise create ----
  //
  // Failure modes we surface separately:
  //   • auth/user-not-found              → fall through to createUser
  //   • auth/insufficient-permission     → IAM gap on the function SA
  //   • auth/email-already-exists        → race with another call (we just
  //                                        looked it up; treat as "use it")
  //   • auth/invalid-password etc.       → bad input
  //   • anything else                    → 500 with the underlying code so
  //                                        the admin UI can show it
  let authUser = null;
  let authUserCreated = false;
  let temporaryPassword = null;

  // Firebase Admin SDK throws FirebaseAuthError with the code on either
  // `err.code` or `err.errorInfo.code` depending on SDK version. Pull
  // both with one helper so the rest of the function never gets caught
  // by a shape change in a future bump.
  function extractAuthErrorInfo(err) {
    const code = (err && err.code)
      || (err && err.errorInfo && err.errorInfo.code)
      || "unknown";
    const message = (err && err.message)
      || (err && err.errorInfo && err.errorInfo.message)
      || String(err);
    return { code: code, message: message };
  }

  function iamFixHint() {
    // Resolved at runtime so logs name the actual SA running this function.
    const sa = (process && process.env && (
      process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT ||
      process.env.FUNCTION_IDENTITY ||
      process.env.K_SERVICE
    )) || "<function service account>";
    return (
      "The Cloud Function's service account is missing IAM permission to call " +
      "the Firebase Authentication API. Grant the role 'Firebase Authentication Admin' " +
      "(roles/firebaseauth.admin) to " + sa + " in Google Cloud Console → IAM, then retry."
    );
  }

  try {
    authUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    const info = extractAuthErrorInfo(err);
    if (info.code === "auth/user-not-found") {
      // Generate a strong temp password. If the admin opted for reset
      // flow, this is throwaway — they'll never see it, and the tech
      // resets it on first sign-in. If they opted for "temp password
      // share", we return it in the response.
      const pwd = makeTempPassword();
      try {
        authUser = await admin.auth().createUser({
          email:         email,
          emailVerified: false,
          password:      pwd,
          displayName:   displayName,
          disabled:      false
        });
        authUserCreated = true;
        if (!sendReset) temporaryPassword = pwd;
      } catch (createErr) {
        const cInfo = extractAuthErrorInfo(createErr);
        logger.error("createCleaningTechLoginV1: createUser failed", {
          email: email, code: cInfo.code, message: cInfo.message,
          stack: createErr && createErr.stack
        });
        let friendly;
        if (cInfo.code === "auth/email-already-exists") {
          friendly = "A Firebase Auth user already exists for this email (race condition). Try again.";
        } else if (cInfo.code === "auth/invalid-password") {
          friendly = "Generated password was rejected by Firebase. Try again.";
        } else if (cInfo.code === "auth/insufficient-permission") {
          friendly = "Couldn't create the Firebase Auth user (" + cInfo.code + "). " + iamFixHint();
        } else if (cInfo.code === "auth/operation-not-allowed") {
          friendly = "Email/Password sign-in is not enabled on this project. " +
                     "Firebase Console → Authentication → Sign-in method → Email/Password → Enable.";
        } else {
          friendly = "Couldn't create the Firebase Auth user (" + cInfo.code + "). " +
                     "Check the function logs for the full error.";
        }
        res.status(500).json({ ok: false, error: friendly, code: cInfo.code });
        return;
      }
    } else {
      // `getUserByEmail` failed for some reason OTHER than "user not found".
      // Log everything we can — the prior version of this function logged
      // only the code+message, which made auth/insufficient-permission
      // indistinguishable from a transient network blip in the toast.
      logger.error("createCleaningTechLoginV1: getUserByEmail failed", {
        email: email, code: info.code, message: info.message,
        stack: err && err.stack,
        errorInfo: err && err.errorInfo || null
      });
      let friendly;
      if (info.code === "auth/insufficient-permission") {
        friendly = "Couldn't look up the Firebase Auth user (" + info.code + "). " + iamFixHint();
      } else if (info.code === "auth/internal-error") {
        friendly = "Firebase Auth returned an internal error. Retry; if it persists, check the function logs.";
      } else {
        friendly = "Couldn't look up the Firebase Auth user (" + info.code + "). " +
                   "Check the function logs for the full error.";
      }
      res.status(500).json({ ok: false, error: friendly, code: info.code });
      return;
    }
  }

  // ---- Reset link (if requested) ----
  let resetLink = null;
  let resetLinkErrorCode = null;
  if (sendReset) {
    try {
      // V2 invite flow: pass actionCodeSettings so Firebase returns
      // the tech to /login.html after they set their password.
      // Without this, the user lands on Firebase's stock success page
      // with no path back into PioneerOps (the bug Makaila hit).
      resetLink = await admin.auth().generatePasswordResetLink(
        email, INVITE_ACTION_CODE_SETTINGS
      );
    } catch (err) {
      // Non-fatal — the cleaning_techs doc still gets written, and the
      // admin client will also try sendPasswordResetEmail() so the tech
      // still gets an email even if this link generation fails. We DO
      // surface the code in the response so the admin UI can warn that
      // the backup link is missing (and why).
      const rInfo = extractAuthErrorInfo(err);
      resetLinkErrorCode = rInfo.code;
      logger.warn("createCleaningTechLoginV1: generatePasswordResetLink failed", {
        email: email, code: rInfo.code, message: rInfo.message,
        stack: err && err.stack
      });
    }
  }

  // ---- cleaning_techs upsert (server-authoritative) ----
  const adminEmail = staff.email;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const docRef = db.collection(TECHS_COLLECTION).doc(techSlug);

  // Use a transaction so that if the doc already exists, we don't blow
  // away fields (e.g., metrics_cache, archived_at) that admin.js might
  // own elsewhere. We only set what this flow is authoritative for.
  try {
    await db.runTransaction(async function (tx) {
      const snap = await tx.get(docRef);
      const existed = snap.exists;
      const baseUpdate = {
        tech_slug:               techSlug,
        display_name:            displayName,
        email:                   email,
        phone:                   phone,
        notes:                   notes,
        experience_level:        experienceLevel,
        assigned_customer_slugs: assignedSorted,
        active:                  true,
        dcr_enabled:             true,
        firebase_auth_uid:       authUser.uid,
        updated_at:              now,
        updated_by:              adminEmail
      };
      // Stamp last_invite_sent_at when this run actually triggered a
      // reset email (or generated the backup link). The Admins tab and
      // Cleaning Techs tab both read this to show "Invite sent: …" in
      // the status display, and the Resend button updates it via
      // sendPasswordResetV1.
      if (sendReset) {
        baseUpdate.last_invite_sent_at = now;
      }
      if (!existed) {
        baseUpdate.created_at = now;
        baseUpdate.created_by = adminEmail;
        // Default these only on create so reactivating an archived tech
        // doesn't accidentally clobber operational fields.
        tx.set(docRef, baseUpdate);
      } else {
        // Preserve created_at/by from the prior doc. If reactivating, also
        // clear any archived_at stamp so the tech reappears in lists.
        const prior = snap.data() || {};
        if (prior.archived_at) {
          baseUpdate.archived_at = null;
          baseUpdate.archived_by = null;
        }
        tx.set(docRef, baseUpdate, { merge: true });
      }
    });
  } catch (err) {
    logger.error("createCleaningTechLoginV1: Firestore upsert failed", {
      tech_slug: techSlug, code: err && err.code, message: err && err.message,
      stack: err && err.stack
    });
    // Auth user may already have been created — surface that to the admin
    // so they can finish manually rather than silently leaking the user.
    res.status(500).json({
      ok: false,
      code: (err && err.code) || "firestore_upsert_failed",
      error: "Couldn't save the cleaning_techs document" +
             (err && err.code ? " (" + err.code + ")" : "") + ". " +
             (authUserCreated
               ? "The Firebase Auth user was created (UID: " + authUser.uid + "). " +
                 "You can finish the doc via the Cleaning Techs tab."
               : "No Firebase Auth changes were made.")
    });
    return;
  }

  logger.info("createCleaningTechLoginV1 ok", {
    by:               adminEmail,
    tech_slug:        techSlug,
    uid:              authUser.uid,
    auth_user_created: authUserCreated,
    send_reset:       sendReset
  });

  res.status(200).json({
    ok:                    true,
    tech_slug:             techSlug,
    uid:                   authUser.uid,
    email:                 email,
    auth_user_created:     authUserCreated,
    temporary_password:    temporaryPassword,   // null unless send_reset === false AND user was newly created
    reset_link:            resetLink,           // null unless send_reset === true AND generation succeeded
    reset_link_error_code: resetLinkErrorCode   // null on success; otherwise the underlying auth/* code
  });
});

/* ----------------------------- createAdminLoginV1 -----------------------------
   Admin-only HTTPS function. Creates (or reuses) a Firebase Auth user
   for the given email, writes/updates admins/{email}, and generates a
   password-reset link that the client also triggers via Firebase Web
   SDK so the invitee receives the reset email from Firebase.
   Idempotent: re-running for an existing email refreshes the doc and
   sends a fresh reset link. */
exports.createAdminLoginV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("createAdminLoginV1: non-admin attempted to provision admin", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const displayName = String(body.display_name || "").trim();
  const emailRaw    = String(body.email        || "").trim();
  const email       = emailRaw.toLowerCase();
  const phone       = String(body.phone        || "").trim();
  const active      = body.active !== false;

  // Optional provenance fields. The Admins-tab "Add admin" flow leaves
  // these blank ("source" defaults to "admin_invite"); the "Promote to
  // Admin" action on a cleaning-tech row passes
  //   source:              "promoted_from_cleaning_tech"
  //   cleaning_tech_slug:  "<tech doc id / slug>"
  // so the resulting /admins/{email} doc carries an audit trail of how
  // the account got admin access. We DO NOT touch the cleaning_techs
  // doc here — a promoted user keeps their tech access (and customer
  // assignments) until/unless an admin separately archives it.
  const ALLOWED_SOURCES = ["admin_invite", "promoted_from_cleaning_tech"];
  let source = String(body.source || "admin_invite").trim();
  if (ALLOWED_SOURCES.indexOf(source) < 0) source = "admin_invite";
  const cleaningTechSlug = String(body.cleaning_tech_slug || "").trim();

  const errs = [];
  if (!displayName) errs.push("display_name is required");
  if (!emailRaw)    errs.push("email is required");
  else if (!isValidEmailShape(emailRaw)) errs.push("email is not in a valid format");

  if (errs.length) {
    res.status(400).json({ ok: false, error: "Validation failed", details: errs });
    return;
  }

  // Auth user: reuse if exists, otherwise create with random temp password.
  let authUser = null;
  let authUserCreated = false;
  try {
    authUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    const code = (err && err.code) || (err && err.errorInfo && err.errorInfo.code) || "";
    if (code === "auth/user-not-found") {
      const pwd = makeTempPassword();
      try {
        authUser = await admin.auth().createUser({
          email:         email,
          emailVerified: false,
          password:      pwd,
          displayName:   displayName,
          disabled:      false
        });
        authUserCreated = true;
      } catch (createErr) {
        logger.error("createAdminLoginV1: createUser failed", {
          email: email,
          code: createErr && createErr.code,
          message: createErr && createErr.message
        });
        res.status(500).json({
          ok: false,
          error: "Couldn't create the Firebase Auth user (" +
                 (createErr && createErr.code || "unknown") + ")."
        });
        return;
      }
    } else {
      logger.error("createAdminLoginV1: getUserByEmail failed", {
        email: email, code: code, message: err && err.message
      });
      res.status(500).json({
        ok: false,
        error: "Couldn't look up the Firebase Auth user (" + (code || "unknown") + ")."
      });
      return;
    }
  }

  // Generate a backup reset link (server-side). Non-fatal — client
  // will also call sendPasswordResetEmail() from Firebase Web SDK.
  // actionCodeSettings.url ensures Firebase sends the new admin back
  // to /login.html after they set their password.
  let resetLink = null;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(
      email, INVITE_ACTION_CODE_SETTINGS
    );
  } catch (err) {
    logger.warn("createAdminLoginV1: generatePasswordResetLink failed (non-fatal)", {
      email: email, code: err && err.code, message: err && err.message
    });
  }

  // Upsert admins/{email}. Doc ID is the lowercased email so the
  // firestore.rules isPioneerAdmin() check can use exists()/get() to
  // resolve it in O(1) at rules eval time.
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection("admins").doc(email);
  try {
    await db.runTransaction(async function (tx) {
      const snap = await tx.get(ref);
      const update = {
        email:               email,
        display_name:        displayName,
        phone:               phone,
        active:              active,
        role:                "admin",
        firebase_auth_uid:   authUser.uid,
        last_invite_sent_at: sts,
        updated_at:          sts,
        updated_by:          staff.email
      };
      // Provenance — only set cleaning_tech_slug when promoting (don't
      // null it out on a regular admin invite, since a previous promote
      // call may have set it and we want to preserve that history).
      if (cleaningTechSlug) update.cleaning_tech_slug = cleaningTechSlug;
      if (!snap.exists) {
        update.created_at = sts;
        update.created_by = staff.email;
        update.source     = source;
        tx.set(ref, update);
      } else {
        // On re-runs, preserve the ORIGINAL source unless the caller
        // is explicitly upgrading from an old doc with no source field.
        const prior = snap.data() || {};
        if (!prior.source) update.source = source;
        tx.set(ref, update, { merge: true });
      }
    });
  } catch (err) {
    logger.error("createAdminLoginV1: admins upsert failed", {
      email: email, code: err && err.code, message: err && err.message
    });
    res.status(500).json({
      ok: false,
      error: "Couldn't save the admin record. " +
             (authUserCreated
               ? "Auth user was created (UID: " + authUser.uid + ") but the admins/{email} doc failed."
               : "No Auth changes were made.")
    });
    return;
  }

  logger.info("createAdminLoginV1 ok", {
    by:                 staff.email,
    email:              email,
    uid:                authUser.uid,
    auth_user_created:  authUserCreated
  });

  res.status(200).json({
    ok:                true,
    email:             email,
    uid:               authUser.uid,
    auth_user_created: authUserCreated,
    reset_link:        resetLink   // backup link; admin can copy if email delivery fails
  });
});

/* ----------------------------- sendPasswordResetV1 -----------------------------
   Admin-only HTTPS function. Generates a password-reset link for the
   given email. Used by the "Resend invite" button on the admin's tech
   and admin rows.
   Tracks `last_invite_sent_at` on the relevant doc when known
   (cleaning_techs/{slug} matched by email, or admins/{email}). */
exports.sendPasswordResetV1 = onRequest({ cors: false, timeoutSeconds: 20 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const emailRaw = String(body.email || "").trim();
  const email    = emailRaw.toLowerCase();
  if (!emailRaw || !isValidEmailShape(emailRaw)) {
    res.status(400).json({ ok: false, error: "Valid email required." });
    return;
  }

  // Look up the Firebase Auth user. If none exists, auto-create one
  // (V6 — pilot-readiness). The previous "no_auth_user → noop" branch
  // forced admins to manually provision Auth users via a separate
  // flow before they could send an invite. That added friction with
  // no security gain (this endpoint is already admin-gated), and it
  // failed the Send invite button for every tech whose
  // cleaning_techs/{slug} doc was seeded without a corresponding
  // Auth user — which was the case for Jared and every cleaning
  // tech the office added through the roster pre-normalization.
  //
  // Auto-create rules:
  //   • emailVerified: false (the recipient verifies via the reset
  //     link they're about to receive)
  //   • disabled: false
  //   • displayName: pulled from the cleaning_techs doc if we can
  //     find one matching this email; otherwise omitted
  // If createUser fails with auth/email-already-exists (rare race
  // condition), we re-fetch via getUserByEmail and proceed.
  let authUser = null;
  let createdNewAuthUser = false;
  try {
    authUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    const code = (err && err.code) || (err && err.errorInfo && err.errorInfo.code) || "";
    if (code !== "auth/user-not-found") {
      logger.error("sendPasswordResetV1: getUserByEmail failed", {
        email_prefix: email.slice(0, 3), code: code
      });
      res.status(500).json({ ok: false, error: "Lookup failed (" + (code || "unknown") + ")." });
      return;
    }
    // Auto-create branch. Try to find a displayName from the
    // matching cleaning_techs doc so the new Auth user's profile is
    // populated. Missing display_name is non-blocking.
    let displayName = "";
    try {
      const techQuery = await db.collection(TECHS_COLLECTION)
        .where("email", "==", email).limit(1).get();
      if (!techQuery.empty) {
        const td = techQuery.docs[0].data() || {};
        displayName = String(td.display_name || td.full_name || "").trim();
      }
    } catch (_e) { /* tolerated — fall back to anonymous create */ }

    try {
      authUser = await admin.auth().createUser({
        email:          email,
        emailVerified:  false,
        disabled:       false,
        displayName:    displayName || undefined
      });
      createdNewAuthUser = true;
      logger.info("sendPasswordResetV1: created new Auth user for invite", {
        by: staff.email, email_prefix: email.slice(0, 3), uid: authUser.uid,
        display_name_used: !!displayName
      });
    } catch (createErr) {
      const cCode = (createErr && createErr.code) ||
                    (createErr && createErr.errorInfo && createErr.errorInfo.code) || "";
      // Race condition: an Auth user appeared between the lookup and
      // the create. Re-fetch and continue.
      if (cCode === "auth/email-already-exists") {
        try {
          authUser = await admin.auth().getUserByEmail(email);
          logger.info("sendPasswordResetV1: createUser raced — re-fetched existing user", {
            email_prefix: email.slice(0, 3), uid: authUser.uid
          });
        } catch (refetchErr) {
          logger.error("sendPasswordResetV1: createUser race + refetch failed", {
            email_prefix: email.slice(0, 3),
            create_code: cCode,
            refetch_code: refetchErr && refetchErr.code
          });
          await stampTechInviteError(db, email, "create_then_refetch_failed: " + cCode);
          res.status(500).json({
            ok: false, code: "create_user_failed",
            error: "Couldn't create or re-fetch the Auth user (" + cCode + ")."
          });
          return;
        }
      } else {
        logger.error("sendPasswordResetV1: createUser failed", {
          email_prefix: email.slice(0, 3),
          code: cCode,
          message: createErr && createErr.message
        });
        await stampTechInviteError(db, email,
          "create_auth_user_failed: " + (cCode || (createErr && createErr.message) || "unknown"));
        res.status(500).json({
          ok:    false,
          code:  "create_user_failed",
          error: "Couldn't create Firebase Auth user (" + (cCode || "unknown") + ")."
        });
        return;
      }
    }
  }

  // Generate a reset link. actionCodeSettings.url ensures Firebase
  // sends the tech back to /login.html after they set their password
  // — without it, they hit Firebase's stock success page with no
  // path back into PioneerOps. (Pilot blocker fix.)
  let resetLink = null;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(
      email, INVITE_ACTION_CODE_SETTINGS
    );
  } catch (err) {
    logger.error("sendPasswordResetV1: generatePasswordResetLink failed", {
      email_prefix: email.slice(0, 3), code: err && err.code
    });
    res.status(500).json({
      ok: false,
      error: "Couldn't generate reset link (" + (err && err.code || "unknown") + ")."
    });
    return;
  }

  // Stamp last_invite_sent_at on whichever doc this email belongs to.
  // Both updates are best-effort; failures don't block the response.
  const sts = admin.firestore.FieldValue.serverTimestamp();
  try {
    const adminDoc = await db.collection("admins").doc(email).get();
    if (adminDoc.exists) {
      await adminDoc.ref.update({
        last_invite_sent_at: sts,
        updated_at:          sts,
        updated_by:          staff.email
      });
    }
  } catch (err) {
    logger.warn("sendPasswordResetV1: admin doc stamp failed", { error: err && err.message });
  }
  try {
    const techSnap = await db.collection(TECHS_COLLECTION)
      .where("email", "==", email)
      .limit(1)
      .get();
    if (!techSnap.empty) {
      // V6 pilot — write both legacy snake_case AND new camelCase
      // fields so existing code paths keep working AND the new admin
      // UI can drive the "Send invite" vs "Reinvite" button label
      // off `inviteSentAt`. `inviteStatus` is set to "sent" here;
      // future flows can flip it to "accepted" when the recipient
      // signs in for the first time.
      await techSnap.docs[0].ref.update({
        last_invite_sent_at: sts,
        updated_at:          sts,
        updated_by:          staff.email,
        // ---- V6 invite fields ----
        inviteSentAt:        sts,
        inviteSentBy:        staff.email,
        inviteEmail:         email,
        inviteStatus:        "sent",
        inviteLastError:     null,
        // V6 — Firebase Auth uid, both shapes so any reader keeps
        // working. Set whether the auth user was created just now or
        // already existed.
        firebaseUid:         authUser.uid,
        firebase_auth_uid:   authUser.uid
      });
      logger.info("sendPasswordResetV1: tech invite stamped", {
        tech_slug: techSnap.docs[0].id,
        email_prefix: email.slice(0, 3),
        by: staff.email
      });
    }
  } catch (err) {
    logger.warn("sendPasswordResetV1: tech doc stamp failed", { error: err && err.message });
    // Best-effort error stamp so the admin UI can surface "last invite
    // attempt failed" for triage. Soft-fail if even this fails.
    try {
      const techSnap = await db.collection(TECHS_COLLECTION)
        .where("email", "==", email).limit(1).get();
      if (!techSnap.empty) {
        await techSnap.docs[0].ref.update({
          inviteLastError: String(err && err.message || "unknown error"),
          inviteStatus:    "error"
        });
      }
    } catch (_innerErr) { /* swallow */ }
  }

  logger.info("sendPasswordResetV1 ok", {
    by: staff.email, email_prefix: email.slice(0, 3), uid: authUser.uid,
    created_auth_user: createdNewAuthUser
  });

  res.status(200).json({
    ok:                 true,
    sent:               true,
    uid:                authUser.uid,
    created_auth_user:  createdNewAuthUser,
    reset_link:         resetLink   // backup link if email delivery hiccups
  });
});

// V6 helper — stamp inviteStatus:"error" + inviteLastError onto the
// matching cleaning_techs doc when an invite attempt fails before we
// reach the success-path tech-doc update. Soft-fails its own write.
async function stampTechInviteError(db, email, reason) {
  try {
    const tq = await db.collection(TECHS_COLLECTION)
      .where("email", "==", email).limit(1).get();
    if (tq.empty) return;
    await tq.docs[0].ref.update({
      inviteStatus:    "error",
      inviteLastError: String(reason || "unknown")
    });
  } catch (_e) { /* swallow */ }
}

/* ----------------------------- deleteCleaningTechV1 -----------------------------
   Admin-only HARD DELETE for a cleaning_tech doc.

   Refuses to delete if the tech has any operational history. Archive
   (active: false) is the only way to "remove" a tech with submissions;
   the hard-delete path exists for typos, test rows, and other techs
   that never produced data.

   Safety checks (ALL must come back empty before delete proceeds):
     • dcr_submissions      where tech_slug == this slug
     • supply_requests      where tech_slug == this slug
     • dcr_issues           where tech_slug == this slug
     • supply_notifications where tech_slug == this slug
     • supply_station_orders where tech_slug == this slug

   Effects on a successful delete:
     • cleaning_techs/{slug} doc removed.
     • Firebase Auth user disabled, BUT ONLY IF:
         - no /admins/{email} doc with active != false exists, AND
         - email isn't in the hardcoded root allowlist.
       (Admins keep working; the deleted-tech-but-still-admin case
       preserves the Auth account so the user can still sign in to
       /admin.html.)
     • Any `admins/{email}` doc with `cleaning_tech_slug == slug` is
       left intact (the user keeps admin access). We DO clear that doc's
       `cleaning_tech_slug` field so a future audit doesn't point at a
       gone tech.

   Best-effort: the Auth user is NOT deleted, only `disabled`. This
   preserves the audit trail in Firebase Auth and lets an admin re-
   enable later without losing the UID. */
exports.deleteCleaningTechV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("deleteCleaningTechV1: non-admin attempted delete", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const techSlug = String(body.tech_slug || "").trim().toLowerCase();
  if (!techSlug) {
    res.status(400).json({ ok: false, error: "tech_slug is required." });
    return;
  }

  // Load the tech doc up front. We need the email to decide whether the
  // Auth user gets disabled; a missing doc is a 404 (not a delete).
  let techData = null;
  try {
    const snap = await db.collection(TECHS_COLLECTION).doc(techSlug).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: "No cleaning_techs doc with that slug." });
      return;
    }
    techData = Object.assign({ id: snap.id }, snap.data());
  } catch (err) {
    logger.error("deleteCleaningTechV1: tech lookup failed", { tech_slug: techSlug, error: err && err.message });
    res.status(500).json({ ok: false, error: "Couldn't load the tech record (" + (err && err.code || "unknown") + ")." });
    return;
  }

  // ---- Safety checks ----
  //
  // Each query is `limit(1)` because we only need to know whether ANY
  // doc exists. We DON'T return a precise count to the admin (running
  // a count() against five collections per delete would be wasteful
  // when the answer "≥1" is sufficient to block). If the admin wants
  // exact numbers they can run reports outside this flow.
  let blockedReasons = [];
  try {
    const checks = [
      { coll: FIRESTORE_COLLECTION,                label: "DCR submissions" },
      { coll: SUPPLY_COLLECTION,                   label: "supply requests" },
      { coll: ISSUES_COLLECTION,                   label: "DCR issues" },
      { coll: SUPPLY_NOTIFICATIONS_COLLECTION,     label: "supply notifications" },
      { coll: SUPPLY_STATION_ORDERS_COLLECTION,    label: "supply station orders" }
    ];
    for (const c of checks) {
      const snap = await db.collection(c.coll)
        .where("tech_slug", "==", techSlug)
        .limit(1)
        .get();
      if (!snap.empty) blockedReasons.push(c.label);
    }
  } catch (err) {
    logger.error("deleteCleaningTechV1: history check failed", { tech_slug: techSlug, error: err && err.message });
    res.status(500).json({
      ok:    false,
      error: "Couldn't verify the tech's history before delete. Try again, or archive instead."
    });
    return;
  }

  if (blockedReasons.length > 0) {
    logger.info("deleteCleaningTechV1 blocked — operational history exists", {
      tech_slug: techSlug, blocked_by: blockedReasons
    });
    res.status(409).json({
      ok:        false,
      blocked:   true,
      reasons:   blockedReasons,
      error:     "Cannot permanently delete — archive instead. " +
                 "This tech has linked records in: " + blockedReasons.join(", ") + "."
    });
    return;
  }

  // ---- Delete is safe — execute ----
  const techEmail = ((techData && techData.email) || "").toLowerCase().trim();

  // 1) Decide whether to disable the Auth user. Only do so if this
  //    email is NOT also an admin (hardcoded OR active /admins doc).
  let isAlsoAdmin = false;
  if (techEmail) {
    isAlsoAdmin = ALLOWED_ADMIN_EMAILS.some(function (e) {
      return e.toLowerCase().trim() === techEmail;
    });
    if (!isAlsoAdmin) {
      try {
        const adminSnap = await db.collection("admins").doc(techEmail).get();
        if (adminSnap.exists && adminSnap.data().active !== false) {
          isAlsoAdmin = true;
        }
      } catch (err) {
        // Non-fatal — if the lookup failed we err on the side of NOT
        // disabling the Auth user (preserves access).
        logger.warn("deleteCleaningTechV1: admins lookup failed (preserving Auth user)", {
          email: techEmail, error: err && err.message
        });
        isAlsoAdmin = true;
      }
    }
  }

  // 2) Delete the cleaning_techs doc.
  try {
    await db.collection(TECHS_COLLECTION).doc(techSlug).delete();
  } catch (err) {
    logger.error("deleteCleaningTechV1: doc delete failed", { tech_slug: techSlug, error: err && err.message });
    res.status(500).json({ ok: false, error: "Couldn't delete the tech record (" + (err && err.code || "unknown") + ")." });
    return;
  }

  // 3) Best-effort: scrub stale cleaning_tech_slug on any admins doc
  //    that pointed at this tech. The admin doc itself stays.
  let adminDocCleared = false;
  if (techEmail) {
    try {
      const adminRef = db.collection("admins").doc(techEmail);
      const adminSnap = await adminRef.get();
      if (adminSnap.exists && (adminSnap.data() || {}).cleaning_tech_slug === techSlug) {
        await adminRef.update({
          cleaning_tech_slug: admin.firestore.FieldValue.delete(),
          updated_at:         admin.firestore.FieldValue.serverTimestamp(),
          updated_by:         staff.email
        });
        adminDocCleared = true;
      }
    } catch (err) {
      logger.warn("deleteCleaningTechV1: admins doc scrub failed (non-fatal)", {
        email: techEmail, error: err && err.message
      });
    }
  }

  // 4) Disable the Auth user if this email isn't also an admin.
  let authUserDisabled = false;
  let authUserDisableError = null;
  if (techEmail && !isAlsoAdmin) {
    try {
      const u = await admin.auth().getUserByEmail(techEmail);
      if (u && !u.disabled) {
        await admin.auth().updateUser(u.uid, { disabled: true });
        authUserDisabled = true;
      }
    } catch (err) {
      const code = (err && err.code) || (err && err.errorInfo && err.errorInfo.code) || "";
      if (code !== "auth/user-not-found") {
        authUserDisableError = code || (err && err.message) || "unknown";
        logger.warn("deleteCleaningTechV1: auth user disable failed (non-fatal)", {
          email: techEmail, code: code
        });
      }
    }
  }

  logger.info("deleteCleaningTechV1 ok", {
    by:                     staff.email,
    tech_slug:              techSlug,
    email:                  techEmail || null,
    is_also_admin:          isAlsoAdmin,
    auth_user_disabled:     authUserDisabled,
    admin_doc_cleared:      adminDocCleared,
    auth_user_disable_err:  authUserDisableError
  });

  res.status(200).json({
    ok:                     true,
    tech_slug:              techSlug,
    email:                  techEmail || null,
    is_also_admin:          isAlsoAdmin,
    auth_user_disabled:     authUserDisabled,
    admin_doc_cleared:      adminDocCleared,
    auth_user_disable_err:  authUserDisableError
  });
});

// Compute a streak — count of consecutive items meeting `threshold`
// starting at the newest end of the list. Caller passes the array
// already sorted newest-first.
//   walkInspectionStreak([{overall_score: 4.9}, {overall_score: 4.6}, {overall_score: 4.4}]) → 2
//   walkInspectionStreak([{overall_score: 4.0}, ...]) → 0
const STREAK_THRESHOLD = 4.5;
function walkInspectionStreak(docsNewestFirst, threshold) {
  const t = typeof threshold === "number" ? threshold : STREAK_THRESHOLD;
  let n = 0;
  for (let i = 0; i < docsNewestFirst.length; i++) {
    const s = (docsNewestFirst[i] || {}).overall_score;
    if (typeof s !== "number") continue;            // unknown — skip, don't break
    if (s >= t) n += 1;
    else break;
  }
  return n;
}

/* ----------------------------- pioneerQualityViewV1 -----------------------------
   Tech-safe aggregate view of /inspections. Any active staff
   (admin + cleaning_tech) can call. Returns the rolling Pioneer
   Quality Score for the last 30 days plus a list of recent 5-star
   wins for celebration on Team Hub.

   Inspections themselves remain admin-only at the rule layer — this
   function uses the Admin SDK to read the collection and emits a
   carefully-trimmed shape that's safe to surface to the whole team:

     • overall_score           — rolling avg of overall_score across
                                 the window (1 decimal). null when
                                 the window is empty.
     • window_days             — 30 (constant; widen later if needed).
     • count                   — number of inspections in the window.
     • recent_five_star_wins[] — up to 5, newest-first. Each entry:
         customer_name, location_name, inspection_date, overall_score,
         celebrated_tech_display_name   ← only when the office wants
         to credit a tech; omitted otherwise. v1 emits an empty value
         and a follow-up build adds the manual "celebrate this tech"
         button. NO inspector identity, NO scoring breakdown, NO notes.
     • last_inspection_at       — ISO string or null.

   Off the response on purpose: per-area scores, low scores, inspector
   identity, internal notes, photos. The hub at /inspections.html
   reads the full docs directly (admin-only rule); Team Hub uses this
   reduced shape for public morale-building visibility. */
exports.pioneerQualityViewV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const WINDOW_DAYS = 30;
  const cutoffMs = Date.now() - (WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Single-field inequality on inspection_submitted_at uses an auto
    // index; no composite needed. Cap at 500 for safety — the form
    // typically writes a handful per day per location, so 500 is
    // ~weeks of activity at scale and the rolling-avg math is light.
    const snap = await db.collection("inspections")
      .where("inspection_submitted_at", ">=", new Date(cutoffMs))
      .limit(500)
      .get();

    const docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

    // Rolling overall score — average of overall_score across docs
    // that have a real number. Defensive against legacy docs.
    const numericScores = docs
      .map(function (d) { return typeof d.overall_score === "number" ? d.overall_score : null; })
      .filter(function (n) { return n !== null && !Number.isNaN(n); });
    const rolling = numericScores.length
      ? Math.round((numericScores.reduce(function (s, n) { return s + n; }, 0) / numericScores.length) * 10) / 10
      : null;

    // 5-star wins (>=4.8). Newest-first. Trim payload aggressively
    // — only public-safe fields. NO inspector identity.
    const wins = docs
      .filter(function (d) { return typeof d.overall_score === "number" && d.overall_score >= 4.8; })
      .sort(function (a, b) {
        return tsToMs(b.inspection_submitted_at) - tsToMs(a.inspection_submitted_at);
      })
      .slice(0, 5)
      .map(function (d) {
        return {
          customer_name:    d.customer_name || "",
          // location_name isn't currently emitted by the intake; fall
          // back to customer_name so the card always reads cleanly.
          location_name:    d.location_name || d.customer_name || "",
          inspection_date:  d.inspection_date || tsToIso(d.inspection_submitted_at) || "",
          overall_score:    Math.round(d.overall_score * 10) / 10,
          // Reserved for the future "credit this tech" flow — empty
          // until an admin explicitly chooses to celebrate.
          celebrated_tech_display_name: ""
        };
      });

    // Last-inspection-at for the trend hint copy.
    let newestMs = 0;
    docs.forEach(function (d) {
      const ms = tsToMs(d.inspection_submitted_at);
      if (ms > newestMs) newestMs = ms;
    });

    // Company streak — count consecutive newest inspections with
    // overall_score >= STREAK_THRESHOLD. Walks across docs (sorted
    // newest-first), regardless of window. Streak resets the moment
    // we see a sub-threshold doc.
    const docsByNewest = docs.slice().sort(function (a, b) {
      return tsToMs(b.inspection_submitted_at) - tsToMs(a.inspection_submitted_at);
    });
    const companyStreak = walkInspectionStreak(docsByNewest, STREAK_THRESHOLD);

    return res.status(200).json({
      ok:                      true,
      window_days:             WINDOW_DAYS,
      overall_score:           rolling,
      count:                   numericScores.length,
      recent_five_star_wins:   wins,
      company_streak:          companyStreak,
      streak_threshold:        STREAK_THRESHOLD,
      last_inspection_at:      newestMs ? new Date(newestMs).toISOString() : null,
      generated_at:            new Date().toISOString()
    });
  } catch (err) {
    logger.error("pioneerQualityViewV1 failed", { error: err && err.message });
    return res.status(500).json({ ok: false, error: "Failed to compute quality view" });
  }
});

/* ----------------------------- submitSupplyStationOrderV1 ----------------------------- */

// Server-side contact for the supply-order escalation. Lives here (not
// in the public JS bundle) so April's phone never reaches a tech-facing
// page. To rotate: edit + redeploy this function.
const APRIL_SUPPLY_NOTIFY = {
  name:                    "April Kesseru",
  phone:                   "5098283335",
  slack:                   true,
  reminder_interval_hours: 48
};

const SUPPLY_STATION_ORDERS_COLLECTION = "supply_station_orders";
const SUPPLY_NOTIFICATIONS_COLLECTION  = "supply_notifications";

// Staff-facing endpoint that lets a signed-in cleaning_tech (or admin)
// submit a supply-station order from /supply-station.html. Creates BOTH
// docs server-side via the Admin SDK so:
//   1. Tech client doesn't need write permission on the admin-only
//      supply_station_orders / supply_notifications collections.
//   2. April's contact info stays out of the publicly-served JS bundle.
//
// The supply_notifications doc carries type:"supply_station_order" so
// existing Zaps that watch the collection can branch the message body
// for this case vs. the existing "ordered" supply-request reminder.
exports.submitSupplyStationOrderV1 = onRequest({ cors: false, timeoutSeconds: 20 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  // Any active staff (admin OR cleaning_tech) can submit a supply-station
  // order. verifyStaffOrReject already returns 403 for archived/disabled
  // techs and non-staff identities.

  const body = req.body || {};

  // ---- Validation ----
  const requestedItems = String(body.requested_items || "").trim();
  const priority       = String(body.priority || "normal").trim().toLowerCase();
  const note           = String(body.note || "").trim();
  const customerSlug   = String(body.customer_slug || "").trim().toLowerCase();
  // V6 pilot — accept customer_name + location_name so the saved
  // supply_requests doc carries human-readable strings the admin UI
  // can render without re-resolving the slug. Trimmed + capped.
  const customerName   = String(body.customer_name || "").trim().slice(0, 200);
  const locationName   = String(body.location_name || "").trim().slice(0, 200);
  let   categoriesRaw  = Array.isArray(body.categories) ? body.categories : [];
  categoriesRaw = categoriesRaw
    .map(function (c) { return String(c || "").trim(); })
    .filter(Boolean)
    .slice(0, 20);

  const ALLOWED_PRIORITIES = ["low", "normal", "high", "urgent"];
  const errs = [];
  if (!requestedItems) errs.push("requested_items is required");
  if (ALLOWED_PRIORITIES.indexOf(priority) < 0) {
    errs.push("priority must be one of " + ALLOWED_PRIORITIES.join(", "));
  }
  if (requestedItems.length > 2000) errs.push("requested_items is too long (max 2000 chars)");
  if (note.length > 1000)           errs.push("note is too long (max 1000 chars)");

  if (errs.length) {
    res.status(400).json({ ok: false, error: "Validation failed", details: errs });
    return;
  }

  // ---- Write supply_requests doc (UNIFIED — supply station orders flow
  // into the same operational queue as customer-location supply requests).
  //
  // Going forward, supply_station orders live in `supply_requests` with
  // `source: "supply_station"` so the existing admin Supply Requests
  // workflow (status pipeline, filters, aging chips, edit modal) handles
  // them without a second admin surface. The dormant
  // `supply_station_orders` collection is no longer written to — it
  // stays in firestore.rules as deny-create / admin-read in case there
  // are still old test docs to triage manually.
  //
  // Initial status: "reviewed".
  //   • Rationale: a supply-station order arrives with the tech's own
  //     priority + categories + items + note already filled in, so the
  //     "did the office see this?" step is functionally redundant.
  //     Starting at "reviewed" skips a no-op click. The doc still
  //     surfaces in the Open count and aging chip, just one notch deeper
  //     in the workflow.
  //   • Customer supply requests created by submitDcrV1 keep their
  //     initial "new" status — they need the office to triage them
  //     before any further action.
  //
  // Customer-related fields (customer_slug, customer_name, location_name,
  // clean_date) are written as empty strings rather than omitted. The
  // admin UI hides empty values for supply_station rows; keeping the
  // keys present means queries that filter by customer_slug still match
  // empty docs out of the result set without throwing.
  const sts        = admin.firestore.FieldValue.serverTimestamp();
  const requestRef = db.collection(SUPPLY_COLLECTION).doc();
  const orderId    = requestRef.id;

  const requestDoc = {
    request_id:         orderId,
    source:             "supply_station",
    // Supply-station-specific fields:
    priority:           priority,
    categories:         categoriesRaw,
    note:               note,
    // Customer-shape fields kept empty for unified queries; admin UI
    // hides blanks for supply_station rows.
    // V6 pilot — customer_name + location_name now flow through from
    // the picker on supply-station.html. Empty strings remain valid
    // for "no specific customer" (office-wide restock).
    customer_slug:      customerSlug,
    customer_name:      customerName,
    location_name:      locationName,
    clean_date:         "",
    // Shared fields:
    requested_items:    requestedItems,
    requested_by_email: staff.email,
    requested_by_uid:   staff.uid,
    requested_by_role:  staff.role,
    tech_slug:          (staff.tech && (staff.tech.tech_slug || staff.tech.slug || staff.tech.id)) || "",
    tech_display_name:  (staff.tech && (staff.tech.display_name || staff.tech.tech_display_name)) || "",
    status:             "reviewed",     // see rationale above
    // Workflow audit stamps. "reviewed_by" is the function name (not an
    // admin email) so the audit trail is honest about who/what set the
    // initial state — there was no human review, the function did it.
    reviewed_at:        sts,
    reviewed_by:        "submitSupplyStationOrderV1",
    // ---- Routing / fulfillment audit (mirrors DCR path) ----
    assigned_to:        SUPPLY_ASSIGNED_TO,
    assigned_to_name:   SUPPLY_ASSIGNED_TO_NAME,
    assigned_to_email:  SUPPLY_ASSIGNED_TO_EMAIL,
    fulfilled_at:       null,
    fulfilled_by:       null,
    created_at:         sts,
    updated_at:         sts
  };

  try {
    await requestRef.set(requestDoc);
  } catch (err) {
    logger.error("submitSupplyStationOrderV1: supply_requests write failed", {
      error: err && err.message, by: staff.email
    });
    res.status(500).json({ ok: false, error: "Couldn't save the supply order. Try again." });
    return;
  }

  // Admin-only notice — non-blocking. Mirrors the DCR-side path so a
  // single admin Supply Notices surface sees both sources.
  await createSupplyNotice({
    supply_request_id: orderId,
    source:            "supply_station",
    tech_slug:         requestDoc.tech_slug,
    tech_name:         requestDoc.tech_display_name || staff.email,
    customer_slug:     customerSlug,
    customer_name:     "",
    body:              (requestDoc.tech_display_name || staff.email) +
                         " submitted a supply station order" +
                         (customerSlug ? " for " + customerSlug : "") +
                         ": " + requestedItems
  });

  // ---- Write supply_notifications doc (April reminder loop) ----
  // Reuses the existing reminder schema so Zapier doesn't need a second
  // workflow. The `type` field discriminates so the Zap can branch on
  // message body if needed.
  //
  // v1 Zap contract (in production as of 2026-05-14):
  //   • Trigger:  Firestore new-document on supply_notifications.
  //   • Filter:   notification_status === "pending" AND
  //               type === "supply_station_order".
  //               (The customer-supply path uses status === "ordered" +
  //               supply_request_id exists; see admin.js for that branch.)
  //   • Actions:  Slack DM to April + Slack DM to Kirby.
  //   • Finalise: Firestore PATCH with updateMask on the SAME doc —
  //               notification_status → "sent",
  //               last_notified_at → now,
  //               sent_channels → "slack_april,slack_kirby".
  //   • Reminders intentionally DEFERRED in v1: next_reminder_at is
  //     written here for forward-compat, but no Zap is polling it. A
  //     future scheduled Zap can resume from this value without a
  //     server-side change.
  //   • Failure path intentionally DEFERRED: Slack failures leave the
  //     doc in "pending"; the office retries from the held Zap run.
  //   • The Firestore PATCH (not full set) is intentional so the
  //     reminder_count / next_reminder_at fields stay intact for a
  //     future reminder Zap to consume.
  //   • sent_channels is a comma-joined list of channels that ACTUALLY
  //     delivered. Append to it (don't overwrite) if future stages add
  //     email/webhook.
  //
  // TIMESTAMP NOTE: next_reminder_at is written here as a JS Date, which
  // the Admin SDK converts to a Firestore Timestamp. last_notified_at
  // is updated by Zapier on send and currently lands as a stringValue
  // (Zapier connector quirk). Follow-up: migrate the Zap's
  // last_notified_at write to a Firestore Timestamp via a Code step
  // so both timestamps share the same Firestore type. Until then, any
  // reader of last_notified_at must accept both shapes.
  const notifRef = db.collection(SUPPLY_NOTIFICATIONS_COLLECTION).doc(orderId);
  const nextReminderAt = new Date(
    Date.now() + APRIL_SUPPLY_NOTIFY.reminder_interval_hours * 3600 * 1000
  );
  const messageSummary = [
    "Supply station order:",
    "\nPriority: " + priority,
    requestedItems ? "\nItems: " + requestedItems.slice(0, 500) : "",
    categoriesRaw.length ? "\nCategories: " + categoriesRaw.join(", ") : "",
    note ? "\nNote: " + note.slice(0, 300) : "",
    "\nRequested by: " + (orderDoc.tech_display_name || orderDoc.requested_by_email)
  ].join("");

  let notificationCreated = false;
  try {
    await notifRef.set({
      type:                    "supply_station_order",
      // Unified ID — same value as the request doc in supply_requests.
      // Kept named supply_request_id so the Zap that already filters on
      // `supply_request_id exists` (the customer-supply branch) matches
      // by structure if you choose to consolidate the two filter paths.
      supply_request_id:       orderId,
      // Legacy alias for any Zap step that referenced the old name.
      // Safe to remove once you've confirmed no Zap step reads it.
      supply_station_order_id: orderId,
      requested_items:         requestedItems,
      requested_by_tech:       orderDoc.tech_display_name || orderDoc.requested_by_email,
      requested_by_email:      orderDoc.requested_by_email,
      customer_slug:           customerSlug,
      priority:                priority,
      categories:              categoriesRaw,
      status:                  "new",
      created_at:              sts,
      notify_to_name:          APRIL_SUPPLY_NOTIFY.name,
      notify_to_phone:         APRIL_SUPPLY_NOTIFY.phone,
      notify_to_slack:         APRIL_SUPPLY_NOTIFY.slack,
      notification_status:     "pending",
      last_notified_at:        null,
      next_reminder_at:        nextReminderAt,
      reminder_interval_hours: APRIL_SUPPLY_NOTIFY.reminder_interval_hours,
      reminder_count:          0,
      resolved_at:             null,
      message_summary:         messageSummary
    });
    notificationCreated = true;
  } catch (err) {
    // Non-fatal — the order is saved, just the notification didn't fire.
    // An admin can re-trigger from the admin UI later.
    logger.warn("submitSupplyStationOrderV1: notification write failed (order still saved)", {
      order_id: orderId, error: err && err.message
    });
  }

  logger.info("submitSupplyStationOrderV1 ok", {
    order_id: orderId, by: staff.email, role: staff.role,
    notification_created: notificationCreated
  });

  res.status(200).json({
    ok:                    true,
    order_id:              orderId,
    notification_created:  notificationCreated
  });
});

/* ----------------------------- validation ----------------------------- */

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function isStringOrEmpty(v)  { return typeof v === "string"; }
function isArray(v)          { return Array.isArray(v); }

function validatePayload(p) {
  const errs = [];
  if (!p || typeof p !== "object")          errs.push("payload must be an object");
  if (!p || p.schema_version !== SCHEMA_VERSION) errs.push(`schema_version must be "${SCHEMA_VERSION}"`);
  if (!p || !ALLOWED_SOURCES.has(p.source)) errs.push(`source must be one of ${[...ALLOWED_SOURCES].join(", ")}`);
  if (!p || !isNonEmptyString(p.submission_id))  errs.push("submission_id is required");
  if (!p || !isNonEmptyString(p.customer_slug))  errs.push("customer_slug is required");
  if (!p || !isNonEmptyString(p.tech_slug))      errs.push("tech_slug is required");
  if (!p || !isNonEmptyString(p.clean_date))     errs.push("clean_date is required");
  if (p && p.clean_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.clean_date)) errs.push("clean_date must be YYYY-MM-DD");
  if (p && !isStringOrEmpty(p.notes))            errs.push("notes must be a string");
  if (p && !isArray(p.photos))                   errs.push("photos must be an array");
  if (p && p.photos) {
    p.photos.forEach((ph, i) => {
      if (!ph || typeof ph !== "object")              errs.push(`photos[${i}] must be an object`);
      else if (!isNonEmptyString(ph.storage_path))    errs.push(`photos[${i}].storage_path is required`);
      else if (!isNonEmptyString(ph.download_url))    errs.push(`photos[${i}].download_url is required`);
    });
  }
  if (p && !p.affirmation || (p.affirmation && p.affirmation.affirmed !== true)) {
    errs.push("affirmation.affirmed must be true");
  }
  if (p && p.affirmation && !isNonEmptyString(p.affirmation.signature_name)) {
    errs.push("affirmation.signature_name is required");
  }
  return errs;
}

/* ----------------------------- Supply requests ----------------------------- */

// Auto-create a supply_requests doc when the DCR says the cleaner needs
// supplies. Idempotent — same submission_id can only create one request
// because the doc ID is deterministic and we use .create() (which throws
// ALREADY_EXISTS on retry rather than clobbering admin-side edits).
//
// Best-effort: a failure here is logged but never blocks the DCR response.
async function maybeCreateSupplyRequest(doc, submissionId) {
  const formData     = doc.form_data || {};
  const needsSupplies = formData.needs_supplies === true;
  const itemsText     = (typeof formData.supply_request_text === "string"
                          ? formData.supply_request_text.trim()
                          : "");
  // User spec: "If a DCR submission includes needs_supplies = true OR
  // supply_requests array/text" → create. Either condition triggers it.
  if (!needsSupplies && !itemsText) return;

  const requestId = "req_" + submissionId;

  const request = {
    request_id:            requestId,
    // Unified source discriminator. Customer-driven supply requests
    // (the ones that originate from a DCR with needs_supplies) get
    // "customer_supply"; supply_station orders submitted from
    // /supply-station.html get "supply_station". The admin UI defaults
    // missing/legacy values to "customer_supply" on read.
    source:                "customer_supply",
    submission_id:         submissionId,

    customer_slug:         doc.customer_slug || "",
    customer_name:         doc.customer_name || "",
    location_name:         doc.location_name || "",

    tech_slug:             doc.tech_slug || "",
    tech_display_name:     doc.tech_display_name || "",
    clean_date:            doc.clean_date || "",

    // Cleaner-side text from the DCR form. NEVER edited by admins —
    // admin_notes (below) is the office-side log.
    requested_items:       itemsText,

    status:                "new",  // new | reviewed | ordered | customer_contacted | closed

    vendor:                "",
    order_number:          "",

    reviewed_by:           null,
    reviewed_at:           null,

    ordered_by:            null,
    ordered_at:            null,

    customer_contacted_by: null,
    customer_contacted_at: null,

    // Office-side internal log (vendor confirmation, freight ETA, etc.).
    // Replaces the previous ambiguous `notes` + `request_notes` pair.
    // The admin UI reads `admin_notes || notes` for back-compat on docs
    // that pre-date this rename.
    admin_notes:           "",

    // ---- Routing / fulfillment audit ----
    // Every new supply request is assigned to Kirby by default. The
    // admin UI lets ops reassign; fulfilled_* stamps fire when admin
    // clicks "Mark Fulfilled" (status: "closed").
    assigned_to:           SUPPLY_ASSIGNED_TO,
    assigned_to_name:      SUPPLY_ASSIGNED_TO_NAME,
    assigned_to_email:     SUPPLY_ASSIGNED_TO_EMAIL,
    fulfilled_at:          null,
    fulfilled_by:          null,

    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    await db.collection(SUPPLY_COLLECTION).doc(requestId).create(request);
    logger.info("supply_requests created", {
      request_id:    requestId,
      submission_id: submissionId,
      customer_slug: doc.customer_slug
    });
    // Admin-only notice — non-blocking. Body matches the user spec:
    // "[Tech] requested supplies for [Customer]: [request_text]".
    const techName = doc.tech_display_name || doc.tech_slug || "Tech";
    const custName = doc.customer_name || doc.customer_slug || "(unknown customer)";
    await createSupplyNotice({
      supply_request_id: requestId,
      source:            "dcr",
      tech_slug:         doc.tech_slug || "",
      tech_name:         techName,
      customer_slug:     doc.customer_slug || "",
      customer_name:     custName,
      body:              techName + " requested supplies for " + custName + ": " + itemsText
    });
  } catch (err) {
    // gRPC ALREADY_EXISTS = 6. We swallow it because a retry is correct —
    // admin-side edits should NOT be overwritten by a re-fire of the same
    // DCR submission.
    const msg = (err && err.message) || String(err);
    if ((err && err.code === 6) || /ALREADY_EXISTS|already exists/i.test(msg)) {
      logger.info("supply_requests already existed for submission — skipping create", {
        request_id: requestId, submission_id: submissionId
      });
    } else {
      logger.error("supply_requests create failed", {
        error: msg, submission_id: submissionId
      });
    }
  }
}

/* ----------------------------- Zapier ----------------------------- */

// Build a clean, flat-ish payload for Zapier — easy to map into Gmail / Google Sheets / etc.
// Top-level `photo_urls` and `signature_url` are duplicated for direct image-tag mapping;
// the original `photos` array is kept too in case a Zap needs richer metadata.
//
// Photo array handling deserves a note: the wire format is a true JSON
// array (`photo_urls: ["url1", "url2", ...]`), but Zapier's default
// renderer joins arrays with `,` when the field is dropped into any
// string-context downstream step (Gmail body, Slack message, Sheets cell).
// That's why a Zap built once-and-forgotten ends up showing only the
// first photo from an "url1,url2,url3" string. To make Zap-builder life
// easier we ALSO emit flat per-photo fields (`photo_url_1`, `photo_url_2`,
// …) and a `photo_count`, so the Zap can drag-and-drop each URL by name
// without learning Zapier's `photo_urls__1` array-index syntax.
//
// `photo_urls_csv` is an explicit comma-joined helper for the rare case
// where a Zap step genuinely wants the CSV form (legacy delivery
// templates, debug spreadsheets, etc.). The array stays canonical.
function buildZapierPayload(doc, submissionId) {
  const submittedAt =
    (doc.submission_meta && doc.submission_meta.client_submitted_at) ||
    new Date().toISOString();
  const formData = doc.form_data || {};
  const aff      = doc.affirmation || {};

  const projectId =
    (admin.app().options && admin.app().options.projectId) ||
    process.env.GCLOUD_PROJECT ||
    "pioneer-dcr-hub";
  const storageBucket =
    (admin.app().options && admin.app().options.storageBucket) ||
    `${projectId}.appspot.com`;

  const onTimeBudget = formData.on_time_budget !== false;

  // ---- Photo URL normalisation ----
  //
  // Build the three views Zapier consumers can choose from:
  //   1. photo_urls         — canonical JSON array (works with Zapier's
  //                           "Line Items" parsing in Code/Looping Zaps).
  //   2. photo_url_1..N     — flat numbered fields for drag-and-drop
  //                           mapping into Gmail / Slack templates.
  //   3. photo_urls_csv     — comma-joined string for legacy steps that
  //                           expect a single text field.
  //
  // We cap the flat fields at MAX_FLAT_PHOTO_FIELDS so the payload size
  // stays predictable. The DCR form caps uploads well below this; if a
  // future change raises the upload cap, bump this constant accordingly.
  const photoUrlsArr = Array.isArray(doc.photo_urls)
    ? doc.photo_urls.filter(function (u) { return typeof u === "string" && u; })
    : [];
  const MAX_FLAT_PHOTO_FIELDS = 10;
  const flatPhotoFields = {};
  for (let i = 0; i < Math.min(photoUrlsArr.length, MAX_FLAT_PHOTO_FIELDS); i++) {
    flatPhotoFields["photo_url_" + (i + 1)] = photoUrlsArr[i];
  }

  return {
    submission_id:         submissionId,
    schema_version:        doc.schema_version,
    source:                doc.source,

    // Field names match the Firestore doc verbatim so Zapier merge tags work
    // identically whether the Zap reads from the webhook payload or from a
    // Firestore lookup of the same submission_id.
    customer_slug:         doc.customer_slug || "",
    customer_name:         doc.customer_name || "",
    customer_email:        doc.customer_email || "",
    location_name:         doc.location_name || "",
    // Customer-level DCR-email opt-out flag. Zapier should branch on this
    // BEFORE the Gmail "Send Customer Email" action — when false, skip the
    // customer email step but keep internal Slack / Sheets / GHL paths
    // running. Default true when missing (back-compat for old docs).
    customer_dcr_email_enabled: doc.customer_dcr_email_enabled !== false,

    tech_slug:             doc.tech_slug || "",
    tech_display_name:     doc.tech_display_name || "",
    tech_experience_level: doc.tech_experience_level || "",

    clean_date:            doc.clean_date || "",
    submitted_at:          submittedAt,
    notes:                 doc.notes || "",

    occupancy:             doc.occupancy || formData.occupancy_level || "",

    time_budget: {
      on_budget: onTimeBudget,
      reasons:   onTimeBudget ? [] : (formData.time_budget_reasons || [])
    },

    // Customer-facing top-level field: ALWAYS EMPTY. Supply requests
    // are an internal operational concern (routed through Kirby via
    // /supply_requests + /supply_notices) and must not appear in any
    // customer email template that references {{supply_requests}}.
    // The `internal_supply_requests` block below carries the data for
    // admin-only Zap branches (Slack ping to Kirby etc.).
    supply_requests: "",
    internal_supply_requests: {
      needs_supplies:        formData.needs_supplies === true,
      request_text:          formData.needs_supplies ? (formData.supply_request_text || "") : "",
      assigned_to:           SUPPLY_ASSIGNED_TO,
      assigned_to_name:      SUPPLY_ASSIGNED_TO_NAME,
      assigned_to_email:     SUPPLY_ASSIGNED_TO_EMAIL,
      audience:              "admin"
    },

    problem: formData.has_problem ? (formData.problem || null) : null,

    checklist: formData.checklist || [],

    // Canonical JSON array. Zaps using "Looping by Zapier" or a Code
    // step receive each URL as a separate iteration.
    photo_urls:     photoUrlsArr,
    // Original objects with metadata (filename, content_type, size, etc.)
    // for Zaps that need more than the URL.
    photos:         Array.isArray(doc.photos) ? doc.photos : [],
    // Convenience flat fields: photo_url_1, photo_url_2, ... up to
    // MAX_FLAT_PHOTO_FIELDS. Only present for slots that actually have a
    // URL — absent keys keep Gmail's image-tag mapping clean (a missing
    // `{{photo_url_4}}` just won't render rather than producing a broken
    // <img src="">).
    ...flatPhotoFields,
    // Total photo count for "Photos attached: N" templating and as a
    // boolean source for has-photos branching in the Zap.
    photo_count:    photoUrlsArr.length,
    // Legacy / explicit helper for any Zap step that genuinely wants the
    // CSV form. Empty string when no photos.
    photo_urls_csv: photoUrlsArr.join(","),

    // Top-level for trivial Gmail <img src="{{signature_url}}"> mapping.
    signature_name: aff.signature_name || "",
    signature_url:  aff.signature_url  || "",

    // Full affirmation block for richer Zaps.
    affirmation: {
      affirmed:       aff.affirmed === true,
      affirmed_text:  aff.affirmed_text || "",
      signature_name: aff.signature_name || "",
      signature_url:  aff.signature_url  || "",
      signed_at:      aff.signed_at      || null
    },

    // Phase-2-ready: Zapier (or anything downstream) can flip these as the
    // review funnel runs. Field name matches the Firestore doc (`feedback`).
    // Always present so Zap field-mappings don't break on absent keys.
    feedback: doc.feedback || {
      review_requested:     false,
      review_link_sent:     false,
      customer_rating:      null,
      customer_feedback_id: null
    },
    review_links: doc.review_links || { five_star_url: "", issue_url: "" },

    // Operational metadata, mirrored from the saved doc so Zapier doesn't
    // need a separate Firestore lookup to find user_agent / app_version /
    // server_received_at when triaging an issue.
    submission_meta: doc.submission_meta || {},

    // Pre-send zapier state (the value at the time we build this payload).
    // After the POST completes, Firestore's `zapier.*` reflects the actual
    // status. This field is included here so the Zap can be field-mapped
    // identically whether reading the webhook payload OR a Firestore replay.
    zapier: doc.zapier || {
      attempted:   false,
      status:      "not_configured",
      status_code: null,
      error:       null,
      sent_at:     null
    },

    firebase: {
      project_id:           projectId,
      firestore_collection: FIRESTORE_COLLECTION,
      storage_bucket:       storageBucket
    }
  };
}

// Materialise dcr_issues docs for one DCR submission.
//
// Detection rules (matches the spec for the Issues tab):
//   • Any checklist item with item.status === "issue" → one issue
//   • doc.form_data.has_problem === true AND doc.form_data.problem → one issue
//   • doc.form_data.problems[] (future plural shape) → one per entry
//
// Deterministic IDs prevent duplicates on retry:
//   • Checklist: iss_{submission_id}_chk_{sectionIdx}-{itemIdx}
//   • Singular problem section: iss_{submission_id}_prob
//   • Array problems: iss_{submission_id}_prob_{i}
//
// Upsert policy: if a dcr_issues doc already exists for the same
// deterministic ID, we only refresh the IMMUTABLE facts (customer/tech
// slugs, issue summary, source) and `updated_at`. We DO NOT clobber the
// workflow fields (status, reviewed_by, admin_notes, etc.) — those are
// owned by the admin once they touch the issue. On first write, status
// defaults to "new" and the workflow timestamps are null.
async function createDcrIssuesForSubmission(submissionId, doc) {
  if (!submissionId || !doc) return;
  const formData = doc.form_data || {};
  const now      = admin.firestore.FieldValue.serverTimestamp();

  // Build the candidate list before any Firestore I/O so we can short-
  // circuit when there's nothing to do.
  const candidates = [];

  // 1. Checklist items in "issue" state.
  const sections = Array.isArray(formData.checklist) ? formData.checklist : [];
  sections.forEach(function (section, sIdx) {
    const items = Array.isArray(section && section.items) ? section.items : [];
    items.forEach(function (item, iIdx) {
      if (!item || item.status !== "issue") return;
      const issueId = "iss_" + submissionId + "_chk_" + sIdx + "-" + iIdx;
      candidates.push({
        issue_id:       issueId,
        source:         "checklist",
        issue_type:     (section && section.section_label) || "Checklist issue",
        issue_summary:  (item.label || "Checklist item") +
                        (item.note ? " — " + String(item.note).slice(0, 400) : ""),
        issue_location: section && section.section_label || ""
      });
    });
  });

  // 2. Problem section — singular shape (current) AND plural (future-proof).
  if (formData.has_problem === true) {
    const probs = Array.isArray(formData.problems) ? formData.problems
                : (formData.problem ? [formData.problem] : []);
    probs.forEach(function (p, i) {
      if (!p || typeof p !== "object") return;
      const slot = Array.isArray(formData.problems) ? ("_" + i) : "";
      const issueId = "iss_" + submissionId + "_prob" + slot;
      const cat = p.category || p.problem_category || "Problem";
      const sum = p.summary || p.problem_summary || p.title || "";
      const det = p.details || p.problem_details || "";
      const loc = p.location || p.problem_location || "";
      candidates.push({
        issue_id:       issueId,
        source:         "problem",
        issue_type:     String(cat).slice(0, 100),
        issue_summary:  (sum || "Problem reported") +
                        (det ? " — " + String(det).slice(0, 400) : ""),
        issue_location: String(loc).slice(0, 200)
      });
    });
  }

  if (candidates.length === 0) return;

  // Shared immutable facts pulled from the DCR doc — written on both
  // first-create AND re-runs so corrected names/slugs propagate without
  // resetting workflow state.
  const facts = {
    submission_id:     submissionId,
    customer_slug:     doc.customer_slug     || "",
    customer_name:     doc.customer_name     || "",
    location_name:     doc.location_name     || "",
    tech_slug:         doc.tech_slug         || "",
    tech_display_name: doc.tech_display_name || "",
    clean_date:        doc.clean_date        || ""
  };

  // Sequential upserts — N is small (typical DCR: 0-3 issues), and
  // sequential keeps log lines orderly and avoids per-issue tx overhead.
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ref = db.collection(ISSUES_COLLECTION).doc(c.issue_id);
    try {
      const snap = await ref.get();
      if (snap.exists) {
        // Refresh immutable facts + this run's summary in case the source
        // DCR was edited admin-side; preserve all workflow state.
        await ref.update(Object.assign({}, facts, {
          issue_type:     c.issue_type,
          issue_summary:  c.issue_summary,
          issue_location: c.issue_location,
          source:         c.source,
          updated_at:     now
        }));
      } else {
        await ref.set(Object.assign({}, facts, {
          issue_id:               c.issue_id,
          issue_type:             c.issue_type,
          issue_summary:          c.issue_summary,
          issue_location:         c.issue_location,
          source:                 c.source,
          status:                 "new",
          reviewed_by:            null,
          reviewed_at:            null,
          customer_contacted_by:  null,
          customer_contacted_at:  null,
          resolved_by:            null,
          resolved_at:            null,
          admin_notes:            "",
          created_at:             now,
          updated_at:             now,
          updated_by:             "submitDcrV1"
        }));
      }
    } catch (err) {
      logger.warn("createDcrIssuesForSubmission: upsert failed", {
        submission_id: submissionId, issue_id: c.issue_id,
        error: err && err.message
      });
    }
  }
  logger.info("submitDcrV1 dcr_issues materialised", {
    submission_id: submissionId, issue_count: candidates.length
  });
}

async function sendToZapier(url, payload) {
  const result = {
    attempted:   false,
    status:      "not_configured",
    status_code: null,
    error:       null,
    sent_at:     null
  };

  if (!url) return result;

  result.attempted = true;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), ZAPIER_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal
    });
    clearTimeout(timeoutId);

    result.status_code = r.status;
    result.sent_at     = new Date().toISOString();

    if (r.ok) {
      result.status = "sent";
    } else {
      result.status = "failed";
      const body = await r.text().catch(() => "");
      result.error = `HTTP ${r.status}${body ? `: ${body.slice(0, 300)}` : ""}`;
    }
  } catch (err) {
    clearTimeout(timeoutId);
    result.status = "failed";
    result.sent_at = new Date().toISOString();
    result.error = err && err.name === "AbortError"
      ? `Request timed out after ${ZAPIER_TIMEOUT_MS}ms`
      : ((err && err.message) || String(err));
  }

  return result;
}

/* ----------------------------- Tech Hub public view ----------------------------- */

// Helpers for tech-hub responses.
/* Canonical "did the tech finish on budget?" reader.
 *
 * Returns:
 *   true  → on budget
 *   false → over budget
 *   null  → unknown / no signal (treat as "—" in UIs)
 *
 * Reads in order of preference:
 *   1. doc.time_budget.on_budget          — written by submitDcrV1 server-side
 *   2. doc.form_data.time_budget.on_budget — same data, nested (very early docs)
 *   3. doc.form_data.on_time_budget        — raw client value (bool or "yes"/"no")
 *   4. doc.on_time_budget                  — top-level legacy fallback
 *
 * Anything else (missing, undefined, non-boolean string) → null. The UI
 * treats null as "Unknown" and excludes the doc from percentage math.
 *
 * Keep this function in sync with the same-name helper in public/admin.js.
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

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function")   return ts.toDate().getTime();
  if (typeof ts.seconds === "number")    return ts.seconds * 1000;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return isNaN(ms) ? 0 : ms;
  }
  if (ts instanceof Date) return ts.getTime();
  return 0;
}
function tsToIso(ts) {
  const ms = tsToMs(ts);
  return ms ? new Date(ms).toISOString() : null;
}

// Public read-only view for the Cleaning Tech Hub at /tech.html. Reads through
// the Admin SDK (bypasses rules), filters out anything techs should not see,
// and returns a compact JSON payload. No authentication in v1 — the surface
// is intentionally tech-safe (no admin notes, no costing, no per-employee
// performance data). Lock this down with a tech auth tier in a future pass.
exports.techHubViewV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  // CORS — identical pattern to submitDcrV1.
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // Staff auth gate — same as submitDcrV1. Anonymous reads of this endpoint
  // are rejected at the function boundary, not just at the rules layer.
  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const rawSlug = (req.query.customer_slug || "").toString().trim();
  if (!rawSlug || !/^[a-z0-9-]{1,80}$/i.test(rawSlug)) {
    res.status(400).json({ ok: false, error: "customer_slug query param is required (kebab-case)" });
    return;
  }
  const customerSlug = rawSlug.toLowerCase();

  try {
    // Supply requests use a single-field where — no composite index needed.
    // DCRs use a where + orderBy so the .limit(50) window is deterministically
    // the newest 50 (critical for last_clean_date accuracy on high-traffic
    // customers with >50 lifetime DCRs). That combination requires a
    // composite index on (customer_slug ASC, created_at DESC) — see
    // firestore.indexes.json.
    //
    // If the index hasn't finished building yet, Firestore throws
    // FAILED_PRECONDITION. We catch it and re-issue the unordered query so
    // the tech hub keeps responding through the build window — `last_clean_date`
    // is briefly approximate until the index is enabled (~minutes).
    async function fetchDcrsForCustomer() {
      try {
        return await db.collection(FIRESTORE_COLLECTION)
          .where("customer_slug", "==", customerSlug)
          .orderBy("created_at", "desc")
          .limit(50)
          .get();
      } catch (err) {
        logger.warn("dcr_submissions composite index missing — falling back to unordered query", {
          error: err && err.message,
          customer_slug: customerSlug
        });
        return await db.collection(FIRESTORE_COLLECTION)
          .where("customer_slug", "==", customerSlug)
          .limit(50)
          .get();
      }
    }
    const [customerSnap, supplySnap, dcrSnap, notesSnap, inspectionsSnap, serviceRecoveriesSnap, customerSecureSnap] = await Promise.all([
      db.collection("customers").doc(customerSlug).get(),
      db.collection("supply_requests")
        .where("customer_slug", "==", customerSlug)
        .limit(50)
        .get(),
      fetchDcrsForCustomer(),
      // Customer cleaning notes — tribal operational knowledge for this
      // location. firestore.rules deny direct client reads from techs;
      // surfacing them through this function preserves the per-tech
      // assigned-customer gate that verifyStaffOrReject already enforces.
      db.collection("customer_notes")
        .where("customer_slug", "==", customerSlug)
        .limit(50)
        .get(),
      // Inspections — admin-only at the rules layer. Reading via Admin
      // SDK here lets techs see an aggregate quality view of their
      // assigned customers without leaking inspector identity or
      // per-task scores (filtered before emit, see below).
      db.collection("inspections")
        .where("customer_slug", "==", customerSlug)
        .limit(50)
        .get(),
      // Service recoveries — used to surface a "Service Recovery
      // Needed" pill when any open SR exists for this customer. Same
      // admin-only rules, same Admin-SDK bypass pattern.
      db.collection("service_recoveries")
        .where("customer_slug", "==", customerSlug)
        .limit(20)
        .get(),
      // customer_secure — admin-only at the rules layer. Admin SDK
      // reads it for this endpoint and EMITS ONLY a tight whitelist
      // of operational security fields techs need in the field. Raw
      // Deputy notes, emergency contacts, alarm-company contacts, and
      // all admin metadata are explicitly NOT forwarded (see the
      // `customer.securityInfo` block below).
      db.collection("customer_secure").doc(customerSlug).get()
    ]);

    /* ----- Customer info (tech-safe subset) ----- */
    let customer = null;
    if (customerSnap.exists) {
      const c = customerSnap.data() || {};
      customer = {
        slug:              c.slug || c.customer_slug || customerSnap.id,
        customer_name:     c.customer_name || c.name || "",
        location_name:     c.location_name || c.customer_name || c.name || "",
        // Whether daily DCR emails go to the customer. Techs should know this
        // so they don't make promises about emails the customer never gets.
        dcr_email_enabled: c.dcr_email_enabled !== false,
        active:            c.active !== false,
        // ---- PUBLIC SOP fields (flat camelCase, tech-safe) ----
        // Imported from Deputy via scripts/seedCustomerSopsFromDeputy.js.
        // Sensitive content (alarm/door/gate codes, emergency contacts,
        // raw Deputy notes) lives in the SEPARATE customer_secure
        // collection — admin-only by firestore.rules — and is
        // INTENTIONALLY NOT returned by this endpoint. The
        // `hasSecureSop` flag below tells the client whether such a
        // sibling doc exists, without revealing any of its content.
        // None of these fields enter the customer-facing DCR email path.
        sopStatus:         String(c.sopStatus || ""),
        sopUpdatedAt:      c.sopUpdatedAt || null,
        sopSource:         String(c.sopSource || ""),
        // v1 tech-view source of truth: redacted full-text Deputy notes.
        // Seed strips code-bearing and emergency-contact lines and
        // scrubs digit-runs before this field is written. Codes never
        // appear here; if they ever do, that's a seed-side bug.
        sopRawPublicText:  String(c.sopRawPublicText || ""),
        sopQuickGlance:    Array.isArray(c.sopQuickGlance) ? c.sopQuickGlance : [],
        sopSections:       Array.isArray(c.sopSections)    ? c.sopSections    : [],
        sopDoNot:          Array.isArray(c.sopDoNot)       ? c.sopDoNot       : [],
        sopMustDo:         Array.isArray(c.sopMustDo)      ? c.sopMustDo      : [],
        sopPublicNotes:    Array.isArray(c.sopPublicNotes) ? c.sopPublicNotes : [],
        hasSecureSop:      c.hasSecureSop === true
        // INTENTIONALLY OMITTED from the tech view:
        //   • alarmCompanyNotes / emergencyContacts / rawDeputyNotes
        //     — admin-only; remain in customer_secure and never emit.
        //   • customer_email          (private to admins)
        //   • review_links            (operational, admin-only)
        //   • slack_channel           (internal)
        //   • notes / archived_*      (internal)
        //   • updated_*               (internal)
      };

      // ---- TECH-VISIBLE security info (whitelist only) ----
      // The customer_secure doc is admin-only at the rules layer, but
      // techs operationally need alarm/door/gate codes and key/fob
      // instructions when they're standing at the customer's door with
      // an alarm panel beeping. This block reads the secure doc via the
      // Admin SDK (which bypasses rules) and forwards ONLY the parsed
      // operational fields — never raw notes, never emergency contacts,
      // never admin metadata, never the alarm company contact.
      //
      // If a future seed parser adds more sensitive buckets to
      // customer_secure (e.g. monitoring station passphrase), they
      // will NOT auto-leak: only the explicitly-named fields below are
      // copied out, everything else stays admin-only.
      const cleanStringArray = function (v) {
        if (!Array.isArray(v)) return [];
        const out = [];
        for (let i = 0; i < v.length; i++) {
          const s = (v[i] == null) ? "" : String(v[i]).trim();
          if (s) out.push(s);
        }
        return out;
      };
      if (customerSecureSnap && customerSecureSnap.exists) {
        const s = customerSecureSnap.data() || {};
        const alarmCodes           = cleanStringArray(s.alarmCodes);
        const doorCodes            = cleanStringArray(s.doorCodes);
        const gateCodes            = cleanStringArray(s.gateCodes);
        const fobCodes             = cleanStringArray(s.fobCodes);   // future bucket; empty today
        const keyNotes             = cleanStringArray(s.keyFobNotes); // seed bucket name
        const securityInstructions = cleanStringArray(s.secureInstructions);
        // Phase 1g additions — admin-editable buckets, tech-visible. The
        // admin-only buckets (emergencyContacts, alarmCompanyNotes,
        // rawDeputyNotes) are EXPLICITLY NOT forwarded.
        const lockboxCodes         = cleanStringArray(s.lockboxCodes);
        const disarmInstructions   = cleanStringArray(s.disarmInstructions);
        const armInstructions      = cleanStringArray(s.armInstructions);
        const hasInfo = !!(
          alarmCodes.length || doorCodes.length || gateCodes.length ||
          fobCodes.length || keyNotes.length || securityInstructions.length ||
          lockboxCodes.length || disarmInstructions.length || armInstructions.length
        );
        customer.securityInfo = {
          hasInfo:              hasInfo,
          alarmCodes:           alarmCodes,
          disarmInstructions:   disarmInstructions,
          doorCodes:            doorCodes,
          gateCodes:            gateCodes,
          lockboxCodes:         lockboxCodes,
          fobCodes:             fobCodes,
          keyNotes:             keyNotes,
          armInstructions:      armInstructions,
          securityInstructions: securityInstructions
        };
      } else {
        customer.securityInfo = {
          hasInfo: false,
          alarmCodes: [], disarmInstructions: [], doorCodes: [], gateCodes: [],
          lockboxCodes: [], fobCodes: [], keyNotes: [], armInstructions: [],
          securityInstructions: []
        };
      }
    }

    /* ----- Supply requests — OPEN statuses only, admin_notes scrubbed ----- */
    const OPEN_STATUSES = ["new", "reviewed", "customer_contacted", "ordered"];
    const supplyRequests = supplySnap.docs
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (r) { return OPEN_STATUSES.indexOf(r.status || "new") >= 0; })
      .map(function (r) {
        return {
          request_id:      r.request_id || r.id,
          requested_items: r.requested_items || "",   // ← cleaner-side text, fine to show
          status:          r.status || "new",
          created_at:      tsToIso(r.created_at),
          vendor:          r.vendor || "",
          order_number:    r.order_number || ""
          // INTENTIONALLY OMITTED:
          //   • admin_notes (office-only log — costs, vendor calls, follow-ups)
          //   • notes / request_notes (legacy)
          //   • reviewed_by / ordered_by / customer_contacted_by (internal audit)
          //   • updated_by / updated_at (internal audit)
        };
      })
      .sort(function (a, b) {
        return Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
      });

    /* ----- Recent issues from DCRs — last 30 days, customer-relevant only ----- */
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentIssues = [];
    let dcrCount30 = 0;
    let lastCleanDate = "";

    dcrSnap.docs.forEach(function (d) {
      const data = d.data() || {};
      const createdMs = tsToMs(data.created_at);
      if (createdMs && createdMs >= cutoffMs) dcrCount30 += 1;
      if (data.clean_date && data.clean_date > lastCleanDate) lastCleanDate = data.clean_date;

      // Only include items from DCRs in the last 30 days.
      if (!createdMs || createdMs < cutoffMs) return;

      // Issue items inside the checklist (need a note to be customer-relevant).
      const sections = (data.form_data && data.form_data.checklist) || [];
      sections.forEach(function (section) {
        (section.items || []).forEach(function (item) {
          if (item && item.status === "issue" && item.note) {
            recentIssues.push({
              clean_date:    data.clean_date || "",
              tech_display_name: data.tech_display_name || "",
              section_label: section.section_label || "",
              item_label:    item.label || "",
              note:          item.note || ""
            });
          }
        });
      });

      // Problem-section reports.
      const formData = data.form_data || {};
      if (formData.has_problem && formData.problem) {
        const p = formData.problem;
        recentIssues.push({
          clean_date:    data.clean_date || "",
          tech_display_name: data.tech_display_name || "",
          section_label: "Problem reported",
          item_label:    (p.category || "Issue"),
          note:          p.summary || p.details || "",
          location:      p.location || ""
        });
      }
      // INTENTIONALLY OMITTED from each DCR:
      //   • photos / photo_urls   (already public-readable via Storage but
      //                            no need to dump them here)
      //   • signature_url         (PII — not for tech view)
      //   • affirmation block     (internal audit)
      //   • customer_email        (admin-only)
      //   • zapier / delivery     (internal observability)
      //   • problem.our_fault     (internal blame attribution)
    });

    recentIssues.sort(function (a, b) {
      return (b.clean_date || "").localeCompare(a.clean_date || "");
    });

    /* ----- Stats for the snapshot card ----- */
    const stats = {
      open_supply_requests: supplyRequests.length,
      open_issues_30d:      recentIssues.length,
      recent_dcr_count:     dcrCount30,
      last_clean_date:      lastCleanDate || null
    };

    /* ----- Budget summary (tech-facing — supportive tone) -----
     *
     * Uses the same dcrSnap (last 50 customer DCRs, newest first) the rest
     * of this handler already reads. No extra Firestore reads.
     *
     * Shape returned to the client:
     *   {
     *     last_clean: "on" | "over" | "unknown",
     *     current_month: { on: n, total: n, pct: 0-100 } | null
     *   }
     *
     * Future caching note: once dcr_submissions grows past a few thousand
     * docs per customer, replace this loop with a daily-aggregated
     * `customer_metrics/{slug}` doc and read that here.
     */
    function buildBudgetSummary(docs /* newest-first */) {
      if (!docs || docs.length === 0) {
        return { last_clean: "unknown", current_month: null };
      }

      // Most-recent DCR's status (whatever the snapshot order is — we
      // re-sort defensively in case the fallback unordered query landed).
      let newest = null;
      let newestMs = -1;
      for (let i = 0; i < docs.length; i++) {
        const ms = tsToMs(docs[i].created_at);
        if (ms != null && ms > newestMs) { newestMs = ms; newest = docs[i]; }
      }
      const lastVal = getOnBudget(newest);
      const last_clean = lastVal === true ? "on" : lastVal === false ? "over" : "unknown";

      // Current month — calendar month bounded by the customer's local
      // tz is overkill for this UI; we use the server's UTC month, which
      // is close enough for "this month so far" framing.
      const now = new Date();
      const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      let monthOn = 0, monthTotal = 0;
      for (let i = 0; i < docs.length; i++) {
        const ms = tsToMs(docs[i].created_at);
        if (ms == null || ms < monthStartMs) continue;
        const v = getOnBudget(docs[i]);
        if (v === null) continue;       // unknown — exclude from %
        monthTotal += 1;
        if (v === true) monthOn += 1;
      }
      const current_month = monthTotal === 0
        ? null
        : { on: monthOn, total: monthTotal, pct: Math.round((monthOn / monthTotal) * 100) };

      return { last_clean: last_clean, current_month: current_month };
    }
    const budget = buildBudgetSummary(dcrSnap.docs.map(function (d) { return d.data() || {}; }));

    /* ----- Feedback — placeholder until the feedback collection exists ----- */
    // Future: read from /feedback or /customer_feedback. For v1, empty array
    // is returned so the UI can show its "No recent feedback yet" state.
    const feedback = [];

    /* ----- Customer Quality (tech-safe) -----
       Aggregate view derived from /inspections for this customer.
       Public-safe trimming:
         • NO inspector identity (no inspector_email, inspector_name)
         • NO per-task / per-area breakdown is exposed
         • Low-area names surface ONLY when score < 3, and only as
           broad category labels ("Floors", "Bathrooms")
         • Notes are admin-only — never echoed here
       Rolling overall_score is calculated over the last 30 days. The
       recent_inspections list shows the most-recent 3 of any age so a
       customer that hasn't been inspected in a while still gets
       context on what we last knew. */
    const AREA_LABELS_PUBLIC = {
      offices:      "Offices",
      bathrooms:    "Bathrooms",
      entry_foyer:  "Entry / Foyer",
      lunchroom:    "Lunchroom",
      common_areas: "Common Areas",
      trash:        "Trash",
      floors:       "Floors",
      dusting:      "Dusting",
      glass:        "Glass",
      touchpoints:  "Touchpoints",
      supplies:     "Supplies"
    };
    const QUALITY_WINDOW_MS         = 30 * 24 * 60 * 60 * 1000;
    const QUALITY_LOW_AREA_THRESHOLD = 2;   // area.score <= 2 → "needs attention"
    const QUALITY_LOW_OVERALL        = 3;   // overall.score < 3 → surface low_areas
    const QUALITY_FIVE_STAR          = 4.8;

    const inspectionDocs = inspectionsSnap.docs
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .sort(function (a, b) {
        return tsToMs(b.inspection_submitted_at) - tsToMs(a.inspection_submitted_at);
      });

    // Rolling 30-day overall — average over docs in the window with a
    // numeric overall_score.
    const cutoffQ = Date.now() - QUALITY_WINDOW_MS;
    const windowDocs = inspectionDocs.filter(function (d) {
      const ms = tsToMs(d.inspection_submitted_at);
      return ms >= cutoffQ && typeof d.overall_score === "number";
    });
    const rollingAvg = windowDocs.length
      ? Math.round((windowDocs.reduce(function (s, d) { return s + d.overall_score; }, 0) / windowDocs.length) * 10) / 10
      : null;

    const lastInspAt = inspectionDocs.length
      ? tsToIso(inspectionDocs[0].inspection_submitted_at)
      : null;

    // Recent 3 — emit only public-safe fields. low_areas only when the
    // overall is "needs attention" so day-to-day high-score cards
    // never read as blame.
    const recentInspections = inspectionDocs.slice(0, 3).map(function (d) {
      const score = typeof d.overall_score === "number" ? d.overall_score : null;
      const out = {
        id:                  d.id,
        inspection_date:     d.inspection_date || (tsToIso(d.inspection_submitted_at) || "").slice(0, 10),
        overall_score:       score != null ? Math.round(score * 10) / 10 : null,
        is_five_star:        score != null && score >= QUALITY_FIVE_STAR,
        low_areas:           []
      };
      if (score != null && score < QUALITY_LOW_OVERALL && d.area_scores) {
        Object.keys(d.area_scores).forEach(function (slug) {
          const a = d.area_scores[slug];
          if (a && typeof a.score === "number" && a.score <= QUALITY_LOW_AREA_THRESHOLD) {
            out.low_areas.push(AREA_LABELS_PUBLIC[slug] || slug);
          }
        });
      }
      return out;
    });

    const openSrCount = serviceRecoveriesSnap.docs.reduce(function (n, d) {
      const s = String((d.data() || {}).status || "open").toLowerCase();
      return (s === "open" || s === "in_progress") ? n + 1 : n;
    }, 0);

    // Per-customer streak — consecutive newest inspections with
    // overall_score >= STREAK_THRESHOLD. Same semantics as the
    // company-wide streak surfaced by pioneerQualityViewV1; tech-safe.
    const customerStreak = walkInspectionStreak(inspectionDocs, STREAK_THRESHOLD);

    const quality = {
      overall_score:                rollingAvg,
      count:                        windowDocs.length,
      window_days:                  30,
      last_inspection_at:           lastInspAt,
      recent_inspections:           recentInspections,
      has_open_service_recovery:    openSrCount > 0,
      open_service_recovery_count:  openSrCount,
      customer_streak:              customerStreak,
      streak_threshold:             STREAK_THRESHOLD
    };

    /* ----- Customer notes — tribal operational knowledge ----- */
    // Filter out archived (active === false); sort newest-updated first.
    // Tech-safe shape only: omits internal audit fields (created_by /
    // updated_by stays — techs see WHO last touched the note, which is
    // useful "ask Karen, she wrote this" context).
    const customerNotes = notesSnap.docs
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (n) { return n.active !== false; })
      .map(function (n) {
        return {
          id:              n.id,
          customer_slug:   n.customer_slug || customerSlug,
          title:           n.title || "",
          body:            n.body || "",
          category:        n.category || "Other",
          updated_by:      n.updated_by || n.created_by || "",
          updated_at:      tsToIso(n.updated_at)      || tsToIso(n.created_at),
          last_reviewed_at: tsToIso(n.last_reviewed_at),
          last_reviewed_by: n.last_reviewed_by || "",
          review_due_at:   tsToIso(n.review_due_at)
        };
      })
      .sort(function (a, b) {
        return Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0);
      });

    return res.status(200).json({
      ok: true,
      generated_at:    new Date().toISOString(),
      customer:        customer,
      stats:           stats,
      budget:          budget,
      quality:         quality,
      supply_requests: supplyRequests.slice(0, 10),
      recent_issues:   recentIssues.slice(0, 10),
      feedback:        feedback,
      customer_notes:  customerNotes
    });
  } catch (err) {
    logger.error("techHubViewV1 failed", { error: err && err.message, customer_slug: customerSlug });
    return res.status(500).json({ ok: false, error: "Failed to load tech hub view" });
  }
});

/* ----------------------------- handler ----------------------------- */

// `cors: false` tells Functions v2 not to attach its own CORS middleware —
// we set the headers ourselves so the same headers go out on every response,
// including 4xx/5xx errors and the OPTIONS preflight.
// Phase 32 — secrets needed by the submitDcrV1 native-email auto-send
// hook. Declared here so the onRequest({ secrets: [...] }) binding below
// can reference them at module-load time (defineSecret must run before
// the onRequest call that lists it). Same const names are reused later
// by generateAndSendDcrEmailV1 — defineSecret is single-call-per-name,
// so do NOT re-declare further down.
const OPENAI_API_KEY             = defineSecret("OPENAI_API_KEY");
const GMAIL_SENDER_EMAIL         = defineSecret("GMAIL_SENDER_EMAIL");
const GMAIL_SERVICE_ACCOUNT_KEY  = defineSecret("GMAIL_SERVICE_ACCOUNT_KEY");
const KIRBY_ALERT_EMAIL          = defineSecret("KIRBY_ALERT_EMAIL");
const APRIL_ALERT_EMAIL          = defineSecret("APRIL_ALERT_EMAIL");

exports.submitDcrV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120,                                         // bumped from 60 to absorb the OpenAI + Gmail leg
  secrets: [OPENAI_API_KEY, GMAIL_SENDER_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY,
            KIRBY_ALERT_EMAIL, APRIL_ALERT_EMAIL]
}, async (req, res) => {
  // ---- CORS: set on every response, before any branching ----
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  // ---- Preflight: short-circuit before doing any work ----
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  // ---- Method gate ----
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // ---- Staff auth gate (NEW) ----
  // Requires a valid Firebase ID token on every submission. Allows
  // admins + active cleaning_techs. Anyone else gets 401/403 and the
  // submission is rejected before validation runs.
  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const payload = req.body;
  const errs = validatePayload(payload);
  if (errs.length) {
    logger.warn("submitDcrV1 validation failed", { errors: errs });
    return res.status(400).json({ ok: false, error: "Validation failed", details: errs });
  }

  // ---- Cleaning-tech assignment gate + server-derived tech identity ----
  // Admins bypass this check entirely (they can submit for any customer with
  // any tech identity — useful for office-side submissions). For cleaning_techs:
  //   1. Reject if the submitted customer_slug isn't in their
  //      assigned_customer_slugs[] on the cleaning_techs doc.
  //   2. Force-overwrite tech_slug + tech_display_name from the authenticated
  //      user's tech doc — the client can't lie about who submitted.
  //   3. Realign affirmation.signature_name to the authenticated display name.
  if (staff.role === "cleaning_tech") {
    const assigned = (staff.tech && Array.isArray(staff.tech.assigned_customer_slugs))
      ? staff.tech.assigned_customer_slugs.map(function (s) { return String(s || "").toLowerCase().trim(); })
      : [];
    const submittedSlug = String(payload.customer_slug || "").toLowerCase().trim();
    if (!submittedSlug || assigned.indexOf(submittedSlug) < 0) {
      logger.warn("submitDcrV1: tech submitted for unassigned customer", {
        tech_uid:               staff.uid,
        tech_email:             staff.email,
        submitted_customer_slug: payload.customer_slug,
        assigned_count:          assigned.length
      });
      return res.status(403).json({
        ok: false,
        error: "You are not assigned to this customer."
      });
    }
    const techSlug        = staff.tech.tech_slug || staff.tech.slug || staff.tech.id || "";
    const techDisplayName = staff.tech.display_name || staff.tech.tech_display_name || "";
    payload.tech_slug         = techSlug;
    payload.tech_display_name = techDisplayName;
    if (payload.affirmation && typeof payload.affirmation === "object") {
      payload.affirmation.signature_name = techDisplayName || payload.affirmation.signature_name;
    }
  }

  const submissionId = payload.submission_id;

  const doc = {
    ...payload,
    submission_id: submissionId,
    // Verified-server-side audit fields — set from the ID token, NOT from
    // the client payload. The client cannot spoof these.
    submitted_by_email: staff.email,
    submitted_by_uid:   staff.uid,
    auth_role:          staff.role,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };

  // Make client-side timestamps server-trustworthy.
  if (doc.submission_meta) {
    doc.submission_meta.client_submitted_at =
      doc.submission_meta.client_submitted_at || null;
    doc.submission_meta.server_received_at =
      admin.firestore.FieldValue.serverTimestamp();
  }

  // Seed `zapier` so the doc shape is consistent even when the webhook
  // is not yet configured. Updated below after the POST attempt.
  doc.zapier = {
    attempted:   false,
    status:      "not_configured",
    status_code: null,
    error:       null,
    sent_at:     null
  };

  try {
    // Use submission_id as the doc ID so retries are idempotent.
    await db.collection(FIRESTORE_COLLECTION).doc(submissionId).set(doc, { merge: false });
    logger.info("submitDcrV1 saved", {
      submission_id: submissionId,
      customer_slug: doc.customer_slug,
      tech_slug:     doc.tech_slug,
      photo_count:   (doc.photos || []).length
    });
  } catch (err) {
    logger.error("submitDcrV1 firestore write failed", { error: err.message, submission_id: submissionId });
    return res.status(500).json({ ok: false, error: "Failed to save DCR", message: err.message });
  }

  // Best-effort: materialise dcr_issues entries for this submission. Each
  // issue is a separate doc in `dcr_issues` keyed by a DETERMINISTIC id
  // so this step is safe to re-run if submitDcrV1 retries — same DCR →
  // same issue IDs → no duplicates. Failure here is logged but does NOT
  // fail the request: the DCR itself is already saved, and the office
  // can recover from the Recent DCRs tab if the issues materialisation
  // misses. See createDcrIssuesForSubmission() for the upsert policy
  // (workflow fields are preserved across re-runs).
  try {
    await createDcrIssuesForSubmission(submissionId, doc);
  } catch (err) {
    logger.warn("submitDcrV1 dcr_issues materialisation failed (DCR itself saved OK)", {
      submission_id: submissionId, error: err && err.message
    });
  }

  // ---- PioneerOps workflow writeback ----
  //
  // If the payload carried a pioneer_session_id (set by the Today's
  // Work workflow when the tech tapped Complete DCR), flip the
  // matching session from "working" → "needs_finish" and stamp the
  // DCR submission id + timestamp. Doc id == deputy_shift_id (1:1
  // with deputy_shift_cache).
  //
  // Best-effort: this writeback is a UI ergonomics nicety, NOT a
  // gate on the DCR. A failure here is logged but never affects the
  // success response. The tech can always finish work from the
  // session even if the writeback failed (the rules allow finishing
  // a session in "working" state — the state machine is permissive
  // on the way to "finished").
  const pioneerSessionId = String((payload && payload.pioneer_session_id) || "").trim();
  if (pioneerSessionId) {
    try {
      const sessionRef = db.collection("pioneer_work_sessions").doc(pioneerSessionId);
      // Read the session FIRST to compare DCR's selected customer
      // against whatever suggestion the sync stamped earlier. When
      // they differ, flag alias_review_needed so admin can refine
      // the customer_aliases table — we never auto-overwrite the
      // suggestion based on this single mismatch.
      let aliasReviewNeeded = false;
      let suggestedSlugAtSubmit = "";
      let suggestionSourceAtSubmit = "";
      try {
        const existing = await sessionRef.get();
        const existingData = existing.exists ? (existing.data() || {}) : {};
        suggestedSlugAtSubmit    = String(existingData.suggested_customer_slug   || "").trim();
        suggestionSourceAtSubmit = String(existingData.suggested_customer_source || "").trim();
        const selectedSlug = String(doc.customer_slug || "").trim();
        if (suggestedSlugAtSubmit && selectedSlug && suggestedSlugAtSubmit !== selectedSlug) {
          aliasReviewNeeded = true;
        }
      } catch (_e) {
        // Read failure is non-fatal — we just skip the flag.
      }
      const sessionUpdate = {
        status:                    "needs_finish",
        pioneer_dcr_submitted_at:  admin.firestore.FieldValue.serverTimestamp(),
        dcr_submission_id:         submissionId,
        updated_at:                admin.firestore.FieldValue.serverTimestamp(),
        // Customer truth lives in PioneerOps now: Deputy gives us
        // who+when, the DCR is where the tech picks the customer.
        // Stamp the chosen customer onto the work session so
        // Today's Work can render the right name after submission.
        selected_customer_slug:    doc.customer_slug || "",
        selected_customer_name:    doc.customer_name || "",
        // Re-stamp the immutable identity fields so the Firestore
        // rules' diff check (request.resource.data.tech_email ==
        // resource.data.tech_email) doesn't trip if the doc was
        // created in a prior run with a different shape. Admin SDK
        // bypasses rules, but keeping them stable preserves audit
        // semantics regardless of who writes.
        deputy_shift_id:           pioneerSessionId,
        tech_email:                doc.submitted_by_email
      };
      if (aliasReviewNeeded) {
        sessionUpdate.alias_review_needed         = true;
        sessionUpdate.alias_review_suggested_slug = suggestedSlugAtSubmit;
        sessionUpdate.alias_review_source         = suggestionSourceAtSubmit;
        sessionUpdate.alias_review_flagged_at     = admin.firestore.FieldValue.serverTimestamp();
      }
      await sessionRef.set(sessionUpdate, { merge: true });
      logger.info("submitDcrV1 pioneer_work_sessions writeback ok", {
        submission_id:       submissionId,
        pioneer_session_id:  pioneerSessionId,
        alias_review_needed: aliasReviewNeeded
      });
    } catch (err) {
      logger.warn("submitDcrV1 pioneer_work_sessions writeback failed (non-fatal)", {
        submission_id:       submissionId,
        pioneer_session_id:  pioneerSessionId,
        error:               err && err.message
      });
    }
  }

  // ---- Pioneer Time Clock writeback (Phase 1b.4) ----
  //
  // When the DCR was initiated from the Pioneer Time Clock surface on
  // /work, the form carries pioneer_assignment_id (the
  // service_assignments doc id) and pioneer_service_session_id (the
  // most-recent pioneer_service_sessions doc id the tech finished
  // from). These are namespace-disjoint from the Deputy back-write
  // above (pioneer_session_id / pioneer_work_sessions) so the two
  // flows never collide.
  //
  // Three writes, all best-effort:
  //   1. dcr_submissions already carries pioneer_assignment_id via the
  //      payload spread (line ~2957), so no explicit write needed
  //      here — the field is on the doc.
  //   2. Back-stamp dcr_submission_id onto the linked
  //      pioneer_service_sessions doc (the "last session for this
  //      assignment").
  //   3. Stamp dcr_submitted=true + dcr_submission_id +
  //      dcr_submitted_at onto the service_assignments doc — gives
  //      service-clock.js a fast denormalized read for the UI's "DCR
  //      Submitted" chip without a second query.
  //
  // Soft-fail throughout: DCR submission already succeeded by this
  // point; back-writes are operational ergonomics only.
  const pioneerAssignmentId     = String((payload && payload.pioneer_assignment_id)     || "").trim();
  const pioneerServiceSessionId = String((payload && payload.pioneer_service_session_id) || "").trim();
  // Phase 29F-ticket1 (2026-06-17) — session and assignment back-writes
  // now run INDEPENDENTLY. Previously both were nested inside
  // `if (pioneerAssignmentId)`, which meant a DCR submitted with a session
  // id but no assignment id (legacy Deputy handoff, direct URL, customer-
  // slug-only bookmark) skipped the session back-stamp entirely. Result
  // was orphan DCRs that left Mission Control's session-side check
  // forever flagging "DCR Missing" while Yesterday's Work's
  // dcr-side check rendered the DCR. Now each block is gated on its own
  // id only, so either or both can fire as the payload allows.
  // 2. session back-write (only when a session id was supplied).
  // Phase 2B — Also stamp dcr_id + dcr_status so Phase 28A's
  // approveGatePasses() (which reads s.dcr_id OR s.dcr_status ===
  // "submitted") will recognize the DCR as complete. Without this,
  // sessions remained DCR Pending forever even after submit, and the
  // payroll Verification Layer blocked exports. merge:true + last-
  // write-wins on serverTimestamp() means a later DCR resubmission
  // (newest submission) wins primary status, per Phase 2B spec #2.
  if (pioneerServiceSessionId) {
    try {
      await db.collection("pioneer_service_sessions").doc(pioneerServiceSessionId).set({
        dcr_id:            submissionId,
        dcr_submission_id: submissionId,
        dcr_status:        "submitted",
        dcr_submitted_at:  admin.firestore.FieldValue.serverTimestamp(),
        updated_at:        admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      logger.info("submitDcrV1 pioneer_service_sessions writeback ok", {
        submission_id:              submissionId,
        pioneer_assignment_id:      pioneerAssignmentId || null,
        pioneer_service_session_id: pioneerServiceSessionId
      });
    } catch (err) {
      logger.warn("submitDcrV1 pioneer_service_sessions writeback failed (non-fatal)", {
        submission_id:              submissionId,
        pioneer_service_session_id: pioneerServiceSessionId,
        error:                      err && err.message
      });
    }
  }
  // 3. service_assignments denormalized write — admin still owns the
  //    .status field; we only set the DCR-completion signals.
  if (pioneerAssignmentId) {
    try {
      await db.collection("service_assignments").doc(pioneerAssignmentId).set({
        dcr_submitted:     true,
        dcr_submission_id: submissionId,
        dcr_submitted_at:  admin.firestore.FieldValue.serverTimestamp(),
        updated_at:        admin.firestore.FieldValue.serverTimestamp(),
        updated_by:        doc.submitted_by_email || "submitDcrV1"
      }, { merge: true });
      logger.info("submitDcrV1 service_assignments writeback ok", {
        submission_id:         submissionId,
        pioneer_assignment_id: pioneerAssignmentId
      });
    } catch (err) {
      logger.warn("submitDcrV1 service_assignments writeback failed (non-fatal)", {
        submission_id:         submissionId,
        pioneer_assignment_id: pioneerAssignmentId,
        error:                 err && err.message
      });
    }
  }

  // Best-effort: create a supply_requests doc if the DCR asked for supplies.
  // Failure here is logged but never blocks the success response — the DCR is
  // already saved by the time we get here, and admins can manually create the
  // request from the office if needed.
  await maybeCreateSupplyRequest(doc, submissionId);

  // ---- Phase 32: Native DCR email auto-send (replaces Zapier as primary) ----
  // Fires after the DCR doc is written. Wrapped in try/catch so any
  // failure (Gmail outage, OpenAI hiccup, missing customer config) NEVER
  // blocks the tech's success response. Audit + native_email status are
  // stamped on the dcr_submissions doc by the helper.
  let nativeEmailResult = { status: "skipped", reason: "not_invoked", code: "not_invoked" };
  try {
    nativeEmailResult = await dcrEmail.sendNativeDcrEmailForSubmission({
      admin:                  admin,
      db:                     db,
      logger:                 logger,
      dcrId:                  submissionId,
      invokedBy:              "submitDcrV1",
      forceSend:              false,
      dryRun:                 false,
      openaiApiKey:           OPENAI_API_KEY.value(),
      gmailSenderEmail:       GMAIL_SENDER_EMAIL.value(),
      gmailServiceAccountKey: GMAIL_SERVICE_ACCOUNT_KEY.value(),
      kirbyAlertEmail:        KIRBY_ALERT_EMAIL.value(),
      aprilAlertEmail:        APRIL_ALERT_EMAIL.value()
    });
    if (nativeEmailResult.status === "sent") {
      logger.info("submitDcrV1 native email sent", {
        submission_id: submissionId,
        recipient:     nativeEmailResult.recipient,
        messageId:     nativeEmailResult.messageId
      });
    } else if (nativeEmailResult.status === "skipped") {
      logger.info("submitDcrV1 native email skipped", {
        submission_id: submissionId,
        reason:        nativeEmailResult.reason,
        code:          nativeEmailResult.code
      });
    } else {
      logger.warn("submitDcrV1 native email failed", {
        submission_id: submissionId,
        reason:        nativeEmailResult.reason,
        code:          nativeEmailResult.code
      });
    }
  } catch (err) {
    // Swallow — DCR submit must succeed even if the email path explodes.
    logger.error("submitDcrV1 native email path threw (swallowed)", {
      submission_id: submissionId,
      error:         err && err.message,
      stack:         err && err.stack
    });
    nativeEmailResult = { status: "failed", reason: (err && err.message) || "unknown error", code: "hook_threw" };
  }

  // ---- Zapier (Phase 32: OFF by default; opt-in via env flag) ----
  // The Zap on the Zapier side was disabled around 2026-06-03, returning
  // HTTP 404 "please unsubscribe me!" on every POST. Native pipeline above
  // is the primary delivery path now. Leave the code intact and gated so
  // we can re-enable as fallback if the native path ever needs an outage
  // backup — set USE_ZAPIER_DCR_FALLBACK=true in the function env.
  const zapierFallbackEnabled = String(process.env.USE_ZAPIER_DCR_FALLBACK || "").toLowerCase() === "true";
  let zapierResult = {
    attempted:   false,
    status:      "disabled_native_cutover",
    status_code: null,
    error:       null,
    sent_at:     null
  };
  if (zapierFallbackEnabled) {
    const zapierUrl = (process.env.ZAPIER_DCR_WEBHOOK_URL || "").trim();
    const zapierPayload = buildZapierPayload(doc, submissionId);
    logger.info("submitDcrV1 zapier payload shape (fallback mode)", {
      submission_id:      submissionId,
      photo_count:        zapierPayload.photo_count,
      photo_urls_is_array: Array.isArray(zapierPayload.photo_urls)
    });
    zapierResult = await sendToZapier(zapierUrl, zapierPayload);
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(submissionId).update({
        zapier:                       zapierResult,
        "delivery.zapier_sent":       zapierResult.status === "sent",
        "delivery.zapier_sent_at":    zapierResult.sent_at,
        "delivery.zapier_attempts":   zapierResult.attempted ? 1 : 0,
        "delivery.last_error":        zapierResult.error,
        updated_at:                   admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      logger.error("submitDcrV1 firestore zapier-status update failed", {
        error: err.message, submission_id: submissionId, zapier_status: zapierResult.status
      });
    }
    if (zapierResult.status === "failed") {
      logger.warn("Zapier delivery failed", {
        submission_id: submissionId, status_code: zapierResult.status_code, error: zapierResult.error
      });
    } else if (zapierResult.status === "sent") {
      logger.info("Zapier delivery succeeded", {
        submission_id: submissionId, status_code: zapierResult.status_code
      });
    }
  } else {
    // Stamp the cutover state on the doc once so admin UIs can show
    // "disabled — native cutover" instead of stale "Zapier failed".
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(submissionId).update({
        zapier:     zapierResult,                                                                                      // { status: "disabled_native_cutover", ... }
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      logger.warn("submitDcrV1 firestore zapier-cutover stamp failed (non-fatal)", {
        error: err.message, submission_id: submissionId
      });
    }
  }

  return res.status(200).json({
    ok:            true,
    submission_id: submissionId,
    native_email:  {
      status:     nativeEmailResult.status,
      reason:     nativeEmailResult.reason,
      code:       nativeEmailResult.code,
      recipient:  nativeEmailResult.recipient,
      messageId:  nativeEmailResult.messageId
    },
    zapier:        zapierResult
  });
});

/* ===========================================================================
   Deputy OAuth + read-only shift sync (Phase 1)
   ===========================================================================
   Architecture overview:
     1. Admin clicks /admin's "Connect Deputy" button (TBD) which navigates
        to deputyOAuthStartV1. That function builds the Deputy authorize URL
        and 302-redirects the admin to it.
     2. Deputy prompts the admin to authorize PioneerOps and redirects back
        to deputyOAuthCallbackV1 with ?code=... + ?state=...
     3. deputyOAuthCallbackV1 validates state (CSRF), exchanges the code
        for access_token + refresh_token, and persists them in
        deputy_oauth_state/current (server-only Firestore doc).
     4. syncDeputyShiftsV1 (Cloud Scheduler, every 10 min) reads the tokens,
        refreshes when expired, pulls today's Deputy roster, and upserts
        each shift into deputy_shift_cache/{shift_id}. Tech HUB + admin UI
        will read this cache in a future Phase 3/4.
     5. refreshDeputyShiftsV1 is the admin-triggered HTTPS twin of the
        scheduled sync — same core, immediate result.

   Token storage: Firestore doc /deputy_oauth_state/current. Server-only
   via Admin SDK; firestore.rules deny client reads/writes outright.

   Secrets used (set via `firebase functions:secrets:set <NAME>`):
     • DEPUTY_CLIENT_ID
     • DEPUTY_CLIENT_SECRET
     • DEPUTY_INSTALL_URL    (also the base URL for manual-token mode)
     • DEPUTY_ACCESS_TOKEN   (manual mode — when set, sync skips the
                              OAuth dance and uses this token directly
                              as the Bearer credential. Endpoint comes
                              from DEPUTY_INSTALL_URL.)

   v1 operational mode: MANUAL TOKEN.
   ----------------------------------
   The user generated a long-lived access token from Deputy's
   "Get An Access Token" tool and stored it as the
   DEPUTY_ACCESS_TOKEN secret. When that secret is present, sync uses
   it directly — no OAuth call, no refresh, no token storage in
   Firestore. The OAuth code (deputyOAuthStartV1 / deputyOAuthCallbackV1
   / refresh logic) is kept in place for future restoration but is
   NOT exercised in the manual-token path. The token value is NEVER
   written to logs; only `token_source` = "manual_token" | "oauth"
   is emitted as a one-word marker.
   =========================================================================== */

const DEPUTY_CLIENT_ID     = defineSecret("DEPUTY_CLIENT_ID");
const DEPUTY_CLIENT_SECRET = defineSecret("DEPUTY_CLIENT_SECRET");
const DEPUTY_INSTALL_URL   = defineSecret("DEPUTY_INSTALL_URL");
const DEPUTY_ACCESS_TOKEN  = defineSecret("DEPUTY_ACCESS_TOKEN");

// Deputy OAuth URLs — INSTALL-SPECIFIC.
//
// Pioneer's OAuth client was registered as a "single-install" client
// (not a marketplace app), so per Deputy's docs the entire OAuth flow
// runs on Pioneer's install URL rather than on Deputy's central
// once.deputy.com gateway:
//
//   • Authorize: {install}/oauth/login
//   • Token:     {install}/oauth/access_token
//
// Verified 2026-05-15 by probing the install directly:
//   - https://b4bbc204060738.na.deputy.com/oauth/login
//       → 200, page title "Authorise an application with Deputy"
//       → form POSTs back to /oauth/login with the OAuth params.
//   - https://b4bbc204060738.na.deputy.com/oauth/access_token
//       → 400 on bare GET (expects POST form-encoded body).
//
// Earlier attempts used once.deputy.com because Deputy's official OAuth
// docs primarily describe the marketplace flow. once.deputy.com doesn't
// know about single-install client_ids and rejected the request with
// `invalid_client`. The fix is to derive both endpoints from the
// DEPUTY_INSTALL_URL secret at runtime.
const DEPUTY_OAUTH_SCOPE = "longlife_refresh_token";

function getDeputyOAuthUrls() {
  const install = trimSecret(DEPUTY_INSTALL_URL.value()).replace(/\/+$/, "");
  if (!install) {
    throw new Error("DEPUTY_INSTALL_URL is not set or empty.");
  }
  return {
    authorizeUrl: install + "/oauth/login",
    tokenUrl:     install + "/oauth/access_token",
    installBase:  install
  };
}

// Defensive trim. Secret Manager preserves whatever bytes were stored,
// so any stray newline or trailing space from a copy-paste would break
// the OAuth handshake silently. Always pipe secret values through this
// before they hit a URL or POST body.
function trimSecret(v) { return String(v == null ? "" : v).trim(); }

// Minimal HTML escape for error pages rendered server-side. Same shape
// as the public/admin.js helper but functions/index.js doesn't have
// access to that file.
function escapeHtmlMinimal(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DEPUTY_OAUTH_STATE_DOC   = "deputy_oauth_state";
const DEPUTY_SHIFT_CACHE_COLL  = "deputy_shift_cache";
const DEPUTY_SYNC_TIMEZONE     = "America/Los_Angeles";

// Compute the redirect URI the same way for BOTH start and callback,
// using the gen1-style Cloud Functions URL pattern. Gen2 functions
// still respond on this URL (Firebase keeps both), and using a stable
// pattern means the admin only has to register ONE redirect URI in
// Deputy's app settings.
function getDeputyCallbackUrl() {
  const projectId = process.env.GCLOUD_PROJECT
    || process.env.GCP_PROJECT
    || (admin.app().options && admin.app().options.projectId)
    || "pioneer-dcr-hub";
  return "https://us-central1-" + projectId + ".cloudfunctions.net/deputyOAuthCallbackV1";
}

/* ----------------------------- deputyOAuthStartV1 -----------------------------
   Admin-gated POST endpoint. Returns JSON with the Deputy authorize URL
   the admin should open in a browser. We do NOT 302-redirect here
   because the admin client needs to attach an Authorization header to
   prove they're an admin — and a browser nav can't attach headers. So
   the contract is: POST with Bearer admin token → get JSON →
   manually open authorize_url in a new tab → Deputy redirects to
   deputyOAuthCallbackV1 (no Bearer needed; state param is the
   security boundary on the callback side). */
exports.deputyOAuthStartV1 = onRequest({
  cors: false,
  timeoutSeconds: 15,
  // DEPUTY_INSTALL_URL is required because getDeputyOAuthUrls() reads
  // it to derive the install-specific /oauth/login authorize URL.
  secrets: [DEPUTY_CLIENT_ID, DEPUTY_INSTALL_URL]
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed. POST with admin Bearer token." });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("deputyOAuthStartV1: non-admin attempted to start OAuth", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  // Generate + persist CSRF state. Single pending-state doc is enough
  // because the OAuth flow is admin-only and rare; concurrent flows
  // would simply overwrite each other and the loser would fail to
  // verify on callback.
  const state = crypto.randomBytes(24).toString("hex");
  try {
    await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("pending").set({
      state:      state,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      created_by: staff.email
    });
  } catch (err) {
    logger.error("deputyOAuthStartV1: pending-state write failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Couldn't initialise OAuth flow. Check logs." });
    return;
  }

  const callbackUrl = getDeputyCallbackUrl();
  const clientId    = trimSecret(DEPUTY_CLIENT_ID.value());
  const installUrl  = trimSecret(DEPUTY_INSTALL_URL.value());

  // First-pass diagnostic mode — caller can pass `?no_scope=1` (or
  // `{no_scope:true}` in the JSON body) to omit the scope param
  // entirely. If invalid_client goes away under no-scope, Deputy is
  // rejecting the scope value (e.g., the app isn't granted
  // longlife_refresh_token). If invalid_client persists, the issue is
  // client_id or redirect_uri.
  const noScope = (req.query && (req.query.no_scope === "1" || req.query.no_scope === "true"))
               || (req.body  && (req.body.no_scope === true || req.body.no_scope === "1"));
  const includeScope = !noScope;

  // Derive install-specific OAuth URLs from the configured install URL.
  // Throws if DEPUTY_INSTALL_URL is unset — caught + 500'd below.
  let oauthUrls;
  try {
    oauthUrls = getDeputyOAuthUrls();
  } catch (err) {
    logger.error("deputyOAuthStartV1: cannot derive OAuth URLs", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
    return;
  }

  // Diagnostic logging — every value is either fully safe to log
  // (lengths, URLs, prefix/suffix) or a 6-char fragment that doesn't
  // expose the full secret. Used to triage `invalid_client` and
  // mismatched-redirect_uri errors without leaking credentials.
  logger.info("deputyOAuthStartV1: building authorize request", {
    admin:              staff.email,
    client_id_length:   clientId.length,
    client_id_prefix:   clientId.slice(0, 6),
    client_id_suffix:   clientId.slice(-6),
    install_url:        installUrl || "(unset)",
    authorize_url_base: oauthUrls.authorizeUrl,
    token_url_base:     oauthUrls.tokenUrl,
    redirect_uri:       callbackUrl,
    scope:              includeScope ? DEPUTY_OAUTH_SCOPE : "(omitted)",
    has_scope:          includeScope,
    response_type:      "code",
    param_names:        includeScope
                          ? ["client_id","redirect_uri","response_type","scope","state"]
                          : ["client_id","redirect_uri","response_type","state"]
  });

  const paramObj = {
    client_id:     clientId,
    redirect_uri:  callbackUrl,
    response_type: "code",
    state:         state
  };
  if (includeScope) paramObj.scope = DEPUTY_OAUTH_SCOPE;
  const params = new URLSearchParams(paramObj);
  const authorizeUrl = oauthUrls.authorizeUrl + "?" + params.toString();

  res.status(200).json({
    ok:            true,
    authorize_url: authorizeUrl,
    callback_url:  callbackUrl,
    expires_in:    600,
    diagnostic: {
      // Exact debug-safe breakdown of the authorize URL.
      authorize_endpoint: oauthUrls.authorizeUrl,
      token_endpoint:     oauthUrls.tokenUrl,
      client_id_preview:  clientId.slice(0, 6) + "..." + clientId.slice(-6),
      client_id_length:   clientId.length,
      redirect_uri:       callbackUrl,
      response_type:      "code",
      has_scope:          includeScope,
      scope:              includeScope ? DEPUTY_OAUTH_SCOPE : null,
      install_url:        installUrl || null,
      param_names:        includeScope
                            ? ["client_id","redirect_uri","response_type","scope","state"]
                            : ["client_id","redirect_uri","response_type","state"]
    },
    instructions: includeScope
      ? "Open authorize_url in a new tab. To test WITHOUT scope, re-run with `?no_scope=1` on this start URL."
      : "Open authorize_url in a new tab (scope param omitted for test)."
  });
});

/* ----------------------------- deputyOAuthCallbackV1 -----------------------------
   NOT staff-gated — Deputy redirects an unauthenticated browser here
   with ?code + ?state. Security comes from validating the state param
   against the pending-state doc we wrote in deputyOAuthStartV1.
   On success: exchange code for tokens, persist tokens in
   deputy_oauth_state/current, render a success HTML page. */
exports.deputyOAuthCallbackV1 = onRequest({
  cors: false,
  timeoutSeconds: 30,
  // DEPUTY_INSTALL_URL is required because getDeputyOAuthUrls() reads
  // it to derive the install-specific /oauth/access_token token URL.
  secrets: [DEPUTY_CLIENT_ID, DEPUTY_CLIENT_SECRET, DEPUTY_INSTALL_URL]
}, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const code              = String(req.query.code  || "");
  const stateInput        = String(req.query.state || "");
  const errorParam        = String(req.query.error || "");
  const errorDescParam    = String(req.query.error_description || "");

  if (errorParam) {
    // Log diagnostic context (no secrets) so admins can triage from
    // the function log when Deputy refuses authorization.
    let authorizeUrlForLog = "(unset)";
    try { authorizeUrlForLog = getDeputyOAuthUrls().authorizeUrl; } catch (_) {}
    logger.warn("deputyOAuthCallbackV1: Deputy returned error param", {
      error:              errorParam,
      error_description:  errorDescParam,
      redirect_uri:       getDeputyCallbackUrl(),
      authorize_url_base: authorizeUrlForLog
    });
    res.status(400).send(
      "<!doctype html><html><body style=\"font-family:system-ui;padding:32px;\">" +
      "<h1>Deputy authorization failed</h1>" +
      "<p><strong>error</strong>: " + escapeHtmlMinimal(errorParam) + "</p>" +
      (errorDescParam ? "<p><strong>error_description</strong>: " + escapeHtmlMinimal(errorDescParam) + "</p>" : "") +
      "<p>Check Cloud Functions logs for <code>deputyOAuthCallbackV1</code> and " +
      "<code>deputyOAuthStartV1</code> — they print the client_id length + " +
      "first/last 6 chars and the redirect_uri so you can compare against " +
      "Deputy's app settings.</p>" +
      "</body></html>"
    );
    return;
  }
  if (!code || !stateInput) {
    res.status(400).send("Missing code or state parameter.");
    return;
  }

  // Validate state.
  let pending;
  try {
    const pendingSnap = await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("pending").get();
    if (!pendingSnap.exists) {
      res.status(400).send("No pending OAuth state. Restart the flow from /admin.");
      return;
    }
    pending = pendingSnap.data();
  } catch (err) {
    logger.error("deputyOAuthCallbackV1: pending-state read failed", { error: err.message });
    res.status(500).send("Couldn't validate OAuth state. Check logs.");
    return;
  }

  if (pending.state !== stateInput) {
    logger.warn("deputyOAuthCallbackV1: state mismatch — possible CSRF", {
      expected_prefix: String(pending.state || "").slice(0, 8),
      got_prefix:      stateInput.slice(0, 8)
    });
    res.status(400).send("OAuth state mismatch (possible CSRF).");
    return;
  }
  const pendingMs = (pending.created_at && pending.created_at.toMillis)
    ? pending.created_at.toMillis() : 0;
  if (pendingMs && Date.now() - pendingMs > 10 * 60 * 1000) {
    res.status(400).send("OAuth flow expired (>10 min). Restart from /admin.");
    return;
  }

  // Exchange code → tokens.
  let tokenData;
  try {
    const clientId      = trimSecret(DEPUTY_CLIENT_ID.value());
    const clientSecret  = trimSecret(DEPUTY_CLIENT_SECRET.value());
    const callbackUrl   = getDeputyCallbackUrl();
    const oauthUrls     = getDeputyOAuthUrls();

    logger.info("deputyOAuthCallbackV1: about to exchange code", {
      client_id_length:     clientId.length,
      client_id_prefix:     clientId.slice(0, 6),
      client_id_suffix:     clientId.slice(-6),
      client_secret_length: clientSecret.length,
      token_url_base:       oauthUrls.tokenUrl,
      redirect_uri:         callbackUrl,
      scope:                DEPUTY_OAUTH_SCOPE
    });

    const body = new URLSearchParams({
      grant_type:    "authorization_code",
      code:          code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  callbackUrl,
      scope:         DEPUTY_OAUTH_SCOPE
    });
    const tokenRes = await fetch(oauthUrls.tokenUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString()
    });
    tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      logger.error("deputyOAuthCallbackV1: token exchange non-OK", {
        status:     tokenRes.status,
        // Don't dump full response — Deputy sometimes echoes parameters.
        error_code: tokenData && tokenData.error,
        error_description: tokenData && tokenData.error_description
      });
      res.status(500).send("Token exchange failed (HTTP " + tokenRes.status + "). Check function logs.");
      return;
    }
  } catch (err) {
    logger.error("deputyOAuthCallbackV1: token exchange threw", { error: err.message });
    res.status(500).send("Token exchange error. Check function logs.");
    return;
  }

  // Persist tokens. Subtract 60s from expires_in so we refresh proactively.
  const expiresInSec = (typeof tokenData.expires_in === "number") ? tokenData.expires_in : 86400;
  const expiresAtMs  = Date.now() + (expiresInSec * 1000) - 60000;

  try {
    await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("current").set({
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      endpoint:      tokenData.endpoint || null,
      scope:         tokenData.scope || DEPUTY_OAUTH_SCOPE,
      expires_at:    new Date(expiresAtMs),
      obtained_at:   admin.firestore.FieldValue.serverTimestamp(),
      obtained_by:   pending.created_by || null,
      refreshed_at:  null
    });
    await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("pending").delete();
  } catch (err) {
    logger.error("deputyOAuthCallbackV1: token persist failed", { error: err.message });
    res.status(500).send("Token storage failed. Check function logs.");
    return;
  }

  logger.info("deputyOAuthCallbackV1 ok", {
    obtained_by: pending.created_by || null,
    endpoint:    tokenData.endpoint || null,
    scope:       tokenData.scope || DEPUTY_OAUTH_SCOPE
  });

  res.status(200).send(
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Deputy Connected</title>" +
    "<style>body{font-family:system-ui,-apple-system,sans-serif;padding:48px 24px;text-align:center;color:#111;}" +
    "h1{margin:0 0 12px;font-size:22px;color:#0f766e;}p{margin:8px 0;line-height:1.5;color:#444;}" +
    "a{color:#0f766e;font-weight:600;}</style></head><body>" +
    "<h1>✅ Deputy connected</h1>" +
    "<p>Pioneer DCR Hub is now authorized to read Deputy shifts.</p>" +
    "<p>You can close this tab. The scheduled sync runs every 10&nbsp;minutes.</p>" +
    "<p><a href=\"/admin\">Return to Admin</a></p>" +
    "</body></html>"
  );
});

/* ----------------------------- sync core helpers ----------------------------- */

// Pacific "today" as YYYY-MM-DD. Used both for Deputy roster filter and
// for the `sync_date` partition key in Firestore.
function deputyTodayLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEPUTY_SYNC_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

// Read the current Deputy credential. Two paths:
//
//   1. MANUAL TOKEN MODE (v1) — DEPUTY_ACCESS_TOKEN is set in Secret
//      Manager. We use it directly as the Bearer credential and pull
//      the API base URL from DEPUTY_INSTALL_URL. No Firestore read,
//      no OAuth refresh, no token rotation. Token value never logged.
//   2. OAUTH MODE (legacy) — read tokens from
//      /deputy_oauth_state/current, refresh transparently when
//      expired. Retained for future restoration; not exercised while
//      DEPUTY_ACCESS_TOKEN is populated.
//
// Returns { accessToken, endpoint, source }.
async function getValidDeputyAccessToken() {
  // ---- (1) Manual-token mode ----
  // Defensive: .value() throws if the secret was never created. We
  // catch that to mean "manual mode not enabled" and fall through to
  // OAuth. Same for an empty/whitespace-only secret value.
  let manualToken = "";
  try { manualToken = trimSecret(DEPUTY_ACCESS_TOKEN.value() || ""); }
  catch (e) { manualToken = ""; }

  if (manualToken) {
    let endpoint = "";
    try { endpoint = trimSecret(DEPUTY_INSTALL_URL.value() || ""); }
    catch (e) { endpoint = ""; }
    if (!endpoint) {
      // Manual token without an install URL is unrunnable — Deputy
      // tokens are scoped to a specific install, and we don't have a
      // way to discover the base URL from the token alone.
      throw new Error("DEPUTY_ACCESS_TOKEN is set but DEPUTY_INSTALL_URL is empty — set both.");
    }
    return {
      accessToken: manualToken,
      endpoint:    endpoint.replace(/\/+$/, ""),
      source:      "manual_token"
    };
  }

  // ---- (2) OAuth mode (legacy) ----
  const snap = await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("current").get();
  if (!snap.exists) {
    throw new Error("Deputy OAuth not yet completed AND DEPUTY_ACCESS_TOKEN is empty. " +
                    "Either set the secret or run deputyOAuthStartV1.");
  }
  const data = snap.data();

  const expiresAtMs = (data.expires_at && data.expires_at.toMillis)
    ? data.expires_at.toMillis()
    : 0;

  if (Date.now() < expiresAtMs && data.access_token) {
    return {
      accessToken: data.access_token,
      endpoint:    data.endpoint || DEPUTY_INSTALL_URL.value(),
      source:      "oauth"
    };
  }

  // Refresh.
  if (!data.refresh_token) {
    throw new Error("Deputy access token expired and no refresh token stored. Re-run deputyOAuthStartV1.");
  }

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: data.refresh_token,
    client_id:     trimSecret(DEPUTY_CLIENT_ID.value()),
    client_secret: trimSecret(DEPUTY_CLIENT_SECRET.value()),
    scope:         DEPUTY_OAUTH_SCOPE
  });
  const refreshOauthUrls = getDeputyOAuthUrls();
  const r = await fetch(refreshOauthUrls.tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString()
  });
  const refreshed = await r.json().catch(() => ({}));
  if (!r.ok || !refreshed.access_token) {
    throw new Error("Deputy refresh failed: HTTP " + r.status + " " + (refreshed.error || ""));
  }

  const newExpiresInSec = (typeof refreshed.expires_in === "number") ? refreshed.expires_in : 86400;
  const newExpiresAtMs  = Date.now() + (newExpiresInSec * 1000) - 60000;

  await db.collection(DEPUTY_OAUTH_STATE_DOC).doc("current").update({
    access_token:  refreshed.access_token,
    // Deputy may rotate the refresh token; keep the old one if not returned.
    refresh_token: refreshed.refresh_token || data.refresh_token,
    endpoint:      refreshed.endpoint || data.endpoint,
    expires_at:    new Date(newExpiresAtMs),
    refreshed_at:  admin.firestore.FieldValue.serverTimestamp()
  });
  logger.info("deputy oauth refresh ok", { endpoint: refreshed.endpoint || data.endpoint });

  return {
    accessToken: refreshed.access_token,
    endpoint:    refreshed.endpoint || data.endpoint || DEPUTY_INSTALL_URL.value(),
    source:      "oauth_refreshed"
  };
}

// Shared sync logic — called by both scheduled and admin-triggered
// entry points. Returns a summary object the caller can log / return.
//
// opts:
//   • invokedBy  — short string for telemetry (scheduled, admin:<email>, …)
//   • syncDate   — optional YYYY-MM-DD override. When omitted, defaults
//                  to today in Pacific. Used by the admin-triggered
//                  refresh path so the office can backfill / preview a
//                  specific date without changing the scheduler. The
//                  caller is responsible for shape validation; this
//                  helper trusts whatever string it gets.
async function syncDeputyShiftsCore(opts) {
  opts = opts || {};
  const invokedBy = opts.invokedBy || "unknown";
  const t0        = Date.now();
  const syncDate  = (typeof opts.syncDate === "string" && opts.syncDate) || deputyTodayLocalDate();
  const cred     = await getValidDeputyAccessToken();
  const accessToken = cred.accessToken;
  const endpoint    = cred.endpoint;
  const tokenSource = cred.source || "unknown";
  if (!endpoint) throw new Error("Deputy endpoint missing — set DEPUTY_INSTALL_URL or re-run OAuth.");

  const cleanEndpoint = String(endpoint).replace(/\/$/, "");

  // ---- Preflight: GET /api/v1/me ----
  //
  // Validates the Bearer token by hitting the cheapest authenticated
  // endpoint Deputy offers. If this fails the roster query will too,
  // and the /me error is far cleaner to triage from logs. We log only
  // the response code + an identity scalar (id/email/display_name) —
  // never the token, never the full body.
  let meSummary = null;
  try {
    const meRes = await fetch(cleanEndpoint + "/api/v1/me", {
      method:  "GET",
      headers: { "Authorization": "Bearer " + accessToken }
    });
    if (!meRes.ok) {
      const meText = await meRes.text().catch(() => "");
      throw new Error("Deputy /api/v1/me preflight failed: HTTP " + meRes.status +
                      " " + meText.slice(0, 200));
    }
    const meBody = await meRes.json().catch(() => ({}));
    meSummary = {
      deputy_id:     meBody && (meBody.Id || meBody.id) || null,
      display_name:  (meBody && (meBody.DisplayName || meBody.Name)) || null,
      // Deliberately omit Email — keeps PII out of telemetry. The id +
      // display name are enough to confirm "we hit the right install
      // as the right user" without echoing email into log sinks.
      token_source:  tokenSource,
      endpoint:      cleanEndpoint
    };
    logger.info("deputy /me preflight ok", meSummary);
  } catch (err) {
    // Surface a concise error; the token NEVER appears in this message
    // because we only string-concat the response status + body, never
    // the Authorization header.
    logger.error("deputy /me preflight failed — aborting sync", {
      token_source: tokenSource,
      endpoint:     cleanEndpoint,
      error:        err && err.message
    });
    throw err;
  }

  // Query today's roster with employee + operational unit joined so we
  // don't need N+1 follow-up fetches. We ask Deputy for the full
  // OperationalUnit join because Deputy returns customer-identifying
  // clues in several different fields depending on how the OU was set
  // up — we capture them all and let the alias table decide which one
  // is canonical for a given customer.
  const queryUrl  = cleanEndpoint + "/api/v1/resource/Roster/QUERY";
  const queryBody = JSON.stringify({
    search: {
      date_from: { field: "Date", type: "ge", data: syncDate },
      date_to:   { field: "Date", type: "le", data: syncDate }
    },
    join: ["EmployeeObject", "OperationalUnitObject"],
    max:  500
  });
  const r = await fetch(queryUrl, {
    method:  "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type":  "application/json"
    },
    body: queryBody
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error("Deputy roster query failed: HTTP " + r.status + " " + text.slice(0, 200));
  }
  const rosters = await r.json();
  if (!Array.isArray(rosters)) {
    throw new Error("Deputy roster query returned non-array: " + typeof rosters);
  }

  // Build slug-resolution maps from the cleaning_techs + customers caches
  // PLUS the admin-curated customer_aliases lookup table. customer_aliases
  // is the canonical Pioneer-side alias table: admins curate it once,
  // and every future Deputy shift carrying a matching alias auto-fills
  // the suggested_customer_* fields on its cache doc.
  const [techsSnap, customersSnap, aliasesSnap] = await Promise.all([
    db.collection("cleaning_techs").get(),
    db.collection("customers").get(),
    db.collection("customer_aliases").get()
  ]);

  // Normalize a free-text name for fuzzy-but-strict matching. Lower
  // case, strip non-alphanumerics, then strip a trailing "s" so simple
  // singular/plural variants collapse to the same key. Keep this in
  // sync with the admin-side helper in public/admin.js (normalizeNameKey).
  function normalizeKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/s$/, "");
  }

  // Multi-key tech index. Match priority on roster ingest:
  //   1. deputy_employee_id   (most stable — never changes for a person)
  //   2. deputy_employee_email (admin-set canonical link)
  //   3. cleaning_tech.email   (legacy fallback)
  //   4. normalized name       (display_name OR admin-set deputy_employee_name)
  // The admin Deputy Mapping panel writes the first three; the
  // normalized-name path is a safety net for first-run before any
  // admin has explicitly applied a mapping.
  const techsByDeputyId   = {};
  const techsByEmail      = {};
  const techsByNameKey    = {};
  techsSnap.docs.forEach(function (d) {
    const t = d.data() || {};
    if (t.active === false) return;          // archived techs don't match
    const ref = {
      slug:         t.tech_slug || d.id,
      display_name: t.display_name || "",
      email:        String(t.email || "").toLowerCase().trim()
    };
    if (t.deputy_employee_id != null && t.deputy_employee_id !== "") {
      techsByDeputyId[String(t.deputy_employee_id)] = ref;
    }
    const linkEmail = String(t.deputy_employee_email || t.email || "").toLowerCase().trim();
    if (linkEmail) techsByEmail[linkEmail] = ref;
    const nameKey = normalizeKey(t.deputy_employee_name || t.display_name || "");
    if (nameKey) {
      // First-wins so admin-set mappings don't collide with name
      // collisions. If two techs share a normalized name, the second
      // one stays in techsByDeputyId/techsByEmail only.
      if (!techsByNameKey[nameKey]) techsByNameKey[nameKey] = ref;
    }
  });

  // Customer match priority (post-_DPMetaData architecture):
  //   1. deputy_company_id    — Deputy Company.Id from _DPMetaData (NEW canonical)
  //   2. deputy_location_id   — legacy back-compat (set from same value)
  //   3. normalized customer_name / location_name against Deputy CompanyName
  //   4. deputy_customer_codes[] (admin-mapped bracket code like [NOTL])
  //   5. deputy_location_name (admin-set canonical link)
  //   6. fallback alias (suggestion resolver)
  const custByCompanyId            = {};   // active customer per Deputy Company.Id
  const duplicateCompanyIdSlugs    = {};   // Deputy Company.Id → [slug,slug,...] when >1 active customers claim it
  const inactiveCustByCompanyId    = {};   // Deputy Company.Id → first inactive customer ref (for warning state)
  const custByDeputyId             = {};   // legacy — keyed by customers.deputy_location_id
  const custByCode                 = {};
  const custByLocKey               = {};
  customersSnap.docs.forEach(function (d) {
    const c    = d.data() || {};
    const slug = c.customer_slug || d.id;
    const ref = {
      slug:           slug,
      customer_name:  c.customer_name || c.name || ""
    };
    // Deputy Company.Id is the canonical customer key. We accept BOTH
    // the new `deputy_company_id` field and the legacy `deputy_location_id`
    // (which earlier rounds stamped from the same source). Inactive
    // customers go into a separate index so the resolver can flag
    // them as "Mapped to inactive customer" instead of silently
    // falling through.
    const cid = c.deputy_company_id != null && c.deputy_company_id !== ""
                  ? c.deputy_company_id
                  : c.deputy_location_id;
    if (cid != null && cid !== "") {
      const key = String(cid);
      if (c.active === false) {
        // Inactive — never auto-resolves, but tracked for warning.
        if (!inactiveCustByCompanyId[key]) inactiveCustByCompanyId[key] = ref;
      } else if (custByCompanyId[key]) {
        // DUPLICATE — second active customer claiming the same Company.Id.
        // Don't overwrite; record so the resolver can fall into the
        // "duplicate mapping" safe-unresolved branch.
        if (!duplicateCompanyIdSlugs[key]) {
          duplicateCompanyIdSlugs[key] = [custByCompanyId[key].slug];
        }
        duplicateCompanyIdSlugs[key].push(slug);
      } else {
        custByCompanyId[key] = ref;
      }
    }
    if (c.active === false) return;   // remaining indexes are active-only
    if (c.deputy_location_id != null && c.deputy_location_id !== "") {
      custByDeputyId[String(c.deputy_location_id)] = ref;
    }
    // Admin-curated bracket codes. Each entry is the bare alpha-num
    // token (no brackets). First-wins across customers if codes collide.
    const codes = Array.isArray(c.deputy_customer_codes) ? c.deputy_customer_codes : [];
    codes.forEach(function (raw) {
      const code = String(raw || "").toUpperCase().trim();
      if (code && !custByCode[code]) custByCode[code] = ref;
    });
    // Add normalized keys for every signal we have, first-wins.
    const keys = [
      normalizeKey(c.deputy_location_name),
      normalizeKey(c.location_name),
      normalizeKey(c.customer_name || c.name)
    ];
    keys.forEach(function (k) {
      if (k && !custByLocKey[k]) custByLocKey[k] = ref;
    });
  });

  // Extract the first [BRACKET CODE] from any free-form text Deputy
  // gives us — operational unit name, company name, or the shift
  // Comment (instructions). Pioneer schedulers put codes like [NOTL],
  // [DIVCO], [MAC], [BT REC] inline so they show up on Deputy's
  // mobile view; we treat the FIRST bracket token as canonical.
  function extractDeputyCode(text) {
    if (!text) return "";
    const m = String(text).toUpperCase().match(/\[([A-Z0-9][A-Z0-9 ]{1,7})\]/);
    return m ? m[1].trim() : "";
  }

  // ===================================================================
  // SUGGESTED-CUSTOMER RESOLVER  (Pioneer-side, informational only)
  // ===================================================================
  // Stamps suggested_customer_{slug,name,confidence,source} on each
  // deputy_shift_cache doc when EXACTLY ONE Pioneer customer matches
  // at HIGH confidence. Tech still picks the customer on the DCR;
  // this is a pre-fill hint, never authority. When no match exists
  // the four fields are intentionally OMITTED from the doc so the
  // merge:false write below clears any stale value.
  const SUGGEST_MIN_LEN = 5;
  const SUGGEST_DENY = new Set([
    "pioneer", "pioneercommercialcleaning", "commercialcleaning",
    "cleaningtech", "technician", "admin", "office", "route",
    "shift", "coverage", "floater", "training"
  ]);
  // Strict normalizer for the suggestion path. NOT the existing
  // normalizeKey() — we deliberately skip the trailing-s strip
  // because "Bonds" → "bond" causes weird collisions in customer
  // names. Suggestion needs to be conservative.
  function normalizeKeySuggest(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  // Build the suggestion index from active customers. Each customer
  // contributes multiple lookup keys: customer_name, slug, location_name,
  // deputy_location_name, every aliases[] entry. Bracket codes go in
  // their own index. First-write wins per key.
  const suggestByKey       = {};   // normalized key → {ref}
  const suggestByKeySource = {};   // normalized key → "name" | "alias" | "location"
  const suggestByCode      = {};   // [CODE] uppercase → {ref}
  customersSnap.docs.forEach(function (d) {
    const c = d.data() || {};
    if (c.active === false) return;
    const ref = {
      slug:          c.customer_slug || d.id,
      customer_name: c.customer_name || c.name || ""
    };
    function addKey(raw, kind) {
      const k = normalizeKeySuggest(raw);
      if (!k) return;
      if (k.length < SUGGEST_MIN_LEN) return;
      if (SUGGEST_DENY.has(k)) return;
      if (!suggestByKey[k]) {
        suggestByKey[k] = ref;
        suggestByKeySource[k] = kind;
      }
    }
    addKey(ref.customer_name, "name");
    addKey(ref.slug,          "name");
    addKey(c.location_name,         "location");
    addKey(c.deputy_location_name,  "location");
    (Array.isArray(c.aliases) ? c.aliases : []).forEach(function (a) {
      addKey(a, "alias");
    });
    // Admin-curated bracket codes (existing field, kept).
    (Array.isArray(c.deputy_customer_codes) ? c.deputy_customer_codes : []).forEach(function (raw) {
      const code = String(raw || "").toUpperCase().trim();
      if (code && !suggestByCode[code]) suggestByCode[code] = ref;
    });
    // Aliases that LOOK like a bracket code (short, all-caps) also
    // serve as code lookups — saves admin from maintaining two arrays.
    (Array.isArray(c.aliases) ? c.aliases : []).forEach(function (raw) {
      const s = String(raw || "").trim();
      if (/^[A-Z0-9][A-Z0-9 ]{1,7}$/.test(s) && !suggestByCode[s.toUpperCase()]) {
        suggestByCode[s.toUpperCase()] = ref;
      }
    });
  });

  // Tokenized text-scan: produce every distinct customer ref whose
  // normalized key appears as a contiguous run of tokens in `text`.
  // Token boundaries are non-alphanumeric — rules out substring
  // false positives like "notes" matching "Note and Kidd" — and the
  // min-length + deny-list guards already applied at index build
  // give a third safety net.
  function findCustomersInText(text) {
    const tokens = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!tokens.length) return [];
    const seen = new Map();   // slug → ref
    for (let i = 0; i < tokens.length; i++) {
      let key = "";
      for (let n = 0; n < 6 && i + n < tokens.length; n++) {
        key += tokens[i + n];
        if (key.length >= SUGGEST_MIN_LEN && suggestByKey[key]) {
          const ref = suggestByKey[key];
          if (!seen.has(ref.slug)) {
            seen.set(ref.slug, { ref: ref, key: key });
          }
        }
      }
    }
    return Array.from(seen.values());
  }

  // Per-shift suggestion resolver. Returns the four stamp fields when
  // EXACTLY ONE customer matches at high confidence, else null. The
  // caller passes a `texts` array in priority order so we can add new
  // fields without re-editing this resolver.
  function suggestCustomerForShift(opts) {
    const found = new Map();   // slug → {ref, source}
    function add(ref, source) {
      if (!ref) return;
      if (!found.has(ref.slug)) {
        found.set(ref.slug, { ref: ref, source: source });
      }
    }
    // Bracket code wins source precedence.
    if (opts.code && suggestByCode[opts.code]) {
      add(suggestByCode[opts.code], "code:" + opts.code);
    }
    // Scan text fields in caller-supplied priority. First field that
    // hits a given customer is the one we record as the source.
    (opts.texts || []).forEach(function (entry) {
      findCustomersInText(entry.text).forEach(function (hit) {
        const kind = suggestByKeySource[hit.key] || "name";
        add(hit.ref, kind + "_match:" + entry.field);
      });
    });
    if (found.size !== 1) return null;
    const only = found.values().next().value;
    return {
      suggested_customer_slug:       only.ref.slug,
      suggested_customer_name:       only.ref.customer_name,
      suggested_customer_confidence: "high",
      suggested_customer_source:     only.source
    };
  }

  // Fold every active /customer_aliases entry into the suggestion
  // index. The new collection is flat: each doc carries `alias`,
  // `normalized_alias`, `customer_slug`, `customer_name`, `active`.
  // We add each alias as a `suggestByKey` entry (kind="alias") AND,
  // when the alias looks like a bracket code (short, all-caps), also
  // as a `suggestByCode` entry. First-write wins to match earlier
  // indexes built off customer-doc fields.
  aliasesSnap.docs.forEach(function (d) {
    const a = d.data() || {};
    if (a.active === false) return;
    const slug = String(a.customer_slug || "").trim();
    if (!slug) return;
    const aliasStr = String(a.alias || "").trim();
    if (!aliasStr) return;
    const ref = {
      slug:          slug,
      customer_name: a.customer_name || ""
    };
    const normalized = a.normalized_alias
      ? String(a.normalized_alias).toLowerCase().replace(/[^a-z0-9]+/g, "")
      : normalizeKeySuggest(aliasStr);
    if (normalized && !suggestByKey[normalized]) {
      suggestByKey[normalized]       = ref;
      suggestByKeySource[normalized] = "alias";
    }
    if (/^[A-Z0-9][A-Z0-9 ]{1,7}$/.test(aliasStr)) {
      const code = aliasStr.toUpperCase();
      if (!suggestByCode[code]) suggestByCode[code] = ref;
    }
  });

  // V20260614 — Two-pass tech-match bridging across rosters in a single
  // sync run.
  //
  // Background: techMatch is resolved per-roster via 3 fallbacks
  // (Deputy ID → Deputy email → normalized display name). When a tech
  // has multiple shifts in a day and Deputy's data is inconsistent
  // across those rosters (e.g. Employee=null on some, different email
  // casing on others), some rosters resolve and some don't. The
  // unresolved ones get stamped with the Deputy raw email which then
  // mismatches the tech's Pioneer auth email on the read side. Result:
  // partial-display bug — tech sees one shift instead of three.
  //
  // Fix: pass 1 collects every successful match keyed by ALL of the
  // matched roster's identifiers (deputy ID, deputy email, name) AND
  // the techMatch's own canonical identifiers (email, display name).
  // Pass 2 then retries every unmatched roster against this enriched
  // bridge index. If ANY one of a tech's rosters resolves in pass 1,
  // ALL of that tech's rosters in this run resolve.
  const rosterMatches    = new Map(); // shiftId(string) → techMatch | null
  const bridgeByDeputyId = {};
  const bridgeByEmail    = {};
  const bridgeByNameKey  = {};

  // Pass 1 — per-roster static lookup; populate bridge keys on hit.
  for (const roster of rosters) {
    const rosterIdKey   = String(roster.Id);
    if (!rosterIdKey || rosterIdKey === "undefined") continue;
    const emp           = roster.EmployeeObject || {};
    const employeeIdRaw = roster.Employee;
    const employeeEmail = String(emp.Email || emp.email || "").toLowerCase().trim();
    const employeeName  = emp.DisplayName || emp.Name || "";
    const employeeNameKey = normalizeKey(employeeName);

    let techMatch = null;
    if (employeeIdRaw != null && techsByDeputyId[String(employeeIdRaw)]) {
      techMatch = techsByDeputyId[String(employeeIdRaw)];
    } else if (employeeEmail && techsByEmail[employeeEmail]) {
      techMatch = techsByEmail[employeeEmail];
    } else if (employeeNameKey && techsByNameKey[employeeNameKey]) {
      techMatch = techsByNameKey[employeeNameKey];
    }

    rosterMatches.set(rosterIdKey, techMatch);

    if (techMatch) {
      // Register by this roster's keys (so future rosters with matching
      // keys hit fast) AND by the techMatch's own canonical identifiers
      // (so a roster that shares ONLY the canonical name still bridges
      // even if its Deputy ID and email are missing/mismatched).
      if (employeeIdRaw != null) bridgeByDeputyId[String(employeeIdRaw)] = techMatch;
      if (employeeEmail)         bridgeByEmail[employeeEmail]            = techMatch;
      if (employeeNameKey)       bridgeByNameKey[employeeNameKey]        = techMatch;
      if (techMatch.email)       bridgeByEmail[techMatch.email]          = techMatch;
      const techNameKey = normalizeKey(techMatch.display_name);
      if (techNameKey)           bridgeByNameKey[techNameKey]            = techMatch;
    }
  }

  // Pass 2 — re-attempt unmatched rosters via the enriched bridge.
  let bridgedCount = 0;
  for (const roster of rosters) {
    const rosterIdKey = String(roster.Id);
    if (!rosterIdKey || rosterIdKey === "undefined") continue;
    if (rosterMatches.get(rosterIdKey)) continue;

    const emp           = roster.EmployeeObject || {};
    const employeeIdRaw = roster.Employee;
    const employeeEmail = String(emp.Email || emp.email || "").toLowerCase().trim();
    const employeeName  = emp.DisplayName || emp.Name || "";
    const employeeNameKey = normalizeKey(employeeName);

    let techMatch = null;
    if (employeeIdRaw != null && bridgeByDeputyId[String(employeeIdRaw)]) {
      techMatch = bridgeByDeputyId[String(employeeIdRaw)];
    } else if (employeeEmail && bridgeByEmail[employeeEmail]) {
      techMatch = bridgeByEmail[employeeEmail];
    } else if (employeeNameKey && bridgeByNameKey[employeeNameKey]) {
      techMatch = bridgeByNameKey[employeeNameKey];
    }

    if (techMatch) {
      rosterMatches.set(rosterIdKey, techMatch);
      bridgedCount += 1;
    }
  }

  logger.info("syncDeputyShifts bridge pass result", {
    sync_date:               syncDate,
    total_rosters:           rosters.length,
    bridged_after_pass1:     bridgedCount,
    unmatched_after_bridge:  Array.from(rosterMatches.values()).filter(function (m) { return !m; }).length
  });

  // Upsert each roster.
  const seenIds = new Set();
  let unmappedEmployees = 0;
  let unmappedCustomers = 0;

  for (const roster of rosters) {
    const shiftId = String(roster.Id);
    if (!shiftId || shiftId === "undefined") continue;
    seenIds.add(shiftId);

    const emp        = roster.EmployeeObject || {};
    const opUnit     = roster.OperationalUnitObject || {};
    const opCompany  = opUnit.Company || opUnit.CompanyObject || {};

    const employeeEmailRaw = String(emp.Email || emp.email || "").toLowerCase().trim();
    const employeeDisplay  = emp.DisplayName || emp.Name || "";
    const employeeIdRaw    = roster.Employee;

    // V20260614 — Use the two-pass bridge result. Falls back to the
    // original inline 3-arm lookup ONLY if rosterMatches somehow doesn't
    // have an entry for this shiftId (defensive — shouldn't happen).
    let techMatch = rosterMatches.get(shiftId);
    if (techMatch === undefined) {
      techMatch = null;
      if (employeeIdRaw != null && techsByDeputyId[String(employeeIdRaw)]) {
        techMatch = techsByDeputyId[String(employeeIdRaw)];
      } else if (employeeEmailRaw && techsByEmail[employeeEmailRaw]) {
        techMatch = techsByEmail[employeeEmailRaw];
      } else {
        const nameKey = normalizeKey(employeeDisplay);
        if (nameKey && techsByNameKey[nameKey]) techMatch = techsByNameKey[nameKey];
      }
    }
    if (!techMatch) unmappedEmployees += 1;

    // ----- Deputy customer-side clues we capture per roster -----
    // Pioneer's Deputy account models customers at the COMPANY level
    // (= "Locations" in Deputy's UI). The OperationalUnit is a
    // sub-grouping that may be a generic team label like "Cleaning
    // Techs". So we treat Company.CompanyName as the canonical
    // deputy_location_name and OperationalUnitName as the secondary
    // operational unit. Both get stamped on the cache doc.
    const opUnitName     = String(opUnit.OperationalUnitName || opUnit.Name || "");
    const opUnitCode     = String(opUnit.Code || opUnit.OperationalUnitCode || "");
    const opUnitMemo     = String(opUnit.Memo || opUnit.OperationalUnitMemo || "");
    const opUnitAddress  = String(opUnit.Address || "");
    const opUnitColour   = String(opUnit.Colour || opUnit.ColourPalette || "");
    const opUnitRosterMsg = String(opUnit.RosterMessage || "");
    const opCompanyName  = String(opCompany.CompanyName || opCompany.Name || "");
    const opCompanyAddr  = String(opCompany.Address || "");
    const opCompanyId    = Number(opCompany.Id || opCompany.CompanyId || 0) || null;
    const opUnitId       = roster.OperationalUnit;
    const rosterComment  = String(roster.Comment || "");
    const rosterMemo     = String(roster.Memo || roster._DPMetaData && roster._DPMetaData.Memo || "");
    const rosterSlots    = Array.isArray(roster.Slots) ? roster.Slots : [];

    // Additional location-flavored signals Deputy MAY surface depending
    // on how the account is configured. We harvest them defensively;
    // any that aren't populated stay as empty strings.
    const opUnitLocation        = opUnit.Location || opUnit.LocationObject || {};
    const opUnitLocationName    = String(opUnitLocation.Name || opUnitLocation.LocationName || opUnit.LocationName || "");
    const opUnitAreaName        = String(opUnit.Area || opUnit.AreaName || "");
    const opUnitTeamName        = String(opUnit.Team || opUnit.TeamName || "");
    const rosterLocationName    = String(roster.LocationName || roster.Location || "");
    const rosterAreaName        = String(roster.AreaName || roster.Area || "");
    const rosterTeamName        = String(roster.TeamName || roster.Team || "");
    const rosterScheduleName    = String(roster.ScheduleName || roster.Schedule || "");

    // ===== Canonical customer identity from Roster._DPMetaData =====
    // Confirmed in production diagnostics: every Roster row carries
    // _DPMetaData.OperationalUnitInfo with Company (id), CompanyName,
    // CompanyCode, and LabelWithCompany. This is the authoritative
    // customer signal — far more reliable than OperationalUnitName
    // (often "Cleaning Techs") or the shift Comment.
    const dpMeta                = roster._DPMetaData || {};
    const opUnitInfo            = dpMeta.OperationalUnitInfo || {};
    const deputyCompanyIdMeta   = (typeof opUnitInfo.Company === "number" && opUnitInfo.Company > 0)
                                    ? opUnitInfo.Company
                                    : (opCompany.Id || opCompany.CompanyId || null);
    const deputyCompanyNameMeta = String(opUnitInfo.CompanyName || opCompanyName || "");
    const deputyCompanyCodeMeta = String(opUnitInfo.CompanyCode || opCompany.Code || opCompany.CompanyCode || "");
    const deputyLabelWithCompany = String(opUnitInfo.LabelWithCompany || "");

    // SOP / scope-of-work notes — Deputy carries these on the
    // AddressObject attached to either the OperationalUnit or the
    // Company. Captured raw on the cache doc so a future job can
    // extract structured fields without re-pulling Deputy.
    const opUnitAddressObj      = opUnit.AddressObject || opUnit.Address || {};
    const opUnitAddressNotes    = typeof opUnitAddressObj === "object"
                                    ? String(opUnitAddressObj.Notes || "")
                                    : "";
    const opCompanyAddressObj   = opCompany.AddressObject || opCompany.Address || {};
    const opCompanyAddressNotes = typeof opCompanyAddressObj === "object"
                                    ? String(opCompanyAddressObj.Notes || "")
                                    : "";

    // Raw snapshot of every string/number field on the OperationalUnit,
    // Company, and Roster objects. Stored on the cache doc so admins
    // can see exactly what Deputy returned without console-diving the
    // raw API. Keep flat so Firestore types stay sane.
    const rawLocationFields = {};
    function captureRaw(prefix, obj) {
      if (!obj || typeof obj !== "object") return;
      Object.keys(obj).forEach(function (k) {
        const v = obj[k];
        if (typeof v === "string" && v) rawLocationFields[prefix + k] = v;
        else if (typeof v === "number")  rawLocationFields[prefix + k] = v;
      });
    }
    captureRaw("ou_",      opUnit);
    captureRaw("company_", opCompany);
    captureRaw("roster_",  roster);

    // Scan every text field Deputy gives us for a [BRACKET CODE].
    // Priority: operational-unit Code (structured field, when populated)
    // → operational unit name → company name → shift Comment → Memo.
    const detectedCode = extractDeputyCode("[" + opUnitCode + "]")  // wrap so a bare "NOTL" matches the regex
                      || extractDeputyCode(opUnitName)
                      || extractDeputyCode(opCompanyName)
                      || extractDeputyCode(rosterComment)
                      || extractDeputyCode(rosterMemo)
                      || extractDeputyCode(opUnitMemo);

    // Customer match priority (hardened):
    //   1. customers.deputy_company_id == Roster._DPMetaData.OperationalUnitInfo.Company
    //   2. normalized Deputy CompanyName == customer name/location_name
    //   3. alias fallback (suggestion resolver) — only when 1 + 2 miss
    //   4. None — safe unresolved
    //
    // Safety branches BEFORE 1-3:
    //   • Duplicate Company.Id (2+ active customers claim it) → safe
    //     unresolved with `duplicate_mapping: true`. Today's Work
    //     refuses to auto-resolve.
    //   • Inactive customer (only customer with this Company.Id is
    //     active=false) → safe unresolved with `inactive_customer: true`.
    //
    // We never use OperationalUnitName as a customer signal (it's
    // typically "Cleaning Techs" in Pioneer's Deputy account). The
    // legacy customer-doc text-match fallbacks have been retired —
    // they were the only paths that could surface a generic OU name.
    const dpCompanyNameKey = normalizeKey(deputyCompanyNameMeta);
    const companyIdKey     = (deputyCompanyIdMeta != null && deputyCompanyIdMeta !== "")
                              ? String(deputyCompanyIdMeta)
                              : "";

    let customerMatch    = null;
    let resolvedVia      = "";
    let matchSource      = "none";
    let matchConfidence  = "none";
    let duplicateMapping = false;
    let inactiveCustomer = false;

    if (companyIdKey && duplicateCompanyIdSlugs[companyIdKey]) {
      // Safe unresolved: two active Pioneer customers claim the same
      // Deputy Company.Id. Admin must disambiguate.
      duplicateMapping = true;
      matchSource      = "duplicate_company_id";
      matchConfidence  = "none";
      resolvedVia      = "duplicate";
    } else if (companyIdKey && custByCompanyId[companyIdKey]) {
      customerMatch    = custByCompanyId[companyIdKey];
      resolvedVia      = "deputy_company_id";
      matchSource      = "deputy_company_id";
      matchConfidence  = "exact";
    } else if (companyIdKey && inactiveCustByCompanyId[companyIdKey]) {
      // Safe unresolved: mapped to an inactive customer. We capture
      // the inactive customer slug so admin can see who it was without
      // auto-selecting them on the DCR.
      inactiveCustomer = true;
      matchSource      = "inactive_customer";
      matchConfidence  = "none";
      resolvedVia      = "inactive";
    } else if (dpCompanyNameKey && custByLocKey[dpCompanyNameKey]) {
      customerMatch    = custByLocKey[dpCompanyNameKey];
      resolvedVia      = "deputy_company_name";
      matchSource      = "deputy_company_name";
      matchConfidence  = "normalized";
    }
    // No legacy OU-name / company-name / code text fallbacks here —
    // they were the only paths that could surface "Cleaning Techs"
    // as a customer. Alias path runs below as the last resort.
    if (!customerMatch && !duplicateMapping && !inactiveCustomer) {
      unmappedCustomers += 1;
    }

    // Alias-based suggestion. SUPPLEMENTAL — only runs when the
    // customer-match priority above didn't fire AND there is no
    // duplicate / inactive safety branch active. Duplicate or
    // inactive mappings must stay in a safe-unresolved state so
    // the admin can correct them.
    let suggestion = null;
    if (!customerMatch && !duplicateMapping && !inactiveCustomer) {
      suggestion = suggestCustomerForShift({
      code:  detectedCode,
      texts: [
        { field: "company_name",            text: deputyCompanyNameMeta || opCompanyName },
        { field: "operational_unit_memo",   text: opUnitMemo },
        { field: "operational_unit_address",text: opUnitAddress },
        { field: "company_address",         text: opCompanyAddr },
        { field: "ou_location_name",        text: opUnitLocationName },
        { field: "ou_area_name",            text: opUnitAreaName },
        { field: "ou_team_name",            text: opUnitTeamName },
        { field: "roster_location_name",    text: rosterLocationName },
        { field: "roster_area_name",        text: rosterAreaName },
        { field: "roster_team_name",        text: rosterTeamName },
        { field: "roster_schedule_name",    text: rosterScheduleName },
        { field: "instructions",            text: rosterComment },
        { field: "memo",                    text: rosterMemo }
      ]
      });
      if (suggestion) {
        matchSource     = "alias";
        matchConfidence = "fallback";
      }
    }

    const startEpochSec = Number(roster.StartTime) || 0;
    const endEpochSec   = Number(roster.EndTime)   || 0;

    // CRITICAL: when matched, write the TECH'S Pioneer auth email
    // (not Deputy's email) to the cache doc. The firestore rule on
    // /deputy_shift_cache gates per-doc reads on
    // `resource.data.employee_email == request.auth.token.email.lower()`
    // so the cache email must equal the tech's Firebase Auth email
    // for the tech to read their shift. Falls back to Deputy's email
    // when unmapped, which means an unmapped tech still can't read
    // their shifts — that's the expected behavior.
    const canonicalEmployeeEmail = (techMatch && techMatch.email)
      ? techMatch.email
      : employeeEmailRaw;

    const docData = {
      shift_id:                  Number(roster.Id) || 0,
      deputy_employee_id:        Number(roster.Employee) || null,
      deputy_operational_unit_id: Number(roster.OperationalUnit) || null,
      employee_email:            canonicalEmployeeEmail,
      employee_email_deputy:     employeeEmailRaw,                  // for triage; not gated by rules
      employee_slug:             techMatch ? techMatch.slug : "",
      employee_display_name:     employeeDisplay || (techMatch && techMatch.display_name) || "",
      customer_slug:             customerMatch ? customerMatch.slug : "",
      // customer_name is ONLY set when we have a real match. Never
      // surface a generic OU label like "Cleaning Techs" here — that
      // was the source of "wrong customer on the work card" complaints.
      // Today's Work falls back to "Customer not linked yet" when empty.
      customer_name:             customerMatch ? customerMatch.customer_name : "",
      resolved_via:              resolvedVia,                       // diagnostic — empty when unresolved
      // ---- QA logging — every shift carries these so admin can
      // sort the cache by match quality. matchSource ∈
      // { "deputy_company_id" | "deputy_company_name" |
      //   "duplicate_company_id" | "inactive_customer" |
      //   "alias" | "none" }.
      match_source:              matchSource,
      match_confidence:          matchConfidence,
      duplicate_mapping:         duplicateMapping,
      inactive_customer:         inactiveCustomer,
      // When duplicate or inactive, capture the offending slug(s) so
      // admin can surface them without re-scanning customers.
      duplicate_mapping_slugs:   duplicateMapping
                                   ? duplicateCompanyIdSlugs[companyIdKey].slice()
                                   : [],
      inactive_mapped_slug:      inactiveCustomer
                                   ? (inactiveCustByCompanyId[companyIdKey] || {}).slug || ""
                                   : "",
      // ---- Canonical Deputy company identity (from _DPMetaData) ----
      // These are the authoritative customer signal. Roster._DPMetaData
      // .OperationalUnitInfo carries Company / CompanyName / CompanyCode
      // for every shift Deputy returns. Persisted even when unmatched
      // so the admin "Deputy Companies" mapping UI can surface them.
      deputy_company_id:              deputyCompanyIdMeta,
      deputy_company_name:            deputyCompanyNameMeta,
      deputy_company_code:            deputyCompanyCodeMeta,
      deputy_label_with_company:      deputyLabelWithCompany,
      // ---- Customer SOP / scope-of-work raw notes from Deputy ----
      // Captured raw; a future job promotes them to /customer_sops.
      operational_unit_notes:         opUnitAddressNotes,
      company_address_notes:          opCompanyAddressNotes,
      // ---- Legacy location signals (kept for back-compat) ----
      // Deputy's "Locations" UI shows Companies. deputy_location_name
      // mirrors deputy_company_name; deputy_location_id mirrors
      // deputy_company_id so old readers continue to work.
      deputy_location_name:           deputyCompanyNameMeta || opCompanyName,
      deputy_location_id:             deputyCompanyIdMeta,
      deputy_operational_unit_name:   opUnitName,
      // deputy_operational_unit_id already set above.
      raw_location_fields:            rawLocationFields,              // every string/number field, flat
      // ---- Legacy fields kept for back-compat with current readers ----
      location_name:             opUnitName,                        // OperationalUnit.OperationalUnitName / .Name
      operational_unit_code:     opUnitCode,                        // OperationalUnit.Code (structured short code)
      operational_unit_memo:     opUnitMemo,                        // OperationalUnit.Memo (admin description)
      operational_unit_address:  opUnitAddress,                     // OperationalUnit.Address
      operational_unit_colour:   opUnitColour,                      // OperationalUnit.Colour
      operational_unit_roster_message: opUnitRosterMsg,             // OperationalUnit.RosterMessage
      company_name:              opCompanyName,                     // Company.CompanyName / Company.Name (== deputy_location_name)
      company_address:           opCompanyAddr,                     // Company.Address
      deputy_customer_code:      detectedCode || "",                // first [BRACKET] hit
      slot_count:                rosterSlots.length,                // useful for split-shift detection
      memo:                      rosterMemo,                        // Roster.Memo / _DPMetaData.Memo
      // ---- Additional location-flavored signals (when present) ----
      ou_location_name:          opUnitLocationName,
      ou_area_name:              opUnitAreaName,
      ou_team_name:              opUnitTeamName,
      roster_location_name:      rosterLocationName,
      roster_area_name:          rosterAreaName,
      roster_team_name:          rosterTeamName,
      roster_schedule_name:      rosterScheduleName,
      start_time:                startEpochSec ? new Date(startEpochSec * 1000) : null,
      end_time:                  endEpochSec   ? new Date(endEpochSec   * 1000) : null,
      instructions:              rosterComment,
      status:                    "scheduled",
      deputy_shift_url:          cleanEndpoint + "/roster/" + roster.Id,
      sync_date:                 syncDate,
      last_synced_at:            admin.firestore.FieldValue.serverTimestamp(),
      source:                    "deputy"
    };

    // Spread the suggestion fields in (or leave absent — merge:false
    // below means absent == cleared in Firestore, which is exactly
    // the stale-data behavior we want).
    if (suggestion) {
      Object.assign(docData, suggestion);
    }

    try {
      await db.collection(DEPUTY_SHIFT_CACHE_COLL).doc(shiftId).set(docData, { merge: false });
    } catch (err) {
      logger.warn("deputy_shift_cache upsert failed (continuing)", {
        shift_id: shiftId, error: err.message
      });
    }
  }

  // Cancel shifts that previously existed for today but disappeared
  // from this run's snapshot. We don't delete — we mark cancelled so
  // there's an audit trail.
  let cancelledCount = 0;
  try {
    const existingSnap = await db.collection(DEPUTY_SHIFT_CACHE_COLL)
      .where("sync_date", "==", syncDate)
      .get();
    for (const doc of existingSnap.docs) {
      if (!seenIds.has(doc.id) && (doc.data().status || "") !== "cancelled") {
        await doc.ref.update({
          status:         "cancelled",
          last_synced_at: admin.firestore.FieldValue.serverTimestamp()
        });
        cancelledCount += 1;
      }
    }
  } catch (err) {
    logger.warn("deputy cancellation sweep failed (non-fatal)", { error: err.message });
  }

  return {
    sync_date:           syncDate,
    fetched_count:       rosters.length,
    upserted_count:      seenIds.size,
    cancelled_count:     cancelledCount,
    unmapped_employees:  unmappedEmployees,
    unmapped_customers:  unmappedCustomers,
    duration_ms:         Date.now() - t0,
    invoked_by:          invokedBy,
    token_source:        tokenSource
  };
}

/* ----------------------------- syncDeputyShiftsV1 -----------------------------
   Scheduled — runs every 10 min on Pacific time. Errors are logged but
   never escalate; the next run retries. The cache stays usable when
   sync fails — UI reads the most recent docs regardless. */
exports.syncDeputyShiftsV1 = onSchedule({
  schedule:        "every 10 minutes",
  timeZone:        DEPUTY_SYNC_TIMEZONE,
  timeoutSeconds:  120,
  // DEPUTY_ACCESS_TOKEN drives the manual-token path. The OAuth
  // secrets are kept attached so the legacy path remains a working
  // fallback if the manual token is ever unset.
  secrets:         [DEPUTY_CLIENT_ID, DEPUTY_CLIENT_SECRET, DEPUTY_INSTALL_URL, DEPUTY_ACCESS_TOKEN]
}, async (event) => {
  try {
    const result = await syncDeputyShiftsCore({ invokedBy: "scheduled" });
    logger.info("syncDeputyShiftsV1 ok", result);
  } catch (err) {
    logger.error("syncDeputyShiftsV1 failed", { error: err.message });
  }
});

/* ----------------------------- refreshDeputyShiftsV1 -----------------------------
   Admin-only HTTPS endpoint. Same sync core, immediate result. Used by
   a future "Refresh shifts" button in the admin UI. */
exports.refreshDeputyShiftsV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120,
  // Manual-token path uses DEPUTY_ACCESS_TOKEN; OAuth secrets retained
  // for the legacy fallback. Keep both attached so toggling between
  // modes never requires a redeploy.
  secrets:        [DEPUTY_CLIENT_ID, DEPUTY_CLIENT_SECRET, DEPUTY_INSTALL_URL, DEPUTY_ACCESS_TOKEN]
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("refreshDeputyShiftsV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  // Optional `sync_date` override (YYYY-MM-DD). Lets the office backfill
  // or preview a specific day's shifts without changing the scheduler.
  // Bounded to ±60 days from today so a typo can't fan out an unbounded
  // Deputy query. Missing/empty → today (Pacific).
  const body = req.body || {};
  let syncDateOverride = null;
  const rawSyncDate = String(body.sync_date || "").trim();
  if (rawSyncDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawSyncDate)) {
      res.status(400).json({
        ok: false,
        error: "sync_date must be in YYYY-MM-DD format (got '" + rawSyncDate + "')."
      });
      return;
    }
    const today = new Date(deputyTodayLocalDate() + "T00:00:00Z").getTime();
    const target = new Date(rawSyncDate + "T00:00:00Z").getTime();
    if (Number.isNaN(target)) {
      res.status(400).json({ ok: false, error: "sync_date is not a real calendar date." });
      return;
    }
    const diffDays = Math.abs(target - today) / 86400000;
    if (diffDays > 60) {
      res.status(400).json({
        ok: false,
        error: "sync_date must be within 60 days of today (got '" + rawSyncDate + "', diff=" + Math.round(diffDays) + "d)."
      });
      return;
    }
    syncDateOverride = rawSyncDate;
  }

  try {
    const result = await syncDeputyShiftsCore({
      invokedBy: "admin:" + staff.email,
      syncDate:  syncDateOverride
    });

    // Sanitized sample of up to the first 3 cached docs for this sync
    // date so the operator can eyeball the data shape without round-
    // tripping through the Firestore console. Reads from
    // deputy_shift_cache (the post-write canonical view). Emails are
    // truncated to the local-part prefix so PII doesn't leak into
    // chat / logs when this response is copy-pasted around.
    let sampleShifts = [];
    try {
      const sampleSnap = await db.collection(DEPUTY_SHIFT_CACHE_COLL)
        .where("sync_date", "==", result.sync_date)
        .limit(3)
        .get();
      sampleShifts = sampleSnap.docs.map(function (d) {
        const x = d.data() || {};
        const email = String(x.employee_email || "");
        const emailRedacted = email
          ? (email.split("@")[0] + "@…")
          : "";
        return {
          shift_id:              x.shift_id || d.id,
          sync_date:             x.sync_date || null,
          employee_email_prefix: emailRedacted,
          employee_slug:         x.employee_slug || "",
          employee_display_name: x.employee_display_name || "",
          customer_slug:         x.customer_slug || "",
          customer_name:         x.customer_name || "",
          location_name:         x.location_name || "",
          start_time:            x.start_time && x.start_time.toDate ? x.start_time.toDate().toISOString() : null,
          end_time:              x.end_time   && x.end_time.toDate   ? x.end_time.toDate().toISOString()   : null,
          status:                x.status || "",
          deputy_shift_url:      x.deputy_shift_url || ""
        };
      });
    } catch (sampleErr) {
      logger.warn("refreshDeputyShiftsV1 sample read failed (non-fatal)", {
        error: sampleErr && sampleErr.message
      });
    }

    logger.info("refreshDeputyShiftsV1 ok", result);
    res.status(200).json({
      ok:             true,
      result:         result,
      sample_shifts:  sampleShifts
    });
  } catch (err) {
    logger.error("refreshDeputyShiftsV1 failed", {
      error: err.message, caller: staff.email
    });
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ----------------------------- refreshDeputyShiftsRangeV1 -----------------------------
   Admin-only HTTPS endpoint. Loops `syncDeputyShiftsCore` once per
   calendar day in an inclusive [start_date, end_date] Pacific range so
   the publish-snapshot flow can populate the 7/14/21-day horizon
   without an admin clicking through `refreshDeputyShiftsV1` per day.

   Bounds (defensive):
     • Range size capped at 31 days. Anything larger 400s — the
       Deputy API is per-day, so unbounded ranges = unbounded fan-out.
     • Each date must be within ±60 days of today (mirrors the
       single-date guard in refreshDeputyShiftsV1).
     • Per-day errors are caught and recorded in the response; one
       bad day does NOT abort the rest. This matches the
       fault-tolerance of the scheduled sync.

   Phase 2 TODO:
     • parallelize per-day calls with a small concurrency cap (3-4)
       once we have evidence the Deputy API tolerates it. Today this
       runs strictly sequentially to keep the rate predictable.
     • move this loop into a callable Cloud Scheduler job that
       re-runs nightly (auto-publish on a fixed schedule rather than
       admin-triggered). */
exports.refreshDeputyShiftsRangeV1 = onRequest({
  cors:           false,
  // 31 days × ~2s/day worst-case ≈ 62s headroom; bump to 300 for
  // safety since Deputy occasionally serves slow.
  timeoutSeconds: 300,
  secrets:        [DEPUTY_CLIENT_ID, DEPUTY_CLIENT_SECRET, DEPUTY_INSTALL_URL, DEPUTY_ACCESS_TOKEN]
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("refreshDeputyShiftsRangeV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const rawStart = String(body.start_date || "").trim();
  const rawEnd   = String(body.end_date   || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStart) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
    res.status(400).json({
      ok: false,
      error: "start_date and end_date are required in YYYY-MM-DD format."
    });
    return;
  }
  const todayMs = new Date(deputyTodayLocalDate() + "T00:00:00Z").getTime();
  const startMs = new Date(rawStart + "T00:00:00Z").getTime();
  const endMs   = new Date(rawEnd   + "T00:00:00Z").getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    res.status(400).json({ ok: false, error: "start_date/end_date are not real calendar dates." });
    return;
  }
  if (endMs < startMs) {
    res.status(400).json({ ok: false, error: "end_date must be on or after start_date." });
    return;
  }
  const rangeDays = Math.round((endMs - startMs) / 86400000) + 1;
  if (rangeDays > 31) {
    res.status(400).json({
      ok: false,
      error: "Range too large (" + rangeDays + " days). Max 31."
    });
    return;
  }
  for (const ms of [startMs, endMs]) {
    const diffDays = Math.abs(ms - todayMs) / 86400000;
    if (diffDays > 60) {
      res.status(400).json({
        ok: false,
        error: "start_date / end_date must each be within 60 days of today."
      });
      return;
    }
  }

  const perDay = [];
  let aggregateUpserted = 0;
  let aggregateCancelled = 0;
  let aggregateUnmappedE = 0;
  let aggregateUnmappedC = 0;
  let failuresCount = 0;

  for (let cursor = startMs; cursor <= endMs; cursor += 86400000) {
    const isoDay = new Date(cursor).toISOString().slice(0, 10);
    try {
      const result = await syncDeputyShiftsCore({
        invokedBy: "admin:range:" + staff.email,
        syncDate:  isoDay
      });
      aggregateUpserted  += (result.upserted_count   || 0);
      aggregateCancelled += (result.cancelled_count  || 0);
      aggregateUnmappedE += Array.isArray(result.unmapped_employees) ? result.unmapped_employees.length : 0;
      aggregateUnmappedC += Array.isArray(result.unmapped_customers) ? result.unmapped_customers.length : 0;
      perDay.push({
        sync_date:       isoDay,
        ok:              true,
        upserted_count:  result.upserted_count   || 0,
        cancelled_count: result.cancelled_count  || 0,
        fetched_count:   result.fetched_count    || 0,
        duration_ms:     result.duration_ms      || 0
      });
    } catch (err) {
      failuresCount += 1;
      perDay.push({
        sync_date: isoDay,
        ok:        false,
        error:     (err && err.message) || String(err)
      });
      logger.warn("refreshDeputyShiftsRangeV1 day failed (continuing)", {
        sync_date: isoDay, error: err && err.message
      });
    }
  }

  logger.info("refreshDeputyShiftsRangeV1 ok", {
    start_date: rawStart, end_date: rawEnd, days: rangeDays,
    upserted: aggregateUpserted, cancelled: aggregateCancelled,
    failures: failuresCount, caller: staff.email
  });

  res.status(200).json({
    ok:                true,
    start_date:        rawStart,
    end_date:          rawEnd,
    days:              rangeDays,
    aggregate: {
      upserted_count:        aggregateUpserted,
      cancelled_count:       aggregateCancelled,
      unmapped_employees:    aggregateUnmappedE,
      unmapped_customers:    aggregateUnmappedC,
      failed_days:           failuresCount
    },
    per_day: perDay
  });
});

/* ====================================================================
 * seedPilotCustomerAliasesV1 — one-shot admin endpoint that populates
 * /customer_aliases with the curated Pioneer pilot alias list. The
 * source-of-truth list lives HERE (server-side), never in frontend
 * code, so refreshes don't ship alias data and edits don't redeploy
 * the SPA bundle.
 *
 * Idempotent: each alias becomes a doc keyed by its normalized form;
 * re-running this endpoint is a no-op for already-seeded entries.
 *
 * Auth: staff:admin only (via verifyStaffOrReject + role check).
 *
 * Response shape:
 *   { ok, seeded: [{alias, customer}], skipped: [{alias, reason}],
 *     missing_customers: [{seed_name, hint}] }
 *
 * Future "learned_from_dcr" hook: every doc carries `learned_from_dcr:
 * false` + `learned_from_dcr_count: 0` so a later pipeline can flip the
 * flag / increment the count without a schema migration.
 * ================================================================== */

// Curated pilot seed. Each entry is one Pioneer customer plus the
// schedule code + name variants we expect to see in Deputy text.
// Editing this list and redeploying is the canonical way to maintain
// pilot aliases; the admin UI is for one-off additions after that.
const PILOT_ALIAS_SEED = [
  { code: "NOTL",    customer_name: "Note and Kidd PLLC",                 extras: ["noteandkidd", "notekidd", "noteandkiddpllc"] },
  { code: "DIVCO",   customer_name: "Divco Inc",                          extras: ["divcoinc"] },
  { code: "GILMN",   customer_name: "Gilman Family Practice",             extras: ["gilmanfamily", "gilmanfamilypractice"] },
  { code: "MAC",     customer_name: "MacDonald Miller Facility Solutions",extras: ["macdonaldmiller", "macdonaldmillerfacility", "macdonaldmillerfacilitysolutions"] },
  { code: "BT REC",  customer_name: "Breakthrough Recovery Group",        extras: ["breakthroughrecovery", "breakthroughrecoverygroup"] },
  { code: "NVLS",    customer_name: "Novelis MMP Spokane",                extras: ["novelis", "novelismmp", "novelisspokane"] },
  { code: "B CONS",  customer_name: "Baker Construction",                 extras: ["bakerconstruction"] },
  { code: "B COMM",  customer_name: "Baker Commodities",                  extras: ["bakercommodities"] },
  { code: "REALTY",  customer_name: "Reality Homes",                      extras: ["realityhomes"] },
  { code: "FLINT",   customer_name: "Flint Building",                     extras: ["flintbuilding"] },
  { code: "CLEAR",   customer_name: "Clearwater Construction",            extras: ["clearwater", "clearwaterconstruction"] },
  { code: "LYDIG",   customer_name: "Lydig Construction",                 extras: ["lydigconstruction"] },
  { code: "VEHRS",   customer_name: "Vehrs Distributing",                 extras: ["vehrsdistributing"] },
  { code: "MOLG",    customer_name: "Dr. Max Molgard Prosthodontics",     extras: ["molgard", "maxmolgard", "molgardprosthodontics"] },
  { code: "HORM",    customer_name: "Hormann Door",                       extras: ["hormanndoor"] },
  { code: "HC PROP", customer_name: "High Country Property Management",   extras: ["highcountryproperty", "highcountrypm", "highcountrypropertymanagement"] }
];

/* ============================================================================
   Phase 2A.1 — Deputy → Pioneer service_assignments bridge.
   ============================================================================

   Reads deputy_shift_cache for a date range and creates/updates matching
   service_assignments docs so Pioneer Time Clock has cards to render
   without manual seeding.

   See firestore.rules:1090-1095 — service_assignments writes are admin-only
   from clients; Admin SDK bypasses, so this function writes them. No rule
   change required for Phase 2A.

   IMPORTANT idempotency rules (mirrored from the plan):
     • doc id = "sa_deputy__" + shift_id (deterministic, unique per Deputy
       roster id; handles split shifts on same day for same customer).
       Falls back to "sa__" + sync_date + "__" + tech_slug + "__" + customer_slug
       only when shift_id is missing.
     • staff_uid resolved via admin.auth().getUserByEmail() — shift SKIPPED
       if email->uid lookup fails (tech hasn't signed in yet).
     • customer_slug empty → SKIP.
     • Existing assignment in {in_progress, paused, dcr_pending, completed}
       → REFRESH safe mapping fields ONLY; never touch status / session_id /
       dcr_submission_id / created_at / assigned_by.
     • Cross-check pioneer_service_sessions for live/completed sessions
       before any status change (belt + suspenders).
     • Deputy cancellation → mark assignment status "canceled_by_deputy"
       ONLY if no Pioneer work has started. NEVER delete.
============================================================================ */

const BRIDGE_SOURCE_TAG       = "deputy_bridge_v1";
const BRIDGE_DOC_ID_PREFIX    = "sa_deputy__";
const BRIDGE_LATE_STATUSES    = ["in_progress", "paused", "dcr_pending", "completed"];
const BRIDGE_AVAILABLE_GRACE_HOURS = 6;   // grace window after end_time

function bridgePacificWeekday(date) {
  // 0=Sunday … 6=Saturday — computed via en-US Intl with TZ override.
  try {
    const wk = new Intl.DateTimeFormat("en-US", {
      timeZone: DEPUTY_SYNC_TIMEZONE, weekday: "short"
    }).format(date);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wk];
  } catch (_e) { return null; }
}

function bridgeIsoForPacificDateAt17(yyyyMmDd) {
  // Returns an ISO 8601 string representing 17:00 Pacific on the given
  // date. PST = -08:00; PDT = -07:00. Derive offset by formatting a test
  // date in Pacific and inspecting the result minutes vs UTC.
  const probe = new Date(yyyyMmDd + "T12:00:00Z");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DEPUTY_SYNC_TIMEZONE, hour: "2-digit", hour12: false
  });
  // Pacific hour at UTC noon: 04 (PST) or 05 (PDT). Offset = 12 - hour.
  const pacificHour = parseInt(fmt.format(probe), 10);
  const offsetHours = 12 - pacificHour;   // 8 (PST) or 7 (PDT)
  const sign = "-";
  const hh = String(Math.abs(offsetHours)).padStart(2, "0");
  return yyyyMmDd + "T17:00:00" + sign + hh + ":00";
}

function bridgeAddDays(yyyyMmDd, days) {
  const base = new Date(yyyyMmDd + "T12:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Compute available_from per the customer's flex_start_policy. Defaults
// to start_time (no flex). The supported policy values are:
//   • "sun_to_fri_evening"     — Sunday work available from prior Fri 17:00 PT
//   • "weekend_to_thu_evening" — Sat/Sun work available from prior Thu 17:00 PT
//   • null / absent            — no flex
function bridgeComputeAvailableFrom(startTime, syncDate, flexPolicy) {
  if (!flexPolicy || !startTime) return startTime || null;
  let dt;
  try { dt = startTime.toDate ? startTime.toDate() : new Date(startTime); }
  catch (_e) { return startTime; }
  const wk = bridgePacificWeekday(dt);
  if (wk == null) return startTime;
  if (flexPolicy === "sun_to_fri_evening" && wk === 0) {
    const iso = bridgeIsoForPacificDateAt17(bridgeAddDays(syncDate, -2));
    return admin.firestore.Timestamp.fromDate(new Date(iso));
  }
  if (flexPolicy === "weekend_to_thu_evening" && (wk === 0 || wk === 6)) {
    const offset = (wk === 0) ? -3 : -2;   // Sun→Thu = 3 days back; Sat→Thu = 2
    const iso = bridgeIsoForPacificDateAt17(bridgeAddDays(syncDate, offset));
    return admin.firestore.Timestamp.fromDate(new Date(iso));
  }
  return startTime;
}

function bridgeComputeAvailableUntil(endTime) {
  if (!endTime) return null;
  let dt;
  try { dt = endTime.toDate ? endTime.toDate() : new Date(endTime); }
  catch (_e) { return endTime; }
  const ms = dt.getTime() + BRIDGE_AVAILABLE_GRACE_HOURS * 3600 * 1000;
  return admin.firestore.Timestamp.fromMillis(ms);
}

function bridgeMakeAssignmentId(shift) {
  const sid = shift.shift_id;
  if (sid !== undefined && sid !== null && String(sid).length > 0 && Number(sid) !== 0) {
    return BRIDGE_DOC_ID_PREFIX + String(sid);
  }
  // Fallback per Phase 2A spec — only fires if shift_id is missing/0.
  // Uses tech slug (NOT uid) so the id stays human-debuggable.
  const techKey = String(shift.employee_slug || shift.employee_email || "unknown_tech")
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const custKey = String(shift.customer_slug || "unknown_customer")
    .toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return "sa__" + shift.sync_date + "__" + techKey + "__" + custKey;
}

async function bridgeResolveUid(email, cache) {
  if (!email) return null;
  const key = String(email).toLowerCase().trim();
  if (!key) return null;
  if (cache[key] !== undefined) return cache[key];
  try {
    const user = await admin.auth().getUserByEmail(key);
    cache[key] = user.uid;
    return user.uid;
  } catch (_e) {
    cache[key] = null;
    return null;
  }
}

async function bridgeHasLiveOrCompletedSession(db, assignmentId) {
  try {
    const snap = await db.collection("pioneer_service_sessions")
      .where("assignment_id", "==", assignmentId)
      .where("status", "in", BRIDGE_LATE_STATUSES)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (_e) {
    // Index missing or transient error — be safe and assume sessions
    // exist; the caller will route to "skip status overwrite" path.
    return true;
  }
}

async function bridgeCore(opts) {
  const dryRun     = !!opts.dryRun;
  const startDate  = (typeof opts.syncDate === "string" && opts.syncDate)
                       || deputyTodayLocalDate();
  const daysForward = Math.max(0, Math.min(30, Number(opts.daysForward) || 0));
  const dates = [];
  for (let i = 0; i <= daysForward; i++) dates.push(bridgeAddDays(startDate, i));

  const db = admin.firestore();
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const uidCache = {};
  const custCache = {};

  const report = {
    dry_run:           dryRun,
    invoked_by:        String(opts.invokedBy || "manual"),
    dates:             dates,
    shifts_seen:       0,
    created:           0,
    updated_assigned:  0,
    refreshed_late:    0,
    cancelled:         0,
    skipped: {
      customer_unresolved: 0,
      uid_unresolved:      0,
      no_email:            0,
      protected_session:   0,
      cancelled_no_doc:    0,
      cancelled_locked:    0,
      no_change_needed:    0
    },
    errors:            []
  };
  // Optional per-shift detail when dry_run is on — caps at 50 to keep
  // the response small.
  const details = dryRun ? [] : null;
  function pushDetail(shiftId, action, reason) {
    if (!details || details.length >= 50) return;
    details.push({ shift_id: shiftId, action: action, reason: reason || null });
  }

  for (const date of dates) {
    let shifts = [];
    try {
      const snap = await db.collection("deputy_shift_cache")
        .where("sync_date", "==", date)
        .get();
      shifts = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data() || {});
      });
    } catch (err) {
      report.errors.push({ stage: "load_deputy_cache", date: date, msg: err.message });
      continue;
    }
    report.shifts_seen += shifts.length;

    for (const shift of shifts) {
      const shiftIdStr = String(shift.shift_id || shift.id || "");
      const deputyCancelled = String(shift.status || "") === "cancelled";

      // Skip — customer mapping unresolved.
      if (!shift.customer_slug) {
        if (deputyCancelled) {
          // Nothing to do; no doc would exist.
          report.skipped.customer_unresolved += 1;
          pushDetail(shiftIdStr, "skip", "customer_unresolved+cancelled");
        } else {
          report.skipped.customer_unresolved += 1;
          pushDetail(shiftIdStr, "skip", "customer_unresolved");
        }
        continue;
      }
      // Skip — no email to resolve.
      if (!shift.employee_email) {
        report.skipped.no_email += 1;
        pushDetail(shiftIdStr, "skip", "no_email");
        continue;
      }

      const assignmentId = bridgeMakeAssignmentId(shift);
      const assignmentRef = db.collection("service_assignments").doc(assignmentId);
      let existingSnap;
      try {
        existingSnap = await assignmentRef.get();
      } catch (err) {
        report.errors.push({ stage: "load_existing", shift_id: shiftIdStr, msg: err.message });
        continue;
      }

      // Cancellation handling.
      if (deputyCancelled) {
        if (!existingSnap.exists) {
          report.skipped.cancelled_no_doc += 1;
          pushDetail(shiftIdStr, "skip", "cancelled_no_doc");
          continue;
        }
        const existingData = existingSnap.data() || {};
        const lateStatus = BRIDGE_LATE_STATUSES.indexOf(existingData.status || "") >= 0;
        const hasLive = await bridgeHasLiveOrCompletedSession(db, assignmentId);
        if (lateStatus || hasLive) {
          report.skipped.cancelled_locked += 1;
          pushDetail(shiftIdStr, "skip", "cancelled_locked");
          continue;
        }
        // Mark cancelled; never delete.
        if (!dryRun) {
          try {
            await assignmentRef.update({
              status:             "canceled_by_deputy",
              status_changed_at:  sts,
              status_changed_by:  BRIDGE_SOURCE_TAG,
              updated_at:         sts,
              updated_by:         BRIDGE_SOURCE_TAG
            });
          } catch (err) {
            report.errors.push({ stage: "mark_cancelled", shift_id: shiftIdStr, msg: err.message });
            continue;
          }
        }
        report.cancelled += 1;
        pushDetail(shiftIdStr, "cancel", null);
        continue;
      }

      // Resolve staff_uid.
      const staff_uid = await bridgeResolveUid(shift.employee_email, uidCache);
      if (!staff_uid) {
        report.skipped.uid_unresolved += 1;
        pushDetail(shiftIdStr, "skip", "uid_unresolved");
        continue;
      }

      // Load customer for flex_start_policy + service_budget_minutes.
      let customer = custCache[shift.customer_slug];
      if (customer === undefined) {
        try {
          const cSnap = await db.collection("customers").doc(shift.customer_slug).get();
          customer = cSnap.exists ? (cSnap.data() || {}) : null;
        } catch (_e) { customer = null; }
        custCache[shift.customer_slug] = customer;
      }

      const flexPolicy = (customer && customer.flex_start_policy) || null;
      const budgetMin  = (customer && typeof customer.service_budget_minutes === "number")
                          ? customer.service_budget_minutes
                          : null;

      // Build the mapping fields. Time math uses the cache's Timestamps
      // as-is — they're already correct UTC moments.
      const startTime = shift.start_time || null;
      const endTime   = shift.end_time   || null;
      let estimatedMin = null;
      if (startTime && endTime) {
        const sMs = startTime.toMillis ? startTime.toMillis() : new Date(startTime).getTime();
        const eMs = endTime.toMillis   ? endTime.toMillis()   : new Date(endTime).getTime();
        if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
          estimatedMin = Math.round((eMs - sMs) / 60000);
        }
      }
      if (estimatedMin == null) estimatedMin = 90;

      const availableFrom  = bridgeComputeAvailableFrom(startTime, date, flexPolicy);
      const availableUntil = bridgeComputeAvailableUntil(endTime);

      const mappingFields = {
        service_date:          date,
        staff_uid:             staff_uid,
        staff_email:           String(shift.employee_email || "").toLowerCase().trim(),
        staff_display_name:    shift.employee_display_name || "",
        customer_id:           shift.customer_slug,
        customer_name:         shift.customer_name || "",
        location_id:           null,
        location_name:         null,
        location_address:      null,
        location_lat:          null,
        location_lon:          null,
        location_geofence_radius_m: null,
        service_window_start:  startTime,
        service_deadline:      endTime,
        estimated_minutes:     estimatedMin,
        budget_minutes:        budgetMin,
        allows_flex_start:     true,
        available_from:        availableFrom,
        available_until:       availableUntil,
        schedule_policy:       flexPolicy,
        deputy_shift_id:       Number(shift.shift_id) || null,
        source:                "deputy_bridge",
        updated_at:            sts,
        updated_by:            BRIDGE_SOURCE_TAG
      };

      // CREATE path.
      if (!existingSnap.exists) {
        const payload = Object.assign({}, mappingFields, {
          assignment_id:      assignmentId,
          status:             "assigned",
          status_changed_at:  sts,
          status_changed_by:  BRIDGE_SOURCE_TAG,
          session_id:         null,
          dcr_submission_id:  null,
          created_at:         sts,
          created_by:         BRIDGE_SOURCE_TAG,
          assigned_by:        BRIDGE_SOURCE_TAG,
          notes:              "Auto-created from Deputy shift " + shiftIdStr
        });
        if (!dryRun) {
          try { await assignmentRef.set(payload); }
          catch (err) {
            report.errors.push({ stage: "create", shift_id: shiftIdStr, msg: err.message });
            continue;
          }
        }
        report.created += 1;
        pushDetail(shiftIdStr, "create", null);
        continue;
      }

      // UPDATE paths.
      const existing = existingSnap.data() || {};
      const existingStatus = String(existing.status || "");
      const lateStatus = BRIDGE_LATE_STATUSES.indexOf(existingStatus) >= 0;
      const hasLive = lateStatus
        ? true
        : await bridgeHasLiveOrCompletedSession(db, assignmentId);

      if (lateStatus || hasLive) {
        // REFRESH SAFE FIELDS ONLY — never touch status / session_id /
        // dcr_submission_id / created_at / assigned_by.
        const safe = Object.assign({}, mappingFields);
        delete safe.staff_uid;   // never change tech mid-stream — sessions
                                 // reference this assignment by id, staff
                                 // identity must remain stable
        delete safe.service_date;
        if (!dryRun) {
          try { await assignmentRef.update(safe); }
          catch (err) {
            report.errors.push({ stage: "update_late", shift_id: shiftIdStr, msg: err.message });
            continue;
          }
        }
        report.refreshed_late += 1;
        pushDetail(shiftIdStr, "refresh_late", null);
        continue;
      }

      // Full mapping update — assignment is "assigned" (or
      // "canceled_by_deputy" being re-armed).
      const patch = Object.assign({}, mappingFields, {
        status:             "assigned",
        status_changed_at:  (existingStatus === "assigned") ? (existing.status_changed_at || sts) : sts,
        status_changed_by:  (existingStatus === "assigned") ? (existing.status_changed_by || BRIDGE_SOURCE_TAG) : BRIDGE_SOURCE_TAG
      });
      if (!dryRun) {
        try { await assignmentRef.update(patch); }
        catch (err) {
          report.errors.push({ stage: "update_assigned", shift_id: shiftIdStr, msg: err.message });
          continue;
        }
      }
      report.updated_assigned += 1;
      pushDetail(shiftIdStr, "update_assigned", null);
    }
  }

  if (details) report.details = details;
  return report;
}

/* --- HTTPS twin: admin-only "Refresh Pioneer Time Clock from Deputy" --- */
/* --------------- bridgeDeputyToServiceAssignmentsV1 (Phase 2A.2) ---------------
 *
 * Scheduled twin of refreshServiceAssignmentsFromDeputyV1. Calls the
 * same bridgeCore() so logic stays single-sourced. Sequenced to run
 * ~5 minutes after syncDeputyShiftsV1 (which schedules at :00/:10/…
 * minutes); a :05/:15/… offset would be ideal but Cloud Scheduler doesn't
 * guarantee phase relative to other jobs — what matters is that within
 * any 10-min window the bridge runs after the sync that preceded it.
 *
 * Idempotency: bridgeCore uses a deterministic doc id
 * `sa_deputy__<shift_id>`. On re-run:
 *   • If the assignment doc is in a late status (in_progress / paused /
 *     dcr_pending / completed), only safe mapping fields refresh; status,
 *     session_id, dcr_submission_id, created_at, assigned_by are preserved.
 *   • Live-session safety check: existence of a
 *     pioneer_service_sessions doc in active/paused/dcr_pending/completed
 *     blocks status overwrite.
 *   • Deputy cancellation → status="canceled_by_deputy" only if no
 *     Pioneer work has started. NEVER deletes.
 *
 * If skipped > 0, logs a warning with the per-reason counts so the
 * office can triage uid_unresolved / no_email / customer_unresolved
 * cases via Cloud Logging.
 *
 * Created by the Drew/Whittaker Sev-1 (2026-06-02). The manual
 * refreshServiceAssignmentsFromDeputyV1 stays as an admin-triggered
 * twin for on-demand backfills (e.g. after a mass tech onboarding).
 */
exports.bridgeDeputyToServiceAssignmentsV1 = onSchedule({
  schedule:       "every 10 minutes",
  timeZone:       DEPUTY_SYNC_TIMEZONE,
  timeoutSeconds: 120
}, async (event) => {
  try {
    const result = await bridgeCore({
      invokedBy:   "scheduled",
      daysForward: 1,
      dryRun:      false
    });
    const skippedTotal =
      (result.skipped.customer_unresolved || 0) +
      (result.skipped.uid_unresolved      || 0) +
      (result.skipped.no_email            || 0) +
      (result.skipped.protected_session   || 0) +
      (result.skipped.cancelled_no_doc    || 0) +
      (result.skipped.cancelled_locked    || 0);

    const summary = {
      dates:            result.dates,
      shifts_seen:      result.shifts_seen,
      created:          result.created,
      updated_assigned: result.updated_assigned,
      refreshed_late:   result.refreshed_late,
      cancelled:        result.cancelled,
      skipped:          result.skipped,
      errors_count:     (result.errors || []).length
    };

    if (skippedTotal > 0) {
      logger.warn("bridgeDeputyToServiceAssignmentsV1 had skipped shifts", summary);
    } else {
      logger.info("bridgeDeputyToServiceAssignmentsV1 ok", summary);
    }
    if (result.errors && result.errors.length) {
      logger.error("bridgeDeputyToServiceAssignmentsV1 surfaced errors", {
        errors: result.errors.slice(0, 20)
      });
    }
  } catch (err) {
    logger.error("bridgeDeputyToServiceAssignmentsV1 failed", {
      error: err && err.message,
      stack: err && err.stack
    });
    throw err;   // surface to Cloud Functions for retry semantics
  }
});

exports.refreshServiceAssignmentsFromDeputyV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("refreshServiceAssignmentsFromDeputyV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};

  // Validate sync_date (YYYY-MM-DD) within ±60 days of today.
  let syncDate = null;
  const raw = String(body.sync_date || "").trim();
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      res.status(400).json({ ok: false, error: "sync_date must be YYYY-MM-DD." });
      return;
    }
    const today = new Date(deputyTodayLocalDate() + "T00:00:00Z").getTime();
    const target = new Date(raw + "T00:00:00Z").getTime();
    if (Number.isNaN(target)) {
      res.status(400).json({ ok: false, error: "sync_date is not a real calendar date." });
      return;
    }
    const diffDays = Math.round((target - today) / (24 * 3600 * 1000));
    if (diffDays < -60 || diffDays > 60) {
      res.status(400).json({ ok: false, error: "sync_date must be within ±60 days of today." });
      return;
    }
    syncDate = raw;
  }

  const daysForward = Math.max(0, Math.min(30, Number(body.days_forward) || 0));
  const dryRun = !!body.dry_run;

  try {
    const report = await bridgeCore({
      syncDate:    syncDate,
      daysForward: daysForward,
      dryRun:      dryRun,
      invokedBy:   "admin:" + (staff.email || "")
    });
    logger.info("refreshServiceAssignmentsFromDeputyV1 ok", {
      caller:           staff.email,
      dates:            report.dates,
      shifts_seen:      report.shifts_seen,
      created:          report.created,
      updated_assigned: report.updated_assigned,
      refreshed_late:   report.refreshed_late,
      cancelled:        report.cancelled,
      dry_run:          report.dry_run
    });
    res.status(200).json({ ok: true, report: report });
  } catch (err) {
    logger.error("refreshServiceAssignmentsFromDeputyV1 failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message || "bridge failed" });
  }
});

/* ============================================================================
   Phase 28D — Payroll CSV export + audit log
   ============================================================================

   exportPayrollCsvV1   — admin-only HTTPS POST. Validates readiness,
                          queries approved sessions + sick entries,
                          generates a CSV, uploads to Cloud Storage at
                          payroll_exports/{export_id}/payroll-…csv,
                          generates a 7-day signed URL, atomically writes
                          payroll_exports/{export_id} + flips each
                          included session's payroll_state to "exported"
                          (locking the workweek for re-allocation).

   voidPayrollExportV1  — admin-only HTTPS POST. Reverses an export:
                          marks payroll_exports doc voided, reverts every
                          included session back to "approved_for_payroll",
                          clears export-lock fields. CSV file is NOT
                          deleted (audit trail preserved).

   Rules (firestore + storage):
     • payroll_exports collection: admin read, no client write (Admin SDK
       only).
     • payroll_exports/<id>/<file>.csv in Storage: admin read, no write.

   See also:
     • Phase 28B engine refuses Approve/Unapprove when
       `workweek_locked_by_export === true` on any session in the
       (staff_uid, workweek_id) bucket — set here on export.
============================================================================ */

const PAYROLL_EXPORT_BUCKET = "pioneer-dcr-hub.firebasestorage.app";
const PAYROLL_BATCH_CAP     = 400;                  // Firestore batch limit is 500; leave headroom
const PAYROLL_URL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const PAYROLL_TZ            = "America/Los_Angeles";

function payrollPacificClock(timestamp) {
  if (!timestamp) return "";
  try {
    const ms = timestamp.toMillis ? timestamp.toMillis()
             : (timestamp.seconds ? timestamp.seconds * 1000 : Number(timestamp));
    if (!Number.isFinite(ms)) return "";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: PAYROLL_TZ, hour: "2-digit", minute: "2-digit"
    }).format(new Date(ms));
  } catch (_e) { return ""; }
}
function payrollDecimalHours(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "0.00";
  return (minutes / 60).toFixed(2);
}
function payrollCsvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function payrollCsvRow(arr) {
  return arr.map(payrollCsvCell).join(",");
}
function payrollSessionNotes(s) {
  const out = [];
  if (s.force_closed_by_admin === true) {
    out.push("force-closed" + (s.force_close_reason ? ": " + s.force_close_reason : ""));
  }
  const geoOffsiteIn  = (s.clock_in_geo_status  === "offsite");
  const geoOffsiteOut = (s.clock_out_geo_status === "offsite");
  if (geoOffsiteIn && geoOffsiteOut) out.push("geo offsite (in + out)");
  else if (geoOffsiteIn)             out.push("geo offsite (in)");
  else if (geoOffsiteOut)            out.push("geo offsite (out)");
  const budget = (typeof s.budget_minutes === "number") ? s.budget_minutes : null;
  if (budget != null && budget > 0 && typeof s.work_minutes === "number"
      && s.work_minutes > budget + 15) {
    out.push("over budget by " + (s.work_minutes - budget) + "m");
  }
  if (s.reviewed_by && s.reviewed_at) {
    out.push("admin reviewed");
  }
  return out.join(" | ");
}
function payrollDcrStatus(s) {
  if (s.dcr_status === "submitted") return "submitted";
  if (s.dcr_id) return "submitted";
  if (s.status === "dcr_pending") return "pending";
  return "—";
}
function payrollGeoLabel(s) {
  const inG  = s.clock_in_geo_status  || "—";
  const outG = s.clock_out_geo_status || "—";
  return inG + " / " + outG;
}
function payrollIsBlocker(s) {
  // Mirrors tab-payroll.js computeBlockers semantics. Returns one of the
  // 4 blocker keys, or null if clean. Used both for verification refusal
  // and for the verification_snapshot stored on payroll_exports.
  if (s.admin_removed === true) return null;
  // Phase 29A — QA / test sessions never count as blockers. They are also
  // already excluded from the exportable filter (payroll_state !==
  // "approved_for_payroll"); this keeps the verification snapshot clean.
  if (s.is_test === true || s.exclude_from_payroll_export === true) return null;
  if (s.needs_review === true) return "needs_review";
  if (s.status === "active" || s.status === "paused") return "active";
  if (s.status === "completed" && !s.clock_out_at) return "missing_clockout";
  // Phase Timeclock Add-On — DCR requirement applies only to cleaning
  // labor. Inspection + supply-station sessions never produce a DCR, so
  // they pass this gate. Absent labor_type defaults to cleaning for
  // back-compat with every session written before the field existed.
  const isCleaning = !s.labor_type || s.labor_type === "cleaning";
  if (!isCleaning) return null;
  const dcrSubmitted = (s.dcr_status === "submitted") || s.dcr_status === "waived" || !!s.dcr_id;
  if (s.status === "dcr_pending") return "dcr_pending";
  if (s.status === "completed" && !dcrSubmitted) return "dcr_pending";
  return null;
}

/* --------------- exportPayrollCsvV1 --------------- */

exports.exportPayrollCsvV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("exportPayrollCsvV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const rangeStart  = String(body.range_start  || "").trim();
  const rangeEnd    = String(body.range_end    || "").trim();
  const periodLabel = String(body.period_label || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeStart) || !/^\d{4}-\d{2}-\d{2}$/.test(rangeEnd)) {
    res.status(400).json({ ok: false, error: "range_start and range_end must be YYYY-MM-DD." });
    return;
  }
  if (rangeStart > rangeEnd) {
    res.status(400).json({ ok: false, error: "range_end must be >= range_start." });
    return;
  }
  const startMs = Date.parse(rangeStart + "T00:00:00Z");
  const endMs   = Date.parse(rangeEnd   + "T00:00:00Z");
  if (Math.round((endMs - startMs) / 86400000) + 1 > 31) {
    res.status(400).json({ ok: false, error: "Range too wide — max 31 days." });
    return;
  }

  const db  = admin.firestore();

  try {
    // ----- Phase 29E-B: LOCK_REQUIRED gate -----
    // Only semi-monthly periods are exportable. Custom date ranges have
    // no payroll_periods doc and therefore cannot be locked; refuse with
    // a clear error. Then refuse if the period exists but is not locked.
    const exportPeriod = payrollPeriodFromRange(rangeStart, rangeEnd);
    if (!exportPeriod) {
      res.status(412).json({
        ok:    false,
        error: "Custom date ranges are not supported. Pick a semi-monthly period (1–15 or 16–EOM) and Lock it first.",
        code:  "PERIOD_NOT_SEMI_MONTHLY"
      });
      return;
    }
    const exportPeriodRef = db.collection("payroll_periods").doc(exportPeriod.period_id);
    const exportPeriodSnap = await exportPeriodRef.get();
    const exportPeriodDoc = exportPeriodSnap.exists ? (exportPeriodSnap.data() || {}) : null;
    if (!exportPeriodDoc || exportPeriodDoc.lock_status !== "locked") {
      res.status(412).json({
        ok:    false,
        error: "Period is not locked. Lock the period before exporting.",
        code:  "LOCK_REQUIRED",
        period_id: exportPeriod.period_id
      });
      return;
    }

    // ----- Concurrency guard: refuse if an active export covers this range -----
    const activeSnap = await db.collection("payroll_exports")
      .where("status", "==", "active")
      .get();
    const conflict = activeSnap.docs.find(function (d) {
      const data = d.data() || {};
      return data.range_start === rangeStart && data.range_end === rangeEnd;
    });
    if (conflict) {
      res.status(409).json({
        ok: false, error: "Export already exists for this range. Void it first to re-export.",
        existing_export_id: conflict.id
      });
      return;
    }

    // ----- Server-side verification re-check -----
    const sessSnap = await db.collection("pioneer_service_sessions")
      .where("service_date", ">=", rangeStart)
      .where("service_date", "<=", rangeEnd)
      .get();
    const allSessions = sessSnap.docs.map(function (d) {
      return Object.assign({ _id: d.id, _ref: d.ref }, d.data() || {});
    });
    const verification_snapshot = {
      needs_review_count:     0,
      active_count:           0,
      dcr_pending_count:      0,
      missing_clockout_count: 0
    };
    allSessions.forEach(function (s) {
      const b = payrollIsBlocker(s);
      if (b === "needs_review")     verification_snapshot.needs_review_count += 1;
      if (b === "active")           verification_snapshot.active_count += 1;
      if (b === "dcr_pending")      verification_snapshot.dcr_pending_count += 1;
      if (b === "missing_clockout") verification_snapshot.missing_clockout_count += 1;
    });
    const totalBlockers = verification_snapshot.needs_review_count +
                          verification_snapshot.active_count +
                          verification_snapshot.dcr_pending_count +
                          verification_snapshot.missing_clockout_count;
    if (totalBlockers > 0) {
      res.status(412).json({
        ok: false,
        error: "Payroll not ready — resolve blockers in Labor first.",
        blockers: verification_snapshot
      });
      return;
    }

    // ----- Filter to exportable sessions -----
    const exportable = allSessions.filter(function (s) {
      if (s.admin_removed === true) return false;
      if (s.payroll_state !== "approved_for_payroll") return false;
      return true;
    });

    // ----- Query sick entries in range (used only) -----
    const sickSnap = await db.collection("sick_leave_ledger")
      .where("effective_date", ">=", rangeStart)
      .where("effective_date", "<=", rangeEnd)
      .get();
    const sickEntries = sickSnap.docs
      .map(function (d) { return Object.assign({ _id: d.id, _ref: d.ref }, d.data() || {}); })
      .filter(function (e) { return e.entry_type === "used"; });

    if (!exportable.length && !sickEntries.length) {
      res.status(400).json({ ok: false, error: "Nothing to export — no approved sessions or sick entries in this range." });
      return;
    }

    // ----- Build display-name map (cleaning_techs by uid) -----
    const techSnap = await db.collection("cleaning_techs").get();
    const techByUid   = {};
    const techByEmail = {};
    techSnap.docs.forEach(function (d) {
      const t = Object.assign({ _id: d.id }, d.data() || {});
      if (t.uid) techByUid[t.uid] = t;
      if (t.email) techByEmail[String(t.email).toLowerCase()] = t;
    });
    function techDisplay(uid, email) {
      const t = (uid && techByUid[uid]) || (email && techByEmail[String(email).toLowerCase()]);
      if (t) return t.display_name || (((t.first_name || "") + " " + (t.last_name || "")).trim()) || t.email || "Tech";
      return email || uid || "Tech";
    }

    // ----- Compute summary totals + per-employee aggregation -----
    const employeesSet = new Set();
    let totalRegularMin = 0, totalOvertimeMin = 0, totalSickMin = 0;
    exportable.forEach(function (s) {
      if (s.staff_uid) employeesSet.add(s.staff_uid);
      totalRegularMin  += (typeof s.regular_minutes  === "number") ? s.regular_minutes  : 0;
      totalOvertimeMin += (typeof s.overtime_minutes === "number") ? s.overtime_minutes : 0;
    });
    sickEntries.forEach(function (e) {
      if (e.staff_uid) employeesSet.add(e.staff_uid);
      totalSickMin += Math.abs(Number(e.minutes_delta) || 0);
    });
    const totalDriveMin = 0;  // Phase 28D: drive ships later
    // Mutable — Phase 29 rebucketing below may shift the reg/ot split when any
    // session carries has_approved_time_adjustment. Recomputed after the
    // rebucketing pass.
    let totalPaidMin = totalRegularMin + totalOvertimeMin + totalDriveMin + totalSickMin;

    // ----- Phase 29 — load any approved time-adjustment requests overlapping
    // this range so we can show audit columns (reason / approved by / approved
    // at) for sessions that carry has_approved_time_adjustment === true. Single
    // range query; map by request id.
    const adjMap = {};
    try {
      const adjSnap = await db.collection("time_adjustment_requests")
        .where("shift_date", ">=", rangeStart)
        .where("shift_date", "<=", rangeEnd)
        .get();
      adjSnap.docs.forEach(function (d) {
        const r = d.data() || {};
        if (r.status !== "approved") return;
        adjMap[d.id] = r;
      });
    } catch (err) {
      logger.warn("exportPayrollCsvV1: time_adjustment_requests lookup failed (non-fatal)", {
        error: err && err.message
      });
    }

    // ----- Phase 29 — Re-bucket regular vs overtime per workweek when any
    // session in that bucket carries an approved time adjustment. Sessions
    // without adjustments keep their stored regular_minutes / overtime_minutes
    // from the Labor OT engine; adjusted sessions contribute effective_minutes
    // and the entire workweek is re-split at the 40h cap so the export sums
    // line up with what the office expects to pay.
    function workweekIdForDate(yyyymmdd) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyymmdd || ""))) return "";
      const dt = new Date(yyyymmdd + "T12:00:00Z");
      const dow = dt.getUTCDay();   // 0 = Sunday (workweek start)
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0, 10);
    }
    function sessionStartMs(s) {
      if (s.has_approved_time_adjustment === true && s.effective_clock_in
          && s.effective_clock_in.toMillis) {
        return s.effective_clock_in.toMillis();
      }
      if (s.clock_in_at && s.clock_in_at.toMillis) return s.clock_in_at.toMillis();
      return 0;
    }
    function sessionPayMinutes(s) {
      if (s.has_approved_time_adjustment === true && typeof s.effective_minutes === "number") {
        return s.effective_minutes;
      }
      const reg = (typeof s.regular_minutes  === "number") ? s.regular_minutes  : 0;
      const ot  = (typeof s.overtime_minutes === "number") ? s.overtime_minutes : 0;
      return reg + ot;
    }
    const REG_CAP_MIN = 2400;   // 40h × 60m — must match Labor Review WEEKLY_REGULAR_CAP_MINUTES.
    const wwBuckets = {};
    exportable.forEach(function (s) {
      const ww  = workweekIdForDate(String(s.service_date || ""));
      const key = (s.staff_uid || ("email:" + (s.staff_email || ""))) + "|" + ww;
      if (!wwBuckets[key]) wwBuckets[key] = { sessions: [], adjusted: false };
      wwBuckets[key].sessions.push(s);
      if (s.has_approved_time_adjustment === true) wwBuckets[key].adjusted = true;
    });
    let rebucketDeltaMin = 0;
    Object.keys(wwBuckets).forEach(function (key) {
      const b = wwBuckets[key];
      if (!b.adjusted) return;   // unchanged — keep OT engine's stored split
      b.sessions.sort(function (a, c) { return sessionStartMs(a) - sessionStartMs(c); });
      let regBudget = REG_CAP_MIN;
      b.sessions.forEach(function (s) {
        const mins = Math.max(0, sessionPayMinutes(s));
        const reg  = Math.min(mins, Math.max(regBudget, 0));
        const ot   = Math.max(0, mins - reg);
        regBudget -= reg;
        // Delta for the running totals: (new reg + new ot) − (stored reg + stored ot).
        const priorReg = (typeof s.regular_minutes  === "number") ? s.regular_minutes  : 0;
        const priorOt  = (typeof s.overtime_minutes === "number") ? s.overtime_minutes : 0;
        rebucketDeltaMin += (reg + ot) - (priorReg + priorOt);
        // Track the reg/ot split shift so the summary line reflects the adjustment.
        totalRegularMin  += (reg - priorReg);
        totalOvertimeMin += (ot  - priorOt);
        s._export_regular_minutes  = reg;
        s._export_overtime_minutes = ot;
      });
    });
    if (rebucketDeltaMin !== 0) {
      totalPaidMin += rebucketDeltaMin;
      logger.info("exportPayrollCsvV1: Phase 29 rebucketing applied", {
        rebucket_delta_minutes: rebucketDeltaMin,
        total_regular_after:    totalRegularMin,
        total_overtime_after:   totalOvertimeMin,
        total_paid_after:       totalPaidMin
      });
    }

    // ----- Build CSV (3 sections) -----
    const sessionHeader = [
      "Employee Name","Employee Email","Employee ID","Pay Period","Service Date",
      "Customer","Location","Clock In","Clock Out",
      "Regular Hours","Overtime Hours","Drive Hours","Sick Hours","Total Paid Hours",
      "Payroll State","Needs Review","DCR Status","Geo Status","Notes",
      // Phase 29 — adjustment audit columns. Empty for non-adjusted rows.
      "Time Adjusted?","Original Clock In","Original Clock Out",
      "Adjustment Minutes","Adjustment Reason","Approved By","Approved At"
    ];
    // Sort sessions by employee name then service_date then effective start
    // (or original start when not adjusted).
    exportable.sort(function (a, b) {
      const an = techDisplay(a.staff_uid, a.staff_email);
      const bn = techDisplay(b.staff_uid, b.staff_email);
      const cn = an.localeCompare(bn);
      if (cn !== 0) return cn;
      const da = String(a.service_date || "");
      const db_ = String(b.service_date || "");
      if (da !== db_) return da.localeCompare(db_);
      return sessionStartMs(a) - sessionStartMs(b);
    });
    const sessionRows = exportable.map(function (s) {
      const adjusted = (s.has_approved_time_adjustment === true);
      const reg = (typeof s._export_regular_minutes  === "number")
        ? s._export_regular_minutes
        : ((typeof s.regular_minutes  === "number") ? s.regular_minutes  : 0);
      const ot  = (typeof s._export_overtime_minutes === "number")
        ? s._export_overtime_minutes
        : ((typeof s.overtime_minutes === "number") ? s.overtime_minutes : 0);
      const sessionTotal = reg + ot;  // drive=0, sick=0 on session row
      const clockInTs  = adjusted ? s.effective_clock_in  : s.clock_in_at;
      const clockOutTs = adjusted ? s.effective_clock_out : s.clock_out_at;

      // Phase 29 audit columns — only populated when adjusted.
      let adjReason = "", adjApprovedBy = "", adjApprovedAt = "", adjDeltaStr = "";
      if (adjusted) {
        const r = adjMap[s.time_adjustment_request_id] || {};
        adjReason     = r.reason || "";
        adjApprovedBy = r.reviewed_by_name || "";
        adjApprovedAt = (r.reviewed_at && r.reviewed_at.toMillis)
          ? new Intl.DateTimeFormat("en-US", {
              timeZone: PAYROLL_TZ,
              year: "numeric", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit"
            }).format(new Date(r.reviewed_at.toMillis()))
          : "";
        const eff = (typeof s.effective_minutes === "number")
          ? s.effective_minutes
          : sessionTotal;
        const orig = (typeof s.work_minutes === "number") ? s.work_minutes : null;
        adjDeltaStr = (orig != null) ? String(eff - orig) : String(eff);
      }

      return payrollCsvRow([
        techDisplay(s.staff_uid, s.staff_email),
        s.staff_email || "",
        s.staff_uid || "",
        periodLabel,
        s.service_date || "",
        s.customer_name || s.customer_id || "",
        s.location_address || s.location_id || "",
        payrollPacificClock(clockInTs),
        payrollPacificClock(clockOutTs),
        payrollDecimalHours(reg),
        payrollDecimalHours(ot),
        "0.00",
        "0.00",
        payrollDecimalHours(sessionTotal),
        "exported",
        (s.needs_review === true) ? "true" : "false",
        payrollDcrStatus(s),
        payrollGeoLabel(s),
        payrollSessionNotes(s),
        adjusted ? "yes" : "no",
        adjusted ? payrollPacificClock(s.clock_in_at)  : "",
        adjusted ? payrollPacificClock(s.clock_out_at) : "",
        adjDeltaStr,
        adjReason,
        adjApprovedBy,
        adjApprovedAt
      ]);
    });

    const sickHeader = [
      "Employee Name","Employee Email","Employee ID","Pay Period","Date",
      "Type","Sick Hours","Total Paid Hours","Notes"
    ];
    sickEntries.sort(function (a, b) {
      const an = techDisplay(a.staff_uid, a.staff_email);
      const bn = techDisplay(b.staff_uid, b.staff_email);
      const cn = an.localeCompare(bn);
      if (cn !== 0) return cn;
      return String(a.effective_date || "").localeCompare(String(b.effective_date || ""));
    });
    const sickRows = sickEntries.map(function (e) {
      const min = Math.abs(Number(e.minutes_delta) || 0);
      return payrollCsvRow([
        techDisplay(e.staff_uid, e.staff_email),
        e.staff_email || "",
        e.staff_uid || "",
        periodLabel,
        e.effective_date || "",
        "Sick Leave",
        payrollDecimalHours(min),
        payrollDecimalHours(min),
        e.reason || ""
      ]);
    });

    const generatedAtPT = new Intl.DateTimeFormat("en-US", {
      timeZone: PAYROLL_TZ,
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    }).format(new Date());

    // Pre-allocate the export_id NOW so we can stamp it into the CSV summary.
    const epochMs = Date.now();
    const exportId = "payroll_export__" + rangeStart + "__" + rangeEnd + "__" + epochMs;

    const summaryRows = [
      payrollCsvRow(["Metric", "Value"]),
      payrollCsvRow(["Period", periodLabel]),
      payrollCsvRow(["Range Start", rangeStart]),
      payrollCsvRow(["Range End",   rangeEnd]),
      payrollCsvRow(["Total Employees",   String(employeesSet.size)]),
      payrollCsvRow(["Total Work Sessions", String(exportable.length)]),
      payrollCsvRow(["Total Sick Entries",  String(sickEntries.length)]),
      payrollCsvRow(["Total Regular Hours",  payrollDecimalHours(totalRegularMin)]),
      payrollCsvRow(["Total Overtime Hours", payrollDecimalHours(totalOvertimeMin)]),
      payrollCsvRow(["Total Drive Hours",    payrollDecimalHours(totalDriveMin)]),
      payrollCsvRow(["Total Sick Hours",     payrollDecimalHours(totalSickMin)]),
      payrollCsvRow(["Grand Total Paid Hours", payrollDecimalHours(totalPaidMin)]),
      payrollCsvRow(["Generated By", staff.email || ""]),
      payrollCsvRow(["Generated At", generatedAtPT + " PT"]),
      payrollCsvRow(["Export ID",    exportId])
    ];

    const csv =
      "=== WORK SESSIONS ===\n" +
      payrollCsvRow(sessionHeader) + "\n" +
      sessionRows.join("\n") + "\n" +
      "\n" +
      "=== SICK LEAVE ===\n" +
      payrollCsvRow(sickHeader) + "\n" +
      sickRows.join("\n") + "\n" +
      "\n" +
      "=== TOTALS ===\n" +
      summaryRows.join("\n") + "\n";

    // ----- Upload CSV to Cloud Storage -----
    // Phase 28D revision (v3) — Storage token URLs abandoned after two
    // metadata-persistence attempts couldn't be made reliable in the
    // function runtime. The download path is now an authenticated
    // streaming endpoint (downloadPayrollExportCsvV1) that verifies the
    // admin ID token and streams the CSV server-side. The Storage
    // object stays plain — no customMetadata token, no public URL.
    const storagePath = "payroll_exports/" + exportId + "/payroll-" +
                        rangeStart + "-to-" + rangeEnd + ".csv";
    const bucket = admin.storage().bucket(PAYROLL_EXPORT_BUCKET);
    const file   = bucket.file(storagePath);
    await file.save(Buffer.from(csv, "utf8"), {
      metadata: { contentType: "text/csv; charset=utf-8" }
    });
    const downloadUrl = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/" +
                        "downloadPayrollExportCsvV1?export_id=" + encodeURIComponent(exportId);

    // ----- Atomic batch: payroll_exports doc + per-session updates -----
    const sts = admin.firestore.FieldValue.serverTimestamp();
    const actor = { uid: staff.uid || "", displayName: staff.email || "admin" };

    const includedSessionIds   = exportable.map(function (s) { return s._id; });
    const includedSickEntryIds = sickEntries.map(function (e) { return e._id; });

    const exportRef = db.collection("payroll_exports").doc(exportId);
    const docPayload = {
      export_id:               exportId,
      range_start:             rangeStart,
      range_end:               rangeEnd,
      period_label:            periodLabel,
      status:                  "active",
      generated_by:            actor,
      generated_by_email:      staff.email || "",
      generated_at:            sts,
      employee_count:          employeesSet.size,
      session_count:           exportable.length,
      sick_entry_count:        sickEntries.length,
      regular_hours_total:     Number(payrollDecimalHours(totalRegularMin)),
      overtime_hours_total:    Number(payrollDecimalHours(totalOvertimeMin)),
      drive_hours_total:       Number(payrollDecimalHours(totalDriveMin)),
      sick_hours_total:        Number(payrollDecimalHours(totalSickMin)),
      total_paid_hours:        Number(payrollDecimalHours(totalPaidMin)),
      storage_path:            storagePath,
      // Phase 28D revision — download_url uses the Firebase Storage
      // download-token pattern (no signBlob IAM dependency). signed_url
      // kept as null for back-compat with the field name; UI prefers
      // download_url when present. The token in download_url IS the
      // secret — payroll_exports is admin-read-only by firestore.rules.
      download_url:            downloadUrl,
      signed_url:              null,
      signed_url_expires_at:   null,
      included_session_ids:    includedSessionIds,
      included_sick_entry_ids: includedSickEntryIds,
      verification_snapshot:   verification_snapshot
    };

    // Write payroll_exports doc first.
    await exportRef.set(docPayload);

    // Flip each session in capped batches (Firestore limit 500/batch).
    for (let i = 0; i < exportable.length; i += PAYROLL_BATCH_CAP) {
      const slice = exportable.slice(i, i + PAYROLL_BATCH_CAP);
      const batch = db.batch();
      slice.forEach(function (s) {
        batch.update(s._ref, {
          payroll_state:             "exported",
          payroll_export_id:         exportId,
          exported_at:               sts,
          exported_by:               actor,
          workweek_locked_by_export: true,
          payroll_state_changed_at:  sts,
          payroll_state_changed_by:  actor
        });
      });
      await batch.commit();
    }

    logger.info("exportPayrollCsvV1 ok", {
      caller:           staff.email,
      export_id:        exportId,
      range_start:      rangeStart,
      range_end:        rangeEnd,
      session_count:    exportable.length,
      sick_entry_count: sickEntries.length,
      employee_count:   employeesSet.size
    });

    res.status(200).json({
      ok: true,
      export_id:    exportId,
      download_url: downloadUrl,
      signed_url:   null,            // Phase 28D revision — kept for client back-compat
      storage_path: storagePath,
      summary: {
        period_label:         periodLabel,
        employee_count:       employeesSet.size,
        session_count:        exportable.length,
        sick_entry_count:     sickEntries.length,
        regular_hours_total:  docPayload.regular_hours_total,
        overtime_hours_total: docPayload.overtime_hours_total,
        sick_hours_total:     docPayload.sick_hours_total,
        total_paid_hours:     docPayload.total_paid_hours
      }
    });
  } catch (err) {
    logger.error("exportPayrollCsvV1 failed", { error: err && err.message });
    res.status(500).json({ ok: false, error: (err && err.message) || "Export failed" });
  }
});

/* --------------- voidPayrollExportV1 --------------- */

exports.voidPayrollExportV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const exportId   = String(body.export_id   || "").trim();
  const voidReason = String(body.void_reason || "").trim();
  if (!exportId) {
    res.status(400).json({ ok: false, error: "export_id is required." });
    return;
  }
  if (voidReason.length < 5) {
    res.status(400).json({ ok: false, error: "void_reason must be at least 5 characters." });
    return;
  }

  const db = admin.firestore();
  try {
    const exportRef = db.collection("payroll_exports").doc(exportId);
    const snap = await exportRef.get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: "Export not found." });
      return;
    }
    const data = snap.data() || {};
    if (data.status === "voided") {
      res.status(409).json({ ok: false, error: "Export is already voided." });
      return;
    }

    const sessionIds = Array.isArray(data.included_session_ids) ? data.included_session_ids : [];
    const sts = admin.firestore.FieldValue.serverTimestamp();
    const actor = { uid: staff.uid || "", displayName: staff.email || "admin" };

    // Update payroll_exports doc first.
    await exportRef.update({
      status:          "voided",
      voided_by:       actor,
      voided_by_email: staff.email || "",
      voided_at:       sts,
      void_reason:     voidReason
    });

    // Revert sessions in capped batches.
    for (let i = 0; i < sessionIds.length; i += PAYROLL_BATCH_CAP) {
      const slice = sessionIds.slice(i, i + PAYROLL_BATCH_CAP);
      const batch = db.batch();
      slice.forEach(function (sid) {
        const ref = db.collection("pioneer_service_sessions").doc(sid);
        batch.update(ref, {
          payroll_state:             "approved_for_payroll",
          payroll_export_id:         admin.firestore.FieldValue.delete(),
          exported_at:               admin.firestore.FieldValue.delete(),
          exported_by:               admin.firestore.FieldValue.delete(),
          workweek_locked_by_export: admin.firestore.FieldValue.delete(),
          payroll_state_changed_at:  sts,
          payroll_state_changed_by:  actor
        });
      });
      await batch.commit();
    }

    logger.info("voidPayrollExportV1 ok", {
      caller:        staff.email,
      export_id:     exportId,
      session_count: sessionIds.length
    });
    res.status(200).json({ ok: true, export_id: exportId, sessions_reverted: sessionIds.length });
  } catch (err) {
    logger.error("voidPayrollExportV1 failed", { error: err && err.message });
    res.status(500).json({ ok: false, error: (err && err.message) || "Void failed" });
  }
});

/* ============================================================================
   Phase 29E-B — Payroll Period Lock workflow.
   ============================================================================

   lockPayrollPeriodV1   — admin-only HTTPS POST. Validates the period is
                           Ready (0 blockers + >=1 approved session),
                           sweeps payroll_review_acknowledgments to
                           auto-finalize any unreviewed techs, and writes
                           payroll_periods/{period_id} with lock_status
                           "locked" + snapshot + appended lock_history.

   unlockPayrollPeriodV1 — admin-only HTTPS POST. Refuses if any session
                           in the period is in exported state OR an
                           active payroll_exports doc covers the period.
                           Deletes the auto_finalized ack docs created
                           at lock time, clears lock_* fields, appends
                           lock_history.

   Both functions write payroll_periods via the Admin SDK and therefore
   bypass the (Phase 29E-B) firestore.rules tightening that denies
   client writes on this collection.

   Period identifier: semi-monthly only ("YYYY-MM-A" for days 1-15,
   "YYYY-MM-B" for days 16-EOM). Custom date ranges have no period_id
   and cannot be locked — exportPayrollCsvV1's LOCK_REQUIRED gate
   refuses them.

   No CSV column changes. No payroll hour math changes. The lock is
   purely a workflow commitment + auto-finalize sweep + audit log.
============================================================================ */

// Lazy: only computed when needed. Mirrors public/admin/_utils.js
// getSemiMonthlyPeriod() exactly so admin UI + backend always agree.
function payrollSemiMonthlyPeriodFor(yyyymmdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyymmdd || ""))) return null;
  const parts = yyyymmdd.split("-").map(function (v) { return parseInt(v, 10); });
  const y = parts[0], m = parts[1], d = parts[2];
  const mm = String(m).padStart(2, "0");
  if (d <= 15) {
    return {
      period_id:  y + "-" + mm + "-A",
      half:       "A",
      month:      mm,
      year:       String(y),
      start_date: y + "-" + mm + "-01",
      end_date:   y + "-" + mm + "-15"
    };
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    period_id:  y + "-" + mm + "-B",
    half:       "B",
    month:      mm,
    year:       String(y),
    start_date: y + "-" + mm + "-16",
    end_date:   y + "-" + mm + "-" + String(lastDay).padStart(2, "0")
  };
}
// Period derived from a range. Returns null if the range doesn't EXACTLY
// match a known semi-monthly period — that's how we refuse custom
// ranges from Lock/Unlock/Export-gated flows.
function payrollPeriodFromRange(rangeStart, rangeEnd) {
  const p = payrollSemiMonthlyPeriodFor(rangeStart);
  if (!p) return null;
  if (p.start_date !== rangeStart) return null;
  if (p.end_date   !== rangeEnd)   return null;
  return p;
}

/* --------------- lockPayrollPeriodV1 --------------- */
exports.lockPayrollPeriodV1 = onRequest({
  cors:           false,
  timeoutSeconds: 60,
  invoker:        "public"
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("lockPayrollPeriodV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const periodId = String(body.period_id || "").trim();
  if (!/^\d{4}-\d{2}-(A|B)$/.test(periodId)) {
    res.status(400).json({ ok: false, error: "period_id must be YYYY-MM-A or YYYY-MM-B." });
    return;
  }
  // Derive start/end from period_id so client can't fabricate a range.
  const probeYmd = periodId.endsWith("-A")
    ? (periodId.slice(0, 7) + "-01")
    : (periodId.slice(0, 7) + "-20");
  const period = payrollSemiMonthlyPeriodFor(probeYmd);
  if (!period || period.period_id !== periodId) {
    res.status(400).json({ ok: false, error: "Couldn't resolve period from period_id." });
    return;
  }

  const db = admin.firestore();
  try {
    // ----- Server-side Ready check (mirrors UI banner gate) -----
    const sessSnap = await db.collection("pioneer_service_sessions")
      .where("service_date", ">=", period.start_date)
      .where("service_date", "<=", period.end_date)
      .get();
    const allSessions = sessSnap.docs.map(function (d) {
      return Object.assign({ _id: d.id, _ref: d.ref }, d.data() || {});
    });
    const verification_snapshot = {
      needs_review_count: 0, active_count: 0,
      dcr_pending_count: 0,  missing_clockout_count: 0
    };
    allSessions.forEach(function (s) {
      const b = payrollIsBlocker(s);
      if (b === "needs_review")     verification_snapshot.needs_review_count    += 1;
      if (b === "active")           verification_snapshot.active_count           += 1;
      if (b === "dcr_pending")      verification_snapshot.dcr_pending_count      += 1;
      if (b === "missing_clockout") verification_snapshot.missing_clockout_count += 1;
    });
    const totalBlockers = verification_snapshot.needs_review_count +
                          verification_snapshot.active_count +
                          verification_snapshot.dcr_pending_count +
                          verification_snapshot.missing_clockout_count;
    if (totalBlockers > 0) {
      res.status(412).json({
        ok: false,
        error: "Period is not Ready — resolve blockers in Labor first.",
        blockers: verification_snapshot
      });
      return;
    }
    const counted = allSessions.filter(function (s) {
      if (s.admin_removed === true) return false;
      if (s.is_test === true || s.exclude_from_payroll_export === true) return false;
      return true;
    });
    const approved = counted.filter(function (s) {
      return s.payroll_state === "approved_for_payroll" || s.payroll_state === "exported";
    });
    if (approved.length === 0) {
      res.status(412).json({
        ok: false,
        error: "No approved sessions in this period. Approve in Labor first."
      });
      return;
    }

    // ----- Period doc preflight: refuse if already locked -----
    const periodRef = db.collection("payroll_periods").doc(periodId);
    const periodSnap = await periodRef.get();
    const periodDoc = periodSnap.exists ? (periodSnap.data() || {}) : null;
    if (periodDoc && periodDoc.lock_status === "locked") {
      res.status(409).json({ ok: false, error: "Period is already locked." });
      return;
    }

    // ----- Auto-finalize ack sweep -----
    // Universe = distinct staff_uid across counted (non-archived,
    // non-QA) sessions. Tech with no doc gets an auto_finalized ack.
    const universeUids = new Set();
    counted.forEach(function (s) { if (s.staff_uid) universeUids.add(s.staff_uid); });
    const existingAcksSnap = await db.collection("payroll_review_acknowledgments")
      .where("period_id", "==", periodId)
      .get();
    const existingByUid = {};
    existingAcksSnap.docs.forEach(function (d) {
      const a = d.data() || {};
      if (a.staff_uid) existingByUid[a.staff_uid] = Object.assign({ _id: d.id }, a);
    });
    // techsByUid lookup so the ack doc has a friendly display name.
    const techSnap = await db.collection("cleaning_techs").get();
    const techByUid = {};
    techSnap.docs.forEach(function (d) {
      const t = d.data() || {};
      if (t.uid) techByUid[t.uid] = t;
    });
    function techDisplayLocal(uid) {
      const t = techByUid[uid];
      if (!t) return uid || "Tech";
      return t.display_name ||
             ((t.first_name || "") + " " + (t.last_name || "")).trim() ||
             t.email || uid || "Tech";
    }

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const actor = { uid: staff.uid || "", displayName: staff.email || "admin", email: staff.email || "" };

    // Build the auto-finalize batch. Keep ack ids so unlock can reverse.
    const autoFinalizedAckIds = [];
    const ackBatchOps = [];
    universeUids.forEach(function (uid) {
      if (existingByUid[uid]) return;   // tech already acked manually
      const ackId = periodId + "__" + uid;
      const ackRef = db.collection("payroll_review_acknowledgments").doc(ackId);
      const techEmail = (techByUid[uid] && techByUid[uid].email) || "";
      const techName  = techDisplayLocal(uid);
      ackBatchOps.push({
        ref: ackRef,
        payload: {
          period_id:                periodId,
          period_start_date:        period.start_date,
          period_end_date:          period.end_date,
          staff_uid:                uid,
          staff_email:              techEmail,
          staff_name:               techName,
          status:                   "auto_finalized",
          acknowledged_at:          sts,
          hours_snapshot:           {
            total_minutes:        0,         // not snapshotted at lock time; UI uses session reads
            session_count:        0,
            pending_adj_count:    0,
            approved_adj_count:   0
          },
          auto_finalized_at:        sts,
          auto_finalized_by_lock_period_id: periodId,
          auto_finalized_by:        actor,
          created_at:               sts,
          updated_at:               sts
        }
      });
      autoFinalizedAckIds.push(ackId);
    });

    // ----- Compose period doc payload -----
    let reviewedCount = 0, correctionCount = 0;
    Object.keys(existingByUid).forEach(function (uid) {
      if (!universeUids.has(uid)) return;
      const a = existingByUid[uid];
      if (a.status === "looks_good")            reviewedCount   += 1;
      else if (a.status === "correction_requested") correctionCount += 1;
    });

    const lockEntry = {
      action:                  "locked",
      at:                      sts,
      by:                      actor,
      session_count:           counted.length,
      approved_count:          approved.length,
      auto_finalized_count:    autoFinalizedAckIds.length
    };

    const periodPayload = {
      period_id:                periodId,
      period_label:             // Friendly label so service-clock.js etc. can read it
                                (function () {
                                  try {
                                    const m = new Intl.DateTimeFormat("en-US", {
                                      timeZone: PAYROLL_TZ, month: "short"
                                    }).format(new Date(period.start_date + "T12:00:00Z"));
                                    const yEnd = new Intl.DateTimeFormat("en-US", {
                                      timeZone: PAYROLL_TZ, year: "numeric"
                                    }).format(new Date(period.end_date + "T12:00:00Z"));
                                    return m + " " +
                                           parseInt(period.start_date.slice(8), 10) + "–" +
                                           parseInt(period.end_date.slice(8),   10) + ", " + yEnd;
                                  } catch (_e) { return periodId; }
                                })(),
      month:                    period.month,
      half:                     period.half,
      start_date:               period.start_date,
      end_date:                 period.end_date,
      lock_status:              "locked",
      locked_at:                sts,
      locked_by:                actor,
      locked_state_snapshot: {
        session_count:        counted.length,
        approved_count:       approved.length,
        exported_count:       counted.filter(function (s) { return s.payroll_state === "exported"; }).length,
        employee_count:       universeUids.size,
        reviewed_count:       reviewedCount,
        correction_count:     correctionCount,
        not_reviewed_count:   autoFinalizedAckIds.length,
        auto_finalized_count: autoFinalizedAckIds.length,
        auto_finalized_ack_ids: autoFinalizedAckIds
      },
      lock_history:             admin.firestore.FieldValue.arrayUnion(lockEntry),
      updated_at:               sts
    };

    // ----- Atomic batch commit: acks + period doc -----
    const batch = db.batch();
    ackBatchOps.forEach(function (op) { batch.set(op.ref, op.payload, { merge: true }); });
    batch.set(periodRef, periodPayload, { merge: true });
    await batch.commit();

    logger.info("lockPayrollPeriodV1 ok", {
      caller:                 staff.email,
      period_id:              periodId,
      session_count:          counted.length,
      approved_count:         approved.length,
      auto_finalized_count:   autoFinalizedAckIds.length
    });
    res.status(200).json({
      ok:                     true,
      period_id:              periodId,
      auto_finalized_count:   autoFinalizedAckIds.length,
      auto_finalized_ack_ids: autoFinalizedAckIds,
      locked_state_snapshot:  periodPayload.locked_state_snapshot
    });
  } catch (err) {
    logger.error("lockPayrollPeriodV1 failed", { error: err && err.message, stack: err && err.stack });
    res.status(500).json({ ok: false, error: (err && err.message) || "Lock failed" });
  }
});

/* --------------- unlockPayrollPeriodV1 --------------- */
exports.unlockPayrollPeriodV1 = onRequest({
  cors:           false,
  timeoutSeconds: 60,
  invoker:        "public"
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("unlockPayrollPeriodV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const periodId = String(body.period_id || "").trim();
  if (!/^\d{4}-\d{2}-(A|B)$/.test(periodId)) {
    res.status(400).json({ ok: false, error: "period_id must be YYYY-MM-A or YYYY-MM-B." });
    return;
  }

  const db = admin.firestore();
  try {
    const periodRef = db.collection("payroll_periods").doc(periodId);
    const periodSnap = await periodRef.get();
    if (!periodSnap.exists) {
      res.status(404).json({ ok: false, error: "Period not found." });
      return;
    }
    const periodDoc = periodSnap.data() || {};
    if (periodDoc.lock_status !== "locked") {
      res.status(409).json({ ok: false, error: "Period is not locked." });
      return;
    }

    // ----- Refuse if an active export covers this period -----
    const activeExportSnap = await db.collection("payroll_exports")
      .where("status", "==", "active")
      .where("range_start", "==", periodDoc.start_date)
      .where("range_end",   "==", periodDoc.end_date)
      .get();
    if (!activeExportSnap.empty) {
      res.status(409).json({
        ok: false,
        error: "Period has an active export. Void the export in Recent Exports first.",
        active_export_id: activeExportSnap.docs[0].id
      });
      return;
    }
    // Also refuse if any session in the period is in exported state
    // (paranoia — should be impossible if there's no active export, but
    // covers edge cases like a stale doc).
    const sessExpSnap = await db.collection("pioneer_service_sessions")
      .where("service_date", ">=", periodDoc.start_date)
      .where("service_date", "<=", periodDoc.end_date)
      .where("payroll_state", "==", "exported")
      .get();
    if (!sessExpSnap.empty) {
      res.status(409).json({
        ok: false,
        error: "Period has " + sessExpSnap.size + " exported session(s). Void the export first."
      });
      return;
    }

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const actor = { uid: staff.uid || "", displayName: staff.email || "admin", email: staff.email || "" };

    // ----- Reverse the auto-finalize sweep -----
    const ackIds = (periodDoc.locked_state_snapshot &&
                    Array.isArray(periodDoc.locked_state_snapshot.auto_finalized_ack_ids))
                    ? periodDoc.locked_state_snapshot.auto_finalized_ack_ids
                    : [];

    const unlockEntry = {
      action:               "unlocked",
      at:                   sts,
      by:                   actor,
      reverted_ack_count:   ackIds.length
    };

    // ----- Atomic batch: delete auto_finalized acks + clear lock fields -----
    const batch = db.batch();
    ackIds.forEach(function (ackId) {
      batch.delete(db.collection("payroll_review_acknowledgments").doc(ackId));
    });
    batch.update(periodRef, {
      lock_status:              "unlocked",
      locked_at:                admin.firestore.FieldValue.delete(),
      locked_by:                admin.firestore.FieldValue.delete(),
      locked_state_snapshot:    admin.firestore.FieldValue.delete(),
      lock_history:             admin.firestore.FieldValue.arrayUnion(unlockEntry),
      updated_at:               sts
    });
    await batch.commit();

    logger.info("unlockPayrollPeriodV1 ok", {
      caller:             staff.email,
      period_id:          periodId,
      reverted_ack_count: ackIds.length
    });
    res.status(200).json({
      ok:                 true,
      period_id:          periodId,
      reverted_ack_count: ackIds.length
    });
  } catch (err) {
    logger.error("unlockPayrollPeriodV1 failed", { error: err && err.message, stack: err && err.stack });
    res.status(500).json({ ok: false, error: (err && err.message) || "Unlock failed" });
  }
});

/* --------------- downloadPayrollExportCsvV1 ---------------
 *
 * Authenticated streaming download of a payroll export's CSV. Replaces
 * the Firebase Storage signed-URL / token-URL approaches that failed
 * in this runtime. Admin gates exactly the same as the other 28D
 * functions; downloads both active and voided exports (voided CSVs are
 * the audit artifact and must remain accessible).
 *
 * The CSV is buffered via file.download() rather than piped via a
 * read stream because Express on Cloud Functions Gen 2 doesn't always
 * forward stream backpressure cleanly; a typical payroll CSV is a few
 * MB so the buffer fits comfortably under the function memory cap.
 */
exports.downloadPayrollExportCsvV1 = onRequest({
  cors:           false,
  timeoutSeconds: 60
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Expose-Headers", "Content-Disposition, Content-Type");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("downloadPayrollExportCsvV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const exportId = String(
    (req.query && req.query.export_id) || (req.body && req.body.export_id) || ""
  ).trim();
  if (!exportId) {
    res.status(400).json({ ok: false, error: "export_id is required." });
    return;
  }

  try {
    const db = admin.firestore();
    const snap = await db.collection("payroll_exports").doc(exportId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: "Export not found." });
      return;
    }
    const data = snap.data() || {};
    if (data.status !== "active" && data.status !== "voided") {
      res.status(409).json({ ok: false, error: "Export status is " + data.status });
      return;
    }
    if (!data.storage_path) {
      res.status(500).json({ ok: false, error: "Export has no storage_path." });
      return;
    }

    const bucket = admin.storage().bucket(PAYROLL_EXPORT_BUCKET);
    const file   = bucket.file(data.storage_path);
    const [exists] = await file.exists();
    if (!exists) {
      logger.warn("downloadPayrollExportCsvV1 storage file missing", {
        export_id: exportId, storage_path: data.storage_path
      });
      res.status(404).json({ ok: false, error: "CSV file is no longer in Storage." });
      return;
    }

    const [buffer] = await file.download();
    const filename = "payroll-" + (data.range_start || "unknown") +
                     "-to-" + (data.range_end || "unknown") + ".csv";

    logger.info("downloadPayrollExportCsvV1 served", {
      caller:       staff.email,
      export_id:    exportId,
      storage_path: data.storage_path,
      bytes:        buffer.length,
      status:       data.status
    });

    res.set("Content-Type",        "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="' + filename + '"');
    res.set("Cache-Control",       "no-store");
    res.status(200).send(buffer);
  } catch (err) {
    logger.error("downloadPayrollExportCsvV1 failed", { error: err && err.message });
    res.status(500).json({ ok: false, error: (err && err.message) || "Download failed" });
  }
});

/* ============================================================================
 * Phase 29 — Payroll Exception Engine.
 *
 * Replaces the Slack-based payroll correction loop. Employees REQUEST time
 * adjustments via createTimeAdjustmentRequestV1; admins approve / deny via
 * approveTimeAdjustmentRequestV1 / denyTimeAdjustmentRequestV1.
 *
 * Critical invariants (per Phase 29 spec):
 *   • Original clock data on the session is NEVER overwritten. Approved
 *     effective times are stamped as new fields:
 *       has_approved_time_adjustment, effective_clock_in, effective_clock_out,
 *       effective_minutes, time_adjustment_request_id
 *   • Active / paused sessions cannot be adjusted (would break clock state).
 *   • Sessions whose workweek is locked for payroll are off-limits to this
 *     flow — payroll_state in {approved_for_payroll, exported} or
 *     workweek_locked_by_export === true. Admin must use the existing Labor
 *     Review unlock path first.
 *   • Approval mutates ONLY the four effective fields + time_adjustment_request_id
 *     on the session. work_minutes / clock_in_at / clock_out_at / payroll_state
 *     / DCR linkage are preserved. The payroll export re-buckets OT on the
 *     fly when has_approved_time_adjustment is true.
 *   • One pending request per (employee, assignment, session) — duplicates
 *     are refused.
 *   • Submission window: shift_date in {today PT, yesterday PT} OR shift_date
 *     within the current semi-monthly pay period.
 *
 * Auth model:
 *   • create — the assigned tech (or admin on their behalf). employees can
 *     only submit for their own assignment.
 *   • approve / deny — admin only.
 *
 * Audit trail:
 *   • The request doc itself is append-only-shaped: original_clock_in/out and
 *     original_minutes are snapshotted at submit time, never updated.
 *   • reviewed_by_uid + reviewed_by_name + reviewed_at stamped on
 *     approve/deny. denial_reason stamped on deny.
 * ============================================================================ */

const TIME_ADJUSTMENT_REASONS = [
  "forgot_clock_in", "forgot_clock_out", "app_issue",
  "phone_issue", "no_internet", "emergency", "other"
];
const TIME_ADJUSTMENT_TZ = "America/Los_Angeles";

function payrollExceptionTodayPT() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ADJUSTMENT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function payrollExceptionAddDaysPT(yyyyMmDd, days) {
  const dt = new Date(yyyyMmDd + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ADJUSTMENT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(dt);
}
function payrollExceptionGetEndOfMonth(yyyyMmDd) {
  const parts = String(yyyyMmDd).split("-");
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return parts[0] + "-" + parts[1] + "-" + String(lastDay).padStart(2, "0");
}
function payrollExceptionGetSemiMonthlyPeriod(yyyyMmDd) {
  const parts = String(yyyyMmDd).split("-");
  const year  = parts[0], month = parts[1];
  const day   = parseInt(parts[2], 10);
  const half  = (day <= 15) ? "A" : "B";
  const start = (half === "A") ? (year + "-" + month + "-01") : (year + "-" + month + "-16");
  const end   = (half === "A") ? (year + "-" + month + "-15") : payrollExceptionGetEndOfMonth(yyyyMmDd);
  return { period_id: year + "-" + month + "-" + half, start_date: start, end_date: end };
}

// Resolves the tech display name + email from cleaning_techs by uid.
// Used at submit time to denormalize so the admin pending list doesn't
// require a second lookup.
async function resolveTechIdentityByUid(uid) {
  if (!uid) return { name: "", email: "" };
  try {
    const snap = await db.collection(TECHS_COLLECTION)
      .where("uid", "==", uid)
      .limit(1)
      .get();
    if (snap.empty) return { name: "", email: "" };
    const t = snap.docs[0].data() || {};
    const name = t.display_name
      || (((t.first_name || "") + " " + (t.last_name || "")).trim())
      || t.email || "";
    return { name: name, email: t.email || "" };
  } catch (err) {
    logger.warn("resolveTechIdentityByUid failed (non-fatal)", { error: err && err.message, uid: uid });
    return { name: "", email: "" };
  }
}

/* --------------- createTimeAdjustmentRequestV1 --------------- */

/* ============================================================================
   V20260614 — waiveDcrV1
   POST { assignment_id, service_session_id?, reason_code, reason_detail? }

   Marks a completed pioneer_service_session as DCR-waived. Used by the
   "No DCR Needed" button on /work.html when a tech / admin needs to
   close a shift without sending a customer-facing DCR — test shifts,
   accidental clock-ins, internal work, customers that don't require
   a DCR.

   Authorization: any signed-in cleaning_tech may waive their OWN
   session. Admins may waive any session. The role gate matches the
   spirit of design choice #2 from the planning round (techs can self-
   serve; every waive is audit-logged and visible to admin).

   Idempotent: re-waiving an already-waived session returns ok with
   the existing audit. Submitting (a real DCR) and waiving are
   mutually exclusive: if dcr_submission_id is already set on the
   session, this endpoint refuses. (Admin can revoke the DCR
   separately if they need to land here.)

   Writes:
     pioneer_service_sessions/{sid}:
       dcr_status                    = "waived"
       dcr_waived_at                 = serverTimestamp
       dcr_waived_by_uid             = staff.uid
       dcr_waived_by_email           = staff.email
       dcr_waived_reason             = reason_code
       dcr_waived_reason_detail      = reason_detail (or null)
       dcr_customer_email_suppressed = true
       updated_at                    = serverTimestamp
     service_assignments/{aid} (denormalized convenience for admin view):
       dcr_waived                    = true
       dcr_waived_at                 = serverTimestamp
       dcr_waived_reason             = reason_code
       dcr_waived_session_id         = sid
       updated_at                    = serverTimestamp

   Returns:
     { ok: true,
       session_id, assignment_id,
       dcr_status, dcr_waived_reason,
       already_waived: boolean }
   ============================================================================ */

const WAIVE_DCR_REASONS = [
  "test_shift",
  "duplicate_clock_in",
  "internal_work",
  "customer_no_dcr",
  "other"
];

exports.waiveDcrV1 = onRequest({
  cors:           false,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const body = req.body || {};
  const assignmentId   = String(body.assignment_id      || "").trim();
  const sessionIdInput = String(body.service_session_id || "").trim();
  const reasonCode     = String(body.reason_code        || "").trim();
  const reasonDetailIn = body.reason_detail == null
                          ? ""
                          : String(body.reason_detail).trim();

  if (!assignmentId) {
    res.status(400).json({ ok: false, error: "assignment_id is required." });
    return;
  }
  if (WAIVE_DCR_REASONS.indexOf(reasonCode) < 0) {
    res.status(400).json({
      ok: false,
      error: "reason_code must be one of: " + WAIVE_DCR_REASONS.join(", ")
    });
    return;
  }
  if (reasonCode === "other" && reasonDetailIn.length < 3) {
    res.status(400).json({
      ok: false,
      error: "reason_detail (≥ 3 characters) is required when reason_code is 'other'."
    });
    return;
  }
  const reasonDetail = reasonDetailIn ? reasonDetailIn.slice(0, 240) : null;

  try {
    // Resolve the assignment + ownership gate.
    const assignSnap = await db.collection("service_assignments").doc(assignmentId).get();
    if (!assignSnap.exists) {
      res.status(404).json({ ok: false, error: "Assignment not found." });
      return;
    }
    const a = assignSnap.data() || {};
    const isAdmin = staff.role === "admin";
    if (!isAdmin && a.staff_uid !== staff.uid) {
      res.status(403).json({
        ok: false,
        error: "You can only waive DCRs on your own assignments."
      });
      return;
    }

    // Resolve the session. Prefer the caller-supplied id; fall back to
    // the latest completed session for this assignment owned by them.
    let sessionRef = null;
    let sessionSnap = null;
    if (sessionIdInput) {
      sessionRef = db.collection("pioneer_service_sessions").doc(sessionIdInput);
      sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) {
        res.status(404).json({ ok: false, error: "Session not found." });
        return;
      }
    } else {
      const sessionQry = await db.collection("pioneer_service_sessions")
        .where("assignment_id", "==", assignmentId)
        .where("staff_uid",     "==", a.staff_uid)
        .where("status",        "==", "completed")
        .orderBy("clock_out_at", "desc")
        .limit(1)
        .get();
      if (sessionQry.empty) {
        res.status(404).json({
          ok: false,
          error: "No completed session on this assignment to waive."
        });
        return;
      }
      sessionRef  = sessionQry.docs[0].ref;
      sessionSnap = sessionQry.docs[0];
    }
    const s = sessionSnap.data() || {};

    // Cross-check: session belongs to the same assignment + owner.
    if (s.assignment_id !== assignmentId) {
      res.status(400).json({
        ok: false,
        error: "Session does not belong to this assignment."
      });
      return;
    }
    if (!isAdmin && s.staff_uid !== staff.uid) {
      res.status(403).json({
        ok: false,
        error: "You can only waive DCRs on your own sessions."
      });
      return;
    }

    // Refuse waiving an actively-running session — clock out first.
    if (s.status === "active") {
      res.status(409).json({
        ok: false,
        error: "Clock out of this session before waiving its DCR."
      });
      return;
    }

    // If a real DCR was already submitted, refuse. Admin can revoke
    // the DCR via a separate flow if they need to land here.
    if (s.dcr_submission_id || s.dcr_status === "submitted") {
      res.status(409).json({
        ok: false,
        error: "A DCR was already submitted for this session. Contact admin to revoke before waiving."
      });
      return;
    }

    // Idempotent re-waive — return ok with current audit shape.
    if (s.dcr_status === "waived") {
      res.json({
        ok:                  true,
        session_id:          sessionRef.id,
        assignment_id:       assignmentId,
        dcr_status:          "waived",
        dcr_waived_reason:   s.dcr_waived_reason || null,
        already_waived:      true
      });
      return;
    }

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const sessionUpdate = {
      dcr_status:                    "waived",
      dcr_waived_at:                 sts,
      dcr_waived_by_uid:             staff.uid,
      dcr_waived_by_email:           String(staff.email || "").toLowerCase().trim(),
      dcr_waived_reason:             reasonCode,
      dcr_waived_reason_detail:      reasonDetail,
      dcr_customer_email_suppressed: true,
      updated_at:                    sts
    };
    const assignmentUpdate = {
      dcr_waived:           true,
      dcr_waived_at:        sts,
      dcr_waived_reason:    reasonCode,
      dcr_waived_session_id: sessionRef.id,
      updated_at:           sts
    };

    await db.runTransaction(async (tx) => {
      tx.set(sessionRef, sessionUpdate, { merge: true });
      tx.set(assignSnap.ref, assignmentUpdate, { merge: true });
    });

    logger.info("waiveDcrV1 ok", {
      assignment_id: assignmentId,
      session_id:    sessionRef.id,
      reason_code:   reasonCode,
      by_uid:        staff.uid,
      by_email:      staff.email,
      is_admin:      isAdmin
    });

    res.json({
      ok:                  true,
      session_id:          sessionRef.id,
      assignment_id:       assignmentId,
      dcr_status:          "waived",
      dcr_waived_reason:   reasonCode,
      already_waived:      false
    });
  } catch (err) {
    logger.error("waiveDcrV1 crashed", {
      error: err && err.message, code: err && err.code,
      assignment_id: assignmentId
    });
    res.status(500).json({ ok: false, error: "waiveDcrV1 crashed: " + (err && err.message) });
  }
});

/* ============================================================================
   V20260614 — listWaivedDcrsV1
   GET (or POST with optional body { limit?, since_iso?, customer_slug? })

   Admin-only audit endpoint. Returns the most recent DCR waivers
   recorded by waiveDcrV1, oldest-first within the window. Drives the
   future admin "Waived DCRs" tab. For today, admin operators can hit
   this endpoint with their Firebase Auth bearer token to see the
   exception list:

     curl -X POST https://us-central1-…/listWaivedDcrsV1 \
       -H "Authorization: Bearer <id_token>" \
       -H "Content-Type: application/json" \
       -d '{ "limit": 50 }'

   Until the tab UI is wired (TODO: public/admin/tab-dcr-waivers.js),
   this is the source of truth for the "visible in admin" guardrail.

   Query mechanics: reads pioneer_service_sessions where
     dcr_status == "waived"
   ordered by dcr_waived_at desc. Requires a small composite index
   added in firestore.indexes.json in this commit.

   Returns:
     { ok: true,
       count: number,
       waivers: [
         { session_id, assignment_id, staff_uid, staff_email,
           customer_slug, customer_name, service_date,
           dcr_waived_at_iso, dcr_waived_by_uid, dcr_waived_by_email,
           dcr_waived_reason, dcr_waived_reason_detail,
           paid_minutes, clock_in_at_iso, clock_out_at_iso } ] }
   ============================================================================ */

exports.listWaivedDcrsV1 = onRequest({
  cors:           false,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
  const limitIn = Number(body.limit);
  const limit   = Number.isFinite(limitIn) && limitIn > 0 && limitIn <= 500
                    ? Math.floor(limitIn) : 50;
  const sinceIso = String(body.since_iso || "").trim();
  const filterCustomerSlug = String(body.customer_slug || "").trim();

  try {
    let q = db.collection("pioneer_service_sessions")
      .where("dcr_status", "==", "waived")
      .orderBy("dcr_waived_at", "desc")
      .limit(limit);
    if (sinceIso) {
      const sinceMs = Date.parse(sinceIso);
      if (Number.isFinite(sinceMs)) {
        q = q.where("dcr_waived_at", ">=", admin.firestore.Timestamp.fromMillis(sinceMs));
      }
    }
    const snap = await q.get();

    function tsIso(ts) {
      if (!ts) return null;
      if (typeof ts.toDate === "function") {
        try { return ts.toDate().toISOString(); } catch (_e) {}
      }
      if (typeof ts.seconds === "number") {
        return new Date(ts.seconds * 1000).toISOString();
      }
      return null;
    }

    const waivers = [];
    snap.docs.forEach(function (d) {
      const s = d.data() || {};
      if (filterCustomerSlug && String(s.customer_slug || "") !== filterCustomerSlug) return;
      waivers.push({
        session_id:               d.id,
        assignment_id:            s.assignment_id || null,
        staff_uid:                s.staff_uid || null,
        staff_email:              s.staff_email || null,
        customer_slug:            s.customer_slug || null,
        customer_name:            s.customer_name || null,
        service_date:             s.service_date || null,
        dcr_waived_at_iso:        tsIso(s.dcr_waived_at),
        dcr_waived_by_uid:        s.dcr_waived_by_uid || null,
        dcr_waived_by_email:      s.dcr_waived_by_email || null,
        dcr_waived_reason:        s.dcr_waived_reason || null,
        dcr_waived_reason_detail: s.dcr_waived_reason_detail || null,
        paid_minutes:             (typeof s.paid_minutes === "number") ? s.paid_minutes : null,
        clock_in_at_iso:          tsIso(s.clock_in_at),
        clock_out_at_iso:         tsIso(s.clock_out_at)
      });
    });

    res.json({ ok: true, count: waivers.length, waivers: waivers });
  } catch (err) {
    logger.error("listWaivedDcrsV1 crashed", {
      error: err && err.message, code: err && err.code,
      caller_email: staff.email
    });
    // Composite index not built yet — surface a friendly hint.
    if (err && err.code === "failed-precondition") {
      res.status(503).json({
        ok: false,
        error: "Composite index still building or missing: pioneer_service_sessions (dcr_status asc, dcr_waived_at desc). Add it to firestore.indexes.json + firebase deploy --only firestore:indexes."
      });
      return;
    }
    res.status(500).json({ ok: false, error: "listWaivedDcrsV1 crashed: " + (err && err.message) });
  }
});

exports.createTimeAdjustmentRequestV1 = onRequest({
  cors:           false,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const body = req.body || {};
  const assignmentId         = String(body.assignment_id       || "").trim();
  const serviceSessionId     = String(body.service_session_id  || "").trim();
  const requestedClockInRaw  = String(body.requested_clock_in  || "").trim();
  const requestedClockOutRaw = String(body.requested_clock_out || "").trim();
  const reason               = String(body.reason              || "").trim();
  const notes                = String(body.notes               || "").trim();

  if (!assignmentId)     { res.status(400).json({ ok: false, error: "assignment_id is required." });     return; }
  if (!serviceSessionId) { res.status(400).json({ ok: false, error: "service_session_id is required — only sessions with a clock-in/out can be adjusted." }); return; }
  if (!notes)            { res.status(400).json({ ok: false, error: "notes is required." });             return; }
  if (TIME_ADJUSTMENT_REASONS.indexOf(reason) < 0) {
    res.status(400).json({ ok: false, error: "reason must be one of: " + TIME_ADJUSTMENT_REASONS.join(", ") });
    return;
  }

  const reqInMs  = Date.parse(requestedClockInRaw);
  const reqOutMs = Date.parse(requestedClockOutRaw);
  if (!Number.isFinite(reqInMs) || !Number.isFinite(reqOutMs)) {
    res.status(400).json({ ok: false, error: "requested_clock_in and requested_clock_out must be ISO timestamps." });
    return;
  }
  if (reqOutMs <= reqInMs) {
    res.status(400).json({ ok: false, error: "requested_clock_out must be after requested_clock_in." });
    return;
  }
  const requestedMinutes = Math.round((reqOutMs - reqInMs) / 60000);
  if (requestedMinutes > 24 * 60) {
    res.status(400).json({ ok: false, error: "Requested span longer than 24 hours is not allowed." });
    return;
  }

  try {
    const assignSnap = await db.collection("service_assignments").doc(assignmentId).get();
    if (!assignSnap.exists) {
      res.status(404).json({ ok: false, error: "Assignment not found." });
      return;
    }
    const a = assignSnap.data() || {};

    // Employees may only submit for their own assignment. Admins may submit on
    // behalf of any tech.
    if (staff.role !== "admin" && a.staff_uid !== staff.uid) {
      res.status(403).json({ ok: false, error: "You can only adjust your own shifts." });
      return;
    }

    const sessRef = db.collection("pioneer_service_sessions").doc(serviceSessionId);
    const sessSnap = await sessRef.get();
    if (!sessSnap.exists) {
      res.status(404).json({ ok: false, error: "Session not found." });
      return;
    }
    const s = sessSnap.data() || {};
    if (s.assignment_id !== assignmentId) {
      res.status(400).json({ ok: false, error: "Session does not belong to that assignment." });
      return;
    }
    if (s.status === "active" || s.status === "paused") {
      res.status(409).json({ ok: false, error: "Clock out of this shift before requesting an adjustment." });
      return;
    }
    if (s.payroll_state === "approved_for_payroll" || s.payroll_state === "exported"
        || s.workweek_locked_by_export === true) {
      res.status(409).json({
        ok:    false,
        error: "This shift is already in a locked payroll period — contact admin for an override."
      });
      return;
    }

    const shiftDate = String(s.service_date || a.service_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      res.status(400).json({ ok: false, error: "Shift date missing or malformed on this session." });
      return;
    }

    // Window: today, yesterday, OR within current semi-monthly pay period.
    // Union of the two halves; "yesterday" matters at the period boundary
    // (e.g. today is the 16th, yesterday is the 15th of the previous period).
    const todayPT     = payrollExceptionTodayPT();
    const yesterdayPT = payrollExceptionAddDaysPT(todayPT, -1);
    const period      = payrollExceptionGetSemiMonthlyPeriod(todayPT);
    const allowedStart = (yesterdayPT < period.start_date) ? yesterdayPT : period.start_date;
    const allowedEnd   = todayPT;
    if (shiftDate < allowedStart || shiftDate > allowedEnd) {
      res.status(400).json({
        ok:    false,
        error: "Shift is outside the allowed window (today, yesterday, or current pay period "
               + period.start_date + " → " + period.end_date + ")."
      });
      return;
    }

    // Duplicate-pending check. Single equality query on assignment + status
    // (no composite index needed: this collection won't have many rows per
    // assignment, so client-side staff_uid filter is fine).
    const dupSnap = await db.collection("time_adjustment_requests")
      .where("assignment_id", "==", assignmentId)
      .where("status",        "==", "pending")
      .limit(20)
      .get();
    const dup = dupSnap.docs.find(function (d) {
      const r = d.data() || {};
      return r.employee_uid === a.staff_uid && r.service_session_id === serviceSessionId;
    });
    if (dup) {
      res.status(409).json({
        ok:    false,
        error: "A pending request already exists for this shift.",
        existing_request_id: dup.id
      });
      return;
    }

    // Compute originals + delta.
    const origInMs  = (s.clock_in_at  && s.clock_in_at.toMillis)  ? s.clock_in_at.toMillis()  : null;
    const origOutMs = (s.clock_out_at && s.clock_out_at.toMillis) ? s.clock_out_at.toMillis() : null;
    const originalMinutes = (typeof s.work_minutes === "number")
      ? s.work_minutes
      : (origInMs != null && origOutMs != null ? Math.round((origOutMs - origInMs) / 60000) : null);
    const deltaMinutes = (originalMinutes != null)
      ? (requestedMinutes - originalMinutes)
      : requestedMinutes;

    const tech = await resolveTechIdentityByUid(a.staff_uid);

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const docRef = db.collection("time_adjustment_requests").doc();
    await docRef.set({
      assignment_id:         assignmentId,
      service_session_id:    serviceSessionId,
      employee_uid:          a.staff_uid,
      employee_name:         tech.name || a.staff_display_name || "",
      employee_email:        tech.email || "",
      customer_name:         s.customer_name || a.customer_name || "",
      location_name:         s.location_address || a.location_name || a.location_id || "",
      shift_date:            shiftDate,
      status:                "pending",
      original_clock_in:     s.clock_in_at  || null,
      original_clock_out:    s.clock_out_at || null,
      requested_clock_in:    admin.firestore.Timestamp.fromMillis(reqInMs),
      requested_clock_out:   admin.firestore.Timestamp.fromMillis(reqOutMs),
      original_minutes:      originalMinutes,
      requested_minutes:     requestedMinutes,
      delta_minutes:         deltaMinutes,
      reason:                reason,
      notes:                 notes,
      payroll_impact_cents:  null,   // pay rate not modeled yet (V1)
      submitted_at:          sts,
      submitted_by_uid:      staff.uid,
      created_at:            sts,
      updated_at:            sts
    });

    logger.info("time adjustment request created", {
      request_id: docRef.id, employee_uid: a.staff_uid, assignment_id: assignmentId,
      session_id: serviceSessionId, reason: reason, delta_minutes: deltaMinutes
    });
    res.status(200).json({ ok: true, request_id: docRef.id });
  } catch (err) {
    logger.error("createTimeAdjustmentRequestV1 failed", {
      error: err && err.message, stack: err && err.stack
    });
    res.status(500).json({ ok: false, error: (err && err.message) || "Create failed" });
  }
});

/* --------------- approveTimeAdjustmentRequestV1 --------------- */

exports.approveTimeAdjustmentRequestV1 = onRequest({
  cors:           false,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const requestId = String(body.request_id || "").trim();
  if (!requestId) {
    res.status(400).json({ ok: false, error: "request_id is required." });
    return;
  }

  try {
    const reqRef  = db.collection("time_adjustment_requests").doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) {
      res.status(404).json({ ok: false, error: "Request not found." });
      return;
    }
    const r = reqSnap.data() || {};
    if (r.status !== "pending") {
      res.status(409).json({ ok: false, error: "Request is not pending (status: " + r.status + ")." });
      return;
    }

    const sessRef  = db.collection("pioneer_service_sessions").doc(r.service_session_id);
    const sessSnap = await sessRef.get();
    if (!sessSnap.exists) {
      res.status(404).json({ ok: false, error: "Session referenced by this request no longer exists." });
      return;
    }
    const s = sessSnap.data() || {};
    if (s.status === "active" || s.status === "paused") {
      res.status(409).json({ ok: false, error: "Session is currently active/paused — cannot apply an adjustment." });
      return;
    }
    if (s.payroll_state === "approved_for_payroll" || s.payroll_state === "exported"
        || s.workweek_locked_by_export === true) {
      res.status(409).json({
        ok:    false,
        error: "Session's workweek is locked for payroll. Unlock in Labor Review before approving."
      });
      return;
    }

    // Effective values come from the request (employee-stated). Defensive
    // re-check — request fields were validated at create time but the
    // session may have been edited since.
    const effectiveIn  = r.requested_clock_in;
    const effectiveOut = r.requested_clock_out;
    if (!effectiveIn || !effectiveOut || typeof effectiveIn.toMillis !== "function") {
      res.status(400).json({ ok: false, error: "Request is missing requested clock timestamps." });
      return;
    }
    const effectiveMinutes = Math.round((effectiveOut.toMillis() - effectiveIn.toMillis()) / 60000);
    const finalDeltaMinutes = (typeof s.work_minutes === "number")
      ? (effectiveMinutes - s.work_minutes)
      : effectiveMinutes;

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const reviewerName = (staff.tech && staff.tech.display_name) || staff.email || "Admin";

    const batch = db.batch();
    batch.update(reqRef, {
      status:                "approved",
      reviewed_by_uid:       staff.uid,
      reviewed_by_name:      reviewerName,
      reviewed_at:           sts,
      effective_clock_in:    effectiveIn,
      effective_clock_out:   effectiveOut,
      effective_minutes:     effectiveMinutes,
      delta_minutes:         finalDeltaMinutes,
      updated_at:            sts
    });
    batch.update(sessRef, {
      has_approved_time_adjustment: true,
      effective_clock_in:           effectiveIn,
      effective_clock_out:          effectiveOut,
      effective_minutes:            effectiveMinutes,
      time_adjustment_request_id:   requestId,
      updated_at:                   sts
    });
    await batch.commit();

    logger.info("time adjustment approved", {
      request_id: requestId, session_id: r.service_session_id,
      employee_uid: r.employee_uid, reviewer_uid: staff.uid,
      effective_minutes: effectiveMinutes, final_delta_minutes: finalDeltaMinutes
    });
    res.status(200).json({ ok: true, request_id: requestId, effective_minutes: effectiveMinutes });
  } catch (err) {
    logger.error("approveTimeAdjustmentRequestV1 failed", {
      error: err && err.message, stack: err && err.stack, request_id: requestId
    });
    res.status(500).json({ ok: false, error: (err && err.message) || "Approve failed" });
  }
});

/* --------------- denyTimeAdjustmentRequestV1 --------------- */

exports.denyTimeAdjustmentRequestV1 = onRequest({
  cors:           false,
  timeoutSeconds: 30
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  const requestId    = String(body.request_id    || "").trim();
  const denialReason = String(body.denial_reason || "").trim();
  if (!requestId)    { res.status(400).json({ ok: false, error: "request_id is required." });    return; }
  if (!denialReason) { res.status(400).json({ ok: false, error: "denial_reason is required." }); return; }

  try {
    const reqRef  = db.collection("time_adjustment_requests").doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) {
      res.status(404).json({ ok: false, error: "Request not found." });
      return;
    }
    const r = reqSnap.data() || {};
    if (r.status !== "pending") {
      res.status(409).json({ ok: false, error: "Request is not pending (status: " + r.status + ")." });
      return;
    }

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const reviewerName = (staff.tech && staff.tech.display_name) || staff.email || "Admin";

    await reqRef.update({
      status:            "denied",
      denial_reason:     denialReason,
      reviewed_by_uid:   staff.uid,
      reviewed_by_name:  reviewerName,
      reviewed_at:       sts,
      updated_at:        sts
    });

    logger.info("time adjustment denied", {
      request_id: requestId, employee_uid: r.employee_uid,
      reviewer_uid: staff.uid, denial_reason: denialReason
    });
    res.status(200).json({ ok: true, request_id: requestId });
  } catch (err) {
    logger.error("denyTimeAdjustmentRequestV1 failed", {
      error: err && err.message, stack: err && err.stack, request_id: requestId
    });
    res.status(500).json({ ok: false, error: (err && err.message) || "Deny failed" });
  }
});

exports.seedPilotCustomerAliasesV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("seedPilotCustomerAliasesV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  // Normalizer used to match seed entries to actual /customers docs
  // and to derive doc ids. Identical rules to the suggestion path
  // (lowercase, strip non-alphanumerics, no trailing-s strip).
  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  try {
    // Build a customer name index: normalized full name → slug + name.
    const customersSnap = await db.collection("customers").get();
    const byName = {};
    const customerList = [];
    customersSnap.docs.forEach(function (d) {
      const c = d.data() || {};
      if (c.active === false) return;
      const slug = c.customer_slug || d.id;
      const name = c.customer_name || c.name || "";
      const key  = norm(name);
      if (key) byName[key] = { slug: slug, name: name };
      customerList.push({ slug: slug, name: name, key: key });
    });

    function findCustomer(seedName) {
      const key = norm(seedName);
      if (byName[key]) return byName[key];
      // Loose fallback: seed key is a substring of a real customer key
      // OR vice versa. Helps when the customer doc says "Note & Kidd
      // PLLC" but the seed line says "Note and Kidd PLLC", etc.
      for (let i = 0; i < customerList.length; i++) {
        const cl = customerList[i];
        if (!cl.key) continue;
        if (cl.key.indexOf(key) !== -1 || key.indexOf(cl.key) !== -1) {
          return { slug: cl.slug, name: cl.name };
        }
      }
      return null;
    }

    // Pre-load existing aliases so we can report idempotent skips
    // without a per-doc round trip.
    const existingSnap = await db.collection("customer_aliases").get();
    const existingIds = new Set(existingSnap.docs.map(function (d) { return d.id; }));

    const seeded = [];
    const skipped = [];
    const missingCustomers = [];

    for (const entry of PILOT_ALIAS_SEED) {
      const customer = findCustomer(entry.customer_name);
      if (!customer) {
        missingCustomers.push({
          seed_name: entry.customer_name,
          hint: "Create a /customers doc with customer_name matching this, then re-run seed."
        });
        continue;
      }
      const variants = [entry.code].concat(Array.isArray(entry.extras) ? entry.extras : []);
      for (const variant of variants) {
        const aliasText = String(variant || "").trim();
        if (!aliasText) continue;
        const docId = norm(aliasText);
        if (!docId) continue;
        if (existingIds.has(docId)) {
          skipped.push({ alias: aliasText, reason: "already exists" });
          continue;
        }
        existingIds.add(docId);   // dedupe within this run
        try {
          await db.collection("customer_aliases").doc(docId).set({
            alias:                  aliasText,
            normalized_alias:       docId,
            customer_slug:          customer.slug,
            customer_name:          customer.name,
            active:                 true,
            source:                 "manual_seed",
            confidence:             "high",
            // Future-ready audit hooks for a "learn from DCR" pipeline
            // that hasn't shipped yet. Stamped at seed time so later
            // code can read/increment without first having to migrate.
            learned_from_dcr:       false,
            learned_from_dcr_count: 0,
            last_learned_at:        null,
            created_at:             admin.firestore.FieldValue.serverTimestamp(),
            updated_at:             admin.firestore.FieldValue.serverTimestamp(),
            created_by:             staff.email
          }, { merge: false });
          seeded.push({ alias: aliasText, customer: customer.name });
        } catch (err) {
          logger.warn("seedPilotCustomerAliasesV1 write failed", {
            alias: aliasText, error: err && err.message
          });
          skipped.push({ alias: aliasText, reason: "write error: " + (err && err.message) });
        }
      }
    }

    logger.info("seedPilotCustomerAliasesV1 done", {
      caller:            staff.email,
      seeded_count:      seeded.length,
      skipped_count:     skipped.length,
      missing_customers: missingCustomers.length
    });
    res.json({
      ok:                true,
      seeded_count:      seeded.length,
      skipped_count:     skipped.length,
      missing_customers: missingCustomers,
      seeded:            seeded,
      skipped:           skipped
    });
  } catch (err) {
    logger.error("seedPilotCustomerAliasesV1 failed", {
      error: err && err.message, caller: staff.email
    });
    res.status(500).json({ ok: false, error: err && err.message });
  }
});

/* ====================================================================
 * deputyApiDiagnosticV1 — read-only admin probe of Deputy's API.
 *
 * Purpose: confirm what entities Deputy actually exposes and what
 * fields each carries. We need this to decide whether to build a
 * proper Locations sync (deputy_location_id → Pioneer customer mapping)
 * or stay on the alias path.
 *
 * Supported resources (POST body `resource` field):
 *   • "Company"          → /api/v1/resource/Company/QUERY (Deputy "Locations" in the UI)
 *   • "OperationalUnit"  → /api/v1/resource/OperationalUnit/QUERY (with Company joined)
 *   • "Roster"           → /api/v1/resource/Roster/QUERY (sample shifts today,
 *                           with EmployeeObject + OperationalUnitObject joined)
 *
 * Response: { ok, resource, endpoint_called, count, summary, raw }
 *   • summary: a sanitized list of the most-useful identifying fields
 *     (for "is this a usable customer signal?" eyeballing).
 *   • raw: the full JSON Deputy returned (capped at first 50 entries).
 *
 * Auth: staff:admin only.
 * ================================================================== */
exports.deputyApiDiagnosticV1 = onRequest({
  cors:           false,
  timeoutSeconds: 60,
  secrets:        [DEPUTY_CLIENT_ID, DEPUTY_CLIENT_SECRET, DEPUTY_INSTALL_URL, DEPUTY_ACCESS_TOKEN]
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("deputyApiDiagnosticV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  const body = req.body || {};
  // Default to OperationalUnit when omitted — that's the most
  // structurally-interesting resource for the customer-mapping
  // question (it carries both the team-level grouping AND the
  // joined Company, so a single probe shows the whole hierarchy).
  const resourceRaw = String(body.resource || "OperationalUnit").trim();
  if (["Company", "OperationalUnit", "Roster"].indexOf(resourceRaw) === -1) {
    res.status(400).json({
      ok: false,
      error: "resource must be 'Company', 'OperationalUnit', or 'Roster' (got '" + resourceRaw + "')."
    });
    return;
  }
  const resource = resourceRaw;

  // Normalizer used for the diagnostic candidate panel. Same shape as
  // the suggestion-side normalizer so admin can see exactly what the
  // resolver would produce for each candidate field.
  function diagNorm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  // Generic-label heuristic for the diagnostic only. If a candidate
  // normalizes to one of these, it's almost certainly NOT a customer
  // name. Mirrors the suggestion deny-list.
  const DIAG_GENERIC = new Set([
    "pioneer", "pioneercommercialcleaning", "commercialcleaning",
    "cleaningtech", "cleaningtechs", "technician", "admin", "office", "route",
    "shift", "coverage", "floater", "training", "default", "main"
  ]);

  let tokenInfo;
  try {
    tokenInfo = await getValidDeputyAccessToken();
  } catch (err) {
    logger.error("deputyApiDiagnosticV1: token fetch failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Deputy token error: " + err.message });
    return;
  }
  const endpoint = String(tokenInfo.endpoint || "").replace(/\/+$/, "");
  const accessToken = tokenInfo.accessToken;

  // Build the right request body per resource.
  let path = "";
  let payload = {};
  if (resource === "Company") {
    path = "/api/v1/resource/Company/QUERY";
    payload = { search: {}, max: 200 };
  } else if (resource === "OperationalUnit") {
    path = "/api/v1/resource/OperationalUnit/QUERY";
    payload = { search: {}, join: ["Company"], max: 200 };
  } else if (resource === "Roster") {
    path = "/api/v1/resource/Roster/QUERY";
    // Today's roster in Pacific time — the same window the sync uses.
    const today = deputyTodayLocalDate();
    payload = {
      search: {
        date_from: { field: "Date", type: "ge", data: today },
        date_to:   { field: "Date", type: "le", data: today }
      },
      join: ["EmployeeObject", "OperationalUnitObject"],
      max:  10
    };
  }

  const url = endpoint + path;
  let httpStatus = 0;
  let parsed = null;
  let rawText = "";
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(payload)
    });
    httpStatus = r.status;
    rawText = await r.text();
    try { parsed = JSON.parse(rawText); } catch (_e) { parsed = null; }
  } catch (err) {
    logger.error("deputyApiDiagnosticV1: HTTP fetch failed", { url: url, error: err.message });
    res.status(500).json({ ok: false, error: "Deputy fetch failed: " + err.message });
    return;
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    res.status(httpStatus).json({
      ok: false,
      resource: resource,
      endpoint_called: url,
      error: "Deputy returned HTTP " + httpStatus,
      raw_text_snippet: rawText.slice(0, 1000)
    });
    return;
  }

  const rows = Array.isArray(parsed) ? parsed : [];
  // Cap at first 50 for the response payload so we don't blow up
  // the browser. The full count is still reported.
  const capped = rows.slice(0, 50);

  // Helper — build the normalized_candidates list for one row.
  // Each entry: { field, value, normalized, looks_generic }
  // The admin can scan this column to see "which field would the
  // suggestion resolver match against, and does it normalize to
  // something that looks like a customer name or a generic label?"
  function candidates(pairs) {
    const out = [];
    pairs.forEach(function (p) {
      const value = String(p.value == null ? "" : p.value).trim();
      if (!value) return;
      const norm = diagNorm(value);
      out.push({
        field:         p.field,
        value:         value,
        normalized:    norm,
        looks_generic: norm.length < 5 || DIAG_GENERIC.has(norm)
      });
    });
    return out;
  }

  // Aggregate the union of object keys across rows — saves admin from
  // hand-tabulating which fields are present across the whole result.
  function unionKeys(rowsArr, deref) {
    const set = new Set();
    rowsArr.forEach(function (r) {
      const target = deref ? deref(r) : r;
      if (target && typeof target === "object") {
        Object.keys(target).forEach(function (k) { set.add(k); });
      }
    });
    return Array.from(set).sort();
  }

  // Build the summary list AND the observable analysis block.
  let summary = [];
  let keysObserved = { row: [] };
  let analysis = {};

  if (resource === "Company") {
    summary = capped.map(function (c) {
      const name = c.CompanyName || c.Name || "";
      return {
        Id:          c.Id,
        CompanyName: name,
        Address:     c.Address || "",
        Active:      c.Active,
        Code:        c.Code || c.CompanyCode || "",
        ParentId:    c.ParentCompany || c.ParentCompanyId || null,
        normalized_candidates: candidates([
          { field: "CompanyName", value: name },
          { field: "Code",        value: c.Code || c.CompanyCode || "" },
          { field: "Address",     value: c.Address || "" }
        ])
      };
    });
    keysObserved = { row: unionKeys(capped) };
    // Observable stats — do NOT speculate; just report what the data says.
    const names = capped.map(function (c) { return c.CompanyName || c.Name || ""; }).filter(Boolean);
    const distinctNames = new Set(names);
    const nonGenericNames = names.filter(function (n) {
      const k = diagNorm(n);
      return k.length >= 5 && !DIAG_GENERIC.has(k);
    });
    analysis = {
      row_count:              rows.length,
      rows_with_company_name: names.length,
      distinct_company_names: distinctNames.size,
      non_generic_names:      nonGenericNames.length,
      // If this number is roughly equal to row_count, Company-level
      // names look customer-distinct in this Deputy account.
      // If it's ~1, Company is org-level (e.g. only "Pioneer Commercial Cleaning").
      example_names:          Array.from(distinctNames).slice(0, 10)
    };
  } else if (resource === "OperationalUnit") {
    summary = capped.map(function (u) {
      const co = u.Company || u.CompanyObject || {};
      const ouName  = u.OperationalUnitName || u.Name || "";
      const ouCode  = u.Code || u.OperationalUnitCode || "";
      const ouMemo  = u.Memo || u.OperationalUnitMemo || "";
      const coName  = co.CompanyName || co.Name || "";
      return {
        Id:                  u.Id,
        OperationalUnitName: ouName,
        Code:                ouCode,
        Memo:                ouMemo,
        Address:             u.Address || "",
        CompanyId:           u.Company || (typeof co.Id === "number" ? co.Id : null),
        CompanyName:         coName,
        Active:              u.Active,
        // Candidates are what the suggestion resolver scans today.
        normalized_candidates: candidates([
          { field: "OperationalUnitName", value: ouName },
          { field: "Code",                value: ouCode },
          { field: "Memo",                value: ouMemo },
          { field: "CompanyName",         value: coName }
        ])
      };
    });
    keysObserved = {
      operational_unit: unionKeys(capped),
      company:          unionKeys(capped, function (u) { return u.Company || u.CompanyObject || {}; })
    };
    const ouNames        = capped.map(function (u) { return u.OperationalUnitName || u.Name || ""; }).filter(Boolean);
    const distinctOuNames = new Set(ouNames);
    const distinctCompanies = new Set();
    capped.forEach(function (u) {
      const co = u.Company || u.CompanyObject || {};
      const id = u.Company || (typeof co.Id === "number" ? co.Id : null);
      if (id != null) distinctCompanies.add(String(id));
    });
    const nonGenericOuNames = ouNames.filter(function (n) {
      const k = diagNorm(n);
      return k.length >= 5 && !DIAG_GENERIC.has(k);
    });
    analysis = {
      row_count:                  rows.length,
      rows_with_ou_name:          ouNames.length,
      distinct_ou_names:          distinctOuNames.size,
      non_generic_ou_names:       nonGenericOuNames.length,
      distinct_company_ids:       distinctCompanies.size,
      // Two signals to look for:
      //   • If distinct_ou_names ≈ row_count and non_generic_ou_names is high,
      //     OperationalUnit IS the customer-level entity.
      //   • If distinct_company_ids > 1, the Company side is also meaningful
      //     (i.e. each OU lives under its own Company).
      example_ou_names:           Array.from(distinctOuNames).slice(0, 10)
    };
  } else if (resource === "Roster") {
    summary = capped.map(function (r) {
      const emp     = r.EmployeeObject || {};
      const ou      = r.OperationalUnitObject || {};
      const co      = ou.Company || ou.CompanyObject || {};
      const ouName  = ou.OperationalUnitName || ou.Name || "";
      const ouCode  = ou.Code || "";
      const ouMemo  = ou.Memo || "";
      const coName  = co.CompanyName || co.Name || "";
      const comment = r.Comment || "";
      const memo    = r.Memo || (r._DPMetaData && r._DPMetaData.Memo) || "";
      return {
        Id:                       r.Id,
        Date:                     r.Date,
        StartTime:                r.StartTime,
        EndTime:                  r.EndTime,
        EmployeeId:               r.Employee,
        EmployeeDisplayName:      emp.DisplayName || emp.Name || "",
        OperationalUnitId:        r.OperationalUnit,
        OperationalUnitName:      ouName,
        OperationalUnitCode:      ouCode,
        OperationalUnitMemo:      ouMemo,
        CompanyId:                ou.Company || (typeof co.Id === "number" ? co.Id : null),
        CompanyName:              coName,
        Comment:                  comment,
        Memo:                     memo,
        // Field-by-field: what could a resolver match against on this shift?
        normalized_candidates: candidates([
          { field: "OperationalUnitName", value: ouName },
          { field: "OperationalUnitCode", value: ouCode },
          { field: "OperationalUnitMemo", value: ouMemo },
          { field: "CompanyName",         value: coName },
          { field: "Comment",             value: comment },
          { field: "Memo",                value: memo }
        ])
      };
    });
    keysObserved = {
      roster:           unionKeys(capped),
      operational_unit: unionKeys(capped, function (r) { return r.OperationalUnitObject || {}; }),
      company:          unionKeys(capped, function (r) {
                          const ou = r.OperationalUnitObject || {};
                          return ou.Company || ou.CompanyObject || {};
                        }),
      employee:         unionKeys(capped, function (r) { return r.EmployeeObject || {}; })
    };
    // How many shifts carry a Company link? An OU link? An OU name? A company name?
    let withOuId = 0, withCompanyId = 0, withOuName = 0, withCompanyName = 0;
    const distinctOuIds = new Set();
    const distinctCompanyIds = new Set();
    capped.forEach(function (r) {
      const ou = r.OperationalUnitObject || {};
      const co = ou.Company || ou.CompanyObject || {};
      if (r.OperationalUnit != null) { withOuId += 1; distinctOuIds.add(String(r.OperationalUnit)); }
      const coId = ou.Company || (typeof co.Id === "number" ? co.Id : null);
      if (coId != null) { withCompanyId += 1; distinctCompanyIds.add(String(coId)); }
      if (ou.OperationalUnitName || ou.Name) withOuName      += 1;
      if (co.CompanyName || co.Name)         withCompanyName += 1;
    });
    analysis = {
      row_count:                rows.length,
      shifts_with_ou_id:        withOuId,
      shifts_with_company_id:   withCompanyId,
      shifts_with_ou_name:      withOuName,
      shifts_with_company_name: withCompanyName,
      distinct_ou_ids_seen:     distinctOuIds.size,
      distinct_company_ids_seen: distinctCompanyIds.size,
      // Relationship hint — every shift links to exactly one OU; OUs
      // link to at most one Company. If every shift carries a CompanyId,
      // the Company side is reliably reachable from shift data.
      relationship:             "Roster → OperationalUnit → Company"
    };
  }

  logger.info("deputyApiDiagnosticV1 ok", {
    caller:           staff.email,
    resource:         resource,
    endpoint_called:  url,
    count:            rows.length,
    capped_to:        capped.length
  });
  res.json({
    ok:              true,
    resource:        resource,
    endpoint_called: url,
    token_source:    tokenInfo.source,
    count:           rows.length,
    capped_to:       capped.length,
    analysis:        analysis,
    keys_observed:   keysObserved,
    summary:         summary,
    raw:             capped
  });
});

/* ===========================================================================
   generateAndSendDcrEmailV1 — PioneerOps native DCR customer email
   ===========================================================================
   First-goal scope: one working DCR email for one test DCR. Replaces the
   Zapier path for the customer-facing report; Zapier is NOT touched here.

   Endpoint:
     POST https://us-central1-pioneer-dcr-hub.cloudfunctions.net/generateAndSendDcrEmailV1
     Body: { "dcrId": "<dcr_submissions doc id>",
             "customerId": "<customers doc id, usually the slug>" }
     Header: Authorization: Bearer <signed-in admin user's ID token>

   Auth:
     Admin only. Reuses verifyStaffOrReject() + staff.isAdmin.

   Required secrets (set BEFORE deploy):
     OPENAI_API_KEY             — OpenAI API key (gpt-4o-mini)
     GMAIL_SENDER_EMAIL         — Pioneer Workspace sender, e.g.
                                   info@pioneercomclean.com
     GMAIL_SERVICE_ACCOUNT_KEY  — JSON-encoded service-account key WITH
                                   domain-wide delegation configured for
                                   scope https://www.googleapis.com/auth/gmail.send
                                   in Workspace Admin → Security → API Controls.

   All business logic lives in functions/dcrEmail.js. This block just
   binds the (already-declared above) secrets to the onRequest endpoint.

   Phase 32 moved these defineSecret calls above submitDcrV1 so the
   auto-send hook can also bind them. The const names below are still in
   scope here. =================================================== */

exports.generateAndSendDcrEmailV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 60,
    secrets: [OPENAI_API_KEY, GMAIL_SENDER_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY, KIRBY_ALERT_EMAIL, APRIL_ALERT_EMAIL]
  },
  dcrEmail.buildHttpHandler({
    admin:                     admin,
    db:                        db,
    logger:                    logger,
    OPENAI_API_KEY:            OPENAI_API_KEY,
    GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
    GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
    KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
    APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL,
    verifyStaffOrReject:       verifyStaffOrReject
  })
);

/* =================================================================
   getDcrEmailReadinessV1 — admin pre-send readiness check.

   POST https://us-central1-pioneer-dcr-hub.cloudfunctions.net/getDcrEmailReadinessV1
     Header: Authorization: Bearer <admin Firebase ID token>
     Body:   { dcrId, mode?: "send" | "resend" }

   Returns the same structured shape as dcrEmail.getDcrEmailReadiness:
     { ready, blockers, warnings, resolved }

   The admin UI calls this BEFORE rendering the Send button. The
   send endpoint itself re-runs the same check (defense in depth) so
   even an admin can't bypass it from a hand-crafted curl.
   ================================================================= */
exports.getDcrEmailReadinessV1 = onRequest(
  { cors: false, timeoutSeconds: 30 },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin",  "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age",       "3600");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST only" }); return;
    }
    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (!staff.isAdmin) {
      res.status(403).json({ ok: false, error: "Admin only" }); return;
    }
    const dcrId = String((req.body && req.body.dcrId) || "").trim();
    const mode  = String((req.body && req.body.mode)  || "send").trim();
    if (!dcrId) {
      res.status(400).json({ ok: false, error: "dcrId is required" }); return;
    }
    try {
      const readiness = await dcrEmail.getDcrEmailReadiness({
        db: db, logger: logger, dcrId: dcrId, mode: mode
      });
      res.json(Object.assign({ ok: true }, readiness));
    } catch (err) {
      const msg = String(err && err.message || err);
      logger.error("[dcr-email-readiness] handler error", { dcrId, error: msg });
      res.status(500).json({ ok: false, error: msg });
    }
  }
);

/* =================================================================
   submitFeedbackV1 — PUBLIC customer feedback intake

   POST https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitFeedbackV1
     Body (compliment): {
       type: "compliment",
       dcrId, customerId, techId,
       rating, complimentText, customerName, shareConsent
     }
     Body (complaint): {
       type: "complaint",
       dcrId, customerId, techId,
       category, details, urgency,
       contactName, contactEmail, contactPhone,
       photos: [{ name, contentType, base64 }]    // optional, max 3
     }
     No Authorization header — public endpoint linked from customer emails.

   Auth model:
     PUBLIC. Customers click links from the DCR email and submit
     anonymously. Defenses: strict body validation, length caps,
     enum whitelists, honeypot field. Rate-limiting is a TODO once
     real traffic shows up — the abuse surface today is tiny.

   Required secrets (set BEFORE deploy):
     GMAIL_SENDER_EMAIL         — reused from generateAndSendDcrEmailV1.
     GMAIL_SERVICE_ACCOUNT_KEY  — reused (Workspace domain-wide delegation).
     KIRBY_ALERT_EMAIL          — office manager destination address.
     APRIL_ALERT_EMAIL          — manager destination address.
   ================================================================= */
const feedback = require("./feedback");
// KIRBY_ALERT_EMAIL + APRIL_ALERT_EMAIL are declared at the top of the
// DCR-email block (see ~line 5012) so generateAndSendDcrEmailV1 can
// reach them. defineSecret() can only be called once per name — the
// shared bindings flow into both endpoints from there.

exports.submitFeedbackV1 = onRequest(
  {
    cors: true,
    timeoutSeconds: 60,
    // Bumped to accommodate up to 3 × ~2MB base64-encoded photos.
    memory: "512MiB",
    secrets: [
      GMAIL_SENDER_EMAIL,
      GMAIL_SERVICE_ACCOUNT_KEY,
      KIRBY_ALERT_EMAIL,
      APRIL_ALERT_EMAIL
    ]
  },
  feedback.buildHttpHandler({
    admin:                     admin,
    db:                        db,
    logger:                    logger,
    GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
    GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
    KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
    APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
  })
);

/* =================================================================
   uploadTechMediaV1 — admin photo / signature manager

   POST .../uploadTechMediaV1
     Header: Authorization: Bearer <admin Firebase ID token>
     Body (upload):   { techId, kind: "photo"|"signature",
                        filename, contentType, base64 }
     Body (clear):    { techId, kind: "photo"|"signature", clear: true }
     Body (active):   { techId, action: "setActive", active: <bool> }

   Auth:
     Admin only (verifyStaffOrReject + staff.isAdmin).

   Storage paths:
     tech-photos/{techId}/{timestamp}-{filename}
     tech-signatures/{techId}/{timestamp}-{filename}

   No new secrets.
   ================================================================= */
const techMediaUpload = require("./techMediaUpload");

exports.uploadTechMediaV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 60,
    // 256MiB is fine for a 5MB photo round-trip; bumped over the
    // default 256 default because base64-decoding stays in memory.
    memory: "512MiB"
  },
  techMediaUpload.buildHttpHandler({
    admin:                admin,
    db:                   db,
    logger:               logger,
    verifyStaffOrReject:  verifyStaffOrReject
  })
);

/* ============================================================================
   Attendance email triggers
   ============================================================================
   Two trigger pairs:
     • onCallOutCreated         → email Kirby + April (urgent)
     • onTimeOffRequestCreated  → email Kirby + April (informational)
     • onCallOutUpdated         → email tech on acknowledged / resolved
     • onTimeOffRequestUpdated  → email tech on approved / denied
   Update triggers ignore everything except `status` transitions to avoid
   noisy resends when an admin adds a coverage note without flipping
   state. Body of the email is built in functions/attendanceEmails.js.

   Secrets reused (already declared above for DCR email + feedback):
     GMAIL_SENDER_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY,
     KIRBY_ALERT_EMAIL, APRIL_ALERT_EMAIL
   ========================================================================= */
const attendanceEmails = require("./attendanceEmails");

const ATTENDANCE_EMAIL_SECRETS = [
  GMAIL_SENDER_EMAIL,
  GMAIL_SERVICE_ACCOUNT_KEY,
  KIRBY_ALERT_EMAIL,
  APRIL_ALERT_EMAIL
];

exports.onCallOutCreatedV1 = onDocumentCreated(
  { document: "call_outs/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleCallOutCreated({
        snapshot: event.data,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onCallOutCreatedV1 failed", { error: err && err.message });
    }
  }
);

exports.onTimeOffRequestCreatedV1 = onDocumentCreated(
  { document: "time_off_requests/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleTimeOffRequestCreated({
        snapshot: event.data,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onTimeOffRequestCreatedV1 failed", { error: err && err.message });
    }
  }
);

exports.onCallOutUpdatedV1 = onDocumentUpdated(
  { document: "call_outs/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleCallOutUpdated({
        before: event.data && event.data.before,
        after:  event.data && event.data.after,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onCallOutUpdatedV1 failed", { error: err && err.message });
    }
  }
);

exports.onTimeOffRequestUpdatedV1 = onDocumentUpdated(
  { document: "time_off_requests/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleTimeOffRequestUpdated({
        before: event.data && event.data.before,
        after:  event.data && event.data.after,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onTimeOffRequestUpdatedV1 failed", { error: err && err.message });
    }
  }
);

exports.onOpenShiftCreatedV1 = onDocumentCreated(
  { document: "open_shift_requests/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleOpenShiftCreated({
        snapshot: event.data,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onOpenShiftCreatedV1 failed", { error: err && err.message });
    }
  }
);

exports.onOpenShiftUpdatedV1 = onDocumentUpdated(
  { document: "open_shift_requests/{id}", secrets: ATTENDANCE_EMAIL_SECRETS, timeoutSeconds: 60 },
  async (event) => {
    try {
      await attendanceEmails.handleOpenShiftUpdated({
        before: event.data && event.data.before,
        after:  event.data && event.data.after,
        secrets: {
          GMAIL_SENDER_EMAIL:        GMAIL_SENDER_EMAIL,
          GMAIL_SERVICE_ACCOUNT_KEY: GMAIL_SERVICE_ACCOUNT_KEY,
          KIRBY_ALERT_EMAIL:         KIRBY_ALERT_EMAIL,
          APRIL_ALERT_EMAIL:         APRIL_ALERT_EMAIL
        },
        logger: logger
      });
    } catch (err) {
      logger.error("onOpenShiftUpdatedV1 failed", { error: err && err.message });
    }
  }
);

/* ----------------------------- pilotReadinessCheckV1 ----------------------------- */

// Admin-only readiness audit. Walks every active cleaning_tech and runs
// structural checks (auth user · cleaning_techs record · Deputy mapping ·
// permission preconditions · customer mapping · pending announcements).
// No writes, no test docs — pure read pipeline. Returns the engine's
// JSON envelope { generated_at, summary, techs }.
//
// Same engine powers `node scripts/pilot-readiness-check.js`, so the
// admin panel and the terminal report stay in sync by construction.
const pilotReadinessEngine = require("./pilotReadinessEngine");
const dcrReportModule      = require("./dcrReport");

exports.pilotReadinessCheckV1 = onRequest({ cors: false, timeoutSeconds: 60 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (!staff.isAdmin) {
    res.status(403).json({ ok: false, error: "Admin-only endpoint." });
    return;
  }

  // Optional query params (debug): ?tech_slug=foo or ?limit=N.
  const techSlug = (req.query && req.query.tech_slug) ? String(req.query.tech_slug) : null;
  const limitRaw = (req.query && req.query.limit) ? Number(req.query.limit) : 0;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;

  try {
    const report = await pilotReadinessEngine.runReadinessForTechs(admin, {
      techSlug: techSlug,
      limit:    limit
    });
    res.status(200).json({ ok: true, report: report });
  } catch (err) {
    logger.error("pilotReadinessCheckV1 failed", {
      caller: staff.email, code: err && err.code, message: err && err.message
    });
    res.status(500).json({
      ok:    false,
      error: "Readiness check failed. " + ((err && err.message) || "unknown"),
      code:  (err && err.code) || null
    });
  }
});

/* ----------------------------- getDcrReportByTokenV1 ----------------------------- */

// PUBLIC endpoint — the customer-facing DCR report page calls this with
// `?t=<rawToken>`. Token is hashed server-side and looked up in
// dcr_report_tokens; no Firebase Auth required (the token IS the auth).
//
// Returns a customer-safe payload (no internal notes, no admin fields).
// Bumps view counters on both the token doc and the source DCR.
exports.getDcrReportByTokenV1 = onRequest({ cors: false, timeoutSeconds: 20 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Cache-Control",                 "no-store");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const rawToken = String((req.query && req.query.t) || "").trim();
  if (!rawToken) {
    res.status(400).json({ ok: false, code: "missing_token", error: "Token required." });
    return;
  }

  try {
    const out = await dcrReportModule.getDcrReportByToken({
      admin: admin, db: db, rawToken: rawToken
    });
    if (!out.ok) {
      // 404 for missing/invalid token; 500 for unexpected internal failure.
      const status = (out.code === "token_not_found" || out.code === "dcr_not_found" || out.code === "token_orphan" || out.code === "bad_token") ? 404 : 500;
      res.status(status).json(out);
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    logger.error("getDcrReportByTokenV1 failed", {
      code: err && err.code, message: err && err.message
    });
    res.status(500).json({
      ok: false,
      error: "Report lookup failed. " + ((err && err.message) || "unknown"),
      code:  (err && err.code) || null
    });
  }
});

/* ----------------------------- Pioneer SOS dispatch -----------------------------

  When the client writes a new emergency_events/{id} doc, this trigger
  fans out SMS notifications to April, Kirby, and (optionally) Nick via
  Twilio, then stamps `notified` + `notificationStatus` back onto the doc.

  Honors the spec: "Do not fake SMS success." When TWILIO_* secrets are
  missing, we write notificationStatus = "sms_provider_missing" and
  leave each recipient as false so the UI surfaces the manual-call
  fallback.

  Phone numbers come from `pioneer_config/emergency_contacts`:
    { april: "+1...", kirby: "+1...", nick: "+1..." }
  The April number falls back to the spec default (+15098283335) when
  the config doc is missing.

  Severity-specific copy:
    help_needed → "PIONEER HELP NEEDED"
    critical    → "🚨 PIONEER SOS EMERGENCY"
*/

const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN  = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = defineSecret("TWILIO_FROM_NUMBER");

const APRIL_DEFAULT_PHONE = "+15098283335";

function safeReadSecret(s) {
  try { return s && s.value ? s.value() : ""; }
  catch (_e) { return ""; }
}

function formatSosBody(severity, data) {
  const techName  = data.techName || data.createdByEmail || "(unknown tech)";
  const customer  = data.customerName || data.locationName || "(no shift in progress)";
  const address   = data.address || "";
  const details   = (data.details || "").trim();
  const ts        = data.createdAt && data.createdAt.toDate
                      ? data.createdAt.toDate().toISOString()
                      : new Date().toISOString();
  const geo       = data.geolocation;
  const geoLine   = (geo && geo.lat != null && geo.lng != null)
                      ? ("\nLoc: https://maps.google.com/?q=" + geo.lat + "," + geo.lng)
                      : "";

  if (severity === "critical") {
    return [
      "🚨 PIONEER SOS EMERGENCY",
      techName,
      customer,
      address ? ("Address: " + address) : "",
      "Triggered emergency alert.",
      details ? ("Note: " + details) : "",
      "Time: " + ts,
      "Call/check immediately." + geoLine
    ].filter(Boolean).join("\n");
  }
  // help_needed
  return [
    "PIONEER HELP NEEDED",
    techName,
    customer,
    address ? ("Address: " + address) : "",
    "Issue: " + (details || "(no details)"),
    "Time: " + ts + geoLine
  ].filter(Boolean).join("\n");
}

async function sendTwilioSms({ accountSid, authToken, fromNumber, toNumber, body, logger }) {
  const url = "https://api.twilio.com/2010-04-01/Accounts/" + accountSid + "/Messages.json";
  const credentials = Buffer.from(accountSid + ":" + authToken).toString("base64");
  const params = new URLSearchParams();
  params.set("From", fromNumber);
  params.set("To",   toNumber);
  params.set("Body", body);
  let res, txt;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Basic " + credentials,
        "Content-Type":  "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    txt = await res.text();
  } catch (e) {
    logger.warn("[sos] twilio fetch threw", { error: e && e.message });
    return { ok: false, error: e && e.message };
  }
  if (!res.ok) {
    logger.warn("[sos] twilio rejected", { status: res.status, body: txt.slice(0, 400) });
    return { ok: false, error: "HTTP " + res.status, body: txt.slice(0, 400) };
  }
  return { ok: true };
}

exports.onEmergencyCreatedV1 = onDocumentCreated(
  {
    document:       "emergency_events/{id}",
    timeoutSeconds: 60,
    secrets:        [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER]
  },
  async (event) => {
    const snap = event && event.data;
    if (!snap || !snap.exists) return;
    const data = snap.data() || {};
    const docRef = snap.ref;

    // ---- 1. Resolve recipient phone numbers ----
    let contacts = {};
    try {
      const cfg = await db.collection("pioneer_config").doc("emergency_contacts").get();
      if (cfg.exists) contacts = cfg.data() || {};
    } catch (e) {
      logger.warn("[sos] failed to read pioneer_config/emergency_contacts", { error: e && e.message });
    }
    const aprilPhone = String(contacts.april || APRIL_DEFAULT_PHONE).trim();
    const kirbyPhone = String(contacts.kirby || "").trim();
    const nickPhone  = String(contacts.nick  || "").trim();

    // ---- 2. Check SMS provider readiness ----
    const sid   = safeReadSecret(TWILIO_ACCOUNT_SID);
    const tok   = safeReadSecret(TWILIO_AUTH_TOKEN);
    const from  = safeReadSecret(TWILIO_FROM_NUMBER);
    const providerReady = !!(sid && tok && from);

    const notified = { april: false, kirby: false, nick: false };
    let   anyFailure = false;
    let   anySuccess = false;
    const errors    = [];

    if (!providerReady) {
      logger.warn("[sos] TWILIO_* secrets not all set — leaving notificationStatus=sms_provider_missing", {
        eventId:    snap.id,
        severity:   data.severity,
        techEmail:  data.createdByEmail,
        hasSid:     !!sid,
        hasToken:   !!tok,
        hasFrom:    !!from
      });
      await docRef.set({
        notified:           notified,
        notificationStatus: "sms_provider_missing",
        notificationError:  "TWILIO_* secrets not configured. Set via `firebase functions:secrets:set` to enable SMS dispatch.",
        notificationAt:     admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    // ---- 3. Build the SMS body + dispatch ----
    const body = formatSosBody(data.severity, data);
    logger.info("[sos] dispatching", {
      eventId: snap.id, severity: data.severity, techEmail: data.createdByEmail,
      recipients: [
        aprilPhone ? "april" : null,
        kirbyPhone ? "kirby" : null,
        nickPhone  ? "nick"  : null
      ].filter(Boolean)
    });

    const targets = [
      { key: "april", to: aprilPhone },
      { key: "kirby", to: kirbyPhone },
      { key: "nick",  to: nickPhone  }
    ];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.to) {
        // No number configured for this recipient — neither success nor
        // failure. Just leave notified[key] = false. The admin UI can
        // surface "(no number configured)" if useful.
        continue;
      }
      const result = await sendTwilioSms({
        accountSid: sid,
        authToken:  tok,
        fromNumber: from,
        toNumber:   t.to,
        body:       body,
        logger:     logger
      });
      if (result.ok) {
        notified[t.key] = true;
        anySuccess = true;
      } else {
        anyFailure = true;
        errors.push(t.key + ": " + (result.error || "unknown"));
      }
    }

    let status;
    if (anySuccess && !anyFailure) status = "sent";
    else if (anySuccess && anyFailure) status = "partial";
    else status = "failed";

    await docRef.set({
      notified:           notified,
      notificationStatus: status,
      notificationError:  errors.length ? errors.join(" | ") : null,
      notificationAt:     admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    logger.info("[sos] dispatch result", { eventId: snap.id, status: status, notified: notified });
  }
);

/* ----------------------------- setTechAuthDisabledV1 -----------------------------
   Admin-only. Disable / re-enable a tech's Firebase Auth user AND
   revoke their refresh tokens so any active PWA / browser session is
   forced to re-authenticate (and immediately fail) on next token
   refresh. Used by the cleaning-tech archive flow.

   Body: { email: string, disabled: boolean }
   Auth: admin Bearer token.
   Effects:
     • admin.auth().updateUser(uid, { disabled })
     • disabled === true → admin.auth().revokeRefreshTokens(uid)
     • idempotent — already-disabled user updates harmlessly
*/
exports.setTechAuthDisabledV1 = onRequest({ cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (!staff.isAdmin) {
    res.status(403).json({ ok: false, error: "Admin-only endpoint." });
    return;
  }
  const body  = req.body || {};
  const email = String(body.email || "").toLowerCase().trim();
  const disabled = !!body.disabled;
  if (!email) {
    res.status(400).json({ ok: false, error: "email required" });
    return;
  }
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { disabled: disabled });
    if (disabled) {
      // Force-invalidate any active session. The client's next ID-token
      // refresh (within ~1h) will fail; STAFF_AUTH then routes to denied.
      await admin.auth().revokeRefreshTokens(user.uid);
    }
    logger.info("[archive] setTechAuthDisabled", {
      caller: staff.email, target: email, uid: user.uid, disabled: disabled
    });
    res.status(200).json({ ok: true, uid: user.uid, disabled: disabled });
  } catch (err) {
    const notFound = err && err.code === "auth/user-not-found";
    logger.warn("[archive] setTechAuthDisabled failed", {
      caller: staff.email, target: email, code: err && err.code, error: err && err.message
    });
    if (notFound) {
      // The tech has no auth user. Not a bug — treat as success because
      // there's nothing to disable.
      res.status(200).json({ ok: true, code: "user_not_found", note: "no auth user existed for this email" });
      return;
    }
    res.status(500).json({
      ok: false,
      error: "Couldn't update auth user. " + ((err && err.message) || "unknown"),
      code:  (err && err.code) || null
    });
  }
});

/* ============================================================================
 * Phase 2A.2 — GHL Hiring Sync (Applicant Tracking pipeline → Firestore)
 *
 * Two endpoints share a single core in ./ghlHiringSync:
 *   • syncGhlHiringV1     — scheduled, daily at 06:30 PT (post-overnight,
 *                           pre-business-hours so the /manager card opens
 *                           with fresh data).
 *   • refreshGhlHiringV1  — admin POST, runs the same sync on demand
 *                           (powers a future "Sync GHL Now" button + the
 *                           local test script).
 *
 * Token lives in the GHL_PRIVATE_INTEGRATION_TOKEN secret. Never returned
 * to the client; never logged. If the secret is unset both endpoints
 * short-circuit with skipped:true so the scheduler stays green during the
 * first deploy.
 *
 * Setup (one-time, Nick):
 *   firebase functions:secrets:set GHL_PRIVATE_INTEGRATION_TOKEN
 *   firebase deploy --only functions:syncGhlHiringV1,functions:refreshGhlHiringV1
 *
 * Manual local run (uses serviceAccountKey + env var):
 *   GHL_PRIVATE_INTEGRATION_TOKEN=... node scripts/run-ghl-hiring-sync.js
 * ========================================================================== */

const GHL_PRIVATE_INTEGRATION_TOKEN = defineSecret("GHL_PRIVATE_INTEGRATION_TOKEN");

exports.syncGhlHiringV1 = onSchedule({
  schedule:       "30 6 * * *",            // 06:30 daily
  timeZone:       "America/Los_Angeles",
  timeoutSeconds: 120,
  secrets:        [GHL_PRIVATE_INTEGRATION_TOKEN]
}, async (event) => {
  try {
    const token = GHL_PRIVATE_INTEGRATION_TOKEN.value();
    const result = await ghlHiringSync.runSync({
      token:     token,
      db:        db,
      invokedBy: "scheduled"
    });
    if (result.skipped) {
      logger.warn("[ghlSync] scheduled run skipped", { reason: result.reason });
    } else {
      logger.info("[ghlSync] scheduled run ok", result);
    }
  } catch (err) {
    logger.error("[ghlSync] scheduled run failed", { error: err && err.message });
  }
});

exports.refreshGhlHiringV1 = onRequest({
  cors:           false,
  timeoutSeconds: 120,
  secrets:        [GHL_PRIVATE_INTEGRATION_TOKEN]
}, async (req, res) => {
  res.set("Access-Control-Allow-Origin",  "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age",       "3600");
  res.set("Vary",                          "Origin");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;
  if (staff.role !== "admin") {
    logger.warn("refreshGhlHiringV1: non-admin attempt", {
      caller_email: staff.email, caller_role: staff.role
    });
    res.status(403).json({ ok: false, error: "Admin access required." });
    return;
  }

  try {
    const token = GHL_PRIVATE_INTEGRATION_TOKEN.value();
    const result = await ghlHiringSync.runSync({
      token:     token,
      db:        db,
      invokedBy: "manual:" + staff.email
    });
    if (result.skipped) {
      res.status(503).json({
        ok: false,
        error: "GHL token not configured. Set GHL_PRIVATE_INTEGRATION_TOKEN secret.",
        reason: result.reason
      });
      return;
    }
    res.json({ ok: true, result: result });
  } catch (err) {
    logger.error("[ghlSync] manual run failed", {
      caller: staff.email, error: err && err.message
    });
    res.status(500).json({ ok: false, error: (err && err.message) || "unknown" });
  }
});

/* ============================================================================
 * Phase Inspection 3 — onInspectionCreatedV1
 *
 * Fires when an admin submits a new inspection. Updates the matching
 * customer_inspection_state doc so the registry, /inspections Health
 * panel, and CEO rollup all see "completed" for this cycle without
 * waiting for a manual write.
 *
 *   - last_inspection_id / last_inspection_date / last_inspector_*
 *     captured from the inspection doc
 *   - due_date = inspection_date + inspection_cadence_days (default 60)
 *   - assignment fields cleared (the cycle is closed)
 *   - inspection_cadence_days preserved if already set on the state doc
 *     (some customers may have a faster cadence override later)
 *
 * Soft-fails on missing customer_slug or write errors; the inspection
 * doc itself is the source of truth and stays committed regardless.
 * ========================================================================== */

exports.onInspectionCreatedV1 = onDocumentCreated(
  { document: "inspections/{inspectionId}", timeoutSeconds: 30 },
  async (event) => {
    try {
      const snap = event.data;
      if (!snap) return;
      const data = snap.data() || {};
      const customerSlug = String(data.customer_slug || "").trim();
      if (!customerSlug) {
        logger.warn("[inspection-state] inspection without customer_slug — skipping", {
          inspection_id: event.params.inspectionId
        });
        return;
      }

      // Default cadence; per-customer override is preserved if the
      // state doc already has one (read-then-write to keep it idempotent
      // for future cadence customization).
      const stateRef = admin.firestore()
        .collection("customer_inspection_state")
        .doc(customerSlug);
      const existing = await stateRef.get();
      const cadence = (existing.exists && existing.data().inspection_cadence_days) || 60;

      const inspectionDate = String(data.inspection_date || "").trim()
        || new Date().toISOString().slice(0, 10);
      const dueDate = computeDueDateYMD(inspectionDate, cadence);

      const update = {
        customer_slug:        customerSlug,
        customer_name:        data.customer_name || (existing.exists ? existing.data().customer_name : "") || "",
        inspection_cadence_days: cadence,
        last_inspection_id:   event.params.inspectionId,
        last_inspection_date: inspectionDate,
        last_inspector_uid:   data.inspector_uid   || null,
        last_inspector_name:  data.inspector_name  || null,
        last_inspector_email: data.inspector_email || null,
        // Cycle closed — clear assignment fields. Next cycle starts
        // unassigned until an admin claims it.
        assigned_to_uid:      null,
        assigned_to_email:    null,
        assigned_to_name:     null,
        assigned_at:          null,
        assigned_by_email:    null,
        due_date:             dueDate,
        updated_at:           admin.firestore.FieldValue.serverTimestamp()
      };
      if (!existing.exists) {
        update.created_at = admin.firestore.FieldValue.serverTimestamp();
      }
      await stateRef.set(update, { merge: true });

      logger.info("[inspection-state] updated", {
        customer_slug: customerSlug,
        last_inspection_date: inspectionDate,
        due_date: dueDate
      });
    } catch (err) {
      logger.error("[inspection-state] update failed", {
        inspection_id: event.params && event.params.inspectionId,
        error: err && err.message
      });
    }
  }
);

// inspection_date + cadence days → YYYY-MM-DD (UTC math is fine for
// date-only arithmetic; we never need sub-day precision here).
function computeDueDateYMD(ymd, cadenceDays) {
  const ms = Date.parse(ymd + "T00:00:00Z");
  if (!Number.isFinite(ms)) return null;
  const due = new Date(ms + cadenceDays * 86400000);
  return due.toISOString().slice(0, 10);
}

/* ============================================================================
 * Phase 3C — Twilio Transport Foundation
 *
 * Three Cloud Functions form the manual SMS transport layer for the
 * Communication Threads system:
 *
 *   sendTwilioMessageV1       admin → tech outbound SMS, manual trigger only
 *   twilioInboundWebhookV1    tech  → admin inbound SMS, posted by Twilio
 *   twilioStatusCallbackV1    Twilio delivery status updates
 *
 * Hard constraints (from Phase 3C spec, enforced in code below):
 *   • Manual send only — no automatic SMS, no broadcast, no mass text.
 *   • No SMS from CEO action nudges yet.
 *   • Twilio credentials live ONLY in Firebase Secrets — never logged or
 *     surfaced to the client.
 *   • Inbound from unknown phone numbers is dropped (not threaded) — this
 *     prevents anonymous parties from creating threads + spamming admin.
 *
 * Secrets used (set via `firebase functions:secrets:set`):
 *   TWILIO_ACCOUNT_SID            (shared with emergency SOS path above)
 *   TWILIO_AUTH_TOKEN             (shared with emergency SOS path above)
 *   TWILIO_MESSAGING_SERVICE_SID  (new — preferred over TWILIO_FROM_NUMBER
 *                                  for the messaging service routing)
 *   TWILIO_PHONE_NUMBER           (new — used for signature validation log
 *                                  context; also a fallback "from" if the
 *                                  messaging service SID is empty)
 * ============================================================================ */

const TWILIO_MESSAGING_SERVICE_SID = defineSecret("TWILIO_MESSAGING_SERVICE_SID");
const TWILIO_PHONE_NUMBER          = defineSecret("TWILIO_PHONE_NUMBER");

const TWILIO_INBOUND_URL = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/twilioInboundWebhookV1";
const TWILIO_STATUS_URL  = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/twilioStatusCallbackV1";

function trimPreviewServer(body) {
  const s = String(body || "").replace(/\s+/g, " ").trim();
  if (s.length <= 140) return s;
  return s.slice(0, 137) + "…";
}

// Sentinel-safe FieldValue.serverTimestamp() shorthand. Used so the three
// functions below don't sprout six copies of the same admin.firestore call.
function fvNow() { return admin.firestore.FieldValue.serverTimestamp(); }

/* --------------------- sendTwilioMessageV1 (admin) --------------------- */
//
// POST /sendTwilioMessageV1
//   Authorization: Bearer <id-token>     (admin email required)
//   { threadId, messageBody,
//     recipientPhone?  — overrides phone resolution from thread participant
//     recipientId?     — overrides participant lookup }
//
// Resolves the recipient phone, sends one SMS via Twilio Messaging Service,
// then persists a communication_messages doc (channel=sms, direction=outbound)
// and bumps the thread status to waiting_on_employee. On Twilio rejection,
// persists a failed doc instead so the thread audit trail keeps the attempt.
exports.sendTwilioMessageV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 30,
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, TWILIO_PHONE_NUMBER]
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin",  "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (staff.role !== "admin") {
      logger.warn("[twilio.send] non-admin denied", { email: staff.email });
      res.status(403).json({ ok: false, error: "Admin access required to send SMS." });
      return;
    }

    const body = req.body || {};
    const threadId    = String(body.threadId    || body.thread_id    || "").trim();
    const messageBody = String(body.messageBody || body.message_body || body.body || "").trim();
    const recipientPhoneRaw = body.recipientPhone || body.recipient_phone || "";
    const recipientIdHint   = String(body.recipientId || body.recipient_id || "").toLowerCase().trim();

    if (!threadId) {
      res.status(400).json({ ok: false, error: "threadId is required." });
      return;
    }
    if (!messageBody) {
      res.status(400).json({ ok: false, error: "messageBody is required." });
      return;
    }
    if (messageBody.length > 1600) {
      // Twilio splits at 1600 chars across multiple segments; we cap here
      // so a runaway paste from /manager can't accidentally fire 20 segments.
      res.status(400).json({ ok: false, error: "messageBody too long (max 1600)." });
      return;
    }

    let threadRef, threadSnap, threadData;
    try {
      threadRef  = db.collection("communication_threads").doc(threadId);
      threadSnap = await threadRef.get();
      if (!threadSnap.exists) {
        res.status(404).json({ ok: false, error: "Thread not found." });
        return;
      }
      threadData = threadSnap.data() || {};
    } catch (e) {
      logger.error("[twilio.send] thread load failed", { threadId, error: e && e.message });
      res.status(500).json({ ok: false, error: "Failed to load thread." });
      return;
    }

    if (threadData.status === "closed" || threadData.status === "resolved") {
      res.status(409).json({ ok: false, error: "Cannot send SMS on a closed/resolved thread." });
      return;
    }

    /* ---- Resolve recipient phone + identity ---- */
    let toPhone = twilioMessaging.normalizePhone(recipientPhoneRaw);
    let recipientEmail = "";
    let recipientName  = "";

    if (!toPhone) {
      // Pick a participant. If recipientId hint was provided, prefer that
      // participant; otherwise first non-admin/non-executive participant.
      const participants = Array.isArray(threadData.participants) ? threadData.participants : [];
      let target = null;
      if (recipientIdHint) {
        target = participants.find(function (p) {
          return String(p.id || "").toLowerCase().trim() === recipientIdHint;
        }) || null;
      }
      if (!target) {
        target = participants.find(function (p) {
          const t = String(p.type || "").toLowerCase();
          return t === "tech" || t === "employee";
        }) || null;
      }
      if (!target) {
        res.status(400).json({ ok: false, error: "Could not identify a tech participant on this thread." });
        return;
      }
      recipientEmail = String(target.id || "").toLowerCase().trim();
      recipientName  = String(target.name || "");
      try {
        const lookup = await twilioMessaging.findTechPhoneByEmail(db, recipientEmail);
        if (!lookup) {
          res.status(400).json({
            ok: false,
            error: "No phone number on file for " + (recipientName || recipientEmail) + ". Update cleaning_techs.phone, then try again."
          });
          return;
        }
        toPhone = lookup.phone;
        if (!recipientName && lookup.tech) {
          recipientName = String(lookup.tech.display_name || lookup.tech.tech_display_name || "");
        }
      } catch (e) {
        logger.error("[twilio.send] phone lookup failed", {
          threadId, email: recipientEmail, error: e && e.message
        });
        res.status(500).json({ ok: false, error: "Failed to look up recipient phone." });
        return;
      }
    }

    /* ---- Send via Twilio ---- */
    const messagingServiceSid = (TWILIO_MESSAGING_SERVICE_SID.value() || "").trim();
    const fromNumber          = (TWILIO_PHONE_NUMBER.value() || "").trim();
    if (!messagingServiceSid && !fromNumber) {
      logger.error("[twilio.send] no messaging service sid OR phone number configured");
      res.status(500).json({ ok: false, error: "Twilio transport not configured." });
      return;
    }

    let client;
    try {
      client = twilioMessaging.getClient(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    } catch (e) {
      logger.error("[twilio.send] client init failed", { error: e && e.message });
      res.status(500).json({ ok: false, error: "Twilio client init failed." });
      return;
    }

    const senderName = (staff.tech && staff.tech.display_name) || staff.email.split("@")[0];

    let twilioRes = null;
    let twilioErr = null;
    try {
      const createOpts = {
        body: messageBody,
        to:   toPhone,
        statusCallback: TWILIO_STATUS_URL
      };
      if (messagingServiceSid) createOpts.messagingServiceSid = messagingServiceSid;
      else                     createOpts.from = fromNumber;
      twilioRes = await client.messages.create(createOpts);
    } catch (e) {
      twilioErr = e;
    }

    /* ---- Persist message + thread bump (atomic) ---- */
    const msgRef = db.collection("communication_messages").doc();
    const sts    = fvNow();
    const successful = !twilioErr && twilioRes && twilioRes.sid;

    const messageDoc = {
      thread_id:      threadId,
      category:       threadData.category || null,
      channel:        "sms",
      direction:      "outbound",
      status:         successful ? "queued" : "failed",
      sender_type:    "admin",
      sender_id:      staff.email,
      sender_name:    senderName,
      recipient_type: "employee",
      recipient_id:   recipientEmail,
      recipient_name: recipientName,
      body:           messageBody,
      created_at:     sts,
      deliver_after:  sts,
      delivered_at:   null,
      read_at:        null,
      sms_phone:      toPhone,
      sms_sid:        successful ? twilioRes.sid : null,
      sms_error:      successful ? null : String((twilioErr && twilioErr.message) || "Twilio rejected the send").slice(0, 500)
    };

    try {
      await db.runTransaction(async (tx) => {
        tx.set(msgRef, messageDoc);
        // Only bump the thread state on a successful send — a failed send
        // shouldn't flip "waiting_on_management" to "waiting_on_employee".
        if (successful) {
          tx.update(threadRef, {
            status:                 "waiting_on_employee",
            updated_at:             sts,
            last_message_at:        sts,
            last_message_preview:   trimPreviewServer(messageBody),
            last_message_direction: "outbound",
            message_count:          admin.firestore.FieldValue.increment(1)
          });
        } else {
          // Still bump updated_at + message_count so the failed attempt
          // appears in the thread history. Status stays put.
          tx.update(threadRef, {
            updated_at:             sts,
            last_message_at:        sts,
            last_message_preview:   trimPreviewServer(messageBody),
            last_message_direction: "outbound",
            message_count:          admin.firestore.FieldValue.increment(1)
          });
        }
      });
    } catch (e) {
      logger.error("[twilio.send] persist failed", { threadId, error: e && e.message });
      // Twilio may have already sent the SMS — return success metadata so
      // the admin sees the SID, but flag the persistence issue.
      res.status(500).json({
        ok: false,
        error: "SMS may have sent, but the database write failed: " + (e && e.message),
        sid:   successful ? twilioRes.sid : null
      });
      return;
    }

    if (!successful) {
      logger.warn("[twilio.send] twilio rejected", {
        threadId, to_redacted: twilioMessaging.redactPhone(toPhone),
        error: twilioErr && twilioErr.message,
        code:  twilioErr && twilioErr.code
      });
      res.status(502).json({
        ok: false,
        error: "Twilio rejected the send: " + (twilioErr && twilioErr.message),
        code:  twilioErr && twilioErr.code,
        messageId: msgRef.id
      });
      return;
    }

    logger.info("[twilio.send] ok", {
      threadId, sid: twilioRes.sid,
      to_redacted: twilioMessaging.redactPhone(toPhone),
      sender: staff.email, bytes: messageBody.length
    });
    res.json({
      ok: true,
      sid: twilioRes.sid,
      messageId: msgRef.id,
      to_redacted: twilioMessaging.redactPhone(toPhone)
    });
  }
);

/* --------------------- twilioInboundWebhookV1 (public) --------------------- */
//
// POST /twilioInboundWebhookV1   (Twilio-form-encoded; X-Twilio-Signature)
//
// Matches the From number to an active cleaning_techs doc. If no match,
// drops the message silently (200 OK + empty TwiML) — anonymous numbers
// MUST NOT be allowed to create threads. If matched, finds the most-
// recently-updated active thread for that tech, OR creates a new "general"
// thread; then appends an inbound message and bumps thread status to
// waiting_on_management.
exports.twilioInboundWebhookV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 30,
    secrets: [TWILIO_AUTH_TOKEN]
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    // Twilio posts application/x-www-form-urlencoded; firebase-functions v2
    // parses it into req.body as an object.
    const params = req.body || {};
    const signature = req.get("X-Twilio-Signature") || "";

    // Signature validation. We accept either signed (production) OR
    // missing-header (manual curl during testing) but never wrong-signature.
    const authToken = TWILIO_AUTH_TOKEN.value();
    if (signature) {
      const valid = twilioMessaging.validateSignature(authToken, signature, TWILIO_INBOUND_URL, params);
      if (!valid) {
        logger.warn("[twilio.inbound] invalid signature; refusing");
        res.status(403).send("Invalid signature");
        return;
      }
    } else {
      logger.info("[twilio.inbound] no signature header (manual call?)");
    }

    const fromRaw   = params.From || "";
    const bodyText  = String(params.Body || "").trim();
    const sid       = String(params.MessageSid || "").trim();

    if (!fromRaw || !sid) {
      res.status(400).send("Missing From or MessageSid");
      return;
    }

    const fromPhone = twilioMessaging.normalizePhone(fromRaw);
    if (!fromPhone) {
      logger.warn("[twilio.inbound] unparseable From", { from_redacted: twilioMessaging.redactPhone(fromRaw), sid });
      res.set("Content-Type", "text/xml");
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }

    let tech = null;
    try {
      tech = await twilioMessaging.findTechByPhone(db, fromPhone);
    } catch (e) {
      logger.error("[twilio.inbound] tech lookup failed", { error: e && e.message, sid });
    }

    if (!tech) {
      // Unknown sender. Log + drop. Returning 200 + empty TwiML so Twilio
      // doesn't retry; not creating a thread so anonymous parties can't
      // generate workload for admin.
      logger.warn("[twilio.inbound] unknown sender; dropping", {
        from_redacted: twilioMessaging.redactPhone(fromPhone), sid
      });
      res.set("Content-Type", "text/xml");
      res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }

    const techEmail = String(tech.email || "").toLowerCase().trim();
    const techName  = String(tech.display_name || tech.tech_display_name || techEmail);

    /* ---- Find or create thread ---- */
    let threadId   = null;
    let threadData = null;

    try {
      const candidates = await db.collection("communication_threads")
        .where("participant_ids", "array-contains", techEmail)
        .where("status", "in", ["open", "waiting_on_employee", "waiting_on_management"])
        .limit(20).get();

      if (!candidates.empty) {
        let bestId = null;
        let bestData = null;
        let bestTs = -1;
        candidates.forEach(function (d) {
          const data = d.data() || {};
          const ts = (data.updated_at && data.updated_at.toMillis && data.updated_at.toMillis()) || 0;
          if (ts > bestTs) { bestTs = ts; bestId = d.id; bestData = data; }
        });
        threadId   = bestId;
        threadData = bestData;
      }
    } catch (e) {
      logger.error("[twilio.inbound] thread query failed", { error: e && e.message, sid });
    }

    if (!threadId) {
      // Create a new general thread. Status starts at waiting_on_management
      // — the inbound message IS the first message, and admin owes a reply.
      const newRef = db.collection("communication_threads").doc();
      const subject = bodyText
        ? (bodyText.length > 80 ? bodyText.slice(0, 77) + "…" : bodyText)
        : ("SMS from " + techName);
      threadData = {
        category:               "general",
        status:                 "waiting_on_management",
        priority:               "action_required",
        message_type:           "general",
        subject:                subject,
        source_type:            "twilio_inbound",
        source_id:              sid,
        participants:           [{ type: "tech", id: techEmail, name: techName }],
        participant_ids:        [techEmail],
        created_by:             techEmail,
        created_at:             fvNow(),
        updated_at:             fvNow(),
        closed_at:              null,
        closed_by:              null,
        last_message_at:        null,
        last_message_preview:   null,
        last_message_direction: null,
        message_count:          0
      };
      try {
        await newRef.set(threadData);
        threadId = newRef.id;
      } catch (e) {
        logger.error("[twilio.inbound] thread create failed", { error: e && e.message, sid });
        res.status(500).send("Internal error");
        return;
      }
    }

    /* ---- Append inbound message + bump thread ---- */
    const msgRef    = db.collection("communication_messages").doc();
    const threadRef = db.collection("communication_threads").doc(threadId);
    const sts       = fvNow();
    const messageDoc = {
      thread_id:      threadId,
      category:       threadData.category || "general",
      channel:        "sms",
      direction:      "inbound",
      status:         "delivered",
      sender_type:    "tech",
      sender_id:      techEmail,
      sender_name:    techName,
      recipient_type: "admin",
      recipient_id:   "",
      recipient_name: "Pioneer Management",
      body:           bodyText || "(empty SMS body)",
      created_at:     sts,
      deliver_after:  sts,
      delivered_at:   sts,
      read_at:        null,
      sms_phone:      fromPhone,
      sms_sid:        sid,
      sms_error:      null
    };

    try {
      await db.runTransaction(async (tx) => {
        tx.set(msgRef, messageDoc);
        tx.update(threadRef, {
          status:                 "waiting_on_management",
          updated_at:             sts,
          last_message_at:        sts,
          last_message_preview:   trimPreviewServer(bodyText || "(empty SMS body)"),
          last_message_direction: "inbound",
          message_count:          admin.firestore.FieldValue.increment(1)
        });
      });
    } catch (e) {
      logger.error("[twilio.inbound] persist failed", { error: e && e.message, sid });
      res.status(500).send("Internal error");
      return;
    }

    logger.info("[twilio.inbound] persisted", {
      threadId, sid, tech: techEmail,
      from_redacted: twilioMessaging.redactPhone(fromPhone),
      bytes: bodyText.length
    });

    // Reply with empty TwiML so Twilio doesn't auto-send an SMS back.
    res.set("Content-Type", "text/xml");
    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }
);

/* --------------------- twilioStatusCallbackV1 (public) --------------------- */
//
// POST /twilioStatusCallbackV1   (Twilio-form-encoded; X-Twilio-Signature)
//
// Looks up the communication_messages doc by sms_sid and updates its status.
// Twilio fires this multiple times per send (queued → sent → delivered);
// we always overwrite with the latest. Errors update sms_error.
exports.twilioStatusCallbackV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 15,
    secrets: [TWILIO_AUTH_TOKEN]
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const params = req.body || {};
    const signature = req.get("X-Twilio-Signature") || "";
    const authToken = TWILIO_AUTH_TOKEN.value();
    if (signature) {
      const valid = twilioMessaging.validateSignature(authToken, signature, TWILIO_STATUS_URL, params);
      if (!valid) {
        logger.warn("[twilio.status] invalid signature; refusing");
        res.status(403).send("Invalid signature");
        return;
      }
    }

    const sid          = String(params.MessageSid || "").trim();
    const twilioStatus = String(params.MessageStatus || params.SmsStatus || "").trim().toLowerCase();
    const errorCode    = String(params.ErrorCode || "").trim();
    const errorMessage = String(params.ErrorMessage || "").trim();

    if (!sid || !twilioStatus) {
      res.status(400).send("Missing MessageSid or MessageStatus");
      return;
    }

    let snap;
    try {
      snap = await db.collection("communication_messages")
        .where("sms_sid", "==", sid)
        .limit(1).get();
    } catch (e) {
      logger.error("[twilio.status] query failed", { error: e && e.message, sid });
      res.status(500).send("Internal error");
      return;
    }

    if (snap.empty) {
      // Twilio may post status for a SID we never wrote (manual curl, race).
      // Acknowledge so Twilio doesn't keep retrying.
      logger.warn("[twilio.status] unknown sid", { sid, twilioStatus });
      res.status(200).send("OK");
      return;
    }

    /* Map Twilio MessageStatus → our MESSAGE_STATUS enum + side fields.
       Twilio status flow: accepted → queued → sending → sent → delivered
       (or → failed / undelivered at any step). We collapse all
       pre-terminal states to 'queued'. */
    let nextStatus = null;
    let setDeliveredAt = false;
    let setError = null;

    switch (twilioStatus) {
      case "accepted":
      case "queued":
      case "scheduled":
      case "sending":
      case "sent":
        nextStatus = "queued";
        break;
      case "delivered":
        nextStatus = "delivered";
        setDeliveredAt = true;
        break;
      case "undelivered":
      case "failed":
        nextStatus = "failed";
        setError = errorCode
          ? ("[" + errorCode + "] " + (errorMessage || twilioStatus))
          : (errorMessage || ("Twilio: " + twilioStatus));
        break;
      default:
        // Unknown status — log + leave the doc alone rather than corrupt it.
        logger.warn("[twilio.status] unmapped status", { sid, twilioStatus });
        res.status(200).send("OK");
        return;
    }

    const ref = snap.docs[0].ref;
    const update = {
      status:     nextStatus,
      updated_at: fvNow()
    };
    if (setDeliveredAt) update.delivered_at = fvNow();
    if (setError)       update.sms_error    = setError.slice(0, 500);

    try {
      await ref.update(update);
    } catch (e) {
      logger.error("[twilio.status] update failed", { sid, error: e && e.message });
      res.status(500).send("Internal error");
      return;
    }

    logger.info("[twilio.status] ok", { sid, twilioStatus, nextStatus });
    res.status(200).send("OK");
  }
);

/* ============================================================================
 * Phase Customer Economics v1 — QuickBooks Online OAuth foundation
 *
 * Two HTTPS endpoints implement the OAuth 2 authorization-code flow:
 *
 *   quickbooksOAuthStartV1     admin-gated. Generates a CSRF state token,
 *                              persists it (with 15-min TTL), and returns
 *                              the Intuit authorize URL the admin should
 *                              navigate to.
 *
 *   quickbooksOAuthCallbackV1  public (Intuit redirects here). Validates
 *                              the state token, exchanges the authorization
 *                              code for access + refresh tokens, and writes
 *                              quickbooks_auth/connection. Returns a small
 *                              HTML success page.
 *
 * Future sync functions call qboAuth.getValidAccessToken() — it auto-
 * refreshes if the access_token is near expiry.
 *
 * Secrets:
 *   QBO_CLIENT_ID
 *   QBO_CLIENT_SECRET
 *   QBO_REDIRECT_URI         (must EXACTLY match what's set in the Intuit
 *                             Developer app's Redirect URIs list)
 *   QBO_ENVIRONMENT          ("production" or "sandbox" — drives API base)
 *
 * Setup checklist (Intuit Developer Portal — Nick's side):
 *   1. Register an app under https://developer.intuit.com/
 *   2. Add the production scope: com.intuit.quickbooks.accounting
 *   3. Add this redirect URI EXACTLY (no trailing slash):
 *      https://us-central1-pioneer-dcr-hub.cloudfunctions.net/quickbooksOAuthCallbackV1
 *   4. Copy the Client ID + Client Secret into Firebase Secrets.
 *   5. Visit /manager → admin tool to trigger quickbooksOAuthStartV1
 *      (or POST to the endpoint with a bearer token + open the returned
 *       authorize URL in a browser).
 * ============================================================================ */

const QBO_CLIENT_ID     = defineSecret("QBO_CLIENT_ID");
const QBO_CLIENT_SECRET = defineSecret("QBO_CLIENT_SECRET");
const QBO_REDIRECT_URI  = defineSecret("QBO_REDIRECT_URI");
const QBO_ENVIRONMENT   = defineSecret("QBO_ENVIRONMENT");

exports.quickbooksOAuthStartV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 15,
    secrets: [QBO_CLIENT_ID, QBO_REDIRECT_URI]
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin",  "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (staff.role !== "admin") {
      logger.warn("[qbo.oauth.start] non-admin denied", { email: staff.email });
      res.status(403).json({ ok: false, error: "Admin access required to connect QuickBooks." });
      return;
    }

    const clientId    = (QBO_CLIENT_ID.value()    || "").trim();
    const redirectUri = (QBO_REDIRECT_URI.value() || "").trim();
    if (!clientId)    { res.status(500).json({ ok: false, error: "QBO_CLIENT_ID secret is empty." });    return; }
    if (!redirectUri) { res.status(500).json({ ok: false, error: "QBO_REDIRECT_URI secret is empty." }); return; }

    try {
      const state = qboAuth.generateState();
      await qboAuth.storeState(state, staff.email);
      const authorizeUrl = qboAuth.buildAuthorizeUrl({
        clientId:    clientId,
        redirectUri: redirectUri,
        state:       state
      });
      logger.info("[qbo.oauth.start] state issued", { email: staff.email });
      res.json({ ok: true, authorize_url: authorizeUrl, state: state });
    } catch (err) {
      logger.error("[qbo.oauth.start] failed", { error: err && err.message });
      res.status(500).json({ ok: false, error: err && err.message });
    }
  }
);

exports.quickbooksOAuthCallbackV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 30,
    secrets: [QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENVIRONMENT]
  },
  async (req, res) => {
    // Intuit redirects here with GET ?code=...&state=...&realmId=...
    if (req.method !== "GET") {
      res.status(405).send("Method not allowed");
      return;
    }

    const code    = String(req.query.code    || "").trim();
    const state   = String(req.query.state   || "").trim();
    const realmId = String(req.query.realmId || "").trim();
    const errorParam = String(req.query.error || "").trim();

    function htmlPage(title, body, status) {
      res.set("Content-Type", "text/html; charset=utf-8");
      res.status(status || 200).send(
        '<!doctype html><meta charset="utf-8">' +
        '<title>' + title + '</title>' +
        '<style>body{font:14px/1.5 system-ui,sans-serif;max-width:560px;' +
        'margin:60px auto;padding:0 20px;color:#1e293b}h1{font-size:20px;' +
        'margin-bottom:12px}.ok{color:#15803d}.err{color:#b91c1c}' +
        'code{background:#f1f5f9;padding:2px 6px;border-radius:4px}</style>' +
        body
      );
    }

    if (errorParam) {
      logger.warn("[qbo.oauth.callback] intuit returned error", { error: errorParam });
      return htmlPage(
        "QuickBooks connection — error",
        '<h1 class="err">QuickBooks rejected the connection</h1>' +
        '<p>Intuit returned: <code>' + String(errorParam).replace(/[<>]/g, "") + '</code></p>' +
        '<p>Try again from /manager.</p>',
        400
      );
    }

    if (!code || !state || !realmId) {
      return htmlPage(
        "QuickBooks connection — missing params",
        '<h1 class="err">Missing OAuth parameters</h1>' +
        '<p>Expected <code>code</code>, <code>state</code>, <code>realmId</code> in the redirect.</p>',
        400
      );
    }

    // Validate state token — defends against CSRF and old-tab replays.
    let stateResult;
    try {
      stateResult = await qboAuth.consumeState(state);
    } catch (err) {
      logger.error("[qbo.oauth.callback] state consume threw", { error: err && err.message });
      return htmlPage(
        "QuickBooks connection — error",
        '<h1 class="err">Could not validate the OAuth state.</h1><p>Try again from /manager.</p>',
        500
      );
    }
    if (!stateResult.ok) {
      logger.warn("[qbo.oauth.callback] invalid state", { reason: stateResult.reason });
      return htmlPage(
        "QuickBooks connection — invalid state",
        '<h1 class="err">OAuth state invalid: ' + stateResult.reason + '</h1>' +
        '<p>This handshake may have expired or been intercepted. Start a fresh connection from /manager.</p>',
        400
      );
    }

    const clientId     = (QBO_CLIENT_ID.value()     || "").trim();
    const clientSecret = (QBO_CLIENT_SECRET.value() || "").trim();
    const redirectUri  = (QBO_REDIRECT_URI.value()  || "").trim();
    const environment  = ((QBO_ENVIRONMENT.value()  || "production") + "").toLowerCase().trim();
    if (!clientId || !clientSecret || !redirectUri) {
      return htmlPage(
        "QuickBooks connection — server misconfigured",
        '<h1 class="err">QBO secrets are missing.</h1>' +
        '<p>Set <code>QBO_CLIENT_ID</code>, <code>QBO_CLIENT_SECRET</code>, and <code>QBO_REDIRECT_URI</code> via <code>firebase functions:secrets:set</code>.</p>',
        500
      );
    }

    let tokens;
    try {
      tokens = await qboAuth.exchangeCodeForTokens({
        clientId:     clientId,
        clientSecret: clientSecret,
        code:         code,
        redirectUri:  redirectUri
      });
    } catch (err) {
      logger.error("[qbo.oauth.callback] token exchange failed", { error: err && err.message });
      return htmlPage(
        "QuickBooks connection — token exchange failed",
        '<h1 class="err">Intuit refused the token exchange.</h1>' +
        '<p><code>' + String((err && err.message) || "unknown").slice(0, 200).replace(/[<>]/g, "") + '</code></p>' +
        '<p>Verify the Redirect URI in the Intuit Developer app matches <code>' + redirectUri + '</code> exactly, then retry.</p>',
        502
      );
    }

    try {
      await qboAuth.saveConnection({
        realmId:      realmId,
        tokens:       tokens,
        environment:  environment,
        connectedBy:  stateResult.created_by,
        isInitial:    true
      });
    } catch (err) {
      logger.error("[qbo.oauth.callback] connection persist failed", { error: err && err.message });
      return htmlPage(
        "QuickBooks connection — persist failed",
        '<h1 class="err">Couldn\'t save the connection.</h1>' +
        '<p>Tokens were issued by Intuit but the Firestore write failed. Check function logs.</p>',
        500
      );
    }

    logger.info("[qbo.oauth.callback] connected", {
      realm_id: realmId, environment: environment, by: stateResult.created_by
    });
    return htmlPage(
      "QuickBooks connected",
      '<h1 class="ok">QuickBooks Online connected.</h1>' +
      '<p>Realm ID: <code>' + realmId.replace(/[<>]/g, "") + '</code></p>' +
      '<p>Environment: <code>' + environment + '</code></p>' +
      '<p>You can close this tab. Customer Economics will start populating on the next sync.</p>'
    );
  }
);

/* ============================================================================
 * Phase Customer Economics v1 — Sync + Manual Refresh
 *
 * syncFinancialPulseV1     scheduled 07:00 PT daily. Pulls QB customers +
 *                          invoices (last 30 days), pulls Pioneer cleaning
 *                          sessions, computes RPLH, writes
 *                          customer_economics/current + history doc.
 *
 * refreshFinancialPulseV1  admin-only HTTPS. Same sync core, run on demand.
 *
 * Fails soft when QuickBooks isn't connected — writes a snapshot with
 * status: "not_connected" so the CEO card renders a "Connect QB" call-to-
 * action instead of a stale dashboard.
 * ============================================================================ */

const ECONOMICS_CURRENT_DOC = "customer_economics/current";
const ECONOMICS_HISTORY_COLL = "customer_economics_history";
const ECONOMICS_TARGET_CONFIG = "pioneer_config/customer_economics";

// YYYY-MM-DD in the America/Los_Angeles zone. Used as the history doc id
// + period_end label. Stays stable across the calendar day even if the
// sync runs multiple times.
function pacificYmd(d) {
  d = d || new Date();
  // Use Intl with a fixed format; the resulting parts are { year, month, day }.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const m = {};
  parts.forEach(function (p) { m[p.type] = p.value; });
  return m.year + "-" + m.month + "-" + m.day;
}

function addDaysYmd(ymd, deltaDays) {
  const ms = Date.parse(ymd + "T12:00:00Z");
  if (!Number.isFinite(ms)) return ymd;
  const d = new Date(ms + deltaDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function readTargetRplh() {
  try {
    const snap = await db.doc(ECONOMICS_TARGET_CONFIG).get();
    if (!snap.exists) return customerEconomics.FALLBACK_TARGET_RPLH;
    const data = snap.data() || {};
    const v = Number(data.target_rplh);
    return (Number.isFinite(v) && v > 0) ? v : customerEconomics.FALLBACK_TARGET_RPLH;
  } catch (_e) {
    return customerEconomics.FALLBACK_TARGET_RPLH;
  }
}

async function readAliasDocs() {
  try {
    const snap = await db.collection("customer_aliases").get();
    return snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); });
  } catch (_e) {
    return [];
  }
}

async function readPioneerSessionsInWindow(periodStartYmd, periodEndYmd) {
  // pioneer_service_sessions stored clock_out_at as a Timestamp. Query
  // by clock_out_at within window, status=completed. Labor-type filtering
  // happens client-side in aggregateLaborByCustomer (cleaning only).
  const startTs = admin.firestore.Timestamp.fromMillis(Date.parse(periodStartYmd + "T00:00:00Z"));
  const endTs   = admin.firestore.Timestamp.fromMillis(Date.parse(periodEndYmd   + "T23:59:59Z"));
  try {
    const snap = await db.collection("pioneer_service_sessions")
      .where("status", "==", "completed")
      .where("clock_out_at", ">=", startTs)
      .where("clock_out_at", "<=", endTs)
      .get();
    return snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); });
  } catch (err) {
    logger.warn("[economics] pioneer_service_sessions query failed; trying fallback range scan", {
      error: err && err.message
    });
    // If the composite index is missing, fall back to a simpler query
    // and filter client-side. Slower, but never blocks the sync.
    try {
      const snap = await db.collection("pioneer_service_sessions")
        .where("status", "==", "completed")
        .limit(5000).get();
      const startMs = startTs.toMillis();
      const endMs   = endTs.toMillis();
      return snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (s) {
          const co = s.clock_out_at && s.clock_out_at.toMillis ? s.clock_out_at.toMillis() : 0;
          return co >= startMs && co <= endMs;
        });
    } catch (err2) {
      logger.error("[economics] pioneer_service_sessions fallback also failed", { error: err2 && err2.message });
      return [];
    }
  }
}

// Build a "not connected" snapshot — shipped on every sync when OAuth
// is missing, so the CEO card renders a clear call-to-action.
function buildNotConnectedSnapshot(reason) {
  const ymd = pacificYmd(new Date());
  return {
    snapshot_date: ymd,
    period:        "trailing_30d",
    period_start:  addDaysYmd(ymd, -30),
    period_end:    ymd,
    status:        "not_connected",
    error_message: String(reason || "QuickBooks not connected. Connect from /manager."),
    label:         "Customer Economics",
    subtitle:      "Revenue Per Labor Hour",
    disclosure:    "Not profitability. Overhead allocation not included.",
    target_rplh:   customerEconomics.FALLBACK_TARGET_RPLH,
    company: null,
    top_customers: [],
    bottom_customers: [],
    recommendations: [],
    customer_count_included: 0,
    customer_count_excluded: 0,
    excluded_customers: []
  };
}

async function writeSnapshot(snap, triggeredBy) {
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const docToWrite = Object.assign({}, snap, {
    snapshot_at:   sts,
    triggered_by:  String(triggeredBy || "schedule")
  });
  await db.doc(ECONOMICS_CURRENT_DOC).set(docToWrite);
  // History is keyed by snapshot date — re-running on same day overwrites.
  // This is intentional: a manual refresh later in the day produces a
  // single authoritative snapshot for that date.
  await db.collection(ECONOMICS_HISTORY_COLL).doc(snap.snapshot_date).set(docToWrite);
  return docToWrite;
}

// Shared core — used by both the scheduled function and the manual
// refresh endpoint.
async function runFinancialPulseSync(opts) {
  const triggeredBy = String((opts && opts.triggeredBy) || "schedule");
  const periodEndYmd   = pacificYmd(new Date());
  const periodStartYmd = addDaysYmd(periodEndYmd, -30);
  const targetRplh = await readTargetRplh();

  // Preflight — if OAuth isn't connected OR secrets are empty, write the
  // not_connected snapshot and return. This is the path admins will hit
  // until they complete the Intuit OAuth handshake.
  const clientId     = (QBO_CLIENT_ID.value()     || "").trim();
  const clientSecret = (QBO_CLIENT_SECRET.value() || "").trim();
  if (!clientId || !clientSecret) {
    logger.warn("[economics] QBO secrets missing — writing not_connected");
    const snap = buildNotConnectedSnapshot("QBO secrets not configured.");
    await writeSnapshot(snap, triggeredBy);
    return { ok: true, status: "not_connected", reason: "secrets_missing" };
  }

  let probe;
  try {
    probe = await qboApi.probeConnection({ clientId: clientId, clientSecret: clientSecret });
  } catch (err) {
    probe = { connected: false, error: err && err.message };
  }
  if (!probe.connected) {
    logger.warn("[economics] QBO not connected — writing not_connected", { reason: probe.error });
    const snap = buildNotConnectedSnapshot(probe.error || "Not connected.");
    await writeSnapshot(snap, triggeredBy);
    return { ok: true, status: "not_connected", reason: probe.error };
  }

  // Pull everything we need in parallel.
  let qboCustomers, qboInvoices, pioneerSessions, aliasDocs;
  try {
    [qboCustomers, qboInvoices, pioneerSessions, aliasDocs] = await Promise.all([
      qboApi.fetchActiveCustomers({ clientId: clientId, clientSecret: clientSecret }),
      qboApi.fetchInvoicesInWindow({ clientId: clientId, clientSecret: clientSecret }, periodStartYmd, periodEndYmd),
      readPioneerSessionsInWindow(periodStartYmd, periodEndYmd),
      readAliasDocs()
    ]);
  } catch (err) {
    logger.error("[economics] data fetch failed", { error: err && err.message });
    const snap = Object.assign(buildNotConnectedSnapshot("QBO data fetch failed: " + (err && err.message)), {
      status: "error"
    });
    await writeSnapshot(snap, triggeredBy);
    return { ok: false, status: "error", error: err && err.message };
  }

  const snap = customerEconomics.buildSnapshot({
    targetRplh:      targetRplh,
    qboCustomers:    qboCustomers,
    qboInvoices:     qboInvoices,
    pioneerSessions: pioneerSessions,
    aliasDocs:       aliasDocs,
    periodStartYmd:  periodStartYmd,
    periodEndYmd:    periodEndYmd
  });
  snap.status = "fresh";

  await writeSnapshot(snap, triggeredBy);

  logger.info("[economics] sync ok", {
    triggered_by: triggeredBy,
    included:     snap.customer_count_included,
    excluded:     snap.customer_count_excluded,
    avg_rplh:     snap.company && snap.company.avg_rplh,
    target_rplh:  snap.target_rplh
  });
  return {
    ok: true,
    status: "fresh",
    included: snap.customer_count_included,
    excluded: snap.customer_count_excluded,
    avg_rplh: snap.company && snap.company.avg_rplh
  };
}

exports.syncFinancialPulseV1 = onSchedule(
  {
    schedule: "0 7 * * *",
    timeZone: "America/Los_Angeles",
    timeoutSeconds: 300,
    secrets: [QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENVIRONMENT]
  },
  async (_event) => {
    try {
      await runFinancialPulseSync({ triggeredBy: "schedule" });
    } catch (err) {
      logger.error("[economics] scheduled sync crashed", { error: err && err.message });
    }
  }
);

exports.refreshFinancialPulseV1 = onRequest(
  {
    cors: false,
    timeoutSeconds: 300,
    secrets: [QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_ENVIRONMENT]
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin",  "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (staff.role !== "admin") {
      logger.warn("[economics.refresh] non-admin denied", { email: staff.email });
      res.status(403).json({ ok: false, error: "Admin access required." });
      return;
    }

    try {
      const result = await runFinancialPulseSync({ triggeredBy: "manual:" + staff.email });
      res.json(result);
    } catch (err) {
      logger.error("[economics.refresh] crashed", { error: err && err.message });
      res.status(500).json({ ok: false, error: err && err.message });
    }
  }
);

