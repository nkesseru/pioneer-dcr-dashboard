/* ============================================================================
 * dcrEmail.js — PioneerOps native DCR customer email pipeline.
 *
 * Replaces the Zapier-based DCR email path. Owns the full lifecycle:
 *   1. Load dcr_submissions/{dcrId} + customers/{customerId} (+ optional tech).
 *   2. Normalize the doc into a flat object the prompt + template understand.
 *   3. Ask OpenAI for a concise customer-facing summary (with a deterministic
 *      template fallback when the API call fails).
 *   4. Build the premium HTML email.
 *   5. Send it via Gmail API using a service account with domain-wide
 *      delegation (impersonating the Pioneer sender address).
 *   6. Write status back to the DCR doc: emailStatus, emailedAt, emailTo,
 *      emailSubject, generatedSummary, htmlPreview, error.
 *
 * Exported builder: buildHttpHandler({ admin, db, secrets, allowedAdminEmails,
 *                                      verifyStaffOrReject }).
 * functions/index.js calls buildHttpHandler() and wraps the result in onRequest()
 * so the request/response + secrets binding stay in one place there.
 *
 * SCOPE — first working email, not the final system:
 *   • Admin-only (verifyStaffOrReject + isAdmin flag).
 *   • Single test DCR at a time. Manual trigger.
 *   • Zapier is NOT touched by this module.
 *   • If customers.dcr_email_enabled === false → emailStatus = "skipped".
 *
 * Secrets used (declared in functions/index.js):
 *   OPENAI_API_KEY                    — string, OpenAI API token.
 *   GMAIL_SENDER_EMAIL                — string, e.g. dcr@pioneercomclean.com.
 *                                       Must be a user in the Workspace tenant.
 *   GMAIL_SERVICE_ACCOUNT_KEY         — JSON string of a service account key
 *                                       with domain-wide delegation enabled
 *                                       for scope https://www.googleapis.com/auth/gmail.send
 * ========================================================================== */

const { google } = require("googleapis");
const dcrReport       = require("./dcrReport");
const customerDisplay = require("./customerDisplay");

// ---- Pioneer brand strings used in the template ----
const PIONEER_BRAND_NAME    = "Pioneer Commercial Cleaning";
const PIONEER_PRIMARY_HEX   = "#0d9488";  // accent (foundation --accent)
const PIONEER_INK_HEX       = "#0f172a";  // dark text
const PIONEER_MUTED_HEX     = "#475569";  // muted body text
const PIONEER_BG_SOFT_HEX   = "#f8fafc";  // panel background
const PIONEER_SUCCESS_HEX   = "#047857";  // OK green
const PIONEER_ATTN_HEX      = "#b45309";  // amber

// Feedback URL placeholders — the Phase 2 feedback router will sit at
// /feedback/compliment and /feedback/problem. For now they're plain
// links the function bakes into the email; clicking just lands on the
// hosting site with the dcrId in the URL.
const FEEDBACK_BASE         = "https://pioneer-dcr-hub.web.app";

// ---- V2 Pioneer brand palette ----
// Refreshed palette used by renderDcrEmailHtmlV2. Held alongside the
// V1 strings above so V1 helpers stay byte-for-byte unchanged; the V2
// renderer reads ONLY the V2_ values below.
const V2_INK         = "#1F1F24";  // dark charcoal
const V2_SURFACE     = "#F5F7FA";  // soft white page background
const V2_TEAL        = "#71E1D1";  // Pioneer teal accent
const V2_MUTED       = "#8A9099";  // warm gray body copy
const V2_SUCCESS     = "#34C759";  // service note green
const V2_WARNING     = "#F5B942";  // service note amber
const V2_SOFT_RED    = "#E36D6D";  // service note red
const V2_CARD_BG     = "#FFFFFF";  // card surface
const V2_CARD_BORDER = "#E6E9EE";  // hairline divider
const V2_LOGO_URL    = "https://pioneer-dcr-hub.web.app/assets/pioneer-logo2.png";

// ---- V2 prompt + model versioning ----
// Bump PROMPT_VERSION_V2 when the prompt rules change. Stored on every
// dcr_email_payloads doc so future audits can pinpoint which prompt
// generation produced a given email. OPENAI_MODEL_V2 is the model id
// passed to the chat completions endpoint AND echoed back into the
// payload doc for the same reason.
const PROMPT_VERSION_V2 = "v2.8-trust-loop-v5";
const OPENAI_MODEL_V2   = "gpt-4o-mini";

/* ----------------------------------------------------------------------------
 * normalizeDcrForEmail
 *
 * Flatten the raw Firestore documents into a single object the prompt
 * and the HTML template can both consume. Keep ALL field names already
 * used elsewhere in the codebase (clean_date, photo_urls, affirmation.*)
 * so the template stays grep-able against the existing schema.
 * --------------------------------------------------------------------------- */
// ---- Field-coalesce helpers ----
// The DCR data has gone through three different shapes over the
// project's life (snake_case from submitDcrV1, camelCase from earlier
// integrations, mixed nested objects from imports). To avoid a brittle
// "field A only" lookup, every loadable signal walks a list of candidate
// field names and returns the first one that's a usable string / URL.
//
// `_pickedFromV2` (logged but not rendered) records WHICH candidate
// supplied each value so audits can answer "why is the signature
// missing on this email?" without grepping the raw doc.
function v2FirstString(obj, candidatePath) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < candidatePath.length; i++) {
    const path = candidatePath[i];
    // Allow nested "a.b.c" lookups.
    const parts = path.split(".");
    let cur = obj;
    let bad = false;
    for (let p = 0; p < parts.length; p++) {
      if (cur == null || typeof cur !== "object") { bad = true; break; }
      cur = cur[parts[p]];
    }
    if (bad) continue;
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return "";
}
function v2FirstHttpsString(obj, candidatePath) {
  const s = v2FirstString(obj, candidatePath);
  return /^https?:\/\//.test(s) ? s : "";
}

// Same lookup but records WHICH path supplied the value. Returns
// { value, source } where source is the matched candidate path or
// "" when no candidate produced a usable URL. Used for the V4
// debug field `techPhotoLookupSource` so an audit can answer
// "why is the photo missing on this email?" without re-grepping
// the raw doc.
function v2FirstHttpsStringWithSource(obj, candidatePath) {
  if (!obj || typeof obj !== "object") return { value: "", source: "" };
  for (let i = 0; i < candidatePath.length; i++) {
    const path  = candidatePath[i];
    const parts = path.split(".");
    let cur = obj;
    let bad = false;
    for (let p = 0; p < parts.length; p++) {
      if (cur == null || typeof cur !== "object") { bad = true; break; }
      cur = cur[parts[p]];
    }
    if (bad) continue;
    if (typeof cur === "string" && cur.trim() && /^https?:\/\//.test(cur.trim())) {
      return { value: cur.trim(), source: path };
    }
  }
  return { value: "", source: "" };
}

// Walk every plausible photo location on the DCR doc and return
// caption-aware entries `[{ url, zone, timestamp }]`. Entries with
// just a URL still flow through; zone/timestamp default to "".
//
// The renderer uses zone + timestamp to produce captions like
// "Reception · 9:14 PM" when the data is present, and falls back to
// "After-photo" otherwise. This keeps the customer-facing email
// evidentiary rather than decorative.
function v2ExtractPhotoEntries(dcr) {
  const out = [];
  const seen = Object.create(null);
  // Rich-shape fields go FIRST so when both rich (photos[]) and flat
  // (photo_urls[]) representations exist on the same DCR, the rich
  // entries (carrying zone + timestamp) win the URL-dedupe race.
  // Without this ordering, flat URLs land first and the matching
  // rich entries get dropped by seen[url] — V5 captions then fall
  // back to "After-photo" even when zone metadata is present.
  const candidates = [
    "photos",
    "media",
    "attachments",
    "uploadedPhotos", "uploaded_photos",
    "beforeAfterPhotos", "before_after_photos",
    "photo_urls", "photoUrls",
    "imageUrls", "image_urls"
  ];
  for (let i = 0; i < candidates.length; i++) {
    const v = dcr && dcr[candidates[i]];
    if (!Array.isArray(v)) continue;
    for (let j = 0; j < v.length; j++) {
      const item = v[j];
      let url      = "";
      let zone     = "";
      let timestamp = "";
      if (typeof item === "string") {
        url = item.trim();
      } else if (item && typeof item === "object") {
        url = String(item.url || item.downloadUrl || item.download_url ||
                     item.src || item.imageUrl || item.image_url || "").trim();
        // Caption metadata — accept any of the plausible field names
        // Pioneer's upload paths have used over time. First non-empty
        // string wins.
        zone = String(
          item.zone || item.area || item.section || item.label ||
          item.location || item.zoneName || item.zone_name || ""
        ).trim();
        timestamp = String(
          item.timestamp || item.takenAt || item.taken_at ||
          item.uploadedAt || item.uploaded_at || item.capturedAt ||
          item.captured_at || item.createdAt || item.created_at || ""
        ).trim();
      }
      if (url && /^https?:\/\//.test(url) && !seen[url]) {
        seen[url] = true;
        out.push({ url: url, zone: zone, timestamp: timestamp });
      }
    }
  }
  return out;
}

// Back-compat thin wrapper — returns URL strings only. Existing
// callers (V1/V2 renderers, dcr_email_payloads.photoUrlCount, etc.)
// keep working without changes.
function v2ExtractPhotoUrls(dcr) {
  return v2ExtractPhotoEntries(dcr).map(function (p) { return p.url; });
}

// Pilot v20260527-checklist-fallthrough — Pioneer's DCR submit pipeline
// writes the live checklist to `dcr.form_data.checklist` and writes an
// EMPTY array to top-level `dcr.checklist`. The naive ternary
// `Array.isArray(dcr.checklist) ? dcr.checklist : form_data.checklist`
// matches the empty array as "an array" and never falls through —
// stranding three call sites (renderer, has-concerns detector,
// readiness gate) on an empty list. This helper picks whichever
// source actually has item-bearing sections, preferring the top-level
// (for forward-compat) but falling back to form_data when top-level is
// empty or items-less. Both inputs may be null/undefined.
function pickChecklistWithItems(primary, fallback) {
  function hasItems(arr) {
    if (!Array.isArray(arr)) return false;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s && Array.isArray(s.items) && s.items.length > 0) return true;
    }
    return false;
  }
  if (hasItems(primary))   return primary;
  if (hasItems(fallback))  return fallback;
  return Array.isArray(primary) ? primary : (Array.isArray(fallback) ? fallback : []);
}

function normalizeDcrForEmail(dcr, customer, tech) {
  const formData    = (dcr && dcr.form_data) || {};
  const affirmation = (dcr && dcr.affirmation) || {};
  const checklist   = pickChecklistWithItems(dcr.checklist, formData.checklist);

  // ---- Cleaning summary surface: only completed tasks (no "❌ not done") ----
  // The customer-facing email omits issue / N/A clutter per the spec
  // ("omit incomplete/unchecked tasks; no red X clutter"). Issues are
  // surfaced separately in their own block when they have notes.
  //
  // V4 additions:
  //   taskDoneCount   — items with status === "done"
  //   taskTotalCount  — total items in the checklist (done + issue + na)
  // These power the V4 "Tasks 27/27" / "Scope: Complete" trust-strip
  // tile. Computed once here so the renderer doesn't re-walk the
  // checklist.
  const completedItems = [];
  const issueItems     = [];
  let taskDoneCount  = 0;
  let taskTotalCount = 0;
  checklist.forEach(function (section) {
    if (!section || !Array.isArray(section.items)) return;
    section.items.forEach(function (item) {
      const status = String(item && item.status || "").toLowerCase();
      const label  = String(item && item.label || "").trim();
      if (!label) return;
      taskTotalCount += 1;
      if (status === "done") {
        taskDoneCount += 1;
        completedItems.push({ section: section.label || "", label: label });
      } else if (status === "issue") {
        const note = String(item.note || "").trim();
        if (note) {
          issueItems.push({ section: section.label || "", label: label, note: note });
        }
      }
      // status === "na" / unset → counted in total but not as "done".
    });
  });

  // ---- Problem block (separate from per-item issues) ----
  const problemBlock = (formData.has_problem && formData.problem)
    ? {
        summary:   String(formData.problem.summary  || "").trim(),
        details:   String(formData.problem.details  || "").trim(),
        location:  String(formData.problem.location || "").trim(),
        ourFault:  formData.problem.our_fault === true
      }
    : null;

  // ---- Supplies block — internal flag, but include when the tech
  // requested anything so the customer sees expected restock items. ----
  const suppliesBlock = (formData.needs_supplies && formData.supply_request_text)
    ? { items: String(formData.supply_request_text).trim() }
    : null;

  // ---- V6 issue-routing — derives a single tier (green|yellow|red)
  // from the DCR fields the office uses to triage. The customer-facing
  // renderer keys off this tier (red shows fixed minimal text; yellow
  // shows a calm customer-safe note; green hides the alert card).
  //
  // Sources, in order of precedence:
  //   1. dcr.issueTier (explicit; admin/tech can set directly)
  //   2. dcr.wasThereAProblem + dcr.causedByTeam (V6 canonical fields)
  //   3. derived from legacy form_data.has_problem + problem.our_fault
  //      + checklist issue items (still works for older DCRs that
  //      pre-date the V6 fields).
  //
  // Sibling flags carried for the renderer + notifications:
  //   customerVisible        — explicit; defaults to true for yellow,
  //                             true for red (always notify customer),
  //                             false for green
  //   customerAlertMessage   — explicit text the renderer uses for
  //                             yellow notes (red ignores it; spec
  //                             requires fixed text for red)
  //   internalNotes          — admin-only, never rendered to customer
  //   shortSummary           — admin-only triage label
  const issueRouting = (function () {
    const explicitTier = String(dcr.issueTier || "").toLowerCase().trim();
    const wasProblem = (dcr.wasThereAProblem === true) ||
                       (formData.wasThereAProblem === true) ||
                       (formData.has_problem === true);
    const causedByTeam = (dcr.causedByTeam === true) ||
                         (formData.causedByTeam === true) ||
                         (formData.problem && formData.problem.our_fault === true);
    const hasIssueItems = (issueItems && issueItems.length > 0);

    let tier;
    if (explicitTier === "red" || explicitTier === "yellow" || explicitTier === "green") {
      tier = explicitTier;
    } else if (!wasProblem && !hasIssueItems && !problemBlock) {
      tier = "green";
    } else if (causedByTeam) {
      tier = "red";
    } else {
      tier = "yellow";
    }

    // customerVisible — explicit overrides everything. Defaults: red is
    // always customer-visible (we say something), green is never (no
    // alert card), yellow defers to the explicit field, defaulting
    // true when unset.
    let customerVisible;
    if (typeof dcr.customerVisible === "boolean") {
      customerVisible = dcr.customerVisible;
    } else if (typeof formData.customerVisible === "boolean") {
      customerVisible = formData.customerVisible;
    } else {
      customerVisible = (tier !== "green");
    }

    return {
      tier:                 tier,
      wasThereAProblem:     !!wasProblem,
      problemCategory:      String(dcr.problemCategory || formData.problemCategory || "").trim(),
      causedByTeam:         !!causedByTeam,
      customerVisible:      customerVisible,
      customerAlertMessage: String(dcr.customerAlertMessage || formData.customerAlertMessage || "").trim(),
      internalNotes:        String(dcr.internalNotes || formData.internalNotes || "").trim(),
      shortSummary:         String(dcr.shortSummary || formData.shortSummary || "").trim(),
      tierDerivedFrom:      explicitTier ? "explicit" :
                              (!wasProblem && !hasIssueItems && !problemBlock) ? "no_problem_signals" :
                              causedByTeam ? "caused_by_team" : "default_yellow"
    };
  })();

  // ---- Time budget — over-budget is the only operationally interesting state ----
  const overBudget = formData.on_time_budget === false;
  const timeBudgetBlock = overBudget
    ? { onBudget: false, reasons: Array.isArray(formData.time_budget_reasons) ? formData.time_budget_reasons : [] }
    : null;

  // ---- Photos — walk every plausible field name + object shape ----
  // photoEntries carries optional zone/timestamp metadata so the V4
  // renderer can produce captions like "Reception · 9:14 PM" when the
  // data exists. photoUrls is a URL-only view used by V1/V2/V3 paths
  // and for the photoUrlCount audit field.
  const photoEntries = v2ExtractPhotoEntries(dcr);
  const photoUrls    = photoEntries.map(function (p) { return p.url; });

  // ---- Tech photo — coalesce across snake_case + camelCase variants
  // on the cleaning_techs doc. If a future field name lands, append it
  // here in one place. We use the with-source variant so the debug
  // field `techPhotoLookupSource` records exactly which field name
  // supplied the URL — auditable in dcr_email_payloads. ----
  const techPhotoLookup = v2FirstHttpsStringWithSource(tech || {}, [
    "photo_url", "photoUrl",
    "profile_photo_url", "profilePhotoUrl",
    "avatar_url", "avatarUrl",
    "image_url", "imageUrl",
    // V5 additions — workspace/identity-system photo paths.
    "badgePhotoUrl", "badge_photo_url",
    "uniformPhotoUrl", "uniform_photo_url"
  ]);
  const techPhotoUrl          = techPhotoLookup.value;
  const techPhotoLookupSource = techPhotoLookup.source;

  // ---- Tech signature — DCR-first per the V5 spec ("signature can
  // change per visit"). The submission's affirmation block is the
  // canonical signal; we walk every plausible DCR-level field name
  // before falling back to the cleaning_techs doc. The picked path
  // is captured on `_pickedFromV2.signatureLookupSource` and
  // persisted on the payload doc so an audit can answer "where did
  // this signature come from?" without re-grepping the raw doc. ----
  const signatureLookup = v2FirstHttpsStringWithSource({ aff: affirmation, dcr: dcr, tech: tech || {} }, [
    // Modern primary path (submitDcrV1).
    "aff.signature_url", "aff.signatureUrl",
    // Nested-object variants. Some imports store the signature as
    // { url, uploaded_at, … } rather than a bare URL string.
    "dcr.affirmation.signatureUrl",
    "dcr.signature.url",
    "dcr.cleanTechSignature.url",
    "dcr.clean_tech_signature.url",
    // DCR-level variants — full V5 enumeration.
    "dcr.signatureUrl",          "dcr.signature_url",
    "dcr.techSignatureUrl",      "dcr.tech_signature_url",
    "dcr.cleanTechSignatureUrl", "dcr.clean_tech_signature_url",
    "dcr.cleanTechSignature",    "dcr.clean_tech_signature",
    "dcr.cleanTechSignature_url",
    "dcr.technicianSignatureUrl",
    // Tech-level fallback — only consulted when no DCR-level URL
    // resolved. Visit-specific signatures (the spec's primary intent)
    // always beat the tech's stored default.
    "tech.signature_url",     "tech.signatureUrl",
    "tech.profile_signature_url", "tech.profileSignatureUrl"
  ]);
  const signatureUrl          = signatureLookup.value;
  const signatureLookupSource = signatureLookup.source;
  const signatureName = String(affirmation.signature_name || affirmation.signatureName || "").trim();

  // ---- On-site duration — derive from any plausible start-time field
  // paired with the submission timestamp. The submitDcrV1 path doesn't
  // currently capture a start time, but several flows (Deputy-link,
  // manual imports) carry it under different names. When neither side
  // resolves to a real Date, the duration is null and the V4 tile is
  // simply skipped. No fabricated values. ----
  const submittedMs = trustTsMs(
    (dcr.submission_meta && dcr.submission_meta.client_submitted_at) ||
    dcr.submitted_at || formData.submitted_at || formData.client_submitted_at
  );
  const startMs = trustTsMs(
    dcr.start_time || dcr.client_started_at || dcr.startedAt ||
    formData.start_time || formData.client_started_at || formData.startedAt
  );
  let onSiteDurationMs = null;
  if (startMs && submittedMs && submittedMs > startMs) {
    const diff = submittedMs - startMs;
    // Sanity-cap to avoid surfacing a multi-day duration on a bad data
    // import. Anything over 12 hours is almost certainly garbage; show
    // nothing rather than something misleading.
    if (diff > 0 && diff < 12 * 60 * 60 * 1000) onSiteDurationMs = diff;
  }

  // ---- Diagnostic — log which field supplied each visual asset so a
  // missing photo / avatar / signature is debuggable from Cloud Logs
  // without re-reading the raw doc. ----
  const pickedFromV2 = {
    photoUrls_count:        photoUrls.length,
    photoUrls_first:        photoUrls[0] || "",
    photoEntries_with_zone: photoEntries.filter(function (p) { return p.zone; }).length,
    techPhotoUrl_found:     !!techPhotoUrl,
    techPhotoLookupSource:  techPhotoLookupSource || "none",
    signatureUrl_found:     !!signatureUrl,
    signature_source:       signatureUrl ? "found" : "none",
    signatureLookupSource:  signatureLookupSource || "none",
    onSiteDurationMs:       onSiteDurationMs,
    onSiteDurationSource:   (startMs && submittedMs && onSiteDurationMs) ? "form_data/start_time" : "none"
  };

  return {
    dcrId:           String(dcr.id || dcr.submission_id || ""),
    customerId:      String(customer && (customer.customer_slug || customer.id) || ""),
    customerName:    String(
      (customer && customerDisplay.getCustomerDisplayName(customer)) ||
      (customer && (customer.customer_name || customer.name)) ||
      dcr.customer_name ||
      "Valued customer"
    ),
    // Primary single email (kept for back-compat with code paths that
    // expect a scalar). The renderer + sender prefer customerEmailRecipients.
    customerEmail:   String(
      (customer && (customer.customer_email || customer.primaryEmail || customer.primary_email || customer.email)) ||
      dcr.customer_email || ""
    ),
    // V6 — full recipient list. Reads dcrEmailRecipients[] first
    // (canonical multi-recipient field), then falls back to the single
    // primaryEmail / customer_email path so legacy customers keep
    // working without any data migration.
    customerEmailRecipients: (function () {
      const out = [];
      const seen = Object.create(null);
      const push = function (raw) {
        const e = String(raw || "").trim().toLowerCase();
        if (e && !seen[e] && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
          seen[e] = true;
          out.push(e);
        }
      };
      if (customer && Array.isArray(customer.dcrEmailRecipients)) {
        customer.dcrEmailRecipients.forEach(push);
      }
      if (customer && Array.isArray(customer.dcr_email_recipients)) {
        customer.dcr_email_recipients.forEach(push);
      }
      // Singular fallbacks — only consulted when the array path
      // didn't produce anything.
      if (out.length === 0) {
        push(customer && (customer.customer_email || customer.primaryEmail || customer.primary_email || customer.email));
        push(dcr.customer_email);
      }
      return out;
    })(),
    customerEmailEnabled: customer
      ? (customer.dcrEmailEnabled !== false && customer.dcr_email_enabled !== false)
      : (dcr.customer_dcr_email_enabled !== false),

    cleaningDate:    String(dcr.clean_date || dcr.cleaningDate || ""),
    submittedAt:     dcr.submission_meta && dcr.submission_meta.client_submitted_at || null,

    // V6 pilot — customer config aliases.
    // locationDisplayName overrides customer_name purely for the
    // email's customer-facing strings (the "TO" address still comes
    // from the email-recipients resolution below). When unset, the
    // existing customer_name flow wins.
    customerLocationName: String((customer && (customer.locationDisplayName || customer.location_display_name)) || "").trim(),

    techName:        String((tech && (tech.display_name || tech.displayName)) || dcr.tech_display_name || dcr.techDisplayName || "").trim(),
    // techSlug — threaded into the customer-facing feedback links so
    // submitFeedbackV1 can resolve the cleaning_techs doc server-side
    // and persist denormalized tech identity on the feedback record.
    techSlug:        String((tech && (tech.tech_slug || tech.id)) || dcr.tech_slug || "").trim(),
    techPhotoUrl:    techPhotoUrl,

    signatureUrl:    signatureUrl,
    signatureName:   signatureName,

    completedItems:  completedItems,
    issueItems:      issueItems,
    taskDoneCount:   taskDoneCount,
    taskTotalCount:  taskTotalCount,
    problem:         problemBlock,
    issueRouting:    issueRouting,
    supplies:        suppliesBlock,
    timeBudget:      timeBudgetBlock,
    occupancy:       String(dcr.occupancy || formData.occupancy_level || "").trim(),
    notes:           String(dcr.notes || "").trim(),

    photoUrls:       photoUrls,
    photoEntries:    photoEntries,
    photoCount:      photoUrls.length,

    // V4 Phase 1 additions — surface lookups + derived metrics on the
    // normalized object so the renderer + persistence layer can read
    // them without re-walking the raw DCR.
    techPhotoLookupSource: techPhotoLookupSource,
    signatureLookupSource: signatureLookupSource,
    onSiteDurationMs:      onSiteDurationMs,

    // V5 — next-clean lookup. Best-effort across customer + DCR field
    // shapes; null when no plausible upcoming-visit timestamp resolves.
    // The renderer emits the line only when this is populated AND the
    // resolved time is in the future (no rendering of stale dates).
    nextCleanAtMs:         (function () {
      const candidates = [
        customer && customer.next_clean_at,
        customer && customer.nextCleanAt,
        customer && customer.next_clean_date,
        customer && customer.nextCleanDate,
        customer && customer.next_visit_at,
        customer && customer.nextVisitAt,
        customer && customer.next_service_at,
        customer && customer.nextServiceAt,
        customer && customer.scheduled_next_clean,
        customer && customer.scheduledNextClean,
        dcr.next_clean_at,    dcr.nextCleanAt,
        dcr.next_clean_date,  dcr.nextCleanDate,
        formData.next_clean_at, formData.nextCleanAt
      ];
      for (let i = 0; i < candidates.length; i++) {
        const ms = trustTsMs(candidates[i]);
        if (ms && ms > Date.now()) return ms;
      }
      return null;
    })(),

    _pickedFromV2:   pickedFromV2
  };
}

/* ----------------------------------------------------------------------------
 * createDcrEmailPrompt
 *
 * Builds the OpenAI prompt. Goal: 2-3 sentence customer-facing summary,
 * Apple-meets-Uber tone, trust + accountability, never reads as internal
 * jargon. Returns { system, user } so the caller can hand both to the
 * chat completions endpoint.
 * --------------------------------------------------------------------------- */
function createDcrEmailPrompt(n) {
  const system =
    "You write short, premium, customer-facing summaries of a commercial cleaning visit. " +
    "Tone is Apple-meets-Uber: confident, calm, accountable, and warm. No emojis. " +
    "No internal jargon, no checklist counts, no 'tasks completed' phrasing. " +
    "Never mention items that weren't done. " +
    "Speak directly to the customer using 'your space' or the building name when natural. " +
    "Output 2 to 3 sentences total. Plain text — no Markdown.";

  // Build a structured-but-compact data block so the model has crisp
  // grounding without 1000+ tokens of noise.
  const completedSamples = (n.completedItems || []).slice(0, 8)
    .map(function (it) { return it.section ? (it.section + ": " + it.label) : it.label; });

  const lines = [];
  lines.push("Customer: " + (n.customerName || "the customer"));
  lines.push("Cleaning date: " + (n.cleaningDate || "today"));
  if (n.techName) lines.push("Tech: " + n.techName);
  if (completedSamples.length) {
    lines.push("Completed work (highlights): " + completedSamples.join("; "));
  }
  if (n.issueItems && n.issueItems.length) {
    const top = n.issueItems.slice(0, 3).map(function (i) {
      return i.label + " (" + (i.note || "noted") + ")";
    });
    lines.push("Items flagged for follow-up: " + top.join("; "));
  }
  if (n.problem && (n.problem.summary || n.problem.details)) {
    lines.push("Issue reported by tech: " +
      (n.problem.summary || n.problem.details) +
      (n.problem.location ? " (" + n.problem.location + ")" : ""));
  }
  if (n.notes) lines.push("Tech's notes to the office: " + n.notes);

  const user =
    "Write the 2-3 sentence summary for this visit. Keep it concise and " +
    "premium. Do not list items. Do not invent details not present below. " +
    "If there are flagged items, acknowledge them with care and confidence " +
    "but keep the overall tone reassuring.\n\n" +
    lines.join("\n");

  return { system: system, user: user };
}

/* ----------------------------------------------------------------------------
 * generateAiSummary
 *
 * Calls OpenAI Chat Completions via fetch. Returns a string. Falls back
 * to buildFallbackSummary if the API call fails (network, 4xx, etc.).
 * --------------------------------------------------------------------------- */
async function generateAiSummary(normalized, apiKey, logger) {
  if (!apiKey) {
    logger && logger.warn("[dcr-email] OPENAI_API_KEY not configured — using fallback summary");
    return buildFallbackSummary(normalized);
  }
  const prompt = createDcrEmailPrompt(normalized);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        // gpt-4o-mini is cost-efficient and consistent at this prompt scale.
        // Bump model later if a/b shows premium tone needs the larger model.
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user",   content: prompt.user }
        ],
        temperature: 0.4,
        max_tokens: 220
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(function () { return ""; });
      logger && logger.warn("[dcr-email] OpenAI " + res.status + " — falling back. body=" + errText.slice(0, 400));
      return buildFallbackSummary(normalized);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message &&
                    data.choices[0].message.content;
    if (!content || typeof content !== "string") return buildFallbackSummary(normalized);
    return content.trim();
  } catch (err) {
    logger && logger.warn("[dcr-email] OpenAI call failed — falling back:", err && err.message || err);
    return buildFallbackSummary(normalized);
  }
}

// Deterministic 2-sentence fallback when OpenAI is unavailable. Honest
// and brief — sounds like Pioneer, never wrong about facts.
function buildFallbackSummary(n) {
  const dateBit = n.cleaningDate ? (" on " + formatHumanDate(n.cleaningDate)) : "";
  const techBit = n.techName ? (n.techName + " cleaned your space" + dateBit + ".") :
                                ("Your space was cleaned" + dateBit + ".");
  if (n.issueItems && n.issueItems.length) {
    return techBit +
      " A couple of items were flagged for follow-up so the office can address them with you.";
  }
  if (n.problem && (n.problem.summary || n.problem.details)) {
    return techBit + " One thing the tech wanted to flag is included below.";
  }
  return techBit + " Photos and a quick recap are below.";
}

/* ----------------------------------------------------------------------------
 * generateDcrEmailHtmlV1
 *
 * Build the customer-facing HTML email. Inline styles only (email clients
 * strip <style> blocks unevenly). Mobile-first with max-width 560px.
 * --------------------------------------------------------------------------- */
function generateDcrEmailHtmlV1(n, aiSummary) {
  const date = formatHumanDate(n.cleaningDate) || "your recent visit";
  const safe = htmlEscape;

  // ---- Issues block — only when there are issue items WITH notes OR a
  // problem block. Empty otherwise (no scaffold = no clutter). ----
  let issuesHtml = "";
  if ((n.issueItems && n.issueItems.length) || n.problem) {
    const items = [];
    (n.issueItems || []).forEach(function (i) {
      items.push(
        '<li style="margin-bottom:8px;">' +
          '<strong style="color:' + PIONEER_INK_HEX + ';">' + safe(i.label) + '</strong>' +
          '<br/><span style="color:' + PIONEER_MUTED_HEX + ';font-size:14px;">' + safe(i.note) + '</span>' +
        '</li>'
      );
    });
    if (n.problem) {
      const txt = n.problem.summary || n.problem.details || "";
      const loc = n.problem.location;
      items.push(
        '<li style="margin-bottom:8px;">' +
          '<strong style="color:' + PIONEER_INK_HEX + ';">Tech-reported issue</strong>' +
          '<br/><span style="color:' + PIONEER_MUTED_HEX + ';font-size:14px;">' +
            safe(txt) + (loc ? (" (" + safe(loc) + ")") : "") +
          '</span>' +
        '</li>'
      );
    }
    issuesHtml =
      '<div style="background:#fef3c7;border:1px solid #fde68a;border-left:4px solid ' + PIONEER_ATTN_HEX + ';' +
                  'border-radius:10px;padding:14px 16px;margin:18px 0;">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;' +
                    'color:' + PIONEER_ATTN_HEX + ';margin-bottom:8px;">Flagged for follow-up</div>' +
        '<ul style="margin:0;padding-left:18px;color:' + PIONEER_INK_HEX + ';font-size:15px;line-height:1.5;">' +
          items.join("") +
        '</ul>' +
      '</div>';
  }

  // ---- Supplies — only when present. Customer-friendly framing
  // ("restock note" rather than "supply request"). ----
  let suppliesHtml = "";
  if (n.supplies && n.supplies.items) {
    suppliesHtml =
      '<div style="background:' + PIONEER_BG_SOFT_HEX + ';border:1px solid #e2e8f0;' +
                  'border-radius:10px;padding:12px 14px;margin:12px 0;">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;' +
                    'color:' + PIONEER_MUTED_HEX + ';margin-bottom:6px;">Restock note</div>' +
        '<div style="color:' + PIONEER_INK_HEX + ';font-size:14.5px;line-height:1.55;">' +
          safe(n.supplies.items) +
        '</div>' +
      '</div>';
  }

  // ---- Over-budget — only when time_budget.on_budget === false. ----
  let budgetHtml = "";
  if (n.timeBudget && n.timeBudget.onBudget === false) {
    const reasons = (n.timeBudget.reasons || []).join(", ");
    budgetHtml =
      '<div style="background:' + PIONEER_BG_SOFT_HEX + ';border:1px solid #e2e8f0;' +
                  'border-radius:10px;padding:12px 14px;margin:12px 0;">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;' +
                    'color:' + PIONEER_MUTED_HEX + ';margin-bottom:6px;">Time on site</div>' +
        '<div style="color:' + PIONEER_INK_HEX + ';font-size:14.5px;line-height:1.55;">' +
          'This visit ran a bit longer than scheduled' +
          (reasons ? (' (' + safe(reasons) + ')') : '') + '. ' +
          'We track this so we can keep service quality steady.' +
        '</div>' +
      '</div>';
  }

  // ---- Photo gallery — render as simple inline images. Email clients
  // can render Firebase Storage download URLs because they include a
  // `?alt=media&token=…` permanent-public-read token. ----
  let photosHtml = "";
  if (n.photoUrls && n.photoUrls.length) {
    const cells = n.photoUrls.map(function (url) {
      return (
        '<td valign="top" style="padding:4px;width:33%;">' +
          '<a href="' + safe(url) + '" style="display:block;">' +
            '<img src="' + safe(url) + '" alt="Cleaning photo" ' +
                 'style="width:100%;border-radius:8px;border:1px solid #e2e8f0;display:block;" />' +
          '</a>' +
        '</td>'
      );
    });
    // Group into rows of 3 for a clean grid in most email clients.
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) {
      const trio = cells.slice(i, i + 3).join("");
      const pad  = "<td></td>".repeat(3 - cells.slice(i, i + 3).length);
      rows.push('<tr>' + trio + pad + '</tr>');
    }
    photosHtml =
      '<div style="margin:18px 0 6px;">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;' +
                    'color:' + PIONEER_MUTED_HEX + ';margin-bottom:8px;">Photos from this visit</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
          rows.join("") +
        '</table>' +
      '</div>';
  }

  // ---- Tech identity block — small avatar + name centered above the summary ----
  let techBlockHtml = "";
  if (n.techName || n.techPhotoUrl) {
    const avatar = n.techPhotoUrl
      ? '<img src="' + safe(n.techPhotoUrl) + '" alt="" width="40" height="40" ' +
        'style="border-radius:999px;border:2px solid #fff;box-shadow:0 0 0 1px #e2e8f0;display:block;" />'
      : '<div style="width:40px;height:40px;border-radius:999px;background:' + PIONEER_PRIMARY_HEX + ';' +
        'color:#fff;font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;line-height:1;">' +
          safe((n.techName || "?").charAt(0).toUpperCase()) +
        '</div>';
    techBlockHtml =
      '<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;">' +
        avatar +
        '<div style="font-size:14px;color:' + PIONEER_MUTED_HEX + ';">' +
          'Cleaned by <strong style="color:' + PIONEER_INK_HEX + ';">' + safe(n.techName || "your tech") + '</strong>' +
        '</div>' +
      '</div>';
  }

  // ---- Signature block — small thumbnail on a calm row ----
  let signatureHtml = "";
  if (n.signatureUrl) {
    signatureHtml =
      '<div style="margin:18px 0 6px;padding:10px 12px;background:' + PIONEER_BG_SOFT_HEX + ';' +
                  'border:1px solid #e2e8f0;border-radius:10px;">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;' +
                    'color:' + PIONEER_MUTED_HEX + ';margin-bottom:4px;">Signed by ' +
                    safe(n.signatureName || n.techName || "your tech") + '</div>' +
        '<img src="' + safe(n.signatureUrl) + '" alt="Signature" ' +
             'style="max-height:60px;max-width:240px;display:block;" />' +
      '</div>';
  }

  // ---- Feedback buttons ----
  const complimentUrl =
    FEEDBACK_BASE + "/feedback/compliment?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId);
  const problemUrl =
    FEEDBACK_BASE + "/feedback/problem?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId);
  const complimentLabel = n.techName
    ? ("Tell " + n.techName + " they did a great job")
    : "Send a compliment";
  const feedbackHtml =
    '<div style="margin:24px 0 8px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
        '<tr>' +
          '<td valign="top" style="padding:4px;width:50%;">' +
            '<a href="' + safe(complimentUrl) + '" ' +
               'style="display:block;text-align:center;padding:12px 14px;background:' + PIONEER_PRIMARY_HEX + ';' +
               'color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:999px;">' +
              safe(complimentLabel) +
            '</a>' +
          '</td>' +
          '<td valign="top" style="padding:4px;width:50%;">' +
            '<a href="' + safe(problemUrl) + '" ' +
               'style="display:block;text-align:center;padding:12px 14px;background:#fff;' +
               'color:' + PIONEER_INK_HEX + ';font-size:14px;font-weight:700;text-decoration:none;' +
               'border-radius:999px;border:1px solid #e2e8f0;">' +
              'Something wasn’t quite right' +
            '</a>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</div>';

  // ---- Final assembly ----
  // Inline styles only — Gmail, Outlook, iOS Mail, Apple Mail compatible.
  return (
    '<!doctype html><html><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<title>Cleaning report</title></head>' +
    '<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:560px;margin:0 auto;padding:24px 16px;">' +
        '<div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px -8px rgba(15,23,42,0.18);">' +
          // hero strip
          '<div style="padding:18px 20px;background:' + PIONEER_INK_HEX + ';color:#fff;">' +
            '<div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#5eead4;">' +
              safe(PIONEER_BRAND_NAME) +
            '</div>' +
            '<div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;margin-top:4px;">' +
              'Cleaning report for ' + safe(n.customerName) +
            '</div>' +
            '<div style="font-size:13px;color:#cbd5e1;margin-top:2px;">' + safe(date) + '</div>' +
          '</div>' +
          // body
          '<div style="padding:20px 22px;color:' + PIONEER_INK_HEX + ';">' +
            techBlockHtml +
            '<p style="margin:0 0 12px;font-size:15.5px;line-height:1.55;color:' + PIONEER_INK_HEX + ';">' +
              safe(aiSummary) +
            '</p>' +
            issuesHtml +
            suppliesHtml +
            budgetHtml +
            photosHtml +
            signatureHtml +
            feedbackHtml +
          '</div>' +
          // footer
          '<div style="padding:12px 22px;background:' + PIONEER_BG_SOFT_HEX + ';color:' + PIONEER_MUTED_HEX + ';' +
                      'font-size:11.5px;line-height:1.5;text-align:center;border-top:1px solid #e2e8f0;">' +
            safe(PIONEER_BRAND_NAME) + ' · This report was generated automatically after the visit.' +
          '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:' + PIONEER_MUTED_HEX + ';text-align:center;margin-top:12px;">' +
          'Questions? <a href="mailto:info@pioneercomclean.com" style="color:' + PIONEER_PRIMARY_HEX + ';text-decoration:none;">info@pioneercomclean.com</a>' +
        '</div>' +
      '</div>' +
    '</body></html>'
  );
}

/* ============================================================================
 * V2 — Structured-content generation + polished template renderer
 * ============================================================================
 * OpenAI returns STRUCTURED JSON only (subject, headline, openingSummary,
 * serviceHighlights[], serviceNote, photoSectionTitle, feedbackPrompt,
 * complimentButtonText, problemButtonText, footerNote). The HTML is
 * rendered by renderDcrEmailHtmlV2 — a pure function with no network or
 * Firestore reads — so the model can't shape the final markup.
 *
 * Why split:
 *   • Stable email template that survives prompt changes
 *   • Easier visual QA — render the same content JSON locally
 *   • Cheaper to fix a copy bug (one helper) vs a template bug
 *   • Predictable Gmail/Outlook compatibility
 *
 * Fallback path: if OpenAI fails or returns malformed JSON, we derive
 * a deterministic content object from the normalized DCR so the email
 * still ships with sensible copy. V2 fallback is RICHER than V1's
 * 2-sentence fallback — it builds real service-highlight bullets.
 * ========================================================================== */

// V2 prompt builder. Returns { system, user, response_format }. The
// response_format hint is read by generateDcrEmailContentJsonV2 to flip
// the OpenAI call into JSON mode.
function createDcrEmailPromptV2(n) {
  // Compact grounding block — same approach as V1 but with more
  // structure so the model can group bullets cleanly.
  const groundingLines = [];
  groundingLines.push("Customer: " + (n.customerName || "the customer"));
  groundingLines.push("Cleaning date: " + (n.cleaningDate || "today"));
  if (n.techName) groundingLines.push("Tech: " + n.techName);

  // Group completed items by section for the model. The prompt asks for
  // CONSOLIDATED bullets, not raw item lists — so the model has to
  // synthesize, not just rephrase.
  const completedBySection = {};
  (n.completedItems || []).forEach(function (it) {
    const k = it.section || "General";
    if (!completedBySection[k]) completedBySection[k] = [];
    completedBySection[k].push(it.label);
  });
  Object.keys(completedBySection).forEach(function (section) {
    groundingLines.push("Completed in " + section + ": " + completedBySection[section].slice(0, 12).join("; "));
  });

  if (n.issueItems && n.issueItems.length) {
    n.issueItems.slice(0, 6).forEach(function (it) {
      groundingLines.push("Flagged item — " + it.section + " · " + it.label + ": " + it.note);
    });
  }
  if (n.problem) {
    const txt = n.problem.summary || n.problem.details || "";
    groundingLines.push("Tech-reported issue: " + txt +
      (n.problem.location ? " (" + n.problem.location + ")" : "") +
      (n.problem.ourFault ? " [our fault]" : ""));
  }
  if (n.supplies && n.supplies.items) {
    groundingLines.push("Supplies requested by tech: " + n.supplies.items);
  }
  if (n.timeBudget && n.timeBudget.onBudget === false) {
    // Note: the model is instructed NOT to expose this. We surface it
    // only so the model can soften the overall tone if a visit ran long.
    groundingLines.push("Internal note (do not mention): visit ran over scheduled time.");
  }
  if (n.notes) groundingLines.push("Tech's notes to office: " + n.notes);

  const firstName = (n.techName || "").trim().split(/\s+/)[0] || "";
  const complimentDefault = firstName
    ? ("Tell " + firstName + " they did a great job")
    : "Send a compliment";

  const system =
    "You write customer-facing daily cleaning reports for Pioneer Commercial Cleaning.\n\n" +
    "Voice: a calm, professional operations manager writing to a customer. " +
    "Practical, grounded, human. Short sentences. No marketing tone. " +
    "Never apologetic, never theatrical, never overstate quality. Never use emojis.\n\n" +
    "Grounding rules — read carefully:\n" +
    "1. Base every claim on the actual completed sections and notes you receive. " +
    "If the data is thin, say something simple and true. Do not invent details, do " +
    "not embellish, do not make the cleaner sound heroic.\n" +
    "2. Mention the tech's first name once in the openingSummary when it's known. " +
    "Do not repeat it across multiple fields unless it adds real information.\n" +
    "3. openingSummary: 1–3 short sentences. ~60 words MAX. State what got done, " +
    "in plain language, anchored to the actual sections that were completed.\n" +
    "4. serviceHighlights bullets must describe what was actually done in that " +
    "section. Specific over generic. If a section only has one completed item, " +
    "the bullet should reflect that — do not pad with vague phrases.\n" +
    "5. If photos are present, the photoSectionTitle should signal proof, not " +
    "decoration. Example: \"Tonight's photos\" or \"Photos from this visit\". " +
    "Avoid \"a glimpse\" / \"showcase\" / \"highlights gallery\" language.\n" +
    "6. If the data shows no issues at all (no flagged items, no tech-reported " +
    "problem, no supplies request, no over-budget note), serviceNote.status must " +
    "be \"green\" and serviceNote.message must read close to: " +
    "\"No concerns were logged during this visit.\"\n" +
    "7. Never expose internal logic — no time budgets, scoring, internal " +
    "categories, area thresholds, or operational scoring language.\n\n" +
    "BANNED WORDS / PHRASES (do not use, do not paraphrase as flavor):\n" +
    "  meticulously, exceptional, pristine, sparkling, elevated, delighted, " +
    "carefully curated, attention to detail, fresh and welcoming, " +
    "spotless, immaculate, top-tier, white-glove, premium service, " +
    "quick recap.\n" +
    "Use \"attention to detail\" or \"fresh and welcoming\" ONLY if the input " +
    "data directly supports it (e.g. an explicit tech note saying so). " +
    "Otherwise, paraphrase neutrally — \"the space was cleaned per the standard " +
    "checklist\" beats any of those banned phrases.\n\n" +
    "Output ONLY valid JSON matching this shape:\n" +
    "{\n" +
    '  "subject": string,\n' +
    '  "preheader": string,\n' +
    '  "headline": string,\n' +
    '  "openingSummary": string,\n' +
    '  "serviceHighlights": [\n' +
    '    { "sectionName": string, "bullets": [string] }\n' +
    '  ],\n' +
    '  "serviceNote": { "status": "green"|"yellow"|"red", "title": string, "message": string },\n' +
    '  "photoSectionTitle": string,\n' +
    '  "feedbackPrompt": string,\n' +
    '  "complimentButtonText": string,\n' +
    '  "problemButtonText": string,\n' +
    '  "footerNote": string\n' +
    "}\n\n" +
    "Field rules:\n" +
    "- subject: \"Cleaning report for <Customer> · <Day, Month Date>\" — short.\n" +
    "- preheader: ONE short inbox-preview sentence (max 90 chars). Plain, factual.\n" +
    "- headline: 4–7 words. Direct. Examples: \"Tonight's clean is wrapped\", " +
    "\"Visit complete\", \"Tonight's report\". Avoid superlatives.\n" +
    "- openingSummary: 1–3 short sentences. Ground in real sections from the input. " +
    "Use this canonical shape when accurate: " +
    "\"<First> completed tonight's clean at <Customer>. The main areas were cleaned " +
    "and reset, and after-photos are included below for visibility.\" " +
    "Adjust to match what actually happened — if the tech name is unknown, " +
    "start with \"Tonight's clean is complete at <Customer>.\" — but keep the " +
    "tone direct and warm. Never use \"quick recap\".\n" +
    "- serviceHighlights: 2–5 SECTIONS, each with 1–4 SPECIFIC bullets. Each bullet " +
    "describes what was actually done in that area. Group raw checklist items into " +
    "these canonical areas when possible (use the customer-facing name verbatim):\n" +
    "    Bathrooms\n" +
    "    Kitchens & Breakrooms\n" +
    "    Offices\n" +
    "    Entryways\n" +
    "    General Areas\n" +
    "  Only include sections that had completed work. If a section the data shows " +
    "doesn't map to a canonical area cleanly, use the original section name. " +
    "Bullets should be SHORT pill-style phrases (2–6 words) — they read in a " +
    "rounded chip in the email. Examples that pass:\n" +
    "    \"Bathrooms reset\"\n" +
    "    \"High-touch surfaces cleaned\"\n" +
    "    \"Trash removed\"\n" +
    "    \"Floors completed\"\n" +
    "  Examples that FAIL (do not use):\n" +
    "    \"Attention to detail throughout\"\n" +
    "    \"Pristine results\"\n" +
    "    \"Carefully cleaned the entire bathroom area with precision\" (too long)\n" +
    "- If the input shows NO completed checklist items at all (sparse " +
    "or missing checklist data), return exactly one section with this " +
    "shape and these two bullets verbatim:\n" +
    "    { \"sectionName\": \"Tonight's visit\",\n" +
    "      \"bullets\": [\n" +
    "        \"Service scope completed\",\n" +
    "        \"No concerns logged\"\n" +
    "      ] }\n" +
    "  Do NOT return an empty serviceHighlights array.\n" +
    "- serviceNote.status:\n" +
    "    \"green\"  no issues, supplies, or follow-ups → title \"No concerns logged\", " +
    "             message exactly: \"Nothing needed from your team.\"\n" +
    "    \"yellow\" small follow-up (e.g. supply note) → title \"Note from tonight's visit\", " +
    "             message: calm 1–2 sentences explaining what.\n" +
    "    \"red\"    tech-reported problem or item affecting customer → title " +
    "             \"Manager follow-up needed\", message: clear, not dramatic, " +
    "             promises the office will be in touch.\n" +
    "- photoSectionTitle: \"Photos from tonight's clean\" or close variant.\n" +
    "- feedbackPrompt: exactly \"Quick feedback helps us keep your building dialed in.\" " +
    "(or a very close equally plain variant — never use \"quick recap\" anywhere).\n" +
    "- complimentButtonText: prefer \"Tell <FirstName> they did a great job\" when tech name is known. Default: \"" +
       complimentDefault + "\".\n" +
    "- problemButtonText: \"Something wasn't quite right\" (or close variant).\n" +
    "- footerNote: one calm closing sentence. No legalese, no superlatives.";

  const user =
    "Write the JSON for the cleaning report below. Stay grounded in this data — " +
    "do not invent anything that isn't here.\n\n" +
    groundingLines.join("\n");

  return {
    system: system,
    user:   user,
    response_format: { type: "json_object" }
  };
}

// V2 deterministic fallback. Used when OpenAI errors out or returns
// unparseable JSON. Builds enough structure to keep the V2 layout
// looking polished without any AI in the loop.
function buildFallbackContentV2(n) {
  const firstName = (n.techName || "").trim().split(/\s+/)[0] || "";
  const customer  = n.customerName || "your space";
  const dateText  = formatHumanDate(n.cleaningDate) || "today";

  // Build serviceHighlights by consolidating per-section completed items.
  // If no checklist items are present, emit the canonical sparse-data
  // 3-bullet set so the customer still sees useful proof copy.
  const sectionMap = {};
  (n.completedItems || []).forEach(function (it) {
    const k = it.section || "General service";
    if (!sectionMap[k]) sectionMap[k] = [];
    sectionMap[k].push(it.label);
  });
  let highlights;
  if (Object.keys(sectionMap).length === 0) {
    highlights = [{
      sectionName: "Tonight's visit",
      bullets: [
        "Service scope completed",
        "No concerns logged"
      ]
    }];
  } else {
    highlights = Object.keys(sectionMap).slice(0, 5).map(function (section) {
      return {
        sectionName: section,
        bullets:     sectionMap[section].slice(0, 4)
      };
    });
  }

  // Status decision.
  let status = "green";
  if (n.problem || (n.issueItems && n.issueItems.length)) status = "red";
  else if (n.supplies || (n.timeBudget && n.timeBudget.onBudget === false)) status = "yellow";

  let noteTitle, noteMessage;
  if (status === "red") {
    noteTitle   = "Manager follow-up needed";
    noteMessage = "A couple of items came up during tonight's visit. Someone from our office will be in touch.";
  } else if (status === "yellow") {
    noteTitle   = "Note from tonight's visit";
    noteMessage = "A small note from tonight's visit. Nothing urgent — reach out if you have questions.";
  } else {
    // Canonical green-state wording, matched on the prompt + renderer.
    // The invitation tail ("If anything looks off…") keeps the door open.
    noteTitle   = "No concerns logged";
    noteMessage = "Nothing needed from your team. If anything looks off, tap below and we’ll take care of it.";
  }

  const complimentLabel = firstName
    ? ("Tell " + firstName + " they did a great job")
    : "Send a compliment";

  // Fallback openingSummary: matches the canonical phrasing the prompt
  // also targets, so AI failures still produce the same voice.
  const subject = firstName || "Your Pioneer team";
  const openingSummary =
    subject + " completed tonight's clean at " + customer + ". " +
    "The main areas were cleaned and reset, and after-photos are included below for visibility.";

  return {
    subject:           "Cleaning report for " + customer + " · " + dateText,
    preheader:         (firstName ? (firstName + "'s ") : "Your ") + "cleaning report for " + customer + ".",
    headline:          "Tonight's report",
    openingSummary:    openingSummary,
    serviceHighlights: highlights,
    serviceNote: {
      status:  status,
      title:   noteTitle,
      message: noteMessage
    },
    photoSectionTitle:    "Photos from tonight’s clean",
    feedbackPrompt:       "Quick feedback helps us keep your building dialed in.",
    complimentButtonText: complimentLabel,
    problemButtonText:    "Something wasn't quite right",
    footerNote:           "Thanks for choosing Pioneer Commercial Cleaning."
  };
}

// V2 content generator. Returns { subject, preheader, headline,
// openingSummary, serviceHighlights[], serviceNote, photoSectionTitle,
// feedbackPrompt, complimentButtonText, problemButtonText, footerNote }.
// Always returns a valid object — falls back to buildFallbackContentV2
// on any error.
async function generateDcrEmailContentJsonV2(normalized, apiKey, logger) {
  if (!apiKey) {
    logger && logger.warn("[dcr-email][v2] OPENAI_API_KEY missing — using fallback content");
    return buildFallbackContentV2(normalized);
  }
  const prompt = createDcrEmailPromptV2(normalized);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model:           OPENAI_MODEL_V2,
        // JSON mode — guarantees valid JSON, simplifies the parse.
        response_format: prompt.response_format,
        // Lower temperature so the model leans on the grounding data
        // rather than inventing flavor copy. 0.25 reliably suppresses
        // the marketing-tone reflex without sounding robotic.
        temperature:     0.25,
        max_tokens:      900,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user",   content: prompt.user }
        ]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(function () { return ""; });
      logger && logger.warn("[dcr-email][v2] OpenAI " + res.status + " — falling back. body=" + errText.slice(0, 400));
      return buildFallbackContentV2(normalized);
    }
    const data = await res.json();
    const raw  = data && data.choices && data.choices[0] &&
                 data.choices[0].message && data.choices[0].message.content;
    if (!raw || typeof raw !== "string") return buildFallbackContentV2(normalized);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      logger && logger.warn("[dcr-email][v2] JSON parse failed — falling back: " + e.message);
      return buildFallbackContentV2(normalized);
    }

    const validated = validateContentJsonV2(parsed, normalized, logger);
    return validated;
  } catch (err) {
    logger && logger.warn("[dcr-email][v2] OpenAI call failed — falling back: " + (err && err.message || err));
    return buildFallbackContentV2(normalized);
  }
}

// Defensive banned-word scrub. The prompt explicitly blocks the
// fluffiest marketing words, but a low-temp model still drifts
// occasionally. If a banned word slips through, swap it for a calm
// neutral phrase rather than rewriting the whole sentence. This is a
// SECOND line of defense — the prompt is the first.
const V2_BANNED_REPLACEMENTS = [
  // [regex pattern, replacement] — case-insensitive, word-bounded.
  [/\bmeticulously\b/gi,            "carefully"],
  [/\bmeticulous\b/gi,              "thorough"],
  [/\bexceptional\b/gi,             "solid"],
  [/\bpristine\b/gi,                "clean"],
  [/\bsparkling\b/gi,               "clean"],
  [/\belevated\b/gi,                "complete"],
  [/\bdelighted\b/gi,               "glad"],
  [/\bcarefully curated\b/gi,       "thorough"],
  [/\bspotless\b/gi,                "clean"],
  [/\bimmaculate\b/gi,              "clean"],
  [/\btop[- ]tier\b/gi,             "complete"],
  [/\bwhite[- ]glove\b/gi,          "thorough"],
  [/\bpremium service\b/gi,         "tonight's service"],
  [/\bquick recap\b/gi,             "recap"]
];

function scrubBannedWords(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  for (let i = 0; i < V2_BANNED_REPLACEMENTS.length; i++) {
    out = out.replace(V2_BANNED_REPLACEMENTS[i][0], V2_BANNED_REPLACEMENTS[i][1]);
  }
  return out;
}

// Strict validator. Required fields with the right types win; missing
// or wrong-shape fields are filled from the fallback so we always end
// up with a complete content object.
function validateContentJsonV2(parsed, normalized, logger) {
  const fb = buildFallbackContentV2(normalized);
  function s(v, fallback) {
    const raw = (typeof v === "string" && v.trim()) ? v.trim() : fallback;
    return scrubBannedWords(raw);
  }
  function noteStatus(v) {
    return (v === "green" || v === "yellow" || v === "red") ? v : "green";
  }

  // Highlights: keep only well-shaped entries. Each must have a non-empty
  // sectionName + a non-empty bullets array of strings.
  let highlights = [];
  if (Array.isArray(parsed.serviceHighlights)) {
    highlights = parsed.serviceHighlights
      .filter(function (h) {
        return h && typeof h === "object" &&
               typeof h.sectionName === "string" && h.sectionName.trim() &&
               Array.isArray(h.bullets);
      })
      .map(function (h) {
        return {
          sectionName: scrubBannedWords(h.sectionName.trim()),
          // Scrub each bullet through the banned-word filter so any
          // marketing flavor the model slipped past the prompt still
          // gets neutralized at render time.
          bullets:     h.bullets
                         .filter(function (b) { return typeof b === "string" && b.trim(); })
                         .map(function (b) { return scrubBannedWords(b.trim()); })
                         .slice(0, 4)   // Spec calls for 1–4, not 1–5
        };
      })
      .filter(function (h) { return h.bullets.length > 0; })
      .slice(0, 5);
  }
  if (!highlights.length) highlights = fb.serviceHighlights;

  let serviceNote = fb.serviceNote;
  if (parsed.serviceNote && typeof parsed.serviceNote === "object") {
    serviceNote = {
      status:  noteStatus(parsed.serviceNote.status),
      title:   s(parsed.serviceNote.title,   fb.serviceNote.title),
      message: s(parsed.serviceNote.message, fb.serviceNote.message)
    };
  }

  // Cap noisy fields to safe lengths so a misbehaving model can't
  // explode the HTML or trip Gmail's 102KB clipping.
  function cap(str, max) {
    return (str && str.length > max) ? str.slice(0, max - 1).trim() + "…" : str;
  }

  if (logger) {
    logger.info("[dcr-email][v2] content validated", {
      highlight_count:    highlights.length,
      bullet_total:       highlights.reduce(function (a, h) { return a + h.bullets.length; }, 0),
      note_status:        serviceNote.status,
      openingSummary_len: (parsed.openingSummary || "").length
    });
  }

  return {
    subject:              cap(s(parsed.subject,           fb.subject),           120),
    preheader:            cap(s(parsed.preheader,         fb.preheader),         140),
    headline:             cap(s(parsed.headline,          fb.headline),           80),
    // openingSummary cap tightened to ~60 words / ~360 chars to match
    // the new "1–3 short sentences" rule. The cap function adds an
    // ellipsis if the model over-writes; the prompt itself targets ~280.
    openingSummary:       cap(s(parsed.openingSummary,    fb.openingSummary),    360),
    serviceHighlights:    highlights,
    serviceNote:          serviceNote,
    photoSectionTitle:    cap(s(parsed.photoSectionTitle, fb.photoSectionTitle),  60),
    feedbackPrompt:       cap(s(parsed.feedbackPrompt,    fb.feedbackPrompt),     90),
    complimentButtonText: cap(s(parsed.complimentButtonText, fb.complimentButtonText), 60),
    problemButtonText:    cap(s(parsed.problemButtonText,    fb.problemButtonText),    60),
    footerNote:           cap(s(parsed.footerNote,          fb.footerNote),           160)
  };
}

/* ----------------------------------------------------------------------------
 * renderDcrEmailHtmlV2
 *
 * PURE function. Inputs:
 *   - n       — normalized DCR (from normalizeDcrForEmail)
 *   - content — content JSON (from generateDcrEmailContentJsonV2)
 * Returns the full HTML string. No network, no Firestore.
 *
 * Email compatibility:
 *   • Table-based outer layout (Outlook 2007–2019 + new Outlook)
 *   • Inline styles on every element that styles
 *   • A tiny <style> block in <head> ONLY for the responsive media
 *     query and the avatar fallback (clients that strip <style> get
 *     a working baseline; clients that respect it get a tighter
 *     mobile experience).
 *   • Images: width/height attrs + display:block + max-width inline.
 *   • Buttons: bullet-proof table-based "VML-free" pattern. Works on
 *     Outlook desktop without VML <v:roundrect> because the corner
 *     radius is implemented purely via CSS border-radius (Outlook
 *     drops the radius and falls back to a sharp button — fine).
 * --------------------------------------------------------------------------- */
function renderDcrEmailHtmlV2(n, content) {
  const safe = htmlEscape;
  const date = formatHumanDate(n.cleaningDate);
  const firstName = (n.techName || "").trim().split(/\s+/)[0] || "";

  // ---- Pioneer logo (hosted on Firebase Hosting). Width capped at
  //      ~120px; height auto. Falls back to text if the image errors. ----
  const logoHtml =
    '<a href="' + safe(FEEDBACK_BASE) + '" style="text-decoration:none;display:inline-block;">' +
      '<img src="' + safe(V2_LOGO_URL) + '" alt="Pioneer Commercial Cleaning" width="120" ' +
           'style="display:block;width:120px;max-width:120px;height:auto;border:0;outline:none;text-decoration:none;" />' +
    '</a>';

  // ---- Header card: brand + headline + sub line (location · date · tech) ----
  const headerCardHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:' + V2_INK + ';border-radius:14px;overflow:hidden;">' +
      '<tr>' +
        '<td align="center" style="padding:22px 22px 8px;">' + logoHtml + '</td>' +
      '</tr>' +
      '<tr>' +
        '<td align="center" style="padding:6px 24px 4px;">' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:' + V2_TEAL + ';">' +
            'Cleaning report' +
          '</div>' +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td align="center" style="padding:2px 24px 6px;">' +
          '<h1 style="margin:0;font-size:22px;line-height:1.25;letter-spacing:-0.01em;font-weight:800;color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
            safe(content.headline || "Tonight's clean is wrapped") +
          '</h1>' +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td align="center" style="padding:0 24px 22px;">' +
          '<div style="font-size:13px;color:#CBD5E1;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
            safe(n.customerName || "Your space") +
            (date ? ('<span style="opacity:.6;"> · </span>' + safe(date)) : '') +
            (n.techName ? ('<span style="opacity:.6;"> · </span>Cleaned by ' + safe(n.techName)) : '') +
          '</div>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- Tech profile card ----
  // Renders only when we have at least a tech name. Three visual states:
  //   1. tech photo present  → real avatar (64px circle)
  //   2. no photo            → calm initials fallback (teal circle, ink text)
  //   3. signature present   → small image with "Report signed after visit"
  //                            caption below the name
  // Spec calls the card a trust receipt — labels are explicit:
  //   "Cleaned by" eyebrow
  //   "[Tech Name]" prominent
  //   "Report signed after visit" caption on the signature row
  let techCardHtml = "";
  if (n.techName || n.techPhotoUrl) {
    const initial = (n.techName || "P").charAt(0).toUpperCase();
    const avatarHtml = n.techPhotoUrl
      ? '<img src="' + safe(n.techPhotoUrl) + '" alt="" width="64" height="64" ' +
        'style="display:block;width:64px;height:64px;border-radius:32px;object-fit:cover;border:2px solid #FFFFFF;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';" />'
      : '<div style="width:64px;height:64px;border-radius:32px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:24px;font-weight:800;line-height:64px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';">' +
          safe(initial) +
        '</div>';

    // Signature block — caption + framed signature image when present.
    // Omitted entirely when no signature_url was found in any of the
    // candidate fields (v2FirstHttpsString returned "").
    let signatureBlockHtml = "";
    if (n.signatureUrl) {
      signatureBlockHtml =
        '<div style="margin-top:12px;padding-top:12px;border-top:1px solid ' + V2_CARD_BORDER + ';">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:6px;">Report signed after the visit</div>' +
          '<div style="background:' + V2_SURFACE + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:8px;padding:8px 12px;display:inline-block;">' +
            '<img src="' + safe(n.signatureUrl) + '" alt="Tech signature" ' +
                 'style="display:block;max-height:54px;max-width:220px;border:0;outline:none;" />' +
          '</div>' +
        '</div>';
    }

    // v2.5 — Subtle visit-count line. Server-derived (never AI), tiered
    // copy: getting familiar (≤3) → has completed several (4–15) → has
    // completed N visits (>15). Rendered as a single muted line under
    // the signature block so it reads as quiet operational continuity,
    // not marketing.
    // TODO portal: link the visit count to a "view all visits" page
    // when the customer-facing portal lands.
    let visitContextHtml = "";
    const ts = n.trustSignals || {};
    if (ts.cleanerVisitMessage) {
      visitContextHtml =
        '<div style="margin-top:10px;font-size:12.5px;line-height:1.5;color:' + V2_MUTED + ';">' +
          safe(ts.cleanerVisitMessage) +
        '</div>';
    }

    techCardHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:12px;margin-top:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
        '<tr>' +
          '<td class="dcr-card" style="padding:18px 20px;" valign="top">' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
              '<tr>' +
                '<td width="76" valign="middle" style="width:76px;padding-right:14px;">' + avatarHtml + '</td>' +
                '<td valign="middle">' +
                  '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">Cleaned by</div>' +
                  '<div style="font-size:18px;font-weight:700;color:' + V2_INK + ';margin-top:3px;line-height:1.25;">' + safe(n.techName || "Your Pioneer tech") + '</div>' +
                '</td>' +
              '</tr>' +
            '</table>' +
            signatureBlockHtml +
            visitContextHtml +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- v2.5 scaffold: follow-up closure ----
  // Renders nothing today. Reserved for Phase-2 issue-closure engine:
  // when an issue from a prior DCR was resolved on this visit, set
  // n.trustSignals.resolvedFromPriorVisit = { itemLabel, fromDate }
  // and surface a small "Resolved from your last visit" chip right
  // above the summary card. Intentionally a slot, not a feature yet.
  // TODO portal: link the resolved chip to the dashboard's per-customer
  // issue history thread.
  let resolvedChipHtml = "";
  if (n.trustSignals && n.trustSignals.resolvedFromPriorVisit &&
      n.trustSignals.resolvedFromPriorVisit.itemLabel) {
    const r = n.trustSignals.resolvedFromPriorVisit;
    resolvedChipHtml =
      '<div style="margin-top:14px;padding:8px 12px;background:#ECFDF5;border:1px solid #A7F3D0;border-left:4px solid ' + V2_SUCCESS + ';border-radius:10px;font-size:13px;color:#065F46;">' +
        'Resolved from a prior visit: <strong>' + safe(r.itemLabel) + '</strong>' +
      '</div>';
  }

  // ---- Tonight's Visit summary card ----
  const summaryCardHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:12px;margin-top:14px;">' +
      '<tr>' +
        '<td style="padding:18px 20px;">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">Tonight’s visit</div>' +
          '<p style="margin:6px 0 0;font-size:15px;line-height:1.55;color:' + V2_INK + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
            safe(content.openingSummary || "") +
          '</p>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- Service Highlights — pill-style rows per section ----
  // One card. Per section: bold section name + a row of teal-bordered
  // pill chips for each short bullet. Chips read like a useful glance,
  // not a paragraph wall. If the prompt returned an empty highlights
  // array (no completed sections in the data), surface the fallback
  // line per the spec.
  let highlightsCardHtml = "";
  const highlightSections = Array.isArray(content.serviceHighlights) ? content.serviceHighlights : [];

  if (highlightSections.length === 0) {
    // Sparse-data path. The model is instructed never to return an
    // empty highlights array, so we should rarely land here — but if
    // we do (older model, validation strip), substitute the canonical
    // 3-bullet "Tonight's visit" pill set so the customer still sees
    // useful proof copy instead of a one-line dead end.
    highlightSections.push({
      sectionName: "Tonight's visit",
      bullets: [
        "Standard cleaning scope completed",
        "Visit documented with after-photos",
        "No concerns logged"
      ]
    });
  }

  {
    const sectionRows = highlightSections.map(function (h) {
      // Render bullets as inline teal-bordered pills, separated by a
      // small inline gap. Wrap them in a single <td> so Gmail/Outlook
      // flow them on multiple lines naturally as the viewport narrows.
      const pills = (h.bullets || []).map(function (b) {
        return (
          '<span style="display:inline-block;margin:3px 6px 3px 0;padding:5px 10px;' +
                 'font-size:13px;line-height:1.25;font-weight:600;' +
                 'color:' + V2_INK + ';' +
                 'background:#F0FBF8;' +     // soft teal tint
                 'border:1px solid #BBEFE3;' +
                 'border-radius:999px;">' +
            safe(b) +
          '</span>'
        );
      }).join("");
      return (
        '<tr>' +
          '<td style="padding:0 0 14px;">' +
            '<div style="font-size:13px;font-weight:800;color:' + V2_INK + ';margin-bottom:6px;letter-spacing:-0.01em;">' +
              safe(h.sectionName) +
            '</div>' +
            '<div>' + pills + '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join("");
    highlightsCardHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:12px;margin-top:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
        '<tr>' +
          '<td class="dcr-card" style="padding:18px 20px 6px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:10px;">What was completed</div>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
              sectionRows +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- Service Note card — color-keyed by content.serviceNote.status ----
  let serviceNoteHtml = "";
  if (content.serviceNote && content.serviceNote.status && content.serviceNote.status !== "green") {
    // For green status we deliberately omit the card; the calm headline
    // + summary already communicate "all good" — adding a second card
    // would be visual noise.
    const status = content.serviceNote.status;
    const color  = status === "red" ? V2_SOFT_RED : V2_WARNING;
    const bgTint = status === "red" ? "#FFF3F3"   : "#FFF7E6";
    serviceNoteHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + bgTint + ';border:1px solid ' + color + ';border-left:4px solid ' + color + ';border-radius:12px;margin-top:14px;">' +
        '<tr>' +
          '<td style="padding:14px 16px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_INK + ';">' +
              safe(content.serviceNote.title || "Note") +
            '</div>' +
            '<p style="margin:6px 0 0;font-size:14.5px;line-height:1.55;color:' + V2_INK + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
              safe(content.serviceNote.message || "") +
            '</p>' +
          '</td>' +
        '</tr>' +
      '</table>';
  } else if (content.serviceNote && content.serviceNote.status === "green") {
    // Green path: calm but explicit. The default message ends with an
    // invitation to flag anything off — the customer should never feel
    // the email is closing the loop on them.
    //
    // v2.5 — When the no-concern streak reaches 5+, append a subtle
    // continuity line BELOW the main message. The streak isn't a
    // headline; it's a quiet confidence signal. Color is muted on
    // purpose so it never reads as marketing.
    //
    // TODO portal: when issue history exists, this is a natural
    // anchor for "view continuity history" linking to the customer
    // dashboard's per-tech timeline.
    const greenTitle   = content.serviceNote.title   || "No concerns logged";
    const greenMessage = content.serviceNote.message ||
      "Nothing needed from your team. If anything looks off, tap below and we’ll take care of it.";
    const streakLineHtml = (n.trustSignals && n.trustSignals.noConcernMessage)
      ? ('<div style="margin-top:8px;font-size:12px;color:#1B5E20;opacity:0.75;font-style:italic;">' +
           safe(n.trustSignals.noConcernMessage) +
         '</div>')
      : "";
    serviceNoteHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:#F1FBF4;border:1px solid #BFEACB;border-left:4px solid ' + V2_SUCCESS + ';border-radius:12px;margin-top:14px;">' +
        '<tr>' +
          '<td style="padding:14px 16px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:#1B5E20;">' +
              safe(greenTitle) +
            '</div>' +
            '<p style="margin:6px 0 0;font-size:14.5px;line-height:1.55;color:#0F3E1A;">' +
              safe(greenMessage) +
            '</p>' +
            streakLineHtml +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- Photo proof section ----
  // Spec: "photos large enough to be useful", framed cards with rounded
  // corners + subtle border + shadow. Omitted entirely when no photos
  // exist (no empty placeholder). Each photo is a framed cell at 50%
  // table width — clients render at ~268px, which is large enough for
  // a customer to actually see the cleaned area on phone or desktop.
  let photoCardHtml = "";
  if (Array.isArray(n.photoUrls) && n.photoUrls.length) {
    const cells = n.photoUrls.slice(0, 12).map(function (url) {
      return (
        '<td valign="top" width="50%" style="padding:6px;">' +
          '<a href="' + safe(url) + '" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;">' +
            '<div style="border:1px solid ' + V2_CARD_BORDER + ';border-radius:10px;overflow:hidden;background:#FFFFFF;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
              '<img src="' + safe(url) + '" alt="Cleaning photo" ' +
                   'style="display:block;width:100%;max-width:280px;height:auto;border:0;" />' +
            '</div>' +
          '</a>' +
        '</td>'
      );
    });
    // Two photos per row. Pad the last row if odd count so widths stay even.
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
      const pair = cells.slice(i, i + 2).join("");
      const pad  = cells.slice(i, i + 2).length === 1 ? '<td width="50%" style="padding:6px;"></td>' : '';
      rows.push('<tr>' + pair + pad + '</tr>');
    }
    // Photo section: spec-defined title + subtext. The subtext frames
    // photos as "verify the visit" — proof, not decoration. The model
    // can override photoSectionTitle through the JSON; the subtext is
    // template-fixed so the framing is consistent.
    const photoTitle = content.photoSectionTitle || "After-photos from tonight’s clean";
    const photoCountLabel = n.photoUrls.length === 1 ? "1 photo" : (n.photoUrls.length + " photos");
    photoCardHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:12px;margin-top:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
        '<tr>' +
          '<td class="dcr-card" style="padding:18px 18px 12px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">' +
              safe(photoTitle) +
            '</div>' +
            '<div style="font-size:13.5px;color:' + V2_INK + ';margin:6px 0 4px;line-height:1.5;">' +
              'Photos are included so you can quickly verify the visit.' +
            '</div>' +
            '<div style="font-size:12px;color:' + V2_MUTED + ';margin:0 0 10px;">' + safe(photoCountLabel) + '</div>' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
              rows.join("") +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- Feedback buttons ----
  const complimentUrl =
    FEEDBACK_BASE + "/feedback/compliment?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId);
  const problemUrl =
    FEEDBACK_BASE + "/feedback/problem?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId);
  const complimentLabel = content.complimentButtonText ||
    (firstName ? ("Tell " + firstName + " they did a great job") : "Send a compliment");
  const problemLabel    = content.problemButtonText || "Something wasn’t quite right";
  const feedbackHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">' +
      '<tr>' +
        '<td style="padding:0 0 8px;font-size:13px;color:' + V2_MUTED + ';text-align:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
          safe(content.feedbackPrompt || "How did we do?") +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
            '<tr>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(complimentUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
                  safe(complimentLabel) +
                '</a>' +
              '</td>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(problemUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_CARD_BG + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border:1px solid ' + V2_CARD_BORDER + ';border-radius:999px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
                  safe(problemLabel) +
                '</a>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- Footer (calm) ----
  const footerHtml =
    '<div style="margin-top:18px;padding:16px 4px;text-align:center;">' +
      '<div style="font-size:12px;color:' + V2_MUTED + ';line-height:1.55;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
        safe(content.footerNote || "Thanks for choosing Pioneer Commercial Cleaning.") +
      '</div>' +
      '<div style="font-size:11px;color:' + V2_MUTED + ';margin-top:6px;">' +
        safe(PIONEER_BRAND_NAME) + ' &middot; ' +
        '<a href="mailto:info@pioneercomclean.com" style="color:' + V2_MUTED + ';text-decoration:underline;">info@pioneercomclean.com</a>' +
      '</div>' +
    '</div>';

  // ---- Final assembly ----
  // The outer <body> background uses V2_SURFACE; the visible card column
  // is max-width 600px centered. Both Gmail web + iOS Mail honor this.
  const preheader = safe(content.preheader || "");
  return (
    '<!doctype html><html><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<meta name="x-apple-disable-message-reformatting"/>' +
      '<title>' + safe(content.subject || "Cleaning report") + '</title>' +
      '<style>' +
        // Tighten paddings on mobile. Clients that strip <style> still
        // get a readable layout from the inline declarations.
        '@media only screen and (max-width: 480px) {' +
          '.dcr-outer { padding: 12px 8px !important; }' +
          '.dcr-card  { padding: 14px !important; }' +
        '}' +
      '</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + V2_SURFACE + ';">' +
      // Inbox-preview text — hidden visually, used by Gmail/iOS preview line.
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:' + V2_SURFACE + ';">' +
        preheader + '&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;' +
      '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + V2_SURFACE + ';">' +
        '<tr>' +
          '<td class="dcr-outer" align="center" style="padding:24px 16px;">' +
            '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">' +
              '<tr><td>' + headerCardHtml + '</td></tr>' +
              '<tr><td>' + techCardHtml + '</td></tr>' +
              '<tr><td>' + resolvedChipHtml + '</td></tr>' +   /* v2.5 scaffold — empty today */
              '<tr><td>' + summaryCardHtml + '</td></tr>' +
              '<tr><td>' + serviceNoteHtml + '</td></tr>' +
              '<tr><td>' + highlightsCardHtml + '</td></tr>' +
              /* TODO portal: insert a "tonight vs. last 30 days" trend
                 strip here (avg score, photo coverage, response time)
                 when the analytics dashboard ships. */
              '<tr><td>' + photoCardHtml + '</td></tr>' +
              /* TODO portal: link "Photos from tonight" to an
                 expandable photo history per customer location. */
              '<tr><td>' + feedbackHtml + '</td></tr>' +
              '<tr><td>' + footerHtml + '</td></tr>' +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</body></html>'
  );
}

/* ============================================================================
 * V3 — Daily Trust Receipt
 * ============================================================================
 * Layout brief: collapse V2's stack of cards into ONE cohesive report.
 * The customer should be able to answer in under 4 seconds:
 *   1. Did the visit go well?      → header status pill + trust strip
 *   2. Who cleaned?                → tech row inside Visit Summary
 *   3. What was completed?         → zone summary (check rows)
 *   4. What's the proof?           → photo evidence
 *   5. What do I do if something was off?  → feedback CTAs
 *
 * Same content JSON contract as V2 (renderDcrEmailHtmlV3 reads the same
 * shape produced by generateDcrEmailContentJsonV2). Only the rendering
 * layer is new — no prompt change.
 * --------------------------------------------------------------------------- */

// Status pill for the header line. Green status carries the "All Clear"
// signal so the standalone green card from V2 can be dropped.
function v3HeaderStatusPill(status) {
  const s = (status === "red" || status === "yellow") ? status : "green";
  if (s === "green") {
    return (
      '<span style="display:inline-block;padding:3px 10px 3px 8px;border-radius:999px;' +
                   'background:#E8F7EB;color:#1B5E20;font-size:12px;font-weight:700;' +
                   'border:1px solid #BFEACB;line-height:1.4;white-space:nowrap;">' +
        '<span style="display:inline-block;width:7px;height:7px;border-radius:4px;' +
                     'background:' + V2_SUCCESS + ';margin-right:6px;vertical-align:middle;"></span>' +
        'All Clear' +
      '</span>'
    );
  }
  if (s === "yellow") {
    return (
      '<span style="display:inline-block;padding:3px 10px 3px 8px;border-radius:999px;' +
                   'background:#FFF7E6;color:#7A4A05;font-size:12px;font-weight:700;' +
                   'border:1px solid #FDE3A8;line-height:1.4;white-space:nowrap;">' +
        '<span style="display:inline-block;width:7px;height:7px;border-radius:4px;' +
                     'background:' + V2_WARNING + ';margin-right:6px;vertical-align:middle;"></span>' +
        'Heads-up' +
      '</span>'
    );
  }
  return (
    '<span style="display:inline-block;padding:3px 10px 3px 8px;border-radius:999px;' +
                 'background:#FFF1F1;color:#8A2A2A;font-size:12px;font-weight:700;' +
                 'border:1px solid #F5C3C3;line-height:1.4;white-space:nowrap;">' +
      '<span style="display:inline-block;width:7px;height:7px;border-radius:4px;' +
                   'background:' + V2_SOFT_RED + ';margin-right:6px;vertical-align:middle;"></span>' +
      'Follow-up needed' +
    '</span>'
  );
}

// Short inline tagline beside the tech name. Pilot v20260527-tenure —
// prefer the precomputed n.techTenureLabel (set by mintReportToken's
// sibling buildTechTenureLabel call against the real DCR history). The
// old visitCount-driven heuristic understated experienced techs
// ("getting familiar" for techs who've been at a site for years). When
// tenure data is available, that string wins; the visitCount fallback
// only fires when no tenure label was attached.
function v3VisitTagline(visitCount, n) {
  if (n && typeof n.techTenureLabel === "string" && n.techTenureLabel.trim()) {
    return n.techTenureLabel.trim().replace(/\.$/, "");
  }
  if (visitCount == null) return "Experienced Pioneer cleaning tech";
  if (visitCount >= 25)   return "Regular Pioneer tech at this location";
  if (visitCount >= 6)    return visitCount + " visits at this location";
  if (visitCount >= 2)    return "Part of the regular Pioneer team for this location";
  return "Experienced Pioneer cleaning tech";
}

// Build the trust strip tile list. Each tile is { label, value }. The
// spec is explicit: "do not fabricate data" — values that aren't
// available are simply omitted, NOT filled with placeholders. The
// renderer trims to a max of 4 visible tiles so the strip stays
// compact across all reasonable data states.
function v3BuildTrustStripTiles(n, content) {
  const tiles = [];

  // Status — always present (derived from serviceNote.status).
  const status = content && content.serviceNote && content.serviceNote.status;
  tiles.push({
    label: "Status",
    value: status === "red"    ? "Follow-up"
         : status === "yellow" ? "Heads-up"
         :                       "All Clear"
  });

  // Photos — only when at least one photo landed.
  if (n.photoUrls && n.photoUrls.length > 0) {
    tiles.push({ label: "Photos", value: String(n.photoUrls.length) });
  }

  // Zones — completed-section count from the AI content payload.
  const zoneCount = (content && Array.isArray(content.serviceHighlights))
                      ? content.serviceHighlights.length : 0;
  if (zoneCount > 0) {
    tiles.push({ label: "Zones", value: String(zoneCount) });
  }

  // Issues — surfaced only when nonzero (a "0" tile would be redundant
  // with the green status pill).
  const issueCount = (n.issueItems && n.issueItems.length) || 0;
  if (issueCount > 0) {
    tiles.push({ label: "Issues", value: String(issueCount) });
  }

  // Visit # — from server-side trust signals.
  const visitCount = n.trustSignals && n.trustSignals.cleanerVisitCount;
  if (visitCount != null && visitCount > 0) {
    tiles.push({ label: "Visit #", value: String(visitCount) });
  }

  // Submitted at — only when a timestamp was on the submission_meta.
  const submittedTime = v3FormatSubmittedTime(n);
  if (submittedTime) {
    tiles.push({ label: "Submitted", value: submittedTime });
  }

  // Cap at 4 tiles. Status + 3 most informative remaining.
  return tiles.slice(0, 4);
}

// "9:42 PM" or "" when no submission timestamp is available. Uses
// Pacific time (Pioneer's operating timezone) so the displayed time
// matches what a tech would see on their device.
function v3FormatSubmittedTime(n) {
  const ms = trustTsMs(n.submittedAt);
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour:     "numeric",
      minute:   "2-digit",
      hour12:   true
    }).format(new Date(ms));
  } catch (_e) { return ""; }
}

// Stable Report ID. Format: DCR-YYYYMMDD-CUSTOMER-XXXXXX. Always
// derivable from data, never null when dcrId is present, so we don't
// need a TODO branch.
function v3BuildReportId(n) {
  if (!n.dcrId) return "";
  // Cleaning date — fall back to today if missing.
  let datePart = "";
  if (n.cleaningDate && /^\d{4}-\d{2}-\d{2}$/.test(n.cleaningDate)) {
    datePart = n.cleaningDate.replace(/-/g, "");
  } else {
    const d = new Date();
    datePart = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    ].join("");
  }
  const customerSlug = (n.customerId || "customer").toString();
  const customerToken = customerSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
  // Tail: first 6 chars of the dcrId, alphanumeric only. Stable per DCR.
  const tail = n.dcrId.replace(/[^A-Za-z0-9]+/g, "").slice(0, 6).toUpperCase();
  return "DCR-" + datePart + "-" + customerToken + "-" + tail;
}

/* ----------------------------------------------------------------------------
 * renderDcrEmailHtmlV3 — Daily Trust Receipt
 *
 * PURE function. Same input shape as V2 (n + content). Different
 * layout: one cohesive report, not a stack of cards.
 * --------------------------------------------------------------------------- */
function renderDcrEmailHtmlV3(n, content) {
  const safe = htmlEscape;
  const dateLong = formatHumanDate(n.cleaningDate);
  const dateShort = dateLong ? formatHumanDateShort(n.cleaningDate) : "";
  const firstName = (n.techName || "").trim().split(/\s+/)[0] || "";
  const ts = n.trustSignals || {};

  // ---- 1. Slim brand strip ----
  const brandStripHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="margin-bottom:12px;">' +
      '<tr>' +
        '<td align="left" style="padding:8px 4px;">' +
          '<a href="' + safe(FEEDBACK_BASE) + '" style="text-decoration:none;display:inline-block;">' +
            '<img src="' + safe(V2_LOGO_URL) + '" alt="Pioneer Commercial Cleaning" width="96" ' +
                 'style="display:block;width:96px;max-width:96px;height:auto;border:0;outline:none;" />' +
          '</a>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 2. Header line: location · date · status pill ----
  const statusPillHtml = v3HeaderStatusPill(content && content.serviceNote && content.serviceNote.status);
  const headerLineHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="margin-bottom:14px;">' +
      '<tr>' +
        '<td valign="middle" style="padding:0 4px;">' +
          '<div style="font-size:19px;font-weight:800;letter-spacing:-0.01em;color:' + V2_INK + ';line-height:1.3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
            safe(n.customerName || "Your location") +
          '</div>' +
          '<div style="margin-top:4px;font-size:13px;color:' + V2_MUTED + ';">' +
            (dateLong ? safe(dateLong) : '') +
            (dateLong ? '<span style="display:inline-block;width:8px;"></span>' : '') +
            statusPillHtml +
          '</div>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 3. Unified Visit Summary card ----
  // Tech row (avatar + name + tagline), then one summary sentence,
  // then optional signature row, then the trust strip. All inside ONE
  // card so the page no longer feels like a stack of modules.
  const initial = (n.techName || "P").charAt(0).toUpperCase();
  const avatarHtml = n.techPhotoUrl
    ? '<img src="' + safe(n.techPhotoUrl) + '" alt="" width="56" height="56" ' +
      'style="display:block;width:56px;height:56px;border-radius:28px;object-fit:cover;border:2px solid #FFFFFF;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';" />'
    : '<div style="width:56px;height:56px;border-radius:28px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:22px;font-weight:800;line-height:56px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';">' +
        safe(initial) +
      '</div>';

  const tagline = v3VisitTagline(ts.cleanerVisitCount, n);
  const techRowHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr>' +
        '<td width="68" valign="middle" style="width:68px;padding-right:12px;">' + avatarHtml + '</td>' +
        '<td valign="middle">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">Cleaned by</div>' +
          '<div style="font-size:17px;font-weight:700;color:' + V2_INK + ';margin-top:2px;line-height:1.25;">' +
            safe(n.techName || "Your Pioneer tech") +
            (tagline
              ? ('<span style="font-weight:500;color:' + V2_MUTED + ';font-size:13.5px;"> · ' + safe(tagline) + '</span>')
              : '') +
          '</div>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // The single concise summary sentence (AI-generated, banned-word
  // scrubbed). One line, not a paragraph.
  const summaryLineHtml =
    '<p style="margin:14px 0 0;font-size:14.5px;line-height:1.55;color:' + V2_INK + ';">' +
      safe(content.openingSummary || "") +
    '</p>';

  // Signature row — small, inline, only when a signature URL was
  // resolved. Caption per spec.
  let signatureRowHtml = "";
  if (n.signatureUrl) {
    signatureRowHtml =
      '<div style="margin-top:14px;padding-top:12px;border-top:1px dashed ' + V2_CARD_BORDER + ';">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:6px;">Report signed after visit</div>' +
        '<div style="background:' + V2_SURFACE + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:8px;padding:6px 10px;display:inline-block;">' +
          '<img src="' + safe(n.signatureUrl) + '" alt="Tech signature" ' +
               'style="display:block;max-height:46px;max-width:200px;border:0;outline:none;" />' +
        '</div>' +
      '</div>';
  }

  // ---- 4. Trust strip (inside Visit Summary card) ----
  const tiles = v3BuildTrustStripTiles(n, content);
  const tileCount = tiles.length;
  // Render tiles as a single equal-width row. At wider widths, all
  // tiles fit on one row. On narrow screens email clients flow the
  // table cells onto multiple lines naturally.
  const tileCellsHtml = tiles.map(function (t) {
    return (
      '<td valign="top" align="center" width="' + Math.floor(100 / tileCount) + '%" ' +
          'style="padding:8px 6px;background:' + V2_SURFACE + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:8px;' +
                 'mso-padding-alt:8px;">' +
        '<div style="font-size:10.5px;letter-spacing:0.6px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">' +
          safe(t.label) +
        '</div>' +
        '<div style="font-size:14px;font-weight:700;color:' + V2_INK + ';margin-top:3px;">' +
          safe(t.value) +
        '</div>' +
      '</td>'
    );
  }).join('<td style="width:6px;"></td>');
  const trustStripHtml =
    '<div style="margin-top:16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
        '<tr>' + tileCellsHtml + '</tr>' +
      '</table>' +
    '</div>';

  const visitSummaryCardHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04);margin-bottom:14px;">' +
      '<tr>' +
        '<td class="dcr-card" style="padding:18px 20px;">' +
          techRowHtml +
          summaryLineHtml +
          signatureRowHtml +
          trustStripHtml +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 7. Conditional alert card (yellow/red ONLY) ----
  // Green is handled by the header pill + trust strip.
  let alertCardHtml = "";
  const noteStatus = content && content.serviceNote && content.serviceNote.status;
  if (noteStatus === "yellow" || noteStatus === "red") {
    const color  = noteStatus === "red" ? V2_SOFT_RED : V2_WARNING;
    const bgTint = noteStatus === "red" ? "#FFF3F3"   : "#FFF7E6";
    alertCardHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + bgTint + ';border:1px solid ' + color + ';border-left:4px solid ' + color + ';border-radius:12px;margin-bottom:14px;">' +
        '<tr>' +
          '<td style="padding:14px 16px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_INK + ';">' +
              safe(content.serviceNote.title ||
                (noteStatus === "red" ? "Manager follow-up needed" : "Note from tonight's visit")) +
            '</div>' +
            '<p style="margin:6px 0 0;font-size:14.5px;line-height:1.55;color:' + V2_INK + ';">' +
              safe(content.serviceNote.message || "") +
            '</p>' +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- 5. Zone Summary — check rows, NOT card chrome ----
  // No outer card border; bullets render directly on the soft surface.
  // Spec: never include "No concerns logged" here — that belongs to
  // the header pill / trust strip.
  let zoneSummaryHtml = "";
  const sections = Array.isArray(content.serviceHighlights) ? content.serviceHighlights : [];
  const allBullets = [];
  sections.forEach(function (h) {
    if (!h || !Array.isArray(h.bullets)) return;
    h.bullets.forEach(function (b) {
      const s = String(b || "").trim();
      // Exclude the spec-banned "No concerns logged" bullet from the
      // zone list — it's a status signal, not a completed-zone signal.
      if (!s) return;
      if (/^no\s+concerns\s+logged\.?$/i.test(s)) return;
      allBullets.push(s);
    });
  });

  // Cap at 6 rows so the report stays scannable. Safe fallback when
  // the catalog returns nothing actionable.
  let bulletsToRender = allBullets.slice(0, 6);
  if (bulletsToRender.length === 0) {
    bulletsToRender = [
      "Standard cleaning scope completed",
      "Visit documented by the Pioneer team"
    ];
  }

  zoneSummaryHtml =
    '<div style="margin:0 4px 18px;">' +
      '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:10px;">What was completed</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
        bulletsToRender.map(function (line) {
          return (
            '<tr>' +
              '<td valign="top" width="20" style="padding:4px 8px 4px 0;color:' + V2_SUCCESS + ';font-weight:800;font-size:14.5px;">✓</td>' +
              '<td valign="top" style="padding:4px 0;font-size:14.5px;line-height:1.5;color:' + V2_INK + ';">' +
                safe(line) +
              '</td>' +
            '</tr>'
          );
        }).join("") +
      '</table>' +
    '</div>';

  // ---- 6. Photo Evidence ----
  let photoSectionHtml = "";
  if (Array.isArray(n.photoUrls) && n.photoUrls.length) {
    const photos = n.photoUrls.slice(0, 4);
    const cells = photos.map(function (url, i) {
      const caption = "After-photo " + (i + 1);
      return (
        '<td valign="top" width="50%" style="padding:6px;">' +
          '<a href="' + safe(url) + '" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;">' +
            '<div style="border:1px solid ' + V2_CARD_BORDER + ';border-radius:10px;overflow:hidden;background:' + V2_SURFACE + ';box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
              '<img src="' + safe(url) + '" alt="Cleaning photo" ' +
                   'style="display:block;width:100%;max-width:280px;height:auto;border:0;" />' +
              '<div style="padding:6px 10px;font-size:11.5px;color:' + V2_MUTED + ';background:#FFFFFF;border-top:1px solid ' + V2_CARD_BORDER + ';">' +
                safe(caption) +
              '</div>' +
            '</div>' +
          '</a>' +
        '</td>'
      );
    });
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
      const pair = cells.slice(i, i + 2).join("");
      const pad  = cells.slice(i, i + 2).length === 1 ? '<td width="50%" style="padding:6px;"></td>' : '';
      rows.push('<tr>' + pair + pad + '</tr>');
    }
    photoSectionHtml =
      '<div style="margin:0 4px 18px;">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:10px;">After-photos from tonight’s clean</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
          rows.join("") +
        '</table>' +
      '</div>';
  }

  // ---- 8. Feedback CTAs ----
  // The feedback pages are static HTML at /feedback-compliment.html and
  // /feedback-issue.html. They read dcrId / customerId / techId from
  // the URL and POST to submitFeedbackV1, which writes Firestore +
  // emails the office. techId lets the server resolve the cleaning_techs
  // doc without re-querying by DCR.
  const complimentUrl =
    FEEDBACK_BASE + "/feedback-compliment.html?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId) +
    "&techId=" + encodeURIComponent(n.techSlug || "");
  const problemUrl =
    FEEDBACK_BASE + "/feedback-issue.html?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId) +
    "&techId=" + encodeURIComponent(n.techSlug || "");
  const complimentLabel = (content && content.complimentButtonText) ||
    (firstName ? ("Tell " + firstName + " they did a great job") : "Send a compliment");
  const problemLabel    = (content && content.problemButtonText) || "Something wasn’t quite right";
  const feedbackHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;">' +
      '<tr>' +
        '<td style="padding:0 4px 10px;font-size:13px;color:' + V2_MUTED + ';text-align:center;">' +
          safe((content && content.feedbackPrompt) || "Quick feedback helps us keep your building dialed in.") +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
            '<tr>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(complimentUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border-radius:999px;">' +
                  safe(complimentLabel) +
                '</a>' +
              '</td>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(problemUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_CARD_BG + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border:1px solid ' + V2_CARD_BORDER + ';border-radius:999px;">' +
                  safe(problemLabel) +
                '</a>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 9. Warmer footer + Report ID + portal link ----
  // TODO portal: "View full report →" will land at /reports/<reportId>
  // once the customer-facing dashboard ships. Currently it links to the
  // hosting root as a polite no-op so the email isn't broken.
  const reportId = v3BuildReportId(n);
  const footerHtml =
    '<div style="margin-top:8px;padding:18px 4px 4px;text-align:center;border-top:1px solid ' + V2_CARD_BORDER + ';">' +
      '<div style="font-size:13.5px;color:' + V2_INK + ';font-weight:600;line-height:1.5;">' +
        'Thank you for your continued partnership.' +
      '</div>' +
      (reportId
        ? ('<div style="font-size:11.5px;color:' + V2_MUTED + ';margin-top:8px;">' +
             'Report ' + safe(reportId) + '<span style="display:inline-block;width:10px;"></span>' +
             '<a href="' + safe(FEEDBACK_BASE) + '" style="color:' + V2_MUTED + ';text-decoration:underline;">View full report →</a>' +
           '</div>')
        : '') +
      '<div style="font-size:11px;color:' + V2_MUTED + ';margin-top:10px;">' +
        safe(PIONEER_BRAND_NAME) + ' &middot; ' +
        '<a href="mailto:info@pioneercomclean.com" style="color:' + V2_MUTED + ';text-decoration:underline;">info@pioneercomclean.com</a>' +
      '</div>' +
    '</div>';

  // ---- Final assembly ----
  const preheader = safe((content && content.preheader) || "");
  return (
    '<!doctype html><html><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<meta name="x-apple-disable-message-reformatting"/>' +
      '<title>' + safe((content && content.subject) || "Cleaning report") + '</title>' +
      '<style>' +
        '@media only screen and (max-width: 480px) {' +
          '.dcr-outer { padding: 10px 8px !important; }' +
          '.dcr-card  { padding: 14px !important; }' +
        '}' +
      '</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + V2_SURFACE + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:' + V2_SURFACE + ';">' +
        preheader + '&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;' +
      '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + V2_SURFACE + ';">' +
        '<tr>' +
          '<td class="dcr-outer" align="center" style="padding:22px 16px;">' +
            '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">' +
              '<tr><td>' + brandStripHtml + '</td></tr>' +
              '<tr><td>' + headerLineHtml + '</td></tr>' +
              '<tr><td>' + visitSummaryCardHtml + '</td></tr>' +
              '<tr><td>' + alertCardHtml + '</td></tr>' +
              '<tr><td>' + zoneSummaryHtml + '</td></tr>' +
              '<tr><td>' + photoSectionHtml + '</td></tr>' +
              '<tr><td>' + feedbackHtml + '</td></tr>' +
              '<tr><td>' + footerHtml + '</td></tr>' +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</body></html>'
  );
}

// Compact form of formatHumanDate for the V3 header line.
// "Sun, May 10" (no year) vs full "Sunday, May 10, 2026" from V2.
function formatHumanDateShort(yyyyMmDd) {
  if (!yyyyMmDd) return "";
  try {
    const d = new Date(yyyyMmDd + "T12:00:00");
    if (isNaN(d.getTime())) return String(yyyyMmDd);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch (_e) { return String(yyyyMmDd); }
}

/* ============================================================================
 * V4 — "Daily Cleaning Report" focused rebuild
 *
 * V4 is a focused rev of V3, NOT a full rewrite. Changes:
 *   1. Signature moves INTO the tech identity row (right side), no longer a
 *      separate block below the summary.
 *   2. Trust-strip tiles use stronger metrics with a clear priority order
 *      (Tasks/Scope · Streak · Report · Photos). Ambiguous "Visit #" tile
 *      is gone. "Status" tile is gone (the header pill already carries it).
 *   3. Slim brand strip carries a "Daily Cleaning Report" label on the right
 *      with a thin divider below.
 *   4. Status pill is filled (not soft-tinted) for stronger visual weight.
 *   5. Photo section heading is "After photos" (no "1 photo" callout).
 *   6. Footer "View full report →" is bolder + accent-coloured.
 *
 * Same content JSON contract as V2/V3 — only the renderer + tile selector
 * change. Prompt is bumped to v2.6 only because the sparse-data fallback
 * dropped from 3 bullets to 2.
 * ========================================================================== */

// V4 status pill — filled background, bolder type. White text on green/red
// so the pill reads clearly on a white email background; dark ink on the
// amber pill so contrast stays AA.
//
// streakCount (optional) — when status is green and the streak is ≥ 5,
// append "· N-visit streak" to the pill so the customer reads both
// "this visit was clean" AND "the trend is strong" in one glance.
// Below the threshold, the streak is omitted from the pill (the trust
// strip's Streak tile still surfaces lower-N streaks at ≥ 2).
function v4HeaderStatusPill(status, streakCount) {
  const s = (status === "red" || status === "yellow") ? status : "green";
  const streak = Number(streakCount) || 0;
  if (s === "green") {
    const streakSuffix = (streak >= 5)
      ? (' <span style="opacity:0.85;font-weight:700;">· ' + streak + '-visit streak</span>')
      : '';
    return (
      '<span style="display:inline-block;padding:4px 12px;border-radius:999px;' +
                   'background:' + V2_SUCCESS + ';color:#FFFFFF;font-size:12px;font-weight:800;' +
                   'line-height:1.4;white-space:nowrap;letter-spacing:0.2px;">' +
        '<span style="display:inline-block;width:6px;height:6px;border-radius:3px;' +
                     'background:#FFFFFF;margin-right:6px;vertical-align:middle;opacity:0.9;"></span>' +
        'All Clear' + streakSuffix +
      '</span>'
    );
  }
  if (s === "yellow") {
    return (
      '<span style="display:inline-block;padding:4px 12px;border-radius:999px;' +
                   'background:' + V2_WARNING + ';color:#3A2A05;font-size:12px;font-weight:800;' +
                   'line-height:1.4;white-space:nowrap;letter-spacing:0.2px;">' +
        '<span style="display:inline-block;width:6px;height:6px;border-radius:3px;' +
                     'background:#3A2A05;margin-right:6px;vertical-align:middle;opacity:0.7;"></span>' +
        'Heads-up' +
      '</span>'
    );
  }
  return (
    '<span style="display:inline-block;padding:4px 12px;border-radius:999px;' +
                 'background:' + V2_SOFT_RED + ';color:#FFFFFF;font-size:12px;font-weight:800;' +
                 'line-height:1.4;white-space:nowrap;letter-spacing:0.2px;">' +
      '<span style="display:inline-block;width:6px;height:6px;border-radius:3px;' +
                   'background:#FFFFFF;margin-right:6px;vertical-align:middle;opacity:0.9;"></span>' +
      'Follow-up needed' +
    '</span>'
  );
}

// V5/V6 — server-derived completed bullets. Walks `n.completedItems`
// (already grouped by section in `normalizeDcrForEmail`), tags each
// section into a category (bathrooms/entry/offices/floors/trash/
// hightouch/kitchen/glass/general/other), then resolves the final
// bullet list with V6 customer-altitude combinations:
//   • offices + floors  → "Offices and floors completed"
//   • trash + hightouch → "Trash and high-touch areas handled"
//   • each other tag    → its own customer-altitude bullet
//
// Returns:
//   { bullets:       ordered customer-altitude bullets,
//     sectionsUsed:  original section names that contributed,
//     source:        "server_derived" | "none" }
function v5CategoryForSection(section) {
  const s = String(section || "").toLowerCase().trim();
  if (!s) return "";
  if (s.indexOf("restroom") >= 0 || s.indexOf("bathroom") >= 0) return "bathrooms";
  if (s.indexOf("kitchen") >= 0 || s.indexOf("breakroom") >= 0 || s.indexOf("break room") >= 0) return "kitchen";
  if (s.indexOf("trash") >= 0 || s.indexOf("recycl") >= 0 || s.indexOf("liner") >= 0) return "trash";
  if (s.indexOf("high-touch") >= 0 || s.indexOf("high touch") >= 0) return "hightouch";
  if (s.indexOf("entry") >= 0 || s.indexOf("vestibule") >= 0 ||
      s.indexOf("foyer") >= 0 || s.indexOf("lobby") >= 0) return "entry";
  if (s.indexOf("glass") >= 0 || s.indexOf("window") >= 0 || s.indexOf("mirror") >= 0) return "glass";
  if (s.indexOf("floor") >= 0) return "floors";
  if (s.indexOf("office") >= 0) return "offices";
  if (s.indexOf("general") >= 0 || s.indexOf("common") >= 0) return "general";
  return "other";
}

// Back-compat shim: emit the SINGLE-section bullet for a given section
// name. Callers that don't need the V6 combination logic still get the
// same shape they had under V5. Internally drives the no-combination
// fallback path for categories like "kitchen" / "bathrooms".
function v5CanonicalBulletForSection(section) {
  const cat = v5CategoryForSection(section);
  switch (cat) {
    case "bathrooms": return "Bathrooms cleaned and restocked";
    case "entry":     return "Entry and foyer areas reset";
    case "floors":    return "Floors completed";
    case "offices":   return "Offices cleaned";
    case "trash":     return "Trash removed and liners replaced";
    case "hightouch": return "High-touch areas handled";
    case "kitchen":   return "Kitchen/breakroom cleaned";
    case "glass":     return "Glass cleaned";
    case "general":   return "Common areas reset";
    case "other": {
      const original = String(section || "").trim();
      return original ? (original + " cleaned") : "";
    }
    default: return "";
  }
}

function v5BuildCompletedBulletsFromChecklist(n) {
  const items = (n && n.completedItems) || [];
  if (!items.length) return { bullets: [], sectionsUsed: [], source: "none" };

  // Walk completedItems, group by section, tag with V6 category.
  // Preserve first-appearance order so the rendered bullets read in
  // the order the tech actually worked through the building.
  const tagAppearance = []; // ordered list of unique category tags
  const sectionsForTag = Object.create(null); // tag → [section names that fed it]
  const sectionSeen   = Object.create(null);
  items.forEach(function (it) {
    const k   = String((it && it.section) || "General").trim();
    if (!k || sectionSeen[k]) return;
    sectionSeen[k] = true;
    const tag = v5CategoryForSection(k);
    if (!tag) return;
    if (!sectionsForTag[tag]) {
      sectionsForTag[tag] = [];
      tagAppearance.push(tag);
    }
    sectionsForTag[tag].push(k);
  });

  // Combinations — when both halves appear, emit the combined bullet
  // and "consume" both tags. Order matters because the combined
  // bullet inherits the position of the FIRST appearing tag.
  const combos = [
    { pair: ["offices",  "floors"],    bullet: "Offices and floors completed" },
    { pair: ["trash",    "hightouch"], bullet: "Trash and high-touch areas handled" }
  ];
  const consumed = Object.create(null);
  const finalBullets = [];
  const finalSections = [];
  function pushUnique(bullet, sections) {
    if (!bullet || finalBullets.indexOf(bullet) >= 0) return;
    if (finalBullets.length >= 6) return;
    finalBullets.push(bullet);
    finalSections.push.apply(finalSections, sections || []);
  }
  for (let i = 0; i < tagAppearance.length; i++) {
    const tag = tagAppearance[i];
    if (consumed[tag]) continue;
    // Check combos rooted at this tag.
    let combined = false;
    for (let c = 0; c < combos.length; c++) {
      const pair = combos[c].pair;
      if (pair.indexOf(tag) < 0) continue;
      const other = pair[0] === tag ? pair[1] : pair[0];
      if (sectionsForTag[other] && !consumed[other]) {
        pushUnique(combos[c].bullet,
          (sectionsForTag[pair[0]] || []).concat(sectionsForTag[pair[1]] || []));
        consumed[pair[0]] = true;
        consumed[pair[1]] = true;
        combined = true;
        break;
      }
    }
    if (combined) continue;
    // No combo applied — emit the single bullet for this tag.
    const single = v5CanonicalBulletForSection((sectionsForTag[tag] || [])[0] || tag);
    pushUnique(single, sectionsForTag[tag]);
    consumed[tag] = true;
  }

  return {
    bullets:      finalBullets,
    sectionsUsed: finalSections,
    source:       "server_derived"
  };
}

// V5 — "Next clean: Tue, May 20 · 8:30 PM" formatter. Returns "" when
// the timestamp can't be parsed or isn't in the future. Used by the
// renderer to emit the next-visit hint inside the Visit Summary card
// when scheduling data is available; cleanly omitted otherwise.
function formatNextCleanLine(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  try {
    const tz = "America/Los_Angeles";
    const datePart = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric"
    }).format(new Date(t));
    const timePart = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true
    }).format(new Date(t));
    return datePart + " · " + timePart;
  } catch (_e) { return ""; }
}

// Photo caption time formatter — "9:14 PM" or "" when the input can't
// be parsed to a real Date. Accepts ISO strings, epoch numbers, and
// Firestore Timestamp-shaped objects (via trustTsMs). Uses Pacific
// time so captions match the on-site clock the tech would have seen.
function formatPhotoCaptionTime(tsValue) {
  if (!tsValue) return "";
  const ms = trustTsMs(tsValue);
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour:     "numeric",
      minute:   "2-digit",
      hour12:   true
    }).format(new Date(ms));
  } catch (_e) { return ""; }
}

// Format milliseconds into a tight "2h 09m" / "47m" string. Returns
// "" for non-positive or NaN input. Used by the On-site trust tile.
function v4FormatDuration(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return "";
  const totalMinutes = Math.round(total / 60000);
  const hours        = Math.floor(totalMinutes / 60);
  const minutes      = totalMinutes - hours * 60;
  if (hours <= 0) return minutes + "m";
  const mm = minutes < 10 ? ("0" + minutes) : String(minutes);
  return hours + "h " + mm + "m";
}

// V5 trust-strip tile selector. Returns
// { tiles, metricsUsed, metricFallbacksUsed }.
//
// Priority (per the V5 spec — "preferred four tiles"):
//   1. Streak    — consecutive clean visits (when ≥ 2)
//   2. Tasks     — checklist completion (value "N/M" or "Scope complete")
//   3. Issues    — concern count from THIS visit (0 reads as reassurance,
//                  N reads as honest accounting; alert card carries detail)
//   4. On-site   — derived duration when start-time is known; falls back
//                  to "Report: Signed" only when signature exists
//
// Last-resort fallbacks (only when strong tiles can't fill 2 slots):
//   • Photos: Included — emitted ONLY if no better metric exists
//
// Hard rules:
//   • NEVER emit "Visit #" (ambiguous to customer).
//   • NEVER emit "Zones: 1" (misleadingly small).
//   • "Photos: Included" is last-resort only — never first-choice.
//   • Cap at 4 tiles total.
function v4BuildTrustStripTiles(n, content) {
  const tiles                 = [];
  const metricsUsed           = [];
  const metricFallbacksUsed   = [];

  function pushStrong(label, value) {
    tiles.push({ label: label, value: value });
    metricsUsed.push(label);
  }
  function pushFallback(label, value) {
    tiles.push({ label: label, value: value });
    metricsUsed.push(label);
    metricFallbacksUsed.push(label);
  }
  const has = function (l) { return metricsUsed.indexOf(l) >= 0; };

  // ---- 1. Streak ----
  // Surface at ≥ 2 (one prior clean visit + current = smallest streak
  // that's actually a signal). Phrasing per V5 spec: "N clean visits".
  const streak = (n.trustSignals && Number(n.trustSignals.noConcernStreak)) || 0;
  if (streak >= 2 && tiles.length < 4) {
    pushStrong("Streak", streak + " clean visits");
  }

  // ---- 2. Tasks ----
  // Value is "Scope complete" when 100% done (label stays "Tasks" for
  // consistent strip vocabulary). When the checklist is partial but
  // present, show the literal "N/M" ratio.
  const total = Number(n.taskTotalCount || 0);
  const done  = Number(n.taskDoneCount  || 0);
  if (total > 0 && tiles.length < 4) {
    pushStrong("Tasks", done === total ? "Scope complete" : (done + "/" + total));
  }

  // ---- 3. Issues ----
  // V5 promotes Issues from fallback to strong-signal. 0 = celebratory,
  // N = honest. The alert card carries the operational detail.
  const issueCount = (n.issueItems && n.issueItems.length) || 0;
  if (tiles.length < 4) {
    pushStrong("Issues", String(issueCount));
  }

  // ---- 4. Report Signed ----
  // V6 pilot — the On-site duration tile was dropped per spec ("Do
  // NOT show time-on-site duration to customers"). The fourth slot
  // now goes to "Report: Signed" when a signature URL resolved.
  // Without that, the slot stays empty rather than surfacing weak
  // signals (Photos: Included is last-resort only).
  if (n.signatureUrl && !has("Report") && tiles.length < 4) {
    pushFallback("Report", "Signed");
  }

  // ---- Last-resort: Photos ----
  // Only if fewer than 2 tiles landed (so the strip isn't empty) AND
  // at least one photo is present. Never first-choice per V5 rules.
  if (tiles.length < 2 && n.photoUrls && n.photoUrls.length > 0 &&
      !has("Photos") && tiles.length < 4) {
    pushFallback("Photos", "Included");
  }

  return {
    tiles:               tiles.slice(0, 4),
    metricsUsed:         metricsUsed.slice(0, 4),
    metricFallbacksUsed: metricFallbacksUsed
  };
}

/* ----------------------------------------------------------------------------
 * renderDcrEmailHtmlV4 — focused rebuild of V3
 *
 * PURE function. Same input shape as V2/V3 (n + content). Returns the
 * full HTML string for the customer-facing email.
 * --------------------------------------------------------------------------- */
function renderDcrEmailHtmlV4(n, content) {
  const safe = htmlEscape;
  const dateLong  = formatHumanDate(n.cleaningDate);
  const firstName = (n.techName || "").trim().split(/\s+/)[0] || "";
  const ts = n.trustSignals || {};

  // ---- 1. Slim brand strip ----
  // Logo left, "Daily Cleaning Report" label right, thin divider below.
  // The label sets customer expectations before they read anything else
  // — replaces the V3 lonely-logo strip that left the doc untitled.
  const brandStripHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="margin-bottom:10px;">' +
      '<tr>' +
        '<td align="left" valign="middle" style="padding:6px 4px;">' +
          '<a href="' + safe(FEEDBACK_BASE) + '" style="text-decoration:none;display:inline-block;">' +
            '<img src="' + safe(V2_LOGO_URL) + '" alt="Pioneer Commercial Cleaning" width="84" ' +
                 'style="display:block;width:84px;max-width:84px;height:auto;border:0;outline:none;" />' +
          '</a>' +
        '</td>' +
        '<td align="right" valign="middle" style="padding:6px 4px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">' +
          'Daily Cleaning Report' +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td colspan="2" style="padding:0 4px;">' +
          '<div style="border-top:1px solid ' + V2_CARD_BORDER + ';line-height:0;font-size:0;height:1px;">&nbsp;</div>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 2. Header line: customer name · date + status pill ----
  // V6 — status pill driven by the authoritative issueRouting.tier
  // (derived in normalizeDcrForEmail from explicit DCR fields + the
  // legacy problem signals). Falls back to the AI's serviceNote
  // status only when issueRouting is somehow absent (shouldn't
  // happen, but defensive).
  const pillTier = (n.issueRouting && n.issueRouting.tier)
    || (content && content.serviceNote && content.serviceNote.status)
    || "green";
  const statusPillHtml = v4HeaderStatusPill(pillTier, ts.noConcernStreak);
  const headerLineHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="margin-bottom:14px;">' +
      '<tr>' +
        '<td valign="middle" style="padding:0 4px;">' +
          '<div style="font-size:19px;font-weight:800;letter-spacing:-0.01em;color:' + V2_INK + ';line-height:1.3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
            safe(n.customerName || "Your location") +
          '</div>' +
          '<div style="margin-top:5px;font-size:13px;color:' + V2_MUTED + ';">' +
            (dateLong ? safe(dateLong) : '') +
            (dateLong ? '<span style="display:inline-block;width:10px;"></span>' : '') +
            statusPillHtml +
          '</div>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 3. Unified Visit Summary card (V4 — signature lives in tech row) ----
  // Tech identity row is now 3 cells:
  //   • avatar / initial    (left, 56px)
  //   • "Cleaned by" + name + tagline (middle, flexes)
  //   • signature image     (right, when resolved)
  //
  // The signature cell is marked .v4-sig-cell so the mobile media query
  // can break it onto its own line below the name on narrow screens.
  // When no signature URL resolved the cell renders empty (collapses
  // gracefully — no awkward placeholder).
  const initial = (n.techName || "P").charAt(0).toUpperCase();
  const avatarHtml = n.techPhotoUrl
    ? '<img src="' + safe(n.techPhotoUrl) + '" alt="" width="56" height="56" ' +
      'style="display:block;width:56px;height:56px;border-radius:28px;object-fit:cover;border:2px solid #FFFFFF;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';" />'
    : '<div style="width:56px;height:56px;border-radius:28px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:22px;font-weight:800;line-height:56px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;box-shadow:0 0 0 1px ' + V2_CARD_BORDER + ';">' +
        safe(initial) +
      '</div>';

  const tagline = v3VisitTagline(ts.cleanerVisitCount, n);

  // Signature cell — small caption above an inline image. V6 phrasing:
  // "Signed off-site · 9:14 PM" when a submission timestamp resolves,
  // otherwise "Signed after visit". The "off-site" framing
  // communicates that the signoff happened in the field (away from
  // Pioneer HQ), not at a desk — consistent with the trust-receipt
  // framing where the tech signs at the customer location.
  let signatureCellHtml = "";
  if (n.signatureUrl) {
    const sigTime = v3FormatSubmittedTime(n);
    const sigCaption = sigTime ? ("Signed off-site · " + sigTime) : "Signed after visit";
    signatureCellHtml =
      '<div style="font-size:10px;letter-spacing:0.8px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:4px;text-align:right;">' +
        safe(sigCaption) +
      '</div>' +
      '<div style="display:inline-block;background:' + V2_SURFACE + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:6px;padding:4px 8px;">' +
        '<img src="' + safe(n.signatureUrl) + '" alt="Tech signature" ' +
             'style="display:block;max-height:38px;max-width:140px;border:0;outline:none;" />' +
      '</div>';
  }

  const techRowHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr>' +
        '<td width="68" valign="middle" style="width:68px;padding-right:12px;">' + avatarHtml + '</td>' +
        '<td valign="middle">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">Cleaned by</div>' +
          '<div style="font-size:17px;font-weight:700;color:' + V2_INK + ';margin-top:2px;line-height:1.25;">' +
            safe(n.techName || "Your Pioneer tech") +
          '</div>' +
          (tagline
            ? ('<div style="font-size:12.5px;color:' + V2_MUTED + ';margin-top:2px;">' + safe(tagline) + '</div>')
            : '') +
        '</td>' +
        '<td class="v4-sig-cell" valign="middle" align="right" style="padding-left:8px;">' +
          signatureCellHtml +
        '</td>' +
      '</tr>' +
    '</table>';

  // Single AI-generated summary sentence (banned-word scrubbed upstream).
  const summaryLineHtml =
    '<p style="margin:14px 0 0;font-size:14.5px;line-height:1.55;color:' + V2_INK + ';">' +
      safe(content.openingSummary || "") +
    '</p>';

  // ---- 4. Trust strip (inside Visit Summary card) ----
  const tileResult = v4BuildTrustStripTiles(n, content);
  const tiles = tileResult.tiles;
  const tileCount = tiles.length;
  let trustStripHtml = "";
  if (tileCount > 0) {
    const tileCellsHtml = tiles.map(function (t) {
      return (
        '<td valign="top" align="center" width="' + Math.floor(100 / tileCount) + '%" ' +
            'style="padding:9px 8px;background:' + V2_SURFACE + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:8px;' +
                   'mso-padding-alt:9px;">' +
          '<div style="font-size:10.5px;letter-spacing:0.6px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';">' +
            safe(t.label) +
          '</div>' +
          '<div style="font-size:14px;font-weight:700;color:' + V2_INK + ';margin-top:3px;line-height:1.3;">' +
            safe(t.value) +
          '</div>' +
        '</td>'
      );
    }).join('<td style="width:6px;font-size:0;line-height:0;">&nbsp;</td>');
    trustStripHtml =
      '<div style="margin-top:16px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
          '<tr>' + tileCellsHtml + '</tr>' +
        '</table>' +
      '</div>';
  }

  // V6 pilot — the Next-clean line was dropped per spec ("Do NOT add
  // next-clean date"). The visit summary card is now just the tech
  // identity row + one-line summary + trust strip.

  const visitSummaryCardHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
           'style="background:' + V2_CARD_BG + ';border:1px solid ' + V2_CARD_BORDER + ';border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04);margin-bottom:14px;">' +
      '<tr>' +
        '<td class="dcr-card" style="padding:18px 20px;">' +
          techRowHtml +
          summaryLineHtml +
          trustStripHtml +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 5. Conditional alert card (V6 issue-tier routed) ----
  // V6 routes the alert card by `n.issueRouting.tier` (green/yellow/red),
  // not by AI's serviceNote. Three branches:
  //   green  → no card
  //   yellow → calm customer-safe note. Uses `customerAlertMessage`
  //             when set; else falls back to the AI's serviceNote.message
  //             (which the prompt already constrains to calm phrasing).
  //             Suppressed entirely when `customerVisible === false`.
  //   red    → FIXED minimal text per spec: "A Pioneer manager will
  //             follow up directly regarding an issue from tonight's
  //             visit." The AI message is intentionally ignored; we
  //             do not over-explain to the customer.
  let alertCardHtml = "";
  const routing = n.issueRouting || {};
  const tier    = routing.tier || "green";
  const showCardForCustomer = tier === "red" ||
    (tier === "yellow" && routing.customerVisible !== false);
  if (showCardForCustomer) {
    const color  = tier === "red" ? V2_SOFT_RED : V2_WARNING;
    const bgTint = tier === "red" ? "#FFF3F3"   : "#FFF7E6";
    const title  = tier === "red"
      ? "Manager follow-up incoming"
      : "Note from tonight's visit";
    let message;
    if (tier === "red") {
      message = "A Pioneer manager will follow up directly regarding an issue from tonight's visit.";
    } else {
      message = routing.customerAlertMessage
        || (content && content.serviceNote && content.serviceNote.message)
        || "A small note from tonight's visit. Nothing urgent — reach out if you have questions.";
    }
    alertCardHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
             'style="background:' + bgTint + ';border:1px solid ' + color + ';border-left:4px solid ' + color + ';border-radius:12px;margin-bottom:14px;">' +
        '<tr>' +
          '<td style="padding:14px 16px;">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_INK + ';">' +
              safe(title) +
            '</div>' +
            '<p style="margin:6px 0 0;font-size:14.5px;line-height:1.55;color:' + V2_INK + ';">' +
              safe(message) +
            '</p>' +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  // ---- 6. "What was completed" — zone bullets ----
  // V5 derives bullets server-side from the checklist sections rather
  // than relying on AI's serviceHighlights. The canonical-bullet map
  // produces operational phrasing (e.g. "Restrooms cleaned and
  // restocked") that matches what the customer actually sees on-site.
  //
  // Source priority:
  //   1. server_derived   — built from n.completedItems (real checklist)
  //   2. ai_serviceHighlights — older AI-bullet path (only used when
  //                              no checklist items but AI emitted
  //                              non-empty highlights — rare in V5)
  //   3. fallback          — "Service scope completed" only
  let bulletsToRender;
  const serverBullets = v5BuildCompletedBulletsFromChecklist(n);
  if (serverBullets.bullets.length > 0) {
    bulletsToRender = serverBullets.bullets;
  } else {
    // AI fallback — flatten serviceHighlights for back-compat with
    // older DCR data shapes that don't carry a parseable checklist.
    const sections = Array.isArray(content.serviceHighlights) ? content.serviceHighlights : [];
    const aiBullets = [];
    sections.forEach(function (h) {
      if (!h || !Array.isArray(h.bullets)) return;
      h.bullets.forEach(function (b) {
        const s = String(b || "").trim();
        if (s) aiBullets.push(s);
      });
    });
    bulletsToRender = aiBullets.slice(0, 6);
  }
  if (bulletsToRender.length === 0) {
    // Last-ditch fallback per V5 spec: a single calm line.
    bulletsToRender = ["Service scope completed"];
  }
  // V6 — when every checklist item came back done, swap the section
  // header from "What was completed" to "Full clean completed". The
  // bullets below still list the specific areas as supporting detail;
  // the header swap is a clear customer-altitude summary statement.
  const fullCleanCompleted = (Number(n.taskTotalCount || 0) > 0)
    && (Number(n.taskDoneCount || 0) === Number(n.taskTotalCount || 0));
  const completedHeaderLabel = fullCleanCompleted ? "Full clean completed" : "What was completed";
  const zoneSummaryHtml =
    '<div style="margin:0 4px 18px;">' +
      '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:10px;">' +
        safe(completedHeaderLabel) +
      '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
        bulletsToRender.map(function (line) {
          return (
            '<tr>' +
              '<td valign="top" width="20" style="padding:4px 8px 4px 0;color:' + V2_SUCCESS + ';font-weight:800;font-size:14.5px;">✓</td>' +
              '<td valign="top" style="padding:4px 0;font-size:14.5px;line-height:1.5;color:' + V2_INK + ';">' +
                safe(line) +
              '</td>' +
            '</tr>'
          );
        }).join("") +
      '</table>' +
    '</div>';

  // ---- 7. After photos ----
  // Heading is simply "After photos" — no "1 photo" callout that loudly
  // announces low counts.
  //
  // Caption logic — evidentiary, not decorative:
  //   • zone + time   → "Reception · 9:14 PM"
  //   • zone only     → "Reception"
  //   • time only     → "9:14 PM"
  //   • neither       → "After-photo"
  // Same caption for 1 or N photos; no "After-photo 1" enumeration
  // (the trailing index reads as marketing chrome on small counts).
  let photoSectionHtml = "";
  // Prefer the richer photoEntries shape when present (carries zone +
  // timestamp). Fall back to the URL-only photoUrls list for legacy
  // DCR data that didn't store per-photo metadata.
  const photoSource = (Array.isArray(n.photoEntries) && n.photoEntries.length)
    ? n.photoEntries
    : (n.photoUrls || []).map(function (u) { return { url: u, zone: "", timestamp: "" }; });
  if (photoSource.length) {
    const photos = photoSource.slice(0, 4);
    const cells = photos.map(function (entry, _i) {
      const url      = entry.url;
      const zone     = (entry.zone || "").trim();
      const timeText = formatPhotoCaptionTime(entry.timestamp);
      let caption    = "After-photo";
      if (zone && timeText) caption = zone + " · " + timeText;
      else if (zone)        caption = zone;
      else if (timeText)    caption = timeText;
      return (
        '<td valign="top" width="50%" style="padding:6px;">' +
          '<a href="' + safe(url) + '" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;">' +
            '<div style="border:1px solid ' + V2_CARD_BORDER + ';border-radius:10px;overflow:hidden;background:' + V2_SURFACE + ';box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
              '<img src="' + safe(url) + '" alt="Cleaning photo" ' +
                   'style="display:block;width:100%;max-width:280px;height:auto;border:0;" />' +
              '<div style="padding:6px 10px;font-size:11.5px;color:' + V2_MUTED + ';background:#FFFFFF;border-top:1px solid ' + V2_CARD_BORDER + ';">' +
                safe(caption) +
              '</div>' +
            '</div>' +
          '</a>' +
        '</td>'
      );
    });
    const rows = [];
    for (let i = 0; i < cells.length; i += 2) {
      const pair = cells.slice(i, i + 2).join("");
      const pad  = cells.slice(i, i + 2).length === 1 ? '<td width="50%" style="padding:6px;"></td>' : '';
      rows.push('<tr>' + pair + pad + '</tr>');
    }
    photoSectionHtml =
      '<div style="margin:0 4px 18px;">' +
        '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + V2_MUTED + ';margin-bottom:10px;">After photos</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
          rows.join("") +
        '</table>' +
      '</div>';
  }

  // ---- 8. Feedback CTAs ----
  // The feedback pages are static HTML at /feedback-compliment.html and
  // /feedback-issue.html. They read dcrId / customerId / techId from
  // the URL and POST to submitFeedbackV1, which writes Firestore +
  // emails the office. techId lets the server resolve the cleaning_techs
  // doc without re-querying by DCR.
  const complimentUrl =
    FEEDBACK_BASE + "/feedback-compliment.html?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId) +
    "&techId=" + encodeURIComponent(n.techSlug || "");
  const problemUrl =
    FEEDBACK_BASE + "/feedback-issue.html?dcrId=" + encodeURIComponent(n.dcrId) +
    "&customerId=" + encodeURIComponent(n.customerId) +
    "&techId=" + encodeURIComponent(n.techSlug || "");
  const complimentLabel = (content && content.complimentButtonText) ||
    (firstName ? ("Tell " + firstName + " they did a great job") : "Send a compliment");
  const problemLabel    = (content && content.problemButtonText) || "Something wasn’t quite right";
  const feedbackHtml =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;">' +
      '<tr>' +
        '<td style="padding:0 4px 10px;font-size:13px;color:' + V2_MUTED + ';text-align:center;">' +
          safe((content && content.feedbackPrompt) || "Quick feedback helps us keep your building dialed in.") +
        '</td>' +
      '</tr>' +
      '<tr>' +
        '<td>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
            '<tr>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(complimentUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_TEAL + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border-radius:999px;">' +
                  safe(complimentLabel) +
                '</a>' +
              '</td>' +
              '<td valign="top" width="50%" style="padding:4px;">' +
                '<a href="' + safe(problemUrl) + '" ' +
                   'style="display:block;text-align:center;padding:14px 16px;background:' + V2_CARD_BG + ';color:' + V2_INK + ';font-size:14px;font-weight:700;text-decoration:none;border:1px solid ' + V2_CARD_BORDER + ';border-radius:999px;">' +
                  safe(problemLabel) +
                '</a>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td>' +
      '</tr>' +
    '</table>';

  // ---- 9. Footer — warmer + bolder "View full report →" link ----
  // The link colour is the dark ink (not muted gray) and bolded so it
  // reads as an actual call to action, not chrome. Still underlined for
  // accessibility / link-recognition in older clients.
  const reportId = v3BuildReportId(n);
  const footerHtml =
    '<div style="margin-top:8px;padding:18px 4px 4px;text-align:center;border-top:1px solid ' + V2_CARD_BORDER + ';">' +
      '<div style="font-size:13.5px;color:' + V2_INK + ';font-weight:600;line-height:1.5;">' +
        'Thank you for your continued partnership.' +
      '</div>' +
      (reportId
        ? ('<div style="font-size:12px;color:' + V2_MUTED + ';margin-top:10px;">' +
             'Report ' + safe(reportId) +
             '<span style="display:inline-block;width:12px;"></span>' +
             '<a href="' + safe(n.reportUrl || FEEDBACK_BASE) + '" style="color:' + V2_INK + ';font-weight:700;text-decoration:underline;">View full report →</a>' +
           '</div>')
        : '') +
      '<div style="font-size:11px;color:' + V2_MUTED + ';margin-top:10px;">' +
        safe(PIONEER_BRAND_NAME) + ' &middot; ' +
        '<a href="mailto:info@pioneercomclean.com" style="color:' + V2_MUTED + ';text-decoration:underline;">info@pioneercomclean.com</a>' +
      '</div>' +
    '</div>';

  // ---- Final assembly ----
  // Mobile media query collapses the 3-cell tech row by forcing the
  // signature cell to display:block + left-align. Gmail / iOS Mail
  // respect <style> blocks for media-query class selectors so this
  // works in practice on small viewports.
  const preheader = safe((content && content.preheader) || "");
  return (
    '<!doctype html><html><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<meta name="x-apple-disable-message-reformatting"/>' +
      '<title>' + safe((content && content.subject) || "Cleaning report") + '</title>' +
      '<style>' +
        '@media only screen and (max-width: 480px) {' +
          '.dcr-outer    { padding: 10px 8px !important; }' +
          '.dcr-card     { padding: 14px !important; }' +
          '.v4-sig-cell  { display: block !important; text-align: left !important; ' +
                          'padding-left: 0 !important; padding-top: 12px !important; }' +
        '}' +
      '</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + V2_SURFACE + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:' + V2_SURFACE + ';">' +
        preheader + '&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;' +
      '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + V2_SURFACE + ';">' +
        '<tr>' +
          '<td class="dcr-outer" align="center" style="padding:22px 16px;">' +
            '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">' +
              '<tr><td>' + brandStripHtml + '</td></tr>' +
              '<tr><td>' + headerLineHtml + '</td></tr>' +
              '<tr><td>' + visitSummaryCardHtml + '</td></tr>' +
              '<tr><td>' + alertCardHtml + '</td></tr>' +
              '<tr><td>' + zoneSummaryHtml + '</td></tr>' +
              '<tr><td>' + photoSectionHtml + '</td></tr>' +
              '<tr><td>' + feedbackHtml + '</td></tr>' +
              '<tr><td>' + footerHtml + '</td></tr>' +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</body></html>'
  );
}

/* ----------------------------------------------------------------------------
 * sendGmailMessage
 *
 * Sends the HTML email via Gmail API using a service account with
 * domain-wide delegation impersonating the configured sender.
 *
 * Returns { id, threadId } from gmail.users.messages.send on success.
 * Throws with a readable message on failure (caller logs + records).
 * --------------------------------------------------------------------------- */
async function sendGmailMessage(opts) {
  const { to, subject, html, senderEmail, serviceAccountKey } = opts || {};
  if (!to)           throw new Error("sendGmailMessage: missing 'to'");
  if (!subject)      throw new Error("sendGmailMessage: missing 'subject'");
  if (!html)         throw new Error("sendGmailMessage: missing 'html'");
  if (!senderEmail)  throw new Error("sendGmailMessage: missing senderEmail (GMAIL_SENDER_EMAIL secret not set?)");
  if (!serviceAccountKey) throw new Error("sendGmailMessage: missing service account key (GMAIL_SERVICE_ACCOUNT_KEY secret not set?)");

  // Parse the JSON-encoded service account key. Stored as a string secret
  // so the function deploy + secrets workflow handles it cleanly.
  let creds;
  try {
    creds = (typeof serviceAccountKey === "string")
              ? JSON.parse(serviceAccountKey)
              : serviceAccountKey;
  } catch (e) {
    throw new Error("GMAIL_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message);
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service account key missing client_email or private_key");
  }

  // JWT auth client with domain-wide delegation. `subject` is the
  // Workspace user the service account is impersonating (the sender).
  const jwt = new google.auth.JWT({
    email:       creds.client_email,
    key:         creds.private_key,
    scopes:      ["https://www.googleapis.com/auth/gmail.send"],
    subject:     senderEmail
  });
  await jwt.authorize();

  const gmail = google.gmail({ version: "v1", auth: jwt });

  // Build an RFC-822 MIME message with the From header set to the
  // impersonated sender. Subject is encoded for non-ASCII safety.
  const fromHeader = '"' + PIONEER_BRAND_NAME + '" <' + senderEmail + '>';
  const subjectHeader = encodeMimeWordIfNeeded(subject);
  const mime =
    "From: " + fromHeader + "\r\n" +
    "To: " + to + "\r\n" +
    "Subject: " + subjectHeader + "\r\n" +
    "MIME-Version: 1.0\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    Buffer.from(html, "utf8").toString("base64");

  // The Gmail API expects the raw message as base64url (RFC 4648 §5).
  const raw = Buffer.from(mime, "utf8")
                .toString("base64")
                .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",   // 'me' resolves to the impersonated subject
    requestBody: { raw: raw }
  });

  return {
    id:       res && res.data && res.data.id || null,
    threadId: res && res.data && res.data.threadId || null
  };
}

/* ----------------------------------------------------------------------------
 * resolveCustomerDoc
 *
 * Robust customer lookup with explicit fallback tiers. Returns
 *   { snap, source, attempts }
 * on success, where `snap` is the matched Firestore DocumentSnapshot,
 * `source` is a short tag explaining which tier matched
 * ("direct_by_customerId", "where_customer_slug_eq_customerId",
 *  "where_slug_eq_customerId", "direct_by_dcr_customer_slug",
 *  "where_customer_slug_eq_dcr_customer_slug",
 *  "where_slug_eq_dcr_customer_slug"),
 * and `attempts` is the array of attempt-result objects we logged so
 * the diagnostic error response can reference them.
 *
 * Returns `{ snap: null, source: null, attempts }` when every tier
 * misses — the caller turns that into either a detailed error or, if
 * a testRecipientEmail was supplied, a best-effort send using
 * DCR-derived metadata.
 *
 * The order matches the spec:
 *   1. customers/{customerId} direct
 *   2. customers where customer_slug == customerId
 *   3. customers where slug == customerId
 *   4. repeat tiers 1-3 using dcr.customer_slug (when different)
 * --------------------------------------------------------------------------- */
async function resolveCustomerDoc(db, customerId, dcrCustomerSlug, logger) {
  const attempts = [];

  async function tryDirect(id, sourceTag) {
    if (!id) {
      attempts.push({ tag: sourceTag, key: id || "(empty)", found: false, reason: "empty key" });
      return null;
    }
    try {
      const snap = await db.collection("customers").doc(id).get();
      const found = snap.exists;
      attempts.push({ tag: sourceTag, key: id, found: found });
      return found ? snap : null;
    } catch (err) {
      attempts.push({ tag: sourceTag, key: id, found: false, reason: (err && err.code) || (err && err.message) || "error" });
      return null;
    }
  }

  async function tryQuery(field, value, sourceTag) {
    if (!value) {
      attempts.push({ tag: sourceTag, key: value || "(empty)", found: false, reason: "empty key" });
      return null;
    }
    try {
      const q = await db.collection("customers").where(field, "==", value).limit(1).get();
      const found = !q.empty;
      attempts.push({ tag: sourceTag, key: value, field: field, found: found });
      return found ? q.docs[0] : null;
    } catch (err) {
      attempts.push({ tag: sourceTag, key: value, field: field, found: false, reason: (err && err.code) || (err && err.message) || "error" });
      return null;
    }
  }

  // Tier 1.
  let snap = await tryDirect(customerId, "direct_by_customerId");
  if (snap) return { snap: snap, source: "direct_by_customerId", attempts: attempts };

  // Tier 2.
  snap = await tryQuery("customer_slug", customerId, "where_customer_slug_eq_customerId");
  if (snap) return { snap: snap, source: "where_customer_slug_eq_customerId", attempts: attempts };

  // Tier 3.
  snap = await tryQuery("slug", customerId, "where_slug_eq_customerId");
  if (snap) return { snap: snap, source: "where_slug_eq_customerId", attempts: attempts };

  // Tier 4 (only if dcr.customer_slug is different from customerId, no
  // point repeating the exact same three queries).
  if (dcrCustomerSlug && dcrCustomerSlug !== customerId) {
    snap = await tryDirect(dcrCustomerSlug, "direct_by_dcr_customer_slug");
    if (snap) return { snap: snap, source: "direct_by_dcr_customer_slug", attempts: attempts };

    snap = await tryQuery("customer_slug", dcrCustomerSlug, "where_customer_slug_eq_dcr_customer_slug");
    if (snap) return { snap: snap, source: "where_customer_slug_eq_dcr_customer_slug", attempts: attempts };

    snap = await tryQuery("slug", dcrCustomerSlug, "where_slug_eq_dcr_customer_slug");
    if (snap) return { snap: snap, source: "where_slug_eq_dcr_customer_slug", attempts: attempts };
  }

  // Nothing matched. Caller decides whether to fail or proceed with
  // DCR-derived metadata (best-effort path for testRecipientEmail).
  if (logger) {
    logger.warn("[dcr-email] customer not found in any tier", {
      requested_customerId: customerId,
      dcr_customer_slug:    dcrCustomerSlug || "(none)",
      attempts:             attempts
    });
  }
  return { snap: null, source: null, attempts: attempts };
}

/* ----------------------------------------------------------------------------
 * computeCleanerTrustSignals
 *
 * Operational trust layer added in v2.5. Reads prior dcr_submissions
 * for the same customer + cleaning-tech combo and derives:
 *
 *   cleanerVisitCount       — total visits this tech has completed at
 *                             this customer's location (current
 *                             included). Used for the tiered subtle
 *                             onboarding / continuity / longevity copy.
 *   cleanerVisitMessage     — pre-rendered string for the tech card
 *                             (server-derived; never AI).
 *   noConcernStreak         — consecutive recent visits (current
 *                             included) with no flagged issues + no
 *                             tech-reported problem.
 *   noConcernMessage        — pre-rendered streak string, only set
 *                             when streak >= 5 per the spec.
 *   resolvedFromPriorVisit  — scaffold only; null today. Phase-2
 *                             follow-up closure will populate this
 *                             when an issue from a prior DCR was
 *                             resolved on this visit.
 *
 * Query shape — equality-only on (customer_slug, tech_slug). No
 * orderBy is used so NO composite Firestore index is required to ship
 * this. We sort the result set client-side. Cap at 200 docs which is
 * plenty for a single tech at a single customer (≈4 years of nightly
 * cleans). If the hard cap is ever hit we still render an accurate
 * count, just truncated.
 *
 * Soft-fail: any error → trustSignals returns its default object and
 * the email still ships. The error is logged for triage.
 * --------------------------------------------------------------------------- */
async function computeCleanerTrustSignals(db, n, dcr, logger) {
  const out = {
    cleanerVisitCount:       null,
    cleanerVisitMessage:     "",
    noConcernStreak:         0,
    noConcernMessage:        "",
    resolvedFromPriorVisit:  null,   // TODO portal: populate on Phase-2 closure engine
    // Customer inspection score — V4 Phase 1. Populated from the
    // /inspections collection (customer-wide, not per-tech) when a
    // recent score exists. Null when no inspection has been logged
    // in the freshness window, so the V4 renderer's Inspection tile
    // simply skips rather than showing a stale value.
    inspectionScorePercent:  null,
    inspectionScoreDate:     null,
    queryError:              null
  };

  const customerSlug = String((dcr && dcr.customer_slug) || n.customerId || "").trim();
  const techSlug     = String((dcr && dcr.tech_slug) || "").trim();
  if (!customerSlug || !techSlug) {
    if (logger) logger.info("[dcr-email][v2] trust-signals skipped — missing slug", {
      customer_slug: customerSlug || "(none)",
      tech_slug:     techSlug     || "(none)"
    });
    return out;
  }

  try {
    const snap = await db.collection("dcr_submissions")
      .where("customer_slug", "==", customerSlug)
      .where("tech_slug",     "==", techSlug)
      .limit(200)
      .get();

    const docs = snap.docs.map(function (d) {
      const data = d.data() || {};
      return {
        id:           d.id,
        submitted_ms: trustTsMs(data.submission_meta && data.submission_meta.client_submitted_at) ||
                      trustTsMs(data.submitted_at) ||
                      trustTsMs(data.clean_date),
        had_concerns: visitHadConcerns(data)
      };
    });

    // Sort most-recent first (client-side; no Firestore orderBy used).
    docs.sort(function (a, b) { return b.submitted_ms - a.submitted_ms; });

    // Total visit count INCLUDES the current visit. The current DCR
    // doc is already written by submitDcrV1 before this email send
    // fires, so it should be in `docs` — but defensively +1 it if
    // somehow absent (manual test injection, eventual-consistency).
    let totalCount = docs.length;
    const currentInSnap = docs.some(function (d) { return d.id === n.dcrId; });
    if (!currentInSnap) totalCount += 1;
    out.cleanerVisitCount = totalCount;

    const firstName = (n.techName || "").trim().split(/\s+/)[0] || "Your tech";
    // Seasoned-default copy. We never say "getting familiar" unless this
    // is genuinely the tech's first visit at the customer — and even
    // then we phrase it as experienced-cleaning-tech, just new-to-site.
    if (totalCount <= 1) {
      out.cleanerVisitMessage = firstName + " is an experienced Pioneer cleaning tech, completing this visit at your location.";
    } else if (totalCount <= 5) {
      out.cleanerVisitMessage = firstName + " is part of the regular Pioneer team for your location.";
    } else if (totalCount < 25) {
      out.cleanerVisitMessage = firstName + " has completed " + totalCount + " visits at your location.";
    } else {
      out.cleanerVisitMessage = firstName + " is your regular Pioneer tech at this location.";
    }

    // No-concern streak: walk most-recent-first from the current
    // visit. Each consecutive clean visit adds 1; the run ends at the
    // first visit with a concern. Streak is only surfaced at >= 5.
    const currentHasConcerns = !!(n.issueItems && n.issueItems.length) || !!n.problem;
    let streak = 0;
    if (!currentHasConcerns) {
      streak = 1; // current visit itself counts
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        if (d.id === n.dcrId) continue;     // skip current visit doc
        if (d.had_concerns) break;
        streak += 1;
      }
    }
    out.noConcernStreak = streak;
    if (streak >= 5) {
      out.noConcernMessage = "No concerns have been logged during the last " + streak + " visits.";
    }

    if (logger) logger.info("[dcr-email][v2] trust-signals computed", {
      dcrId:              n.dcrId,
      customer_slug:      customerSlug,
      tech_slug:          techSlug,
      cleanerVisitCount:  out.cleanerVisitCount,
      noConcernStreak:    out.noConcernStreak,
      snapshot_count:     docs.length,
      current_in_snap:    currentInSnap
    });

    // ---- Customer inspection score (Phase 1 — V4 Inspection tile) ----
    // Independent query, equality-only on customer_slug so no composite
    // index is required. Pulls up to 20 recent inspections, picks the
    // newest with a numeric overall_score, and converts the 0–5 scale
    // to a 0–100 percentage. Anything older than 90 days is treated as
    // stale and skipped — better to show no tile than a misleading one.
    try {
      const inspSnap = await db.collection("inspections")
        .where("customer_slug", "==", customerSlug)
        .limit(20)
        .get();
      const inspDocs = inspSnap.docs
        .map(function (d) {
          const data = d.data() || {};
          return {
            score:       typeof data.overall_score === "number" ? data.overall_score : null,
            submittedMs: trustTsMs(data.inspection_submitted_at) ||
                         trustTsMs(data.submitted_at) ||
                         trustTsMs(data.inspection_date)
          };
        })
        .filter(function (x) { return x.score != null && x.submittedMs > 0; })
        .sort(function (a, b) { return b.submittedMs - a.submittedMs; });

      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const newest = inspDocs[0];
      if (newest && (now - newest.submittedMs) <= NINETY_DAYS_MS) {
        // 0–5 scale → 0–100, rounded to nearest integer.
        const pct = Math.round((newest.score / 5) * 100);
        // Cap at 100 in case anyone ever logs an over-scale value.
        out.inspectionScorePercent = Math.max(0, Math.min(100, pct));
        out.inspectionScoreDate    = new Date(newest.submittedMs).toISOString();
      }
    } catch (inspErr) {
      // Soft-fail. Trust signals still ship without the Inspection tile.
      if (logger) logger.warn("[dcr-email][v2] inspection-score query failed (soft)", {
        code:    inspErr && inspErr.code,
        message: inspErr && inspErr.message
      });
    }
  } catch (err) {
    out.queryError = String(err && err.message || err);
    if (logger) logger.warn("[dcr-email][v2] trust-signals query failed (soft)", {
      code:    err && err.code,
      message: err && err.message
    });
  }
  return out;
}

// Truthy when a DCR doc carries either a tech-reported problem flag
// or any checklist item with status="issue". Used for visit-streak
// computation. Defensive about field shape — older docs nested
// problem inside form_data; newer docs may also have a top-level field.
function visitHadConcerns(dcrData) {
  if (!dcrData) return false;
  const fd = dcrData.form_data || {};
  if (fd.has_problem === true || dcrData.has_problem === true) return true;
  const checklist = pickChecklistWithItems(dcrData.checklist, fd.checklist);
  for (let i = 0; i < checklist.length; i++) {
    const section = checklist[i];
    if (!section || !Array.isArray(section.items)) continue;
    for (let j = 0; j < section.items.length; j++) {
      const it = section.items[j];
      if (it && String(it.status || "").toLowerCase() === "issue") return true;
    }
  }
  return false;
}

// Tiny local timestamp normalizer for trust-signal queries. Returns
// 0 when shape is unrecognized so sort/compare behave predictably.
function trustTsMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
  if (ts.toMillis) return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

/* ----------------------------------------------------------------------------
 * recordEmailStatus
 *
 * Single Firestore writeback for the email lifecycle fields. Always
 * merge:true so we don't blow away anything else on the doc.
 * --------------------------------------------------------------------------- */
async function recordEmailStatus(db, dcrId, fields, admin) {
  if (!dcrId) return;
  const ref = db.collection("dcr_submissions").doc(dcrId);
  const payload = Object.assign({
    emailedAt: admin.firestore.FieldValue.serverTimestamp()
  }, fields || {});
  await ref.set(payload, { merge: true });
}

/* ----------------------------------------------------------------------------
 * Utility helpers
 * --------------------------------------------------------------------------- */
function htmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatHumanDate(yyyyMmDd) {
  if (!yyyyMmDd) return "";
  try {
    const d = new Date(yyyyMmDd + "T12:00:00");
    if (isNaN(d.getTime())) return String(yyyyMmDd);
    return d.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric"
    });
  } catch (_e) { return String(yyyyMmDd); }
}

// RFC 2047 encoded-word for the Subject header. Only kicks in when the
// subject contains non-ASCII so plain ASCII subjects stay readable in
// raw logs.
function encodeMimeWordIfNeeded(s) {
  const str = String(s || "");
  /* eslint-disable no-control-regex */
  if (!/[^\x00-\x7F]/.test(str)) return str;
  return "=?UTF-8?B?" + Buffer.from(str, "utf8").toString("base64") + "?=";
}

function buildSubject(n) {
  const date = formatHumanDate(n.cleaningDate);
  if (date) return "Cleaning report for " + n.customerName + " · " + date;
  return "Cleaning report for " + n.customerName;
}

/* ----------------------------------------------------------------------------
 * sendDcrEmailCore — shared core for the DCR email pipeline.
 *
 * Pure business logic. No HTTP, no auth — the caller decides how to
 * authenticate and how to respond. Used by two paths today:
 *   1. generateAndSendDcrEmailV1   (Cloud Function, admin-token gated)
 *   2. scripts/test-dcr-email-local.js (local dev QA, ADC-creds)
 *
 * Required:
 *   admin, db, logger            — already-initialised Firebase Admin
 *   dcrId, customerId            — IDs to resolve
 *   openaiApiKey                 — resolved string (NOT a defineSecret binding)
 *   gmailSenderEmail             — resolved string
 *   gmailServiceAccountKey       — resolved string OR parsed object
 *
 * Optional:
 *   testRecipientEmail           — when set, diverts the send + tags
 *                                   the payload doc as a test send
 *   subjectPrefix                — overrides the test-subject prefix
 *                                   (default "[TEST V5]"). Local script
 *                                   uses "[LOCAL TEST]".
 *
 * Returns one of:
 *   { ok: true, status: "sent",    subject, messageId, promptVersion,
 *     emailTemplate, to, summary, isTestSend, payloadDocId }
 *   { ok: true, status: "skipped", reason }
 *   { ok: false, code: "<bad_request|dcr_not_found|customer_not_found|
 *                       no_email|send_failed|unknown>",
 *     error, status?, diagnostics? }
 *
 * Throws only for unexpected runtime errors. "Expected" outcomes
 * (missing DCR, missing customer, etc.) come back as structured
 * { ok: false, code } so callers can map cleanly to HTTP codes or
 * console output.
 * --------------------------------------------------------------------------- */
async function sendDcrEmailCore(opts) {
  const {
    admin, db, logger,
    dcrId, customerId,
    openaiApiKey,
    gmailSenderEmail,
    gmailServiceAccountKey,
    // V6 — optional office-alert recipient strings. When set + DCR
    // is tier=red, an alert email goes to these addresses in addition
    // to the customer send. Silently skipped when unset.
    kirbyAlertEmail,
    aprilAlertEmail
  } = opts;
  const subjectPrefix = String(opts.subjectPrefix || "[TEST V6]");

  // ---- Validate inputs ----
  if (!dcrId || !customerId) {
    return { ok: false, code: "bad_request", error: "dcrId and customerId are required" };
  }
  const rawTestRecipient = String(opts.testRecipientEmail || "").trim();
  const testRecipientEmail = rawTestRecipient && isEmailShaped(rawTestRecipient)
                              ? rawTestRecipient.toLowerCase()
                              : "";
  if (rawTestRecipient && !testRecipientEmail) {
    return { ok: false, code: "bad_request", error: "testRecipientEmail is not a valid email" };
  }

  // ---- 1. Read DCR (always required) ----
  const dcrSnap = await db.collection("dcr_submissions").doc(dcrId).get();
  if (!dcrSnap.exists) {
    return { ok: false, code: "dcr_not_found", error: "DCR not found", dcrId: dcrId };
  }
  const dcr = Object.assign({ id: dcrSnap.id }, dcrSnap.data());
  const dcrCustomerSlug = String(dcr.customer_slug || "").trim();
  const dcrCustomerName = String(dcr.customer_name || dcr.customerName || "").trim();

  // ---- 2. Resolve the customer doc via the 4-tier fallback ----
  // Direct → query customer_slug → query slug → repeat with the
  // DCR's own customer_slug. Each attempt is tracked so the
  // diagnostic error response can show exactly what we tried.
  const resolved = await resolveCustomerDoc(db, customerId, dcrCustomerSlug, logger);
  const customerSnap = resolved.snap;

  // Structured resolution log — shows up in Cloud Functions logs
  // alongside the requested IDs, the matched doc id (when any),
  // and the matched email/display name. Makes future support
  // tickets a single grep instead of a wild-goose chase.
  logger.info("[dcr-email] customer resolution", {
    dcrId:                dcrId,
    requested_customerId: customerId,
    dcr_customer_slug:    dcrCustomerSlug || "(none)",
    dcr_customer_name:    dcrCustomerName || "(none)",
    resolved_doc_id:      (customerSnap && customerSnap.id) || null,
    resolved_source:      resolved.source || null,
    attempts:             resolved.attempts
  });

      // Decide whether to proceed.
      //   • Found      → use customer doc as the metadata source.
      //   • Not found  → either fail (production path) OR proceed with
      //                  DCR-derived metadata when a testRecipientEmail
      //                  was supplied. This matches the spec:
  //                  "testRecipientEmail overrides customer email
  //                   for test sends, but customer metadata is still
  //                   loaded if possible."
  let customer;
  if (customerSnap) {
    customer = Object.assign({ id: customerSnap.id }, customerSnap.data());
    logger.info("[dcr-email] customer matched", {
      dcrId:                  dcrId,
      resolved_doc_id:        customerSnap.id,
      resolved_source:        resolved.source,
      resolved_customer_email: customer.customer_email || null,
      resolved_customer_name:  customer.customer_name  || null
    });
  } else if (testRecipientEmail) {
    // Best-effort: synthesize a stub customer from the DCR doc.
    // This lets QA proceed for a DCR whose customer slug doesn't
    // yet have its own /customers doc (early data, typo, etc.).
    customer = {
      id:                  customerId,
      customer_slug:       dcrCustomerSlug || customerId,
      customer_name:       dcrCustomerName || "Valued customer",
      customer_email:      "",                 // forced via testRecipientEmail
      dcr_email_enabled:   true                // test sends always proceed
    };
    logger.warn("[dcr-email] customer not found — proceeding with DCR-derived stub for test send", {
      dcrId:                dcrId,
      requested_customerId: customerId,
      dcr_customer_slug:    dcrCustomerSlug || "(none)",
      dcr_customer_name:    dcrCustomerName || "(none)",
      testRecipientEmail:   testRecipientEmail
    });
  } else {
    // Detailed-error production path. Includes every diagnostic
    // the caller needs to reconcile the data state.
    return {
      ok: false,
      code: "customer_not_found",
      error: "Customer not found",
      diagnostics: {
        requested_customerId: customerId,
        dcr_customer_slug:    dcrCustomerSlug || null,
        dcr_customer_name:    dcrCustomerName || null,
        attempted_lookups:    resolved.attempts,
        hint:                 "Add a customers/<slug> doc, OR pass testRecipientEmail to bypass for QA."
      }
    };
  }

  let tech = null;
  let techResolvedVia = "none";
  const techSlug = dcr.tech_slug || (dcr.form_data && dcr.form_data.tech) || "";
  if (techSlug) {
    const techSnap = await db.collection("cleaning_techs").doc(techSlug).get();
    if (techSnap.exists) {
      tech = Object.assign({ id: techSnap.id }, techSnap.data());
      techResolvedVia = "tech_slug";
    }
  }
  // V5 — fallback lookup by display name. Triggered when the DCR
  // carries a tech_display_name but the slug-based lookup missed
  // (older imports, manual data, typo'd slug). Equality-only query
  // on a small collection — no index required, no orderBy. Best
  // match wins; ambiguous duplicates fall through to "no tech".
  if (!tech) {
    const dcrTechName = String(
      dcr.tech_display_name || dcr.techDisplayName ||
      (dcr.form_data && (dcr.form_data.tech_display_name || dcr.form_data.techDisplayName)) ||
      ""
    ).trim();
    if (dcrTechName) {
      const targets = [dcrTechName, dcrTechName.toLowerCase()];
      const nameFields = ["display_name", "displayName", "name", "fullName", "full_name", "firstName", "first_name", "slug"];
      for (let i = 0; !tech && i < nameFields.length; i++) {
        for (let j = 0; !tech && j < targets.length; j++) {
          try {
            const q = await db.collection("cleaning_techs")
              .where(nameFields[i], "==", targets[j])
              .limit(2)
              .get();
            if (!q.empty && q.size === 1) {
              const d = q.docs[0];
              tech = Object.assign({ id: d.id }, d.data());
              techResolvedVia = "name_lookup:" + nameFields[i];
            }
          } catch (_e) { /* tolerated — try next field */ }
        }
      }
      logger.info("[dcr-email][v5] tech name-fallback lookup", {
        dcrId: dcrId, tech_slug: techSlug || "(none)",
        dcr_tech_name: dcrTechName,
        resolved_via: techResolvedVia,
        matched_tech_id: tech ? tech.id : null
      });
    }
  }

  // ---- 3. Normalize ----
  const n = normalizeDcrForEmail(dcr, customer, tech);
  logger.info("[dcr-email][v2] visual-asset audit", Object.assign({
    dcrId:        dcrId,
    techSlug:     techSlug || null,
    completedItems_count: (n.completedItems || []).length,
    issueItems_count:     (n.issueItems     || []).length
  }, n._pickedFromV2 || {}));

  // ---- 3b. Operational trust signals (v2.5) ----
  n.trustSignals = await computeCleanerTrustSignals(db, n, dcr, logger);

  // Decide the actual destination address(es). Priority:
  //   1. testRecipientEmail (override — diverts the send for QA;
  //      always a single recipient).
  //   2. customer.dcrEmailRecipients[] (V6 canonical multi-recipient).
  //   3. customer.customer_email / primaryEmail (legacy singular).
  const isTestSend       = !!testRecipientEmail;
  const recipientEmails  = isTestSend
    ? [testRecipientEmail]
    : (n.customerEmailRecipients && n.customerEmailRecipients.length
        ? n.customerEmailRecipients
        : (n.customerEmail ? [n.customerEmail] : []));
  // Comma-joined `To:` for Gmail; also keep the array form for the
  // payload doc so the audit reflects the actual list.
  const recipientEmail = recipientEmails.join(", ");

  if (!isTestSend && !n.customerEmailEnabled) {
    await recordEmailStatus(db, dcrId, {
      emailStatus:     "skipped",
      emailTo:         recipientEmail,
      emailSubject:    "",
      generatedSummary: "",
      htmlPreview:     "",
      emailError:      "customer.dcrEmailEnabled === false"
    }, admin);
    return { ok: true, status: "skipped", reason: "customer email disabled" };
  }
  if (recipientEmails.length === 0) {
    await recordEmailStatus(db, dcrId, {
      emailStatus:     "failed",
      emailTo:         "",
      emailSubject:    "",
      generatedSummary: "",
      htmlPreview:     "",
      emailError:      "customer has no email recipient on file (and no testRecipientEmail provided)"
    }, admin);
    return {
      ok: false, code: "no_email",
      error: "customer has no email recipient on file (and no testRecipientEmail provided)"
    };
  }

  // ---- 3c. Tokenized customer report URL + tech tenure label ----
  // Mint a fresh per-send token so the email's "View full report" link
  // lands on /dcr-report.html?t=<token>. Hash stored in dcr_report_tokens;
  // raw token only appears in the email link. Failure is non-fatal —
  // the email still sends, the link just falls back to the brand homepage.
  try {
    const minted = await dcrReport.mintReportToken({
      admin: admin, db: db, dcrId: dcrId,
      customerId: customerId, emailTo: recipientEmail || null
    });
    n.reportUrl       = minted.reportUrl;
    n.reportTokenHash = minted.tokenHash;
  } catch (mintErr) {
    logger.warn("[dcr-email] report token mint failed (non-fatal)", {
      dcrId: dcrId, error: mintErr && mintErr.message
    });
    n.reportUrl = FEEDBACK_BASE;
  }
  // Tenure phrasing (count + earliest date by tech+customer).
  try {
    n.techTenureLabel = await dcrReport.buildTechTenureLabel({
      db: db,
      techSlug:     n.techSlug || dcr.tech_slug,
      customerSlug: n.customerId || dcr.customer_slug,
      techName:     n.techName  || dcr.tech_display_name,
      currentDcrId: dcrId
    });
  } catch (_e) {
    n.techTenureLabel = "Experienced Pioneer cleaning tech.";
  }

  // ---- 4. Generate structured content JSON (V2). ----
  const content = await generateDcrEmailContentJsonV2(n, openaiApiKey, logger);
  const aiSummary = content.openingSummary || "";

  // ---- 5. Build HTML email + subject ----
  // Test subject convention: "<subjectPrefix> <baseSubject> · <HH:MM AM/PM>".
  // The trailing local time guarantees each test send produces a
  // unique subject string so Gmail does NOT thread them.
  const html        = renderDcrEmailHtmlV4(n, content);
  const baseSubject = content.subject || buildSubject(n);
  let subject;
  if (isTestSend) {
    let nowStamp = "";
    try {
      nowStamp = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour:     "numeric",
        minute:   "2-digit",
        hour12:   true
      }).format(new Date());
    } catch (_e) { nowStamp = String(Date.now()); }
    subject = subjectPrefix + " " + baseSubject + " · " + nowStamp;
  } else {
    subject = baseSubject;
  }

  const tileResult = (function () {
    try { return v4BuildTrustStripTiles(n, content); }
    catch (_e) { return { tiles: [], metricsUsed: [], metricFallbacksUsed: [] }; }
  })();
  const metricsUsed         = tileResult.metricsUsed         || [];
  const metricFallbacksUsed = tileResult.metricFallbacksUsed || [];

  // ---- 6. Persist the full payload to dcr_email_payloads BEFORE the
  //         Gmail send. Doing it pre-send means we have an auditable
  //         record even if the API call throws. sentAt is added on
  //         success in the merge below. ----
  const serverBulletResult = v5BuildCompletedBulletsFromChecklist(n);
  let checklistSourceUsed = "fallback";
  let completedBulletsUsed = 0;
  let completedSectionsUsed = [];
  if (serverBulletResult.bullets.length > 0) {
    checklistSourceUsed   = "server_derived";
    completedBulletsUsed  = serverBulletResult.bullets.length;
    completedSectionsUsed = serverBulletResult.sectionsUsed;
  } else if (Array.isArray(content.serviceHighlights) && content.serviceHighlights.length > 0) {
    checklistSourceUsed = "ai_serviceHighlights";
    completedBulletsUsed = content.serviceHighlights.reduce(function (acc, h) {
      return acc + (Array.isArray(h.bullets) ? h.bullets.length : 0);
    }, 0);
    completedSectionsUsed = content.serviceHighlights
      .map(function (h) { return String((h && h.sectionName) || "").trim(); })
      .filter(function (s) { return s.length > 0; });
  }
  const completedSectionCount = completedSectionsUsed.length;

  await db.collection("dcr_email_payloads").doc(dcrId).set({
    html:                 html,
    htmlPreview:          html.slice(0, 1000),
    subject:              subject,
    to:                   recipientEmail,
    toList:               recipientEmails,
    summary:              aiSummary,
    generatedSummary:     aiSummary,
    generatedContent:     content,
    emailTemplate:        "v5",
    promptVersion:        PROMPT_VERSION_V2,
    model:                OPENAI_MODEL_V2,
    customerId:           customerId,
    customerName:         n.customerName,
    techName:             n.techName,
    cleaningDate:         n.cleaningDate,
    // ---- Debug fields ----
    resolvedTechPhotoUrl:   n.techPhotoUrl  || "",
    resolvedSignatureUrl:   n.signatureUrl  || "",
    photoUrlCount:          (n.photoUrls && n.photoUrls.length) || 0,
    completedSectionCount:  completedSectionCount,
    completedBulletsUsed:   completedBulletsUsed,
    completedSectionsUsed:  completedSectionsUsed,
    taskDoneCount:          Number(n.taskDoneCount  || 0),
    taskTotalCount:         Number(n.taskTotalCount || 0),
    metricsUsed:            metricsUsed,
    metricFallbacksUsed:    metricFallbacksUsed,
    techPhotoLookupSource:  n.techPhotoLookupSource || null,
    techResolvedVia:        techResolvedVia,
    signatureLookupSource:  n.signatureLookupSource || null,
    onSiteDurationMs:       n.onSiteDurationMs || null,
    inspectionScorePercent: (n.trustSignals && n.trustSignals.inspectionScorePercent) || null,
    inspectionScoreDate:    (n.trustSignals && n.trustSignals.inspectionScoreDate)    || null,
    photoEntriesWithZone:   (n._pickedFromV2 && n._pickedFromV2.photoEntries_with_zone) || 0,
    checklistSourceUsed:    checklistSourceUsed,
    nextCleanResolved:      !!n.nextCleanAtMs,
    nextCleanAtMs:          n.nextCleanAtMs || null,
    cleanerVisitCount:      (n.trustSignals && n.trustSignals.cleanerVisitCount) || null,
    noConcernVisitStreak:   (n.trustSignals && n.trustSignals.noConcernStreak)   || 0,
    resolvedIssueCount:     0,
    usedFallbackTechPhoto:  !n.techPhotoUrl,
    usedFallbackSignature:  !n.signatureUrl,
    trustSignalsQueryError: (n.trustSignals && n.trustSignals.queryError) || null,
    isTestSend:             isTestSend,
    createdAt:              admin.firestore.FieldValue.serverTimestamp()
  }, { merge: false });

  // ---- 7. Send via Gmail API ----
  let sendResult  = null;
  let emailStatus = "sent";
  let errorText   = null;
  try {
    sendResult = await sendGmailMessage({
      to:                 recipientEmail,
      subject:            subject,
      html:               html,
      senderEmail:        gmailSenderEmail,
      serviceAccountKey:  gmailServiceAccountKey
    });
    await db.collection("dcr_email_payloads").doc(dcrId).set({
      sentAt:         admin.firestore.FieldValue.serverTimestamp(),
      gmailMessageId: sendResult && sendResult.id || null
    }, { merge: true });
  } catch (sendErr) {
    emailStatus = "failed";
    errorText   = String(sendErr && sendErr.message || sendErr);
    logger.error("[dcr-email] Gmail send failed", { dcrId, error: errorText });
  }

  // ---- 8. Firestore writeback on the DCR doc itself ----
  await recordEmailStatus(db, dcrId, {
    emailStatus:      emailStatus,
    emailTo:          recipientEmail,
    emailSubject:     subject,
    generatedSummary: aiSummary,
    htmlPreview:      html.slice(0, 1000),
    gmailMessageId:   sendResult && sendResult.id || null,
    emailError:       errorText,
    emailIsTestSend:  isTestSend
  }, admin);

  // ---- 9. V6 issue-tier routing: notifications + (red) office alert ----
  // Soft-fail — these side effects never block the customer-send
  // success path. Test sends still fire notifications so QA can see
  // the routing produces the right records.
  const routing = n.issueRouting || { tier: "green" };
  if (routing.tier === "yellow" || routing.tier === "red") {
    try {
      await db.collection("notifications").add({
        type:             "dcr_issue_" + routing.tier,
        priority:         routing.tier === "red" ? "high" : "medium",
        audience:         routing.tier === "red"
          ? ["office_manager", "manager"]
          : ["office_manager"],
        assignedRoles:    routing.tier === "red"
          ? ["office_manager", "manager"]
          : ["office_manager"],
        assignedUsers:    routing.tier === "red" ? ["kirby", "april"] : ["kirby"],
        title:            routing.tier === "red"
          ? "DCR red issue — Pioneer manager follow-up needed"
          : "DCR yellow note — customer informed",
        message:          (routing.shortSummary
          || "DCR " + dcrId + " was flagged " + routing.tier +
             (n.customerName ? (" for " + n.customerName) : "")) +
          (routing.problemCategory ? " (category: " + routing.problemCategory + ")" : ""),
        severity:         routing.tier === "red" ? "high" : "medium",
        requiresAction:   routing.tier === "red",
        celebration:      false,
        read:             false,
        linkedCollection: "dcr_submissions",
        linkedDocId:      dcrId,
        customerId:       n.customerId || null,
        customerName:     n.customerName || null,
        techId:           n.techSlug || null,
        techName:         n.techName || null,
        issueTier:        routing.tier,
        problemCategory:  routing.problemCategory || null,
        causedByTeam:     !!routing.causedByTeam,
        customerVisible:  !!routing.customerVisible,
        customerAlertMessageSent: routing.tier === "red"
          ? "A Pioneer manager will follow up directly regarding an issue from tonight's visit."
          : (routing.customerAlertMessage || null),
        internalNotes:    routing.internalNotes || null,
        isTestSend:       isTestSend,
        createdAt:        admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      logger.warn("[dcr-email] issue-tier notification write failed (non-fatal)", {
        dcrId: dcrId, tier: routing.tier, error: e.message
      });
    }

    // Red-only: Gmail alert to Kirby + April. Reuses the customer-send
    // Gmail credentials (already authorised for the sender Workspace
    // user) and the KIRBY_ALERT_EMAIL / APRIL_ALERT_EMAIL secret
    // values resolved by the caller. Silently skipped when either
    // secret is unset.
    if (routing.tier === "red") {
      const alertTo = [];
      if (kirbyAlertEmail) alertTo.push(kirbyAlertEmail);
      if (aprilAlertEmail) alertTo.push(aprilAlertEmail);
      if (alertTo.length) {
        try {
          const safe = htmlEscape;
          const alertHtml =
            '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F1F24;margin:0;padding:0;">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF3F3;">' +
            '<tr><td align="center" style="padding:24px 16px;">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #E6E9EE;border-left:4px solid #E36D6D;border-radius:12px;">' +
            '<tr><td style="padding:24px;">' +
            '<div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;color:#8A2A2A;margin-bottom:8px;">Pioneer Alert · DCR red tier</div>' +
            '<h1 style="margin:0 0 4px;font-size:20px;font-weight:800;">' +
              safe(n.customerName || "Unspecified location") +
            '</h1>' +
            '<div style="font-size:13px;color:#475569;margin-bottom:16px;">' +
              safe(n.techName ? ("Tech on record: " + n.techName) : "Tech: unknown") +
              '  ·  DCR: ' + safe(dcrId) +
            '</div>' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F7FA;border-radius:8px;margin-bottom:16px;"><tr><td style="padding:12px 14px;font-size:13px;">' +
              (routing.problemCategory ? ('<div><strong>Category:</strong> ' + safe(routing.problemCategory) + '</div>') : '') +
              '<div><strong>Caused by team:</strong> ' + (routing.causedByTeam ? "YES" : "no") + '</div>' +
              '<div><strong>Customer visible:</strong> ' + (routing.customerVisible ? "YES" : "no") + '</div>' +
              (routing.shortSummary ? ('<div><strong>Summary:</strong> ' + safe(routing.shortSummary) + '</div>') : '') +
            '</td></tr></table>' +
            (routing.internalNotes
              ? ('<p style="margin:0 0 4px;font-weight:700;">Internal notes:</p>' +
                 '<p style="margin:0 0 16px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;">' +
                 safe(routing.internalNotes) + '</p>')
              : '') +
            '<p style="margin:0 0 4px;font-weight:700;">What the customer email said:</p>' +
            '<p style="margin:0 0 16px;font-size:14.5px;line-height:1.55;font-style:italic;">' +
              '"A Pioneer manager will follow up directly regarding an issue from tonight\'s visit."' +
            '</p>' +
            '<hr style="border:none;border-top:1px solid #E6E9EE;margin:20px 0;" />' +
            '<div style="font-size:12px;color:#475569;">DCR ID: ' + safe(dcrId) + '</div>' +
            '</td></tr></table>' +
            '</td></tr></table></body></html>';
          await sendGmailMessage({
            to:                alertTo.join(", "),
            subject:           "[Pioneer Alert] DCR red issue — " + (n.customerName || "unknown"),
            html:              alertHtml,
            senderEmail:       gmailSenderEmail,
            serviceAccountKey: gmailServiceAccountKey
          });
        } catch (e) {
          logger.warn("[dcr-email] red-tier office alert failed (non-fatal)", {
            dcrId: dcrId, error: e.message
          });
        }
      } else {
        logger.warn("[dcr-email] red tier with no KIRBY_ALERT_EMAIL/APRIL_ALERT_EMAIL configured", { dcrId: dcrId });
      }
    }
  }

  if (emailStatus === "failed") {
    return {
      ok:            false,
      code:          "send_failed",
      status:        "failed",
      error:         errorText,
      subject:       subject,
      to:            recipientEmail,
      promptVersion: PROMPT_VERSION_V2,
      emailTemplate: "v6"
    };
  }
  return {
    ok:            true,
    status:        emailStatus,
    to:            recipientEmail,
    subject:       subject,
    messageId:     sendResult && sendResult.id || null,
    summary:       aiSummary,
    isTestSend:    isTestSend,
    promptVersion: PROMPT_VERSION_V2,
    emailTemplate: "v6",
    payloadDocId:  dcrId
  };
}

/* ----------------------------------------------------------------------------
 * getDcrEmailReadiness — pre-send readiness check for the admin Review UI.
 *
 * Walks every signal the email render + send pipeline needs and reports
 * which are present, missing, or weak. Used by:
 *   • Admin Review modal → renders blockers/warnings + enables Send
 *   • generateAndSendDcrEmailV1 HTTP handler → refuses to send when
 *     blockers exist (downgrades "already_sent" to non-blocking when
 *     the caller passes confirmResend: true).
 *
 * Pure read — never writes to Firestore. Reuses the same lookup
 * helpers the send path uses (resolveCustomerDoc, normalizeDcrForEmail,
 * the signature/photo coalesce lists) so the readiness picture matches
 * what the email will actually render — no drift.
 *
 * Returns:
 *   {
 *     ready:    boolean,
 *     blockers: [{ code, message }],
 *     warnings: [{ code, message }],
 *     resolved: {
 *       customerId, customerName, emailRecipients[], emailEnabled,
 *       techId, techName, hasTechPhoto, hasSignature, photoCount,
 *       issueTier, emailStatus  ("never" | "sent" | "failed")
 *     }
 *   }
 *
 * Mode:
 *   "send"   — default. `already_sent` is a blocker.
 *   "resend" — `already_sent` is a warning, not a blocker.
 * --------------------------------------------------------------------------- */
async function getDcrEmailReadiness(opts) {
  const { db, logger } = opts;
  const dcrId = String(opts.dcrId || "").trim();
  const mode  = opts.mode === "resend" ? "resend" : "send";

  const blockers = [];
  const warnings = [];
  const resolved = {
    customerId:      null,
    customerName:    null,
    emailRecipients: [],
    emailEnabled:    true,
    techId:          null,
    techName:        null,
    hasTechPhoto:    false,
    hasSignature:    false,
    photoCount:      0,
    issueTier:       "green",
    emailStatus:     "never"
  };

  if (!dcrId) {
    return {
      ready: false,
      blockers: [{ code: "missing_dcr_id", message: "dcrId is required" }],
      warnings: [], resolved: resolved
    };
  }

  const dcrSnap = await db.collection("dcr_submissions").doc(dcrId).get();
  if (!dcrSnap.exists) {
    return {
      ready: false,
      blockers: [{ code: "dcr_not_found", message: "DCR not found: " + dcrId }],
      warnings: [], resolved: resolved
    };
  }
  const dcr = Object.assign({ id: dcrSnap.id }, dcrSnap.data());

  // ---- Customer resolution (mirrors the send path) ----
  const dcrCustomerSlug = String(dcr.customer_slug || "").trim();
  const customerIdGuess = dcrCustomerSlug || String(dcr.customer_id || dcr.customerId || "").trim();
  resolved.customerId = customerIdGuess || null;

  let customer = null;
  if (customerIdGuess) {
    const cusRes = await resolveCustomerDoc(db, customerIdGuess, dcrCustomerSlug, logger);
    if (cusRes.snap) customer = Object.assign({ id: cusRes.snap.id }, cusRes.snap.data());
  }
  if (!customer) {
    blockers.push({
      code:    "customer_not_found",
      message: "Customer doc not in Firestore for slug \"" + customerIdGuess + "\""
    });
  }

  // ---- Tech resolution (mirrors the send path — slug then name fallback) ----
  const techSlug = String(dcr.tech_slug || (dcr.form_data && dcr.form_data.tech) || "").trim();
  let tech = null;
  let techResolvedVia = "none";
  if (techSlug) {
    const techSnap = await db.collection("cleaning_techs").doc(techSlug).get();
    if (techSnap.exists) {
      tech = Object.assign({ id: techSnap.id }, techSnap.data());
      techResolvedVia = "tech_slug";
    }
  }
  if (!tech) {
    const dcrTechName = String(
      dcr.tech_display_name || dcr.techDisplayName ||
      (dcr.form_data && (dcr.form_data.tech_display_name || dcr.form_data.techDisplayName)) || ""
    ).trim();
    if (dcrTechName) {
      const nameFields = ["display_name", "displayName", "name", "fullName", "full_name", "firstName", "first_name", "slug"];
      const targets = [dcrTechName, dcrTechName.toLowerCase()];
      outer: for (let i = 0; i < nameFields.length; i++) {
        for (let j = 0; j < targets.length; j++) {
          try {
            const q = await db.collection("cleaning_techs")
              .where(nameFields[i], "==", targets[j])
              .limit(2).get();
            if (!q.empty && q.size === 1) {
              const d = q.docs[0];
              tech = Object.assign({ id: d.id }, d.data());
              techResolvedVia = "name_lookup:" + nameFields[i];
              break outer;
            }
          } catch (_e) { /* tolerated */ }
        }
      }
    }
  }
  if (tech) {
    resolved.techId   = tech.id || tech.tech_slug || techSlug;
    resolved.techName = tech.display_name || tech.displayName || tech.name || resolved.techId;
  } else {
    resolved.techId   = techSlug || null;
    resolved.techName = String(dcr.tech_display_name || dcr.techDisplayName || "").trim() || null;
    blockers.push({
      code:    "tech_not_found",
      message: techSlug
        ? ("Tech " + techSlug + " not in cleaning_techs collection")
        : "DCR has no tech_slug or matchable tech_display_name"
    });
  }

  // ---- Normalize — reuses every lookup the send path runs ----
  // When customer resolution missed, normalize with a stub so we can
  // still inspect the DCR-level signals (signature, photos, checklist).
  const stubCustomer = customer || {
    id:                dcrCustomerSlug || customerIdGuess,
    customer_slug:     dcrCustomerSlug,
    customer_name:     String(dcr.customer_name || dcr.customerName || "").trim() || "Valued customer",
    dcr_email_enabled: true,
    customer_email:    ""
  };
  const n = normalizeDcrForEmail(dcr, stubCustomer, tech);

  resolved.customerName    = (customer && customerDisplay.getCustomerDisplayName(customer)) || n.customerName;
  resolved.emailRecipients = n.customerEmailRecipients || [];
  resolved.emailEnabled    = !!n.customerEmailEnabled;
  resolved.hasTechPhoto    = !!n.techPhotoUrl;
  resolved.hasSignature    = !!n.signatureUrl;
  resolved.photoCount      = (n.photoUrls && n.photoUrls.length) || 0;
  resolved.issueTier       = (n.issueRouting && n.issueRouting.tier) || "green";
  resolved.signatureLookupSource = n.signatureLookupSource || null;
  resolved.techPhotoLookupSource = n.techPhotoLookupSource || null;
  resolved.techResolvedVia       = techResolvedVia;

  // ---- Recipient + opt-out blockers ----
  if (customer && !resolved.emailEnabled) {
    blockers.push({
      code:    "dcr_email_disabled",
      message: "customer.dcrEmailEnabled is false (customer has opted out of DCR emails)"
    });
  }
  if (customer && resolved.emailEnabled && resolved.emailRecipients.length === 0) {
    blockers.push({
      code:    "no_recipient",
      message: "Customer has no dcrEmailRecipients[] or primaryEmail set"
    });
  }

  // ---- Signature blocker ----
  if (!resolved.hasSignature) {
    blockers.push({
      code:    "no_signature",
      message: "DCR has no signature URL (tech did not sign off, or the URL didn't write to Firestore)"
    });
  }

  // ---- Checklist blocker ----
  const checklist = pickChecklistWithItems(
    dcr.checklist,
    dcr.form_data && dcr.form_data.checklist
  );
  const hasChecklist = checklist.some(function (s) {
    return s && Array.isArray(s.items) && s.items.length > 0;
  });
  if (!hasChecklist) {
    blockers.push({
      code:    "no_checklist",
      message: "DCR has no checklist / service scope items"
    });
  }

  // ---- Issue tier validation ----
  // The tier value itself is always one of green|yellow|red (the
  // derivation guarantees it). What we surface here is the OPERATIONAL
  // implication: red requires manager review.
  if (resolved.issueTier === "red") {
    warnings.push({
      code:    "red_requires_review",
      message: "issueTier=red — Pioneer manager will follow up. Confirm the customer-facing wording is appropriate before sending."
    });
  }

  // ---- Soft warnings (photo/signature falls) ----
  if (!resolved.hasTechPhoto) {
    warnings.push({
      code:    "no_tech_photo",
      message: "Tech \"" + (resolved.techName || "(unknown)") + "\" has no profile photo — the email will fall back to an initials bubble."
    });
  }
  if (resolved.photoCount === 0) {
    warnings.push({
      code:    "no_photos",
      message: "DCR has no after-photos. The customer email will skip the photo section."
    });
  }
  if (resolved.techResolvedVia && resolved.techResolvedVia.indexOf("name_lookup") === 0) {
    warnings.push({
      code:    "tech_resolved_by_name",
      message: "Tech was resolved by name fallback (" + resolved.techResolvedVia + "), not by tech_slug. The DCR's tech_slug may be stale."
    });
  }

  // ---- Already-sent check ----
  const payloadSnap = await db.collection("dcr_email_payloads").doc(dcrId).get();
  if (payloadSnap.exists) {
    const p = payloadSnap.data() || {};
    if (p.sentAt) {
      resolved.emailStatus      = "sent";
      resolved.lastSentAt       = p.sentAt && p.sentAt.toDate ? p.sentAt.toDate().toISOString() : null;
      resolved.lastSentTo       = p.to || (Array.isArray(p.toList) ? p.toList.join(", ") : null);
      resolved.lastSentMessageId = p.gmailMessageId || null;
      if (mode === "send") {
        blockers.push({
          code:    "already_sent",
          message: "DCR email already sent at " + (resolved.lastSentAt || "(unknown time)") +
                   ". Pass confirmResend: true (or click Resend) to send again."
        });
      } else {
        warnings.push({
          code:    "already_sent",
          message: "This is a resend. The original was sent at " + (resolved.lastSentAt || "(unknown time)") + "."
        });
      }
    } else {
      resolved.emailStatus = "failed";
      resolved.lastEmailError = p.emailError || null;
    }
  }

  return {
    ready:    blockers.length === 0,
    blockers: blockers,
    warnings: warnings,
    resolved: resolved
  };
}

/* ----------------------------------------------------------------------------
 * sendNativeDcrEmailForSubmission — Phase 32 cutover entrypoint.
 *
 * Single wrapper that BOTH the admin manual-send handler and the
 * submitDcrV1 post-write hook should call. Composes the existing
 * pieces:
 *   1. Read the dcr_submissions doc.
 *   2. Apply QA / test-customer / opt-out exclusions BEFORE the
 *      readiness check so seed data and excluded customers exit clean.
 *   3. Run getDcrEmailReadiness (mode="send") — exit "skipped" when
 *      blockers exist. Treats `already_sent` as duplicate_already_sent
 *      unless forceSend === true.
 *   4. Optionally short-circuit when dryRun.
 *   5. Call sendDcrEmailCore with the resolved customerId.
 *   6. Stamp native_email status onto dcr_submissions via
 *      recordEmailStatus.
 *   7. Return a structured result that both the HTTP handler and the
 *      submitDcrV1 hook can interpret without any further branching.
 *
 * Required inputs (callers must pre-resolve all secrets):
 *   admin, db, logger
 *   dcrId
 *   openaiApiKey, gmailSenderEmail, gmailServiceAccountKey
 *   kirbyAlertEmail?, aprilAlertEmail?
 *
 * Optional inputs:
 *   invokedBy        string — telemetry tag (e.g. "submitDcrV1" or
 *                              admin email)
 *   forceSend        bool   — override already_sent
 *   dryRun           bool   — skip the network call; everything else
 *                              runs (readiness, exclusion, planned recipient)
 *   subjectPrefix    string — override the subject tag (default
 *                              "[Pioneer DCR]" for prod auto-sends, or
 *                              "[TEST V6]" if caller doesn't set anything)
 *
 * Returns:
 *   {
 *     status:         "sent" | "skipped" | "failed",
 *     reason:         string,                 // human-readable explanation
 *     code:           string | null,          // blocker / failure code (machine)
 *     dcrId:          string,
 *     customerId:     string | null,
 *     recipient:      string | null,          // primary "to"
 *     messageId:      string | null,          // Gmail message id when sent
 *     payloadDocId:   string | null,          // dcr_email_payloads doc id
 *     invokedBy:      string,
 *     attemptedAt:    ISO string,             // when this helper ran
 *     sentAt:         ISO string | null
 *   }
 *
 * Never throws for "expected" outcomes. Any thrown exception bubbles
 * up so the caller (the submitDcrV1 hook wraps in try/catch) can decide
 * to swallow vs surface.
 * --------------------------------------------------------------------------- */
async function sendNativeDcrEmailForSubmission(opts) {
  const { admin: adminSdk, db, logger } = opts;
  const dcrId         = String(opts.dcrId || "").trim();
  const invokedBy     = String(opts.invokedBy || "unspecified");
  const forceSend     = opts.forceSend === true;
  const dryRun        = opts.dryRun === true;
  const subjectPrefix = opts.subjectPrefix || "[Pioneer DCR]";
  const attemptedAt   = new Date().toISOString();

  function result(status, reason, extras) {
    return Object.assign({
      status:        status,
      reason:        reason,
      code:          (extras && extras.code) || null,
      dcrId:         dcrId,
      customerId:    null,
      recipient:     null,
      messageId:     null,
      payloadDocId:  null,
      invokedBy:     invokedBy,
      attemptedAt:   attemptedAt,
      sentAt:        null
    }, extras || {});
  }

  if (!dcrId) {
    return result("failed", "dcrId is required", { code: "bad_request" });
  }

  // ---- 1. Read DCR ----
  const dcrSnap = await db.collection("dcr_submissions").doc(dcrId).get();
  if (!dcrSnap.exists) {
    return result("failed", "DCR not found", { code: "dcr_not_found" });
  }
  const dcr = Object.assign({ id: dcrSnap.id }, dcrSnap.data());

  // ---- 2. QA / test-data exclusions BEFORE the readiness call ----
  // Mirrors the Phase 29A QA filter used across payroll surfaces, plus
  // explicit Phase 32 customer-side opt-out fields. A submission tagged
  // as QA/test bypasses email entirely so seed data never reaches real
  // customers. NOTE: customer-side exclusion is also re-checked after
  // we resolve the customer doc inside readiness — this pre-check is
  // the fast path when the DCR doc itself is flagged.
  if (dcr.is_test === true || dcr.exclude_from_customer_reporting === true ||
      dcr.is_qa_test === true) {
    const reason = "DCR flagged as QA/test (is_test/is_qa_test/exclude_from_customer_reporting on submission)";
    if (!dryRun) {
      await recordEmailStatus(db, dcrId, {
        native_email: {
          status:      "skipped",
          reason:      reason,
          code:        "qa_test_submission",
          invokedBy:   invokedBy,
          attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
        }
      }, adminSdk);
    }
    return result("skipped", reason, { code: "qa_test_submission" });
  }

  // ---- 3. Readiness check ----
  const customerSlugGuess = String(dcr.customer_slug || dcr.customer_id || dcr.customerId || "").trim();
  const readiness = await getDcrEmailReadiness({
    db:      db,
    logger:  logger,
    dcrId:   dcrId,
    mode:    forceSend ? "resend" : "send"
  });
  const resolved = readiness.resolved || {};
  const customerId = resolved.customerId || customerSlugGuess || null;
  const recipient = (Array.isArray(resolved.emailRecipients) && resolved.emailRecipients[0]) || null;

  // ---- 3b. Customer-doc-level exclusion (re-check after readiness resolves) ----
  // Even if the DCR submission itself isn't QA-flagged, the customer doc
  // can carry exclude_from_customer_reporting. Read the customer doc
  // directly to honor it BEFORE we send.
  if (customerId) {
    try {
      const cSnap = await db.collection("customers").doc(customerId).get();
      if (cSnap.exists) {
        const c = cSnap.data() || {};
        if (c.is_test === true || c.exclude_from_customer_reporting === true ||
            c.disable_customer_notifications === true ||
            c.disable_dcr_email === true) {
          const reason = 'customers/' + customerId + " is flagged as test/excluded";
          if (!dryRun) {
            await recordEmailStatus(db, dcrId, {
              native_email: {
                status:      "skipped",
                reason:      reason,
                code:        "customer_excluded",
                customerId:  customerId,
                invokedBy:   invokedBy,
                attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
              }
            }, adminSdk);
          }
          return result("skipped", reason, { code: "customer_excluded", customerId: customerId });
        }
      }
    } catch (err) {
      logger.warn("[native-email] customer exclusion lookup failed (non-fatal)", {
        dcrId: dcrId, customerId: customerId, error: err && err.message
      });
    }
  }

  // ---- 3c. V20260614 — DCR-waiver / email-suppression gate ----
  // Honors the No-DCR-Needed flow: even if a DCR submission exists
  // (uncommon but possible — DCR submitted then waived, or two-tech
  // crossover), refuse to email the customer when the submission OR
  // its pioneer_service_session carries a waiver/suppression flag.
  // Three places to check:
  //   1. dcr.customer_email_suppressed === true     (set explicitly on submission)
  //   2. dcr.dcr_status === "waived"                (mirror flag if upstream sets it)
  //   3. session.dcr_status === "waived" OR
  //      session.dcr_customer_email_suppressed       (the canonical store of waiver state)
  // forceSend does NOT override these — a waived DCR is a product
  // decision, not a "didn't send yet" condition.
  if (dcr.customer_email_suppressed === true) {
    const reason = "DCR flagged customer_email_suppressed=true on submission — waiver upstream";
    if (!dryRun) {
      await recordEmailStatus(db, dcrId, {
        native_email: {
          status:      "skipped",
          reason:      reason,
          code:        "dcr_waived",
          customerId:  customerId,
          invokedBy:   invokedBy,
          attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
        }
      }, adminSdk);
    }
    return result("skipped", reason, { code: "dcr_waived", customerId: customerId });
  }
  if (dcr.dcr_status === "waived") {
    const reason = "DCR submission carries dcr_status='waived' — email suppressed";
    if (!dryRun) {
      await recordEmailStatus(db, dcrId, {
        native_email: {
          status:      "skipped",
          reason:      reason,
          code:        "dcr_waived",
          customerId:  customerId,
          invokedBy:   invokedBy,
          attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
        }
      }, adminSdk);
    }
    return result("skipped", reason, { code: "dcr_waived", customerId: customerId });
  }
  // Cross-check the linked session. pioneer_session_id is the doc id
  // of pioneer_service_sessions when submitDcrV1 wrote the DCR. Read
  // it cheaply (doc-id read) so the canonical waiver flag on the
  // session blocks email regardless of whether anyone wrote a mirror
  // onto the DCR doc.
  const linkedSessionId = String(dcr.pioneer_session_id || dcr.service_session_id || "").trim();
  if (linkedSessionId) {
    try {
      const sSnap = await db.collection("pioneer_service_sessions").doc(linkedSessionId).get();
      if (sSnap.exists) {
        const s = sSnap.data() || {};
        if (s.dcr_status === "waived" || s.dcr_customer_email_suppressed === true) {
          const reason = "pioneer_service_sessions/" + linkedSessionId +
                         " is dcr_status='waived' (or customer_email_suppressed) — email suppressed";
          if (!dryRun) {
            await recordEmailStatus(db, dcrId, {
              native_email: {
                status:      "skipped",
                reason:      reason,
                code:        "session_dcr_waived",
                customerId:  customerId,
                invokedBy:   invokedBy,
                attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
              }
            }, adminSdk);
          }
          return result("skipped", reason, {
            code:       "session_dcr_waived",
            customerId: customerId
          });
        }
      }
    } catch (err) {
      logger.warn("[native-email] linked-session waiver lookup failed (non-fatal)", {
        dcrId: dcrId, sessionId: linkedSessionId, error: err && err.message
      });
    }
  }

  // ---- 3d. V20260614 — Per-customer per-service-date dedupe ----
  // Blocks a second customer-facing email when a *different* DCR
  // for the same (customer_slug + clean_date) already mailed. Two
  // techs cleaning the same site, an admin late-resubmit, an
  // accidental-recovery DCR — all produce duplicate customer-side
  // noise unless we guard.
  //
  // Reads the existing (customer_slug asc, created_at desc)
  // composite index. created_at >= startOfDay - 1d gives a wide
  // enough window that submissions filed near midnight are still
  // caught. Results are filtered client-side by clean_date and
  // by id != current so we don't false-positive on this DCR's
  // own row.
  //
  // forceSend (admin manual resend) bypasses this gate so admins
  // retain the existing "explicitly resend" flow they already use
  // for already_sent.
  if (!forceSend && customerSlugGuess && dcr.clean_date) {
    try {
      const cleanDate = String(dcr.clean_date || "").trim();
      const widenStart = new Date(cleanDate + "T00:00:00Z");
      // 36-hour back-window: covers PST/PDT shift, late-night
      // submissions, and DCR forms that arrive after midnight UTC
      // but still belong to the same service day.
      widenStart.setUTCHours(widenStart.getUTCHours() - 36);
      const startTs = adminSdk.firestore.Timestamp.fromDate(widenStart);
      const dupQry = await db.collection("dcr_submissions")
        .where("customer_slug", "==", customerSlugGuess)
        .where("created_at",     ">=", startTs)
        .orderBy("created_at", "desc")
        .limit(20)
        .get();
      let dupHit = null;
      for (const d of dupQry.docs) {
        if (d.id === dcrId) continue;
        const other = d.data() || {};
        if (String(other.clean_date || "") !== cleanDate) continue;
        const nativeStatus = (other.native_email && other.native_email.status) || null;
        const deliveryEmailSent = (other.delivery && other.delivery.email_sent) || false;
        if (nativeStatus === "sent" || deliveryEmailSent === true) {
          dupHit = { id: d.id, sentAt: (other.native_email && other.native_email.sentAt) || null };
          break;
        }
      }
      if (dupHit) {
        const reason = "customer_already_emailed_today — dcr_submissions/" +
                       dupHit.id +
                       " for customer_slug=" + customerSlugGuess +
                       " clean_date=" + cleanDate +
                       " already sent" +
                       (dupHit.sentAt ? (" at " + dupHit.sentAt) : "");
        if (!dryRun) {
          await recordEmailStatus(db, dcrId, {
            native_email: {
              status:           "skipped",
              reason:           reason,
              code:             "customer_already_emailed_today",
              customerId:       customerId,
              dedupeAgainstDcr: dupHit.id,
              invokedBy:        invokedBy,
              attemptedAt:      adminSdk.firestore.FieldValue.serverTimestamp()
            }
          }, adminSdk);
        }
        return result("skipped", reason, {
          code:             "customer_already_emailed_today",
          customerId:       customerId,
          dedupeAgainstDcr: dupHit.id
        });
      }
    } catch (err) {
      logger.warn("[native-email] customer-date dedupe lookup failed (non-fatal)", {
        dcrId: dcrId, customerSlug: customerSlugGuess, cleanDate: dcr.clean_date,
        error: err && err.message
      });
    }
  }

  // ---- 4. Block on readiness blockers (with already_sent / forceSend logic) ----
  if (!readiness.ready) {
    const firstBlocker = (readiness.blockers && readiness.blockers[0]) || {};
    const code = firstBlocker.code || "not_ready";
    // "already_sent" gets a more specific reason for duplicate-protection visibility.
    if (code === "already_sent") {
      const reason = "duplicate_already_sent — DCR email already sent previously" +
                     (resolved.lastSentAt ? " at " + resolved.lastSentAt : "");
      if (!dryRun) {
        await recordEmailStatus(db, dcrId, {
          native_email: {
            status:       "skipped",
            reason:       reason,
            code:         "duplicate_already_sent",
            customerId:   customerId,
            recipient:    resolved.lastSentTo || recipient,
            messageId:    resolved.lastSentMessageId || null,
            invokedBy:    invokedBy,
            attemptedAt:  adminSdk.firestore.FieldValue.serverTimestamp()
          }
        }, adminSdk);
      }
      return result("skipped", reason, {
        code: "duplicate_already_sent",
        customerId: customerId,
        recipient: resolved.lastSentTo || recipient,
        messageId: resolved.lastSentMessageId || null,
        payloadDocId: dcrId,
        sentAt: resolved.lastSentAt || null
      });
    }
    // Map common blockers to skipped reasons (don't fail the parent flow).
    const reason = firstBlocker.message || code;
    if (!dryRun) {
      await recordEmailStatus(db, dcrId, {
        native_email: {
          status:      "skipped",
          reason:      reason,
          code:        code,
          customerId:  customerId,
          invokedBy:   invokedBy,
          attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
        }
      }, adminSdk);
    }
    return result("skipped", reason, { code: code, customerId: customerId, recipient: recipient });
  }

  // ---- 5. Dry-run short-circuit (after readiness so we still surface the planned recipient) ----
  if (dryRun) {
    return result("skipped", "dry_run — would have sent", {
      code: "dry_run",
      customerId: customerId,
      recipient: recipient
    });
  }

  // ---- 6. Send via sendDcrEmailCore ----
  let core;
  try {
    core = await sendDcrEmailCore({
      admin:                  adminSdk,
      db:                     db,
      logger:                 logger,
      dcrId:                  dcrId,
      customerId:             customerId,
      openaiApiKey:           opts.openaiApiKey,
      gmailSenderEmail:       opts.gmailSenderEmail,
      gmailServiceAccountKey: opts.gmailServiceAccountKey,
      kirbyAlertEmail:        opts.kirbyAlertEmail,
      aprilAlertEmail:        opts.aprilAlertEmail,
      subjectPrefix:          subjectPrefix
    });
  } catch (err) {
    // sendDcrEmailCore only throws for truly unexpected runtime errors.
    // Stamp + surface as failed.
    logger.error("[native-email] sendDcrEmailCore threw", {
      dcrId: dcrId, customerId: customerId, error: err && err.message, stack: err && err.stack
    });
    await recordEmailStatus(db, dcrId, {
      native_email: {
        status:      "failed",
        reason:      (err && err.message) || "unknown error",
        code:        "core_threw",
        customerId:  customerId,
        recipient:   recipient,
        invokedBy:   invokedBy,
        attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
      }
    }, adminSdk);
    return result("failed", (err && err.message) || "core threw", {
      code: "core_threw", customerId: customerId, recipient: recipient
    });
  }

  // ---- 7. Translate core result into our return shape + stamp native_email ----
  if (core && core.ok && core.status === "sent") {
    const sentAtIso = new Date().toISOString();
    await recordEmailStatus(db, dcrId, {
      native_email: {
        status:       "sent",
        reason:       null,
        code:         null,
        customerId:   customerId,
        recipient:    core.to || recipient,
        messageId:    core.messageId || null,
        payloadDocId: core.payloadDocId || dcrId,
        invokedBy:    invokedBy,
        attemptedAt:  adminSdk.firestore.FieldValue.serverTimestamp(),
        sentAt:       adminSdk.firestore.FieldValue.serverTimestamp()
      }
    }, adminSdk);
    return result("sent", "delivered via Gmail API", {
      code:         null,
      customerId:   customerId,
      recipient:    core.to || recipient,
      messageId:    core.messageId || null,
      payloadDocId: core.payloadDocId || dcrId,
      sentAt:       sentAtIso
    });
  }
  if (core && core.ok && core.status === "skipped") {
    const reason = core.reason || "core returned skipped";
    await recordEmailStatus(db, dcrId, {
      native_email: {
        status:      "skipped",
        reason:      reason,
        code:        "core_skipped",
        customerId:  customerId,
        recipient:   recipient,
        invokedBy:   invokedBy,
        attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
      }
    }, adminSdk);
    return result("skipped", reason, { code: "core_skipped", customerId: customerId, recipient: recipient });
  }
  // Failure path (core.ok === false).
  const failCode = (core && core.code) || "unknown_failure";
  const failMsg  = (core && core.error) || "core returned unexpected shape";
  await recordEmailStatus(db, dcrId, {
    native_email: {
      status:      "failed",
      reason:      failMsg,
      code:        failCode,
      customerId:  customerId,
      recipient:   recipient,
      invokedBy:   invokedBy,
      attemptedAt: adminSdk.firestore.FieldValue.serverTimestamp()
    }
  }, adminSdk);
  return result("failed", failMsg, { code: failCode, customerId: customerId, recipient: recipient });
}

/* ----------------------------------------------------------------------------
 * buildHttpHandler — admin-auth wrapper around sendDcrEmailCore.
 *
 * Returns an async (req, res) handler suitable for onRequest(). All the
 * business logic lives in sendDcrEmailCore; this layer is responsible
 * only for HTTP shape, CORS, admin-token verification, and mapping the
 * core's structured result to HTTP status codes.
 * --------------------------------------------------------------------------- */
function buildHttpHandler(deps) {
  const {
    admin, db, logger,
    OPENAI_API_KEY,
    GMAIL_SENDER_EMAIL,
    GMAIL_SERVICE_ACCOUNT_KEY,
    // V6 — optional office-alert secrets. When present + DCR is red
    // tier, the send fires an alert email to these addresses too.
    KIRBY_ALERT_EMAIL,
    APRIL_ALERT_EMAIL,
    verifyStaffOrReject
  } = deps;
  function safeSecretValue(s) {
    try { return s && s.value ? s.value() : ""; }
    catch (_e) { return ""; }
  }

  return async function generateAndSendDcrEmailV1(req, res) {
    res.set("Access-Control-Allow-Origin",  "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age",       "3600");
    res.set("Vary", "Origin");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST only" });
      return;
    }

    // Admin auth gate. Reuses the same Firebase-Auth-token verification
    // every other admin endpoint relies on. Non-admins are rejected.
    const staff = await verifyStaffOrReject(req, res);
    if (!staff) return;
    if (!staff.isAdmin) {
      res.status(403).json({ ok: false, error: "Admin only" });
      return;
    }

    const body = req.body || {};
    const dcrId      = String(body.dcrId || "").trim();
    const customerId = String(body.customerId || "").trim();
    const testRecipientEmail = String(body.testRecipientEmail || "").trim();
    const confirmResend = body.confirmResend === true || body.confirmResend === "true";

    try {
      // V6 — readiness gate. Production sends MUST pass the readiness
      // check before we burn an email. Test sends (testRecipientEmail
      // set) bypass the gate so QA can target deliberately-thin DCRs.
      // The single bypassable blocker is `already_sent` — but only
      // when the caller passes confirmResend: true.
      if (!testRecipientEmail) {
        const readiness = await getDcrEmailReadiness({
          db: db, logger: logger, dcrId: dcrId,
          mode: confirmResend ? "resend" : "send"
        });
        if (!readiness.ready) {
          res.status(409).json({
            ok:        false,
            code:      "not_ready",
            error:     "DCR is not ready to send",
            blockers:  readiness.blockers,
            warnings:  readiness.warnings,
            resolved:  readiness.resolved,
            hint:      "Resolve blockers and try again. To resend a previously sent DCR, pass confirmResend: true."
          });
          return;
        }
      }

      // Phase 32 — production-path sends route through the wrapper so
      // dcr_submissions.native_email gets stamped consistently with the
      // submitDcrV1 auto-send path. Test sends (testRecipientEmail set)
      // keep the legacy direct-core path so QA can target thin DCRs
      // without tripping the wrapper's QA-exclusion guard.
      let result;
      if (!testRecipientEmail) {
        const wrapped = await sendNativeDcrEmailForSubmission({
          admin: admin, db: db, logger: logger,
          dcrId:                  dcrId,
          invokedBy:              "admin:" + (staff.email || "?"),
          forceSend:              confirmResend,
          dryRun:                 false,
          openaiApiKey:           OPENAI_API_KEY.value(),
          gmailSenderEmail:       GMAIL_SENDER_EMAIL.value(),
          gmailServiceAccountKey: GMAIL_SERVICE_ACCOUNT_KEY.value(),
          kirbyAlertEmail:        safeSecretValue(KIRBY_ALERT_EMAIL),
          aprilAlertEmail:        safeSecretValue(APRIL_ALERT_EMAIL)
        });
        // Translate wrapper shape → sendDcrEmailCore-compatible shape so
        // the existing response-mapping code below works unchanged.
        if (wrapped.status === "sent") {
          result = {
            ok: true, status: "sent",
            subject:       null,
            messageId:     wrapped.messageId,
            promptVersion: null,
            emailTemplate: null,
            to:            wrapped.recipient,
            summary:       null,
            isTestSend:    false,
            payloadDocId:  wrapped.payloadDocId
          };
        } else if (wrapped.status === "skipped") {
          result = { ok: true, status: "skipped", reason: wrapped.reason };
        } else {
          result = { ok: false, code: wrapped.code || "unknown_failure", error: wrapped.reason };
        }
      } else {
        result = await sendDcrEmailCore({
          admin, db, logger,
          dcrId, customerId, testRecipientEmail,
          openaiApiKey:           OPENAI_API_KEY.value(),
          gmailSenderEmail:       GMAIL_SENDER_EMAIL.value(),
          gmailServiceAccountKey: GMAIL_SERVICE_ACCOUNT_KEY.value(),
          kirbyAlertEmail:        safeSecretValue(KIRBY_ALERT_EMAIL),
          aprilAlertEmail:        safeSecretValue(APRIL_ALERT_EMAIL)
        });
      }

      // Map structured core result → HTTP. Success + skipped are 2xx;
      // expected failures get specific codes; everything else is 500.
      if (result.ok) {
        res.json(result);
        return;
      }
      const codeToStatus = {
        bad_request:        400,
        dcr_not_found:      404,
        customer_not_found: 404,
        no_email:           400,
        send_failed:        502
      };
      const httpStatus = codeToStatus[result.code] || 500;
      res.status(httpStatus).json(result);
    } catch (err) {
      const msg = String(err && err.message || err);
      logger.error("[dcr-email] handler error", { dcrId, customerId, error: msg, stack: err && err.stack });
      try {
        await recordEmailStatus(db, dcrId, {
          emailStatus: "failed",
          emailError:  msg
        }, admin);
      } catch (_inner) { /* swallow — primary failure is what matters */ }
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

// Quick email shape check — not RFC-strict, just "looks like an email".
// Used only for the optional testRecipientEmail body field.
function isEmailShaped(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

module.exports = {
  buildHttpHandler:                  buildHttpHandler,
  // Shared core — used by buildHttpHandler AND scripts/test-dcr-email-local.js.
  // No HTTP, no auth — pure business logic. See the function header for the
  // input contract and the structured return shape.
  sendDcrEmailCore:                  sendDcrEmailCore,
  // Readiness gate — used by getDcrEmailReadinessV1 (admin UI) AND the
  // HTTP handler before it calls sendDcrEmailCore. Pure read, no
  // Firestore writes.
  getDcrEmailReadiness:              getDcrEmailReadiness,
  // Phase 32 — single entrypoint used by BOTH the admin manual send path
  // AND the submitDcrV1 auto-send hook. Wraps readiness + exclusions +
  // sendDcrEmailCore + native_email stamping.
  sendNativeDcrEmailForSubmission:   sendNativeDcrEmailForSubmission,
  // Helpers exported for unit testing or reuse in future scheduled trigger.
  normalizeDcrForEmail:              normalizeDcrForEmail,
  // ---- V1 helpers (legacy; preserved for compatibility) ----
  createDcrEmailPrompt:              createDcrEmailPrompt,
  generateAiSummary:                 generateAiSummary,
  generateDcrEmailHtmlV1:            generateDcrEmailHtmlV1,
  buildFallbackSummary:              buildFallbackSummary,
  // ---- V2 helpers (still used: content generation + V2 renderer back-compat) ----
  createDcrEmailPromptV2:            createDcrEmailPromptV2,
  generateDcrEmailContentJsonV2:     generateDcrEmailContentJsonV2,
  buildFallbackContentV2:            buildFallbackContentV2,
  validateContentJsonV2:             validateContentJsonV2,
  renderDcrEmailHtmlV2:              renderDcrEmailHtmlV2,
  // ---- V3 helpers (preserved; V4 reuses tagline + report-id + time) ----
  renderDcrEmailHtmlV3:              renderDcrEmailHtmlV3,
  v3HeaderStatusPill:                v3HeaderStatusPill,
  v3VisitTagline:                    v3VisitTagline,
  v3BuildTrustStripTiles:            v3BuildTrustStripTiles,
  v3BuildReportId:                   v3BuildReportId,
  v3FormatSubmittedTime:             v3FormatSubmittedTime,
  // ---- V4 helpers (active rendering path) ----
  renderDcrEmailHtmlV4:              renderDcrEmailHtmlV4,
  v4HeaderStatusPill:                v4HeaderStatusPill,
  v4BuildTrustStripTiles:            v4BuildTrustStripTiles,
  v4FormatDuration:                  v4FormatDuration,
  formatPhotoCaptionTime:            formatPhotoCaptionTime,
  formatNextCleanLine:               formatNextCleanLine,
  v5BuildCompletedBulletsFromChecklist: v5BuildCompletedBulletsFromChecklist,
  v5CanonicalBulletForSection:       v5CanonicalBulletForSection,
  v2ExtractPhotoEntries:             v2ExtractPhotoEntries,
  v2FirstHttpsStringWithSource:      v2FirstHttpsStringWithSource,
  // ---- Shared ----
  sendGmailMessage:                  sendGmailMessage,
  recordEmailStatus:                 recordEmailStatus,
  buildSubject:                      buildSubject
};
