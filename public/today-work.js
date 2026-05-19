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

  const DEPUTY_TIMEZONE = "America/Los_Angeles";

  // Pacific-TZ YYYY-MM-DD — matches server-emitted sync_date.
  function deputyTodayPT() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: DEPUTY_TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  // Firestore Timestamp / Date / ms / ISO → "h:mm AM/PM" or "" missing.
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

    let customer;
    let customerKind;   // "selected" | "resolved" | "suggested" | "unknown" | "placeholder"
    if (sessionCustomerName) {
      customer = sessionCustomerName;
      customerKind = "selected";
    } else if (cacheCustomerName && !safeUnresolved) {
      customer = cacheCustomerName;
      customerKind = "resolved";
    } else if (suggestedCustomerName && !safeUnresolved) {
      customer = suggestedCustomerName;
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
                  'Start Work' +
                '</button>';
      helperText = "Clock in/out stays in Deputy for payroll accuracy. We'll open it for you.";
    } else if (state === WORK_STATE_WORKING) {
      const dcrHref = buildOpenDcrHref(shift, { pioneer_session_id: sessionId });
      ctaHtml = '<a class="assign-card-btn is-primary"' +
                  ' data-action="complete-dcr"' +
                  ' data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '"' +
                  ' href="' + escapeHtml(dcrHref) + '">' +
                  'Complete DCR' +
                '</a>';
      helperText = "Fill in your DCR for this shift. Deputy stays open in the other tab for clock-out.";
    } else if (state === WORK_STATE_NEEDS_FIN) {
      ctaHtml = '<button type="button" class="assign-card-btn is-primary"' +
                  ' data-action="finish-work" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
                  'Finish Work' +
                '</button>';
      helperText = "Finish your payroll clock-out in Deputy. We'll open it for you.";
    } else {
      ctaHtml = '<span class="assign-card-done"><span aria-hidden="true">✅</span> Work completed</span>';
      const dcrSubmissionId = session && session.dcr_submission_id;
      if (dcrSubmissionId) {
        footerHtml =
          '<p class="assign-card-footer">' +
            '<span class="assign-card-footer-label">DCR submitted:</span> ' +
            '<code>' + escapeHtml(dcrSubmissionId) + '</code>' +
          '</p>';
      }
    }

    // In admin preview, the tech identity now lives in a small chip
    // at the top-right of the card header (see techInitialChip below).
    // Keeping `ownerLine` for two reasons: (1) sketches a fallback if
    // the chip ever has to be hidden on narrow widths via CSS, and
    // (2) downstream pages/tests grepping for the footer label keep
    // working. In v1 we emit the chip in the header and leave the
    // footer empty so we don't double-print the same info.
    const ownerLine = "";

    return (
      '<article class="assign-card work-card is-state-' + state + '"' +
        (opts.readOnly ? ' data-preview="true"' : '') +
        ' role="listitem" data-shift-id="' + escapeHtml(shift.shift_id || shift.id) + '">' +
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
        footerHtml +
        ownerLine +
      '</article>'
    );
  }

  /* ---------- module state ---------- */

  let workShiftsByShiftId  = {};
  let workSessionByShiftId = {};
  let workCurrentStaff     = null;
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
    setText("work-kpi-shifts-meta",  snap.total === 1 ? "Scheduled" : "Scheduled");
    setText("work-kpi-hours",        formatHours(snap.hours));
    setText("work-kpi-techs",        String(snap.techsOn || 0));
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
      setAssignmentsState("empty");
      listEl.innerHTML = "";
      return;
    }

    // Apply the filter — full set first, then trimmed.
    const opts = { readOnly: workIsAdminPreview };
    const displayed = visible.filter(function (shift) {
      const sess = workSessionByShiftId[String(shift.shift_id || shift.id)] || null;
      return shiftMatchesFilter(shift, sess, workCurrentFilter);
    });

    const filterEmptyEl = document.getElementById("team-hub-assignments-filter-empty");
    if (displayed.length === 0 && visible.length > 0) {
      // Filtered to zero — show the calm filter-specific empty state
      // and keep the underlying section in "list" state so the KPI
      // strip + filter row stay visible.
      listEl.innerHTML = "";
      if (filterEmptyEl) filterEmptyEl.hidden = false;
      setAssignmentsState("list");
      return;
    }
    if (filterEmptyEl) filterEmptyEl.hidden = true;

    listEl.innerHTML = displayed.map(function (shift) {
      return workCard(shift, workSessionByShiftId[String(shift.shift_id || shift.id)] || null, opts);
    }).join("");
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
        list.push({
          slug:           c.customer_slug || d.id,
          name:           c.customer_name || c.name || "",
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
    if (workIsAdminPreview) {
      console.warn("[today's-work] startWork ignored in admin-preview mode");
      return;
    }
    const db = firebase.firestore();
    const shiftId = String(shift.shift_id || shift.id);
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
      console.error("[today's-work] startWork failed", err && err.code, err && err.message);
      window.alert("Couldn't start work — check your connection and try again.\n\n" +
                   (err && err.code || err && err.message || "unknown"));
      return;
    }

    workSessionByShiftId[shiftId] = Object.assign(
      {}, workSessionByShiftId[shiftId] || {}, snapshot, { status: WORK_STATE_WORKING }
    );
    renderWorkCards();

    if (shift.deputy_shift_url) {
      try { window.open(shift.deputy_shift_url, "_blank", "noopener"); }
      catch (e) { console.warn("[today's-work] window.open failed", e); }
    }
  }

  async function stampDcrOpenedAt(shift) {
    if (workIsAdminPreview) return;
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
    if (workIsAdminPreview) {
      console.warn("[today's-work] finishWork ignored in admin-preview mode");
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
    } catch (err) {
      console.error("[today's-work] finishWork failed", err && err.code, err && err.message);
      window.alert("Couldn't finish work — check your connection and try again.\n\n" +
                   (err && err.code || err && err.message || "unknown"));
      return;
    }

    workSessionByShiftId[shiftId] = Object.assign({},
      workSessionByShiftId[shiftId] || {},
      { status: WORK_STATE_FINISHED });
    renderWorkCards();

    if (shift.deputy_shift_url) {
      try { window.open(shift.deputy_shift_url, "_blank", "noopener"); }
      catch (e) { console.warn("[today's-work] window.open failed", e); }
    }
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

    const dateRes  = resolveWorkDate();
    const queryDate = dateRes.date;
    const email    = String(staff.email || "").toLowerCase().trim();

    // Admin preview: admin + ?work_date override → unscoped read.
    workIsAdminPreview = (staff.role === "admin") && dateRes.isOverride;

    logDebug("[today's-work] booting:", {
      email:                email,
      tech_slug:            (staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "(none)",
      tech_display_name:    (staff.tech && staff.tech.display_name) || "(none)",
      role:                 staff.role,
      query_sync_date:      queryDate,
      override:             dateRes.isOverride,
      admin_preview:        workIsAdminPreview,
      today_pacific:        deputyTodayPT()
    });

    try {
      const db = firebase.firestore();

      // Build query — same collection in both modes; admin-preview just
      // drops the email filter so the rule's `isPioneerAdmin()` arm
      // returns every shift for that date.
      let query = db.collection("deputy_shift_cache")
        .where("sync_date", "==", queryDate);
      if (!workIsAdminPreview) {
        query = query.where("employee_email", "==", email);
      }
      const snap = await query.get();

      let shifts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });

      logDebug("[today's-work] fetched shifts:", {
        mode:                 workIsAdminPreview ? "admin_preview" : "tech_email_match",
        total:                shifts.length,
        ids:                  shifts.map(function (s) { return String(s.shift_id || s.id); }),
        statuses:             shifts.map(function (s) { return s.status || "(none)"; }),
        matched_emails:       shifts.map(function (s) { return s.employee_email || "(blank)"; }),
        matched_slugs:        shifts.map(function (s) { return s.employee_slug || "(empty)"; }),
        matched_display_names: shifts.map(function (s) { return s.employee_display_name || "(blank)"; }),
        first_doc_keys:       shifts[0] ? Object.keys(shifts[0]) : []
      });

      // Fallback for non-admin techs whose Auth email didn't match a
      // cache row directly: try display_name match. Rule still requires
      // employee_email==auth.email, so the fallback can ONLY find rows
      // where the email IS the tech's auth email but happened to be
      // mixed-case in the cache. (Server lowercases on write, so this
      // is rare — but harmless to attempt.) For mapping data fixes,
      // the office should align cleaning_techs.email with Deputy.
      if (!workIsAdminPreview && shifts.length === 0 && staff.tech && staff.tech.display_name) {
        try {
          const altSnap = await db.collection("deputy_shift_cache")
            .where("sync_date", "==", queryDate)
            .where("employee_display_name", "==", staff.tech.display_name)
            .get();
          const fallbackShifts = altSnap.docs
            .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
            // Rules will still strip docs where employee_email doesn't
            // match auth email; the snapshot only contains permitted
            // rows, so a non-empty result is safe.
            .filter(function (s) { return s.employee_email === email; });
          if (fallbackShifts.length > 0) {
            logDebug("[today's-work] display_name fallback matched:", fallbackShifts.length);
            shifts = fallbackShifts;
          }
        } catch (err) {
          console.warn("[today's-work] display_name fallback failed", err && err.code);
        }
      }

      const visible = shifts
        .filter(function (s) { return String(s.status || "").toLowerCase() !== "cancelled"; });

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

      const subEl = $("team-hub-assignments-sub");
      if (subEl) {
        if (workIsAdminPreview) {
          subEl.textContent = "Read-only preview. Techs only see their assigned shifts.";
        } else if (dateRes.isOverride) {
          subEl.textContent = "Admin preview · showing work for " + queryDate + ". Remove ?work_date=… from the URL to return to today.";
        } else {
          subEl.textContent = "Start work, finish the DCR, and clock out — one step at a time.";
        }
      }

      // Admin-preview callout — a visible banner just under the section
      // header so the operator never confuses preview with a real tech
      // view. Tech-side renders nothing here.
      const calloutEl = $("team-hub-assignments-callout");
      if (calloutEl) {
        if (workIsAdminPreview) {
          calloutEl.textContent =
            "👁 Admin preview for " + queryDate + ". " +
            "You're seeing every Deputy shift for that day; techs only see their own shifts and can use Start / Complete DCR / Finish Work. " +
            "Buttons are intentionally suppressed here so admins don't accidentally start a shift on a tech's behalf.";
          calloutEl.hidden = false;
        } else {
          calloutEl.hidden = true;
          calloutEl.textContent = "";
        }
      }

      renderWorkCards();
    } catch (err) {
      console.warn("[today's-work] load failed", err && err.code, err && err.message, err);
      const friendly = (err && err.code === "permission-denied")
        ? "Couldn't load shifts. Email mismatch with Deputy — ask the office to align."
        : "Couldn't load shifts. Check your connection and reload.";
      setAssignmentsState("error", friendly);
    }
  }

  window.PIONEER_TODAY_WORK = { init: init };
})();
