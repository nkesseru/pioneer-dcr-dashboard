/* ============================================================================
 * ceo.js — Executive Mission Control
 *
 * Surface: /ceo
 * Audience: executive + owner roles (initially April + Nick).
 * Aesthetic: luxury wellness app, not enterprise dashboard.
 *
 * Auth model:
 *   Hardcoded role allowlists mirror firestore.rules:isPioneerExecutive() and
 *   functions/index.js:ALLOWED_EXECUTIVE_EMAILS. /admins/{email} can opt a
 *   user UP to admin tier but cannot promote to executive — promotion is a
 *   deploy. This stays in sync until the role-management UI ships.
 *
 * Sections (top to bottom):
 *   1.  Company Health   — composite Operational Health %, 4 pillar tiles
 *   1B. Today's Actions  — 1-3 action cards (auto-suggestions + ceo_tasks)
 *   2.  Dangers          — "Where to lead this week" — calm, guiding
 *   3.  Opportunities    — "What is working" — wins, momentum
 *   4.  Scorecards       — Operations / People / Quality / Hiring (30d)
 *   5.  Leadership Pulse — personal accomplishments + items on your desk
 *
 * Action Layer (Phase 1B):
 *   - Cap of 3 cards total to prevent stacking clutter.
 *   - Cards are either a TASK (already in ceo_tasks, status=open) or a
 *     SUGGESTION (computed from current data).
 *   - Dedup by (sourceType + sourceId + category) — a suggestion whose
 *     triple matches an open task is suppressed; the task itself shows.
 *   - Create Task is idempotent at the UI layer: client queries for an
 *     existing open task before writing. Race window is tiny + visible.
 *
 * Reads (live, on load):
 *   office_manager_hiring_snapshots, cleaning_techs, pioneer_service_sessions,
 *   service_assignments, dcr_issues, inspections, customer_feedback,
 *   customer_complaints, call_outs, open_shift_requests, service_recoveries,
 *   rockstar_bonuses, quality_wins, time_adjustment_requests,
 *   office_manager_improvements, office_manager_reflections,
 *   office_manager_bottlenecks
 *
 * Writes: none. This surface is read-only by design.
 * ========================================================================== */

(function () {
  'use strict';

  /* ---------------- Role allowlist (mirrors firestore.rules) ---------------- */

  const OWNER_EMAILS = [
    'nick@pioneercomclean.com',
    'april@pioneercomclean.com'
  ];
  const EXECUTIVE_EMAILS = [
    'april@pioneercomclean.com'
  ];

  function isExecutiveOrOwner(email) {
    if (!email) return false;
    const lc = String(email).toLowerCase().trim();
    return OWNER_EMAILS.indexOf(lc) >= 0 || EXECUTIVE_EMAILS.indexOf(lc) >= 0;
  }

  /* ---------------- DOM helpers ---------------- */

  function $(id)  { return document.getElementById(id); }
  function show(id) { const el = $(id); if (el) el.classList.remove('ceo-hidden'); }
  function hide(id) { const el = $(id); if (el) el.classList.add('ceo-hidden'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showState(name, ctx) {
    ['ceo-state-signin', 'ceo-state-denied', 'ceo-state-loading', 'ceo-state-content']
      .forEach(hide);
    show('ceo-state-' + name);
    if (name === 'denied' && ctx && ctx.email) {
      const e = $('ceo-denied-email');
      if (e) e.textContent = 'Signed in as ' + ctx.email;
    }
  }

  /* ---------------- Date / time helpers ---------------- */

  function pacificDateString() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }
  function fmtTodayLong() {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long', month: 'long', day: 'numeric'
    }).format(new Date());
  }
  function fmtHourPart() {
    const h = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
    }).format(new Date()), 10);
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }
  function firstName(user) {
    if (!user) return 'there';
    if (user.displayName) return user.displayName.split(/\s+/)[0];
    if (user.email) return user.email.split('@')[0];
    return 'there';
  }
  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'object' && typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts === 'object' && typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    if (ts instanceof Date) return ts.getTime();
    return 0;
  }

  /* ---------------- Auth flow ---------------- */

  const firebaseApp  = firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth         = firebase.auth();
  const db           = firebase.firestore();
  let currentUser    = null;

  auth.onAuthStateChanged(handleAuthChange);

  async function handleAuthChange(user) {
    if (!user) {
      currentUser = null;
      showState('signin');
      return;
    }
    const email = (user.email || '').toLowerCase();
    if (!isExecutiveOrOwner(email)) {
      currentUser = null;
      showState('denied', { email: email || '(no email)' });
      return;
    }
    currentUser = user;
    showState('loading');
    paintHero();
    try {
      const snap = await loadEverything();
      render(snap);
      showState('content');
    } catch (err) {
      console.error('[ceo] load failed', err);
      // Still show content with whatever rendered — let user see partials.
      showState('content');
    }
  }

  function paintHero() {
    const g = $('ceo-greeting');
    if (g) {
      g.innerHTML = escapeHtml(fmtHourPart()) + ', <em>' +
                    escapeHtml(firstName(currentUser)) + '</em>.';
    }
    const d = $('ceo-date-label');
    if (d) d.textContent = fmtTodayLong();
  }

  function bindSignIn() {
    const btn = $('ceo-signin-btn');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      try {
        await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
      } catch (err) {
        console.error('[ceo] sign-in failed', err);
        btn.disabled = false;
      }
    });
  }

  /* ---------------- Data loader ---------------- */

  async function loadEverything() {
    const todayPT       = pacificDateString();
    const now           = Date.now();
    const sevenDaysAgo  = now - 7  * 86400000;
    const fourteenDaysAgo = now - 14 * 86400000;
    const thirtyDaysAgo = now - 30 * 86400000;
    const sixtyDaysAgo  = now - 60 * 86400000;

    function safe(label, p) {
      return p.then(
        function (val) { return { ok: true, val: val }; },
        function (err) {
          console.warn('[ceo] read failed: ' + label, err && (err.message || err));
          return { ok: false, label: label };
        }
      );
    }

    // ISO-date strings for service_date range queries
    const sevenDaysAgoYMD = new Date(sevenDaysAgo).toISOString().slice(0, 10);
    const thirtyDaysAgoYMD = new Date(thirtyDaysAgo).toISOString().slice(0, 10);

    const reads = await Promise.all([
      // 0. hiring snapshot — latest
      safe('hiring_snap', db.collection('office_manager_hiring_snapshots')
        .orderBy('snapshot_date', 'desc').limit(1).get()
        .catch(function () { return { docs: [] }; })),
      // 1. cleaning_techs (all — for active count)
      safe('techs', db.collection('cleaning_techs').get()),
      // 2. pioneer_service_sessions last 30d (by service_date)
      safe('sessions', db.collection('pioneer_service_sessions')
        .where('service_date', '>=', thirtyDaysAgoYMD)
        .where('service_date', '<=', todayPT).get()),
      // 3. service_assignments last 30d
      safe('assignments', db.collection('service_assignments')
        .where('service_date', '>=', thirtyDaysAgoYMD)
        .where('service_date', '<=', todayPT).get()),
      // 4. dcr_issues last 200 (cap)
      safe('dcr_issues', db.collection('dcr_issues')
        .orderBy('created_at', 'desc').limit(200).get()),
      // 5. inspections last 30 (most recent)
      safe('inspections', db.collection('inspections')
        .orderBy('inspection_date', 'desc').limit(60).get()
        .catch(function () { return { docs: [] }; })),
      // 6. customer_feedback last 50
      safe('feedback', db.collection('customer_feedback')
        .orderBy('created_at', 'desc').limit(50).get()
        .catch(function () { return { docs: [] }; })),
      // 7. customer_complaints last 60 (status mix)
      safe('complaints', db.collection('customer_complaints')
        .orderBy('created_at', 'desc').limit(60).get()
        .catch(function () { return { docs: [] }; })),
      // 8. call_outs last 50
      safe('call_outs', db.collection('call_outs')
        .orderBy('created_at', 'desc').limit(50).get()),
      // 9. open_shift_requests (full small set)
      safe('open_shifts', db.collection('open_shift_requests')
        .where('status', '==', 'open').get()),
      // 10. service_recoveries open
      safe('recoveries', db.collection('service_recoveries')
        .where('status', '==', 'open').get()
        .catch(function () { return { docs: [] }; })),
      // 11. rockstar_bonuses last 50
      safe('rockstars', db.collection('rockstar_bonuses')
        .orderBy('created_at', 'desc').limit(50).get()
        .catch(function () { return { docs: [] }; })),
      // 12. quality_wins last 50
      safe('quality_wins', db.collection('quality_wins')
        .orderBy('created_at', 'desc').limit(50).get()
        .catch(function () { return { docs: [] }; })),
      // 13. time_adjustment_requests pending
      safe('time_adj', db.collection('time_adjustment_requests')
        .where('status', '==', 'pending').get()),
      // 14. office_manager_improvements (cap 100)
      safe('improvements', db.collection('office_manager_improvements')
        .orderBy('created_at', 'desc').limit(100).get()),
      // 15. office_manager_reflections (today)
      safe('om_reflection_today', db.collection('office_manager_reflections')
        .orderBy('created_at', 'desc').limit(7).get()),
      // 16. office_manager_bottlenecks (today)
      safe('om_bottleneck_today', db.collection('office_manager_bottlenecks')
        .orderBy('created_at', 'desc').limit(7).get()),
      // 17. ceo_tasks — Phase 1B action queue, open only.
      // Limit 50 is well above the 3-card cap so we never miss an open task.
      safe('ceo_tasks_open', db.collection('ceo_tasks')
        .where('status', '==', 'open')
        .orderBy('createdAt', 'desc').limit(50).get()
        .catch(function () { return { docs: [] }; })),
      // 18. ceo_tasks — Phase 1D recent handled by THIS exec (history +
      // today's progress count + suggestion same-day dedup).
      safe('ceo_tasks_recent', db.collection('ceo_tasks')
        .where('createdBy', '==', (currentUser && currentUser.email ? currentUser.email.toLowerCase() : ''))
        .orderBy('completedAt', 'desc').limit(30).get()
        .catch(function () { return { docs: [] }; })),
      // 19. leadership_messages — Phase 1D recent by THIS exec (streak +
      // history + today's queued/recognition counts).
      safe('leadership_msgs_recent', db.collection('leadership_messages')
        .where('createdBy', '==', (currentUser && currentUser.email ? currentUser.email.toLowerCase() : ''))
        .orderBy('createdAt', 'desc').limit(60).get()
        .catch(function () { return { docs: [] }; }))
    ]);

    function docs(idx) {
      const r = reads[idx];
      if (!r.ok) return [];
      if (r.val && r.val.docs) return r.val.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      return [];
    }

    const hiringSnaps = docs(0);

    return {
      todayPT:       todayPT,
      now:           now,
      sevenDaysAgo:  sevenDaysAgo,
      fourteenDaysAgo: fourteenDaysAgo,
      thirtyDaysAgo: thirtyDaysAgo,
      sixtyDaysAgo:  sixtyDaysAgo,
      hiring:        hiringSnaps.length ? hiringSnaps[0] : null,
      techs:         docs(1),
      sessions:      docs(2),
      assignments:   docs(3),
      dcrIssues:     docs(4),
      inspections:   docs(5),
      feedback:      docs(6),
      complaints:    docs(7),
      callOuts:      docs(8),
      openShifts:    docs(9),
      recoveries:    docs(10),
      rockstars:     docs(11),
      qualityWins:   docs(12),
      timeAdj:       docs(13),
      improvements:  docs(14),
      omReflections: docs(15),
      omBottlenecks: docs(16),
      openTasks:     docs(17),
      recentTasks:   docs(18),
      recentMessages: docs(19)
    };
  }

  /* ---------------- Scoring ---------------- */

  function scoreQuality(insps) {
    if (!insps || !insps.length) return 85;
    // Inspection scores are 0-5; some old rows may be 0-100. Detect and normalize.
    let sum = 0, n = 0;
    insps.forEach(function (i) {
      const s = Number(i.overall_score);
      if (Number.isFinite(s)) {
        sum += (s > 5 ? s : s * 20);
        n++;
      }
    });
    if (!n) return 85;
    return Math.round(Math.max(0, Math.min(100, sum / n)));
  }

  function scoreStaffing(openShifts48h, callouts7d, activeTechs) {
    if (activeTechs === 0) return 0;
    let s = 100;
    s -= openShifts48h * 8;
    s -= callouts7d * 4;
    return Math.max(0, Math.min(100, s));
  }

  function scoreService(assignments) {
    if (!assignments || !assignments.length) return 85;
    let submitted = 0, finished = 0;
    assignments.forEach(function (a) {
      const isDone = (a.status === 'completed' || a.dcr_submitted === true);
      if (isDone) {
        finished++;
        if (a.dcr_submitted === true) submitted++;
      }
    });
    if (finished === 0) return 85;
    return Math.round((submitted / finished) * 100);
  }

  function scoreCustomer(complaints, recoveries, chronicCustomerCount) {
    let s = 100;
    const openComplaints = complaints.filter(function (c) {
      const st = String(c.status || '').toLowerCase();
      return st !== 'resolved' && st !== 'closed';
    }).length;
    const openRecoveries = recoveries.length;
    s -= openComplaints * 8;
    s -= openRecoveries * 4;
    s -= chronicCustomerCount * 6;
    return Math.max(0, Math.min(100, s));
  }

  function scoreHiring(snap) {
    if (!snap) return 75;
    const a7  = Number(snap.applicants_7d  || 0);
    const a30 = Number(snap.applicants_30d || 0);
    if (a30 === 0) return 50;       // no flow at all
    if (a7  === 0) return 65;       // flow stalling
    if (a7 >= 5)   return 95;
    return 85;
  }

  function calcCompanyHealth(snap) {
    const insps  = snap.inspections;
    const techs  = snap.techs.filter(function (t) { return t.active !== false; });

    // Open shifts within 48h
    const now    = snap.now;
    const cutoff48 = now + 48 * 3600000;
    const openShifts48h = snap.openShifts.filter(function (s) {
      const ms = tsToMs(s.shift_date) || tsToMs(s.start_at) || 0;
      return ms > 0 && ms <= cutoff48;
    }).length;

    const callouts7d = snap.callOuts.filter(function (c) {
      return tsToMs(c.created_at) >= snap.sevenDaysAgo;
    }).length;

    // Chronic-issue customers: 3+ DCR issues in last 30d
    const issuesByCustomer = {};
    snap.dcrIssues.forEach(function (i) {
      if (tsToMs(i.created_at) < snap.thirtyDaysAgo) return;
      const k = i.customer_slug || i.customer || '(unknown)';
      issuesByCustomer[k] = (issuesByCustomer[k] || 0) + 1;
    });
    const chronicCount = Object.values(issuesByCustomer).filter(function (n) { return n >= 3; }).length;

    const pillars = {
      quality:  scoreQuality(insps),
      staffing: scoreStaffing(openShifts48h, callouts7d, techs.length),
      service:  scoreService(snap.assignments),
      customer: scoreCustomer(snap.complaints, snap.recoveries, chronicCount),
      hiring:   scoreHiring(snap.hiring)
    };
    const avg = Math.round(
      (pillars.quality + pillars.staffing + pillars.service + pillars.customer + pillars.hiring) / 5
    );
    return { score: avg, pillars: pillars,
             openShifts48h: openShifts48h, callouts7d: callouts7d,
             chronicCount: chronicCount, activeTechs: techs.length,
             issuesByCustomer: issuesByCustomer };
  }

  /* ---------------- Renderers ---------------- */

  // Cached for in-place re-renders (Action Layer Create/Done/Dismiss).
  let cachedSnap   = null;
  let cachedHealth = null;

  function render(snap) {
    const health = calcCompanyHealth(snap);
    cachedSnap   = snap;
    cachedHealth = health;
    renderCompanyHealth(snap, health);
    renderActions(snap, health);
    renderDangers(snap, health);
    renderOpportunities(snap, health);
    renderScorecards(snap, health);
    renderRecentActivity(snap);
    renderLeadershipPulse(snap, health);
    // Phase 3B — Open Conversations preview. Fires its own read; soft-fails.
    renderOpenConvosPreview().catch(function (err) {
      console.warn('[ceo] open convos preview failed', err);
    });
    // Phase Inspection 3 — registry rollup. Soft-fails independently.
    renderInspectionRollup().catch(function (err) {
      console.warn('[ceo] inspection rollup failed', err);
    });
    // Phase Customer Economics v1 — Revenue Per Labor Hour card.
    // Reads customer_economics/current. Soft-fails independently —
    // sync runs daily via syncFinancialPulseV1.
    renderCustomerEconomics().catch(function (err) {
      console.warn('[ceo] customer economics failed', err);
    });
    // Phase 30 — Financial Pulse card. Reads financial_pulse/current.
    // Sync runs daily via syncCeoFinancialPulseV1. Soft-fails so a QBO
    // outage doesn't blank the whole CEO surface.
    renderFinancialPulse().catch(function (err) {
      console.warn('[ceo] financial pulse failed', err);
    });
  }

  // ---- Section 1: Company Health ----

  function renderCompanyHealth(snap, health) {
    $('ceo-health-score').textContent = String(health.score);
    $('ceo-health-label').textContent = healthLabelFor(health.score);

    // Supporting pillars — 4 oversized tiles to the right of the score
    const sessionsLast7 = snap.sessions.filter(function (s) {
      return tsToMs(s.clock_in_at) >= snap.sevenDaysAgo ||
             (s.service_date && Date.parse(s.service_date + 'T00:00:00Z') >= snap.sevenDaysAgo);
    }).length;

    const customersServed7 = new Set();
    snap.assignments.forEach(function (a) {
      const ms = a.service_date ? Date.parse(a.service_date + 'T00:00:00Z') : 0;
      if (ms >= snap.sevenDaysAgo && a.customer_slug) customersServed7.add(a.customer_slug);
    });

    const hiring = snap.hiring || {};
    const a30 = hiring.applicants_30d != null ? hiring.applicants_30d : '—';
    const h30 = hiring.hires != null ? hiring.hires : '—';

    const pillarsHtml = [
      pillarHtml('Active Team',       health.activeTechs,
                 health.activeTechs === 1 ? 'cleaner on the field' : 'cleaners on the field'),
      pillarHtml('Sessions This Week', sessionsLast7,
                 customersServed7.size + ' customer' + (customersServed7.size === 1 ? '' : 's') + ' served'),
      pillarHtml('Quality Score',     fmtScoreOutOf(health.pillars.quality),
                 snap.inspections.length ? 'across recent inspections' : 'baseline (no inspections yet)'),
      pillarHtml('Hiring Pipeline',   a30,
                 h30 + ' hire' + (h30 === 1 ? '' : 's') + ' last 30 days')
    ].join('');
    $('ceo-health-pillars').innerHTML = pillarsHtml;
  }

  function pillarHtml(label, value, context) {
    return '<div class="ceo-pillar">' +
             '<p class="ceo-pillar-label">' + escapeHtml(label) + '</p>' +
             '<div class="ceo-pillar-value">' + escapeHtml(value) + '</div>' +
             '<p class="ceo-pillar-context">' + escapeHtml(context) + '</p>' +
           '</div>';
  }

  function healthLabelFor(score) {
    if (score >= 92) return 'Operational Health';
    if (score >= 80) return 'Operational Health · steady';
    if (score >= 65) return 'Operational Health · watch';
    return 'Operational Health · needs care';
  }

  function fmtScoreOutOf(score) {
    // Quality score is 0-100; show as fraction out of 100 to feel natural
    return String(Math.round(score)) + '%';
  }

  // ---- Section 1B: Today's CEO Actions ----------------------------------

  const MAX_ACTIONS = 3;

  const CATEGORY_LABEL = {
    customer:   'Customer',
    staffing:   'Staffing',
    hiring:     'Hiring',
    leadership: 'Leadership',
    finance:    'Finance'
  };

  // Generate up to ~6 auto-suggestions from the current snapshot, in
  // priority order. Each suggestion is a candidate for the action card
  // grid; merged with open tasks and capped at MAX_ACTIONS downstream.
  function generateSuggestions(snap, health) {
    const out = [];
    const now = snap.now;

    // 1) 48-hour coverage gap — immediate operational
    if (health.openShifts48h > 0) {
      out.push({
        sourceType: 'coverage_gap_48h',
        sourceId:   snap.todayPT,
        category:   'staffing',
        title:      health.openShifts48h + ' open shift' +
                    (health.openShifts48h === 1 ? '' : 's') + ' in the next 48 hours',
        why:        'Coverage is the first promise Pioneer makes to customers. Every uncovered shift puts a relationship at risk.',
        next:       'Lock in coverage now while options exist — call, text, or post to the open-shift board.',
        openLabel:  'Manager view',
        openHref:   '/manager',
        description: 'Resolve all open shifts on the board within the next 48 hours.'
      });
    }

    // 2) Unresolved customer complaint > 48h — reputation risk
    const stale = snap.complaints.filter(function (c) {
      const st = String(c.status || '').toLowerCase();
      const created = tsToMs(c.created_at);
      return st !== 'resolved' && st !== 'closed'
          && created > 0 && (now - created) > 48 * 3600000;
    });
    if (stale.length) {
      const oldest = stale.sort(function (a, b) { return tsToMs(a.created_at) - tsToMs(b.created_at); })[0];
      out.push({
        sourceType: 'unresolved_complaint',
        sourceId:   oldest._id || 'unknown',
        category:   'customer',
        title:      stale.length + ' complaint' + (stale.length === 1 ? '' : 's') +
                    ' open longer than 48 hours',
        why:        'A complaint left open past 48 hours usually means the customer feels unheard. Time matters more than the resolution itself.',
        next:       'Read the oldest one personally, then call the customer today.',
        openLabel:  'Review in admin',
        openHref:   '/admin',
        description: 'Personally close the loop on every complaint older than 48 hours.'
      });
    }

    // 3) Repeat customer issue — chronic 3+ DCR issues in 30d
    const chronicEntries = Object.entries(health.issuesByCustomer)
      .filter(function (e) { return e[1] >= 3; })
      .sort(function (a, b) { return b[1] - a[1]; });
    if (chronicEntries.length) {
      const top = chronicEntries[0];
      out.push({
        sourceType: 'chronic_customer_issue',
        sourceId:   top[0],
        category:   'customer',
        title:      'Repeat issues at ' + top[0] + ' (' + top[1] + ' this month)',
        why:        'Repeat concerns are the earliest signal of cancellation risk. A short personal call often resets the relationship.',
        next:       'Review the recent DCRs for this customer, then decide whether to contact them.',
        openLabel:  'Open admin',
        openHref:   '/admin',
        description: 'Review repeat issues for ' + top[0] + ' and decide on outreach.'
      });
    }

    // 4) Hiring funnel stalling — applicants but no hires
    if (snap.hiring) {
      const a30 = Number(snap.hiring.applicants_30d || 0);
      const h30 = Number(snap.hiring.hires || 0);
      if (a30 > 0 && h30 === 0) {
        out.push({
          sourceType: 'hiring_funnel_stalling',
          sourceId:   snap.hiring.snapshot_date || snap.todayPT,
          category:   'hiring',
          title:      a30 + ' applicants this month, zero hires',
          why:        'Pipeline activity is healthy, but no one is converting. The bottleneck is usually somewhere between interview and offer.',
          next:       'Sit in on a working interview this week, then debrief the conversion step that’s losing people.',
          openLabel:  'Open Hiring',
          openHref:   '/manager',
          description: 'Audit the interview-to-hire conversion and fix the weakest step.'
        });
      }
    }

    // 5) Approvals piling up
    const pendingImprovements = snap.improvements.filter(function (i) {
      return String(i.status || '').toLowerCase() === 'submitted';
    }).length;
    const approvalsBacklog = snap.timeAdj.length + pendingImprovements;
    if (approvalsBacklog >= 5) {
      out.push({
        sourceType: 'approvals_backlog',
        sourceId:   'current',
        category:   'leadership',
        title:      approvalsBacklog + ' approvals waiting on your nod',
        why:        'Approvals waiting too long erode trust in the system. The faster the loop, the more the team submits.',
        next:       'Clear the queue in one sitting — typically five minutes per item.',
        openLabel:  'Open admin',
        openHref:   '/admin',
        description: 'Clear the backlog of pending approvals (time adjustments + improvements).'
      });
    }

    // 6) No recognition logged this month
    const rockstars30 = snap.rockstars.filter(function (r) {
      return tsToMs(r.created_at) >= snap.thirtyDaysAgo;
    });
    const activeTechs = snap.techs.filter(function (t) { return t.active !== false; }).length;
    if (rockstars30.length === 0 && activeTechs > 0) {
      const monthKey = snap.todayPT.slice(0, 7); // YYYY-MM
      out.push({
        sourceType: 'no_recognition_30d',
        sourceId:   monthKey,
        category:   'leadership',
        title:      'No recognition logged in 30 days',
        why:        'Recognition is the cheapest, fastest lever for retention and morale. Easy to forget when no one’s asking.',
        next:       'Recognize one employee today — a Rockstar bonus, a hand-written note, or a public mention.',
        openLabel:  'Team view',
        openHref:   '/admin',
        description: 'Recognize at least one team member this week.'
      });
    }

    return out;
  }

  function actionTaskKey(task) {
    return (task.sourceType || '') + '|' + (task.sourceId || '') + '|' + (task.category || '');
  }

  function renderActions(snap, health) {
    const root = $('ceo-actions');
    if (!root) return;

    const openTasks   = (snap.openTasks || []).slice(); // already status==='open'

    // Phase 1D — also suppress suggestions whose triple was handled
    // TODAY (status done/dismissed AND completedAt is today PT). Yesterday's
    // done task can come back as a suggestion if the underlying signal
    // still fires; today's handled action stays cleared.
    const todayStart = todayStartMs(snap.todayPT);
    const handledTodayKeys = new Set(
      (snap.recentTasks || [])
        .filter(function (t) {
          const status = String(t.status || '');
          if (status !== 'done' && status !== 'dismissed') return false;
          return tsToMs(t.completedAt) >= todayStart;
        })
        .map(actionTaskKey)
    );

    const taskKeys    = new Set(openTasks.map(actionTaskKey));
    const suggestions = generateSuggestions(snap, health)
      .filter(function (s) {
        const k = actionTaskKey(s);
        return !taskKeys.has(k) && !handledTodayKeys.has(k);
      });

    const cards = [];
    // Open tasks first — these are commitments April already made.
    openTasks.forEach(function (t) {
      if (cards.length < MAX_ACTIONS) cards.push(renderTaskCardHtml(t));
    });
    // Top suggestions to fill remaining slots.
    suggestions.forEach(function (s) {
      if (cards.length < MAX_ACTIONS) cards.push(renderSuggestionCardHtml(s));
    });

    if (!cards.length) {
      const handled = handledTodayKeys.size;
      const headline = handled > 0
        ? 'Inbox zero. Beautiful.'
        : 'Today is unscripted.';
      const sub = handled > 0
        ? 'You\'ve handled ' + handled + ' action' + (handled === 1 ? '' : 's') +
          ' today. Take the rest of the afternoon to think, not react.'
        : 'Nothing demands your attention right now. Use the space to think, not react.';
      root.innerHTML =
        '<div class="ceo-actions-empty">' +
          '<div class="ceo-actions-empty-icon">·</div>' +
          '<p class="ceo-actions-empty-title">' + escapeHtml(headline) + '</p>' +
          '<p class="ceo-actions-empty-sub">' + escapeHtml(sub) + '</p>' +
        '</div>';
      renderTodaysProgress(snap);
      return;
    }
    root.innerHTML = cards.join('');
    wireActionButtons();
    renderTodaysProgress(snap);
  }

  function renderSuggestionCardHtml(s) {
    const dataAttrs =
      ' data-action-kind="suggestion"' +
      ' data-source-type="' + escapeHtml(s.sourceType) + '"' +
      ' data-source-id="'   + escapeHtml(s.sourceId)   + '"' +
      ' data-category="'    + escapeHtml(s.category)   + '"';
    return '<article class="ceo-action-card" data-category="' + escapeHtml(s.category) + '"' + dataAttrs + '>' +
             '<span class="ceo-action-badge">' + escapeHtml(CATEGORY_LABEL[s.category] || s.category) + '</span>' +
             '<h3 class="ceo-action-title">' + escapeHtml(s.title) + '</h3>' +
             '<p class="ceo-action-why">' + escapeHtml(s.why) + '</p>' +
             '<p class="ceo-action-next">' + escapeHtml(s.next) + '</p>' +
             '<div class="ceo-action-btns">' +
               // Phase 1D — three controls. Done writes a task with status
               // pre-set so April can act in one click without creating an
               // open task first. Create Task keeps the option to commit
               // for later. Open jumps to the related admin surface.
               '<button type="button" class="ceo-action-btn" data-action="done">Done</button>' +
               '<button type="button" class="ceo-action-btn ceo-action-btn-secondary" data-action="dismiss">Dismiss</button>' +
               '<button type="button" class="ceo-action-btn ceo-action-btn-ghost" data-action="create">+ Task</button>' +
               '<a class="ceo-action-btn ceo-action-btn-ghost" href="' + escapeHtml(s.openHref) +
                 '" data-action="open">' + escapeHtml(s.openLabel || 'Open') + '</a>' +
             '</div>' +
             '<p class="ceo-action-status" data-status></p>' +
             // Stash payload on the element so click handlers can hydrate
             // the task doc without re-walking the suggestion list.
             '<script type="application/json" data-payload>' +
               JSON.stringify({
                 title:       s.title,
                 description: s.description || s.next,
                 category:    s.category,
                 sourceType:  s.sourceType,
                 sourceId:    s.sourceId,
                 openHref:    s.openHref,
                 openLabel:   s.openLabel
               }).replace(/</g, '\\u003c') +
             '</script>' +
           '</article>';
  }

  function renderTaskCardHtml(t) {
    const dataAttrs =
      ' data-action-kind="task"' +
      ' data-task-id="'   + escapeHtml(t._id) + '"' +
      ' data-source-type="' + escapeHtml(t.sourceType || '') + '"' +
      ' data-source-id="'   + escapeHtml(t.sourceId   || '') + '"' +
      ' data-category="'    + escapeHtml(t.category   || 'leadership') + '"';
    const cat = t.category || 'leadership';
    // Re-derive a useful "open related area" target from the category.
    const openLink = categoryDefaultLink(cat);
    const createdMeta = t.createdAt ? 'Created ' + fmtAgo(tsToMs(t.createdAt)) : '';
    const why = t.description || 'Committed action on your queue.';
    return '<article class="ceo-action-card" data-category="' + escapeHtml(cat) + '"' + dataAttrs + '>' +
             '<span class="ceo-action-badge">On Your Desk · ' +
               escapeHtml(CATEGORY_LABEL[cat] || cat) + '</span>' +
             '<h3 class="ceo-action-title">' + escapeHtml(t.title || 'Untitled task') + '</h3>' +
             '<p class="ceo-action-why">' + escapeHtml(why) + '</p>' +
             '<p class="ceo-action-next">Mark this done when you’ve handled it, or dismiss if it’s no longer relevant.</p>' +
             (createdMeta ? '<p class="ceo-action-meta">' + escapeHtml(createdMeta) + '</p>' : '') +
             '<div class="ceo-action-btns">' +
               '<button type="button" class="ceo-action-btn" data-action="done">Mark Done</button>' +
               '<button type="button" class="ceo-action-btn ceo-action-btn-secondary" data-action="dismiss">Dismiss</button>' +
               (openLink ? '<a class="ceo-action-btn ceo-action-btn-ghost" href="' + escapeHtml(openLink.href) +
                            '" data-action="open">' + escapeHtml(openLink.label) + '</a>' : '') +
             '</div>' +
             '<p class="ceo-action-status" data-status></p>' +
           '</article>';
  }

  function categoryDefaultLink(category) {
    switch (category) {
      case 'customer':   return { href: '/admin',   label: 'Open admin' };
      case 'staffing':   return { href: '/manager', label: 'Manager view' };
      case 'hiring':     return { href: '/manager', label: 'Open hiring' };
      case 'leadership': return { href: '/admin',   label: 'Open admin' };
      case 'finance':    return null; // placeholder until Financial Pulse
      default:           return null;
    }
  }

  function fmtAgo(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    if (diff < 60_000)        return 'just now';
    if (diff < 3600_000)      return Math.round(diff / 60_000)   + ' min ago';
    if (diff < 86400_000)     return Math.round(diff / 3600_000) + ' hr ago';
    return Math.round(diff / 86400_000) + ' d ago';
  }

  /* ---- Action card button wiring ---- */

  function wireActionButtons() {
    document.querySelectorAll('.ceo-action-card').forEach(function (card) {
      // Replace listeners by re-attaching fresh — the card markup is
      // rebuilt on every re-render so no de-dup needed.
      card.querySelectorAll('[data-action]').forEach(function (btn) {
        if (btn.tagName === 'A') return; // anchors navigate natively
        btn.addEventListener('click', function () { handleActionClick(card, btn); });
      });
    });
  }

  async function handleActionClick(card, btn) {
    const kind   = card.getAttribute('data-action-kind');
    const action = btn.getAttribute('data-action');
    const status = card.querySelector('[data-status]');
    setActionStatus(status, '');

    if (kind === 'suggestion') {
      if (action === 'create')  return handleCreateTask(card, btn, status, 'open');
      if (action === 'done')    return handleCreateTask(card, btn, status, 'done');
      if (action === 'dismiss') return handleCreateTask(card, btn, status, 'dismissed');
    } else if (kind === 'task') {
      if (action === 'done')    return handleMutateTask(card, btn, status, 'done');
      if (action === 'dismiss') return handleMutateTask(card, btn, status, 'dismissed');
    }
  }

  async function handleCreateTask(card, btn, status, targetStatus) {
    const payloadEl = card.querySelector('[data-payload]');
    if (!payloadEl || !currentUser) return;
    let payload;
    try { payload = JSON.parse(payloadEl.textContent || '{}'); }
    catch (err) { setActionStatus(status, 'Could not read this suggestion.', 'error'); return; }

    const finalStatus = (targetStatus === 'done' || targetStatus === 'dismissed') ? targetStatus : 'open';
    btn.disabled = true;
    setActionStatus(status,
      finalStatus === 'done'      ? 'Marking done…' :
      finalStatus === 'dismissed' ? 'Dismissing…'   : 'Saving…');

    try {
      // Dedup: existing OPEN task with same triple? Only meaningful when
      // we'd be opening a new task. For one-shot Done/Dismiss, allow a
      // new doc — the audit trail benefits from per-event records.
      if (finalStatus === 'open') {
        const existing = await db.collection('ceo_tasks')
          .where('status', '==', 'open')
          .where('sourceType', '==', payload.sourceType)
          .where('sourceId',   '==', payload.sourceId)
          .where('category',   '==', payload.category)
          .limit(1).get();
        if (!existing.empty) {
          setActionStatus(status, 'Task already open.', 'error');
          btn.disabled = false;
          await refreshActionLayer();
          return;
        }
      }

      const email = (currentUser.email || '').toLowerCase();
      const sts   = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection('ceo_tasks').add({
        title:       payload.title,
        description: payload.description || '',
        category:    payload.category,
        sourceType:  payload.sourceType,
        sourceId:    payload.sourceId,
        status:      finalStatus,
        assignedTo:  email,
        createdBy:   email,
        createdAt:   sts,
        dueDate:     null,
        completedAt: (finalStatus === 'open') ? null : sts
      });
      setActionStatus(status,
        finalStatus === 'done'      ? 'Done. Nice.' :
        finalStatus === 'dismissed' ? 'Dismissed.'  : 'Added to your desk.');
      await refreshActionLayer();
    } catch (err) {
      console.error('[ceo] create task failed', err);
      setActionStatus(status, 'Save failed: ' + (err.message || 'unknown'), 'error');
      btn.disabled = false;
    }
  }

  async function handleMutateTask(card, btn, status, nextStatus) {
    const taskId = card.getAttribute('data-task-id');
    if (!taskId) return;

    btn.disabled = true;
    setActionStatus(status, nextStatus === 'done' ? 'Marking done…' : 'Dismissing…');

    try {
      await db.collection('ceo_tasks').doc(taskId).update({
        status:      nextStatus,
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updated_at:  firebase.firestore.FieldValue.serverTimestamp()
      });
      setActionStatus(status, nextStatus === 'done' ? 'Done. Nice.' : 'Dismissed.');
      await refreshActionLayer();
    } catch (err) {
      console.error('[ceo] task update failed', err);
      setActionStatus(status, 'Update failed: ' + (err.message || 'unknown'), 'error');
      btn.disabled = false;
    }
  }

  function setActionStatus(el, msg, tone) {
    if (!el) return;
    el.textContent = msg || '';
    if (tone) el.setAttribute('data-tone', tone);
    else el.removeAttribute('data-tone');
  }

  // Re-read only ceo_tasks (open + recent) + recent messages, then
  // re-render the action layer and progress strip using the cached snap.
  // Avoids a full 17-collection re-fetch after every click.
  async function refreshActionLayer() {
    if (!cachedSnap || !cachedHealth || !currentUser) return;
    const email = (currentUser.email || '').toLowerCase();
    try {
      const [openSnap, recentSnap, msgSnap] = await Promise.all([
        db.collection('ceo_tasks')
          .where('status', '==', 'open')
          .orderBy('createdAt', 'desc').limit(50).get(),
        db.collection('ceo_tasks')
          .where('createdBy', '==', email)
          .orderBy('completedAt', 'desc').limit(30).get()
          .catch(function () { return { docs: [] }; }),
        db.collection('leadership_messages')
          .where('createdBy', '==', email)
          .orderBy('createdAt', 'desc').limit(60).get()
          .catch(function () { return { docs: [] }; })
      ]);
      const mapDocs = function (s) {
        return s.docs.map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); });
      };
      cachedSnap.openTasks      = mapDocs(openSnap);
      cachedSnap.recentTasks    = mapDocs(recentSnap);
      cachedSnap.recentMessages = mapDocs(msgSnap);
      renderActions(cachedSnap, cachedHealth);
      renderRecentActivity(cachedSnap);
    } catch (err) {
      console.error('[ceo] action refresh failed', err);
    }
  }

  // ---- Section 2: Dangers (Attention Needed) ----

  function renderDangers(snap, health) {
    const root = $('ceo-dangers');
    const items = [];

    // Open customer complaints (unresolved)
    const openComplaints = snap.complaints.filter(function (c) {
      const st = String(c.status || '').toLowerCase();
      return st !== 'resolved' && st !== 'closed';
    });
    if (openComplaints.length) {
      items.push({
        icon: '!',
        title: openComplaints.length + ' customer complaint' +
               (openComplaints.length === 1 ? '' : 's') + ' awaiting resolution',
        context: 'Stepping in personally can save a relationship.',
        cta: { label: 'Review in admin', href: '/admin' }
      });
    }

    // Open service recoveries
    if (snap.recoveries.length) {
      items.push({
        icon: '◐',
        title: snap.recoveries.length + ' service recover' +
               (snap.recoveries.length === 1 ? 'y' : 'ies') + ' still open',
        context: 'Customer is waiting for a follow-up. Closing one wins back trust.',
        cta: { label: 'See recoveries', href: '/admin' }
      });
    }

    // Chronic-issue customers
    if (health.chronicCount > 0) {
      const top = Object.entries(health.issuesByCustomer)
        .filter(function (e) { return e[1] >= 3; })
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 3)
        .map(function (e) { return e[0]; });
      items.push({
        icon: '⚑',
        title: health.chronicCount + ' customer' + (health.chronicCount === 1 ? '' : 's') +
               ' with repeat issues this month',
        context: top.length ? 'Focus: ' + top.join(', ') : 'A conversation may be overdue.',
        cta: null
      });
    }

    // Open shifts in next 48h
    if (health.openShifts48h > 0) {
      items.push({
        icon: '◷',
        title: health.openShifts48h + ' open shift' +
               (health.openShifts48h === 1 ? '' : 's') + ' in the next 48 hours',
        context: 'Coverage is the first promise we make to customers.',
        cta: { label: 'Manager view', href: '/manager' }
      });
    }

    // Callouts last 7d (only flag if non-trivial)
    if (health.callouts7d >= 3) {
      items.push({
        icon: '~',
        title: health.callouts7d + ' call-outs in the last 7 days',
        context: 'Watch the trend; a conversation with the team may help.',
        cta: { label: 'Attendance', href: '/admin' }
      });
    }

    // Pending time adjustments piling up
    if (snap.timeAdj.length >= 5) {
      items.push({
        icon: '∮',
        title: snap.timeAdj.length + ' time-adjustment requests awaiting review',
        context: 'Approvals waiting too long erode trust in the system.',
        cta: { label: 'Payroll Exceptions', href: '/admin' }
      });
    }

    if (!items.length) {
      root.innerHTML = emptyHtml('All clear',
        'No emergencies waiting. This is rare. Enjoy it.', '✿');
      return;
    }

    root.innerHTML = '<ul class="ceo-list">' +
      items.map(function (it) { return listItemHtml(it, 'ceo-tone-attention'); }).join('') +
      '</ul>';
  }

  // ---- Section 3: Opportunities (Momentum) ----

  function renderOpportunities(snap, health) {
    const root = $('ceo-opportunities');
    const items = [];

    // Quality wins last 30d
    const recentQualityWins = snap.qualityWins.filter(function (w) {
      return tsToMs(w.created_at) >= snap.thirtyDaysAgo;
    });
    if (recentQualityWins.length) {
      items.push({
        icon: '✦',
        title: recentQualityWins.length + ' quality win' +
               (recentQualityWins.length === 1 ? '' : 's') + ' this month',
        context: 'Five-star inspections and customer compliments worth celebrating.',
        cta: null
      });
    }

    // Compliments specifically
    const compliments30 = snap.feedback.filter(function (f) {
      const isCompliment = String(f.feedback_type || f.type || '').toLowerCase() === 'compliment';
      return isCompliment && tsToMs(f.created_at) >= snap.thirtyDaysAgo;
    });
    if (compliments30.length) {
      items.push({
        icon: '♡',
        title: compliments30.length + ' customer compliment' +
               (compliments30.length === 1 ? '' : 's') + ' last 30 days',
        context: 'Each one is a customer who chose to take the time to thank Pioneer.',
        cta: null
      });
    }

    // Hiring funnel — healthy if applicants_7d > 0
    if (snap.hiring && Number(snap.hiring.applicants_7d || 0) > 0) {
      const a7 = Number(snap.hiring.applicants_7d);
      items.push({
        icon: '↗',
        title: a7 + ' new applicant' + (a7 === 1 ? '' : 's') + ' in the last week',
        context: 'The funnel is moving — keep the conversion conversations going.',
        cta: { label: 'Hiring view', href: '/manager' }
      });
    }

    // Rockstar bonuses paid
    const rockstars30 = snap.rockstars.filter(function (r) {
      return tsToMs(r.created_at) >= snap.thirtyDaysAgo;
    });
    if (rockstars30.length) {
      const totalCents = rockstars30.reduce(function (s, r) {
        return s + (Number(r.bonusAmount || r.amount || 0));
      }, 0);
      items.push({
        icon: '◇',
        title: rockstars30.length + ' Rockstar bonus' +
               (rockstars30.length === 1 ? '' : 'es') + ' earned this month',
        context: 'Team members stepping up to cover. ' +
                 (totalCents > 0 ? '$' + Math.round(totalCents) + ' in recognition paid.' : ''),
        cta: null
      });
    }

    // Steady customers — those with zero issues in 60d (rough proxy: served but no DCR issue)
    const servedCustomers = new Set();
    snap.assignments.forEach(function (a) {
      if (a.customer_slug && tsToMs(a.service_date) >= snap.sixtyDaysAgo) {
        servedCustomers.add(a.customer_slug);
      }
    });
    const issueCustomers = new Set();
    snap.dcrIssues.forEach(function (i) {
      if (tsToMs(i.created_at) >= snap.sixtyDaysAgo) {
        issueCustomers.add(i.customer_slug || i.customer);
      }
    });
    const steadyCount = [].concat(Array.from(servedCustomers))
      .filter(function (c) { return c && !issueCustomers.has(c); }).length;
    if (steadyCount >= 3) {
      items.push({
        icon: '◉',
        title: steadyCount + ' customers with zero issues in 60 days',
        context: 'These relationships are gold — natural references, renewal targets.',
        cta: null
      });
    }

    if (!items.length) {
      root.innerHTML = emptyHtml('Building momentum',
        'New wins will surface here as they happen.', '✿');
      return;
    }

    root.innerHTML = '<ul class="ceo-list">' +
      items.map(function (it) { return listItemHtml(it, 'ceo-tone-celebrate'); }).join('') +
      '</ul>';
  }

  function listItemHtml(it, toneClass) {
    const cta = it.cta
      ? '<a class="ceo-list-item-cta" href="' + escapeHtml(it.cta.href) + '">' +
          escapeHtml(it.cta.label) + ' →</a>'
      : '';
    return '<li class="ceo-list-item ' + toneClass + '">' +
             '<div class="ceo-list-item-icon">' + escapeHtml(it.icon) + '</div>' +
             '<div class="ceo-list-item-body">' +
               '<p class="ceo-list-item-title">' + escapeHtml(it.title) + '</p>' +
               (it.context ? '<p class="ceo-list-item-context">' + escapeHtml(it.context) + '</p>' : '') +
               cta +
             '</div>' +
           '</li>';
  }

  function emptyHtml(headline, context, icon) {
    return '<div class="ceo-empty">' +
             '<div class="ceo-empty-icon">' + escapeHtml(icon || '·') + '</div>' +
             '<p class="ceo-empty-headline">' + escapeHtml(headline) + '</p>' +
             '<p class="ceo-empty-context">' + escapeHtml(context) + '</p>' +
           '</div>';
  }

  // ---- Section 4: Department Scorecards ----

  function renderScorecards(snap, health) {
    const root = $('ceo-scorecards');

    // Operations
    const finished = snap.assignments.filter(function (a) {
      return a.status === 'completed' || a.dcr_submitted === true;
    });
    const submitted = finished.filter(function (a) { return a.dcr_submitted === true; });
    const dcrRate = finished.length ? Math.round((submitted.length / finished.length) * 100) : null;
    const sessions30 = snap.sessions.length;

    // People
    const activeTechs = snap.techs.filter(function (t) { return t.active !== false; }).length;
    const callouts30 = snap.callOuts.filter(function (c) {
      return tsToMs(c.created_at) >= snap.thirtyDaysAgo;
    }).length;
    const calloutRate = sessions30 > 0
      ? Math.round((callouts30 / sessions30) * 1000) / 10
      : null;

    // Quality
    const compliments30 = snap.feedback.filter(function (f) {
      const t = String(f.feedback_type || f.type || '').toLowerCase();
      return t === 'compliment' && tsToMs(f.created_at) >= snap.thirtyDaysAgo;
    }).length;
    const complaintsTotal30 = snap.complaints.filter(function (c) {
      return tsToMs(c.created_at) >= snap.thirtyDaysAgo;
    }).length;
    const inspectionAvg = snap.inspections.length
      ? snap.inspections.reduce(function (s, i) {
          const v = Number(i.overall_score || 0);
          return s + (v > 5 ? v / 20 : v);
        }, 0) / snap.inspections.length
      : null;

    // Hiring
    const hiring = snap.hiring || {};
    const apps30  = hiring.applicants_30d != null ? hiring.applicants_30d : null;
    const hires30 = hiring.hires != null ? hiring.hires : null;
    const interviews30 = hiring.interviews_scheduled != null ? hiring.interviews_scheduled : null;
    const hireConv = (apps30 && apps30 > 0 && hires30 != null)
      ? Math.round((hires30 / apps30) * 100)
      : null;

    root.innerHTML = [
      scorecardHtml({
        eyebrow: 'Operations',
        name: 'Service Delivery',
        hero: sessions30,
        heroSuffix: '',
        heroLabel: 'completed sessions, 30 days',
        stats: [
          { label: 'DCR submission rate', value: dcrRate != null ? dcrRate + '%' : '—' },
          { label: 'Customers served',    value: countUniqueCustomers(snap.assignments, snap.thirtyDaysAgo) },
          { label: 'Open shifts',         value: snap.openShifts.length }
        ]
      }),
      scorecardHtml({
        eyebrow: 'People',
        name: 'Team',
        hero: activeTechs,
        heroSuffix: '',
        heroLabel: 'active cleaning techs',
        stats: [
          { label: 'Call-outs (30d)',     value: callouts30 },
          { label: 'Call-out rate',       value: calloutRate != null ? calloutRate + '%' : '—' },
          { label: 'Pending time-adjusts', value: snap.timeAdj.length }
        ]
      }),
      scorecardHtml({
        eyebrow: 'Quality',
        name: 'Customer Care',
        hero: inspectionAvg != null ? inspectionAvg.toFixed(1) : '—',
        heroSuffix: inspectionAvg != null ? ' / 5' : '',
        heroLabel: 'inspection avg, 30 days',
        stats: [
          { label: 'Compliments (30d)',   value: compliments30 },
          { label: 'Complaints (30d)',    value: complaintsTotal30 },
          { label: 'Open recoveries',     value: snap.recoveries.length }
        ]
      }),
      scorecardHtml({
        eyebrow: 'Hiring',
        name: 'Pipeline',
        hero: apps30 != null ? apps30 : '—',
        heroSuffix: '',
        heroLabel: 'applicants in last 30 days',
        stats: [
          { label: 'Interviews (cohort)', value: interviews30 != null ? interviews30 : '—' },
          { label: 'Hires (30d)',         value: hires30 != null ? hires30 : '—' },
          { label: 'Applicant → Hire',    value: hireConv != null ? hireConv + '%' : '—' }
        ]
      })
    ].join('');
  }

  function scorecardHtml(c) {
    return '<div class="ceo-scorecard">' +
             '<p class="ceo-scorecard-eyebrow">' + escapeHtml(c.eyebrow) + '</p>' +
             '<h3 class="ceo-scorecard-name">' + escapeHtml(c.name) + '</h3>' +
             '<div class="ceo-scorecard-hero">' + escapeHtml(c.hero) +
               '<span class="ceo-scorecard-hero-suffix">' + escapeHtml(c.heroSuffix || '') + '</span>' +
             '</div>' +
             '<p class="ceo-scorecard-hero-label">' + escapeHtml(c.heroLabel) + '</p>' +
             '<div class="ceo-scorecard-stats">' +
               c.stats.map(function (s) {
                 return '<div class="ceo-scorecard-stat">' +
                          '<span class="ceo-scorecard-stat-label">' + escapeHtml(s.label) + '</span>' +
                          '<span class="ceo-scorecard-stat-value">' + escapeHtml(s.value) + '</span>' +
                        '</div>';
               }).join('') +
             '</div>' +
           '</div>';
  }

  function countUniqueCustomers(assignments, cutoffMs) {
    const set = new Set();
    assignments.forEach(function (a) {
      const ms = a.service_date ? Date.parse(a.service_date + 'T00:00:00Z') : 0;
      if (ms >= cutoffMs && a.customer_slug) set.add(a.customer_slug);
    });
    return set.size;
  }

  // ---- Section 5: Leadership Pulse ----

  function renderLeadershipPulse(snap, health) {
    // OM reflection today?
    const omReflectionToday = snap.omReflections.find(function (r) {
      return r.reflection_date === snap.todayPT ||
             tsToMs(r.created_at) >= todayStartMs(snap.todayPT);
    });
    // OM bottleneck today?
    const omBottleneckToday = snap.omBottlenecks.find(function (b) {
      return tsToMs(b.created_at) >= todayStartMs(snap.todayPT);
    });
    // Rockstars paid this month
    const rockstars30 = snap.rockstars.filter(function (r) {
      return tsToMs(r.created_at) >= snap.thirtyDaysAgo;
    }).length;
    // Improvements approved or implemented in last 30d
    const improvementsMoved = snap.improvements.filter(function (i) {
      const st = String(i.status || '').toLowerCase();
      const t = tsToMs(i.updated_at || i.created_at);
      return t >= snap.thirtyDaysAgo &&
             (st === 'approved' || st === 'in_progress' || st === 'implemented');
    }).length;
    // Items pending review (your desk)
    const pendingImprovements = snap.improvements.filter(function (i) {
      return String(i.status || '').toLowerCase() === 'submitted';
    }).length;
    const pendingApprovals = pendingImprovements + snap.timeAdj.length;

    const items = [
      {
        label: 'Recognition Given',
        value: rockstars30,
        context: 'Rockstar bonuses paid this month'
      },
      {
        label: 'Improvements Advanced',
        value: improvementsMoved,
        context: 'Team ideas moved forward in 30 days'
      },
      {
        label: 'On Your Desk',
        value: pendingApprovals,
        context: pendingApprovals === 0
          ? 'Inbox zero. Beautiful.'
          : 'Approvals waiting on your nod'
      },
      {
        label: 'Office Manager Pulse',
        value: omReflectionToday ? '✓ Today' : '—',
        context: omReflectionToday
          ? 'Daily reflection submitted'
          : 'No reflection yet today'
      },
      {
        label: "Today's Bottleneck",
        value: omBottleneckToday
          ? (omBottleneckToday.choice === 'nobody' ? 'Clear' : capitalize(omBottleneckToday.choice || ''))
          : '—',
        context: omBottleneckToday
          ? (omBottleneckToday.choice === 'nobody'
              ? 'Nothing is blocked today'
              : 'Waiting on ' + (omBottleneckToday.choice || 'someone'))
          : 'Office manager has not logged one yet'
      },
      {
        label: 'Team Health',
        value: health.activeTechs + ' active',
        context: 'cleaning techs serving Pioneer customers'
      }
    ];

    $('ceo-pulse-grid').innerHTML = items.map(function (it) {
      return '<div class="ceo-pulse-item">' +
               '<p class="ceo-pulse-item-label">' + escapeHtml(it.label) + '</p>' +
               '<div class="ceo-pulse-item-value">' + escapeHtml(String(it.value)) + '</div>' +
               '<p class="ceo-pulse-item-context">' + escapeHtml(it.context) + '</p>' +
             '</div>';
    }).join('');
  }

  function todayStartMs(todayPT) {
    return Date.parse(todayPT + 'T00:00:00-07:00') ||
           Date.parse(todayPT + 'T00:00:00Z') - 7 * 3600000;
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ============================================================
   * Phase 1D — Today's Progress + Leadership Streak + Activity Feed
   * ============================================================ */

  function pacificDateOf(ms) {
    if (!ms) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(ms));
  }

  // Pacific YYYY-MM-DD offset by N days. Walks via date math in UTC,
  // then formats back to PT. Works across DST because we let Intl
  // re-resolve the offset each step.
  function pacificDateShift(startPT, deltaDays) {
    const ms = Date.parse(startPT + 'T12:00:00Z'); // noon UTC anchor avoids DST cliff
    return pacificDateOf(ms + deltaDays * 86400000);
  }

  // Compute progress + streak from recent activity. Activity for a day
  // counts if April either (a) completed an action (ceo_tasks status in
  // [done, dismissed], completedAt that day) OR (b) sent any leadership
  // message (createdAt that day). Streak is the longest run of
  // consecutive PT days ending today (or yesterday — see below).
  function computeProgress(snap) {
    const recentTasks    = snap.recentTasks    || [];
    const recentMessages = snap.recentMessages || [];
    const todayPT        = snap.todayPT;
    const todayStart     = todayStartMs(todayPT);

    // Today counts
    const handledToday = recentTasks.filter(function (t) {
      const st = String(t.status || '');
      if (st !== 'done' && st !== 'dismissed') return false;
      return tsToMs(t.completedAt) >= todayStart;
    }).length;
    const messagesToday = recentMessages.filter(function (m) {
      return tsToMs(m.createdAt) >= todayStart;
    }).length;
    const recognitionsToday = recentMessages.filter(function (m) {
      return tsToMs(m.createdAt) >= todayStart && m.messageType === 'recognition';
    }).length;

    // Build the set of PT dates with at least one activity event.
    const activeDates = new Set();
    recentTasks.forEach(function (t) {
      const st = String(t.status || '');
      if (st !== 'done' && st !== 'dismissed') return;
      const d = pacificDateOf(tsToMs(t.completedAt));
      if (d) activeDates.add(d);
    });
    recentMessages.forEach(function (m) {
      const d = pacificDateOf(tsToMs(m.createdAt));
      if (d) activeDates.add(d);
    });

    // Streak: walk back from today (or yesterday if today has no activity
    // yet but yesterday did — preserves a streak before April acts today).
    let streak = 0;
    let cursor = activeDates.has(todayPT) ? todayPT : pacificDateShift(todayPT, -1);
    while (activeDates.has(cursor) && streak < 365) {
      streak++;
      cursor = pacificDateShift(cursor, -1);
    }
    // If today has no activity AND yesterday has none, streak is 0
    // (not "carry yesterday's streak forward"). If today has activity,
    // streak includes today.

    return {
      handledToday:      handledToday,
      messagesToday:     messagesToday,
      recognitionsToday: recognitionsToday,
      remaining:         0, // filled by renderTodaysProgress (knows current card count)
      streak:            streak,
      streakIncludesToday: activeDates.has(todayPT)
    };
  }

  function renderTodaysProgress(snap) {
    const aside = $('ceo-actions-aside');
    if (!aside) return;
    const p = computeProgress(snap);
    const visibleCards = document.querySelectorAll('#ceo-actions .ceo-action-card').length;
    const totalToday = p.handledToday + visibleCards;
    const handledPart = totalToday > 0
      ? p.handledToday + ' of ' + totalToday + ' handled'
      : 'No actions yet today';
    const safeParts = [escapeHtml(handledPart)];
    if (p.messagesToday > 0) {
      safeParts.push(escapeHtml(
        p.messagesToday + ' message' + (p.messagesToday === 1 ? '' : 's') + ' queued'
      ));
    }
    if (p.recognitionsToday > 0) {
      safeParts.push(escapeHtml(
        p.recognitionsToday + ' recognition' + (p.recognitionsToday === 1 ? '' : 's') + ' sent'
      ));
    }
    let html = safeParts.join(' &middot; ');
    if (p.streak >= 2) {
      // Champagne-gold chip — celebratory but quiet. 2-day minimum so
      // a single active day doesn't yell.
      html += '<span class="ceo-streak-chip" title="Consecutive days with at least one action or message">' +
              '<span class="ceo-streak-flame">✦</span>' +
              p.streak + '-day streak</span>';
    }
    aside.innerHTML = html;
  }

  /* ---- Recent Activity feed ---- */

  function renderRecentActivity(snap) {
    const root = $('ceo-recent-activity');
    if (!root) return;
    const events = [];
    (snap.recentTasks || []).forEach(function (t) {
      const st = String(t.status || '');
      if (st !== 'done' && st !== 'dismissed') return;
      const at = tsToMs(t.completedAt);
      if (!at) return;
      events.push({
        at:       at,
        verb:     st === 'done' ? 'Marked done' : 'Dismissed',
        title:    t.title || 'Untitled action',
        category: t.category || 'leadership',
        tone:     st === 'done' ? 'good' : 'neutral'
      });
    });
    (snap.recentMessages || []).forEach(function (m) {
      const at = tsToMs(m.createdAt);
      if (!at) return;
      const verb = m.messageType === 'recognition' ? 'Recognized'
                 : m.recipientType === 'team'      ? 'Messaged the team'
                 : m.recipientType === 'office_manager' ? 'Messaged office manager'
                 : 'Messaged';
      const subject = (m.messageType === 'recognition' || m.recipientType === 'employee')
                      ? (m.recipientName || m.recipientId || 'a teammate')
                      : '';
      events.push({
        at:       at,
        verb:     verb,
        title:    subject ? subject : (m.recipientName || ''),
        category: 'leadership',
        tone:     m.messageType === 'recognition' ? 'celebrate' : 'neutral'
      });
    });
    events.sort(function (a, b) { return b.at - a.at; });
    const top = events.slice(0, 10);

    if (!top.length) {
      root.innerHTML =
        '<p class="ceo-empty-context" style="padding:18px 12px;text-align:center;">' +
        'Your recent leadership actions and messages will appear here.' +
        '</p>';
      return;
    }

    root.innerHTML = '<ul class="ceo-activity-list">' +
      top.map(function (ev) {
        return '<li class="ceo-activity-item" data-tone="' + escapeHtml(ev.tone) + '">' +
                 '<span class="ceo-activity-dot"></span>' +
                 '<div class="ceo-activity-body">' +
                   '<p class="ceo-activity-line">' +
                     '<span class="ceo-activity-verb">' + escapeHtml(ev.verb) + '</span>' +
                     (ev.title ? ' &middot; <span class="ceo-activity-subject">' + escapeHtml(ev.title) + '</span>' : '') +
                   '</p>' +
                   '<p class="ceo-activity-when">' + escapeHtml(fmtRelative(ev.at)) + '</p>' +
                 '</div>' +
               '</li>';
      }).join('') +
    '</ul>';
  }

  function fmtRelative(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60_000)    return 'just now';
    if (diff < 3600_000)  return Math.round(diff / 60_000)   + ' min ago';
    if (diff < 86400_000) return Math.round(diff / 3600_000) + ' hr ago';
    const days = Math.round(diff / 86400_000);
    if (days === 1) return 'yesterday';
    if (days < 7)   return days + ' days ago';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric'
    }).format(new Date(ms));
  }

  /* ============================================================
   * Phase Inspection 3 — Inspection Program rollup (read-only)
   * ============================================================ */

  async function renderInspectionRollup() {
    const root = $('ceo-inspection-rollup');
    if (!root) return;
    try {
      const snap = await db.collection('customer_inspection_state').get();
      const rows = snap.docs.map(function (d) { return d.data() || {}; });
      const total = rows.length;
      if (total === 0) {
        root.innerHTML =
          '<div class="ceo-empty" style="padding:24px 12px;">' +
            '<p class="ceo-empty-headline">No registry yet.</p>' +
            '<p class="ceo-empty-context">' +
              'Open /inspections once to bootstrap the customer registry.' +
            '</p>' +
          '</div>';
        return;
      }
      const todayMs = Date.now();
      const DEFAULT_CADENCE = 60;
      let completed = 0, assigned = 0, overdue = 0, unassigned = 0;
      rows.forEach(function (r) {
        const lastDate = r.last_inspection_date;
        const isAssigned = !!r.assigned_to_uid;
        // v1.0 audit fix — honor per-customer cadence overrides instead
        // of hardcoding 60d. Matches the truth table in inspections.js.
        const cadence = Number(r.inspection_cadence_days) || DEFAULT_CADENCE;
        let status;
        if (!lastDate) {
          status = isAssigned ? 'assigned' : 'unassigned';
        } else {
          const ms = Date.parse(lastDate + 'T00:00:00Z');
          const daysSince = Number.isFinite(ms)
            ? Math.floor((todayMs - ms) / 86400000)
            : 999;
          status = daysSince < cadence ? 'completed'
                : isAssigned ? 'assigned' : 'overdue';
        }
        if (status === 'completed')       completed++;
        else if (status === 'assigned')   assigned++;
        else if (status === 'overdue')    overdue++;
        else if (status === 'unassigned') unassigned++;
      });
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      const tiles = [
        { label: 'Completion rate', value: pct + '%',
          context: completed + ' of ' + total + ' customers on schedule' },
        { label: 'Overdue',          value: String(overdue),
          context: overdue === 0 ? 'Nothing past due. Beautiful.'
                                 : 'Past 60 days with no assignment yet' },
        { label: 'Assigned',         value: String(assigned),
          context: 'Owned by an inspector right now' },
        { label: 'Awaiting first',   value: String(unassigned),
          context: 'Newly added customers, no inspection yet' }
      ];
      root.innerHTML = '<div class="ceo-health-pillars" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:20px 28px;">' +
        tiles.map(function (t) {
          return '<div class="ceo-pillar">' +
                   '<p class="ceo-pillar-label">' + escapeHtml(t.label) + '</p>' +
                   '<div class="ceo-pillar-value">' + escapeHtml(t.value) + '</div>' +
                   '<p class="ceo-pillar-context">' + escapeHtml(t.context) + '</p>' +
                 '</div>';
        }).join('') +
      '</div>';
    } catch (err) {
      console.warn('[ceo] inspection rollup read failed', err);
      root.innerHTML = '<p class="ceo-empty-context" style="padding:18px 12px;">' +
        'Inspection registry isn\'t loading right now.</p>';
    }
  }

  /* ============================================================
   * Phase 3B — Open Conversations preview (read-only)
   * ============================================================ */

  async function renderOpenConvosPreview() {
    const root = $('ceo-open-convos');
    if (!root) return;
    try {
      // Phase 3B.1 — match every active status (open + waiting_on_*).
      // No orderBy because `status in [...]` + orderBy needs separate
      // composite indexes per value; client-side sort is fine while
      // the active thread count stays in the dozens.
      const activeStatuses = (window.CommThreads && window.CommThreads.ACTIVE_STATUSES)
        ? window.CommThreads.ACTIVE_STATUSES.slice()
        : ['open', 'waiting_on_employee', 'waiting_on_management'];
      const snap = await db.collection('communication_threads')
        .where('status', 'in', activeStatuses)
        .limit(20).get();
      const threads = snap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      }).sort(function (a, b) {
        return tsToMs(b.updated_at) - tsToMs(a.updated_at);
      });
      if (!threads.length) {
        root.innerHTML =
          '<div class="ceo-empty" style="padding:24px 12px;">' +
            '<p class="ceo-empty-headline">Quiet on the wires.</p>' +
            '<p class="ceo-empty-context">No open conversations right now.</p>' +
          '</div>';
        return;
      }
      const total = threads.length;
      const top   = threads.slice(0, 3);
      root.innerHTML =
        '<p style="font-size:13px;color:var(--ceo-charcoal-soft);margin:0 0 14px;">' +
          escapeHtml(total + ' open conversation' + (total === 1 ? '' : 's') +
                    ' across the team. Latest 3:') +
        '</p>' +
        '<ul class="ceo-list">' +
          top.map(renderOpenConvoRowHtml).join('') +
        '</ul>';
    } catch (err) {
      console.warn('[ceo] open convos read failed', err);
      root.innerHTML = '<p class="ceo-empty-context" style="padding:18px 12px;">' +
        'Conversations aren\'t loading right now.</p>';
    }
  }

  function renderOpenConvoRowHtml(t) {
    const categoryLabel = (t.category || 'general').charAt(0).toUpperCase() + (t.category || 'general').slice(1);
    const preview = t.last_message_preview || 'No messages yet.';
    const when = fmtRelative(tsToMs(t.last_message_at || t.updated_at));
    const participants = (t.participants || [])
      .map(function (p) { return p.name || p.id; })
      .filter(Boolean).join(' · ');
    // Phase 3B.1 — status badge inline. Same five-state vocabulary as
    // /manager + /team-hub.
    const statusValue = String(t.status || 'open');
    const statusLabel = (window.CommThreads && window.CommThreads.STATUS_LABEL &&
                         window.CommThreads.STATUS_LABEL[statusValue]) || statusValue;
    // Phase 3B.2 — priority indicator. Only render when NOT fyi —
    // executive attention should be drawn to action_required + urgent
    // threads, not the calm FYI background.
    const priorityValue = String(t.priority || 'action_required');
    const priorityLabel = (window.CommThreads && window.CommThreads.PRIORITY_LABEL &&
                           window.CommThreads.PRIORITY_LABEL[priorityValue]) || priorityValue;
    const priorityChip = (priorityValue !== 'fyi')
      ? ' <span class="ceo-comm-priority-chip is-' + escapeHtml(priorityValue) + '">' +
          escapeHtml(priorityLabel) + '</span>'
      : '';
    return '<li class="ceo-list-item ceo-tone-pulse"' +
             ' data-priority="' + escapeHtml(priorityValue) + '">' +
             '<div class="ceo-list-item-icon">·</div>' +
             '<div class="ceo-list-item-body">' +
               '<p class="ceo-list-item-title">' + escapeHtml(t.subject || '(no subject)') +
                 priorityChip +
                 ' <span class="ceo-comm-status-chip is-' + escapeHtml(statusValue) + '">' +
                   escapeHtml(statusLabel) + '</span>' +
               '</p>' +
               '<p class="ceo-list-item-context">' +
                 escapeHtml(categoryLabel + ' · ' + (participants || '—') + ' · ' + when) +
               '</p>' +
               '<p class="ceo-list-item-context" style="margin-top:4px;font-style:italic;">' +
                 escapeHtml(preview) +
               '</p>' +
             '</div>' +
           '</li>';
  }

  /* ============================================================
   * Phase 1C — Quick Leadership Actions (compose + queue)
   * ============================================================ */

  // Active techs cache for the Recognize-Employee picker. Loaded lazily
  // on first modal-open so the page paints fast.
  let techsCache = null;

  function pacificHour(date) {
    return parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
    }).format(date), 10);
  }

  // Delivery timing depends on recipientType:
  //   - office_manager → working-hours protection (8 AM–6 PM PT). Outside
  //     the window, queue until the next 8 AM PT. The OM is in front of
  //     /manager during business hours, so a 4 AM ping isn't useful.
  //   - employee / team → deliver immediately. Techs work evenings and
  //     weekends; they see messages whenever they next open Team Hub.
  //     The "queue" is the sign-in event itself, not a clock.
  // Twilio/SMS gating (future) will keep its own separate window — the
  // in-app deliverAfter does not constrain SMS scheduling.
  function nextDeliveryAt(now, recipientType) {
    if (recipientType !== 'office_manager') return new Date(now);
    const hour = pacificHour(now);
    if (hour >= 8 && hour < 18) return new Date(now);
    let cursor = new Date(now);
    cursor.setMinutes(0, 0, 0);
    cursor = new Date(cursor.getTime() + 3600000);
    let safety = 0;
    while (pacificHour(cursor) !== 8 && safety < 36) {
      cursor = new Date(cursor.getTime() + 3600000);
      safety++;
    }
    return cursor;
  }

  function fmtDeliveryHint(deliverAt, now, recipientType) {
    if (recipientType !== 'office_manager') {
      return 'It will appear the next time they open Team Hub.';
    }
    if (deliverAt.getTime() - now.getTime() < 60_000) return 'Delivers immediately.';
    const nowPT  = pacificDateString();
    const deliverPT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(deliverAt);
    const when = (deliverPT === nowPT) ? 'today' : 'tomorrow';
    return 'Queued for delivery ' + when + ' at 8 AM PT.';
  }

  /* ---- Tech roster (for Recognize Employee picker) ---- */

  async function ensureTechsCache() {
    if (techsCache) return techsCache;
    try {
      const snap = await db.collection('cleaning_techs').get();
      techsCache = snap.docs
        .map(function (d) { return Object.assign({ _id: d.id }, d.data() || {}); })
        .filter(function (t) { return t.active !== false; })
        .filter(function (t) { return t.email; })
        .sort(function (a, b) {
          return String(a.display_name || a.tech_display_name || a.email)
                 .localeCompare(String(b.display_name || b.tech_display_name || b.email));
        });
      return techsCache;
    } catch (err) {
      console.error('[ceo] tech roster load failed', err);
      techsCache = [];
      return techsCache;
    }
  }

  /* ---- Compose modal ---- */

  let composeMode = null; // 'recognize' | 'team' | 'office_manager'

  function openCompose(mode) {
    composeMode = mode;
    const overlay = $('ceo-compose-overlay');
    const recipientField = $('ceo-compose-recipient-field');
    const recipientSelect = $('ceo-compose-recipient');
    const typeSelect = $('ceo-compose-type');
    const eyebrow = $('ceo-compose-eyebrow');
    const title = $('ceo-compose-title');
    const sub = $('ceo-compose-sub');
    const body = $('ceo-compose-body');
    const status = $('ceo-compose-status');
    const helper = $('ceo-compose-helper');

    setActionStatus(status, '');
    body.value = '';

    if (mode === 'recognize') {
      eyebrow.textContent = 'Recognition';
      title.textContent   = 'Recognize a teammate';
      sub.textContent     = 'A few specific words mean more than anything generic. Name the thing you noticed.';
      typeSelect.value    = 'recognition';
      body.placeholder    = 'Example: "Thank you for covering the Saturday DIVCO route — that took real flexibility."';
      recipientField.hidden = false;
      // Load techs list async
      recipientSelect.innerHTML = '<option value="">Loading…</option>';
      ensureTechsCache().then(function (techs) {
        recipientSelect.innerHTML = '<option value="">Select a teammate…</option>' +
          techs.map(function (t) {
            const name = escapeHtml(t.display_name || t.tech_display_name || t.email);
            return '<option value="' + escapeHtml(t.email.toLowerCase()) +
                   '" data-name="' + name + '">' + name + '</option>';
          }).join('');
      });
    } else if (mode === 'team') {
      eyebrow.textContent = 'Team Announcement';
      title.textContent   = 'A note for the whole team';
      sub.textContent     = 'Keep it short. Everyone on the field will see it next time they sign in.';
      typeSelect.value    = 'announcement';
      body.placeholder    = 'Example: "Great week, everyone. The five-star inspection at Westfield was the cherry on top."';
      recipientField.hidden = true;
    } else if (mode === 'office_manager') {
      eyebrow.textContent = 'Office Manager';
      title.textContent   = 'A note for the office manager';
      sub.textContent     = 'Coaching, appreciation, or a quick thought. Delivered on their dashboard.';
      typeSelect.value    = 'coaching';
      body.placeholder    = 'Example: "Thank you for pushing the open-shift coverage this week — it landed."';
      recipientField.hidden = true;
    } else {
      return;
    }

    // Helper text mirrors the post-send confirmation copy. Techs see the
    // message whenever they next open Team Hub regardless of hour; the
    // office manager surface respects the 8 AM-6 PM PT window.
    if (mode === 'office_manager') {
      const hr = pacificHour(new Date());
      helper.textContent = (hr >= 8 && hr < 18)
        ? 'Delivers immediately to the office manager dashboard.'
        : 'Outside delivery hours — queued until next 8 AM PT.';
    } else {
      helper.textContent = 'It will appear the next time they open Team Hub.';
    }

    overlay.classList.remove('ceo-hidden');
    setTimeout(function () { body.focus(); }, 50);
  }

  function closeCompose() {
    composeMode = null;
    $('ceo-compose-overlay').classList.add('ceo-hidden');
  }

  async function sendCompose() {
    if (!currentUser || !composeMode) return;
    const status = $('ceo-compose-status');
    const body   = $('ceo-compose-body').value.trim();
    const messageType = $('ceo-compose-type').value;

    if (!body) {
      setActionStatus(status, 'Add a message before queueing.', 'error');
      return;
    }
    if (body.length > 2000) {
      setActionStatus(status, 'Keep it under 2,000 characters.', 'error');
      return;
    }

    let recipientType, recipientId, recipientName;
    if (composeMode === 'recognize') {
      const sel = $('ceo-compose-recipient');
      recipientId = (sel.value || '').toLowerCase();
      if (!recipientId) {
        setActionStatus(status, 'Choose a teammate to recognize.', 'error');
        return;
      }
      recipientName = sel.options[sel.selectedIndex].getAttribute('data-name') || recipientId;
      recipientType = 'employee';
    } else if (composeMode === 'team') {
      recipientType = 'team';
      recipientId   = '';
      recipientName = 'Pioneer Team';
    } else if (composeMode === 'office_manager') {
      recipientType = 'office_manager';
      recipientId   = '';
      recipientName = 'Office Manager';
    }

    const sendBtn   = $('ceo-compose-send');
    const cancelBtn = $('ceo-compose-cancel');
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    setActionStatus(status, 'Queueing…');

    try {
      const now       = new Date();
      const deliverAt = nextDeliveryAt(now, recipientType);
      const email     = (currentUser.email || '').toLowerCase();
      await db.collection('leadership_messages').add({
        messageType:   messageType,
        recipientType: recipientType,
        recipientId:   recipientId,
        recipientName: recipientName,
        messageBody:   body,
        createdBy:     email,
        createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
        status:        'queued',
        deliverAfter:  firebase.firestore.Timestamp.fromDate(deliverAt),
        deliveredAt:   null
      });
      setActionStatus(status, 'Message queued. ' + fmtDeliveryHint(deliverAt, now, recipientType));
      // Refresh action layer so Today's Progress + Streak reflect the
      // just-queued message in real time without a full page reload.
      refreshActionLayer().catch(function () {});
      setTimeout(closeCompose, 1400);
    } catch (err) {
      console.error('[ceo] compose send failed', err);
      setActionStatus(status, 'Save failed: ' + (err.message || 'unknown'), 'error');
      sendBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }

  function wireQuickActions() {
    document.querySelectorAll('[data-quick]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openCompose(btn.getAttribute('data-quick'));
      });
    });
    const overlay = $('ceo-compose-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closeCompose();
      });
    }
    const cancel = $('ceo-compose-cancel');
    if (cancel) cancel.addEventListener('click', closeCompose);
    const send = $('ceo-compose-send');
    if (send) send.addEventListener('click', sendCompose);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && composeMode) closeCompose();
    });
  }

  /* ---------------- Customer Economics (Phase Customer Economics v1) ---------------- */

  // Reads customer_economics/current and renders the Revenue Per Labor
  // Hour card. Handles four states:
  //   not_connected → CTA to /manager to connect QB
  //   error         → small error banner with the reason
  //   stale         → renders normally + freshness chip turns muted
  //   fresh         → full render
  async function renderCustomerEconomics() {
    const bodyEl = $('ceo-economics-body');
    const periodEl = $('ceo-economics-period');
    const refreshBtn = $('ceo-economics-refresh');
    if (!bodyEl) return;

    let snap;
    try {
      const doc = await db.collection('customer_economics').doc('current').get();
      if (!doc.exists) {
        bodyEl.innerHTML = econEmptyHtml(
          'No Customer Economics snapshot yet.',
          'The daily sync runs at 7 AM Pacific. Once QuickBooks is connected, this card will populate on the next sync.'
        );
        if (periodEl) periodEl.textContent = '';
        return;
      }
      snap = Object.assign({ _id: doc.id }, doc.data() || {});
    } catch (err) {
      console.warn('[ceo] customer_economics read failed', err);
      bodyEl.innerHTML = econEmptyHtml('Couldn\'t load Customer Economics.', err.message || 'unknown');
      return;
    }

    // Freshness chip
    if (periodEl) {
      const ageText = econFreshnessLabel(snap);
      periodEl.textContent = ageText;
    }

    // Wire refresh — admin only. Owners + executives always; admins by the
    // server-side check on refreshFinancialPulseV1.
    if (refreshBtn && window.REFRESH_FINANCIAL_PULSE_URL) {
      refreshBtn.hidden = false;
      refreshBtn.onclick = function () { handleEconRefresh(refreshBtn); };
    }

    if (snap.status === 'not_connected') {
      bodyEl.innerHTML = econEmptyHtml(
        'QuickBooks not connected.',
        (snap.error_message || 'Connect from /manager to enable Customer Economics.') +
          '<br><a class="ceo-econ-cta" href="/manager.html#qbo-connect">Open /manager</a>'
      );
      return;
    }
    if (snap.status === 'error') {
      bodyEl.innerHTML = econEmptyHtml('Customer Economics sync error.', snap.error_message || 'unknown');
      return;
    }

    const company = snap.company || {};
    const target  = Number(snap.target_rplh || 62);
    const gap     = Number(company.gap_to_target || 0);
    const avg     = Number(company.avg_rplh || 0);
    const needsImprovement = gap < 0;

    bodyEl.innerHTML =
      econSummaryHtml(company, target, avg, gap, needsImprovement) +
      econLeversHtml(company, needsImprovement) +
      econColumnsHtml(snap) +
      econRecommendationsHtml(snap) +
      econExcludedHtml(snap);
  }

  function econFmtCurrency(n) {
    const v = Math.round(Number(n) || 0);
    return '$' + v.toLocaleString();
  }
  function econFmtCurrencyCents(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function econFmtHours(n) {
    const v = Number(n) || 0;
    return (Math.round(v * 10) / 10).toFixed(1) + ' hrs';
  }
  function econEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function econFreshnessLabel(snap) {
    if (!snap || !snap.snapshot_at) return snap && snap.period_start
      ? (snap.period_start + ' → ' + snap.period_end)
      : '';
    const ts = snap.snapshot_at && snap.snapshot_at.toMillis
      ? snap.snapshot_at.toMillis()
      : (snap.snapshot_at._seconds ? snap.snapshot_at._seconds * 1000 : 0);
    if (!ts) return '';
    const ageMin = (Date.now() - ts) / 60000;
    const periodLabel = snap.period_start + ' → ' + snap.period_end;
    if (ageMin < 60) return periodLabel + ' · fresh';
    const hours = Math.floor(ageMin / 60);
    if (hours < 36) return periodLabel + ' · ' + hours + 'h ago';
    const days = Math.floor(hours / 24);
    return periodLabel + ' · ' + days + 'd ago';
  }

  function econEmptyHtml(title, sub) {
    return '<div class="ceo-econ-empty"><div style="font-weight:600;margin-bottom:6px">'
         + econEsc(title) + '</div><div>' + sub + '</div></div>';
  }

  function econSummaryHtml(company, target, avg, gap, needsImprovement) {
    const gapClass = needsImprovement ? 'is-bad' : 'is-good';
    const gapText  = (gap >= 0 ? '+' : '') + econFmtCurrencyCents(gap) + '/hr';
    const subAvg   = (Number(company.customers_at_or_above_target || 0))
                   + ' of ' + (Number(company.customers_at_or_above_target || 0) + Number(company.customers_below_target || 0))
                   + ' customers at or above target';
    return (
      '<div class="ceo-econ-summary">' +
        '<div class="ceo-econ-summary-item">' +
          '<span class="ceo-econ-summary-label">Company Average</span>' +
          '<span class="ceo-econ-summary-value">' + econFmtCurrencyCents(avg) + '/hr</span>' +
          '<span class="ceo-econ-summary-sub">Revenue Per Labor Hour</span>' +
        '</div>' +
        '<div class="ceo-econ-summary-item">' +
          '<span class="ceo-econ-summary-label">Target</span>' +
          '<span class="ceo-econ-summary-value">' + econFmtCurrencyCents(target) + '/hr</span>' +
          '<span class="ceo-econ-summary-sub">' + econEsc(subAvg) + '</span>' +
        '</div>' +
        '<div class="ceo-econ-summary-item">' +
          '<span class="ceo-econ-summary-label">Gap to Target</span>' +
          '<span class="ceo-econ-summary-value ' + gapClass + '">' + econEsc(gapText) + '</span>' +
          '<span class="ceo-econ-summary-sub">' +
            (needsImprovement ? 'Below target' : 'At or above target') +
          '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function econLeversHtml(company, needsImprovement) {
    if (!needsImprovement) {
      return (
        '<div class="ceo-econ-levers" style="grid-template-columns:1fr">' +
          '<div class="ceo-econ-lever">' +
            '<span class="ceo-econ-lever-label">Status</span>' +
            '<span class="ceo-econ-lever-value">Company average is at or above target. Keep it up.</span>' +
          '</div>' +
        '</div>'
      );
    }
    const inc = Number(company.improvement_required_monthly_increase || 0);
    const red = Number(company.improvement_required_labor_reduction || 0);
    return (
      '<div class="ceo-econ-levers">' +
        '<div class="ceo-econ-lever">' +
          '<span class="ceo-econ-lever-label">To Reach Target — Increase Monthly Revenue</span>' +
          '<span class="ceo-econ-lever-value">' + econFmtCurrency(inc) + '</span>' +
        '</div>' +
        '<div class="ceo-econ-lever-or">OR</div>' +
        '<div class="ceo-econ-lever">' +
          '<span class="ceo-econ-lever-label">Reduce Labor</span>' +
          '<span class="ceo-econ-lever-value">' + econFmtHours(red) + '/month</span>' +
        '</div>' +
      '</div>'
    );
  }

  function econCustomerRowHtml(c, target) {
    const rplh = Number(c.rplh || 0);
    const cls  = rplh >= target ? 'is-good' : 'is-bad';
    const name = econEsc(c.qbo_name || c.pioneer_name || '(unknown)');
    return (
      '<li class="ceo-econ-list-row">' +
        '<span class="ceo-econ-list-name">' + name + '</span>' +
        '<span class="ceo-econ-list-rplh ' + cls + '">' + econFmtCurrencyCents(rplh) + '/hr</span>' +
      '</li>'
    );
  }

  function econColumnsHtml(snap) {
    const target = Number(snap.target_rplh || 62);
    const top    = (snap.top_customers    || []).map(function (c) { return econCustomerRowHtml(c, target); }).join('');
    const bottom = (snap.bottom_customers || []).map(function (c) { return econCustomerRowHtml(c, target); }).join('');
    return (
      '<div class="ceo-econ-cols">' +
        '<div>' +
          '<p class="ceo-econ-col-title">Top 3 Customers</p>' +
          '<ul class="ceo-econ-list">' + (top || '<li class="ceo-econ-list-row"><span class="ceo-econ-list-name">—</span></li>') + '</ul>' +
        '</div>' +
        '<div>' +
          '<p class="ceo-econ-col-title">Bottom 3 Customers</p>' +
          '<ul class="ceo-econ-list">' + (bottom || '<li class="ceo-econ-list-row"><span class="ceo-econ-list-name">—</span></li>') + '</ul>' +
        '</div>' +
      '</div>'
    );
  }

  function econRecommendationsHtml(snap) {
    const recs = snap.recommendations || [];
    if (!recs.length) return '';
    const items = recs.map(function (c) {
      const name = econEsc(c.qbo_name || c.pioneer_name || '(unknown)');
      const rplh = econFmtCurrencyCents(c.rplh || 0);
      const gap  = econFmtCurrencyCents(c.gap_to_target || 0);
      const inc  = econFmtCurrency(c.required_monthly_increase || 0);
      const red  = econFmtHours(c.required_labor_reduction || 0);
      return (
        '<div class="ceo-econ-rec">' +
          '<div class="ceo-econ-rec-head">' +
            '<span>' + name + '</span>' +
            '<span style="color:#b91c1c">' + rplh + '/hr · gap ' + gap + '</span>' +
          '</div>' +
          '<div class="ceo-econ-rec-detail">' +
            'Raise monthly billing by <strong>' + inc + '</strong> ' +
            '<span style="opacity:0.6;padding:0 6px">OR</span> ' +
            'cut <strong>' + red + '/month</strong>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="ceo-econ-recs">' +
        '<p class="ceo-econ-col-title" style="margin-top:8px">Top ' + recs.length + ' Opportunities</p>' +
        items +
      '</div>'
    );
  }

  function econExcludedHtml(snap) {
    const n = Number(snap.customer_count_excluded || 0);
    if (!n) return '';
    return '<p class="ceo-econ-excluded">' + n + ' customer'
         + (n === 1 ? '' : 's')
         + ' excluded (low labor signal, mapping, or unbilled). '
         + 'Included: ' + Number(snap.customer_count_included || 0) + '.</p>';
  }

  async function handleEconRefresh(btn) {
    const url = window.REFRESH_FINANCIAL_PULSE_URL;
    if (!url) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Refreshing…';
    try {
      const idToken = await firebase.auth().currentUser.getIdToken();
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + idToken
        },
        body: JSON.stringify({})
      });
      const json = await r.json().catch(function () { return {}; });
      if (!r.ok || !json.ok) {
        btn.textContent = 'Failed';
        console.warn('[ceo] economics refresh failed', json);
        setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 1800);
        return;
      }
      await renderCustomerEconomics();
      btn.textContent = 'Refreshed';
      setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 1200);
    } catch (err) {
      console.warn('[ceo] economics refresh threw', err);
      btn.textContent = 'Failed';
      setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 1800);
    }
  }

  /* ============================================================
     Phase 30 — Financial Pulse renderer.
     ============================================================ */

  function pulseFmtMoney(n, opts) {
    if (n == null || isNaN(n)) return '—';
    const o = opts || {};
    const sign = (o.signed && n > 0) ? '+' : (o.signed && n < 0) ? '−' : '';
    const abs = Math.abs(n);
    return sign + '$' + abs.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }
  function pulseFmtMoneyShort(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pulseFmtPct(n) {
    if (n == null || isNaN(n)) return '';
    const sign = n > 0 ? '+' : (n < 0 ? '−' : '');
    return ' (' + sign + Math.abs(n).toFixed(1) + '%)';
  }
  function pulseArrow(direction) {
    if (direction === 'up')   return '<span class="ceo-pulse-arrow-up">↑</span> ';
    if (direction === 'down') return '<span class="ceo-pulse-arrow-down">↓</span> ';
    return '<span class="ceo-pulse-arrow-flat">→</span> ';
  }
  function pulseEmptyHtml(title, sub) {
    return '<div class="ceo-pulse-empty">' +
             '<p style="font-weight:600;">' + escapeHtml(title) + '</p>' +
             (sub ? '<p style="margin-top:6px;">' + sub + '</p>' : '') +
           '</div>';
  }
  function pulseFreshnessLabel(snap) {
    if (!snap || !snap.snapshot_at) return '';
    const ts = snap.snapshot_at;
    const ms = (ts && ts.toMillis) ? ts.toMillis()
            : (ts && ts.seconds)   ? ts.seconds * 1000
            : 0;
    if (!ms) return '';
    try {
      return 'as of ' + new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      }).format(new Date(ms)) + ' PT';
    } catch (_e) { return ''; }
  }

  async function renderFinancialPulse() {
    const bodyEl    = $('ceo-pulse-body');
    const periodEl  = $('ceo-pulse-period');
    const refreshBtn = $('ceo-pulse-refresh');
    if (!bodyEl) return;

    let snap;
    try {
      const doc = await db.collection('financial_pulse').doc('current').get();
      if (!doc.exists) {
        bodyEl.innerHTML = pulseEmptyHtml(
          'No Financial Pulse snapshot yet.',
          'The daily sync runs at 7:05 AM Pacific. Once QuickBooks is connected, this card will populate on the next sync.'
        );
        if (periodEl) periodEl.textContent = '';
        return;
      }
      snap = Object.assign({ _id: doc.id }, doc.data() || {});
    } catch (err) {
      console.warn('[ceo] financial_pulse read failed', err);
      bodyEl.innerHTML = pulseEmptyHtml('Couldn\'t load Financial Pulse.', err.message || 'unknown');
      return;
    }

    if (periodEl) periodEl.textContent = pulseFreshnessLabel(snap);

    if (refreshBtn && window.REFRESH_CEO_FINANCIAL_PULSE_URL) {
      refreshBtn.hidden = false;
      refreshBtn.onclick = function () { handlePulseRefresh(refreshBtn); };
    }

    if (snap.status === 'not_connected') {
      bodyEl.innerHTML = pulseEmptyHtml(
        'QuickBooks not connected.',
        (snap.error_message || 'Connect from /manager to enable Financial Pulse.') +
          '<br><a class="ceo-pulse-cta" href="/manager.html#qbo-connect">Open /manager</a>'
      );
      return;
    }
    if (snap.status === 'error') {
      bodyEl.innerHTML = pulseEmptyHtml('Financial Pulse sync error.', snap.error_message || 'unknown');
      return;
    }

    bodyEl.innerHTML =
      '<div class="ceo-pulse-grid">' +
        pulseTileCashToday(snap.cash_today) +
        pulseTileCashRunway(snap.cash_runway) +
        pulseTileTrend('30-Day Trend', snap.trend_30d) +
        pulseTileTrend('90-Day Trend', snap.trend_90d) +
        pulseTileOpenInvoices(snap.invoices) +
        pulseTileOverdueInvoices(snap.invoices) +
        pulseTileCollectionsWatch(snap.collections_watch) +
        pulseTilePayroll(snap.payroll) +
        pulseTileNeedsNick(snap.needs_nick) +
      '</div>';
  }

  function pulseTileCashToday(c) {
    if (!c) return '<div class="ceo-pulse-tile"><p class="ceo-pulse-tile-eyebrow">Cash Today</p><p class="ceo-pulse-tile-value">—</p></div>';
    const sub = c.accounts && c.accounts.length
      ? '<ul class="ceo-pulse-tile-list">' +
          c.accounts.map(function (a) {
            return '<li><span>' + escapeHtml(a.name) + '</span>' +
                   '<span class="ceo-pulse-list-amt">' + pulseFmtMoneyShort(a.current_balance) + '</span></li>';
          }).join('') +
        '</ul>'
      : '<p class="ceo-pulse-tile-sub">No bank accounts on file.</p>';
    return '<div class="ceo-pulse-tile">' +
             '<p class="ceo-pulse-tile-eyebrow">Cash Today</p>' +
             '<p class="ceo-pulse-tile-value">' + pulseFmtMoney(c.total_cash_on_hand) + '</p>' +
             sub +
             '<p class="ceo-pulse-tile-disclosure">' + escapeHtml(c.disclosure || '') + '</p>' +
           '</div>';
  }

  function pulseTileCashRunway(r) {
    if (!r) return '';
    let valHtml, sub;
    if (r.state === 'burning' && r.months_remaining != null) {
      valHtml = '<span class="ceo-pulse-runway-state-burning">' + r.months_remaining.toFixed(1) + ' mo</span>';
      sub = 'Net out: ' + pulseFmtMoney(Math.abs(r.monthly_net_change)) + '/mo · cap 24 mo';
    } else if (r.state === 'growing') {
      valHtml = '<span class="ceo-pulse-runway-state-growing">Growing</span>';
      sub = 'Net in: ' + pulseFmtMoney(Math.abs(r.monthly_net_change)) + '/mo';
    } else if (r.state === 'stable') {
      valHtml = '<span class="ceo-pulse-runway-state-stable">Stable</span>';
      sub = 'Cash holding steady';
    } else {
      valHtml = '<span class="ceo-pulse-runway-state-unknown">—</span>';
      sub = 'Need 90 days of QB history to estimate';
    }
    return '<div class="ceo-pulse-tile">' +
             '<p class="ceo-pulse-tile-eyebrow">Cash Runway</p>' +
             '<p class="ceo-pulse-tile-value">' + valHtml + '</p>' +
             '<p class="ceo-pulse-tile-sub">' + escapeHtml(sub) + '</p>' +
             '<p class="ceo-pulse-tile-disclosure">' + escapeHtml(r.disclosure || '') + '</p>' +
           '</div>';
  }

  function pulseTileTrend(title, t) {
    if (!t || !t.available) {
      return '<div class="ceo-pulse-tile">' +
               '<p class="ceo-pulse-tile-eyebrow">' + escapeHtml(title) + '</p>' +
               '<p class="ceo-pulse-tile-value" style="font-size:18px;">Unavailable</p>' +
               '<p class="ceo-pulse-tile-sub">' + escapeHtml(t && t.reason || '') + '</p>' +
             '</div>';
    }
    const pct = t.delta_percent != null ? pulseFmtPct(t.delta_percent) : '';
    return '<div class="ceo-pulse-tile">' +
             '<p class="ceo-pulse-tile-eyebrow">' + escapeHtml(title) + '</p>' +
             '<p class="ceo-pulse-tile-value">' + pulseArrow(t.direction) +
                pulseFmtMoney(t.delta_dollars, { signed: true }) + escapeHtml(pct) + '</p>' +
             '<p class="ceo-pulse-tile-sub">vs ' + escapeHtml(t.comparison_date || '') + '</p>' +
           '</div>';
  }

  function pulseTileOpenInvoices(inv) {
    if (!inv) return '';
    return '<div class="ceo-pulse-tile">' +
             '<p class="ceo-pulse-tile-eyebrow">Open Invoices</p>' +
             '<p class="ceo-pulse-tile-value">' + pulseFmtMoneyShort(inv.open_total_amount) + '</p>' +
             '<p class="ceo-pulse-tile-sub">' + (inv.open_count || 0) + ' invoice' +
                ((inv.open_count === 1) ? '' : 's') +
                ' · paid last 30d ' + pulseFmtMoneyShort(inv.paid_last_30d_amount) + '</p>' +
           '</div>';
  }

  function pulseTileOverdueInvoices(inv) {
    if (!inv) return '';
    const oldestLine = (inv.oldest_overdue_days != null)
      ? ' · oldest ' + inv.oldest_overdue_days + ' days'
      : '';
    return '<div class="ceo-pulse-tile">' +
             '<p class="ceo-pulse-tile-eyebrow">Overdue</p>' +
             '<p class="ceo-pulse-tile-value">' + pulseFmtMoneyShort(inv.overdue_total_amount) + '</p>' +
             '<p class="ceo-pulse-tile-sub">' + (inv.overdue_count || 0) + ' invoice' +
                ((inv.overdue_count === 1) ? '' : 's') + escapeHtml(oldestLine) + '</p>' +
           '</div>';
  }

  function pulseTileCollectionsWatch(list) {
    const rows = (list || []).map(function (r) {
      const days = (r.days_overdue != null) ? r.days_overdue + 'd' : '—';
      const inv  = r.doc_number ? 'Inv #' + r.doc_number : '';
      return '<li>' +
               '<span>' +
                 '<strong>' + escapeHtml(r.customer_name) + '</strong>' +
                 ' <span class="ceo-pulse-list-sub">' + escapeHtml(days) +
                   (inv ? ' · ' + escapeHtml(inv) : '') + '</span>' +
               '</span>' +
               '<span class="ceo-pulse-list-amt">' + pulseFmtMoneyShort(r.amount_outstanding) + '</span>' +
             '</li>';
    }).join('');
    const body = rows
      ? '<ul class="ceo-pulse-tile-list">' + rows + '</ul>'
      : '<p class="ceo-pulse-tile-sub">No overdue invoices on file.</p>';
    return '<div class="ceo-pulse-tile ceo-pulse-grid-full">' +
             '<p class="ceo-pulse-tile-eyebrow">Collections Watch</p>' +
             body +
           '</div>';
  }

  function pulseTilePayroll(p) {
    if (!p || !p.available) {
      return '<div class="ceo-pulse-tile ceo-pulse-grid-full">' +
               '<p class="ceo-pulse-tile-eyebrow">Payroll Snapshot</p>' +
               '<p class="ceo-pulse-tile-sub">' + escapeHtml((p && p.reason) || 'No payroll exports yet.') + '</p>' +
             '</div>';
    }
    const trendLine = p.trend
      ? pulseArrow(p.trend.direction) +
        (p.trend.delta_hours > 0 ? '+' : (p.trend.delta_hours < 0 ? '−' : '±')) +
        Math.abs(p.trend.delta_hours).toFixed(2) + ' hrs vs ' +
        escapeHtml(p.trend.prior_export_period || 'prior cycle')
      : '';
    return '<div class="ceo-pulse-tile ceo-pulse-grid-full">' +
             '<p class="ceo-pulse-tile-eyebrow">Payroll Snapshot</p>' +
             '<p class="ceo-pulse-tile-value" style="font-size:22px;">' +
               p.last_export_total_paid_hours.toFixed(2) + ' hrs · ' +
               (p.last_export_employee_count || 0) + ' employees' +
             '</p>' +
             '<p class="ceo-pulse-tile-sub">' + escapeHtml(p.last_export_period || '') +
                ' · ' + (p.last_export_session_count || 0) + ' sessions</p>' +
             (trendLine ? '<p class="ceo-pulse-tile-disclosure" style="font-style:normal;">' + trendLine + '</p>' : '') +
           '</div>';
  }

  function pulseTileNeedsNick(list) {
    const rows = (list || []).map(function (n) {
      return '<li>' +
               '<p class="ceo-pulse-nick-title">' +
                 '<span class="ceo-pulse-nick-sev ceo-pulse-nick-sev-' + escapeHtml(n.severity) + '">' +
                   escapeHtml(n.severity) +
                 '</span>' +
                 escapeHtml(n.title || '') +
               '</p>' +
               '<p class="ceo-pulse-nick-msg">' + escapeHtml(n.message || '') +
                 (n.action_url ? ' <a class="ceo-pulse-cta" style="padding:2px 12px;font-size:11px;" href="' +
                   escapeHtml(n.action_url) + '">Open</a>' : '') +
               '</p>' +
             '</li>';
    }).join('');
    const body = rows
      ? '<ul class="ceo-pulse-nick-list">' + rows + '</ul>'
      : '<p class="ceo-pulse-nick-empty">No items need your attention right now.</p>';
    return '<div class="ceo-pulse-tile ceo-pulse-grid-full ceo-pulse-nick">' +
             '<p class="ceo-pulse-tile-eyebrow ceo-pulse-nick-eyebrow">Needs Nick</p>' +
             body +
           '</div>';
  }

  async function handlePulseRefresh(btn) {
    if (!btn || !window.REFRESH_CEO_FINANCIAL_PULSE_URL) return;
    const originalText = btn.textContent;
    btn.textContent = 'Refreshing…';
    btn.disabled = true;
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(window.REFRESH_CEO_FINANCIAL_PULSE_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + idToken,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({})
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body || !body.ok) {
        const msg = (body && body.error) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      await renderFinancialPulse();
      btn.textContent = 'Refreshed';
      setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 1200);
    } catch (err) {
      console.warn('[ceo] pulse refresh threw', err);
      btn.textContent = 'Failed';
      setTimeout(function () { btn.textContent = originalText; btn.disabled = false; }, 1800);
    }
  }

  /* ---------------- Boot ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    bindSignIn();
    wireQuickActions();
  });

})();
