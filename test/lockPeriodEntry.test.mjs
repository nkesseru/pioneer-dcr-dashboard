// Lock Period entry construction — regression tests for the
// FieldValue.serverTimestamp()-in-array Firestore rejection.
//
// Background: `lockPayrollPeriodV1` and `unlockPayrollPeriodV1`
// stamp per-invocation entries into a `lock_history` array via
// `arrayUnion`. Firestore rejects any `FieldValue.serverTimestamp()`
// sentinel inside an array element. The fix is to use
// `Timestamp.now()` for the per-entry `at` field only; top-level
// `locked_at` / `updated_at` remain on `serverTimestamp()` where
// allowed.
//
// This file mirrors the prod source EXACTLY. Any divergence is a
// bug — diff the buildLockEntry / buildUnlockEntry helpers below
// against functions/index.js when either changes.
//
// Run: node --test test/lockPeriodEntry.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
if (!admin.apps.length) {
  // No credentials needed — we're only using the Timestamp + FieldValue
  // constructors, not authenticating against a real Firestore.
  admin.initializeApp({ projectId: "test" });
}
const { Timestamp, FieldValue } = admin.firestore;

// ============================================================
// MIRROR of functions/index.js :: lockPayrollPeriodV1 lockEntry
// ============================================================
function buildLockEntry(actor, counted, approved, autoFinalizedAckIds) {
  return {
    action:                  "locked",
    at:                      Timestamp.now(),
    by:                      actor,
    session_count:           counted.length,
    approved_count:          approved.length,
    auto_finalized_count:    autoFinalizedAckIds.length
  };
}

// ============================================================
// MIRROR of functions/index.js :: unlockPayrollPeriodV1 unlockEntry
// ============================================================
function buildUnlockEntry(actor, ackIds) {
  return {
    action:               "unlocked",
    at:                   Timestamp.now(),
    by:                   actor,
    reverted_ack_count:   ackIds.length
  };
}

// ============================================================
// Detector — walks a value tree and returns true if any leaf is a
// serverTimestamp() sentinel. This mirrors the check Firestore
// performs before persistence. If any array element contains such
// a sentinel, the write is rejected.
// ============================================================
function containsServerTimestampSentinel(value) {
  if (value == null) return false;
  if (typeof value !== "object") return false;
  // FieldValue instances have a constructor whose name starts with the
  // sentinel type. In firebase-admin, `serverTimestamp()` returns an
  // instance of `ServerTimestampTransform` (Node SDK) whose _methodName
  // === "serverTimestamp". Timestamp instances do NOT match.
  if (value instanceof Timestamp) return false;
  const proto = Object.getPrototypeOf(value);
  const ctorName = proto && proto.constructor && proto.constructor.name;
  if (ctorName === "ServerTimestampTransform") return true;
  if (typeof value._methodName === "string" &&
      value._methodName.toLowerCase().indexOf("servertimestamp") >= 0) return true;
  if (Array.isArray(value)) {
    return value.some(v => containsServerTimestampSentinel(v));
  }
  for (const k of Object.keys(value)) {
    if (containsServerTimestampSentinel(value[k])) return true;
  }
  return false;
}

const SAMPLE_ACTOR = {
  uid: "admin_uid_abc",
  displayName: "kirby@pioneercomclean.com",
  email: "kirby@pioneercomclean.com"
};

// ============================================================
// Successful Lock Period — happy path
// ============================================================
describe("Lock Period entry — Firestore-safe shape (regression)", () => {
  test("lockEntry.at is a real Timestamp, NOT a serverTimestamp sentinel", () => {
    const entry = buildLockEntry(SAMPLE_ACTOR, [1, 2, 3], [1, 2], []);
    assert.ok(entry.at instanceof Timestamp,
      "at must be a Timestamp instance");
    assert.equal(containsServerTimestampSentinel(entry), false,
      "lockEntry must NOT contain any serverTimestamp() sentinel — Firestore " +
      "rejects that inside arrayUnion elements");
  });

  test("unlockEntry.at is a real Timestamp, NOT a serverTimestamp sentinel", () => {
    const entry = buildUnlockEntry(SAMPLE_ACTOR, ["ack1", "ack2"]);
    assert.ok(entry.at instanceof Timestamp);
    assert.equal(containsServerTimestampSentinel(entry), false);
  });

  test("regression guard: attempting the bad pattern is caught", () => {
    // Confirm the detector actually fires on the bad shape.
    const badEntry = {
      action: "locked",
      at:     FieldValue.serverTimestamp(),
      by:     SAMPLE_ACTOR
    };
    assert.equal(containsServerTimestampSentinel(badEntry), true,
      "detector must catch the bad shape that Firestore would reject");
  });

  test("nested map inside array element is also caught", () => {
    const badNested = {
      action: "locked",
      by:     { name: "x", ts: FieldValue.serverTimestamp() }
    };
    assert.equal(containsServerTimestampSentinel(badNested), true);
  });
});

// ============================================================
// Audit history append semantics
// ============================================================
describe("lock_history append semantics — audit trail integrity", () => {
  test("each entry has full audit context (action, at, by)", () => {
    const entry = buildLockEntry(SAMPLE_ACTOR, [1], [1], []);
    assert.equal(entry.action, "locked");
    assert.ok(entry.at instanceof Timestamp);
    assert.deepEqual(entry.by, SAMPLE_ACTOR);
  });

  test("unlock entry has full audit context (action, at, by, reverted_ack_count)", () => {
    const entry = buildUnlockEntry(SAMPLE_ACTOR, ["a", "b", "c"]);
    assert.equal(entry.action, "unlocked");
    assert.equal(entry.reverted_ack_count, 3);
    assert.ok(entry.at instanceof Timestamp);
    assert.deepEqual(entry.by, SAMPLE_ACTOR);
  });

  test("lock entry captures the counted / approved / auto-finalized snapshot", () => {
    const entry = buildLockEntry(SAMPLE_ACTOR,
      [1, 2, 3, 4, 5], [1, 2, 3], ["ack1", "ack2"]);
    assert.equal(entry.session_count, 5);
    assert.equal(entry.approved_count, 3);
    assert.equal(entry.auto_finalized_count, 2);
  });
});

// ============================================================
// Timestamp field — ordering + monotonicity
// ============================================================
describe("Timestamp field — real time values, orderable", () => {
  test("at is a Timestamp with toMillis() returning a positive number", () => {
    const entry = buildLockEntry(SAMPLE_ACTOR, [1], [1], []);
    const ms = entry.at.toMillis();
    assert.ok(typeof ms === "number");
    assert.ok(ms > 0);
    assert.ok(ms < Date.now() + 60000, "timestamp within one minute of now");
    assert.ok(ms > Date.now() - 60000, "timestamp within one minute of now");
  });

  test("Timestamp.toDate() returns a real Date object", () => {
    const entry = buildLockEntry(SAMPLE_ACTOR, [1], [1], []);
    const d = entry.at.toDate();
    assert.ok(d instanceof Date);
    assert.ok(!isNaN(d.getTime()));
  });
});

// ============================================================
// Multiple history entries — ordering preserved
// ============================================================
describe("Multiple history entries — ordering + independence", () => {
  test("two sequential lock entries produce distinct Timestamps", async () => {
    const e1 = buildLockEntry(SAMPLE_ACTOR, [1], [1], []);
    // Small sleep to guarantee Timestamp.now() advances at least 1ms.
    await new Promise(r => setTimeout(r, 5));
    const e2 = buildLockEntry(SAMPLE_ACTOR, [2], [2], []);
    assert.ok(e2.at.toMillis() >= e1.at.toMillis(),
      "second entry timestamp must not go backward");
    assert.notEqual(e1.at.toMillis(), e2.at.toMillis(),
      "distinct calls should produce distinct timestamps");
  });

  test("lock followed by unlock followed by lock — three entries, three timestamps", async () => {
    const entries = [];
    entries.push(buildLockEntry(SAMPLE_ACTOR, [1], [1], []));
    await new Promise(r => setTimeout(r, 5));
    entries.push(buildUnlockEntry(SAMPLE_ACTOR, ["ack1"]));
    await new Promise(r => setTimeout(r, 5));
    entries.push(buildLockEntry(SAMPLE_ACTOR, [2], [2], []));
    assert.equal(entries.length, 3);
    assert.equal(entries[0].action, "locked");
    assert.equal(entries[1].action, "unlocked");
    assert.equal(entries[2].action, "locked");
    // Timestamps monotonic non-decreasing
    assert.ok(entries[1].at.toMillis() >= entries[0].at.toMillis());
    assert.ok(entries[2].at.toMillis() >= entries[1].at.toMillis());
  });

  test("many entries can be arrayUnion'd — none contain the bad sentinel", () => {
    // Simulate 10 lock/unlock cycles. If ANY entry contains a
    // FieldValue.serverTimestamp(), Firestore will reject the batch.
    const history = [];
    for (let i = 0; i < 10; i++) {
      history.push(buildLockEntry(SAMPLE_ACTOR, [i], [i], []));
      history.push(buildUnlockEntry(SAMPLE_ACTOR, ["ack" + i]));
    }
    assert.equal(history.length, 20);
    history.forEach((entry, idx) => {
      assert.equal(containsServerTimestampSentinel(entry), false,
        "entry #" + idx + " must NOT contain a serverTimestamp() sentinel");
    });
  });
});

// ============================================================
// Firestore-write shape sanity — top-level fields separate from arrays
// ============================================================
describe("Firestore write shape — top-level vs array-element rules", () => {
  test("top-level locked_at can safely use serverTimestamp() (allowed)", () => {
    // Simulates the periodPayload shape from lockPayrollPeriodV1.
    // Top-level FieldValue is fine; array-element is not.
    const periodPayload = {
      lock_status: "locked",
      locked_at:   FieldValue.serverTimestamp(),  // TOP-LEVEL — allowed
      updated_at:  FieldValue.serverTimestamp(),  // TOP-LEVEL — allowed
      lock_history: FieldValue.arrayUnion(
        buildLockEntry(SAMPLE_ACTOR, [1], [1], [])
      )
    };
    // The lock_history arrayUnion argument (the entry inside) must be clean:
    const entryInArg = buildLockEntry(SAMPLE_ACTOR, [1], [1], []);
    assert.equal(containsServerTimestampSentinel(entryInArg), false);
    // And the top-level sentinels are the expected sentinels (not real Timestamps):
    assert.notEqual(periodPayload.locked_at.constructor.name, "Timestamp");
  });
});
