/* Pioneer DCR Hub — Admin Supply Requests tab (vanilla JS, no build).
 *
 * Workflow:
 *   • Techs submit supply requests from /tech (autocreated by submitDcrV1
 *     when a DCR has supplies_requested:true) or from the Supply Station
 *     order surface. Both shapes land in /supply_requests.
 *   • Office picks up each request in this panel, edits status / vendor /
 *     order # / admin notes, and either "Mark Fulfilled" or rolls through
 *     the new → reviewed → ordered → closed workflow inside Edit.
 *   • Transitioning a request INTO `ordered` queues a Slack DM to April
 *     via /supply_notifications (Zapier filter sets the doc to "sent").
 *     Transitioning INTO `closed` resolves the same doc.
 *   • A second Firestore collection `/supply_notices` is a calmer
 *     admin-only awareness feed — read here, never written from here.
 *
 * Surface lives at window.__pioneerAdmin.tabs.supplyRequests:
 *   {
 *     init,                  // wireSupplyControls — refresh button + filter selects
 *     refresh,               // loadSupplyRequests — full Firestore reload
 *     getSupplyRequests,     // () => supplyRequests
 *     applyFilter,           // applyCurrentSupplyFilter — text + dropdown filter
 *     refreshFilterOptions   // refreshSupplyFilterOptions — repopulate customer/tech selects
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml from __pioneerAdmin.utils
 *   • setStatus, hideAllStatuses, badge, showToast from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - refreshAttentionStrip()
 *   • window.firebase compat SDK (auth + firestore)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-supply-requests.js: utils + shell modules must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;
  const { setStatus, hideAllStatuses, badge, showToast } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-supply-requests: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCurrentAdminEmail  = window.__pioneerAdmin.shell.getCurrentAdminEmail;
  const handleAdminWriteError = window.__pioneerAdmin.shell.handleAdminWriteError;
  const refreshAttentionStrip = () => depOrThrow("refreshAttentionStrip")();

  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- constants ---------- */

  // Workflow order per spec (new → reviewed → customer-notified → ordered → closed):
  const SUPPLY_STATUSES = ["new", "reviewed", "customer_contacted", "ordered", "closed"];
  // The status KEY `ordered` is kept stable for back-compat with every
  // historical supply_requests doc; only the LABEL changes. The new
  // label intentionally drops the past-tense "Ordered" — at this status
  // the order is queued for April to place, not yet placed.
  const STATUS_LABELS = {
    new:                "New",
    reviewed:           "Reviewed by PCC",
    customer_contacted: "Customer Notified",
    ordered:            "Pioneer Commercial Cleaning will order",
    closed:             "Closed / Received"
  };

  /* April supply-order notification target.
   *
   * Stored in admin.js (which Firebase Hosting serves publicly, so anyone
   * who scrapes /admin.js sees the phone). That trade-off was accepted
   * by the office — the contact info is internal-public, not a secret.
   * The Firestore collection `supply_notifications` is admin-only via
   * rules and is NEVER read by tech.js / app.js / techHubViewV1, so the
   * phone does not leak through any tech-facing surface.
   *
   * To rotate the contact: edit this object + redeploy hosting. No
   * Firestore migration is required — only future notifications get the
   * new values; historical docs preserve the values at create time. */
  const APRIL_NOTIFY = {
    name:                    "April Kesseru",
    phone:                   "5098283335",
    slack:                   true,
    reminder_interval_hours: 48
  };
  // Groups that start expanded — the active workflow stages. Closed stays
  // collapsed so it doesn't crowd the day-to-day view.
  const GROUPS_OPEN_BY_DEFAULT = { new: true, reviewed: true, ordered: true, customer_contacted: true, closed: false };

  /* ---------- module state ---------- */

  let supplyRequests = [];

  /* ---------- helpers ---------- */

  function isToday(ts) {
    if (!ts) return false;
    let date;
    try {
      if (typeof ts.toDate === "function") date = ts.toDate();
      else if (typeof ts === "object" && typeof ts.seconds === "number") date = new Date(ts.seconds * 1000);
      else if (typeof ts === "string") date = new Date(ts);
      else return false;
    } catch (e) { return false; }
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
  }

  function updateSupplyMetrics(list) {
    let newCount = 0, orderedToday = 0, openCount = 0;
    list.forEach(function (r) {
      const status = r.status || "new";
      if (status === "new")     newCount += 1;
      if (status !== "closed")  openCount += 1;
      if (status === "ordered" && isToday(r.ordered_at)) orderedToday += 1;
    });
    const mN = $("metric-new");          if (mN) mN.textContent = newCount;
    const mT = $("metric-ordered-today"); if (mT) mT.textContent = orderedToday;
    const mO = $("metric-open");         if (mO) mO.textContent = openCount;

    // The tab badge now mirrors the OPEN count — every request that isn't
    // Closed / Received. Same number as the "Open" metric card, so the
    // top-of-tab badge and the in-tab card always agree. Previously it
    // showed the New count, which conflicted with the "Open" card and made
    // the badge's meaning ambiguous. Open is also the more actionable
    // signal for "how many supply tickets still need office work".
    const tabBadge = $("supply-tab-badge");
    if (tabBadge) {
      if (openCount > 0) {
        tabBadge.textContent = openCount;
        tabBadge.hidden = false;
      } else {
        tabBadge.hidden = true;
      }
    }
  }

  // Build an aging chip for a supply request. The chip shows "Xd open"
  // (or "Xh open" for under-24h items) plus a warn/danger color tier:
  //   • >48h open AND status === "new"           → danger (stale entry)
  //   • >24h reviewed but not ordered/contacted  → warn (follow-up overdue)
  //   • everything else                          → neutral
  // Returns the HTML string or "" when no meaningful chip applies.
  function supplyAgingChipHtml(r) {
    const createdMs  = supplyTsToMs(r.created_at);
    const reviewedMs = supplyTsToMs(r.reviewed_at);
    const status     = r.status || "new";
    if (createdMs == null) return "";
    const ageMs = Date.now() - createdMs;
    const ageHr = ageMs / 3600000;
    const ageDay = ageMs / 86400000;
    const ageLabel = ageHr < 24
      ? Math.max(0, Math.round(ageHr)) + "h open"
      : Math.max(1, Math.round(ageDay)) + "d open";
    let cls = "";
    if (status === "new" && ageMs > 48 * 3600000) cls = " is-danger";
    else if (status === "reviewed" && reviewedMs != null &&
             (Date.now() - reviewedMs) > 24 * 3600000) cls = " is-warn";
    return '<span class="supply-aging-chip' + cls + '">' + escapeHtml(ageLabel) + '</span>';
  }

  // Source discriminator. Default to "customer_supply" for any legacy
  // doc that pre-dates the source field — those all originated from
  // submitDcrV1's auto-create path, which was customer-driven.
  function getSupplyRowSource(r) {
    const s = (r && r.source) || "";
    return s === "supply_station" ? "supply_station" : "customer_supply";
  }

  // Build the head + body of one supply-request card. innerHTML is safe here —
  // every dynamic value passes through escapeHtml().
  function supplyRowMarkup(r) {
    const source       = getSupplyRowSource(r);
    const isStation    = source === "supply_station";
    const headlineRaw  = isStation
      ? (r.tech_display_name || r.requested_by_email || "Supply station order")
      : (r.customer_name || "(no customer)");
    const headline     = escapeHtml(headlineRaw);
    let subLineHtml    = "";
    if (isStation) {
      const subParts = [];
      if (r.priority)                     subParts.push("Priority: " + r.priority);
      if (Array.isArray(r.categories) && r.categories.length) {
        subParts.push("Categories: " + r.categories.join(", "));
      }
      if (r.requested_by_email)           subParts.push(r.requested_by_email);
      subLineHtml = '<div class="supply-row-sub">' + escapeHtml(subParts.join(" · ")) + '</div>';
    } else {
      const cleanDate = r.clean_date || "";
      const tech      = r.tech_display_name || "";
      const location  = r.location_name || "";
      const subParts  = [];
      if (location)  subParts.push(location);
      if (cleanDate) subParts.push(cleanDate);
      if (tech)      subParts.push(tech);
      subLineHtml = '<div class="supply-row-sub">' + escapeHtml(subParts.join(" · ") || "—") + '</div>';
    }

    const items    = escapeHtml(r.requested_items || "(no items listed)");
    const vendor   = escapeHtml(r.vendor || "—");
    const order    = escapeHtml(r.order_number || "—");
    const status   = r.status || "new";
    const statusLabel = STATUS_LABELS[status] || status;
    const agingHtml   = supplyAgingChipHtml(r);

    const sourceBadge = isStation
      ? badge("is-station", "🧺 Supply Station")
      : badge("is-neutral", "Customer Supply");

    const statusOptions = SUPPLY_STATUSES.map(function (s) {
      const sel = s === status ? " selected" : "";
      return '<option value="' + s + '"' + sel + '>' + STATUS_LABELS[s] + '</option>';
    }).join("");

    const stationNoteHtml = (isStation && r.note)
      ? '<p class="supply-row-note"><strong>Note:</strong> ' + escapeHtml(r.note) + '</p>'
      : '';

    const assignedName  = r.assigned_to_name || r.assigned_to ||
                            (r.fulfilled_at ? "" : "Kirby");
    const assignedChip  = assignedName
      ? '<span class="badge is-assigned">Assigned: ' + escapeHtml(assignedName) + '</span>'
      : '';
    const isClosed      = status === "closed";
    const markFulfilledBtn = isClosed
      ? ''
      : '<button class="supply-row-edit" type="button" data-action="mark-fulfilled">Mark Fulfilled</button>';
    const fulfilledMeta = r.fulfilled_at
      ? '<div class="supply-row-fulfilled">Fulfilled' +
          (r.fulfilled_by ? ' by ' + escapeHtml(r.fulfilled_by) : '') +
          (r.fulfilled_at && r.fulfilled_at.toDate
            ? ' at ' + escapeHtml(r.fulfilled_at.toDate().toLocaleString())
            : '') +
        '</div>'
      : '';

    return (
      '<article class="supply-row" data-request-id="' + escapeHtml(r.request_id || r.id) + '" data-status="' + status + '" data-source="' + source + '">' +
        '<header class="supply-row-head">' +
          '<div style="min-width:0;flex:1 1 auto;">' +
            '<div class="supply-row-name">' + headline + '</div>' +
            subLineHtml +
          '</div>' +
          sourceBadge +
          '<span class="badge status-' + status + '">' + escapeHtml(statusLabel) + '</span>' +
          assignedChip +
          agingHtml +
          markFulfilledBtn +
          '<button class="supply-row-edit" type="button" data-action="edit">Edit</button>' +
        '</header>' +
        '<p class="supply-row-items">' + items + '</p>' +
        stationNoteHtml +
        fulfilledMeta +
        '<div class="supply-row-meta">' +
          '<span><strong>Vendor:</strong> ' + vendor + '</span>' +
          '<span><strong>Order #:</strong> ' + order + '</span>' +
        '</div>' +

        '<div class="supply-edit">' +
          '<div class="field-row"><label>Status</label>' +
            '<select class="supply-status-select">' + statusOptions + '</select>' +
          '</div>' +
          '<div class="field-row"><label>Vendor</label>' +
            '<input type="text" class="supply-vendor-input" value="' + escapeHtml(r.vendor || "") + '" placeholder="e.g. Costco" />' +
          '</div>' +
          '<div class="field-row"><label>Order #</label>' +
            '<input type="text" class="supply-order-input" value="' + escapeHtml(r.order_number || "") + '" placeholder="Vendor order number" />' +
          '</div>' +
          '<div class="field-row"><label>Admin notes</label>' +
            // `admin_notes` is the canonical office-side log. Fall back to
            // BOTH legacy fields (`notes` and `request_notes`) for docs that
            // pre-date the rename — read-only fallback, neither field is
            // written here anymore. Next save migrates the text into
            // admin_notes; the legacy fields freeze where they are on the
            // doc and stop affecting display.
            '<textarea class="supply-admin-notes-input" placeholder="Office notes — vendor confirmation, ETA, follow-ups…">' +
              escapeHtml(r.admin_notes || r.notes || r.request_notes || "") +
            '</textarea>' +
          '</div>' +
          '<div class="supply-save-error"></div>' +
          '<div class="supply-edit-actions">' +
            '<button class="supply-cancel" type="button" data-action="cancel">Cancel</button>' +
            '<button class="supply-save"   type="button" data-action="save">Save</button>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  // Render all supply requests grouped by status, in the SUPPLY_STATUSES order.
  function renderSupplyRequests(list) {
    const root = $("supply-list");
    const cnt  = $("supply-count");
    if (!root) return;

    if (cnt) {
      cnt.textContent = list.length + ' request' + (list.length === 1 ? '' : 's');
    }

    if (list.length === 0 && supplyRequests.length === 0) {
      setStatus("supply", "empty");
      root.innerHTML = "";
      updateSupplyMetrics([]);
      return;
    }
    hideAllStatuses("supply");

    const byStatus = {};
    SUPPLY_STATUSES.forEach(function (s) { byStatus[s] = []; });
    list.forEach(function (r) {
      const s = SUPPLY_STATUSES.indexOf(r.status) >= 0 ? r.status : "new";
      byStatus[s].push(r);
    });

    SUPPLY_STATUSES.forEach(function (s) {
      byStatus[s].sort(function (a, b) {
        const at = (a.created_at && a.created_at.seconds) || 0;
        const bt = (b.created_at && b.created_at.seconds) || 0;
        return bt - at;
      });
    });

    root.innerHTML = SUPPLY_STATUSES.map(function (s) {
      const rows = byStatus[s];
      if (!rows.length) return "";
      const isOpen = GROUPS_OPEN_BY_DEFAULT[s] ? " open" : "";
      return (
        '<details class="supply-group" data-status="' + s + '"' + isOpen + '>' +
          '<summary class="supply-group-summary">' +
            '<span class="badge status-' + s + '">' + escapeHtml(STATUS_LABELS[s]) + '</span>' +
            '<span class="supply-group-count">' +
              rows.length + ' request' + (rows.length === 1 ? '' : 's') +
            '</span>' +
          '</summary>' +
          '<div class="supply-group-rows">' +
            rows.map(supplyRowMarkup).join("") +
          '</div>' +
        '</details>'
      );
    }).join("");

    wireSupplyRowActions(root);

    // Update metrics + tab badge from the *unfiltered* list, so the numbers
    // don't drop when the user searches.
    updateSupplyMetrics(supplyRequests);
  }

  function wireSupplyRowActions(root) {
    $$(".supply-row", root).forEach(function (row) {
      const editBtn      = row.querySelector('[data-action="edit"]');
      const cancelBtn    = row.querySelector('[data-action="cancel"]');
      const saveBtn      = row.querySelector('[data-action="save"]');
      const fulfillBtn   = row.querySelector('[data-action="mark-fulfilled"]');
      if (editBtn)   editBtn.addEventListener("click",   function () { row.classList.add("is-editing"); });
      if (cancelBtn) cancelBtn.addEventListener("click", function () {
        row.classList.remove("is-editing", "has-save-error");
      });
      if (saveBtn)   saveBtn.addEventListener("click",   function () { onSupplySave(row); });
      if (fulfillBtn) fulfillBtn.addEventListener("click", function () { onSupplyMarkFulfilled(row); });
    });
  }

  // Quick-action: flip a supply request to status:"closed" + stamp
  // fulfilled_at + fulfilled_by. Skips the full Edit drawer for the
  // common "this is done" case. Keeps the supply_notifications
  // close-out write in sync via the same statusAuditUpdates path.
  async function onSupplyMarkFulfilled(row) {
    const id = row.getAttribute("data-request-id");
    if (!id) return;
    const prior = supplyRequests.find(function (r) { return (r.request_id || r.id) === id; });
    if (!prior) return;
    if (!window.confirm(
      "Mark this supply request as fulfilled?\n\n" +
      "Items: " + (prior.requested_items || "(none)") + "\n\n" +
      "Status will flip to Closed and Kirby will be stamped as the fulfiller."
    )) return;
    const me = getCurrentAdminEmail();
    const db = firebase.firestore();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const updates = Object.assign(
      {
        status:       "closed",
        fulfilled_at: now,
        fulfilled_by: me || "admin",
        closed_at:    now,
        closed_by:    me || "admin",
        updated_at:   now,
        updated_by:   me || "admin"
      },
      statusAuditUpdates(prior, "closed", me)
    );
    try {
      await db.collection("supply_requests").doc(id).update(updates);
      showToast("ok", "Supply request marked fulfilled.");
      try {
        await db.collection("supply_notifications").doc(id).set({
          notification_status: "resolved",
          resolved_at:         now,
          resolved_by:         me || "admin"
        }, { merge: true });
      } catch (_e) { /* swallow — supply_notifications may not exist */ }
      await loadSupplyRequests();
    } catch (err) {
      handleAdminWriteError(err, { context: "mark supply request fulfilled" });
    }
  }

  // Compute audit-field updates triggered by a status change. First-time set
  // only — a status that's been hit before keeps its original by/at pair so
  // the audit trail is preserved through workflow ping-pong.
  function statusAuditUpdates(prev, newStatus, currentEmail) {
    const updates = {};
    const now = firebase.firestore.FieldValue.serverTimestamp();
    if (newStatus === "reviewed" && !prev.reviewed_at) {
      updates.reviewed_by = currentEmail;
      updates.reviewed_at = now;
    }
    if (newStatus === "ordered" && !prev.ordered_at) {
      updates.ordered_by = currentEmail;
      updates.ordered_at = now;
    }
    if (newStatus === "customer_contacted" && !prev.customer_contacted_at) {
      updates.customer_contacted_by = currentEmail;
      updates.customer_contacted_at = now;
    }
    return updates;
  }

  /* April supply-order notification flow.
   *
   * Lifecycle:
   *   • Supply status transitions INTO "ordered" for the first time
   *     → create supply_notifications/{request_id} with notification_status
   *       "pending", reminder_count=0, next_reminder_at = now + 48h.
   *   • Supply status transitions to "closed"
   *     → update the same notification doc: resolved_at = now,
   *       notification_status = "resolved".
   *
   * Reminders are NOT driven by this client — see the README block in
   * the head of this file for Zapier polling instructions. The admin
   * client only writes the trigger record and resolves it on close.
   *
   * v1 Zap contract (in production as of 2026-05-14):
   *   • Trigger: Firestore new-document on supply_notifications.
   *   • Filter: notification_status === "pending" AND (
   *               type === "supply_station_order"
   *               OR (supply_request_id exists AND status === "ordered")
   *             ).
   *   • Action: Slack DM to April + Slack DM to Kirby.
   *   • Final: Firestore PATCH on same doc → notification_status="sent",
   *            last_notified_at=now, sent_channels="slack_april,slack_kirby".
   *   • Reminders: intentionally deferred — there is no Zap polling
   *     next_reminder_at in v1. The doc's next_reminder_at field is
   *     written but not consumed. Build a scheduled Zap later if needed.
   *   • Failure path: intentionally deferred — Slack delivery failures
   *     leave the doc in "pending"; office sees the held Zap run and
   *     retries from the Zapier history UI.
   *   • Firestore PATCH (not full set) with explicit updateMask is
   *     intentional — preserves reminder_count + next_reminder_at so a
   *     future reminder Zap can resume cleanly.
   *   • sent_channels tracks ACTUALLY delivered channels (comma-joined).
   *     If a future Zap stage adds e.g. email or webhook, append it to
   *     the string rather than overwriting.
   *
   * OPERATOR NOTE: any held Zap runs from pre-v2 testing (April-phone
   * variant, SMS attempts, mis-triggered DCR notifications) can be
   * safely ignored or bulk-dismissed in the Zapier task history. They
   * predate the current filter and won't re-fire under the new rules.
   *
   * Idempotency: the supply_request_id is the notification doc ID. If
   * the same supply hits "ordered" twice (e.g. admin reverts then
   * re-promotes), the second write is a no-op against any existing
   * pending doc — we explicitly check for an existing doc first so a
   * Zapier-side reminder cycle in flight is not reset.
   *
   * Failure handling: a Firestore write failure here does NOT roll back
   * the supply_requests update — the status change is still valid; the
   * admin just sees a warning toast and can retry the notification
   * manually if needed. */
  async function createAprilSupplyNotification(supplyRequest) {
    if (!supplyRequest) return;
    const id = supplyRequest.request_id || supplyRequest.id;
    if (!id) return;

    const db  = firebase.firestore();
    const ref = db.collection("supply_notifications").doc(id);
    let existing = null;
    try {
      const snap = await ref.get();
      if (snap.exists) existing = snap.data();
    } catch (err) {
      console.warn("createAprilSupplyNotification: read failed (will still try to write)", err && err.code);
    }
    if (existing && existing.notification_status === "pending") return;

    // We write Firestore Timestamp values for our own timestamps (sts +
    // nextReminderAt). The Zap that updates last_notified_at on send
    // currently writes a stringValue via Zapier's Firestore connector —
    // workable for v1 but inconsistent with this side of the contract.
    // Follow-up: migrate the Zap to set last_notified_at as a real
    // Firestore Timestamp (Zapier Code-step or Custom Action format).
    // Until then, any consumer that reads last_notified_at must accept
    // BOTH shapes — see supplyTsToMs() in this file for the reader
    // that already handles strings, numbers, and Timestamps.
    const sts            = firebase.firestore.FieldValue.serverTimestamp();
    const nextReminderAt = new Date(Date.now() + APRIL_NOTIFY.reminder_interval_hours * 3600 * 1000);
    const doc = {
      supply_request_id:       id,
      customer_slug:           supplyRequest.customer_slug   || "",
      customer_name:           supplyRequest.customer_name   || "",
      location_name:           supplyRequest.location_name   || "",
      requested_items:         supplyRequest.requested_items || "",
      requested_by_tech:       supplyRequest.tech_display_name || supplyRequest.tech_slug || "",
      clean_date:              supplyRequest.clean_date      || "",
      status:                  "ordered",
      created_at:              sts,
      created_by:              getCurrentAdminEmail(),
      notify_to_name:          APRIL_NOTIFY.name,
      notify_to_phone:         APRIL_NOTIFY.phone,
      notify_to_slack:         APRIL_NOTIFY.slack,
      notification_status:     "pending",
      last_notified_at:        null,
      next_reminder_at:        nextReminderAt,
      reminder_interval_hours: APRIL_NOTIFY.reminder_interval_hours,
      reminder_count:          0,
      resolved_at:             null,
      message_summary: [
        "Supply order ready to place:",
        supplyRequest.customer_name || supplyRequest.customer_slug || "(unknown customer)",
        supplyRequest.location_name ? " — " + supplyRequest.location_name : "",
        "\nItems: " + (supplyRequest.requested_items || "(none listed)"),
        "\nRequested by: " + (supplyRequest.tech_display_name || "(unknown tech)"),
        "\nClean date: " + (supplyRequest.clean_date || "—"),
        "\nStatus: Pioneer Commercial Cleaning will order"
      ].join("")
    };
    try {
      await ref.set(doc, { merge: false });
      showToast("ok", "Notification queued for " + APRIL_NOTIFY.name + ".");
    } catch (err) {
      console.error("createAprilSupplyNotification: write failed", err);
      handleAdminWriteError(err, { context: "april notification" });
    }
  }

  async function resolveAprilSupplyNotification(supplyRequest) {
    if (!supplyRequest) return;
    const id = supplyRequest.request_id || supplyRequest.id;
    if (!id) return;
    const db  = firebase.firestore();
    const ref = db.collection("supply_notifications").doc(id);
    try {
      // Only touch the doc if it actually exists — avoids accidentally
      // creating a "resolved" notification for a supply that never went
      // through the "ordered" stage in the first place.
      const snap = await ref.get();
      if (!snap.exists) return;
      await ref.update({
        notification_status: "resolved",
        resolved_at:         firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:          firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:          getCurrentAdminEmail()
      });
    } catch (err) {
      console.warn("resolveAprilSupplyNotification failed (non-fatal)", err && err.code);
    }
  }

  async function onSupplySave(row) {
    const id = row.dataset.requestId;
    if (!id) return;

    const prev = supplyRequests.find(function (r) { return (r.request_id || r.id) === id; }) || {};
    const newStatus  = row.querySelector(".supply-status-select").value;
    const vendor     = row.querySelector(".supply-vendor-input").value.trim();
    const orderNum   = row.querySelector(".supply-order-input").value.trim();
    const adminNotes = row.querySelector(".supply-admin-notes-input").value;

    const currentEmail = (firebase.auth().currentUser && firebase.auth().currentUser.email) || null;

    const updates = Object.assign({
      status:       newStatus,
      vendor:       vendor,
      order_number: orderNum,
      // `admin_notes` is the renamed office-log field. Writing it here
      // doesn't touch the legacy `notes` on existing docs — `notes` simply
      // becomes a frozen historical field on those records.
      admin_notes:  adminNotes,
      updated_at:   firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:   currentEmail || "unknown"
    }, statusAuditUpdates(prev, newStatus, currentEmail));

    const saveBtn = row.querySelector('[data-action="save"]');
    const errEl   = row.querySelector(".supply-save-error");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    row.classList.remove("has-save-error");
    if (errEl) errEl.textContent = "";

    try {
      await firebase.firestore().collection("supply_requests").doc(id).update(updates);
      // Local cache update so the next render shows fresh values without a
      // second round-trip. Server timestamps stay as the local ISO until the
      // next refresh; that's fine for the immediate-feedback UI.
      const idx = supplyRequests.findIndex(function (r) { return (r.request_id || r.id) === id; });
      if (idx >= 0) {
        const merged = Object.assign({}, supplyRequests[idx], updates);
        if (updates.reviewed_at)            merged.reviewed_at           = new Date();
        if (updates.ordered_at)             merged.ordered_at            = new Date();
        if (updates.customer_contacted_at)  merged.customer_contacted_at = new Date();
        merged.updated_at = new Date();
        supplyRequests[idx] = merged;
      }
      row.classList.remove("is-editing");
      // Full list re-render — innerHTML is replaced, so every row
      // (including this one, plus the destination row in the new status
      // group if status changed) is rebuilt fresh from the patched cache.
      applyCurrentSupplyFilter();
      showToast("ok", "Supply request updated.");

      // April notification side effects (best-effort, non-blocking).
      //
      //   • Transition INTO "ordered" → queue April notification.
      //   • Transition INTO "closed" → mark any existing notification
      //     resolved so Zapier stops the reminder loop.
      const prevStatus = (prev && prev.status) || "new";
      const merged     = (idx >= 0) ? supplyRequests[idx] : Object.assign({}, prev, updates);
      if (newStatus === "ordered" && prevStatus !== "ordered") {
        await createAprilSupplyNotification(merged);
      } else if (newStatus === "closed" && prevStatus !== "closed") {
        await resolveAprilSupplyNotification(merged);
      }
    } catch (err) {
      console.error("supply update failed", err);
      const msg = (err && (err.message || err.code)) || String(err);
      row.classList.add("has-save-error");
      if (errEl) errEl.textContent = "Couldn't save: " + msg;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  }

  async function loadSupplyRequests() {
    setStatus("supply", "loading");
    try {
      const snap = await firebase.firestore().collection("supply_requests")
        .orderBy("created_at", "desc")
        .get();
      supplyRequests = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      refreshSupplyFilterOptions();
      applyCurrentSupplyFilter();
      refreshAttentionStrip();
      // Load + render the admin-only Supply Notices disclosure.
      loadSupplyNotices();
    } catch (err) {
      console.error("loadSupplyRequests failed", err);
      setStatus("supply", "error",
        "Couldn't load supply requests: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', confirm:" +
        "\n  • You're signed in as one of the four Pioneer admin emails." +
        "\n  • firestore.rules has the /supply_requests block deployed."
      );
    }
  }

  // ---- Supply Notices (admin-only awareness layer) ------------------
  // Read /supply_notices, sort newest first, cap at most-recent-14-days
  // for display. The collection itself is admin-only by firestore rule.
  async function loadSupplyNotices() {
    const root    = $("supply-notices-list");
    const counter = $("supply-notices-counter");
    if (!root) return;
    try {
      const cutoffMs = Date.now() - 14 * 24 * 3600 * 1000;
      const snap = await firebase.firestore().collection("supply_notices")
        .orderBy("created_at", "desc")
        .limit(50)
        .get();
      const notices = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      }).filter(function (n) {
        const t = n.created_at && n.created_at.toMillis ? n.created_at.toMillis() : 0;
        return t >= cutoffMs;
      });
      if (counter) counter.textContent = String(notices.length);
      if (notices.length === 0) {
        root.innerHTML = '<p class="dm-empty-state">No new supply notices in the last 14 days.</p>';
        return;
      }
      root.innerHTML = notices.map(function (n) {
        const when = n.created_at && n.created_at.toDate
                       ? n.created_at.toDate().toLocaleString()
                       : "";
        return (
          '<div class="supply-notice-row" role="listitem">' +
            '<div class="supply-notice-head">' +
              '<strong>' + escapeHtml(n.title || "New supply request") + '</strong>' +
              '<span class="badge is-neutral">' + escapeHtml(n.source || "dcr") + '</span>' +
              '<span class="badge is-assigned">' + escapeHtml(n.assigned_to_name || "Kirby") + '</span>' +
            '</div>' +
            '<div class="supply-notice-body">' + escapeHtml(n.body || "") + '</div>' +
            '<div class="supply-notice-meta">' +
              (when ? escapeHtml(when) + ' · ' : '') +
              'order <code>' + escapeHtml(n.linked_supply_order_id || "") + '</code>' +
            '</div>' +
          '</div>'
        );
      }).join("");
    } catch (err) {
      // Soft-fail — the notice disclosure is informational; the
      // supply_requests list below is the operational source of truth.
      console.warn("[supply-notices] load failed", err && err.code);
      if (counter) counter.textContent = "?";
      root.innerHTML = '<p class="dm-empty-state">Couldn\'t load notices: ' +
                       escapeHtml(err && err.message || "unknown") + '</p>';
    }
  }

  // Pulled out so save / search both re-apply the same active filter without
  // duplicating the matching logic. Honors text search AND the compound
  // status/customer/tech/window selects added to the supply panel.
  function applyCurrentSupplyFilter() {
    const ds = $("supply-search");
    const q  = ds ? ds.value.trim().toLowerCase() : "";

    const sourceSel   = $("supply-filter-source");
    const statusSel   = $("supply-filter-status");
    const customerSel = $("supply-filter-customer");
    const techSel     = $("supply-filter-tech");
    const windowSel   = $("supply-filter-window");
    const wantSource = sourceSel   ? sourceSel.value   : "all";
    const status     = statusSel   ? statusSel.value   : "all";
    const cust       = customerSel ? customerSel.value : "all";
    const tech       = techSel     ? techSel.value     : "all";
    const winDays    = windowSel   ? parseInt(windowSel.value, 10) : NaN;
    const cutoffMs   = isNaN(winDays) ? null : Date.now() - winDays * 24 * 60 * 60 * 1000;

    const filtered = supplyRequests.filter(function (r) {
      // Source filter — defaults to "customer_supply" for legacy docs
      // that don't have an explicit source field.
      if (wantSource !== "all" && getSupplyRowSource(r) !== wantSource) return false;
      // Status filter — "open" is a pseudo-status meaning "anything not
      // closed". The dropdown lets the office filter to the actionable
      // queue without committing to one specific stage.
      const rowStatus = r.status || "new";
      if (status === "open" && rowStatus === "closed") return false;
      if (status !== "all" && status !== "open" && rowStatus !== status) return false;
      if (cust   !== "all" && (r.customer_slug || "")  !== cust) return false;
      if (tech   !== "all" && (r.tech_slug || "")      !== tech) return false;
      if (cutoffMs != null) {
        const ms = supplyTsToMs(r.created_at);
        if (ms == null || ms < cutoffMs) return false;
      }
      if (q) {
        return (
          (r.customer_name      || "").toLowerCase().includes(q) ||
          (r.location_name      || "").toLowerCase().includes(q) ||
          (r.tech_display_name  || "").toLowerCase().includes(q) ||
          (r.requested_items    || "").toLowerCase().includes(q) ||
          (r.requested_by_email || "").toLowerCase().includes(q) ||
          (r.note               || "").toLowerCase().includes(q) ||
          (r.vendor             || "").toLowerCase().includes(q) ||
          (r.order_number       || "").toLowerCase().includes(q) ||
          (r.status             || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
    renderSupplyRequests(filtered);
  }

  // Tolerant timestamp reader for supply-request created_at (Firestore
  // Timestamp / ISO string / number-ms). Shared by the filter window
  // logic and the aging-chip computation.
  function supplyTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number")              return ts;
    if (typeof ts === "string")              { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function")   return ts.toMillis();
    if (typeof ts.seconds === "number")      return ts.seconds * 1000;
    if (ts._seconds && typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  // Populates the customer + tech filter dropdowns from the loaded
  // supplyRequests list. Called whenever the cache repopulates.
  function refreshSupplyFilterOptions() {
    const custSel = $("supply-filter-customer");
    const techSel = $("supply-filter-tech");
    if (!custSel && !techSel) return;
    function uniqueOptions(arr, keyField, labelField) {
      const seen = {};
      arr.forEach(function (r) {
        const k = r[keyField];
        if (!k) return;
        if (!seen[k]) seen[k] = r[labelField] || k;
      });
      return Object.keys(seen).sort(function (a, b) {
        return String(seen[a]).localeCompare(String(seen[b]));
      }).map(function (k) {
        return '<option value="' + escapeHtml(k) + '">' + escapeHtml(seen[k]) + '</option>';
      }).join("");
    }
    if (custSel) {
      const cur = custSel.value;
      custSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(supplyRequests, "customer_slug", "customer_name");
      custSel.value = cur || "all";
    }
    if (techSel) {
      const cur = techSel.value;
      techSel.innerHTML = '<option value="all">All</option>' +
        uniqueOptions(supplyRequests, "tech_slug", "tech_display_name");
      techSel.value = cur || "all";
    }
  }

  function wireSupplyControls() {
    const ds = $("supply-search");
    if (ds) ds.addEventListener("input", applyCurrentSupplyFilter);

    // Compound filter selects — each refilters in place. No reload of
    // the underlying data; the cache stays intact and we just re-render.
    ["supply-filter-source", "supply-filter-status", "supply-filter-customer",
     "supply-filter-tech",   "supply-filter-window"
    ].forEach(function (id) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", applyCurrentSupplyFilter);
    });

    const refresh = $("supply-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      refresh.disabled = true;
      const original = refresh.textContent;
      refresh.textContent = "Refreshing…";
      loadSupplyRequests().finally(function () {
        refresh.disabled = false;
        refresh.textContent = original;
        const ds2 = $("supply-search");
        if (ds2) ds2.value = "";
      });
    });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.supplyRequests = {
    init:                 wireSupplyControls,
    refresh:              loadSupplyRequests,
    getSupplyRequests:    function () { return supplyRequests; },
    applyFilter:          applyCurrentSupplyFilter,
    refreshFilterOptions: refreshSupplyFilterOptions
  };
}());
