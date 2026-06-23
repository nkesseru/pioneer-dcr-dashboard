/* Pioneer DCR Hub — Pilot Readiness check engine.
 *
 * Shared between:
 *   • functions/index.js (pilotReadinessCheckV1 HTTPS endpoint)
 *   • scripts/pilot-readiness-check.js (terminal diagnostic)
 *
 * Goal: detect access / permission / data problems for each active
 * cleaning tech BEFORE they hit the app on pilot day.
 *
 * Design: every check is STRUCTURAL — we verify the data inputs each
 * Firestore rule needs (e.g., shift.employee_email lowercased ===
 * tech.auth.email). No real writes, no test docs, no mutation of
 * production state. The engine never throws — every check captures
 * its own error as a FAIL/WARN entry so one bad lookup doesn't
 * blank the whole report.
 *
 * Levels:
 *   PASS — input data matches what the production rule requires
 *   WARN — works today but operationally weak (e.g., never signed in)
 *   FAIL — would deny / break a real user flow
 *
 * Categories (per spec):
 *   1. Auth                  — Firebase Auth user exists, provider known
 *   2. Tech record           — cleaning_techs/{slug} shape + flags
 *   3. Deputy mapping        — deputy_shift_cache lines up with auth email
 *   4. Permissions           — structural rule preconditions
 *   5. Customer mapping      — upcoming shifts point at active customers
 *   6. Announcements         — pending mandatory announcements (info only)
 *   7. Mobile safety         — manual; surfaced as a note in the summary
 *
 * Author note: this file is required by BOTH the Cloud Function and the
 * Node script. Avoid functions-runtime imports here; keep it to plain
 * Node + firebase-admin SDK calls passed in from the caller.
 */

const TECHS_COLLECTION = "cleaning_techs";

const ALLOWED_ADMIN_EMAILS = [
  "nick@pioneercomclean.com",
  "april@pioneercomclean.com",
  "kirby@pioneercomclean.com",
  "mgies@pioneercomclean.com"
];

function normEmail(e) { return String(e == null ? "" : e).trim().toLowerCase(); }

function pacificDateString(dateMs) {
  // YYYY-MM-DD in America/Los_Angeles, matches deputy_shift_cache.sync_date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit"
  }).format(new Date(dateMs));
}

function upcomingDateStrings(days) {
  const out = [];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 0; i < days; i++) {
    out.push(pacificDateString(now + i * DAY));
  }
  return out;
}

// Single result entry. `level` ∈ {PASS, WARN, FAIL}.
function entry(category, level, label, detail) {
  return { category: category, level: level, label: label, detail: detail || null };
}

// Worst level across a tech's checks, used for the per-tech badge.
function rollup(checks) {
  if (checks.some(function (c) { return c.level === "FAIL"; })) return "FAIL";
  if (checks.some(function (c) { return c.level === "WARN"; })) return "WARN";
  return "PASS";
}

/* --------------------------------------------------------------------
 * Per-category checks.
 * Each function pushes entries onto `checks` (mutates) and returns
 * useful side data the next category may need (e.g., the resolved
 * auth UID for the Deputy stage).
 * ------------------------------------------------------------------ */

async function checkAuth(admin, tech, checks) {
  const email = normEmail(tech.email);
  if (!email) {
    checks.push(entry("Auth", "FAIL", "Tech email missing",
      "cleaning_techs." + tech.id + ".email is empty — cannot resolve Firebase Auth user."));
    return { user: null };
  }
  let user = null;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      checks.push(entry("Auth", "FAIL", "No Firebase Auth user for tech email",
        "Run Admin → Cleaning Techs → " + (tech.display_name || tech.id) + " → Send Invite."));
    } else {
      checks.push(entry("Auth", "FAIL", "Auth lookup failed",
        (err && err.code) || (err && err.message) || "unknown"));
    }
    return { user: null };
  }
  if (user.disabled) {
    checks.push(entry("Auth", "FAIL", "Auth user is disabled",
      "Re-enable " + email + " in the Firebase Auth console."));
    return { user: user };
  }
  const providers = (user.providerData || []).map(function (p) { return p.providerId; });
  const hasUsableProvider = providers.indexOf("google.com") >= 0 || providers.indexOf("password") >= 0;
  if (!hasUsableProvider) {
    checks.push(entry("Auth", "FAIL", "No usable sign-in provider",
      "Providers = [" + providers.join(", ") + "] — re-invite to attach google.com or password."));
    return { user: user };
  }
  checks.push(entry("Auth", "PASS", "Firebase Auth user exists",
    "uid=" + user.uid + " · providers=" + (providers.join(", ") || "(none)")));
  const lastSignIn = user.metadata && user.metadata.lastSignInTime;
  if (!lastSignIn) {
    checks.push(entry("Auth", "WARN", "Never signed in yet",
      "User has accepted the invite but has not signed in. Confirm they can complete first sign-in before pilot day."));
  }
  return { user: user };
}

function checkTechRecord(tech, checks) {
  if (tech.active === false) {
    checks.push(entry("Tech record", "FAIL", "cleaning_techs.active = false",
      "Archived tech — exclude from pilot or re-activate."));
  } else {
    checks.push(entry("Tech record", "PASS", "active = true"));
  }
  if (tech.dcr_enabled === false) {
    checks.push(entry("Tech record", "FAIL", "dcr_enabled = false",
      "Tech is excluded from DCR. Flip the toggle in Admin → Cleaning Techs."));
  } else {
    checks.push(entry("Tech record", "PASS", "dcr_enabled = true"));
  }
  if (!normEmail(tech.email)) {
    checks.push(entry("Tech record", "FAIL", "email field empty"));
  } else if (tech.email !== normEmail(tech.email)) {
    checks.push(entry("Tech record", "WARN", "email is not normalized",
      "Stored as '" + tech.email + "'; auth lookup uses lowercase + trim, so this may still work but is fragile."));
  } else {
    checks.push(entry("Tech record", "PASS", "email normalized · " + tech.email));
  }
  if (!tech.id) {
    checks.push(entry("Tech record", "FAIL", "tech slug missing (doc id)"));
  } else {
    checks.push(entry("Tech record", "PASS", "tech slug · " + tech.id));
  }
  if (!String(tech.display_name || "").trim()) {
    checks.push(entry("Tech record", "FAIL", "display_name empty"));
  } else {
    checks.push(entry("Tech record", "PASS", "display_name · " + tech.display_name));
  }
  // Cleaning techs are inferred (not stored) — but flag if cleaning_techs
  // has a `role` field that suggests it's not a cleaning_tech.
  const r = String(tech.role || "").toLowerCase();
  if (r && r !== "cleaning_tech" && r !== "tech") {
    checks.push(entry("Tech record", "WARN", "cleaning_techs.role looks unusual",
      "Stored role = '" + tech.role + "'. App treats every active cleaning_techs row as a cleaning tech."));
  }
}

async function checkDeputyMapping(db, tech, checks) {
  const email = normEmail(tech.email);
  const slug  = tech.id;
  if (!email) {
    checks.push(entry("Deputy mapping", "FAIL", "Cannot check — tech email missing"));
    return { upcoming: [] };
  }
  // Deputy employee mapping fields on the cleaning_techs doc.
  const deputyEmail = normEmail(tech.deputy_employee_email);
  if (deputyEmail && deputyEmail !== email) {
    checks.push(entry("Deputy mapping", "FAIL",
      "deputy_employee_email differs from tech email",
      "Tech email '" + email + "' vs Deputy '" + deputyEmail + "'. Deputy sync will tag shifts under the wrong email and the rule will deny reads."));
  } else if (deputyEmail) {
    checks.push(entry("Deputy mapping", "PASS", "deputy_employee_email matches tech email"));
  } else {
    checks.push(entry("Deputy mapping", "WARN",
      "deputy_employee_email not stored on cleaning_techs",
      "App will fall back to employee_slug match. Set deputy_employee_email or deputy_employee_id to harden ownership."));
  }
  if (tech.deputy_employee_id == null || tech.deputy_employee_id === "") {
    checks.push(entry("Deputy mapping", "WARN",
      "deputy_employee_id missing",
      "Without this, the Deputy sync can't tag shifts to this tech reliably. Set it in Admin → Cleaning Techs."));
  } else {
    checks.push(entry("Deputy mapping", "PASS", "deputy_employee_id · " + tech.deputy_employee_id));
  }
  // Upcoming 7-day shifts.
  const dateRange = upcomingDateStrings(7);
  let upcoming = [];
  try {
    // Firestore `in` cap is 30 — 7 is fine.
    const snap = await db.collection("deputy_shift_cache")
      .where("sync_date", "in", dateRange)
      .where("employee_email", "==", email)
      .get();
    upcoming = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  } catch (err) {
    checks.push(entry("Deputy mapping", "FAIL",
      "Shift cache query failed",
      (err && err.code) || (err && err.message) || "unknown"));
    return { upcoming: [] };
  }
  if (upcoming.length === 0) {
    // Try slug fallback so we report "shifts exist but were tagged with the slug, not the email."
    let bySlug = [];
    try {
      const snap2 = await db.collection("deputy_shift_cache")
        .where("sync_date", "in", dateRange)
        .where("employee_slug", "==", slug)
        .get();
      bySlug = snap2.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (_e) {}
    if (bySlug.length > 0) {
      checks.push(entry("Deputy mapping", "FAIL",
        "Upcoming shifts exist but employee_email is wrong",
        bySlug.length + " shift(s) found by slug. Refresh Deputy after fixing deputy_employee_email so shifts get re-tagged."));
    } else {
      checks.push(entry("Deputy mapping", "WARN",
        "No upcoming shifts in next 7 days",
        "If this tech is on the pilot roster, post a Deputy shift and re-run."));
    }
    return { upcoming: [] };
  }
  checks.push(entry("Deputy mapping", "PASS",
    upcoming.length + " upcoming shift(s) in next 7 days",
    upcoming.map(function (s) {
      return s.sync_date + " · " + (s.customer_name || "(no customer)");
    }).join(" | ")));
  // Confirm each shift's email is normalized — silent normalization bugs
  // bite at write time.
  const misnormalized = upcoming.filter(function (s) {
    return s.employee_email && s.employee_email !== normEmail(s.employee_email);
  });
  if (misnormalized.length > 0) {
    checks.push(entry("Deputy mapping", "WARN",
      misnormalized.length + " shift(s) carry non-normalized employee_email",
      "Rule lowercases auth.email before compare — these would still match, but downstream code that does strict-equal may break."));
  }
  return { upcoming: upcoming };
}

function checkPermissionsStructural(tech, authUser, upcoming, checks) {
  const email = normEmail(tech.email);
  const authEmail = authUser ? normEmail(authUser.email) : "";

  // Read Today's Work / Team Hub — gated by `whoAmI`-style role check.
  // Structurally requires: auth user + cleaning_techs row + active + dcr_enabled.
  if (authUser && tech.active !== false && tech.dcr_enabled !== false) {
    checks.push(entry("Permissions", "PASS", "Team Hub + Today's Work readable",
      "Auth user + active cleaning_techs row + dcr_enabled — STAFF_AUTH will let them through."));
  } else {
    checks.push(entry("Permissions", "FAIL", "Cannot read Team Hub / Today's Work",
      "Missing one of: auth user, active=true, dcr_enabled=true."));
  }

  // Read own shift docs — rule on deputy_shift_cache requires
  // resource.data.employee_email == auth.token.email.lower().
  if (upcoming.length === 0) {
    checks.push(entry("Permissions", "WARN",
      "Cannot validate shift-read permission",
      "No upcoming shifts to test against. Will recover once Deputy posts one."));
  } else {
    const mismatches = upcoming.filter(function (s) {
      return normEmail(s.employee_email) !== authEmail;
    });
    if (mismatches.length === 0) {
      checks.push(entry("Permissions", "PASS",
        "All upcoming shifts' employee_email match auth email",
        "deputy_shift_cache read rule will allow."));
    } else {
      checks.push(entry("Permissions", "FAIL",
        mismatches.length + " upcoming shift(s) have wrong employee_email",
        "Rule denies read for these. Mismatched on: " +
        mismatches.map(function (s) { return s.sync_date + "/" + s.id; }).join(", ")));
    }
  }

  // Create/update pioneer_work_sessions — rule shiftBelongsToCaller()
  // requires deputy_shift_cache/{shiftId}.employee_email == auth email.
  // SAME structural check as shift-read above, but a separate entry
  // because the user explicitly asked for it in the spec.
  if (upcoming.length === 0) {
    checks.push(entry("Permissions", "WARN",
      "Cannot validate Start/Finish Work write",
      "No upcoming shift to simulate against."));
  } else {
    const writeOk = upcoming.every(function (s) {
      return normEmail(s.employee_email) === authEmail;
    });
    checks.push(entry("Permissions", writeOk ? "PASS" : "FAIL",
      writeOk
        ? "pioneer_work_sessions create/update allowed for upcoming shifts"
        : "pioneer_work_sessions write would be denied for ≥1 shift",
      writeOk ? "shiftBelongsToCaller() will return true." :
        "shiftBelongsToCaller() returns false where employee_email != auth email."));
  }

  // DCR submit — server enforces ownership via tech_email; same structural
  // input. Customer Info / SOP read is gated by the customers rule which
  // is open to signed-in staff (handled below in customer mapping).
  checks.push(entry("Permissions", authUser ? "PASS" : "FAIL",
    "DCR submission identity stamp present",
    authUser ? "submitDcrV1 will accept the bearer token." : "No auth user → submit will 401."));

  // Supply request, callout, time-off — open to any signed-in staff.
  if (authUser) {
    checks.push(entry("Permissions", "PASS",
      "Supply request + call-out + time-off create allowed",
      "Rules allow any signed-in staff on these collections."));
  } else {
    checks.push(entry("Permissions", "FAIL",
      "Supply request + call-out + time-off blocked",
      "No auth user."));
  }

  // Admin gating — cleaning_techs are NOT in ALLOWED_ADMIN_EMAILS and
  // should NOT have an active /admins/{email} doc.
  // (We don't check /admins from here for non-admins — too noisy. The
  // structural check is: if the tech is also flagged admin somehow,
  // surface it for the office to triage. Otherwise PASS quietly.)
  const isHardcodedAdmin = ALLOWED_ADMIN_EMAILS.indexOf(email) >= 0;
  if (isHardcodedAdmin) {
    checks.push(entry("Permissions", "WARN",
      "Tech email is on the hardcoded admin list",
      "This tech also has admin access. Confirm that's intentional."));
  } else {
    checks.push(entry("Permissions", "PASS",
      "Tech is not flagged as admin",
      "Admin surfaces will be hidden."));
  }
}

async function checkCustomers(db, upcoming, checks) {
  if (upcoming.length === 0) {
    checks.push(entry("Customers", "WARN",
      "No upcoming shifts to validate customer mapping for"));
    return;
  }
  const seenSlugs = Object.create(null);
  for (let i = 0; i < upcoming.length; i++) {
    const s = upcoming[i];
    if (!s.customer_name && !s.customer_slug) {
      // PioneerOps already designs for this — the card renders as UNKNOWN
      // with an inline customer picker, and the tech picks at DCR time.
      // It's worth surfacing (the office may want to fix in Deputy) but
      // not a blocker.
      checks.push(entry("Customers", "WARN",
        "Shift " + s.id + " has no customer (Deputy area blank)",
        "sync_date=" + s.sync_date + " — tech will see UNKNOWN card with customer picker. Fix the Deputy area mapping to remove the extra step."));
      continue;
    }
    if (!s.customer_slug) {
      checks.push(entry("Customers", "WARN",
        "Shift " + s.id + " has customer_name but no slug",
        "Card will show 'Suggested' / UNKNOWN until tech confirms customer on DCR."));
      continue;
    }
    if (seenSlugs[s.customer_slug]) continue;
    seenSlugs[s.customer_slug] = true;
    let custSnap;
    try {
      custSnap = await db.collection("customers").doc(s.customer_slug).get();
    } catch (err) {
      checks.push(entry("Customers", "FAIL",
        "Customer lookup failed for slug " + s.customer_slug,
        (err && err.code) || (err && err.message)));
      continue;
    }
    if (!custSnap.exists) {
      checks.push(entry("Customers", "FAIL",
        "customers/" + s.customer_slug + " does not exist",
        "Shift's customer_slug points at a missing doc. Reseed customer or fix the slug."));
      continue;
    }
    const c = custSnap.data() || {};
    if (c.active === false) {
      checks.push(entry("Customers", "FAIL",
        "Customer " + s.customer_slug + " is archived",
        "Tech will see the customer but Customer Info reads may surface empty state. Re-activate or update the shift."));
      continue;
    }
    if (!String(c.customer_name || c.name || "").trim()) {
      checks.push(entry("Customers", "WARN",
        "Customer " + s.customer_slug + " has no name",
        "Card label will fall back to slug."));
    }
    const hasSop = (Array.isArray(c.sopQuickGlance) && c.sopQuickGlance.length > 0) ||
                   c.hasSecureSop === true ||
                   !!c.sopMarkdown;
    if (!hasSop) {
      checks.push(entry("Customers", "WARN",
        "Customer " + s.customer_slug + " has no SOP content",
        "Tech sees 'No SOP yet' empty state — that's safe, but tonight's run loses SOP detail."));
    } else {
      checks.push(entry("Customers", "PASS",
        "Customer " + s.customer_slug + " ready",
        (c.customer_name || c.name) + " · sopQuickGlance=" + (Array.isArray(c.sopQuickGlance) ? c.sopQuickGlance.length : 0) +
        " · hasSecureSop=" + (c.hasSecureSop === true)));
    }
  }
}

async function checkAnnouncements(db, authUser, checks) {
  if (!authUser) {
    checks.push(entry("Announcements", "WARN",
      "Cannot check — no auth user"));
    return;
  }
  let annSnap, readSnap;
  try {
    [annSnap, readSnap] = await Promise.all([
      db.collection("announcements").where("active", "==", true).get(),
      db.collection("announcement_reads").where("uid", "==", authUser.uid).get()
    ]);
  } catch (err) {
    checks.push(entry("Announcements", "WARN",
      "Announcement state lookup failed (non-fatal)",
      (err && err.code) || (err && err.message)));
    return;
  }
  const reads = Object.create(null);
  readSnap.docs.forEach(function (d) {
    const x = d.data() || {};
    if (!x.announcement_id) return;
    reads[x.announcement_id] = Number(x.version) || 1;
  });
  const now = Date.now();
  function annTsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }
  const pending = annSnap.docs
    .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
    .filter(function (a) {
      if (a.archived_at) return false;
      if (a.active === false) return false;
      const startMs = annTsToMs(a.starts_at);
      if (startMs != null && startMs > now) return false;
      const expMs = annTsToMs(a.expires_at);
      if (expMs != null && expMs <= now) return false;
      return a.mandatory === true;
    })
    .filter(function (a) {
      const v = Number(a.version) || 1;
      return (reads[a.id] || 0) < v;
    });
  if (pending.length === 0) {
    checks.push(entry("Announcements", "PASS",
      "No pending mandatory announcements"));
  } else {
    checks.push(entry("Announcements", "WARN",
      pending.length + " pending mandatory announcement(s)",
      "Tech will see the modal on first load. " +
      "Hardened in /work.html · v20260526-scrolldeputy — body overflow now clears even if the modal close partially fails. " +
      "Pending IDs: " + pending.map(function (a) { return a.id; }).join(", ")));
  }
}

function appendMobileSafetyNote(checks) {
  // The script can't poke iOS Safari. The hardened scroll-lock + Deputy
  // toast shipped today addresses the regressions Makaila hit. Record
  // it as an info entry so the report calls out the manual step.
  checks.push(entry("Mobile safety", "WARN",
    "Manual verification required",
    "On the tech's iPhone: open /work.html, dismiss any announcement, confirm vertical scroll works, tap Start Work, confirm the Deputy toast appears (no auto-navigation 404). Hardened in v20260526-scrolldeputy."));
}

/* --------------------------------------------------------------------
 * Public API.
 *
 * runReadinessForTechs(admin, { limit, techSlug })
 *   admin     — initialized firebase-admin module (caller owns lifecycle)
 *   limit     — cap on techs checked (debug). 0 / undefined = all.
 *   techSlug  — restrict to one tech (debug).
 *
 * Returns:
 *   {
 *     generated_at: ISO string,
 *     summary: { tech_count, pass, warn, fail },
 *     techs: [ { tech_slug, display_name, email, overall, checks: [...] } ]
 *   }
 * ------------------------------------------------------------------ */
async function runReadinessForTechs(admin, options) {
  options = options || {};
  const db = admin.firestore();

  // 1. Resolve the tech roster — only active records.
  let techSnap;
  try {
    techSnap = await db.collection(TECHS_COLLECTION).get();
  } catch (err) {
    return {
      generated_at: new Date().toISOString(),
      summary: { tech_count: 0, pass: 0, warn: 0, fail: 1 },
      techs: [{
        tech_slug:    "(roster)",
        display_name: "(roster lookup)",
        email:        "",
        overall:      "FAIL",
        checks: [entry("Roster", "FAIL", "cleaning_techs collection read failed",
          (err && err.code) || (err && err.message))]
      }]
    };
  }

  let techs = techSnap.docs
    .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
    .filter(function (t) { return t.active !== false; });

  if (options.techSlug) {
    techs = techs.filter(function (t) { return t.id === options.techSlug; });
  }
  if (options.limit && options.limit > 0) {
    techs = techs.slice(0, options.limit);
  }

  // Stable order by display_name for readability.
  techs.sort(function (a, b) {
    return String(a.display_name || a.id).localeCompare(String(b.display_name || b.id));
  });

  const results = [];
  for (let i = 0; i < techs.length; i++) {
    const tech = techs[i];
    const checks = [];
    const authRes  = await checkAuth(admin, tech, checks);
    checkTechRecord(tech, checks);
    const deputyRes = await checkDeputyMapping(db, tech, checks);
    checkPermissionsStructural(tech, authRes.user, deputyRes.upcoming, checks);
    await checkCustomers(db, deputyRes.upcoming, checks);
    await checkAnnouncements(db, authRes.user, checks);
    appendMobileSafetyNote(checks);
    results.push({
      tech_slug:    tech.id,
      display_name: tech.display_name || tech.id,
      email:        normEmail(tech.email),
      overall:      rollup(checks),
      checks:       checks
    });
  }

  const summary = { tech_count: results.length, pass: 0, warn: 0, fail: 0 };
  results.forEach(function (r) {
    if (r.overall === "PASS") summary.pass++;
    else if (r.overall === "WARN") summary.warn++;
    else summary.fail++;
  });

  return {
    generated_at: new Date().toISOString(),
    summary:      summary,
    techs:        results
  };
}

module.exports = {
  runReadinessForTechs: runReadinessForTechs,
  // Exposed for unit-testable consumers.
  _internal: {
    normEmail:           normEmail,
    pacificDateString:   pacificDateString,
    upcomingDateStrings: upcomingDateStrings,
    entry:               entry,
    rollup:              rollup
  }
};
