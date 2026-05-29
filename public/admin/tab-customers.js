/* Pioneer DCR Hub — Admin Customers tab (vanilla JS, no build).
 *
 * Customers tab — list / search / create / edit / archive.
 *
 * Owns the customers array. Other modules that need to read customers
 * (Customer Notes, Service Recoveries, Yesterday's Work — already
 * extracted; the attention strip, Cleaning Techs assignment picker,
 * and Deputy Mapping panels — still in admin.js) read via:
 *   window.__pioneerAdmin.deps.getCustomers()
 * which the admin.js boot wires through to this module's getCustomers().
 *
 * Surface lives at window.__pioneerAdmin.tabs.customers:
 *   {
 *     init:             no-op (kept for parity; controls are wired by
 *                       admin.js's wireWriteControls + wireSearch),
 *     refresh:          loadCustomers,
 *     getCustomers:     () => customers,
 *     applyFilter:      applyCurrentCustomerFilter,
 *     openCreateModal:  openCustomerCreateModal,
 *     openEditModal:    openCustomerEditModal,
 *     onArchive:        onCustomerArchive,
 *     onSave:           dispatches by modal mode (create vs edit)
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js + admin/_budget.js
 * and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getCustomerName, getCustomerSlug, getCustomerEmail,
 *     getCustomerLocation, getActive, getDcrEnabled, getDcrEmailEnabled,
 *     tsToMs from __pioneerAdmin.utils
 *   • setStatus, hideAllStatuses, badge, activeBadge, dcrEnabledBadge,
 *     dcrEmailBadge, openModal, closeModal, showToast
 *     from __pioneerAdmin.shell
 *   • computeBudgetStats, budgetRowBadge, budgetTooltipText
 *     from __pioneerAdmin.budget
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getDcrs(), getDcrIssues(), getSupplyRequests()
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *       - setModalError(modalId, msg)
 *       - setModalSaving(modalId, saving)
 *       - populateCustomerDeputyIntegration(c)
 *         — read-only Deputy-side block on the edit modal. Kept in
 *           admin.js for now (its deputyMappingShifts/toMillis/etc.
 *           ties live with the Deputy Mapping module).
 *   • window.firebase compat SDK (firestore)
 *   • window.CustomerSop (from public/customer-sop.js)
 *
 * No closure deps on admin.js beyond the bridge. No cross-tab state
 * escape — customers array lives inside this IIFE only.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils
      || !window.__pioneerAdmin.shell || !window.__pioneerAdmin.budget) {
    throw new Error("admin/tab-customers.js: utils + shell + budget modules must load first");
  }
  const {
    escapeHtml,
    getCustomerName, getCustomerSlug, getCustomerEmail, getCustomerLocation,
    getActive, getDcrEnabled, getDcrEmailEnabled,
    tsToMs
  } = window.__pioneerAdmin.utils;
  const {
    setStatus, hideAllStatuses,
    badge, activeBadge, dcrEnabledBadge, dcrEmailBadge,
    openModal, closeModal, showToast
  } = window.__pioneerAdmin.shell;
  const {
    computeBudgetStats, budgetRowBadge, budgetTooltipText
  } = window.__pioneerAdmin.budget;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-customers: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getDcrs                          = () => depOrThrow("getDcrs")();
  const getDcrIssues                     = () => depOrThrow("getDcrIssues")();
  const getSupplyRequests                = () => depOrThrow("getSupplyRequests")();
  const getCurrentAdminEmail             = () => depOrThrow("getCurrentAdminEmail")();
  const handleAdminWriteError            = (err, opts) => depOrThrow("handleAdminWriteError")(err, opts);
  const setModalError                    = (modalId, msg) => depOrThrow("setModalError")(modalId, msg);
  const setModalSaving                   = (modalId, on) => depOrThrow("setModalSaving")(modalId, on);
  const populateCustomerDeputyIntegration = c => depOrThrow("populateCustomerDeputyIntegration")(c);

  function $(id) { return document.getElementById(id); }

  // Local slugify — tiny inline copy of slugifyForTech (admin.js) so this
  // module is self-contained for the create-modal path. Will consolidate
  // when admin.js's tech-create flow is also extracted.
  function slugifyCustomerCandidate(s) {
    return String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  /* ---------- module state ---------- */

  let customers = [];
  // V6 pilot fix — "No customers in Firestore yet" was sometimes
  // showing alongside populated customer cards because renderCustomers
  // can fire from the search filter BEFORE loadCustomers resolves
  // (race when the user types in the search box during load). The
  // empty-state should ONLY appear after the load completes AND the
  // resulting list is truly empty. customersLoaded becomes true on
  // the first successful loadCustomers run; until then, the empty
  // state stays suppressed.
  let customersLoaded = false;

  function customerCard(c) {
    const name         = getCustomerName(c) || "(unnamed customer)";
    const slug         = getCustomerSlug(c);
    const email        = getCustomerEmail(c);
    const location     = getCustomerLocation(c);
    const active       = getActive(c);
    const enabled      = getDcrEnabled(c);
    const emailEnabled = getDcrEmailEnabled(c);

    // Per-customer on-budget summary. Computed lazily here from the
    // in-memory dcrs cache — no extra Firestore reads. Returns "" when
    // we have no usable data for this customer.
    const dcrs = getDcrs();
    const budgetStats   = computeBudgetStats(dcrs, { kind: "customer", slug: slug });
    const budgetBadgeHtml = budgetRowBadge(budgetStats);
    const budgetTooltip   = budgetTooltipText(budgetStats);

    // Operational metrics line — high-value, scan-friendly counts only.
    // Open issues / open supply / 30-day issue count / last clean / last
    // issue date / first open unresolved issue summary. Absent rows are
    // omitted to keep the line one row max even on dense customers.
    const dcrIssues = getDcrIssues();
    const supplyRequests = getSupplyRequests();
    const cutoffMs30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const customerOpenIssues = dcrIssues.filter(function (it) {
      return it.customer_slug === slug &&
             (it.status || "new") !== "resolved" &&
             (it.status || "new") !== "closed_no_action";
    });
    const openIssues  = customerOpenIssues.length;
    const recentIssues = dcrIssues.filter(function (it) {
      if (it.customer_slug !== slug) return false;
      const ms = tsToMs(it.created_at);
      return ms != null && ms >= cutoffMs30;
    }).length;
    // Reserved for the future `customer_complaints` collection.
    const recentComplaints = 0;
    const openSupply = supplyRequests.filter(function (r) {
      return r.customer_slug === slug && (r.status || "new") !== "closed";
    }).length;
    // Most recent issue date for this customer (any status).
    let lastIssueMs = null;
    let firstOpenIssueSummary = "";
    for (let i = 0; i < dcrIssues.length; i++) {
      const it = dcrIssues[i];
      if (it.customer_slug !== slug) continue;
      const ms = tsToMs(it.created_at);
      if (ms != null && (lastIssueMs == null || ms > lastIssueMs)) lastIssueMs = ms;
    }
    if (customerOpenIssues.length > 0) {
      const s = customerOpenIssues[0].issue_summary || "";
      firstOpenIssueSummary = s.length > 80 ? s.slice(0, 77) + "…" : s;
    }
    let lastCleanDate = "";
    for (let i = 0; i < dcrs.length; i++) {
      if (dcrs[i].customer_slug === slug && dcrs[i].clean_date) {
        if (!lastCleanDate || dcrs[i].clean_date > lastCleanDate) lastCleanDate = dcrs[i].clean_date;
      }
    }
    const lastIssueLabel = lastIssueMs
      ? new Date(lastIssueMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";

    const metricsParts = [];
    if (openIssues       > 0) metricsParts.push(openIssues       + " open issue"   + (openIssues       === 1 ? "" : "s"));
    if (recentIssues     > 0) metricsParts.push(recentIssues     + " issue"        + (recentIssues     === 1 ? "" : "s") + " · 30d");
    if (recentComplaints > 0) metricsParts.push(recentComplaints + " complaint"    + (recentComplaints === 1 ? "" : "s") + " · 30d");
    if (openSupply       > 0) metricsParts.push(openSupply       + " open supply");
    if (lastIssueLabel)       metricsParts.push("Last issue " + lastIssueLabel);
    if (lastCleanDate)        metricsParts.push("Last clean " + lastCleanDate);
    const metricsLineHtml = metricsParts.length
      ? '<span class="row-metrics">' + escapeHtml(metricsParts.join(" · ")) + '</span>'
      : '';
    const issueSummaryHtml = firstOpenIssueSummary
      ? '<span class="row-metrics is-issue-summary" title="' +
          escapeHtml(customerOpenIssues[0].issue_summary || "") + '">⚠ ' +
          escapeHtml(firstOpenIssueSummary) + '</span>'
      : '';

    const issuesBadgeHtml = openIssues > 0
      ? badge("is-warn", openIssues + " open issue" + (openIssues === 1 ? "" : "s"))
      : "";
    const openSupplyBadgeHtml = openSupply > 0
      ? badge("is-neutral", openSupply + " open supply")
      : "";
    let sopBadgeHtml = "";
    if (window.CustomerSop && typeof window.CustomerSop.statusForCustomer === "function") {
      const st = window.CustomerSop.statusForCustomer(c);
      const cls = st.code === "has_sop"      ? "is-on"
                : st.code === "needs_review" ? "is-warn"
                : st.code === "inactive"     ? "is-off"
                : "is-neutral";
      sopBadgeHtml = badge(cls, "SOP: " + st.label);
    }

    const badges =
      activeBadge(active) +
      dcrEnabledBadge(enabled) +
      dcrEmailBadge(emailEnabled) +
      budgetBadgeHtml +
      issuesBadgeHtml +
      openSupplyBadgeHtml +
      sopBadgeHtml;

    const archiveLabel    = active ? "Archive" : "Reactivate";
    const archiveExtraCls = active ? ""        : " row-btn-reactivate";

    const rowTitle = "Slug: " + (slug || "—") + (email ? "\nEmail: " + email : "");

    return (
      '<div class="admin-row" role="listitem" data-id="' + escapeHtml(c.id) + '" title="' + escapeHtml(rowTitle) + '">' +
        '<div class="row-primary">' +
          '<span class="row-name">'  + escapeHtml(name) + '</span>' +
          '<span class="row-sub">'   + escapeHtml(location || "—") + '</span>' +
          metricsLineHtml +
          issueSummaryHtml +
        '</div>' +
        '<div class="row-actions"' + (budgetTooltip ? ' title="' + escapeHtml(budgetTooltip) + '"' : '') + '>' +
          '<div class="pill-badges">' + badges + '</div>' +
          '<button class="row-btn" type="button" data-action="edit">Edit</button>' +
          '<button class="row-btn' + archiveExtraCls + '" type="button" data-action="archive">' + archiveLabel + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCustomers(list) {
    const root = $("customer-list");
    const cnt  = $("customer-count");
    if (!root) return;
    if (cnt) cnt.textContent = list.length + " customer" + (list.length === 1 ? "" : "s");
    if (list.length === 0 && customersLoaded && customers.length === 0) {
      setStatus("customer", "empty");
      root.innerHTML = "";
      return;
    }
    hideAllStatuses("customer");
    root.innerHTML = list.map(customerCard).join("");
  }

  async function loadCustomers() {
    setStatus("customer", "loading");
    try {
      const snap = await firebase.firestore().collection("customers").get();
      customers = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customers.sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
      customersLoaded = true;
      renderCustomers(customers);
    } catch (err) {
      console.error("loadCustomers failed", err);
      setStatus("customer", "error",
        "Couldn't load customers: " + (err.message || err) +
        "\n\nIf this says 'permission-denied', verify firestore.rules allow read on /customers."
      );
    }
  }

  function applyCurrentCustomerFilter() {
    const cs = $("customer-search");
    const q = String((cs && cs.value) || "").trim().toLowerCase();
    if (!q) return renderCustomers(customers);
    const filtered = customers.filter(function (c) {
      return (
        getCustomerName(c).toLowerCase().includes(q) ||
        getCustomerSlug(c).toLowerCase().includes(q) ||
        getCustomerEmail(c).toLowerCase().includes(q) ||
        getCustomerLocation(c).toLowerCase().includes(q)
      );
    });
    renderCustomers(filtered);
  }

  /* ---- Customer SOP block (public + secure) ---- */

  async function populateCustomerSopBlock(c) {
    const publicBody = $("cust-edit-sop-body");
    const secureBody = $("cust-edit-secure-body");
    if (!c || !window.CustomerSop) {
      if (publicBody) publicBody.innerHTML = '<div class="sop-empty">customer-sop.js not loaded.</div>';
      if (secureBody) secureBody.innerHTML = '<div class="sop-empty">customer-sop.js not loaded.</div>';
      return;
    }
    if (publicBody && typeof window.CustomerSop.renderPublic === "function") {
      window.CustomerSop.renderPublic(publicBody, c);
    }
    if (!secureBody) return;
    secureBody.innerHTML = '<div class="sop-empty">Loading secure ops…</div>';
    try {
      const slug = getCustomerSlug(c);
      const snap = await firebase.firestore().collection("customer_secure").doc(slug).get();
      if (snap.exists) {
        window.CustomerSop.renderSecure(secureBody, snap.data() || {});
      } else {
        secureBody.innerHTML =
          '<div class="sop-empty">No secure ops doc on file for this customer. ' +
          (c.hasSecureSop
            ? 'Customer doc has <code>hasSecureSop: true</code> but the secure doc is missing — re-run the seed parser to repair.'
            : 'No codes / contacts / raw Deputy notes detected during import.') +
          '</div>';
      }
    } catch (err) {
      console.warn("[admin] customer_secure read failed", err && err.code);
      secureBody.innerHTML =
        '<div class="sop-empty">Couldn\'t load secure ops: ' +
        escapeHtml(err && err.message || "unknown") +
        '. Confirm you\'re signed in as an admin and firestore.rules has the /customer_secure block deployed.</div>';
    }
  }

  /* ---- Customer EDIT modal ---- */

  function openCustomerEditModal(c) {
    const modal = $("customer-edit-modal");
    if (modal) modal.dataset.mode = "edit";
    const title = $("customer-modal-title");
    if (title) title.textContent = "Edit customer";
    const save  = $("customer-edit-save");
    if (save) save.textContent = "Save";

    $("cust-edit-id").value                  = c.id;
    $("cust-edit-name").value                = getCustomerName(c);
    $("cust-edit-location").value            = getCustomerLocation(c);
    $("cust-edit-email").value               = getCustomerEmail(c);
    $("cust-edit-active").checked            = getActive(c);
    $("cust-edit-dcr-enabled").checked       = getDcrEnabled(c);
    $("cust-edit-dcr-email-enabled").checked = getDcrEmailEnabled(c);
    $("cust-edit-slack").value               = c.slack_channel || "";
    const rl = (c.review_links && typeof c.review_links === "object") ? c.review_links : {};
    $("cust-edit-five-star").value           = rl.five_star_url || "";
    $("cust-edit-issue-url").value           = rl.issue_url     || "";
    $("cust-edit-notes").value               = c.notes || "";
    // Populate the read-only Deputy Integration block (admin.js still
    // owns that helper because of its deputyMappingShifts ties).
    populateCustomerDeputyIntegration(c);
    // Populate the read-only SOP block (admin mode — shows raw notes).
    populateCustomerSopBlock(c);
    // Blank the create-only slug input to defend against stale carry-over.
    const slugEl = $("cust-create-slug");
    if (slugEl) { slugEl.value = ""; delete slugEl.dataset.touched; }
    setModalError("customer-edit-modal", "");
    openModal("customer-edit-modal");
  }

  /* ---- Customer CREATE modal ---- */

  function openCustomerCreateModal() {
    const modal = $("customer-edit-modal");
    if (modal) modal.dataset.mode = "create";
    const title = $("customer-modal-title");
    if (title) title.textContent = "Add customer";
    const save  = $("customer-edit-save");
    if (save) save.textContent = "Add customer";

    $("cust-edit-id").value                  = "";
    $("cust-edit-name").value                = "";
    $("cust-edit-location").value            = "";
    $("cust-edit-email").value               = "";
    $("cust-edit-active").checked            = true;
    $("cust-edit-dcr-enabled").checked       = true;
    $("cust-edit-dcr-email-enabled").checked = true;
    $("cust-edit-slack").value               = "";
    $("cust-edit-five-star").value           = "";
    $("cust-edit-issue-url").value           = "";
    $("cust-edit-notes").value               = "";

    const slugEl = $("cust-create-slug");
    if (slugEl) { slugEl.value = ""; delete slugEl.dataset.touched; }

    setModalError("customer-edit-modal", "");
    openModal("customer-edit-modal");
  }

  async function onCustomerCreateSave() {
    const name     = $("cust-edit-name").value.trim();
    const location = $("cust-edit-location").value.trim();
    const slugIn   = $("cust-create-slug").value.trim().toLowerCase();
    const slug     = slugIn || slugifyCustomerCandidate(location || name);

    if (!name) {
      setModalError("customer-edit-modal", "Customer name is required.");
      return;
    }
    if (!location) {
      setModalError("customer-edit-modal", "Location name is required.");
      return;
    }
    if (!slug) {
      setModalError("customer-edit-modal", "Customer slug is required (couldn't derive one from the name).");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setModalError("customer-edit-modal", "Slug must be lowercase letters, digits, and dashes only.");
      return;
    }

    setModalSaving("customer-edit-modal", true);
    setModalError("customer-edit-modal", "");

    const db = firebase.firestore();
    try {
      const existing = await db.collection("customers").doc(slug).get();
      if (existing.exists) {
        setModalError("customer-edit-modal",
          "A customer with slug '" + slug + "' already exists. Pick a different slug.");
        setModalSaving("customer-edit-modal", false);
        return;
      }
    } catch (err) {
      handleAdminWriteError(err, { context: "customer slug-uniqueness check", modalId: "customer-edit-modal" });
      setModalSaving("customer-edit-modal", false);
      return;
    }

    const adminEmail = getCurrentAdminEmail();
    const sts        = firebase.firestore.FieldValue.serverTimestamp();
    const doc = {
      customer_slug:     slug,
      customer_name:     name,
      location_name:     location,
      customer_email:    $("cust-edit-email").value.trim(),
      active:            $("cust-edit-active").checked,
      dcr_enabled:       $("cust-edit-dcr-enabled").checked,
      dcr_email_enabled: $("cust-edit-dcr-email-enabled").checked,
      slack_channel:     $("cust-edit-slack").value.trim(),
      review_links: {
        five_star_url:   $("cust-edit-five-star").value.trim(),
        issue_url:       $("cust-edit-issue-url").value.trim()
      },
      notes:             $("cust-edit-notes").value.trim(),
      created_at:        sts,
      created_by:        adminEmail,
      updated_at:        sts,
      updated_by:        adminEmail
    };

    try {
      await db.collection("customers").doc(slug).set(doc);
      const local = Object.assign({ id: slug }, doc, {
        created_at: new Date(),
        updated_at: new Date()
      });
      customers.push(local);
      customers.sort(function (a, b) {
        return getCustomerName(a).localeCompare(getCustomerName(b));
      });
      applyCurrentCustomerFilter();
      closeModal("customer-edit-modal");
      showToast("ok", "Customer added.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer create", modalId: "customer-edit-modal" });
    } finally {
      setModalSaving("customer-edit-modal", false);
    }
  }

  async function onCustomerEditSave() {
    const id = $("cust-edit-id").value;
    if (!id) return;
    const idx = customers.findIndex(function (x) { return x.id === id; });
    if (idx < 0) {
      setModalError("customer-edit-modal", "Couldn't find this customer in the local cache. Refresh the page and try again.");
      return;
    }

    const name = $("cust-edit-name").value.trim();
    if (!name) {
      setModalError("customer-edit-modal", "Customer name is required.");
      return;
    }

    const updates = {
      customer_name:     name,
      location_name:     $("cust-edit-location").value.trim(),
      customer_email:    $("cust-edit-email").value.trim(),
      active:            $("cust-edit-active").checked,
      dcr_enabled:       $("cust-edit-dcr-enabled").checked,
      dcr_email_enabled: $("cust-edit-dcr-email-enabled").checked,
      slack_channel:     $("cust-edit-slack").value.trim(),
      review_links: {
        five_star_url:   $("cust-edit-five-star").value.trim(),
        issue_url:       $("cust-edit-issue-url").value.trim()
      },
      notes:             $("cust-edit-notes").value.trim(),
      updated_at:        firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:        getCurrentAdminEmail()
    };

    setModalSaving("customer-edit-modal", true);
    setModalError("customer-edit-modal", "");
    try {
      await firebase.firestore().collection("customers").doc(id).update(updates);
      customers[idx] = Object.assign({}, customers[idx], updates, {
        updated_at:   new Date(),
        review_links: updates.review_links
      });
      applyCurrentCustomerFilter();
      closeModal("customer-edit-modal");
      showToast("ok", "Customer updated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer save", modalId: "customer-edit-modal" });
    } finally {
      setModalSaving("customer-edit-modal", false);
    }
  }

  // Dispatcher used by admin.js's wireWriteControls — single Save button
  // serves both modes via the modal's data-mode attribute.
  function onSave() {
    const modal = $("customer-edit-modal");
    const mode  = modal ? (modal.dataset.mode || "edit") : "edit";
    if (mode === "create") onCustomerCreateSave();
    else                   onCustomerEditSave();
  }

  async function onCustomerArchive(c) {
    const name        = getCustomerName(c) || c.id;
    const isArchiving = getActive(c);
    const verb        = isArchiving ? "Archive" : "Reactivate";
    const summary     = isArchiving
      ? "They'll be hidden from the DCR form. No data is deleted — you can reactivate later."
      : "They'll reappear in the DCR form (assuming dcr_enabled stays on).";
    if (!window.confirm(verb + " " + name + "?\n\n" + summary)) return;

    const adminEmail = getCurrentAdminEmail();
    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const updates = isArchiving
      ? { active: false, archived_at: sts,  archived_by: adminEmail, updated_at: sts, updated_by: adminEmail }
      : { active: true,  archived_at: null, archived_by: null,       updated_at: sts, updated_by: adminEmail };

    try {
      await firebase.firestore().collection("customers").doc(c.id).update(updates);
      const idx = customers.findIndex(function (x) { return x.id === c.id; });
      if (idx >= 0) {
        customers[idx] = Object.assign({}, customers[idx], updates, {
          updated_at:  new Date(),
          archived_at: isArchiving ? new Date() : null
        });
      }
      applyCurrentCustomerFilter();
      showToast("ok", isArchiving ? "Customer archived." : "Customer reactivated.");
    } catch (err) {
      handleAdminWriteError(err, { context: "customer archive" });
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.customers = {
    init:            function () { /* no-op — controls wired in admin.js */ },
    refresh:         loadCustomers,
    getCustomers:    function () { return customers; },
    applyFilter:     applyCurrentCustomerFilter,
    openCreateModal: openCustomerCreateModal,
    openEditModal:   openCustomerEditModal,
    onArchive:       onCustomerArchive,
    onSave:          onSave
  };
}());
