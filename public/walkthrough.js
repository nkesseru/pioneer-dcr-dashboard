/* Pioneer DCR Hub — pilot walkthrough modal.
 *
 * Auto-pops a one-time "Welcome to PioneerOps" modal the first time a
 * staff member signs in to any of the staff pages that load this
 * script (tech.html, work.html, team-hub.html, supply-station.html).
 * After the user clicks "Got it", a versioned localStorage flag
 * (`pioneer_walkthrough_seen_v1`) prevents re-pop. Bumping the
 * version below forces every user to re-see it (use sparingly).
 *
 * Public API:
 *   window.PIONEER_WALKTHROUGH.showIfFirstTime()   — auto-pop logic
 *   window.PIONEER_WALKTHROUGH.showNow()           — manual re-open
 *
 * Wire-in: every page loads this script. On boot the module hooks
 * itself into STAFF_AUTH.init() via a thin wrapper. If a page never
 * signs the user in (e.g. denied state) the modal never appears.
 *
 * Visual: dark glassy card with seven highlighted feature rows. Single
 * "Got it" button. Mobile-friendly. Esc + backdrop click also dismiss.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "pioneer_walkthrough_seen_v1";

  // The seven pilot features. Emoji + label + one-line description.
  // Order is the order they render. Keep copy short — this is a
  // glanceable overview, not documentation.
  const FEATURES = [
    { icon: "📅", title: "Today's Work",  body: "Your scheduled shifts for today. One step at a time." },
    { icon: "▶️", title: "Start Work",    body: "Tap once to begin. Deputy opens in another tab for clock-in." },
    { icon: "📝", title: "DCR",           body: "Daily Clean Report — your notes, supplies, photos. Saved instantly." },
    { icon: "📌", title: "Customer Notes",body: "Standing instructions for each location. See or suggest updates." },
    { icon: "🔍", title: "Inspections",   body: "Quality audits. Admin-led for now — wins celebrated on Team Hub." },
    { icon: "📣", title: "Announcements", body: "Office posts to the whole team. Mandatory items show a blocking modal." },
    { icon: "🧴", title: "Supplies",      body: "Submit a supply order from the Supply Station page anytime." }
  ];

  function shown() {
    try { return !!localStorage.getItem(STORAGE_KEY); }
    catch (e) { return false; }
  }
  function markShown() {
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()); }
    catch (e) { /* storage disabled — modal just shows again next time */ }
  }

  function ensureRoot() {
    let root = document.getElementById("pioneer-walkthrough-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "pioneer-walkthrough-root";
    root.className = "pw-root";
    root.setAttribute("hidden", "");
    root.innerHTML =
      '<div class="pw-backdrop" data-pw-close></div>' +
      '<div class="pw-dialog" role="dialog" aria-modal="true" aria-labelledby="pw-title">' +
        '<div class="pw-glow" aria-hidden="true"></div>' +
        '<header class="pw-head">' +
          '<span class="pw-eyebrow">Welcome to PioneerOps</span>' +
          '<h2 id="pw-title" class="pw-title">Here\'s what\'s new</h2>' +
          '<p class="pw-sub">Pioneer Commercial Cleaning\'s new operational app. Quick tour:</p>' +
        '</header>' +
        '<ul class="pw-list">' +
          FEATURES.map(function (f) {
            return (
              '<li class="pw-item">' +
                '<span class="pw-item-icon" aria-hidden="true">' + f.icon + '</span>' +
                '<div class="pw-item-text">' +
                  '<span class="pw-item-title">' + f.title + '</span>' +
                  '<span class="pw-item-body">' + f.body + '</span>' +
                '</div>' +
              '</li>'
            );
          }).join("") +
        '</ul>' +
        '<footer class="pw-foot">' +
          '<button type="button" class="pw-close-btn" data-pw-close>Got it</button>' +
        '</footer>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-pw-close]")) close();
    });
    return root;
  }

  function open() {
    const root = ensureRoot();
    root.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function close() {
    const root = document.getElementById("pioneer-walkthrough-root");
    if (root) root.hidden = true;
    document.body.style.overflow = "";
    markShown();
  }

  function showIfFirstTime() {
    if (shown()) return;
    // Defer a beat so the rest of the page paints first — feels less
    // intrusive than landing straight into the modal.
    setTimeout(open, 350);
  }
  function showNow() { open(); }

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    const root = document.getElementById("pioneer-walkthrough-root");
    if (root && !root.hidden) close();
  });

  // Auto-hook into STAFF_AUTH. If the page never authorizes anyone
  // (sign-in denied / signed out), the modal never appears. We wrap
  // the original init so the host page's onAuthorized still runs.
  function autoHook() {
    if (!window.STAFF_AUTH || typeof window.STAFF_AUTH.init !== "function") return;
    if (window.STAFF_AUTH.__pwHooked) return;          // idempotent
    const origInit = window.STAFF_AUTH.init.bind(window.STAFF_AUTH);
    window.STAFF_AUTH.__pwHooked = true;
    window.STAFF_AUTH.init = function (opts) {
      const wrappedOpts = Object.assign({}, opts || {});
      const userOnAuth = wrappedOpts.onAuthorized;
      wrappedOpts.onAuthorized = function (staff) {
        try { if (userOnAuth) userOnAuth(staff); }
        finally { showIfFirstTime(); }
      };
      return origInit(wrappedOpts);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoHook);
  } else {
    autoHook();
  }

  window.PIONEER_WALKTHROUGH = { showIfFirstTime: showIfFirstTime, showNow: showNow };
})();
