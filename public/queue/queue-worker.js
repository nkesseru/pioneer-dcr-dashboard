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

  /* ----------------------------------------------------------------------
   * Phase 31C — dcr_pending_uploads shadow doc.
   *
   * Best-effort beacon to /admin so an operator can see what's queued on
   * a tech's device. Mirrors lifecycle transitions; deleted on terminal
   * success. NEVER throws into the upload pipeline — every helper catches
   * its own errors, logs a [queue-shadow] warning, and returns.
   *
   * Gated by shadowEnabled() which checks:
   *   1. OFFLINE_QUEUE_ENABLED === true (Phase 31 feature flag)
   *   2. window.firebase + firestore available (catches load-order edge cases)
   *
   * Source of truth for the queued DCR's payload + photos remains the
   * device's IndexedDB. The shadow doc holds NO blobs, NO payload — only
   * the metadata needed for the admin grid (tech identity, customer,
   * status, error codes, attempt counters).
   *
   * Schema matches firestore.rules /dcr_pending_uploads block (deployed
   * 2026-06-22): immutable identity fields on update (submission_id,
   * tech_uid, tech_email, customer_slug, schema_version, queued_at);
   * status restricted to enum.
   * --------------------------------------------------------------------- */

  const DEVICE_ID_KEY = "pioneer.device.id";

  function getOrCreateDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (id) return id;
      id = (self.crypto && self.crypto.randomUUID)
        ? self.crypto.randomUUID()
        : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
      localStorage.setItem(DEVICE_ID_KEY, id);
      return id;
    } catch (_e) {
      return "unknown-device";
    }
  }

  function shadowEnabled() {
    return !!(self.OFFLINE_QUEUE_ENABLED
           && self.firebase
           && typeof self.firebase.firestore === "function");
  }

  async function createShadowDoc(input) {
    if (!shadowEnabled()) return;
    try {
      const user = self.firebase.auth().currentUser;
      if (!user) {
        try { console.warn("[queue-shadow] no signed-in user — skipping shadow create", { submission_id: input.submission_id }); } catch (_e) {}
        return;
      }
      const p   = input.payload || {};
      const fs  = self.firebase.firestore();
      const fv  = self.firebase.firestore.FieldValue;

      const customerSlug = p.customer_slug
                        || (p.customer && p.customer.slug) || "";
      const customerName = p.customer_name
                        || (p.customer && p.customer.name) || "";
      const techSlug     = p.tech_slug
                        || (p.tech && p.tech.slug) || null;
      const techDisplay  = p.tech_display_name
                        || (p.tech && p.tech.display_name) || null;

      await fs.collection("dcr_pending_uploads").doc(input.submission_id).set({
        submission_id:              input.submission_id,
        schema_version:             1,
        device_id:                  getOrCreateDeviceId(),
        tech_uid:                   user.uid,
        tech_email:                 (user.email || "").toLowerCase(),
        tech_slug:                  techSlug,
        tech_display_name:          techDisplay,
        customer_slug:              customerSlug,
        customer_name:              customerName,
        clean_date:                 p.clean_date || "",
        pioneer_assignment_id:      p.pioneer_assignment_id || null,
        pioneer_service_session_id: p.pioneer_service_session_id || null,
        deputy_shift_id:            p.deputy_shift_id || null,
        photo_count:                (input.photos || []).length,
        has_signature:              !!input.signature_blob,
        status:                     "queued",
        queued_at:                  fv.serverTimestamp(),
        last_attempt_at:            null,
        attempt_count:              0,
        next_attempt_at:            null,
        last_error_code:            null,
        last_error_message:         null,
        created_at:                 fv.serverTimestamp(),
        updated_at:                 fv.serverTimestamp()
      });
      try { console.info("[queue-shadow] create ok", { submission_id: input.submission_id, customer_slug: customerSlug }); } catch (_e) {}
    } catch (err) {
      try { console.warn("[queue-shadow] create failed (non-fatal)", { submission_id: input && input.submission_id, err: err && err.message }); } catch (_e) {}
    }
  }

  async function updateShadowStatus(submissionId, patch) {
    if (!shadowEnabled()) return;
    try {
      const fs = self.firebase.firestore();
      const fv = self.firebase.firestore.FieldValue;
      const update = Object.assign({}, patch, { updated_at: fv.serverTimestamp() });
      // next_attempt_at: convert epoch-ms to Firestore Timestamp so the
      // doc-stored type matches the schema (timestamp, not number).
      if (typeof update.next_attempt_at === "number") {
        update.next_attempt_at = self.firebase.firestore.Timestamp.fromMillis(update.next_attempt_at);
      }
      // last_attempt_at: server timestamp sentinel — caller can pass "SERVER".
      if (update.last_attempt_at === "SERVER") {
        update.last_attempt_at = fv.serverTimestamp();
      }
      await fs.collection("dcr_pending_uploads").doc(submissionId).update(update);
      try { console.info("[queue-shadow] update ok", { submission_id: submissionId, status: patch.status }); } catch (_e) {}
    } catch (err) {
      try { console.warn("[queue-shadow] update failed (non-fatal)", { submission_id: submissionId, err: err && err.message }); } catch (_e) {}
    }
  }

  async function deleteShadowDoc(submissionId) {
    if (!shadowEnabled()) return;
    try {
      const fs = self.firebase.firestore();
      await fs.collection("dcr_pending_uploads").doc(submissionId).delete();
      try { console.info("[queue-shadow] delete ok", { submission_id: submissionId }); } catch (_e) {}
    } catch (err) {
      try { console.warn("[queue-shadow] delete failed (non-fatal)", { submission_id: submissionId, err: err && err.message }); } catch (_e) {}
    }
  }

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
    // Phase 31C — mirror the "now uploading" transition to the shadow doc.
    // Best-effort; never blocks the upload.
    await updateShadowStatus(row.submission_id, {
      status:          "uploading",
      last_attempt_at: "SERVER",
      attempt_count:   (row.attempts_count || 0) + 1
    });

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
        // Phase 31C — also remove the admin-visible shadow doc.
        await deleteShadowDoc(row.submission_id);
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
          // Phase 31C — mirror permanent-failure to the shadow doc so
          // admin can see this device needs human attention.
          await updateShadowStatus(row.submission_id, {
            status:             "failed_permanent",
            last_error_code:    err.code || "unknown",
            last_error_message: err.message || String(err)
          });
          results.push({ submission_id: row.submission_id, ok: false, permanent: true, error: err });
        } else {
          const nextAt = nextBackoffAt(nextAttempts);
          await DB.markStatus(row.submission_id, DB.STATUS.FAILED_WILL_RETRY, {
            last_error_code:    err.code || "unknown",
            last_error_message: err.message || String(err),
            next_attempt_at:    nextAt
          });
          await DB.appendAttempt(row.submission_id, {
            stage: "transient_fail",
            code:  err.code || "unknown",
            message: err.message || String(err),
            next_attempt_at: nextAt
          });
          // Phase 31C — mirror transient-failure with the scheduled retry
          // time so admin grid can show "next attempt in ~30s" UX.
          await updateShadowStatus(row.submission_id, {
            status:             "failed_will_retry",
            last_error_code:    err.code || "unknown",
            last_error_message: err.message || String(err),
            next_attempt_at:    nextAt
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
    // Phase 31C — write the admin-visible shadow doc. Best-effort: a
    // failure here (Firestore unreachable, etc.) does NOT undo the IDB
    // enqueue. The DCR remains safely on-device; the worker will create
    // the shadow on first drain attempt if we add a re-try here later.
    await createShadowDoc(input);
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
    BACKOFF_SCHEDULE_MS:     BACKOFF_SCHEDULE_MS,
    // Phase 31C — shadow doc helpers exposed for QA + future Phase D
    // admin tile. shadowEnabled() returns the boolean used internally to
    // gate every write. getOrCreateDeviceId() is idempotent.
    getOrCreateDeviceId:     getOrCreateDeviceId,
    shadowEnabled:           shadowEnabled,
    createShadowDoc:         createShadowDoc,
    updateShadowStatus:      updateShadowStatus,
    deleteShadowDoc:         deleteShadowDoc
  };
}());
