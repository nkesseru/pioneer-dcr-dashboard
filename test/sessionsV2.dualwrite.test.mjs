// SessionV2 Phase 35a — dual-write Firestore rules + client helper unit tests.
// Run via: npm run test:dualwrite:sessionsV2

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
    await db.doc("pioneer_config/session_v2_dual_write").set({
      enabled: true,
      allowed_emails: [ADMIN_EMAIL]
    });
  });
});

after(async () => { if (env) await env.cleanup(); });

function adminCtx() { return env.authenticatedContext("admin_uid", { email: ADMIN_EMAIL }); }
function techCtx()  { return env.authenticatedContext(TECH_UID,    { email: TECH_EMAIL  }); }
function anonCtx()  { return env.unauthenticatedContext(); }

// ============================================================
// pioneer_config/session_v2_dual_write — read access
// ============================================================
describe("pioneer_config/session_v2_dual_write rules", () => {
  test("admin can read the config doc", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("pioneer_config/session_v2_dual_write").get()
    );
  });

  test("active tech can read the config doc (allowlist check)", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("pioneer_config/session_v2_dual_write").get()
    );
  });

  test("anonymous CANNOT read the config doc", async () => {
    await assertFails(
      anonCtx().firestore().doc("pioneer_config/session_v2_dual_write").get()
    );
  });

  test("admin can write the config doc", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("pioneer_config/session_v2_dual_write").set({
        enabled: false,
        allowed_emails: []
      })
    );
  });

  test("tech CANNOT write the config doc", async () => {
    await assertFails(
      techCtx().firestore().doc("pioneer_config/session_v2_dual_write").set({
        enabled: true,
        allowed_emails: [TECH_EMAIL]
      })
    );
  });

  test("other pioneer_config docs still admin-only read (no rule loosening leak)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("pioneer_config/other_secret").set({ secret: true });
    });
    await assertSucceeds(
      adminCtx().firestore().doc("pioneer_config/other_secret").get()
    );
    await assertFails(
      techCtx().firestore().doc("pioneer_config/other_secret").get()
    );
  });
});

// ============================================================
// Deterministic V2 session_id derivation (pure logic test)
// ============================================================
describe("deriveSessionV2Id format", () => {
  function deriveSessionV2Id(assignmentId, serviceDate, attempt) {
    if (!assignmentId || !serviceDate) return null;
    const att = (typeof attempt === "number" && attempt >= 1) ? attempt : 1;
    return "sess_" + assignmentId + "_" + serviceDate + "_a" + att;
  }

  test("derives expected format for tech_clock", () => {
    const id = deriveSessionV2Id("aJ8kf3pQ", "2026-06-26", 1);
    assert.equal(id, "sess_aJ8kf3pQ_2026-06-26_a1");
  });

  test("defaults attempt to 1 when omitted", () => {
    const id = deriveSessionV2Id("xyz", "2026-06-26");
    assert.equal(id, "sess_xyz_2026-06-26_a1");
  });

  test("returns null for missing assignment_id", () => {
    assert.equal(deriveSessionV2Id(null, "2026-06-26", 1), null);
  });

  test("returns null for missing service_date", () => {
    assert.equal(deriveSessionV2Id("xyz", null, 1), null);
  });

  test("respects explicit attempt > 1", () => {
    const id = deriveSessionV2Id("xyz", "2026-06-26", 3);
    assert.equal(id, "sess_xyz_2026-06-26_a3");
  });
});

// ============================================================
// V2 doc create accepts v1_session_id back-pointer (Phase 35a payload)
// ============================================================
describe("sessionsV2 accepts v1_session_id field at create", () => {
  before(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`active_techs_by_email/${TECH_EMAIL}`).set({
        active: true, slug: "tech-1", email: TECH_EMAIL
      });
    });
  });

  test("admin can create V2 doc with v1_session_id field", async () => {
    function comp(s) {
      return { status: s, started_at: null, last_event_at: null, completed_at: null,
               last_event: null, error: null, count: null, pct: null, ref: null };
    }
    const doc = {
      session_id:        "sess_asg_test_2026-06-26_a1",
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
      expected_components: ["clock", "payroll"],
      components: {
        clock:          comp("missing"),
        gps:            comp("not_applicable"),
        photos:         comp("not_applicable"),
        checklist:      comp("not_applicable"),
        dcr:            comp("not_applicable"),
        customer_email: comp("not_applicable"),
        payroll:        comp("missing")
      },
      status:            "assigned",
      status_changed_at: new Date(),
      status_version:    1,
      admin_removed:     false,
      v1_session_id:     "v1RandomId_xyz",
      created_at:        new Date(),
      created_by:        { type: "admin", uid: "admin_uid", email: ADMIN_EMAIL, name: "Admin" },
      updated_at:        new Date()
    };
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_asg_test_2026-06-26_a1").set(doc)
    );
  });
});
