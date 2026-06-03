/* Bridge skip audit — enumerate every Deputy shift that would skip the
 * Phase 2A.1 bridge for today + tomorrow with the actionable fix per
 * shift. Replicates the bridge's reject reasons by mirroring the same
 * checks against deputy_shift_cache + admin.auth().getUserByEmail().
 *
 *   node scripts/bridge-skip-audit.js
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
const db = admin.firestore();
const TZ = "America/Los_Angeles";

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}
function addDaysPT(ymd, n) {
  const [y,m,d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d)); dt.setUTCDate(dt.getUTCDate()+n);
  return dt.toISOString().slice(0,10);
}

(async () => {
  const today = todayPT();
  const dates = [today, addDaysPT(today, 1)];
  console.log("Bridge skip audit · dates: " + dates.join(", "));
  console.log("================================================================");

  const summary = {
    created: 0, would_update: 0,
    skipped_uid_unresolved: [], skipped_no_email: [],
    skipped_customer_unresolved: [], skipped_other: []
  };

  // Cache uid resolution to avoid hammering Auth API
  const uidCache = {};
  async function resolveUid(email) {
    if (!email) return null;
    const k = email.toLowerCase().trim();
    if (uidCache[k] !== undefined) return uidCache[k];
    try { uidCache[k] = (await admin.auth().getUserByEmail(k)).uid; }
    catch { uidCache[k] = null; }
    return uidCache[k];
  }

  for (const d of dates) {
    const snap = await db.collection("deputy_shift_cache").where("sync_date","==",d).get();
    console.log("\n--- " + d + " · " + snap.size + " Deputy shifts ---");
    for (const doc of snap.docs) {
      const s = doc.data();
      const tag = "shift " + s.shift_id + " · " + (s.employee_display_name||"?") + " → " + (s.customer_name||s.deputy_company_name||"?");

      if (String(s.status||"") === "cancelled") {
        console.log("  [skip cancelled] " + tag);
        continue;
      }
      if (!s.customer_slug) {
        console.log("  ❌ [SKIP customer_unresolved] " + tag);
        console.log("       deputy_company_name: " + s.deputy_company_name);
        console.log("       fix: map this Deputy company in /admin → Deputy Mapping or add an alias to customers/{slug}");
        summary.skipped_customer_unresolved.push({
          shift_id: s.shift_id, employee: s.employee_display_name, deputy_company: s.deputy_company_name
        });
        continue;
      }
      if (!s.employee_email) {
        console.log("  ❌ [SKIP no_email] " + tag);
        console.log("       employee_slug: " + s.employee_slug + " · employee_display: " + s.employee_display_name);
        console.log("       fix: ensure cleaning_techs/" + s.employee_slug + " carries an email field, then resync Deputy");
        summary.skipped_no_email.push({
          shift_id: s.shift_id, employee_slug: s.employee_slug, employee: s.employee_display_name
        });
        continue;
      }
      const uid = await resolveUid(s.employee_email);
      if (!uid) {
        console.log("  ❌ [SKIP uid_unresolved] " + tag);
        console.log("       email: " + s.employee_email + " · employee_display: " + s.employee_display_name);
        console.log("       fix: tech must sign in to PioneerOps ONCE at /work (creates Firebase Auth account)");
        summary.skipped_uid_unresolved.push({
          shift_id: s.shift_id, email: s.employee_email, employee: s.employee_display_name
        });
        continue;
      }
      // Resolves — check if assignment exists
      const aid = "sa_deputy__" + s.shift_id;
      const existing = await db.collection("service_assignments").doc(aid).get();
      if (existing.exists) {
        console.log("  ✅ [exists] " + tag + " (sa_deputy__" + s.shift_id + ", state=" + existing.data().status + ")");
        summary.would_update += 1;
      } else {
        console.log("  ➕ [would create] " + tag + " (uid=" + uid.slice(0,12) + "…)");
        summary.created += 1;
      }
    }
  }

  console.log("\n================================================================");
  console.log("SUMMARY");
  console.log("================================================================");
  console.log("Would create (missing assignment):     " + summary.created);
  console.log("Existing (would refresh fields only):  " + summary.would_update);
  console.log("SKIP customer_unresolved:              " + summary.skipped_customer_unresolved.length);
  console.log("SKIP no_email:                         " + summary.skipped_no_email.length);
  console.log("SKIP uid_unresolved:                   " + summary.skipped_uid_unresolved.length);
  console.log("");

  function listGroup(label, arr, keys) {
    if (!arr.length) return;
    console.log(label + ":");
    arr.forEach(x => {
      console.log("  • shift " + x.shift_id + " — " + keys.map(k => k + "=" + (x[k]||"?")).join(", "));
    });
  }
  listGroup("\nuid_unresolved (tech needs to sign into /work once)", summary.skipped_uid_unresolved, ["email","employee"]);
  listGroup("\nno_email (cleaning_techs doc missing email)", summary.skipped_no_email, ["employee_slug","employee"]);
  listGroup("\ncustomer_unresolved (Deputy company not mapped)", summary.skipped_customer_unresolved, ["deputy_company","employee"]);
})().catch(e => { console.error(e); process.exit(1); });
