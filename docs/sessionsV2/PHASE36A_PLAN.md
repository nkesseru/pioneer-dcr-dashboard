# Phase 36a Plan — DCR Becomes a Session Projection

**Status (2026-06-27)**: 36a.1 shipped to preview; 36a.2 in progress.

**North Star (re-affirmed)**:

> The Session is the truth. The DCR is a projection of completed work, not a competing source of truth.

---

## Object-reduction principle (locked 2026-06-27)

Earlier drafts proposed adding `sessionsV2_parity_log` and `dcr_snapshots/{id}` subcollections. Both were rejected — see `SNAPSHOT_SCHEMA.md` anti-patterns. **Phase 36 adds ZERO new Firestore collections.**

Net-new artifacts in Phase 36a:
- `public/lib/sessionsV2-snapshot.js` — pure-function renderer (1 module)
- Server-side helper inside `functions/index.js` — splice glue
- Documentation (this plan + `SNAPSHOT_SCHEMA.md`)
- Tests

---

## Slices

| Slice | Goal | Status |
|---|---|---|
| **36a.1** | Pure renderer + canary buttons + tests + schema doc | **Done — preview** |
| **36a.2** | Splice into `submitDcrV1` post-commit: update V2 components + append Timeline events for `dcr.submitted` and (if divergent) `parity.diverged` | **In progress** |
| ~~36a.3~~ | ~~Reserve dcr_snapshots subcollection + snapshot_version registry~~ | **Deleted** per object-reduction collapse |

---

## 36a.1 — Renderer

Files:
- `public/lib/sessionsV2-snapshot.js` (UMD: browser + node)
- `test/sessionsV2.snapshot.test.mjs` (34 tests, pure-JS, no emulator)
- `docs/sessionsV2/SNAPSHOT_SCHEMA.md` (v1.0.0 reference)
- `public/admin.html` (3 canary buttons + cache-bust)
- `public/admin/tab-sessionsv2-canary.js` (3 button handlers, read-only)
- `package.json` (`test:snapshot:sessionsV2` script)

Surface:
- `SNAPSHOT_VERSION` — `"v1.0.0"`
- `renderSessionSnapshot(session, options?)` — pure function
- `deriveCompletion(session)` — also pure

Canary buttons (admin-only, gated by `SESSION_V2_DEBUG_UI_ENABLED`):
- **5a** Render snapshot from canary V2 session
- **5b** Render snapshot from arbitrary V2 session id (prompt-driven)
- **5c** Reproducibility check (render twice, expect byte-identical)

All three are READ-ONLY. No Firestore writes from 36a.1.

---

## 36a.2 — Splice + parity Timeline

Splice location: `functions/index.js` `submitDcrV1`, immediately after `service_assignments` denormalized writeback and before native email send (line ~3290 area).

Helper signature (server-side):
```
async function _submitDcrV1_dualWriteToSessionV2(args)
  args: { db, admin, logger, submissionId, dcrDoc, staff }
  returns: { status, v2_session_id, divergent_fields, error }
  side effects: updates sessionsV2/{v2_id}.components.* + timeline
  guarantees: never throws; logs on failure; respects SESSION_V2_ENABLED
```

Behavior:
1. **Gate check**: `process.env.SESSION_V2_ENABLED === "true"` AND `dcrDoc.pioneer_assignment_id` non-empty. Otherwise return `{ status: "skipped", reason: "..." }`.
2. **Compute V2 id**: same deterministic algorithm — `sess_<assignment_id>_<service_date>_a1`. (Higher attempt numbers not supported in 36a.2; flag if V2 doc not found at `_a1`.)
3. **Read V2 session**: `sessionsV2/{v2_id}`.
   - If missing: log `v2_session_not_present`, return `{ status: "skipped", reason: "v2_missing" }`. No retry queue write (intentional — see Risks #1).
   - If present: continue.
4. **Update V2 components** in one transaction:
   - `components.dcr` → `{ status: "complete", last_event: "dcr.submitted", ref: submissionId, completed_at: serverTimestamp, last_event_at: serverTimestamp }`
   - `components.photos.count` → photos array length (only if photos present)
   - `components.photos.status` → `"complete"` (if photos present, else leave)
   - `components.checklist.pct` → 100 (if checklist present) — caveat below
   - `components.issues.count` → number of issues (if dcrDoc has issues array)
   - Append timeline entry: `{ event: "dcr.submitted", title: "DCR submitted to customer", actor: { type: "system", uid: staff.uid, email: staff.email }, ref: submissionId }`
5. **Render snapshot** from updated V2 doc + compare against V1 dcrDoc.
6. **Parity diff** (small, well-scoped — see "Parity fields" below):
   - If `divergent_fields.length > 0`: append second timeline entry `{ event: "parity.diverged", title: "V1 and V2 snapshot disagreed on N fields", detail: "fields: ...", field_path: "parity", ref: submissionId }`
7. **Return** `{ status: "ok", v2_session_id, divergent_fields }`.

All wrapped in try/catch. Failure logs warning; never blocks V1 success response. Native email send continues regardless of V2 outcome.

### Parity fields (small, deterministic set in v1.0.0)

These are the fields where V1 dcr_submissions and V2 snapshot are EXPECTED to match. Drift signals a bug.

| V1 path | V2 snapshot path | Comparison |
|---|---|---|
| `dcr.customer_slug` | `work.customer.slug` | exact lower-case string |
| `dcr.tech_slug` | (lookup) | skipped in v1 — tech identity comes from auth, not payload |
| `dcr.photos.length` | `components.photos.count` | exact int |
| `dcr.submitted_by_email` | `work.staff.email` | exact lower-case string |
| `dcr.pioneer_assignment_id` | (derived from V2 session_id) | session_id contains assignment_id |

Ignored on purpose: timestamps (precision drift), free-form text (notes/observations), tech-side device metadata, server-stamped fields with no V2 counterpart.

If any of the compared fields disagree, the diff list is JSON-stringified (max 500 chars) into `timeline.parity.diverged.detail`.

### What 36a.2 does NOT do

- Does NOT change `submitDcrV1` response shape
- Does NOT change customer email path
- Does NOT change V1 dcr_submissions document
- Does NOT touch payroll fields on V2
- Does NOT advance V2 status (Phase 36b territory)
- Does NOT write photo bytes to a new GCS path (Phase 36c)
- Does NOT enqueue retries on V2 failure (the V2 doc may not even exist yet — see Risks)

---

## Canary plan

### 36a.1 (already deployable to preview)
1. Run **3. Create canary session** to produce a V2 doc.
2. Run **5a. Render snapshot** — confirm JSON shape matches `SNAPSHOT_SCHEMA.md`.
3. Run **5c. Reproducibility check** — confirm `result: "PASS"`.
4. Run **5b. Render snapshot (real)** with an arbitrary real V2 session id from earlier canary runs — confirm sensible output.
5. Clean up canary docs (button **8**, after confirming **7** dry-run output).

### 36a.2 (after splice + helper land)
1. Use an admin-write canary button to set the canary V2 session into a state that mimics "tech submitted a DCR" (status=in_progress with components.photos count > 0).
2. POST a synthetic DCR to `submitDcrV1` with the canary `pioneer_assignment_id`. (Better: a dedicated `simulate_dcr_dual_write` admin button that calls the helper directly against a known canary doc with synthesized V1 payload, no V1 doc actually written.)
3. Read V2 doc + Timeline — expect `dcr.submitted` Timeline entry, `components.dcr.status === "complete"`.
4. Submit again with a tweaked photo count — expect `parity.diverged` Timeline entry.

Live-user canary is **off-limits** through Phase 37 per [[canary-harness-first-policy]].

---

## Rollback

### 36a.1
Zero risk to V1. Renderer is read-only. Rollback: revert hosting deploy.

### 36a.2
Flag rollback: set `SESSION_V2_ENABLED=false` in `functions/.env`; redeploy `submitDcrV1`. Splice short-circuits at step 1. V2 docs that were partially updated remain (no readers; harmless).

Catastrophic rollback: revert the `submitDcrV1` deploy. V2 sessions stop receiving updates; V1 keeps working as it did before Phase 36.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | V2 session not yet dual-written when DCR submits (rare during Phase 35 ramp) | Skip with `v2_missing` reason; log. No retry queue write — V2 will catch up next clock-in/out cycle. Bigger fix is Phase 36b auto-create. |
| 2 | Helper adds latency to `submitDcrV1` | Helper runs single read + single update + (optional) second update. Sub-200ms in steady state. Existing native email leg is much heavier (OpenAI + Gmail). |
| 3 | Splice throws and is caught by outer try, but masks a real bug | Helper logs at `warn` level with full error.stack; reconciliation function (Phase 35a) surfaces V1/V2 lag at the document level. |
| 4 | Parity diff is too noisy (false divergences) | v1 diff set is deliberately small (4 fields). Ignored fields list documented. If noise appears, tighten further before promoting. |
| 5 | Helper updates V2 components even when V1 DCR write was a retry (idempotency) | V2 update uses `merge: true`; rewriting same `components.dcr.ref` is a no-op semantically. Timeline entry duplicates — acceptable since they carry `ref: submissionId` for de-dupe by readers. |
| 6 | Snapshot v1.0.0 renderer bug discovered after Phase 36 ships | Bump to v1.1.0 with fixed renderer; existing parity Timeline entries retain `snapshot_version` so the diff context is known. |

---

## Effort actuals (so far)

| Sub-slice | Estimated | Actual |
|---|---|---|
| 36a.1 renderer + tests + canary + docs | 7h | ~3h |
| 36a.2 splice + helper + tests + canary | 5.5h | TBD |

Estimate was conservative; reuse of Phase 35 patterns made 36a.1 faster.

---

## Memory references

- [[sessionsv2-architecture]] — North Star
- [[canary-harness-first-policy]] — no live-user canary until after Phase 37
- [[preview-hits-prod-backend]] — preview channels share PRODUCTION Firestore + Cloud Functions; admin write paths must default to safe-no-op
