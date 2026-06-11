# The Financial Pulse Operating System

> **Product doctrine.** Not curriculum. Not a lesson. Not UI.
>
> This document specifies the operational system that produces the Financial Pulse — the analytical layer beneath Mission Control. It is the engineering and product team's reference for how the Six Operational Vitals get measured, when they trigger attention, what patterns they detect, and how they connect to the Academy's doctrine.
>
> **Authority:** [Academy Thesis](../operator-academy/ACADEMY-THESIS.md) Sections 8 + 11 (Economic Reality + Financial Pulse Framework), [Constitution v1.1](../operator-academy/CONSTITUTION.md) (Pillar 7 + The Six Operational Vitals), and the four foundation lessons ([RPLH](../operator-academy/02-cleaning-operations/02-revenue-per-labor-hour.md), [Customer Economics](../operator-academy/02-cleaning-operations/03-customer-economics.md), [QBR Delivery](../operator-academy/05-customer-success/03-qbr-delivery.md), [Mission Control Diagnostics](../operator-academy/03-pioneerops-platform-mastery/01-mission-control-diagnostics.md)).
>
> Where any specification below conflicts with the Thesis or Constitution, the governing doctrine wins. Where doctrine is silent, this document speaks.

---

## How to read this document

This document is for two audiences:

1. **The platform team** — engineers and product designers building the Financial Pulse layer. They need the metrics, thresholds, patterns, and architectural relationships specified precisely enough to implement.
2. **The Academy team** — trainers and operators who use the Financial Pulse output. They need to understand the thinking so they can teach customers to read it.

This is the *thinking* layer. UI, dashboards, schemas, API contracts, and code live downstream. Design the thinking first; everything else descends from it.

---

## 0. Foundational Claims

Before specifying the system, four claims that govern every choice below.

### Claim 1 — The Six Operational Vitals are the right abstraction

The Constitution names six vitals: Labor Efficiency, Margin Integrity, Revenue Quality & Leakage, Cash Conversion, Cost of Poor Quality, Operational Exposure.

These six are not arbitrary. They cover every place an operational business bleeds. A seventh vital does not exist that adds new signal; an eighth would be a re-cut of these six. The platform must commit to the six as the **complete top-level taxonomy** — and resist the engineering instinct to add more.

### Claim 2 — Trend is the vital, not the snapshot

A single number is not a vital. The TREND of that number is the vital. Financial Pulse must compute and surface trends as first-class data, not as a "click for chart" affordance buried under a number.

This is doctrine-load: per Constitution and Thesis, "trend over snapshot" is a reading standard. The system must encode that standard.

### Claim 3 — Every vital is upstream-traceable

Every vital reading must trace back to the field events that produced it, within 60 seconds, through Mission Control. If a CEO sees a vital change and cannot drill into the underlying records, the reading is not defensible. Pillar 8 fails.

This is non-negotiable. A vital that cannot be traced is a vital that cannot be acted on responsibly.

### Claim 4 — Financial Pulse is the financial expression of the Loop

Visibility → Measurement → Diagnosis → Action → Verification. Financial Pulse runs four of those five stages automatically. The CEO and Operator hold Action and Verification (judgment + signature). FP holds the rest.

This division of labor is structural. The platform automates the mechanical, the human holds the judgment. Any deviation requires explicit doctrine amendment.

---

## 1. The Six Vitals — Deep Specification

For each vital, this document specifies four things:

- **What it measures** (the operational reality)
- **Why it matters** (the consequence pattern)
- **The composite metrics that feed it**
- **The reading lens** (how an Operator interprets it)

The complete metric → threshold mappings live in Section 3 (the Threshold Library).

---

### Vital 1 — Labor Efficiency

#### What it measures

The ratio of paid labor time to productive (revenue-producing) labor time.

> *Of every labor dollar we spend, how much lands on revenue-producing work — and which direction is that trending?*

#### Why it matters

Labor is the dominant cost in cleaning operations (typically 35–55% of revenue). It leaks through clock drift, overstaffed shifts, unbudgeted overtime, travel waste, and rework hours. Most of this leakage is invisible at month-end finance. FP makes it visible weekly.

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| Clock-in compliance rate | `time_punches` | % of shifts where clock-in was within 5 min of scheduled |
| Clock-out compliance rate | `time_punches` | % of shifts where clock-out was within 5 min of scheduled |
| Paid : worked ratio | `pioneer_service_sessions` | paid_minutes ÷ work_minutes per session, then averaged |
| Overtime rate | Deputy + payroll | OT hours ÷ total hours per pay period |
| Travel + transition % | Implied gap analysis | Time between session ends and next session starts (per tech) |
| Re-clean hours rate | Inspections + DCR linkage | Hours logged on a re-clean ÷ total hours |
| Coverage waste | `service_assignments` vs scheduled | Scheduled hours not covered by actual labor (over-staff) |

#### Reading lens

A trained Operator reads Labor Efficiency as **money escaping the business through minutes**. The headline number is the company average paid:worked ratio; the diagnostic value is in the variance — which techs, which routes, which customers, which days.

#### Connects upstream to

Time-card capture quality (Pillar 8). If time-cards are entered late or imprecisely, Labor Efficiency cannot be trusted.

---

### Vital 2 — Margin Integrity

#### What it measures

Whether each unit of work — customer, route, account, contract — covers its direct costs with healthy margin.

> *Do we know which specific jobs, accounts, or crews make money and which lose it — or do we only know the blend?*

#### Why it matters

Company-level margin is an average. Averages hide cross-subsidy: profitable accounts quietly funding unprofitable ones. The two strongest customers in a portfolio often mask three bleeding ones. Margin Integrity exposes the per-customer truth.

This is the Customer Economics view, already partially implemented in PioneerOps.

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| RPLH per customer | QBO + `pioneer_service_sessions` | Revenue (30d) ÷ cleaning labor hours (30d) |
| Gross margin % per customer | QBO + sessions + supplies | (Revenue − direct labor − burden − supplies) ÷ revenue |
| Top 3 / Bottom 3 customers | RPLH sort | Highest and lowest RPLH across portfolio |
| Variance from quoted hours | `service_assignments` vs actual | Quoted (contracted) hours per customer vs actual hours logged |
| New customer margin trajectory | Customer Economics first 90 days | Margin of customers in their first 90 days vs portfolio average |
| Long-tenure customer drift | Customer Economics multi-year | Customers 24+ months without rate adjustment, flagged |

#### Reading lens

The Operator reads Margin Integrity through Top 3 / Bottom 3 first. The company average is the *least* actionable number. The bottom 3 with names attached is where decisions live.

#### Connects upstream to

Customer name resolution (QBO ↔ Pioneer slug matching), labor type filtering (cleaning only, per the Customer Economics spec), and minimum-hours noise filtering (10-hour threshold).

---

### Vital 3 — Revenue Quality & Leakage

#### What it measures

The gap between work performed and revenue captured, AND the durability of the revenue itself.

> *Is everything we do becoming revenue, and is that revenue recurring, defensible, and concentrated safely?*

#### Why it matters

Cleaning companies bleed through scope creep absorbed for free, change orders never billed, recurring contracts that drift below market, and customer concentration that hides single-point-of-failure risk. None of these show up in monthly revenue numbers — they show up two quarters later when a customer leaves or a margin re-pricing fails.

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| Recurring revenue base | QBO recurring invoices | Sum of recurring monthly invoices; the company's "floor" |
| Recurring base MoM delta | QBO over time | Month-over-month change in recurring base |
| Top-N customer concentration | QBO revenue aggregate | Top 5 customers as % of total revenue |
| One-off revenue % | QBO | One-off revenue ÷ total revenue (rising = recurring base eroding) |
| Scope-vs-billed delta (estimated) | Service hours vs contract scope | Customers showing 15%+ hours over contracted scope |
| Unbilled add-on rate | Manual + DCR signals | Add-ons performed without contract revision |

#### Reading lens

The Operator reads Revenue Quality through two questions: *Is the recurring base growing or shrinking?* and *Are we serving customers who think they're paying for less than they're getting?*

Recurring base shrinkage is the lagging indicator of past churn. Unbilled scope is the leading indicator of next quarter's margin compression.

#### Connects upstream to

QBO recurring transaction setup discipline (are recurring contracts actually marked recurring in QBO?). Contract scope being captured in PioneerOps service_assignments (currently incomplete).

---

### Vital 4 — Cash Conversion

#### What it measures

The time and friction between work completed and cash collected, AND the operational behaviors that govern that time.

> *How long does a finished job take to become money, and what operational behavior sets that clock?*

#### Why it matters

For cleaning companies, cash conversion is often governed operationally — by closeout speed, DCR completeness, and first-pass invoice acceptance. Long cash conversion silently constrains growth: payroll and supplies must run while invoices age. The vital can be a growth ceiling no one has named.

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| DSO (Days Sales Outstanding) | QBO | Weighted average days from invoice date to payment date |
| Closeout latency | DCR submission vs job completion | Days from job end to DCR submitted |
| Invoice latency | DCR vs invoice issued | Days from DCR submission to invoice issued |
| AR aging buckets | QBO | Current / 1-30 / 31-60 / 61-90 / 91+ as % of total |
| AR concentration | QBO | Top 3 customers as % of total AR |
| Cash on hand | QBO | Current bank + cash balance |
| Cash runway | Cash ÷ trailing-30d burn | Days of runway at current burn rate |

#### Reading lens

The Operator reads Cash Conversion as **a chain that starts in the field**. Long DSO is almost never a finance problem; it's a closeout-record problem (Pillar 8) producing slow invoicing.

The CEO reads Cash Conversion as a *survival vital* — runway, burn, and the rate at which work-done becomes money-received.

#### Connects upstream to

DCR submission discipline (Pillar 8 — work becoming the record). Invoice generation workflow speed. QBO sync freshness.

---

### Vital 5 — Cost of Poor Quality

#### What it measures

The total price of doing things twice — rework, callbacks, remobilization, penalties, credits, and quality-attributable churn.

> *What are we paying for work that didn't hold the first time — and where does it cluster?*

#### Why it matters

Cost of Poor Quality almost never appears as a line item on a P&L. It hides across labor, supplies, and customer service categories. That hiding is exactly why it persists. Operators surface it; finance never does.

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| Re-clean hours | DCR + assignments | Hours logged on re-cleans ÷ total hours |
| Complaint rate | Customer feedback + communication threads | Complaints ÷ active customer count, per period |
| Inspection failure rate | Inspection scoring | Inspections scored below threshold ÷ total inspections |
| Service credit dollars | QBO credit memos | Credits issued ÷ revenue per period |
| Quality-attributable churn | QBO + feedback | Customers who churned with documented quality issue in prior 90 days |
| Repeat callout rate | Operational feed | Customers requiring follow-up dispatch within 7 days of original service |

#### Reading lens

The Operator reads Cost of Poor Quality through clustering. Complaints clustering on one building means a site issue. Clustering on one tech means a coaching issue. Clustering on shift-turnover days means a handoff issue. The lens is always: *where does this concentrate?*

#### Connects upstream to

Inspection cadence + scoring discipline (Inspection v2.1). DCR completeness for problem-section reporting. Customer feedback channel quality.

---

### Vital 6 — Operational Exposure

#### What it measures

Quantified risk carried in gaps — uncaptured work, missing compliance records, undefendable disputes, audit vulnerability.

> *If we were challenged tomorrow — by a customer, an auditor, a regulator, an acquirer — what could we prove, and what would we have to argue?*

#### Why it matters

Operational Exposure is the vital most businesses cannot read at all because exposure is invisible until the dispute, audit, or claim arrives. By then it's too late. This is the vital where Pillar 8 (Work Becomes the Record) becomes financial.

For cleaning companies, exposure concentrates in:
- Healthcare and regulated industries (compliance audits)
- Buildings with insurance carriers as ultimate clients (claims defense)
- Long-tenure customers whose contracts haven't been revisited

#### Composite metrics

| Metric | Source | Definition |
|---|---|---|
| Inspection coverage % | Inspections by building, 60d window | % of buildings inspected in last 60 days |
| DCR submission rate | DCR vs assignments | DCRs submitted ÷ assignments completed |
| Photo capture rate | DCR photos | Average photos per DCR (DCRs with zero photos flagged) |
| Days since last inspection (per building) | Inspections | Max consecutive days a building has gone without an inspection record |
| Healthcare / regulated building coverage | Customer tier + inspection coverage | Coverage % for buildings flagged as healthcare/regulated |
| Compliance record completeness | DCR + inspections + photos | Composite score — % of required record types present per service |

#### Reading lens

The Operator reads Operational Exposure with one question: *Could we prove what we did?* The CEO reads it with a more specific question: *If our largest customer's risk officer asked for proof of work this week, what would we hand them?*

Operational Exposure is the vital that converts to dollars only at the moment of a dispute — but by then, the exposure number has compounded across years of uncaptured work.

#### Connects upstream to

Inspection scheduling discipline. DCR completion enforcement. Customer tier flagging (which accounts are regulated). Pillar 8 record discipline.

---

## 2. The Metric → Vital Map

For traceability, every metric the system computes must roll up to exactly one primary vital (with optional secondary contributions noted).

| Metric | Primary Vital | Secondary contribution |
|---|---|---|
| Clock-in compliance rate | Labor Efficiency | — |
| Paid:worked ratio | Labor Efficiency | — |
| Overtime rate | Labor Efficiency | Margin Integrity |
| Re-clean hours rate | Labor Efficiency | Cost of Poor Quality |
| Travel + transition % | Labor Efficiency | — |
| Coverage waste | Labor Efficiency | — |
| RPLH per customer | Margin Integrity | — |
| Gross margin per customer | Margin Integrity | — |
| Top 3 / Bottom 3 customers | Margin Integrity | — |
| Variance from quoted hours | Margin Integrity | Revenue Quality |
| New customer margin trajectory | Margin Integrity | — |
| Long-tenure customer drift | Margin Integrity | Revenue Quality |
| Recurring revenue base | Revenue Quality | — |
| Recurring base MoM delta | Revenue Quality | — |
| Top-N customer concentration | Revenue Quality | — |
| One-off revenue % | Revenue Quality | — |
| Scope-vs-billed delta | Revenue Quality | Margin Integrity |
| Unbilled add-on rate | Revenue Quality | Margin Integrity |
| DSO | Cash Conversion | — |
| Closeout latency | Cash Conversion | Operational Exposure |
| Invoice latency | Cash Conversion | — |
| AR aging buckets | Cash Conversion | — |
| AR concentration | Cash Conversion | Revenue Quality |
| Cash on hand / runway | Cash Conversion | — |
| Re-clean hours | Cost of Poor Quality | Labor Efficiency |
| Complaint rate | Cost of Poor Quality | — |
| Inspection failure rate | Cost of Poor Quality | Operational Exposure |
| Service credit dollars | Cost of Poor Quality | Revenue Quality |
| Quality-attributable churn | Cost of Poor Quality | Revenue Quality |
| Repeat callout rate | Cost of Poor Quality | — |
| Inspection coverage % | Operational Exposure | Cost of Poor Quality |
| DCR submission rate | Operational Exposure | Cash Conversion |
| Photo capture rate | Operational Exposure | — |
| Days since last inspection | Operational Exposure | — |
| Healthcare building coverage | Operational Exposure | — |
| Compliance record completeness | Operational Exposure | — |

**Architectural rule:** every metric in the system maps to exactly one row above. New metrics require an amendment to this table — including the primary vital they roll up to. Metrics that don't roll up cleanly are evidence the metric is wrong, not evidence we need a new vital.

---

## 3. The Threshold Library

For each metric, three thresholds: green (healthy), yellow (attention), red (action required).

Thresholds are **opinionated defaults**. Customers can adjust per their own context via `pioneer_config`. The defaults are calibrated for a mid-size commercial cleaning company; very large or very small companies will tune.

> **Critical principle:** thresholds are about *triggers*, not *targets*. A metric crossing yellow does not mean failure; it means *look*. Crossing red means *act*. The threshold is the prompt; the action is the human's.

### Labor Efficiency thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Clock-in compliance rate | ≥ 95% | 90–94% | < 90% |
| Clock-out compliance rate | ≥ 95% | 90–94% | < 90% |
| Paid:worked ratio (company avg) | ≤ 1.05 | 1.05–1.10 | > 1.10 |
| Overtime rate (period) | < 5% | 5–10% | > 10% |
| Travel + transition % (per tech) | < 12% | 12–18% | > 18% |
| Re-clean hours rate | < 2% | 2–5% | > 5% |
| Coverage waste (scheduled but unworked) | < 3% | 3–7% | > 7% |

### Margin Integrity thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| RPLH vs target (per customer) | ≥ target | target − $10 to target | > $10 below target |
| Gross margin per customer | > 45% | 35–45% | < 35% |
| Company avg RPLH vs target | ≥ target | target − $5 to target | > $5 below target |
| Variance from quoted hours | ≤ ±10% | ±10–20% | > ±20% |
| Long-tenure customer (24+ mo, no rate change) | < 10% of base | 10–20% | > 20% |

### Revenue Quality & Leakage thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Recurring base MoM delta | ≥ 0% | -2% to 0% | < -2% |
| Top 5 customer concentration | < 40% | 40–60% | > 60% |
| Top 1 customer concentration | < 15% | 15–25% | > 25% |
| One-off revenue % | < 15% | 15–25% | > 25% |
| Scope-vs-billed positive delta | < 5% of base | 5–10% | > 10% |
| Unbilled add-on rate | 0–2% | 2–5% | > 5% |

### Cash Conversion thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| DSO | < 30 days | 30–45 days | > 45 days |
| Closeout latency (DCR submission) | < 1 day | 1–3 days | > 3 days |
| Invoice latency (DCR → invoice) | < 3 days | 3–7 days | > 7 days |
| AR > 60 days (% of total AR) | < 5% | 5–10% | > 10% |
| AR > 90 days (% of total AR) | < 2% | 2–5% | > 5% |
| Cash runway | > 60 days | 30–60 days | < 30 days |
| AR concentration (top 3) | < 35% | 35–50% | > 50% |

### Cost of Poor Quality thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Re-clean hours rate | < 2% | 2–5% | > 5% |
| Complaint rate (per customer per month) | < 0.5 | 0.5–1.0 | > 1.0 |
| Inspection failure rate | < 5% | 5–15% | > 15% |
| Service credits (% of revenue) | < 1% | 1–3% | > 3% |
| Quality-attributable churn (trailing 90d) | 0 | 1 customer | 2+ customers |
| Repeat callout rate | < 2% | 2–5% | > 5% |

### Operational Exposure thresholds

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Inspection coverage (60d window) — general buildings | ≥ 90% | 80–90% | < 80% |
| Inspection coverage — healthcare/regulated | ≥ 95% | 90–95% | < 90% |
| DCR submission rate | ≥ 95% | 90–95% | < 90% |
| Photo capture rate (avg per DCR) | ≥ 3 | 1–2 | 0 |
| Days since last inspection — general | < 60 | 60–90 | > 90 |
| Days since last inspection — healthcare | < 30 | 30–45 | > 45 |
| Compliance record completeness score | > 95% | 90–95% | < 90% |

---

## 4. The Pattern Library

Patterns are higher-level signals the system detects automatically — not just threshold breaches but *correlations* and *trajectories* across metrics, vitals, or time.

Each pattern has:
- **Name** (operator-readable)
- **Trigger condition** (what the system detects)
- **Vital(s) affected**
- **Suggested diagnosis prompt** (the question to ask)
- **Suggested action class** (the kind of fix)

The pattern library is **opinionated, evolvable, and observable.** Patterns get added when field experience surfaces new ones. Patterns get removed if false-positive rates exceed signal value.

### Pattern Library v1

#### 1. Drift Catch

> **Trigger:** Any vital metric trending in the wrong direction for 3+ consecutive readings while still in the green zone.
>
> **Vitals:** Any
>
> **Diagnostic prompt:** "What changed in the last 21 days that would explain this drift?"
>
> **Action class:** Investigate before red. Lowest-cost intervention point.

#### 2. Threshold Breach

> **Trigger:** Any metric transitions green → yellow OR yellow → red since last reading.
>
> **Vitals:** Any
>
> **Diagnostic prompt:** "What event in the last reading window crossed this threshold?"
>
> **Action class:** Mandatory diagnosis at next read. If red, create Loop entry with verification date.

#### 3. Bottom-3 Bleed

> **Trigger:** Any customer's RPLH drops below break-even (effectively, more than $X below target where $X is company-specific) for 30+ days.
>
> **Vitals:** Margin Integrity
>
> **Diagnostic prompt:** "Why is this customer below cost? Scope creep, wage drift, or contract pricing?"
>
> **Action class:** Customer-specific intervention: rate increase, scope reduction, exit conversation.

#### 4. Concentration Risk

> **Trigger:** Top 1 customer > 20% of revenue OR top 3 > 50% of revenue.
>
> **Vitals:** Revenue Quality
>
> **Diagnostic prompt:** "What's the multi-year retention probability of these customers, and what happens if one leaves?"
>
> **Action class:** Strategic — diversification plan or formal acceptance of concentration.

#### 5. Scope Creep Detected

> **Trigger:** Customer's actual labor hours exceed quoted hours by 15%+ for 60+ days.
>
> **Vitals:** Revenue Quality (primary), Margin Integrity (secondary)
>
> **Diagnostic prompt:** "What additional scope has accumulated, and was it priced?"
>
> **Action class:** Customer conversation: scope audit + repricing.

#### 6. Cash Conversion Stretch

> **Trigger:** DSO increases by 5+ days over a 60-day window.
>
> **Vitals:** Cash Conversion
>
> **Diagnostic prompt:** "Are we invoicing slower, or are customers paying slower? Which customer dragged the average?"
>
> **Action class:** Process diagnosis (closeout discipline) + customer-specific collections.

#### 7. Closeout-to-Invoice Drift

> **Trigger:** Average days from DCR submission to invoice generation increases beyond yellow threshold for 30+ days.
>
> **Vitals:** Cash Conversion (primary), Operational Exposure (secondary)
>
> **Diagnostic prompt:** "Is the invoicing workflow broken, or is the DCR data not flowing cleanly into billing?"
>
> **Action class:** Process intervention. Cross-functional (ops + finance).

#### 8. Quality Cluster

> **Trigger:** Complaints clustering on a single building (3+ complaints in 30 days) OR single tech (3+ complaints in 30 days) OR shift type (2+ complaints clustering on shift-turnover days).
>
> **Vitals:** Cost of Poor Quality
>
> **Diagnostic prompt:** "What is the cause of the clustering? Site, person, or process?"
>
> **Action class:** Specific intervention based on cluster type.

#### 9. Healthcare Exposure Drift

> **Trigger:** Any healthcare or regulated building's inspection coverage drops below 90% in 60-day window.
>
> **Vitals:** Operational Exposure
>
> **Diagnostic prompt:** "What happened to the inspection schedule for this building?"
>
> **Action class:** Immediate — schedule inspection within 7 days. Healthcare gaps compound to compliance failures.

#### 10. Recurring Base Erosion

> **Trigger:** Recurring revenue base declines 2%+ MoM for 2+ consecutive months.
>
> **Vitals:** Revenue Quality
>
> **Diagnostic prompt:** "Which specific recurring contracts ended or downsized, and why?"
>
> **Action class:** Strategic — diagnose churn pattern; protect the base.

#### 11. Tech Reassignment Margin Impact

> **Trigger:** Customer's RPLH drops 10%+ within 30 days of a tech reassignment at that customer.
>
> **Vitals:** Margin Integrity (primary), Labor Efficiency (secondary)
>
> **Diagnostic prompt:** "Did the new tech inherit the productivity of the old, or is there a learning curve costing us margin?"
>
> **Action class:** Pair-shadowing to close productivity gap; reassign if no improvement in 60 days.

#### 12. Verification Overdue

> **Trigger:** A Loop entry's verification date has passed by 7+ days without an explicit verification result logged.
>
> **Vitals:** All (loop-level pattern)
>
> **Diagnostic prompt:** "Did the action work, or did we drop the verification?"
>
> **Action class:** Force closure: log the verification result (positive, negative, or "couldn't measure"). Never leave open.

#### 13. Cross-Vital Correlation

> **Trigger:** Two or more vitals move in the wrong direction in the same window, on the same customer or route.
>
> **Vitals:** Multi-vital
>
> **Diagnostic prompt:** "What single upstream event is moving both? Likely a shared root cause."
>
> **Action class:** Root cause investigation before treating either symptom.

#### 14. Pillar 8 Discontinuity

> **Trigger:** A vital reading shows a sharp single-period change (more than 3 standard deviations) that doesn't have a corresponding raw-event explanation in the underlying records.
>
> **Vitals:** Any
>
> **Diagnostic prompt:** "Is the record gap real (something happened we didn't capture) or is the metric calculation wrong?"
>
> **Action class:** Pause action. Verify record completeness BEFORE acting on the reading. If it's a calculation bug, fix it; if it's a record gap, address the capture upstream.

---

## 5. Reading Cadences

Different roles read the Financial Pulse at different cadences. The system must serve all three.

### Cadence 1 — Operator Weekly (Monday morning, 15–30 min per portfolio)

The Operator's portfolio review across all owned accounts.

**Purpose:** identify which accounts the Operator needs to pre-stage diagnoses for, before their customers do their own Vital Reads.

**Structure:**

| Section | Time | Focus |
|---|---|---|
| Cross-portfolio scan | 5 min | Any accounts with red on any vital? Any new yellow → red transitions? |
| Drift Catch review | 5 min | Any accounts trending wrong while still green? |
| Pattern library scan | 5 min | Any patterns triggered in the past week the Operator hasn't acknowledged? |
| Verification follow-up | 5 min | Any open Loop entries with verification dates this week? |
| Customer-by-customer flag | 5–10 min | For each red or yellow account: pre-stage the diagnosis the customer CEO might want to run |

**Output:** the Operator walks into each customer's Monday Vital Read having already done the pre-diagnosis. The customer's read becomes faster and sharper because the Operator showed up prepared.

**System obligation:** the platform should produce a one-page "Operator Monday Brief" per Operator, generated overnight Sunday → Monday morning, summarizing all of the above.

### Cadence 2 — Customer Owner Weekly (Monday morning, 5 min)

The customer CEO's Vital Read. Fully specified in the [Mission Control Diagnostics lesson](../operator-academy/03-pioneerops-platform-mastery/01-mission-control-diagnostics.md).

**Purpose:** catch deviations on the customer's own business in the same week they happen.

**Structure:**

| Time | Section | Cards |
|---|---|---|
| 0:00–1:00 | Cash | Cash on hand, runway days |
| 1:00–2:30 | Margin (Top 3 / Bottom 3) | RPLH per customer; gap to target |
| 2:30–3:30 | Exposure | Inspection coverage, especially healthcare |
| 3:30–4:30 | Operational Feed | Last 7 days of events |
| 4:30–5:00 | Loop closures | Did last week's verifications verify? |

**Output:** 0–3 Loop entries with named verification dates.

**System obligation:** Mission Control must surface the right cards in the right order, with the green/yellow/red signals computed and the trends visible. No customer should ever have to "figure out" how to do their Vital Read — the screen should structure it.

### Cadence 3 — CEO Monthly (45–60 min strategic review)

The slower, strategic financial conversation.

**Purpose:** make decisions at a scope larger than a single Loop entry. Customer mix evolution, pricing strategy, hiring, capital decisions.

**Structure:**

| Section | Time | Focus |
|---|---|---|
| All six vitals — 90-day trend | 15 min | Direction of every vital, not weekly noise. Where is the company heading? |
| Customer mix evolution | 10 min | New customers' margin profile vs portfolio average. Are we growing profitably? |
| Recurring base trajectory | 5 min | Recurring revenue MoM. Is the floor rising or falling? |
| Concentration risk | 5 min | Top 1 / Top 5. Mitigation plan if needed. |
| Operational Exposure strategic review | 10 min | Which buildings are most at risk? Which contracts need compliance re-audit? |
| Strategic decisions queue | 10 min | 1–3 strategic decisions the CEO will make this month: pricing change, customer exit, hiring, investment. |

**Output:** 1–3 strategic decisions made, each with verification at the next monthly review.

**System obligation:** the platform must compute and present 90-day trends across all six vitals, with the customer-level and route-level cuts CEO-level decisions require. The monthly review uses MORE data than the weekly read, not less — but presented at the same level of compression.

---

## 6. Mission Control + Financial Pulse — The Architectural Relationship

Mission Control is the **surface**. Financial Pulse is the **engine**.

This is not a UI distinction. It is a structural one with operational consequences.

### The division of responsibility

| Layer | Owns |
|---|---|
| **Field Reality** | The work happens. Captured per Pillar 8 (DCR, time-cards, inspections, photos). |
| **Raw Records** | PioneerOps tables (`pioneer_service_sessions`, `dcr_submissions`, `inspections`, etc.), QBO entities, Deputy shift cache. The substrate. |
| **Financial Pulse Engine** | Computes the Six Vitals from raw records. Detects patterns. Holds thresholds. Stages diagnostic prompts. Runs continuously; refreshes nightly + on-demand. |
| **Mission Control** | Presents the Financial Pulse state to humans in the right structure for the right cadence. Surfaces Loop entries, verification dates, action prompts. |
| **Human Action** | CEO + Operator close the Loop. Decisions get made, actions get taken. Verification gets logged back into the records. |
| **Loop closure** | Verification feeds the records, which feed the next FP computation, which surfaces the next read. The Loop closes. |

### The data flow

```
                  FIELD REALITY
                       │
                       │   (Pillar 8 — work becomes the record)
                       ▼
                   RAW RECORDS
   ┌───────────────────┴────────────────────────┐
   │  pioneer_service_sessions                  │
   │  dcr_submissions                           │
   │  inspections                               │
   │  time_punches                              │
   │  customer_aliases ← QBO Customers          │
   │  QBO Invoices / Bills / Accounts           │
   │  Deputy shift cache                        │
   └───────────────────┬────────────────────────┘
                       │
                       │   (daily sync at 07:00 PT,
                       │    + on-demand refresh)
                       ▼
            FINANCIAL PULSE ENGINE
   ┌───────────────────┴────────────────────────┐
   │                                            │
   │  Vital computation (six vitals)            │
   │           │                                │
   │           ▼                                │
   │  Threshold engine (green / yellow / red)   │
   │           │                                │
   │           ▼                                │
   │  Pattern detection (14 patterns v1)        │
   │           │                                │
   │           ▼                                │
   │  Diagnostic staging                        │
   │  (prompt + suggested action class)         │
   │                                            │
   └───────────────────┬────────────────────────┘
                       │
                       │   (read on demand by MC;
                       │    pushed for alerts)
                       ▼
                MISSION CONTROL
   ┌───────────────────┴────────────────────────┐
   │                                            │
   │  Per-cadence views:                        │
   │  - Customer Weekly Vital Read              │
   │  - Operator Monday Brief                   │
   │  - CEO Monthly Review                      │
   │                                            │
   │  Loop entry creation + tracking            │
   │  Verification date scheduling              │
   │                                            │
   └───────────────────┬────────────────────────┘
                       │
                       │   (CEO + Operator interact)
                       ▼
                  HUMAN ACTION
                       │
                       │   (action → verification → record)
                       ▼
                  RAW RECORDS UPDATED
                       │
                       └─────► cycle repeats
```

### Where FP ends and MC begins

The FP engine's job ends at "this vital is yellow, this pattern triggered, this diagnostic question should be asked, this action class is recommended."

MC's job is to take that staged output and present it to a human in the right cadence-specific structure, with the right level of compression. MC also receives back the human's decisions and writes Loop entries / verification dates / action records.

**Boundary rule:** FP does not "decide." MC does not "compute." Any logic that decides what to recommend lives in FP. Any logic that presents to humans lives in MC. If a piece of work could go either place, it goes in FP — the engine should be the single source of analytical truth.

### Why this separation matters

Three reasons:

1. **Testability.** FP can be tested independently of UI. The right vital + right threshold + right pattern can be unit-tested. Visual presentation is a separate problem.
2. **Evolvability.** New presentation surfaces (mobile, email digest, voice) can read from FP without re-implementing the analytical layer.
3. **Doctrine integrity.** The Six Vitals and pattern library are doctrine. They should live in code one place — the FP engine. Doctrine that lives in three UI implementations drifts.

---

## 7. What Mission Control Surfaces Automatically

The Operator and customer CEO should not have to *ask* for the most important signals. The system pushes them.

### Surfacing rules

| Signal | Surfacing rule |
|---|---|
| Any vital metric crossing green → yellow | Surfaced in next read; no alert |
| Any vital metric crossing yellow → red | Surfaced as a banner alert AND in next read |
| Any healthcare/regulated building dropping below 90% inspection coverage | Surfaced immediately as critical alert |
| Cash runway < 30 days | Surfaced immediately as critical alert |
| Any Drift Catch (3+ consecutive wrong-direction readings) | Surfaced in next read as "Drift Catch" callout |
| Any pattern-library trigger | Surfaced in next read with the named pattern + suggested diagnosis |
| Any open Loop entry past verification date | Surfaced in next read as "Verification Overdue" |
| Cross-vital correlation pattern | Surfaced in next read with the suggested root-cause investigation prompt |

### What should NOT be surfaced automatically

| Anti-signal | Why |
|---|---|
| Every metric change | Noise. The reading discipline is "look at what crossed a threshold," not "look at every wobble." |
| Per-tech micro-variance | Detail that belongs in the per-tech drill-down, not the executive read. |
| Forecasts or projections | FP shows what IS, not what might be. Projections belong in a separate strategic-planning surface (not v1 scope). |
| Aggregate metrics without trend | Per Foundational Claim 2: trend is the vital. A snapshot without trend should not appear on MC. |

---

## 8. The Operator Workflow

A day-in-the-life view of how the Operator uses Financial Pulse — concretely, with cadence.

### Sunday evening (automated)

Financial Pulse engine runs its weekly aggregation. Generates the Operator Monday Brief per Operator: portfolio-wide vital state, all triggered patterns, all open verifications due this week, all Drift Catches.

### Monday 7:30 AM

Operator opens the Monday Brief in their email or MC dashboard. **15–20 minutes:**

- Scans cross-portfolio vital state (5 min)
- Reviews triggered patterns (5 min)
- Notes verification dates landing this week (3 min)
- For each red or yellow account, mentally pre-stages the diagnostic question (5 min)

### Monday 8:00 AM — 11:00 AM

Operator joins (or observes) customer CEO Monday Vital Reads. **For each customer, ~10 min:**

- First 4 weeks of a new account: Operator leads the read
- Weeks 5–16: Operator observes, prompts only on Pillar 8 risks
- Week 16+: Operator on a 30-second check-in; customer runs the read solo

### Tuesday–Thursday

Operator works the Loop entries created Monday. **Per account, varies:**

- Calls customers about pattern triggers their CEO should diagnose
- Pulls underlying records when a Pillar 8 Discontinuity pattern triggers
- Drafts customer-specific recommendations for patterns the CEO should hear at next QBR

### Friday afternoon

Operator reviews the week. **30 minutes per Operator:**

- Did all verification dates from prior weeks get closed?
- Were there pattern triggers the Operator didn't act on?
- Calibrate the threshold library: any false positives that need tuning?

### Quarterly

Operator delivers QBRs. The QBR is the Loop closure across 90 days of Financial Pulse signal. Each QBR draws directly from the Financial Pulse history; no new analysis is needed beyond synthesis.

### The Operator's mental model

The Operator does **not** think of Financial Pulse as a dashboard. They think of it as their **standing intelligence layer**:

- Sunday: the brief is delivered
- Monday: the read uses the brief
- Tuesday–Thursday: the actions execute against the brief's signals
- Friday: the brief gets calibrated
- Quarterly: the brief becomes the QBR substrate

The pulse is always running. The Operator is always reading. The customer increasingly runs their own reads.

---

## 9. How Financial Pulse Becomes the Financial Expression of the Academy Doctrine

This is the philosophical heart of the system. Financial Pulse is not a feature. It is **the platform's commitment to Academy doctrine in working code.**

### Six doctrine connections

#### Connection 1 — Pillar 7 (Economic Reality) made mechanical

The Constitution names the four-link chain: Operational Event → Operational Metric → Financial Consequence → Business Outcome.

Financial Pulse automates the first three links. Operational events flow into the records (Pillar 8). The records compute into operational metrics. The metrics translate into financial consequences via threshold + pattern. Only the fourth link — Business Outcome — requires a human decision.

The system that makes the chain run on its own is the system that makes the chain *trustable*. Operators no longer have to argue the chain exists; FP makes it visible automatically.

#### Connection 2 — The Loop (Thesis Section 9) made operational

The six-stage Loop: Visibility → Measurement → Diagnosis → Action → Verification → Refinement.

Financial Pulse runs the first three stages on schedule. **Visibility** is the FP engine consuming records. **Measurement** is the vital computation. **Diagnosis** is the threshold + pattern engine staging the prompt.

Stages 4 + 5 (Action + Verification) are human. Stage 6 (Refinement) happens at QBR retrospectives and in the FP engine's own ongoing pattern-library tuning.

A platform that automates 3 of 6 Loop stages without automating Action or Verification is a platform that holds doctrine integrity. AI-deference fails Action. AI-refusal fails Visibility. The middle path is the doctrine, and the platform encodes it.

#### Connection 3 — The Six Vitals (Constitution) implemented

The Constitution names the Six Vitals as the complete top-level taxonomy. Financial Pulse implements them as the system's primary data structure. New metrics roll up to existing vitals. New vitals require Constitutional amendment.

This is **schema discipline derived from doctrine discipline**. The platform's data model reflects the institutional model. A change to one requires a change to the other.

#### Connection 4 — Pillar 8 (Work Becomes the Record) tested at financial scale

Every vital reading must be defensible against the underlying records. FP doesn't trust its own computation — it makes the underlying records auditable in under 60 seconds from any vital, via Mission Control's drill-down paths.

If FP can't trace, FP can't be trusted. The platform's commitment to Pillar 8 IS the platform's commitment to its own readings.

This is also why Pillar 8 Discontinuity is in the Pattern Library v1 — the system actively watches for cases where it can't explain its own movements, and flags them for human attention BEFORE recommending action.

#### Connection 5 — The Academy's diagnostician identity (Pillar 2) supported, not replaced

FP does not turn CEOs into "people who look at dashboards." It turns CEOs into people who **read vitals on a rhythm**, the way clinicians read patient vitals.

The platform actively supports the diagnostician identity:
- By bounding the read time (5 minutes — like rounds in a hospital)
- By structuring the scan (vital order, threshold triggers, named patterns)
- By forcing diagnosis-before-prescription (the staged diagnostic prompts come BEFORE the suggested action)
- By making the underlying records reachable in 60 seconds (verification supports diagnosis)

A platform that supports diagnostician identity is a platform that builds the profession the Academy is creating. Without FP, the Academy could teach the discipline but the platform would fight it. With FP, the platform IS the discipline.

#### Connection 6 — The customer becomes self-sustaining

The Mission Control Diagnostics lesson introduces the Operator Withdrawal Curve — the operator's planned reduction in routine involvement as the customer becomes self-sustaining.

FP enables this curve. A customer who can read their own vitals, with thresholds and patterns staged automatically, does not need the operator on the Monday call. The platform structures the read; the operator can withdraw to higher-value work.

Without FP, the operator IS the analytical layer. With FP, the operator is the strategic advisor on what the analytical layer surfaces. The role gets smaller and more valuable at the same time.

**This is the test of the platform.** A platform that makes the operator MORE necessary forever has failed Academy doctrine. A platform that makes the customer self-sustaining at the routine reads, freeing the operator for the strategic conversations, IS the doctrine in code.

### The unified statement

**Financial Pulse is the platform's commitment, in working code, to the Academy's claim that operational behavior is financially traceable, that the Loop is run faithfully, that the Six Vitals are the complete operational scoreboard, and that the operator's role is to make the customer self-sustaining at the diagnostic act.**

That is the philosophical center. Every architectural choice below it must support that statement, or be rejected.

---

## 10. Out of Scope for v1

To be honest about bounds — what this system intentionally does NOT do.

| Out of scope | Why |
|---|---|
| Forecasting / projection of vital trajectory | v1 shows what IS, not what MIGHT BE. Projection requires separate doctrine. |
| Automated action execution (auto-emails, auto-rate-changes) | Pillar 5 doctrine: AI does breadth, humans take action. The platform stages; it does not act. |
| Per-tech individual performance vitals | Adjacent product (workforce analytics). Operator can drill into per-tech detail from existing surfaces; FP rolls up at customer / route / portfolio levels. |
| Industry benchmarking against external companies | Adjacent product. Requires data sharing model not yet built. |
| Real-time streaming pulses (sub-daily) | Cadence doctrine: weekly is the Vital Read. Hourly pulse is panic, not diagnosis. |
| Custom vital creation per customer | The Six are the Six. Custom vitals are a v3+ conversation, with doctrine amendment first. |
| Predictive churn modeling | Adjacent product. Possibly v2; requires the recurring base data quality v1 produces. |
| Multi-company / multi-tenant aggregation views | Architecturally distinct system. Not in this doctrine's scope. |

---

## 11. Open Questions for the Build Phase

Questions whose answers are not yet locked, but need to be before implementation:

1. **Cadence latency tolerance.** How fresh must each vital be on the Monday read? Probably 24-hour-fresh is sufficient for most; cash + AR must be 1-hour-fresh. Tune.
2. **Customer-tier flagging mechanism.** Operational Exposure thresholds differ for healthcare vs general. Where does the customer tier live? Currently nowhere — needs a `customer_tier` schema decision.
3. **Photo capture rate threshold.** Set at "average 3 photos per DCR" but DCRs vary in expected photo count. Per-customer or per-building threshold needed.
4. **Pattern false-positive tolerance.** What's the acceptable false-positive rate per pattern before we tune or remove? 10% feels right; needs field data.
5. **Threshold customization UX.** Per-company override of threshold defaults — where does it live? `pioneer_config` documents have a precedent.
6. **Verification overdue escalation.** After 7 days overdue, what happens? Operator email? Manager escalation? Currently undefined.
7. **The Customer Economics card → Margin Integrity vital relationship.** Currently the Customer Economics card is a single feature. Does it become "the Margin Integrity surface" in v2? Architectural decision pending.
8. **Refinement stage support.** The Loop's sixth stage (Refinement) currently lives outside FP. Should FP capture refinement notes against patterns over time, building institutional intelligence (Compounding Intelligence per Constitution glossary)?

These questions are not blockers — v1 can ship with defaults and amend later. But they should be answered before the v1 ships, even if the answer is "default + amend at v1.1."

---

## 12. Amendment Process for This Document

This document is product doctrine. It evolves through the same standard as Constitution and Thesis amendments:

1. **Evidence first.** An amendment begins with verified field evidence — an operator or customer experience that surfaced a gap in the doctrine, not a feature request or a vendor preference.
2. **Diagnosed, not patched.** The failure is traced to the specific principle and the specific boundary of its application.
3. **Amended visibly.** Changes are written, dated, reasoned, and propagated. Old versions live in `archive/`.
4. **Verified after.** Amendments carry a prediction (what will change as a result) and a review date.

**Amendment authority:** product lead + Academy lead jointly. Neither alone. Where they disagree, the Thesis governs.

---

## Amendment Log

### v1 — 2026-06-11 · Initial doctrine

First publication of the Financial Pulse Operating System. Defines the Six Vitals at metric depth, the Threshold Library (v1 defaults), the Pattern Library (14 patterns), the three cadences, the MC + FP architectural relationship, the operator workflow, and the doctrinal connections to Academy v1.1.

**Predicted result:** the platform team can build the Financial Pulse v1 engine against this spec without recurring "what should this metric be?" or "what threshold do we use?" questions. The Academy team can teach customers to read the system without re-translating each time.

**Verification:** by Q4 2026, are there ≤3 unresolved doctrine-level questions blocking platform implementation? If yes, this document needs amendment.

---

> **Custodians:** PioneerOps platform lead + Academy lead.
>
> **Review cadence:** quarterly, OR upon any Constitution v1.X → v2.0 transition, whichever comes first.
>
> **Authority resolution:** Thesis > Constitution > Academy Gold Standard > this document. Where this document conflicts with senior doctrine, senior doctrine governs and this document is amended.
