# Academy Checkpoint v1.5

> **Incremental versioned snapshot.** Post-audit. Marks the state after the corpus audit + Tier 1 fixes landed.
>
> Distinct from [Checkpoint v1](./academy-checkpoint-v1.md) (initial snapshot) and the [State of the Union](./academy-state-of-the-union.md) (analytical audit). This checkpoint is a **stability marker** — the Academy in a known-good, audit-clean state, ready for the first certification cycle.

| Field | Value |
|---|---|
| Checkpoint version | v1.5 |
| Snapshot date | 2026-06-11 |
| Latest commit on remote | `e656614` |
| Branch | `feature/admin-mission-control` |
| Promoted from | Checkpoint v1 (commit `c079a3e`) |
| Delta from v1 | +1,332 lines (audit report + 5 glossary entries + AI Operator lesson previously) |
| Total Academy markdown files | 48 |

---

## What Changed Since v1

The single audit cycle between v1 and v1.5 surfaced one structural bug + five quality gaps. All six were resolved in the same cycle.

| Item | Before | After |
|---|---|---|
| Duplicate `# B` section header in glossary | Present | Fixed |
| Glossary entries | 66 | 71 |
| Doctrine terms used in senior docs without glossary entries | 5 | 0 |
| Dated audit reports on file | 0 | 1 |

Plus:
- [AI Operator lesson](./04-ai-operator/01-prompt-patterns.md) ⭐ added (was named in v1's "next milestones"; landed before v1.5)
- [State of the Union audit](./academy-state-of-the-union.md) authored
- Internal link integrity verified: 166/166 resolve

---

## What Exists

(Inventory unchanged from [Checkpoint v1's What Exists section](./academy-checkpoint-v1.md#what-exists) — refer there for the complete file-by-file inventory. v1.5 changes captured above.)

Headline numbers:

| Layer | Count |
|---|---|
| Senior governance docs | 5 |
| Operating reference docs | 4 (Glossary, State of the Union, Checkpoint v1, Checkpoint v1.5) |
| Audits on file | 1 |
| Academy overview curriculum | 11 sections |
| Live pillar lessons | 5 of ~35 planned (~14.3%) |
| Templates | 16 (9 lesson + 7 cert) |
| Sibling product doctrine | 1 (Financial Pulse Operating System) |
| Glossary terms | 71, four-part format, no duplicates |

---

## What Is Production-Ready

Items that can be used in real work today. Distinct from "complete" — these are battle-tested-enough to ship to an Operator, Apprentice, or customer without further drafting.

### Senior Doctrine — Production-Ready

| Document | Production-ready? | Notes |
|---|---|---|
| Academy Thesis | ✅ | Senior governing doctrine; serves all audiences |
| Constitution v1.1 | ✅ | Amendment log live; cited consistently across corpus |
| Academy Gold Standard | ✅ | Used as quality bar by 3 lessons already |
| Operator Certification Framework | ✅ | Specified end-to-end with templates; awaiting first cycle to validate |
| Certification Registry | ✅ | Initialized; ready to accept first Lineage ID |
| Operator Glossary | ✅ | 71 entries; 100% four-part format compliance |
| Financial Pulse Operating System | ✅ | Engineering can build against this v1 spec |

### Curriculum — Production-Ready

| Lesson | Production-ready? | Notes |
|---|---|---|
| 02.2 RPLH | ✅ Academy Standard | Can be assigned to any Apprentice today |
| 02.3 Customer Economics | ✅ Academy Standard | Pairs with RPLH as a two-lesson sequence |
| 03.1 Mission Control Diagnostics | ✅ Gold Standard candidate (verification pending) | Teachable today; verifications gate Gold Standard mark |
| 04.1 AI Operator | ✅ Gold Standard candidate (verification pending) | Same posture |
| 05.3 QBR Delivery | ✅ Gold Standard CERTIFIED | The reference flagship |

**The five-lesson Operator II foundation is production-ready.** An Apprentice candidate could begin training against these today.

### Templates — Production-Ready

All 16 templates are real, fillable forms. No stubs. Both tracks (lesson authoring + certification process) operationally complete.

### Audit Infrastructure — Production-Ready

| Item | State |
|---|---|
| Audit method documented | ✅ In `audits/audit-2026-06-11.md` |
| Audit findings catalog | ✅ 6 findings surfaced; 6 resolved |
| Audit reproducibility | ✅ Scripts at `/tmp/`; Tier 2 work moves to `audits/scripts/` |
| Monthly audit cadence recommended | ⚠️ Recommended but not yet codified as an Academy lead playbook item |

---

## What Remains Incomplete

Production-ready ≠ feature-complete. These items are gaps, not blockers for the next milestone.

### Curriculum Gaps

| Pillar | Live | Planned | Gap |
|---|---|---|---|
| 01 SaaS Foundations | 0 | ~5 | Pillar entirely empty |
| 02 Cleaning Operations | 2 | ~6 | 4 lessons unwritten |
| 03 PioneerOps Platform Mastery | 1 | ~6 | 5 lessons unwritten |
| 04 AI Operator | 1 | ~5 | 4 lessons unwritten |
| 05 Customer Success | 1 | ~5 | 4 lessons unwritten (Discovery is highest-leverage) |
| 06 Revenue Operations | 0 | ~4 | Pillar entirely empty |
| 07 Executive Advisor | 0 | ~4 | Pillar entirely empty (strategic gap) |

### Process Gaps Surfaced in the State of the Union

| Gap | Status |
|---|---|
| Apprentice Progress Tracker template | Open (named in State of the Union as the highest-leverage next doc) |
| 360 Review template | Open |
| Academy KPIs / Scorecard | Open |
| Academy Lead Playbook | Open |
| Trainer-of-Trainers doc | Open |
| Cross-Industry Adaptation Guide | Open |
| Customer-Facing Vital Read Primer | Open |
| Pattern Library Deep Dive | Open |
| Customer-Tier Taxonomy | Open |
| Academy External-Comms Brand Voice | Open |

### Verification Pending (Gates Two Gold Standard Certifications)

| Lesson | Pending |
|---|---|
| 03.1 MC Diagnostics | (1) Nick verifies April's Pioneer example texture; (2) Engineering verifies "MC does NOT show" bounds table |
| 04.1 AI Operator | (1) Nick verifies April's Dental Plaza catch matches Pioneer practice; (2) Verify named-failure-first interpretation honors original Gold Standard intent |

Until both verifications clear for each lesson, both remain "Gold Standard candidates," not "certified."

### Audit Tooling — Tier 2 Work

| Item | Status |
|---|---|
| Link audit as pre-commit hook | Open · ~30 min |
| Glossary format check as pre-commit hook | Open · ~45 min |
| Move audit scripts to `audits/scripts/` | Open · ~20 min |
| Document the audit cadence in Academy Lead Playbook | Open (depends on Playbook authoring) |

### Untested in Practice

The certification framework itself is fully specified but **zero candidates have been certified.** Until the first Operator II cycle runs end-to-end, the framework is theoretical. This is the same blocker named in Checkpoint v1.

---

## Next Recommended Milestone

**Unchanged from Checkpoint v1:**

> **Milestone v2 — First Operator II Certification.**
>
> Within 90 days of v1 snapshot (target: 2026-09-11), run the first complete certification cycle from intent to decision.

The audit + fixes between v1 and v1.5 do not change the next milestone — they confirm the Academy is **clean enough to attempt it.**

### Why v2 (not v1.5+)

- v1.5 captures the audit cycle (stability work)
- v2 should capture the first real certification (operational validation)

This naming convention works as long as the same actor (Academy lead, founder-mode) is moving the milestone forward. If multiple people start contributing, the framework's natural amendment cycle takes over.

### What v2 specifically requires

(Already enumerated in Checkpoint v1's Milestone v1.5 section; restated here as v2-relevant.)

| # | Requirement | Status at v1.5 |
|---|---|---|
| 1 | Candidate identified (Operator I or Apprentice attempting Operator II) | Open |
| 2–3 | Candidate has completed 5 foundation lessons | Lessons exist; candidate-side reading + practice required |
| 4–9 | Portfolio requirements (8+ accounts, 8+ QBRs, churn save, expansion, etc.) | TBD per candidate |
| 10 | Two reviewers identified | Open |
| 11 | Gold Standard verifications cleared on 03.1 + 04.1 | Open (Nick reviews) |

### Stretch milestones from v1.5 onward

| Milestone | Target |
|---|---|
| v2 — First Operator II certification | 2026-09-11 |
| v2.1 — Apprentice → Operator I first cycle | After v2 success |
| v2.2 — Tier 2 audit tooling (pre-commit hooks) | Parallel-able with v2 |
| v3 — First non-cleaning industry adaptation guide + telecom case study | 2027 |

---

## The Single-Sentence State at v1.5

> *"The Academy is audit-clean, the foundation curriculum is production-ready, and the first certification cycle is unblocked."*

Compare to v1's headline:

> *"The doctrine is mature; the foundation curriculum exists; the framework is specified; the first certification is the next milestone."*

The v1.5 sentence is stronger — same milestone, fewer caveats. The audit work between v1 and v1.5 produced a real upgrade in confidence, not just file count.

---

## Comparison Promise (for v2)

When v2 ships, this section should report the **delta from v1.5 to v2**. Specifically:

- First Lineage ID assigned (`POPS-OP-II-2026-0001`)
- First evidence pack archived
- Reviewer ratings + Academy lead decision documented
- Any Framework v1 → v1.1 amendments triggered by the first cycle
- Pillars that gained a first lesson since v1.5
- Customer-facing materials authored (if any)

v2 target: **2026-09-11.** If v2 ships earlier, the early-ship date should be celebrated, not anxiety-inducing. If v2 slips past 2026-09-11, that's a signal to review what blocked the first certification.

---

## What This Checkpoint Marks

A **stable state.** The Academy is not yet feature-complete, but it is doctrinally consistent, audit-clean, and operationally usable. Three audiences could pick it up today:

1. **A new Academy lead** could inherit it and run the first cert cycle without inventing process.
2. **An Apprentice candidate** could begin training against the five foundation lessons and the templates today.
3. **An external evaluator** could read the State of the Union + this Checkpoint + the audit report and form an opinion on the Academy's seriousness without needing live demos.

That third audience matters. The Academy is now **defensible against external scrutiny** in a way it was not at v1. The audit work is the difference.

---

| Document version | 1.5 |
|---|---|
| Snapshot date | 2026-06-11 |
| Authored by | Academy lead (founder-mode) |
| Promoted from | [Checkpoint v1](./academy-checkpoint-v1.md) (`c079a3e`) |
| Next checkpoint | v2 — target by 2026-09-11; ships when first Operator II is certified |
| Authority | This checkpoint inherits from [Constitution v1.1](./CONSTITUTION.md), [Operator Certification Framework](./operator-certification-framework.md), [State of the Union](./academy-state-of-the-union.md), and [Audit 2026-06-11](./audits/audit-2026-06-11.md). |
