/* Pioneer DCR Hub — payload builder (vanilla JS, no build step).
 *
 * Exposes:
 *   window.DCR_V1_EXAMPLE       — canonical example payload (matches FIRESTORE_SCHEMA.md)
 *   window.buildDcrV1Payload()  — converts a flat form `input` object into a Firestore-ready payload
 *
 * The Cloud Function (`submitDcrV1`) stamps server timestamps on top of this.
 */
(function () {
  "use strict";

  const SCHEMA_VERSION = "dcr.v1";
  const APP_VERSION    = "dcr-hub-web@0.1.0";

  /* ----------------------------- canonical example ----------------------------- */

  const DCR_V1_EXAMPLE = {
    schema_version: SCHEMA_VERSION,
    submission_id: "abc123",
    source: "web_form",

    customer_slug: "acme-dental",
    customer_name: "Acme Dental — Riverside",

    tech_slug: "maria-g",
    tech_display_name: "Maria G.",
    tech_experience_level: "lead",

    template_id: "medical-office-standard",
    template_version: 1,

    clean_date: "2026-05-10",
    clean_started_at: null,
    clean_ended_at: null,

    time_budget: {
      budgeted_minutes: 90,
      actual_minutes: 105,
      variance_minutes: 15,
      reason_group: "over_budget_due_to",
      reason_note: "Spill in lobby required extra wet vac pass"
    },

    occupancy: "normal",

    checklist: [
      {
        section_id: "restrooms",
        section_label: "Restrooms",
        items: [
          { item_id: "toilets-cleaned", label: "Toilets cleaned & disinfected", status: "done" },
          { item_id: "mirrors-streak",  label: "Mirrors streak-free",           status: "issue", note: "Cracked mirror in stall 2" }
        ]
      }
    ],

    supply_requests: [
      { supply_id: "tp-2ply", label: "Toilet paper (2-ply)", quantity: 2, unit: "case", urgency: "next_visit" }
    ],

    problems: [
      {
        id: "p1",
        category: "plumbing",
        tier: "tier_2",
        description: "Slow drain in men's room sink #2",
        photo_ids: ["ph_3"],
        reported_to_customer: false
      }
    ],

    photos: [
      {
        id: "ph_1",
        storage_path: "dcr-photos/acme-dental/abc123/photo-1.jpg",
        download_url: "https://firebasestorage.googleapis.com/.../photo-1.jpg?alt=media&token=...",
        content_type: "image/jpeg",
        size_bytes: 482910,
        width: null,
        height: null,
        caption: "After — lobby floor",
        tag: "after"
      }
    ],

    notes: "All routine. Reported slow drain to AM via Slack.",

    affirmation: {
      affirmed: true,
      affirmed_text: "I confirm the above is accurate to the best of my knowledge.",
      signature_name: "Maria G.",
      signed_at: null
    },

    submission_meta: {
      user_agent: "",
      app_version: APP_VERSION,
      ip_hash: null,
      client_submitted_at: null,
      geo: null
    },

    delivery: {
      email_sent: false,
      email_sent_at: null,
      zapier_sent: false,
      zapier_sent_at: null,
      zapier_attempts: 0,
      last_error: null
    }
  };

  /* ----------------------------- helpers ----------------------------- */

  function nowIso() { return new Date().toISOString(); }

  // Always returns a string. Use for fields that may legitimately be empty (notes, captions).
  function safeStr(v, fallback)  { return (typeof v === "string" && v.length) ? v : (fallback ?? ""); }
  // Returns a trimmed, non-empty string or the fallback (also trimmed). Use for required fields
  // — must match the function validator's `isNonEmptyString` behaviour exactly.
  function reqStr(v, fallback) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length) return t;
    }
    return typeof fallback === "string" ? fallback.trim() : "";
  }
  function safeArr(v)            { return Array.isArray(v) ? v : []; }
  function safeObj(v)            { return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }

  // Whitelist must mirror functions/index.js → ALLOWED_SOURCES.
  const ALLOWED_SOURCES_SET = new Set(["web_form", "ghl", "api"]);
  function pickSource(v)    { return ALLOWED_SOURCES_SET.has(v) ? v : "web_form"; }
  // Mirror the validator's regex; if the input doesn't match, return "" so the function rejects it
  // loudly rather than silently writing a malformed date.
  function pickCleanDate(v) { return (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : ""; }

  function normalizePhoto(p, idx) {
    const o = safeObj(p);
    return {
      id:           reqStr(o.id, `ph_${idx + 1}`),
      storage_path: reqStr(o.storage_path),
      download_url: reqStr(o.download_url),
      content_type: typeof o.content_type === "string" ? o.content_type : null,
      size_bytes:   typeof o.size_bytes   === "number" ? o.size_bytes   : 0,
      width:        typeof o.width        === "number" ? o.width        : null,
      height:       typeof o.height       === "number" ? o.height       : null,
      caption:      typeof o.caption      === "string" ? o.caption      : "",
      tag:          reqStr(o.tag, "general")
    };
  }

  /**
   * Build a Firestore-ready DCR v1 payload.
   *
   * Required input shape (everything else is optional):
   *   {
   *     submission_id:        string,           // generated client-side (used in storage path)
   *     customer:             { slug, name },
   *     tech:                 { slug, display_name, experience_level? },
   *     clean_date:           "YYYY-MM-DD",
   *     notes:                string,
   *     photos:               Photo[],          // already-uploaded photo objects
   *     checklist?:           ChecklistSection[],
   *     supply_requests?:     SupplyRequest[],
   *     problems?:            Problem[],
   *     occupancy?:           string,
   *     time_budget?:         TimeBudget,
   *     template?:            { id, version },
   *     affirmation?:         { affirmed, signature_name },
   *     source?:              "web_form" | "ghl" | "api"
   *   }
   */
  function buildDcrV1Payload(input) {
    const i = safeObj(input);

    const customer    = safeObj(i.customer);
    const tech        = safeObj(i.tech);
    const template    = safeObj(i.template);
    const aff         = safeObj(i.affirmation);
    const reviewLinks = safeObj(i.review_links || customer.review_links);

    // Normalized photo objects + a flat photo_urls array for downstream consumers
    // (Zapier templates, email merge fields) that just want a list of URLs.
    const photos = safeArr(i.photos).map(normalizePhoto);
    const photoUrls = photos
      .map(function (p) { return typeof p.download_url === "string" ? p.download_url : ""; })
      .filter(function (u) { return u.length > 0; });

    return {
      schema_version: SCHEMA_VERSION,
      submission_id: reqStr(i.submission_id),
      source: pickSource(i.source),

      customer_slug: reqStr(customer.slug),
      customer_name: safeStr(customer.name),
      // Denormalized for Zapier / email routing without a separate customer lookup.
      customer_email: safeStr(customer.email),
      // Distinct from customer_name so multi-location customers can keep one name
      // but route reports per-location. Falls back to customer_name when omitted.
      location_name: safeStr(customer.location_name || customer.name),
      // Customer-level DCR email opt-out. DISTINCT from dcr_enabled — this only
      // controls whether the downstream Zap should send the customer-facing
      // DCR email. The customer still appears in the form, the cleaner still
      // submits, Firestore still persists, Zapier still receives the payload.
      // Default true when missing → backward-compatible with existing docs.
      customer_dcr_email_enabled: customer.dcr_email_enabled !== false,

      tech_slug: reqStr(tech.slug),
      tech_display_name: safeStr(tech.display_name),
      tech_experience_level: reqStr(tech.experience_level, "standard"),

      template_id: safeStr(template.id, ""),
      template_version: typeof template.version === "number" ? template.version : 0,

      clean_date: pickCleanDate(i.clean_date),
      clean_started_at: i.clean_started_at || null,
      clean_ended_at: i.clean_ended_at || null,

      time_budget: i.time_budget || null,
      occupancy: safeStr(i.occupancy, ""),

      checklist:       safeArr(i.checklist),
      supply_requests: safeArr(i.supply_requests),
      problems:        safeArr(i.problems),

      photos:     photos,
      photo_urls: photoUrls,

      // notes is "must be a string" per validator — empty string is allowed, undefined is not.
      notes: typeof i.notes === "string" ? i.notes : "",

      // Validator (functions/index.js) requires:
      //   affirmation.affirmed === true
      //   affirmation.signature_name is a non-empty (trimmed) string
      // Build this block explicitly so the value from the signature/name input
      // flows through verbatim — no silent fallbacks that could mask a missing value.
      // signature_url is always present (string or null) so downstream readers
      // never have to existence-check the field.
      affirmation: (function () {
        const affirmed = aff.affirmed === true;
        const signatureName = reqStr(aff.signature_name);
        return {
          affirmed: affirmed,
          signature_name: signatureName,
          signature_url: typeof aff.signature_url === "string" && aff.signature_url ? aff.signature_url : null,
          affirmed_text: safeStr(aff.affirmed_text, "I confirm the above is accurate to the best of my knowledge."),
          signed_at: affirmed ? nowIso() : null
        };
      })(),

      // Phase-2-ready slot for the GHL review funnel. Empty defaults until Zapier
      // (or a future intake) populates customer-specific URLs.
      review_links: {
        five_star_url: safeStr(reviewLinks.five_star_url),
        issue_url:     safeStr(reviewLinks.issue_url)
      },

      // Phase-2-ready linkage between this DCR and the customer review it triggers.
      // Default values so reads never need null-checks.
      feedback: {
        review_requested:     false,
        review_link_sent:     false,
        customer_rating:      null,
        customer_feedback_id: null
      },

      submission_meta: {
        user_agent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
        app_version: APP_VERSION,
        ip_hash: null,
        client_submitted_at: nowIso(),
        geo: i.geo || null
      },

      delivery: {
        email_sent: false,
        email_sent_at: null,
        // Policy snapshot at submit time — mirrors customer_dcr_email_enabled.
        // Lives in `delivery` so a Zap reading just the delivery map sees both
        // the "should we?" (this) and the "did we?" (email_sent) flags together.
        customer_email_enabled: customer.dcr_email_enabled !== false,
        zapier_sent: false,
        zapier_sent_at: null,
        zapier_attempts: 0,
        last_error: null
      }
    };
  }

  window.DCR_V1_EXAMPLE      = Object.freeze(DCR_V1_EXAMPLE);
  window.buildDcrV1Payload   = buildDcrV1Payload;
})();
