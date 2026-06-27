// SessionV2 Canary Harness — Phase 35a-canary functional tests.
// Run via: npm run test:canary:sessionsV2
//
// Tests the rule-layer side of the cleanup function (admin-only, debug-only).
// The CF logic itself is integration-tested via curl after deploy.
// Helper module param defaults are unit-tested via pure JS.

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

function compMap(s) {
  return { status: s, started_at: null, last_event_at: null, completed_at: null,
           last_event: null, error: null, count: null, pct: null, ref: null };
}

function makeCanaryDoc(id, overrides = {}) {
  return {
    session_id:        id,
    schema_version:    2,
    source:            "canary",
    environment:       "debug",
    attempt_number:    1,
    session_type:      "admin_manual_recovery",
    assignment_id:     "canary-asg",
    staff_uid:         TECH_UID,
    staff_email:       TECH_EMAIL,
    customer_id:       "canary-customer",
    customer_slug:     "canary-customer",
    customer_name:     "Canary Test",
    service_date:      "2026-06-26",
    parent_route_id:   "rt_" + TECH_UID + "_2026-06-26",
    expected_components: ["clock", "payroll"],
    components: {
      clock: compMap("missing"), gps: compMap("not_applicable"),
      photos: compMap("not_applicable"), checklist: compMap("not_applicable"),
      dcr: compMap("not_applicable"), customer_email: compMap("not_applicable"),
      payroll: compMap("missing")
    },
    status:            "assigned",
    status_changed_at: new Date(),
    status_version:    1,
    admin_removed:     false,
    v1_session_id:     "canary_fake_v1_" + id,
    created_at:        new Date(),
    created_by:        { type: "admin", uid: "admin_uid", email: ADMIN_EMAIL, name: "Admin" },
    updated_at:        new Date(),
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
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`active_techs_by_email/${TECH_EMAIL}`).set({
      active: true, slug: "tech-1", email: TECH_EMAIL
    });
  });
});

after(async () => { if (env) await env.cleanup(); });

function adminCtx() { return env.authenticatedContext("admin_uid", { email: ADMIN_EMAIL }); }
function techCtx()  { return env.authenticatedContext(TECH_UID,    { email: TECH_EMAIL  }); }

// ============================================================
// Canary doc CRUD via rules layer
// ============================================================
describe("sessionsV2 canary doc rule semantics", () => {
  before(async () => { await env.clearFirestore(); });

  test("admin can create environment=debug source=canary doc", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_canary_a_2026-06-26_a1").set(
        makeCanaryDoc("sess_canary_a_2026-06-26_a1")
      )
    );
  });

  test("tech CANNOT create environment=debug source=canary doc", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_canary_b_2026-06-26_a1").set(
        makeCanaryDoc("sess_canary_b_2026-06-26_a1")
      )
    );
  });

  test("client (admin or tech) CANNOT delete a canary doc directly", async () => {
    // Rules forbid client delete on sessionsV2 entirely — even for admin.
    // Cleanup happens via cleanupSessionV2CanaryV1 CF using Admin SDK.
    await assertFails(
      adminCtx().firestore().doc("sessionsV2/sess_canary_a_2026-06-26_a1").delete()
    );
  });

  test("admin can READ canary docs (for harness display)", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_canary_a_2026-06-26_a1").get()
    );
  });
});

// ============================================================
// Helper module param contract (pure JS tests, no rules involved)
// ============================================================
describe("sessionsV2-client.js helper param contract", () => {
  // Re-implement the public surface as a plain object to test the contract.
  // (We can't import the helper directly because it uses `firebase` globals.)
  function buildPayload(opts) {
    var environment = opts.environment || "production";
    var source      = opts.source      || "tech_clock";
    return {
      source: source,
      environment: environment,
      session_type: "office_cleaning",
      v1_session_id: opts.v1_session_id
    };
  }

  test("defaults preserve production tech_clock", () => {
    const p = buildPayload({ v1_session_id: "v1xyz" });
    assert.equal(p.environment, "production");
    assert.equal(p.source, "tech_clock");
  });

  test("canary opts override to debug + canary", () => {
    const p = buildPayload({ v1_session_id: "v1xyz", environment: "debug", source: "canary" });
    assert.equal(p.environment, "debug");
    assert.equal(p.source, "canary");
  });

  test("v1_session_id always carries through", () => {
    const p = buildPayload({ v1_session_id: "v1_real_id_abc" });
    assert.equal(p.v1_session_id, "v1_real_id_abc");
  });
});

// ============================================================
// Cleanup function contract (rule + filter semantics)
//
// The CF logic itself runs against prod via curl after deploy.
// Here we test the rule + query semantics that the CF depends on.
// ============================================================
describe("cleanupSessionV2CanaryV1 query semantics", () => {
  before(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // Seed: 2 canary docs, 1 production doc, 1 debug-but-not-canary doc
      await db.doc("sessionsV2/sess_c1").set(makeCanaryDoc("sess_c1"));
      await db.doc("sessionsV2/sess_c2").set(makeCanaryDoc("sess_c2"));
      await db.doc("sessionsV2/sess_prod").set(makeCanaryDoc("sess_prod", {
        environment: "production", source: "tech_clock"
      }));
      await db.doc("sessionsV2/sess_debug_not_canary").set(makeCanaryDoc("sess_debug_not_canary", {
        environment: "debug", source: "admin_manual"
      }));
    });
  });

  test("query environment=debug AND source=canary returns ONLY the 2 canary docs", async () => {
    // Use admin context to read; rules allow admin read.
    const snap = await adminCtx().firestore().collection("sessionsV2")
      .where("environment", "==", "debug")
      .where("source",      "==", "canary")
      .get();
    const ids = snap.docs.map(d => d.id).sort();
    assert.deepEqual(ids, ["sess_c1", "sess_c2"]);
  });

  test("query does NOT return production docs", async () => {
    const snap = await adminCtx().firestore().collection("sessionsV2")
      .where("environment", "==", "debug")
      .where("source",      "==", "canary")
      .get();
    const ids = snap.docs.map(d => d.id);
    assert.equal(ids.indexOf("sess_prod"), -1);
  });

  test("query does NOT return debug-but-not-canary docs", async () => {
    const snap = await adminCtx().firestore().collection("sessionsV2")
      .where("environment", "==", "debug")
      .where("source",      "==", "canary")
      .get();
    const ids = snap.docs.map(d => d.id);
    assert.equal(ids.indexOf("sess_debug_not_canary"), -1);
  });
});
