/* Pioneer DCR Hub — Cleaning Tech Hub (vanilla JS, no build).
 *
 * v1 scope (READ-ONLY):
 *   • Customer picker reads /customers directly (public read).
 *   • Per-customer view (snapshot, supply requests, recent issues, feedback,
 *     wins, ask-for-update placeholder) fetches from the techHubViewV1
 *     Cloud Function. The function reads the locked-down collections
 *     (supply_requests, dcr_submissions) via Admin SDK and returns a
 *     tech-safe scrubbed payload — admin_notes / costing / employee
 *     performance metrics are stripped before they leave Firestore.
 *
 * Future-ready hooks (NOT WIRED in v1):
 *   • Per-tech login + personalized dashboard. Firebase Auth tier separate
 *     from the admin allowlist — anonymous-with-claim or email/password.
 *   • AI briefings ("here's what to watch for tonight at Acme Dental").
 *   • Live supply-update request workflow. The Ask-for-Update button currently
 *     pops a "coming soon" toast; v2 will route to a Cloud Function that
 *     creates a comment thread on the open supply_request.
 *   • Streaks, badges, customer-briefing summaries — additive sections that
 *     plug into the same renderer pattern below.
 */
(function () {
  "use strict";

  // Labels MUST match the admin tab so techs and the office see identical
  // wording for the same workflow stage. Internal status values are unchanged.
  const STATUS_LABELS = {
    new:                "New",
    reviewed:           "Reviewed by PCC",
    customer_contacted: "Customer Notified",
    ordered:            "Ordered by Pioneer Commercial Cleaning",
    closed:             "Closed / Received"
  };

  /* ---------- DOM helpers ---------- */
  const $  = function (id) { return document.getElementById(id); };
  const $$ = function (sel, root) { return Array.from((root || document).querySelectorAll(sel)); };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showToast(msg) {
    const el = $("tech-toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add("is-shown"); });
    setTimeout(function () {
      el.classList.remove("is-shown");
      setTimeout(function () { el.hidden = true; }, 320);
    }, 2800);
  }

  function showFetchError(msg) {
    const el = $("tech-fetch-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideFetchError() {
    const el = $("tech-fetch-error");
    if (el) el.hidden = true;
  }

  function showContent(show) {
    const el = $("tech-content");
    if (el) el.hidden = !show;
  }
  function showLoading(show) {
    const el = $("tech-loading");
    if (el) el.hidden = !show;
  }

  /* ---------- defensive customer accessors (mirrors form-side) ---------- */
  function getCustomerName(c)     { return c.customer_name || c.name || c.display_name || ""; }
  function getCustomerSlug(c)     { return c.customer_slug || c.slug || c.id || ""; }
  function getCustomerLocation(c) { return c.location_name || c.location || ""; }
  function getCustomerActive(c)     { return c.active     !== false; }
  function getCustomerDcrEnabled(c) { return c.dcr_enabled !== false; }

  function customerDisplayLabel(c) {
    // Canonical helper — applies displayNameMode + customDisplayName.
    if (window.PioneerCustomerDisplay) {
      const label = window.PioneerCustomerDisplay.getCustomerDisplayName(c);
      if (label) return label;
    }
    return getCustomerName(c) || getCustomerLocation(c) || getCustomerSlug(c) || "(unnamed)";
  }

  /* ---------- Firebase init (firestore only — auth not needed in v1) ---------- */
  if (!window.FIREBASE_CONFIG || !window.firebase) {
    showFetchError("Firebase SDK or config missing. Copy firebase-config.example.js to firebase-config.js and fill it in.");
    return;
  }
  if (typeof firebase.firestore !== "function") {
    showFetchError("Firestore SDK didn't load. Hard-reload the page (Cmd+Shift+R).");
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  const db = firebase.firestore();

  /* ---------- 1. Load active customers ---------- */
  // `staff` is the authorized identity from STAFF_AUTH. When the user is a
  // cleaning_tech we filter the dropdown to their per-tech
  // assigned_customer_slugs. Admins see everything (so the office can
  // still demo or troubleshoot from the same UI).
  async function loadCustomers(staff) {
    const select = $("tech-customer-select");
    try {
      const snap = await db.collection("customers").get();
      let customers = snap.docs
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (c) { return getCustomerActive(c) && getCustomerDcrEnabled(c); });

      let restrictedEmptyForTech = false;
      if (staff && staff.role === "cleaning_tech") {
        const assigned = (staff.tech && Array.isArray(staff.tech.assigned_customer_slugs))
          ? staff.tech.assigned_customer_slugs.map(function (s) { return String(s || "").toLowerCase().trim(); })
          : [];
        const allow = new Set(assigned.filter(Boolean));
        customers = customers.filter(function (c) {
          return allow.has(String(getCustomerSlug(c) || "").toLowerCase().trim());
        });
        if (customers.length === 0) restrictedEmptyForTech = true;
      }

      customers.sort(function (a, b) {
        return customerDisplayLabel(a).localeCompare(customerDisplayLabel(b));
      });

      if (customers.length === 0) {
        if (restrictedEmptyForTech) {
          select.innerHTML = '<option value="" disabled selected>— No assigned locations yet —</option>';
          select.disabled = true;
          showFetchError("No assigned locations yet — email info@pioneercomclean.com to get locations assigned.");
        } else {
          select.innerHTML = '<option value="" disabled selected>— No active customers yet —</option>';
          select.disabled = true;
        }
        return;
      }

      select.innerHTML = '<option value="" disabled selected>— Choose your customer —</option>';
      customers.forEach(function (c) {
        const o = document.createElement("option");
        o.value = getCustomerSlug(c);
        o.textContent = customerDisplayLabel(c);
        select.appendChild(o);
      });
      select.disabled = false;
    } catch (err) {
      console.error("loadCustomers failed", err);
      select.innerHTML = '<option value="" disabled selected>— Couldn\'t load. Refresh the page. —</option>';
      select.disabled = true;
      showFetchError("Couldn't load the customer list. Refresh the page and try again. (" +
                     ((err && err.code) || (err && err.message) || "unknown") + ")");
    }
  }

  /* ---------- 2. Fetch tech-hub view from the function ---------- */
  async function fetchTechHubView(customerSlug) {
    const base = (window.TECH_HUB_VIEW_URL || "").trim();
    if (!base || /REPLACE_WITH/.test(base)) {
      throw new Error(
        "TECH_HUB_VIEW_URL is not configured in firebase-config.js. " +
        "Deploy the techHubViewV1 function and paste its URL into firebase-config.js."
      );
    }
    const url = base + (base.indexOf("?") >= 0 ? "&" : "?") +
                "customer_slug=" + encodeURIComponent(customerSlug);
    // Attach the current staff ID token. The function rejects without it.
    const idToken = window.STAFF_AUTH && await window.STAFF_AUTH.getIdToken();
    if (!idToken) throw new Error("Not signed in. Refresh the page and sign in again.");
    const res = await fetch(url, {
      method:  "GET",
      headers: { "Authorization": "Bearer " + idToken }
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body.ok) {
      const msg = (body && body.error) || ("Server returned " + res.status);
      throw new Error(msg);
    }
    return body;
  }

  /* ---------- 3. Render snapshot card ---------- */
  function renderSnapshot(data) {
    const customer = data.customer || {};
    const stats    = data.stats    || {};

    const name     = (window.PioneerCustomerDisplay && window.PioneerCustomerDisplay.getCustomerDisplayName(customer))
                       || customer.customer_name || customer.name || "(no customer)";
    const location = customer.location_name || name;
    $("tech-customer-name").textContent     = name;
    $("tech-customer-location").textContent = (location !== name) ? location : "";

    // Badges — DCR email + archived state + (optionally) an open
    // service-recovery pill so the tech knows the office is already
    // following up on something for this customer.
    const badges = [];
    if (customer.dcr_email_enabled !== false) {
      badges.push('<span class="tech-badge is-on">DCR email on</span>');
    } else {
      badges.push('<span class="tech-badge is-off">DCR email off</span>');
    }
    if (customer.active === false) {
      badges.push('<span class="tech-badge is-archived">Archived</span>');
    }
    const q = data.quality || null;
    if (q && q.has_open_service_recovery) {
      const n = q.open_service_recovery_count || 1;
      badges.push(
        '<span class="tech-badge is-recovery"' +
          ' title="The office has at least one open Service Recovery for this customer.">' +
          '🛠 Service Recovery Needed' +
          (n > 1 ? ' · ' + n : '') +
        '</span>'
      );
    }
    $("tech-snapshot-badges").innerHTML = badges.join("");

    $("stat-supply").textContent   = String(stats.open_supply_requests || 0);
    $("stat-issues").textContent   = String(stats.open_issues_30d      || 0);
    $("stat-last-clean").textContent = stats.last_clean_date || "—";
    $("stat-feedback").textContent = String((data.feedback || []).length || 0);

    // "Last inspected" — formatted via the local quality helper so
    // we don't pull in a heavier date lib.
    const lastInspEl = $("stat-last-inspected");
    if (lastInspEl) lastInspEl.textContent = q ? qualityFormatDate(q.last_inspection_at) : "—";

    // Budget tile — supportive copy. Server returns:
    //   { last_clean: "on"|"over"|"unknown", current_month: {pct, on, total} | null }
    // We render headline + sub-line. Defensive null-checks throughout
    // so a missing server field (older function build) just shows "—".
    const budget = data.budget || null;
    const lastEl  = $("stat-budget-last");
    const monthEl = $("stat-budget-month");
    if (lastEl && monthEl) {
      const lc = budget && budget.last_clean;
      if (lc === "on") {
        lastEl.textContent = "On Budget";
        lastEl.classList.remove("is-over"); lastEl.classList.add("is-on");
      } else if (lc === "over") {
        lastEl.textContent = "Over Budget";
        lastEl.classList.remove("is-on");   lastEl.classList.add("is-over");
      } else {
        lastEl.textContent = "—";
        lastEl.classList.remove("is-on", "is-over");
      }

      const mtd = budget && budget.current_month;
      if (mtd && typeof mtd.pct === "number") {
        // Supportive phrasing — celebrate strong months, stay factual
        // (not punitive) when low.
        if (mtd.pct >= 85) {
          monthEl.textContent = "This month · " + mtd.pct + "% on budget — strong work";
        } else {
          monthEl.textContent = "This month · " + mtd.pct + "% on budget";
        }
      } else {
        monthEl.textContent = "Budget · this month —";
      }
    }
  }

  /* ---------- 4. Render open supply requests ---------- */
  function formatShortDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const opts = { month: "short", day: "numeric", year: "numeric" };
      return d.toLocaleDateString(undefined, opts);
    } catch (e) { return ""; }
  }

  function renderSupplyList(list) {
    const root = $("tech-supply-list");
    const empty = $("tech-supply-empty");
    if (!root) return;
    root.innerHTML = "";

    if (!list || list.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    const html = list.map(function (r) {
      const status = r.status || "new";
      const statusLabel = STATUS_LABELS[status] || status;
      const meta = [];
      if (r.created_at)   meta.push('<span>Created <strong>' + escapeHtml(formatShortDate(r.created_at)) + '</strong></span>');
      if (r.vendor)       meta.push('<span>Vendor <strong>' + escapeHtml(r.vendor) + '</strong></span>');
      if (r.order_number) meta.push('<span>Order # <strong>' + escapeHtml(r.order_number) + '</strong></span>');
      // V6 pilot — "Ask Kirby for update" nudge. Per-row button so a
      // tech can ping the office about a specific supply request
      // without firing a generic catch-all message. Hidden after the
      // click; the toast confirms what landed in Firestore.
      const supplyId = String(r.id || r.supply_request_id || "");
      const nudgeBtn = supplyId
        ? '<button type="button" class="tech-supply-nudge" ' +
            'data-action="ask-kirby-update" ' +
            'data-supply-id="' + escapeHtml(supplyId) + '" ' +
            'data-customer-id="' + escapeHtml(r.customer_slug || r.customer_id || "") + '" ' +
            'title="Send Kirby a notification asking for a status update on this request">' +
            'Ask Kirby for update' +
          '</button>'
        : '';
      return (
        '<div class="tech-supply-row" data-supply-id="' + escapeHtml(supplyId) + '">' +
          '<div>' +
            '<div class="row-items">' + escapeHtml(r.requested_items || "(no items listed)") + '</div>' +
            (meta.length ? '<div class="row-meta">' + meta.join("") + '</div>' : '') +
            nudgeBtn +
          '</div>' +
          '<span class="row-status">' +
            '<span class="tech-status status-' + status + '">' + escapeHtml(statusLabel) + '</span>' +
          '</span>' +
        '</div>'
      );
    }).join("");

    root.innerHTML = html;
  }

  // V6 pilot — handler for the "Ask Kirby for update" button.
  // Creates ONE doc in `notifications/{autoId}` with the spec field
  // shape PLUS the standard notification fields so the office triage
  // view picks it up alongside other priority items. Idempotent
  // per-button (we disable the button on success so the same request
  // can't double-fire); rate-limited by the natural UI flow.
  async function askKirbyForUpdate(opts) {
    const supplyId   = String(opts.supplyId || "").trim();
    const customerId = String(opts.customerId || "").trim();
    const btn        = opts.btn;
    if (!supplyId) {
      showToast("Couldn't find the supply request id. Refresh and try again.");
      return;
    }
    const staff = window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff && window.STAFF_AUTH.getCurrentStaff();
    if (!staff || !staff.email) {
      showToast("You appear to be signed out. Refresh and sign in again.");
      return;
    }
    const techSlug = (staff.tech && (staff.tech.slug || staff.tech.tech_slug)) || "";
    const techDisplayName = (staff.tech && staff.tech.display_name) || "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sending…";
    }
    try {
      const db = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("notifications").add({
        // V6 spec fields (camelCase per the user-supplied shape) ----
        type:               "supply_update_request",
        supplyRequestId:    supplyId,
        customerId:         customerId || null,
        techId:             techSlug || null,
        requestedBy:        String(staff.email || "").toLowerCase().trim(),
        requestedAt:        sts,
        status:             "update_requested",
        // ---- Standard notification fields ----
        // Mirrors the existing customer-complaint/quality_win shape so
        // the office Today's Operations + notifications inbox picks
        // this up alongside other items.
        priority:           "medium",
        audience:           ["office_manager"],
        assignedRoles:      ["office_manager"],
        assignedUsers:      ["kirby"],
        title:              "Supply request update asked for",
        message:            (techDisplayName || "A tech") + " is asking Kirby for an update on supply request " + supplyId,
        requiresAction:     true,
        celebration:        false,
        read:               false,
        linkedCollection:   "supply_requests",
        linkedDocId:        supplyId,
        techDisplayName:    techDisplayName || null,
        createdAt:          sts
      });
      showToast("Update requested — Kirby will see this.");
      if (btn) btn.textContent = "Requested ✓";
    } catch (err) {
      console.error("[tech-supply] Ask-Kirby write failed", err && err.code, err && err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Ask Kirby for update";
      }
      showToast(err && err.code === "permission-denied"
        ? "Permission denied. Make sure you're signed in."
        : "Couldn't send. Check your connection and try again.");
    }
  }

  // Single delegated click listener — wired ONCE on boot per the
  // pattern used by tech-notes-list. Subsequent renderSupplyList
  // calls just replace the row HTML; the listener attached to the
  // list root keeps working.
  let _supplyListWired = false;
  function wireSupplyListNudge() {
    if (_supplyListWired) return;
    const list = $("tech-supply-list");
    if (!list) return;
    list.addEventListener("click", function (ev) {
      const btn = ev.target.closest('[data-action="ask-kirby-update"]');
      if (!btn) return;
      askKirbyForUpdate({
        supplyId:   btn.dataset.supplyId,
        customerId: btn.dataset.customerId,
        btn:        btn
      });
    });
    _supplyListWired = true;
  }

  /* ---------- 5. Render recent issues ---------- */
  function renderIssuesList(list) {
    const root = $("tech-issues-list");
    const empty = $("tech-issues-empty");
    if (!root) return;
    root.innerHTML = "";

    if (!list || list.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    const html = list.map(function (i) {
      const where = [i.section_label, i.item_label].filter(Boolean).join(" · ");
      const techBit = i.tech_display_name ? 'Logged by ' + escapeHtml(i.tech_display_name) : '';
      const locBit  = i.location ? ' &middot; ' + escapeHtml(i.location) : '';
      return (
        '<div class="tech-issue-row">' +
          '<div class="row-head">' +
            '<span class="row-where">' + escapeHtml(where || "(no location)") + '</span>' +
            '<span class="row-when">' + escapeHtml(i.clean_date || "") + '</span>' +
          '</div>' +
          (i.note ? '<p class="row-note">' + escapeHtml(i.note) + '</p>' : '') +
          (techBit || locBit
            ? '<p class="row-tech">' + techBit + locBit + '</p>'
            : '') +
        '</div>'
      );
    }).join("");

    root.innerHTML = html;
  }

  /* ---------- 6. Render feedback ----------
   * V6 pilot: the whole `Recent Positive Feedback` section is hidden
   * by default in tech.html. Unhide ONLY when we have real items to
   * show — an empty state on a tech page reads as noise. If a future
   * build wants to show "we know it's a slow week" empty-state copy,
   * flip the conditional below. */
  function renderFeedbackList(list) {
    const root    = $("tech-feedback-list");
    const empty   = $("tech-feedback-empty");
    const section = $("tech-feedback-section");
    if (!root) return;
    root.innerHTML = "";

    if (!list || list.length === 0) {
      // Keep the section hidden during pilot.
      if (section) section.hidden = true;
      if (empty)   empty.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    if (empty)   empty.hidden = true;

    const html = list.map(function (f) {
      return (
        '<div class="tech-feedback-row">' +
          '<div class="row-rating">★ ' + escapeHtml(String(f.rating || "")) + '</div>' +
          (f.comment ? '<p class="row-comment">' + escapeHtml(f.comment) + '</p>' : '') +
          (f.clean_date ? '<p class="row-tech">' + escapeHtml(f.clean_date) + '</p>' : '') +
        '</div>'
      );
    }).join("");

    root.innerHTML = html;
  }

  /* ---------- 7. Wins / recognition (v1 placeholder only) ---------- */
  // Intentionally static for v1 — see the file header for the v2 plan
  // (streaks, badges, AI briefings). Hooking the real data later is just
  // calling `renderWinsList(data.wins || [])` from `renderAll()`.

  /* ---------- 8. "Ask for Update" button ---------- */
  function wireAskBtn() {
    const btn = $("tech-ask-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      showToast("Update request feature coming soon.");
    });
  }

  /* ---------- 8.4 Customer Quality (per-customer) ---------- */

  function qualityToneForScore(score) {
    const s = typeof score === "number" ? score : 3;
    if (s >= 4.5) return "tone-5";
    if (s >= 3.5) return "tone-4";
    if (s >= 2.5) return "tone-3";
    if (s >= 1.5) return "tone-2";
    return "tone-1";
  }
  function qualityLabelForScore(score) {
    if (score == null) return "Awaiting first inspection";
    if (score >= 4.5) return "Excellent · " + score.toFixed(1);
    if (score >= 3.5) return "Great · " + score.toFixed(1);
    if (score >= 2.5) return "Acceptable · " + score.toFixed(1);
    if (score >= 1.5) return "Needs work · " + score.toFixed(1);
    return "Critical · " + score.toFixed(1);
  }
  function qualityFormatDate(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
    } catch (e) { return "—"; }
  }
  function qualityEscape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderQualityTile(quality) {
    const tile = $("tech-quality-tile");
    if (!tile) return;
    const value = $("tech-quality-value");
    const label = $("tech-quality-label");
    const sub   = $("tech-quality-sub");

    // Always reveal the tile so the empty state reads as a baseline,
    // not a missing section. Empty state copy comes from the score
    // label + sub line.
    tile.hidden = false;

    if (!quality || quality.overall_score == null) {
      if (value) value.textContent = "—";
      if (label) label.textContent = "Awaiting first inspection";
      if (sub)   sub.textContent   = "First inspection will create this customer's quality baseline.";
      tile.setAttribute("data-tone", "tone-3");
      return;
    }
    const rolling = quality.overall_score;
    if (value) value.textContent = rolling.toFixed(1);
    if (label) label.textContent = qualityLabelForScore(rolling);
    if (sub)   sub.textContent   =
      "Rolling " + (quality.window_days || 30) + "-day average · " +
      (quality.count || 0) + " inspection" + ((quality.count || 0) === 1 ? "" : "s");
    tile.setAttribute("data-tone", qualityToneForScore(rolling));
  }

  // Render the per-customer streak chip inside the quality tile. Hides
  // when streak is 0 (we don't want to broadcast "0 in a row").
  function renderCustomerStreak(quality) {
    const el = $("tech-quality-streak");
    if (!el) return;
    const streak = quality && typeof quality.customer_streak === "number" ? quality.customer_streak : 0;
    if (streak <= 0) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.innerHTML = '<span aria-hidden="true">🔥</span> ' +
      streak + ' in a row above ' +
      (quality.streak_threshold || 4.5).toFixed(1);
  }

  /* ---------- 8.45 Customer Health ----------
     Composite signal from existing data points. Formula (all values
     clamped to 0–5):
       base   = quality.overall_score || 4.0 (neutral default if no insp)
       open_supply_penalty   = min(0.5, 0.1 * open_supply)
       open_issues_penalty   = min(0.5, 0.1 * open_issues_30d)
       complaints_penalty    = min(1.0, 0.3 * count(recent_issues with section_label === "Problem reported"))
       service_recov_penalty = min(1.0, 0.3 * open_service_recovery_count)
       health = max(0, min(5, base - sum-of-penalties))

     This is deliberately gentle — a healthy customer with two open
     supply requests still reads as "Steady", not "Attention". The
     intent is operational signal, not a witch-hunt. */
  function computeHealthScore(data) {
    const q     = data.quality || {};
    const stats = data.stats   || {};
    const base  = (typeof q.overall_score === "number") ? q.overall_score : 4.0;

    const openSupply   = Number(stats.open_supply_requests || 0);
    const openIssues   = Number(stats.open_issues_30d      || 0);
    const complaints   = (data.recent_issues || []).filter(function (r) {
      return r && r.section_label === "Problem reported";
    }).length;
    const openSR = Number(q.open_service_recovery_count || 0);

    const supplyPenalty   = Math.min(0.5, 0.1 * openSupply);
    const issuesPenalty   = Math.min(0.5, 0.1 * openIssues);
    const complaintPenalty = Math.min(1.0, 0.3 * complaints);
    const srPenalty       = Math.min(1.0, 0.3 * openSR);

    const total = base - supplyPenalty - issuesPenalty - complaintPenalty - srPenalty;
    const clamped = Math.max(0, Math.min(5, total));
    return {
      score:               Math.round(clamped * 10) / 10,
      has_quality_base:    typeof q.overall_score === "number",
      penalties: {
        open_supply: openSupply,    open_supply_penalty:   supplyPenalty,
        open_issues: openIssues,    open_issues_penalty:   issuesPenalty,
        complaints:  complaints,    complaints_penalty:    complaintPenalty,
        open_sr:     openSR,        open_sr_penalty:       srPenalty
      }
    };
  }

  function healthLabel(score) {
    if (score >= 4.5) return "Healthy";
    if (score >= 3.5) return "Steady";
    if (score >= 2.5) return "Attention";
    return "Needs care";
  }

  function renderHealthCard(data) {
    const card    = $("tech-health-card");
    const scoreEl = $("tech-health-score");
    const labelEl = $("tech-health-label");
    const signals = $("tech-health-signals");
    if (!card || !scoreEl || !labelEl || !signals) return;
    card.hidden = false;

    const h = computeHealthScore(data);
    scoreEl.textContent = h.score.toFixed(1);
    labelEl.textContent = h.has_quality_base
      ? healthLabel(h.score)
      : (h.score >= 4.0 ? "Steady — no inspection baseline yet" : "Needs care");
    card.setAttribute("data-tone", qualityToneForScore(h.score));

    // Signals list — only what's non-zero. Keeps card compact when
    // everything is fine. We DO NOT include the inspector / coaching
    // context here.
    const bits = [];
    const p = h.penalties;
    if (p.open_supply > 0)   bits.push('<li>' + p.open_supply + ' open supply request' + (p.open_supply === 1 ? '' : 's') + '</li>');
    if (p.open_issues > 0)   bits.push('<li>' + p.open_issues + ' open issue' + (p.open_issues === 1 ? '' : 's') + ' (30d)</li>');
    if (p.complaints > 0)    bits.push('<li>' + p.complaints + ' recent complaint' + (p.complaints === 1 ? '' : 's') + '</li>');
    if (p.open_sr > 0)       bits.push('<li>' + p.open_sr + ' open service recovery</li>');
    if (bits.length === 0)   bits.push('<li class="tech-health-signal-good">No open items — clean slate.</li>');
    signals.innerHTML = bits.join("");
  }

  function renderRecentInspections(quality) {
    const root  = $("tech-recent-insp-list");
    const empty = $("tech-recent-insp-empty");
    if (!root || !empty) return;

    const list = quality && Array.isArray(quality.recent_inspections)
      ? quality.recent_inspections
      : [];

    if (list.length === 0) {
      root.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    root.innerHTML = list.map(function (insp) {
      const score = typeof insp.overall_score === "number" ? insp.overall_score : null;
      const tone  = qualityToneForScore(score == null ? 0 : score);
      const date  = insp.inspection_date || "";

      // Celebration copy for 5-star wins. Replaces the low-areas
      // callout — public surface never shows blame and a 5-star
      // row never carries one.
      let summary = "";
      if (insp.is_five_star) {
        summary =
          '<div class="tech-recent-insp-celebrate">' +
            '<span aria-hidden="true">🌟</span> 5-star inspection — nice work, team.' +
          '</div>';
      } else if (Array.isArray(insp.low_areas) && insp.low_areas.length) {
        summary =
          '<div class="tech-recent-insp-attention">' +
            '<strong>Areas needing attention:</strong> ' +
            qualityEscape(insp.low_areas.join(" · ")) +
          '</div>';
      }

      return (
        '<div class="tech-recent-insp-row" role="listitem">' +
          '<div class="tech-recent-insp-score is-' + qualityEscape(tone) + '">' +
            (score != null ? score.toFixed(1) : "—") +
          '</div>' +
          '<div class="tech-recent-insp-body">' +
            '<p class="tech-recent-insp-date">' + qualityEscape(qualityFormatDate(date)) + '</p>' +
            summary +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  /* ---------- 8.5 Important Cleaning Notes ---------- */

  // Categories — kept in sync with the admin Note modal options.
  const NOTE_CATEGORY_LABELS = {
    "Security":           "🛡 Security",
    "Access":             "🔑 Access",
    "Cleaning Preference":"🧴 Cleaning preference",
    "Sensitive Area":     "⚠ Sensitive area",
    "Equipment":          "🛠 Equipment",
    "Customer Request":   "💬 Customer request",
    "Other":              "📌 Note"
  };

  function escapeHtmlNote(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatNoteDate(iso) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric"
      }).format(new Date(iso));
    } catch (e) { return ""; }
  }

  // Render one note card.
  function noteCardHtml(n) {
    const catLabel = NOTE_CATEGORY_LABELS[n.category] || NOTE_CATEGORY_LABELS["Other"];
    const updatedBy   = n.updated_by || "office";
    const updatedDate = formatNoteDate(n.updated_at);
    const reviewedDate = n.last_reviewed_at ? formatNoteDate(n.last_reviewed_at) : "";

    // Footer line — combines "Updated by … on …" with the optional
    // "Last reviewed …" stamp. Both are informational.
    const metaParts = [];
    if (updatedBy || updatedDate) {
      metaParts.push("Updated by " + escapeHtmlNote(updatedBy) +
                     (updatedDate ? " on " + escapeHtmlNote(updatedDate) : ""));
    }
    if (reviewedDate) {
      metaParts.push("Last reviewed " + escapeHtmlNote(reviewedDate));
    }

    return (
      '<article class="tech-note-card" role="listitem" data-id="' + escapeHtmlNote(n.id) + '">' +
        '<header class="tech-note-head">' +
          '<span class="tech-note-cat">' + escapeHtmlNote(catLabel) + '</span>' +
          '<button type="button" class="tech-note-suggest"' +
            ' data-action="suggest-edit"' +
            ' data-note-id="' + escapeHtmlNote(n.id) + '">' +
            'Suggest update' +
          '</button>' +
        '</header>' +
        '<h3 class="tech-note-title">' + escapeHtmlNote(n.title || "(untitled)") + '</h3>' +
        '<p class="tech-note-body">' + escapeHtmlNote(n.body || "") + '</p>' +
        (metaParts.length
          ? '<p class="tech-note-meta">' + metaParts.join(" · ") + '</p>'
          : '') +
      '</article>'
    );
  }

  // Module state for the suggest modal — the renderer caches notes so
  // the click handler can resolve `data-note-id` back to a real note
  // without re-fetching.
  let currentCustomerSlugForNotes = "";
  let currentNotesById            = {};

  function renderCustomerNotes(notes, customerSlug) {
    const root  = $("tech-notes-list");
    const empty = $("tech-notes-empty");
    const label = $("tech-notes-list-label");
    if (!root || !empty) return;

    currentCustomerSlugForNotes = customerSlug || "";
    currentNotesById = {};
    (notes || []).forEach(function (n) { currentNotesById[n.id] = n; });

    if (!notes || notes.length === 0) {
      root.innerHTML = "";
      empty.hidden = false;
      if (label) label.hidden = true;
      return;
    }
    empty.hidden = true;
    if (label) label.hidden = false;
    root.innerHTML = notes.map(noteCardHtml).join("");
  }

  /* ---------- Suggest Update modal ---------- */

  function openSuggestModal(mode, opts) {
    const modal     = $("tech-suggest-modal");
    const titleEl   = $("tech-suggest-title");
    const ctxEl     = $("tech-suggest-context");
    const existingEl = $("tech-suggest-existing");
    const existingTitle = $("tech-suggest-existing-title");
    const existingBody  = $("tech-suggest-existing-body");
    const textEl    = $("tech-suggest-text");
    const errEl     = $("tech-suggest-err");
    const saveBtn   = $("tech-suggest-save");
    if (!modal || !textEl) return;

    textEl.value = "";
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Send suggestion"; }

    if (mode === "edit" && opts && opts.note) {
      if (titleEl) titleEl.textContent = "Suggest changes to this note";
      if (ctxEl)   ctxEl.textContent   = "Your suggestion will be sent to the office. The note below stays as-is until they approve.";
      if (existingEl) {
        existingEl.hidden = false;
        if (existingTitle) existingTitle.textContent = opts.note.title || "(untitled)";
        if (existingBody)  existingBody.textContent  = opts.note.body  || "";
      }
      // Stash on the modal element so the save handler can read them.
      modal.dataset.mode = "edit";
      modal.dataset.noteId = opts.note.id || "";
    } else {
      if (titleEl) titleEl.textContent = "Suggest a new note";
      if (ctxEl)   ctxEl.textContent   = "Describe what the office should add to this customer's standing notes. They'll review and post it if it looks good.";
      if (existingEl) existingEl.hidden = true;
      modal.dataset.mode = "new";
      modal.dataset.noteId = "";
    }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(function () { textEl.focus(); }, 60);
  }

  function closeSuggestModal() {
    const modal = $("tech-suggest-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  async function saveSuggestion() {
    const modal   = $("tech-suggest-modal");
    const textEl  = $("tech-suggest-text");
    const errEl   = $("tech-suggest-err");
    const saveBtn = $("tech-suggest-save");
    if (!modal || !textEl) return;

    const text = String(textEl.value || "").trim();
    if (!text) {
      if (errEl) { errEl.hidden = false; errEl.textContent = "Please describe your suggestion before sending."; }
      textEl.focus();
      return;
    }
    if (!currentCustomerSlugForNotes) {
      if (errEl) { errEl.hidden = false; errEl.textContent = "Lost the customer context — refresh the page and try again."; }
      return;
    }

    const staff = window.STAFF_AUTH && window.STAFF_AUTH.getCurrentStaff && window.STAFF_AUTH.getCurrentStaff();
    if (!staff || !staff.uid || !staff.email) {
      if (errEl) { errEl.hidden = false; errEl.textContent = "You appear to be signed out. Refresh and sign in again."; }
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Sending…";

    try {
      const db = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const payload = {
        customer_slug:            currentCustomerSlugForNotes,
        existing_note_id:         modal.dataset.noteId || null,
        suggested_change:         text,
        status:                   "pending",
        suggested_by:             String(staff.email || "").toLowerCase().trim(),
        suggested_by_uid:         staff.uid,
        suggested_by_display_name: (staff.tech && staff.tech.display_name) || "",
        created_at:               sts,
        reviewed_by:              null,
        reviewed_at:              null,
        review_notes:             null
      };
      await db.collection("customer_note_suggestions").add(payload);
      closeSuggestModal();
      showToast("Suggestion sent. The office will review.");
    } catch (err) {
      console.error("[tech-notes] save suggestion failed", err);
      const msg = (err && err.code === "permission-denied")
        ? "Permission denied. Make sure you're signed in."
        : "Couldn't send suggestion. Check your connection and try again.";
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
      saveBtn.disabled = false;
      saveBtn.textContent = "Send suggestion";
    }
  }

  function wireSuggestModal() {
    // Backdrop / close button.
    const modal = $("tech-suggest-modal");
    if (modal) {
      modal.querySelectorAll("[data-modal-close]").forEach(function (el) {
        el.addEventListener("click", closeSuggestModal);
      });
    }
    // Save button.
    const saveBtn = $("tech-suggest-save");
    if (saveBtn) saveBtn.addEventListener("click", saveSuggestion);
    // Escape key while modal is open.
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      const m = $("tech-suggest-modal");
      if (m && !m.hidden) closeSuggestModal();
    });
    // Section-level "Suggest update" button (compose new).
    const newBtn = $("tech-notes-suggest-new");
    if (newBtn) newBtn.addEventListener("click", function () {
      if (!currentCustomerSlugForNotes) {
        showToast("Pick a customer first.");
        return;
      }
      openSuggestModal("new");
    });
    // Per-card "Suggest update" — event-delegated on the list.
    const list = $("tech-notes-list");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest('[data-action="suggest-edit"]');
        if (!btn) return;
        const id = btn.dataset.noteId;
        const note = id && currentNotesById[id];
        if (!note) return;
        openSuggestModal("edit", { note: note });
      });
    }
  }

  /* ---------- 9. Master render after fetch ---------- */
  function renderAll(data) {
    renderSnapshot(data);
    renderQualityTile(data.quality || null);
    renderCustomerStreak(data.quality || null);
    renderHealthCard(data);
    renderCustomerNotes(data.customer_notes || [], (data.customer && data.customer.slug) || "");
    renderRecentInspections(data.quality || null);
    renderSupplyList(data.supply_requests || []);
    renderIssuesList(data.recent_issues || []);
    renderFeedbackList(data.feedback || []);
    renderSecurityInfo(data.customer || null);
    renderSopBlock(data.customer || null);
    showContent(true);
  }

  // ---------- Security Info (tech-approved, whitelist) ----------
  // Reads the `securityInfo` object that techHubViewV1 forwards from
  // customer_secure/{slug}. The server-side whitelist already strips
  // raw notes / emergency contacts / admin metadata, so this renderer
  // can trust everything it gets is safe for tech display.
  // The launcher card stays hidden unless securityInfo.hasInfo is true.
  // The modal body is populated lazily on open so we don't repaint
  // unused DOM every time the customer changes.
  let _securityInfoPending = null;     // customer obj waiting for open
  let _securityLastFocusEl = null;     // restore focus on close

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderSecurityInfo(customer) {
    const launcher = document.getElementById("tech-security-launcher");
    if (!launcher) return;
    const info = customer && customer.securityInfo;
    if (!info || info.hasInfo !== true) {
      launcher.hidden = true;
      _securityInfoPending = null;
      return;
    }
    _securityInfoPending = customer;
    launcher.hidden = false;
  }

  function buildSecurityModalBody(info) {
    function block(label, values) {
      if (!Array.isArray(values) || !values.length) return "";
      const items = values.map(function (v) {
        return '<li class="tech-security-code">' + escapeHtml(v) + '</li>';
      }).join("");
      return (
        '<section class="tech-security-block">' +
          '<div class="tech-security-block-label">' + escapeHtml(label) + '</div>' +
          '<ul class="tech-security-block-list">' + items + '</ul>' +
        '</section>'
      );
    }
    function notesBlock(label, values) {
      if (!Array.isArray(values) || !values.length) return "";
      const items = values.map(function (v) {
        return '<li class="tech-security-note">' + escapeHtml(v) + '</li>';
      }).join("");
      return (
        '<section class="tech-security-block tech-security-block-notes">' +
          '<div class="tech-security-block-label">' + escapeHtml(label) + '</div>' +
          '<ul class="tech-security-block-list">' + items + '</ul>' +
        '</section>'
      );
    }
    // Order matters: alarm first because it's usually the timed one.
    return (
      block("Alarm Code",     info.alarmCodes) +
      block("Door Code",      info.doorCodes) +
      block("Gate Code",      info.gateCodes) +
      block("Fob / Key Info", (info.fobCodes || []).concat(info.keyNotes || [])) +
      notesBlock("Security Instructions", info.securityInstructions)
    );
  }

  function openSecurityModal() {
    const modal     = document.getElementById("tech-security-modal");
    const body      = document.getElementById("tech-security-body");
    const customer  = document.getElementById("tech-security-customer");
    if (!modal || !body || !_securityInfoPending) return;
    const c    = _securityInfoPending;
    const info = c.securityInfo || {};
    customer.textContent =
      (window.PioneerCustomerDisplay && window.PioneerCustomerDisplay.getCustomerDisplayName(c)) ||
      c.customer_name || c.location_name || c.slug || "";
    body.innerHTML = buildSecurityModalBody(info) ||
      '<p class="tech-security-empty">No security info on file for this customer.</p>';
    _securityLastFocusEl = document.activeElement;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Focus the Done button so Enter immediately closes (fewest taps).
    const done = modal.querySelector(".tech-security-done");
    setTimeout(function () { if (done) done.focus(); }, 30);
  }

  function closeSecurityModal() {
    const modal = document.getElementById("tech-security-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (_securityLastFocusEl && typeof _securityLastFocusEl.focus === "function") {
      try { _securityLastFocusEl.focus(); } catch (_e) { /* ignore */ }
    }
    _securityLastFocusEl = null;
  }

  function wireSecurityModal() {
    const launcherBtn = document.getElementById("tech-security-btn");
    if (launcherBtn) launcherBtn.addEventListener("click", openSecurityModal);
    const modal = document.getElementById("tech-security-modal");
    if (modal) {
      modal.querySelectorAll("[data-modal-close]").forEach(function (el) {
        el.addEventListener("click", closeSecurityModal);
      });
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      const m = document.getElementById("tech-security-modal");
      if (m && !m.hidden) closeSecurityModal();
    });
  }

  // PUBLIC SOP block. Reads the flat sop* fields from the customer
  // object returned by techHubViewV1. The SECURE counterpart
  // (customer_secure/{slug}) is NEVER fetched here — firestore.rules
  // denies tech reads of that collection and this function never
  // attempts it. When customer.hasSecureSop is true, the footer in
  // the public renderer shows a small "admin-only secure info exists"
  // pill so techs know to ping the office for codes.
  function renderSopBlock(customer) {
    const card = document.getElementById("tech-sop-card");
    const body = document.getElementById("tech-sop-body");
    if (!card || !body) return;
    if (!customer) { card.hidden = true; body.innerHTML = ""; return; }
    // Tech view v1: always show the card. The simple renderer paints
    // either the SOP block or the "No SOP added for this customer yet"
    // empty state. Falls back to the sectioned renderer only if the
    // simple one isn't loaded.
    if (!window.CustomerSop) { card.hidden = true; return; }
    card.hidden = false;
    if (typeof window.CustomerSop.renderPublicSimple === "function") {
      window.CustomerSop.renderPublicSimple(body, customer);
    } else if (typeof window.CustomerSop.renderPublic === "function") {
      window.CustomerSop.renderPublic(body, customer);
    } else {
      card.hidden = true;
    }
  }

  /* ---------- 10. Load + render a specific customer ----------
     Shared by the customer-select change handler AND the Refresh button.
     `opts.refresh = true` means the user already has data on screen and
     wants to re-fetch in place — we keep the content visible and skip the
     loading card so the refresh feels instant. First-time loads (and
     customer switches) show the full loading card so the page never looks
     blank. */
  async function loadCustomer(slug, opts) {
    if (!slug) return;
    const isRefresh = !!(opts && opts.refresh);
    hideFetchError();
    if (!isRefresh) {
      // First load or customer switch — hide stale content, show loading.
      showContent(false);
      showLoading(true);
    }
    try {
      const data = await fetchTechHubView(slug);
      showLoading(false);
      renderAll(data);
    } catch (err) {
      console.error("tech-hub fetch failed", err);
      showLoading(false);
      if (!isRefresh) showContent(false);
      showFetchError(
        "Couldn't load this customer's tech view. " +
        ((err && err.message) || "unknown error")
      );
    }
  }

  function wireCustomerSelect() {
    const select = $("tech-customer-select");
    if (!select) return;
    select.addEventListener("change", function () {
      loadCustomer(select.value);
    });
  }

  /* ---------- 11. Refresh button — re-fetch the currently selected customer ---------- */
  function wireRefreshBtn() {
    const btn = $("tech-refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      const select = $("tech-customer-select");
      const slug = select && select.value;
      if (!slug) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Refreshing…";
      try {
        await loadCustomer(slug, { refresh: true });
        showToast("Up to date.");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  /* ---------- staff auth gate ---------- */
  let bootedForStaff = false;

  /* Role-aware nav — same shape as the renderer in app.js. Convenience
     navigation only; admin-page access is still gated by its own
     allowlist. Future placeholders (Announcements / Company Updates /
     Training Notes) live in the commented entries below. */
  // KEEP IN SYNC across five files: app.js, tech.js, admin.js,
  // supply-station.js, team-hub.js. See app.js for the rationale on not
  // extracting.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",           roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                    roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",           roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html", roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",       roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",       roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",    roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",               roles: ["admin"] }
    // { key: "announcements",   label: "Announcements",   href: "/announcements.html", roles: ["admin", "cleaning_tech"] },
    // { key: "company-updates", label: "Company Updates", href: "/company-updates.html", roles: ["admin", "cleaning_tech"] },
  ];

  // Preserve any cache-buster (?v=2600, etc.) on nav hops so a hard-busted
  // page doesn't slip back into a stale cached copy of the next page.
  function withCurrentSearch(href) {
    const search = (typeof location !== "undefined" && location.search) || "";
    if (!search) return href;
    return href + (href.indexOf("?") >= 0 ? "&" + search.slice(1) : search);
  }

  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }
    const current = nav.dataset.currentPage || "";
    const items   = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = (i.key === current);
      const cls   = "role-nav-link" + (isActive ? " is-active" : "");
      const aria  = isActive ? ' aria-current="page"' : '';
      if (isActive) return '<span class="' + cls + '"' + aria + '>' + i.label + '</span>';
      return '<a class="' + cls + '" href="' + withCurrentSearch(i.href) + '">' + i.label + '</a>';
    }).join("");
    nav.hidden = false;
  }

  // Pioneer Team Hub unread-announcements badge — KEEP IN SYNC across
  // app.js / tech.js / admin.js / supply-station.js / team-hub.js.
  async function paintTeamHubUnreadBadge(staff) {
    if (!staff || !staff.uid) return;
    if (!window.firebase || typeof firebase.firestore !== "function") return;
    try {
      const db = firebase.firestore();
      const [annsSnap, readsSnap] = await Promise.all([
        db.collection("announcements").where("active", "==", true).get(),
        db.collection("announcement_reads").where("uid", "==", staff.uid).get()
      ]);
      const readIds = new Set();
      readsSnap.docs.forEach(function (d) {
        const data = d.data() || {};
        if (data.announcement_id) readIds.add(data.announcement_id);
      });
      function toMs(ts) {
        if (!ts) return null;
        if (typeof ts === "number") return ts;
        if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
        if (typeof ts.toMillis === "function") return ts.toMillis();
        if (typeof ts.seconds === "number") return ts.seconds * 1000;
        return null;
      }
      const now = Date.now();
      let unread = 0;
      annsSnap.docs.forEach(function (d) {
        const a = d.data() || {};
        if (a.archived_at) return;
        const s = toMs(a.starts_at);   if (s != null && s > now) return;
        const e = toMs(a.expires_at);  if (e != null && e <= now) return;
        if (!readIds.has(d.id)) unread += 1;
      });
      const pills = document.querySelectorAll(".role-nav-link");
      let target = null;
      pills.forEach(function (p) {
        if ((p.textContent || "").trim() === "Pioneer Team Hub") target = p;
      });
      if (!target) return;
      const old = target.querySelector(".role-nav-badge");
      if (old) old.remove();
      if (unread > 0) {
        const dot = document.createElement("span");
        dot.className = "role-nav-badge";
        dot.textContent = unread > 9 ? "9+" : String(unread);
        target.appendChild(dot);
      }
    } catch (err) {
      console.warn("paintTeamHubUnreadBadge failed", err && err.code);
    }
  }

  function paintStaffIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    const cached  = (window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff)
                      ? window.STAFF_AUTH.getCachedStaff() : null;
    const displayName =
      (staff && staff.tech && staff.tech.display_name) ||
      (cached && cached.display_name) ||
      "";
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
  }

  function setStaffAuthState(state) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("staff-auth-" + s);
      if (el) el.hidden = s !== state;
    });
    const content = $("staff-auth-content");
    if (content) content.hidden = state !== "content";

    // Toggle the animated login backdrop. See app.js for full rationale.
    document.body.classList.toggle("is-signing-in", state === "signin");
    const headerAccount = $("staff-header-account");
    const headerEmail   = $("staff-header-email");
    if (state === "content") {
      if (headerAccount) headerAccount.hidden = false;
    } else {
      if (headerAccount) headerAccount.hidden = true;
      if (headerEmail)   headerEmail.textContent = "";
      const nameEl = $("staff-header-name");
      if (nameEl) nameEl.textContent = "";
      const nav = $("role-nav");
      if (nav) { nav.hidden = true; nav.innerHTML = ""; }
    }

    if (state === "checking") {
      const checkingEl = $("staff-auth-checking");
      const titleEl    = checkingEl && checkingEl.querySelector(".staff-auth-title");
      const cached     = window.STAFF_AUTH && window.STAFF_AUTH.getCachedStaff
                          ? window.STAFF_AUTH.getCachedStaff() : null;
      if (titleEl) {
        const name = cached && (cached.display_name || cached.email);
        titleEl.textContent = name ? ("Welcome back, " + name + "…") : "Checking access…";
      }
    }
  }

  function bootForStaff(staff) {
    if (bootedForStaff) return;
    bootedForStaff = true;
    wireAskBtn();
    wireCustomerSelect();
    wireRefreshBtn();
    wireSuggestModal();
    wireSecurityModal();
    wireSupplyListNudge();
    loadCustomers(staff);
  }

  function setStaffAuthInlineMsg(msg, kind /* "ok" | "err" */) {
    const el = $("staff-auth-inline-msg");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-ok");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("is-ok", kind === "ok");
    el.hidden = false;
  }

  function wireSignInButton() {
    const btn = $("staff-signin-btn");
    if (btn) btn.addEventListener("click", async function () {
      if (!window.STAFF_AUTH) return;
      setStaffAuthInlineMsg("");
      btn.disabled = true;
      try {
        // STAFF_AUTH.signIn() returns a result envelope (NEVER throws).
        // No redirect-fallback on Safari — see staff-auth.js for policy.
        const result = await window.STAFF_AUTH.signIn();
        if (result && !result.ok && !result.cancelled) {
          setStaffAuthInlineMsg(result.message, "err");
        }
      } finally {
        btn.disabled = false;
      }
    });

    const form    = $("staff-password-form");
    const submit  = $("staff-password-submit");
    const emailEl = $("staff-email");
    const passEl  = $("staff-password");
    if (form && submit && emailEl && passEl) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        submit.disabled = true;
        const origLabel = submit.textContent;
        submit.textContent = "Signing in…";
        try {
          const result = await window.STAFF_AUTH.signInWithPassword(emailEl.value, passEl.value);
          if (!result.ok) {
            setStaffAuthInlineMsg(result.message, "err");
            passEl.value = "";
            passEl.focus();
          }
        } finally {
          submit.disabled = false;
          submit.textContent = origLabel;
        }
      });
    }

    const forgot = $("staff-forgot-link");
    if (forgot && emailEl) {
      forgot.addEventListener("click", async function () {
        if (!window.STAFF_AUTH) return;
        setStaffAuthInlineMsg("");
        forgot.disabled = true;
        try {
          const result = await window.STAFF_AUTH.sendPasswordReset(emailEl.value);
          setStaffAuthInlineMsg(result.message, result.ok ? "ok" : "err");
        } finally {
          forgot.disabled = false;
        }
      });
    }
  }
  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
    setStaffAuthState("checking");
    try {
      window.STAFF_AUTH.init({
        onChecking:   function () { setStaffAuthState("checking"); },
        onSignedOut:  function () { setStaffAuthState("signin"); },
        onDenied:     function (info) {
          setStaffAuthState("denied");
          const msgEl = $("staff-auth-denied-msg");
          if (msgEl && info && info.message) msgEl.textContent = info.message;
        },
        onAuthorized: function (staff) {
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);
          paintTeamHubUnreadBadge(staff);
          if (window.MANDATORY_ANN && typeof window.MANDATORY_ANN.check === "function") {
            window.MANDATORY_ANN.check(staff).then(function () {
              paintTeamHubUnreadBadge(staff);
            });
          }
          bootForStaff(staff);
        }
      });
    } catch (err) {
      console.error("STAFF_AUTH init failed", err);
      setStaffAuthState("denied");
      const msgEl = $("staff-auth-denied-msg");
      if (msgEl) msgEl.textContent = "Couldn't start sign-in. Hard-reload (Cmd+Shift+R).";
    }
  });
})();
