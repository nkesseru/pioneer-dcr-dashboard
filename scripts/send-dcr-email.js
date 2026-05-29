/* Pioneer DCR Hub — manual native-email send for a specific DCR.
 *
 * Wraps `generateAndSendDcrEmailV1` so we can:
 *   1. Send a TEST email of a real DCR to a chosen recipient (QA).
 *   2. Trigger the live native customer email for DCRs whose Zapier
 *      delivery failed, then stamp manual-resend audit fields on the
 *      Firestore doc.
 *
 * Auth: mints an ID token for `nick@pioneercomclean.com` (already on the
 * hardcoded admin allowlist) via Firebase Auth's signInWithCustomToken
 * REST endpoint. Requires `serviceAccountKey.json` at the repo root.
 *
 * Usage:
 *   node scripts/send-dcr-email.js --dcr <submission_id> --test nick@pioneercomclean.com
 *   node scripts/send-dcr-email.js --dcr <submission_id> --customer --reason "Legacy Zapier delivery failed during pilot"
 *
 * Flags:
 *   --dcr <id>           dcr_submissions/<id> to send
 *   --test <email>       OPTIONAL — divert to this address; NO customer send
 *   --customer           OPTIONAL — go live, send to the real customer recipient
 *   --reason "text"      OPTIONAL — sets manualResendReason on the doc (live sends only)
 *   --confirm-resend     OPTIONAL — passes confirmResend:true (allow resend of an already-sent DCR)
 *
 * `--test` and `--customer` are mutually exclusive — passing neither aborts
 * to avoid an accidental customer send.
 */

const admin = require("firebase-admin");
const path  = require("path");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(path.join(__dirname, "..", "serviceAccountKey.json")))
  });
}
const db = admin.firestore();

const FIREBASE_API_KEY = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL      = "nick@pioneercomclean.com";
const SEND_URL         = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/generateAndSendDcrEmailV1";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dcr: null, test: null, customer: false, reason: "", confirmResend: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dcr")             { out.dcr = args[++i]; continue; }
    if (a === "--test")            { out.test = args[++i]; continue; }
    if (a === "--customer")        { out.customer = true;  continue; }
    if (a === "--reason")          { out.reason = args[++i]; continue; }
    if (a === "--confirm-resend")  { out.confirmResend = true; continue; }
    if (a === "-h" || a === "--help") {
      console.log("Usage: node scripts/send-dcr-email.js --dcr <id> ( --test <email> | --customer ) [--reason \"...\"] [--confirm-resend]");
      process.exit(0);
    }
  }
  return out;
}

async function mintAdminIdToken() {
  const user = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(user.uid);
  const url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + FIREBASE_API_KEY;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  const body = await res.json();
  if (!res.ok || !body.idToken) {
    throw new Error("Failed to exchange custom token for ID token: " + JSON.stringify(body));
  }
  return body.idToken;
}

async function callSendEndpoint(idToken, payload) {
  const res = await fetch(SEND_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + idToken
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(function () { return {}; });
  return { httpStatus: res.status, body: body };
}

(async function main() {
  const opts = parseArgs();
  if (!opts.dcr) {
    console.error("Missing --dcr <submission_id>"); process.exit(1);
  }
  if (!opts.test && !opts.customer) {
    console.error("Pass either --test <email> (QA) or --customer (live). Aborting to avoid an accidental customer send.");
    process.exit(1);
  }
  if (opts.test && opts.customer) {
    console.error("Pass either --test OR --customer, not both.");
    process.exit(1);
  }

  // Pre-flight: read the DCR doc so we can echo what we're about to send.
  const dcrSnap = await db.collection("dcr_submissions").doc(opts.dcr).get();
  if (!dcrSnap.exists) {
    console.error("DCR not found:", opts.dcr);
    process.exit(1);
  }
  const dcr = dcrSnap.data() || {};
  console.log("DCR target:");
  console.log("  submission_id : " + opts.dcr);
  console.log("  customer      : " + (dcr.customer_name || dcr.customer_slug || "(unknown)"));
  console.log("  tech          : " + (dcr.tech_display_name || dcr.tech_slug || "(unknown)"));
  console.log("  clean_date    : " + (dcr.clean_date || "(unknown)"));
  console.log("  emailStatus   : " + (dcr.emailStatus || "(unset)"));
  console.log("  zapier.status : " + ((dcr.zapier && dcr.zapier.status) || "(unset)"));
  console.log("");

  if (opts.test) {
    console.log("Mode: TEST — diverting send to " + opts.test);
  } else {
    console.log("Mode: LIVE — sending to the customer's recipient on file");
    if (opts.reason) console.log("Reason: " + opts.reason);
    if (opts.confirmResend) console.log("Bypass: confirmResend = true");
  }
  console.log("");

  console.log("Minting admin ID token for " + ADMIN_EMAIL + " …");
  const idToken = await mintAdminIdToken();

  const customerId = String(dcr.customer_slug || "").trim();
  if (!customerId) {
    console.error("DCR has no customer_slug — cannot resolve customers/{customerId}.");
    process.exit(1);
  }
  const payload = { dcrId: opts.dcr, customerId: customerId };
  if (opts.test)          payload.testRecipientEmail = opts.test;
  if (opts.confirmResend) payload.confirmResend = true;

  console.log("Calling generateAndSendDcrEmailV1 …");
  const { httpStatus, body } = await callSendEndpoint(idToken, payload);
  console.log("HTTP " + httpStatus);
  console.log(JSON.stringify(body, null, 2));

  if (!body || body.ok !== true) {
    console.error("\nSend did not succeed. Aborting Firestore audit-field writeback.");
    process.exit(httpStatus >= 400 ? 2 : 1);
  }
  if (body.status === "skipped") {
    console.log("\nFunction returned ok: true, status: skipped — nothing to audit. Reason: " + (body.reason || "(none)"));
    process.exit(0);
  }

  // Live customer sends — write the manual-resend audit fields the user asked for.
  if (opts.customer && body.status === "sent") {
    const updates = {
      emailProvider:        "native",
      manualResend:         true,
      manualResendReason:   opts.reason || "Manual native email send",
      manualResendBy:       ADMIN_EMAIL,
      manualResendAt:       admin.firestore.FieldValue.serverTimestamp(),
      nativeEmailMessageId: body.messageId || null
    };
    await db.collection("dcr_submissions").doc(opts.dcr).set(updates, { merge: true });
    console.log("\nWrote audit fields to dcr_submissions/" + opts.dcr + ":");
    console.log(JSON.stringify(updates, null, 2));
  }
  console.log("\nDone.");
  process.exit(0);
})().catch(function (err) {
  console.error("Crashed:", err && err.message);
  if (err && err.stack) console.error(err.stack);
  process.exit(2);
});
