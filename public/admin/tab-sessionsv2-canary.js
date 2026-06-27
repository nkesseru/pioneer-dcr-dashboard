/* tab-sessionsv2-canary.js — Phase 35a-canary admin harness.
 *
 * Minimal function-first UI: 7 buttons, one result pane.
 * No polish. No CSS beyond what admin.css provides.
 *
 * Exports window.__pioneerAdmin.tabs.sessionsv2Canary = { init, refresh }.
 * Tab is registered only when window.SESSION_V2_DEBUG_UI_ENABLED === true.
 */

(function () {
  "use strict";
  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) return;

  const $ = function (id) { return document.getElementById(id); };

  function logToPane(label, payload) {
    const pane = $("sv2c-result");
    if (!pane) return;
    const ts = new Date().toISOString().slice(11, 19);
    const block = "[" + ts + "] " + label + "\n" +
      (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)) +
      "\n\n";
    pane.value = block + pane.value;
  }

  function genCanaryV1Id() {
    return "canary_v1_" + Math.random().toString(36).slice(2, 10);
  }

  function todayPT() {
    // Pacific time YYYY-MM-DD
    const d = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    });
    const parts = fmt.formatToParts(d).reduce(function (a, p) { a[p.type] = p.value; return a; }, {});
    return parts.year + "-" + parts.month + "-" + parts.day;
  }

  function fixedAssignmentId() { return "canary-asg-fixed"; }
  function fixedV1IdSeed()     { return "canary_v1_seed"; } // stable for idempotency tests

  function commonOpts(v1IdOverride) {
    const u = firebase.auth().currentUser;
    return {
      assignment_id:        fixedAssignmentId(),
      service_date:         todayPT(),
      staff_uid:            (u && u.uid)   || "no-user",
      staff_email:          ((u && u.email) || "no-user").toLowerCase(),
      v1_session_id:        v1IdOverride || fixedV1IdSeed(),
      environment:          "debug",
      source:               "canary",
      bypass_allowlist_check: true,
      assignment: {
        customer_id:   "canary-customer",
        customer_slug: "canary-customer",
        customer_name: "Canary Test Customer",
        location_id:   null
      }
    };
  }

  function expectedV2Id() {
    return "sess_" + fixedAssignmentId() + "_" + todayPT() + "_a1";
  }

  function fakeV1Id() { return "canary_v1_fake_" + todayPT(); }
  function fakeClockOutAt() { return new Date().toISOString(); }

  async function btnDiagnose() {
    const out = {
      timestamp:                          new Date().toISOString(),
      helper_loaded:                      typeof window.PIONEER_SESSIONS_V2 === "object",
      maybeDualWriteClockIn_typeof:       typeof (window.PIONEER_SESSIONS_V2 && window.PIONEER_SESSIONS_V2.maybeDualWriteClockIn),
      deriveSessionV2Id_typeof:           typeof (window.PIONEER_SESSIONS_V2 && window.PIONEER_SESSIONS_V2.deriveSessionV2Id),
      SESSION_V2_ENABLED_client_mirror:   window.SESSION_V2_ENABLED,
      SESSION_V2_DEBUG_UI_ENABLED:        window.SESSION_V2_DEBUG_UI_ENABLED,
      CREATE_SESSION_V2_URL:              window.CREATE_SESSION_V2_URL || "<unset>",
      CLEANUP_SESSION_V2_CANARY_URL:      window.CLEANUP_SESSION_V2_CANARY_URL || "<unset>",
      current_user:                       (firebase.auth().currentUser || {}).email || "<not signed in>",
      expected_v2_id_for_canary_run:      expectedV2Id()
    };
    try {
      if (window.PIONEER_SESSIONS_V2 && window.PIONEER_SESSIONS_V2.getConfig) {
        const cfg = await window.PIONEER_SESSIONS_V2.getConfig(true);
        out.allowlist_config_doc = cfg;
        out.current_user_in_allowlist = !!(cfg && cfg.allowed_emails && cfg.allowed_emails.indexOf(out.current_user.toLowerCase()) >= 0);
      }
    } catch (err) {
      out.allowlist_config_doc_error = err && err.message;
    }
    logToPane("DIAGNOSE", out);
  }

  function btnComputeId() {
    const id = (window.PIONEER_SESSIONS_V2 && window.PIONEER_SESSIONS_V2.deriveSessionV2Id)
      ? window.PIONEER_SESSIONS_V2.deriveSessionV2Id(fixedAssignmentId(), todayPT(), 1)
      : "<helper unavailable>";
    logToPane("COMPUTE_ID", {
      assignment_id: fixedAssignmentId(),
      service_date:  todayPT(),
      attempt:       1,
      derived_v2_id: id
    });
  }

  async function btnCreateCanary() {
    if (!window.PIONEER_SESSIONS_V2 || !window.PIONEER_SESSIONS_V2.maybeDualWriteClockIn) {
      logToPane("CREATE_CANARY ERROR", "helper unavailable");
      return;
    }
    try {
      const result = await window.PIONEER_SESSIONS_V2.maybeDualWriteClockIn(commonOpts());
      logToPane("CREATE_CANARY", result);
    } catch (err) {
      logToPane("CREATE_CANARY ERROR", err && err.message);
    }
  }

  async function btnRecreateSame() {
    if (!window.PIONEER_SESSIONS_V2 || !window.PIONEER_SESSIONS_V2.maybeDualWriteClockIn) {
      logToPane("RECREATE_SAME ERROR", "helper unavailable");
      return;
    }
    try {
      const result = await window.PIONEER_SESSIONS_V2.maybeDualWriteClockIn(commonOpts());
      logToPane("RECREATE_SAME (idempotency)", result);
    } catch (err) {
      logToPane("RECREATE_SAME ERROR", err && err.message);
    }
  }

  async function btnReadBack() {
    const id = expectedV2Id();
    try {
      const snap = await firebase.firestore().doc("sessionsV2/" + id).get();
      if (!snap.exists) {
        logToPane("READ_BACK", { session_id: id, exists: false });
        return;
      }
      const data = snap.data() || {};
      const summary = {
        session_id:          id,
        exists:              true,
        source:              data.source,
        environment:         data.environment,
        status:              data.status,
        v1_session_id:       data.v1_session_id,
        parent_route_id:     data.parent_route_id,
        expected_components: data.expected_components,
        components_keys:     Object.keys(data.components || {}).sort(),
        timeline_count:      (data.timeline || []).length,
        timeline_first_event: data.timeline && data.timeline[0] && data.timeline[0].event,
        created_at:          data.created_at && data.created_at.toDate ? data.created_at.toDate().toISOString() : null
      };
      logToPane("READ_BACK", summary);
    } catch (err) {
      logToPane("READ_BACK ERROR", err && err.message);
    }
  }

  async function _postWithAuth(url, body) {
    const u = firebase.auth().currentUser;
    if (!u) return { ok: false, error: "not signed in" };
    const token = await u.getIdToken();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(body || {})
    });
    const json = await res.json().catch(function () { return {}; });
    return { status: res.status, body: json };
  }

  async function btnReconcile() {
    try {
      const url = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/reconcileV1V2ParityV1";
      const result = await _postWithAuth(url, { lookback_hours: 1 });
      logToPane("RECONCILE", result);
    } catch (err) {
      logToPane("RECONCILE ERROR", err && err.message);
    }
  }

  /* ----- Phase 35b clock-out canary buttons -----
   *
   * Step sequence for the canary doc's status:
   *   1. "Create canary session" -> doc at status=assigned
   *   2. "3p. Advance to in_progress (admin write)" -> doc at status=in_progress
   *   3. "3q. Call clock-out CF" -> doc at status=awaiting_completion (via real CF)
   *   4. "3r. Call clock-out CF again" -> 200 idempotent (status unchanged)
   *
   * 3p is a direct Firestore write by admin (rules allow admin update). It
   * simulates what Phase 35b-2 would do (in_progress transition). 3q exercises
   * the real updateSessionV2ClockOutV1 endpoint end-to-end.
   */

  async function btnAdvanceToInProgress() {
    const id = expectedV2Id();
    const refTxn = firebase.firestore().doc("sessionsV2/" + id);
    try {
      const snap = await refTxn.get();
      if (!snap.exists) {
        logToPane("ADVANCE_TO_IN_PROGRESS ERROR", { v2_id: id, exists: false, hint: "Run Create canary session first." });
        return;
      }
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const actor = firebase.auth().currentUser;
      const actorEmail = (actor && actor.email) || "unknown";
      await refTxn.update({
        status:            "in_progress",
        status_changed_at: sts,
        status_version:    firebase.firestore.FieldValue.increment(1),
        clock_in_at:       sts,
        "components.clock.status":        "collecting",
        "components.clock.last_event":    "clock.in",
        "components.clock.last_event_at": sts,
        timeline: firebase.firestore.FieldValue.arrayUnion({
          ts:         new Date(),
          actor:      { type: "admin", email: actorEmail },
          event:      "clock.in",
          title:      "Canary: admin advanced to in_progress",
          from:       snap.data().status || "assigned",
          to:         "in_progress",
          field_path: "status"
        }),
        updated_at: sts
      });
      logToPane("ADVANCE_TO_IN_PROGRESS OK", { v2_id: id, advanced_to: "in_progress" });
    } catch (err) {
      logToPane("ADVANCE_TO_IN_PROGRESS ERROR", err && err.message);
    }
  }

  async function btnCallClockOutCF() {
    if (!window.PIONEER_SESSIONS_V2 || !window.PIONEER_SESSIONS_V2.maybeDualWriteClockOut) {
      logToPane("CLOCKOUT_CF ERROR", "maybeDualWriteClockOut helper not available");
      return;
    }
    try {
      const result = await window.PIONEER_SESSIONS_V2.maybeDualWriteClockOut({
        v2_session_id:           expectedV2Id(),
        v1_session_id:           fakeV1Id(),
        staff_uid:               (firebase.auth().currentUser || {}).uid || "no-user",
        staff_email:             ((firebase.auth().currentUser || {}).email || "no-user").toLowerCase(),
        clock_out_at:            fakeClockOutAt(),
        clock_out_gps:           null,
        environment:             "debug",
        bypass_allowlist_check:  true
      });
      logToPane("CLOCKOUT_CF", result);
    } catch (err) {
      logToPane("CLOCKOUT_CF ERROR", err && err.message);
    }
  }

  async function btnCallClockOutCFAgain() {
    if (!window.PIONEER_SESSIONS_V2 || !window.PIONEER_SESSIONS_V2.maybeDualWriteClockOut) {
      logToPane("CLOCKOUT_CF_IDEMPOTENT ERROR", "helper unavailable");
      return;
    }
    try {
      const result = await window.PIONEER_SESSIONS_V2.maybeDualWriteClockOut({
        v2_session_id:           expectedV2Id(),
        v1_session_id:           fakeV1Id(),
        staff_uid:               (firebase.auth().currentUser || {}).uid || "no-user",
        staff_email:             ((firebase.auth().currentUser || {}).email || "no-user").toLowerCase(),
        clock_out_at:            fakeClockOutAt(),
        clock_out_gps:           null,
        environment:             "debug",
        bypass_allowlist_check:  true
      });
      logToPane("CLOCKOUT_CF_IDEMPOTENT", result);
    } catch (err) {
      logToPane("CLOCKOUT_CF_IDEMPOTENT ERROR", err && err.message);
    }
  }

  async function btnCleanupDry() {
    const url = window.CLEANUP_SESSION_V2_CANARY_URL;
    if (!url) { logToPane("CLEANUP_DRY ERROR", "CLEANUP_SESSION_V2_CANARY_URL unset"); return; }
    try {
      const result = await _postWithAuth(url, { dry_run: true });
      logToPane("CLEANUP_DRY_RUN", result);
    } catch (err) {
      logToPane("CLEANUP_DRY ERROR", err && err.message);
    }
  }

  function openConfirmModal() {
    const m = $("sv2c-confirm-modal");
    const errEl = $("sv2c-confirm-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
    if (m) { m.hidden = false; m.setAttribute("aria-hidden", "false"); }
  }
  function closeConfirmModal() {
    const m = $("sv2c-confirm-modal");
    if (m) { m.hidden = true; m.setAttribute("aria-hidden", "true"); }
  }

  function btnCleanupApply() {
    const url = window.CLEANUP_SESSION_V2_CANARY_URL;
    if (!url) {
      logToPane("CLEANUP_APPLY ERROR", "CLEANUP_SESSION_V2_CANARY_URL unset");
      return;
    }
    openConfirmModal();
  }

  async function performCleanupApply() {
    const url = window.CLEANUP_SESSION_V2_CANARY_URL;
    const errEl = $("sv2c-confirm-err");
    const btn = $("sv2c-confirm-apply");
    if (btn) btn.disabled = true;
    try {
      const result = await _postWithAuth(url, { dry_run: false });
      logToPane("CLEANUP_APPLY", result);
      closeConfirmModal();
    } catch (err) {
      const msg = (err && err.message) || "unknown";
      if (errEl) { errEl.textContent = "Cleanup failed: " + msg; errEl.hidden = false; }
      logToPane("CLEANUP_APPLY ERROR", msg);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wire() {
    const bind = function (id, fn) { const el = $(id); if (el) el.addEventListener("click", fn); };
    bind("sv2c-btn-diagnose",        btnDiagnose);
    bind("sv2c-btn-compute-id",      btnComputeId);
    bind("sv2c-btn-create",          btnCreateCanary);
    bind("sv2c-btn-recreate",        btnRecreateSame);
    bind("sv2c-btn-read-back",       btnReadBack);
    bind("sv2c-btn-reconcile",       btnReconcile);
    bind("sv2c-btn-cleanup-dry",     btnCleanupDry);
    bind("sv2c-btn-cleanup-apply",   btnCleanupApply);
    bind("sv2c-confirm-apply",       performCleanupApply);
    // Phase 35b clock-out canary buttons
    bind("sv2c-btn-advance-inprog",  btnAdvanceToInProgress);
    bind("sv2c-btn-clockout-cf",     btnCallClockOutCF);
    bind("sv2c-btn-clockout-again",  btnCallClockOutCFAgain);
    bind("sv2c-btn-clear-pane",      function () {
      const pane = $("sv2c-result");
      if (pane) pane.value = "";
    });
  }

  function init() { wire(); }
  function refresh() { /* no-op: harness is button-driven */ }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.sessionsv2Canary = { init: init, refresh: refresh };
}());
