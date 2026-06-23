/* Pioneer DCR Hub — Phase 2A.2 manual GHL hiring sync.
 *
 * Runs the same sync core that Cloud Functions runs on schedule, but
 * locally with the serviceAccountKey. Useful for:
 *   - First-time validation before deploying the scheduled function.
 *   - Forcing a snapshot refresh during business hours without waiting
 *     for the 06:30 PT scheduled run.
 *   - Debugging a stage-name mismatch (the log output dumps the resolved
 *     pipeline + per-stage breakdown).
 *
 * Usage:
 *   GHL_PRIVATE_INTEGRATION_TOKEN=pit-... node scripts/run-ghl-hiring-sync.js
 *
 * The token is read from the env var only — never read from disk, never
 * persisted by this script. Pass it inline or export it for one shell:
 *   export GHL_PRIVATE_INTEGRATION_TOKEN=pit-...
 *   node scripts/run-ghl-hiring-sync.js
 *
 * Writes office_manager_hiring_snapshots/{YYYY-MM-DD} (Pacific date).
 * Cleanup: node scripts/cleanup-hiring-snapshots-test.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json")),
  });
}

const ghlHiringSync = require("../functions/ghlHiringSync");

async function main() {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  if (!token) {
    console.error("[ghl-sync] GHL_PRIVATE_INTEGRATION_TOKEN env var is required");
    console.error("");
    console.error("  Usage:");
    console.error("    GHL_PRIVATE_INTEGRATION_TOKEN=pit-... node scripts/run-ghl-hiring-sync.js");
    process.exit(1);
  }

  console.log("[ghl-sync] starting manual sync...");
  const result = await ghlHiringSync.runSync({
    token:     token,
    db:        admin.firestore(),
    invokedBy: "local-script"
  });

  console.log("[ghl-sync] result:");
  console.log(JSON.stringify(result, null, 2));

  if (result.skipped) {
    console.error("[ghl-sync] sync skipped:", result.reason);
    process.exit(2);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error("[ghl-sync] FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
