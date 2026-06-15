/* Pioneer DCR Hub — front-end glue (vanilla JS, no build).
 *
 * Responsibilities:
 *   1. Initialize Firebase web SDK (app + storage).
 *   2. Render dynamic form pieces (dropdowns, checklist sections w/ progress bars,
 *      rating cards, time-budget reason groups) from window.DCR_FORM_CONFIG.
 *   3. Wire interactive UI: yes/no segmented buttons, three-state checklist pills
 *      (with per-section progress + completion celebration), experience rating
 *      cards, photo gallery with remove, signature pad, conditional reveals.
 *   4. Auto-save form state to localStorage as a draft and restore on accidental
 *      reload. Clear on successful submit.
 *   5. On submit:
 *        a. Generate a submission id.
 *        b. Upload each photo to dcr-photos/{customerSlug}/{submissionId}/photo-{n}.{ext}
 *           with real-time progress (Firebase state_changed listener).
 *        c. Upload signature PNG to dcr-signatures/{customerSlug}/{submissionId}/signature.png.
 *        d. Build the v1 payload via window.buildDcrV1Payload() and attach the
 *           rich form answers under payload.form_data.
 *        e. POST to window.SUBMIT_DCR_V1_URL.
 *        f. Show animated success card with the submission id.
 */
(function () {
  "use strict";

  const MAX_BYTES_PER_PHOTO = 10 * 1024 * 1024;
  const ALLOWED_PREFIX      = "image/";
  const AFFIRM_TEXT         =
    "I take pride in my work, did my best, and stand by the quality of my cleaning.";

  const DRAFT_KEY    = "pioneer.dcr.draft.v1";
  const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  // ----- Optional DCR submit-success delight: tiny flush sound effect -----
  // Decorative only. Plays at low volume after a confirmed submit. Never
  // fires on validation errors, never fires on draft restore, never plays
  // twice for the same submission, and silently no-ops when the browser
  // blocks autoplay or the audio file is missing. Set to `false` to kill
  // the feature entirely without removing the wiring.
  const ENABLE_DCR_SUCCESS_SOUND   = true;
  const DCR_SUCCESS_SOUND_SRC      = "/assets/sounds/dcr-success.mp3";
  const DCR_SUCCESS_SOUND_VOLUME   = 0.30;
  // Tracks the most-recent submissionId we played the sound for. Same
  // id arriving twice (e.g. success-card rerender) → no replay.
  let _dcrSuccessSoundLastPlayedId = null;

  // Inline content for each checklist pill — done/issue are icon-only SVGs
  // (currentColor picks up the active state's color), N/A is short text.
  // `M10 16v.01` + `stroke-linecap="round"` renders as a single dot for the
  // bottom of the exclamation mark, no separate <circle> needed.
  const PILL_STATES = ["done", "issue", "na"];
  const PILL_INNER = {
    done:  '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><polyline points="4 11 8 15 16 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    issue: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 4v7.5M10 15.5v.01" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    na:    '<span class="pill-text">N/A</span>'
  };
  const PILL_TITLES = { done: "Done", issue: "Issue", na: "Not applicable" };

  // Chevron used in the collapsible section header. Rotates via CSS.
  const CHEVRON_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- module state ---------- */

  let MAX_PHOTOS         = 12;
  let pendingFiles       = [];     // File[]
  let segState           = {};     // { needs_supplies: "yes"|"no", ... }
  let ratingState        = "";     // "" | "excellent" | "good" | "okay" | "difficult"
  let checklistState     = {};     // { [section_id]: { [item_id]: "done"|"issue"|"na" } }
  let checklistNotes     = {};     // { [section_id]: { [item_id]: "free-text note for an issue" } }
  let sectionCollapsed   = {};     // { [section_id]: true when section is collapsed }
  let timeBudgetReasons  = new Set();
  // V6 pilot — freeform note that pairs with the "other" reason on the
  // time-budget section. Optional; survives draft save/restore; flows
  // into the submitted DCR as both snake_case (form_data.time_budget_other_note)
  // and camelCase (overBudgetNote, overBudgetReason) mirrors so any
  // downstream reader picks it up.
  let overBudgetOtherNote = "";
  // Phase 1e.2 — populated by loadLinkedPioneerSession() when the URL
  // carries a pioneer_service_session_id AND that session shows
  // work_minutes > budget_minutes + 15. Null otherwise. Drives both
  // the Time card's visibility and the time_over_budget_context block
  // on the submitted DCR payload.
  let timeOverBudgetSnapshot = null;
  let signaturePad       = null;
  let firebaseCtx        = null;
  let isSubmitting       = false;
  let isRestoringDraft   = false;
  let draftSaveTimer     = null;

  /* ---------- DOM helpers ---------- */

  const $  = (id)               => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {};

  function setStatus(kind, msg) {
    if (!els.status) return;
    els.status.className = kind || "";
    els.status.textContent = msg || "";
  }

  /* ---------- config + Firebase init ---------- */

  function ensureConfig() {
    if (
      !window.FIREBASE_CONFIG ||
      !window.FIREBASE_CONFIG.apiKey ||
      !window.FIREBASE_CONFIG.projectId ||
      !window.FIREBASE_CONFIG.storageBucket
    ) {
      throw new Error("firebase-config.js is missing required Firebase config values.");
    }
    if (!window.SUBMIT_DCR_V1_URL || !window.SUBMIT_DCR_V1_URL.startsWith("https://")) {
      throw new Error("SUBMIT_DCR_V1_URL is not set correctly in firebase-config.js.");
    }
    if (!window.DCR_FORM_CONFIG)   throw new Error("dcr-form-config.js failed to load.");
    if (!window.buildDcrV1Payload) throw new Error("submit-dcr-v1.js failed to load.");
  }

  function initFirebase() {
    if (!window.firebase) throw new Error("Firebase SDK script tags failed to load.");
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    return { storage: firebase.storage() };
  }

  /* ---------- render: dropdowns + date default ---------- */

  // Static dropdowns — problem categories + occupancy options live in
  // dcr-form-config.js (they're a fixed enum). The customer + tech selects
  // are populated separately from a live Firestore fetch — see
  // loadCustomersAndTechs() below.
  function renderDropdowns(cfg) {
    cfg.problem_categories.forEach(function (c) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.label;
      els.problemCategory.appendChild(o);
    });

    cfg.occupancy_options.forEach(function (o2) {
      const o = document.createElement("option");
      o.value = o2.id;
      o.textContent = o2.label;
      els.occupancyLevel.appendChild(o);
    });

    setCleanDateToday();
  }

  /* ---------- live customer + tech roster (Firestore) ----------
   * Schema-tolerant accessors mirror the ones in admin.js — docs may use
   * either the canonical field names (`name`, `slug`, `email`) OR the
   * denormalized submission-payload names (`customer_name`, `customer_slug`,
   * `customer_email`). Both are accepted; the canonical names win when both
   * are present.
   *
   * Filtering rules per spec:
   *   • active === true            (default true if missing)
   *   • dcr_enabled === true       (default true if missing)
   *
   * Sort:
   *   • customers by location_name OR customer_name (display label)
   *   • techs by display_name
   */

  let rosterReady = false;

  function getCustomerName(c)        { return c.customer_name  || c.name         || c.display_name || ""; }
  function getCustomerSlug(c)        { return c.customer_slug  || c.slug         || c.id          || ""; }
  function getCustomerEmail(c)       { return c.customer_email || c.email        || ""; }
  function getCustomerLocation(c)    { return c.location_name  || c.location     || ""; }
  function getCustomerActive(c)      { return c.active     !== false; }   // default true when missing
  function getCustomerDcrEnabled(c)  { return c.dcr_enabled !== false; }
  // DCR EMAIL opt-out. Default true when missing → existing customer docs
  // keep getting emails unless explicitly opted out via dcr_email_enabled: false.
  // This is DISTINCT from dcr_enabled, which controls form visibility.
  function getCustomerDcrEmailEnabled(c) { return c.dcr_email_enabled !== false; }
  function getCustomerReviewLinks(c) { return (c.review_links && typeof c.review_links === "object") ? c.review_links : {}; }
  function getCustomerDisplayLabel(c){
    // Canonical display name — routes through the shared helper so
    // `displayNameMode + customDisplayName` are honored consistently
    // with every other surface (Team Hub schedule, Today's Work cards,
    // Customer Info, Yesterday's Work, DCR email, customer report).
    // The "(unnamed customer)" last-resort string is kept for the
    // dropdown's still-selectable affordance.
    if (window.PioneerCustomerDisplay) {
      const label = window.PioneerCustomerDisplay.getCustomerDisplayName(c);
      if (label) return label;
    }
    return getCustomerName(c) || getCustomerLocation(c) || getCustomerSlug(c) || "(unnamed customer)";
  }

  function getTechName(t)        { return t.display_name || t.tech_display_name || t.name || ""; }
  function getTechSlug(t)        { return t.tech_slug    || t.slug              || t.id   || ""; }
  function getTechExpLevel(t)    { return t.experience_level || "standard"; }
  function getTechActive(t)      { return t.active     !== false; }
  function getTechDcrEnabled(t)  { return t.dcr_enabled !== false; }

  // In-dropdown status helpers — feedback lives inside the <select> itself
  // so the UI doesn't need a separate banner area.
  function setRosterDropdown(sel, message) {
    sel.innerHTML = '<option value="" disabled selected>' + message + '</option>';
  }
  function setCustomerLoading()       { setRosterDropdown(els.customer, "Loading customers…"); }
  function setTechLoading()           { setRosterDropdown(els.tech,     "Loading techs…");     }
  function setCustomerError(msg)      { setRosterDropdown(els.customer, "— " + msg + " —");   }
  function setTechError(msg)          { setRosterDropdown(els.tech,     "— " + msg + " —");   }

  function populateCustomerSelect(list) {
    els.customer.innerHTML = '<option value="" disabled selected>— Select customer —</option>';
    list.forEach(function (c) {
      const o = document.createElement("option");
      o.value                  = getCustomerSlug(c);
      o.textContent            = getCustomerDisplayLabel(c);
      o.dataset.name           = getCustomerName(c);
      o.dataset.email          = getCustomerEmail(c);
      // location_name is denormalized onto submissions; fall back to the
      // display label so downstream Zapier always has a usable value.
      o.dataset.locationName   = getCustomerLocation(c) || getCustomerName(c);
      // DCR email opt-out flag. Stored on the dataset so the submit handler
      // can ride it through to the payload (string "true"/"false" because
      // dataset values are always strings — converted back to bool there).
      o.dataset.dcrEmailEnabled = getCustomerDcrEmailEnabled(c) ? "true" : "false";
      const rl = getCustomerReviewLinks(c);
      o.dataset.reviewFiveStar = rl.five_star_url || "";
      o.dataset.reviewIssue    = rl.issue_url     || "";
      els.customer.appendChild(o);
    });
  }

  function populateTechSelect(list) {
    els.tech.innerHTML = '<option value="" disabled selected>— Select cleaning tech —</option>';
    list.forEach(function (t) {
      const o = document.createElement("option");
      o.value                    = getTechSlug(t);
      o.textContent              = getTechName(t);
      o.dataset.displayName      = getTechName(t);
      o.dataset.experienceLevel  = getTechExpLevel(t);
      els.tech.appendChild(o);
    });
  }

  async function loadCustomersAndTechs(staff) {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setCustomerError("Firestore not available");
      setTechError("Firestore not available");
      rosterReady = false;
      return;
    }
    setCustomerLoading();
    setTechLoading();
    const fs = firebase.firestore();
    try {
      const [custSnap, techSnap] = await Promise.all([
        fs.collection("customers").get(),
        fs.collection("cleaning_techs").get()
      ]);

      let customers = custSnap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (c) { return getCustomerActive(c) && getCustomerDcrEnabled(c); });
      const techs = techSnap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (t) { return getTechActive(t) && getTechDcrEnabled(t); });

      // Per-tech assignment scope. Admins see every active customer (they
      // sometimes submit on behalf of a tech from the office). Cleaning
      // techs only see customers whose slug is in their personal
      // assigned_customer_slugs list — the server-side gate in
      // submitDcrV1 enforces the same restriction, so this UI restriction
      // is purely about not showing customers the tech can't pick.
      let restrictedEmptyForTech = false;
      if (staff && staff.role === "cleaning_tech") {
        const assigned = (staff.tech && Array.isArray(staff.tech.assigned_customer_slugs))
          ? staff.tech.assigned_customer_slugs.map(function (s) { return String(s || "").toLowerCase().trim(); })
          : [];
        const allow = new Set(assigned.filter(Boolean));
        customers = customers.filter(function (c) {
          return allow.has(String(getCustomerSlug(c) || "").toLowerCase().trim());
        });
        if (customers.length === 0) restrictedEmptyForTech = true;
      }

      customers.sort(function (a, b) {
        return getCustomerDisplayLabel(a).localeCompare(getCustomerDisplayLabel(b));
      });
      techs.sort(function (a, b) {
        return getTechName(a).localeCompare(getTechName(b));
      });

      if (customers.length === 0) {
        setCustomerError(restrictedEmptyForTech
          ? "No assigned locations yet — email info@pioneercomclean.com to get locations assigned"
          : "No active customers yet — email info@pioneercomclean.com");
      } else {
        populateCustomerSelect(customers);
      }
      if (techs.length === 0) {
        setTechError("No active techs yet — email info@pioneercomclean.com");
      } else {
        populateTechSelect(techs);
      }
      rosterReady = customers.length > 0 && techs.length > 0;
    } catch (err) {
      console.error("loadCustomersAndTechs failed", err);
      setCustomerError("Couldn't load — refresh the page");
      setTechError("Couldn't load — refresh the page");
      rosterReady = false;
    }
  }

  /* ====================================================================
     Deputy shift handoff — query params from Today's Assignments
     ====================================================================
     When the tech opens this form from a Team-Hub assignment card, the
     URL carries the full Deputy snapshot:
       ?deputy_shift_id=…&sync_date=…&customer_slug=…&customer_name=…
        &location_name=…&scheduled_start=…&scheduled_end=…&deputy_shift_url=…
     We parse it once at boot, prefill the customer dropdown after the
     roster loads, show a banner so the tech knows the form is bound to
     a specific shift, and attach the snapshot to the submitted payload.
     The DCR proceeds even when the customer can't be mapped — the
     banner just flips to an "unmapped" / "please confirm" state. */

  function parseDeputyShiftFromUrl() {
    try {
      const params = new URLSearchParams((typeof location !== "undefined" && location.search) || "");
      const shiftId = (params.get("deputy_shift_id") || "").trim();
      if (!shiftId) return null;
      return {
        deputy_shift_id:     shiftId,
        // PioneerOps workflow session id (== deputy_shift_id today,
        // but threaded explicitly so a future schema change can decouple
        // them without touching the form). When present, submitDcrV1
        // updates the matching pioneer_work_sessions doc to mark the
        // DCR complete and flip the state to needs_finish.
        pioneer_session_id:  (params.get("pioneer_session_id") || "").trim(),
        sync_date:           (params.get("sync_date")        || "").trim(),
        customer_slug:       (params.get("customer_slug")    || "").trim(),
        customer_name:       (params.get("customer_name")    || "").trim(),
        location_name:       (params.get("location_name")    || "").trim(),
        scheduled_start:     (params.get("scheduled_start")  || "").trim(),
        scheduled_end:       (params.get("scheduled_end")    || "").trim(),
        deputy_shift_url:    (params.get("deputy_shift_url") || "").trim()
      };
    } catch (e) { return null; }
  }

  // Module-level cache so the submit handler can read the same snapshot
  // the prefill banner painted. Null when the form was opened without
  // Deputy params (manual DCR — the existing flow).
  const deputyShiftParams = parseDeputyShiftFromUrl();

  // Phase 1b.4 — Pioneer Time Clock entry point. Separate namespace
  // from Deputy params so the two flows never collide in submitDcrV1's
  // back-write logic. Tech arrives at /index.html from service-clock.js
  // with these query params; we forward them in the submit payload so
  // the Cloud Function can back-stamp the linked
  // pioneer_service_sessions + service_assignments docs.
  function parsePioneerAssignmentFromUrl() {
    try {
      const params = new URLSearchParams((typeof location !== "undefined" && location.search) || "");
      const assignmentId = (params.get("pioneer_assignment_id") || "").trim();
      if (!assignmentId) return null;
      return {
        pioneer_assignment_id:      assignmentId,
        pioneer_service_session_id: (params.get("pioneer_service_session_id") || "").trim(),
        customer_slug:              (params.get("customer_slug") || "").trim(),
        customer_name:              (params.get("customer_name") || "").trim(),
        sync_date:                  (params.get("sync_date")     || "").trim()
      };
    } catch (e) { return null; }
  }
  const pioneerAssignmentParams = parsePioneerAssignmentFromUrl();

  /* ---------- Phase 1e.2: linked Pioneer session over-budget check ----------
   *
   * When the URL carries a pioneer_service_session_id (set by service-clock.js
   * when the tech taps "Complete DCR" from Time Clock), read that session and
   * decide whether to reveal the optional scope-change Time card.
   *
   * Reveal rule: work_minutes > budget_minutes + 15  (strict greater-than)
   * Everything else (no id, no session, no budget, under-budget, error) leaves
   * the card hidden — the question is purely opt-in collaborative context.
   *
   * Reads pioneer_service_sessions/{id} once. The session's read rule is
   * `isPioneerAdmin() || own staff_uid` — the tech who submitted the clock-in
   * is also the one filling the DCR, so this is allowed. Any failure is
   * swallowed and the card just stays hidden (zero impact on submission).
   */
  function revealTimeBudgetCard() {
    const card = document.getElementById("time-budget-card");
    if (card) card.hidden = false;
  }

  async function loadLinkedPioneerSession() {
    try {
      if (!pioneerAssignmentParams ||
          !pioneerAssignmentParams.pioneer_service_session_id) return;
      if (!window.firebase || typeof firebase.firestore !== "function") return;
      const sid  = pioneerAssignmentParams.pioneer_service_session_id;
      const snap = await firebase.firestore()
        .collection("pioneer_service_sessions").doc(sid).get();
      if (!snap.exists) return;
      const s      = snap.data() || {};
      const work   = (typeof s.work_minutes   === "number") ? s.work_minutes   : null;
      const budget = (typeof s.budget_minutes === "number") ? s.budget_minutes : null;
      if (work == null || budget == null || budget <= 0) return;
      const overBy = work - budget;
      if (overBy <= 15) return;
      timeOverBudgetSnapshot = {
        pioneer_service_session_id: sid,
        work_minutes:    work,
        budget_minutes:  budget,
        over_by_minutes: overBy
      };
      revealTimeBudgetCard();
    } catch (e) {
      // Permission, network, or any other failure → stay hidden.
      // Never blocks submission; the question is optional.
      try { console.warn("[dcr] linked pioneer session check failed", e && (e.message || e.code)); } catch (_) {}
    }
  }

  function formatScheduledRange(startIso, endIso) {
    function fmt(iso) {
      if (!iso) return "";
      try {
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "numeric", minute: "2-digit", hour12: true
        }).format(new Date(iso));
      } catch (e) { return ""; }
    }
    const s = fmt(startIso);
    const e = fmt(endIso);
    if (s && e) return s + " – " + e;
    return s || e || "";
  }

  // Local helper — avoids depending on a shared util. Mirrors the same
  // shape used in admin.js / team-hub.js.
  function escapeHtmlDeputy(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Phase A Deputy launcher — fire-and-forget click log for the DCR
  // success page's "Open Deputy App" button. Soft-fails on every error
  // so a failed write never blocks the anchor navigation. Twin of the
  // logDeputyOpenClick helper in today-work.js; rules in firestore.rules
  // require staff.uid == request.auth.uid.
  function logDeputyOpenClick(source, extras) {
    try {
      if (!window.firebase || typeof firebase.firestore !== "function") return;
      const staff = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
        ? window.STAFF_AUTH.getCachedStaff() : null) || {};
      const authU = (firebase.auth && firebase.auth().currentUser) || null;
      const uid   = staff.uid || (authU && authU.uid) || null;
      if (!uid) return;
      const payload = Object.assign({
        action:     "open_deputy",
        source:     String(source || "unknown"),
        staff: {
          uid:         uid,
          email:       String(staff.email || (authU && authU.email) || ""),
          displayName: String(staff.displayName || (authU && authU.displayName) || "")
        },
        page_url:   (typeof location !== "undefined" && location.pathname) || "",
        user_agent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      }, extras || {});
      firebase.firestore().collection("employee_action_events").add(payload)
        .catch(function (err) {
          try { console.warn("[app] deputy click log failed (non-fatal)", err && err.code); } catch (_e) {}
        });
    } catch (e) {
      try { console.warn("[app] deputy click log threw (non-fatal)", e); } catch (_e) {}
    }
  }

  function applyDeputyShiftFromUrl(staffArg) {
    const banner = document.getElementById("deputy-shift-banner");
    const metaEl = document.getElementById("deputy-shift-banner-meta");
    const actEl  = document.getElementById("deputy-shift-banner-actions");
    if (!banner || !metaEl || !actEl) return;
    if (!deputyShiftParams) { banner.hidden = true; return; }
    // Cached staff fallback — earlier boot paths sometimes call this
    // without an explicit staff arg, but the assigned-shift handoff
    // needs the signed-in user's tech identity. Keep working either way.
    const staffForCard = staffArg || (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
      ? window.STAFF_AUTH.getCachedStaff() : null);

    // Match priority: explicit slug, then exact customer_name (case-
    // insensitive), then exact location_name, then substring of the
    // option's display label. Options were populated by
    // populateCustomerSelect() with data-name + data-locationName +
    // value=slug.
    const opts     = els.customer ? Array.from(els.customer.options) : [];
    const wantSlug = deputyShiftParams.customer_slug.toLowerCase().trim();
    const wantName = deputyShiftParams.customer_name.toLowerCase().trim();
    const wantLoc  = deputyShiftParams.location_name.toLowerCase().trim();

    let matched = null;
    if (wantSlug) {
      matched = opts.find(function (o) {
        return (o.value || "").toLowerCase().trim() === wantSlug;
      }) || null;
    }
    if (!matched && wantName) {
      matched = opts.find(function (o) {
        return (o.dataset.name || "").toLowerCase().trim() === wantName;
      }) || null;
    }
    if (!matched && wantLoc) {
      matched = opts.find(function (o) {
        return (o.dataset.locationName || "").toLowerCase().trim() === wantLoc;
      }) || null;
    }
    if (!matched && wantName) {
      matched = opts.find(function (o) {
        return (o.textContent || "").toLowerCase().indexOf(wantName) >= 0;
      }) || null;
    }

    // ---- Build meta block (always populated, one line per piece) ----
    //
    // Order: customer/location first (the thing the tech most needs to
    // confirm), then time, then sync date, then the shift id. Each
    // line lives in its own <div> so the banner reads naturally and
    // wraps cleanly on narrow viewports.
    const lines = [];

    const locationLabel =
      (matched && (matched.dataset.name || matched.textContent)) ||
      deputyShiftParams.customer_name ||
      deputyShiftParams.location_name ||
      "(unknown)";
    lines.push(
      '<div class="deputy-shift-banner-line">' +
        '<span class="deputy-shift-banner-key">Location:</span> ' +
        escapeHtmlDeputy(locationLabel) +
      '</div>'
    );

    const time = formatScheduledRange(
      deputyShiftParams.scheduled_start,
      deputyShiftParams.scheduled_end
    );
    if (time) {
      lines.push(
        '<div class="deputy-shift-banner-line">' +
          '<span class="deputy-shift-banner-key">Scheduled:</span> ' +
          escapeHtmlDeputy(time) +
        '</div>'
      );
    }

    if (deputyShiftParams.sync_date) {
      lines.push(
        '<div class="deputy-shift-banner-line">' +
          '<span class="deputy-shift-banner-key">Sync date:</span> ' +
          escapeHtmlDeputy(deputyShiftParams.sync_date) +
        '</div>'
      );
    }

    // Show the shift id and (when distinct) the work session id. Today
    // they're the same value — the pioneer_work_sessions doc id is the
    // deputy_shift_id — but the session id is plumbed separately so a
    // future schema change can decouple them without touching the form.
    lines.push(
      '<div class="deputy-shift-banner-line">' +
        '<span class="deputy-shift-banner-key">Deputy shift:</span> #' +
        escapeHtmlDeputy(deputyShiftParams.deputy_shift_id) +
      '</div>'
    );
    if (deputyShiftParams.pioneer_session_id &&
        deputyShiftParams.pioneer_session_id !== deputyShiftParams.deputy_shift_id) {
      lines.push(
        '<div class="deputy-shift-banner-line">' +
          '<span class="deputy-shift-banner-key">Work session:</span> ' +
          escapeHtmlDeputy(deputyShiftParams.pioneer_session_id) +
        '</div>'
      );
    }

    // Linkage promise — what this DCR will be tied to once submitted.
    // Phrased so the tech knows the workflow is automatic; no extra
    // clicks needed beyond the existing Submit button.
    if (deputyShiftParams.pioneer_session_id) {
      lines.push(
        '<div class="deputy-shift-banner-link-note">' +
          'This DCR will be linked to the selected work session.' +
        '</div>'
      );
    } else {
      lines.push(
        '<div class="deputy-shift-banner-link-note">' +
          'This DCR will be linked to Deputy shift #' +
          escapeHtmlDeputy(deputyShiftParams.deputy_shift_id) + '.' +
        '</div>'
      );
    }

    if (!matched) {
      lines.push(
        '<div class="deputy-shift-banner-confirm">' +
          '⚠ Please confirm customer — couldn\'t auto-match this shift to an active customer.' +
        '</div>'
      );
    }
    metaEl.innerHTML = lines.join("");

    // ---- Build actions block (Deputy roster link if URL present) ----
    if (deputyShiftParams.deputy_shift_url) {
      actEl.innerHTML =
        '<a class="deputy-shift-banner-link" target="_blank" rel="noopener noreferrer" href="' +
          escapeHtmlDeputy(deputyShiftParams.deputy_shift_url) + '">' +
          'Open in Deputy ↗' +
        '</a>';
    } else {
      actEl.innerHTML = "";
    }

    // ---- Apply prefill + visual state ----
    if (matched) {
      // Override anything the draft set; the Deputy shift is the
      // authoritative customer for this DCR. Dispatch `change` so
      // downstream listeners (review_links snapshot, etc.) refresh.
      els.customer.value = matched.value;
      try { els.customer.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
      banner.classList.remove("is-unmapped");
    } else {
      banner.classList.add("is-unmapped");
    }

    // When this DCR was opened from Today's Work but no confident
    // customer was pre-selected, swap the customer label + show a
    // helper so the tech understands the field is the source of
    // truth for this report. When pre-selected, restore the default
    // label and hide the helper (the banner above already conveys
    // the link).
    const labelEl  = document.getElementById("customer-label");
    const helperEl = document.getElementById("customer-helper");
    if (labelEl && helperEl) {
      if (!matched) {
        labelEl.textContent  = "Choose the customer you cleaned";
        helperEl.textContent = "This links your report to the right location.";
        helperEl.hidden      = false;
      } else {
        labelEl.textContent  = "Customer";
        helperEl.textContent = "";
        helperEl.hidden      = true;
      }
    }

    banner.hidden = false;

    // ----------------------------------------------------------------
    // Assigned-shift summary card.
    //
    // When the handoff is confident — customer matched + pioneer work
    // session present + signed-in user owns the shift — collapse the
    // manual Visit Details section and surface a four-line summary
    // ("complete tonight's assigned shift", not "fill out a generic
    // form"). Falls back to the original setup form for:
    //   • unmatched customer (tech still needs to pick)
    //   • no pioneer_session_id (DCR opened outside the Start Work flow)
    //   • admin viewing another tech's shift (no auto-populate)
    //   • the staff record is missing or denied
    // Admins get an inline "Change shift / Advanced" toggle to fall back
    // to the manual form for office overrides; cleaning techs never see it.
    paintAssignedShiftSummary({
      matchedOption: matched,
      staff:         staffForCard,
      banner:        banner
    });
  }

  function paintAssignedShiftSummary(ctx) {
    const card = document.getElementById("assigned-shift-summary");
    const visit = document.getElementById("visit-details-section");
    if (!card || !visit) return;
    const params = deputyShiftParams;
    if (!params) return;

    // Confident handoff guard: every input must be present for the card
    // to take over. Otherwise leave the manual form in place — that's
    // the safe fallback the user explicitly asked for.
    const hasSession = !!String(params.pioneer_session_id || "").trim();
    const techMatched = ctx.staff && ctx.staff.tech && ctx.staff.tech.slug;
    const techIsCleaner = ctx.staff && ctx.staff.role === "cleaning_tech";
    // Admin path: only auto-populate when the admin is also the tech of
    // record on the shift (rare but valid — admins occasionally pick up
    // shifts). For the much more common "admin reviewing another tech's
    // shift" case, fall back to the manual form so the admin can edit.
    const adminOwnsShift = ctx.staff && ctx.staff.role === "admin" &&
      techMatched &&
      String(params.deputy_shift_id || "").length > 0 &&
      // The assigned-shift card shows the SIGNED-IN tech's name. For an
      // admin who isn't the assignee, the card would be misleading. We
      // detect this by checking whether the shift's employee_email param
      // (when present) matches the admin's email — but the URL doesn't
      // carry that today, so for the pilot we conservatively only auto-
      // populate for cleaning_tech role. Admins see the manual form +
      // banner (existing behavior).
      false;

    if (!hasSession || !ctx.matchedOption || !techMatched || (!techIsCleaner && !adminOwnsShift)) {
      // Fallback to manual form. Make sure the card is hidden in case a
      // previous render left it visible (e.g., draft restore edge case).
      card.hidden = true;
      visit.hidden = false;
      return;
    }

    // ---- All preconditions met — paint the card + hide the manual form.
    const custEl = document.getElementById("assigned-shift-customer-name");
    const techEl = document.getElementById("assigned-shift-tech-name");
    const dateEl = document.getElementById("assigned-shift-date");
    const timeEl = document.getElementById("assigned-shift-time");

    if (custEl) {
      // textContent is the helper-derived display label (honors
      // displayNameMode + customDisplayName). dataset.name carries the
      // raw `customer_name` field — used downstream for the DCR doc's
      // identity-style `customer_name` write, but we don't want to
      // show that raw value when an admin has authored a different
      // public-facing display string.
      const custName =
        ctx.matchedOption.textContent ||
        (ctx.matchedOption.dataset && ctx.matchedOption.dataset.name) ||
        params.customer_name ||
        "(customer)";
      custEl.textContent = custName;
    }
    if (techEl) {
      const techDisplayName =
        (ctx.staff.tech && ctx.staff.tech.display_name) ||
        (els.tech && els.tech.selectedOptions[0] && els.tech.selectedOptions[0].textContent.trim()) ||
        ctx.staff.email || "";
      techEl.textContent = techDisplayName;
    }
    if (dateEl) {
      dateEl.textContent = formatAssignedShiftDate(params.sync_date);
    }
    if (timeEl) {
      const range = formatScheduledRange(params.scheduled_start, params.scheduled_end);
      timeEl.textContent = range || "Time not set";
    }

    // Align clean_date with the shift's sync_date so the submission
    // carries the right operational day even if the tech opens the DCR
    // after midnight Pacific. Manual flow keeps "today" as its default.
    if (params.sync_date && /^\d{4}-\d{2}-\d{2}$/.test(params.sync_date) && els.cleanDate) {
      els.cleanDate.value = params.sync_date;
      try { els.cleanDate.dispatchEvent(new Event("change", { bubbles: true })); } catch (_e) {}
    }

    // Admins ONLY get the advanced toggle. Cleaning techs see the four
    // lines and head straight into the checklist — no fallback exposed.
    const toggle = document.getElementById("assigned-shift-advanced-toggle");
    if (toggle) {
      const showToggle = ctx.staff && ctx.staff.role === "admin";
      toggle.hidden = !showToggle;
      if (showToggle && !toggle.dataset.wired) {
        toggle.dataset.wired = "1";
        toggle.addEventListener("click", function () {
          const open = visit.hidden;
          visit.hidden = !open;
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
          toggle.textContent = open ? "Hide advanced" : "Change shift / Advanced";
        });
      }
    }

    // The Deputy banner duplicates info shown by the summary card. Hide
    // it in the assigned-shift mode so the screen stays focused.
    if (ctx.banner) ctx.banner.hidden = true;

    card.hidden = false;
    visit.hidden = true;
    try {
      console.info("[DCR] assigned-shift summary applied", {
        shift_id:       params.deputy_shift_id,
        session_id:     params.pioneer_session_id,
        customer_slug:  ctx.matchedOption.value,
        tech_slug:      ctx.staff.tech && ctx.staff.tech.slug,
        sync_date:      params.sync_date
      });
    } catch (_e) {}
  }

  // Format YYYY-MM-DD (Pacific calendar day, as emitted by Deputy sync)
  // into "Monday, May 26" — the human-readable variant the summary card
  // wants. Falls back to the raw string on parse failure so a bad input
  // never blanks the card.
  function formatAssignedShiftDate(yyyymmdd) {
    if (!yyyymmdd || !/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return yyyymmdd || "";
    try {
      // Build noon-Pacific so DST + timezone never flip the calendar day.
      const d = new Date(yyyymmdd + "T12:00:00-07:00");
      if (isNaN(d.getTime())) return yyyymmdd;
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long", month: "long", day: "numeric"
      }).format(d);
    } catch (_e) { return yyyymmdd; }
  }

  // Re-apply the saved draft's customer + tech selection after the live
  // Firestore load finishes. `restoreDraftIfFresh()` runs earlier (during
  // boot) for everything else, but its select-value assignment is a no-op
  // until the options exist.
  function reapplyDraftRoster() {
    let raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    let draft;
    try { draft = JSON.parse(raw); } catch (e) { return; }
    if (!draft || typeof draft !== "object") return;
    if (typeof draft.customer === "string" && draft.customer) {
      els.customer.value = draft.customer;
    }
    if (typeof draft.tech === "string" && draft.tech) {
      els.tech.value = draft.tech;
    }
  }

  function setCleanDateToday() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    els.cleanDate.value = `${yyyy}-${mm}-${dd}`;
  }

  /* ---------- render: checklist cards (with progress) ---------- */

  function renderChecklists(cfg) {
    const root = $("checklist-cards");
    if (!root) return;
    root.innerHTML = "";

    ensureChecklistStateInitialized(cfg);

    cfg.checklist_sections.forEach(function (section) {

      const card = document.createElement("section");
      card.className = "card checklist-card";
      card.dataset.sectionId = section.id;

      // V20260614 — Select All / Clear All control. Wraps the existing
      // collapsible header in a positioning zone so a sibling button
      // can sit at the top-right corner without producing an invalid
      // nested-<button> tree. Click on the Select-All button stops
      // propagation so it never toggles the collapse.
      const headZone = document.createElement("div");
      headZone.className = "checklist-card-head-zone";

      // Collapsible header: the whole top row is one button that toggles
      // the section's `is-collapsed` state. iOS Settings density — title +
      // progress count + chevron, no chrome between them.
      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "checklist-header";
      headerBtn.setAttribute("aria-expanded", "true");
      headerBtn.dataset.sectionId = section.id;
      headerBtn.addEventListener("click", function () { toggleSectionCollapse(section.id); });

      const titleRow = document.createElement("div");
      titleRow.className = "checklist-card-header";

      const title = document.createElement("h2");
      title.className = "card-title";
      title.textContent = section.label;
      titleRow.appendChild(title);

      const right = document.createElement("span");
      right.className = "header-right";

      const count = document.createElement("span");
      count.className = "progress-count";
      count.dataset.sectionId = section.id;
      count.textContent = `0/${section.items.length}`;
      right.appendChild(count);

      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.innerHTML = CHEVRON_SVG;
      right.appendChild(chevron);

      titleRow.appendChild(right);
      headerBtn.appendChild(titleRow);

      // Progress bar sits under the title row but inside the header button so
      // both hide together when collapsed.
      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("div");
      fill.className = "progress-bar-fill";
      fill.dataset.sectionId = section.id;
      bar.appendChild(fill);
      headerBtn.appendChild(bar);

      // V20260614 — Select All / Clear All sibling button. Positioned
      // absolutely inside .checklist-card-head-zone (see CSS) so it
      // sits at the top-right of the header without nesting inside
      // headerBtn. Label flips between "Select All" and "Clear All"
      // based purely on current state (every item has any state set ?
      // "Clear All" : "Select All"). updateSelectAllLabel() recomputes
      // on every state change so manual unchecks bring "Select All"
      // back automatically.
      const selectAllBtn = document.createElement("button");
      selectAllBtn.type = "button";
      selectAllBtn.className = "select-all-btn";
      selectAllBtn.dataset.sectionId = section.id;
      selectAllBtn.textContent = "Select All";
      selectAllBtn.setAttribute("aria-label", "Select All for " + section.label);
      selectAllBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleSelectAllForSection(section.id);
      });

      headZone.appendChild(headerBtn);
      headZone.appendChild(selectAllBtn);
      card.appendChild(headZone);

      // Compact instruction line under the header.
      const sub = document.createElement("p");
      sub.className = "card-sub checklist-sub";
      sub.textContent = "Mark each:  ✓ done   !  issue   N/A";
      card.appendChild(sub);

      // Items list — rows with bottom dividers, label left, 3 pills right.
      const list = document.createElement("div");
      list.className = "checklist";

      section.items.forEach(function (item) {
        const row = document.createElement("div");
        row.className = "checklist-item";
        row.dataset.sectionId = section.id;
        row.dataset.itemId    = item.id;

        const label = document.createElement("span");
        label.className = "item-label";
        label.textContent = item.label;
        row.appendChild(label);

        const pills = document.createElement("div");
        pills.className = "pills";
        pills.setAttribute("role", "radiogroup");
        pills.setAttribute("aria-label", "Status for " + item.label);

        PILL_STATES.forEach(function (state) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "pill";
          btn.dataset.state = state;
          btn.setAttribute("aria-label", PILL_TITLES[state]);
          btn.setAttribute("title", PILL_TITLES[state]);
          // PILL_INNER entries are static strings under our control.
          btn.innerHTML = PILL_INNER[state];
          btn.addEventListener("click", function () {
            onChecklistPill(section.id, item.id, state, row, btn);
          });
          pills.appendChild(btn);
        });
        row.appendChild(pills);

        // Issue detail (inline, only shown when status === "issue"). Lives in
        // the same row using a full-width grid-column span — keeps the issue
        // note visually tied to the item it describes.
        const issueDetail = document.createElement("div");
        issueDetail.className = "issue-detail";

        const note = document.createElement("textarea");
        note.className = "issue-note";
        note.placeholder = "What's the issue?";
        note.rows = 2;
        note.setAttribute("aria-label", "Issue note for " + item.label);
        note.addEventListener("input", function () {
          // Defensive: section sub-map may have been cleared by onNewDcr.
          // Without this, typing the first character into an issue note on
          // the second DCR throws and the note never persists into
          // checklistNotes — which is why "Issue noted ✓" never appeared
          // and validation kept blocking submit.
          if (!checklistNotes[section.id]) checklistNotes[section.id] = {};
          checklistNotes[section.id][item.id] = note.value;
          // 1. Mark the row as "resolved" once the note has text. This flips
          //    the note border + background to teal and reveals the "Issue
          //    noted ✓" confirmation line.
          refreshIssueResolved(row, section.id, item.id);
          // 2. Re-count the section so the X/Y badge climbs as soon as the
          //    note becomes non-empty (an issue-with-note is now "complete").
          updateSectionProgress(section.id);
          scheduleSaveDraft();
        });
        issueDetail.appendChild(note);

        // Phase 3: replace the passive "tip — add a photo above" line
        // with an active affordance: a small button that scrolls to the
        // Photos card and opens the file picker so techs don't have to
        // hunt for it while marking issues.
        const photoCta = document.createElement("button");
        photoCta.type = "button";
        photoCta.className = "issue-photo-cta";
        photoCta.innerHTML =
          '<span class="issue-photo-cta-icon" aria-hidden="true">📷</span>' +
          '<span class="issue-photo-cta-text">Add a photo for this issue</span>';
        photoCta.addEventListener("click", function (ev) {
          // V6 — open the file picker SYNCHRONOUSLY inside the user
          // click handler. The earlier `setTimeout(..., 240)` wrapper
          // broke iOS Safari's user-activation requirement, so the
          // file picker silently refused to open on iPhone. We also
          // stop propagation so this click can't bubble to any
          // ancestor that might react to it.
          ev.stopPropagation();
          const photosLabel = document.querySelector('label.file-drop[for="photos"]');
          const photosInput = document.getElementById("photos");
          if (photosInput && typeof photosInput.click === "function") {
            photosInput.click();
          }
          if (photosLabel) {
            photosLabel.scrollIntoView({ behavior: "smooth", block: "center" });
            photosLabel.classList.add("is-flashing");
            setTimeout(function () { photosLabel.classList.remove("is-flashing"); }, 1200);
          }
        });
        issueDetail.appendChild(photoCta);

        // Subtle secondary hint so the user knows the photo is optional
        // and lives in the shared Photos block above.
        const hint = document.createElement("p");
        hint.className = "issue-hint";
        hint.textContent = "Optional. Photos help the office triage this issue faster.";
        issueDetail.appendChild(hint);

        // Confirmation line — hidden by CSS until the row is `.issue-resolved`,
        // then it replaces the hint to acknowledge the cleaner's input.
        const confirmed = document.createElement("p");
        confirmed.className = "issue-confirmed";
        confirmed.innerHTML =
          '<svg class="issue-confirmed-icon" viewBox="0 0 16 16" aria-hidden="true">' +
          '<polyline points="3 9 7 13 14 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          'Issue noted';
        issueDetail.appendChild(confirmed);

        row.appendChild(issueDetail);
        list.appendChild(row);
      });

      card.appendChild(list);
      root.appendChild(card);

      updateSectionProgress(section.id);
    });
  }

  /* ---------- Select All / Clear All ----------
     V20260614 — Per-section batch control.
     - "Select All" sets every item to "done".
     - "Clear All" clears state AND notes for every item in the section.
     - Button label is derived purely from current state:
         every item has any state ? "Clear All" : "Select All".
       So a manual uncheck on a single item flips the label back to
       "Select All" without any additional flag tracking. */
  function toggleSelectAllForSection(sectionId) {
    const cfg = window.DCR_FORM_CONFIG;
    if (!cfg || !cfg.checklist_sections) return;
    const section = cfg.checklist_sections.find(function (s) { return s.id === sectionId; });
    if (!section) return;

    if (!checklistState[sectionId]) checklistState[sectionId] = {};
    if (!checklistNotes[sectionId]) checklistNotes[sectionId] = {};

    const allHaveState = section.items.every(function (item) {
      return !!checklistState[sectionId][item.id];
    });

    if (allHaveState) {
      // Clear All — wipe state + notes for the whole section.
      section.items.forEach(function (item) {
        delete checklistState[sectionId][item.id];
        delete checklistNotes[sectionId][item.id];
      });
    } else {
      // Select All — set every item to "done" (overwriting existing).
      // Notes for items previously at "issue" are PRESERVED in
      // checklistNotes so the tech can re-flag the item without
      // re-typing the note.
      section.items.forEach(function (item) {
        checklistState[sectionId][item.id] = "done";
      });
    }

    // Re-paint each row's pills + status classes from the new state.
    const card = document.querySelector('.checklist-card[data-section-id="' +
      cssEscape(sectionId) + '"]');
    if (card) {
      section.items.forEach(function (item) {
        const row = card.querySelector('.checklist-item[data-item-id="' +
          cssEscape(item.id) + '"]');
        if (!row) return;
        const newState = checklistState[sectionId][item.id] || null;
        // Reset pill active classes.
        row.querySelectorAll(".pill").forEach(function (p) {
          p.classList.remove("is-active--done", "is-active--issue", "is-active--na");
          if (newState && p.dataset.state === newState) {
            p.classList.add("is-active--" + newState);
          }
        });
        // Reset row status classes.
        row.classList.remove("status-done", "status-issue", "status-na", "has-issue", "issue-resolved");
        if (newState) {
          row.classList.add("is-answered", "status-" + newState);
          if (newState === "issue") row.classList.add("has-issue");
        } else {
          row.classList.remove("is-answered");
          // Also clear any inline note textarea value when fully cleared.
          const note = row.querySelector(".issue-note");
          if (note) note.value = "";
        }
        refreshIssueResolved(row, sectionId, item.id);
      });
    }

    updateSectionProgress(sectionId);
    scheduleSaveDraft();
    refreshDcrCompletion();
  }

  // Minimal CSS.escape polyfill — needed because some section/item IDs
  // contain hyphens or special characters that CSS attribute selectors
  // can't parse directly.
  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  // Recompute and apply the Select-All button label for a section based
  // on whether every item currently has any state set.
  function updateSelectAllLabel(sectionId) {
    const cfg = window.DCR_FORM_CONFIG;
    if (!cfg || !cfg.checklist_sections) return;
    const section = cfg.checklist_sections.find(function (s) { return s.id === sectionId; });
    if (!section) return;
    const btn = document.querySelector('.select-all-btn[data-section-id="' +
      cssEscape(sectionId) + '"]');
    if (!btn) return;
    const allHaveState = section.items.every(function (item) {
      return !!(checklistState[sectionId] && checklistState[sectionId][item.id]);
    });
    const newLabel = allHaveState ? "Clear All" : "Select All";
    if (btn.textContent !== newLabel) btn.textContent = newLabel;
    btn.classList.toggle("is-clear-all", allHaveState);
    btn.setAttribute("aria-label", newLabel + " for " + section.label);
  }

  function onChecklistPill(sectionId, itemId, state, row, btn) {
    // Defensive: section sub-map may have been cleared by a reset path
    // (e.g. onNewDcr). Without this guard, the assignment below throws
    // TypeError on the second DCR's first pill tap.
    if (!checklistState[sectionId]) checklistState[sectionId] = {};
    if (!checklistNotes[sectionId]) checklistNotes[sectionId] = {};
    checklistState[sectionId][itemId] = state;

    // Update the pill button states (one active, two inactive).
    $$(".pill", row).forEach(function (p) {
      p.classList.remove("is-active--done", "is-active--issue", "is-active--na");
      if (p.dataset.state === state) p.classList.add(`is-active--${state}`);
    });

    // Row-level status classes drive subtle label-color shifts (e.g. N/A
    // items fade slightly so they read as lower-priority while scanning).
    row.classList.add("is-answered");
    row.classList.remove("status-done", "status-issue", "status-na");
    row.classList.add("status-" + state);
    // Reveal/hide the inline issue note area for THIS item only.
    row.classList.toggle("has-issue", state === "issue");
    // Resolved-state recompute: flipping from Issue → Done removes the
    // teal "noted" treatment; flipping back restores it if the note kept
    // its text in memory.
    refreshIssueResolved(row, sectionId, itemId);

    if (btn) {
      btn.classList.remove("just-tapped");
      void btn.offsetWidth;            // re-trigger the pop animation
      btn.classList.add("just-tapped");
    }

    // If user just opened an issue, focus the note so they can type immediately.
    if (state === "issue") {
      const note = row.querySelector(".issue-note");
      if (note) setTimeout(function () { note.focus(); }, 80);
    }

    updateSectionProgress(sectionId);
    scheduleSaveDraft();
    refreshDcrCompletion();   // Phase 3: instant sticky context + submit-bar update
    // Auto-collapse if all items are now answered AND the user didn't just
    // pick "issue" (in which case they probably want to type a note).
    maybeAutoCollapse(sectionId, state);
  }

  /**
   * Idempotently seed `checklistState[sectionId] = {}` and
   * `checklistNotes[sectionId] = {}` for every configured section.
   *
   * Why this exists: the pill click handler and the issue-note `input`
   * handler both write directly into the nested map (e.g.
   * `checklistState["bathrooms"]["toilets-cleaned"] = "done"`). If the
   * section sub-object is missing, that assignment throws
   * `TypeError: Cannot set properties of undefined`, which silently
   * breaks the button. Always call this after any reset that reassigns
   * `checklistState` / `checklistNotes` to fresh `{}` objects (e.g. in
   * onNewDcr) so the handlers stay safe.
   */
  function ensureChecklistStateInitialized(cfg) {
    const sections = (cfg && cfg.checklist_sections) ||
                     (window.DCR_FORM_CONFIG && window.DCR_FORM_CONFIG.checklist_sections) ||
                     [];
    sections.forEach(function (section) {
      if (!checklistState[section.id]) checklistState[section.id] = {};
      if (!checklistNotes[section.id]) checklistNotes[section.id] = {};
    });
  }

  /**
   * Single source of truth for "is this checklist item complete?"
   *   - done           → complete
   *   - na             → complete
   *   - issue + note   → complete (the note IS the resolution)
   *   - issue + empty  → NOT complete (still needs a note)
   *   - no status set  → NOT complete
   *
   * Used by progress count, auto-collapse, AND validation so the badge,
   * the auto-collapse trigger, and the submit gate all agree.
   */
  function isItemComplete(sectionId, itemId) {
    const status = checklistState[sectionId] && checklistState[sectionId][itemId];
    if (status === "done" || status === "na") return true;
    if (status === "issue") {
      const note = (checklistNotes[sectionId] && checklistNotes[sectionId][itemId]) || "";
      return note.trim().length > 0;
    }
    return false;
  }

  // Sets/removes the `.issue-resolved` class on a row based on current state.
  // Called from both the pill-tap handler and the note-input handler so the
  // row's visual treatment always reflects the latest status + note pair.
  function refreshIssueResolved(row, sectionId, itemId) {
    if (!row) return;
    const status = checklistState[sectionId] && checklistState[sectionId][itemId];
    const note = (checklistNotes[sectionId] && checklistNotes[sectionId][itemId]) || "";
    row.classList.toggle("issue-resolved", status === "issue" && note.trim().length > 0);
  }

  function updateSectionProgress(sectionId) {
    const section = (window.DCR_FORM_CONFIG.checklist_sections || [])
      .find(function (s) { return s.id === sectionId; });
    if (!section) return;

    // V20260614 — Keep the per-section Select All / Clear All label
    // in sync with current state. A manual uncheck on a single item
    // flips the label back to "Select All" automatically.
    updateSelectAllLabel(sectionId);

    const total = section.items.length;
    let completed = 0;
    let issueCount = 0;
    section.items.forEach(function (item) {
      if (isItemComplete(sectionId, item.id)) completed += 1;
      const v = checklistState[sectionId] && checklistState[sectionId][item.id];
      if (v === "issue") issueCount += 1;
    });

    const count = document.querySelector(`.progress-count[data-section-id="${sectionId}"]`);
    const fill  = document.querySelector(`.progress-bar-fill[data-section-id="${sectionId}"]`);
    const card  = document.querySelector(`.checklist-card[data-section-id="${sectionId}"]`);
    const isComplete = completed === total && total > 0;

    const pct = total > 0 ? (completed / total) * 100 : 0;
    if (fill)  fill.style.width = pct + "%";
    if (count) {
      // V20260614 — Append "Complete" word so the badge reads as a
      // completion count (e.g. "5/6 Complete") per product spec. Stays
      // mobile-friendly: pill width grows a few px but doesn't wrap.
      // `completed` counts an issue-with-note as 1 — typing the note bumps the
      // badge so the user sees their action register immediately.
      count.textContent = `${completed}/${total} Complete`;
      count.classList.toggle("is-complete", isComplete);
      // `has-issues` colors the badge coral — section-level issue scanning
      // becomes a glance: green pill = clear, coral pill = noted issues.
      count.classList.toggle("has-issues", isComplete && issueCount > 0);
    }
    if (card) {
      card.classList.toggle("is-complete", isComplete);
      card.classList.toggle("has-issues",  issueCount > 0);
    }
  }

  /* ---------- collapsible checklist sections ---------- */

  // Called after a pill tap. Auto-collapses the section iff:
  //   • every item is COMPLETE (done / na / issue-with-note), AND
  //   • the last tap wasn't "issue" (user is probably about to type a note),
  //   • the section isn't already collapsed.
  // Re-checks state after the delay so a fast un-tap aborts the collapse.
  function maybeAutoCollapse(sectionId, lastTapState) {
    if (lastTapState === "issue") return;
    const section = (window.DCR_FORM_CONFIG.checklist_sections || [])
      .find(function (s) { return s.id === sectionId; });
    if (!section) return;

    const allComplete = section.items.every(function (item) {
      return isItemComplete(sectionId, item.id);
    });
    if (!allComplete || sectionCollapsed[sectionId]) return;

    setTimeout(function () {
      const stillComplete = section.items.every(function (item) {
        return isItemComplete(sectionId, item.id);
      });
      if (stillComplete) {
        debugDcrScroll("completedSection", { sectionId: sectionId, scrollY: window.scrollY });
        collapseSection(sectionId);
      }
    }, 450);
  }

  function collapseSection(sectionId) {
    // Resolve the scroll target BEFORE the layout shrinks. Once the
    // section is marked is-collapsed, its items go display:none and the
    // page height drops by hundreds of pixels — if we measure positions
    // AFTER that, "next section" can land at the wrong y. Capturing the
    // element here means we just call scrollIntoView on it post-collapse
    // and the browser handles the rest.
    const nextSectionId = findNextIncompleteSectionId(sectionId);
    const beforeY = (typeof window !== "undefined") ? window.scrollY : 0;
    sectionCollapsed[sectionId] = true;
    applyCollapseState(sectionId);
    scheduleSaveDraft();

    // After the .is-collapsed class flips, the browser needs one frame
    // to recompute layout. Schedule the scroll in requestAnimationFrame
    // so we never read stale coordinates. Falls back to setTimeout for
    // older runtimes.
    const doScroll = function () {
      scrollToSectionHeader(nextSectionId, { source: "auto-collapse", completedSectionId: sectionId, beforeY: beforeY });
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () { window.requestAnimationFrame(doScroll); });
    } else {
      setTimeout(doScroll, 32);
    }
  }

  // Iterate config sections in order; return the FIRST section AFTER
  // `currentSectionId` that still has unfinished items. Returns null if
  // every later section is already complete (caller falls back to the
  // submit/affirmation area). Manually-collapsed sections still count
  // as incomplete if their underlying items aren't all done — we want
  // to land on the user's next work, not their next visible card.
  function findNextIncompleteSectionId(currentSectionId) {
    const sections = (window.DCR_FORM_CONFIG && window.DCR_FORM_CONFIG.checklist_sections) || [];
    let started = false;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (!started) {
        if (s.id === currentSectionId) started = true;
        continue;
      }
      const incomplete = !s.items.every(function (item) {
        return isItemComplete(s.id, item.id);
      });
      if (incomplete) return s.id;
    }
    return null;
  }

  // Sum of sticky-at-top elements (brand header + DCR sticky context).
  // Used as the scroll offset so the section header doesn't tuck behind
  // the sticky strip. Computed at scroll-time so it adapts when the
  // sticky context bar is hidden (e.g. on /admin pages or before the
  // form hydrates).
  function stickyOffsetTop() {
    let bottom = 0;
    const candidates = document.querySelectorAll(".brand-header, .dcr-sticky-context");
    candidates.forEach(function (el) {
      if (!el || el.hidden) return;
      const rect = el.getBoundingClientRect();
      // Element is currently stuck at the top when its top is at/near 0.
      // Anything stuck below ~12px isn't pinned (it's scrolled off).
      if (rect.top <= 4 && rect.bottom > bottom) bottom = rect.bottom;
    });
    return bottom;
  }

  // Centralized scroll helper. Uses native scrollIntoView({block:"start"})
  // with a dynamically-set scroll-margin-top so the browser handles all
  // positioning math from fresh post-collapse measurements. The margin =
  // current sticky-strip bottom + 24px of comfortable breathing room so the
  // next section header lands clearly below the sticky bar, not glued under
  // it and not scrolled past it.
  //
  // Phase 1e.2 — replaced the prior manual window.scrollTo(beforeY + rect.top
  // - offset - 8) math, which overshot the target after a collapse shrank the
  // document above the viewport (stale beforeY vs fresh rect.top led to a
  // landing well past the next section).
  function scrollToSectionHeader(sectionId, ctx) {
    ctx = ctx || {};
    let target = null;
    if (sectionId) {
      target = document.querySelector('.checklist-card[data-section-id="' + sectionId + '"]');
    }
    if (!target) {
      // Phase 1e.2 fix — when the LAST checklist section finishes, there's
      // no next incomplete checklist to land on, but there ARE more cards
      // below (Supplies, How was the clean?, Photos, Occupancy, Notes,
      // Sign & submit). Walk forward from the #checklist-cards container
      // and land on the FIRST visible .card so the tech sees the next
      // question's header — not the affirmation checkbox at the bottom.
      // Honors `hidden` (the Phase 1e.2 #time-budget-card stays hidden
      // unless the over-budget reveal fires).
      const checklistRoot = document.getElementById("checklist-cards");
      if (checklistRoot) {
        let sibling = checklistRoot.nextElementSibling;
        while (sibling) {
          if (sibling.classList &&
              sibling.classList.contains("card") &&
              !sibling.hidden) {
            target = sibling;
            break;
          }
          sibling = sibling.nextElementSibling;
        }
      }
      // Last-resort fallback if no card was found (e.g. checklist-cards is
      // the final element on the page): land on the submit area so the
      // tech still sees what's next instead of staying where they were.
      if (!target) {
        target = document.getElementById("affirm") ||
                 document.getElementById("submit-btn") ||
                 document.querySelector(".submit-bar") ||
                 null;
      }
    }
    debugDcrScroll("nextIncompleteSection", {
      sectionId: sectionId,
      target: target ? (target.id || target.dataset.sectionId || "(fallback)") : "(none)"
    });
    if (!target) return;

    const offset = stickyOffsetTop();
    const margin = offset + 24;   // 24px comfortable padding below the sticky strip
    // scroll-margin-top is honored by scrollIntoView in all modern engines
    // (Chrome, Safari, Firefox). Setting it per-call keeps the value in sync
    // with whichever sticky strips are currently pinned.
    try { target.style.scrollMarginTop = margin + "px"; } catch (_) {}
    debugDcrScroll("scrollTarget", {
      sectionId: sectionId, offset: offset, scrollMarginTop: margin,
      completedSectionId: ctx.completedSectionId
    });
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // Log the resolved scroll position on the next frame for debug
    // verification — useful when tuning the offset on a real device.
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          debugDcrScroll("afterY", { scrollY: window.scrollY });
        });
      });
    }
  }

  // ?debug_dcr_scroll=1 surfaces the auto-collapse → scroll trace in the
  // browser console. Off by default — there's no visual indicator.
  let _DCR_SCROLL_DEBUG = false;
  try {
    const u = new URLSearchParams((typeof location !== "undefined" && location.search) || "");
    _DCR_SCROLL_DEBUG = u.get("debug_dcr_scroll") === "1" || u.get("debug_dcr_scroll") === "true";
  } catch (_e) {}
  function debugDcrScroll(label, meta) {
    if (!_DCR_SCROLL_DEBUG) return;
    try { console.info("[DCRScroll] " + label, meta || ""); } catch (_e) {}
  }

  function toggleSectionCollapse(sectionId) {
    sectionCollapsed[sectionId] = !sectionCollapsed[sectionId];
    applyCollapseState(sectionId);
    scheduleSaveDraft();
  }

  function applyCollapseState(sectionId) {
    const card = document.querySelector(`.checklist-card[data-section-id="${sectionId}"]`);
    if (!card) return;
    const collapsed = !!sectionCollapsed[sectionId];
    card.classList.toggle("is-collapsed", collapsed);
    const headerBtn = card.querySelector(".checklist-header");
    if (headerBtn) headerBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  /* ---------- render: experience rating cards ---------- */

  function renderRating(cfg) {
    const root = $("experience-rating");
    if (!root) return;
    root.innerHTML = "";
    (cfg.experience_ratings || []).forEach(function (r) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rating-card";
      btn.dataset.value = r.id;
      btn.textContent = r.label;
      btn.addEventListener("click", function () { onRating(r.id); });
      root.appendChild(btn);
    });
  }

  function onRating(value) {
    ratingState = value;
    $$(".rating-card", $("experience-rating")).forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.value === value);
    });
    scheduleSaveDraft();
    refreshDcrCompletion();   // Phase 3 instant update
  }

  /* ---------- render: time budget reason groups ---------- */

  function renderTimeBudgetReasons(cfg) {
    const root = $("time-budget-reasons");
    if (!root) return;
    root.innerHTML = "";
    // Phase 1e.2 — render the canonical scope-change option set. The
    // "Anything else…" note textarea below is always visible when the
    // card is shown (no per-reason reveal), so no "other"-gated logic.
    const opts = Array.isArray(cfg.over_budget_context_options)
      ? cfg.over_budget_context_options
      : [];
    if (!opts.length) return;

    const block = document.createElement("div");
    block.className = "reason-group";

    opts.forEach(function (reason) {
      const label = document.createElement("label");
      label.className = "check-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = reason.id;
      cb.dataset.group = "over_budget_context";
      cb.addEventListener("change", function () {
        if (cb.checked) timeBudgetReasons.add(reason.id);
        else            timeBudgetReasons.delete(reason.id);
        scheduleSaveDraft();
      });

      const span = document.createElement("span");
      span.textContent = reason.label;

      label.appendChild(cb);
      label.appendChild(span);
      block.appendChild(label);
    });

    root.appendChild(block);
  }

  // Phase 1e.2 retired the "other"-gated note reveal. The textarea is
  // now always visible when the Time card is shown ("Anything else
  // that would help us explain the extra time?"). This helper remains
  // as a no-op so older draft-restore / reset callers don't blow up;
  // a follow-up cleanup can delete it once those callers are pruned.
  function toggleOverBudgetOtherNoteVisibility(_visible) {
    const ta = $("over-budget-other-note");
    if (!ta) return;
    if (_visible === false) {
      // Reset path — clear the textarea + module state so a fresh DCR
      // starts blank. (Truthy calls used to reveal #over-budget-other-wrap,
      // which no longer exists; left intentionally noop.)
      ta.value = "";
      overBudgetOtherNote = "";
      scheduleSaveDraft();
    }
  }

  /* ---------- yes/no segmented control ---------- */

  function wireSegments() {
    $$(".seg").forEach(function (seg) {
      const name = seg.dataset.name;
      $$(".seg-btn", seg).forEach(function (btn) {
        btn.addEventListener("click", function () { onSeg(name, btn.dataset.value); });
      });
    });
  }

  function onSeg(name, value) {
    segState[name] = value;
    $$(`.seg[data-name="${name}"] .seg-btn`).forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.value === value);
    });
    updateConditionals();
    scheduleSaveDraft();
    refreshDcrCompletion();   // Phase 3 instant update
  }

  function updateConditionals() {
    $$(".conditional").forEach(function (el) {
      const cond = el.dataset.showWhen;
      if (!cond) return;
      const [name, expected] = cond.split("=");
      el.classList.toggle("is-shown", segState[name] === expected);
    });
  }

  /* ---------- signature pad ---------- */

  function createSignaturePad(canvas, padEl) {
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    let drawing = false;
    let inked   = false;
    let lastX = 0, lastY = 0;

    function applyContextDefaults() {
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";
      ctx.lineWidth   = 2.4;
      ctx.strokeStyle = "#14171a";
    }

    function sizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width  * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      canvas.width  = w;
      canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      applyContextDefaults();
    }

    function pointFromEvent(ev) {
      const rect = canvas.getBoundingClientRect();
      let clientX, clientY;
      if (ev.touches && ev.touches.length) {
        clientX = ev.touches[0].clientX;
        clientY = ev.touches[0].clientY;
      } else {
        clientX = ev.clientX;
        clientY = ev.clientY;
      }
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function start(ev) {
      ev.preventDefault();
      drawing = true;
      const p = pointFromEvent(ev);
      lastX = p.x; lastY = p.y;
      ctx.beginPath();
      ctx.arc(lastX, lastY, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      inked = true;
      if (padEl) padEl.classList.add("is-focused");
    }

    function move(ev) {
      if (!drawing) return;
      ev.preventDefault();
      const p = pointFromEvent(ev);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
      inked = true;
    }

    function end() {
      drawing = false;
      if (padEl) padEl.classList.remove("is-focused");
    }

    canvas.addEventListener("mousedown",  start);
    canvas.addEventListener("mousemove",  move);
    canvas.addEventListener("mouseup",    end);
    canvas.addEventListener("mouseleave", end);

    canvas.addEventListener("touchstart",  start, { passive: false });
    canvas.addEventListener("touchmove",   move,  { passive: false });
    canvas.addEventListener("touchend",    end);
    canvas.addEventListener("touchcancel", end);

    sizeCanvas();

    return {
      canvas: canvas,
      hasInk: function () { return inked; },
      clear: function () {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        applyContextDefaults();
        inked = false;
      },
      toBlob: function (mimeType) {
        return new Promise(function (resolve, reject) {
          canvas.toBlob(
            function (blob) { blob ? resolve(blob) : reject(new Error("Failed to encode signature.")); },
            mimeType || "image/png"
          );
        });
      }
    };
  }

  /* ---------- photo handling ---------- */

  function extFromFile(file) {
    const byName = (file.name || "").split(".").pop();
    if (byName && byName.length <= 5) return byName.toLowerCase();
    const byType = (file.type || "").split("/").pop();
    return (byType || "bin").toLowerCase();
  }

  function validateFile(f) {
    if (!f.type || !f.type.startsWith(ALLOWED_PREFIX)) return `${f.name}: not an image.`;
    if (f.size > MAX_BYTES_PER_PHOTO)                  return `${f.name}: exceeds 10 MB.`;
    return null;
  }

  function onFileInputChange(ev) {
    const incoming = Array.from(ev.target.files || []);
    const errors = [];
    const accepted = [];
    incoming.forEach(function (f) {
      const err = validateFile(f);
      if (err) errors.push(err);
      else accepted.push(f);
    });

    pendingFiles = pendingFiles.concat(accepted).slice(0, MAX_PHOTOS);

    if (errors.length) setStatus("err", errors.join(" "));
    else               setStatus("", "");

    renderPhotoPreview();
    ev.target.value = "";
  }

  function renderPhotoPreview() {
    const root = $("photo-preview");
    root.innerHTML = "";
    pendingFiles.forEach(function (f, idx) {
      const thumb = document.createElement("div");
      thumb.className = "photo-thumb";

      const img = document.createElement("img");
      img.alt = f.name;
      img.src = URL.createObjectURL(f);
      img.onload = function () { URL.revokeObjectURL(img.src); };

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = "Remove photo";
      remove.setAttribute("aria-label", `Remove photo ${idx + 1}`);
      remove.addEventListener("click", function () {
        pendingFiles.splice(idx, 1);
        renderPhotoPreview();
      });

      thumb.appendChild(img);
      thumb.appendChild(remove);
      root.appendChild(thumb);
    });

    const counter = $("photo-counter-text");
    if (counter) counter.textContent = `${pendingFiles.length} of ${MAX_PHOTOS}`;
  }

  /* ---------- upload progress UI ---------- */

  function showUploadProgress(label) {
    const root = $("upload-progress");
    const lbl  = $("upload-progress-label");
    const pct  = $("upload-progress-pct");
    const fill = $("upload-progress-bar-fill");
    if (root) root.hidden = false;
    if (lbl)  lbl.textContent  = label || "Uploading…";
    if (pct)  pct.textContent  = "0%";
    if (fill) fill.style.width = "0%";
  }
  function setUploadProgress(label, pctValue) {
    const lbl  = $("upload-progress-label");
    const pct  = $("upload-progress-pct");
    const fill = $("upload-progress-bar-fill");
    const clamped = Math.max(0, Math.min(100, Math.round(pctValue)));
    if (lbl  && label) lbl.textContent  = label;
    if (pct)  pct.textContent  = clamped + "%";
    if (fill) fill.style.width = clamped + "%";
  }
  function hideUploadProgress() {
    const root = $("upload-progress");
    if (root) root.hidden = true;
  }

  /* ---------- submission id ---------- */

  function newSubmissionId() {
    const ts  = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rnd}`;
  }

  /* ---------- upload one photo (UNCHANGED storage path contract) ---------- */

  function uploadPhoto(storage, customerSlug, submissionId, file, index, onProgress) {
    const ext  = extFromFile(file);
    const path = `dcr-photos/${customerSlug}/${submissionId}/photo-${index + 1}.${ext}`;
    const ref  = storage.ref(path);
    const task = ref.put(file, { contentType: file.type });

    return new Promise(function (resolve, reject) {
      task.on(
        "state_changed",
        function (snap) {
          const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
          if (onProgress) onProgress(pct);
        },
        reject,
        async function () {
          try {
            const url = await task.snapshot.ref.getDownloadURL();
            resolve({
              id: `ph_${index + 1}`,
              storage_path: path,
              download_url: url,
              content_type: file.type || null,
              size_bytes:   file.size,
              width:  null,
              height: null,
              caption: "",
              tag: "general"
            });
          } catch (e) { reject(e); }
        }
      );
    });
  }

  /* ---------- upload signature (UNCHANGED storage path contract) ---------- */

  function uploadSignature(storage, customerSlug, submissionId, blob, onProgress) {
    const path = `dcr-signatures/${customerSlug}/${submissionId}/signature.png`;
    const ref  = storage.ref(path);
    const task = ref.put(blob, { contentType: "image/png" });

    return new Promise(function (resolve, reject) {
      task.on(
        "state_changed",
        function (snap) {
          const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
          if (onProgress) onProgress(pct);
        },
        reject,
        async function () {
          try {
            const url = await task.snapshot.ref.getDownloadURL();
            resolve({
              storage_path: path,
              download_url: url,
              content_type: "image/png",
              size_bytes:   blob.size
            });
          } catch (e) { reject(e); }
        }
      );
    });
  }

  /* ---------- assemble form_data (rich answers, attached to payload) ---------- */

  function buildFormData(cfg) {
    const checklist = cfg.checklist_sections.map(function (section) {
      return {
        section_id:    section.id,
        section_label: section.label,
        items: section.items.map(function (item) {
          const status = (checklistState[section.id] && checklistState[section.id][item.id]) || null;
          const note   = (checklistNotes[section.id] && checklistNotes[section.id][item.id]) || "";
          const entry  = { item_id: item.id, label: item.label, status: status };
          // Only attach a note when the status is "issue" — keeps the doc
          // shape predictable and Zapier-mappable, no stale notes left over
          // from a temporary issue selection.
          if (status === "issue" && note.trim()) entry.note = note.trim();
          return entry;
        })
      };
    });

    const needsSupplies = segState.needs_supplies === "yes";
    const supplyText    = needsSupplies ? (els.supplyRequestText.value || "").trim() : "";

    const hasProblem = segState.has_problem === "yes";
    const problem    = hasProblem ? {
      category:  els.problemCategory.value || null,
      summary:   (els.problemSummary.value  || "").trim(),
      details:   (els.problemDetails.value  || "").trim(),
      location:  (els.problemLocation.value || "").trim(),
      our_fault: segState.problem_our_fault === "yes"
    } : null;

    const anyoneIn       = segState.anyone_in_building === "yes";
    const occupancyLevel = anyoneIn ? (els.occupancyLevel.value || "") : "empty";

    // Phase 1e.1 — the yes/no on_time_budget control was retired (Pioneer
    // Time Clock now captures worked vs budget directly). We still emit
    // the same on_time_budget / timeBudget fields so downstream readers
    // (admin DCR review, email render, dashboards) don't break, but we
    // synthesize them from the "what slowed you down" picks: any reason
    // checked → off budget; no reasons checked → on budget.
    const onTimeBudget = timeBudgetReasons.size === 0;

    return {
      checklist:            checklist,
      experience_rating:    ratingState || null,
      needs_supplies:       needsSupplies,
      supply_request_text:  supplyText,
      has_problem:          hasProblem,
      problem:              problem,
      anyone_in_building:   anyoneIn,
      occupancy_level:      occupancyLevel,
      on_time_budget:       onTimeBudget,
      time_budget_reasons:  onTimeBudget ? [] : Array.from(timeBudgetReasons),
      // V6 pilot — freeform "other" note for the over-budget reason.
      // Persisted under multiple field names so any downstream reader
      // (admin UI, DCR email render, future operational dashboards)
      // can pick it up without schema-migration churn:
      //   - snake_case (matches the rest of form_data shape)
      //   - camelCase mirrors per the V6 spec (overBudgetReason
      //     "other", overBudgetNote = freeform text)
      //   - timeBudget structured object for compose/render layers
      //     that prefer the nested shape
      // Only populated when over-budget AND "other" is selected;
      // empty otherwise so the doc doesn't carry stale notes.
      time_budget_other_note: (!onTimeBudget && timeBudgetReasons.has("other"))
        ? overBudgetOtherNote : "",
      overBudgetReason:       (!onTimeBudget && timeBudgetReasons.has("other"))
        ? "other" : null,
      overBudgetNote:         (!onTimeBudget && timeBudgetReasons.has("other"))
        ? overBudgetOtherNote : "",
      timeBudget: {
        withinBudget:  !!onTimeBudget,
        reasons:       onTimeBudget ? [] : Array.from(timeBudgetReasons),
        reasonsOther:  (!onTimeBudget && timeBudgetReasons.has("other"))
          ? overBudgetOtherNote : ""
      },
      // Phase 1e.2 — structured snapshot of the scope-change question. Only
      // present when the Time card was actually shown (linked Pioneer session
      // exceeded budget by >15m). Absence signals "no over-budget check
      // happened" — downstream readers can treat that as "no signal."
      time_over_budget_context: timeOverBudgetSnapshot
        ? {
            pioneer_service_session_id: timeOverBudgetSnapshot.pioneer_service_session_id,
            work_minutes:    timeOverBudgetSnapshot.work_minutes,
            budget_minutes:  timeOverBudgetSnapshot.budget_minutes,
            over_by_minutes: timeOverBudgetSnapshot.over_by_minutes,
            reasons:         Array.from(timeBudgetReasons),
            note:            overBudgetOtherNote || ""
          }
        : null
    };
  }

  /* ---------- draft save / restore ---------- */

  function scheduleSaveDraft() {
    if (isRestoringDraft) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraft, 500);
  }

  function saveDraft() {
    try {
      const draft = {
        saved_at: Date.now(),
        customer:           els.customer.value,
        tech:               els.tech.value,
        clean_date:         els.cleanDate.value,
        notes:              els.notes.value,
        seg:                segState,
        rating:             ratingState,
        checklist:          checklistState,
        checklistNotes:     checklistNotes,
        sectionCollapsed:   sectionCollapsed,
        timeBudgetReasons:  Array.from(timeBudgetReasons),
        overBudgetOtherNote: overBudgetOtherNote,
        supplyRequestText:  els.supplyRequestText.value,
        problemCategory:    els.problemCategory.value,
        problemSummary:     els.problemSummary.value,
        problemDetails:     els.problemDetails.value,
        problemLocation:    els.problemLocation.value,
        occupancyLevel:     els.occupancyLevel.value,
        affirm:             els.affirm.checked
        // (no signature_name — the cleaning tech selected at the top of the
        // form is the name of record, so the existing `tech` field covers it.)
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (e) { /* quota / privacy mode — silently skip */ }
    // Phase 3 polish: refresh the sticky context bar + submit-bar count
    // on every draft save. saveDraft is debounced to ~500ms after input,
    // so this won't run on every keystroke. Discrete state-change
    // handlers (onSeg, onRating, onChecklistPill) call refreshDcrCompletion
    // directly for instant feedback.
    refreshDcrCompletion();
  }

  /* ---------- Phase 3: sticky visit context + completion progress ----------
     Two consumers:
       1. #dcr-sticky-context — sticky bar at top showing customer · tech
          · date once all three are filled, with a slim progress bar.
       2. .submit-bar-progress — the "N of M sections complete" chip
          next to the Submit button. Sticky on mobile via existing CSS.
     Counts ONLY operational sections (customer/tech/date, the N
     checklist sections, supplies, rating, problems, occupancy, time,
     sign+signature). Photos + Notes are optional so they don't show
     up in the denominator. */
  function computeDcrCompletion() {
    const gates = [];
    gates.push({ id: "visit",      done: !!(els.customer && els.customer.value &&
                                            els.tech && els.tech.value &&
                                            els.cleanDate && els.cleanDate.value) });
    gates.push({ id: "supplies",   done: !!segState.needs_supplies });
    gates.push({ id: "rating",     done: !!ratingState });
    gates.push({ id: "problems",   done: !!segState.has_problem });
    gates.push({ id: "occupancy",  done: !!segState.anyone_in_building });
    // Phase 1e.1 — "time" gate removed. The time-budget question is now
    // an optional what-slowed-you-down picker, not a required yes/no.
    gates.push({ id: "submit",     done: !!(els.affirm && els.affirm.checked &&
                                            signaturePad && signaturePad.hasInk()) });

    const sections = (window.DCR_FORM_CONFIG &&
                      Array.isArray(window.DCR_FORM_CONFIG.checklist_sections))
                       ? window.DCR_FORM_CONFIG.checklist_sections : [];
    sections.forEach(function (section) {
      const items = section.items || [];
      let allDone = items.length > 0;
      for (let i = 0; i < items.length; i++) {
        const itemId = items[i].id;
        const st = checklistState[section.id] && checklistState[section.id][itemId];
        if (!st) { allDone = false; break; }
        if (st === "issue") {
          // Issue rows need a non-empty note to be considered complete —
          // matches the form-level submit validation in onSubmit.
          const note = (checklistNotes[section.id] && checklistNotes[section.id][itemId]) || "";
          if (!String(note).trim()) { allDone = false; break; }
        }
      }
      gates.push({ id: "section:" + section.id, done: allDone });
    });

    const total = gates.length;
    const done  = gates.filter(function (g) { return g.done; }).length;
    return { total: total, done: done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function refreshDcrCompletion() {
    // Only paint when the form is on screen (success card hides it).
    const successCard = document.getElementById("success-card");
    if (successCard && successCard.hidden === false) {
      const sticky = document.getElementById("dcr-sticky-context");
      if (sticky) sticky.hidden = true;
      return;
    }

    const stickyEl = document.getElementById("dcr-sticky-context");
    if (stickyEl) {
      const hasCtx = !!(els.customer && els.customer.value &&
                        els.tech && els.tech.value &&
                        els.cleanDate && els.cleanDate.value);
      if (!hasCtx) {
        stickyEl.hidden = true;
      } else {
        // Pull display names from the SELECTED option's textContent so
        // the bar shows "Lydig Construction" not "lydig-construction".
        const custName = (els.customer.selectedOptions && els.customer.selectedOptions[0])
                           ? els.customer.selectedOptions[0].textContent.trim()
                           : els.customer.value;
        const techName = (els.tech.selectedOptions && els.tech.selectedOptions[0])
                           ? els.tech.selectedOptions[0].textContent.trim()
                           : els.tech.value;
        let dateLabel = els.cleanDate.value;
        try {
          const d = new Date(els.cleanDate.value + "T12:00:00");
          if (!isNaN(d.getTime())) {
            dateLabel = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          }
        } catch (_e) { /* fall through to raw value */ }

        const setEl = function (id, text) {
          const el = document.getElementById(id);
          if (el) el.textContent = text;
        };
        setEl("dcr-sticky-customer", custName);
        setEl("dcr-sticky-tech",     techName);
        setEl("dcr-sticky-date",     dateLabel);
        stickyEl.hidden = false;
      }
    }

    const comp = computeDcrCompletion();

    // Sticky bar progress.
    const pctEl  = document.getElementById("dcr-sticky-progress-pct");
    const fillEl = document.getElementById("dcr-sticky-progress-fill");
    const barEl  = document.getElementById("dcr-sticky-progress-bar");
    if (pctEl)  pctEl.textContent = comp.pct + "%";
    if (fillEl) fillEl.style.width = comp.pct + "%";
    if (barEl) {
      barEl.setAttribute("aria-valuenow", String(comp.pct));
      barEl.setAttribute("data-state",
        comp.pct === 100 ? "complete" :
        comp.pct >= 60   ? "moving"   :
        comp.pct >  0    ? "started"  : "idle");
    }

    // Submit-bar progress chip.
    const sbTextEl = document.getElementById("submit-bar-progress-text");
    const sbWrapEl = document.getElementById("submit-bar-progress");
    if (sbTextEl) {
      sbTextEl.textContent = comp.done + " of " + comp.total + " sections complete";
    }
    if (sbWrapEl) {
      sbWrapEl.setAttribute("data-state",
        comp.pct === 100 ? "complete" :
        comp.pct >= 60   ? "moving"   :
        comp.pct >  0    ? "started"  : "idle");
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function restoreDraftIfFresh() {
    let raw = null;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
    if (!raw) return false;

    let draft;
    try { draft = JSON.parse(raw); } catch (e) { clearDraft(); return false; }

    if (!draft || !draft.saved_at || (Date.now() - draft.saved_at) > DRAFT_TTL_MS) {
      clearDraft();
      return false;
    }

    isRestoringDraft = true;
    try {
      // Plain inputs
      if (draft.customer)         els.customer.value         = draft.customer;
      if (draft.tech)             els.tech.value             = draft.tech;
      if (draft.clean_date)       els.cleanDate.value        = draft.clean_date;
      if (typeof draft.notes === "string") els.notes.value   = draft.notes;
      if (draft.supplyRequestText) els.supplyRequestText.value = draft.supplyRequestText;
      if (draft.problemCategory)   els.problemCategory.value   = draft.problemCategory;
      if (draft.problemSummary)    els.problemSummary.value    = draft.problemSummary;
      if (draft.problemDetails)    els.problemDetails.value    = draft.problemDetails;
      if (draft.problemLocation)   els.problemLocation.value   = draft.problemLocation;
      if (draft.occupancyLevel)    els.occupancyLevel.value    = draft.occupancyLevel;
      if (typeof draft.affirm === "boolean")        els.affirm.checked  = draft.affirm;

      // Segments
      Object.keys(draft.seg || {}).forEach(function (name) {
        onSeg(name, draft.seg[name]);
      });

      // Rating
      if (draft.rating) onRating(draft.rating);

      // Notes carry across as plain text; rehydrate first so onChecklistPill
      // can populate the textarea via the .has-issue reveal.
      checklistNotes = draft.checklistNotes || {};

      // Checklist statuses (after renderChecklists has built the DOM).
      // Migration: prior drafts used "skip" — map it to the new "na" value.
      Object.keys(draft.checklist || {}).forEach(function (sectionId) {
        const items = draft.checklist[sectionId] || {};
        Object.keys(items).forEach(function (itemId) {
          let state = items[itemId];
          if (state === "skip") state = "na";
          const row = document.querySelector(
            `.checklist-item[data-section-id="${sectionId}"][data-item-id="${itemId}"]`
          );
          if (row && state) {
            onChecklistPill(sectionId, itemId, state, row, null);
            // Re-populate the issue textarea (onChecklistPill toggled has-issue).
            if (state === "issue") {
              const note = row.querySelector(".issue-note");
              const text = (checklistNotes[sectionId] && checklistNotes[sectionId][itemId]) || "";
              if (note) note.value = text;
              // Re-apply the resolved-state visual + bump progress, since
              // the textarea's programmatic value-set doesn't fire `input`.
              refreshIssueResolved(row, sectionId, itemId);
              updateSectionProgress(sectionId);
            }
          }
        });
      });

      // Collapsed-state map. Apply AFTER pill statuses so any auto-collapse
      // that fired during the restore loop above doesn't fight us.
      sectionCollapsed = draft.sectionCollapsed || {};
      Object.keys(sectionCollapsed).forEach(applyCollapseState);

      // Time budget reason checkboxes
      (draft.timeBudgetReasons || []).forEach(function (reasonId) {
        timeBudgetReasons.add(reasonId);
        const cb = $$('input[type="checkbox"]', $("time-budget-reasons"))
          .find(function (c) { return c.value === reasonId; });
        if (cb) cb.checked = true;
      });

      // Phase 1e.2 — the "Anything else…" note textarea is always visible
      // when the Time card is shown (no "other"-gated reveal anymore).
      // Always hydrate the saved note + the textarea so the tech sees their
      // prior input. Card visibility is reasserted by loadLinkedPioneerSession.
      overBudgetOtherNote = String(draft.overBudgetOtherNote || "").trim();
      const overOtherEl = $("over-budget-other-note");
      if (overOtherEl) overOtherEl.value = overBudgetOtherNote;

      return true;
    } finally {
      isRestoringDraft = false;
      // Phase 3: once the draft is hydrated, refresh the sticky bar +
      // submit count so the tech sees their resume state right away.
      refreshDcrCompletion();
    }
  }

  function showDraftToast() {
    const toast = $("draft-toast");
    if (toast) toast.hidden = false;
  }
  function hideDraftToast() {
    const toast = $("draft-toast");
    if (toast) toast.hidden = true;
  }

  /* ---------- signature attribution (tech name → signature) ---------- */

  // The cleaning tech selected at the top of the form is the legal name of
  // record on every DCR. This keeps the attribution line below the pad in
  // sync with whatever's currently picked, and is read at submit time as
  // affirmation.signature_name.
  function updateSignatureAttribution() {
    const techOpt = els.tech && els.tech.selectedOptions[0];
    const name = techOpt && techOpt.value
      ? (techOpt.dataset.displayName || techOpt.textContent || "").trim()
      : "—";
    if (els.signatureAttribution) els.signatureAttribution.textContent = name;
  }

  /* ---------- validation collector ---------- */

  // Returns a list of {msg, scrollTo} objects describing every field that
  // still needs attention. Empty array = ready to submit.
  function collectValidationErrors() {
    const cfg = window.DCR_FORM_CONFIG;
    const errors = [];

    const customerOpt = els.customer.selectedOptions[0];
    const techOpt     = els.tech.selectedOptions[0];

    // ---- 1-3: visit basics ----
    if (!customerOpt || !customerOpt.value) errors.push({ msg: "Select a customer",       scrollTo: "#customer" });
    if (!techOpt     || !techOpt.value)     errors.push({ msg: "Select a cleaning tech",  scrollTo: "#tech"     });
    if (!els.cleanDate.value)                errors.push({ msg: "Pick a clean date",       scrollTo: "#clean_date" });

    // ---- 4: every checklist item needs a status; every Issue needs a note ----
    (cfg.checklist_sections || []).forEach(function (section) {
      const items = section.items;
      const missingCount = items.filter(function (item) {
        return !(checklistState[section.id] && checklistState[section.id][item.id]);
      }).length;
      if (missingCount > 0) {
        errors.push({
          msg: `${section.label}: ${missingCount} item${missingCount === 1 ? "" : "s"} still need${missingCount === 1 ? "s" : ""} a status`,
          scrollTo: `.checklist-card[data-section-id="${section.id}"]`
        });
      }
      items.forEach(function (item) {
        const status = checklistState[section.id] && checklistState[section.id][item.id];
        if (status === "issue") {
          const note = (checklistNotes[section.id] && checklistNotes[section.id][item.id]) || "";
          if (!note.trim()) {
            errors.push({
              msg: `Add a quick note for the issue at "${item.label}"`,
              scrollTo: `.checklist-item[data-section-id="${section.id}"][data-item-id="${item.id}"]`
            });
          }
        }
      });
    });

    // ---- 5: supplies (yes/no, plus textarea if yes) ----
    if (!segState.needs_supplies) {
      errors.push({ msg: "Answer: do you need supplies?", scrollTo: '.seg[data-name="needs_supplies"]' });
    } else if (segState.needs_supplies === "yes" && !els.supplyRequestText.value.trim()) {
      errors.push({ msg: "List the supplies you need",     scrollTo: "#supply_request_text" });
    }

    // ---- 6: experience rating ----
    if (!ratingState) {
      errors.push({ msg: "Rate how the clean went",         scrollTo: "#experience-rating" });
    }

    // ---- 7: problem (yes/no, plus category + summary if yes) ----
    if (!segState.has_problem) {
      errors.push({ msg: "Answer: was there a problem?",    scrollTo: '.seg[data-name="has_problem"]' });
    } else if (segState.has_problem === "yes") {
      if (!els.problemCategory.value) {
        errors.push({ msg: "Choose a problem category",     scrollTo: "#problem_category" });
      }
      const hasSummary = els.problemSummary.value.trim();
      const hasDetails = els.problemDetails.value.trim();
      if (!hasSummary && !hasDetails) {
        errors.push({ msg: "Add a short problem summary or details", scrollTo: "#problem_summary" });
      }
    }

    // ---- 8: at least one photo ----
    if (pendingFiles.length === 0) {
      errors.push({ msg: "Add at least one photo",          scrollTo: "#photos" });
    }

    // ---- 9: occupancy (yes/no, plus level if yes) ----
    if (!segState.anyone_in_building) {
      errors.push({ msg: "Answer: was anyone in the building?", scrollTo: '.seg[data-name="anyone_in_building"]' });
    } else if (segState.anyone_in_building === "yes" && !els.occupancyLevel.value) {
      errors.push({ msg: "Choose how busy the building was",    scrollTo: "#occupancy_level" });
    }

    // ---- 10: time budget — Phase 1e.1 retired the required yes/no.
    //          The "what slowed you down" picker is OPTIONAL and never
    //          gates submission. Pioneer Time Clock now captures
    //          worked time vs budget directly.

    // ---- 11: affirmation checkbox ----
    if (!els.affirm.checked) {
      errors.push({ msg: "Check the affirmation box",       scrollTo: "#affirm" });
    }

    // ---- 12: handwritten signature ----
    if (!signaturePad || !signaturePad.hasInk()) {
      errors.push({ msg: "Add your handwritten signature",  scrollTo: "#signature-canvas" });
    }

    return errors;
  }

  // Map a terse internal validation message to a calm, guided string
  // for the single-focus validation card. Returns the existing msg if
  // there's no specific mapping, so future errors don't crash.
  function guidedValidationCopy(err) {
    const m = (err && err.msg) || "";
    // Exact-match table for the canned strings collectValidationErrors
    // emits today. Order doesn't matter; this is a lookup.
    const MAP = {
      "Select a customer":                  "Pick a customer to start",
      "Select a cleaning tech":             "Pick the tech who cleaned",
      "Pick a clean date":                  "Set the clean date",
      "Answer: do you need supplies?":      "Tell us about supplies",
      "List the supplies you need":         "List the supplies you need",
      "Rate how the clean went":            "Rate how the clean went",
      "Answer: was there a problem?":       "Tell us if anything went wrong",
      "Choose a problem category":          "Pick the problem category",
      "Add a short problem summary or details": "Describe the problem briefly",
      "Add at least one photo":             "One more step — add a photo",
      "Answer: was anyone in the building?": "Tell us about occupancy",
      "Choose how busy the building was":   "Pick how busy it was",
      "Answer: did you stick to your time budget?": "Tell us about your time budget",
      "Pick a reason for being off budget": "Pick what threw the timing off",
      "Check the affirmation box":          "Check the affirmation to sign off",
      "Add your handwritten signature":     "Add your signature to finish"
    };
    if (MAP[m]) return MAP[m];

    // Checklist-section "N items still need a status" → "<Section> still needs attention"
    const sectionMatch = m.match(/^(.+?):\s+\d+\s+items?\s+still\s+needs?\s+a\s+status$/i);
    if (sectionMatch) return sectionMatch[1] + " still needs attention";

    // Per-item issue note: "Add a quick note for the issue at \"<item>\""
    const issueMatch = m.match(/^Add a quick note for the issue at\s+"(.+)"$/);
    if (issueMatch) return "Add a note to the issue on " + issueMatch[1];

    // Fall back to the original copy if a new error type lands without
    // a mapping — caller still gets readable text, just less polished.
    return m;
  }

  // Pick a supportive eyebrow based on how many items remain. The
  // wording shifts as the tech gets closer to done so the card feels
  // like it's cheering them on, not nagging.
  function validationEyebrowFor(count) {
    if (count <= 1) return "One last thing";
    if (count <= 2) return "Almost there";
    if (count <= 4) return "Just a few more steps";
    return "A few things to wrap up";
  }

  // Phase 4 refactor: single-focus operational guidance instead of a
  // bullet wall. Surfaces ONLY the next highest-priority missing item
  // with a tap-anywhere CTA that scrolls, expands, and glows. The
  // submit gate (collectValidationErrors) is unchanged.
  function showValidationErrors(errors) {
    const summary = $("validation-summary");
    const head    = $("validation-head");
    const msgEl   = $("validation-message");
    const ctaEl   = $("validation-cta");
    if (!summary) return;
    if (!errors || errors.length === 0) {
      summary.hidden = true;
      return;
    }

    const first      = errors[0];
    const guidedText = guidedValidationCopy(first);
    if (msgEl) msgEl.textContent = guidedText;
    if (head)  head.textContent  = validationEyebrowFor(errors.length);

    // Stash the target selector on the wrapper + CTA so the click
    // handler (wired once in wireValidationCta) can navigate to it.
    summary.dataset.scrollTo = first.scrollTo || "";
    if (ctaEl) ctaEl.dataset.scrollTo = first.scrollTo || "";

    summary.hidden = false;

    // Auto-scroll to the target on first paint so the tech sees both
    // the guidance card AND the destination together. The handler
    // below covers re-taps after the initial scroll.
    scrollToValidationTarget(first.scrollTo);
  }

  // Bring a missing-field target into view, expand the section if
  // it's collapsed, and pulse a brief glow. Used both on initial
  // showValidationErrors paint and on every CTA click.
  function scrollToValidationTarget(selector) {
    if (!selector) return;
    const target = document.querySelector(selector);
    if (!target) return;

    // Identify the wrapping card so we can expand + glow it as a unit.
    const card = target.closest(".checklist-card, .card") || target;

    // Expand a collapsed checklist section so its items become
    // visible after the scroll lands. toggleSectionCollapse handles
    // the actual aria-expanded + is-collapsed flip + persistence.
    if (card.classList && card.classList.contains("checklist-card") &&
        card.classList.contains("is-collapsed")) {
      const sectionId = card.dataset.sectionId;
      if (sectionId && typeof toggleSectionCollapse === "function") {
        toggleSectionCollapse(sectionId);
      }
    }

    // Smooth scroll + temporary glow. The glow class is removed on
    // animationend OR after a defensive 1.6s timeout in case the
    // browser drops the event.
    setTimeout(function () {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("is-validation-glow");
      const cleanup = function () { card.classList.remove("is-validation-glow"); };
      card.addEventListener("animationend", cleanup, { once: true });
      setTimeout(cleanup, 1600);
    }, 60);
  }

  // Wire the CTA + card-as-button once on boot so the click handler
  // survives every showValidationErrors() / hideValidationSummary()
  // toggle cycle.
  let _validationCtaWired = false;
  function wireValidationCta() {
    if (_validationCtaWired) return;
    const summary = $("validation-summary");
    const ctaEl   = $("validation-cta");
    if (!summary) return;
    function go(ev) {
      ev && ev.preventDefault && ev.preventDefault();
      const target = (ctaEl && ctaEl.dataset.scrollTo) ||
                     summary.dataset.scrollTo || "";
      scrollToValidationTarget(target);
    }
    if (ctaEl)  ctaEl.addEventListener("click", go);
    // The whole card is also a soft tap target — wide thumbs win.
    summary.addEventListener("click", function (ev) {
      // Don't double-fire when the inner button was the actual click.
      if (ev.target && ev.target.closest("#validation-cta")) return;
      go(ev);
    });
    _validationCtaWired = true;
  }

  function hideValidationSummary() {
    const summary = $("validation-summary");
    if (summary) summary.hidden = true;
  }

  /* ---------- success celebration (confetti + accent Lottie) ---------- */

  function spawnConfetti() {
    const root = $("success-confetti");
    if (!root) return;
    root.innerHTML = "";
    // Twelve dots in a 30° spread; staggered start times + varied distances
    // give the burst a natural, non-mechanical feel.
    const colors = ["var(--pc-teal)", "var(--pc-teal-200)", "#ffffff", "var(--pc-silver-300)"];
    for (let i = 0; i < 12; i++) {
      const dot = document.createElement("span");
      dot.className = "confetti-dot";
      dot.style.setProperty("--angle", (i * 30) + "deg");
      dot.style.setProperty("--distance", (110 + Math.floor(Math.random() * 70)) + "px");
      dot.style.setProperty("--delay", (Math.random() * 0.15).toFixed(3) + "s");
      dot.style.background = colors[i % colors.length];
      root.appendChild(dot);
    }
  }

  function triggerCelebration() {
    const card = $("success-card");
    if (!card) return;
    card.classList.remove("is-celebrating");
    void card.offsetWidth;        // force reflow → re-trigger CSS animation
    card.classList.add("is-celebrating");

    // Play the accent OK Lottie ~700 ms after the main fist-bump so the two
    // moments don't talk over each other.
    setTimeout(function () {
      const ok = $("success-ok-lottie");
      if (!ok) return;
      try {
        if (typeof ok.stop === "function") ok.stop();
        if (typeof ok.play === "function") ok.play();
      } catch (e) { /* graceful — element undefined or asset missing */ }
    }, 700);
  }

  /* ---------- submit ---------- */

  async function onSubmit(ev) {
    ev.preventDefault();
    if (isSubmitting) return;

    // Prime the success-sound element INSIDE the user-gesture chain.
    // The fully-async submit path (Storage upload → Function call) can
    // outlive Safari's "play allowed after gesture" window, so creating
    // + load()ing the Audio object here, while the click is still fresh,
    // lets the eventual onSuccess() call .play() on an already-primed
    // element. Silent no-op if the feature flag is off.
    primeDcrSuccessSound();

    // Roster gate — block submit if the live customer/tech list hasn't
    // loaded. Skipping this would let the form submit with empty slugs
    // and fail backend validation with a less friendly error.
    if (!rosterReady) {
      setStatus("err",
        "Couldn't reach the customer / tech list. Refresh the page and try again. " +
        "If the issue persists, email info@pioneercomclean.com to confirm Firestore is reachable."
      );
      return;
    }

    // One-shot validation — collect every missing/incomplete field and show
    // a clean checklist instead of failing one item at a time.
    setStatus("busy", "Checking…");
    const validationErrors = collectValidationErrors();
    if (validationErrors.length > 0) {
      setStatus("", "");
      showValidationErrors(validationErrors);
      return;
    }
    hideValidationSummary();

    // Past the gate — the validator above guarantees these are populated.
    const customerOpt   = els.customer.selectedOptions[0];
    const techOpt       = els.tech.selectedOptions[0];
    // The cleaning tech selected at the top of the form is the signer of
    // record on this DCR. No retype required.
    const signatureName = (techOpt.dataset.displayName || techOpt.textContent || "").trim();

    const submissionId = newSubmissionId();
    const customerSlug = customerOpt.value;

    isSubmitting = true;
    els.submitBtn.disabled = true;

    try {
      let uploadedPhotos = [];

      if (pendingFiles.length) {
        showUploadProgress(`Uploading photo 1 of ${pendingFiles.length}…`);
        for (let i = 0; i < pendingFiles.length; i++) {
          const photoIndex = i + 1;
          setUploadProgress(`Uploading photo ${photoIndex} of ${pendingFiles.length}…`, 0);
          const meta = await uploadPhoto(
            firebaseCtx.storage, customerSlug, submissionId, pendingFiles[i], i,
            function (pct) {
              setUploadProgress(`Uploading photo ${photoIndex} of ${pendingFiles.length}…`, pct);
            }
          );
          uploadedPhotos.push(meta);
        }
      }

      showUploadProgress("Uploading signature…");
      const signatureBlob = await signaturePad.toBlob("image/png");
      const signatureMeta = await uploadSignature(
        firebaseCtx.storage, customerSlug, submissionId, signatureBlob,
        function (pct) { setUploadProgress("Uploading signature…", pct); }
      );

      hideUploadProgress();
      setStatus("busy", "Saving DCR…");

      const formData = buildFormData(window.DCR_FORM_CONFIG);
      formData.signature = {
        storage_path: signatureMeta.storage_path,
        download_url: signatureMeta.download_url
      };

      const customerName        = customerOpt.dataset.name             || customerOpt.textContent;
      const customerEmail       = customerOpt.dataset.email            || "";
      const locationName        = customerOpt.dataset.locationName     || customerName;
      // Dataset values are strings — `!== "false"` defaults to true if
      // the attribute is missing entirely (unlikely, but defensive).
      const customerDcrEmailEnabled = customerOpt.dataset.dcrEmailEnabled !== "false";
      const reviewFiveStar      = customerOpt.dataset.reviewFiveStar   || "";
      const reviewIssue         = customerOpt.dataset.reviewIssue      || "";

      const payload = window.buildDcrV1Payload({
        submission_id: submissionId,
        source: "web_form",
        customer: {
          slug: customerSlug,
          name: customerName,
          email: customerEmail,
          location_name: locationName,
          // Carried into payload.customer_dcr_email_enabled + delivery.customer_email_enabled.
          dcr_email_enabled: customerDcrEmailEnabled,
          review_links: { five_star_url: reviewFiveStar, issue_url: reviewIssue }
        },
        tech: {
          slug: techOpt.value,
          display_name:     techOpt.dataset.displayName     || techOpt.textContent,
          experience_level: techOpt.dataset.experienceLevel || "standard"
        },
        clean_date: els.cleanDate.value,
        occupancy:  formData.occupancy_level || "",
        notes:      els.notes.value || "",
        photos:     uploadedPhotos,
        affirmation: {
          affirmed:        true,
          signature_name:  signatureName,
          affirmed_text:   AFFIRM_TEXT,
          signature_url:   signatureMeta.download_url
        }
      });

      payload.form_data = formData;

      // Deputy-shift handoff — when the form was launched from a
      // Today's Assignments card, the snapshot lives in module state
      // (parsed once at boot from location.search). We attach it to
      // the payload here as flat `deputy_*` top-level fields so the
      // server's `{...payload}` spread preserves them on the
      // dcr_submissions doc without any submitDcrV1 changes.
      //
      // Future timesheet sync hooks (deputy_actual_*, timesheet_id,
      // time_variance_minutes) are written as null placeholders so the
      // doc shape stays stable — later jobs can update these fields in
      // place rather than fanning out a schema migration.
      if (deputyShiftParams && deputyShiftParams.deputy_shift_id) {
        payload.deputy_shift_id          = deputyShiftParams.deputy_shift_id;
        payload.deputy_sync_date         = deputyShiftParams.sync_date         || "";
        payload.deputy_scheduled_start   = deputyShiftParams.scheduled_start   || "";
        payload.deputy_scheduled_end     = deputyShiftParams.scheduled_end     || "";
        payload.deputy_customer_name     = deputyShiftParams.customer_name     || "";
        payload.deputy_location_name     = deputyShiftParams.location_name     || "";
        payload.deputy_shift_url         = deputyShiftParams.deputy_shift_url  || "";
        payload.deputy_actual_start          = null;
        payload.deputy_actual_end            = null;
        payload.deputy_timesheet_id          = null;
        payload.deputy_time_variance_minutes = null;
        // PioneerOps workflow link — submitDcrV1 reads this to flip
        // pioneer_work_sessions/{id}.status from "working" to
        // "needs_finish" and stamp pioneer_dcr_submitted_at +
        // dcr_submission_id. Empty when the DCR was opened outside
        // the guided workflow (manual DCR), and that's fine.
        if (deputyShiftParams.pioneer_session_id) {
          payload.pioneer_session_id = deputyShiftParams.pioneer_session_id;
        }
      }

      // Phase 1b.4 — Pioneer Time Clock handoff. Independent from the
      // Deputy block above (a DCR can carry either, both, or neither).
      // submitDcrV1 reads pioneer_assignment_id + pioneer_service_session_id
      // and back-stamps dcr_submission_id onto the matching
      // pioneer_service_sessions doc + service_assignments doc.
      if (pioneerAssignmentParams && pioneerAssignmentParams.pioneer_assignment_id) {
        payload.pioneer_assignment_id = pioneerAssignmentParams.pioneer_assignment_id;
        if (pioneerAssignmentParams.pioneer_service_session_id) {
          payload.pioneer_service_session_id = pioneerAssignmentParams.pioneer_service_session_id;
        }
      }

      // Defensive guard against any silent shape regression.
      if (
        !payload.affirmation ||
        payload.affirmation.affirmed !== true ||
        !payload.affirmation.signature_name ||
        !payload.affirmation.signature_url
      ) {
        throw new Error("affirmation missing required fields — refusing to submit.");
      }

      // Attach the current staff's ID token. The function rejects the
      // submission with 401 if missing or 403 if not an active staff member.
      const idToken = window.STAFF_AUTH && await window.STAFF_AUTH.getIdToken();
      if (!idToken) {
        throw new Error("You're not signed in. Refresh the page and sign in again.");
      }
      try { console.info("[DCR] send start", { submissionId: submissionId, customer_slug: payload.customer_slug }); } catch (_e) {}
      const res = await fetch(window.SUBMIT_DCR_V1_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify(payload)
      });

      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        const details = Array.isArray(body.details) && body.details.length
          ? `\n• ${body.details.join("\n• ")}`
          : "";
        throw new Error(`${body.error || `Server returned ${res.status}`}${details}`);
      }

      try {
        console.info("[DCR] submit accepted", {
          submission_id: body.submission_id || submissionId,
          email_status:  (body.email && body.email.status) || null,
          feedback_links_generated:
            !!(body.feedback && (body.feedback.complimentUrl || body.feedback.problemUrl))
        });
      } catch (_e) {}
      clearDraft();
      onSuccess(body.submission_id || submissionId, body.zapier || null);
    } catch (err) {
      console.error("[DCR] submit failed", err);
      hideUploadProgress();
      setStatus("err", `Submission failed: ${err.message || err}`);
    } finally {
      isSubmitting = false;
      els.submitBtn.disabled = false;
    }
  }

  /* ---------- success / reset ---------- */

  function onSuccess(submissionId, zapierStatus) {
    setStatus("", "");
    hideDraftToast();
    hideValidationSummary();
    els.form.hidden = true;
    $("success-submission-id").textContent = submissionId;
    renderSuccessZapier(zapierStatus);
    spawnConfetti();
    paintSuccessGoldenPath();
    $("success-card").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    triggerCelebration();
    playSuccessLottie();
    playDcrSuccessSound(submissionId);
    // Phase 3: hide the sticky context bar — the DCR is in the post-
    // submit celebration moment, not "open".
    const sticky = document.getElementById("dcr-sticky-context");
    if (sticky) sticky.hidden = true;
  }

  // Show the right post-submit affordance block:
  //   • Session-linked DCR (came in from Start Work) → "Final step"
  //     panel with Finish Work + Open Deputy.
  //   • Manual / admin / no session → calmer fallback with
  //     "Back to Today's Work" + "Start another DCR".
  function paintSuccessGoldenPath() {
    // Phase 1b.4 — the "final-step" panel paints for EITHER a Deputy
    // hand-off (deputy.pioneer_session_id) OR a Pioneer Time Clock
    // hand-off (pioneer_assignment_id). Both flows can coexist on the
    // same DCR (uncommon today; future cross-link). When only Pioneer
    // is present, hide the Deputy-specific buttons.
    const deputySessionId          = (deputyShiftParams      && String(deputyShiftParams.pioneer_session_id              || "").trim()) || "";
    const pioneerAssignmentId      = (pioneerAssignmentParams && String(pioneerAssignmentParams.pioneer_assignment_id     || "").trim()) || "";
    // V20260614 — Pioneer Time Clock session id from the DCR open URL.
    // service-clock.js's dcrHref() sets this whenever the DCR was
    // launched from a Pioneer Time Clock card. We pass it through to
    // /work.html so the auto-finish handler can mark the session
    // status: "completed" on the Pioneer side, not just the Deputy
    // bridge.
    const pioneerServiceSessionId  = (pioneerAssignmentParams && String(pioneerAssignmentParams.pioneer_service_session_id || "").trim()) || "";
    const finalStep = document.getElementById("success-final-step");
    const noSession = document.getElementById("success-no-session");
    if (deputySessionId || pioneerAssignmentId) {
      if (finalStep) finalStep.hidden = false;
      if (noSession) noSession.hidden = true;

      // Finish Work button — shows whenever EITHER the Deputy bridge
      // flow OR the Pioneer Time Clock flow has a finishable session.
      // The handler builds a /work.html URL carrying both ids when
      // available; the auto-finish handlers in today-work.js and
      // service-clock.js each pick up their respective param and
      // close their own model. Deputy-only button (Open Deputy)
      // still gated to deputySessionId presence.
      const finishBtn = document.getElementById("success-finish-work");
      const deputyBtn = document.getElementById("success-open-deputy");
      const anyFinishable = !!(deputySessionId || pioneerServiceSessionId);
      if (finishBtn) {
        if (anyFinishable) {
          finishBtn.hidden = false;
          finishBtn.onclick = function () {
            const qs = new URLSearchParams();
            if (deputySessionId)         qs.set("finishSession",            deputySessionId);
            if (pioneerServiceSessionId) qs.set("finishPioneerSession",     pioneerServiceSessionId);
            if (pioneerAssignmentId)     qs.set("finishPioneerAssignment",  pioneerAssignmentId);
            window.location.href = "/work.html?" + qs.toString();
          };
        } else {
          finishBtn.hidden = true;
        }
      }
      if (deputyBtn) {
        if (deputySessionId) {
          deputyBtn.hidden = false;
          if (!deputyBtn.dataset.deputyClickWired) {
            deputyBtn.dataset.deputyClickWired = "1";
            deputyBtn.addEventListener("click", function () {
              logDeputyOpenClick("dcr_success", {
                shift_id:           String((deputyShiftParams && deputyShiftParams.deputy_shift_id) || ""),
                sync_date:          String((deputyShiftParams && deputyShiftParams.sync_date) || ""),
                pioneer_session_id: String((deputyShiftParams && deputyShiftParams.pioneer_session_id) || "")
              });
            });
          }
        } else {
          deputyBtn.hidden = true;
        }
      }

      // Pioneer-specific back-link — repurpose the existing
      // #success-back-to-work anchor to point at /work.html?focus=ptc
      // and relabel as "Back to Pioneer Time Clock". Falls back to the
      // default "Back to Today's Work" / /work.html for the Deputy-only
      // case.
      const backToWorkLink = document.getElementById("success-back-to-work");
      if (backToWorkLink) {
        if (pioneerAssignmentId) {
          backToWorkLink.href = "/work.html?focus=ptc";
          backToWorkLink.textContent = "← Back to Pioneer Time Clock";
        } else {
          backToWorkLink.href = "/work.html";
          backToWorkLink.textContent = "← Back to Today's Work";
        }
      }
    } else {
      if (finalStep) finalStep.hidden = true;
      if (noSession) noSession.hidden = false;
    }
  }

  // Tiny optional delight: a soft flush sound effect after a confirmed
  // DCR submission. Strictly cosmetic.
  //
  // Contract:
  //   • Only fires from onSuccess (post-submit). Never on validation
  //     errors, never on draft restore, never on form reset.
  //   • Dedup-by-submissionId so a success-card rerender can't replay.
  //   • Silent on:
  //       - feature flag off
  //       - missing audio file (server 404 → play() rejects)
  //       - browser autoplay restrictions (play() rejects)
  //       - older browsers without the Audio constructor
  //   • No screen-reader announcement — decorative audio only, no DOM.
  //   • Volume capped at 0.25 so it never startles in a quiet office.
  //
  // Autoplay survival strategy:
  //   The submit path is fully-async (Storage upload → Function call →
  //   onSuccess). On Safari especially, the "user gesture" window can
  //   expire before onSuccess fires, even though the original click is
  //   the cause. primeDcrSuccessSound() runs inside the gesture chain
  //   at the top of onSubmit() to pre-create + .load() the Audio
  //   element while the click is still fresh, so the eventual .play()
  //   has the best chance of being honored.
  let _dcrSuccessAudio = null;

  function primeDcrSuccessSound() {
    if (!ENABLE_DCR_SUCCESS_SOUND) return;
    if (typeof Audio === "undefined") return;
    if (_dcrSuccessAudio) return;   // already primed for this page session
    try {
      _dcrSuccessAudio = new Audio(DCR_SUCCESS_SOUND_SRC);
      _dcrSuccessAudio.volume  = DCR_SUCCESS_SOUND_VOLUME;
      _dcrSuccessAudio.preload = "auto";
      // load() forces the browser to begin fetching the file so the
      // network round-trip doesn't add to submit latency.
      if (typeof _dcrSuccessAudio.load === "function") _dcrSuccessAudio.load();
      // Log file-fetch problems so a missing MP3 surfaces in DevTools
      // without breaking the submit flow.
      _dcrSuccessAudio.addEventListener("error", function () {
        console.warn("[dcr-success-sound] file unreachable at " + DCR_SUCCESS_SOUND_SRC +
                     " — check that the MP3 is deployed.");
      }, { once: true });
    } catch (_e) {
      // Audio constructor missing — drop silently.
    }
  }

  function playDcrSuccessSound(submissionId) {
    if (!ENABLE_DCR_SUCCESS_SOUND) return;
    if (typeof Audio === "undefined") return;
    const id = submissionId == null ? "" : String(submissionId);
    if (id && id === _dcrSuccessSoundLastPlayedId) return;
    _dcrSuccessSoundLastPlayedId = id || _dcrSuccessSoundLastPlayedId;

    // Use the primed element when available — keeps the play() inside
    // the user-gesture lineage. Fall back to a fresh Audio if no prime
    // happened (e.g. submit handler reached onSuccess via a non-click
    // code path — not currently possible, but defensive).
    let audio = _dcrSuccessAudio;
    if (!audio) {
      try {
        audio = new Audio(DCR_SUCCESS_SOUND_SRC);
        audio.volume = DCR_SUCCESS_SOUND_VOLUME;
      } catch (_e) {
        return;
      }
    }
    // Reset to start so a primed (possibly already-played) element
    // replays from the beginning. Some browsers reject currentTime
    // before the element has metadata; safe to swallow.
    try { audio.currentTime = 0; } catch (_e) { /* not always settable */ }

    const p = audio.play();
    if (p && typeof p.then === "function") {
      p.then(function () {
        // Quiet success log so we can confirm in DevTools that the
        // sound actually played. Not announced to screen readers.
        try { console.info("[dcr-success-sound] played ok"); } catch (_e) {}
      }).catch(function (err) {
        // Most common failures:
        //   • NotAllowedError — browser blocked autoplay
        //   • NotSupportedError — file missing or wrong MIME
        // The catch keeps the success flow uninterrupted either way.
        try {
          console.warn("[dcr-success-sound] play() rejected:",
                       (err && (err.name + ": " + err.message)) || err);
        } catch (_e) {}
      });
    }
  }

  // Trigger the Pioneer fist-bump animation. Deferred ~280 ms so the success
  // card's CSS slide-in completes first — the animation gets a clean "moment"
  // instead of competing with the card entrance. Silently no-ops if the
  // <lottie-player> script hasn't defined the element yet (the CSS fallback
  // shows the static SVG check in that case).
  function playSuccessLottie() {
    const player = $("success-lottie");
    if (!player) return;
    setTimeout(function () {
      try {
        if (typeof player.stop === "function") player.stop();
        if (typeof player.play === "function") player.play();
      } catch (err) { /* gracefully ignore — fallback SVG handles it */ }
    }, 280);
  }

  // Surface the delivery status on the success card. Currently the
  // submit pipeline is fully native PioneerOps (no Zapier); the
  // function name + CSS class are kept for stability but the user-
  // facing copy now reflects the native pipeline. Hidden when status
  // is missing or "not_configured" — those aren't actionable for the
  // cleaner.
  function renderSuccessZapier(status) {
    const el = $("success-zapier");
    if (!el) return;
    el.className = "success-zapier";
    el.hidden = true;
    el.textContent = "";
    if (!status || !status.status || status.status === "not_configured") return;
    if (status.status === "sent") {
      el.classList.add("is-sent");
      el.textContent = "Submitted to PioneerOps";
      el.hidden = false;
    } else if (status.status === "failed") {
      el.classList.add("is-failed");
      el.textContent = "Delivery pending — saved for retry";
      el.hidden = false;
    }
  }

  function onNewDcr() {
    pendingFiles        = [];
    segState            = {};
    ratingState         = "";
    checklistState      = {};
    checklistNotes      = {};
    sectionCollapsed    = {};
    timeBudgetReasons   = new Set();
    overBudgetOtherNote = "";
    // Also collapse the "other" note textarea + clear its value so a
    // fresh DCR doesn't start with the previous run's freeform text.
    const overOtherTa = $("over-budget-other-note");
    if (overOtherTa) overOtherTa.value = "";
    toggleOverBudgetOtherNoteVisibility(false);

    // Re-seed per-section sub-maps so the next pill click lands somewhere
    // valid. Without this, the handlers throw on first interaction with the
    // second DCR — root cause of the "Do another DCR breaks the buttons"
    // bug and the "Issue note doesn't take" bug.
    ensureChecklistStateInitialized(window.DCR_FORM_CONFIG);

    els.form.reset();

    $("photo-preview").innerHTML = "";
    const counter = $("photo-counter-text");
    if (counter) counter.textContent = `0 of ${MAX_PHOTOS}`;

    $$(".seg-btn.is-active").forEach(function (b) { b.classList.remove("is-active"); });
    $$(".rating-card.is-active").forEach(function (b) { b.classList.remove("is-active"); });
    $$(".pill").forEach(function (p) {
      p.classList.remove("is-active--done", "is-active--issue", "is-active--na");
    });
    $$(".checklist-item").forEach(function (r) {
      r.classList.remove("is-answered", "has-issue", "issue-resolved",
                         "status-done", "status-issue", "status-na");
    });
    $$(".checklist-card").forEach(function (c) {
      c.classList.remove("is-collapsed", "is-complete", "has-issues");
      const headerBtn = c.querySelector(".checklist-header");
      if (headerBtn) headerBtn.setAttribute("aria-expanded", "true");
    });
    $$(".issue-note").forEach(function (t) { t.value = ""; });
    $$(".conditional").forEach(function (el) { el.classList.remove("is-shown"); });
    $$('input[type="checkbox"]', $("time-budget-reasons")).forEach(function (cb) { cb.checked = false; });

    // Reset every checklist progress display.
    (window.DCR_FORM_CONFIG.checklist_sections || []).forEach(function (s) {
      updateSectionProgress(s.id);
    });

    if (signaturePad) signaturePad.clear();

    // Reset the Lottie celebration so the next successful DCR plays it fresh
    // from frame 0 rather than from wherever the previous loop ended.
    const lottie = $("success-lottie");
    if (lottie && typeof lottie.stop === "function") {
      try { lottie.stop(); } catch (e) { /* not defined yet — fine */ }
    }
    const okLottie = $("success-ok-lottie");
    if (okLottie && typeof okLottie.stop === "function") {
      try { okLottie.stop(); } catch (e) { /* graceful */ }
    }
    // Clear the confetti container + remove the is-celebrating class so the
    // burst replays fresh on the next submit.
    const confetti = $("success-confetti");
    if (confetti) confetti.innerHTML = "";
    const successCard = $("success-card");
    if (successCard) successCard.classList.remove("is-celebrating");
    hideValidationSummary();

    setCleanDateToday();
    setStatus("", "");
    hideUploadProgress();
    clearDraft();

    $("success-card").hidden = true;
    els.form.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Phase 3: reset the sticky context bar to its idle state for the
    // fresh DCR (everything zeroed, bar hidden until customer/tech/date land).
    refreshDcrCompletion();
  }

  /* ---------- input wiring for draft autosave ---------- */

  function wireDraftInputs() {
    [
      els.customer, els.tech, els.cleanDate, els.notes,
      els.supplyRequestText, els.problemCategory, els.problemSummary,
      els.problemDetails, els.problemLocation, els.occupancyLevel,
      els.affirm
    ].forEach(function (el) {
      if (!el) return;
      el.addEventListener("input",  scheduleSaveDraft);
      el.addEventListener("change", scheduleSaveDraft);
    });
    // Phase 3: hook customer/tech/date directly so the sticky context
    // bar reveals INSTANTLY when all three land — without waiting for
    // saveDraft's 500ms debounce.
    [els.customer, els.tech, els.cleanDate, els.affirm].forEach(function (el) {
      if (!el) return;
      el.addEventListener("change", refreshDcrCompletion);
    });
    // Signature drawing — listen on the canvas for pointer events so
    // the "submit" gate flips once any ink lands.
    const sigCanvas = document.getElementById("signature-canvas");
    if (sigCanvas) {
      ["mouseup", "touchend", "touchcancel"].forEach(function (evt) {
        sigCanvas.addEventListener(evt, refreshDcrCompletion);
      });
    }
  }

  /* ---------- boot ---------- */

  /* ---------- staff auth integration ----------
   * The form is gated by STAFF_AUTH. The page renders one of:
   *   #staff-auth-checking → #staff-auth-signin / #staff-auth-denied / #staff-auth-content
   * Boot of the form's rendering + Firebase init runs ONLY once STAFF_AUTH
   * fires onAuthorized — that way we never read /customers without auth.
   */
  let bootedForStaff = false;

  function setStaffAuthState(state) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("staff-auth-" + s);
      if (el) el.hidden = s !== state;
    });
    const content = $("staff-auth-content");
    if (content) content.hidden = state !== "content";

    // Toggle the animated login backdrop. Only visible during the
    // sign-in card phase. The CSS disables animations entirely under
    // prefers-reduced-motion and on `body:not(.is-signing-in)`, so this
    // single class controls both visibility AND motion.
    document.body.classList.toggle("is-signing-in", state === "signin");
    const headerAccount = $("staff-header-account");
    const headerEmail   = $("staff-header-email");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
    } else {
      if (headerAccount) headerAccount.hidden = true;
      if (headerEmail)   headerEmail.textContent = "";
      // Also blank the display-name span so a previous user's name
      // doesn't linger in the chip if it briefly shows again.
      const nameEl = $("staff-header-name");
      if (nameEl) nameEl.textContent = "";
      // Hide nav on any non-content state — signed-out users see no nav.
      const nav = $("role-nav");
      if (nav) { nav.hidden = true; nav.innerHTML = ""; }
    }

    // Mobile snappy-boot polish — when re-opening after a previous
    // sign-in on the same device, swap the generic "Checking access…"
    // text for "Welcome back, {Name}…" using the cached staff snapshot.
    // The cache is not authorization (whoAmI is); this is purely UI.
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

  function applyStaffToTechDropdown(staff) {
    // Cleaning techs are LOCKED to their own slug in the tech dropdown.
    // Admins keep full control (handy for office-side submissions).
    if (!staff || !staff.tech || !staff.tech.slug) return;
    if (staff.role !== "cleaning_tech") return;
    if (!els.tech) return;
    const wanted = staff.tech.slug;
    const opt = Array.from(els.tech.options).find(function (o) { return o.value === wanted; });
    if (opt) {
      els.tech.value = wanted;
      els.tech.disabled = true;
      els.tech.title = "Locked to your account. An admin can change it server-side.";
      updateSignatureAttribution();
    }
  }

  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
  }

  /* ---------- role-aware navigation ---------- */
  //
  // Renders the small pill nav in the brand-header based on the signed-in
  // user's role from STAFF_AUTH. This is convenience navigation only —
  // security is enforced by the admin allowlist + server functions, NOT
  // by which buttons we paint here. Hiding the Admin link from a tech
  // does nothing to stop them visiting /admin directly; the admin page's
  // own gate handles that.
  //
  // `currentPage` matches the `data-current-page` attribute on the <nav>
  // and is used to mark the active link.
  // KEEP IN SYNC across five files: app.js, tech.js, admin.js,
  // supply-station.js, team-hub.js. Extracting this to a shared module
  // was evaluated and intentionally NOT done — the marginal duplication
  // is preferable to the load-order risk of a 6th <script> tag on every
  // page. When you edit the list, do it in all five places in the same
  // commit.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",           roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                    roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",           roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html", roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",       roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",       roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",    roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",               roles: ["admin"] }
    // Future placeholders (uncomment + wire when ready):
    //   { key: "announcements",   label: "Announcements",   href: "/announcements.html", roles: ["admin", "cleaning_tech"] },
    //   { key: "company-updates", label: "Company Updates", href: "/company-updates.html", roles: ["admin", "cleaning_tech"] },
  ];

  // Preserve any cache-buster (?v=2600, etc.) on nav hops so an admin
  // hard-busting one page doesn't slip back into a stale cached copy of
  // the next page. Falls back to the bare href if location.search is
  // empty. We deliberately do NOT carry forward hashes or unrelated
  // params — only the literal `location.search` string.
  function withCurrentSearch(href) {
    const search = (typeof location !== "undefined" && location.search) || "";
    if (!search) return href;
    return href + (href.indexOf("?") >= 0 ? "&" + search.slice(1) : search);
  }

  function renderRoleNav(role) {
    const nav = document.getElementById("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }

    const current = nav.dataset.currentPage || "";
    const items   = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = (i.key === current);
      const cls   = "role-nav-link" + (isActive ? " is-active" : "");
      const aria  = isActive ? ' aria-current="page"' : '';
      // Active link is rendered as a non-clickable span so screen
      // readers don't suggest "go to current page" and so the
      // pointer-cursor change in CSS isn't fighting an active anchor.
      if (isActive) {
        return '<span class="' + cls + '"' + aria + '>' + i.label + '</span>';
      }
      return '<a class="' + cls + '" href="' + withCurrentSearch(i.href) + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  // Pioneer Team Hub unread-announcements badge — paints a small red
  // pill on the Team Hub nav pill across every staff page. Identical
  // helper exists in app.js / tech.js / admin.js / supply-station.js /
  // team-hub.js. KEEP IN SYNC: edits to this block must land in all five.
  // No firestore SDK guard returns silently — pages that haven't loaded
  // firestore-compat (e.g. config error) just skip the badge.
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
      // V20260614c — inline targetsMe so badge count agrees with the
      // team-hub UI for admins (rule-bypass otherwise over-counts
      // audienceType="selected" announcements that don't target them).
      const myUid   = (staff && staff.uid) || null;
      const myEmail = String((staff && staff.email) || "").toLowerCase().trim();
      const mySlug  = String((staff && staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "");
      function targetsMe(a) {
        if (!a) return false;
        const type = String(a.audienceType || "all");
        if (type === "all") return true;
        if (type !== "selected") return true;  // unknown — fail open
        if (Array.isArray(a.recipientUids)      && myUid   && a.recipientUids.indexOf(myUid) >= 0) return true;
        if (Array.isArray(a.recipientEmails)    && myEmail && a.recipientEmails.indexOf(myEmail) >= 0) return true;
        if (Array.isArray(a.recipientTechSlugs) && mySlug  && a.recipientTechSlugs.indexOf(mySlug) >= 0) return true;
        return false;
      }
      const now = Date.now();
      let unread = 0;
      annsSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.archived_at) return;
        const s = toMs(a.starts_at);   if (s != null && s > now) return;
        const e = toMs(a.expires_at);  if (e != null && e <= now) return;
        if (!targetsMe(a)) return;
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

  // Identity painter — fills in display_name (or email fallback) into the
  // header chip. Email row stays for confirmation. Falls back gracefully
  // when no display name exists.
  function paintStaffIdentity(staff) {
    const nameEl  = document.getElementById("staff-header-name");
    const emailEl = document.getElementById("staff-header-email");
    const cached  = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
                      ? window.STAFF_AUTH.getCachedStaff() : null;
    const displayName =
      (staff && staff.tech && staff.tech.display_name) ||
      (cached && cached.display_name) ||
      "";
    if (nameEl) nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
  }

  // Inline message helper for the sign-in panel. Shared by password form,
  // forgot-password link, and Google fallback. Defensive null-checks so a
  // partial deploy can't blank the page.
  function setStaffAuthInlineMsg(msg, kind /* "ok" | "err" */) {
    const el = document.getElementById("staff-auth-inline-msg");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-ok");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("is-ok", kind === "ok");
    el.hidden = false;
  }

  function wireSignInButton() {
    const btn = document.getElementById("staff-signin-btn");
    if (btn) btn.addEventListener("click", async function () {
      if (!window.STAFF_AUTH) return;
      setStaffAuthInlineMsg("");
      btn.disabled = true;
      try {
        // STAFF_AUTH.signIn() returns a result envelope (NEVER throws).
        // On Safari, popup-based Google sign-in occasionally fails due
        // to storage partitioning; we deliberately do NOT fall back to
        // signInWithRedirect — the email/password form sitting right
        // above this button is the supported recovery path.
        const result = await window.STAFF_AUTH.signIn();
        if (result && !result.ok && !result.cancelled) {
          setStaffAuthInlineMsg(result.message, "err");
        }
        // On {ok: true}, onAuthStateChanged → onAuthorized flips the page.
      } finally {
        btn.disabled = false;
      }
    });

    // Email/password form. Form-submit handler so the Enter key works on
    // both inputs and the password manager autofill fires the submit.
    const form    = document.getElementById("staff-password-form");
    const submit  = document.getElementById("staff-password-submit");
    const emailEl = document.getElementById("staff-email");
    const passEl  = document.getElementById("staff-password");
    if (form && submit && emailEl && passEl) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        submit.disabled = true;
        const origLabel = submit.textContent;
        submit.textContent = "Signing in…";
        try {
          const result = await window.STAFF_AUTH.signInWithPassword(emailEl.value, passEl.value);
          if (!result.ok) {
            setStaffAuthInlineMsg(result.message, "err");
            passEl.value = "";
            passEl.focus();
          }
          // On success, onAuthStateChanged → whoAmI → onAuthorized flips the page.
        } finally {
          submit.disabled = false;
          submit.textContent = origLabel;
        }
      });
    }

    // Forgot password — sends a Firebase reset email to whatever's in the
    // email field. Reset itself happens at Firebase's hosted reset page.
    const forgot = document.getElementById("staff-forgot-link");
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

  document.addEventListener("DOMContentLoaded", function () {
    els.form              = $("dcr-form");
    els.customer          = $("customer");
    els.tech              = $("tech");
    els.cleanDate         = $("clean_date");
    els.notes             = $("notes");
    els.photos            = $("photos");
    els.submitBtn         = $("submit-btn");
    els.status            = $("status");
    els.affirm            = $("affirm");
    els.supplyRequestText = $("supply_request_text");
    els.problemCategory   = $("problem_category");
    els.problemSummary    = $("problem_summary");
    els.problemDetails    = $("problem_details");
    els.problemLocation   = $("problem_location");
    els.occupancyLevel    = $("occupancy_level");
    // No more typed signature input — the tech selected at the top of the
    // form is the name of record, mirrored into the small attribution line.
    els.signatureAttribution = $("signature-attribution-name");

    // The whole "real" boot — Firebase init, dropdown render, draft restore,
    // signature pad, etc. — runs ONLY after STAFF_AUTH says the user is
    // active staff. That way no Firestore read fires until the user is
    // authenticated, and no SUBMIT_DCR_V1_URL fetch can happen without a
    // valid ID token. Anyone signed-out or denied sees the auth-screen
    // cards instead.
    function bootFormForStaff(staff) {
      if (bootedForStaff) return;
      bootedForStaff = true;

      ensureConfig();
      firebaseCtx = initFirebase();

      const cfg = window.DCR_FORM_CONFIG;
      MAX_PHOTOS = (typeof cfg.max_photos === "number" && cfg.max_photos > 0) ? cfg.max_photos : 12;
      const maxLabel = $("max-photos-label");
      if (maxLabel) maxLabel.textContent = String(MAX_PHOTOS);
      const counter = $("photo-counter-text");
      if (counter) counter.textContent = `0 of ${MAX_PHOTOS}`;

      renderDropdowns(cfg);
      // Customer + tech selects show "Loading…" until the Firestore fetch
      // below resolves; this keeps the page interactive in every other
      // dimension while the roster is in flight.
      setCustomerLoading();
      setTechLoading();
      renderChecklists(cfg);
      renderRating(cfg);
      renderTimeBudgetReasons(cfg);
      // Phase 1e.2 — fire-and-forget: kick off the linked-session read.
      // Reveals the Time card if the session shows worked > budget + 15.
      // Hidden by default; failure modes leave it hidden (no UX impact).
      loadLinkedPioneerSession();
      wireSegments();
      updateSignatureAttribution();

      els.photos.addEventListener("change", onFileInputChange);
      els.form.addEventListener("submit",  onSubmit);

      // V6 pilot — bind the "Other / leave a note" textarea so its
      // value flows into module state + the draft. Input event keeps
      // the live state in sync; blur ensures a final save on exit.
      const overOtherEl = $("over-budget-other-note");
      if (overOtherEl) {
        overOtherEl.addEventListener("input", function () {
          overBudgetOtherNote = String(overOtherEl.value || "").trim();
          scheduleSaveDraft();
        });
      }

      // V6 pilot regression guard — clicking "Add photos" must NEVER
      // navigate the user away from the DCR form. Symptoms in the
      // wild (Android Chrome, iOS Safari) included the page jumping
      // to /tech.html ("Customer Info Hub") after a label tap —
      // suspected cause was a click event bubbling out of the nested
      // <input> + parent label combo to an ancestor handler. We
      // moved the input OUT of the label (see index.html), and we
      // also stop click propagation on BOTH the file-drop label and
      // the hidden input so no parent listener ever sees the event.
      // We do NOT preventDefault — the browser still needs to open
      // the native file picker.
      //
      // Regression check: tap "Add photos" on the DCR form (mobile +
      // desktop) → file picker opens → URL stays at "/" → after
      // selecting a file, the page does NOT navigate. If this
      // breaks, look for new ancestor click handlers and re-tighten
      // the stopPropagation here.
      const photosLabelEl = document.querySelector('label.file-drop[for="photos"]');
      if (photosLabelEl) {
        photosLabelEl.addEventListener("click", function (ev) {
          ev.stopPropagation();
        });
      }
      els.photos.addEventListener("click", function (ev) {
        ev.stopPropagation();
      });

      // Keep the signature-attribution line in sync as the tech dropdown
      // changes; that name becomes affirmation.signature_name on submit.
      els.tech.addEventListener("change", updateSignatureAttribution);

      // Signature pad — defer one frame so the canvas's CSS-driven width is settled.
      const sigCanvas = $("signature-canvas");
      const sigPadEl  = sigCanvas ? sigCanvas.closest(".signature-pad") : null;
      const sigClear  = $("clear-signature");
      if (sigCanvas) {
        requestAnimationFrame(function () {
          signaturePad = createSignaturePad(sigCanvas, sigPadEl);
        });
      }
      if (sigClear) sigClear.addEventListener("click", function () { if (signaturePad) signaturePad.clear(); });

      const newDcrBtn = $("new-dcr-btn");
      if (newDcrBtn) newDcrBtn.addEventListener("click", onNewDcr);

      const draftClear = $("draft-toast-clear");
      if (draftClear) {
        draftClear.addEventListener("click", function () {
          clearDraft();
          hideDraftToast();
          onNewDcr();
        });
      }

      // Restore draft AFTER all dynamic (static) content is rendered.
      // Customer + tech values can't apply yet (the selects are still
      // showing "Loading…"); the live-roster `.then()` below re-applies
      // them once the Firestore fetch resolves.
      const restored = restoreDraftIfFresh();
      if (restored) showDraftToast();
      // Re-run after restore in case the draft selected a different tech.
      updateSignatureAttribution();

      wireDraftInputs();
      wireValidationCta();

      // Kick off the live customer + tech load. Runs in the background
      // (boot continues without awaiting) so the rest of the form is
      // immediately usable; only Submit is gated on rosterReady.
      loadCustomersAndTechs(staff).then(function () {
        // Now that the selects are populated, restore the draft's
        // customer + tech selection and refresh the signature
        // attribution line.
        reapplyDraftRoster();
        updateSignatureAttribution();
        // If the signed-in user is a cleaning_tech, lock the tech dropdown
        // to their slug. Admins keep full control.
        applyStaffToTechDropdown(staff);
        // Deputy-shift handoff — if the URL carries shift params from
        // Today's Assignments, prefill the customer dropdown and paint
        // the banner. Runs LAST so it overrides any draft selection.
        applyDeputyShiftFromUrl(staff);
      }).catch(function (err) {
        // loadCustomersAndTechs already painted its in-dropdown error.
        // Surface a console hint for debugging.
        console.error("Roster load failed", err);
      });
    }

    // ---- Staff auth gate ----
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
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);
          paintTeamHubUnreadBadge(staff);
          // Mandatory-announcement gate. Blocks until the user marks
          // each unread mandatory announcement read. Resolves silently
          // when there are none. After resolution we re-paint the nav
          // badge so the count drops on the same page load.
          if (window.MANDATORY_ANN && typeof window.MANDATORY_ANN.check === "function") {
            window.MANDATORY_ANN.check(staff).then(function () {
              paintTeamHubUnreadBadge(staff);
            });
          }
          if (!bootedForStaff) {
            bootFormForStaff(staff);
          } else {
            // Already booted (e.g., user re-signed-in after token refresh
            // or signed-out → signed back in within the same session).
            // Just re-apply tech-dropdown lock for the current identity.
            applyStaffToTechDropdown(staff);
          }
        }
      });
    } catch (err) {
      console.error("STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
      const msgEl = $("staff-auth-denied-msg");
      if (msgEl) msgEl.textContent = "Couldn't start the sign-in flow. Hard-reload (Cmd+Shift+R).";
    }
  });
})();
