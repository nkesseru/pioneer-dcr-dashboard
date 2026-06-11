# Academy Checkpoint v1

> **Versioned snapshot of the PioneerOps Operator Academy as of 2026-06-11.**
>
> Distinct from the [State of the Union](./academy-state-of-the-union.md), which is the analytical audit. This checkpoint is the **documentary state marker** — what exists, what is complete, what is pending verification, what comes next.
>
> Future checkpoints (v2, v3) follow the same format. Comparing v1 to v2 will show the Academy's trajectory.

| Field | Value |
|---|---|
| Checkpoint version | v1 |
| Snapshot date | 2026-06-11 |
| Latest commit hash on remote | `141547f` |
| Branch | `feature/admin-mission-control` |
| Total Academy markdown files | 46 (after this checkpoint commits) |
| Total Academy line count | ~25,000 lines (approximate) |
| Sibling product doctrine docs | 1 (Financial Pulse Operating System) |

---

## What Exists

The complete inventory at v1.

### Senior Governance Documents (5)

Mature; all amendments tracked.

| Document | Path | Version | Maturity |
|---|---|---|---|
| Academy Thesis | `ACADEMY-THESIS.md` | v1 | Senior governing doctrine; committed verbatim |
| Constitution | `CONSTITUTION.md` | v1.1 | Operational working standard; amendment log live |
| Academy Gold Standard | `academy-gold-standard.md` | v1 | Quality bar for flagship curriculum |
| Operator Certification Framework | `operator-certification-framework.md` | v1 | 4-tier credentialing system; full process spec |
| Certification Registry | `certification-registry.md` | v1 | Canonical list; Lineage ID system specified |

### Operating Reference Documents (3)

| Document | Path | State |
|---|---|---|
| Operator Glossary | `operator-glossary.md` | 60+ terms in four-part format; growing |
| Academy State of the Union | `academy-state-of-the-union.md` | First audit complete; founder-voice |
| Academy Checkpoint v1 | `academy-checkpoint-v1.md` | This document |

### Curriculum — Academy Overview (`00-academy-overview/`)

Eleven sections defining the Academy.

| # | Section | State |
|---|---|---|
| README | Mission | Live |
| 01 | Who This Is For | Live |
| 02 | Competency Model (34 competencies × 7 pillars) | Live |
| 03 | Certification Ladder | **SUPERSEDED** by Certification Framework |
| 04 | 30/60/90 Day Path | Live (references some unwritten lessons) |
| 05 | Coaching Rhythm | Live |
| 06 | Scorecard | Live |
| 07 | Graduation Standards | Live (overlaps with Certification Framework) |
| 08 | Customer Success Connection | Live |
| 09 | Company Moat | Live |
| 10 | Customer Journey | Live |

### Curriculum — Pillar Lessons

| Pillar | Planned | Live | Live lessons |
|---|---|---|---|
| 01 SaaS Foundations | ~5 | 0 | README only |
| 02 Cleaning Operations | ~6 | 2 | 02.2 RPLH, 02.3 Customer Economics |
| 03 PioneerOps Platform Mastery | ~6 | 1 | 03.1 Mission Control Diagnostics ⭐ |
| 04 AI Operator | ~5 | 1 | 04.1 AI as Operational Leverage ⭐ |
| 05 Customer Success | ~5 | 1 | 05.3 QBR Delivery ⭐ |
| 06 Revenue Operations | ~4 | 0 | README only |
| 07 Executive Advisor | ~4 | 0 | README only |
| **Total** | **~35** | **5** | **~14.3% coverage** |

⭐ = Gold Standard candidate or certified.

### Templates (`templates/`) — 16 total

| Lesson authoring (9) | Certification process (7) |
|---|---|
| `lesson-plan.md` | `certification-intent.md` |
| `student-workbook.md` | `certification-self-assessment.md` |
| `trainer-guide.md` | `certification-evidence-pack.md` |
| `quiz.md` | `certification-reviewer-evaluation.md` |
| `roleplay-scenarios.md` | `certification-decision.md` |
| `certification-rubric.md` | `certification-renewal-evidence.md` |
| `scorecard.md` | `certification-demotion-notice.md` |
| `implementation-exercise.md` | |
| `executive-briefing-exercise.md` | |

`certification-rubric.md` marked SUPERSEDED but retained for transparency.

### Sibling Product Doctrine

| Document | Path | State |
|---|---|---|
| Financial Pulse Operating System | `docs/financial-pulse-framework/01-financial-pulse-operating-system.md` | Mature v1 (947 lines); 14 patterns; full threshold library; 6 vitals deep-specified |

---

## What is Complete

The five-lesson Operator II certification foundation is complete. A candidate can — in principle — attempt Operator II certification under the existing framework using only the live lessons + templates + glossary.

### The Operator II Foundation (5 lessons)

| Lesson | Status |
|---|---|
| 02.2 — Revenue Per Labor Hour | Live · Academy Standard |
| 02.3 — Customer Economics | Live · Academy Standard |
| 03.1 — Mission Control Diagnostics | Live · Gold Standard candidate ⭐ (pending verification) |
| 05.3 — QBR Delivery | Live · **Gold Standard certified** ⭐ |
| 04.1 — AI as Operational Leverage | Live · Gold Standard candidate ⭐ (pending verification) |

Together these five lessons cover:

- **The detection layer** — RPLH detects margin issues
- **The diagnosis layer** — Customer Economics explains why
- **The diagnostic instrument** — Mission Control surfaces operational truth
- **The executive conversation** — QBR Delivery turns truth into decisions
- **The leverage** — AI Operator makes all of the above possible at scale

This is the Academy's first complete coherent learning arc. The doctrine, the curriculum, and the framework converge.

### Operator I Foundation

Operator I has slightly different bar. The foundation lessons above all support Operator I as required reading; quizzes for those lessons gate Operator I; practical demonstrations + role-play passes complete the bar.

Operator I certification is **achievable under v1** — pending only that an Apprentice candidate exists.

### Governance + Process

| Item | State |
|---|---|
| Doctrine hierarchy (Thesis → Constitution → Gold Standard → Framework) | Complete and enforced |
| Certification process (Steps 1–7) | Specified end-to-end |
| Renewal cycle | Specified per tier |
| Demotion process | Specified |
| Amendment process | Active for all doctrine docs (Constitution v1.1 demonstrates) |
| Registry system | Initialized; Lineage IDs ready |

### Templates Coverage

Every step of the certification process has a fillable template. A new Academy lead inheriting this could run a certification cycle without inventing process.

---

## What is Pending Verification

Items that are authored but require independent review before final certification or release.

### Gold Standard Verifications

Two lessons claim Gold Standard status pending independent verification:

#### 03.1 Mission Control Diagnostics

| Item | Status |
|---|---|
| Self-assessment | 18/18 Gold Standard checklist; 15/15 Pioneer Test |
| Pending verification 1 | **Nick reading April's Pioneer example** — does the texture match real Pioneer Monday-read workflows? |
| Pending verification 2 | **Engineering review of "MC does NOT show" bounds table** — verify each entry against current platform capability |

#### 04.1 AI as Operational Leverage

| Item | Status |
|---|---|
| Self-assessment | 18/18 Gold Standard checklist; 15/15 Pioneer Test |
| Pending verification 1 | **Nick reading April's Dental Plaza Pillar 8 catch** — does it match Pioneer practice? |
| Pending verification 2 | **Interpretation of "named failure first" pattern** — does the lesson honor original Gold Standard intent? |

Once both verifications clear for either lesson, that lesson becomes a **Gold Standard certified** lesson (joining 05.3 QBR Delivery).

### Lesson-Level Improvement Backlog

Items flagged during executive reviews but not yet applied:

| Lesson | Improvements pending |
|---|---|
| 03.1 MC Diagnostics | (1) Engineering verification of bounds table; (2) Add anonymization disclosure to trainer notes; (3) Add fallback path for exercise if real CEO unavailable |
| 04.1 AI Operator | (1) Add anonymization disclosure; (2) FMR calibration note; (3) "How to read this lesson" navigation; (4) First-time exercise multiplier note; (5) FMR diagram visual upgrade (future) |

These improvements are **non-blocking for shipping the lessons to the first cohort**. They are blocking for the lesson being marked Gold Standard certified.

### Framework Untested in Practice

| Item | Status |
|---|---|
| Operator Certification Framework | Fully specified; **zero candidates certified** |
| Registry | Initialized; **zero Lineage IDs assigned** |
| Renewal cycle | Specified; **zero renewals attempted** |
| Demotion process | Specified; **zero demotions attempted** |

The framework is theoretical until the first certification cycle runs. **First cycle is the v1 → v1.1 trigger** — whatever the framework cannot handle gracefully will need amendment.

### Doctrine Drift Risk

Cross-reference drift across the corpus is a known risk surfaced in the State of the Union audit. No automated link-checker exists yet. Quarterly manual audit recommended.

| Concept | Defined in | Drift control |
|---|---|---|
| Pioneer Test | Constitution | Senior source enforces; templates derive |
| Six Vitals | Thesis + Constitution | Senior sources align; downstream consistent |
| The Loop | Thesis Section 9 | Senior source; downstream consistent |
| Operator definition | Thesis + Constitution Pillar 2 | Both senior-tier; mirrored |
| Certification Standard | Constitution + Cert Framework | Constitution principle; Framework operational |

All currently consistent. Will drift if amendments aren't propagated carefully.

---

## What the Next Recommended Milestone Is

The audit + checkpoint together recommend a single named milestone:

> **Milestone v1.5 — First Operator II Certification.**
>
> Within the next 90 days, run the first complete certification cycle from intent to decision. The candidate must come from active Pioneer staff. The framework must hold against real evidence. The verification must be defensible against an external review.

### What's required to hit Milestone v1.5

| Requirement | Status | Action needed |
|---|---|---|
| 1. Candidate identified | Not done | Operator I current OR Apprentice ready to attempt Operator II |
| 2. Candidate has completed 4 of 5 foundation lessons (RPLH, Customer Economics, MC Diagnostics, QBR Delivery) | Lessons exist; candidate must read | Schedule reading + practice time |
| 3. Candidate has completed 04.1 AI Operator | Lesson exists; candidate must read | Schedule reading + practice |
| 4. Candidate has owned ≥ 8 accounts for ≥ 90 days | TBD | Verify against current Pioneer customer roster |
| 5. Candidate has delivered ≥ 8 QBRs with rubric pass | TBD | Operator activity history |
| 6. Candidate has documented ≥ 12 Loop entries, ≥ 8 closed | TBD | Loop log existence |
| 7. Candidate has at least 1 churn-risk save | TBD | Operator portfolio review |
| 8. Candidate has at least 1 expansion deal | TBD | Operator portfolio review |
| 9. Candidate has at least 1 Pillar 8 Discontinuity handled | TBD | Operator workflow audit |
| 10. Two reviewers identified (one primary, one independent senior) | Not done | Pioneer roster review |
| 11. Pioneer Test + Gold Standard pass on Items 1 + 2 above | Pending verifications | Nick read + engineering review |

### What v1.5 produces

- **The first Lineage ID** entered into the registry: `POPS-OP-II-2026-0001`
- **The first evidence pack** in archive — establishes the bar against which all future packs will be measured
- **The first certified Operator** — converts the framework from theoretical to operational
- **Amendments to the Framework v1 → v1.1** — whatever the first cycle could not handle gracefully

### Why v1.5 specifically (not v2)

v2 would imply major structural change (e.g., second industry, external candidates, public verification API). v1.5 is the first practical use of the v1 system. It validates the framework without restructuring it.

If v1.5 succeeds (the first certified Operator's evidence pack would defend against external review), v2 work can start with confidence. If v1.5 fails or requires major amendment, the framework needs rework before v2.

### Stretch milestones after v1.5

| Milestone | Target |
|---|---|
| v1.6 — First Apprentice → Operator I cycle | After v1.5 success |
| v1.7 — Doctrine drift audit complete | Quarterly, ongoing |
| v1.8 — Pillar 07 (Executive Advisor) first lesson live | Next curriculum gap to close |
| v1.9 — Customer-Facing Vital Read Primer live | First customer-facing material |
| v2 — Cross-industry adaptation guide + telecom case study | The moat proof |

These are sequenced by leverage, not by date. v1.5 is the gating milestone. Everything beyond depends on the framework being proven in practice.

---

## The Single-Sentence State

If a board member asked the founder for one sentence on the Academy at v1:

> *"The doctrine is mature; the foundation curriculum exists; the framework is specified; the first certification is the next milestone."*

Each of those four clauses is a real claim and each is defensible against the evidence in this checkpoint.

---

## Comparison Promise (for future v2)

When v2 ships, this section should be filled with the **delta from v1 to v2**. Specifically:

- New lessons authored
- New Gold Standard certifications
- Number of Operators certified
- Doctrine amendments
- Framework amendments (what the first cycle taught us)
- New product features built from the FP Operating System
- New senior governance docs (if any)

v2 should ship no later than 6 months after v1 (2026-12-11). Earlier is fine. Later is a signal that the v1.5 milestone got blocked.

---

| Document version | 1 |
|---|---|
| Snapshot date | 2026-06-11 |
| Authored by | Academy lead (founder-mode) |
| Next checkpoint | v2 — target by 2026-12-11 |
| Authority | This document inherits from [Constitution v1.1](./CONSTITUTION.md), [Operator Certification Framework](./operator-certification-framework.md), and the [State of the Union](./academy-state-of-the-union.md). Where it conflicts with senior doctrine, senior doctrine governs. |
