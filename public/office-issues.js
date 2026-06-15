/* Pioneer DCR Hub — Message the Office page (Phase 1).
 *
 * Employee-facing surface for submitting office_issues docs +
 * watching their own status. Admin triage lives in /admin
 * (tab-office-issues.js). Future ingest channels (customer email,
 * external complaint webhook) will write into the same collection
 * with source != "employee_submission" via Cloud Functions.
 *
 * Read/write surface (all admin-gated where it matters; see firestore.rules):
 *   - office_issues   create (own) + read (own)
 */
(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };

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

  const STATUS_LABELS = {
    new:          "New",
    acknowledged: "Acknowledged",
    working:      "Working",
    waiting:      "Waiting",
    resolved:     "Resolved",
    closed:       "Closed"
  };

  // Mirror of ROLE_NAV from the other staff pages. KEEP IN SYNC across
  // app.js / tech.js / admin.js / supply-station.js / team-hub.js /
  // work.js. New entry "office-issues" added here in V20260615.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",            roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                     roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",            roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html",  roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",        roles: ["admin", "cleaning_tech"] },
    { key: "office-issues",  label: "Message the Office",   href: "/office-issues.html",   roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",        roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",     roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",                roles: ["admin"] }
  ];

  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }
    const current = nav.dataset.currentPage || "";
    const items   = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = (i.key === current);
      const cls   = "role-nav-link" + (isActive ? " is-active" : "");
      const aria  = isActive ? ' aria-current="page"' : "";
      if (isActive) return '<span class="' + cls + '"' + aria + '>' + i.label + '</span>';
      return '<a class="' + cls + '" href="' + i.href + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  function setAuthState(state) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("staff-auth-" + s);
      if (el) el.hidden = s !== state;
    });
    const content = $("staff-auth-content");
    if (content) content.hidden = state !== "content";
    document.body.classList.toggle("is-signing-in", state === "signin");
    const headerAccount = $("staff-header-account");
    const headerEmail   = $("staff-header-email");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
    } else {
      if (headerAccount) headerAccount.hidden = true;
      if (headerEmail)   headerEmail.textContent = "";
      const nameEl = $("staff-header-name");
      if (nameEl) nameEl.textContent = "";
    }
  }

  function paintIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    const cached  = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
                      ? window.STAFF_AUTH.getCachedStaff() : null;
    const displayName =
      (staff && staff.tech && staff.tech.display_name) ||
      (cached && cached.display_name) ||
      "";
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
  }

  function showToast(kind, msg) {
    const root = document.getElementById("toast-container");
    if (!root) return;
    const t = document.createElement("div");
    t.className = "toast toast-" + kind;
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (_e) {} }, 4500);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return 0;
  }

  function fmtAge(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    const diff = Date.now() - ms;
    const mins = Math.round(diff / 60000);
    if (mins < 1)   return "just now";
    if (mins < 60)  return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 48)   return hrs + "h ago";
    const days = Math.round(hrs / 24);
    return days + "d ago";
  }

  function statusChip(s) {
    const cls   = "oi-chip is-" + (s || "new");
    const label = STATUS_LABELS[s] || s || "—";
    return '<span class="' + cls + '">' + escapeHtml(label) + '</span>';
  }

  /* ---------- writers ---------- */

  let currentStaff = null;
  let submitting   = false;

  async function submitNewIssue() {
    if (submitting) return;
    const errEl   = $("oi-form-err");
    const btn     = $("oi-submit");
    const catEl   = $("oi-category");
    const descEl  = $("oi-description");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    const category    = String((catEl && catEl.value) || "").trim();
    const description = String((descEl && descEl.value) || "").trim();
    if (!category)            { showErr("Pick a category.");                                          return; }
    if (!CATEGORY_LABELS[category]) { showErr("Pick one of the listed categories.");                  return; }
    if (description.length < 5) { showErr("Please write at least 5 characters describing the issue."); return; }
    if (description.length > 4000) { showErr("Description is too long (max 4000 characters).");        return; }
    if (!currentStaff || !currentStaff.uid) { showErr("Sign-in lost. Please refresh the page.");      return; }

    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    submitting = true;
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    try {
      const db  = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const employee_uid   = currentStaff.uid;
      const employee_email = String(currentStaff.email || "").toLowerCase().trim();
      const employee_name  =
        (currentStaff.tech && currentStaff.tech.display_name) ||
        currentStaff.display_name ||
        employee_email ||
        "Staff";

      const ref = db.collection("office_issues").doc();
      await ref.set({
        issue_id:        ref.id,
        source:          "employee_submission",
        employee_uid:    employee_uid,
        employee_email:  employee_email,
        employee_name:   employee_name,
        category:        category,
        description:     description,
        status:          "new",
        priority:        "normal",
        owner_uid:       null,
        owner_email:     null,
        created_at:      sts,
        updated_at:      sts,
        acknowledged_at: null,
        resolved_at:     null,
        closed_at:       null,
        // Append-only timeline. Phase 1 writes only the initial entry;
        // admin status transitions append from the admin tab.
        status_history: [{
          status:   "new",
          at:       new Date().toISOString(),
          by_uid:   employee_uid,
          by_email: employee_email
        }]
      });

      // Reset form + toast. The onSnapshot subscription picks up the
      // new doc automatically — no manual reload needed.
      if (catEl)  catEl.value  = "";
      if (descEl) descEl.value = "";
      showToast("ok", "Sent to the office. We'll respond.");
    } catch (err) {
      console.error("[office-issues] submit failed", err);
      const code = (err && err.code) || "";
      const msg = code === "permission-denied"
        ? "Permission denied. Are you signed in as active staff?"
        : "Couldn't send: " + ((err && err.message) || "try again");
      showErr(msg);
      showToast("err", msg);
    } finally {
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = "Send to office"; }
    }
  }

  /* ---------- readers ---------- */

  let unsubscribeMine = null;

  // V20260615b — Real-time subscription. Replaces the one-shot .get()
  // so techs see admin status changes / owner assignments without a
  // manual refresh. Subscription lives for the page session; the
  // Refresh button forces a re-subscribe (handy after the initial
  // index is built).
  function loadMyIssues() {
    if (!currentStaff || !currentStaff.uid) return;
    if (unsubscribeMine) {
      try { unsubscribeMine(); } catch (_e) {}
      unsubscribeMine = null;
    }
    const loadingEl = $("oi-my-loading");
    const errorEl   = $("oi-my-error");
    const emptyEl   = $("oi-my-empty");
    const listEl    = $("oi-my-list");
    if (loadingEl) loadingEl.hidden = false;
    if (errorEl)   errorEl.hidden   = true;
    if (emptyEl)   emptyEl.hidden   = true;
    if (listEl)    listEl.innerHTML = "";

    try {
      const q = firebase.firestore().collection("office_issues")
        .where("employee_uid", "==", currentStaff.uid)
        .orderBy("created_at", "desc")
        .limit(50);
      unsubscribeMine = q.onSnapshot(
        function (snap) {
          if (loadingEl) loadingEl.hidden = true;
          const docs = snap.docs.map(function (d) {
            return Object.assign({ _id: d.id }, d.data() || {});
          });
          if (!docs.length) {
            if (listEl)  listEl.innerHTML = "";
            if (emptyEl) emptyEl.hidden = false;
          } else {
            if (emptyEl) emptyEl.hidden = true;
            if (listEl)  listEl.innerHTML = docs.map(renderRow).join("");
          }
        },
        function (err) {
          console.error("[office-issues] subscription failed", err);
          const code = (err && err.code) || "";
          const msg = code === "failed-precondition"
            ? "Couldn't load your issues — Firestore index still building. Refresh in a minute."
            : code === "permission-denied"
              ? "Permission denied loading your issues. Confirm sign-in."
              : "Couldn't load your issues: " + ((err && err.message) || "unknown");
          if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; }
          if (loadingEl) loadingEl.hidden = true;
        }
      );
    } catch (err) {
      console.error("[office-issues] subscribe crashed", err);
      if (errorEl) { errorEl.textContent = "Subscription error: " + ((err && err.message) || "unknown"); errorEl.hidden = false; }
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  function renderRow(d) {
    const cat  = CATEGORY_LABELS[d.category] || d.category || "—";
    const desc = String(d.description || "").slice(0, 180);
    const truncated = String(d.description || "").length > 180 ? "…" : "";
    return (
      '<article class="oi-row" data-issue-id="' + escapeHtml(d._id) + '">' +
        '<div class="oi-row-head">' +
          statusChip(d.status) +
          '<span class="oi-row-cat">' + escapeHtml(cat) + '</span>' +
          '<span class="oi-row-age">' + escapeHtml(fmtAge(d.created_at)) + '</span>' +
        '</div>' +
        '<p class="oi-row-desc">' + escapeHtml(desc) + escapeHtml(truncated) + '</p>' +
      '</article>'
    );
  }

  /* ---------- wire-up ---------- */

  function wire() {
    const form    = $("oi-form");
    const refresh = $("oi-refresh");
    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        submitNewIssue();
      });
    }
    if (refresh) {
      refresh.addEventListener("click", function () { loadMyIssues(); });
    }
  }

  /* ---------- boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    setAuthState("checking");
    if (!window.STAFF_AUTH || typeof window.STAFF_AUTH.init !== "function") {
      console.error("[office-issues] staff-auth.js failed to load");
      setAuthState("signin");
      return;
    }
    window.STAFF_AUTH.init({
      onChecking:  function () { setAuthState("checking"); },
      onSignedOut: function () { setAuthState("signin"); },
      onDenied:    function (info) {
        setAuthState("denied");
        const msgEl = $("staff-auth-denied-msg");
        if (msgEl && info && info.message) msgEl.textContent = info.message;
      },
      onAuthorized: function (staff) {
        currentStaff = staff;
        setAuthState("content");
        paintIdentity(staff);
        renderRoleNav(staff && staff.role);
        loadMyIssues();
      }
    });
  });
}());
