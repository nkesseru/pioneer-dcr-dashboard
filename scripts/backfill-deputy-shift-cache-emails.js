#!/usr/bin/env node
/* ============================================================================
 * backfill-deputy-shift-cache-emails.js
 *
 * The Deputy sync writes `employee_email` on each `deputy_shift_cache`
 * doc based on the MATCHED cleaning_techs/{slug}.email at sync time.
 * When that field is empty on the tech doc, the sync writes
 * employee_email="", which causes the Firestore rule to reject the
 * tech's read and "Today's Work" shows "No work scheduled today" even
 * though the shifts ARE in Firestore.
 *
 * After the office adds emails to the affected cleaning_techs docs,
 * a full Deputy resync would fix the cache — but resync is heavy and
 * only runs nightly. This script does the lightweight patch: scan
 * cache docs in a date window, find ones with empty employee_email
 * but non-empty employee_slug, look up the tech's email, stamp it on
 * the cache doc. Idempotent.
 *
 * Usage:
 *   DRY_RUN=true node scripts/backfill-deputy-shift-cache-emails.js          # default — preview
 *   DRY_RUN=false node scripts/backfill-deputy-shift-cache-emails.js         # write
 *   SYNC_DATE=2026-05-20 DRY_RUN=false node scripts/...                      # specific date
 *
 * Without SYNC_DATE, defaults to a 7-day window ending today (Pacific
 * TZ) so a single run fixes the recent cache.
 * ========================================================================== */

'use strict';

const path  = require('path');
const fs    = require('fs');
const admin = require('firebase-admin');

const PROJECT_ID  = 'pioneer-dcr-hub';
const REPO_ROOT   = path.resolve(__dirname, '..');
const SA_KEY      = path.join(REPO_ROOT, 'serviceAccountKey.json');
const DRY_RUN     = process.env.DRY_RUN !== 'false';
const SINGLE_DATE = (process.env.SYNC_DATE || '').trim();

function pacificDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d || new Date());
}

function initAdmin() {
  if (admin.apps.length) return;
  if (!fs.existsSync(SA_KEY)) {
    console.error('✗ Missing serviceAccountKey.json at repo root.');
    process.exit(2);
  }
  admin.initializeApp({
    credential: admin.credential.cert(require(SA_KEY)),
    projectId:  PROJECT_ID
  });
  if (admin.app().options.projectId !== PROJECT_ID) {
    console.error('✗ refusing to run against', admin.app().options.projectId);
    process.exit(2);
  }
}

async function main() {
  initAdmin();
  const db = admin.firestore();

  // ---- Determine the date window ----
  // Either a single SYNC_DATE override, or today + 6 prior days (7 total).
  // 7 days covers the visible operational horizon without paging through
  // months of archival data.
  let datesToScan;
  if (SINGLE_DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(SINGLE_DATE)) {
      console.error('✗ SYNC_DATE must be YYYY-MM-DD (got', SINGLE_DATE + ').');
      process.exit(2);
    }
    datesToScan = [SINGLE_DATE];
  } else {
    datesToScan = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      datesToScan.push(pacificDate(d));
    }
  }

  console.log('================================================================');
  console.log(' Pioneer DCR Hub — deputy_shift_cache email backfill');
  console.log('================================================================');
  console.log(' Project:    ', PROJECT_ID);
  console.log(' Mode:       ', DRY_RUN ? 'DRY-RUN (set DRY_RUN=false to write)' : 'WRITE');
  console.log(' Date range: ', datesToScan.join(', '));
  console.log('----------------------------------------------------------------');

  // ---- Build the tech-email lookup table once ----
  // Reads ALL cleaning_techs docs. Keys: tech slug → email (lowercased).
  // Skips docs with empty email so we can clearly report "still missing".
  const techsSnap = await db.collection('cleaning_techs').get();
  const techEmailBySlug = Object.create(null);
  const techsMissingEmail = [];
  techsSnap.docs.forEach(function (d) {
    const data = d.data() || {};
    const slug = d.id;
    const email = String(data.email || '').toLowerCase().trim();
    if (email) techEmailBySlug[slug] = email;
    else       techsMissingEmail.push(slug);
  });
  console.log(' Techs with email on file:    ', Object.keys(techEmailBySlug).length);
  console.log(' Techs WITHOUT email on file: ', techsMissingEmail.length,
    techsMissingEmail.length ? '(' + techsMissingEmail.join(', ') + ')' : '');
  console.log('----------------------------------------------------------------');

  // ---- Walk each date, patch what we can ----
  let totalScanned    = 0;
  let totalPatched    = 0;
  let totalStillBlank = 0;
  const stillBlankByTech = Object.create(null);

  for (const date of datesToScan) {
    const snap = await db.collection('deputy_shift_cache')
      .where('sync_date', '==', date)
      .get();
    if (snap.empty) {
      console.log(' [' + date + '] 0 cache docs');
      continue;
    }
    let datePatched = 0;
    let dateBlank   = 0;
    let dateOk      = 0;
    for (const doc of snap.docs) {
      totalScanned += 1;
      const data = doc.data() || {};
      const currentEmail = String(data.employee_email || '').trim();
      const slug         = String(data.employee_slug  || '').trim();
      if (currentEmail) {
        dateOk += 1;
        continue;
      }
      // employee_email is empty. Can we fix it?
      if (!slug) {
        // No slug either — the original Deputy sync couldn't match this
        // shift to any tech at all. Office needs to set deputy_employee_id
        // or deputy_employee_email on a tech doc and resync.
        dateBlank += 1;
        const key = '(no slug, no email — shift ' + (data.shift_id || doc.id) + ')';
        stillBlankByTech[key] = (stillBlankByTech[key] || 0) + 1;
        continue;
      }
      const techEmail = techEmailBySlug[slug];
      if (!techEmail) {
        dateBlank += 1;
        stillBlankByTech[slug] = (stillBlankByTech[slug] || 0) + 1;
        continue;
      }
      // We can patch.
      datePatched += 1;
      totalPatched += 1;
      if (DRY_RUN) {
        console.log('  [' + date + '] would patch ' + doc.id + ': employee_email = "' + techEmail + '"  (slug=' + slug + ')');
      } else {
        try {
          await doc.ref.update({
            employee_email:    techEmail,
            employee_email_backfilled_at: admin.firestore.FieldValue.serverTimestamp(),
            employee_email_backfill_source: 'scripts/backfill-deputy-shift-cache-emails.js'
          });
          console.log('  [' + date + '] patched ' + doc.id + ': employee_email = "' + techEmail + '"  (slug=' + slug + ')');
        } catch (err) {
          console.error('  [' + date + '] update FAILED on ' + doc.id + ':', err.message);
        }
      }
    }
    totalStillBlank += dateBlank;
    console.log(' [' + date + '] scanned=' + snap.size +
                '  already_ok=' + dateOk +
                '  patched=' + datePatched +
                '  still_blank=' + dateBlank);
  }

  console.log('----------------------------------------------------------------');
  console.log(' Totals');
  console.log('   scanned:        ', totalScanned);
  console.log('   patched:        ', totalPatched, DRY_RUN ? '(dry-run — no writes)' : '(written)');
  console.log('   still blank:    ', totalStillBlank);
  if (totalStillBlank > 0) {
    console.log('   still-blank breakdown by tech slug / unmapped:');
    Object.keys(stillBlankByTech).forEach(function (k) {
      console.log('     -', k, '→', stillBlankByTech[k], 'doc(s)');
    });
    console.log('');
    console.log(' Next step:');
    console.log('   For each tech listed above, edit cleaning_techs/{slug} in the admin UI');
    console.log('   (Core Ops → Cleaning Techs → Edit) and set the "Email" field to the');
    console.log('   tech\'s Firebase Auth email. Then re-run this script to backfill the');
    console.log('   cache docs without waiting for the nightly Deputy resync.');
  }
  console.log('================================================================');

  if (DRY_RUN) {
    console.log(' DRY-RUN complete. Re-run with: DRY_RUN=false node scripts/backfill-deputy-shift-cache-emails.js');
  }
  process.exit(0);
}

main().catch(function (err) {
  console.error('fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});
