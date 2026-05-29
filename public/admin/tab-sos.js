/* Pioneer DCR Hub — Admin SOS Events tab (vanilla JS, no build).
 *
 * Pioneer SOS — admin review panel.
 *
 * Reads emergency_events (admin-only via Firestore rule). Real-time
 * snapshot listener so a new alert appears without manual refresh.
 * Each card shows severity, tech, location, time, details, geolocation
 * link (if available), and notification status. Resolve button writes
 * status=resolved + resolved_at + resolved_by + resolution_notes.
 *
 * Surface lives at window.__pioneerAdmin.tabs.sos. Only `init` is
 * exported — internal functions stay private to the module. Loaded
 * AFTER admin/_utils.js + admin/_shell.js + admin/_budget.js and BEFORE
 * admin.js. The boot in admin.js wires
 *   registerTabActivator("sos", window.__pioneerAdmin.tabs.sos.init);
 *
 * External dependencies:
 *   • escapeHtml, cssEsc, formatImprovementDate from __pioneerAdmin.utils
 *   • window.firebase compat SDK (auth + firestore)
 *
 * No closure deps on admin.js — this module is self-contained.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin/tab-sos.js: admin/_utils.js must load first");
  }
  const { escapeHtml, cssEsc, formatImprovementDate } = window.__pioneerAdmin.utils;

  /* ---------- module state ---------- */

  let sosWired = false;
  let sosFilter = "open";
  let sosUnsubscribe = null;
  let sosLastEvents = [];

  function initSosOnce() {
    if (sosWired) {
      sosStartListening();
      return;
    }
    sosWired = true;
    const refresh = document.getElementById("sos-refresh");
    if (refresh) refresh.addEventListener("click", function () { sosStartListening(true); });
    document.querySelectorAll(".sos-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sosFilter = btn.dataset.filter || "open";
        document.querySelectorAll(".sos-filter").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        renderSosList();
      });
    });
    sosStartListening();
  }

  function sosStartListening(forceRebind) {
    if (sosUnsubscribe && !forceRebind) return;
    if (sosUnsubscribe && forceRebind) {
      try { sosUnsubscribe(); } catch (_e) {}
      sosUnsubscribe = null;
    }
    const loading = document.getElementById("sos-loading");
    const errEl   = document.getElementById("sos-error");
    if (loading) loading.hidden = false;
    if (errEl)   errEl.hidden = true;
    try {
      sosUnsubscribe = firebase.firestore()
        .collection("emergency_events")
        .orderBy("createdAt", "desc")
        .limit(200)
        .onSnapshot(function (snap) {
          sosLastEvents = snap.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data()); });
          if (loading) loading.hidden = true;
          renderSosList();
          updateSosBadge();
        }, function (err) {
          console.error("[sos-admin] snapshot failed", err);
          if (loading) loading.hidden = true;
          if (errEl) { errEl.textContent = "Couldn't load SOS events: " + (err && err.message || "unknown"); errEl.hidden = false; }
        });
    } catch (err) {
      if (loading) loading.hidden = true;
      if (errEl) { errEl.textContent = "Couldn't open SOS listener: " + (err && err.message); errEl.hidden = false; }
    }
  }

  function updateSosBadge() {
    const badge = document.getElementById("sos-tab-badge");
    if (!badge) return;
    const open = sosLastEvents.filter(function (e) {
      return String(e.status || "open") !== "resolved";
    }).length;
    if (open > 0) { badge.textContent = String(open); badge.hidden = false; }
    else          { badge.textContent = "0";          badge.hidden = true;  }
  }

  function renderSosList() {
    const list  = document.getElementById("sos-list");
    const empty = document.getElementById("sos-empty");
    if (!list) return;
    const filtered = sosLastEvents.filter(function (e) {
      const s = String(e.status || "open");
      const sev = String(e.severity || "help_needed");
      if (sosFilter === "open")     return s !== "resolved";
      if (sosFilter === "critical") return sev === "critical";
      if (sosFilter === "resolved") return s === "resolved";
      return true;
    });
    if (filtered.length === 0) {
      list.innerHTML = "";
      if (empty) {
        empty.textContent = sosLastEvents.length === 0
          ? "No SOS events yet — quiet shift, good."
          : "Nothing matches this filter.";
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = filtered.map(renderSosCard).join("");
    list.querySelectorAll("button[data-sos-resolve]").forEach(function (btn) {
      btn.addEventListener("click", function () { resolveSosEvent(btn); });
    });
  }

  function renderSosCard(e) {
    const id       = e._id;
    const severity = String(e.severity || "help_needed");
    const status   = String(e.status || "open");
    const notif    = String(e.notificationStatus || "pending");
    const notified = e.notified || {};
    const created  = formatImprovementDate(e.createdAt);
    const techName = escapeHtml(e.techName || e.createdByEmail || "(unknown)");
    const customer = e.customerName || e.locationName || "";
    const customerLine = customer
      ? '<span class="sos-evt-customer">📍 ' + escapeHtml(customer) + '</span>'
      : '<span class="sos-evt-customer sos-evt-customer-empty">No shift in progress</span>';
    const details  = e.details ? escapeHtml(String(e.details)) : "";
    const detailsBlock = details
      ? '<p class="sos-evt-details">' + details.replace(/\n/g, "<br>") + '</p>'
      : '<p class="sos-evt-details sos-evt-details-empty">(no description provided)</p>';
    const geo = e.geolocation;
    const geoLine = (geo && geo.lat != null && geo.lng != null)
      ? '<a class="sos-evt-geo" href="https://maps.google.com/?q=' + Number(geo.lat) + ',' + Number(geo.lng) +
        '" target="_blank" rel="noopener noreferrer">📌 Open in Maps</a>'
      : '';
    const shiftRef = e.shiftId
      ? '<span class="sos-evt-meta-piece">Shift #' + escapeHtml(String(e.shiftId)) + '</span>'
      : '';

    const notifBits = [];
    notifBits.push((notified.april ? "✓ April" : "✗ April"));
    notifBits.push((notified.kirby ? "✓ Kirby" : "✗ Kirby"));
    notifBits.push((notified.nick  ? "✓ Nick"  : "✗ Nick"));
    let notifLabel;
    if (notif === "sent")                     notifLabel = "SMS sent · " + notifBits.join(" · ");
    else if (notif === "partial")             notifLabel = "Partial · " + notifBits.join(" · ");
    else if (notif === "sms_provider_missing")notifLabel = "SMS provider not configured · call manually";
    else if (notif === "failed")              notifLabel = "SMS dispatch failed · call manually";
    else                                       notifLabel = "Dispatching…";

    const resolutionBlock = status === "resolved"
      ? '<div class="sos-evt-resolution">' +
          '<p class="sos-evt-resolution-when">Resolved ' +
            escapeHtml(formatImprovementDate(e.resolved_at) || "") +
            (e.resolved_by && e.resolved_by.displayName
              ? ' by ' + escapeHtml(e.resolved_by.displayName) : '') +
          '</p>' +
          (e.resolution_notes
            ? '<p class="sos-evt-resolution-notes">' + escapeHtml(e.resolution_notes) + '</p>'
            : '') +
        '</div>'
      : '<div class="sos-evt-resolve">' +
          '<input type="text" class="sos-evt-notes" data-sos-notes="' + escapeHtml(id) + '"' +
            ' placeholder="Resolution notes (what happened, how it was handled)" maxlength="300" />' +
          '<button type="button" class="panel-action" data-sos-resolve="' + escapeHtml(id) + '">Mark resolved</button>' +
        '</div>';

    return '<article class="sos-evt sos-evt-' + escapeHtml(severity) + ' sos-evt-' + escapeHtml(status) + '" data-sos-id="' + escapeHtml(id) + '">' +
             '<header class="sos-evt-head">' +
               '<span class="sos-evt-sev sos-sev-' + escapeHtml(severity) + '">' +
                 (severity === "critical" ? "🚨 EMERGENCY" : "⚠ HELP NEEDED") +
               '</span>' +
               '<strong class="sos-evt-tech">' + techName + '</strong>' +
               '<span class="sos-evt-time">' + escapeHtml(created) + '</span>' +
             '</header>' +
             '<div class="sos-evt-meta">' +
               customerLine +
               (geoLine ? ' · ' + geoLine : '') +
               (shiftRef ? ' · ' + shiftRef : '') +
             '</div>' +
             detailsBlock +
             '<div class="sos-evt-notif">' + escapeHtml(notifLabel) + '</div>' +
             '<div class="sos-evt-callbar">' +
               '<a class="sos-evt-call-btn" href="tel:+15098283335">📞 Call April</a>' +
               '<a class="sos-evt-call-btn" href="tel:911">📞 911</a>' +
             '</div>' +
             resolutionBlock +
           '</article>';
  }

  async function resolveSosEvent(btn) {
    const id = btn.getAttribute("data-sos-resolve");
    if (!id) return;
    const notesEl = document.querySelector('input[data-sos-notes="' + cssEsc(id) + '"]');
    const notes = String((notesEl && notesEl.value) || "").trim();
    if (!notes) {
      alert("Add a one-line resolution note before marking resolved.");
      if (notesEl) notesEl.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const u = firebase.auth().currentUser;
      await firebase.firestore().collection("emergency_events").doc(id).set({
        status:            "resolved",
        resolution_notes:  notes,
        resolved_at:       firebase.firestore.FieldValue.serverTimestamp(),
        resolved_by: {
          uid:         (u && u.uid)         || null,
          email:       (u && u.email)       || null,
          displayName: (u && u.displayName) || (u && u.email) || "admin"
        }
      }, { merge: true });
    } catch (err) {
      console.error("[sos-admin] resolve failed", err);
      btn.disabled = false;
      btn.textContent = "Mark resolved";
      alert("Couldn't save: " + (err && err.message));
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.sos = {
    init: initSosOnce
  };
}());
