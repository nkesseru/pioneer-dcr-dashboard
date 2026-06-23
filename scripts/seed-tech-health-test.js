/* Pioneer DCR Hub — Tech Health verification seed.
 *
 * Creates 4 call_outs + 2 over-budget dcr_submissions for ONE existing
 * cleaning tech so the Tech Health dashboard flips them to
 * "Needs Support" (the 4-callout threshold trumps the 2-DCR Watch
 * threshold). Each record is stamped with:
 *
 *   _testSeed:     true
 *   _testSeedNote: "TEST_TECH_HEALTH — delete after verification"
 *
 * Doc IDs are hard-coded prefixes (_test_health_callout_N,
 * _test_health_dcr_N) so the cleanup script can delete by ID without
 * ever needing to scan or filter the real collections.
 *
 * Usage:
 *   node scripts/seed-tech-health-test.js              # uses drew-c
 *   TECH_SLUG=april-k node scripts/seed-tech-health-test.js
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json")),
  });
}
const db = admin.firestore();

const TECH_SLUG = process.env.TECH_SLUG || "drew-c";
const SEED_NOTE = "TEST_TECH_HEALTH — delete after verification";

const REASONS = ["sick", "transportation", "family", "sick"];   // 4 call-outs

async function main() {
  console.log("--- Tech Health TEST seed ---");
  console.log("Target tech slug:", TECH_SLUG);
  console.log("");

  // Resolve the tech doc so the display_name on each record matches.
  const techSnap = await db.collection("cleaning_techs").doc(TECH_SLUG).get();
  if (!techSnap.exists) {
    console.error("FATAL: cleaning_techs/" + TECH_SLUG + " not found. Pass TECH_SLUG=<existing-slug>.");
    process.exit(1);
  }
  const tech = techSnap.data() || {};
  const techName = tech.display_name || tech.name || TECH_SLUG;
  console.log("Resolved display_name:", techName);
  console.log("");

  // 4 call_outs, one per recent day.
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const id = "_test_health_callout_" + (i + 1);
    const submittedAt = new Date(now.getTime() - (i + 1) * 86400000); // 1, 2, 3, 4 days ago
    const date = submittedAt.toISOString().slice(0, 10);
    const reason = REASONS[i];
    const payload = {
      techId:         TECH_SLUG,
      techName:       techName,
      techUid:        "TEST_UID_" + TECH_SLUG,
      techEmail:      "test+" + TECH_SLUG + "@pioneercomclean.com",
      date:           date,
      shiftCustomer:  null,
      reason:         reason,
      note:           "TEST SEED — auto-generated for Tech Health verification.",
      submittedAt:    admin.firestore.Timestamp.fromDate(submittedAt),
      status:         "new",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt:     null,
      resolvedBy:     null,
      coverageNote:   null,
      _testSeed:      true,
      _testSeedNote:  SEED_NOTE
    };
    await db.collection("call_outs").doc(id).set(payload);
    console.log("  call_outs/" + id + " — " + reason + " — " + date);
  }

  // 2 over-budget DCRs — match production shape from app.js. The
  // canonical signal is `timeBudget.withinBudget === false`. Legacy
  // mirror fields are also set so any older reader path works.
  for (let i = 0; i < 2; i++) {
    const id = "_test_health_dcr_" + (i + 1);
    const submittedAt = new Date(now.getTime() - (i + 1) * 86400000 - 3600000); // skew by 1h
    const payload = {
      tech_slug:               TECH_SLUG,
      tech_display_name:       techName,
      customer_slug:           "_test_customer_seed",
      customer_name:           "TEST Customer (seed)",
      submittedAt:             admin.firestore.Timestamp.fromDate(submittedAt),
      // Canonical over-budget shape (matches app.js form_data block).
      timeBudget: {
        withinBudget: false,
        reasons:      ["other"],
        reasonsOther: "TEST SEED — flagged over-budget for Tech Health verification."
      },
      overBudgetReason:        "other",
      overBudgetNote:          "TEST SEED — flagged over-budget for Tech Health verification.",
      time_budget_other_note:  "TEST SEED — flagged over-budget for Tech Health verification.",
      _testSeed:               true,
      _testSeedNote:           SEED_NOTE
    };
    await db.collection("dcr_submissions").doc(id).set(payload);
    console.log("  dcr_submissions/" + id + " — over-budget (timeBudget.withinBudget=false) — " + submittedAt.toISOString());
  }

  console.log("");
  console.log("Seed complete.");
  console.log("");
  console.log("Verify:");
  console.log("  1. Open https://pioneer-dcr-hub.web.app/admin");
  console.log("  2. Quality → Tech Health tab");
  console.log("  3. " + techName + " should show 'Needs Support' (4 call-outs)");
  console.log("     with 'What we're watching: 4 call-outs · 2 over-budget DCRs'");
  console.log("");
  console.log("Cleanup when done:");
  console.log("  node scripts/cleanup-tech-health-test.js");
}

main().catch(function (err) {
  console.error("Seed failed:", err);
  process.exit(1);
});
