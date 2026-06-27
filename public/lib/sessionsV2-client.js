/* sessionsV2-client.js — Phase 35a SessionV2 dual-write helper.
 *
 * Operation One Truth — clock-IN dual-write surface.
 *
 * Responsibility:
 *   1. Decide if dual-write should fire for the current user (server flag
 *      + per-user allowlist read from pioneer_config/session_v2_dual_write).
 *   2. Compute deterministic SessionV2 id from assignment + service_date.
 *   3. Fire createSessionV2 fire-and-forget (V1 has already committed).
 *   4. On failure, enqueue a retry entry in pending_session_writes.
 *
 * Guarantees:
 *   - Never throws — caller (service-clock.js) wraps in try anyway.
 *   - Never blocks V1 success path — only fires AFTER V1 transaction commits.
 *   - Zero behavior when window.SESSION_V2_ENABLED !== true OR caller
 *     not in allowlist.
 *
 * Surface (exposed as self.PIONEER_SESSIONS_V2):
 *   - deriveSessionV2Id(assignmentId, serviceDate, attempt?)  → string
 *   - isDualWriteEnabledForCurrentUser()                       → Promise<bool>
 *   - maybeDualWriteClockIn({ v1_session_id, assignment_id,
 *                             service_date, staff_uid, staff_email,
 *                             assignment })                    → Promise<void>
 *   - getConfig()                                              → Promise<{enabled, allowed_emails}>
 *
 * Phase 35a scope guard:
 *   - Clock-IN only. No clock-OUT helper. No status transitions.
 *   - V2 doc gets v1_session_id back-pointer. V1 doc is NOT mutated.
 *   - Reconciliation closes the loop nightly.
 */

(function (global) {
  "use strict";

  var CONFIG_DOC_PATH    = "pioneer_config/session_v2_dual_write";
  var CONFIG_CACHE_MS    = 15 * 60 * 1000;   // 15 min
  var FETCH_TIMEOUT_MS   = 5000;             // V2 POST hard cap

  var _configCache       = null;
  var _configFetchedAt   = 0;
  var _configInflight    = null;

  function _lc(s) { return String(s || "").toLowerCase().trim(); }

  function _now() { return Date.now(); }

  function _log(msg, extra) {
    try { console.log("[sessionsV2] " + msg, extra || ""); } catch (_e) {}
  }
  function _warn(msg, extra) {
    try { console.warn("[sessionsV2] " + msg, extra || ""); } catch (_e) {}
  }

  /* ----- Deterministic ID ----- */
  function deriveSessionV2Id(assignmentId, serviceDate, attempt) {
    if (!assignmentId || !serviceDate) return null;
    var att = (typeof attempt === "number" && attempt >= 1) ? attempt : 1;
    return "sess_" + assignmentId + "_" + serviceDate + "_a" + att;
  }

  /* ----- Config fetch (cached) ----- */
  async function _fetchConfig() {
    try {
      var snap = await firebase.firestore().doc(CONFIG_DOC_PATH).get();
      if (!snap.exists) {
        return { enabled: false, allowed_emails: [] };
      }
      var data = snap.data() || {};
      var emails = Array.isArray(data.allowed_emails)
        ? data.allowed_emails.map(_lc)
        : [];
      return {
        enabled:        data.enabled === true,
        allowed_emails: emails
      };
    } catch (err) {
      _warn("config fetch failed", err && err.message);
      return { enabled: false, allowed_emails: [] };
    }
  }

  async function getConfig(forceRefresh) {
    var fresh = !!forceRefresh
                || !_configCache
                || (_now() - _configFetchedAt) > CONFIG_CACHE_MS;
    if (!fresh) return _configCache;
    if (_configInflight) return _configInflight;
    _configInflight = _fetchConfig().then(function (cfg) {
      _configCache     = cfg;
      _configFetchedAt = _now();
      _configInflight  = null;
      return cfg;
    });
    return _configInflight;
  }

  /* ----- Gate ----- */
  async function isDualWriteEnabledForCurrentUser() {
    if (global.SESSION_V2_ENABLED !== true) return false;
    var user = firebase.auth().currentUser;
    var email = user && _lc(user.email);
    if (!email) return false;
    var cfg = await getConfig(false);
    if (!cfg.enabled) return false;
    return cfg.allowed_emails.indexOf(email) >= 0;
  }

  /* ----- POST with hard timeout (shared helper for any V2 endpoint) ----- */
  async function _postWithAuth(url, payload) {
    if (!url) return { ok: false, error: "no_url" };
    var user = firebase.auth().currentUser;
    if (!user) return { ok: false, error: "no_user" };

    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;

    try {
      var token = await user.getIdToken();
      var res = await fetch(url, {
        method:  "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type":  "application/json"
        },
        body:    JSON.stringify(payload),
        signal:  ctrl ? ctrl.signal : undefined
      });
      var body = await res.json().catch(function () { return {}; });
      if (timer) clearTimeout(timer);
      if (res.ok && body.ok) {
        return { ok: true, status: res.status, body: body };
      }
      return { ok: false, status: res.status, body: body };
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: (err && err.message) || "fetch_failed" };
    }
  }

  // Back-compat wrapper preserved so service-clock.js's clock-in path
  // continues working without change.
  async function _postCreateSessionV2(payload) {
    return _postWithAuth(global.CREATE_SESSION_V2_URL, payload);
  }

  /* ----- Failure: enqueue retry (shared) ----- */
  async function _enqueueRetry(eventType, payload, lastErrorSummary) {
    var user = firebase.auth().currentUser;
    if (!user) return;
    var sts = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await firebase.firestore().collection("pending_session_writes").add({
        session_id:       payload.session_id,
        event_type:       eventType,
        event_id:         eventType + "-" + payload.session_id,
        payload:          payload,
        status:           "queued",
        attempt_count:    1,
        next_attempt_at:  sts,
        last_error:       String(lastErrorSummary || "").slice(0, 500),
        staff_uid:        user.uid,
        intent_ts:        sts,
        device:           {
          app_version: String(global.APP_VERSION || "unknown"),
          platform:    (typeof navigator !== "undefined" && navigator.platform) || "unknown"
        },
        enqueued_at:      sts
      });
    } catch (err) {
      _warn("enqueue retry failed (" + eventType + ")", err && err.message);
    }
  }

  /* ----- Main entry: dual-write a clock-IN -----
   *
   * Optional fields on opts (Phase 35a-canary extension):
   *   environment:  "production" | "debug" | "emulator"   (default "production")
   *   source:       "tech_clock" | "admin_manual" | ...    (default "tech_clock")
   *   bypass_allowlist_check: true to skip the allowlist gate (canary only;
   *      caller is responsible for ensuring they have admin-equivalent auth)
   *
   * Defaults preserve production behavior. The canary harness passes
   * environment:"debug" + source:"canary" + bypass_allowlist_check:true
   * so debug runs work even if the operator isn't in the dual-write
   * allowlist.
   */
  async function maybeDualWriteClockIn(opts) {
    if (!opts || !opts.assignment_id || !opts.service_date || !opts.v1_session_id) {
      return { ok: false, skipped: true, reason: "missing_required_input" };
    }

    var bypass = opts.bypass_allowlist_check === true;
    if (!bypass) {
      var enabled;
      try {
        enabled = await isDualWriteEnabledForCurrentUser();
      } catch (err) {
        _warn("gate check failed", err && err.message);
        return { ok: false, skipped: true, reason: "gate_check_failed", error: err && err.message };
      }
      if (!enabled) return { ok: false, skipped: true, reason: "gate_disabled" };
    }

    var v2Id = deriveSessionV2Id(opts.assignment_id, opts.service_date, 1);
    if (!v2Id) return { ok: false, skipped: true, reason: "id_derivation_failed" };

    var asg = opts.assignment || {};
    var environment = opts.environment || "production";
    var source      = opts.source      || "tech_clock";
    var payload = {
      session_id:        v2Id,
      source:            source,
      session_type:      "office_cleaning",
      environment:       environment,
      attempt_number:    1,
      staff_uid:         opts.staff_uid,
      staff_email:       opts.staff_email,
      customer_id:       asg.customer_id  || "",
      customer_slug:     asg.customer_slug || asg.customer_id || "",
      customer_name:     asg.customer_name || "",
      service_date:      opts.service_date,
      assignment_id:     opts.assignment_id,
      location_id:       asg.location_id || null,
      v1_session_id:     opts.v1_session_id,
      client_session_id: null,
      client_app_version: String(global.APP_VERSION || "unknown")
    };

    _log("dual-write firing", { v2_id: v2Id, v1_id: opts.v1_session_id, env: environment, source: source });
    var result = await _postCreateSessionV2(payload);

    if (result.ok) {
      _log("dual-write OK", {
        v2_id:      v2Id,
        idempotent: !!(result.body && result.body.idempotent)
      });
      return { ok: true, v2_id: v2Id, body: result.body, status: result.status };
    }

    // Soft-skip on 503 (server flag is the source of truth — client cache
    // may be stale by a few minutes). Don't enqueue — just log.
    var status = result.status || 0;
    var bodyCode = result.body && result.body.code;
    if (status === 503 || bodyCode === "SESSION_V2_DISABLED") {
      _log("dual-write skipped (server flag off)", { status: status });
      return { ok: false, skipped: true, reason: "server_flag_off", v2_id: v2Id };
    }

    // All other failures → enqueue retry
    _warn("dual-write failed; enqueueing retry", {
      status: status,
      error:  (result.body && result.body.error) || result.error || "unknown"
    });
    await _enqueueRetry("v2.create.retry", payload, (result.body && result.body.error) || result.error);
    return {
      ok:        false,
      enqueued:  true,
      v2_id:     v2Id,
      status:    status,
      error:     (result.body && result.body.error) || result.error || "unknown"
    };
  }

  /* ----- Phase 35b: dual-write a clock-OUT (status advance) -----
   *
   * Mirrors maybeDualWriteClockIn shape. Fire-and-forget after V1 clock-out
   * transaction commits in service-clock.js. Never throws. V1 success
   * path is unchanged.
   *
   * Required opts:
   *   v2_session_id  string   (caller computes via deriveSessionV2Id)
   *   v1_session_id  string   (V1 random doc id, for audit cross-ref)
   *   staff_uid      string
   *   staff_email    string
   *   clock_out_at   ISO 8601 string
   *
   * Optional:
   *   clock_out_gps  { lat, lng, accuracy_m, status } | null
   *   environment    "production" | "debug" | "emulator"  (default production)
   *   bypass_allowlist_check  boolean (canary only)
   *
   * Returns: { ok, body?, status?, ... } status object (same shape as clock-in).
   */
  async function maybeDualWriteClockOut(opts) {
    if (!opts || !opts.v2_session_id || !opts.v1_session_id || !opts.clock_out_at) {
      return { ok: false, skipped: true, reason: "missing_required_input" };
    }

    var bypass = opts.bypass_allowlist_check === true;
    if (!bypass) {
      var enabled;
      try {
        enabled = await isDualWriteEnabledForCurrentUser();
      } catch (err) {
        _warn("clock-out gate check failed", err && err.message);
        return { ok: false, skipped: true, reason: "gate_check_failed", error: err && err.message };
      }
      if (!enabled) return { ok: false, skipped: true, reason: "gate_disabled" };
    }

    var environment = opts.environment || "production";
    var payload = {
      session_id:    opts.v2_session_id,
      v1_session_id: opts.v1_session_id,
      clock_out_at:  opts.clock_out_at,
      clock_out_gps: opts.clock_out_gps || null,
      environment:   environment
    };

    _log("clock-out dual-write firing", {
      v2_id: opts.v2_session_id, v1_id: opts.v1_session_id, env: environment
    });
    var result = await _postWithAuth(global.UPDATE_SESSION_V2_CLOCK_OUT_URL, payload);

    if (result.ok) {
      _log("clock-out dual-write OK", {
        v2_id:      opts.v2_session_id,
        advanced:   !!(result.body && result.body.advanced),
        idempotent: !!(result.body && result.body.idempotent)
      });
      return { ok: true, body: result.body, status: result.status };
    }

    var status = result.status || 0;
    var bodyCode = result.body && result.body.code;

    // 503 flag-off: soft skip, no enqueue.
    if (status === 503 || bodyCode === "SESSION_V2_DISABLED") {
      _log("clock-out skipped (server flag off)", { status: status });
      return { ok: false, skipped: true, reason: "server_flag_off" };
    }

    // 409 INVALID_STATE: terminal state divergence — do NOT enqueue
    // (Recovery Toolbox owns these, per architectural decision).
    if (status === 409 || bodyCode === "INVALID_STATE") {
      _warn("clock-out refused (invalid state)", {
        status: status, current: result.body && result.body.current_status
      });
      return { ok: false, skipped: true, reason: "invalid_state", body: result.body };
    }

    // 404 V2_NOT_FOUND: enqueue retry (Phase 35c worker will create-then-advance).
    // Plus any other failure → enqueue.
    _warn("clock-out failed; enqueueing retry", {
      status: status, code: bodyCode,
      error:  (result.body && result.body.error) || result.error || "unknown"
    });
    await _enqueueRetry("v2.clockout.retry", payload, (result.body && result.body.error) || result.error);
    return {
      ok:       false,
      enqueued: true,
      status:   status,
      code:     bodyCode || null,
      error:    (result.body && result.body.error) || result.error || "unknown"
    };
  }

  /* ----- Public surface ----- */
  global.PIONEER_SESSIONS_V2 = {
    deriveSessionV2Id:                 deriveSessionV2Id,
    isDualWriteEnabledForCurrentUser:  isDualWriteEnabledForCurrentUser,
    maybeDualWriteClockIn:             maybeDualWriteClockIn,
    maybeDualWriteClockOut:            maybeDualWriteClockOut,
    getConfig:                         getConfig,
    _internal: {
      CONFIG_DOC_PATH: CONFIG_DOC_PATH,
      CONFIG_CACHE_MS: CONFIG_CACHE_MS,
      FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS
    }
  };
}(typeof self !== "undefined" ? self : this));
