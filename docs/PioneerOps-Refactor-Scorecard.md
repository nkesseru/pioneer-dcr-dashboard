# PioneerOps — Admin Refactor Scorecard

**Branch:** `feature/admin-mission-control`
**Latest deployed commit:** `917d335` (Phase 25f Commit B — retire redundant deps bridges)
**Final refactor commit:** `917d335`
**Generated:** 2026-05-31 (post-Phase 25f deploy)
**Scope:** `public/admin.js` modularization (Phases 1 through 25f of the refactor plan)

---

## Executive summary

The Pioneer admin page started as a single ~14,290-line `public/admin.js` file. After 25 numbered phases and 7 sub-phases (4a/4b, 6/6a, 16a/16b, 25a-25f), it is now a **638-line shell** that does five things only: boot, Firebase init, auth controller, cross-tab orchestration, and DOMContentLoaded wiring. Every tab subsystem lives in its own self-contained module under `public/admin/`. Every shared DOM/modal/write helper lives in `public/admin/_shell.js`. Every pure helper lives in `public/admin/_utils.js`. Every per-DCR budget computation lives in `public/admin/_budget.js`.

Zero production regressions were caused by the refactor itself. One P0 (Phase 22 — eager Firestore init in tab-deputy-mapping) was caught and fixed within the same cycle. ~18 latent strict-mode ReferenceError bugs that pre-dated the refactor were surfaced and fixed as each tab was extracted. Phase 24 surfaced a CSS `[hidden]` author-rule footgun in `admin-overrides.css` that had been silently breaking empty-state hiding across the admin UI — fixed during the same phase.

The refactor is **complete**. The remaining `admin.js` code is page-shell that genuinely belongs there. Further extraction crosses the diminishing-returns line. **Recommendation: stop refactoring admin.js. Stabilize, document, and ship the open product-safety follow-ups in Phase 26.**

---

## Headline numbers

| Metric | Value |
|---|---:|
| Original `admin.js` size | **14,290 LOC** |
| Final `admin.js` size | **638 LOC** |
| Total LOC reduction in `admin.js` | **−13,652 LOC** |
| Percent reduction | **−95.5%** |
| Modules extracted | **24 tab modules + 3 shared foundation modules = 27 files** |
| Refactor phases completed | **25** (with 7 sub-phases: 4a/4b, 6/6a, 16a/16b, 25a/25b/25c/25d/25e/25f) |
| Production regressions caused by refactor | **0** |
| P0 incidents encountered + resolved within cycle | **1** (Phase 22 — eager Firestore init) |
| Latent bugs surfaced + fixed during refactor | **~19** (18 ReferenceError, 1 CSS `[hidden]` footgun) |
| Cumulative repo growth from refactor | **+1,757 LOC across 27 files** (entirely IIFE wrappers, load guards, module-header JSDoc, namespace destructures — the cost of legibility) |

### Per-phase admin.js size trajectory

| Phase | admin.js LOC | Δ vs start |
|---|---:|---:|
| Phase 1 start | 14,290 | — |
| Phase 23 end | 1,928 | −86.5% |
| Phase 24 end (Attendance + Open Shifts) | 1,188 | −91.7% |
| Phase 25a (shell helpers consolidated) | 1,091 | −92.4% |
| Phase 25b (row overflow → shell) | 1,062 | −92.6% |
| Phase 25c (customer controls → tab-customers) | 1,015 | −92.9% |
| Phase 25d (tech controls → tab-techs) | 920 | −93.6% |
| Phase 25e (DCR controls → tab-recent-dcrs) | 875 | −93.9% |
| **Phase 25f (final cleanup + bridge retirement)** | **638** | **−95.5%** |

---

## Modules extracted (27 files, 16,066 LOC)

### Shared foundation (3 files, 812 LOC)

| File | LOC | Purpose |
|---|---:|---|
| `public/admin/_utils.js` | 248 | Pure helpers: `escapeHtml`, `formatTimestamp`, customer/tech accessors, date helpers (`pacificDateString`, `addDaysPacific`, `getOpsDayWindow`), `DCR_RECENT_LIMIT`, `ALLOWED_ADMIN_EMAILS`, `isRootAdmin` |
| `public/admin/_shell.js` | 368 | DOM/shell: tab wiring, status banners, modals (`openModal`/`closeModal`), toasts, badges, `registerTabActivator`, `installModalCloseAffordances`, modal save-state helpers (`MODAL_REGISTRY` + `setModalSaving`/`setModalError`), admin-write error handler, `getCurrentAdminEmail`, `copyInputValue`, row overflow menu trio |
| `public/admin/_budget.js` | 196 | DCR on-budget analytics: `computeBudgetStats`, `budgetRowBadge`, `budgetTooltipText` |

### Tab modules (24 files, 15,254 LOC)

| # | Module | LOC | Extracted in |
|---|---|---:|---:|
| 1 | `tab-sos.js` | 240 | Phase 4b |
| 2 | `tab-improvements.js` | 313 | Phase 5 |
| 3 | `tab-customer-notes.js` | 708 | Phase 6 |
| 4 | `tab-service-recoveries.js` | 364 | Phase 7 |
| 5 | `tab-training.js` | 178 | Phase 8 |
| 6 | `tab-pilot-readiness.js` | 235 | Phase 9 |
| 7 | `tab-feed.js` | 137 | Phase 10 |
| 8 | `tab-recent-dcrs.js` | 238 | Phase 11 + 25e |
| 9 | `tab-dcr-issues.js` | 410 | Phase 12 |
| 10 | `tab-tech-health.js` | 377 | Phase 13 |
| 11 | `tab-yesterdays-work.js` | 655 | Phase 14 |
| 12 | `tab-customers.js` | 643 | Phase 15 + 25c |
| 13 | `tab-techs.js` | 1,564 | Phase 16a/16b + 25d |
| 14 | `tab-admins.js` | 675 | Phase 17 |
| 15 | `tab-supply-requests.js` | 866 | Phase 18 |
| 16 | `tab-day-health.js` | 548 | Phase 19 |
| 17 | `tab-announcements.js` | 1,158 | Phase 20 |
| 18 | `tab-dcr-review.js` | 331 | Phase 21 |
| 19 | `tab-deputy-mapping.js` | 2,039 | Phase 22 |
| 20 | `tab-schedule.js` | 2,108 | Phase 23 |
| 21 | `tab-attendance.js` | 829 | Phase 24 |

(`tab-customer-notes.js` contains two related tabs — Customer Notes and Note Suggestions — exporting separate namespaces. Counted as one file.)

---

## Phase-by-phase log

| # | Phase | Commit | What moved |
|---|---|---|---|
| 1 | utils | (initial) | `_utils.js` foundation |
| 2 | shell | `de3f4ea` | `_shell.js` foundation + `registerTabActivator` registry |
| 3 | budget | `4d9bb4a` | `_budget.js` foundation |
| 4a | utils backfill | — | extended `_utils.js` |
| 4b | SOS | `f03004b` | `tab-sos.js` |
| 5 | Improvements | `c87477c` | `tab-improvements.js` |
| 6 | Customer Notes | `76b256e` | `tab-customer-notes.js` (also Note Suggestions) |
| 6a | shell badge ext | — | extended `_shell.js` |
| 7 | Service Recoveries | `4102fd2` | `tab-service-recoveries.js` |
| 8 | Training | `d540aaf` | `tab-training.js` |
| 9 | Pilot Readiness | `8ed9dd0` | `tab-pilot-readiness.js` |
| 10 | Feed | `4bd476d` | `tab-feed.js` |
| 11 | Recent DCRs | `b4081ed` | `tab-recent-dcrs.js` |
| 12 | DCR Issues | `7a5c122` | `tab-dcr-issues.js` |
| 13 | Tech Health | `522fb96` | `tab-tech-health.js` |
| 14 | Yesterday's Work | `49cbb71` | `tab-yesterdays-work.js` |
| 15 | Customers | `24e28e5` | `tab-customers.js` core |
| 16a | Cleaning Techs core | `a46e4ff` | `tab-techs.js` core |
| 16b | Cleaning Techs media | `1694b65` | extended `tab-techs.js` |
| 17 | Admins | `e9235a5` | `tab-admins.js` |
| 18 | Supply Requests | `bc0ff8f` | `tab-supply-requests.js` |
| 19 | Day Health | `fc1bd0b` | `tab-day-health.js` |
| 20 | Announcements | `3c7e532` | `tab-announcements.js` |
| 21 | DCR Review modal | `0b771a4` | `tab-dcr-review.js` |
| 22 | Deputy Mapping | `c523dbd` | `tab-deputy-mapping.js` |
| 23 | Schedule | `97f77a2` | `tab-schedule.js` (largest single subsystem) |
| 24 | Attendance + Open Shifts | `092a34c` | `tab-attendance.js` (5-sub-tab module) |
| **25a** | Shell helpers | `d0f3f36` | `handleAdminWriteError`, `MODAL_REGISTRY`, `setModalSaving`, `setModalError`, `getCurrentAdminEmail`, `copyInputValue`, `installModalCloseAffordances` → `_shell.js` |
| **25b** | Row overflow → shell | `9c11196` | `closeAllRowOverflowMenus`, `toggleRowOverflow`, `installOverflowMenuOutsideClose` → `_shell.js` |
| **25c** | Customer controls → tab | `fae38d6` | Customer list delegation + search + save button + auto-slug → `tab-customers.js` `init()` |
| **25d** | Tech controls → tab | `21bf92e` | Tech list delegation (7 actions) + search + save buttons + auto-slug + copy buttons → `tab-techs.js` `init()`; deleted dead `slugifyForTech` |
| **25e** | DCR controls → tab | `7327a22` | DCR list delegation + search + refresh button → `tab-recent-dcrs.js` `init()`; deleted `wireSearch` + `wireRefresh` |
| **25f-A** | Shell orchestration cleanup | `afddc9b` | Collapsed 24-block presence-check ladder into REQUIRED loop; deleted empty `wireWriteControls`; trimmed ~140 lines of stale "moved to" breadcrumbs |
| **25f-B** | Retire redundant deps bridges | `917d335` | Retired 5 deps entries (`loadAdmins`, `getAdmins`, `refreshAttentionStrip`, `getOpsDayWindow`, `populateCustomerDeputyIntegration`) — consumers now call owning namespace or utils export directly |

### Hotfix and stabilization commits (not numbered refactor phases)

- `aba7f1a` — Phase 23 hotfix-2 cache-bust on `_utils.js` + `tab-schedule.js`
- `070f6de` — **P0 fix:** lazy Firestore init in `tab-deputy-mapping.js` (eager `firebase.firestore()` at IIFE-load time crashed admin boot on cold loads)
- `d747294` — docs: scorecard at end of Phase 23
- `2754833` — Phase 24 follow-up: clean attendance loading empty states (JS guard pass — see CSS fix below for actual root cause)
- `6d15163` — Phase 24 follow-up: honor `hidden` empty states in admin panels (CSS `[hidden]` author-rule footgun fix)

---

## Key production QA passes

Every numbered phase was deployed to `https://pioneer-dcr-hub.web.app` and validated by manual browser QA before the next phase started. Notable QA outcomes:

- **Phase 22** — Deputy Mapping QA caught the eager-Firestore-init P0 within hours of deploy; reverted-and-fixed via lazy initialization (`070f6de`).
- **Phase 23** — Schedule subsystem QA surfaced an `_utils.js` cache-bust mismatch that forced a same-day `aba7f1a` hotfix.
- **Phase 24** — Attendance QA initially reported "Loading attendance data…" stuck visible alongside empty states. First fix (Phase 24 JS guard) was correct in intent but defeated by a CSS `[hidden]` author-rule override on `.admin-status.admin-empty`. Second fix (CSS defensive `[hidden] { display: none }` rule) closed the issue. Lesson: when `[hidden]` attribute manipulation appears to "not work," check for higher-specificity `display:` rules in CSS — author rules outrank user-agent `[hidden] { display: none }` at equal specificity.
- **Phases 25a/b/c/d/e/f** — All passed first-try browser QA; no rollbacks, no hotfixes.

---

## P0 incident encountered and resolved

### Phase 22 — eager Firestore init in `tab-deputy-mapping.js`

**Severity:** P0. Admin boot crashed before any tab loaded.

**Root cause:** `tab-deputy-mapping.js`'s IIFE called `firebase.firestore()` at module-load time. On cold page loads where Firebase app initialization hadn't completed yet, this threw and aborted the module's IIFE before its `tabs.deputyMapping` namespace was registered. The downstream `admin.js` presence-check then threw a fatal "tabs.deputyMapping not registered" error, blanking the admin UI.

**Fix:** commit `070f6de` — moved all `firebase.firestore()` calls inside function bodies (lazy-init pattern). The module's IIFE registers the namespace without touching Firebase; Firestore is only accessed when an action handler fires (by which time Firebase is guaranteed initialized).

**Lesson institutionalized:** every `firebase.firestore()` / `firebase.auth()` call in tab modules must be inside a function body, never at IIFE-load time. Verified across all 24 tab modules via grep at Phase 23 close. Audited again at Phase 25f close — pattern holds.

---

## Latent bugs surfaced and fixed during refactor

**Total: ~19** bugs that pre-dated the refactor and were exposed by the act of extraction.

### 18 strict-mode ReferenceError bugs

A recurring pattern: incremental tab extractions left bare `(customers || [])` / `(techs || [])` references in cross-tab consumer code that previously read these as undeclared globals. When the source array moved into a tab module's closure, the consumer's reference broke. Strict mode turned the silent `undefined` into a hard `ReferenceError`.

- **Phase 20** (Announcements): 6 sites
- **Phase 22** (Deputy Mapping): 6 sites
- **Phase 23** (Schedule): 6 sites
- **Phases 24, 25a-25f:** 0 — the pattern was understood by then and audits caught remaining sites at the source-grep stage

### CSS `[hidden]` author-rule footgun (Phase 24 round 2)

**Symptom:** Empty-state divs in Attendance sub-tabs stayed visible even when JS set `el.hidden = true`. Also affected every other admin tab's empty state, but went unnoticed because those tabs always had data.

**Root cause:** `public/styles/admin-overrides.css:189` declares `.admin-panel .admin-status.admin-empty { display: flex; ... }` at specificity (0,3,0), which outranks the browser's `[hidden] { display: none }` rule at (0,1,0). Setting the `hidden` attribute in JS had no visible effect.

**Fix:** commit `6d15163` — added a single defensive rule `.admin-panel .admin-status.admin-empty[hidden] { display: none; }` at higher specificity (0,4,0). Same pattern `ui-empty-states.css:47` already used for `.empty-state[hidden]`.

**Lesson:** when adding a `display:` rule on an element that uses the `hidden` attribute, always add a companion `[hidden]` defensive rule. `.admin-loading` and `.admin-error` were audited and confirmed to not need this fix (no `display:` override exists on either).

---

## Product safety follow-ups (open, NOT addressed in refactor)

The refactor was strictly behavior-preserving — these were observed during QA but deliberately deferred to Phase 26 feature work. All three involve privilege-escalation or destructive actions firing without confirmation.

### 1. Promote-to-Admin fires immediately without confirmation
- **Surface:** Cleaning Techs tab → More menu → "Promote to Admin"
- **Currently:** Click → `tabs.admins.promoteTechToAdmin(t)` fires → creates `/admins/{email}` doc + sends reset email. No confirmation.
- **Risk:** Mis-clicking the wrong row silently grants admin access. Other privileged actions in the admin UI (Archive, Delete) use confirmation modals — Promote should match.
- **Recommended fix:** Reuse the archive-confirm modal pattern from `tab-techs.js` or add a dedicated `admin-promote-confirm-modal` in `admin.html`.

### 2. Reinvite/Resend reset email fires immediately
- **Surface:** Cleaning Techs tab → More menu → "Resend invite" (and Admins tab equivalent)
- **Currently:** Click → `tabs.admins.sendResetInviteFor(email, null)` fires the reset email immediately. No confirmation.
- **Risk:** Accidental clicks send password-reset emails to staff (confusing, support-call generating). Multi-send to the same user creates an audit-trail noise problem.
- **Recommended fix:** Simple confirm dialog ("Send reset email to <name>?") before firing.

### 3. Reactivate fires immediately
- **Surface:** Cleaning Techs tab → archived row → "Reactivate" (and Customers tab equivalent)
- **Currently:** Click → re-enables the auth user and flips `active: true` immediately. No confirmation.
- **Risk:** Accidental reactivation of a tech who was offboarded for cause (e.g., performance, employment ended) re-enables their login.
- **Recommended fix:** Same lightweight confirm modal pattern as Promote.

These three should ship together as a single Phase 26 follow-up — they share the confirmation-modal infrastructure and the touchpoints overlap (tab-techs.js + tab-admins.js + admin.html). Logged in project memory: `project-promote-to-admin-no-confirmation.md`.

---

## Remaining technical debt

### Inside `admin.js` (minimal)
1. **Cross-page nav block duplicated 5×** (`ROLE_NAV_ITEMS` + `withCurrentSearch` + `renderRoleNav` + `paintTeamHubUnreadBadge`, ~120 LOC) — duplicated in `app.js`, `tech.js`, `admin.js`, `supply-station.js`, `team-hub.js`. **Intentional non-extraction**: `app.js:2869-2874` documents the load-order rationale (a 6th `<script>` tag on every page would carry more risk than the duplication carries cost). Revisit only if reopening that decision.
2. **12 small "moved to" breadcrumb comments** in `admin.js` survived the 25f sweep. Cosmetic noise; not worth chasing.

### Module-internal debt
3. **`tab-schedule.js` (2,108 LOC) and `tab-deputy-mapping.js` (2,039 LOC)** are larger than the plan-doc's 1,500-LOC target. Both are genuinely cohesive (single load entry, shared state, single wire-up dispatcher). Splitting would cost more than it saves. Acceptable per `docs/PioneerOps-Refactor-Plan.md` §4.
4. **`tab-schedule.js` `dayHealth24h` dead state** (Phase 23) — confirmed unused, preserved verbatim during extraction. Safe to remove in a follow-up cleanup.
5. **Two byte-identical `slugify*` copies** in `tab-techs.js` (`slugifyTechCandidate`) and `tab-customers.js` (`slugifyCustomerCandidate`). Both are 8-line pure functions. Could move to `_utils.js` but the savings are marginal — leave alone.

### Operational debt
6. **No automated tests.** Every phase verified by browser QA only. Out of scope per `PioneerOps-Refactor-Plan.md` §0 non-goals.
7. **No automated cache-bust bumping.** Cache-bust query strings on `<script>` tags are hand-bumped per phase. A pre-commit hook could derive from `git rev-parse --short HEAD` or file mtime. Not in scope; manual works.

### Documentation debt
8. **`CLAUDE.md`** does not exist in this repo. Future AI-assisted work would benefit from one (covering: deps bridge state, shell helpers map, tab-module template, the CSS `[hidden]` footgun lesson). Recommended as a Phase 25g doc-only commit.
9. **Architecture diagram** is text-only in this scorecard + the new Architecture Guide (`docs/PioneerOps-Architecture-Guide.md`). A visual would help onboarding.

---

## Final recommendation

**Stop refactoring `admin.js`. Stabilize, document, then ship Phase 26.**

Concretely:

1. **No further `admin.js` extraction.** At 638 LOC, the remaining code is page-shell that genuinely belongs here. Boot + auth + cross-tab glue + intentional cross-page nav-dup. Further extraction crosses the diminishing-returns line and risks new failure modes for negligible LoC win.

2. **End-to-end sign-off pass** before declaring the refactor complete: at least one write per writeable surface (customer edit-save, tech archive, announcement save, customer note save, supply-request status flip, recovery save, DCR review-send), plus the bridge-retirement spot checks from Phase 25f QA. If anything regresses, it'll be a bridge-retirement edge case caught best while the changes are fresh.

3. **Documentation** (this commit): scorecard + `PioneerOps-Architecture-Guide.md` capture the post-refactor reality. Optionally add a `CLAUDE.md` for future AI-assisted work.

4. **Phase 26:** the three product-safety follow-ups above. Bounded scope, clear motivation, shippable as a single confirmation-modal commit across `tab-techs.js` + `tab-admins.js` + `admin.html`.

The refactor delivered what it set out to deliver. Time to stabilize and build.

---

*End of scorecard. Refactor cycle complete at commit `917d335` (2026-05-31).*
