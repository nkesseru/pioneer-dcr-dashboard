# SessionV2 Snapshot Schema

**Status (2026-06-27)**: v1.0.0 — Phase 36a.1 shipped to preview.

**North Star**:

> The Session is the truth. A Snapshot is a deterministic projection of a Session at a moment in time. It carries no independent state.

A Snapshot is what you get when you call `renderSessionSnapshot(session)`. It is **not** a stored entity in Phase 36. The output of the renderer is consumed in three contexts:

1. **Admin canary** — admin renders a snapshot to inspect what V2 currently describes (read-only)
2. **Parity validation** (Phase 36a.2) — `submitDcrV1` renders a snapshot and compares against the V1 dcr_submissions row; divergences write `parity.diverged` Timeline entries
3. **Customer email body** (Phase 39+) — the email payload embeds the rendered snapshot (with `snapshot_version`) for audit + reproducibility

In none of these is a "snapshot document" stored on its own. The renderer is a pure function; storage of its output is always a downstream act in an object that already exists for another reason.

---

## Reproducibility invariant (the whole point of versioning)

For a fixed `snapshot_version`, the function `renderSessionSnapshot(session, options)` MUST satisfy:

```
forall session, options where options.generated_at_iso is fixed:
  renderSessionSnapshot(session, options) === renderSessionSnapshot(session, options)
```

(Byte-identical via `JSON.stringify`.)

This is what allows a customer email sent in 2026 to be re-rendered in 2030 from the historical Session state + the recorded `snapshot_version`, and produce identical output. Once a `snapshot_version` ships, its renderer is **frozen forever**. New features go in a new version.

Tests in `test/sessionsV2.snapshot.test.mjs` enforce this invariant.

---

## Version registry

| Version | Shipped | Renderer source | Notes |
|---|---|---|---|
| `v1.0.0` | 2026-06-27 (Phase 36a.1) | `public/lib/sessionsV2-snapshot.js` | Initial canonical shape. |

### Version bump policy

A new version is REQUIRED when:
- A field is added, removed, or renamed
- A field type changes
- The derivation algorithm for `derived.completion_pct` or `derived.blockers` changes
- Component projection rules change (e.g., new per-component fields)
- Normalization rules change (e.g., timestamp format)

A new version is NOT required when:
- Bug fix that ONLY affects edge cases impossible in production (e.g., handling a malformed input that has never appeared)
- Internal refactor that produces byte-identical output for every valid input

When in doubt, bump the version. Old renderers are kept side-by-side as `sessionsV2-snapshot-v1.js`, `sessionsV2-snapshot-v2.js`, etc., and the version dispatcher picks the right one.

---

## v1.0.0 — Field reference

### Top-level (closed set)

| Field | Type | Notes |
|---|---|---|
| `snapshot_version` | string | Always `"v1.0.0"` for this renderer |
| `generated_at_iso` | string (ISO 8601) | Caller-supplied via `options.generated_at_iso`, defaults to `new Date().toISOString()` at render call |
| `session_id` | string \| null | Echoes `session.session_id` |
| `session_source` | string \| null | Echoes `session.source` (`tech_clock` / `admin_manual` / etc.) |
| `session_status` | string \| null | Status at render time |
| `service_date` | string \| null | YYYY-MM-DD Pacific |
| `work` | object | See below |
| `components` | object | See below |
| `refs` | object | See below |
| `notes` | string \| null | `session.notes` (Phase 36+) |
| `derived` | object | See below |

### `work`

| Field | Type | Notes |
|---|---|---|
| `customer.id` | string \| null | |
| `customer.slug` | string \| null | |
| `customer.name` | string \| null | Denormalized display name |
| `staff.uid` | string \| null | |
| `staff.email` | string \| null | Lowercase |
| `clock_in_at_iso` | string (ISO 8601) \| null | Normalized from Firestore Timestamp \| Date \| ISO string \| ms epoch |
| `clock_out_at_iso` | string (ISO 8601) \| null | Same normalization |
| `effective_minutes` | int \| null | `session.effective_minutes` (admin overlay if present) |

### `components`

All 7 components always present in the output, even if the Session is missing some. Default status is `"missing"`.

```
components.clock          { status, started_at_iso, completed_at_iso }
components.gps            { status, started_at_iso, completed_at_iso }
components.photos         { status, started_at_iso, completed_at_iso, count }
components.checklist      { status, started_at_iso, completed_at_iso,
                            pct, items_total, items_complete }
components.dcr            { status, started_at_iso, completed_at_iso,
                            ref, last_event }
components.customer_email { status, started_at_iso, completed_at_iso,
                            ref, last_event }
components.payroll        { status, started_at_iso, completed_at_iso }
```

Component status enum: `not_applicable | missing | collecting | complete | failed | replaced` (matches `SCHEMA.md`).

### `refs`

| Field | Type | Notes |
|---|---|---|
| `refs.dcr_id` | string \| null | V1 dcr_submissions doc id |
| `refs.photo_paths` | array<string> | GCS paths, normalized; never null (empty array if none) |

### `derived` (computed at render — never persisted)

| Field | Type | Notes |
|---|---|---|
| `derived.expected_components` | array<string> | Echo of `session.expected_components` |
| `derived.completion_pct` | int | 0–100, computed from expected vs `components.*.status` |
| `derived.blockers` | array<string> | Each `"componentName:status"` (e.g., `"photos:collecting"`); empty array when 100% |

`derived.completion_pct === 0` when `expected_components` is empty (with `blockers: ["no_expected_components"]`). This is intentional — an "empty Session" cannot be 100% complete because completion is undefined.

`status === "complete"` AND `status === "not_applicable"` both count toward `completion_pct`. The latter handles cases where a session_type intentionally omits a component (e.g., supply_delivery has no DCR).

---

## Normalization rules

| Input shape | Output |
|---|---|
| Firestore `Timestamp` (has `.toDate()`) | `Date.toISOString()` |
| `Date` instance | `Date.toISOString()` |
| ISO 8601 string | Passthrough |
| Number (ms epoch) | `new Date(n).toISOString()` |
| `null` / `undefined` / invalid | `null` |
| Non-object `components` | Treated as empty object → all components default to `status: "missing"` |
| Non-array `refs.photo_paths` | Treated as empty array |
| Non-array `expected_components` | Treated as empty array → derived returns 0% + `["no_expected_components"]` |

The renderer NEVER throws. Adversarial inputs produce sane defaults. Tests cover the defensive paths.

---

## Field allowlist

The renderer is allowlist-driven, not blanket-serialize. Fields outside the allowlist are silently dropped. This prevents accidental leakage of internal fields (admin overlay payroll fields, supersede chain, debug telemetry) into customer-facing artifacts.

If a new field needs to be in the snapshot, it MUST be added to the renderer AND the version bumped.

---

## Anti-patterns (rejected designs)

### Why no `dcr_snapshots` subcollection?

Earlier drafts proposed `sessionsV2/{id}/dcr_snapshots/{snapshot_id}` for immutable audit. Rejected because:

1. The customer email itself is the audit record. Storing a separate `dcr_snapshot` doc duplicates what the email already carries. Two copies of one truth invite drift.
2. If no customer email is sent, there's no "delivered DCR" to immortalize — the Session itself is the record.

Replaced by: customer email body embeds the rendered snapshot inline with `snapshot_version`. Phase 39 wires this up.

### Why no `sessionsV2_parity_log` collection?

Earlier drafts proposed a collection to log V1↔V2 divergences. Rejected because Timeline already exists and is already the first-class log of "what happened to this Session." A parity divergence IS what-happened-to-this-Session. Adding a second history creates a mental-merge burden. See `parity.diverged` event in SCHEMA.md.

### Why no separate snapshot_version registry collection?

The registry IS this document plus the source file. Source-controlled, code-reviewable, deployed atomically with the renderer. A Firestore collection adds nothing.
