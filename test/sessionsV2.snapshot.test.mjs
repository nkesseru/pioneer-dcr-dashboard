// SessionV2 Phase 36a.1 — pure-JS renderer tests.
// Run via: npm run test:snapshot:sessionsV2
//
// These tests do NOT require the Firestore emulator. The renderer is a
// pure function — input goes in, deterministic output comes out.
//
// Coverage areas:
//   - SNAPSHOT_VERSION constant
//   - Minimal valid input renders the expected canonical shape
//   - Reproducibility: same input -> byte-identical output
//   - Normalization: Firestore Timestamp / Date / ISO / number / null
//   - Field allowlist: no arbitrary fields leak through
//   - deriveCompletion math
//   - Defensive inputs (undefined, null, garbage components)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const snap = require("../public/lib/sessionsV2-snapshot.js");

const FIXED_TS = "2026-06-26T17:30:00.000Z";

// ============================================================
// Basics
// ============================================================
describe("snapshot — basics", () => {
  test("SNAPSHOT_VERSION is v1.0.0", () => {
    assert.equal(snap.SNAPSHOT_VERSION, "v1.0.0");
  });

  test("exports renderSessionSnapshot + deriveCompletion", () => {
    assert.equal(typeof snap.renderSessionSnapshot, "function");
    assert.equal(typeof snap.deriveCompletion, "function");
  });

  test("renders a minimal session into expected canonical shape", () => {
    const r = snap.renderSessionSnapshot({
      session_id: "sess_x_2026-06-26_a1",
      source: "tech_clock",
      status: "in_progress",
      service_date: "2026-06-26",
      customer_id: "cedar", customer_slug: "cedar", customer_name: "Cedar LLC",
      staff_uid: "u1", staff_email: "tech@example.com",
      expected_components: ["clock", "photos", "dcr"],
      components: {
        clock:  { status: "complete",
                  started_at:   new Date("2026-06-26T15:00:00Z"),
                  completed_at: new Date("2026-06-26T17:00:00Z") },
        photos: { status: "collecting", count: 3 },
        dcr:    { status: "missing" }
      },
      refs: { dcr_id: null, photo_paths: ["a.jpg", "b.jpg", "c.jpg"] }
    }, { generated_at_iso: FIXED_TS });

    assert.equal(r.snapshot_version, "v1.0.0");
    assert.equal(r.generated_at_iso, FIXED_TS);
    assert.equal(r.session_id, "sess_x_2026-06-26_a1");
    assert.equal(r.session_source, "tech_clock");
    assert.equal(r.session_status, "in_progress");
    assert.equal(r.service_date, "2026-06-26");

    assert.equal(r.work.customer.slug, "cedar");
    assert.equal(r.work.staff.email, "tech@example.com");

    assert.equal(r.components.clock.status, "complete");
    assert.equal(r.components.clock.started_at_iso,   "2026-06-26T15:00:00.000Z");
    assert.equal(r.components.clock.completed_at_iso, "2026-06-26T17:00:00.000Z");

    assert.equal(r.components.photos.count, 3);
    assert.equal(r.components.dcr.status, "missing");

    assert.equal(r.derived.completion_pct, 33); // 1 of 3
    assert.deepEqual(r.derived.blockers.sort(),
      ["dcr:missing", "photos:collecting"]);

    assert.deepEqual(r.refs.photo_paths, ["a.jpg", "b.jpg", "c.jpg"]);
  });
});

// ============================================================
// Reproducibility — the core invariant
// ============================================================
describe("snapshot — reproducibility", () => {
  const baseSession = {
    session_id: "s1",
    source: "tech_clock",
    status: "complete",
    expected_components: ["clock", "photos"],
    components: {
      clock:  { status: "complete" },
      photos: { status: "complete", count: 5 }
    }
  };

  test("same input -> byte-identical output (when generated_at_iso pinned)", () => {
    const a = snap.renderSessionSnapshot(baseSession, { generated_at_iso: FIXED_TS });
    const b = snap.renderSessionSnapshot(baseSession, { generated_at_iso: FIXED_TS });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("only generated_at_iso varies across renders", () => {
    const a = snap.renderSessionSnapshot(baseSession, { generated_at_iso: "A" });
    const b = snap.renderSessionSnapshot(baseSession, { generated_at_iso: "B" });
    a.generated_at_iso = "X";
    b.generated_at_iso = "X";
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("default generated_at_iso is an ISO 8601 string", () => {
    const r = snap.renderSessionSnapshot(baseSession);
    assert.match(r.generated_at_iso,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ============================================================
// Timestamp normalization
// ============================================================
describe("snapshot — timestamp normalization", () => {
  test("Firestore Timestamp (toDate) -> ISO", () => {
    const fakeTs = { toDate: () => new Date("2026-06-26T18:00:00Z") };
    const r = snap.renderSessionSnapshot(
      { session_id: "s", clock_in_at: fakeTs, expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, "2026-06-26T18:00:00.000Z");
  });

  test("native Date -> ISO", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s",
        clock_in_at: new Date("2026-06-26T18:00:00Z"),
        expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, "2026-06-26T18:00:00.000Z");
  });

  test("ISO string passthrough", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", clock_in_at: "2026-06-26T18:00:00.000Z",
        expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, "2026-06-26T18:00:00.000Z");
  });

  test("ms epoch number -> ISO", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", clock_in_at: Date.parse("2026-06-26T18:00:00Z"),
        expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, "2026-06-26T18:00:00.000Z");
  });

  test("null stays null", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", clock_in_at: null, expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, null);
  });

  test("undefined stays null", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, null);
  });

  test("malformed Timestamp object (toDate throws) -> null", () => {
    const bad = { toDate: () => { throw new Error("nope"); } };
    const r = snap.renderSessionSnapshot(
      { session_id: "s", clock_in_at: bad, expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.work.clock_in_at_iso, null);
  });
});

// ============================================================
// Component projection
// ============================================================
describe("snapshot — component projection", () => {
  test("missing components default to status:missing", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: ["photos"] },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.photos.status, "missing");
  });

  test("all 7 components always present in output", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    const keys = Object.keys(r.components).sort();
    assert.deepEqual(keys, [
      "checklist", "clock", "customer_email",
      "dcr", "gps", "payroll", "photos"
    ]);
  });

  test("photos carries count", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [],
        components: { photos: { status: "complete", count: 7 } } },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.photos.count, 7);
  });

  test("checklist carries pct/items_total/items_complete", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [],
        components: { checklist: { status: "collecting",
                                   pct: 60, items_total: 10, items_complete: 6 } } },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.checklist.pct, 60);
    assert.equal(r.components.checklist.items_total, 10);
    assert.equal(r.components.checklist.items_complete, 6);
  });

  test("dcr carries ref + last_event", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [],
        components: { dcr: { status: "complete",
                             ref: "dcr_abc123", last_event: "dcr.submitted" } } },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.dcr.ref, "dcr_abc123");
    assert.equal(r.components.dcr.last_event, "dcr.submitted");
  });
});

// ============================================================
// Field allowlist — adversarial inputs
// ============================================================
describe("snapshot — field allowlist", () => {
  test("does not leak arbitrary top-level fields", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [],
        arbitrary_field: "should not appear",
        mystery_object: { a: 1 },
        secret_token: "tok_xyz" },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.arbitrary_field, undefined);
    assert.equal(r.mystery_object, undefined);
    assert.equal(r.secret_token, undefined);
  });

  test("does not leak arbitrary fields from components", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: ["photos"],
        components: { photos: { status: "complete",
                                count: 5, secret_field: "x" } } },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.photos.secret_field, undefined);
  });

  test("top-level snapshot keys are a closed set", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, [
      "components",
      "derived",
      "generated_at_iso",
      "notes",
      "refs",
      "service_date",
      "session_id",
      "session_source",
      "session_status",
      "snapshot_version",
      "work"
    ]);
  });

  test("work sub-keys are a closed set", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [] },
      { generated_at_iso: FIXED_TS }
    );
    assert.deepEqual(Object.keys(r.work).sort(), [
      "clock_in_at_iso", "clock_out_at_iso", "customer",
      "effective_minutes", "staff"
    ]);
  });
});

// ============================================================
// deriveCompletion math
// ============================================================
describe("deriveCompletion", () => {
  test("0% + sentinel blocker when no expected_components", () => {
    const d = snap.deriveCompletion({});
    assert.equal(d.pct, 0);
    assert.deepEqual(d.blockers, ["no_expected_components"]);
  });

  test("100% when all expected components complete", () => {
    const d = snap.deriveCompletion({
      expected_components: ["clock", "photos"],
      components: { clock: { status: "complete" },
                    photos: { status: "complete" } }
    });
    assert.equal(d.pct, 100);
    assert.deepEqual(d.blockers, []);
  });

  test("50% with one blocker", () => {
    const d = snap.deriveCompletion({
      expected_components: ["clock", "photos"],
      components: { clock: { status: "complete" },
                    photos: { status: "collecting" } }
    });
    assert.equal(d.pct, 50);
    assert.deepEqual(d.blockers, ["photos:collecting"]);
  });

  test("missing component -> status:missing", () => {
    const d = snap.deriveCompletion({
      expected_components: ["dcr"],
      components: {}
    });
    assert.equal(d.pct, 0);
    assert.deepEqual(d.blockers, ["dcr:missing"]);
  });

  test("not_applicable counts toward completion", () => {
    const d = snap.deriveCompletion({
      expected_components: ["clock", "photos"],
      components: { clock: { status: "complete" },
                    photos: { status: "not_applicable" } }
    });
    assert.equal(d.pct, 100);
    assert.deepEqual(d.blockers, []);
  });

  test("rounds to integer", () => {
    // 1 of 3 = 33.33% -> 33
    const d = snap.deriveCompletion({
      expected_components: ["a", "b", "c"],
      components: { a: { status: "complete" },
                    b: { status: "missing" },
                    c: { status: "failed" } }
    });
    assert.equal(d.pct, 33);
  });
});

// ============================================================
// Defensive inputs
// ============================================================
describe("snapshot — defensive inputs", () => {
  test("undefined session -> valid empty-ish snapshot", () => {
    const r = snap.renderSessionSnapshot(undefined, { generated_at_iso: FIXED_TS });
    assert.equal(r.snapshot_version, "v1.0.0");
    assert.equal(r.session_id, null);
    assert.equal(r.derived.completion_pct, 0);
  });

  test("null session -> valid empty-ish snapshot", () => {
    const r = snap.renderSessionSnapshot(null, { generated_at_iso: FIXED_TS });
    assert.equal(r.session_id, null);
  });

  test("non-object components ignored", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [], components: "garbage" },
      { generated_at_iso: FIXED_TS }
    );
    assert.equal(r.components.clock.status, "missing");
  });

  test("non-array refs.photo_paths -> empty array", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: [], refs: { photo_paths: "nope" } },
      { generated_at_iso: FIXED_TS }
    );
    assert.deepEqual(r.refs.photo_paths, []);
  });

  test("non-array expected_components -> empty array + 0%", () => {
    const r = snap.renderSessionSnapshot(
      { session_id: "s", expected_components: "garbage" },
      { generated_at_iso: FIXED_TS }
    );
    assert.deepEqual(r.derived.expected_components, []);
    assert.equal(r.derived.completion_pct, 0);
  });

  test("null options -> defaults applied", () => {
    const r = snap.renderSessionSnapshot({ session_id: "s",
                                            expected_components: [] }, null);
    assert.equal(r.snapshot_version, "v1.0.0");
    assert.match(r.generated_at_iso,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
