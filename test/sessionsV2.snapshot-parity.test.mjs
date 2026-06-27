// SessionV2 Phase 36a — snapshot module byte-parity guard.
//
// The snapshot renderer ships in TWO places because:
//   - public/lib/sessionsV2-snapshot.js is loaded by the browser
//     (admin canary harness) via <script> tag.
//   - functions/sessionsV2-snapshot.js is loaded by Cloud Functions
//     via require() — Firebase deploy bundles ONLY the functions/
//     directory, so it cannot reach public/lib/ at runtime.
//
// This test asserts the two files are byte-identical AND that they
// load + export the same surface. Any drift between them risks
// producing different snapshots for the same Session — which would
// silently break parity validation (Phase 36a.2) and historical
// re-rendering (Phase 36f+).
//
// On a real diff, the test fails loudly. Fix by syncing the files.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, "..");
const require   = createRequire(import.meta.url);

describe("snapshot module — byte parity between public/ and functions/", () => {
  test("public/lib/sessionsV2-snapshot.js === functions/sessionsV2-snapshot.js", () => {
    const a = readFileSync(join(repoRoot, "public/lib/sessionsV2-snapshot.js"), "utf8");
    const b = readFileSync(join(repoRoot, "functions/sessionsV2-snapshot.js"),  "utf8");
    assert.equal(a, b,
      "sessionsV2-snapshot.js copies have drifted between public/lib and functions/. " +
      "Sync them (copy canonical version to the other) before continuing.");
  });

  test("both copies export same SNAPSHOT_VERSION", () => {
    const pubMod = require("../public/lib/sessionsV2-snapshot.js");
    const fnMod  = require("../functions/sessionsV2-snapshot.js");
    assert.equal(pubMod.SNAPSHOT_VERSION, fnMod.SNAPSHOT_VERSION);
  });

  test("both copies render identical snapshots for the same input", () => {
    const pubMod = require("../public/lib/sessionsV2-snapshot.js");
    const fnMod  = require("../functions/sessionsV2-snapshot.js");
    const input = {
      session_id: "sess_x_2026-06-27_a1",
      source: "tech_clock",
      status: "in_progress",
      service_date: "2026-06-27",
      customer_id: "cedar", customer_slug: "cedar", customer_name: "Cedar LLC",
      staff_uid: "u1", staff_email: "tech@example.com",
      expected_components: ["clock", "photos", "dcr"],
      components: {
        clock:  { status: "complete" },
        photos: { status: "collecting", count: 2 },
        dcr:    { status: "missing" }
      }
    };
    const a = pubMod.renderSessionSnapshot(input, { generated_at_iso: "PIN" });
    const b = fnMod.renderSessionSnapshot(input,  { generated_at_iso: "PIN" });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
