# PioneerOps DCR Hub — Internal Pilot Checklist

Last updated for the V6 pilot wrap.

This is the short, runnable checklist for inviting Pioneer team members to
the live PioneerOps DCR pipeline. Walk it top-to-bottom. Every item should
return "yes" before you invite a second tester.

---

## 0. Pre-flight

- [ ] Hosting + functions deployed to `pioneer-dcr-hub` (Firebase project).
- [ ] `OPENAI_API_KEY`, `GMAIL_SENDER_EMAIL`, `GMAIL_SERVICE_ACCOUNT_KEY`,
      `KIRBY_ALERT_EMAIL`, `APRIL_ALERT_EMAIL` secrets are set
      (`firebase functions:secrets:access <NAME>` returns a value).
- [ ] You're signed in to https://pioneer-dcr-hub.web.app/admin.html as an
      allowlisted admin.

---

## 1. Tech invite flow

1. Open **Admin → Cleaning Techs**.
2. Find the tech you want to invite. Confirm they have an `email` set.
3. Button next to **Edit** reads either:
   - **Send invite** — they've never been invited.
   - **Reinvite** — they've been invited at least once.
4. Click the button.
   - **Expected**: green success toast, "Reset email sent to …".
   - **Expected**: the tech's row updates with the new `inviteSentAt`
     timestamp on next refresh.
5. Open Firestore → `cleaning_techs/{slug}`. Verify these fields exist:
   - `inviteSentAt` (timestamp)
   - `inviteSentBy` (admin email who clicked)
   - `inviteEmail` (lowercased recipient)
   - `inviteStatus` = `"sent"`
   - `inviteLastError` = `null`
   - (Legacy `last_invite_sent_at` is also stamped — kept for back-compat.)
6. The tech receives the Firebase password-reset email and follows the link.
7. They set a password, sign in at https://pioneer-dcr-hub.web.app, and
   land on **Today's Work** by default.

**Pass criteria**: tech can open the link, sign in, and reach the tech app.

---

## 2. Tech can only see assigned data

After the tech signs in:

1. They land on **Today's Work** or are redirected to the customer picker
   on `/tech.html`.
2. The customer picker dropdown shows **only customers in their
   `assigned_customer_slugs` array** — nothing else.
3. They open one assigned customer.
   - Page order from top → bottom: **🔐 Security Info** (if any) → 📌
     Important Cleaning Notes → 🗂 Customer SOP → snapshot stats → quality
     → health → open supply → open issues → recent inspections → recent
     feedback (only if any in last 30 d).
4. The "Wins & Recognition" and "Ask for Supply Update" placeholder
   sections do NOT appear during pilot (hidden in V6).

**Pass criteria**: tech sees only assigned customer data, security info is
the first card after the picker.

---

## 3. DCR can be completed once

1. From the tech app, click **DCR** in the role-nav (top).
2. Customer + cleaning tech dropdowns populated.
3. Fill the checklist sections.
4. Tap **Add photos** → file picker opens.
   - **Regression check**: tapping "Add photos" must **NOT** navigate the
     page to Customer Info Hub. URL must stay at `/`.
   - The file picker is the native iOS/Android sheet; pick a photo or
     two. Thumbnails appear in the photo grid.
5. Off-site signature: tap **Clear** to draw, sign with finger, release.
   - Signature pad accepts the stroke; the line appears on the canvas.
6. Tap **Submit DCR**.
   - Photos upload to `dcr-photos/{customerSlug}/{submissionId}/photo-N.ext`.
   - Signature uploads to
     `dcr-signatures/{customerSlug}/{submissionId}/signature.png`.
   - Firestore writes the DCR doc at `dcr_submissions/{id}`.
7. The "Start another DCR" button appears.

**Pass criteria**: DCR submits cleanly; photos + signature both land in
Storage; Firestore doc carries `affirmation.signature_url`,
`photo_urls`, `checklist`, etc.

---

## 4. Admin review + send

1. Admin opens https://pioneer-dcr-hub.web.app/admin.html → **Core Ops →
   Recent DCRs**.
2. The new DCR appears at the top of the list.
3. Click **Review & Send** on its row.
4. Modal opens. Readiness check runs.
   - **Pass state**: All checklist items show ✓. **Send Customer DCR
     Email** button is enabled.
   - **Fail state**: Blockers appear in a red panel (e.g., "no_signature",
     "customer_not_found", "no_recipient"). Send button stays disabled.
5. Click **Send Customer DCR Email**.
6. Modal flips to a green confirmation block with `messageId`, `subject`,
   `emailTemplate: v6`, `promptVersion: v2.8-trust-loop-v5`.
7. Customer (initially **`nick@pioneercomclean.com`** for pilot) receives
   the email. Subject: `Cleaning report for {Customer} · {Date}`.

**Pass criteria**: email lands in the recipient inbox; payload doc at
`dcr_email_payloads/{dcrId}` shows `emailTemplate: "v6"`, `to`, `toList[]`,
`sentAt`, and `gmailMessageId`.

---

## 5. Feedback loop

In the customer's email:

1. **Tell {tech} they did a great job** button opens
   `https://pioneer-dcr-hub.web.app/feedback-compliment.html?dcrId=…&customerId=…&techId=…`.
2. Submit a 5-star compliment. The page shows a green thank-you with the
   tech's name.
3. **Something wasn't quite right** button opens
   `https://pioneer-dcr-hub.web.app/feedback-issue.html?dcrId=…&customerId=…&techId=…`.
4. Submit a low-urgency concern. The page shows a green confirmation.
5. Verify in Firestore:
   - `customer_feedback/{autoId}` — both records present.
   - `quality_wins/{autoId}` — created when compliment rating ≥ 4.
   - `customer_complaints/{autoId}` — created for the concern.
   - `notifications/{autoId}` — one per submission, with correct
     `priority` and `assignedUsers`.

**Pass criteria**: both buttons land on the right pages, submissions
create the right Firestore records, no errors in the browser console.

---

## 6. Verification + rollback

After the live send works:

- [ ] Cloud Functions logs (`firebase functions:log`) show no
      errors during the 5 steps above.
- [ ] If anything misfires:
   1. **Per-customer kill switch**: set
      `customers/{slug}.dcrEmailEnabled = false` in Firestore console.
      The readiness check will block all future sends for that customer.
   2. **Global pause**: temporarily revoke the
      `roles/secretmanager.secretAccessor` permission on the function's
      service account — sends fail closed (no email, Firestore writeback
      records the failure).
   3. **Code rollback**: each `firebase deploy` creates a versioned
      Cloud Run revision at
      `https://console.cloud.google.com/run?project=pioneer-dcr-hub`.
      One-click rollback to the prior revision.
- [ ] `dcr_email_payloads/{dcrId}.html` contains the full rendered HTML
      of every send — pull this to inspect what the customer actually
      received.

---

## Pilot blockers list — must be resolved before second invitee

(Tracked separately during the pilot. Add to this list as they surface.)

- _none open as of this revision_
