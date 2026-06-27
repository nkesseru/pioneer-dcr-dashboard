# SessionV2 Recovery Session Toolbox — Architectural Direction

**Status (2026-06-26)**: architectural direction only. NO implementation in Phase 35b.

**Phase target**: Phase 38 (Mission Control reads SessionV2) and beyond.

---

## Why this doc exists

The pre-SessionV2 admin model is built around "force" verbs: force-close a stuck session, force-reset DCR state, force-archive a record. These verbs are mechanical operations on disconnected records. They reflect the architecture they live in — reconcile and override.

SessionV2 reframes the same operational needs as **named recoveries on a Session**. A Session is a coherent unit. When it goes wrong, the admin's job is not to mutate one row; it is to choose how to recover the Session as a whole.

This doc reserves the toolbox concept now so that Phase 38+ Mission Control surfaces, admin tooling, and Cloud Function endpoints all converge on the same shape.

---

## The toolbox (named operations)

| Operation | Semantics | Replaces today's... |
|---|---|---|
| **Resume** | Re-open a Session that was incorrectly marked complete. Returns it to `in_progress` (or `awaiting_completion` if clock-out was real). Timeline appends `admin.recover` with reason. | Manual Firestore edits to undo a status change |
| **Finish** | Force a Session to `awaiting_completion` even if components are incomplete. Captures a reason that's surfaced to whoever later reviews. Timeline appends. | Force-closing a stuck session via the existing Labor Review modal |
| **Recover** | The session existed in reality but the records are broken (lost device, network blackout, etc.). Admin enters known facts (clock_in_at, clock_out_at, components actually completed), Cloud Function rebuilds the Session from those facts. Timeline appends `admin.recover` with the full delta. | Surgical Firestore writes via browser console, plus reconstructing what happened |
| **Supersede** | A new Session replaces an old one. Old is archived but preserved. Both carry cross-refs (`supersedes_session_ids` + `superseded_by_session_id`). Already designed for Add Shift; same shape applies to SessionV2. | Today's `addManualSessionV1` supersede batch logic, but unified |
| **Archive** | Session is removed from active views. `admin_removed: true`. Preserved for audit. Never deleted. | Today's `admin_removed` flag, but with a named operation and Timeline entry |

---

## What the toolbox is NOT

- **Not a generic "set status to X" endpoint.** Each operation has a name, a reason field, an audit footprint. Arbitrary state mutation is forbidden by design. If a new operational need emerges that doesn't fit one of the verbs, we add a new verb — we do not relax the contract.
- **Not exposed to techs.** Recovery is an admin action. Techs use the standard `/work` flow.
- **Not automatic.** Reconciliation can SURFACE that a Session needs recovery; it never INITIATES recovery. Admin always chooses + reasons.
- **Not destructive.** No verb in the toolbox deletes a Session. Archive is the only removal verb, and it preserves the doc.

---

## Why named verbs > generic state-update

1. **Audit clarity.** "Admin recovered Session X with reason: device_lost" is more useful than "Admin set status to awaiting_completion." The verb captures intent.
2. **Constrained surface.** Each verb has its own Cloud Function endpoint, its own validation rules, its own Timeline entry shape. Adding a new endpoint is a deliberate architectural decision, not a config tweak.
3. **Recovery is a workflow.** Real operational recovery often touches multiple aspects of a Session simultaneously: clock times AND component states AND payroll flags. A generic state updater requires the admin to remember every field. A named verb encapsulates the entire workflow.
4. **Future Mission Control alignment.** Mission Control surfaces "This Session is missing clock-out" with action buttons: [Resume] [Finish] [Recover]. The buttons map to the verbs. No "set status to X" dropdown anywhere.

---

## Mapping to today's tools

| Today's tool | Future SessionV2 verb |
|---|---|
| Labor Review "Force close" modal | **Finish** (with reason, on the Session, with Timeline entry) |
| Add Manual Shift (Slice 1) | **Recover** (when admin is reconstructing) OR **Supersede** (when admin is replacing) |
| Browser-console surgical writes | **Recover** with explicit fact entry |
| `admin_removed: true` direct write | **Archive** verb |
| Pending: Edit Session times | Either **Recover** (rebuild) or future **Correct** verb (small, time-only correction) |

The toolbox does NOT immediately replace today's tools. It is the destination state. Today's tools continue working through Phase 39. Phase 38+ adds the toolbox UIs and gradually migrates admin workflows toward the verbs.

---

## What Phase 35b does with this direction

**Nothing implementational.** This doc records the direction so that:

1. The Phase 35b `updateSessionV2ClockOutV1` Cloud Function is correctly scoped — narrow, single-purpose, clock-out only. NOT a generic state-update. NOT a "force advance." It's a normal lifecycle event, not a recovery operation.
2. Admin recovery use cases that arise during Phase 35b validation are deferred to Phase 38+ rather than absorbed into 35b's CF. Recovery is its own slice.
3. Future engineers reading the SessionV2 codebase see this doc and understand the intent — recovery is a workflow, not a state mutation.

---

## Open questions deferred to Phase 38+

- What's the right Cloud Function shape — one CF per verb (`resumeSessionV2`, `finishSessionV2`, ...) or one with a `verb` discriminator?
- How do admin UI surfaces communicate "this is an irreversible recovery action" without becoming alarmist?
- What's the relationship between the toolbox and existing surgical-write patterns ([[surgical-write-pattern]] memory)? Probably: toolbox replaces surgical writes for SessionV2; surgical writes remain valid for V1-only collections during the migration window.
- Should the toolbox have a "preview / dry-run" mode like the canary harness cleanup? Probably yes for Recover and Finish; not for Resume / Archive.

---

## North Star reminder

> The Session becomes the truth. Recovery is a verb on a Session, not a row mutation.

Every time we're tempted to add a "force X" admin endpoint, ask: is this a Recovery verb? If yes, design it into the toolbox. If no, it probably shouldn't exist.
