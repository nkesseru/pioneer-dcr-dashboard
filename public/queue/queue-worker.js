/* Pioneer DCR Hub — Phase 31 prototype: queue worker (processQueue).
 *
 * STATUS: PROTOTYPE. Not loaded by any production page. Reachable only
 * from /queue/queue-test.html. Depends on queue-db.js being loaded first.
 *
 * Responsibilities:
 *   1. Pick the next drainable row from the pending store.
 *   2. Upload photos (max 2 concurrent), then signature, then POST to
 *      submitDcrV1.
 *   3. Each Storage upload inherits the production hotfix's per-upload
 *      guards: 20s stall watchdog + 90s hard cap + AbortController-style
 *      cancellation. See app.js wrapUploadWithGuards for the proven shape.
 *   4. Retry with exponential backoff: 30s -> 2m -> 10m. After 3 failed
 *      attempts the row moves to failed_permanent (needs human).
 *   5. On terminal success the row is deleted from pending.
 *
 * What this prototype does NOT do:
 *   - Does not register itself as a service-worker sync handler (sw-v2.js
 *     does that; in the test harness we drive processQueue() manually).
 *   - Does not call Firestore directly. Only Firebase Storage (uploads)
 *     and submitDcrV1 (final POST). All other writes happen server-side.
 *   - Does not auto-poll. Caller must invoke processQueue() or wire it
 *     to `online` / `sync` events themselves.
 *
 * Idempotency contract:
 *   The submission_id is the idempotency key. Re-running processQueue on
 *   the SAME row must never produce a second dcr_submissions doc or a
 *   second customer email. Server-side enforcement lives in the
 *   submitDcrV1 idempotency patch (functions/_drafts/...). Client-side
 *   enforcement here is: never mutate the submission_id once enqueued,
 *   never re-enqueue a row already marked submitted.
 */

(function () {
  "use strict";

  const STALL_MS                = 20000;
  const HARD_MS                 = 90000;
  const MAX_PARALLEL_PHOTOS     = 2;
  const MAX_ATTEMPTS            = 3;
  const BACKOFF_SCHEDULE_MS     = [30000, 120000, 600000]; // 30s, 2m, 10m

  function nowMs() { return Date.now(); }

  function nextBackoffAt(attemptNumber) {
    const idx = Math.min(attemptNumber - 1, BACKOFF_SCHEDULE_MS.length - 1);
    return nowMs() + BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
  }

  // ---------- Storage upload with watchdog + hard cap ----------
  //
  // Mirrors the production hotfix (public/app.js wrapUploadWithGuards). Kept
  // standalone here so the worker has no dependency on app.js — both files
  // ship the same guarantees.

  function wrapUploadWithGuards(task, onProgress, completePayloadFn) {
    return new Promise(function (resolve, reject) {
      let stallTimer = null;
      let hardTimer  = null;
      let settled    = false;

      function clearTimers() {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (hardTimer)  { clearTimeout(hardTimer);  hardTimer  = null; }
      }
      function abort(message, code) {
        if (settled) return;
        settled = true;
        clearTimers();
        const err = new Error(message);
        err.code = code || "pioneer/upload-aborted";
        try { task.cancel(); } catch (_e) {}
        reject(err);
      }
      function armStall() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(function () {
          abort("Upload stalled — no progress for " + (STALL_MS / 1000) + "s", "pioneer/upload-stalled");
        }, STALL_MS);
      }

      hardTimer = setTimeout(function () {
        abort("Upload timed out after " + (HARD_MS / 1000) + "s", "pioneer/upload-timeout");
      }, HARD_MS);
      armStall();

      task.on(
        "state_changed",
        function (snap) {
          if (settled) return;
          armStall();
          const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
          if (onProgress) onProgress(pct);
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(err);
        },
        async function () {
          if (settled) return;
          settled = true;
          clearTimers();
          try {
            const out = await completePayloadFn();
            resolve(out);
          } catch (e) { reject(e); }
        }
      );
    });
  }

  function uploadOnePhoto(storage, photo, customerSlug, submissionId, photoIndex, onProgress) {
    // The planned_path is set at enqueue time so the queue row is
    // self-describing. Recompute as a fallback for backward compat if
    // an older row was enqueued without it.
    const path = photo.planned_path
      || ("dcr-photos/" + customerSlug + "/" + submissionId + "/photo-" + (photoIndex + 1) +
          "." + (photo.ext || "jpg"));
    const ref  = storage.ref(path);
    const task = ref.put(photo.blob, { contentType: photo.content_type || photo.blob.type });
    return wrapUploadWithGuards(task, onProgress, async function () {
      const url = await task.snapshot.ref.getDownloadURL();
      return {
        id: "ph_" + (photoIndex + 1),
        storage_path: path,
        download_url: url,
        content_type: photo.content_type || photo.blob.type || null,
        size_bytes:   photo.blob.size,
        width:  null,
        height: null,
        caption: "",
        tag: "general"
      };
    });
  }

  function uploadSignature(storage, signatureBlob, customerSlug, submissionId, onProgress) {
    const path = "dcr-signatures/" + customerSlug + "/" + submissionId + "/signature.png";
    const ref  = storage.ref(path);
    const task = ref.put(signatureBlob, { contentType: "image/png" });
    return wrapUploadWithGuards(task, onProgress, async function () {
      const url = await task.snapshot.ref.getDownloadURL();
      return {
        storage_path: path,
        download_url: url,
        content_type: "image/png",
        size_bytes:   signatureBlob.size
      };
    });
  }

  // ---------- bounded-concurrency parallel runner ----------
  //
  // Runs `items` through `worker(item, index)` with at most `limit` in
  // flight at once. Resolves to results in original order. Rejects on the
  // first failure (caller decides whether to retry the whole submission
  // or mark per-file failures).

  function runWithConcurrency(items, limit, worker) {
    return new Promise(function (resolve, reject) {
      if (!items.length) return resolve([]);
      const out      = new Array(items.length);
      let cursor     = 0;
      let inFlight   = 0;
      let done       = 0;
      let failed     = false;

      function pump() {
        if (failed) return;
        while (inFlight < limit && cursor < items.length) {
          const i = cursor++;
          inFlight++;
          Promise.resolve(worker(items[i], i)).then(
            function (res) {
              out[i] = res;
              inFlight--;
              done++;
              if (done === items.length) resolve(out);
              else pump();
            },
            function (err) {
              if (failed) return;
              failed = true;
              reject(err);
            }
          );
        }
      }
      pump();
    });
  }

  // ---------- core: drain one row ----------

  async function drainOne(deps, row, onProgress) {
    const DB       = self.PIONEER_QUEUE_DB;
    const storage  = deps.storage;
    const submit   = deps.submitFn;  // fn(payload, idToken) -> {ok, body, status}
    const idToken  = await deps.getIdToken();

    if (!idToken) throw new Error("No ID token — cannot post to submitDcrV1");

    await DB.appendAttempt(row.submission_id, { stage: "start" });

    // ---- photos (parallel, bounded) ----
    let uploadedPhotos = [];
    if (Array.isArray(row.photos) && row.photos.length) {
      await DB.markStatus(row.submission_id, DB.STATUS.UPLOADING_PHOTOS);
      uploadedPhotos = await runWithConcurrency(row.photos, MAX_PARALLEL_PHOTOS, function (photo, i) {
        return uploadOnePhoto(
          storage, photo, row.payload.customer_slug || row.payload.customer.slug,
          row.submission_id, i,
          function (pct) {
            if (onProgress) onProgress({ stage: "photo", index: i, pct: pct });
          }
        );
      });
    }

    // ---- signature ----
    await DB.markStatus(row.submission_id, DB.STATUS.UPLOADING_SIGNATURE);
    const signatureMeta = await uploadSignature(
      storage, row.signature_blob,
      row.payload.customer_slug || row.payload.customer.slug,
      row.submission_id,
      function (pct) { if (onProgress) onProgress({ stage: "signature", pct: pct }); }
    );

    // ---- payload finalisation ----
    // Splice the upload results into the saved payload skeleton. The
    // skeleton was finalized at Submit-click time minus the URLs that
    // didn't exist yet.
    const finalPayload = Object.assign({}, row.payload, {
      photos:    uploadedPhotos,
      // Mirror the existing affirmation shape from buildDcrV1Payload.
      affirmation: Object.assign({}, row.payload.affirmation || {}, {
        signature_url: signatureMeta.download_url
      })
    });
    if (finalPayload.form_data && finalPayload.form_data.signature) {
      finalPayload.form_data.signature = {
        storage_path: signatureMeta.storage_path,
        download_url: signatureMeta.download_url
      };
    }

    // ---- POST to submitDcrV1 ----
    await DB.markStatus(row.submission_id, DB.STATUS.POSTING_PAYLOAD);
    const postResult = await submit(finalPayload, idToken);
    if (!postResult || !postResult.ok) {
      const e = new Error(
        (postResult && postResult.body && postResult.body.error) ||
        ("submitDcrV1 returned " + (postResult && postResult.status))
      );
      e.code = "pioneer/submit-failed";
      e.status = postResult && postResult.status;
      throw e;
    }

    await DB.markStatus(row.submission_id, DB.STATUS.SUBMITTED, {
      submitted_at:      nowMs(),
      server_receipt:    postResult.body || null,
      already_submitted: !!(postResult.body && postResult.body.already_submitted)
    });
    return postResult.body || { ok: true };
  }

  // ---------- public: processQueue ----------

  async function processQueue(deps, opts) {
    const DB = self.PIONEER_QUEUE_DB;
    if (!DB) throw new Error("queue-db.js not loaded");
    deps = deps || {};
    opts = opts || {};
    const maxRows = opts.maxRows || 10;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const results = [];

    for (let i = 0; i < maxRows; i++) {
      const row = await DB.getNextDrainable();
      if (!row) break;

      try {
        const receipt = await drainOne(deps, row, function (ev) {
          if (onProgress) onProgress(Object.assign({ submission_id: row.submission_id }, ev));
        });
        // Terminal success: remove the row entirely once the caller has
        // had a chance to read the receipt (we keep one tick by deleting
        // synchronously inside this loop iteration).
        await DB.removeSubmission(row.submission_id);
        results.push({ submission_id: row.submission_id, ok: true, receipt: receipt });
      } catch (err) {
        const nextAttempts = (row.attempts_count || 0) + 1;
        if (nextAttempts >= MAX_ATTEMPTS) {
          await DB.markStatus(row.submission_id, DB.STATUS.FAILED_PERMANENT, {
            last_error_code:    err.code || "unknown",
            last_error_message: err.message || String(err)
          });
          await DB.appendAttempt(row.submission_id, {
            stage: "permanent_fail",
            code:  err.code || "unknown",
            message: err.message || String(err)
          });
          results.push({ submission_id: row.submission_id, ok: false, permanent: true, error: err });
        } else {
          await DB.markStatus(row.submission_id, DB.STATUS.FAILED_WILL_RETRY, {
            last_error_code:    err.code || "unknown",
            last_error_message: err.message || String(err),
            next_attempt_at:    nextBackoffAt(nextAttempts)
          });
          await DB.appendAttempt(row.submission_id, {
            stage: "transient_fail",
            code:  err.code || "unknown",
            message: err.message || String(err),
            next_attempt_at: nextBackoffAt(nextAttempts)
          });
          results.push({ submission_id: row.submission_id, ok: false, permanent: false, error: err });
          // Move on — the failed row is no longer drainable until
          // next_attempt_at, so getNextDrainable() will skip it.
        }
      }
    }
    return results;
  }

  // ---------- public: helpers for the form path ----------
  //
  // The form path enqueues a submission via queueSubmissionFromForm — this
  // is what the DCR form's onSubmit will call once we wire Phase 31 in.
  // For the prototype it's exercised by queue-test.html.

  async function queueSubmissionFromForm(input) {
    const DB = self.PIONEER_QUEUE_DB;
    if (!DB) throw new Error("queue-db.js not loaded");
    if (!input || !input.submission_id) throw new Error("submission_id required");
    if (!Array.isArray(input.photos))   throw new Error("photos array required (may be empty)");
    if (!(input.signature_blob instanceof Blob)) throw new Error("signature_blob (Blob) required");
    if (!input.payload)                  throw new Error("payload skeleton required");

    const photos = input.photos.map(function (p, i) {
      return {
        blob:           p.blob,
        content_type:   p.content_type || (p.blob && p.blob.type) || null,
        size_bytes:     p.blob && p.blob.size,
        ext:            p.ext || "jpg",
        planned_path:   "dcr-photos/" + (input.payload.customer_slug || input.payload.customer.slug) +
                        "/" + input.submission_id + "/photo-" + (i + 1) + "." + (p.ext || "jpg"),
        upload_status:  "pending"
      };
    });

    await DB.enqueueSubmission({
      submission_id:   input.submission_id,
      payload:         input.payload,
      photos:          photos,
      signature_blob:  input.signature_blob
    });
    return { submission_id: input.submission_id, ok: true, queued: true };
  }

  self.PIONEER_QUEUE_WORKER = {
    processQueue:            processQueue,
    queueSubmissionFromForm: queueSubmissionFromForm,
    drainOne:                drainOne,
    wrapUploadWithGuards:    wrapUploadWithGuards,
    runWithConcurrency:      runWithConcurrency,
    nextBackoffAt:           nextBackoffAt,
    STALL_MS:                STALL_MS,
    HARD_MS:                 HARD_MS,
    MAX_PARALLEL_PHOTOS:     MAX_PARALLEL_PHOTOS,
    MAX_ATTEMPTS:            MAX_ATTEMPTS,
    BACKOFF_SCHEDULE_MS:     BACKOFF_SCHEDULE_MS
  };
}());
