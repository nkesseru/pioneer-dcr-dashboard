# PioneerOps Team Readiness Documentation

**Audience:** Pioneer Commercial Cleaning leadership (Nick, April, Kirby, Mike) preparing to onboard staff onto PioneerOps and write durable SOPs.

**Status:** Phase Team Readiness — first complete pass. Updated as features ship.

**Scope:** This package replaces tribal knowledge with written documentation so a new hire can learn PioneerOps from the materials below plus the walkthrough video, without needing a coworker on standby.

---

## What's in this folder

| File | Purpose | Read time |
|---|---|---|
| [`01-capability-inventory.md`](01-capability-inventory.md) | Every page, every tab, every workflow, every permission level with inputs / outputs / dependencies / status | 25 min |
| [`02-role-matrix.md`](02-role-matrix.md) | What Cleaning Tech / Inspector / Office Manager / CEO / Admin can View, Create, Edit, Approve, Export | 10 min |
| [`03-training-outline.md`](03-training-outline.md) | New-hire training plans — 15-minute quick-start + 60-minute deep dive for each of the 4 user roles | 30 min |
| [`04-sop-drafts.md`](04-sop-drafts.md) | First-draft SOPs for the 11 most-frequent procedures (Clock In / Clock Out / DCR / Time Adjustment / etc.) | 35 min |
| [`05-video-recording-guide.md`](05-video-recording-guide.md) | Sequence + script outline for Nick's continuous walkthrough recording | 15 min |
| [`06-known-gaps.md`](06-known-gaps.md) | Features that are partial / planned / using Deputy / using QuickBooks / still in development | 15 min |
| [`07-roadmap.md`](07-roadmap.md) | Nova 7 strategic roadmap — what's locked, what's hardening, what's next, and the rollout readiness gates | 10 min |

---

## How to use these documents

**For onboarding a new employee:**
1. Pick the matching outline in `03-training-outline.md` (Cleaning Tech / Inspector / Office Manager / CEO).
2. Walk them through the 15-minute quick-start with the live system open.
3. Hand them the SOPs in `04-sop-drafts.md` for the procedures they own.
4. Schedule the 60-minute deep-dive within their first week.

**For writing a permanent SOP from a draft:**
1. Open the matching draft in `04-sop-drafts.md`.
2. Verify the step list still matches the current UI (these will drift as we ship; see Maintenance below).
3. Add your own screenshots, the Pioneer brand header, and the staff signoff block.
4. Promote to your SOP system (Notion / paper binder / wherever you keep them).

**For recording the walkthrough video:**
1. Open `05-video-recording-guide.md`.
2. Follow the sequence top to bottom. The script blocks tell you what to say.
3. Keep it one continuous take if you can — re-recording sections sounds inconsistent.

**For checking what's NOT done:**
- `06-known-gaps.md` is the honest list. Read it before you tell anyone "the system handles that."

---

## Source of truth

These docs are written **from the actual code as it stands today**. Where a feature is partially complete or has a known workaround, that's flagged inline (and aggregated in `06-known-gaps.md`).

When the code changes, these docs lag — they don't auto-update. The Maintenance section below covers when to refresh them.

---

## Maintenance

**When to refresh these docs:**
- A new page or tab ships → update `01-capability-inventory.md` and the role matrix
- A workflow changes its step order or button labels → update the relevant SOP in `04-sop-drafts.md`
- A role's permissions change → update `02-role-matrix.md`
- A "known gap" gets shipped → move it out of `06-known-gaps.md` and into the inventory

**Owner:** Whoever ships the change owns the doc update for that change. The same commit should touch both.

**Cadence check:** Every quarter, leadership should skim `01-capability-inventory.md` and confirm every "live" item is still live and every "planned" item still planned.

---

## Versioning

This is version 1.0 of the documentation package. The git history of this folder is the change log.
