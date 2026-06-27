# SessionV2 — Phase 35 Readiness Checklist

**Status (2026-06-26)**: Phase 34a deployed. Phase 35 (clock writes Session) cannot start until every box below is checked.

Phase 35 = `service-clock.js` dual-writes V1 + V2 behind `SESSION_V2_ENABLED`. The hardest slice in the migration because tech-clock is the highest-traffic write path in the system.

---

## A. Phase 34a hard gates (must all be true)

### Foundation shipped
- [x] `createSessionV2` Cloud Function deployed to prod 2026-06-26 (returns 503 with flag off)
- [x] `reconcileV1V2ParityV1` Cloud Function stub deployed to prod 2026-06-26
- [x] Updated `firestore.rules` deployed (timeline rename + environment field gate)
- [x] 2 new composite indexes deployed (parent_route_id, environment)
- [x] 69/69 rules tests passing
- [x] 12/12 functional tests passing
- [x] Smoke: POST createSessionV2 returns 503 SESSION_V2_DISABLED
- [x] Smoke: GET 405, OPTIONS 204, POST unauth-via-reconcile 401 (auth gate intact)

### Stability soak
- [ ] 7 days minimum since Phase 34a deploy with no incidents
- [ ] No spurious sessionsV2 writes detected (alert: any write to sessionsV2 from non-admin auth)
- [ ] Existing production behavior unchanged (Phase 33 metrics flat)

### End-to-end validation
- [ ] `SESSION_V2_ENABLED` flag flipped to `true` in canary mode
- [ ] At least 1 real createSessionV2 invocation by admin succeeds (returns 200 + creates doc)
- [ ] Doc inspected in Firestore Console — schema matches `docs/sessionsV2/SCHEMA.md` exactly
- [ ] Timeline entry visible with `session.created` event
- [ ] Doc deleted via Admin SDK (rules deny client delete; this verifies the immutability invariant)
- [ ] Flag flipped back to `false` after validation

### Phase 34b (debug UI) optional
- [ ] `/admin` SessionV2 Debug tab built (HTML + JS) — _optional; deferred from Phase 34a_
- [ ] `SESSION_V2_DEBUG_UI_ENABLED` flag wired in `firebase-config.js`
- [ ] Debug tab can create + display debug sessions with Timeline expanded

Phase 35 can proceed WITHOUT 34b if validation happens via curl.

---

## B. Phase 35 implementation prerequisites

### Design tightening
- [ ] **Decision A**: tech `/work` opens-assignment → creates Session at `status="ready"` OR holds Session-create until clock_in? Recommend: hold until clock_in (matches "Session = reality" principle)
- [ ] **Decision B**: dual-write order — V1 first then V2, or V2 first then V1? Recommend: V1 first (existing reliable path) then V2 (best-effort; failure surfaces in reconciliation)
- [ ] **Decision C**: cross-midnight clock-in: which `service_date` does the Session get? Recommend: shift-start date in Pacific (matches Phase 32C.1 classifier convention)
- [ ] **Decision D**: dual-write skew alert threshold — log-only or page-on-call? Recommend: log + nightly summary email to admin@; no on-call paging in Phase 35

### Infrastructure to build
- [ ] `applyPendingSessionWritesV1` queue processor — design doc + impl
- [ ] `reconcileV1V2ParityV1` real logic (replaces Phase 34 stub):
    - Queries V1 sessions created in the last hour
    - For each, checks if matching V2 doc exists
    - Logs skew with session_id + diff
    - Optional: write skew alert to admin alert collection
- [ ] `service-clock.js` instrumentation:
    - Pre-compute V2 session_id at assignment-open time (offline-first anchor)
    - On clock_in: write V1 session (existing path) → POST createSessionV2 with deterministic id
    - On clock_out: write V1 update (existing path) → POST updateSessionV2Status (NEW CF needed) to flip status to `awaiting_completion`
- [ ] NEW Cloud Function: `updateSessionV2StatusV1` for status transitions (clock_out → awaiting_completion etc.)

### Test coverage extension
- [ ] Rule test: tech can write `actual_sequence` on own session
- [ ] Functional test: dual-write produces matching V1 + V2 docs
- [ ] Skew test: deliberate V2 failure → reconciliation detects + logs
- [ ] Idempotency test: clock_in fires twice in 1 second → exactly 1 V2 doc

### Rollback infrastructure
- [ ] `SESSION_V2_ENABLED` flag plumbed into `service-clock.js` (via firebase-config.js mirror)
- [ ] Tested: setting flag to false cleanly disables all V2 writes (V1 still flows)
- [ ] V1 collection unchanged; V1 writers untouched

---

## C. Phase 35 cutover plan (must be approved before code starts)

### Rollout sequence (revised 2026-06-26 — canary-harness-first policy)

**Live-user canary is NOT scheduled for Phase 35.** The Canary Harness (see `CANARY_HARNESS.md`) is the primary validation mechanism for Phases 35-37. Live-user canary returns only AFTER Phase 37 completes.

For Phase 35 specifically:
1. Land Phase 35 code with `SESSION_V2_ENABLED=false` (no behavior change in production)
2. Deploy to prod functions + hosting (UI flag stays off)
3. Run full canary-harness validation on preview channel (admin only, environment=debug, source=canary)
4. Code-review the splice point in `service-clock.js:clockIn()`
5. Verify zero skew via `reconcileV1V2ParityV1` against canary docs
6. Mark Phase 35 complete; proceed to Phase 36 without live-user canary

### Rollback signals (any one triggers immediate flag-off)
- V1↔V2 mismatch on any field except `updated_at` / `status_version` / `timeline`
- Tech `/work` clock-in latency > +500ms over baseline
- Any V1 session created without matching V2 doc within 30s
- Spike in client-side errors related to V2

### Phase 35 → Phase 36 promotion gate
- 14-day soak with zero rollback signals
- Reconciliation job shows zero skew across all techs
- No spurious admin pages or alerts

---

## D. Phase 35 explicitly does NOT touch

- DCR submit flow (Phase 36)
- Photo upload flow (Phase 36)
- Payroll export reader (Phase 37)
- Mission Control reader (Phase 38)
- Customer email pipeline (Phase 39)
- Removal of any V1 logic (Phase 40)
- Admin Labor Review UI (read paths unchanged)

---

## E. Decision log

| Date | Decision | Rationale | Owner |
|---|---|---|---|
| 2026-06-25 | Phase 33 schema finalized | See `docs/sessionsV2/SCHEMA.md` | Nick |
| 2026-06-26 | Phase 34 design locked: session_id format, environment field, parent_route_id, component state machines, derived completion, Timeline first-class | All approved + 7 items in `[[sessionsV2-architecture]]` | Nick |
| 2026-06-26 | Phase 34a scope cut: debug UI deferred to 34b | Function + flag is the safety; UI is convenience | Claude |
| 2026-06-26 | New state `pending_payroll_review` added | Lesson from 2026-06-25 Add Shift incident | Nick |
| 2026-06-26 | `audit_log` renamed → `timeline` | Timeline is first-class human narrative, not audit-only | Nick |
| _pending_ | Decision A: Session-create timing on Start Work | _Phase 35 design decision_ | — |
| _pending_ | Decision B: dual-write order | _Phase 35 design decision_ | — |
| _pending_ | Decision C: cross-midnight service_date convention | _Phase 35 design decision_ | — |
| _pending_ | Decision D: skew alert routing | _Phase 35 design decision_ | — |

---

## F. Phase 34a → Phase 35 owner handoff

When Phase 35 begins, the implementer should:
1. Read `docs/sessionsV2/SCHEMA.md` end-to-end
2. Read `docs/sessionsV2/PHASE34_PLAN.md` for context on what's in place
3. Read `[[sessionsV2-architecture]]` memory
4. Run `npm run test:all:sessionsV2` and confirm 81/81 passing
5. Verify prod rules + indexes match local
6. Verify `firebase functions:list` shows `createSessionV2` + `reconcileV1V2ParityV1`
7. Verify smoke: `curl ...createSessionV2` POST returns 503
8. Resolve open decisions A-D above with Nick
9. Author Phase 35 implementation plan doc before writing code
