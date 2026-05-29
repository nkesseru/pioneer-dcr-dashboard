/* Pioneer DCR Hub — Admin Pilot Readiness tab (vanilla JS, no build).
 *
 * Pilot Readiness — admin-only pre-rollout audit panel.
 *
 * Calls `pilotReadinessCheckV1` (admin-gated HTTPS endpoint). Renders
 * the per-tech PASS/WARN/FAIL breakdown grouped by category. The Run
 * check button is the explicit trigger — we don't auto-run on tab
 * activate because the report touches Firebase Auth + Firestore for
 * every tech and we don't want a hot reload to thrash the API.
 *
 * Surface lives at window.__pioneerAdmin.tabs.pilotReadiness:
 *   { init: initPilotReadinessOnce }
 *
 * No `refresh` is exported — by design, the report only runs on
 * explicit Run / Refresh button clicks. The buttons are wired by
 * init() and remain functional for the rest of the session.
 *
 * Loaded AFTER admin/_utils.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml from __pioneerAdmin.utils
 *   • window.firebase compat SDK (auth — for ID token)
 *   • window.PILOT_READINESS_CHECK_URL (config in firebase-config.js)
 *   • fetch(), navigator.clipboard, window.prompt — DOM globals
 *
 * No closure deps on admin.js — this module is self-contained.
 * No cross-tab state escape.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin/tab-pilot-readiness.js: admin/_utils.js must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;

  /* ---------- module state ---------- */

  let pilotReadinessWired = false;
  let pilotReadinessLastReport = null;

  function initPilotReadinessOnce() {
    if (pilotReadinessWired) return;
    pilotReadinessWired = true;
    const runBtn     = document.getElementById("pilot-readiness-run");
    const refreshBtn = document.getElementById("pilot-readiness-refresh");
    const copyBtn    = document.getElementById("pilot-readiness-copy");
    if (runBtn)     runBtn.addEventListener("click", function () { runPilotReadiness(); });
    if (refreshBtn) refreshBtn.addEventListener("click", function () { runPilotReadiness(); });
    if (copyBtn)    copyBtn.addEventListener("click", function () { copyPilotReadinessReport(); });
  }

  async function runPilotReadiness() {
    const url = window.PILOT_READINESS_CHECK_URL;
    const loadingEl = document.getElementById("pilot-readiness-loading");
    const errEl     = document.getElementById("pilot-readiness-error");
    const summaryEl = document.getElementById("pilot-readiness-summary");
    const resultsEl = document.getElementById("pilot-readiness-results");
    const emptyEl   = document.getElementById("pilot-readiness-empty");
    const runBtn    = document.getElementById("pilot-readiness-run");
    const refreshBtn = document.getElementById("pilot-readiness-refresh");
    const copyBtn   = document.getElementById("pilot-readiness-copy");

    if (!url) {
      if (errEl) { errEl.textContent = "PILOT_READINESS_CHECK_URL not configured in firebase-config.js."; errEl.hidden = false; }
      return;
    }
    if (loadingEl) loadingEl.hidden = false;
    if (errEl)     errEl.hidden = true;
    if (summaryEl) summaryEl.hidden = true;
    if (resultsEl) resultsEl.hidden = true;
    if (emptyEl)   emptyEl.hidden = true;
    if (runBtn)    runBtn.disabled = true;

    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) {}
    if (!idToken) {
      if (errEl) { errEl.textContent = "You appear to be signed out. Refresh and sign in again."; errEl.hidden = false; }
      if (loadingEl) loadingEl.hidden = true;
      if (runBtn)    runBtn.disabled = false;
      return;
    }

    try {
      const res = await fetch(url, {
        method:  "GET",
        headers: { "Authorization": "Bearer " + idToken }
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        const msg = (body && body.error) || ("Server returned " + res.status);
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
        return;
      }
      pilotReadinessLastReport = body.report;
      renderPilotReadinessReport(body.report);
      if (refreshBtn) refreshBtn.hidden = false;
      if (copyBtn)    copyBtn.hidden    = false;
      if (runBtn)     runBtn.hidden     = true;
    } catch (err) {
      console.error("pilotReadinessCheckV1 fetch failed", err);
      if (errEl) {
        errEl.textContent = "Couldn't reach the readiness service. " + (err && err.message ? err.message : "Check your connection and try again.");
        errEl.hidden = false;
      }
    } finally {
      if (loadingEl) loadingEl.hidden = true;
      if (runBtn)    runBtn.disabled = false;
    }
  }

  function renderPilotReadinessReport(report) {
    const summaryEl = document.getElementById("pilot-readiness-summary");
    const resultsEl = document.getElementById("pilot-readiness-results");
    const emptyEl   = document.getElementById("pilot-readiness-empty");
    if (!report || !Array.isArray(report.techs)) return;
    if (report.techs.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    const s = report.summary || { tech_count: report.techs.length, pass: 0, warn: 0, fail: 0 };

    if (summaryEl) {
      summaryEl.innerHTML =
        '<div class="pr-summary-row">' +
          '<span class="pr-summary-stat pr-stat-total">' +
            '<strong>' + s.tech_count + '</strong> tech' + (s.tech_count === 1 ? "" : "s") + ' checked' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-pass">' +
            '<strong>' + s.pass + '</strong> PASS' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-warn">' +
            '<strong>' + s.warn + '</strong> WARN' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-fail">' +
            '<strong>' + s.fail + '</strong> FAIL' +
          '</span>' +
          '<span class="pr-summary-stat pr-stat-time">' +
            'Generated ' + escapeHtml(report.generated_at || "") +
          '</span>' +
        '</div>';
      summaryEl.hidden = false;
    }

    if (resultsEl) {
      resultsEl.innerHTML = report.techs.map(function (t) {
        const grouped = Object.create(null);
        (t.checks || []).forEach(function (c) {
          if (!grouped[c.category]) grouped[c.category] = [];
          grouped[c.category].push(c);
        });
        const groupHtml = Object.keys(grouped).map(function (cat) {
          const rows = grouped[cat].map(function (c) {
            return '<li class="pr-check pr-' + escapeHtml(c.level) + '">' +
                     '<span class="pr-check-badge">' + escapeHtml(c.level) + '</span> ' +
                     '<span class="pr-check-label">' + escapeHtml(c.label) + '</span>' +
                     (c.detail
                       ? '<div class="pr-check-detail">' + escapeHtml(c.detail) + '</div>'
                       : '') +
                   '</li>';
          }).join("");
          return '<div class="pr-category">' +
                   '<h4 class="pr-category-head">' + escapeHtml(cat) + '</h4>' +
                   '<ul class="pr-check-list">' + rows + '</ul>' +
                 '</div>';
        }).join("");
        return '<article class="pr-tech pr-tech-' + escapeHtml(t.overall) + '">' +
                 '<header class="pr-tech-head">' +
                   '<span class="pr-tech-badge">' + escapeHtml(t.overall) + '</span> ' +
                   '<strong class="pr-tech-name">' + escapeHtml(t.display_name || t.tech_slug) + '</strong> ' +
                   '<span class="pr-tech-meta">' + escapeHtml(t.tech_slug || "") +
                     (t.email ? ' · ' + escapeHtml(t.email) : '') +
                   '</span>' +
                 '</header>' +
                 groupHtml +
               '</article>';
      }).join("");
      resultsEl.hidden = false;
    }
  }

  function copyPilotReadinessReport() {
    if (!pilotReadinessLastReport) return;
    const r = pilotReadinessLastReport;
    const lines = [];
    lines.push("Pioneer DCR Hub — Pilot Readiness");
    lines.push("Generated " + (r.generated_at || ""));
    lines.push("Techs: " + r.summary.tech_count + " · PASS " + r.summary.pass +
               " · WARN " + r.summary.warn + " · FAIL " + r.summary.fail);
    lines.push("");
    (r.techs || []).forEach(function (t) {
      lines.push("[" + t.overall + "] " + (t.display_name || t.tech_slug) +
                 "  ·  " + t.tech_slug + (t.email ? " · " + t.email : ""));
      const grouped = Object.create(null);
      (t.checks || []).forEach(function (c) {
        if (!grouped[c.category]) grouped[c.category] = [];
        grouped[c.category].push(c);
      });
      Object.keys(grouped).forEach(function (cat) {
        lines.push("  [" + cat + "]");
        grouped[cat].forEach(function (c) {
          lines.push("    " + c.level + "  " + c.label);
          if (c.detail) lines.push("        " + c.detail);
        });
      });
      lines.push("");
    });
    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        const btn = document.getElementById("pilot-readiness-copy");
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(function () { btn.textContent = orig; }, 1500);
        }
      }).catch(function (e) {
        console.warn("clipboard write failed", e);
        window.prompt("Copy the report below:", text);
      });
    } else {
      window.prompt("Copy the report below:", text);
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.pilotReadiness = {
    init: initPilotReadinessOnce
  };
}());
