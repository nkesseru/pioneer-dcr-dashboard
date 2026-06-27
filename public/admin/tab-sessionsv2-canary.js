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
  try { console.log("[sessionsV2.canary] module evaluating"); } catch (_e) {}

  // Phase 36a hotfix: don't early-return on missing __pioneerAdmin/utils.
  // Initialize the namespace ourselves so handler binding still happens
  // even if this script evaluates before admin/_utils.js (which would be
  // surprising given the HTML load order, but the previous silent
  // early-return swallowed all evidence). Worst case: tabs object gets
  // pre-seeded by us and _utils.js's `|| {}` guard preserves it.
  window.__pioneerAdmin       = window.__pioneerAdmin       || {};
  window.__pioneerAdmin.tabs  = window.__pioneerAdmin.tabs  || {};

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
    // Phase 36a hotfix: immediate observability. Prove the handler
    // fired before any async work runs. If you see DIAGNOSE_FIRED in
    // the result pane, wiring is OK and the issue (if any) is downstream.
    try { console.log("[sessionsV2.canary] btnDiagnose fired"); } catch (_e) {}
    logToPane("DIAGNOSE_FIRED", { fired_at: new Date().toISOString() });
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

  /* ----- Phase 36a snapshot renderer buttons -----
   *
   * 5a. Render snapshot from canary V2 session  (read-only)
   * 5b. Render snapshot from a real V2 session id (read-only, admin enters id)
   * 5c. Reproducibility check — render twice on same canary doc, diff outputs
   *     excluding generated_at_iso; pass iff byte-identical.
   * 5d. Simulate DCR dual-write on canary session — admin direct write
   *     that mimics the Phase 36a.2 server splice (stamps components.dcr,
   *     components.photos, appends timeline.dcr.submitted). No V1
   *     dcr_submissions doc is created.
   *
   * 5a/b/c are READ-ONLY. 5d writes only to the canary V2 doc.
   * The renderer is exposed via window.PIONEER_SESSIONS_V2_SNAPSHOT.
   */
  function _snapHelper() {
    return window.PIONEER_SESSIONS_V2_SNAPSHOT || null;
  }

  async function btnSnapshotCanary() {
    const h = _snapHelper();
    if (!h) { logToPane("SNAPSHOT_CANARY ERROR", "snapshot helper unavailable"); return; }
    const id = expectedV2Id();
    try {
      const doc = await firebase.firestore().doc("sessionsV2/" + id).get();
      if (!doc.exists) {
        logToPane("SNAPSHOT_CANARY", { session_id: id, exists: false,
          hint: "Run 'Create canary session' first." });
        return;
      }
      const view = h.renderSessionSnapshot(doc.data(),
        { generated_at_iso: new Date().toISOString() });
      logToPane("SNAPSHOT_CANARY (" + h.SNAPSHOT_VERSION + ")", view);
    } catch (err) {
      logToPane("SNAPSHOT_CANARY ERROR", err && err.message);
    }
  }

  async function btnSnapshotReal() {
    const h = _snapHelper();
    if (!h) { logToPane("SNAPSHOT_REAL ERROR", "snapshot helper unavailable"); return; }
    var id = "";
    try { id = window.prompt("Real V2 session id (sess_..._a1):", ""); }
    catch (_e) { id = ""; }
    if (!id) { logToPane("SNAPSHOT_REAL", "cancelled"); return; }
    id = String(id).trim();
    if (id.indexOf("sess_") !== 0) {
      logToPane("SNAPSHOT_REAL ERROR",
        "id must start with sess_; received: " + id);
      return;
    }
    try {
      const doc = await firebase.firestore().doc("sessionsV2/" + id).get();
      if (!doc.exists) {
        logToPane("SNAPSHOT_REAL", { session_id: id, exists: false });
        return;
      }
      const view = h.renderSessionSnapshot(doc.data(),
        { generated_at_iso: new Date().toISOString() });
      logToPane("SNAPSHOT_REAL (" + h.SNAPSHOT_VERSION + ")", view);
    } catch (err) {
      logToPane("SNAPSHOT_REAL ERROR", err && err.message);
    }
  }

  async function btnSnapshotRepro() {
    const h = _snapHelper();
    if (!h) { logToPane("SNAPSHOT_REPRO ERROR", "snapshot helper unavailable"); return; }
    const id = expectedV2Id();
    try {
      const doc = await firebase.firestore().doc("sessionsV2/" + id).get();
      if (!doc.exists) {
        logToPane("SNAPSHOT_REPRO", { session_id: id, exists: false,
          hint: "Run 'Create canary session' first." });
        return;
      }
      const data = doc.data();
      const a = h.renderSessionSnapshot(data, { generated_at_iso: "PIN_A" });
      const b = h.renderSessionSnapshot(data, { generated_at_iso: "PIN_B" });
      a.generated_at_iso = "PIN";
      b.generated_at_iso = "PIN";
      const aJson = JSON.stringify(a);
      const bJson = JSON.stringify(b);
      const identical = (aJson === bJson);
      logToPane("SNAPSHOT_REPRO", {
        session_id:        id,
        snapshot_version:  h.SNAPSHOT_VERSION,
        byte_identical:    identical,
        a_length_bytes:    aJson.length,
        b_length_bytes:    bJson.length,
        result:            identical ? "PASS" : "FAIL"
      });
    } catch (err) {
      logToPane("SNAPSHOT_REPRO ERROR", err && err.message);
    }
  }

  async function btnSimulateDcrDualWrite() {
    const h = _snapHelper();
    if (!h) { logToPane("SIMULATE_DCR ERROR", "snapshot helper unavailable"); return; }
    const id  = expectedV2Id();
    const ref = firebase.firestore().doc("sessionsV2/" + id);
    const actor = firebase.auth().currentUser;
    const actorEmail = (actor && actor.email) || "unknown";
    const fakeSubmissionId = "canary_dcr_" + Date.now();
    try {
      const snap = await ref.get();
      if (!snap.exists) {
        logToPane("SIMULATE_DCR ERROR", { v2_id: id, exists: false,
          hint: "Run 'Create canary session' first." });
        return;
      }
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const photoCount = 3;
      const tlEntry = {
        ts:         new Date(),
        actor:      { type: "admin", uid: (actor && actor.uid) || null,
                      email: actorEmail },
        event:      "dcr.submitted",
        title:      "Canary: simulated DCR submit",
        field_path: "components.dcr",
        from:       "missing",
        to:         "complete",
        ref:        fakeSubmissionId,
        client:     { app_version: "canary-harness-36a", platform: "browser" }
      };
      await ref.update({
        "components.dcr.status":          "complete",
        "components.dcr.last_event":      "dcr.submitted",
        "components.dcr.last_event_at":   sts,
        "components.dcr.completed_at":    sts,
        "components.dcr.ref":             fakeSubmissionId,
        "components.photos.status":       "complete",
        "components.photos.count":        photoCount,
        "components.photos.last_event":   "photos.complete",
        "components.photos.last_event_at": sts,
        "components.photos.completed_at": sts,
        "refs.dcr_id":                    fakeSubmissionId,
        "refs.dcr_submission_id":         fakeSubmissionId,
        timeline:                         firebase.firestore.FieldValue.arrayUnion(tlEntry),
        updated_at:                       sts
      });
      const after = await ref.get();
      const view = h.renderSessionSnapshot(after.data(),
        { generated_at_iso: new Date().toISOString() });
      logToPane("SIMULATE_DCR OK", {
        v2_session_id:    id,
        fake_submission:  fakeSubmissionId,
        photo_count:      photoCount,
        snapshot_version: h.SNAPSHOT_VERSION,
        rendered_dcr_status:    view.components.dcr.status,
        rendered_dcr_ref:       view.components.dcr.ref,
        rendered_photo_count:   view.components.photos.count,
        timeline_entries:       (after.data().timeline || []).length
      });
    } catch (err) {
      logToPane("SIMULATE_DCR ERROR", err && err.message);
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

  /* Phase 36a hotfix2 — Cleanup APPLY wiring.
   *
   * Original modal path proved unreliable in real Chrome (button #8
   * appeared to do nothing). Switched to a self-contained two-step
   * inline confirmation:
   *   1st click  -> button text becomes "CONFIRM DELETE — click again (Ns)"
   *                 and arms for 8 seconds; pane gets ARM line.
   *   2nd click  -> fires cleanup POST, logs result, disarms.
   *   no 2nd     -> auto-disarms after 8s, pane gets DISARM line.
   *
   * No dependency on the separate modal element. Same button id
   * (sv2c-btn-cleanup-apply) handles both arm + confirm. Idempotent —
   * safe to spam-click during the arm window without firing twice.
   *
   * The old modal (sv2c-confirm-modal) remains as orphan HTML;
   * performCleanupApply() is kept as a back-compat fallback for the
   * modal's "Delete canary docs" button if anyone reaches it.
   */
  let _cleanupArmedUntil = 0;
  let _cleanupTimeoutId  = null;

  function _resetCleanupArm() {
    _cleanupArmedUntil = 0;
    if (_cleanupTimeoutId) { clearTimeout(_cleanupTimeoutId); _cleanupTimeoutId = null; }
    const btn = $("sv2c-btn-cleanup-apply");
    if (btn) {
      btn.textContent = "8. Cleanup (APPLY)";
      btn.style.background = "#fee2e2";
      btn.style.color      = "#991b1b";
      btn.style.borderColor = "#fca5a5";
    }
  }

  function _armCleanup(seconds) {
    const btn = $("sv2c-btn-cleanup-apply");
    _cleanupArmedUntil = Date.now() + seconds * 1000;
    if (btn) {
      btn.textContent      = "CONFIRM DELETE — click again (" + seconds + "s)";
      btn.style.background = "#991b1b";
      btn.style.color      = "#fff";
      btn.style.borderColor = "#7f1d1d";
    }
    if (_cleanupTimeoutId) clearTimeout(_cleanupTimeoutId);
    _cleanupTimeoutId = setTimeout(function () {
      logToPane("CLEANUP_APPLY DISARMED", "auto-disarmed after " + seconds + "s without confirm");
      _resetCleanupArm();
    }, seconds * 1000);
  }

  async function btnCleanupApply() {
    try { console.log("[sessionsV2.canary] btnCleanupApply fired"); } catch (_e) {}
    const url = window.CLEANUP_SESSION_V2_CANARY_URL;
    if (!url) {
      logToPane("CLEANUP_APPLY ERROR", "CLEANUP_SESSION_V2_CANARY_URL unset");
      return;
    }
    // Two-step inline arm/confirm.
    if (Date.now() > _cleanupArmedUntil) {
      _armCleanup(8);
      logToPane("CLEANUP_APPLY ARMED",
        "click the same button again within 8s to confirm deletion of all environment=debug, source=canary docs");
      return;
    }
    // Confirmed click within arm window. Fire.
    if (_cleanupTimeoutId) { clearTimeout(_cleanupTimeoutId); _cleanupTimeoutId = null; }
    const btn = $("sv2c-btn-cleanup-apply");
    if (btn) { btn.disabled = true; btn.textContent = "DELETING..."; }
    try {
      const result = await _postWithAuth(url, { dry_run: false });
      logToPane("CLEANUP_APPLY", result);
    } catch (err) {
      logToPane("CLEANUP_APPLY ERROR", (err && err.message) || "unknown");
    } finally {
      _cleanupArmedUntil = 0;
      if (btn) { btn.disabled = false; }
      _resetCleanupArm();
    }
  }

  // Kept for back-compat — modal "Delete canary docs" button still
  // calls this if someone reaches it via the modal path.
  async function performCleanupApply() {
    try { console.log("[sessionsV2.canary] performCleanupApply fired (legacy modal path)"); } catch (_e) {}
    const url = window.CLEANUP_SESSION_V2_CANARY_URL;
    if (!url) {
      logToPane("CLEANUP_APPLY ERROR", "CLEANUP_SESSION_V2_CANARY_URL unset");
      return;
    }
    try {
      const result = await _postWithAuth(url, { dry_run: false });
      logToPane("CLEANUP_APPLY (legacy modal)", result);
      closeConfirmModal();
    } catch (err) {
      logToPane("CLEANUP_APPLY ERROR", (err && err.message) || "unknown");
    }
  }

  // Phase 36a hotfix: idempotent binding via dataset marker. Safe to
  // call wire() multiple times — bind only fires once per element.
  function wire() {
    const BINDINGS = [
      // Phase 35a
      ["sv2c-btn-diagnose",        btnDiagnose],
      ["sv2c-btn-compute-id",      btnComputeId],
      ["sv2c-btn-create",          btnCreateCanary],
      ["sv2c-btn-recreate",        btnRecreateSame],
      ["sv2c-btn-read-back",       btnReadBack],
      ["sv2c-btn-reconcile",       btnReconcile],
      ["sv2c-btn-cleanup-dry",     btnCleanupDry],
      ["sv2c-btn-cleanup-apply",   btnCleanupApply],
      ["sv2c-confirm-apply",       performCleanupApply],
      // Phase 35b clock-out
      ["sv2c-btn-advance-inprog",  btnAdvanceToInProgress],
      ["sv2c-btn-clockout-cf",     btnCallClockOutCF],
      ["sv2c-btn-clockout-again",  btnCallClockOutCFAgain],
      // Phase 36a snapshot (read-only)
      ["sv2c-btn-snapshot-canary", btnSnapshotCanary],
      ["sv2c-btn-snapshot-real",   btnSnapshotReal],
      ["sv2c-btn-snapshot-repro",  btnSnapshotRepro],
      // Phase 36a.2 simulated DCR dual-write (admin direct write)
      ["sv2c-btn-simulate-dcr",    btnSimulateDcrDualWrite],
      ["sv2c-btn-clear-pane",      function () {
        const pane = $("sv2c-result");
        if (pane) pane.value = "";
      }]
    ];
    let bound = 0;
    let already = 0;
    const missing = [];
    BINDINGS.forEach(function (pair) {
      const id = pair[0], fn = pair[1];
      const el = $(id);
      if (!el) { missing.push(id); return; }
      if (el.dataset.sv2cBound === "1") { already++; return; }
      el.addEventListener("click", fn);
      el.dataset.sv2cBound = "1";
      bound++;
    });
    try {
      console.log("[sessionsV2.canary] handlers bound",
        { bound: bound, already_bound: already, missing: missing });
    } catch (_e) {}
    return { bound: bound, already: already, missing: missing };
  }

  function init()    { try { console.log("[sessionsV2.canary] init() called"); } catch (_e) {} return wire(); }
  function refresh() { try { console.log("[sessionsV2.canary] refresh() called"); } catch (_e) {} return wire(); }

  window.__pioneerAdmin.tabs.sessionsv2Canary = { init: init, refresh: refresh, _wire: wire };

  // Phase 36a safety net: bind on DOMContentLoaded too, in case admin.js's
  // tab-activator path doesn't reach us (e.g., flag mis-set, panel
  // re-rendered after init). Idempotent via dataset marker.
  function safeNetBind() {
    try {
      const r = wire();
      console.log("[sessionsV2.canary] DOMContentLoaded self-bind", r);
    } catch (e) {
      try { console.warn("[sessionsV2.canary] safeNetBind threw", e && e.message); } catch (_e) {}
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeNetBind, { once: true });
  } else {
    safeNetBind();
  }

  try { console.log("[sessionsV2.canary] module registered + safety-net armed"); } catch (_e) {}
}());
