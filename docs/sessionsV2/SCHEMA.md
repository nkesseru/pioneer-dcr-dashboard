# SessionV2 Schema — Phase 33

**Status**: Schema landed 2026-06-25 (Phase 33). NO product writes. NO product reads. Inert. Backed by Firestore rules + composite indexes + Firebase Emulator rule-test suite. Slice 1 of Operation One Truth.

**North Star principle (every implementation decision must serve this)**:

> The Session becomes the truth. A Session is ONE customer stop / assignment / job. A workday is just a container view over multiple independent Sessions. Sessions are reorderable blocks.

See [[sessionsV2-architecture]] memory for the full 15-section architecture rationale.

---

## Collections (Phase 33 scope)

| Collection | Purpose | Phase 33 status |
|---|---|---|
| `sessionsV2/{session_id}` | **Primary** — one document per stop. Single source of truth for lifecycle, completion, payroll, supersede chain, audit. | Rules + indexes live; **no writers** |
| `sessionsV2_open/{session_id}` | Mirror of sessions in `in_progress \| paused \| awaiting_completion` only. Cheap Mission Control query target. | Rules live; mirror Cloud Function deferred to Phase 34 |
| `sessionsV2_active_by_tech/{staff_uid}` | Pointer to current open session per tech (max 1). Used by tech `/work` to resume. | Rules live; writer deferred to Phase 34 |
| `session_audit_log/{session_id}/entries/{entry_id}` | Overflow store when embedded `audit_log[]` > 50 entries. | Rules live; CF writer deferred to Phase 34 |
| `pending_session_writes/{queue_id}` | Unified offline queue (replaces `dcr_pending_uploads` + `pending_clock_events`). | Rules live; processor deferred to Phase 34 |

---

## Deterministic `session_id` strategy

Every Session has a content-addressable ID so the same logical stop converges to one document, even when the client is offline or two devices race.

### Format by origin

| Origin | Format | Example |
|---|---|---|
| Tech clock (organic) | `sess_<assignment_id>_<service_date>` | `sess_aJ8kf3pQ_2026-06-25` |
| Admin manual (Slice 1 today; will migrate at Phase 35) | `sess_manual_<staff_uid>_<service_date>_<customer_slug>` | `sess_manual_xbz4v8...PX92_2026-06-25_cedar-llc` |
| Reschedule same assignment same day (rare) | `sess_<assignment_id>_<service_date>_<seq>` where `seq >= 2` | `sess_aJ8kf3pQ_2026-06-25_2` |
| Auto-recovery (admin recreates lost session, Phase 35+) | `sess_recover_<original_id>_<epoch_ms>` | `sess_recover_aJ8kf3pQ_1735091200000` |

### Validation rules

- All four formats start with `sess_` (namespace guard against V1 collision)
- ASCII only; lowercase customer slugs and dates
- service_date format: `YYYY-MM-DD` (Pacific)
- assignment_id, staff_uid: opaque IDs from existing collections; trust their format
- seq: integer `>= 2` when present (first instance gets no suffix)
- Total length cap: 256 bytes (Firestore doc-id limit is 1500; we cap lower for sanity)

### Why deterministic
- **Offline-first**: client computes ID before any network round trip; writes locally; syncs later
- **Idempotency**: duplicate writes (network retry, two devices) hit the same doc
- **Reverse lookup**: any artifact carrying `session_id` can resolve its session without joining

---

## Field specification

### Identity (immutable after create)

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | yes | Matches deterministic ID format |
| `schema_version` | int | yes | Must be `2` |
| `source` | string | yes | One of: `tech_clock`, `admin_manual`, `auto_recovery`, `scheduled_shell` |
| `client_session_id` | string\|null | no | Device-generated UUID for offline reconciliation |

### Linkage (immutable after create)

| Field | Type | Required | Notes |
|---|---|---|---|
| `assignment_id` | string\|null | depends on source | Required for `tech_clock` / `scheduled_shell` |
| `staff_uid` | string | yes | Firebase Auth UID |
| `staff_email` | string | yes | Lowercase |
| `customer_id` | string | yes | Slug (matches `customers/{id}`) |
| `customer_slug` | string | yes | Denormalized copy of customer_id for clarity |
| `customer_name` | string | yes | Denormalized display name at create time |
| `location_id` | string\|null | no | If customer has multiple locations |
| `service_date` | string | yes | `YYYY-MM-DD` Pacific |

### Scheduled context (denormalized snapshot at create)

| Field | Type | Notes |
|---|---|---|
| `scheduled.start_window` | Timestamp\|null | Planned arrival window start |
| `scheduled.end_window` | Timestamp\|null | Planned arrival window end |
| `scheduled.sequence_planned` | int\|null | Intended order in workday (informational only — actual order can differ) |
| `scheduled.budget_minutes` | int\|null | Customer budget for this stop |

### Lifecycle (single source of truth)

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | yes | See state machine below |
| `status_changed_at` | Timestamp | yes | When current status was entered |
| `status_version` | int | yes | Monotonic counter; CAS guard for concurrent writes |

### Work timestamps

`clock_in_at` / `clock_out_at` are **immutable originals** — once written, never overwritten. Admin corrections go to `effective_*` overlay.

| Field | Type | Notes |
|---|---|---|
| `clock_in_at` | Timestamp\|null | Tech-clock origin or admin-manual initial value |
| `clock_out_at` | Timestamp\|null | Same |
| `paused_intervals` | Array<{start, end, reason}> | Append-only |

### Admin overlay (admin/CF writes only)

| Field | Type | Notes |
|---|---|---|
| `effective_clock_in` | Timestamp\|null | Admin-corrected in-time |
| `effective_clock_out` | Timestamp\|null | Admin-corrected out-time |
| `effective_minutes` | int\|null | Derived: ceil((effective_out - effective_in) / 60s) |

### GPS evidence

| Field | Type | Notes |
|---|---|---|
| `clock_in_gps` | `{lat, lng, accuracy_m, ts, status}` | Status: `verified`, `allowed`, `denied`, `unknown` |
| `clock_out_gps` | same shape | |
| `max_distance_from_site_m` | number | Computed during session |

### Components (OR-merge semantics — once true, stays true unless explicitly unset by admin)

| Field | Type | Notes |
|---|---|---|
| `components.clock_in_done` | bool | |
| `components.clock_out_done` | bool | |
| `components.photos_done` | bool | |
| `components.photos_count` | int | |
| `components.checklist_done` | bool | |
| `components.checklist_pct` | int | 0–100 |
| `components.dcr_done` | bool | |
| `components.dcr_status` | string\|null | `pending`, `submitted`, `waived`, `skipped` |
| `components.issues_logged_count` | int | |
| `components.customer_email_sent` | bool | |

### Computed completion

| Field | Type | Notes |
|---|---|---|
| `completion_pct` | int | 0–100. Recomputed on every component change by Cloud Function trigger (Phase 34+) |
| `blockers` | Array<string> | Human-readable "what's missing" list, e.g. `["DCR not submitted", "Photos missing"]` |

### Sub-references (pointers, not data)

| Field | Type | Notes |
|---|---|---|
| `refs.photo_paths` | Array<string> | GCS paths |
| `refs.dcr_id` | string\|null | FK to `dcr_submissions/{id}` |
| `refs.dcr_submission_id` | string\|null | Same as `dcr_id`; kept for back-compat |
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
| `payroll.payroll_state` | string | `pending_review`, `reviewed`, `approved_for_payroll`, `exported`, `voided` |
| `payroll.workweek_locked_by_export` | bool | |
| `payroll.approved_by` | `{uid, email, name}` \| null | |
| `payroll.approved_at` | Timestamp\|null | |
| `payroll.exported_in` | string\|null | `payroll_exports/{export_id}` |
| `payroll.exported_at` | Timestamp\|null | |

### Supersede chain

| Field | Type | Notes |
|---|---|---|
| `supersedes_session_ids` | Array<string> | Sessions this one replaces |
| `superseded_by_session_id` | string\|null | Session that replaced this one |
| `superseded_at` | Timestamp\|null | |
| `superseded_reason` | string\|null | |
| `admin_removed` | bool | Standard archive flag |

### Customer notification

| Field | Type | Notes |
|---|---|---|
| `customer.email_sent_at` | Timestamp\|null | |
| `customer.email_message_id` | string\|null | |
| `customer.email_template` | string\|null | |
| `customer.notification_state` | string | `pending`, `sent`, `failed`, `suppressed` |

### Audit log (append-only, capped at 50 entries)

Embedded array of:
```
{
  ts: Timestamp,
  actor: { type: "tech"|"admin"|"system", uid, email, name },
  event: <canonical event name>,
  field_path: string|null,
  from: any,
  to: any,
  note: string|null,
  client: { app_version, platform, network } | null
}
```

Overflow (>50 entries) moves to `session_audit_log/{session_id}/entries/{auto_id}`.

#### Canonical event names

```
session.created   session.status_changed   session.client_resumed
clock.in          clock.out                clock.intent_recorded
pause.start       pause.end
photos.uploaded   photos.deleted
checklist.updated checklist.completed
dcr.submitted     dcr.waived               dcr.skipped
issue.logged
payroll.approved  payroll.unapproved       payroll.exported  payroll.voided
customer.email_sent  customer.email_failed
admin.correction  admin.supersede          admin.recover  admin.archive
system.recovery   system.queue_drain       system.reconciliation_alert
```

### Provenance + bookkeeping

| Field | Type | Notes |
|---|---|---|
| `created_at` | Timestamp | |
| `created_by` | `{type, uid, email, name}` | |
| `updated_at` | Timestamp | |
| `client_app_version` | string | |
| `client_intent_at` | Timestamp\|null | Device-clock at write time; skew detection |

---

## State machine

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
              [all components.* true]
                       v
                   complete
                       v [admin approve]
              payroll_approved
                       v [email sent / suppressed]
              customer_notified
                       v [period lock]
                    locked
                       v [admin archive — rare]
                   archived

  ANY state ----[admin supersede / admin remove]----> archived
```

### Transition matrix

| From → To | Trigger | Who can do it |
|---|---|---|
| `assigned → ready` | Tech opens assignment | Tech (own) |
| `ready → in_progress` | clock_in event | Tech (own) / CF |
| `in_progress → paused` | Pause event | Tech (own) |
| `paused → in_progress` | Resume event | Tech (own) |
| `in_progress\|paused → awaiting_completion` | clock_out event | Tech (own) / CF |
| `awaiting_completion → complete` | All `components.*_done` true | CF trigger only |
| `complete → payroll_approved` | Admin approve | Admin / CF |
| `payroll_approved → customer_notified` | Email sent / suppressed | CF trigger |
| `customer_notified → locked` | Period lock | CF (lockPayrollPeriod) |
| `payroll_approved → complete` | Admin unapprove | Admin |
| `complete → awaiting_completion` | Admin "needs more" | Admin (rare) |
| `locked → payroll_approved` | Admin unlock period | Admin |
| ANY → `archived` | Admin supersede / remove | Admin |

### Tech-allowed transitions (enforced by Firestore rules)

Tech direct-write to `status` is permitted ONLY for:
- `assigned → ready`
- `ready → in_progress`
- `in_progress → paused`
- `paused → in_progress`
- `in_progress → awaiting_completion`
- `paused → awaiting_completion`

All other transitions require admin or Cloud Function.

### Forbidden once `locked`
Direct edits to `clock_in_at`, `clock_out_at`, `effective_*`, `payroll.*`, `components.*` are denied. Admin must explicitly unlock the period first (mirrors today's Phase 29E-B pattern).

### Forbidden once `archived`
All writes denied (`admin_removed === true` is the gate). Admin must un-archive first.

---

## Critical invariants (rule-enforced)

1. **Originals are immutable**: `clock_in_at` / `clock_out_at` / `work_minutes` never overwritten. Corrections live in `effective_*` overlay.
2. **Sessions are never deleted**: `allow delete: if false` on all sessionsV2 paths. Archive only.
3. **Locked sessions are read-only at field level**: rules block writes to time/payroll/components when `status == "locked"`.
4. **Tech cannot write payroll**: `payroll.*` and `effective_*` field paths denied to tech writers by rule.
5. **Schema version must be 2** at create time.
6. **Source must be in closed enum**: `tech_clock | admin_manual | auto_recovery | scheduled_shell`.
7. **No silent identity changes**: `staff_uid`, `assignment_id`, `customer_id`, `service_date`, `source`, `created_at`, `created_by` immutable after create.

---

## Composite indexes

| Collection | Fields | Use case |
|---|---|---|
| `sessionsV2` | `(status ASC, updated_at DESC)` | Mission Control stalled-session query |
| `sessionsV2` | `(staff_uid ASC, service_date DESC)` | Admin Labor Review per-tech view |
| `sessionsV2` | `(service_date ASC, payroll.payroll_state ASC, admin_removed ASC)` | Payroll export filter |
| `sessionsV2` | `(assignment_id ASC, service_date ASC)` | Uniqueness check at create |
| `sessionsV2_open` | `(staff_uid ASC)` | Tech /work resume query |
| `pending_session_writes` | `(status ASC, next_attempt_at ASC)` | Queue processor scan |

---

## What Phase 33 does NOT include (deferred to later phases)

- Tech `/work` UI writing to `sessionsV2` (Phase 34)
- Admin UI reading from `sessionsV2` (Phase 36/37)
- `submitDcrV1` stamping `session_id` (Phase 35)
- Photo upload appending to `refs.photo_paths` (Phase 35)
- Payroll export reading from `sessionsV2` (Phase 36)
- Mission Control "Incomplete Sessions" tile (Phase 37)
- Customer email Cloud Function trigger (Phase 38)
- Removal of V1 reconciliation logic (Phase 39)
- Backfill of historic V1 sessions into V2 (Phase 34 start)

## Phase 33 deliverables (this slice)

- [x] Schema specification (this document)
- [x] Firestore rules (`firestore.rules` block + helpers)
- [x] Composite indexes (`firestore.indexes.json`)
- [x] Emulator rule-test suite (`test/sessionsV2.rules.test.js`)
- [x] Optional inert `createSessionV2` Cloud Function (gated by `SESSION_V2_ENABLED=false`)
- [x] Phase 34 readiness checklist (`docs/sessionsV2/PHASE34_READINESS.md`)

No production behavior changes. No product wiring. No deploys until emulator QA passes.
