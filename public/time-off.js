/* Pioneer DCR Hub — /time-off.html controller.
 *
 * Planned-time-off request submission. Writes to `time_off_requests`
 * + a `notifications` doc the admin badge reads.
 *
 * Phase 2 TODO:
 *   • Cloud Function trigger on create → email Kirby
 *   • Notify tech when status changes to approved/denied
 *   • Optional "see who's also off this day" preview */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

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
    const techEl = $("timeoff-tech-display");
    if (techEl)  techEl.textContent  = displayName || staff.email || "—";
  }

  function setStatus(text) { const el = $("timeoff-status"); if (el) el.textContent = text || ""; }
  function setError(msg) {
    const el = $("timeoff-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg; el.hidden = false;
  }

  function onSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setError("");
    setStatus("");

    if (!currentStaff || !currentStaff.uid) { setError("Not signed in. Refresh the page and try again."); return; }
    const u = firebase.auth().currentUser;
    if (!u) { setError("Not signed in. Refresh the page and try again."); return; }

    const startEl = $("timeoff-start-date");
    const endEl   = $("timeoff-end-date");
    const typeEl  = document.querySelector("input[name='timeoff-type']:checked");
    const noteEl  = $("timeoff-note");

    const startDate = (startEl && startEl.value || "").trim();
    const endDate   = (endEl   && endEl.value   || "").trim();
    if (!startDate) { setError("Pick a start date."); return; }
    if (!endDate)   { setError("Pick an end date."); return; }
    if (endDate < startDate) {
      setError("End date must be on or after the start date.");
      return;
    }
    if (!typeEl) { setError("Pick a request type."); return; }

    const submitBtn = $("timeoff-submit");
    if (submitBtn) submitBtn.disabled = true;

    const tech = currentStaff.tech || {};
    const techId   = tech.slug || tech.tech_slug || "";
    const techName = tech.display_name || currentStaff.display_name || currentStaff.email || "Tech";
    const payload  = {
      techId:        techId,
      techName:      techName,
      techUid:       u.uid,
      techEmail:     (currentStaff.email || u.email || "").toLowerCase(),
      startDate:     startDate,
      endDate:       endDate,
      requestType:   typeEl.value,
      note:          (noteEl && noteEl.value || "").trim() || null,
      submittedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      status:        "pending",
      reviewedAt:    null,
      reviewedBy:    null,
      managerNote:   null
    };

    setStatus("Submitting…");
    const db = firebase.firestore();
    db.collection("time_off_requests").add(payload)
      .then(function (ref) {
        db.collection("notifications").add({
          type:         "time_off_request",
          refId:        ref.id,
          createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
          createdByUid: u.uid,
          summary:      techName + " requested time off " + startDate +
                        (startDate === endDate ? "" : (" → " + endDate)) +
                        " (" + typeEl.value + ")",
          status:       "unread"
        }).catch(function (err) { console.warn("[time-off] notification write failed (non-fatal)", err); });
        setStatus("Request submitted. The office team will review and update you.");
        if (submitBtn) submitBtn.disabled = false;
        if (noteEl)  noteEl.value = "";
        if (typeEl)  typeEl.checked = false;
        loadOwnHistory();
      })
      .catch(function (err) {
        console.error("[time-off] submit failed", err);
        setError(
          err && err.code === "permission-denied"
            ? "Permission denied. Confirm your account is active and try again."
            : ("Submit failed: " + (err && (err.message || err.code)) || "unknown error")
        );
        setStatus("");
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  function typeLabel(v) {
    switch (v) {
      case "vacation":     return "Vacation";
      case "personal_day": return "Personal day";
      case "appointment":  return "Appointment";
      case "family_event": return "Family event";
      case "other":        return "Other";
      default:             return v || "—";
    }
  }
  function statusChip(s) {
    const map = { pending: "Pending", approved: "Approved", denied: "Denied" };
    const label = map[s] || s || "—";
    return '<span class="attendance-chip attendance-chip--' + (s || "pending") + '">' + label + '</span>';
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
        .collection("time_off_requests")
        .where("techUid", "==", u.uid)
        .orderBy("submittedAt", "desc")
        .limit(5)
        .get();
      const list = $("timeoff-history-list");
      const wrap = $("timeoff-history-section");
      if (!list || !wrap) return;
      if (snap.empty) { wrap.hidden = true; return; }
      list.innerHTML = snap.docs.map(function (d) {
        const x = d.data() || {};
        const range = (x.startDate || "—") +
          (x.startDate === x.endDate ? "" : (" → " + (x.endDate || "—")));
        return (
          '<li class="attendance-history-row">' +
            '<div class="attendance-history-row-main">' +
              '<div class="attendance-history-row-title">' + escapeHtml(typeLabel(x.requestType)) +
                ' · ' + escapeHtml(range) + '</div>' +
              (x.managerNote
                ? '<div class="attendance-history-row-sub"><strong>Manager:</strong> ' + escapeHtml(x.managerNote) + '</div>'
                : '') +
              '<div class="attendance-history-row-meta">Submitted ' + formatSubmittedAt(x.submittedAt) + '</div>' +
            '</div>' +
            statusChip(x.status) +
          '</li>'
        );
      }).join("");
      wrap.hidden = false;
    } catch (err) {
      console.warn("[time-off] history load failed", err);
    }
  }

  /* ---------- Soft pressure warning ----------
     When the user picks start/end dates that already have 3+ people
     requested off (the "red" threshold), show an inline warning. The
     pressure map is built once per page load from the
     time_off_requests collection — same rule as the admin Attendance
     calendar + the Scheduled Time Off heatmap on /team-schedule. */
  let pressureByDate = new Map();   // YYYY-MM-DD → count
  async function loadPressureMap() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("time_off_requests")
        .where("status", "in", ["pending", "approved"])
        .get();
      const map = new Map();
      snap.docs.forEach(function (d) {
        const x = d.data() || {};
        if (!x.startDate) return;
        let cur = x.startDate;
        const end = x.endDate || x.startDate;
        let safety = 0;
        while (cur <= end && safety < 120) {
          map.set(cur, (map.get(cur) || 0) + 1);
          const ms = new Date(cur + "T12:00:00Z").getTime() + 86400000;
          cur = new Date(ms).toISOString().slice(0, 10);
          safety += 1;
        }
      });
      pressureByDate = map;
    } catch (err) {
      console.warn("[time-off] pressure read failed (non-fatal)", err);
      pressureByDate = new Map();
    }
  }
  function updatePressureWarning() {
    const startEl = $("timeoff-start-date");
    const endEl   = $("timeoff-end-date");
    const warnEl  = $("timeoff-pressure-warning");
    if (!startEl || !endEl || !warnEl) return;
    const s = startEl.value;
    const e = endEl.value || s;
    if (!s) { warnEl.hidden = true; return; }
    let cur = s;
    let safety = 0;
    let anyRed = false;
    while (cur <= e && safety < 120) {
      if ((pressureByDate.get(cur) || 0) >= 3) { anyRed = true; break; }
      const ms = new Date(cur + "T12:00:00Z").getTime() + 86400000;
      cur = new Date(ms).toISOString().slice(0, 10);
      safety += 1;
    }
    warnEl.hidden = !anyRed;
  }

  function bootForStaff(staff) {
    currentStaff = staff;
    paintStaffIdentity(staff);
    renderRoleNav(staff && staff.role);
    setStaffAuthState("content");
    const form = $("timeoff-form");
    if (form) form.addEventListener("submit", onSubmit);
    // Sync start → end so end is never before start. Also trigger the
    // pressure warning check whenever either date input changes.
    const startEl = $("timeoff-start-date");
    const endEl   = $("timeoff-end-date");
    if (startEl && endEl) {
      startEl.addEventListener("change", function () {
        if (endEl.value && endEl.value < startEl.value) endEl.value = startEl.value;
        endEl.min = startEl.value || "";
        updatePressureWarning();
      });
      endEl.addEventListener("change", updatePressureWarning);
    }
    loadOwnHistory();
    // Build the pressure map in the background so the warning is
    // ready by the time the user picks dates.
    loadPressureMap().then(updatePressureWarning);
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
        console.warn("[time-off] google sign-in failed", err);
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
      console.error("[time-off] STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
    }
  });
})();
