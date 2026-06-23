# Phase 31 — QA Harness + Test Plan

**Harness URL (prototype, served locally via `firebase serve` or any static server):**
`/queue/queue-test.html`

The harness drives `queue-db.js`, `queue-worker.js`, and `draft-migration.js` against an in-memory mock storage + mock submitDcrV1. No real network calls. Real-network behavior (DevTools throttling, real `submitDcrV1`) is exercised separately on a preview channel deploy when Phase 31 wires into `app.js`.

## Harness sections (mapped to test cases)

| Harness section | What it exercises | Pass criteria |
|---|---|---|
| 1 — DB lifecycle | open / stats / clearAll | Open returns; stats counts agree with prior writes; clearAll zeroes everything |
| 2 — Draft store | saveDraft / loadAllDrafts | Drafts persist across button clicks; submission_id is the key |
| 3 — Legacy migration | seed → run → run again | First run returns `{migrated: true, submission_id, draft}`; second run returns `{migrated: false, reason: "no legacy draft present"}` |
| 4 — Pending queue + drain | enqueue / processQueue / list pending / stress | Enqueued rows appear in pending; drain removes them on success; stress with 5 rows drains all |
| 5 — Idempotency probe | enqueue twice with same submission_id | `IDEMPOTENCY_PASS === true`. Email counter and Zapier counter equal between first and second drain |
| 6 — Diagnostics | env probe | All three modules loaded; `idb_available` true |

## Test cases — Unit (run in harness, all in-memory)

| # | Case | Steps | Expected |
|---|---|---|---|
| U1 | Empty DB stats | Clear → Stats | `{drafts:0, pending:0, assignments:0, customers:0, techs:0}` |
| U2 | Draft round-trip | Save sample → Load all | One row with the saved submission_id |
| U3 | Migration first run | Seed legacy → Run migration | `{migrated: true, ...}`; legacy localStorage cleared |
| U4 | Migration idempotency | Seed → Run → Run again | Second run: `{migrated: false, reason: "no legacy draft present"}` |
| U5 | Migration unparseable | Set legacy to garbage → Run | `{migrated: false, reason: "legacy draft unparseable; removed"}`; legacy key removed |
| U6 | Enqueue with 0 photos | photo count 0 → Enqueue → Drain | Drains with signature only; FAKE_SUBMIT called once |
| U7 | Enqueue with 2 photos | photo count 2 → Enqueue → Drain | Two photo uploads + signature + FAKE_SUBMIT; row deleted on success |
| U8 | Network failure → retry | Check "Force network failure" → Enqueue → Drain | Row stays in pending with `failed_will_retry`, `next_attempt_at` ~30s ahead, `attempts_count: 1` |
| U9 | Network failure → permanent | Drain 3 times with network failure on | Row reaches `failed_permanent` after 3 attempts |
| U10 | Stall watchdog | Check "Stall every upload" → Enqueue → Drain | Row fails with `pioneer/upload-stalled` after ~20s |
| U11 | Cancel mid-drain | Drain, immediately call task.cancel() (manual via DevTools) | `storage/canceled` propagates; row goes to `failed_will_retry` |
| U12 | Stress 5 enqueue | Stress button → Drain | All 5 rows drain to success; FAKE_SUBMIT call count == 5; email count == 5 |
| U13 | Idempotency probe | Click "Run idempotency probe" | `IDEMPOTENCY_PASS: true`; email count steady at 1 across both drains |
| U14 | DB upgrade survives reload | Reload page → Stats | Pre-reload data still present |
| U15 | clearAll wipes everything | Save + enqueue + migrate → clearAll → Stats | All counters at 0; legacy localStorage absent |

## Test cases — Integration (run on preview channel, real network)

Requires Phase 31 wired into `app.js` behind `OFFLINE_QUEUE_ENABLED` flag and deployed to a `phase31-prototype` preview channel.

| # | Case | Steps | Expected |
|---|---|---|---|
| I1 | Happy path with queue on | Online tech, normal DCR submit | Submits within 5s; `dcr_submissions` doc has `already_submitted` absent or false |
| I2 | Submit offline | DevTools Offline → fill DCR → Submit | Instant local success: "Saved — Pioneer will send when reconnected." Pending row created |
| I3 | Drain on reconnect | After I2, toggle DevTools Online | Within 30s, queue chip clears, `dcr_submissions` lands, email arrives |
| I4 | Stall watchdog (real network) | Slow 3G throttle → Submit | Stall watchdog fires within ~25s; row marked `failed_will_retry` |
| I5 | Hard cap (real network) | Custom throttle 1kb/s → Submit | Hard cap fires at ~95s; row marked `failed_will_retry` |
| I6 | Idempotent replay | Manually call `processQueue` twice for the same row | Exactly ONE `dcr_submissions` doc, ONE customer email. Second response includes `already_submitted: true` |
| I7 | Multi-DCR queue | Offline → submit 2 different stops | Both queue separately; both drain on reconnect; both `dcr_submissions` docs land |
| I8 | App update mid-queue | Pending row, deploy new SW | Refresh banner shown; after refresh, queue still drains |
| I9 | Migration on real device | Tech with existing legacy draft → first Phase 31 boot | Draft restores intact; legacy localStorage key gone |
| I10 | iOS Safari fallback | Disable Background Sync in DevTools → online toggle | Page-side `online` listener drains queue without SW sync |
| I11 | Service worker rollback | Re-deploy V1 sw.js | V2 shell cache reaped on V1 activate; no stale assets served |
| I12 | Bonnie's exact scenario | 50 kbps + 2000ms latency → submit at Baker Construction | Form remains submittable; queues and drains automatically when signal returns |

## Test cases — Server-side (run against preview backend with idempotency patch wired)

Requires `functions/_drafts/submitDcrV1-idempotency.js` integrated and deployed to a backend preview.

| # | Case | Steps | Expected |
|---|---|---|---|
| S1 | First call writes doc + sends email | `curl -X POST submitDcrV1` with fresh submission_id | 200 OK; new `dcr_submissions` doc; one customer email in Gmail Sent |
| S2 | Replay returns cached receipt | Repeat S1 with same submission_id | 200 OK; response body includes `already_submitted: true`; NO new email; NO new Zapier ping; doc unchanged |
| S3 | Cross-staff replay refuses cache | Different ID token, same submission_id | Idempotency declined (different submitted_by_uid); proceeds with write path; logs warning |
| S4 | Firestore read failure → falls through | Inject error on first .get() | Logs warning; proceeds with normal write; first-submission behavior preserved |

## Acceptance criteria

Phase 31 ships when:
- All U-series cases pass on harness (deterministic, in-memory).
- All I-series cases pass on preview channel with real Firebase Storage.
- All S-series cases pass on backend preview with idempotency patch live.
- No regression on the production hotfix QA (the 7 items from 2026-06-18).
- One named tech (Bonnie) completes one real-world cycle at Baker Construction.

## Harness operating notes

- Open in any modern browser. Chrome DevTools → Application → IndexedDB → "pioneer-queue" to inspect the live state.
- "Force network failure" checkbox makes FAKE_STORAGE reject with `storage/retry-limit-exceeded` and FAKE_SUBMIT return `{ok: false, status: 0}`.
- "Stall every upload" checkbox makes FAKE_STORAGE never emit progress, so the worker's watchdog fires (~20s).
- The harness uses `crypto.randomUUID()` when available; falls back to `Date.now() + Math.random()` otherwise.
- Counters (`callCount`, `emailCount`, `zapierCount`) reset on `clearAll`.
