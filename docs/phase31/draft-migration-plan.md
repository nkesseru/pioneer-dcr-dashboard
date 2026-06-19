# Phase 31 — Draft Migration Plan (localStorage → IndexedDB)

**Status:** Draft, prototype only. Migration code lives in `public/queue/draft-migration.js`; exercised by `public/queue/queue-test.html` section 3.

## What changes

| Surface | Before (today) | After (Phase 31) |
|---|---|---|
| Storage | `localStorage["pioneer.dcr.draft.v1"]` — single key, last-write-wins | IndexedDB `pioneer-queue / drafts` object store, keyed by `submission_id` (UUIDv4) |
| Multi-DCR drafts | Impossible (single key) | Native (one row per submission_id) |
| Photo blob persistence | Field data only; photos lost on reload | Photo blobs queued separately in `pending` store after Submit click |
| Survives quota pressure | Fragile — 5 MB cap | Robust — IDB allowance is orders of magnitude larger |

## Migration trigger

On first boot of a Phase 31 client (gated by `window.OFFLINE_QUEUE_ENABLED === true`), `draft-migration.js#migrateLegacyDraftIfPresent()` runs once during app.js boot, **after** STAFF_AUTH succeeds but **before** the form attempts to restore from any store.

```
boot:
  STAFF_AUTH OK
  → PIONEER_QUEUE_MIGRATION.migrateLegacyDraftIfPresent()
  → PIONEER_QUEUE_DB.loadAllDrafts()  // returns migrated draft + any new ones
  → form selects the most recent draft to restore
```

## Migration semantics

1. **Read** `localStorage["pioneer.dcr.draft.v1"]`.
2. If absent → no-op (`{migrated: false, reason: "no legacy draft present"}`).
3. If unparseable → remove the bad key and no-op.
4. **Generate** a fresh UUIDv4 `submission_id` (or fall back to the legacy `ts-rnd` shape if `crypto.randomUUID` is missing — Safari < 15.4).
5. **Wrap** the parsed legacy payload in a Phase 31 envelope:
   ```js
   {
     submission_id: "<new uuid>",
     source: "legacy-migration",
     migrated_at: <ts>,
     legacy_payload: <entire original blob>,
     customer_slug: "<lifted>",
     tech_slug:     "<lifted>",
     created_at:    <legacy ts or now>,
     updated_at:    <now>
   }
   ```
6. **Write** the envelope to IDB `drafts` (`PIONEER_QUEUE_DB.saveDraft`).
7. **Delete** `localStorage["pioneer.dcr.draft.v1"]`.
8. Return `{migrated: true, submission_id, draft}`.

## Idempotency

Steps 1–7 are inside one logical operation. If the page closes mid-migration:
- Worst case: IDB write succeeded but localStorage removal didn't → next boot re-runs the migration, sees the legacy key, writes a SECOND IDB row with a different UUID, then removes the legacy key. The form restore path picks the most recent by `updated_at`. The duplicate row is benign (no submission lands on Firestore from a draft — drafts only become submissions when the user taps Submit, which generates yet another `submission_id`).
- Best case: clean run, single IDB row, legacy key gone.

To strengthen this: a future enhancement could write a meta marker (`meta / legacy_migration_done`) BEFORE removing localStorage, then check that marker before re-reading legacy. Not in v1.

## Field-by-field shape

The legacy `pioneer.dcr.draft.v1` blob (verified against `public/app.js#saveDraft` at line 2082) contains:

```js
{
  version: 1,
  saved_at: <ts>,
  customer_slug, tech_slug, clean_date, notes,
  occupancyLevel,
  segState:        { needs_supplies, has_problem, problem_our_fault },
  checklistState:  { [section_id]: { [item_id]: status } },
  checklistNotes:  { [section_id]: { [item_id]: noteText } },
  pendingFilesMeta: [{ name, size, type }],   // metadata only — no blobs
  supplyRequestText, problemCategory, problemSummary, problemDetails, problemLocation,
  signatureStrokes: ...,
  affirmed: bool,
  overBudgetOtherNote: string
}
```

All of that lives intact under `envelope.legacy_payload.*`. The form's restore path (`restoreDraftIfFresh()` at `public/app.js:2244`) reads field names — we update it to read from `envelope.legacy_payload.*` when source === "legacy-migration", or from the new top-level fields when source === "phase31-native" (the post-migration drafts).

## Code-side integration (when Phase 31 ships for real)

In `public/app.js`, three small edits:

1. **`saveDraft()` (line 2082)** — if `OFFLINE_QUEUE_ENABLED`, write through `PIONEER_QUEUE_DB.saveDraft({ submission_id: currentDraftSubmissionId, ... })` instead of `localStorage.setItem(DRAFT_KEY, ...)`.
2. **`restoreDraftIfFresh()` (line 2244)** — if `OFFLINE_QUEUE_ENABLED`, try IDB first; only fall back to localStorage if IDB has no drafts AND the legacy key is also absent (migration didn't run yet).
3. **`clearDraft()` (line 2240)** — if `OFFLINE_QUEUE_ENABLED`, call `PIONEER_QUEUE_DB.deleteDraft(currentDraftSubmissionId)` AND remove the legacy key (defensive).

These changes are gated by the flag. With the flag off (default), the existing localStorage path stays in effect — useful for staged rollout.

## Rollout plan

1. Ship `OFFLINE_QUEUE_ENABLED = false` to production. No behavior change. Verify in field for a week.
2. Flip to `true` for one named tech (Bonnie). Verify drafts migrate cleanly on her device, photos blobs queue after Submit, drain on reconnect.
3. Flip to `true` globally. Monitor `dcr_submissions` for any submission_id with `already_submitted: true` flag (rare under normal connectivity; common under bad signal).
4. After two weeks of stable globally-on, delete the localStorage code path entirely. Migration code stays as a one-shot for any laggard devices.

## Why not just throw away the legacy draft?

Because a tech could have a partly-filled DCR sitting on their device right now (post-hotfix, pre-Phase-31). Losing it during the upgrade would be a quiet form of work loss — exactly the kind of thing this whole phase exists to prevent. Migration is cheap; throwing it away would be a regression.
