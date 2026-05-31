/* Pioneer DCR Hub — Admin Schedule tab (vanilla JS, no build).
 *
 * Four coordinated sub-modules, one Firestore document family:
 *
 * 1. Team Schedule (legacy upload)
 *    Single doc at `team_schedule/current` + blob at
 *    `team-schedules/{yyyymm}/{ts}-{filename}` in Storage. Each
 *    upload OVERWRITES the doc. Team Hub reads the same doc.
 *
 * 2. Published Team Schedule (Deputy snapshot)
 *    `published_team_schedule/current` — admin publishes on demand by
 *    reading the next N days from `deputy_shift_cache` and writing a
 *    normalized snapshot. Team Hub reads that doc only; does NOT
 *    reflect live Deputy edits.
 *
 * 3. Sync From Deputy workflow
 *    Single-button shortcut: 21-day horizon, sync-first ON, no
 *    notes. Same pipeline as the advanced publish form.
 *
 * 4. Schedule Import V1 (paste/PDF → draft → publish)
 *    Primary path while Deputy's future-day API is unreliable. PDF.js
 *    loaded lazily from CDN. Parser + draft editor + publish-from-draft.
 *
 * Phase 23 also fixes 6 latent `(techs || [])` / `(customers || [])`
 * ReferenceError sites in buildSchedulePeopleIndex, renderDraftEditor,
 * and syncDraftRowsFromTable — same pattern as the Phase 20/22 fixes.
 *
 * Surface lives at window.__pioneerAdmin.tabs.schedule:
 *   {
 *     init,             // wireScheduleControls + wireScheduleImportControls
 *     refresh,          // loadTeamSchedule + loadPublishedSnapshot + loadScheduleDraft (registerTabActivator target)
 *     refreshTeam,      // loadTeamSchedule
 *     refreshPublished, // loadPublishedSnapshot
 *     refreshDraft      // loadScheduleDraft
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getActive, getCustomerName, pacificDateString,
 *     addDaysPacific from __pioneerAdmin.utils
 *   • showToast from __pioneerAdmin.shell (not used directly here;
 *     reserved for future)
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCustomers()
 *       - getTechs()
 *   • window.firebase compat SDK (auth + firestore + storage)
 *   • window.PioneerCustomerDisplay (for canonical display name during publish)
 *   • window.PioneerCelebrate (confetti milestone — optional)
 *   • window.REFRESH_DEPUTY_SHIFTS_RANGE_URL (firebase-config.js)
 *   • PDF.js loaded lazily from CDN (cdnjs.cloudflare.com/ajax/libs/pdf.js)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-schedule.js: utils + shell modules must load first");
  }
  const {
    escapeHtml,
    pacificDateString, addDaysPacific
  } = window.__pioneerAdmin.utils;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-schedule: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCustomers = () => depOrThrow("getCustomers")();
  const getTechs     = () => depOrThrow("getTechs")();

  function $(id) { return document.getElementById(id); }

  /* ====================================================================
     Sub-module 1: Team Schedule — admin upload + current-schedule summary
     ==================================================================== */

  const TEAM_SCHEDULE_DOC_ID         = "current";
  const TEAM_SCHEDULE_MAX_BYTES      = 10 * 1024 * 1024;
  const TEAM_SCHEDULE_ALLOWED_MIME   = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp"
  ];
  const TEAM_SCHEDULE_ALLOWED_EXT    = ["pdf", "png", "jpg", "jpeg", "webp"];

  let teamScheduleLoaded = false;
  void teamScheduleLoaded;  // tracking flag — kept for parity even if unused locally

  function setScheduleStatus(state) {
    const ids = ["schedule-loading", "schedule-error", "schedule-empty", "schedule-current"];
    ids.forEach(function (id) {
      const el = $(id);
      if (el) el.hidden = true;
    });
    if (state) {
      const target = $("schedule-" + state);
      if (target) target.hidden = false;
    }
  }

  function setScheduleError(message) {
    const el = $("schedule-error");
    if (!el) return;
    el.textContent = message || "Couldn't load the current schedule.";
    setScheduleStatus("error");
  }

  function setScheduleUploadError(message) {
    const el = $("schedule-upload-error");
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function setScheduleUploadStatus(text) {
    const el = $("schedule-upload-status");
    if (el) el.textContent = text || "";
  }

  function formatScheduleUploadedAt(ts) {
    if (!ts) return "Unknown upload time";
    let ms = null;
    if (typeof ts.toMillis === "function") ms = ts.toMillis();
    else if (typeof ts.seconds === "number") ms = ts.seconds * 1000;
    else if (typeof ts === "number") ms = ts;
    else if (typeof ts === "string") { const t = Date.parse(ts); ms = isNaN(t) ? null : t; }
    if (ms == null) return "Unknown upload time";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderTeamSchedule(doc) {
    const data = (doc && doc.data && doc.data()) || null;
    // Reflect the current-PDF state onto the Extract button. Clean
    // disabled state with a hovertip beats a click that surfaces
    // "No PDF backup uploaded yet" as a red error banner.
    syncExtractButtonState(data);
    if (!data || data.active === false || !data.downloadUrl) {
      setScheduleStatus("empty");
      return;
    }
    const filenameEl = $("schedule-current-filename");
    const uploadedEl = $("schedule-current-uploaded");
    const notesEl    = $("schedule-current-notes");
    const viewBtn    = $("schedule-current-view");
    const dlBtn      = $("schedule-current-download");
    if (filenameEl) filenameEl.textContent = data.fileName || "Schedule file";
    if (uploadedEl) {
      const byName = (data.uploadedBy && (data.uploadedBy.displayName || data.uploadedBy.email)) || "an admin";
      const effective = data.effectiveMonth ? " · Effective " + data.effectiveMonth : "";
      uploadedEl.textContent =
        "Uploaded " + formatScheduleUploadedAt(data.uploadedAt) +
        " by " + byName + effective;
    }
    if (notesEl) {
      if (data.notes) {
        notesEl.textContent = data.notes;
        notesEl.hidden = false;
      } else {
        notesEl.hidden = true;
        notesEl.textContent = "";
      }
    }
    if (viewBtn) {
      viewBtn.href   = data.downloadUrl;
      viewBtn.target = "_blank";
      viewBtn.rel    = "noopener noreferrer";
    }
    if (dlBtn) {
      // Append a download hint to nudge the browser to save rather than
      // navigate. The query string is harmless to Firebase Storage.
      dlBtn.href = data.downloadUrl;
      dlBtn.setAttribute("download", data.fileName || "team-schedule.pdf");
    }
    setScheduleStatus("current");
  }

  async function loadTeamSchedule() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setScheduleError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }
    setScheduleStatus("loading");
    try {
      const snap = await firebase.firestore()
        .collection("team_schedule").doc(TEAM_SCHEDULE_DOC_ID).get();
      teamScheduleLoaded = true;
      if (!snap.exists) { setScheduleStatus("empty"); return; }
      renderTeamSchedule(snap);
    } catch (err) {
      console.error("loadTeamSchedule failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm firestore.rules has the team_schedule block deployed."
        : ("Couldn't load the schedule: " + (err && (err.message || err.code)) || "unknown error");
      setScheduleError(friendly);
    }
  }

  function validateScheduleFile(file) {
    if (!file) return "Pick a schedule file first.";
    if (file.size > TEAM_SCHEDULE_MAX_BYTES) {
      return "File is too large (" +
        Math.ceil(file.size / (1024 * 1024)) +
        " MB). Max 10 MB.";
    }
    const ct = (file.type || "").toLowerCase();
    if (ct && TEAM_SCHEDULE_ALLOWED_MIME.indexOf(ct) >= 0) return "";
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
    if (TEAM_SCHEDULE_ALLOWED_EXT.indexOf(ext) >= 0) return "";
    return "Unsupported file type. Allowed: PDF, PNG, JPG, WEBP.";
  }

  function makeScheduleStoragePath(file) {
    const now = new Date();
    const ym  = now.getFullYear() + "-" +
                String(now.getMonth() + 1).padStart(2, "0");
    const safe = (file.name || "schedule")
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return "team-schedules/" + ym + "/" + Date.now() + "-" + (safe || "schedule");
  }

  async function onScheduleUploadSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setScheduleUploadError("");

    const fileInput = $("schedule-upload-file");
    const file      = (fileInput && fileInput.files && fileInput.files[0]) || null;
    const validationErr = validateScheduleFile(file);
    if (validationErr) {
      setScheduleUploadError(validationErr);
      return;
    }

    if (!window.firebase ||
        typeof firebase.storage !== "function" ||
        typeof firebase.firestore !== "function") {
      setScheduleUploadError("Storage / Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    const submitBtn = $("schedule-upload-submit");
    if (submitBtn) submitBtn.disabled = true;

    const storagePath = makeScheduleStoragePath(file);
    const ref         = firebase.storage().ref(storagePath);

    try {
      setScheduleUploadStatus("Uploading " + file.name + "…");
      const snap        = await ref.put(file, { contentType: file.type || undefined });
      const downloadUrl = await snap.ref.getDownloadURL();

      const effectiveMonthEl = $("schedule-upload-effective-month");
      const notesEl          = $("schedule-upload-notes");
      const effectiveMonth   = (effectiveMonthEl && effectiveMonthEl.value) || "";
      const notes            = (notesEl && notesEl.value || "").trim();

      const u = firebase.auth().currentUser;
      const uploadedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };

      setScheduleUploadStatus("Saving to Firestore…");
      await firebase.firestore().collection("team_schedule").doc(TEAM_SCHEDULE_DOC_ID).set({
        fileName:       file.name || "team-schedule",
        storagePath:    storagePath,
        downloadUrl:    downloadUrl,
        contentType:    file.type || "application/octet-stream",
        byteSize:       file.size || 0,
        uploadedAt:     firebase.firestore.FieldValue.serverTimestamp(),
        uploadedBy:     uploadedBy,
        effectiveMonth: effectiveMonth || null,
        notes:          notes || null,
        active:         true
      }, { merge: false });

      // Reset the form and refresh the summary card.
      if (fileInput)        fileInput.value = "";
      if (notesEl)          notesEl.value   = "";
      // Leave effectiveMonth as-is — admins often upload the same month twice.
      setScheduleUploadStatus("Published. Team Hub will pick this up on next page load.");
      await loadTeamSchedule();
    } catch (err) {
      console.error("schedule upload failed", err);
      const friendly = (err && err.code === "storage/unauthorized")
        ? "Upload denied by Storage rules. Confirm you're signed in as an admin and storage.rules has the team-schedules block deployed."
        : (err && err.code === "permission-denied")
        ? "Firestore write denied. Confirm firestore.rules has the team_schedule block deployed."
        : ("Upload failed: " + (err && (err.message || err.code)) || "unknown error");
      setScheduleUploadError(friendly);
      setScheduleUploadStatus("");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ====================================================================
     Sub-module 2: Published Team Schedule (Deputy-powered)
     ==================================================================== */

  const PUBLISHED_SCHEDULE_DOC_ID    = "current";
  const PUBLISHED_SCHEDULE_HORIZONS  = [7, 14, 21];  // allowed values
  const PUBLISHED_SCHEDULE_DEFAULT   = 21;
  const PUBLISHED_SCHEDULE_MAX_SHIFTS = 1200;        // safety cap (21d × ~50 shifts/day)

  function tsToMillis(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number")    return ts.seconds * 1000;
    if (typeof ts.toDate   === "function") return ts.toDate().getTime();
    return null;
  }

  function formatPacificTimeOfDay(ms) {
    if (ms == null) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms)).replace(/\s+/g, "").toLowerCase();
    } catch (_e) {
      return "";
    }
  }

  function weekdayLabelFromDate(yyyymmdd) {
    if (!yyyymmdd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) {
      return "";
    }
  }

  function setPublishedStatus(state) {
    const ids = [
      "schedule-published-loading",
      "schedule-published-error",
      "schedule-published-empty",
      "schedule-published-summary"
    ];
    ids.forEach(function (id) { const el = $(id); if (el) el.hidden = true; });
    if (state) {
      const target = $("schedule-published-" + state);
      if (target) target.hidden = false;
    }
  }

  function setPublishedError(message) {
    const el = $("schedule-published-error");
    if (!el) return;
    el.textContent = message || "Couldn't load the published snapshot.";
    setPublishedStatus("error");
  }

  function setPublishStatus(text) {
    const el = $("schedule-publish-status");
    if (el) el.textContent = text || "";
  }

  function setPublishError(message) {
    const el = $("schedule-publish-error");
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function formatPublishedAt(ts) {
    if (!ts) return "Unknown";
    const ms = tsToMillis(ts);
    if (ms == null) return "Unknown";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(ms));
    } catch (_e) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderPublishedSnapshot(doc) {
    const data = (doc && doc.data && doc.data()) || null;
    const metaSub = $("schedule-published-meta");
    if (!data || data.active === false) {
      if (metaSub) metaSub.textContent = "Nothing published yet.";
      setPublishedStatus("empty");
      return;
    }
    const whenEl    = $("schedule-published-when");
    const rangeEl   = $("schedule-published-range");
    const countEl   = $("schedule-published-count");
    const techsEl   = $("schedule-published-techs");
    const notesEl   = $("schedule-published-notes");
    if (whenEl)  whenEl.textContent  = formatPublishedAt(data.publishedAt) + " by " +
      ((data.publishedBy && (data.publishedBy.displayName || data.publishedBy.email)) || "an admin");
    if (rangeEl) rangeEl.textContent = (data.startDate || "—") + " → " + (data.endDate || "—");
    if (countEl) countEl.textContent = String(data.shiftCount || (Array.isArray(data.shifts) ? data.shifts.length : 0));
    if (techsEl) {
      const techSet = new Set();
      (data.shifts || []).forEach(function (s) {
        const name = (s.techName || "").trim();
        if (name) techSet.add(name);
      });
      techsEl.textContent = String(techSet.size);
    }
    if (notesEl) {
      if (data.notes) { notesEl.textContent = data.notes; notesEl.hidden = false; }
      else            { notesEl.hidden = true; notesEl.textContent = ""; }
    }
    if (metaSub) {
      metaSub.textContent =
        "Last published " + formatPublishedAt(data.publishedAt) +
        " · " + (data.shiftCount || 0) + " shifts · range " +
        (data.startDate || "—") + " → " + (data.endDate || "—");
    }
    setPublishedStatus("summary");
  }

  async function loadPublishedSnapshot() {
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setPublishedError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }
    setPublishedStatus("loading");
    try {
      const snap = await firebase.firestore()
        .collection("published_team_schedule").doc(PUBLISHED_SCHEDULE_DOC_ID).get();
      if (!snap.exists) { setPublishedStatus("empty"); return; }
      renderPublishedSnapshot(snap);
    } catch (err) {
      console.error("loadPublishedSnapshot failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm firestore.rules has the published_team_schedule block deployed."
        : ("Couldn't load the published snapshot: " + (err && (err.message || err.code)) || "unknown error");
      setPublishedError(friendly);
    }
  }

  // Build a normalized shift record from a raw deputy_shift_cache doc.
  // Drops shifts with no start_time or no employee match — those are
  // not actionable on the published schedule.
  // customer-by-slug lookup populated by buildCustomerLookupForPublish()
  // before each publish run. Empty by default; normalizeDeputyShift only
  // applies the canonical helper when this is populated.
  let _publishCustomerBySlug = Object.create(null);

  function buildCustomerLookupForPublish(customerDocs) {
    const map = Object.create(null);
    (customerDocs || []).forEach(function (c) {
      const slug = String((c && (c.customer_slug || c.slug || c.id)) || "").trim();
      if (slug) map[slug] = c;
    });
    _publishCustomerBySlug = map;
  }

  function normalizeDeputyShift(raw) {
    const startMs = tsToMillis(raw.start_time);
    const endMs   = tsToMillis(raw.end_time);
    if (startMs == null) return null;
    const techName     = String(raw.employee_display_name || "").trim() ||
                         String(raw.employee_email || "").trim();
    if (!techName) return null;
    // Customer name precedence — match today-work.js conventions:
    //   1. sync-resolved (deputy_company_id → customers.customer_slug)
    //   2. high-confidence suggested alias
    //   3. raw Deputy location/company name (unresolved, marked as such)
    let customerName = String(raw.customer_name || "").trim();
    let customerSlug = String(raw.customer_slug || "").trim();
    if (!customerName) {
      const sugg = String(raw.suggested_customer_name || "").trim();
      if (sugg) { customerName = sugg; customerSlug = String(raw.suggested_customer_slug || "").trim(); }
    }
    if (!customerName) {
      customerName = String(raw.company_name || raw.deputy_location_name || "Unassigned").trim();
    }

    // Canonical display via the helper — when the customer slug resolves
    // to a doc we have, apply displayNameMode + customDisplayName so the
    // published snapshot shows the same string Team Hub / Team Schedule
    // and every other surface uses. Logs at [DisplayNamePublish] for
    // each row so the office can confirm matching during a publish.
    const rawCustomerName = customerName;
    const matchedDoc = customerSlug ? _publishCustomerBySlug[customerSlug] : null;
    if (matchedDoc && window.PioneerCustomerDisplay) {
      const helperName = window.PioneerCustomerDisplay.getCustomerDisplayName(matchedDoc);
      if (helperName) customerName = helperName;
    }
    try {
      console.info("[DisplayNamePublish]", {
        rawCustomerName:    rawCustomerName,
        customerSlug:       customerSlug || "(none)",
        matchedCustomerDoc: matchedDoc ? (matchedDoc.id || matchedDoc.customer_slug || "(no-id)") : null,
        displayNameMode:    matchedDoc ? (matchedDoc.displayNameMode || matchedDoc.display_name_mode || "(unset)") : null,
        customDisplayName:  matchedDoc ? (matchedDoc.customDisplayName || matchedDoc.custom_display_name || "(unset)") : null,
        location_name:      matchedDoc ? (matchedDoc.location_name || "(unset)") : null,
        finalDisplayName:   customerName
      });
    } catch (_e) {}

    return {
      date:           String(raw.sync_date || ""),
      weekday:        weekdayLabelFromDate(raw.sync_date),
      startTime:      formatPacificTimeOfDay(startMs),
      endTime:        endMs == null ? "" : formatPacificTimeOfDay(endMs),
      startMs:        startMs,
      endMs:          endMs,
      techName:       techName,
      techSlug:       String(raw.employee_slug || "").trim(),
      customerName:   customerName,
      customerSlug:   customerSlug,
      status:         String(raw.status || "scheduled"),
      deputyShiftUrl: String(raw.deputy_shift_url || "")
    };
  }

  function readPublishHorizon() {
    const checked = document.querySelector("input[name='schedule-publish-horizon']:checked");
    const raw = checked && Number(checked.value);
    if (PUBLISHED_SCHEDULE_HORIZONS.indexOf(raw) >= 0) return raw;
    return PUBLISHED_SCHEDULE_DEFAULT;
  }

  async function syncDeputyRangeBeforePublish(today, endDay) {
    const url = (window.REFRESH_DEPUTY_SHIFTS_RANGE_URL || "").trim();
    if (!url || /REPLACE_WITH/.test(url)) {
      throw new Error("REFRESH_DEPUTY_SHIFTS_RANGE_URL is not configured.");
    }
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in.");
    const idToken = await u.getIdToken();
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + idToken,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ start_date: today, end_date: endDay })
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body || !body.ok) {
      throw new Error((body && body.error) || ("HTTP " + res.status));
    }
    return body;
  }

  // Render the per-day publish breakdown into the <details> panel
  // below the form. Lists every date in the horizon with: Deputy
  // fetch count (from the range-refresh result, if it ran) and
  // cache-doc count (from the read we did to build the snapshot).
  // Zero-shift dates get a "0 shifts" visual treatment so admins
  // immediately see which days are thin in Deputy.
  function renderPublishDebug(data) {
    const root = $("schedule-publish-debug");
    const body = $("schedule-publish-debug-body");
    if (!root || !body) return;
    if (!data) { root.hidden = true; body.innerHTML = ""; return; }

    const dateList = data.dates || [];
    const syncMap  = data.sync_per_day || {};   // date → {upserted, fetched, ok, error}
    const cacheMap = data.cache_per_day || {};  // date → count (after filter)

    const rows = dateList.map(function (d) {
      const sync = syncMap[d] || null;
      const c    = (typeof cacheMap[d] === "number") ? cacheMap[d] : 0;
      const syncCell = sync
        ? (sync.ok
            ? ('Deputy: ' + (sync.upserted_count || 0) + ' upserted (' + (sync.fetched_count || 0) + ' fetched)')
            : ('<span class="schedule-publish-debug-fail">Deputy sync failed: ' + escapeHtmlForDebug(sync.error || 'unknown') + '</span>'))
        : '<span class="schedule-publish-debug-muted">Deputy sync skipped</span>';
      const cacheCell = c === 0
        ? '<span class="schedule-publish-debug-zero">0 shifts</span>'
        : (c + ' shift' + (c === 1 ? '' : 's'));
      return (
        '<tr>' +
          '<td>' + escapeHtmlForDebug(d) + '</td>' +
          '<td>' + syncCell + '</td>' +
          '<td>' + cacheCell + '</td>' +
        '</tr>'
      );
    }).join("");

    const zeroDates = dateList.filter(function (d) { return !cacheMap[d]; });
    const zeroSummary = zeroDates.length
      ? ('<p class="schedule-publish-debug-zero-summary"><strong>' +
         zeroDates.length + ' of ' + dateList.length + ' day(s)</strong> ended with zero shifts in cache: ' +
         zeroDates.map(escapeHtmlForDebug).join(', ') + '</p>')
      : '<p class="schedule-publish-debug-zero-summary">Every day in the horizon has at least one cached shift.</p>';

    body.innerHTML =
      '<p class="schedule-publish-debug-range"><strong>Requested range:</strong> ' +
        escapeHtmlForDebug(data.start_date) + ' → ' + escapeHtmlForDebug(data.end_date) +
        ' (' + dateList.length + ' days)</p>' +
      '<p><strong>Total shifts published:</strong> ' + (data.total_published || 0) + '</p>' +
      zeroSummary +
      '<table class="schedule-publish-debug-table">' +
        '<thead><tr><th>Date</th><th>Deputy sync</th><th>Cache after sync</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';

    root.hidden = false;
    // Auto-open the details so the admin sees the result without
    // having to click the disclosure.
    root.open = true;
  }

  function escapeHtmlForDebug(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function onPublishScheduleSubmit(ev) {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    setPublishError("");
    setPublishStatus("");
    renderPublishDebug(null);

    if (!window.firebase || typeof firebase.firestore !== "function") {
      setPublishError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    const submitBtn = $("schedule-publish-submit");
    if (submitBtn) submitBtn.disabled = true;

    try {
      const horizon = readPublishHorizon();
      const today   = pacificDateString(new Date());
      const endDay  = addDaysPacific(today, horizon - 1);

      // Build the full date list for the per-day debug output.
      const allDates = [];
      for (let i = 0; i < horizon; i++) allDates.push(addDaysPacific(today, i));
      const syncPerDay = {};

      // Step 1 (optional, default ON): server-side Deputy refresh for
      // every day in the horizon. Without this, the published snapshot
      // would reflect only today's shifts (the scheduled sync only
      // covers today). See `refreshDeputyShiftsRangeV1` in functions/.
      const syncFirstEl = $("schedule-publish-sync-first");
      const syncFirst   = !syncFirstEl || syncFirstEl.checked !== false;
      if (syncFirst) {
        setPublishStatus(
          "Syncing Deputy for " + today + " → " + endDay + " (" + horizon + " days) — this can take 20–60s…"
        );
        try {
          const syncBody = await syncDeputyRangeBeforePublish(today, endDay);
          const agg      = (syncBody && syncBody.aggregate) || {};
          (syncBody && Array.isArray(syncBody.per_day) ? syncBody.per_day : []).forEach(function (d) {
            if (d && d.sync_date) syncPerDay[d.sync_date] = d;
          });
          setPublishStatus(
            "Deputy sync complete: " + (agg.upserted_count || 0) + " shifts upserted across " +
            ((syncBody && syncBody.days) || horizon) + " day(s), " +
            (agg.failed_days || 0) + " failed. Building snapshot…"
          );
        } catch (syncErr) {
          // Surface but don't abort — admin can still publish whatever
          // is currently in cache. Don't silently move on; record the
          // failure so the debug panel makes it obvious.
          allDates.forEach(function (d) {
            syncPerDay[d] = { sync_date: d, ok: false, error: (syncErr && syncErr.message) || String(syncErr) };
          });
          setPublishStatus(
            "Deputy sync failed (continuing with cached data): " +
            (syncErr && syncErr.message || syncErr) + ". Building snapshot…"
          );
        }
      } else {
        setPublishStatus("Reading Deputy shifts " + today + " → " + endDay + "…");
      }

      // Single inequality on sync_date keeps us inside a single-field
      // index. We filter the upper bound + status in memory.
      const snap = await firebase.firestore()
        .collection("deputy_shift_cache")
        .where("sync_date", ">=", today)
        .get();

      const rawDocs = snap.docs.map(function (d) { return d.data() || {}; });
      const horizonRaw = rawDocs.filter(function (raw) {
        const sd = String(raw.sync_date || "");
        if (!sd || sd > endDay) return false;
        if ((raw.status || "scheduled") === "cancelled") return false;
        return true;
      });

      // Build per-day cache counts for the debug panel.
      const cachePerDay = {};
      allDates.forEach(function (d) { cachePerDay[d] = 0; });
      horizonRaw.forEach(function (raw) {
        const d = String(raw.sync_date || "");
        if (cachePerDay[d] == null) cachePerDay[d] = 0;
        cachePerDay[d] += 1;
      });

      // Populate the customer-by-slug lookup so normalizeDeputyShift can
      // apply the canonical display helper. One-shot read; cached in
      // _publishCustomerBySlug for the duration of this publish call.
      try {
        const custSnap = await firebase.firestore().collection("customers").get();
        const customerDocs = custSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        buildCustomerLookupForPublish(customerDocs);
      } catch (_e) { buildCustomerLookupForPublish([]); }

      let shifts = horizonRaw
        .map(normalizeDeputyShift)
        .filter(function (x) { return !!x; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          if (a.startMs !== b.startMs) return a.startMs - b.startMs;
          return a.techName.localeCompare(b.techName);
        });

      if (shifts.length > PUBLISHED_SCHEDULE_MAX_SHIFTS) {
        shifts = shifts.slice(0, PUBLISHED_SCHEDULE_MAX_SHIFTS);
      }

      const notesEl = $("schedule-publish-notes");
      const notes   = (notesEl && notesEl.value || "").trim();
      const u       = firebase.auth().currentUser;
      const publishedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };

      setPublishStatus("Writing snapshot (" + shifts.length + " shifts)…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID).set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy:       publishedBy,
          startDate:         today,
          endDate:           endDay,
          viewRangeDays:     horizon,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             notes || null,
          active:            true
        }, { merge: false });

      // Clear notes; leave the form open so the admin sees the
      // refreshed summary.
      if (notesEl) notesEl.value = "";

      if (shifts.length === 0) {
        setPublishStatus(
          "Published. 0 shifts in cache for " + today + " → " + endDay + " " +
          "(" + horizon + " days). See the per-day breakdown below — if Deputy " +
          "returned shifts but nothing landed in the cache, that's a sync issue. " +
          "If both columns read 0, Deputy genuinely has no shifts in that range."
        );
      } else {
        setPublishStatus(
          "Published " + shifts.length + " shifts over " + horizon + " days " +
          "(" + today + " → " + endDay + "). Team Hub will pick this up on next page load."
        );
      }

      // Always render the debug breakdown — even on success — so
      // admins can spot zero-shift dates and act on them.
      renderPublishDebug({
        start_date:      today,
        end_date:        endDay,
        dates:           allDates,
        sync_per_day:    syncPerDay,
        cache_per_day:   cachePerDay,
        total_published: shifts.length
      });
      await loadPublishedSnapshot();
    } catch (err) {
      console.error("publishTeamSchedule failed", err);
      const friendly = (err && err.code === "permission-denied")
        ? "Permission denied. Confirm you're signed in as an admin and firestore.rules has the published_team_schedule + deputy_shift_cache blocks deployed."
        : ("Publish failed: " + (err && (err.message || err.code)) || "unknown error");
      setPublishError(friendly);
      setPublishStatus("");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ====================================================================
     Sub-module 3: Sync next 21 days from Deputy

     Same pipeline as onPublishScheduleSubmit (Deputy range refresh →
     read deputy_shift_cache → write published_team_schedule/current)
     but driven by a single button with hardcoded sensible defaults
     (21-day horizon, sync-first ON, no notes). The advanced publish
     form above remains for fine-grained control.
     ==================================================================== */
  function setSyncStatus(text) {
    const el = $("schedule-sync-status");
    if (!el) return;
    if (text) { el.textContent = text; el.hidden = false; }
    else      { el.textContent = "";   el.hidden = true; }
  }
  function setSyncError(msg) {
    const el = $("schedule-sync-error");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = "";  el.hidden = true; }
  }
  function setSyncSuccess(payload) {
    const card = $("schedule-sync-success");
    if (!card) return;
    if (!payload) { card.hidden = true; return; }
    const sh = $("schedule-sync-success-shifts");
    const rn = $("schedule-sync-success-range");
    const wh = $("schedule-sync-success-when");
    if (sh) sh.textContent = String(payload.shiftCount) +
                             (payload.shiftCount === 1 ? " shift" : " shifts");
    if (rn) rn.textContent = formatRangeHuman(payload.startDate, payload.endDate);
    if (wh) wh.textContent = formatSyncWhen(payload.publishedAtMs);
    card.hidden = false;
  }
  function formatRangeHuman(startYmd, endYmd) {
    function fmt(ymd) {
      if (!ymd) return "";
      try {
        const d = new Date(ymd + "T12:00:00-07:00");
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles", month: "short", day: "numeric"
        }).format(d);
      } catch (_e) { return ymd; }
    }
    const s = fmt(startYmd);
    const e = fmt(endYmd);
    return s && e ? (s + " – " + e) : (s || e || "—");
  }
  function formatSyncWhen(ms) {
    if (!ms) return "just now";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "just now"; }
  }

  async function onSyncFromDeputyClick() {
    const SYNC_DAYS = 21;
    const btn = $("schedule-sync-now-btn");
    setSyncError("");
    setSyncSuccess(null);

    if (!window.firebase || typeof firebase.firestore !== "function") {
      setSyncError("Firestore SDK isn't loaded. Hard-reload (Cmd+Shift+R).");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.textContent   = "Syncing…";
    }
    setSyncStatus("Pulling the next " + SYNC_DAYS + " days from Deputy — this can take 20–60 seconds.");

    const today  = pacificDateString(new Date());
    const endDay = addDaysPacific(today, SYNC_DAYS - 1);

    // For the per-day breakdown panel (kept available under a disclosure
    // for the office that wants to triage zero-shift days).
    const allDates = [];
    for (let i = 0; i < SYNC_DAYS; i++) allDates.push(addDaysPacific(today, i));
    const syncPerDay = {};

    try {
      // 1. Refresh deputy_shift_cache for every day in the range.
      let deputyOk = true;
      try {
        const syncBody = await syncDeputyRangeBeforePublish(today, endDay);
        (syncBody && Array.isArray(syncBody.per_day) ? syncBody.per_day : []).forEach(function (d) {
          if (d && d.sync_date) syncPerDay[d.sync_date] = d;
        });
      } catch (syncErr) {
        deputyOk = false;
        allDates.forEach(function (d) {
          syncPerDay[d] = { sync_date: d, ok: false, error: (syncErr && syncErr.message) || String(syncErr) };
        });
        // Don't abort — we can still publish from whatever's already in
        // the cache. Note it on the error banner so the office knows
        // the data may not be fresh.
        console.warn("[schedule-sync] Deputy refresh failed; publishing from cache", syncErr);
      }

      // 2. Read the post-refresh cache for the horizon.
      setSyncStatus("Reading Deputy shifts and building snapshot…");
      const snap = await firebase.firestore()
        .collection("deputy_shift_cache")
        .where("sync_date", ">=", today)
        .get();
      const rawDocs = snap.docs.map(function (d) { return d.data() || {}; });
      const horizonRaw = rawDocs.filter(function (raw) {
        const sd = String(raw.sync_date || "");
        if (!sd || sd > endDay) return false;
        if ((raw.status || "scheduled") === "cancelled") return false;
        return true;
      });
      const cachePerDay = {};
      allDates.forEach(function (d) { cachePerDay[d] = 0; });
      horizonRaw.forEach(function (raw) {
        const d = String(raw.sync_date || "");
        if (cachePerDay[d] == null) cachePerDay[d] = 0;
        cachePerDay[d] += 1;
      });

      // 3. Populate customer lookup so the helper applies inside
      //    normalizeDeputyShift. One-shot per sync run.
      try {
        const custSnap = await firebase.firestore().collection("customers").get();
        const customerDocs = custSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        buildCustomerLookupForPublish(customerDocs);
      } catch (_e) { buildCustomerLookupForPublish([]); }

      // 4. Normalize + sort.
      let shifts = horizonRaw
        .map(normalizeDeputyShift)
        .filter(function (x) { return !!x; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          if (a.startMs !== b.startMs) return a.startMs - b.startMs;
          return a.techName.localeCompare(b.techName);
        });
      if (shifts.length > PUBLISHED_SCHEDULE_MAX_SHIFTS) {
        shifts = shifts.slice(0, PUBLISHED_SCHEDULE_MAX_SHIFTS);
      }

      // 4. Write the snapshot.
      const u = firebase.auth().currentUser;
      const publishedBy = {
        uid:         (u && u.uid)         || null,
        email:       (u && u.email)       || null,
        displayName: (u && u.displayName) || (u && u.email) || "admin"
      };
      const nowMs = Date.now();
      await firebase.firestore()
        .collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID)
        .set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy:       publishedBy,
          startDate:         today,
          endDate:           endDay,
          viewRangeDays:     SYNC_DAYS,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             null,
          source:            "deputy_sync",
          active:            true
        }, { merge: false });

      // 5. Show success summary + render the per-day breakdown for
      //    anyone who opens the disclosure.
      setSyncStatus("");
      setSyncSuccess({
        shiftCount:    shifts.length,
        startDate:     today,
        endDate:       endDay,
        publishedAtMs: nowMs
      });
      renderSyncDebug({
        dates:           allDates,
        sync_per_day:    syncPerDay,
        cache_per_day:   cachePerDay,
        total_published: shifts.length
      });

      // 6. Refresh the published-snapshot summary card so the existing
      //    "current snapshot" panel reflects the new state too.
      try { await loadPublishedSnapshot(); } catch (_e) {}

      // 7. Tasteful celebration — schedule publish is a milestone moment.
      try { if (window.PioneerCelebrate) window.PioneerCelebrate.fire({ intensity: "medium" }); } catch (_e) {}

      // 8. Soft-warn if Deputy was unreachable but we published from cache.
      if (!deputyOk) {
        setSyncError(
          "Deputy was unreachable, so we published the most recent cached shifts. " +
          "Try Sync again in a few minutes if you suspect the schedule has changed."
        );
      }
    } catch (err) {
      console.error("[schedule-sync] failed", err);
      // Friendly first; technical detail goes in the console for Nick.
      const code    = err && err.code;
      const message = err && err.message;
      let friendly;
      if (code === "permission-denied") {
        friendly = "Access denied. You may need to sign out and back in as an admin.";
      } else if (/Deputy|sync|429|HTTP/i.test(String(message || ""))) {
        friendly = "We could not reach Deputy. Try again in a few minutes or ask Nick.";
      } else {
        friendly = "Schedule sync didn't complete. Try again in a few minutes or ask Nick.";
      }
      setSyncError(friendly);
      setSyncStatus("");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.label || "Sync next 21 days from Deputy";
      }
    }
  }

  // Per-day breakdown rendered into the disclosure under the success card.
  // Same shape as the advanced publish-form debug panel.
  function renderSyncDebug(data) {
    const root = $("schedule-sync-debug");
    const body = $("schedule-sync-debug-body");
    if (!root || !body) return;
    if (!data) { root.hidden = true; body.innerHTML = ""; return; }
    const dateList = data.dates || [];
    const syncMap  = data.sync_per_day || {};
    const cacheMap = data.cache_per_day || {};
    const rows = dateList.map(function (d) {
      const sync = syncMap[d] || null;
      const c    = (typeof cacheMap[d] === "number") ? cacheMap[d] : 0;
      const syncCell = sync
        ? (sync.ok
            ? ('Deputy: ' + (sync.upserted_count || 0) + ' upserted')
            : ('<span class="schedule-publish-debug-fail">Deputy sync failed: ' + escapeHtmlForDebug(sync.error || 'unknown') + '</span>'))
        : '<span class="schedule-publish-debug-muted">Deputy sync skipped</span>';
      return '<tr><td>' + escapeHtmlForDebug(d) + '</td>' +
             '<td>' + syncCell + '</td>' +
             '<td>' + c + ' in cache</td></tr>';
    }).join("");
    body.innerHTML =
      '<table class="schedule-publish-debug-table"><thead>' +
        '<tr><th>Date</th><th>Deputy sync</th><th>Cache</th></tr>' +
      '</thead><tbody>' + rows + '</tbody></table>' +
      '<p class="schedule-publish-debug-foot">Published ' + (data.total_published || 0) + ' shift(s) across ' + dateList.length + ' day(s).</p>';
    root.hidden = false;
  }

  /* ====================================================================
     Sub-module 4: Schedule Import V1 — paste/PDF → draft → publish

     Primary path while Deputy's future-day API is unreliable.
     Pipeline:
       1. Admin pastes text (or clicks "Extract from current PDF" — PDF.js
          loaded lazily from CDN).
       2. parseScheduleText() runs a line-based heuristic parser against
          the cleaning_techs + customers caches. Each output shift gets
          a `source: "pdf_import" | "manual"` stamp and a 0..1
          confidence score.
       3. Draft is rendered as an editable table; admin fixes
          mismatches, adds/removes rows.
       4. "Publish from draft" normalizes the rows into the same shape
          `published_team_schedule/current` already uses (date, startMs,
          endMs, techSlug, customerSlug, …) and overwrites the doc.
          The existing Team Hub + /team-schedule renderers pick it up
          without any further change.
     ==================================================================== */

  const SCHEDULE_DRAFT_DOC_ID    = "draft";
  const SCHEDULE_PARSER_VERSION  = "v1";
  // Bumping the rev forces stale rendered rows to invalidate when the
  // admin re-parses without leaving the page. The rev is used as the
  // key prefix for row ids.
  let scheduleDraftRev = 0;
  let scheduleDraftRows = [];     // in-memory editable rows

  function setImportStatus(text) {
    const el = $("schedule-import-status");
    if (el) el.textContent = text || "";
  }
  function setImportError(msg) {
    const el = $("schedule-import-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg; el.hidden = false;
  }
  function setDraftStatus(text) {
    const el = $("schedule-draft-status");
    if (el) el.textContent = text || "";
  }
  function setDraftError(msg) {
    const el = $("schedule-draft-error");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg; el.hidden = false;
  }

  /* ---------- PDF.js lazy loader ---------- */
  let pdfJsLoading = null;
  function loadPdfJsOnce() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsLoading) return pdfJsLoading;
    pdfJsLoading = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload  = function () {
        if (!window.pdfjsLib) { reject(new Error("PDF.js loaded but global missing")); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error("PDF.js failed to load from CDN")); };
      document.head.appendChild(s);
    });
    return pdfJsLoading;
  }
  async function extractPdfText(url) {
    const pdfjs = await loadPdfJsOnce();
    scheduleExtractLog("pdfjs loaded", { version: pdfjs && pdfjs.version });
    const loadingTask = pdfjs.getDocument(url);
    const pdf = await loadingTask.promise;
    scheduleExtractLog("pdf opened", { numPages: pdf.numPages });
    let lines = [];
    let perPageCounts = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // PDF.js gives us items with `str` + positional metadata. The
      // positional data could be used to reconstruct columns, but the
      // line-based parser works fine on a flat newline-joined dump
      // for most Pioneer-style schedules.
      const pageText = content.items.map(function (i) { return i.str; }).join("\n");
      lines.push(pageText);
      perPageCounts.push(pageText.length);
    }
    scheduleExtractLog("text extracted", { perPageCounts: perPageCounts });
    return lines.join("\n\n");
  }

  // Always-on diagnostic prefix for the PDF extract flow. Pure client
  // side — no Cloud Function involved — so the trace lives in the
  // admin's own console. Failures bubble through here on every step.
  function scheduleExtractLog(label, meta) {
    try { console.info("[ScheduleExtract] " + label, meta || ""); }
    catch (_e) {}
  }
  function scheduleExtractWarn(label, meta) {
    try { console.warn("[ScheduleExtract] " + label, meta || ""); }
    catch (_e) {}
  }

  // Pre-flight reachability check. Fired before PDF.js so we can give
  // a specific error instead of the generic "Failed to fetch" the
  // library throws when the URL can't be reached. Range: 0-1023 bytes
  // is enough to confirm CORS + reachability without downloading the
  // whole PDF; if the host doesn't support Range, that's also a clear
  // signal we surface in the error path.
  async function pdfUrlIsReachable(url) {
    try {
      const ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      const timeoutMs = 8000;
      const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      const res = await fetch(url, {
        method:  "GET",
        mode:    "cors",
        cache:   "no-store",
        headers: { "Range": "bytes=0-1023" },
        signal:  ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      const ctype = res.headers.get("content-type") || "";
      const status = res.status;
      scheduleExtractLog("preflight result", {
        status:        status,
        ok:            res.ok,
        content_type:  ctype || "(unset)",
        accept_ranges: res.headers.get("accept-ranges") || "(unset)"
      });
      // 200 (full) or 206 (partial) both confirm reachability. Anything
      // else is a hosting/storage problem we should report cleanly.
      if (status !== 200 && status !== 206) {
        return { ok: false, code: "bad_status", status: status, ctype: ctype };
      }
      return { ok: true, status: status, ctype: ctype };
    } catch (err) {
      const name = err && err.name;
      const msg  = (err && err.message) || String(err);
      scheduleExtractWarn("preflight failed", { name: name, message: msg });
      if (name === "AbortError") {
        return { ok: false, code: "timeout", message: msg };
      }
      return { ok: false, code: "network", message: msg };
    }
  }

  /* ---------- Parser ---------- */
  // Build lookup maps from the loaded admin caches. Used by the parser
  // to match free-text "Bonnie" or "baker construction" to canonical
  // cleaning_techs / customers docs.
  function buildSchedulePeopleIndex() {
    const techByKey = new Map();     // lowercased token → tech doc
    const custByKey = new Map();     // lowercased token → customer doc
    const techs     = getTechs();
    const customers = getCustomers();
    techs.forEach(function (t) {
      const name = String(t.display_name || t.name || "").trim();
      if (!name) return;
      techByKey.set(name.toLowerCase(), t);
      // First-name key for casual schedule prose ("Bonnie", "April").
      const first = name.split(/\s+/)[0];
      if (first) techByKey.set(first.toLowerCase(), t);
    });
    customers.forEach(function (c) {
      const name = String(c.customer_name || c.name || c.display_name || "").trim();
      if (!name) return;
      custByKey.set(name.toLowerCase(), c);
      // Each word ≥ 4 chars is a potential keyword match.
      name.split(/\s+/).forEach(function (w) {
        if (w.length >= 4) custByKey.set(w.toLowerCase(), c);
      });
    });
    return { techByKey: techByKey, custByKey: custByKey };
  }

  function matchTechInLine(line, idx) {
    const lower = line.toLowerCase();
    let best = null;
    let bestLen = 0;
    idx.techByKey.forEach(function (tech, key) {
      if (key.length < 2) return;
      if (lower.indexOf(key) >= 0 && key.length > bestLen) {
        best = tech;
        bestLen = key.length;
      }
    });
    return best;
  }
  function matchCustomerInLine(line, idx) {
    const lower = line.toLowerCase();
    let best = null;
    let bestLen = 0;
    idx.custByKey.forEach(function (cust, key) {
      if (key.length < 4) return;
      if (lower.indexOf(key) >= 0 && key.length > bestLen) {
        best = cust;
        bestLen = key.length;
      }
    });
    return best;
  }

  // Parse a date-heading line, e.g. "Wednesday, May 20" / "5/20" /
  // "5/20/2026" / "May 20, 2026". Returns YYYY-MM-DD or null.
  const MONTH_MAP = {
    jan: 1,  january: 1,
    feb: 2,  february: 2,
    mar: 3,  march: 3,
    apr: 4,  april: 4,
    may: 5,
    jun: 6,  june: 6,
    jul: 7,  july: 7,
    aug: 8,  august: 8,
    sep: 9,  september: 9, sept: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };
  function tryParseDate(line, defaultYear) {
    if (!line) return null;
    const cleaned = line.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
    // "May 20" / "May 20 2026"
    const mWord = cleaned.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/);
    if (mWord) {
      const monthKey = mWord[1].toLowerCase();
      const m = MONTH_MAP[monthKey];
      if (m) {
        const d = parseInt(mWord[2], 10);
        let y = mWord[3] ? parseInt(mWord[3], 10) : defaultYear;
        if (y < 100) y += 2000;
        if (d >= 1 && d <= 31) {
          return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        }
      }
    }
    // "5/20" or "5/20/2026" or "5/20/26"
    const mSlash = cleaned.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (mSlash) {
      const m = parseInt(mSlash[1], 10);
      const d = parseInt(mSlash[2], 10);
      let y = mSlash[3] ? parseInt(mSlash[3], 10) : defaultYear;
      if (y < 100) y += 2000;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      }
    }
    // ISO "2026-05-20"
    const mIso = cleaned.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (mIso) return mIso[1] + "-" + mIso[2] + "-" + mIso[3];
    return null;
  }

  // Returns { start24: "HH:MM", end24: "HH:MM" | null } or null.
  function tryParseTimeRange(line) {
    // Tolerant: 5, 5:00, 5am, 5:00am, with optional separator – - to ~
    const re = /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?\s*[-–—~to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?/i;
    const m = line.match(re);
    if (!m) {
      // Try single-time fallback: "5:00am" with no range
      const m1 = line.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)/i);
      if (!m1) return null;
      const startStr = normalizeTime(m1[1], m1[2], m1[3], null);
      return startStr ? { start24: startStr, end24: null } : null;
    }
    // Disambiguate: if only the END has am/pm, infer the start ampm
    // from the end (common in schedules: "5-8:30am").
    const startAm = m[3] || m[6] || null;
    const endAm   = m[6] || m[3] || null;
    const start24 = normalizeTime(m[1], m[2], startAm, "start");
    const end24   = normalizeTime(m[4], m[5], endAm,   "end");
    if (!start24) return null;
    return { start24: start24, end24: end24 };
  }
  function normalizeTime(hh, mm, ampm, position) {
    let h = parseInt(hh, 10);
    if (isNaN(h) || h < 0 || h > 23) return null;
    let m = mm ? parseInt(mm, 10) : 0;
    if (isNaN(m) || m < 0 || m > 59) m = 0;
    const ap = (ampm || "").toLowerCase().replace(/\./g, "")[0]; // "a"|"p"|""
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    void position;  // reserved for future positional disambiguation
    // No am/pm at all: leave as-is (assume 24h or admin will fix).
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  function buildLocalTimestamp(yyyymmdd, hhmm) {
    if (!yyyymmdd || !hhmm) return null;
    // Pacific time anchor — uses a fixed -07:00/-08:00 offset by way
    // of `Date.UTC` plus offset calc. To keep this simple + correct
    // across DST we anchor at the wall-clock representation in
    // Pacific via Intl and then re-parse. For pilot precision, we
    // accept that DST boundary days might land off by an hour; the
    // admin can correct in the editor if needed.
    const [h, m] = hhmm.split(":").map(function (s) { return parseInt(s, 10); });
    const [yy, mm, dd] = yyyymmdd.split("-").map(function (s) { return parseInt(s, 10); });
    // Build a "noon-of-day-in-UTC" anchor, then compute Pacific
    // offset for that date, then subtract that offset.
    const noonUTC = Date.UTC(yy, mm - 1, dd, 12, 0, 0);
    const pacificParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", timeZoneName: "shortOffset"
    }).formatToParts(new Date(noonUTC));
    const offsetPart = pacificParts.find(function (p) { return p.type === "timeZoneName"; });
    // offsetPart.value like "GMT-7" or "GMT-8"
    let offsetHours = -8;
    if (offsetPart && offsetPart.value) {
      const m2 = offsetPart.value.match(/GMT([+-]\d{1,2})/);
      if (m2) offsetHours = parseInt(m2[1], 10);
    }
    return Date.UTC(yy, mm - 1, dd, h - offsetHours, m, 0);
  }

  function format12HourTime(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(function (s) { return parseInt(s, 10); });
    if (isNaN(h)) return "";
    const ap = h >= 12 ? "pm" : "am";
    const h12 = h % 12 || 12;
    return h12 + ":" + String(m || 0).padStart(2, "0") + ap;
  }
  function weekdayLabel(yyyymmdd) {
    if (!yyyymmdd) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles", weekday: "long"
      }).format(new Date(yyyymmdd + "T12:00:00Z"));
    } catch (_e) { return ""; }
  }

  function parseScheduleText(text, opts) {
    opts = opts || {};
    const defaultYear = Number(opts.defaultYear) || new Date().getFullYear();
    const idx = buildSchedulePeopleIndex();
    const rawLines = String(text || "").split(/\r?\n/);
    const lines = rawLines.map(function (l) { return l.replace(/\s+/g, " ").trim(); });

    const out = [];
    let currentDate = null;
    lines.forEach(function (line) {
      if (!line) return;

      // 1. Is this a date heading? If the line has a date but NO time
      //    range, treat it as a heading.
      const dateGuess = tryParseDate(line, defaultYear);
      const timeGuess = tryParseTimeRange(line);
      if (dateGuess && !timeGuess) {
        currentDate = dateGuess;
        return;
      }

      // 2. Otherwise look for a shift row. Must have a time range.
      if (!timeGuess) return;

      // 3. Date precedence: inline date on this row wins; otherwise
      //    use the current heading date.
      const shiftDate = dateGuess || currentDate;
      if (!shiftDate) return; // can't place this row in time

      // 4. Match tech + customer.
      const tech     = matchTechInLine(line, idx);
      const customer = matchCustomerInLine(line, idx);

      // 5. Extract leftover text as notes. Strip the matched tokens
      //    + the time range + any date so the admin sees just the
      //    "extra" parts.
      let notes = line;
      // Strip time range
      notes = notes.replace(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?\s*[-–—~to]+\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m?\.?)?/i, "");
      if (dateGuess) {
        notes = notes
          .replace(/\b([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/, "")
          .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, "")
          .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/, "");
      }
      if (tech) {
        const techName = String(tech.display_name || tech.name || "").trim();
        if (techName) {
          notes = notes.replace(new RegExp(escapeRegex(techName), "ig"), "");
          const first = techName.split(/\s+/)[0];
          if (first) notes = notes.replace(new RegExp("\\b" + escapeRegex(first) + "\\b", "ig"), "");
        }
      }
      if (customer) {
        const custName = String(customer.customer_name || customer.name || "").trim();
        if (custName) notes = notes.replace(new RegExp(escapeRegex(custName), "ig"), "");
      }
      notes = notes.replace(/[-–—|·,:]+/g, " ").replace(/\s+/g, " ").trim();
      // Drop trivial residue
      if (notes.length <= 1) notes = "";

      // Confidence scoring — 0.2 per matched component.
      let conf = 0.2;                  // base (we have a time)
      if (shiftDate) conf += 0.2;
      if (tech)      conf += 0.3;
      if (customer)  conf += 0.2;
      if (timeGuess.end24) conf += 0.1;
      if (conf > 1) conf = 1;

      out.push({
        date:         shiftDate,
        startTime24:  timeGuess.start24,
        endTime24:    timeGuess.end24 || "",
        techSlug:     tech     ? (tech.tech_slug || tech.id || "")     : "",
        techName:     tech     ? (tech.display_name || tech.name || "") : "",
        customerSlug: customer ? (customer.customer_slug || customer.id || "") : "",
        customerName: customer ? (customer.customer_name || customer.name || "") : "",
        notes:        notes,
        source:       opts.source || "manual",
        confidence:   conf
      });
    });

    // Sort by date then time so the editor reads in calendar order.
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime24 || "").localeCompare(b.startTime24 || "");
    });
    return out;
  }
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* ---------- Draft editor ---------- */
  function renderDraftEditor(rows, meta) {
    scheduleDraftRev += 1;
    scheduleDraftRows = (rows || []).slice();
    const block = $("schedule-draft-block");
    const body  = $("schedule-draft-rows");
    const metaEl = $("schedule-draft-meta");
    if (!block || !body) return;

    if (!scheduleDraftRows.length) {
      block.hidden = true;
      body.innerHTML = "";
      return;
    }
    block.hidden = false;
    if (metaEl) {
      const dates = scheduleDraftRows.map(function (r) { return r.date; }).filter(Boolean).sort();
      const minD = dates[0] || "—";
      const maxD = dates[dates.length - 1] || "—";
      const techSet = new Set(scheduleDraftRows.map(function (r) { return r.techSlug || r.techName || ""; }).filter(Boolean));
      const src = (meta && meta.source) || (scheduleDraftRows[0] && scheduleDraftRows[0].source) || "manual";
      metaEl.textContent = scheduleDraftRows.length + " shifts · " + techSet.size + " techs · " +
        minD + " → " + maxD + " · source: " + src;
    }

    const techsArr     = getTechs();
    const customersArr = getCustomers();
    const techOptions = techsArr
      .filter(function (t) { return (t.display_name || t.name); })
      .sort(function (a, b) {
        return String(a.display_name || a.name).localeCompare(String(b.display_name || b.name));
      })
      .map(function (t) {
        const slug = t.tech_slug || t.id;
        const name = t.display_name || t.name;
        return '<option value="' + escapeAttr(slug) + '">' + escapeHtmlForDebug(name) + '</option>';
      }).join("");
    const custOptions = customersArr
      .filter(function (c) { return (c.customer_name || c.name); })
      .sort(function (a, b) {
        return String(a.customer_name || a.name).localeCompare(String(b.customer_name || b.name));
      })
      .map(function (c) {
        const slug = c.customer_slug || c.id;
        const name = c.customer_name || c.name;
        return '<option value="' + escapeAttr(slug) + '">' + escapeHtmlForDebug(name) + '</option>';
      }).join("");

    body.innerHTML = scheduleDraftRows.map(function (r, idx) {
      const conf  = typeof r.confidence === "number" ? r.confidence : 1;
      const isLow = conf < 0.7;
      const confText = Math.round(conf * 100) + "%";
      return (
        '<tr class="schedule-draft-row' + (isLow ? ' is-low-conf' : '') + '" data-idx="' + idx + '">' +
          '<td><input type="date"  data-field="date"        value="' + escapeAttr(r.date || "") + '" /></td>' +
          '<td>' +
            '<select data-field="techSlug">' +
              '<option value="">— pick tech —</option>' +
              techOptions +
            '</select>' +
          '</td>' +
          '<td>' +
            '<select data-field="customerSlug">' +
              '<option value="">— pick customer —</option>' +
              custOptions +
            '</select>' +
          '</td>' +
          '<td><input type="time"  data-field="startTime24" value="' + escapeAttr(r.startTime24 || "") + '" /></td>' +
          '<td><input type="time"  data-field="endTime24"   value="' + escapeAttr(r.endTime24   || "") + '" /></td>' +
          '<td><input type="text"  data-field="notes"       value="' + escapeAttr(r.notes || "") + '" placeholder="optional notes" /></td>' +
          '<td><span class="schedule-draft-conf' + (isLow ? ' is-low' : '') + '">' + confText + '</span></td>' +
          '<td><button type="button" class="schedule-draft-del" data-act="delete">✕</button></td>' +
        '</tr>'
      );
    }).join("");

    // Set initial select values (innerHTML doesn't apply selected for
    // option matching by attribute alone after we built the option
    // list dynamically — set programmatically for reliability).
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      const idx = parseInt(tr.dataset.idx, 10);
      const r = scheduleDraftRows[idx];
      const techSel = tr.querySelector("select[data-field='techSlug']");
      const custSel = tr.querySelector("select[data-field='customerSlug']");
      if (techSel) techSel.value = r.techSlug || "";
      if (custSel) custSel.value = r.customerSlug || "";
    });

    setDraftStatus("");
    setDraftError("");
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Read the table back into the in-memory rows array. Called before
  // save + publish so any pending edits are captured.
  function syncDraftRowsFromTable() {
    const body = $("schedule-draft-rows");
    if (!body) return;
    const techsArr     = getTechs();
    const customersArr = getCustomers();
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      const idx = parseInt(tr.dataset.idx, 10);
      if (isNaN(idx)) return;
      const row = scheduleDraftRows[idx];
      if (!row) return;
      Array.prototype.forEach.call(tr.querySelectorAll("[data-field]"), function (el) {
        const field = el.dataset.field;
        row[field] = el.value;
      });
      // Refresh derived fields from the picked slug.
      if (row.techSlug) {
        const t = techsArr.find(function (x) { return (x.tech_slug || x.id) === row.techSlug; });
        if (t) row.techName = t.display_name || t.name || row.techName || "";
      } else {
        row.techName = "";
      }
      if (row.customerSlug) {
        const c = customersArr.find(function (x) { return (x.customer_slug || x.id) === row.customerSlug; });
        if (c) row.customerName = c.customer_name || c.name || row.customerName || "";
      } else {
        row.customerName = "";
      }
    });
  }

  function addEmptyDraftRow() {
    syncDraftRowsFromTable();
    const today = pacificDateString(new Date());
    scheduleDraftRows.push({
      date:         today,
      startTime24:  "",
      endTime24:    "",
      techSlug:     "",
      techName:     "",
      customerSlug: "",
      customerName: "",
      notes:        "",
      source:       "manual",
      confidence:   1
    });
    renderDraftEditor(scheduleDraftRows);
  }
  function deleteDraftRow(idx) {
    syncDraftRowsFromTable();
    if (idx < 0 || idx >= scheduleDraftRows.length) return;
    scheduleDraftRows.splice(idx, 1);
    renderDraftEditor(scheduleDraftRows);
  }

  /* ---------- Firestore load/save ---------- */
  async function loadScheduleDraft() {
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const snap = await firebase.firestore()
        .collection("published_team_schedule").doc(SCHEDULE_DRAFT_DOC_ID).get();
      if (!snap.exists) {
        // Hide the editor when no draft exists.
        scheduleDraftRows = [];
        renderDraftEditor([]);
        return;
      }
      const data = snap.data() || {};
      // Normalize loaded shifts into the editor shape. The doc stores
      // canonical shift records (startMs/endMs); the editor uses
      // startTime24/endTime24, which we derive from the canonical
      // record when present, or fall back to the parser-shaped fields.
      const rows = (data.shifts || []).map(function (s) {
        return {
          date:         s.date || "",
          startTime24:  s.startTime24 || timeFromMs(s.startMs, s.date) || "",
          endTime24:    s.endTime24   || timeFromMs(s.endMs,   s.date) || "",
          techSlug:     s.techSlug     || "",
          techName:     s.techName     || "",
          customerSlug: s.customerSlug || "",
          customerName: s.customerName || "",
          notes:        s.notes        || "",
          source:       s.source       || "manual",
          confidence:   typeof s.confidence === "number" ? s.confidence : 1
        };
      });
      renderDraftEditor(rows, { source: data.source });
    } catch (err) {
      console.error("loadScheduleDraft failed", err);
    }
  }
  function timeFromMs(ms, yyyymmdd) {
    if (!ms || !yyyymmdd) return "";
    try {
      // Format in Pacific
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Los_Angeles",
        hour12: false, hour: "2-digit", minute: "2-digit"
      }).formatToParts(new Date(ms));
      const h = parts.find(function (p) { return p.type === "hour"; });
      const m = parts.find(function (p) { return p.type === "minute"; });
      if (!h || !m) return "";
      return h.value + ":" + m.value;
    } catch (_e) { return ""; }
  }

  async function saveScheduleDraft() {
    syncDraftRowsFromTable();
    setDraftError("");
    if (!scheduleDraftRows.length) {
      setDraftError("Nothing to save — the draft is empty.");
      return;
    }
    const u = firebase.auth().currentUser;
    try {
      setDraftStatus("Saving draft…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(SCHEDULE_DRAFT_DOC_ID).set({
          parsedAt:      firebase.firestore.FieldValue.serverTimestamp(),
          parsedBy: {
            uid:         (u && u.uid) || null,
            email:       (u && u.email) || null,
            displayName: (u && u.displayName) || (u && u.email) || "admin"
          },
          parserVersion: SCHEDULE_PARSER_VERSION,
          source:        "draft",
          shiftCount:    scheduleDraftRows.length,
          shifts:        scheduleDraftRows.slice(),
          active:        false
        }, { merge: false });
      setDraftStatus("Draft saved. Reload won't lose your edits.");
    } catch (err) {
      console.error("saveScheduleDraft failed", err);
      setDraftError("Save failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }

  async function discardScheduleDraft() {
    if (!confirm("Discard the current draft? This cannot be undone.")) return;
    setDraftError("");
    try {
      setDraftStatus("Discarding draft…");
      // Overwrite with a tombstone (cheaper than delete since rules
      // already allow update). active:false + empty shifts means "no
      // draft" from the editor's perspective.
      await firebase.firestore().collection("published_team_schedule")
        .doc(SCHEDULE_DRAFT_DOC_ID).set({
          discardedAt:  firebase.firestore.FieldValue.serverTimestamp(),
          shiftCount:   0,
          shifts:       [],
          active:       false,
          source:       "discarded"
        }, { merge: false });
      scheduleDraftRows = [];
      renderDraftEditor([]);
      setDraftStatus("Draft discarded.");
    } catch (err) {
      console.error("discardScheduleDraft failed", err);
      setDraftError("Discard failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }

  async function publishFromDraft() {
    syncDraftRowsFromTable();
    setDraftError("");
    if (!scheduleDraftRows.length) {
      setDraftError("Nothing to publish — the draft is empty.");
      return;
    }
    // Build canonical shift records matching the schema Team Hub +
    // /team-schedule already render.
    const shifts = [];
    const problems = [];
    scheduleDraftRows.forEach(function (r, i) {
      if (!r.date)        { problems.push("Row " + (i + 1) + ": missing date"); return; }
      if (!r.startTime24) { problems.push("Row " + (i + 1) + ": missing start time"); return; }
      const startMs = buildLocalTimestamp(r.date, r.startTime24);
      const endMs   = r.endTime24 ? buildLocalTimestamp(r.date, r.endTime24) : null;
      shifts.push({
        date:           r.date,
        weekday:        weekdayLabel(r.date),
        startTime:      format12HourTime(r.startTime24),
        endTime:        r.endTime24 ? format12HourTime(r.endTime24) : "",
        startMs:        startMs,
        endMs:          endMs,
        techName:       r.techName     || "",
        techSlug:       r.techSlug     || "",
        customerName:   r.customerName || "",
        customerSlug:   r.customerSlug || "",
        status:         "scheduled",
        deputyShiftUrl: "",
        notes:          r.notes        || "",
        source:         r.source       || "manual",
        confidence:     typeof r.confidence === "number" ? r.confidence : 1
      });
    });
    if (problems.length) {
      setDraftError("Can't publish — " + problems.length + " row(s) need attention:\n" + problems.join("\n"));
      return;
    }
    shifts.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startMs || 0) - (b.startMs || 0);
    });

    const dates    = shifts.map(function (s) { return s.date; }).sort();
    const startDate = dates[0];
    const endDate   = dates[dates.length - 1];
    const days = Math.round((dateToMillisLocal(endDate) - dateToMillisLocal(startDate)) / 86400000) + 1;
    const viewRangeDays = days <= 7 ? 7 : (days <= 14 ? 14 : 21);

    const u = firebase.auth().currentUser;
    try {
      setDraftStatus("Publishing " + shifts.length + " shifts to Team Hub…");
      await firebase.firestore().collection("published_team_schedule")
        .doc(PUBLISHED_SCHEDULE_DOC_ID).set({
          publishedAt:       firebase.firestore.FieldValue.serverTimestamp(),
          publishedBy: {
            uid:         (u && u.uid) || null,
            email:       (u && u.email) || null,
            displayName: (u && u.displayName) || (u && u.email) || "admin"
          },
          startDate:         startDate,
          endDate:           endDate,
          viewRangeDays:     viewRangeDays,
          deputySyncVersion: null,
          shiftCount:        shifts.length,
          shifts:            shifts,
          notes:             null,
          source:            "import",
          active:            true
        }, { merge: false });
      setDraftStatus("Published " + shifts.length + " shifts (" + startDate + " → " + endDate + "). Team Hub will pick this up on next page load.");
      // Small celebration — schedule publish is a real milestone moment
      // for the office. Confetti only, no sound (admin pages stay quiet).
      try {
        if (window.PioneerCelebrate) window.PioneerCelebrate.fire({ intensity: "medium" });
      } catch (_e) {}
      // Refresh the published-snapshot summary so the admin sees the
      // up-to-date counts in the section below.
      loadPublishedSnapshot();
    } catch (err) {
      console.error("publishFromDraft failed", err);
      setDraftError("Publish failed: " + (err && (err.message || err.code) || "unknown"));
      setDraftStatus("");
    }
  }
  function dateToMillisLocal(yyyymmdd) {
    return new Date(yyyymmdd + "T12:00:00Z").getTime();
  }

  // Reflect "is there a PDF I can extract from?" onto the button so
  // admins see the actionability at a glance. Disabled state keeps the
  // button visible (cheaper than hiding it entirely — admins know the
  // feature exists) but unclickable, with a hovertip explaining why.
  function syncExtractButtonState(scheduleDoc) {
    const btn = document.getElementById("schedule-import-from-pdf");
    if (!btn) return;
    const hasPdf = !!(scheduleDoc && scheduleDoc.active !== false && scheduleDoc.downloadUrl);
    btn.disabled = !hasPdf;
    if (hasPdf) {
      btn.title = "Pull the schedule out of the currently uploaded PDF";
    } else {
      btn.title = "Upload the Deputy schedule PDF below first.";
    }
  }

  /* ---------- Import controls wiring ---------- */
  async function onExtractFromPdfClick() {
    setImportError("");
    setImportStatus("Reading current PDF backup…");
    scheduleExtractLog("click", { now: new Date().toISOString() });
    if (!window.firebase || typeof firebase.firestore !== "function") {
      setImportError("Firestore SDK isn't loaded.");
      return;
    }
    let pdfDoc;
    try {
      pdfDoc = await firebase.firestore().collection("team_schedule").doc("current").get();
    } catch (err) {
      setImportError("Couldn't read team_schedule/current: " + (err && err.message || err));
      setImportStatus("");
      return;
    }
    const data = pdfDoc.exists ? pdfDoc.data() : null;
    if (!data || !data.downloadUrl) {
      setImportError("No schedule PDF uploaded yet. Upload the Deputy PDF in the section below, then click Extract again.");
      setImportStatus("");
      return;
    }
    // Pre-flight reachability — turns the generic "Failed to fetch"
    // PDF.js throws into a specific, actionable error.
    scheduleExtractLog("pdfUrl", { url: data.downloadUrl });
    setImportStatus("Checking PDF reachability…");
    const reach = await pdfUrlIsReachable(data.downloadUrl);
    if (!reach.ok) {
      let msg;
      if (reach.code === "timeout") {
        msg = "The schedule PDF didn't load in time. Try Extract again in a minute. " +
              "If it keeps failing, ask Nick to help import this schedule manually.";
      } else if (reach.code === "bad_status") {
        msg = "The schedule PDF storage URL returned HTTP " + reach.status + ". " +
              "The file may have been moved or replaced. Re-upload the PDF below, " +
              "or ask Nick to help import this schedule manually.";
      } else {
        msg = "We couldn't reach the schedule PDF (" + (reach.message || "network error") + "). " +
              "An ad blocker or browser extension may be blocking it. " +
              "Try a different browser, or ask Nick to help import this schedule manually.";
      }
      setImportError(msg);
      setImportStatus("");
      return;
    }

    try {
      setImportStatus("Reading the schedule from the PDF…");
      scheduleExtractLog("extract start", { url: data.downloadUrl });
      const text = await extractPdfText(data.downloadUrl);
      const ta = $("schedule-import-text");
      const len = (text || "").trim().length;
      scheduleExtractLog("extract done", { length: len });
      if (!len) {
        // Reachability OK, library OK, but no text — almost always means
        // the PDF is image-only (scanned/exported as raster). Be specific.
        if (ta) ta.value = "";
        setImportError(
          "We couldn't read any text from that PDF — it looks image-only (scanned or rasterized). " +
          "Re-export from Deputy as a text PDF and try again, or ask Nick to help import this schedule manually."
        );
        setImportStatus("");
        return;
      }
      if (ta) ta.value = text;
      // Auto-convert the extracted text into a draft so the office never
      // has to know "Convert" exists. The Advanced panel still has the
      // button for hand-edited imports.
      setImportStatus("Building the schedule draft…");
      try {
        await onParseImportClick();
        setImportStatus("Schedule draft ready below. Review it, then publish to Team Hub.");
      } catch (parseErr) {
        scheduleExtractWarn("auto-parse failed", { error: parseErr && parseErr.message });
        // Surface the textarea + Advanced panel so the office can adjust.
        const adv = document.getElementById("schedule-import-advanced");
        if (adv) adv.open = true;
        setImportError(
          "We read the PDF but couldn't turn it into a schedule draft automatically. " +
          "Open the Advanced panel below to review the text, or ask Nick to help import this schedule manually."
        );
        setImportStatus("");
      }
    } catch (err) {
      const msg  = (err && err.message) || String(err);
      const name = err && err.name;
      scheduleExtractWarn("extract failed", { name: name, message: msg });
      // Categorize the failure. All branches end with the "Nick can help"
      // escape hatch so the admin never feels stranded.
      let friendly;
      if (/Failed to fetch|NetworkError|network/i.test(msg)) {
        friendly = "The PDF download was interrupted (" + msg + "). " +
                   "Try Extract again. If it keeps failing, ask Nick to help import this schedule manually.";
      } else if (/Invalid PDF|UnknownErrorException|InvalidPDFException/i.test(msg)) {
        friendly = "That PDF couldn't be opened — the file looks corrupt or isn't a valid PDF. " +
                   "Re-upload the PDF below, or ask Nick to help import this schedule manually.";
      } else if (/Password|encrypted/i.test(msg)) {
        friendly = "That PDF is password-protected. Save an unprotected copy and re-upload, " +
                   "or ask Nick to help import this schedule manually.";
      } else if (/PDF\.js/i.test(msg)) {
        friendly = "PDF extraction is temporarily unavailable. " +
                   "Try again in a minute. If it keeps failing, ask Nick to help import this schedule manually.";
      } else {
        friendly = "PDF extraction didn't work (" + msg + "). " +
                   "Nick can help import this schedule manually.";
      }
      setImportError(friendly);
      setImportStatus("");
    }
  }

  function onClearImportClick() {
    const ta = $("schedule-import-text");
    if (ta) ta.value = "";
    setImportStatus("");
    setImportError("");
  }

  async function onParseImportClick() {
    setImportError("");
    const ta = $("schedule-import-text");
    const text = ta ? ta.value : "";
    if (!text || text.trim().length < 8) {
      setImportError("Paste some schedule text first (or extract from the current PDF).");
      return;
    }
    const yearEl = $("schedule-import-year");
    const defaultYear = (yearEl && Number(yearEl.value)) || new Date().getFullYear();
    setImportStatus("Parsing…");
    let rows;
    try {
      rows = parseScheduleText(text, { defaultYear: defaultYear, source: "pdf_import" });
    } catch (err) {
      setImportError("Parser threw an error: " + (err && err.message || err));
      setImportStatus("");
      return;
    }
    if (!rows.length) {
      setImportError(
        "No shifts found in the pasted text. Check: each row needs a recognizable time " +
        "range (e.g., 5:00-8:30) and at least one tech / customer hint."
      );
      setImportStatus("");
      return;
    }
    const lowConf = rows.filter(function (r) { return r.confidence < 0.7; }).length;
    setImportStatus(
      "Parsed " + rows.length + " shifts. " +
      (lowConf ? lowConf + " row(s) low-confidence — review highlighted rows below." : "All rows look good — review below.")
    );
    renderDraftEditor(rows, { source: "pdf_import" });
  }

  function wireScheduleImportControls() {
    const yearEl = $("schedule-import-year");
    if (yearEl && !yearEl.value) yearEl.value = String(new Date().getFullYear());

    const ext = $("schedule-import-from-pdf");
    if (ext) ext.addEventListener("click", onExtractFromPdfClick);
    const clr = $("schedule-import-clear");
    if (clr) clr.addEventListener("click", onClearImportClick);
    const parseBtn = $("schedule-import-parse");
    if (parseBtn) parseBtn.addEventListener("click", onParseImportClick);

    const addRow = $("schedule-draft-add-row");
    if (addRow) addRow.addEventListener("click", addEmptyDraftRow);
    const saveBtn = $("schedule-draft-save");
    if (saveBtn) saveBtn.addEventListener("click", saveScheduleDraft);
    const discardBtn = $("schedule-draft-discard");
    if (discardBtn) discardBtn.addEventListener("click", discardScheduleDraft);
    const publishBtn = $("schedule-draft-publish");
    if (publishBtn) publishBtn.addEventListener("click", publishFromDraft);

    // Delegated click for per-row delete buttons.
    const body = $("schedule-draft-rows");
    if (body) {
      body.addEventListener("click", function (ev) {
        const btn = ev.target.closest && ev.target.closest("[data-act='delete']");
        if (!btn) return;
        const tr = btn.closest("tr");
        if (!tr) return;
        const idx = parseInt(tr.dataset.idx, 10);
        if (!isNaN(idx)) deleteDraftRow(idx);
      });
    }
  }

  function wireScheduleControls() {
    const form = $("schedule-upload-form");
    if (form) form.addEventListener("submit", onScheduleUploadSubmit);
    const publishForm = $("schedule-publish-form");
    if (publishForm) publishForm.addEventListener("submit", onPublishScheduleSubmit);
    const syncNowBtn = $("schedule-sync-now-btn");
    if (syncNowBtn) syncNowBtn.addEventListener("click", onSyncFromDeputyClick);
    const refresh = $("schedule-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      loadTeamSchedule();
      loadPublishedSnapshot();
      loadScheduleDraft();
    });
    // Clear inline upload errors as soon as the user picks a new file.
    const fileInput = $("schedule-upload-file");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        setScheduleUploadError("");
        setScheduleUploadStatus("");
      });
    }

    // Auto-load on first tab activation. The shell's wireTabs() click
    // handler only toggles visibility — it does NOT fire the
    // registered tab activator (registerTabActivator is reached only
    // via programmatic activateTab() from Attention Strip / Yesterday's
    // Work). So we add our own click listener to load Team Schedule +
    // Published Snapshot + Schedule Draft the first time the user
    // navigates here. Mirrors the same pattern Deputy Mapping uses.
    // This is what makes the "Reload won't lose your edits" promise on
    // saveScheduleDraft accurate — on reload + tab click, the saved
    // draft is fetched and rendered.
    const tabBtn = document.querySelector('.admin-tab[data-tab="schedule"]');
    let firstActivation = true;
    if (tabBtn) {
      tabBtn.addEventListener("click", function () {
        if (!firstActivation) return;
        firstActivation = false;
        loadTeamSchedule();
        loadPublishedSnapshot();
        loadScheduleDraft();
      });
    }
  }

  /* ---------- export surface ---------- */

  function init() {
    wireScheduleControls();
    wireScheduleImportControls();
  }

  function refresh() {
    loadTeamSchedule();
    loadPublishedSnapshot();
    loadScheduleDraft();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.schedule = {
    init:             init,
    refresh:          refresh,
    refreshTeam:      loadTeamSchedule,
    refreshPublished: loadPublishedSnapshot,
    refreshDraft:     loadScheduleDraft
  };
}());
