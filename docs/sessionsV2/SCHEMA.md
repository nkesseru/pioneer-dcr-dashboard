# SessionV2 Schema — Phase 33 Foundation + Phase 34 Design

**Status (2026-06-26)**: Phase 33 deployed to production (rules + indexes, no writers). Phase 34 design locked. This document is the canonical schema reference.

**North Star** (every implementation decision must serve this):

> The Session becomes the truth. A Session is ONE customer stop / assignment / job. A workday is just a container view over multiple independent Sessions. Sessions are reorderable blocks. Timeline is how humans understand Sessions.

---

## Lifecycle principle (revised 2026-06-26)

**Sessions are created when work actually begins — not when work is planned.**

```
Assignment exists                ← planned work (service_assignments)
       │
       │  Tech taps "Start Work"
       ▼
Session created                   ← actual work (sessionsV2) — this is the first durable record of reality
```

No-show signal lives on the **Assignment**, not on a missing Session. Mission Control reads BOTH collections: assignments-without-sessions = "tech missed scheduled work"; in-progress sessions stalled past threshold = "session stuck."

**Session ID is pre-computable**: even though the doc isn't created until Start Work, the `session_id` is content-addressable from `assignment_id + service_date + attempt_number`. The client computes the ID the moment it loads the assignment so offline writes can target it.

---

## Collections (Phase 33 + 34)

| Collection | Purpose | Phase 34 status |
|---|---|---|
| `sessionsV2/{session_id}` | **Primary** — one document per stop | Rules live; `createSessionV2` Cloud Function writes (flag-gated) |
| `sessionsV2_open/{session_id}` | Mirror of `in_progress \| paused \| awaiting_completion`. Cheap Mission Control queries. | Rules live; mirror trigger deferred to Phase 35 |
| `sessionsV2_active_by_tech/{staff_uid}` | Pointer to current open session per tech (max 1). | Rules live; writer deferred to Phase 35 |
| `session_timeline/{session_id}/entries/{entry_id}` | Overflow store when embedded `timeline[]` > 50 entries | Rules live; CF writer deferred to Phase 35 |
| `pending_session_writes/{queue_id}` | Unified retry queue. Populated when V2 dual-write fails (35a + 35b). Drained by `processSessionV2QueueV1` (35c). See doc shape below. | Rules live; processor shipped Phase 35c |

---

## Deterministic `session_id` strategy

Every Session has a content-addressable ID so the same logical stop converges to one document, even when the client is offline or two devices race.

### Format

| Origin | Format | Example |
|---|---|---|
| Tech-clock (organic, has assignment) | `sess_<assignment_id>_<service_date>_a<n>` | `sess_aJ8kf3pQ_2026-06-25_a1` |
| Admin-manual (no assignment) | `sess_manual_<staff_uid>_<service_date>_<customer_slug>_a<n>` | `sess_manual_xbz4v8...PX92_2026-06-25_cedar-llc_a1` |
| Auto-recovery (admin recreates lost session) | `sess_recover_<original_id>_a<n>` | `sess_recover_aJ8kf3pQ_2026-06-25_a1_a1` |

### Why this format
- **`assignment_id` is sufficient** when present — links to customer + location already. `customer_slug` is redundant for tech-clock and would cause ID drift if a customer is re-slugged.
- **`service_date`** scopes to a calendar day (Pacific midnight), needed for biweekly/monthly recurring customers.
- **`_a<n>` always present, starting at `_a1`**, including first attempt. Avoids forking codepaths between "first attempt" and "retry."
- **`attempt` is for genuine redo only**, NOT for supersede. Supersede archives + creates a new ID with `_a2`. Reschedule-mid-day = `_a2`. Routine clean = `_a1` forever.
- **`staff_uid` deliberately NOT in tech-clock ID**. A Session is ONE customer stop; the tech identity is a field, not part of identity. Tech-handoff mid-shift = same Session ID, timeline captures handoff.
- **`staff_uid` IS in admin-manual ID** because there's no assignment to anchor identity.

### Validation rules
- All formats start with `sess_` (namespace guard against V1 collision)
- ASCII only; lowercase customer slugs and dates
- service_date format: `YYYY-MM-DD` (Pacific)
- assignment_id, staff_uid: opaque IDs from existing collections; trust their format
- attempt: positive integer `>= 1`; always explicitly present as `_a<n>` suffix
- Total length cap: 256 bytes

### When `attempt` increments
- First time tech starts work on this assignment+date → `_a1`
- Tech aborts mid-session, admin marks failed, tech re-starts later same day → `_a2`
- Admin supersede → new manual session at `_a<next>` (NOT same as original's attempt)
- Normal biweekly clean two weeks later → different `service_date` so still `_a1`

---

## Field specification

### Identity (immutable after create)

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | yes | Matches deterministic ID format |
| `schema_version` | int | yes | Must be `2` |
| `source` | string | yes | `tech_clock` \| `admin_manual` \| `auto_recovery` \| `scheduled_shell` \| `canary` — describes HOW the session was created. `canary` is reserved for the Phase 35a debug harness; always paired with `environment: "debug"` |
| `environment` | string | yes | `production` \| `debug` \| `emulator` — describes WHERE the write happened; default `production`. Reconciliation/payroll/MC filter on this. |
| `attempt_number` | int | yes | Always `>= 1`, parsed from `_a<n>` suffix |
| `session_type` | string | yes | `office_cleaning` \| `supply_delivery` \| `inspection` \| `admin_manual_recovery` \| `other` — drives `expected_components` |
| `client_session_id` | string \| null | no | Device-generated UUID for offline reconciliation |

### Expected components (snapshot at create — historical sessions stay valid even if session_type defaults change later)

| Field | Type | Notes |
|---|---|---|
| `expected_components` | Array<string> | Subset of `["clock", "gps", "photos", "checklist", "dcr", "customer_email", "payroll"]`. Drives derived completion. |

#### `session_type` → `expected_components` defaults

| session_type | expected_components |
|---|---|
| `office_cleaning` | `clock, gps, photos, checklist, dcr, customer_email, payroll` |
| `supply_delivery` | `clock, gps, payroll` |
| `inspection` | `clock, gps, photos, checklist` |
| `admin_manual_recovery` | `clock, payroll` (admin decides on a per-session basis if more) |
| `other` | `clock, payroll` (minimum) |

Admin can override `expected_components` per-session at create or later.

### Linkage (immutable after create)

| Field | Type | Required | Notes |
|---|---|---|---|
| `assignment_id` | string \| null | depends on source | Required for `tech_clock` / `scheduled_shell` |
| `staff_uid` | string | yes | Firebase Auth UID |
| `staff_email` | string | yes | Lowercase |
| `customer_id` | string | yes | Slug (matches `customers/{id}`) |
| `customer_slug` | string | yes | Denormalized copy of customer_id for clarity |
| `customer_name` | string | yes | Denormalized display name at create time |
| `location_id` | string \| null | no | If customer has multiple locations |
| `service_date` | string | yes | `YYYY-MM-DD` Pacific |

### Route grouping

| Field | Type | Notes |
|---|---|---|
| `parent_route_id` | string | Deterministic: `rt_<staff_uid>_<service_date>`. No separate `routes/{id}` collection. |
| `scheduled.sequence_planned` | int \| null | Original planned order in the route |
| `actual_sequence` | int \| null | Order tech actually visited this stop (1 = first started, 2 = next, etc.); set when status transitions `ready → in_progress` |

Sessions on the same route are reorderable. `actual_sequence != scheduled.sequence_planned` is expected and fine. Mission Control should never assume planned order equals actual order.

### Scheduled context (denormalized snapshot at create)

| Field | Type | Notes |
|---|---|---|
| `scheduled.start_window` | Timestamp \| null | Planned arrival window start |
| `scheduled.end_window` | Timestamp \| null | Planned arrival window end |
| `scheduled.sequence_planned` | int \| null | (above) |
| `scheduled.budget_minutes` | int \| null | Customer budget for this stop |

### Lifecycle state (single source of truth)

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | yes | See state machine below |
| `status_changed_at` | Timestamp | yes | When current status was entered |
| `status_version` | int | yes | Monotonic; CAS guard for concurrent writes |

### Work timestamps

**`clock_in_at` / `clock_out_at` are immutable originals.** Admin corrections live in the `effective_*` overlay.

| Field | Type | Notes |
|---|---|---|
| `clock_in_at` | Timestamp \| null | Stamped when status transitions to `in_progress` |
| `clock_out_at` | Timestamp \| null | Stamped when status transitions to `awaiting_completion` |
| `paused_intervals` | Array<{start, end, reason}> | Append-only |

### Admin overlay (admin/Cloud Function writes only)

| Field | Type | Notes |
|---|---|---|
| `effective_clock_in` | Timestamp \| null | Admin-corrected in-time |
| `effective_clock_out` | Timestamp \| null | Admin-corrected out-time |
| `effective_minutes` | int \| null | Derived: `ceil((effective_out - effective_in) / 60s)` |

### GPS evidence

| Field | Type | Notes |
|---|---|---|
| `clock_in_gps` | `{lat, lng, accuracy_m, ts, status}` | Status: `verified \| allowed \| denied \| unknown` |
| `clock_out_gps` | same shape | |
| `max_distance_from_site_m` | number | Computed during session |

### Components (state machines, uniform shape)

Every Session has all component objects (uniform shape). Status starts at `not_applicable` for components not in `expected_components`. For expected components, status starts at `missing`.

```
components.<name> = {
  status:        "not_applicable" | "missing" | "collecting" | "complete" | "failed" | "replaced",
  started_at:    Timestamp | null,
  last_event_at: Timestamp | null,
  completed_at:  Timestamp | null,
  last_event:    string | null,           // canonical timeline event name (alignment with Timeline)
  error:         string | null,           // populated when status == "failed"
  count:         number | null,           // photos: how many uploaded
  pct:           number | null,           // checklist: percent complete
  ref:           string | null            // dcr_id, email_message_id, etc.
}
```

#### components.photos extensions (Phase 36c)

Phase 36c (Photos as Session Components — Operation One Truth Rule 2) adds embedded per-photo metadata, authored at upload time (not at DCR submit). Session is the ownership site for photo state.

```
components.photos = {
  status:           "not_applicable" | "missing" | "collecting" | "complete" | "failed" | "replaced",
  started_at:       Timestamp | null,
  last_event_at:    Timestamp | null,
  completed_at:     Timestamp | null,
  last_event:       "photo.uploaded" | "photos.batch_complete" | null,
  error:            string | null,
  count:            number | null,        // == items.length once Phase 36c writes are live
  pct:              null,
  ref:              null,
  // Phase 36c additions:
  items:            Array<PhotoEntry>,    // embedded; cap ~50 photos before considering subcollection
  primary_photo_id: string | null         // RESERVED — set by future slice; not authored in 36c
}
```

`PhotoEntry` shape (closed; new fields require SNAPSHOT_VERSION bump if rendered):

```
{
  photo_id:           string,             // client-generated UUID; idempotency key
  gcs_path:           string,             // "pioneerdcr/<...>/<filename>" — V2 path scheme
  uploaded_at:        Timestamp,
  uploaded_by_uid:    string,
  uploaded_by_email:  string,             // lowercase
  position:           int,                // 1-based order in tech's upload batch
  mime_type:          string,             // "image/jpeg" | "image/png" | etc.
  size_bytes:         int,
  status:             "uploaded"          // closed enum in Phase 36c; future: "failed" | "replaced"
}
```

State transitions on `components.photos` (Phase 36c):
- `missing` → `collecting` on first photo arrival (helper sets `started_at` + `last_event: "photo.uploaded"`)
- `collecting` → `collecting` on each subsequent upload (last_event_at advances, count++)
- `collecting` → `complete` on DCR submit (Phase 36a/b path — unchanged, still owned by trigger)

Idempotency: `photo_id` is the natural key. Re-upload of the same photo updates the existing entry rather than appending. Firestore transaction wraps read-modify-write.

`primary_photo_id` is RESERVED in Phase 36c — field exists with value `null`, but no writer sets it. Future slice can flip it to one of the `items[].photo_id` values to designate the customer-facing hero shot.

#### components.checklist extensions (Phase 36d)

Phase 36d (Checklist as Session Component — Operation One Truth Rule 2) replaces Phase 36a's thin checklist stamp (which silently mis-counted sections as items + assumed all items "done") with a full per-section, per-item projection authored at DCR submit time. The data flows through the existing `sessionsV2_dualWriteFromDcrSubmit` helper (called from both the inline `submitDcrV1` splice AND the `onDcrSubmissionCreatedV36b` trigger).

```
components.checklist = {
  status:           "not_applicable" | "missing" | "collecting" | "complete" | "failed" | "replaced",
  started_at:       Timestamp | null,
  last_event_at:    Timestamp | null,
  completed_at:     Timestamp | null,
  last_event:       "checklist.complete" | "checklist.updated" | null,
  error:            string | null,
  count:            null,
  pct:              int (0-100),                    // (items_complete / items_total) × 100, or 0 when items_total === 0
  ref:              null,
  // Phase 36d additions:
  items_total:      int,                            // count of items across all sections
  items_complete:   int,                            // count where status === "done"
  items_issue:      int,                            // count where status === "issue"
  items_na:         int,                            // count where status === "na"
  items_untouched:  int,                            // count where status was null / not yet answered
  sections:         Array<SectionSnapshot>          // see below
}
```

`SectionSnapshot` shape (closed; new fields require helper version bump):

```
{
  section_id:   string,
  items: Array<{
    item_id: string,
    status:  "done" | "issue" | "na" | "untouched",  // never null in projection
    note:    string | null                            // present only when status === "issue"
                                                      // (matches buildFormData's `status === "issue" && note.trim()` rule)
  }>
}
```

Deliberately excluded from `components.checklist.sections`:
- `section_label` (lives in `public/dcr-form-config.js`; storing per-session would bloat + drift if config changes)
- `item.label` (same reason)

State semantics at DCR submit:
- `status` is set to `"complete"` regardless of `pct` value — DCR submit is the canonical "tech declared this done" moment.
- `pct` reflects the **actual** percentage of items marked `"done"` — may be less than 100 when items are `"issue"`, `"na"`, or `"untouched"`. This is by design: status and pct are two different facts.

`checklist_config_version` is RESERVED at the session-top-level — initially `null`; future slice can stamp the config version that was active at submit time so historical sessions can be re-rendered against the right labels.

Per-item Timeline events are deliberately NOT emitted. Timeline is for STATE TRANSITIONS, not field-by-field captures; 40+ checklist toggles per DCR would create Timeline noise. The single existing `checklist.complete` event fires at DCR submit.

#### Component names (closed set)

```
clock           ← clock_in + clock_out as a single lifecycle
gps             ← GPS evidence collected on clock_in/out
photos          ← photo uploads
checklist       ← task checklist items
dcr             ← DCR submission / waiver
customer_email  ← outbound customer notification
payroll         ← payroll review + approval gate
```

### Derived completion (NOT persisted)

There is **no `completion_pct` field**. Completion is computed dynamically by a shared `deriveCompletion(session)` function imported by every reader (admin UI, Mission Control, payroll preview, Cloud Function triggers).

```
function deriveCompletion(s) {
  let expected = s.expected_components;
  if (!expected || !expected.length) return { pct: 0, blockers: ["no expected_components"] };
  let done = 0;
  let blockers = [];
  expected.forEach(c => {
    if (s.components[c]?.status === "complete") done++;
    else blockers.push(c + " (" + (s.components[c]?.status || "missing") + ")");
  });
  return { pct: Math.round(100 * done / expected.length), blockers };
}
```

**Why**: future changes to `expected_components` for a session_type should not retroactively invalidate historical Sessions. Persisted completion creates drift.

### Session Integrity Score (reserved — internal-only)

**Distinct concept from completion.** Integrity is an operational health indicator, not a progress percentage. A Session can be 0% complete and still have integrity OK (work hasn't started yet). A Session can be 90% complete and have integrity DEGRADED (a component failed mid-flight).

Derived (also not persisted) from `expected_components` + current component states:

| Integrity state | Trigger |
|---|---|
| `ok` | All expected components are in `missing`, `collecting`, or `complete` |
| `degraded` | Any expected component has `status: "failed"` |
| `stalled` | Session is in `in_progress` or `awaiting_completion` AND any expected component has been in `collecting` past its SLA threshold |
| `recovered` | After admin recovery (Phase 38+) the integrity flag tracks that the session passed through a recovery state |

**Mission Control surface (Phase 38+)**: instead of asking "is this DCR orphaned?" it asks "what is this Session missing?" — which is the integrity report. The exact thresholds + UI come in Phase 38; the concept is reserved now so the schema doesn't need changes when it lands.

**NOT exposed to users.** Internal operational use only. Future Mission Control surfaces it as "This Session is missing X" — never as a percent or letter grade.

### Sub-references (pointers, not data)

| Field | Type | Notes |
|---|---|---|
| `refs.photo_paths` | Array<string> | GCS paths |
| `refs.dcr_id` | string \| null | FK to `dcr_submissions/{id}` |
| `refs.dcr_submission_id` | string \| null | Same as `dcr_id`; kept for back-compat |
| `refs.time_punch_ids` | Array<string> | FK to immutable `time_punches/{id}` |
| `refs.pending_queue_ids` | Array<string> | Offline-queue records still draining |
| `refs.email_message_ids` | Array<string> | Sent customer email IDs |

### Payroll (admin / Cloud Function writes only)

| Field | Type | Notes |
|---|---|---|
| `payroll.work_minutes` | int | Final effective minutes |
| `payroll.paid_minutes` | int | |
| `payroll.paid_drive_minutes` | int | |
| `payroll.break_minutes` | int | |
| `payroll.regular_minutes` | int | OT engine output |
| `payroll.overtime_minutes` | int | OT engine output |
| `payroll.accrued_in_period_id` | string | e.g. `2026-06-B` |
| `payroll.payroll_state` | string | `pending_review` \| `reviewed` \| `approved_for_payroll` \| `exported` \| `voided` \| `excluded_from_payroll` |
| `payroll.workweek_locked_by_export` | bool | |
| `payroll.approved_by` | `{uid, email, name}` \| null | |
| `payroll.approved_at` | Timestamp \| null | |
| `payroll.exported_in` | string \| null | `payroll_exports/{export_id}` |
| `payroll.exported_at` | Timestamp \| null | |
| `payroll.excluded_reason` | string \| null | When `payroll_state == "excluded_from_payroll"` |

### Supersede chain

| Field | Type | Notes |
|---|---|---|
| `supersedes_session_ids` | Array<string> | Sessions this one replaces |
| `superseded_by_session_id` | string \| null | Session that replaced this one |
| `superseded_at` | Timestamp \| null | |
| `superseded_reason` | string \| null | |
| `admin_removed` | bool | Standard archive flag |

### Customer notification

| Field | Type | Notes |
|---|---|---|
| `customer.email_sent_at` | Timestamp \| null | |
| `customer.email_message_id` | string \| null | |
| `customer.email_template` | string \| null | |
| `customer.notification_state` | string | `pending \| sent \| failed \| suppressed` |

### Timeline (append-only, capped at 50 entries, first-class)

**Timeline is part of the Session itself — not a debugging feature.** Every state transition + every meaningful action emits a Timeline entry. Operators read Timeline to understand "what happened to this Session." Compliance/audit also reads Timeline. Future Mission Control, recovery tooling, and customer-facing receipts can all read from Timeline without needing a separate event log.

**Invariant**: every status transition MUST append a Timeline entry. The entry's `from` + `to` fields capture the transition. If a Cloud Function or client writes to `status` without appending Timeline, that is a defect — Timeline and status are co-equal sources of truth for "what happened, when."

Embedded array:
```
timeline = [
  {
    ts:           Timestamp,                                 // server time
    intent_ts:    Timestamp | null,                          // device clock at event (offline reconciliation)
    actor:        { type: "tech"|"admin"|"system", uid, email, name },
    event:        string,                                    // canonical event name (see below)
    title:        string,                                    // human-readable headline ("Tech started cleaning")
    detail:       string | null,                             // human-readable detail ("Bonnie clocked in at 8:02 AM, 12 m from site")
    icon:         string | null,                             // semantic key ("clock-in", "photo-upload", "warning")
    field_path:   string | null,                             // technical: which session field changed
    from:         any,                                       // technical: previous value
    to:           any,                                       // technical: new value
    ref:          string | null,                             // pointer to related artifact (photo_id, dcr_id, etc.)
    client:       { app_version, platform, network } | null
  },
  ...
]
```

Overflow (>50 entries) moves to `session_timeline/{session_id}/entries/{auto_id}`. Embedded array always shows the latest 50 in chronological order.

#### Canonical Timeline events (closed enum, human-first)

```
# Lifecycle
session.created            "Session created"
session.opened             "Tech opened assignment"
session.status_changed     "Status: <from> -> <to>"
session.client_resumed     "Tech resumed session after disconnect"

# Clock + GPS
clock.in                   "Tech started cleaning"
clock.out                  "Tech finished cleaning"
clock.intent_recorded      "Clock intent recorded (offline)"
pause.start                "Paused"
pause.end                  "Resumed"

# Components
photos.first               "First photo uploaded"
photo.uploaded             "Photo uploaded" (Phase 36c — singular; one event per individual photo, carries ref=photo_id)
photos.uploaded            "Photo uploaded" (legacy; superseded by photo.uploaded in Phase 36c)
photos.complete            "All required photos uploaded"
photos.deleted             "Photo deleted"
checklist.updated          "Checklist progress: <pct>%"
checklist.complete         "Checklist completed"
dcr.submitted              "DCR submitted to customer"
dcr.waived                 "DCR waived"
dcr.skipped                "DCR skipped"
issue.logged               "Issue logged"

# Payroll
payroll.review_ready       "Ready for payroll review"
payroll.approved           "Approved for payroll"
payroll.unapproved         "Approval reverted"
payroll.exported           "Sent to payroll export"
payroll.voided             "Payroll voided"
payroll.excluded           "Excluded from payroll"

# Customer
customer.email_sent        "Customer notified"
customer.email_failed      "Customer email failed"

# Admin actions
admin.correction           "Admin corrected <field>"
admin.supersede            "Superseded by manual session"
admin.recover              "Recovered by admin"
admin.archive              "Archived"
admin.expected_components_changed "Required components updated"

# System
session.locked             "Locked in payroll period"
system.recovery            "Auto-recovered from offline queue"
system.queue_drain         "Offline queue drained"
system.reconciliation_alert "Reconciliation alert raised"
```

Every state transition writes a `session.status_changed` Timeline entry. Every state transition is observable to operators without reading code.

### Provenance + bookkeeping

| Field | Type | Notes |
|---|---|---|
| `created_at` | Timestamp | |
| `created_by` | `{type, uid, email, name}` | |
| `updated_at` | Timestamp | |
| `client_app_version` | string | |
| `client_intent_at` | Timestamp \| null | Device-clock at write time; skew detection |

---

## State machine (with `pending_payroll_review` and Timeline)

```
                 [admin schedule]
                       v
                  +- assigned -+
   [tech opens] --|            |
                  +-> ready ---+
                       v [clock_in]
                  in_progress <----+
                       |           |
                  [pause]          | [resume]
                       v           |
                    paused --------+
                       |
                  [clock_out] (from either)
                       v
              awaiting_completion
                       |
              [all expected components complete]
                       v
                   complete
                       v [auto on entering complete]
            pending_payroll_review     <-- explicit no-auto-approval gate
                       v [admin approve from Labor Review]
              payroll_approved
                       v [payroll export]
                    exported
                       v [email sent / suppressed]
              customer_notified
                       v [period lock]
                    locked
                       v [admin archive — rare]
                   archived

  ANY state ----[admin supersede / admin remove]----> archived
```

**Every transition emits a Timeline entry**: `event: "session.status_changed"`, `from: <prev>`, `to: <next>`, plus a human title. Operators see the lifecycle without reading code.

### Tech-allowed transitions (rule-enforced)

Tech direct-write to `status` is permitted ONLY for:
- `assigned → ready`
- `ready → in_progress`
- `in_progress → paused` *(reserved; pause/resume not implemented through Phase 35b)*
- `paused → in_progress` *(reserved)*
- `in_progress → awaiting_completion`
- `paused → awaiting_completion` *(reserved)*

All other transitions require admin or Cloud Function. The `complete → pending_payroll_review` transition is CF-trigger only (auto on all-components-complete).

### Reserved states (locked 2026-06-26)

`paused` is **reserved** in the lifecycle model but not yet wired into any production path. Phase 35b (clock-out dual-write) deliberately skips pause/resume implementation to keep the slice small. The state appears in the state machine, the transition matrix, and the rule allowlist now so that a future Phase 35b-2 (or later) can light it up without schema changes, rule changes, or migration. **Do not write `paused` from any product code until that slice ships.**

### Transition matrix (full)

| From → To | Trigger | Who can do it |
|---|---|---|
| `assigned → ready` | Tech opens assignment | Tech (own) |
| `ready → in_progress` | clock_in event | Tech (own) / CF |
| `in_progress → paused` | Pause event | Tech (own) |
| `paused → in_progress` | Resume event | Tech (own) |
| `in_progress\|paused → awaiting_completion` | clock_out event | Tech (own) / CF |
| `awaiting_completion → complete` | All expected components have `status = complete` | CF trigger only |
| `complete → pending_payroll_review` | Auto on entering `complete` | CF trigger only |
| `pending_payroll_review → payroll_approved` | Admin clicks Approve in Labor Review | Admin only |
| `payroll_approved → exported` | Payroll export CSV run | CF (`exportPayrollCsv`) |
| `exported → customer_notified` | Email sent / suppressed | CF trigger |
| `customer_notified → locked` | Period lock | CF (`lockPayrollPeriod`) |
| `payroll_approved → pending_payroll_review` | Admin unapprove | Admin |
| `pending_payroll_review → complete` | Admin "needs more" | Admin (rare) |
| `locked → payroll_approved` | Admin unlock period | Admin |
| ANY → `archived` | Admin supersede / remove | Admin |

### Forbidden once `locked`
Direct edits to `clock_in_at`, `clock_out_at`, `effective_*`, `payroll.*`, `components.*` denied at the rule layer. Admin must explicitly unlock the period first.

### Forbidden once `archived`
All writes denied (`admin_removed === true` is the gate). Admin must un-archive first.

---

## Critical invariants (rule-enforced)

1. **Originals are immutable**: `clock_in_at` / `clock_out_at` / `work_minutes` never overwritten. Corrections live in `effective_*` overlay.
2. **Sessions are never deleted**: `allow delete: if false` on all sessionsV2 paths. Archive only.
3. **Locked sessions are read-only at field level**: rules block writes to time/payroll/components when `status == "locked"`.
4. **Tech cannot write payroll**: `payroll.*` and `effective_*` field paths denied to tech writers by rule.
5. **Tech cannot write `environment`**: must default to `production`. Only Cloud Function / admin can set `debug` or `emulator`.
6. **Schema version must be 2** at create time.
7. **Source must be in closed enum**: `tech_clock \| admin_manual \| auto_recovery \| scheduled_shell`.
8. **Environment must be in closed enum**: `production \| debug \| emulator`.
9. **No silent identity changes**: `staff_uid`, `assignment_id`, `customer_id`, `service_date`, `source`, `session_type`, `attempt_number`, `parent_route_id`, `created_at`, `created_by` immutable after create.
10. **Completion is never persisted**: no `completion_pct` field; derived at read time.
11. **No auto-approval to payroll**: `complete → pending_payroll_review` is the gate (lesson from 2026-06-25 incident); admin must explicitly approve.
12. **Timeline is append-only**: existing entries never modified; new entries appended.

---

## Composite indexes (Phase 33 + Phase 34 additions)

| Collection | Fields | Use case |
|---|---|---|
| `sessionsV2` | `(status ASC, updated_at DESC)` | Mission Control stalled-session query |
| `sessionsV2` | `(staff_uid ASC, service_date DESC)` | Admin Labor Review per-tech view |
| `sessionsV2` | `(service_date ASC, payroll.payroll_state ASC, admin_removed ASC)` | Payroll export filter |
| `sessionsV2` | `(assignment_id ASC, service_date ASC)` | Uniqueness check at create |
| `sessionsV2` | `(parent_route_id ASC, actual_sequence ASC)` | Today's route view, sorted by visit order — **NEW Phase 34** |
| `sessionsV2` | `(environment ASC, service_date ASC)` | Reconciliation filter (`environment != "debug"`) — **NEW Phase 34** |
| `sessionsV2_open` | `(staff_uid ASC, updated_at DESC)` | Tech /work resume query |
| `pending_session_writes` | `(status ASC, next_attempt_at ASC)` | Queue processor scan |

### `pending_session_writes/{queue_id}` field shape

```
{
  queue_id:        string,                              // doc id mirror
  session_id:      string,                              // target SessionV2 doc
  event_type:      "v2.create.retry" | "v2.clockout.retry",
  event_id:        string,                              // deterministic; idempotency key
  payload:         object,                              // full request body for the downstream CF
  status:          "queued" | "uploading" | "failed_will_retry" | "applied" | "failed_permanent",
  attempt_count:   number,                              // 0 on first enqueue
  next_attempt_at: Timestamp,                           // serverTimestamp on enqueue; processor advances per backoff schedule
  last_error:      string | null,                       // last failure summary (max 500 chars)
  staff_uid:       string,                              // auth gate for tech-create
  intent_ts:       Timestamp,                           // when the original V1 write completed
  device:          { app_version, platform } | null,
  enqueued_at:     Timestamp,
  applied_at:      Timestamp | null,                    // set on success
  failed_at:       Timestamp | null,                    // set on dead-letter
  origin_operation: "clockin.dual_write"                // NEW Phase 35c — diagnostic only
                  | "clockout.dual_write"
                  | "canary.harness"                    // future: "addshift.dual_write", "reconcile.auto_repair"
                  | string                              // open for future enum additions
}
```

**Backoff schedule** (Phase 35c): 1m, 5m, 15m, 30m, 60m between attempts. After 5 attempts → `failed_permanent`. Processor invocation cap: 25 entries per call.

**`origin_operation`** is a diagnostic field stamped at enqueue time. Identifies WHICH upstream operation produced the failed write. Processor does NOT branch on it. Used by admin to answer "which surface is producing the most retries?" Closed enum today; new values added in their owning phase.

---

## Phase 33 completed deliverables

- Schema (this document)
- Firestore rules (5 collection blocks + 3 helpers)
- 6 composite indexes
- 61 emulator rule tests
- Deployed to production 2026-06-25 (`firebase deploy --only firestore:rules,firestore:indexes`)
- Zero writers — collection is inert

## Phase 34 scope (this slice)

- `createSessionV2` Cloud Function (admin-only, flag-gated, idempotent)
- `SESSION_V2_ENABLED` Cloud Function env flag (default `false` → 503)
- `SESSION_V2_DEBUG_UI_ENABLED` flag for the admin debug tab
- `reconcileV1V2ParityV1` Cloud Function stub (logs "no V2 sessions to reconcile" until Phase 35)
- `/admin` SessionV2 Debug tab (flag-gated) — single create button + recent debug sessions list with Timeline expanded
- Rules updated: `timeline` replaces `audit_log`; `environment` and `expected_components` field gates added
- 2 new composite indexes (`parent_route_id`, `environment`)
- Functional emulator tests for `createSessionV2`
- Admin debug-stamped sessions get `environment: "debug"` and are filtered out by reconciliation/payroll/Mission Control queries

## What Phase 34 does NOT include (deferred to later phases)

- Tech `/work` writing to V2 (Phase 35)
- `service-clock.js` modifications (Phase 35)
- `submitDcrV1` modifications (Phase 36)
- Photo upload modifications (Phase 36)
- Payroll export reader (Phase 37)
- Mission Control reader (Phase 38)
- Customer email pipeline (Phase 39)
- Removal of V1 reconciliation logic (Phase 40)
- Backfill of historic V1 sessions (Phase 34b — separate slice after createSessionV2 verified safe)
