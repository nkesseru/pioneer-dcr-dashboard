# 07 — Graduation Standards

What "graduated" means in tangible artifacts. Not opinions. Not vibes. Real outputs an external reviewer can examine and rate.

This is the integrity layer of the Academy. If we promote without these artifacts, the certification means nothing.

## The graduation portfolio

By Operator II certification, every operator must produce and submit a portfolio of seven artifacts. They become Pioneer's institutional record of what a graduated operator can do.

### Portfolio contents

1. **Implementation case study** (writeup)
2. **Recorded customer kickoff** (video, ~45 min)
3. **Recorded QBR delivery** (video, ~30 min)
4. **AI-assisted analytical artifact** (spreadsheet/report + prompt log)
5. **Executive briefing** (recorded, 15 min, to internal panel)
6. **Difficult-conversation transcript or recording** (real customer, anonymized)
7. **Customer health model** (model + writeup of how it's used)

Each artifact has an explicit rubric in [`templates/certification-rubric.md`](../templates/certification-rubric.md). Each is reviewed by the trainer plus one additional Senior Operator or leader.

---

## 1. Implementation Case Study

A written deliverable that documents one customer's full PioneerOps implementation — start to current state — and reflects on what worked, what didn't, and what the operator would do differently.

### Required structure

| Section | Content | Length |
|---|---|---|
| Customer summary | Industry, size, revenue band, why they bought | ½ page |
| Pre-Pioneer state | Workflow before PioneerOps, baseline metrics if available | 1 page |
| Implementation timeline | Week-by-week from contract to "live and adopting" | 1–2 pages |
| Decision log | 5–10 key decisions made during implementation + why | 1 page |
| Activation event achieved | When + how — be specific | ½ page |
| Current state metrics | Active users, customer NPS, health score, RPLH delta if measurable | 1 page |
| Three things that worked | Concrete, replicable | 1 page |
| Three things to do differently | Concrete, replicable | 1 page |
| Recommendations to the product team | What PioneerOps should change to help the next customer like this one | ½ page |

### Bar

- Real customer (not hypothetical)
- Real metrics (not made up)
- Real lessons (not generic CSM platitudes)
- Reviewer reads it and says "I would implement this differently than I did, based on this"

### Common failure modes

- ❌ Marketing-flavored "success story" — we want honest reflection
- ❌ All wins, no losses — every implementation has at least 3 things to do differently
- ❌ Vague metrics ("engagement increased") — show me the numbers

---

## 2. Recorded Customer Kickoff (video)

A real kickoff call for a real new customer, recorded with customer permission. Approximately 45 minutes.

### What we evaluate

| Dimension | Bar |
|---|---|
| Pre-call prep | Did the operator read the contract + sales handoff + customer industry context? Reviewer asks the operator what they knew going in. |
| Opening | Sets agenda. Establishes outcomes. Doesn't open with "thanks for taking the call." |
| Discovery | Real questions, not survey-style. Operator follows up on interesting answers. |
| Platform overview | Customer-specific, not feature tour. |
| Implementation plan | Concrete dates, concrete owners, concrete next call. |
| Question handling | Operator answers cleanly. When unsure, says so + commits to follow up by [date]. |
| Close | Operator gets the next-call calendar invite confirmed before hanging up. |

### Common failure modes

- ❌ Feature tour instead of outcome conversation
- ❌ Reading from a deck for 30 minutes
- ❌ Vague next steps ("we'll set up another call soon")
- ❌ Letting the customer drift into philosophy with no plan back

---

## 3. Recorded QBR Delivery (video)

A real Quarterly Business Review for a real customer. Approximately 30 minutes.

### What we evaluate

| Dimension | Bar |
|---|---|
| Data accuracy | Every number on the deck matches PioneerOps |
| Narrative arc | One story across the 30 minutes, not 12 unrelated stats |
| Three recommendations | Specific, prioritized, with effort estimate |
| Customer-CEO appropriateness | No jargon, no feature talk. Outcome language. |
| Pushback handling | When the customer disagrees, operator engages, doesn't fold |
| Time discipline | Lands the close in the allotted time |

### Bar for graduation

Either: deliver to a real customer CEO and get score ≥ 4/5 from reviewer.
Or: deliver to an internal CEO-equivalent panel and get score ≥ 4/5 from reviewer.

Real-customer delivery counts more — encourage operators to push for it.

---

## 4. AI-Assisted Analytical Artifact

A real analytical work product the operator built with AI assistance. Plus the prompt log showing how they got there.

### Examples that qualify

- A customer health model in a spreadsheet, populated with PioneerOps data, with predictive scoring
- A churn-risk analysis across the operator's owned accounts
- A pricing model for a specific customer's renewal
- A competitive analysis brief (Pioneer vs. another vendor for a specific prospect)
- A one-page operational diagnostic for a customer

### What we evaluate

| Dimension | Bar |
|---|---|
| Quality of output | The artifact would be useful to send to a customer or to Pioneer leadership |
| Prompt sophistication | Operator iterated; didn't take first AI output as-is |
| Edit discipline | Operator verified facts; AI errors caught and fixed |
| Time spent | Operator can tell us how long this would have taken without AI (≥ 3× faster is the target) |

### Submission format

- The artifact itself
- The prompt log (every prompt, every iteration)
- A 1-page writeup: what they built, what they learned, what AI was bad at

---

## 5. Executive Briefing (recorded, 15 min)

The operator delivers a 15-minute briefing to an internal panel playing the role of a customer CEO + senior team.

### Brief topic options (operator picks one)

- "Here's how to think about your Revenue Per Labor Hour over the next 12 months"
- "Three structural changes to your operation that PioneerOps unlocks"
- "Why your current AR aging tells me something about your sales process"
- "The labor market is shifting; here's what it means for your business"
- "Your customer concentration risk and how to dilute it"

### What we evaluate

| Dimension | Bar |
|---|---|
| Strategic framing | Not feature-pitch. CEO-level thinking. |
| Numbers | Real (from PioneerOps or industry benchmarks) |
| Recommendations | 3 specific, prioritized, with ROI math |
| Q&A | Hostile-but-fair questions handled cleanly |
| Time discipline | 15 minutes, not 14 or 17 |

This is the artifact that most often catches under-cooked operators. Practice in skill drills. Don't ship until ready.

---

## 6. Difficult-Conversation Recording or Transcript

A real customer interaction where something hard had to happen. Examples:

- Price increase delivered
- Service failure owned (without throwing field team under bus)
- Churn-risk save attempted
- Contract pushback (customer wants out)
- Performance issue with the customer's side (they're not using the product)

### What we evaluate

| Dimension | Bar |
|---|---|
| Truthfulness | Operator told the truth, including unflattering parts |
| Empathy | Operator acknowledged the customer's position |
| Stance | Operator held a position, didn't fold to keep the customer happy |
| Forward path | Conversation ended with a concrete next step |

Anonymize the customer if submitting transcript. Audio with customer permission is best.

---

## 7. Customer Health Model

The operator's actual model for scoring their accounts' health. Used weekly in pipeline review.

### Required components

- The model itself (spreadsheet, Notion, doc — operator's tool of choice)
- Documentation of:
  - Inputs (which signals from PioneerOps + which qualitative observations)
  - Weightings (and why)
  - Score-to-action mapping (score < X → what we do)
- One example of the model catching a real signal that drove a real action
- One example of the model being wrong, and what the operator learned

### Bar

- The model is being used (not built for graduation theatre)
- The operator can defend every weighting
- The operator has updated the model at least twice since first building it

---

## Submission

All seven artifacts submitted in a single folder shared with:

- Trainer
- One Senior Operator or leader (independent reviewer)
- Nick (read-only)

### Review process

1. Each reviewer rates against the rubric (in `templates/certification-rubric.md`)
2. Reviewers convene; resolve any score disagreements
3. Joint decision: pass, conditional pass (specific gaps to close in 30 days), or fail
4. Written feedback delivered to operator with concrete next steps

### Conditional pass

If 6 of 7 artifacts pass but one is weak: operator gets 30 days to redo the weak one. Operator II status grants on resubmission. Common case; not a stigma.

### Fail

If 2+ artifacts are weak: extend training 30–60 days. Specific remediation plan. Re-test.

Two consecutive fails = role-fit conversation.

---

## What happens to the portfolio after graduation

Kept in the Academy archive. Future operators read past portfolios as part of their own training. Anonymize customer names if required.

The best portfolios become recommended reading for the next class. This is one of the ways the Academy gets better every year.

---

Continue to [08 — How This Supports Customer Success](./08-customer-success-connection.md).
