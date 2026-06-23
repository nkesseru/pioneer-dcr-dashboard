/* Pioneer DCR Hub — Admin Tech Health tab (vanilla JS, no build).
 *
 * Tech Health — operational support dashboard (admin-only)
 *
 * NOT surveillance. NOT a public ranking. The intent is to surface
 * early signals so admins can check in with a tech who might need
 * support — and to celebrate techs who are reliably showing up +
 * helping the team.
 *
 * Last-30-day window over existing PioneerOps signals:
 *   Positive: DCRs submitted, open-shift pickups, Rockstar bonuses,
 *             5-star inspections
 *   Watch:    call-outs, over-budget DCRs, open inspection
 *             follow-ups
 *
 * Status thresholds (documented inline so the rationale is visible
 * when an admin clicks "Why?"):
 *   needs-support : ≥ 4 call-outs in last 30d
 *   watch         : ≥ 2 call-outs OR ≥ 2 over-budget DCRs
 *   stable        : default
 *
 * Phase 2 TODO:
 *   • midnight cron: incomplete shifts (Deputy ended, no DCR)
 *   • complaint/compliment linkage via dcrId
 *   • customer continuity score
 *   • trend deltas vs prior 30 days
 *   • "support check-in" workflow with manager notes
 *
 * Surface lives at window.__pioneerAdmin.tabs.techHealth:
 *   { init: wireTechHealthControls, refresh: loadTechHealth }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • __pioneerAdmin.deps.getTechs() — read live techs cache
 *   • __pioneerAdmin.deps.getDcrs()  — read live dcrs cache
 *     (both populated by admin.js boot; no new bridge entries needed)
 *   • window.firebase compat SDK (firestore — 4 parallel reads:
 *     call_outs, open_shift_requests, rockstar_bonuses, inspections)
 *
 * No cross-tab state escape: techHealthState lives inside this IIFE only.
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-tech-health.js: admin/_utils.js + admin/_shell.js must load first");
  }

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-tech-health: __pioneerAdmin.deps." + name + " not populated yet — boot order issue");
    }
    return deps[name];
  }
  const getTechs = () => depOrThrow("getTechs")();
  const getDcrs  = () => depOrThrow("getDcrs")();

  function $(id) { return document.getElementById(id); }

  /* ---------- module state ---------- */

  const TECH_HEALTH_WINDOW_DAYS = 30;

  let techHealthState  = [];      // computed per-tech metrics
  let techHealthFilter = "all";

  function techHealthMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds  === "number")   return ts.seconds * 1000;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function techHealthSetState(state, msg) {
    const ids = { loading: "tech-health-loading", error: "tech-health-error", empty: "tech-health-empty" };
    Object.keys(ids).forEach(function (k) {
      const el = $(ids[k]);
      if (el) el.hidden = (k !== state);
    });
    if (state === "error" && msg) {
      const el = $("tech-health-error");
      if (el) el.textContent = msg;
    }
  }

  async function loadTechHealth() {
    techHealthSetState("loading");
    try {
      const db = firebase.firestore();
      const sinceMs = Date.now() - TECH_HEALTH_WINDOW_DAYS * 86400000;
      const sinceTs = firebase.firestore.Timestamp.fromMillis(sinceMs);

      // Parallel queries. Each is capped so a runaway collection
      // can't blow up the dashboard.
      const [coSnap, osSnap, rbSnap, inspSnap] = await Promise.all([
        db.collection("call_outs")
          .where("submittedAt", ">=", sinceTs)
          .limit(500).get()
          .catch(function (err) { console.warn("[tech-health] call_outs read failed", err); return { docs: [] }; }),
        db.collection("open_shift_requests")
          .where("status", "==", "confirmed")
          .where("confirmedAt", ">=", sinceTs)
          .limit(300).get()
          .catch(function (err) { console.warn("[tech-health] open_shift_requests read failed", err); return { docs: [] }; }),
        db.collection("rockstar_bonuses")
          .where("earnedAt", ">=", sinceTs)
          .limit(300).get()
          .catch(function (err) { console.warn("[tech-health] rockstar_bonuses read failed", err); return { docs: [] }; }),
        db.collection("inspections")
          .where("inspected_at", ">=", sinceTs)
          .limit(500).get()
          .catch(function (err) { console.warn("[tech-health] inspections read failed", err); return { docs: [] }; })
      ]);

      // Bucket each signal by techSlug. Some signals expose techId
      // (call_outs, rockstar_bonuses, open_shift_requests) — those
      // all use the cleaning_techs slug as the ID. inspections use
      // credited_cleaning_tech_slug. DCRs come from the in-memory
      // `dcrs` cache (read via deps bridge below).
      function bucket(snap, getKey, cb) {
        const m = new Map();
        (snap.docs || []).forEach(function (d) {
          const data = d.data ? (d.data() || {}) : {};
          const key  = getKey(data);
          if (!key) return;
          if (!m.has(key)) m.set(key, { count: 0, fiveStar: 0 });
          m.get(key).count += 1;
          if (typeof cb === "function") cb(data, m.get(key));
        });
        return m;
      }
      const callOutsByTech    = bucket(coSnap,   function (d) { return d.techId; });
      const pickupsByTech     = bucket(osSnap,   function (d) { return d.acceptedByTechId; });
      const bonusesByTech     = bucket(rbSnap,   function (d) { return d.techId; });
      const inspectionsByTech = bucket(inspSnap, function (d) { return d.credited_cleaning_tech_slug || d.credited_tech_slug; }, function (d, b) {
        const score = Number(d.overall_score);
        if (!isNaN(score) && score >= 4.8) b.fiveStar += 1;
      });

      // DCRs from cache. Production over-budget signal is
      // `d.timeBudget.withinBudget === false` (set by app.js when the
      // tech reports the shift went over budget). Legacy field
      // variants are checked as fallbacks for any prior-schema docs.
      const dcrs = getDcrs();
      const dcrsByTech = new Map();
      (Array.isArray(dcrs) ? dcrs : []).forEach(function (d) {
        const ts = techHealthMs(d.submittedAt || d.submitted_at || d.createdAt);
        if (!ts || ts < sinceMs) return;
        const slug = d.tech_slug || d.techSlug || "";
        if (!slug) return;
        if (!dcrsByTech.has(slug)) dcrsByTech.set(slug, { count: 0, overBudget: 0 });
        const b = dcrsByTech.get(slug);
        b.count += 1;
        // Primary: the nested timeBudget shape app.js writes today.
        // Secondary: legacy / mirror fields the form has used.
        const overBudget =
             (d.timeBudget && d.timeBudget.withinBudget === false)
          || (d.time_budget && d.time_budget.within_budget === false)
          || d.overtimeOrOverBudget === true
          || d.overtime_or_over_budget === true
          || !!(d.overBudgetReason || d.over_budget_reason)
          || !!(d.overtimeOrOverBudgetReason || d.overtime_or_over_budget_reason);
        if (overBudget) b.overBudget += 1;
      });

      // Stitch per-tech rows. Only active techs render — archived
      // techs would otherwise add noise.
      const techs = getTechs();
      techHealthState = (techs || [])
        .filter(function (t) { return t.active !== false; })
        .map(function (t) {
          const slug = t.tech_slug || t.slug || t.id || "";
          const co   = callOutsByTech.get(slug)    || { count: 0 };
          const pu   = pickupsByTech.get(slug)     || { count: 0 };
          const rb   = bonusesByTech.get(slug)     || { count: 0 };
          const insp = inspectionsByTech.get(slug) || { count: 0, fiveStar: 0 };
          const dcr  = dcrsByTech.get(slug)        || { count: 0, overBudget: 0 };

          let status   = "stable";
          const reasons = [];
          if (co.count >= 4) {
            status = "needs-support";
            reasons.push(co.count + " call-outs in last 30 days");
          } else if (co.count >= 2) {
            status = "watch";
            reasons.push(co.count + " call-outs in last 30 days");
          }
          if (dcr.overBudget >= 2 && status === "stable") {
            status = "watch";
            reasons.push(dcr.overBudget + " over-budget DCRs in last 30 days");
          } else if (dcr.overBudget >= 2 && status === "watch") {
            reasons.push(dcr.overBudget + " over-budget DCRs in last 30 days");
          }

          return {
            tech: t,
            slug: slug,
            display_name: t.display_name || t.name || slug,
            status: status,
            reasons: reasons,
            metrics: {
              dcrs:        dcr.count,
              overBudget:  dcr.overBudget,
              callOuts:    co.count,
              pickups:     pu.count,
              rockstars:   rb.count,
              inspections: insp.count,
              fiveStar:    insp.fiveStar
            }
          };
        })
        // Sort: needs-support first, then watch, then stable. Within
        // each tier, alphabetical by display_name.
        .sort(function (a, b) {
          const order = { "needs-support": 0, "watch": 1, "stable": 2 };
          const oa = order[a.status] == null ? 3 : order[a.status];
          const ob = order[b.status] == null ? 3 : order[b.status];
          if (oa !== ob) return oa - ob;
          return String(a.display_name).localeCompare(String(b.display_name));
        });

      techHealthSetState(null);
      renderTechHealth();
    } catch (err) {
      console.error("[tech-health] load failed", err);
      techHealthSetState("error",
        err && err.code === "permission-denied"
          ? "Permission denied. Confirm you're signed in as an admin."
          : "Couldn't load tech health: " + (err && (err.message || err.code) || "unknown"));
    }
  }

  // Private 4-char escape (no single-quote escape). Equivalent in
  // practice to utils.escapeHtml for this module's call sites (all
  // attribute values live inside double-quoted strings); preserved
  // exactly to keep behavior identical to pre-extraction.
  function techHealthEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderTechHealth() {
    const listEl    = $("tech-health-list");
    const emptyEl   = $("tech-health-empty");
    const loadingEl = $("tech-health-loading");
    const errorEl   = $("tech-health-error");
    if (!listEl || !emptyEl) return;

    // Always sync the tab badge with the current flagged count.
    // Running it here (not just inside loadTechHealth) keeps the
    // badge correct after filter clicks and any future re-render,
    // and survives any stale-paint scenario from earlier turns.
    try {
      const flagged = techHealthState.filter(function (x) {
        return x.status === "watch" || x.status === "needs-support";
      }).length;
      const badge = $("tech-health-tab-badge");
      if (badge) {
        if (flagged > 0) {
          badge.textContent = String(flagged);
          badge.hidden = false;
          badge.removeAttribute("hidden");      // belt+suspenders for any older paint that left `hidden` attr stuck
        } else {
          badge.hidden = true;
          badge.setAttribute("hidden", "");
        }
      }
    } catch (_e) { /* badge is decorative; never fail render over it */ }

    // Hard-reset transient state surfaces. Defensive — every render
    // takes responsibility for hiding loading/error so a prior
    // render's loading text can never stack with the card list.
    if (loadingEl) loadingEl.hidden = true;
    if (errorEl)   errorEl.hidden   = true;

    const rows = techHealthState.filter(function (x) {
      if (techHealthFilter === "all") return true;
      return x.status === techHealthFilter;
    });

    if (!rows.length) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = techHealthFilter === "all"
        ? "No active techs to display."
        : "No techs in this status. Nice.";
      return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = rows.map(function (r) {
      const statusLabel = r.status === "needs-support" ? "Needs Support"
                        : r.status === "watch"         ? "Watch"
                        :                                "Stable";
      const statusChip =
        '<span class="th-status-chip th-status-chip--' + r.status + '">' + statusLabel + '</span>';

      // Tech avatar — photo if cleaning_techs has photoUrl, otherwise
      // a colored initial. Reuse the existing colorForSeed pattern by
      // computing here (admin.js doesn't expose colorForSeed; do a
      // tiny inline HSL hash so we get the same per-tech identity
      // color the schedule page uses).
      function colorForSlug(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
        const hue = Math.abs(h) % 360;
        return { bg: "hsl(" + hue + " 70% 92%)", ring: "hsl(" + hue + " 55% 60%)", fg: "hsl(" + hue + " 50% 28%)" };
      }
      const c = colorForSlug(r.slug || r.display_name);
      const photoUrl = (r.tech && (r.tech.photoUrl || r.tech.profilePhotoUrl)) || "";
      const initial  = (String(r.display_name).trim().charAt(0) || "?").toUpperCase();
      const avatar = photoUrl
        ? '<span class="th-avatar"><img src="' + techHealthEscape(photoUrl) + '" alt="" /></span>'
        : '<span class="th-avatar th-avatar--initial"' +
            ' style="background:' + c.bg + ';color:' + c.fg + ';border-color:' + c.ring + ';">' +
            techHealthEscape(initial) +
          '</span>';

      // Positive-first metric row. Reasons (Watch/NeedsSupport) live
      // below in a separate "what we're watching" block.
      const metricsHtml =
        '<dl class="th-metrics">' +
          '<div><dt>DCRs</dt><dd>' + r.metrics.dcrs + '</dd></div>' +
          '<div><dt>Pickups</dt><dd>' + r.metrics.pickups + '</dd></div>' +
          '<div><dt>Rockstars</dt><dd>' + r.metrics.rockstars + '</dd></div>' +
          '<div><dt>5★ insp.</dt><dd>' + r.metrics.fiveStar + '</dd></div>' +
        '</dl>';

      const watchHtml = r.reasons.length
        ? '<div class="th-watch"><span class="th-watch-label">What we\'re watching:</span> ' +
          r.reasons.map(techHealthEscape).join(" · ") +
          ' <span class="th-watch-cta">A supportive check-in might help.</span></div>'
        : '';

      return (
        '<article class="th-card th-card--' + r.status + '" role="listitem">' +
          '<header class="th-head">' +
            avatar +
            '<h3 class="th-name">' + techHealthEscape(r.display_name) + '</h3>' +
            statusChip +
          '</header>' +
          metricsHtml +
          watchHtml +
        '</article>'
      );
    }).join("");
  }

  function wireTechHealthControls() {
    document.querySelectorAll(".tech-health-pill[data-th-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        techHealthFilter = btn.dataset.thFilter || "all";
        document.querySelectorAll(".tech-health-pill").forEach(function (b) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        renderTechHealth();
      });
    });
    const refresh = $("tech-health-refresh");
    if (refresh) refresh.addEventListener("click", function () { loadTechHealth(); });
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.techHealth = {
    init:    wireTechHealthControls,
    refresh: loadTechHealth
  };
}());
