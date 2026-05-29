/* Pioneer DCR Hub — friendly Install PioneerOps UX.
 *
 * Loaded ONLY on /team-hub.html (the page that hosts the install card).
 * Adjacent pages don't need the install UI yet — Team Hub is the daily
 * landing surface for techs, so installation discovery lives there.
 *
 * Responsibilities:
 *   1. Reveal the install card when the app is INSTALLABLE and NOT yet
 *      installed. Hide it when already running standalone OR when the
 *      user clicked "Maybe Later" within the last 30 days.
 *   2. Wire the "Install App" button:
 *        • Android / Chromium with beforeinstallprompt → call promptInstall()
 *        • iOS Safari → open the "Add to Home Screen" instructions modal
 *        • Desktop → call promptInstall() if available, else open modal
 *   3. Track each event under `[PWAInstall]`:
 *        installPromptShown / installPromptAccepted / installPromptDismissed
 *
 * Depends on the PWA helper from pwa-register.js:
 *   window.PioneerPWA = { canInstall, isStandalone, isiOS, promptInstall }
 *
 * No business logic touched. No Firestore writes. localStorage holds the
 * "Maybe Later" suppression timestamp only.
 */
(function () {
  "use strict";

  const SUPPRESS_KEY     = "pioneerops_install_dismissed_at";
  const SUPPRESS_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days

  function $(id) { return document.getElementById(id); }

  function suppressedUntil() {
    try {
      const v = Number(localStorage.getItem(SUPPRESS_KEY) || 0);
      if (!v) return 0;
      return v + SUPPRESS_MS;
    } catch (_e) { return 0; }
  }
  function isSuppressed() { return Date.now() < suppressedUntil(); }
  function markDismissed() {
    try { localStorage.setItem(SUPPRESS_KEY, String(Date.now())); }
    catch (_e) {}
  }
  function clearDismissed() {
    try { localStorage.removeItem(SUPPRESS_KEY); }
    catch (_e) {}
  }

  function pwa() { return (typeof window !== "undefined") ? window.PioneerPWA : null; }
  function isStandalone() {
    const p = pwa();
    return !!(p && p.isStandalone && p.isStandalone());
  }
  function isiOS() {
    const p = pwa();
    return !!(p && p.isiOS && p.isiOS());
  }
  function canInstall() {
    const p = pwa();
    return !!(p && p.canInstall && p.canInstall());
  }

  function log(label, meta) {
    try { console.info("[PWAInstall] " + label, meta || ""); } catch (_e) {}
  }

  function showCard(reason) {
    const card = $("install-card");
    if (!card || !card.hidden) return;
    card.hidden = false;
    log("installPromptShown", { surface: "team-hub-card", reason: reason });
  }
  function hideCard(reason) {
    const card = $("install-card");
    if (!card || card.hidden) return;
    card.hidden = true;
    log("installPromptHidden", { reason: reason });
  }

  function showIosModal() {
    const modal = $("install-ios-modal");
    if (!modal) return;
    modal.hidden = false;
    log("installPromptShown", { surface: "ios-modal" });
  }
  function hideIosModal() {
    const modal = $("install-ios-modal");
    if (!modal) return;
    modal.hidden = true;
  }

  /* ---- Card visibility decision ----------------------------------- */

  function reevaluate() {
    // Hidden permanently if running standalone — they've already installed.
    if (isStandalone()) { hideCard("standalone"); return; }
    // Suppressed for 30 days after a "Maybe Later" tap.
    if (isSuppressed()) { hideCard("suppressed-30d"); return; }
    // iOS Safari never fires beforeinstallprompt — we always show the
    // card so the user can read the manual Add to Home Screen steps.
    if (isiOS()) { showCard("ios-manual"); return; }
    // Android/Chromium/Edge — show as soon as the prompt is captured.
    if (canInstall()) { showCard("can-install"); return; }
    // Otherwise: still in capture window (or browser doesn't support).
    // Stay hidden; the `pioneerops:can-install` event will re-trigger us.
  }

  /* ---- Wiring ----------------------------------------------------- */

  async function onInstallClick() {
    log("installButtonClicked", { isiOS: isiOS(), canInstall: canInstall() });
    if (isiOS()) {
      showIosModal();
      return;
    }
    const p = pwa();
    if (!p || !p.promptInstall) {
      // Fallback — no prompt available. Show the iOS-style instructions
      // (universal advice) since the user clearly wants to install.
      showIosModal();
      return;
    }
    const result = await p.promptInstall();
    if (result && result.outcome === "accepted") {
      log("installPromptAccepted", { surface: "team-hub-card" });
      clearDismissed();
      hideCard("accepted");
    } else if (result && result.outcome === "dismissed") {
      log("installPromptDismissed", { surface: "team-hub-card", source: "native-prompt" });
      // The browser's native dismiss isn't the same as the user clicking
      // Maybe Later — don't suppress for 30 days, just hide for this
      // session and let the next page load re-evaluate.
    } else if (result && !result.ok) {
      log("installPromptError", { reason: result.reason, error: result.error || null });
      // If something went wrong with the native call, fall through to
      // the instructions modal so the user still has a path forward.
      showIosModal();
    }
  }

  function onMaybeLaterClick() {
    log("installPromptDismissed", { surface: "team-hub-card", source: "maybe-later" });
    markDismissed();
    hideCard("maybe-later");
  }

  function wire() {
    const installBtn = $("install-card-install-btn");
    const laterBtn   = $("install-card-later-btn");
    if (installBtn) installBtn.addEventListener("click", onInstallClick);
    if (laterBtn)   laterBtn.addEventListener("click", onMaybeLaterClick);

    // iOS modal dismiss + backdrop tap + Escape key.
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      if (!t) return;
      if (t.closest && t.closest('[data-action="close-install-ios"]')) {
        ev.preventDefault();
        hideIosModal();
      }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") hideIosModal();
    });

    // The PWA helper dispatches this event when the Android prompt is
    // captured — re-evaluate to flip the card from hidden → visible.
    window.addEventListener("pioneerops:can-install", function () {
      reevaluate();
    });
    // After install, the helper fires `appinstalled` natively; recompute.
    window.addEventListener("appinstalled", function () {
      log("installCompleted");
      clearDismissed();
      reevaluate();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    // First decision on load. If the Android prompt isn't captured yet,
    // the listener above will flip us when it lands.
    reevaluate();
  });
})();
