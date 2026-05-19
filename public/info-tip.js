/* Pioneer DCR Hub — shared score-explanation tooltip controller.
 *
 * Drops a small ⓘ button next to any element that needs explaining
 * and renders a click/tap-toggled popover with the explanation. Lives
 * as a shared shim so every page (Customer Info Hub, Inspection Hub,
 * Team Hub, Admin) can use the same affordance without re-writing.
 *
 * Usage — HTML:
 *   <button type="button" class="info-tip"
 *           aria-label="About this score"
 *           data-info-tip="Customer Health is based on …">ⓘ</button>
 *
 * Behavior:
 *   • Click / tap the button → toggle the popover next to it.
 *   • Click outside → all popovers close.
 *   • Escape → all popovers close.
 *   • Only one popover open at a time (toggling one closes the rest).
 *   • The popover element is appended to <body> with absolute
 *     positioning calculated against the trigger's bounding rect, so
 *     parent overflow / transform contexts don't clip it.
 *
 * The CSS lives in styles.css under "Score-explanation tooltips".
 */
(function () {
  "use strict";

  let popover = null;       // singleton popover DOM node (lazy-created)
  let openFor = null;       // the trigger element the popover is currently bound to
  let positionRaf = 0;      // requestAnimationFrame handle for scroll/resize repositioning

  function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement("div");
    popover.className = "info-tip-popover";
    popover.setAttribute("role", "tooltip");
    popover.hidden = true;
    document.body.appendChild(popover);
    return popover;
  }

  function close() {
    if (!popover) return;
    popover.hidden = true;
    popover.textContent = "";
    if (openFor) openFor.setAttribute("aria-expanded", "false");
    openFor = null;
  }

  function positionTo(trigger) {
    if (!popover || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Show popover BELOW the trigger by default. If we'd overflow the
    // viewport bottom, flip to ABOVE.
    const popRect = popover.getBoundingClientRect();
    const margin = 6;
    let top  = rect.bottom + margin;
    if (top + popRect.height + 8 > window.innerHeight) {
      top = Math.max(8, rect.top - popRect.height - margin);
    }
    // Horizontally: prefer the trigger's left edge, but clamp to the
    // viewport so the popover never escapes.
    const desiredLeft = rect.left;
    const maxLeft = window.innerWidth - popRect.width - 8;
    const left = Math.max(8, Math.min(maxLeft, desiredLeft));
    popover.style.top  = (top + window.scrollY) + "px";
    popover.style.left = (left + window.scrollX) + "px";
  }

  function open(trigger) {
    const text = trigger.getAttribute("data-info-tip") || "";
    if (!text) return;
    ensurePopover();
    popover.textContent = text;
    popover.hidden = false;
    openFor = trigger;
    trigger.setAttribute("aria-expanded", "true");
    // Position after layout settles.
    requestAnimationFrame(function () { positionTo(trigger); });
  }

  function toggle(trigger) {
    if (openFor === trigger && popover && !popover.hidden) {
      close();
    } else {
      open(trigger);
    }
  }

  function init() {
    // Global click delegator. Triggers carry `.info-tip`. Outside-clicks
    // (anything not the trigger or the popover) close.
    document.addEventListener("click", function (ev) {
      const trigger = ev.target.closest && ev.target.closest(".info-tip");
      if (trigger) {
        ev.preventDefault();
        ev.stopPropagation();
        toggle(trigger);
        return;
      }
      // Inside the popover? leave alone.
      if (popover && popover.contains(ev.target)) return;
      close();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") close();
    });
    // Repositioning on scroll / resize while open — throttled via rAF.
    function bumpReposition() {
      if (!openFor || !popover || popover.hidden) return;
      if (positionRaf) cancelAnimationFrame(positionRaf);
      positionRaf = requestAnimationFrame(function () {
        if (openFor) positionTo(openFor);
      });
    }
    window.addEventListener("scroll", bumpReposition, { passive: true });
    window.addEventListener("resize", bumpReposition);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose a tiny helper for callers who want to inject tooltips on
  // dynamically-rendered cards: just set data-info-tip on the trigger
  // and the global delegator handles the rest.
  window.PIONEER_INFO_TIP = { close: close };
})();
