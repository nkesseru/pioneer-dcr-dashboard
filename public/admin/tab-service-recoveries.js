/* Pioneer DCR Hub — Admin Service Recoveries tab (vanilla JS, no build).
 *
 * Service Recoveries — admin coaching board
 *
 * Reads /service_recoveries. Admin can edit status / assignment /
 * resolution. "Mark resolved" stamps resolved_at + resolved_by in one
 * click. Customer + linked inspection_id are immutable after create.
 * Soft-delete only — workflow is "resolved", not "deleted".
 *
 * Surface lives at window.__pioneerAdmin.tabs.serviceRecoveries:
 *   { init: wireRecoveriesControls, refresh: loadServiceRecoveries }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getCustomerName, getCustomerSlug, getActive,
 *     getTechName, getTechSlug, tsToMs
 *     from __pioneerAdmin.utils
 *   • openModal, closeModal, showToast, setStatus, hideAllStatuses
 *     from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps (admin.js
 *     populates this bridge during boot — scaffolding until Customers,
 *     Techs, and modal-infra are extracted):
 *       - getCustomers()             — returns the live customers array
 *       - getTechs()                 — returns the live techs array
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, saving)
 *   • window.firebase compat SDK (auth + firestore)
 *
 * No cross-tab state escape: serviceRecoveries array lives inside this
 * IIFE only. customerLabelForSlug now lives here too — when Phase 6's
 * admin.js shim is deleted alongside this extraction, Service Recoveries
 * becomes its sole authoritative owner.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-service-recoveries.js: admin/_utils.js + admin/_shell.js must load first");
  }
  const {
    escapeHtml,
    getCustomerName,
    getCustomerSlug,
    getActive,
    getTechName,
    getTechSlug,
    tsToMs
  } = window.__pioneerAdmin.utils;
  const {
    openModal,
    closeModal,
    showToast,
    setStatus,
    hideAllStatuses
  } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-service-recoveries: __pioneerAdmin.deps." + name + " not populated yet — boot order issue");
    }
    return deps[name];
  }
  const getCustomers          = () => depOrThrow("getCustomers")();
  const getTechs              = () => depOrThrow("getTechs")();
  const getCurrentAdminEmail  = window.__pioneerAdmin.shell.getCurrentAdminEmail;
  const handleAdminWriteError = window.__pioneerAdmin.shell.handleAdminWriteError;
  const setModalError         = window.__pioneerAdmin.shell.setModalError;
  const setModalSaving        = window.__pioneerAdmin.shell.setModalSaving;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let serviceRecoveries = [];
  const RECOVERY_STATUSES = ["open", "in_progress", "resolved", "cannot_resolve"];

  // Customer-label resolver. Moved here from the admin.js shim added in
  // Phase 6 — Service Recoveries is now the sole owner. Reads the live
  // customers array via the deps bridge.
  function customerLabelForSlug(slug) {
    const customers = getCustomers();
    const c = customers.find(function (x) {
      return String(getCustomerSlug(x) || "").toLowerCase() === String(slug || "").toLowerCase();
    });
    return c ? (getCustomerName(c) || getCustomerSlug(c)) : (slug || "(unknown)");
  }

  function recoveryRowHtml(r) {
    const status = String(r.status || "open").toLowerCase();
    const sev    = String(r.severity || "low").toLowerCase();
    const created = r.created_at ? new Date(tsToMs(r.created_at)).toLocaleDateString() : "—";
    const due     = r.due_date    || "";
    const overdue = due && status !== "resolved" && status !== "cannot_resolve" &&
                    Date.parse(due + "T23:59:59Z") < Date.now();
    const customer = customerLabelForSlug(r.customer_slug);
    const assignee = r.assigned_to_display_name || (r.assigned_to_email ? r.assigned_to_email : "Unassigned");

    return (
      '<div class="recovery-row" role="listitem" data-id="' + escapeHtml(r.id) + '">' +
        '<div>' +
          '<p class="recovery-customer">' + escapeHtml(customer) + '</p>' +
          '<span class="recovery-pill is-' + escapeHtml(status) + '">' + escapeHtml(status.replace("_", " ")) + '</span>' +
          '<span class="recovery-pill sev-' + escapeHtml(sev) + '">' + escapeHtml(sev) + '</span>' +
          (overdue ? '<span class="recovery-overdue">Overdue</span>' : '') +
          '<pre class="recovery-desc">' + escapeHtml(r.description || "") + '</pre>' +
        '</div>' +
        '<div class="recovery-meta">' +
          '<span class="recovery-meta-line">Assigned: ' + escapeHtml(assignee) + '</span>' +
          '<span class="recovery-meta-line">Area: ' + escapeHtml(r.area || "—") + '</span>' +
          '<span class="recovery-meta-line">Due: ' + escapeHtml(due || "—") + '</span>' +
          '<span class="recovery-meta-line">Created: ' + escapeHtml(created) +
            (r.created_by ? ' by ' + escapeHtml(r.created_by) : '') +
          '</span>' +
          (r.resolved_at
            ? '<span class="recovery-meta-line">Resolved ' +
                escapeHtml(new Date(tsToMs(r.resolved_at)).toLocaleDateString()) +
                (r.resolved_by ? ' by ' + escapeHtml(r.resolved_by) : '') +
              '</span>'
            : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="row-btn" type="button" data-action="edit-recovery">Edit</button>' +
        '</div>' +
      '</div>'
    );
  }

  function populateRecoveryAssignedDropdown(selId) {
    const sel = $(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">— Unassigned —</option>';
    const activeTechs = getTechs()
      .filter(function (t) { return getActive(t); })
      .sort(function (a, b) { return getTechName(a).localeCompare(getTechName(b)); });
    activeTechs.forEach(function (t) {
      const slug  = getTechSlug(t);
      const email = (t.email || "").toLowerCase().trim();
      const name  = getTechName(t) || slug;
      const opt = document.createElement("option");
      opt.value = slug;
      opt.dataset.email = email;
      opt.dataset.name  = name;
      opt.textContent = name + (email ? " (" + email + ")" : "");
      sel.appendChild(opt);
    });
  }

  function applyCurrentRecoveriesFilter() {
    const root  = $("recoveries-list");
    const cnt   = $("recoveries-count");
    const badge = $("recoveries-open-badge");
    if (!root) return;

    const stat  = ($("recoveries-filter-status")   && $("recoveries-filter-status").value)   || "open";
    const cust  = ($("recoveries-filter-customer") && $("recoveries-filter-customer").value) || "all";
    const sev   = ($("recoveries-filter-severity") && $("recoveries-filter-severity").value) || "all";
    const q     = String(($("recoveries-search") && $("recoveries-search").value) || "").trim().toLowerCase();

    const filtered = serviceRecoveries.filter(function (r) {
      const s = String(r.status || "open").toLowerCase();
      if (stat === "active") { if (s !== "open" && s !== "in_progress") return false; }
      else if (stat !== "all" && s !== stat) return false;
      if (cust !== "all" && String(r.customer_slug || "").toLowerCase() !== cust.toLowerCase()) return false;
      if (sev !== "all" && String(r.severity || "").toLowerCase() !== sev) return false;
      if (q) {
        const hay = [
          r.description, r.customer_slug, customerLabelForSlug(r.customer_slug),
          r.assigned_to_display_name, r.assigned_to_email, r.area
        ].filter(Boolean).join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (cnt) cnt.textContent = filtered.length + " of " + serviceRecoveries.length + " recovery" + (serviceRecoveries.length === 1 ? "" : "ies");

    // Open badge count (top-level open + in_progress, irrespective of filters).
    if (badge) {
      const openCount = serviceRecoveries.filter(function (r) {
        const s = String(r.status || "open").toLowerCase();
        return s === "open" || s === "in_progress";
      }).length;
      if (openCount > 0) { badge.hidden = false; badge.textContent = openCount > 9 ? "9+" : String(openCount); }
      else                { badge.hidden = true;  badge.textContent = "0"; }
    }

    if (filtered.length === 0) {
      root.innerHTML = "";
      setStatus("recoveries", "empty");
      return;
    }
    hideAllStatuses("recoveries");
    root.innerHTML = filtered.map(recoveryRowHtml).join("");
  }

  async function loadServiceRecoveries() {
    setStatus("recoveries", "loading");
    try {
      const snap = await firebase.firestore().collection("service_recoveries").get();
      serviceRecoveries = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      serviceRecoveries.sort(function (a, b) {
        // Open / in_progress first; resolved/cannot_resolve last; tie-break by created desc.
        function rank(r) {
          const s = String(r.status || "open").toLowerCase();
          if (s === "open")           return 0;
          if (s === "in_progress")    return 1;
          if (s === "cannot_resolve") return 2;
          if (s === "resolved")       return 3;
          return 4;
        }
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return (tsToMs(b.created_at) || 0) - (tsToMs(a.created_at) || 0);
      });
      // Populate customer filter dropdown (reuses the customers cache).
      const sel = $("recoveries-filter-customer");
      if (sel) {
        const preserved = sel.value || "all";
        const opts = getCustomers()
          .filter(function (c) { return getActive(c); })
          .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); });
        sel.innerHTML = '<option value="all">All customers</option>' + opts.map(function (c) {
          const slug = getCustomerSlug(c);
          return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(getCustomerName(c)) + '</option>';
        }).join("");
        sel.value = preserved;
      }
      applyCurrentRecoveriesFilter();
    } catch (err) {
      console.error("loadServiceRecoveries failed", err);
      setStatus("recoveries", "error",
        "Couldn't load service recoveries: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', deploy firestore.rules with the service_recoveries block."
      );
    }
  }

  function openRecoveryEditModal(r) {
    if (!r) return;
    $("recovery-edit-id").value = r.id;
    $("recovery-edit-title").textContent = "Service Recovery · " + customerLabelForSlug(r.customer_slug);
    $("recovery-edit-desc").textContent = r.description || "";
    $("recovery-edit-status").value = r.status || "open";
    $("recovery-edit-due").value = r.due_date || "";
    $("recovery-edit-resolution").value = r.resolution_notes || "";

    populateRecoveryAssignedDropdown("recovery-edit-assigned");
    const sel = $("recovery-edit-assigned");
    if (sel) sel.value = r.assigned_to || "";

    const meta = [];
    if (r.area) meta.push("Area: " + r.area);
    if (r.severity) meta.push("Severity: " + r.severity);
    if (r.inspection_id) meta.push("Linked inspection: " + r.inspection_id);
    if (r.created_at) meta.push("Created " + new Date(tsToMs(r.created_at)).toLocaleString());
    $("recovery-edit-meta").textContent = meta.join(" · ");

    setModalError("recovery-edit-modal", "");
    setModalSaving("recovery-edit-modal", false);
    openModal("recovery-edit-modal");
  }

  async function onRecoverySave() {
    const id = $("recovery-edit-id").value.trim();
    if (!id) return;
    const status = $("recovery-edit-status").value;
    const due    = $("recovery-edit-due").value.trim();
    const resolution = $("recovery-edit-resolution").value.trim();
    const sel = $("recovery-edit-assigned");
    const opt = sel ? sel.options[sel.selectedIndex] : null;
    const assignedTo    = (sel && sel.value) || null;
    const assignedEmail = (opt && opt.dataset && opt.dataset.email) || null;
    const assignedName  = (opt && opt.dataset && opt.dataset.name)  || null;

    if (RECOVERY_STATUSES.indexOf(status) < 0) {
      setModalError("recovery-edit-modal", "Pick a valid status."); return;
    }

    setModalSaving("recovery-edit-modal", true);
    setModalError("recovery-edit-modal", "");

    const db  = firebase.firestore();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const adminEmail = getCurrentAdminEmail();
    const updates = {
      status:                      status,
      assigned_to:                 assignedTo,
      assigned_to_email:           assignedEmail,
      assigned_to_display_name:    assignedName,
      due_date:                    due || null,
      resolution_notes:            resolution || null,
      updated_at:                  sts,
      updated_by:                  adminEmail
    };
    if (status === "resolved" || status === "cannot_resolve") {
      updates.resolved_at = sts;
      updates.resolved_by = adminEmail;
    } else {
      // If status moves back from resolved, clear the resolved stamp.
      updates.resolved_at = null;
      updates.resolved_by = null;
    }

    try {
      await db.collection("service_recoveries").doc(id).update(updates);
      showToast("ok", "Service Recovery updated.");
      closeModal("recovery-edit-modal");
      await loadServiceRecoveries();
    } catch (err) {
      handleAdminWriteError(err, { context: "recovery save", modalId: "recovery-edit-modal" });
    } finally {
      setModalSaving("recovery-edit-modal", false);
    }
  }

  async function onRecoveryMarkResolved() {
    // Force status → resolved + stamp resolved_*. Reads any in-flight
    // resolution text and assignee from the open modal.
    $("recovery-edit-status").value = "resolved";
    await onRecoverySave();
  }

  function wireRecoveriesControls() {
    const list = $("recoveries-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const r = serviceRecoveries.find(function (x) { return x.id === row.dataset.id; });
        if (!r) return;
        if (btn.dataset.action === "edit-recovery") openRecoveryEditModal(r);
      });
    }
    const refresh = $("recoveries-refresh");
    if (refresh) refresh.addEventListener("click", loadServiceRecoveries);
    const save = $("recovery-edit-save");
    if (save) save.addEventListener("click", onRecoverySave);
    const markResolved = $("recovery-mark-resolved");
    if (markResolved) markResolved.addEventListener("click", onRecoveryMarkResolved);

    ["recoveries-filter-status", "recoveries-filter-customer", "recoveries-filter-severity"].forEach(function (id) {
      const el = $(id);
      if (el) el.addEventListener("change", applyCurrentRecoveriesFilter);
    });
    const search = $("recoveries-search");
    if (search) search.addEventListener("input", applyCurrentRecoveriesFilter);
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.serviceRecoveries = {
    init:    wireRecoveriesControls,
    refresh: loadServiceRecoveries
  };
}());
