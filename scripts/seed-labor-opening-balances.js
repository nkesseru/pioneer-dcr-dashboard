/* Pioneer DCR Hub — Phase 1a seed: opening sick-leave balances.
 *
 * Writes one `opening_balance` ledger entry + the matching
 * `staff_labor_balances` doc per active tech, from values an admin
 * enters in scripts/opening-balances.json.
 *
 * IMPORTANT:
 *   • This script does NOT default to zero. Every staff to be seeded
 *     must appear explicitly in opening-balances.json (use 0 if zero).
 *   • Cap = 2400 minutes (40h). Values above the cap require an explicit
 *     allow_above_cap: true flag per entry (admin override).
 *   • Idempotent: if a staff_labor_balances doc already exists, the
 *     entry is skipped. Corrections after-the-fact must use the admin
 *     adjustment ledger entry (entry_type="admin_adjustment").
 *
 * Usage:
 *   1. Copy scripts/opening-balances.example.json → scripts/opening-balances.json
 *   2. Fill in real values + reasons.
 *   3. DRY_RUN=true  node scripts/seed-labor-opening-balances.js   (preview)
 *      DRY_RUN=false node scripts/seed-labor-opening-balances.js   (commit)
 *
 * Optional:
 *   ADMIN_EMAIL=... — recorded as created_by on the ledger entry
 *                     (default: "seed-script").
 *   CONFIG_PATH=...  — alternate path to the JSON config (default
 *                     scripts/opening-balances.json).
 */

"use strict";

const admin = require("firebase-admin");
const fs    = require("fs");
const path  = require("path");
const lib   = require("./lib/semi-monthly.js");

const DRY_RUN     = process.env.DRY_RUN !== "false";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "seed-script";
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "opening-balances.json");
const CAP_MINUTES = lib.SICK_LEAVE_CAP_MINUTES;

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("[ERROR] Config file missing: " + CONFIG_PATH);
  console.error("Copy scripts/opening-balances.example.json → scripts/opening-balances.json and fill in real values.");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const entries = raw.entries || {};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

(async () => {
  console.log("--- Pioneer DCR Hub: opening sick-leave balances seed ---");
  console.log("DRY_RUN:    ", DRY_RUN);
  console.log("ADMIN_EMAIL:", ADMIN_EMAIL);
  console.log("CONFIG_PATH:", CONFIG_PATH);
  console.log("Entries:    ", Object.keys(entries).length);
  console.log("Cap:        ", CAP_MINUTES + " minutes (40h)");
  console.log("---------------------------------------------------------");

  let created = 0;
  let skipped = 0;
  let warned  = 0;
  let errored = 0;

  const effective_date = lib.pacificDateString();

  for (const [emailRaw, cfg] of Object.entries(entries)) {
    const email = String(emailRaw || "").toLowerCase().trim();
    if (!email) continue;

    const minutes = Math.round(Number(cfg.opening_balance_minutes));
    if (!Number.isFinite(minutes) || minutes < 0) {
      console.error(`[ERROR] ${email}: opening_balance_minutes must be a non-negative integer; got ${cfg.opening_balance_minutes}`);
      errored += 1;
      continue;
    }

    if (minutes > CAP_MINUTES && !cfg.allow_above_cap) {
      console.error(`[ERROR] ${email}: ${minutes} min exceeds cap ${CAP_MINUTES}. Set allow_above_cap: true to override.`);
      errored += 1;
      continue;
    }

    // Look up the tech's auth uid via their cleaning_techs doc.
    // cleaning_techs are keyed by slug, but contain the email field.
    const techSnap = await db.collection("cleaning_techs")
      .where("email", "==", email)
      .limit(1)
      .get();
    if (techSnap.empty) {
      console.warn(`[WARN ] ${email}: no cleaning_techs doc with this email; skipping`);
      warned += 1;
      continue;
    }
    const techDoc = techSnap.docs[0];
    const techData = techDoc.data() || {};
    // The auth uid lives on the tech doc as `uid` (or `auth_uid`) once
    // the tech has signed in at least once. If missing, we still seed
    // by email but log a warning — the balance doc id IS the uid.
    const staff_uid = techData.uid || techData.auth_uid || null;
    if (!staff_uid) {
      console.warn(`[WARN ] ${email}: no auth uid on cleaning_techs/${techDoc.id}; skipping (tech must sign in once first, then re-run)`);
      warned += 1;
      continue;
    }

    // Idempotency: skip if balance doc already exists.
    const balanceRef  = db.collection("staff_labor_balances").doc(staff_uid);
    const balanceSnap = await balanceRef.get();
    if (balanceSnap.exists) {
      console.log(`[SKIP existing] ${email} (uid=${staff_uid}) — staff_labor_balances doc already present; use admin_adjustment to change`);
      skipped += 1;
      continue;
    }

    const reason = String(cfg.reason || "Opening balance seeded by " + ADMIN_EMAIL);

    if (DRY_RUN) {
      console.log(`[DRY-RUN would seed] ${email} (uid=${staff_uid}) — ${minutes} min (${lib.formatMinutesAsHm(minutes)})`);
      created += 1;
      continue;
    }

    const sts = admin.firestore.FieldValue.serverTimestamp();
    const ledgerRef = db.collection("sick_leave_ledger").doc();

    // Two writes in one batch — ledger entry + balance doc.
    const batch = db.batch();
    batch.set(ledgerRef, {
      staff_uid:      staff_uid,
      staff_email:    email,
      entry_type:     "opening_balance",
      minutes_delta:  minutes,
      effective_date: effective_date,
      reason:         reason,
      source: {
        kind:   "migration",
        ref_id: null
      },
      basis:        null,
      created_at:   sts,
      created_by:   ADMIN_EMAIL,
      batch_id:     null
    });
    batch.set(balanceRef, {
      staff_uid:                        staff_uid,
      staff_email:                      email,
      sick_leave_balance_minutes:       minutes,
      sick_leave_lifetime_earned_minutes:    0,
      sick_leave_lifetime_used_minutes:      0,
      sick_leave_lifetime_adjusted_minutes:  0,
      sick_leave_lifetime_forfeited_minutes: 0,
      sick_leave_opening_balance_minutes: minutes,
      current_period_id:                       null,
      current_period_work_minutes:             0,
      current_period_paid_drive_minutes:       0,
      current_period_paid_minutes:             0,
      current_period_sick_accrual_estimated_minutes: 0,
      hire_date:                  techData.hire_date || null,
      sick_leave_usable_after:    null,
      last_ledger_entry_id:       ledgerRef.id,
      last_ledger_entry_at:       sts,
      updated_at:                 sts,
      updated_by:                 ADMIN_EMAIL
    });
    await batch.commit();
    console.log(`[CREATED] ${email} (uid=${staff_uid}) — ${minutes} min (${lib.formatMinutesAsHm(minutes)}) — ledger=${ledgerRef.id}`);
    created += 1;
  }

  console.log("---------------------------------------------------------");
  console.log(DRY_RUN ? "Done (dry-run, no writes)." : "Done.");
  console.log(`Created: ${created}, Skipped: ${skipped}, Warned: ${warned}, Errored: ${errored}`);
  if (DRY_RUN && created > 0) {
    console.log("Re-run with DRY_RUN=false to commit.");
  }
  if (errored > 0) {
    process.exit(2);
  }
})().catch((err) => {
  console.error("seed-labor-opening-balances failed:", err);
  process.exit(1);
});
