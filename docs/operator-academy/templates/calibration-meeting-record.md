---
doc_type: operational-meeting-record
status: active
created: 2026-06-11
governance_tier: 4
scope: structured record of the Week 6 calibration meeting that produces the cycle decision
applies_to: every certification cycle (Bootstrap + post-Bootstrap)
referenced_in: founder-pilot-plan.md §7, operator-i-reviewer-scorecard.md "Composite decision", bootstrap-reviewer-onboarding-kit.md §5
derived_from: operator-certification-framework.md §7 Step 4 + Bootstrap §7.5 (Triple-Reviewer Safeguard)
---

# Calibration Meeting Record

**The artifact that decides the cycle.** Three scorecards on one screen → one decision recorded here → Lineage ID issued or not.

**Duration:** 60 minutes hard cap. Discussions that need more time produce a Conditional Pass with named gaps, not a longer meeting.

**Filled by:** the Acting Academy Lead (or Academy Lead post-Bootstrap), in the meeting, on screen visible to all three reviewers.

---

## 1. Meeting metadata

| Field | Value |
|---|---|
| Cycle identifier | (e.g., Cycle 1 — Nick Kesseru — Operator I — Founder Pilot) |
| Candidate | |
| Target tier | Operator I / II / III / Executive Advisor |
| Meeting date | |
| Meeting start time | |
| Meeting end time | |
| Facilitator | (Acting Academy Lead — must NOT be the candidate's primary trainer) |
| Reviewers present | All 3 required for Bootstrap; ≥ 2 of 2 + Academy Lead post-Bootstrap |

## 2. Reviewer scorecards received

Each reviewer submits their independently-completed [scorecard](./operator-i-reviewer-scorecard.md) by 24 hours before this meeting. No coordination allowed before submission.

| Reviewer | Scorecard received? | Date submitted | COI form on file? |
|---|---|---|---|
| Reviewer 1 | Y / N | | Y / N |
| Reviewer 2 | Y / N | | Y / N |
| Reviewer 3 (Bootstrap only) | Y / N | | Y / N |

**If any "N":** the meeting does not proceed. Reschedule when complete.

## 3. Composite scorecard summary

Each reviewer states their overall decision and the single biggest evidence point that drove it. **5 minutes per reviewer. Hard cap.**

| Reviewer | Overall decision | Single biggest evidence point |
|---|---|---|
| Reviewer 1 | Pass / Conditional / Not Yet | |
| Reviewer 2 | Pass / Conditional / Not Yet | |
| Reviewer 3 | Pass / Conditional / Not Yet | |

## 4. Category-by-category disagreements

For each of the 9 scorecard categories, list any category where reviewers' scores differ.

**Discipline 5 from the onboarding kit applies:** each disagreement is named in one sentence. Resolved by re-reading evidence against the bar, not by debate. **No paragraphs. No relitigating evidence after the fact.**

| Category | Disagreement (1 sentence each) | Resolution |
|---|---|---|
| 1 · Competencies | | |
| 2 · Lessons | | |
| 3 · Practical demonstrations | | |
| 4 · Portfolio evidence | | |
| 5 · Business outcomes | | |
| 6 · Role-play assessments | | |
| 7 · Executive comms | | |
| 8 · Financial Pulse capabilities | | |
| 9 · Cannot-do exclusions | | |

## 5. Hard-fail flags

| Trigger | Cited by any reviewer? | Evidence ref |
|---|---|---|
| Any quiz < 7/10 AND no retake | Y / N | |
| Zero closed Loops | Y / N | |
| Customer Economics arithmetic fails Pillar 7 | Y / N | |
| No verified business outcome | Y / N | |
| Pioneer Test reflection fails the Pioneer Test | Y / N | |
| Fails 2 of 2 chosen roleplays | Y / N | |
| Any competency at level 0 | Y / N | |
| < 15 of 34 competencies at level 2+ | Y / N | |
| Cannot-do exclusion violation (over-reaching to higher-tier work) | Y / N | |

**If any hard-fail trigger is "Y" by any reviewer:** the cycle outcome is automatically at minimum Not Yet for that category. Final decision still applies the worst-of-three rule.

## 6. Composite decision

**The decision rule:** the final decision is the **worst** of the three reviewers' decisions, not the average. This is the Bootstrap Triple-Reviewer Safeguard.

| | |
|---|---|
| Worst reviewer decision | Pass / Conditional / Not Yet |
| **Composite cycle decision** | Pass / Conditional / Not Yet |

If hard-fail flags surfaced AND any reviewer cites them as binding: composite decision is Not Yet regardless of other scores.

### Decision details

**If Pass:**

| | |
|---|---|
| Lineage ID to issue | POPS-OP-{I/II/III/EA}-{YYYY}-{NNN} |
| Effective date | (date of this meeting) |
| Title change effective date | |
| Registry update committed by | (Acting Academy Lead) |
| Next renewal date | (= effective date + 1 year for Operator I/II, + 2 years for III/EA) |

**If Conditional Pass:**

| | |
|---|---|
| Named gaps (≤ 2) | 1. <br>2. |
| Remediation window | 14 days from this meeting (per [framework §7 Step 4](../operator-certification-framework.md)) |
| Remediation due date | |
| Re-review reviewer | Single reviewer (typically Academy Lead) re-reviews remediation; full panel does NOT reconvene |
| Lineage ID reserved at | (status: "Conditional Pass · pending remediation" until cleared) |

**If Not Yet:**

| | |
|---|---|
| Primary reason | (one sentence) |
| Remediation plan | (3 specific bars to clear) |
| Earliest re-test window | (4 weeks for Operator I, 8 weeks for higher tiers per framework §8) |
| Lineage ID status | Released back to pool (not consumed) |

## 7. Public Review trigger (Bootstrap only)

Per [framework §7.5 Safeguard 3](../operator-certification-framework.md), Bootstrap-phase certifications receive Public Review:

- [ ] Cycle record file authored within 48 hours of this meeting
- [ ] Cycle record file distributed to Pioneer leadership (internal-public review)
- [ ] 7-day review window opens on (date)
- [ ] No leadership-raised concerns by end of window OR concerns resolved
- [ ] Decision finalized after review window closes

**Post-Bootstrap:** skip §7. Decision is final at end of this meeting.

## 8. Framework v1.2 amendment candidates surfaced

This cycle is also a stress-test of the framework. Capture amendment candidates that surfaced during scoring or calibration. These feed the [framework amendment process](../operator-certification-framework.md).

| Amendment candidate | Why surfaced | Defer to Cycle 2 retro? |
|---|---|---|
| | | Y / N |
| | | Y / N |
| | | Y / N |

## 9. Meeting close

| | |
|---|---|
| Composite decision communicated to candidate by | (Acting Academy Lead delivers within 24 hours via [decision template](./certification-decision.md)) |
| Cycle record file location | `certification-cycles/cycle-{N}-{candidate}-{tier}.md` |
| Cycle record file due date | (within 48 hours of this meeting) |
| Reviewer COI forms attached to cycle record | Y / N |
| Reviewer scorecards attached to cycle record | Y / N |
| All artifacts archived | Y / N (per the archive workflow in [`cycle-operations.md`](../cycle-operations.md)) |

**Meeting record signed by:**

| | |
|---|---|
| Facilitator (Academy Lead) | |
| Date | |

---

## What this record is NOT

- **Not the cycle record.** That's a separate, fuller artifact (see [cycle-operations.md](../cycle-operations.md) workflow). This is the input.
- **Not the decision letter to the candidate.** That's [`certification-decision.md`](./certification-decision.md), filled separately by Academy Lead within 24 hours.
- **Not where disagreements get rehashed in detail.** Reviewers cited evidence in their independent scorecards. This meeting cites those scorecards, not new opinions.
