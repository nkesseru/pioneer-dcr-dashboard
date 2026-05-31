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

  /* ---------- modal + toast helpers ----------
   * openModal / closeModal manage the .admin-modal overflow lock + aria
   * state. showToast appends a transient toast that auto-removes after
   * 3.5s. All three are pure-DOM — no Firebase, no closure deps. Used
   * by 15 + 15 + 77 call sites across admin.js as of Phase 6a; moved
   * here so the per-tab extractions in Phase 6b+ can import them
   * without staying coupled to admin.js's IIFE.
   */
  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Focus the first text-like input for keyboard ergonomics.
    const firstInput = el.querySelector('input[type="text"], input[type="email"], input[type="url"], input[type="tel"], textarea');
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 60);
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    const errEl = el.querySelector(".admin-modal-err");
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
  }

  function showToast(kind, msg) {
    const root = document.getElementById("toast-container");
    if (!root) return;
    const t = document.createElement("div");
    t.className = "toast toast-" + kind;
    t.textContent = msg;
    root.appendChild(t);
    // Next-frame class flip so the CSS transition fires.
    requestAnimationFrame(function () { t.classList.add("is-shown"); });
    setTimeout(function () {
      t.classList.remove("is-shown");
      setTimeout(function () { t.remove(); }, 320);
    }, 3500);
  }

  /* ---------- write helpers + per-modal save state ----------
   * MODAL_REGISTRY: per-modal save-button + error-element IDs.
   * setModalSaving / setModalError: generic helpers that read the
   *   registry and flip the matching DOM. Used by every tab that
   *   owns an admin-modal save flow.
   * handleAdminWriteError: centralized error formatter for Firestore
   *   writes — logs full error + friendly message + toast.
   * getCurrentAdminEmail: identity helper for updated_by stamps.
   * Moved here in Phase 25a so tab modules can read them from
   * window.__pioneerAdmin.shell directly instead of via the deps
   * bridge. Adding a modal? Add an entry below and the helpers work
   * without further branching.
   */
  const MODAL_REGISTRY = {
    "customer-edit-modal":      { saveBtnId: "customer-edit-save",      errId: "customer-edit-err",      savingLabel: "Saving…",   defaultLabel: "Save" },
    "tech-edit-modal":          { saveBtnId: "tech-edit-save",          errId: "tech-edit-err",          savingLabel: "Saving…",   defaultLabel: "Save" },
    "tech-create-modal":        { saveBtnId: "tech-create-save",        errId: "tech-create-err",        savingLabel: "Creating…", defaultLabel: "Create login" },
    "announcement-edit-modal":  { saveBtnId: "announcement-edit-save",  errId: "announcement-edit-err",  savingLabel: "Saving…",   defaultLabel: "Save" },
    "admin-create-modal":       { saveBtnId: "admin-create-save",       errId: "admin-create-err",       savingLabel: "Creating…", defaultLabel: "Create admin login" },
    "admin-edit-modal":         { saveBtnId: "admin-edit-save",         errId: "admin-edit-err",         savingLabel: "Saving…",   defaultLabel: "Save changes" },
    "note-edit-modal":          { saveBtnId: "note-edit-save",          errId: "note-edit-err",          savingLabel: "Saving…",   defaultLabel: "Save" },
    "suggestion-review-modal":  { saveBtnId: "suggestion-approve",      errId: "suggestion-review-err",  savingLabel: "Saving…",   defaultLabel: "Approve" },
    "recovery-edit-modal":      { saveBtnId: "recovery-edit-save",      errId: "recovery-edit-err",      savingLabel: "Saving…",   defaultLabel: "Save" }
  };

  function setModalSaving(modalId, saving) {
    const reg = MODAL_REGISTRY[modalId];
    if (!reg) return;
    const btn = document.getElementById(reg.saveBtnId);
    if (!btn) return;
    btn.disabled = saving;
    btn.textContent = saving ? reg.savingLabel : reg.defaultLabel;
  }

  function setModalError(modalId, msg) {
    const reg = MODAL_REGISTRY[modalId];
    if (!reg) return;
    const errEl = document.getElementById(reg.errId);
    if (!errEl) return;
    if (msg) { errEl.textContent = msg; errEl.hidden = false; }
    else     { errEl.hidden = true; errEl.textContent = ""; }
  }

  function handleAdminWriteError(err, opts) {
    opts = opts || {};
    const code    = (err && err.code)    || "";
    const message = (err && err.message) || (err && String(err)) || "Unknown error";

    console.error("[admin write failed]", opts.context || "", err);
    if (code)    console.error("  • Firebase code:   ", code);
    if (message) console.error("  • Firebase message:", message);

    let friendly = message;
    if (code === "permission-denied") {
      friendly =
        "Permission denied. Two common causes:\n" +
        "  1. firestore.rules wasn't redeployed since the admin-write rules " +
        "were added. Run `firebase deploy --only firestore:rules`.\n" +
        "  2. Your signed-in email isn't on the allowlist in " +
        "isPioneerAdmin() inside firestore.rules.";
    } else if (code === "not-found") {
      friendly = "Doc not found — refresh the page and try again.";
    } else if (code === "unauthenticated") {
      friendly = "Sign-in expired — sign out and back in.";
    } else if (code === "failed-precondition") {
      friendly = "Save rejected: " + message + " (Firestore: " + code + ").";
    }

    if (opts.modalId) setModalError(opts.modalId, friendly);
    showToast("err", "Save failed" + (code ? " — " + code : "") + ". See console for details.");
    return friendly;
  }

  function getCurrentAdminEmail() {
    if (!window.firebase || typeof firebase.auth !== "function") return "unknown";
    const u = firebase.auth().currentUser;
    return (u && u.email) || "unknown";
  }

  /* copyInputValue — write the value of an <input> to the clipboard,
   * with a "Copied!" label flash on the trigger button. Falls back to
   * input.select + execCommand("copy") for browsers without the
   * Clipboard API. */
  async function copyInputValue(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn   = document.getElementById(btnId);
    if (!input) return;
    const val = input.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(val);
      } else {
        input.focus();
        input.select();
        document.execCommand && document.execCommand("copy");
      }
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = orig; }, 1500);
      }
    } catch (e) {
      console.warn("clipboard write failed", e);
      input.focus(); input.select();
    }
  }

  /* installModalCloseAffordances — wire backdrop / X / Cancel close
   * buttons (anything [data-modal-close] inside .admin-modal) plus an
   * Escape-to-close handler for the three core editor modals (customer
   * edit, tech edit, tech create). Other modals close via [data-modal-close]
   * exclusively — matches the original admin.js Esc behavior exactly. */
  function installModalCloseAffordances() {
    Array.from(document.querySelectorAll("[data-modal-close]")).forEach(function (el) {
      el.addEventListener("click", function () {
        const modal = el.closest(".admin-modal");
        if (modal) closeModal(modal.id);
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!document.getElementById("customer-edit-modal").hidden) closeModal("customer-edit-modal");
      if (!document.getElementById("tech-edit-modal").hidden)     closeModal("tech-edit-modal");
      if (!document.getElementById("tech-create-modal").hidden)   closeModal("tech-create-modal");
    });
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
    openModal: openModal,
    closeModal: closeModal,
    showToast: showToast,
    badge: badge,
    activeBadge: activeBadge,
    dcrEnabledBadge: dcrEnabledBadge,
    dcrEmailBadge: dcrEmailBadge,
    activateTab: activateTab,
    registerTabActivator: registerTabActivator,
    setModalSaving: setModalSaving,
    setModalError: setModalError,
    handleAdminWriteError: handleAdminWriteError,
    getCurrentAdminEmail: getCurrentAdminEmail,
    copyInputValue: copyInputValue,
    installModalCloseAffordances: installModalCloseAffordances
  };
}());
