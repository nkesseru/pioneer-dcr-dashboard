/* PioneerOps Night-Shift Readiness Audit.
 *
 * Read-only by default. Walks every Deputy shift for today + tomorrow in
 * Pacific time and confirms each one is ready for the tech to clock in
 * and submit a DCR. Classifies each row as GREEN / YELLOW / RED and
 * produces both a per-row table and a final action list.
 *
 *   node scripts/night-shift-readiness-audit.js
 *     → read-only audit (PASS 1)
 *
 *   node scripts/night-shift-readiness-audit.js --fix-low-risk
 *     → PASS 3 — applies only the allowed low-risk fixes:
 *         1. re-runs refreshServiceAssignmentsFromDeputyV1 once (idempotent
 *            bridge re-pass; never overwrites live sessions/DCRs)
 *         2. refreshes denormalized customer_name / location_name on
 *            already-bridged service_assignments from the current
 *            customers/{slug} doc (read-from-customer, write-to-assignment
 *            on safe fields only)
 *       NOT applied automatically: creating users, changing customer
 *       notification settings, enabling DCR on real customers, touching
 *       payroll/session records, deleting anything.
 *
 *   node scripts/night-shift-readiness-audit.js --verbose
 *     → verbose per-row dump (default is one-line-per-shift)
 *
 * Sources consulted (read-only in PASS 1):
 *   deputy_shift_cache       — what Deputy says is scheduled
 *   service_assignments      — what got bridged to PioneerOps
 *   pioneer_service_sessions — clock state per assignment
 *   active_service_sessions  — current-clock-in conflict check
 *   cleaning_techs           — staff mapping + dcr_enabled + active flag
 *   admin.auth()             — UID resolution via email
 *   customers                — customer + DCR config
 *   payroll_exports          — workweek lock indirectly
 *
 * Exit code is 0 if no RED rows, 2 if any RED rows present, 1 on error.
 */
"use strict";
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require("../serviceAccountKey.json")) });
}
const db = admin.firestore();
const TZ = "America/Los_Angeles";

const FIX_LOW_RISK = process.argv.includes("--fix-low-risk");
const VERBOSE      = process.argv.includes("--verbose");

const API_KEY     = "AIzaSyC6QiDLp5NAMRR1ODPOli2eTni4bX6Nu74";
const ADMIN_EMAIL = "nick@pioneercomclean.com";
const REFRESH_URL = "https://us-central1-pioneer-dcr-hub.cloudfunctions.net/refreshServiceAssignmentsFromDeputyV1";

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(new Date());
}
function addDaysPT(yyyy_mm_dd, n) {
  const dt = new Date(yyyy_mm_dd + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(dt);
}
function fmtTime(ts) {
  if (!ts) return "—";
  const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds*1000 : null);
  if (ms == null) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true
    }).format(new Date(ms));
  } catch (_e) { return "—"; }
}
function pad(s, n) { return String(s || "").padEnd(n).slice(0, n); }

// ---- Cache UID resolution to avoid hammering admin.auth ----
const uidCache = {};
async function resolveUid(email) {
  if (!email) return null;
  const k = String(email).toLowerCase().trim();
  if (uidCache[k] !== undefined) return uidCache[k];
  try {
    const u = await admin.auth().getUserByEmail(k);
    uidCache[k] = u.uid;
  } catch (_e) { uidCache[k] = null; }
  return uidCache[k];
}

(async () => {
  const today    = todayPT();
  const tomorrow = addDaysPT(today, 1);
  const dates    = [today, tomorrow];

  console.log("================================================================");
  console.log("PioneerOps Night-Shift Readiness Audit");
  console.log("Mode: " + (FIX_LOW_RISK ? "PASS 3 (--fix-low-risk)" : "PASS 1 (read-only)"));
  console.log("Dates (Pacific): " + dates.join(", "));
  console.log("================================================================");

  // ---- Load all reference data once ----
  const [shiftSnap, assignSnap, techSnap, custSnap, sessSnap, activeSnap] = await Promise.all([
    Promise.all(dates.map(d => db.collection("deputy_shift_cache").where("sync_date","==",d).get()))
      .then(snaps => snaps.flatMap(s => s.docs)),
    db.collection("service_assignments")
      .where("service_date",">=",today).where("service_date","<=",tomorrow).get(),
    db.collection("cleaning_techs").get(),
    db.collection("customers").get(),
    db.collection("pioneer_service_sessions")
      .where("service_date",">=",today).where("service_date","<=",tomorrow).get(),
    db.collection("active_service_sessions").get()
  ]);

  const shifts      = shiftSnap.map(d => Object.assign({_id:d.id}, d.data()||{}));
  const assignments = assignSnap.docs.map(d => Object.assign({_id:d.id}, d.data()||{}));
  const techs       = techSnap.docs.map(d => Object.assign({_id:d.id}, d.data()||{}));
  const customers   = custSnap.docs.map(d => Object.assign({_id:d.id}, d.data()||{}));
  const sessions    = sessSnap.docs.map(d => Object.assign({_id:d.id}, d.data()||{}));
  const activeSess  = activeSnap.docs.map(d => Object.assign({_id:d.id}, d.data()||{}));

  const techsByEmail = {}; techs.forEach(t => { if (t.email) techsByEmail[String(t.email).toLowerCase()] = t; });
  const techsBySlug  = {}; techs.forEach(t => { techsBySlug[t._id] = t; });
  const custsBySlug  = {}; customers.forEach(c => { custsBySlug[c._id] = c; });
  const assignById   = {}; assignments.forEach(a => { assignById[a._id] = a; });
  const sessionsByAsgn = {};
  sessions.forEach(s => {
    if (!s.assignment_id) return;
    if (!sessionsByAsgn[s.assignment_id]) sessionsByAsgn[s.assignment_id] = [];
    sessionsByAsgn[s.assignment_id].push(s);
  });
  const activeByUid = {}; activeSess.forEach(a => { if (a.staff_uid) activeByUid[a.staff_uid] = a; });

  console.log("\nLoaded: " + shifts.length + " Deputy shifts · " + assignments.length + " bridged assignments · "
    + techs.length + " cleaning_techs · " + customers.length + " customers · "
    + sessions.length + " sessions in range · " + activeSess.length + " active sessions globally\n");

  /* -------------------------------------------------------------------- */
  /* PASS 3 — optional low-risk fix #1: re-run the bridge once.           */
  /* -------------------------------------------------------------------- */
  if (FIX_LOW_RISK) {
    console.log("--- PASS 3 fix #1: re-run Deputy → service_assignments bridge ---");
    const u = await admin.auth().getUserByEmail(ADMIN_EMAIL);
    const customToken = await admin.auth().createCustomToken(u.uid);
    const ex = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" + API_KEY, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    });
    const exB = await ex.json();
    const idToken = exB.idToken;
    const r = await fetch(REFRESH_URL, {
      method:"POST", headers:{"Authorization":"Bearer "+idToken,"Content-Type":"application/json"},
      body: JSON.stringify({ sync_date: today, days_forward: 1, dry_run: false })
    });
    const b = await r.json();
    console.log("Bridge HTTP " + r.status + " · created=" + (b.created||0) + " · updated_assigned=" + (b.updated_assigned||0)
      + " · skipped=" + JSON.stringify(b.skipped||{}));

    // Re-fetch assignments after the bridge so the rest of the audit sees fresh state.
    const aSnap2 = await db.collection("service_assignments")
      .where("service_date",">=",today).where("service_date","<=",tomorrow).get();
    aSnap2.docs.forEach(d => { assignById[d.id] = Object.assign({_id:d.id}, d.data()||{}); });
    Object.keys(assignById).forEach(k => assignments.push(assignById[k]));
    console.log("");
  }

  /* -------------------------------------------------------------------- */
  /* PASS 1 — per-shift inspection                                        */
  /* -------------------------------------------------------------------- */
  const rows = [];
  const greenCount = { v: 0 }, yellowCount = { v: 0 }, redCount = { v: 0 };
  const skipReasons = {
    uid_unresolved: 0, no_email: 0, customer_unresolved: 0,
    location_unresolved: 0, inactive_customer: 0, inactive_employee: 0,
    invalid_date: 0, other: 0
  };

  for (const s of shifts) {
    const row = {
      shift_id:        s.shift_id,
      sync_date:       s.sync_date,
      start_time:      s.start_time,
      end_time:        s.end_time,
      emp_name:        s.employee_display_name || "?",
      emp_id:          s.deputy_employee_id || "?",
      emp_email:       String(s.employee_email || "").toLowerCase().trim(),
      emp_slug:        s.employee_slug || "",
      customer_slug:   s.customer_slug || "",
      customer_name:   s.customer_name || s.deputy_company_name || "",
      deputy_company:  s.deputy_company_name || "",
      status:          s.status || "",
      flags:           [],
      severity:        "GREEN",
      notes:           []
    };

    // Skip cancelled Deputy shifts entirely — they aren't part of tonight's roster.
    if (String(s.status||"").toLowerCase() === "cancelled") {
      row.notes.push("Deputy shift cancelled");
      row.severity = "GREEN";
      row.flags.push("cancelled");
      rows.push(row);
      continue;
    }

    // --- Employee mapping ---
    const tech = (row.emp_slug && techsBySlug[row.emp_slug]) || (row.emp_email && techsByEmail[row.emp_email]) || null;
    row.tech_path        = tech ? "cleaning_techs/" + tech._id : "(none)";
    row.tech_active      = tech ? (tech.active !== false) : null;
    row.tech_dcr_enabled = tech ? (tech.dcr_enabled !== false) : null;
    row.tech_role        = tech ? (tech.role || "cleaning_tech") : null;

    if (!row.emp_email) {
      skipReasons.no_email++;
      row.flags.push("no_email");
      row.notes.push("Deputy shift has no employee_email — fix in cleaning_techs/" + (row.emp_slug || "{slug}"));
      row.severity = "RED";
    }

    let uid = null;
    if (row.emp_email) {
      uid = await resolveUid(row.emp_email);
      row.firebase_uid = uid || "(unresolved)";
      if (!uid) {
        skipReasons.uid_unresolved++;
        row.flags.push("uid_unresolved");
        row.notes.push("Tech has not signed into PioneerOps yet — they must visit /work once");
        row.severity = "RED";
      }
    }

    if (tech && tech.active === false) {
      skipReasons.inactive_employee++;
      row.flags.push("inactive_employee");
      row.notes.push("cleaning_techs/" + tech._id + " is archived");
      row.severity = "RED";
    }

    // --- Customer mapping ---
    const customer = row.customer_slug ? custsBySlug[row.customer_slug] : null;
    row.customer_path  = customer ? "customers/" + customer._id : "(unmapped)";
    row.customer_active = customer ? (customer.active !== false) : null;
    row.location_name   = customer ? (customer.location_name || customer.customer_name || "") : "";
    // DCR config: default-on if customer present and dcr_enabled !== false.
    row.dcr_enabled        = customer ? (customer.dcr_enabled !== false) : false;
    row.dcr_email_enabled  = customer ? (customer.dcr_email_enabled === true) : false;
    row.has_review_links   = !!(customer && customer.review_links &&
                               (customer.review_links.five_star_url || customer.review_links.issue_url));

    if (!customer) {
      skipReasons.customer_unresolved++;
      row.flags.push("customer_unresolved");
      row.notes.push("Deputy company \"" + row.deputy_company + "\" not mapped — add via /admin → Deputy Mapping");
      row.severity = "RED";
    } else if (customer.active === false) {
      skipReasons.inactive_customer++;
      row.flags.push("inactive_customer");
      row.notes.push("customers/" + customer._id + " is archived but Deputy still has a shift here");
      row.severity = "RED";
    }

    // --- Bridge state ---
    const expectedAsgnId = "sa_deputy__" + row.shift_id;
    const assignment = assignById[expectedAsgnId];
    row.assignment_path = assignment ? "service_assignments/" + expectedAsgnId : "(missing)";
    if (!assignment) {
      row.flags.push("missing_assignment");
      // If we have a customer + uid, it should have bridged. If not, this is RED.
      if (uid && customer && customer.active !== false) {
        row.severity = "RED";
        row.notes.push("Bridge has not created sa_deputy__" + row.shift_id + " yet — re-run refreshServiceAssignmentsFromDeputyV1");
      }
    } else {
      row.assignment_status   = assignment.status;
      row.removed_from_ptc    = assignment.removed_from_ptc === true;
      row.assignment_admin_removed = assignment.status === "admin_removed";
      if (row.removed_from_ptc || row.assignment_admin_removed) {
        row.flags.push("removed_from_ptc");
        row.notes.push("Assignment was removed from PTC by admin — tech won't see it");
        // Could be intentional; mark YELLOW
        if (row.severity === "GREEN") row.severity = "YELLOW";
      }
      // Visibility expectation: shift_date matches today, no removal, uid matches.
      const visibleToEmployeeExpected = !!(uid && assignment.staff_uid === uid &&
                                            !row.removed_from_ptc && !row.assignment_admin_removed);
      row.visible_to_employee_expected = visibleToEmployeeExpected ? "yes" : "no";
      // Bridge mismatch — UID drifted (tech re-signed in?)
      if (uid && assignment.staff_uid && assignment.staff_uid !== uid) {
        row.flags.push("uid_mismatch");
        row.notes.push("assignment.staff_uid (" + assignment.staff_uid + ") doesn't match Auth uid (" + uid + ")");
        row.severity = "RED";
      }
      // Workweek-lock check (Phase 28D) — block clock-in if exported.
      if (assignment.workweek_locked_by_export === true) {
        row.flags.push("workweek_locked");
        row.notes.push("Workweek already exported — clock-in would be blocked");
        row.severity = "RED";
      }
    }

    // --- DCR readiness ---
    let dcrReady = false, dcrNote = "";
    if (!customer) {
      dcrNote = "no customer";
    } else if (customer.dcr_enabled === false) {
      dcrNote = "dcr_enabled=false (intentionally disabled)";
      if (row.severity === "GREEN") row.severity = "YELLOW";
      row.flags.push("dcr_disabled");
    } else if (typeof customer.dcr_enabled === "undefined") {
      dcrNote = "dcr_enabled missing (default-on, but flag absent)";
      if (row.severity === "GREEN") row.severity = "YELLOW";
      row.flags.push("dcr_flag_missing");
    } else {
      dcrReady = true;
      dcrNote = "dcr_enabled=true";
    }
    if (customer && tech && tech.dcr_enabled === false) {
      // Admin-role techs intentionally have dcr_enabled=false — they don't
      // submit DCRs themselves. Not a blocker; informational note.
      const techIsAdmin = String(tech.role || "").toLowerCase() === "admin";
      if (techIsAdmin) {
        dcrNote += "; tech.dcr_enabled=false (admin role — expected)";
        row.flags.push("tech_dcr_disabled_admin");
      } else {
        dcrNote += "; tech.dcr_enabled=false (tech blocked from DCR)";
        row.flags.push("tech_dcr_disabled");
        row.severity = "RED";
      }
    }
    row.dcr_ready = dcrReady;
    row.dcr_note  = dcrNote;

    // --- Time-clock readiness ---
    let clockReady = !!(uid && assignment && !row.removed_from_ptc && !row.assignment_admin_removed
                        && assignment.workweek_locked_by_export !== true);
    row.clock_ready = clockReady;

    const conflictActive = uid && activeByUid[uid] && activeByUid[uid].assignment_id !== expectedAsgnId;
    if (conflictActive) {
      row.flags.push("active_session_conflict");
      row.notes.push("Tech is currently clocked into " + activeByUid[uid].assignment_id + " — would block clock-in here");
      if (row.severity === "GREEN") row.severity = "YELLOW";
    }
    const priorSessions = sessionsByAsgn[expectedAsgnId] || [];
    row.prior_session_count = priorSessions.length;
    if (priorSessions.some(s => s.status === "active" || s.status === "paused")) {
      row.flags.push("session_in_progress");
      if (row.severity === "GREEN") row.severity = "YELLOW";
    }

    // Final severity tally
    if (row.severity === "RED")    redCount.v++;
    else if (row.severity === "YELLOW") yellowCount.v++;
    else greenCount.v++;
    rows.push(row);
  }

  /* -------------------------------------------------------------------- */
  /* PASS 3 — fix #2: refresh customer metadata on bridged assignments.   */
  /* -------------------------------------------------------------------- */
  let metadataRefreshed = 0;
  if (FIX_LOW_RISK) {
    const batch = db.batch();
    let updates = 0;
    for (const row of rows) {
      if (row.flags.includes("missing_assignment")) continue;
      const a = assignById["sa_deputy__" + row.shift_id];
      if (!a) continue;
      const cust = custsBySlug[row.customer_slug];
      if (!cust) continue;
      const newName     = cust.customer_name || a.customer_name;
      const newLocation = cust.location_name || a.location_name || null;
      if ((a.customer_name || "") !== (newName || "") ||
          (a.location_name || "") !== (newLocation || "")) {
        batch.update(db.collection("service_assignments").doc(a._id), {
          customer_name: newName,
          location_name: newLocation,
          updated_at:    admin.firestore.FieldValue.serverTimestamp(),
          updated_by:    "night_shift_audit_fix_low_risk"
        });
        updates++;
      }
    }
    if (updates > 0) await batch.commit();
    metadataRefreshed = updates;
    console.log("--- PASS 3 fix #2: refreshed customer/location metadata on " + metadataRefreshed + " assignment(s) ---\n");
  }

  /* -------------------------------------------------------------------- */
  /* OUTPUT                                                               */
  /* -------------------------------------------------------------------- */

  if (VERBOSE) {
    console.log("--- Per-shift detail ---");
    rows.forEach(r => {
      console.log("\n[" + r.severity + "] shift " + r.shift_id + " · " + r.sync_date);
      console.log("  employee:    " + r.emp_name + " · " + r.emp_email + " · uid=" + (r.firebase_uid||"?"));
      console.log("  tech:        " + r.tech_path + " · active=" + r.tech_active + " · dcr=" + r.tech_dcr_enabled);
      console.log("  customer:    " + r.customer_path + " · active=" + r.customer_active + " · location=" + r.location_name);
      console.log("  dcr config:  " + r.dcr_note + " · dcr_email=" + r.dcr_email_enabled + " · review_links=" + r.has_review_links);
      console.log("  assignment:  " + r.assignment_path + " · status=" + (r.assignment_status||"?")
        + " · visible=" + (r.visible_to_employee_expected||"?"));
      console.log("  clock:       ready=" + r.clock_ready + " · prior_sessions=" + r.prior_session_count);
      console.log("  flags:       " + (r.flags.length ? r.flags.join(", ") : "—"));
      if (r.notes.length) r.notes.forEach(n => console.log("  ! " + n));
    });
  }

  console.log("\n================================================================");
  console.log("SUMMARY");
  console.log("================================================================");
  console.log("Total Deputy shifts:       " + shifts.length);
  console.log("Active tech shifts (not cancelled): " +
    rows.filter(r => !r.flags.includes("cancelled")).length);
  console.log("Bridged assignments:       " +
    rows.filter(r => !r.flags.includes("missing_assignment") && !r.flags.includes("cancelled")).length);
  console.log("Missing assignments:       " +
    rows.filter(r => r.flags.includes("missing_assignment") && !r.flags.includes("cancelled")).length);
  console.log("");
  console.log("Skip reasons:");
  Object.keys(skipReasons).forEach(k => {
    if (skipReasons[k] > 0) console.log("  " + k + ": " + skipReasons[k]);
  });
  console.log("");
  console.log("DCR enabled (default-on, flag present):  " +
    rows.filter(r => r.dcr_ready && !r.flags.includes("cancelled")).length);
  console.log("DCR intentionally disabled:              " +
    rows.filter(r => r.flags.includes("dcr_disabled") && !r.flags.includes("cancelled")).length);
  console.log("DCR flag missing (default-on, unset):    " +
    rows.filter(r => r.flags.includes("dcr_flag_missing") && !r.flags.includes("cancelled")).length);
  console.log("");
  console.log("GREEN (ready):    " + greenCount.v);
  console.log("YELLOW (review):  " + yellowCount.v);
  console.log("RED (blocked):    " + redCount.v);

  console.log("\n================================================================");
  console.log("ACTION TABLE (concise)");
  console.log("================================================================");
  console.log(pad("Employee", 22) + " | " + pad("Location", 30) + " | " + pad("Shift", 18) + " | "
    + pad("Asgn", 6) + " | " + pad("DCR", 8) + " | " + pad("Clk", 4) + " | " + pad("Status", 7) + " | Fix");
  console.log("-".repeat(140));
  rows
    .filter(r => !r.flags.includes("cancelled"))
    .sort((a,b) => {
      const order = { RED: 0, YELLOW: 1, GREEN: 2 };
      const diff = order[a.severity] - order[b.severity];
      if (diff !== 0) return diff;
      return String(a.emp_name).localeCompare(String(b.emp_name));
    })
    .forEach(r => {
      const loc = (r.customer_name || r.deputy_company || "?").slice(0,30);
      const shift = r.sync_date + " " + fmtTime(r.start_time);
      const asgn = r.flags.includes("missing_assignment") ? "MISSING" : "ok";
      const dcr  = r.flags.includes("dcr_disabled") ? "DIS" :
                   r.flags.includes("dcr_flag_missing") ? "?" :
                   r.dcr_ready ? "ok" : "—";
      const clk  = r.clock_ready ? "ok" : "—";
      const fix  = r.notes[0] || (r.severity === "GREEN" ? "" : "(see flags: " + r.flags.join(",") + ")");
      console.log(pad(r.emp_name, 22) + " | " + pad(loc, 30) + " | " + pad(shift, 18) + " | "
        + pad(asgn, 6) + " | " + pad(dcr, 8) + " | " + pad(clk, 4) + " | " + pad(r.severity, 7) + " | " + fix);
    });

  if (FIX_LOW_RISK) {
    console.log("\n================================================================");
    console.log("PASS 3 fix summary:");
    console.log("  bridge re-run:              done");
    console.log("  metadata refresh updates:   " + metadataRefreshed);
    console.log("================================================================");
  }

  const ready = redCount.v === 0;
  console.log("\n" + (ready ? "✔ READY FOR TONIGHT" : "✖ NOT READY — " + redCount.v + " RED row(s) need action"));
  process.exit(ready ? 0 : 2);
})().catch(e => { console.error("Audit failed:", e); process.exit(1); });
