/* ====================================================================
 * operational-feed.js — shared renderer for /operational_feed cards.
 *
 * Phase 1 surfaces: admin "Feed" tab + (planned) team-hub feed section.
 * Both load this module and call OpFeed.mount({ containerId, mode })
 * where mode ∈ { "admin", "tech" }.
 *
 * Access:
 *   • firestore.rules gates reads to isPioneerAdmin() OR uid ∈
 *     audience_user_ids. The same rule gates the "ack + status" update.
 *   • Admins see everything; non-admins see only their own audience.
 *
 * Friendly tone (per spec):
 *   "I'm on it" / "Got it" / "All set" / "Waiting on something".
 *   No sterile UI labels like "ticket updated" or "processed".
 * ================================================================== */
(function () {
  "use strict";

  // ---------- constants ----------
  const COLL = "operational_feed";

  const TYPE_LABEL = {
    announcement:     "Announcement",
    issue:            "Issue",
    shift_note:       "Shift note",
    inspection_note:  "Inspection note",
    recognition:      "Recognition",
    safety_alert:     "Safety alert",
    scheduler_notice: "Scheduler",
    hiring_notice:    "Hiring",
    training_update:  "Training",
    policy_update:    "Policy"
  };

  const SEVERITY_LABEL = {
    info:      "Info",
    important: "Important",
    urgent:    "Urgent"
  };

  const STATUS_LABEL = {
    new:       "New",
    seen:      "Seen",
    im_on_it:  "I'm on it",
    waiting:   "Waiting on something",
    resolved:  "All set",
    archived:  "Archived"
  };

  // Friendly action labels keyed off (currentStatus, action).
  function actionLabel(action) {
    if (action === "ack")           return "Got it";
    if (action === "im_on_it")      return "I'm on it";
    if (action === "waiting")       return "Waiting on something";
    if (action === "resolve")       return "All set";
    if (action === "archive")       return "Archive";
    return action;
  }

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, opts, children) {
    const n = document.createElement(tag);
    if (opts) {
      if (opts.className) n.className = opts.className;
      if (opts.text)      n.textContent = opts.text;
      if (opts.html)      n.innerHTML = opts.html;
      if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) {
        n.setAttribute(k, opts.attrs[k]);
      });
    }
    if (Array.isArray(children)) children.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtWhen(ts) {
    if (!ts) return "";
    let d = null;
    if (ts.toDate) d = ts.toDate();
    else if (typeof ts === "string") d = new Date(ts);
    else if (typeof ts === "number") d = new Date(ts);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  // ---------- state ----------
  const state = {
    containerId: null,
    mode:        "admin",     // "admin" | "tech"
    items:       [],
    unsubscribe: null,
    user:        null,        // { uid, email, name, isAdmin }
    filterStatus: "open"      // "open" | "all" | "resolved"
  };

  // Has the current user already acked this item?
  function hasAcked(item) {
    if (!item || !Array.isArray(item.acknowledged_by) || !state.user) return false;
    return item.acknowledged_by.some(function (a) {
      return a && a.uid === state.user.uid;
    });
  }

  // Can the current user perform the given write?
  //   • Admin: anything
  //   • Non-admin: only on items in their audience_user_ids, and only
  //     the ack + status fields. We don't render disallowed actions.
  function canUpdate(item) {
    if (!state.user) return false;
    if (state.user.isAdmin) return true;
    return Array.isArray(item.audience_user_ids) &&
           item.audience_user_ids.indexOf(state.user.uid) !== -1;
  }

  // ---------- writes ----------
  async function ackItem(item) {
    if (!state.user) return;
    if (hasAcked(item)) return;
    const db = firebase.firestore();
    const entry = {
      uid:              state.user.uid,
      name:             state.user.name || state.user.email || "staff",
      acknowledged_at:  firebase.firestore.Timestamp.now()
    };
    try {
      await db.collection(COLL).doc(item.id).update({
        acknowledged_by: firebase.firestore.FieldValue.arrayUnion(entry),
        status:          item.status === "new" ? "seen" : item.status,
        updated_at:      firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      console.warn("[operational-feed] ack failed", err && err.code);
      window.alert("Couldn't save your acknowledgment. Try again in a moment.");
    }
  }

  async function setStatus(item, nextStatus) {
    if (!canUpdate(item)) return;
    const db = firebase.firestore();
    const update = {
      status:     nextStatus,
      updated_at: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (nextStatus === "resolved") {
      // resolved_at is admin-only per the rule (only ack+status+updated_at
      // are tech-writable). Set it only when the caller is admin.
      if (state.user.isAdmin) update.resolved_at = firebase.firestore.FieldValue.serverTimestamp();
    }
    try {
      await db.collection(COLL).doc(item.id).update(update);
    } catch (err) {
      console.warn("[operational-feed] setStatus failed", err && err.code);
      window.alert("Couldn't update this item. Try again.");
    }
  }

  // Admin-only direct create. Used by demo buttons + future create UI.
  async function adminCreate(payload) {
    if (!state.user || !state.user.isAdmin) {
      window.alert("Only admins can post to the operational feed.");
      return null;
    }
    const db = firebase.firestore();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const doc = Object.assign({
      type:               "announcement",
      title:              "",
      body:               "",
      severity:           "info",
      status:             "new",
      customer_slug:      null,
      customer_name:      null,
      shift_id:           null,
      inspection_id:      null,
      dcr_submission_id:  null,
      supply_request_id:  null,
      created_by_uid:     state.user.uid,
      created_by_name:    state.user.name || state.user.email || "admin",
      created_at:         now,
      updated_at:         now,
      resolved_at:        null,
      expires_at:         null,
      audience_roles:     [],
      audience_user_ids:  [],
      requires_ack:       false,
      acknowledged_by:    [],
      ai_ready: {
        allow_ai_summary:     true,
        allow_ai_sentiment:   true,
        allow_ai_recognition: true,
        ai_handled:           false,
        ai_notes:             ""
      }
    }, payload || {});
    try {
      const ref = await db.collection(COLL).add(doc);
      return ref.id;
    } catch (err) {
      console.error("[operational-feed] adminCreate failed", err);
      window.alert("Couldn't create feed item: " + (err && err.message || "unknown"));
      return null;
    }
  }

  // ---------- render ----------
  function chipHtml(cls, text) {
    return '<span class="of-chip ' + cls + '">' + esc(text) + '</span>';
  }

  function renderItemCard(item) {
    const typeLabel     = TYPE_LABEL[item.type]     || item.type || "Note";
    const severityLabel = SEVERITY_LABEL[item.severity] || "Info";
    const statusLabel   = STATUS_LABEL[item.status] || item.status || "—";
    const acked         = hasAcked(item);
    const acks          = Array.isArray(item.acknowledged_by) ? item.acknowledged_by : [];

    // Action buttons — only render ones the user is allowed to fire.
    const actionsHtml = [];
    if (item.requires_ack && !acked && canUpdate(item)) {
      actionsHtml.push(
        '<button class="of-btn of-btn-primary" data-action="ack" data-id="' + esc(item.id) + '">' +
          'Got it</button>'
      );
    }
    if (canUpdate(item) &&
        item.status !== "resolved" && item.status !== "archived") {
      if (item.status === "new" || item.status === "seen") {
        actionsHtml.push(
          '<button class="of-btn" data-action="im_on_it" data-id="' + esc(item.id) + '">' +
            'I\'m on it</button>'
        );
      }
      if (item.status === "im_on_it" || item.status === "seen") {
        actionsHtml.push(
          '<button class="of-btn" data-action="waiting" data-id="' + esc(item.id) + '">' +
            'Waiting on something</button>'
        );
      }
      // "All set" — admin / privileged roles. For Phase 1, admins only;
      // future phases will check audience_roles for {office_manager,
      // scheduler, quality_manager}.
      if (state.user && state.user.isAdmin) {
        actionsHtml.push(
          '<button class="of-btn of-btn-primary" data-action="resolve" data-id="' + esc(item.id) + '">' +
            'All set</button>'
        );
      }
    }
    if (state.user && state.user.isAdmin && item.status !== "archived") {
      actionsHtml.push(
        '<button class="of-btn of-btn-ghost" data-action="archive" data-id="' + esc(item.id) + '">' +
          'Archive</button>'
      );
    }

    const customerLine = item.customer_name
      ? '<div class="of-customer">Customer: <strong>' + esc(item.customer_name) + '</strong></div>'
      : '';

    const acksLine = acks.length
      ? '<div class="of-acks">Acknowledged by ' + esc(acks.length) +
          ' (' + esc(acks.map(function (a) { return a.name; }).join(", ")) + ')</div>'
      : '';

    return (
      '<article class="of-card of-sev-' + esc(item.severity || "info") +
        ' of-status-' + esc(item.status || "new") + '" data-id="' + esc(item.id) + '">' +
        '<header class="of-card-head">' +
          chipHtml("of-chip-type",     typeLabel) +
          chipHtml("of-chip-severity", severityLabel) +
          chipHtml("of-chip-status",   statusLabel) +
          (item.requires_ack ? chipHtml("of-chip-ack", "Ack required") : "") +
        '</header>' +
        '<h3 class="of-title">' + esc(item.title || "(no title)") + '</h3>' +
        (item.body
          ? '<p class="of-body">' + esc(item.body) + '</p>'
          : '') +
        customerLine +
        acksLine +
        '<footer class="of-card-foot">' +
          '<span class="of-meta">' +
            (item.created_by_name ? esc(item.created_by_name) + ' · ' : '') +
            esc(fmtWhen(item.created_at)) +
          '</span>' +
          (actionsHtml.length
            ? '<div class="of-actions">' + actionsHtml.join("") + '</div>'
            : '') +
        '</footer>' +
      '</article>'
    );
  }

  function applyFilter(items) {
    if (state.filterStatus === "all")      return items;
    if (state.filterStatus === "resolved") return items.filter(function (i) { return i.status === "resolved"; });
    // "open" = anything that isn't resolved/archived
    return items.filter(function (i) { return i.status !== "resolved" && i.status !== "archived"; });
  }

  function renderList() {
    const root = $(state.containerId);
    if (!root) return;
    const items = applyFilter(state.items);
    if (items.length === 0) {
      root.innerHTML =
        '<p class="of-empty">' +
          'No items right now. ' +
          (state.mode === "admin"
            ? 'New supply requests + Phase 2 categories will show up here.'
            : 'Anything you need to know will show up here.') +
        '</p>';
      return;
    }
    root.innerHTML = items.map(renderItemCard).join("");
  }

  // ---------- live subscribe ----------
  function subscribe() {
    if (state.unsubscribe) { try { state.unsubscribe(); } catch (_e) {} }
    const db = firebase.firestore();
    // Order by created_at desc, cap at 200 for sanity.
    state.unsubscribe = db.collection(COLL)
      .orderBy("created_at", "desc")
      .limit(200)
      .onSnapshot(function (snap) {
        state.items = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });
        renderList();
      }, function (err) {
        console.warn("[operational-feed] subscribe failed", err && err.code);
        const root = $(state.containerId);
        if (root) {
          root.innerHTML = '<p class="of-empty">Couldn\'t load the feed: ' +
                           esc(err && err.message || "permission denied") + '</p>';
        }
      });
  }

  // ---------- click delegation ----------
  function wireClicks() {
    const root = $(state.containerId);
    if (!root || root.dataset.opFeedWired) return;
    root.dataset.opFeedWired = "1";
    root.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-action][data-id]");
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const item = state.items.find(function (i) { return i.id === id; });
      if (!item) return;
      btn.disabled = true;
      if (action === "ack")          { ackItem(item).finally(function () { btn.disabled = false; }); }
      else if (action === "im_on_it"){ setStatus(item, "im_on_it").finally(function () { btn.disabled = false; }); }
      else if (action === "waiting") { setStatus(item, "waiting").finally(function () { btn.disabled = false; }); }
      else if (action === "resolve") { setStatus(item, "resolved").finally(function () { btn.disabled = false; }); }
      else if (action === "archive") { setStatus(item, "archived").finally(function () { btn.disabled = false; }); }
      else                            { btn.disabled = false; }
    });
    // Status filter (admin only — tech surface has no filter for Phase 1).
    const filterEl = document.getElementById(state.containerId + "-filter");
    if (filterEl) {
      filterEl.addEventListener("change", function () {
        state.filterStatus = filterEl.value;
        renderList();
      });
    }
  }

  // ---------- public API ----------
  function mount(opts) {
    opts = opts || {};
    state.containerId = String(opts.containerId || "");
    state.mode        = opts.mode === "tech" ? "tech" : "admin";
    state.user        = opts.user || null;
    state.filterStatus = opts.filterStatus || "open";
    wireClicks();
    subscribe();
  }

  function unmount() {
    if (state.unsubscribe) { try { state.unsubscribe(); } catch (_e) {} }
    state.unsubscribe = null;
  }

  window.OpFeed = {
    mount:       mount,
    unmount:     unmount,
    adminCreate: adminCreate
  };
})();
