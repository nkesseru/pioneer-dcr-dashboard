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

// Phase 36d — checklist projection for components.checklist.
//
// Operation One Truth Rule 2: Session owns checklist reality. At DCR
// submit time, the V1 dcr_submissions doc carries a full per-section,
// per-item checklist (built by app.js::buildFormData). This pure helper
// projects that into the Session's components.checklist shape: counts +
// pct + per-item snapshot.
//
// Pure function. No I/O. Defensive on all shapes. Returns the canonical
// projection that sessionsV2_dualWriteFromDcrSubmit stamps onto V2.
//
// Output shape (closed; new fields require helper version bump):
//   {
//     items_total:     int,
//     items_complete:  int,                    // status === "done"
//     items_issue:     int,                    // status === "issue"
//     items_na:        int,                    // status === "na"
//     items_untouched: int,                    // status was null / unknown
//     pct:             int (0-100),            // (items_complete / items_total) × 100,
//                                              // or 0 if items_total === 0
//     sections:        Array<SectionSnapshot>  // see below
//   }
//
// SectionSnapshot shape (closed):
//   {
//     section_id: string,
//     items: Array<{
//       item_id: string,
//       status:  "done" | "issue" | "na" | "untouched",   // never null
//       note:    string | null                            // only when status === "issue"
//     }>
//   }
//
// Deliberately excluded (live in dcr-form-config.js):
//   - section_label, item_label
//
// Status normalization:
//   - "done"      -> "done"
//   - "issue"     -> "issue"
//   - "na"        -> "na"
//   - null/missing/unknown string -> "untouched"
//
// Note is preserved on output only when status === "issue" (matches the
// V1 buildFormData logic at app.js: `if (status === "issue" && note.trim())`).
const _CHECKLIST_STATUS_DONE      = "done";
const _CHECKLIST_STATUS_ISSUE     = "issue";
const _CHECKLIST_STATUS_NA        = "na";
const _CHECKLIST_STATUS_UNTOUCHED = "untouched";

function _normalizeChecklistItemStatus(raw) {
  if (raw === _CHECKLIST_STATUS_DONE)  return _CHECKLIST_STATUS_DONE;
  if (raw === _CHECKLIST_STATUS_ISSUE) return _CHECKLIST_STATUS_ISSUE;
  if (raw === _CHECKLIST_STATUS_NA)    return _CHECKLIST_STATUS_NA;
  return _CHECKLIST_STATUS_UNTOUCHED;
}

function projectChecklistForSession(dcrChecklist) {
  const empty = {
    items_total:     0,
    items_complete:  0,
    items_issue:     0,
    items_na:        0,
    items_untouched: 0,
    pct:             0,
    sections:        []
  };

  if (!Array.isArray(dcrChecklist)) return empty;

  const sections = [];
  let total = 0, done = 0, issue = 0, na = 0, untouched = 0;

  for (let s = 0; s < dcrChecklist.length; s++) {
    const sec = dcrChecklist[s];
    if (!sec || typeof sec !== "object") continue;

    const sectionId = (sec.section_id != null) ? String(sec.section_id) : "";
    if (!sectionId) continue;

    const items = [];
    if (Array.isArray(sec.items)) {
      for (let i = 0; i < sec.items.length; i++) {
        const it = sec.items[i];
        if (!it || typeof it !== "object") continue;

        const itemId = (it.item_id != null) ? String(it.item_id) : "";
        if (!itemId) continue;

        const status = _normalizeChecklistItemStatus(it.status);
        const entry  = { item_id: itemId, status: status, note: null };

        if (status === _CHECKLIST_STATUS_ISSUE) {
          // Preserve note only on issue. Trim like buildFormData does;
          // empty/whitespace-only -> null.
          const noteRaw = (it.note != null) ? String(it.note).trim() : "";
          entry.note = noteRaw || null;
        }

        items.push(entry);
        total++;
        if      (status === _CHECKLIST_STATUS_DONE)  done++;
        else if (status === _CHECKLIST_STATUS_ISSUE) issue++;
        else if (status === _CHECKLIST_STATUS_NA)    na++;
        else                                          untouched++;
      }
    }

    sections.push({ section_id: sectionId, items: items });
  }

  return {
    items_total:     total,
    items_complete:  done,
    items_issue:     issue,
    items_na:        na,
    items_untouched: untouched,
    pct:             total > 0 ? Math.round((done * 100) / total) : 0,
    sections:        sections
  };
}

// Phase 36e — notes projection (session-level field, reserved-null).
//
// Operation One Truth Rule 2: Session owns notes. There is no V1 source
// for tech-written session notes today; this projection ships as a
// pass-through / placeholder so future writers (admin correction tool,
// tech-side notes UI) can populate without schema-breaking changes.
//
// Reads dcrDoc for a top-level `notes` field (does not exist today; V1
// admins occasionally add notes to dcr_submissions via ad-hoc edits).
// Returns null if no writer stamped a value.
//
// Pure. Never throws.
function projectNotesForSession(dcrDoc) {
  if (!dcrDoc || typeof dcrDoc !== "object") return { text: null };
  const raw = dcrDoc.notes;
  if (typeof raw !== "string") return { text: null };
  const trimmed = raw.trim();
  return { text: trimmed || null };
}

// Phase 36e — occupancy projection (session-level field).
//
// Operation One Truth Rule 2: Session owns occupancy observation.
// Reads dcrDoc.anyone_in_building + dcrDoc.occupancy_level (V1 buildFormData
// stamps both when the "Anyone in building?" segment is filled).
//
// Returns:
//   null                              — DCR did not carry occupancy fields
//   { anyone_in_building: bool | null,
//     occupancy_level:    string | null }
//
// V1 sends anyone_in_building as "yes" | "no" (string). We normalize to
// boolean here so consumers don't need to reparse. occupancy_level is
// kept as string; enum validation is a Phase 37 read-side concern.
//
// Pure. Never throws.
function projectOccupancyForSession(dcrDoc) {
  if (!dcrDoc || typeof dcrDoc !== "object") return null;
  const rawAnyone = dcrDoc.anyone_in_building;
  const rawLevel  = dcrDoc.occupancy_level;

  // If neither field is present in any recognizable form, treat as absent.
  const hasAnyone = rawAnyone === true || rawAnyone === false ||
                    rawAnyone === "yes" || rawAnyone === "no";
  const hasLevel  = typeof rawLevel === "string" && rawLevel.trim().length > 0;
  if (!hasAnyone && !hasLevel) return null;

  let anyone = null;
  if (rawAnyone === true || rawAnyone === "yes") anyone = true;
  else if (rawAnyone === false || rawAnyone === "no") anyone = false;

  const level = hasLevel ? rawLevel.trim() : null;

  return {
    anyone_in_building: anyone,
    occupancy_level:    level
  };
}

// Phase 36e — supplies projection (components.supplies).
//
// Operation One Truth Rule 2 + Rule 8: components.supplies has its own
// lifecycle (`not_applicable` / `requested` / `fulfilled`).
//
// Reads dcrDoc.needs_supplies + dcrDoc.supply_request_text. In V1's
// buildFormData shape (public/app.js), needs_supplies is `boolean`; the
// supply_request_text is a trimmed string (present only when
// needs_supplies is true).
//
// Returns:
//   { status: "not_applicable", request_text: null } — no supply request
//   { status: "requested",      request_text: str | null } — tech asked
//
// Phase 36e does NOT wire the "fulfilled" transition (Phase 37+ admin
// tool territory). request_ref (link to V1 supply_requests doc id) is
// deliberately deferred to a Phase 40 slice — no query at splice time.
//
// Pure. Never throws.
function projectSuppliesForSession(dcrDoc) {
  const NA = { status: "not_applicable", request_text: null };
  if (!dcrDoc || typeof dcrDoc !== "object") return NA;
  if (dcrDoc.needs_supplies !== true) return NA;

  let text = null;
  if (typeof dcrDoc.supply_request_text === "string") {
    const t = dcrDoc.supply_request_text.trim();
    text = t || null;
  }
  return { status: "requested", request_text: text };
}

// Phase 36e — problem projection (components.problem).
//
// Operation One Truth Rule 2 + Rule 8: components.problem has its own
// lifecycle (`not_applicable` / `reported` / `resolved`).
//
// Reads dcrDoc.has_problem + dcrDoc.problem. V1 buildFormData shape:
//   has_problem: bool
//   problem:     { category, summary, details, location, our_fault } | null
//                   (populated only when has_problem is true)
//
// Returns:
//   { status: "not_applicable", report: null }
//   { status: "reported",       report: { category, summary, details,
//                                          location, our_fault } }
//
// Phase 36e does NOT wire the "resolved" transition (Phase 37+ admin
// action). Defensive on inner report shape — every field defaults to
// null when malformed.
//
// Pure. Never throws.
function projectProblemForSession(dcrDoc) {
  const NA = { status: "not_applicable", report: null };
  if (!dcrDoc || typeof dcrDoc !== "object") return NA;
  if (dcrDoc.has_problem !== true) return NA;

  const p = dcrDoc.problem;
  if (!p || typeof p !== "object") {
    // has_problem === true but no problem detail object — record the
    // reported status with an empty report shell so downstream readers
    // can distinguish "problem was flagged" from "no problem".
    return {
      status: "reported",
      report: { category: null, summary: null, details: null,
                location: null, our_fault: null }
    };
  }

  const strOrNull = function (v) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t || null;
  };
  const boolOrNull = function (v) {
    if (v === true || v === false) return v;
    return null;
  };

  return {
    status: "reported",
    report: {
      category:  strOrNull(p.category),
      summary:   strOrNull(p.summary),
      details:   strOrNull(p.details),
      location:  strOrNull(p.location),
      our_fault: boolOrNull(p.our_fault)
    }
  };
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
  isAlreadyProcessedByDcrSubmissionId: isAlreadyProcessedByDcrSubmissionId,
  projectChecklistForSession:          projectChecklistForSession,
  // Phase 36e
  projectNotesForSession:              projectNotesForSession,
  projectOccupancyForSession:          projectOccupancyForSession,
  projectSuppliesForSession:           projectSuppliesForSession,
  projectProblemForSession:            projectProblemForSession
};
