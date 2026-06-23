# Deliverable 2 — Role-Based Feature Matrix

Five roles. Five action verbs. The answer to "can role X do action Y to thing Z?"

**Roles (left to right, narrowest → broadest authority):**
- **Cleaning Tech** — active `cleaning_techs` user
- **Inspector** — admin who also does inspection walks (in practice: April, Kirby, occasional Mike). Same auth tier as Admin.
- **Office Manager** — admin tier user whose primary surface is `/manager` (in practice: Kirby + April)
- **CEO** — executive + owner (in practice: April + Nick)
- **Admin** — generic admin tier (Kirby, Mike, others added via `/admin → Admins`)

> **Hierarchy note:** Permissions are hierarchical. CEO inherits everything Office Manager + Admin + Inspector can do. Office Manager / Inspector / Admin all sit at the same tier and inherit Tech-side abilities they happen to be configured for (e.g., an admin who's also in `cleaning_techs` can clock in for cleaning).

**Legend:**
- ✓ = full access
- ⚠ = limited / own-only / with constraints (see footnote)
- — = not available
- 🔒 = explicitly blocked

---

## 1. View / Read

| Capability | Tech | Inspector | Office Manager | CEO | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Own service sessions (`pioneer_service_sessions`) | ⚠ own only | ✓ | ✓ | ✓ | ✓ |
| All service sessions | — | ✓ | ✓ | ✓ | ✓ |
| Own clock state (`active_service_sessions`) | ⚠ own | ✓ | ✓ | ✓ | ✓ |
| Own time-adjustment requests | ⚠ own | ✓ | ✓ | ✓ | ✓ |
| All time-adjustment requests | — | ✓ | ✓ | ✓ | ✓ |
| Own DCR submissions | ⚠ own | ✓ | ✓ | ✓ | ✓ |
| All DCR submissions | — | ✓ | ✓ | ✓ | ✓ |
| Inspections (`inspections`) | — | ✓ | ✓ | ✓ | ✓ |
| Customer inspection state | — | ✓ | ✓ | ✓ | ✓ |
| Customers (basic) | ✓ via tech-safe view | ✓ | ✓ | ✓ | ✓ |
| Customer secure SOP (`customer_secure`) | 🔒 | ✓ | ✓ | ✓ | ✓ |
| Cleaning techs roster | ✓ basic (display name) | ✓ | ✓ | ✓ | ✓ |
| Supply requests | own + assigned | ✓ | ✓ | ✓ | ✓ |
| Call-outs / time-off / open shifts | ⚠ own | ✓ | ✓ | ✓ | ✓ |
| Announcements targeted at me | ✓ | ✓ | ✓ | ✓ | ✓ |
| All announcements | — | ✓ | ✓ | ✓ | ✓ |
| Leadership messages addressed to me | ✓ | ✓ | ✓ | ✓ | ✓ |
| Communication threads I'm a participant in | ✓ | ✓ | ✓ | ✓ | ✓ |
| All communication threads | — | ✓ | ✓ | ✓ | ✓ |
| Customer feedback (compliments + complaints) | — | ✓ | ✓ | ✓ | ✓ |
| Customer complaints details | — | ✓ | ✓ | ✓ | ✓ |
| `dcr_issues` | — | ✓ | ✓ | ✓ | ✓ |
| Service recoveries | — | ✓ | ✓ | ✓ | ✓ |
| Quality wins | ✓ company-wide brag wall | ✓ | ✓ | ✓ | ✓ |
| Rockstar bonuses | ✓ company-wide | ✓ | ✓ | ✓ | ✓ |
| Hiring pipeline (`office_manager_hiring_snapshots`) | — | ✓ | ✓ | ✓ | ✓ |
| Office Manager Mission Control (`/manager`) | — | ✓ | ✓ | ✓ | ✓ |
| CEO Mission Control (`/ceo`) | — | — | — | ✓ | — |
| Pay rates / per-tech compensation data | — | — | — | (owner only when wired) | — |
| Payroll exports + verification snapshot | — | ✓ | ✓ | ✓ | ✓ |
| Sick leave ledger | ⚠ own balance | ✓ | ✓ | ✓ | ✓ |
| `ceo_tasks` | — | — | — | ✓ | — |
| `payroll_periods` | ✓ | ✓ | ✓ | ✓ | ✓ |

> **⚠ own-only** for Tech is enforced by `staff_uid == request.auth.uid` predicates in `firestore.rules`.

---

## 2. Create

| Capability | Tech | Inspector | Office Manager | CEO | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Clock in a cleaning session | ✓ | ✓ | ✓ | ✓ | ✓ |
| Clock in an inspection session | — | ✓ | ✓ | ✓ | ✓ |
| Clock in a supply pickup | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit a DCR | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit an inspection | — | ✓ | ✓ | ✓ | ✓ |
| Submit a call-out (`call_outs`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit time-off request | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit a time-adjustment request | ⚠ own session only | ✓ | ✓ | ✓ | ✓ |
| Submit a supply request | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit an improvement suggestion (`pioneer_improvements`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Submit customer feedback (public anon) | n/a | ✓ | ✓ | ✓ | ✓ |
| Claim an open shift | ✓ atomic via rules | ✓ | ✓ | ✓ | ✓ |
| Reply on a communication thread I'm a participant in | ✓ inbound only | ✓ | ✓ | ✓ | ✓ |
| Create a new communication thread | 🔒 | ✓ | ✓ | ✓ | ✓ |
| Create a `customer_inspection_state` doc | — | ✓ (lazy bootstrap) | ✓ | ✓ | ✓ |
| Create a new customer | — | — | — | ✓ | ✓ |
| Create a new cleaning tech (incl. Auth user) | — | — | — | ✓ | ✓ |
| Create an admin (`/admin → Admins`) | — | — | — | ✓ | ✓ |
| Compose / queue a leadership message | — | — | — | ✓ | — |
| Create a `ceo_task` | — | — | — | ✓ | — |
| Create an announcement | — | — | ✓ | ✓ | ✓ |
| Approve / confirm an open shift coverage (mints Rockstar bonus) | — | — | ✓ | ✓ | ✓ |

---

## 3. Edit / Update

| Capability | Tech | Inspector | Office Manager | CEO | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Move own active session → completed (clock-out) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit a submitted DCR | 🔒 | ✓ admin path | ✓ | ✓ | ✓ |
| Edit a submitted inspection | 🔒 | ✓ | ✓ | ✓ | ✓ |
| Acknowledge / dismiss a leadership message I received | ✓ | ✓ | ✓ | ✓ | ✓ |
| Mark a communication message read | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reassign an inspection (Take Over) | — | ✓ | ✓ | ✓ | ✓ |
| Release an inspection assignment | — | ✓ own | ✓ | ✓ | ✓ |
| Mark Complete an inspection (no form, manual closure) | — | ✓ | ✓ | ✓ | ✓ |
| Bump a `ceo_task` to done / dismissed | — | — | — | ✓ | — |
| Close a communication thread | — | — | ✓ | ✓ | ✓ |
| Edit customer record | — | — | — | ✓ | ✓ |
| Edit `customer_secure` record | — | — | — | ✓ | ✓ |
| Edit / archive a cleaning tech | — | — | — | ✓ | ✓ |
| Edit announcement | — | — | ✓ | ✓ | ✓ |
| Edit a service_assignments doc directly | — | — | ✓ (via bridge) | ✓ | ✓ |
| Update a customer_inspection_state assignment | — | ✓ | ✓ | ✓ | ✓ |
| Mark a `supply_request` status | — | — | ✓ | ✓ | ✓ |
| Mark a `dcr_issue` status | — | — | ✓ | ✓ | ✓ |
| Mark a service_recovery status | — | — | ✓ | ✓ | ✓ |
| Bump an `office_manager_improvements` status | — | — | ✓ | ✓ | ✓ |
| Adjust sick_leave_ledger | — | — | ✓ | ✓ | ✓ |
| Mark a session reviewed / approved for payroll | — | — | ✓ | ✓ | ✓ |
| Unapprove a session (un-revert payroll_state) | — | — | ✓ | ✓ | ✓ |
| Modify pay rates / financial settings | — | — | — | (owner-only, future) | — |
| Hardcoded `ALLOWED_ADMIN_EMAILS` (server) | — | — | — | ⚠ requires deploy | ⚠ requires deploy |

---

## 4. Approve / Reject / Confirm

| Capability | Tech | Inspector | Office Manager | CEO | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Approve a time-adjustment request | — | — | ✓ | ✓ | ✓ |
| Deny a time-adjustment request | — | — | ✓ | ✓ | ✓ |
| Approve a session for payroll | — | — | ✓ | ✓ | ✓ |
| Approve / deny a time-off request | — | — | ✓ | ✓ | ✓ |
| Acknowledge / resolve a call-out | — | — | ✓ | ✓ | ✓ |
| Confirm open-shift coverage (mints Rockstar bonus) | — | — | ✓ | ✓ | ✓ |
| Approve an office_manager_improvement | — | — | ✓ | ✓ | ✓ |
| Approve an improvement suggestion (`pioneer_improvements`) | — | — | ✓ | ✓ | ✓ |
| Resolve / close a customer complaint | — | — | ✓ | ✓ | ✓ |
| Close a service_recovery | — | — | ✓ | ✓ | ✓ |
| Close a communication thread | — | — | ✓ | ✓ | ✓ |

---

## 5. Export

| Capability | Tech | Inspector | Office Manager | CEO | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Download own DCR PDF (via email link) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Download payroll CSV (Verification Layer must pass) | — | — | ✓ | ✓ | ✓ |
| Download a prior payroll export CSV by ID | — | — | ✓ | ✓ | ✓ |
| Void a payroll export | — | — | ✓ | ✓ | ✓ |
| Print inspection result page | — | ✓ browser-print | ✓ | ✓ | ✓ |
| Export `customers` list | — | — | — | — | — (not built; manual copy from /admin) |
| Export QuickBooks-ready data beyond payroll CSV | — | — | — | 🔴 planned | — |

---

## Footnotes — gotchas worth highlighting

1. **Tech sees "From Leadership" only when their email matches `recipientId`** — case-sensitive AFTER lowercase normalization. Drift between Firebase Auth email and `cleaning_techs.email` will silently hide messages. Audit this when a new tech joins.

2. **Tech "own session" reads** depend on `staff_uid` matching `request.auth.uid` — they cannot accidentally see another tech's hours, but they ALSO cannot see anything labeled with a different uid (e.g., admin who clocked on their behalf via an override flow — none currently in production).

3. **Mark Complete on inspection** does NOT create an `inspections/{id}` doc — it only stamps `customer_inspection_state`. The cadence registry sees it; the inspection score history does not. Use Open Inspection if you want a real score recorded.

4. **The "Admin" column in the matrix above** is the catch-all for the Kirby + Mike tier. April is also an admin (inherited from Executive), but for matrix simplicity her CEO-only capabilities are isolated to the CEO column.

5. **Pay rate storage** is not built today. The "owner-only when wired" entries are placeholders for the Financial Pulse phase; the role hierarchy is ready for it (see `06-known-gaps.md`).

6. **Approve / Deny actions** all flow through Cloud Functions (admin SDK bypasses rules). Client-side users can only TRIGGER them; the function re-validates admin role. If the function rejects, the client sees a 403 with the reason.

7. **No "Tech can edit their own DCR"** — DCR docs are immutable after submit. Mistakes require admin action.

---

## End of Matrix

For "how to run these capabilities day to day" → `04-sop-drafts.md`.
For "what's NOT in this matrix that you might expect" → `06-known-gaps.md`.
