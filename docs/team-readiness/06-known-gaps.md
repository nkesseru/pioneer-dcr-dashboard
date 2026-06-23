# Deliverable 6 — Known Gaps

The honest list. Things that are partially built, planned but not shipped, dependent on external tools, or in active development. Read this before you tell anyone "the system handles that."

**Last updated:** Phase Team Readiness (this document).

**Status legend (matches inventory):**
- 🟢 **Live** — shipped, used
- 🟡 **Partial** — usable but incomplete
- 🔴 **Planned** — declared, not built
- 🟠 **Workaround** — a manual process bridges the gap

---

## 1. Partial features (works but with caveats)

### Inspection photo upload
**Status:** 🟡 Partial
**Current:** Schema is ready (`photo_urls[]` on each item) but actual upload is a disabled "(coming soon)" button on the form. Fails capture comments only.
**Impact:** Visual evidence of Fails relies on the comment text. No before/after photo trail in the system.
**Workaround:** Inspectors who want to document with photos can attach them to a Service Recovery doc on `/admin` after the inspection. Not great UX.
**To-do:** Wire Firebase Storage upload → write URL into the inspection's per-item `photo_urls` array.

### `/training` per-tech page
**Status:** 🟡 Partial
**Current:** Page renders + has the basic onboarding checklist UI, but analytics / completion tracking is light. Doesn't yet link to the walkthrough video referenced in Deliverable 5.
**Workaround:** Kirby tracks training completion in her head / Slack.
**To-do:** Wire video links + completion stamping when this Team Readiness phase is fully cut over.

### Training Hub / Onboarding Knowledge Base
**Status:** 🔴 Planned
**Current:** This Team Readiness docs folder is the closest thing. No in-product training surface beyond the per-tech `/training` page.
**Workaround:** Send tech the docs in this folder + the walkthrough video link.
**To-do:** Future phase — surface these docs (or a curated subset) inside `/training`.

### Inspection per-customer cadence override
**Status:** 🟡 Partial — schema ready, no UI
**Current:** `customer_inspection_state.inspection_cadence_days` is a stored field and the consumer logic honors it everywhere. But there's no admin UI to set it; the value defaults to 60 for every customer.
**Workaround:** A Firestore console edit can set a different cadence for a specific customer if it matters. Both `/inspections` and `/ceo` rollup will honor it.
**To-do:** Add a per-customer cadence edit on `/admin → Customers` when a real customer needs a different rhythm.

### Phase 29 — Time Adjustment feature flag
**Status:** 🟡 Phased rollout flag still in place
**Current:** `PHASE29_TIME_ADJUSTMENTS_ENABLED` in `firebase-config.js` gates the Request Adjustment button on `service-clock.js` (for techs at the customer site). A tester allowlist (nick / april / kirby / mgies) sees it always. `/team-hub → My Hours` ALWAYS shows the button (no gate), so all techs already have access through that path.
**Workaround:** None needed — techs can submit via `/team-hub`.
**To-do:** Flip the flag to `true` after sustained My Hours usage; retire the tester allowlist.

### Mission Control alert noise control
**Status:** 🟢 Live, but tuning ongoing
**Current:** Dismiss / Snooze / Suppress are wired. Default rules sometimes surface alerts that aren't actionable for Pioneer's current state.
**Workaround:** Use Suppress Similar to silence chronic non-actionable categories.
**To-do:** Quarterly review of which suppression rules are still load-bearing.

### Inspection rotation enforcement
**Status:** 🟢 Live as a hint, NOT enforced
**Current:** "Suggested next inspector" shows inline on registry rows ("last: Kirby → try: April"). Assign-to-Me still claims for whoever clicked. By design.
**Workaround:** Social contract among April + Kirby to honor the rotation.
**To-do:** None planned — enforcement was explicitly out of scope. Revisit if rotation drifts.

### Communication thread real-time
**Status:** 🟡 Loads on page open only
**Current:** All comm thread reads (admin Communication Center on `/manager`, tech messages on `/team-hub`, CEO Open Conversations preview on `/ceo`) are one-shot reads, not real-time `onSnapshot` listeners. A user has to reload to see new messages.
**Workaround:** Page refresh.
**To-do:** Future enhancement — convert reads to onSnapshot for the active panels.

---

## 2. Planned but not finished

### Twilio / SMS delivery
**Status:** 🔴 Planned
**Current:** `leadership_messages` and `communication_messages` schemas include `channel: 'sms'` and SMS-specific fields (sms_phone, sms_sid, sms_error). Nothing actually sends SMS today. All delivery is in-app only.
**Why not yet:** Phase Comms Foundation explicitly deferred Twilio integration. Wiring it would require Twilio account, webhook for delivery status, opt-in flow.
**To-do:** Phase TBD — wire Twilio when Pioneer wants SMS leadership messages.

### Financial Pulse (CEO Mission Control Phase 2)
**Status:** 🔴 Planned
**Current:** No revenue, AR, expenses, cash, gross profit, or customer profitability in PioneerOps. The CEO Mission Control Phase 1 build (live) is operational-only by spec.
**Why not yet:** Requires QuickBooks integration + Pioneer-side class/department tagging discipline in QB. See CEO Discovery report in `docs/team-readiness/01-capability-inventory.md` for the architectural plan.
**To-do:** Future major phase.

### Pay rate storage
**Status:** 🔴 Planned
**Current:** No `staff_pay_rates` collection. Payroll CSV exports per-period hours; QuickBooks holds the rate side. Sick leave $ liability can't be computed from PioneerOps alone.
**Why not yet:** Sensitive data; storing it requires owner-tier rules + audit logging. Role hierarchy is ready; surface isn't built.
**To-do:** Future small phase — add the collection + admin UI behind owner-only gate.

### CEO daily snapshot history
**Status:** 🔴 Planned
**Current:** `/ceo` reads live data each load. No `ceo_daily_snapshots/{YYYY-MM-DD}` doc gets written. Trend charts on the CEO surface can't span historical windows.
**Why not yet:** Phase 1 prioritized current-state visibility.
**To-do:** Future scheduled job + trend widgets if leadership wants quarter-over-quarter trend lines.

### CEO customer rollups
**Status:** 🔴 Planned
**Current:** `ceo_customer_rollups/{slug}__{period}` would let `/ceo` compare customer profitability without re-aggregating every load. Doesn't exist.
**Why not yet:** Tied to Financial Pulse phase — can't roll up profitability without revenue data.
**To-do:** Lands with Financial Pulse.

### Inspection cohort historical analytics
**Status:** 🔴 Planned
**Current:** Each inspection is a doc; aggregate trends are computed live on read. No pre-aggregated trend collection.
**Why not yet:** Volume is low enough that live computation is fine.
**To-do:** Revisit when inspection count exceeds ~thousands.

### Role management UI
**Status:** 🔴 Planned (intentional)
**Current:** Promoting / demoting between owner / executive / admin / tech requires editing hardcoded allowlists in three files (`firestore.rules`, `functions/index.js`, `public/staff-auth.js`) and redeploying.
**Why not yet:** Phase CEO Mission Control intentionally deferred the management UI to keep scope tight. The hierarchy is the right shape; the UI just isn't built.
**To-do:** Small phase — admin tab for role assignment with audit log. Until then, deploys are the management UI.

### Live `onSnapshot` listeners across the board
**Status:** 🔴 Planned
**Current:** Most surfaces read on page load. /team-hub leadership messages, /manager Mission Control, /ceo open conversations — all reload-driven.
**Why not yet:** Reloads are cheap for low-traffic surfaces; the Firestore read cost of constant listeners is non-trivial.
**To-do:** Selective onSnapshot on the highest-traffic surfaces if real-time becomes a felt need.

### CEO Action category: Finance
**Status:** 🔴 Placeholder
**Current:** `ceo_tasks.category` enum includes 'finance' but no auto-suggestion ever uses it; no surface reads it.
**Why not yet:** Reserved for Financial Pulse.
**To-do:** Lands with Financial Pulse.

---

## 3. Items still using Deputy

### Shift scheduling
**Status:** 🟢 Live (Deputy-backed)
**Current:** Deputy remains the authoritative scheduler. `syncDeputyShiftsV1` runs every 10 min pulling shifts into `deputy_shift_cache`. `bridgeDeputyToServiceAssignmentsV1` writes today's assignments into `service_assignments` which is what `/work` reads.
**Why still Deputy:** Deputy's UI for scheduling is mature; building a replacement would be a major phase. The Deputy integration is reliable.
**To-do:** Optional future phase if Pioneer wants to retire the Deputy subscription.

### Published team schedule view
**Status:** 🟢 Live (PioneerOps-side display, Deputy source)
**Current:** `/team-schedule` reads `published_team_schedule/current` which an admin populates from the `/admin → Schedule` flow after the Deputy publish.
**To-do:** Same — fine as-is.

### Deputy mapping admin UI
**Status:** 🟢 Live (`/admin → Deputy` tab)
**Current:** Admin maps Deputy `employee_id` ↔ Pioneer `cleaning_techs.slug` so the cache sync knows who's who.
**To-do:** None — works.

---

## 4. Items still using / depending on QuickBooks

### Payroll dollars (gross pay, taxes, deductions)
**Status:** 🟠 Workaround (manual CSV import)
**Current:** PioneerOps exports a Verification-Layer-gated CSV with per-period hours per tech. CSV gets manually imported into QuickBooks. Pay rate, gross pay, tax math all happens in QB.
**Why:** Per CEO Discovery, Financial Pulse is a separate phase.
**To-do:** Either wire QuickBooks API (large phase) OR keep the manual handoff. Pioneer should decide based on payroll frequency + error tolerance.

### Customer invoicing / AR
**Status:** 🔴 Not modeled in PioneerOps
**Current:** No `invoices`, `payments`, or `customer_billing` collections. Invoicing lives entirely in QB.
**To-do:** Lands with Financial Pulse.

### Vendor expenses / supply costs
**Status:** 🔴 Not modeled
**Current:** `supply_requests` tracks what was needed; no cost-per-item data lands in PioneerOps.
**To-do:** Lands with Financial Pulse.

### Cash position / bank balances
**Status:** 🔴 Not in PioneerOps
**Current:** Entirely external.
**To-do:** Lands with Financial Pulse if it ever does.

---

## 5. Items still under development (active phases)

These items are in progress but haven't hit a "finished" milestone yet. They might be partially live with rough edges.

### Tech Health tab (admin)
**Status:** 🟢 Live but signal coverage is uneven
**Current:** Per-tech score combines callouts, DCR rate, customer continuity, quality wins. Some metrics depend on signals that are themselves still maturing (e.g., quality_wins depends on inspection volume).
**To-do:** Calibrate weightings as inspection volume grows.

### Customer feedback routing
**Status:** 🟢 Live, lightweight
**Current:** Customer complaint → email to Kirby + April. No SLA tracking, no recovery state machine beyond `customer_complaints.status`.
**To-do:** Tighter integration with Service Recoveries collection. The two collections coexist but don't fully cross-reference.

### Phase 33 Mission Control noise control (suppression UX)
**Status:** 🟢 Live, ongoing tuning
**Current:** Default fire rules sometimes generate alerts that aren't useful. Suppression rules accumulate.
**To-do:** Quarterly cleanup of suppression rules.

---

## 6. Permanent dependencies / external systems

These aren't "gaps" — they're load-bearing third-party systems that PioneerOps depends on.

| System | Used for | What breaks if it goes down |
|---|---|---|
| **Firebase Auth** | All sign-in | No one can sign in |
| **Firebase Hosting / Firestore / Functions / Storage** | Core platform | Nothing works |
| **Gmail Workspace (sender service account)** | DCR emails, alert emails | Customers don't get DCRs; admins don't get callout alerts |
| **OpenAI API** | DCR email body composition | DCR emails fall back to plain template (still send) |
| **GoHighLevel (LeadConnector v2)** | Hiring pipeline pull | Hiring Health card shows "No data yet" or falls back to Manual entry |
| **Deputy** | Scheduling | Tomorrow's `/work` page is empty until shifts get bridged |
| **QuickBooks (manual)** | Payroll dollars, AR, expenses | Payroll math has to happen elsewhere |

---

## 7. Documented known bugs (none open as of this writing)

The Phase Inspection v1.0 production audit fixed 7 bugs in late June 2026. The Kirby production usability fix (labor table clip + Mission Control button scroll) resolved Kirby's two reported issues. No P0 bugs open at this writing.

If a bug surfaces during the documentation-to-staff handoff, add it here with the date, symptom, and either the fix commit or the workaround.

---

## 8. Maintenance discipline

This gaps doc is only useful if it stays current. Recommended cadence:

- **When a "Planned" item ships:** Move it from this file to the Capability Inventory.
- **When a workaround gets eliminated:** Remove the entry.
- **When a new gap is discovered:** Add it here with date.
- **Quarterly:** Leadership reads the whole file and confirms each entry is still accurate.

---

## End of Known Gaps

For the surfaces that ARE live → `01-capability-inventory.md`.
For training around the gaps (especially "what to tell a new hire NOT to expect yet") → `03-training-outline.md`.
