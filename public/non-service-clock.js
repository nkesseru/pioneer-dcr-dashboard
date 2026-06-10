/* ============================================================================
 * non-service-clock.js — Phase Timeclock Add-On
 *
 * Clock-in / clock-out helpers for NON-cleaning paid labor: inspection
 * walks (from /inspections) and supply-station shifts (from /supply-station).
 * Cleaning labor still goes through the canonical service-clock.js — this
 * module deliberately uses the SAME backing collections so all paid time
 * lands in one place for payroll:
 *
 *   - pioneer_service_sessions/{sessionId}   — the durable record
 *   - active_service_sessions/{staff_uid}    — the singleton "is clocked in" lock
 *
 * The only schema-level addition is the `labor_type` field on each row
 * (and a few inspection-specific hooks: customer_slug, customer_name,
 * inspection_id). When labor_type !== "cleaning" the downstream consumers
 * (payrollIsBlocker, manager.js missing-DCR filter, admin labor review)
 * skip the DCR + assignment_id checks. See gate comments inline in those
 * consumers.
 *
 * Cross-type safety: the singleton lock at active_service_sessions/{uid}
 * is shared with service-clock.js, so a tech who's actively cleaning
 * cannot start an inspection or supply shift, and vice versa. The error
 * message names the active labor type so the user knows what to end first.
 *
 * Public API (window.NonServiceClock):
 *   clockIn(staff, laborType, opts)   -> sessionId
 *   clockOut(staff, laborType)        -> { sessionId, workMinutes }
 *   getActive(staff)                  -> active doc or null
 *   patchActiveSession(staff, fields) -> updates the running session
 *
 * Out of scope: paid_drive_minutes, OT split, geo_status — non-cleaning
 * labor has none of those mechanics.
 * ========================================================================== */

(function () {
  'use strict';

  const LABOR_TYPES = Object.freeze({
    INSPECTION:    'inspection',
    SUPPLY_STATION: 'supply_station'
  });

  const LABOR_TYPE_LABEL = Object.freeze({
    cleaning:       'Cleaning',
    inspection:     'Inspection',
    supply_station: 'Supply Station'
  });

  function db() {
    if (!window.firebase || typeof firebase.firestore !== 'function') {
      throw new Error('non-service-clock: firestore SDK not ready');
    }
    return firebase.firestore();
  }
  function sts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function todayPacific() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }
  function lc(s) { return String(s || '').toLowerCase().trim(); }

  function ensureLaborType(value) {
    if (value === LABOR_TYPES.INSPECTION || value === LABOR_TYPES.SUPPLY_STATION) return value;
    throw new Error('non-service-clock: invalid labor type "' + value + '"');
  }

  async function getActive(staff) {
    if (!staff || !staff.uid) return null;
    const snap = await db().collection('active_service_sessions').doc(staff.uid).get();
    if (!snap.exists) return null;
    return Object.assign({ _id: snap.id }, snap.data() || {});
  }

  /**
   * Start a non-cleaning shift. Transaction-safe — if anything is
   * already in the singleton lock (cleaning, inspection, supply, any
   * type) the call throws with a human-readable message naming the
   * existing shift type. Returns the new pioneer_service_sessions id.
   *
   * opts (all optional):
   *   customer_slug, customer_name   — captured at start if known
   *   inspection_id                  — usually attached later via patchActiveSession
   */
  async function clockIn(staff, laborType, opts) {
    if (!staff || !staff.uid) throw new Error('Sign in required.');
    const lt = ensureLaborType(laborType);
    opts = opts || {};
    const firestore = db();
    const activeRef  = firestore.collection('active_service_sessions').doc(staff.uid);
    const sessionRef = firestore.collection('pioneer_service_sessions').doc();
    const today      = todayPacific();
    const staffEmail = lc(staff.email);
    const staffName  = (staff.tech && (staff.tech.display_name || staff.tech.tech_display_name))
                       || (staff.email ? staff.email.split('@')[0] : 'Staff');

    await firestore.runTransaction(async function (tx) {
      const activeSnap = await tx.get(activeRef);
      if (activeSnap.exists) {
        const ex = activeSnap.data() || {};
        const exType = ex.labor_type || 'cleaning';
        const exLabel = LABOR_TYPE_LABEL[exType] || exType;
        const hint = exType === 'cleaning'
          ? ' (' + (ex.customer_id || ex.assignment_id || '') + ')'
          : '';
        throw new Error('Already clocked in for ' + exLabel + hint + '. Clock out first.');
      }
      tx.set(sessionRef, {
        // labor classification — the key field downstream consumers
        // gate on to skip cleaning-specific checks (DCR, assignment).
        labor_type:                    lt,
        source:                        lt,
        // identity + day
        staff_uid:                     staff.uid,
        staff_email:                   staffEmail,
        staff_display_name:            staffName,
        service_date:                  today,
        // customer hooks — populated when known, otherwise empty.
        assignment_id:                 '',
        customer_id:                   opts.customer_slug || '',
        customer_name:                 opts.customer_name || '',
        // inspection linkage (back-filled via patchActiveSession on submit)
        inspection_id:                 opts.inspection_id || null,
        // clock fields — mirror service-clock.js shape so payroll
        // export can ingest these rows without special-casing.
        clock_in_at:                   sts(),
        clock_out_at:                  null,
        status:                        'active',
        break_minutes:                 0,
        work_minutes:                  0,
        paid_minutes:                  0,
        paid_drive_minutes:            0,
        sick_accrual_eligible_minutes: 0,
        needs_review:                  false,
        accrued_in_period_id:          null,
        // DCR fields — explicitly null. Consumers must check labor_type
        // before flagging these as missing.
        dcr_submission_id:             null,
        dcr_id:                        null,
        dcr_status:                    null,
        // timestamps
        created_at:                    sts(),
        updated_at:                    sts()
      });
      tx.set(activeRef, {
        staff_uid:     staff.uid,
        session_id:    sessionRef.id,
        labor_type:    lt,
        source:        lt,
        // assignment_id/customer_id are part of the existing schema for
        // service-clock; we write blanks so the doc shape stays uniform.
        assignment_id: '',
        customer_id:   opts.customer_slug || '',
        clock_in_at:   sts(),
        service_date:  today
      });
    });

    return sessionRef.id;
  }

  /**
   * End the current non-cleaning shift. Reads the singleton lock to find
   * the session id, computes work_minutes from the recorded clock_in_at,
   * flips the session to completed, and deletes the lock.
   *
   * Throws if (a) nothing is active, (b) the active shift is a DIFFERENT
   * labor type than what was requested (caller asked to end an inspection
   * but the lock says cleaning) — the latter prevents one page from
   * accidentally clobbering another page's active shift.
   */
  async function clockOut(staff, expectedLaborType) {
    if (!staff || !staff.uid) throw new Error('Sign in required.');
    const lt = ensureLaborType(expectedLaborType);
    const firestore = db();
    const activeRef = firestore.collection('active_service_sessions').doc(staff.uid);
    const activeSnap = await activeRef.get();
    if (!activeSnap.exists) throw new Error('Not currently clocked in.');
    const a = activeSnap.data() || {};
    if ((a.labor_type || 'cleaning') !== lt) {
      const got = LABOR_TYPE_LABEL[a.labor_type || 'cleaning'] || a.labor_type;
      throw new Error('Active shift is ' + got + ', not ' + LABOR_TYPE_LABEL[lt] + '. End it from its own page.');
    }
    if (!a.session_id) throw new Error('Active lock has no session id — please contact an admin.');

    const sessionRef = firestore.collection('pioneer_service_sessions').doc(a.session_id);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      // Tidy the orphan lock before bailing so the user can retry.
      try { await activeRef.delete(); } catch (_) {}
      throw new Error('Session not found — lock was cleared so you can clock back in.');
    }
    const data = sessionSnap.data() || {};
    const clockInMs = (data.clock_in_at && typeof data.clock_in_at.toMillis === 'function')
      ? data.clock_in_at.toMillis()
      : (data.clock_in_at && typeof data.clock_in_at.seconds === 'number')
        ? data.clock_in_at.seconds * 1000
        : Date.now();
    const elapsedMs = Date.now() - clockInMs;
    // Clamp at 0; flag for review if abnormally short/long. 840 min =
    // 14 hours, matching the cleaning clock's review threshold.
    const workMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
    const needsReview = workMinutes < 1 || workMinutes > 840;

    await sessionRef.update({
      status:                        'completed',
      clock_out_at:                  sts(),
      work_minutes:                  workMinutes,
      paid_minutes:                  workMinutes,
      sick_accrual_eligible_minutes: workMinutes,
      needs_review:                  needsReview,
      updated_at:                    sts()
    });
    await activeRef.delete();
    return { sessionId: sessionRef.id, workMinutes: workMinutes };
  }

  /**
   * Patch the running session with additional fields. Used by the
   * inspection page to attach customer_slug + customer_name when the
   * inspector picks a customer mid-shift, or to attach inspection_id
   * once an inspection submits. No-op if nothing is active.
   *
   * Only allows fields the rules permit techs to update on their own
   * sessions while status === active. Identity/timing fields are
   * filtered out as a defensive guard against caller mistakes.
   */
  const PATCH_ALLOWED = new Set([
    'customer_id', 'customer_name', 'inspection_id'
  ]);
  async function patchActiveSession(staff, fields) {
    if (!staff || !staff.uid) return;
    if (!fields) return;
    const active = await getActive(staff);
    if (!active || !active.session_id) return;
    const payload = {};
    Object.keys(fields).forEach(function (k) {
      if (PATCH_ALLOWED.has(k)) payload[k] = fields[k];
    });
    if (!Object.keys(payload).length) return;
    payload.updated_at = sts();
    await db().collection('pioneer_service_sessions').doc(active.session_id).update(payload);
  }

  window.NonServiceClock = Object.freeze({
    LABOR_TYPES:         LABOR_TYPES,
    LABOR_TYPE_LABEL:    LABOR_TYPE_LABEL,
    clockIn:             clockIn,
    clockOut:            clockOut,
    getActive:           getActive,
    patchActiveSession:  patchActiveSession
  });
})();
