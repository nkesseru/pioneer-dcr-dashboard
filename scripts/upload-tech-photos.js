#!/usr/bin/env node
/* ============================================================================
 * upload-tech-photos.js
 *
 * Upload local tech-photo JPGs in `assets/tech-photos/` to Firebase Storage
 * (under `tech-photos/`) and stamp the matching `cleaning_techs` Firestore
 * docs with the resulting long-lived download URL.
 *
 * The DCR email renderer reads tech-photo URLs from the cleaning_techs doc
 * via a multi-field coalesce list that includes `photoUrl` and
 * `profilePhotoUrl` — so once this script runs, the next DCR email send
 * resolves a real photo instead of the initials bubble.
 *
 * Credentials:
 *   Tries Application Default Credentials first (gcloud auth
 *   application-default login). Falls back to a `serviceAccountKey.json`
 *   file at the project root. The fallback key file is .gitignored
 *   (.gitignore already protects `serviceAccountKey.json`,
 *   `service-account*.json`, and `firebase-adminsdk*.json`). Neither
 *   credential is read inline in this script.
 *
 * Long-lived URLs:
 *   Uses the Firebase Storage download-token URL shape
 *   (`?alt=media&token=<uuid>`). The token is stored as object metadata
 *   so the URL stays valid indefinitely unless explicitly revoked. This
 *   is what `getDownloadURL()` returns in the client SDK and is the
 *   right shape for email rendering — no expiration, no per-render
 *   signing cost.
 *
 * Usage:
 *   DRY_RUN=true node scripts/upload-tech-photos.js   # default: dry-run
 *   DRY_RUN=false node scripts/upload-tech-photos.js  # actually upload + stamp
 *
 * Safety:
 *   Refuses to write unless DRY_RUN=false is explicitly set.
 *   Never creates new cleaning_techs docs — only updates existing ones.
 *   Unmatched files are logged clearly so the operator can investigate.
 * ========================================================================== */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
let admin    = require('firebase-admin');

// ---- Config ----------------------------------------------------------------
const PROJECT_ID     = 'pioneer-dcr-hub';
const STORAGE_BUCKET = 'pioneer-dcr-hub.firebasestorage.app';
const COLLECTION     = 'cleaning_techs';
const SOURCE_DIR     = path.resolve(__dirname, '..', 'assets', 'tech-photos');
const STORAGE_PREFIX = 'tech-photos';

const DRY_RUN = process.env.DRY_RUN !== 'false';   // default: true

// ---- Init Admin SDK --------------------------------------------------------
// Prefer the local serviceAccountKey.json when present (it's .gitignored
// and is how every other admin script in this repo authenticates). Fall
// back to Application Default Credentials only when the key file isn't
// available — that path covers operators who've already run
// `gcloud auth application-default login` and don't have a key on disk.
//
// Note: admin.initializeApp() does NOT actually authenticate; auth
// happens lazily on the first Firestore/Storage call. So a try/catch
// around initializeApp can't detect ADC failure — we have to choose the
// right credential up front, by file existence.
if (!admin.apps.length) {
  const keyPath = path.resolve(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    admin.initializeApp({
      credential:    admin.credential.cert(require(keyPath)),
      projectId:     PROJECT_ID,
      storageBucket: STORAGE_BUCKET
    });
  } else {
    admin.initializeApp({
      credential:    admin.credential.applicationDefault(),
      projectId:     PROJECT_ID,
      storageBucket: STORAGE_BUCKET
    });
  }
}

// Hard safety check: refuse to run against any other project.
if (admin.app().options.projectId &&
    admin.app().options.projectId !== PROJECT_ID) {
  console.error('[upload-tech-photos] refusing to run against project',
                admin.app().options.projectId,
                '— expected', PROJECT_ID);
  process.exit(2);
}

const db     = admin.firestore();
const bucket = admin.storage().bucket();

// ---- Helpers ---------------------------------------------------------------

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

// Derive plausible match tokens from a filename like "kiana-l.jpg":
//   - the full basename without extension (e.g. "kiana-l")
//   - the basename with hyphens replaced by spaces ("kiana l")
//   - the first word only ("kiana")
// Returned in priority order; the matcher tries them in turn.
function deriveCandidates(filename) {
  const base = path.basename(filename, path.extname(filename)).toLowerCase();
  const spaced    = base.replace(/[-_]+/g, ' ').trim();
  const firstWord = base.split(/[-_\s]+/)[0];
  return Array.from(new Set([base, spaced, firstWord]));
}

// Try to find a cleaning_techs doc that matches a filename. Searches:
//   1. Exact match on doc.id (which is `tech_slug` in this codebase).
//   2. doc.id starts with the filename basename ("april" → "april-k").
//   3. doc.id starts with the first word.
//   4. Field-by-field equality against the candidate set, using both
//      the spec's listed field names (displayName, name, fullName,
//      firstName, first_name) AND the actual schema field
//      (display_name). First-word match on the FIRST word of
//      display_name catches "Drew C." → "drew.jpg".
//
// Returns { doc, matchedOn } | null. matchedOn is a human label for
// the per-row log line.
function findTechMatch(snap, filename) {
  const candidates = deriveCandidates(filename);
  const base       = candidates[0];
  const firstWord  = candidates[candidates.length - 1];

  // Pass 1 — exact doc id.
  for (const doc of snap.docs) {
    if (normalize(doc.id) === base) {
      return { doc: doc, matchedOn: 'doc.id == "' + base + '"' };
    }
  }
  // Pass 2 — doc id starts with the basename (e.g. "april" → "april-k").
  // Skip when the basename is the whole id (already caught above).
  for (const doc of snap.docs) {
    const id = normalize(doc.id);
    if (id !== base && id.startsWith(base + '-')) {
      return { doc: doc, matchedOn: 'doc.id startsWith "' + base + '-"' };
    }
  }
  // Pass 3 — doc id starts with the first word.
  for (const doc of snap.docs) {
    const id = normalize(doc.id);
    if (id !== base && firstWord && firstWord !== base &&
        id.startsWith(firstWord + '-')) {
      return { doc: doc, matchedOn: 'doc.id startsWith "' + firstWord + '-"' };
    }
  }
  // Pass 4 — equality across spec-named fields + actual schema field.
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const fields = {
      displayName:  normalize(data.displayName),
      display_name: normalize(data.display_name),
      name:         normalize(data.name),
      fullName:     normalize(data.fullName),
      full_name:    normalize(data.full_name),
      firstName:    normalize(data.firstName),
      first_name:   normalize(data.first_name)
    };
    for (const [fieldName, value] of Object.entries(fields)) {
      if (!value) continue;
      for (const cand of candidates) {
        if (value === cand) {
          return { doc: doc, matchedOn: fieldName + ' == "' + cand + '"' };
        }
      }
      // First-word match (e.g. display_name "Drew C." → first word "drew").
      const valueFirstWord = value.split(/\s+/)[0];
      if (valueFirstWord && firstWord && valueFirstWord === firstWord) {
        return { doc: doc, matchedOn: fieldName + ' firstWord == "' + firstWord + '"' };
      }
    }
  }
  return null;
}

// Upload one photo and return { storagePath, downloadUrl }.
// Mints a fresh Firebase download token so the URL is stable + long-lived.
async function uploadOne(filename) {
  const localPath   = path.join(SOURCE_DIR, filename);
  const storagePath = STORAGE_PREFIX + '/' + filename;
  const token       = crypto.randomUUID();

  await bucket.upload(localPath, {
    destination: storagePath,
    resumable:   false,
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType:  'image/jpeg',
      metadata: {
        // This is the magic field — Firebase Storage treats objects with
        // a `firebaseStorageDownloadTokens` metadata entry as token-
        // authorised, and the `?alt=media&token=…` URL below resolves
        // against it. The token persists in the object's metadata until
        // it's explicitly revoked from the Firebase console.
        firebaseStorageDownloadTokens: token
      }
    }
  });

  const downloadUrl =
    'https://firebasestorage.googleapis.com/v0/b/' + STORAGE_BUCKET +
    '/o/' + encodeURIComponent(storagePath) +
    '?alt=media&token=' + token;

  return { storagePath: storagePath, downloadUrl: downloadUrl };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error('[upload-tech-photos] source dir not found:', SOURCE_DIR);
    process.exit(2);
  }

  const files = fs.readdirSync(SOURCE_DIR)
    .filter(function (f) { return /\.(jpe?g|png)$/i.test(f); })
    .sort();

  console.log('================================================================');
  console.log(' Pioneer tech-photo uploader');
  console.log('================================================================');
  console.log(' Project:     ', PROJECT_ID);
  console.log(' Bucket:      ', STORAGE_BUCKET);
  console.log(' Source dir:  ', SOURCE_DIR);
  console.log(' Files found: ', files.length);
  console.log(' Mode:        ', DRY_RUN ? 'DRY-RUN (set DRY_RUN=false to write)' : 'WRITE');
  console.log('----------------------------------------------------------------');

  // Pull the cleaning_techs collection once. It's a small collection
  // (<50 docs) so in-memory matching beats N round-trip queries.
  const techSnap = await db.collection(COLLECTION).get();
  console.log(' cleaning_techs docs:', techSnap.size);
  console.log('----------------------------------------------------------------');

  const updated   = [];
  const unmatched = [];

  for (const filename of files) {
    const match = findTechMatch(techSnap, filename);
    if (!match) {
      console.log('• ' + filename + '  →  NO MATCH  (skipped, no doc created)');
      unmatched.push(filename);
      continue;
    }
    const data = match.doc.data() || {};
    const techLabel = data.display_name || data.displayName ||
                      data.name || data.fullName || match.doc.id;

    if (DRY_RUN) {
      console.log('• ' + filename);
      console.log('    matched →', techLabel, '(' + match.doc.id + ')');
      console.log('    matchOn  →', match.matchedOn);
      console.log('    would upload to: ' + STORAGE_PREFIX + '/' + filename);
      console.log('    would stamp:     photoUrl, profilePhotoUrl, photoStoragePath, photoUpdatedAt');
      updated.push({
        filename:    filename,
        techLabel:   techLabel,
        docId:       match.doc.id,
        storagePath: STORAGE_PREFIX + '/' + filename,
        downloadUrl: '(dry-run; no URL minted)'
      });
      continue;
    }

    // Real run — upload + stamp.
    const { storagePath, downloadUrl } = await uploadOne(filename);
    await match.doc.ref.update({
      photoUrl:         downloadUrl,
      profilePhotoUrl:  downloadUrl,
      photoStoragePath: storagePath,
      photoUpdatedAt:   admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('• ' + filename);
    console.log('    matched →', techLabel, '(' + match.doc.id + ')');
    console.log('    matchOn  →', match.matchedOn);
    console.log('    storage  →', storagePath);
    console.log('    url      →', downloadUrl);
    updated.push({
      filename:    filename,
      techLabel:   techLabel,
      docId:       match.doc.id,
      storagePath: storagePath,
      downloadUrl: downloadUrl
    });
  }

  console.log('----------------------------------------------------------------');
  console.log(' Summary');
  console.log('   updated:  ', updated.length);
  console.log('   unmatched:', unmatched.length);
  if (unmatched.length) {
    console.log('   unmatched files:');
    unmatched.forEach(function (f) { console.log('     -', f); });
  }
  console.log('================================================================');

  if (DRY_RUN) {
    console.log(' DRY-RUN complete. No data was written.');
    console.log(' Re-run with:  DRY_RUN=false node scripts/upload-tech-photos.js');
  } else {
    // Verification — confirm at least one updated tech doc now has a
    // photoUrl that the renderer's tech-photo coalesce list will see.
    // The list reads: photo_url | photoUrl | profile_photo_url |
    // profilePhotoUrl | avatar_url | avatarUrl | image_url | imageUrl.
    // We write photoUrl + profilePhotoUrl, so v2FirstHttpsString will
    // pick up the URL on the first hit.
    if (updated.length) {
      const sampleId  = updated[0].docId;
      const sampleDoc = await db.collection(COLLECTION).doc(sampleId).get();
      const sampleData = sampleDoc.exists ? sampleDoc.data() : {};
      console.log(' Renderer verification (read-back of ' + sampleId + '):');
      console.log('   photoUrl set:        ', !!sampleData.photoUrl);
      console.log('   profilePhotoUrl set: ', !!sampleData.profilePhotoUrl);
      console.log('   photoStoragePath:    ', sampleData.photoStoragePath || '(missing)');
      console.log('   → renderer will resolve resolvedTechPhotoUrl + set usedFallbackTechPhoto = false');
      console.log('     for any DCR whose tech_slug matches one of:',
                  updated.map(function (u) { return u.docId; }).join(', '));
    }
  }

  process.exit(unmatched.length && !DRY_RUN ? 1 : 0);
}

main().catch(function (err) {
  console.error('[upload-tech-photos] fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});
