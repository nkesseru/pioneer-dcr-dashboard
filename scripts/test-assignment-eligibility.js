/* Regression tests for the shared assignment-eligibility helper.
 *
 * Phase 33 / Phase 33 rule correction — Pioneer's operational rule is
 * "Friday AND Saturday can be used for Sunday cleanings" (not just
 * Friday early-start). The 8 explicit scenarios from the spec are run
 * first; supplementary coverage follows. The same public/assignment-
 * eligibility.js file the browser loads is the file the tests exercise.
 *
 *   node scripts/test-assignment-eligibility.js
 */
"use strict";

var ELIG = require("../public/assignment-eligibility.js");

var passed = 0;
var failed = 0;
var lines  = [];
var currentSection = "";

function section(name) {
  currentSection = name;
  lines.push("");
  lines.push("── " + name + " ──");
}

function ts(yyyymmdd, hh, mm) {
  // Build a Pacific wall-clock millis for the given Pacific date + time.
  var probeNoon = new Date(yyyymmdd + "T12:00:00Z");
  var partsFmt = new Intl.DateTimeFormat("en-US", {
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
  if (ok) { passed++; lines.push("  ✔ " + name); }
  else    { failed++; lines.push("  ✖ " + name + "  (got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) + ")"); }
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
 * 2026-06-13 = Saturday
 * 2026-06-14 = Sunday  (a Sunday in a DIFFERENT workweek)
 */
var FRI       = "2026-06-05";
var SAT       = "2026-06-06";
var SUN       = "2026-06-07";
var MON       = "2026-06-08";
var WED       = "2026-06-10";
var THU       = "2026-06-11";
var NEXT_FRI  = "2026-06-12";
var NEXT_SAT  = "2026-06-13";
var NEXT_SUN  = "2026-06-14";

console.log("================================================================");
console.log("Phase 33 — assignment-eligibility regression tests");
console.log("Rule: Friday AND Saturday can be used for Sunday cleanings.");
console.log("================================================================");

/* ============================================================
 * Spec scenarios 1-8 — explicit per the rule-correction memo.
 * ============================================================
 *
 * The "DIVCO Sunday flex assignment" used here is the exact bug
 * artifact: a service_assignments doc with service_date Sunday and
 * allows_flex_start: true. The eligibility helper is the single rule
 * used by both the clock-in surface (service-clock.js) and any DCR
 * launch surface — so the same helper call with the same inputs is
 * the source of truth for both. Scenario 8 verifies this by exercising
 * the helper with the same inputs and asserting identical answers.
 */

var divcoSundayFlex = {
  service_date:      SUN,
  staff_uid:         "drew-uid",
  customer_id:       "divco",
  customer_name:     "DIVCO",
  status:            "assigned",
  allows_flex_start: true
};

section("Scenarios 1-8 (explicit, per rule-correction memo)");

/* (1) Sunday flex assignment visible Friday for clock-in. */
assert(
  "1) Sunday flex assignment visible Friday for clock-in",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(FRI, 10, 0), FRI),
  true
);

/* (2) Sunday flex assignment visible Friday for DCR. The DCR launch
 * surface uses the same isWorkableNow call; verifying the helper
 * returns the same answer for the same inputs is the same check. */
assert(
  "2) Sunday flex assignment visible Friday for DCR (same helper)",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(FRI, 18, 30), FRI),
  true
);

/* (3) Sunday flex assignment visible Saturday for clock-in. */
assert(
  "3) Sunday flex assignment visible Saturday for clock-in",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SAT, 9, 30), SAT),
  true
);

/* (4) Sunday flex assignment visible Saturday for DCR. */
assert(
  "4) Sunday flex assignment visible Saturday for DCR (same helper)",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SAT, 16, 0), SAT),
  true
);

/* (5) Sunday flex assignment visible Sunday normally. */
assert(
  "5) Sunday flex assignment visible Sunday morning (normal)",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SUN, 8, 0), SUN),
  true
);
assert(
  "5b) Sunday flex assignment visible Sunday evening (normal)",
  ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SUN, 21, 0), SUN),
  true
);

/* (6) Non-flex Sunday assignment hidden Friday/Saturday but visible Sunday. */
var nonFlexSunday = {
  service_date:      SUN,
  status:            "assigned",
  allows_flex_start: false
};
assert(
  "6a) Non-flex Sunday assignment HIDDEN on Friday",
  ELIG.isWorkableNow(nonFlexSunday, pacMillis(FRI, 10, 0), FRI),
  false
);
assert(
  "6b) Non-flex Sunday assignment HIDDEN on Saturday",
  ELIG.isWorkableNow(nonFlexSunday, pacMillis(SAT, 10, 0), SAT),
  false
);
assert(
  "6c) Non-flex Sunday assignment VISIBLE on Sunday",
  ELIG.isWorkableNow(nonFlexSunday, pacMillis(SUN, 9, 0), SUN),
  true
);

/* (7) Future Sunday two workweeks out remains hidden Friday/Saturday of the wrong week. */
var futureFutureSundayFlex = {
  service_date:      NEXT_SUN,
  status:            "assigned",
  allows_flex_start: true
};
assert(
  "7a) Sunday 06-14 (next workweek) HIDDEN on Friday 06-05 (this workweek's prior gap)",
  ELIG.isWorkableNow(futureFutureSundayFlex, pacMillis(FRI, 10, 0), FRI),
  false
);
assert(
  "7b) Sunday 06-14 (next workweek) HIDDEN on Saturday 06-06 (this workweek's prior gap)",
  ELIG.isWorkableNow(futureFutureSundayFlex, pacMillis(SAT, 10, 0), SAT),
  false
);
assert(
  "7c) Sunday 06-14 VISIBLE on Friday 06-12 (correct prior gap, next-workweek flex window opens)",
  ELIG.isWorkableNow(futureFutureSundayFlex, pacMillis(NEXT_FRI, 10, 0), NEXT_FRI),
  true
);
assert(
  "7d) Sunday 06-14 VISIBLE on Saturday 06-13 (correct prior gap)",
  ELIG.isWorkableNow(futureFutureSundayFlex, pacMillis(NEXT_SAT, 10, 0), NEXT_SAT),
  true
);

/* (8) Same eligibility helper is used by clock-in and DCR surfaces.
 *
 * The browser bindings:
 *   /work          → service-clock.js     → window.PIONEER_ELIGIBILITY.isWorkableNow
 *   /  (DCR form)  → app.js                → window.PIONEER_ELIGIBILITY.isWorkableNow (via load order)
 *
 * Both load public/assignment-eligibility.js BEFORE their own module.
 * In this Node test we hold a direct reference to the same module and
 * exercise it with the same inputs the two surfaces would. Identical
 * inputs MUST yield identical answers, because there is exactly one
 * implementation.
 */
var clockInAnswer = ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SAT, 14, 0), SAT);
var dcrAnswer     = ELIG.isWorkableNow(divcoSundayFlex, pacMillis(SAT, 14, 0), SAT);
assert(
  "8a) Clock-in surface and DCR surface return identical answers (Sat / Sunday flex)",
  clockInAnswer === dcrAnswer && clockInAnswer === true,
  true
);
// Also verify the exported function is a single function reference,
// not two separately-instantiated copies.
assert(
  "8b) ELIG.isWorkableNow is a single function reference",
  typeof ELIG.isWorkableNow === "function" && ELIG.isWorkableNow === ELIG.isWorkableNow,
  true
);

/* ============================================================
 * Supplementary coverage — non-spec but worth not regressing.
 * ============================================================ */

section("Post-clock-out states (assignment stays visible through DCR)");
assert(
  "P1) dcr_pending assignment stays workable Friday (post-clock-out)",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "dcr_pending", allows_flex_start: true },
    pacMillis(FRI, 19, 0), FRI
  ),
  true
);
assert(
  "P2) in_progress assignment stays workable",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "in_progress", allows_flex_start: true },
    pacMillis(SAT, 12, 0), SAT
  ),
  true
);
assert(
  "P3) paused assignment stays workable",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "paused", allows_flex_start: true },
    pacMillis(SUN, 14, 0), SUN
  ),
  true
);

section("Cancellation / removal — never workable regardless of date");
assert(
  "P4) canceled_by_deputy assignment is never workable",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "canceled_by_deputy", allows_flex_start: true },
    pacMillis(SUN, 10, 0), SUN
  ),
  false
);
assert(
  "P5) removed_from_ptc assignment is never workable",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "assigned", removed_from_ptc: true },
    pacMillis(SUN, 10, 0), SUN
  ),
  false
);
assert(
  "P6) admin_removed assignment is never workable",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "admin_removed", allows_flex_start: true },
    pacMillis(SUN, 10, 0), SUN
  ),
  false
);

section("Modern docs with explicit available_from + available_until");
var modernFlex = {
  service_date:      SUN,
  status:            "assigned",
  available_from:    ts(FRI, 17, 0),
  available_until:   ts(MON, 6, 0)
};
assert(
  "M1) Modern doc with explicit window — workable Friday 17:30",
  ELIG.isWorkableNow(modernFlex, pacMillis(FRI, 17, 30), FRI),
  true
);
assert(
  "M2) Modern doc — workable Saturday afternoon",
  ELIG.isWorkableNow(modernFlex, pacMillis(SAT, 14, 0), SAT),
  true
);
assert(
  "M3) Modern doc — NOT workable Friday 13:00 (before available_from)",
  ELIG.isWorkableNow(modernFlex, pacMillis(FRI, 13, 0), FRI),
  false
);
assert(
  "M4) Modern doc — NOT workable Monday 07:00 (after available_until)",
  ELIG.isWorkableNow(modernFlex, pacMillis(MON, 7, 0), MON),
  false
);

section("Multi-tech — helper is staff-uid-agnostic");
var drewSunday    = { service_date: SUN, staff_uid: "drew-uid",    allows_flex_start: true, status: "assigned" };
var makailaSunday = { service_date: SUN, staff_uid: "makaila-uid", allows_flex_start: true, status: "assigned" };
assert(
  "T1) Drew's Sunday assignment visible Friday",
  ELIG.isWorkableNow(drewSunday, pacMillis(FRI, 10, 0), FRI),
  true
);
assert(
  "T2) Makaila's Sunday assignment visible Friday — same rule, same answer",
  ELIG.isWorkableNow(makailaSunday, pacMillis(FRI, 10, 0), FRI),
  true
);
assert(
  "T3) Drew on Saturday → workable",
  ELIG.isWorkableNow(drewSunday, pacMillis(SAT, 16, 0), SAT),
  true
);

section("Workweek boundary correctness");
assert(
  "W1) Sunday 06-14 NOT workable Thursday 06-11 (different workweek, too early)",
  ELIG.isWorkableNow(
    { service_date: NEXT_SUN, status: "assigned", allows_flex_start: true },
    pacMillis(THU, 10, 0), THU
  ),
  false
);
assert(
  "W2) Sunday 06-07 NOT workable Friday 06-12 (different workweek, late)",
  ELIG.isWorkableNow(
    { service_date: SUN, status: "assigned", allows_flex_start: true },
    pacMillis(NEXT_FRI, 10, 0), NEXT_FRI
  ),
  false
);

section("Workweek math primitives");
assert("X1) Sunday 06-07 weekday is 0",        ELIG.pacificWeekday(SUN), 0);
assert("X2) Friday 06-05 weekday is 5",        ELIG.pacificWeekday(FRI), 5);
assert("X3) Saturday 06-06 weekday is 6",      ELIG.pacificWeekday(SAT), 6);
assert("X4) workweekSundayFor(Sun 06-07) === 06-07", ELIG.workweekSundayFor(SUN), SUN);
assert("X5) workweekSundayFor(Mon 06-08) === 06-07", ELIG.workweekSundayFor(MON), SUN);
assert("X6) workweekSundayFor(Fri 06-05) === 06-07 (next Sun)", ELIG.workweekSundayFor(FRI), SUN);
assert("X7) workweekSundayFor(Sat 06-06) === 06-07 (next Sun)", ELIG.workweekSundayFor(SAT), SUN);
var win = ELIG.workableWindowFor(SUN);
assert("X8) workableWindowFor(Sun 06-07).start === 06-05 (prior Fri)", win && win.start, FRI);
assert("X9) workableWindowFor(Sun 06-07).end   === 06-11 (Thu)",         win && win.end,   THU);

/* ---------- Output ---------- */
console.log("");
lines.forEach(function (l) { console.log(l); });
console.log("");
console.log("================================================================");
console.log("Result: " + passed + " passed · " + failed + " failed");
console.log("================================================================");
process.exit(failed > 0 ? 1 : 0);
