/* Pioneer DCR Hub — Admin Labor Review Lite tab (Phase 1e Lite, Path A).
 *
 * Surface: today's Pioneer Time Clock sessions for admin review.
 *
 * Two render blocks inside the #labor-review panel:
 *   1. "Open Active Sessions" — techs currently clocked in (active_service_sessions).
 *      Each card supports "Force close…" → opens #labor-force-close-modal.
 *   2. "Today's Sessions" — every pioneer_service_sessions doc where
 *      service_date == today (Pacific). Each row shows employee / customer /
 *      status / clock in/out / worked / budget / geo / DCR / needs_review
 *      and exposes a "Review" button when needs_review === true.
 *
 * Firestore I/O (admin-allowlist reads, isPioneerAdmin() updates — no rule
 * changes required by Phase 1e Lite):
 *   • pioneer_service_sessions  — read (service_date == today, client sort);
 *                                 update on Mark Reviewed + Force Close
 *   • active_service_sessions   — read (whole collection, small);
 *                                 delete on Force Close
 *   • service_assignments       — read by doc-id (budget_minutes, customer)
 *   • cleaning_techs            — read via __pioneerAdmin.deps.getTechs() cache
 *
 * Path A trade-off (per Phase 1e plan): admin force-close updates the session
 * doc and deletes the active-singleton, but does NOT write a time_punches
 * doc. The session metadata documents the override: force_closed_by_admin,
 * force_close_reason, force_closed_by, force_closed_at. Path B (proper
 * punch write with rule exemption) is deferred.
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * Exports window.__pioneerAdmin.tabs.laborReview = { init, refresh }.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-labor-review.js: utils + shell modules must load first");
  }
  const { escapeHtml, pacificDateString } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ---------- state ---------- */

  let sessions          = [];   // pioneer_service_sessions for today (sorted desc by clock_in)
  let activeByUid       = {};   // doc-id → active_service_sessions data
  let assignmentsById   = {};   // assignment_id → service_assignments data
  let techsByEmail      = {};   // staff_email → cleaning_techs row
  let techsByUid        = {};   // staff_uid   → cleaning_techs row
  let loaded            = false;
  let loading           = false;

  /* ---------- helpers ---------- */

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function fmtTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtDateTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtMinutes(m) {
    if (m == null || isNaN(m)) return "—";
    const n = Math.round(m);
    if (n <= 0) return "0m";
    const h = Math.floor(n / 60);
    const r = n % 60;
    if (h === 0) return r + "m";
    if (r === 0) return h + "h";
    return h + "h " + r + "m";
  }
  function liveElapsedMinutes(clockInAt) {
    const ms = tsToMs(clockInAt);
    if (!ms) return null;
    return Math.max(0, Math.round((Date.now() - ms) / 60000));
  }

  function techName(email, uid) {
    const t = (email && techsByEmail[email]) || (uid && techsByUid[uid]);
    if (t) {
      return t.display_name || t.first_name || t.email || email || uid || "Tech";
    }
    return email || uid || "Tech";
  }
  function customerLabel(session, assignment) {
    const name = (assignment && (assignment.customer_name || assignment.customer_slug))
              || session.customer_name
              || session.customer_slug
              || "—";
    const addr = (assignment && assignment.location_address) || session.location_address || "";
    if (addr) return name + " · " + addr;
    return name;
  }

  function statusChip(s, needsReview) {
    if (needsReview) {
      return '<span class="lr-chip is-review">Needs review</span>';
    }
    switch (s) {
      case "active":      return '<span class="lr-chip is-active">Active</span>';
      case "paused":      return '<span class="lr-chip is-paused">Paused</span>';
      case "dcr_pending": return '<span class="lr-chip is-dcr">DCR pending</span>';
      case "completed":   return '<span class="lr-chip is-complete">Complete</span>';
      case "canceled":    return '<span class="lr-chip is-canceled">Canceled</span>';
      case "missed":      return '<span class="lr-chip is-missed">Missed</span>';
      default:            return '<span class="lr-chip">' + escapeHtml(s || "—") + '</span>';
    }
  }
  // Phase 2A.2 — small chip rendered on rows whose underlying assignment
  // (or session) was admin-removed from PTC. Keeps the row visible for
  // audit but signals "no longer in the tech-facing PTC list."
  function removedChip() {
    return '<span class="lr-chip is-removed" title="Hidden from Pioneer Time Clock for the assigned tech">Removed from PTC</span>';
  }
  function geoChip(g) {
    if (!g) return "—";
    if (g === "onsite")  return '<span class="lr-geo is-onsite">Onsite</span>';
    if (g === "nearby")  return '<span class="lr-geo is-nearby">Nearby</span>';
    if (g === "offsite") return '<span class="lr-geo is-offsite">Offsite</span>';
    if (/^unknown/.test(g)) {
      return '<span class="lr-geo is-unknown" title="' + escapeHtml(g.replace(/_/g, " ")) +
        '">Unavailable</span>';
    }
    return escapeHtml(g);
  }
  function dcrChip(session) {
    const status = session.dcr_status || (session.dcr_id ? "submitted" : null);
    if (status === "submitted") return '<span class="lr-dcr is-submitted">DCR ✓</span>';
    if (status === "pending")   return '<span class="lr-dcr is-pending">DCR pending</span>';
    return '<span class="lr-dcr is-none">—</span>';
  }
  function needsReviewFlag(session) {
    return session.needs_review === true;
  }

  /* ---------- loaders ---------- */

  function setState(state, message) {
    const loadingEl = $("labor-loading");
    const errorEl   = $("labor-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && message) errorEl.textContent = message;
    }
  }

  async function loadAssignmentsByIds(ids) {
    const db = firebase.firestore();
    const unique = Array.from(new Set(ids.filter(Boolean)));
    const need = unique.filter(function (id) { return !assignmentsById[id]; });
    if (!need.length) return;
    const snaps = await Promise.all(need.map(function (id) {
      return db.collection("service_assignments").doc(id).get().catch(function () { return null; });
    }));
    snaps.forEach(function (s, i) {
      if (s && s.exists) {
        assignmentsById[need[i]] = Object.assign({ _id: s.id }, s.data() || {});
      } else {
        assignmentsById[need[i]] = null;
      }
    });
  }

  function hydrateTechMaps() {
    techsByEmail = {};
    techsByUid   = {};
    let list = [];
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      if (deps && typeof deps.getTechs === "function") list = deps.getTechs() || [];
    } catch (_e) { list = []; }
    list.forEach(function (t) {
      if (!t) return;
      if (t.email) techsByEmail[t.email.toLowerCase()] = t;
      if (t.uid)   techsByUid[t.uid] = t;
    });
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      hydrateTechMaps();
      const db = firebase.firestore();
      const today = pacificDateString(new Date());

      const [sessSnap, activeSnap] = await Promise.all([
        db.collection("pioneer_service_sessions")
          .where("service_date", "==", today)
          .get(),
        db.collection("active_service_sessions").get()
      ]);

      sessions = sessSnap.docs.map(function (d) {
        return Object.assign({ _id: d.id }, d.data() || {});
      });
      sessions.sort(function (a, b) {
        return tsToMs(b.clock_in_at) - tsToMs(a.clock_in_at);
      });

      activeByUid = {};
      activeSnap.docs.forEach(function (d) {
        activeByUid[d.id] = Object.assign({ _id: d.id }, d.data() || {});
      });

      // Hydrate assignments referenced by either source.
      const ids = [];
      sessions.forEach(function (s) { if (s.assignment_id) ids.push(s.assignment_id); });
      Object.keys(activeByUid).forEach(function (uid) {
        const a = activeByUid[uid];
        if (a && a.assignment_id) ids.push(a.assignment_id);
      });
      await loadAssignmentsByIds(ids);

      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[labor-review] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read access to pioneer_service_sessions + active_service_sessions."
        : "Couldn't load labor data: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderActive();
    renderTable();
  }

  function renderHeader() {
    const sub = $("labor-sub");
    if (!sub) return;
    const today = pacificDateString(new Date());
    let label = today;
    try {
      label = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "long",
        month: "long", day: "numeric", year: "numeric"
      }).format(new Date(today + "T12:00:00Z"));
    } catch (_e) {}
    const activeCount = Object.keys(activeByUid).length;
    const needsReviewCount = sessions.filter(needsReviewFlag).length;
    sub.textContent = label + " · " + sessions.length + " session" +
      (sessions.length === 1 ? "" : "s") +
      " · " + activeCount + " open · " + needsReviewCount + " needs review";
  }

  function renderActive() {
    const list  = $("labor-active-list");
    const empty = $("labor-active-empty");
    if (!list || !empty) return;
    const uids = Object.keys(activeByUid);
    if (!uids.length) {
      list.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    // Sort by most recent clock-in first.
    uids.sort(function (a, b) {
      return tsToMs(activeByUid[b].clock_in_at) - tsToMs(activeByUid[a].clock_in_at);
    });
    list.innerHTML = uids.map(function (uid) {
      const a = activeByUid[uid];
      const sid = a.session_id || a.pioneer_session_id || a.pioneer_service_session_id || "";
      const sess = sessions.find(function (s) { return s._id === sid; }) || null;
      const assignment = a.assignment_id ? assignmentsById[a.assignment_id] : null;
      const elapsed = liveElapsedMinutes(a.clock_in_at);
      const tech = techName(a.staff_email, uid);
      const cust = customerLabel(sess || a, assignment);
      const stat = (sess && sess.status) || "active";
      return (
        '<article class="labor-active-card" data-session-id="' + escapeHtml(sid) + '" ' +
                  'data-active-uid="' + escapeHtml(uid) + '">' +
          '<header class="labor-active-head">' +
            '<div class="labor-active-who">' +
              '<div class="labor-active-name">' + escapeHtml(tech) + '</div>' +
              '<div class="labor-active-sub">' + escapeHtml(cust) + '</div>' +
            '</div>' +
            statusChip(stat, sess && needsReviewFlag(sess)) +
          '</header>' +
          '<div class="labor-active-meta">' +
            '<span>Clocked in <strong>' + escapeHtml(fmtTime(a.clock_in_at)) + '</strong></span>' +
            (elapsed != null ? '<span>· ' + escapeHtml(fmtMinutes(elapsed)) + ' running</span>' : '') +
            (sess && sess.clock_in_geo_status
              ? '<span>· ' + geoChip(sess.clock_in_geo_status) + '</span>'
              : '') +
          '</div>' +
          '<div class="labor-active-actions">' +
            '<button type="button" class="labor-btn labor-btn-danger" data-act="force-close">' +
              'Force close…</button>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  // Phase 2A.2 — combined status display (legacy chip + optional
  // "Removed from PTC" chip when the session was admin-removed).
  function sessionStatusDisplay(s) {
    const base = statusChip(s.status, needsReviewFlag(s));
    return (s && s.admin_removed === true) ? (removedChip() + " " + base) : base;
  }
  function removedMetaLine(s) {
    if (!s || s.admin_removed !== true) return "";
    const who = (s.removed_by && (s.removed_by.displayName || s.removed_by.email)) || "admin";
    const when = s.removed_at ? fmtDateTime(s.removed_at) : "";
    const reason = s.removed_reason ? " — " + s.removed_reason : "";
    return '<div class="lr-removed-meta">Removed from PTC' +
           (when ? ' ' + escapeHtml(when) : '') +
           ' by ' + escapeHtml(who) +
           escapeHtml(reason) +
           '</div>';
  }

  function renderTable() {
    const wrap = $("labor-table");
    const empty = $("labor-table-empty");
    if (!wrap || !empty) return;
    if (!sessions.length) {
      wrap.innerHTML = ""; empty.hidden = false; return;
    }
    empty.hidden = true;
    const headerHtml =
      '<div class="labor-row labor-row-head">' +
        '<div class="lr-col-emp">Employee</div>' +
        '<div class="lr-col-cust">Customer</div>' +
        '<div class="lr-col-status">Status</div>' +
        '<div class="lr-col-in">In</div>' +
        '<div class="lr-col-out">Out</div>' +
        '<div class="lr-col-wkd">Worked</div>' +
        '<div class="lr-col-bgt">Budget</div>' +
        '<div class="lr-col-geo">Geo (in/out)</div>' +
        '<div class="lr-col-dcr">DCR</div>' +
        '<div class="lr-col-act"></div>' +
      '</div>';
    const rowsHtml = sessions.map(function (s) {
      const assignment = s.assignment_id ? assignmentsById[s.assignment_id] : null;
      const budget = (s.budget_minutes != null ? s.budget_minutes
                  : (assignment && assignment.budget_minutes != null ? assignment.budget_minutes
                  : null));
      const worked = s.work_minutes != null
        ? s.work_minutes
        : (s.status === "active" ? liveElapsedMinutes(s.clock_in_at) : null);
      const reviewBtn = needsReviewFlag(s)
        ? '<button type="button" class="labor-btn labor-btn-review" data-act="mark-reviewed">Review</button>'
        : '';
      // Phase 2A.2 — Remove button is available on rows that have an
      // assignment_id and aren't already admin-removed. Admin can stack
      // it with Review when both apply.
      const removeBtn = (s.assignment_id && s.admin_removed !== true)
        ? '<button type="button" class="labor-btn labor-btn-remove" data-act="remove-from-ptc">Remove…</button>'
        : '';
      const reviewedMeta = (s.reviewed_by && s.reviewed_at)
        ? '<div class="lr-reviewed-meta">Reviewed ' + escapeHtml(fmtDateTime(s.reviewed_at)) +
            ' by ' + escapeHtml(s.reviewed_by.displayName || s.reviewed_by.email || "admin") +
          '</div>'
        : '';
      const forceClosedMeta = (s.force_closed_by_admin && s.force_closed_by)
        ? '<div class="lr-forceclosed-meta">Force-closed by ' +
            escapeHtml(s.force_closed_by.displayName || s.force_closed_by.email || "admin") +
            (s.force_close_reason ? ' — ' + escapeHtml(s.force_close_reason) : '') +
          '</div>'
        : '';
      const removedMeta = removedMetaLine(s);
      const summary = techName(s.staff_email, s.staff_uid) + " · " + customerLabel(s, assignment);
      return (
        '<div class="labor-row" data-session-id="' + escapeHtml(s._id) + '"' +
            ' data-assignment-id="' + escapeHtml(s.assignment_id || "") + '"' +
            ' data-summary="' + escapeHtml(summary) + '">' +
          '<div class="lr-col-emp">' + escapeHtml(techName(s.staff_email, s.staff_uid)) + '</div>' +
          '<div class="lr-col-cust">' + escapeHtml(customerLabel(s, assignment)) + '</div>' +
          '<div class="lr-col-status">' + sessionStatusDisplay(s) + '</div>' +
          '<div class="lr-col-in">' + escapeHtml(fmtTime(s.clock_in_at)) + '</div>' +
          '<div class="lr-col-out">' + escapeHtml(fmtTime(s.clock_out_at)) + '</div>' +
          '<div class="lr-col-wkd">' + escapeHtml(fmtMinutes(worked)) + '</div>' +
          '<div class="lr-col-bgt">' + escapeHtml(fmtMinutes(budget)) + '</div>' +
          '<div class="lr-col-geo">' + geoChip(s.clock_in_geo_status) +
              ' / ' + geoChip(s.clock_out_geo_status) + '</div>' +
          '<div class="lr-col-dcr">' + dcrChip(s) + '</div>' +
          '<div class="lr-col-act">' + reviewBtn + removeBtn + '</div>' +
          (reviewedMeta || forceClosedMeta || removedMeta
            ? '<div class="lr-row-meta">' + reviewedMeta + forceClosedMeta + removedMeta + '</div>'
            : '') +
        '</div>'
      );
    }).join("");
    wrap.innerHTML = headerHtml + rowsHtml;
  }

  /* ---------- writers ---------- */

  function currentActor() {
    const u = firebase.auth().currentUser;
    return u
      ? { uid: u.uid, email: u.email || null, displayName: u.displayName || u.email || "admin" }
      : null;
  }

  async function markReviewed(sessionId) {
    const actor = currentActor();
    await firebase.firestore().collection("pioneer_service_sessions").doc(sessionId).update({
      needs_review: false,
      reviewed_at:  firebase.firestore.FieldValue.serverTimestamp(),
      reviewed_by:  actor
    });
  }

  // Path A force-close: transactional update of session + delete of the
  // active-singleton. No time_punches write. Audit metadata lives on the
  // session doc.
  async function forceCloseSession(opts) {
    const sessionId  = opts.sessionId;
    const activeUid  = opts.activeUid;
    const clockOutAt = opts.clockOutAt;  // Firestore Timestamp OR null → serverTimestamp
    const reason     = opts.reason;
    const actor      = currentActor();
    const db         = firebase.firestore();

    await db.runTransaction(async function (tx) {
      const sessRef = db.collection("pioneer_service_sessions").doc(sessionId);
      const sessSnap = await tx.get(sessRef);
      if (!sessSnap.exists) throw new Error("Session no longer exists");
      const sess = sessSnap.data() || {};

      const clockInMs = tsToMs(sess.clock_in_at);
      const outMs     = tsToMs(clockOutAt) || Date.now();
      const workMin   = clockInMs ? Math.max(0, Math.round((outMs - clockInMs) / 60000)) : null;

      const patch = {
        status:                  "completed",
        clock_out_at:            clockOutAt || firebase.firestore.FieldValue.serverTimestamp(),
        work_minutes:            workMin,
        force_closed_by_admin:   true,
        force_close_reason:      reason,
        force_closed_by:         actor,
        force_closed_at:         firebase.firestore.FieldValue.serverTimestamp(),
        needs_review:            true
      };
      tx.update(sessRef, patch);

      if (activeUid) {
        const activeRef = db.collection("active_service_sessions").doc(activeUid);
        tx.delete(activeRef);
      }
    });
  }

  /* ---------- modal ---------- */

  function openForceCloseModal(sessionId, activeUid) {
    const modal = $("labor-force-close-modal");
    if (!modal) return;
    const sess = sessions.find(function (s) { return s._id === sessionId; }) || activeByUid[activeUid] || {};
    const tech = techName(sess.staff_email, sess.staff_uid || activeUid);
    const assignment = sess.assignment_id ? assignmentsById[sess.assignment_id] : null;
    const cust = customerLabel(sess, assignment);

    const sidEl = $("labor-fc-session-id");   if (sidEl) sidEl.value = sessionId || "";
    const uidEl = $("labor-fc-active-uid");   if (uidEl) uidEl.value = activeUid || "";
    const sumEl = $("labor-fc-summary");
    if (sumEl) sumEl.textContent = tech + " · " + cust + " · clocked in " + fmtDateTime(sess.clock_in_at);

    const tEl = $("labor-fc-clock-out-time");
    if (tEl) {
      // Default to "now" rendered as a local datetime-local string.
      const d = new Date();
      const pad = function (n) { return String(n).padStart(2, "0"); };
      tEl.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
                  "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    const rEl = $("labor-fc-reason");  if (rEl) rEl.value = "";
    const eEl = $("labor-fc-err");     if (eEl) { eEl.textContent = ""; eEl.hidden = true; }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeForceCloseModal() {
    const modal = $("labor-force-close-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function submitForceClose() {
    const sessionId = ($("labor-fc-session-id") && $("labor-fc-session-id").value) || "";
    const activeUid = ($("labor-fc-active-uid") && $("labor-fc-active-uid").value) || "";
    const reason    = (($("labor-fc-reason") && $("labor-fc-reason").value) || "").trim();
    const timeStr   = ($("labor-fc-clock-out-time") && $("labor-fc-clock-out-time").value) || "";
    const errEl     = $("labor-fc-err");
    const saveBtn   = $("labor-fc-save");

    function showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    }

    if (!sessionId) { showErr("Missing session id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }

    let clockOutAt = null;
    if (timeStr) {
      const ms = Date.parse(timeStr);
      if (isNaN(ms)) { showErr("Invalid clock-out time."); return; }
      if (ms > Date.now() + 60000) { showErr("Clock-out time can't be in the future."); return; }
      clockOutAt = firebase.firestore.Timestamp.fromMillis(ms);
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
      await forceCloseSession({
        sessionId:  sessionId,
        activeUid:  activeUid || null,
        clockOutAt: clockOutAt,
        reason:     reason
      });
      closeForceCloseModal();
      refresh();
    } catch (err) {
      console.error("[labor-review] force close failed", err);
      showErr((err && (err.message || err.code)) || "Force-close failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- Phase 2A.2: Remove assignment from PTC ----------
   *
   * Reads service_assignments/{id}, blocks if an active_service_session
   * points at this assignment (force-close first per spec), then in one
   * batch:
   *   • service_assignments/{id}.update({ status: "admin_removed",
   *       removed_from_ptc: true, removed_reason, removed_by, removed_at })
   *   • for each pioneer_service_sessions where assignment_id == id:
   *       .update({ admin_removed: true, removed_reason, removed_by,
   *                 removed_at, needs_review: true })
   *
   * NEVER deletes any doc. Audit trail preserved. /work hides assignments
   * whose status === "admin_removed" OR removed_from_ptc === true
   * (service-clock.js filter, Phase 2A.2).
   */
  async function removeAssignmentFromPtc(opts) {
    const assignmentId = opts.assignmentId;
    const reason       = opts.reason;
    const actor        = currentActor();
    const db           = firebase.firestore();
    const sts          = firebase.firestore.FieldValue.serverTimestamp();

    if (!assignmentId) throw new Error("Missing assignment id.");

    const assignRef  = db.collection("service_assignments").doc(assignmentId);
    const assignSnap = await assignRef.get();
    if (!assignSnap.exists) throw new Error("Assignment not found: " + assignmentId);
    const assignData = assignSnap.data() || {};
    const staffUid   = assignData.staff_uid || "";

    // Block if the assigned tech is actively clocked into this assignment.
    if (staffUid) {
      const activeSnap = await db.collection("active_service_sessions")
        .doc(staffUid).get();
      if (activeSnap.exists) {
        const active = activeSnap.data() || {};
        if (active.assignment_id === assignmentId) {
          throw new Error(
            "Tech is currently clocked into this assignment. " +
            "Use Force close in the Open Active Sessions block first, then Remove."
          );
        }
      }
    }

    // Fetch every pioneer_service_sessions doc that points at this
    // assignment. Each gets the admin_removed audit fields. Sessions
    // are NOT deleted; work_minutes / clock-in / clock-out preserved.
    const sessionsSnap = await db.collection("pioneer_service_sessions")
      .where("assignment_id", "==", assignmentId)
      .get();

    const batch = db.batch();
    batch.update(assignRef, {
      status:           "admin_removed",
      removed_from_ptc: true,
      removed_reason:   reason,
      removed_by:       actor,
      removed_at:       sts,
      updated_at:       sts,
      updated_by:       actor
    });
    sessionsSnap.docs.forEach(function (d) {
      batch.update(d.ref, {
        admin_removed: true,
        removed_reason: reason,
        removed_by:    actor,
        removed_at:    sts,
        needs_review:  true
      });
    });
    await batch.commit();
    return { affected_sessions: sessionsSnap.size };
  }

  function openRemoveModal(assignmentId, summary) {
    const modal = $("labor-remove-modal");
    if (!modal) return;
    const idEl = $("labor-rm-assignment-id"); if (idEl) idEl.value = assignmentId || "";
    const sEl  = $("labor-rm-summary");       if (sEl)  sEl.textContent = summary || "—";
    const rEl  = $("labor-rm-reason");        if (rEl)  rEl.value = "";
    const eEl  = $("labor-rm-err");           if (eEl)  { eEl.textContent = ""; eEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setTimeout(function () { const r = $("labor-rm-reason"); if (r) r.focus(); }, 60);
  }

  function closeRemoveModal() {
    const modal = $("labor-remove-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function submitRemove() {
    const assignmentId = ($("labor-rm-assignment-id") && $("labor-rm-assignment-id").value) || "";
    const reason       = (($("labor-rm-reason") && $("labor-rm-reason").value) || "").trim();
    const errEl        = $("labor-rm-err");
    const saveBtn      = $("labor-rm-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    if (!assignmentId) { showErr("Missing assignment id."); return; }
    if (reason.length < 5) { showErr("Reason must be at least 5 characters."); return; }

    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await removeAssignmentFromPtc({ assignmentId: assignmentId, reason: reason });
      closeRemoveModal();
      refresh();
      try {
        console.info("[labor-review] removed assignment from PTC", {
          assignment_id: assignmentId, affected_sessions: r.affected_sessions
        });
      } catch (_e) {}
    } catch (err) {
      console.error("[labor-review] remove failed", err);
      showErr((err && (err.message || err.code)) || "Remove failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- wire-up ---------- */

  function wire() {
    const refreshBtn = $("labor-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    // Delegated clicks for both blocks.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest('.labor-btn[data-act]');
      if (!btn) return;

      // Force close
      if (btn.dataset.act === "force-close") {
        const card = btn.closest("[data-active-uid]");
        if (!card) return;
        openForceCloseModal(card.dataset.sessionId || null, card.dataset.activeUid);
        return;
      }
      // Mark reviewed
      if (btn.dataset.act === "mark-reviewed") {
        const row = btn.closest("[data-session-id]");
        if (!row) return;
        const sid = row.dataset.sessionId;
        btn.disabled = true;
        markReviewed(sid)
          .then(refresh)
          .catch(function (err) {
            console.error("[labor-review] mark reviewed failed", err);
            alert((err && (err.message || err.code)) || "Mark reviewed failed.");
            btn.disabled = false;
          });
        return;
      }
      // Phase 2A.2 — Remove from PTC
      if (btn.dataset.act === "remove-from-ptc") {
        const row = btn.closest("[data-assignment-id]");
        if (!row) return;
        const aid = row.dataset.assignmentId;
        if (!aid) {
          alert("This row has no assignment_id — cannot remove. (Older session docs may lack the field; refresh and try again.)");
          return;
        }
        const summary = row.dataset.summary || "";
        openRemoveModal(aid, summary);
        return;
      }
    });

    // Force-close modal save + cancel (X / backdrop / Cancel use [data-modal-close]
    // which the shell wires globally).
    const fcSaveBtn = $("labor-fc-save");
    if (fcSaveBtn) fcSaveBtn.addEventListener("click", function () { submitForceClose(); });
    // Remove modal save (Phase 2A.2).
    const rmSaveBtn = $("labor-rm-save");
    if (rmSaveBtn) rmSaveBtn.addEventListener("click", function () { submitRemove(); });
  }

  /* ---------- export surface ---------- */

  function init() {
    wire();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.laborReview = {
    init:    init,
    refresh: refresh
  };
}());
