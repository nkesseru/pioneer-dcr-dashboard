# PioneerOps — Admin Architecture Guide

**Status:** post-Phase 25f (commit `917d335`, 2026-05-31)
**Audience:** developers (human or AI) making changes to `public/admin.html` and its JavaScript modules.

This document captures the architecture of the admin page after the multi-phase refactor that brought `admin.js` from 14,290 LOC to 638 LOC. For the journey, see [PioneerOps-Refactor-Scorecard.md](./PioneerOps-Refactor-Scorecard.md). This guide is about the destination.

---

## Architecture overview

```
                ┌─────────────────────────────────────────────────┐
                │  public/admin.html                              │
                │  (HTML shell — panels, modals, role nav)        │
                └─────────────────────────────────────────────────┘
                                       │
                       Script load order (top → bottom)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Foundation layer (3 files, ~810 LOC total)                             │
│  ─────────────────────────────────────────────────                      │
│  public/admin/_utils.js   pure helpers, date math, accessors            │
│  public/admin/_shell.js   DOM/shell: modals, toasts, tabs, write helpers│
│  public/admin/_budget.js  per-DCR budget analytics                      │
└─────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Tab modules (24 files, ~15,250 LOC total)                              │
│  ─────────────────────────────────────────────────                      │
│  Each owns: its own Firestore reads, writes, state, DOM, event handlers │
│  Each exports: window.__pioneerAdmin.tabs.<name> = { init, refresh,…}   │
│                                                                          │
│  tab-sos.js · tab-improvements.js · tab-customer-notes.js               │
│  tab-service-recoveries.js · tab-training.js · tab-pilot-readiness.js  │
│  tab-feed.js · tab-recent-dcrs.js · tab-dcr-issues.js                  │
│  tab-tech-health.js · tab-yesterdays-work.js · tab-customers.js        │
│  tab-techs.js · tab-admins.js · tab-supply-requests.js                 │
│  tab-day-health.js · tab-announcements.js · tab-dcr-review.js          │
│  tab-deputy-mapping.js · tab-schedule.js · tab-attendance.js           │
└─────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  public/admin.js — the shell (638 LOC)                                  │
│  ─────────────────────────────────────────────────                      │
│  Boot · Firebase init · auth controller · DOMContentLoaded orchestrator │
│  · cross-tab fan-out (loadDcrsAndRerenderDependents) · deps bridge      │
│  · cross-page nav (intentionally duplicated, see §"Cross-page nav")     │
└─────────────────────────────────────────────────────────────────────────┘
```

There is no build pipeline. Every module is a plain IIFE that attaches its public surface to `window.__pioneerAdmin`. Script tags are ordered explicitly in `admin.html`.

---

## Role of each file

### `public/admin.js` — shell / boot / auth / orchestration only

**638 LOC.** Five responsibilities, nothing else:

1. **Module presence checks** — a `REQUIRED_PATHS` loop verifies every foundation + tab module loaded before admin.js. Fails loud (throws with explicit message) if a script tag is missing.
2. **Firebase SDK presence checks + initialization** — granular checks for app/auth/firestore + config; `firebase.initializeApp(...)`; creates the `db = firebase.firestore()` singleton.
3. **Auth controller** — `resolveAdminStatus` (two-tier hardcoded + Firestore admins lookup); `showAuthState` (four-state UI: checking / signin / denied / content); `handleAuthChange` (fires the cross-tab refresh fan-out once the admin is confirmed); `wireSignIn` / `wireSignOut` (Google popup auth).
4. **Cross-tab fan-out orchestration** — `loadDcrsAndRerenderDependents()` refreshes Recent DCRs then re-renders Customers / Techs / Day Health (whose cards display DCR-derived data). Called from the DCR Refresh button (tab-recent-dcrs.js) and the DCR Review modal success path (tab-dcr-review.js) via the deps bridge.
5. **DOMContentLoaded boot orchestrator** — `wireTabs()`, `registerTabActivator()` calls for lazy-load tabs, eager `init()` calls for tabs that wire on boot, `__pioneerAdmin.deps` bridge population, `onAuthStateChanged` start, modal close + overflow menu install.

**`admin.js` deliberately contains zero business logic.** No Firestore writes, no UI rendering of business data, no per-tab behavior. If you find yourself adding any of those, you're in the wrong file.

### `public/admin/_shell.js` — DOM/shell helpers (368 LOC)

Helpers that every tab needs but that aren't tab-specific. Exposed at `window.__pioneerAdmin.shell.*`:

| Helper | Purpose |
|---|---|
| `wireTabs()` | One-time click wiring for the main tab strip (`.admin-tab`) |
| `setStatus(panelKey, state, msg)` | Show/hide loading/error/empty banners per panel by ID convention (`<panelKey>-loading`, etc.) |
| `hideAllStatuses(panelKey)` | Hide all three banners for a panel |
| `showFatal(msg)` | Replace `<body>` with a fatal-error tile (page-killing) |
| `openModal(id)` / `closeModal(id)` | Modal show/hide with focus management + body scroll lock |
| `showToast(kind, msg)` | Transient toast notification with CSS-transition reveal/hide |
| `badge(cls, label)` + `activeBadge` / `dcrEnabledBadge` / `dcrEmailBadge` | Shared status pill HTML builders |
| `activateTab(tabKey)` | Programmatic tab activation; fires the registered activator |
| `registerTabActivator(tabKey, fn)` | Lazy-load registry — tabs that want to load only when opened register here |
| `setModalSaving(modalId, on)` | Generic save-button disabled-state + label flip; reads `MODAL_REGISTRY` |
| `setModalError(modalId, msg)` | Generic modal error display; reads `MODAL_REGISTRY` |
| `handleAdminWriteError(err, opts)` | Centralized Firestore-write error formatter — logs full error, formats friendly message, fires toast, optionally sets modal error |
| `getCurrentAdminEmail()` | Reads `firebase.auth().currentUser.email`; falls back to `"unknown"` |
| `copyInputValue(inputId, btnId)` | Clipboard API helper with "Copied!" label flash; fallback to `execCommand("copy")` |
| `installModalCloseAffordances()` | Wires `[data-modal-close]` clicks + Escape-to-close for the three core editor modals |
| `closeAllRowOverflowMenus` / `toggleRowOverflow` / `installOverflowMenuOutsideClose` | Row "More ▾" popover trio |

### `public/admin/_utils.js` — pure helpers (248 LOC)

Pure functions and constants. No DOM, no Firebase. Exposed at `window.__pioneerAdmin.utils.*`:

| Helper | Purpose |
|---|---|
| `DCR_RECENT_LIMIT` | Constant — recent DCR fetch cap (500) |
| `ALLOWED_ADMIN_EMAILS` / `isRootAdmin(email)` | Hardcoded root admin allowlist |
| `escapeHtml(s)` / `cssEsc(s)` | XSS-safe string escaping |
| `formatTimestamp(ts)` / `tsToMs(ts)` / `formatImprovementDate(...)` | Timestamp formatting + conversion |
| `getCustomerName` / `getCustomerSlug` / `getCustomerEmail` / `getCustomerLocation` | Customer field accessors with denormalized-vs-canonical schema tolerance |
| `getActive` / `getDcrEnabled` / `getDcrEmailEnabled` | Boolean field accessors with sensible defaults |
| `getTechName` / `getTechSlug` | Tech field accessors |
| `pacificDateString(d)` / `addDaysPacific(s, n)` / `getOpsDayWindow(now, cutoffHour, tz)` | Pacific-time date math for the operational-day boundaries |

### `public/admin/_budget.js` — DCR budget analytics (196 LOC)

Per-DCR "on-budget" computations used by the Customer + Tech row cards. Exposed at `window.__pioneerAdmin.budget.*`:

| Helper | Purpose |
|---|---|
| `getOnBudget(dcr)` | Returns "yes" / "no" / "n/a" / null per DCR's on-budget tag |
| `dcrTsToMs(dcr)` | DCR-specific timestamp extraction |
| `emptyBucket()` | Returns zero-counts object |
| `computeBudgetStats(dcrs, { kind, slug })` | Aggregates on-budget counts for a customer or tech |
| `budgetRowBadge(stats)` / `budgetTooltipText(stats)` | UI builders that emit the badge HTML + tooltip text |

---

## Tab registration pattern

Every tab module exposes `init` + `refresh`, plus tab-specific exports:

```js
window.__pioneerAdmin.tabs.<module> = {
  init:    function () { /* one-time wiring */ },
  refresh: function () { /* re-fetch Firestore data + re-render */ },
  // ...tab-specific exports (getX, openYModal, onZSave, etc.)
};
```

`init()` is called once at boot in admin.js's DOMContentLoaded handler (or skipped if the tab uses lazy-load via `registerTabActivator`). `refresh()` is called by `handleAuthChange` when an admin signs in (initial data load) and any time a write elsewhere needs that tab's data to repaint.

For lazy-loaded tabs (Feed, Training, Schedule, Attendance, Tech Health, Pilot Readiness, Yesterday, Improvements, SOS):
```js
registerTabActivator("attendance", window.__pioneerAdmin.tabs.attendance.refresh);
```

The shell calls the activator the first time the user clicks the tab — and on every subsequent click for idempotent re-reads. Tabs that need only-once-initializers (Pilot Readiness, Yesterday, Improvements, SOS) gate their internal logic with a `wired` flag.

---

## How to add a new tab module (future)

Six steps. The pattern is mechanical at this point.

### 1. Create the module file

Path: `public/admin/tab-<name>.js`. Template:

```js
/* Pioneer DCR Hub — Admin <Name> tab (vanilla JS, no build).
 * Brief description of what this tab owns and does.
 * Surface lives at window.__pioneerAdmin.tabs.<name>.
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-<name>.js: utils + shell modules must load first");
  }
  const { /* ...needed utils... */ } = window.__pioneerAdmin.utils;
  const { /* ...needed shell helpers... */ } = window.__pioneerAdmin.shell;

  function $(id) { return document.getElementById(id); }

  // ---------- module state (owned by this module only) ----------
  let myDataArray = [];

  // ---------- helpers / renderers / actions ----------
  // ...all tab logic here...

  // ---------- one-time wiring ----------
  function wire<Name>Controls() {
    // Event listeners, click handlers, etc.
  }

  function init() {
    wire<Name>Controls();
  }

  async function refresh() {
    // Fetch from Firestore, render.
  }

  // ---------- export surface ----------
  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.<name> = {
    init: init,
    refresh: refresh,
    // ...other exports if other tabs need read access...
  };
}());
```

### 2. Add the script tag to `admin.html`

Insert between the other tab modules, before `admin.js`. Include a cache-bust:
```html
<script src="admin/tab-<name>.js?v=YYYYMMDD-feature-name"></script>
```

### 3. Add the path to `REQUIRED_PATHS` in `admin.js`

```js
const REQUIRED_PATHS = [
  // ...existing...
  "tabs.<name>"
];
```

That's it for the presence check — no per-tab `if` block needed.

### 4. Wire the boot or activator

Eager init (wires on boot):
```js
window.__pioneerAdmin.tabs.<name>.init();
```

Lazy activator (loads on first tab click):
```js
registerTabActivator("<name>", window.__pioneerAdmin.tabs.<name>.refresh);
```

### 5. Optionally add to `handleAuthChange`

If the tab needs to load data on admin sign-in:
```js
window.__pioneerAdmin.tabs.<name>.refresh();
```

### 6. Optionally expose data to other tabs via the deps bridge

If sibling tabs need to read this tab's state:
```js
window.__pioneerAdmin.deps = {
  // ...existing...
  get<Name>: function () { return window.__pioneerAdmin.tabs.<name>.get<Name>(); }
};
```

Only do this if there are 2+ external consumers. Single-consumer reads should call the namespace directly (`window.__pioneerAdmin.tabs.<owner>.getX()`).

---

## Script load order (mandatory)

From `admin.html`:

1. **Firebase compat SDK** (v10.12.5): `firebase-app-compat.js`, `firebase-auth-compat.js`, `firebase-firestore-compat.js`, `firebase-storage-compat.js`
2. **`firebase-config.js`** — sets `window.FIREBASE_CONFIG`
3. **Standalone helpers**: `mandatory-modal.js`, `info-tip.js`, `operational-feed.js`, `customer-sop.js`, `celebrate.js`, `customer-display.js`
4. **Foundation modules** (order matters):
   - `admin/_utils.js`
   - `admin/_shell.js` (depends on `_utils.js`)
   - `admin/_budget.js`
5. **Tab modules** (any order — each guards on `__pioneerAdmin.utils` + `__pioneerAdmin.shell` being present)
6. **`admin.js`** (depends on all of the above)
7. **`pwa-register.js`** (last — registers the service worker)

The order is enforced by `admin.js`'s `REQUIRED_PATHS` presence-check loop. If a script tag is missing or misordered, admin.js throws a `must load before admin.js` error before anything else runs.

---

## Required guard / check patterns

Every tab module's IIFE must:

```js
if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
  throw new Error("admin/tab-<name>.js: utils + shell modules must load first");
}
```

(Add `|| !window.__pioneerAdmin.budget` if the module uses budget helpers.)

`admin.js` then runs `REQUIRED_PATHS.forEach(...)` to verify every tab successfully registered. Together these catch:
- Script tags missing from `admin.html`
- Script tag ordering errors
- IIFE-level throws inside any tab (which would prevent registration)

The `tab-deputy-mapping.js` check has a verbose error message (post-Phase 22 P0) — preserved as a one-off after the loop to give the next person debugging a similar issue a head start.

---

## The `deps` bridge — pattern and current state

`__pioneerAdmin.deps` is a small bridge object populated by `admin.js` at boot. Tabs use it to read live data from sibling tabs without importing each other directly.

### Current bridge entries (post-25f — 6 only)

```js
window.__pioneerAdmin.deps = {
  getCustomers:                  function () { return tabs.customers.getCustomers(); },
  getTechs:                      function () { return tabs.techs.getTechs(); },
  getDcrs:                       function () { return tabs.recentDcrs.getDcrs(); },
  getDcrIssues:                  function () { return tabs.dcrIssues.getDcrIssues(); },
  getSupplyRequests:             function () { return tabs.supplyRequests.getSupplyRequests(); },
  loadDcrsAndRerenderDependents: function () { return loadDcrsAndRerenderDependents(); }
};
```

### Usage pattern in tab modules

```js
function depOrThrow(name) {
  const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
  if (!deps || typeof deps[name] !== "function") {
    throw new Error("tab-X: __pioneerAdmin.deps." + name + " not populated yet");
  }
  return deps[name];
}
const getCustomers = () => depOrThrow("getCustomers")();
// ...used as: const customers = getCustomers();
```

This is lazy-by-design — `depOrThrow` runs at call time, not module-load time, so it tolerates the `deps` bridge being populated *after* the tab module's IIFE runs (which it is — admin.js populates `deps` inside DOMContentLoaded, after all tab IIFEs have already executed).

### When to add a new bridge entry

Only when **multiple sibling tabs** need to read the same data from one owning tab. Single-consumer reads should call `window.__pioneerAdmin.tabs.<owner>.getX()` directly.

### What was retired (Phase 25f)

Five bridge entries were retired because they had only 1-3 consumers and each had a direct equivalent:
- `loadAdmins` (→ `tabs.admins.refresh()`)
- `getAdmins` (→ `tabs.admins.getAdmins()`)
- `refreshAttentionStrip` (→ `tabs.dayHealth.refresh()`)
- `getOpsDayWindow` (→ `utils.getOpsDayWindow`)
- `populateCustomerDeputyIntegration` (→ `tabs.deputyMapping.populateCustomerIntegration(c)`)

Also retired in Phase 25a — four shell-side helpers that lived in `deps` before they moved to `_shell.js`:
- `getCurrentAdminEmail` (→ `shell.getCurrentAdminEmail`)
- `handleAdminWriteError` (→ `shell.handleAdminWriteError`)
- `setModalError` (→ `shell.setModalError`)
- `setModalSaving` (→ `shell.setModalSaving`)

---

## Module ownership map

| Owns Firestore writes to… | Module |
|---|---|
| `customers` | `tab-customers.js` |
| `cleaning_techs` (+ auth disable/enable + delete Cloud Function) | `tab-techs.js` |
| `dcr_submissions` (reads only; writes happen via DCR submit flow) | `tab-recent-dcrs.js` (reads) |
| `dcr_issues` | `tab-dcr-issues.js` |
| `supply_requests` | `tab-supply-requests.js` |
| `admins` (+ create login + reset email + promote) | `tab-admins.js` |
| `announcements` + `announcement_reads` | `tab-announcements.js` |
| `customer_notes` + `customer_note_suggestions` | `tab-customer-notes.js` |
| `service_recoveries` | `tab-service-recoveries.js` |
| `time_off_requests` + `call_outs` + `open_shift_requests` + `rockstar_bonuses` | `tab-attendance.js` |
| `deputy_customer_mappings` (+ Deputy API sync) | `tab-deputy-mapping.js` |
| `team_schedule` + Storage uploads | `tab-schedule.js` |
| `dcr_email_payloads` (Review & Send modal) | `tab-dcr-review.js` |
| `improvements` | `tab-improvements.js` |
| `sos_events` | `tab-sos.js` |

Read-only modules (no Firestore writes):
- `tab-day-health.js` (aggregates from many collections)
- `tab-feed.js` (reads `operational_feed_events`)
- `tab-pilot-readiness.js` (cross-collection readiness checks)
- `tab-tech-health.js` (derives from techs + dcrs)
- `tab-training.js` (reads training completion records)
- `tab-yesterdays-work.js` (read-only nightly recap)

---

## Auth flow

```
                       Page load
                          │
                          ▼
         admin.js sets showAuthState("checking")
                          │
                          ▼
   firebase.auth().onAuthStateChanged(handleAuthChange)
                          │
              ┌───────────┴───────────┐
              │                       │
         user == null              user != null
              │                       │
              ▼                       ▼
   showAuthState("signin")    isRootAdmin(email)?
                                      │
                            ┌─────────┴─────────┐
                            yes                 no
                            │                   │
                            ▼                   ▼
                   showAuthState         resolveAdminStatus(email)
                   ("content")           queries /admins/{email}
                            │                   │
                            │           ┌───────┴───────┐
                            │          ok              !ok
                            │           │               │
                            │           ▼               ▼
                            │      showAuthState   showAuthState
                            │      ("content")     ("denied")
                            │           │
                            └─────┬─────┘
                                  │
                                  ▼
                  if currentAuthEmail changed:
                    fire cross-tab refresh fan-out:
                      tabs.customers.refresh()
                      tabs.techs.refresh()
                      loadDcrsAndRerenderDependents()
                      tabs.supplyRequests.refresh()
                      tabs.dcrIssues.refresh()
                      tabs.announcements.refresh()
                      tabs.admins.refresh()
                      tabs.customerNotes.refresh()
                      tabs.noteSuggestions.refresh()
                      tabs.serviceRecoveries.refresh()
                      tabs.dayHealth.loadInspectionsThisWeek()
                      tabs.dayHealth.refreshMetrics()
                      paintTeamHubUnreadBadge(staffShape)
                      MANDATORY_ANN.check(staffShape)
```

**Two-tier admin check** (mirrors `firestore.rules` `isPioneerAdmin()` and `functions/index.js` `verifyStaffOrReject()`):
1. **Root admins** (hardcoded `ALLOWED_ADMIN_EMAILS` in `_utils.js`) — instant grant, survives Firestore outages.
2. **Operational admins** — `/admins/{lowercased-email}` doc with `active != false`. Added via the Admins tab without a code deploy.

`currentAuthEmail` is the re-entrancy guard — `onAuthStateChanged` can fire multiple times for the same user, but the fan-out only runs when the email actually changes.

---

## Boot flow

```
DOMContentLoaded fires
       │
       ▼
wireTabs()                                         ─── main tab strip clicks
       │
       ▼
registerTabActivator("feed", tabs.feed.init)       ─── lazy-load registry
registerTabActivator("training", ...)              ─── (9 total)
…
       │
       ▼
tabs.recentDcrs.init()                             ─── eager init: tabs that
tabs.supplyRequests.init()                              wire on boot
tabs.dcrIssues.init()
tabs.dayHealth.init()
tabs.announcements.init()
tabs.admins.init()
tabs.dcrReview.init()
       │
       ▼
window.__pioneerAdmin.deps = { … }                 ─── populate cross-tab bridge
                                                       BEFORE later inits can read it
       │
       ▼
tabs.dcrIssues.onChange(callback)                  ─── cross-tab repaint wiring
       │
       ▼
tabs.customerNotes.init()                          ─── more eager inits
tabs.noteSuggestions.init()
tabs.serviceRecoveries.init()
tabs.training.init()
tabs.customers.init()
tabs.techs.init()
tabs.deputyMapping.init()
tabs.schedule.init()
tabs.attendance.init()
tabs.techHealth.init()
       │
       ▼
installModalCloseAffordances()                     ─── modal close + Esc
installOverflowMenuOutsideClose()                  ─── row "More" outside-click
       │
       ▼
wireSignIn()                                       ─── Google popup wiring
wireSignOut()
       │
       ▼
showAuthState("checking")                          ─── initial UI state
       │
       ▼
firebase.auth().onAuthStateChanged(handleAuthChange) ── start auth listener
```

**Critical invariant:** the `deps` bridge population must complete *before* any later tab `init()` reads from it. The current ordering achieves this — `deps =` runs immediately after the first batch of inits and before the second batch.

---

## Cross-tab refresh / fan-out flow

The cross-tab orchestrator is `loadDcrsAndRerenderDependents()`, kept in `admin.js`:

```js
async function loadDcrsAndRerenderDependents() {
  await window.__pioneerAdmin.tabs.recentDcrs.refresh();
  window.__pioneerAdmin.tabs.customers.applyFilter();   // customer cards show DCR-derived budget stats
  window.__pioneerAdmin.tabs.techs.applyFilter();       // tech cards show DCR-derived budget stats
  window.__pioneerAdmin.tabs.dayHealth.refresh();       // attention strip rolls up DCR signals
}
```

**Called from two places** (both through `deps.loadDcrsAndRerenderDependents`):
1. The DCR Refresh button in `tab-recent-dcrs.js` (`wireRecentDcrsControls`)
2. The DCR Review modal Send/Resend success path in `tab-dcr-review.js`

This orchestrator lives in `admin.js` because no single tab is the natural owner — it fans out across four different tab modules. Tabs read it through the `deps` bridge.

---

## Cross-page nav (intentionally duplicated 5×)

`ROLE_NAV_ITEMS`, `withCurrentSearch`, `renderRoleNav`, and `paintTeamHubUnreadBadge` are **duplicated identically** in:
- `public/app.js`
- `public/tech.js`
- `public/admin.js`
- `public/supply-station.js`
- `public/team-hub.js`

This is **intentional**, documented in `app.js:2869-2874`. Reasoning: extracting to a shared `nav.js` would require a 6th `<script>` tag on every page, and the load-order risk (a single missing tag silently breaks the nav menu on one page) outweighs the duplication cost (~120 LOC × 5 files = ~600 LOC).

**Rule:** when editing the role nav or team-hub badge logic, edit it in **all five files in the same commit.** A grep for `KEEP IN SYNC` in any of those files will land you in the right spot.

---

## Known PWA / service-worker cache caveat

The repo includes a service worker at `public/sw.js`. **It is intentionally passthrough** — present only for PWA installability, does not cache anything. `public/pwa-register.js` registers it on every page load.

However, **browser HTTP cache** still applies. `firebase.json` sets `Cache-Control: no-cache` for `*.js` / `*.css` / `*.html`, which means browsers must revalidate every request but may serve from cache if the ETag matches. After a deploy, an open tab won't pick up new JS until the page is reloaded.

**Operational rule:** after every `firebase deploy --only hosting`, hard-reload `/admin` (Cmd+Shift+R / Ctrl+Shift+R) before QA. Cache-bust query strings on `<script>` tags should be bumped any time a file's contents change in a way QA needs to verify against fresh code.

---

## CSS `[hidden]` footgun (Phase 24 lesson)

**Problem:** The browser's `[hidden] { display: none }` user-agent rule has specificity (0,1,0). Any CSS author rule that sets `display:` on the same element at higher specificity will *defeat* the `hidden` attribute, making `el.hidden = true` in JS appear to have no effect.

**Example that bit us:** `styles/admin-overrides.css:189` set `.admin-panel .admin-status.admin-empty { display: flex; ... }` at specificity (0,3,0). Empty-state divs stayed visible even when JS hid them. Symptom was visible across all admin tabs but only noticed during Phase 24 Attendance QA (because most tabs always have data and never showed empty states).

**Fix (Phase 24 round 2, commit `6d15163`):** Always add a companion `[hidden]` defensive rule at equal-or-higher specificity:
```css
.admin-panel .admin-status.admin-empty { display: flex; /* ... */ }
.admin-panel .admin-status.admin-empty[hidden] { display: none; }   /* ← defensive */
```

`ui-empty-states.css:47` was already using this pattern for `.empty-state[hidden]`; the admin override was just missing it.

**Rule:** whenever you add a `display:` rule on a class that any element will use with the `hidden` attribute, add the `[hidden] { display: none }` companion rule immediately. Audit other CSS files in this repo for the same footgun before adding new components.

---

## Testing checklist for future admin changes

There are no automated tests. Use this manual checklist after any non-trivial admin change.

### Boot
- [ ] `/admin` loads without console errors
- [ ] No fatal-error screen ("Couldn't initialize the Pioneer admin page…")
- [ ] No "Checking access…" hang
- [ ] Console clean of `ReferenceError`, `TypeError`, "is not a function"

### Auth
- [ ] Sign out → sign-in screen shows
- [ ] Sign in with admin email → dashboard renders
- [ ] Sign in with non-admin email → "Access denied" screen with email shown
- [ ] Sign-out from any page returns to sign-in

### Every tab opens
Click through every tab in the strip. Verify each loads without console errors and renders either real data or a clean empty state (NOT both a loading banner AND an empty state at the same time — that's the Phase 24 footgun).

### Per-tab spot checks
- **Customers** — search filters; Edit modal opens; save no-op completes; Archive works; "+ Add customer" with auto-slug works
- **Cleaning Techs** — search filters; Edit + Media modals open; Save works; "More" menu → Promote / Archive / Delete / Resend each fire (note: Promote/Reactivate/Resend are open safety follow-ups — they currently fire without confirmation); "+ Add tech" with auto-slug + copy buttons works
- **Dashboard (Recent DCRs)** — search filters; Refresh button cycles label correctly + clears search after; Review & Send opens modal
- **Customer Notes / Service Recoveries / Announcements / Admins** — open create modal, save no-op, verify list updates
- **Day Health** — KPI strip renders; attention items show; ops-window calculations look right (4 PM Pacific reset)
- **Supply Requests** — list renders; status flips work
- **Attendance** — all 5 sub-tabs (Pending TO / Approved TO / Call-Outs / Calendar / Open Shifts) render; Calendar shows 60 cells; Open Shifts form opens
- **Deputy Mapping** — sync from Deputy works (if Deputy creds present)
- **Schedule** — current schedule loads; upload flow works
- **Tech Health / Yesterday / Pilot Readiness / SOS / Training / Improvements / Feed** — each opens and renders

### Cross-tab fan-out
- [ ] Submit a test DCR via `/` → click Refresh on the admin Dashboard → verify the customer card + tech card for that DCR update their stats
- [ ] Save a customer note → verify Day Health attention strip updates

### Console audit
Open DevTools → Console. No errors during any of the above steps.

### Force a failure path
- [ ] Sign out in another tab while editing a customer → save → confirm the admin-write error path fires (toast + modal error)

---

## Rules for future developers

These are non-negotiable. The refactor existed to make these possible — don't reintroduce the patterns the refactor removed.

### 1. Do not add new business logic to `admin.js`
`admin.js` is shell only. New per-tab features go in the tab module that owns them. New shared helpers go in `_shell.js` (DOM-touching) or `_utils.js` (pure).

### 2. New admin features live in tab modules
Adding a new section to the admin UI? Create a new `public/admin/tab-<name>.js` per the template above. Don't put it in `admin.js`.

### 3. Keep `admin.js` as shell only
If you find yourself reaching for `firebase.firestore()` in `admin.js`, stop. That work belongs in a tab module. The only Firestore call `admin.js` makes is the one-line `/admins/{email}` lookup inside `resolveAdminStatus` — and that's because it's the auth check.

### 4. Use shell helpers for modal / write / overflow behavior
Don't roll your own toast, modal open/close, save-button disabling, or admin-write error formatter. All of those are in `_shell.js`. Destructure them at the top of your tab module:
```js
const { openModal, closeModal, showToast, setModalSaving, setModalError, handleAdminWriteError } = window.__pioneerAdmin.shell;
```

### 5. Keep risky auth / admin-access code isolated
Anything that touches `/admins`, `firebase.auth()`, or admin allowlists must stay in either `admin.js`'s auth controller or `tab-admins.js`. Don't sprinkle auth checks into other tabs — the firestore.rules + admin allowlist is the security boundary; tab modules trust that boundary.

### 6. Never call `firebase.firestore()` / `firebase.auth()` at IIFE-load time
**Always** wrap Firebase calls inside function bodies. The Phase 22 P0 was an eager `firebase.firestore()` at module-load time — it crashed boot when Firebase initialization hadn't completed yet. Lazy-init pattern only.

### 7. Add `[hidden] { display: none }` companion rules when overriding `display`
See the CSS footgun section above. If you add a `display: flex` (or any `display:` value) to a class that any element will use the `hidden` attribute on, add the defensive `[hidden]` rule next to it.

### 8. Bump cache-bust on every `<script>` tag whose source changed
Format: `?v=YYYYMMDD-feature-name`. Hand-bumped. After deploy, hard-reload `/admin` before QA.

### 9. Preserve behavior exactly during refactor work
If you're moving code (not adding features), the diff should produce byte-identical UI behavior. The 25-phase refactor stayed regression-free precisely because every phase was "move, don't change." Adding behavior changes into a refactor commit makes regressions impossible to attribute.

### 10. Document the why, not the what
Comments in this codebase favor "why is this surprising / what constraint forced this shape" over "what does this code do." If you find yourself writing a comment that just describes what the next line does, delete it. If you find a constraint or decision that future-you would want to know, write it down with enough context to be actionable.

---

*End of architecture guide. For the journey here, see `docs/PioneerOps-Refactor-Scorecard.md`. For the original plan, see `docs/PioneerOps-Refactor-Plan.md`.*
