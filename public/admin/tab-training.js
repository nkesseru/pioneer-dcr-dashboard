/* Pioneer DCR Hub — Admin Training Reports tab (vanilla JS, no build).
 *
 * Training Reports (System tab → Training)
 *
 * Reads safety-training completion progress across every user via a
 * collectionGroup("training_progress") query. firestore.rules gates
 * that pattern to admins only (see the
 * `match /{path=**}/training_progress/{lessonId}` block).
 *
 * Lessons come from /data/training-lessons.json — the same static
 * file the tech viewer (training.js) uses. We don't store lesson
 * metadata in Firestore so admins can hand-edit the catalog without
 * a Firestore write path.
 *
 * Surface lives at window.__pioneerAdmin.tabs.training:
 *   { init: wireTrainingRefresh, refresh: loadTrainingReport }
 *
 * Loaded AFTER admin/_utils.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml from __pioneerAdmin.utils
 *   • window.firebase compat SDK (firestore — collectionGroup query)
 *   • fetch() for the lesson catalog JSON
 *
 * No closure deps on admin.js — this module is self-contained.
 * No cross-tab state escape.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils) {
    throw new Error("admin/tab-training.js: admin/_utils.js must load first");
  }
  const { escapeHtml } = window.__pioneerAdmin.utils;

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  let trainingReportLoaded = false;

  async function fetchLessonCatalog() {
    try {
      const res = await fetch("data/training-lessons.json", { credentials: "same-origin" });
      if (!res.ok) throw new Error("catalog " + res.status);
      const json = await res.json();
      return (json && Array.isArray(json.lessons)) ? json.lessons : [];
    } catch (err) {
      console.warn("[admin/training] catalog fetch failed", err && err.message || err);
      return [];
    }
  }

  function statusPillHtml(status) {
    if (status === "completed")   return '<span class="training-report-cell-pill is-done">Completed</span>';
    if (status === "in_progress") return '<span class="training-report-cell-pill is-mid">In progress</span>';
    return '<span class="training-report-cell-pill is-new">' + escapeHtml(status || "—") + '</span>';
  }

  function fmtCompletedAt(row) {
    const ts = row.completedAt || row.acknowledgmentSignedAt || row.updatedAt;
    if (!ts) return "—";
    try {
      const d = ts.toDate ? ts.toDate() : (typeof ts === "string" ? new Date(ts) : null);
      if (!d || isNaN(d.getTime())) return "—";
      return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    } catch (_e) { return "—"; }
  }

  async function loadTrainingReport() {
    const loadingEl = $("training-report-loading");
    const errorEl   = $("training-report-error");
    const emptyEl   = $("training-report-empty");
    const wrapEl    = $("training-report-wrap");
    const tbodyEl   = $("training-report-tbody");
    const subEl     = $("training-report-sub");
    if (!tbodyEl) return;
    [loadingEl, errorEl, emptyEl, wrapEl].forEach(function (el) { if (el) el.hidden = true; });
    if (loadingEl) loadingEl.hidden = false;

    try {
      const [lessons, progressSnap] = await Promise.all([
        fetchLessonCatalog(),
        firebase.firestore().collectionGroup("training_progress").get()
      ]);
      const titleById = {};
      lessons.forEach(function (l) { titleById[l.id] = l.title || l.id; });

      const rows = progressSnap.docs.map(function (d) {
        const data = d.data() || {};
        const path = d.ref.path; // users/{uid}/training_progress/{lessonId}
        const m = path.match(/^users\/([^/]+)\/training_progress\/([^/]+)$/);
        const uid      = (m && m[1]) || "";
        const lessonId = (m && m[2]) || d.id;
        return {
          uid:           uid,
          lessonId:      lessonId,
          lessonTitle:   titleById[lessonId] || lessonId,
          status:        data.status || "in_progress",
          score:         (data.score == null) ? null : data.score,
          completedAt:   data.completedAt,
          acknowledgmentSignedAt: data.acknowledgmentSignedAt,
          updatedAt:     data.updatedAt,
          email:         data.email || "",
          displayName:   data.displayName || data.signedName || "",
          raw:           data
        };
      });
      // Sort: most recent first.
      rows.sort(function (a, b) {
        const ax = (a.completedAt && a.completedAt.toMillis && a.completedAt.toMillis()) ||
                   (a.updatedAt   && a.updatedAt.toMillis   && a.updatedAt.toMillis())   || 0;
        const bx = (b.completedAt && b.completedAt.toMillis && b.completedAt.toMillis()) ||
                   (b.updatedAt   && b.updatedAt.toMillis   && b.updatedAt.toMillis())   || 0;
        return bx - ax;
      });

      if (loadingEl) loadingEl.hidden = true;
      if (subEl) {
        const total     = rows.length;
        const completed = rows.filter(function (r) { return r.status === "completed"; }).length;
        subEl.textContent = total + " progress record" + (total === 1 ? "" : "s") +
                            " · " + completed + " completed";
      }
      if (!rows.length) {
        if (emptyEl) emptyEl.hidden = false;
        return;
      }

      tbodyEl.innerHTML = rows.map(function (r) {
        const who   = r.displayName ? (escapeHtml(r.displayName) + '<span class="training-report-meta">' + escapeHtml(r.email || r.uid) + '</span>')
                                    : escapeHtml(r.email || r.uid);
        const score = (r.score == null) ? "—" : (escapeHtml(String(r.score)) + "%");
        return (
          '<tr>' +
            '<td>' + who + '</td>' +
            '<td>' + escapeHtml(r.lessonTitle) +
              '<span class="training-report-meta">' + escapeHtml(r.lessonId) + '</span></td>' +
            '<td>' + statusPillHtml(r.status) + '</td>' +
            '<td>' + score + '</td>' +
            '<td>' + escapeHtml(fmtCompletedAt(r)) + '</td>' +
          '</tr>'
        );
      }).join("");
      if (wrapEl) wrapEl.hidden = false;
      trainingReportLoaded = true;
    } catch (err) {
      console.error("[admin/training] load failed", err);
      if (loadingEl) loadingEl.hidden = true;
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = (err && err.code === "permission-denied")
          ? "Permission denied. You need an admin account to view training reports."
          : ("Couldn't load training progress: " + ((err && err.message) || "unknown error"));
      }
    }
  }

  // Refresh button — re-fetches even after first paint. Invoked by
  // admin.js boot via tabs.training.init().
  function wireTrainingRefresh() {
    const btn = document.getElementById("training-report-refresh");
    if (btn) btn.addEventListener("click", function () { loadTrainingReport(); });
  }

  // Acknowledge so the IIFE-scoped flag isn't reported as unused —
  // future code may check trainingReportLoaded to skip the auto-load
  // on subsequent tab clicks.
  void trainingReportLoaded;

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.training = {
    init:    wireTrainingRefresh,
    refresh: loadTrainingReport
  };
}());
