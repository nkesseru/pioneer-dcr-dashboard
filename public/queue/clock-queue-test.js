/* Pioneer Phase 32B-1 — Clock queue harness driver.
 *
 * Loaded only from clock-queue-test.html. Exercises every method of
 * PIONEER_CLOCK_QUEUE_DB against the live IndexedDB on the device.
 * No Firestore, no network. Safe to run repeatedly.
 */
(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const out = function (id, val) {
    const el = $(id);
    if (!el) return;
    el.textContent = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  };

  function freshId() {
    if (self.crypto && self.crypto.randomUUID) {
      try { return self.crypto.randomUUID(); } catch (_e) {}
    }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function sampleClockIn(overrides) {
    return Object.assign({
      event_id:       freshId(),
      schema_version: 1,
      device_id:      "test-device",
      type:           "clock_in",
      staff_uid:      "test-uid",
      staff_email:    "test@example.com",
      assignment_id:  "asgn-test-1",
      session_id:     null,
      customer_id:    "test-customer",
      customer_slug:  "test-customer",
      customer_name:  "Test Customer",
      service_date:   "2026-06-23",
      intent_ts:      Date.now(),
      intent_ts_floor:Math.floor(Date.now() / 60000) * 60000,
      geo:            { lat: null, lon: null, accuracy_m: null, status: "ok" },
      ua:             navigator.userAgent || ""
    }, overrides || {});
  }
  function sampleClockOut(overrides) {
    return Object.assign({
      event_id:       freshId(),
      schema_version: 1,
      device_id:      "test-device",
      type:           "clock_out",
      staff_uid:      "test-uid",
      staff_email:    "test@example.com",
      assignment_id:  "asgn-test-1",
      session_id:     "sess-test-1",
      customer_id:    "test-customer",
      customer_slug:  "test-customer",
      customer_name:  "Test Customer",
      service_date:   "2026-06-23",
      intent_ts:      Date.now(),
      intent_ts_floor:Math.floor(Date.now() / 60000) * 60000,
      geo:            { lat: null, lon: null, accuracy_m: null, status: "ok" },
      ua:             navigator.userAgent || ""
    }, overrides || {});
  }

  function wire() {
    const DB = self.PIONEER_CLOCK_QUEUE_DB;
    if (!DB) {
      out("qt-diag", "ERROR: PIONEER_CLOCK_QUEUE_DB not loaded.");
      return;
    }
    let lastEnqueuedId = null;

    // --- DB lifecycle ---
    $("qt-open").onclick = async function () {
      try { await DB.open(); out("qt-out-db", "DB opened."); }
      catch (e) { out("qt-out-db", "open failed: " + e.message); }
    };
    $("qt-stats").onclick = async function () {
      try { out("qt-out-db", await DB.stats()); }
      catch (e) { out("qt-out-db", "stats failed: " + e.message); }
    };
    $("qt-clear").onclick = async function () {
      try {
        await DB.clearAll();
        lastEnqueuedId = null;
        out("qt-out-db", "Cleared.");
      } catch (e) { out("qt-out-db", "clearAll failed: " + e.message); }
    };

    // --- Enqueue + lifecycle ---
    $("qt-enq-in").onclick = async function () {
      try {
        const ev = sampleClockIn();
        await DB.enqueueEvent(ev);
        lastEnqueuedId = ev.event_id;
        out("qt-out-enq", { enqueued: ev.event_id, type: ev.type });
      } catch (e) { out("qt-out-enq", "enqueue failed: " + e.message); }
    };
    $("qt-enq-out").onclick = async function () {
      try {
        const ev = sampleClockOut();
        await DB.enqueueEvent(ev);
        lastEnqueuedId = ev.event_id;
        out("qt-out-enq", { enqueued: ev.event_id, type: ev.type });
      } catch (e) { out("qt-out-enq", "enqueue failed: " + e.message); }
    };
    $("qt-list").onclick = async function () {
      try { out("qt-out-enq", await DB.getAllEvents()); }
      catch (e) { out("qt-out-enq", "list failed: " + e.message); }
    };
    $("qt-next").onclick = async function () {
      try { out("qt-out-enq", await DB.getNextDrainable()); }
      catch (e) { out("qt-out-enq", "getNext failed: " + e.message); }
    };

    // --- Mark + remove ---
    $("qt-uploading").onclick = async function () {
      if (!lastEnqueuedId) return out("qt-out-mark", "no last-enqueued id");
      try {
        await DB.markStatus(lastEnqueuedId, DB.STATUS.UPLOADING, { last_attempt_at: Date.now() });
        await DB.appendAttempt(lastEnqueuedId, { stage: "start" });
        out("qt-out-mark", await DB.getEvent(lastEnqueuedId));
      } catch (e) { out("qt-out-mark", "mark failed: " + e.message); }
    };
    $("qt-fail-retry").onclick = async function () {
      if (!lastEnqueuedId) return out("qt-out-mark", "no last-enqueued id");
      try {
        const next = Date.now() + 30000;
        await DB.markStatus(lastEnqueuedId, DB.STATUS.FAILED_WILL_RETRY, {
          last_error_code: "test/simulated",
          last_error_message: "harness simulated failure",
          next_attempt_at: next
        });
        await DB.appendAttempt(lastEnqueuedId, { stage: "transient_fail", code: "test/simulated" });
        out("qt-out-mark", await DB.getEvent(lastEnqueuedId));
      } catch (e) { out("qt-out-mark", "mark failed: " + e.message); }
    };
    $("qt-fail-perm").onclick = async function () {
      if (!lastEnqueuedId) return out("qt-out-mark", "no last-enqueued id");
      try {
        await DB.markStatus(lastEnqueuedId, DB.STATUS.FAILED_PERMANENT, {
          last_error_code: "test/permanent",
          last_error_message: "harness simulated permanent failure"
        });
        out("qt-out-mark", await DB.getEvent(lastEnqueuedId));
      } catch (e) { out("qt-out-mark", "mark failed: " + e.message); }
    };
    $("qt-remove").onclick = async function () {
      if (!lastEnqueuedId) return out("qt-out-mark", "no last-enqueued id");
      try {
        await DB.removeEvent(lastEnqueuedId);
        const after = await DB.getEvent(lastEnqueuedId);
        out("qt-out-mark", { removed: lastEnqueuedId, lookup_after: after });
      } catch (e) { out("qt-out-mark", "remove failed: " + e.message); }
    };

    // --- Ordering ---
    $("qt-pair").onclick = async function () {
      try {
        const inMs  = Date.now();
        const outMs = Date.now() + 1000;
        const evIn  = sampleClockIn({  intent_ts: inMs,  intent_ts_floor: Math.floor(inMs/60000)*60000 });
        const evOut = sampleClockOut({ intent_ts: outMs, intent_ts_floor: Math.floor(outMs/60000)*60000 });
        await DB.enqueueEvent(evIn);
        await DB.enqueueEvent(evOut);
        out("qt-out-order", { enqueued: [evIn.event_id, evOut.event_id] });
      } catch (e) { out("qt-out-order", "pair failed: " + e.message); }
    };
    $("qt-by-asgn").onclick = async function () {
      try {
        const rows = await DB.getEventsByTechAndAssignment("test-uid", "asgn-test-1");
        out("qt-out-order", {
          count: rows.length,
          order_by_intent_ts: rows.map(function (r) { return { type: r.type, intent_ts: r.intent_ts, event_id: r.event_id.slice(0, 8) }; })
        });
      } catch (e) { out("qt-out-order", "read failed: " + e.message); }
    };

    // --- Validation ---
    $("qt-val-bad-type").onclick = async function () {
      try {
        const ev = sampleClockIn({ type: "bogus" });
        await DB.enqueueEvent(ev);
        out("qt-out-val", "FAIL — should have thrown");
      } catch (e) { out("qt-out-val", "PASS — rejected: " + e.message); }
    };
    $("qt-val-no-id").onclick = async function () {
      try {
        const ev = sampleClockIn({ event_id: "" });
        await DB.enqueueEvent(ev);
        out("qt-out-val", "FAIL — should have thrown");
      } catch (e) { out("qt-out-val", "PASS — rejected: " + e.message); }
    };
    $("qt-val-out-no-sid").onclick = async function () {
      try {
        const ev = sampleClockOut({ session_id: null });
        await DB.enqueueEvent(ev);
        out("qt-out-val", "FAIL — should have thrown");
      } catch (e) { out("qt-out-val", "PASS — rejected: " + e.message); }
    };
    $("qt-val-in-no-asgn").onclick = async function () {
      try {
        const ev = sampleClockIn({ assignment_id: null });
        await DB.enqueueEvent(ev);
        out("qt-out-val", "FAIL — should have thrown");
      } catch (e) { out("qt-out-val", "PASS — rejected: " + e.message); }
    };

    out("qt-diag", {
      module_loaded:    !!DB,
      idb_available:    "indexedDB" in self,
      crypto_uuid:      !!(self.crypto && self.crypto.randomUUID),
      db_name:          DB.DB_NAME,
      db_version:       DB.DB_VERSION,
      stores:           DB.STORES,
      statuses:         DB.STATUS,
      types:            DB.TYPES
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
}());
