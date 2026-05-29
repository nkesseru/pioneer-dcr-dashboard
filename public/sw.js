/* Pioneer DCR Hub — minimal service worker for PWA installability.
 *
 * Scope: V1 is INSTALLABILITY ONLY. We deliberately:
 *   • Do NOT cache HTML / JS / CSS / API responses
 *   • Do NOT cache authenticated pages (Firebase Auth, work sessions, DCRs)
 *   • Do NOT serve any stale content
 *
 * Why so conservative:
 *   • DCR submit, Start/Finish Work, Storage uploads, and admin writes
 *     all run live against Firebase. Any stale cached response would
 *     silently break those flows.
 *   • Firebase Auth tokens refresh on a strict schedule — caching can
 *     hand out stale tokens and 401 every request.
 *   • The app is online-first by design (field techs always have
 *     coverage). Offline-first caching is a separate, deliberate
 *     project (Phase 2 — would need write queueing for DCR submits).
 *
 * What this does:
 *   1. Installs and takes control on the next page load.
 *   2. Passes every fetch through to the network unchanged. The mere
 *      presence of a `fetch` listener satisfies older PWA installability
 *      heuristics on Chromium without altering behavior.
 *   3. Lets the browser handle its own HTTP caching headers (no-cache
 *      already set in firebase.json for .html / .js / .css).
 *
 * Update strategy:
 *   • `skipWaiting()` on install + `clients.claim()` on activate so a
 *     code change picks up on the next navigation (no "shift-reload"
 *     ritual). The version string below is bumped when this file
 *     changes so installed PWAs detect the new SW.
 */

const SW_VERSION = "20260528-pwa-v1";

self.addEventListener("install", function (event) {
  // Take over old SWs without waiting for tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  // Become the controller for ALL clients immediately. Any open tab
  // becomes governed by this SW without a reload.
  event.waitUntil(self.clients.claim());
});

// Passthrough fetch — satisfies installability without affecting behavior.
// We intentionally do NOT call respondWith with a cached value.
self.addEventListener("fetch", function (_event) { /* default network handling */ });

// Optional: respond to a "skip waiting" message from the page so a new
// SW activates immediately without a manual page reload. Used by
// pwa-register.js when it detects a waiting worker.
self.addEventListener("message", function (event) {
  if (event && event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
