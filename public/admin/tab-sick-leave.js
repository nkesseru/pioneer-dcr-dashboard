/* Pioneer DCR Hub — Admin Sick Leave tab (Phase 1f).
 *
 * Surface: per-tech banked sick-leave balance management.
 *   • Set opening balance — only available for techs whose
 *     staff_labor_balances doc does NOT yet exist. Creates the balance
 *     doc + a `sick_leave_ledger` entry of type "opening_balance" in
 *     one batch. Mirrors scripts/seed-labor-opening-balances.js so a
 *     manual admin seed lines up with the script seed.
 *   • Add adjustment — for techs with an existing balance doc. Posts a
 *     `sick_leave_ledger` entry of type "admin_adjustment" (signed
 *     minutes_delta + required non-empty reason) AND updates the
 *     materialized balance doc atomically in the same batch. Never
 *     overwrites silently — every balance change has a ledger row.
 *
 * Cap: 2400 minutes (40 hours). Enforced client-side here; an "Allow
 * above cap" checkbox lets admin override per the requirement.
 *
 * Firestore I/O (admin-only — zero rule changes needed):
 *   • cleaning_techs       — read (active only) via deps.getTechs()
 *   • staff_labor_balances — read (whole collection) + create + update
 *   • sick_leave_ledger    — create only (append-only by rules)
 *
 * Surface lives at window.__pioneerAdmin.tabs.sickLeave:
 *   { init, refresh }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-sick-leave.js: utils + shell modules must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;

  const CAP_MINUTES = 2400;  // 40h Phase 1 ceiling; admin can override per entry.

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let balancesByUid = {};   // uid → staff_labor_balances data
  let loaded        = false;
  let loading       = false;
  // Current modal context (which tech we're editing). Refreshed each open.
  let currentTech    = null;
  let currentBalance = null;

  /* ---------- helpers ---------- */

  function getActiveTechs() {
    let list = [];
    try {
      const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
      if (deps && typeof deps.getTechs === "function") list = deps.getTechs() || [];
    } catch (_e) { list = []; }
    return list.filter(function (t) { return t && t.active !== false; });
  }

  function techDisplayName(t) {
    if (!t) return "—";
    if (t.display_name) return t.display_name;
    const fn = t.first_name || "";
    const ln = t.last_name  || "";
    const joined = (fn + " " + ln).trim();
    return joined || t.email || t.id || "Tech";
  }

  function techEmail(t) {
    return String((t && t.email) || "").toLowerCase().trim();
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    return 0;
  }
  function fmtDateTime(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }
  function fmtMinutes(m) {
    if (m == null || isNaN(m)) return "—";
    const n = Math.round(m);
    if (n === 0) return "0h";
    const neg = n < 0;
    const abs = Math.abs(n);
    const h = Math.floor(abs / 60);
    const r = abs % 60;
    let label;
    if (h === 0) label = r + "m";
    else if (r === 0) label = h + "h";
    else label = h + "h " + r + "m";
    return neg ? ("-" + label) : label;
  }
  function fmtHoursForInput(m) {
    if (m == null || isNaN(m)) return "";
    return (Math.round(m) / 60).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }
  function hoursToMinutes(hoursStr) {
    const n = Number(hoursStr);
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * 60);
  }

  function currentAdminEmail() {
    try {
      const u = firebase.auth().currentUser;
      return u ? (u.email || "admin") : "admin";
    } catch (_) { return "admin"; }
  }

  function pacificDateStringNow() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
    } catch (_e) { return new Date().toISOString().slice(0, 10); }
  }

  /* ---------- loaders ---------- */

  function setState(state, msg) {
    const loadingEl = $("sick-leave-loading");
    const errorEl   = $("sick-leave-error");
    if (loadingEl) loadingEl.hidden = (state !== "loading");
    if (errorEl) {
      errorEl.hidden = (state !== "error");
      if (state === "error" && msg) errorEl.textContent = msg;
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    setState("loading");
    try {
      const snap = await firebase.firestore().collection("staff_labor_balances").get();
      balancesByUid = {};
      snap.docs.forEach(function (d) {
        balancesByUid[d.id] = Object.assign({ _id: d.id }, d.data() || {});
      });
      loaded = true;
      setState(null);
      render();
    } catch (err) {
      console.error("[sick-leave] load failed", err);
      const msg = err && err.code === "permission-denied"
        ? "Permission denied. Confirm firestore.rules grants isPioneerAdmin() read on staff_labor_balances."
        : "Couldn't load sick leave balances: " + ((err && (err.message || err.code)) || "unknown");
      setState("error", msg);
    } finally {
      loading = false;
    }
  }

  /* ---------- renderers ---------- */

  function render() {
    if (!loaded) return;
    renderHeader();
    renderTable();
  }

  function renderHeader() {
    const sub = $("sick-leave-sub");
    if (!sub) return;
    const techs = getActiveTechs();
    let seeded = 0;
    techs.forEach(function (t) {
      const uid = t.uid || t.auth_uid;
      if (uid && balancesByUid[uid]) seeded += 1;
    });
    sub.textContent = techs.length + " active tech" + (techs.length === 1 ? "" : "s") +
      " · " + seeded + " with balances seeded";
  }

  function renderTable() {
    const wrap  = $("sick-leave-table");
    const empty = $("sick-leave-empty");
    if (!wrap || !empty) return;
    const techs = getActiveTechs();
    if (!techs.length) {
      wrap.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    techs.sort(function (a, b) {
      return techDisplayName(a).localeCompare(techDisplayName(b));
    });

    const headerHtml =
      '<div class="sick-row sick-row-head">' +
        '<div class="sl-col-name">Tech</div>' +
        '<div class="sl-col-email">Email</div>' +
        '<div class="sl-col-avail">Available</div>' +
        '<div class="sl-col-used">Used</div>' +
        '<div class="sl-col-period">Period</div>' +
        '<div class="sl-col-updated">Last update</div>' +
        '<div class="sl-col-act"></div>' +
      '</div>';

    const rowsHtml = techs.map(function (t) {
      const uid     = t.uid || t.auth_uid || "";
      const balance = uid ? balancesByUid[uid] : null;
      const name    = techDisplayName(t);
      const email   = techEmail(t);

      let availLabel, usedLabel, periodLabel, updatedLabel, actionHtml;
      if (!uid) {
        availLabel = '<span class="sl-muted">—</span>';
        usedLabel  = '<span class="sl-muted">—</span>';
        periodLabel = '<span class="sl-muted">—</span>';
        updatedLabel = '<span class="sl-muted" title="Tech has not signed in yet — no auth uid on cleaning_techs/' +
                       escapeHtml(t.id || "") + '">No auth uid</span>';
        actionHtml = '';
      } else if (!balance) {
        availLabel = '<span class="sl-muted">Not seeded</span>';
        usedLabel  = '<span class="sl-muted">—</span>';
        periodLabel = '<span class="sl-muted">—</span>';
        updatedLabel = '<span class="sl-muted">—</span>';
        actionHtml =
          '<button type="button" class="sick-btn sick-btn-primary" data-act="seed" ' +
            'data-tech-id="' + escapeHtml(t.id) + '">Set opening balance…</button>';
      } else {
        const avail    = balance.sick_leave_balance_minutes;
        const used     = balance.sick_leave_lifetime_used_minutes;
        const periodMin = balance.current_period_id ? balance.current_period_work_minutes : null;
        const updated  = Math.max(tsToMs(balance.updated_at), tsToMs(balance.last_ledger_entry_at));
        availLabel = '<strong>' + escapeHtml(fmtMinutes(avail)) + '</strong>';
        if (typeof avail === "number" && avail >= CAP_MINUTES) {
          availLabel += ' <span class="sl-cap-chip">cap</span>';
        }
        usedLabel  = escapeHtml(fmtMinutes(used));
        periodLabel = periodMin == null
          ? '<span class="sl-muted">—</span>'
          : escapeHtml(fmtMinutes(periodMin));
        updatedLabel = updated ? escapeHtml(fmtDateTime(updated)) : '<span class="sl-muted">—</span>';
        actionHtml =
          '<button type="button" class="sick-btn" data-act="adjust" ' +
            'data-tech-id="' + escapeHtml(t.id) + '">Adjust…</button>';
      }

      return (
        '<div class="sick-row" data-tech-id="' + escapeHtml(t.id) + '">' +
          '<div class="sl-col-name">' + escapeHtml(name) + '</div>' +
          '<div class="sl-col-email">' + escapeHtml(email || "—") + '</div>' +
          '<div class="sl-col-avail">' + availLabel + '</div>' +
          '<div class="sl-col-used">' + usedLabel + '</div>' +
          '<div class="sl-col-period">' + periodLabel + '</div>' +
          '<div class="sl-col-updated">' + updatedLabel + '</div>' +
          '<div class="sl-col-act">' + actionHtml + '</div>' +
        '</div>'
      );
    }).join("");

    wrap.innerHTML = headerHtml + rowsHtml;
  }

  /* ---------- writers ---------- */

  // Opening balance — create both docs in one batch. Mirrors the seed
  // script's payload so manual seeds and script seeds are interchangeable.
  async function setOpeningBalance(opts) {
    const tech      = opts.tech;
    const minutes   = opts.minutes;
    const reason    = opts.reason;
    const adminEmail = currentAdminEmail();
    const staff_uid = tech.uid || tech.auth_uid;
    if (!staff_uid) throw new Error("Tech has no auth uid yet. Ask them to sign in once and refresh.");
    const staff_email = techEmail(tech);
    const db          = firebase.firestore();
    const sts         = firebase.firestore.FieldValue.serverTimestamp();
    const effective_date = pacificDateStringNow();

    const balanceRef = db.collection("staff_labor_balances").doc(staff_uid);
    const existing   = await balanceRef.get();
    if (existing.exists) {
      throw new Error("Balance already seeded for " + staff_email + ". Use Adjust instead.");
    }

    const ledgerRef = db.collection("sick_leave_ledger").doc();
    const batch = db.batch();
    batch.set(ledgerRef, {
      staff_uid:      staff_uid,
      staff_email:    staff_email,
      entry_type:     "opening_balance",
      minutes_delta:  minutes,
      effective_date: effective_date,
      reason:         reason || "Opening balance seeded by " + adminEmail,
      source:         { kind: "admin_ui", ref_id: null },
      basis:          null,
      created_at:     sts,
      created_by:     adminEmail,
      batch_id:       null
    });
    batch.set(balanceRef, {
      staff_uid:                                   staff_uid,
      staff_email:                                 staff_email,
      sick_leave_balance_minutes:                  minutes,
      sick_leave_lifetime_earned_minutes:          0,
      sick_leave_lifetime_used_minutes:            0,
      sick_leave_lifetime_adjusted_minutes:        0,
      sick_leave_lifetime_forfeited_minutes:       0,
      sick_leave_opening_balance_minutes:          minutes,
      current_period_id:                           null,
      current_period_work_minutes:                 0,
      current_period_paid_drive_minutes:           0,
      current_period_paid_minutes:                 0,
      current_period_sick_accrual_estimated_minutes: 0,
      hire_date:                                   tech.hire_date || null,
      sick_leave_usable_after:                     null,
      last_ledger_entry_id:                        ledgerRef.id,
      last_ledger_entry_at:                        sts,
      updated_at:                                  sts,
      updated_by:                                  adminEmail
    });
    await batch.commit();
  }

  // Adjustment — append-only ledger entry + balance doc update in one
  // batch. The balance doc's running totals are recomputed from the
  // existing snapshot + the signed delta. Never overwrites the balance
  // without a matching ledger row.
  async function applyAdjustment(opts) {
    const tech         = opts.tech;
    const minutesDelta = opts.minutesDelta;   // signed integer
    const reason       = opts.reason;
    const adminEmail   = currentAdminEmail();
    const staff_uid    = tech.uid || tech.auth_uid;
    if (!staff_uid) throw new Error("Tech has no auth uid.");
    const staff_email  = techEmail(tech);
    const db           = firebase.firestore();
    const sts          = firebase.firestore.FieldValue.serverTimestamp();
    const effective_date = pacificDateStringNow();

    const balanceRef = db.collection("staff_labor_balances").doc(staff_uid);
    const existingSnap = await balanceRef.get();
    if (!existingSnap.exists) {
      throw new Error("No balance doc to adjust. Set the opening balance first.");
    }
    const existing = existingSnap.data() || {};
    const prevBalance = Number(existing.sick_leave_balance_minutes) || 0;
    const prevAdj     = Number(existing.sick_leave_lifetime_adjusted_minutes) || 0;
    const newBalance  = prevBalance + minutesDelta;
    if (newBalance < 0) {
      throw new Error("Adjustment would drop balance below zero (" +
        fmtMinutes(prevBalance) + " - " + fmtMinutes(-minutesDelta) +
        " = " + fmtMinutes(newBalance) + ").");
    }

    const ledgerRef = db.collection("sick_leave_ledger").doc();
    const batch = db.batch();
    batch.set(ledgerRef, {
      staff_uid:      staff_uid,
      staff_email:    staff_email,
      entry_type:     "admin_adjustment",
      minutes_delta:  minutesDelta,
      effective_date: effective_date,
      reason:         reason,
      source:         { kind: "admin_ui", ref_id: null },
      basis:          null,
      created_at:     sts,
      created_by:     adminEmail,
      batch_id:       null
    });
    batch.update(balanceRef, {
      sick_leave_balance_minutes:           newBalance,
      sick_leave_lifetime_adjusted_minutes: prevAdj + minutesDelta,
      last_ledger_entry_id:                 ledgerRef.id,
      last_ledger_entry_at:                 sts,
      updated_at:                           sts,
      updated_by:                           adminEmail
    });
    await batch.commit();
  }

  /* ---------- modals ---------- */

  function openOpeningBalanceModal(tech) {
    currentTech = tech;
    currentBalance = null;
    const modal = $("sick-seed-modal");
    if (!modal) return;
    $("sick-seed-summary").textContent = techDisplayName(tech) + " · " + techEmail(tech);
    $("sick-seed-hours").value = "";
    $("sick-seed-reason").value = "";
    $("sick-seed-allow-cap").checked = false;
    const errEl = $("sick-seed-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setTimeout(function () { $("sick-seed-hours").focus(); }, 60);
  }

  function openAdjustmentModal(tech) {
    currentTech    = tech;
    const uid      = tech.uid || tech.auth_uid;
    currentBalance = uid ? balancesByUid[uid] : null;
    const modal = $("sick-adj-modal");
    if (!modal) return;
    const currentMin = currentBalance ? currentBalance.sick_leave_balance_minutes : 0;
    $("sick-adj-summary").textContent =
      techDisplayName(tech) + " · " + techEmail(tech) +
      " · current balance " + fmtMinutes(currentMin);
    $("sick-adj-hours").value = "";
    $("sick-adj-reason").value = "";
    $("sick-adj-allow-cap").checked = false;
    const errEl = $("sick-adj-err");
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setTimeout(function () { $("sick-adj-hours").focus(); }, 60);
  }

  function closeSickModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function submitOpeningBalance() {
    const errEl   = $("sick-seed-err");
    const saveBtn = $("sick-seed-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    if (!currentTech) { showErr("No tech selected."); return; }
    const hoursStr = ($("sick-seed-hours") && $("sick-seed-hours").value) || "";
    const reason   = (($("sick-seed-reason") && $("sick-seed-reason").value) || "").trim();
    const allowCap = !!($("sick-seed-allow-cap") && $("sick-seed-allow-cap").checked);
    const minutes  = hoursToMinutes(hoursStr);
    if (!Number.isFinite(minutes) || minutes < 0) {
      showErr("Enter a non-negative number of hours."); return;
    }
    if (minutes > CAP_MINUTES && !allowCap) {
      showErr("Opening balance exceeds the 40h cap (" + fmtMinutes(minutes) +
        "). Check 'Allow above cap' to override."); return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
      await setOpeningBalance({ tech: currentTech, minutes: minutes, reason: reason });
      closeSickModal("sick-seed-modal");
      refresh();
    } catch (err) {
      console.error("[sick-leave] opening balance failed", err);
      showErr((err && (err.message || err.code)) || "Save failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function submitAdjustment() {
    const errEl   = $("sick-adj-err");
    const saveBtn = $("sick-adj-save");
    function showErr(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } }

    if (!currentTech) { showErr("No tech selected."); return; }
    const hoursStr = ($("sick-adj-hours") && $("sick-adj-hours").value) || "";
    const reason   = (($("sick-adj-reason") && $("sick-adj-reason").value) || "").trim();
    const allowCap = !!($("sick-adj-allow-cap") && $("sick-adj-allow-cap").checked);
    const minutes  = hoursToMinutes(hoursStr);
    if (!Number.isFinite(minutes) || minutes === 0) {
      showErr("Enter a non-zero number of hours (positive or negative)."); return;
    }
    if (reason.length < 5) {
      showErr("Reason must be at least 5 characters (required for admin adjustments)."); return;
    }
    const prev = currentBalance ? Number(currentBalance.sick_leave_balance_minutes) || 0 : 0;
    const next = prev + minutes;
    if (next > CAP_MINUTES && !allowCap) {
      showErr("Adjustment would push balance above the 40h cap (" + fmtMinutes(next) +
        "). Check 'Allow above cap' to override."); return;
    }
    if (next < 0) {
      showErr("Adjustment would drop balance below zero (current " + fmtMinutes(prev) +
        ", delta " + fmtMinutes(minutes) + ", result " + fmtMinutes(next) + ")."); return;
    }

    if (saveBtn) saveBtn.disabled = true;
    try {
      await applyAdjustment({ tech: currentTech, minutesDelta: minutes, reason: reason });
      closeSickModal("sick-adj-modal");
      refresh();
    } catch (err) {
      console.error("[sick-leave] adjustment failed", err);
      showErr((err && (err.message || err.code)) || "Save failed.");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /* ---------- wire-up ---------- */

  function findTechById(id) {
    return getActiveTechs().find(function (t) { return t && t.id === id; }) || null;
  }

  function wire() {
    const refreshBtn = $("sick-leave-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { refresh(); });

    // Delegated row-button clicks for both Seed and Adjust.
    document.addEventListener("click", function (ev) {
      const btn = ev.target.closest && ev.target.closest('.sick-btn[data-act]');
      if (!btn) return;
      const techId = btn.dataset.techId;
      if (!techId) return;
      const tech = findTechById(techId);
      if (!tech) return;
      if (btn.dataset.act === "seed")   openOpeningBalanceModal(tech);
      if (btn.dataset.act === "adjust") openAdjustmentModal(tech);
    });

    const seedSave = $("sick-seed-save");
    if (seedSave) seedSave.addEventListener("click", submitOpeningBalance);
    const adjSave = $("sick-adj-save");
    if (adjSave) adjSave.addEventListener("click", submitAdjustment);
  }

  /* ---------- export ---------- */

  function init() {
    wire();
  }

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.sickLeave = {
    init:    init,
    refresh: refresh
  };
}());
