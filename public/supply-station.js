/* Pioneer DCR Hub — Supply Station Order page controller.
 *
 * Drives /supply-station.html: same staff-auth gate as the DCR form and
 * the Customer Info Hub, plus a small submit form that POSTs to the
 * `submitSupplyStationOrderV1` Cloud Function. The function creates
 * BOTH the supply_station_orders doc AND the supply_notifications doc
 * server-side so April's contact info never reaches this publicly-served
 * JS bundle.
 *
 * Wiring at a glance:
 *   STAFF_AUTH.init()
 *     ↳ onChecking / onSignedOut / onDenied  → toggle the auth-screen card
 *     ↳ onAuthorized(staff)                  → paint identity + nav, show form
 *
 *   Form submit
 *     ↳ Validate locally (requested_items required, priority in set)
 *     ↳ Fetch staff ID token
 *     ↳ POST to SUPPLY_STATION_ORDER_URL with Bearer token + JSON body
 *     ↳ On success → show success card with order_id
 *     ↳ On error → render inline message; no nav state changes
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ---------- role-aware navigation ----------
   *
   * Same renderer the other pages use. Kept inline here so this page
   * doesn't need a shared module. The `withCurrentSearch` helper carries
   * forward the cache-buster query (e.g. ?v=3000) on nav hops. */
  // KEEP IN SYNC across five files: app.js, tech.js, admin.js,
  // supply-station.js, team-hub.js. See app.js for the rationale on not
  // extracting.
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

  function withCurrentSearch(href) {
    const search = (typeof location !== "undefined" && location.search) || "";
    if (!search) return href;
    return href + (href.indexOf("?") >= 0 ? "&" + search.slice(1) : search);
  }

  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }
    const current = nav.dataset.currentPage || "";
    const items   = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = (i.key === current);
      const cls   = "role-nav-link" + (isActive ? " is-active" : "");
      const aria  = isActive ? ' aria-current="page"' : '';
      if (isActive) return '<span class="' + cls + '"' + aria + '>' + i.label + '</span>';
      return '<a class="' + cls + '" href="' + withCurrentSearch(i.href) + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  // Pioneer Team Hub unread-announcements badge — KEEP IN SYNC across
  // app.js / tech.js / admin.js / supply-station.js / team-hub.js.
  async function paintTeamHubUnreadBadge(staff) {
    if (!staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const db = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        db.collection("announcements").where("active", "==", true).get(),
        db.collection("announcement_reads").where("uid", "==", staff.uid).get()
      ]);
      const readIds = new Set();
      readsSnap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (data.announcement_id) readIds.add(data.announcement_id);
      });
      function toMs(ts) {
        if (!ts) return null;
        if (typeof ts === "number") return ts;
        if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
        if (typeof ts.toMillis === "function") return ts.toMillis();
        if (typeof ts.seconds === "number") return ts.seconds * 1000;
        return null;
      }
      const now = Date.now();
      let unread = 0;
      annsSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.archived_at) return;
        const s = toMs(a.starts_at);   if (s != null && s > now) return;
        const e = toMs(a.expires_at);  if (e != null && e <= now) return;
        if (!readIds.has(d.id)) unread += 1;
      });
      const pills = document.querySelectorAll(".role-nav-link");
      let target = null;
      pills.forEach(function (p) {
        if ((p.textContent || "").trim() === "Pioneer Team Hub") target = p;
      });
      if (!target) return;
      const old = target.querySelector(".role-nav-badge");
      if (old) old.remove();
      if (unread > 0) {
        const dot = document.createElement("span");
        dot.className = "role-nav-badge";
        dot.textContent = unread > 9 ? "9+" : String(unread);
        target.appendChild(dot);
      }
    } catch (err) {
      console.warn("paintTeamHubUnreadBadge failed", err && err.code);
    }
  }

  function paintStaffIdentity(staff) {
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

  /* ---------- auth-screen state ---------- */
  function setStaffAuthState(state) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("staff-auth-" + s);
      if (el) el.hidden = s !== state;
    });
    const content = $("staff-auth-content");
    if (content) content.hidden = state !== "content";

    const headerAccount = $("staff-header-account");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
    } else {
      if (headerAccount) headerAccount.hidden = true;
      const nav = $("role-nav");
      if (nav) { nav.hidden = true; nav.innerHTML = ""; }
    }

    // Animated login backdrop toggle — same convention as app.js / tech.js.
    document.body.classList.toggle("is-signing-in", state === "signin");

    if (state === "checking") {
      const checkingEl = $("staff-auth-checking");
      const titleEl    = checkingEl && checkingEl.querySelector(".staff-auth-title");
      const cached     = window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
                          ? window.STAFF_AUTH.getCachedStaff() : null;
      if (titleEl) {
        const name = cached && (cached.display_name || cached.email);
        titleEl.textContent = name ? ("Welcome back, " + name + "…") : "Checking access…";
      }
    }
  }

  /* ---------- sign-in panel inline messaging ---------- */
  function setStaffAuthInlineMsg(msg, kind) {
    const el = $("staff-auth-inline-msg");
    if (!el) return;
    if (!msg) {
      el.hidden = true; el.textContent = "";
      el.classList.remove("is-ok");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("is-ok", kind === "ok");
    el.hidden = false;
  }

  /* ---------- form-level inline messaging ---------- */
  function setFormInlineMsg(msg, kind) {
    const el = $("ss-inline-msg");
    if (!el) return;
    if (!msg) {
      el.hidden = true; el.textContent = "";
      el.classList.remove("is-ok");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("is-ok", kind === "ok");
    el.hidden = false;
  }

  /* ---------- sign-in button wiring (parallels app.js / tech.js) ---------- */
  function wireSignInButton() {
    const btn = $("staff-signin-btn");
    if (btn) btn.addEventListener("click", async function () {
      if (!window.STAFF_AUTH) return;
      setStaffAuthInlineMsg("");
      btn.disabled = true;
      try {
        const result = await window.STAFF_AUTH.signIn();
        if (result && !result.ok && !result.cancelled) {
          setStaffAuthInlineMsg(result.message, "err");
        }
      } finally {
        btn.disabled = false;
      }
    });

    const form    = $("staff-password-form");
    const submit  = $("staff-password-submit");
    const emailEl = $("staff-email");
    const passEl  = $("staff-password");
    if (form && submit && emailEl && passEl) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        submit.disabled = true;
        const orig = submit.textContent;
        submit.textContent = "Signing in…";
        try {
          const result = await window.STAFF_AUTH.signInWithPassword(emailEl.value, passEl.value);
          if (!result.ok) {
            setStaffAuthInlineMsg(result.message, "err");
            passEl.value = "";
            passEl.focus();
          }
        } finally {
          submit.disabled = false;
          submit.textContent = orig;
        }
      });
    }

    const forgot = $("staff-forgot-link");
    if (forgot && emailEl) {
      forgot.addEventListener("click", async function () {
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        forgot.disabled = true;
        try {
          const result = await window.STAFF_AUTH.sendPasswordReset(emailEl.value);
          setStaffAuthInlineMsg(result.message, result.ok ? "ok" : "err");
        } finally {
          forgot.disabled = false;
        }
      });
    }
  }

  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
  }

  /* ---------- order form ----------
   *
   * Reset behavior (called from "Submit another order"):
   *   • form.reset() restores every <input>, <textarea>, <select>, and
   *     <input type="checkbox"> to its parsed-HTML default state. The
   *     priority <select> falls back to value="normal" (the `selected`
   *     attribute on that option). All six category checkboxes return
   *     to UNCHECKED. The note + requested_items textareas clear.
   *   • setFormInlineMsg("") clears any leftover red error banner from
   *     the prior submit attempt.
   *   • The success card hide / form show toggle lives in showForm()
   *     (one level up) so resetForm is reusable elsewhere if needed.
   *
   * Double-submit guard:
   *   The submit handler synchronously sets submit.disabled = true the
   *   moment validation passes — before the fetch() starts. Subsequent
   *   click / Enter events on a disabled button are dropped by the
   *   browser, so even Enter-spam can't fire two POSTs. The try/finally
   *   re-enables the button only after the fetch resolves or throws. */
  function resetForm() {
    const form = $("supply-station-form");
    if (form) form.reset();
    setFormInlineMsg("");
  }

  function showSuccess(orderId) {
    const formEl = $("supply-station-form");
    const succ   = $("ss-success");
    const idEl   = $("ss-order-id");
    if (formEl) formEl.hidden = true;
    if (idEl)   idEl.textContent = orderId || "—";
    if (succ)   succ.hidden = false;
  }

  function showForm() {
    const formEl = $("supply-station-form");
    const succ   = $("ss-success");
    if (succ)   succ.hidden = true;
    if (formEl) formEl.hidden = false;
    resetForm();
  }

  function wireForm() {
    const form     = $("supply-station-form");
    const submit   = $("ss-submit");
    const newBtn   = $("ss-new-btn");

    if (newBtn) newBtn.addEventListener("click", showForm);

    if (form && submit) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        setFormInlineMsg("");

        const requestedItems = ($("ss-requested-items").value || "").trim();
        if (!requestedItems) {
          setFormInlineMsg("Enter at least one requested item.", "err");
          $("ss-requested-items").focus();
          return;
        }
        const priority   = $("ss-priority").value || "normal";
        const note       = ($("ss-note").value || "").trim();
        const categories = Array.from(
          document.querySelectorAll('input[name="category"]:checked')
        ).map(function (cb) { return cb.value; });

        const url = (window.SUPPLY_STATION_ORDER_URL || "").trim();
        if (!url || /REPLACE_WITH/.test(url)) {
          setFormInlineMsg(
            "Supply Station endpoint isn't configured yet. The office is on it — try again shortly.",
            "err"
          );
          return;
        }

        let idToken = null;
        try {
          idToken = window.STAFF_AUTH && await window.STAFF_AUTH.getIdToken();
        } catch (e) { /* fall through */ }
        if (!idToken) {
          setFormInlineMsg("Your session expired. Refresh the page and sign in again.", "err");
          return;
        }

        submit.disabled = true;
        const origLabel = submit.textContent;
        submit.textContent = "Submitting…";

        try {
          const res = await fetch(url, {
            method:  "POST",
            headers: {
              "Content-Type":  "application/json",
              "Authorization": "Bearer " + idToken
            },
            body: JSON.stringify({
              requested_items: requestedItems,
              priority:        priority,
              note:            note,
              categories:      categories
            })
          });
          const body = await res.json().catch(function () { return {}; });
          if (!res.ok || !body.ok) {
            const msg =
              (body && body.error) ||
              ((body && Array.isArray(body.details) && body.details.join(" · ")) ||
                ("Server returned " + res.status));
            setFormInlineMsg(msg, "err");
            return;
          }
          showSuccess(body.order_id);
        } catch (err) {
          console.error("supply-station submit failed", err);
          setFormInlineMsg(
            "Couldn't reach the supply station service. Check your connection and try again.",
            "err"
          );
        } finally {
          submit.disabled = false;
          submit.textContent = origLabel;
        }
      });
    }
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
    wireForm();
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
        onAuthorized: function (staff) {
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);
          paintTeamHubUnreadBadge(staff);
          if (window.MANDATORY_ANN && typeof window.MANDATORY_ANN.check === "function") {
            window.MANDATORY_ANN.check(staff).then(function () {
              paintTeamHubUnreadBadge(staff);
            });
          }
          showForm();
        }
      });
    } catch (err) {
      console.error("STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
      const msgEl = $("staff-auth-denied-msg");
      if (msgEl) msgEl.textContent = "Couldn't start sign-in. Hard-reload (Cmd+Shift+R).";
    }
  });
})();
