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

  // V6 pilot — load active customers into the supply-station picker.
  // For cleaning techs we scope to their assigned_customer_slugs (so a
  // tech doesn't see Pioneer's full client list). Admins get the full
  // active list. Caching the customer list in memory keeps subsequent
  // resets fast; the Submit-another-order button calls form.reset()
  // which the <select> handles natively (returns to placeholder).
  /* ============================================================
   * Phase Timeclock Add-On — Supply Station shift clock
   *
   * Mirrors the inspection clock card pattern. Shared
   * window.NonServiceClock provides the singleton lock so any active
   * shift (cleaning, inspection, supply) blocks the others.
   * ============================================================ */
  let ssClockStaff = null;
  let ssClockTickHandle = null;

  async function bootSupplyClock(staff) {
    if (!staff) return;
    if (!window.NonServiceClock) {
      console.warn("supply-station: NonServiceClock not loaded — clock UI hidden");
      return;
    }
    ssClockStaff = staff;
    const card = $("ss-clock-card");
    const btn  = $("ss-clock-toggle");
    if (!card || !btn) return;
    card.hidden = false;
    if (!btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", onSsClockToggle);
    }
    await refreshSsClock();
  }

  async function refreshSsClock() {
    if (!ssClockStaff || !window.NonServiceClock) return;
    try {
      const active = await window.NonServiceClock.getActive(ssClockStaff);
      paintSsClock(active);
    } catch (err) {
      console.warn("supply-station: clock refresh failed", err);
    }
  }

  function paintSsClock(active) {
    const card = $("ss-clock-card");
    const status = $("ss-clock-status");
    const btn = $("ss-clock-toggle");
    const errEl = $("ss-clock-err");
    if (!card || !status || !btn) return;
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

    if (active && (active.labor_type || "cleaning") === "supply_station") {
      card.setAttribute("data-state", "active");
      btn.textContent = "End Supply Station Shift";
      btn.disabled = false;
      paintSsElapsed(active);
      if (ssClockTickHandle) clearInterval(ssClockTickHandle);
      ssClockTickHandle = setInterval(function () { paintSsElapsed(active); }, 30000);
    } else if (active) {
      const lt = active.labor_type || "cleaning";
      const ltLabel = (window.NonServiceClock.LABOR_TYPE_LABEL[lt] || lt);
      card.removeAttribute("data-state");
      btn.textContent = "Start Supply Station Shift";
      btn.disabled = true;
      status.innerHTML = "Already clocked in for <strong>" + escapeText(ltLabel) +
                         "</strong>. End that shift first.";
      if (ssClockTickHandle) { clearInterval(ssClockTickHandle); ssClockTickHandle = null; }
    } else {
      card.removeAttribute("data-state");
      btn.textContent = "Start Supply Station Shift";
      btn.disabled = false;
      status.textContent = "Not clocked in.";
      if (ssClockTickHandle) { clearInterval(ssClockTickHandle); ssClockTickHandle = null; }
    }
  }

  function paintSsElapsed(active) {
    const status = $("ss-clock-status");
    if (!status) return;
    const startedMs = active && active.clock_in_at && typeof active.clock_in_at.toMillis === "function"
      ? active.clock_in_at.toMillis()
      : (active && active.clock_in_at && typeof active.clock_in_at.seconds === "number"
          ? active.clock_in_at.seconds * 1000
          : Date.now());
    const min = Math.max(0, Math.floor((Date.now() - startedMs) / 60000));
    const hh = Math.floor(min / 60);
    const mm = min % 60;
    const dur = hh > 0 ? hh + "h " + mm + "m" : mm + "m";
    status.innerHTML = "On the clock · <strong>" + escapeText(dur) + "</strong>";
  }

  async function onSsClockToggle() {
    const btn = $("ss-clock-toggle");
    const errEl = $("ss-clock-err");
    if (!btn || !window.NonServiceClock || !ssClockStaff) return;
    btn.disabled = true;
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    try {
      const active = await window.NonServiceClock.getActive(ssClockStaff);
      if (active && (active.labor_type || "cleaning") === "supply_station") {
        await window.NonServiceClock.clockOut(ssClockStaff,
          window.NonServiceClock.LABOR_TYPES.SUPPLY_STATION);
      } else {
        await window.NonServiceClock.clockIn(ssClockStaff,
          window.NonServiceClock.LABOR_TYPES.SUPPLY_STATION,
          {});
      }
      await refreshSsClock();
    } catch (err) {
      console.error("supply-station: clock toggle failed", err);
      if (errEl) {
        errEl.textContent = (err && err.message) || "Couldn't change shift state.";
        errEl.hidden = false;
      }
      btn.disabled = false;
    }
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  let _ssCustomersLoaded = false;
  async function loadCustomerPicker(staff) {
    const sel = $("ss-customer");
    if (!sel || _ssCustomersLoaded) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    const db = firebase.firestore();
    const snap = await db.collection("customers").get();
    let docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

    // Keep only active customers (default true when field missing).
    docs = docs.filter(function (c) { return c.active !== false; });

    // Cleaning techs: narrow to assigned customers (matches the DCR
    // form's customer dropdown gating). Admins see everything.
    if (staff && staff.role === "cleaning_tech") {
      const assigned = (staff.tech && Array.isArray(staff.tech.assigned_customer_slugs))
        ? new Set(staff.tech.assigned_customer_slugs)
        : new Set();
      docs = docs.filter(function (c) {
        const slug = c.customer_slug || c.slug || c.id;
        return assigned.has(slug);
      });
    }

    docs.sort(function (a, b) {
      const an = (a.customer_name || a.name || a.id).toLowerCase();
      const bn = (b.customer_name || b.name || b.id).toLowerCase();
      return an.localeCompare(bn);
    });

    docs.forEach(function (c) {
      const slug = c.customer_slug || c.slug || c.id;
      const name = c.customer_name || c.name || slug;
      const loc  = c.locationDisplayName || c.location_name || "";
      const opt  = document.createElement("option");
      opt.value = slug;
      opt.textContent = loc ? (name + " · " + loc) : name;
      opt.dataset.name = name;
      opt.dataset.location = loc;
      sel.appendChild(opt);
    });
    _ssCustomersLoaded = true;
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

        // V6 pilot — attach the selected customer (when any) so the
        // saved supply_requests doc carries customer_slug / name /
        // location for office routing. Empty string fallback when the
        // operator chose the "no specific customer" placeholder.
        const custSel  = $("ss-customer");
        const custOpt  = custSel && custSel.selectedIndex >= 0
          ? custSel.options[custSel.selectedIndex] : null;
        const custSlug = (custSel && custSel.value) || "";
        const custName = (custOpt && custOpt.dataset && custOpt.dataset.name) || "";
        const custLoc  = (custOpt && custOpt.dataset && custOpt.dataset.location) || "";

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
              categories:      categories,
              customer_slug:   custSlug,
              customer_name:   custName,
              location_name:   custLoc
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

  /* ---------- Supply Station Access — tap-to-copy + toast ----------
     The access card lives above the order form. Each pill/address
     button declares its copy payload via data-copy + a label for the
     confirmation toast. Wired once globally; the card is the only
     surface with .ss-copy-target so the delegate is safe. */
  function wireSupplyStationAccessCopy() {
    let toastTimer = null;
    function showCopyToast(label) {
      const toastEl = $("ss-access-toast");
      if (!toastEl) return;
      toastEl.textContent = label + " copied";
      toastEl.hidden = false;
      // Reflow trick: re-trigger the fade-in animation if the toast
      // is already up when a second copy happens.
      toastEl.classList.remove("is-visible");
      void toastEl.offsetWidth;
      toastEl.classList.add("is-visible");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.classList.remove("is-visible");
        toastEl.hidden = true;
      }, 2200);
    }
    function copyToClipboard(text) {
      // Modern API where available; falls back to the textarea trick
      // for the rare browser without permissions (or on insecure
      // contexts during local testing).
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error("execCommand copy failed"));
        } catch (err) { reject(err); }
      });
    }

    document.addEventListener("click", function (ev) {
      const target = ev.target.closest && ev.target.closest(".ss-copy-target[data-copy]");
      if (!target) return;
      ev.preventDefault();
      const payload = target.dataset.copy || "";
      const label   = target.dataset.copyLabel || "Code";
      if (!payload) return;
      copyToClipboard(payload).then(function () {
        showCopyToast(label);
        // Subtle pulse on the button so the user sees the action
        // even before the toast lands.
        target.classList.add("is-copied");
        setTimeout(function () { target.classList.remove("is-copied"); }, 350);
      }).catch(function (err) {
        console.warn("[supply-station] clipboard write failed", err);
        showCopyToast("Couldn't copy — long-press to select");
      });
    });
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
    wireForm();
    wireSupplyStationAccessCopy();
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
          // V6 pilot — load the customer picker so the submit attaches
          // the order to a specific site. Soft-fails on any read
          // error (network, rules) — the form still submits with an
          // empty customer if the picker doesn't populate.
          loadCustomerPicker(staff).catch(function (err) {
            console.warn("supply-station: customer picker load failed (non-fatal)",
              err && err.code, err && err.message);
          });
          // Phase Timeclock Add-On — Supply Station shift clock.
          // Reads the shared singleton lock at active_service_sessions/
          // {uid} so a tech who's actively cleaning or inspecting cannot
          // start a supply shift (and vice versa). Soft-fails if the
          // helper module didn't load.
          bootSupplyClock(staff).catch(function (err) {
            console.warn("supply-station: clock boot failed (non-fatal)", err);
          });
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
