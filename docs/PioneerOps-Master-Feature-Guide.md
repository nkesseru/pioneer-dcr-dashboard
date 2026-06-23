# PioneerOps — Master Feature Guide

**Branch:** `feature/admin-mission-control`
**Commit range:** `9f52db2` → `bf10b1f` (5 thematic commits, 71 files, ~27,500 LOC net add)
**Status:** Pilot-deployed at `https://pioneer-dcr-hub.web.app`
**Stack:** Firebase Hosting (multi-page vanilla JS), Firestore, Firebase Auth (LOCAL persistence), Cloud Functions v2, Firebase Storage, Twilio (SOS — currently empty secrets), Gmail API (DCR customer email).

---

## Table of contents

1. [The five commits](#the-five-commits)
2. [Feature catalog](#feature-catalog)
   - [Authentication & identity](#authentication--identity)
   - [Field shift execution](#field-shift-execution)
   - [Customer-facing trust](#customer-facing-trust)
   - [Workforce operations](#workforce-operations)
   - [Quality & safety](#quality--safety)
   - [Emergency / SOS](#emergency--sos)
   - [Communication](#communication)
   - [PWA & install UX](#pwa--install-ux)
   - [Admin mission control](#admin-mission-control)
3. [Role guides](#role-guides)
   - [Employee guide (cleaning tech)](#1-employee-guide-cleaning-tech)
   - [Manager guide (April replacement)](#2-manager-guide-april-replacement)
   - [Admin guide (Kirby replacement)](#3-admin-guide-kirby-replacement)
   - [Owner guide (super admin)](#4-owner-guide-super-admin)
   - [Emergency / SOS guide](#5-emergency--sos-guide)
4. [Sitemap](#sitemap)

---

## The five commits

| # | Hash | Theme | Files |
|---|---|---|---|
| 1 | `9f52db2` | Admin mission control — Yesterday's Work, Improvements, SOS Events, Pilot Readiness, Schedule sync, targeted Announcements thread, archive flow | 4 (`admin.{html,js,css}`, `inspections.html`) |
| 2 | `a7cfd8f` | Employee experience — Today's Work + DCR golden path, Team Hub upgrade, SOS lone-worker protection, PWA install, login flow, customer-safe DCR report, customer display helper, celebrate sound + confetti, scroll-lock + iPhone fixes | 38 (employee-facing UI + PWA + login + SOS + customer report + assets) |
| 3 | `08906ec` | Workforce flows — Team Schedule (List + Coverage + Assignments), Open Shift pickup + Rockstar, Call Out, Time Off, Help Improve Pioneer | 14 (attendance + schedule + improvements pages + styles) |
| 4 | `ef72b42` | Backend — Firestore + Storage rules, indexes, 10+ new Cloud Functions including SOS dispatch, tokenized DCR report, native DCR email v6, pilot readiness, setTechAuthDisabled, attendance emails, shared customer display helper | 10 (`firestore.rules`, `storage.rules`, `firebase.json`, `firestore.indexes.json`, `functions/*`) |
| 5 | `bf10b1f` | Ops scripts — pilot readiness CLI, manual native DCR email sender, tech auth diagnostic, Tech Health V1 fixtures | 5 (`scripts/*`) |

---

## Feature catalog

### Authentication & identity

#### Sign-in (Google + email/password)
- **Purpose:** Single canonical sign-in surface for every staff member.
- **Who uses it:** All roles.
- **Where it lives:** `/login.html` + `staff-auth.js` + `whoAmIV1` Cloud Function.
- **Problem it solves:** Removes the legacy password-reset dead-end ("post-reset Firebase page with no Continue button") and centralizes the auth gate.
- **How it works:** Firebase Auth (LOCAL persistence) with Google popup primary + email/password fallback + "Forgot password" link that uses `actionCodeSettings.url` so post-reset users land back on `/login.html`. `whoAmIV1` verifies the ID token, resolves admin vs cleaning_tech, returns `{allowed, role, tech}`.
- **Required permissions:** Public; gates downstream pages.
- **Notifications:** Password-reset email on Forgot Password.
- **Firestore / Functions:** Reads `cleaning_techs`, `admins`, hardcoded admin allowlist; function `whoAmIV1`.
- **Status:** **Production.**

#### Tech invite
- **Purpose:** Onboard a new cleaning tech.
- **Who uses it:** Admin.
- **Where it lives:** Admin → Core Ops → Cleaning Techs → +New, `createCleaningTechLoginV1`.
- **Problem it solves:** Creates the auth user, the cleaning_techs doc, and the password-reset link in one step.
- **How it works:** Server creates Firebase Auth user (password or Google-only), upserts `cleaning_techs/{slug}`, mints a password-reset link with `INVITE_CONTINUE_URL=/login.html`.
- **Required permissions:** Admin (allowlist or `/admins/{email}.active==true`).
- **Notifications:** Password-reset Gmail to tech.
- **Firestore / Functions:** `cleaning_techs`, Firebase Auth, `createCleaningTechLoginV1`.
- **Status:** **Production** (pilot-tested with Makaila, Drew, Jared).

#### Archive tech (access revocation)
- **Purpose:** Remove PioneerOps access when a tech is offboarded — no historical data loss.
- **Who uses it:** Admin.
- **Where it lives:** Admin → Cleaning Techs → More → Archive; `setTechAuthDisabledV1`.
- **Problem it solves:** Closes the security risk of departed techs retaining session access.
- **How it works:** DOM confirmation modal (`window.confirm` was being auto-dismissed by automation) → flips `cleaning_techs.active=false`, writes `active_techs_by_email/{email}.active=false`, calls Cloud Function that disables the Firebase Auth user AND revokes refresh tokens. The Firestore rule `isActiveStaff()` then denies every field-tech write — three layers of defense.
- **Required permissions:** Admin.
- **Notifications:** None (silent revocation).
- **Firestore / Functions:** `cleaning_techs`, `active_techs_by_email`, Firebase Auth; function `setTechAuthDisabledV1`.
- **Status:** **Production.**

#### Active-staff Firestore gate
- **Purpose:** Defense-in-depth rule helper.
- **Who uses it:** All field-tech write paths.
- **Where it lives:** `firestore.rules` (`isActiveStaff()`, `isActiveCleaningTech()`).
- **Problem it solves:** Even with a fresh ID token, archived techs cannot write anything.
- **How it works:** Rule looks up `active_techs_by_email/{auth.token.email.lower()}.active == true`. Index is backfilled on rules deploy + maintained by archive/reactivate handlers.
- **Required permissions:** Index writable only by admin.
- **Notifications:** None.
- **Firestore / Functions:** `active_techs_by_email`.
- **Status:** **Production.**

---

### Field shift execution

#### Today's Work board
- **Purpose:** Tech's single-tap launchpad for tonight's shifts.
- **Who uses it:** Tech, Admin (Admin sees company-wide overview).
- **Where it lives:** `/work.html` + `today-work.js`.
- **Problem it solves:** Replaces the "go find your shift in Deputy" hunt with a Pioneer-native dispatch.
- **How it works:** Reads `deputy_shift_cache where sync_date == today AND employee_email == auth_email` (with slug + display-name fallbacks). Joins `pioneer_work_sessions/{shiftId}` for status. Renders cards with Start Work → Complete DCR → Finish Work steppers. Robust empty-state diagnostic shows "Current login: …" + ops window + raw shift count.
- **Required permissions:** Active cleaning_tech (email-match) or admin; rule `shiftBelongsToCaller()`.
- **Notifications:** None at render. Clock-in reminder card after Start Work.
- **Firestore / Functions:** `deputy_shift_cache`, `pioneer_work_sessions`.
- **Status:** **Production** (iPhone-tested; scroll-lock and Deputy-deep-link incidents resolved).

#### Start Work
- **Purpose:** Mark the PioneerOps work session open + nudge Deputy clock-in.
- **Who uses it:** Tech (admin can also for their own shifts).
- **Where it lives:** `today-work.js startWork()`.
- **Problem it solves:** Decouples the operational session from Deputy's unreliable shift deep-links.
- **How it works:** Atomic ownership check via the `shiftBelongsToCaller()` rule (reads `deputy_shift_cache/{shiftId}.employee_email`). Writes `pioneer_work_sessions/{shiftId}` with status="working". Pops the **Clock In Reminder** bottom card with a real `<a href="https://once.deputy.com/my">` anchor — never JS popup, never broken deep-link.
- **Required permissions:** Active cleaning_tech with `auth.email == shift.employee_email`.
- **Notifications:** In-app reminder card + `[StartWork]` log.
- **Firestore / Functions:** `pioneer_work_sessions`, `deputy_shift_cache`.
- **Status:** **Production.**

#### DCR form
- **Purpose:** Capture the customer-facing service record.
- **Who uses it:** Tech.
- **Where it lives:** `/` (`index.html`) + `app.js` + `submitDcrV1` Cloud Function.
- **Problem it solves:** Turns 18+ form fields into a guided golden-path flow when launched from Today's Work, while still supporting manual admin entry.
- **How it works:** **Assigned-shift summary card** (📍 Customer · 👤 Tech · 📅 Date · 🕘 Time) replaces Visit Details when launched from Start Work with a confident handoff. Six checklist sections (Bathrooms, General Areas, Kitchens, Offices, Entryways + custom) with auto-collapse on completion and scroll-to-next-incomplete. Photo upload, signature canvas, supplies request, problem reporting. Submit calls `submitDcrV1` which validates server-side (assigned_customer_slugs, signature, photos), creates `dcr_submissions/{id}`, materializes `dcr_issues`, optionally creates `supply_requests`, writes back `pioneer_work_sessions.status="needs_finish"`.
- **Required permissions:** Active staff; server validates `auth.token.email` matches assigned tech.
- **Notifications:** Server-side: optional `generateAndSendDcrEmailV1` to customer. UI: confetti + chime + "DCR submitted. Great work."
- **Firestore / Functions:** `dcr_submissions`, `dcr_issues`, `pioneer_work_sessions`, `supply_requests`; function `submitDcrV1`.
- **Status:** **Production** (DCR pipeline is the most-deployed surface).

#### Golden-path success screen
- **Purpose:** Hand the tech directly into Finish Work — no thinking required.
- **Who uses it:** Tech.
- **Where it lives:** `app.js paintSuccessGoldenPath()` rendered in `#success-card`.
- **Problem it solves:** Tech used to leave the DCR success screen without finishing the work session; admin had to chase.
- **How it works:** When `pioneer_session_id` present in URL → renders **Final Step** panel: primary "Finish Work in PioneerOps" (= `/work.html?finishSession={id}`), secondary "Open Deputy App" (real `<a target="_blank">`), small "Back to Today's Work" link, helper "Deputy is still the official time clock." When no session → fallback "Back to Today's Work" + "Start another DCR" for admin/manual use.
- **Required permissions:** Active cleaning_tech.
- **Notifications:** Confetti + chime via `celebrate.js`.
- **Firestore / Functions:** None at this step; downstream `finishWork()`.
- **Status:** **Production.**

#### Finish Work
- **Purpose:** Close the PioneerOps session + nudge Deputy clock-out.
- **Who uses it:** Tech.
- **Where it lives:** `today-work.js finishWork()`; auto-triggered when `?finishSession=<id>` lands on `/work.html`.
- **Problem it solves:** Same as Start Work — Pioneer-native session close, no Deputy dependency.
- **How it works:** Writes `pioneer_work_sessions.status="finished"` + `pioneer_finished_at`. Pops top-of-viewport "Shift complete. Nice work tonight." toast + bottom clock-out reminder card with "Open Deputy App" anchor. URL param is `history.replaceState`-stripped so reload is a no-op.
- **Required permissions:** Active cleaning_tech who owns the session.
- **Notifications:** Toast + reminder card + `celebrate.js` medium-intensity burst.
- **Firestore / Functions:** `pioneer_work_sessions`.
- **Status:** **Production.**

#### Customer Info Hub (SOPs + secure access codes)
- **Purpose:** Tech reads tonight's SOP + gate/alarm code before driving.
- **Who uses it:** Tech, Admin.
- **Where it lives:** `/tech.html` + `tech.js` + `customer-sop.js` + `techHubViewV1`.
- **Problem it solves:** Eliminates the "text Kirby for the alarm code" loop.
- **How it works:** Tech picks customer from a list filtered by their `assigned_customer_slugs`. Renders Quick Glance bullets, SOP markdown, last 5-star inspection. **Security Modal** loads `customer_secure/{slug}` (gate/alarm) via admin-SDK function only — Firestore rules deny tech reads.
- **Required permissions:** Active cleaning_tech with the customer in their assigned list; Security data needs the server function.
- **Notifications:** None.
- **Firestore / Functions:** `customers`, `customer_secure`; function `techHubViewV1`.
- **Status:** **Production.**

#### Supply Station Order
- **Purpose:** Tech requests supplies for next visit + checks gate/lock codes.
- **Who uses it:** Tech.
- **Where it lives:** `/supply-station.html` + `supply-station.js` + `submitSupplyStationOrderV1`.
- **Problem it solves:** Removes the text-Kirby supply chain.
- **How it works:** Tech picks customer (assignment-filtered), types order, submits. Server creates `supply_requests/{id}` and forwards to admin. The page also surfaces a customer's **Supply Station Access Card** (gate code + lock code) inline.
- **Required permissions:** Active cleaning_tech.
- **Notifications:** Admin badge on Supply Requests tab.
- **Firestore / Functions:** `supply_requests`, `customers`; function `submitSupplyStationOrderV1`.
- **Status:** **Production.**

---

### Customer-facing trust

#### Native DCR customer email (V6 template)
- **Purpose:** Send the customer a beautiful, branded DCR confirmation via Pioneer Gmail.
- **Who uses it:** Manager, Admin (manual send); future server-auto on submit.
- **Where it lives:** `generateAndSendDcrEmailV1` + `functions/dcrEmail.js`; readiness check via `getDcrEmailReadinessV1`.
- **Problem it solves:** Replaces the legacy Zapier path that 404'd two of three pilot DCRs.
- **How it works:** Pulls DCR + customer + tech; builds V6 HTML with hero customer name, tech avatar + tenure label, AI-generated cleaning summary (OpenAI), checklist bullets, photos, feedback CTAs, "View full report" tokenized link. Routes by `issueRouting.tier` (green/yellow/red). Sends via Gmail API (domain-wide delegation). Writes `dcr_submissions.emailStatus/emailedAt/gmailMessageId` and a `dcr_email_payloads/{dcrId}` audit doc.
- **Required permissions:** Admin (Bearer ID token).
- **Notifications:** Gmail to customer. Office alerts (Kirby + April) on red-tier.
- **Firestore / Functions:** `dcr_submissions`, `dcr_email_payloads`, `dcr_report_tokens`, `customers`, `cleaning_techs`; functions `generateAndSendDcrEmailV1`, `getDcrEmailReadinessV1`.
- **Status:** **Production** (pilot delivery verified to Rick Harvey at Novelis).

#### Tokenized customer report page
- **Purpose:** Single-DCR customer-safe view, no login required.
- **Who uses it:** Customer.
- **Where it lives:** `/dcr-report.html` + `dcr-report.js` + `getDcrReportByTokenV1` + `functions/dcrReport.js`.
- **Problem it solves:** Customer can drill into the cleaning report without a portal account.
- **How it works:** Per email send, server mints a 32-byte URL-safe token, stores `sha256(token)` in `dcr_report_tokens/{hash} → {dcr_submission_id, view_count}`. Email's "View full report" link carries the raw token. Public endpoint hashes the incoming token, fetches the DCR + customer, applies the customer-safe whitelist (no internal IDs, notes, or audit fields), and renders branded report with tech tenure label, checklist done items, photos, feedback links. Each view bumps `report_view_count` + `last_report_viewed_at` mirrored onto the DCR doc.
- **Required permissions:** Public (token = auth).
- **Notifications:** Admin sees view count in Yesterday's Work.
- **Firestore / Functions:** `dcr_report_tokens`, `dcr_submissions`; function `getDcrReportByTokenV1`.
- **Status:** **Production.**

#### Public feedback forms
- **Purpose:** Customer compliments and concerns intake.
- **Who uses it:** Customer.
- **Where it lives:** `/feedback-compliment.html`, `/feedback-issue.html`, `submitFeedbackV1`.
- **Problem it solves:** Direct customer signal without email.
- **How it works:** Forms linked from DCR email + report page. Public submission with body validation + honeypot. Compliments may attach to Pioneer Quality wins display.
- **Required permissions:** Public.
- **Notifications:** Admin Gmail on submit.
- **Firestore / Functions:** `feedback`; function `submitFeedbackV1`.
- **Status:** **Production V1** (rate limiting noted as TODO).

#### Tech tenure phrasing
- **Purpose:** Make experienced techs read as seasoned, never as new.
- **Who uses it:** All customer-facing surfaces (email + report).
- **Where it lives:** `functions/dcrReport.js buildTechTenureLabel()`, `functions/dcrEmail.js v3VisitTagline()`.
- **Problem it solves:** Old wording said "getting familiar with your location" even for techs who'd cleaned a site for years.
- **How it works:** Reads admin overrides in priority: `cleaning_techs.locationExperienceLabel[customerSlug]` → `cleaning_techs.profileTagline` → `experienceMonthsAtCurrentAccounts`. Falls through to DCR-history heuristic: ≥25 visits = "Regular Pioneer tech at this location"; ≥12 months tenure = "{years}+ year experience…"; ≥6 months = "6+ months experience…"; 2–24 visits = "Part of the regular Pioneer team for this location"; else "Experienced Pioneer cleaning tech."
- **Required permissions:** Reads from server.
- **Notifications:** None.
- **Firestore / Functions:** `cleaning_techs`, `dcr_submissions`.
- **Status:** **Production.**

#### Customer display name helper
- **Purpose:** One canonical resolver for the customer string shown on every surface.
- **Who uses it:** Everywhere a customer is rendered to a human.
- **Where it lives:** `public/customer-display.js` (front-end) + `functions/customerDisplay.js` (server). Same logic, both sides.
- **Problem it solves:** Inconsistent display — DCR dropdown used `location_name`, Today's Work used `customer_name`, etc.
- **How it works:** `getCustomerDisplayName(customer)` priority: (1) `customDisplayName` when `displayNameMode === "customAlias"`; (2) `location_name` when `displayNameMode === "locationName"`; (3) `customer_name` default; (4) `slug` last resort. Applied on DCR form, Today's Work, Yesterday's Work, Team Hub schedule, Team Schedule list/coverage/assignments, Customer Info Hub, native DCR email, customer report. Snapshot builder bakes the helper output; render-time fallback resolves stale snapshots against live `cleaning_techs` doc lookups.
- **Required permissions:** Public schema fields.
- **Notifications:** None.
- **Firestore / Functions:** `customers.displayNameMode + customDisplayName`.
- **Status:** **Production.**

---

### Workforce operations

#### Call Out (same-day / running late)
- **Purpose:** Tech reports a same-day attendance issue.
- **Who uses it:** Tech.
- **Where it lives:** `/call-out.html` + `call-out.js`.
- **Problem it solves:** Removes the manual text-April routine.
- **How it works:** Form submission writes `call_outs/{id}` with `techUid == auth.uid` (rule-enforced). Cloud Function trigger `onCallOutCreatedV1` emails Kirby + April via Gmail; updates `onCallOutUpdatedV1` notify on status change.
- **Required permissions:** Active cleaning_tech.
- **Notifications:** Gmail to Kirby + April.
- **Firestore / Functions:** `call_outs`, `notifications`; functions `onCallOutCreatedV1`, `onCallOutUpdatedV1`.
- **Status:** **Production.**

#### Request Time Off
- **Purpose:** Planned PTO request.
- **Who uses it:** Tech.
- **Where it lives:** `/time-off.html` + `time-off.js`.
- **Problem it solves:** Pioneer-native replacement for the legacy GHL form.
- **How it works:** Form writes `time_off_requests/{id}` with status="pending". `onTimeOffRequestCreatedV1` emails Kirby/April. Visibility is open to any signed-in staff so the Team Schedule coverage heatmap can render.
- **Required permissions:** Active cleaning_tech.
- **Notifications:** Gmail.
- **Firestore / Functions:** `time_off_requests`; functions `onTimeOffRequestCreatedV1`, `onTimeOffRequestUpdatedV1`.
- **Status:** **Production.**

#### Open Shift Pickup ($25 Rockstar)
- **Purpose:** Tech accepts an open coverage shift, earns a $25 Rockstar bonus on admin confirmation.
- **Who uses it:** Tech.
- **Where it lives:** `/open-shifts.html` + `open-shifts.js`.
- **Problem it solves:** Replaces the legacy "Shift Acceptance" GHL widget with an atomic-claim flow that prevents double-accept.
- **How it works:** Tech taps Accept → Firestore atomic update flips `status:"open" → "accepted"` + stamps `acceptedByTechUid`. Rule rejects the second tech because pre-write status is no longer "open". Admin confirms coverage → batched write creates `rockstar_bonuses/{id}` with amount=$25.
- **Required permissions:** Active cleaning_tech; admin confirms.
- **Notifications:** Gmail via `onOpenShiftCreatedV1` / `onOpenShiftUpdatedV1`; celebrate.js for the tech on accept.
- **Firestore / Functions:** `open_shift_requests`, `rockstar_bonuses`; functions `onOpenShiftCreatedV1`, `onOpenShiftUpdatedV1`.
- **Status:** **Production.**

#### Team Schedule (next 21 days)
- **Purpose:** Visualize and filter the upcoming 21 days of Deputy shifts.
- **Who uses it:** All staff.
- **Where it lives:** `/team-schedule.html` + `team-schedule.js`.
- **Problem it solves:** Team-wide schedule visibility outside Deputy.
- **How it works:** Reads `published_team_schedule/current.shifts[]`. Three views: **Assignments** (Pioneer-native dispatch board), **List**, **Coverage Calendar**. Filters: tech, customer, mine/all. Scheduled-time-off overlay (collapsible). Avatars resolved via `cleaning_techs` directory. Display names resolved via `customer-display.js` at render time (so admin alias edits propagate without re-publish).
- **Required permissions:** Active staff.
- **Notifications:** None.
- **Firestore / Functions:** `published_team_schedule`, `cleaning_techs`, `customers`, `time_off_requests`.
- **Status:** **Production.**

#### Sync next 21 days from Deputy
- **Purpose:** One-button schedule publish.
- **Who uses it:** Admin.
- **Where it lives:** Admin → System → Schedule (primary card).
- **Problem it solves:** Replaces the fragile PDF upload + parse flow that broke on Kirby's machine.
- **How it works:** Calls `refreshDeputyShiftsRangeV1` for today→today+20, reads back `deputy_shift_cache`, normalizes each shift (with `customer-display.js` baked in), writes `published_team_schedule/current`. Per-day breakdown debug panel + `[DisplayNamePublish]` console logs. PDF + manual paste preserved under "Advanced backup" disclosure.
- **Required permissions:** Admin.
- **Notifications:** Confetti on success.
- **Firestore / Functions:** `published_team_schedule`, `deputy_shift_cache`; functions `refreshDeputyShiftsRangeV1`, `syncDeputyShiftsV1` (scheduled 10-min).
- **Status:** **Production.**

#### Yesterday's Work admin recap
- **Purpose:** Manager morning recap of the previous ops day.
- **Who uses it:** Manager, Admin.
- **Where it lives:** Admin → Core Ops → Yesterday's Work.
- **Problem it solves:** Single screen tells admin "what happened last night."
- **How it works:** Pacific 4pm cutoff ops-window logic. Date picker + prev/next arrows. Top stat strip (8 metrics: scheduled, started, finished, DCRs submitted, DCRs missing, issues, emails sent, emails failed). Per-tech grouping. Per-row status traffic light (GREEN / YELLOW / RED). Strongest-first match ladder: `pioneer_session_id` → `deputy_shift_id` → tech+customer+date triple → email key. Unmatched DCRs + Unmatched shifts sections. Customer-report view-count chip. Legacy `zapier.status` never colors a row.
- **Required permissions:** Admin.
- **Notifications:** None.
- **Firestore / Functions:** `deputy_shift_cache`, `pioneer_work_sessions`, `dcr_submissions`, `dcr_issues`, `cleaning_techs`, `customers`.
- **Status:** **Production.**

#### Pilot Readiness Check
- **Purpose:** Pre-rollout audit for every active tech.
- **Who uses it:** Admin.
- **Where it lives:** Admin → System → Pilot Readiness + `scripts/pilot-readiness-check.js` CLI.
- **Problem it solves:** Catches "missing recipient", "wrong Deputy mapping", "tech never signed in" before pilot day instead of during.
- **How it works:** Function `pilotReadinessCheckV1` walks every `cleaning_techs.active!==false` doc. Categories: Firebase Auth, tech record, Deputy mapping (next 7 days), permission preconditions (structural rule check), customer mapping, pending announcements, mobile-safety manual note. Emits PASS / WARN / FAIL per check + overall per tech.
- **Required permissions:** Admin.
- **Notifications:** None.
- **Firestore / Functions:** Reads many collections; function `pilotReadinessCheckV1`; engine `functions/pilotReadinessEngine.js`.
- **Status:** **Production.**

#### Tech Health V1
- **Purpose:** 30-day operational signals per tech.
- **Who uses it:** Admin.
- **Where it lives:** Admin → Quality → Tech Health.
- **Problem it solves:** Surfaces reliability + contribution + watch signals — coaching surface, not surveillance.
- **How it works:** Aggregates DCR submissions, work sessions, attendance, supply requests for the trailing 30 days per tech. Color-coded watch tiers.
- **Required permissions:** Admin.
- **Notifications:** None.
- **Firestore / Functions:** Aggregates from many collections.
- **Status:** **Production.**

---

### Quality & safety

#### Inspections
- **Purpose:** Weekly customer-site quality inspections.
- **Who uses it:** Admin.
- **Where it lives:** `/inspections.html` + `inspections.js`.
- **Problem it solves:** Quality data feeds the Pioneer Quality score + 5-star team wins.
- **How it works:** Inspection intake form scores per area, captures credited cleaning tech, writes `inspections/{id}`. Score ≥4.8 + credit → `quality_wins/{id}`. Issues during inspection → `dcr_issues/{id}`.
- **Required permissions:** Admin.
- **Notifications:** None.
- **Firestore / Functions:** `inspections`, `quality_wins`, `dcr_issues`.
- **Status:** **Production.**

#### DCR Issues backlog
- **Purpose:** Office triage of in-the-field problems.
- **Who uses it:** Admin.
- **Where it lives:** Admin → Quality → Issues.
- **Problem it solves:** Auto-created during DCR submit when a checklist item is "issue" or `has_problem==true` — no manual transcription.
- **How it works:** Server materializes `dcr_issues/{id}` inside `submitDcrV1`. Admin moves status through new → reviewed → customer_contacted → resolved / closed_no_action. Admin notes never leak to techs.
- **Required permissions:** Admin read/update.
- **Notifications:** None.
- **Firestore / Functions:** `dcr_issues`; written by `submitDcrV1`.
- **Status:** **Production.**

#### Service Recoveries
- **Purpose:** Customer-level follow-up tasks.
- **Who uses it:** Admin.
- **Where it lives:** Admin → Quality → Service Recoveries.
- **Problem it solves:** Tracks long-tail follow-ups that don't fit a single DCR issue.
- **How it works:** Manually-created `service_recoveries/{id}` tied to customer (and optionally inspection). Status workflow + resolution notes.
- **Required permissions:** Admin.
- **Notifications:** None.
- **Firestore / Functions:** `service_recoveries`.
- **Status:** **Production** (auto-creation from RED issues remains a build gap).

#### Customer Notes / Note Suggestions
- **Purpose:** Customer-level operational notes + tech-submitted suggestions.
- **Who uses it:** Admin (manage); Tech (suggest).
- **Where it lives:** Admin → Quality → Customer Notes / Note Suggestions.
- **Problem it solves:** Persistent customer context that survives turnover.
- **How it works:** Admin authors notes; techs suggest from Customer Info Hub; admin approves into the canonical notes set.
- **Required permissions:** Admin read; techs write to suggestions only.
- **Notifications:** Admin badge on Note Suggestions tab.
- **Firestore / Functions:** `customer_notes`, `note_suggestions`.
- **Status:** **Production.**

#### Pioneer Quality (Team Hub morale surface)
- **Purpose:** Company-wide quality score + recent 5-star wins shown to techs.
- **Who uses it:** Tech.
- **Where it lives:** Team Hub → 🌟 Pioneer Quality section + `pioneerQualityViewV1` function.
- **Problem it solves:** Public morale signal — deliberately omits per-area breakdowns + low-score callouts.
- **How it works:** Server aggregates rolling 30-day inspection score + recent `quality_wins`; returns sanitized payload.
- **Required permissions:** Active staff.
- **Notifications:** None.
- **Firestore / Functions:** `inspections`, `quality_wins`; function `pioneerQualityViewV1`.
- **Status:** **Production.**

#### Safety Training portal
- **Purpose:** Per-lesson training UI with quiz scaffolding.
- **Who uses it:** Tech.
- **Where it lives:** `/training.html` (catalog) + `/lesson.html` (per-lesson) + `training.js`.
- **Problem it solves:** Foundation for the eventual compliance training system.
- **How it works:** Lesson card lists assigned lessons; lesson page renders body, optional video URL, and quiz radio sections; completion writes to a per-tech record.
- **Required permissions:** Active cleaning_tech.
- **Notifications:** None.
- **Firestore / Functions:** `training_lessons`, `training_completion`.
- **Status:** **Beta — UI complete, curriculum not populated, requalification cadence + signature step + admin dashboard remain build gaps.**

#### Safety Incident / Near Miss
- **Purpose:** Tech reports incidents.
- **Who uses it:** Tech.
- **Where it lives:** Team Hub → Safety Incident card → opens external GHL form.
- **Problem it solves:** Captures OSHA-reportable signals.
- **How it works:** Direct link to `https://api.leadconnectorhq.com/widget/form/Y8QiwgpmRrkOe7F6exoa`.
- **Required permissions:** N/A (external).
- **Notifications:** Via GHL webhook.
- **Firestore / Functions:** N/A.
- **Status:** **Beta** (external; flagged for migration to Pioneer-native).

---

### Emergency / SOS

#### 🚨 SOS pill (top-right FAB)
- **Purpose:** Single-tap escalation for lone-worker safety and operational emergencies.
- **Who uses it:** Tech, Admin (for testing).
- **Where it lives:** `sos.js` injects FAB + modal on `/work.html`, `/`, `/tech.html`, `/team-hub.html`; styles in `public/styles/sos.css`.
- **Problem it solves:** Replaces Slack (unreliable after-hours) with a real audit trail + SMS fan-out.
- **How it works:** Top-right pill (moved off bottom thumb zone). Three-step flow: **Step 1** "Are you safe?" → **Step A** Help-needed (textarea + context chips) → **Step B** Emergency (large [Call 911] + [Call April] side-by-side, secondary "Also send Pioneer SOS Alert"). Captures active shift / customer / staff identity / one-shot geolocation (only after Send). Multi-source staff resolution (`getCurrentStaff` → `getCachedStaff` → `firebase.auth().currentUser`) with up to 1.5s patient wait — admins on first iPhone load no longer race the access check. Always-on `[SOSAccess]` debug log.
- **Required permissions:** Active staff (admin or active cleaning_tech). Inactive users routed to a dedicated sheet with equal-prominence Call 911 + Call April.
- **Notifications:** Server `onEmergencyCreatedV1` dispatches SMS via Twilio.
- **Firestore / Functions:** `emergency_events`, `pioneer_config/emergency_contacts`; function `onEmergencyCreatedV1`.
- **Status:** **Beta — UI complete, SMS provider currently empty secrets (`notificationStatus: "sms_provider_missing"`). UI surfaces honest "Alert saved. Please call April now." with persistent tel/sms anchors. Twilio provisioning is the #1 recommended next build.**

#### Admin → SOS Events panel
- **Purpose:** Live triage of incoming SOS alerts.
- **Who uses it:** Manager, Admin.
- **Where it lives:** Admin → System → SOS Events.
- **Problem it solves:** Real-time visibility into open events + resolution workflow.
- **How it works:** `onSnapshot` listener; filter pills (Open / Critical only / Resolved / All); each card shows severity chip, tech, customer, time, geolocation Maps link, per-recipient SMS ✓/✗, persistent Call April + Call 911 buttons, resolve workflow with **required** notes. Tab badge shows open-event count.
- **Required permissions:** Admin (rule-enforced).
- **Notifications:** None at panel; external dispatch already happened.
- **Firestore / Functions:** `emergency_events`.
- **Status:** **Production.**

#### Need Help Now (urgent — non-emergency)
- **Purpose:** Tech can reach April directly for non-safety urgent issues.
- **Who uses it:** Tech.
- **Where it lives:** Team Hub → "Need Help Now?" red card → action sheet with [Call April] [Text April] [Cancel].
- **Problem it solves:** Slack not reliable for after-hours support; this is the always-available manual fallback that does NOT depend on Twilio or any Pioneer write.
- **How it works:** Real `<a href="tel:+15098283335">` and `<a href="sms:+15098283335?body=…">` anchors. iOS routes natively to dialer + Messages. Includes "If anyone is in immediate danger, call 911 first." banner.
- **Required permissions:** Any signed-in staff.
- **Notifications:** Native phone call / SMS.
- **Firestore / Functions:** None.
- **Status:** **Production.**

---

### Communication

#### Targeted Announcements V2
- **Purpose:** Operational comms — to all staff or to a selected audience — with mandatory ack and reply requirements.
- **Who uses it:** Admin (create); Tech (read + reply).
- **Where it lives:** Admin → System → Announcements; Team Hub → 📣 Announcements section.
- **Problem it solves:** Upgrades announcements from broadcast-only to threaded communication tied to operational policy.
- **How it works:** Admin picks audience: All active staff OR selected techs (searchable picker with avatars). Toggles Require Acknowledgement + Require Reply. Priority normal/important/urgent. Each card shows pre-V2 pills plus Acknowledge button + Reply button. Inline thread renders comments via `onSnapshot`; admin comments get teal "admin" chip + cyan background. Card status summary line shows "1 unread · 0 viewed · 0 acknowledged · 0 replied" lazy-loaded after render + "Awaiting reply" / "All responses complete" badges. Mandatory blocking modal honors audience targeting. Migration: pre-V2 docs (no `audienceType`) treated as "all" by both rule and client.
- **Required permissions:** Admin create/update; active staff create comments + recipient_status (rule-enforced).
- **Notifications:** Mandatory blocking modal on next page load for required acks.
- **Firestore / Functions:** `announcements/{id}` + `recipient_status/{uid}` + `comments/{commentId}` subcollections; `announcement_reads` legacy collection.
- **Status:** **Production.**

#### Mandatory blocking modal
- **Purpose:** Force-read for mandatory announcements.
- **Who uses it:** Tech.
- **Where it lives:** `mandatory-modal.js` injected on every signed-in page.
- **Problem it solves:** Pops a fullscreen overlay for unread mandatory announcements assigned to the user.
- **How it works:** Self-contained CSS inject so the modal renders correctly even on pages that don't load `admin.css`. Audience-aware filter applied to the queue. Writes `announcement_reads/{annId_uid}` on Mark as Read. Body overflow lock + cleanup in try/finally — no scroll-strand bug.
- **Required permissions:** Active staff.
- **Notifications:** None.
- **Firestore / Functions:** `announcements`, `announcement_reads`.
- **Status:** **Production.**

#### Help Improve Pioneer
- **Purpose:** Constructive operational improvement channel + separate protected-concerns intake.
- **Who uses it:** Tech, Admin (review).
- **Where it lives:** `/improve.html`, Admin → Quality → Improvements.
- **Problem it solves:** Structured operational feedback (not anonymous venting, not Slack drama).
- **How it works:** Two modes: Standard improvement (3-question form: problem / why it matters / what would improve it; optional category, PioneerOps-issue toggle, photos) and Protected concern (anonymous-capable; harassment/discrimination/ethics/safety). Admin panel: filter pills (Open / Implemented / Protected only / All); per-card status workflow (submitted → reviewing → needs_clarification → implemented / declined); inline admin reply thread (per-comment avatars + admin chip); admin notes (internal). Photos upload to Firebase Storage with admin-only read.
- **Required permissions:** Active staff create; admin read/update.
- **Notifications:** Tab badge counts open submissions.
- **Firestore / Functions:** `pioneer_improvements`; Storage path `pioneer-improvements/{submissionId}/`.
- **Status:** **Production.**

---

### PWA & install UX

#### PWA manifest + service worker
- **Purpose:** Installable on iPhone, Android, Desktop.
- **Who uses it:** All.
- **Where it lives:** `/manifest.webmanifest`, `/sw.js`, `/pwa-register.js`; loaded by every HTML entry.
- **Problem it solves:** Tech opens PioneerOps from home-screen icon like a real app; auth persists across launches.
- **How it works:** `display: standalone`, `theme_color: #111827`, 180/192/512 icons generated from `pioneer-logo2.png` via `sips`. Service worker is **intentionally minimal** — install + activate + passthrough fetch only. No caching of authenticated content (DCR submit, Auth tokens, work sessions all live-network). Manifest content-type + no-cache headers set in `firebase.json`.
- **Required permissions:** N/A.
- **Notifications:** None.
- **Firestore / Functions:** None.
- **Status:** **Production.**

#### Install PioneerOps card (Team Hub)
- **Purpose:** Friendly one-tap install instead of "Chrome menu → Cast, Save and Share → Install Page as App".
- **Who uses it:** Tech.
- **Where it lives:** Team Hub top + `pwa-install-ui.js`.
- **Problem it solves:** Most techs would never find the native install path.
- **How it works:** Detects `beforeinstallprompt` (Android/Chromium → native prompt) or iOS Safari (→ in-page modal with 3 steps + SVG share-glyph). "Maybe Later" suppresses for 30 days via `localStorage.pioneerops_install_dismissed_at`. Hidden when `display-mode: standalone`. `[PWAInstall]` event log on every action.
- **Required permissions:** Active staff.
- **Notifications:** None.
- **Firestore / Functions:** None.
- **Status:** **Production.**

---

### Admin mission control

#### Admin app structure
- **Purpose:** The single Admin shell hosting 20 panels in 3 groups.
- **Who uses it:** Manager, Admin, Owner.
- **Where it lives:** `/admin.html` + `admin.js` (~14k LOC) + `admin.css`.
- **Tab groups:**
  - **Core Ops:** Customers · Cleaning Techs · Recent DCRs · Yesterday's Work · Supply Requests
  - **Quality:** Issues · Service Recoveries · Customer Notes · Note Suggestions · Improvements · Tech Health
  - **System:** Feed · Announcements · Admins · Training · Schedule · Attendance · Deputy · SOS Events · Pilot Readiness
- **Required permissions:** Admin (allowlist or `/admins/{email}.active==true`).
- **Status:** **Production.**

#### Customers
- **Purpose:** Customer CRUD + per-customer config.
- **Where it lives:** Admin → Core Ops → Customers.
- **What it manages:** name, slug, email recipients (`dcrEmailRecipients[]`), `dcrEmailEnabled` opt-out, location_name, `displayNameMode`, `customDisplayName`, assigned_customer_slugs (back-reference), SOPs, `customer_secure` (gate/alarm codes), review links.
- **Status:** **Production.**

#### Cleaning Techs
- **Purpose:** Tech CRUD, invite, archive, promote, media (photo + signature).
- **Where it lives:** Admin → Core Ops → Cleaning Techs; archive flow uses DOM confirmation modal.
- **Status:** **Production.**

#### Recent DCRs
- **Purpose:** Audit + manual re-send.
- **Where it lives:** Admin → Core Ops → Recent DCRs.
- **What it manages:** Search by submission_id / customer / tech / clean_date; per-row send-customer-email action gated by `getDcrEmailReadinessV1`.
- **Status:** **Production.**

#### Supply Requests
- **Purpose:** Office triage of tech supply needs.
- **Where it lives:** Admin → Core Ops → Supply Requests.
- **Status:** **Production.**

#### Attendance
- **Purpose:** Call-outs + time-off + open shifts + calendar overlay.
- **Where it lives:** Admin → System → Attendance (sub-panels: Call Outs · Time Off · Open Shifts · Calendar).
- **Status:** **Production.**

#### Deputy Mapping
- **Purpose:** Map Deputy employee IDs / customer locations to Pioneer records.
- **Where it lives:** Admin → System → Deputy.
- **What it includes:** Connection Health diagnostic, Unmapped Deputy people list, customer alias mapping.
- **Status:** **Production.**

#### Operational Feed
- **Purpose:** Chronological event log surface.
- **Where it lives:** Admin → System → Feed.
- **Status:** **Production V1.**

#### Admins
- **Purpose:** Operational admin invite + archive.
- **Where it lives:** Admin → System → Admins.
- **What it manages:** `admins/{email}` Firestore-registered admins. The 4-email hardcoded allowlist is owner-only.
- **Status:** **Production.**

---

## Role guides

### 1. Employee guide (cleaning tech)

#### Day-1 onboarding
1. Receive Pioneer invite email → click password link → set password.
2. Open Safari → `https://pioneer-dcr-hub.web.app/login` → sign in with Deputy email.
3. Tap **Team Hub** in nav → Team Hub loads.
4. Scroll to **Install PioneerOps** card → tap **Install App** → follow the modal:
   - **iPhone:** Share → Add to Home Screen → Add.
   - **Android:** native install prompt fires automatically.
5. Open from home-screen icon → confirm it launches without the Safari address bar.

#### Every shift (the golden path)
1. Open PioneerOps from home screen → **Today's Work** in nav.
2. Find tonight's shift card → tap **Start Work**.
3. **Clock In Reminder** card appears at bottom → tap **Open Deputy App** → clock in → return to PioneerOps.
4. On the same card, tap **Complete DCR** → DCR form opens with the **assigned-shift summary** pre-populated (📍 Customer · 👤 You · 📅 Date · 🕘 Time).
5. Work through checklist (Bathrooms, General Areas, Kitchens, Offices, Entryways, and any custom sections). Sections auto-collapse on completion and scroll to the next.
6. Add photos, sign on the signature pad, type any supplies needed.
7. Tap **Submit DCR**. Confetti + chime + **"DCR submitted. Great work."** card.
8. Tap **Finish Work in PioneerOps** → app jumps back to Today's Work, closes the session, shows the **Shift complete. Nice work tonight.** toast + clock-out reminder.
9. Tap **Open Deputy App** → clock out in Deputy.

#### Other recurring tasks
- **Customer Info Hub** (nav) — read SOP + tap **Security** for gate/alarm code before driving.
- **Supply Station Order** (nav) — request supplies; check gate/lock codes.
- **Team Hub** (nav home) — read announcements (Acknowledge / Reply when prompted); see schedule preview; access Help Improve Pioneer.

#### When something goes wrong
| Situation | What to use |
|---|---|
| Locked out, alarm not working, can't find supplies | **Need Help Now?** card → Call April / Text April |
| Injury, accident, threat, medical emergency, fire | **🚨 SOS** pill top-right → "No, emergency" → **[Call 911]** first → optionally also **Send Pioneer SOS Alert** |
| Customer issue or operational idea | DCR form Issue section (during shift) or **Help Improve Pioneer** (later) |
| Schedule problem same-day | **Call Out / Running Late** card |
| Want time off | **Request Time Off** card |
| Want to pick up an open shift | **Open Shift Pickup** card |

### 2. Manager guide (April replacement)

#### Morning recap (5 minutes)
1. Open Admin → **Core Ops → Yesterday's Work**.
2. Verify date picker shows previous Pacific ops day.
3. Scan the **per-tech rollup** — pay attention to RED traffic lights.
4. Click **View DCR** on any RED row to inspect.
5. Click **Customer report ↗** to see what the customer actually received (or didn't).
6. Open **Unmatched DCRs** + **Unmatched shifts** sections — these are today's call-list.

#### Throughout the day
- Admin tab badges tell you what's new:
  - **SOS Events** badge → resolve any open events.
  - **Supply Requests** badge → fulfill new requests.
  - **Issues** badge → triage DCR-derived issues.
  - **Improvements** badge → reply in-thread, mark Implemented.
  - **Attendance** badge → approve time-off, create open shifts.
- **Customer Notes / Note Suggestions** — approve tech-submitted suggestions; author per-customer notes when something changes.

#### Weekly schedule rhythm
1. Admin → **System → Schedule** → tap **Sync next 21 days from Deputy** (one button).
2. Wait 20–60s for the success card.
3. Tap **View Team Schedule ↗** to confirm.
4. Check the per-day breakdown disclosure for any zero-shift days that should have shifts.

#### Announcements you'll send
- All-staff: weekly reminders, schedule updates, kudos.
- Targeted: when only certain techs need to know (a specific customer's access codes changed, two techs swapping shifts, etc.).
- Mandatory: anything they MUST read before continuing.
- Require Reply: when you need confirmation back.

### 3. Admin guide (Kirby replacement)

All Manager flows plus:

#### Adding a new customer
1. Admin → **Core Ops → Customers** → +New.
2. Required: customer slug (URL-safe id), customer_name, primary email.
3. **DCR email config:**
   - `dcrEmailEnabled: true` (default — set false to opt out).
   - `dcrEmailRecipients: [{ email, name? }]` — multi-recipient. Native DCR email won't send without at least one recipient on file.
4. SOP fields: quickGlance bullets, instructions markdown.
5. Customer secure (gate/alarm): use the secure modal; field-techs never read this directly.
6. Display name: optional `displayNameMode: "customAlias"` + `customDisplayName: "Willow & Branch"` when the customer's marketing name differs from internal.
7. Save → run **Pilot Readiness Check** to verify everything aligns.

#### Onboarding a new cleaning tech
1. Admin → **Core Ops → Cleaning Techs → +New**.
2. Required: display_name, email, tech_slug.
3. Set `assigned_customer_slugs` (drives DCR dropdown filtering + Customer Info Hub access).
4. Upload tech photo (`photoUrl`) — required for trust signal on customer email.
5. Upload tech signature (`signatureUrl`) — required for signed-receipt block on customer email.
6. Save → server creates the Firebase Auth user + sends password reset.
7. Run Pilot Readiness Check on the new tech → confirm PASS.

#### Archiving a departing tech
1. Admin → **Cleaning Techs** → find the tech → **More → Archive**.
2. Confirmation modal shows the 4 bullet effects → tap **Archive team member**.
3. Three security layers fire automatically:
   - `cleaning_techs.active = false` + `active_techs_by_email/{email}.active = false`.
   - `setTechAuthDisabledV1` disables the Firebase Auth user + revokes refresh tokens.
   - Firestore rules deny all field-tech writes from that auth identity going forward.
4. Toast confirms: "Team member archived and PioneerOps access removed."
5. Their historical DCRs, work sessions, etc. all remain intact.

#### Announcement targeting workflow
1. Admin → **System → Announcements → +New**.
2. Title + body + priority.
3. Audience: All active staff OR Selected team members (searchable picker with avatars).
4. Require Acknowledgement / Require Reply toggles.
5. Save → in the panel, tap **View thread** to monitor recipient status + replies in real time.
6. Reply as admin via the in-thread textarea — your reply carries the teal "admin" chip everywhere.

#### Deputy admin
- Admin → **System → Deputy** → Refresh button refreshes today's shifts immediately.
- Connection Health stat tile shows Deputy API status.
- Unmapped Deputy people list — map their emails/slugs to Pioneer `cleaning_techs` so future syncs work cleanly.

### 4. Owner guide (super admin)

All Admin flows plus:

#### Hardcoded admin allowlist (4 emails)
- Lives in three files (kept in sync manually):
  - `firestore.rules` → `isPioneerAdmin()`
  - `functions/index.js` → `ALLOWED_ADMIN_EMAILS`
  - `public/admin.js` → admin-email check
- To add a 5th senior admin: edit all three + deploy rules + deploy function + deploy hosting.
- For runtime admin additions, use **Admin → System → Admins → +New** (writes `admins/{email}` Firestore doc which is checked by the rule).

#### Twilio secret rotation (SOS SMS)
```
firebase functions:secrets:set TWILIO_ACCOUNT_SID --project pioneer-dcr-hub
firebase functions:secrets:set TWILIO_AUTH_TOKEN  --project pioneer-dcr-hub
firebase functions:secrets:set TWILIO_FROM_NUMBER --project pioneer-dcr-hub
firebase deploy --only functions:onEmergencyCreatedV1 --project pioneer-dcr-hub
```
Once Twilio is wired, SOS confirmation reads "Alert sent. April and Kirby have been texted." instead of "Alert saved. Please call April now."

#### Deputy OAuth credentials
- Secrets: `DEPUTY_CLIENT_ID`, `DEPUTY_CLIENT_SECRET`, `DEPUTY_INSTALL_URL`, `DEPUTY_ACCESS_TOKEN`.
- OAuth round-trip handled by `deputyOAuthStartV1` and `deputyOAuthCallbackV1`.
- Manual token path: `DEPUTY_ACCESS_TOKEN` is the simplest pilot path; OAuth is the long-term path.

#### Emergency contact phone numbers
Write `pioneer_config/emergency_contacts`:
```json
{
  "april": "+15098283335",
  "kirby": "+1...",
  "nick": "+1..."
}
```
Falls back to hardcoded `+15098283335` for April if missing.

#### Customer email opt-outs
Two fields, both checked by readiness gate:
- `customers/{slug}.dcrEmailEnabled` (camelCase, V6 canonical)
- `customers/{slug}.dcr_email_enabled` (snake_case, legacy)
Set both to `false` for full opt-out (script `_pilot-dcr-email-flags.js`-style writes do both).

#### Manual native DCR email send
```
node scripts/send-dcr-email.js --dcr <submission_id> --test nick@pioneercomclean.com
node scripts/send-dcr-email.js --dcr <submission_id> --customer --reason "Legacy delivery failed"
```
Writes audit fields: `emailProvider: "native"`, `manualResend: true`, `manualResendReason`, `manualResendBy`, `manualResendAt`, `nativeEmailMessageId`.

#### Pilot readiness audit
```
node scripts/pilot-readiness-check.js                   # full roster
node scripts/pilot-readiness-check.js --tech makaila-b  # one tech
node scripts/pilot-readiness-check.js --json
```
Exits 1 on any FAIL → CI-friendly.

### 5. Emergency / SOS guide

#### What's wired today
| Layer | Status | What works |
|---|---|---|
| Frontend SOS flow | ✅ Production | Three-step confirmation; 911 + April equal prominence; multi-source staff resolution; geolocation capture; honest confirmation copy |
| Firestore write | ✅ Production | `emergency_events/{autoId}` created; rule-gated by `isActiveStaff()` |
| Admin → SOS Events | ✅ Production | Real-time list with severity, geolocation Maps link, resolve workflow |
| SMS dispatch | ⚠️ **Beta — Twilio secrets empty** | `notificationStatus: "sms_provider_missing"` is honestly reported; tech sees "Alert saved. Please call April now." with persistent tel/sms anchors |

#### Tech response flow
1. Tap top-right **🚨 SOS** pill on any tech page.
2. **"Are you safe?"** step:
   - **Yes, but I need help** → Help-needed form. Examples: locked out, alarm, vehicle, stuck. Type a one-line description → Send.
   - **No, this is an emergency** → Emergency step. **Always tap [Call 911] first** if anyone is in danger. Then tap [Call April]. Optionally tap "Also send Pioneer SOS Alert" to fan out via SMS.
   - **Cancel** → modal closes, no event.
3. Confirmation step shows the SMS result honestly:
   - "Alert sent. April and Kirby have been texted." (when Twilio works)
   - "Alert saved. Please call April now." (current pilot state — SMS provider empty)
   - "Notification dispatch failed." (when Twilio errors)
4. Persistent [Call April now] + [Text April] anchors always visible.

#### Admin response flow
1. Admin → **System → SOS Events** tab badge increments (real-time).
2. Open the tab → newest event at top.
3. Severity chip (⚠ HELP NEEDED amber / 🚨 EMERGENCY red) + tech name + customer/location + time.
4. Click **📌 Open in Maps** for geolocation (if tech consented).
5. Read details + notification status.
6. Tap **📞 Call April** or **📞 911** buttons inline.
7. After handling: type required resolution notes → **Mark resolved**.
8. Card greys out (kept for audit), badge decrements.

#### The "Need Help Now" path (different from SOS)
- For: locked out, access problem, alarm not working, vehicle issue, supplies missing, stuck and need support.
- NOT for: injury, accident, threat, medical emergency, fire.
- Where: Team Hub → "Need Help Now?" red card.
- How it works: action sheet with real `<a href="tel:+15098283335">` and `<a href="sms:+15098283335?body=…">` anchors. No Pioneer Firestore write — pure escalation to April's phone. Always works regardless of app state, Twilio status, or auth.

#### Inactive-user fallback (archived tech, signed-out user)
- Modal opens to **"Pioneer access not active"** sheet.
- Equal-prominence [Call 911] + [Call April] anchors.
- No Pioneer Firestore write attempted (rule would deny anyway).
- This is the floor — even a fully-revoked tech can still dial 911 and call April from the modal.

---

## Sitemap

### Public pages (no login)
- `/login` — sign-in
- `/dcr-report.html?t=<token>` — customer DCR report (token-gated)
- `/feedback-compliment.html?dcrId=…` — customer compliment
- `/feedback-issue.html?dcrId=…` — customer concern

### Tech pages (active cleaning_tech or admin)
- `/team-hub.html` — landing page; Announcements + Requests & Support + Schedule preview + Install PioneerOps card + Pioneer Quality + Need Help Now + Help Improve Pioneer
- `/work.html` — Today's Work (per-shift cards with Start/Finish/Complete-DCR)
- `/` (`/index.html`) — DCR form (golden path when launched from Start Work)
- `/tech.html` — Customer Info Hub (SOPs + Security Modal)
- `/supply-station.html` — Supply Station Order + Access Card
- `/team-schedule.html` — Next 21 days (Assignments / List / Coverage views)
- `/training.html` — Safety Training catalog
- `/lesson.html?lessonId=…` — per-lesson view + quiz
- `/inspections.html` — Inspections intake (admin)
- `/call-out.html` — Same-day call-out / running late form
- `/time-off.html` — Planned PTO request form
- `/open-shifts.html` — Pick up open shifts + $25 Rockstar
- `/improve.html` — Help Improve Pioneer (Standard + Protected concern modes)

### Admin pages (admin only)
- `/admin.html` — 20-panel mission control

### Admin panel hierarchy
```
Core Ops
├── Customers
├── Cleaning Techs (with archive flow)
├── Recent DCRs
├── Yesterday's Work
└── Supply Requests

Quality
├── Issues (from DCR submissions)
├── Service Recoveries
├── Customer Notes
├── Note Suggestions (tech-submitted)
├── Improvements (V2 with thread)
└── Tech Health

System
├── Feed
├── Announcements (V2 targeted)
├── Admins
├── Training
├── Schedule (Sync next 21 days primary)
├── Attendance
│   ├── Call Outs
│   ├── Time Off
│   ├── Open Shifts
│   └── Calendar
├── Deputy
├── SOS Events
└── Pilot Readiness
```

### Floating / persistent UI elements
| Element | Where it lives | Trigger |
|---|---|---|
| 🚨 SOS pill | Top-right of `/work.html`, `/`, `/tech.html`, `/team-hub.html` | Always visible when signed in |
| Install PioneerOps card | Team Hub top | When `beforeinstallprompt` captured AND not standalone AND not dismissed in last 30 days |
| Clock In Reminder card | Bottom of viewport after Start Work | One-shot, 45s auto-dismiss |
| Shift Complete toast + Deputy clock-out reminder | After Finish Work | One-shot |
| Mandatory blocking modal | Any signed-in page | When tech has unread mandatory announcement targeted to them |
| Need Help Now action sheet | Team Hub | On tap |
| Walkthrough modal | Any signed-in page | First-time visit per device |

### Workflow sequences

#### Tech's normal shift
```
Open PWA → Team Hub
        ↓
nav: Today's Work
        ↓
Start Work card tap
        ↓ writes pioneer_work_sessions.status="working"
Clock In Reminder card → Open Deputy App (new tab)
        ↓
Back on PioneerOps card → Complete DCR
        ↓ opens /?deputy_shift_id=…&pioneer_session_id=…
DCR form with assigned-shift summary
        ↓ checklist + photos + signature
Submit DCR
        ↓ writes dcr_submissions/{id} (+ dcr_issues, supply_requests if applicable)
Golden-path success: Finish Work in PioneerOps
        ↓ /work.html?finishSession=…
finishWork() auto-runs → writes pioneer_work_sessions.status="finished"
        ↓
Shift Complete toast + Deputy clock-out reminder
        ↓
Open Deputy App → clock out
```

#### Customer's DCR email flow
```
Tech submits DCR → submitDcrV1 → dcr_submissions write
        ↓ (manual admin trigger today; auto-trigger remains a build gap)
generateAndSendDcrEmailV1
        ↓ readiness check (customer recipient + checklist + photos + signature)
mintReportToken → dcr_report_tokens/{sha256(token)} written
        ↓
buildTechTenureLabel → tenure phrasing from cleaning_techs overrides + DCR history
        ↓
V6 HTML render → Gmail API send
        ↓ writes dcr_submissions.{emailStatus, emailedAt, gmailMessageId, emailTo}
Customer receives email with View full report ↗ tokenized link
        ↓
Customer clicks → /dcr-report.html?t=<token>
        ↓ getDcrReportByTokenV1 → customer-safe whitelist response
Customer reads → optional feedback CTAs → public feedback forms
        ↓ submitFeedbackV1 → feedback/{id}
Admin sees view count chip + new feedback in admin
```

#### SOS escalation
```
Tech taps 🚨 SOS pill
        ↓
"Are you safe?" step 1 (Yes / No / Cancel)
        ↓ (No branch)
Emergency step — [Call 911] [Call April] equal prominence
        ↓ optionally "Also send Pioneer SOS Alert"
Critical form → Send → emergency_events/{id} created (severity=critical)
        ↓
onEmergencyCreatedV1 server trigger
        ↓ Twilio secrets check
        ├── secrets empty → notificationStatus="sms_provider_missing"
        └── secrets valid → Twilio Messages.json → notified.{april,kirby,nick}=true
        ↓
DCR doc updated with notification result
        ↓
Admin SOS Events panel badge increments (real-time onSnapshot)
Admin handles → Mark resolved with required notes
```

---

*End of document. Update on every material deploy.*
