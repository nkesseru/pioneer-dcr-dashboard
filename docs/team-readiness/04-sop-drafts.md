# Deliverable 4 — Standard Operating Procedure (SOP) Drafts

First-draft SOPs for the 11 most-frequent PioneerOps procedures. Each follows the same template:

- **Audience** — who runs this
- **When to run it** — the trigger
- **Steps** — numbered, atomic, screenshot-ready
- **Verify** — how to confirm it worked
- **Edge cases** — what can go sideways and how to recover

These are first drafts. Promote to your permanent SOP system after verifying the step list matches the current UI.

---

## Table of Contents

1. [SOP-001 Clock In (Cleaning)](#sop-001--clock-in-cleaning)
2. [SOP-002 Clock Out (Cleaning)](#sop-002--clock-out-cleaning)
3. [SOP-003 Submit a DCR](#sop-003--submit-a-dcr)
4. [SOP-004 Request a Time Adjustment](#sop-004--request-a-time-adjustment)
5. [SOP-005 Use My Hours (Verify Payroll)](#sop-005--use-my-hours-verify-payroll)
6. [SOP-006 Submit a Supply Request](#sop-006--submit-a-supply-request)
7. [SOP-007 Perform an Inspection](#sop-007--perform-an-inspection)
8. [SOP-008 Review Inspection Results](#sop-008--review-inspection-results)
9. [SOP-009 Approve a Time Adjustment](#sop-009--approve-a-time-adjustment)
10. [SOP-010 Review + Export Payroll](#sop-010--review--export-payroll)
11. [SOP-011 Mission Control Daily Triage](#sop-011--mission-control-daily-triage)

---

## SOP-001 — Clock In (Cleaning)

**Audience:** Cleaning Tech
**When:** Arriving at a customer site to start a cleaning shift.

### Steps
1. Sign in at `https://pioneer-dcr-hub.web.app/work` if not already signed in.
2. Find today's customer card under "Today's Work."
3. Tap **Clock In** on that card.
4. Confirm the screen shows the green active state and a running timer.
5. Begin cleaning.

### Verify
- Top banner shows "On the clock · [customer name]" with a running timer.
- The same page can no longer offer Clock In on a different customer until you clock out.

### Edge cases
- **"Already clocked in to another stop (X)."** — You have a leftover active session. Clock out of X first (it may have been an inspection or supply pickup from earlier).
- **No customer cards visible.** — Today's assignments haven't been pulled from Deputy yet. Try refreshing. If still empty after a minute, message Kirby on the Need Help Now card.
- **GPS warning shows "off-site."** — The system records this for review but DOES NOT block you. Carry on.

---

## SOP-002 — Clock Out (Cleaning)

**Audience:** Cleaning Tech
**When:** Finishing your work at a customer site.

### Steps
1. From `/work`, tap **Clock Out** on the active customer card.
2. The DCR (Daily Cleaning Report) form opens automatically.
3. Complete the DCR per **SOP-003** before leaving the screen.

### Verify
- The card returns to its "available" state.
- Your shift now appears on `/team-hub` under My Hours with a clock-in / clock-out timestamp and a status of **Complete**.

### Edge cases
- **You forgot to clock out at the customer.** — Submit a Time Adjustment request the next time you sign in (see SOP-004). DO NOT leave the session active overnight; admin will follow up either way.
- **The DCR form failed to open.** — You can manually navigate to it; the session is in `dcr_pending` state and payroll will be blocked until the DCR is submitted.

---

## SOP-003 — Submit a DCR

**Audience:** Cleaning Tech
**When:** Right after clock-out at a customer site.

### Steps
1. The DCR form opens automatically when you Clock Out.
2. Complete each section. Five sections appear:
   - Bathrooms
   - General Areas
   - Kitchens / Break Rooms
   - Offices
   - Entryways
3. For each item, mark Yes / No / N/A based on what you actually did.
4. **Photos** — at least one per cleaned section is the Pioneer expectation. Quality > quantity.
5. **Issues** — if you noticed something the customer should know (broken faucet, supply running low), describe it in the issue box at the bottom. This creates a `dcr_issues` doc for Kirby to triage.
6. **Sign** — type your name in the signature field.
7. Tap **Submit DCR**.
8. Confirm the success screen. The DCR is now stamped on your session.

### Verify
- Success screen shows the DCR has been recorded.
- On `/team-hub → My Hours`, your shift row no longer shows "DCR pending" — it's payroll-ready.
- The customer (if customer email is on file) will receive an auto-generated DCR email within minutes.

### Edge cases
- **"Submit DCR" button is greyed out.** — A required field is missing. Scroll up to find the highlighted row.
- **Customer email didn't arrive.** — Some customers don't have email on file. Kirby can check `/admin → Customers` to verify and add an email.
- **You realized you submitted with wrong info.** — DCRs are immutable once submitted. Talk to Kirby; she can edit on the admin side.

---

## SOP-004 — Request a Time Adjustment

**Audience:** Cleaning Tech (also admin tier on their own behalf)
**When:** You notice a shift in My Hours has the wrong clock-in or clock-out time.

### Steps
1. Open `/team-hub` and scroll to **My Hours**.
2. Find the shift with the wrong time in the shift list. The most recent 5 show by default; click **View All Shifts** if needed.
3. Click **Adjust** on the affected shift. *(If the button is disabled, hover over it for the reason — typically because the shift is still active or already has a pending request.)*
4. The Time Adjustment modal opens with your original clock-in and clock-out pre-filled.
5. Change the wrong time to the correct one. (Both times are required even if you only need one corrected.)
6. Pick a **Reason** from the dropdown:
   - Forgot to clock in
   - Forgot to clock out
   - Phone issue
   - Wrong time
   - Wrong location
   - Other
7. Write a **Note** (required). One or two sentences so Kirby can verify what happened.
8. Click **Submit Request**.
9. Confirm the success message "Submitted — Kirby will review shortly."
10. Refresh My Hours. That shift now shows a yellow **Correction pending** badge and the Pending corrections tile increments.

### Verify
- Yellow "Pending correction" pill appears next to the shift.
- The Confidence chip at the top of My Hours shows "⚠ Pending correction".
- Kirby will approve or follow up before the payroll deadline shown ("Payroll closes: [date]").

### Edge cases
- **"Adjust" button is greyed out and tooltip says "Clock out first"** — The shift is still active. Clock out first.
- **"Adjust" button shows "Pending"** — You already submitted a correction for this shift. One pending at a time.
- **"Adjust" missing because the shift has no Clock Out** — A missing-clock-out shift needs Kirby's manual fix. Use the Need Help Now card on `/team-hub`.
- **Modal won't accept your time** — Clock-out has to be AFTER clock-in. Re-check.

---

## SOP-005 — Use My Hours (Verify Payroll)

**Audience:** Cleaning Tech (any role with sessions logged)
**When:** Each pay period close. Daily quick-glance is also a good habit.

### Steps
1. Open `/team-hub`.
2. Scroll to **⏱ My Hours**.
3. Read the **Confidence chip** at the top:
   - **✓ Hours look good** (green) — nothing pending; payroll should reflect what's shown.
   - **⚠ Pending correction** (amber) — at least one correction is waiting on Kirby.
4. Read the **Total hours** tile. This is what payroll will pay you (modulo any pending correction).
5. Read the **Payroll closes:** date. After this date, corrections become hard to get in.
6. Scroll the shift list. The most recent 5 show by default — click **View All Shifts** to see the rest.
7. For each shift, verify:
   - Date
   - Customer name (or Supply Pickup / Inspection)
   - Clock-in → clock-out times
   - Duration
8. If anything is wrong, run **SOP-004** to submit a correction.

### Verify
- All your shifts for the period appear in the list.
- The Total hours tile reflects what you actually worked.
- If you submitted a correction, the badge "Correction pending" appears on that row.

### Edge cases
- **Total hours seems low.** — Expand the shift list and check for missing shifts. Common cause: a shift never got a clock-out (admin must close it). Run SOP-004 if it's a clock-time issue; ping Kirby if a whole shift is missing.
- **A shift you DON'T remember working appears.** — Talk to Kirby; admin can mark it removed from payroll.

---

## SOP-006 — Submit a Supply Request

**Audience:** Anyone with PioneerOps access (tech, admin).
**When:** Customer site needs restock OR you need supplies for general use.

### Steps
1. Open `/supply-station`.
2. (Optional — only if you're physically at the storage unit) Click **📦 Start Supply Pickup** at the top to log paid time.
3. Scroll to the Supply Request form.
4. Pick the **Customer** from the dropdown. Choose "No specific customer" for HQ-general stock.
5. Add the items needed. Be specific (brand, size).
6. Set the **Priority**. "Urgent" should be reserved for "I have nothing for tomorrow's shift."
7. Click **Submit Request**.
8. (Optional — only if you started the Pickup clock) Click **✓ Complete Supply Pickup** when you leave the storage unit.

### Verify
- Confirmation toast appears.
- Request shows up in `/admin → Supply Requests` for Kirby/April.

### Edge cases
- **You forgot to start the pickup clock at the unit.** — Submit a Time Adjustment after the fact (SOP-004) for the supply_station shift.
- **You see "Already clocked in for Cleaning."** — You're still clocked in for a customer site. Finish that first.

---

## SOP-007 — Perform an Inspection

**Audience:** Inspector (admin tier)
**When:** A customer is due for inspection (look at `/inspections → Customer Registry → Overdue` filter).

### Steps
1. Open `/inspections`.
2. At the top, click **▶ Start Inspection** to log paid time for the walk.
3. In the **Customer Registry**, filter by **Overdue** or browse the list. Note the rotation hint inline ("last: Kirby → try: April").
4. Click **Assign to Me** on the customer's row. Row jumps to your **My Queue**.
5. In My Queue, click **Open Inspection** on the same row. The intake form opens with the customer pre-filled.
6. Step 1 Setup — confirm date, your name as inspector, time since last clean. Pick a credited tech if you know who cleaned last.
7. Step 2 Evaluate each item — for every item across the 8 sections, mark one of:
   - **N/A** — not applicable tonight
   - **Pass** — met Pioneer standard
   - **Great** — exceeded expectations
   - **Fail** — missing or unacceptable (a comment is REQUIRED)
8. (Optional) On Pass or Great, you can add a praise note.
9. Step 3 Overall — confirm the score readout. Add overall inspection notes.
10. Click **Submit inspection**.
11. After success, click **■ End Inspection** to clock out.

### Verify
- Success screen shows the inspection has been recorded.
- Within ~2 seconds, the Customer Registry refreshes that customer to **Completed** status.
- If overall score ≥ 4.8, a 5-star celebration appears + a Quality Win is minted.
- Your paid time for the walk appears in My Hours when you next visit `/team-hub`.

### Edge cases
- **Customer doesn't appear in the registry.** — On first registry load, the page lazy-bootstraps state docs for every active customer. If a customer is missing, they may be inactive in `/admin → Customers`.
- **You did the inspection on paper and need to mark the cycle complete without entering data.** — Use **Mark Complete** on the My Queue row instead of Open Inspection. The cadence registry closes but no score row gets created.
- **You marked a Fail without comment.** — Submit refuses with a clear message. Add the comment.
- **Photo upload says "(coming soon)".** — Yes, photo upload isn't fully wired yet. See `06-known-gaps.md`. The Fail comment is sufficient documentation for V1.

---

## SOP-008 — Review Inspection Results

**Audience:** Admin / Office Manager
**When:** Daily skim. Specifically after Quality Wins ping or when a tech health concern surfaces.

### Steps
1. Open `/inspections`.
2. Scroll to **Recent inspections** (last 5).
3. Click a card to open the detail modal.
4. Read the summary chips: total Pass / Great / Fail counts.
5. Read the per-section item list. Fails will have their comments inline.
6. If any Fails warrant coaching: open `/admin → Service Recoveries` and create a follow-up doc.
7. If overall score ≥ 4.8: the Quality Win was already auto-celebrated on `/team-hub`. Optional: read it on the brag wall.

### Verify
- Detail modal shows the inspection summary + every item.
- Any Service Recovery you created appears on the related customer's record.

### Edge cases
- **Inspection score seems too low for what you observed.** — Click into the detail. Read each Fail comment. If the inspector made a mistake, talk to them (or have admin edit the inspection record on the admin path).

---

## SOP-009 — Approve a Time Adjustment

**Audience:** Office Manager (Kirby) primarily; any admin tier can do this.
**When:** A tech has submitted a correction. You'll see them in two places: `/manager` Mission Control "Attention" bucket, and `/admin → Payroll Exceptions`.

### Steps
1. Open `/admin` and click the **Payroll Exceptions** tab.
2. Sub-tab **Pending** shows every awaiting request.
3. Click a row to see:
   - Tech name + email
   - Customer + location
   - Shift date
   - Original clock-in / clock-out
   - Requested clock-in / clock-out
   - Delta minutes
   - Reason + note
   - 30-day + 90-day count of this tech's requests (pattern signal)
4. Decide:
   - **Approve** — if the requested times are credible based on the note + your knowledge of the day
   - **Deny** — if the request doesn't match reality
5. Click the button. Confirmation prompt asks one more time.
6. On approve: function stamps `effective_clock_in/out/minutes` on the underlying session + sets `has_approved_time_adjustment: true`. Payroll export uses the effective values.
7. On deny: enter a denial reason. Tech will see the status change next time they refresh My Hours.

### Verify
- Row moves from Pending to Approved (or Denied) sub-tab.
- On approve, the affected session in `/admin → Labor` shows the new effective times.
- Tech's My Hours shows "Correction applied" badge (green) next time they load.

### Edge cases
- **Requested clock-out is in the future** — Reject. The function should already refuse but if it slipped through, deny it.
- **Tech has 5+ requests in 30 days** — Pattern signal. Worth a conversation rather than just approving the next one.
- **Session has already been exported to payroll** — The function will refuse to update locked sessions. The fix is to void the export, then approve, then re-export.

---

## SOP-010 — Review + Export Payroll

**Audience:** Office Manager (Kirby) — primary owner. April + Nick as backup.
**When:** End of each semi-monthly pay period (15th and last day of month).

### Steps
1. Open `/admin` and click the **Labor** tab.
2. **Filter to the pay period** using the date range controls.
3. Walk the session list. For each row:
   - Verify clock-in / clock-out times look right
   - Verify status is **Complete** with a DCR submitted (for cleaning rows)
   - For Inspection / Supply Pickup rows: they don't require a DCR (the labor type chip shows "Inspection · CustomerName" or "Supply Pickup")
4. Mark each clean row **Reviewed** → **Approve for Payroll**.
5. Resolve any blockers:
   - `dcr_pending` — get the tech to submit, or close the issue admin-side
   - `needs_review` — investigate the flag (offsite, abnormal duration, etc.)
   - `missing_clockout` — admin must enter the clock-out manually
6. When all blockers cleared, open the **Payroll** tab.
7. **Verification Layer** banner at the top shows the readiness state. If any blocker remains, the banner is red and the Export button is disabled.
8. Click **Export Payroll CSV**.
9. CSV downloads. Open it. Sanity-check totals against your gut feel.
10. Import the CSV into QuickBooks (manual handoff today — see `06-known-gaps.md` re: QuickBooks integration).

### Verify
- CSV row count matches approved-session count
- Total paid hours match the bucket sums in Labor tab
- A `payroll_exports` doc is now in Firestore as the audit record

### Edge cases
- **Export button is disabled and the banner shows "DCR pending: 3"** — Three sessions are still missing DCRs. Find them in Labor with the DCR Pending filter chip; resolve them; re-check.
- **You exported but then noticed an error** — Use **Void Payroll Export** in the Payroll tab. The CSV is invalidated; sessions become re-editable; repeat the process.
- **Tech submitted a time-adjustment AFTER you approved their session** — The session is locked. Void the export, approve the time-adjustment, re-export.

---

## SOP-011 — Mission Control Daily Triage

**Audience:** Office Manager (Kirby), also useful for April when filling in.
**When:** Once each morning, ~15 minutes.

### Steps
1. Open `/manager`.
2. Read the **Action Required** counters: Critical / Attention / Healthy.
3. Walk the **Attention** list top to bottom:
   - Click into each item's source page (Labor, DCR Issues, Supply, etc.)
   - Resolve, dismiss, or snooze the alert
4. If something is genuinely irrelevant: click **Dismiss** (one-time hide) or **Suppress Similar** (category-wide rule).
5. Click **Refresh** at the top to re-pull. Confirm the counter drops.
6. Read the **Health cards** row (Customer / Admin / Hiring). Note anything off-baseline.
7. Submit your **Daily Reflection** (~3 sentences).
8. Pick **Today's Bottleneck** — "Waiting on April / Customer / Vendor / Nobody". Optional context.
9. Read the **Communication Center** — reply to anything addressed to you, close anything resolved.
10. Skim the **Improvement Pipeline** — if anything is Approved and waiting to start, push it to In Progress.

### Verify
- Mission Control counters dropped after triage
- Daily Reflection + Bottleneck are recorded for today (date YYYY-MM-DD)
- Open communication threads have either replies or closures

### Edge cases
- **Counter is "0 / 0 / 0"** — Healthy day. Spend the 15 min on coaching or a forward-looking task.
- **Counter is 5+ Critical** — Pause everything else. Resolve each Critical one by one. If any are genuinely unresolvable today, escalate to April.
- **You accidentally suppressed a category you shouldn't have** — `/admin → Mission Control → Suppressions` shows active rules; reactivate the one you regret.

---

## SOP Maintenance

These SOPs reference specific button labels and section names. When the UI changes:
- Whoever ships the change updates the affected SOP in the same commit
- Quarterly leadership skim ensures no SOP has drifted

The git history of this file IS the change log.

---

## End of SOPs

For onboarding a new employee through these → `03-training-outline.md`.
For "is this SOP describing something that's actually fully built?" → `06-known-gaps.md`.
