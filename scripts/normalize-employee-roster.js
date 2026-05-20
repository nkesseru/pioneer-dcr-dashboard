#!/usr/bin/env node
/* ============================================================================
 * normalize-employee-roster.js
 *
 * Single-source-of-truth pass for the Pioneer roster before inviting
 * the team to the live app. Two collections in scope:
 *
 *   • cleaning_techs/{slug} — per-person operational doc. Carries
 *       email (drives Deputy + login mapping), media (photo / sig
 *       URLs), assigned customers, active/dcr_enabled flags.
 *   • admins/{email}        — admin allowlist for /admin access.
 *       Doc id is lowercased email.
 *
 * The script does THREE things:
 *
 *   1. Inspect every existing cleaning_techs doc against the CANONICAL_ROSTER
 *      defined below. For each doc, classify the action:
 *         keep_canonical       — this is the canonical doc for the person
 *         merge_into_canonical — duplicate; media + assignments migrate
 *         archive_test         — clearly a test record (active = false)
 *         archive_extra        — real-looking but not on the roster
 *         delete_safe_test     — clearly safe test record + --delete-safe-tests
 *      Media + assignment migration RUNS BEFORE the duplicate is archived,
 *      so we never lose photos / signatures / assigned_customer_slugs.
 *
 *   2. Upsert canonical fields onto each canonical doc:
 *         email, role, isAdmin, isManager, isOfficeManager, dcr_enabled,
 *         active, aliases[], normalizedAt, normalizedBy
 *
 *   3. Manage admins/{email} docs for each canonical admin/manager.
 *      Cleaning techs are NOT added to /admins. Existing admins not on
 *      the canonical list are LEFT ALONE (we don't revoke).
 *
 * Default: --dry-run. Use --apply to write. Use --archive-tests to
 * include the archive_test branch. Use --delete-safe-tests to hard
 * delete records explicitly tagged safe_test (today: only the
 * "dcr-test-cleaning-tech" doc qualifies).
 *
 * Hard rules (per the spec):
 *   • Never delete a doc that has a photo, signature, assigned
 *     customers, or invite history without migrating first.
 *   • Never auto-create birth dates, phone numbers, or addresses.
 *   • Never silently archive a doc whose Deputy shift cache references
 *     its slug — log it and let the operator confirm.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/normalize-employee-roster.js                       # default dry-run
 *   node scripts/normalize-employee-roster.js --apply               # write canonical + media migration
 *   node scripts/normalize-employee-roster.js --apply --archive-tests
 *   node scripts/normalize-employee-roster.js --apply --archive-tests --delete-safe-tests
 * ========================================================================== */

'use strict';

const path  = require('path');
const fs    = require('fs');
const admin = require('firebase-admin');

const PROJECT_ID = 'pioneer-dcr-hub';
const SA_KEY     = path.join(path.resolve(__dirname, '..'), 'serviceAccountKey.json');

const ARGS = process.argv.slice(2);
const FLAGS = {
  apply:            ARGS.includes('--apply'),
  archiveTests:     ARGS.includes('--archive-tests'),
  deleteSafeTests:  ARGS.includes('--delete-safe-tests')
};
const DRY_RUN = !FLAGS.apply;

const NORMALIZED_BY = "normalize-employee-roster-script";

// ----------------------------------------------------------------------------
// CANONICAL ROSTER. Source of truth supplied by the office. Everything below
// references this list — if a slug is here, it MUST exist as a cleaning_techs
// doc after this run; if a doc isn't here, it's either a known duplicate
// (listed under `duplicates`) or it's flagged extra / test.
// ----------------------------------------------------------------------------
const CANONICAL_ROSTER = [
  // Admins / managers
  {
    slug: "nick-k",
    display_name: "Nick K.",
    full_name: "Nick Kesseru",
    email: "nick@pioneercomclean.com",
    role: "admin",
    isAdmin: true,
    isManager: true,
    isOfficeManager: false,
    dcr_enabled: false,    // Nick doesn't run cleaning shifts; toggle if needed
    aliases: ["Nick Kesseru", "Nick", "Nick K"],
    duplicates: ["nick", "nicholas-r"]    // these slugs get merged into nick-k
  },
  {
    slug: "april-k",
    display_name: "April K.",
    full_name: "April Kesseru",
    email: "april@pioneercomclean.com",
    role: "manager_admin",
    isAdmin: true,
    isManager: true,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["April Kesseru", "April"],
    duplicates: []
  },
  {
    slug: "kirby-a",
    display_name: "Kirby A.",
    full_name: "Kirby Ariola",
    // TODO: confirm Kirby's email. The spec said "use existing email
    // if present; if missing, leave TODO". No kirby@... appears in the
    // current Firestore data, so this is a placeholder; the script
    // will leave the field unset and surface it in the report under
    // "emails still missing" so the office can fill it in via the
    // admin UI before inviting.
    email: "",
    emailTodo: "Kirby's email — confirm with office and run again.",
    role: "office_manager_admin",
    isAdmin: true,
    isManager: true,
    isOfficeManager: true,
    dcr_enabled: false,
    aliases: ["Kirby Ariola", "Kirby"],
    duplicates: []
  },
  {
    slug: "laura-j",
    display_name: "Laura J.",
    full_name: "Laura Jensen",
    email: "laura@pioneercomclean.com",
    role: "admin",
    isAdmin: true,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Laura Jensen", "Laura"],
    duplicates: ["laura"]
  },
  {
    slug: "jared-d",
    display_name: "Jared D.",
    full_name: "Jared Davis",
    email: "davisjared1984@gmail.com",
    role: "admin",
    isAdmin: true,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Jared Davis", "Jared"],
    duplicates: []
  },

  // Cleaning techs
  {
    slug: "makaila-b",
    display_name: "Makaila B.",
    full_name: "Makaila Bergeron",
    email: "makaila.ann@live.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Makaila Bergeron", "Makaila"],
    duplicates: []
  },
  {
    slug: "drew-c",
    display_name: "Drew C.",
    full_name: "Drew Choules",
    email: "choulesd@gmail.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Drew Choules", "Drew"],
    duplicates: []
  },
  {
    slug: "gene-f",
    display_name: "Gene F.",
    full_name: "Eugene Ferrell",
    email: "genef1976@hotmail.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Eugene Ferrell", "Gene", "Eugene"],
    duplicates: []
  },
  {
    slug: "kiana-l",
    display_name: "Kiana L.",
    full_name: "Kiana Lopez",
    email: "lopezkiana05@gmail.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Kiana Lopez", "Kiana"],
    duplicates: []
  },
  {
    slug: "jacob-n",
    display_name: "Jacob N.",
    full_name: "Jacob Norris",
    email: "jacobn155@yahoo.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Jacob Norris", "Jacob"],
    duplicates: []
  },
  {
    slug: "bonnie-r",
    display_name: "Bonnie R.",
    full_name: "Bonnie Root",
    email: "1blroot@gmail.com",
    role: "cleaning_tech",
    isAdmin: false,
    isManager: false,
    isOfficeManager: false,
    dcr_enabled: true,
    aliases: ["Bonnie Root", "Bonnie"],
    duplicates: []
  }
];

// Records flagged as safe-to-delete only with --delete-safe-tests. These
// are unambiguously test fixtures (the slug name + display name say so).
// Anything not in this list either becomes archive_test or archive_extra
// depending on its content (assignments / media).
const KNOWN_SAFE_TEST_SLUGS = new Set(["dcr-test-cleaning-tech"]);

// Slugs the operator has decided are NOT part of the canonical roster
// but ALSO not test records. Today: mackenzie-s. Action defaults to
// archive_extra (active=false, dcr_enabled=false). Lives here so the
// report calls it out by name rather than just classifying via "no
// canonical match".
const KNOWN_NON_CANONICAL_REAL_SLUGS = new Set(["mackenzie-s"]);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

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

function canonicalBySlug() {
  const map = Object.create(null);
  CANONICAL_ROSTER.forEach(function (c) { map[c.slug] = c; });
  return map;
}

function canonicalForDoc(doc) {
  // First: exact slug match.
  for (const c of CANONICAL_ROSTER) {
    if (doc.id === c.slug) return { canonical: c, match: "slug" };
  }
  // Second: doc's id is listed under a canonical's duplicates[].
  for (const c of CANONICAL_ROSTER) {
    if (c.duplicates.indexOf(doc.id) >= 0) return { canonical: c, match: "duplicate_of" };
  }
  // Third: email match against canonical.email (only when the doc has
  // an email AND it matches exactly).
  const email = String((doc.data() || {}).email || "").toLowerCase().trim();
  if (email) {
    for (const c of CANONICAL_ROSTER) {
      if (String(c.email || "").toLowerCase().trim() === email) {
        return { canonical: c, match: "email" };
      }
    }
  }
  return { canonical: null, match: null };
}

function classify(doc) {
  const data = doc.data() || {};
  const { canonical, match } = canonicalForDoc(doc);
  const hasMedia      = !!(data.photoUrl || data.profilePhotoUrl || data.signatureUrl);
  const assignedCount = (Array.isArray(data.assigned_customer_slugs) ? data.assigned_customer_slugs.length : 0);

  if (canonical) {
    if (match === "slug" || match === "email") {
      return { action: "keep_canonical", canonical: canonical, match: match };
    }
    if (match === "duplicate_of") {
      return { action: "merge_into_canonical", canonical: canonical, match: match };
    }
  }

  if (KNOWN_SAFE_TEST_SLUGS.has(doc.id)) {
    return {
      action:    FLAGS.deleteSafeTests ? "delete_safe_test" : "archive_test",
      canonical: null,
      match:     null,
      // Always migrate any assignments/media before deletion. The
      // dcr-test-cleaning-tech doc carries 19 fabricated customer
      // assignments today; we don't migrate THOSE (test data).
      preserve:  hasMedia
    };
  }
  if (KNOWN_NON_CANONICAL_REAL_SLUGS.has(doc.id)) {
    return { action: "archive_extra", canonical: null, match: null };
  }
  // Anything else with no canonical match: default to archive_extra so
  // the office sees it in the report rather than silent-passing.
  return { action: "archive_extra", canonical: null, match: null };
}

// Build the field patch for a canonical doc. Pulls from CANONICAL_ROSTER
// + optionally absorbs media/assignments from a merge-source doc when
// the canonical lacks them.
function buildCanonicalUpdate(canonical, existing, mergeSource) {
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const ex  = existing || {};
  const mg  = mergeSource || {};

  // Email: canonical wins unless canonical.email is blank (Kirby TODO)
  // — in that case preserve any existing email rather than wiping.
  const emailToWrite = canonical.email ||
                       String(ex.email || mg.email || "").toLowerCase().trim();

  const update = {
    // Identity ----------------------------------------------------------
    tech_slug:        canonical.slug,
    display_name:     canonical.display_name,
    full_name:        canonical.full_name,
    email:            emailToWrite,
    // Role + flags ------------------------------------------------------
    role:             canonical.role,
    isAdmin:          !!canonical.isAdmin,
    isManager:        !!canonical.isManager,
    isOfficeManager:  !!canonical.isOfficeManager,
    // Visibility --------------------------------------------------------
    active:           true,
    dcr_enabled:      !!canonical.dcr_enabled,
    dcrEnabled:       !!canonical.dcr_enabled,
    // Aliases for future fuzzy matching ----------------------------------
    aliases:          (canonical.aliases || []).slice(),
    // Audit -------------------------------------------------------------
    normalizedAt:     sts,
    normalizedBy:     NORMALIZED_BY
  };

  // Media migration: only copy from the merge source if the canonical
  // doesn't already have the field. NEVER overwrite an existing media
  // URL on the canonical (avoids regressing a freshly-uploaded photo).
  const MEDIA_FIELDS = [
    "photoUrl", "profilePhotoUrl", "photoStoragePath", "photoUpdatedAt",
    "photoContentType", "photoSizeBytes",
    "signatureUrl", "signatureStoragePath", "signatureUpdatedAt",
    "signatureContentType", "signatureSizeBytes"
  ];
  MEDIA_FIELDS.forEach(function (k) {
    if (!ex[k] && mg[k]) update[k] = mg[k];
  });

  // Assigned customers: union of canonical's existing list + merge
  // source's list. Dedupe; preserve canonical's order first.
  const existingAssigned = Array.isArray(ex.assigned_customer_slugs) ? ex.assigned_customer_slugs : [];
  const mergeAssigned    = Array.isArray(mg.assigned_customer_slugs) ? mg.assigned_customer_slugs : [];
  const seen = Object.create(null);
  const merged = [];
  existingAssigned.concat(mergeAssigned).forEach(function (s) {
    const v = String(s || "").trim();
    if (!v || seen[v]) return;
    seen[v] = true;
    merged.push(v);
  });
  if (merged.length) update.assigned_customer_slugs = merged;

  // Invite history: keep canonical's if present; absorb merge source's
  // otherwise. Helps when a tech was invited under a duplicate doc.
  ["inviteSentAt", "inviteSentBy", "inviteEmail", "inviteStatus",
   "last_invite_sent_at", "last_reset_sent_at"].forEach(function (k) {
    if (!ex[k] && mg[k]) update[k] = mg[k];
  });

  return update;
}

function buildArchivePatch(why) {
  return {
    active:        false,
    dcr_enabled:   false,
    dcrEnabled:    false,
    archived_at:   admin.firestore.FieldValue.serverTimestamp(),
    archived_by:   NORMALIZED_BY,
    archived_reason: why
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  initAdmin();
  const db = admin.firestore();

  console.log('================================================================');
  console.log(' Pioneer roster normalization');
  console.log('================================================================');
  console.log(' Project:           ', PROJECT_ID);
  console.log(' Mode:              ', DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (writes)');
  console.log(' --archive-tests:   ', FLAGS.archiveTests ? 'YES' : 'no');
  console.log(' --delete-safe-tests:', FLAGS.deleteSafeTests ? 'YES' : 'no');
  console.log('----------------------------------------------------------------');

  // 1. Load everything.
  const [techsSnap, adminsSnap, deputySnap] = await Promise.all([
    db.collection('cleaning_techs').get(),
    db.collection('admins').get(),
    db.collection('deputy_shift_cache').limit(500).get()
  ]);
  const techsById = Object.create(null);
  techsSnap.docs.forEach(function (d) { techsById[d.id] = d; });

  const adminsById = Object.create(null);
  adminsSnap.docs.forEach(function (d) { adminsById[d.id] = d; });

  // Slugs referenced by recent Deputy shifts — surface these so the
  // operator can confirm before archiving anything that's still
  // actively receiving shifts.
  const slugsInDeputyCache = new Set();
  deputySnap.docs.forEach(function (d) {
    const s = String((d.data() || {}).employee_slug || "").trim();
    if (s) slugsInDeputyCache.add(s);
  });

  // 2. Classify every existing cleaning_techs doc.
  const plan = [];
  techsSnap.docs.forEach(function (d) {
    const cls = classify(d);
    plan.push({ doc: d, ...cls });
  });

  // 3. Build a per-canonical merge-source lookup so the canonical
  // doc's update can absorb media from its duplicates without
  // re-walking the list.
  const dupesByCanonicalSlug = Object.create(null);
  plan.forEach(function (p) {
    if (p.action === "merge_into_canonical" && p.canonical) {
      const k = p.canonical.slug;
      if (!dupesByCanonicalSlug[k]) dupesByCanonicalSlug[k] = [];
      dupesByCanonicalSlug[k].push(p.doc);
    }
  });

  // 4. REPORT.
  console.log('\n--- Per-doc plan ---');
  const counters = { keep: 0, merge: 0, archiveTest: 0, deleteTest: 0, archiveExtra: 0, missingCanonical: 0 };
  plan.forEach(function (p) {
    const data = p.doc.data() || {};
    const hasPhoto = !!(data.photoUrl || data.profilePhotoUrl);
    const hasSig   = !!data.signatureUrl;
    const assignN  = (Array.isArray(data.assigned_customer_slugs) ? data.assigned_customer_slugs.length : 0);
    const stillInDeputy = slugsInDeputyCache.has(p.doc.id) ? " · ⚠ active in deputy_shift_cache" : "";
    const canonicalSlug = p.canonical ? p.canonical.slug : "—";
    const verb = ({
      keep_canonical:       "KEEP CANONICAL",
      merge_into_canonical: "MERGE → " + canonicalSlug,
      archive_test:         "ARCHIVE (test)",
      delete_safe_test:     "DELETE (safe test)",
      archive_extra:        "ARCHIVE (extra/non-roster)"
    })[p.action] || p.action;
    console.log(
      '  ' + p.doc.id.padEnd(24) +
      ' → ' + verb.padEnd(28) +
      ' | email=' + (data.email || '(none)').padEnd(34) +
      ' | photo=' + (hasPhoto ? '✓' : '·') +
      ' | sig=' + (hasSig ? '✓' : '·') +
      ' | assigned=' + assignN +
      stillInDeputy
    );
    if (p.action === "keep_canonical")       counters.keep++;
    if (p.action === "merge_into_canonical") counters.merge++;
    if (p.action === "archive_test")         counters.archiveTest++;
    if (p.action === "delete_safe_test")     counters.deleteTest++;
    if (p.action === "archive_extra")        counters.archiveExtra++;
  });

  // 5. Canonical slugs that have NO existing doc — these need to be
  // CREATED on apply.
  const canonicalToCreate = [];
  CANONICAL_ROSTER.forEach(function (c) {
    if (!techsById[c.slug]) canonicalToCreate.push(c);
  });

  console.log('\n--- Canonical docs that need to be CREATED ---');
  if (canonicalToCreate.length === 0) {
    console.log('  (none — every canonical slug already has a doc)');
  } else {
    canonicalToCreate.forEach(function (c) {
      console.log('  +', c.slug.padEnd(12), '|', c.display_name.padEnd(14),
        '| email=' + (c.email || '(TODO — Kirby)'));
    });
  }

  // 6. Admins collection plan.
  console.log('\n--- admins/{email} plan ---');
  const ADMIN_CANONICAL = CANONICAL_ROSTER.filter(function (c) { return c.isAdmin; });
  const adminPlan = [];
  ADMIN_CANONICAL.forEach(function (c) {
    if (!c.email) {
      adminPlan.push({ email: '(TODO — ' + c.display_name + ')', action: 'skip_email_todo', canonical: c });
      return;
    }
    const key = c.email.toLowerCase();
    if (adminsById[key]) {
      adminPlan.push({ email: key, action: 'update_role', canonical: c });
    } else {
      adminPlan.push({ email: key, action: 'create',     canonical: c });
    }
  });
  adminPlan.forEach(function (p) {
    console.log('  ' + p.email.padEnd(40) +
      ' → ' + p.action.padEnd(20) +
      ' | role=' + (p.canonical.role || ''));
  });

  // 7. Emails still missing summary.
  console.log('\n--- Emails still missing for canonical roster ---');
  const emailMissing = CANONICAL_ROSTER.filter(function (c) { return !c.email; });
  if (emailMissing.length === 0) {
    console.log('  (none)');
  } else {
    emailMissing.forEach(function (c) {
      console.log('  ⚠', c.slug, '|', c.full_name, '— ' + (c.emailTodo || 'email not set in CANONICAL_ROSTER'));
    });
  }

  console.log('\n--- Plan totals ---');
  console.log('  keep_canonical:        ', counters.keep);
  console.log('  merge_into_canonical:  ', counters.merge);
  console.log('  archive_test:          ', counters.archiveTest);
  console.log('  delete_safe_test:      ', counters.deleteTest);
  console.log('  archive_extra:         ', counters.archiveExtra);
  console.log('  canonical to create:   ', canonicalToCreate.length);
  console.log('  admin docs to create:  ', adminPlan.filter(function (p) { return p.action === 'create'; }).length);
  console.log('  admin docs to update:  ', adminPlan.filter(function (p) { return p.action === 'update_role'; }).length);
  console.log('================================================================');

  if (DRY_RUN) {
    console.log('\n DRY-RUN complete. No data written.');
    console.log(' Re-run with --apply to write canonical updates + admin docs.');
    console.log(' Add --archive-tests to also flip active=false on the archive_test rows.');
    console.log(' Add --delete-safe-tests to hard-delete dcr-test-cleaning-tech.');
    process.exit(0);
  }

  // ----------------------------------------------------------------------
  // APPLY
  // ----------------------------------------------------------------------
  console.log('\n--- Applying writes ---');
  let writes = 0;

  // Pass A: write canonical doc updates (with media migration absorbed
  // from any merge sources). This MUST run before pass B (archives)
  // so we never lose media from a duplicate.
  for (const c of CANONICAL_ROSTER) {
    const existingSnap = techsById[c.slug];
    const existing     = existingSnap ? (existingSnap.data() || {}) : {};
    // Pull all duplicate docs' data for media absorption.
    const mergeSources = (dupesByCanonicalSlug[c.slug] || []).map(function (d) { return d.data() || {}; });
    // Fold all sources into a single mergeSource object — first non-empty value wins.
    const mergeSource = {};
    mergeSources.forEach(function (src) {
      Object.keys(src).forEach(function (k) {
        if (mergeSource[k] === undefined) mergeSource[k] = src[k];
      });
    });

    const update = buildCanonicalUpdate(c, existing, mergeSource);
    // Hoist a clear "media migrated from" trace when we actually pulled
    // something so post-run audits can see the lineage.
    const migratedFrom = (dupesByCanonicalSlug[c.slug] || []).map(function (d) { return d.id; });
    if (migratedFrom.length) update.migrated_from = migratedFrom;

    try {
      const ref = db.collection('cleaning_techs').doc(c.slug);
      await ref.set(update, { merge: true });
      writes += 1;
      console.log('  ✓ wrote', c.slug, existingSnap ? '(updated)' : '(created)');
    } catch (e) {
      console.error('  ✗ canonical write failed for', c.slug, ':', e.message);
    }
  }

  // Pass B: handle archives + deletes.
  for (const p of plan) {
    if (p.action === "merge_into_canonical") {
      // Once the canonical absorbed the media, archive (or delete if
      // tagged safe). For now we ALWAYS archive merge sources — they
      // may have invite history / created_at the audit trail wants.
      try {
        await p.doc.ref.set(
          buildArchivePatch("merged into " + (p.canonical && p.canonical.slug)),
          { merge: true }
        );
        writes += 1;
        console.log('  ✓ archived merge source', p.doc.id);
      } catch (e) {
        console.error('  ✗ archive failed for', p.doc.id, ':', e.message);
      }
      continue;
    }
    if (p.action === "archive_test") {
      if (!FLAGS.archiveTests) {
        console.log('  · skipped archive_test (' + p.doc.id + ') — pass --archive-tests to apply');
        continue;
      }
      try {
        await p.doc.ref.set(buildArchivePatch("known test record"), { merge: true });
        writes += 1;
        console.log('  ✓ archived test doc', p.doc.id);
      } catch (e) { console.error('  ✗ archive failed for', p.doc.id, ':', e.message); }
      continue;
    }
    if (p.action === "delete_safe_test") {
      if (!FLAGS.deleteSafeTests) {
        console.log('  · skipped delete_safe_test (' + p.doc.id + ') — pass --delete-safe-tests to apply');
        continue;
      }
      // Hard delete. Spec only lets us do this for KNOWN_SAFE_TEST_SLUGS.
      if (!KNOWN_SAFE_TEST_SLUGS.has(p.doc.id)) {
        console.log('  ✗ refused to delete', p.doc.id, '(not in KNOWN_SAFE_TEST_SLUGS)');
        continue;
      }
      try {
        await p.doc.ref.delete();
        writes += 1;
        console.log('  ✓ DELETED safe test doc', p.doc.id);
      } catch (e) { console.error('  ✗ delete failed for', p.doc.id, ':', e.message); }
      continue;
    }
    if (p.action === "archive_extra") {
      try {
        await p.doc.ref.set(buildArchivePatch("not on canonical roster"), { merge: true });
        writes += 1;
        console.log('  ✓ archived extra doc', p.doc.id);
      } catch (e) { console.error('  ✗ archive failed for', p.doc.id, ':', e.message); }
      continue;
    }
    // keep_canonical handled by Pass A above.
  }

  // Pass C: admins/{email}.
  for (const ap of adminPlan) {
    if (ap.action === 'skip_email_todo') {
      console.log('  · skipped admins/{email} create for', ap.canonical.display_name,
        '(email TODO — set in CANONICAL_ROSTER + rerun)');
      continue;
    }
    try {
      const ref = db.collection('admins').doc(ap.email);
      const payload = {
        email:      ap.email,
        role:       ap.canonical.role,
        active:     true,
        display_name: ap.canonical.display_name,
        full_name:   ap.canonical.full_name,
        tech_slug:   ap.canonical.slug,
        isOfficeManager: !!ap.canonical.isOfficeManager,
        normalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        normalizedBy: NORMALIZED_BY
      };
      await ref.set(payload, { merge: true });
      writes += 1;
      console.log('  ✓ admins write', ap.email, '(' + ap.action + ')');
    } catch (e) {
      console.error('  ✗ admins write failed for', ap.email, ':', e.message);
    }
  }

  console.log('\n--- Apply complete ---');
  console.log('  total writes:', writes);
  console.log('================================================================');
  console.log('\n Next:');
  console.log('   1. Run the cache backfill so emails flow into deputy_shift_cache:');
  console.log('      DRY_RUN=false node scripts/backfill-deputy-shift-cache-emails.js');
  console.log('   2. In the admin UI (Core Ops → Cleaning Techs), click Send invite for each');
  console.log('      cleaning tech you want to onboard.');

  process.exit(0);
}

main().catch(function (err) {
  console.error('fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});
