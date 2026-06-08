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
 * Five sections:
 *   1. Company Health   — composite Operational Health %, 4 pillar tiles
 *   2. Dangers          — "Where to lead this week" — calm, guiding
 *   3. Opportunities    — "What is working" — wins, momentum
 *   4. Scorecards       — Operations / People / Quality / Hiring (30d)
 *   5. Leadership Pulse — personal accomplishments + items on your desk
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
        .orderBy('created_at', 'desc').limit(7).get())
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
      omBottlenecks: docs(16)
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

  function render(snap) {
    const health = calcCompanyHealth(snap);
    renderCompanyHealth(snap, health);
    renderDangers(snap, health);
    renderOpportunities(snap, health);
    renderScorecards(snap, health);
    renderLeadershipPulse(snap, health);
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

  /* ---------------- Boot ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    bindSignIn();
  });

})();
