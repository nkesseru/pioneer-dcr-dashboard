// SessionV2 Firestore rules — Phase 33 emulator test suite.
// Run via: npm run test:rules:sessionsV2
// Requires the Firebase Firestore emulator on port 8080 (auto-started by emulators:exec).

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from "@firebase/rules-unit-testing";

const PROJECT_ID  = "demo-pioneer-test";
const ADMIN_EMAIL = "nick@pioneercomclean.com";        // hardcoded admin allow-list
const TECH_EMAIL  = "tech1@example.com";
const TECH_UID    = "tech_uid_1";
const OTHER_TECH_EMAIL = "tech2@example.com";
const OTHER_TECH_UID   = "tech_uid_2";

let env;

// Minimal valid session base — tests override status, fields as needed.
function baseSessionDoc(overrides = {}) {
  return {
    session_id:        "sess_test_assignment_2026-06-25",
    schema_version:    2,
    source:            "tech_clock",
    assignment_id:     "assignment_xyz",
    staff_uid:         TECH_UID,
    staff_email:       TECH_EMAIL,
    customer_id:       "cedar-llc",
    customer_slug:     "cedar-llc",
    customer_name:     "Cedar LLC",
    service_date:      "2026-06-25",
    status:            "assigned",
    status_changed_at: new Date(),
    status_version:    1,
    admin_removed:     false,
    created_at:        new Date(),
    created_by:        { type: "tech", uid: TECH_UID, email: TECH_EMAIL, name: "Tech 1" },
    updated_at:        new Date(),
    components: {
      clock_in_done: false, clock_out_done: false,
      photos_done: false, photos_count: 0,
      checklist_done: false, checklist_pct: 0,
      dcr_done: false, dcr_status: null,
      issues_logged_count: 0, customer_email_sent: false
    },
    refs: {
      photo_paths: [], dcr_id: null, dcr_submission_id: null,
      time_punch_ids: [], pending_queue_ids: [], email_message_ids: []
    },
    completion_pct: 0,
    blockers:       [],
    audit_log:      [],
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

  // Seed admin + active-tech index docs under security-rules-disabled context.
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

after(async () => {
  if (env) await env.cleanup();
});

function adminCtx()  { return env.authenticatedContext("admin_uid", { email: ADMIN_EMAIL }); }
function techCtx()   { return env.authenticatedContext(TECH_UID,   { email: TECH_EMAIL  }); }
function otherCtx()  { return env.authenticatedContext(OTHER_TECH_UID, { email: OTHER_TECH_EMAIL }); }
function anonCtx()   { return env.unauthenticatedContext(); }

async function seedSession(doc) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`sessionsV2/${doc.session_id}`).set(doc);
  });
}

async function clearSessions() {
  await env.clearFirestore();
  // Re-seed admin/tech index after clear.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`active_techs_by_email/${TECH_EMAIL}`).set({
      active: true, slug: "tech-1", email: TECH_EMAIL
    });
    await db.doc(`active_techs_by_email/${OTHER_TECH_EMAIL}`).set({
      active: true, slug: "tech-2", email: OTHER_TECH_EMAIL
    });
  });
}

// ============================================================
// sessionsV2/{sessionId} — READ
// ============================================================
describe("sessionsV2 READ", () => {
  before(async () => {
    await clearSessions();
    await seedSession(baseSessionDoc());
  });

  test("admin can read any session", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").get()
    );
  });

  test("tech can read own session", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").get()
    );
  });

  test("other tech CANNOT read someone else's session", async () => {
    await assertFails(
      otherCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").get()
    );
  });

  test("anonymous CANNOT read", async () => {
    await assertFails(
      anonCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").get()
    );
  });
});

// ============================================================
// sessionsV2/{sessionId} — CREATE
// ============================================================
describe("sessionsV2 CREATE", () => {
  before(async () => { await clearSessions(); });

  test("tech can create own session with status=assigned", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_c1_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c1_2026-06-25"
      }))
    );
  });

  test("tech can create own session with status=ready", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_c2_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c2_2026-06-25", status: "ready"
      }))
    );
  });

  test("tech CANNOT create session for another staff_uid", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c3_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c3_2026-06-25",
        staff_uid:  OTHER_TECH_UID
      }))
    );
  });

  test("tech CANNOT create at status=in_progress (must start at assigned/ready)", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c4_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c4_2026-06-25", status: "in_progress"
      }))
    );
  });

  test("tech CANNOT create at status=complete", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c5_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c5_2026-06-25", status: "complete"
      }))
    );
  });

  test("tech CANNOT create with payroll.* field", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c6_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c6_2026-06-25",
        payroll:    { payroll_state: "approved_for_payroll", work_minutes: 60 }
      }))
    );
  });

  test("tech CANNOT create with effective_clock_in field", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c7_2026-06-25").set(baseSessionDoc({
        session_id:         "sess_c7_2026-06-25",
        effective_clock_in: new Date()
      }))
    );
  });

  test("tech CANNOT create with effective_clock_out field", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c8_2026-06-25").set(baseSessionDoc({
        session_id:          "sess_c8_2026-06-25",
        effective_clock_out: new Date()
      }))
    );
  });

  test("tech CANNOT create with effective_minutes field", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c9_2026-06-25").set(baseSessionDoc({
        session_id:       "sess_c9_2026-06-25",
        effective_minutes: 60
      }))
    );
  });

  test("tech CANNOT create with supersede chain set", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c10_2026-06-25").set(baseSessionDoc({
        session_id:             "sess_c10_2026-06-25",
        supersedes_session_ids: ["sess_old"]
      }))
    );
  });

  test("tech CANNOT create with admin_removed=true", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c11_2026-06-25").set(baseSessionDoc({
        session_id:    "sess_c11_2026-06-25",
        admin_removed: true
      }))
    );
  });

  test("tech CANNOT create with schema_version=1", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c12_2026-06-25").set(baseSessionDoc({
        session_id:     "sess_c12_2026-06-25",
        schema_version: 1
      }))
    );
  });

  test("tech CANNOT create with unknown source", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_c13_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c13_2026-06-25",
        source:     "rogue_source"
      }))
    );
  });

  test("anon CANNOT create", async () => {
    await assertFails(
      anonCtx().firestore().doc("sessionsV2/sess_c14_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c14_2026-06-25"
      }))
    );
  });

  test("admin can create on tech's behalf", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_c15_2026-06-25").set(baseSessionDoc({
        session_id: "sess_c15_2026-06-25",
        staff_uid:  TECH_UID,
        source:     "admin_manual"
      }))
    );
  });
});

// ============================================================
// sessionsV2/{sessionId} — UPDATE
// ============================================================
describe("sessionsV2 UPDATE", () => {
  before(async () => {
    await clearSessions();
    await seedSession(baseSessionDoc({
      session_id: "sess_u_active",
      status:     "in_progress"
    }));
    await seedSession(baseSessionDoc({
      session_id: "sess_u_locked",
      status:     "locked"
    }));
    await seedSession(baseSessionDoc({
      session_id:    "sess_u_archived",
      status:        "archived",
      admin_removed: true
    }));
    await seedSession(baseSessionDoc({
      session_id: "sess_u_assigned",
      status:     "assigned"
    }));
    await seedSession(baseSessionDoc({
      session_id: "sess_u_ready",
      status:     "ready"
    }));
  });

  test("tech can flip components.photos_done on own active session", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        "components.photos_done":  true,
        "components.photos_count": 3,
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT write payroll.* fields", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        "payroll.payroll_state": "approved_for_payroll",
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT write effective_clock_in", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        effective_clock_in: new Date(),
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT write supersedes_session_ids", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        supersedes_session_ids: ["old_id"],
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT set admin_removed=true", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        admin_removed: true,
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT mutate staff_uid", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        staff_uid:  OTHER_TECH_UID,
        updated_at: new Date()
      })
    );
  });

  test("tech CAN transition assigned -> ready", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_u_assigned").update({
        status:            "ready",
        status_changed_at: new Date(),
        status_version:    2,
        updated_at:        new Date()
      })
    );
  });

  test("tech CAN transition ready -> in_progress", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("sessionsV2/sess_u_ready").update({
        status:            "in_progress",
        status_changed_at: new Date(),
        status_version:    2,
        clock_in_at:       new Date(),
        updated_at:        new Date()
      })
    );
  });

  test("tech CANNOT skip to complete", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        status:            "complete",
        status_changed_at: new Date(),
        status_version:    2,
        updated_at:        new Date()
      })
    );
  });

  test("tech CANNOT skip to payroll_approved", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_active").update({
        status:            "payroll_approved",
        status_changed_at: new Date(),
        status_version:    2,
        updated_at:        new Date()
      })
    );
  });

  test("tech CANNOT edit a locked session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_locked").update({
        "components.photos_done": true,
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT edit an archived session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_u_archived").update({
        "components.photos_done": true,
        updated_at: new Date()
      })
    );
  });

  test("other tech CANNOT edit someone else's session", async () => {
    await assertFails(
      otherCtx().firestore().doc("sessionsV2/sess_u_active").update({
        "components.photos_done": true,
        updated_at: new Date()
      })
    );
  });

  test("admin CAN write payroll.* fields", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_u_active").update({
        "payroll.payroll_state": "approved_for_payroll",
        "payroll.work_minutes":  120,
        updated_at: new Date()
      })
    );
  });

  test("admin CAN write effective_clock_in", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_u_active").update({
        effective_clock_in: new Date(),
        updated_at:         new Date()
      })
    );
  });

  test("admin CAN transition status to complete", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("sessionsV2/sess_u_active").update({
        status:            "complete",
        status_changed_at: new Date(),
        status_version:    3,
        updated_at:        new Date()
      })
    );
  });
});

// ============================================================
// sessionsV2/{sessionId} — DELETE (nobody, ever)
// ============================================================
describe("sessionsV2 DELETE", () => {
  before(async () => {
    await clearSessions();
    await seedSession(baseSessionDoc());
  });

  test("admin CANNOT delete (archive only)", async () => {
    await assertFails(
      adminCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").delete()
    );
  });

  test("tech CANNOT delete own session", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2/sess_test_assignment_2026-06-25").delete()
    );
  });
});

// ============================================================
// sessionsV2_open mirror — read-only for everyone
// ============================================================
describe("sessionsV2_open mirror", () => {
  before(async () => {
    await clearSessions();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("sessionsV2_open/sess_open_1").set({
        session_id: "sess_open_1", staff_uid: TECH_UID, status: "in_progress", updated_at: new Date()
      });
    });
  });

  test("admin can read", async () => {
    await assertSucceeds(adminCtx().firestore().doc("sessionsV2_open/sess_open_1").get());
  });

  test("own tech can read", async () => {
    await assertSucceeds(techCtx().firestore().doc("sessionsV2_open/sess_open_1").get());
  });

  test("other tech CANNOT read", async () => {
    await assertFails(otherCtx().firestore().doc("sessionsV2_open/sess_open_1").get());
  });

  test("admin CANNOT write (CF trigger only)", async () => {
    await assertFails(
      adminCtx().firestore().doc("sessionsV2_open/sess_open_1").set({ status: "complete" })
    );
  });

  test("tech CANNOT write", async () => {
    await assertFails(
      techCtx().firestore().doc("sessionsV2_open/sess_open_1").set({ status: "complete" })
    );
  });
});

// ============================================================
// sessionsV2_active_by_tech — read own; no writes
// ============================================================
describe("sessionsV2_active_by_tech pointer", () => {
  before(async () => {
    await clearSessions();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).set({
        session_id: "sess_open_1", updated_at: new Date()
      });
    });
  });

  test("admin can read any", async () => {
    await assertSucceeds(adminCtx().firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).get());
  });

  test("own tech can read own", async () => {
    await assertSucceeds(techCtx().firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).get());
  });

  test("other tech CANNOT read another tech's pointer", async () => {
    await assertFails(otherCtx().firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).get());
  });

  test("admin CANNOT write", async () => {
    await assertFails(
      adminCtx().firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).set({ session_id: "x" })
    );
  });

  test("tech CANNOT write", async () => {
    await assertFails(
      techCtx().firestore().doc(`sessionsV2_active_by_tech/${TECH_UID}`).set({ session_id: "x" })
    );
  });
});

// ============================================================
// session_audit_log overflow — admin-read; CF-write only
// ============================================================
describe("session_audit_log overflow", () => {
  before(async () => {
    await clearSessions();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("session_audit_log/sess_x/entries/entry_1").set({
        ts: new Date(), actor: { type: "admin" }, event: "admin.correction"
      });
    });
  });

  test("admin can read entries", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("session_audit_log/sess_x/entries/entry_1").get()
    );
  });

  test("tech CANNOT read entries", async () => {
    await assertFails(
      techCtx().firestore().doc("session_audit_log/sess_x/entries/entry_1").get()
    );
  });

  test("admin CANNOT write (CF only)", async () => {
    await assertFails(
      adminCtx().firestore().doc("session_audit_log/sess_x/entries/entry_2").set({
        ts: new Date(), event: "x"
      })
    );
  });

  test("tech CANNOT write", async () => {
    await assertFails(
      techCtx().firestore().doc("session_audit_log/sess_x/entries/entry_3").set({
        ts: new Date(), event: "x"
      })
    );
  });
});

// ============================================================
// pending_session_writes — offline queue
// ============================================================
describe("pending_session_writes offline queue", () => {
  before(async () => { await clearSessions(); });

  test("tech can create own queued event", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("pending_session_writes/q1").set({
        queue_id:    "q1",
        session_id:  "sess_x",
        event_type:  "clock.in",
        event_id:    "evt_hash_1",
        intent_ts:   new Date(),
        payload:     { foo: "bar" },
        status:      "queued",
        attempt_count: 0,
        next_attempt_at: new Date(),
        device:      { id: "dev_1", app_version: "1.0" },
        staff_uid:   TECH_UID,
        enqueued_at: new Date()
      })
    );
  });

  test("tech CANNOT create queue entry for another staff_uid", async () => {
    await assertFails(
      techCtx().firestore().doc("pending_session_writes/q2").set({
        queue_id:    "q2",
        session_id:  "sess_x",
        event_type:  "clock.in",
        event_id:    "evt_hash_2",
        intent_ts:   new Date(),
        payload:     {},
        status:      "queued",
        attempt_count: 0,
        next_attempt_at: new Date(),
        staff_uid:   OTHER_TECH_UID,
        enqueued_at: new Date()
      })
    );
  });

  test("tech CANNOT create with non-queued initial status", async () => {
    await assertFails(
      techCtx().firestore().doc("pending_session_writes/q3").set({
        queue_id:    "q3",
        session_id:  "sess_x",
        event_type:  "clock.in",
        event_id:    "evt_hash_3",
        intent_ts:   new Date(),
        payload:     {},
        status:      "applied",
        attempt_count: 0,
        next_attempt_at: new Date(),
        staff_uid:   TECH_UID,
        enqueued_at: new Date()
      })
    );
  });

  test("tech can update status/attempt_count on own queue entry", async () => {
    await assertSucceeds(
      techCtx().firestore().doc("pending_session_writes/q1").update({
        status:          "uploading",
        attempt_count:   1,
        next_attempt_at: new Date(),
        updated_at:      new Date()
      })
    );
  });

  test("tech CANNOT mutate payload after create", async () => {
    await assertFails(
      techCtx().firestore().doc("pending_session_writes/q1").update({
        payload:    { tampered: true },
        updated_at: new Date()
      })
    );
  });

  test("tech CANNOT change staff_uid on own queue entry", async () => {
    await assertFails(
      techCtx().firestore().doc("pending_session_writes/q1").update({
        staff_uid:  OTHER_TECH_UID,
        updated_at: new Date()
      })
    );
  });

  test("tech can delete own queue entry", async () => {
    // First create a fresh one to delete (q1 will be deleted in this test)
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("pending_session_writes/q_del").set({
        queue_id: "q_del", session_id: "x", event_type: "x", event_id: "x",
        status: "queued", staff_uid: TECH_UID, intent_ts: new Date(), payload: {},
        attempt_count: 0, next_attempt_at: new Date(), enqueued_at: new Date()
      });
    });
    await assertSucceeds(
      techCtx().firestore().doc("pending_session_writes/q_del").delete()
    );
  });

  test("other tech CANNOT read another tech's queue entry", async () => {
    await assertFails(
      otherCtx().firestore().doc("pending_session_writes/q1").get()
    );
  });

  test("admin can read any queue entry", async () => {
    await assertSucceeds(
      adminCtx().firestore().doc("pending_session_writes/q1").get()
    );
  });

  test("admin can delete any queue entry", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("pending_session_writes/q_admin_del").set({
        queue_id: "q_admin_del", session_id: "x", event_type: "x", event_id: "x",
        status: "queued", staff_uid: TECH_UID, intent_ts: new Date(), payload: {},
        attempt_count: 0, next_attempt_at: new Date(), enqueued_at: new Date()
      });
    });
    await assertSucceeds(
      adminCtx().firestore().doc("pending_session_writes/q_admin_del").delete()
    );
  });
});
