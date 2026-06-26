# SessionV2 Phase 34 — Implementation Plan

**Status (2026-06-26)**: Design locked. Implementation in progress.

**Authoritative schema**: see `docs/sessionsV2/SCHEMA.md`.

---

## Scope (final)

1. **`createSessionV2` Cloud Function** — admin-only HTTPS POST that creates a `sessionsV2/{id}` doc per the locked schema. Idempotent. Flag-gated.
2. **`SESSION_V2_ENABLED` env flag** — Cloud Function env var. Default `false` → function returns `503 SESSION_V2_DISABLED`. When `true`, processes requests.
3. **`SESSION_V2_DEBUG_UI_ENABLED` env flag** — separate flag (stamped into `firebase-config.js`) that controls visibility of the admin debug tab.
4. **Admin SessionV2 Debug tab** — single button under `/admin` that posts a hand-crafted payload to `createSessionV2`. Displays recently-created `environment: "debug"` sessions with their Timeline expanded.
5. **`reconcileV1V2ParityV1` stub** — Cloud Function that exists but does nothing until Phase 35. Logs "no V2 sessions to reconcile" and exits.
6. **Functional emulator tests** — `test/sessionsV2.create.test.mjs` covering flag-off, auth, validation, idempotency, doc shape.
7. **Updated rules + indexes** — `timeline` replaces `audit_log`; new indexes for `parent_route_id` + `environment`.

## Explicitly NOT in Phase 34

- Tech writes (Phase 35)
- DCR writes (Phase 36)
- Payroll reads (Phase 37)
- Mission Control reads (Phase 38)
- Customer email pipeline (Phase 39)
- V1 retire (Phase 40)
- Backfill (Phase 34b — separate slice)

---

## `createSessionV2` design

### Endpoint
- Method: `POST`
- URL: `https://us-central1-pioneer-dcr-hub.cloudfunctions.net/createSessionV2`
- Auth: Firebase ID token; admin role required
- Idempotency: deterministic `session_id`; duplicate POST returns existing doc

### Request payload

```
{
  // Required identity (server validates ID format)
  session_id:        string,                    // per SCHEMA.md format
  source:            "admin_manual" | "scheduled_shell" | "auto_recovery",
  session_type:      "office_cleaning" | "supply_delivery" | "inspection" | "admin_manual_recovery" | "other",
  staff_uid:         string,
  staff_email:       string,
  customer_id:       string,
  customer_slug:     string,
  customer_name:     string,
  service_date:      string (YYYY-MM-DD),
  attempt_number:    int >= 1,

  // Optional
  assignment_id:        string | null,
  location_id:          string | null,
  scheduled:            { start_window, end_window, sequence_planned, budget_minutes } | null,
  expected_components:  Array<string> | null,   // null = derive from session_type defaults
  environment:          "production" | "debug" | "emulator" | null,  // defaults to "production"
  client_session_id:    string | null,
  client_app_version:   string | null
}
```

### Response

| Code | Body | Trigger |
|---|---|---|
| `200` | `{ ok: true, session_id, created: true }` | New session created |
| `200` | `{ ok: true, session_id, created: false, idempotent: true }` | Existing non-archived session returned |
| `400` | `{ ok: false, error, field_errors[] }` | Invalid payload (with field-level errors) |
| `401` | `{ ok: false, error: "Sign-in required" }` | No / invalid auth |
| `403` | `{ ok: false, error: "Admin access required" }` | Authed but not admin |
| `409` | `{ ok: false, error: "Session ID conflicts with archived session" }` | Doc exists with `admin_removed: true` |
| `503` | `{ ok: false, code: "SESSION_V2_DISABLED", error: "Feature flag is off" }` | When `SESSION_V2_ENABLED != "true"` |

### Created doc shape (per SCHEMA.md)

Minimal valid SessionV2 at status `assigned`:

```
{
  session_id, schema_version: 2, source, environment, attempt_number, session_type,
  assignment_id, staff_uid, staff_email,
  customer_id, customer_slug, customer_name,
  service_date,
  scheduled: { ... },
  parent_route_id: "rt_<staff_uid>_<service_date>",
  expected_components: [...],
  components: {
    clock:          { status: <missing|not_applicable>, started_at: null, ... },
    gps:            { ... },
    photos:         { ... },
    checklist:      { ... },
    dcr:            { ... },
    customer_email: { ... },
    payroll:        { ... }
  },
  status: "assigned",
  status_changed_at: serverTimestamp,
  status_version: 1,
  admin_removed: false,
  timeline: [{
    ts:        serverTimestamp,
    actor:     { type, uid, email, name },
    event:     "session.created",
    title:     "Session created",
    detail:    "Session created by admin (<email>) for <customer_name> on <service_date>",
    icon:      "session-created",
    from:      null,
    to:        "assigned"
  }],
  refs: {
    photo_paths: [], dcr_id: null, dcr_submission_id: null,
    time_punch_ids: [], pending_queue_ids: [], email_message_ids: []
  },
  created_at:    serverTimestamp,
  created_by:    { type, uid, email, name },
  updated_at:    serverTimestamp,
  client_app_version: null,
  client_intent_at:   null
}
```

**Critical**: NO `payroll.*` subobject written at create time. NO `effective_*`. NO `supersedes_*`. These come later in the lifecycle (Phase 37 admin approve workflow).

### Server-side validation

- `session_id` matches one of three regex formats from SCHEMA.md
- `source`, `session_type`, `environment` are in their closed enums
- `service_date` is `YYYY-MM-DD`
- `attempt_number >= 1`
- `staff_uid` non-empty (Phase 35+ will check existence against `cleaning_techs`)
- `customer_slug` non-empty (Phase 35+ will check existence against `customers`)
- `expected_components` if provided is subset of canonical names
- For `source == "tech_clock"` or `source == "scheduled_shell"`: `assignment_id` required
- For `source == "admin_manual"`: `customer_slug` must be in session_id

### Idempotency

- If `sessionsV2/{session_id}` exists AND `admin_removed != true`:
    - If payload's `staff_uid + customer_slug + service_date` matches existing → return `200 idempotent`
    - If any of those don't match → return `409 conflict` (ID re-use error)
- If `sessionsV2/{session_id}` exists AND `admin_removed == true`:
    - Return `409 conflict` (caller must use different ID; never silently un-archive)

### Timeline-event seeding

The single `session.created` Timeline entry is added in the same write as doc creation. No Cloud Function trigger needed — Timeline is part of the create payload.

---

## Feature flag mechanics

### `SESSION_V2_ENABLED`

- Cloud Function env var, string `"true"` | `"false"`, default `"false"`
- Read at function invocation time (no cold-start cache lock)
- Update via `firebase functions:secrets:set` OR Cloud Run env edit + redeploy
- When `false`: function returns `503 { code: "SESSION_V2_DISABLED" }`
- When `true`: function processes admin requests normally

### `SESSION_V2_DEBUG_UI_ENABLED`

- Stamped into `public/firebase-config.js` as `window.SESSION_V2_DEBUG_UI_ENABLED = true|false`
- When `false`: admin tab pill hidden
- When `true`: admin tab pill visible (still only renders for admins)
- Separate from `SESSION_V2_ENABLED` — UI can be hidden even when function is on

### Default state at deploy

- `SESSION_V2_ENABLED=false` → function deploys but returns 503
- `SESSION_V2_DEBUG_UI_ENABLED=false` → no debug tab visible
- Verifies pipeline + auth gate + base routing without exposing write capability

### Flip procedure

1. Verify Phase 34 deployed; function returns 503 to authed admin
2. Set `SESSION_V2_ENABLED=true` via env update; redeploy
3. Smoke check: function returns 401 (unauth) instead of 503 (disabled)
4. Set `SESSION_V2_DEBUG_UI_ENABLED=true` in firebase-config; deploy hosting
5. Open debug tab; create a test SessionV2 with `environment: "debug"`
6. Verify doc shape via Firestore Console
7. Verify Timeline shows `session.created` entry
8. Phase 35 gate opens after 7-day no-issue soak

---

## Files to change

| File | Change |
|---|---|
| `functions/index.js` | New `createSessionV2` function (~300 LOC). New `reconcileV1V2ParityV1` stub (~30 LOC). |
| `firestore.rules` | Rename `audit_log` → `timeline` in tech-allowed update keys; ensure `environment` and `expected_components` allowed in create payload |
| `firestore.indexes.json` | Add `(parent_route_id, actual_sequence)` + `(environment, service_date)` composites |
| `test/sessionsV2.rules.test.mjs` | Update `audit_log` → `timeline` references |
| `test/sessionsV2.create.test.mjs` | NEW — functional tests for createSessionV2 |
| `public/firebase-config.js` | Add `window.SESSION_V2_DEBUG_UI_ENABLED = false` + `window.CREATE_SESSION_V2_URL` |
| `public/admin.html` | New panel `data-panel="sessionsv2-debug"` with create form + Timeline display |
| `public/admin/tab-sessionsv2-debug.js` | NEW — debug tab JS (~250 LOC) |
| `public/admin.js` | Register tab activator for `sessionsv2-debug` |
| `public/admin.css` | Styling for debug tab + Timeline display |
| `docs/sessionsV2/PHASE34_PLAN.md` | This doc |
| `docs/sessionsV2/PHASE35_READINESS.md` | NEW — gate checklist for Phase 35 |

NO changes to `service-clock.js`, `submitDcrV1`, `exportPayrollCsvV1`, Mission Control, `/work` UI, `/admin` Labor Review, or any other product surface.

---

## Deploy plan

1. Deploy rules + indexes first: `firebase deploy --only firestore:rules,firestore:indexes`
2. Deploy Cloud Functions: `firebase deploy --only functions:createSessionV2,functions:reconcileV1V2ParityV1`
3. Deploy hosting preview ONLY: `firebase hosting:channel:deploy sessionsv2-debug`
4. Verify smoke: function returns 503 to authed POST (flag off by default)
5. Verify debug tab visible only when `SESSION_V2_DEBUG_UI_ENABLED=true` (controlled via firebase-config.js — gitignored, so production hosting can stay flag-off)
6. NO production hosting promote in Phase 34 deploy
7. Phase 35 gate opens after 7-day soak

---

## Rollback plan

- Set `SESSION_V2_ENABLED=false`, redeploy function → all invocations 503
- Existing V2 docs harmless (no product readers in Phase 34)
- If V2 docs need full removal, manually delete via Admin SDK (rules deny client delete)
- Phase 33 rules + indexes already in production; no rollback needed there
- Debug tab hidden by flipping `SESSION_V2_DEBUG_UI_ENABLED=false` + hosting deploy

---

## Tests

### Rule regression (Phase 33 suite)
- All 61 existing tests pass after schema update (timeline rename, environment field allowed)

### New functional tests (`test/sessionsV2.create.test.mjs`)
- 503 when `SESSION_V2_ENABLED=false`
- 401 without auth
- 403 for non-admin
- 200 + `created: true` for admin with valid payload
- 200 + `idempotent: true` on duplicate POST
- 409 on archived session_id conflict
- 400 on invalid session_id format
- 400 on invalid source enum
- 400 on invalid environment enum
- 400 on session_type without matching expected_components when overrides invalid
- Created doc has correct Timeline entry (session.created event)
- Created doc has uniform components shape (all canonical keys present, status correct)

---

## Open questions (resolved before code)

| # | Question | Decision |
|---|---|---|
| 1 | Admin debug surface location? | New `/admin` tab "SessionV2 Debug", gated by `SESSION_V2_DEBUG_UI_ENABLED` |
| 2 | Separate UI flag from function flag? | Yes — `SESSION_V2_DEBUG_UI_ENABLED` is independent of `SESSION_V2_ENABLED` |
| 3 | Idempotency on archived conflict? | 409. Never silently un-archive. |
| 4 | Cleanup of debug docs? | Stamp `environment: "debug"`; reconciliation/payroll/MC filter on environment |
| 5 | Backfill of historical sessions? | Deferred to Phase 34b. Phase 34 stays inert + safe. |

---

## Estimated effort

| Component | Hours |
|---|---|
| Rules + indexes update + test regression | 1.0 |
| `createSessionV2` Cloud Function | 4.0 |
| `reconcileV1V2ParityV1` stub | 0.5 |
| Functional emulator tests | 2.0 |
| Admin Debug tab (HTML + JS + CSS) | 2.5 |
| Firebase config + URL wire | 0.5 |
| Deploy + smoke + Phase 35 readiness | 1.0 |
| **Total** | **~11.5 hours / ~1.5 dev days** |
