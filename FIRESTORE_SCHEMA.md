# Firestore Schema — Pioneer DCR Hub

Firebase project: `pioneer-dcr-hub`
Region: `nam5`
Schema version: `v1` (field `schema_version: "dcr.v1"` on all `dcr_submissions`)

This schema is the single source of truth for what gets written into Firestore from
the DCR intake (web form today, possibly replacing GoHighLevel later). It is intentionally
flat and tolerant of missing fields so we can iterate without breaking the pipeline.

Top-level collections:

- `customers`
- `cleaning_techs`
- `dcr_form_templates`
- `dcr_submissions`

All timestamps are Firestore `Timestamp`. All slugs are `kebab-case`, ASCII, no spaces.

---

## 1. `customers`

One doc per customer site / billing entity. Doc ID = `customerSlug`.

| Field             | Type       | Notes |
|-------------------|------------|-------|
| `slug`            | string     | Doc ID. Used in storage path. e.g. `acme-dental`. |
| `name`            | string     | Display name. e.g. `Acme Dental — Riverside`. |
| `address`         | string     | Single-line address. |
| `timezone`        | string     | IANA tz, e.g. `America/Phoenix`. |
| `default_template_id` | string | Doc ID in `dcr_form_templates`. |
| `email_recipients`| string[]   | Where the daily report email is sent. |
| `notify_on_problem`| string[]  | Extra recipients for `severity >= tier_2`. |
| `active`          | boolean    | Hide inactive from the dropdown. Default `true` when missing. |
| `dcr_enabled`     | boolean    | Controls whether this customer appears in the **DCR form** dropdown. `false` = removed from the dropdown entirely. Default `true` when missing. |
| `dcr_email_enabled` | boolean  | Controls whether **customer-facing DCR emails** should be sent downstream by Zapier. `false` = customer is opted out of the daily DCR email **but still appears in the form** and DCRs still save normally. Distinct from `dcr_enabled`. Default `true` when missing (back-compat: existing customers keep receiving emails unless explicitly opted out). |
| `slack_channel`   | string     | Per-customer Slack channel for ops alerts (e.g. `#customer-acme`). |
| `notes`           | string     | Internal notes — office-only, never reaches the customer. |
| `created_at`      | Timestamp  | server. |
| `updated_at`      | Timestamp  | server. Stamped on every admin save. |
| `updated_by`      | string     | Email of the admin who last touched the doc. |
| `archived_at`     | Timestamp \| null | Set when admin archives (active → false). `null` when active. |
| `archived_by`     | string \| null    | Email of the admin who archived. `null` when active. |

---

## 2. `cleaning_techs`

One doc per cleaner. Doc ID = `techSlug` (e.g. `maria-g`).

| Field            | Type       | Notes |
|------------------|------------|-------|
| `slug`           | string     | Doc ID. |
| `display_name`   | string     | `Maria G.` |
| `full_name`      | string     | Internal full name. |
| `email`          | string     | Tech contact email. Office-internal. |
| `phone`          | string     | E.164 if possible. |
| `experience_level`| string    | One of `trainee`, `standard`, `lead`, `supervisor`. |
| `assigned_customers` | string[]| Customer slugs they typically clean. |
| `active`         | boolean    | Hide inactive from dropdown. Default `true` when missing. |
| `dcr_enabled`    | boolean    | Controls whether this tech appears in the **DCR form** dropdown. Default `true` when missing. |
| `notes`          | string     | Internal notes. |
| `created_at`     | Timestamp  | |
| `updated_at`     | Timestamp  | Stamped on every admin save. |
| `updated_by`     | string     | Email of the admin who last touched the doc. |
| `archived_at`    | Timestamp \| null | Set when admin archives (active → false). `null` when active. |
| `archived_by`    | string \| null    | Email of the admin who archived. `null` when active. |

---

## 3. `dcr_form_templates`

Defines the checklist a tech sees for a given customer. Doc ID = `templateSlug`
(e.g. `medical-office-standard`). Customers reference this via `default_template_id`.

| Field             | Type       | Notes |
|-------------------|------------|-------|
| `slug`            | string     | Doc ID. |
| `name`            | string     | `Medical Office — Standard`. |
| `version`         | number     | Bump on edit. |
| `sections`        | Section[]  | See below. |
| `supply_catalog`  | Supply[]   | Items the tech can request. |
| `problem_categories` | string[] | e.g. `plumbing`, `equipment`, `safety`, `access`, `vandalism`, `other`. |
| `problem_tiers`   | Tier[]     | Severity ladder, see below. |
| `occupancy_options` | string[] | e.g. `empty`, `light`, `normal`, `heavy`, `after-event`. |
| `budget_reason_groups` | string[] | e.g. `over_budget_due_to`, `under_budget_due_to`. |
| `active`          | boolean    | |
| `created_at`      | Timestamp  | |
| `updated_at`      | Timestamp  | |

### `Section` (embedded)

```
{
  id: "restrooms",
  label: "Restrooms",
  required: true,
  items: [
    { id: "toilets-cleaned",  label: "Toilets cleaned & disinfected", required: true },
    { id: "mirrors-streak",   label: "Mirrors streak-free",           required: true },
    { id: "tp-restocked",     label: "Toilet paper restocked",        required: true }
  ]
}
```

### `Supply` (embedded)

```
{ id: "tp-2ply", label: "Toilet paper (2-ply)", unit: "case" }
```

### `Tier` (embedded)

```
{ id: "tier_1", label: "Minor — log only" }
{ id: "tier_2", label: "Moderate — notify account manager" }
{ id: "tier_3", label: "Critical — notify account manager + customer immediately" }
```

---

## 4. `dcr_submissions`

The daily cleaning report. Doc ID = auto. One doc per visit.
Storage path for photos: `dcr-photos/{customerSlug}/{submissionId}/photo-{n}.{ext}`.

| Field                  | Type       | Notes |
|------------------------|------------|-------|
| `schema_version`       | string     | `"dcr.v1"`. |
| `submission_id`        | string     | Mirror of doc ID (denormalized for downstream consumers like Zapier). |
| `source`               | string     | `"web_form"` today, `"ghl"` later, `"api"` for partners. |
| `customer_slug`        | string     | FK → `customers`. |
| `customer_name`        | string     | Denormalized for email/Zapier. |
| `tech_slug`            | string     | FK → `cleaning_techs`. |
| `tech_display_name`    | string     | Denormalized. |
| `tech_experience_level`| string     | Denormalized (helps weight tier_3 escalations). |
| `template_id`          | string     | FK → `dcr_form_templates`. |
| `template_version`     | number     | Captured at submit time. |
| `clean_date`           | string     | `YYYY-MM-DD` in customer tz. |
| `clean_started_at`     | Timestamp  | Optional. |
| `clean_ended_at`       | Timestamp  | Optional. |
| `time_budget`          | TimeBudget | See below. |
| `occupancy`            | string     | One of `template.occupancy_options`. |
| `checklist`            | ChecklistSection[] | See below. |
| `supply_requests`      | SupplyRequest[]    | See below. |
| `problems`             | Problem[]          | See below. |
| `photos`               | Photo[]            | See below. **Stable Firebase URLs live here.** |
| `notes`                | string     | Free text from tech. |
| `affirmation`          | Affirmation| See below. |
| `submission_meta`      | Meta       | See below. |
| `delivery`             | Delivery   | See below — tracks downstream send (email, Zapier). |
| `created_at`           | Timestamp  | server. |
| `updated_at`           | Timestamp  | server. |

### `TimeBudget`

```
{
  budgeted_minutes: 90,
  actual_minutes: 105,
  variance_minutes: 15,
  reason_group: "over_budget_due_to",   // matches template.budget_reason_groups
  reason_note: "Spill in lobby required extra wet vac pass"
}
```

### `ChecklistSection`

```
{
  section_id: "bathrooms",
  section_label: "Bathrooms",
  items: [
    { item_id: "toilets-cleaned", label: "...", status: "done" },     // "done" | "issue" | "na"
    { item_id: "mirrors-streak",  label: "...", status: "issue", note: "Cracked mirror in stall 2" }
  ]
}
```

Status values:
- `done`  — item completed normally
- `issue` — problem found; a `note` field (free text) is attached when present
- `na`    — not applicable to this visit (replaces the previous `skipped`)

### `SupplyRequest`

```
{ supply_id: "tp-2ply", label: "Toilet paper (2-ply)", quantity: 2, unit: "case", urgency: "next_visit" }
```

### `Problem`

```
{
  id: "p1",
  category: "plumbing",
  tier: "tier_2",
  description: "Slow drain in men's room sink #2",
  photo_ids: ["ph_3"],         // references photos[].id
  reported_to_customer: false
}
```

### `Photo`

```
{
  id: "ph_1",
  storage_path: "dcr-photos/acme-dental/abc123/photo-1.jpg",
  download_url: "https://firebasestorage.googleapis.com/...&token=...",   // STABLE, embeddable in email
  content_type: "image/jpeg",
  size_bytes: 482910,
  width: 3024,
  height: 4032,
  caption: "After — lobby floor",
  tag: "after"   // before | after | problem | general
}
```

### `Affirmation`

```
{
  affirmed: true,
  affirmed_text: "I confirm the above is accurate to the best of my knowledge.",
  signature_name: "Maria G.",
  signed_at: Timestamp
}
```

### `Meta`

```
{
  user_agent: "...",
  app_version: "dcr-hub-web@0.1.0",
  ip_hash: "sha256:...",        // never store raw IP
  client_submitted_at: Timestamp,
  geo: { lat: 33.4, lng: -112.0, accuracy_m: 25 }   // optional
}
```

### `Delivery`

```
{
  email_sent: false,
  email_sent_at: null,
  zapier_sent: false,
  zapier_sent_at: null,
  zapier_attempts: 0,
  last_error: null
}
```

---

## Why this shape

- **Photos as objects, not just URL strings.** We carry the storage path AND the
  download URL so we can rotate tokens or re-mint URLs without losing the file pointer.
- **Denormalized customer/tech names.** Email + Zapier consumers never need a join.
- **`schema_version` on every submission.** Future-proofs the pipeline when GHL is
  swapped in/out as a source.
- **`source` field.** Same collection accepts web form, GHL webhook, or future API
  partners — only the writer changes, the schema doesn't.
- **`delivery` sub-doc.** One place to see whether a DCR has been emailed / Zapped,
  and to retry idempotently.
