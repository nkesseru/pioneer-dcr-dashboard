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

  /* ----- POST with hard timeout ----- */
  async function _postCreateSessionV2(payload) {
    var url = global.CREATE_SESSION_V2_URL;
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

  /* ----- Failure: enqueue retry ----- */
  async function _enqueueRetry(payload, lastErrorSummary) {
    var user = firebase.auth().currentUser;
    if (!user) return;
    var sts = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await firebase.firestore().collection("pending_session_writes").add({
        session_id:       payload.session_id,
        event_type:       "v2.create.retry",
        event_id:         "v2create-" + payload.session_id,
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
      _warn("enqueue retry failed", err && err.message);
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
    await _enqueueRetry(payload, (result.body && result.body.error) || result.error);
    return {
      ok:        false,
      enqueued:  true,
      v2_id:     v2Id,
      status:    status,
      error:     (result.body && result.body.error) || result.error || "unknown"
    };
  }

  /* ----- Public surface ----- */
  global.PIONEER_SESSIONS_V2 = {
    deriveSessionV2Id:                 deriveSessionV2Id,
    isDualWriteEnabledForCurrentUser:  isDualWriteEnabledForCurrentUser,
    maybeDualWriteClockIn:             maybeDualWriteClockIn,
    getConfig:                         getConfig,
    _internal: {
      CONFIG_DOC_PATH: CONFIG_DOC_PATH,
      CONFIG_CACHE_MS: CONFIG_CACHE_MS,
      FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS
    }
  };
}(typeof self !== "undefined" ? self : this));
