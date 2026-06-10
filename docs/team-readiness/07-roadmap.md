# Nova 7 Roadmap — PioneerOps Readiness Path

**Snapshot date:** 2026-06-10
**Author intent:** A current-state roadmap after the Team Readiness documentation package landed. Strategic-level only; tactical details live in the other six deliverables in this folder.

**Status legend:**
- 🟢 **Live / Locked** — in production, used daily
- 🟡 **Active** — shipping or shipped-pending-verification
- 🔴 **Planned** — declared, not built

---

## 1. Locked / Production Ready

Every system below is shipped, in use, and considered hardened for production.

| System | Phase | Reference |
|---|---|---|
| 🟢 **Team Hub** (`/team-hub`) | Phase 1A+ through Phase 1C | [`01-capability-inventory.md`](01-capability-inventory.md#team-hub-team-hub) |
| 🟢 **Clock In / Clock Out** | Phase 1d Lite + Timeclock Add-On | [`04-sop-drafts.md`](04-sop-drafts.md#sop-001--clock-in-cleaning) |
| 🟢 **DCR Workflow** | Native pipeline (replaces Zapier) | [`04-sop-drafts.md`](04-sop-drafts.md#sop-003--submit-a-dcr) |
| 🟢 **Supply Station** (Supply Pickup + Supply Request) | Timeclock Add-On rename pass | [`04-sop-drafts.md`](04-sop-drafts.md#sop-006--submit-a-supply-request) |
| 🟢 **My Hours** (employee payroll self-service) | Employee Trust Layer + UX refinement | [`04-sop-drafts.md`](04-sop-drafts.md#sop-005--use-my-hours-verify-payroll) |
| 🟢 **Time Adjustment Requests** | Phase 29 + My Hours flow | [`04-sop-drafts.md`](04-sop-drafts.md#sop-004--request-a-time-adjustment) |
| 🟢 **Inspection System v1** (objective Pass/Great/Fail/N/A) | Inspection V2.1 recalibrated | [`04-sop-drafts.md`](04-sop-drafts.md#sop-007--perform-an-inspection) |
| 🟢 **Inspection Assignment System** | Phase Inspection 3 (cadence + registry + rotation hint + auto-completion trigger) | [`01-capability-inventory.md`](01-capability-inventory.md#inspections--inspection-intake--health-dashboard--registry) |
| 🟢 **Office Manager Mission Control** (`/manager`) | Phase 1A.1–2A.1 + Phase 33 noise control | [`04-sop-drafts.md`](04-sop-drafts.md#sop-011--mission-control-daily-triage) |
| 🟢 **CEO Mission Control** (`/ceo`) | Phase 1A–1D (Company Health + Today's Actions + Quick Leadership Actions + Recent Activity + Streak) | [`03-training-outline.md`](03-training-outline.md#new-ceo--executive) |
| 🟢 **GHL Hiring Intelligence** | Phase 2A.2 + cohort-funnel recalibration | [`01-capability-inventory.md`](01-capability-inventory.md#external-integrations) |
| 🟢 **Team Readiness Documentation Package** | This phase | [`README.md`](README.md) |

---

## 2. Active Hardening

Shipping, just-shipped, or actively being firmed up. None of these blocks the next strategic build — but each needs ≥ 1 cycle of real-world use before we mark it locked.

### Kirby admin usability bugs
- 🟡 **Labor table — right-side columns clipped**
  Fixed (commit `10cf850`). Awaiting Kirby's "looks right at her desktop width" confirmation. See `02-role-matrix.md` for who runs payroll.
- 🟡 **Mission Control action buttons — appeared unclickable**
  Fixed (commit `10cf850`). Root cause: button was firing correctly; activated tab was below the fold. Added `scrollIntoView` so the activation is visibly acknowledged. Awaiting Kirby's "I click Open Cleaning Techs and it works now" confirmation.

### Communication Threads
- 🟡 **Phase 3A+3B shipped** — collection model + Manager Communication Center + Team Hub thread reads + CEO Open Conversations preview.
- 🟡 **Pending hardening:** real-time `onSnapshot` listeners instead of reload-driven reads (see [`06-known-gaps.md`](06-known-gaps.md#communication-thread-real-time)). Quarterly review of which categories are actually getting used; trim or re-spec accordingly.

### Employee Replies
- 🟡 **Inbound reply path live in Phase 3B** — techs can reply to admin-initiated communication threads from `/team-hub`. Rules let them mutate denorm bookkeeping on the parent thread + create `direction: inbound` messages.
- 🟡 **Pending hardening:** monitor first 2 weeks of real reply volume. Add a "reply received" badge or notification surface if Kirby reports she's missing them. Today she'd find them by opening the thread on `/manager`.

### Twilio Transport Foundation
- 🔴 **Schema-ready, not wired** — `leadership_messages` and `communication_messages` both carry `channel: sms` and SMS-specific fields (`sms_phone`, `sms_sid`, `sms_error`). Nothing actually sends SMS today.
- 🔴 **Pending:** A2P 10DLC campaign approval (see Section 4 below). Once approved, wire a scheduled Twilio worker that reads queued messages whose `deliverAfter` has passed and have `channel: sms`.

---

## 3. Next Strategic Build

### Financial Pulse

The next major phase after Team Readiness wraps. Brings PioneerOps from operations-only to operations + financial visibility.

**Components (none built yet):**
- 🔴 **Cash** — daily snapshot of bank account balances (sourced from QuickBooks API)
- 🔴 **Revenue** — invoices issued, payments received, AR aging buckets (Current / 30 / 60 / 90+)
- 🔴 **Expenses** — vendor bills + categorized expense entries (cleaning supplies / fuel / rent / insurance / other)
- 🔴 **AR** — accounts receivable detail with per-customer outstanding amounts
- 🔴 **Trend visibility** — quarter-over-quarter trend lines on revenue, gross profit, customer profitability

**Prerequisites:**
1. QuickBooks API integration (OAuth + scheduled sync)
2. Pioneer-side class/department tagging discipline inside QB so per-customer profitability is attributable (see [`06-known-gaps.md`](06-known-gaps.md#customer-invoicing--ar))
3. Pay rate storage in PioneerOps (small phase, owner-only gate)
4. New Firestore collections: `qb_invoices`, `qb_payments`, `qb_expenses`, `qb_account_balances`, `qb_customer_mapping`, plus rollup collections per the CEO Discovery report

**Scope discipline:**
Phase 1 of Financial Pulse should ship visibility (read-only widgets on `/ceo`), not write-back. Don't try to mutate QB from PioneerOps in the first cut.

---

## 4. External Dependencies

PioneerOps is opinionated about what it owns. Four systems remain authoritative for what they're best at; PioneerOps integrates rather than replicates.

| System | What it owns | PioneerOps relationship |
|---|---|---|
| **Deputy** | Shift scheduling — building tomorrow's roster | Inbound sync every 10 min → `deputy_shift_cache` → bridged into `service_assignments` for `/work` |
| **QuickBooks** | Accounting — invoices, payments, expenses, AR, payroll dollars | Manual CSV import today; Financial Pulse will wire the API (read-mostly) |
| **Twilio** | SMS transport | Schema-ready in PioneerOps; **A2P 10DLC campaign approval pending** before first send. Until approved, all messaging stays in-app. |
| **GoHighLevel (LeadConnector)** | Hiring funnel + applicant data | Inbound sync at 06:30 PT daily → `office_manager_hiring_snapshots` → reads on `/manager` + `/ceo` |

**Pending external action items:**
- 📋 Twilio A2P 10DLC campaign approval (admin work, no Pioneer code change blocks this)
- 📋 QuickBooks API credentials provisioned in Firebase Secrets when Financial Pulse phase begins

---

## 5. Operating Principle

A clear statement of who does what, so no one mistakes PioneerOps for something it isn't trying to be.

> **Deputy schedules.**
> **PioneerOps operates, reviews, corrects, communicates, inspects, and reports.**
> **QuickBooks accounts.**
> **Twilio transports messages.**

Each system owns its domain. PioneerOps is the operational heartbeat — what happens *during* the workday, every workflow that touches a real customer or a real tech. Scheduling lives upstream in Deputy; accounting lives downstream in QuickBooks; SMS transport lives in Twilio when wired.

When a feature is proposed, the first question is: which of those four boxes does it belong in? If it's clearly Deputy or QuickBooks or Twilio, PioneerOps doesn't replicate — it integrates.

---

## 6. Team Adoption Plan

Locking the docs is necessary but not sufficient. The team has to actually use PioneerOps for it to be Pioneer's source of truth.

| Step | Owner | Status | Reference |
|---|---|---|---|
| Record **cleaning tech walkthrough** | Nick | 🔴 Pending | [`05-video-recording-guide.md`](05-video-recording-guide.md) |
| Record **inspector walkthrough** | Nick | 🔴 Pending | [`05-video-recording-guide.md`](05-video-recording-guide.md#additional-shorter-videos-recommended-after-the-main-one) |
| Record **office manager walkthrough** (Kirby's `/manager` daily ritual) | Nick + Kirby | 🔴 Pending | Same |
| Record **CEO walkthrough** (April's `/ceo` daily check) | Nick + April | 🔴 Pending | Same |
| Publish **SOPs to team** (printed binder + digital) | Kirby | 🔴 Pending | [`04-sop-drafts.md`](04-sop-drafts.md) |
| Use PioneerOps as **source of truth for daily work** (retire ad-hoc Slack / text confirmations) | All | 🟡 In progress | — |

**Cadence target:** All four walkthroughs recorded within two weeks of this roadmap's snapshot date. SOPs printed and distributed in the same window.

---

## 7. Definition of Ready for Full Team Rollout

PioneerOps is ready to be presented as the official daily tool for every Pioneer employee when ALL of these are true:

| # | Criterion | Status |
|---|---|---|
| 1 | **Kirby bugs fixed** — labor table no longer clips; Mission Control action buttons scroll the target panel into view | 🟡 Shipped (commit `10cf850`); awaiting Kirby's verification |
| 2 | **Team walkthrough recorded** — at minimum the cleaning-tech 30-min video; ideally all four roles | 🔴 Not started |
| 3 | **My Hours verified by at least one employee** — a tech opens `/team-hub`, confirms their hours match what they actually worked, optionally submits + closes a Time Adjustment round-trip | 🔴 Not started |
| 4 | **Inspection workflow tested by Laura/Jared** — one full Open Inspection → submit → score → Quality Win OR Service Recovery cycle | 🔴 Not started |
| 5 | **Payroll correction workflow confirmed** — a real tech submits a correction; Kirby approves; verifies effective times propagate to next payroll CSV export | 🔴 Not started |
| 6 | **Mission Control buttons verified** — Kirby opens `/admin` Mission Control, clicks each action button (Open Cleaning Techs, Open Labor, Open Payroll Exceptions, etc.) and confirms the target panel both activates AND scrolls into view | 🟡 Shipped; awaiting verification |

**When all six green:** PioneerOps is officially Pioneer's operational system of record. Kirby + April retire ad-hoc Slack-based tracking. Techs are told "if it's not in PioneerOps, it didn't happen."

**Until then:** Run PioneerOps alongside existing processes, not as a replacement. Every gap surfaced during dual-running gets logged in `06-known-gaps.md` and triaged.

---

## Maintenance

This roadmap is a snapshot. It will drift the moment a feature ships or a gap closes. Recommended refresh cadence:
- **When a Section 1 item changes status:** update the table
- **When a Section 7 criterion turns green:** update + announce
- **When Financial Pulse phase begins:** move it from Section 3 to Section 2; create a new Section 3 with whatever's next
- **Monthly:** leadership re-reads the whole file, confirms each entry is still accurate

---

## End of Roadmap

For the surfaces that ARE live → [`01-capability-inventory.md`](01-capability-inventory.md)
For what role does what → [`02-role-matrix.md`](02-role-matrix.md)
For onboarding new staff → [`03-training-outline.md`](03-training-outline.md)
For SOP drafts → [`04-sop-drafts.md`](04-sop-drafts.md)
For Nick's video plan → [`05-video-recording-guide.md`](05-video-recording-guide.md)
For the honest list of what isn't done → [`06-known-gaps.md`](06-known-gaps.md)
