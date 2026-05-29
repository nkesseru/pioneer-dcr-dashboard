/* Pioneer DCR Hub — Service-worker registration + install-prompt helper.
 *
 * Loaded on every PioneerOps HTML entry point. Idempotent — calling
 * register twice is a no-op.
 *
 * Behavior:
 *   1. Registers /sw.js with scope "/" when serviceWorker is supported
 *      AND we're on a secure context (HTTPS or localhost).
 *   2. Listens for the Android/Chrome `beforeinstallprompt` event so we
 *      can show a non-blocking "Install PioneerOps" affordance later.
 *      The event is captured; UI surfacing is deliberately deferred
 *      (V1 only enables installability, doesn't push an install dialog).
 *   3. Exposes a tiny API on `window.PioneerPWA` for the optional
 *      install-prompt button: `.canInstall()`, `.promptInstall()`,
 *      `.isStandalone()`, `.isiOS()`.
 *
 * Deliberately NOT done in V1:
 *   • Auto-popping the Android install prompt — that's spammy and the
 *     Play Store rates it down.
 *   • Showing iOS "Add to Home Screen" instructions automatically.
 *     We surface a helper API; pages can opt in to show a banner.
 *   • Any background sync / push notifications — separate project.
 */
(function () {
  "use strict";

  let deferredInstallEvent = null;

  function isSecureContext() {
    return (typeof window !== "undefined") && (
      window.isSecureContext === true ||
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1"
    );
  }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      if (navigator.standalone === true) return true;     // iOS Safari
    } catch (_e) {}
    return false;
  }

  function isiOS() {
    try {
      const ua = navigator.userAgent || "";
      return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    } catch (_e) { return false; }
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (!isSecureContext()) return;
    // Don't fight HMR / dev servers — but in this project there is none,
    // so just register against the static file at /sw.js.
    navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then(function (reg) {
        try { console.info("[PWA] service worker registered", reg && reg.scope); } catch (_e) {}
        if (reg && reg.waiting) {
          // A new SW already waiting — activate it on the next nav so
          // updates take effect without a hard reload.
          try { reg.waiting.postMessage({ type: "SKIP_WAITING" }); } catch (_e) {}
        }
        // On a future update, also nudge the new worker to activate.
        if (reg) {
          reg.addEventListener && reg.addEventListener("updatefound", function () {
            const next = reg.installing;
            if (!next) return;
            next.addEventListener("statechange", function () {
              if (next.state === "installed" && navigator.serviceWorker.controller) {
                try { next.postMessage({ type: "SKIP_WAITING" }); } catch (_e) {}
              }
            });
          });
        }
      })
      .catch(function (err) {
        try { console.warn("[PWA] service worker registration failed", err); } catch (_e) {}
      });
  }

  // Android/Chrome — capture the install event so the page can prompt
  // when the user has clearly opted in (e.g. tapped a small "Install"
  // button). Browsers reject any auto-prompt as spammy.
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallEvent = event;
    try { console.info("[PWA] beforeinstallprompt captured"); } catch (_e) {}
    // Page can listen for this custom event to reveal an install button.
    try {
      window.dispatchEvent(new CustomEvent("pioneerops:can-install"));
    } catch (_e) {}
  });

  window.addEventListener("appinstalled", function () {
    deferredInstallEvent = null;
    try { console.info("[PWA] app installed"); } catch (_e) {}
  });

  window.PioneerPWA = {
    canInstall:     function () { return !!deferredInstallEvent; },
    isStandalone:   isStandalone,
    isiOS:          isiOS,
    promptInstall:  async function () {
      if (!deferredInstallEvent) return { ok: false, reason: "no-prompt" };
      try {
        deferredInstallEvent.prompt();
        const choice = await deferredInstallEvent.userChoice;
        deferredInstallEvent = null;
        return { ok: true, outcome: (choice && choice.outcome) || "unknown" };
      } catch (e) {
        return { ok: false, reason: "throw", error: (e && e.message) || String(e) };
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", registerSW);
  } else {
    registerSW();
  }
})();
