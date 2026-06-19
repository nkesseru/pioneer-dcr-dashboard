/* Pioneer DCR Hub — Phase 31 prototype: IndexedDB queue scaffold.
 *
 * STATUS: PROTOTYPE. Not loaded by any production page. Reachable only
 * from /queue/queue-test.html and any future opt-in branch of the DCR form
 * gated by window.OFFLINE_QUEUE_ENABLED.
 *
 * Layout:
 *   Database:   "pioneer-queue"
 *   Version:    1
 *
 *   Object stores:
 *     drafts        — keyed by submission_id (client UUIDv4)
 *                     value: { submission_id, customer_slug, tech_slug,
 *                              form_data, photos_meta, signature_data_url,
 *                              created_at, updated_at }
 *                     NOTE: drafts do NOT include photo blobs. Blobs live
 *                     in module memory while the form is open; on Submit
 *                     they move into the `pending` store along with the
 *                     finalized payload.
 *
 *     pending       — keyed by submission_id
 *                     value: { submission_id, payload, photos: [{blob,
 *                              content_type, size_bytes, planned_path,
 *                              upload_status}], signature_blob, status,
 *                              attempts: [{started_at, stage, code,
 *                              message}], created_at, updated_at,
 *                              next_attempt_at, attempts_count }
 *                     One row per in-flight DCR. Survives reload.
 *
 *     assignments   — keyed by assignment_id (mirror of service_assignments doc id)
 *     customers     — keyed by slug
 *     techs         — keyed by slug
 *                     All three are pure caches refreshed from Firestore
 *                     whenever online. processQueue reads them when
 *                     hydrating the form offline.
 *
 *     meta          — keyed by string key
 *                     One special row at key="roster" with cached_at
 *                     timestamp. Other meta rows reserved (sw_version,
 *                     last_drain_at, etc.).
 *
 * Status enum on pending rows:
 *   queued                — never tried
 *   uploading_photos      — actively uploading
 *   uploading_signature   — actively uploading
 *   posting_payload       — calling submitDcrV1
 *   submitted             — terminal success
 *   failed_will_retry     — scheduled for backoff retry
 *   failed_permanent      — exceeded retries, needs human
 *
 * All methods return Promises. No dependency on idb-keyval — uses the
 * raw IndexedDB API wrapped in a thin promisify layer so this file ships
 * as a single self-contained script.
 */

(function () {
  "use strict";

  const DB_NAME    = "pioneer-queue";
  const DB_VERSION = 1;

  const STORES = {
    DRAFTS:      "drafts",
    PENDING:     "pending",
    ASSIGNMENTS: "assignments",
    CUSTOMERS:   "customers",
    TECHS:       "techs",
    META:        "meta"
  };

  const STATUS = {
    QUEUED:               "queued",
    UPLOADING_PHOTOS:     "uploading_photos",
    UPLOADING_SIGNATURE:  "uploading_signature",
    POSTING_PAYLOAD:      "posting_payload",
    SUBMITTED:            "submitted",
    FAILED_WILL_RETRY:    "failed_will_retry",
    FAILED_PERMANENT:     "failed_permanent"
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
      _dbPromise = Promise.reject(new Error("IndexedDB not supported in this environment"));
      return _dbPromise;
    }
    _dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        const db = req.result;
        // V1 schema — create only what's missing so future upgrades can
        // be additive. Object stores use submission_id / slug / id as the
        // primary key (out-of-line keys are NOT used).
        if (!db.objectStoreNames.contains(STORES.DRAFTS)) {
          db.createObjectStore(STORES.DRAFTS,      { keyPath: "submission_id" });
        }
        if (!db.objectStoreNames.contains(STORES.PENDING)) {
          const pending = db.createObjectStore(STORES.PENDING, { keyPath: "submission_id" });
          pending.createIndex("status",          "status",          { unique: false });
          pending.createIndex("next_attempt_at", "next_attempt_at", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.ASSIGNMENTS)) {
          db.createObjectStore(STORES.ASSIGNMENTS, { keyPath: "assignment_id" });
        }
        if (!db.objectStoreNames.contains(STORES.CUSTOMERS)) {
          db.createObjectStore(STORES.CUSTOMERS,   { keyPath: "slug" });
        }
        if (!db.objectStoreNames.contains(STORES.TECHS)) {
          db.createObjectStore(STORES.TECHS,       { keyPath: "slug" });
        }
        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META,        { keyPath: "key" });
        }
      };
      req.onsuccess = function () {
        const db = req.result;
        // Blocked-by-other-tab safety: if the schema version changes
        // later, kill this connection so the new tab can upgrade.
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

  // ---------- drafts ----------

  function saveDraft(draft) {
    if (!draft || !draft.submission_id) {
      return Promise.reject(new Error("saveDraft: submission_id required"));
    }
    const now = Date.now();
    const row = Object.assign({}, draft, {
      updated_at: now,
      created_at: draft.created_at || now
    });
    return tx(STORES.DRAFTS, "readwrite", function (store) {
      return promisifyRequest(store.put(row));
    });
  }

  function loadDraft(submissionId) {
    return tx(STORES.DRAFTS, "readonly", function (store) {
      return promisifyRequest(store.get(submissionId));
    }).then(function (row) { return row || null; });
  }

  function loadAllDrafts() {
    return tx(STORES.DRAFTS, "readonly", function (store) {
      return promisifyRequest(store.getAll());
    }).then(function (rows) { return rows || []; });
  }

  function deleteDraft(submissionId) {
    return tx(STORES.DRAFTS, "readwrite", function (store) {
      return promisifyRequest(store.delete(submissionId));
    });
  }

  // ---------- pending ----------

  function enqueueSubmission(submission) {
    if (!submission || !submission.submission_id) {
      return Promise.reject(new Error("enqueueSubmission: submission_id required"));
    }
    if (!Array.isArray(submission.photos)) {
      return Promise.reject(new Error("enqueueSubmission: photos array required (may be empty)"));
    }
    const now = Date.now();
    const row = Object.assign({
      status:          STATUS.QUEUED,
      attempts:        [],
      attempts_count:  0,
      next_attempt_at: now,
      created_at:      now,
      updated_at:      now
    }, submission, {
      // Force these fields server-side of the object after merging the
      // caller's payload, so they can't accidentally override the defaults
      // above with stale values from a re-enqueue path.
      submission_id: submission.submission_id,
      updated_at:    now
    });
    return tx(STORES.PENDING, "readwrite", function (store) {
      return promisifyRequest(store.put(row));
    });
  }

  function getPending() {
    return tx(STORES.PENDING, "readonly", function (store) {
      return promisifyRequest(store.getAll());
    }).then(function (rows) { return rows || []; });
  }

  function getNextDrainable(nowMs) {
    nowMs = nowMs || Date.now();
    return tx(STORES.PENDING, "readonly", function (store) {
      const idx = store.index("status");
      return Promise.all([
        promisifyRequest(idx.getAll(STATUS.QUEUED)),
        promisifyRequest(idx.getAll(STATUS.FAILED_WILL_RETRY))
      ]);
    }).then(function (parts) {
      const all = parts[0].concat(parts[1]);
      const ready = all.filter(function (r) {
        return !r.next_attempt_at || r.next_attempt_at <= nowMs;
      });
      ready.sort(function (a, b) {
        return (a.next_attempt_at || a.created_at) - (b.next_attempt_at || b.created_at);
      });
      return ready[0] || null;
    });
  }

  function markStatus(submissionId, status, patch) {
    return tx(STORES.PENDING, "readwrite", function (store) {
      return promisifyRequest(store.get(submissionId)).then(function (row) {
        if (!row) throw new Error("markStatus: no pending row for " + submissionId);
        row.status     = status;
        row.updated_at = Date.now();
        if (patch && typeof patch === "object") {
          Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        }
        return promisifyRequest(store.put(row));
      });
    });
  }

  function appendAttempt(submissionId, attempt) {
    return tx(STORES.PENDING, "readwrite", function (store) {
      return promisifyRequest(store.get(submissionId)).then(function (row) {
        if (!row) throw new Error("appendAttempt: no pending row for " + submissionId);
        if (!Array.isArray(row.attempts)) row.attempts = [];
        row.attempts.push(Object.assign({ started_at: Date.now() }, attempt || {}));
        row.attempts_count = row.attempts.length;
        row.updated_at     = Date.now();
        return promisifyRequest(store.put(row));
      });
    });
  }

  function removeSubmission(submissionId) {
    return tx(STORES.PENDING, "readwrite", function (store) {
      return promisifyRequest(store.delete(submissionId));
    });
  }

  // ---------- roster cache ----------

  function cacheCollection(storeName, rows, keyField) {
    if (!Array.isArray(rows)) return Promise.resolve();
    return tx(storeName, "readwrite", function (store) {
      // Wipe-and-reseed semantics — Firestore is the source of truth, so
      // we replace the cache wholesale on each refresh. Simpler than
      // deletion diffing and the cache is small (<1MB realistic).
      return promisifyRequest(store.clear()).then(function () {
        return Promise.all(rows.map(function (row) {
          if (!row[keyField]) return Promise.resolve(); // skip malformed
          return promisifyRequest(store.put(row));
        }));
      });
    });
  }

  function cacheAssignments(rows) { return cacheCollection(STORES.ASSIGNMENTS, rows, "assignment_id"); }
  function cacheCustomers(rows)   { return cacheCollection(STORES.CUSTOMERS,   rows, "slug"); }
  function cacheTechs(rows)       { return cacheCollection(STORES.TECHS,       rows, "slug"); }

  function loadCachedRoster() {
    return Promise.all([
      tx(STORES.ASSIGNMENTS, "readonly", function (s) { return promisifyRequest(s.getAll()); }),
      tx(STORES.CUSTOMERS,   "readonly", function (s) { return promisifyRequest(s.getAll()); }),
      tx(STORES.TECHS,       "readonly", function (s) { return promisifyRequest(s.getAll()); }),
      tx(STORES.META,        "readonly", function (s) { return promisifyRequest(s.get("roster")); })
    ]).then(function (parts) {
      return {
        assignments: parts[0] || [],
        customers:   parts[1] || [],
        techs:       parts[2] || [],
        cached_at:   (parts[3] && parts[3].cached_at) || null
      };
    });
  }

  function stampRosterCachedAt(ts) {
    ts = ts || Date.now();
    return tx(STORES.META, "readwrite", function (store) {
      return promisifyRequest(store.put({ key: "roster", cached_at: ts }));
    });
  }

  // ---------- diagnostics ----------

  function stats() {
    return Promise.all([
      tx(STORES.DRAFTS,      "readonly", function (s) { return promisifyRequest(s.count()); }),
      tx(STORES.PENDING,     "readonly", function (s) { return promisifyRequest(s.count()); }),
      tx(STORES.ASSIGNMENTS, "readonly", function (s) { return promisifyRequest(s.count()); }),
      tx(STORES.CUSTOMERS,   "readonly", function (s) { return promisifyRequest(s.count()); }),
      tx(STORES.TECHS,       "readonly", function (s) { return promisifyRequest(s.count()); })
    ]).then(function (parts) {
      return {
        drafts:      parts[0],
        pending:     parts[1],
        assignments: parts[2],
        customers:   parts[3],
        techs:       parts[4]
      };
    });
  }

  function clearAll() {
    return tx(
      [STORES.DRAFTS, STORES.PENDING, STORES.ASSIGNMENTS, STORES.CUSTOMERS, STORES.TECHS, STORES.META],
      "readwrite",
      function (stores) {
        return Promise.all(stores.map(function (s) { return promisifyRequest(s.clear()); }));
      }
    );
  }

  // ---------- public API ----------

  self.PIONEER_QUEUE_DB = {
    open:                 open,
    saveDraft:            saveDraft,
    loadDraft:            loadDraft,
    loadAllDrafts:        loadAllDrafts,
    deleteDraft:          deleteDraft,
    enqueueSubmission:    enqueueSubmission,
    getPending:           getPending,
    getNextDrainable:     getNextDrainable,
    markStatus:           markStatus,
    appendAttempt:        appendAttempt,
    removeSubmission:     removeSubmission,
    cacheAssignments:     cacheAssignments,
    cacheCustomers:       cacheCustomers,
    cacheTechs:           cacheTechs,
    loadCachedRoster:     loadCachedRoster,
    stampRosterCachedAt:  stampRosterCachedAt,
    stats:                stats,
    clearAll:             clearAll,
    STATUS:               STATUS,
    STORES:               STORES,
    DB_NAME:              DB_NAME,
    DB_VERSION:           DB_VERSION
  };
}());
