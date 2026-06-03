/* Sev-1 diagnostic — Drew / Whitaker / June 2 visibility failure.
 *
 * Walks every layer of the shift ingestion pipeline:
 *   1. cleaning_techs lookup (uid, email, slug, active)
 *   2. deputy_shift_cache for today (Pacific)
 *   3. service_assignments for today's window (what PTC queries)
 *   4. customers lookup for Whitaker slug + active state
 *   5. service-clock.js isAvailableNow() simulation (UI filter)
 *
 *   node scripts/diag-drew-whitaker.js
 */
"use strict";
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();
const TZ = "America/Los_Angeles";

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDaysPT(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

(async () => {
  console.log("================================================================");
  console.log("Sev-1 Trace — Drew / Whitaker / June 2");
  console.log("Today (Pacific): " + todayPT());
  console.log("================================================================");

  // ---- 1. cleaning_techs — find Drew by any reasonable signal
  console.log("\n--- 1. cleaning_techs lookup ---");
  const techsAll = await db.collection("cleaning_techs").get();
  const drewCandidates = techsAll.docs
    .map(d => Object.assign({ _id: d.id }, d.data() || {}))
    .filter(t => {
      const blob = [t._id, t.email, t.display_name, t.first_name, t.last_name, t.deputy_employee_name]
        .filter(Boolean).join(" ").toLowerCase();
      return /drew/.test(blob);
    });
  if (!drewCandidates.length) {
    console.error("  ❌ No tech with 'drew' in slug/email/name. STOP.");
    process.exit(2);
  }
  drewCandidates.forEach(t => {
    console.log("  Candidate: " + t._id);
    console.log("    email:               " + (t.email || "(none)"));
    console.log("    display_name:        " + (t.display_name || "(none)"));
    console.log("    first_name/last:     " + (t.first_name || "") + " / " + (t.last_name || ""));
    console.log("    uid:                 " + (t.uid || "(NOT SIGNED IN)"));
    console.log("    auth_uid:            " + (t.auth_uid || "(none)"));
    console.log("    active:              " + (t.active === false ? "FALSE (archived)" : "true"));
    console.log("    deputy_employee_email: " + (t.deputy_employee_email || "(none)"));
    console.log("    deputy_employee_id:  " + (t.deputy_employee_id || "(none)"));
  });

  // Pick the active Drew (most likely match)
  const drew = drewCandidates.find(t => t.active !== false) || drewCandidates[0];
  console.log("\n  >>> Using: " + drew._id + " (email=" + (drew.email || "?") + ", uid=" + (drew.uid || "ABSENT") + ")");

  // ---- 2. customers — find Whitaker
  console.log("\n--- 2. customers lookup (Whitaker) ---");
  const custsAll = await db.collection("customers").get();
  const whitCands = custsAll.docs
    .map(d => Object.assign({ _id: d.id }, d.data() || {}))
    .filter(c => {
      const blob = [c._id, c.customer_name, c.location_name].filter(Boolean).join(" ").toLowerCase();
      return /whitaker/.test(blob);
    });
  if (!whitCands.length) {
    console.error("  ❌ No customer with 'whitaker' in slug/name. STOP — Deputy → Pioneer mapping unresolved.");
  }
  whitCands.forEach(c => {
    console.log("  Customer: " + c._id);
    console.log("    customer_name:        " + c.customer_name);
    console.log("    location_name:        " + c.location_name);
    console.log("    active:               " + (c.active === false ? "FALSE" : "true"));
    console.log("    deputy_company_id:    " + (c.deputy_company_id || "(none)"));
    console.log("    deputy_company_name:  " + (c.deputy_company_name || "(none)"));
    console.log("    aliases:              " + (Array.isArray(c.aliases) ? c.aliases.join(", ") : "(none)"));
  });
  const whitaker = whitCands.find(c => c.active !== false) || whitCands[0] || null;

  // ---- 3. deputy_shift_cache for today + adjacent days (TZ defensive)
  console.log("\n--- 3. deputy_shift_cache — today's shifts for Drew ---");
  const today = todayPT();
  const dates = [addDaysPT(today, -1), today, addDaysPT(today, 1)];
  for (const d of dates) {
    const snap = await db.collection("deputy_shift_cache").where("sync_date", "==", d).get();
    const drewShifts = snap.docs
      .map(x => Object.assign({ _id: x.id }, x.data() || {}))
      .filter(s => {
        const e = (s.employee_email || "").toLowerCase();
        const slug = (s.employee_slug || "").toLowerCase();
        const dispB = (s.employee_display_name || "").toLowerCase();
        const drewEmail = (drew.email || "").toLowerCase();
        return (drewEmail && e === drewEmail) ||
               (drew._id && slug === drew._id.toLowerCase()) ||
               /drew/.test(dispB);
      });
    console.log("  " + d + " · " + snap.size + " total shifts · " + drewShifts.length + " match Drew");
    drewShifts.forEach(s => {
      console.log("    shift " + s.shift_id + " · status=" + s.status);
      console.log("      employee_email:      " + s.employee_email);
      console.log("      employee_slug:       " + s.employee_slug);
      console.log("      employee_display:    " + s.employee_display_name);
      console.log("      customer_slug:       " + (s.customer_slug || "(EMPTY — unmapped)"));
      console.log("      customer_name:       " + (s.customer_name || "(empty)"));
      console.log("      deputy_company_name: " + s.deputy_company_name);
      console.log("      operational_unit_name: " + s.operational_unit_name);
      console.log("      match_source:        " + s.match_source);
      console.log("      start/end:           " + s.start_time + " → " + s.end_time);
    });
  }

  // ---- 4. service_assignments — what PTC queries
  console.log("\n--- 4. service_assignments — what /work Pioneer Time Clock queries ---");
  if (!drew.uid) {
    console.error("  ❌ Drew has NO auth uid on her cleaning_techs doc.");
    console.error("     PTC query is .where(staff_uid==auth.uid). No assignments will ever match.");
    console.error("     Cause: she has not signed in to PioneerOps yet, OR her cleaning_techs doc lost its uid stamp.");
  } else {
    const lookback = addDaysPT(today, -1);
    const lookahead = addDaysPT(today, 3);
    const saSnap = await db.collection("service_assignments")
      .where("staff_uid", "==", drew.uid)
      .where("service_date", ">=", lookback)
      .where("service_date", "<=", lookahead)
      .get();
    console.log("  Query: staff_uid=" + drew.uid + " AND service_date in [" + lookback + ", " + lookahead + "]");
    console.log("  Returned: " + saSnap.size + " assignment(s)");
    saSnap.docs.forEach(d => {
      const a = d.data();
      console.log("    " + d.id);
      console.log("      service_date:         " + a.service_date);
      console.log("      customer_id:          " + a.customer_id);
      console.log("      customer_name:        " + a.customer_name);
      console.log("      status:               " + a.status);
      console.log("      admin_removed:        " + (a.admin_removed === true ? "TRUE (archived)" : "false"));
      console.log("      removed_from_ptc:     " + (a.removed_from_ptc === true ? "TRUE" : "false"));
      console.log("      source:               " + a.source);
      console.log("      deputy_shift_id:      " + a.deputy_shift_id);
      console.log("      available_from:       " + (a.available_from ? a.available_from.toDate() : "(null)"));
      console.log("      available_until:      " + (a.available_until ? a.available_until.toDate() : "(null)"));
      console.log("      service_window_start: " + (a.service_window_start ? a.service_window_start.toDate() : "(null)"));
      console.log("      service_deadline:     " + (a.service_deadline ? a.service_deadline.toDate() : "(null)"));
    });
    // Filter to what /work would actually render after the Phase 2A.2
    // exclude-removed + isAvailableNow filter.
    const visible = saSnap.docs
      .map(d => Object.assign({ _id: d.id }, d.data()))
      .filter(a => a.removed_from_ptc !== true && a.status !== "admin_removed");
    console.log("\n  After PTC client filter (removed_from_ptc / admin_removed): " + visible.length);
  }

  // ---- 5. Summary diagnosis
  console.log("\n================================================================");
  console.log("DIAGNOSIS");
  console.log("================================================================");
  if (!drew.uid) {
    console.log("⚠ ROOT CAUSE: Drew's cleaning_techs/" + drew._id + " has NO `uid` field.");
    console.log("  Without uid, the Phase 2A.1 bridge SKIPS her shifts (uid_unresolved),");
    console.log("  and PTC's .where(staff_uid == auth.uid) returns 0 docs.");
    console.log("  Fix: have Drew sign in to PioneerOps once so cleaning_techs.uid gets stamped,");
    console.log("       then re-run the bridge (admin: Refresh Pioneer Time Clock from Deputy).");
    return;
  }
  if (!whitaker) {
    console.log("⚠ ROOT CAUSE CANDIDATE: No customers/{whitaker} doc found.");
    console.log("  Even if Drew has Deputy shifts, the bridge skips them (customer_unresolved).");
  }
})().catch(e => { console.error("Diagnostic failed:", e); process.exit(1); });
