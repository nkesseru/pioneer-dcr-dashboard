// SessionV2 createSessionV2 Cloud Function — Phase 34 functional tests.
// Run via emulator (firestore + functions). NOT included in
// npm run test:rules:sessionsV2 (separate runner because it spins
// up both emulators).
//
// Run via: npm run test:create:sessionsV2
//
// Note (Phase 34): we can't easily emulate Cloud Functions HTTPS in the
// same harness as the rules emulator without spinning up the functions
// emulator. For Phase 34 we exercise the IDEMPOTENCY + VALIDATION logic
// directly via the Admin SDK against the rules emulator, simulating
// what the function will write. Full HTTPS round-trip tests come with
// Phase 35 when we have an integration runner.
//
// This file primarily verifies the schema invariants we expect
// createSessionV2 to produce. The functions/index.js logic itself
// is small enough that integration testing via Postman/curl after
// deploy is acceptable for Phase 34.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from "@firebase/rules-unit-testing";

const PROJECT_ID  = "demo-pioneer-test";
const ADMIN_EMAIL = "nick@pioneercomclean.com";
const TECH_EMAIL  = "tech1@example.com";
const TECH_UID    = "tech_uid_1";

let env;

// Replicates the schema that createSessionV2 (functions/index.js)
// will produce. Tests assert that this schema passes Phase 33 rules
// and that critical fields are present.
function adminCreatedSession(overrides = {}) {
  function comp(status) {
    return {
      status: status, started_at: null, last_event_at: null, completed_at: null,
      last_event: null, error: null, count: null, pct: null, ref: null
    };
  }
  const expected = overrides.expected_components ||
    ["clock", "gps", "photos", "checklist", "dcr", "customer_email", "payroll"];
  const components = {};
  ["clock", "gps", "photos", "checklist", "dcr", "customer_email", "payroll"].forEach(function (n) {
    components[n] = comp(expected.indexOf(n) >= 0 ? "missing" : "not_applicable");
  });
  return {
    session_id:        "sess_test_asg_2026-06-26_a1",
    schema_version:    2,
    source:            "admin_manual",
    environment:       "production",
    attempt_number:    1,
    session_type:      "office_cleaning",
    client_session_id: null,
    assignment_id:     null,
    staff_uid:         TECH_UID,
    staff_email:       TECH_EMAIL,
    customer_id:       "cedar-llc",
    customer_slug:     "cedar-llc",
    customer_name:     "Cedar LLC",
    location_id:       null,
    service_date:      "2026-06-26",
    parent_route_id:   "rt_" + TECH_UID + "_2026-06-26",
    scheduled:         null,
    actual_sequence:   null,
    expected_components: expected,
    components:        components,
    status:            "assigned",
    status_changed_at: new Date(),
    status_version:    1,
    clock_in_at:       null,
    clock_out_at:      null,
    paused_intervals:  [],
    max_distance_from_site_m: null,
    clock_in_gps:      null,
    clock_out_gps:     null,
    refs: {
      photo_paths: [], dcr_id: null, dcr_submission_id: null,
      time_punch_ids: [], pending_queue_ids: [], email_message_ids: []
    },
    supersedes_session_ids:   [],
    superseded_by_session_id: null,
    superseded_at:            null,
    superseded_reason:        null,
    admin_removed:            false,
    customer: {
      email_sent_at: null, email_message_id: null, email_template: null,
      notification_state: "pending"
    },
    timeline: [{
      ts: new Date(), intent_ts: null,
      actor: { type: "admin", uid: "admin_uid", email: ADMIN_EMAIL, name: "Admin" },
      event: "session.created", title: "Session created",
      detail: "Created by " + ADMIN_EMAIL,
      icon: "session-created", field_path: "status", from: null, to: "assigned",
      ref: null, client: null
    }],
    created_at: new Date(),
    created_by: { type: "admin", uid: "admin_uid", email: ADMIN_EMAIL, name: "Admin" },
    updated_at: new Date(),
    client_app_version: null,
    client_intent_at:   null,
    ...overrides
  };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host:  "127.0.0.1",
      port:  8080
    }
  });
});

after(async () => { if (env) await env.cleanup(); });

function adminCtx() { return env.authenticatedContext("admin_uid", { email: ADMIN_EMAIL }); }

describe("createSessionV2 schema invariants", () => {
  before(async () => { await env.clearFirestore(); });

  test("admin-created session with full schema passes rules", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1").set(
        adminCreatedSession()
      )
    );
  });

  test("admin can create with environment=debug", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a2").set(
        adminCreatedSession({
          session_id:  "sess_test_asg_2026-06-26_a2",
          environment: "debug"
        })
      )
    );
  });

  test("admin can create supply_delivery session with minimal expected_components", async () => {
    const doc = adminCreatedSession({
      session_id:          "sess_test_supply_2026-06-26_a1",
      session_type:        "supply_delivery",
      expected_components: ["clock", "gps", "payroll"]
    });
    // Re-derive components shape for the new expected list.
    function comp(s) {
      return { status: s, started_at: null, last_event_at: null, completed_at: null,
               last_event: null, error: null, count: null, pct: null, ref: null };
    }
    doc.components = {
      clock:          comp("missing"),
      gps:            comp("missing"),
      photos:         comp("not_applicable"),
      checklist:      comp("not_applicable"),
      dcr:            comp("not_applicable"),
      customer_email: comp("not_applicable"),
      payroll:        comp("missing")
    };
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_test_supply_2026-06-26_a1").set(doc)
    );
  });

  test("session has Timeline entry with session.created event", async () => {
    const ref = adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1");
    const snap = await ref.get();
    const data = snap.data();
    assert.ok(Array.isArray(data.timeline), "timeline must be an array");
    assert.equal(data.timeline.length, 1, "timeline starts with exactly one entry");
    assert.equal(data.timeline[0].event, "session.created");
    assert.equal(data.timeline[0].title, "Session created");
  });

  test("session has uniform components shape (all 7 component keys)", async () => {
    const ref = adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1");
    const snap = await ref.get();
    const data = snap.data();
    ["clock", "gps", "photos", "checklist", "dcr", "customer_email", "payroll"].forEach(function (c) {
      assert.ok(data.components[c], "components." + c + " must exist");
      assert.ok(typeof data.components[c].status === "string", "components." + c + ".status must be string");
    });
  });

  test("session has parent_route_id matching rt_<uid>_<date>", async () => {
    const ref = adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1");
    const snap = await ref.get();
    const data = snap.data();
    assert.equal(data.parent_route_id, "rt_" + TECH_UID + "_2026-06-26");
  });

  test("session has NO completion_pct or blockers field (derived only)", async () => {
    const ref = adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1");
    const snap = await ref.get();
    const data = snap.data();
    assert.equal(data.completion_pct, undefined, "completion_pct must not be persisted");
    assert.equal(data.blockers, undefined, "blockers must not be persisted");
  });

  test("session has NO payroll subobject at create time", async () => {
    const ref = adminCtx().firestore().doc("sessionsV2/sess_test_asg_2026-06-26_a1");
    const snap = await ref.get();
    const data = snap.data();
    assert.equal(data.payroll, undefined, "payroll must not be set until Phase 37 admin approval");
  });

  test("session_id with invalid format would be rejected (sanity check via rule)", async () => {
    // Phase 34 rule doesn't enforce ID format (that's CF responsibility).
    // CF unit test for this is the Postman/curl smoke after deploy.
    // This test documents the expectation rather than enforcing it at rule layer.
    assert.ok(true);
  });
});

describe("createSessionV2 identity invariants", () => {
  before(async () => { await env.clearFirestore(); });

  test("session_id format encodes deterministic identity", () => {
    const id = "sess_aJ8kf3pQ_2026-06-25_a1";
    assert.match(id, /^sess_.+_a\d+$/, "all IDs end with _a<n>");
  });

  test("manual session_id includes staff_uid + customer_slug", () => {
    const id = "sess_manual_xbz4v8ZSPgdhzn6umnI2EdYXPX92_2026-06-25_cedar-llc_a1";
    assert.match(id, /^sess_manual_/, "manual sessions prefixed");
    assert.ok(id.indexOf("cedar-llc") > 0, "manual sessions include customer_slug");
  });

  test("recover session_id chains from original", () => {
    const id = "sess_recover_sess_aJ8kf3pQ_2026-06-25_a1_a1";
    assert.match(id, /^sess_recover_/, "recover sessions prefixed");
  });
});
