/* Pioneer DCR Hub — Phase 1a seed: test service_assignments.
 *
 * Seeds 1-3 service_assignments docs for a known test tech so the
 * Phase 1b UI work has real data to render against. Uses the
 * existing dcr-test-cleaning-tech fixture by default.
 *
 * Behavior:
 *   • Targets a tech by slug (default: "dcr-test-cleaning-tech").
 *   • Looks up that tech's auth uid; fails if not present (tech must
 *     have signed in at least once).
 *   • Seeds assignments for today + tomorrow against the dcr-test
 *     customer by default. All open/pending; allows_flex_start: true.
 *   • Idempotent on assignment_id (a deterministic id per day+slug),
 *     so re-running on the same day is a no-op.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/seed-test-service-assignment.js
 *   DRY_RUN=false node scripts/seed-test-service-assignment.js
 *
 * Optional:
 *   TECH_SLUG=...    — different tech (default: dcr-test-cleaning-tech)
 *   CUSTOMER_SLUG=... — different customer (default: dcr-test-customer
 *                       OR the first customers/{slug} where active==true)
 *   DAYS=N           — how many days forward to seed (default: 2)
 */

"use strict";

const admin = require("firebase-admin");
const lib   = require("./lib/semi-monthly.js");

const DRY_RUN       = process.env.DRY_RUN !== "false";
const TECH_SLUG     = process.env.TECH_SLUG     || "dcr-test-cleaning-tech";
const CUSTOMER_SLUG = process.env.CUSTOMER_SLUG || null;  // resolved below
const DAYS          = parseInt(process.env.DAYS || "2", 10);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}
const db = admin.firestore();

function addDaysToYYYYMMDD(yyyyMmDd, days) {
  const base = new Date(yyyyMmDd + "T12:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return lib.pacificDateString(base);
}

// Deterministic doc id keeps the script idempotent within a day.
function makeAssignmentId(serviceDate, techSlug, customerSlug) {
  return ["sa", serviceDate, techSlug, customerSlug].join("__");
}

(async () => {
  console.log("--- Pioneer DCR Hub: test service_assignments seed ---");
  console.log("DRY_RUN:      ", DRY_RUN);
  console.log("TECH_SLUG:    ", TECH_SLUG);
  console.log("CUSTOMER_SLUG:", CUSTOMER_SLUG || "(auto)");
  console.log("DAYS:         ", DAYS);
  console.log("------------------------------------------------------");

  // Resolve the tech.
  const techRef  = db.collection("cleaning_techs").doc(TECH_SLUG);
  const techSnap = await techRef.get();
  if (!techSnap.exists) {
    console.error(`[ERROR] cleaning_techs/${TECH_SLUG} not found`);
    process.exit(2);
  }
  const tech = techSnap.data() || {};
  const staff_email = String(tech.email || "").toLowerCase().trim();
  if (!staff_email) {
    console.error(`[ERROR] cleaning_techs/${TECH_SLUG} has no email field — cannot resolve Firebase Auth uid without it`);
    process.exit(2);
  }
  // PioneerOps does not stamp uid on cleaning_techs docs — the auth uid
  // is the runtime identity resolved via firebase.auth().currentUser.
  // For this offline seed we look it up by email via the Admin SDK.
  let staff_uid;
  try {
    const user = await admin.auth().getUserByEmail(staff_email);
    staff_uid = user.uid;
  } catch (e) {
    if (e && e.code === "auth/user-not-found") {
      console.error(`[ERROR] No Firebase Auth user found for ${staff_email}.`);
      console.error("        Create the auth user first (e.g. via the admin '+ Add tech / Login setup' flow), then re-run.");
    } else {
      console.error(`[ERROR] Firebase Auth lookup failed for ${staff_email}:`, e && e.message);
    }
    process.exit(2);
  }
  const staff_display_name = tech.display_name || tech.displayName || TECH_SLUG;

  // Resolve the customer.
  let customerSlug = CUSTOMER_SLUG;
  let customerName = null;
  if (!customerSlug) {
    // Prefer the existing test fixture if present.
    const tryTest = await db.collection("customers").doc("dcr-test-customer").get();
    if (tryTest.exists) {
      customerSlug = "dcr-test-customer";
      customerName = (tryTest.data() || {}).name || "DCR Test Customer";
    } else {
      // Fall back to the first active customer.
      const anySnap = await db.collection("customers").where("active", "==", true).limit(1).get();
      if (anySnap.empty) {
        console.error("[ERROR] No active customers found and no CUSTOMER_SLUG override given.");
        process.exit(2);
      }
      const doc = anySnap.docs[0];
      customerSlug = doc.id;
      customerName = (doc.data() || {}).name || doc.id;
    }
  } else {
    const cSnap = await db.collection("customers").doc(customerSlug).get();
    if (!cSnap.exists) {
      console.error(`[ERROR] customers/${customerSlug} not found`);
      process.exit(2);
    }
    customerName = (cSnap.data() || {}).name || customerSlug;
  }

  // Build the assignment list.
  const todayPT = lib.pacificDateString();
  const assignments = [];
  for (let i = 0; i < DAYS; i++) {
    const serviceDate = addDaysToYYYYMMDD(todayPT, i);
    // Deadline: 10 PM Pacific on that service_date. Stored as ISO so the
    // backend can compute "remaining time" without needing a TZ helper.
    // (Pacific is UTC-7 during PDT; UTC-8 PST. Use a representative
    // "T22:00:00-07:00" — UI converts to local for display.)
    const deadlineIso = serviceDate + "T22:00:00-07:00";
    assignments.push({
      assignment_id:     makeAssignmentId(serviceDate, TECH_SLUG, customerSlug),
      service_date:      serviceDate,
      service_deadline:  deadlineIso,
      customerSlug:      customerSlug,
      customerName:      customerName
    });
  }

  let created = 0;
  let skipped = 0;

  for (const a of assignments) {
    const ref  = db.collection("service_assignments").doc(a.assignment_id);
    const snap = await ref.get();
    if (snap.exists) {
      console.log(`[SKIP existing] ${a.assignment_id}`);
      skipped += 1;
      continue;
    }
    const sts = admin.firestore.FieldValue.serverTimestamp();
    const payload = {
      assignment_id:      a.assignment_id,
      service_date:       a.service_date,
      staff_uid:          staff_uid,
      staff_email:        staff_email,
      staff_display_name: staff_display_name,

      customer_id:        a.customerSlug,
      customer_name:      a.customerName,
      location_id:        null,
      location_name:      null,
      location_address:   null,
      location_lat:       null,
      location_lon:       null,
      location_geofence_radius_m: null,

      service_window_start: null,
      service_deadline:    admin.firestore.Timestamp.fromDate(new Date(a.service_deadline)),
      estimated_minutes:   90,
      budget_minutes:      75,
      allows_flex_start:   true,

      status:              "assigned",
      status_changed_at:   sts,
      status_changed_by:   "seed-script",

      session_id:          null,
      dcr_submission_id:   null,

      created_at:   sts,
      created_by:   "seed-script",
      assigned_by:  "seed-script",
      updated_at:   sts,
      updated_by:   "seed-script",
      notes:        "Phase 1a test assignment — auto-seeded"
    };

    if (DRY_RUN) {
      console.log(`[DRY-RUN would create] ${a.assignment_id} — ${a.customerName} on ${a.service_date}`);
    } else {
      await ref.set(payload);
      console.log(`[CREATED] ${a.assignment_id} — ${a.customerName} on ${a.service_date} (deadline ${a.service_deadline})`);
    }
    created += 1;
  }

  console.log("------------------------------------------------------");
  console.log(DRY_RUN ? "Done (dry-run, no writes)." : "Done.");
  console.log(`Created: ${created}, Skipped (existing): ${skipped}`);
  if (DRY_RUN && created > 0) {
    console.log("Re-run with DRY_RUN=false to commit.");
  }
})().catch((err) => {
  console.error("seed-test-service-assignment failed:", err);
  process.exit(1);
});
