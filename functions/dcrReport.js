/* Pioneer DCR Hub — tokenized customer DCR report module.
 *
 * Goal: the "View full report" link in customer DCR emails opens a
 * read-only, customer-safe page for that ONE DCR — no login, no admin
 * surface area, no internal notes.
 *
 * Security model:
 *   • Mint a 32-byte URL-safe random token per email send.
 *   • Store SHA-256(token) in `dcr_report_tokens/{tokenHash}` mapping to
 *     the DCR id. The raw token only ever appears in the email link.
 *   • Public read endpoint hashes the token from the query string and
 *     looks up the mapping; no auth required.
 *   • Customer-safe whitelist: returned JSON exposes ONLY presentation
 *     fields (customer name, clean date, tech display + photo, checklist
 *     done items, photos, customer-friendly issue summary, feedback URLs,
 *     report id). Internal notes / Slack / Zapier / Firebase paths /
 *     admin notes are never serialized.
 *
 * Click tracking:
 *   • Each successful read bumps `dcr_report_tokens/{hash}.view_count`,
 *     stamps `last_viewed_at`, and mirrors `report_viewed_at` /
 *     `report_view_count` / `last_report_viewed_at` onto the DCR doc so
 *     the admin Yesterday's Work panel can render the status without a
 *     second lookup.
 */

const crypto          = require("crypto");
const customerDisplay = require("./customerDisplay");

const TOKENS_COLLECTION = "dcr_report_tokens";
const DCR_COLLECTION    = "dcr_submissions";

const PROD_BASE_URL = "https://pioneer-dcr-hub.web.app";

function makeToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");
}

/* --------------------------------------------------------------------
 * mintReportToken
 *
 * Generates a new token + stores its hash. Called from sendDcrEmailCore
 * right after recipient resolution passes — one new token per send so a
 * re-send issues a fresh link (the old link still works; it's a separate
 * row in the tokens collection). Returns the raw token for the renderer.
 * ------------------------------------------------------------------ */
async function mintReportToken({ admin, db, dcrId, customerId, emailTo }) {
  if (!dcrId) throw new Error("mintReportToken: dcrId required");
  const rawToken  = makeToken();
  const tokenHash = hashToken(rawToken);
  const sts       = admin.firestore.FieldValue.serverTimestamp();
  await db.collection(TOKENS_COLLECTION).doc(tokenHash).set({
    dcr_submission_id: dcrId,
    customer_id:       customerId || null,
    email_to:          emailTo    || null,
    created_at:        sts,
    view_count:        0,
    last_viewed_at:    null
  }, { merge: false });
  // Stamp the raw URL on the DCR doc so admins can re-share without
  // re-minting. The raw token is intentionally written here too — admins
  // already have full read access to dcr_submissions, so anyone who can
  // see the doc was already entitled to share the URL.
  const reportUrl = PROD_BASE_URL + "/dcr-report.html?t=" + rawToken;
  await db.collection(DCR_COLLECTION).doc(dcrId).set({
    report_token_hash: tokenHash,
    report_url:        reportUrl,
    report_url_minted_at: sts,
    report_view_count: admin.firestore.FieldValue.increment(0)  // ensures field exists
  }, { merge: true });
  return { rawToken: rawToken, tokenHash: tokenHash, reportUrl: reportUrl };
}

/* --------------------------------------------------------------------
 * buildTechTenureLabel
 *
 * Computes the most precise tenure phrasing we can defend for this tech
 * at this customer. Pure read against dcr_submissions; gracefully
 * degrades when there's no history.
 *
 * Priority ladder (per the spec):
 *   visits >= 25                     → "Your regular Pioneer tech at this location"
 *   exact count + 12+ months tenure  → "Cleaning this location since {Month Year}"
 *   exact count                      → "{tech} has completed {N} visits at this location"
 *   2+ visits                        → "Part of the regular team at this location"
 *   1 visit (just this one)          → "Experienced Pioneer cleaning tech"
 *   no data                          → "Experienced Pioneer cleaning tech"
 * ------------------------------------------------------------------ */
async function buildTechTenureLabel({ db, techSlug, customerSlug, techName, currentDcrId }) {
  const slug = String(techSlug || "").trim();
  const cust = String(customerSlug || "").trim();
  if (!slug) return "Experienced Pioneer cleaning tech.";

  // Admin override path. cleaning_techs/{slug} can carry three optional
  // fields that take precedence over the computed history:
  //   • profileTagline                — global blurb for ALL DCRs by this tech
  //   • locationExperienceLabel       — { customer_slug: "<override string>" }
  //                                      map for per-location overrides
  //   • experienceMonthsAtCurrentAccounts
  //                                   — single number; trumps the visit
  //                                     count when ≥ 12 (years) or ≥ 6 (months)
  // When the office has authored a clean blurb, use it. Otherwise fall
  // through to the DCR-history heuristic.
  let techDoc = null;
  try {
    const t = await db.collection("cleaning_techs").doc(slug).get();
    if (t.exists) techDoc = t.data();
  } catch (_e) {}
  if (techDoc) {
    // Per-location override has highest priority — the office authored
    // this exact string for this exact account.
    if (cust && techDoc.locationExperienceLabel && typeof techDoc.locationExperienceLabel === "object") {
      const perLoc = techDoc.locationExperienceLabel[cust];
      if (typeof perLoc === "string" && perLoc.trim()) return perLoc.trim();
    }
    // Per-tech tagline second — applies to every DCR by this tech.
    if (typeof techDoc.profileTagline === "string" && techDoc.profileTagline.trim()) {
      return techDoc.profileTagline.trim();
    }
    // Months counter — admin's documented baseline of how long this tech
    // has been holding their current account roster. Trumps the DCR
    // history when the office set it.
    const months = Number(techDoc.experienceMonthsAtCurrentAccounts);
    if (Number.isFinite(months) && months >= 12) {
      const years = Math.floor(months / 12);
      return years + "+ year" + (years === 1 ? "" : "s") +
             " experience at current Pioneer locations.";
    }
    if (Number.isFinite(months) && months >= 6) {
      return "6+ months experience at current Pioneer locations.";
    }
  }

  // History-driven fallback. Counts THIS tech's DCRs at THIS customer.
  // Never returns "getting familiar" — the spec is explicit that we
  // default to seasoned-feeling copy and only acknowledge newness when
  // truly warranted (and even then, in calm terms).
  if (!cust) return "Experienced Pioneer cleaning tech.";
  let snap;
  try {
    snap = await db.collection(DCR_COLLECTION)
      .where("tech_slug",     "==", slug)
      .where("customer_slug", "==", cust)
      .get();
  } catch (_e) {
    return "Experienced Pioneer cleaning tech.";
  }
  const docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  const visitCount = docs.length;
  if (visitCount === 0) return "Experienced Pioneer cleaning tech.";

  let earliest = null;
  for (let i = 0; i < docs.length; i++) {
    const cd = String(docs[i].clean_date || "");
    if (!cd) continue;
    if (!earliest || cd < earliest) earliest = cd;
  }
  const monthsTenure = earliest ? monthsBetween(earliest, todayPacificDate()) : 0;

  if (visitCount >= 25) {
    return "Regular Pioneer tech at this location.";
  }
  if (earliest && monthsTenure >= 12) {
    const years = Math.floor(monthsTenure / 12);
    return years + "+ year" + (years === 1 ? "" : "s") +
           " experience at current Pioneer locations.";
  }
  if (earliest && monthsTenure >= 6) {
    return "6+ months experience at current Pioneer locations.";
  }
  if (visitCount >= 2) {
    return "Part of the regular Pioneer team for this location.";
  }
  return "Experienced Pioneer cleaning tech.";
}

function todayPacificDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function monthsBetween(earlyYmd, laterYmd) {
  if (!earlyYmd || !laterYmd) return 0;
  const [ey, em] = earlyYmd.split("-").map(Number);
  const [ly, lm] = laterYmd.split("-").map(Number);
  if (!ey || !ly) return 0;
  return (ly - ey) * 12 + (lm - em);
}
function formatMonthYear(yyyymmdd) {
  const [y, m] = yyyymmdd.split("-").map(Number);
  if (!y || !m) return yyyymmdd;
  const d = new Date(Date.UTC(y, m - 1, 15));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", month: "long", year: "numeric"
  }).format(d);
}
function formatHumanDate(yyyymmdd) {
  if (!yyyymmdd) return "";
  const d = new Date(yyyymmdd + "T12:00:00-07:00");
  if (isNaN(d.getTime())) return String(yyyymmdd);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  }).format(d);
}

/* --------------------------------------------------------------------
 * pickChecklist
 *
 * Same fallthrough logic as dcrEmail.js — top-level dcr.checklist if
 * it has substance, else form_data.checklist. Kept inline so the
 * report module has no dependency on the email module.
 * ------------------------------------------------------------------ */
function pickChecklistWithItems(primary, fallback) {
  function hasItems(arr) {
    if (!Array.isArray(arr)) return false;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s && Array.isArray(s.items) && s.items.length > 0) return true;
    }
    return false;
  }
  if (hasItems(primary))  return primary;
  if (hasItems(fallback)) return fallback;
  return Array.isArray(primary) ? primary : (Array.isArray(fallback) ? fallback : []);
}

/* --------------------------------------------------------------------
 * buildCustomerSafeShape
 *
 * The whitelist. Returns ONLY presentation fields. Internal-only fields
 * (admin notes, debug ids, slack/zapier metadata, internal issue notes
 * unless explicitly customerVisible:true) are dropped.
 *
 * Issue visibility rules (pilot V1):
 *   green tier  → "All clear — no issues to report."
 *   yellow tier → use issueRouting.shortSummary OR a generic friendly note
 *   red tier    → suppressed unless any dcr_issues doc has customerVisible:true
 *                  (no current docs do — surface a soft acknowledgement)
 * ------------------------------------------------------------------ */
function buildCustomerSafeShape({ dcr, customer, tenureLabel, reportUrl }) {
  const formData = dcr.form_data || {};
  const aff      = dcr.affirmation || {};
  const checklist = pickChecklistWithItems(dcr.checklist, formData.checklist);

  // Done items per section — completed only, no red Xs / N/A clutter.
  const checklistSections = checklist.map(function (sec) {
    if (!sec || !Array.isArray(sec.items)) return null;
    const doneItems = sec.items
      .filter(function (it) { return it && String(it.status || "").toLowerCase() === "done"; })
      .map(function (it) { return String(it.label || it.item_id || "").trim(); })
      .filter(Boolean);
    if (doneItems.length === 0) return null;
    return {
      section_label: String(sec.section_label || sec.section_id || "Cleaning"),
      done_items:    doneItems
    };
  }).filter(Boolean);

  // Photos — flatten the two storage shapes (`photo_urls[]` strings OR
  // `photos[]` objects with `url`). Caption is optional.
  let photos = [];
  if (Array.isArray(dcr.photo_urls)) {
    photos = dcr.photo_urls.map(function (u, i) {
      return { url: String(u), caption: "Photo " + (i + 1) };
    });
  } else if (Array.isArray(dcr.photos)) {
    photos = dcr.photos.map(function (p, i) {
      return {
        url: String(p && (p.url || p.publicUrl || p.downloadURL) || ""),
        caption: String((p && (p.caption || p.label)) || ("Photo " + (i + 1)))
      };
    }).filter(function (p) { return !!p.url; });
  }

  // Issue tier + customer-facing message.
  const tier = String(
    (dcr.issueRouting && dcr.issueRouting.tier) ||
    dcr.issueTier ||
    "green"
  ).toLowerCase();
  let issueMessage = "All clear — no issues to report tonight.";
  if (tier === "yellow") {
    const summary = (dcr.issueRouting && dcr.issueRouting.shortSummary) || "";
    issueMessage = summary
      ? summary
      : "A note for your team is included with this visit. We'll follow up if anything needs your attention.";
  } else if (tier === "red") {
    // Hide internal detail. Acknowledge softly. Admins can edit copy on
    // a per-DCR basis later if a public-safe red message is needed.
    issueMessage = "Pioneer is following up on this visit internally. Reach out to info@pioneercomclean.com if you'd like the details.";
  }

  // Canonical customer display via the shared helper. Honors
  // displayNameMode + customDisplayName when present on the customer
  // doc; falls back to dcr.customer_name (the historical write).
  const helperCustomerName = (customer && customerDisplay.getCustomerDisplayName(customer)) || "";

  // Customer-facing summary — prefer dcr.generatedSummary (AI), else
  // a deterministic stub. Internal-only fields like emailError, htmlPreview
  // never enter this shape.
  const summary = String(
    dcr.generatedSummary ||
    ((dcr.tech_display_name || "Your tech") +
      " completed the visit at " +
      (helperCustomerName || dcr.customer_name || "your location") + ".")
  );

  // Signed off-site time — prefer affirmation timestamps if present.
  const signedOffAt = aff.signed_at_iso || dcr.clean_ended_at || null;

  // Feedback links — already exist in the codebase. We thread the
  // tokenized report URL through so the feedback page can deep-link
  // back to the report if needed. The base feedback URLs are kept
  // unchanged so existing routing keeps working.
  const FEEDBACK_BASE = PROD_BASE_URL;
  const compEsc = encodeURIComponent(dcr.submission_id);
  const custEsc = encodeURIComponent(dcr.customer_slug || (customer && customer.customer_slug) || "");
  const techEsc = encodeURIComponent(dcr.tech_slug || "");

  return {
    report_id:        dcr.submission_id || dcr.id || "",
    customer_name:    helperCustomerName || dcr.customer_name || "",
    clean_date:       dcr.clean_date || "",
    clean_date_human: formatHumanDate(dcr.clean_date || ""),
    tech: {
      display_name:  dcr.tech_display_name || "Your Pioneer cleaning tech",
      photo_url:     String(aff.tech_photo_url || dcr.tech_photo_url || "") || null,
      signature_url: String(aff.signature_url  || "") || null,
      tenure_label:  tenureLabel || "Experienced Pioneer cleaning tech."
    },
    signed_off_at:    signedOffAt,
    summary:          summary,
    checklist:        checklistSections,
    photos:           photos,
    issue: {
      tier:    tier === "red" ? "red" : (tier === "yellow" ? "yellow" : "green"),
      message: issueMessage
    },
    feedback: {
      compliment_url: FEEDBACK_BASE + "/feedback-compliment.html?dcrId=" + compEsc + "&customerId=" + custEsc + "&techId=" + techEsc,
      issue_url:      FEEDBACK_BASE + "/feedback-issue.html?dcrId="      + compEsc + "&customerId=" + custEsc + "&techId=" + techEsc
    },
    report_url:       reportUrl
  };
}

/* --------------------------------------------------------------------
 * getDcrReportByToken
 *
 * Public read by token. Returns customer-safe payload or {ok:false}.
 * Increments view count + stamps `last_viewed_at` on token doc and
 * mirrors `report_viewed_at` / `report_view_count` / `last_report_viewed_at`
 * onto the DCR doc.
 * ------------------------------------------------------------------ */
async function getDcrReportByToken({ admin, db, rawToken }) {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 16) {
    return { ok: false, code: "bad_token", error: "Invalid or missing token." };
  }
  const tokenHash = hashToken(rawToken);
  let tokenSnap;
  try {
    tokenSnap = await db.collection(TOKENS_COLLECTION).doc(tokenHash).get();
  } catch (err) {
    return { ok: false, code: "token_lookup_failed", error: (err && err.message) || "unknown" };
  }
  if (!tokenSnap.exists) {
    return { ok: false, code: "token_not_found", error: "This report link is invalid or has expired." };
  }
  const tokenDoc = tokenSnap.data() || {};
  const dcrId    = tokenDoc.dcr_submission_id;
  if (!dcrId) {
    return { ok: false, code: "token_orphan", error: "This report link is invalid." };
  }
  const dcrSnap = await db.collection(DCR_COLLECTION).doc(dcrId).get();
  if (!dcrSnap.exists) {
    return { ok: false, code: "dcr_not_found", error: "Report not found." };
  }
  const dcr = dcrSnap.data() || {};

  // Customer lookup (optional — many fields fall back to dcr.customer_*).
  let customer = null;
  if (dcr.customer_slug) {
    try {
      const c = await db.collection("customers").doc(dcr.customer_slug).get();
      if (c.exists) customer = c.data();
    } catch (_e) {}
  }

  // Tenure — never blocks the response on failure.
  let tenureLabel = "Experienced Pioneer cleaning tech.";
  try {
    tenureLabel = await buildTechTenureLabel({
      db,
      techSlug:     dcr.tech_slug,
      customerSlug: dcr.customer_slug,
      techName:     dcr.tech_display_name,
      currentDcrId: dcrId
    });
  } catch (_e) {}

  // Construct report URL from the raw token (we don't trust dcr.report_url
  // since multiple tokens may map to the same DCR if minted on resend).
  const reportUrl = PROD_BASE_URL + "/dcr-report.html?t=" + rawToken;
  const report = buildCustomerSafeShape({ dcr, customer, tenureLabel, reportUrl });

  // Click tracking — best-effort, never blocks the response.
  const sts = admin.firestore.FieldValue.serverTimestamp();
  try {
    await db.collection(TOKENS_COLLECTION).doc(tokenHash).set({
      view_count:     admin.firestore.FieldValue.increment(1),
      last_viewed_at: sts
    }, { merge: true });
    await db.collection(DCR_COLLECTION).doc(dcrId).set({
      report_view_count:     admin.firestore.FieldValue.increment(1),
      last_report_viewed_at: sts,
      report_viewed_at:      dcr.report_viewed_at || sts
    }, { merge: true });
  } catch (_e) {}

  return { ok: true, report: report };
}

module.exports = {
  mintReportToken:      mintReportToken,
  getDcrReportByToken:  getDcrReportByToken,
  buildTechTenureLabel: buildTechTenureLabel,
  // exported for unit-testable email-side use
  _internal: {
    hashToken:               hashToken,
    pickChecklistWithItems:  pickChecklistWithItems,
    buildCustomerSafeShape:  buildCustomerSafeShape,
    formatHumanDate:         formatHumanDate,
    formatMonthYear:         formatMonthYear,
    monthsBetween:           monthsBetween
  }
};
