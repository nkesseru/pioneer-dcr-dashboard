# Phase 31 — Risk Report

Authored 2026-06-18 alongside the prototype. Covers everything that could go wrong on the path from "prototype on disk" to "globally enabled in production." Each risk has a likelihood / impact assessment and a mitigation actually present in the prototype (or a clear plan to add it before ship).

## Top 6 risks

### R1 — Duplicate customer emails on idempotency-patch miss
**Likelihood:** Medium. **Impact:** High. **Status:** Mitigated in prototype.

If the Phase 31 queue worker retries a submission whose first-attempt `submitDcrV1` POST landed but whose 200 response was lost, today's backend would re-fire the customer email. The prototype addresses this with `functions/_drafts/submitDcrV1-idempotency.js`, a single Firestore read added before any side-effecting writes. Covered by harness section 5 (IDEMPOTENCY_PASS) and integration test S2 (`already_submitted: true` returned, zero new emails).

**Residual:** If the idempotency patch ships behind the queue (queue enabled before backend patch live), the window between deploys could leak duplicates. **Mitigation:** Backend patch must merge and deploy BEFORE the `OFFLINE_QUEUE_ENABLED` flag flips, and CI should fail if a release tag carries the flag without the patch.

### R2 — Service worker upgrade strands a tech mid-DCR
**Likelihood:** Medium. **Impact:** Medium. **Status:** Mitigated by SW-V2 design.

SW-V2 ships with `skipWaiting()` + `clients.claim()` so old SWs are replaced on next nav. But if a tech is mid-DCR when an update lands, claiming a new SW could swap their JS bundle out from under them. The V2 draft installs the new SW silently but only takes control on next nav. The page should listen for `controllerchange` and show a "Update available — finish this DCR first" banner instead of forcing a reload.

**Residual:** First-deploy of V2 forces a one-time fetch of the new shell. Mitigation: deploy V2 outside of business hours (overnight 2-5am PT) when no field DCRs are in flight.

### R3 — IndexedDB quota exhaustion on devices with many queued photos
**Likelihood:** Low. **Impact:** Medium-high. **Status:** Watched, not blocked.

A tech who works 5 hours offline with 6 photos × 2MB per stop × 4 stops could queue ~50MB. IDB quotas are large on most platforms (>100MB allowed without prompt on Chrome Android; iOS Safari is stricter at ~50MB before evict). If quota hits during a queued write, the `IDBRequest.error` will be `QuotaExceededError`.

**Mitigation:** Quota probe at boot (`navigator.storage.estimate()`). When usage > 80% of quota, surface a banner: "Local storage almost full — finish queued DCRs before adding more." Not in v1 — add when first reported.

**Residual:** Worst case under quota stress is failed enqueue, which surfaces a clear error and falls back to keeping the form open (same as today's stall behavior). No silent data loss.

### R4 — Photo blob persistence across browser cache eviction
**Likelihood:** Low. **Impact:** Medium. **Status:** Acceptable.

iOS Safari may evict IDB if the site goes 7+ days unused. A tech with a queued DCR who doesn't open the app for a week could lose the queued blobs. Field reality: techs use the app daily, so 7-day evictions are unlikely.

**Mitigation:** Request `navigator.storage.persist()` at first Phase 31 boot. Chrome grants it readily; Safari requires user gesture + bookmark/install. Surface a "Add to Home Screen" prompt to upgrade to a persisted PWA install (eligibility-gated by SW + manifest, which the codebase already has).

**Residual:** Pre-PWA-install Safari devices remain vulnerable. Document; do not block.

### R5 — Background Sync API unavailable on iOS Safari < 16.4
**Likelihood:** High. **Impact:** Low. **Status:** Mitigated by fallback.

SW-V2's `sync` event handler doesn't fire on Safari < 16.4. Without a fallback, queued DCRs would only drain when the user manually opens the app.

**Mitigation:** Page-side `window.addEventListener("online", processQueue)` runs alongside the SW sync registration. Both paths drain the same IDB rows; whichever fires first wins (the worker is idempotent against double-invocation since `getNextDrainable` skips rows already in `posting_payload`/`submitted`).

**Residual:** A backgrounded Safari tab won't drain. User must foreground the app at least once after reconnection. Acceptable for v1; documented in QA case I10.

### R6 — Idempotency patch can't help if submission_id changes between retries
**Likelihood:** Low (in the queue path). **Impact:** Critical (would cause double-email). **Status:** Locked in by client invariant.

The patch's key invariant: the queue worker uses the same `submission_id` across all retries of one logical submission. If a future change accidentally regenerates `submission_id` on retry (e.g., a refactor that pulls `newSubmissionId()` into the wrong place), the patch becomes useless. Coverage:

- Harness section 5 includes the probe.
- The worker stores `submission_id` as the IDB row's primary key — there is no path to mutate it.
- Add a unit test: enqueue + drain + assert the FAKE_SUBMIT call's payload `submission_id` matches the row's primary key.

**Residual:** A reviewer needs to catch any future PR that touches `newSubmissionId()` placement. Mitigation: comment in app.js: `// DO NOT call newSubmissionId() on retry — see Phase 31 idempotency contract.`

## Lower-tier risks (track, don't block)

| # | Risk | Mitigation |
|---|---|---|
| L1 | Storage SDK retry-budget interaction with the worker's stall watchdog | Worker explicitly calls `task.cancel()` on stall; SDK retries inside cancel are bounded by the same 60s `maxUploadRetryTime` set in the hotfix |
| L2 | Multiple tabs open with queued DCRs racing | `getNextDrainable` reads rows by status; status transitions are atomic per transaction. Worst case: both tabs see a `queued` row and both try to drain. The second hit will see `submitted` from the first and exit cleanly with `already_submitted: true`. Could be tightened with a `claimed_by_tab_id` field; not in v1. |
| L3 | DST / clock drift on the device affecting `next_attempt_at` | All times are epoch ms. Drift of a few minutes is invisible to retry scheduling. |
| L4 | A tech logging out with queued DCRs | The queue rows persist in IDB even after sign-out. On next sign-in, queued DCRs drain under the new ID token. If a DIFFERENT tech signs in, the server-side `submitted_by_uid` check in the idempotency patch declines the cache hit and proceeds with the write path — the new tech's UID is recorded as the submitter. Edge case; document for ops. |
| L5 | Encrypted form data at rest on shared devices | IDB is per-origin and not encrypted at rest. The DCR doesn't contain PII beyond customer name + tech name. No PCI / no PII regulated under HIPAA. Acceptable. |
| L6 | Telemetry blind spot — we can't see how many submissions drained from queue vs landed on first try | Add a `submission_meta.queue_attempts_count` field on the final payload (set by the worker from `attempts_count`). Server stores it; analytics can read it. Not in v1. |

## Roll-back plan

| Failure mode | Roll-back |
|---|---|
| Backend idempotency patch causes incorrect cache hit | Revert single insert in `functions/index.js`; redeploy. Falls back to today's behavior (write-always). |
| SW V2 breaks shell loads | `firebase deploy --only hosting` with old `sw.js`. V2 cache reaps itself on next activate. |
| Queue worker double-drains | Disable `OFFLINE_QUEUE_ENABLED` flag in `firebase-config.js` (no deploy needed if the flag is read at boot — it is). Falls back to today's submit-direct path. |
| IDB schema upgrade fails | Bump `DB_VERSION`; add an upgrade handler that wipes (not migrates) on next open. Acceptable for v1 since drafts are non-critical. |

## What this report does NOT cover

- Offline punch in/out: separate write surface, separate phase.
- Offline waiver: separate write surface, separate phase.
- Multi-device sync: techs share devices? Out of scope; one device per tech is the operating assumption.
- Photo compression: client-side resize before queue would help R3 + R4. Phase 32 candidate.

## Bottom-line risk assessment

**Overall:** Medium risk, high reward. R1 (duplicate email) is the only must-fix-before-ship risk and the prototype addresses it explicitly. R2 (SW upgrade) is well-trodden ground in the PWA world and the V2 draft follows the safe pattern. Everything else is monitoring + iterating.

**Recommended go/no-go gate:** approve Phase 31 to start coding for real after the prototype harness's U-series tests all pass green AND the idempotency patch S-series tests pass on a backend preview. Both are accomplishable in 1-2 days of code review + harness exercising.
