# SessionV2 Phase 35b — Clock-Out Dual-Write + Status Transition

**Status (2026-06-26)**: design locked, implementation in progress.

**Guiding principle**: every Phase should reduce reconciliation. Every Phase should strengthen Session as the single source of truth. Every design decision asks: "Does this make the Session more complete, or are we adding another disconnected record?"

---

## Scope

1. **`updateSessionV2ClockOutV1` Cloud Function** — narrow, single-purpose admin/tech endpoint that advances a SessionV2 doc from `in_progress|paused → awaiting_completion`. Flag-gated. Idempotent on terminal states.
2. **`maybeDualWriteClockOut` client helper** — fire-and-forget after V1 clock-out transaction commits. Same shape as `maybeDualWriteClockIn`. Never blocks tech UX.
3. **`service-clock.js` splice** — try/catch after `clockOut()` V1 runTransaction. Never throws. V1 success path unchanged.
4. **`reconcileV1V2ParityV1` extension** — additive status_lag detection. Log-only. Does NOT count toward `skew_total` in 35b.
5. **Canary harness extensions** — 3 new buttons (advance, idempotent re-advance, terminal-state refusal).

## Explicitly NOT in 35b

| Out of scope | Why |
|---|---|
| Pause / resume dual-write | Reserved in state machine; not implemented. Will land in 35b-2 if needed. Cosmetic divergence only (V2 may show `in_progress` while V1 is in pause-equivalent state — harmless until Phase 37 reads V2). |
| Offline queue worker | Phase 35c. Failed retries currently enqueue but are not drained. |
| DCR / photo / customer email writes to V2 | Phase 36+. |
| Payroll read from V2 | Phase 37. |
| Mission Control read from V2 | Phase 38. |
| Force-close → V2 propagation | Deferred. Operational recovery is a separate concern (see `RECOVERY_TOOLBOX.md`). |
| Generic admin "force advance" endpoint | Rejected by design. Recovery is a toolbox of named operations, not arbitrary state mutation. |
| Auto-create V2 on update if missing | Rejected. Missing Sessions are valuable signals. CF returns 404; client enqueues retry; reconciliation surfaces. |

## Architectural refinements baked in (2026-06-26)

| Refinement | Implementation |
|---|---|
| Single-purpose endpoint (not a generic updater) | `updateSessionV2ClockOutV1` only does clock-out advancement. No other status transitions. |
| No auto-create on missing V2 | CF returns `404 V2_NOT_FOUND`; client enqueues retry; reconciliation flags. |
| Log status_lag only, no alerts | Reconciliation summary gains `status_lag_count` field (informational). No paging. No emails. |
| Force-close deferred | Not addressed in 35b. Operational recovery is a separate workstream (`RECOVERY_TOOLBOX.md`). |
| Reserve `paused` state | Tech-allowed-transitions rule and state machine doc include `paused` as a valid state. No product code writes it through Phase 35b. |
| Recovery Session direction (not "force advance") | Architectural direction recorded in `RECOVERY_TOOLBOX.md`. No implementation in 35b. |
| Timeline first-class | Every status transition (including the new `clock.out` event) appends a Timeline entry. Invariant: status changes always co-write Timeline. |
| Session Integrity Score (reserved) | Concept documented in SCHEMA.md. Not computed or surfaced in 35b. Reserved for Mission Control read path (Phase 38). |
| V1 stays authoritative | Fire-and-forget after V1 commits. Tech UX latency unchanged. V2 is observational until Phase 37 explicitly moves payroll ownership. |

---

## Detailed design

### `updateSessionV2ClockOutV1`

**Endpoint**: `POST https://us-central1-pioneer-dcr-hub.cloudfunctions.net/updateSessionV2ClockOutV1`

**Auth**: Firebase ID token. Admin OR own-session tech (verified by `v2.staff_uid == request.auth.uid`).

**Flag gate**: `SESSION_V2_ENABLED=true` required → `503 SESSION_V2_DISABLED` otherwise.

**Request payload**:
```
{
  session_id:     "<v2 deterministic id, sess_<asg>_<date>_a<n>>",
  v1_session_id:  "<v1 random doc id, for audit cross-ref>",
  clock_out_at:   "<ISO 8601 from V1 transaction>",
  clock_out_gps:  { lat, lng, accuracy_m, status } | null,
  environment:    "production" | "debug" | "emulator"   (defaults production)
}
```

**Response codes**:
| Code | Meaning |
|---|---|
| 200 | `{ ok:true, advanced:true \| idempotent:true, from_status, to_status }` |
| 400 | Invalid payload (with `field_errors`) |
| 401 | Not signed in |
| 403 | Not own session AND not admin |
| 404 | `{ ok:false, code:"V2_NOT_FOUND" }` — V2 doc missing; client enqueues retry |
| 409 | `{ ok:false, code:"INVALID_STATE", current_status }` — V2 archived, locked, or status not in `{in_progress, paused}` and not already past `awaiting_completion` |
| 503 | `{ ok:false, code:"SESSION_V2_DISABLED" }` |

**Idempotency**: If V2 status already in `{awaiting_completion, complete, pending_payroll_review, payroll_approved, exported, customer_notified, locked}` → 200 with `idempotent:true`. Never advances backward.

**Write contents** (single Firestore update):
- `status: "awaiting_completion"`
- `status_changed_at: serverTimestamp`
- `status_version: previous + 1`
- `clock_out_at: <from payload>`
- `clock_out_gps: <from payload, or null>`
- `components.clock.status: "complete"`
- `components.clock.last_event: "clock.out"`
- `components.clock.last_event_at: serverTimestamp`
- `components.clock.completed_at: serverTimestamp`
- `timeline: arrayUnion(entry)` where entry is:
    ```
    {
      ts: serverTimestamp, intent_ts: <clock_out_at>,
      actor: { type: caller_role, uid, email, name },
      event: "clock.out",
      title: "Tech finished cleaning",
      detail: "Clock-out at <time>; advancing to awaiting_completion",
      icon: "clock-out",
      field_path: "status",
      from: <previous_status>, to: "awaiting_completion",
      ref: <v1_session_id>
    }
    ```
- `updated_at: serverTimestamp`

### Client helper extension

`PIONEER_SESSIONS_V2.maybeDualWriteClockOut(opts)`:

```
opts = {
  v2_session_id:  string,        // computed by caller via deriveSessionV2Id
  v1_session_id:  string,        // V1 random doc id
  staff_uid:      string,
  staff_email:    string,
  clock_out_at:   ISO string,
  clock_out_gps:  { ... } | null,
  environment:    "production" | "debug" (default production),
  bypass_allowlist_check: boolean (default false; canary only)
}

returns: { ok, status?, body? } | { ok:false, skipped, reason } | { ok:false, enqueued }
```

Internals:
- Same allowlist + flag check as `maybeDualWriteClockIn`
- Same 5s timeout
- Same 503 soft-skip behavior
- Same 404 → enqueue retry path (event_type: "v2.clockout.retry")
- Same shared `_postWithAuth` and `_enqueueRetry`

### Splice in `service-clock.js:clockOut()`

After `await db.runTransaction(...)` succeeds:

```javascript
try {
  if (self.PIONEER_SESSIONS_V2 && self.PIONEER_SESSIONS_V2.maybeDualWriteClockOut) {
    self.PIONEER_SESSIONS_V2.maybeDualWriteClockOut({
      v2_session_id: self.PIONEER_SESSIONS_V2.deriveSessionV2Id(
        existingSession.assignment_id,
        existingSession.service_date,
        1
      ),
      v1_session_id: sessionId,
      staff_uid:     currentStaff.uid,
      staff_email:   staffEmail,
      clock_out_at:  new Date().toISOString(),
      clock_out_gps: geo
    }).catch(function (e) {
      logSC("sessionV2 clock-out dual-write failed (V1 already saved)", e && e.message);
    });
  }
} catch (_e) {
  logSC("sessionV2 clock-out dual-write skipped (helper unavailable)", _e && _e.message);
}
```

Skip the dual-write call entirely if `existingSession.assignment_id` is missing (admin-manual V1 sessions don't have matching V2 docs by design).

### Reconciliation extension

`reconcileV1V2ParityV1` (already exists, Phase 35a) gains additive status comparison:

- For each V2 doc checked, ALSO read V1 doc's `status` field
- Map V1 status to V2 status family:
    - `V1 active` → V2 should be `assigned|ready|in_progress|paused`
    - `V1 completed` → V2 should be `awaiting_completion|complete|pending_payroll_review|...|locked`
- If V2 is "behind" expected family → log `status_lag` (informational)
- If V2 is "ahead" of expected family → log `status_ahead` (unusual)

Summary response gains:
```
status_lag_count:   number,
status_ahead_count: number,
status_lag_details: Array<{v2_id, v1_status, v2_status}>  (cap 20)
```

These do **NOT** count toward `skew_total`. No alerting in Phase 35b.

### Canary harness extensions

Three new buttons appended to existing harness:

| Button | Behavior |
|---|---|
| **3a. Advance to awaiting_completion** | Calls helper → CF with canary V2 id + fake clock_out_at + environment=debug. Expect 200 advanced. |
| **3b. Try advance again (idempotency)** | Same payload → expect 200 idempotent:true. |
| **3c. Try advance from terminal state** | Calls CF on a canary doc already at `awaiting_completion`. Should NOT advance further — expects 200 idempotent (since it's already past clock-out). |

For step 3a to be meaningful, the canary doc must be at `in_progress` first. The existing "Create canary session" creates at `assigned`. The canary harness should expose an intermediate "Advance to in_progress" step OR `updateSessionV2ClockOutV1` accepts `assigned` as a starting state if `environment=debug` (admin-only path). For simplicity in 35b: the test path is **admin manually advances via direct Firestore write** (admin perms allow this on debug canary docs) OR the harness's "Create canary session" is extended to accept a starting-status param.

**Recommended**: extend `maybeDualWriteClockOut` to accept an `expected_from_status` param. For canary mode (bypass_allowlist_check=true), the CF accepts the doc at whatever status and just sets it to `awaiting_completion`. For production mode, the CF strictly requires `in_progress|paused`.

Actually cleaner: the canary harness does TWO writes per cycle:
1. Click "Create canary" → V2 at `assigned`
2. Click "Force advance to in_progress" — calls a tiny admin-write directly to Firestore (debug docs allow admin write per rules). Sets status=in_progress.
3. Click "3a. Advance to awaiting_completion" — calls the real CF endpoint.

This validates the real CF code path without complicating its production semantics.

---

## Files touched

| File | Change |
|---|---|
| `functions/index.js` | NEW `updateSessionV2ClockOutV1` (~200 LOC). Extend `reconcileV1V2ParityV1` for status_lag (~50 LOC). |
| `public/lib/sessionsV2-client.js` | NEW `maybeDualWriteClockOut` entry point + shared `_postWithAuth` extraction (~120 LOC). |
| `public/service-clock.js` | Splice after `clockOut()` V1 transaction (~25 LOC). |
| `public/firebase-config.js` | NEW `window.UPDATE_SESSION_V2_CLOCK_OUT_URL` constant. |
| `public/admin.html` | 3 new harness buttons + cache-bust bump. |
| `public/admin/tab-sessionsv2-canary.js` | 3 new button handlers (~100 LOC) + intermediate "advance to in_progress" admin-write helper. |
| `test/sessionsV2.clockout.test.mjs` | NEW ~300 LOC functional tests. |
| `package.json` | New test script `test:clockout:sessionsV2`. |
| `docs/sessionsV2/PHASE35B_PLAN.md` | THIS doc. |
| `docs/sessionsV2/RECOVERY_TOOLBOX.md` | NEW architectural direction (Recover Session toolbox). |
| `docs/sessionsV2/CANARY_HARNESS.md` | Runbook extended for 3 new buttons. |
| `docs/sessionsV2/SCHEMA.md` | Reserved `paused` clarification + Session Integrity Score reservation + Timeline first-class reinforcement (already landed). |
| `firestore.rules` | NO CHANGE. Existing tech-allowed transitions already include the required arrows. |
| `firestore.indexes.json` | NO CHANGE. |

NOT touched: `submitDcrV1`, photo upload, payroll export, Mission Control, customer email, Add Shift, Phase 31/32B queues, V1 schema.

---

## Tests

### Functional (`test/sessionsV2.clockout.test.mjs`) — ~10 tests
- 503 when SESSION_V2_ENABLED off
- 401 unauth
- 403 non-admin trying to update another tech's session
- 200 advanced (own session)
- 200 advanced (admin token, any session)
- 404 V2_NOT_FOUND
- 409 INVALID_STATE (status=archived)
- 409 INVALID_STATE (status=locked)
- 200 idempotent (status already=awaiting_completion)
- Doc shape after advance: status, components.clock, timeline entry, updated_at

### Rule regression
All 103 existing tests pass.

### Harness validation (manual)
Run buttons 1→2→3→4→5→3a→3b→5→3c→7→8 on preview channel. Result pane shows expected output at each step.

---

## Deploy plan

1. Land Phase 35b code with `SESSION_V2_ENABLED=false` (no behavior change)
2. Deploy: `firebase deploy --only functions:updateSessionV2ClockOutV1,functions:reconcileV1V2ParityV1` (extended) + hosting preview channel
3. Smoke: `updateSessionV2ClockOutV1` POST unauth → 503 (with flag off)
4. Flip `SESSION_V2_ENABLED=true` temporarily for harness validation
5. Run canary harness sequence on preview channel
6. Verify reconciliation summary shows status_lag fields populated correctly
7. Flip `SESSION_V2_ENABLED=false` back
8. Mark Phase 35b complete; proceed to 35c (offline queue worker) when ready

## Rollback plan

- Flag off → all V2 update calls 503 → tech clock-out flow unaffected (V1 was always authoritative)
- Existing V2 docs at `awaiting_completion` from prior dual-writes remain (harmless)
- Code revert: `git revert <35b SHA>`
- Reconciliation extension is additive; reverting drops the status_lag fields but doesn't break anything

## Estimated effort

| Component | Hours |
|---|---|
| Cloud Function `updateSessionV2ClockOutV1` | 3.5 |
| Reconcile extension | 1.0 |
| Helper extension | 1.5 |
| service-clock splice | 0.5 |
| Harness extensions | 1.5 |
| Functional tests | 2.5 |
| Deploy + harness validation | 1.0 |
| Docs | 1.0 |
| **Total** | **~12.5 hours** |
