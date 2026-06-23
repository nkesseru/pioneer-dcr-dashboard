/* Pioneer DCR Hub — Phase 1a seed: payroll_periods.
 *
 * Bootstraps the semi-monthly payroll period collection.
 *
 * Behavior:
 *   • Computes the CURRENT period from today's Pacific date.
 *   • Writes that period + the next 5 periods (covers ~3 months ahead).
 *   • Idempotent — existing periods are skipped (not overwritten).
 *
 * Usage:
 *   DRY_RUN=true  node scripts/seed-payroll-periods.js     (default; preview)
 *   DRY_RUN=false node scripts/seed-payroll-periods.js     (commits writes)
 *
 * Optional:
 *   AHEAD=N  — how many additional periods to seed beyond current (default 5).
 *   FROM=YYYY-MM-DD — explicit starting date instead of today (for replays).
 */

"use strict";

const admin = require("firebase-admin");
const lib   = require("./lib/semi-monthly.js");

const DRY_RUN = process.env.DRY_RUN !== "false";
const AHEAD   = parseInt(process.env.AHEAD || "5", 10);
const FROM    = process.env.FROM || lib.pacificDateString();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

(async () => {
  console.log("--- Pioneer DCR Hub: payroll_periods seed ---");
  console.log("DRY_RUN:", DRY_RUN);
  console.log("FROM:   ", FROM);
  console.log("AHEAD:  ", AHEAD);
  console.log("---------------------------------------------");

  // Build the period list: current + next AHEAD periods.
  const periods = [];
  let current = lib.getSemiMonthlyPeriod(FROM);
  periods.push(current);
  for (let i = 0; i < AHEAD; i++) {
    current = lib.nextSemiMonthlyPeriod(current.period_id);
    periods.push(current);
  }

  let created = 0;
  let skipped = 0;

  for (const p of periods) {
    const ref  = db.collection("payroll_periods").doc(p.period_id);
    const snap = await ref.get();
    if (snap.exists) {
      console.log(`[SKIP existing] ${p.period_id} (${p.period_label})`);
      skipped += 1;
      continue;
    }
    const payload = {
      period_id:    p.period_id,
      period_label: p.period_label,
      month:        p.month,
      half:         p.half,
      start_date:   p.start_date,
      end_date:     p.end_date,
      payday:       p.payday,
      status:       "open",
      status_changed_at: admin.firestore.FieldValue.serverTimestamp(),
      status_changed_by: "seed-script",
      closed_at:    null,
      closed_by:    null,
      paid_at:      null,
      paid_by:      null,
      close_summary: null,
      created_at:   admin.firestore.FieldValue.serverTimestamp(),
      created_by:   "seed-script"
    };
    if (DRY_RUN) {
      console.log(`[DRY-RUN would create] ${p.period_id} (${p.start_date} .. ${p.end_date}, payday ${p.payday})`);
    } else {
      await ref.set(payload);
      console.log(`[CREATED] ${p.period_id} (${p.start_date} .. ${p.end_date}, payday ${p.payday})`);
    }
    created += 1;
  }

  console.log("---------------------------------------------");
  console.log(DRY_RUN ? "Done (dry-run, no writes)." : "Done.");
  console.log(`Created: ${created}, Skipped (existing): ${skipped}`);
  if (DRY_RUN && created > 0) {
    console.log("Re-run with DRY_RUN=false to commit.");
  }
})().catch((err) => {
  console.error("seed-payroll-periods failed:", err);
  process.exit(1);
});
