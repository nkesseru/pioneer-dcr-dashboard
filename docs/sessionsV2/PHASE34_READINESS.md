# SessionV2 — Phase 34 Readiness Checklist

**Status (2026-06-25)**: Phase 33 implementation complete locally. Production deploy of rules + indexes still PENDING (held until Add Manual Shift + Supersede prod soak completes, per gating in [[sessionsV2-architecture]]).

Phase 34 (dual-write tech clock-in to V2 alongside V1) cannot begin until every box below is checked.

---

## A. Phase 33 hard gates (must all pass before Phase 34 starts)

### Foundation in place
- [ ] `firestore.rules` sessionsV2 block deployed to PROD
- [ ] `firestore.indexes.json` 6 sessionsV2 composite indexes deployed to PROD
- [ ] All 61 emulator rule tests passing on a clean machine
- [ ] `docs/sessionsV2/SCHEMA.md` reviewed by Nick + signed off as canonical
- [ ] Production Firestore `sessionsV2` collection visibly empty (no rogue writers)

### Pre-requisite stability gates (revised 2026-06-26)
- Phase 35-37 explicitly DO NOT require Bonnie pilot or any live-user
  canary; the Canary Harness (see `CANARY_HARNESS.md`) is the primary
  validation mechanism. Live-user canary returns AFTER Phase 37.
- [ ] Phase 32B inert clock queue not flipped on without coordinated cutover plan

### Observability ready
- [ ] Alerting rule: any write to `sessionsV2` collection from non-admin auth fires alert (defensive — should be zero writes until Phase 34)
- [ ] Mission Control debug tile (off by default) shows V2 doc count for confidence during Phase 33 → 34 transition

---

## B. Phase 34 implementation prerequisites (must be drafted before code starts)

### Design tightening
- [ ] Decide: tech open-assignment writes `status=assigned` or `status=ready` (current draft: tech opening = `ready`; admin scheduling shell = `assigned`)
- [ ] Decide: client-side ID computation for cross-midnight cases — does `service_date` follow Pacific midnight or shift's actual start date?
- [ ] Decide: how dual-write handles writeback failure on one side (V1 success / V2 fail or vice versa) — retry queue or alert-and-skip?

### Infrastructure
- [ ] Cloud Function `applyPendingSessionWritesV1` queue-processor design doc authored
- [ ] Cloud Function `createSessionV2` callable function authored (was optional in Phase 33; required for Phase 34)
- [ ] `service-clock.js` modification plan: where dual-write fits, how to avoid double-counting
- [ ] Cloud Function `reconcileV1V2ParityV1` (nightly comparison job) authored

### Test coverage extension
- [ ] Phase 34 emulator tests added to `test/sessionsV2.rules.test.mjs`:
    - Cloud Function service-account write path (via custom claim or admin SDK bypass)
    - Status transition `awaiting_completion → complete` auto-triggered by all components true
    - Mirror to `sessionsV2_open` write through CF trigger context
- [ ] Cloud Function unit tests for `applyPendingSessionWritesV1` (idempotency, ordering, drift clamp)

### Rollback infrastructure
- [ ] `SESSION_V2_ENABLED` env flag plumbed into `service-clock.js` (defaults `false`)
- [ ] Verified: setting `SESSION_V2_ENABLED=false` cleanly disables all V2 writes within ≤5 min of deploy
- [ ] V1 collection unchanged; V1 writers untouched

---

## C. Phase 34 cutover plan (must be approved before code starts)

### Rollout sequence
1. Land Phase 34 code with `SESSION_V2_ENABLED=false` (no behavior change)
2. Deploy to prod hosting + functions
3. Enable flag for 1 admin tech account only (canary)
4. Verify dual-write happens cleanly (V1 + V2 both written, same data)
5. Verify reconciliation job shows zero skew over 24h
6. Enable flag for Bonnie (Phase 31 pilot account) for 7 days
7. Reconcile + verify
8. Enable flag for all techs

### Rollback signals (any one triggers immediate flag-off)
- V1↔V2 mismatch on any field except `updated_at` / `status_version`
- Tech `/work` clock-in latency > +500ms over baseline
- Any session created without matching V1 doc
- Any `pioneer_service_sessions` row that doesn't get a V2 mirror within 30 sec

### Success signal for Phase 34 → Phase 35 promotion
- 14-day soak with zero rollback signals
- Reconciliation job shows zero skew
- Backfill of last 90 days V1 → V2 shells completes without errors

---

## D. What Phase 34 explicitly does NOT touch

- DCR submit flow (Phase 35)
- Photo upload flow (Phase 35)
- Payroll export reader (Phase 36)
- Mission Control reader (Phase 37)
- Customer email pipeline (Phase 38)
- Removal of any V1 logic (Phase 39)

---

## E. Decision log (filled in as decisions land)

| Date | Decision | Rationale | Owner |
|---|---|---|---|
| 2026-06-25 | Schema fields finalized | See `docs/sessionsV2/SCHEMA.md` | Nick |
| 2026-06-25 | Inert `createSessionV2` skipped in Phase 33 | No caller; would add code surface Phase 34 immediately replaces. Function created when Phase 34 needs it. | Claude / Nick |
| _pending_ | Tech open status: assigned vs ready | _Phase 34 design decision_ | — |
| _pending_ | Cross-midnight service_date handling | _Phase 34 design decision_ | — |
| _pending_ | Dual-write failure handling | _Phase 34 design decision_ | — |

---

## F. Phase 33 → 34 owner handoff

When Phase 34 begins, the implementer should:
1. Read `docs/sessionsV2/SCHEMA.md` end-to-end
2. Read `[[sessionsV2-architecture]]` memory
3. Run `npm run test:rules:sessionsV2` and confirm 61/61 passing
4. Verify prod rules + indexes match local
5. Review the Decision log above and resolve any `_pending_` entries with Nick
6. Author Phase 34 implementation slice doc (rollout sequence + rollback signals) before writing code
