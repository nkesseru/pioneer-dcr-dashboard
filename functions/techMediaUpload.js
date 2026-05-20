/* ============================================================================
 * techMediaUpload.js — admin-only tech photo / signature manager backend
 *
 * One endpoint (uploadTechMediaV1) that covers four operations against a
 * cleaning_techs/{techId} doc:
 *
 *   1. Upload a new photo            — kind="photo",     base64=<data>
 *   2. Upload a new signature        — kind="signature", base64=<data>
 *   3. Clear the photo               — kind="photo",     clear=true
 *   4. Clear the signature           — kind="signature", clear=true
 *   5. Flip active / inactive        — action="setActive", active=<bool>
 *
 * All ops are admin-only (staff.isAdmin === true). Failures return
 * structured JSON the admin UI can surface inline. The function never
 * leaves the cleaning_techs doc in a half-updated state — Storage
 * uploads come first and only succeed-and-mint-URL paths reach the
 * Firestore update.
 *
 * Storage paths (per the spec):
 *   tech-photos/{techId}/{timestamp}-{filename}
 *   tech-signatures/{techId}/{timestamp}-{filename}
 *
 * Fields written on the cleaning_techs doc (per the spec):
 *   photoUrl              — long-lived Firebase download URL
 *   profilePhotoUrl       — mirror of photoUrl (DCR renderer reads both)
 *   photoStoragePath      — `tech-photos/{techId}/{ts}-{name}`
 *   photoUpdatedAt        — serverTimestamp
 *   signatureUrl          — long-lived Firebase download URL
 *   signatureStoragePath  — `tech-signatures/{techId}/{ts}-{name}`
 *   signatureUpdatedAt    — serverTimestamp
 *
 * On clear: the four fields for that kind are wiped (null + serverTs on
 * the *UpdatedAt) and the Storage object is deleted best-effort. We do
 * NOT scrub history (older timestamped uploads remain in Storage) —
 * that's a follow-up if/when the bucket size ever matters.
 * ========================================================================== */

'use strict';

const crypto = require('crypto');

const STORAGE_BUCKET = "pioneer-dcr-hub.firebasestorage.app";

const MAX_PHOTO_BYTES     = 5 * 1024 * 1024;   // 5 MB per the customer-facing trust promise
const MAX_SIGNATURE_BYTES = 1 * 1024 * 1024;   // 1 MB — signatures are tiny PNG/JPEG strokes

const VALID_PHOTO_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
]);
const VALID_SIGNATURE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp'
]);

// Strip optional `data:image/...;base64,` prefix and decode. Returns
// null on any failure so callers can soft-fail cleanly.
function decodeBase64Image(input) {
  if (typeof input !== 'string') return null;
  let raw = input;
  const commaIdx = raw.indexOf(',');
  if (raw.startsWith('data:') && commaIdx > 0) raw = raw.slice(commaIdx + 1);
  try {
    const buf = Buffer.from(raw, 'base64');
    if (!buf || buf.length === 0) return null;
    return buf;
  } catch (_e) { return null; }
}

// Sanitise a user-supplied filename: keep extension, drop everything
// else that isn't alphanumeric/underscore/dot/dash. Cap at 80 chars so
// the storage path stays bounded.
function safeFilename(input, fallbackExt) {
  let name = String(input || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  if (!name) name = 'upload';
  // If no extension in the name, append the fallback derived from MIME.
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name) && fallbackExt) {
    name = name + '.' + fallbackExt;
  }
  return name;
}

function mimeToExt(mime) {
  if (!mime) return 'jpg';
  if (/heic/i.test(mime)) return 'heic';
  if (/heif/i.test(mime)) return 'heif';
  if (/png/i.test(mime))  return 'png';
  if (/webp/i.test(mime)) return 'webp';
  return 'jpg';
}

function buildFirebaseTokenUrl(storagePath, token) {
  return 'https://firebasestorage.googleapis.com/v0/b/' + STORAGE_BUCKET +
         '/o/' + encodeURIComponent(storagePath) +
         '?alt=media&token=' + token;
}

async function uploadOne(bucket, storagePath, buffer, contentType) {
  const token = crypto.randomUUID();
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    resumable:   false,
    contentType: contentType,
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: {
        // Firebase Storage download-token URL pattern. The token in
        // object metadata is the auth side of the URL; revoking it
        // invalidates the URL without changing object ACLs.
        firebaseStorageDownloadTokens: token
      }
    }
  });
  return { storagePath: storagePath, url: buildFirebaseTokenUrl(storagePath, token) };
}

// Best-effort delete — used during the "clear" path. We swallow the
// error if the object doesn't exist; that's the desired idempotent
// behavior (e.g. a tech without any prior upload still resolves the
// clear request cleanly).
async function deleteIfExists(bucket, storagePath, logger) {
  if (!storagePath) return;
  try {
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
  } catch (e) {
    logger && logger.warn('[tech-media] storage delete soft-failed', {
      storagePath: storagePath, error: e.message
    });
  }
}

function buildHttpHandler(deps) {
  const { admin, db, logger, verifyStaffOrReject } = deps;

  return async function uploadTechMediaV1(req, res) {
    res.set('Access-Control-Allow-Origin',  '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age',       '3600');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'POST only' });
      return;
    }

    // Admin gate — same pattern every other admin function uses.
    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (!staff.isAdmin) {
      res.status(403).json({ ok: false, error: 'Admin only' });
      return;
    }

    const body = req.body || {};
    const techId = String(body.techId || '').trim();
    if (!techId) {
      res.status(400).json({ ok: false, error: 'techId is required' });
      return;
    }

    const techRef  = db.collection('cleaning_techs').doc(techId);
    const techSnap = await techRef.get();
    if (!techSnap.exists) {
      res.status(404).json({ ok: false, error: 'tech not found', techId: techId });
      return;
    }
    const existing = techSnap.data() || {};

    // ---- setActive branch (no upload, just a boolean flip) ----
    // Stored on the doc as `active`. The seed data uses `active: true`
    // by default; this just toggles it. Distinct from the existing
    // edit-tech modal's "Archive/Reactivate" so the media manager can
    // do everything in one place.
    if (body.action === 'setActive') {
      const next = body.active === true || body.active === 'true';
      try {
        await techRef.update({
          active:        next,
          activeUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        logger.error('[tech-media] setActive failed', { techId, error: e.message });
        res.status(500).json({ ok: false, error: e.message });
        return;
      }
      logger.info('[tech-media] active flipped', { techId, active: next });
      res.json({ ok: true, action: 'setActive', techId: techId, active: next });
      return;
    }

    const kind  = String(body.kind || '').trim().toLowerCase();
    const clear = body.clear === true || body.clear === 'true';

    if (kind !== 'photo' && kind !== 'signature') {
      res.status(400).json({ ok: false, error: 'kind must be "photo" or "signature"' });
      return;
    }

    const bucket = admin.storage().bucket(STORAGE_BUCKET);

    // ---- clear branch ----
    // Wipes the URL + storage-path fields and best-effort deletes the
    // currently-pointed-at object in Storage. Idempotent — calling
    // clear on a tech with no prior media succeeds quietly.
    if (clear) {
      const targetField = (kind === 'photo') ? 'photoStoragePath' : 'signatureStoragePath';
      await deleteIfExists(bucket, existing[targetField], logger);

      const update = (kind === 'photo')
        ? {
            photoUrl:          null,
            profilePhotoUrl:   null,
            photoStoragePath:  null,
            photoUpdatedAt:    admin.firestore.FieldValue.serverTimestamp()
          }
        : {
            signatureUrl:         null,
            signatureStoragePath: null,
            signatureUpdatedAt:   admin.firestore.FieldValue.serverTimestamp()
          };

      try {
        await techRef.update(update);
      } catch (e) {
        logger.error('[tech-media] clear update failed', { techId, kind, error: e.message });
        res.status(500).json({ ok: false, error: e.message });
        return;
      }
      logger.info('[tech-media] cleared', { techId, kind });
      res.json({ ok: true, action: 'clear', techId: techId, kind: kind });
      return;
    }

    // ---- upload branch ----
    const contentType = String(body.contentType || '').trim().toLowerCase();
    const validMime   = (kind === 'photo') ? VALID_PHOTO_MIME : VALID_SIGNATURE_MIME;
    const maxBytes    = (kind === 'photo') ? MAX_PHOTO_BYTES   : MAX_SIGNATURE_BYTES;

    if (!validMime.has(contentType)) {
      res.status(400).json({
        ok: false,
        error: 'unsupported contentType for ' + kind +
               ' (allowed: ' + Array.from(validMime).join(', ') + ')'
      });
      return;
    }
    const buf = decodeBase64Image(body.base64);
    if (!buf) {
      res.status(400).json({ ok: false, error: 'base64 missing or undecodable' });
      return;
    }
    if (buf.length > maxBytes) {
      res.status(400).json({
        ok: false,
        error: kind + ' exceeds ' + Math.round(maxBytes / 1024) + 'KB limit',
        size_kb: Math.round(buf.length / 1024)
      });
      return;
    }

    const ext        = mimeToExt(contentType);
    const filename   = safeFilename(body.filename, ext);
    const ts         = Date.now();
    const prefix     = (kind === 'photo') ? 'tech-photos' : 'tech-signatures';
    const storagePath = prefix + '/' + techId + '/' + ts + '-' + filename;

    let uploadResult;
    try {
      uploadResult = await uploadOne(bucket, storagePath, buf, contentType);
    } catch (e) {
      logger.error('[tech-media] storage upload failed', {
        techId, kind, storagePath, error: e.message
      });
      res.status(500).json({ ok: false, error: 'storage upload failed: ' + e.message });
      return;
    }

    // Best-effort delete of the previously-pointed-at object so the
    // bucket doesn't accumulate orphan blobs from repeated re-uploads.
    // Timestamped paths mean every successful upload would otherwise
    // pile up next to its predecessor.
    const previousPathField = (kind === 'photo') ? 'photoStoragePath' : 'signatureStoragePath';
    if (existing[previousPathField] && existing[previousPathField] !== storagePath) {
      await deleteIfExists(bucket, existing[previousPathField], logger);
    }

    const update = (kind === 'photo')
      ? {
          photoUrl:          uploadResult.url,
          profilePhotoUrl:   uploadResult.url,
          photoStoragePath:  storagePath,
          photoContentType:  contentType,
          photoSizeBytes:    buf.length,
          photoUpdatedAt:    admin.firestore.FieldValue.serverTimestamp()
        }
      : {
          signatureUrl:         uploadResult.url,
          signatureStoragePath: storagePath,
          signatureContentType: contentType,
          signatureSizeBytes:   buf.length,
          signatureUpdatedAt:   admin.firestore.FieldValue.serverTimestamp()
        };

    try {
      await techRef.update(update);
    } catch (e) {
      logger.error('[tech-media] firestore update failed (storage already wrote)', {
        techId, kind, storagePath, error: e.message
      });
      // Storage object exists but Firestore didn't update — leave the
      // object in place (idempotent retry will overwrite next time)
      // and surface the error.
      res.status(500).json({ ok: false, error: e.message });
      return;
    }

    logger.info('[tech-media] uploaded', {
      techId, kind, storagePath, size: buf.length, contentType
    });
    res.json({
      ok:           true,
      action:       'upload',
      techId:       techId,
      kind:         kind,
      url:          uploadResult.url,
      storagePath:  storagePath,
      size:         buf.length
    });
  };
}

module.exports = {
  buildHttpHandler:       buildHttpHandler,
  buildFirebaseTokenUrl:  buildFirebaseTokenUrl,
  decodeBase64Image:      decodeBase64Image
};
