/* sessionsV2-dcr-parity.js — Phase 36a.2 pure parity helpers.
 *
 * Compare a V1 dcr_submissions document against a V2 SessionSnapshot
 * and return human-readable divergence strings on the small allowlist
 * of fields where V1 and V2 are EXPECTED to match.
 *
 * Pure functions. No I/O, no async. Testable from node --test.
 *
 * Closed allowlist of compared fields (see docs/sessionsV2/PHASE36A_PLAN.md):
 *   - customer_slug
 *   - photo_count
 *   - submitter_email
 *   - assignment_id (extracted from V2 session_id)
 *
 * Intentionally NOT compared:
 *   - timestamps (precision drift)
 *   - free-form text (notes, observations)
 *   - tech-side device metadata
 *   - server-stamped fields with no V2 counterpart
 */

"use strict";

function _lc(s) { return String(s == null ? "" : s).toLowerCase().trim(); }

// Extract assignment_id segment from a V2 session_id of the form
//   sess_<assignment_id>_<service_date>_a<n>
// where assignment_id may itself contain dashes (but not underscores or
// segment boundaries). Returns "" if shape doesn't match.
function extractAssignmentIdFromSessionId(sessionId) {
  const sid = String(sessionId || "");
  if (sid.indexOf("sess_") !== 0) return "";
  // Skip the admin-manual + recovery forms — they don't have a 1:1
  // assignment_id and aren't expected from tech_clock DCR submits.
  const tail = sid.slice(5);
  if (tail.indexOf("manual_") === 0 || tail.indexOf("recover_") === 0) return "";
  const lastAttemptIdx = tail.lastIndexOf("_a");
  if (lastAttemptIdx < 0) return "";
  const middle = tail.slice(0, lastAttemptIdx);
  const lastDateIdx = middle.lastIndexOf("_");
  if (lastDateIdx < 0) return "";
  return middle.slice(0, lastDateIdx);
}

function parityDiff(v1Doc, snapshot) {
  const out = [];
  const v1 = v1Doc   || {};
  const w  = (snapshot && snapshot.work) || {};
  const cust  = w.customer || {};
  const staff = w.staff    || {};

  // customer_slug
  const v1Slug = _lc(v1.customer_slug);
  const v2Slug = _lc(cust.slug);
  if (v1Slug && v2Slug && v1Slug !== v2Slug) {
    out.push("customer_slug(v1=" + v1Slug + ",v2=" + v2Slug + ")");
  }

  // photo_count
  const v1Photos = Array.isArray(v1.photos) ? v1.photos.length : null;
  const v2Photos = (snapshot && snapshot.components &&
                    snapshot.components.photos &&
                    snapshot.components.photos.count);
  if (v1Photos != null && v2Photos != null && v1Photos !== v2Photos) {
    out.push("photo_count(v1=" + v1Photos + ",v2=" + v2Photos + ")");
  }

  // submitter_email
  const v1Email = _lc(v1.submitted_by_email);
  const v2Email = _lc(staff.email);
  if (v1Email && v2Email && v1Email !== v2Email) {
    out.push("submitter_email(v1=" + v1Email + ",v2=" + v2Email + ")");
  }

  // assignment_id (V2 derived from session_id)
  const v1Asg   = String(v1.pioneer_assignment_id || "").trim();
  const v2SidAsg = extractAssignmentIdFromSessionId(snapshot && snapshot.session_id);
  if (v1Asg && v2SidAsg && v1Asg !== v2SidAsg) {
    out.push("assignment_id(v1=" + v1Asg + ",v2_sid_asg=" + v2SidAsg + ")");
  }

  return out;
}

// Phase 36b — idempotency predicate for the DCR -> Session dual-write.
// Both the inline submitDcrV1 splice AND the new onDcrSubmissionCreatedV36b
// trigger call sessionsV2_dualWriteFromDcrSubmit; either may fire more than
// once for the same submissionId (Firestore at-least-once delivery; dual-
// writer overlap during Phase 36b). This predicate is the natural idempotency
// key: if components.dcr.ref === submissionId AND components.dcr.status is
// "complete", the event has already been applied. Caller should skip.
//
// Pure function. No I/O. Defensive on shape: returns false (= don't skip)
// for any malformed input rather than erroring.
function isAlreadyProcessedByDcrSubmissionId(v2Data, submissionId) {
  if (!v2Data || typeof v2Data !== "object") return false;
  if (!submissionId) return false;
  const dcr = (v2Data.components && v2Data.components.dcr) || null;
  if (!dcr || typeof dcr !== "object") return false;
  return dcr.ref === submissionId && dcr.status === "complete";
}

module.exports = {
  parityDiff:                          parityDiff,
  extractAssignmentIdFromSessionId:    extractAssignmentIdFromSessionId,
  isAlreadyProcessedByDcrSubmissionId: isAlreadyProcessedByDcrSubmissionId
};
