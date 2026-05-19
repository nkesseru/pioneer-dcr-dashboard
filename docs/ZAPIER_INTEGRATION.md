# Zapier Integration — Pioneer DCR Hub

**Goal:** When `submitDcrV1` writes a new DCR to Firestore, it also POSTs a clean
JSON payload to a Zapier "Catch Hook" so the existing GHL email + review flow
can run from a stable Firebase data source instead of brittle GHL image URLs.

This document covers:

- [Configuration](#configuration)
- [Webhook payload shape](#webhook-payload-shape)
- [Field reference](#field-reference)
- [Zapier "Catch Hook" setup](#zapier-catch-hook-setup)
- [Mapping into a Gmail action](#mapping-into-a-gmail-action)
- [Recommended HTML for photos and signature](#recommended-html-for-photos-and-signature)
- [Email-rendering test checklist](#email-rendering-test-checklist)
- [Troubleshooting](#troubleshooting)

---

## Configuration

The Zapier URL is **never** stored in frontend code or in source. It lives in
the Cloud Function's environment file, which is gitignored.

### 1. Get the webhook URL from Zapier

In Zapier:

1. Create a new Zap.
2. Trigger → **Webhooks by Zapier** → **Catch Hook** → Continue.
3. Zapier shows a custom webhook URL like
   `https://hooks.zapier.com/hooks/catch/1234567/abcd1234/`. Copy it.

### 2. Configure the Cloud Function

```bash
cp functions/.env.example functions/.env
```

Edit `functions/.env`:

```
ZAPIER_DCR_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/1234567/abcd1234/
```

### 3. Redeploy the function

```bash
firebase deploy --only functions:submitDcrV1
```

The value is read at request time (`process.env.ZAPIER_DCR_WEBHOOK_URL`), so a
single redeploy is enough — the function picks the URL up immediately.

If `ZAPIER_DCR_WEBHOOK_URL` is empty or absent the function still works — every
DCR records `zapier: { status: "not_configured" }` on its Firestore doc and the
browser's success card simply won't show a Zapier indicator.

---

## Webhook payload shape

`submitDcrV1` POSTs `Content-Type: application/json` with a body that looks
like this. Top-level `photo_urls` and `signature_url` are the easy hooks for
Gmail templates; `photos` and `affirmation` carry richer metadata for Zaps that
need it.

```jsonc
{
  "submission_id":         "abc123-xyz",
  "schema_version":        "dcr.v1",
  "source":                "web_form",

  "customer_slug":              "acme-dental",
  "customer_name":              "Acme Dental — Riverside",
  "customer_email":             "ops@acmedental.com",
  "customer_dcr_email_enabled": true,
  "location_name":              "Acme Dental — Riverside",

  "tech_slug":             "maria-g",
  "tech_display_name":     "Maria G.",
  "tech_experience_level": "lead",

  "clean_date":            "2026-05-10",
  "submitted_at":          "2026-05-10T17:42:18.221Z",
  "notes":                 "All routine. Reported slow drain to AM via Slack.",

  "occupancy":             "normal",

  "time_budget": {
    "on_budget": false,
    "reasons":  ["extra-mess", "supplies-issue"]
  },

  "supply_requests": "2 cases of TP, 1 case of trash bags",

  "problem": {
    "category":  "plumbing",
    "summary":   "Slow drain in men's room sink #2",
    "details":   "Water pooling for ~30s before draining. Photos attached.",
    "location":  "Men's restroom, 2nd floor",
    "our_fault": false
  },

  "checklist": [
    {
      "section_id":    "bathrooms",
      "section_label": "Bathrooms",
      "items": [
        { "item_id": "toilets-cleaned", "label": "Toilets cleaned & disinfected", "status": "done"  },
        { "item_id": "mirrors-streak",  "label": "Mirrors streak-free",           "status": "issue" }
      ]
    }
    /* ... one entry per section ... */
  ],

  "photo_urls": [
    "https://firebasestorage.googleapis.com/.../photo-1.jpg?alt=media&token=...",
    "https://firebasestorage.googleapis.com/.../photo-2.jpg?alt=media&token=..."
  ],
  "photos": [
    {
      "id":           "ph_1",
      "storage_path": "dcr-photos/acme-dental/abc123-xyz/photo-1.jpg",
      "download_url": "https://firebasestorage.googleapis.com/.../photo-1.jpg?alt=media&token=...",
      "content_type": "image/jpeg",
      "size_bytes":   482910,
      "tag":          "general"
    }
  ],

  "signature_name": "Maria G.",
  "signature_url":  "https://firebasestorage.googleapis.com/.../signature.png?alt=media&token=...",

  "affirmation": {
    "affirmed":       true,
    "affirmed_text":  "I take pride in my work, did my best, and stand by the quality of my cleaning.",
    "signature_name": "Maria G.",
    "signature_url":  "https://firebasestorage.googleapis.com/.../signature.png?alt=media&token=...",
    "signed_at":      "2026-05-10T17:42:17.998Z"
  },

  "feedback": {
    "review_requested":     false,
    "review_link_sent":     false,
    "customer_rating":      null,
    "customer_feedback_id": null
  },
  "review_links": {
    "five_star_url": "",
    "issue_url":     ""
  },

  "submission_meta": {
    "user_agent":          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)...",
    "app_version":         "dcr-hub-web@0.1.0",
    "client_submitted_at": "2026-05-10T17:42:18.221Z",
    "ip_hash":             null,
    "geo":                 null
  },

  "zapier": {
    "attempted":   false,
    "status":      "not_configured",
    "status_code": null,
    "error":       null,
    "sent_at":     null
  },

  "firebase": {
    "project_id":           "pioneer-dcr-hub",
    "firestore_collection": "dcr_submissions",
    "storage_bucket":       "pioneer-dcr-hub.appspot.com"
  }
}
```

**Note on `zapier`:** the value here is always the *pre-send* seed (status:
`"not_configured"`). After the webhook completes, Firestore's `zapier.*`
reflects the real outcome (`sent` / `failed`). Use the Firestore doc — not
the webhook payload — when querying delivery state.

---

## Field reference

| Field                           | Type      | Notes                                                                                            |
|---------------------------------|-----------|--------------------------------------------------------------------------------------------------|
| `submission_id`                 | string    | Sortable client-generated ID; also the Firestore doc ID. Use this as Zap idempotency key.        |
| `schema_version`                | string    | Currently `"dcr.v1"`. Bump only when shape changes.                                              |
| `source`                        | string    | `"web_form"`, `"ghl"`, or `"api"`.                                                               |
| `customer_slug`                 | string    | Stable customer key.                                                                             |
| `customer_name`         | string    | Marketing-cased name, safe to drop in email subject lines.                                       |
| `customer_email`                | string    | Where Zapier should send the DCR email (if `customer_dcr_email_enabled` is `true`).              |
| `customer_dcr_email_enabled`    | bool      | **Branch the Zap on this.** When `false`, skip the customer-facing Gmail step but keep internal Slack / Sheets / GHL paths running. Default `true` when missing. Distinct from `dcr_enabled` (which gates form visibility). |
| `location_name`                 | string    | Per-site label. Falls back to `customer_name` when not set.                              |
| `tech_slug` / `tech_display_name` | string  | Cleaner identity.                                                                                |
| `tech_experience_level`         | string    | `trainee` / `standard` / `lead` / `supervisor`.                                                  |
| `clean_date`                    | string    | `YYYY-MM-DD` in customer time zone.                                                              |
| `submitted_at`                  | string    | ISO 8601 (client clock at submission). For wall-clock receipt time use `firebase.created_at`.    |
| `notes`                         | string    | Free text from the cleaner.                                                                      |
| `occupancy`                     | string    | `empty` / `light` / `normal` / `heavy` / `after-event`.                                          |
| `time_budget.on_budget`         | bool      | `true` when the cleaner stayed inside budgeted minutes.                                          |
| `time_budget.reasons[]`         | string[]  | Reason IDs when `on_budget=false` (see `dcr-form-config.js`).                                    |
| `supply_requests`               | string    | Free text. Empty string when no supplies were requested.                                         |
| `problem`                       | object?   | `null` when no problem reported. Otherwise `{category, summary, details, location, our_fault}`.  |
| `checklist[]`                   | array     | Per-section per-item state. `status` is `done` / `issue` / `na` / `null`. When `status="issue"` the item may include a free-text `note` field. |
| `photo_urls[]`                  | string[]  | **Use this for Gmail.** Flat list of stable Firebase download URLs.                              |
| `photos[]`                      | object[]  | Same URLs with metadata (size, content_type, storage_path).                                      |
| `signature_name`                | string    | Typed name from the affirmation step.                                                            |
| `signature_url`                 | string    | **Use this for Gmail.** Stable Firebase download URL of the handwritten signature PNG.           |
| `affirmation`                   | object    | Full affirmation block; mirrors `signature_*` plus `affirmed`, `affirmed_text`, `signed_at`.     |
| `feedback`               | object    | Phase-2 placeholders for the GHL review-funnel link-back. All defaults until Zapier flips them.  |
| `submission_meta`               | object    | `{user_agent, app_version, client_submitted_at, ip_hash, geo}` — operational fingerprint.        |
| `zapier`                        | object    | Pre-send state at the moment the webhook fires (`status: "not_configured"` here). Authoritative delivery state lives on the Firestore doc. |
| `review_links`                  | object    | `{five_star_url, issue_url}` from the customer record (empty strings until populated).           |
| `firebase`                      | object    | `{project_id, firestore_collection, storage_bucket}` — useful in Zaps that re-read from Firebase.|

---

## Zapier "Catch Hook" setup

### Trigger

1. **App & Event** → **Webhooks by Zapier** → **Catch Hook**.
2. **Set up trigger** → leave the "Pick off a Child Key" field blank.
3. **Test trigger** → Zapier waits for a sample.
4. Submit one real DCR from the form. Zapier shows the captured payload.
5. Confirm the test payload contains `signature_url`, `photo_urls[]`, and
   `customer_name`. If anything is missing, see [Troubleshooting](#troubleshooting).

### Action: Email by Zapier *or* Gmail

The instructions below assume Gmail as the action app. "Email by Zapier" works
the same way — it just doesn't authenticate against a Google account.

1. **App & Event** → **Gmail** → **Send Email**.
2. **Account** → connect / pick the Pioneer outbound mailbox.
3. **Action** field mapping:
   - **To**: `customer_email`
   - **From Name**: `Pioneer Commercial Cleaning`
   - **Reply To**: `customer_email` *(or your support inbox)*
   - **Subject**: `DCR — {{customer_name}} — {{clean_date}}`
   - **Body Type**: `HTML`
   - **Body**: paste the template from the next section.

---

### Branching on `customer_dcr_email_enabled`

**Before** the Gmail "Send Email" action, add a Zapier **Filter** step:

> *Only continue if &nbsp;`customer_dcr_email_enabled`&nbsp; **(Boolean) is true***

This way:

- Customers with `dcr_email_enabled: true` (or missing — defaults to true) get
  the daily DCR email as before.
- Customers with `dcr_email_enabled: false` skip the Gmail step entirely.
- Either way, **the rest of the Zap still runs** — Slack alerts, Sheets logging,
  GHL review flow, OpenAI triage. The opt-out is customer-email-only, not a
  full pipeline kill switch.

If you have separate Zap paths (e.g. one Zap per customer tier), you can also
fan out earlier and only route opt-in customers down the Gmail path.

## Mapping into a Gmail action

In the Gmail body, click each `{{...}}` placeholder and pick the matching field
from the trigger sample.

Quick map:

- `{{photo_url}}` ← any element of `photo_urls[]`
- `{{signature_url}}` ← `signature_url`
- `{{tech_display_name}}` ← `tech_display_name`
- `{{clean_date}}` ← `clean_date`
- `{{notes}}` ← `notes`

For a multi-photo email, Zapier exposes `photo_urls` as an indexed list. Add
one `<img>` block per slot you want to render (Gmail does not support loops in
HTML; you have to enumerate). Three slots is usually enough; extras are
gracefully empty if the cleaner uploaded fewer.

---

## Recommended HTML for photos and signature

Drop this into the Gmail action's **Body** (Body Type = HTML). Tested in Gmail
desktop, Gmail iOS/Android, Outlook web, and iPhone Mail.

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
            max-width:640px; margin:0 auto; color:#14171a; line-height:1.5;">

  <h2 style="color:#0b3d2e; margin:0 0 8px;">Daily Cleaning Report</h2>
  <p style="color:#5d6962; margin:0 0 24px;">
    {{customer_name}} &middot; {{clean_date}}
  </p>

  <p><strong>Cleaner:</strong> {{tech_display_name}}</p>
  <p><strong>Notes:</strong><br />{{notes}}</p>

  <h3 style="color:#0b3d2e; margin:24px 0 8px;">Photos</h3>

  <!-- Repeat as many of these blocks as you want photo slots. -->
  <p>
    <img src="{{photo_url}}"
         alt="DCR photo"
         style="max-width:600px; width:100%; height:auto;
                border-radius:12px; display:block; margin:0 0 12px;" />
  </p>

  <h3 style="color:#0b3d2e; margin:24px 0 8px;">Signature</h3>
  <p>
    <img src="{{signature_url}}"
         alt="Signature — {{signature_name}}"
         style="max-width:220px; height:auto; display:block; margin:0 0 6px;" />
    <span style="color:#5d6962; font-size:13px;">{{signature_name}}</span>
  </p>

  <hr style="border:0; border-top:1px solid #e7e9e2; margin:32px 0 16px;" />
  <p style="color:#8b948c; font-size:12px;">
    Submission ID: {{submission_id}}
  </p>
</div>
```

Why these specific styles:

- `max-width:600px; width:100%; height:auto;` — Outlook desktop's renderer
  ignores `max-width`, so we also set `width:100%` to clamp to the message
  column. The image's intrinsic size limits it once the column is wider.
- `display:block` on the `<img>` — kills the small inline gap iOS Mail adds
  under inline images.
- `border-radius:12px` — Gmail and Apple Mail honor it. Outlook desktop
  silently drops it (acceptable degradation).
- No `width="..."` attribute on the `<img>` — Outlook prefers attribute
  sizing, but since the URL points to the original-resolution photo we'd lose
  retina sharpness. Using only inline CSS gives consistent rendering across
  modern clients with one fallback (Outlook).

---

## Email-rendering test checklist

After wiring the Zap, send one test DCR with **two photos** + a signature, then
verify each client renders inline without a "show images" prompt loop.

- [ ] **Gmail desktop (web)** — both photos render, signature renders, no
      "Display images" banner on subsequent opens.
- [ ] **Gmail iOS** — photos and signature render in the preview pane.
- [ ] **Gmail Android** — photos and signature render.
- [ ] **Outlook.com web** — photos and signature render. Border-radius will be
      square; that's expected.
- [ ] **Outlook desktop (Windows)** — photos and signature render without
      "Click here to download pictures." If blocked, resend (Outlook caches
      blocked-image state aggressively).
- [ ] **iPhone Mail (Apple Mail iOS)** — photos and signature render inline,
      including in the lock-screen preview.

If any client blocks the image:

1. Open the URL in a new browser tab — must be `200 OK` with the image.
2. Confirm the URL contains `?alt=media&token=...`. Without the token, Storage
   returns 403 and the email shows a broken image silently.
3. Confirm the file's `Content-Type` in the Storage console is `image/jpeg` /
   `image/png`. PNG signatures sometimes get uploaded as `application/octet-stream`
   if the source blob isn't typed — the function explicitly sets `image/png`,
   but verify if you see breakage.

---

## Troubleshooting

**`zapier.status === "failed"` on the Firestore doc.**
Read `zapier.error` and `zapier.status_code` on the same doc. Common causes:

- **`HTTP 410`** — Zap is off or has been deleted. Re-enable in Zapier.
- **`HTTP 400`** — Catch Hook trigger expects different fields. Re-run the
  Zapier "Test trigger" step against a fresh DCR submission.
- **`Request timed out after 10000ms`** — Zapier's edge was slow. The Firestore
  doc is intact; Zapier will not retry automatically. Either resubmit the DCR,
  or write a small admin tool that re-POSTs from Firestore.

**`zapier.status === "not_configured"`.**
`functions/.env` is missing the URL or the function hasn't been redeployed
since you added it. Set the var and redeploy `submitDcrV1`.

**Test payload missing `signature_url` or `photo_urls`.**
The DCR was probably submitted from a stale frontend bundle. Hard-reload the
form (`Cmd+Shift+R`) and submit again. The schema additions ride in the same
Hosting deploy as the visual polish.

**Browser shows "Sent to Zapier" but the Zap didn't fire.**
The function got a 2xx response from Zapier but the Zap is paused or
filtered. Check the Zap's "Task History" in Zapier for held / filtered runs.

**Need to retry a failed delivery.**
Open the Firestore doc → copy the saved payload → POST it manually:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d @payload.json \
  "$ZAPIER_DCR_WEBHOOK_URL"
```

(Do not re-call `submitDcrV1` — that would create a duplicate Firestore doc
with a fresh `submission_id`.)
