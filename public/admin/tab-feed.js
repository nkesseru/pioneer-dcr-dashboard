/* Pioneer DCR Hub — Admin Operational Feed tab (vanilla JS, no build).
 *
 * Operational Feed — admin mount + demo-item buttons.
 *
 * Thin admin-side shim over `window.OpFeed` (from operational-feed.js).
 * Mounts the shared feed renderer in admin mode and wires the buried
 * "demo feed item" buttons that admins use to exercise the ack +
 * status flow end-to-end. Server-side wiring (e.g. supply request →
 * feed item) is the production path; these demo buttons just create
 * sandbox-style docs that include the admin's own uid in
 * audience_user_ids so the admin can see + ack them.
 *
 * Surface lives at window.__pioneerAdmin.tabs.feed:
 *   { init: mountOperationalFeedOnce }
 *
 * Loaded AFTER admin/_utils.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • window.OpFeed (from public/operational-feed.js — must load first)
 *   • window.firebase compat SDK (auth — for currentUser)
 *
 * No deps on __pioneerAdmin.utils or .shell beyond the standard load
 * order. No closure deps on admin.js. No cross-tab state escape.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin) {
    throw new Error("admin/tab-feed.js: __pioneerAdmin namespace missing");
  }

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  // Idempotent mount: subsequent clicks on the Feed tab do nothing.
  let opFeedMounted = false;

  function mountOperationalFeedOnce() {
    if (opFeedMounted) return;
    if (!window.OpFeed || typeof window.OpFeed.mount !== "function") {
      console.warn("[admin] OpFeed module not loaded — operational-feed.js missing?");
      return;
    }
    const u = firebase.auth().currentUser;
    if (!u) return;
    window.OpFeed.mount({
      containerId: "op-feed-list",
      mode:        "admin",
      user: {
        uid:     u.uid,
        email:   u.email || "",
        name:    u.displayName || u.email || "admin",
        isAdmin: true
      },
      filterStatus: ($("op-feed-list-filter") && $("op-feed-list-filter").value) || "open"
    });
    opFeedMounted = true;
    wireOperationalFeedDemoButtons();
  }

  // Demo buttons — admin-only test docs that include the admin's own
  // uid in audience_user_ids so the admin can exercise the ack +
  // status flow end-to-end. Server-side wiring (supply request →
  // feed item) is the production path.
  function wireOperationalFeedDemoButtons() {
    const disclosure = $("op-feed-demo-disclosure");
    if (!disclosure || disclosure.dataset.wired) return;
    disclosure.dataset.wired = "1";
    const status = $("op-feed-demo-status");
    function setStatus(msg) { if (status) status.textContent = msg; }

    disclosure.addEventListener("click", async function (ev) {
      const btn = ev.target.closest("button[data-feed-demo]");
      if (!btn) return;
      const u = firebase.auth().currentUser;
      if (!u) { setStatus("Sign in first."); return; }
      const kind = btn.dataset.feedDemo;
      const adminName = u.displayName || u.email || "admin";
      let payload = null;
      if (kind === "recognition") {
        payload = {
          type:              "recognition",
          title:              "Demo: Nice work on the Tuesday close",
          body:               "Great attention to detail in the lobby — wanted to call it out.",
          severity:           "info",
          status:             "new",
          requires_ack:       false,
          audience_roles:     ["admin", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else if (kind === "scheduler_notice") {
        payload = {
          type:              "scheduler_notice",
          title:              "Demo: Schedule swap for tomorrow",
          body:               "Heads up — Drew is covering Maks's Tuesday morning shift.",
          severity:           "important",
          status:             "new",
          requires_ack:       false,
          audience_roles:     ["admin", "scheduler", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else if (kind === "safety_alert") {
        payload = {
          type:              "safety_alert",
          title:              "Demo: Slip hazard at NOTL east wing",
          body:               "Recent floor sealant means slow drying — wear non-slip and post the cone before entry.",
          severity:           "urgent",
          status:             "new",
          requires_ack:       true,
          audience_roles:     ["admin", "tech"],
          audience_user_ids:  [u.uid],
          created_by_uid:     u.uid,
          created_by_name:    adminName
        };
      } else {
        return;
      }
      btn.disabled = true;
      setStatus("Creating…");
      const id = await window.OpFeed.adminCreate(payload);
      btn.disabled = false;
      setStatus(id ? "Created. Look for it in the feed below." : "Failed — see console for details.");
    });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.feed = {
    init: mountOperationalFeedOnce
  };
}());
