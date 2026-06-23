/* Pioneer DCR Hub — Phase 32B-1 IndexedDB scaffold for clock events.
 *
 * STATUS: FOUNDATION ONLY. Not loaded by any production page. Not wired
 * into service-clock.js. Reachable only from /queue/clock-queue-test.html
 * for harness exercise. Will be activated when 32B-3 worker + 32B-2
 * optimistic UI ship in a later sprint.
 *
 * Separate database from Phase 31's pioneer-queue. Reasons:
 *   - Different durability stakes: DCR queue can lose a row (recoverable
 *     via re-submit); clock queue cannot (payroll integrity).
 *   - Different lifecycle: DCR events are independent; clock events have
 *     in/out ordering dependencies.
 *   - Different idempotency keys.
 *   - Isolation reduces blast radius if one queue has a bug.
 *
 * Layout:
 *   Database: "pioneer-clock-queue"
 *   Version:  1
 *
 *   Object stores:
 *     events  — keyed by event_id (client UUIDv4)
 *               value shape documented in docs/phase32b/scope.md
 *               status enum: queued | uploading | submitted |
 *                            failed_will_retry | failed_permanent
 *               (terminal success deletes the row; "submitted" is a
 *                transient state during the success ack window)
 *               indexes:
 *                 status            — for getNextDrainable() queries
 *                 next_attempt_at   — for retry scheduling
 *                 [staff_uid, assignment_id] — compound, for ordering
 *                   check (clock-out blocks until matching clock-in
 *                   drains successfully)
 *
 *     meta    — keyed by `key` string
 *               key="schema_version" : { value: 1 }
 *               key="last_drain_at"  : { value: epoch_ms }
 *               key="device_id"      : { value: string }  ← mirrors Phase 31
 *
 * Public API attaches to self.PIONEER_CLOCK_QUEUE_DB. Pattern mirrors
 * Phase 31's self.PIONEER_QUEUE_DB.
 */

(function () {
  "use strict";

  const DB_NAME    = "pioneer-clock-queue";
  const DB_VERSION = 1;

  const STORES = {
    EVENTS: "events",
    META:   "meta"
  };

  const STATUS = {
    QUEUED:             "queued",
    UPLOADING:          "uploading",
    SUBMITTED:          "submitted",
    FAILED_WILL_RETRY:  "failed_will_retry",
    FAILED_PERMANENT:   "failed_permanent"
  };

  const TYPES = {
    CLOCK_IN:  "clock_in",
    CLOCK_OUT: "clock_out"
  };

  // ---------- promisify ----------

  function promisifyRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  function promisifyTx(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort    = function () { reject(tx.error || new Error("Transaction aborted")); };
      tx.onerror    = function () { reject(tx.error || new Error("Transaction error")); };
    });
  }

  // ---------- open + upgrade ----------

  let _dbPromise = null;

  function open() {
    if (_dbPromise) return _dbPromise;
    if (!("indexedDB" in self)) {
      _dbPromise = Promise.reject(new Error("IndexedDB not supported"));
      return _dbPromise;
    }
    _dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        // V1 schema — additive create-if-missing pattern matches Phase 31.
        if (!db.objectStoreNames.contains(STORES.EVENTS)) {
          const events = db.createObjectStore(STORES.EVENTS, { keyPath: "event_id" });
          events.createIndex("status",          "status",          { unique: false });
          events.createIndex("next_attempt_at", "next_attempt_at", { unique: false });
          // Compound index for ordering check — letting the worker find
          // "the matching clock-in for this clock-out" cheaply.
          events.createIndex("by_staff_assignment", ["staff_uid", "assignment_id"], { unique: false });
          events.createIndex("by_intent_ts", "intent_ts", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: "key" });
        }
      };
      req.onsuccess = function () {
        const db = req.result;
        // Same version-change safety as Phase 31's queue-db.js: close
        // this connection if a newer-version tab opens, so the new tab
        // can upgrade without blocking.
        db.onversionchange = function () { try { db.close(); } catch (_e) {} _dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }

  async function tx(storeNames, mode, work) {
    const db    = await open();
    const trans = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? storeNames.map(function (n) { return trans.objectStore(n); })
      : trans.objectStore(storeNames);
    const result = await Promise.resolve(work(stores, trans));
    await promisifyTx(trans);
    return result;
  }

  // ---------- validation ----------

  // Shape-check at enqueue time. Saves us a round-trip to Firestore if
  // the event is missing required fields. Required vs optional matches
  // the Cloud Function design at functions/_drafts/submitClockEventV1.js.
  function validateEvent(ev) {
    const errs = [];
    // Hard-return on null/undefined/non-object so later field reads
    // don't TypeError. Without this guard, validateEvent(null) throws
    // and any caller that doesn't try/catch would crash. Surfaced by
    // Phase 32B-1 harness test 2026-06-23.
    if (!ev || typeof ev !== "object") {
      errs.push("event must be an object");
      return errs;
    }
    if (!ev.event_id  || typeof ev.event_id !== "string") errs.push("event_id required (string)");
    if (ev.schema_version !== 1)                errs.push("schema_version must be 1");
    if (ev.type !== TYPES.CLOCK_IN && ev.type !== TYPES.CLOCK_OUT)
      errs.push("type must be clock_in or clock_out");
    if (!ev.staff_uid    || typeof ev.staff_uid !== "string")    errs.push("staff_uid required");
    if (!ev.staff_email  || typeof ev.staff_email !== "string")  errs.push("staff_email required");
    if (typeof ev.intent_ts       !== "number") errs.push("intent_ts required (number, epoch ms)");
    if (typeof ev.intent_ts_floor !== "number") errs.push("intent_ts_floor required (number, epoch ms)");
    if (ev.type === TYPES.CLOCK_IN && !ev.assignment_id)
      errs.push("assignment_id required for clock_in events");
    if (ev.type === TYPES.CLOCK_OUT && !ev.session_id)
      errs.push("session_id required for clock_out events");
    return errs;
  }

  // ---------- events ----------

  function enqueueEvent(input) {
    const errs = validateEvent(input);
    if (errs.length) return Promise.reject(new Error("enqueueEvent: " + errs.join("; ")));
    const now = Date.now();
    const row = Object.assign({
      status:             STATUS.QUEUED,
      attempt_count:      0,
      next_attempt_at:    now,
      last_attempt_at:    null,
      last_error_code:    null,
      last_error_message: null,
      attempts:           [],
      created_at:         now,
      updated_at:         now
    }, input, {
      // Force these to overwrite any caller-supplied values to defend
      // against accidental re-enqueue with stale fields.
      event_id:   input.event_id,
      updated_at: now
    });
    return tx(STORES.EVENTS, "readwrite", function (store) {
      return promisifyRequest(store.put(row));
    });
  }

  function getEvent(eventId) {
    return tx(STORES.EVENTS, "readonly", function (store) {
      return promisifyRequest(store.get(eventId));
    }).then(function (row) { return row || null; });
  }

  function getAllEvents() {
    return tx(STORES.EVENTS, "readonly", function (store) {
      return promisifyRequest(store.getAll());
    }).then(function (rows) { return rows || []; });
  }

  // Returns the oldest drainable event by intent_ts. "Drainable" means
  // status is queued or failed_will_retry AND next_attempt_at <= now.
  // Worker calls this in a loop until null.
  function getNextDrainable(nowMs) {
    nowMs = nowMs || Date.now();
    return tx(STORES.EVENTS, "readonly", function (store) {
      const statusIdx = store.index("status");
      return Promise.all([
        promisifyRequest(statusIdx.getAll(STATUS.QUEUED)),
        promisifyRequest(statusIdx.getAll(STATUS.FAILED_WILL_RETRY))
      ]);
    }).then(function (parts) {
      const all = parts[0].concat(parts[1]);
      const ready = all.filter(function (r) {
        return !r.next_attempt_at || r.next_attempt_at <= nowMs;
      });
      // Order by intent_ts ASC so clock-ins drain before clock-outs that
      // followed them. Worker-side ordering (clock-out waits for its
      // matching clock-in) is enforced separately via
      // getEventsByTechAndAssignment.
      ready.sort(function (a, b) {
        return (a.intent_ts || a.created_at) - (b.intent_ts || b.created_at);
      });
      return ready[0] || null;
    });
  }

  // Returns all events for one tech + assignment, ordered by intent_ts.
  // The 32B-3 worker will use this to enforce in-before-out ordering:
  // a queued clock_out for (uid, asgn) waits until any earlier-intent_ts
  // clock_in for the same (uid, asgn) has been submitted (or failed
  // permanently — in which case the clock-out is moot).
  function getEventsByTechAndAssignment(staffUid, assignmentId) {
    return tx(STORES.EVENTS, "readonly", function (store) {
      const idx = store.index("by_staff_assignment");
      return promisifyRequest(idx.getAll(IDBKeyRange.only([staffUid, assignmentId])));
    }).then(function (rows) {
      return (rows || []).slice().sort(function (a, b) {
        return (a.intent_ts || 0) - (b.intent_ts || 0);
      });
    });
  }

  function markStatus(eventId, status, patch) {
    return tx(STORES.EVENTS, "readwrite", function (store) {
      return promisifyRequest(store.get(eventId)).then(function (row) {
        if (!row) throw new Error("markStatus: no event " + eventId);
        row.status     = status;
        row.updated_at = Date.now();
        if (patch && typeof patch === "object") {
          Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        }
        return promisifyRequest(store.put(row));
      });
    });
  }

  function appendAttempt(eventId, attempt) {
    return tx(STORES.EVENTS, "readwrite", function (store) {
      return promisifyRequest(store.get(eventId)).then(function (row) {
        if (!row) throw new Error("appendAttempt: no event " + eventId);
        if (!Array.isArray(row.attempts)) row.attempts = [];
        row.attempts.push(Object.assign({ started_at: Date.now() }, attempt || {}));
        row.attempt_count = row.attempts.length;
        row.updated_at    = Date.now();
        return promisifyRequest(store.put(row));
      });
    });
  }

  function removeEvent(eventId) {
    return tx(STORES.EVENTS, "readwrite", function (store) {
      return promisifyRequest(store.delete(eventId));
    });
  }

  // ---------- meta ----------

  function getMeta(key) {
    return tx(STORES.META, "readonly", function (store) {
      return promisifyRequest(store.get(key));
    }).then(function (row) { return row ? row.value : null; });
  }

  function setMeta(key, value) {
    return tx(STORES.META, "readwrite", function (store) {
      return promisifyRequest(store.put({ key: key, value: value }));
    });
  }

  // ---------- diagnostics ----------

  function stats() {
    return tx(STORES.EVENTS, "readonly", function (store) {
      const statusIdx = store.index("status");
      return Promise.all([
        promisifyRequest(store.count()),
        promisifyRequest(statusIdx.count(STATUS.QUEUED)),
        promisifyRequest(statusIdx.count(STATUS.UPLOADING)),
        promisifyRequest(statusIdx.count(STATUS.SUBMITTED)),
        promisifyRequest(statusIdx.count(STATUS.FAILED_WILL_RETRY)),
        promisifyRequest(statusIdx.count(STATUS.FAILED_PERMANENT))
      ]).then(function (parts) {
        return {
          total:              parts[0],
          queued:             parts[1],
          uploading:          parts[2],
          submitted:          parts[3],
          failed_will_retry:  parts[4],
          failed_permanent:   parts[5]
        };
      });
    });
  }

  function clearAll() {
    return tx([STORES.EVENTS, STORES.META], "readwrite", function (stores) {
      return Promise.all(stores.map(function (s) { return promisifyRequest(s.clear()); }));
    });
  }

  // ---------- public API ----------

  self.PIONEER_CLOCK_QUEUE_DB = {
    // lifecycle
    open:                        open,
    enqueueEvent:                enqueueEvent,
    getEvent:                    getEvent,
    getAllEvents:                getAllEvents,
    getNextDrainable:            getNextDrainable,
    getEventsByTechAndAssignment: getEventsByTechAndAssignment,
    markStatus:                  markStatus,
    appendAttempt:               appendAttempt,
    removeEvent:                 removeEvent,
    // meta
    getMeta:                     getMeta,
    setMeta:                     setMeta,
    // diagnostics
    stats:                       stats,
    clearAll:                    clearAll,
    // constants
    STATUS:                      STATUS,
    TYPES:                       TYPES,
    STORES:                      STORES,
    DB_NAME:                     DB_NAME,
    DB_VERSION:                  DB_VERSION,
    // schema validation (exposed for harness + future client wire)
    validateEvent:               validateEvent
  };
}());
