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

// ============================================================
// Phase 36c.3a — canRecordSessionPhoto auth decision
// ============================================================
//
// Authorization predicate for the recordSessionPhotoV1 endpoint.
// Decision:
//   - admin                               → allowed (scope: admin)
//   - cleaning_tech AND own session       → allowed (scope: tech_own)
//   - everything else                     → denied with reason
//
// Endpoint reads the session (one extra Firestore read) and passes
// sessionData here. Pure predicate; never throws; defensive on shape.
// ============================================================
describe("canRecordSessionPhoto — auth decision (Phase 36c.3a)", () => {
  const fn = photo.canRecordSessionPhoto;

  // ----- admin: always allowed -----

  test("admin allowed regardless of session", () => {
    const d = fn({ role: "admin", uid: "admin1" }, { staff_uid: "tech_other" });
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "admin");
  });

  test("admin allowed even when session data is null", () => {
    const d = fn({ role: "admin", uid: "admin1" }, null);
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "admin");
  });

  test("admin allowed even when session staff_uid missing", () => {
    const d = fn({ role: "admin", uid: "admin1" }, {});
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "admin");
  });

  // ----- tech-own: allowed -----

  test("cleaning_tech allowed when own session", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, { staff_uid: "tech1" });
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "tech_own");
  });

  test("staff_uid string comparison is trimmed", () => {
    const d = fn({ role: "cleaning_tech", uid: "  tech1  " }, { staff_uid: "tech1" });
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "tech_own");
  });

  // ----- tech-other-session: denied -----

  test("cleaning_tech denied when session belongs to another tech", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, { staff_uid: "tech_other" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "not_session_owner");
  });

  test("cleaning_tech with empty uid denied (treats as not_session_owner)", () => {
    const d = fn({ role: "cleaning_tech", uid: "" }, { staff_uid: "tech1" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "not_session_owner");
  });

  test("cleaning_tech denied when session staff_uid is empty", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, { staff_uid: "" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "not_session_owner");
  });

  // ----- missing session: denied -----

  test("cleaning_tech denied when session data is null (session not found)", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, null);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "session_not_found");
  });

  test("cleaning_tech denied when session data is undefined", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, undefined);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "session_not_found");
  });

  test("cleaning_tech denied when session data is non-object", () => {
    const d = fn({ role: "cleaning_tech", uid: "tech1" }, "garbage");
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "session_not_found");
  });

  // ----- wrong role / missing staff: denied -----

  test("no staff denied (no_staff)", () => {
    const d = fn(null, { staff_uid: "tech1" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "no_staff");
  });

  test("undefined staff denied (no_staff)", () => {
    const d = fn(undefined, { staff_uid: "tech1" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "no_staff");
  });

  test("non-object staff (string) denied (no_staff)", () => {
    const d = fn("garbage", { staff_uid: "tech1" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "no_staff");
  });

  test("unknown role denied (wrong_role)", () => {
    const d = fn({ role: "office_worker", uid: "ow1" }, { staff_uid: "ow1" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "wrong_role");
  });

  test("missing role denied (wrong_role)", () => {
    const d = fn({ uid: "x" }, { staff_uid: "x" });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "wrong_role");
  });

  // ----- composition: real-world endpoint flow -----

  test("admin can record to a tech's session (admin override path)", () => {
    const adminStaff = { role: "admin", uid: "admin_a", email: "admin@x.com" };
    const techSession = { staff_uid: "tech_bonnie", customer_slug: "cedar" };
    const d = fn(adminStaff, techSession);
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "admin");
  });

  test("tech bonnie can record to her own session", () => {
    const bonnie = { role: "cleaning_tech", uid: "uid_bonnie", email: "bonnie@x.com" };
    const session = { staff_uid: "uid_bonnie", customer_slug: "cedar" };
    const d = fn(bonnie, session);
    assert.equal(d.allowed, true);
    assert.equal(d.scope, "tech_own");
  });

  test("tech kiana CANNOT record to bonnie's session", () => {
    const kiana = { role: "cleaning_tech", uid: "uid_kiana", email: "kiana@x.com" };
    const bonnieSession = { staff_uid: "uid_bonnie", customer_slug: "cedar" };
    const d = fn(kiana, bonnieSession);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "not_session_owner");
  });
});

// ============================================================
// Phase 36c.3a — client helper pure surface
//
// public/lib/sessionsV2-client.js exposes _todayPacific,
// _derivePhotoId, _classifyRecordPhotoOpts as pure helpers used by
// maybeRecordSessionPhoto. They run inside an IIFE that assigns to
// `self.PIONEER_SESSIONS_V2`. To exercise them in Node we simulate
// the browser globals + auth shim, then evaluate the script.
// ============================================================
describe("client maybeRecordSessionPhoto — pure helpers (Phase 36c.3a)", () => {
  // Load the browser IIFE into a Node-compatible global. This avoids
  // pulling firebase SDK into the test process — we only touch pure
  // exports that don't reference firebase.* at module load time.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "public/lib/sessionsV2-client.js"),
    "utf8"
  );
  // Build a sandbox with `self` so the IIFE's `(typeof self !== "undefined" ? self : this)`
  // resolves to our sandbox. We DO NOT load firebase; the pure helpers
  // we test don't touch it.
  const sandbox = { self: {}, console: console };
  sandbox.self.firebase = undefined; // explicit — no firebase in test
  const fn = new Function("self", "console", src);
  fn(sandbox.self, console);
  const helper = sandbox.self.PIONEER_SESSIONS_V2;

  test("module loaded + exposes new pure helpers", () => {
    assert.equal(typeof helper, "object");
    assert.equal(typeof helper._todayPacific, "function");
    assert.equal(typeof helper._derivePhotoId, "function");
    assert.equal(typeof helper._classifyRecordPhotoOpts, "function");
    assert.equal(typeof helper.maybeRecordSessionPhoto, "function");
  });

  describe("_todayPacific", () => {
    test("returns YYYY-MM-DD string", () => {
      const d = helper._todayPacific();
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("_derivePhotoId", () => {
    test("submissionId + position 1 -> submissionId_ph_1", () => {
      assert.equal(helper._derivePhotoId("abc123", 1), "abc123_ph_1");
    });
    test("position 12 (max DCR batch) works", () => {
      assert.equal(helper._derivePhotoId("abc123", 12), "abc123_ph_12");
    });
    test("non-integer position rounded", () => {
      assert.equal(helper._derivePhotoId("abc", 3.7), "abc_ph_4");
    });
    test("missing submissionId -> null", () => {
      assert.equal(helper._derivePhotoId(null, 1), null);
      assert.equal(helper._derivePhotoId("", 1), null);
      assert.equal(helper._derivePhotoId(undefined, 1), null);
    });
    test("position 0 -> null (1-based positions only)", () => {
      assert.equal(helper._derivePhotoId("abc", 0), null);
    });
    test("negative position -> null", () => {
      assert.equal(helper._derivePhotoId("abc", -1), null);
    });
    test("non-number position -> null", () => {
      assert.equal(helper._derivePhotoId("abc", "1"), null);
      assert.equal(helper._derivePhotoId("abc", null), null);
    });
  });

  describe("_classifyRecordPhotoOpts", () => {
    const fn = (o) => helper._classifyRecordPhotoOpts(o);

    test("missing opts -> missing_opts", () => {
      assert.deepEqual(fn(null),      { ok: false, reason: "missing_opts" });
      assert.deepEqual(fn(undefined), { ok: false, reason: "missing_opts" });
      assert.deepEqual(fn("string"),  { ok: false, reason: "missing_opts" });
    });
    test("missing assignment_id -> missing_assignment_id", () => {
      assert.deepEqual(fn({ submission_id: "x", photo: { storage_path: "y", position: 1 } }),
        { ok: false, reason: "missing_assignment_id" });
    });
    test("missing submission_id -> missing_submission_id", () => {
      assert.deepEqual(fn({ assignment_id: "x", photo: { storage_path: "y", position: 1 } }),
        { ok: false, reason: "missing_submission_id" });
    });
    test("missing photo -> missing_photo", () => {
      assert.deepEqual(fn({ assignment_id: "x", submission_id: "y" }),
        { ok: false, reason: "missing_photo" });
    });
    test("missing storage_path -> missing_storage_path", () => {
      assert.deepEqual(fn({ assignment_id: "x", submission_id: "y",
                            photo: { position: 1 } }),
        { ok: false, reason: "missing_storage_path" });
    });
    test("missing position -> missing_position", () => {
      assert.deepEqual(fn({ assignment_id: "x", submission_id: "y",
                            photo: { storage_path: "z" } }),
        { ok: false, reason: "missing_position" });
    });
    test("position 0 -> missing_position (1-based)", () => {
      assert.deepEqual(fn({ assignment_id: "x", submission_id: "y",
                            photo: { storage_path: "z", position: 0 } }),
        { ok: false, reason: "missing_position" });
    });
    test("all valid -> ok:true", () => {
      assert.deepEqual(fn({
        assignment_id: "asg",
        submission_id: "subm",
        photo: { storage_path: "p", position: 1 }
      }), { ok: true });
    });
    test("extra fields ignored (forward-compat)", () => {
      assert.deepEqual(fn({
        assignment_id: "asg",
        submission_id: "subm",
        service_date:  "2026-06-29",
        photo: { storage_path: "p", position: 1, mime_type: "image/jpeg",
                 size_bytes: 12345, future_field: "ok" },
        another_field: true
      }), { ok: true });
    });
  });

  describe("maybeRecordSessionPhoto — flag-off behavior (no HTTP)", () => {
    test("returns flag_off_client when window.SESSION_V2_ENABLED !== true", async () => {
      sandbox.self.SESSION_V2_ENABLED = false;
      sandbox.self.RECORD_SESSION_PHOTO_URL = "https://example.com/x";
      const r = await helper.maybeRecordSessionPhoto({
        assignment_id: "asg", submission_id: "subm",
        photo: { storage_path: "p", position: 1 }
      });
      assert.deepEqual(r, { status: "skipped", reason: "flag_off_client" });
    });

    test("returns flag_off_client even when URL is configured (flag wins)", async () => {
      sandbox.self.SESSION_V2_ENABLED = undefined;
      sandbox.self.RECORD_SESSION_PHOTO_URL = "https://example.com/x";
      const r = await helper.maybeRecordSessionPhoto({
        assignment_id: "asg", submission_id: "subm",
        photo: { storage_path: "p", position: 1 }
      });
      assert.equal(r.status, "skipped");
      assert.equal(r.reason, "flag_off_client");
    });

    test("returns url_unset when flag on but URL missing", async () => {
      sandbox.self.SESSION_V2_ENABLED = true;
      sandbox.self.RECORD_SESSION_PHOTO_URL = "";
      const r = await helper.maybeRecordSessionPhoto({
        assignment_id: "asg", submission_id: "subm",
        photo: { storage_path: "p", position: 1 }
      });
      assert.deepEqual(r, { status: "skipped", reason: "url_unset" });
    });

    test("returns missing_assignment_id when flag on + URL set but opts invalid", async () => {
      sandbox.self.SESSION_V2_ENABLED = true;
      sandbox.self.RECORD_SESSION_PHOTO_URL = "https://example.com/x";
      const r = await helper.maybeRecordSessionPhoto({
        submission_id: "subm",
        photo: { storage_path: "p", position: 1 }
      });
      assert.deepEqual(r, { status: "skipped", reason: "missing_assignment_id" });
    });

    test("never throws — even on adversarial input", async () => {
      sandbox.self.SESSION_V2_ENABLED = true;
      const r = await helper.maybeRecordSessionPhoto(null);
      assert.equal(r.status, "skipped");
    });
  });
});
