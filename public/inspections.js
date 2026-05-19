/* Pioneer DCR Hub — Inspections v1 page controller.
 *
 * Drives /inspections.html. v1 scope is intake-only:
 *   • Sign-in gate + admin role check (cleaning_tech UI can land later)
 *   • Customer dropdown (active + DCR-enabled, mirrors the DCR form)
 *   • Three context questions (segmented pills)
 *   • 11 area scores via tactile <input type="range"> sliders
 *   • Auto-calculated overall score
 *   • Submit → write one doc to /inspections
 *
 * Out of scope (deliberate): analytics, trend dashboards, photo
 * upload (button is a stub), customer-facing reporting. Schema fields
 * for future aggregation are stamped at submit time even when the UI
 * doesn't expose them yet (cleaning_tech_slug, etc.).
 */
(function () {
  "use strict";

  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // KEEP IN SYNC across seven page-controller files: app.js, tech.js,
  // admin.js, supply-station.js, team-hub.js, work.js, inspections.js.
  // The Inspections pill is admin-only for v1 — the same access rules
  // gate the page itself.
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

  // Inspection areas. Each item: { slug, label }. Slug is the
  // canonical key on the inspection doc's area_scores map; label is
  // the inspector-facing string. Order is the order they render in
  // the form (and the order they'll roll up to dashboards later).
  const INSPECTION_AREAS = [
    { slug: "offices",        label: "Offices" },
    { slug: "bathrooms",      label: "Bathrooms" },
    { slug: "entry_foyer",    label: "Entry / Foyer" },
    { slug: "lunchroom",      label: "Lunchroom" },
    { slug: "common_areas",   label: "Common Areas" },
    { slug: "trash",          label: "Trash" },
    { slug: "floors",         label: "Floors" },
    { slug: "dusting",        label: "Dusting" },
    { slug: "glass",          label: "Glass" },
    { slug: "touchpoints",    label: "Touchpoints" },
    { slug: "supplies",       label: "Supplies" }
  ];

  const SCORE_META = {
    1: { label: "Poor",        emoji: "🚩", tone: "tone-1" },
    2: { label: "Needs Work",  emoji: "⚠️", tone: "tone-2" },
    3: { label: "Acceptable",  emoji: "😐", tone: "tone-3" },
    4: { label: "Great",       emoji: "👍", tone: "tone-4" },
    5: { label: "Excellent",   emoji: "🌟", tone: "tone-5" }
  };

  /* ====================================================================
     Role-nav + identity painters (mirrors team-hub.js / work.js).
     KEEP IN SYNC — see comment on ROLE_NAV_ITEMS above.
     ==================================================================== */

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
    const inspEl = $("insp-inspector-name");
    if (inspEl) inspEl.textContent = displayName || (staff && staff.email) || "—";
  }

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

  /* ---------- sign-in panel wiring ---------- */
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
      } finally { btn.disabled = false; }
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
        } finally { forgot.disabled = false; }
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

  /* ====================================================================
     Form state model
     ==================================================================== */

  // One central state object so the submit handler doesn't have to
  // re-scrape the DOM. Each area starts at 3 (Acceptable) — the spec
  // wants "swipe → score → move on", so a sensible default is faster
  // than nudging from null. Inspector adjusts where things differ.
  const state = {
    customer_slug:                "",
    customer_name:                "",
    inspection_date:              "",
    inspection_started_at:        new Date(),
    building_activity_level:      "",
    cleaning_tech_present:        "",       // "yes" | "no" | ""
    approximate_time_since_clean: "",
    area_scores: (function () {
      const obj = {};
      INSPECTION_AREAS.forEach(function (a) {
        obj[a.slug] = { score: 3, note: "", photo_urls: [] };
      });
      return obj;
    })(),
    notes: ""
  };

  /* ---------- customer dropdown ---------- */

  function todayLocalDate() {
    const d = new Date();
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  async function loadCustomers() {
    const sel = $("insp-customer");
    if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>Loading customers…</option>';
    if (!window.firebase || typeof firebase.firestore !== "function") {
      sel.innerHTML = '<option value="" disabled selected>Firestore unavailable</option>';
      return;
    }
    try {
      const snap = await firebase.firestore().collection("customers").get();
      const customers = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (c) { return c.active !== false; })
        .sort(function (a, b) {
          return (a.customer_name || a.name || "").localeCompare(b.customer_name || b.name || "");
        });
      // Cache slug → display name so the hub cards always have a
      // human-readable label even when an old inspection doc was
      // light on customer_name.
      hubCustomerNames = {};
      customers.forEach(function (c) {
        const slug = c.customer_slug || c.slug || c.id;
        hubCustomerNames[slug] = c.customer_name || c.name || slug;
      });
      if (customers.length === 0) {
        sel.innerHTML = '<option value="" disabled selected>No active customers</option>';
        return;
      }
      sel.innerHTML =
        '<option value="" disabled selected>— Pick customer —</option>' +
        customers.map(function (c) {
          const slug = c.customer_slug || c.slug || c.id;
          const name = c.customer_name || c.name || slug;
          const loc  = c.location_name && c.location_name !== name ? " · " + c.location_name : "";
          return '<option value="' + escapeAttr(slug) + '" data-name="' + escapeAttr(name) + '">' +
                   escapeText(name + loc) + '</option>';
        }).join("");
    } catch (err) {
      console.error("[inspections] loadCustomers failed", err);
      sel.innerHTML = '<option value="" disabled selected>Couldn\'t load — refresh</option>';
    }
  }

  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Cleaning-tech dropdown for the optional "Credit a tech" field.
  // Loads active techs from /cleaning_techs (admin reads allowed per
  // rules) and stamps them as <option value="slug" data-name="Display">.
  async function loadCreditTechDropdown() {
    const sel = $("insp-credit-tech");
    if (!sel) return;
    sel.innerHTML = '<option value="">— No credit yet —</option>';
    try {
      const snap = await firebase.firestore().collection("cleaning_techs").get();
      const techs = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (t) { return t.active !== false; })
        .sort(function (a, b) { return (a.display_name || a.tech_slug || a.id).localeCompare(b.display_name || b.tech_slug || b.id); });
      techs.forEach(function (t) {
        const slug = t.tech_slug || t.id;
        const name = t.display_name || slug;
        const opt = document.createElement("option");
        opt.value = slug;
        opt.dataset.name = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
    } catch (err) {
      console.warn("[inspections] loadCreditTechDropdown failed", err && err.code);
    }
  }

  /* ---------- segmented-pill context questions ---------- */

  function wireContextPills() {
    $$(".insp-segmented").forEach(function (group) {
      const question = group.dataset.question;
      if (!question) return;
      group.addEventListener("click", function (ev) {
        const btn = ev.target.closest(".insp-pill");
        if (!btn) return;
        // Deselect siblings, select clicked.
        group.querySelectorAll(".insp-pill").forEach(function (b) {
          b.classList.toggle("is-selected", b === btn);
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        state[question] = btn.dataset.value || "";
      });
    });
  }

  /* ---------- area sliders ---------- */

  function renderAreas() {
    const root = $("insp-areas");
    if (!root) return;
    root.innerHTML = INSPECTION_AREAS.map(function (a) {
      const initial = state.area_scores[a.slug].score;
      const meta = SCORE_META[initial];
      return (
        '<article class="insp-area is-' + escapeAttr(meta.tone) + '" data-slug="' + escapeAttr(a.slug) + '">' +
          '<header class="insp-area-head">' +
            '<h3 class="insp-area-title">' + escapeText(a.label) + '</h3>' +
            '<button type="button" class="insp-area-note-toggle" data-action="toggle-note"' +
                   ' aria-expanded="false" aria-label="Add note">+ note</button>' +
          '</header>' +
          '<div class="insp-area-readout">' +
            '<span class="insp-area-score" data-role="score">' + initial + '</span>' +
            '<div class="insp-area-meta">' +
              '<span class="insp-area-label" data-role="label">' + escapeText(meta.label) + '</span>' +
              '<span class="insp-area-emoji" data-role="emoji" aria-hidden="true">' + meta.emoji + '</span>' +
            '</div>' +
          '</div>' +
          '<input type="range" class="insp-area-slider" min="1" max="5" step="1"' +
                ' value="' + initial + '" aria-label="' + escapeAttr(a.label) + ' score"' +
                ' data-role="slider" />' +
          '<div class="insp-area-ticks" role="presentation">' +
            '<button type="button" class="insp-area-tick" data-tick="1">1</button>' +
            '<button type="button" class="insp-area-tick" data-tick="2">2</button>' +
            '<button type="button" class="insp-area-tick" data-tick="3">3</button>' +
            '<button type="button" class="insp-area-tick" data-tick="4">4</button>' +
            '<button type="button" class="insp-area-tick" data-tick="5">5</button>' +
          '</div>' +
          '<div class="insp-area-extras" hidden data-role="extras">' +
            '<textarea class="insp-area-note" data-role="note" rows="2" maxlength="1000"' +
                     ' placeholder="What did you see? (optional)"></textarea>' +
            '<button type="button" class="insp-area-photo" data-action="add-photo" disabled' +
                   ' title="Photo upload lands in a follow-up build">' +
              '📷 Add photo (coming soon)' +
            '</button>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function applyAreaScore(card, score) {
    const slug = card.dataset.slug;
    if (!slug) return;
    const clean = Math.max(1, Math.min(5, parseInt(score, 10) || 3));
    state.area_scores[slug].score = clean;

    const meta = SCORE_META[clean];
    // Update visuals.
    card.querySelector('[data-role="score"]').textContent = clean;
    card.querySelector('[data-role="label"]').textContent = meta.label;
    card.querySelector('[data-role="emoji"]').textContent = meta.emoji;
    const slider = card.querySelector('[data-role="slider"]');
    if (slider && Number(slider.value) !== clean) slider.value = clean;
    // Swap tone class.
    ["tone-1","tone-2","tone-3","tone-4","tone-5"].forEach(function (t) {
      card.classList.remove("is-" + t);
    });
    card.classList.add("is-" + meta.tone);
    // Recalculate overall.
    renderOverallScore();
  }

  function wireAreas() {
    const root = $("insp-areas");
    if (!root) return;

    // Slider input — fires on every drag step. Apply live for tactile
    // feedback (color + score number snap to the value).
    root.addEventListener("input", function (ev) {
      const slider = ev.target.closest('[data-role="slider"]');
      if (!slider) return;
      const card = slider.closest(".insp-area");
      if (card) applyAreaScore(card, slider.value);
    });

    // Click delegator — handles tick buttons + note toggle.
    root.addEventListener("click", function (ev) {
      // Tick buttons jump the slider.
      const tick = ev.target.closest(".insp-area-tick");
      if (tick) {
        const card = tick.closest(".insp-area");
        if (card) applyAreaScore(card, tick.dataset.tick);
        return;
      }
      // Note toggle.
      const noteBtn = ev.target.closest('[data-action="toggle-note"]');
      if (noteBtn) {
        const card    = noteBtn.closest(".insp-area");
        const extras  = card && card.querySelector('[data-role="extras"]');
        if (!extras) return;
        const expanded = noteBtn.getAttribute("aria-expanded") === "true";
        extras.hidden = expanded;
        noteBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
        noteBtn.textContent = expanded ? "+ note" : "− note";
        if (!expanded) {
          const ta = extras.querySelector('[data-role="note"]');
          if (ta) setTimeout(function () { ta.focus(); }, 60);
        }
        return;
      }
      // Photo button — placeholder. Disabled in markup; click does nothing.
    });

    // Note textarea input — sync to state.
    root.addEventListener("input", function (ev) {
      const ta = ev.target.closest('[data-role="note"]');
      if (!ta) return;
      const card = ta.closest(".insp-area");
      if (!card) return;
      state.area_scores[card.dataset.slug].note = ta.value;
    });
  }

  /* ---------- overall score ---------- */

  function renderOverallScore() {
    const valueEl = $("insp-overall-value");
    const emojiEl = $("insp-overall-emoji");
    const subEl   = $("insp-overall-sub");
    if (!valueEl) return;
    const scores = INSPECTION_AREAS.map(function (a) { return state.area_scores[a.slug].score; });
    const total = scores.reduce(function (s, n) { return s + n; }, 0);
    const avg = total / scores.length;
    const rounded = Math.round(avg * 10) / 10;     // 1 decimal
    valueEl.textContent = rounded.toFixed(1);

    // Tone the overall card by the rounded-to-nearest score.
    const nearest = Math.round(avg);
    const meta = SCORE_META[Math.max(1, Math.min(5, nearest))];
    if (emojiEl) emojiEl.textContent = meta.emoji;
    if (subEl)   subEl.textContent   = meta.label + " · " + scores.length + " areas";

    const wrap = $("insp-overall");
    if (wrap) {
      ["tone-1","tone-2","tone-3","tone-4","tone-5"].forEach(function (t) {
        wrap.classList.remove("is-" + t);
      });
      wrap.classList.add("is-" + meta.tone);
    }
  }

  /* ---------- submit ---------- */

  function setSubmitError(msg) {
    const el = $("insp-submit-err");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.hidden = true; el.textContent = ""; }
  }

  async function onSubmit() {
    const btn = $("insp-submit-btn");
    if (!btn) return;
    setSubmitError("");

    // Pull customer + date from inputs (they may have changed since
    // module init). Inspector identity comes from the signed-in staff.
    const custSel = $("insp-customer");
    state.customer_slug = custSel ? custSel.value : "";
    const opt = custSel && custSel.options[custSel.selectedIndex];
    state.customer_name = (opt && opt.dataset && opt.dataset.name) || "";
    state.inspection_date = ($("insp-date") && $("insp-date").value) || todayLocalDate();
    state.notes = ($("insp-overall-notes") && $("insp-overall-notes").value) || "";

    if (!state.customer_slug) {
      setSubmitError("Pick a customer first.");
      return;
    }

    const staff = window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff && window.STAFF_AUTH.getCurrentStaff();
    if (!staff || !staff.uid) {
      setSubmitError("You appear to be signed out. Refresh and sign in again.");
      return;
    }

    const inspector_name =
      (staff.tech && staff.tech.display_name) ||
      (staff.email || "").split("@")[0] ||
      "Inspector";

    // Average across all areas. Decimal preserved for downstream
    // rolling averages — the UI rounds at display time.
    const scores  = INSPECTION_AREAS.map(function (a) { return state.area_scores[a.slug].score; });
    const overall = scores.reduce(function (s, n) { return s + n; }, 0) / scores.length;

    const sts = firebase.firestore.FieldValue.serverTimestamp();
    const doc = {
      // Identity / lookup
      customer_slug:                state.customer_slug,
      customer_name:                state.customer_name || "",
      inspector_name:               inspector_name,
      inspector_uid:                staff.uid,
      inspector_email:              String(staff.email || "").toLowerCase().trim(),

      // Timing
      inspection_started_at:        firebase.firestore.Timestamp.fromDate(state.inspection_started_at),
      inspection_submitted_at:      sts,
      inspection_date:              state.inspection_date,
      created_at:                   sts,
      updated_at:                   sts,

      // Context
      building_activity_level:      state.building_activity_level || "",
      cleaning_tech_present:        state.cleaning_tech_present === "yes" ? true
                                  : state.cleaning_tech_present === "no"  ? false
                                  : null,
      approximate_time_since_clean: state.approximate_time_since_clean || "",

      // Scoring
      overall_score:                Math.round(overall * 100) / 100,   // 2 decimals on disk
      area_scores:                  Object.keys(state.area_scores).reduce(function (out, k) {
        const a = state.area_scores[k];
        out[k] = {
          score:      a.score,
          score_label: SCORE_META[a.score].label,
          note:       String(a.note || "").trim(),
          photo_urls: Array.isArray(a.photo_urls) ? a.photo_urls.slice() : []
        };
        return out;
      }, {}),

      // Free-text / attachments
      notes:                        String(state.notes || "").trim(),
      photos:                       [],   // placeholder — wired in a follow-up

      // Future-ready aggregation fields (set when known; null otherwise).
      // Submit-side leaves them null; admin tools or scheduled jobs can
      // backfill from area_scores + customer/tech lookups later.
      cleaning_tech_slug:           null,
      cleaning_tech_display_name:   null,
      location_slug:                state.customer_slug,
      company_slug:                 "pioneer",   // operator constant
      schema_version:               "inspection.v1"
    };

    // Cleaning-tech attribution — captured at intake when the
    // inspector knows whose work is being evaluated. These fields
    // are the canonical hooks for future Cleaning Tech Quality math.
    // The `credited_team_*` arrays are stamped empty; a follow-up
    // build adds multi-tech / team attribution.
    const creditSel = $("insp-credit-tech");
    const creditSlug = creditSel ? (creditSel.value || "") : "";
    const creditOpt  = creditSel && creditSel.options[creditSel.selectedIndex];
    const creditName = (creditOpt && creditOpt.dataset && creditOpt.dataset.name) || "";
    doc.credited_cleaning_tech_slug = creditSlug || null;
    doc.credited_cleaning_tech_name = creditName || null;
    doc.credited_team_slugs         = [];
    doc.credited_team_names         = [];

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Submitting…";

    try {
      const ref = await firebase.firestore().collection("inspections").add(doc);

      // 5-star celebration writeback. Best-effort — if the win write
      // fails we still consider the inspection saved, since wins are
      // derivable from inspections (pioneerQualityViewV1 scans the
      // collection). The durable quality_wins record exists so future
      // moderation / "credit a tech" flows have a stable surface to
      // write to. Rules enforce the >= 4.8 threshold.
      if (doc.overall_score >= 4.8) {
        try {
          await firebase.firestore().collection("quality_wins").add({
            inspection_id:                ref.id,
            customer_slug:                doc.customer_slug,
            customer_name:                doc.customer_name || "",
            location_slug:                doc.location_slug || doc.customer_slug,
            location_name:                doc.location_name || doc.customer_name || "",
            inspection_date:              doc.inspection_date || "",
            overall_score:                doc.overall_score,
            // Credit fields — populated when the inspector tagged a
            // tech on intake. Surfaced ONLY in admin contexts; never
            // public. Preserves the "no inspector identity" rule
            // because this is the *cleaning* tech, not the inspector.
            credited_tech_slug:           doc.credited_cleaning_tech_slug || null,
            credited_tech_display_name:   doc.credited_cleaning_tech_name || null,
            celebration_message:          "🌟 5-Star Inspection!",
            active:                       true,
            created_at:                   sts,
            created_by:                   doc.inspector_email,
            archived_at:                  null,
            archived_by:                  null,
            schema_version:               "quality_win.v1"
          });
        } catch (winErr) {
          console.warn("[inspections] quality_wins writeback failed (non-fatal)", winErr && winErr.code);
        }
      }

      showSuccess(doc, ref.id);
    } catch (err) {
      console.error("[inspections] submit failed", err);
      const msg = (err && err.code === "permission-denied")
        ? "Permission denied. Make sure you're signed in as an admin."
        : ("Couldn't save inspection: " + (err && err.message || "unknown"));
      setSubmitError(msg);
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  /* ---------- success state ---------- */

  function showSuccess(doc, inspectionId) {
    const succ = $("insp-success");
    const content = $("staff-auth-content");
    if (!succ || !content) return;
    // Hide all input cards.
    $$("#insp-step-context, #insp-step-areas, #insp-step-wrap, .insp-actions, .insp-hero", content)
      .forEach(function (el) { el.hidden = true; });
    // Compose sub message.
    const sub = $("insp-success-sub");
    if (sub) {
      sub.textContent =
        "Saved to Pioneer records · Overall " + doc.overall_score.toFixed(1) +
        " · " + (doc.customer_name || doc.customer_slug);
    }
    // Celebration callout for >= 4.8.
    const celeb = $("insp-celebrate");
    if (celeb) celeb.hidden = !(doc.overall_score >= CELEBRATION_SCORE_THRESHOLD);

    // Wire "View customer quality history" to land on tech.html with
    // the inspected customer pre-selected via query param (tech.js
    // already honors the dropdown; we deep-link with ?customer=slug
    // for now — tech.js can be taught to consume it in a follow-up).
    const historyBtn = $("insp-success-history");
    if (historyBtn) {
      historyBtn.href = "/tech.html?customer=" + encodeURIComponent(doc.customer_slug);
    }
    succ.hidden = false;
    // Scroll to top so the success state is immediately visible.
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
  }

  function resetForm() {
    // Re-show input cards and reset state.
    const content = $("staff-auth-content");
    if (content) {
      $$("#insp-step-context, #insp-step-areas, #insp-step-wrap, .insp-actions, .insp-hero", content)
        .forEach(function (el) { el.hidden = false; });
    }
    const succ = $("insp-success");
    if (succ) succ.hidden = true;

    // Reset state.
    state.customer_slug = "";
    state.customer_name = "";
    state.inspection_date = todayLocalDate();
    state.inspection_started_at = new Date();
    state.building_activity_level = "";
    state.cleaning_tech_present   = "";
    state.approximate_time_since_clean = "";
    state.notes = "";
    INSPECTION_AREAS.forEach(function (a) {
      state.area_scores[a.slug] = { score: 3, note: "", photo_urls: [] };
    });

    // Reset DOM.
    const custSel = $("insp-customer");
    if (custSel) custSel.value = "";
    const creditSel = $("insp-credit-tech");
    if (creditSel) creditSel.value = "";
    const dateEl = $("insp-date");
    if (dateEl) dateEl.value = state.inspection_date;
    const notesEl = $("insp-overall-notes");
    if (notesEl) notesEl.value = "";
    $$(".insp-segmented .insp-pill").forEach(function (b) {
      b.classList.remove("is-selected");
      b.setAttribute("aria-pressed", "false");
    });
    renderAreas();
    renderOverallScore();
    const btn = $("insp-submit-btn");
    if (btn) { btn.disabled = false; btn.textContent = "Submit inspection"; }
    setSubmitError("");
  }

  /* ====================================================================
     Hub view — Pioneer Quality Score, recent inspections, archive
     ====================================================================
     Admin-only collection reads (rules already enforce). The hub
     fetches up to 100 most-recent inspections once on enter, then
     filters client-side for the Archive UX without composite indexes.

     Public morale rules per spec:
       • No inspector names in the public surface (we don't render any
         inspector identity on the hub cards; admins see it inside the
         detail modal — internal coaching context, not public shaming).
       • No per-task blame on low-score cards. The "Areas needing
         attention" callout names broad categories only ("Floors",
         "Bathrooms") — never per-task line items.
       • Notes are surfaced inside the admin-only modal, not the
         summary card.
     ==================================================================== */

  const HUB_INSPECTIONS_LIMIT = 100;
  const HUB_RECENT_DEFAULT    = 5;
  const ATTENTION_SCORE_THRESHOLD  = 3;
  const CELEBRATION_SCORE_THRESHOLD = 4.8;

  // Cache of inspection docs after the hub load. Indexed by id for
  // O(1) lookups when expanding a row into the detail modal.
  let hubInspections    = [];
  let hubInspectionById = {};

  // Map customer_slug → display name. Built when the customer
  // dropdown loads so the Recent / Archive cards can show the right
  // public-facing name even if an inspection doc was light on it.
  let hubCustomerNames = {};

  // Sortable timestamp ms helper — local copy (the function returns
  // a number, not an ISO).
  function inspTsMs(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function inspToneForScore(score) {
    const s = typeof score === "number" ? score : 3;
    if (s >= 4.5) return "tone-5";
    if (s >= 3.5) return "tone-4";
    if (s >= 2.5) return "tone-3";
    if (s >= 1.5) return "tone-2";
    return "tone-1";
  }

  function inspLabelForScore(score) {
    if (score == null) return "Awaiting inspections";
    if (score >= 4.5) return "Excellent · " + score.toFixed(1);
    if (score >= 3.5) return "Great · " + score.toFixed(1);
    if (score >= 2.5) return "Acceptable · " + score.toFixed(1);
    if (score >= 1.5) return "Needs work · " + score.toFixed(1);
    return "Critical · " + score.toFixed(1);
  }

  // Walk a newest-first array, counting consecutive docs with
  // overall_score >= threshold. Unknown scores skip (don't break).
  const STREAK_THRESHOLD = 4.5;
  function walkStreak(docsNewestFirst) {
    let n = 0;
    for (let i = 0; i < docsNewestFirst.length; i++) {
      const s = (docsNewestFirst[i] || {}).overall_score;
      if (typeof s !== "number") continue;
      if (s >= STREAK_THRESHOLD) n += 1;
      else break;
    }
    return n;
  }

  // Phase 2 normalization — snapshot KPI strip beneath the quality card.
  // Derives four counts from the in-memory `hubInspections` array; no
  // additional Firestore reads. Tones reflect operational direction
  // (positive when count > 0 for celebration metrics, attention when
  // count > 0 for follow-up metrics, neutral otherwise).
  function paintInspSnapshot(inspections) {
    const arr = Array.isArray(inspections) ? inspections : [];
    const nowMs    = Date.now();
    const week     = nowMs - (7  * 24 * 60 * 60 * 1000);
    const month    = nowMs - (30 * 24 * 60 * 60 * 1000);

    let last7 = 0, last30 = 0, fiveStar = 0, lowScore = 0;
    for (let i = 0; i < arr.length; i++) {
      const d  = arr[i] || {};
      const ms = inspTsMs(d.inspection_submitted_at) || inspTsMs(d.created_at);
      if (!ms) continue;
      if (ms >= week)  last7  += 1;
      if (ms >= month) {
        last30 += 1;
        const s = typeof d.overall_score === "number" ? d.overall_score : null;
        if (s !== null && s >= CELEBRATION_SCORE_THRESHOLD) fiveStar += 1;
        if (s !== null && s <  ATTENTION_SCORE_THRESHOLD)   lowScore += 1;
      }
    }

    function setTxt(id, txt) { const el = $(id); if (el) el.textContent = txt; }
    function setTone(id, tone) {
      const el = $(id);
      if (!el) return;
      const card = el.closest(".kpi-card");
      if (card) card.setAttribute("data-tone", tone);
    }

    setTxt("insp-snap-week",        String(last7));
    setTxt("insp-snap-month",       String(last30));
    setTxt("insp-snap-fivestar",    String(fiveStar));
    setTxt("insp-snap-low",         String(lowScore));

    // Meta lines stay descriptive; the value itself carries the story.
    setTxt("insp-snap-week-meta",     last7  === 0 ? "Quiet stretch"          : "Inspections logged");
    setTxt("insp-snap-month-meta",    last30 === 0 ? "No inspections yet"     : "Rolling window");
    setTxt("insp-snap-fivestar-meta", fiveStar > 0 ? "Worth celebrating"      : "Score ≥ 4.8");
    setTxt("insp-snap-low-meta",      lowScore > 0 ? "Open coaching loop"     : "Coaching follow-up");

    // Tone rails: positive for last7/last30 when > 0 (movement is good),
    // positive for fiveStar when > 0 (celebration), attention for
    // lowScore when > 0 (needs follow-up), neutral otherwise.
    setTone("insp-snap-week",      last7    > 0 ? "positive"  : "neutral");
    setTone("insp-snap-month",     last30   > 0 ? "positive"  : "neutral");
    setTone("insp-snap-fivestar",  fiveStar > 0 ? "positive"  : "neutral");
    setTone("insp-snap-low",       lowScore > 0 ? "attention" : "positive");
  }

  function paintQualityCard(rolling, streak) {
    const card  = $("insp-quality-card");
    const value = $("insp-quality-value");
    const label = $("insp-quality-label");
    const sub   = $("insp-quality-sub");
    const trend = $("insp-quality-trend-text");
    const streakEl = $("insp-quality-streak");
    if (!card || !value || !label || !sub) return;

    if (rolling == null || Number.isNaN(rolling)) {
      value.textContent = "—";
      label.textContent = "Awaiting inspections";
      sub.textContent = "Rolling 30-day average across all customers.";
      if (trend) trend.textContent = "Trend coming soon";
      if (streakEl) { streakEl.hidden = true; streakEl.textContent = ""; }
      card.setAttribute("data-tone", "tone-3");
      return;
    }
    value.textContent = rolling.toFixed(1);
    label.textContent = inspLabelForScore(rolling);
    sub.textContent = "Rolling 30-day average across all customers.";
    if (trend) trend.textContent = "Trend coming soon";
    card.setAttribute("data-tone", inspToneForScore(rolling));

    if (streakEl) {
      if (typeof streak === "number" && streak > 0) {
        streakEl.hidden = false;
        streakEl.innerHTML = '<span aria-hidden="true">🔥</span> ' +
          streak + ' inspection' + (streak === 1 ? '' : 's') +
          ' in a row above ' + STREAK_THRESHOLD.toFixed(1);
      } else {
        streakEl.hidden = true;
        streakEl.textContent = "";
      }
    }
  }

  // Friendly relative timestamp ("2 hours ago", "yesterday", "Mar 4").
  function relativeTime(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
    if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + "d ago";
    try {
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(ms));
    } catch (e) { return new Date(ms).toLocaleDateString(); }
  }

  // Public-safe rendering. NO inspector identity. Areas needing
  // attention surfaces broad CATEGORY names only, derived from
  // area_scores. v1 picks any area with score <= 2; broader, not
  // per-task.
  function lowAreasFor(doc) {
    const out = [];
    const scores = doc && doc.area_scores;
    if (!scores) return out;
    Object.keys(scores).forEach(function (slug) {
      const s = scores[slug] && scores[slug].score;
      if (typeof s === "number" && s <= 2) out.push(slug);
    });
    return out;
  }

  // Title-case the area slug for display. e.g. "entry_foyer" → "Entry / Foyer"
  const AREA_LABELS = {
    offices:        "Offices",
    bathrooms:      "Bathrooms",
    entry_foyer:    "Entry / Foyer",
    lunchroom:      "Lunchroom",
    common_areas:   "Common Areas",
    trash:          "Trash",
    floors:         "Floors",
    dusting:        "Dusting",
    glass:          "Glass",
    touchpoints:    "Touchpoints",
    supplies:       "Supplies"
  };

  function recentCardHtml(doc) {
    const score = typeof doc.overall_score === "number" ? doc.overall_score : null;
    const tone  = inspToneForScore(score || 0);
    const customerName = doc.customer_name ||
                         hubCustomerNames[doc.customer_slug] ||
                         doc.customer_slug ||
                         "(no customer)";
    const ms   = inspTsMs(doc.inspection_submitted_at) || inspTsMs(doc.created_at);
    const date = doc.inspection_date || "";
    const when = ms ? relativeTime(ms) : (date || "—");

    // Areas needing attention — broad categories only, no inspector
    // identity, no per-task callouts.
    let attentionHtml = "";
    if (score !== null && score < ATTENTION_SCORE_THRESHOLD) {
      const lows = lowAreasFor(doc).map(function (slug) { return AREA_LABELS[slug] || slug; });
      if (lows.length) {
        attentionHtml =
          '<div class="insp-recent-attention">' +
            '<strong>Areas needing attention:</strong> ' +
            escapeText(lows.join(" · ")) +
          '</div>';
      }
    }

    // Celebration micro-callout for high scores.
    const celebrationChip = score !== null && score >= CELEBRATION_SCORE_THRESHOLD
      ? '<div class="insp-recent-summary"><span class="insp-celebrate-emoji" aria-hidden="true">🌟</span> 5-star inspection — nice work, team.</div>'
      : "";

    // Admin-only quiet attention flag — surfaces ONE small chip when
    // the inspection has any area scoring under the area-attention
    // threshold (≤2). NOT public, NOT loud, NOT blame copy. Lives only
    // on /inspections.html which is admin-gated.
    const hasLowArea = (function () {
      const a = doc.area_scores || {};
      return Object.keys(a).some(function (k) {
        const v = a[k] && a[k].score;
        return typeof v === "number" && v <= 2;
      });
    })();
    const attentionChip = hasLowArea
      ? '<span class="insp-recent-attention-chip" title="Admin quiet flag — one or more areas scored ≤ 2">🚩 Attention</span>'
      : "";

    return (
      '<button type="button" class="insp-recent-row" role="listitem" data-id="' + escapeAttr(doc.id) + '">' +
        '<div>' +
          '<p class="insp-recent-customer">' + escapeText(customerName) + attentionChip + '</p>' +
          '<span class="insp-recent-meta">' + escapeText(when) +
            (date && when !== date ? ' · ' + escapeText(date) : '') +
          '</span>' +
          celebrationChip +
          attentionHtml +
        '</div>' +
        '<div class="insp-recent-score is-' + escapeAttr(tone) + '">' +
          (score !== null ? score.toFixed(1) : "—") +
        '</div>' +
        '<span class="insp-recent-view">View details</span>' +
      '</button>'
    );
  }

  function setRecentState(state, msg) {
    const loadEl  = $("insp-recent-loading");
    const errEl   = $("insp-recent-error");
    const emptyEl = $("insp-recent-empty");
    const listEl  = $("insp-recent-list");
    if (loadEl)  loadEl.hidden  = state !== "loading";
    if (errEl)   errEl.hidden   = state !== "error";
    if (emptyEl) emptyEl.hidden = state !== "empty";
    if (listEl)  listEl.hidden  = state !== "list";
    if (state === "error" && errEl && msg) errEl.textContent = msg;
  }

  function renderRecent() {
    const root = $("insp-recent-list");
    if (!root) return;
    const recent = hubInspections.slice(0, HUB_RECENT_DEFAULT);
    if (recent.length === 0) {
      setRecentState("empty");
      root.innerHTML = "";
      return;
    }
    root.innerHTML = recent.map(recentCardHtml).join("");
    setRecentState("list");
  }

  function renderArchive() {
    const root      = $("insp-archive-list");
    const status    = $("insp-archive-status");
    const searchVal = (($("insp-archive-search") && $("insp-archive-search").value) || "").trim().toLowerCase();
    const scoreVal  = ($("insp-archive-score") && $("insp-archive-score").value) || "all";
    if (!root) return;

    let filtered = hubInspections.slice();

    if (scoreVal !== "all") {
      const band = parseInt(scoreVal, 10);
      filtered = filtered.filter(function (d) {
        const s = typeof d.overall_score === "number" ? d.overall_score : null;
        if (s === null) return false;
        if (band === 5) return s >= 4.8;
        if (band === 4) return s >= 4 && s < 4.8;
        if (band === 3) return s >= 3 && s < 4;
        if (band === 2) return s >= 2 && s < 3;
        if (band === 1) return s < 2;
        return true;
      });
    }
    if (searchVal) {
      filtered = filtered.filter(function (d) {
        const hay = [
          d.customer_name, hubCustomerNames[d.customer_slug],
          d.customer_slug, d.inspector_name, d.notes
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.indexOf(searchVal) >= 0;
      });
    }

    if (filtered.length === 0) {
      root.innerHTML = "";
      if (status) {
        status.hidden = false;
        status.textContent = "No inspections match this filter.";
      }
      return;
    }
    root.innerHTML = filtered.map(recentCardHtml).join("");
    if (status) {
      status.hidden = false;
      status.textContent = "Showing " + filtered.length + " of " + hubInspections.length + " inspection" + (hubInspections.length === 1 ? "" : "s");
    }
  }

  async function loadHubInspections() {
    setRecentState("loading");
    try {
      // Try orderBy first — needs `inspection_submitted_at` indexed
      // (auto). Falls back to unordered if the field doesn't exist on
      // some legacy docs.
      const fs = firebase.firestore();
      let snap;
      try {
        snap = await fs.collection("inspections")
          .orderBy("inspection_submitted_at", "desc")
          .limit(HUB_INSPECTIONS_LIMIT)
          .get();
      } catch (err) {
        console.warn("[inspections-hub] orderBy fallback", err && err.code);
        snap = await fs.collection("inspections").limit(HUB_INSPECTIONS_LIMIT).get();
      }
      hubInspections = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      // Defensive: sort newest first.
      hubInspections.sort(function (a, b) {
        return inspTsMs(b.inspection_submitted_at) - inspTsMs(a.inspection_submitted_at);
      });
      hubInspectionById = {};
      hubInspections.forEach(function (d) { hubInspectionById[d.id] = d; });

      // Quality card uses the same data (avg of `overall_score` over
      // last 30 days). Computed client-side; admins already have full
      // read access to /inspections, so this stays accurate without a
      // round-trip to pioneerQualityViewV1.
      const cutoffMs = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const windowDocs = hubInspections.filter(function (d) {
        const ms = inspTsMs(d.inspection_submitted_at) || inspTsMs(d.created_at);
        return ms >= cutoffMs && typeof d.overall_score === "number";
      });
      const rolling = windowDocs.length
        ? Math.round((windowDocs.reduce(function (s, d) { return s + d.overall_score; }, 0) / windowDocs.length) * 10) / 10
        : null;
      const companyStreak = walkStreak(hubInspections);
      paintQualityCard(rolling, companyStreak);
      paintInspSnapshot(hubInspections);

      renderRecent();
      renderArchive();
    } catch (err) {
      console.error("[inspections-hub] load failed", err);
      setRecentState("error",
        (err && err.code === "permission-denied")
          ? "Permission denied — Inspections are admin-only."
          : "Couldn't load inspections. Check your connection and try again.");
    }
  }

  /* ---------- Inspection detail modal ---------- */

  function inspectionDetailHtml(doc) {
    const ctxBits = [
      { k: "Building activity", v: doc.building_activity_level || "—" },
      { k: "Tech present",
        v: doc.cleaning_tech_present === true  ? "Yes"
         : doc.cleaning_tech_present === false ? "No" : "—" },
      { k: "Time since clean", v: doc.approximate_time_since_clean || "—" }
    ];
    const ctxHtml = '<div class="insp-detail-context">' +
      ctxBits.map(function (b) {
        return '<div><span class="insp-detail-key">' + escapeText(b.k) + '</span>' + escapeText(b.v) + '</div>';
      }).join("") +
    '</div>';

    const scores = doc.area_scores || {};
    const order = ["offices","bathrooms","entry_foyer","lunchroom","common_areas","trash","floors","dusting","glass","touchpoints","supplies"];
    const areasHtml = '<div class="insp-detail-areas">' +
      order.map(function (slug) {
        const a = scores[slug];
        if (!a) return "";
        const score = typeof a.score === "number" ? a.score : null;
        const tone  = inspToneForScore(score || 0);
        const note  = (a.note || "").trim();
        return (
          '<div class="insp-detail-area-row">' +
            '<div>' +
              '<span class="insp-detail-area-name">' + escapeText(AREA_LABELS[slug] || slug) + '</span>' +
              (note ? '<p class="insp-detail-area-note">' + escapeText(note) + '</p>' : "") +
            '</div>' +
            '<span class="insp-detail-area-score is-' + escapeAttr(tone) + '">' +
              (score !== null ? score : "—") +
            '</span>' +
          '</div>'
        );
      }).join("") +
    '</div>';

    const notes = (doc.notes || "").trim();
    const notesHtml = notes
      ? '<p class="insp-detail-notes">' + escapeText(notes) + '</p>'
      : '<p class="insp-detail-notes-empty">No overall notes.</p>';

    const score = typeof doc.overall_score === "number" ? doc.overall_score : null;
    const tone  = inspToneForScore(score || 0);
    const customerName = doc.customer_name || hubCustomerNames[doc.customer_slug] || doc.customer_slug || "(no customer)";
    const inspectorBit = doc.inspector_name
      ? ' · Inspected by ' + escapeText(doc.inspector_name)
      : "";
    const dateBit = doc.inspection_date
      ? ' · ' + escapeText(doc.inspection_date)
      : "";

    return (
      '<div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">' +
        '<div class="insp-recent-score is-' + escapeAttr(tone) + '" style="min-width:74px;height:64px;font-size:28px;">' +
          (score !== null ? score.toFixed(1) : "—") +
        '</div>' +
        '<div style="min-width:0;">' +
          '<p style="margin:0;font-size:16px;font-weight:800;">' + escapeText(customerName) + '</p>' +
          '<span style="font-size:12px;color:var(--pc-text-muted,#475569);">' +
            (doc.location_name && doc.location_name !== customerName ? escapeText(doc.location_name) : "") +
            inspectorBit + dateBit +
          '</span>' +
        '</div>' +
      '</div>' +
      ctxHtml +
      '<h3 style="margin:12px 0 4px;font-size:13px;letter-spacing:0.3px;text-transform:uppercase;color:var(--pc-text-subtle,#64748b);">Area scores</h3>' +
      areasHtml +
      '<h3 style="margin:12px 0 4px;font-size:13px;letter-spacing:0.3px;text-transform:uppercase;color:var(--pc-text-subtle,#64748b);">Notes</h3>' +
      notesHtml
    );
  }

  let detailCurrentDoc = null;
  function openInspectionDetail(id) {
    const doc = hubInspectionById[id];
    if (!doc) return;
    detailCurrentDoc = doc;
    const body = $("insp-detail-body");
    const title = $("insp-detail-title");
    if (title) title.textContent = "Inspection · " + (doc.customer_name || hubCustomerNames[doc.customer_slug] || doc.customer_slug || "");
    if (body) body.innerHTML = inspectionDetailHtml(doc);
    openInspModal("insp-detail-modal");
  }

  /* ---------- Service Recovery modal ---------- */

  let srSelectedSeverity = "";

  function openServiceRecoveryFor(inspectionDoc) {
    const modal = $("sr-modal");
    if (!modal) return;
    // Populate hidden FKs.
    $("sr-customer-slug").value = inspectionDoc ? inspectionDoc.customer_slug : "";
    $("sr-inspection-id").value = inspectionDoc ? inspectionDoc.id : "";
    // Reset fields.
    $("sr-area").value = "";
    $("sr-description").value = "";
    $("sr-assigned").value = "";
    $("sr-due").value = "";
    srSelectedSeverity = "";
    $$('[data-sr-severity] .insp-pill', modal).forEach(function (b) {
      b.classList.remove("is-selected");
      b.setAttribute("aria-pressed", "false");
    });
    const err = $("sr-err"); if (err) { err.hidden = true; err.textContent = ""; }
    const ctx = $("sr-modal-context");
    if (ctx) {
      ctx.textContent = inspectionDoc
        ? ("Linked to inspection for " + (inspectionDoc.customer_name || hubCustomerNames[inspectionDoc.customer_slug] || inspectionDoc.customer_slug) + ".")
        : "Capture a follow-up so the team can make this right.";
    }
    openInspModal("sr-modal");
  }

  async function loadSrAssignedDropdown() {
    const sel = $("sr-assigned");
    if (!sel) return;
    sel.innerHTML = '<option value="">— Unassigned —</option>';
    try {
      const snap = await firebase.firestore().collection("cleaning_techs").get();
      const techs = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (t) { return t.active !== false; })
        .sort(function (a, b) {
          return (a.display_name || a.tech_slug || a.id).localeCompare(b.display_name || b.tech_slug || b.id);
        });
      techs.forEach(function (t) {
        const slug = t.tech_slug || t.id;
        const email = (t.email || "").toLowerCase().trim();
        const name = t.display_name || slug;
        const opt = document.createElement("option");
        opt.value = slug;
        opt.dataset.email = email;
        opt.dataset.name  = name;
        opt.textContent = name + (email ? " (" + email + ")" : "");
        sel.appendChild(opt);
      });
    } catch (err) {
      console.warn("[sr] couldn't load techs", err);
    }
  }

  async function submitServiceRecovery() {
    const btn   = $("sr-submit");
    const err   = $("sr-err");
    const slug  = $("sr-customer-slug").value || "";
    const inspId = $("sr-inspection-id").value || "";
    const area  = $("sr-area").value;
    const desc  = $("sr-description").value.trim();
    const assignedSel = $("sr-assigned");
    const dueStr = $("sr-due").value;

    function showErr(msg) {
      if (!err) return;
      err.hidden = false;
      err.textContent = msg;
    }
    if (err) { err.hidden = true; err.textContent = ""; }

    if (!slug) return showErr("Lost customer context — close and reopen.");
    if (!area) return showErr("Pick an area.");
    if (!srSelectedSeverity) return showErr("Pick a severity.");
    if (!desc) return showErr("Describe what needs to happen.");

    const staff = window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff && window.STAFF_AUTH.getCurrentStaff();
    if (!staff || !staff.uid) return showErr("You appear to be signed out. Refresh and sign in again.");

    let assignedTo = "", assignedEmail = "", assignedName = "";
    if (assignedSel && assignedSel.value) {
      assignedTo    = assignedSel.value;
      const opt     = assignedSel.options[assignedSel.selectedIndex];
      assignedEmail = (opt && opt.dataset && opt.dataset.email) || "";
      assignedName  = (opt && opt.dataset && opt.dataset.name)  || "";
    }

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Saving…";

    try {
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const linkedDoc = inspId ? hubInspectionById[inspId] : null;
      await firebase.firestore().collection("service_recoveries").add({
        customer_slug:               slug,
        customer_name:               (linkedDoc && linkedDoc.customer_name) || hubCustomerNames[slug] || "",
        inspection_id:               inspId || null,
        area:                        area,
        severity:                    srSelectedSeverity,
        description:                 desc,
        assigned_to:                 assignedTo || null,
        assigned_to_email:           assignedEmail || null,
        assigned_to_display_name:    assignedName || null,
        due_date:                    dueStr || null,
        status:                      "open",
        resolution_notes:            null,
        resolved_at:                 null,
        resolved_by:                 null,
        created_by:                  String(staff.email || "").toLowerCase().trim(),
        created_at:                  sts,
        updated_at:                  sts,
        updated_by:                  String(staff.email || "").toLowerCase().trim(),
        schema_version:              "service_recovery.v1"
      });
      closeInspModal("sr-modal");
      // Tiny inline toast — we don't ship a full toast component on
      // this page, so use an alert as a stopgap.
      window.alert("Service Recovery created.");
    } catch (e2) {
      console.error("[sr] submit failed", e2);
      const msg = (e2 && e2.code === "permission-denied")
        ? "Permission denied. Service Recoveries are admin-only."
        : "Couldn't save Service Recovery. Check your connection and try again.";
      showErr(msg);
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  /* ---------- modal helpers ---------- */

  function openInspModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeInspModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
  function wireInspModals() {
    document.querySelectorAll(".insp-modal").forEach(function (modal) {
      modal.querySelectorAll("[data-modal-close]").forEach(function (el) {
        el.addEventListener("click", function () { closeInspModal(modal.id); });
      });
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      document.querySelectorAll(".insp-modal").forEach(function (m) {
        if (!m.hidden) closeInspModal(m.id);
      });
    });
    // Recent + archive list — event-delegate row clicks → open detail.
    ["insp-recent-list", "insp-archive-list"].forEach(function (listId) {
      const list = $(listId);
      if (!list) return;
      list.addEventListener("click", function (ev) {
        const row = ev.target.closest(".insp-recent-row");
        if (!row) return;
        openInspectionDetail(row.dataset.id);
      });
    });
    // Detail → Create Service Recovery.
    const srBtn = $("insp-detail-create-sr");
    if (srBtn) srBtn.addEventListener("click", function () {
      if (!detailCurrentDoc) return;
      closeInspModal("insp-detail-modal");
      openServiceRecoveryFor(detailCurrentDoc);
    });
    // SR severity pills.
    const sevGroup = document.querySelector('[data-sr-severity]');
    if (sevGroup) {
      sevGroup.addEventListener("click", function (ev) {
        const btn = ev.target.closest(".insp-pill");
        if (!btn) return;
        sevGroup.querySelectorAll(".insp-pill").forEach(function (b) {
          b.classList.toggle("is-selected", b === btn);
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        srSelectedSeverity = btn.dataset.value || "";
      });
    }
    const srSubmit = $("sr-submit");
    if (srSubmit) srSubmit.addEventListener("click", submitServiceRecovery);
  }

  /* ---------- View toggle ---------- */

  function showIntakeView() {
    const hub = $("insp-hub-view");
    const intake = $("insp-intake-view");
    if (hub) hub.hidden = true;
    if (intake) intake.hidden = false;
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
  }
  function showHubView() {
    const hub = $("insp-hub-view");
    const intake = $("insp-intake-view");
    if (hub) hub.hidden = false;
    if (intake) intake.hidden = true;
    // Reload the hub so any inspection just submitted appears.
    loadHubInspections();
  }

  function wireHubControls() {
    const newBtn = $("insp-new-btn");
    if (newBtn) newBtn.addEventListener("click", function () { showIntakeView(); });
    const backBtn = $("insp-back-to-hub");
    if (backBtn) backBtn.addEventListener("click", function () { showHubView(); });
    const archToggle = $("insp-archive-toggle");
    const archBody   = $("insp-archive-body");
    if (archToggle && archBody) {
      archToggle.addEventListener("click", function () {
        const expanded = archToggle.getAttribute("aria-expanded") === "true";
        archToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
        archBody.hidden = expanded;
        if (!expanded) renderArchive();
      });
    }
    const search = $("insp-archive-search");
    if (search) search.addEventListener("input", renderArchive);
    const scoreSel = $("insp-archive-score");
    if (scoreSel) scoreSel.addEventListener("change", renderArchive);
  }

  /* ====================================================================
     Boot
     ==================================================================== */

  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
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
          // v1: admin-only. Cleaning techs land on the denied screen
          // with a clearer message (the role check is per the spec —
          // adjust here when an "inspector" role is introduced).
          if (!staff || staff.role !== "admin") {
            setStaffAuthState("denied");
            const msgEl = $("staff-auth-denied-msg");
            if (msgEl) {
              msgEl.textContent =
                "Inspections are admin-only right now. " +
                "Tech access lands later — for now, ask an admin to inspect on your behalf.";
            }
            return;
          }
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);

          const dateEl = $("insp-date");
          if (dateEl && !dateEl.value) dateEl.value = todayLocalDate();
          state.inspection_date = (dateEl && dateEl.value) || todayLocalDate();
          state.inspection_started_at = new Date();

          loadCustomers();
          loadCreditTechDropdown();
          wireContextPills();
          renderAreas();
          wireAreas();
          renderOverallScore();
          const btn = $("insp-submit-btn");
          if (btn && !btn.dataset.wired) {
            btn.dataset.wired = "1";
            btn.addEventListener("click", onSubmit);
          }
          const again = $("insp-success-new");
          if (again && !again.dataset.wired) {
            again.dataset.wired = "1";
            again.addEventListener("click", resetForm);
          }
          const backToHub = $("insp-success-back-to-hub");
          if (backToHub && !backToHub.dataset.wired) {
            backToHub.dataset.wired = "1";
            backToHub.addEventListener("click", function () {
              resetForm();
              showHubView();
            });
          }
          // Wire customer dropdown change → cache name on state.
          const custSel = $("insp-customer");
          if (custSel && !custSel.dataset.wired) {
            custSel.dataset.wired = "1";
            custSel.addEventListener("change", function () {
              const opt = custSel.options[custSel.selectedIndex];
              state.customer_slug = custSel.value || "";
              state.customer_name = (opt && opt.dataset && opt.dataset.name) || "";
            });
          }

          // Hub wiring + initial load.
          wireHubControls();
          wireInspModals();
          loadHubInspections();
          loadSrAssignedDropdown();

          // ?mode=new deep-link straight into the intake.
          try {
            const params = new URLSearchParams(location.search || "");
            if ((params.get("mode") || "").trim() === "new") showIntakeView();
          } catch (e) { /* ignore */ }
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
