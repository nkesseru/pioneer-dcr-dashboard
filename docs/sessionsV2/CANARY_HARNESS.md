# SessionV2 Canary Harness

**Status (2026-06-26)**: Phase 35a sub-slice. Admin-only test harness for validating the SessionV2 dual-write pipeline without touching V1 payroll data, time_punches, active_service_sessions, customer emails, or DCRs.

**North Star alignment**: lets us iterate on SessionV2 Phases 35-40 without burning real assignments or accumulating immutable audit noise.

---

## Why it exists

The live clock-in canary path creates permanent `time_punches` rows (immutable by rule), V1 sessions that risk payroll contamination, and requires creating fenced `service_assignments`. That's too cumbersome for repeated validation cycles.

This harness exercises the same `sessionsV2-client.js` adapter and the same `createSessionV2` Cloud Function the production splice uses, but with `environment: "debug"` + `source: "canary"` so every artifact is permanently excluded from production-data flows.

---

## What it validates

| Phase 35a surface | Validated by harness |
|---|---|
| `sessionsV2-client.js` adapter loads, exports `PIONEER_SESSIONS_V2` | ✅ |
| `deriveSessionV2Id` deterministic format | ✅ |
| `pioneer_config/session_v2_dual_write` Firestore read | ✅ |
| Server flag `SESSION_V2_ENABLED` gate | ✅ |
| Allowlist gate (`isDualWriteEnabledForCurrentUser`) | ✅ |
| `createSessionV2` accepts `v1_session_id` cross-ref field | ✅ |
| Idempotent re-create returns existing doc | ✅ |
| `reconcileV1V2ParityV1` detects canary docs (and ignores them for prod parity) | ✅ |
| Cleanup function deletes ONLY `environment=debug AND source=canary` | ✅ |

## What it does NOT validate

| Surface | Why |
|---|---|
| The actual splice in `service-clock.js:clockIn()` | Harness calls the adapter directly, not via `clockIn()`. Code review + sanity log probe + one final live canary close this gap. |
| Real `v1_session_id` (real V1 doc exists) | Harness passes a fabricated UID; reconciliation will mark canary docs as `v1_not_found` — we filter those out by `source: "canary"`. |
| Real GPS / `captureGeo` timing | Harness skips entirely |
| Real `active_service_sessions` transaction race | Harness does not write V1 at all |
| Service Worker queue path (Phase 35c) | Not in Phase 35a scope |

---

## Architecture

```
[admin browser]
   /admin/SessionV2 Canary tab
        |
        +-- "Diagnose" button
        |     -> PIONEER_SESSIONS_V2.getConfig(true)
        |     -> isDualWriteEnabledForCurrentUser()
        |     -> typeof helper functions
        |
        +-- "Create canary session" button
        |     -> PIONEER_SESSIONS_V2.maybeDualWriteClockIn({
        |          environment: "debug",
        |          source:      "canary",
        |          v1_session_id: "canary_<rand>",
        |          assignment_id: "canary-asg",
        |          service_date:  <today>,
        |          ...
        |       })
        |     -> fetch(CREATE_SESSION_V2_URL, ...)
        |
        +-- "Re-create same" button (idempotency)
        |     -> same payload as above, expect created:false + idempotent:true
        |
        +-- "Read back" button
        |     -> Firestore client GET on deterministic id
        |
        +-- "Run reconciliation" button
        |     -> fetch(RECONCILE_URL, { lookback_hours: 1 })
        |
        +-- "Cleanup all debug canary docs" button
        |     -> fetch(CLEANUP_SESSION_V2_CANARY_URL, { dry_run: false })
        |
        +-- "Toggle dry_run" — preference for cleanup button (defaults true)
```

### Two-flag system
- `SESSION_V2_ENABLED` (server env on `createSessionV2`) — must be `true` for any V2 write to succeed
- `SESSION_V2_DEBUG_UI_ENABLED` (client mirror in `firebase-config.js`) — hides the admin tab when `false`

Both default `false`. Both must flip `true` for the harness to function.

---

## Security model

### Defense layers
1. **Admin role check** on the cleanup Cloud Function (`verifyStaffOrReject` + `staff.role === "admin"`)
2. **Cleanup function asserts every doc before delete**: `if (doc.source !== "canary" || doc.environment !== "debug") refuse to delete this doc`
3. **Cleanup function dry_run defaults to true** — operator must explicitly pass `{ dry_run: false }` to actually delete
4. **Admin tab visibility flag-gated** — UI hidden when `SESSION_V2_DEBUG_UI_ENABLED !== true`
5. **createSessionV2 still requires `SESSION_V2_ENABLED=true`** — harness can't write if the global flag is off
6. **All canary writes carry `environment: "debug"` + `source: "canary"`** — reconciliation/payroll/Mission Control/customer email all filter these out by design

### Cannot-happen analysis
- Cleanup function deletes production data: per-doc filter + per-doc assertion + admin gate + dry_run default
- Non-admin reaches harness: tab visibility flag + admin role check + CF role check
- Operator confuses harness with production flow: all payload fields hardcoded `environment=debug` `source=canary`; result pane shows these prominently
- Operator forgets cleanup: harmless; reconciliation filters canary docs out; payroll never reads V2 in Phase 35a anyway

---

## Runbook

### Enabling (per session)
1. Verify `SESSION_V2_ENABLED=true` in `functions/.env` and `createSessionV2` redeployed
2. Verify `pioneer_config/session_v2_dual_write` doc has `enabled: true` and admin's email in `allowed_emails`
3. Set `window.SESSION_V2_DEBUG_UI_ENABLED = true` in `firebase-config.js`, deploy hosting (preview channel preferred)
4. Open `/admin` as admin; click **SessionV2 Canary** tab

### Standard QA sequence (any time)
1. Click **Diagnose** → expect: helper loaded, config doc reachable, admin in allowlist
2. Click **Create canary session** → expect: `created: true`, deterministic id printed
3. Click **Re-create same** → expect: `idempotent: true`
4. Click **Read back** → expect: schema fields match SCHEMA.md
5. Click **Run reconciliation** → expect: summary includes canary doc count
6. Click **Cleanup all debug canary docs** (with `dry_run: true`) → expect: preview list shown
7. Toggle dry_run off, click **Cleanup** again → expect: deleted_count > 0
8. Click **Read back** → expect: 404 NOT_FOUND

### Disabling (after session)
1. Set `window.SESSION_V2_DEBUG_UI_ENABLED = false` in `firebase-config.js`, deploy hosting
2. Verify tab hidden
3. Optionally: set `SESSION_V2_ENABLED=false` in `functions/.env`, redeploy

---

## Files in this slice

| File | Purpose |
|---|---|
| `docs/sessionsV2/CANARY_HARNESS.md` | This doc |
| `functions/index.js` | NEW `cleanupSessionV2CanaryV1` |
| `public/lib/sessionsV2-client.js` | Extended `maybeDualWriteClockIn` to accept optional `environment` + `source` |
| `public/admin.html` | New `<section data-panel="sessionsv2-canary">` + tab pill |
| `public/admin/tab-sessionsv2-canary.js` | NEW — harness JS module |
| `public/admin.js` | Tab activator registration (flag-gated) |
| `public/admin.css` | Minimal styling |
| `public/firebase-config.js` | `CLEANUP_SESSION_V2_CANARY_URL` + `SESSION_V2_DEBUG_UI_ENABLED` (default false) |
| `test/sessionsV2.canary.test.mjs` | Functional tests |

## NOT touched
- `service-clock.js` (clock-in code path)
- `submitDcrV1`
- Payroll export
- Mission Control
- Customer email
- Add Shift
- `time_punches`, `active_service_sessions`, `pioneer_service_sessions`
