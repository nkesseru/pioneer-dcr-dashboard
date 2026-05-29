/* Pioneer DCR Hub — Admin shell (vanilla JS, no build).
 *
 * DOM-aware helpers that every admin tab depends on but that are NOT
 * tab-specific.
 *
 *   • wireTabs()                       — click-handler that toggles
 *                                        is-active / aria-selected / panel hidden
 *   • setStatus / hideAllStatuses /
 *     showFatal                        — panel-level loading/error/empty UI
 *   • badge / activeBadge /
 *     dcrEnabledBadge / dcrEmailBadge  — shared status pills
 *   • activateTab(tabKey)              — programmatic tab activation +
 *                                        on-activate-once callback dispatch
 *   • registerTabActivator(key, fn)    — admin.js (and future tab modules)
 *                                        register their lazy-load handler
 *
 * Surface lives at window.__pioneerAdmin.shell. Loaded AFTER admin/_utils.js
 * and BEFORE admin.js. admin.js destructures from this namespace at the
 * top of its IIFE.
 *
 * Constraints:
 *   • Reads escapeHtml from window.__pioneerAdmin.utils — _utils.js MUST
 *     load first.
 *   • activateTab uses a registry instead of hardcoded init calls, so the
 *     shell does not depend on any tab module. admin.js wires the current
 *     9 tab activators during boot. Future tab modules will self-register.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin/_shell.js: admin/_utils.js must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;

  /* ---------- tab wiring ---------- */

  function wireTabs() {
    const tabs = Array.from(document.querySelectorAll(".admin-tab"));
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const name = tab.dataset.tab;
        tabs.forEach(function (t) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        Array.from(document.querySelectorAll(".admin-panel")).forEach(function (p) {
          p.hidden = p.dataset.panel !== name;
        });
      });
    });
  }

  /* ---------- shared panel state UI ---------- */

  function setStatus(panelKey, state, message) {
    ["loading", "error", "empty"].forEach(function (k) {
      const el = document.getElementById(panelKey + "-" + k);
      if (el) el.hidden = k !== state;
    });
    if (state === "error" && message) {
      const errEl = document.getElementById(panelKey + "-error");
      if (errEl) errEl.textContent = message;
    }
  }

  function hideAllStatuses(panelKey) {
    ["loading", "error", "empty"].forEach(function (k) {
      const el = document.getElementById(panelKey + "-" + k);
      if (el) el.hidden = true;
    });
  }

  function showFatal(msg) {
    document.body.innerHTML =
      '<div class="admin-status admin-error" style="margin:40px auto;max-width:520px;">' +
        escapeHtml(msg) +
      '</div>';
  }

  /* ---------- badge helpers ---------- */

  function badge(cls, label) {
    return '<span class="badge ' + cls + '">' + escapeHtml(label) + '</span>';
  }
  function activeBadge(isActive)     { return isActive ? badge("is-on", "Active")      : badge("is-off", "Archived"); }
  function dcrEnabledBadge(enabled)  { return enabled  ? badge("is-on", "DCR enabled") : badge("is-off", "DCR off"); }
  // Three distinct states must be readable at a glance: Active/Archived,
  // DCR on/off (form visibility), DCR EMAIL on/off (customer-email delivery).
  // The badge label spells it out so the difference between DCR and DCR-email
  // is unambiguous to a sleep-deprived ops admin scanning the list.
  function dcrEmailBadge(enabled)    { return enabled  ? badge("is-on", "DCR email on") : badge("is-off", "DCR email off"); }

  /* ---------- programmatic tab activation + on-activate registry ----------
   * activateTab mirrors the click handler wired by wireTabs() — toggles
   * is-active + the panel hidden attribute — then dispatches an optional
   * on-activate callback registered for the tab key. Tabs that don't
   * register a callback (e.g. customers, techs, dcrs) are simple show/hide.
   *
   * Defensive null-checks so a missing tab or missing callback is a no-op.
   */
  const tabActivators = Object.create(null);

  function registerTabActivator(tabKey, fn) {
    if (!tabKey || typeof fn !== "function") return;
    tabActivators[tabKey] = fn;
  }

  function activateTab(tabKey) {
    const tabs   = document.querySelectorAll(".admin-tab[data-tab]");
    const panels = document.querySelectorAll(".admin-panel[data-panel]");
    tabs.forEach(function (t) {
      const on = (t.dataset.tab === tabKey);
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach(function (p) {
      p.hidden = (p.dataset.panel !== tabKey);
    });
    const onActivate = tabActivators[tabKey];
    if (typeof onActivate === "function") {
      try { onActivate(); }
      catch (err) { console.error("[admin shell] tab activator threw for " + tabKey, err); }
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.shell = {
    wireTabs: wireTabs,
    setStatus: setStatus,
    hideAllStatuses: hideAllStatuses,
    showFatal: showFatal,
    badge: badge,
    activeBadge: activeBadge,
    dcrEnabledBadge: dcrEnabledBadge,
    dcrEmailBadge: dcrEmailBadge,
    activateTab: activateTab,
    registerTabActivator: registerTabActivator
  };
}());
