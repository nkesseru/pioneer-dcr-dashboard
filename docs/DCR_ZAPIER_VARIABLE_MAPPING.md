# Pioneer DCR Hub — Zapier / GHL Variable Mapping (Handoff)

**Audience:** the engineer wiring the new Pioneer DCR Hub up to the existing
downstream automation (Zapier → OpenAI / Gmail / Slack / Sheets / GHL Reviews).

**Scope of change:** the **entire DCR intake layer has been replaced** — not
just photo hosting. The DCR form, the file storage, the data store, and the
webhook origin are all new. Most of the downstream Zap can stay intact, but
**every field mapping must be updated** before it can run on real submissions.

This document is the source of truth for the field-by-field migration.

---

## ⚠️ Do not touch PeakOps

Pioneer DCR Hub lives in its own isolated Firebase project at
`/Users/nicholaskesseru/Projects/pioneer-dcr-hub`. **PeakOps is a separate
codebase that is intentionally out of scope for this migration.** Do not
import from, reuse env from, or deploy alongside PeakOps. Treat
`pioneer-dcr-hub` as a stand-alone production app for this work.

---

## 1. Current architecture

### OLD (pre-migration)

```
GHL DCR Form
   └── Zapier (Catch Hook on GHL trigger)
         ├── OpenAI (summary / triage)
         ├── Gmail   (customer DCR email — images broken in clients ❌)
         ├── Slack   (ops alerts)
         ├── Sheets  (logging)
         └── GHL     (review request flow)
```

GHL provided the form, the contact record, and the image hosting. Image URLs
were unstable in Gmail / Outlook clients — the original reason this project
exists.

### NEW (current)

```
Firebase DCR Form (Hosting)
   ├──> Firebase Storage   (photos + signatures, stable Firebase token URLs)
   ├──> submitDcrV1        (Cloud Function v2)
   │       ├── validates payload
   │       ├── writes to Firestore (dcr_submissions/{submission_id})
   │       └── POSTs clean payload to Zapier Catch Hook
   └──> Zapier (existing Zap — re-mapped to Firebase fields)
         ├── OpenAI  (unchanged)
         ├── Gmail   (now uses Firebase URLs ✅)
         ├── Slack   (unchanged)
         ├── Sheets  (unchanged)
         └── GHL     (review request flow — see §11)
```

The Zap **does not have to be rebuilt** — its trigger swaps from "GHL Inbound
Webhook" to "Webhooks by Zapier — Catch Hook", and every field merge tag is
re-bound to the new Firebase payload (see §6).

---

## 2. What's replaced vs. what's not

| Layer | Status |
|---|---|
| DCR intake form | **Replaced** — now Firebase Hosting (vanilla HTML/CSS/JS, mobile-first, signature pad, draft autosave) |
| Image hosting | **Replaced** — Firebase Storage with stable token URLs |
| Data persistence | **Replaced** — Firestore `dcr_submissions/{submission_id}` |
| Webhook origin | **Replaced** — `submitDcrV1` Cloud Function POSTs to the Zap |
| Field shapes | **Replaced** — see §5 |
| Zapier Zap | **Re-mapped** — same Zap, new trigger + new field bindings |
| OpenAI / Gmail / Slack / Sheets actions | **Unchanged logic, new field references** |
| GHL review workflow | **Unchanged** — fed by the same Zap (see §11) |

---

## 3. Firebase URLs

| Resource | URL |
|---|---|
| Form (Hosting) | `https://pioneer-dcr-hub.web.app` |
| `submitDcrV1` function | `https://submitdcrv1-pix4fcoh4a-uc.a.run.app` |
| Firestore project | `pioneer-dcr-hub` |
| Firestore collection | `dcr_submissions` |
| Storage bucket | `pioneer-dcr-hub.appspot.com` |

The function URL accepts `POST application/json` only. Validator rejects
anything missing the v1 required fields with `HTTP 400` and a `details[]`
array; valid submissions write to Firestore and (when configured) POST a
clean payload to Zapier.

---

## 4. Storage paths

**Photos** — uploaded directly from the browser via the Firebase Web SDK
before the function is called. The function never sees the bytes — only the
resolved `download_url` and `storage_path`.

```
dcr-photos/{customerSlug}/{submissionId}/photo-{n}.{ext}
```

**Signatures** — the handwritten PNG from the on-screen signature pad,
captured at submit time.

```
dcr-signatures/{customerSlug}/{submissionId}/signature.png
```

Both paths are publicly readable (rules allow anonymous read so Gmail /
Outlook can render the images directly). Writes are constrained to
`image/*` ≤ 10 MB (photos) and ≤ 1 MB (signatures).

---

## 5. Canonical Firebase payload fields

Every field below appears on every saved `dcr_submissions/{submission_id}`
document AND on every Zapier webhook POST. Optional/conditional fields are
called out.

### Identity + provenance

| Field | Type | Notes |
|---|---|---|
| `submission_id` | string | URL-safe, sortable, used as Firestore doc ID and the idempotency key. |
| `schema_version` | string | Currently `"dcr.v1"`. Bump only on breaking shape changes. |
| `source` | string | `"web_form"` (current intake), `"ghl"` (legacy / dual-source compat), `"api"` (future partner intake). |

### Customer + tech (denormalized so downstream never needs a join)

| Field | Type | Notes |
|---|---|---|
| `customer_slug` | string | Stable customer key (e.g. `acme-dental`). |
| `customer_name` | string | Display name for emails / Slack. |
| `customer_email` | string | Where Zapier should send the DCR email (only if `customer_dcr_email_enabled` is `true`). Empty string when not yet populated in the customer record. |
| `customer_dcr_email_enabled` | bool | **DCR-email opt-out flag.** When `false`, the Zap should branch around the Gmail step but keep Slack / Sheets / GHL running. Default `true` when the customer doc omits the field. Distinct from `dcr_enabled` (which gates form visibility — opted-out customers still appear in the form). |
| `location_name` | string | Per-site label for multi-location customers. Falls back to `customer_name`. |
| `tech_slug` | string | Stable tech key. |
| `tech_display_name` | string | Marketing-cased name. **This is the value used as `affirmation.signature_name`.** |
| `tech_experience_level` | string | `trainee` / `standard` / `lead` / `supervisor`. |

### Visit basics

| Field | Type | Notes |
|---|---|---|
| `clean_date` | string | `YYYY-MM-DD` in the customer's time zone. |
| `notes` | string | Free text from the cleaner. May be empty. Not required. |
| `occupancy` | string | `empty` / `light` / `normal` / `heavy` / `after-event`. Always present (defaults to `empty` if "no one was in the building"). |
| `time_budget` | object \| null | Legacy v1 placeholder. Authoritative data lives in `form_data.on_time_budget` + `form_data.time_budget_reasons`. |

### Checklist

| Field | Type | Notes |
|---|---|---|
| `checklist` | array | Legacy v1 mirror — currently empty in normal flow. Use `form_data.checklist` for actual data. |
| `form_data.checklist[]` | array | One entry per section, each with `section_id`, `section_label`, `items[]`. Each `item` has `item_id`, `label`, `status: "done" \| "issue" \| "na" \| null`. Items with `status === "issue"` and a non-empty `note` will include the `note` field. |

### Supplies

| Field | Type | Notes |
|---|---|---|
| `supply_requests` | array | Legacy v1 placeholder. Actual answer lives in `form_data`. |
| `form_data.needs_supplies` | boolean | True if cleaner answered "Yes" to "Do you need supplies?". |
| `form_data.supply_request_text` | string | Free text. Empty string when `needs_supplies = false`. |

### Problems

| Field | Type | Notes |
|---|---|---|
| `problems` | array | Legacy v1 placeholder. |
| `form_data.has_problem` | boolean | |
| `form_data.problem` | object \| null | When `has_problem = true`: `{category, summary, details, location, our_fault}`. `null` otherwise. |

### Photos + signature

| Field | Type | Notes |
|---|---|---|
| `photo_urls[]` | string[] | **Flat list of stable Firebase download URLs.** Recommended for Gmail templates. |
| `photos[]` | object[] | Full objects: `{id, storage_path, download_url, content_type, size_bytes, width, height, caption, tag}`. Use when richer metadata is needed. |
| `affirmation.signature_name` | string | Mirrors `tech_display_name`. The cleaning tech selected at the top of the form is the legal name of record. Required, non-empty. |
| `affirmation.signature_url` | string \| null | Stable Firebase download URL of the handwritten signature PNG. Always present when the form is submitted (the form validator requires a handwritten signature). |
| `affirmation.affirmed` | boolean | Must be `true` for a submission to validate. |
| `affirmation.signed_at` | string (ISO 8601) | Client-set at submit time. |
| `affirmation.affirmed_text` | string | The exact pledge wording the cleaner ticked. |

### Cleaning experience (this-visit rating)

| Field | Type | Notes |
|---|---|---|
| `form_data.experience_rating` | string | `excellent` / `good` / `okay` / `difficult`. Distinct from `tech_experience_level` (skill level). |

### Time + occupancy detail

| Field | Type | Notes |
|---|---|---|
| `form_data.anyone_in_building` | boolean | |
| `form_data.occupancy_level` | string | Same enum as top-level `occupancy`. |
| `form_data.on_time_budget` | boolean | True if cleaner stayed inside budgeted minutes. |
| `form_data.time_budget_reasons[]` | string[] | Reason IDs (see `dcr-form-config.js` → `budget_reason_groups`). Empty when `on_time_budget = true`. |

### Downstream-routing placeholders (Phase-2 ready)

| Field | Type | Notes |
|---|---|---|
| `feedback.review_requested` | boolean | Flipped to `true` by a future Zap when the review email goes out. |
| `feedback.review_link_sent` | boolean | Same. |
| `feedback.customer_rating` | number \| null | Populated when the customer answers. |
| `feedback.customer_feedback_id` | string \| null | Stable FK back into the review system. |
| `review_links.five_star_url` | string | Per-customer URL from the customer record. Empty until populated. |
| `review_links.issue_url` | string | Same. |

### Delivery / observability

| Field | Type | Notes |
|---|---|---|
| `delivery.email_sent` | boolean | Flipped by the downstream Zap (Phase 2). |
| `delivery.email_sent_at` | string \| null | ISO. |
| `delivery.zapier_sent` | boolean | Mirrors `zapier.status === "sent"` for quick filtering. |
| `delivery.zapier_sent_at` | string \| null | |
| `delivery.zapier_attempts` | number | 0 when not configured, 1 after first attempt. |
| `delivery.last_error` | string \| null | |
| `zapier.attempted` | boolean | |
| `zapier.status` | string | `"not_configured"` / `"sent"` / `"failed"`. |
| `zapier.status_code` | number \| null | HTTP status returned by Zapier. |
| `zapier.error` | string \| null | First 300 chars of error body if `failed`. |
| `zapier.sent_at` | string \| null | ISO. |
| `submission_meta.user_agent` | string | |
| `submission_meta.app_version` | string | Current intake build. |
| `submission_meta.client_submitted_at` | string (ISO) | |
| `submission_meta.server_received_at` | Firestore Timestamp | Set on the server when the doc lands. |
| `submission_meta.geo` | object \| null | Reserved for future geofence work. |
| `created_at` | Firestore Timestamp | |
| `updated_at` | Firestore Timestamp | |

---

## 6. Old GHL → New Firebase mapping

> **Heads-up on checklist sections.** GHL stored each checklist as a single
> text/boolean per section. The new Firebase payload stores per-item state
> (`done` / `issue` / `na`) and per-issue notes. The Zap should iterate
> `form_data.checklist[].items[]` and filter where `status === "issue"` to
> reproduce the old "what went wrong" summary.

| Old GHL field / concept | New Firebase field | Used for | Notes |
|---|---|---|---|
| Customer Name | `customer_name` | Email subject, Slack, sheets, GHL contact lookup | Use `customer_slug` for stable joins. |
| Cleaning Tech | `tech_display_name` | Email "Cleaner: …" line, Sheets, Slack | Also written as `affirmation.signature_name`. |
| Clean Date | `clean_date` | Email subject ("DCR — Acme — 2026-05-11"), Sheets | Always `YYYY-MM-DD` in customer TZ. |
| Bathrooms checklist | `form_data.checklist[section_id="bathrooms"].items[]` | Email body, Sheets | Each item: `{item_id, label, status, note?}`. |
| General Areas checklist | `form_data.checklist[section_id="general-areas"].items[]` | same | |
| Kitchens / Cafeteria / Break Rooms checklist | `form_data.checklist[section_id="kitchen-cafeteria-break"].items[]` | same | Label in UI is "Kitchens / Break Rooms"; the section_id retained `cafeteria` for back-compat. |
| Offices checklist | `form_data.checklist[section_id="offices"].items[]` | same | |
| Entry / Vestibules / Foyer / Main Doors checklist | `form_data.checklist[section_id="entry-vestibules"].items[]` | same | UI label is now "Entryways". |
| Do you need supplies? | `form_data.needs_supplies` (bool) | Slack alert, email | |
| Supply request details | `form_data.supply_request_text` | Email body, Slack | Empty string when `needs_supplies = false`. |
| Cleaning Experience | `form_data.experience_rating` | Email, Sheets, OpenAI triage | Enum: `excellent` / `good` / `okay` / `difficult`. |
| Was there a problem? | `form_data.has_problem` (bool) | Slack high-priority routing | |
| Problem Category | `form_data.problem.category` | Slack, email | Enum from `problem_categories` in `dcr-form-config.js`. |
| Problem Summary | `form_data.problem.summary` | Slack title, email subject decoration | |
| Problem Details | `form_data.problem.details` | Email body, OpenAI input | |
| Detailed Location | `form_data.problem.location` | Slack, email | |
| Was this caused by our team? | `form_data.problem.our_fault` (bool) | Internal triage, escalation routing | |
| Picture Upload 1 | `photo_urls[0]` (or `photos[0].download_url`) | Email image #1 | If absent, the Zap should render fewer slots silently. |
| Picture Upload 2 | `photo_urls[1]` | Email image #2 | |
| Picture Upload 3 | `photo_urls[2]` | Email image #3 | |
| Extra pictures | `photo_urls[3..]` | Email gallery / Sheets | The new form accepts up to 12 photos total. |
| Was anyone in the building? | `form_data.anyone_in_building` (bool) | Email, Slack ops note | |
| Occupancy timing/level | `form_data.occupancy_level` (also mirrored to top-level `occupancy`) | Email, Sheets | Enum: `empty` / `light` / `normal` / `heavy` / `after-event`. |
| Were you able to stick to your time budget? | `form_data.on_time_budget` (bool) | Slack "off-budget" alert | |
| Time budget reasons | `form_data.time_budget_reasons[]` | Email body, Sheets | Array of reason IDs. Empty when on budget. |
| Notes | `notes` | Email body | Free text. Not required. |
| Affirmation checkbox | `affirmation.affirmed` (bool, always `true` when present) | Compliance / audit | The pledge text is in `affirmation.affirmed_text`. |
| Clean Tech Signature | `affirmation.signature_url` (image) + `affirmation.signature_name` (string) | Email signature image, audit log | `signature_name` is auto-sourced from the selected cleaning tech — no retype. |

**New fields without a GHL precedent** — useful additions worth wiring:

- `submission_id` — exact-clean identity, idempotency key.
- `customer_email` — moves customer-email lookup off the Zap and onto the customer record.
- `location_name` — supports multi-location customers cleanly.
- `experience_rating` — new self-rating signal for tech-side morale tracking.
- Per-item checklist status + note — granular instead of section-level boolean.

---

## 7. Zapier Catch Hook field recommendations

Set the Zap trigger to **Webhooks by Zapier → Catch Hook**, then walk the
sample payload after the first real submission. When mapping into actions:

- Use **`photo_urls[]`** as the primary handle for Gmail / Slack image
  rendering. It's a flat list of strings — trivial to slot into a loop or
  enumerate. Zapier exposes each as `photo_urls`, `photo_urls__1`,
  `photo_urls__2`, etc.
- Use **`photos[]`** when an action needs richer image metadata
  (`storage_path`, `size_bytes`, `content_type`).
- Use **`affirmation.signature_url`** for the signature image at the
  bottom of the customer email.
- Use **`submission_id`** as the idempotency / deduplication key on every
  downstream action that has a "skip if seen before" filter.
- Use **`customer_slug` + `clean_date` + `tech_slug`** as the relational
  triple for any Sheets/BI work. `submission_id` is the unique row key;
  the triple is the natural query.

---

## 8. Gmail email mapping recommendations

> ⚠ **Gate the Gmail step on `customer_dcr_email_enabled`.**
> Add a Zapier **Filter** step *before* the Gmail action that only continues
> when `customer_dcr_email_enabled` is `true`. Customers with `false` are
> opted out of the customer-facing DCR email but **still** appear in the
> form and **still** flow through Slack / Sheets / GHL. Default is `true`
> when missing, so existing customers keep getting email as before.



Body Type = **HTML**. Tested in Gmail desktop / iOS / Android, Outlook web,
and iPhone Mail (see also `docs/ZAPIER_INTEGRATION.md` for the full
client-by-client checklist).

### Photos (one block per slot — enumerate, don't loop)

```html
<img src="{{photo_url}}"
     style="max-width:600px; width:100%; height:auto;
            border-radius:12px; margin:8px 0; display:block;" />
```

`{{photo_url}}` maps to any element of `photo_urls[]`. Repeat the block for
each slot you want to render (Gmail HTML doesn't support loops). Three
slots covers the typical DCR; missing slots render as broken-image-free
empty space because Zapier substitutes empty string for absent indices.

### Signature

```html
<img src="{{signature_url}}"
     alt="Signature — {{signature_name}}"
     style="max-width:220px; height:auto; margin-top:8px; display:block;" />
<p style="margin:4px 0 0; font-size:13px; color:#5b6573;">
  {{signature_name}}
</p>
```

### Subject line pattern

```
DCR — {{customer_name}} — {{clean_date}}{{#if problem}} ⚠ Problem{{/if}}
```

(Zapier doesn't support handlebars syntax inline, but most "Formatter by
Zapier" steps can simulate the conditional decoration with a Lookup Table
keyed on `form_data.has_problem`.)

---

## 9. Google Sheets logging recommendations

Recommended columns (one row per DCR submission):

| Column | Source field |
|---|---|
| `submission_id` | `submission_id` |
| `clean_date` | `clean_date` |
| `customer_name` | `customer_name` |
| `customer_slug` | `customer_slug` |
| `location_name` | `location_name` |
| `tech_display_name` | `tech_display_name` |
| `tech_slug` | `tech_slug` |
| `photo_urls_joined` | `photo_urls[]` joined with `, ` (use Formatter → Text → Join) |
| `signature_url` | `affirmation.signature_url` |
| `has_problem` | `form_data.has_problem` |
| `problem_summary` | `form_data.problem.summary` |
| `needs_supplies` | `form_data.needs_supplies` |
| `supply_request_text` | `form_data.supply_request_text` |
| `occupancy_level` | `form_data.occupancy_level` |
| `on_time_budget` | `form_data.on_time_budget` |
| `tech_experience_level` | `tech_experience_level` |
| `experience_rating` | `form_data.experience_rating` |
| `created_at` | `created_at` (or `submission_meta.client_submitted_at` if you want client clock instead of server) |
| `zapier_status` | `zapier.status` |

Sort by `clean_date` descending; pivot by `customer_slug` for monthly
reports.

---

## 10. Slack alert recommendations

Drive these from filter steps in the same Zap, posting to the appropriate
Slack channel.

| Trigger | Filter condition | Channel | Body |
|---|---|---|---|
| **Problem reported** | `form_data.has_problem == true` | `#ops-alerts` | `⚠ {{customer_name}} ({{tech_display_name}}, {{clean_date}}) — {{form_data.problem.category}}: {{form_data.problem.summary}}` + a link to the doc. |
| **Supply request** | `form_data.needs_supplies == true` | `#supplies` | `📦 {{customer_name}} — {{form_data.supply_request_text}}` (tech: `{{tech_display_name}}`). |
| **Over budget** | `form_data.on_time_budget == false` | `#ops` | `⏱ {{customer_name}} ({{tech_display_name}}) — off budget. Reasons: {{form_data.time_budget_reasons}}.` |
| **Issue items on checklist** | Count of `form_data.checklist[*].items[*].status == "issue"` ≥ 1 | `#ops` | `🔧 {{customer_name}} — {{N}} checklist issue(s) flagged. {{tech_display_name}}, {{clean_date}}.` Link to doc, list the labels + notes. |
| **Customer interaction note** | `form_data.anyone_in_building == true` AND `notes` non-empty | `#ops` | `👥 {{customer_name}} — occupancy: {{form_data.occupancy_level}}. Notes: {{notes}}` |

Tag the original `submission_id` in each Slack message so a follow-up can
reference back to the exact clean.

---

## 11. Review workflow linkage

**Phase 1 (now):** keep the existing GHL review-request workflow. It
already triggers on a contact tag, owns the customer record, and renders
the customer-facing review pages. We are not rebuilding that flow.

**What to pass into GHL** when the Zap fires the review request:

- `submission_id` — store as a GHL custom field on the contact event
  ("Last DCR Submission ID") and/or as a URL parameter on the review
  link so any customer response can be associated back to the exact
  clean.
- `customer_slug`, `tech_slug`, `clean_date` — same idea, useful for
  segmentation and tech-level review scoring.
- `review_links.five_star_url` / `review_links.issue_url` — if you
  populate these on the customer record, the Zap can pass them through
  without a separate Zap branch.

**Phase 2 (later — not in scope here):** an inbound webhook from GHL
(or from the review pages themselves) writes back into the same
Firestore doc by `submission_id`, flipping `feedback.review_requested`,
`feedback.review_link_sent`, and eventually `feedback.customer_rating` +
`feedback.customer_feedback_id`. The schema slots are already in place
(see §5 → "Downstream-routing placeholders").

---

## 12. Current status

- ✅ Form is live: `https://pioneer-dcr-hub.web.app`
- ✅ Function is deployed and accepting submissions:
  `https://submitdcrv1-pix4fcoh4a-uc.a.run.app`
- ✅ Firestore writes succeed; photos + signatures upload to Storage.
- ⚠ **Zapier URL is intentionally not configured yet.** Every saved
  submission today carries `zapier: { status: "not_configured" }`.
- ⏳ Pending: MaCe provides a real Zapier Catch Hook URL → it gets pasted
  into `functions/.env` → the function is redeployed → the very next
  submission fires the webhook.

Until the URL is set, the form, the function, and the Firestore writes
all behave exactly as they will in production — only the Zapier dispatch
is skipped. No data is lost in the interim; every submission is
recoverable from Firestore and can be back-filled into the Zap by a
manual replay if desired.

---

## 13. Final setup command

When the Catch Hook URL is ready:

```bash
# 1. Drop the URL into the gitignored env file.
#    functions/.env  (create from functions/.env.example if missing)
ZAPIER_DCR_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/1234567/abcdef/

# 2. Deploy the function (and only the function — hosting + rules unchanged).
firebase deploy --only functions:submitDcrV1
```

Verify by submitting one real DCR from the form and checking that the
Firestore doc gets `zapier.status: "sent"` updated alongside the regular
fields.

---

## 14. Quick reference — paths and IDs

| Resource | Value |
|---|---|
| Project | `pioneer-dcr-hub` |
| Region | `us-central1` |
| Firestore region | `nam5` |
| Collection | `dcr_submissions` |
| Document ID | `submission_id` (idempotent — retries are safe) |
| Schema version | `dcr.v1` |
| Storage bucket | `pioneer-dcr-hub.appspot.com` |
| Photos prefix | `dcr-photos/{customerSlug}/{submissionId}/` |
| Signatures prefix | `dcr-signatures/{customerSlug}/{submissionId}/` |
| Function name | `submitDcrV1` |
| Function URL | `https://submitdcrv1-pix4fcoh4a-uc.a.run.app` |
| Form URL | `https://pioneer-dcr-hub.web.app` |
| Env var | `ZAPIER_DCR_WEBHOOK_URL` (in `functions/.env`) |

---

## ⚠️ Reminder — do not touch PeakOps

PeakOps lives in a separate folder, runs on a separate Firebase project,
and is **out of scope for this integration**. Do not import code from it,
copy env from it, or deploy it. Pioneer DCR Hub is standalone. If you
find yourself opening a PeakOps file, you're in the wrong repo.
