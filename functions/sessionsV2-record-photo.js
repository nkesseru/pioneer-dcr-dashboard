/* sessionsV2-record-photo.js — Phase 36c (Operation One Truth Rule 2).
 *
 * Session owns photos. Each photo is authored into the Session at upload
 * time, not at DCR submit time. This module is the canonical write path
 * for "tech uploaded a photo" → Session.
 *
 * Used by:
 *   - functions/techMediaUpload.js (production path; called after GCS
 *     finalize succeeds; fire-and-forget)
 *   - exports.recordSessionPhotoV1 in functions/index.js (HTTP wrapper
 *     for canary harness)
 *
 * Constitution alignment:
 *   - Rule 2 — Session owns reality (photos)
 *   - Rule 4 — no new V1 dependency
 *   - Rule 7 — no new collection; embedded items[] array
 *   - Rule 8 — components.photos has its own state machine
 *   - Rule 9 — every upload emits a Timeline event
 *   - Rule 10 — flag-gated; reversible
 *
 * Idempotency:
 *   photo_id is the natural key. Re-call with the same photo_id is a
 *   no-op (predicate: items[].some(p => p.photo_id === photoId)).
 *   Firestore transaction reads items[], checks, and only writes if
 *   the photo_id is new.
 *
 * Flag-gate:
 *   sessionsV2_isEnabled() — false on prod → skip silently with
 *   reason="flag_off". No Firestore read, no write.
 *
 * Failure modes (none throw):
 *   - flag_off              → expected; skip silently
 *   - session_id_invalid    → bad input from caller; skip
 *   - v2_missing            → V2 session doesn't exist yet; skip
 *                             (will catch up on next DCR submit via
 *                             onDcrSubmissionCreatedV36b trigger)
 *   - already_recorded      → photo_id already in items[]; idempotent skip
 *   - transaction_failed    → log + return failed; caller decides what to do
 */

"use strict";

const SESSIONSV2_ID_RE = /^sess_(manual_[A-Za-z0-9-]+_\d{4}-\d{2}-\d{2}_[a-z0-9-]+_a\d+|recover_sess_[A-Za-z0-9_-]+_a\d+|[A-Za-z0-9-]+_\d{4}-\d{2}-\d{2}_a\d+)$/;

// Pure: does items[] already contain a photo with this photo_id?
function isPhotoAlreadyRecorded(itemsArray, photoId) {
  if (!Array.isArray(itemsArray)) return false;
  if (!photoId) return false;
  for (let i = 0; i < itemsArray.length; i++) {
    const it = itemsArray[i];
    if (it && it.photo_id === photoId) return true;
  }
  return false;
}

// Pure: build a PhotoEntry shape from inputs. Returns the entry or null
// if required inputs are missing. Defensive — caller can rely on shape.
function buildPhotoEntry(args, uploadedAtTs) {
  if (!args) return null;
  const photoId = String(args.photoId || "").trim();
  const gcsPath = String(args.gcsPath || "").trim();
  if (!photoId || !gcsPath) return null;
  return {
    photo_id:          photoId,
    gcs_path:          gcsPath,
    uploaded_at:       uploadedAtTs,
    uploaded_by_uid:   args.uploadedByUid   ? String(args.uploadedByUid)               : null,
    uploaded_by_email: args.uploadedByEmail ? String(args.uploadedByEmail).toLowerCase() : null,
    position:          (typeof args.position === "number" && args.position >= 1)
                         ? Math.round(args.position) : null,
    mime_type:         args.mimeType  ? String(args.mimeType)  : null,
    size_bytes:        (typeof args.sizeBytes === "number" && args.sizeBytes >= 0)
                         ? Math.round(args.sizeBytes) : null,
    status:            "uploaded"
  };
}

// Pure: compute the components.photos status after this photo arrives.
// Phase 36c lifecycle (per Constitution Rule 8):
//   missing       → collecting   (first upload)
//   collecting    → collecting   (subsequent uploads; status unchanged)
//   not_applicable, complete, failed, replaced → unchanged
//     (collecting can be reached again only via explicit reset by an
//      admin/recovery path; that's outside Phase 36c.)
function nextPhotosStatus(currentStatus) {
  if (currentStatus === "missing" || !currentStatus) return "collecting";
  return currentStatus;
}

// Pure: build the Timeline entry for photo.uploaded.
function buildPhotoTimelineEntry(args, photoEntry, jsTimestampNow) {
  return {
    ts:         jsTimestampNow,
    intent_ts:  null,
    actor:      {
      type:  "tech",
      uid:   photoEntry.uploaded_by_uid   || null,
      email: photoEntry.uploaded_by_email || null,
      name:  null
    },
    event:      "photo.uploaded",
    title:      "Photo uploaded",
    detail:     null,
    icon:       "photo-upload",
    field_path: "components.photos.items",
    from:       null,
    to:         photoEntry.photo_id,
    ref:        photoEntry.photo_id,
    client:     {
      app_version: "recordSessionPhotoV1",
      platform:    args && args.platform ? String(args.platform) : null
    }
  };
}

// Pure: snapshot of how the helper would interpret its inputs without
// touching Firestore. Used by unit tests + canary diagnostics.
function classifyRecordPhotoInput(args) {
  if (!args)                                  return { ok: false, reason: "no_args" };
  if (!args.sessionId)                        return { ok: false, reason: "no_session_id" };
  if (!SESSIONSV2_ID_RE.test(args.sessionId)) return { ok: false, reason: "session_id_invalid" };
  if (!args.photoId)                          return { ok: false, reason: "no_photo_id" };
  if (!args.gcsPath)                          return { ok: false, reason: "no_gcs_path" };
  return { ok: true };
}

/* ---------- main I/O entry point ---------- */

// recordSessionPhoto — write a single photo entry into the Session.
// Returns { status, reason?, photo_id?, items_count_after? }.
// NEVER throws. Caller's caller can fire-and-forget.
//
// args: {
//   db, admin, logger,
//   sessionsV2_isEnabled: () => boolean,
//   sessionId, photoId, gcsPath,
//   uploadedByUid, uploadedByEmail,
//   position, mimeType, sizeBytes,
//   platform                      // optional, for client metadata
// }
async function recordSessionPhoto(args) {
  const logger = (args && args.logger) || { info: () => {}, warn: () => {} };
  try {
    // Flag gate.
    const isEnabled = (args && typeof args.sessionsV2_isEnabled === "function")
                        ? args.sessionsV2_isEnabled()
                        : false;
    if (!isEnabled) {
      return { status: "skipped", reason: "flag_off" };
    }

    // Input classification.
    const cls = classifyRecordPhotoInput(args);
    if (!cls.ok) {
      logger.warn("recordSessionPhoto: bad input", { reason: cls.reason });
      return { status: "skipped", reason: cls.reason };
    }

    const db    = args.db;
    const admin = args.admin;
    const sessRef = db.collection("sessionsV2").doc(args.sessionId);

    let outcome = { status: "skipped", reason: "transaction_did_not_run" };

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(sessRef);
      if (!snap.exists) {
        outcome = { status: "skipped", reason: "v2_missing",
                    session_id: args.sessionId };
        return;
      }
      const data       = snap.data() || {};
      const components = (data.components && typeof data.components === "object")
                           ? data.components : {};
      const photosCmp  = (components.photos && typeof components.photos === "object")
                           ? components.photos : {};
      const itemsNow   = Array.isArray(photosCmp.items) ? photosCmp.items : [];

      // Idempotency.
      if (isPhotoAlreadyRecorded(itemsNow, args.photoId)) {
        outcome = {
          status:            "skipped",
          reason:            "already_recorded",
          session_id:        args.sessionId,
          photo_id:          args.photoId,
          items_count_after: itemsNow.length
        };
        return;
      }

      const sts        = admin.firestore.FieldValue.serverTimestamp();
      const nowJs      = admin.firestore.Timestamp.now();
      const photoEntry = buildPhotoEntry(args, nowJs);
      const tlEntry    = buildPhotoTimelineEntry(args, photoEntry, nowJs);
      const newCount   = itemsNow.length + 1;
      const newStatus  = nextPhotosStatus(photosCmp.status);

      const update = {
        "components.photos.items":         admin.firestore.FieldValue.arrayUnion(photoEntry),
        "components.photos.status":        newStatus,
        "components.photos.count":         newCount,
        "components.photos.last_event":    "photo.uploaded",
        "components.photos.last_event_at": sts,
        timeline:                          admin.firestore.FieldValue.arrayUnion(tlEntry),
        updated_at:                        sts
      };
      if (!photosCmp.started_at || photosCmp.status === "missing" || !photosCmp.status) {
        update["components.photos.started_at"] = sts;
      }
      // Reserve primary_photo_id field shape (Phase 36c does NOT set it).
      // We touch it ONLY on first-ever upload to ensure the field exists
      // as `null` (Firestore otherwise leaves the field absent). Safe:
      // subsequent uploads do not overwrite an already-set value because
      // we only write when itemsNow.length === 0.
      if (itemsNow.length === 0 && photosCmp.primary_photo_id === undefined) {
        update["components.photos.primary_photo_id"] = null;
      }

      txn.update(sessRef, update);

      outcome = {
        status:            "ok",
        session_id:        args.sessionId,
        photo_id:          args.photoId,
        items_count_after: newCount,
        status_after:      newStatus
      };
    });

    if (outcome.status === "ok") {
      logger.info("recordSessionPhoto: recorded", outcome);
    } else if (outcome.status === "skipped" && outcome.reason !== "flag_off") {
      logger.info("recordSessionPhoto: skipped", outcome);
    }
    return outcome;
  } catch (err) {
    try {
      logger.warn("recordSessionPhoto: threw (swallowed)", {
        error: err && err.message,
        stack: err && err.stack
      });
    } catch (_e) {}
    return { status: "failed", reason: "exception",
             error: (err && err.message) || "unknown" };
  }
}

module.exports = {
  // I/O entry point
  recordSessionPhoto:        recordSessionPhoto,
  // Pure helpers (testable + canary-inspectable)
  isPhotoAlreadyRecorded:    isPhotoAlreadyRecorded,
  buildPhotoEntry:           buildPhotoEntry,
  nextPhotosStatus:          nextPhotosStatus,
  buildPhotoTimelineEntry:   buildPhotoTimelineEntry,
  classifyRecordPhotoInput:  classifyRecordPhotoInput,
  // ID regex re-exported for caller's pre-validation if desired
  SESSIONSV2_ID_RE:          SESSIONSV2_ID_RE
};
