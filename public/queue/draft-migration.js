/* Pioneer DCR Hub — Phase 31 prototype: draft migration helper.
 *
 * STATUS: PROTOTYPE. Wired by queue-test.html and (in the production
 * build of Phase 31) by app.js boot — only when window.OFFLINE_QUEUE_ENABLED
 * is true.
 *
 * Contract:
 *   migrateLegacyDraftIfPresent({ allocSubmissionId, force })
 *     If localStorage["pioneer.dcr.draft.v1"] is present and parseable,
 *     move it into the IDB drafts store keyed by a fresh submission_id,
 *     then delete the localStorage key. Idempotent — running twice does
 *     not produce two IDB rows because the legacy key is removed on
 *     success.
 *
 *   Returns:
 *     { migrated: true,  submission_id, draft }  on first successful run
 *     { migrated: false, reason: "..." }         on no-op (no legacy key,
 *                                                  unparseable JSON, or
 *                                                  already migrated)
 *
 * Why this exists:
 *   The production hotfix (2026-06-18) keeps the legacy localStorage draft
 *   so reload preserves field data. When Phase 31 ships, every tech device
 *   may have one stale localStorage draft from before the upgrade. We must
 *   not drop it. The migration runs once per device on first Phase 31 boot
 *   and is a no-op forever after.
 *
 * Why a fresh submission_id:
 *   The legacy draft predates client-generated submission_id allocation
 *   (which moved to Submit-click time, not draft-save time). Generating a
 *   new UUIDv4 here matches the post-Phase 31 invariant: every draft row
 *   has a stable submission_id from the moment of first save.
 */

(function () {
  "use strict";

  const LEGACY_KEY = "pioneer.dcr.draft.v1";

  function defaultAllocSubmissionId() {
    // UUIDv4 if available, fall back to the same shape app.js
    // newSubmissionId() uses so the format stays consistent in older
    // browsers (the timestamp + random suffix shape).
    if (self.crypto && self.crypto.randomUUID) {
      try { return self.crypto.randomUUID(); } catch (_e) {}
    }
    const ts  = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return ts + "-" + rnd;
  }

  async function migrateLegacyDraftIfPresent(opts) {
    opts = opts || {};
    const DB = self.PIONEER_QUEUE_DB;
    if (!DB) throw new Error("queue-db.js not loaded");

    let raw = null;
    try { raw = localStorage.getItem(LEGACY_KEY); }
    catch (_e) { return { migrated: false, reason: "localStorage unavailable" }; }

    if (!raw) return { migrated: false, reason: "no legacy draft present" };

    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (_e) {
      // Garbage on disk — don't crash. Clear the bad value so it doesn't
      // re-trigger this path forever.
      try { localStorage.removeItem(LEGACY_KEY); } catch (__e) {}
      return { migrated: false, reason: "legacy draft unparseable; removed" };
    }
    if (!parsed || typeof parsed !== "object") {
      try { localStorage.removeItem(LEGACY_KEY); } catch (__e) {}
      return { migrated: false, reason: "legacy draft not an object; removed" };
    }

    const submissionId = (opts.allocSubmissionId || defaultAllocSubmissionId)();

    // Wrap the parsed legacy blob in a Phase-31 draft envelope. We keep
    // the entire original payload under `legacy_payload` so the form
    // restore path can do its own field-by-field hydration without
    // guessing at field names from this migration code (the legacy
    // schema includes form_data, segState, checklistState,
    // checklistNotes, pendingFilesMeta, etc. — fields owned by app.js,
    // not by the queue).
    const draftRow = {
      submission_id:   submissionId,
      source:          "legacy-migration",
      migrated_at:     Date.now(),
      legacy_payload:  parsed,
      // Pull common high-signal fields up to the top level for diagnostic
      // queries; the form restore path should still read from
      // legacy_payload.* as the source of truth.
      customer_slug:   parsed.customer_slug    || parsed.customer || null,
      tech_slug:       parsed.tech_slug        || parsed.tech     || null,
      created_at:      parsed.created_at       || Date.now(),
      updated_at:      Date.now()
    };

    await DB.saveDraft(draftRow);
    try { localStorage.removeItem(LEGACY_KEY); } catch (_e) {}
    return { migrated: true, submission_id: submissionId, draft: draftRow };
  }

  function readLegacyDraftRaw() {
    try { return localStorage.getItem(LEGACY_KEY); }
    catch (_e) { return null; }
  }

  self.PIONEER_QUEUE_MIGRATION = {
    migrateLegacyDraftIfPresent: migrateLegacyDraftIfPresent,
    readLegacyDraftRaw:          readLegacyDraftRaw,
    LEGACY_KEY:                  LEGACY_KEY
  };
}());
