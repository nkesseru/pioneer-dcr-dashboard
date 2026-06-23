/* Pioneer DCR Hub — Twilio Messaging helpers (Phase 3C).
 *
 * Phone normalization, tech-by-phone lookup, tech-by-email→phone lookup,
 * and a thin Twilio REST client wrapper. Kept in its own module so the
 * three Phase 3C Cloud Functions (sendTwilioMessageV1,
 * twilioInboundWebhookV1, twilioStatusCallbackV1) can share one normalization
 * pass and one lookup contract.
 *
 * Phone fields searched on cleaning_techs (in order): phone, phone_number,
 * mobile, sms_phone. Hubs that add new variants should update CANDIDATE_FIELDS.
 *
 * NEVER log raw phone numbers or auth tokens. Use redactPhone() before
 * passing to logger.info/warn.
 */
"use strict";

const Twilio = require("twilio");

const CANDIDATE_FIELDS = ["phone", "phone_number", "mobile", "sms_phone"];

/* ----------------------------- Normalization ----------------------------- */

// Returns E.164 (+1XXXXXXXXXX) for any obvious US 10-or-11-digit input, or
// the trimmed +<digits> if it already starts with +. Returns null when the
// input cannot be reasonably interpreted as a phone number.
function normalizePhone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const stripped = s.replace(/[^\d+]/g, "");
  if (!stripped) return null;
  if (stripped.startsWith("+")) {
    // Must be +<digits>, length >= 11 (+1XXXXXXXXXX) — reject obvious junk.
    const digits = stripped.slice(1).replace(/\+/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return "+" + digits;
  }
  // No +; assume US.
  if (stripped.length === 10) return "+1" + stripped;
  if (stripped.length === 11 && stripped.startsWith("1")) return "+" + stripped;
  return null;
}

function redactPhone(raw) {
  const n = normalizePhone(raw);
  if (!n) return "(unparseable)";
  if (n.length <= 5) return "***";
  return n.slice(0, 5) + "***" + n.slice(-2);
}

/* ----------------------------- Lookups ----------------------------- */

// Find cleaning_techs doc whose any phone-shaped field matches `phone`.
// Two-pass: indexed equality first (cheap), then full scan + normalize
// fallback (small collection, never more than ~50 docs).
async function findTechByPhone(db, phone) {
  const want = normalizePhone(phone);
  if (!want) return null;

  // Pass 1 — indexed equality on each candidate field. Matches only if the
  // tech doc stores the number already in E.164.
  for (const field of CANDIDATE_FIELDS) {
    try {
      const snap = await db.collection("cleaning_techs")
        .where(field, "==", want)
        .limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0];
        return Object.assign({ _id: d.id }, d.data() || {});
      }
    } catch (_e) { /* field may not exist on any doc — Firestore is fine; ignore */ }
  }

  // Pass 2 — scan + normalize. Catches techs whose phone was entered as
  // "(509) 555-1234" or "5095551234".
  const all = await db.collection("cleaning_techs").get();
  for (const doc of all.docs) {
    const data = doc.data() || {};
    if (data.active === false) continue;
    for (const field of CANDIDATE_FIELDS) {
      const n = normalizePhone(data[field]);
      if (n && n === want) {
        return Object.assign({ _id: doc.id }, data);
      }
    }
  }
  return null;
}

// Given an email, find the tech's primary E.164 phone (first non-null
// across CANDIDATE_FIELDS), or null. Active-only.
async function findTechPhoneByEmail(db, email) {
  const e = String(email || "").toLowerCase().trim();
  if (!e) return null;
  const snap = await db.collection("cleaning_techs")
    .where("email", "==", e)
    .limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() || {};
  if (data.active === false) return null;
  for (const field of CANDIDATE_FIELDS) {
    const n = normalizePhone(data[field]);
    if (n) return { phone: n, tech: Object.assign({ _id: snap.docs[0].id }, data) };
  }
  return null;
}

/* ----------------------------- Twilio client ----------------------------- */

function getClient(accountSid, authToken) {
  if (!accountSid) throw new Error("twilio: TWILIO_ACCOUNT_SID secret is empty");
  if (!authToken)  throw new Error("twilio: TWILIO_AUTH_TOKEN secret is empty");
  return Twilio(accountSid, authToken);
}

// Wrapper around Twilio.validateRequest that tolerates missing inputs by
// returning false (never throws). Caller decides what to do on failure.
function validateSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  try {
    return Twilio.validateRequest(authToken, signature, url, params || {});
  } catch (_e) {
    return false;
  }
}

module.exports = {
  CANDIDATE_FIELDS,
  normalizePhone,
  redactPhone,
  findTechByPhone,
  findTechPhoneByEmail,
  getClient,
  validateSignature
};
