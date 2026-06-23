/* Pioneer DCR Hub — Phase 32B-4A submitClockEventV1 handler.
 *
 * Backend endpoint for the (future) clock event queue worker. Accepts
 * a clock_in or clock_out event from a tech's device, validates it,
 * enforces idempotency, and either writes the resulting session doc
 * (live path) or returns a synthetic "would-have-written" response
 * (dry-run path).
 *
 * SAFETY GATES (32B-4A is deploy-safe-inert):
 *   1. No client wiring exists yet — this endpoint has no production
 *      caller. service-clock.js direct path is untouched.
 *   2. dry_run defaults to true. Caller must explicitly send
 *      { dry_run: false } in the body to attempt a live write.
 *   3. LIVE_WRITE_ENABLED_EMAILS is empty. Even a caller sending
 *      { dry_run: false } gets forced back to dry-run because their
 *      email isn't allowlisted.
 *
 * To activate Bonnie's live writes later: add her email to
 * LIVE_WRITE_ENABLED_EMAILS AND have the worker (32B-3) send
 * dry_run: false. Both edits required, neither happens accidentally.
 *
 * The handler is exported as a plain function so tests can drive it
 * with mocked req/res/ctx. functions/index.js wires it into onRequest.
 */

"use strict";

// ---------- safety allowlist ----------
// Currently empty. Adding an email here + the worker sending
// dry_run: false = the only way to get a live Firestore mutation.
const LIVE_WRITE_ENABLED_EMAILS = [
  // "1blroot@gmail.com",   // Bonnie — uncomment + redeploy to flip pilot live
];

// ---------- constants ----------
const CLOCK_DRIFT_MAX_MS = 6 * 60 * 60 * 1000;  // 6 hours either direction
const FALLBACK_LOOKUP_WINDOW_MS = 60 * 1000;    // ±60s for mixed-mode idempotency
const FALLBACK_LOOKUP_LIMIT = 5;

// ---------- helpers ----------

function reply(res, status, body) {
  res.status(status).json(body);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function makeIdempotencyKey(staffUid, assignmentId, intentTsFloor) {
  return staffUid + ":" + assignmentId + ":" + intentTsFloor;
}

function shouldDryRun(body, staffEmail) {
  // Stack the two gates. Either gate triggers dry-run.
  if (body.dry_run !== false) return true;  // gate 1: explicit opt-out required
  if (LIVE_WRITE_ENABLED_EMAILS.indexOf(String(staffEmail || "").toLowerCase()) < 0) {
    return true;  // gate 2: allowlist
  }
  return false;
}

function dryRunReason(body, staffEmail) {
  // Why is dry-run active? Surfaced in response so callers + admins
  // can debug "why didn't my live write fire."
  if (body.dry_run !== false) return "dry_run_default";
  if (LIVE_WRITE_ENABLED_EMAILS.indexOf(String(staffEmail || "").toLowerCase()) < 0) {
    return "allowlist_denied";
  }
  return null;
}

// ---------- validation ----------

// Pure function. Takes the parsed body + the verified staff context.
// Returns null on success OR { status, body } on rejection.
function validateBody(body, staff) {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { ok: false, error: "schema_invalid", message: "Body must be JSON object." } };
  }
  if (body.schema_version !== 1) {
    return { status: 400, body: { ok: false, error: "schema_invalid", message: "schema_version must be 1.", details: { got: body.schema_version } } };
  }
  if (!isNonEmptyString(body.event_id)) {
    return { status: 400, body: { ok: false, error: "missing_field", message: "event_id is required.", details: { field: "event_id" } } };
  }
  if (body.type !== "clock_in" && body.type !== "clock_out") {
    return { status: 400, body: { ok: false, error: "wrong_type", message: "type must be clock_in or clock_out.", details: { got: body.type } } };
  }

  // Identity binding. If staff_uid is sent, it must match the token's uid.
  // Client may omit it (server uses token uid); sending the wrong one
  // is a hard error so callers can't spoof.
  if (body.staff_uid && body.staff_uid !== staff.uid) {
    return { status: 400, body: { ok: false, error: "schema_invalid", message: "staff_uid does not match auth token.", details: { token_uid: staff.uid } } };
  }

  if (typeof body.intent_ts !== "number") {
    return { status: 400, body: { ok: false, error: "missing_field", message: "intent_ts is required (number, epoch ms).", details: { field: "intent_ts" } } };
  }
  if (typeof body.intent_ts_floor !== "number") {
    return { status: 400, body: { ok: false, error: "missing_field", message: "intent_ts_floor is required.", details: { field: "intent_ts_floor" } } };
  }

  // Clock drift sanity. Catches broken-device-clock garbage and any
  // malicious payload trying to alter payroll hours far in the past
  // or future.
  const driftMs = Math.abs(body.intent_ts - Date.now());
  if (driftMs > CLOCK_DRIFT_MAX_MS) {
    return { status: 400, body: { ok: false, error: "clock_drift_too_large", message: "intent_ts is more than 6 hours from server time.", details: { drift_ms: driftMs, max_ms: CLOCK_DRIFT_MAX_MS } } };
  }

  // intent_ts_floor must equal floor(intent_ts / 60000) * 60000.
  // If client computed it from a different intent_ts, idempotency
  // dedup would silently miss replays.
  const expectedFloor = Math.floor(body.intent_ts / 60000) * 60000;
  if (body.intent_ts_floor !== expectedFloor) {
    return { status: 400, body: { ok: false, error: "intent_ts_floor_mismatch", message: "intent_ts_floor must equal floor(intent_ts / 60000) * 60000.", details: { expected: expectedFloor, got: body.intent_ts_floor } } };
  }

  // Type-specific required fields.
  if (body.type === "clock_in" && !isNonEmptyString(body.assignment_id)) {
    return { status: 400, body: { ok: false, error: "missing_field", message: "assignment_id is required for clock_in.", details: { field: "assignment_id" } } };
  }
  if (body.type === "clock_out" && !isNonEmptyString(body.session_id)) {
    return { status: 400, body: { ok: false, error: "missing_field", message: "session_id is required for clock_out.", details: { field: "session_id" } } };
  }

  return null;  // valid
}

// ---------- Firestore-bound checks ----------

// Returns { error: { status, body } } or { ok: true, doc }
async function validateAssignmentOwnership(db, assignmentId, staff) {
  let snap;
  try {
    snap = await db.collection("service_assignments").doc(assignmentId).get();
  } catch (err) {
    return { error: { status: 500, body: { ok: false, error: "internal", message: "Failed to read assignment.", details: { message: err && err.message } } } };
  }
  if (!snap.exists) {
    return { error: { status: 404, body: { ok: false, error: "assignment_not_found", message: "Assignment does not exist.", details: { assignment_id: assignmentId } } } };
  }
  const data = snap.data() || {};
  if (data.staff_uid && data.staff_uid !== staff.uid) {
    return { error: { status: 403, body: { ok: false, error: "assignment_not_yours", message: "This assignment is assigned to a different tech.", details: { assignment_id: assignmentId } } } };
  }
  return { ok: true, doc: Object.assign({ _id: snap.id }, data) };
}

async function validateSessionOwnership(db, sessionId, staff) {
  let snap;
  try {
    snap = await db.collection("pioneer_service_sessions").doc(sessionId).get();
  } catch (err) {
    return { error: { status: 500, body: { ok: false, error: "internal", message: "Failed to read session.", details: { message: err && err.message } } } };
  }
  if (!snap.exists) {
    return { error: { status: 409, body: { ok: false, error: "session_not_found", message: "Session does not exist. Likely an ordering race — worker should retry.", details: { session_id: sessionId } } } };
  }
  const data = snap.data() || {};
  if (data.staff_uid && data.staff_uid !== staff.uid) {
    return { error: { status: 403, body: { ok: false, error: "session_not_yours", message: "This session belongs to a different tech.", details: { session_id: sessionId } } } };
  }
  return { ok: true, doc: Object.assign({ _id: snap.id }, data) };
}

// ---------- idempotency ----------

// Returns null on miss OR { session_id, ... } on hit.
async function lookupExistingClockIn(db, staffUid, assignmentId, intentTs, intentTsFloor) {
  const key = makeIdempotencyKey(staffUid, assignmentId, intentTsFloor);

  // Primary lookup: docs explicitly stamped with idempotency_key by
  // submitClockEventV1's prior calls.
  try {
    const snap = await db.collection("pioneer_service_sessions")
      .where("idempotency_key", "==", key)
      .limit(1)
      .get();
    if (!snap.empty) {
      const d = snap.docs[0];
      return Object.assign({ session_id: d.id }, d.data());
    }
  } catch (err) {
    // Index missing or other read error — fall through to fallback.
  }

  // Fallback lookup: covers mixed-mode case where the tech clocked in
  // via the direct service-clock.js path (no idempotency_key field).
  // Match by staff_uid + assignment_id + clock_in_at within ±60s of
  // intent_ts. Slightly more permissive than the primary key.
  try {
    const snap = await db.collection("pioneer_service_sessions")
      .where("staff_uid",     "==", staffUid)
      .where("assignment_id", "==", assignmentId)
      .limit(FALLBACK_LOOKUP_LIMIT)
      .get();
    for (const d of snap.docs) {
      const data = d.data() || {};
      const ms = data.clock_in_at && typeof data.clock_in_at.toMillis === "function"
        ? data.clock_in_at.toMillis()
        : null;
      if (ms !== null && Math.abs(ms - intentTs) <= FALLBACK_LOOKUP_WINDOW_MS) {
        return Object.assign({ session_id: d.id }, data);
      }
    }
  } catch (err) {
    // Best-effort. If both lookups fail, idempotency is degraded but
    // not broken — a subsequent attempt with the same event_id would
    // still hit either the primary key (if write succeeded) or the
    // fallback (if write succeeded with different idempotency_key
    // field shape).
  }

  return null;
}

async function lookupExistingClockOut(db, sessionId) {
  try {
    const snap = await db.collection("pioneer_service_sessions").doc(sessionId).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (data.status === "completed" && data.clock_out_at) {
      return Object.assign({ session_id: sessionId }, data);
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ---------- live write (only fires when BOTH safety gates open) ----------

async function liveWriteClockIn(admin, db, body, staff, assignmentDoc) {
  const sessionRef = db.collection("pioneer_service_sessions").doc();
  const activeRef  = db.collection("active_service_sessions").doc(staff.uid);
  const punchRef   = db.collection("time_punches").doc();
  const intentTs = admin.firestore.Timestamp.fromMillis(body.intent_ts);
  const serverNow = admin.firestore.FieldValue.serverTimestamp();
  const idempotencyKey = makeIdempotencyKey(staff.uid, body.assignment_id, body.intent_ts_floor);

  await db.runTransaction(async function (tx) {
    // Re-check active singleton lock inside the transaction. Catches
    // race where another tab clocked the tech in between this fn's
    // outer reads and the transaction start.
    const activeSnap = await tx.get(activeRef);
    if (activeSnap.exists) {
      const ex = activeSnap.data() || {};
      if (ex.assignment_id !== body.assignment_id) {
        const err = new Error("clock_in_conflict");
        err.code = "clock_in_conflict";
        err.existing_active = { assignment_id: ex.assignment_id, customer_id: ex.customer_id };
        throw err;
      }
      // Same assignment already active — treated as already_processed
      // (defensive; idempotency lookup should have caught this).
      const err = new Error("already_active_same_assignment");
      err.code = "already_active_same_assignment";
      throw err;
    }

    const a = assignmentDoc;
    tx.set(sessionRef, {
      assignment_id:                 body.assignment_id,
      staff_uid:                     staff.uid,
      staff_email:                   staff.email,
      service_date:                  a.service_date,
      customer_id:                   a.customer_id  || null,
      customer_name:                 a.customer_name || null,
      location_id:                   a.location_id  || null,

      clock_in_at:                   intentTs,
      clock_in_source:               "submitClockEventV1",
      idempotency_key:               idempotencyKey,
      event_id:                      body.event_id,

      clock_out_at:                  null,
      status:                        "active",
      break_minutes:                 0,
      work_minutes:                  0,
      paid_minutes:                  0,
      paid_drive_minutes:            0,
      sick_accrual_eligible_minutes: 0,
      needs_review:                  false,
      dcr_submission_id:             null,

      created_at:                    serverNow,
      updated_at:                    serverNow,
      server_received_at:            serverNow
    });

    tx.set(activeRef, {
      staff_uid:     staff.uid,
      session_id:    sessionRef.id,
      assignment_id: body.assignment_id,
      customer_id:   a.customer_id || null,
      clock_in_at:   intentTs,
      service_date:  a.service_date
    });

    tx.set(punchRef, {
      punch_type:    "clock_in",
      staff_uid:     staff.uid,
      staff_email:   staff.email,
      service_date:  a.service_date,
      assignment_id: body.assignment_id,
      session_id:    sessionRef.id,
      customer_id:   a.customer_id || null,
      punch_at:      intentTs,
      client_ts:     body.intent_ts,
      server_received_at: serverNow,
      source:        "submitClockEventV1",
      event_id:      body.event_id
    });
  });

  return { session_id: sessionRef.id };
}

async function liveWriteClockOut(admin, db, body, staff, sessionDoc) {
  const sessionRef = db.collection("pioneer_service_sessions").doc(body.session_id);
  const activeRef  = db.collection("active_service_sessions").doc(staff.uid);
  const punchRef   = db.collection("time_punches").doc();
  const intentTs = admin.firestore.Timestamp.fromMillis(body.intent_ts);
  const serverNow = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async function (tx) {
    const sessSnap = await tx.get(sessionRef);
    if (!sessSnap.exists) {
      const err = new Error("session_not_found"); err.code = "session_not_found"; throw err;
    }
    const s = sessSnap.data() || {};
    if (s.status !== "active") {
      const err = new Error("session_not_active"); err.code = "session_not_active"; throw err;
    }

    let workMinutes = 0;
    if (s.clock_in_at && typeof s.clock_in_at.toMillis === "function") {
      const ms = body.intent_ts - s.clock_in_at.toMillis();
      workMinutes = Math.max(0, Math.floor(ms / 60000));
    }

    tx.update(sessionRef, {
      status:                        "completed",
      clock_out_at:                  intentTs,
      clock_out_source:              "submitClockEventV1",
      clock_out_event_id:            body.event_id,
      work_minutes:                  workMinutes,
      paid_minutes:                  workMinutes,
      paid_drive_minutes:            0,
      break_minutes:                 0,
      sick_accrual_eligible_minutes: workMinutes,
      updated_at:                    serverNow
    });

    tx.delete(activeRef);

    tx.set(punchRef, {
      punch_type:    "clock_out",
      staff_uid:     staff.uid,
      staff_email:   staff.email,
      service_date:  s.service_date,
      assignment_id: s.assignment_id,
      session_id:    body.session_id,
      customer_id:   s.customer_id || null,
      punch_at:      intentTs,
      client_ts:     body.intent_ts,
      server_received_at: serverNow,
      source:        "submitClockEventV1",
      event_id:      body.event_id
    });
  });

  return { session_id: body.session_id };
}

// ---------- main handler ----------

async function handler(req, res, ctx) {
  const { admin, db, logger, verifyStaffOrReject } = ctx;

  // CORS preflight (cors: false in onRequest means we handle it).
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") {
    return reply(res, 405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  }

  // Auth (writes 401 + returns null on failure).
  const staff = await verifyStaffOrReject(req, res);
  if (!staff) return;

  const body = req.body || {};

  // Pure validation.
  const vErr = validateBody(body, staff);
  if (vErr) return reply(res, vErr.status, vErr.body);

  // Type-specific ownership reads.
  let assignmentDoc = null;
  let sessionDoc = null;
  if (body.type === "clock_in") {
    const r = await validateAssignmentOwnership(db, body.assignment_id, staff);
    if (r.error) return reply(res, r.error.status, r.error.body);
    assignmentDoc = r.doc;
  } else {
    const r = await validateSessionOwnership(db, body.session_id, staff);
    if (r.error) return reply(res, r.error.status, r.error.body);
    sessionDoc = r.doc;
  }

  // Idempotency lookup.
  let cached = null;
  if (body.type === "clock_in") {
    cached = await lookupExistingClockIn(db, staff.uid, body.assignment_id, body.intent_ts, body.intent_ts_floor);
  } else {
    cached = await lookupExistingClockOut(db, body.session_id);
  }
  const dryRun = shouldDryRun(body, staff.email);
  const dryRunWhy = dryRun ? dryRunReason(body, staff.email) : null;

  if (cached) {
    logger && logger.info && logger.info("submitClockEventV1 idempotency hit", {
      event_id: body.event_id, type: body.type, session_id: cached.session_id,
      tech_uid: staff.uid, dry_run: dryRun
    });
    return reply(res, 200, {
      ok: true,
      type: body.type,
      event_id: body.event_id,
      dry_run: dryRun,
      dry_run_reason: dryRunWhy,
      already_processed: true,
      session_id: cached.session_id,
      assignment_id: body.assignment_id || cached.assignment_id || null,
      clock_at: new Date(body.intent_ts).toISOString()
    });
  }

  // Dry-run synthetic response — every validation has passed but no
  // Firestore mutation happens.
  if (dryRun) {
    logger && logger.info && logger.info("submitClockEventV1 dry-run synthetic response", {
      event_id: body.event_id, type: body.type, tech_uid: staff.uid, reason: dryRunWhy
    });
    return reply(res, 200, {
      ok: true,
      type: body.type,
      event_id: body.event_id,
      dry_run: true,
      dry_run_reason: dryRunWhy,
      already_processed: false,
      would_create: {
        clock_at: new Date(body.intent_ts).toISOString(),
        idempotency_key: body.type === "clock_in"
          ? makeIdempotencyKey(staff.uid, body.assignment_id, body.intent_ts_floor)
          : null,
        session_doc_id: body.type === "clock_in" ? "(would generate fresh)" : body.session_id
      }
    });
  }

  // Live write path. Only reaches here when both safety gates are open.
  try {
    let result;
    if (body.type === "clock_in") {
      result = await liveWriteClockIn(admin, db, body, staff, assignmentDoc);
    } else {
      result = await liveWriteClockOut(admin, db, body, staff, sessionDoc);
    }
    logger && logger.info && logger.info("submitClockEventV1 live write", {
      event_id: body.event_id, type: body.type, session_id: result.session_id, tech_uid: staff.uid
    });
    return reply(res, 200, {
      ok: true,
      type: body.type,
      event_id: body.event_id,
      dry_run: false,
      already_processed: false,
      session_id: result.session_id,
      assignment_id: body.assignment_id || (sessionDoc && sessionDoc.assignment_id) || null,
      clock_at: new Date(body.intent_ts).toISOString(),
      server_received_at: new Date().toISOString()
    });
  } catch (err) {
    if (err && err.code === "clock_in_conflict") {
      return reply(res, 409, { ok: false, error: "clock_in_conflict", message: "Tech already has an active session at a different assignment.", details: { existing_active: err.existing_active || null } });
    }
    if (err && err.code === "already_active_same_assignment") {
      return reply(res, 200, { ok: true, type: body.type, event_id: body.event_id, dry_run: false, already_processed: true, message: "Already active for this assignment." });
    }
    if (err && err.code === "session_not_found") {
      return reply(res, 409, { ok: false, error: "session_not_found", message: "Session disappeared between lookup and write." });
    }
    if (err && err.code === "session_not_active") {
      return reply(res, 409, { ok: false, error: "session_not_active", message: "Session is no longer active (already completed or canceled)." });
    }
    logger && logger.error && logger.error("submitClockEventV1 live write failed", { event_id: body.event_id, error: err && err.message });
    return reply(res, 500, { ok: false, error: "internal", message: "Server transaction failed.", details: { message: err && err.message } });
  }
}

module.exports = {
  handler:                handler,
  // exported for harness tests
  validateBody:           validateBody,
  shouldDryRun:           shouldDryRun,
  dryRunReason:           dryRunReason,
  makeIdempotencyKey:     makeIdempotencyKey,
  LIVE_WRITE_ENABLED_EMAILS: LIVE_WRITE_ENABLED_EMAILS,
  CLOCK_DRIFT_MAX_MS:     CLOCK_DRIFT_MAX_MS
};
