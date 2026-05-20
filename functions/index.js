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

// Mirror of the client-side ALLOWED_ADMIN_EMAILS in public/admin.js. Server-
// side authoritative copy — used by verifyStaffOrReject() + whoAmIV1.
// Keep in sync with public/admin.js + firestore.rules → isPioneerAdmin().
const ALLOWED_ADMIN_EMAILS = [
  "nick@pioneercomclean.com",
  "april@pioneercomclean.com",
  "kirby@pioneercomclean.com",
  "mgies@pioneercomclean.com"
];

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
      resetLink = await admin.auth().generatePasswordResetLink(email);
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
  let resetLink = null;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(email);
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

  // Generate a reset link.
  let resetLink = null;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(email);
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
        const hasInfo = !!(
          alarmCodes.length || doorCodes.length || gateCodes.length ||
          fobCodes.length || keyNotes.length || securityInstructions.length
        );
        customer.securityInfo = {
          hasInfo:              hasInfo,
          alarmCodes:           alarmCodes,
          doorCodes:            doorCodes,
          gateCodes:            gateCodes,
          fobCodes:             fobCodes,
          keyNotes:             keyNotes,
          securityInstructions: securityInstructions
        };
      } else {
        customer.securityInfo = {
          hasInfo: false,
          alarmCodes: [], doorCodes: [], gateCodes: [],
          fobCodes: [], keyNotes: [], securityInstructions: []
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
exports.submitDcrV1 = onRequest({ cors: false, timeoutSeconds: 60 }, async (req, res) => {
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

  // Best-effort: create a supply_requests doc if the DCR asked for supplies.
  // Failure here is logged but never blocks the success response — the DCR is
  // already saved by the time we get here, and admins can manually create the
  // request from the office if needed.
  await maybeCreateSupplyRequest(doc, submissionId);

  // ---- Zapier (best-effort, never blocks the success response) ----
  // Read URL at request time (not module load) so deploys without the env var
  // still work and a redeploy with the var picks it up immediately.
  const zapierUrl = (process.env.ZAPIER_DCR_WEBHOOK_URL || "").trim();
  const zapierPayload = buildZapierPayload(doc, submissionId);
  // Minimal verification log — confirms (a) the array shape Zapier
  // receives and (b) the photo count exposed via the new flat fields.
  // Keeps logs scannable without dumping URLs (those are already
  // available via Cloud Storage if a triage needs them).
  logger.info("submitDcrV1 zapier payload shape", {
    submission_id:      submissionId,
    photo_count:        zapierPayload.photo_count,
    photo_urls_is_array: Array.isArray(zapierPayload.photo_urls),
    flat_field_count:   Object.keys(zapierPayload)
                          .filter(function (k) { return /^photo_url_\d+$/.test(k); })
                          .length
  });
  const zapierResult  = await sendToZapier(zapierUrl, zapierPayload);

  // Persist the Zapier outcome on the doc. Best-effort — if the update itself
  // fails we still return success to the browser.
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
      error: err.message,
      submission_id: submissionId,
      zapier_status: zapierResult.status
    });
  }

  if (zapierResult.status === "failed") {
    logger.warn("Zapier delivery failed", {
      submission_id: submissionId,
      status_code: zapierResult.status_code,
      error: zapierResult.error
    });
  } else if (zapierResult.status === "sent") {
    logger.info("Zapier delivery succeeded", {
      submission_id: submissionId,
      status_code: zapierResult.status_code
    });
  }

  return res.status(200).json({
    ok: true,
    submission_id: submissionId,
    zapier: zapierResult
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

    let techMatch = null;
    if (employeeIdRaw != null && techsByDeputyId[String(employeeIdRaw)]) {
      techMatch = techsByDeputyId[String(employeeIdRaw)];
    } else if (employeeEmailRaw && techsByEmail[employeeEmailRaw]) {
      techMatch = techsByEmail[employeeEmailRaw];
    } else {
      const nameKey = normalizeKey(employeeDisplay);
      if (nameKey && techsByNameKey[nameKey]) techMatch = techsByNameKey[nameKey];
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
   declares the secrets + binds them to the onRequest endpoint. =============== */
const OPENAI_API_KEY             = defineSecret("OPENAI_API_KEY");
const GMAIL_SENDER_EMAIL         = defineSecret("GMAIL_SENDER_EMAIL");
const GMAIL_SERVICE_ACCOUNT_KEY  = defineSecret("GMAIL_SERVICE_ACCOUNT_KEY");
// V6 — these were originally declared further down (for submitFeedbackV1).
// Moved up so generateAndSendDcrEmailV1 can also bind them; the
// duplicate `defineSecret` calls below are removed to avoid the
// "secret already declared" deploy-time error.
const KIRBY_ALERT_EMAIL          = defineSecret("KIRBY_ALERT_EMAIL");
const APRIL_ALERT_EMAIL          = defineSecret("APRIL_ALERT_EMAIL");

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
