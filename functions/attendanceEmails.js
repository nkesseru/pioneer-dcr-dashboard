/* ============================================================================
 * attendanceEmails.js — PioneerOps attendance notification emails.
 *
 * Two pairs of triggers:
 *   onCallOutCreated         → email Kirby (+ April) — urgent shift issue
 *   onTimeOffRequestCreated  → email Kirby (+ April) — informational
 *   onCallOutUpdated         → email tech on acknowledged / resolved
 *   onTimeOffRequestUpdated  → email tech on approved / denied
 *
 * Update triggers ignore everything except `status` transitions to keep
 * the inbox quiet when admins add a coverage/manager note without
 * flipping state.
 *
 * Re-uses feedback.js's sendGmailMessage (already proven path —
 * domain-wide-delegated service account impersonating
 * GMAIL_SENDER_EMAIL via the Gmail API).
 *
 * Phase 2 TODO:
 *   • Push / SMS escalation if a call-out stays "new" past 15 minutes
 *   • Manager opt-in / opt-out per channel
 *   • Bundle multiple events into a single morning digest
 * ========================================================================== */

const { sendGmailMessage } = require("./feedback");

const PIONEER_TEAL_HEX   = "#0d9488";
const PIONEER_INK_HEX    = "#0f172a";
const PIONEER_MUTED_HEX  = "#475569";
const PIONEER_URGENT_HEX = "#b91c1c";
const PIONEER_BG_SOFT    = "#f8fafc";

const ADMIN_ATTENDANCE_URL = "https://pioneer-dcr-hub.web.app/admin?tab=attendance";
const TEAM_HUB_URL         = "https://pioneer-dcr-hub.web.app/team-hub.html";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function reasonLabel(v) {
  switch (v) {
    case "sick":           return "Sick";
    case "emergency":      return "Emergency";
    case "transportation": return "Transportation issue";
    case "family":         return "Family issue";
    case "running_late":   return "Running late";
    case "other":          return "Other";
    default:               return v || "—";
  }
}
function typeLabel(v) {
  switch (v) {
    case "vacation":     return "Vacation";
    case "personal_day": return "Personal day";
    case "appointment":  return "Appointment";
    case "family_event": return "Family event";
    case "other":        return "Other";
    default:             return v || "—";
  }
}
function rangeLabel(start, end) {
  if (!start) return "—";
  if (!end || end === start) return start;
  return start + " → " + end;
}

/* ----- Email shells ---------------------------------------------------- */

function buildShell(opts) {
  const { eyebrow, title, accentHex, rows, footerText, ctaLabel, ctaHref } = opts;
  const rowsHtml = rows.map(function (r) {
    return (
      '<tr>' +
        '<td style="padding:6px 0;color:' + PIONEER_MUTED_HEX +
          ';font-size:13px;width:140px;vertical-align:top;">' +
          escapeHtml(r.label) +
        '</td>' +
        '<td style="padding:6px 0;color:' + PIONEER_INK_HEX +
          ';font-size:14px;font-weight:600;">' +
          (r.html != null ? r.html : escapeHtml(r.value || "—")) +
        '</td>' +
      '</tr>'
    );
  }).join("");
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:' + PIONEER_BG_SOFT + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + PIONEER_BG_SOFT + ';padding:24px 12px;">' +
        '<tr><td align="center">' +
          '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">' +
            '<tr><td style="padding:18px 22px;border-bottom:3px solid ' + accentHex + ';">' +
              '<div style="font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:' + accentHex + ';">' +
                escapeHtml(eyebrow) +
              '</div>' +
              '<div style="font-size:20px;font-weight:800;color:' + PIONEER_INK_HEX + ';margin-top:4px;line-height:1.25;">' +
                escapeHtml(title) +
              '</div>' +
            '</td></tr>' +
            '<tr><td style="padding:18px 22px 4px;">' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rowsHtml + '</table>' +
            '</td></tr>' +
            (ctaLabel && ctaHref
              ? '<tr><td style="padding:8px 22px 20px;">' +
                  '<a href="' + escapeHtml(ctaHref) + '" style="display:inline-block;padding:10px 18px;background:' + PIONEER_INK_HEX + ';color:#fff;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px;">' +
                    escapeHtml(ctaLabel) +
                  '</a>' +
                '</td></tr>'
              : '') +
            '<tr><td style="padding:14px 22px 18px;border-top:1px solid #e2e8f0;color:' + PIONEER_MUTED_HEX + ';font-size:12px;line-height:1.5;">' +
              escapeHtml(footerText || "Pioneer Commercial Cleaning · PioneerOps") +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

/* ----- Recipient list helpers -------------------------------------- */

function adminRecipients(secrets) {
  const list = [];
  try { if (secrets.KIRBY_ALERT_EMAIL && secrets.KIRBY_ALERT_EMAIL.value()) list.push(secrets.KIRBY_ALERT_EMAIL.value()); } catch (_e) {}
  try { if (secrets.APRIL_ALERT_EMAIL && secrets.APRIL_ALERT_EMAIL.value()) list.push(secrets.APRIL_ALERT_EMAIL.value()); } catch (_e) {}
  return list.filter(Boolean);
}

async function sendToList({ list, subject, html, secrets, logger, context }) {
  if (!list.length) {
    if (logger) logger.warn("[attendance-email] no recipients configured", context);
    return { sent: 0, recipients: [] };
  }
  const sender = secrets.GMAIL_SENDER_EMAIL && secrets.GMAIL_SENDER_EMAIL.value();
  const key    = secrets.GMAIL_SERVICE_ACCOUNT_KEY && secrets.GMAIL_SERVICE_ACCOUNT_KEY.value();
  if (!sender || !key) {
    if (logger) logger.warn("[attendance-email] sender or service account missing", context);
    return { sent: 0, recipients: list, error: "missing_secrets" };
  }
  // Sequential sends — keeps Gmail rate-limit safe and the failure
  // mode obvious in logs (one bad address shouldn't fail the rest).
  const results = [];
  for (const to of list) {
    try {
      const res = await sendGmailMessage({
        to: to,
        subject: subject,
        html: html,
        senderEmail: sender,
        serviceAccountKey: key
      });
      results.push({ to: to, ok: true, id: res && res.id });
    } catch (err) {
      if (logger) logger.error("[attendance-email] send failed", { to: to, error: err && err.message, context: context });
      results.push({ to: to, ok: false, error: err && err.message });
    }
  }
  return { sent: results.filter(function (r) { return r.ok; }).length, recipients: results };
}

/* ----- onCallOutCreated → email Kirby ------------------------------ */

async function handleCallOutCreated({ snapshot, secrets, logger }) {
  if (!snapshot || !snapshot.exists) return null;
  const data = snapshot.data() || {};
  const tech = data.techName || data.techEmail || "Unknown tech";
  const rows = [
    { label: "Tech",      value: tech },
    { label: "Date",      value: data.date || "—" },
    { label: "Reason",    value: reasonLabel(data.reason) },
    { label: "Shift/customer", value: data.shiftCustomer || "—" },
    { label: "Note",      value: data.note || "(no note)" }
  ];
  const html = buildShell({
    eyebrow:    "Urgent call-out",
    title:      tech + " can't make a shift",
    accentHex:  PIONEER_URGENT_HEX,
    rows:       rows,
    ctaLabel:   "Review in Admin",
    ctaHref:    ADMIN_ATTENDANCE_URL,
    footerText: "PioneerOps · Attendance · This is an automated alert from the call-out form."
  });
  return sendToList({
    list:     adminRecipients(secrets),
    subject:  "[PioneerOps] New Call-Out — " + tech,
    html:     html,
    secrets:  secrets,
    logger:   logger,
    context:  { kind: "call_out_created", id: snapshot.id }
  });
}

/* ----- onTimeOffRequestCreated → email Kirby (informational) ------- */

async function handleTimeOffRequestCreated({ snapshot, secrets, logger }) {
  if (!snapshot || !snapshot.exists) return null;
  const data = snapshot.data() || {};
  const tech = data.techName || data.techEmail || "Unknown tech";
  const rows = [
    { label: "Tech",         value: tech },
    { label: "Dates",        value: rangeLabel(data.startDate, data.endDate) },
    { label: "Request type", value: typeLabel(data.requestType) },
    { label: "Note",         value: data.note || "(no note)" }
  ];
  const html = buildShell({
    eyebrow:    "New time-off request",
    title:      tech + " requested time off",
    accentHex:  PIONEER_TEAL_HEX,
    rows:       rows,
    ctaLabel:   "Review in Admin",
    ctaHref:    ADMIN_ATTENDANCE_URL,
    footerText: "PioneerOps · Attendance · Approval is required before this request is final."
  });
  return sendToList({
    list:     adminRecipients(secrets),
    subject:  "[PioneerOps] New Time-Off Request — " + tech,
    html:     html,
    secrets:  secrets,
    logger:   logger,
    context:  { kind: "time_off_created", id: snapshot.id }
  });
}

/* ----- onCallOutUpdated → email tech on status change -------------- */

async function handleCallOutUpdated({ before, after, secrets, logger }) {
  const b = (before && before.exists && before.data()) || {};
  const a = (after  && after.exists  && after.data())  || {};
  if (!a.techEmail) return null;
  if (b.status === a.status) return null;            // ignore note-only edits
  if (a.status !== "acknowledged" && a.status !== "resolved") return null;

  const isResolved = (a.status === "resolved");
  const subject = isResolved
    ? "[PioneerOps] Call-Out Resolved"
    : "[PioneerOps] Call-Out Received";
  const title = isResolved
    ? "Your call-out is marked resolved"
    : "We received your call-out";
  const eyebrow = isResolved ? "Call-out resolved" : "Call-out received";
  const rows = [
    { label: "Date",        value: a.date || "—" },
    { label: "Reason",      value: reasonLabel(a.reason) },
    { label: "Status",      value: isResolved ? "Resolved" : "Acknowledged" },
    { label: "Coverage",    value: a.coverageNote || "—" }
  ];
  const html = buildShell({
    eyebrow:    eyebrow,
    title:      title,
    accentHex:  isResolved ? PIONEER_TEAL_HEX : PIONEER_URGENT_HEX,
    rows:       rows,
    ctaLabel:   "Open Team Hub",
    ctaHref:    TEAM_HUB_URL,
    footerText: "PioneerOps · Reply to this email or call the office with any updates."
  });
  return sendToList({
    list:     [a.techEmail],
    subject:  subject,
    html:     html,
    secrets:  secrets,
    logger:   logger,
    context:  { kind: "call_out_updated", id: (after && after.id) || null, new_status: a.status }
  });
}

/* ----- onTimeOffRequestUpdated → email tech on approve/deny -------- */

async function handleTimeOffRequestUpdated({ before, after, secrets, logger }) {
  const b = (before && before.exists && before.data()) || {};
  const a = (after  && after.exists  && after.data())  || {};
  if (!a.techEmail) return null;
  if (b.status === a.status) return null;            // ignore note-only edits
  if (a.status !== "approved" && a.status !== "denied") return null;

  const isApproved = (a.status === "approved");
  const subject = isApproved
    ? "[PioneerOps] Time-Off Request Approved"
    : "[PioneerOps] Time-Off Request Update";
  const title = isApproved
    ? "Your time-off request is approved"
    : "Update on your time-off request";
  const rows = [
    { label: "Dates",        value: rangeLabel(a.startDate, a.endDate) },
    { label: "Request type", value: typeLabel(a.requestType) },
    { label: "Status",       value: isApproved ? "Approved" : "Denied" },
    { label: "Manager note", value: a.managerNote || "—" }
  ];
  const html = buildShell({
    eyebrow:    isApproved ? "Time-off approved" : "Time-off update",
    title:      title,
    accentHex:  isApproved ? PIONEER_TEAL_HEX : PIONEER_URGENT_HEX,
    rows:       rows,
    ctaLabel:   "Open Team Hub",
    ctaHref:    TEAM_HUB_URL,
    footerText: "PioneerOps · Questions? Reply to this email or contact the office."
  });
  return sendToList({
    list:     [a.techEmail],
    subject:  subject,
    html:     html,
    secrets:  secrets,
    logger:   logger,
    context:  { kind: "time_off_updated", id: (after && after.id) || null, new_status: a.status }
  });
}

/* ----- onOpenShiftCreated → email Kirby ----------------------------- */

async function handleOpenShiftCreated({ snapshot, secrets, logger }) {
  if (!snapshot || !snapshot.exists) return null;
  const data = snapshot.data() || {};
  const customer = data.customerName || "Customer";
  const rows = [
    { label: "Customer",     value: customer },
    { label: "Shift date",   value: data.shiftDate || "—" },
    { label: "Shift time",   value: data.shiftTime || "—" },
    { label: "Notes",        value: data.notes || "(no notes)" },
    { label: "Rockstar bonus", value: "$25 (on coverage confirmation)" }
  ];
  const html = buildShell({
    eyebrow:    "Open shift available",
    title:      "Open shift: " + customer,
    accentHex:  PIONEER_TEAL_HEX,
    rows:       rows,
    ctaLabel:   "Review in Admin",
    ctaHref:    ADMIN_ATTENDANCE_URL,
    footerText: "PioneerOps · Attendance · Techs can claim this from /open-shifts.html."
  });
  return sendToList({
    list:     adminRecipients(secrets),
    subject:  "[PioneerOps] New Open Shift — " + customer,
    html:     html,
    secrets:  secrets,
    logger:   logger,
    context:  { kind: "open_shift_created", id: snapshot.id }
  });
}

/* ----- onOpenShiftUpdated → email tech on accepted / confirmed ----- */

async function handleOpenShiftUpdated({ before, after, secrets, logger }) {
  const b = (before && before.exists && before.data()) || {};
  const a = (after  && after.exists  && after.data())  || {};
  if (b.status === a.status) return null; // ignore note-only edits
  const customer = a.customerName || "Customer";

  // Tech-facing email when they accept (the tech already saw the in-app
  // toast; this gives them a thread for confirmation later).
  if (a.status === "accepted" && a.acceptedByTechName) {
    // Two emails: one to the tech (confirmation receipt), one to Kirby
    // (heads-up that someone picked it up).
    const techList = [];
    // Cleaning_techs collection has the canonical email; we don't have
    // it on the shift doc by default, so we look it up if a slug is set.
    if (a.acceptedByTechId) {
      try {
        const { getFirestore } = require("firebase-admin/firestore");
        const techSnap = await getFirestore()
          .collection("cleaning_techs").doc(a.acceptedByTechId).get();
        const techData = techSnap.exists ? (techSnap.data() || {}) : {};
        if (techData.email) techList.push(String(techData.email));
      } catch (lookupErr) {
        if (logger) logger.warn("[open_shift_email] tech lookup failed", { error: lookupErr && lookupErr.message });
      }
    }
    const techRows = [
      { label: "Customer",   value: customer },
      { label: "Shift date", value: a.shiftDate || "—" },
      { label: "Shift time", value: a.shiftTime || "—" },
      { label: "Bonus",      value: "$25 Rockstar — pending Kirby's confirmation" }
    ];
    const techHtml = buildShell({
      eyebrow:    "Open shift accepted",
      title:      "Thanks for helping the team",
      accentHex:  PIONEER_TEAL_HEX,
      rows:       techRows,
      ctaLabel:   "Open Team Hub",
      ctaHref:    TEAM_HUB_URL,
      footerText: "PioneerOps · Kirby will confirm coverage. Bonus is paid after confirmation."
    });
    const techResult = techList.length ? await sendToList({
      list: techList, subject: "[PioneerOps] Open Shift Accepted — " + customer,
      html: techHtml, secrets: secrets, logger: logger,
      context: { kind: "open_shift_accepted_tech", id: (after && after.id) || null }
    }) : null;

    // Admin heads-up.
    const adminRows = [
      { label: "Customer",   value: customer },
      { label: "Shift date", value: a.shiftDate || "—" },
      { label: "Shift time", value: a.shiftTime || "—" },
      { label: "Accepted by", value: a.acceptedByTechName }
    ];
    const adminHtml = buildShell({
      eyebrow:    "Open shift accepted",
      title:      a.acceptedByTechName + " accepted the open shift",
      accentHex:  PIONEER_TEAL_HEX,
      rows:       adminRows,
      ctaLabel:   "Confirm coverage",
      ctaHref:    ADMIN_ATTENDANCE_URL,
      footerText: "PioneerOps · Attendance · Confirming records the Rockstar bonus."
    });
    await sendToList({
      list: adminRecipients(secrets),
      subject: "[PioneerOps] Open Shift Accepted — " + customer,
      html: adminHtml, secrets: secrets, logger: logger,
      context: { kind: "open_shift_accepted_admin", id: (after && after.id) || null }
    });
    return techResult;
  }

  // Tech-facing email on confirm — the bonus is now official.
  if (a.status === "confirmed" && a.acceptedByTechId) {
    let techEmail = null;
    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const techSnap = await getFirestore()
        .collection("cleaning_techs").doc(a.acceptedByTechId).get();
      const td = techSnap.exists ? (techSnap.data() || {}) : {};
      if (td.email) techEmail = String(td.email);
    } catch (_e) {}
    if (!techEmail) return null;
    const rows = [
      { label: "Customer",   value: customer },
      { label: "Shift date", value: a.shiftDate || "—" },
      { label: "Bonus",      value: "$25 Rockstar — confirmed" }
    ];
    const html = buildShell({
      eyebrow:    "Coverage confirmed",
      title:      "Your $25 Rockstar bonus is confirmed",
      accentHex:  PIONEER_TEAL_HEX,
      rows:       rows,
      ctaLabel:   "Open Team Hub",
      ctaHref:    TEAM_HUB_URL,
      footerText: "PioneerOps · Thanks for stepping up to help the team."
    });
    return sendToList({
      list: [techEmail],
      subject: "[PioneerOps] Coverage Confirmed — $25 Rockstar Bonus",
      html: html, secrets: secrets, logger: logger,
      context: { kind: "open_shift_confirmed", id: (after && after.id) || null }
    });
  }

  return null;
}

module.exports = {
  handleCallOutCreated:        handleCallOutCreated,
  handleTimeOffRequestCreated: handleTimeOffRequestCreated,
  handleCallOutUpdated:        handleCallOutUpdated,
  handleTimeOffRequestUpdated: handleTimeOffRequestUpdated,
  handleOpenShiftCreated:      handleOpenShiftCreated,
  handleOpenShiftUpdated:      handleOpenShiftUpdated
};
