# Deliverable 1 — System Capability Inventory

Every major surface in PioneerOps, grouped by audience. For each: who it's for, what it produces, what it depends on, and whether it's fully live, partial, or planned.

**Status legend:**
- 🟢 **Live** — in production, used daily
- 🟡 **Partial** — usable but with known gaps (see notes inline + `06-known-gaps.md`)
- 🔴 **Planned** — declared but not built / not wired

---

## Table of Contents

1. [Roles & Permission Hierarchy](#roles--permission-hierarchy)
2. [Cleaning-Tech-Facing Pages](#cleaning-tech-facing-pages)
3. [Office Manager Surface](#office-manager-surface)
4. [CEO Surface](#ceo-surface)
5. [Admin Panel Tabs](#admin-panel-tabs)
6. [Public / Customer-Facing Pages](#public--customer-facing-pages)
7. [Cross-Cutting Workflows](#cross-cutting-workflows)
8. [Background Jobs (Cloud Functions)](#background-jobs-cloud-functions)
9. [External Integrations](#external-integrations)

---

## Roles & Permission Hierarchy

Pioneer uses a four-tier hierarchical role model. Higher roles inherit lower-role capabilities.

| Tier | Role | Who today | What unlocks |
|---|---|---|---|
| 1 | **Owner** | Nick, April | Full access including (future) pay-rate + financial data |
| 2 | **Executive** | April | CEO Mission Control + (future) Financial Pulse |
| 3 | **Admin** | Nick, April, Kirby, Mike | Office Manager Mission Control + all admin CRUD |
| 4 | **Tech** | Active `cleaning_techs` | Operational surfaces only — own clock, own DCRs, own hours |

**Mechanism:** Hardcoded allowlists in three places that must stay in sync: `firestore.rules`, `functions/index.js`, and `public/staff-auth.js`. Each promotion requires a deploy until a role-management UI ships. Status: 🟢 **Live** as of the CEO Mission Control phase.

---

## Cleaning-Tech-Facing Pages

### `/team-hub` — Team Hub
**Purpose:** The cleaning tech's home page. Operational dashboard + personal items + leadership-broadcast inbox.

**Who:** Active cleaning techs (after staff-auth sign-in).

**Sections (top to bottom):**
- **From Leadership** — Phase 1C leadership_messages addressed to this tech or to the team
- **Messages from Pioneer** — Phase 3B communication_messages (thread-based; supports reply)
- **Announcements** — current active announcements with read-tracking + mandatory-modal for urgent ones
- **Upcoming Team Schedule** — Deputy-published shifts for the next ~14 days
- **My Hours** — current payroll period: total hours, pending corrections, recent 5 shifts, Request Adjustment
- **Requests & Support** — 6-card grid: Need Help Now, Time Off, Call Out, Open Shifts, Improve, Safety Incident
- **Pioneer Quality** — rolling-30-day inspection average + streak (morale signal)
- **Rockstar Team Players** — coverage bonuses paid this month

**Inputs:** Firestore reads on `announcements`, `leadership_messages`, `communication_messages`, `published_team_schedule`, `pioneer_service_sessions`, `time_adjustment_requests`, `quality_wins`, `rockstar_bonuses`.

**Outputs:**
- Read marks on announcements
- Acknowledge / Dismiss on leadership messages and comm messages
- Reply (inbound) on comm threads
- Time adjustment requests (via My Hours)

**Dependencies:** STAFF_AUTH (whoAmIV1), Firebase Hosting + Firestore. Status: 🟢 **Live**.

---

### `/work` — Today's Work + DCR submission
**Purpose:** Where techs see their assigned customers for the day, clock in/out, and submit Daily Cleaning Reports (DCRs).

**Who:** Active cleaning techs with `dcr_enabled !== false`.

**Workflow:**
1. Page shows today's `service_assignments` for this tech
2. Tech clocks in on a specific assignment — creates a `pioneer_service_sessions` doc + writes the singleton `active_service_sessions/{uid}` lock
3. Tech does the cleaning
4. Tech clocks out — flips session to `completed`, computes `work_minutes` + `paid_minutes`
5. DCR form opens — tech fills out the cleaning checklist (5 sections: Bathrooms, General Areas, Kitchens/Break, Offices, Entryways), uploads photos, signs
6. Submit → `dcr_submissions` doc + bound back to the session

**Inputs:** Today's `service_assignments` for this tech, the active session if any, the DCR template config.

**Outputs:** `pioneer_service_sessions` (active → completed), `dcr_submissions`, `time_punches` (audit trail), optional DCR email to the customer via `generateAndSendDcrEmailV1`.

**Safety:**
- Singleton lock at `active_service_sessions/{uid}` — can't double-clock
- Phase 1d Lite GPS captures geo_status but **never blocks** clock-in
- DCR submission required for cleaning sessions to be payable (see Payroll blocking)

**Dependencies:** STAFF_AUTH, service-clock.js, Firestore composite indexes on `(staff_uid, service_date)`, Cloud Functions `submitDcrV1` + `generateAndSendDcrEmailV1`. Status: 🟢 **Live**.

---

### `/tech` — Tech Hub
**Purpose:** Per-customer view of a cleaning tech's assigned customers + their SOP / access info.

**Who:** Active cleaning techs.

**Inputs:** Read of customer assignments the tech has access to, sourced via `techHubViewV1` Cloud Function (which returns a tech-safe filtered view — no `customer_secure` codes leak through).

**Outputs:** None — read-only view.

**Status:** 🟢 **Live**.

---

### `/supply-station` — Supply Pickup + Supply Request
**Purpose:** Two distinct workflows on one page.

**Who:** Any active staff (admin or tech).

**Workflows:**
1. **Supply Pickup clock** (top of page, Phase Timeclock Add-On) — Start / Complete Supply Pickup buttons. Logs paid time at the storage unit. Uses the same singleton lock as cleaning + inspection shifts. Writes to `pioneer_service_sessions` with `labor_type: "supply_station"`.
2. **Supply Request form** — submits a request to restock at a specific customer site OR for general HQ stock. Writes to `supply_requests`.

**Inputs:** Storage unit access codes (visible inline), customer picker, supply items requested.

**Outputs:** `pioneer_service_sessions` (supply_station type), `supply_requests`, optional `supply_notifications` for routing to admin.

**Dependencies:** non-service-clock.js, supply-station.js, `submitSupplyStationOrderV1`. Status: 🟢 **Live**.

---

### `/call-out` — Same-day call-out
**Purpose:** Tech reports they can't make their shift today. Routes to admin attendance review.

**Who:** Any active tech.

**Output:** `call_outs` doc. Triggers `onCallOutCreatedV1` Cloud Function which sends alert email to Kirby + April.

**Status:** 🟢 **Live**.

---

### `/time-off` — Planned time-off request
**Purpose:** Tech requests scheduled days off in advance.

**Who:** Any active tech.

**Output:** `time_off_requests` doc with status `pending`. Triggers alert email via `onTimeOffRequestCreatedV1`.

**Status:** 🟢 **Live**.

---

### `/open-shifts` — Pick up open shifts
**Purpose:** Tech sees `open_shift_requests` admins have posted and can claim them.

**Who:** Any active tech.

**Output:** Atomic transaction that flips `open_shift_requests.status` from `open` to `accepted` and stamps the tech's uid. Triggers `onOpenShiftUpdatedV1` which writes a `rockstar_bonuses` doc when admin confirms.

**Status:** 🟢 **Live**.

---

### `/improve` — Improvement suggestions
**Purpose:** Any tech (or admin) can submit a "what could be better at Pioneer" suggestion.

**Output:** `pioneer_improvements` doc. Surfaces in Office Manager improvement pipeline.

**Status:** 🟢 **Live**.

---

### `/team-schedule` — Full published team schedule
**Purpose:** Read-only 14-day team schedule view. Read from `published_team_schedule/current`.

**Status:** 🟢 **Live**. Note: schedule still authored in Deputy and then published; see `06-known-gaps.md`.

---

### `/inspections` — Inspection Intake + Health Dashboard + Registry
**Purpose:** Admin-tier only. Combines four jobs on one page:
1. **Inspection clock** (top) — paid time card for inspection walks
2. **Inspection Health dashboard** — totals: total customers / assigned / completed / overdue / completion %
3. **My Assigned Inspections** — queue of customers this admin owns this cycle
4. **Customer Registry** — every customer's inspection state with filter chips
5. **Recent inspections** — last 5 submitted
6. **Intake form** — Step 1 Setup / Step 2 Item Evaluation (Pass/Great/Fail/N/A) / Step 3 Overall + Submit

**Who:** Admin tier (currently April / Nick / Kirby / Mike).

**Inputs:** `customers`, `customer_inspection_state`, `inspections`, the V2.1 hardcoded template (8 sections, ~37 items).

**Outputs:**
- `inspections` doc with `schema_version: "inspection.v2.1"` and per-item verdicts + score (0–5 scale)
- `customer_inspection_state` auto-updates via `onInspectionCreatedV1` (clears assignment, stamps last_inspection_date + due_date = +60d)
- `quality_wins` doc when overall_score ≥ 4.8

**Workflows:** Assign to Me / Take Over / Open Inspection / Release / Mark Complete (manual closure without form).

**Status:** 🟢 **Live**. Inspection v1.0 production-ready as of Phase Inspection 3 + v1.0 audit fixes.

---

## Office Manager Surface

### `/manager` — Office Manager Mission Control
**Purpose:** The OM's daily cockpit. Surfaces every operational signal that needs human judgment.

**Who:** Admin tier (everyone above too — executives + owners see this surface).

**Sections (top to bottom):**
- **Leadership Messages** — communications from executives addressed to office_manager
- **Communication Center** — open communication_threads grouped by category (leadership / scheduling / supplies / callout / customer / general), can reply + close
- **Hero greeting** — date + name
- **Action Required (cockpit)** — counters by severity (Critical / Attention Needed / Healthy) + per-bucket alert list
- **Health cards** — Customer Health / Admin Health / Hiring Health (3-card row)
- **Communication Center** (full panel with category filters + thread modal)
- **Bottlenecks + Daily Reflection** — OM's own daily journaling
- **Improvement Pipeline** — kanban-style view of pioneer_improvements + office_manager_improvements
- **Weekly Review** — Friday wrap-up form
- **Hiring Health** — applicants / interviews / hires from `office_manager_hiring_snapshots` (live GHL sync) with manual-fallback if no snapshot

**Inputs (15+ live reads):** sessions, callouts, time-adj, dcr_issues, supply, techs, payroll_exports, improvements, om_reflections, om_bottlenecks, om_improvements, om_week, hiring_snapshots, complaints, etc.

**Outputs:** OM bottleneck + reflection docs; thread replies; improvement status mutations; hiring weekly numbers (manual override).

**Status:** 🟢 **Live**.

---

## CEO Surface

### `/ceo` — Executive Mission Control
**Purpose:** Read-mostly executive overview for April + Nick. Luxury-wellness aesthetic (deliberately distinct from /manager's operational feel).

**Who:** Executive + owner only (currently April + Nick).

**Sections:**
- **Greeting hero** ("Good morning, April") + date
- **Company Health** — composite Operational Health % with 4 pillar tiles (Active Team / Sessions This Week / Quality Score / Hiring Pipeline)
- **Today's CEO Actions** (Phase 1B) — 1–3 action cards (auto-detected suggestions + open `ceo_tasks`). Buttons: Done / Dismiss / Create Task. Live progress strip: "X of Y handled · N messages · 5-day streak"
- **Quick Leadership Actions** (Phase 1C) — Recognize Employee / Message Team / Message Office Manager → opens compose modal, writes `leadership_messages`
- **Attention Needed** — guiding-tone list of items that need leadership care
- **Momentum** — wins / compliments / hiring activity
- **Department Scorecards** — Operations / People / Customer Care / Hiring (30-day rollups)
- **Inspection Program rollup** — Completion rate / Overdue / Assigned / Awaiting first
- **Open Conversations preview** — count + latest 3 communication_threads
- **Recent Activity** — last 10 completed tasks + queued messages
- **Leadership Pulse** — personal-framing tiles (Recognition Given, OM Pulse, etc.)

**Inputs:** Many parallel Firestore reads — same collections as /manager plus `customer_inspection_state`, `communication_threads`, `ceo_tasks`, `leadership_messages`.

**Outputs:** `ceo_tasks` create/done/dismiss; `leadership_messages` queued for delivery (working-hours-aware for office_manager type only).

**Status:** 🟢 **Live**.

---

## Admin Panel Tabs

`/admin` is a single-page tabbed surface for operational admin work. Mission Control sits at the top (always visible). Tabs are grouped into clusters.

### Core Ops cluster

| Tab | Purpose | Inputs | Outputs | Status |
|---|---|---|---|---|
| **Customers** | CRUD on `customers` + secure SOP fields | Customer dropdown | Customer create / update / archive | 🟢 Live |
| **Cleaning Techs** | CRUD on `cleaning_techs` + invite flow | Tech roster | New auth user via `createCleaningTechLoginV1`; archive/reactivate | 🟢 Live |
| **Recent DCRs** | Browse + filter `dcr_submissions` | DCR archive | Bookmark / share links | 🟢 Live |
| **Yesterday's Work** | Quick audit view — what happened yesterday | Sessions + DCRs from yesterday | Read-only | 🟢 Live |
| **Supply Requests** | Triage `supply_requests` | All open requests | Status flip: new → "PCC will order" → ordered → received | 🟢 Live |
| **DCR Issues** | Triage `dcr_issues` opened by techs in their DCRs | Issue queue | Status flip: new → reviewed → customer_contacted → resolved | 🟢 Live |
| **Service Recoveries** | Coaching + follow-up tasks tied to a customer/inspection | Open recoveries | Status flip, notes | 🟢 Live |
| **Customer Notes** | Per-customer operational notes (security, access, prefs) | `customer_notes` | Create / publish (Phase 1e3) | 🟢 Live |
| **Suggestions** | Triage `pioneer_improvements` | Submission queue | Status (acknowledged / shipped / declined) | 🟢 Live |
| **Improvements** | Phase 1B improvement lifecycle on `office_manager_improvements` | Improvement docs | Status: submitted → approved → in_progress → implemented (or rejected) | 🟢 Live |
| **Tech Health** | Per-tech readiness scorecard | Sessions, callouts, DCR rate, quality wins | Read-only diagnostic | 🟢 Live |

### Communications cluster

| Tab | Purpose | Status |
|---|---|---|
| **Feed** | Combined activity feed | 🟢 Live |
| **Announcements** | Author + manage `announcements` (mandatory / non-mandatory; audience targeting) | 🟢 Live |
| **Admins** | Add / remove admin-tier users; resend invite | 🟢 Live |
| **Training** | Per-tech onboarding checklist | 🟡 Partial — checklist UI exists; analytics light |

### Scheduling cluster

| Tab | Purpose | Status |
|---|---|---|
| **Schedule** | Upload + publish team schedule; bridge Deputy → service_assignments | 🟢 Live |
| **Attendance** | Review call_outs + time_off_requests; approve/deny | 🟢 Live |
| **Deputy** | Map Deputy employee ↔ Pioneer tech | 🟢 Live |

### Payroll cluster

| Tab | Purpose | Status |
|---|---|---|
| **Labor (Labor Review)** | Per-session audit. Mark Reviewed → Approve for Payroll → Verification Layer blocks export until DCR pending / missing clockout / needs_review are 0. **Phase Timeclock Add-On:** non-cleaning labor (inspection / supply pickup) is exempt from DCR + assignment_id requirements. | 🟢 Live |
| **Payroll** | Run `exportPayrollCsvV1` — outputs CSV with per-period hours for QuickBooks import; voids; download by export ID | 🟢 Live |
| **Payroll Exceptions** | Review `time_adjustment_requests` (pending / approved / denied). Calls `approveTimeAdjustmentRequestV1` or `denyTimeAdjustmentRequestV1`. Approval stamps `effective_clock_in/out/minutes` on the underlying session. | 🟢 Live |
| **Sick Leave** | View / adjust `sick_leave_ledger` per tech. Append-only. | 🟢 Live |

### Settings cluster

(Various — check `/admin` directly for the complete list. Above are the high-traffic tabs.)

---

## Public / Customer-Facing Pages

| Page | Purpose | Status |
|---|---|---|
| `/feedback-compliment` | Customer compliment intake from DCR email link | 🟢 Live |
| `/feedback-issue` | Customer complaint intake — triggers complaint email to Kirby + April | 🟢 Live |
| `/dcr-report` | Public DCR view via signed URL (when customer clicks "View DCR" in email) | 🟢 Live |
| `/login` | Sign-in page (Google + email/password) | 🟢 Live |
| `/training` | Per-tech training landing (gated to that tech) | 🟡 Partial |

---

## Cross-Cutting Workflows

### Clock-in / Clock-out
- **Lock:** Singleton at `active_service_sessions/{uid}` enforces one active session per user across ALL labor types (cleaning, inspection, supply pickup).
- **Cleaning:** Requires `assignment_id`. Writes `pioneer_service_sessions` with `labor_type: "cleaning"` (default). DCR is required for payroll.
- **Inspection:** No assignment_id required. `labor_type: "inspection"`. Optional `customer_id` + `inspection_id` patched in.
- **Supply Pickup:** No assignment_id required. `labor_type: "supply_station"`. No customer.
- **Auto-sick-accrual:** Every session writes `sick_accrual_eligible_minutes` on clock-out.

### DCR submission
1. Tech finishes clock-out → DCR form opens
2. Fill template (5 sections, photos, signature)
3. Submit → `dcr_submissions` doc
4. Linked back to session via `dcr_id` + `dcr_submission_id`
5. Optional Cloud Function `generateAndSendDcrEmailV1` composes + sends the customer email via Gmail

### Time Adjustment Request (Phase 29)
1. Tech notices wrong clock time on /team-hub My Hours
2. Click `Adjust` on the shift row OR `Request Adjustment` button
3. Modal pre-fills original times; tech corrects them, picks reason, writes note
4. Submit → `createTimeAdjustmentRequestV1` validates everything (within current pay period, no duplicate pending, etc.)
5. `time_adjustment_requests` doc created with `status: pending`
6. Kirby sees in `/admin → Payroll Exceptions`
7. Approve → stamps `effective_clock_in/out/minutes` on the session + sets `has_approved_time_adjustment: true`
8. Payroll export uses effective values

### Inspection cycle
1. Admin opens `/inspections` → lazy bootstrap creates `customer_inspection_state` docs for any active customer that doesn't have one yet
2. Customers grouped by status: Overdue / Unassigned / Assigned / Completed
3. Admin clicks "Assign to Me" on a row (rotation suggestion shown inline)
4. Admin clicks "Open Inspection" → intake form pre-populated with customer
5. Fill out items (Pass/Great/Fail/N/A; Fail requires comment), submit
6. `onInspectionCreatedV1` Cloud Function bumps state doc: `last_inspection_date = today`, `due_date = +60d`, clears assignment

### Leadership messaging (Phase 1C)
1. CEO on `/ceo` clicks `+ Recognize Employee` / `+ Message Team` / `+ Message Office Manager`
2. Compose modal: pick recipient (for Recognize), pick tone, write body
3. Submit → `leadership_messages` doc with `deliverAfter` timestamp
   - **employee/team:** `deliverAfter = now` (delivers immediately at next sign-in)
   - **office_manager:** `deliverAfter = next 8 AM PT` if outside business hours (working-hours protection)
4. Recipient sees message at next `/team-hub` (or `/manager`) load. Acknowledge → status flips to `delivered`.

### Communication Threads (Phase 3A/B)
1. Admin on `/manager` clicks `+ New Conversation`
2. Pick category (leadership / scheduling / supplies / callout / customer / general), recipient, subject, first message body
3. `communication_threads` doc created + first `communication_messages` doc batched in
4. Recipient sees on `/team-hub` "Messages from Pioneer" panel
5. Tech can reply (inbound) — uses `addMessage` helper, denorm fields on thread bump
6. Admin closes thread when done

### CEO Action Loop (Phase 1B + 1D)
1. CEO opens `/ceo` → "Today's CEO Actions" surfaces 1–3 suggestions (auto-detected from data) + open tasks
2. Click `Done` / `Dismiss` / `+ Task` on a suggestion → writes `ceo_tasks` doc
3. Done/dismissed today suppresses the suggestion for the rest of the day
4. Streak counter increments when CEO takes at least one action OR sends one recognition per day

### Payroll period close
1. Semi-monthly: 1–15 = half A; 16–EOM = half B
2. `payroll_periods` collection holds each period's metadata (status open → closed → paid)
3. During period: techs accumulate sessions; admin marks them Reviewed → Approved
4. End of period: admin runs `exportPayrollCsvV1` → Verification Layer refuses if blockers exist
5. CSV downloaded → imported into QuickBooks (manual handoff today; see `06-known-gaps.md`)

---

## Background Jobs (Cloud Functions)

| Function | Trigger | Purpose | Status |
|---|---|---|---|
| `whoAmIV1` | HTTPS | Identity + role resolution on every page load | 🟢 Live |
| `submitDcrV1` | HTTPS | Validates + writes a DCR submission; triggers auto-email | 🟢 Live |
| `generateAndSendDcrEmailV1` | HTTPS | Composes (OpenAI) + sends the per-customer DCR email | 🟢 Live |
| `submitSupplyStationOrderV1` | HTTPS | Tech-side supply order intake | 🟢 Live |
| `submitFeedbackV1` | HTTPS | Customer compliment / complaint intake | 🟢 Live |
| `createTimeAdjustmentRequestV1` | HTTPS | Tech / admin submits time correction request | 🟢 Live |
| `approveTimeAdjustmentRequestV1` | HTTPS | Admin approves; updates session with effective fields | 🟢 Live |
| `denyTimeAdjustmentRequestV1` | HTTPS | Admin denies with reason | 🟢 Live |
| `exportPayrollCsvV1` | HTTPS | Admin exports semi-monthly payroll CSV; Verification Layer | 🟢 Live |
| `voidPayrollExportV1` / `downloadPayrollExportCsvV1` | HTTPS | Void + re-download | 🟢 Live |
| `syncDeputyShiftsV1` | Scheduled (every 10 min) | Pull Deputy shift cache | 🟢 Live |
| `bridgeDeputyToServiceAssignmentsV1` | Scheduled | Build today's `service_assignments` from cache | 🟢 Live |
| `refreshDeputyShiftsV1` / `RangeV1` | HTTPS | Admin-button manual Deputy sync | 🟢 Live |
| `syncGhlHiringV1` | Scheduled (06:30 PT daily) | Pull Applicant Tracking pipeline from LeadConnector → `office_manager_hiring_snapshots` | 🟢 Live |
| `refreshGhlHiringV1` | HTTPS | "Refresh GHL" button on `/manager` | 🟢 Live |
| `onInspectionCreatedV1` | Firestore onCreate | Bumps `customer_inspection_state` on inspection submit | 🟢 Live |
| `onCallOutCreatedV1` / `onTimeOffRequestCreatedV1` | Firestore onCreate | Alert email routing | 🟢 Live |
| `onOpenShiftCreatedV1` / `onOpenShiftUpdatedV1` | Firestore | Open-shift state machine + Rockstar bonus mint | 🟢 Live |
| `onEmergencyCreatedV1` | Firestore | Safety incident alert | 🟢 Live |
| `pioneerQualityViewV1` | HTTPS | Tech-safe quality data feed for `/team-hub` | 🟢 Live |
| `techHubViewV1` | HTTPS | Tech-safe customer + supply view for `/tech` | 🟢 Live |
| `pilotReadinessCheckV1` | HTTPS | Pre-flight diagnostic for a tech's first day | 🟢 Live |

---

## External Integrations

| Integration | Direction | Purpose | Status |
|---|---|---|---|
| **Firebase Auth (Google + email/password)** | bidirectional | Identity | 🟢 Live |
| **Firebase Hosting + Firestore + Functions + Storage** | core platform | Everything | 🟢 Live |
| **Deputy** | inbound | Shift roster (still authoritative for scheduling) | 🟢 Live (legacy) |
| **GoHighLevel / LeadConnector v2** | inbound | Daily hiring pipeline snapshot | 🟢 Live |
| **Gmail (Workspace service account)** | outbound | DCR emails to customers, alert emails to admin | 🟢 Live |
| **OpenAI** | outbound | DCR email body composition | 🟢 Live |
| **Twilio / SMS** | outbound | NOT WIRED — schema-ready, no sending | 🔴 Planned |
| **QuickBooks** | outbound | NOT INTEGRATED — payroll CSV manually imported | 🔴 Planned |

---

## End of Inventory

For "what each role can DO with these surfaces" → `02-role-matrix.md`.
For "what's not done yet" → `06-known-gaps.md`.
