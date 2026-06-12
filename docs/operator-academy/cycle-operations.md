---
doc_type: operational-workflows
status: active
created: 2026-06-11
governance_tier: 3
scope: procedural workflows that operate the Academy end-to-end
applies_to: every cycle, every tier
derived_from: operator-certification-framework.md §7, §8, §9, §12 + Bootstrap §7.5
---

# Cycle Operations Workflows

The procedures that connect the Academy's templates into a runnable system. Each workflow below has explicit steps, owners, and outputs. Together they ensure a cycle can complete end-to-end without tribal knowledge.

**Scope:** operational only. No new doctrine. No new bars. Each workflow operationalizes a process already implied by the [framework](./operator-certification-framework.md) — these are the *how*, not the *what*.

---

## Workflow 1 — Evidence pack submission

**When:** Friday of Week 5.
**Owner:** Candidate.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Candidate fills the [evidence pack index](./templates/operator-i-evidence-pack-index.md) with all 10 rows pointing to real artifacts. | Candidate | Filled index |
| 2 | Candidate places the index + all 10 artifacts in a single shared folder named `cycle-{N}-evidence-{candidate-slug}/`. Folder is reviewer-readable (anyone with the link can view; no individual ACLs). | Candidate | Shared folder |
| 3 | Candidate sends the folder link + the filled index to the Acting Academy Lead with the subject line: `Evidence Pack Submission — Cycle {N} — {candidate name} — Operator {tier}`. | Candidate | Submission message |
| 4 | Candidate marks the apprentice tracker with submission date and time. | Candidate | Tracker updated |

**No partial submissions.** Submission means all 10 evidence pack rows have links. If any row is unfilled, the cycle is paused until the row is complete — the cycle clock keeps running (does not extend the 6-week schedule).

---

## Workflow 2 — Evidence pack intake

**When:** within 24 hours of submission.
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Open the submission message + folder link. Verify access works. | Academy Lead | Confirmation reply |
| 2 | Walk the [evidence pack index](./templates/operator-i-evidence-pack-index.md). For each row, click the link. Mark Y/N/Missing in the verified column. | Academy Lead | Intake-verified index |
| 3 | Apply intake disqualification rules: < 8 of 10 rows linked, any Vital Read unviewable, zero closed Loops, CE math invisible. If any apply, raise to candidate immediately. Candidate has 7-day re-submission window. | Academy Lead | Intake report |
| 4 | If intake passes, send the **evidence pack** + the **intake-verified index** + the **[reviewer scorecard](./templates/operator-i-reviewer-scorecard.md)** + the **[onboarding kit](./templates/bootstrap-reviewer-onboarding-kit.md)** to all three reviewers. Subject line: `Cycle {N} Evidence Pack — Independent Review Begins {date}`. | Academy Lead | Reviewer kickoff message |
| 5 | Confirm each reviewer's [COI form](./templates/reviewer-acceptance-coi-disclosure.md) is on file. If any are missing, raise immediately. | Academy Lead | COI confirmation |

**Reviewer independence preserved:** the three reviewers receive the materials simultaneously. No reviewer receives early access. No reviewer is told what the other reviewers think.

---

## Workflow 3 — Reviewer scorecard collection

**When:** by end of Week 5.
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Each reviewer fills their [scorecard](./templates/operator-i-reviewer-scorecard.md) independently. **No reviewer-to-reviewer contact about scoring until all three are submitted.** | Each reviewer | 3 independent scorecards |
| 2 | Each reviewer sends their completed scorecard to the Academy Lead **only**. Subject line: `Reviewer Scorecard — Cycle {N} — {reviewer name}`. | Each reviewer | Submission message |
| 3 | Academy Lead acknowledges receipt and stores each scorecard in `certification-cycles/cycle-{N}-scorecards/`. **Does not share scorecards with other reviewers yet.** | Academy Lead | Stored scorecards |
| 4 | When all three are received, Academy Lead schedules the calibration meeting for Week 6 Thursday (or sooner if all parties are available). 60-minute hard cap. | Academy Lead | Meeting scheduled |
| 5 | 24 hours before the meeting, Academy Lead sends all three scorecards to all three reviewers simultaneously. Reviewers may review the others' scorecards before the meeting; reviewers may NOT discuss with each other before the meeting. | Academy Lead | Pre-meeting distribution |

**If a reviewer's scorecard is late:** the Academy Lead pings them. If still not received within 48 hours of the calibration meeting, the meeting is rescheduled. **Do not run calibration with 2 scorecards. The Triple-Reviewer Safeguard is not optional.**

---

## Workflow 4 — Calibration meeting facilitation

**When:** Week 6 Thursday. 60 minutes.
**Owner:** Acting Academy Lead (facilitator).

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Academy Lead opens the [calibration meeting record](./templates/calibration-meeting-record.md) on screen. Confirms all three scorecards + all three COI forms are attached. | Academy Lead | Meeting opened |
| 2 | Each reviewer states overall decision + single biggest evidence point. 5 minutes each. **Hard cap.** | Reviewers | Reviewer statements logged in §3 |
| 3 | Academy Lead walks each of the 9 scorecard categories. For any category with disagreement, the disagreeing reviewer names the disagreement in **one sentence**. Other reviewers respond in **one sentence**. No paragraphs. | All reviewers | §4 disagreements logged |
| 4 | Academy Lead surfaces hard-fail flags from §5 of the meeting record. Any "Y" by any reviewer triggers automatic Not Yet for that category. | All reviewers | §5 hard-fail flags |
| 5 | Composite decision applied: **worst of three** is the cycle decision. Hard-fail flags override. | All reviewers | §6 composite decision |
| 6 | Academy Lead records decision details (Pass → Lineage ID; Conditional → named gaps + remediation; Not Yet → reason + 3 bars). | Academy Lead | §6 decision details |
| 7 | For Bootstrap cycles: Academy Lead confirms Public Review trigger (§7). For post-Bootstrap: skip. | Academy Lead | §7 logged |
| 8 | Academy Lead captures Framework v1.2 amendment candidates surfaced (§8). | All | §8 logged |
| 9 | Academy Lead closes the meeting with §9 (decision delivery commitment, cycle record file due date, archive confirmation). | Academy Lead | §9 logged |
| 10 | Academy Lead signs the record. Meeting ends. | Academy Lead | Signed record |

**The 60-minute cap is the discipline.** Discussions that exceed the cap convert open questions into Conditional Pass named gaps. The calibration meeting is not where evidence gets re-evaluated; that's what the independent scorecards were for.

---

## Workflow 5 — Lineage ID issuance (Pass case)

**When:** within 24 hours of calibration meeting.
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Academy Lead opens [certification-registry.md](./certification-registry.md). | Academy Lead | Open registry |
| 2 | Locate the reserved Lineage ID (e.g., `POPS-OP-I-2026-001`) — should already be present with status `In Progress`. | Academy Lead | Located ID row |
| 3 | Update the row's status to `Certified · effective {date}`. Add cycle record file path. Add next renewal date (effective + 1 year for Operator I/II, + 2 years for III/EA per [framework §8](./operator-certification-framework.md)). | Academy Lead | Updated row |
| 4 | Commit the registry update with message: `cert(registry): issue {Lineage-ID} to {candidate} ({tier})`. | Academy Lead | Registry commit |
| 5 | Push the commit. The credential is now publicly recorded. | Academy Lead | Pushed |
| 6 | Update the cycle record file §1 with Lineage ID issued and §8 with the issuance commit hash. | Academy Lead | Cycle record updated |
| 7 | Send [certification decision letter](./templates/certification-decision.md) to candidate with subject line: `Operator Certification Decision — Cycle {N} — Pass — Lineage ID {ID}`. | Academy Lead | Decision delivered |

**Conditional Pass case:** registry status is `Conditional Pass · pending remediation through {date}`. Lineage ID is reserved but NOT issued. Steps 3–5 wait until remediation clears. Steps 6–7 still happen with the Conditional decision letter.

**Not Yet case:** Lineage ID is **released back to the pool**. Next cycle reserves the next sequential ID. Registry row deleted or marked `Released — not consumed`. Decision letter delivered with three bars to clear.

---

## Workflow 6 — Decision delivery

**When:** within 24 hours of the calibration meeting (all three outcomes).
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Open [certification-decision.md](./templates/certification-decision.md). | Academy Lead | Open template |
| 2 | Fill the decision letter with: candidate name, cycle ID, tier, decision, written feedback (1 page minimum per framework §7 Step 5), reviewer ratings (all three for Bootstrap), Pioneer Test outcome, specific bars cleared / specific bars to clear, next renewal date (if Pass) or re-test window (if not Pass). | Academy Lead | Filled letter |
| 3 | Send the letter to the candidate as a standalone artifact (not a chat message; a real document they can re-read). | Academy Lead | Delivered |
| 4 | Schedule a 30-minute conversation with the candidate to walk through the decision in person within 7 days. | Academy Lead | Conversation scheduled |
| 5 | Append the decision letter to the cycle record file §8. | Academy Lead | Cycle record updated |

**The candidate's right of re-review** (framework §7 Step 5): the candidate has 14 days to request a single re-review by an additional senior reviewer. Re-reviews require new evidence; they are not appeals based on disagreement alone.

---

## Workflow 7 — Public Review (Bootstrap only)

**When:** within 48 hours of calibration meeting.
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Finalize the cycle record file (template at [`templates/cycle-record.md`](./templates/cycle-record.md)) at `certification-cycles/cycle-{N}-{candidate}-{tier}.md`. | Academy Lead | Cycle record file |
| 2 | Distribute the cycle record file to Pioneer leadership (internal-public). Suggested distribution list: executives, board (if any), advisor circle. | Academy Lead | Distribution message |
| 3 | Set a 7-day review window. Notify candidate that decision is provisional until the window closes. | Academy Lead | Window opens |
| 4 | Collect any concerns raised by leadership. Most cycles surface zero concerns. For any raised, the Academy Lead writes a 1-paragraph resolution memo appended to the cycle record. | Academy Lead | Concerns + resolutions |
| 5 | After the 7-day window closes, finalize the decision in registry + cycle record. | Academy Lead | Decision final |

**Sunset condition** (per [framework §7.5](./operator-certification-framework.md)): Public Review ends for a tier when 3 Operators are certified at that tier. After sunset, this workflow is skipped.

---

## Workflow 8 — Archive

**When:** within 30 days of cycle decision.
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Confirm all artifacts referenced in the cycle record exist and are linkable. | Academy Lead | Verified |
| 2 | Move all evidence pack files (recordings, analyses, logs) to `certification-cycles/cycle-{N}-archive/` (the durable archive). The shared folder used during submission may be removed. | Academy Lead | Archive folder |
| 3 | Attach all reviewer scorecards + COI forms + calibration meeting record to the cycle record file (as appended sections or links). | Academy Lead | Attached |
| 4 | Mark the cycle record file as **read-only** by appending the line: `<!-- ARCHIVE LOCKED: {date} -->` at top. Subsequent corrections require a v1.1 addendum, not edits. | Academy Lead | Locked |
| 5 | Commit the archive with message: `cert(archive): cycle {N} {candidate} {tier} archived`. Push. | Academy Lead | Archived |
| 6 | Update [certification-registry.md](./certification-registry.md) row with archive path. | Academy Lead | Registry final |

**Retention:** Vital Read recordings retained 7 years. All written artifacts retained indefinitely.

---

## Workflow 9 — Renewal trigger (for already-certified Operators)

**When:** 60 days before renewal due date.
**Owner:** Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Academy Lead reviews [certification-registry.md](./certification-registry.md) at the start of each quarter. Identifies all Operators with renewal due in the next 90 days. | Academy Lead | Renewal list |
| 2 | For each, send a renewal notice 60 days before due date. Include [renewal evidence template](./templates/certification-renewal-evidence.md). | Academy Lead | Notices sent |
| 3 | Operator submits renewal evidence ≥ 14 days before due date. | Operator | Submitted |
| 4 | Academy Lead reviews renewal evidence against the tier's renewal bar (per [framework §8](./operator-certification-framework.md)). | Academy Lead | Renewal decision |
| 5 | Renewal decisions: renewed for one cycle, renewed with conditions, demoted (separate workflow), revoked. | Academy Lead | Updated registry |

**Operator I + II renew annually. Operator III + Executive Advisor renew biennially.** Renewal evidence is smaller than initial certification — focused proof the bar has been maintained.

---

## Workflow 10 — Demotion (rare, framework §9)

**When:** when an Operator's recent work falls below tier bar AND remediation has not closed the gap.
**Owner:** Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Academy Lead identifies a tier-bar concern (e.g., closed Loop rate has dropped, customer outcomes have degraded, Pillar 8 violations have occurred). | Academy Lead | Concern memo |
| 2 | Academy Lead sends a private 30-day improvement notice with specific bars to clear. Not yet a demotion. | Academy Lead | Notice sent |
| 3 | After 30 days, Academy Lead re-reviews. If bars clear: notice closes. If not: proceed. | Academy Lead | Re-review record |
| 4 | Academy Lead fills [certification-demotion-notice.md](./templates/certification-demotion-notice.md). | Academy Lead | Demotion notice |
| 5 | Demotion is delivered in a private conversation. Demotee may request a single 14-day appeal. | Academy Lead | Conversation + appeal window |
| 6 | After appeal window: registry updated with demoted tier. Demotee may pursue re-certification after the standard re-test window. | Academy Lead | Registry updated |

**Demotion is rare. It is also non-negotiable when warranted.** The demotion form's purpose is to ensure the decision is documented, defensible, and proceeds with dignity — see framework §9.

---

## Workflow 11 — Feedback capture (post-cycle)

**When:** within 14 days of cycle decision (Pass, Conditional, or Not Yet).
**Owner:** Acting Academy Lead.

| # | Step | Owner | Output |
|---|---|---|---|
| 1 | Academy Lead conducts a 30-minute feedback conversation with each reviewer (separately). 3 questions: what surprised you, what was unclear, what would you change? | Academy Lead | Reviewer feedback notes |
| 2 | Academy Lead conducts a 30-minute feedback conversation with the candidate. Same 3 questions, plus: what would have helped you most? | Academy Lead | Candidate feedback notes |
| 3 | Academy Lead writes a 1-page cycle retro and appends to the cycle record (§12–§14). | Academy Lead | Retro appended |
| 4 | Framework v1.2 amendment candidates surfaced are added to a running `framework-amendments-backlog.md` (created if first time). Amendments are NOT implemented during live cycles. | Academy Lead | Backlog updated |
| 5 | The retro is shared with Pioneer leadership (Bootstrap) or with the next cycle's reviewer pool (post-Bootstrap). | Academy Lead | Distribution |

**Feedback is not a satisfaction survey.** It's evidence for the Academy's evolution. The Academy gets better cycle by cycle because feedback is captured, named, and acted on at framework-revision time.

---

## What these workflows are NOT

- **Not new doctrine.** Every workflow operationalizes a process already in the [framework](./operator-certification-framework.md).
- **Not optional.** A cycle that skips a workflow is a cycle without an audit trail.
- **Not the candidate's responsibility (mostly).** Workflows 1 is the candidate's. Workflows 2–11 are Academy Lead's. Reviewer responsibilities are in the [onboarding kit](./templates/bootstrap-reviewer-onboarding-kit.md).
- **Not Operator-I-specific.** Tier-specific bars apply, but the workflows are tier-agnostic.

If a cycle hits a situation that no workflow above covers: the Academy Lead documents the new pattern, runs it manually, and proposes a Workflow 12+ for the next framework revision. **Do not invent doctrine to fill a workflow gap during a live cycle.**
