/* Phase 32G — backfill / retry tool for unsent DCR customer emails.
 *
 * Safe by default: DRY-RUN. Lists the DCRs that would be sent, with the
 * resolved customer + recipient + the readiness verdict. Pass --send to
 * actually fire emails (one at a time, with a small delay so we don't
 * overrun the OpenAI / Gmail quotas).
 *
 * Calls the live generateAndSendDcrEmailV1 Cloud Function via Nick's
 * admin custom-token exchange — same auth path the admin UI uses — so
 * the script doesn't need to bind any secrets locally. That also means
 * the duplicate-protection + readiness gates inside the Cloud Function
 * apply identically; we can't accidentally double-send.
 *
 * Usage:
 *   node scripts/backfill-unsent-dcr-emails.js               # last 7 days, dry-run
 *   node scripts/backfill-unsent-dcr-emails.js --days=14     # widen the window
 *   node scripts/backfill-unsent-dcr-emails.js --send        # actually send eligible
 *   node scripts/backfill-unsent-dcr-emails.js --send --limit=5
 *   node scripts/backfill-unsent-dcr-emails.js --dcrId=<id>  # one specific DCR
 *
 * Eligibility (applied client-side BEFORE invoking the Cloud Function,
 * so dry-run shows accurate counts):
 *   • dcr_submissions has a customer_email or the customer doc does
 *   • customer is not flagged is_test / exclude_from_customer_reporting /
 *     disable_customer_notifications / disable_dcr_email
 *   • customer.dcr_enabled !== false
 *   • dcr_email_payloads/{dcrId} does not have sentAt set already
 *   • dcr_submissions.{id}.is_test / is_qa_test / exclude_from_customer_reporting
 *     are not true
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();

const API_KEY      = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL  = "nick@pioneercomclean.com";
const SEND_URL     = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/generateAndSendDcrEmailV1";
const SEND_DELAY_MS = 2000;     // throttle between sends

// ---- argv parsing ----
const args = {};
process.argv.slice(2).forEach(a => {
  const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/i.exec(a);
  if (m) args[m[1]] = (m[2] == null) ? true : m[2];
});
const DAYS    = Math.max(1, Math.min(60, Number(args.days || 7)));
const SEND    = args.send === true || args.send === "true";
const LIMIT   = args.limit ? Math.max(1, Number(args.limit)) : null;
const FORCE   = args.force === true || args.force === "true";
const ONE_ID  = args.dcrId || null;

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

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return Number(ts) || 0;
}

async function loadCandidates() {
  // Load + filter client-side.
  let dcrs;
  if (ONE_ID) {
    const d = await db.collection("dcr_submissions").doc(ONE_ID).get();
    if (!d.exists) throw new Error("DCR not found: " + ONE_ID);
    dcrs = [Object.assign({ _id: d.id }, d.data() || {})];
  } else {
    const cutoff = Date.now() - DAYS * 86400000;
    const snap = await db.collection("dcr_submissions")
      .orderBy("created_at", "desc")
      .limit(500)                                                                                                     // safety ceiling
      .get();
    dcrs = snap.docs.map(d => Object.assign({ _id: d.id }, d.data() || {}))
      .filter(d => tsToMs(d.created_at) >= cutoff);
  }
  // Pre-fetch customer + payload state for each.
  const out = [];
  for (const d of dcrs) {
    const verdict = await classify(d);
    out.push({ dcr: d, verdict: verdict });
  }
  return out;
}

async function classify(dcr) {
  // Per-DCR eligibility, mirroring the Cloud Function's readiness gate
  // + the new sendNativeDcrEmailForSubmission exclusion logic. Returns
  // { eligible, reason }.
  const reasons = [];
  if (dcr.is_test || dcr.is_qa_test || dcr.exclude_from_customer_reporting === true) {
    return { eligible: false, reason: "skipped:qa_test_submission" };
  }
  // Duplicate check — dcr_email_payloads doc id = dcrId
  if (!FORCE) {
    const ep = await db.collection("dcr_email_payloads").doc(dcr._id).get();
    if (ep.exists && ep.data() && ep.data().sentAt) {
      return { eligible: false, reason: "skipped:duplicate_already_sent" };
    }
  }
  // Customer doc check
  const slug = String(dcr.customer_slug || dcr.customer_id || "").trim();
  if (!slug) return { eligible: false, reason: "skipped:no_customer_slug" };
  const cSnap = await db.collection("customers").doc(slug).get();
  if (!cSnap.exists) return { eligible: false, reason: "skipped:customer_not_found:" + slug };
  const c = cSnap.data() || {};
  if (c.is_test === true || c.exclude_from_customer_reporting === true ||
      c.disable_customer_notifications === true || c.disable_dcr_email === true) {
    return { eligible: false, reason: "skipped:customer_excluded" };
  }
  if (c.dcr_enabled === false) {
    return { eligible: false, reason: "skipped:dcr_email_disabled" };
  }
  const recipient = c.customer_email || dcr.customer_email || null;
  if (!recipient) return { eligible: false, reason: "skipped:no_recipient" };
  return { eligible: true, recipient: recipient, customerId: slug };
}

async function callSend(idToken, dcrId, customerId) {
  const r = await fetch(SEND_URL, {
    method:  "POST",
    headers: { "Authorization": "Bearer " + idToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      dcrId:        dcrId,
      customerId:   customerId,
      confirmResend: FORCE
    })
  });
  const b = await r.json().catch(() => ({}));
  return { http: r.status, body: b };
}

(async () => {
  console.log("================================================================");
  console.log("Phase 32G — backfill unsent DCR emails");
  console.log("  mode:       " + (SEND ? "SEND" : "DRY-RUN"));
  console.log("  window:     " + DAYS + " days" + (ONE_ID ? " (overridden by --dcrId)" : ""));
  console.log("  limit:      " + (LIMIT || "(none)"));
  console.log("  forceSend:  " + FORCE);
  if (ONE_ID) console.log("  --dcrId:    " + ONE_ID);
  console.log("================================================================");

  const list = await loadCandidates();
  const eligible = list.filter(x => x.verdict.eligible);
  const skipped  = list.filter(x => !x.verdict.eligible);
  console.log("\nCandidates: " + list.length + " · Eligible: " + eligible.length + " · Skipped: " + skipped.length);

  if (skipped.length) {
    console.log("\n--- Skipped (per-row reason) ---");
    skipped.forEach(x => {
      console.log("  " + x.dcr._id.padEnd(24) + " · " + (x.dcr.customer_name || "?").padEnd(28) + " · " + x.verdict.reason);
    });
  }
  if (!eligible.length) {
    console.log("\nNothing eligible. Done.");
    process.exit(0);
  }

  const queue = LIMIT ? eligible.slice(0, LIMIT) : eligible;
  console.log("\n--- Eligible (will " + (SEND ? "SEND" : "DRY-RUN") + ") ---");
  queue.forEach(x => {
    console.log("  " + x.dcr._id.padEnd(24) + " · " + (x.dcr.customer_name || "?").padEnd(28) + " → " + x.verdict.recipient);
  });
  if (!SEND) {
    console.log("\nDRY-RUN complete — re-run with --send to actually fire emails.");
    process.exit(0);
  }

  // ---- Real send leg ----
  console.log("\n--- Sending (throttled " + SEND_DELAY_MS + "ms between calls) ---");
  const idToken = await adminIdToken();
  let sent = 0, failed = 0;
  const failures = [];
  for (const x of queue) {
    const tag = x.dcr._id.padEnd(24) + " → " + x.verdict.recipient;
    process.stdout.write("  " + tag + "  ");
    try {
      const r = await callSend(idToken, x.dcr._id, x.verdict.customerId);
      if (r.http === 200 && r.body && r.body.ok && r.body.status === "sent") {
        sent++;
        console.log("✔ sent · message=" + (r.body.messageId || "?"));
      } else if (r.body && r.body.status === "skipped") {
        console.log("∅ skipped · " + (r.body.reason || JSON.stringify(r.body).slice(0,120)));
      } else {
        failed++;
        const msg = (r.body && (r.body.error || r.body.reason)) || JSON.stringify(r.body).slice(0,200);
        failures.push({ dcrId: x.dcr._id, http: r.http, msg: msg });
        console.log("✖ failed · http=" + r.http + " · " + msg);
      }
    } catch (err) {
      failed++;
      failures.push({ dcrId: x.dcr._id, msg: err.message });
      console.log("✖ threw · " + err.message);
    }
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
  }
  console.log("\n--- Summary ---");
  console.log("  Sent:    " + sent);
  console.log("  Failed:  " + failed);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach(f => console.log("  " + f.dcrId + ": " + (f.msg || "").slice(0, 200)));
  }
  process.exit(failed > 0 ? 2 : 0);
})().catch(e => { console.error("Backfill threw:", e); process.exit(1); });
