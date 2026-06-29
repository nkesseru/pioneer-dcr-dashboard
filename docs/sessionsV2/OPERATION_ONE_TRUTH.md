# Operation One Truth — Constitution v1.0

**Locked 2026-06-29.**

This document is the governing philosophy for the remainder of the SessionV2 migration. Implementation details may evolve. These principles do not.

---

## Mission

PioneerOps is no longer migrating features.

PioneerOps is migrating ownership of operational truth.

The Session becomes the truth.

Everything else becomes a projection of Session state.

---

## Rule 1 — V1 is frozen for new business logic

V1 receives only:
- production bug fixes
- security fixes
- operational blockers

No new reporting. No new workflows. No new reconciliation.

Every engineering hour should move ownership toward Session.

## Rule 2 — Session owns reality

Reality includes: clock, GPS, photos, checklist, issues, notes, DCR, payroll lifecycle, customer communication lifecycle.

No second object may become another source of truth.

## Rule 3 — Projections never own data

Mission Control, Payroll, Customer Reports, Exports, Dashboards, Analytics — all projections.

They observe Session. They never author Session.

## Rule 4 — No new Cloud Function may depend on V1

Permitted V1 reads/writes:
- migration bridges
- compatibility shims
- historical reporting
- retirement tooling

Every new feature reads Session. Never V1.

## Rule 5 — Stop writing V1

The end goal is NOT deleting historical collections.

Historical data remains. Historical writes end.

Once no writes occur, reconciliation becomes unnecessary and deletes itself.

**Phase 40 is defined as: V1 becomes read-only audit history.**

## Rule 6 — Assignments are outside Operation One Truth

Assignments represent planned work. Sessions represent completed work.

Plan and record remain separate concepts.

Future AssignmentsV2 may exist. They are not part of this migration.

Do not couple Session architecture to assignment architecture.

## Rule 7 — No new document types

Every new concept becomes exactly one of:
- A Session Component
- A Projection

If a proposed feature requires a brand new top-level collection, challenge the design first.

Assume the architecture is wrong before assuming another collection is necessary.

## Rule 8 — Components own their own lifecycle

Never introduce top-level booleans.

Each component maintains its own state machine.

Example (photos): `missing | collecting | complete | failed | replaced`

Apply this philosophy consistently.

## Rule 9 — Timeline is canonical

Every meaningful transition creates a timeline event.

Timeline is not debugging. Timeline is operational history.

Future tooling should prefer timeline over inferred state.

## Rule 10 — Migration slices remain tiny

Every phase must be:
- independently deployable
- independently testable
- reversible
- preview deployable
- canary validated
- safe with feature flags OFF

No large rewrites. No flag days. No production surprises.

---

## Phase Roadmap (post-Constitution)

| Phase | Goal |
|---|---|
| **36c** | Photos become Session components |
| **36d** | Checklist becomes Session component |
| **36e** | Issues and Notes become Session components |
| **37a** | One Mission Control alert type reads from Session (stalled-session recommended) |
| **37b** | Remaining MC alert types migrated, one at a time |
| **37c** | MC's "today's sessions" list rendered from sessionsV2_open projection |
| **38a** | Payroll WRITES to session.payroll.* (additive, no readers yet) |
| **38b** | Payroll READS replaced (Labor Review, then Export) |
| **39a** | Customer email body rendered from `renderSessionSnapshot()` at send time |
| **39b** | Retire V1 Zapier webhook |
| **40a** | Stop writing dcr_submissions (submitDcrV1 deletes its V1 write) |
| **40b** | Stop writing pioneer_service_sessions (service-clock deletes its V1 write) |
| **40c** | Delete reconciliation Cloud Functions (self-deletion of bridges) |

Mission Control should never depend on partial Session ownership. **Finish ownership before migrating readers.**

---

## Engineering Philosophy

When faced with two designs, prefer:
- Deleting code over adding code
- One source of truth over synchronization
- Projection over duplication
- Recovery over reconciliation
- Observation over mutation
- Session over everything else

## Challenge Clause

Do not follow this document blindly. If a simpler architecture better satisfies these principles, challenge it before implementing.

Optimize for the platform PioneerOps should still be running ten years from now. Not for today's implementation.

## Final Principle

Every design discussion begins with one question:

> **"How does the Session own this?"**

If the answer is unclear, stop. Rethink the architecture. Only continue when ownership is obvious.

The Session becomes the truth.
