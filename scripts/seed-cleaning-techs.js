const admin = require('firebase-admin');
const fs = require('fs');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const FORCE_OVERWRITE = process.env.FORCE_OVERWRITE === 'true';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('../serviceAccountKey.json')),
  });
}

const db = admin.firestore();

const techs = JSON.parse(
  fs.readFileSync('./data/cleaning-techs.json', 'utf8')
);

(async () => {
  console.log('--- Pioneer DCR Hub: cleaning techs seed ---');
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`FORCE_OVERWRITE: ${FORCE_OVERWRITE}`);
  console.log(`Tech count: ${techs.length}`);
  console.log('--------------------------------------------');

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const tech of techs) {
    const ref = db.collection('cleaning_techs').doc(tech.tech_slug);
    const snap = await ref.get();

    if (snap.exists && !FORCE_OVERWRITE) {
      console.log(`[SKIP existing] ${tech.tech_slug}`);
      skipped++;
      continue;
    }

    const payload = {
      tech_slug: tech.tech_slug,
      display_name: tech.display_name,
      active: tech.active,
      dcr_enabled: tech.dcr_enabled,

      metrics_cache: {
        total_dcrs: 0,
        perfect_cleans: 0,
        issue_count: 0,
        customer_rating_avg: null,
        five_star_count: 0,
        supply_requests_count: 0,
        over_budget_count: 0,
        last_dcr_at: null
      },

      recognition: {
        last_recognized_at: null,
        recognition_count: 0,
        badges: []
      },

      happiness: {
        last_reported_level: null,
        trend: "unknown",
        notes: ""
      },

      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    };

    console.log(
      `[${DRY_RUN ? 'DRY-RUN ' : ''}${snap.exists ? 'OVERWRITE' : 'CREATE'}] ${tech.tech_slug}`
    );

    if (!DRY_RUN) {
      await ref.set(payload, { merge: false });

      if (snap.exists) overwritten++;
      else created++;
    }
  }

  console.log('--------------------------------------------');

  if (DRY_RUN) {
    console.log('DRY RUN complete. No writes performed.');
  } else {
    console.log(
      `Done. created=${created} overwritten=${overwritten} skipped=${skipped}`
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
