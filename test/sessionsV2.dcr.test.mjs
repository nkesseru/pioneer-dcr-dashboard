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
