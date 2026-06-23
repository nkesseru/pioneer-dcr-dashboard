/* Pioneer DCR Hub — /open-shifts.html controller.
 *
 * Tech-facing surface for the Rockstar coverage flow. Two lists:
 *   1. Available now — open_shift_requests where status="open".
 *      Click Accept → atomic rule-enforced claim (status: open →
 *      accepted, acceptedByTechUid stamped). The Firestore rule
 *      checks `resource.data.status == "open"`, so a second tech's
 *      concurrent accept fails cleanly.
 *   2. Your covered shifts — open_shift_requests where this tech is
 *      acceptedByTechUid. Shows status + bonus state.
 *
 * Phase 2 TODO:
 *   • Decline / waitlist
 *   • Tech-facing summary of total bonus earned this month (already
 *     surfaced on Team Hub via rockstar_bonuses; this page could
 *     show personal totals)
 */
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
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "short", day: "numeric"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return yyyymmdd; }
  }
  function bonusStatusLabel(s) {
    switch (s) {
      case "pending":  return "Bonus pending";
      case "approved": return "Bonus approved";
      case "paid":     return "Bonus paid";
      default:         return "Bonus pending";
    }
  }
  function bonusStatusClass(s) {
    return "os-bonus-status os-bonus-status--" + (s || "pending");
  }

  function showToast(msg, isError) {
    const el = $("os-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    // Auto-clear non-error toasts after 6s. Errors stay until next
    // user action so they don't disappear before the user reads them.
    if (!isError) setTimeout(function () { el.hidden = true; }, 6000);
  }

  function setStatus(text) {
    const el = $("os-status-loading");
    if (el) {
      if (!text) { el.hidden = true; el.textContent = ""; return; }
      el.textContent = text;
      el.hidden = false;
    }
  }
  function setError(text) {
    const el = $("os-status-error");
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = text; el.hidden = false;
  }

  /* ---------- Render: available list ---------- */
  function renderAvailable(docs) {
    const listEl  = $("os-available-list");
    const emptyEl = $("os-empty");
    if (!listEl || !emptyEl) return;
    if (!docs.length) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = docs.map(function (d) {
      const x = d.data() || {};
      return (
        '<li class="os-row" data-id="' + escapeHtml(d.id) + '">' +
          '<div class="os-row-main">' +
            '<div class="os-row-customer">' + escapeHtml(x.customerName || "Customer") + '</div>' +
            '<div class="os-row-meta">' +
              escapeHtml(fmtDate(x.shiftDate)) +
              (x.shiftTime ? ' · ' + escapeHtml(x.shiftTime) : '') +
            '</div>' +
            (x.notes ? '<p class="os-row-notes">' + escapeHtml(x.notes) + '</p>' : '') +
          '</div>' +
          '<div class="os-row-side">' +
            '<span class="os-bonus-badge">$25 Rockstar bonus</span>' +
            '<button type="button" class="os-accept-btn" data-act="accept">Accept Shift</button>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  /* ---------- Render: mine list ---------- */
  function renderMine(docs) {
    const card    = $("os-mine-card");
    const listEl  = $("os-mine-list");
    if (!card || !listEl) return;
    if (!docs.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    listEl.innerHTML = docs.map(function (d) {
      const x = d.data() || {};
      const statusChip = x.status === "confirmed"
        ? '<span class="os-status-chip is-confirmed">Confirmed</span>'
        : x.status === "cancelled"
          ? '<span class="os-status-chip is-cancelled">Cancelled</span>'
          : '<span class="os-status-chip is-accepted">Accepted · awaiting confirm</span>';
      return (
        '<li class="os-row os-row--mine" data-id="' + escapeHtml(d.id) + '">' +
          '<div class="os-row-main">' +
            '<div class="os-row-customer">' + escapeHtml(x.customerName || "Customer") + '</div>' +
            '<div class="os-row-meta">' +
              escapeHtml(fmtDate(x.shiftDate)) +
              (x.shiftTime ? ' · ' + escapeHtml(x.shiftTime) : '') +
            '</div>' +
          '</div>' +
          '<div class="os-row-side">' +
            statusChip +
            '<span class="' + bonusStatusClass(x.rockstarBonusStatus) + '">' +
              escapeHtml(bonusStatusLabel(x.rockstarBonusStatus)) +
            '</span>' +
          '</div>' +
        '</li>'
      );
    }).join("");
  }

  /* ---------- Load ---------- */
  async function loadAll() {
    setError("");
    setStatus("Loading open shifts…");
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setStatus(""); setError("Firestore SDK missing. Hard-reload (Cmd+Shift+R).");
      return;
    }
    const u = firebase.auth().currentUser;
    if (!u) {
      setStatus(""); setError("Not signed in.");
      return;
    }
    try {
      const db = firebase.firestore();
      const [availSnap, mineSnap] = await Promise.all([
        db.collection("open_shift_requests")
          .where("status", "==", "open")
          .orderBy("shiftDate", "asc")
          .limit(50).get(),
        db.collection("open_shift_requests")
          .where("acceptedByTechUid", "==", u.uid)
          .orderBy("acceptedAt", "desc")
          .limit(10).get()
      ]);
      setStatus("");
      renderAvailable(availSnap.docs);
      renderMine(mineSnap.docs);
    } catch (err) {
      console.error("[open-shifts] load failed", err);
      setStatus("");
      setError(
        err && err.code === "permission-denied"
          ? "Permission denied. Confirm your account is active."
          : ("Couldn't load open shifts: " + (err && (err.message || err.code)) || "unknown")
      );
    }
  }

  /* ---------- Accept (rule-enforced atomic claim) ---------- */
  async function onAcceptClick(rowEl) {
    const id = rowEl.dataset.id;
    if (!id) return;
    const btn = rowEl.querySelector(".os-accept-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Accepting…"; }

    const u = firebase.auth().currentUser;
    if (!u) {
      showToast("Not signed in — refresh and try again.", true);
      if (btn) { btn.disabled = false; btn.textContent = "Accept Shift"; }
      return;
    }
    const tech = (currentStaff && currentStaff.tech) || {};
    const techId   = tech.slug || tech.tech_slug || "";
    const techName = tech.display_name || (currentStaff && currentStaff.display_name) ||
                     (currentStaff && currentStaff.email) || "Tech";

    const db = firebase.firestore();
    try {
      // Single update call. The Firestore rule rejects this if the
      // doc's pre-write status isn't "open" — so concurrent attempts
      // resolve via the rule, no transaction needed.
      await db.collection("open_shift_requests").doc(id).update({
        status:             "accepted",
        acceptedByTechUid:  u.uid,
        acceptedByTechId:   techId,
        acceptedByTechName: techName,
        acceptedAt:         firebase.firestore.FieldValue.serverTimestamp()
      });
      showToast("Thanks for helping the team. Kirby will confirm coverage. Rockstar bonus pending confirmation.", false);
      // Celebration moment — tech just stepped up to cover a shift.
      try {
        if (window.PioneerCelebrate) window.PioneerCelebrate.celebrate({ intensity: "medium" });
      } catch (_e) {}
      loadAll();
    } catch (err) {
      console.error("[open-shifts] accept failed", err);
      const msg = (err && err.code === "permission-denied")
        ? "Someone else just took this shift, or it was cancelled. Refresh to see the current list."
        : ("Accept failed: " + (err && (err.message || err.code)) || "unknown");
      showToast(msg, true);
      if (btn) { btn.disabled = false; btn.textContent = "Accept Shift"; }
      loadAll();
    }
  }

  function wireAcceptClicks() {
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest(".os-accept-btn[data-act='accept']");
      if (!btn) return;
      const row = btn.closest(".os-row");
      if (row) onAcceptClick(row);
    });
  }

  /* ---------- Boot ---------- */
  function bootForStaff(staff) {
    currentStaff = staff;
    paintStaffIdentity(staff);
    renderRoleNav(staff && staff.role);
    setStaffAuthState("content");
    wireAcceptClicks();
    loadAll();
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
        console.warn("[open-shifts] google sign-in failed", err);
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
      console.error("[open-shifts] STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
    }
  });
})();
