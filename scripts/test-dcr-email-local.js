#!/usr/bin/env node
/* ============================================================================
 * test-dcr-email-local.js — local DCR email QA loop
 *
 * One command: `npm run test:dcr-email`
 *
 * What it does:
 *   • Initialises Firebase Admin SDK with the developer's local
 *     serviceAccountKey.json (or Application Default Credentials).
 *   • Resolves OPENAI_API_KEY / GMAIL_SENDER_EMAIL / GMAIL_SERVICE_ACCOUNT_KEY
 *     via (in priority order):
 *         1. `.secrets.local.json` at the repo root          (offline-friendly)
 *         2. `firebase functions:secrets:access`             (zero-setup path)
 *         3. process.env.<NAME>                              (CI / shell)
 *   • Calls `functions/dcrEmail.js → sendDcrEmailCore` directly.
 *     This is the SAME core the production Cloud Function calls; the
 *     only difference is no admin-token auth gate (because the script
 *     authenticates as Firebase Admin SDK, not as a web user).
 *
 * Production security is preserved:
 *   • The Cloud Function (generateAndSendDcrEmailV1) is still admin-
 *     auth-token gated.
 *   • This script targets a hard-coded allowlist of one DCR + one
 *     customer + one recipient. Anything else exits non-zero.
 *   • Subject prefix is "[LOCAL TEST]" so production audits can tell
 *     local sends apart from real customer sends.
 *
 * If you don't want the script pulling secrets via the firebase CLI
 * (or you're offline), create `.secrets.local.json` at the repo root:
 *
 *     {
 *       "OPENAI_API_KEY": "sk-...",
 *       "GMAIL_SENDER_EMAIL": "info@pioneercomclean.com",
 *       "GMAIL_SERVICE_ACCOUNT_KEY": { ...workspace SA JSON object... }
 *     }
 *
 * That file is .gitignored. Never commit it.
 * ========================================================================== */

'use strict';

const path        = require('path');
const fs          = require('fs');
const { execFileSync } = require('child_process');
const admin       = require('firebase-admin');

// ---- Hard allowlist --------------------------------------------------------
// Local test runs may target ONLY one of these fixtures. The recipient
// is locked to nick@ across all fixtures — the security boundary is
// "no random customer ever gets a local-machine send". The dcrId +
// customerId can vary across test fixtures (acme-dental for the
// legacy minimal case, pioneer-rich-test for the V5-rich case
// seeded by scripts/seed-rich-dcr-email-test.js).
//
// Env-var overrides (DCR_ID / CUSTOMER_ID / TEST_RECIPIENT) pick the
// fixture; anything that doesn't match a fixture row is rejected.
const ALLOWED_FIXTURES = [
  // Legacy fixture — first real DCR, sparse data, useful for fallback testing.
  {
    dcrId:      'mp00xeh7-wum68l',
    customerId: 'acme-dental',
    recipient:  'nick@pioneercomclean.com',
    label:      'acme-dental (legacy minimal)'
  },
  // Rich fixture — seeded by scripts/seed-rich-dcr-email-test.js. Exercises
  // every V5 trust-loop signal (Streak, Tasks, Issues, On-site, real
  // tech photo, visit-specific signature, photo zone+timestamp captions).
  {
    dcrId:      'test-rich-dcr-nick',
    customerId: 'pioneer-commercial-cleaning-test',
    recipient:  'nick@pioneercomclean.com',
    label:      'pioneer-rich-test (full V5 fixture)'
  }
];

// Pick a fixture from env vars. When no env vars are set, defaults to
// the first (acme-dental, for back-compat with the original
// `npm run test:dcr-email`). When env vars ARE set, they MUST match
// a fixture row exactly — otherwise the run is rejected so a typo
// can't accidentally email an arbitrary address.
function resolveFixture() {
  const env = {
    dcrId:      String(process.env.DCR_ID         || '').trim(),
    customerId: String(process.env.CUSTOMER_ID    || '').trim(),
    recipient:  String(process.env.TEST_RECIPIENT || '').trim().toLowerCase()
  };
  const noOverride = !env.dcrId && !env.customerId && !env.recipient;
  if (noOverride) return ALLOWED_FIXTURES[0];

  const match = ALLOWED_FIXTURES.find(function (f) {
    return (!env.dcrId      || f.dcrId      === env.dcrId)
        && (!env.customerId || f.customerId === env.customerId)
        && (!env.recipient  || f.recipient.toLowerCase() === env.recipient);
  });
  if (!match) {
    console.error('✗ DCR_ID / CUSTOMER_ID / TEST_RECIPIENT do not match any allowed fixture.');
    console.error('  Requested: ' + JSON.stringify(env));
    console.error('  Allowed fixtures:');
    ALLOWED_FIXTURES.forEach(function (f) {
      console.error('    • ' + f.label + '  ' + JSON.stringify({
        dcrId: f.dcrId, customerId: f.customerId, recipient: f.recipient
      }));
    });
    process.exit(2);
  }
  return match;
}
const ALLOW = resolveFixture();

const PROJECT_ID     = 'pioneer-dcr-hub';
const STORAGE_BUCKET = 'pioneer-dcr-hub.firebasestorage.app';
const REPO_ROOT      = path.resolve(__dirname, '..');
const LOCAL_SECRETS  = path.join(REPO_ROOT, '.secrets.local.json');
const SA_KEY         = path.join(REPO_ROOT, 'serviceAccountKey.json');
const SUBJECT_PREFIX = '[LOCAL TEST]';

// ---- Logger that matches firebase-functions/logger shape ------------------
// The shared core calls logger.info / .warn / .error; we proxy to console
// so the local run streams what Cloud Logging would otherwise capture.
const logger = {
  info:  function (msg, meta) { console.log('ℹ',  msg, meta != null ? JSON.stringify(meta) : ''); },
  warn:  function (msg, meta) { console.warn('⚠', msg, meta != null ? JSON.stringify(meta) : ''); },
  error: function (msg, meta) { console.error('✗', msg, meta != null ? JSON.stringify(meta) : ''); }
};

// ---- Admin SDK init -------------------------------------------------------
// Prefer the local serviceAccountKey when present (covered by the existing
// .gitignore rules). Falls back to Application Default Credentials (e.g.
// after `gcloud auth application-default login`).
function initAdmin() {
  if (admin.apps.length) return;
  if (fs.existsSync(SA_KEY)) {
    admin.initializeApp({
      credential:    admin.credential.cert(require(SA_KEY)),
      projectId:     PROJECT_ID,
      storageBucket: STORAGE_BUCKET
    });
    return 'serviceAccountKey.json';
  }
  admin.initializeApp({
    credential:    admin.credential.applicationDefault(),
    projectId:     PROJECT_ID,
    storageBucket: STORAGE_BUCKET
  });
  return 'ADC';
}

// ---- Secret resolution -----------------------------------------------------
function loadLocalSecretsFile() {
  if (!fs.existsSync(LOCAL_SECRETS)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCAL_SECRETS, 'utf8')) || {};
  } catch (e) {
    console.error('✗ Failed to parse .secrets.local.json:', e.message);
    process.exit(2);
  }
}

// Shell out to the Firebase CLI. Returns the secret value as a string
// (trimmed of trailing newline), or "" on failure.
function firebaseSecretAccess(name) {
  try {
    const out = execFileSync('firebase', ['functions:secrets:access', name, '--project', PROJECT_ID], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    return String(out || '').replace(/\r?\n$/, '');
  } catch (_e) {
    return '';
  }
}

// Resolve a single secret across all three sources. The .secrets.local.json
// path can carry JSON objects (for GMAIL_SERVICE_ACCOUNT_KEY) AND strings;
// the CLI + env paths always return strings. The caller decides how to
// interpret the string (sendDcrEmailCore parses JSON-shaped strings for
// the Gmail key).
function resolveSecret(name, localFile) {
  if (localFile && Object.prototype.hasOwnProperty.call(localFile, name)) {
    const v = localFile[name];
    if (typeof v === 'string') return { value: v, source: '.secrets.local.json' };
    if (v && typeof v === 'object') return { value: JSON.stringify(v), source: '.secrets.local.json' };
  }
  const fromCli = firebaseSecretAccess(name);
  if (fromCli) return { value: fromCli, source: 'firebase functions:secrets:access' };
  const fromEnv = process.env[name];
  if (fromEnv) return { value: fromEnv, source: 'process.env' };
  return { value: '', source: 'unresolved' };
}

// ---- Main -----------------------------------------------------------------
async function main() {
  console.log('================================================================');
  console.log(' Pioneer DCR email — LOCAL TEST loop');
  console.log('================================================================');
  console.log(' Project:    ', PROJECT_ID);
  console.log(' Fixture:    ', ALLOW.label || '(unnamed)');
  console.log(' DCR ID:     ', ALLOW.dcrId);
  console.log(' Customer:   ', ALLOW.customerId);
  console.log(' Recipient:  ', ALLOW.recipient);
  console.log(' Subject tag:', SUBJECT_PREFIX);
  console.log('----------------------------------------------------------------');

  const authVia = initAdmin();
  console.log(' Admin SDK:  ', authVia);

  const localFile = loadLocalSecretsFile();
  if (Object.keys(localFile).length) {
    console.log(' Local file: ', '.secrets.local.json (' + Object.keys(localFile).length + ' keys)');
  }

  console.log(' Resolving secrets (may take a few seconds via firebase CLI)…');
  const openai = resolveSecret('OPENAI_API_KEY', localFile);
  const sender = resolveSecret('GMAIL_SENDER_EMAIL', localFile);
  const saKey  = resolveSecret('GMAIL_SERVICE_ACCOUNT_KEY', localFile);

  // Report sources WITHOUT printing values.
  console.log('   OPENAI_API_KEY            →', openai.source);
  console.log('   GMAIL_SENDER_EMAIL        →', sender.source);
  console.log('   GMAIL_SERVICE_ACCOUNT_KEY →', saKey.source);
  const missing = [
    !openai.value && 'OPENAI_API_KEY',
    !sender.value && 'GMAIL_SENDER_EMAIL',
    !saKey.value  && 'GMAIL_SERVICE_ACCOUNT_KEY'
  ].filter(Boolean);
  if (missing.length) {
    console.error('');
    console.error('✗ Missing secret(s): ' + missing.join(', '));
    console.error('  Either:');
    console.error('    • run `firebase login` (CLI path will resolve them automatically), OR');
    console.error('    • create .secrets.local.json at the repo root with these keys.');
    process.exit(2);
  }

  console.log('----------------------------------------------------------------');
  console.log(' Calling sendDcrEmailCore…');
  const dcrEmail = require(path.join(REPO_ROOT, 'functions', 'dcrEmail'));
  const db = admin.firestore();

  let result;
  try {
    result = await dcrEmail.sendDcrEmailCore({
      admin:                  admin,
      db:                     db,
      logger:                 logger,
      dcrId:                  ALLOW.dcrId,
      customerId:             ALLOW.customerId,
      testRecipientEmail:     ALLOW.recipient,
      subjectPrefix:          SUBJECT_PREFIX,
      openaiApiKey:           openai.value,
      gmailSenderEmail:       sender.value,
      gmailServiceAccountKey: saKey.value
    });
  } catch (err) {
    console.error('');
    console.error('✗ sendDcrEmailCore threw:', err && (err.stack || err.message || err));
    process.exit(1);
  }

  console.log('----------------------------------------------------------------');
  console.log(' Result');
  console.log('   ok:            ', result.ok);
  console.log('   status:        ', result.status || '(none)');
  console.log('   subject:       ', result.subject || '(none)');
  console.log('   messageId:     ', result.messageId || '(none)');
  console.log('   promptVersion: ', result.promptVersion || '(none)');
  console.log('   emailTemplate: ', result.emailTemplate || '(none)');
  if (result.code) console.log('   code:          ', result.code);
  if (result.error) console.log('   error:         ', result.error);
  if (result.diagnostics) {
    console.log('   diagnostics:   ', JSON.stringify(result.diagnostics, null, 2));
  }
  console.log('================================================================');

  process.exit(result.ok ? 0 : 1);
}

main().catch(function (err) {
  console.error('fatal:', err && (err.stack || err.message || err));
  process.exit(1);
});
