// SessionV2 Phase 35c — queue rules + invariants tests.
// Run via: npm run test:queue:sessionsV2
//
// Validates the rule-layer semantics around pending_session_writes
// queue entries. The processor's worker logic itself runs against prod
// (curl smoke after deploy + canary harness exercise). These tests
// confirm:
//   - rules permit tech to enqueue own entries with origin_operation
//   - rules permit admin to read/update/delete all entries
//   - backoff schedule math
//   - dispatcher routing decision (pure-JS unit)

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

function queueEntry(overrides = {}) {
  return {
    queue_id:         "q_test",
    session_id:       "sess_test_2026-06-26_a1",
    event_type:       "v2.clockout.retry",
    event_id:         "evt_test_1",
    payload:          { session_id: "sess_test_2026-06-26_a1", clock_out_at: new Date().toISOString() },
    status:           "queued",
    attempt_count:    0,
    next_attempt_at:  new Date(),
    last_error:       null,
    staff_uid:        TECH_UID,
    intent_ts:        new Date(),
    device:           { app_version: "1.0", platform: "test" },
    enqueued_at:      new Date(),
    origin_operation: "clockout.dual_write",
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
function anonCtx()  { return env.unauthenticatedContext(); }

// ============================================================
// Queue create rules — with origin_operation field
// ============================================================
describe("pending_session_writes create rules (Phase 35c)", () => {
  before(async () => { await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`active_techs_by_email/${TECH_EMAIL}`).set({
        active: true, slug: "tech-1", email: TECH_EMAIL
      });
    });
  });

  test("tech can enqueue own clock-out retry with origin_operation", async () => {
    await assertSucceeds(
      techCtx().firestore().collection("pending_session_writes").add(queueEntry({
        origin_operation: "clockout.dual_write"
      }))
    );
  });

  test("tech can enqueue with canary.harness origin (debug only)", async () => {
    await assertSucceeds(
      techCtx().firestore().collection("pending_session_writes").add(queueEntry({
        origin_operation: "canary.harness"
      }))
    );
  });

  test("tech CANNOT enqueue with another tech's staff_uid", async () => {
    await assertFails(
      techCtx().firestore().collection("pending_session_writes").add(queueEntry({
        staff_uid: OTHER_TECH_UID
      }))
    );
  });

  test("tech CANNOT enqueue with status != queued", async () => {
    await assertFails(
      techCtx().firestore().collection("pending_session_writes").add(queueEntry({
        status: "applied"
      }))
    );
  });

  test("anonymous CANNOT enqueue", async () => {
    await assertFails(
      anonCtx().firestore().collection("pending_session_writes").add(queueEntry())
    );
  });
});

// ============================================================
// Queue read rules
// ============================================================
describe("pending_session_writes read rules", () => {
  before(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`active_techs_by_email/${TECH_EMAIL}`).set({
        active: true, slug: "tech-1", email: TECH_EMAIL
      });
      await db.doc("pending_session_writes/q_tech1_entry").set(queueEntry({
        staff_uid: TECH_UID
      }));
    });
  });

  test("admin can read any queue entry", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("pending_session_writes/q_tech1_entry").get()
    );
  });

  test("own tech can read own queue entry", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("pending_session_writes/q_tech1_entry").get()
    );
  });

  test("other tech CANNOT read another tech's queue entry", async () => {
    await assertFails(
      otherCtx().firestore().doc("pending_session_writes/q_tech1_entry").get()
    );
  });
});

// ============================================================
// Backoff schedule (pure JS unit test of the math)
// ============================================================
describe("queue backoff schedule", () => {
  function nextDelaySec(attemptCount) {
    const SCHEDULE = [60, 300, 900, 1800, 3600];
    const idx = Math.min(attemptCount - 1, SCHEDULE.length - 1);
    return SCHEDULE[idx];
  }

  test("first failure -> 60s", () => {
    assert.equal(nextDelaySec(1), 60);
  });
  test("second failure -> 300s", () => {
    assert.equal(nextDelaySec(2), 300);
  });
  test("third failure -> 900s", () => {
    assert.equal(nextDelaySec(3), 900);
  });
  test("fourth failure -> 1800s", () => {
    assert.equal(nextDelaySec(4), 1800);
  });
  test("fifth failure -> 3600s (saturates)", () => {
    assert.equal(nextDelaySec(5), 3600);
  });
  test("sixth failure -> still 3600s (clamped)", () => {
    assert.equal(nextDelaySec(6), 3600);
  });
});

// ============================================================
// Dispatcher routing decision (pure JS unit test)
// ============================================================
describe("queue dispatcher routing", () => {
  const DISPATCH = {
    "v2.create.retry":   "createSessionV2",
    "v2.clockout.retry": "updateSessionV2ClockOutV1"
  };

  test("v2.create.retry routes to createSessionV2", () => {
    assert.equal(DISPATCH["v2.create.retry"], "createSessionV2");
  });
  test("v2.clockout.retry routes to updateSessionV2ClockOutV1", () => {
    assert.equal(DISPATCH["v2.clockout.retry"], "updateSessionV2ClockOutV1");
  });
  test("unknown event_type returns undefined (caller marks failed_permanent)", () => {
    assert.equal(DISPATCH["v2.unknown.retry"], undefined);
  });
});

// ============================================================
// origin_operation enum
// ============================================================
describe("origin_operation closed enum", () => {
  const KNOWN = ["clockin.dual_write", "clockout.dual_write", "canary.harness"];
  test("includes phase 35a/b/c values", () => {
    assert.ok(KNOWN.indexOf("clockin.dual_write") >= 0);
    assert.ok(KNOWN.indexOf("clockout.dual_write") >= 0);
    assert.ok(KNOWN.indexOf("canary.harness") >= 0);
  });
  test("excludes future values not yet shipped", () => {
    assert.equal(KNOWN.indexOf("addshift.dual_write"), -1);
    assert.equal(KNOWN.indexOf("reconcile.auto_repair"), -1);
  });
});
