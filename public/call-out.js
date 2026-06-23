/* Pioneer DCR Hub — /call-out.html controller.
 *
 * Urgent shift-issue submission. Writes to `call_outs` (Firestore) +
 * a `notifications` doc the admin badge reads.
 *
 * Phase 2 TODO:
 *   • Cloud Function trigger on create → email Kirby
 *   • SMS escalation if status stays "new" longer than 15 minutes
 *   • Notify tech back when acknowledged */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // KEEP IN SYNC with the other staff pages.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",            roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                     roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",            roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html",  roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",        roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",        roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",     roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",                roles: ["admin"] }
  ];

  let currentStaff = null;

  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav || !role) return;
    const current = nav.dataset.currentPage || "";
    const items = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = i.key === current;
      const cls = "role-nav-link" + (isActive ? " is-active" : "");
      return isActive
        ? '<span class="' + cls + '" aria-current="page">' + i.label + '</span>'
        : '<a class="' + cls + '" href="' + i.href + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  function setStaffAuthState(state) {
    ["staff-auth-checking", "staff-auth-signin", "staff-auth-denied"].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.hidden = (state !== id.replace("staff-auth-", ""));
    });
    const content = $("staff-auth-content");
    const account = $("staff-header-account");
    if (state === "content") {
      if (content) content.hidden = false;
      if (account) account.hidden = false;
    } else {
      if (content) content.hidden = true;
      if (account) account.hidden = true;
    }
  }

  function paintStaffIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    const displayName =
      (staff && staff.display_name) ||
      (staff && staff.tech && staff.tech.display_name) ||
      "";
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
    const techEl = $("callout-tech-display");
    if (techEl)  techEl.textContent  = displayName || staff.email || "—";
  }

  function pacificDateToday() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function setStatus(text) {
    const el = $("callout-status");
    if (el) el.textContent = text || "";
  }
  function setError(msg) {
    const el = $("callout-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function onSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setError("");
    setStatus("");

    if (!currentStaff || !currentStaff.uid) {
      setError("Not signed in. Refresh the page and try again.");
      return;
    }
    const u = firebase.auth().currentUser;
    if (!u) { setError("Not signed in. Refresh the page and try again."); return; }

    const dateEl   = $("callout-date");
    const shiftEl  = $("callout-shift-customer");
    const reasonEl = document.querySelector("input[name='callout-reason']:checked");
    const noteEl   = $("callout-note");

    const date = (dateEl && dateEl.value || "").trim();
    if (!date) { setError("Pick a date."); return; }
    if (!reasonEl) { setError("Pick a reason."); return; }

    const submitBtn = $("callout-submit");
    if (submitBtn) submitBtn.disabled = true;

    const tech = currentStaff.tech || {};
    const techId   = tech.slug || tech.tech_slug || "";
    const techName = tech.display_name || currentStaff.display_name || currentStaff.email || "Tech";
    const payload  = {
      techId:         techId,
      techName:       techName,
      techUid:        u.uid,
      techEmail:      (currentStaff.email || u.email || "").toLowerCase(),
      date:           date,
      shiftCustomer: (shiftEl && shiftEl.value || "").trim() || null,
      reason:         reasonEl.value,
      note:           (noteEl && noteEl.value || "").trim() || null,
      submittedAt:    firebase.firestore.FieldValue.serverTimestamp(),
      status:         "new",
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt:     null,
      resolvedBy:     null,
      coverageNote:   null
    };

    setStatus("Submitting…");
    const db = firebase.firestore();
    db.collection("call_outs").add(payload)
      .then(function (ref) {
        // Best-effort notification doc for the admin badge. If this
        // fails (rules / quota) the call-out itself is still recorded,
        // so we don't block the user on it.
        db.collection("notifications").add({
          type:         "call_out",
          refId:        ref.id,
          createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
          createdByUid: u.uid,
          summary:      techName + " called out for " + date + " (" + reasonEl.value + ")",
          status:       "unread"
        }).catch(function (err) { console.warn("[call-out] notification write failed (non-fatal)", err); });
        setStatus("Submitted. The office team has been notified.");
        if (submitBtn) submitBtn.disabled = false;
        // Reset form except date (commonly the same day).
        if (shiftEl)  shiftEl.value = "";
        if (noteEl)   noteEl.value = "";
        if (reasonEl) reasonEl.checked = false;
        loadOwnHistory();
      })
      .catch(function (err) {
        console.error("[call-out] submit failed", err);
        setError(
          err && err.code === "permission-denied"
            ? "Permission denied. Confirm your account is active and try again."
            : ("Submit failed: " + (err && (err.message || err.code)) || "unknown error")
        );
        setStatus("");
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  function reasonLabel(v) {
    switch (v) {
      case "sick":           return "Sick";
      case "emergency":      return "Emergency";
      case "transportation": return "Transportation issue";
      case "family":         return "Family issue";
      case "running_late":   return "Running late";
      case "other":          return "Other";
      default:               return v || "—";
    }
  }
  function statusChip(s) {
    const map = { new: "New", acknowledged: "Acknowledged", resolved: "Resolved" };
    const label = map[s] || s || "—";
    return '<span class="attendance-chip attendance-chip--' + (s || "new") + '">' + label + '</span>';
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function formatSubmittedAt(ts) {
    if (!ts) return "—";
    let ms = null;
    if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    if (ms == null) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) { return new Date(ms).toLocaleString(); }
  }

  async function loadOwnHistory() {
    const u = firebase.auth().currentUser;
    if (!u) return;
    try {
      const snap = await firebase.firestore()
        .collection("call_outs")
        .where("techUid", "==", u.uid)
        .orderBy("submittedAt", "desc")
        .limit(5)
        .get();
      const list = $("callout-history-list");
      const wrap = $("callout-history-section");
      if (!list || !wrap) return;
      if (snap.empty) { wrap.hidden = true; return; }
      list.innerHTML = snap.docs.map(function (d) {
        const x = d.data() || {};
        return (
          '<li class="attendance-history-row">' +
            '<div class="attendance-history-row-main">' +
              '<div class="attendance-history-row-title">' + escapeHtml(reasonLabel(x.reason)) +
                ' · ' + escapeHtml(x.date || "—") + '</div>' +
              (x.shiftCustomer
                ? '<div class="attendance-history-row-sub">' + escapeHtml(x.shiftCustomer) + '</div>'
                : '') +
              '<div class="attendance-history-row-meta">Submitted ' + formatSubmittedAt(x.submittedAt) + '</div>' +
            '</div>' +
            statusChip(x.status) +
          '</li>'
        );
      }).join("");
      wrap.hidden = false;
    } catch (err) {
      // Index error on first run is fine; the section just stays hidden.
      console.warn("[call-out] history load failed", err);
    }
  }

  function bootForStaff(staff) {
    currentStaff = staff;
    paintStaffIdentity(staff);
    renderRoleNav(staff && staff.role);
    setStaffAuthState("content");
    const dateEl = $("callout-date");
    if (dateEl && !dateEl.value) dateEl.value = pacificDateToday();
    const form = $("callout-form");
    if (form) form.addEventListener("submit", onSubmit);
    loadOwnHistory();
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () { try { firebase.auth().signOut(); } catch (_e) {} });
    });
    const ssoBtn = $("staff-signin-btn");
    if (ssoBtn) ssoBtn.addEventListener("click", function () {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      firebase.auth().signInWithPopup(provider).catch(function (err) {
        console.warn("[call-out] google sign-in failed", err);
      });
    });
    setStaffAuthState("checking");
    try {
      window.STAFF_AUTH.init({
        onChecking:   function () { setStaffAuthState("checking"); },
        onSignedOut:  function () { setStaffAuthState("signin"); },
        onDenied:     function (info) {
          setStaffAuthState("denied");
          const msgEl = $("staff-auth-denied-msg");
          if (msgEl && info && info.message) msgEl.textContent = info.message;
        },
        onAuthorized: bootForStaff
      });
    } catch (err) {
      console.error("[call-out] STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
    }
  });
})();
