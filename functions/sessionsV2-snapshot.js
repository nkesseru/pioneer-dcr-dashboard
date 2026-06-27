/* sessionsV2-snapshot.js — Phase 36a.1 SessionV2 -> Snapshot renderer.
 *
 * Operation One Truth — DCR is a PROJECTION of Session state.
 *
 * Responsibility:
 *   Take a SessionV2 document and produce a canonical, reproducible
 *   SessionSnapshot. The Snapshot is the "what would a DCR show?" form
 *   of a Session. The Session is the truth; the Snapshot is strictly
 *   derived from session state.
 *
 * Guarantees:
 *   - PURE function. No async, no I/O, no Firestore reads. The only
 *     clock read is the implicit `new Date()` default for
 *     generated_at_iso when the caller does not supply one.
 *   - Same Session input -> byte-identical Snapshot output (excluding
 *     the generated_at_iso field). Reproducibility is the invariant.
 *   - Field allowlist only: never blanket-serializes. New fields require
 *     a SNAPSHOT_VERSION bump.
 *   - Snapshot version stamped on every output for historical rendering
 *     fidelity (a v1.0.0 snapshot must render identically forever).
 *
 * Surface (browser: self.PIONEER_SESSIONS_V2_SNAPSHOT; node: module.exports):
 *   - SNAPSHOT_VERSION                          string constant "v1.0.0"
 *   - renderSessionSnapshot(session, options?)  -> SessionSnapshot
 *   - deriveCompletion(session)                 -> { pct, blockers }
 *
 * Snapshot schema: see docs/sessionsV2/SNAPSHOT_SCHEMA.md
 *
 * Scope (Phase 36a.1):
 *   - Renderer only. No splice into submitDcrV1 (Phase 36a.2).
 *   - No parity_log writes (Phase 36a.2).
 *   - No dcr_snapshots subcollection writes (Phase 36f).
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PIONEER_SESSIONS_V2_SNAPSHOT = factory();
  }
}(typeof self !== "undefined"
    ? self
    : (typeof globalThis !== "undefined" ? globalThis : this),
  function () {
  "use strict";

  var SNAPSHOT_VERSION = "v1.0.0";

  /* ----- Helpers (private) ----- */

  function _isObject(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x);
  }

  // Normalize any timestamp-shaped value to ISO 8601 string or null.
  // Accepts: Firestore Timestamp (toDate), Date, ISO string, ms epoch number.
  function _iso(ts) {
    if (ts == null) return null;
    if (typeof ts === "string") return ts;
    if (typeof ts === "number") {
      var d = new Date(ts);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (ts && typeof ts.toDate === "function") {
      try {
        var d2 = ts.toDate();
        return (d2 && typeof d2.toISOString === "function")
          ? d2.toISOString()
          : null;
      } catch (_e) { return null; }
    }
    if (ts instanceof Date) {
      return isNaN(ts.getTime()) ? null : ts.toISOString();
    }
    return null;
  }

  function _str(x) {
    return (x == null) ? null : String(x);
  }

  function _intOrNull(x) {
    if (x == null) return null;
    var n = Number(x);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function _arr(x) {
    return Array.isArray(x) ? x : [];
  }

  /* ----- Component projection -----
   *
   * Each component is projected with a KNOWN field shape. Never
   * blanket-serialize the input. New per-component fields require
   * a SNAPSHOT_VERSION bump.
   */
  function _projectComponent(name, comp) {
    var c = _isObject(comp) ? comp : {};
    var base = {
      status:           _str(c.status) || "missing",
      started_at_iso:   _iso(c.started_at),
      completed_at_iso: _iso(c.completed_at)
    };
    if (name === "photos") {
      base.count = _intOrNull(c.count);
    }
    if (name === "checklist") {
      base.pct            = _intOrNull(c.pct);
      base.items_total    = _intOrNull(c.items_total);
      base.items_complete = _intOrNull(c.items_complete);
    }
    if (name === "dcr") {
      base.ref        = _str(c.ref);
      base.last_event = _str(c.last_event);
    }
    if (name === "customer_email") {
      base.ref        = _str(c.ref);
      base.last_event = _str(c.last_event);
    }
    return base;
  }

  /* ----- Derived completion -----
   *
   * Mirrors the SCHEMA.md spec. Not persisted; computed at render time.
   * A Session with no expected_components is 0% with a "no_expected_components"
   * blocker, NOT 100%.
   */
  function deriveCompletion(session) {
    var s = _isObject(session) ? session : {};
    var expected = _arr(s.expected_components);
    if (expected.length === 0) {
      return { pct: 0, blockers: ["no_expected_components"] };
    }
    var components = _isObject(s.components) ? s.components : {};
    var done = 0;
    var blockers = [];
    for (var i = 0; i < expected.length; i++) {
      var name = _str(expected[i]);
      if (!name) continue;
      var c  = components[name];
      var st = (c && c.status) ? String(c.status) : "missing";
      if (st === "complete" || st === "not_applicable") {
        done++;
      } else {
        blockers.push(name + ":" + st);
      }
    }
    return {
      pct:      Math.round(100 * done / expected.length),
      blockers: blockers
    };
  }

  /* ----- Main renderer ----- */
  function renderSessionSnapshot(session, options) {
    var opts = _isObject(options) ? options : {};
    var s    = _isObject(session) ? session : {};
    var components = _isObject(s.components) ? s.components : {};
    var refs       = _isObject(s.refs)       ? s.refs       : {};

    var derived     = deriveCompletion(s);
    var generatedAt = opts.generated_at_iso || new Date().toISOString();

    return {
      snapshot_version: SNAPSHOT_VERSION,
      generated_at_iso: generatedAt,

      session_id:     _str(s.session_id),
      session_source: _str(s.source),
      session_status: _str(s.status),
      service_date:   _str(s.service_date),

      work: {
        customer: {
          id:   _str(s.customer_id),
          slug: _str(s.customer_slug),
          name: _str(s.customer_name)
        },
        staff: {
          uid:   _str(s.staff_uid),
          email: _str(s.staff_email)
        },
        clock_in_at_iso:   _iso(s.clock_in_at),
        clock_out_at_iso:  _iso(s.clock_out_at),
        effective_minutes: _intOrNull(s.effective_minutes)
      },

      components: {
        clock:          _projectComponent("clock",          components.clock),
        gps:            _projectComponent("gps",            components.gps),
        photos:         _projectComponent("photos",         components.photos),
        checklist:      _projectComponent("checklist",      components.checklist),
        dcr:            _projectComponent("dcr",            components.dcr),
        customer_email: _projectComponent("customer_email", components.customer_email),
        payroll:        _projectComponent("payroll",        components.payroll)
      },

      refs: {
        dcr_id:      _str(refs.dcr_id),
        photo_paths: _arr(refs.photo_paths)
                      .map(_str)
                      .filter(function (x) { return x != null; })
      },

      notes: _str(s.notes),

      derived: {
        expected_components: _arr(s.expected_components)
                              .map(_str)
                              .filter(function (x) { return x != null; }),
        completion_pct:      derived.pct,
        blockers:            derived.blockers
      }
    };
  }

  /* ----- Public surface ----- */
  return {
    SNAPSHOT_VERSION:       SNAPSHOT_VERSION,
    renderSessionSnapshot:  renderSessionSnapshot,
    deriveCompletion:       deriveCompletion
  };
}));
