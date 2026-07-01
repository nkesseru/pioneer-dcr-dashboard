// SessionV2 Phase 36a.2 — DCR dual-write parity tests.
// Run via: npm run test:dcr:sessionsV2
//
// Pure-JS tests on functions/sessionsV2-dcr-parity.js. No emulator
// needed — the parity helper is a deterministic function from
// (v1 dcr doc, v2 snapshot) to a divergence list.
//
// Orchestration tests (read/update Firestore) are exercised by the
// canary harness in /admin (button 5d. Simulate DCR dual-write).
// See docs/sessionsV2/PHASE36A_PLAN.md for the test strategy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parity = require("../functions/sessionsV2-dcr-parity.js");
const snap   = require("../functions/sessionsV2-snapshot.js");

const FIXED_TS = "2026-06-27T17:30:00.000Z";

function renderSnap(session) {
  return snap.renderSessionSnapshot(session, { generated_at_iso: FIXED_TS });
}

// ============================================================
// extractAssignmentIdFromSessionId
// ============================================================
describe("extractAssignmentIdFromSessionId", () => {
  test("tech_clock form: sess_<asg>_<date>_a1", () => {
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_abc123_2026-06-27_a1"),
      "abc123"
    );
  });

  test("tech_clock form with dashed assignment_id", () => {
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_canary-asg-fixed_2026-06-27_a1"),
      "canary-asg-fixed"
    );
  });

  test("higher attempt numbers (_a2, _a10)", () => {
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_abc_2026-06-27_a2"),
      "abc"
    );
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_abc_2026-06-27_a10"),
      "abc"
    );
  });

  test("admin-manual form not extracted (returns empty)", () => {
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_manual_uid_2026-06-27_cedar_a1"),
      ""
    );
  });

  test("recovery form not extracted (returns empty)", () => {
    assert.equal(
      parity.extractAssignmentIdFromSessionId("sess_recover_sess_abc_2026-06-27_a1_a1"),
      ""
    );
  });

  test("not a session id returns empty", () => {
    assert.equal(parity.extractAssignmentIdFromSessionId("garbage"), "");
    assert.equal(parity.extractAssignmentIdFromSessionId(""), "");
    assert.equal(parity.extractAssignmentIdFromSessionId(null), "");
  });
});

// ============================================================
// parityDiff — matching cases (empty array)
// ============================================================
describe("parityDiff — parity OK cases", () => {
  test("identical customer_slug + photo_count + email + assignment_id -> []", () => {
    const v1 = {
      customer_slug:          "cedar",
      photos:                 [{}, {}, {}],
      submitted_by_email:     "tech@example.com",
      pioneer_assignment_id:  "asg-1"
    };
    const v2snap = renderSnap({
      session_id:    "sess_asg-1_2026-06-27_a1",
      customer_slug: "cedar",
      customer_id:   "cedar",
      staff_email:   "tech@example.com",
      expected_components: ["photos"],
      components:    { photos: { status: "complete", count: 3 } }
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("case-insensitive customer_slug match", () => {
    const v1 = { customer_slug: "Cedar-LLC" };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      customer_slug: "cedar-llc"
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("case-insensitive email match", () => {
    const v1 = { submitted_by_email: "Tech@Example.com" };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      staff_email: "tech@example.com"
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("empty / missing fields on either side skip the check", () => {
    const v1 = { customer_slug: "cedar" }; // no photos, no email
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      customer_slug: "cedar"
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });
});

// ============================================================
// parityDiff — divergence cases
// ============================================================
describe("parityDiff — divergence cases", () => {
  test("customer_slug mismatch", () => {
    const v1 = { customer_slug: "alpha" };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      customer_slug: "beta"
    });
    const d = parity.parityDiff(v1, v2snap);
    assert.equal(d.length, 1);
    assert.match(d[0], /^customer_slug\(v1=alpha,v2=beta\)/);
  });

  test("photo_count mismatch", () => {
    const v1 = { photos: [{}, {}] };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      expected_components: ["photos"],
      components: { photos: { status: "complete", count: 5 } }
    });
    const d = parity.parityDiff(v1, v2snap);
    assert.equal(d.length, 1);
    assert.match(d[0], /^photo_count\(v1=2,v2=5\)/);
  });

  test("submitter_email mismatch", () => {
    const v1 = { submitted_by_email: "a@example.com" };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      staff_email: "b@example.com"
    });
    const d = parity.parityDiff(v1, v2snap);
    assert.equal(d.length, 1);
    assert.match(d[0], /^submitter_email\(v1=a@example.com,v2=b@example.com\)/);
  });

  test("assignment_id mismatch (v1 vs sid-derived)", () => {
    const v1 = { pioneer_assignment_id: "expected-asg" };
    const v2snap = renderSnap({ session_id: "sess_other-asg_2026-06-27_a1" });
    const d = parity.parityDiff(v1, v2snap);
    assert.equal(d.length, 1);
    assert.match(d[0], /^assignment_id\(v1=expected-asg,v2_sid_asg=other-asg\)/);
  });

  test("multiple divergences accumulate", () => {
    const v1 = {
      customer_slug:          "alpha",
      photos:                 [{}],
      submitted_by_email:     "a@example.com",
      pioneer_assignment_id:  "asg-1"
    };
    const v2snap = renderSnap({
      session_id:    "sess_asg-2_2026-06-27_a1",
      customer_slug: "beta",
      staff_email:   "b@example.com",
      expected_components: ["photos"],
      components:    { photos: { status: "complete", count: 9 } }
    });
    const d = parity.parityDiff(v1, v2snap);
    assert.equal(d.length, 4);
    const joined = d.join(" ");
    assert.match(joined, /customer_slug/);
    assert.match(joined, /photo_count/);
    assert.match(joined, /submitter_email/);
    assert.match(joined, /assignment_id/);
  });
});

// ============================================================
// parityDiff — defensive inputs
// ============================================================
describe("parityDiff — defensive inputs", () => {
  test("undefined inputs -> empty array", () => {
    assert.deepEqual(parity.parityDiff(undefined, undefined), []);
  });

  test("null inputs -> empty array", () => {
    assert.deepEqual(parity.parityDiff(null, null), []);
  });

  test("v1 with v2-missing fields -> no false positives", () => {
    const v1 = { customer_slug: "cedar" };
    const v2snap = renderSnap({ session_id: "sess_x_2026-06-27_a1" });
    // customer_slug only flagged if both sides present; v2 is null -> skip.
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("v1.photos non-array -> photo check skipped", () => {
    const v1 = { photos: "garbage" };
    const v2snap = renderSnap({
      session_id: "sess_x_2026-06-27_a1",
      expected_components: ["photos"],
      components: { photos: { status: "complete", count: 3 } }
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("admin-manual v2 session_id -> assignment_id check skipped", () => {
    const v1 = { pioneer_assignment_id: "anything" };
    const v2snap = renderSnap({
      session_id: "sess_manual_uid_2026-06-27_cedar_a1"
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });
});

// ============================================================
// Documented invariants — fields intentionally NOT compared
// ============================================================
describe("parityDiff — intentional non-comparisons", () => {
  test("timestamp drift never produces a divergence", () => {
    const v1 = {
      customer_slug:      "cedar",
      created_at:         { seconds: 100 },
      server_received_at: { seconds: 200 }
    };
    const v2snap = renderSnap({
      session_id:    "sess_x_2026-06-27_a1",
      customer_slug: "cedar",
      clock_in_at:   new Date("2026-06-27T15:00:00Z")
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("free-form notes never produce a divergence", () => {
    const v1 = { customer_slug: "cedar", notes: "long story" };
    const v2snap = renderSnap({
      session_id:    "sess_x_2026-06-27_a1",
      customer_slug: "cedar",
      notes:         "different story"
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });

  test("checklist progress drift never produces a divergence", () => {
    const v1 = { customer_slug: "cedar", checklist: [{a:1}, {b:2}] };
    const v2snap = renderSnap({
      session_id:    "sess_x_2026-06-27_a1",
      customer_slug: "cedar",
      expected_components: ["checklist"],
      components: { checklist: { status: "missing", pct: 0,
                                  items_total: 5, items_complete: 0 } }
    });
    assert.deepEqual(parity.parityDiff(v1, v2snap), []);
  });
});

// ============================================================
// Phase 36b — idempotency-by-submissionId predicate
// ============================================================
//
// Guards both the inline submitDcrV1 splice and the new
// onDcrSubmissionCreatedV36b trigger against double-processing the
// same DCR write. Predicate: V2's components.dcr.ref already matches
// THIS submissionId AND components.dcr.status is "complete".
// ============================================================
describe("isAlreadyProcessedByDcrSubmissionId — idempotency predicate", () => {
  const fn = parity.isAlreadyProcessedByDcrSubmissionId;

  test("skip when ref matches AND status is complete", () => {
    const v2 = { components: { dcr: { ref: "dcr_abc", status: "complete" } } };
    assert.equal(fn(v2, "dcr_abc"), true);
  });

  test("do NOT skip when ref matches but status is collecting", () => {
    const v2 = { components: { dcr: { ref: "dcr_abc", status: "collecting" } } };
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when ref matches but status is missing", () => {
    const v2 = { components: { dcr: { ref: "dcr_abc", status: "missing" } } };
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when ref does not match (different submission)", () => {
    const v2 = { components: { dcr: { ref: "dcr_xyz", status: "complete" } } };
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when components.dcr is absent", () => {
    const v2 = { components: {} };
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when components is absent", () => {
    const v2 = {};
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when v2Data is null", () => {
    assert.equal(fn(null, "dcr_abc"), false);
  });

  test("do NOT skip when v2Data is undefined", () => {
    assert.equal(fn(undefined, "dcr_abc"), false);
  });

  test("do NOT skip when submissionId is null", () => {
    const v2 = { components: { dcr: { ref: null, status: "complete" } } };
    assert.equal(fn(v2, null), false);
  });

  test("do NOT skip when submissionId is empty string", () => {
    const v2 = { components: { dcr: { ref: "", status: "complete" } } };
    assert.equal(fn(v2, ""), false);
  });

  test("do NOT skip when components.dcr is a non-object scalar", () => {
    const v2 = { components: { dcr: "garbage" } };
    assert.equal(fn(v2, "dcr_abc"), false);
  });

  test("do NOT skip when v2Data is a non-object scalar", () => {
    assert.equal(fn("garbage", "dcr_abc"), false);
  });

  test("calling twice with the same processed state is stable", () => {
    const v2 = { components: { dcr: { ref: "dcr_abc", status: "complete" } } };
    assert.equal(fn(v2, "dcr_abc"), true);
    assert.equal(fn(v2, "dcr_abc"), true);
    // Different submissionId on same v2Data -> still not skipped
    assert.equal(fn(v2, "dcr_other"), false);
  });
});

// ============================================================
// Phase 36d — projectChecklistForSession
//
// Pure projection from V1 dcr_submissions.checklist (array of sections)
// into V2 components.checklist shape. Closed output (items_total +
// items_complete + items_issue + items_na + items_untouched + pct +
// sections[]). Defensive on every malformed input — never throws.
// ============================================================
describe("projectChecklistForSession — projection (Phase 36d)", () => {
  const fn = parity.projectChecklistForSession;

  // ----- empty / defensive paths -----

  test("undefined input -> empty projection", () => {
    const r = fn(undefined);
    assert.deepEqual(r, {
      items_total: 0, items_complete: 0, items_issue: 0,
      items_na: 0, items_untouched: 0, pct: 0, sections: []
    });
  });

  test("null input -> empty projection", () => {
    assert.equal(fn(null).items_total, 0);
    assert.deepEqual(fn(null).sections, []);
  });

  test("non-array input (string) -> empty projection", () => {
    assert.equal(fn("garbage").items_total, 0);
  });

  test("non-array input (object) -> empty projection", () => {
    assert.equal(fn({ section_id: "x" }).items_total, 0);
  });

  test("empty array -> pct 0, items_total 0", () => {
    const r = fn([]);
    assert.equal(r.pct, 0);
    assert.equal(r.items_total, 0);
    assert.deepEqual(r.sections, []);
  });

  // ----- happy paths -----

  test("single section, single done item -> pct 100", () => {
    const r = fn([{
      section_id: "ext",
      section_label: "Exterior",
      items: [{ item_id: "lock", label: "Lock doors", status: "done" }]
    }]);
    assert.equal(r.items_total, 1);
    assert.equal(r.items_complete, 1);
    assert.equal(r.pct, 100);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].section_id, "ext");
    assert.equal(r.sections[0].items.length, 1);
    assert.deepEqual(r.sections[0].items[0], {
      item_id: "lock", status: "done", note: null
    });
  });

  test("section_label and item.label are NOT in projection", () => {
    const r = fn([{
      section_id: "ext",
      section_label: "Exterior",
      items: [{ item_id: "lock", label: "Lock doors", status: "done" }]
    }]);
    assert.equal(r.sections[0].section_label, undefined);
    assert.equal(r.sections[0].items[0].label, undefined);
  });

  test("multiple sections combine correctly", () => {
    const r = fn([
      { section_id: "ext", items: [
        { item_id: "lock",   status: "done"  },
        { item_id: "lights", status: "done"  }
      ]},
      { section_id: "int", items: [
        { item_id: "vac",   status: "done"  },
        { item_id: "trash", status: "issue", note: "bin overflowing" }
      ]}
    ]);
    assert.equal(r.items_total,     4);
    assert.equal(r.items_complete,  3);
    assert.equal(r.items_issue,     1);
    assert.equal(r.pct,             75);
    assert.equal(r.sections.length, 2);
  });

  // ----- status normalization -----

  test('status "done" preserved', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i", status: "done" }] }]);
    assert.equal(r.sections[0].items[0].status, "done");
    assert.equal(r.items_complete, 1);
  });

  test('status "issue" preserved', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i", status: "issue" }] }]);
    assert.equal(r.sections[0].items[0].status, "issue");
    assert.equal(r.items_issue, 1);
  });

  test('status "na" preserved', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i", status: "na" }] }]);
    assert.equal(r.sections[0].items[0].status, "na");
    assert.equal(r.items_na, 1);
  });

  test('null status -> "untouched"', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i", status: null }] }]);
    assert.equal(r.sections[0].items[0].status, "untouched");
    assert.equal(r.items_untouched, 1);
  });

  test('missing status field -> "untouched"', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i" }] }]);
    assert.equal(r.sections[0].items[0].status, "untouched");
    assert.equal(r.items_untouched, 1);
  });

  test('unknown status string -> "untouched"', () => {
    const r = fn([{ section_id: "s", items: [{ item_id: "i", status: "maybe" }] }]);
    assert.equal(r.sections[0].items[0].status, "untouched");
    assert.equal(r.items_untouched, 1);
  });

  // ----- note handling -----

  test('note preserved only when status === "issue"', () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "a", status: "done",  note: "ignored"     },
      { item_id: "b", status: "issue", note: "real note"   },
      { item_id: "c", status: "na",    note: "also ignored" }
    ]}]);
    assert.equal(r.sections[0].items[0].note, null);
    assert.equal(r.sections[0].items[1].note, "real note");
    assert.equal(r.sections[0].items[2].note, null);
  });

  test('whitespace-only note on issue -> null', () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "b", status: "issue", note: "   " }
    ]}]);
    assert.equal(r.sections[0].items[0].note, null);
  });

  test('note is trimmed on issue', () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "b", status: "issue", note: "  bulb out  " }
    ]}]);
    assert.equal(r.sections[0].items[0].note, "bulb out");
  });

  test('missing note on issue -> null', () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "b", status: "issue" }
    ]}]);
    assert.equal(r.sections[0].items[0].note, null);
  });

  // ----- pct math -----

  test("pct rounds correctly (1 of 3 -> 33)", () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "a", status: "done" },
      { item_id: "b", status: "issue" },
      { item_id: "c", status: "na" }
    ]}]);
    assert.equal(r.items_total, 3);
    assert.equal(r.items_complete, 1);
    assert.equal(r.pct, 33);
  });

  test("pct rounds correctly (2 of 3 -> 67)", () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "a", status: "done" },
      { item_id: "b", status: "done" },
      { item_id: "c", status: "issue" }
    ]}]);
    assert.equal(r.pct, 67);
  });

  test("pct is 0 when nothing is done", () => {
    const r = fn([{ section_id: "s", items: [
      { item_id: "a", status: "issue" },
      { item_id: "b", status: "na" },
      { item_id: "c", status: null }
    ]}]);
    assert.equal(r.pct, 0);
    assert.equal(r.items_complete, 0);
  });

  // ----- malformed input defenses -----

  test("section without section_id is dropped", () => {
    const r = fn([
      { items: [{ item_id: "a", status: "done" }] },           // no section_id
      { section_id: "good", items: [{ item_id: "b", status: "done" }] }
    ]);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].section_id, "good");
    assert.equal(r.items_total, 1);
  });

  test("empty section_id ('') is dropped", () => {
    const r = fn([{ section_id: "", items: [{ item_id: "a", status: "done" }] }]);
    assert.equal(r.sections.length, 0);
  });

  test("section without items array becomes empty section", () => {
    const r = fn([{ section_id: "s" }]);
    assert.equal(r.sections.length, 1);
    assert.deepEqual(r.sections[0].items, []);
  });

  test("item without item_id is dropped", () => {
    const r = fn([{ section_id: "s", items: [
      { status: "done" },                          // no item_id
      { item_id: "good", status: "done" }
    ]}]);
    assert.equal(r.sections[0].items.length, 1);
    assert.equal(r.items_total, 1);
  });

  test("non-object section in array is skipped", () => {
    const r = fn([
      null,
      "garbage",
      { section_id: "good", items: [{ item_id: "a", status: "done" }] }
    ]);
    assert.equal(r.sections.length, 1);
  });

  test("non-object item in items array is skipped", () => {
    const r = fn([{ section_id: "s", items: [
      null,
      "garbage",
      { item_id: "good", status: "done" }
    ]}]);
    assert.equal(r.sections[0].items.length, 1);
    assert.equal(r.items_total, 1);
  });

  test("numeric section_id and item_id coerced to string", () => {
    const r = fn([{ section_id: 42, items: [{ item_id: 7, status: "done" }] }]);
    assert.equal(r.sections[0].section_id, "42");
    assert.equal(r.sections[0].items[0].item_id, "7");
  });

  // ----- realistic Pioneer DCR shape -----

  test("realistic Pioneer DCR with 3 sections, mix of statuses", () => {
    const r = fn([
      { section_id: "exterior", section_label: "Exterior", items: [
        { item_id: "lockup",  label: "All doors locked",         status: "done"                                  },
        { item_id: "lights",  label: "Exterior lights off",      status: "issue", note: "Front entry bulb out"   },
        { item_id: "trash",   label: "Trash to curb",            status: "na"                                    }
      ]},
      { section_id: "office", section_label: "Office Areas", items: [
        { item_id: "vac",     label: "Vacuum all carpets",        status: "done"  },
        { item_id: "trash2",  label: "Empty all bins",            status: "done"  },
        { item_id: "dust",    label: "Dust desks",                status: "done"  },
        { item_id: "windows", label: "Spot-clean windows",        status: null    }
      ]},
      { section_id: "restroom", section_label: "Restrooms", items: [
        { item_id: "sinks",   label: "Wipe sinks",                status: "done"  },
        { item_id: "toilet",  label: "Clean toilets",             status: "done"  },
        { item_id: "supply",  label: "Restock paper supplies",    status: "done"  }
      ]}
    ]);
    assert.equal(r.items_total,     10);
    assert.equal(r.items_complete,  7);
    assert.equal(r.items_issue,     1);
    assert.equal(r.items_na,        1);
    assert.equal(r.items_untouched, 1);
    assert.equal(r.pct,             70);
    assert.equal(r.sections.length, 3);
    // Verify issue note carries through
    const exteriorLights = r.sections[0].items.find(it => it.item_id === "lights");
    assert.equal(exteriorLights.status, "issue");
    assert.equal(exteriorLights.note, "Front entry bulb out");
  });
});

// ============================================================
// Phase 36d — EXPLICIT malformed/partial input + never-throws guarantee
//
// Per Operation One Truth Rule 10 (no production surprises): the
// projection MUST tolerate every reasonable form of bad input from V1.
// `assert.doesNotThrow` wraps each adversarial input so a future
// regression that introduces a throw is caught immediately.
//
// Coverage:
//   - missing checklist        (undefined, null, omitted field)
//   - empty checklist          (empty array)
//   - mixed complete/incomplete items (correctness on partials)
//   - unexpected field types   (boolean, number, function, Symbol,
//                               BigInt, Date, nested cycles, very long
//                               strings, primitive at every nest level)
// ============================================================
describe("projectChecklistForSession — explicit malformed/partial + never-throws (Phase 36d)", () => {
  const fn = parity.projectChecklistForSession;

  // ----- 1. missing checklist -----

  test("missing: undefined input never throws + returns empty projection", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(undefined); });
    assert.deepEqual(r, {
      items_total: 0, items_complete: 0, items_issue: 0,
      items_na: 0, items_untouched: 0, pct: 0, sections: []
    });
  });

  test("missing: null input never throws + returns empty projection", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(null); });
    assert.equal(r.items_total, 0);
    assert.equal(r.pct, 0);
    assert.deepEqual(r.sections, []);
  });

  test("missing: caller forgot to pass an arg (no args) never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(); });
    assert.equal(r.items_total, 0);
  });

  test("missing: simulated dcrDoc with no checklist field at all", () => {
    // What sessionsV2_dualWriteFromDcrSubmit actually passes:
    // sessionsV2DcrParity.projectChecklistForSession(dcrDoc.checklist)
    // If dcrDoc has no checklist property, that's `undefined`.
    const dcrDoc = { customer_slug: "x", photos: [{}, {}] };  // no .checklist
    let r;
    assert.doesNotThrow(() => { r = fn(dcrDoc.checklist); });
    assert.equal(r.items_total, 0);
  });

  // ----- 2. empty checklist -----

  test("empty: [] never throws + returns empty projection", () => {
    let r;
    assert.doesNotThrow(() => { r = fn([]); });
    assert.equal(r.items_total, 0);
    assert.equal(r.pct, 0);
    assert.deepEqual(r.sections, []);
  });

  test("empty: array of empty sections (each with no items array)", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([
        { section_id: "a" },
        { section_id: "b" },
        { section_id: "c" }
      ]);
    });
    assert.equal(r.items_total,     0);
    assert.equal(r.pct,             0);
    assert.equal(r.sections.length, 3);
    assert.deepEqual(r.sections[0].items, []);
    assert.deepEqual(r.sections[1].items, []);
    assert.deepEqual(r.sections[2].items, []);
  });

  test("empty: section with explicitly empty items array", () => {
    let r;
    assert.doesNotThrow(() => { r = fn([{ section_id: "a", items: [] }]); });
    assert.equal(r.items_total, 0);
    assert.equal(r.sections[0].items.length, 0);
  });

  // ----- 3. mixed complete/incomplete items -----

  test("mixed: 5 items across 2 sections — 2 done / 1 issue / 1 na / 1 untouched", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([
        { section_id: "outdoor", items: [
          { item_id: "lockup",  status: "done"                              },
          { item_id: "lights",  status: "issue", note: "front bulb out"     }
        ]},
        { section_id: "indoor", items: [
          { item_id: "vac",     status: "done"                              },
          { item_id: "supply",  status: "na"                                },
          { item_id: "windows", status: null  /* untouched */               }
        ]}
      ]);
    });
    assert.equal(r.items_total,     5);
    assert.equal(r.items_complete,  2);
    assert.equal(r.items_issue,     1);
    assert.equal(r.items_na,        1);
    assert.equal(r.items_untouched, 1);
    assert.equal(r.pct,             40);              // 2 of 5
    assert.equal(r.sections.length, 2);
    // Buckets sum to total — invariant check
    assert.equal(
      r.items_complete + r.items_issue + r.items_na + r.items_untouched,
      r.items_total
    );
  });

  test("mixed: tech submitted DCR with everything untouched (rare but possible)", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "outdoor", items: [
        { item_id: "a", status: null },
        { item_id: "b", status: null },
        { item_id: "c", status: null }
      ]}]);
    });
    assert.equal(r.items_total,     3);
    assert.equal(r.items_complete,  0);
    assert.equal(r.items_untouched, 3);
    assert.equal(r.pct,             0);
  });

  test("mixed: all issues (DCR with everything flagged as problems)", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "x", items: [
        { item_id: "a", status: "issue", note: "broken"  },
        { item_id: "b", status: "issue", note: "missing" },
        { item_id: "c", status: "issue", note: "damaged" }
      ]}]);
    });
    assert.equal(r.items_total,    3);
    assert.equal(r.items_complete, 0);
    assert.equal(r.items_issue,    3);
    assert.equal(r.pct,            0);
    // All notes preserved
    r.sections[0].items.forEach(it => assert.ok(it.note && it.note.length > 0));
  });

  // ----- 4. unexpected field types -----

  test("type: top-level input is a boolean", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(true); });
    assert.equal(r.items_total, 0);
    assert.doesNotThrow(() => { r = fn(false); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a number", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(0); });
    assert.equal(r.items_total, 0);
    assert.doesNotThrow(() => { r = fn(42); });
    assert.equal(r.items_total, 0);
    assert.doesNotThrow(() => { r = fn(Number.NaN); });
    assert.equal(r.items_total, 0);
    assert.doesNotThrow(() => { r = fn(Infinity); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a function", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(() => "garbage"); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a Symbol", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(Symbol("sym")); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a BigInt", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(BigInt(123)); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a Date", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(new Date()); });
    assert.equal(r.items_total, 0);
  });

  test("type: top-level input is a Map", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(new Map([["a", 1]])); });
    assert.equal(r.items_total, 0);
  });

  test("type: section is a primitive inside the array", () => {
    let r;
    assert.doesNotThrow(() => { r = fn([42, "string", true, null, undefined]); });
    assert.equal(r.items_total, 0);
    assert.equal(r.sections.length, 0);
  });

  test("type: section is a function inside the array", () => {
    let r;
    assert.doesNotThrow(() => { r = fn([() => ({ section_id: "x" })]); });
    assert.equal(r.items_total, 0);
  });

  test("type: section_id is a boolean / array / object", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([
        { section_id: true,        items: [{ item_id: "a", status: "done" }] },
        { section_id: ["x", "y"],  items: [{ item_id: "b", status: "done" }] },
        { section_id: { k: "v" },  items: [{ item_id: "c", status: "done" }] }
      ]);
    });
    // String coercion happens: each section_id stringifies to "true",
    // "x,y", "[object Object]" — all non-empty, so all sections accepted.
    assert.equal(r.sections.length, 3);
    assert.equal(r.items_total, 3);
  });

  test("type: items field is a non-array value", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([
        { section_id: "a", items: "garbage"          },
        { section_id: "b", items: { item_id: "x" }   },
        { section_id: "c", items: 42                 },
        { section_id: "d", items: null               },
        { section_id: "e", items: true               }
      ]);
    });
    // Each section accepted (has section_id), but items[] becomes empty
    assert.equal(r.sections.length, 5);
    assert.equal(r.items_total, 0);
    r.sections.forEach(s => assert.deepEqual(s.items, []));
  });

  test("type: item is a primitive inside items array", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "a", items: [
        42,
        "string-item",
        true,
        null,
        undefined,
        { item_id: "real", status: "done" }    // only this survives
      ]}]);
    });
    assert.equal(r.sections[0].items.length, 1);
    assert.equal(r.items_total, 1);
  });

  test("type: item_id is an object / array / boolean", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "s", items: [
        { item_id: { k: "v" }, status: "done" },
        { item_id: ["a", "b"], status: "done" },
        { item_id: true,       status: "done" }
      ]}]);
    });
    // All coerced to non-empty strings; all 3 survive
    assert.equal(r.items_total, 3);
  });

  test("type: status is a number / boolean / object / array", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "s", items: [
        { item_id: "a", status: 1            },  // not "done" → untouched
        { item_id: "b", status: true         },  // → untouched
        { item_id: "c", status: { x: "done" } }, // → untouched
        { item_id: "d", status: ["done"]     }   // → untouched
      ]}]);
    });
    assert.equal(r.items_total, 4);
    assert.equal(r.items_untouched, 4);
    assert.equal(r.pct, 0);
  });

  test("type: note is a non-string on issue items", () => {
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "s", items: [
        { item_id: "a", status: "issue", note: 42       },
        { item_id: "b", status: "issue", note: true     },
        { item_id: "c", status: "issue", note: { k: 1 } },
        { item_id: "d", status: "issue", note: null     },
        { item_id: "e", status: "issue", note: undefined }
      ]}]);
    });
    assert.equal(r.items_total, 5);
    assert.equal(r.items_issue, 5);
    // String coercion produces "42", "true", "[object Object]";
    // null/undefined become null in projection
    assert.equal(r.sections[0].items[0].note, "42");
    assert.equal(r.sections[0].items[1].note, "true");
    assert.equal(r.sections[0].items[2].note, "[object Object]");
    assert.equal(r.sections[0].items[3].note, null);
    assert.equal(r.sections[0].items[4].note, null);
  });

  test("type: very long strings (10k chars) don't blow stack", () => {
    const longLabel = "x".repeat(10000);
    const longNote  = "y".repeat(10000);
    let r;
    assert.doesNotThrow(() => {
      r = fn([{ section_id: "s", items: [
        { item_id: longLabel, status: "issue", note: longNote }
      ]}]);
    });
    assert.equal(r.items_total, 1);
    assert.equal(r.sections[0].items[0].item_id.length, 10000);
    assert.equal(r.sections[0].items[0].note.length, 10000);
  });

  test("type: deeply nested object as section (no crash, no infinite loop)", () => {
    const deep = { section_id: "s", items: [] };
    let cur = deep;
    for (let i = 0; i < 100; i++) {
      cur.extra = { nested: "yes" };
      cur = cur.extra;
    }
    let r;
    assert.doesNotThrow(() => { r = fn([deep]); });
    assert.equal(r.sections.length, 1);
  });

  test("type: cyclic reference in section object (no infinite loop)", () => {
    const cyc = { section_id: "s", items: [] };
    cyc.self = cyc;  // cycle
    let r;
    assert.doesNotThrow(() => { r = fn([cyc]); });
    assert.equal(r.sections.length, 1);
    // We do NOT walk `self`, so no infinite recursion
  });

  test("type: huge number of sections (1000) doesn't crash", () => {
    const many = [];
    for (let i = 0; i < 1000; i++) {
      many.push({
        section_id: "s" + i,
        items: [{ item_id: "i", status: i % 2 === 0 ? "done" : "issue" }]
      });
    }
    let r;
    assert.doesNotThrow(() => { r = fn(many); });
    assert.equal(r.sections.length, 1000);
    assert.equal(r.items_total,     1000);
    assert.equal(r.items_complete,  500);
    assert.equal(r.items_issue,     500);
    assert.equal(r.pct,             50);
  });

  // ----- 5. never-throws — final sweep -----

  test("sweep: every adversarial value through one assert.doesNotThrow", () => {
    const inputs = [
      undefined, null, true, false, 0, 42, NaN, Infinity, -Infinity,
      "", "garbage", "[]", "{}",
      [], [null], [undefined], [true], [42], ["string"],
      [{}], [{ section_id: "x" }], [{ items: [] }],
      [{ section_id: "x", items: null }],
      [{ section_id: "x", items: [null, undefined, 42] }],
      [{ section_id: null, items: [{ item_id: "y", status: "done" }] }],
      [{ section_id: "x", items: [{ item_id: null, status: "done" }] }],
      [{ section_id: "x", items: [{ item_id: "y", status: { obj: true } }] }],
      [{ section_id: "x", items: [{ item_id: "y", status: "issue", note: { obj: true } }] }],
      () => {},
      Symbol("s"),
      BigInt(0),
      new Map(),
      new Set(),
      new Date(),
      /regex/,
      Buffer.from("bytes"),
      { not: "an array" },
      { length: 5, 0: { section_id: "fake-array" } }  // array-like but not Array
    ];
    inputs.forEach((input, idx) => {
      assert.doesNotThrow(
        () => fn(input),
        "fn threw on input index " + idx
      );
    });
  });
});

// ============================================================
// projectNotesForSession (Phase 36e)
// ============================================================
describe("projectNotesForSession — happy path (Phase 36e)", () => {
  const fn = parity.projectNotesForSession;

  test("string notes returned as { text }", () => {
    assert.deepEqual(fn({ notes: "left key under mat" }),
                     { text: "left key under mat" });
  });

  test("string with surrounding whitespace is trimmed", () => {
    assert.deepEqual(fn({ notes: "  hello  " }), { text: "hello" });
  });

  test("empty string returns null text", () => {
    assert.deepEqual(fn({ notes: "" }), { text: null });
  });

  test("whitespace-only string returns null text", () => {
    assert.deepEqual(fn({ notes: "   \t\n  " }), { text: null });
  });

  test("very long notes preserved verbatim (after trim)", () => {
    const long = "x".repeat(10000);
    assert.equal(fn({ notes: long }).text, long);
  });

  test("multi-line notes preserved (only outer trim)", () => {
    assert.deepEqual(fn({ notes: "line1\nline2\nline3" }),
                     { text: "line1\nline2\nline3" });
  });

  test("unicode notes preserved", () => {
    assert.deepEqual(fn({ notes: "café · résumé · 中文 · 😀" }),
                     { text: "café · résumé · 中文 · 😀" });
  });
});

describe("projectNotesForSession — malformed/partial + never-throws (Phase 36e)", () => {
  const fn = parity.projectNotesForSession;

  test("missing dcrDoc field (no notes) returns null", () => {
    assert.deepEqual(fn({ customer_slug: "x" }), { text: null });
  });

  test("undefined input never throws + returns null", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(undefined); });
    assert.deepEqual(r, { text: null });
  });

  test("null input never throws + returns null", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(null); });
    assert.deepEqual(r, { text: null });
  });

  test("no args never throws + returns null", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(); });
    assert.deepEqual(r, { text: null });
  });

  test("non-object primitives never throw", () => {
    [42, true, false, "string", Symbol("s"), 0n].forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on primitive idx " + idx);
    });
  });

  test("number notes returns null (must be string)", () => {
    assert.deepEqual(fn({ notes: 42 }), { text: null });
  });

  test("boolean notes returns null", () => {
    assert.deepEqual(fn({ notes: true }),  { text: null });
    assert.deepEqual(fn({ notes: false }), { text: null });
  });

  test("array notes returns null (must be string)", () => {
    assert.deepEqual(fn({ notes: ["a", "b"] }), { text: null });
  });

  test("object notes returns null (must be string)", () => {
    assert.deepEqual(fn({ notes: { text: "hi" } }), { text: null });
  });

  test("sweep: adversarial values never throw", () => {
    const inputs = [
      undefined, null, true, false, 0, 42, NaN, Infinity, -Infinity,
      "", "garbage", [], [null], {}, { notes: null }, { notes: [] },
      { notes: {} }, { notes: 0 }, { notes: NaN },
      () => {}, Symbol("s"), 0n, new Map(), new Set(), new Date(), /r/,
      Buffer.from("bytes")
    ];
    inputs.forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on idx " + idx);
    });
  });
});

// ============================================================
// projectOccupancyForSession (Phase 36e)
// ============================================================
describe("projectOccupancyForSession — happy path (Phase 36e)", () => {
  const fn = parity.projectOccupancyForSession;

  test("V1 string 'yes' + level string -> { true, level }", () => {
    assert.deepEqual(
      fn({ anyone_in_building: "yes", occupancy_level: "high" }),
      { anyone_in_building: true, occupancy_level: "high" }
    );
  });

  test("V1 string 'no' + level 'empty'", () => {
    assert.deepEqual(
      fn({ anyone_in_building: "no", occupancy_level: "empty" }),
      { anyone_in_building: false, occupancy_level: "empty" }
    );
  });

  test("boolean true + level", () => {
    assert.deepEqual(
      fn({ anyone_in_building: true, occupancy_level: "medium" }),
      { anyone_in_building: true, occupancy_level: "medium" }
    );
  });

  test("boolean false + level", () => {
    assert.deepEqual(
      fn({ anyone_in_building: false, occupancy_level: "low" }),
      { anyone_in_building: false, occupancy_level: "low" }
    );
  });

  test("only anyone_in_building present (level missing)", () => {
    assert.deepEqual(
      fn({ anyone_in_building: "yes" }),
      { anyone_in_building: true, occupancy_level: null }
    );
  });

  test("only occupancy_level present (anyone missing)", () => {
    assert.deepEqual(
      fn({ occupancy_level: "high" }),
      { anyone_in_building: null, occupancy_level: "high" }
    );
  });

  test("level string trimmed", () => {
    assert.deepEqual(
      fn({ anyone_in_building: "no", occupancy_level: "  empty  " }),
      { anyone_in_building: false, occupancy_level: "empty" }
    );
  });
});

describe("projectOccupancyForSession — malformed/partial + never-throws (Phase 36e)", () => {
  const fn = parity.projectOccupancyForSession;

  test("neither field present returns null (dcr has no occupancy at all)", () => {
    assert.equal(fn({ customer_slug: "x" }), null);
  });

  test("empty string level treated as absent", () => {
    assert.equal(fn({ occupancy_level: "" }), null);
  });

  test("whitespace-only level treated as absent", () => {
    assert.equal(fn({ occupancy_level: "   " }), null);
  });

  test("undefined input never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(undefined); });
    assert.equal(r, null);
  });

  test("null input never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(null); });
    assert.equal(r, null);
  });

  test("no args never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(); });
    assert.equal(r, null);
  });

  test("non-object primitives never throw", () => {
    [42, true, "s", Symbol("s"), 0n].forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on idx " + idx);
    });
  });

  test("anyone_in_building as unrecognized string ('maybe') treated as absent", () => {
    assert.equal(fn({ anyone_in_building: "maybe" }), null);
  });

  test("anyone as unrecognized string but level present -> anyone=null, level=str", () => {
    assert.deepEqual(
      fn({ anyone_in_building: "maybe", occupancy_level: "low" }),
      { anyone_in_building: null, occupancy_level: "low" }
    );
  });

  test("anyone as number 1 treated as absent (only true/false/'yes'/'no')", () => {
    assert.equal(fn({ anyone_in_building: 1 }), null);
  });

  test("anyone as object treated as absent", () => {
    assert.equal(fn({ anyone_in_building: { yes: true } }), null);
  });

  test("occupancy_level as number treated as absent (must be string)", () => {
    assert.equal(fn({ occupancy_level: 5 }), null);
  });

  test("occupancy_level as array treated as absent", () => {
    assert.equal(fn({ occupancy_level: ["high"] }), null);
  });

  test("occupancy_level as object treated as absent", () => {
    assert.equal(fn({ occupancy_level: { value: "high" } }), null);
  });

  test("sweep: adversarial values never throw", () => {
    const inputs = [
      undefined, null, true, false, 0, 42, NaN, Infinity, -Infinity,
      "", "garbage", [], [null], {}, { anyone_in_building: null },
      { occupancy_level: null }, { anyone_in_building: {}, occupancy_level: {} },
      () => {}, Symbol("s"), 0n, new Map(), new Set(), new Date(), /r/,
      Buffer.from("bytes")
    ];
    inputs.forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on idx " + idx);
    });
  });
});

// ============================================================
// projectSuppliesForSession (Phase 36e)
// ============================================================
describe("projectSuppliesForSession — happy path (Phase 36e)", () => {
  const fn = parity.projectSuppliesForSession;

  test("needs_supplies=true + text -> requested + trimmed text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: "TP x2" }),
      { status: "requested", request_text: "TP x2" }
    );
  });

  test("needs_supplies=true + whitespace text is trimmed", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: "  gloves  " }),
      { status: "requested", request_text: "gloves" }
    );
  });

  test("needs_supplies=true + empty text -> requested with null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: "" }),
      { status: "requested", request_text: null }
    );
  });

  test("needs_supplies=true + missing text -> requested with null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true }),
      { status: "requested", request_text: null }
    );
  });

  test("needs_supplies=false -> not_applicable", () => {
    assert.deepEqual(
      fn({ needs_supplies: false, supply_request_text: "ignored" }),
      { status: "not_applicable", request_text: null }
    );
  });

  test("needs_supplies field absent -> not_applicable", () => {
    assert.deepEqual(
      fn({ customer_slug: "x" }),
      { status: "not_applicable", request_text: null }
    );
  });

  test("very long request_text preserved (after trim)", () => {
    const long = "supply " + "x".repeat(5000);
    assert.equal(fn({ needs_supplies: true, supply_request_text: long })
                   .request_text, long);
  });
});

describe("projectSuppliesForSession — malformed/partial + never-throws (Phase 36e)", () => {
  const fn = parity.projectSuppliesForSession;

  test("undefined input never throws + returns not_applicable", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(undefined); });
    assert.deepEqual(r, { status: "not_applicable", request_text: null });
  });

  test("null input never throws + returns not_applicable", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(null); });
    assert.deepEqual(r, { status: "not_applicable", request_text: null });
  });

  test("no args never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(); });
    assert.deepEqual(r, { status: "not_applicable", request_text: null });
  });

  test("needs_supplies as truthy non-true ('true' string) -> not_applicable", () => {
    assert.deepEqual(
      fn({ needs_supplies: "true", supply_request_text: "x" }),
      { status: "not_applicable", request_text: null }
    );
  });

  test("needs_supplies as truthy number (1) -> not_applicable (strict === true)", () => {
    assert.deepEqual(
      fn({ needs_supplies: 1, supply_request_text: "x" }),
      { status: "not_applicable", request_text: null }
    );
  });

  test("needs_supplies=true + text is number -> requested with null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: 42 }),
      { status: "requested", request_text: null }
    );
  });

  test("needs_supplies=true + text is array -> requested with null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: ["a"] }),
      { status: "requested", request_text: null }
    );
  });

  test("needs_supplies=true + text is object -> requested with null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: { note: "hi" } }),
      { status: "requested", request_text: null }
    );
  });

  test("needs_supplies=true + text is whitespace-only -> null text", () => {
    assert.deepEqual(
      fn({ needs_supplies: true, supply_request_text: "   \t  " }),
      { status: "requested", request_text: null }
    );
  });

  test("non-object primitives never throw", () => {
    [42, true, false, "string", Symbol("s"), 0n].forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on primitive idx " + idx);
    });
  });

  test("sweep: adversarial values never throw", () => {
    const inputs = [
      undefined, null, true, false, 0, 42, NaN, Infinity, -Infinity,
      "", "garbage", [], [null], {}, { needs_supplies: null },
      { needs_supplies: "yes" }, { needs_supplies: {} },
      { needs_supplies: true, supply_request_text: null },
      { needs_supplies: true, supply_request_text: {} },
      () => {}, Symbol("s"), 0n, new Map(), new Set(), new Date(), /r/,
      Buffer.from("bytes")
    ];
    inputs.forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on idx " + idx);
    });
  });
});

// ============================================================
// projectProblemForSession (Phase 36e)
// ============================================================
describe("projectProblemForSession — happy path (Phase 36e)", () => {
  const fn = parity.projectProblemForSession;

  test("has_problem=true + full report -> reported + normalized report", () => {
    const r = fn({
      has_problem: true,
      problem: {
        category: "customer-complaint",
        summary:  "Smudge on lobby glass",
        details:  "Customer walked in and noticed streak",
        location: "lobby",
        our_fault: true
      }
    });
    assert.equal(r.status, "reported");
    assert.deepEqual(r.report, {
      category: "customer-complaint",
      summary:  "Smudge on lobby glass",
      details:  "Customer walked in and noticed streak",
      location: "lobby",
      our_fault: true
    });
  });

  test("has_problem=true + our_fault=false", () => {
    const r = fn({
      has_problem: true,
      problem: {
        category: "site-condition",
        summary:  "Broken window",
        details:  "Existed before we arrived",
        location: "back-office",
        our_fault: false
      }
    });
    assert.equal(r.status, "reported");
    assert.equal(r.report.our_fault, false);
  });

  test("has_problem=true + strings trimmed", () => {
    const r = fn({
      has_problem: true,
      problem: {
        category: "  broken-equipment  ",
        summary:  "  short summary  ",
        details:  "  full details  ",
        location: "  garage  ",
        our_fault: true
      }
    });
    assert.equal(r.report.category, "broken-equipment");
    assert.equal(r.report.summary,  "short summary");
    assert.equal(r.report.details,  "full details");
    assert.equal(r.report.location, "garage");
  });

  test("has_problem=true + empty strings normalize to null", () => {
    const r = fn({
      has_problem: true,
      problem: {
        category: "",
        summary:  "",
        details:  "",
        location: "",
        our_fault: null
      }
    });
    assert.equal(r.status, "reported");
    assert.deepEqual(r.report, {
      category: null, summary: null, details: null,
      location: null, our_fault: null
    });
  });

  test("has_problem=true + partial report (only summary) fills nulls elsewhere", () => {
    const r = fn({
      has_problem: true,
      problem: { summary: "just this" }
    });
    assert.equal(r.status, "reported");
    assert.deepEqual(r.report, {
      category: null, summary: "just this", details: null,
      location: null, our_fault: null
    });
  });

  test("has_problem=false -> not_applicable", () => {
    assert.deepEqual(fn({ has_problem: false, problem: { category: "x" } }),
                     { status: "not_applicable", report: null });
  });

  test("has_problem field absent -> not_applicable", () => {
    assert.deepEqual(fn({ customer_slug: "x" }),
                     { status: "not_applicable", report: null });
  });

  test("has_problem=true + problem missing -> reported with null shell", () => {
    assert.deepEqual(fn({ has_problem: true }), {
      status: "reported",
      report: { category: null, summary: null, details: null,
                location: null, our_fault: null }
    });
  });

  test("has_problem=true + problem=null -> reported with null shell", () => {
    assert.deepEqual(fn({ has_problem: true, problem: null }), {
      status: "reported",
      report: { category: null, summary: null, details: null,
                location: null, our_fault: null }
    });
  });
});

describe("projectProblemForSession — malformed/partial + never-throws (Phase 36e)", () => {
  const fn = parity.projectProblemForSession;

  test("undefined input never throws + returns not_applicable", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(undefined); });
    assert.deepEqual(r, { status: "not_applicable", report: null });
  });

  test("null input never throws + returns not_applicable", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(null); });
    assert.deepEqual(r, { status: "not_applicable", report: null });
  });

  test("no args never throws", () => {
    let r;
    assert.doesNotThrow(() => { r = fn(); });
    assert.deepEqual(r, { status: "not_applicable", report: null });
  });

  test("has_problem as string 'true' -> not_applicable (strict === true)", () => {
    assert.deepEqual(
      fn({ has_problem: "true", problem: { category: "x" } }),
      { status: "not_applicable", report: null }
    );
  });

  test("has_problem as truthy number (1) -> not_applicable", () => {
    assert.deepEqual(
      fn({ has_problem: 1, problem: { category: "x" } }),
      { status: "not_applicable", report: null }
    );
  });

  test("has_problem=true + problem is array -> reported with null shell", () => {
    assert.deepEqual(fn({ has_problem: true, problem: ["a"] }), {
      status: "reported",
      report: { category: null, summary: null, details: null,
                location: null, our_fault: null }
    });
  });

  test("has_problem=true + problem is string -> reported with null shell", () => {
    assert.deepEqual(fn({ has_problem: true, problem: "garbage" }), {
      status: "reported",
      report: { category: null, summary: null, details: null,
                location: null, our_fault: null }
    });
  });

  test("has_problem=true + numeric fields inside problem normalize to null", () => {
    const r = fn({
      has_problem: true,
      problem: { category: 42, summary: 7, details: [], location: {}, our_fault: 1 }
    });
    assert.equal(r.report.category,  null);
    assert.equal(r.report.summary,   null);
    assert.equal(r.report.details,   null);
    assert.equal(r.report.location,  null);
    assert.equal(r.report.our_fault, null);
  });

  test("has_problem=true + our_fault as string 'yes' -> null (strict bool)", () => {
    const r = fn({
      has_problem: true,
      problem: { summary: "s", our_fault: "yes" }
    });
    assert.equal(r.report.our_fault, null);
  });

  test("has_problem=true + all fields whitespace -> nulls", () => {
    const r = fn({
      has_problem: true,
      problem: {
        category: "   ", summary: "\t\n", details: "  ",
        location: " ", our_fault: null
      }
    });
    assert.deepEqual(r.report, {
      category: null, summary: null, details: null,
      location: null, our_fault: null
    });
  });

  test("non-object dcrDoc primitives never throw", () => {
    [42, true, false, "string", Symbol("s"), 0n].forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on primitive idx " + idx);
    });
  });

  test("nested cycles inside problem don't crash (we don't walk them)", () => {
    const p = { summary: "s" };
    p.self = p;
    let r;
    assert.doesNotThrow(() => {
      r = fn({ has_problem: true, problem: p });
    });
    assert.equal(r.status, "reported");
    assert.equal(r.report.summary, "s");
  });

  test("sweep: adversarial values never throw", () => {
    const inputs = [
      undefined, null, true, false, 0, 42, NaN, Infinity, -Infinity,
      "", "garbage", [], [null], {},
      { has_problem: null },
      { has_problem: "yes" },
      { has_problem: {} },
      { has_problem: true, problem: null },
      { has_problem: true, problem: undefined },
      { has_problem: true, problem: "" },
      { has_problem: true, problem: 42 },
      { has_problem: true, problem: true },
      { has_problem: true, problem: [] },
      { has_problem: true, problem: {} },
      { has_problem: true, problem: { category: {}, summary: [], details: 0,
                                       location: null, our_fault: "x" } },
      () => {}, Symbol("s"), 0n, new Map(), new Set(), new Date(), /r/,
      Buffer.from("bytes")
    ];
    inputs.forEach((v, idx) => {
      assert.doesNotThrow(() => fn(v), "threw on idx " + idx);
    });
  });
});
