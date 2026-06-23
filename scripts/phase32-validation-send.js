/* Phase 32 controlled validation send.
 *
 * Routes through the EXACT same path a real DCR submission takes:
 *   submitDcrV1
 *     → save dcr_submissions doc
 *     → sendNativeDcrEmailForSubmission wrapper
 *       → getDcrEmailReadiness
 *       → sendDcrEmailCore
 *         → normalizeDcrForEmail
 *         → OpenAI summary generation
 *         → renderDcrEmailHtmlV4
 *         → Gmail API send
 *         → dcr_email_payloads write
 *       → recordEmailStatus stamps native_email
 *
 * Test customer "Phase 32 Validation Test" is created with:
 *   customer_email: nick@pioneercomclean.com
 *   dcr_email_enabled: true
 *   active: true
 *   (NO is_test / exclude flags — those would trip the wrapper's customer
 *   exclusion gate and skip the send. The customer is named so its purpose
 *   is obvious from /admin and the email subject.)
 *
 * Synthetic DCR payload modeled on a known-good Whittaker DCR. Reuses one
 * Whittaker signature URL + one photo URL so the email renders against
 * actual Firebase Storage objects without uploading any new media. Marker
 * `is_test_send: true` is stamped on both the payload (Phase 32 spec) and
 * `submission_meta.phase_32_validation` so audit trails are obvious.
 *
 * Recipient: nick@pioneercomclean.com (set on the customer doc).
 * Subject:   "Cleaning report for Phase 32 Validation Test · <date>".
 *
 *   node scripts/phase32-validation-send.js
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();

const API_KEY     = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL = "nick@pioneercomclean.com";
const SUBMIT_URL  = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitDcrV1";

const CUSTOMER_SLUG = "phase-32-validation-test";
const SOURCE_DCR_ID = "mpxhtso7-rnxbxu";       // known-good shape we mirror media URLs from

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit"
  }).format(new Date());
}

async function adminIdToken() {
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(u.uid);
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const b = await r.json();
  if (!r.ok || !b.idToken) throw new Error("Token exchange failed: " + JSON.stringify(b));
  return b.idToken;
}

async function ensureValidationCustomer() {
  const ref = db.collection("customers").doc(CUSTOMER_SLUG);
  const cur = await ref.get();
  const sts = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    customer_slug:        CUSTOMER_SLUG,
    customer_name:        "Phase 32 Validation Test",
    location_name:        "Phase 32 Validation Test",
    customer_email:       ADMIN_EMAIL,
    dcr_enabled:          true,
    dcr_email_enabled:    true,
    active:               true,
    seed_source:          "scripts/phase32-validation-send.js",
    phase_32_validation:  true,
    updated_at:           sts,
    updated_by:           "phase32_validation_send"
  };
  if (cur.exists) {
    await ref.update(payload);
    return { existed: true, ref: ref };
  }
  payload.created_at = sts;
  payload.created_by = "phase32_validation_send";
  await ref.set(payload);
  return { existed: false, ref: ref };
}

async function loadMediaTemplate() {
  // Pull one signature URL + one photo URL from the known-good Whittaker
  // DCR so the email renders against real Firebase Storage objects.
  const d = (await db.collection("dcr_submissions").doc(SOURCE_DCR_ID).get()).data() || {};
  const aff = d.affirmation || {};
  const signatureUrl = aff.signature_url
    || (d.form_data && d.form_data.signature && d.form_data.signature.download_url)
    || "";
  const photos = (d.photos || []).slice(0, 2);   // 2 photos — enough to verify rendering
  const photoUrls = (d.photo_urls || []).slice(0, 2);
  if (!signatureUrl) throw new Error("Couldn't load a signature URL from the template DCR.");
  if (!photos.length) throw new Error("Couldn't load photos from the template DCR.");
  return { signatureUrl, photos, photoUrls };
}

function buildSyntheticPayload(submissionId, media) {
  const today = todayPT();
  return {
    schema_version: "dcr.v1",
    source:         "api",
    submission_id:  submissionId,

    // Customer routing
    customer_slug:  CUSTOMER_SLUG,
    customer_name:  "Phase 32 Validation Test",
    location_name:  "Phase 32 Validation Test",

    // Tech identity (admin caller bypasses the assignment-gate; we use a
    // real tech slug so the readiness check resolves it cleanly).
    tech_slug:         "nick-k",
    tech_display_name: "Phase 32 Validation Bot",

    // Clean date is today
    clean_date: today,

    notes:      "Phase 32 validation send — synthetic DCR routed through the production submitDcrV1 path to verify native email delivery end-to-end.",
    occupancy:  "empty",

    // PHOTOS — required by validatePayload (array shape).
    photos:     media.photos,
    photo_urls: media.photoUrls,

    // Affirmation (required by validatePayload)
    affirmation: {
      affirmed_text:   "Phase 32 validation — synthetic affirmation.",
      affirmed:        true,
      signed_at:       new Date().toISOString(),
      signature_url:   media.signatureUrl,
      signature_name:  "Phase 32 Validation Bot"
    },

    // Form data — checklist + the side fields readiness wants.
    form_data: {
      checklist: [
        {
          section_id:    "lobby",
          section_label: "Lobby + Reception",
          items: [
            { item_id: "lobby-vacuumed",     label: "Lobby vacuumed",      status: "done" },
            { item_id: "reception-wiped",    label: "Reception desk wiped", status: "done" }
          ]
        },
        {
          section_id:    "restrooms",
          section_label: "Restrooms",
          items: [
            { item_id: "tp-restocked",   label: "Toilet paper restocked", status: "done" },
            { item_id: "soap-restocked", label: "Soap restocked",         status: "done" }
          ]
        }
      ],
      has_problem:        false,
      needs_supplies:     false,
      on_time_budget:     "yes",
      occupancy_level:    "empty",
      anyone_in_building: "no",
      signature: {
        storage_path:  "dcr-signatures/" + CUSTOMER_SLUG + "/" + submissionId + "/signature.png",
        download_url:  media.signatureUrl
      },
      time_budget_reasons:    [],
      experience_rating:      "ok",
      overBudgetNote:         "",
      time_budget_other_note: "",
      time_over_budget_context: "",
      timeBudget: null,
      problem:    "",
      supply_request_text: ""
    },

    // Phase 32 markers
    is_test_send: true,
    submission_meta: {
      phase_32_validation: true,
      synthetic_dcr:       true,
      origin_script:       "scripts/phase32-validation-send.js",
      client_submitted_at: new Date().toISOString()
    }
  };
}

(async () => {
  console.log("================================================================");
  console.log("Phase 32 — Controlled Validation Send");
  console.log("================================================================");

  // ---- 1. Customer doc ----
  const cust = await ensureValidationCustomer();
  console.log("Customer customers/" + CUSTOMER_SLUG + ": " + (cust.existed ? "refreshed" : "created"));

  // ---- 2. Media template ----
  const media = await loadMediaTemplate();
  console.log("Loaded signature + " + media.photos.length + " photo(s) from template " + SOURCE_DCR_ID);

  // ---- 3. Build payload ----
  const submissionId = "phase32_validation_" + Date.now();
  const payload = buildSyntheticPayload(submissionId, media);
  console.log("Synthetic submission_id: " + submissionId);

  // ---- 4. Admin token ----
  const idToken = await adminIdToken();

  // ---- 5. POST to submitDcrV1 (FULL native path: submitDcrV1 → wrapper → OpenAI → Gmail) ----
  console.log("\nPOST submitDcrV1 (admin bypass enabled)...");
  const t0 = Date.now();
  const r = await fetch(SUBMIT_URL, {
    method:  "POST",
    headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
    body:    JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  const elapsed = Date.now() - t0;
  console.log("HTTP " + r.status + " · " + elapsed + "ms");
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));

  if (r.status !== 200 || !body.ok) {
    console.error("\n✖ submitDcrV1 failed.");
    process.exit(2);
  }

  // ---- 6. Verify dcr_submissions ----
  const dcrSnap = await db.collection("dcr_submissions").doc(submissionId).get();
  if (!dcrSnap.exists) { console.error("✖ dcr_submissions doc missing"); process.exit(3); }
  const dcr = dcrSnap.data();
  console.log("\n--- dcr_submissions/" + submissionId + " ---");
  console.log("  customer_name:    " + dcr.customer_name);
  console.log("  customer_slug:    " + dcr.customer_slug);
  console.log("  tech_display:     " + dcr.tech_display_name);
  console.log("  clean_date:       " + dcr.clean_date);
  console.log("  is_test_send:     " + dcr.is_test_send);
  console.log("  submitted_by:     " + dcr.submitted_by_email);
  console.log("  zapier.status:    " + (dcr.zapier && dcr.zapier.status));
  console.log("  zapier.attempted: " + (dcr.zapier && dcr.zapier.attempted));
  console.log("\n--- dcr_submissions.native_email ---");
  console.log("  " + JSON.stringify(dcr.native_email || null, null, 2).split("\n").join("\n  "));
  console.log("\n--- dcr_submissions other email fields ---");
  console.log("  emailStatus:     " + dcr.emailStatus);
  console.log("  emailTo:         " + dcr.emailTo);
  console.log("  emailSubject:    " + dcr.emailSubject);
  console.log("  gmailMessageId:  " + dcr.gmailMessageId);
  console.log("  emailedAt:       " + (dcr.emailedAt && dcr.emailedAt.toDate ? dcr.emailedAt.toDate().toISOString() : "?"));

  // ---- 7. Verify dcr_email_payloads ----
  const ep = await db.collection("dcr_email_payloads").doc(submissionId).get();
  if (!ep.exists) { console.error("✖ dcr_email_payloads doc missing"); process.exit(4); }
  const p = ep.data();
  console.log("\n--- dcr_email_payloads/" + submissionId + " ---");
  console.log("  to:              " + p.to);
  console.log("  subject:         " + p.subject);
  console.log("  customerId:      " + p.customerId);
  console.log("  sentAt:          " + (p.sentAt && p.sentAt.toDate ? p.sentAt.toDate().toISOString() : "?"));
  console.log("  gmailMessageId:  " + p.gmailMessageId);
  console.log("  promptVersion:   " + p.promptVersion);
  console.log("  isTestSend:      " + p.isTestSend);
  console.log("  photoUrlCount:   " + p.photoUrlCount);

  // ---- 8. Duplicate-protection re-send (no force) ----
  console.log("\n--- Duplicate protection test (re-submit same submission_id) ---");
  const r2 = await fetch(SUBMIT_URL, {
    method:  "POST",
    headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
    body:    JSON.stringify(payload)
  });
  const body2 = await r2.json().catch(() => ({}));
  console.log("HTTP " + r2.status);
  console.log("native_email.status: " + (body2.native_email && body2.native_email.status));
  console.log("native_email.code:   " + (body2.native_email && body2.native_email.code));
  console.log("native_email.reason: " + (body2.native_email && body2.native_email.reason));

  console.log("\n================================================================");
  console.log("VALIDATION COMPLETE");
  console.log("================================================================");
  console.log("dcrId:           " + submissionId);
  console.log("payload doc:     dcr_email_payloads/" + submissionId);
  console.log("Gmail messageId: " + p.gmailMessageId);
  console.log("Recipient:       " + p.to);
  console.log("Subject:         " + p.subject);
  console.log("Send timestamp:  " + (p.sentAt && p.sentAt.toDate ? p.sentAt.toDate().toISOString() : "?"));
})().catch(e => { console.error("Validation threw:", e); process.exit(1); });
