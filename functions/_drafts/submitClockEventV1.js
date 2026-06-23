/* Pioneer DCR Hub — Phase 32B-4 design draft.
 *
 * STATUS UPDATE 2026-06-23: Phase 32B-4A implementation has shipped.
 * The actual handler lives at functions/submitClockEventV1.js and is
 * exported from functions/index.js. This file is preserved as the
 * original design reference — the implementation matches it with
 * three additions:
 *   1. dry_run defaults to true (safety gate 1)
 *   2. LIVE_WRITE_ENABLED_EMAILS allowlist (safety gate 2, currently empty)
 *   3. dry_run_reason field on responses for diagnostic clarity
 *
 * Below is the original design draft (preserved verbatim).
 *
 * STATUS: DESIGN ONLY. NOT EXPORTED. NOT WIRED. NOT DEPLOYED.
 *
 * This file lives in functions/_drafts/ so the Cloud Functions deploy
 * surface (which walks `exports.*` in functions/index.js) cannot pick
 * it up. Identical convention as functions/_drafts/submitDcrV1-idempotency.js
 * during Phase 31A.
 *
 * Purpose: When the Phase 32B-3 worker drains a clock event from the
 * IndexedDB queue, it POSTs the event payload to this Cloud Function.
 * The function applies an idempotency guard, then performs the same
 * Firestore transaction that service-clock.js#clockIn / #clockOut
 * does today — but server-side, with retry safety, and using the
 * tech's intent_ts (NOT serverTimestamp) so payroll precision is
 * preserved across queue delay.
 *
 * Foundation sprint (2026-06-23) ships this as a design doc only.
 * Integration is a future sprint after 32B-1 + 32B-5 are committed
 * and the Phase 31E Bonnie debrief (2026-06-29) confirms the
 * queue+idempotency pattern is durable enough to extend to payroll.
 *
 * ============================================================
 * REQUEST CONTRACT
 * ============================================================
 *
 * POST https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitClockEventV1
 *   Authorization: Bearer <Firebase Auth ID token>
 *   Content-Type:  application/json
 *
 * Body:
 *   {
 *     schema_version:  1,
 *     event_id:        <UUIDv4 string, client-generated>,
 *     device_id:       <string, mirrors pioneer.device.id from Phase 31>,
 *     type:            "clock_in" | "clock_out",
 *     assignment_id:   <string, required when type=clock_in>,
 *     session_id:      <string, required when type=clock_out>,
 *     intent_ts:       <number, epoch ms — when tech tapped the button>,
 *     intent_ts_floor: <number, intent_ts floored to nearest minute>,
 *     geo: {
 *       lat:        <number | null>,
 *       lon:        <number | null>,
 *       accuracy_m: <number | null>,
 *       status:     "ok" | "denied" | "timeout" | "unavailable" | "error"
 *     }
 *   }
 *
 * Response (200):
 *   {
 *     ok:                true,
 *     already_processed: <bool>,
 *     type:              "clock_in" | "clock_out",
 *     session_id:        <string>,
 *     assignment_id:     <string>,
 *     clock_at:          <ISO 8601 string from intent_ts>
 *   }
 *
 * Response codes:
 *   200 — success or idempotent replay
 *   400 — missing/invalid fields, wrong type, bad timestamp
 *   401 — missing or invalid Authorization header
 *   403 — tech not assigned to the customer (clock_in) OR
 *         session not owned by signing tech (clock_out)
 *   409 — clock_in for a tech who already has a different active row
 *         (need to clock out first; client surfaces the active row to user)
 *   5xx — Firestore unavailable; client retries via the queue worker
 *
 * ============================================================
 * IDEMPOTENCY CONTRACT
 * ============================================================
 *
 * The queue worker may retry the same logical event multiple times.
 * Two replay scenarios:
 *
 *   (a) Network drop after the SDK retry budget exhausts. Client sees
 *       failure; worker re-queues; eventually re-fires. Server-side
 *       state from the first call may or may not have committed.
 *   (b) Mid-transaction page-kill. Same as (a) — non-deterministic.
 *
 * The guard handles both by using deterministic idempotency keys:
 *
 *   CLOCK_IN:
 *     key = staff_uid + ":" + assignment_id + ":" + intent_ts_floor
 *     Stored on the resulting pioneer_service_sessions doc as
 *     `idempotency_key` (new field; backward-compatible).
 *     Replay path: query pioneer_service_sessions WHERE idempotency_key
 *     == this key. If exists, return cached receipt. If not, proceed
 *     with the original clockIn transaction.
 *     Why intent_ts_floor and not intent_ts: two taps within the same
 *     minute should be deduped (anti-double-tap); two taps in adjacent
 *     minutes are intentional separate events (e.g., immediately
 *     clocking out + back in for a labor-type switch).
 *
 *   CLOCK_OUT:
 *     key = session_id
 *     Server reads pioneer_service_sessions/{session_id}. If
 *     `status === "completed"` and `clock_out_at` is set, return cached
 *     receipt. Otherwise proceed with the original clockOut transaction.
 *     Why session_id: there's only one clock-out per session, ever, so
 *     the session id itself is a perfect idempotency key.
 *
 * Pattern matches Phase 31A's enforceIdempotency for submitDcrV1.
 * That helper has been live in production since 2026-06-22 08:15 PT
 * and the Bonnie pilot (2026-06-22 to 2026-06-29) is exercising it
 * in the real world; its proof-of-concept directly informs this design.
 *
 * ============================================================
 * SIDE-EFFECT MAP
 * ============================================================
 *
 *   CLOCK_IN — server runs the same Firestore transaction as
 *   service-clock.js:1462-1568, with these changes:
 *
 *     pioneer_service_sessions/{newId} = {
 *       ... [all fields from clockIn transaction, unchanged] ...
 *       clock_in_at:     admin.firestore.Timestamp.fromMillis(intent_ts),
 *                        // ^ was serverTimestamp; now intent_ts for
 *                        //   payroll-accurate work_minutes calc
 *       clock_in_source: "submitClockEventV1",
 *                        // ^ distinguishes queued from direct
 *                        //   (today's value is "work_html_phase_1d_lite")
 *       idempotency_key: staff_uid + ":" + assignment_id +
 *                        ":" + intent_ts_floor
 *                        // ^ NEW field; only set when this fn writes
 *                        //   the doc; absent on docs from direct
 *                        //   service-clock.js path
 *     }
 *
 *     active_service_sessions/{staff_uid} = {
 *       ... [unchanged] ...
 *       clock_in_at: Timestamp.fromMillis(intent_ts)
 *     }
 *
 *     time_punches/{newId} = {
 *       ... [unchanged] ...
 *       punch_at:     Timestamp.fromMillis(intent_ts),
 *       client_ts:    intent_ts,
 *       server_received_at: serverTimestamp()
 *                          // ^ NEW; lets payroll cross-check the queue delay
 *     }
 *
 *   CLOCK_OUT — server runs service-clock.js:1623-1707 transaction,
 *   with these changes:
 *
 *     pioneer_service_sessions/{session_id} = merge {
 *       status:        "completed",
 *       clock_out_at:  Timestamp.fromMillis(intent_ts),
 *       clock_out_source: "submitClockEventV1",
 *       work_minutes:  Math.floor((intent_ts - clock_in_at.toMillis()) / 60000),
 *                      // ^ computed from intent_ts (accurate) not now
 *       paid_minutes:  same,
 *       updated_at:    serverTimestamp
 *     }
 *
 *     active_service_sessions/{staff_uid} = DELETE
 *
 *     time_punches/{newId} = {
 *       ... unchanged ...
 *       punch_at: Timestamp.fromMillis(intent_ts)
 *     }
 *
 * ============================================================
 * INTEGRATION DIFF (for future sprint)
 * ============================================================
 *
 * functions/index.js — add at the end of the file:
 *
 *   const submitClockEvent = require("./submitClockEventV1");
 *   exports.submitClockEventV1 = onRequest({
 *     cors: false,
 *     timeoutSeconds: 30,
 *     // No new secrets needed.
 *   }, submitClockEvent.handler);
 *
 * The handler module then implements:
 *   - verifyStaffOrReject (existing helper)
 *   - validate body (similar to validateDcrPayload)
 *   - branch on type === "clock_in" vs "clock_out"
 *   - call enforceClockInIdempotency / enforceClockOutIdempotency
 *   - return cached or run transaction
 *
 * No schema migration needed on pioneer_service_sessions because the
 * new fields (idempotency_key, clock_in_source/clock_out_source,
 * server_received_at on time_punches) are additive and backward-
 * compatible. Existing docs without these fields remain readable;
 * payroll/labor-review tabs don't care about them.
 *
 * ============================================================
 * TEST PLAN (for future integration sprint)
 * ============================================================
 *
 *   S1. clock_in fresh event -> creates pioneer + active + punch
 *       transactionally; response includes new session_id; field
 *       idempotency_key stamped on session doc.
 *   S2. clock_in replay (same event_id) -> returns cached receipt;
 *       no second pioneer_service_sessions doc; no second time_punch.
 *   S3. clock_in for tech who already has an active row at a
 *       DIFFERENT assignment -> 409 with the other assignment's id
 *       in the error body so client can surface "clock out of X first".
 *   S4. clock_out fresh event -> flips pioneer session to completed,
 *       deletes active, writes punch. work_minutes computed from
 *       intent_ts - clock_in_at (not now - clock_in_at).
 *   S5. clock_out replay (same session_id) -> returns cached receipt
 *       containing the existing completed session.
 *   S6. clock_out for a session not owned by signing tech -> 403.
 *   S7. clock_out for a session that doesn't exist -> 404 or 409
 *       (TBD; recommend 409 because the typical cause is a queue
 *       worker draining a clock-out before its clock-in landed).
 *   S8. Cross-staff replay (same event_id, different signing tech)
 *       -> idempotency guard refuses (mirrors Phase 31A behavior).
 *
 * ============================================================
 * INTERACTION WITH EXISTING DIRECT CLOCK-IN/OUT PATH
 * ============================================================
 *
 * service-clock.js#clockIn/#clockOut continues to work unchanged.
 * Techs not in the queue-pilot allowlist clock in/out directly via
 * Firestore (current behavior). The pilot allowlist (TBD, possibly
 * the same PHASE_31_E_PILOT_ACCOUNTS) gates whether the client
 * worker routes through submitClockEventV1 or hits Firestore directly.
 *
 * Idempotency guard on the direct path is unnecessary because the
 * direct path is synchronous from the user-gesture click — no retry
 * loop, no queue. Server doesn't need to dedupe direct clicks.
 *
 * Mixed-mode safety: if a tech somehow has BOTH a direct doc AND a
 * queued event for the same intent_ts_floor, the queue's
 * enforceIdempotency reads the direct doc (which has no
 * idempotency_key field) and... returns null (not a match). Result:
 * the queue's clock-in fires a SECOND transaction. To prevent this,
 * the guard's query needs to fall back to "same staff_uid + same
 * assignment_id + clock_in_at within 60s" when no idempotency_key
 * match is found. Cost: one extra Firestore read per fresh clock-in.
 * Acceptable.
 *
 * ============================================================
 * OPEN QUESTIONS (for stakeholder review before integration)
 * ============================================================
 *
 *   1. Is intent_ts as clock_in_at acceptable to payroll? It trusts
 *      the client clock. Tech device clock drift is typically small
 *      (NTP-synced) but theoretically unbounded. Alternative: keep
 *      serverTimestamp and accept the queue-delay drift.
 *      Recommendation: intent_ts, with a sanity check (reject events
 *      where |intent_ts - serverNow| > 6 hours as likely-malicious
 *      or clock-broken).
 *
 *   2. What error UX for 409 (already clocked into different stop)?
 *      The current direct path throws an Error that becomes an
 *      alert(). For the queue path, the worker would need a clear
 *      "stop draining this event; show retry banner with extra
 *      context" path.
 *
 *   3. Pilot scope — extend Phase 31E flag (Bonnie) or a new
 *      OFFLINE_CLOCK_ENABLED per-user gate?
 *
 *   4. When clock_out drains BEFORE its clock_in (worker ordering
 *      bug, network race) -> server returns 409. Client worker
 *      should re-queue the clock_out, not mark it permanent-fail.
 *      Worker-side ordering enforcement is in 32B-3 scope.
 */

"use strict";

// Intentionally NO exports. This file is design + planning only.
// Integration in a future sprint will create either:
//   - functions/submitClockEventV1.js with the actual handler
//   - or inline in functions/index.js
// AND a one-line `exports.submitClockEventV1 = ...` in functions/index.js
// at that time. Until then, this file is documentation.

module.exports = {};
