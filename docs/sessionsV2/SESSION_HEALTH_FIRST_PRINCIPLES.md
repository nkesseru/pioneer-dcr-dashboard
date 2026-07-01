# Session Health — First Principles Design

**Status (2026-07-01)**: DESIGN PROPOSAL. Architecture-only, no implementation. Phase 37A candidate.

**Governed by** [`OPERATION_ONE_TRUTH.md`](./OPERATION_ONE_TRUTH.md) (Constitution v1.0).
**Feeds into** [`MISSION_CONTROL_V2_FIRST_PRINCIPLES.md`](./MISSION_CONTROL_V2_FIRST_PRINCIPLES.md) — Mission Control becomes a projection of Session Health.

> The Session is the truth.
> Session Health is the question the operator asks of that truth.
> Recovery is the answer.

The office should never again investigate multiple collections to answer "what does this Session still need?" One Session, one Health state, one Recovery path.

---

## Preamble — the exercise

Mission Control V2 is paused. Before we build the dashboard, we must define the object the dashboard displays. That object is `SessionHealth` — the pure derivation of "what does this Session still need?" from the Session document itself (with narrow, opt-in cross-Session context).

This doc defines the object model. Implementation is the next slice.

---

## Part I — The Question

Every operational question at Pioneer maps to Session Health:

| Persona | Their morning question | Session Health answer |
|---|---|---|
| Kirby (payroll) | Can I approve payroll for this Session? | `payroll_readiness.state` |
| April (customer) | Is the customer served? | `customer_readiness.state` |
| Nicholas H (dispatch) | Is this Session on track? | `session_readiness.state` + `integrity` |
| On-call (push) | Is this Session stuck? | `integrity == "stalled"` |
| Auditor (later) | What happened here? | Session `timeline` + frozen Health snapshots |

Five personas, one Session, one Health function. **Health is the single lens through which every operator reads the Session.** No persona uses a different vocabulary; each looks at a different field of the same object.

---

## Part II — First principles

### P1. Session Health is derived, never stored

The Session already holds every fact needed to answer "what does this Session still need?" Storing Health as a flat field creates a duplicate source of truth that will drift the first time a trigger drops a write. Health is computed at read time.

This diverges from prior proposals (MC V2 arch doc's `session.integrity` flat field). The pushback stands: Constitution Rule 3 says projections never own data, and Health is a projection.

### P2. Health is a structured object, not a percentage

A single "completion pct" collapses multiple independent readiness axes into a scalar and loses information the operator needs. A Session can be 100% component-complete but payroll-blocked, or 60% component-complete and safely payroll-approvable (labor is clean, DCR is recovery work per Payroll Gate V2). The percentage lies.

Session Health has **three independent readiness axes** — session, payroll, customer — plus recovery. Any collapse is a display convenience, not a truth.

### P3. Required vs Optional is a Session-type question

The Session's `expected_components` field enumerates *required*. Everything else is *optional*: still tracked, still displays, but never blocks. This maps to Session type:
- `office_cleaning` → 7 required components (clock, gps, photos, checklist, dcr, customer_email, payroll)
- `supply_delivery` → 3 required (clock, gps, payroll)
- `admin_manual_recovery` → 2 required (clock, payroll)

Optional components (`supplies`, `problem`, and situationally `customer_email` when customer opts out) contribute to warnings but never to blockers.

### P4. Blockers must be Recoverable

Every blocker in the Health output carries a recommended recovery verb. If we can't say what to do about a blocker, either the design of the blocker is wrong or the Recovery verb set is incomplete. In practice, the 5-verb set (Notify / Resume / Recover / Supersede / Archive from MC V2 §VIII) covers every blocker we've seen.

### P5. Warnings are for the operator, not the system

The system doesn't "clear" warnings. The operator looks and decides. Warnings surface facts that MAY matter — the operator's judgment turns them into action or dismissal.

### P6. Health knows nothing about UI

The Health function returns structured data. Rendering — cards, tiles, colors, sort order — is a downstream concern. This lets multiple UIs (Mission Control V2, MC-mobile, on-call push, customer-facing status) all read the same Health object and render differently.

### P7. Cross-Session context is opt-in

Some operator questions require looking at OTHER Sessions ("Is Bonnie currently on another job?"). Session Health accepts an optional `cross_session_ctx` parameter. Callers that don't need it don't pay for it. The function stays pure and testable.

### P8. Timeline is Health's history

`session.timeline[]` records every state transition. Health computes the *current* answer. Timeline records the *sequence* of answers. Together they give the operator both "what's true now" and "what happened to get here." No separate audit log.

---

## Part III — The Health Model (shape)

```
SessionHealth {

  session_id:   "sess_<asg>_<date>_a<n>",
  computed_at:  Timestamp,

  // ─── Three independent readiness axes ─────────────────────────

  session_readiness: SessionReadinessAxis,     // Part IV
  payroll_readiness: PayrollReadinessAxis,     // Part V
  customer_readiness: CustomerReadinessAxis,   // Part VI

  // ─── Cross-cutting operator affordance ───────────────────────

  recovery: RecoveryHint,                      // Part VIII

  // ─── Meta / display ──────────────────────────────────────────

  integrity: "ok" | "degraded" | "stalled" | "recovered",
  headline: string,                             // Part X — one sentence
  warnings_all_axes: [ Warning ],               // merged across axes for at-a-glance

  // ─── Provenance ──────────────────────────────────────────────

  input_schema_version: 2,                     // matches session.schema_version
  compute_version:      "1.0.0",               // this function's version
  cross_session_ctx_used: bool                 // was cross-session data considered?
}
```

Every field is either derived from the Session, derived from Session components, or (for cross-Session facts) derived from opt-in supplied context. Nothing is authored; everything is computed.

---

## Part IV — Session Readiness axis

**The question**: Is the Session complete enough to close?

### States (discrete)

```
session_readiness.state ∈ {
  not_started,       // Session created, no clock_in yet
  in_progress,       // clock_in fired, work happening
  ready_to_close,    // clock_out fired, awaiting components
  closed             // all required components terminal
}
```

Discrete state is the load-bearing readiness signal. Percentage is a display convenience only.

### Full shape

```
SessionReadinessAxis {
  state:               (discrete state above),
  pct:                 int (0-100),
  required_total:      int,          // e.g., 7 for office_cleaning
  required_complete:   int,
  blockers:            [ Blocker ],  // required components not terminal
  warnings:            [ Warning ],  // slow but progressing, or optional issues
  next_expected_event: string | null // "tech to submit DCR" | "tech to clock out"
}
```

### `next_expected_event`

The Session's Health function knows the DAG of components. For each state, one component is "next" in the natural flow:

| Session state | Next expected event |
|---|---|
| `not_started` | "tech to start work (clock in)" |
| `in_progress` | first non-complete required component: photos / checklist / etc |
| `ready_to_close` | DCR submit → customer email send → payroll approval |
| `closed` | null (nothing expected) |

This is what the operator READS when they scan the row without drilling in.

### Blockers on this axis

A required component NOT in a terminal state, and past its SLA (or in a `failed` state):
- `photos` in `collecting` past 5m/no-progress
- `checklist` `untouched` past 5m post-clock-in
- `dcr` `missing` past 15m post-clock-out
- `customer_email` `failed`

Terminal states (clear, don't block): `complete`, `waived`, `sent`, `suppressed`, `not_applicable`.

### Warnings on this axis

- Required component `collecting` within SLA but slow
- Optional component in a "reported" or "requested" state (supplies, problem)
- Session `in_progress` past customer's `budget_minutes` (overtime detected)
- GPS `denied` (a required-with-reduced-integrity signal)

---

## Part V — Payroll Readiness axis

**The question**: Can Kirby approve payroll for this Session?

Governed by **Payroll Gate V2** (2026-07-01): only labor-integrity signals gate approval. DCR is recovery work, not a payroll blocker.

### States (discrete)

```
payroll_readiness.state ∈ {
  not_yet,             // Session not far enough along
  ready_for_review,    // labor integrity clean; Kirby can approve
  review_blocked,      // labor-integrity issue (needs_review / active / missing_clockout)
  approved,            // Kirby approved (payroll_state = approved_for_payroll)
  exported,            // sent to CSV export
  locked               // period closed
}
```

### Full shape

```
PayrollReadinessAxis {
  state:            (discrete state above),
  blockers:         [ Blocker ],         // labor-integrity only
  warnings:         [ Warning ],         // DCR pending, customer_email failed, etc — informational
  computed_hours: {
    work_minutes:      int,
    drive_minutes:     int,              // future — Deputy sync
    break_minutes:     int,              // from paused_intervals
    regular_minutes:   int,              // OT engine output
    overtime_minutes:  int
  },
  approval_hint:    "auto_ok" | "watch_flag" | "needs_kirby_decision",
  period_id:        string,               // "2026-07-A"
  period_close_at:  Timestamp | null,     // when the period locks
  minutes_until_close: int | null
}
```

### Blockers on this axis (Payroll Gate V2)

Only three keys. Any other issue is a warning, not a blocker.
- `needs_review` — admin flagged
- `active` — session still running (`status in [active, paused]`)
- `missing_clockout` — `status = completed` but no `clock_out_at`

That's the complete list. DCR pending, orphaned DCR, customer email failure, supplies open — all warnings, not blockers.

### Warnings on this axis

- DCR pending (recovery visible, not blocking)
- Customer email failed (April concern, not Kirby's)
- Supplies requested / problem reported (log-only for Kirby)
- Session's tech has open Sessions on other days that still need approval (heads-up for period close)

### Approval hint

Three-tier signal Kirby uses to decide how much to look:

| Hint | Meaning | Kirby's action |
|---|---|---|
| `auto_ok` | Labor clean, no warnings | Batch approve safely |
| `watch_flag` | Labor clean, but has warnings (open supplies, problem, or DCR pending) | Peek before approve |
| `needs_kirby_decision` | Has pending time adjustment or manual flag | Judgment call, review carefully |

### Computed hours

Always current, always derived. Rules:
- `work_minutes` — from `effective_minutes` if any approved adjustment, else `session.work_minutes`
- `break_minutes` — sum of `paused_intervals`
- `regular_minutes` + `overtime_minutes` — OT engine output for the tech's week
- `drive_minutes` — reserved for future Deputy integration; 0 today

---

## Part VI — Customer Readiness axis

**The question**: Does the customer know we were there?

### States (discrete)

```
customer_readiness.state ∈ {
  not_yet,          // DCR component not complete
  queued,           // email drafted, waiting to send
  sent,             // successfully delivered
  failed,           // bounce or SMTP error
  suppressed,       // customer opted out OR no email on file
  manual_needed     // human follow-up required (problem was reported this visit)
}
```

### Full shape

```
CustomerReadinessAxis {
  state:                    (discrete state above),
  blockers:                 [ Blocker ],
  warnings:                 [ Warning ],
  last_communication_at:    Timestamp | null,
  delivery_channel:         "dcr_email" | "manual_call" | null,
  message_id:               string | null,        // pointer to send audit
  customer_email_enabled:   bool,                 // from customer config
  customer_open_issues:     int | null,           // from cross_session_ctx (opt-in)
  suppressed_reason:        string | null         // "customer opted out" | "no email on file"
}
```

### Blockers on this axis

- `failed` state with no retry in progress — admin must resend or change recipient
- `manual_needed` — problem reported on this visit and no follow-up recorded

### Warnings on this axis

- Customer opted out (heads-up: they get no automated visibility into our work)
- Delivery success rate < 80% for this customer over last 30d (informational)
- This customer has `open_issues > 0` across recent sessions (cross-session context)
- Customer cycle status is `overdue` (heads-up: they missed a scheduled service)

---

## Part VII — Required vs Optional Components

### Required components

Component listed in `session.expected_components`. Rules:
- Terminal state (`complete`, `waived`, `sent`, `suppressed`, `not_applicable`) → contributes to `pct` numerator + doesn't block
- Non-terminal + within SLA → contributes to `pct` denominator, appears as `warning`
- Non-terminal + past SLA → appears as `blocker`
- `failed` state → appears as `blocker` regardless of time

### Optional components

Component NOT in `expected_components`, or in `expected_components` but effectively downgraded (e.g., `customer_email` when customer opts out):
- Any state → contributes to `warnings` only
- Never blocks any readiness axis
- Recovery verbs still available

### Component-by-component classification

| Component | Required in office_cleaning? | Required when? | Terminal states |
|---|---|---|---|
| `clock` | Yes | Always for any labor Session | `clock_in_at` AND `clock_out_at` set |
| `gps` | Yes | Always | `verified` OR `allowed` OR `unknown` |
| `photos` | Yes | Non-inspection labor | `complete` (count ≥ min_required) |
| `checklist` | Yes | Non-inspection labor | `complete` (pct = 100%) |
| `dcr` | Yes | office_cleaning | `submitted` OR `waived` |
| `customer_email` | Situationally | Customer has `dcrEmailEnabled = true` | `sent` OR `suppressed` |
| `payroll` | Yes | Every labor Session | `approved_for_payroll` OR `excluded` |
| `supplies` | No — always optional | — | `not_applicable` OR `fulfilled` |
| `problem` | No — always optional | — | `not_applicable` OR `resolved` |

`customer_email` is the interesting case: it's required BY DEFAULT but downgraded to optional when `customer.dcrEmailEnabled === false` (opt-out). The Health function reads customer config to make this determination.

---

## Part VIII — Blockers, Warnings, Recoverable

### Blocker shape

```
Blocker {
  component:       "photos" | "checklist" | "dcr" | ... | "payroll_time_gap" | ...,
  state:           string,                    // the current bad state
  since:           Timestamp,                 // when it became blocking
  since_minutes:   int,                       // convenience
  severity:        "blocking",                // always "blocking" for a blocker
  label:           string,                    // "3 of 8 photos uploaded"
  recovery: {
    verb:              "notify" | "resume" | "recover" | "supersede" | "archive" | "escalate",
    reason:            string,                // "tech online recently — try notify"
    payload_hint: {                           // what the verb needs as input
      channel?:  "sms" | "call" | "push",
      message?:  string
    } | null
  },
  affects_axes: ["session" | "payroll" | "customer"]  // which readiness axes this blocks
}
```

`affects_axes` is important: a single blocker can affect multiple axes simultaneously (e.g., `active` blocks both session_readiness — session is still running — and payroll_readiness — Kirby can't approve).

### Warning shape

```
Warning {
  component:       string,                     // may be a component OR a cross-session concern
  kind:            "slow" | "optional_active" | "opt_out" | "cross_session" | "cycle" | "history",
  since:           Timestamp | null,
  label:           string,                     // "photos: 5 of 8, last activity 12m ago"
  severity:        "info" | "watch" | "escalate",
  action_hint:     string | null              // "reach out to April" | null (no action)
}
```

Warnings don't have a `recovery.verb` because they're not directly recoverable — they're facts to consider.

### Recoverable states = every blocker has a verb

A key design invariant: every `Blocker` MUST have a non-null `recovery.verb`. If Health computes a blocker with no verb, that's a design gap — either:
- (a) the component's blocked state shouldn't be a blocker (make it a warning), or
- (b) the Recovery verb set is incomplete (add a verb — a design decision, not a coding decision)

This invariant is testable and should be enforced in `computeSessionHealth` output validation.

### Warning severity split

- `info` — heads-up; no action needed. Displayed low-key.
- `watch` — something to keep an eye on. May escalate to a blocker if it worsens.
- `escalate` — non-blocking but worth surfacing to a specific role (e.g., safety problem reported → dispatch).

---

## Part IX — Recovery (per-blocker + Session-level)

### Per-blocker recovery

Each `Blocker` carries one recommended verb + payload hint. This is per-block — a Session with 3 blockers gets 3 verb suggestions.

### Session-level recovery hint

The overall `SessionHealth.recovery` field aggregates:

```
RecoveryHint {
  suggested_verb:      "notify" | "resume" | "recover" | "supersede" | "archive" | null,
  suggested_reason:    string,                 // "tech stalled 4h — notify first"
  primary_blocker_ref: Blocker | null,         // which blocker drove the suggestion
  fallback_verbs:      [ "recover", "supersede" ],
  escalation_hint:     string | null           // "if notify + resume both fail, page dispatch"
}
```

The `suggested_verb` is the top-priority blocker's verb, per a fixed priority order:

**Blocker priority (highest first)**:
1. `clock` blockers (session can't complete without clock)
2. `dcr` blockers (blocks customer + payroll downstream)
3. `photos` / `checklist` (blocks DCR downstream)
4. `customer_email` failures (April action)
5. `payroll_time_gap` (needs_review / active / missing_clockout)

If Session has multiple blockers, Health surfaces the highest-priority one first.

### Recovery verb payload hints per blocker type

Each Recovery verb's typical payload shape:

| Verb | Payload fields | Notes |
|---|---|---|
| `notify` | `channel`, `message` (template), `rate_limit_override?` | audit trail via Timeline `admin.notify` |
| `resume` | `reason` | no state change; wakes stuck Session |
| `recover` | per-field diff (`patch`) + `reason` | Timeline `admin.correction` |
| `supersede` | `reason`, `new_session_hints?` | archives old + creates new with `_a<n+1>` |
| `archive` | `reason` | `admin_removed = true` |
| `escalate` | `to_role`, `message` | non-verb but included for API symmetry — pages a human |

`escalate` is proposed as a 6th "meta-verb" for cases where the 5 explicit verbs don't apply — e.g., a payroll blocker that only Kirby can decide. It doesn't change Session state; it just tells the system who to notify.

---

## Part X — Cross-Session context (opt-in)

Some operator questions require reading OTHER Sessions or customer/tech-level facts. Session Health accepts an optional `cross_session_ctx` parameter:

```
cross_session_ctx?: {
  tech: {
    open_sessions_count:       int,           // is tech currently on another job?
    orphan_dcr_rate_30d:       float,         // 0.0-1.0
    recently_online_at:        Timestamp | null
  },
  customer: {
    last_serviced_at:          Timestamp | null,
    cycle_status:              "on_schedule" | "due_today" | "overdue" | "no_schedule",
    open_problems_count:       int,
    email_success_rate_30d:    float | null
  }
}
```

If provided, Health emits richer warnings:
- "Tech is currently at another Session (Cedar LLC, 12m in)" — tech.open_sessions_count > 0
- "This customer has 3 open problems from recent visits" — customer.open_problems_count > 0
- "This customer is 5 days overdue on cycle" — customer.cycle_status == "overdue"

If not provided, Health omits those warnings. **The function stays pure.** The dashboard batches the cross-session reads (efficient), then calls Health (cheap).

---

## Part XI — Headline + Integrity (derived meta)

### Headline

One sentence, ≤ 100 chars, that captures "what does this Session still need?" for the operator's quick scan. Deterministically composed from readiness axes + top blocker:

| Condition | Headline |
|---|---|
| All three axes terminal (closed/exported/sent) | "Complete — no action needed" |
| session_readiness in `in_progress` + no blockers | "On track — {next_expected_event}" |
| session_readiness with blocker | "Stalled {since_minutes}m — {recovery.verb} {tech_or_component}" |
| payroll_readiness = `ready_for_review` + others clean | "Ready for payroll approval" |
| payroll_readiness = `approved` + customer pending | "Payroll approved; customer email {state}" |
| customer_readiness = `failed` | "Customer email failed — retry or edit recipient" |
| session_readiness = `closed` + payroll open | "Complete; awaiting Kirby's approval" |

Headline generation is a deterministic template function inside `computeSessionHealth`. No LLM. Text is stable and testable.

### Integrity (derived, NOT stored)

```
integrity ∈ {
  ok,          // all readiness axes at clean-forward states, no blockers, no warnings
  degraded,    // one or more warnings, no blockers
  stalled,     // any blocker present OR session in_progress past 4h with no forward progress
  recovered    // was stalled/degraded within the last 24h and now clean (from Timeline)
}
```

Derived from the SAME data as everything else in Health. NOT persisted on the Session document. Callers that need queryable integrity get it via projections (Mission Control V2's proposed `sessionsV2_payroll_readiness` and `customersV2_readiness` carry integrity as a de-normalized field for filter performance — that's fine; those are read-side projections that can drift and self-heal).

---

## Part XII — Compute function signature + purity

```
computeSessionHealth(
  session:            Session,                  // full session document
  now:                Timestamp,                // "as of" — testable time
  customer_config?:   CustomerConfig,           // { photos.min_required, dcrEmailEnabled }
  cross_session_ctx?: CrossSessionCtx           // opt-in (Part X)
) → SessionHealth
```

**Pure function.** No I/O. Deterministic. Given the same inputs, always returns the same output.

**Testable in isolation.** All inputs are plain objects. All outputs are plain objects.

**No dependencies on Firestore, Cloud Functions, browser DOM, or global state.** Runs in Node, browser, tests, or Cloud Function equally well.

The function has a version stamp (`compute_version: "1.0.0"`) so callers can detect drift when the algorithm changes.

---

## Part XIII — How Mission Control V2 projects from Health

Once `computeSessionHealth` exists and is stable, every Mission Control V2 tab is a filter over Health outputs:

| MC V2 tab / card | Filter |
|---|---|
| Today's Active Routes | `session_readiness.state in [in_progress, ready_to_close]` grouped by tech |
| Stalled sessions card | `integrity == "stalled"` |
| Session Health drill-in | full `SessionHealth` object for a single Session |
| Kirby's "Ready for approval" list | `payroll_readiness.state == "ready_for_review" AND approval_hint == "auto_ok"` |
| April's "Failed emails" list | `customer_readiness.state == "failed"` |
| Nicholas H's "Needs attention" | `integrity in [stalled, degraded]` |
| Recovery queue | `blockers.length > 0` sorted by primary_blocker priority |
| Historical drill-in | Session `timeline` + reconstruct-Health at each timestamp (from frozen snapshots) |

**No tab reads directly from the Session document.** Every read goes through `computeSessionHealth`. This is the single lens.

For performance at scale, projections (`sessionsV2_open`, `sessionsV2_payroll_readiness`, `customersV2_readiness`) precompute derived fields from Health — a trigger runs Health on each Session write and denormalizes the result. Reads then filter on those denormalized fields. Health remains the source of truth for the algorithm; projections are just query-shaped caches.

---

## Part XIV — Challenges to prior designs

### C1. Percentage-as-progress is misleading
**Existing schema**: `deriveCompletion(s).pct = (complete/expected) × 100`. Treats all components equal weight. A Session with clock + gps + photos + checklist done but DCR + customer_email + payroll pending shows 57% — which reads as "half-done" but is actually "the hard part remains."

**Session Health**: pct is a display convenience. **State is the load-bearing signal.** Kirby doesn't look at pct; she looks at `payroll_readiness.state`. Nicholas H doesn't look at pct; he looks at `session_readiness.state` + `integrity`.

### C2. `session.integrity` should NOT be a stored flat field
**MC V2 arch doc** proposed adding `session.integrity` as a stored, trigger-maintained flat field for queryability.

**Session Health**: computed at read time, never stored on the Session. Query performance concerns are handled by projections (`sessionsV2_payroll_readiness` etc.), which are allowed under Constitution Rule 3 as read-side caches. Never denormalize into the source.

### C3. Health does NOT collapse into a single state
The temptation is to say `SessionHealth.state = ready | blocked | ok` as a top-level scalar. Resist. The three readiness axes are independent for a reason — they answer different personas' questions. Any top-level scalar is a lie about at least one persona.

### C4. Optional components live in the SAME Health object
The temptation is to separate "core" and "extras." Resist. `components.problem` in `reported` state is a first-class Warning inside `customer_readiness.warnings` — same object, same shape, just different severity. Callers filter by severity, not by "which bucket."

### C5. Cross-Session context is a parameter, not an implicit fetch
The temptation is to have `computeSessionHealth(session)` fetch other Sessions internally when it needs them. Resist. Impurity kills testability. Callers batch reads, then compute. Payroll-batch callers pass `null`; interactive dashboards pass rich context.

### C6. Recovery per blocker, not per Session
Sessions often have multiple blockers simultaneously (photos stuck + tech offline). Each blocker has its own recovery verb. The top-level `SessionHealth.recovery` field points to the HIGHEST-PRIORITY blocker's verb — but the operator can see all blockers and pick differently. Don't hide the multiplicity.

### C7. Health has NO knowledge of UI
No colors. No CSS classes. No icons. Health is a data structure. Rendering is downstream. This lets MC V2, MC-mobile, on-call push, and hypothetical customer-facing status pages all read the same Health object and render differently.

### C8. Timeline is the CHANGELOG of Health
Timeline entries are the immutable record of every state transition. Health computes the CURRENT state; Timeline is how we know how we got here. The operator can drill from Health → Timeline seamlessly.

**Interesting corollary**: to render "how has this Session's Health evolved?", we'd need Health snapshots at each Timeline entry timestamp. Proposal: at customer_email send time, freeze the current `SessionHealth` output as a snapshot artifact in `sessionsV2/{id}/health_snapshots/{ts}`. Historical replay reads snapshots.

Snapshot-freeze is a separate slice (Phase 39a candidate). Health function itself doesn't need snapshots to work.

---

## Part XV — What Session Health does NOT do

Deliberately excluded from the model:

- **Not a per-tech rollup.** Health is per-Session. Tech-level rollups (Nicholas H's orphan rate, Bonnie's average completion time) are separate views. Session Health provides one atomic answer; rollups aggregate atomic answers.

- **Not a per-customer rollup.** Same. Customer-level context (`customersV2_readiness`) is an aggregate that reads across Sessions; per-Session Health only reads customer *config* (opt-in for context).

- **Not an alert/notification target.** Health is read-side. Push alerts (Phase 37h) fire on Health *state transitions* observed by a trigger, not on Health itself. Health is the mirror; alerts are the reaction.

- **Not a permission model.** Health returns all fields to every caller. Callers apply role-scoping (Kirby's tab hides customer email details she can't act on). Health's job is truth; the tab's job is scope.

- **Not opinionated about display format.** Percentages are ints, timestamps are Firestore Timestamps, states are strings. Colors, icons, thresholds — downstream.

- **Not aware of Session type semantics beyond `expected_components`.** The Session doc's `session_type` field drives `expected_components`; Health reads `expected_components` directly. No per-type branching inside Health.

- **Not persistent state.** Nothing writes back. Recovery actions write to Session (via dedicated Cloud Functions); Health merely computes what those actions could be.

---

## Part XVI — Migration path (proposed Phase 37A)

### Phase 37A.1 — The pure function module
- Ship `functions/sessionsV2-session-health.js` (also exposed to browser as UMD)
- Implements `computeSessionHealth(session, now, customer_config?, cross_session_ctx?)`
- 100% pure; no I/O
- ~300-500 LOC estimated

### Phase 37A.2 — Tests
- Pure-JS test file covering:
  - All discrete states across all three axes (~40 tests)
  - Blocker generation per component × state matrix (~30 tests)
  - Warning generation including cross-session ctx cases (~20 tests)
  - Headline determinism (given inputs → exact string output; ~15 tests)
  - Recovery verb assignment per blocker (~10 tests)
  - Integrity derivation (~10 tests)
- Target: >100 tests. All pure. Fast. Deterministic.

### Phase 37A.3 — Canary integration
- New admin canary button: "Compute Session Health for..." — pick a real Session, render the SessionHealth object as JSON + a lightweight preview card.
- Verifies the function works on real data across many Session shapes.
- No production behavior change. Read-only tool.

### Phase 37A.4 — Documentation
- Author `SESSION_HEALTH_SCHEMA.md` — closed enum of every state, blocker key, warning kind, recovery verb.
- Version stamp: `compute_version: "1.0.0"`.

**After 37A, Mission Control V2 tabs consume this function. Payroll Gate V2's server-side blocker check is refactored to import from the shared module. Every operational surface reads Health, not raw Session.**

### Phase 37A.5 — Health-driven Payroll Gate
- Refactor `payrollIsBlocker(s)` in `functions/index.js` to call `computeSessionHealth(s).payroll_readiness.blockers.length > 0`. Same behavior, single source of truth. Deletes duplicate labor-integrity logic across client + server.

---

## Part XVII — Guiding principle (repeated)

> The Session is the truth.
> Session Health is the question the operator asks of that truth.
> Recovery is the answer.

Every Kirby question. Every April question. Every Nicholas H question. Every push alert. Every payroll batch. Every audit query.

**One Session. One Health. One Recovery.**

The office should never again investigate multiple collections. They read Health. Health tells them what the Session still needs. Recovery tells them how to move it forward. If Health doesn't answer, the Session's data is incomplete — go fix that upstream, not by adding another collection to query.

---

## Appendix A — Full `SessionHealth` object shape (canonical)

```
SessionHealth {
  session_id:                string,
  computed_at:               Timestamp,
  input_schema_version:      2,
  compute_version:           "1.0.0",
  cross_session_ctx_used:    bool,

  session_readiness: {
    state:                   "not_started" | "in_progress" | "ready_to_close" | "closed",
    pct:                     int (0-100),
    required_total:          int,
    required_complete:       int,
    blockers:                [ Blocker ],
    warnings:                [ Warning ],
    next_expected_event:     string | null
  },

  payroll_readiness: {
    state:                   "not_yet" | "ready_for_review" | "review_blocked" | "approved" | "exported" | "locked",
    blockers:                [ Blocker ],
    warnings:                [ Warning ],
    computed_hours: {
      work_minutes:           int,
      drive_minutes:          int,
      break_minutes:          int,
      regular_minutes:        int,
      overtime_minutes:       int
    },
    approval_hint:           "auto_ok" | "watch_flag" | "needs_kirby_decision",
    period_id:               string,
    period_close_at:         Timestamp | null,
    minutes_until_close:     int | null
  },

  customer_readiness: {
    state:                   "not_yet" | "queued" | "sent" | "failed" | "suppressed" | "manual_needed",
    blockers:                [ Blocker ],
    warnings:                [ Warning ],
    last_communication_at:   Timestamp | null,
    delivery_channel:        "dcr_email" | "manual_call" | null,
    message_id:              string | null,
    customer_email_enabled:  bool,
    customer_open_issues:    int | null,
    suppressed_reason:       string | null
  },

  recovery: {
    suggested_verb:          "notify" | "resume" | "recover" | "supersede" | "archive" | "escalate" | null,
    suggested_reason:        string,
    primary_blocker_ref:     Blocker | null,
    fallback_verbs:          [ string ],
    escalation_hint:         string | null
  },

  integrity:                 "ok" | "degraded" | "stalled" | "recovered",
  headline:                  string,
  warnings_all_axes:         [ Warning ]
}

Blocker {
  component:                 string,
  state:                     string,
  since:                     Timestamp,
  since_minutes:             int,
  severity:                  "blocking",
  label:                     string,
  affects_axes:              [ "session" | "payroll" | "customer" ],
  recovery: {
    verb:                    "notify" | "resume" | "recover" | "supersede" | "archive" | "escalate",
    reason:                  string,
    payload_hint:            { channel?, message?, patch?, ... } | null
  }
}

Warning {
  component:                 string,
  kind:                      "slow" | "optional_active" | "opt_out" | "cross_session" | "cycle" | "history",
  since:                     Timestamp | null,
  label:                     string,
  severity:                  "info" | "watch" | "escalate",
  action_hint:               string | null
}
```

---

## Appendix B — Component × state → readiness contribution table

For each component × current state, what does Session Health output?

| Component | State | session_readiness | payroll_readiness | customer_readiness |
|---|---|---|---|---|
| clock | (both stamped) | terminal, contributes to pct | possible `ready_for_review` | — |
| clock | (missing clock_out) | blocker (component=clock, verb=recover) | blocker=missing_clockout | — |
| gps | verified/allowed/unknown | terminal | — | — |
| gps | denied | warning (severity=info) | — | — |
| photos | complete | terminal, contributes to pct | — | — |
| photos | collecting < 5m no-progress | warning (kind=slow) | — | — |
| photos | collecting ≥ 5m no-progress | blocker (verb=notify) | — | — |
| photos | failed | blocker (verb=recover) | — | — |
| checklist | complete (pct=100%) | terminal | — | — |
| checklist | collecting < 5m no-progress | warning | — | — |
| checklist | collecting ≥ 5m no-progress | blocker (verb=notify) | — | — |
| dcr | submitted OR waived | terminal | — | unlocks queued state |
| dcr | missing < 15m post-clock-out | warning | — | — |
| dcr | missing ≥ 15m post-clock-out | blocker (verb=notify → recover) | — | — |
| customer_email | sent OR suppressed | terminal | — | terminal state |
| customer_email | queued | (informational — expected) | — | in `queued` state |
| customer_email | failed | blocker (severity=info in session; blocking in customer) | warning | blocker (verb=recover) |
| payroll | approved_for_payroll OR excluded | terminal | terminal | — |
| payroll | pending_review + labor clean | (session already complete) | `ready_for_review` state | — |
| supplies | not_applicable | — | — | — |
| supplies | requested | warning (kind=optional_active, severity=info) | warning | — |
| problem | not_applicable | — | — | — |
| problem | reported | warning (kind=optional_active, severity=watch) | warning | manual_needed state |
| problem | reported + category="safety" | warning (severity=escalate) | warning | manual_needed state |

Blank cells = component doesn't affect that axis.

This table is the canonical translation from component state → Health output. Any change to component semantics requires updating this table AND the `computeSessionHealth` function.

---

## Final principle

Mission Control V2 asked: "What does this Session still need?"

Session Health is the object that answers that question.

Every downstream surface — Mission Control tabs, push alerts, payroll batches, customer-facing status — reads Session Health. None reads the raw Session directly.

**One Session. One Health state. One Recovery path.**

The Session is the truth. Health is how we read it.

---

**End of design.**
