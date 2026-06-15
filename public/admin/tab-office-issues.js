/* Pioneer DCR Hub — Admin Office Issues tab (Phase 1).
 *
 * Surface: triage all employee-submitted office_issues + change
 * status / priority / owner. Internal notes subcollection is
 * deferred to Phase 2.
 *
 * Firestore I/O:
 *   - office_issues  — read all, update status/priority/owner only.
 *
 * Lives at window.__pioneerAdmin.tabs.officeIssues.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-office-issues.js: utils + shell modules must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;
  const shell          = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }

  const CATEGORY_LABELS = {
    payroll:          "Payroll",
    schedule:         "Schedule",
    supplies:         "Supplies",
    sick_leave:       "Sick Leave",
    time_adjustment:  "Time Adjustment",
    equipment:        "Equipment",
    customer_concern: "Customer Concern",
    other:            "Other"
  };

  const STATUS_ORDER = ["new", "acknowledged", "working", "waiting", "resolved", "closed"];
  const STATUS_LABELS = {
    new:          "New",
    acknowledged: "Acknowledged",
    working:      "Working",
    waiting:      "Waiting",
    resolved:     "Resolved",
    closed:       "Closed"
  };

  const PRIORITY_ORDER  = ["low", "normal", "high", "urgent"];
  const PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

  /* ---------- module state ---------- */

  let allIssues = [];
  let filterStatus   = "open";    // "open" | "all" | <one of STATUS_ORDER>
  let filterCategory = "all";
  let loaded         = false;
  let loading        = false;
  let currentIssue   = null;      // doc being edited in the modal

  /* ---------- helpers ---------- */

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return 0;
  }
  function fmtDateTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtAge(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    const diff = Date.now() - ms;
    const mins = Math.round(diff / 60000);
    if (mins < 1)   return "just now";
    if (mins < 60)  return mins + "m";
    const hrs = Math.round(mins / 60);
    if (hrs < 48)   return hrs + "h";
    const days = Math.round(hrs / 24);
    return days + "d";
  }

  function currentAdminEmail() {
    try {
      const u = firebase.auth().currentUser;
      return u ? (u.email || "admin") : "admin";
    } catch (_) { return "admin"; }
  }
  function currentAdminUid() {
    try {
      const u = firebase.auth().currentUser;
      return (u && u.uid) || null;
    } catch (_) { return null; }
  }

  function statusChip(s) {
    const cls   = "oi-admin-chip is-" + (s || "new");
    const label = STATUS_LABELS[s] || s || "—";
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }
  function priorityChip(p) {
    if (!p || p === "normal") return "";
    const cls   = "oi-admin-prio is-" + p;
    const label = PRIORITY_LABELS[p] || p;
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  function setState(state, msg) {
    const loadingEl = $("office-issues-loading");
    const errorEl   = $("office-issues-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && msg) errorEl.textContent = msg;
    }
  }

  /* ---------- loaders ---------- */

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      const snap = await firebase.firestore()
        .collection("office_issues")
        .orderBy("created_at", "desc")
        .limit(200)
        .get();
      allIssues = snap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[office-issues] load failed", err);
      const code = err && err.code;
      const msg = code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read on office_issues."
        : "Couldn't load office issues: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderTable();
  }

  function renderHeader() {
    const sub = $("office-issues-sub");
    if (!sub) return;
    const open = allIssues.filter(function (i) {
      return i.status !== "resolved" && i.status !== "closed";
    }).length;
    sub.textContent = open + " open · " + allIssues.length + " total";
  }

  function renderTable() {
    const wrap   = $("office-issues-table");
    const empty  = $("office-issues-empty");
    if (!wrap || !empty) return;

    let list = allIssues.slice();
    if (filterStatus === "open") {
      list = list.filter(function (i) {
        return i.status !== "resolved" && i.status !== "closed";
      });
    } else if (filterStatus !== "all") {
      list = list.filter(function (i) { return i.status === filterStatus; });
    }
    if (filterCategory !== "all") {
      list = list.filter(function (i) { return i.category === filterCategory; });
    }

    if (!list.length) {
      wrap.innerHTML = "";
      empty.hidden = false;
      empty.textContent = allIssues.length === 0
        ? "No office issues yet."
        : "No issues match the current filters.";
      return;
    }
    empty.hidden = true;

    const headerHtml =
      '<div class="oi-admin-row oi-admin-row-head">' +
        '<div class="oi-col-status">Status</div>' +
        '<div class="oi-col-cat">Category</div>' +
        '<div class="oi-col-emp">Employee</div>' +
        '<div class="oi-col-desc">Description</div>' +
        '<div class="oi-col-prio">Priority</div>' +
        '<div class="oi-col-owner">Owner</div>' +
        '<div class="oi-col-age">Age</div>' +
      '</div>';

    const rowsHtml = list.map(function (i) {
      const cat   = CATEGORY_LABELS[i.category] || i.category || "—";
      const desc  = String(i.description || "").slice(0, 100) +
                    (String(i.description || "").length > 100 ? "…" : "");
      const owner = i.owner_email
        ? escapeHtml(i.owner_email)
        : '<span class="oi-admin-muted">— unassigned —</span>';
      return (
        '<div class="oi-admin-row" data-issue-id="' + escapeHtml(i._id) + '" role="button" tabindex="0">' +
          '<div class="oi-col-status">' + statusChip(i.status) + '</div>' +
          '<div class="oi-col-cat">'    + escapeHtml(cat) + '</div>' +
          '<div class="oi-col-emp">'    + escapeHtml(i.employee_name || i.employee_email || "—") + '</div>' +
          '<div class="oi-col-desc">'   + escapeHtml(desc) + '</div>' +
          '<div class="oi-col-prio">'   + (priorityChip(i.priority) || '<span class="oi-admin-muted">normal</span>') + '</div>' +
          '<div class="oi-col-owner">'  + owner + '</div>' +
          '<div class="oi-col-age">'    + escapeHtml(fmtAge(i.created_at)) + '</div>' +
        '</div>'
      );
    }).join("");

    wrap.innerHTML = headerHtml + rowsHtml;
  }

  /* ---------- modal ---------- */

  function openIssueModal(issue) {
    currentIssue = issue;
    const modal = $("office-issues-modal");
    if (!modal) return;

    $("office-issues-modal-title").textContent =
      "Issue from " + (issue.employee_name || issue.employee_email || "Staff");

    $("office-issues-modal-meta").innerHTML =
      '<div><strong>Category</strong>: ' + escapeHtml(CATEGORY_LABELS[issue.category] || issue.category || "—") + '</div>' +
      '<div><strong>Submitted</strong>: ' + escapeHtml(fmtDateTime(issue.created_at)) + '</div>' +
      '<div><strong>Source</strong>: ' + escapeHtml(issue.source || "employee_submission") + '</div>' +
      '<div><strong>Employee</strong>: ' + escapeHtml(issue.employee_email || "—") + '</div>' +
      '<div><strong>Issue ID</strong>: <code style="font-size:11px;">' + escapeHtml(issue._id) + '</code></div>';

    $("office-issues-modal-description").textContent = issue.description || "—";

    const statusSel = $("office-issues-status");
    if (statusSel) statusSel.value = issue.status || "new";
    const prioSel = $("office-issues-priority");
    if (prioSel) prioSel.value = issue.priority || "normal";
    const ownerInput = $("office-issues-owner-email");
    if (ownerInput) ownerInput.value = issue.owner_email || "";

    const errEl = $("office-issues-modal-err");
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    const modal = $("office-issues-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    currentIssue = null;
  }

  async function saveIssueChanges() {
    const errEl   = $("office-issues-modal-err");
    const saveBtn = $("office-issues-modal-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    if (!currentIssue) { showErr("No issue loaded."); return; }
    const newStatus     = String(($("office-issues-status")      && $("office-issues-status").value)      || "").trim();
    const newPriority   = String(($("office-issues-priority")    && $("office-issues-priority").value)    || "").trim();
    const newOwnerEmail = String(($("office-issues-owner-email") && $("office-issues-owner-email").value) || "").trim().toLowerCase();

    if (STATUS_ORDER.indexOf(newStatus)    < 0) { showErr("Pick a valid status.");   return; }
    if (PRIORITY_ORDER.indexOf(newPriority) < 0) { showErr("Pick a valid priority."); return; }
    if (newOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newOwnerEmail)) {
      showErr("Owner email looks invalid. Leave blank to unassign.");
      return;
    }

    // No-op guard.
    const prevStatus     = currentIssue.status || "new";
    const prevPriority   = currentIssue.priority || "normal";
    const prevOwnerEmail = String(currentIssue.owner_email || "").toLowerCase();
    if (newStatus === prevStatus && newPriority === prevPriority && newOwnerEmail === prevOwnerEmail) {
      showErr("Nothing changed.");
      return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
      const db  = firebase.firestore();
      const ref = db.collection("office_issues").doc(currentIssue._id);
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const adminEmail = currentAdminEmail();
      const adminUid   = currentAdminUid();

      const update = {
        status:     newStatus,
        priority:   newPriority,
        updated_at: sts
      };
      // Owner: empty string → unassign. Otherwise denormalize email; uid
      // resolution from email is deferred to Phase 2 (Cloud Function lookup).
      if (newOwnerEmail) {
        update.owner_email = newOwnerEmail;
        // owner_uid stays null in Phase 1 — we only have the email surface
        // from the admin form. Owner-by-uid assignment will land with the
        // proper picker in Phase 2.
        update.owner_uid   = null;
      } else {
        update.owner_email = null;
        update.owner_uid   = null;
      }

      // Terminal-state timestamps. Stamp once on transition; never clear.
      if (newStatus === "acknowledged" && !currentIssue.acknowledged_at) update.acknowledged_at = sts;
      if (newStatus === "resolved"     && !currentIssue.resolved_at)     update.resolved_at     = sts;
      if (newStatus === "closed"       && !currentIssue.closed_at)       update.closed_at       = sts;

      // Append to status_history when status actually changed. The doc
      // already has the initial "new" entry from submission.
      if (newStatus !== prevStatus) {
        update.status_history = firebase.firestore.FieldValue.arrayUnion({
          status:   newStatus,
          at:       new Date().toISOString(),
          by_uid:   adminUid,
          by_email: adminEmail
        });
      }

      await ref.update(update);
      shell.showToast("ok", "Issue updated.");
      closeModal();
      await refresh();
    } catch (err) {
      console.error("[office-issues] save failed", err);
      const msg = (err && (err.message || err.code)) || "Save failed.";
      showErr(msg);
      shell.showToast("err", "Save failed — " + msg);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- wire-up ---------- */

  function findIssueById(id) {
    return allIssues.find(function (i) { return i._id === id; }) || null;
  }

  function wire() {
    const refreshBtn = $("office-issues-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    const statusFilter   = $("office-issues-filter-status");
    const categoryFilter = $("office-issues-filter-category");
    if (statusFilter) statusFilter.addEventListener("change", function () {
      filterStatus = statusFilter.value || "open";
      renderTable();
    });
    if (categoryFilter) categoryFilter.addEventListener("change", function () {
      filterCategory = categoryFilter.value || "all";
      renderTable();
    });

    // Delegated row click → open modal.
    document.addEventListener("click", function (ev) {
      const row = ev.target.closest && ev.target.closest(".oi-admin-row[data-issue-id]");
      if (!row) return;
      const id = row.dataset.issueId;
      if (!id) return;
      const issue = findIssueById(id);
      if (issue) openIssueModal(issue);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      const row = ev.target && ev.target.closest && ev.target.closest(".oi-admin-row[data-issue-id]");
      if (!row) return;
      const id = row.dataset.issueId;
      if (!id) return;
      const issue = findIssueById(id);
      if (issue) openIssueModal(issue);
    });

    const saveBtn = $("office-issues-modal-save");
    if (saveBtn) saveBtn.addEventListener("click", saveIssueChanges);

    // Modal close affordances — backdrop + close buttons share data-modal-close.
    const modal = $("office-issues-modal");
    if (modal) {
      modal.addEventListener("click", function (ev) {
        if (ev.target.closest && ev.target.closest("[data-modal-close]")) closeModal();
      });
    }
  }

  /* ---------- export ---------- */

  function init() { wire(); }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.officeIssues = {
    init:    init,
    refresh: refresh
  };
}());
