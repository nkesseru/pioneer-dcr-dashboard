# PioneerOps — Phase 26 Backlog

**Status:** active engineering backlog
**Branch baseline:** `feature/admin-mission-control` at commit `451de3b` (docs) / `917d335` (last code change)
**Generated:** 2026-05-31
**Owners:** admin engineering team, with ops + support input on Priority 1 sequencing

---

## Executive Summary

The Phase 1–25f admin refactor closed on 2026-05-31. The Pioneer admin surface is now a 638-line shell (`public/admin.js`) plus 27 self-contained foundation + tab modules under `public/admin/`. Zero refactor-caused regressions, one same-cycle P0 caught and fixed (Phase 22 lazy-init), ~19 latent bugs surfaced and fixed along the way. See [`PioneerOps-Refactor-Scorecard.md`](./PioneerOps-Refactor-Scorecard.md) for the full retrospective and [`PioneerOps-Architecture-Guide.md`](./PioneerOps-Architecture-Guide.md) for the post-refactor architecture.

**Current system status:** stable in production. No active incidents. No outstanding refactor work. Cross-tab fan-out, auth controller, deps bridge, and per-tab `init()` registration are all behaving as designed.

**Current `admin.js` size:** 638 LOC (down from 14,290 — a 95.5% reduction).

**Why Phase 26 exists.** Three categories of work surfaced during the refactor that were deliberately deferred to keep refactor commits behavior-preserving:
1. **Product safety gaps** — three privilege-escalation / destructive actions fire without confirmation
2. **UX polish** — four loading/empty-state inconsistencies observed during phase QA
3. **Operational improvements** — service-worker / cache discipline + a reusable production regression checklist

Phase 26 ships these. It is **not** a refactor phase. It is **not** an architecture phase. There is no "Phase 26 plan" for `admin.js` LOC reduction.

**Guiding principle:** *Product improvements, not architecture churn.*

Every Phase 26 item must satisfy one of: it makes the product safer, it makes the product easier to use, or it makes the team's operational discipline stronger. Items that only move code around — even cleanly — belong somewhere else.

---

## Priority 1 — Product Safety Fixes

Three privilege-escalation / destructive actions in the admin UI currently fire immediately on click with no confirmation. All three were observed during Phase 24 / 25 QA and explicitly deferred from the refactor because they require new modal markup + new state, not just code movement.

Treat these as the **highest priority** items in this backlog. They should ship together as a single coherent commit — they share the confirmation-modal infrastructure and the touchpoints overlap.

### 1.1 Promote To Admin Confirmation Flow

**Problem.** Clicking the More-menu "Promote to Admin" action on a tech row in `/admin` (Cleaning Techs tab) immediately calls `tabs.admins.promoteTechToAdmin(t)`. The handler creates an `/admins/{email}` Firestore doc, sends a password-reset email via the `createAdminLoginV1` Cloud Function, and refreshes the Admins list. There is no confirmation dialog between the click and these side effects.

**Risk.** Privilege escalation by mis-click. Promote grants the target user full PioneerOps admin permissions (`isPioneerAdmin()` in `firestore.rules` checks the `/admins` doc). A wrong-row click silently grants admin access that requires manual intervention to revoke (delete the `/admins` doc + notify the user the reset email was spurious). Audit trail noise: the resulting `/admins` doc + reset-email logs document an action no one consciously approved.

**Proposed solution.**
- Add a confirmation modal (`admin-promote-confirm-modal`) to `public/admin.html`, sibling to the existing `tech-archive-confirm-modal`. Content: tech display name + email, explicit list of consequences ("creates an /admins doc", "sends a password-reset email", "this user can read and write Pioneer admin data"), Cancel + "Yes, promote to admin" buttons.
- In `tab-techs.js` `wireTechControls`, change the dispatch from immediate call to: open the modal, wait for confirm, then call `tabs.admins.promoteTechToAdmin(t)`. Cancel = no-op.
- Use the shell's existing `openModal` / `closeModal` + `MODAL_REGISTRY` pattern. No new shell helpers needed.

**Files likely affected.**
- `public/admin.html` — new modal markup (~30 lines)
- `public/admin/tab-techs.js` — dispatch change at line 1483 (`if (action === "promote") …`)
- `public/admin/tab-admins.js` — register the new modal in `MODAL_REGISTRY` if it needs save-button-state machinery
- `public/admin/_shell.js` — extend `MODAL_REGISTRY` if applicable

**Estimated effort.** 2–3 hours including QA. The modal pattern is already established; this is mostly markup + a 5-line dispatch swap.

**QA requirements.**
- Click Promote on a test tech row → modal opens → Cancel closes modal with no Firestore write
- Click Promote → confirm → `/admins` doc created, reset email sent, Admins list updates
- Click Promote → confirm → force `permission-denied` in another tab (sign out) → toast + modal error fires
- Esc closes the modal without firing
- Backdrop click closes the modal without firing
- After confirm completes, focus returns to the tech row that triggered the action

---

### 1.2 Reinvite Confirmation Flow

**Problem.** Three call sites fire `tabs.admins.sendResetInviteFor(email, …)` immediately:
- Cleaning Techs tab → tech row More menu → "Resend invite" (`tab-techs.js:1481`)
- Admins tab → admin row "Resend invite" button (`tab-admins.js:623`)
- Admin Edit modal → "Resend invite" button (`tab-admins.js:655`)

All three send a password-reset email immediately on click with no confirmation. The destination email is visible in the row context but the user is not asked to confirm.

**Risk.**
- **Accidental email to staff** — confusing to the recipient (unexpected password-reset email), generates support questions
- **Audit-trail noise** — repeated mis-clicks generate repeated reset emails that look like targeted activity in Firebase Auth logs
- **Multi-send amplification** — Reinvite on a tech that already has a pending reset adds a second reset link, and the first one stays valid; the recipient sees two emails with two different links

**Proposed solution.**
- Lightweight confirmation dialog with the target email rendered prominently: "Send password-reset email to `<email>`?" — Cancel + "Send" buttons. Cancel = no-op.
- Either reuse the new promote-confirm modal pattern (separate modal element, generic title/body) or introduce a single small reusable confirm-dialog helper in `_shell.js` (e.g., `shell.confirm({ title, message, confirmLabel, danger })` returning a Promise). The reusable helper is preferred — it would also serve the Reactivate flow (§1.3) and any future destructive-action confirmations.
- All three call sites swap from `sendResetInviteFor(email, …)` to `shell.confirm({...}).then(ok => ok && sendResetInviteFor(email, …))`.

**Files likely affected.**
- `public/admin/_shell.js` — new `confirm()` helper (~30 lines) if going the reusable route
- `public/admin.html` — generic `admin-confirm-modal` markup (~25 lines) if reusable
- `public/admin/tab-techs.js` — dispatch change at line 1481
- `public/admin/tab-admins.js` — two dispatch changes (lines 623, 655)

**Estimated effort.** 3–4 hours if building the reusable `shell.confirm`. The investment pays off across §1.1, §1.3, and future flows.

**QA requirements.**
- Click Resend on a tech row → modal opens with the tech's email visible → Cancel closes with no email sent
- Click Resend → confirm → reset email sent (verify in Firebase Auth logs or recipient inbox in dev)
- Same flow from Admins tab row
- Same flow from Admin Edit modal Resend button — modal should not conflict with the parent Admin Edit modal still being open (verify z-index and focus management)
- Esc / backdrop click cancels without sending
- Force a Cloud Function error (e.g., simulate non-existent email) — toast + modal error fires

---

### 1.3 Reactivate Confirmation Flow

**Problem.** `onTechArchive` (`tab-techs.js:823`) and `onCustomerArchive` (`tab-customers.js:536`) are dual-purpose handlers: when the target is currently `active: true`, they archive; when currently `active: false`, they reactivate. The **archive** branch opens an explicit confirmation modal (`openArchiveConfirmModal`) before firing. The **reactivate** branch fires immediately — it re-enables the auth user (for techs) and flips `active: true` with no confirmation.

**Risk.**
- **Reactivation of intentionally-offboarded staff** — a tech archived for cause (performance, employment ended, security concern) gets their PioneerOps login re-enabled on a single accidental click. The auth re-enable in particular is operationally significant: it restores the tech's ability to submit DCRs, view customer info, etc.
- **No paper trail of "I meant to do this"** — archive has a confirm step that creates an implicit audit moment; reactivate doesn't. Post-incident reconstruction is harder.
- **Same asymmetry on the Customers side** — reactivating a customer re-exposes them in the DCR form. Less risky than the tech case but still surprising.

**Proposed solution.**
- Use the same `shell.confirm()` helper introduced in §1.2 (if going that route) or a dedicated `tech-reactivate-confirm-modal` + `customer-reactivate-confirm-modal` pair (matches the existing archive-confirm-modal pattern).
- Reactivate text should call out the specific consequences: "Reactivating <name> will re-enable their PioneerOps login and add them back to the active staff index" (techs) / "Reactivating <name> will make them visible again in the DCR form" (customers).
- Optionally include the date/time of the original archive ("archived 2026-03-12 by `<admin>`") so the admin sees what they're undoing.

**Files likely affected.**
- `public/admin/_shell.js` — uses the `confirm()` helper from §1.2
- `public/admin.html` — if going dedicated-modal route, two new modals (~50 lines total)
- `public/admin/tab-techs.js` — `onTechArchive` reactivate branch (`tab-techs.js:842` and surrounding) — guard with confirm
- `public/admin/tab-customers.js` — `onCustomerArchive` reactivate branch (`tab-customers.js:549` and surrounding) — guard with confirm

**Estimated effort.** 2 hours if reusing `shell.confirm` from §1.2. 4 hours if building dedicated modals.

**QA requirements.**
- Archive a test tech → confirm flow still works as today (no regression)
- On the archived tech row, click Reactivate → modal opens with consequence text + original-archive metadata → Cancel keeps tech archived (no Firestore write, no auth re-enable)
- Reactivate → confirm → tech becomes active, auth user re-enabled, row re-renders with Active badge
- Same flow for Customers tab
- Force the Cloud Function `setTechAuthDisabled(false)` to fail (mock or wrong endpoint) — confirm the error path surfaces toast + modal error and Firestore stays at `active: false` (transaction integrity)

---

## Priority 2 — UX Improvements

Four observed-but-not-blocking UX gaps. Lower risk than Priority 1 but each was noticed during QA and deserves cleanup before they accumulate into bigger problems.

### 2.1 Attendance Loading State Cleanup

**Current state.** Phase 24's CSS `[hidden]` fix (commit `6d15163`) resolved the main "loading banner + empty state simultaneously" bug across the Attendance sub-tabs. Two minor cleanups remain:
- **Open Shifts sub-tab** has its own independent fetch flow that fires when the user clicks the sub-tab. During that fetch window, the panel is briefly blank (no loading indicator inside the sub-panel itself — the global `#attendance-loading` banner is already hidden by then since Attendance's main load completed). Brief but visible empty pause.
- **Refresh flow** during a re-fetch leaves stale data visible (intentional — better than blank — but no visual indication that a re-fetch is in progress).

**Desired state.**
- Open Shifts sub-tab shows a small in-panel loading indicator during its first fetch (after that, instant render from in-memory).
- The Attendance refresh button (`#attendance-refresh`) shows a "Refreshing…" label flip during re-fetch, same pattern as the DCR Refresh button (`tab-recent-dcrs.js` `wireRecentDcrsControls`).

**Effort.** 1–2 hours. Pattern lift from `tab-recent-dcrs.js` refresh-button code.

**Files.** `public/admin/tab-attendance.js`.

---

### 2.2 Tech Health Loading Banner Cleanup

**Current state.** `#tech-health-loading` (`admin.html:1228`) is `<div class="admin-status admin-loading">` — *no `hidden` attribute*, so visible by default. `tab-tech-health.js:79` declares the standard status-ID map; `:250` is the only direct hide site. Reported during QA as "persistent loading banner" — needs reproduction in production to confirm whether this is (a) the same class of bug as Phase 24's `[hidden]` footgun on `.admin-loading` (the audit during Phase 25f found no `display:` override on `.admin-loading`, so this *should* work), (b) the load is failing silently and not hiding the banner, or (c) the load is genuinely slow.

**Desired behavior.** Loading banner visible only during active fetch; hidden as soon as the first render completes. If load fails, switch to `#tech-health-error` with an actionable message.

**Effort.** 1 hour for diagnosis + fix once reproduced.

**Files.** `public/admin/tab-tech-health.js`. Possibly `public/admin.html` (initial `hidden` attribute on the loading banner if appropriate). Possibly `public/admin.css` / `styles/admin-overrides.css` if the Phase 24 footgun has re-surfaced on a different selector.

**Mandatory check before fix:** verify with DevTools whether `#tech-health-loading` has `hidden="true"` set in the DOM at the moment of observation. If yes → CSS override (apply the same defensive `[hidden] { display: none }` pattern from Phase 24). If no → JS-side hide path isn't firing → trace `setStatus("tech-health", …)` calls.

---

### 2.3 Announcements Empty-State Cleanup

**Current state.** `#announcements-empty` (`admin.html:712`) is `<div class="admin-status admin-empty" hidden>No announcements yet. Click "+ New announcement" to compose one.</div>`. After Phase 24's CSS fix, `[hidden]` should hide it correctly across all `.admin-empty` elements in `.admin-panel`. Reported during QA as "residual placeholder issue" — needs reproduction. Most likely root cause: the empty state appears briefly during a re-fetch (between `loadAnnouncements()` clearing the list and the new data arriving), or alongside data when the filter returns no matches.

**Desired behavior.**
- Empty state appears only when `announcements.length === 0` after a successful load
- Empty state never appears during loading (same guard pattern as Phase 24 Attendance `attendanceLoaded` flag)
- Search filter returning no matches should show a *filtered* empty state ("No announcements match your search") — distinct from the "you haven't created any yet" message, or just hide both and let the empty list speak for itself

**Effort.** 1–2 hours. Pattern lift from Phase 24's `attendanceLoaded` guard in `tab-attendance.js`.

**Files.** `public/admin/tab-announcements.js`.

---

### 2.4 Schedule Import UX Improvements

**Current state.** The Schedule Import V1 flow (`tab-schedule.js`) supports importing snapshots and producing drafts before publishing. Reported during refactor as having three sub-issues:
- **Draft handling** — unclear when a draft is created vs. overwriting an in-progress one
- **Draft visibility** — drafts are not surfaced prominently in the UI; an admin who started a draft yesterday may not remember
- **Import clarity** — the import flow's success/failure state messaging is terse; not always clear whether changes need to be published or are already live

**Desired behavior.**
- Persistent indicator showing "Draft from <date> exists — Resume or Discard?" when an admin opens Schedule with an in-progress draft
- Import flow explicitly differentiates "imported as draft" vs. "imported and published"
- Post-import summary shows what changed and what action is needed next

**Effort.** 8–12 hours — this is closer to a small feature than a polish item. Requires a quick PM/ops chat on the desired UX before implementation.

**Files.** `public/admin/tab-schedule.js`, `public/admin.html` schedule panel markup, possibly the `team_schedule` Firestore schema for draft-state tracking if not already supported.

**Recommendation:** treat as a Phase 26.5 / Phase 27 candidate rather than a same-sprint item with Priority 1.

---

## Priority 3 — Operational Improvements

### 3.1 Service Worker / Cache Strategy Review

**Reference incidents.**
- **Phase 22 (P0, commit `070f6de`)** — eager Firestore init crash. Not a cache incident per se, but the hotfix-deploy cycle exposed how hard it was for an open admin tab to pick up the fix (browser HTTP cache + tab-state caching). Hard reload required for every admin to recover.
- **Phase 23 hotfix-2 (commit `aba7f1a`)** — cache-bust mismatch on `_utils.js` after the Phase 23 push left its `<script>` query string at `?v=…phase4a`. Browsers served stale `_utils.js` → admin boot threw "_utils.js must load first" because the new `tab-schedule.js` was looking for symbols only present in the new `_utils.js`. Hand-fixed by bumping the cache-bust string on the source admin.html.
- **Phase 24** (commit `092a34c` + follow-ups) — packaging gap where the new `tab-attendance.js` wasn't initially referenced in deployed admin.html. Caught by the user's QA pass; fixed with a one-line `<script>` tag add + redeploy.

**Risks (current state).**
- Cache-bust query strings are **hand-bumped per phase**. A future contributor who forgets the bump after a `<script src="…">` source change will produce a "works in incognito, broken on returning admins" failure mode that's hard to diagnose without DevTools network inspection.
- The service worker (`public/sw.js`) is verified passthrough — *does not cache anything* — which is good for safety but means there's no offline story for the admin page.
- `firebase.json` sets `Cache-Control: no-cache` for `*.js` / `*.css` / `*.html`, so browsers always revalidate. This is the right setting but doesn't prevent the stale-tab problem (a tab loaded before the deploy keeps its in-memory copy of the old JS).

**Desired improvements.**
- **Automate cache-bust string generation.** Pre-commit hook (or `firebase deploy` wrapper script) that derives the `?v=` value from `git rev-parse --short HEAD` or per-file `git log -1 --format=%h <file>`. Single source of truth; can't forget to bump.
- **Document the hard-reload requirement** in the architecture guide (already present in §"Known PWA / service-worker cache caveat"). Reinforce in deploy docs / runbook.
- **Optional: in-page "new version available" notice.** A small hook that polls a version endpoint (or compares `pwa-register.js`'s SW version) and shows a toast prompting reload when the deployed version drifts from the loaded version. Adds complexity; only worth it if stale-tab incidents repeat.

**Testing strategy.**
- After every deploy, perform a "stale-tab reproduction" check: keep one admin tab open in incognito (pre-deploy), deploy, open a fresh tab (post-deploy), verify the stale tab continues to function (no JS errors) until reload. If the stale tab errors, the cache-bust discipline was insufficient.
- Add a "cache-bust audit" line item to the Phase 26.5 release checklist (see §3.2): grep every `<script src=` in `admin.html` for `?v=` and confirm the date matches the last code change on that file.

**Effort.** 4 hours for the pre-commit hook + docs. 8 hours if adding the in-page version-drift notice.

---

### 3.2 Full Production Regression Checklist

**Problem.** The Phase 25f sign-off pass surfaced the need for a reusable, surface-by-surface regression checklist that any admin engineer (or future AI agent) can execute after a non-trivial change. The Architecture Guide's "Testing checklist for future admin changes" is a good starting point but is structured by *flow* (boot, auth, every-tab-opens) rather than by *write surface*.

**Deliverable.** A reusable checklist organized by writeable Firestore collection. For each surface, document: the action to perform, what to verify, and how to reset the test fixture afterward. The categories below are the minimum coverage; expand as new modules ship.

### 3.2.1 Customers
- [ ] Open Customers tab → list renders → search filters
- [ ] Click Edit on a test customer → modal opens with current values → save no-op → list re-renders, search query preserved
- [ ] Edit a customer → toggle DCR-enabled → save → row badge updates
- [ ] Archive a test customer → confirm modal → customer hidden from active list
- [ ] Reactivate a test customer (post-§1.3 — should require confirm modal) → customer reappears
- [ ] "+ Add customer" → modal opens in create mode → type name → auto-slug fills → type in slug field → auto-fill stops → save → customer appears in list
- [ ] Force `permission-denied` (sign out in second tab) → save → toast + modal error fires

### 3.2.2 Cleaning Techs
- [ ] Open Cleaning Techs tab → list renders → search filters
- [ ] Edit a test tech → assignment checklist loads → save no-op
- [ ] Media modal — open on a test tech → upload zone visible (don't upload unless cleanup planned)
- [ ] More menu → Promote (post-§1.1 — should require confirm) → `/admins/{email}` doc created → Admins list updates
- [ ] More menu → Archive → confirm → tech moves to archived; auth user disabled
- [ ] More menu → Reactivate on the archived test tech (post-§1.3 — should require confirm) → tech active again, auth re-enabled
- [ ] More menu → Delete on a test tech → confirm → tech removed (irreversible; use a known-test fixture)
- [ ] More menu → Resend invite (post-§1.2 — should require confirm) → reset email sent
- [ ] "+ Add tech" → modal opens → name + auto-slug + assignment checklist → save → success pane shows reset link + temp password → copy buttons flash "Copied!"

### 3.2.3 Admins
- [ ] Open Admins tab → list renders
- [ ] Edit an admin → modal opens → save no-op
- [ ] Resend invite from row (post-§1.2 — should require confirm)
- [ ] Resend invite from inside Admin Edit modal (post-§1.2 — should require confirm)
- [ ] Create new admin login → success pane

### 3.2.4 Attendance
- [ ] Open Attendance tab → all 5 sub-tabs render cleanly (no loading-and-empty-simultaneously)
- [ ] Pending Time-Off — submit one as a test tech via `/time-off.html` → approve from admin → moves to Approved
- [ ] Call-Outs — submit one as a test tech via `/call-out.html` → acknowledge → resolve
- [ ] Calendar — verify 60-day grid renders, color levels correct for any active time-off
- [ ] Open Shifts — click sub-tab → list loads → "+ New open shift" → form opens → cancel works

### 3.2.5 Schedule
- [ ] Open Schedule tab → published snapshot loads → current schedule loads
- [ ] Upload a test PDF → preview appears
- [ ] (Post-§2.4) draft handling visible and clear

### 3.2.6 Deputy Mapping
- [ ] Open Deputy Mapping tab → mappings load
- [ ] Sync from Deputy (if Deputy creds present) → new shifts appear
- [ ] Open a Customer Edit modal → Deputy integration block populates (verifies `populateCustomerIntegration` cross-tab call)

### 3.2.7 DCRs
- [ ] Submit a test DCR via `/` → click Refresh on the Dashboard → DCR appears in Recent DCRs
- [ ] Verify the Customer card + Tech card for that DCR update their budget stats (proves `loadDcrsAndRerenderDependents` fan-out)
- [ ] Open DCR Review & Send on the new row → modal loads readiness check → send (if test customer)

### 3.2.8 Announcements
- [ ] Open Announcements tab → list renders cleanly
- [ ] Compose a test announcement → save → appears in list, unread badge updates on the Team Hub nav pill
- [ ] Archive the test announcement → removed from active list

### 3.2.9 Supply Requests
- [ ] Open Supply Requests tab → list renders → search filters
- [ ] Open a test request → flip status → list updates

**Effort.** 2 hours to format the checklist into a single `/docs/PioneerOps-Production-Regression-Checklist.md` file. 1 hour per regression pass to execute.

**Frequency.** After every Priority 1 ship; after every non-trivial admin code change; before any cross-page-affecting refactor.

---

## Priority 4 — Future Product Opportunities

Ideas only. Captured here to prevent them being forgotten; **not designed**, not scoped, not committed to. Each entry: short description, potential value, suggested priority for separate planning.

### 4.1 Better onboarding
- **What:** Streamlined first-week experience for new cleaning techs — interactive walkthrough of DCR submission, customer info hub, supply station, time-off request.
- **Value:** Reduces support burden during the most-likely-to-quit window. Faster ramp to DCR-submission self-sufficiency.
- **Suggested priority:** Medium. Worth scoping after Priority 1–3 ships.

### 4.2 Customer portal enhancements
- **What:** Customer-facing view of their own DCRs (read-only) at a unique URL per customer. Optional: customer can flag a DCR for revisit/recovery.
- **Value:** Reduces "where can I see what was done?" support calls. Surfaces trust signals.
- **Suggested priority:** Medium. Has product/sales implications — consult before designing.

### 4.3 DCR intelligence
- **What:** Automated detection of patterns in DCR submissions — repeated issues at one customer, tech-specific quality drift, photo-count anomalies. Could surface on the Day Health attention strip.
- **Value:** Operational signal before issues become customer complaints.
- **Suggested priority:** Medium-High. Synergizes with existing Day Health work; would benefit from a small ML/heuristics PoC.

### 4.4 Hiring integrations
- **What:** Sync with applicant-tracking system (or Deputy hiring module) to pre-populate new tech profiles. Auto-create Firebase Auth + `cleaning_techs` doc on hire.
- **Value:** Removes manual data entry on every hire. Reduces "tech can't log in" support tickets in the first week.
- **Suggested priority:** Low-Medium. Depends on which ATS is in use and whether their API supports the integration shape.

### 4.5 Reporting enhancements
- **What:** Exportable reports — monthly DCR summary per customer, on-budget % over time, tech performance dashboards. CSV + PDF.
- **Value:** Supports recurring customer business reviews. Internal performance management.
- **Suggested priority:** Medium. Operations team should weigh in on which reports are highest-value.

### 4.6 Mobile improvements
- **What:** Mobile-first redesign of tech-facing pages (`/work.html`, DCR form, `/tech.html`, supply station). Improved photo capture UX. Offline DCR drafting + queue.
- **Value:** Techs are mobile-first users. Better experience = better data quality and lower drop-off.
- **Suggested priority:** **High** — this is the single biggest user-experience lever for the existing user base. Worth a dedicated planning cycle.

---

## Technical Debt Register

Lifted from `PioneerOps-Refactor-Scorecard.md` "Remaining technical debt" and re-categorized for Phase 26 actionability.

### Inside `admin.js` (minimal, do not touch)
- **Cross-page nav block duplicated 5×** (`ROLE_NAV_ITEMS` + helpers + `paintTeamHubUnreadBadge`, ~120 LOC across `app.js` / `tech.js` / `admin.js` / `supply-station.js` / `team-hub.js`). **Intentional non-extraction** — see `app.js:2869-2874` for the documented load-order rationale. Touch only if reopening that decision.
- **12 small "moved to" breadcrumb comments** survived the Phase 25f sweep. Cosmetic. Not worth a follow-up commit.

### Remaining `deps` bridge entries (6 — all load-bearing)
These exist because multiple sibling tabs read the same data from one owning tab. They are not debt; they are the documented cross-tab seam. Do not retire without confirming each has only one consumer.
- `getCustomers` — 7 consumer files
- `getTechs` — 7 consumer files
- `getDcrs` — 5 consumer files
- `getDcrIssues` — 3 consumer files
- `getSupplyRequests` — 2 consumer files
- `loadDcrsAndRerenderDependents` — 2 consumer files; cross-tab orchestrator owned by `admin.js`

### Module-internal debt
- **`tab-schedule.js` (2,108 LOC) and `tab-deputy-mapping.js` (2,039 LOC)** exceed the plan-doc's 1,500-LOC target. Both are genuinely cohesive single subsystems. Splitting costs more than it saves. Accept as-is.
- **`tab-schedule.js` `dayHealth24h` dead state** — confirmed unused since Phase 23; preserved verbatim. Safe to delete in a one-line cleanup commit if anyone is touching this file for other reasons.
- **Two byte-identical `slugify*` copies** (`tab-techs.js` `slugifyTechCandidate`, `tab-customers.js` `slugifyCustomerCandidate`). 8 lines each. Could move to `_utils.js`. Not worth the cross-file change for the savings.

### Known architectural constraints
- **No build pipeline.** Vanilla JS + Firebase compat SDK + IIFE modules. Deliberate. Documented as a non-goal in `PioneerOps-Refactor-Plan.md` §0. Any future "let's add Vite/esbuild/Webpack" should re-litigate this decision with the operational tradeoffs in mind (build = +ops complexity, +deploy step, +rollback risk in exchange for tree-shaking and module syntax that the current architecture doesn't need).
- **No automated tests.** Every change verified by manual browser QA. Same non-goal rationale. Phase 26's regression checklist (§3.2) is the substitute discipline.
- **Service worker is intentionally passthrough.** No offline support for admin. Field techs are online-first by design (always have coverage). See Architecture Guide §"Known PWA / service-worker cache caveat".

### PWA caveats
- Hard-reload required after every deploy for already-open tabs to pick up new JS. Documented; not fixable without an in-page version-drift notice (see §3.1).
- Cache-bust query strings are hand-bumped. Pre-commit hook would mitigate (see §3.1).

### Unresolved follow-ups from the scorecard
- **`CLAUDE.md` does not exist.** Recommended as a small doc-only commit; would benefit future AI-assisted work (covering: deps bridge state, shell helpers map, tab-module template, CSS `[hidden]` footgun lesson). Low effort; deferrable until next AI engagement.
- **Architecture diagram is text-only.** A visual would help onboarding. Defer until/unless a designer is involved.

---

## Deferred / Not Recommended

Items intentionally NOT pursued. If a future contributor proposes one of these, point them at this section and the reasoning before they spend time.

### Large-scale rewrites
**Not recommended.** The Phase 1–25f refactor was structurally complete. `admin.js` is shell-shaped at 638 LOC. Tab modules are cohesive, single-responsibility, and reviewable in one sitting each. The pain point that drove the refactor — a 14,290-line monolith — no longer exists. Any "let's rewrite this in `<framework>`" proposal needs to articulate a problem the current architecture can't solve. The list of such problems is currently empty.

### Framework migration (React / Vue / Svelte / etc.)
**Not recommended at this scale.** The admin surface is ~16,000 LOC of working, tested-in-production vanilla JS. Migration cost (rewrite + retest + retrain ops + new deploy pipeline + new dependency surface) vastly exceeds any anticipated maintainability benefit. The single-file-per-tab pattern + the no-build constraint + the Firebase compat SDK choice form a coherent system that is easier to operate than the same surface in any modern framework would be. Re-evaluate only if a future feature (e.g., complex client-state UI) demonstrably can't be built without one.

### Repo split (admin / techs / customers / etc. as separate repos)
**Not recommended.** Current repo structure (single Firebase project, single `public/` folder, shared `firestore.rules` and `functions/`) reflects the operational reality — one Firebase project, one deploy pipeline, one auth surface. Splitting into multiple repos multiplies operational overhead (multiple deploys, multiple PRs to ship a cross-surface feature, multiple `firebase.json` files to keep in sync) without splitting any natural product seam. The current monorepo is correct for this product's scale.

### Premature abstraction
**Not recommended.** Examples to avoid:
- Building a generic "tab framework" with lifecycle hooks, render contracts, etc. — the current pattern (export `{init, refresh}`) is the minimum needed; anything more is YAGNI
- Introducing a state management library (Redux, Zustand) — every tab owns its own state; cross-tab reads go through the deps bridge; this is fine
- Adding a CSS framework (Tailwind, etc.) over the existing tokens-based system — the current approach works; the cost of migration would dwarf any productivity gain
- Building a "shared modal component" abstraction beyond `openModal` / `closeModal` + `MODAL_REGISTRY` — the existing helpers cover every modal in the system without forcing inheritance/composition patterns

When in doubt: write the simplest thing that solves the actual problem. Abstract only when the third concrete use case appears.

---

## Success Criteria for Phase 26

Phase 26 is **done** when:

### Product safety fixes shipped (Priority 1)
- [ ] §1.1 Promote-to-Admin confirmation modal deployed, QA'd, no regression
- [ ] §1.2 Reinvite confirmation deployed across all three call sites, QA'd
- [ ] §1.3 Reactivate confirmation deployed for both techs and customers, QA'd
- [ ] Either a reusable `shell.confirm()` helper or three dedicated modals chosen and implemented consistently
- [ ] Architecture Guide §"Rules for future developers" updated to include "destructive / privilege-escalation actions must require explicit confirmation"

### UX issues cleaned up (Priority 2)
- [ ] §2.1 Attendance loading state polish shipped
- [ ] §2.2 Tech Health loading banner reproduced + fixed (root cause documented)
- [ ] §2.3 Announcements empty-state guard pattern applied
- [ ] §2.4 Schedule Import — either shipped or explicitly scoped into Phase 27 with a PM-approved spec

### Regression suite updated (Priority 3)
- [ ] §3.1 Cache-bust automation either implemented or formally deferred with rationale
- [ ] §3.2 Production regression checklist promoted to `docs/PioneerOps-Production-Regression-Checklist.md` as a standalone file
- [ ] Regression checklist executed end-to-end at least once on a Phase-26 deploy to validate it works in practice

### Documentation current
- [ ] Refactor Scorecard remains accurate (no further changes to `admin.js` invalidated its claims)
- [ ] Architecture Guide §"Module ownership map" updated if any new modules were added
- [ ] This backlog moved to `docs/archive/` (or deleted) once all Priority 1–3 items are shipped or formally deferred
- [ ] Optional: `CLAUDE.md` added to the repo root

### Non-goals (explicitly out of scope for Phase 26)
- No further `admin.js` LOC reduction
- No tab module extraction
- No framework migration
- No build pipeline introduction
- No automated test infrastructure
- Priority 4 items are **ideas, not commitments** — none of them are "done" criteria

---

## Appendix — Cross-references

- **Refactor history:** [`PioneerOps-Refactor-Scorecard.md`](./PioneerOps-Refactor-Scorecard.md)
- **Current architecture:** [`PioneerOps-Architecture-Guide.md`](./PioneerOps-Architecture-Guide.md)
- **Original plan:** [`PioneerOps-Refactor-Plan.md`](./PioneerOps-Refactor-Plan.md)
- **Feature catalog:** [`PioneerOps-Master-Feature-Guide.md`](./PioneerOps-Master-Feature-Guide.md)

---

*This backlog is a living document. Update Success Criteria checkboxes as items ship. Add Priority 4 items as ideas surface. Move shipped items to the archive section or delete them outright — only open work belongs here.*
