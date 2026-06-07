/* Regression tests for the shared assignment-eligibility helper.
 *
 * The 5 scenarios in the Phase 33 spec, plus a sixth that reproduces
 * the original incident (Drew → DIVCO → Friday → invisible) so we
 * never re-introduce it.
 *
 * Runs the actual public/assignment-eligibility.js module — no mocks,
 * no shims, no shadow implementation. The same file the browser loads
 * is the file the tests exercise.
 *
 *   node scripts/test-assignment-eligibility.js
 */
"use strict";

var ELIG = require("../public/assignment-eligibility.js");

var passed = 0;
var failed = 0;
var lines  = [];

function ts(yyyymmdd, hh, mm) {
  // Build a Pacific wall-clock millis for the given Pacific date + time.
  // Uses the Intl machinery to learn the offset on that calendar date.
  var probeNoon = new Date(yyyymmdd + "T12:00:00Z");
  var partsFmt  = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "longOffset"
  }).formatToParts(probeNoon);
  var off = "+00:00";
  for (var i = 0; i < partsFmt.length; i++) {
    if (partsFmt[i].type === "timeZoneName") {
      var m = /GMT([+-]\d{2}:\d{2})/.exec(partsFmt[i].value);
      if (m) off = m[1];
    }
  }
  var iso = yyyymmdd + "T" +
    String(hh || 0).padStart(2, "0") + ":" +
    String(mm || 0).padStart(2, "0") + ":00" + off;
  return { toMillis: function () { return new Date(iso).getTime(); } };
}

function pacMillis(yyyymmdd, hh, mm) {
  return ts(yyyymmdd, hh, mm).toMillis();
}

function assert(name, actual, expected) {
  var ok = actual === expected;
  if (ok) { passed++; lines.push("✔ " + name); }
  else    { failed++; lines.push("✖ " + name + "  (got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) + ")"); }
}

/* ---------- Calendar anchor for the test world ----------
 *
 * 2026-06-05 = Friday
 * 2026-06-06 = Saturday
 * 2026-06-07 = Sunday   (Drew's DIVCO service_date in the original incident)
 * 2026-06-08 = Monday
 * 2026-06-09 = Tuesday
 * 2026-06-10 = Wednesday
 * 2026-06-11 = Thursday
 * 2026-06-12 = Friday (next workweek boundary)
 * 2026-06-14 = Sunday  (a Sunday in a DIFFERENT workweek)
 */
var FRI    = "2026-06-05";
var SAT    = "2026-06-06";
var SUN    = "2026-06-07";
var MON    = "2026-06-08";
var WED    = "2026-06-10";
var THU    = "2026-06-11";
var NEXT_FRI = "2026-06-12";
var NEXT_SUN = "2026-06-14";

console.log("================================================================");
console.log("Phase 33 — assignment-eligibility regression tests");
console.log("================================================================");

/* ---------- Test 1 — Sunday DIVCO assignment visible Friday for clock-in ---------- */
var divcoSundayLegacy = {
  // Legacy doc shape — no available_from/until. This is the exact case
  // that triggered Drew's incident: bridge created the doc without flex
  // bounds, so the old isAvailableNow fell back to service_date === today.
  service_date:       SUN,
  staff_uid:          "drew-uid",
  customer_id:        "divco",
  customer_name:      "DIVCO",
  status:             "assigned",
  allows_flex_start:  true
};
assert(
  "1) Sunday DIVCO assignment visible on FRIDAY for clock-in",
  ELIG.isWorkableNow(divcoSundayLegacy, pacMillis(FRI, 10, 0), FRI),
  true
);
assert(
  "1b) Sunday DIVCO assignment visible on SATURDAY for clock-in",
  ELIG.isWorkableNow(divcoSundayLegacy, pacMillis(SAT, 14, 0), SAT),
  true
);

/* ---------- Test 2 — Same assignment visible Friday for DCR ---------- */
// Same helper, same return value: the DCR-launch surface uses the same
// isWorkableNow call, so by definition the answer is identical.
assert(
  "2) Same DIVCO assignment also workable Friday (DCR surface consistency)",
  ELIG.isWorkableNow(divcoSundayLegacy, pacMillis(FRI, 18, 30), FRI),
  true
);
// Modern shape — bridge set flex_start_policy: "sun_to_fri_evening",
// so available_from = prior Fri 17:00, available_until = Sun 23:59 + 6h grace.
var divcoSundayModern = {
  service_date:       SUN,
  staff_uid:          "drew-uid",
  customer_id:        "divco",
  customer_name:      "DIVCO",
  status:             "assigned",
  available_from:     ts(FRI, 17, 0),
  available_until:    ts(MON, 6, 0)
};
assert(
  "2b) Modern DIVCO doc with explicit bounds — workable Friday 17:30",
  ELIG.isWorkableNow(divcoSundayModern, pacMillis(FRI, 17, 30), FRI),
  true
);
assert(
  "2c) Modern DIVCO doc — NOT workable Friday 13:00 (before available_from)",
  ELIG.isWorkableNow(divcoSundayModern, pacMillis(FRI, 13, 0), FRI),
  false
);

/* ---------- Test 3 — Assignment does NOT disappear after clock-out ---------- */
// Right after clock-out, the session is in dcr_pending. The assignment
// status mirrors that. The helper must keep returning true so the card
// stays visible until DCR submission.
var dcrPendingAssignment = {
  service_date:      SUN,
  status:            "dcr_pending",
  allows_flex_start: true
};
assert(
  "3) Assignment in dcr_pending stays workable on Friday (post-clock-out)",
  ELIG.isWorkableNow(dcrPendingAssignment, pacMillis(FRI, 19, 0), FRI),
  true
);
var inProgressAssignment = Object.assign({}, dcrPendingAssignment, { status: "in_progress" });
assert(
  "3b) in_progress assignment stays workable",
  ELIG.isWorkableNow(inProgressAssignment, pacMillis(FRI, 19, 0), FRI),
  true
);
var pausedAssignment = Object.assign({}, dcrPendingAssignment, { status: "paused" });
assert(
  "3c) paused assignment stays workable",
  ELIG.isWorkableNow(pausedAssignment, pacMillis(FRI, 19, 0), FRI),
  true
);

/* ---------- Test 4 — Non-eligible future jobs remain hidden ---------- */
// A Sunday job TWO workweeks away should NOT appear Friday.
var futureFutureSunday = {
  service_date:      NEXT_SUN,
  status:            "assigned",
  allows_flex_start: true
};
assert(
  "4) Sunday job two workweeks out is NOT workable on Friday today",
  ELIG.isWorkableNow(futureFutureSunday, pacMillis(FRI, 10, 0), FRI),
  false
);
// A non-flex same-day-only assignment should not surface early.
var nonFlex = {
  service_date:      SUN,
  status:            "assigned",
  allows_flex_start: false
};
assert(
  "4b) Non-flex Sunday assignment is NOT workable on Friday",
  ELIG.isWorkableNow(nonFlex, pacMillis(FRI, 10, 0), FRI),
  false
);
assert(
  "4c) Non-flex Sunday assignment IS workable on Sunday",
  ELIG.isWorkableNow(nonFlex, pacMillis(SUN, 9, 0), SUN),
  true
);
// Cancelled assignments — never workable, regardless of date.
var cancelled = {
  service_date:      SUN,
  status:            "canceled_by_deputy",
  allows_flex_start: true
};
assert(
  "4d) canceled_by_deputy assignment is never workable",
  ELIG.isWorkableNow(cancelled, pacMillis(SUN, 10, 0), SUN),
  false
);
var removed = {
  service_date:      SUN,
  status:            "assigned",
  removed_from_ptc:  true
};
assert(
  "4e) removed_from_ptc assignment is never workable",
  ELIG.isWorkableNow(removed, pacMillis(SUN, 10, 0), SUN),
  false
);

/* ---------- Test 5 — Multi-tech assignments still behave correctly ---------- */
// The helper does NOT inspect staff_uid — that's the caller's
// responsibility (the Firestore query filters by staff_uid before
// reaching the helper). Two assignments for two techs with identical
// date + flex shape should both report workable. This proves the helper
// is staff-uid-agnostic and doesn't accidentally bias toward a single tech.
var drewSunday   = { service_date: SUN, staff_uid: "drew-uid",     allows_flex_start: true, status: "assigned" };
var makailaSunday= { service_date: SUN, staff_uid: "makaila-uid",  allows_flex_start: true, status: "assigned" };
assert(
  "5) Drew's Sunday assignment visible Friday (multi-tech case)",
  ELIG.isWorkableNow(drewSunday, pacMillis(FRI, 10, 0), FRI),
  true
);
assert(
  "5b) Makaila's Sunday assignment visible Friday — same rule, same answer",
  ELIG.isWorkableNow(makailaSunday, pacMillis(FRI, 10, 0), FRI),
  true
);

/* ---------- Test 6 — Workweek boundary correctness ---------- */
// Cross-workweek negative cases. Today = Thursday 06-11. A Sunday job
// for 06-14 is in the NEXT workweek and should NOT show on Thursday.
assert(
  "6) Sunday 06-14 NOT workable Thursday 06-11 (different workweek, too early)",
  ELIG.isWorkableNow(
    { service_date: NEXT_SUN, status: "assigned", allows_flex_start: true },
    pacMillis(THU, 10, 0), THU
  ),
  false
);
// But Friday 06-12 (start of next workweek's flex window) → visible.
assert(
  "6b) Sunday 06-14 IS workable Friday 06-12 (flex window opens)",
  ELIG.isWorkableNow(
    { service_date: NEXT_SUN, status: "assigned", allows_flex_start: true },
    pacMillis(NEXT_FRI, 10, 0), NEXT_FRI
  ),
  true
);

/* ---------- Test 7 — Same-day always works (sanity) ---------- */
assert(
  "7) Sunday job IS workable on Sunday morning",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "assigned" },
    pacMillis(SUN, 8, 0), SUN
  ),
  true
);
assert(
  "7b) Wednesday job IS workable on Wednesday",
  ELIG.isWorkableNow(
    { service_date: WED, status: "assigned" },
    pacMillis(WED, 14, 0), WED
  ),
  true
);

/* ---------- Test 8 — Late completion within workweek ---------- */
assert(
  "8) Sunday job IS workable Monday (late completion, same workweek)",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "assigned", allows_flex_start: true },
    pacMillis(MON, 14, 0), MON
  ),
  true
);

/* ---------- Test 9 — Workweek math primitives ---------- */
assert("9) Sunday 06-07 weekday is 0",  ELIG.pacificWeekday(SUN), 0);
assert("9b) Friday 06-05 weekday is 5", ELIG.pacificWeekday(FRI), 5);
assert("9c) workweekSundayFor(Sun 06-07) === 06-07", ELIG.workweekSundayFor(SUN), SUN);
assert("9d) workweekSundayFor(Mon 06-08) === 06-07", ELIG.workweekSundayFor(MON), SUN);
assert("9e) workweekSundayFor(Fri 06-05) === 06-07 (next Sun)", ELIG.workweekSundayFor(FRI), SUN);
var win = ELIG.workableWindowFor(SUN);
assert("9f) workableWindowFor(Sun 06-07).start === 06-05 (prior Fri)", win && win.start, FRI);
assert("9g) workableWindowFor(Sun 06-07).end   === 06-11 (Thu)",        win && win.end,   THU);

/* ---------- Output ---------- */
console.log("");
lines.forEach(function (l) { console.log("  " + l); });
console.log("");
console.log("================================================================");
console.log("Result: " + passed + " passed · " + failed + " failed");
console.log("================================================================");
process.exit(failed > 0 ? 1 : 0);
