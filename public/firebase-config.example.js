/* Firebase web SDK config — PLACEHOLDER ONLY.
 *
 * Copy this file to `public/firebase-config.js` and fill in the values from:
 *   Firebase Console → Project settings → General → Your apps → Web app → SDK setup and configuration → Config
 *
 * `firebase-config.js` is .gitignored and is loaded by index.html before app.js.
 * It must define window.FIREBASE_CONFIG and window.SUBMIT_DCR_V1_URL.
 *
 * DO NOT commit real credentials in this example file.
 */
(function () {
  "use strict";

  window.FIREBASE_CONFIG = {
    apiKey:            "REPLACE_WITH_apiKey",
    authDomain:        "pioneer-dcr-hub.firebaseapp.com",
    projectId:         "pioneer-dcr-hub",
    storageBucket:     "pioneer-dcr-hub.appspot.com",
    messagingSenderId: "REPLACE_WITH_messagingSenderId",
    appId:             "REPLACE_WITH_appId"
  };

  // HTTPS endpoint of the deployed Cloud Function `submitDcrV1`.
  // After `firebase deploy --only functions:submitDcrV1`, the console prints a URL
  // like: https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitDcrV1
  // Paste it here.
  window.SUBMIT_DCR_V1_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `techHubViewV1`.
  // After `firebase deploy --only functions:techHubViewV1`, the console prints
  // a URL like: https://techhubviewv1-XXXXX-uc.a.run.app
  // Paste it here. Used by /tech.html to load the cleaning-tech-safe view of
  // customer + supply + DCR data.
  window.TECH_HUB_VIEW_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `whoAmIV1`. Called on boot
  // by both the DCR form and the Tech Hub to determine whether the signed-in
  // user is an admin, an active cleaning_tech, or denied. Required for the
  // staff-auth gate to function.
  window.WHOAMI_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `createCleaningTechLoginV1`.
  // Used by /admin.html (Cleaning Techs tab → "+ Add tech / Login setup")
  // to provision a Firebase Auth user AND the cleaning_techs/{tech_slug}
  // doc in one server call. Admin-only — the function rejects anyone
  // not in the ALLOWED_ADMIN_EMAILS list.
  window.CREATE_CLEANING_TECH_LOGIN_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `createAdminLoginV1`.
  // Used by /admin.html (Admins tab → "+ Add admin") to create a Firebase
  // Auth user, write /admins/{email}, and trigger the Firebase password
  // reset email so the new admin can set their password. Admin-only.
  window.CREATE_ADMIN_LOGIN_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `sendPasswordResetV1`.
  // Used by /admin.html (the "Resend invite" buttons on tech and admin
  // rows) to send a fresh Firebase password-reset email for an existing
  // user. Admin-only. Idempotent — anti-enumerated: same response shape
  // regardless of whether an Auth user exists.
  window.SEND_PASSWORD_RESET_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `pioneerQualityViewV1`.
  // Tech-safe aggregate read used by /team-hub.html to surface the
  // company Pioneer Quality Score + recent 5-star celebration wins.
  // Inspections themselves stay admin-only — this function emits a
  // trimmed, public-safe payload (no inspector identity, no per-area
  // breakdown, no notes).
  window.PIONEER_QUALITY_VIEW_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `deleteCleaningTechV1`.
  // Used by /admin.html (Cleaning Techs tab → "Delete" button) to HARD
  // delete a tech doc. Admin-only. Refuses if the tech has any linked
  // DCR submissions, supply requests, issues, or notifications — the
  // admin must Archive instead. If safe, also disables the Firebase
  // Auth user (unless the same email is also an admin).
  window.DELETE_CLEANING_TECH_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `submitSupplyStationOrderV1`.
  // Used by /supply-station.html (Supply Station Order page) — any active
  // signed-in staff (admin OR cleaning_tech) can POST a supply-station
  // order. Server creates both the supply_station_orders doc AND the
  // supply_notifications reminder doc with April's contact info attached
  // server-side, so the tech-facing JS bundle never sees the phone.
  window.SUPPLY_STATION_ORDER_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `refreshGhlHiringV1`.
  // Used by /manager.html (Hiring Health → "Refresh GHL" button) to trigger
  // an on-demand pull of the GHL Applicant Tracking pipeline. Admin-only
  // (server-side role check). The GHL integration token is held only in
  // the GHL_PRIVATE_INTEGRATION_TOKEN Firebase secret — never exposed here.
  window.REFRESH_GHL_HIRING_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `sendTwilioMessageV1`.
  // Used by /manager.html (thread detail modal → "Send SMS" button) to
  // trigger one manual outbound SMS to the employee's phone on file.
  // Admin-only (server-side role check). Twilio credentials live only in
  // the TWILIO_* Firebase Secrets — never exposed here.
  window.SEND_TWILIO_MESSAGE_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `quickbooksOAuthStartV1`.
  // Used by /manager.html (Financial Pulse card → "Connect QuickBooks"
  // button) to initiate the OAuth 2 handshake with Intuit. Returns an
  // authorize URL the admin must visit in a new tab.
  window.QUICKBOOKS_OAUTH_START_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `refreshFinancialPulseV1`.
  // Used by /manager.html and /ceo.html refresh buttons to trigger an
  // on-demand Customer Economics sync. Daily scheduled sync runs at
  // 07:00 PT without this URL.
  window.REFRESH_FINANCIAL_PULSE_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";

  // HTTPS endpoint of the deployed Cloud Function `waiveDcrV1`. POST
  // { assignment_id, service_session_id, reason_code, reason_detail }
  // with Firebase Auth bearer token. The signed-in tech / admin marks
  // the session's dcr_status: "waived" with full audit fields. Used
  // by /work.html (the "No DCR Needed" button on dcr_pending cards).
  window.WAIVE_DCR_URL = "REPLACE_WITH_HTTPS_FUNCTION_URL";
})();
