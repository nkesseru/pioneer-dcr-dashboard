/* Test harness — replicates the new exportPayrollCsvV1 upload pattern
 * via Admin SDK to prove the firebaseStorageDownloadTokens metadata
 * persists AND the resulting URL resolves end-to-end.
 *
 * This is what the live function does on its upload + readback step,
 * minus the Firestore writes + admin-auth check.
 *
 *   node scripts/test-payroll-token-upload.js
 */
"use strict";
const admin = require("firebase-admin");
const crypto = require("crypto");

const BUCKET = "pioneer-dcr-hub.firebasestorage.app";
const TEST_PATH = "payroll_exports/__token_persistence_test__/probe-" + Date.now() + ".csv";
const TEST_CONTENT = "Probe,Time\n28D-token-fix," + new Date().toISOString() + "\n";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}

(async () => {
  console.log("=== Phase 28D token-persistence probe ===");
  console.log("Bucket:    " + BUCKET);
  console.log("Path:      " + TEST_PATH);
  console.log("");

  const token = crypto.randomUUID();
  console.log("Generated token: " + token);

  const bucket = admin.storage().bucket(BUCKET);
  const file   = bucket.file(TEST_PATH);

  // Mirror the new function's save options EXACTLY.
  console.log("\nUploading with new metadata structure (contentType + token both inside metadata)...");
  await file.save(Buffer.from(TEST_CONTENT, "utf8"), {
    metadata: {
      contentType: "text/csv; charset=utf-8",
      metadata: {
        firebaseStorageDownloadTokens: token
      }
    }
  });
  console.log("Upload complete.");

  // Read back metadata to verify token persisted.
  console.log("\nReading back object metadata...");
  const [meta] = await file.getMetadata();
  const persisted = meta && meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
  console.log("contentType on object:  " + meta.contentType);
  console.log("customMetadata keys:    " + (meta.metadata ? Object.keys(meta.metadata).join(",") : "(none)"));
  console.log("token in customMetadata: " + (persisted || "(absent)"));
  console.log("token matches generated:" + (persisted === token ? " ✅ YES" : " ❌ NO"));

  if (persisted !== token) {
    console.error("\n❌ Token did NOT persist on object metadata. Fix has NOT landed correctly.");
    process.exit(2);
  }

  // Build download URL exactly as the function does.
  const url = "https://firebasestorage.googleapis.com/v0/b/" + BUCKET +
              "/o/" + encodeURIComponent(TEST_PATH) +
              "?alt=media&token=" + token;
  console.log("\nDownload URL: " + url);

  // Actually fetch the URL to confirm it resolves (not 503).
  console.log("\nFetching download URL to verify end-to-end...");
  const res = await fetch(url);
  console.log("HTTP status: " + res.status + " " + res.statusText);
  const body = await res.text();
  console.log("Response body (first 200 chars): " + body.slice(0, 200));
  if (!res.ok) {
    console.error("\n❌ Download URL did NOT resolve (HTTP " + res.status + ").");
    process.exit(2);
  }
  if (!body.includes("28D-token-fix")) {
    console.error("\n❌ Body did not contain expected content.");
    process.exit(2);
  }

  console.log("\n✅ End-to-end token download verified.");
  console.log("");
  console.log("Cleaning up probe object...");
  await file.delete();
  console.log("Cleanup done.");
  console.log("");
  console.log("Conclusion: the new file.save() metadata structure DOES persist");
  console.log("firebaseStorageDownloadTokens correctly, and the resulting URL");
  console.log("resolves 200 OK with the file content. The live exportPayrollCsvV1");
  console.log("function uses the identical pattern — your UI Export → Download");
  console.log("CSV button should now work.");
})().catch(e => { console.error("Probe failed:", e); process.exit(1); });
