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
  const getCurrentAdminEmail             = window.__pioneerAdmin.shell.getCurrentAdminEmail;
  const handleAdminWriteError            = window.__pioneerAdmin.shell.handleAdminWriteError;
  const setModalError                    = window.__pioneerAdmin.shell.setModalError;
  const setModalSaving                   = window.__pioneerAdmin.shell.setModalSaving;
  const populateCustomerDeputyIntegration = function (c) { return window.__pioneerAdmin.tabs.deputyMapping.populateCustomerIntegration(c); };

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
    if (!c) return;
    if (publicBody && window.CustomerSop && typeof window.CustomerSop.renderPublic === "function") {
      window.CustomerSop.renderPublic(publicBody, c);
    } else if (publicBody) {
      publicBody.innerHTML = '<div class="sop-empty">customer-sop.js not loaded.</div>';
    }
    // Phase 1g — Access & Security editor + Standing Notes summary
    // replace the prior renderSecure(secureBody) read-only display.
    const slug = getCustomerSlug(c);
    populateAccessSecurityEditor(slug);
    populateStandingNotesSummary(slug);
  }

  /* ---- Phase 1g: Access & Security Info editor ----
   *
   * Reads customer_secure/{slug} once when the modal opens and hydrates
   * the 10 textareas (8 tech-visible + 2 admin-only) + read-only raw
   * Deputy notes block + last-edited stamp. Stashes the original snapshot
   * on the modal element so the save handler can no-op when nothing
   * changed (preserving the "empty-everything → don't create empty doc"
   * invariant from Phase 1g requirements).
   *
   * NEVER logs the textarea values. NEVER persists them anywhere except
   * customer_secure/{slug}. Codes are kept out of console / event streams.
   */
  const SECURE_FIELD_IDS = {
    // Tech-visible
    alarmCodes:          "cust-edit-alarm-codes",
    disarmInstructions:  "cust-edit-disarm-instructions",
    doorCodes:           "cust-edit-door-codes",
    gateCodes:           "cust-edit-gate-codes",
    lockboxCodes:        "cust-edit-lockbox-codes",
    keyFobNotes:         "cust-edit-key-fob-notes",
    armInstructions:     "cust-edit-arm-instructions",
    secureInstructions:  "cust-edit-secure-instructions",
    // Admin-only
    emergencyContacts:   "cust-edit-emergency-contacts",
    alarmCompanyNotes:   "cust-edit-alarm-company-notes"
  };
  const SECURE_TECH_VISIBLE_KEYS = [
    "alarmCodes", "disarmInstructions", "doorCodes", "gateCodes",
    "lockboxCodes", "keyFobNotes", "armInstructions", "secureInstructions"
  ];
  const SECURE_ADMIN_ONLY_KEYS = ["emergencyContacts", "alarmCompanyNotes"];

  function joinLines(arr) {
    if (!Array.isArray(arr)) return "";
    return arr
      .map(function (s) { return String(s == null ? "" : s); })
      .filter(function (s) { return s.length > 0; })
      .join("\n");
  }
  function splitLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
  }
  function tsToMillisSecure(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function fmtSecureDate(ts) {
    const ms = tsToMillisSecure(ts);
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return ""; }
  }

  async function populateAccessSecurityEditor(slug) {
    const modal = $("customer-edit-modal");
    if (!modal) return;
    // Reset everything first so a previous customer's data doesn't ghost in.
    Object.keys(SECURE_FIELD_IDS).forEach(function (k) {
      const el = $(SECURE_FIELD_IDS[k]);
      if (el) el.value = "";
    });
    const rawEl = $("cust-edit-raw-deputy-notes");
    if (rawEl) rawEl.textContent = "—";
    const stampEl = $("cust-edit-secure-last-edited");
    if (stampEl) stampEl.textContent = "Loading…";
    delete modal.dataset.secureExisted;
    delete modal.dataset.secureSlug;

    if (!slug) {
      if (stampEl) stampEl.textContent = "No customer slug — open this customer from the list to edit.";
      return;
    }
    modal.dataset.secureSlug = slug;
    try {
      const snap = await firebase.firestore().collection("customer_secure").doc(slug).get();
      if (snap.exists) {
        modal.dataset.secureExisted = "true";
        const data = snap.data() || {};
        Object.keys(SECURE_FIELD_IDS).forEach(function (k) {
          const el = $(SECURE_FIELD_IDS[k]);
          if (el) el.value = joinLines(data[k]);
        });
        if (rawEl) rawEl.textContent = data.rawDeputyNotes
          ? String(data.rawDeputyNotes)
          : "—";
        const editedAt = data.lastEditedAt || data.sourceUpdatedAt || data.parsedAt;
        const editedBy = data.lastEditedBy ||
          (data.parserVersion ? "Deputy import (" + data.parserVersion + ")" : "Deputy import");
        const when = fmtSecureDate(editedAt);
        if (stampEl) {
          stampEl.textContent = when
            ? ("Last edited " + when + " by " + editedBy)
            : "No Access & Security edits recorded yet.";
        }
      } else {
        modal.dataset.secureExisted = "false";
        if (stampEl) stampEl.textContent = "No Access & Security info on file yet.";
      }
    } catch (err) {
      // Don't echo error details into the DOM with raw user-controlled
      // strings; this view stays admin-only anyway, but keep it minimal.
      if (stampEl) stampEl.textContent =
        "Couldn't load Access & Security: " + (err && err.code || err && err.message || "unknown");
    }
  }

  function readAccessSecurityFromForm() {
    const out = {};
    Object.keys(SECURE_FIELD_IDS).forEach(function (k) {
      const el = $(SECURE_FIELD_IDS[k]);
      out[k] = splitLines(el && el.value);
    });
    return out;
  }
  function accessSecurityIsEmpty(values) {
    const all = SECURE_TECH_VISIBLE_KEYS.concat(SECURE_ADMIN_ONLY_KEYS);
    for (let i = 0; i < all.length; i++) {
      if (Array.isArray(values[all[i]]) && values[all[i]].length > 0) return false;
    }
    return true;
  }
  function computeHasSecureSop(values, rawDeputyNotes) {
    const all = SECURE_TECH_VISIBLE_KEYS.concat(SECURE_ADMIN_ONLY_KEYS);
    for (let i = 0; i < all.length; i++) {
      if (Array.isArray(values[all[i]]) && values[all[i]].length > 0) return true;
    }
    if (rawDeputyNotes && String(rawDeputyNotes).trim().length > 0) return true;
    return false;
  }

  /* ---- Phase 1g: Standing Cleaning Notes read-only summary ---- */

  async function populateStandingNotesSummary(slug) {
    const root = $("cust-edit-standing-notes-body");
    if (!root) return;
    root.textContent = "Loading…";
    if (!slug) { root.textContent = "—"; return; }
    try {
      const snap = await firebase.firestore().collection("customer_notes")
        .where("customer_slug", "==", slug)
        .limit(20)
        .get();
      const notes = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); })
        .filter(function (n) { return n.active !== false; });
      if (!notes.length) {
        root.innerHTML =
          '<p class="standing-notes-empty">No standing notes for this customer yet. ' +
          'Add one in the <strong>Customer Notes</strong> tab.</p>';
        return;
      }
      notes.sort(function (a, b) {
        return tsToMillisSecure(b.updated_at) - tsToMillisSecure(a.updated_at);
      });
      const top = notes.slice(0, 5);
      const more = notes.length - top.length;
      root.innerHTML =
        '<ul class="standing-notes-summary-list">' +
        top.map(function (n) {
          const title = escapeHtml(n.title || "(untitled)");
          const cat   = escapeHtml(n.category || "Other");
          return '<li><span class="standing-notes-cat">' + cat + '</span> ' +
                 '<strong>' + title + '</strong></li>';
        }).join("") +
        '</ul>' +
        (more > 0
          ? '<p class="standing-notes-more">+ ' + more + ' more in Customer Notes tab</p>'
          : '');
    } catch (err) {
      root.textContent = "Couldn't load standing notes: " +
        ((err && err.code) || (err && err.message) || "unknown");
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

    // Phase 1g — read the Access & Security textareas + decide what to
    // commit. Three branches:
    //   (a) doc didn't exist AND everything blank → skip customer_secure
    //       write entirely (no empty doc created); hasSecureSop stays
    //       whatever it was on the public doc (likely false).
    //   (b) doc existed AND everything cleared → write empty arrays to
    //       customer_secure (merge:true) so a Firestore-Console reader
    //       sees the explicit clear; hasSecureSop recomputed from the
    //       saved arrays (false if no field has content AND no raw
    //       Deputy notes remain on the existing doc).
    //   (c) anything non-empty → write the arrays + stamp last-edited
    //       fields; hasSecureSop true if anything has content.
    const modal = $("customer-edit-modal");
    const secureExisted = (modal && modal.dataset.secureExisted === "true");
    const secureSlug = (modal && modal.dataset.secureSlug) || id;
    const secureValues = readAccessSecurityFromForm();
    const allBlank = accessSecurityIsEmpty(secureValues);
    const writeSecureDoc = secureExisted || !allBlank;

    // For hasSecureSop, also consider the rawDeputyNotes that may exist
    // on the secure doc today (admin can't edit it from this UI; preserve
    // its contribution to hasSecureSop when present).
    let secureRawNotes = "";
    if (writeSecureDoc) {
      try {
        const existingSnap = await firebase.firestore()
          .collection("customer_secure").doc(secureSlug).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() || {};
          secureRawNotes = String(existingData.rawDeputyNotes || "");
        }
      } catch (_e) { /* swallow — fall through with empty raw notes */ }
    }
    const hasSecureSop = writeSecureDoc
      ? computeHasSecureSop(secureValues, secureRawNotes)
      : !!(customers[idx] && customers[idx].hasSecureSop);

    // Augment the public doc update with the hasSecureSop flag whenever
    // we're touching customer_secure so the public flag stays in sync.
    if (writeSecureDoc) {
      updates.hasSecureSop = hasSecureSop;
    }

    setModalSaving("customer-edit-modal", true);
    setModalError("customer-edit-modal", "");
    try {
      const db = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const batch = db.batch();
      const custRef = db.collection("customers").doc(id);
      batch.update(custRef, updates);

      if (writeSecureDoc) {
        const securePayload = Object.assign({}, secureValues, {
          lastEditedAt:    sts,
          lastEditedBy:    getCurrentAdminEmail(),
          lastEditedVia:   "admin_ui"
        });
        const secureRef = db.collection("customer_secure").doc(secureSlug);
        batch.set(secureRef, securePayload, { merge: true });
      }
      await batch.commit();

      customers[idx] = Object.assign({}, customers[idx], updates, {
        updated_at:   new Date(),
        review_links: updates.review_links
      });
      applyCurrentCustomerFilter();
      closeModal("customer-edit-modal");
      showToast("ok", writeSecureDoc
        ? "Customer + Access & Security updated."
        : "Customer updated.");
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

  /* ---------- one-time wiring ----------
   * Phase 25c: search input + list event delegation + modal save button +
   * "+ Add customer" trigger + auto-slug listeners moved from admin.js
   * (wireSearch + wireWriteControls) into this module. The customers
   * array lives here, so the list-delegation reads it directly instead of
   * via the deps bridge. slugifyCustomerCandidate (already local) replaces
   * the slugifyForTech call admin.js used for the auto-slug — same body,
   * same output, behavior identical. Boot calls tabs.customers.init().
   */
  function wireCustomerControls() {
    // Search input — calls applyCurrentCustomerFilter directly. Same
    // post-save-friendly re-filter behavior as before.
    const cs = $("customer-search");
    if (cs) cs.addEventListener("input", function () { applyCurrentCustomerFilter(); });

    // List event delegation — Edit / Archive clicks. The customers array
    // is owned by this module; no deps bridge lookup needed.
    const custRoot = $("customer-list");
    if (custRoot) {
      custRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-id]");
        if (!row) return;
        const c = customers.find(function (x) { return x.id === row.dataset.id; });
        if (!c) return;
        if (btn.dataset.action === "edit")    openCustomerEditModal(c);
        if (btn.dataset.action === "archive") onCustomerArchive(c);
      });
    }

    // Customer save button — dispatches edit vs create on modal data-mode.
    const custSave = $("customer-edit-save");
    if (custSave) custSave.addEventListener("click", function () { onSave(); });

    // "+ Add customer" — opens the modal in create mode.
    const custCreateOpen = $("customer-create-open");
    if (custCreateOpen) custCreateOpen.addEventListener("click", function () {
      openCustomerCreateModal();
    });

    // Auto-slug on the customer-create modal — derive from location_name
    // (preferred) or customer_name as the admin types, until the admin
    // touches the slug field themselves. Mode-gated on data-mode="create".
    const custNameEl     = $("cust-edit-name");
    const custLocationEl = $("cust-edit-location");
    const custSlugEl     = $("cust-create-slug");
    function refreshAutoCustSlug() {
      const modal = $("customer-edit-modal");
      if (!modal || modal.dataset.mode !== "create") return;
      if (!custSlugEl) return;
      if (custSlugEl.dataset.touched === "1") return;
      const src = (custLocationEl && custLocationEl.value.trim()) ||
                  (custNameEl     && custNameEl.value.trim())     || "";
      custSlugEl.value = slugifyCustomerCandidate(src);
    }
    if (custSlugEl) {
      custSlugEl.addEventListener("input", function () { custSlugEl.dataset.touched = "1"; });
    }
    if (custNameEl)     custNameEl.addEventListener("input",     refreshAutoCustSlug);
    if (custLocationEl) custLocationEl.addEventListener("input", refreshAutoCustSlug);
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.customers = {
    init:            wireCustomerControls,
    refresh:         loadCustomers,
    getCustomers:    function () { return customers; },
    applyFilter:     applyCurrentCustomerFilter,
    openCreateModal: openCustomerCreateModal,
    openEditModal:   openCustomerEditModal,
    onArchive:       onCustomerArchive,
    onSave:          onSave
  };
}());
