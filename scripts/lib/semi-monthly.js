/* Pioneer DCR Hub — Semi-monthly payroll period helpers (Node side).
 *
 * Pure functions. No Firebase, no network, no DOM. Safe for use from
 * any seed/migration script.
 *
 * Cadence: Period A = 1st-15th, Period B = 16th-EOM.
 * Paydays:  A = 20th of same month, B = 5th of following month.
 * Doc id format: YYYY-MM-{A|B}. All dates Pacific YYYY-MM-DD strings.
 *
 * Mirror of public/admin/_utils.js helpers — keep bodies in sync.
 * Sick-leave cap = 2400 integer minutes (40 hours).
 */

"use strict";

const SICK_LEAVE_CAP_MINUTES = 2400;

// Last calendar day of the month containing a Pacific YYYY-MM-DD.
// Handles leap-year February.
function getEndOfMonth(yyyyMmDd) {
  const parts = String(yyyyMmDd).split("-");
  const year  = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return parts[0] + "-" + parts[1] + "-" + String(lastDay).padStart(2, "0");
}

// Returns the period record for a given Pacific YYYY-MM-DD.
// Shape: { period_id, period_label, month, half, start_date, end_date, payday }.
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

// Returns the NEXT semi-monthly period after the given period_id or YYYY-MM-DD.
function nextSemiMonthlyPeriod(input) {
  let year, month, half;
  const periodRe = /^(\d{4})-(\d{2})-([AB])$/;
  const match    = periodRe.exec(String(input));
  if (match) {
    year  = match[1]; month = match[2]; half = match[3];
  } else {
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
  const seedDay = (nextHalf === "A") ? "08" : "20";
  const seed = String(nextYear) + "-" + String(nextMonth).padStart(2, "0") + "-" + seedDay;
  return getSemiMonthlyPeriod(seed);
}

// Pacific YYYY-MM-DD for "today" or a given Date instance.
function pacificDateString(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d || new Date());
}

// Integer minutes → "Xh Ym" display string.
function formatMinutesAsHm(minutes) {
  const n = Math.round(Number(minutes) || 0);
  const sign = n < 0 ? "-" : "";
  const abs  = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return sign + h + "h " + m + "m";
}

module.exports = {
  SICK_LEAVE_CAP_MINUTES: SICK_LEAVE_CAP_MINUTES,
  getEndOfMonth:          getEndOfMonth,
  getSemiMonthlyPeriod:   getSemiMonthlyPeriod,
  nextSemiMonthlyPeriod:  nextSemiMonthlyPeriod,
  pacificDateString:      pacificDateString,
  formatMinutesAsHm:      formatMinutesAsHm
};
