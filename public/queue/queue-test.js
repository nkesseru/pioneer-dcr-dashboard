/* Pioneer DCR Hub — Phase 31 prototype: queue test harness driver.
 *
 * STATUS: PROTOTYPE. Exercised only from queue-test.html. Provides:
 *   - Mock storage (FAKE_STORAGE) that mimics firebase.storage()'s ref().put()
 *     contract so wrapUploadWithGuards can drive it without real network.
 *   - Mock submit (FAKE_SUBMIT) that counts calls and enforces server-side
 *     idempotency by submission_id — matches what the real
 *     submitDcrV1 idempotency patch will do once shipped.
 *   - Click handlers wiring buttons to queue-db / queue-worker / migration.
 */

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const out = function (id, val) {
    const el = $(id);
    if (!el) return;
    el.textContent = typeof val === "string" ? val : JSON.stringify(val, replacer, 2);
  };
  function replacer(k, v) {
    if (v instanceof Blob) return "<Blob " + v.size + " bytes, " + (v.type || "?") + ">";
    if (v && v.then && typeof v.then === "function") return "<Promise>";
    return v;
  }

  // ---------- mock storage ----------
  //
  // task.on(state_changed, progressCb, errorCb, completeCb) is the contract.
  // We emit progress events at intervals based on UI checkboxes. Cancel via
  // task.cancel(). getDownloadURL() returns a fake URL.

  function makeFakeTask(path, blob, opts) {
    opts = opts || {};
    const subs = [];
    let canceled = false;
    let progressTimer = null;
    let elapsedMs = 0;

    function emitState(snap) { subs.forEach(function (s) { try { s.progress(snap); } catch (_e) {} }); }
    function emitError(err)  { subs.forEach(function (s) { try { s.error(err); }    catch (_e) {} }); }
    function emitDone()      { subs.forEach(function (s) { try { s.complete(); }    catch (_e) {} }); }

    const task = {
      snapshot: {
        ref: {
          getDownloadURL: function () {
            return Promise.resolve("https://fake-storage/" + encodeURIComponent(path));
          }
        }
      },
      cancel: function () {
        canceled = true;
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        const err = new Error("Upload canceled");
        err.code = "storage/canceled";
        emitError(err);
      },
      on: function (eventType, progressCb, errorCb, completeCb) {
        if (eventType !== "state_changed") return;
        subs.push({ progress: progressCb, error: errorCb, complete: completeCb });
      }
    };

    // Drive progress on next tick so caller has time to attach .on().
    setTimeout(function () {
      if (canceled) return;
      const totalBytes = (blob && blob.size) || 1000;
      let bytesTransferred = 0;

      if (opts.stall) {
        // Never emit progress; rely on caller's stall watchdog to fire.
        return;
      }
      if (opts.offline) {
        // Hard fail immediately to simulate a network error.
        const err = new Error("Network unavailable");
        err.code = "storage/retry-limit-exceeded";
        emitError(err);
        return;
      }

      progressTimer = setInterval(function () {
        if (canceled) return;
        elapsedMs += 50;
        bytesTransferred = Math.min(totalBytes, bytesTransferred + Math.ceil(totalBytes / 10));
        emitState({ bytesTransferred: bytesTransferred, totalBytes: totalBytes });
        if (bytesTransferred >= totalBytes) {
          clearInterval(progressTimer);
          progressTimer = null;
          emitDone();
        }
      }, 50);
    }, 0);

    return task;
  }

  const FAKE_STORAGE = {
    ref: function (path) {
      return {
        put: function (blob, meta) {
          const opts = {
            stall:   !!$("qt-net-stall").checked,
            offline: !!$("qt-net-offline").checked
          };
          return makeFakeTask(path, blob, opts);
        }
      };
    }
  };

  // ---------- mock submit ----------

  const FAKE_SUBMIT_STATE = {
    seenSubmissions: Object.create(null),  // submission_id -> first receipt
    callCount:       0,
    emailCount:      0,
    zapierCount:     0
  };

  function fakeSubmit(payload, idToken) {
    return new Promise(function (resolve) {
      FAKE_SUBMIT_STATE.callCount++;
      if ($("qt-net-offline").checked) {
        return resolve({ ok: false, status: 0, body: { error: "Network unavailable" } });
      }
      const id = payload.submission_id;
      const prior = FAKE_SUBMIT_STATE.seenSubmissions[id];
      if (prior) {
        // Server-side idempotency — return the cached receipt without
        // counting another email/Zapier fire.
        return resolve({
          ok:     true,
          status: 200,
          body:   Object.assign({}, prior, { already_submitted: true })
        });
      }
      FAKE_SUBMIT_STATE.emailCount++;
      FAKE_SUBMIT_STATE.zapierCount++;
      const receipt = {
        ok: true,
        submission_id: id,
        email:  { status: "sent" },
        zapier: { attempted: true, status: "ok" }
      };
      FAKE_SUBMIT_STATE.seenSubmissions[id] = receipt;
      // Simulate a 100ms server round-trip.
      setTimeout(function () { resolve({ ok: true, status: 200, body: receipt }); }, 100);
    });
  }

  function fakeGetIdToken() { return Promise.resolve("fake-id-token-for-testing"); }

  // ---------- sample factories ----------

  function makeFakeBlob(sizeBytes, mime) {
    const buf = new Uint8Array(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) buf[i] = i & 0xff;
    return new Blob([buf], { type: mime || "image/jpeg" });
  }

  function sampleDraft(submissionId) {
    return {
      submission_id: submissionId,
      source:        "test-harness",
      customer_slug: "baker-construction",
      tech_slug:     "bonnie-test",
      form_data:     { occupancy_level: "medium", notes: "Sample test draft" }
    };
  }

  function sampleSubmissionInput(submissionId, photoCount) {
    const photos = [];
    for (let i = 0; i < photoCount; i++) {
      photos.push({ blob: makeFakeBlob(1024 * (i + 1), "image/jpeg"), content_type: "image/jpeg", ext: "jpg" });
    }
    return {
      submission_id: submissionId,
      payload: {
        submission_id: submissionId,
        source:        "test-harness",
        customer_slug: "baker-construction",
        customer:      { slug: "baker-construction", name: "Baker Construction", email: "test@example.com" },
        tech_slug:     "bonnie-test",
        tech:          { slug: "bonnie-test", display_name: "Bonnie (Test)" },
        clean_date:    "2026-06-18",
        affirmation:   { affirmed: true, signature_name: "Bonnie (Test)", affirmed_text: "I affirm…" }
      },
      photos: photos,
      signature_blob: makeFakeBlob(512, "image/png")
    };
  }

  function freshId() {
    return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID()
      : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
  }

  // ---------- button wiring ----------

  function wire() {
    const DB     = self.PIONEER_QUEUE_DB;
    const WORKER = self.PIONEER_QUEUE_WORKER;
    const MIG    = self.PIONEER_QUEUE_MIGRATION;

    if (!DB || !WORKER || !MIG) {
      out("qt-diag", "ERROR: one of queue-db / queue-worker / draft-migration failed to load.");
      return;
    }

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
        FAKE_SUBMIT_STATE.seenSubmissions = Object.create(null);
        FAKE_SUBMIT_STATE.callCount  = 0;
        FAKE_SUBMIT_STATE.emailCount = 0;
        FAKE_SUBMIT_STATE.zapierCount = 0;
        try { localStorage.removeItem("pioneer.dcr.draft.v1"); } catch (_e) {}
        out("qt-out-db", "Cleared. (Stores + FAKE_SUBMIT counters + legacy localStorage.)");
      } catch (e) { out("qt-out-db", "clearAll failed: " + e.message); }
    };

    $("qt-draft-save").onclick = async function () {
      const id = freshId();
      try {
        await DB.saveDraft(sampleDraft(id));
        out("qt-out-draft", { saved: id });
      } catch (e) { out("qt-out-draft", "save failed: " + e.message); }
    };
    $("qt-draft-load-all").onclick = async function () {
      try { out("qt-out-draft", await DB.loadAllDrafts()); }
      catch (e) { out("qt-out-draft", "load failed: " + e.message); }
    };

    $("qt-mig-seed").onclick = function () {
      const legacy = {
        version: 1,
        saved_at: Date.now(),
        customer_slug: "baker-construction",
        tech_slug:     "bonnie",
        form_data: { notes: "Legacy draft — pre-Phase 31" }
      };
      try {
        localStorage.setItem("pioneer.dcr.draft.v1", JSON.stringify(legacy));
        out("qt-out-mig", "Seeded legacy draft into localStorage.");
      } catch (e) { out("qt-out-mig", "seed failed: " + e.message); }
    };
    $("qt-mig-run").onclick = async function () {
      try { out("qt-out-mig", await MIG.migrateLegacyDraftIfPresent()); }
      catch (e) { out("qt-out-mig", "run failed: " + e.message); }
    };
    $("qt-mig-run-again").onclick = async function () {
      try { out("qt-out-mig", await MIG.migrateLegacyDraftIfPresent()); }
      catch (e) { out("qt-out-mig", "run failed: " + e.message); }
    };

    $("qt-enqueue").onclick = async function () {
      const id = freshId();
      const photoCount = parseInt($("qt-photo-count").value, 10) || 0;
      try {
        await WORKER.queueSubmissionFromForm(sampleSubmissionInput(id, photoCount));
        out("qt-out-queue", { enqueued: id, photo_count: photoCount });
      } catch (e) { out("qt-out-queue", "enqueue failed: " + e.message); }
    };
    $("qt-drain").onclick = async function () {
      try {
        const events = [];
        const res = await WORKER.processQueue(
          { storage: FAKE_STORAGE, submitFn: fakeSubmit, getIdToken: fakeGetIdToken },
          { maxRows: 5, onProgress: function (e) { events.push(e); } }
        );
        out("qt-out-queue", {
          results: res,
          event_count: events.length,
          last_events: events.slice(-6),
          fake_submit_state: {
            callCount:   FAKE_SUBMIT_STATE.callCount,
            emailCount:  FAKE_SUBMIT_STATE.emailCount,
            zapierCount: FAKE_SUBMIT_STATE.zapierCount
          }
        });
      } catch (e) { out("qt-out-queue", "drain failed: " + e.message); }
    };
    $("qt-list-pending").onclick = async function () {
      try { out("qt-out-queue", await DB.getPending()); }
      catch (e) { out("qt-out-queue", "list failed: " + e.message); }
    };
    $("qt-stress").onclick = async function () {
      try {
        const ids = [];
        for (let i = 0; i < 5; i++) {
          const id = freshId();
          ids.push(id);
          await WORKER.queueSubmissionFromForm(sampleSubmissionInput(id, 1));
        }
        out("qt-out-queue", { enqueued: ids });
      } catch (e) { out("qt-out-queue", "stress failed: " + e.message); }
    };

    $("qt-idem").onclick = async function () {
      // Probe: enqueue once, drain (success). Re-enqueue with same ID,
      // drain. Email + Zapier counts must NOT increment on second drain.
      const id = freshId();
      try {
        await DB.clearAll();
        FAKE_SUBMIT_STATE.seenSubmissions = Object.create(null);
        FAKE_SUBMIT_STATE.callCount  = 0;
        FAKE_SUBMIT_STATE.emailCount = 0;
        FAKE_SUBMIT_STATE.zapierCount = 0;

        await WORKER.queueSubmissionFromForm(sampleSubmissionInput(id, 1));
        const first = await WORKER.processQueue(
          { storage: FAKE_STORAGE, submitFn: fakeSubmit, getIdToken: fakeGetIdToken },
          { maxRows: 1 }
        );
        const afterFirst = {
          email:  FAKE_SUBMIT_STATE.emailCount,
          zapier: FAKE_SUBMIT_STATE.zapierCount,
          calls:  FAKE_SUBMIT_STATE.callCount
        };

        // Re-enqueue the same submission_id and drain again.
        await WORKER.queueSubmissionFromForm(sampleSubmissionInput(id, 1));
        const second = await WORKER.processQueue(
          { storage: FAKE_STORAGE, submitFn: fakeSubmit, getIdToken: fakeGetIdToken },
          { maxRows: 1 }
        );
        const afterSecond = {
          email:  FAKE_SUBMIT_STATE.emailCount,
          zapier: FAKE_SUBMIT_STATE.zapierCount,
          calls:  FAKE_SUBMIT_STATE.callCount
        };
        const pass = (afterSecond.email === afterFirst.email)
                  && (afterSecond.zapier === afterFirst.zapier)
                  && (second[0] && second[0].receipt && second[0].receipt.already_submitted === true);
        out("qt-out-idem", {
          submission_id:    id,
          first_drain:      first,
          second_drain:     second,
          counters_first:   afterFirst,
          counters_second:  afterSecond,
          IDEMPOTENCY_PASS: pass
        });
      } catch (e) { out("qt-out-idem", "probe failed: " + e.message); }
    };

    out("qt-diag", {
      queue_db_loaded:      !!DB,
      queue_worker_loaded:  !!WORKER,
      migration_loaded:     !!MIG,
      idb_available:        "indexedDB" in self,
      crypto_uuid:          !!(self.crypto && self.crypto.randomUUID),
      sw_v1_active:         navigator.serviceWorker
                              && navigator.serviceWorker.controller
                              && navigator.serviceWorker.controller.scriptURL,
      fixture: "FAKE_STORAGE + FAKE_SUBMIT in-memory; no network."
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
}());
