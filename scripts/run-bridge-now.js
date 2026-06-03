/* Sev-1 remediation — fire refreshServiceAssignmentsFromDeputyV1 for
 * today + 1 day forward. Uses Nick's admin custom-token exchange so the
 * call hits the LIVE Cloud Function exactly like the admin UI button.
 *
 *   DRY_RUN=true  node scripts/run-bridge-now.js  (preview)
 *   DRY_RUN=false node scripts/run-bridge-now.js  (commit)
 */
"use strict";
const admin = require("firebase-admin");

const API_KEY = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL = "nick@pioneercomclean.com";
const BRIDGE_URL = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/refreshServiceAssignmentsFromDeputyV1";
const DRY_RUN = process.env.DRY_RUN !== "false";

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}

(async () => {
  const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
  const customToken = await admin.auth().createCustomToken(u.uid);
  const exch = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  const exchBody = await exch.json();
  if (!exch.ok || !exchBody.idToken) { console.error("Token exchange failed:", exchBody); process.exit(2); }
  const idToken = exchBody.idToken;

  const sync_date = todayPT();
  const days_forward = 1;
  console.log("Calling bridge — sync_date=" + sync_date + ", days_forward=" + days_forward + ", dry_run=" + DRY_RUN);

  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
    body: JSON.stringify({ sync_date, days_forward, dry_run: DRY_RUN })
  });
  const body = await res.json();
  console.log("HTTP " + res.status);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok || !body.ok) process.exit(2);
})().catch(e => { console.error(e); process.exit(1); });
