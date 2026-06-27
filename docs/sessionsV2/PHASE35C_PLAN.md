# SessionV2 Phase 35c — Queue Processor

**Status (2026-06-26)**: design locked, implementation in progress.

## Goal

Drain the `pending_session_writes` queue that Phase 35a + 35b populate when V2 writes fail. Without a processor the queue grows unbounded and the "best-effort with retry" promise is broken. Phase 35c closes that loop.

## Architectural decisions (locked with Nick 2026-06-26)

| Decision | Implementation |
|---|---|
| **Naming** | `processSessionV2QueueV1` (HTTP, admin/canary) + `scheduledSessionV2QueueDrainV1` (cron). Follows project's verb + scope + V1 convention. "Process" is generic enough to absorb future event types. |
| **`origin_operation` field** | Stamped on every queue insert. Closed enum: `clockin.dual_write`, `clockout.dual_write`, `canary.harness`. Diagnostic-only; processor does not branch on it. |
| Single shared internal helper | `_processQueueBatch()` is the actual worker; both HTTP and scheduled triggers call it. |
| Event-type dispatcher | Map: `v2.create.retry → createSessionV2`, `v2.clockout.retry → updateSessionV2ClockOutV1`. Unknown event_type → mark `failed_permanent` immediately. |
| Backoff schedule | 1m, 5m, 15m, 30m, 60m. After 5 attempts → `failed_permanent`. |
| Dead-letter behavior | `status: "failed_permanent"` + `failed_at: serverTimestamp` + permanent reason. No separate dead-letter collection in 35c (Phase 38+ Mission Control will surface). |
| Idempotency | Downstream CFs (`createSessionV2` + `updateSessionV2ClockOutV1`) already idempotent. Processor doesn't need its own claim-lock. |
| Flag gate | `SESSION_V2_ENABLED=false` → processor returns early (logs + 200 `{ok:true, skipped:true, reason:"flag_off"}`). |
| Hard cap per invocation | 25 entries max per call. Prevents runaway. Scheduled trigger picks up overflow next cycle. |

## Scope

### What ships in 35c

1. **`processSessionV2QueueV1`** — HTTP Cloud Function. Admin-callable. Returns summary `{ok, processed, succeeded, failed, dead_lettered, scanned, ids[]}`.
2. **`scheduledSessionV2QueueDrainV1`** — `onSchedule("every 5 minutes")`. Internally calls `_processQueueBatch()`. Logs summary.
3. **Helper module update** — `sessionsV2-client.js` stamps `origin_operation` on enqueue:
   - `maybeDualWriteClockIn` → `clockin.dual_write`
   - `maybeDualWriteClockOut` → `clockout.dual_write`
4. **Canary harness extensions** — 3 new buttons:
   - **4a. List queue entries** — admin Firestore read, prints last 20 queue entries with status + origin + last_error
   - **4b. Enqueue manual retry** — admin direct-write a synthetic `v2.clockout.retry` entry with `origin_operation: "canary.harness"`
   - **4c. Run processor now** — POST to `processSessionV2QueueV1`
5. **Tests** — `test/sessionsV2.queue.test.mjs` covering routing, backoff, dead-letter, idempotency, flag-off, origin_operation preservation.

### Explicitly NOT in 35c

| Out of scope | Why |
|---|---|
| Service Worker browser-side queue | Browser failure modes differ; Phase 35d if needed |
| Per-tech queue throttling | Existing 200-event cap is informational; add when we have load data |
| Status_lag auto-repair queue | No evidence yet; Phase 37+ |
| Dead-letter admin alerting UI | Phase 38 Mission Control |
| Force-close → V2 propagation | Recovery Toolbox, Phase 38+ |
| DCR / payroll / Mission Control / customer email | Phase 36+ |
| New event types beyond v2.create.retry + v2.clockout.retry | Add as needed in their owning phase |
| Add Shift / Supersede / Payroll Review files | Separate uncommitted slice |

## Files touched

| File | Change |
|---|---|
| `functions/index.js` | NEW `processSessionV2QueueV1` (HTTP, ~250 LOC) + `scheduledSessionV2QueueDrainV1` (scheduled, ~40 LOC) + shared `_processQueueBatch()` internal |
| `public/lib/sessionsV2-client.js` | Stamp `origin_operation` on enqueue calls (~10 LOC delta) |
| `public/admin.html` | 3 new harness buttons + cache-bust bump |
| `public/admin/tab-sessionsv2-canary.js` | 3 new button handlers (~120 LOC) |
| `public/firebase-config.js` (gitignored) | NEW `window.PROCESS_SESSION_V2_QUEUE_URL` |
| `test/sessionsV2.queue.test.mjs` | NEW ~300 LOC functional tests |
| `package.json` | New `test:queue:sessionsV2` + include in `test:all:sessionsV2` |
| `docs/sessionsV2/PHASE35C_PLAN.md` | THIS doc |
| `docs/sessionsV2/SCHEMA.md` | Document `origin_operation` field in pending_session_writes section |
| `docs/sessionsV2/CANARY_HARNESS.md` | Runbook extended for queue buttons |
| `firestore.rules` | NO CHANGE — existing rules cover pending_session_writes (tech-create / admin-write / admin-read) |
| `firestore.indexes.json` | NO CHANGE — `(status, next_attempt_at)` composite already deployed in Phase 33 |

NOT touched: `service-clock.js`, `submitDcrV1`, payroll export, Mission Control, customer email, Add Shift surfaces.

## Canary plan

1. **Create canary session** (existing button) — V2 doc at `assigned`
2. **4a. List queue entries** → 0 entries
3. **4b. Enqueue manual retry** — synthetic `v2.clockout.retry` pointing at canary V2 id (which is at `assigned`, not `in_progress|paused`)
4. **4c. Run processor now** → processor calls `updateSessionV2ClockOutV1`, gets 409 `INVALID_STATE`, marks queue entry `failed_will_retry`, schedules retry +1m
5. **4a. List again** → entry visible with `attempt_count: 1`, `next_attempt_at: +1m`, `last_error: INVALID_STATE`, `origin_operation: canary.harness`
6. **Admin-advance canary to `in_progress`** (existing button 3p)
7. **4c. Run processor now** again → retry succeeds, canary advances to `awaiting_completion`, queue entry marked `applied`
8. **5. Read back** → V2 doc shows status `awaiting_completion`, timeline contains the clock.out entry
9. **4a. List again** → entry shows `status: applied`
10. **Cleanup** (existing buttons 7/8)

Bonus: deliberately enqueue 6+ retries pointing at a deleted session (404 path) to exercise the dead-letter path — verify after 5 attempts entry flips to `failed_permanent`.

## Tests (`test/sessionsV2.queue.test.mjs`)

- 503 when SESSION_V2_ENABLED off
- 401 unauth
- 403 non-admin
- Processor drains queued entries (oldest next_attempt_at first)
- Processor skips entries with future next_attempt_at
- Backoff schedule advances correctly (1m → 5m → 15m → 30m → 60m)
- After 5 failed attempts → status `failed_permanent`
- Idempotent re-run on same applied entry → no-op
- v2.create.retry routes to createSessionV2 (verified via dispatcher map)
- v2.clockout.retry routes to updateSessionV2ClockOutV1
- Unknown event_type → failed_permanent immediately
- Hard cap: scans max 25 per invocation
- origin_operation field preserved through retries

## Deploy plan

1. Land Phase 35c with `SESSION_V2_ENABLED=false` (no behavior change)
2. Deploy: `firebase deploy --only functions:processSessionV2QueueV1,functions:scheduledSessionV2QueueDrainV1` + hosting preview channel
3. Smoke: HTTP endpoint returns 503 unauth (flag off)
4. Verify scheduled trigger registered via `firebase functions:list`
5. Canary harness validates end-to-end with flag temporarily on
6. Flip flag back off
7. Stop before prod hosting promote

## Rollback plan

- Flag off → both HTTP and scheduled return 503 / no-op
- Scheduled trigger can be paused via Cloud Scheduler console if needed
- Code revert: `git revert <35c SHA>`; existing queue entries remain (no schema change beyond `origin_operation` addition which is null-safe for old entries)

## Risk

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Processor double-processes entry (race) | Low | Downstream CFs idempotent; if same entry processed twice, status update fails-safely |
| 2 | Bug marks valid entries `failed_permanent` | Medium | Per-event 5-attempt threshold + manual reset via Firestore Console + canary harness validates each event type |
| 3 | Scheduled cron cost spike | Low | Every 5 min × 24h = 288 invocations/day; each <1s. Negligible. |
| 4 | Queue grows beyond hard cap | Low | Hard cap = 25/invocation; scheduled trigger picks up overflow; if persistent, admin investigates |
| 5 | Unknown event_type processed | Low | Dispatcher map fails closed (mark failed_permanent + log) |

Overall risk: **Low.** Additive Cloud Function. Flag-gated. Validated via canary harness. No production behavior change.

## Estimated effort: ~13 hours / ~1.5 dev days
