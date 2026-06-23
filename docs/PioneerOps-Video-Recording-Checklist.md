# PioneerOps — Video Recording Checklist

**Purpose:** Replace tribal knowledge with a fixed library of short, role-scoped training videos so a new hire can self-onboard from a single playlist.
**Companion doc:** `PioneerOps-Master-Feature-Guide.md`
**Total videos:** 28 (8 Employee · 7 Manager · 7 Admin · 6 Owner)
**Combined runtime:** ~2 h 40 min — designed to be watched once, referenced forever.

---

## Production standards (apply to every video)

- **Resolution:** 1080p minimum; record at native device DPI (iPhone for tech videos, Mac for office videos).
- **Audio:** External mic. No system bell sounds, no Slack pings during record.
- **First 10 seconds:** State your name, the title, the role, and the one thing the viewer will know how to do by the end.
- **Last 15 seconds:** Restate the completion criteria + name the next video in the series.
- **On-screen:** Mouse highlights ON, keystroke overlay ON for any keyboard input, redact any real customer/tech name not already public (use the seeded test customer "Test Account" when possible).
- **Pioneer-native footage:** Always show `https://pioneer-dcr-hub.web.app` — never localhost.
- **No fake data:** If something requires writing to Firestore, use the dedicated test customer + test tech accounts. Never edit a real customer record for demo purposes.
- **Caption file (.srt):** Required on every video. Auto-generate, then hand-correct.
- **Storage:** Loom workspace `PioneerOps Training` → folder per role.

---

## Employee track (cleaning tech)

### E1 — Day-1 setup: sign in and install PioneerOps
- **Title:** "Day 1: Get into PioneerOps and put it on your phone"
- **Goal:** New tech opens the password-reset email, signs in once, installs the PWA, and never has to type the URL again.
- **Runtime:** 4–5 minutes
- **Screens / pages to show:**
  - Gmail invite email from Pioneer Commercial Cleaning
  - Firebase password-reset page (with the new `actionCodeSettings` continue URL)
  - `/login.html` post-reset landing
  - `/team-hub.html` → Install PioneerOps card → iOS install modal (3 steps)
  - Home-screen icon → relaunch in standalone mode
- **Script outline:**
  1. "You'll get an email titled 'Set up your Pioneer login'. Tap the blue button."
  2. Show the password-set screen. Set the password. Tap continue.
  3. Land back on `/login.html`. Sign in with the new password (NOT Google for the first time — make sure email/password works).
  4. Land on `/team-hub.html`. Scroll to the **Install PioneerOps** card.
  5. Walk the iOS modal: Share → Add to Home Screen → Add. Show the new icon.
  6. **Close Safari completely.** Open from the home screen. Demonstrate that the address bar is gone — that's how you know it's installed correctly.
- **Common mistakes to demonstrate:**
  - Trying to use Google sign-in the first time before the password is set (skip to the "Forgot password" path).
  - Dismissing the install card by accident with "Maybe Later" → show how it suppresses for 30 days and how to recover (clear `localStorage.pioneerops_install_dismissed_at` from Settings if absolutely needed, but normally just wait it out).
  - Installing from Chrome on iPhone (wrong) instead of Safari.
- **Completion criteria:** PioneerOps icon on home screen, standalone launch, signed-in state shown on Team Hub.

---

### E2 — The golden path: Start Work → DCR → Finish Work
- **Title:** "Your nightly shift in PioneerOps (the only video you must memorize)"
- **Goal:** Tech can execute a full shift without thinking — Start in PioneerOps, clock in Deputy, complete DCR, finish in PioneerOps, clock out Deputy.
- **Runtime:** 7–8 minutes
- **Screens / pages to show:**
  - `/team-hub.html` nav
  - `/work.html` Today's Work card
  - Clock In Reminder bottom card → Deputy app (briefly)
  - `/index.html` DCR form with assigned-shift summary
  - Checklist auto-collapse + scroll-to-next-incomplete behavior
  - Photo upload, signature pad, submit
  - Golden-path success screen
  - `/work.html?finishSession=…` auto-finish toast + clock-out reminder
- **Script outline:**
  1. Open from home screen → Today's Work in nav.
  2. Find tonight's shift card. Read it out loud (customer, time, address).
  3. Tap **Start Work**. Show the Clock In Reminder card. Tap **Open Deputy App**, clock in, return to PioneerOps.
  4. Tap **Complete DCR** from the same card. The DCR opens with the assigned-shift summary already populated.
  5. Walk every section: Bathrooms, General Areas, Kitchens, Offices, Entryways, custom. Show auto-collapse.
  6. Add at least one photo + sign on the signature pad.
  7. Submit. Confetti + chime. Read the success message.
  8. Tap **Finish Work in PioneerOps**. The app jumps to `/work.html`, the session closes automatically, the green toast appears.
  9. Tap **Open Deputy App** from the clock-out reminder. Clock out.
- **Common mistakes to demonstrate:**
  - Submitting the DCR before signing → show the validation error.
  - Forgetting to clock into Deputy → show that PioneerOps doesn't block you, but warn that payroll will be wrong.
  - Closing the browser between Start Work and Complete DCR → show that the session is still open and you can resume from Today's Work.
  - Trying to finish a shift you didn't start → show the empty Today's Work state.
- **Completion criteria:** New tech can recite the five Start → Deputy → DCR → Finish → Deputy steps in order without looking.

---

### E3 — Before you drive: Customer Info Hub + Supply Station
- **Title:** "Get the gate code, the SOP, and order supplies — all before you leave home"
- **Goal:** Tech can prep for every shift from one app, eliminating the "text Kirby for the alarm code" loop.
- **Runtime:** 4 minutes
- **Screens / pages to show:**
  - `/tech.html` — customer picker filtered to assigned customers
  - Quick Glance + SOP body + last 5-star inspection
  - Security Modal (gate code + alarm code)
  - `/supply-station.html` — order form + Access Card
- **Script outline:**
  1. From Team Hub, tap Customer Info Hub. Show that only YOUR assigned customers appear.
  2. Pick the customer you're cleaning tonight. Read the Quick Glance bullets.
  3. Scroll to the SOP. Read it.
  4. Tap **Security** → unlock the gate code + alarm code.
  5. Switch to Supply Station. Show the Access Card again (gate + lock codes) and place a sample order ("Need three rolls of paper towels for Test Account").
- **Common mistakes to demonstrate:**
  - Looking for a customer NOT in your assigned list and being confused — explain that the office controls assignments.
  - Sharing gate codes over text — show that the codes live in the app so you never need to.
- **Completion criteria:** Tech opens the Customer Info Hub, reads an SOP aloud, unlocks the Security Modal, and submits a supply order in under 60 seconds.

---

### E4 — Team Hub tour + Team Schedule
- **Title:** "What's on Team Hub and how to read the schedule"
- **Goal:** Tech knows every card on the landing page and can find any shift in the next 21 days.
- **Runtime:** 4 minutes
- **Screens / pages to show:**
  - `/team-hub.html` — Announcements, Install card, Pioneer Quality, Requests & Support grid, Schedule preview
  - `/team-schedule.html` — Assignments, List, Coverage views; filter pills; time-off overlay
- **Script outline:**
  1. Walk top-to-bottom on Team Hub: 📣 Announcements (with Acknowledge button), 🌟 Pioneer Quality, schedule preview, Requests & Support grid.
  2. Tap into Team Schedule. Switch between Assignments / List / Coverage.
  3. Toggle "Mine only" filter. Toggle "Show scheduled time off."
  4. Explain that the schedule is published from Deputy by the office — if a shift is missing, contact April.
- **Common mistakes to demonstrate:**
  - Tapping into someone else's shift and trying to Start Work from there (you can't — server checks email).
  - Mistaking the schedule for Deputy itself (Deputy remains the official time clock).
- **Completion criteria:** Tech can switch between all three schedule views and filter to themselves.

---

### E5 — Call Out, Time Off, Open Shifts
- **Title:** "When you can't make it — or when you want extra hours"
- **Goal:** Tech can request time off cleanly, call out same-day without phone tag, and pick up extra shifts for the $25 Rockstar bonus.
- **Runtime:** 5 minutes
- **Screens / pages to show:**
  - `/call-out.html`
  - `/time-off.html`
  - `/open-shifts.html` — Accept button + Rockstar messaging
- **Script outline:**
  1. **Call Out:** open `/call-out.html`. Walk the form. Submit. Explain that April and Kirby get an email immediately.
  2. **Time Off:** open `/time-off.html`. Submit a request 2 weeks out. Explain the approval workflow and how it shows up on the Team Schedule coverage overlay.
  3. **Open Shifts:** open `/open-shifts.html`. Tap Accept on a demo shift. Explain the $25 Rockstar bonus and that admin must confirm coverage before the bonus posts.
- **Common mistakes to demonstrate:**
  - Texting April instead of using Call Out (no paper trail).
  - Submitting Time Off the day before (it's the *planned* PTO form; same-day is Call Out).
  - Accepting an open shift you can't actually cover — bonus only posts after admin confirms.
- **Completion criteria:** Tech submits one Call Out, one Time Off, and accepts one Open Shift in the test environment.

---

### E6 — Safety: SOS and Need Help Now
- **Title:** "If something goes wrong tonight — your two safety paths"
- **Goal:** Tech can distinguish "I need help" from "this is an emergency" and uses the right path under stress.
- **Runtime:** 5 minutes
- **Screens / pages to show:**
  - 🚨 SOS pill (top-right) on `/work.html`, `/`, `/tech.html`, `/team-hub.html`
  - Step 1 "Are you safe?" → Help-needed sheet → Emergency sheet with [Call 911] [Call April]
  - Confirmation step with persistent tel: and sms: anchors
  - Team Hub → Need Help Now? card → Call April / Text April action sheet
  - Admin → SOS Events tab (briefly, for context — admin will resolve)
- **Script outline:**
  1. Open Team Hub. Point at the red **🚨 SOS** pill top-right. "This is for safety. Not for missing supplies."
  2. Tap it → "Are you safe?" → demo the **Yes, but I need help** path (locked out, alarm misbehaving). Type a description. Send. Read the confirmation aloud.
  3. Reopen. This time tap **No, this is an emergency**. Point at the EQUAL prominence of [Call 911] and [Call April]. **Say clearly: "Call 911 first if anyone is hurt."**
  4. Show the optional "Also send Pioneer SOS Alert" checkbox.
  5. **Honesty note:** Twilio SMS is currently pending. The confirmation says "Alert saved. Please call April now." with persistent buttons. The buttons always work.
  6. Switch to Team Hub → Need Help Now card. "Use this for non-safety urgent: locked out, supplies missing, vehicle issue."
- **Common mistakes to demonstrate:**
  - Using SOS for low supplies (use Need Help Now instead).
  - Tapping Send Pioneer SOS Alert and assuming someone called 911 for you — they didn't. Always call 911 yourself.
  - Texting April directly when you're injured (use SOS so there's an audit trail).
- **Completion criteria:** Tech demonstrates both flows in the test environment AND verbalizes the rule: **emergency = call 911 first, then SOS**.

---

### E7 — Announcements + Help Improve Pioneer
- **Title:** "How we communicate with you — and how you communicate back"
- **Goal:** Tech reads and acknowledges announcements correctly, knows when a mandatory modal will block them, and uses Help Improve Pioneer instead of Slack venting.
- **Runtime:** 4 minutes
- **Screens / pages to show:**
  - Team Hub → 📣 Announcements section with Acknowledge / Reply buttons + inline thread
  - Mandatory blocking modal (force one for demo)
  - `/improve.html` — Standard mode + Protected concern mode (the toggle)
- **Script outline:**
  1. From Team Hub, scroll to Announcements. Show a normal announcement with Reply.
  2. Show one with a required Acknowledge — tap Acknowledge. Note the green status pill update.
  3. Trigger a mandatory blocking modal (have an admin send one). Show that you can't dismiss it without Mark as Read.
  4. Open `/improve.html`. Walk the **Standard improvement** form: problem → why it matters → what would improve it. Optional category + photos.
  5. Switch to **Protected concern** mode. Note the anonymous toggle. Submit a demo concern.
- **Common mistakes to demonstrate:**
  - Slack-venting instead of submitting Improve (no audit, no follow-up).
  - Marking mandatory acknowledgements without reading.
  - Using Protected Concern for a standard idea (mixes the queue and slows triage).
- **Completion criteria:** Tech acknowledges an announcement, replies in a thread, submits one Standard improvement.

---

### E8 — Common pitfalls and FAQ
- **Title:** "10 things that trip up brand-new techs"
- **Goal:** Pre-empt the support questions Kirby and April get every week.
- **Runtime:** 6 minutes
- **Screens / pages to show:** Compilation — mostly Team Hub + Today's Work + DCR form
- **Script outline (one mistake per ~30 sec):**
  1. "I clicked Start Work but didn't clock in." → Two systems, two clicks.
  2. "I can't see tonight's shift." → Office hasn't synced Deputy yet, or you're assigned to a different customer.
  3. "My DCR won't submit." → Missing signature or photos.
  4. "I forgot to Finish Work." → Open Today's Work tomorrow, the session is still there.
  5. "The address bar is showing — am I not installed?" → Reinstall via Team Hub card.
  6. "I'm signed out every time I open the app." → Force-quit Safari background; re-install standalone.
  7. "I tapped SOS by accident." → Cancel button is always present; nothing was sent.
  8. "Customer not in dropdown." → Office needs to add you to assigned_customer_slugs.
  9. "Gate code changed." → SOP > Security shows the latest; if wrong, message admin via Improve.
  10. "Photo upload failed." → Check signal, then retry. The form holds your work.
- **Common mistakes to demonstrate:** All of the above.
- **Completion criteria:** Tech watches once; future questions get answered by "rewatch E8 mistake N."

---

## Manager track (April-replacement)

### M1 — Morning recap: reading Yesterday's Work
- **Title:** "Your 5-minute morning routine on PioneerOps"
- **Goal:** Manager can spot every issue from last night before the first coffee.
- **Runtime:** 6 minutes
- **Screens / pages to show:**
  - Admin → Core Ops → Yesterday's Work
  - Date picker + Pacific 4pm cutoff explained
  - Top stat strip (8 metrics)
  - Per-tech rollups + traffic light statuses
  - Unmatched DCRs + Unmatched shifts sections
  - Customer report view-count chip
- **Script outline:**
  1. Open Admin → Yesterday's Work. Confirm the date.
  2. Walk the 8 top stats. Explain what each means.
  3. Scan the per-tech rollup. Stop on the first RED row. Click View DCR. Click Customer report ↗.
  4. Scroll to Unmatched DCRs. Explain: DCR submitted but no Deputy shift to attach to → call the tech.
  5. Scroll to Unmatched shifts. Explain: Deputy shift but no DCR → the work might not have been documented.
  6. Wrap: "If everything is green, you are done. Move on."
- **Common mistakes to demonstrate:**
  - Coloring a RED row by hand (it's auto from data — fix the data, not the panel).
  - Trusting `zapier.status` (deprecated — ignore).
  - Reading the wrong date because the picker defaults to today, not yesterday.
- **Completion criteria:** Manager loads Yesterday's Work, identifies one RED row, and opens both the DCR and customer report in under 90 seconds.

---

### M2 — SOS Events triage
- **Title:** "When the SOS badge lights up"
- **Goal:** Manager treats SOS like a fire alarm — answered within 60 seconds, resolved with notes.
- **Runtime:** 4 minutes
- **Screens / pages to show:** Admin → System → SOS Events
- **Script outline:**
  1. Show the tab badge counting open events.
  2. Open an event. Read it aloud. Click 📌 Open in Maps if geolocation present.
  3. Tap [Call April] or [911] inline. Walk through the SMS notification chips (who got it, who didn't).
  4. Type resolution notes (required) → Mark resolved.
  5. Show the card greying out + badge decrementing.
- **Common mistakes to demonstrate:**
  - Resolving without notes (rule blocks it; show the error).
  - Ignoring the tab and only reading email (badge is the source of truth).
- **Completion criteria:** Manager resolves a test SOS event with required notes and confirms the badge decrements.

---

### M3 — Issues, Supply Requests, Improvements triage
- **Title:** "Working through the Quality tabs"
- **Goal:** Manager can clear every Quality-tab badge in one daily pass.
- **Runtime:** 7 minutes
- **Screens / pages to show:**
  - Admin → Quality → Issues
  - Admin → Core Ops → Supply Requests
  - Admin → Quality → Improvements
- **Script outline:**
  1. **Issues:** open the tab. Filter to "new". Walk a status transition: new → reviewed → customer_contacted → resolved. Add an admin note. Show the tech-facing card does NOT show your admin note.
  2. **Supply Requests:** fulfill a demo request. Mark as ordered, then delivered.
  3. **Improvements:** open the Improvements tab. Walk Standard mode triage (status workflow). Reply in-thread as admin — show the teal admin chip. Switch the filter pill to Protected concern. **Explain the elevated handling protocol.**
- **Common mistakes to demonstrate:**
  - Replying in-thread with a sensitive comment intended for internal notes only → use Admin Notes instead.
  - Resolving an Issue without contacting the customer first.
  - Letting Protected concerns sit — they should be triaged within 24 hours.
- **Completion criteria:** Manager clears one of each (issue, supply request, improvement) end-to-end.

---

### M4 — Customer Notes + Note Suggestions
- **Title:** "Keeping institutional knowledge alive"
- **Goal:** Manager can author a customer note + approve a tech-submitted suggestion in under 2 minutes.
- **Runtime:** 3 minutes
- **Screens / pages to show:**
  - Admin → Quality → Customer Notes
  - Admin → Quality → Note Suggestions
- **Script outline:**
  1. Add a new note to the test customer ("Side door locks at 9pm — use front entrance after").
  2. Switch to Note Suggestions. Open a suggestion from a tech. Approve → it shows up on Customer Notes.
  3. Show how the notes surface on `/tech.html` Customer Info Hub.
- **Common mistakes to demonstrate:**
  - Authoring duplicate notes (search first).
  - Approving without editing for clarity.
- **Completion criteria:** One note authored, one suggestion approved, both visible on the tech-facing surface.

---

### M5 — Sending Announcements (incl. targeted + mandatory)
- **Title:** "Announcements: all-staff, selected, and mandatory"
- **Goal:** Manager can pick the right audience and the right urgency without spamming the whole team.
- **Runtime:** 6 minutes
- **Screens / pages to show:** Admin → System → Announcements
- **Script outline:**
  1. **All-staff normal:** create a weekly reminder. Send. Show it on Team Hub.
  2. **Selected, normal:** create an announcement for 3 picked techs (use the searchable picker with avatars). Note that only those 3 see it.
  3. **All-staff with Require Acknowledgement:** create a policy update. Send. From a tech account, show the Acknowledge button.
  4. **All-staff with Require Reply:** create a "Confirm you'll attend tomorrow's huddle." Show the reply thread filling up.
  5. **Mandatory blocking modal:** mark Important + Require Ack. From a tech account, show the blocking modal on next page load.
  6. **Admin thread replies:** post a reply with the teal admin chip.
- **Common mistakes to demonstrate:**
  - Sending mandatory to everyone for something that only matters to two techs (audience targeting exists — use it).
  - Confusing Require Ack with Require Reply.
  - Forgetting to set audience and broadcasting an internal-only announcement.
- **Completion criteria:** Manager sends all 5 announcement variants in the test environment.

---

### M6 — Weekly schedule sync from Deputy
- **Title:** "The one-button schedule publish"
- **Goal:** Manager runs the Sync next 21 days flow every Sunday in under 90 seconds.
- **Runtime:** 3 minutes
- **Screens / pages to show:**
  - Admin → System → Schedule
  - Sync next 21 days primary button
  - Per-day breakdown disclosure
  - Team Schedule view-after link
  - Advanced backup section (PDF + manual paste) — briefly
- **Script outline:**
  1. Open Admin → System → Schedule.
  2. Tap **Sync next 21 days from Deputy**. Wait for the success card.
  3. Expand the per-day breakdown. Confirm no surprise zero-shift days.
  4. Tap **View Team Schedule ↗**. Confirm the schedule is published with correct customer display names.
  5. Mention the Advanced backup section exists for emergencies (PDF + paste) but should never be the primary path.
- **Common mistakes to demonstrate:**
  - Using the PDF upload as the default (it's the backup, not the primary).
  - Syncing while Deputy is in the middle of edits (do it after the schedule is finalized).
- **Completion criteria:** One full sync executed; per-day counts match Deputy.

---

### M7 — Attendance approvals (Call Out · Time Off · Open Shifts · Rockstar)
- **Title:** "Approving requests + paying out the Rockstar bonus"
- **Goal:** Manager can clear the Attendance tab daily and trigger the $25 Rockstar payout cleanly.
- **Runtime:** 5 minutes
- **Screens / pages to show:** Admin → System → Attendance (4 sub-panels)
- **Script outline:**
  1. **Call Outs:** read one, mark acknowledged.
  2. **Time Off:** approve / decline a request. Note the email back to the tech.
  3. **Open Shifts:** create an open shift for tonight. From a tech account, accept it.
  4. **Confirm coverage** on the accepted shift → trigger the $25 Rockstar bonus. Show the `rockstar_bonuses` doc in admin view.
  5. Open the **Calendar** sub-panel. Show how all four flows overlay.
- **Common mistakes to demonstrate:**
  - Confirming Rockstar coverage before the tech actually accepted (you'll pay for nothing).
  - Approving Time Off without checking the coverage calendar first.
  - Declining a Call Out (no — call outs are reports, not requests; never decline).
- **Completion criteria:** One of each (Call Out, Time Off, Open Shift accept + Rockstar confirm) end-to-end.

---

## Admin track (Kirby-replacement)

### A1 — Adding a new customer
- **Title:** "Onboarding a new customer cleanly"
- **Goal:** Admin can stand up a new customer with email recipients, SOP, gate/alarm codes, and display name in under 10 minutes.
- **Runtime:** 8 minutes
- **Screens / pages to show:** Admin → Core Ops → Customers → +New
- **Script outline:**
  1. +New. Required: slug (URL-safe), customer_name, primary email.
  2. **DCR email config:** `dcrEmailEnabled: true`, `dcrEmailRecipients: [{email, name?}]`. Add 2 recipients to demonstrate multi-recipient.
  3. SOP fields: 3 Quick Glance bullets, full instructions markdown.
  4. **Customer secure (gate + alarm):** save into the Security Modal. Confirm field techs can't see this directly in Firestore.
  5. **Display name:** demo `displayNameMode: "customAlias"` + `customDisplayName: "Willow & Branch"`. Show how it propagates to the DCR dropdown + customer email.
  6. Assign 2 techs via the customer's reverse linkage.
  7. Run Pilot Readiness Check on those techs to confirm green.
- **Common mistakes to demonstrate:**
  - Forgetting `dcrEmailRecipients` (server will refuse to send → silent customer).
  - Using a slug with spaces or capitals (must be URL-safe).
  - Setting `displayNameMode: "locationName"` but leaving `location_name` blank (renders as slug).
- **Completion criteria:** Test customer created, Pilot Readiness Check returns PASS for assigned techs, DCR dropdown shows the display name.

---

### A2 — Onboarding a new cleaning tech
- **Title:** "Inviting a new tech the right way"
- **Goal:** Admin can invite a tech, upload photo + signature, assign customers, and confirm via Pilot Readiness — in under 8 minutes.
- **Runtime:** 7 minutes
- **Screens / pages to show:** Admin → Core Ops → Cleaning Techs → +New
- **Script outline:**
  1. +New. Required: display_name, email, tech_slug.
  2. **Photo upload (`photoUrl`)** — required for the trust block on customer email.
  3. **Signature upload (`signatureUrl`)** — required for the signed-receipt block.
  4. Set `assigned_customer_slugs` (controls DCR dropdown + Customer Info Hub).
  5. Save. Server creates the Firebase Auth user and sends a password reset.
  6. Open Pilot Readiness Check on the new tech. Walk through each category. Confirm PASS overall.
- **Common mistakes to demonstrate:**
  - Skipping photo or signature (DCR email won't look right).
  - Wrong email (must match Deputy's email exactly for Today's Work to find their shifts).
  - Forgetting to assign customers (DCR dropdown will be empty).
- **Completion criteria:** New test tech created, email received, signs in, sees assigned customers in DCR + Customer Info Hub.

---

### A3 — Archiving a departing tech
- **Title:** "Revoking access when a tech leaves"
- **Goal:** Admin can offboard a tech with full security in under 60 seconds, preserving all historical records.
- **Runtime:** 4 minutes
- **Screens / pages to show:** Admin → Cleaning Techs → More → Archive
- **Script outline:**
  1. Open the tech's row → More → Archive.
  2. Read the 4-bullet confirmation modal aloud.
  3. Confirm. Show the toast "Team member archived and PioneerOps access removed."
  4. Switch to the archived tech's account (test tech). Try to sign in → blocked / refresh token revoked.
  5. Try to write a DCR via Firestore directly → rule denies.
  6. Show their historical DCRs still readable in admin.
- **Common mistakes to demonstrate:**
  - Deleting the cleaning_techs doc instead of archiving (you lose history).
  - Forgetting that there are 3 security layers — explain all three so admin trusts the flow.
- **Completion criteria:** Archived tech cannot sign in, cannot write to Firestore, but their historical DCRs remain intact.

---

### A4 — Manual DCR customer email send
- **Title:** "Resending a DCR email when something goes wrong"
- **Goal:** Admin can manually send a customer DCR email, verify delivery, and reset readiness blockers.
- **Runtime:** 5 minutes
- **Screens / pages to show:**
  - Admin → Core Ops → Recent DCRs
  - Per-row send action gated by `getDcrEmailReadinessV1`
  - Email payload audit doc (briefly)
- **Script outline:**
  1. Find a DCR. Click "Send customer email."
  2. If the readiness check fails — walk through the gate (missing recipient, no signature, no photos, customer opt-out). Fix each blocker.
  3. Send. Show the audit fields written back to the DCR doc.
  4. Receive on a test customer email account. Show the tokenized "View full report" link → customer report page.
- **Common mistakes to demonstrate:**
  - Sending without setting customer recipients first.
  - Sending to a customer who has `dcrEmailEnabled: false` (gate stops you — for a reason).
- **Completion criteria:** Manual send succeeds; audit fields populated; tokenized report opens.

---

### A5 — Running Pilot Readiness Check
- **Title:** "The pre-rollout audit"
- **Goal:** Admin can run the readiness sweep on every active tech and resolve any FAILs before pilot day.
- **Runtime:** 5 minutes
- **Screens / pages to show:**
  - Admin → System → Pilot Readiness
  - CLI version: `node scripts/pilot-readiness-check.js` (terminal)
- **Script outline:**
  1. Open the panel. Tap Run.
  2. Walk the categories: Firebase Auth, tech record, Deputy mapping (next 7 days), permission preconditions, customer mapping, pending announcements, mobile-safety manual note.
  3. Stop on a WARN. Resolve it.
  4. Stop on a FAIL. Resolve it.
  5. Re-run. Get all green.
  6. Show the CLI version → exits 1 on any FAIL (useful for CI / pre-pilot-day gates).
- **Common mistakes to demonstrate:**
  - Reading PASS at the tech level and ignoring a WARN at the category level.
  - Treating "no Deputy shifts in next 7 days" as a FAIL (it's a WARN — could be legit time off).
- **Completion criteria:** Full roster runs green or every red is documented with a reason.

---

### A6 — Deputy mapping + connection health
- **Title:** "When Deputy and PioneerOps disagree"
- **Goal:** Admin can spot Deputy mapping issues, refresh connection, and fix unmapped people.
- **Runtime:** 5 minutes
- **Screens / pages to show:** Admin → System → Deputy
- **Script outline:**
  1. Open the panel. Show the Connection Health stat tile.
  2. Tap Refresh. Wait for green.
  3. Open the Unmapped Deputy people list. Pick one. Map their email/slug to the Pioneer `cleaning_techs` doc.
  4. Re-sync the schedule from Schedule panel. Confirm their shifts now appear in Today's Work.
- **Common mistakes to demonstrate:**
  - Letting an unmapped person sit for a week (their shifts never show up; tech blames the app).
  - Mapping to the wrong tech slug (they see someone else's shifts).
- **Completion criteria:** Unmapped count goes to zero; previously orphaned shifts now appear correctly.

---

### A7 — Customer display name management
- **Title:** "Renaming customers without breaking history"
- **Goal:** Admin understands the three display modes and the render-time fallback, and can rebrand a customer in 30 seconds without losing historical data.
- **Runtime:** 4 minutes
- **Screens / pages to show:**
  - Admin → Customers → edit display config
  - DCR form dropdown
  - Today's Work shift card
  - Customer report header
- **Script outline:**
  1. Open a test customer. Walk the three modes:
     - `customerName` (default) → uses `customer_name`.
     - `locationName` → uses `location_name`.
     - `customAlias` → uses `customDisplayName`.
  2. Save the change. Show the new display name on:
     - DCR dropdown
     - Today's Work card
     - Team Schedule
     - Customer DCR email
     - Customer report page
  3. Explain that slug NEVER changes — the slug is the canonical key forever.
- **Common mistakes to demonstrate:**
  - Editing the slug to "rename" (don't — change the display fields).
  - Setting `customAlias` mode but forgetting to set `customDisplayName` (renders the slug as a last resort).
- **Completion criteria:** Display name changes propagate to all 5 surfaces immediately without a re-publish.

---

## Owner track (super admin / Nick)

### O1 — The hardcoded admin allowlist
- **Title:** "When to edit the 4-email allowlist (and when not to)"
- **Goal:** Owner understands the 3-file allowlist + when to use it vs. the in-app Admins panel.
- **Runtime:** 4 minutes
- **Screens / pages to show:**
  - `firestore.rules` (`isPioneerAdmin()`)
  - `functions/index.js` (`ALLOWED_ADMIN_EMAILS`)
  - `public/admin.js` (admin-email check)
  - Admin → System → Admins (for the runtime path)
- **Script outline:**
  1. Show the 3 file locations of the hardcoded allowlist.
  2. Rule of thumb: **runtime path = Admins panel.** Hardcoded path = senior trusted ops only.
  3. Demo adding a 5th senior admin: edit all 3 files → deploy rules → deploy function → deploy hosting.
  4. Show the Admins panel runtime add for everyone else.
- **Common mistakes to demonstrate:**
  - Editing only the rules file and not the function (admin can read but can't call functions).
  - Adding to the in-app Admins panel for someone who should also be hardcoded (split allowlists drift).
- **Completion criteria:** Owner can recite the 3 file paths from memory and explain when to use which path.

---

### O2 — Twilio secret rotation (SOS SMS)
- **Title:** "Wiring up SOS SMS fan-out"
- **Goal:** Owner can provision Twilio so SOS messages actually fan out, replacing the current honest-fallback copy.
- **Runtime:** 5 minutes
- **Screens / pages to show:**
  - Terminal: `firebase functions:secrets:set`
  - Twilio console (briefly — Account SID, Auth Token, Messaging Service / From number)
  - Admin → SOS Events after deploy
- **Script outline:**
  1. Set 3 secrets:
     ```
     firebase functions:secrets:set TWILIO_ACCOUNT_SID --project pioneer-dcr-hub
     firebase functions:secrets:set TWILIO_AUTH_TOKEN  --project pioneer-dcr-hub
     firebase functions:secrets:set TWILIO_FROM_NUMBER --project pioneer-dcr-hub
     ```
  2. Deploy: `firebase deploy --only functions:onEmergencyCreatedV1 --project pioneer-dcr-hub`.
  3. From a test tech, fire an SOS. Confirm Twilio dashboard shows outbound SMS to April / Kirby / Nick.
  4. Confirm the confirmation copy switched from "Alert saved. Please call April now." to "Alert sent. April and Kirby have been texted."
- **Common mistakes to demonstrate:**
  - Setting the secret but forgetting to redeploy the function (still empty at runtime).
  - Using a number without SMS capability.
- **Completion criteria:** Test SOS event delivers SMS to all 3 emergency contacts; confirmation copy reflects success.

---

### O3 — Deputy OAuth setup
- **Title:** "Connecting Pioneer to Deputy without sharing a password"
- **Goal:** Owner can complete the Deputy OAuth round-trip + know when to fall back to the manual token path.
- **Runtime:** 6 minutes
- **Screens / pages to show:**
  - Deputy developer console (briefly)
  - Terminal: `firebase functions:secrets:set` for Deputy secrets
  - `deputyOAuthStartV1` URL → browser auth → callback
  - Manual token path (fallback)
- **Script outline:**
  1. Walk the secret names: `DEPUTY_CLIENT_ID`, `DEPUTY_CLIENT_SECRET`, `DEPUTY_INSTALL_URL`, `DEPUTY_ACCESS_TOKEN`.
  2. Round-trip OAuth: hit `deputyOAuthStartV1` → Deputy authorizes → callback writes the token.
  3. Show the manual path: paste `DEPUTY_ACCESS_TOKEN` directly (simplest pilot path).
  4. Force a sync (`syncDeputyShiftsV1` or `refreshDeputyShiftsRangeV1`). Confirm `deputy_shift_cache` populates.
- **Common mistakes to demonstrate:**
  - Mixing OAuth-managed token with manually-pasted one (last write wins; mark which you're using).
  - Forgetting to whitelist the callback URL in Deputy.
- **Completion criteria:** `deputy_shift_cache` populates after sync; Today's Work loads shifts.

---

### O4 — Emergency contacts configuration
- **Title:** "Who gets the 911-adjacent text"
- **Goal:** Owner can configure and rotate emergency contact phone numbers in Firestore without code.
- **Runtime:** 3 minutes
- **Screens / pages to show:** Firebase Console → Firestore → `pioneer_config/emergency_contacts`
- **Script outline:**
  1. Open `pioneer_config/emergency_contacts`. Show the doc:
     ```json
     {
       "april": "+15098283335",
       "kirby": "+1...",
       "nick": "+1..."
     }
     ```
  2. Rotate Kirby's number to a new value. Fire a test SOS → confirm the SMS lands.
  3. Explain the hardcoded fallback (+15098283335 for April) — used when the doc is missing entirely.
- **Common mistakes to demonstrate:**
  - Using a non-E.164 format (must start with `+1` + 10 digits).
  - Deleting the doc to "reset" (use the hardcoded fallback only as a true emergency floor).
- **Completion criteria:** Updated phone receives the next test SOS SMS.

---

### O5 — Customer DCR email opt-outs
- **Title:** "When a customer says 'stop emailing me'"
- **Goal:** Owner can opt a customer out cleanly across both schema fields and confirm the readiness gate respects it.
- **Runtime:** 3 minutes
- **Screens / pages to show:**
  - Admin → Customers → edit
  - Firebase Console → customer doc
  - Manual DCR email attempt → blocked
- **Script outline:**
  1. Open the customer. Toggle off DCR email (UI sets `dcrEmailEnabled: false`).
  2. **Important:** also set `dcr_email_enabled: false` (legacy snake_case) — both fields are checked by the readiness gate.
  3. Try a manual send from Recent DCRs. The readiness gate blocks it with a clear reason.
  4. Explain when to re-enable + the audit fields written if you do.
- **Common mistakes to demonstrate:**
  - Setting only the camelCase field (legacy code paths may still send).
  - Deleting the customer to opt them out (don't — opt-out flag is the clean path).
- **Completion criteria:** Customer opted out; manual send attempt is rejected at the gate; no future auto-send.

---

### O6 — Operational CLI scripts (pilot readiness, manual DCR, tech auth, fixtures)
- **Title:** "The Pioneer admin CLI toolkit"
- **Goal:** Owner can run every operational script from the terminal during an incident.
- **Runtime:** 6 minutes
- **Screens / pages to show:** Terminal in `scripts/` directory
- **Script outline:**
  1. `node scripts/pilot-readiness-check.js` — full roster.
  2. `node scripts/pilot-readiness-check.js --tech makaila-b --json` — single-tech, machine-readable.
  3. `node scripts/send-dcr-email.js --dcr <submission_id> --test nick@pioneercomclean.com` — test send to yourself first.
  4. `node scripts/send-dcr-email.js --dcr <submission_id> --customer --reason "Legacy delivery failed"` — real send with audit reason.
  5. `node scripts/check-tech-auth.js --tech <slug>` — diagnostic when a tech says "I can't sign in."
  6. `node scripts/seed-tech-health-test.js` → `cleanup-tech-health-test.js` — fixture lifecycle.
- **Common mistakes to demonstrate:**
  - Running `--customer` without `--test` first (always test to yourself first).
  - Forgetting the `--reason` flag on manual sends (audit field stays blank).
  - Running seed without cleanup (test data pollutes admin views).
- **Completion criteria:** Owner runs all 5 scripts successfully against the test environment.

---

## Recording sequence + onboarding playlist

### New hire — Cleaning Tech (Day 1 self-onboarding, ~36 min)
Watch in order:
1. E1 — Day-1 setup
2. E2 — Golden path (rewatch this one. Twice.)
3. E3 — Pre-shift prep
4. E4 — Team Hub + Schedule
5. E5 — Call Out / Time Off / Open Shifts
6. E6 — Safety (SOS + Need Help Now)
7. E7 — Announcements + Improve
8. E8 — Common pitfalls

**Day 1 live coaching:** ~10 minutes — sign-in verification + first shift partner-up.

### New hire — Manager (~34 min)
First watch all 8 Employee videos (you need to know what techs see), then:
1. M1 — Morning recap
2. M2 — SOS Events
3. M3 — Quality tabs
4. M4 — Customer Notes
5. M5 — Announcements
6. M6 — Schedule sync
7. M7 — Attendance

**Day 1 live coaching:** ~20 minutes — shadow one real morning recap end-to-end.

### New hire — Admin (~32 min)
Watch Employee + Manager tracks first, then:
1. A1 — Add customer
2. A2 — Onboard tech
3. A3 — Archive tech
4. A4 — Manual DCR email
5. A5 — Pilot Readiness
6. A6 — Deputy mapping
7. A7 — Display name management

**Day 1 live coaching:** ~30 minutes — supervised onboarding of one real tech.

### Owner / senior admin escalation (~26 min)
Watch all of the above first, then:
1. O1 — Allowlist
2. O2 — Twilio rotation
3. O3 — Deputy OAuth
4. O4 — Emergency contacts
5. O5 — Customer opt-outs
6. O6 — CLI toolkit

**Day 1 live coaching:** none — owner-level work is reference-as-needed.

---

## Maintenance policy

- **Re-record trigger:** any time a video's screens or script no longer match production. UI drift is a regression.
- **Versioning:** title every video with date + version (e.g., `E2 v2 — Golden path — 2026-05-28`). Loom keeps history; never silently overwrite.
- **Quarterly audit:** every quarter, an admin watches the full Employee track at 1.5x to spot drift. Anything wrong → file an Improvement.
- **Captions:** required for accessibility. Verify on every re-record.
- **Test environment:** demo customer `test-account`, demo tech `test-tech` — never record against production data.

---

*End of document. Update before recording — record against the latest version.*
