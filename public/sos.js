/* Pioneer SOS — Phase 1 Lone-Worker Protection.
 *
 * Single shared module loaded on every page that needs the SOS surface.
 * Injects:
 *   • A persistent red "🚨 SOS" pill in the lower-left corner
 *   • A multi-step modal flow:
 *       Step 1  – Are you safe?
 *       Step A  – Help-needed form  (severity: "help_needed")
 *       Step B  – Critical emergency form  (severity: "critical")
 *       Step C  – After-submit confirmation with Call April / 911 fallbacks
 *
 * Persistence:
 *   Writes to Firestore `emergency_events/{autoId}`. A Cloud Function
 *   (`onEmergencyCreatedV1`) fans out SMS notifications and updates the
 *   doc's notified/notificationStatus fields. The UI does NOT fake
 *   success — it surfaces the actual server-stamped notification status
 *   on the confirmation screen and always shows tel/sms anchors as a
 *   manual fallback.
 *
 * Context capture (best-effort, never required):
 *   • Active shift / work session from URL params + window.PIONEER_TODAY_WORK
 *   • Customer / location from the same sources
 *   • Geolocation (single one-shot getCurrentPosition, only after user
 *     opts in by clicking Send Alert — never auto-requested)
 *   • staff identity from STAFF_AUTH cached staff
 *
 * No business-logic side effects. No DCR/work-session writes. No
 * dependency on Slack or Zapier. Honors the existing scroll-lock
 * lessons: no body overflow lock, real action sheet, real <a tel:>
 * anchors.
 */
(function () {
  "use strict";

  const APRIL_PHONE = "+15098283335";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function softLog(label, meta) {
    try { console.info("[SOS] " + label, meta || ""); } catch (_e) {}
  }
  function softWarn(label, meta) {
    try { console.warn("[SOS] " + label, meta || ""); } catch (_e) {}
  }

  /* ---------- Context capture ----------------------------------------
   * Each piece is best-effort and silently empty when unavailable.
   * Nothing here blocks the flow — the goal is to attach context to the
   * Firestore doc so admins can triage faster.
   * ------------------------------------------------------------------ */
  function readUrlParam(key) {
    try {
      return (new URLSearchParams(location.search || "").get(key) || "").trim();
    } catch (_e) { return ""; }
  }
  // Multi-source staff capture. STAFF_AUTH has two surfaces:
  //   • getCurrentStaff()  — in-memory, set after whoAmI succeeds
  //   • getCachedStaff()   — localStorage, persists across loads
  // On mobile Safari with a slow network, both can be empty while
  // firebase.auth().currentUser still carries a valid signed-in user
  // (Nick's iPhone hit this exact race). When any one of them returns
  // an identity, treat the user as authenticated and open the modal —
  // the Firestore rule is the final gate at write time.
  function captureStaff() {
    let s = null;
    try {
      s = (window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff)
            ? window.STAFF_AUTH.getCurrentStaff() : null;
    } catch (_e) {}
    if (!s) {
      try {
        s = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
              ? window.STAFF_AUTH.getCachedStaff() : null;
      } catch (_e) {}
    }
    // Final fallback — raw Firebase Auth user. No role/tech info but a
    // uid + email is enough to open the modal. The Firestore rule
    // enforces real authorization on the write.
    if (!s) {
      try {
        const fbUser = (window.firebase && firebase.auth && firebase.auth().currentUser) || null;
        if (fbUser && fbUser.uid) {
          s = {
            uid:   fbUser.uid,
            email: String(fbUser.email || "").toLowerCase().trim(),
            display_name: fbUser.displayName || fbUser.email || "",
            role:  "",   // unknown — the rule decides
            tech:  null,
            _source: "firebase-auth-fallback"
          };
        }
      } catch (_e) {}
    }
    if (!s) return null;
    return {
      uid:         s.uid || null,
      email:       String(s.email || "").toLowerCase().trim(),
      displayName: String(s.display_name || (s.tech && s.tech.display_name) || s.email || "").trim(),
      techSlug:    String((s.tech && (s.tech.slug || s.tech.tech_slug)) || "").trim(),
      role:        s.role || "",
      _source:     s._source || (s.tech ? "staff-auth:tech" : (s.role === "admin" ? "staff-auth:admin" : "staff-auth"))
    };
  }
  function captureShiftContext() {
    // 1. URL params (DCR page carries deputy_shift_id + pioneer_session_id +
    //    customer_slug etc. when launched from Today's Work).
    const ctx = {
      shiftId:       readUrlParam("deputy_shift_id") || readUrlParam("finishSession") || "",
      workSessionId: readUrlParam("pioneer_session_id") || readUrlParam("deputy_shift_id") || "",
      customerSlug:  readUrlParam("customer_slug") || "",
      customerName:  readUrlParam("customer_name") || "",
      locationName:  readUrlParam("location_name") || ""
    };
    // 2. Today's Work module — when the tech is on /work.html, the
    //    currently-rendered shift may not be in the URL. Read whatever
    //    the module has exposed for the active session.
    try {
      if (window.PIONEER_TODAY_WORK && typeof window.PIONEER_TODAY_WORK.getActiveShift === "function") {
        const shift = window.PIONEER_TODAY_WORK.getActiveShift();
        if (shift) {
          ctx.shiftId       = ctx.shiftId       || String(shift.shift_id || "");
          ctx.workSessionId = ctx.workSessionId || String(shift.shift_id || "");
          ctx.customerSlug  = ctx.customerSlug  || String(shift.customer_slug || "");
          ctx.customerName  = ctx.customerName  || String(shift.customer_name || "");
          ctx.locationName  = ctx.locationName  || String(shift.location_name || "");
        }
      }
    } catch (_e) {}
    return ctx;
  }
  async function captureGeolocation() {
    return new Promise(function (resolve) {
      if (!navigator || !navigator.geolocation) return resolve(null);
      try {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            resolve({
              lat:       pos.coords.latitude,
              lng:       pos.coords.longitude,
              accuracy:  pos.coords.accuracy || null,
              capturedAt: new Date().toISOString()
            });
          },
          function (_err) { resolve(null); },
          { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
        );
      } catch (_e) { resolve(null); }
    });
  }

  /* ---------- UI markup --------------------------------------------- */

  function ensureMarkup() {
    if (document.getElementById("sos-fab")) return;

    // Floating action button.
    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "sos-fab";
    fab.className = "sos-fab";
    fab.setAttribute("aria-haspopup", "dialog");
    fab.innerHTML =
      '<span class="sos-fab-icon" aria-hidden="true">🚨</span>' +
      '<span class="sos-fab-text">SOS</span>';
    fab.title = "For urgent safety or lone-worker situations.";
    document.body.appendChild(fab);
    fab.addEventListener("click", openModal);

    // Modal overlay.
    const overlay = document.createElement("div");
    overlay.id = "sos-overlay";
    overlay.className = "sos-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "sos-step-title");
    overlay.innerHTML =
      '<div class="sos-backdrop" data-action="sos-close"></div>' +
      '<div class="sos-sheet" id="sos-sheet">' +
        '<button type="button" class="sos-close" data-action="sos-close" aria-label="Close">×</button>' +
        '<div id="sos-step-1" class="sos-step">' +
          '<p class="sos-eyebrow">Pioneer SOS</p>' +
          '<h2 class="sos-title" id="sos-step-title">Are you safe?</h2>' +
          '<p class="sos-helper">For urgent safety or lone-worker situations. Pick the option that fits.</p>' +
          '<div class="sos-actions">' +
            '<button type="button" class="sos-btn sos-btn-warning" data-action="sos-help-needed">' +
              '<strong>Yes, but I need help</strong>' +
              '<span class="sos-btn-sub">Locked out · alarm · access · vehicle · stuck and need support</span>' +
            '</button>' +
            '<button type="button" class="sos-btn sos-btn-emergency" data-action="sos-emergency">' +
              '<strong>No, this is an emergency</strong>' +
              '<span class="sos-btn-sub">Injury · accident · threat · medical · fire · immediate danger</span>' +
            '</button>' +
            '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-close">' +
              'Cancel' +
            '</button>' +
          '</div>' +
        '</div>' +

        // ---- HELP NEEDED branch (Step A) ----
        '<div id="sos-step-help" class="sos-step" hidden>' +
          '<p class="sos-eyebrow sos-eyebrow-amber">Help needed</p>' +
          '<h2 class="sos-title">What\'s going on?</h2>' +
          '<p class="sos-helper">Short description is best. We\'ll text April + Kirby right away. Your shift context attaches automatically.</p>' +
          '<textarea id="sos-help-text" class="sos-textarea" rows="4" maxlength="500"' +
                   ' placeholder="e.g. Locked out of Lydig front door, security code not working. At south side."></textarea>' +
          '<div class="sos-ctx" id="sos-help-ctx"></div>' +
          '<div class="sos-actions">' +
            '<button type="button" class="sos-btn sos-btn-warning sos-btn-go" data-action="sos-submit-help">Send Help Request</button>' +
            '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-back-1">Back</button>' +
          '</div>' +
        '</div>' +

        // ---- EMERGENCY branch (Step B) ----
        '<div id="sos-step-emergency" class="sos-step" hidden>' +
          '<p class="sos-eyebrow sos-eyebrow-red">Emergency</p>' +
          '<h2 class="sos-title">If anyone is in immediate danger, call 911 first.</h2>' +
          '<p class="sos-helper">911 routes faster than any internal alert. After 911, you can also send a Pioneer SOS so April and Kirby get notified.</p>' +
          // 911 + April as equally-prominent primary buttons side-by-side.
          '<div class="sos-actions sos-actions-grid">' +
            '<a class="sos-btn sos-btn-emergency sos-btn-go" href="tel:911" data-action="sos-911">' +
              '<span aria-hidden="true">📞</span> Call 911' +
            '</a>' +
            '<a class="sos-btn sos-btn-warning sos-btn-go" href="tel:' + esc(APRIL_PHONE) + '" data-action="sos-call-april-em">' +
              '<span aria-hidden="true">📞</span> Call April' +
            '</a>' +
          '</div>' +
          // Pioneer SOS fan-out as a secondary affordance below — still
          // accessible, but visually subordinate to the direct calls.
          '<div class="sos-actions">' +
            '<button type="button" class="sos-btn sos-btn-emergency-outline" data-action="sos-show-emergency-form">' +
              '<span aria-hidden="true">🚨</span> Also send Pioneer SOS Alert' +
            '</button>' +
            '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-back-1">Back</button>' +
          '</div>' +
        '</div>' +

        // ---- EMERGENCY FORM (Step B-2) ----
        '<div id="sos-step-emergency-form" class="sos-step" hidden>' +
          '<p class="sos-eyebrow sos-eyebrow-red">Send SOS alert</p>' +
          '<h2 class="sos-title">Anything you can tell us?</h2>' +
          '<p class="sos-helper">Optional. Even one word helps April and Kirby know what they\'re walking into. We\'ll send the alert with whatever context we have.</p>' +
          '<textarea id="sos-emergency-text" class="sos-textarea" rows="3" maxlength="500"' +
                   ' placeholder="Optional — what\'s happening, where you are."></textarea>' +
          '<div class="sos-ctx" id="sos-em-ctx"></div>' +
          '<div class="sos-actions">' +
            '<button type="button" class="sos-btn sos-btn-emergency sos-btn-go" data-action="sos-submit-emergency">Send SOS Alert</button>' +
            '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-back-emergency">Back</button>' +
          '</div>' +
        '</div>' +

        // ---- Confirmation (Step C) ----
        '<div id="sos-step-done" class="sos-step" hidden>' +
          '<p class="sos-eyebrow" id="sos-done-eyebrow">SOS alert</p>' +
          '<h2 class="sos-title" id="sos-done-title">Alert sent</h2>' +
          '<p class="sos-helper" id="sos-done-body">—</p>' +
          '<div class="sos-actions">' +
            '<a class="sos-btn sos-btn-warning" href="tel:' + esc(APRIL_PHONE) + '" data-action="sos-call-april-done">' +
              '<span aria-hidden="true">📞</span> Call April now' +
            '</a>' +
            '<a class="sos-btn sos-btn-cancel-light" href="sms:' + esc(APRIL_PHONE) + '" data-action="sos-sms-april-done">' +
              '<span aria-hidden="true">💬</span> Text April' +
            '</a>' +
            '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-close">Close</button>' +
          '</div>' +
          '<p class="sos-event-id" id="sos-event-id"></p>' +
        '</div>' +

        // ---- Error state (failed Firestore write etc.) ----
        '<div id="sos-step-error" class="sos-step" hidden>' +
          '<p class="sos-eyebrow sos-eyebrow-red">Couldn\'t save SOS</p>' +
          '<h2 class="sos-title">Call for help directly</h2>' +
          '<p class="sos-helper" id="sos-error-body">We couldn\'t save your SOS alert. Please call 911 or April directly — your alert did NOT save to Pioneer.</p>' +
          '<div class="sos-actions sos-actions-grid">' +
            '<a class="sos-btn sos-btn-emergency sos-btn-go" href="tel:911">' +
              '<span aria-hidden="true">📞</span> Call 911' +
            '</a>' +
            '<a class="sos-btn sos-btn-warning sos-btn-go" href="tel:' + esc(APRIL_PHONE) + '">' +
              '<span aria-hidden="true">📞</span> Call April' +
            '</a>' +
          '</div>' +
          '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-close">Close</button>' +
        '</div>' +

        // ---- Access-inactive state — shown when STAFF_AUTH has no
        //      resolved staff identity. The Pioneer alert can\'t save,
        //      but the tech still gets equal-prominence 911 + April. ----
        '<div id="sos-step-inactive" class="sos-step" hidden>' +
          '<p class="sos-eyebrow sos-eyebrow-red">Pioneer access not active</p>' +
          '<h2 class="sos-title">Call for help directly</h2>' +
          '<p class="sos-helper">' +
            'Your PioneerOps access isn\'t active right now, so we can\'t save an SOS alert for the office. ' +
            'If this is an emergency, call 911 first. April is available for support.' +
          '</p>' +
          '<div class="sos-actions sos-actions-grid">' +
            '<a class="sos-btn sos-btn-emergency sos-btn-go" href="tel:911">' +
              '<span aria-hidden="true">📞</span> Call 911' +
            '</a>' +
            '<a class="sos-btn sos-btn-warning sos-btn-go" href="tel:' + esc(APRIL_PHONE) + '">' +
              '<span aria-hidden="true">📞</span> Call April' +
            '</a>' +
          '</div>' +
          '<button type="button" class="sos-btn sos-btn-cancel" data-action="sos-close">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", onDelegateClick);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !overlay.hidden) closeModal();
    });
  }

  /* ---------- Step handling ----------------------------------------- */

  function showStep(id) {
    ["sos-step-1", "sos-step-help", "sos-step-emergency", "sos-step-emergency-form",
     "sos-step-done", "sos-step-error", "sos-step-inactive"].forEach(function (k) {
      const el = document.getElementById(k);
      if (el) el.hidden = (k !== id);
    });
  }

  // Wait up to `maxMs` for any of the three staff signals to resolve.
  // Polls every 100ms. Returns the resolved staff or null. Lets a slow
  // mobile-Safari whoAmI catch up before we render the access-inactive
  // sheet — admins kept hitting the race on first iPhone load.
  async function awaitStaffReady(maxMs) {
    const started = Date.now();
    let s = captureStaff();
    while (!s && Date.now() - started < maxMs) {
      await new Promise(function (r) { setTimeout(r, 100); });
      s = captureStaff();
    }
    return s;
  }

  // Permissive access check at modal-open time. Authoritative gating is
  // at the Firestore rule. We only refuse to open when there's truly
  // no signed-in identity anywhere.
  async function openModal() {
    ensureMarkup();
    // First synchronous check — fast path for the common case.
    let staff = captureStaff();
    // If nothing's there yet, wait briefly. Most pages have STAFF_AUTH
    // settled within 100-300ms after DOMContentLoaded; first iPhone
    // page loads on a cold cache can take 600-1200ms.
    if (!staff || !staff.uid) {
      staff = await awaitStaffReady(1500);
    }
    // Always emit the access trace so a remote admin can grep it from
    // a tech's iPhone Safari console without enabling a debug flag.
    logSosAccess(staff);
    if (!staff || !staff.uid) {
      softLog("modal-blocked-no-resolved-staff");
      showStep("sos-step-inactive");
      document.getElementById("sos-overlay").hidden = false;
      return;
    }
    softLog("modal-opened", { source: staff._source });
    showStep("sos-step-1");
    document.getElementById("sos-overlay").hidden = false;
    paintContext();
  }

  function logSosAccess(staff) {
    try {
      const cached = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
        ? window.STAFF_AUTH.getCachedStaff() : null;
      const fbUser = (window.firebase && firebase.auth && firebase.auth().currentUser) || null;
      const role = (staff && staff.role) || "";
      console.info("[SOSAccess]", {
        uid:             (staff && staff.uid) || (fbUser && fbUser.uid) || null,
        email:           (staff && staff.email) || (fbUser && fbUser.email) || null,
        cachedStaff:     cached ? { hasUid: !!cached.uid, role: cached.role || null, hasTech: !!cached.tech } : null,
        isAdmin:         role === "admin",
        isCleaningTech:  role === "cleaning_tech",
        isActive:        !!(staff && staff.uid),
        source:          (staff && staff._source) || "none"
      });
    } catch (_e) {}
  }
  function closeModal() {
    const overlay = document.getElementById("sos-overlay");
    if (overlay) overlay.hidden = true;
    softLog("modal-closed");
  }

  function paintContext() {
    const shift = captureShiftContext();
    const staff = captureStaff();
    const parts = [];
    if (staff && staff.displayName) parts.push("Tech: " + staff.displayName);
    if (shift.customerName || shift.locationName) {
      parts.push("Location: " + (shift.customerName || shift.locationName));
    }
    if (shift.shiftId) parts.push("Shift #" + shift.shiftId);
    const html = parts.length
      ? parts.map(function (p) { return '<span class="sos-ctx-chip">' + esc(p) + '</span>'; }).join("")
      : '<span class="sos-ctx-empty">No active shift detected — that\'s OK, alert will still go out.</span>';
    const a = document.getElementById("sos-help-ctx");
    const b = document.getElementById("sos-em-ctx");
    if (a) a.innerHTML = html;
    if (b) b.innerHTML = html;
  }

  function onDelegateClick(ev) {
    const t = ev.target && ev.target.closest && ev.target.closest("[data-action]");
    if (!t) return;
    const action = t.getAttribute("data-action");
    switch (action) {
      case "sos-close":         closeModal(); break;
      case "sos-help-needed":   showStep("sos-step-help"); softLog("branch-help-needed"); break;
      case "sos-emergency":     showStep("sos-step-emergency"); softLog("branch-emergency"); break;
      case "sos-back-1":        showStep("sos-step-1"); break;
      case "sos-back-emergency":showStep("sos-step-emergency"); break;
      case "sos-show-emergency-form": showStep("sos-step-emergency-form"); break;
      case "sos-submit-help":   submitEvent("help_needed"); break;
      case "sos-submit-emergency": submitEvent("critical"); break;
      // Tel anchors handle themselves. We log for analytics.
      case "sos-911":            softLog("called-911"); break;
      case "sos-call-april-em":  softLog("called-april-from-emergency-step"); break;
      case "sos-call-april-done":softLog("called-april-from-done-step"); break;
      case "sos-sms-april-done": softLog("sms-april-from-done-step"); break;
      default: break;
    }
  }

  /* ---------- Submit -------------------------------------------------
   * Single Firestore write to `emergency_events/{autoId}`. A
   * Cloud Function trigger fans out SMS notifications and writes back
   * the actual `notified` + `notificationStatus` fields. We DO NOT show
   * "alert sent" until Firestore confirms the write.
   * ------------------------------------------------------------------ */
  async function submitEvent(severity) {
    const btnSelector = severity === "critical"
      ? '[data-action="sos-submit-emergency"]'
      : '[data-action="sos-submit-help"]';
    const btn = document.querySelector(btnSelector);
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

    const detailsEl = severity === "critical"
      ? document.getElementById("sos-emergency-text")
      : document.getElementById("sos-help-text");
    const details = String((detailsEl && detailsEl.value) || "").trim().slice(0, 500);

    if (severity === "help_needed" && !details) {
      // Help-needed branch needs at least a one-liner. Critical branch
      // sends regardless — every second matters.
      if (btn) { btn.disabled = false; btn.textContent = "Send Help Request"; }
      alert("Add a one-line description so April and Kirby know what to expect.");
      return;
    }

    const staff = captureStaff();
    if (!staff || !staff.uid) {
      softWarn("missing-staff", { hasStaffAuth: !!window.STAFF_AUTH });
      showErrorState("Sign-in expired. Sign in and try again, or call April directly.");
      return;
    }
    const shift = captureShiftContext();
    const geo = await captureGeolocation();

    const doc = {
      severity:         severity,
      status:           "open",
      createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
      createdByUid:     staff.uid,
      createdByEmail:   staff.email,
      techSlug:         staff.techSlug || "",
      techName:         staff.displayName || "",
      customerSlug:     shift.customerSlug || "",
      customerName:     shift.customerName || "",
      locationName:     shift.locationName || "",
      address:          "",
      shiftId:          shift.shiftId || "",
      workSessionId:    shift.workSessionId || "",
      sourcePage:       (location.pathname || "") + (location.search || ""),
      details:          details,
      geolocation:      geo,
      userAgent:        navigator.userAgent || "",
      // Initial notification state — Cloud Function overwrites these
      // after attempting to dispatch SMS.
      notified:         { april: false, kirby: false, nick: false },
      notificationStatus: "pending"
    };

    let docRef;
    try {
      docRef = await firebase.firestore().collection("emergency_events").add(doc);
      softLog("event-saved", { id: docRef.id, severity: severity });
    } catch (err) {
      softWarn("event-save-failed", { code: err && err.code, message: err && err.message });
      showErrorState(err && err.message);
      return;
    }

    // Wait briefly for the Cloud Function to stamp notification status,
    // but never block more than 4s. The confirmation copy adapts to
    // whatever state we observe.
    const finalDoc = await pollForNotificationStatus(docRef, 4000);
    showDoneState(severity, finalDoc || doc, docRef.id);
  }

  async function pollForNotificationStatus(docRef, maxMs) {
    const started = Date.now();
    let lastSnap = null;
    while (Date.now() - started < maxMs) {
      try {
        const snap = await docRef.get();
        if (snap.exists) {
          const data = snap.data() || {};
          lastSnap = data;
          const status = String(data.notificationStatus || "");
          if (status && status !== "pending") return data;
        }
      } catch (_e) { /* keep polling */ }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return lastSnap;
  }

  /* ---------- Confirmation / error painting ------------------------- */

  function showDoneState(severity, doc, eventId) {
    showStep("sos-step-done");
    const eyebrow = document.getElementById("sos-done-eyebrow");
    const title   = document.getElementById("sos-done-title");
    const body    = document.getElementById("sos-done-body");
    const idEl    = document.getElementById("sos-event-id");

    const notified = doc && doc.notified || {};
    const status   = String((doc && doc.notificationStatus) || "pending");

    if (severity === "critical") {
      if (eyebrow) { eyebrow.textContent = "SOS emergency"; eyebrow.className = "sos-eyebrow sos-eyebrow-red"; }
    } else {
      if (eyebrow) { eyebrow.textContent = "Help needed"; eyebrow.className = "sos-eyebrow sos-eyebrow-amber"; }
    }

    if (status === "sent") {
      title.textContent = "Alert sent.";
      body.textContent  = "April" +
        (notified.kirby ? " and Kirby" : "") +
        (notified.nick  ? " and Nick"  : "") +
        " have been texted. Stay safe — you can also call them directly below.";
    } else if (status === "partial") {
      title.textContent = "Alert saved.";
      const went = [];
      if (notified.april) went.push("April");
      if (notified.kirby) went.push("Kirby");
      if (notified.nick)  went.push("Nick");
      body.textContent = went.length
        ? ("Texted " + went.join(" + ") + ". Other texts failed — please also call April now.")
        : "Texts failed to send. Please call April directly now.";
    } else if (status === "sms_provider_missing") {
      title.textContent = "Alert saved. Please call April now.";
      body.textContent  = "Your alert is logged for the office, but Pioneer's SMS provider isn't wired up yet — automatic texts didn't go out. Call April directly using the button below.";
    } else if (status === "failed") {
      title.textContent = "Alert saved.";
      body.textContent  = "Notification dispatch failed. Please call April directly now.";
    } else {
      // Still pending after our polling window — the function may
      // complete shortly. Be honest about it.
      title.textContent = "Alert saved.";
      body.textContent  = "Your alert is being processed. Don't wait — please call April directly now.";
    }
    if (idEl && eventId) idEl.textContent = "Event ID: " + eventId;
  }
  function showErrorState(msg) {
    showStep("sos-step-error");
    const body = document.getElementById("sos-error-body");
    if (body && msg) body.textContent = "Firestore error: " + msg + ". Your alert did NOT save — call April directly.";
  }

  /* ---------- Boot --------------------------------------------------- */

  document.addEventListener("DOMContentLoaded", function () {
    // The FAB is mounted once Firestore SDK is available — if Firebase
    // isn't loaded on this page, we can't write events anyway.
    if (!window.firebase || typeof firebase.firestore !== "function") {
      softWarn("firebase-not-loaded — SOS hidden on this page");
      return;
    }
    ensureMarkup();
  });

  window.PioneerSOS = {
    open:  openModal,
    close: closeModal
  };
})();
