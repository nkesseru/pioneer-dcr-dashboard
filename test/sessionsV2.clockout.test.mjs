// SessionV2 Phase 35b — clock-out advance functional tests.
// Run via: npm run test:clockout:sessionsV2
//
// Tests the rule-layer + schema invariants for the clock-out advancement.
// The CF endpoint itself runs against prod (curl smoke after deploy).
// Here we verify rule permission semantics + schema-shape invariants
// that a successful advance would produce.

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
const OTHER_TECH_EMAIL = "tech2@example.com";
const OTHER_TECH_UID   = "tech_uid_2";

let env;

function compMap(s) {
  return { status: s, started_at: null, last_event_at: null, completed_at: null,
           last_event: null, error: null, count: null, pct: null, ref: null };
}

function makeSession(id, overrides = {}) {
  return {
    session_id:        id,
    schema_version:    2,
    source:            "tech_clock",
    environment:       "production",
    attempt_number:    1,
    session_type:      "office_cleaning",
    assignment_id:     "asg_test",
    staff_uid:         TECH_UID,
    staff_email:       TECH_EMAIL,
    customer_id:       "cedar-llc",
    customer_slug:     "cedar-llc",
    customer_name:     "Cedar LLC",
    service_date:      "2026-06-26",
    parent_route_id:   "rt_" + TECH_UID + "_2026-06-26",
    expected_components: ["clock", "gps", "photos", "checklist", "dcr", "customer_email", "payroll"],
    components: {
      clock: compMap("collecting"), gps: compMap("collecting"),
      photos: compMap("missing"), checklist: compMap("missing"),
      dcr: compMap("missing"), customer_email: compMap("missing"),
      payroll: compMap("missing")
    },
    status:            "in_progress",
    status_changed_at: new Date(),
    status_version:    2,
    admin_removed:     false,
    v1_session_id:     "v1_random_abc",
    clock_in_at:       new Date(),
    timeline: [{ ts: new Date(), event: "session.created", title: "Session created" }],
    created_at:        new Date(),
    created_by:        { type: "tech", uid: TECH_UID, email: TECH_EMAIL, name: "Tech 1" },
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
    const db = ctx.firestore();
    await db.doc(`active_techs_by_email/${TECH_EMAIL}`).set({
      active: true, slug: "tech-1", email: TECH_EMAIL
    });
    await db.doc(`active_techs_by_email/${OTHER_TECH_EMAIL}`).set({
      active: true, slug: "tech-2", email: OTHER_TECH_EMAIL
    });
  });
});

after(async () => { if (env) await env.cleanup(); });

function adminCtx() { return env.authenticatedContext("admin_uid", { email: ADMIN_EMAIL }); }
function techCtx()  { return env.authenticatedContext(TECH_UID,    { email: TECH_EMAIL  }); }
function otherCtx() { return env.authenticatedContext(OTHER_TECH_UID, { email: OTHER_TECH_EMAIL }); }

// ============================================================
// Tech-allowed transition from in_progress -> awaiting_completion
// ============================================================
describe("sessionsV2 clock-out tech-allowed transition (rules)", () => {
  before(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`active_techs_by_email/${TECH_EMAIL}`).set({
        active: true, slug: "tech-1", email: TECH_EMAIL
      });
      await ctx.firestore().doc(`active_techs_by_email/${OTHER_TECH_EMAIL}`).set({
        active: true, slug: "tech-2", email: OTHER_TECH_EMAIL
      });
      await ctx.firestore().doc("sessionsV2/sess_co_inprog").set(
        makeSession("sess_co_inprog", { status: "in_progress" })
      );
      await ctx.firestore().doc("sessionsV2/sess_co_paused").set(
        makeSession("sess_co_paused", { status: "paused" })
      );
      await ctx.firestore().doc("sessionsV2/sess_co_complete").set(
        makeSession("sess_co_complete", { status: "complete" })
      );
      await ctx.firestore().doc("sessionsV2/sess_co_locked").set(
        makeSession("sess_co_locked", { status: "locked" })
      );
      await ctx.firestore().doc("sessionsV2/sess_co_archived").set(
        makeSession("sess_co_archived", { status: "archived", admin_removed: true })
      );
      await ctx.firestore().doc("sessionsV2/sess_co_other").set(
        makeSession("sess_co_other", {
          status: "in_progress", staff_uid: OTHER_TECH_UID, staff_email: OTHER_TECH_EMAIL
        })
      );
    });
  });

  test("tech CAN transition own in_progress -> awaiting_completion (rule allows)", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_co_inprog").update({
        status: "awaiting_completion",
        status_changed_at: new Date(),
        status_version: 3,
        clock_out_at: new Date(),
        "components.clock.status": "complete",
        timeline: [{ ts: new Date(), event: "clock.out" }],
        updated_at: new Date()
      })
    );
  });

  test("tech CAN transition own paused -> awaiting_completion (rule allows)", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_co_paused").update({
        status: "awaiting_completion",
        status_changed_at: new Date(),
        status_version: 3,
        clock_out_at: new Date(),
        "components.clock.status": "complete",
        timeline: [{ ts: new Date(), event: "clock.out" }],
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT transition another tech's session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_co_other").update({
        status: "awaiting_completion",
        status_changed_at: new Date(),
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT edit a locked session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_co_locked").update({
        status: "awaiting_completion",
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT edit an archived session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_co_archived").update({
        status: "awaiting_completion",
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT skip from in_progress -> complete (only awaiting_completion allowed)", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_co_inprog").update({
        status: "complete",
        status_changed_at: new Date(),
        updated_at: new Date()
      })
    );
  });
});

// ============================================================
// Admin can perform clock-out advance on any session
// ============================================================
describe("sessionsV2 clock-out admin transition (rules)", () => {
  before(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("sessionsV2/sess_co_admin").set(
        makeSession("sess_co_admin", { status: "in_progress" })
      );
    });
  });

  test("admin CAN advance any session", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_co_admin").update({
        status: "awaiting_completion",
        status_changed_at: new Date(),
        status_version: 3,
        clock_out_at: new Date(),
        updated_at: new Date()
      })
    );
  });
});

// ============================================================
// Status_lag detection helper logic (pure JS test of reconcile decision tree)
// ============================================================
describe("status_lag detection logic", () => {
  function detectLag(v1Status, v2Status) {
    const V1_OPEN  = ["active", "paused"];
    const V2_OPEN  = ["assigned", "ready", "in_progress", "paused"];
    const V2_CLOSED = [
      "awaiting_completion", "complete", "pending_payroll_review",
      "payroll_approved", "exported", "customer_notified", "locked"
    ];
    if (V1_OPEN.indexOf(v1Status) >= 0 && V2_CLOSED.indexOf(v2Status) >= 0) return "status_ahead";
    if (v1Status === "completed" && V2_OPEN.indexOf(v2Status) >= 0) return "status_lag";
    return "ok";
  }

  test("V1 completed + V2 in_progress => status_lag", () => {
    assert.equal(detectLag("completed", "in_progress"), "status_lag");
  });
  test("V1 completed + V2 awaiting_completion => ok", () => {
    assert.equal(detectLag("completed", "awaiting_completion"), "ok");
  });
  test("V1 active + V2 in_progress => ok", () => {
    assert.equal(detectLag("active", "in_progress"), "ok");
  });
  test("V1 active + V2 complete => status_ahead", () => {
    assert.equal(detectLag("active", "complete"), "status_ahead");
  });
});
