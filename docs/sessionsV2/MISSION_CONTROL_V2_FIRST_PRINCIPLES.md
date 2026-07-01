# Mission Control V2 — First Principles Design

**Status (2026-07-01)**: DESIGN PROPOSAL — **PAUSED** at operator request pending explicit resume. Architecture-only, no implementation. Written as if V1 never existed.

---

## ⏸ PAUSE STATE (2026-07-01T16:12Z)

**Progress: ~65% of the design surface complete.**

### Sections completed (15 Parts + 2 Appendices)
- ✅ Part I — First Principles (P1–P7)
- ✅ Part II — Operator personas (Kirby / April / Nicholas H / Nicholas K / On-call)
- ✅ Part III — Session as primitive
- ✅ Part IV — Component Contract (rubric table, DAG, readiness semantics) — **shape defined; per-component code detail deferred**
- ✅ Part V — Payroll Readiness subsystem (projection shape, indexes, tab layout, Kirby ritual)
- ✅ Part VI — Customer Readiness subsystem (projection shape, indexes, tab layout, April ritual)
- ✅ Part VII — Day Health (computed, live)
- ✅ Part VIII — Recovery + Notify verb + decision tree
- ✅ Part IX — Push alerts subsystem (routing, types, Timeline integration)
- ✅ Part X — Historical drill-down + snapshot artifact
- ✅ Part XI — Ten-year design bets
- ✅ Part XII — Migration ladder (persona-organized)
- ✅ Part XIII — Design tensions with existing arch doc (8 challenges surfaced)
- ✅ Part XIV — Deliberate non-scope list
- ✅ Part XV — Guiding principle
- ✅ Appendix A — Reconciliation table with existing arch doc
- ✅ Appendix B — 7 decisions surfaced for operator confirmation

### Remaining work (recommended order)
1. **Component Contract module — per-component code contents.** Enumerate all 9 components with their `is_ready_to_begin`, `is_complete`, `sla_seconds_collecting`, `blocks`/`blocked_by` for the code module. Rubric table exists (§IV.2); code-level detail does not.
2. **Session Health card renderer spec** — how Component Contract output renders in the shared card used by every persona. Existing arch doc §7 sketches; needs Component-Contract-aware rewrite.
3. **Auth / permission model for role-scoped tabs** — how does Kirby's session claim gate her tab vs April's? Reserved but undesigned.
4. **Alert route seed config** — enumerate the first `alert_routes` docs (recipient lists, channels, quiet hours). §IX.4 lists alert types; concrete config needs authoring.
5. **Push channel wiring** — Twilio for SMS? Slack webhook? Third-party abstraction? §IX assumes channels exist; the plumbing is undesigned.
6. **Batch Approve UX detail** — confirm dialog, per-Session error handling, partial-success flow. §V.4 references it; flow is undesigned.
7. **Historical search UI detail** — query composition (customer + date range + tech), pagination, empty-state. §X sketches; flow-detail is undesigned.
8. **Firebase-config additions inventory** — new Cloud Function URLs (`notifySessionV1`, `resumeSessionV1`, `recoverSessionV1`, `supersedeSessionV1`, `archiveSessionV1`, alert-fire endpoints) — list of what needs adding to `public/firebase-config.js`.
9. **Test strategy for persona tabs** — end-to-end validation approach (pure-JS Component Contract tests + emulator tests for projections + Chrome canary for tabs). Undesigned.
10. **Snapshot artifact versioning** — §X.4 proposes writing snapshots at customer-email time; the versioning + format-migration story is deferred to Phase 39 slice planning.

### Open questions requiring operator decision (before implementation)
Copied verbatim from Appendix B, each independently rejectable:
1. `session.integrity` flat field — **build or skip?** *(recommend SKIP; use projections)*
2. **Role-scoped tabs** vs single dashboard? *(recommend role-scoped)*
3. Add **Notify** as 5th Recovery verb? *(recommend yes)*
4. Add **push alerts subsystem** now? *(recommend yes; wire in 37-pre, activate in 37h)*
5. Build **Component Contract module** first? *(recommend yes; foundation for everything)*
6. Assignment reads for **Day Health card** acceptable? *(recommend yes — Constitution Rule 6 permits plan-side reads)*
7. Add **`entity_id` reservation** to Session schema now? *(recommend defer, decide by Phase 41)*

### Recommended next-session starting point
**Open a decision meeting with the operator on the 7 questions above, in that order.** Each decision unblocks a specific remaining-work item:
- Decision #1 gates whether §XI.6 pushback stands → schema stability
- Decision #2 gates whether Phase 37 ladder reorganizes around personas (§XII) or stays single-page
- Decisions #3, #4, #5 gate the Phase 37-pre slice contents
- Decision #6 gates the Day Health card scope
- Decision #7 is a schema reservation only — cheapest decision, most future-proofing

After decisions land, next code artifact is **`functions/sessionsV2-component-contract.js`** (per Remaining Work #1). Everything else in Phase 37-pre depends on it.

### Files touched by this pause
- `docs/sessionsV2/MISSION_CONTROL_V2_FIRST_PRINCIPLES.md` (this doc — new)
- `docs/sessionsV2/MISSION_CONTROL_V2_ARCHITECTURE.md` (unchanged; committed at `fb77606`)
- No production code changed. No schema changed. No functions deployed.

### Related work still running
- **Production polling for Phase 36e canary** — ScheduleWakeup fires every 30 min; unaffected by this pause.

---



**Governed by** [`OPERATION_ONE_TRUTH.md`](./OPERATION_ONE_TRUTH.md) (Constitution v1.0).
**Companion to** [`MISSION_CONTROL_V2_ARCHITECTURE.md`](./MISSION_CONTROL_V2_ARCHITECTURE.md) — this document extends it, challenges some of its assumptions, and fills two gaps (Payroll Readiness and Customer Readiness) that the existing doc left thin.

> The Session becomes the truth.
> Mission Control becomes the window into that truth.
> Mission Control never asks: "Where is the DCR?"
> Mission Control asks: "What does this Session still need?"

The exercise: **design the operations dashboard PioneerOps should still be using ten years from now.**

---

## Part I — First Principles

### P1. The Session is the sentence

A Session is one customer stop. Every operational question at Pioneer — "did the tech show up," "did the DCR go out," "will Kirby approve payroll," "should we re-schedule this customer" — is answered by looking at Sessions. Not routes, not shifts, not customers, not the plan. Sessions.

The workday is a *view* over Sessions. The route is a *view* over Sessions. The customer is a *view* over Sessions. The payroll period is a *view* over Sessions. The Session is the sentence; everything else is a paragraph of Sessions.

### P2. Mission Control is a lens, not a database

Mission Control writes **only** through the four Recovery verbs (plus one this design adds — see §VIII). Every other pixel on the screen is a projection of Session state at some level of granularity. If a card ever needs to author authoritative state, the card is wrong or the schema is wrong. Fix the schema, don't add a write path.

### P3. Personas differ; the Session is the same

Kirby (payroll), April (customer comms), Nicholas H (mid-office / dispatch), Nicholas K (systems), and whoever is on-call — five distinct personas, five distinct morning questions, one Session model that answers all of them. The dashboard must be **role-scoped** without duplicating data.

### P4. Push and pull are separate concerns

A dashboard is a pull surface. An alert is a push surface. Both read from Sessions. Neither owns state. If a stalled Session needs to page the on-call tech at 8 PM, the dashboard shouldn't be the mechanism — a push channel is. Mission Control V2 needs both.

### P5. The morning question beats the health check

"Is everything OK?" is a verdict — binary, low-information, easy to lie to yourself about. "What does today still need?" is a task list — specific, actionable, honest. Every card must answer a *need* question, not an *OK* question.

### P6. The ten-year test

Every design decision is asked: **will this still be the right structure ten years from now?** Sessions will be, because they map to atomic reality. Uniform component shape will be, because business is a set of composable capabilities. Denormalized flat convenience fields probably won't be — they age poorly. Role-scoped tabs will be, because the personas will exist even if the people don't.

### P7. Reality has entropy; the schema must not amplify it

Sessions go stale. Techs go offline. Photos fail to upload. Emails bounce. The schema should model *entropy as normal*, with observable states for degradation, not throw errors when the world misbehaves. Every component state machine already does this — MC V2 must too.

---

## Part II — Operator personas and their questions

Ten years from now these people are gone; the roles remain.

### II.1 Kirby role — Payroll owner

Morning questions:
1. Whose hours am I approving today?
2. Any hours I *can't* approve — why not?
3. Any hours already exported that I need to reopen?
4. How close am I to the payroll period close deadline?

Never asks: "Is the DCR submitted?" (that's a Session-completeness question upstream). Cares only that the *Session* is ready for approval.

### II.2 April role — Customer communications

Morning questions:
1. Which customer emails went out yesterday? Any failed?
2. Which customers haven't been serviced this cycle?
3. Any customer flagged as needing a follow-up call?
4. Any open supply request or reported problem I need to close the loop on?

Never asks: "Did the tech clock in?" (Session state answers implicitly). Cares only about the *customer view* of Sessions.

### II.3 Nicholas H role — Mid-office / dispatch

Morning questions:
1. Which techs are on shift and where are they right now?
2. Any tech unreachable / offline for too long?
3. Any customer needing me to intervene mid-day (missed stop, complaint, etc.)?
4. Projected day-end time — are we finishing on schedule?

Never asks: "Did the photo upload?" (Session Health surfaces it). Cares only about *right-now* movement across Sessions.

### II.4 Nicholas K role — Systems

Morning questions:
1. Any Cloud Function errors overnight?
2. What's the queue backlog?
3. What's the projection drift?
4. Any Session with `integrity: degraded` older than 24h?

Sees a *systems* tab that other personas don't see.

### II.5 On-call role — Rotating pager

**Has no dashboard.** On-call receives targeted push alerts (SMS + Slack) and deep-links from those alerts into Session Health. No idle staring at a dashboard at 11 PM. Section IX covers push in full.

### II.6 What we deliberately do NOT do

- We do NOT build a per-persona *separate app*. One app, role-scoped tabs.
- We do NOT let each persona define their own vocabulary. Kirby, April, and Nicholas H all speak "Session" — differences are which components they look at, not what those components mean.

---

## Part III — The Session as the primitive

### III.1 Sessions are slots

A Session is a slot of reality: one customer, one stop, one attempt. The schema already enforces this via the deterministic `session_id` format (`sess_<assignment_id>_<service_date>_a<n>`). Reorderable, superseable, archiveable — but never merged, never joined.

### III.2 Components are the extension point

The uniform component shape (§ SCHEMA — status/started_at/last_event_at/completed_at/last_event/error/count/pct/ref) is the platform's contract for growth. New business capability = new component. Never a new top-level collection (Constitution Rule 7).

Today's closed set: `clock, gps, photos, checklist, supplies, problem, dcr, customer_email, payroll`.

Ten-year additions might include: `qc_visit` (supervisor inspection), `restock_delivery`, `key_return`, `bio_hazard_notice`, `client_signoff`. Each is a component. Each has states. Each has completeness rules. **Nothing about MC V2 changes when a new component ships** — the schema does the work.

### III.3 The Session speaks Timeline

Timeline is the load-bearing audit log. Constitution Rule 9: canonical. MC V2 reads Timeline (never infers state), renders Timeline (never reformats state), and stamps Timeline whenever it invokes a Recovery verb. Nothing else uses "audit" or "log."

---

## Part IV — The Component Contract

The existing arch doc leaves component completeness rules **implicit and scattered**. Photos are "complete when count ≥ min," but what's the min? Checklist is "complete when pct = 100%," but the code sets status = `complete` regardless of pct on DCR submit. Payroll is "complete when approved_for_payroll." Each in a different place, in a different shape.

**Proposal**: one canonical module — `functions/sessionsV2-component-contract.js` (also exposed to browser as UMD) — declares the rules for every component.

### IV.1 Contract shape

```js
{
  name:                    "photos",
  states:                  ["not_applicable", "missing", "collecting", "complete", "failed", "replaced"],
  is_applicable:           session => session.expected_components.includes("photos"),
  is_ready_to_begin:       session => session.status === "in_progress",
  is_complete:             session => session.components.photos.status === "complete",
  is_blocking_dcr:         session => !this.is_complete(session) && session.components.dcr.status === "missing",
  sla_seconds_collecting:  300,     // "collecting" > 5min without progress → stalled
  blocks: ["dcr"],                  // this component blocks these
  blocked_by: [],                   // this component is blocked by these
  min_count_from:          customer => customer.config?.photos?.min_required ?? 0,
  escalation: {
    level_1: "operator_dashboard",  // 5-30m
    level_2: "sms_dispatch",        // 30m-2h
    level_3: "customer_email"       // 2h+ (only for customer-facing components)
  }
}
```

### IV.2 Canonical rubric per component

| Component | Ready when | Complete when | SLA | Blocks | Blocked by |
|---|---|---|---|---|---|
| **clock** | Session created | `clock_in_at` AND `clock_out_at` both stamped | none | (everything) | — |
| **gps** | `clock_in` fired | GPS verified within 100m OR status = `allowed`/`unknown` | 60s | — (soft) | clock |
| **photos** | Session `in_progress` | `count ≥ customer.photos.min_required` | 5m per photo | dcr | clock |
| **checklist** | Session `in_progress` | `pct = 100%` (per-item statuses `done` or `na`) | 5m untouched | dcr | clock |
| **dcr** | photos + checklist complete | `status = submitted` OR `waived` | 10m post-`clock_out` | customer_email, payroll | photos, checklist |
| **supplies** | Session created | admin marks `fulfilled` | 24h | — | — |
| **problem** | Session created | admin marks `resolved` | 24h | — (soft flag) | — |
| **customer_email** | dcr complete | `sent` OR `suppressed` OR `failed_final` | 60m post-dcr | — (fails escalate) | dcr |
| **payroll** | clock + dcr + customer_email settled | `approved_for_payroll` OR `excluded` | (Kirby judgment) | — | dcr, customer_email |

### IV.3 What "blocking" means

A component `A` **blocks** component `B` when `B` cannot legitimately begin its work until `A` is complete. This forms an acyclic dependency graph:

```
      clock ── gps
        │
        ├──► photos ──┐
        ├──► checklist ┘─► dcr ──► customer_email
        │              └────────► payroll
        ├──► supplies (parallel; never blocks)
        └──► problem  (parallel; never blocks)
```

Consequences:
- Ready-to-begin gates are checkable statically (no runtime cycle risk)
- MC V2 renders a **dependency-aware** blocker list: "photos is blocking DCR is blocking Payroll"
- Recovery UX (§VIII) suggests actions by walking DAG toward first blocking node

### IV.4 What "readiness" means (per-component completion semantics)

The existing `deriveCompletion(session)` treats every expected component equally. That's wrong at the boundaries:
- A Session `in_progress` at 30% completion should show as **on track** (work is happening).
- A Session `awaiting_completion` at 30% completion is **stalled** — every remaining component is now blocking.

The Component Contract answers this by exposing:

```js
computeSessionHealth(session) = {
  pct:            derived from components.*.status
  status_label:   "On Track" | "In Flight" | "Almost Done" | "Stalled" | "Failed"
  blockers:       [ per-component blocker list, ordered by DAG-depth ]
  next_expected:  the shallowest incomplete component
  integrity:      "ok" | "degraded" | "stalled" | "recovered"
  ready_for_dcr:  bool
  ready_for_email: bool
  ready_for_payroll: bool
}
```

Every persona-specific tab uses this same function. Kirby's tab filters by `ready_for_payroll`. April's tab filters by `ready_for_email`. Nicholas H's tab filters by `integrity`.

**Diverges from existing arch doc §7**: existing doc lists severity mapping per-component-state; this doc adds the DAG so severity is context-aware ("photos blocking dcr" outranks "photos untouched" when clock-out fires).

---

## Part V — Payroll Readiness (the Kirby subsystem)

The existing arch doc mentions payroll only in KPI aggregates. This section fills the gap.

### V.1 The payroll question is not "is it approved?"

The payroll question is: **"what's between me and this being approvable?"** Approval is Kirby's action. The dashboard's job is to *pre-answer that question at a glance*.

### V.2 Payroll Readiness state (derived, per Session)

Computed by the Component Contract, never stored on Session directly:

```js
payroll_readiness = {
  status: "not_yet"             // components not settled
        | "ready_for_review"    // Kirby can review
        | "review_blocked"      // something is preventing review (e.g. DCR failed)
        | "reviewed_hold"       // Kirby reviewed and held for manual decision
        | "approved"            // approved_for_payroll
        | "exported"            // sent to CSV
        | "locked",             // period closed

  blockers: [
    { component: "dcr",           reason: "failed", severity: "blocking" },
    { component: "customer_email", reason: "queued", severity: "info" }
  ],

  computed_hours: {
    work_minutes, drive_minutes, break_minutes,
    regular_minutes, overtime_minutes
  },

  approval_hint: "auto_ok"           // all clean, safe batch approve
                | "watch_flag"        // clean but has a problem/supplies note — Kirby should peek
                | "needs_kirby_decision" // component pending or history flag

  period_id: "2026-07-A",
  period_close_at: Timestamp,
  minutes_until_close: int
}
```

### V.3 Payroll projection collection

New: `sessionsV2_payroll_readiness/{session_id}`.

Maintained by trigger `onSessionsV2WriteMaintainsPayrollReadinessV1`. Pruned when Session enters `locked` OR `service_date < today - 60`. Compact — ~1.5 KB per Session.

Doc shape (all derivable — projection exists purely to avoid re-computing on every read):

```js
{
  session_id, staff_uid, customer_id, service_date,
  status:            "ready_for_review",
  approval_hint:     "auto_ok",
  blockers:          [...],
  computed_hours:    {...},
  period_id:         "2026-07-A",
  period_close_at:   Timestamp,
  status_changed_at: Timestamp,
  updated_at:        Timestamp
}
```

Why this projection and not on-read compute: the Payroll tab lists potentially 50-200 Sessions per period. Computing readiness for each on every card render (30s refresh) is a per-Session fan-out that Firestore ergonomics can't sustain cheaply. Trigger-maintained projection = 1 read for 200 Sessions.

Indexes needed:
- `(period_id ASC, status ASC, staff_uid ASC)`
- `(period_id ASC, approval_hint ASC)`
- `(staff_uid ASC, service_date DESC)`

### V.4 The Payroll tab layout

```
┌─────────────────────────────────────────────────────────────┐
│ PAYROLL · Period 2026-07-A  ·  Close in 3d 6h               │
│                                                              │
│  ┌──────────┬──────────┬──────────┬──────────┐              │
│  │   18     │    3     │    1     │    72    │              │
│  │Approvable│ Blocked  │  Needs   │Approved  │              │
│  │          │          │ Decision │ in period│              │
│  └──────────┴──────────┴──────────┴──────────┘              │
│                                                              │
│  Ready for Review (18)                    [ Batch Approve ] │
│  ─────────────────────────────────────────                  │
│  Bonnie   · Cedar LLC       · 3h 47m · auto_ok              │
│  Bonnie   · Acme Dental     · 2h 12m · auto_ok              │
│  Kiana    · MacDonald-Miller· 4h 03m · watch_flag: problem  │
│  ...                                                         │
│                                                              │
│  Blocked (3)                                                 │
│  ─────────────────────────────────────────                  │
│  Kiana    · Novelis         · dcr FAILED · [ Recover DCR ]  │
│  Gene     · Baker Commodities· email queued · [ Wait ]      │
│  Drew     · Hormann Door    · payroll excluded · [ View ]   │
│                                                              │
│  Needs Decision (1)                                          │
│  ─────────────────────────────────────────                  │
│  Nicholas · Riverside       · supplies reported · [ Review ]│
└─────────────────────────────────────────────────────────────┘
```

Key design choices:
- **Batch Approve** is the primary CTA — Kirby wants to move fast on the easy cases
- Every Blocked row has a **direct-action button** — no drill-in for the common recovery path
- `auto_ok` vs `watch_flag` vs `needs_decision` are three separate visual tiers, not a percent grade
- Period close countdown always visible

### V.5 Kirby's five-minute morning ritual

1. Open MC V2 → Payroll tab
2. See "18 approvable" strip. Click Batch Approve → confirm dialog with hours breakdown → done.
3. See "3 blocked" strip. Click each row → in-line Recovery buttons (Recover DCR, Wait, View).
4. See "1 needs decision." Click → per-Session detail with Session Health drill-in.
5. Total elapsed: <5 minutes on a normal day.

**This is the design test for the Payroll tab: can Kirby clear a normal day in five minutes without leaving the tab?**

### V.6 What Payroll never does

- Payroll tab NEVER shows techs the option to approve their own hours.
- Payroll tab NEVER edits `clock_in_at` / `clock_out_at` directly — those are immutable originals. Corrections go through Recovery verb `recover` which writes `effective_*` overlay.
- Payroll tab NEVER writes to `pending_session_writes` — payroll approve is a synchronous authoritative action on the Session itself.

---

## Part VI — Customer Readiness (the April subsystem)

The existing arch doc mentions customers primarily through the Missed Shifts / Customer Coverage cards. This section designs the customer-facing operational surface.

### VI.1 The customer question is not "did the email send?"

It's: **"does the customer feel served?"**

That decomposes into:
- Was the visit completed?
- Did the customer see the DCR?
- Any issues from that visit?
- When are they next scheduled?
- Are they on cycle?

### VI.2 Customer Readiness projection

New: `customersV2_readiness/{customer_id}`.

Maintained by trigger on Session writes. Contains a rolling summary per customer:

```js
{
  customer_id, customer_name, customer_slug,

  last_serviced_at:              Timestamp,
  last_serviced_session_id:      string,
  last_serviced_staff:           { uid, email, name },

  cycle_config: {
    expected_frequency:          "weekly" | "biweekly" | "monthly" | "as_scheduled",
    expected_next_at:            Timestamp | null
  },

  cycle_status:                  "on_schedule" | "due_today" | "overdue" | "no_schedule",

  last_communication: {
    channel:                     "dcr_email" | "manual_call" | "none",
    at:                          Timestamp | null,
    delivery_status:             "delivered" | "failed" | "suppressed" | null,
    message_id:                  string | null
  },

  open_issues: {
    supplies_open_count:         int,
    problems_open_count:         int,
    email_failed_count_7d:       int
  },

  service_health_30d: {
    sessions_completed:          int,
    sessions_stalled_or_failed:  int,
    average_completion_hours:    number,
    dcr_email_success_rate:      float  // 0.0–1.0
  },

  updated_at:                    Timestamp
}
```

Prune rule: keep forever (customer view is used for account management, retention). Cheap because 1 doc per customer, not per Session.

Indexes needed:
- `(cycle_status ASC, last_serviced_at DESC)`
- `(open_issues.problems_open_count DESC)` (single-field auto)

### VI.3 The Customer tab layout

```
┌─────────────────────────────────────────────────────────────┐
│ CUSTOMERS                                                    │
│                                                              │
│  ┌──────────┬──────────┬──────────┬──────────┐              │
│  │    8     │    1     │    2     │    4     │              │
│  │ Emails   │  Email   │ Overdue  │  Open    │              │
│  │Yesterday │ Failed   │ Services │ Issues   │              │
│  └──────────┴──────────┴──────────┴──────────┘              │
│                                                              │
│  Failed Emails (1)                                           │
│  ─────────────────────────────────────                       │
│  Baker Construction · 2h ago · SMTP bounce                   │
│    [ Resend ] [ Change Recipient ] [ Suppress ]              │
│                                                              │
│  Overdue Services (2)                                        │
│  ─────────────────────────────────────                       │
│  Cedar LLC       · biweekly · 5 days overdue                 │
│  Acme Dental     · weekly   · 2 days overdue                 │
│                                                              │
│  Open Issues (4)                                             │
│  ─────────────────────────────────────                       │
│  MacDonald-Miller · problem: broken glass (2d old)           │
│  Novelis          · supply requested: gloves (1d old)        │
│  Hormann Door     · problem: complaint (4h old)              │
│  Baker Commodities· supply requested: TP (6h old)            │
│                                                              │
│  Search customer: [_________________]                        │
└─────────────────────────────────────────────────────────────┘
```

### VI.4 April's morning ritual

1. Open MC V2 → Customer tab
2. See "1 failed email" — click Resend → done.
3. See "2 overdue services" — call the account manager / adjust schedule.
4. See "4 open issues" — triage; close what's closable, escalate what needs escalation.
5. Search "riverside" → see the customer's 30-day service history + issue timeline.

### VI.5 Customer Readiness cards summary

| Card | Query | Refresh | Action affordance |
|---|---|---|---|
| **Yesterday's Emails** | count from customer_email component (yesterday) | 5m | tap → email list |
| **Failed Emails** | `customersV2_readiness where open_issues.email_failed_count_7d > 0` | 5m | tap → resend/edit |
| **Overdue Services** | `customersV2_readiness where cycle_status in [overdue, due_today]` | 1h | tap → schedule view |
| **Open Issues** | `customersV2_readiness where open_issues.problems_open_count > 0 OR supplies_open_count > 0` | 30m | tap → resolve |
| **Customer Coverage Today** | Session projection filtered by customer today | 5m | tap → today's session |
| **Cycle Compliance (30d)** | rollup query on `customersV2_readiness` | 1h | tap → trend |
| **Search** | direct lookup on `customersV2_readiness` | on-demand | tap → customer view |

---

## Part VII — Session Health at the Day Level

For Nicholas H at 8 AM, the question is not "how is one Session doing?" It's "**how is today doing?**"

The existing arch doc addresses this partially in the Right-Now strip + Active Routes card. This section formalizes it.

### VII.1 Day Health (computed, never stored)

Pure function `computeDayHealth(sessions_of_the_day, now)`:

```js
{
  date: "2026-07-01",
  planned_count:       12,   // service_assignments count
  session_counts: {
    not_started:       2,    // assignment without session
    assigned:          0,
    ready:             1,
    in_progress:       3,
    awaiting:          1,
    complete:          5
  },
  degraded_count:      1,    // any expected component failed
  stalled_count:       1,    // in_progress + status_changed_at > SLA
  blocked_by_component: { photos: 2, checklist: 1, dcr: 1 },
  projected_end_local: "16:45 PT",  // derived from active routes + median stop duration
  worst_offenders: [
    { session_id, tech, customer, blocker, minutes_stuck: 245 }
  ],
  headline: "1 Session stalled 4h; otherwise on track for 5 PM finish"
}
```

Renders client-side from two Firestore reads:
1. `service_assignments where service_date = today` (plan count)
2. `sessionsV2 where service_date = today` (actual state)

No projection collection needed at Pioneer's scale (~50-200 sessions/day even at 10×).

### VII.2 The single-glance card

```
Today · 12 planned · 5 done · 4 in flight · 1 stuck · 2 not started
Projected finish: 16:45 PT
⚠ Stuck: Riverside · Bonnie · 4h stalled  →
```

Nicholas H clicks the stuck row → Session Health card. Two clicks to Recovery.

### VII.3 Why this is different from Yesterday's Closeout

Yesterday's Closeout is a *retrospective count* — "how did we do?" Day Health is a *live projection* — "how are we doing right now, and when will we finish?" Different queries, different refresh cadences, different affordances.

---

## Part VIII — Recovery, deepened

### VIII.1 Confirming the four verbs

The existing arch doc's Recovery Toolbox is right:
- **Resume**: wake a stuck Session, tech continues
- **Recover**: admin fills missing data on tech's behalf
- **Supersede**: archive + create fresh
- **Archive**: cancel this Session

Design test: any operational recovery scenario should map to exactly one of these four. If a new scenario doesn't map, the framing is wrong, not the verb set.

Ten-year test: these four are stable. New business capabilities add new *components*, not new verbs.

### VIII.2 The missing fifth verb — Notify

Before any of the four state-changing verbs, the operator often just needs to *reach the tech*. Today this happens outside Mission Control (personal phone, text, Slack). That's fine for Pioneer's current scale but broken for the ten-year view:

- No audit trail of "we tried to reach Bonnie at 2:15 PM"
- No idempotency ("did I already text her?")
- No rate limiting ("Nicholas already texted her three times — cool it")

Proposal: fifth verb `Notify`.

```
notifySessionV1(session_id, channel: "sms" | "call" | "app_push", message: string, override_rate_limit: bool)
```

Behavior:
- Sends targeted comm to the tech associated with the Session
- Appends `admin.notify` Timeline entry with channel + message
- Does NOT change Session state
- Rate limit: 3 notifications per hour per Session per operator; overridable with reason
- Idempotency: (session_id, operator_uid, minute-truncated-ts) is the natural key

Notify is the recommended first verb 80% of the time. The Recovery panel foregrounds it accordingly.

### VIII.3 Recovery UX principle: the Session recommends the verb

The existing arch doc renders four buttons side-by-side. That's a menu; menus force the operator to choose. **Better**: the Recovery panel *recommends* a verb based on the Session's state, and the operator confirms or overrides.

Decision tree (derivable from Session state, no admin config needed):

| Session state | Signal | Recommended verb |
|---|---|---|
| `in_progress` + stalled 30m-2h + tech online | Just a lull | **Resume** |
| `in_progress` + stalled 2h+ + tech online | Tech distracted | **Notify** (primary), Resume (secondary) |
| `in_progress` + stalled 2h+ + tech offline | Tech unreachable | **Notify** (primary), Supersede (secondary) |
| `awaiting_completion` + DCR missing 15m+ | Tech forgot | **Notify** (primary), Recover (secondary) |
| `awaiting_completion` + DCR missing 60m+ + tech offline | Tech left without submitting | **Recover** (primary) |
| any state + admin decides re-do | Fresh start | **Supersede** |
| tech never should have started | Wrong stop | **Archive** |

The Recovery panel renders as:

```
┌──────────────────────────────────────────────────────┐
│ Recovery                                              │
│ Session: Riverside · Bonnie · stalled 4h              │
│                                                       │
│ ▸ RECOMMENDED  [ Notify Bonnie ]                     │
│                                                       │
│ Other options:                                        │
│   [ Resume ]  [ Recover ]  [ Supersede ]  [ Archive ]│
└──────────────────────────────────────────────────────┘
```

**Diverges from existing arch doc §8**: existing renders four side-by-side buttons. This design foregrounds one recommendation. Operator can still override. Menu is not removed — hierarchy is added.

### VIII.4 Recovery Timeline entries

Each verb appends exactly one Timeline entry:

| Verb | Event | Contents |
|---|---|---|
| Notify | `admin.notify` | channel, message (truncated), operator, delivery result |
| Resume | `system.recovery` | reason, operator |
| Recover | `admin.correction` | field diff (per-field from → to), operator |
| Supersede | `admin.supersede` | old session_id, new session_id, reason, operator |
| Archive | `admin.archive` | reason, operator |

Every recovery action is thereby auditable via Timeline alone. Ten-year test: yes.

### VIII.5 Verb idempotency

Every verb Cloud Function must be idempotent on retry — the network may double-fire. Idempotency keys:

- Notify: `(session_id, operator_uid, message_content_hash, minute_truncated_ts)`
- Resume: `(session_id, operator_uid, minute_truncated_ts)` — status transition is CAS-guarded by `status_version`
- Recover: `(session_id, request_body_hash)` — client generates a `client_request_id` on each attempt
- Supersede: `(session_id, minute_truncated_ts)` — already covered by supersede chain schema
- Archive: `(session_id)` — archive is monotonic

---

## Part IX — Push (Alerts)

The existing arch doc has zero push layer. Ten-year Pioneer will have on-call rotations, off-hours emergencies, and multi-persona alerting. Adding it now.

### IX.1 Push and pull are separate

- **Pull** (dashboards): operator opens the tab, reads state. Read cadence set by refresh interval.
- **Push** (alerts): system reaches out to a specific person when a specific Session state transition warrants it. No dashboard required.

Both read Session state through the same Component Contract. Neither writes. Alerts fire based on **transitions**, not standing state — a Session that's been `stalled` for 6 hours has already been alerted; the current alert is for Sessions that *just became* stalled.

### IX.2 Alert Cloud Function: `sessionsV2AlertOnStateChangeV1`

Firestore trigger on `sessionsV2` update. Diffs `before` vs `after`. Fires alerts per the `alert_config` collection.

```js
if (before.integrity == "ok" && after.integrity == "stalled") {
  fireAlert("session_stalled", session_id, ...);
}
if (before.components.customer_email.status != "failed"
    && after.components.customer_email.status == "failed") {
  fireAlert("customer_email_failed", session_id, ...);
}
// etc.
```

### IX.3 Alert routing (config-driven, not hard-coded)

New collection: `pioneer_config/alert_routes/{alert_type}`.

```js
{
  alert_type:            "session_stalled",
  channels:              ["sms", "slack"],
  recipients: {
    sms:    ["+1206...", "+1503..."],
    slack:  "#dispatch"
  },
  quiet_hours: {
    start:  "22:00",
    end:    "06:00",
    tz:     "America/Los_Angeles",
    override_for_severity: "critical"
  },
  rate_limit_per_hour:   5,
  cooldown_seconds_same_session: 3600,   // 1h before re-alerting on same session
  active:                true
}
```

Ten-year test: alert types (business events) evolve slowly; recipient lists and channels evolve constantly. Config-driven wins.

### IX.4 Alert types (initial set)

| Alert | Trigger | Severity | Default recipients |
|---|---|---|---|
| `session_stalled` | integrity ok → stalled | warning | dispatch SMS + Slack |
| `customer_email_failed` | email component → failed | warning | April email |
| `payroll_awaiting_backlog` | Kirby's approvable count > 20 | info | Kirby email (daily digest) |
| `tech_offline_mid_session` | `staff_online = false` + Session in_progress > 30m | critical | dispatch SMS |
| `period_close_reminder` | 24h before payroll period close | info | Kirby email |
| `dcr_upload_stall` | photos component `collecting` > 15m | warning | dispatch Slack |
| `problem_reported_critical` | components.problem.category = "safety" | critical | Nicholas H SMS + April email |

New alert types added via config, not code.

### IX.5 Alerts as first-class Session events

Every alert firing appends `system.alert_fired` Timeline entry on the affected Session:

```js
{
  event:      "system.alert_fired",
  title:      "Alert: session_stalled sent to dispatch",
  detail:     "Sent SMS to +1206... and Slack #dispatch at 14:32",
  field_path: "system.alerts",
  ref:        "alert_run_<uuid>"
}
```

This makes alerts observable in the Session Health card — operators can see *why* the on-call was paged and *what* the response was. Closes the audit loop.

### IX.6 Alert receiver acknowledgment

Every SMS / Slack alert includes a deep-link:
```
https://pioneer-dcr-hub.web.app/admin/sessions/{session_id}?src=alert_{run_id}
```
Click → MC V2 opens Session Health directly. Acknowledgment (open) is stamped in Timeline: `system.alert_acknowledged`. Un-ack'd alerts persist; ack'd alerts fade.

Rate-limits prevent alert-storming during real-world outages.

---

## Part X — Historical drill-down

Ten-year Pioneer will have millions of Sessions in cold storage. Operators, auditors, and legal will need to answer "what happened at Riverside on 2027-04-13?"

### X.1 Design choice: no separate historical app

Historical drill-down lives inside MC V2 as a single search interface. No sub-app, no separate URL, no separate schema. The Session collection is the historical record.

### X.2 Query shape

Direct read on `sessionsV2`:
```
where customer_id = <slug>
  and service_date >= <start>
  and service_date <= <end>
  and admin_removed = false
order by service_date desc
```

Indexes needed:
- `(customer_id ASC, service_date DESC, admin_removed ASC)` (already proposed in arch doc §3)
- `(staff_uid ASC, service_date DESC)` (already in SCHEMA composite indexes)

Session Firestore reads scale linearly with result set size. Search UX pages 20 at a time.

### X.3 Historical card in MC V2

```
┌─────────────────────────────────────────────────┐
│ SEARCH                                           │
│                                                  │
│  Customer:  [_______________]                    │
│  Tech:      [_______________]                    │
│  Date:      [ 2026-07-01 ] to [ 2026-07-01 ]    │
│                                                  │
│  Results (23):                                   │
│  ─────────────────────────                       │
│  2026-06-28 · Cedar LLC · Bonnie · Complete      │
│  2026-06-14 · Cedar LLC · Bonnie · Complete      │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

Click any result → Session Health card in **read-only historical mode** (no Recovery buttons on locked Sessions).

### X.4 Snapshot artifact (already reserved)

The existing SCHEMA reserves `sessionsV2/{id}/dcr_snapshots/{snapshot_id}` for frozen render output. Proposal: **at customer_email send time**, `renderSessionSnapshot()` output is written as a snapshot doc.

Why: config evolves. A checklist section renamed in 2027 shouldn't retroactively rename a 2026 Session's Timeline. Historical drill-down reads snapshot when Session data has evolved beyond its schema-at-that-time.

Snapshot writer is a Phase 39a slice (customer email pipeline), not MC V2 scope directly — but MC V2's historical view depends on it.

---

## Part XI — Ten-year design bets

### XI.1 What survives 10 years

- **Session as atomic unit** — reality is atomic; the model should be too
- **Uniform component shape** — new business = new components; no schema churn required
- **Timeline as canonical audit** — reads better than event logs, satisfies compliance
- **Component Contract as one module** — cheap to add capabilities
- **Projection collections** — the pattern is right; the specific collections evolve
- **Recovery verb model** (Notify + 4) — 80% of ops recovery is one of five actions

### XI.2 What evolves

- **Component set** — from 9 today (clock, gps, photos, checklist, supplies, problem, dcr, customer_email, payroll) to probably 12-15
- **Projection collections** — added when a card struggles; retired when patterns change
- **Personas** — the roles will exist; the people rotate
- **Push channels** — email + SMS + Slack today; voice, mobile push, WhatsApp likely later
- **Session types** — office_cleaning is 90% of today; new types added as Pioneer expands
- **Alert types** — added by config, not code

### XI.3 What we deliberately design against

- **Denormalization budget**: every flat field is a maintenance cost. `session.integrity` proposed in existing arch doc — pushback: keep it derived, avoid the sync-drift risk (see §XIII.6)
- **Recovery by mutation**: no operator flow ever writes to more than one Session document in one gesture. Supersede is the exception, and it's constrained (one archive + one create).
- **Per-persona apps**: one app, role-scoped tabs.
- **Global admin role**: role-scoped access from day one (Kirby can't see or trigger Recovery on sessions outside her permission set)
- **Cross-collection joins in read path**: MC V2 never joins Sessions + service_assignments in one query. Missed Shifts card is a client-side join over two independently indexed queries.

### XI.4 Multi-entity readiness (Phase 42+)

Reserved decision. Recommendation: add `entity_id` (default `"pioneer"`) to every Session at Phase 41+ so future multi-entity expansion doesn't require migration. Rules gate reads by `entity_id`. All projections partition by `entity_id`. Cheap to add now; expensive to add later.

**Not** in Phase 37 scope. Documented so future decisions don't accidentally paint us into a single-entity corner.

### XI.5 LLM-augmented triage (Phase 44+)

Ten-year Pioneer will likely have an LLM sit atop the Session read path:
- "Show me all Sessions where the tech reported a customer complaint about carpet cleaning" — natural-language query over Timeline + problem components
- "Summarize the last 30 days at Riverside" — LLM reads Sessions and produces a paragraph
- "Which techs are trending toward stalls?" — pattern recognition over Session state

MC V2's architecture supports this because Sessions are self-contained atomic units. The LLM never needs to reconstruct state from joins. Reads Sessions → summarizes.

Not in scope now, but architecture must not preclude it.

---

## Part XII — Migration ladder (Phase 37 revised)

The existing arch doc's Phase 37a–37k ladder is sound. Below is a revised ladder that incorporates this doc's additions.

### Pre-flight (Phase 37-pre) — the wiring

- **37-pre.1** — `sessionsV2-component-contract.js` module (canonical rubric §IV) + tests. This is a *pure module*; no production behavior change. Foundation for everything else.
- **37-pre.2** — `computeSessionHealth(session)` pure helper + tests, uses Component Contract. **DERIVED, not stored.**
- **37-pre.3** — Recovery Cloud Function stubs (return 501). Wiring for §VIII.
- **37-pre.4** — `sessionsV2AlertOnStateChangeV1` trigger stub + `alert_routes` collection rules (no active routes; no alerts fire). Wiring for §IX.

Deliberately dropped from existing doc §12: `session.integrity` flat field. See §XIII.6 pushback.

### Persona ladder

Ships one persona at a time. Each ships as a single-week slice or less.

- **37a — Nicholas H persona**: Today tab. Stalled card + Active Routes card + Day Health card. Recovery panel with Notify verb functional. Push alerts wired (session_stalled + tech_offline).
- **37b — April persona**: Customer tab. `customersV2_readiness` projection + trigger. Failed-email resend action. Cycle compliance card.
- **37c — Kirby persona**: Payroll tab. `sessionsV2_payroll_readiness` projection + trigger. Batch Approve action. Period close countdown.
- **37d — Nicholas K persona**: Systems tab. Queue backlog card, projection drift card, error log. Cloud Function health.

### Cross-persona ladder

- **37e — Session Health card**: shared across all personas. Reads Component Contract. Renders per §IV.4.
- **37f — Recovery verbs (Recover, Supersede, Archive)**: promote 37-pre stubs to production. Each verb one slice, per-verb feature flag.
- **37g — Historical search**: MC V2 search interface (§X). Direct queries on `sessionsV2`.
- **37h — Push alerts activation**: enable alert routes. One alert type at a time. Each has a soak week.

### Cleanup

- **37i — V1 Mission Control read-side deletion**: remove old alert code, old dashboard code, old orphan-DCR classifier code. Estimated 3000-4000 LOC deletion.
- **37j — Reconciliation Cloud Function deletion**: `reconcileV1V2ParityV1` deletes itself once no V1 reads remain.

### Total effort

~10 slices at ~1 week each = ~10 weeks calendar for the persona core, plus 3-4 weeks for cleanup. Comparable to the existing doc's estimate.

### Rollback surface

Every slice reversible via feature flag flip. Cleanup slices reversible via `git revert`. No flag day.

---

## Part XIII — Design tensions with existing arch doc (challenges)

Where this doc pushes back on the locked arch doc's design choices.

### XIII.1 One dashboard vs role-scoped tabs

- Existing: single scrollable page with 12 cards.
- This doc: single app, four role-scoped tabs (Today, Customer, Payroll, Systems).
- Tension: existing serves the "one person watches everything" case (small teams); this doc serves scale.
- Recommendation: **role-scoped tabs**. Single-page is fine at Pioneer's 2026 scale; role-scoped is required at 2036 scale, and the migration cost is minimal if done now.

### XIII.2 4 Recovery verbs vs 5 (adds Notify)

- Existing: Resume, Recover, Supersede, Archive.
- This doc: same + Notify.
- Tension: Notify doesn't change state; is it really "recovery"?
- Recommendation: **add Notify**. 80% of recovery attempts start with "reach the tech." Auditability alone justifies the verb.

### XIII.3 No push layer vs push subsystem (alerts)

- Existing: implicit — no alerts, dashboard is only surface.
- This doc: `sessionsV2AlertOnStateChangeV1` + `alert_routes` config.
- Tension: adds Cloud Function + trigger + config surface. Extra maintenance.
- Recommendation: **add push**. On-call ops at 10 PM cannot be dashboard-only.

### XIII.4 Materialized projections vs ad-hoc queries

- Existing (§12): lean ad-hoc.
- This doc: two new projections proposed (`sessionsV2_payroll_readiness`, `customersV2_readiness`).
- Tension: more triggers, more write amplification, more sync-drift risk.
- Recommendation: **projections for these two cases** because both list views scan 50-200 docs at 30s refresh — ad-hoc composite scans would burn read budget. Ad-hoc still preferred for one-off Session drill-in and historical search.

### XIII.5 Session-level completeness vs day-level Day Health

- Existing: Session Health card and per-tech Active Routes.
- This doc: adds Day Health at the top of Today tab.
- Tension: overlaps with the Right-Now strip in existing doc.
- Recommendation: **merge**. Day Health *is* the Right-Now strip, computed more precisely from the Component Contract.

### XIII.6 `session.integrity` flat field — pushback

- Existing (§2): adds `session.integrity` as a flat queryable field, maintained by trigger.
- This doc: does NOT add it.
- Tension: derived from `components.*.status`; not queryable in Firestore. Query pattern requires it.
- Recommendation:
  - Push back: `session.integrity` is derived from components. If we add it, we create a sync-drift risk (trigger drops one write → integrity is stale). SCHEMA principle #10 says "Completion is never persisted."
  - Alternative: for the "any expected component failed" query, add `integrity_derived` to the **projection collections** where it's needed (Payroll tab, Customer tab). Projections are already trigger-maintained — one more field is cheap. Never add derived data to `sessionsV2` itself.
- **This is the biggest structural disagreement with the existing arch doc.** Worth raising for decision.

### XIII.7 Component Contract as a shared module

- Existing: no explicit contract module; rules scattered across `deriveCompletion`, per-component code, and MC UI.
- This doc: one canonical module.
- Tension: adds one module + tests + versioning cost.
- Recommendation: **ship the module**. Every persona tab, every projection trigger, every alert reads from the same rubric. The alternative is drift.

### XIII.8 Assignment reads

- Existing (§6 note): assignments read allowed for Missed Shifts card only.
- This doc: same. But adds Day Health card which also reads assignments (for the planned-count denominator).
- Tension: adds one more assignment reader.
- Recommendation: **acceptable**. Missed Shifts and Day Health are both structurally plan-side questions. Constitution Rule 6 (assignments outside Operation One Truth) applies: reading is fine, writing is not.

---

## Part XIV — What this doc still does NOT design

Deferred, not forgotten:

- **Multi-tech Sessions**: `staff_uid` is single-tech. Handoff mid-shift is a future schema decision. Doesn't affect MC V2 architecture.
- **Customer-facing Session status page**: separate sub-app; reads snapshot artifacts. Out of MC V2 scope.
- **Tech-side view (`/work` redesign)**: symmetrical to MC V2 but tech-facing. Phase 36h+.
- **LLM query interface**: architecturally possible (see §XI.5), not designed here.
- **Full permission / role model**: role-scoped tabs are proposed here; the underlying auth model (per-persona claims, per-Session scopes) is a separate ticket.
- **Off-line MC V2**: MC V2 assumes network. Tech-facing apps handle offline. Ops managers work at desks or on strong signal.
- **Historical schema evolution**: snapshot artifact strategy is proposed; the versioning + migration story for snapshot format is deferred to Phase 39.

---

## Part XV — Guiding principle (Constitutional)

Mission Control never asks:

> "Where is the DCR?"

Mission Control asks:

> "What does this Session still need?"

Every card renders that question in a different vocabulary for a different persona:
- Nicholas H sees: "Which Sessions need dispatch attention?"
- April sees: "Which customers need my communication?"
- Kirby sees: "Which Sessions need my approval decision?"
- Nicholas K sees: "Which systems need my troubleshooting?"
- On-call sees only: "This Session needs someone right now" (via push).

Different questions, one Session model.

The Session becomes the truth. Mission Control becomes the window into that truth.

---

## Appendix A — Where this doc reconciles with `MISSION_CONTROL_V2_ARCHITECTURE.md`

| Existing arch doc says | This doc says | Direction |
|---|---|---|
| Materialized projections are a Rule 7 carve-out | Same, and adds 2 more projections | **extends** |
| `session.integrity` flat field | Compute on read; move flat to projections | **challenges** |
| Single scrollable dashboard | Role-scoped tabs | **challenges** |
| 4 Recovery verbs | 5 (add Notify) | **extends** |
| No push layer | Adds push (alerts + config) | **extends** |
| `deriveCompletion` per-component | Component Contract module | **extends & centralizes** |
| Session Health per Session | Adds Day Health per day | **extends** |
| Historical Lookup sub-app | Historical search inside MC V2 | **simplifies** |
| Phase 37a-k ladder (12 slices) | Reorganized around personas (10-14 slices) | **restructures** |
| Missed Shifts + Customer Coverage on main dashboard | Both move to Customer tab | **restructures** |

## Appendix B — Decisions this doc surfaces for confirmation

1. **`session.integrity` flat field: build it or skip it?** (§XIII.6) — recommendation: SKIP; use projection collections for the query patterns that need it.
2. **Role-scoped tabs or single dashboard?** (§XIII.1) — recommendation: role-scoped.
3. **Add Notify as 5th Recovery verb?** (§XIII.2) — recommendation: yes.
4. **Add push alerts subsystem now?** (§XIII.3) — recommendation: yes; wiring in 37-pre, activation in 37h.
5. **Build Component Contract module first?** (§XIII.7) — recommendation: yes; 37-pre.1 is the foundation.
6. **Assignment reads for Day Health card acceptable?** (§XIII.8) — recommendation: yes; already permitted for Missed Shifts, and the questions are structurally the same.
7. **Add `entity_id` reservation to Session schema now (default `"pioneer"`)?** (§XI.4) — recommendation: defer, but decide by Phase 41.

Each of these seven is independent. Reject / approve one at a time.

---

**End of document.**
