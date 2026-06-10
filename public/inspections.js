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

  // Phase Inspection V2 — objective inspection template. Mirrors the
  // DCR cleaning sections (per spec) and forces each item to a discrete
  // verdict: N/A, Pass, Great, or Fail. Subjective 1-5 ratings are gone
  // — the inspector validates DCR completion rather than expressing
  // opinions. Items are hardcoded here; a per-customer template
  // override can land later without changing the doc schema.
  //
  // Item key = "{section.slug}::{item.slug}" — used as the map key on
  // state.inspection_items so we can look up + mutate by ID in O(1)
  // without walking the array.
  const INSPECTION_TEMPLATE_V2 = [
    { slug: "trash",         label: "Trash", items: [
      { slug: "all_bins_emptied",        label: "All trash bins emptied" },
      { slug: "new_liners_installed",    label: "New liners installed" },
      { slug: "trash_area_clean",        label: "Trash area left clean" }
    ]},
    { slug: "restrooms",     label: "Restrooms", items: [
      { slug: "toilets_sanitized",       label: "Toilets cleaned and sanitized" },
      { slug: "sinks_counters_wiped",    label: "Sinks and counters wiped" },
      { slug: "mirrors_streak_free",     label: "Mirrors streak-free" },
      { slug: "floors_mopped",           label: "Floors mopped" },
      { slug: "soap_paper_restocked",    label: "Soap / paper restocked" },
      { slug: "trash_emptied",           label: "Restroom trash emptied" }
    ]},
    { slug: "breakroom",     label: "Breakroom", items: [
      { slug: "counters_wiped",          label: "Counters wiped" },
      { slug: "sink_cleaned",            label: "Sink cleaned" },
      { slug: "microwave_wiped",         label: "Microwave wiped (inside + out)" },
      { slug: "tables_clean",            label: "Tables clean" },
      { slug: "floor_swept_mopped",      label: "Floor swept and mopped" },
      { slug: "trash_emptied",           label: "Breakroom trash emptied" }
    ]},
    { slug: "floors",        label: "Floors", items: [
      { slug: "vacuumed",                label: "Carpets vacuumed" },
      { slug: "mopped",                  label: "Hard floors mopped" },
      { slug: "edges_done",              label: "Edges and corners addressed" },
      { slug: "no_visible_debris",       label: "No visible debris remaining" }
    ]},
    { slug: "dusting",       label: "Dusting", items: [
      { slug: "surfaces_dusted",         label: "Desk and counter surfaces dusted" },
      { slug: "high_touch_wiped",        label: "High-touch surfaces wiped" },
      { slug: "vents_blinds",            label: "Vents and blinds dusted (as scheduled)" }
    ]},
    { slug: "entry",         label: "Entry", items: [
      { slug: "glass_cleaned",           label: "Entry glass cleaned" },
      { slug: "mats_vacuumed",           label: "Mats vacuumed" },
      { slug: "entry_floors",            label: "Entry floors mopped" }
    ]},
    { slug: "security",      label: "Security", items: [
      { slug: "doors_locked",            label: "All exterior doors locked" },
      { slug: "lights_set",              label: "Lights set per customer protocol" },
      { slug: "alarm_armed",             label: "Alarm armed (if applicable)" }
    ]},
    { slug: "supplies",      label: "Supplies", items: [
      { slug: "toilet_paper",            label: "Toilet paper restocked" },
      { slug: "paper_towels",            label: "Paper towels restocked" },
      { slug: "hand_soap",               label: "Hand soap restocked" },
      { slug: "liners",                  label: "Trash liners restocked" },
      { slug: "janitorial_closet",       label: "Janitorial closet clean and organized" }
    ]}
  ];

  // Per-item verdict metadata. Order matters — buttons render in this
  // sequence (N/A first so a non-applicable item can be cleared from
  // the scoring denominator with one tap).
  //
  // Phase V2.1 scoring (recalibrated):
  //   Fail  = 0     coaching needed; the only verdict that hurts the score
  //   Pass  = 1     met Pioneer standard — successful
  //   Great = 1.25  exceptional, called out separately as praise
  //   N/A          excluded from both numerator and denominator
  //
  // The 0-5 conversion in computeScoreV2 multiplies (earned / scored)
  // by 5 and clamps at 5. A clean all-Pass inspection scores 5.0 — Pass
  // is celebrated, not shamed. Greats can't pull the score above 5 but
  // surface separately as a praise signal.
  const V2_RESULTS = [
    { value: "na",    label: "N/A",   short: "N/A",   tone: "tone-na",    points: null, includeInScore: false },
    { value: "pass",  label: "Pass",  short: "Pass",  tone: "tone-pass",  points: 1,    includeInScore: true  },
    { value: "great", label: "Great", short: "Great", tone: "tone-great", points: 1.25, includeInScore: true  },
    { value: "fail",  label: "Fail",  short: "Fail",  tone: "tone-fail",  points: 0,    includeInScore: true  }
  ];
  const V2_RESULT_META = V2_RESULTS.reduce(function (o, r) { o[r.value] = r; return o; }, {});

  function itemKey(sectionSlug, itemSlug) { return sectionSlug + "::" + itemSlug; }

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
    // Phase V2 — per-item verdicts. Map keyed by "{section}::{item}",
    // value: { result: null|"pass"|"great"|"fail"|"na", comment, photo_urls }.
    // Items start unselected so the inspector has to make a conscious
    // choice on each one — that's the objectivity guarantee.
    inspection_items: (function () {
      const obj = {};
      INSPECTION_TEMPLATE_V2.forEach(function (sec) {
        sec.items.forEach(function (it) {
          obj[itemKey(sec.slug, it.slug)] = { result: null, comment: "", photo_urls: [] };
        });
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

  /* ---------- Phase V2 — section + item rendering ----------
     Each section is a labeled card. Within it, every item exposes a
     four-button toggle (N/A · Pass · Great · Fail). Fail expands a
     comment box (required before submit). Great optionally collects
     a "what was great" praise note. */

  function renderAreas() {
    const root = $("insp-areas");
    if (!root) return;
    root.innerHTML = INSPECTION_TEMPLATE_V2.map(renderSectionHtml).join("");
  }

  function renderSectionHtml(section) {
    // Phase V2.1 — no per-section averages or progress counters.
    // The objective verdict per item is the unit of truth; section
    // rollups add noise without adding coaching value.
    return (
      '<article class="insp-section" data-section-slug="' + escapeAttr(section.slug) + '">' +
        '<header class="insp-section-head">' +
          '<h3 class="insp-section-title">' + escapeText(section.label) + '</h3>' +
        '</header>' +
        '<div class="insp-section-items">' +
          section.items.map(function (it) { return renderItemHtml(section, it); }).join("") +
        '</div>' +
      '</article>'
    );
  }

  function renderItemHtml(section, item) {
    const key = itemKey(section.slug, item.slug);
    return (
      '<div class="insp-item" data-key="' + escapeAttr(key) + '" data-result="">' +
        '<div class="insp-item-line">' +
          '<span class="insp-item-label">' + escapeText(item.label) + '</span>' +
          '<div class="insp-item-results" role="radiogroup" aria-label="' +
              escapeAttr(item.label) + ' result">' +
            V2_RESULTS.map(function (r) {
              return '<button type="button" class="insp-item-btn ' + escapeAttr(r.tone) +
                     '" data-result="' + escapeAttr(r.value) +
                     '" aria-pressed="false">' + escapeText(r.short) + '</button>';
            }).join("") +
          '</div>' +
        '</div>' +
        // Comment row hidden until result === fail or great. Fail
        // requires the comment; great makes it optional praise.
        '<div class="insp-item-comment" hidden data-role="comment-wrap">' +
          '<textarea class="insp-item-comment-input" data-role="comment-input"' +
                   ' rows="2" maxlength="1000"' +
                   ' placeholder="What did you see?"></textarea>' +
          '<button type="button" class="insp-item-photo" data-action="add-photo" disabled' +
                 ' title="Photo upload lands in a follow-up build">' +
            '📷 Add photo (coming soon)' +
          '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function applyItemResult(itemEl, result) {
    const key = itemEl.dataset.key;
    if (!key || !state.inspection_items[key]) return;
    const cur = state.inspection_items[key];
    const meta = V2_RESULT_META[result];
    if (!meta) return;

    cur.result = result;

    // Update pressed state on buttons.
    itemEl.querySelectorAll(".insp-item-btn").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.result === result ? "true" : "false");
    });
    itemEl.dataset.result = result;

    // Show/hide the comment box. Fail and Great both reveal it. Pass
    // and N/A clear it from view (state preserved if they flip back).
    const wrap = itemEl.querySelector('[data-role="comment-wrap"]');
    const input = itemEl.querySelector('[data-role="comment-input"]');
    if (wrap) {
      const showComment = (result === "fail" || result === "great");
      wrap.hidden = !showComment;
      if (input) {
        input.placeholder = (result === "fail")
          ? "What was missing or unacceptable? (required)"
          : (result === "great")
            ? "What made this great? (optional)"
            : "What did you see?";
        if (showComment) {
          input.value = cur.comment || "";
          setTimeout(function () { input.focus(); }, 60);
        }
      }
    }
    renderOverallScore();
  }

  function wireAreas() {
    const root = $("insp-areas");
    if (!root) return;

    // Verdict button delegator.
    root.addEventListener("click", function (ev) {
      const btn = ev.target.closest(".insp-item-btn");
      if (!btn) return;
      const itemEl = btn.closest(".insp-item");
      if (itemEl) applyItemResult(itemEl, btn.dataset.result);
    });

    // Comment text input sync.
    root.addEventListener("input", function (ev) {
      const ta = ev.target.closest('[data-role="comment-input"]');
      if (!ta) return;
      const itemEl = ta.closest(".insp-item");
      if (!itemEl) return;
      const key = itemEl.dataset.key;
      if (state.inspection_items[key]) {
        state.inspection_items[key].comment = ta.value;
      }
    });
  }

  /* ---------- Phase V2.1 (recalibrated) — overall score ----------
     Score math:
       fail = 0, pass = 1, great = 1.25, n/a excluded from both sides.
       base_score    = earned_points / scored_count        (0..1.25)
       overall_score = min(5, base_score * 5)              (0..5)
     A clean all-Pass run lands at 5.0 — Pass is treated as successful,
     not mediocre. Great can't pull the score above 5 by itself; it
     surfaces separately as a praise signal next to the overall.

     pass_pct / great_pct / fail_pct are over the scored denominator
     (n/a excluded), unchanged from prior V2.

     If nothing is scored yet, overall_score reads "—" so the inspector
     doesn't see a misleading 0. */

  function computeScoreV2() {
    let pass = 0, great = 0, fail = 0, na = 0, earned = 0;
    Object.keys(state.inspection_items).forEach(function (k) {
      const r = state.inspection_items[k].result;
      if (r === "pass")       { pass++;  earned += 1.0;  }
      else if (r === "great") { great++; earned += 1.25; }
      else if (r === "fail")  { fail++; /* +0 */         }
      else if (r === "na")    { na++;  }
    });
    const scored = pass + great + fail;
    const baseScore = scored > 0 ? earned / scored : null;
    return {
      pass_count: pass, great_count: great, fail_count: fail, na_count: na,
      scored_count:  scored,
      earned_points: earned,
      earned_ratio:  baseScore,                                          // 0..1.25 (uncapped)
      overall_score: baseScore != null ? Math.min(5, baseScore * 5) : null,
      pass_pct:      scored > 0 ? pass  / scored : 0,
      great_pct:     scored > 0 ? great / scored : 0,
      fail_pct:      scored > 0 ? fail  / scored : 0
    };
  }

  function renderOverallScore() {
    const valueEl = $("insp-overall-value");
    const emojiEl = $("insp-overall-emoji");
    const subEl   = $("insp-overall-sub");
    if (!valueEl) return;
    const s = computeScoreV2();
    if (s.scored_count === 0) {
      valueEl.textContent = "—";
      if (subEl)   subEl.textContent   = "Mark items to start scoring";
      if (emojiEl) emojiEl.textContent = "•";
      setOverallTone("tone-empty");
      return;
    }
    valueEl.textContent = (Math.round(s.overall_score * 10) / 10).toFixed(1);
    // Phase V2.1 — show pass / great / fail only. N/A is excluded from
    // scoring on purpose; not surfacing it keeps the readout tied to
    // what actually counted.
    if (subEl) {
      subEl.textContent =
        s.pass_count  + " pass · " +
        s.great_count + " great · " +
        s.fail_count  + " fail";
    }

    // Choose tone by fail rate first, then by great share.
    let tone, emoji;
    if (s.fail_count > 0)        { tone = "tone-fail";  emoji = "⚠️"; }
    else if (s.great_pct >= 0.5) { tone = "tone-great"; emoji = "🌟"; }
    else                         { tone = "tone-pass";  emoji = "✓";  }
    if (emojiEl) emojiEl.textContent = emoji;
    setOverallTone(tone);
  }

  function setOverallTone(tone) {
    const wrap = $("insp-overall");
    if (!wrap) return;
    ["tone-1","tone-2","tone-3","tone-4","tone-5",
     "tone-empty","tone-pass","tone-great","tone-fail"].forEach(function (t) {
      wrap.classList.remove("is-" + t);
    });
    wrap.classList.add("is-" + tone);
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

    // Phase V2 — scoring computed from inspection_items.
    const v2 = computeScoreV2();
    if (v2.scored_count === 0) {
      setSubmitError("Mark at least one item before submitting.");
      return;
    }
    // Each Fail must carry a comment — that's the objectivity guarantee.
    const failsMissingComment = [];
    Object.keys(state.inspection_items).forEach(function (k) {
      const it = state.inspection_items[k];
      if (it.result === "fail" && !String(it.comment || "").trim()) {
        failsMissingComment.push(k);
      }
    });
    if (failsMissingComment.length) {
      setSubmitError("Add a comment for each failed item (" +
        failsMissingComment.length + " missing).");
      return;
    }

    // Flatten inspection_items into an ordered array that matches the
    // template — readers don't have to know about map keys.
    const itemsFlat = [];
    INSPECTION_TEMPLATE_V2.forEach(function (sec) {
      sec.items.forEach(function (it) {
        const key = itemKey(sec.slug, it.slug);
        const cur = state.inspection_items[key];
        if (!cur || cur.result == null) return; // skip unmarked items
        itemsFlat.push({
          section:      sec.slug,
          section_label: sec.label,
          item:         it.slug,
          item_label:   it.label,
          result:       cur.result,
          comment:      String(cur.comment || "").trim(),
          photo_urls:   Array.isArray(cur.photo_urls) ? cur.photo_urls.slice() : []
        });
      });
    });

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

      // Phase V2 scoring
      inspection_items:             itemsFlat,
      pass_count:                   v2.pass_count,
      great_count:                  v2.great_count,
      fail_count:                   v2.fail_count,
      na_count:                     v2.na_count,
      scored_count:                 v2.scored_count,
      earned_points:                Math.round(v2.earned_points * 100) / 100,
      earned_ratio:                 Math.round(v2.earned_ratio * 10000) / 10000,
      pass_pct:                     Math.round(v2.pass_pct  * 10000) / 10000,
      great_pct:                    Math.round(v2.great_pct * 10000) / 10000,
      fail_pct:                     Math.round(v2.fail_pct  * 10000) / 10000,
      // 0-5 scale for back-compat with /ceo, /tech, /team-hub readers
      // that already speak v1's overall_score. V2.1-aware readers can
      // prefer earned_ratio (0..1.25, uncapped) for the precise number.
      overall_score:                Math.round(v2.overall_score * 100) / 100,

      // Free-text / attachments
      notes:                        String(state.notes || "").trim(),
      photos:                       [],

      // Future-ready aggregation fields.
      cleaning_tech_slug:           null,
      cleaning_tech_display_name:   null,
      location_slug:                state.customer_slug,
      company_slug:                 "pioneer",
      schema_version:               "inspection.v2.1"
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

      // Phase Timeclock Add-On — if the inspector clocked in for this
      // walk, link the new inspection id back to the active session so
      // payroll can see what was produced during the paid time.
      if (window.NonServiceClock) {
        const stf = window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff
          ? window.STAFF_AUTH.getCurrentStaff() : null;
        if (stf) {
          window.NonServiceClock.patchActiveSession(stf, {
            inspection_id: ref.id
          }).catch(function () {});
        }
      }
      showSuccess(doc, ref.id);
      // v1.0 audit fix — refresh the registry so Laura/Jared see the
      // cycle close immediately on the same page. The Cloud Function
      // onInspectionCreatedV1 needs ~1-2s to land its state update, so
      // we delay the read a beat. If the function hasn't fired yet, the
      // worst case is the operator sees their own write reflected from
      // an earlier load — a follow-up render will catch up.
      setTimeout(function () {
        if (typeof loadAndRenderRegistry === "function") {
          loadAndRenderRegistry().catch(function (e) {
            console.warn("[inspections] post-submit registry refresh failed", e);
          });
        }
      }, 2500);
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
    state.inspection_items = {};
    INSPECTION_TEMPLATE_V2.forEach(function (sec) {
      sec.items.forEach(function (it) {
        state.inspection_items[itemKey(sec.slug, it.slug)] =
          { result: null, comment: "", photo_urls: [] };
      });
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

  // Public-safe rendering. NO inspector identity. "Areas needing
  // attention" surfaces broad CATEGORY names only. For v2 docs that's
  // any section with at least one failing item. For legacy v1 docs
  // it's any area with score <= 2.
  function lowAreasFor(doc) {
    if (!doc) return [];
    // v2 path
    if (Array.isArray(doc.inspection_items)) {
      const sectionLabels = {};
      doc.inspection_items.forEach(function (it) {
        if (it && it.result === "fail") {
          const label = it.section_label || it.section || "";
          if (label) sectionLabels[label] = true;
        }
      });
      return Object.keys(sectionLabels);
    }
    // v1 path
    const out = [];
    const scores = doc.area_scores;
    if (!scores) return out;
    Object.keys(scores).forEach(function (slug) {
      const s = scores[slug] && scores[slug].score;
      if (typeof s === "number" && s <= 2) out.push(AREA_LABELS[slug] || slug);
    });
    return out;
  }

  function hasAttentionForRow(doc) {
    if (!doc) return false;
    if (Array.isArray(doc.inspection_items)) {
      return doc.inspection_items.some(function (it) { return it && it.result === "fail"; });
    }
    const a = doc.area_scores || {};
    return Object.keys(a).some(function (k) {
      const v = a[k] && a[k].score;
      return typeof v === "number" && v <= 2;
    });
  }

  // Title-case the area slug for display. e.g. "entry_foyer" → "Entry / Foyer"
  // Legacy v1 area labels, kept for displaying older docs.
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
    // identity, no per-task callouts. lowAreasFor handles both v1 and
    // v2 docs and already returns display-ready labels.
    let attentionHtml = "";
    if (score !== null && score < ATTENTION_SCORE_THRESHOLD) {
      const lows = lowAreasFor(doc);
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

    // Admin-only quiet attention flag — v1 = any area scoring ≤ 2;
    // v2 = any failed item. Lives only on admin-gated /inspections.html.
    const attentionChip = hasAttentionForRow(doc)
      ? '<span class="insp-recent-attention-chip" title="Admin quiet flag — needs attention">🚩 Attention</span>'
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

    // Branch on schema version. v2 docs carry inspection_items[];
    // v1 docs carry area_scores{}. v2 renderer groups items by section
    // and shows their per-item verdict + comments.
    const isV2 = Array.isArray(doc.inspection_items);
    let areasHtml = "";
    if (isV2) {
      const grouped = {};
      doc.inspection_items.forEach(function (it) {
        const sec = it.section_label || it.section || "Other";
        if (!grouped[sec]) grouped[sec] = [];
        grouped[sec].push(it);
      });
      // Section order — match the template if possible, else alphabetical
      const order = INSPECTION_TEMPLATE_V2.map(function (s) { return s.label; });
      const sectionsToShow = order.filter(function (s) { return grouped[s]; })
        .concat(Object.keys(grouped).filter(function (s) { return order.indexOf(s) < 0; }));
      // Phase V2.1 — display Pass / Great / Fail only. N/A is excluded
      // from scoring; surfacing it here would imply it counts. The
      // per-item rows below still render N/A verdicts for context.
      const counts = {
        pass:  doc.pass_count  || 0,
        great: doc.great_count || 0,
        fail:  doc.fail_count  || 0
      };
      const summaryHtml = '<div class="insp-detail-summary">' +
        '<span class="insp-detail-summary-chip tone-pass">'  + counts.pass  + ' Pass</span>' +
        '<span class="insp-detail-summary-chip tone-great">' + counts.great + ' Great</span>' +
        '<span class="insp-detail-summary-chip tone-fail">'  + counts.fail  + ' Fail</span>' +
      '</div>';
      areasHtml = summaryHtml + '<div class="insp-detail-areas">' +
        sectionsToShow.map(function (sec) {
          const items = grouped[sec];
          return (
            '<div class="insp-detail-section">' +
              '<h4 class="insp-detail-section-title">' + escapeText(sec) + '</h4>' +
              items.map(function (it) {
                const r = (it.result || "");
                const comment = (it.comment || "").trim();
                return (
                  '<div class="insp-detail-item-row" data-result="' + escapeAttr(r) + '">' +
                    '<div>' +
                      '<span class="insp-detail-item-name">' + escapeText(it.item_label || it.item || "—") + '</span>' +
                      (comment ? '<p class="insp-detail-area-note">' + escapeText(comment) + '</p>' : "") +
                    '</div>' +
                    '<span class="insp-detail-item-verdict tone-' + escapeAttr(r) + '">' +
                      escapeText((r || "—").toUpperCase()) +
                    '</span>' +
                  '</div>'
                );
              }).join("") +
            '</div>'
          );
        }).join("") +
      '</div>';
    } else {
      // v1 legacy — area_scores with 1-5 numbers
      const scores = doc.area_scores || {};
      const order = ["offices","bathrooms","entry_foyer","lunchroom","common_areas","trash","floors","dusting","glass","touchpoints","supplies"];
      areasHtml = '<div class="insp-detail-areas">' +
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
    }

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

  /* ============================================================
   * Phase Inspection 3 — Health Dashboard + Customer Registry
   *
   * Loads (and lazily bootstraps) customer_inspection_state docs,
   * computes status per customer client-side, renders the four
   * dashboard tiles + completion %, the full registry filterable by
   * status, and the inspector's personal "my queue" of assignments.
   *
   * Status derivation is client-side and stateless: based only on
   * last_inspection_date and assigned_to_uid. That means "completed"
   * automatically flips back to "unassigned" or "overdue" the moment
   * the customer crosses the 60-day cadence — no scheduled job needed.
   * ============================================================ */

  const INSPECTION_CADENCE_DAYS = 60;
  // Hardcoded root admin list mirrors firestore.rules + functions/index.js.
  // Used as the rotation suggestion pool when the /admins collection is
  // empty or unreadable. Keep in sync with the other two source-of-truth
  // copies.
  const INSPECTION_ROTATION_FALLBACK_EMAILS = [
    "nick@pioneercomclean.com",
    "april@pioneercomclean.com",
    "kirby@pioneercomclean.com",
    "mgies@pioneercomclean.com"
  ];
  let registryStaff = null;
  let registryFilter = "all";
  let registryRowsCache = [];
  let registryAdminRoster = [];   // [{ email, display_name }]

  /* ============================================================
   * Phase Timeclock Add-On — Inspection shift clock
   *
   * Shows a card at the top of /inspections with Start / End buttons
   * and a live elapsed timer. Reuses window.NonServiceClock so the
   * cleaning singleton lock at active_service_sessions/{uid} prevents
   * starting an inspection while a cleaning shift is active (and vice
   * versa). Customer + inspection_id are patched onto the running
   * session as the inspector picks them.
   * ============================================================ */

  let inspClockStaff = null;
  let inspClockTickHandle = null;

  async function bootInspectionClock(staff) {
    if (!staff) return;
    if (!window.NonServiceClock) {
      console.warn("[inspections] NonServiceClock not loaded — clock UI hidden");
      return;
    }
    inspClockStaff = staff;
    const card = $("insp-clock-card");
    const btn  = $("insp-clock-toggle");
    if (!card || !btn) return;
    card.hidden = false;
    if (!btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", onInspClockToggle);
    }
    await refreshInspClock();
  }

  async function refreshInspClock() {
    if (!inspClockStaff || !window.NonServiceClock) return;
    try {
      const active = await window.NonServiceClock.getActive(inspClockStaff);
      paintInspClock(active);
    } catch (err) {
      console.warn("[inspections] clock refresh failed", err);
    }
  }

  function paintInspClock(active) {
    const card = $("insp-clock-card");
    const status = $("insp-clock-status");
    const btn = $("insp-clock-toggle");
    const errEl = $("insp-clock-err");
    if (!card || !status || !btn) return;
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

    if (active && (active.labor_type || "cleaning") === "inspection") {
      // Currently clocked in for an inspection shift — show live timer.
      card.setAttribute("data-state", "active");
      btn.textContent = "End Inspection Shift";
      btn.disabled = false;
      paintInspElapsed(active);
      // Tick every 30s (mirrors service-clock cadence).
      if (inspClockTickHandle) clearInterval(inspClockTickHandle);
      inspClockTickHandle = setInterval(function () {
        paintInspElapsed(active);
      }, 30000);
    } else if (active) {
      // Clocked in for a DIFFERENT labor type — disable Start, explain.
      const ltLabel = (window.NonServiceClock.LABOR_TYPE_LABEL[active.labor_type || "cleaning"]
                       || active.labor_type || "cleaning");
      card.removeAttribute("data-state");
      btn.textContent = "Start Inspection Shift";
      btn.disabled = true;
      status.innerHTML = "Already clocked in for <strong>" + escapeText(ltLabel) +
                         "</strong>. End that shift first.";
      if (inspClockTickHandle) { clearInterval(inspClockTickHandle); inspClockTickHandle = null; }
    } else {
      // Not clocked in.
      card.removeAttribute("data-state");
      btn.textContent = "Start Inspection Shift";
      btn.disabled = false;
      status.textContent = "Not clocked in.";
      if (inspClockTickHandle) { clearInterval(inspClockTickHandle); inspClockTickHandle = null; }
    }
  }

  function paintInspElapsed(active) {
    const status = $("insp-clock-status");
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
    const cust = active && active.customer_id ? " · " + active.customer_id : "";
    status.innerHTML = "On the clock · <strong>" + escapeText(dur) + "</strong>" + escapeText(cust);
  }

  async function onInspClockToggle() {
    const btn = $("insp-clock-toggle");
    const errEl = $("insp-clock-err");
    if (!btn || !window.NonServiceClock || !inspClockStaff) return;
    btn.disabled = true;
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    try {
      const active = await window.NonServiceClock.getActive(inspClockStaff);
      if (active && (active.labor_type || "cleaning") === "inspection") {
        // End the shift.
        await window.NonServiceClock.clockOut(inspClockStaff,
          window.NonServiceClock.LABOR_TYPES.INSPECTION);
      } else {
        // Start the shift — capture any currently-picked customer from
        // the intake form so the session is associated immediately.
        await window.NonServiceClock.clockIn(inspClockStaff,
          window.NonServiceClock.LABOR_TYPES.INSPECTION,
          {
            customer_slug: state.customer_slug || "",
            customer_name: state.customer_name || ""
          });
      }
      await refreshInspClock();
    } catch (err) {
      console.error("[inspections] clock toggle failed", err);
      if (errEl) {
        errEl.textContent = (err && err.message) || "Couldn't change shift state.";
        errEl.hidden = false;
      }
      btn.disabled = false;
    }
  }

  async function bootInspectionRegistry(staff) {
    if (!staff) return;
    if (staff.role !== "admin") return;
    registryStaff = staff;
    wireRegistryFilters();
    await loadAndRenderRegistry();
  }

  function wireRegistryFilters() {
    document.querySelectorAll(".insp-reg-filter").forEach(function (b) {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      b.addEventListener("click", function () {
        document.querySelectorAll(".insp-reg-filter").forEach(function (x) { x.classList.remove("is-active"); });
        b.classList.add("is-active");
        registryFilter = b.dataset.filter || "all";
        renderRegistry();
      });
    });
  }

  async function loadAndRenderRegistry() {
    const db = firebase.firestore();
    try {
      // Pull state docs + customers in parallel. We need both: the state
      // docs hold inspection history; the customers collection is the
      // source of truth for "every customer Pioneer cleans" — so we can
      // bootstrap rows for any customer that doesn't have a state doc
      // yet (first time loading the registry after a fresh customer
      // was added).
      const [stateSnap, custSnap, adminSnap] = await Promise.all([
        db.collection("customer_inspection_state").get(),
        db.collection("customers").get(),
        // Admin roster powers the rotation-suggestion chip on the
        // registry. Soft-fail: if the admins collection is empty or
        // unreadable we fall back to the hardcoded root list below.
        db.collection("admins").get().catch(function () { return { docs: [] }; })
      ]);

      // Build the rotation pool — active admins + hardcoded root list.
      const rosterByEmail = new Map();
      adminSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.active === false) return;
        const email = String(a.email || d.id || "").toLowerCase().trim();
        if (!email) return;
        rosterByEmail.set(email, {
          email: email,
          display_name: a.display_name || a.name || email.split("@")[0]
        });
      });
      INSPECTION_ROTATION_FALLBACK_EMAILS.forEach(function (e) {
        const lc = e.toLowerCase();
        if (!rosterByEmail.has(lc)) {
          rosterByEmail.set(lc, { email: lc, display_name: lc.split("@")[0] });
        }
      });
      registryAdminRoster = Array.from(rosterByEmail.values())
        .sort(function (a, b) { return a.display_name.localeCompare(b.display_name); });

      const stateByCustomer = new Map();
      stateSnap.docs.forEach(function (d) {
        stateByCustomer.set(d.id, Object.assign({ _id: d.id }, d.data() || {}));
      });

      const allCustomers = custSnap.docs
        .map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (c) { return c.active !== false; })
        .filter(function (c) { return c._id && (c.name || c.display_name); });

      // Lazy bootstrap: for any active customer without a state doc,
      // create one in batch. Idempotent — re-running is a no-op once
      // the docs exist.
      const missing = allCustomers.filter(function (c) { return !stateByCustomer.has(c._id); });
      if (missing.length) {
        const batch = db.batch();
        const nowSentinel = firebase.firestore.FieldValue.serverTimestamp();
        missing.forEach(function (c) {
          const ref = db.collection("customer_inspection_state").doc(c._id);
          batch.set(ref, {
            customer_slug:           c._id,
            customer_name:           c.name || c.display_name || c._id,
            inspection_cadence_days: INSPECTION_CADENCE_DAYS,
            last_inspection_id:      null,
            last_inspection_date:    null,
            last_inspector_uid:      null,
            last_inspector_name:     null,
            last_inspector_email:    null,
            assigned_to_uid:         null,
            assigned_to_email:       null,
            assigned_to_name:        null,
            assigned_at:             null,
            assigned_by_email:       null,
            due_date:                null,
            created_at:              nowSentinel,
            updated_at:              nowSentinel
          }, { merge: true });
          stateByCustomer.set(c._id, {
            _id:           c._id,
            customer_slug: c._id,
            customer_name: c.name || c.display_name || c._id,
            inspection_cadence_days: INSPECTION_CADENCE_DAYS,
            last_inspection_date: null,
            assigned_to_uid: null
          });
        });
        try { await batch.commit(); }
        catch (err) { console.warn("[inspections] registry bootstrap write failed", err); }
      }

      // Hydrate name from customers when missing on the state doc.
      const nameBySlug = {};
      allCustomers.forEach(function (c) { nameBySlug[c._id] = c.name || c.display_name || c._id; });
      registryRowsCache = Array.from(stateByCustomer.values()).map(function (s) {
        return Object.assign({}, s, {
          customer_name: s.customer_name || nameBySlug[s.customer_slug] || s._id
        });
      });

      renderRegistry();
      renderHealthTotals();
      renderMyQueue();
    } catch (err) {
      console.error("[inspections] registry load failed", err);
      const list = $("insp-registry-list");
      if (list) list.innerHTML = '<p class="insp-recent-status">Couldn\'t load registry: ' + regEscape(err.message || "unknown") + '</p>';
    }
  }

  function computeRegistryStatus(row, todayMs) {
    const lastDate = row.last_inspection_date;
    const assigned = !!row.assigned_to_uid;
    if (!lastDate) {
      return assigned ? "assigned" : "unassigned";
    }
    const ms = Date.parse(lastDate + "T00:00:00Z");
    if (!Number.isFinite(ms)) return assigned ? "assigned" : "unassigned";
    const daysSince = Math.floor((todayMs - ms) / 86400000);
    // v1.0 audit fix — honor per-customer cadence overrides; mirrors
    // the CEO rollup truth table so both surfaces agree on status.
    const cadence = Number(row.inspection_cadence_days) || INSPECTION_CADENCE_DAYS;
    if (daysSince < cadence) return "completed";
    if (assigned) return "assigned";
    return "overdue";
  }

  function renderHealthTotals() {
    const card = $("insp-health-card");
    if (!card) return;
    card.hidden = false;
    const todayMs = Date.now();
    let total = registryRowsCache.length, completed = 0, assigned = 0, overdue = 0, unassigned = 0;
    registryRowsCache.forEach(function (r) {
      const st = computeRegistryStatus(r, todayMs);
      if (st === "completed")       completed++;
      else if (st === "assigned")   assigned++;
      else if (st === "overdue")    overdue++;
      else if (st === "unassigned") unassigned++;
    });
    $("insp-h-total").textContent     = String(total);
    $("insp-h-assigned").textContent  = String(assigned);
    $("insp-h-completed").textContent = String(completed);
    $("insp-h-overdue").textContent   = String(overdue);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    $("insp-h-pct").textContent = pct + "%";
  }

  function renderMyQueue() {
    if (!registryStaff) return;
    const card = $("insp-queue-card");
    const list = $("insp-queue-list");
    if (!card || !list) return;
    const myUid = registryStaff.uid;
    const myEmail = String((registryStaff.email || "")).toLowerCase();
    const mine = registryRowsCache.filter(function (r) {
      return (r.assigned_to_uid && r.assigned_to_uid === myUid)
          || (r.assigned_to_email && r.assigned_to_email === myEmail);
    });
    if (!mine.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    list.innerHTML = mine.map(function (r) {
      return renderRegistryRowHtml(r, /* showQueueActions */ true);
    }).join("");
    wireRegistryRowButtons();
  }

  function renderRegistry() {
    const card = $("insp-registry-card");
    const list = $("insp-registry-list");
    if (!card || !list) return;
    card.hidden = false;
    const todayMs = Date.now();
    const filtered = registryRowsCache.filter(function (r) {
      if (registryFilter === "all") return true;
      return computeRegistryStatus(r, todayMs) === registryFilter;
    });
    // Sort: overdue first, then assigned (by due date), then completed.
    filtered.sort(function (a, b) {
      const sa = computeRegistryStatus(a, todayMs);
      const sb = computeRegistryStatus(b, todayMs);
      const order = { overdue: 0, unassigned: 1, assigned: 2, completed: 3 };
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      // Within same status, oldest inspection first (most urgent).
      const da = a.last_inspection_date || "0000-00-00";
      const db_ = b.last_inspection_date || "0000-00-00";
      return da < db_ ? -1 : da > db_ ? 1 : (a.customer_name || "").localeCompare(b.customer_name || "");
    });
    if (!filtered.length) {
      list.innerHTML = '<p class="insp-recent-status">No customers match this filter.</p>';
      return;
    }
    list.innerHTML = filtered.map(function (r) {
      return renderRegistryRowHtml(r, /* showQueueActions */ false);
    }).join("");
    wireRegistryRowButtons();
  }

  // Rotation suggestion: any admin in the roster whose email is NOT the
  // last inspector. Stable pick (alphabetical) — same row suggests the
  // same person every load, so the inspector + manager develop muscle
  // memory. "Do not hard-enforce" — this is advisory, surfaced as a
  // small chip next to the last-inspector hint.
  function suggestNextInspector(lastEmail) {
    const last = String(lastEmail || "").toLowerCase();
    if (!registryAdminRoster.length) return null;
    const candidates = registryAdminRoster.filter(function (a) {
      return a.email !== last;
    });
    if (!candidates.length) return null;
    return candidates[0];
  }

  function renderRegistryRowHtml(r, showQueueActions) {
    const todayMs = Date.now();
    const status = computeRegistryStatus(r, todayMs);
    const lastDate = r.last_inspection_date || "—";
    const dueDate  = r.due_date || (r.last_inspection_date
      ? computeDueDateClient(r.last_inspection_date, r.inspection_cadence_days || INSPECTION_CADENCE_DAYS)
      : "—");
    const daysSince = r.last_inspection_date
      ? Math.floor((todayMs - Date.parse(r.last_inspection_date + "T00:00:00Z")) / 86400000) + " days"
      : "—";
    const assignedTo = r.assigned_to_name || r.assigned_to_email || "—";
    const lastInspector = r.last_inspector_name || (r.last_inspector_email ? r.last_inspector_email.split("@")[0] : "—");
    const meEmail = String((registryStaff && registryStaff.email) || "").toLowerCase();
    const isMine = r.assigned_to_email === meEmail;

    // Rotation: surface a suggested next inspector when (a) someone has
    // inspected before, (b) nobody currently owns the next cycle, and
    // (c) the suggestion isn't the same person who last inspected.
    const suggested = (r.last_inspector_email && !r.assigned_to_uid)
      ? suggestNextInspector(r.last_inspector_email)
      : null;
    const suggestedHtml = suggested
      ? ' &nbsp;→&nbsp;<em style="color:#94a3b8;">try: ' + regEscape(suggested.display_name) + '</em>'
      : '';

    let actionsHtml = '';
    if (showQueueActions) {
      // My Queue: Open Inspection + Mark Complete (manual closure
      // without filling out the form, for out-of-band inspections) +
      // Release (drop the assignment without completing).
      actionsHtml =
        '<button type="button" class="insp-reg-btn insp-reg-btn-primary" data-row-action="open" data-slug="' + regAttr(r.customer_slug) + '">Open Inspection</button>' +
        '<button type="button" class="insp-reg-btn" data-row-action="mark-complete" data-slug="' + regAttr(r.customer_slug) + '">Mark Complete</button>' +
        '<button type="button" class="insp-reg-btn" data-row-action="unassign" data-slug="' + regAttr(r.customer_slug) + '">Release</button>';
    } else if (status === "assigned") {
      actionsHtml =
        (isMine
          ? '<button type="button" class="insp-reg-btn insp-reg-btn-primary" data-row-action="open" data-slug="' + regAttr(r.customer_slug) + '">Open Inspection</button>'
          : '<button type="button" class="insp-reg-btn" data-row-action="claim" data-slug="' + regAttr(r.customer_slug) + '">Take Over</button>'
        );
    } else {
      actionsHtml =
        '<button type="button" class="insp-reg-btn insp-reg-btn-primary" data-row-action="claim" data-slug="' + regAttr(r.customer_slug) + '">Assign to Me</button>';
    }
    return (
      '<div class="insp-reg-row" data-status="' + regAttr(status) + '" data-slug="' + regAttr(r.customer_slug) + '">' +
        '<div class="insp-reg-name">' + regEscape(r.customer_name || r.customer_slug) + '</div>' +
        '<div class="insp-reg-meta"><span class="insp-reg-meta-key">Last</span>' + regEscape(lastDate) + '</div>' +
        '<div class="insp-reg-meta"><span class="insp-reg-meta-key">Days</span>' + regEscape(daysSince) + '</div>' +
        '<div class="insp-reg-meta"><span class="insp-reg-meta-key">Assigned</span>' + regEscape(assignedTo) +
          (lastInspector && lastInspector !== "—" ? ' &nbsp;·&nbsp; <em style="color:#94a3b8;">last: ' + regEscape(lastInspector) + '</em>' : '') +
          suggestedHtml +
        '</div>' +
        '<div class="insp-reg-meta"><span class="insp-reg-meta-key">Due</span>' + regEscape(dueDate) +
          ' &nbsp;<span class="insp-reg-status-chip s-' + regAttr(status) + '">' + regEscape(status) + '</span>' +
        '</div>' +
        '<div class="insp-reg-actions">' + actionsHtml + '</div>' +
      '</div>'
    );
  }

  function wireRegistryRowButtons() {
    document.querySelectorAll("[data-row-action]").forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", async function () {
        const action = btn.getAttribute("data-row-action");
        const slug = btn.getAttribute("data-slug");
        if (!slug) return;
        // v1.0 audit fix — disable the clicked button while the write
        // is in flight so a double-tap can't fire the action twice.
        // The whole row is about to be re-rendered by loadAndRenderRegistry
        // anyway, so re-enabling is moot on success; on failure we
        // restore the button so the operator can retry.
        if (action === "open") return openInspectionFor(slug);
        btn.disabled = true;
        try {
          if (action === "claim")         await claimRow(slug);
          else if (action === "unassign") await unassignRow(slug);
          else if (action === "mark-complete") await markCompleteRow(slug);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // "Mark Complete" stamps the customer as inspected today WITHOUT
  // creating an inspections/{id} doc — for inspections that happened
  // out of band (paper walkthrough, phone walkthrough, anything not
  // logged through the intake form). The registry treats the cycle as
  // closed; the inspections collection itself is untouched, so quality
  // scores and 5-star wins aren't synthesized. The trade is: visibility
  // of the cadence vs. clean inspection score data — Mark Complete
  // prioritizes the cadence side. Confirmation prompts so it isn't an
  // accidental click.
  async function markCompleteRow(slug) {
    if (!registryStaff) return;
    const row = registryRowsCache.find(function (r) { return r.customer_slug === slug; });
    const label = (row && row.customer_name) || slug;
    const ok = window.confirm(
      "Mark " + label + " as inspected today without filling out the form?\n\n" +
      "This closes the current cycle in the registry but doesn't create an " +
      "inspection record — use Open Inspection to capture details + score."
    );
    if (!ok) return;
    const today = new Date().toISOString().slice(0, 10);
    const cadence = (row && row.inspection_cadence_days) || INSPECTION_CADENCE_DAYS;
    const due = computeDueDateClient(today, cadence);
    const me = registryStaff;
    const myEmail = String(me.email || "").toLowerCase();
    const myName = (me.tech && me.tech.display_name) || myEmail.split("@")[0];
    try {
      await firebase.firestore().collection("customer_inspection_state").doc(slug).set({
        customer_slug:           slug,
        // v1.0 audit fix — persist customer_name so the state doc isn't
        // blank for fresh customers that hit Mark Complete before any
        // inspection has run. Falls back to the slug if the cache row
        // is somehow missing the name.
        customer_name:           (row && row.customer_name) || slug,
        inspection_cadence_days: cadence,
        last_inspection_id:      null,
        last_inspection_date:    today,
        last_inspector_uid:      me.uid,
        last_inspector_name:     myName,
        last_inspector_email:    myEmail,
        assigned_to_uid:         null,
        assigned_to_email:       null,
        assigned_to_name:        null,
        assigned_at:             null,
        assigned_by_email:       null,
        due_date:                due,
        updated_at:              firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await loadAndRenderRegistry();
    } catch (err) {
      console.error("[inspections] mark complete failed", err);
      alert("Couldn't mark complete: " + (err.message || "unknown"));
    }
  }

  async function claimRow(slug) {
    if (!registryStaff) return;
    const me = registryStaff;
    const row = registryRowsCache.find(function (r) { return r.customer_slug === slug; });
    try {
      await firebase.firestore().collection("customer_inspection_state").doc(slug).set({
        customer_slug:     slug,
        // v1.0 audit fix — defensive customer_name write so the state
        // doc is never anonymous after a claim, even for fresh
        // customers added since the last bootstrap.
        customer_name:     (row && row.customer_name) || slug,
        assigned_to_uid:   me.uid,
        assigned_to_email: String(me.email || "").toLowerCase(),
        assigned_to_name:  (me.tech && me.tech.display_name) || (me.email || "").split("@")[0],
        assigned_at:       firebase.firestore.FieldValue.serverTimestamp(),
        assigned_by_email: String(me.email || "").toLowerCase(),
        updated_at:        firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await loadAndRenderRegistry();
    } catch (err) {
      console.error("[inspections] claim failed", err);
      alert("Couldn't assign: " + (err.message || "unknown"));
    }
  }

  async function unassignRow(slug) {
    // v1.0 audit fix — guard against firing after sign-out (session
    // expiry between page boot and button click).
    if (!registryStaff) return;
    try {
      await firebase.firestore().collection("customer_inspection_state").doc(slug).set({
        assigned_to_uid:   null,
        assigned_to_email: null,
        assigned_to_name:  null,
        assigned_at:       null,
        assigned_by_email: null,
        updated_at:        firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await loadAndRenderRegistry();
    } catch (err) {
      console.error("[inspections] unassign failed", err);
      alert("Couldn't release: " + (err.message || "unknown"));
    }
  }

  function openInspectionFor(slug) {
    // Navigate to intake with the customer preselected. Same-page
    // navigation via setting search + reload keeps it simple and lets
    // the existing ?customer= deep-link path do the heavy lifting.
    const url = location.pathname + "?customer=" + encodeURIComponent(slug);
    location.href = url;
  }

  function preselectCustomerOnIntake(slug) {
    // Called from the onAuthorized boot after the intake form is wired.
    // The customer dropdown is populated async by loadCustomers, so
    // poll briefly until the slug is selectable.
    let tries = 0;
    const tick = function () {
      const sel = $("insp-customer");
      if (!sel) return;
      if (sel.querySelector('option[value="' + slug + '"]')) {
        sel.value = slug;
        const opt = sel.options[sel.selectedIndex];
        state.customer_slug = slug;
        state.customer_name = (opt && opt.dataset && opt.dataset.name) || "";
        return;
      }
      if (tries++ < 40) setTimeout(tick, 100);
    };
    tick();
  }

  function computeDueDateClient(ymd, cadenceDays) {
    const ms = Date.parse(ymd + "T00:00:00Z");
    if (!Number.isFinite(ms)) return "—";
    return new Date(ms + cadenceDays * 86400000).toISOString().slice(0, 10);
  }

  function regEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function regAttr(s) { return regEscape(s); }

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
          // Wire customer dropdown change → cache name on state +
          // patch the active inspection shift session (if any) so the
          // session carries the customer for payroll visibility.
          const custSel = $("insp-customer");
          if (custSel && !custSel.dataset.wired) {
            custSel.dataset.wired = "1";
            custSel.addEventListener("change", function () {
              const opt = custSel.options[custSel.selectedIndex];
              state.customer_slug = custSel.value || "";
              state.customer_name = (opt && opt.dataset && opt.dataset.name) || "";
              // Best-effort patch — silently no-op if not clocked in.
              if (window.NonServiceClock && state.customer_slug) {
                window.NonServiceClock.patchActiveSession(staff, {
                  customer_id:   state.customer_slug,
                  customer_name: state.customer_name
                }).catch(function () {});
              }
            });
          }

          // Hub wiring + initial load.
          wireHubControls();
          wireInspModals();
          loadHubInspections();
          loadSrAssignedDropdown();

          // Phase Timeclock Add-On — Inspection shift clock.
          bootInspectionClock(staff).catch(function (err) {
            console.warn("[inspections] clock boot failed", err);
          });

          // Phase Inspection 3 — Health Dashboard + Customer Registry +
          // My Queue. Async, non-blocking; soft-fails if reads error.
          bootInspectionRegistry(staff).catch(function (err) {
            console.warn("[inspections] registry boot failed", err);
          });

          // Deep-link handling. ?mode=new → straight into intake.
          //                     ?customer=<slug> → intake with that
          //                     customer pre-selected (used by the
          //                     registry "Open Inspection" button).
          try {
            const params = new URLSearchParams(location.search || "");
            const mode = (params.get("mode") || "").trim();
            const preselectSlug = (params.get("customer") || "").trim();
            if (mode === "new" || preselectSlug) {
              showIntakeView();
              if (preselectSlug) preselectCustomerOnIntake(preselectSlug);
            }
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
