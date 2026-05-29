# PioneerOps — Refactor Plan

**Goal:** Reduce the six largest files in the repo without changing behavior, routes, schemas, auth, or UI. Optimize for **sellability** (a buyer's tech-DD reviewer should be able to read any file in one sitting), **maintainability** (each file does one job), and **low regression risk** (every phase is a single reviewable commit with a clear rollback).

**Non-goals:**
- No behavior changes.
- No route changes (no HTML rename, no Cloud Function rename).
- No Firestore collection or schema changes.
- No auth-model changes (allowlist + `/admins/{email}` stays as-is).
- No UI redesign or copy changes.
- No introduction of a build pipeline. Vanilla JS multi-page Firebase Hosting stays.

**Constraint that drives every decision:** `public/admin.js` is wrapped in a single IIFE (`(function () { ... })()` at line 35). Every function inside shares the same lexical scope and depends on closure variables. We **cannot** simply move functions into separate files without exposing a tiny shared namespace OR converting to ES modules. The plan below picks the **window-namespace** path because it requires zero script-tag-type changes, preserves load order, and lets any phase revert by deleting one file + removing one `<script>` line.

---

## 1. Current complexity map

### File-by-file shape

| File | Lines | Shape | Primary risk |
|---|---:|---|---|
| `public/admin.js` | 14,290 | Single IIFE; 200+ closure-local functions; one `activateTab(tabKey)` dispatcher (line 2585) calls one `init*Once()` / `load*()` per tab; 20 tab modules co-resident | Closure scope shared by every tab → moving any function risks breaking a sibling that captured the same closure-local |
| `functions/index.js` | 6,029 | 30 `exports.*` + ~25 internal helpers; 6 sub-modules already extracted (`dcrEmail`, `feedback`, `techMediaUpload`, `attendanceEmails`, `pilotReadinessEngine`, `dcrReport`, `customerDisplay`); Deputy + identity + DCR + SOS + ops still inline | Each top-level function may capture the global `admin`/`logger` requires; safe to extract because there's no IIFE wrapper |
| `functions/dcrEmail.js` | 4,539 | Four generations of email templates (V1 / V2 / V3 / V4) all co-resident; V4 is the only active path (`renderDcrEmailHtmlV4` + `sendDcrEmailCore` + `getDcrEmailReadiness`); ~3,000 lines of legacy template + AI-prompt code | V1–V3 are dead but read-referenced; cannot delete without confirming via grep |
| `public/admin.html` | 2,807 | Static markup. Tab nav + 20 panel sections inline. 5 `<script>` tags + 10 `<link rel=stylesheet>` tags | Can't split without templating; **leave alone** |
| `public/admin.css` | 6,283 | Clear `/* ===== */` section markers every ~100 lines, one per tab; bottom 1,500 lines are post-Apr-2026 overrides | Splits cleanly along its own section markers |
| `firestore.rules` | 1,072 | 38 `match /collection/{id}` blocks + 4 helper functions (`isPioneerAdmin`, `isActiveStaff`, `isActiveCleaningTech`, `requestOwnsAuth`); cannot be split (Firestore loads exactly one rules file) | High risk — rules are the security gate |

### Cross-file dependency edges (what depends on what)

```
admin.html ─┬─→ firebase-config.js
            ├─→ mandatory-modal.js   (mandatory announcement modal)
            ├─→ info-tip.js          (tooltips)
            ├─→ operational-feed.js  (shared feed renderer)
            ├─→ customer-sop.js
            ├─→ celebrate.js         (confetti + sound)
            ├─→ customer-display.js  (display-name resolver)
            └─→ admin.js             ← all 14k LOC
                ├─→ Firebase compat SDK globals: firebase.auth, firebase.firestore, firebase.storage
                ├─→ window.OperationalFeed (from operational-feed.js)
                ├─→ window.getCustomerDisplayName (from customer-display.js)
                ├─→ window.celebrate (from celebrate.js)
                └─→ DOM elements in admin.html (querySelector data-tab="…", data-panel="…")

functions/index.js → ./dcrEmail, ./feedback, ./techMediaUpload, ./attendanceEmails,
                     ./pilotReadinessEngine, ./dcrReport, ./customerDisplay,
                     firebase-admin, firebase-functions/v2

functions/dcrEmail.js → firebase-admin (passed in), googleapis (Gmail), OpenAI (fetch),
                        no other internal module
```

---

## 2. Dependency map for `public/admin.js`

The IIFE has four concentric layers. The outer layers are touched by everything; the inner layers are tab-scoped.

### Layer A — pure utilities (lines 35–217, ~180 lines)
- `const DCR_RECENT_LIMIT = 500` (line 42)
- `ALLOWED_ADMIN_EMAILS[]` (line 56)
- `isRootAdmin(email)` (line 66)
- `resolveAdminStatus(email)` (line 81)
- `escapeHtml(s)` (line 102)
- `formatTimestamp(ts)` (line 108)
- `getCustomerName/Slug/Email/Location/Active/DcrEnabled/DcrEmailEnabled` (lines 123–132)
- `getTechName/Slug` (lines 134–135)

**Dependencies:** none (pure). **Used by:** every tab module. **Extract risk: lowest.**

### Layer B — admin shell + status banners (lines 218–286)
- `wireTabs()` — tab click delegator (line 218)
- `setStatus`, `hideAllStatuses`, `showFatal` (lines 236–252)
- `badge`, `activeBadge`, `dcrEnabledBadge`, `dcrEmailBadge` (lines 261–270)

**Dependencies:** DOM querySelectors only. **Used by:** every tab. **Extract risk: low.**

### Layer C — domain helpers (lines 289–435)
- `getOnBudget(doc)`, `dcrTsToMs(ts)`, `emptyBucket()`, `computeBudgetStats(filter)`, `budgetRowBadge`, `budgetTooltipText` (DCR budget analytics, used by Customers + DCRs tabs)

**Dependencies:** Layer A only. **Used by:** Customers + DCRs tabs. **Extract risk: low.**

### Layer D — tab modules (each ~300–2000 lines)
Each tab has an idempotent `init*Once()` + `load*()` pair gated by a wired-flag. Dispatcher at `activateTab(tabKey)` (line 2585) calls them.

| Tab | Init / load entry | LOC ballpark | Closure deps |
|---|---|---:|---|
| Customers | `loadCustomers()` (line 611) | ~700 | Layer A, B, C |
| Cleaning Techs | `loadTechs()` (line 830) | ~1,100 | Layer A, B |
| Recent DCRs | `loadDcrs()` (line 934) | ~800 | Layer A, B, C |
| Supply Requests | `loadSupplyRequests()` (line 1587) | ~900 | Layer A, B |
| DCR Issues | `loadDcrIssues()` (line 1818) | ~1,000 | Layer A, B |
| Yesterday's Work | `initYesterdayOnce()` | ~1,200 | Layer A, B |
| SOS Events | `initSosOnce()` (line 2632) | ~400 | Layer A, B |
| Improvements | `initImprovementsOnce()` (line 2861) | ~600 | Layer A, B |
| Tech Health | `loadTechHealth()` | ~900 | Layer A, B |
| Pilot Readiness | `initPilotReadinessOnce()` | ~700 | Layer A, B |
| Schedule | `loadTeamSchedule()` / `loadPublishedSnapshot()` / `loadScheduleDraft()` | ~1,200 | Layer A, B |
| Attendance | `loadAttendance()` | ~1,500 | Layer A, B |
| Deputy | (Deputy panel handlers around line 10441) | ~800 | Layer A, B |
| Announcements | (announcement create + thread) | ~1,500 | Layer A, B |
| Customer Notes / Note Suggestions | | ~700 | Layer A, B |
| Service Recoveries | | ~500 | Layer A, B |
| Admins | | ~400 | Layer A, B |
| Training | `loadTrainingReport()` | ~600 | Layer A, B |
| Feed | `mountOperationalFeedOnce()` | ~50 (thin shim) | calls `window.OperationalFeed` |

### Critical observation
**No tab module references another tab module's helpers.** The closure graph is a star: every tab module reads from Layer A/B/C, but no tab module reads from another tab module. This is why per-tab extraction is safe — the only shared surface is the utility layers.

---

## 3. Dependency map for `functions/index.js`

Six sub-modules are already extracted. Eight clusters remain inline.

### Already extracted (good models for the rest)
- `./dcrEmail` — V4 customer email pipeline
- `./feedback` — public feedback forms
- `./techMediaUpload` — photo + signature upload
- `./attendanceEmails` — call-out / time-off / open-shift Gmail notifications
- `./pilotReadinessEngine` — readiness engine shared by panel + CLI
- `./dcrReport` — tokenized customer report endpoint
- `./customerDisplay` — server twin of `public/customer-display.js`

### Inline clusters (each is an independent extract candidate)

| Cluster | Lines | Exports | Internal helpers used | External deps |
|---|---:|---|---|---|
| **Shared infra** | 16–238 | (none — module-level setup) | `setGlobalOptions`, `createOperationalFeedItem`, `createSupplyNotice`, `verifyStaffOrReject` | admin, logger |
| **Identity** | 332–1467 | `whoAmIV1`, `createCleaningTechLoginV1`, `createAdminLoginV1`, `sendPasswordResetV1`, `deleteCleaningTechV1`, `setTechAuthDisabledV1` (line 5975) | `makeTempPassword`, `slugifyForTech`, `isValidEmailShape`, `stampTechInviteError` | Firebase Auth admin SDK |
| **Quality / Trust** | 1467–2400 | `pioneerQualityViewV1`, `techHubViewV1`, `submitSupplyStationOrderV1` | `walkInspectionStreak` | Firestore reads |
| **DCR submit** | 1836–3158 | `submitDcrV1` (line 2886) | `validatePayload`, `maybeCreateSupplyRequest`, `buildZapierPayload`, `createDcrIssuesForSubmission`, `sendToZapier`, `getOnBudget`, `tsToMs`, `tsToIso` | Firestore writes, fetch (Zapier deprecated) |
| **Deputy** | 3232–4742 | `deputyOAuthStartV1`, `deputyOAuthCallbackV1`, `syncDeputyShiftsV1` (scheduled), `refreshDeputyShiftsV1`, `refreshDeputyShiftsRangeV1`, `deputyApiDiagnosticV1`, `seedPilotCustomerAliasesV1` | `getDeputyOAuthUrls`, `trimSecret`, `escapeHtmlMinimal`, `getDeputyCallbackUrl`, `deputyTodayLocalDate`, `getValidDeputyAccessToken`, `syncDeputyShiftsCore` | Deputy REST, OAuth2 |
| **DCR email** thin wrappers | 5300–5404 | `generateAndSendDcrEmailV1`, `getDcrEmailReadinessV1` | (delegates to `./dcrEmail`) | — |
| **Attendance triggers** | 5501–5650 | `onCallOutCreatedV1`, `onTimeOffRequestCreatedV1`, `onCallOutUpdatedV1`, `onTimeOffRequestUpdatedV1`, `onOpenShiftCreatedV1`, `onOpenShiftUpdatedV1` | (delegates to `./attendanceEmails`) | — |
| **Emergency / SOS** | 5783–5973 | `onEmergencyCreatedV1` | `safeReadSecret`, `formatSosBody`, `sendTwilioSms` | Twilio (secret-driven) |

---

## 4. Safest module boundaries

### Front-end (`public/admin.js`)
- `public/admin/_utils.js` — Layer A only (pure helpers, no DOM, no Firebase)
- `public/admin/_shell.js` — Layer B (status banners, badges, tab wiring)
- `public/admin/_budget.js` — Layer C (budget analytics helpers)
- `public/admin/tab-<key>.js` — one per tab, eventually 20 files
- `public/admin/index.js` — the dispatcher + auth bootstrap, becomes a slim entry point

Every module attaches its public surface to `window.__pioneerAdmin` (single global, namespaced):
```js
window.__pioneerAdmin = window.__pioneerAdmin || {};
window.__pioneerAdmin.utils = { escapeHtml, formatTimestamp, getCustomerName, ... };
```
Other modules read via `const { escapeHtml } = window.__pioneerAdmin.utils;` at the top of their IIFE. No ES module conversion. No build step. Script tag order in `admin.html` enforces availability.

### Back-end (`functions/index.js`)
Follow the established `./dcrEmail` / `./feedback` pattern. New files:
- `functions/shared/feedItems.js` — `createOperationalFeedItem`, `createSupplyNotice`, `verifyStaffOrReject`
- `functions/identity.js` — all 6 identity functions + helpers
- `functions/dcr/submit.js` — `submitDcrV1` + all the validate/build/create helpers
- `functions/dcr/issues.js` — `createDcrIssuesForSubmission` (if cleaner to separate)
- `functions/deputy/index.js` — all 7 Deputy functions + `syncDeputyShiftsCore`
- `functions/quality.js` — `pioneerQualityViewV1`, `techHubViewV1`, `submitSupplyStationOrderV1`
- `functions/sos.js` — `onEmergencyCreatedV1` + Twilio helpers

`functions/index.js` becomes a barrel: ~150 lines of `exports.foo = require("./identity").fooV1` lines + the `setGlobalOptions` block.

### Email template (`functions/dcrEmail.js`)
- `functions/dcrEmail/_archive/v1.js`, `v2.js`, `v3.js` — historical templates kept read-only; grep first to confirm V1/V2/V3 are truly dead.
- `functions/dcrEmail/normalize.js` — `normalizeDcrForEmail` + `v2*` photo/checklist extractors
- `functions/dcrEmail/ai.js` — `generateAiSummary`, `createDcrEmailPromptV2`, `generateDcrEmailContentJsonV2`, `scrubBannedWords`, `validateContentJsonV2`, `buildFallbackContentV2`
- `functions/dcrEmail/template/v4.js` — `renderDcrEmailHtmlV4` + V4 helpers (`v4HeaderStatusPill`, `v5*` bullet helpers, `v4BuildTrustStripTiles`, `v4FormatDuration`)
- `functions/dcrEmail/template/_shared.js` — `htmlEscape`, `formatHumanDate`, `formatHumanDateShort`, `encodeMimeWordIfNeeded`, `formatNextCleanLine`, `formatPhotoCaptionTime`
- `functions/dcrEmail/gmail.js` — `sendGmailMessage`, `buildSubject`
- `functions/dcrEmail/readiness.js` — `getDcrEmailReadiness`
- `functions/dcrEmail/trustSignals.js` — `computeCleanerTrustSignals`, `visitHadConcerns`, `trustTsMs`, `resolveCustomerDoc`, `recordEmailStatus`
- `functions/dcrEmail/index.js` — `sendDcrEmailCore`, `buildHttpHandler`, `module.exports` barrel

### CSS (`public/admin.css`)
- `public/styles/admin/_shell.css` — top ~600 lines (global admin shell, tabs, modal frame)
- `public/styles/admin/tab-customers.css`, `tab-techs.css`, `tab-dcrs.css`, `tab-supply.css`, `tab-issues.css`, `tab-yesterday.css`, … one per section marker
- `public/styles/admin/_overrides.css` — bottom post-deploy override stack

### Rules (`firestore.rules`)
**Do not split.** Instead: introduce 2–3 helper functions to deduplicate repeated subject + audit-field patterns, reorder collections into the same groups as the function modules above for navigability, and add `/* ===== */` section banners.

---

## 5. Exact phased refactor plan

Each phase = one commit. Each phase passes the smoke tests in §8 before merging. Each phase is independently revertable per §9.

### Phase 0 — instrumentation prep (no code changes)
- Add `docs/PioneerOps-Refactor-Plan.md` (this file).
- Add `docs/PioneerOps-Refactor-Inventory.md` — frozen snapshot of LOC per file at the start of work (one `wc -l` run). Each phase appends a `before → after` row.
- Set up a `scripts/audit-bundle-size.sh` one-liner that re-runs the inventory so you can see drift per commit.

**Risk:** zero (docs only).
**Commit:** `docs: capture refactor baseline inventory`.

### Phase 1 — extract `public/admin.js` Layer A utilities (the tiny first slice)
- Create `public/admin/_utils.js` (~120 LOC) containing exactly:
  - `DCR_RECENT_LIMIT`
  - `ALLOWED_ADMIN_EMAILS`
  - `isRootAdmin`
  - `escapeHtml`
  - `formatTimestamp`
  - `getCustomerName / Slug / Email / Location / Active / DcrEnabled / DcrEmailEnabled`
  - `getTechName / Slug`
- File pattern:
  ```js
  (function () {
    "use strict";
    function escapeHtml(s) { /* exact copy */ }
    /* … */
    window.__pioneerAdmin = window.__pioneerAdmin || {};
    window.__pioneerAdmin.utils = {
      DCR_RECENT_LIMIT, ALLOWED_ADMIN_EMAILS,
      isRootAdmin, escapeHtml, formatTimestamp,
      getCustomerName, getCustomerSlug, getCustomerEmail,
      getCustomerLocation, getActive, getDcrEnabled,
      getDcrEmailEnabled, getTechName, getTechSlug,
    };
  }());
  ```
- In `public/admin.html`, add `<script src="admin/_utils.js?v=…"></script>` **before** `<script src="admin.js?v=…">`.
- In `public/admin.js`, at the very top of the IIFE (line 36), add a destructuring import:
  ```js
  const {
    DCR_RECENT_LIMIT, ALLOWED_ADMIN_EMAILS, isRootAdmin,
    escapeHtml, formatTimestamp,
    getCustomerName, getCustomerSlug, getCustomerEmail,
    getCustomerLocation, getActive, getDcrEnabled, getDcrEmailEnabled,
    getTechName, getTechSlug,
  } = window.__pioneerAdmin.utils;
  ```
- Delete the original definitions (lines 42–135).
- **Expected delta:** `admin.js` shrinks ~90 LOC, `_utils.js` adds ~120 LOC (includes the IIFE wrapper + comments). Net repo +30 LOC for clarity.

**Risk:** very low. Pure functions, no DOM, no Firebase. If anything breaks it's an immediate ReferenceError on page load.
**Commit:** `refactor(admin): extract pure utility helpers to admin/_utils.js`.

### Phase 2 — extract `public/admin.js` Layer B shell helpers
- Create `public/admin/_shell.js` with `wireTabs`, `setStatus`, `hideAllStatuses`, `showFatal`, `badge`, `activeBadge`, `dcrEnabledBadge`, `dcrEmailBadge`, `activateTab`.
- Tab dispatch (`activateTab`) stays here as the shell's responsibility.
- `admin.html`: add `<script src="admin/_shell.js?v=…">` after `_utils.js`, before `admin.js`.
- `admin.js`: import via destructure from `window.__pioneerAdmin.shell`, delete originals.

**Risk:** low. Shell has DOM dependencies but is well-isolated.
**Commit:** `refactor(admin): extract shell + tab dispatch to admin/_shell.js`.

### Phase 3 — extract Layer C budget helpers
- Create `public/admin/_budget.js`: `getOnBudget`, `dcrTsToMs`, `emptyBucket`, `computeBudgetStats`, `budgetRowBadge`, `budgetTooltipText`.
- Same script-tag pattern.

**Risk:** very low. Used only by Customers + DCRs tabs.
**Commit:** `refactor(admin): extract budget analytics helpers to admin/_budget.js`.

### Phase 4 — extract one tab as a proof-of-pattern: **SOS** (~400 LOC)
SOS is chosen because:
- Smallest tab module by LOC.
- Already has a clean `initSosOnce()` boundary.
- Real-time `onSnapshot` listener is a non-trivial dependency — proves the pattern works for stateful tabs.

Steps:
- Create `public/admin/tab-sos.js` containing `initSosOnce`, `sosStartListening`, `updateSosBadge`, `renderSosList`, `renderSosCard`, `resolveSosEvent` + the closure-locals (`sosWired`, `sosFilter`, `sosUnsubscribe`, `sosLastEvents`).
- Surface: `window.__pioneerAdmin.tabs.sos = { init: initSosOnce };`
- In `admin.js`'s `activateTab`, replace `if (tabKey === "sos") initSosOnce();` with `if (tabKey === "sos") window.__pioneerAdmin.tabs.sos.init();`.
- Delete the original SOS code.

**Risk:** medium (first stateful module). Verify the real-time listener still fires.
**Commit:** `refactor(admin): extract SOS Events tab to admin/tab-sos.js`.

### Phase 5–14 — extract remaining 19 tabs, one per commit
Order by ascending LOC + ascending dependency complexity, so each commit is reviewable:
5. **Improvements** (~600)
6. **Admins** (~400) — touches the allowlist; double-review
7. **Customer Notes + Note Suggestions** (~700, combined because they share `customer_notes` helpers)
8. **Training** (~600)
9. **Pilot Readiness** (~700)
10. **Customers** (~700)
11. **Recent DCRs** (~800)
12. **Service Recoveries** (~500)
13. **DCR Issues** (~1,000)
14. **Supply Requests** (~900)
15. **Tech Health** (~900)
16. **Cleaning Techs** (~1,100)
17. **Yesterday's Work** (~1,200)
18. **Schedule** (~1,200)
19. **Attendance** (~1,500)
20. **Announcements** (~1,500)
21. **Deputy** (~800, includes admin-side OAuth start)

After Phase 21, `admin.js` is ~600 LOC: auth bootstrap + `activateTab` shell + minimal glue. Rename to `public/admin/index.js` and keep `admin.js` as a one-line redirect for cache safety:
```js
// admin.js — moved. See admin/index.js.
```

### Phase 22 — split `functions/index.js`
One commit per cluster (§3 table). Order:
22a. `functions/shared/feedItems.js` (smallest, used by every other module — extract first).
22b. `functions/sos.js` — `onEmergencyCreatedV1` + Twilio helpers (small, self-contained, low traffic).
22c. `functions/quality.js` — `pioneerQualityViewV1`, `techHubViewV1`, `submitSupplyStationOrderV1`.
22d. `functions/identity.js` — 6 identity functions + helpers (large but very cohesive).
22e. `functions/deputy/index.js` — 7 Deputy functions + `syncDeputyShiftsCore` (largest).
22f. `functions/dcr/submit.js` — `submitDcrV1` + validate/build helpers.

For each: keep `exports.fooV1 = require("./identity").fooV1` lines in `functions/index.js` so the **public function name doesn't change** (no Firebase Function rename → no deploy gotcha).

### Phase 23 — split `functions/dcrEmail.js`
23a. Confirm V1/V2/V3 templates are unreferenced (`grep "renderDcrEmailHtmlV[123]" functions/index.js` returns zero hits). If confirmed, move V1/V2/V3 into `functions/dcrEmail/_archive/` as read-only history.
23b. Extract `functions/dcrEmail/normalize.js` + `ai.js` + `template/v4.js` + `template/_shared.js` + `gmail.js` + `readiness.js` + `trustSignals.js` + `index.js`.
23c. Keep `functions/dcrEmail.js` as a barrel shim: `module.exports = require("./dcrEmail/index.js");` — zero callsite changes in `functions/index.js`.

### Phase 24 — split `public/admin.css`
Split along the existing `/* ===== */` section markers. One file per tab, plus shell + overrides. Add `<link rel="stylesheet">` tags to `admin.html` in source order matching current cascade. **Cascade order matters** — do not reorder.

### Phase 25 — `firestore.rules` cleanup (no logic change)
- Reorder `match` blocks to follow the same grouping as the function modules.
- Factor out 2–3 repeated patterns into helper functions if grep shows ≥3 identical occurrences. Examples: `isCreatingOwnDoc()`, `auditFieldsPresent()`. Add only if they shrink LOC by ≥30 with zero rule-behavior change.
- Add `/* ===== */` banners.
- Deploy to **emulator first**, run the existing tech invite + DCR submit + SOS create + announcement read paths against the emulator, then deploy to prod.

**Risk:** high. This is the only phase that touches the security gate. **Do not bundle with other changes.** Single-purpose PR. Test on emulator before merging.

### Phase 26 — `admin.html` is intentionally left alone
Splitting `admin.html` requires server-side includes or a templating system. **Not in scope.** The only `admin.html` edits across this whole plan are `<script>` and `<link>` tag additions in stable insertion points.

---

## 6. Files to create

### Front-end
```
public/admin/_utils.js
public/admin/_shell.js
public/admin/_budget.js
public/admin/tab-sos.js
public/admin/tab-improvements.js
public/admin/tab-admins.js
public/admin/tab-customer-notes.js
public/admin/tab-training.js
public/admin/tab-pilot-readiness.js
public/admin/tab-customers.js
public/admin/tab-dcrs.js
public/admin/tab-recoveries.js
public/admin/tab-issues.js
public/admin/tab-supply.js
public/admin/tab-tech-health.js
public/admin/tab-techs.js
public/admin/tab-yesterday.js
public/admin/tab-schedule.js
public/admin/tab-attendance.js
public/admin/tab-announcements.js
public/admin/tab-deputy.js
public/admin/index.js                          (slim entry; replaces fat admin.js)
public/styles/admin/_shell.css
public/styles/admin/tab-customers.css
public/styles/admin/tab-techs.css
public/styles/admin/tab-dcrs.css
public/styles/admin/tab-supply.css
public/styles/admin/tab-issues.css
public/styles/admin/tab-yesterday.css
public/styles/admin/tab-schedule.css
public/styles/admin/tab-attendance.css
public/styles/admin/tab-deputy.css
public/styles/admin/tab-announcements.css
public/styles/admin/tab-sos.css
public/styles/admin/tab-improvements.css
public/styles/admin/tab-tech-health.css
public/styles/admin/tab-pilot-readiness.css
public/styles/admin/_overrides.css
```

### Back-end
```
functions/shared/feedItems.js
functions/identity.js
functions/quality.js
functions/dcr/submit.js
functions/deputy/index.js
functions/deputy/oauth.js                      (if oauth + sync warrant split)
functions/sos.js
functions/dcrEmail/normalize.js
functions/dcrEmail/ai.js
functions/dcrEmail/template/v4.js
functions/dcrEmail/template/_shared.js
functions/dcrEmail/gmail.js
functions/dcrEmail/readiness.js
functions/dcrEmail/trustSignals.js
functions/dcrEmail/index.js
functions/dcrEmail/_archive/v1.js              (kept for history, unreferenced)
functions/dcrEmail/_archive/v2.js
functions/dcrEmail/_archive/v3.js
```

### Docs
```
docs/PioneerOps-Refactor-Inventory.md          (frozen baseline + per-phase LOC delta)
```

---

## 7. Files to avoid touching

| File | Why |
|---|---|
| `public/admin.html` | Splitting requires templating. Only safe edit is adding `<script>` / `<link>` tags. **Do not move markup.** |
| `firestore.indexes.json` | Index changes affect query plans. Not in scope. |
| `firebase.json` | Hosting routes, function regions, cache headers. Not in scope. |
| `public/firebase-config.js` | Project config; not refactor surface. |
| `public/customer-display.js`, `public/celebrate.js`, `public/info-tip.js`, `public/operational-feed.js`, `public/customer-sop.js`, `public/mandatory-modal.js` | These are already small standalone modules. Leave them. |
| Any `public/*.js` tech-facing file other than `admin.js` | Not in scope. Each tech page is already a single bounded file. |
| `functions/attendanceEmails.js`, `functions/feedback.js`, `functions/pilotReadinessEngine.js`, `functions/dcrReport.js`, `functions/customerDisplay.js`, `functions/techMediaUpload.js` | Already extracted; do not re-architect. |
| All Cloud Function **export names** (`exports.foo` identifier on the right of `=`) | Renaming = redeploy with new function name = broken callers. The barrel pattern keeps the public name identical. |
| All HTML route paths (`/work.html`, `/team-hub.html`, …) | Out of scope. |
| All Firestore collection names + field names | Schema is frozen. |
| `scripts/*.js` | Operational scripts, separate concern. |

---

## 8. Smoke tests after each phase

### Universal smoke (run after every commit, all phases)
1. Hard-refresh `https://pioneer-dcr-hub.web.app/admin.html` in an incognito window. Sign in as `nick@pioneercomclean.com`. **Expected:** Customers tab loads with the customer list.
2. Click through every one of the 20 admin tabs. **Expected:** each panel renders, no DevTools console errors.
3. Open DevTools → Network. Look for any 404 on `admin/*.js` or `styles/admin/*.css`. **Expected:** zero.
4. Open DevTools → Application → Service Workers → Unregister, then hard-refresh. **Expected:** still works (caches aren't masking errors).
5. Hard-refresh `https://pioneer-dcr-hub.web.app/team-hub.html` as a tech (test account). **Expected:** Team Hub still renders. (Regression check for accidental global pollution.)

### Phase 1–3 smoke (utility extraction)
- DevTools console: `window.__pioneerAdmin.utils.escapeHtml("<x>")` → `"&lt;x&gt;"`.
- Customers tab → search box → type a customer name. Expected: filtering works.

### Phase 4–21 smoke (per-tab extraction)
For the tab being extracted in this phase, the per-tab acceptance test below MUST pass before merging.

| Tab | Acceptance test |
|---|---|
| Customers | Open tab → list renders → click a row → inline edit form opens |
| Cleaning Techs | List renders → +New → invite modal opens (do not submit) |
| Recent DCRs | List renders → click View → modal shows DCR details |
| Yesterday's Work | Date picker shows previous Pacific ops day → per-tech rollup renders → traffic-light statuses present |
| Supply Requests | List renders → status pills toggle filter |
| DCR Issues | List renders → status workflow buttons present |
| SOS Events | Real-time listener: from a second tab, create a test `emergency_events` doc → first tab shows the new card within ~2s; resolve flow requires notes |
| Improvements | List renders → admin reply textarea functional in thread |
| Tech Health | Trailing-30-day metrics render per tech |
| Pilot Readiness | Run button → audit completes → categories shown |
| Schedule | "Sync next 21 days from Deputy" button present → per-day breakdown disclosure works |
| Attendance | All 4 sub-tabs render (call-outs / time-off / open-shifts / calendar) |
| Deputy | Connection Health stat tile renders → Refresh button present |
| Announcements | +New flow opens → audience picker shows tech list with avatars → mandatory toggle works |
| Customer Notes / Note Suggestions | Notes list + suggestion approve flow |
| Service Recoveries | List + status workflow |
| Admins | List of admins → +New flow opens (do not submit) |
| Training | Training report tab loads |
| Feed | `mountOperationalFeedOnce()` mounts the shared renderer |

### Phase 22–23 smoke (Cloud Functions)
1. After deploying the split, run `firebase functions:list --project pioneer-dcr-hub`. **Expected:** all 30 function names still present.
2. From an admin signed in to `/admin.html`, perform each of these flows end-to-end:
   - Invite a test tech (`createCleaningTechLoginV1`).
   - Submit a DCR as the test tech via `/` (`submitDcrV1`).
   - Send the DCR customer email manually (`generateAndSendDcrEmailV1`) to your own test address.
   - Run Pilot Readiness Check (`pilotReadinessCheckV1`).
   - Trigger a Deputy refresh (`refreshDeputyShiftsV1`).
   - Create a test SOS via the tech UI (`onEmergencyCreatedV1` fires).
3. `node scripts/pilot-readiness-check.js --tech <test-slug>` → exits 0.
4. `node scripts/send-dcr-email.js --dcr <test-submission> --test nick@pioneercomclean.com` → email arrives.

### Phase 25 smoke (rules cleanup) — special
1. Deploy rules to **emulator**: `firebase emulators:start --only firestore`.
2. Run the existing manual rule walk-through from the test environment:
   - Active tech can read assigned customers, cannot read `customer_secure`, cannot read other techs' DCRs.
   - Inactive tech cannot write to any field-tech collection (verify by flipping `active_techs_by_email/{email}.active=false` in emulator).
   - Admin can read everything.
   - Public token-based `dcr_report_tokens` read works without auth.
3. If all green → deploy to prod with `firebase deploy --only firestore:rules`.
4. After prod deploy, monitor Cloud Logging for rule deny spikes for 30 minutes.

---

## 9. Rollback plan

### Universal rollback rule
**Every phase = one commit.** Revert with `git revert <phase-sha>` and `firebase deploy --only hosting` (front-end) or `firebase deploy --only functions:<name>` (back-end).

### Phase-specific recovery

| Phase | Symptom | Rollback |
|---|---|---|
| 1–3 | `ReferenceError: escapeHtml is not defined` on `/admin.html` | `git revert`, redeploy hosting. <1 min. |
| 4–21 | A specific admin tab is broken; others still work | `git revert` is the safe path. Alternative tactical fix: edit `admin.html` to remove that one `<script src="admin/tab-<key>.js">` tag and re-include the inline code via a hotfix commit. |
| 22–23 | Cloud Function logs show `Cannot find module './identity'` after deploy | `firebase deploy --only functions --project pioneer-dcr-hub` of the previous SHA. If urgent: `firebase functions:rollback <function-name>` to last known good version. |
| 24 | Visual regression on a tab | `git revert`. Cascade order changes can be subtle — the only fix is to put the cascade back. |
| 25 | Rule deny spike in Cloud Logging | `firebase deploy --only firestore:rules` of the previous SHA. Rules deploys are atomic and instant. |

### Belt-and-suspenders safety nets
- **Tag the pre-refactor baseline:** `git tag refactor-baseline-2026-05-29 && git push --tags` before Phase 1. Any rollback can `git checkout refactor-baseline-2026-05-29 -- <file>` to recover a specific file.
- **One commit, one PR, one deploy.** Do not bundle phases. The whole point of phasing is small reviewable units.
- **Deploy front-end and back-end separately.** Phases 1–21 + 24 are `firebase deploy --only hosting`. Phases 22–23 are `firebase deploy --only functions`. Phase 25 is `firebase deploy --only firestore:rules`. Never bundle.
- **Cache-bust query strings.** Bump the `?v=YYYYMMDD-…` query on every script/stylesheet edit so service workers and CDN nodes don't serve stale.

---

## 10. Recommended first tiny refactor slice

**Phase 1 — extract `public/admin/_utils.js`.**

Why this slice first:
- **~90 LOC moved**, all pure functions, zero DOM, zero Firebase, zero closure capture from elsewhere.
- Proves the `window.__pioneerAdmin.utils` namespace pattern works without risking any user-visible behavior.
- If the pattern is wrong, you find out in 30 seconds with one hard refresh — no production data touched.
- Reviewer can read both files end-to-end in under 5 minutes and approve.
- Sets up the template that the next 24 phases will follow verbatim.

**Exact diff shape:**
1. Create `public/admin/_utils.js` (~120 LOC including IIFE wrapper + module comment).
2. Edit `public/admin.html` (1 line added — `<script src="admin/_utils.js?v=…">` before the existing `admin.js` tag).
3. Edit `public/admin.js`:
   - Add 8-line destructure import at top of IIFE.
   - Delete lines 42 + 56 + 66 + 102 + 108 + 123–135 (the 14 function/constant definitions).

**Expected metrics:**
- `wc -l public/admin.js`: 14,290 → ~14,200.
- `wc -l public/admin/_utils.js`: 0 → ~120.
- Net repo: +30 LOC for clarity (the IIFE wrapper + the file header comment + the destructure import are the overhead).

**Commit message:**
```
refactor(admin): extract pure utility helpers to admin/_utils.js

Moves DCR_RECENT_LIMIT, ALLOWED_ADMIN_EMAILS, isRootAdmin, escapeHtml,
formatTimestamp, and the getCustomer*/getTech* accessors from the
public/admin.js IIFE into a sibling module under window.__pioneerAdmin.utils.

No behavior change. No route change. No schema change.

Sets the pattern for the per-tab extractions tracked in
docs/PioneerOps-Refactor-Plan.md.
```

**Smoke test before merging:**
1. Hard-refresh `/admin.html` incognito. Customers tab renders.
2. DevTools console: `Object.keys(window.__pioneerAdmin.utils)` shows all 14 helpers.
3. Click every other tab. No `ReferenceError` in console.
4. Walk a single search in the Customers tab (uses `escapeHtml`). Filtering works.

If all four pass: commit, push, deploy hosting, monitor Cloud Logging for 10 minutes. Done.

---

## Appendix A — what is explicitly out of scope

- Replacing the vanilla-JS architecture with a framework.
- Introducing TypeScript.
- Introducing a bundler (Vite, Rollup, esbuild).
- Migrating from Firebase compat SDK v9 to the modular SDK.
- Replacing the per-page HTML routing with an SPA router.
- Restructuring Firestore data model.
- Replacing Cloud Functions v2 callable pattern.
- Replacing the IIFE pattern with native ES modules. (Possible later, but **not in this plan** — it would require simultaneously changing every `<script>` tag and is not phaseable.)

These are all defensible long-term moves; none of them are required to make the codebase reviewable. The plan above gets every file under ~1,500 LOC without any of them.

---

## Appendix B — expected LOC after full execution

| File | Before | After (target) |
|---|---:|---:|
| `public/admin.js` (renamed to `admin/index.js`) | 14,290 | ~600 (auth bootstrap + dispatcher only) |
| Largest `public/admin/tab-*.js` | — | ~1,500 (Attendance / Announcements / Schedule are the heaviest) |
| `functions/index.js` | 6,029 | ~250 (barrel + setGlobalOptions only) |
| Largest `functions/<cluster>.js` | — | ~1,500 (`functions/deputy/index.js` or `functions/dcr/submit.js`) |
| `functions/dcrEmail.js` (now a shim) | 4,539 | ~5 (`module.exports = require("./dcrEmail/index.js")`) |
| Largest `functions/dcrEmail/*` | — | ~1,500 (`template/v4.js`) |
| `public/admin.css` (renamed to `styles/admin/_shell.css`) | 6,283 | ~600 |
| Largest per-tab `styles/admin/tab-*.css` | — | ~900 (`tab-techs.css` or `tab-issues.css`) |
| `firestore.rules` | 1,072 | ~950 (helper extraction reduces ~10%) |
| `public/admin.html` | 2,807 | 2,807 (untouched per §7) |

**Result:** every JavaScript and CSS file in the repo under 1,500 LOC, except for `admin.html` (which is markup, not logic) and `firestore.rules` (single-file constraint). The codebase becomes navigable in under 30 minutes for a new reviewer.

---

*End of plan. No code changes yet. Open the first PR (Phase 1) only after this plan has been reviewed.*
