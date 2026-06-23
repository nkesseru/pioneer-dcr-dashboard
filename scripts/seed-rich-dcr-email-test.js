#!/usr/bin/env node
/* ============================================================================
 * seed-rich-dcr-email-test.js — seed the "rich" DCR test fixture.
 *
 * Stops the previous acme-dental / Maria G. test loop dead — that DCR
 * had no matching tech photo, no signature, and a sparse checklist, so
 * the email always rendered fallback-heavy. This seed builds a fixture
 * where every V5 trust-loop signal can actually fire:
 *
 *   • customers/pioneer-commercial-cleaning-test  (upserted)
 *   • cleaning_techs/nick                          (verified, with photoUrl)
 *   • Storage uploads:
 *       - test-photos/pioneer-rich-test/{01..03}-<zone>.jpg
 *       - dcr-signatures/pioneer-commercial-cleaning-test/
 *           test-rich-dcr-nick/signature.jpg
 *   • dcr_submissions/test-rich-dcr-nick  (rich checklist + photo entries
 *     with zone+timestamp metadata + start_time → on-site duration tile
 *     should compute to ~2h 09m)
 *
 * Idempotent — safe to re-run. Each run remints download tokens for the
 * uploaded photos so URL freshness is guaranteed.
 *
 * Usage:
 *   npm run seed:rich-dcr-test
 * Then:
 *   npm run test:dcr-email:rich
 * ========================================================================== */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const admin  = require('firebase-admin');

// ---- Config ----------------------------------------------------------------
const PROJECT_ID     = 'pioneer-dcr-hub';
const STORAGE_BUCKET = 'pioneer-dcr-hub.firebasestorage.app';
const REPO_ROOT      = path.resolve(__dirname, '..');
const SA_KEY         = path.join(REPO_ROOT, 'serviceAccountKey.json');

const CUSTOMER_ID    = 'pioneer-commercial-cleaning-test';
const CUSTOMER_NAME  = 'Pioneer Commercial Cleaning Test Customer';
const CUSTOMER_EMAIL = 'nick@pioneercomclean.com';

const DCR_ID            = 'test-rich-dcr-nick';
const TECH_SLUG         = 'nick';
const TECH_DISPLAY_NAME = 'Nick';

// Source JPGs we use as both cleaning photos and the signature image.
// They're already in the repo (assets/tech-photos/) and visually look
// like real photos — adequate for QA. The signature placeholder is
// also a JPG; the renderer just shows it in the signature frame.
const SOURCE_PHOTOS = [
  { file: 'april.jpg',  storage: 'test-photos/pioneer-rich-test/01-reception.jpg', zone: 'Reception' },
  { file: 'bonnie.jpg', storage: 'test-photos/pioneer-rich-test/02-restrooms.jpg', zone: 'Restrooms' },
  { file: 'drew.jpg',   storage: 'test-photos/pioneer-rich-test/03-kitchen.jpg',   zone: 'Kitchen'   }
];
const SOURCE_SIGNATURE = {
  file:    'nick.jpg',
  storage: 'dcr-signatures/' + CUSTOMER_ID + '/' + DCR_ID + '/signature.jpg'
};

// Required-not-optional safety: refuse to run against any other project.
function initAdmin() {
  if (admin.apps.length) return;
  if (!fs.existsSync(SA_KEY)) {
    console.error('✗ Missing serviceAccountKey.json at the repo root.');
    process.exit(2);
  }
  admin.initializeApp({
    credential:    admin.credential.cert(require(SA_KEY)),
    projectId:     PROJECT_ID,
    storageBucket: STORAGE_BUCKET
  });
  if (admin.app().options.projectId !== PROJECT_ID) {
    console.error('✗ refusing to seed against', admin.app().options.projectId);
    process.exit(2);
  }
}

// ---- Storage upload helper -------------------------------------------------
async function uploadFile(bucket, localPath, storagePath, contentType) {
  const token = crypto.randomUUID();
  await bucket.upload(localPath, {
    destination: storagePath,
    resumable:   false,
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType:  contentType || 'image/jpeg',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return 'https://firebasestorage.googleapis.com/v0/b/' + STORAGE_BUCKET +
         '/o/' + encodeURIComponent(storagePath) +
         '?alt=media&token=' + token;
}

// ---- Realistic checklist + timestamps --------------------------------------
// Six canonical sections — exactly the keywords v5BuildCompletedBulletsFromChecklist
// looks for, so the rendered "What was completed" block emits the spec's
// canonical bullets (Restrooms cleaned and restocked, Floors completed,
// Trash removed and liners replaced, High-touch areas handled, Entry
// areas reset, Kitchen/breakroom cleaned).
function buildChecklist() {
  const done = function (label) { return { label: label, status: 'done' }; };
  return [
    { label: 'Bathrooms', items: [
      done('Wipe counters and fixtures'),
      done('Restock paper products + soap'),
      done('Clean toilets and urinals'),
      done('Clean mirrors'),
      done('Empty waste bins')
    ]},
    { label: 'Floors', items: [
      done('Vacuum all carpeted areas'),
      done('Mop hard floors'),
      done('Spot-clean baseboards')
    ]},
    { label: 'Trash', items: [
      done('Empty all bins'),
      done('Replace liners'),
      done('Take consolidated trash to dumpster')
    ]},
    { label: 'High-touch', items: [
      done('Wipe door handles + push plates'),
      done('Wipe light switches'),
      done('Wipe shared phones / fobs'),
      done('Wipe stair railings')
    ]},
    { label: 'Entry', items: [
      done('Sweep entry mats'),
      done('Clean glass front doors'),
      done('Wipe sign-in counter')
    ]},
    { label: 'Kitchens', items: [
      done('Wipe counters + appliances'),
      done('Clean sink and faucet'),
      done('Wipe microwave inside and out'),
      done('Wipe tables + chairs'),
      done('Empty coffee station')
    ]}
  ];
}

// Pick a submittedAt that's well in the past (so the timestamp doesn't
// trigger "future date" filters anywhere) and a start_time that's
// exactly 2h 09m before it, so the V5 On-site tile renders "2h 09m"
// (matching the spec example).
function buildTimestamps() {
  const submittedMs = Date.now() - 30 * 60 * 1000;            // 30 min ago
  const startMs     = submittedMs - (2 * 3600000 + 9 * 60000); // 2h 09m before submit
  return {
    submittedAt: new Date(submittedMs).toISOString(),
    startedAt:   new Date(startMs).toISOString(),
    submittedMs: submittedMs,
    startMs:     startMs
  };
}

// ---- Main -----------------------------------------------------------------
async function main() {
  initAdmin();
  const db     = admin.firestore();
  const bucket = admin.storage().bucket();

  console.log('================================================================');
  console.log(' Pioneer DCR email — RICH TEST FIXTURE SEED');
  console.log('================================================================');
  console.log(' Project:    ', PROJECT_ID);
  console.log(' Customer:   ', CUSTOMER_ID);
  console.log(' DCR:        ', DCR_ID);
  console.log(' Tech:       ', TECH_SLUG);
  console.log('----------------------------------------------------------------');

  // ---- 1. Verify Nick tech ----
  // The tech doc already exists from the earlier bulk-upload seed. We
  // do NOT overwrite it — just confirm it carries the required URLs.
  // If the photo went missing, surface it as a soft warning so the
  // operator can re-run the upload-tech-photos script.
  const nickRef  = db.collection('cleaning_techs').doc(TECH_SLUG);
  const nickSnap = await nickRef.get();
  if (!nickSnap.exists) {
    console.error('✗ cleaning_techs/' + TECH_SLUG + ' is missing.');
    console.error('  Run: DRY_RUN=false node scripts/upload-tech-photos.js');
    process.exit(2);
  }
  const nickData = nickSnap.data() || {};
  const techPhotoUrl = nickData.photoUrl || nickData.profilePhotoUrl || '';
  if (!techPhotoUrl) {
    console.warn('⚠ cleaning_techs/' + TECH_SLUG + ' has no photoUrl/profilePhotoUrl.');
    console.warn('  The email will fall back to an initials bubble.');
  } else {
    console.log(' Nick photoUrl:    ', techPhotoUrl.slice(0, 70) + '…');
  }

  // ---- 2. Upload 3 cleaning photos + 1 signature ----
  // Source images come from assets/tech-photos/ — real JPGs already in
  // the repo. They're not "real" cleaning photos but they're real
  // images with real Storage URLs, which is what V5 caption + photo
  // rendering needs to exercise. The captions in the email will read
  // "Reception · <time>", "Restrooms · <time>", "Kitchen · <time>".
  const sourceDir = path.join(REPO_ROOT, 'assets', 'tech-photos');
  const photoUrls = [];
  for (let i = 0; i < SOURCE_PHOTOS.length; i++) {
    const src = SOURCE_PHOTOS[i];
    const localPath = path.join(sourceDir, src.file);
    if (!fs.existsSync(localPath)) {
      console.error('✗ source file missing:', localPath);
      process.exit(2);
    }
    const url = await uploadFile(bucket, localPath, src.storage, 'image/jpeg');
    photoUrls.push({ url: url, zone: src.zone, storage: src.storage });
    console.log(' Uploaded photo ' + (i + 1) + ':', src.storage);
  }

  const sigLocalPath = path.join(sourceDir, SOURCE_SIGNATURE.file);
  if (!fs.existsSync(sigLocalPath)) {
    console.error('✗ signature source file missing:', sigLocalPath);
    process.exit(2);
  }
  const signatureUrl = await uploadFile(bucket, sigLocalPath, SOURCE_SIGNATURE.storage, 'image/jpeg');
  console.log(' Uploaded signature:', SOURCE_SIGNATURE.storage);

  // ---- 3. Upsert customer ----
  const customerRef = db.collection('customers').doc(CUSTOMER_ID);
  const customerExisted = (await customerRef.get()).exists;
  await customerRef.set({
    customer_slug:     CUSTOMER_ID,
    customer_name:     CUSTOMER_NAME,
    customer_email:    CUSTOMER_EMAIL,
    dcr_email_enabled: true,
    active:            true,
    // Seed marker so this customer is easy to spot/clean later.
    seed_source:       'scripts/seed-rich-dcr-email-test.js',
    updated_at:        admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  if (!customerExisted) {
    // First time only — also set created_at.
    await customerRef.set({ created_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  console.log(' Customer ' + (customerExisted ? 'updated' : 'created') + ':', CUSTOMER_ID);

  // ---- 4. Build the DCR ----
  const ts        = buildTimestamps();
  const checklist = buildChecklist();
  const cleanDate = ts.submittedAt.slice(0, 10); // YYYY-MM-DD

  // photoEntries with zone+timestamp — exercises the V5 caption logic.
  // The renderer prefers photoEntries over the flat photo_urls list.
  // We carry BOTH so legacy V1/V2 code paths also see something.
  const photoEntries = photoUrls.map(function (p, i) {
    const tsMs = ts.startMs + (i + 1) * (5 * 60 * 1000); // 5min apart
    return {
      url:       p.url,
      zone:      p.zone,
      timestamp: new Date(tsMs).toISOString()
    };
  });
  const flatPhotoUrls = photoUrls.map(function (p) { return p.url; });

  // Affirmation block — modern primary path for signature resolution.
  // V5 looks at aff.signature_url first; this is the cleanest field
  // to use so the dcr_email_payloads.signatureLookupSource records
  // "aff.signature_url" on the next test run.
  const affirmation = {
    signature_url:    signatureUrl,
    signature_name:   TECH_DISPLAY_NAME,
    signed_at:        ts.submittedAt
  };

  const dcrRef = db.collection('dcr_submissions').doc(DCR_ID);
  const dcrExisted = (await dcrRef.get()).exists;
  await dcrRef.set({
    submission_id:     DCR_ID,
    customer_slug:     CUSTOMER_ID,
    customer_name:     CUSTOMER_NAME,
    tech_slug:         TECH_SLUG,
    tech_display_name: TECH_DISPLAY_NAME,
    clean_date:        cleanDate,

    // Timestamps — submitted_at + start_time pair drive the V5 On-site
    // tile (~2h 09m). Both are real Date instances so trustTsMs
    // resolves them cleanly.
    submission_meta: { client_submitted_at: new Date(ts.submittedMs) },
    start_time:      new Date(ts.startMs),
    submitted_at:    new Date(ts.submittedMs),

    // Checklist — top-level. The renderer reads either dcr.checklist
    // or dcr.form_data.checklist; top-level is canonical.
    checklist:       checklist,

    // form_data carries the rest of the DCR submission shape so
    // anything else that reads from form_data keeps working.
    form_data: {
      checklist:      checklist,
      has_problem:    false,
      needs_supplies: false,
      on_time_budget: true,
      occupancy_level: 'low',
      start_time:     new Date(ts.startMs),
      tech:           TECH_SLUG,
      tech_display_name: TECH_DISPLAY_NAME
    },

    // Signature — affirmation block. V5 signature coalesce list reads
    // aff.signature_url first; this puts the visit-specific URL right
    // in the canonical slot.
    affirmation: affirmation,

    // Photos — both shapes. V5 renderer prefers `photos` (object array
    // with zone + timestamp); legacy code reads flat `photo_urls`.
    photos:          photoEntries,
    photo_urls:      flatPhotoUrls,

    // No issues, no problem, no supply request, on-time.
    has_problem:     false,
    needs_supplies:  false,

    // Seed marker.
    seed_source:     'scripts/seed-rich-dcr-email-test.js',
    created_at:      admin.firestore.FieldValue.serverTimestamp(),
    updated_at:      admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(' DCR ' + (dcrExisted ? 'updated' : 'created') + ':', DCR_ID);

  // ---- 5. Summary ----
  console.log('----------------------------------------------------------------');
  console.log(' Summary');
  console.log('   customer doc:            ', customerExisted ? 'updated' : 'created');
  console.log('   DCR doc ID:              ', DCR_ID);
  console.log('   tech doc used:           ', TECH_SLUG, '(' + TECH_DISPLAY_NAME + ')');
  console.log('   resolved tech photo URL: ', techPhotoUrl ? (techPhotoUrl.slice(0, 90) + '…') : '(none — initials fallback will fire)');
  console.log('   resolved signature URL:  ', signatureUrl.slice(0, 90) + '…');
  console.log('   photo count:             ', photoEntries.length);
  console.log('   checklist sections:      ', checklist.map(function (s) { return s.label; }).join(', '));
  console.log('   start_time:              ', ts.startedAt);
  console.log('   submitted_at:            ', ts.submittedAt);
  console.log('================================================================');
  console.log('');
  console.log(' Next: send the rich test email with');
  console.log('   npm run test:dcr-email:rich');
  console.log('');

  process.exit(0);
}

main().catch(function (err) {
  console.error('fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});
