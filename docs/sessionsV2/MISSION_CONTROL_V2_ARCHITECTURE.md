# Mission Control V2 — Architecture

**Status (2026-06-30)**: ARCHITECTURE LOCKED — direction-of-travel for the Phase 37 ladder. No implementation. No production change.

**Governed by** [`OPERATION_ONE_TRUTH.md`](./OPERATION_ONE_TRUTH.md) (Constitution v1.0, 2026-06-29).

> Mission Control owns nothing.
> Mission Control observes Sessions.
> Everything displayed on Mission Control must be derivable from Session state.

This document is the architectural deliverable produced before Phase 37 begins. It establishes the design that the Phase 37a–37k slices will execute.

---

## 0. Constitution check first — the load-bearing question

Before designing anything, one rule needs explicit resolution:

> Rule 7 — *"No new document types. Every new concept becomes exactly one of: A Session Component or A Projection. If a proposed feature requires a brand new top-level collection, challenge the design first."*

MC V2's read-side performance plausibly requires materialized projection collections (e.g., `sessionsV2_open` already exists; we may need more). This document operates under the following clarification, not a change:

> **Projection collections are a permitted Rule 7 carve-out** because they OBSERVE Session state via triggers; they NEVER author. They are derivative state, exist only to make Session readable at scale, and self-delete when their source Session changes. They are not "second sources of truth" — they are pre-computed Session views.

This matches existing precedent (`sessionsV2_open`, `sessionsV2_active_by_tech` shipped in Phase 33–34 under this same logic).

Throughout this doc: **only Sessions are written; everything else is derived.**

---

## 1. Mission Control V2 architecture

```
                               sessionsV2/{session_id}                        ← THE truth
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
        sessionsV2_open       sessionsV2_by_route     sessionsV2_by_customer    ← projections (CF triggers maintain)
                │                      │                      │
                └──────────────┬───────┴──────────────────────┘
                               ▼
                       Mission Control V2 reader                                 ← observe only
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
          Live cards     Yesterday cards    Exception cards
                                                       │
                                                       ▼
                                              Recovery actions
                                                       │
                                                       ▼
                                          Cloud Function endpoints
                                          (Resume / Recover / Supersede / Archive)
                                                       │
                                                       ▼
                                       sessionsV2/{session_id}                  ← back to truth (writes via explicit verbs)
```

**Read path**: MC reads projection collections (fast, scoped). Falls through to direct `sessionsV2` queries for cards that need fields not in any projection.

**Write path** (Recovery only): MC never writes to `sessionsV2` directly. Operator clicks "Resume Session" → POST to a Recovery Cloud Function → CF writes `session.status` + Timeline entry → triggers update projections → MC re-renders.

**No V1 reads in MC V2 except**: a separate "Historical Lookup" sub-app for sessions older than the Phase 40 cutover date. Kept architecturally separate so MC V2 has zero V1-aware code, except for the single legitimate `service_assignments` reader described below.

---

## 2. Session query model

The eight access patterns MC V2 needs:

| Pattern | Query | Source |
|---|---|---|
| **Live operations** | "All open sessions today, sorted by `status_changed_at`" | `sessionsV2_open` mirror, filter by `service_date` |
| **Per-tech route** | "Today's sessions for this tech, in `actual_sequence` order" | `sessionsV2` `where staff_uid = X AND service_date = today ORDER BY actual_sequence` |
| **Customer coverage** | "Today's sessions for this customer" | `sessionsV2_by_customer` projection (NEW) |
| **Yesterday counts** | "Sessions where `service_date = yesterday`, grouped by status" | `sessionsV2` `where service_date = yesterday AND admin_removed = false` — counted by reader |
| **Stalled** | "Sessions `in_progress` past SLA" | `sessionsV2_open where status_changed_at < (now − 4h)` |
| **Failed component** | "Sessions where any component has failed" | Requires `session.integrity` flat field (NEW; Phase 37 prep) |
| **Recovery queue** | "Sessions that hit failed/stalled in last 24h" | `sessionsV2 where integrity in [degraded, stalled] AND service_date >= today−1` |
| **Session detail** | "One session + Timeline + components" | `sessionsV2/{id}` + `session_timeline/{id}/entries` |

### Critical schema additions Phase 37 needs

**Add `session.integrity` flat field**:
```
integrity: "ok" | "degraded" | "stalled" | "recovered"
```

Derivable from `components.*.status`, but flat fields are queryable (Firestore can't query "any nested field equals failed"). This is the smallest read-side ergonomic that makes MC fast.

Stamp via CF trigger on `sessionsV2.update` whenever components change. Always-derived; never authoritative.

**`Session Integrity Score`** (reserved in SCHEMA.md per Phase 35b) becomes ACTIVE in Phase 37. MC V2 reads this; never writes it.

---

## 3. Required indexes

Adds to `firestore.indexes.json`:

| Index | Collection | Fields | Use case |
|---|---|---|---|
| 1 | `sessionsV2_open` | `(service_date ASC, status_changed_at DESC)` | Live ops today, sorted by status moment |
| 2 | `sessionsV2_open` | `(staff_uid ASC, status_changed_at DESC)` | Per-tech live ops |
| 3 | `sessionsV2_open` | `(status ASC, status_changed_at ASC)` | Stalled-session detection |
| 4 | `sessionsV2` | `(service_date ASC, admin_removed ASC, status ASC)` | Yesterday counts by status |
| 5 | `sessionsV2` | `(service_date ASC, integrity ASC)` | Recovery queue lookup |
| 6 | `sessionsV2` | `(parent_route_id ASC, actual_sequence ASC)` | Route-ordered list (already exists from Phase 34) |
| 7 | `sessionsV2_by_customer` | `(customer_id ASC, service_date DESC)` | Customer coverage view (NEW projection) |
| 8 | `sessionsV2` | `(customer_id ASC, service_date DESC, admin_removed ASC)` | "All sessions at this customer, recent first" (admin drill) |

Phase 37 ships these incrementally — each card adds 0–1 indexes.

---

## 4. Firestore access patterns

### Read budget

Mission Control's "right now" view loads:
- 1 count query on `sessionsV2_open` (cheap)
- 1 list query on `sessionsV2_open where service_date = today` (typical: 20–80 docs for Pioneer scale)
- 1 list query on `service_assignments where service_date = today` (read of the plan — see Constitution Rule 6 note in §6)
- ~5 KPI count queries (cached client-side for 5 minutes)

Total: ~5–10 queries per page load. Compare with V1 which joins 4 collections per render. Substantial reduction.

### Materialized projections (maintained by CF triggers)

| Projection | Source | Trigger that maintains it | Why it exists |
|---|---|---|---|
| `sessionsV2_open` | sessionsV2 | onUpdate(sessionsV2) — populate when status enters open set; remove when leaves | Live operations needs fast scan; this is ~80 docs vs ~10k+ historical |
| `sessionsV2_active_by_tech` | sessionsV2 | Same trigger as `_open` | "Is this tech currently working?" answered in 1 read |
| `sessionsV2_by_customer` (NEW) | sessionsV2 | onUpdate(sessionsV2) — partition by customer_id, prune old entries (configurable retention) | Customer coverage card; admin drill-down |
| `sessionsV2_daily_rollup` (NEW, optional) | sessionsV2 | onWrite(sessionsV2) → debounced aggregation | If Yesterday's count queries become too slow at scale, swap to pre-aggregated doc per service_date |

`sessionsV2_daily_rollup` is **only** added when Pioneer's session count makes per-day counting via aggregation queries unacceptably slow. At current scale (tens of sessions per day) plain Firestore counts are fine. Reserved for future.

### Read modes

Phase 37 introduces a per-card config:
- `MC_CARD_STALLED_SESSIONS_SOURCE = "v2" | "v1" | "both"` — flag-gated per card
- Default through Phase 37 ramp: `v1` (existing behavior)
- After 37a canary: `both` (read both, compare in admin dashboard, log divergence — no UI change)
- After 7-day clean soak: `v2` (V1 reader retired)
- After 37 fully ships: per-card flags removed; V1 reader code deleted

This is the migration mechanism (see §11).

---

## 5. Dashboard layout

Single page. Scrollable. Mobile-first (Pioneer ops are sometimes managed from a phone in the field).

```
┌─────────────────────────────────────────────────────────────────┐
│ TOP STRIP — "Right now"                                          │
│ ┌─────────────────┬─────────────────┬───────────────────────┐   │
│ │  3 SESSIONS     │  1 STALLED      │  2 EXCEPTIONS         │   │  ← always-visible
│ │  IN PROGRESS    │  (>4h)          │  (failed components)  │   │     counts; tap for detail
│ └─────────────────┴─────────────────┴───────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│ TODAY — Active Routes (grouped by tech)                          │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Bonnie · 3 stops · 2 complete                              │ │
│ │  ✓ 9:02–10:14  Cedar LLC          100%                     │ │
│ │  ✓ 10:30–11:55 Acme Dental         92%  Lockup unchecked   │ │
│ │  → 12:10–…    Riverside Office    47%  Photos · 3 of 8     │ │
│ │                                                             │ │
│ │ Kiana · 4 stops · 1 complete                                │ │
│ │  ✓ 8:00–9:12  MacDonald-Miller    100%                     │ │
│ │  ⚠ 9:30–13:45 Novelis              31%  STALLED 4h+        │ │  ← bright color
│ │  ○ scheduled  Building X          ━     not started        │ │
│ │  ○ scheduled  Building Y          ━     not started        │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ SESSION HEALTH (when an active session is selected)              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Riverside Office · Bonnie · 12:10 PT                      │  │
│  │ Session 47%                                                │  │
│  │                                                            │  │
│  │ Missing:                                                   │  │
│  │  □ Lobby photos       (3 of 5 uploaded)                   │  │
│  │  □ Restroom photos    (0 of 2 uploaded)                   │  │
│  │  □ Lockup checklist   (untouched)                         │  │
│  │  □ Customer email     (queued, waiting on completion)     │  │
│  │                                                            │  │
│  │ Timeline: 8 events  →  view all                           │  │
│  │                                                            │  │
│  │ [ Resume ] [ Recover ] [ Supersede ] [ Archive ]          │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│ YESTERDAY'S CLOSEOUT                                             │
│  Assigned 12  ·  Started 12  ·  Completed 11  ·  Recovered 1     │
│  Avg completion: 1h 47m   Avg recovery: 24m                      │
│  Completion quality: 91% (10 of 11 reached payroll_approved      │
│  without an exception)                                           │
├─────────────────────────────────────────────────────────────────┤
│ EXCEPTIONS (7-day window)                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Yesterday · Acme Dental · Bonnie · DCR email failed       │ │
│  │   components.customer_email.status = failed                │ │
│  │   [ Re-send ]  [ View Session ]                            │ │
│  └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ KPI TREND (30-day)                                               │
│  ▒▒▓▓▓▒▒▓▓▓▓ Sessions per day                                   │
│  ▒▓▓▓▓▒▓▓▒▓▓ Average completion time                            │
│  ▒▒▒▓▓▓▓▓▓▓▓ Customer email send rate                           │
└─────────────────────────────────────────────────────────────────┘
```

What's deliberately absent:
- "DCR Missing" alerts — Session Health surfaces "what's missing" per Session naturally
- "Where's the photo?" alerts — Session Health lists photo blockers per Session
- "Sessions without DCR" — meaningless; the DCR IS the Session
- Cross-collection reconciliation banners — there is nothing to reconcile

---

## 6. Card definitions

| Card | Source | Refresh | Action affordance |
|---|---|---|---|
| **Right Now strip** (counts) | `sessionsV2_open` count queries | 30s | tap → drill to filtered view |
| **Active Routes** (per-tech) | `sessionsV2 where staff_uid = X AND service_date = today ORDER BY actual_sequence` | 30s + onUpdate listener | tap session → Session Health |
| **Session Health** | `sessionsV2/{id}` + `session_timeline` | onSnapshot listener (live) | Recovery action buttons |
| **Yesterday's Closeout** | `sessionsV2 where service_date = yesterday` aggregated | client-side cache 5m | tap → daily detail page |
| **Exceptions** | `sessionsV2 where integrity in [degraded, stalled] AND service_date >= today−6` | 5min | tap → Session Health on that session |
| **KPI Trend** | `sessionsV2 where service_date >= today−29` daily aggregates | client-side cache 1h | tap → KPI detail page |
| **Stalled card** | `sessionsV2_open where status_changed_at < (now − 4h)` | 1m | tap → Session Health |
| **Missed Shifts** | `service_assignments where service_date = today AND planned_start < (now − 30m)` minus `sessionsV2 where assignment_id IN (...)` | 1m | tap → assignment detail OR start session manually |
| **Customer Coverage** | `sessionsV2_by_customer where service_date = today` | 5m | tap → Session list for customer |
| **Tech Online** | count of distinct `sessionsV2_active_by_tech` docs | 30s | tap → tech list |
| **Recovery Queue** | `sessionsV2 where integrity in [degraded, stalled] AND admin_removed = false` | 1m | tap → Session Health (Recovery panel pre-opened) |
| **Parity Watch** (transitional — Phase 36 era; retires when reconciliation deletes) | `sessionsV2 where last_event = "parity.diverged" AND service_date >= today−6` | 5m | tap → Session detail + diff view |

**Note: "Missed Shifts" is the ONLY card that reads `service_assignments`.** Per Constitution Rule 6, **assignments are outside Operation One Truth scope for now** — they represent the **plan**; Sessions represent **reality**. This card is the canonical "plan vs record" view: it answers "which scheduled assignments haven't yet produced a Session?" — which is structurally a plan-side question and is the legitimate reason MC V2 touches `service_assignments`. Whether assignments themselves eventually migrate to an AssignmentsV2 model is a separate future decision and does not affect MC V2's design. All other cards are Session-only.

---

## 7. Session Health model

The Session Health card transforms the question:

| V1 question | V2 question |
|---|---|
| "Is the DCR missing?" | "What does this Session still need?" |
| "Did the photos upload?" | "What's the Session's photo state?" |
| "Why isn't payroll approved?" | "What components are blocking payroll readiness?" |

### Health computation

Pure function `computeSessionHealth(session)`:

```
{
  pct: int,                              // (complete components / expected components) × 100
  status_label: "On Track" | "Behind" | "Stuck" | "Failed" | "Done",
  blockers: [
    {
      component: "photos",
      label:     "Photos · 3 of 8 uploaded",
      severity:  "info" | "warning" | "blocking",
      action:    "wait" | "tap_to_assist" | null
    },
    {
      component: "checklist",
      label:     "Lockup · untouched",
      severity:  "blocking",
      ...
    }
  ],
  next_expected_event:  "tech to upload remaining photos" | "tech to clock out" | ...,
  integrity:            "ok" | "degraded" | "stalled" | "recovered"
}
```

### Severity mapping (designed once; never per-customer)

| Component state | Severity |
|---|---|
| `missing` and time-budget exceeded | **blocking** |
| `missing` and within time budget | **info** |
| `collecting` and slow (no progress > 10m) | **warning** |
| `failed` | **blocking** |
| `complete` | (not shown) |

### Sub-component granularity (Phase 36c–d enables)

Now that Phase 36c gives `components.photos.items[]` and Phase 36d gives `components.checklist.sections[]`, Health can drill DOWN:

```
□ Bathroom photos        (0 of 2 uploaded)            ← sub-bucket of photos
□ Lobby photos           (3 of 5 uploaded)            ← sub-bucket
□ Lockup                                              ← individual checklist item
□ Customer email                                      ← component-level
```

The grouping ("Bathroom" / "Lobby") is config-driven — comes from `dcr-form-config.js` photo tags (currently all `"general"`; future slice can add tags).

This is the operator-facing distinction between V1 ("DCR missing") and V2 ("3 specific things still needed"). Massive UX gain.

---

## 8. Recovery workflow

### Verb model (locked from `RECOVERY_TOOLBOX.md`)

Four operations. **No others ever exist.** "Fix DCR" / "Fix Clock" / "Fix Payroll" do not appear in MC V2.

| Verb | What it does | Session state transition | Audit |
|---|---|---|---|
| **Resume** | Wake a stuck session; tech retries the next missing thing | no status change; emits `system.recovery` Timeline event | actor + reason |
| **Recover** | Admin fills missing data on tech's behalf | components.X stamped by admin; `admin.correction` Timeline event | actor + field-by-field diff |
| **Supersede** | Archive old; create new Session with `supersedes_session_ids: [old]` | old → `archived`; new created at `assigned` | new session_id linked |
| **Archive** | Permanent removal from active workflow | `admin_removed = true`; status → `archived` | actor + reason |

Each verb is one Cloud Function:
- `resumeSessionV1` (HTTPS, admin)
- `recoverSessionV1` (HTTPS, admin, field-edit payload)
- `supersedeSessionV1` (HTTPS, admin; archives the named session, creates new one with same identity except `_a<n>` increment)
- `archiveSessionV1` (HTTPS, admin)

Auth: admin-only. Each writes Timeline. Each is idempotent on retry.

### Recovery workflow UX

When an operator opens Session Health and the Session is `degraded` or `stalled`:

```
┌─────────────────────────────────────────────────┐
│  Riverside Office · Bonnie                       │
│  Session 47%  ·  STALLED 4h                      │
│                                                  │
│  What happened:                                  │
│   Tech started 12:10. No event since 12:23.      │
│   Photos in progress (3 of 8). Checklist 0/12.   │
│                                                  │
│  Most likely cause:                              │
│   Bonnie offline OR phone died.                  │
│                                                  │
│  Recovery options:                               │
│   [ Resume      ] Tech will continue on phone    │
│   [ Recover     ] I'll fill what's missing       │
│   [ Supersede   ] Bonnie restarts the visit      │
│   [ Archive     ] Cancel this session            │
└─────────────────────────────────────────────────┘
```

Each button → CF call → Timeline appends → projections update → UI re-renders.

---

## 9. Performance considerations

### Scale assumptions (Pioneer at ~10× today)

- ~500 sessions / day
- ~150 active at any moment (multi-shift overlap)
- ~30 techs concurrent
- ~50 customers / day
- 5–10 ops managers loading dashboard simultaneously

### Hot reads and how they stay cheap

| Read | Cost without projection | Cost with projection | Verdict |
|---|---|---|---|
| Live ops top strip (3 counts) | 3 × COUNT on `sessionsV2` with filters | 3 × COUNT on `sessionsV2_open` (smaller collection) | Use projection |
| Active Routes per tech | `sessionsV2` query with composite index | Same query against `sessionsV2_open` (smaller scan) | Use projection if available; else direct |
| Yesterday counts | `sessionsV2` query — `service_date` is partition-friendly | None — direct query is fine | Direct |
| Stalled card | Filter on `sessionsV2_open` by `status_changed_at` | Same | Direct on projection |
| Customer coverage today | `sessionsV2 where customer_id + service_date` — needs composite index | `sessionsV2_by_customer` partition read | Use projection |

### Write amplification

Each session write triggers projection updates. Worst case:
- 1 session write
- + 1 `sessionsV2_open` upsert (if status entered/left open set)
- + 1 `sessionsV2_active_by_tech` upsert (if tech changed)
- + 1 `sessionsV2_by_customer` upsert (write goes to a specific partition)
- + 1 `session.integrity` flat-field stamp (in-place same write)

So worst case **5 writes per Session change.** Acceptable at Pioneer scale. Triggers are gen2 onDocumentWritten; sub-second.

### Client-side caching

Strict rules to keep the dashboard responsive without staleness:
- Live cards: 30s polling + Firestore `onSnapshot` listener on focused Session
- Yesterday/KPI cards: 5m and 1h respectively (data is stable)
- Aggressively invalidate on Recovery action (operator just changed something; refresh immediately)

### Failure modes

- Projection trigger drops one write → MC drifts by one session for that update. Self-healing via daily reconciliation job that scans `sessionsV2` and rebuilds projections. (NOT the parity reconciliation we're killing — this is INTRA-V2 self-healing, runs once daily, has no V1 dependency.)
- Index missing → query falls back to client-side filtering on smaller result set (degraded but functional).
- Cold cache → first page load slower; subsequent loads cached.

---

## 10. Migration plan (Phase 37a → 37k)

| Slice | Goal | Risk | Reversible |
|---|---|---|---|
| **37a** | Stalled-session card reads from V2 (in DUAL-READ mode — reads both, surfaces V2 result, logs divergence to admin-only sink for 7 days) | Low | UI flag toggles back to V1 in 1 line |
| **37b** | Stalled-session V1 reader retired after 37a soak | Low | revert commit |
| **37c** | Live Operations Right-Now strip reads from `sessionsV2_open` (dual-read soak) | Low | flag |
| **37d** | Active Routes card reads from V2 (per-tech listener) | Low | flag |
| **37e** | Session Health card built on V2 (the load-bearing new feature) | Medium | feature flag per operator |
| **37f** | Recovery action endpoints shipped (Resume/Recover/Supersede/Archive Cloud Functions) | Medium | each CF flag-gated |
| **37g** | Yesterday's Closeout card from V2 (V1 mirror card stays as historical-lookup sub-app) | Low | URL routes split |
| **37h** | Exceptions card from V2 (depends on `session.integrity` flat field shipping) | Low | flag |
| **37i** | KPI trend cards from V2 (read-side aggregations or `sessionsV2_daily_rollup` if needed) | Low | client cache + flag |
| **37j** | Missed Shifts card uses Sessions + reads `service_assignments` (assignments outside Operation One Truth scope for now — plan-side read is legitimate) | Low | flag |
| **37k** | MC V1 code DELETED. Reconciliation Cloud Functions DELETED. The "DCR Missing" alert class no longer exists. | High once landed; trivial to revert via git revert before the delete | reverts the deletion |

Each slice independently shippable. Each can soak. None creates a flag day.

### Pre-requisites (must ship before Phase 37 starts)

- **Phases 36c, 36d, 36e** — components must have full data (photos, checklist, issues+notes) so MC V2 has something to read
- **`session.integrity` flat field + maintenance trigger** — added in 37 prep (probably 37-pre slice)
- **Recovery Cloud Functions stubs** — admin-only, return 501 not_implemented until 37f wires the body

Optimistically: Phase 37 ladder is ~12 weeks calendar at one slice per week.

---

## 11. Rollback strategy

### Per-card rollback (Phase 37a–37j)

Every new V2 card has a feature flag (`MC_CARD_<NAME>_V2`). Default false during ramp. Each card independently switchable.

Rollback for one card → flip flag, redeploy hosting. No data migration, no schema change. ~5-minute rollback.

### Recovery action rollback (Phase 37f)

Each verb is a separate Cloud Function. To roll back one verb → `firebase functions:delete <verb>`. Operators lose that one action; MC degrades gracefully (button greyed with tooltip).

### Migration-wide rollback (Phase 37k — V1 deletion)

This is the only irreversible-without-restore slice. Mitigation:
- 37k is the LAST slice. By then all V1-readers have been independently soaked-and-replaced.
- Before 37k merges, all flag-toggles for V1 fallback are removed in a separate commit. Reviewers can verify no V1 dependency remains.
- The V1 deletion commit is a SEPARATE PR from any other change. Single-purpose. Easy to git revert.

### Schema rollback

`session.integrity` is a flat field added to existing docs. If we abandon it: the field becomes ignored. No data corruption. Trigger maintaining it gets disabled.

`sessionsV2_by_customer` projection: same. Disable trigger, ignore collection. Future cleanup can delete the collection.

No Firestore migration is irreversible.

---

## 12. Implementation slices (decomposed for Rule 10)

Below: every slice listed independently, sized for ~1 week or less.

**Phase 37-pre** — Prep (the "wiring" before any UI changes)
- 37-pre.1: Add `session.integrity` field to schema + maintenance trigger. Flag-gated (initially: writes go through but no reader).
- 37-pre.2: `computeSessionHealth(session)` pure helper + tests.
- 37-pre.3: Stub recovery Cloud Functions (return 501).

**Phase 37a** — First card on V2 (the proof-of-concept)
- 37a.1: Stalled-session card UI + dual-read implementation.
- 37a.2: Divergence logger sink for the dual-read soak.
- 37a.3: Soak 7 days, declare V2 source canonical, remove V1 reader.

**Phase 37b–37j** — Each card slice
- For each card listed in §6, one slice per card.
- Each follows same pattern: dual-read → soak → cutover → delete V1 reader.

**Phase 37 final** — Recovery actions
- 37-rec.1: `resumeSessionV1` body implementation + tests + canary harness button + admin canary.
- 37-rec.2: `recoverSessionV1` (admin-edit form). Larger UI.
- 37-rec.3: `supersedeSessionV1` (already partly implemented in Add Shift stash; reconcile).
- 37-rec.4: `archiveSessionV1`.

**Phase 37 close-out**
- 37k: V1 MC code deletion + reconciliation Cloud Functions deletion.

---

## Things this design DELETES from V1 (long-term, by Phase 37k)

| Code | Why it goes |
|---|---|
| `reconcileV1V2ParityV1` Cloud Function | No V1↔V2 to reconcile; Session is sole truth |
| `processSessionV2QueueV1` queue processor | Queue exists for V1 dual-write failures; no V1 to dual-write to |
| `sessionsV2_dualWriteFromDcrSubmit` helper | Same |
| All "orphan DCR" classifier code | No DCR without Session in a Session-owns-DCR world |
| All "missing X" join code in Mission Control | Session Health surfaces missing-X natively |
| `dcr_pending_uploads` shadow collection | Phase 31E mechanism; superseded by Session-native completion |

Total: probably 3000–4000 LOC deletion across `functions/index.js` + `admin/tab-mission-control.js` + `queue/`. Substantial codebase shrink.

---

## Strategic tradeoff to surface

The biggest design decision is **"materialized projection collections" vs "ad-hoc queries with composite indexes"**.

| | Materialized projections | Ad-hoc queries |
|---|---|---|
| Read latency | ~50ms (single-collection scan) | ~100–300ms (composite-index scan) |
| Write amplification | 3–5 writes per Session change | 1 write |
| Code maintenance | Trigger code per projection | None |
| Failure modes | Stale projection if trigger drops write | None |
| Constitution Rule 7 alignment | Requires the carve-out documented in §0 | Cleanest reading of Rule 7 |

**Recommendation**: lean ad-hoc-queries for Phase 37a–37e. Only add a materialized projection when a specific card's latency proves unacceptable. Existing `sessionsV2_open` and `sessionsV2_active_by_tech` are sufficient; defer `sessionsV2_by_customer` until customer coverage card actually struggles.

The Constitution's preference for "deleting code over adding code" applies here: fewer projection triggers = less code surface. We pay a small read-latency cost for cleaner architecture.

---

## What this design does NOT cover (deliberately)

- **Multi-tech sessions** (handoff with concurrent tech presence) — out of scope; `Session.staff_uid` is single-tech today; expanding to multi-tech is a future schema decision that doesn't impact MC V2.
- **AI assistance on Session Health** ("most likely cause" suggestions) — could be powered by historical Session embeddings + LLM. Out of scope for the architecture; could land in Phase 38+.
- **Tech-side view of "what's blocking my Session"** — currently in scope for the tech `/work` redesign (Phase 36h). MC V2's Session Health is admin-facing; tech-side is symmetrical but separate.
- **Customer-facing Session status page** — separate sub-app; reads only from Snapshot artifact (`sessionsV2/{id}/dcr_snapshots/{snapshot_id}` reserved subcollection). Out of MC V2 scope.

---

## Guiding principle

Mission Control never asks:

> "What happened to the DCR?"

Mission Control asks:

> "What does the Session still need?"

The Session becomes the truth.
Mission Control becomes the window into that truth.
