/* Pioneer DCR Hub — Phase 31 prototype: submitDcrV1 idempotency patch (DRAFT).
 *
 * STATUS: DRAFT. NOT exported from functions/index.js. Lives under
 * functions/_drafts/ so it can't be picked up by Cloud Functions deploy
 * (the firebase functions deploy walks the exports surface, not the file
 * tree). Review here; integrate later behind a feature flag.
 *
 * WHAT THIS PATCH ADDS:
 *   Today (post-2026-06-18 hotfix) submitDcrV1 uses `submission_id` as
 *   the doc ID and does `.set(doc, { merge: false })`. That makes the
 *   FIRESTORE WRITE idempotent — the dcr_submissions doc itself does
 *   not duplicate. But the rest of the handler is not gated:
 *
 *     1. The native DCR email (dcrEmail.sendNativeDcrEmailForSubmission
 *        ~line 3257) fires every call.
 *     2. The Zapier webhook (downstream of the doc write) fires every call.
 *     3. createDcrIssuesForSubmission writes per-issue docs with
 *        deterministic IDs — already safe (existing comment confirms).
 *     4. PioneerOps work_sessions writeback (line ~3076) re-stamps the
 *        session status. Idempotent in shape but creates audit noise.
 *     5. pioneer_service_sessions writeback (line ~3207) same shape.
 *     6. maybeCreateSupplyRequest is documented as idempotent on
 *        submission_id — already safe.
 *
 *   The single highest-impact integrity issue is (1) — a duplicate email
 *   to the customer if Phase 31's queue-worker retries a submission_id
 *   that was previously accepted but whose 200 response was lost mid-flight.
 *
 *   This patch adds a single Firestore read at the top of the handler
 *   (after auth + validation, before any writes or sends) and returns a
 *   cached receipt when a prior submission with the same submission_id
 *   already exists.
 *
 * MIGRATION SAFETY:
 *   - Backward-compatible with the current web client (no schema change
 *     visible to the client; same response shape with one new optional
 *     field: `already_submitted: true`).
 *   - Backward-compatible with pre-Phase-31 clients that never retry —
 *     the new code path is only entered when a prior doc exists, which
 *     pre-Phase-31 clients never created by retrying.
 *   - No write here. Pure read. Safe to ship without a flag.
 *
 * INTEGRATION PLAN:
 *   1. Open functions/index.js, find the block:
 *        const submissionId = payload.submission_id;
 *        const doc = { ...payload, submission_id: submissionId, ... };
 *      (around line 3014 as of 2026-06-18).
 *   2. Insert this module's `enforceIdempotency` call BEFORE that block:
 *        const cached = await enforceIdempotency({ db, admin, logger,
 *          collection: FIRESTORE_COLLECTION, submissionId, staff });
 *        if (cached) return res.status(200).json(cached);
 *   3. Wire `dcrEmail.markIdempotencyReplay()` if we later add a side-
 *      effect telemetry counter (not in v1).
 *
 * TESTING:
 *   - public/queue/queue-test.html includes an "Idempotency check"
 *     button that exercises this contract against FAKE_SUBMIT, which
 *     mirrors the read-first-then-write behavior below.
 *   - For the real backend, ship behind a temporary env flag in a preview
 *     channel, fire two POSTs with the same submission_id via curl, and
 *     verify exactly one customer email lands in Gmail Sent.
 */

"use strict";

/**
 * enforceIdempotency
 *
 * Reads dcr_submissions/{submissionId}. If it exists, returns the cached
 * receipt payload that the original handler would have returned, augmented
 * with `already_submitted: true`. Returns null when no prior doc exists
 * (caller proceeds with the normal write path).
 *
 * Pure read — never throws on missing doc, never writes.
 *
 * @param {Object} args
 * @param {Object} args.db          Firestore handle (admin.firestore())
 * @param {Object} args.admin       admin SDK module (for FieldValue, if needed later)
 * @param {Object} args.logger      Cloud Functions logger
 * @param {string} args.collection  Collection name (FIRESTORE_COLLECTION)
 * @param {string} args.submissionId  Client-supplied submission_id
 * @param {Object} args.staff       { uid, email, role } from the verified ID token
 * @returns {Promise<Object|null>}  Cached receipt payload to send to the client, or null.
 */
async function enforceIdempotency(args) {
  const db           = args.db;
  const logger       = args.logger || console;
  const collection   = args.collection;
  const submissionId = args.submissionId;
  const staff        = args.staff || {};

  if (!submissionId) return null;
  if (!collection)   return null;

  let snap = null;
  try {
    snap = await db.collection(collection).doc(submissionId).get();
  } catch (err) {
    // Hard fail on Firestore read is unusual. Log + fall through to the
    // normal write path so we never block a legitimate first-submission.
    logger.warn("submitDcrV1 idempotency read failed (proceeding with write)", {
      submission_id: submissionId,
      error: err && err.message
    });
    return null;
  }

  if (!snap || !snap.exists) return null;

  const cached = snap.data() || {};

  // Defensive: if the cached doc was written by a DIFFERENT staff member
  // (extremely unlikely — submission_id is client-generated UUIDv4 — but
  // possible with collisions or malicious replay), refuse to confirm the
  // replay and let the write path proceed (which will overwrite — same
  // behavior as today). Log the anomaly for audit.
  if (cached.submitted_by_uid && staff.uid && cached.submitted_by_uid !== staff.uid) {
    logger.warn("submitDcrV1 idempotency: submission_id reuse across staff", {
      submission_id:        submissionId,
      cached_submitted_by:  cached.submitted_by_uid,
      replay_submitted_by:  staff.uid
    });
    return null;
  }

  logger.info("submitDcrV1 idempotency hit — returning cached receipt", {
    submission_id: submissionId,
    cached_submitted_at: cached.created_at && cached.created_at.toMillis && cached.created_at.toMillis(),
    staff_uid: staff.uid
  });

  // Compose the receipt the original handler would have returned. We
  // include the fields the client reads (`onSuccess` in app.js reads
  // body.submission_id + body.zapier + body.feedback + body.email).
  return {
    ok:               true,
    already_submitted: true,
    submission_id:    submissionId,
    customer_slug:    cached.customer_slug || null,
    email:            cached.native_email || cached.email || { status: "previously_sent" },
    zapier:           cached.zapier || { attempted: false, status: "previously_handled" },
    feedback:         cached.feedback || null,
    submitted_at_iso: cached.created_at && cached.created_at.toDate
                        ? cached.created_at.toDate().toISOString() : null
  };
}

/**
 * INTEGRATION DIFF — for human review, not auto-applied.
 *
 * In functions/index.js, the current shape (post-2026-06-18 hotfix) is:
 *
 *    // ~ line 3014
 *    const submissionId = payload.submission_id;
 *    const doc = { ...payload, ... };
 *    ...
 *    await db.collection(FIRESTORE_COLLECTION).doc(submissionId).set(doc, { merge: false });
 *    ...
 *    await maybeCreateSupplyRequest(doc, submissionId);
 *    let nativeEmailResult = ...
 *    await dcrEmail.sendNativeDcrEmailForSubmission({...});
 *    ...
 *    return res.status(200).json({ ok: true, submission_id: submissionId, ... });
 *
 * The patch adds, immediately before `const doc = {...}`:
 *
 *    const cachedReceipt = await enforceIdempotency({
 *      db, admin, logger,
 *      collection: FIRESTORE_COLLECTION,
 *      submissionId, staff
 *    });
 *    if (cachedReceipt) {
 *      return res.status(200).json(cachedReceipt);
 *    }
 *
 * That single insert is the entire integration. Nothing else changes in
 * the handler. The native email block, Zapier block, work_sessions block,
 * service_sessions block, and dcr_issues block all stay where they are
 * — they simply never run on a replay.
 *
 * SUGGESTED PR TITLE:
 *   feat(submitDcrV1): idempotent replay handling for Phase 31 queue
 *
 * SUGGESTED COMMIT BODY:
 *   - Adds early-exit when dcr_submissions/{submission_id} already exists.
 *   - Returns cached receipt so the Phase 31 queue worker can safely retry
 *     after a mid-flight 200 loss.
 *   - No schema change. No client change. No email/Zapier behavior change
 *     on first-submission path.
 */

module.exports = {
  enforceIdempotency: enforceIdempotency
};
