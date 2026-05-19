# Phase 1 — Pioneer DCR Hub Deployment Checklist

Goal: ship a Firebase-backed intake that produces **stable image URLs** which render
in Gmail and Outlook. This document is the operational runbook for getting from a
fresh checkout to a working production endpoint.

---

## 0. Pre-flight

- [ ] You have access to the GCP/Firebase account that owns the `pioneer-dcr-hub` project.
- [ ] Node 20 and npm are installed locally.
- [ ] Firebase CLI is installed: `npm install -g firebase-tools`.
- [ ] `firebase login` — log in with the account that owns `pioneer-dcr-hub`.

---

## 1. Firebase Console setup

In the [Firebase Console](https://console.firebase.google.com/) for project
**pioneer-dcr-hub**:

### 1.1 Firestore
- [ ] Build → **Firestore Database** → **Create database**.
- [ ] Mode: **Production**.
- [ ] Location: **`nam5` (multi-region: us-central)** — must match this project's stated region.
- [ ] Confirm.

### 1.2 Storage
- [ ] Build → **Storage** → **Get started**.
- [ ] Start in **production mode**.
- [ ] Use the default bucket: `pioneer-dcr-hub.appspot.com`.

### 1.3 Hosting
- [ ] Build → **Hosting** → **Get started** (just to enable the product). The CLI
      will create the actual site on first deploy.

### 1.4 Web app
- [ ] Project Overview → ⚙️ → **Project settings** → **General** → **Your apps**.
- [ ] Click **Add app** → **Web** (`</>`). Nickname: `dcr-hub-web`.
- [ ] **Do not** enable Firebase Hosting from this dialog (we'll wire it via the CLI).
- [ ] Copy the `firebaseConfig` object — you'll paste it in step 2.2.

### 1.5 Functions / Billing
- [ ] Functions v2 requires the **Blaze (pay-as-you-go)** plan. Upgrade if needed.
      Phase 1 traffic stays well within free tier.

---

## 2. Local config

### 2.1 Install function deps
```
cd functions
npm install
cd ..
```

### 2.2 Create real Firebase web config
```
cp public/firebase-config.example.js public/firebase-config.js
```
Edit `public/firebase-config.js`:
- [ ] Paste real values from step 1.4 into `window.FIREBASE_CONFIG`.
- [ ] Leave `window.SUBMIT_DCR_V1_URL` as the placeholder for now — we'll set it after the function deploys (step 3.2).

`public/firebase-config.js` is in `.gitignore`. Do not commit it.

---

## 3. Deploy

> Deploy in this order so the front-end has a real function URL to call.

### 3.1 Deploy rules
```
firebase deploy --only firestore:rules,storage
```
- [ ] `firestore.rules` deploys successfully.
- [ ] `storage.rules` deploys successfully.

### 3.2 Deploy the function
```
firebase deploy --only functions:submitDcrV1
```
- [ ] Note the printed URL, e.g. `https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitDcrV1`.
- [ ] Paste it into `public/firebase-config.js` as `window.SUBMIT_DCR_V1_URL`.

### 3.3 Deploy Hosting
```
firebase deploy --only hosting
```
- [ ] Note the printed Hosting URL, e.g. `https://pioneer-dcr-hub.web.app`.

---

## 4. End-to-end test flow

- [ ] Open the Hosting URL on a phone (the form is mobile-first).
- [ ] Pick a customer + tech, set a clean date, type a name in the affirmation field.
- [ ] Attach 2 photos (one small, one large; both under 10 MB).
- [ ] Tap **Submit DCR**.
- [ ] Status text shows: `DCR submitted. Submission id: …`.
- [ ] Console → Firestore → `dcr_submissions` → confirm the doc exists with:
  - [ ] `schema_version: "dcr.v1"`
  - [ ] `photos[*].storage_path` matches `dcr-photos/{customerSlug}/{submissionId}/photo-{n}.{ext}`
  - [ ] `photos[*].download_url` is a `https://firebasestorage.googleapis.com/...&token=...` URL
  - [ ] `created_at` and `updated_at` are server timestamps.
- [ ] Console → Storage → `dcr-photos/...` → files are present at the expected path.

---

## 5. Email rendering test (the actual Phase 1 success criterion)

For each download URL on the submission, build a tiny HTML email:

```html
<p>Test image:</p>
<img src="HTTPS_DOWNLOAD_URL_HERE" alt="DCR photo" style="max-width: 480px;" />
```

### 5.1 Gmail test
- [ ] Send the test email to a Gmail account.
- [ ] Open it on **Gmail web** — image renders without "Display images" prompt loop.
- [ ] Open it on **Gmail iOS** — image renders.
- [ ] Open it on **Gmail Android** — image renders.

### 5.2 Outlook test
- [ ] Send to an Outlook.com / Microsoft 365 account.
- [ ] Open in **Outlook desktop (Windows)** — image renders without "Click here to download pictures".
- [ ] Open in **Outlook web** — image renders.
- [ ] Open in **Outlook iOS / Android** — image renders.

If any client blocks the image:
- Confirm the URL still works in an incognito browser tab.
- Confirm `download_url` includes `?alt=media&token=...` — without the token, Storage returns 403 and the image breaks silently in email.
- Confirm `Content-Type` on the object is `image/jpeg` / `image/png` (visible in Storage console).

---

## 6. Troubleshooting

**`CORS` error in browser when calling submitDcrV1**
- Confirm `applyCors` ran (check function logs).
- Confirm you're POSTing to the exact URL in `SUBMIT_DCR_V1_URL`, not an old one from a prior deploy.

**`Validation failed` 400 response**
- Open the response body — `details[]` lists every failed field.
- Most common: missing `affirmation.affirmed = true` or wrong `clean_date` format (must be `YYYY-MM-DD`).

**Upload fails with `storage/unauthorized`**
- File is over 10 MB, or `Content-Type` isn't `image/*`.
- Path doesn't match `dcr-photos/{slug}/{id}/{file}` — check `customerSlug` is set before the upload starts.

**Image breaks in Outlook desktop only**
- Outlook caches images aggressively; resend a fresh email rather than reopening an old one.
- Verify the URL contains the `&token=...` query parameter. If not, the file was likely fetched via the `gs://` path or a tokenless preview URL — re-mint with `getDownloadURL()`.

**Function cold starts feel slow**
- Acceptable for Phase 1. If it becomes an issue, set `minInstances: 1` in `setGlobalOptions` (costs ~$5/mo).

**Firestore writes succeed but no doc appears**
- You're probably looking at the wrong Firestore region / database. Confirm the database is the **default** one in `nam5`.

---

## 7. What's intentionally NOT in Phase 1

- No auth on the submit endpoint (locked down by validation + future rate limits).
- No Zapier dispatch (the `delivery` sub-doc is in place, ready for Phase 2).
- No admin dashboard / read API.
- No GHL webhook ingestion (schema is ready; writer comes in Phase 2).

When ready for Phase 2, the natural extension points are:
1. Add an `onDocumentCreated('dcr_submissions/{id}')` trigger that POSTs to Zapier and updates `delivery.zapier_*`.
2. Add a second HTTPS function for the GHL webhook that writes the same shape.
3. Tighten Firestore rules and add admin auth before exposing reads to the front-end.
