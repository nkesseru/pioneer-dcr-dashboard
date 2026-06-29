// SessionV2 Phase 36c — photo recorder pure-JS tests.
// Run via: npm run test:photo:sessionsV2
//
// Covers the pure (no I/O) surface of functions/sessionsV2-record-photo.js:
//   - isPhotoAlreadyRecorded (idempotency predicate)
//   - buildPhotoEntry (entry-shape builder)
//   - nextPhotosStatus (state-machine transition)
//   - buildPhotoTimelineEntry (Timeline entry shape)
//   - classifyRecordPhotoInput (defensive input check)
//
// The async recordSessionPhoto() function takes a real Firestore handle;
// its end-to-end behavior is exercised by Phase 36c.2's canary harness
// (HTTP Cloud Function + admin button). These tests confirm the pure
// logic that drives the transaction.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const photo = require("../functions/sessionsV2-record-photo.js");

// ============================================================
// isPhotoAlreadyRecorded — idempotency by photo_id
// ============================================================
describe("isPhotoAlreadyRecorded", () => {
  const fn = photo.isPhotoAlreadyRecorded;

  test("empty array + any id -> false", () => {
    assert.equal(fn([], "ph_x"), false);
  });

  test("missing array (null) -> false", () => {
    assert.equal(fn(null, "ph_x"), false);
  });

  test("missing array (undefined) -> false", () => {
    assert.equal(fn(undefined, "ph_x"), false);
  });

  test("non-array (string) -> false", () => {
    assert.equal(fn("garbage", "ph_x"), false);
  });

  test("missing photoId -> false (defensive)", () => {
    assert.equal(fn([{ photo_id: "ph_x" }], ""), false);
    assert.equal(fn([{ photo_id: "ph_x" }], null), false);
    assert.equal(fn([{ photo_id: "ph_x" }], undefined), false);
  });

  test("matches single entry", () => {
    assert.equal(fn([{ photo_id: "ph_x" }], "ph_x"), true);
  });

  test("matches in multi-entry array", () => {
    assert.equal(fn([{ photo_id: "ph_a" }, { photo_id: "ph_b" }, { photo_id: "ph_c" }], "ph_b"), true);
  });

  test("no match in multi-entry array", () => {
    assert.equal(fn([{ photo_id: "ph_a" }, { photo_id: "ph_b" }], "ph_x"), false);
  });

  test("ignores malformed entries", () => {
    assert.equal(fn([null, { not_photo_id: "ph_x" }, { photo_id: "ph_x" }], "ph_x"), true);
    assert.equal(fn([null, { not_photo_id: "ph_x" }], "ph_x"), false);
  });
});

// ============================================================
// buildPhotoEntry — entry shape builder
// ============================================================
describe("buildPhotoEntry", () => {
  const fn = photo.buildPhotoEntry;
  const ts = { fake: "ts" }; // opaque — we just want it carried through

  test("null args -> null", () => {
    assert.equal(fn(null, ts), null);
  });

  test("missing photoId -> null", () => {
    assert.equal(fn({ gcsPath: "x" }, ts), null);
  });

  test("missing gcsPath -> null", () => {
    assert.equal(fn({ photoId: "ph_x" }, ts), null);
  });

  test("minimum valid input -> closed-shape entry", () => {
    const e = fn({ photoId: "ph_x", gcsPath: "pioneerdcr/x.jpg" }, ts);
    assert.deepEqual(Object.keys(e).sort(), [
      "gcs_path", "mime_type", "photo_id", "position",
      "size_bytes", "status", "uploaded_at", "uploaded_by_email",
      "uploaded_by_uid"
    ]);
    assert.equal(e.photo_id, "ph_x");
    assert.equal(e.gcs_path, "pioneerdcr/x.jpg");
    assert.equal(e.uploaded_at, ts);
    assert.equal(e.status, "uploaded");
    assert.equal(e.uploaded_by_uid, null);
    assert.equal(e.uploaded_by_email, null);
    assert.equal(e.position, null);
    assert.equal(e.mime_type, null);
    assert.equal(e.size_bytes, null);
  });

  test("full input populates all fields", () => {
    const e = fn({
      photoId:         "ph_x",
      gcsPath:         "pioneerdcr/x.jpg",
      uploadedByUid:   "u1",
      uploadedByEmail: "Tech@Example.com",
      position:        2,
      mimeType:        "image/jpeg",
      sizeBytes:       82341
    }, ts);
    assert.equal(e.uploaded_by_uid, "u1");
    assert.equal(e.uploaded_by_email, "tech@example.com"); // lowercased
    assert.equal(e.position, 2);
    assert.equal(e.mime_type, "image/jpeg");
    assert.equal(e.size_bytes, 82341);
    assert.equal(e.status, "uploaded");
  });

  test("position normalizes: non-integer rounded, <1 dropped", () => {
    const a = fn({ photoId: "x", gcsPath: "y", position: 2.7 }, ts);
    assert.equal(a.position, 3);
    const b = fn({ photoId: "x", gcsPath: "y", position: 0 }, ts);
    assert.equal(b.position, null);
    const c = fn({ photoId: "x", gcsPath: "y", position: -5 }, ts);
    assert.equal(c.position, null);
    const d = fn({ photoId: "x", gcsPath: "y", position: "garbage" }, ts);
    assert.equal(d.position, null);
  });

  test("sizeBytes normalizes: rounded, negative dropped", () => {
    const a = fn({ photoId: "x", gcsPath: "y", sizeBytes: 1024.7 }, ts);
    assert.equal(a.size_bytes, 1025);
    const b = fn({ photoId: "x", gcsPath: "y", sizeBytes: -1 }, ts);
    assert.equal(b.size_bytes, null);
    const c = fn({ photoId: "x", gcsPath: "y", sizeBytes: "garbage" }, ts);
    assert.equal(c.size_bytes, null);
  });

  test("email is lowercased", () => {
    const e = fn({ photoId: "x", gcsPath: "y", uploadedByEmail: "  Tech@Example.COM  " }, ts);
    assert.equal(e.uploaded_by_email, "  tech@example.com  "); // lowercased, NOT trimmed
  });
});

// ============================================================
// nextPhotosStatus — state machine
// ============================================================
describe("nextPhotosStatus", () => {
  const fn = photo.nextPhotosStatus;

  test("missing -> collecting", () => {
    assert.equal(fn("missing"), "collecting");
  });

  test("undefined / null / '' -> collecting (defensive: treat as missing)", () => {
    assert.equal(fn(undefined), "collecting");
    assert.equal(fn(null), "collecting");
    assert.equal(fn(""), "collecting");
  });

  test("collecting -> collecting (no change)", () => {
    assert.equal(fn("collecting"), "collecting");
  });

  test("complete -> complete (unchanged; do NOT regress to collecting)", () => {
    assert.equal(fn("complete"), "complete");
  });

  test("failed -> failed (unchanged)", () => {
    assert.equal(fn("failed"), "failed");
  });

  test("replaced -> replaced (unchanged)", () => {
    assert.equal(fn("replaced"), "replaced");
  });

  test("not_applicable -> not_applicable (unchanged)", () => {
    assert.equal(fn("not_applicable"), "not_applicable");
  });
});

// ============================================================
// buildPhotoTimelineEntry — Timeline entry shape
// ============================================================
describe("buildPhotoTimelineEntry", () => {
  const fn = photo.buildPhotoTimelineEntry;
  const ts = { fake: "ts" };

  test("emits canonical photo.uploaded event", () => {
    const entry = photo.buildPhotoEntry({
      photoId: "ph_x", gcsPath: "y",
      uploadedByUid: "u1", uploadedByEmail: "tech@example.com"
    }, ts);
    const tl = fn({ platform: "web" }, entry, ts);
    assert.equal(tl.event, "photo.uploaded");
    assert.equal(tl.title, "Photo uploaded");
    assert.equal(tl.field_path, "components.photos.items");
    assert.equal(tl.ref, "ph_x");
    assert.equal(tl.to, "ph_x");
    assert.equal(tl.actor.type, "tech");
    assert.equal(tl.actor.uid, "u1");
    assert.equal(tl.actor.email, "tech@example.com");
    assert.equal(tl.client.app_version, "recordSessionPhotoV1");
    assert.equal(tl.client.platform, "web");
    assert.equal(tl.icon, "photo-upload");
  });

  test("missing platform -> client.platform is null", () => {
    const entry = photo.buildPhotoEntry({ photoId: "ph_x", gcsPath: "y" }, ts);
    const tl = fn({}, entry, ts);
    assert.equal(tl.client.platform, null);
  });

  test("missing args object -> client.platform is null", () => {
    const entry = photo.buildPhotoEntry({ photoId: "ph_x", gcsPath: "y" }, ts);
    const tl = fn(null, entry, ts);
    assert.equal(tl.client.platform, null);
  });
});

// ============================================================
// classifyRecordPhotoInput — defensive input check
// ============================================================
describe("classifyRecordPhotoInput", () => {
  const fn = photo.classifyRecordPhotoInput;

  test("null/undefined -> no_args", () => {
    assert.deepEqual(fn(null),      { ok: false, reason: "no_args" });
    assert.deepEqual(fn(undefined), { ok: false, reason: "no_args" });
  });

  test("missing sessionId -> no_session_id", () => {
    assert.deepEqual(fn({ photoId: "x", gcsPath: "y" }),
      { ok: false, reason: "no_session_id" });
  });

  test("invalid sessionId format -> session_id_invalid", () => {
    assert.deepEqual(fn({ sessionId: "garbage", photoId: "x", gcsPath: "y" }),
      { ok: false, reason: "session_id_invalid" });
    assert.deepEqual(fn({ sessionId: "sess_no_attempt", photoId: "x", gcsPath: "y" }),
      { ok: false, reason: "session_id_invalid" });
  });

  test("valid sessionId, missing photoId -> no_photo_id", () => {
    assert.deepEqual(fn({ sessionId: "sess_abc_2026-06-29_a1", gcsPath: "y" }),
      { ok: false, reason: "no_photo_id" });
  });

  test("missing gcsPath -> no_gcs_path", () => {
    assert.deepEqual(fn({ sessionId: "sess_abc_2026-06-29_a1", photoId: "x" }),
      { ok: false, reason: "no_gcs_path" });
  });

  test("all valid -> ok:true", () => {
    assert.deepEqual(fn({
      sessionId: "sess_abc_2026-06-29_a1",
      photoId:   "ph_x",
      gcsPath:   "pioneerdcr/x.jpg"
    }), { ok: true });
  });

  test("admin_manual sessionId format accepted", () => {
    assert.deepEqual(fn({
      sessionId: "sess_manual_uid_2026-06-29_cedar_a1",
      photoId:   "ph_x",
      gcsPath:   "y"
    }), { ok: true });
  });

  test("recovery sessionId format accepted", () => {
    assert.deepEqual(fn({
      sessionId: "sess_recover_sess_abc_2026-06-29_a1_a1",
      photoId:   "ph_x",
      gcsPath:   "y"
    }), { ok: true });
  });

  test("attempt 10+ accepted", () => {
    assert.deepEqual(fn({
      sessionId: "sess_abc_2026-06-29_a10",
      photoId:   "ph_x",
      gcsPath:   "y"
    }), { ok: true });
  });
});

// ============================================================
// SESSIONSV2_ID_RE — exported for caller pre-validation
// ============================================================
describe("SESSIONSV2_ID_RE — exported regex parity", () => {
  test("matches tech_clock form", () => {
    assert.ok(photo.SESSIONSV2_ID_RE.test("sess_abc_2026-06-29_a1"));
  });
  test("matches manual form", () => {
    assert.ok(photo.SESSIONSV2_ID_RE.test("sess_manual_uid_2026-06-29_cedar_a1"));
  });
  test("rejects garbage", () => {
    assert.equal(photo.SESSIONSV2_ID_RE.test("garbage"), false);
    assert.equal(photo.SESSIONSV2_ID_RE.test(""), false);
  });
});

// ============================================================
// Composition — confirm pure helpers compose into the write shape
// the transaction will apply.
// ============================================================
describe("composition — full write shape (no I/O)", () => {
  test("first photo on a missing-component session produces expected update", () => {
    const args = {
      photoId:         "ph_001",
      gcsPath:         "pioneerdcr/sess_abc/2026/01.jpg",
      uploadedByUid:   "u1",
      uploadedByEmail: "tech@example.com",
      position:        1,
      mimeType:        "image/jpeg",
      sizeBytes:       82341,
      platform:        "web"
    };
    const ts    = { fake: "ts_now" };
    const entry = photo.buildPhotoEntry(args, ts);
    const tl    = photo.buildPhotoTimelineEntry(args, entry, ts);
    const nextStatus = photo.nextPhotosStatus("missing");

    // Verify the composed pieces match what the transaction will write.
    assert.equal(nextStatus, "collecting");
    assert.equal(entry.photo_id, "ph_001");
    assert.equal(entry.status, "uploaded");
    assert.equal(tl.event, "photo.uploaded");
    assert.equal(tl.ref, entry.photo_id);
  });

  test("second photo on a collecting-component session keeps collecting", () => {
    const next = photo.nextPhotosStatus("collecting");
    assert.equal(next, "collecting");
  });
});
