/* Pioneer DCR Hub — Today's Work workflow module.
 *
 * Mounts the guided shift workflow (Start Work → Complete DCR → Finish
 * Work) inside the DOM section identified by:
 *
 *     #team-hub-assignments-section           (outer card; flipped from hidden on init)
 *       #team-hub-assignments-sub             (status sub-copy)
 *       #team-hub-assignments-loading         (default visible)
 *       #team-hub-assignments-error           (set by setAssignmentsState)
 *       #team-hub-assignments-empty           ("No work scheduled today.")
 *       #team-hub-assignments-list            (cards mount here)
 *
 * Same DOM ids the previous in-Team-Hub implementation used — kept so
 * any external CSS (admin theme, etc.) doesn't need to change.
 *
 * Public API:
 *     window.PIONEER_TODAY_WORK.init(staff)
 *
 * Reads:
 *   - deputy_shift_cache  (filter: sync_date + employee_email; rules enforce
 *                          per-doc tech.email match server-side)
 *   - pioneer_work_sessions  (by doc id == shift_id)
 *
 * Writes (CLIENT-SIDE):
 *   - pioneer_work_sessions/{shift_id} — START + FINISH transitions and
 *     the pioneer_dcr_opened_at stamp before DCR navigation.
 *
 * Does NOT write deputy_shift_cache, DCR submissions, or auth state.
 *
 * Admin preview:
 *   When staff.role === "admin" AND ?work_date=YYYY-MM-DD is on the URL,
 *   the email filter is dropped and ALL shifts for that date are shown
 *   with an "Admin preview" sub-copy. Rules already allow admins to read
 *   the full cache, so no rule change.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Debug logs are off by default. Add ?debug_work=1 to the URL to see
  // the booting / fetched / sessions trace in the browser console.
  // Warnings + errors always fire (they only surface real problems).
  let DEBUG_WORK = false;
  try {
    const dbg = new URLSearchParams(location.search || "").get("debug_work");
    DEBUG_WORK = dbg === "1" || dbg === "true";
  } catch (e) { /* parse failure → debug off */ }
  function logDebug() {
    if (!DEBUG_WORK) return;
    try { console.info.apply(console, arguments); } catch (e) {}
  }
  // V6 pilot — ALWAYS-ON triage log under a single grep-friendly
  // prefix. The verbose object dumps (logDebug above) stay gated by
  // ?debug_work=1, but the structured "shifts query → result" trace
  // ships in every page load so the office can diagnose live without
  // asking the tech to add a URL flag first.
  function logTodayWork(msg, meta) {
    try { console.info("[PioneerOps TodayWork] " + msg, meta || ""); }
    catch (_e) {}
  }
  function warnTodayWork(msg, meta) {
    try { console.warn("[PioneerOps TodayWork] " + msg, meta || ""); }
    catch (_e) {}
  }
  // Pilot v20260526-shiftrestore — explicit [todays-work] lines the
  // office can pattern-match in any tech's console without touching a
  // URL flag. Ships in every page load. Pairs with the diagnostic
  // empty state below so a "no cards" report can be triaged remotely.
  function logTW(msg, meta) {
    try { console.info("[todays-work] " + msg, meta || ""); }
    catch (_e) {}
  }

  // Phase A Deputy launcher — fire-and-forget click log.
  // Writes one doc to employee_action_events per Open-Deputy tap so ops
  // can correlate "I tapped Open Deputy but didn't get to the app" reports
  // against device + surface + shift context. Soft-fails on every error
  // path so a failed write never blocks the anchor navigation. Rules in
  // firestore.rules require staff.uid == request.auth.uid.
  function logDeputyOpenClick(source, extras) {
    try {
      if (!window.firebase || typeof firebase.firestore !== "function") return;
      const staff = workCurrentStaff || {};
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
          try { console.warn("[todays-work] deputy click log failed (non-fatal)", err && err.code); } catch (_e) {}
        });
    } catch (e) {
      try { console.warn("[todays-work] deputy click log threw (non-fatal)", e); } catch (_e) {}
    }
  }

  const DEPUTY_TIMEZONE = "America/Los_Angeles";

  // Pilot v20260526-mobileunlock — once.deputy.com/my is Deputy's stable
  // signed-in landing page (routes to the user's own roster regardless
  // of org). Safer than deep-linking to a specific shift URL that may
  // serve 404 on mobile, and safer than the org-install host which can
  // change. Wrapped as a real <a href> on every work card so the tap
  // is a native navigation, not a JS window.open after async work.
  const DEPUTY_HOME_URL = "https://once.deputy.com/my";

  // Pacific-TZ YYYY-MM-DD — matches server-emitted sync_date.
  function deputyTodayPT() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: DEPUTY_TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  // Firestore Timestamp / Date / ms / ISO → "h:mm AM/PM" or "" missing.
  // Format a duration in milliseconds as "Xh Ym" (or "Ym" when under
  // an hour). Used by the completed-shift card so techs see their
  // logged time at a glance without doing the math.
  function formatDuration(ms) {
    if (!ms || ms < 0) return "";
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 60) return totalMin + "m";
    const h = Math.floor(totalMin / 60);
    const m = totalMin - h * 60;
    return m > 0 ? (h + "h " + m + "m") : (h + "h");
  }

  function formatShiftTime(ts) {
    if (!ts) return "";
    let ms = null;
    if (typeof ts === "number") ms = ts;
    else if (typeof ts === "string") { const t = Date.parse(ts); if (!isNaN(t)) ms = t; }
    else if (ts.toDate && typeof ts.toDate === "function") ms = ts.toDate().getTime();
    else if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    if (ms == null) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: DEPUTY_TIMEZONE,
        hour:   "numeric",
        minute: "2-digit",
        hour12: true
      }).format(new Date(ms));
    } catch (e) { return ""; }
  }

  function shiftSortFn(a, b) {
    function ms(ts) {
      if (!ts) return 0;
      if (ts.toMillis) return ts.toMillis();
      if (typeof ts.seconds === "number") return ts.seconds * 1000;
      if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
      return 0;
    }
    const aMs = ms(a.start_time);
    const bMs = ms(b.start_time);
    if (aMs === bMs) return 0;
    if (aMs === 0)   return 1;
    if (bMs === 0)   return -1;
    return aMs - bMs;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- workflow state machine ---------- */

  const WORK_STATE_NOT_STARTED = "not_started";
  const WORK_STATE_WORKING     = "working";
  const WORK_STATE_NEEDS_FIN   = "needs_finish";
  const WORK_STATE_FINISHED    = "finished";

  /* --------------------------------------------------------------------
   * isShiftOwnedByCurrentUser — single source of truth for "is THIS
   * shift assigned to the signed-in user?"
   *
   * Used by every shift-action gate (Start Work, Finish Work, DCR
   * open) so the same compare logic runs everywhere. Normalizes
   * both sides (trim + lower) so a stray uppercase letter in either
   * Deputy or Auth can't strand a tech.
   *
   * Ownership signals checked, in order:
   *   1. employee_email   (Deputy-side email) === staff.email
   *   2. employee_slug    === staff.tech.slug
   *   3. (fallback) deputy_employee_id present on the tech doc
   *
   * Returns { allowed: boolean, reason: string } so the caller can
   * log + surface a meaningful message instead of a generic deny.
   * ------------------------------------------------------------------ */
  function isShiftOwnedByCurrentUser(shift, staff) {
    if (!shift || !staff) return { allowed: false, reason: "no shift or staff" };
    const myEmail = String(staff.email || "").trim().toLowerCase();
    const mySlug  = String((staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "").trim().toLowerCase();
    const shiftEmail = String(shift.employee_email || "").trim().toLowerCase();
    const shiftSlug  = String(shift.employee_slug  || "").trim().toLowerCase();
    if (myEmail && shiftEmail && myEmail === shiftEmail) {
      return { allowed: true, reason: "email match" };
    }
    if (mySlug && shiftSlug && mySlug === shiftSlug) {
      return { allowed: true, reason: "slug match" };
    }
    return {
      allowed: false,
      reason:  "no email or slug match · my(" + myEmail + "/" + mySlug + ") shift(" + shiftEmail + "/" + shiftSlug + ")"
    };
  }
  // Expose for cross-page use (e.g., DCR open guards on /work.html).
  if (typeof window !== "undefined") {
    window.PioneerShiftOwnership = { isShiftOwnedByCurrentUser: isShiftOwnedByCurrentUser };
  }

  /* --------------------------------------------------------------------
   * Clock reminder — non-blocking bottom card surfaced after Start Work
   * (clock-in reminder) or Finish Work (clock-out reminder).
   *
   * Deputy is the official timeclock; PioneerOps never clocks the tech
   * in or out. The reminder is informational ONLY:
   *
   *   • Real <a href target="_blank"> so iPhone Safari can't block the
   *     navigation as a popup, and so the OS routes to the Deputy app
   *     via universal links when installed.
   *   • Bottom-anchored card — no full-viewport overlay, no body scroll
   *     lock, no focus trap. The page beneath stays interactive.
   *   • Tech can dismiss with "I Already Clocked In" (start) or the ×.
   *   • Auto-fades after 45s as a last-resort cleanup.
   *
   * Phase: "start" → two buttons (Open Deputy App / I Already Clocked In)
   *        "finish" → single Open Deputy App + dismiss ×
   *
   * If anything in here throws, the underlying Start/Finish flow is
   * already complete (PioneerOps work session is written); the reminder
   * is layered on top, never on the critical path.
   * ------------------------------------------------------------------ */
  function showClockReminder(opts) {
    opts = opts || {};
    const phase = opts.phase === "finish" ? "finish" : "start";
    try {
      const existing = document.getElementById("pioneer-clock-reminder");
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

      const card = document.createElement("div");
      card.id = "pioneer-clock-reminder";
      card.className = "pioneer-clock-reminder pioneer-clock-reminder-" + phase;
      card.setAttribute("role", "status");
      card.setAttribute("aria-live", "polite");

      const title = phase === "finish"
        ? "Before you leave"
        : "Clock In Reminder";
      const body  = phase === "finish"
        ? "Please clock out in the Deputy app. Deputy remains the official time clock."
        : "Please open the Deputy app to clock in for your shift. Deputy remains the official time clock.";

      const dismissButton = phase === "start"
        ? '<button type="button" class="pioneer-clock-reminder-btn pioneer-clock-reminder-btn-secondary"' +
          ' data-action="dismiss">I Already Clocked In</button>'
        : '';

      card.innerHTML =
        '<div class="pioneer-clock-reminder-head">' +
          '<strong class="pioneer-clock-reminder-title">' + title + '</strong>' +
          '<button type="button" class="pioneer-clock-reminder-close"' +
            ' data-action="dismiss" aria-label="Dismiss reminder">×</button>' +
        '</div>' +
        '<p class="pioneer-clock-reminder-body">' + body + '</p>' +
        '<div class="pioneer-clock-reminder-actions">' +
          '<a class="pioneer-clock-reminder-btn pioneer-clock-reminder-btn-primary"' +
            ' href="' + DEPUTY_HOME_URL + '"' +
            ' target="_blank" rel="noopener noreferrer"' +
            ' data-action="open-deputy">Open Deputy App</a>' +
          dismissButton +
        '</div>' +
        '<p class="pioneer-clock-reminder-helper">' +
          'Use the Deputy mobile app — sign in once and future taps should open the app automatically. ' +
          'Don’t have it? Install the Deputy app first, then return here.' +
        '</p>';

      function dismiss() {
        if (!card.parentNode) return;
        card.classList.add("is-leaving");
        setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);
        }, 240);
      }

      card.addEventListener("click", function (ev) {
        const action = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-action");
        // The Deputy anchor opens in a new tab; we ALSO dismiss the card
        // a beat later so the user sees the tap registered.
        if (action === "open-deputy") {
          logDeputyOpenClick("clock_in_reminder");
          setTimeout(dismiss, 200);
          return;
        }
        if (action === "dismiss") {
          ev.preventDefault();
          dismiss();
        }
      });

      document.body.appendChild(card);
      // Auto-dismiss long after the natural attention window. Last-resort
      // cleanup so a card never lingers past the workflow.
      setTimeout(dismiss, 45000);
    } catch (e) {
      // Reminder failure must NEVER block Start/Finish.
      try { console.warn("[today's-work] clock reminder failed (non-fatal)", e); } catch (_e) {}
    }
  }

  function resolveWorkState(session) {
    if (!session) return WORK_STATE_NOT_STARTED;
    const s = String(session.status || "").toLowerCase();
    if (s === WORK_STATE_FINISHED)    return WORK_STATE_FINISHED;
    if (s === WORK_STATE_NEEDS_FIN)   return WORK_STATE_NEEDS_FIN;
    if (s === WORK_STATE_WORKING)     return WORK_STATE_WORKING;
    return WORK_STATE_NOT_STARTED;
  }

  // Phase 2 normalization: emit shared .status-chip (ui-chips.css)
  // so chip styling matches the rest of PioneerOps. The legacy
  // .assign-chip class is kept as a secondary so any existing CSS
  // (e.g. third-party themes) that targeted it still has a hook,
  // but visual styling now comes from .status-chip.
  function workStatusChip(state) {
    if (state === WORK_STATE_WORKING)
      return '<span class="status-chip assign-chip is-progress" data-state="in-progress">Working</span>';
    if (state === WORK_STATE_NEEDS_FIN)
      return '<span class="status-chip assign-chip is-progress" data-state="attention">Needs finish</span>';
    if (state === WORK_STATE_FINISHED)
      return '<span class="status-chip assign-chip is-done" data-state="completed">Finished</span>';
    return '<span class="status-chip assign-chip is-scheduled" data-state="not-started">Not started</span>';
  }

  // Tech initial chip for admin-preview cards. Takes the first letter
  // of the display name (or the email's local part) so the operator
  // can see WHO each shift belongs to without reading the footer line.
  // Only used when opts.readOnly is true.
  function techInitialChip(shift) {
    const name  = String(shift.employee_display_name || "").trim();
    const email = String(shift.employee_email || "").trim();
    if (!name && !email) return "";
    const initial = (name || email).charAt(0).toUpperCase() || "?";
    const tooltip = name && email ? (name + " · " + email)
                   : (name || email);
    return (
      '<span class="assign-card-tech-chip" title="' + escapeHtml(tooltip) + '" aria-label="Assigned tech: ' + escapeHtml(tooltip) + '">' +
        '<span class="assign-card-tech-chip-initial" aria-hidden="true">' + escapeHtml(initial) + '</span>' +
        '<span class="assign-card-tech-chip-name">' + escapeHtml(name || email) + '</span>' +
      '</span>'
    );
  }

  function workStepper(state) {
    let s1 = "is-todo", s2 = "is-todo", s3 = "is-todo";
    if (state === WORK_STATE_NOT_STARTED) { s1 = "is-active"; }
    else if (state === WORK_STATE_WORKING)     { s1 = "is-done";   s2 = "is-active"; }
    else if (state === WORK_STATE_NEEDS_FIN)   { s1 = "is-done";   s2 = "is-done";   s3 = "is-active"; }
    else if (state === WORK_STATE_FINISHED)    { s1 = "is-done";   s2 = "is-done";   s3 = "is-done"; }
    return (
      '<ol class="work-stepper" aria-label="Workflow progress">' +
        '<li class="work-step ' + s1 + '"><span class="work-step-num">1</span><span class="work-step-label">Start Work</span></li>' +
        '<li class="work-step ' + s2 + '"><span class="work-step-num">2</span><span class="work-step-label">Complete DCR</span></li>' +
        '<li class="work-step ' + s3 + '"><span class="work-step-num">3</span><span class="work-step-label">Finish Work</span></li>' +
      '</ol>'
    );
  }

  function buildOpenDcrHref(s, opts) {
    function tsIso(ts) {
      if (!ts) return "";
      if (typeof ts === "number")              return new Date(ts).toISOString();
      if (typeof ts === "string")              return ts;
      if (ts.toDate && typeof ts.toDate === "function") return ts.toDate().toISOString();
      if (typeof ts.toMillis === "function")   return new Date(ts.toMillis()).toISOString();
      if (typeof ts.seconds === "number")      return new Date(ts.seconds * 1000).toISOString();
      return "";
    }
    opts = opts || {};
    const params = new URLSearchParams();
    if (s.shift_id)                  params.set("deputy_shift_id",  String(s.shift_id));
    if (opts.pioneer_session_id)     params.set("pioneer_session_id", String(opts.pioneer_session_id));
    if (s.sync_date)                 params.set("sync_date",       String(s.sync_date));
    // Customer pre-fill precedence (only confident sources):
    //   1. Resolved customer_slug/name from sync (rare).
    //   2. HIGH-confidence alias suggestion from sync.
    // When neither exists we pass nothing — the DCR opens with the
    // "Choose the customer you cleaned" label and an empty dropdown,
    // and the tech selects manually. We DO NOT push raw Deputy
    // location names into the DCR field; those would just create
    // false-confidence pre-fills the tech would have to clear.
    if (s.customer_slug) {
      params.set("customer_slug", String(s.customer_slug));
      if (s.customer_name) params.set("customer_name", String(s.customer_name));
    } else if (s.suggested_customer_slug) {
      params.set("customer_slug",   String(s.suggested_customer_slug));
      if (s.suggested_customer_name) params.set("customer_name", String(s.suggested_customer_name));
      params.set("customer_source", "suggested");
    }
    const startIso = tsIso(s.start_time); if (startIso) params.set("scheduled_start", startIso);
    const endIso   = tsIso(s.end_time);   if (endIso)   params.set("scheduled_end",   endIso);
    if (s.deputy_shift_url)          params.set("deputy_shift_url", String(s.deputy_shift_url));
    const qs = params.toString();
    return qs ? ("/?" + qs) : "/";
  }

  // Pre-fill a mailto: to the office with the shift context so a tech
  // who notices wrong timestamps after clock-out can request an
  // adjustment in one tap without re-typing the shift's metadata.
  // We deliberately use mailto: (no client-side write) because the
  // payroll exception engine's tech-side UI is not built yet (the
  // backend Cloud Function exists; surfacing a "Reopen" button would
  // be unsafe without a confirmation flow that doesn't exist).
  function buildAdjustmentMailto(shift, session, customerLabel, scheduledText, clockedInText, clockedOutText, durationText) {
    const staff = workCurrentStaff || {};
    const techName = (staff.tech && staff.tech.display_name) || staff.email || "";
    const date     = shift.sync_date || "";
    const subjectParts = ["Time adjustment request"];
    if (customerLabel && customerLabel !== "Customer not linked yet") subjectParts.push(customerLabel);
    if (date) subjectParts.push(date);
    const subject = subjectParts.join(" — ");
    const body =
      "Hi office team,\n\n" +
      "I need a time adjustment for the following shift:\n\n" +
      "Customer: " + (customerLabel || "Unknown") + "\n" +
      "Date: " + (date || "(unknown)") + "\n" +
      "Scheduled: " + (scheduledText || "(unknown)") + "\n" +
      "Clocked in: " + (clockedInText || "(unknown)") + "\n" +
      "Clocked out: " + (clockedOutText || "(unknown)") + "\n" +
      "Logged duration: " + (durationText || "(unknown)") + "\n\n" +
      "Reason for adjustment:\n" +
      "(please describe what was wrong)\n\n" +
      "Correct times should be:\n" +
      "Start:\n" +
      "End:\n\n" +
      "Thanks,\n" +
      techName;
    return "mailto:info@pioneercomclean.com" +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }

  function workCard(shift, session, opts) {
    opts = opts || {};
    const state    = resolveWorkState(session);
    // Customer display precedence (pilot UX — keep it clean):
    //   1. session.selected_customer_name — tech submitted DCR. Truth.
    //   2. shift.customer_name — sync-resolved via deputy_company_id
    //      (the authoritative path). No "Suggested:" prefix.
    //   3. session.suggested_customer_name OR shift.suggested_customer_name
    //      — alias fallback. "Suggested:" prefix.
    //   4. "Customer not linked yet" placeholder (with sub-line
    //      "Choose customer on DCR") when nothing matched OR the sync
    //      tripped a safety branch (duplicate_mapping / inactive_customer).
    //
    // We never surface raw Deputy operational-unit names ("Cleaning
    // Techs") and never auto-pick when duplicate or inactive flags are
    // set — those are safe-unresolved states the tech handles on DCR.
    const sessionCustomerName   = (session && session.selected_customer_name) || "";
    const suggestedCustomerName = (session && session.suggested_customer_name) ||
                                  shift.suggested_customer_name || "";
    const suggestedSource       = (session && session.suggested_customer_source) ||
                                  shift.suggested_customer_source || "";
    const safeUnresolved        = !!(shift.duplicate_mapping || shift.inactive_customer);

    // Defensive: old cache docs (synced before the hardening) may carry
    // a generic OperationalUnit label like "Cleaning Techs" in
    // customer_name. Treat any of these as empty so the placeholder
    // shows instead of a wrong customer name. The new sync writes
    // empty customer_name when there's no match.
    const GENERIC_CUSTOMER_NAMES = {
      "cleaningtech": 1, "cleaningtechs": 1, "office": 1, "default": 1,
      "main": 1, "shift": 1, "coverage": 1, "floater": 1, "training": 1,
      "pioneer": 1, "pioneercommercialcleaning": 1, "commercialcleaning": 1
    };
    function looksGeneric(name) {
      const k = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      return !!GENERIC_CUSTOMER_NAMES[k];
    }
    const cacheCustomerName = (shift.customer_name && !looksGeneric(shift.customer_name))
                                ? shift.customer_name
                                : "";

    // Deputy company name from the shift, used only on the UNKNOWN
    // header to show "Deputy: <CompanyName>" as context. Never used
    // as the customer label.
    const deputyCompanyName = String(shift.deputy_company_name || "").trim();

    // Apply the canonical display helper when we know the customer's
    // slug AND the matching /customers/{slug} doc is in our cache —
    // that's where `displayNameMode + customDisplayName` live. When the
    // doc isn't available, fall through to the sync-resolved cache
    // string. This preserves the existing precedence while giving the
    // admin the override path for resolved customers.
    function resolveDisplayBySlug(slug) {
      if (!slug || !window.PioneerCustomerDisplay) return "";
      const c = findCustomerBySlug(slug);
      if (!c) return "";
      const label = window.PioneerCustomerDisplay.getCustomerDisplayName(c);
      return label || "";
    }

    let customer;
    let customerKind;   // "selected" | "resolved" | "suggested" | "unknown" | "placeholder"
    if (sessionCustomerName) {
      // Session has the tech-confirmed customer; if its slug is in cache,
      // we can still upgrade to the helper-derived display string.
      const sessionSlug = String((session && session.selected_customer_slug) || "");
      customer = resolveDisplayBySlug(sessionSlug) || sessionCustomerName;
      customerKind = "selected";
    } else if (cacheCustomerName && !safeUnresolved) {
      customer = resolveDisplayBySlug(shift.customer_slug) || cacheCustomerName;
      customerKind = "resolved";
    } else if (suggestedCustomerName && !safeUnresolved) {
      customer = resolveDisplayBySlug(shift.suggested_customer_slug) || suggestedCustomerName;
      customerKind = "suggested";
    } else if (deputyCompanyName) {
      // UNKNOWN state — Deputy sent a company name we can't map to a
      // Pioneer customer. Tech MUST pick before Start Work.
      customer = "UNKNOWN CUSTOMER";
      customerKind = "unknown";
    } else {
      customer = "Customer not linked yet";
      customerKind = "placeholder";
    }
    const customerIsPlaceholder = customerKind === "placeholder";
    const customerIsSuggested   = customerKind === "suggested";
    const customerIsUnknown     = customerKind === "unknown";

    const start = formatShiftTime(shift.start_time);
    const end   = formatShiftTime(shift.end_time);
    const timeText = (start && end) ? (start + " – " + end)
                  : (start || end || "Time TBD");

    // Shift notes — Deputy's roster Comment / Memo, rendered as a
    // small labeled subsection when present. Kept low-key so they
    // inform without screaming for attention.
    const notesRaw = String(shift.instructions || "").trim();
    const instructionsHtml = notesRaw
      ? '<div class="assign-card-notes">' +
          '<span class="assign-card-notes-label">Shift notes</span>' +
          '<p class="assign-card-notes-text">' + escapeHtml(notesRaw) + '</p>' +
        '</div>'
      : "";

    // Quick Notes — top 3 quick_glance items from the customer's SOP
    // (imported from Deputy). Only renders when the shift has a
    // resolved customer_slug AND that customer has a sop block.
    // Access codes are deliberately NOT shown inline — those live
    // behind the "Open in Customer Info Hub" tap-through.
    let quickNotesHtml = "";
    const resolvedSlug =
      (session && session.selected_customer_slug) ||
      shift.customer_slug || "";
    if (resolvedSlug && window.CustomerSop && typeof window.CustomerSop.inlineSummary === "function") {
      const cust = findCustomerBySlug(resolvedSlug);
      if (cust && Array.isArray(cust.sopQuickGlance) && cust.sopQuickGlance.length) {
        const inline = window.CustomerSop.inlineSummary(cust, { max: 3 });
        if (inline) {
          quickNotesHtml =
            '<div class="assign-card-notes assign-card-sop-quick">' +
              '<div class="assign-card-notes-label-row">' +
                '<span class="assign-card-notes-label">Quick notes</span>' +
                '<a class="assign-card-sop-link" href="/tech.html" target="_blank" rel="noopener">' +
                  'View full SOP ↗' +
                '</a>' +
              '</div>' +
              inline +
            '</div>';
        }
      }
    }

    const sessionId = (session && (session.pioneer_session_id || session.id)) ||
                       shift.shift_id || shift.id;

    let ctaHtml    = "";
    let helperText = "";
    let footerHtml = "";

    // Admin-preview mode: the admin is looking at someone else's shifts.
    // Don't expose actionable buttons — the admin shouldn't be creating
    // sessions on a tech's behalf. Render a read-only summary.
    if (opts.readOnly) {
      ctaHtml = '<span class="assign-card-done is-preview"><span aria-hidden="true">👁</span> Admin preview · read-only</span>';
    } else if (state === WORK_STATE_NOT_STARTED && customerIsUnknown) {
      // UNKNOWN-customer guard: tech picks the customer BEFORE the
      // session is created. The Start Work button is disabled until
      // a customer is chosen. On click we write the picked customer
      // straight onto the new session as selected_customer_*.
      const customerPickerOptions = workActiveCustomers
        .map(function (c) {
          return '<option value="' + escapeHtml(c.slug) + '">' + escapeHtml(c.name) + '</option>';
        }).join("");
      ctaHtml =
        '<div class="assign-card-unknown-picker">' +
          '<label class="assign-card-unknown-label" for="ucp-' +
            escapeHtml(shift.shift_id || shift.id) + '">' +
            'Pick the customer you\'re cleaning at this shift:' +
          '</label>' +
          '<select class="assign-card-unknown-select" id="ucp-' +
            escapeHtml(shift.shift_id || shift.id) +
            '" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
            '<option value="">— Pick a customer —</option>' +
            customerPickerOptions +
          '</select>' +
          '<button type="button" class="assign-card-btn is-primary is-disabled"' +
            ' data-action="start-work-unknown"' +
            ' data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '"' +
            ' disabled>Pick customer first</button>' +
        '</div>';
      helperText = "Deputy didn't link this shift to a Pioneer customer. Confirm who you're cleaning to keep the report accurate.";
    } else if (state === WORK_STATE_NOT_STARTED) {
      ctaHtml = '<button type="button" class="assign-card-btn is-primary"' +
                  ' data-action="start-work" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
                  'Start This Shift' +
                '</button>';
      helperText = "Deputy remains the official time clock. We'll show a reminder after you tap Start This Shift.";
    } else if (state === WORK_STATE_WORKING) {
      const dcrHref = buildOpenDcrHref(shift, { pioneer_session_id: sessionId });
      ctaHtml = '<a class="assign-card-btn is-primary"' +
                  ' data-action="complete-dcr"' +
                  ' data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '"' +
                  ' href="' + escapeHtml(dcrHref) + '">' +
                  'Complete DCR' +
                '</a>';
      helperText = "Fill in your DCR for this shift. Clock out in Deputy when you leave.";
    } else if (state === WORK_STATE_NEEDS_FIN) {
      ctaHtml = '<button type="button" class="assign-card-btn is-primary"' +
                  ' data-action="finish-work" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
                  'Finish Work' +
                '</button>';
      helperText = "Deputy remains the official time clock. We'll show a reminder after you tap Finish Work.";
    } else {
      // Finished state — full completion card. Replaces the previous
      // inline "✅ Work completed" pill so techs can tell a finished
      // shift from a not-yet-started one at a glance, and so they have
      // a clear path to fix a wrong time without trying to clock back
      // in. The card shows: clocked-out time, total duration, DCR
      // status, a helper line, and two actions (View Summary expands
      // an inline detail block; Request Time Adjustment opens a
      // mailto: to the office with the shift pre-filled).
      const startedAt   = session && session.pioneer_started_at;
      const finishedAt  = session && session.pioneer_finished_at;
      const dcrId       = session && session.dcr_submission_id;
      const finishedFmt = formatShiftTime(finishedAt);
      const startedFmt  = formatShiftTime(startedAt);
      const startMs     = tsToMs(startedAt);
      const finishMs    = tsToMs(finishedAt);
      const durationMs  = (startMs > 0 && finishMs > startMs) ? (finishMs - startMs) : 0;
      const durationStr = formatDuration(durationMs);

      const dcrPill = dcrId
        ? '<span class="assign-card-completed-pill is-ok">DCR submitted · <code>' + escapeHtml(dcrId) + '</code></span>'
        : '<span class="assign-card-completed-pill is-warn">DCR missing</span>';

      const adjustmentHref = buildAdjustmentMailto(shift, session, customer, timeText, startedFmt, finishedFmt, durationStr);

      ctaHtml =
        '<div class="assign-card-completed">' +
          '<div class="assign-card-completed-banner">' +
            '<span aria-hidden="true">✅</span> Shift Completed' +
          '</div>' +
          '<div class="assign-card-completed-grid">' +
            (finishedFmt
              ? '<div class="assign-card-completed-row">' +
                  '<span class="assign-card-completed-label">Clocked out at</span> ' +
                  '<strong>' + escapeHtml(finishedFmt) + '</strong>' +
                '</div>'
              : '') +
            (durationStr
              ? '<div class="assign-card-completed-row">' +
                  '<span class="assign-card-completed-label">Total time</span> ' +
                  '<strong>' + escapeHtml(durationStr) + '</strong>' +
                '</div>'
              : '') +
            '<div class="assign-card-completed-row">' + dcrPill + '</div>' +
          '</div>' +
          '<p class="assign-card-completed-help">' +
            'Your shift is complete. If your time looks wrong, request an adjustment instead of clocking in again.' +
          '</p>' +
          '<div class="assign-card-completed-actions">' +
            '<button type="button" class="assign-card-btn is-secondary"' +
              ' data-action="view-summary"' +
              ' data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '"' +
              ' aria-expanded="false">View Summary</button>' +
            '<a class="assign-card-btn is-secondary"' +
              ' href="' + adjustmentHref + '"' +
              ' data-action="request-adjustment"' +
              ' data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
              'Request Time Adjustment' +
            '</a>' +
          '</div>' +
          '<div class="assign-card-completed-summary"' +
            ' data-summary-for="' + escapeHtml(shift.shift_id || shift.id) + '"' +
            ' hidden>' +
            '<dl class="assign-card-summary-dl">' +
              '<dt>Scheduled</dt><dd>' + escapeHtml(timeText) + '</dd>' +
              (startedFmt ? '<dt>Clocked in</dt><dd>' + escapeHtml(startedFmt) + '</dd>' : '') +
              (finishedFmt ? '<dt>Clocked out</dt><dd>' + escapeHtml(finishedFmt) + '</dd>' : '') +
              (durationStr ? '<dt>Logged duration</dt><dd>' + escapeHtml(durationStr) + '</dd>' : '') +
              '<dt>Customer</dt><dd>' + escapeHtml(customer) + '</dd>' +
            '</dl>' +
          '</div>' +
        '</div>';
      helperText = "";
    }

    // In admin preview, the tech identity now lives in a small chip
    // at the top-right of the card header (see techInitialChip below).
    // Keeping `ownerLine` for two reasons: (1) sketches a fallback if
    // the chip ever has to be hidden on narrow widths via CSS, and
    // (2) downstream pages/tests grepping for the footer label keep
    // working. In v1 we emit the chip in the header and leave the
    // footer empty so we don't double-print the same info.
    const ownerLine = "";

    // Phase 1b.3 — show a small badge if this Deputy shift maps to the
    // active Pioneer Time Clock session for the signed-in tech. Match
    // is conservative (customer_slug + sync_date) so we never imply a
    // cross-tech relationship. Display-only — no writes from here.
    let pioneerBadgeHtml = "";
    if (pioneerActiveSession) {
      const shiftCustSlug = String(shift.customer_slug || shift.suggested_customer_slug || "").toLowerCase().trim();
      const shiftDate     = String(shift.sync_date || "").trim();
      const sessCustSlug  = String(pioneerActiveSession.customer_id || "").toLowerCase().trim();
      const sessDate      = String(pioneerActiveSession.service_date || "").trim();
      if (shiftCustSlug && shiftDate && shiftCustSlug === sessCustSlug && shiftDate === sessDate) {
        pioneerBadgeHtml =
          '<div class="assign-card-pioneer-badge" title="Pioneer Time Clock is tracking this stop">' +
            '⏱ Clocked in with Pioneer Time Clock' +
          '</div>';
      }
    }

    return (
      '<article class="assign-card work-card is-state-' + state + '"' +
        (opts.readOnly ? ' data-preview="true"' : '') +
        ' role="listitem" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
        pioneerBadgeHtml +
        '<header class="assign-card-head">' +
          '<div class="assign-card-customer">' +
            '<span class="assign-card-name' +
              (customerIsPlaceholder ? ' is-placeholder' : '') +
              (customerIsSuggested   ? ' is-suggested'   : '') +
              (customerIsUnknown     ? ' is-unknown'     : '') + '"' +
              (customerIsSuggested && suggestedSource
                ? ' title="Suggested from Deputy schedule (' + escapeHtml(suggestedSource) + ') — confirm on DCR"'
                : '') + '>' +
              (customerIsSuggested
                ? '<span class="assign-card-suggested-label">Suggested: </span>'
                : '') +
              escapeHtml(customer) +
            '</span>' +
            (customerIsPlaceholder
              ? '<span class="assign-card-loc">Choose customer on DCR</span>'
              : '') +
            (customerIsUnknown
              ? '<span class="assign-card-loc">Deputy: ' + escapeHtml(deputyCompanyName) + '</span>'
              : '') +
            // Show physical location only when present, not redundant
            // with customer name, and not in a placeholder/unknown
            // state. Helps techs who have multiple shifts at the same
            // customer (different floors, buildings, etc.) confirm
            // which one they're starting.
            (!customerIsPlaceholder && !customerIsUnknown && shift.location_name
              && String(shift.location_name).trim()
              && String(shift.location_name).trim().toLowerCase() !== String(customer).toLowerCase()
              ? '<span class="assign-card-loc is-physical-location">📍 ' + escapeHtml(String(shift.location_name).trim()) + '</span>'
              : '') +
          '</div>' +
          workStatusChip(state) +
          // Admin-preview only: tech identity chip in the header.
          (opts.readOnly ? techInitialChip(shift) : "") +
        '</header>' +
        '<div class="assign-card-time">' +
          '<span class="assign-card-time-icon" aria-hidden="true">🕘</span>' +
          '<span class="assign-card-time-text">' + escapeHtml(timeText) + '</span>' +
        '</div>' +
        instructionsHtml +
        quickNotesHtml +
        workStepper(state) +
        '<div class="assign-card-actions">' + ctaHtml + '</div>' +
        (helperText ? '<p class="assign-card-helper">' + escapeHtml(helperText) + '</p>' : '') +
        // Persistent inline Deputy link as a backup affordance. Real
        // anchor so iPhone Safari can't block it as a popup; the OS
        // routes to the Deputy app via universal links when installed,
        // else falls back to once.deputy.com/my. Deputy remains the
        // official timeclock — PioneerOps never claims to clock the tech.
        // data-action="open-deputy" lets the list-level delegated handler
        // fire-and-forget a click log (Phase A) without preventDefault.
        '<a class="assign-card-deputy-link" href="' + DEPUTY_HOME_URL + '"' +
          ' target="_blank" rel="noopener noreferrer"' +
          ' data-action="open-deputy"' +
          ' data-shift-id="' + escapeHtml(String(shift.shift_id || "")) + '">' +
          'Open Deputy App ↗' +
        '</a>' +
        '<p class="assign-card-deputy-helper">' +
          'Use the Deputy mobile app — sign in once and future taps should open the app automatically. ' +
          'Don’t have it? Install the Deputy app first, then return here.' +
        '</p>' +
        footerHtml +
        ownerLine +
      '</article>'
    );
  }

  /* ---------- module state ---------- */

  let workShiftsByShiftId  = {};
  let workSessionByShiftId = {};
  let workCurrentStaff     = null;
  // Phase 1b.3 — read-only mirror of active_service_sessions/{uid} so a
  // Deputy card can show a "Clocked in with Pioneer Time Clock" badge
  // when the legacy shift maps to the same customer + date as the
  // active Pioneer session. Match is conservative (customer_slug +
  // service_date) to avoid cross-tech writes — we never mutate the
  // Pioneer side from here, this is display only.
  let pioneerActiveSession = null;
  // V6 — Today's Work runs in one of two role modes:
  //   "tech"  — current user is a cleaning tech. Personal view; query
  //              gated by employee_email == auth email.
  //   "admin" — current user is admin / manager / office-manager. Sees
  //              every shift for the day company-wide. Their OWN shifts
  //              (if any) are still actionable via Start/End. Other
  //              techs' shifts are read-only — rules also enforce this
  //              server-side via the pioneer_work_sessions tech_email
  //              check.
  // `workIsAdmin` is true ONLY when staff.role === "admin" (the server
  // returns "admin" for every admin/manager flavour). Cleaning techs
  // keep the existing narrow path so they never see anyone else's data.
  let workIsAdmin          = false;
  let workIsAdminPreview   = false;
  // Active Pioneer customers — loaded once on tab activation. Used to
  // power the inline customer picker that appears on UNKNOWN cards so
  // techs can confirm the customer before Start Work creates a session.
  let workActiveCustomers  = [];
  // Phase 2 normalization state. The filter is purely cosmetic — it
  // changes which cards render, not what data is loaded. KPI counts
  // always reflect the full day (so the tile values don't shrink to
  // match the filter selection).
  let workCurrentFilter    = "all";
  // Track which filter buttons we've already wired. The renderer is
  // called repeatedly and we only want to attach the click listener once.
  let workFilterWired      = false;

  /* ---------- shift classification (used by filter + KPIs) ----------
     Returns one of: "not_started" | "in_progress" | "completed" | "unassigned".
     "Unassigned" is a CUSTOMER-side state — a shift Deputy posted whose
     customer Pioneer can't safely resolve (no slug, suggestion blocked
     by duplicate/inactive mapping, or just a generic OperationalUnit
     name). Unassigned takes precedence over not_started so the filter
     pill counts surface the riskiest shifts. */
  function classifyShiftForFilter(shift, session) {
    const sessionCustomerName = (session && session.selected_customer_name) || "";
    const suggestedCustomerName =
      (session && session.suggested_customer_name) ||
      shift.suggested_customer_name || "";
    const safeUnresolved = !!(shift.duplicate_mapping || shift.inactive_customer);
    const GENERIC = {
      "cleaningtech": 1, "cleaningtechs": 1, "office": 1, "default": 1,
      "main": 1, "shift": 1, "coverage": 1, "floater": 1, "training": 1,
      "pioneer": 1, "pioneercommercialcleaning": 1, "commercialcleaning": 1
    };
    const cacheName = String(shift.customer_name || "");
    const cacheKey  = cacheName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const cacheCustomerOk = cacheName && !GENERIC[cacheKey] && !safeUnresolved;
    const hasCustomer = !!(
      sessionCustomerName ||
      cacheCustomerOk ||
      (suggestedCustomerName && !safeUnresolved)
    );
    if (!hasCustomer) return "unassigned";
    const state = resolveWorkState(session);
    if (state === WORK_STATE_FINISHED)  return "completed";
    if (state === WORK_STATE_WORKING ||
        state === WORK_STATE_NEEDS_FIN) return "in_progress";
    return "not_started";
  }

  function shiftMatchesFilter(shift, session, filter) {
    if (filter === "all") return true;
    // V6 — "mine" matches shifts where employee_email equals the
    // current admin user's email. Cleaning techs never trigger this
    // filter (it's hidden in their UI), but the comparison is safe
    // either way: a tech's full shift set is already their own.
    if (filter === "mine") {
      const myEmail = String(
        (workCurrentStaff && workCurrentStaff.email) || ""
      ).toLowerCase().trim();
      if (!myEmail) return false;
      return String(shift.employee_email || "").toLowerCase().trim() === myEmail;
    }
    return classifyShiftForFilter(shift, session) === filter;
  }

  /* ---------- KPI + Day Health computation ---------- */

  function computeDaySnapshot() {
    const shifts = Object.keys(workShiftsByShiftId).map(function (id) {
      return workShiftsByShiftId[id];
    });
    const total = shifts.length;
    let notStarted = 0, inProgress = 0, completed = 0, unassigned = 0;
    let hoursMs = 0;
    const techSet = new Set();
    shifts.forEach(function (s) {
      const sess = workSessionByShiftId[String(s.shift_id || s.id)] || null;
      const cls  = classifyShiftForFilter(s, sess);
      if (cls === "not_started") notStarted += 1;
      else if (cls === "in_progress") inProgress += 1;
      else if (cls === "completed") completed += 1;
      else if (cls === "unassigned") unassigned += 1;
      // Hours: sum of (end - start) when both timestamps are present.
      const startMs = tsToMs(s.start_time);
      const endMs   = tsToMs(s.end_time);
      if (startMs && endMs && endMs > startMs) {
        hoursMs += (endMs - startMs);
      }
      const email = String(s.employee_email || "").toLowerCase().trim();
      if (email) techSet.add(email);
    });
    return {
      total:      total,
      notStarted: notStarted,
      inProgress: inProgress,
      completed:  completed,
      unassigned: unassigned,
      hours:      hoursMs / 3600000,
      techsOn:    techSet.size
    };
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    if (ts.toMillis) return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function formatHours(h) {
    if (!h || isNaN(h)) return "0h";
    if (h < 0.1) return "0h";
    // Show one decimal under 10h, whole hours above. Use h+m for sub-hour.
    if (h < 1)   return Math.round(h * 60) + "m";
    if (h < 10)  return h.toFixed(1) + "h";
    return Math.round(h) + "h";
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setKpiTone(cardSelector, tone) {
    const el = document.querySelector(cardSelector);
    if (el) el.setAttribute("data-tone", tone);
  }

  function paintKpiStrip(snap) {
    if (snap.total === 0) {
      // Day is empty — show "—" not "0" so the strip looks resting,
      // not failed. The empty-state below will explain.
      setText("work-kpi-shifts",        "—");
      setText("work-kpi-shifts-meta",   "Scheduled");
      setText("work-kpi-hours",         "—");
      setText("work-kpi-techs",         "—");
      setText("work-kpi-not-started",   "—");
      setText("work-kpi-progress-done", "—");
      return;
    }
    setText("work-kpi-shifts",       String(snap.total));
    // Real meta now (was a noop ternary): pluralizes the noun + reflects
    // the running state so techs reading the strip get a sense of where
    // the day is.
    setText("work-kpi-shifts-meta",
            snap.completed === snap.total
              ? (snap.total === 1 ? "Scheduled · wrapped" : "All wrapped")
              : (snap.notStarted === snap.total ? "Scheduled · awaiting"
                                                : "Scheduled · in motion"));
    setText("work-kpi-hours",        formatHours(snap.hours));
    setText("work-kpi-techs",        String(snap.techsOn || 0));
    // Tech mode always shows techsOn=1 (just the signed-in user). Tweak
    // the meta line so it doesn't look like a stat — admin-preview keeps
    // the plural "Distinct employees" label.
    setText("work-kpi-techs-meta",
            (snap.techsOn || 0) === 1 ? "On the schedule" : "Distinct employees");
    setText("work-kpi-not-started",  String(snap.notStarted));
    setText("work-kpi-progress-done",
            String(snap.inProgress) + " / " + String(snap.completed));

    // Subtle left-rail tones — only paint a tone when the tile carries
    // an operational signal. Plain count tiles stay neutral.
    setKpiTone('#work-kpi-not-started',   snap.notStarted > 0 ? "attention" : "positive");
    setKpiTone('#work-kpi-progress-done',
               snap.completed === snap.total      ? "positive"   :
               snap.inProgress > 0                ? "info"       : "neutral");
  }

  function paintDayHealth(snap) {
    const card = document.getElementById("work-day-health");
    if (!card) return;
    if (snap.total === 0) {
      // Resting state. Don't show health card at all when there are
      // no shifts — the empty-state tile below carries the message.
      card.hidden = true;
      return;
    }
    card.hidden = false;
    let status, title, summary;
    if (snap.unassigned > 0) {
      status  = "attention";
      title   = snap.unassigned === 1
                  ? "1 shift needs a customer."
                  : (snap.unassigned + " shifts need a customer.");
      summary = "Pick the customer on each unassigned card before starting work.";
    } else if (snap.completed === snap.total) {
      status  = "healthy";
      title   = "Day's wrapped up. Nicely done.";
      summary = snap.total === 1
                  ? "Shift complete and DCR submitted."
                  : "All " + snap.total + " shifts complete and DCRs submitted.";
    } else if (snap.notStarted === snap.total) {
      status  = "healthy";
      title   = snap.total === 1 ? "Shift ready to start." : (snap.total + " shifts queued.");
      summary = "Open each card to Start Work when you arrive on site.";
    } else {
      status  = "healthy";
      title   = "Day is on track.";
      summary = snap.inProgress + " in progress · " + snap.notStarted + " to start · " + snap.completed + " finished.";
    }
    card.setAttribute("data-status", status);
    setText("work-day-health-title",   title);
    setText("work-day-health-summary", summary);

    // Checklist states.
    const liStarted = document.getElementById("work-day-health-li-started");
    const liAssign  = document.getElementById("work-day-health-li-assigned");
    const liWrap    = document.getElementById("work-day-health-li-wrapped");
    if (liStarted) {
      liStarted.setAttribute("data-state", snap.notStarted === 0 ? "ok" : "watch");
      liStarted.textContent = snap.notStarted === 0
        ? "All shifts started"
        : (snap.notStarted + " yet to start");
    }
    if (liAssign) {
      liAssign.setAttribute("data-state", snap.unassigned === 0 ? "ok" : "watch");
      liAssign.textContent = snap.unassigned === 0
        ? "All customers assigned"
        : (snap.unassigned + " unassigned");
    }
    if (liWrap) {
      const allDone = snap.completed === snap.total;
      liWrap.setAttribute("data-state", allDone ? "ok" : "muted");
      liWrap.textContent = allDone
        ? "All work wrapped up"
        : (snap.completed + " of " + snap.total + " complete");
    }

    const foot = document.getElementById("work-day-health-foot-right");
    if (foot) foot.textContent = formatHours(snap.hours) + " scheduled";
  }

  function paintFilterCounts(snap) {
    setText("work-filter-count-all",         String(snap.total));
    setText("work-filter-count-not_started", String(snap.notStarted));
    setText("work-filter-count-in_progress", String(snap.inProgress));
    setText("work-filter-count-completed",   String(snap.completed));
    setText("work-filter-count-unassigned",  String(snap.unassigned));
    // V6 — "mine" count + visibility. Pill is HTML-hidden by default;
    // unhide for admins. Count is the number of shifts where the
    // admin's own email matches employee_email. Always painted so
    // the count stays current as Start/End sessions mutate state.
    const mineEl  = document.getElementById("work-filter-count-mine");
    const mineBtn = document.querySelector('#work-filter .work-filter-btn[data-filter="mine"]');
    if (mineBtn) mineBtn.hidden = !workIsAdmin;
    if (mineEl) {
      const myEmail = String(
        (workCurrentStaff && workCurrentStaff.email) || ""
      ).toLowerCase().trim();
      let mine = 0;
      Object.keys(workShiftsByShiftId).forEach(function (k) {
        const s = workShiftsByShiftId[k];
        if (String(s.employee_email || "").toLowerCase().trim() === myEmail) mine += 1;
      });
      mineEl.textContent = String(mine);
    }

    // Phase 3 polish: surface a subtle "has-items" hint on the two
    // attention-worthy filter pills (Not Started, Unassigned). It's
    // not the same as "is-active" (selection) — it's a quiet visual
    // signal that those buckets are non-empty so the tech notices
    // without having to scan the count numbers.
    function setHasItems(filter, has) {
      const btn = document.querySelector(
        '#work-filter .work-filter-btn[data-filter="' + filter + '"]'
      );
      if (!btn) return;
      btn.classList.toggle("has-items", has);
    }
    setHasItems("not_started", snap.notStarted > 0);
    setHasItems("unassigned",  snap.unassigned  > 0);
  }

  // Phase 3 polish: filter-aware copy for the "filtered to zero" tile.
  // Each filter has its own tone — Completed/finished feels good,
  // Unassigned feels calmer, etc. Keeps the page from reading as
  // "broken" when the user just picked a filter with no matches.
  function filterEmptyCopyFor(filter) {
    if (filter === "mine") return {
      title: "No shifts assigned to you today",
      body:  "Other shifts on the roster are still visible — tap All to switch back to the company view."
    };
    if (filter === "not_started") return {
      title: "Nothing waiting to start",
      body:  "Every shift is either in progress or wrapped. Nice rhythm."
    };
    if (filter === "in_progress") return {
      title: "No shifts in progress right now",
      body:  "Either you haven't started yet, or everything's already wrapped."
    };
    if (filter === "completed") return {
      title: "No shifts wrapped yet",
      body:  "Once you Finish Work on a card, it'll move into this filter."
    };
    if (filter === "unassigned") return {
      title: "Every shift has a customer 🎉",
      body:  "No unmatched shifts today — DCRs will land on the right customer."
    };
    return {
      title: "No shifts match that filter",
      body:  "Try a different filter, or tap All to see every shift."
    };
  }

  function paintFilterActive() {
    const buttons = document.querySelectorAll("#work-filter .work-filter-btn");
    buttons.forEach(function (b) {
      const isActive = b.dataset.filter === workCurrentFilter;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  function wireFilterBar() {
    if (workFilterWired) return;
    const bar = document.getElementById("work-filter");
    if (!bar) return;
    bar.addEventListener("click", function (ev) {
      const btn = ev.target.closest(".work-filter-btn");
      if (!btn) return;
      const next = btn.dataset.filter || "all";
      if (next === workCurrentFilter) return;
      workCurrentFilter = next;
      paintFilterActive();
      renderWorkCards();
    });
    workFilterWired = true;
  }

  /* ---------- panel state helpers ---------- */

  function setAssignmentsState(state, msg) {
    const loadEl  = $("team-hub-assignments-loading");
    const errEl   = $("team-hub-assignments-error");
    const emptyEl = $("team-hub-assignments-empty");
    const listEl  = $("team-hub-assignments-list");
    if (loadEl)  loadEl.hidden  = state !== "loading";
    if (errEl)   errEl.hidden   = state !== "error";
    if (emptyEl) emptyEl.hidden = state !== "empty";
    if (listEl)  listEl.hidden  = state !== "list";
    if (state === "error" && errEl && msg) errEl.textContent = msg;
  }

  // V6 pilot — populate the empty-state diagnostic block. Visible to:
  //   • admins (always — they need to triage regardless of URL flags)
  //   • techs when ?debug_work=1 is on the URL
  // Renders a compact dl of the signals the office needs to debug
  // "shifts not showing": email queried, sync_date, tech mapping,
  // rules error (when set). Calm tone — this is information, not
  // an error banner.
  function populateEmptyDiag(ctx) {
    const el = $("team-hub-assignments-empty-diag");
    if (!el) return;
    const isAdmin = ctx.staff && ctx.staff.role === "admin";

    function safe(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Pilot v20260526-shiftrestore — techs ALSO get a minimal "current
    // login + window queried" block by default, so a no-cards report
    // can be triaged remotely without asking the tech to add ?debug_work=1.
    // The fuller triage rows (rules error, tech mapping, etc.) stay
    // admin/debug-only so a real slow day still reads calmly for the tech.
    if (!isAdmin && !DEBUG_WORK) {
      const techRows = [
        ["Current login",    safe(ctx.email || "(none)")],
        ["Looked up date",   safe(ctx.queryDate) + " <em>(Pacific TZ)</em>"],
        ["Shifts in cache",  String(ctx.rawShiftsCount || 0)]
      ];
      el.classList.remove("team-hub-empty-diag-bad");
      el.innerHTML =
        '<div class="team-hub-empty-diag-title">What we checked</div>' +
        '<dl>' +
          techRows.map(function (r) {
            return '<dt>' + safe(r[0]) + '</dt><dd>' + r[1] + '</dd>';
          }).join("") +
        '</dl>' +
        '<p class="team-hub-empty-diag-hint">If you expected a shift, refresh in a minute, or text <strong>Kirby</strong> or <strong>Nick</strong> and share the email above.</p>';
      el.hidden = false;
      return;
    }
    const techMappingMissing = !ctx.techSlug && !ctx.techDisplayName;
    const rows = [];
    rows.push(["Queried email",     safe(ctx.email || "(missing)")]);
    rows.push(["sync_date",         safe(ctx.queryDate) + " <em>(Pacific TZ; matches server)</em>"]);
    rows.push(["Tech slug",         safe(ctx.techSlug || "(not resolved)")]);
    rows.push(["Tech display name", safe(ctx.techDisplayName || "(blank)")]);
    rows.push(["Mode",              ctx.isAdminAllView ? "admin overview (no email filter)" : "tech email match"]);
    rows.push(["Date override",     ctx.dateOverride ? "yes (?work_date=…)" : "no"]);
    rows.push(["Raw docs returned", String(ctx.rawShiftsCount || 0)]);
    if (ctx.cancelledCount > 0) {
      rows.push(["Cancelled (filtered)", String(ctx.cancelledCount)]);
    }
    if (ctx.rulesError) {
      rows.push(["Rules / read error",  safe(ctx.rulesError)]);
    }

    const hints = [];
    if (ctx.rulesError) {
      hints.push("Read was blocked by Firestore rules — the auth email above didn't match any shift's <code>employee_email</code>.");
    } else if (techMappingMissing && !ctx.isAdminAllView) {
      hints.push("This Pioneer user doesn't have a <code>cleaning_techs/{slug}</code> link. Wire <code>deputy_employee_id</code> or <code>deputy_employee_email</code> in the admin Cleaning Techs tab so the next Deputy sync writes <code>employee_email</code> to match this user's Auth email.");
    } else if (ctx.rawShiftsCount === 0 && ctx.isAdminAllView) {
      hints.push("Admin overview returned zero docs — the <code>deputy_shift_cache</code> collection is truly empty for <code>" + safe(ctx.queryDate) + "</code>. Likely the daily Deputy sync hasn't run; try the admin <code>refreshDeputyShiftsV1</code> Cloud Function and re-load.");
    } else if (ctx.rawShiftsCount === 0) {
      hints.push("Cache is empty for <code>" + safe(ctx.queryDate) + "</code>. Either there really are no Deputy shifts today, OR the daily sync hasn't run / didn't match this tech. Try the admin <code>refreshDeputyShiftsV1</code> Cloud Function and re-load.");
    } else {
      hints.push("All shifts returned were cancelled. The day's roster cleared out — confirm in Deputy.");
    }
    hints.push("Add <code>?debug_work=1</code> for verbose console output prefixed with <code>[today's-work]</code>.");

    const isBad = !!(ctx.rulesError || techMappingMissing);
    el.classList.toggle("team-hub-empty-diag-bad", isBad);
    el.innerHTML =
      '<div class="team-hub-empty-diag-title">' +
        (isBad ? "Triage signals" : "Diagnostic signals") +
      '</div>' +
      '<dl>' +
        rows.map(function (r) {
          return '<dt>' + safe(r[0]) + '</dt><dd>' + r[1] + '</dd>';
        }).join("") +
      '</dl>' +
      '<p class="team-hub-empty-diag-hint">' + hints.join(" ") + '</p>';
    el.hidden = false;
  }

  function renderWorkCards() {
    const listEl = $("team-hub-assignments-list");
    if (!listEl) return;

    // Compute the day snapshot first — KPIs + Day Health + filter
    // counts ALWAYS reflect the full day, regardless of the user's
    // filter selection. The filter only affects which CARDS render.
    const snap = computeDaySnapshot();
    paintKpiStrip(snap);
    paintDayHealth(snap);
    paintFilterCounts(snap);
    paintFilterActive();

    // Show/hide the KPI strip + filter row based on whether there's
    // anything to render. With zero shifts the empty-state alone is
    // friendlier than an empty strip + a row of zero counts.
    const stripEl  = document.getElementById("work-kpi-strip");
    const filterEl = document.getElementById("work-filter");
    if (stripEl)  stripEl.hidden  = snap.total === 0;
    if (filterEl) filterEl.hidden = snap.total === 0;

    const visible = Object.keys(workShiftsByShiftId)
      .map(function (id) { return workShiftsByShiftId[id]; })
      .sort(shiftSortFn);
    if (visible.length === 0) {
      // V6 — swap the empty-state copy for admin overview vs tech view.
      // Admin sees "No Deputy shifts company-wide" only when the day
      // genuinely has zero shifts (the query is unfiltered). Tech
      // sees the original "No work scheduled today" — that's about
      // THEM specifically.
      const emptyTitleEl = document.querySelector('#team-hub-assignments-empty .empty-state-title');
      const emptyBodyEl  = document.querySelector('#team-hub-assignments-empty .empty-state-body');
      if (emptyTitleEl && emptyBodyEl) {
        if (workIsAdmin) {
          emptyTitleEl.textContent = "No Deputy shifts on the roster today";
          emptyBodyEl.textContent  = "Nothing has been posted in Deputy for today across any tech. Once shifts land they'll appear here.";
        } else {
          emptyTitleEl.textContent = "No shifts found for your account today";
          emptyBodyEl.textContent  = "If you expected one, refresh in a minute. If it still doesn't show up, text Kirby or Nick.";
        }
      }
      // Pilot v20260526-shiftrestore — always show the signed-in email
      // under the empty state, so the office can confirm the tech is
      // logged into the right account at a glance.
      const loginLineEl = document.getElementById("team-hub-empty-current-login-line");
      const loginEmailEl = document.getElementById("team-hub-empty-current-login");
      if (loginLineEl && loginEmailEl) {
        const emailNow = String((workCurrentStaff && workCurrentStaff.email) || "").trim();
        loginEmailEl.textContent = emailNow || "(not signed in)";
        loginLineEl.hidden = false;
      }
      logTW("render → empty state", {
        current_user_email: (workCurrentStaff && workCurrentStaff.email) || "(none)",
        admin_mode:         workIsAdmin
      });
      setAssignmentsState("empty");
      listEl.innerHTML = "";
      return;
    }

    // Apply the filter — full set first, then trimmed.
    const displayed = visible.filter(function (shift) {
      const sess = workSessionByShiftId[String(shift.shift_id || shift.id)] || null;
      return shiftMatchesFilter(shift, sess, workCurrentFilter);
    });
    // V6 — per-card readOnly. A shift is actionable only when it
    // belongs to the current user. Cleaning techs always pass this
    // check (the query already gated them to their own shifts).
    // Admins viewing OTHER techs' shifts get a read-only card —
    // Start/Finish buttons suppressed. (The server rule on
    // pioneer_work_sessions also rejects cross-tech writes, so this
    // is defense in depth, not the only gate.)
    const myEmailForCard = String(
      (workCurrentStaff && workCurrentStaff.email) || ""
    ).toLowerCase().trim();

    const filterEmptyEl = document.getElementById("team-hub-assignments-filter-empty");
    if (displayed.length === 0 && visible.length > 0) {
      // Filtered to zero — show the calm filter-specific empty state
      // and keep the underlying section in "list" state so the KPI
      // strip + filter row stay visible. Copy is filter-aware so the
      // tech reads it as "the day is in a good place" not "broken".
      listEl.innerHTML = "";
      if (filterEmptyEl) {
        const titleEl = document.getElementById("team-hub-assignments-filter-empty-title");
        const bodyEl  = filterEmptyEl.querySelector(".empty-state-body");
        const copy = filterEmptyCopyFor(workCurrentFilter);
        if (titleEl) titleEl.textContent = copy.title;
        if (bodyEl)  bodyEl.textContent  = copy.body;
        filterEmptyEl.hidden = false;
      }
      setAssignmentsState("list");
      return;
    }
    if (filterEmptyEl) filterEmptyEl.hidden = true;

    listEl.innerHTML = displayed.map(function (shift) {
      const shiftEmail = String(shift.employee_email || "").toLowerCase().trim();
      const isOwnShift = !workIsAdmin || (myEmailForCard && shiftEmail === myEmailForCard);
      const opts = { readOnly: !isOwnShift };
      return workCard(shift, workSessionByShiftId[String(shift.shift_id || shift.id)] || null, opts);
    }).join("");
    logTW("render → list state", {
      current_user_email: myEmailForCard || "(none)",
      visible_count:      visible.length,
      displayed_count:    displayed.length,
      active_filter:      workCurrentFilter,
      visible_shift_ids:  visible.map(function (s) { return String(s.shift_id || s.id); }),
      displayed_shift_ids: displayed.map(function (s) { return String(s.shift_id || s.id); })
    });
    setAssignmentsState("list");
  }

  /* ---------- Firestore reads ---------- */

  // Doc id == deputy_shift_id. Batch via __name__ in chunks of 10.
  async function loadSessionsFor(shiftIds) {
    if (!shiftIds.length) return {};
    const db = firebase.firestore();
    const out = {};
    for (let i = 0; i < shiftIds.length; i += 10) {
      const chunk = shiftIds.slice(i, i + 10);
      try {
        const snap = await db.collection("pioneer_work_sessions")
          .where(firebase.firestore.FieldPath.documentId(), "in", chunk.map(String))
          .get();
        snap.docs.forEach(function (d) {
          out[d.id] = Object.assign({ id: d.id }, d.data());
        });
      } catch (err) {
        // Rules deny session reads for sessions whose tech_email != my
        // auth email (or for non-admins outside admin-preview). Either
        // way, soft-fail the chunk.
        console.warn("[today's-work] loadSessionsFor chunk failed", err && err.code, chunk);
      }
    }
    return out;
  }

  // Active customers for the UNKNOWN-shift inline picker AND the
  // Quick Notes preview on shift cards. Rules allow any signed-in
  // staff member to read the customers collection. We capture ONLY
  // the public SOP fields (flat camelCase) so Quick Glance renders
  // inline. customer_secure/{slug} is NEVER touched by this function;
  // firestore.rules denies tech reads of that collection.
  async function loadActiveCustomersForPicker() {
    try {
      const db = firebase.firestore();
      const snap = await db.collection("customers").get();
      const list = [];
      snap.docs.forEach(function (d) {
        const c = d.data() || {};
        if (c.active === false) return;
        // Capture the display-mode fields too so we can run the helper at
        // render time without re-fetching the doc.
        const displayName = (window.PioneerCustomerDisplay
          && window.PioneerCustomerDisplay.getCustomerDisplayName(Object.assign({ slug: d.id }, c)))
          || c.customer_name || c.name || "";
        list.push({
          slug:               c.customer_slug || d.id,
          name:               displayName,
          rawCustomerName:    c.customer_name || c.name || "",
          locationName:       c.location_name || "",
          displayNameMode:    c.displayNameMode || c.display_name_mode || "",
          customDisplayName:  c.customDisplayName || c.custom_display_name || "",
          // Public SOP fields only — codes never touch this list.
          sopQuickGlance: Array.isArray(c.sopQuickGlance) ? c.sopQuickGlance : [],
          hasSecureSop:   c.hasSecureSop === true
        });
      });
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return list;
    } catch (err) {
      console.warn("[today's-work] loadActiveCustomersForPicker failed", err && err.code);
      return [];
    }
  }

  // Lookup a customer by slug from the cached list. Returns null when
  // the slug isn't in the active customers list (archived or unknown).
  function findCustomerBySlug(slug) {
    const s = String(slug || "").trim();
    if (!s) return null;
    for (let i = 0; i < workActiveCustomers.length; i++) {
      if (workActiveCustomers[i].slug === s) return workActiveCustomers[i];
    }
    return null;
  }

  function resolveWorkDate() {
    try {
      const params = new URLSearchParams(location.search || "");
      const override = (params.get("work_date") || "").trim();
      if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
        logDebug("[today's-work] DEBUG override active: work_date=" + override);
        return { date: override, isOverride: true };
      }
    } catch (e) { /* fall through to today */ }
    return { date: deputyTodayPT(), isOverride: false };
  }

  /* ---------- writes ---------- */

  function buildSessionSnapshot(shift, staff) {
    const fs = firebase.firestore;
    const shiftId = String(shift.shift_id || shift.id);
    function tsFromMaybe(ts) {
      if (!ts) return null;
      if (ts && ts.toDate) return ts;
      if (typeof ts === "string") {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) return fs.Timestamp.fromDate(d);
      }
      return null;
    }
    return {
      pioneer_session_id: shiftId,
      deputy_shift_id:    shiftId,
      tech_email:         String(staff.email || "").toLowerCase().trim(),
      tech_slug:          (staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "",
      sync_date:          shift.sync_date || "",
      customer_slug:      shift.customer_slug || "",
      customer_name:      shift.customer_name || "",
      location_name:      shift.location_name || "",
      // Carry the Pioneer-side HIGH suggestion onto the session.
      // submitDcrV1 overwrites selected_customer_* on DCR submit;
      // these stay as audit of what the system thought.
      suggested_customer_slug:       shift.suggested_customer_slug       || "",
      suggested_customer_name:       shift.suggested_customer_name       || "",
      suggested_customer_confidence: shift.suggested_customer_confidence || "",
      suggested_customer_source:     shift.suggested_customer_source     || "",
      scheduled_start:    tsFromMaybe(shift.start_time),
      scheduled_end:      tsFromMaybe(shift.end_time),
      deputy_shift_url:   shift.deputy_shift_url || ""
    };
  }

  async function startWork(shift, opts) {
    opts = opts || {};
    const staff = workCurrentStaff;
    if (!staff) return;
    const myEmailNow = String(staff.email || "").toLowerCase().trim();
    const mySlugNow  = String((staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "").toLowerCase().trim();
    const shiftId    = String(shift.shift_id || shift.id);

    // V7 — normalized shift-ownership resolution. The deputy_shift_cache
    // doc carries `employee_email` (matches Firebase Auth email) and
    // `employee_slug` (matches cleaning_techs doc id). Either match is
    // sufficient. Both are normalized (trim + lowercase) before compare
    // so spurious case/whitespace mismatches can't strand a tech.
    const ownership = isShiftOwnedByCurrentUser(shift, staff);
    try {
      console.info("[ShiftOwnership]", {
        shiftId:           shiftId,
        assignedEmail:     shift.employee_email || null,
        assignedSlug:      shift.employee_slug  || null,
        assignedTech:      shift.employee_display_name || null,
        currentAuthEmail:  myEmailNow,
        currentTechSlug:   mySlugNow,
        allowed:           ownership.allowed,
        reason:            ownership.reason,
        isAdmin:           workIsAdmin
      });
    } catch (_e) {}

    // Admins viewing other techs' shifts must not Start (per-card
    // readOnly already hides the button; this is defense-in-depth).
    if (workIsAdmin && !ownership.allowed) {
      warnTodayWork("startWork refused — admin starting another tech's shift", {
        shift_id: shiftId, shift_email: shift.employee_email, viewer: myEmailNow
      });
      try { console.info("[StartWork]", { shiftId: shiftId, allowed: false, reason: "admin viewing another tech", source: "client" }); } catch (_e) {}
      return;
    }
    if (!workIsAdmin && !ownership.allowed) {
      try { console.warn("[StartWork]", { shiftId: shiftId, allowed: false, reason: ownership.reason, source: "client" }); } catch (_e) {}
      window.alert(
        "This shift isn't currently linked to your PioneerOps profile yet.\n\n" +
        "Text Kirby or Nick so we can fix the assignment mapping. " +
        "(Shift " + shiftId + " is assigned to " +
        (shift.employee_display_name || shift.employee_email || "another tech") + ".)"
      );
      return;
    }

    // Multi-active-shift safety: techs may have several eligible shifts
    // in a day and may complete them out of scheduled order, but only
    // ONE shift may be active (working OR needs-finish) at a time. If a
    // different shift is already active, stop here and tell the tech.
    // The check reads in-memory session state — Firestore is the source
    // of truth, but renderWorkCards() always reflects the latest
    // session statuses, so this catches the foot-gun without an extra
    // read.
    const otherActive = Object.keys(workSessionByShiftId).filter(function (sid) {
      if (sid === shiftId) return false;
      const s = workSessionByShiftId[sid];
      if (!s || !s.status) return false;
      const status = String(s.status).toLowerCase();
      return status === WORK_STATE_WORKING || status === WORK_STATE_NEEDS_FIN;
    });
    if (otherActive.length > 0) {
      window.alert("Clock out of your current shift before starting another.");
      return;
    }

    const db = firebase.firestore();
    const ref = db.collection("pioneer_work_sessions").doc(shiftId);
    const sts = firebase.firestore.FieldValue.serverTimestamp();

    const snapshot = buildSessionSnapshot(shift, staff);
    snapshot.status              = WORK_STATE_WORKING;
    snapshot.pioneer_started_at  = sts;
    snapshot.updated_at          = sts;
    // UNKNOWN-customer guard: when the tech picked a customer on the
    // card before Start Work, stash it as selected_customer_* on the
    // session. DCR pre-fills from this; DCR submit overwrites with
    // the final selection.
    if (opts.picked_customer_slug) {
      snapshot.selected_customer_slug = String(opts.picked_customer_slug);
      snapshot.selected_customer_name = String(opts.picked_customer_name || "");
      snapshot.customer_picked_before_start = true;
    }

    try {
      await db.runTransaction(async function (tx) {
        const existing = await tx.get(ref);
        const create = !existing.exists;
        const payload = Object.assign({}, snapshot);
        if (create) {
          payload.created_at = sts;
        } else {
          const prior = existing.data() || {};
          if (prior.pioneer_started_at) delete payload.pioneer_started_at;
          delete payload.created_at;
        }
        tx.set(ref, payload, { merge: true });
      });
    } catch (err) {
      const code = (err && err.code) || "unknown";
      console.error("[StartWork] failed", { shiftId: shiftId, code: code, message: err && err.message, source: "firestore-write" });
      const friendly = code === "permission-denied"
        ? "This shift is not currently linked to your PioneerOps profile yet. " +
          "Text Kirby or Nick so we can fix the assignment mapping.\n\n" +
          "(Shift " + shiftId + " · code: " + code + ")"
        : "Couldn't start work — check your connection and try again.\n\n" + code;
      window.alert(friendly);
      return;
    }
    try { console.info("[StartWork]", { shiftId: shiftId, allowed: true, reason: "session write succeeded", source: "firestore" }); } catch (_e) {}

    workSessionByShiftId[shiftId] = Object.assign(
      {}, workSessionByShiftId[shiftId] || {}, snapshot, { status: WORK_STATE_WORKING }
    );
    renderWorkCards();

    // Surface the clock-in reminder card. Deputy remains the official
    // timeclock; PioneerOps never clocks the tech in. The card is
    // informational only and dismissable.
    showClockReminder({ phase: "start" });
  }

  async function stampDcrOpenedAt(shift) {
    // V6 — admins can OPEN a DCR for any shift (review path); only
    // stamp `pioneer_dcr_opened_at` for the shift's own tech to keep
    // the per-tech session log clean. Cross-tech stamps are gated by
    // the pioneer_work_sessions rule anyway.
    const staff = workCurrentStaff;
    if (!staff) return;
    const myEmailNow = String(staff.email || "").toLowerCase().trim();
    const shiftEmail = String(shift.employee_email || "").toLowerCase().trim();
    if (workIsAdmin && shiftEmail && shiftEmail !== myEmailNow) return;
    try {
      const db = firebase.firestore();
      const shiftId = String(shift.shift_id || shift.id);
      const ref = db.collection("pioneer_work_sessions").doc(shiftId);
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const existing = await ref.get();
      if (existing.exists && existing.data() && existing.data().pioneer_dcr_opened_at) return;
      await ref.set({ pioneer_dcr_opened_at: sts, updated_at: sts }, { merge: true });
    } catch (err) {
      console.warn("[today's-work] stampDcrOpenedAt failed (non-fatal)", err && err.code);
    }
  }

  async function finishWork(shift) {
    const staff = workCurrentStaff;
    if (!staff) return;
    // V6 — guard: admins can't finish another tech's shift. Per-card
    // readOnly already hides the button; this is defense-in-depth.
    const myEmailNow = String(staff.email || "").toLowerCase().trim();
    const shiftEmail = String(shift.employee_email || "").toLowerCase().trim();
    if (workIsAdmin && shiftEmail && shiftEmail !== myEmailNow) {
      warnTodayWork("finishWork refused — shift belongs to another tech", {
        shift_id: shift.shift_id || shift.id, shift_email: shiftEmail, viewer: myEmailNow
      });
      return;
    }
    const db = firebase.firestore();
    const shiftId = String(shift.shift_id || shift.id);
    const ref = db.collection("pioneer_work_sessions").doc(shiftId);
    const sts = firebase.firestore.FieldValue.serverTimestamp();

    try {
      await ref.set({
        status:               WORK_STATE_FINISHED,
        pioneer_finished_at:  sts,
        updated_at:           sts,
        tech_email:           String(staff.email || "").toLowerCase().trim(),
        deputy_shift_id:      shiftId
      }, { merge: true });
      try { console.info("[DCR] finish work complete", { shift_id: shiftId, tech_email: myEmailNow }); } catch (_e) {}
    } catch (err) {
      console.error("[DCR] finish work failed", err && err.code, err && err.message);
      window.alert("Couldn't finish work — check your connection and try again.\n\n" +
                   (err && err.code || err && err.message || "unknown"));
      return;
    }

    workSessionByShiftId[shiftId] = Object.assign({},
      workSessionByShiftId[shiftId] || {},
      { status: WORK_STATE_FINISHED });
    renderWorkCards();

    // Small celebration moment for the tech finishing their shift.
    // Confetti + sound, both no-ops if blocked or reduced-motion.
    try {
      if (window.PioneerCelebrate) window.PioneerCelebrate.celebrate({ intensity: "medium" });
    } catch (_e) {}
    showShiftCompleteToast();

    // Same reminder pattern as Start Work, with clock-out wording.
    // Deputy is the official timeclock.
    showClockReminder({ phase: "finish" });
  }

  // Called once after the shifts query lands. If the URL carried
  // ?finishSession=<id> (from the DCR success card's "Finish Work in
  // PioneerOps" button), close that session via the standard finishWork
  // path and strip the param from the URL so a reload is a no-op.
  function maybeAutoFinishFromUrl() {
    try {
      const params = new URLSearchParams(location.search || "");
      const sessionId = String(params.get("finishSession") || "").trim();
      if (!sessionId) return;
      // Strip param so reloads don't repeat the action and the URL
      // history stays clean.
      params.delete("finishSession");
      const newQs = params.toString();
      const newUrl = location.pathname + (newQs ? ("?" + newQs) : "") + location.hash;
      try { history.replaceState(history.state, "", newUrl); } catch (_e) {}

      const shift = workShiftsByShiftId[sessionId];
      if (!shift) {
        warnTodayWork("auto-finish: shift not found in current view", { sessionId: sessionId });
        return;
      }
      const session = workSessionByShiftId[sessionId] || null;
      const status = session ? String(session.status || "").toLowerCase() : "";
      if (status === "finished") {
        // Already closed — no-op, but still surface the Deputy reminder
        // so the tech sees the clock-out cue (which is the whole point
        // of routing through here).
        logTodayWork("auto-finish: already finished, surfacing Deputy reminder", { sessionId: sessionId });
        showClockReminder({ phase: "finish" });
        return;
      }
      logTodayWork("auto-finish: running finishWork", { sessionId: sessionId, current_status: status || "(none)" });
      finishWork(shift);
    } catch (e) {
      warnTodayWork("auto-finish failed (non-fatal)", { error: e && e.message });
    }
  }

  // Brief top-of-viewport confirmation toast for shift completion.
  // Independent from the Deputy clock-out reminder so the tech sees both
  // signals: a happy "you did it" beat AND the Deputy nudge below.
  function showShiftCompleteToast() {
    try {
      const existing = document.getElementById("pioneer-shift-complete-toast");
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      const t = document.createElement("div");
      t.id = "pioneer-shift-complete-toast";
      t.className = "pioneer-shift-complete-toast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      t.innerHTML =
        '<strong>Shift complete.</strong> Nice work tonight.';
      document.body.appendChild(t);
      setTimeout(function () {
        if (t.parentNode) t.classList.add("is-leaving");
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 360);
      }, 4500);
    } catch (_e) {}
  }

  /* ---------- click delegator ---------- */

  let wired = false;
  function wireWorkCardClicks() {
    if (wired) return;
    const list = $("team-hub-assignments-list");
    if (!list) return;
    // Enable/disable the "Start Work" button on UNKNOWN cards based on
    // the customer picker's value.
    list.addEventListener("change", function (ev) {
      const sel = ev.target.closest("select.assign-card-unknown-select");
      if (!sel) return;
      const card = sel.closest(".assign-card");
      const btn  = card && card.querySelector('button[data-action="start-work-unknown"]');
      if (!btn) return;
      const hasValue = !!sel.value;
      btn.disabled = !hasValue;
      btn.classList.toggle("is-disabled", !hasValue);
      btn.textContent = hasValue ? "Confirm customer & Start Work" : "Pick customer first";
    });
    list.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const action  = btn.dataset.action;
      const shiftId = btn.dataset.shiftId;
      if (!shiftId) return;
      const shift = workShiftsByShiftId[shiftId];
      if (!shift) return;

      if (action === "start-work") {
        ev.preventDefault();
        startWork(shift);
      } else if (action === "start-work-unknown") {
        ev.preventDefault();
        const card = btn.closest(".assign-card");
        const sel  = card && card.querySelector("select.assign-card-unknown-select");
        const slug = sel && sel.value;
        if (!slug) {
          window.alert("Pick a customer first.");
          return;
        }
        const opt  = sel.options[sel.selectedIndex];
        startWork(shift, {
          picked_customer_slug: slug,
          picked_customer_name: opt ? opt.text : ""
        });
      } else if (action === "finish-work") {
        ev.preventDefault();
        finishWork(shift);
      } else if (action === "complete-dcr") {
        // anchor's default href navigates; stamp the open time first.
        stampDcrOpenedAt(shift);
      } else if (action === "view-summary") {
        // Toggle the inline summary block on completed cards. Pure UI —
        // no Firestore write, no navigation.
        ev.preventDefault();
        const card = btn.closest(".assign-card");
        const sel  = (window.CSS && CSS.escape) ? CSS.escape(shiftId) : shiftId;
        const summary = card && card.querySelector('[data-summary-for="' + sel + '"]');
        if (summary) {
          const isOpen = !summary.hidden;
          summary.hidden = isOpen;
          btn.setAttribute("aria-expanded", String(!isOpen));
          btn.textContent = isOpen ? "View Summary" : "Hide Summary";
        }
      }
      // "request-adjustment" — let the mailto: anchor navigate via its
      // default href; no JS handler needed. Listed here for grep-ability.
      else if (action === "open-deputy") {
        // Phase A — fire-and-forget click log. Do NOT preventDefault:
        // the anchor must navigate so the OS can route to the Deputy app.
        logDeputyOpenClick("today_work_card", {
          shift_id:  String(shift.shift_id || ""),
          sync_date: String(shift.sync_date || "")
        });
      }
    });
    wired = true;
  }

  /* ---------- public boot ---------- */

  async function init(staff) {
    const section = $("team-hub-assignments-section");
    if (!section) {
      console.warn("[today's-work] #team-hub-assignments-section missing — nothing to mount");
      return;
    }
    if (!staff || !staff.email) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;

    workCurrentStaff = staff;
    section.hidden = false;
    wireWorkCardClicks();
    wireFilterBar();
    setAssignmentsState("loading");

    // Phase 1b.3 — fetch active Pioneer Time Clock session (if any) so
    // Deputy cards can show a "Clocked in with Pioneer Time Clock"
    // badge when they match the same customer + date. Doc-id read; no
    // index needed; soft-fails — Deputy display works whether or not
    // this read succeeds.
    if (staff && staff.uid) {
      firebase.firestore().collection("active_service_sessions").doc(staff.uid).get()
        .then(function (snap) {
          if (snap.exists) {
            pioneerActiveSession = snap.data();
            // Re-render so any already-rendered cards pick up the badge.
            try { renderWorkCards(); } catch (_e) {}
          }
        })
        .catch(function (_e) { /* non-fatal */ });
    }

    const dateRes  = resolveWorkDate();
    const queryDate = dateRes.date;
    const email    = String(staff.email || "").toLowerCase().trim();

    // V6 role mode. Admin / manager / office-manager (the server
    // returns role: "admin" for any of them) sees ALL shifts for the
    // day by default — no email filter on the query. Cleaning techs
    // stay on the narrow per-email path.
    workIsAdmin        = (staff.role === "admin");
    workIsAdminPreview = workIsAdmin && dateRes.isOverride;   // kept for date-override copy

    // V6 pilot — unconditional triage log under [PioneerOps TodayWork].
    // The verbose object-dump version (logDebug) stays gated by
    // ?debug_work=1; this concise line ships in every load so the
    // office can diagnose "shifts not showing" without asking the
    // tech to add a URL flag first.
    const techSlugResolved = (staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "";
    const techDisplayResolved = (staff.tech && staff.tech.display_name) || "";
    logTodayWork("booting", {
      email:             email,
      tech_slug:         techSlugResolved || "(none)",
      tech_display_name: techDisplayResolved || "(none)",
      role:              staff.role,
      query_sync_date:   queryDate,
      today_pacific:     deputyTodayPT(),
      timezone:          DEPUTY_TIMEZONE,
      admin_preview:     workIsAdminPreview,
      override:          dateRes.isOverride
    });
    // Pilot v20260526-shiftrestore — single-line summary the office
    // can ask any tech to read aloud over the phone.
    logTW("booting", {
      current_user_email: email || "(none)",
      current_tech_slug:  techSlugResolved || "(none)",
      role:               staff.role || "(none)",
      ops_window_date:    queryDate,
      ops_window_today:   deputyTodayPT(),
      ops_window_tz:      DEPUTY_TIMEZONE,
      admin_mode:         workIsAdmin,
      date_override:      dateRes.isOverride
    });
    logDebug("[today's-work] booting:", {
      email:                email,
      tech_slug:            techSlugResolved || "(none)",
      tech_display_name:    techDisplayResolved || "(none)",
      role:                 staff.role,
      query_sync_date:      queryDate,
      override:             dateRes.isOverride,
      admin_preview:        workIsAdminPreview,
      today_pacific:        deputyTodayPT()
    });

    let rulesError = null;     // set in the catch below if the snap fails
    try {
      const db = firebase.firestore();

      // V20260614 — Parallel email + slug query, merged by doc id.
      //
      // Why parallel: the firestore rule has THREE read arms — admin,
      // email match, slug fallback — but a single client query can only
      // filter on ONE field. Previously we ran the email-match query
      // first and only fell back to a slug query when the email query
      // returned ZERO. That created a silent partial-display bug: a
      // tech with 3 shifts where the sync stamped employee_email
      // inconsistently (1 doc has the Pioneer auth email, 2 have the
      // Deputy raw email) saw only 1 shift. The slug query was gated
      // on full-miss, not partial-miss, so it never fired.
      //
      // Fix: run BOTH queries in parallel and merge by doc id. Email-
      // matched takes precedence on duplicates (it's the doc shape the
      // rest of the codepath already trusts). Admin path is unchanged
      // — the unfiltered query still hits the rule's isPioneerAdmin
      // arm and returns every shift for the date.
      const techSlugForFallback = (staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "";

      let emailQuery = db.collection("deputy_shift_cache")
        .where("sync_date", "==", queryDate);
      if (!workIsAdmin) {
        emailQuery = emailQuery.where("employee_email", "==", email);
      }
      const slugQueryPromise = (!workIsAdmin && techSlugForFallback)
        ? db.collection("deputy_shift_cache")
            .where("sync_date", "==", queryDate)
            .where("employee_slug", "==", techSlugForFallback)
            .get()
            .catch(function (err) {
              warnTodayWork("slug-parallel query failed (non-fatal)", {
                code: err && err.code, message: err && err.message
              });
              return null;
            })
        : Promise.resolve(null);

      const [emailSnap, slugSnap] = await Promise.all([emailQuery.get(), slugQueryPromise]);

      const emailDocs = emailSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      const slugDocs = (slugSnap && slugSnap.docs)
        ? slugSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        : [];

      // Merge by doc id, deduplicating. Email-matched takes precedence:
      // its employee_email field already equals the tech's auth email,
      // which is what other code paths assume when they re-read the
      // shift's email for logging or display.
      const dedupedById = {};
      emailDocs.forEach(function (s) { dedupedById[String(s.id)] = s; });
      slugDocs.forEach(function (s) {
        const k = String(s.id);
        if (!dedupedById[k]) dedupedById[k] = s;
      });
      let shifts = Object.keys(dedupedById).map(function (k) { return dedupedById[k]; });

      logTodayWork("primary parallel query → deputy_shift_cache", {
        collection:           "deputy_shift_cache",
        where_sync_date_eq:   queryDate,
        where_employee_email_eq: workIsAdmin ? "(admin overview — no email filter)" : email,
        where_employee_slug_eq:  techSlugForFallback || "(no slug — skipped)",
        email_query_count:    emailDocs.length,
        slug_query_count:     slugDocs.length,
        merged_count:         shifts.length
      });
      logTW("primary parallel query → deputy_shift_cache", {
        email_query_count:    emailDocs.length,
        slug_query_count:     slugDocs.length,
        merged_count:         shifts.length,
        email_shift_ids:      emailDocs.map(function (s) { return String(s.shift_id || s.id); }),
        slug_shift_ids:       slugDocs.map(function (s) { return String(s.shift_id || s.id); }),
        deduped_shift_ids:    Object.keys(dedupedById),
        current_user_email:   email,
        current_tech_slug:    techSlugForFallback || "(none)",
        ops_window_date:      queryDate
      });
      logDebug("[today's-work] fetched shifts (email+slug parallel):", {
        mode:                  workIsAdmin ? "admin_all_shifts" : "tech_email+slug_parallel",
        email_query_count:     emailDocs.length,
        slug_query_count:      slugDocs.length,
        merged_count:          shifts.length,
        deduped_shift_ids:     Object.keys(dedupedById),
        ids:                   shifts.map(function (s) { return String(s.shift_id || s.id); }),
        statuses:              shifts.map(function (s) { return s.status || "(none)"; }),
        matched_emails:        shifts.map(function (s) { return s.employee_email || "(blank)"; }),
        matched_slugs:         shifts.map(function (s) { return s.employee_slug || "(empty)"; }),
        matched_display_names: shifts.map(function (s) { return s.employee_display_name || "(blank)"; }),
        first_doc_keys:        shifts[0] ? Object.keys(shifts[0]) : []
      });

      // Display-name fallback — third-line defense for very old data
      // where neither email nor slug match resolves. Only for techs
      // (admins already see everything). The rule's tech-slug arm
      // still applies to each returned doc, so this is safe even if
      // the cache carries unmapped rows from third-party imports.
      if (!workIsAdmin && shifts.length === 0 && staff.tech && staff.tech.display_name) {
        try {
          const altSnap = await db.collection("deputy_shift_cache")
            .where("sync_date", "==", queryDate)
            .where("employee_display_name", "==", staff.tech.display_name)
            .get();
          const fallbackShifts = altSnap.docs
            .map(function (d) { return Object.assign({ id: d.id }, d.data()); });
          if (fallbackShifts.length > 0) {
            logTodayWork("display_name fallback matched", { count: fallbackShifts.length });
            shifts = fallbackShifts;
          }
        } catch (err) {
          warnTodayWork("display_name fallback query failed", { code: err && err.code });
        }
      }

      // Walk every shift and record WHY it survived or got dropped.
      // Pilot v20260526-shiftrestore — the user explicitly required
      // that no shift be silently hidden. Each rejection carries a
      // human-readable reason so the office can ask the tech for the
      // exact line.
      const rejected = [];
      const visible = shifts.filter(function (s) {
        const sId = String(s.shift_id || s.id);
        const status = String(s.status || "").toLowerCase();
        if (status === "cancelled") {
          rejected.push({ shift_id: sId, reason: "status=cancelled" });
          return false;
        }
        return true;
      });
      const cancelledCount = shifts.length - visible.length;

      logTodayWork("filter result", {
        raw_shifts:        shifts.length,
        cancelled_filtered: cancelledCount,
        visible:           visible.length
      });
      logTW("filter result", {
        raw_shifts_count:      shifts.length,
        filtered_shifts_count: visible.length,
        visible_shift_ids:     visible.map(function (s) { return String(s.shift_id || s.id); }),
        rejected_shifts:       rejected,
        cancelled_count:       cancelledCount,
        current_user_email:    email,
        current_tech_slug:     techSlugResolved || "(none)",
        ops_window_date:       queryDate
      });
      if (visible.length === 0) {
        populateEmptyDiag({
          staff:             staff,
          email:             email,
          queryDate:         queryDate,
          techSlug:          techSlugResolved,
          techDisplayName:   techDisplayResolved,
          isAdminAllView:    workIsAdmin,
          dateOverride:      dateRes.isOverride,
          rawShiftsCount:    shifts.length,
          cancelledCount:    cancelledCount,
          rulesError:        null
        });
      }

      workShiftsByShiftId = {};
      visible.forEach(function (s) {
        const id = String(s.shift_id || s.id);
        workShiftsByShiftId[id] = s;
      });

      const [sessionsById, customersList] = await Promise.all([
        loadSessionsFor(Object.keys(workShiftsByShiftId)),
        loadActiveCustomersForPicker()
      ]);
      workSessionByShiftId = sessionsById;
      workActiveCustomers  = customersList;

      logDebug("[today's-work] sessions loaded:", {
        session_count: Object.keys(sessionsById).length,
        session_ids:   Object.keys(sessionsById),
        statuses:      Object.keys(sessionsById).map(function (k) { return sessionsById[k].status || "(none)"; })
      });

      // Subtitle text under the section header — picks the right
      // operational framing for the role + date mode combo.
      const subEl = $("team-hub-assignments-sub");
      if (subEl) {
        if (workIsAdmin && dateRes.isOverride) {
          subEl.textContent = "Admin overview · showing work for " + queryDate +
            ". Remove ?work_date=… from the URL to return to today.";
        } else if (workIsAdmin) {
          subEl.textContent = "Admin overview — every Pioneer shift for today. " +
            "Tap My Shifts to focus on your own.";
        } else if (dateRes.isOverride) {
          subEl.textContent = "Viewing work for " + queryDate +
            ". Remove ?work_date=… to return to today.";
        } else {
          subEl.textContent = "Start work, finish the DCR, and clock out — one step at a time.";
        }
      }

      // Admin callout — a soft visible banner under the header so the
      // operator never confuses "I'm seeing all shifts company-wide"
      // with "no shifts assigned to me". Tech-side renders nothing.
      const calloutEl = $("team-hub-assignments-callout");
      if (calloutEl) {
        if (workIsAdmin) {
          calloutEl.textContent =
            "👁 Admin overview · seeing every Deputy shift for " + queryDate + ". " +
            "Start / Finish Work + Complete DCR are enabled only on YOUR own shifts (the rule rejects cross-tech writes). " +
            "Use the My Shifts filter to focus on yours.";
          calloutEl.hidden = false;
        } else {
          calloutEl.hidden = true;
          calloutEl.textContent = "";
        }
      }

      renderWorkCards();

      // Golden-path auto-finish handoff from the DCR success card.
      //   /work.html?finishSession=<deputy_shift_id>
      // The DCR success card sends the tech here with the just-submitted
      // session id. We close it with the same finishWork code path that
      // the in-card Finish Work button uses — same write, same Deputy
      // reminder card, same audit trail. The URL param is cleared on the
      // way in so a reload can't re-trigger.
      maybeAutoFinishFromUrl();
    } catch (err) {
      warnTodayWork("query failed", {
        code:    err && err.code,
        message: err && err.message,
        email:   email,
        sync_date: queryDate
      });
      console.warn("[today's-work] load failed", err && err.code, err && err.message, err);
      const isRules = err && (err.code === "permission-denied" || err.code === "permission_denied");
      const friendly = isRules
        ? "Couldn't load shifts. Email mismatch with Deputy — ask the office to align."
        : "Couldn't load shifts. Check your connection and reload.";
      setAssignmentsState("error", friendly);
      // V6 pilot — also stamp the empty-state diagnostic so admins
      // can see WHY the query failed (mode + email + sync_date +
      // error code). The error banner above stays visible; the diag
      // block is admin/debug-only, so it doesn't crowd the tech view.
      populateEmptyDiag({
        staff:           staff,
        email:           email,
        queryDate:       queryDate,
        techSlug:        techSlugResolved,
        techDisplayName: techDisplayResolved,
        isAdminAllView:  workIsAdmin,
        dateOverride:    dateRes.isOverride,
        rawShiftsCount:  0,
        cancelledCount:  0,
        rulesError:      (err && (err.code || err.message)) || "unknown"
      });
    }
  }

  /* --------------------------------------------------------------------
   * Scroll-lock safety net — Pilot v20260526-mobileunlock.
   *
   * iOS Safari was STILL stranding /work.html in an unscrollable state
   * even after the prior fix. Make it impossible by:
   *   1. Running an aggressive unlock at every reasonable trigger
   *      (DOM ready, after auth, after announcements, +500ms, +1500ms,
   *      pageshow, touchstart on the page itself).
   *   2. Each unlock wipes inline overflow/position/height on BOTH
   *      body and html, AND removes the modal-scroll-locked class
   *      unless a modal is genuinely visible right now.
   *   3. Adding a `?debug_scroll=1` floating overlay that prints the
   *      live overflow / modal / scrollY state so we can diagnose
   *      remotely without a Safari devtools session.
   * ------------------------------------------------------------------ */
  function isAnyModalVisible() {
    const candidates = document.querySelectorAll(
      "#mandatory-modal, .mandatory-modal-root, #pioneer-walkthrough-root, [role='dialog'][aria-modal='true']"
    );
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el && !el.hidden && el.getAttribute("aria-hidden") !== "true") {
        return { visible: true, id: el.id || el.className };
      }
    }
    return { visible: false, id: null };
  }

  // Pilot v20260526-scrollrestore — clear inline scroll-related styles
  // and the lock class, but ONLY when no modal is genuinely visible.
  // We do NOT force overflow:auto or any other value — the browser
  // default (visible) is what we want. Forcing a value here is what
  // broke desktop scroll in the v20260526-mobileunlock release.
  function unlockScroll(source) {
    try {
      const modal = isAnyModalVisible();
      if (!modal.visible) {
        // Clear inline styles (empty string lets the stylesheet rule win)
        // and the lock class. Never assign "auto" or any forced value.
        document.body.classList.remove("modal-scroll-locked");
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.height   = "";
        document.documentElement.style.overflow = "";
        document.documentElement.style.height   = "";
      }
      console.info("[ScrollLock]", {
        source:        source,
        body_overflow: document.body.style.overflow || "(empty)",
        html_overflow: document.documentElement.style.overflow || "(empty)",
        body_position: document.body.style.position || "(empty)",
        body_height:   document.body.style.height   || "(empty)",
        html_height:   document.documentElement.style.height || "(empty)",
        body_class:    document.body.className || "(empty)",
        modal_state:   modal.visible ? ("visible:" + modal.id) : "no-modal-visible",
        scrollY:       (typeof window !== "undefined") ? window.scrollY : null
      });
      paintScrollDebugOverlay(source, modal);
    } catch (_e) {}
  }
  // Back-compat aliases used elsewhere in this file.
  function emergencyUnlock(source) { unlockScroll(source); }
  function sweepScrollLock(source) { unlockScroll(source); }

  // ?debug_scroll=1 floating panel — shown only when the URL flag is on.
  // Updates in place on every emergencyUnlock call so we can watch the
  // live state from a remote tech's iPhone.
  let _scrollDebugEnabled = false;
  try {
    const dbg = new URLSearchParams(location.search || "").get("debug_scroll");
    _scrollDebugEnabled = dbg === "1" || dbg === "true";
  } catch (_e) {}
  function paintScrollDebugOverlay(source, modal) {
    if (!_scrollDebugEnabled) return;
    let host = document.getElementById("pioneer-scroll-debug-overlay");
    if (!host) {
      host = document.createElement("div");
      host.id = "pioneer-scroll-debug-overlay";
      host.style.cssText =
        "position:fixed;top:8px;right:8px;z-index:99999;" +
        "background:rgba(15,23,42,0.92);color:#f8fafc;" +
        "font:11px/1.4 ui-monospace,Menlo,monospace;" +
        "padding:8px 10px;border-radius:6px;max-width:260px;" +
        "pointer-events:auto;white-space:pre-wrap;";
      document.body.appendChild(host);
      host.addEventListener("click", function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      });
    }
    host.textContent =
      "[scroll-debug] tap to dismiss\n" +
      "source: " + source + "\n" +
      "body overflow: " + (document.body.style.overflow || "(empty)") + "\n" +
      "html overflow: " + (document.documentElement.style.overflow || "(empty)") + "\n" +
      "body class: " + (document.body.className || "(empty)") + "\n" +
      "modal: " + (modal && modal.visible ? modal.id : "none") + "\n" +
      "scrollY: " + ((typeof window !== "undefined") ? window.scrollY : "?");
  }

  if (typeof window !== "undefined") {
    // Multi-trigger emergency unlock. Each trigger is cheap; we run a
    // lot of them because the cost of NOT unlocking is a stranded tech.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { emergencyUnlock("dom-content-loaded"); });
    } else {
      setTimeout(function () { emergencyUnlock("script-load"); }, 0);
    }
    window.addEventListener("pageshow", function (e) {
      emergencyUnlock("pageshow:persisted=" + (e && e.persisted ? "true" : "false"));
    });
    window.addEventListener("focus", function () { emergencyUnlock("window-focus"); });
    // First user interaction also unlocks — covers the "modal closed but
    // overflow stuck" Safari edge.
    document.addEventListener("touchstart", function () { emergencyUnlock("touchstart"); }, { once: true, passive: true });
    document.addEventListener("click",      function () { emergencyUnlock("click");      }, { once: true });
    setTimeout(function () { emergencyUnlock("delayed-500ms");  },  500);
    setTimeout(function () { emergencyUnlock("delayed-1500ms"); }, 1500);
    setTimeout(function () { emergencyUnlock("delayed-3000ms"); }, 3000);
  }

  window.PIONEER_TODAY_WORK = { init: init };
})();
