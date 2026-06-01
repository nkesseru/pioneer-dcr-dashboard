/* Pioneer DCR Hub — Admin utility helpers (vanilla JS, no build).
 *
 * Pure, side-effect-free helpers shared by every admin tab module.
 *
 *   • DCR_RECENT_LIMIT          — analytics window (Last 7d / MTD / All-time)
 *   • ALLOWED_ADMIN_EMAILS      — single-source-of-truth allowlist
 *   • isRootAdmin(email)        — sync allowlist check
 *   • escapeHtml(s)             — HTML-entity escape
 *   • cssEsc(s)                 — CSS attribute-selector escape (" and \)
 *   • formatTimestamp(ts)       — Firestore-tolerant date formatter (locale)
 *   • tsToMs(ts)                — Firestore/ISO/number → ms reader
 *   • formatImprovementDate(ts) — short Pacific-time formatter
 *                                 (used by SOS, Improvements, Announcements)
 *   • getCustomer*(c) / getTech*(t) — schema-tolerant field accessors
 *
 * Surface lives at window.__pioneerAdmin.utils. Loaded BEFORE admin.js
 * by admin.html so admin.js can destructure at the top of its IIFE.
 *
 * Constraints:
 *   • No DOM access.
 *   • No Firebase access (resolveAdminStatus() stays in admin.js because
 *     it depends on the `db` closure variable).
 *   • Pure functions only.
 */
(function () {
  "use strict";

  // The DCR list cap doubles as our analytics window. 500 covers ~6 months
  // for a typical 80-clean-per-week org and lets us compute Last 7d / MTD /
  // "All-time" (defined as the loaded window) without any extra Firestore
  // reads. Future: replace with a server-aggregated `dcr_metrics_cache`
  // document once dataset growth makes 500-doc pulls expensive.
  const DCR_RECENT_LIMIT = 500;

  /* =====================================================================
     ADMIN ACCESS CONTROL — single-source-of-truth allowlist
     =====================================================================
     Add or remove emails here. Comparison is case-insensitive — the values
     below are normalised to lower-case on read. After editing, redeploy
     hosting (no function/rules redeploy needed).

     If you ever swap to a custom-claims auth model, this list becomes the
     seed for whoever runs `setCustomUserClaims({admin: true})` server-side.
     ===================================================================== */
  const ALLOWED_ADMIN_EMAILS = [
    "nick@pioneercomclean.com",
    "april@pioneercomclean.com",
    "kirby@pioneercomclean.com",
    "mgies@pioneercomclean.com"
  ];

  // Synchronous "root admin" check — for callers that need a snap
  // decision and are OK only matching the hardcoded list. Used as the
  // optimistic first-pass during auth state changes; full check goes
  // through resolveAdminStatus() (which stays in admin.js because it
  // depends on the Firestore handle).
  function isRootAdmin(email) {
    if (!email) return false;
    const normalized = email.toLowerCase().trim();
    return ALLOWED_ADMIN_EMAILS.some(function (e) {
      return e.toLowerCase().trim() === normalized;
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatTimestamp(ts) {
    if (!ts) return "—";
    try {
      // Firestore Timestamp shape: { seconds, nanoseconds } OR a Timestamp obj.
      if (typeof ts.toDate === "function") return ts.toDate().toLocaleString();
      if (typeof ts === "object" && typeof ts.seconds === "number") {
        return new Date(ts.seconds * 1000).toLocaleString();
      }
      if (typeof ts === "string") return new Date(ts).toLocaleString();
    } catch (e) { /* fall through */ }
    return String(ts);
  }

  /* ---------- shared time/escape helpers ----------
   * tsToMs is the canonical Firestore-Timestamp / ISO / number reader.
   * dcrTsToMs (in admin/_budget.js) is now an alias to this — same impl,
   * one source of truth. Mirrors the server-side helper in
   * functions/index.js.
   */
  function tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? null : t; }
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    if (typeof ts._seconds === "number") return ts._seconds * 1000;
    return null;
  }

  // Short Pacific-time formatter used across SOS, Improvements, and
  // Announcements panels. Returns "—" on unreadable input.
  function formatImprovementDate(ts) {
    const ms = tsToMs(ts);
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
      }).format(new Date(ms));
    } catch (_e) { return "—"; }
  }

  // Escape a string for use inside a CSS attribute-selector value, e.g.
  // document.querySelector('input[data-x="' + cssEsc(id) + '"]'). Escapes
  // only " and \ since those are the characters that break the selector
  // string.
  function cssEsc(s) {
    return String(s == null ? "" : s).replace(/(["\\])/g, "\\$1");
  }

  /* ---------- defensive field accessors ---------- */

  function getCustomerName(c)     { return c.customer_name  || c.name         || c.display_name || ""; }
  function getCustomerSlug(c)     { return c.customer_slug  || c.slug         || c.id          || ""; }
  function getCustomerEmail(c)    { return c.customer_email || c.email        || ""; }
  function getCustomerLocation(c) { return c.location_name  || c.location     || ""; }
  function getActive(c)           { return c.active !== false; }                  // default true
  function getDcrEnabled(c)       { return c.dcr_enabled !== false; }             // default true
  // Customer-only — controls customer-facing DCR EMAIL delivery downstream.
  // Distinct from getDcrEnabled (form visibility). Both default true when
  // the field is missing, preserving existing behaviour.
  function getDcrEmailEnabled(c)  { return c.dcr_email_enabled !== false; }       // default true

  function getTechName(t)         { return t.display_name || t.tech_display_name || t.name || ""; }
  function getTechSlug(t)         { return t.tech_slug    || t.slug              || t.id   || ""; }

  /* ---------- pure date helpers ----------
   *
   * pacificDateString + addDaysPacific + getOpsDayWindow promoted to
   * utils in Phase 23 because they're consumed by multiple tab
   * modules (Schedule, Attendance, Day Health). No closures, no
   * Firestore, no network — safe to share at the utils layer.
   */

  function pacificDateString(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year:  "numeric", month: "2-digit", day:   "2-digit"
    }).format(d);
  }

  function addDaysPacific(yyyymmdd, days) {
    // Add `days` to a YYYY-MM-DD string, working in UTC to avoid DST
    // drift, then re-format in Pacific. Sufficient for short windows
    // (14-21 days).
    const base = new Date(yyyymmdd + "T12:00:00Z");
    base.setUTCDate(base.getUTCDate() + days);
    return pacificDateString(base);
  }

  /* getOpsDayWindow — Pioneer operational day boundaries.
   *
   * The "operational day" begins at 4 PM Pacific (office staff close
   * out the previous workday) and ends at 4 PM the next day. Midnight-
   * to-midnight stats are less useful because cleaning techs work
   * overnight and the office wants their morning view to STILL reflect
   * last night's work.
   *
   * Returns the current ops-day window + the previous one + a human
   * label describing which physical hours the current window covers.
   *
   * Pure date math. No Firestore. No network. */
  function getOpsDayWindow(now, cutoffHour, timezone) {
    now         = now         || new Date();
    cutoffHour  = (cutoffHour  != null) ? cutoffHour  : 16;
    timezone    = timezone     || "America/Los_Angeles";

    // What's the Pacific wall-clock hour:minute:second right now?
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
    function partVal(name) {
      const p = parts.find(function (x) { return x.type === name; });
      return p ? parseInt(p.value, 10) : 0;
    }
    const h = partVal("hour");
    const m = partVal("minute");
    const s = partVal("second");

    // How many ms have elapsed since the most recent 4 PM Pacific
    // boundary? If we're past today's cutoff, that boundary was today
    // at the cutoff hour; otherwise it was yesterday at the cutoff hour.
    const isPastCutoff = (h >= cutoffHour);
    const hoursSince = isPastCutoff
      ? (h - cutoffHour)
      : (h + (24 - cutoffHour));
    const msSince = (hoursSince * 3600 + m * 60 + s) * 1000;

    // Anchor to the boundary by subtracting the elapsed ms from `now`.
    // This sidesteps DST gotchas: we're stepping back a wall-clock
    // duration that's already in the Pacific frame.
    const currentOpsStart  = new Date(now.getTime() - msSince);
    const currentOpsEnd    = new Date(currentOpsStart.getTime() + 86400000);
    const previousOpsStart = new Date(currentOpsStart.getTime() - 86400000);
    const previousOpsEnd   = new Date(currentOpsStart.getTime());

    const opsDayLabel = isPastCutoff
      ? "Today 4 PM → Tomorrow 4 PM"
      : "Yesterday 4 PM → Today 4 PM";

    return {
      currentOpsStart:  currentOpsStart,
      currentOpsEnd:    currentOpsEnd,
      previousOpsStart: previousOpsStart,
      previousOpsEnd:   previousOpsEnd,
      opsDayLabel:      opsDayLabel
    };
  }

  /* ---------- Semi-monthly payroll periods ----------
   * Pioneer pay cadence: 1st-15th (Period A) and 16th-EOM (Period B).
   * Paydays: 20th of same month for A, 5th of following month for B.
   * Doc id format: YYYY-MM-{A|B}. All dates are Pacific YYYY-MM-DD strings.
   * Sick leave is denominated in INTEGER MINUTES (cap = 2400 = 40h).
   *
   * Mirror of scripts/lib/semi-monthly.js — keep bodies in sync.
   */
  const SICK_LEAVE_CAP_MINUTES = 2400;

  // Last calendar day of the month containing a Pacific YYYY-MM-DD.
  // Handles leap-year February. Uses UTC date math but returns a string
  // built from the input's YYYY/MM parts (no TZ crossing).
  function getEndOfMonth(yyyyMmDd) {
    const parts = String(yyyyMmDd).split("-");
    const year  = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    // Day 0 of next month = last day of current month
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return parts[0] + "-" + parts[1] + "-" + String(lastDay).padStart(2, "0");
  }

  // Returns the period record for a given Pacific YYYY-MM-DD.
  // Shape matches the payroll_periods doc fields: { period_id, period_label,
  // month, half, start_date, end_date, payday }.
  function getSemiMonthlyPeriod(yyyyMmDd) {
    const parts = String(yyyyMmDd).split("-");
    const year  = parts[0];
    const month = parts[1];
    const day   = parseInt(parts[2], 10);
    const half  = (day <= 15) ? "A" : "B";
    const period_id = year + "-" + month + "-" + half;

    let start_date, end_date, payday;
    if (half === "A") {
      start_date = year + "-" + month + "-01";
      end_date   = year + "-" + month + "-15";
      payday     = year + "-" + month + "-20";
    } else {
      start_date = year + "-" + month + "-16";
      end_date   = getEndOfMonth(yyyyMmDd);
      // Payday: 5th of following month
      let nextYear  = parseInt(year, 10);
      let nextMonth = parseInt(month, 10) + 1;
      if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
      payday = String(nextYear) + "-" + String(nextMonth).padStart(2, "0") + "-05";
    }

    const MONTH_NAMES = ["January","February","March","April","May","June",
                         "July","August","September","October","November","December"];
    const monthName   = MONTH_NAMES[parseInt(month, 10) - 1];
    const startDay    = parseInt(start_date.slice(8), 10);
    const endDay      = parseInt(end_date.slice(8), 10);
    const period_label = monthName + " " + year + " — Period " + half +
                         " (" + monthName.slice(0,3) + " " + startDay + "–" + endDay + ")";

    return {
      period_id:    period_id,
      period_label: period_label,
      month:        year + "-" + month,
      half:         half,
      start_date:   start_date,
      end_date:     end_date,
      payday:       payday
    };
  }

  // Returns the NEXT semi-monthly period after the given period_id or
  // YYYY-MM-DD date. A → B same month; B → A next month (handles year roll).
  function nextSemiMonthlyPeriod(input) {
    let year, month, half;
    const periodRe = /^(\d{4})-(\d{2})-([AB])$/;
    const match    = periodRe.exec(String(input));
    if (match) {
      year  = match[1]; month = match[2]; half = match[3];
    } else {
      // Treat input as YYYY-MM-DD; find its period first.
      const p = getSemiMonthlyPeriod(input);
      year  = p.month.slice(0, 4);
      month = p.month.slice(5, 7);
      half  = p.half;
    }
    let nextYear  = parseInt(year, 10);
    let nextMonth = parseInt(month, 10);
    let nextHalf;
    if (half === "A") {
      nextHalf = "B";
    } else {
      nextHalf = "A";
      nextMonth += 1;
      if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    }
    // Build a representative date in the target period and round-trip.
    const seedDay = (nextHalf === "A") ? "08" : "20";
    const seed = String(nextYear) + "-" + String(nextMonth).padStart(2, "0") + "-" + seedDay;
    return getSemiMonthlyPeriod(seed);
  }

  // Display helper — integer minutes → "Xh Ym" (e.g., 758 → "12h 38m").
  // Used by employee Time + Sick Leave card. Negative input → "-Xh Ym".
  function formatMinutesAsHm(minutes) {
    const n = Math.round(Number(minutes) || 0);
    const sign = n < 0 ? "-" : "";
    const abs  = Math.abs(n);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return sign + h + "h " + m + "m";
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin = window.__pioneerAdmin || {};
  window.__pioneerAdmin.utils = {
    DCR_RECENT_LIMIT: DCR_RECENT_LIMIT,
    ALLOWED_ADMIN_EMAILS: ALLOWED_ADMIN_EMAILS,
    isRootAdmin: isRootAdmin,
    escapeHtml: escapeHtml,
    cssEsc: cssEsc,
    formatTimestamp: formatTimestamp,
    tsToMs: tsToMs,
    formatImprovementDate: formatImprovementDate,
    getCustomerName: getCustomerName,
    getCustomerSlug: getCustomerSlug,
    getCustomerEmail: getCustomerEmail,
    getCustomerLocation: getCustomerLocation,
    getActive: getActive,
    getDcrEnabled: getDcrEnabled,
    getDcrEmailEnabled: getDcrEmailEnabled,
    getTechName: getTechName,
    getTechSlug: getTechSlug,
    pacificDateString: pacificDateString,
    addDaysPacific: addDaysPacific,
    getOpsDayWindow: getOpsDayWindow,
    // Phase 1a labor + sick leave additions
    SICK_LEAVE_CAP_MINUTES: SICK_LEAVE_CAP_MINUTES,
    getEndOfMonth: getEndOfMonth,
    getSemiMonthlyPeriod: getSemiMonthlyPeriod,
    nextSemiMonthlyPeriod: nextSemiMonthlyPeriod,
    formatMinutesAsHm: formatMinutesAsHm
  };
}());
