// scripts/seed-customers.js
//
// Seeds Pioneer Commercial Cleaning customers into the `customers` collection
// of the pioneer-dcr-hub Firebase project.
//
// Project:        pioneer-dcr-hub
// Storage bucket: pioneer-dcr-hub.firebasestorage.app   (reference only; not used here)
// Collection:     customers   (the ONLY collection this script touches)
//
// Safe defaults:
//   DRY_RUN = true            -> no writes, just prints the plan
//   FORCE_OVERWRITE = false   -> existing docs are skipped (never deleted)
//
// This script:
//   - never deletes
//   - never deploys
//   - never touches dcr_submissions or any other collection
//   - uses customer_slug as the Firestore document ID
//   - preserves created_at on overwrite (when explicitly enabled)
//
// Usage:
//   DRY_RUN=true  node scripts/seed-customers.js
//   DRY_RUN=false node scripts/seed-customers.js
//   DRY_RUN=false FORCE_OVERWRITE=true node scripts/seed-customers.js   (DANGEROUS)

const admin = require('firebase-admin');

const DRY_RUN = process.env.DRY_RUN !== 'false';                // default true
const FORCE_OVERWRITE = process.env.FORCE_OVERWRITE === 'true'; // default false
const PROJECT_ID = 'pioneer-dcr-hub';
const STORAGE_BUCKET = 'pioneer-dcr-hub.firebasestorage.app';   // reference only
const COLLECTION = 'customers';

// --- Initialize Admin SDK ---------------------------------------------------
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
      storageBucket: STORAGE_BUCKET,
    });
  } catch (e) {
    const sa = require('../serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: PROJECT_ID,
      storageBucket: STORAGE_BUCKET,
    });
  }
}

const db = admin.firestore();

// --- Hard safety check: refuse to run against any other project -------------
const actualProject =
  (admin.app().options && admin.app().options.projectId) || PROJECT_ID;
if (actualProject !== PROJECT_ID) {
  console.error(
    `Refusing to run: connected to project "${actualProject}", expected "${PROJECT_ID}".`
  );
  process.exit(1);
}

// --- Customer data ----------------------------------------------------------
const CUSTOMERS = [
  { slug: '6817-cedar',              name: '6817 Cedar LLC',                                  location: '6817 Cedar LLC' },
  { slug: 'baker-commodities',       name: 'Baker Commodities, Inc.',                         location: 'Baker Commodities' },
  { slug: 'baker-construction',      name: 'Baker Construction & Development, INC.',          location: 'Baker Construction & Development' },
  { slug: 'brg-901n',                name: 'Breakthrough Recovery Group',                     location: '901N BRG' },
  { slug: 'brg-11711',               name: 'Breakthrough Recovery Group',                     location: 'BTRG 11711' },
  { slug: 'clearwater-construction', name: 'Clearwater Construction and Management LLC',      location: 'Clearwater Construction and Management' },
  { slug: 'divco',                   name: 'DIVCO',                                           location: 'DIVCO' },
  { slug: 'molgard-prosthodontics',  name: 'Dr. Max Molgard Prosthodontics and Esthetics',    location: 'Molgard Prosthodontics' },
  { slug: 'gilman-family-practice',  name: 'Gilman Family Practice',                          location: 'Gilman Family Practice' },
  { slug: 'high-country-property',   name: 'High Country Property Management',                location: 'High Country Property Management' },
  { slug: 'hormann-door',            name: 'Hormann Door',                                    location: 'Hormann Door' },
  { slug: 'lydig-construction',      name: 'Lydig Construction',                              location: 'Lydig Construction' },
  { slug: 'macdonald-miller',        name: 'MacDonald Miller Facility Solutions',             location: 'MacDonald Miller Facility Solutions' },
  { slug: 'mark-whittaker-cpa',      name: 'Mark Whittaker CPA, PS',                          location: 'Mark Whittaker CPA' },
  { slug: 'note-and-kidd',           name: 'Note and Kidd PLLC',                              location: 'Note and Kidd' },
  { slug: 'novelis-mmp-spokane',     name: 'Novelis MMP Spokane',                             location: 'Novelis MMP Spokane' },
  { slug: 'reality-homes',           name: 'Reality Homes, Inc',                              location: 'Reality Homes' },
  { slug: 'the-flint-building',      name: 'The Flint Building',                              location: 'The Flint Building' },
  { slug: 'vehrs-distributing',      name: "Vehr's Distributing Company",                     location: "Vehr's Distributing" },
];

// Sanity: detect duplicate slugs before doing anything
const slugSet = new Set();
for (const c of CUSTOMERS) {
  if (slugSet.has(c.slug)) {
    console.error(`Duplicate slug detected in source array: ${c.slug}`);
    process.exit(1);
  }
  slugSet.add(c.slug);
}

function buildDoc(c) {
  return {
    customer_slug: c.slug,
    customer_name: c.name,
    location_name: c.location,
    customer_email: '',
    active: true,
    dcr_enabled: true,
    review_links: { five_star_url: '', issue_url: '' },
    slack_channel: '',
    notes: '',
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
}

// --- Main -------------------------------------------------------------------
(async () => {
  console.log('--- Pioneer DCR Hub: customers seed ---');
  console.log(`Project:         ${PROJECT_ID}`);
  console.log(`Storage bucket:  ${STORAGE_BUCKET} (reference only)`);
  console.log(`Collection:      ${COLLECTION}`);
  console.log(`DRY_RUN:         ${DRY_RUN}`);
  console.log(`FORCE_OVERWRITE: ${FORCE_OVERWRITE}`);
  console.log(`Customers:       ${CUSTOMERS.length}`);
  console.log('---------------------------------------');

  let created = 0, skipped = 0, overwritten = 0;
  let wouldCreate = 0, wouldOverwrite = 0, wouldSkip = 0;

  for (const c of CUSTOMERS) {
    const ref = db.collection(COLLECTION).doc(c.slug);
    const snap = await ref.get();
    const exists = snap.exists;
    const data = buildDoc(c);

    if (exists && !FORCE_OVERWRITE) {
      console.log(`[SKIP existing] ${c.slug}  (${c.name} / ${c.location})`);
      if (DRY_RUN) wouldSkip++; else skipped++;
      continue;
    }

    const action = exists ? 'OVERWRITE' : 'CREATE';
    console.log(`[${DRY_RUN ? 'DRY-RUN ' : ''}${action}] ${c.slug}  (${c.name} / ${c.location})`);

    if (DRY_RUN) {
      if (exists) wouldOverwrite++; else wouldCreate++;
      continue;
    }

    // Preserve created_at on overwrite if present
    const payload = exists
      ? { ...data, created_at: snap.get('created_at') || data.created_at }
      : data;
    await ref.set(payload, { merge: false });
    if (exists) overwritten++; else created++;
  }

  console.log('---------------------------------------');
  if (DRY_RUN) {
    console.log(
      `DRY RUN complete. No writes performed. ` +
      `would_create=${wouldCreate} would_overwrite=${wouldOverwrite} would_skip=${wouldSkip}`
    );
  } else {
    console.log(`Done. created=${created} overwritten=${overwritten} skipped=${skipped}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
