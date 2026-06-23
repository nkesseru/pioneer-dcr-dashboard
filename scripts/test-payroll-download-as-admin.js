/* Simulate the Payroll UI download click end-to-end:
 *
 *   1. Mint an admin ID token (same shape Firebase Auth gives the browser)
 *   2. GET downloadPayrollExportCsvV1 with Authorization: Bearer <ID_TOKEN>
 *   3. Verify 200 OK · text/csv · Content-Disposition · body parses
 *
 *   node scripts/test-payroll-download-as-admin.js [<export_id>]
 *
 * If no export_id arg, finds the most recent ACTIVE export.
 */
"use strict";
const admin = require("firebase-admin");
const fs = require("fs");

const API_KEY = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";  // public web API key from firebase-config.js
const ADMIN_EMAIL = "nick@pioneercomclean.com";
const DOWNLOAD_URL = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/downloadPayrollExportCsvV1";

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}

(async () => {
  // Resolve the export_id.
  let exportId = process.argv[2] || null;
  if (!exportId) {
    const snap = await admin.firestore().collection("payroll_exports")
      .where("status", "==", "active").orderBy("generated_at", "desc").limit(1).get();
    if (snap.empty) { console.error("No active export found."); process.exit(2); }
    exportId = snap.docs[0].id;
  }
  console.log("Target export_id: " + exportId);
  console.log("");

  // Step 1: Custom token for admin user
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  console.log("Step 1 — minting custom token for admin uid=" + u.uid + " (" + u.email + ")");
  const customToken = await admin.auth().createCustomToken(u.uid);

  // Step 2: Exchange custom token for ID token via Identity Toolkit REST
  console.log("Step 2 — exchanging custom token for ID token via Identity Toolkit…");
  const exch = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  const exchBody = await exch.json();
  if (!exch.ok || !exchBody.idToken) {
    console.error("Exchange failed:", exchBody);
    process.exit(2);
  }
  const idToken = exchBody.idToken;
  console.log("  ID token issued (len=" + idToken.length + ")");
  console.log("");

  // Step 3: Call download endpoint with Authorization header — mirrors
  // downloadCsvViaAuthenticatedFetch() in tab-payroll.js.
  console.log("Step 3 — GET " + DOWNLOAD_URL + "?export_id=" + exportId);
  console.log("  Authorization: Bearer <ID_TOKEN>");
  const url = DOWNLOAD_URL + "?export_id=" + encodeURIComponent(exportId);
  const res = await fetch(url, {
    method: "GET",
    headers: { "Authorization": "Bearer " + idToken }
  });
  console.log("");
  console.log("Response:");
  console.log("  status:               " + res.status + " " + res.statusText);
  console.log("  content-type:         " + res.headers.get("content-type"));
  console.log("  content-disposition:  " + res.headers.get("content-disposition"));
  console.log("  cache-control:        " + res.headers.get("cache-control"));

  if (!res.ok) {
    const body = await res.text();
    console.error("  body: " + body.slice(0, 500));
    console.error("\n❌ Download failed.");
    process.exit(2);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  console.log("  body length:          " + buf.length + " bytes");
  const head = buf.toString("utf8", 0, Math.min(buf.length, 800));
  console.log("  body (first 800 chars):");
  console.log("------------------------------------------");
  console.log(head);
  console.log("------------------------------------------");

  // Save to a temp file for posterity.
  const tmpPath = "/tmp/" + exportId + ".csv";
  fs.writeFileSync(tmpPath, buf);
  console.log("\nSaved to: " + tmpPath);

  // Sanity checks
  const hasSection1 = head.includes("=== WORK SESSIONS ===");
  const hasSection3 = head.includes("=== TOTALS ===") || buf.toString("utf8").includes("=== TOTALS ===");
  console.log("");
  console.log("Content sanity:");
  console.log("  Has '=== WORK SESSIONS ===' header:  " + (hasSection1 ? "✅" : "❌"));
  console.log("  Has '=== TOTALS ===' header:         " + (hasSection3 ? "✅" : "❌"));

  if (res.status === 200 && hasSection1 && hasSection3) {
    console.log("\n✅ Authenticated download verified end-to-end.");
  } else {
    console.log("\n❌ Something looks off; inspect output above.");
    process.exit(2);
  }
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
