---
doc_type: operational-gap-analysis
status: active
created: 2026-06-11
author: Nick (with Claude)
governance_tier: 3
scope: gaps blocking April from completing Operator I cycle
companion_to:
  - [operator-i-launch-plan.md](./operator-i-launch-plan.md)
  - [academy-next-milestone.md](./academy-next-milestone.md)
---

# Operator I Gap Analysis

**The question.** April starts Monday 2026-06-15. The [launch plan](./operator-i-launch-plan.md) is a 6-week sequence executable against the frozen Academy corpus. What's missing that would block her from finishing?

**Inventory method.** For each artifact the launch plan calls for, did I check whether it exists in the corpus AS A FUNCTIONING ARTIFACT — not just a template, not just a reference. If the answer is "the template exists but the Operator I version isn't filled in," that's a gap.

**Ranking rule.**
- **Critical** — the cycle cannot complete without this. April hits a wall.
- **Important** — the cycle can complete but quality of the certification decision degrades. Reviewers calibrate on vibes instead of evidence.
- **Nice to Have** — would make the cycle smoother, faster, or more scalable. Not required for first cycle.

The goal is **not** to author all critical items right now. The goal is to know which items must be in place by which week so Week 1 doesn't get blocked.

---

## Missing curriculum

### Critical

| Gap | Why it blocks | Latest acceptable resolution |
|---|---|---|
| **Quiz answer keys for the 4 foundation lessons.** Quiz questions exist inline (10 per lesson, verified). Authoritative answer keys + grading rubrics do not exist as a separate artifact. Without keys, "≥ 7/10" cannot be objectively measured. | Blocks Week 1 Days 1–4 (quiz scoring). Reviewers can't validate quiz scores in Week 6. | **Day 0 (Friday Intent meeting).** Nick writes the answer key for at least one quiz before the meeting; the rest can be written in evenings of Week 1 alongside April's attempts. |
| **Operational Feed access for April.** The launch plan asks her to review 20 events. If her PioneerOps account doesn't have the right role/permission to see the Operational Feed, she's blocked. | Blocks Week 2 onward. | **Day 0.** Verify her role in `users/` Firestore doc grants Operational Feed read. |

### Important

| Gap | Why it matters | Latest acceptable resolution |
|---|---|---|
| **Reading guide ordering across the 4 lessons.** Each lesson is standalone, but there's an implicit pedagogical order (RPLH → Customer Economics → MC Diagnostics → QBR Delivery). No single doc states this order is required. | Without a stated order April may take them in a sequence that confuses her. | **Day 0.** Verbally stated at Intent meeting; written into the cycle record. |
| **Constitution reading discipline.** The launch plan says "read the Constitution" Week 1. The Constitution is dense (8 pillars, Pioneer Test, Six Vitals). A 1-paragraph Pioneer Test reflection assumes she's internalized it. There is no Constitution quiz or comprehension check. | Risk: Pioneer Test reflection is shallow, gets flagged as failing the Pioneer Test, triggers Conditional Pass. | **Week 1.** Add a single Constitution comprehension exercise — verbal Q&A with Nick at end of Week 1, 15 min. No new doctrine; just a checkpoint conversation. |

### Nice to have

- **Video lectures for the 4 foundation lessons.** Currently all text. Video accelerates absorption but isn't required.
- **04.1 AI Operator quiz answer key.** Lesson is "recommended, not required" for Operator I. Not blocking.

---

## Missing assessments

### Critical

| Gap | Why it blocks | Latest acceptable resolution |
|---|---|---|
| **Pioneer Test grading rubric.** The Pioneer Test reflection is required evidence. The Constitution defines what the Pioneer Test *is*. There is no rubric for what "passes" the Pioneer Test reflection. Reviewers will calibrate by feel. | Reviewer disagreement on Pioneer Test reflection becomes the single hardest calibration discussion. | **End of Week 5.** Nick writes a 5-line rubric before evidence pack submission. (This is not new doctrine — it's an operational rubric derived from the Constitution.) |
| **Roleplay grading rubric per scenario.** Each lesson contains a Scenario A description. The "Trainer must verify the candidate did NOT fall into the trap named in each scenario" line in the framework is the only stated bar. There's no per-scenario rubric authored. | Blocks Week 3 Roleplay #1 evaluation. | **Day before each roleplay.** Nick (and Mike for Roleplay #2) reads the scenario in advance, lists the 3 trap moments specific to that scenario, and uses that list as the rubric. Captured in the cycle record. |
| **Self-rating form populated for the 34 competencies at the Operator I bar.** The [competency model](./00-academy-overview/02-competency-model.md) exists. There is no Operator-I-specific form pre-loaded with the bar lines from framework §2 ("level 1+ on all five Pillar 01 competencies, etc."). | Without a single sheet, April will guess at her self-rating. Reviewers can't compare apples to apples. | **End of Week 4.** Build a one-page spreadsheet (or markdown table) listing the 34 competencies with the Operator I bar in each row. April fills the right column. (Not new doctrine; a derivative artifact.) |

### Important

| Gap | Why it matters |
|---|---|
| **Quiz administration mechanism.** Paper? Form? Firebase? In-line in the lesson markdown? No decision made. | Affects whether quiz scores are auditable later. |
| **Per-lesson Q10 compression rubric for Operator I bar.** The Constitution mentions 90-second compression. Lessons have Q10. The framework says Operator II requires "Q10 pass on all 4 lessons." For Operator I the bar is softer: "Q10 pass on ONE topic." Which Q10? Pick at Intent meeting. | Without picking, April compresses everything weakly instead of compressing one thing brilliantly. |

### Nice to have

- **Quiz time limits.** No spec today. Add if April speeds through or stalls.
- **Quiz re-take policy.** Implicit (retake allowed if < 7/10). No formal cap on retakes. Probably fine for Cycle 1.

---

## Missing scorecards

### Critical

| Gap | Why it blocks | Latest acceptable resolution |
|---|---|---|
| **Operator I reviewer scorecard.** [`templates/scorecard.md`](./templates/scorecard.md) is generic. The framework §2 enumerates the Operator I bar across 9 categories (competencies, lessons, practical demos, portfolio evidence, business outcomes, roleplays, executive comms, Financial Pulse, cannot-do exclusions). There is no scorecard that takes those 9 categories and gives each reviewer a yes/no/score-with-evidence column. | Week 6 calibration meeting becomes chaotic because the 3 reviewers are scoring on different rubrics. | **Beginning of Week 5.** Convert framework §2 into a one-page scorecard (markdown table). Pre-share with Mike + Kirby Day 1 of Week 5. |

### Important

| Gap | Why it matters |
|---|---|
| **Calibration sheet.** A single document where the three scorecards collapse into one decision, including named disagreements + the resolution. Today there's nothing. | The decision artifact (the cycle record file) will need to show calibration; without a sheet it's reconstructed from memory. |

### Nice to have

- **Visual scorecard summary (RAG chart, traffic-light per category).** Reviewers can use prose. Not blocking.

---

## Missing evidence templates

### Critical

| Gap | Why it blocks | Latest acceptable resolution |
|---|---|---|
| **Operator I evidence pack index.** [`templates/certification-evidence-pack.md`](./templates/certification-evidence-pack.md) exists generically. No version is pre-filled with the 10 specific Operator I artifacts from framework §2 with placeholder fields ("link to recording 1, link to recording 2, …"). | April assembles evidence ad hoc in Week 5; reviewers find pieces missing or hidden. | **Week 4 Friday.** Nick writes the 10-row index. April fills it during Week 5 assembly. |
| **Vital Read recording template.** "Recorded" is the bar. Nothing specifies: format (mp4? Loom?), length cap, audio quality, what frames must appear, whether the customer's name can appear. | If April records inconsistently across 8 sessions, reviewers can't compare. | **Day 0.** State: Loom screencast, 15–25 min cap, audio on, customer name in title. Captured in Intent meeting notes. |
| **Loop entry log template.** No template exists for the Loop entry log. The framework just says "log." Loop entry needs: hypothesis, baseline, verification date, predicted outcome, actual outcome (after verification), honest closure note. | Without a template, April's Loop log won't be reviewer-readable. | **Day 0.** Build a 6-column table in markdown. Five rows for now (room for 3+ entries with overflow). |

### Important

| Gap | Why it matters |
|---|---|
| **Pillar 8 verification pause template.** The framework requires 1 documented pause. No template for what gets captured. | The pause is meaningful only if the captured artifact shows: signal observed → "wait, let me check the record" → record check → what was found → action taken (or not). |
| **Business outcome verification template.** Framework requires baseline → action → verification. No standard form. | Reviewers will struggle to compare April's outcome doc to the framework bar. |
| **Customer Economics analysis template.** Lesson 02.3 contains the methodology. No standalone analysis template pre-formatted (cost stack, revenue stack, RPLH, recommendation, customer-facing version vs. internal version). | April will produce an analysis but it may not match what reviewers expect. Half a day of rework. |

### Nice to have

- **Operational Feed event categorization template.** A 5-column sheet for the 20 events. Helpful but generic markdown table works.
- **Self-rating change log.** When April updates her self-rating between drafts, capture the diff. Not Cycle 1 critical.

---

## Missing reviewer workflows

### Critical

| Gap | Why it blocks | Latest acceptable resolution |
|---|---|---|
| **Reviewer onboarding kit for Mike + Kirby.** Neither has reviewed a certification before. They need: (a) the Operator I bar one-pager (this is the framework §2 content abridged), (b) the scorecard, (c) the expected time commitment (~10 hours each), (d) the Bootstrap Reviewer constraints (independent reads, no coordination, no advance discussion with the candidate). | If they show up Week 6 cold, calibration is a debate, not a calibration. | **Day 1 of Week 5.** Send them the kit when April submits the evidence pack. |
| **Lineage ID issuance workflow.** Framework defines the Lineage ID format (`POPS-OP-I-2026-001`). The registry exists but is empty. No documented workflow for: who reserves the ID, when, how is it written into `certification-registry.md`, who commits the change. | Without a workflow, on decision day the ID is invented inconsistently or forgotten. | **Day 0.** Reserve `POPS-OP-I-2026-001` in the registry with status "In Progress, April." (One-line edit. Not new doctrine.) |

### Important

| Gap | Why it matters |
|---|---|
| **Reviewer disagreement protocol.** What happens when Mike scores Pass, Kirby scores Conditional Pass, Nick scores Not Yet? The framework names Triple-Reviewer Safeguard but does not specify the tie-break. | Pre-decide: majority wins unless any reviewer cites a hard-fail condition, in which case lowest score wins. |
| **Reviewer conflict-of-interest disclosure.** Nick is candidate's employer + Academy Lead. Bootstrap reviewers may also have prior relationships. | Per Bootstrap clause, each reviewer notes their prior relationship to the candidate at top of scorecard. |

### Nice to have

- **Reviewer training video.** Onboarding kit text is fine for Cycle 1.
- **Calendar tool for scheduling reviewer reads.** Slack/calendar is fine.

---

## Missing automation

### Critical

(None. Cycle 1 is small enough to run manually. Automation gaps do not block this cycle.)

### Important

| Gap | Why it matters |
|---|---|
| **Link audit on commit (pre-commit hook).** Currently audit is manual via `/tmp/link_check.sh`. If reviewers add markdown docs during the cycle (scorecards, decision artifact), broken links can ship silently. | One-time cost: ~30 min to wire the existing script as a pre-commit hook. |

### Nice to have

- **Loop entry tracking via Firestore.** Manual markdown is fine for Cycle 1.
- **Quiz auto-grading.** Nick can grade manually.
- **Evidence pack auto-index.** Manual table is fine.
- **Reviewer notification system.** Email/Slack.
- **Lineage ID auto-issuance from registry on decision recording.** Manual edit is fine.
- **Vital Read recording auto-upload to storage.** Manual Loom links suffice.

---

## Critical summary — what must exist by what day

| Day | Critical artifact |
|---|---|
| **Day 0 (Friday 2026-06-12)** | Quiz answer key for at least 1 lesson · Operational Feed access verified for April · Vital Read recording standard stated · Loop entry log template drafted · Lineage ID reserved in registry |
| **End of Week 1** | Quiz answer keys for remaining 3 lessons · Constitution comprehension checkpoint scheduled |
| **Week 3 (before Roleplay #1)** | Per-scenario roleplay rubric written (3 trap moments listed) |
| **Week 4 Friday** | Operator I evidence pack index written · 34-competency self-rating sheet built |
| **End of Week 4** | Pioneer Test grading rubric (5 lines) drafted |
| **Day 1 of Week 5** | Operator I reviewer scorecard built · Reviewer onboarding kit sent to Mike + Kirby |

Eight critical items. **Total estimated build time: under 12 hours of Nick's work, distributed across the 6-week cycle.** No item requires more than 90 minutes; most take 15–30.

None of these are doctrine, lessons, philosophy, or new certification levels. They are derivative operational artifacts that take the existing frozen corpus and turn it into a runnable cycle.

---

## What this gap analysis is NOT

- **Not a backlog of new doctrine to author.** Every item above derives from the frozen corpus.
- **Not a roadmap for Operator II or III.** Those tiers have their own gaps; out of scope.
- **Not a plan for hiring an Academy Lead.** Nick runs Cycle 1; that's the Bootstrap clause.
- **Not a tooling project.** Automation gaps are all Nice to Have for Cycle 1. Run it manually. Automate after Cycle 2 if patterns repeat.
- **Not a list of curriculum holes.** The 4 foundation lessons are sufficient for Operator I. Future lessons are not required for Cycle 1.

---

## Operational summary

**Critical gaps: 11 items. Build time: ~12 hours across 6 weeks. Distributed so no week is overloaded.**

**Important gaps: 11 items.** Build only if Cycle 1 surfaces a real need. Most can stay deferred until Cycle 2 design.

**Nice-to-Have gaps: 13 items.** Defer entirely until at least one Operator has been certified. Building automation before knowing the manual flow is premature.

The Academy can produce a certified Operator I in 6 weeks with the existing corpus + the 11 critical derivative artifacts. **None of the 11 are doctrine.** All of them are filling-in-the-form work.

The launch plan is executable as-is. This analysis names the seams that need sewing as April moves through it.
