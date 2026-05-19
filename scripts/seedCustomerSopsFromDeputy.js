#!/usr/bin/env node
/* ====================================================================
 * seedCustomerSopsFromDeputy.js
 *
 * Reads scripts/deputy-company-sop-seed.json (raw Deputy /Company/QUERY
 * payload), parses each Company's _DPMetaData.AddressObject.Notes into
 * TWO independent docs:
 *
 *   • customers/{slug}              — PUBLIC, signed-in staff readable
 *       sopStatus, sopUpdatedAt, sopSource, sopQuickGlance,
 *       sopSections, sopDoNot, sopMustDo, sopPublicNotes,
 *       hasSecureSop
 *
 *   • customer_secure/{slug}        — ADMIN-ONLY (rule-gated)
 *       alarmCodes, doorCodes, gateCodes, emergencyContacts,
 *       rawDeputyNotes, secureInstructions, deputyCompanyId,
 *       sourceUpdatedAt, parsedAt
 *
 * SAFETY:
 *   • Default mode is DRY-RUN. Nothing is written.
 *   • --write splits the data and commits BOTH docs (customers with
 *     merge:true; customer_secure with merge:false so stale codes
 *     never linger after a re-import).
 *   • Codes / emergency contacts are NEVER written to the customer
 *     doc itself. They live ONLY in customer_secure.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   node scripts/seedCustomerSopsFromDeputy.js [flags]
 *
 * Flags:
 *   --dry-run                 (default — print summary, write nothing)
 *   --write                   (commit to Firestore)
 *   --company-id=<id>         (process a single Deputy Company.Id)
 *   --customer-id=<slug>      (process only the matched Pioneer slug)
 *   --seed-file=<path>        (override default seed path)
 *   --verbose                 (extra per-doc logging)
 *   --diagnose                (print diagnostic context block)
 *   --strict                  (exit non-zero if any risky/stale/duplicate
 *                              mappings exist; prevents accidental write)
 *
 * Safety gate (post-2026-05-17 hardening):
 *   • deputy_company_id alone NEVER auto-confirms a match — names must align.
 *   • customer.deputy_company_name is SUPPORTING only — it can confirm an
 *     already-plausible match (customer_name overlap or alias overlap) but
 *     can NEVER approve a match on its own.
 *   • Stale-mapping (stored deputy_company_name matches Deputy but
 *     customer_name disagrees) → STALE_MAPPING_DETECTED, blocked.
 *   • Two Deputy companies → same Pioneer slug → DUPLICATE_TARGET_CONFLICT,
 *     both blocked.
 * ================================================================== */

const fs   = require("fs");
const path = require("path");

let admin = null;
try { admin = require("firebase-admin"); }
catch (_e) { /* deferred: lazy-init below */ }

// ---------- CLI ----------
const ARGS = process.argv.slice(2).reduce(function (acc, raw) {
  const eq = raw.indexOf("=");
  if (eq > 0) acc[raw.slice(2, eq)] = raw.slice(eq + 1);
  else        acc[raw.replace(/^--/, "")] = true;
  return acc;
}, {});
const MODE       = ARGS.write ? "write" : "dry-run";
const SEED_FILE  = ARGS["seed-file"] ||
                   path.join(__dirname, "deputy-company-sop-seed.json");
const VERBOSE    = !!ARGS.verbose;
const DIAGNOSE   = !!ARGS.diagnose;
const STRICT     = !!ARGS.strict;
const ONLY_COMP  = ARGS["company-id"]  ? String(ARGS["company-id"])  : null;
const ONLY_CUST  = ARGS["customer-id"] ? String(ARGS["customer-id"]) : null;

// ---------- Skip / inactive rules ----------
// Pattern-based so the real Deputy names match — they're slightly
// longer than the placeholder names (e.g. the live data has
// "Pioneer Commercial Cleaning HQ" instead of "Pioneer HQ", and
// "Supply Station - Max Storage" instead of "Supply Station").
const SKIP_INTERNAL_PATTERNS = [
  /^\s*default\s+pay\s+(centre|center)\s*$/i,
  /^\s*pioneer\s+commercial\s+cleaning\b/i,    // catches HQ, Interviews, Inspections, etc.
  /^\s*pioneer\s+hq\s*$/i,                     // legacy short form
  /\bmonthly\s+employee\s+meet(ing)?\b/i,
  /^\s*remote\s+hq\s*$/i,
  /^\s*supply\s+station\b/i                    // catches "Supply Station - Max Storage"
];

function isInternalSkip(companyName) {
  const s = String(companyName || "").trim();
  if (!s) return true;   // empty name → not a real customer
  return SKIP_INTERNAL_PATTERNS.some(function (re) { return re.test(s); });
}

// ---------- Normalization ----------
function normalizeKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ---------- Sensitivity detector ----------
// Returns true when a line contains anything that looks like a code,
// phone number, or other sensitive identifier — even if it's wrapped
// in an otherwise-safe DO-NOT or MUST-DO sentence. Used to route
// critical-note lines to either public (sopDoNot/sopMustDo) or secure
// (secureInstructions). Conservative — false positives go to secure.
function looksSensitive(line) {
  const s = String(line || "");
  const lo = s.toLowerCase();
  if (/\b(alarm|pin|fob|keypad|key\s*code|combo|combination)\b/.test(lo)) return true;
  if (/\b(door|gate|entry|side\s*door|back\s*door)\s*code\b/.test(lo)) return true;
  if (/\bcode\s*[:#-]?\s*\d/.test(lo)) return true;
  if (/\b(passphrase|password|pass\s*code)\b/.test(lo)) return true;
  if (/\bemergency\s*contact\b/.test(lo)) return true;
  if (/\b(\d[\d\-().\s]{6,}\d)\b/.test(s)) return true;   // phone numbers / long digit runs
  if (/[#*]\s*\d{2,}/.test(s)) return true;                // 7421#, *123#
  if (/\b\d{4,}\b/.test(s)) return true;                   // any 4+ digit run on its own
  return false;
}

// ---------- Line helpers ----------
function splitNonEmptyLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

// ---------- Parsers ----------
// Each parser returns plain arrays. Splitting into public/secure is
// done by the buildSplitSop step below.
function parseAccess(notes) {
  const out = {
    door_codes:          [],
    gate_codes:          [],
    alarm_codes:         [],
    key_fob_notes:       [],
    alarm_company_notes: [],
    emergency_contacts:  [],
    general_access_notes:[]
  };
  splitNonEmptyLines(notes).forEach(function (line) {
    const lower = line.toLowerCase();
    if (/^\s*alarm\s*code/i.test(line))                       out.alarm_codes.push(line);
    else if (/^\s*alarm\s*company/i.test(line))               out.alarm_company_notes.push(line);
    else if (/^\s*gate\s*code/i.test(line))                   out.gate_codes.push(line);
    else if (/^\s*(door|entry)\s*code/i.test(line))           out.door_codes.push(line);
    else if (/^\s*(key\s*fob|key\s*card|keys?)\b/i.test(line)) out.key_fob_notes.push(line);
    else if (/^\s*emergency\s*contact/i.test(line))           out.emergency_contacts.push(line);
    else if (/^\s*contact\s*person/i.test(line))              out.emergency_contacts.push(line);
    else if (lower.includes("alarm")     && /\b\d{3,}\b/.test(line)) out.alarm_codes.push(line);
    else if (/(gate).{0,12}code/i.test(line) && /\d/.test(line))     out.gate_codes.push(line);
    else if (/(door|entry).{0,12}code/i.test(line) && /\d/.test(line)) out.door_codes.push(line);
    else if (/passphrase|pass code|pass-code/i.test(line))    out.general_access_notes.push(line);
  });
  return out;
}

function parseCriticalNotes(notes) {
  const out = { do_not_do: [], must_do: [], safety_or_emergency: [], customer_preferences: [] };
  splitNonEmptyLines(notes).forEach(function (line) {
    if (/\b(do\s*not|don'?t|never|avoid)\b/i.test(line))            out.do_not_do.push(line);
    if (/\b(must|make\s*sure|always|required|only)\b/i.test(line) &&
        !/\b(do\s*not|don'?t)\b/i.test(line))                       out.must_do.push(line);
    if (/\b(danger|warning|caution|hazard|safety|wet floor|biohazard|sharps)\b/i.test(line)) {
      out.safety_or_emergency.push(line);
    }
    if (/\b(prefer|preference|likes|dislikes|allerg(y|ic))\b/i.test(line) &&
        !/(do\s*not|don'?t)/i.test(line)) {
      out.customer_preferences.push(line);
    }
  });
  Object.keys(out).forEach(function (k) {
    out[k] = Array.from(new Set(out[k]));
  });
  return out;
}

const FREQ_REGEX = /\b(daily|weekly|biweekly|bi-weekly|monthly|quarterly|annually|annual|5x\s*weekly|4x\s*weekly|3x\s*weekly|2x\s*weekly|1x\s*weekly|first\s+(sun|mon|tue|wed|thu|fri|sat)|weekend\s*full\s*cleaning|every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi;

function parseServiceProfile(notes) {
  const out = { frequency_notes: [], areas_serviced: [], special_periodic_tasks: [] };
  splitNonEmptyLines(notes).forEach(function (line) {
    if (line.match(FREQ_REGEX)) out.frequency_notes.push(line);
    if (/\b(weekly|monthly|quarterly|annual)\b/i.test(line) &&
        /\b(detail|deep|polish|wax|strip|seal)/i.test(line)) {
      out.special_periodic_tasks.push(line);
    }
  });
  Object.keys(out).forEach(function (k) {
    out[k] = Array.from(new Set(out[k]));
  });
  return out;
}

const SECTION_HEADINGS_RAW = [
  "Front Entry", "Front Entrance", "Entry / Lobby", "Lobby", "Reception",
  "Offices", "Office Area", "Provider Offices",
  "Kitchens", "Kitchen", "Break Room", "Lunch Room", "Lunchroom",
  "Restrooms", "Bathrooms",
  "Hallways", "Hallway",
  "Stairwells", "Stairwell",
  "Conference Rooms", "Conference Room",
  "Shop Areas", "Shop Area", "Shop Floor",
  "Exam Rooms", "Exam Room",
  "Lab Area", "Lab",
  "Production Area", "Warehouse",
  "Special Cleaning", "Special Cleaning Instructions",
  "Weekly", "Monthly", "Quarterly", "Annually",
  "Areas Serviced"
];
const SECTION_HEADING_SET = new Set(SECTION_HEADINGS_RAW.map(function (h) { return h.toLowerCase(); }));

function parseSections(notes) {
  const lines = String(notes || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = null;
  function flush() {
    if (current && current.tasks.length) sections.push(current);
    current = null;
  }
  lines.forEach(function (raw) {
    const trimmed = raw.trim();
    const candidate = trimmed.replace(/[:\-]+$/, "").trim();
    if (candidate && SECTION_HEADING_SET.has(candidate.toLowerCase())) {
      flush();
      const freqMatch = candidate.match(/^\s*(weekly|monthly|quarterly|annually)\b(.*)$/i);
      current = {
        title:     candidate,
        frequency: freqMatch ? freqMatch[1].toLowerCase() : null,
        tasks:     []
      };
      return;
    }
    if (!current) return;
    if (!trimmed) return;
    const task = trimmed.replace(/^[-*•·]\s*/, "").trim();
    if (task) current.tasks.push(task);
  });
  flush();
  // Section TASK lines that look sensitive are stripped — those go
  // into customer_secure.secureInstructions via the caller.
  return sections;
}

// ---------- Public raw-text redactor ----------
// Builds the redacted full-text version of Deputy notes that the tech
// view uses as the single-source readable SOP. Strategy:
//   1. Split into lines.
//   2. Drop any line that looksSensitive() flags — codes, phones,
//      emergency contacts, alarm/door/gate identifiers.
//   3. Defensively scrub the surviving lines anyway: replace any 4+
//      digit run, any #NN / *NN keypad-shaped pattern, and any phone-
//      shaped digit run with "[redacted]". This is belt-and-suspenders
//      so a malformed sensitive line that slips past looksSensitive
//      still doesn't leak the actual digits to a tech.
//   4. Collapse runs of 3+ blank lines into 2 and trim outer whitespace.
//
// The result is what techs see. It is NEVER sent to customer_secure
// (which still gets the unredacted rawDeputyNotes).
function buildPublicRawText(notes) {
  if (!notes) return "";
  const lines = String(notes).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (looksSensitive(line)) continue;
    const safe = String(line)
      .replace(/\b(\d[\d\-().\s]{6,}\d)\b/g, "[redacted]")    // phone-shaped
      .replace(/[#*]\s*\d{2,}/g, "[redacted]")                  // 7421# / *123
      .replace(/\b\d{4,}\b/g, "[redacted]");                    // any 4+ digit run
    kept.push(safe);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseQuickGlance(notes, critical) {
  // Top public-safe one-liners. We deliberately filter out anything
  // looksSensitive() flags so codes never end up on the public glance.
  const candidates = []
    .concat(critical.must_do || [])
    .concat(critical.do_not_do || [])
    .concat(critical.safety_or_emergency || [])
    .concat(critical.customer_preferences || []);
  const firstLine = (splitNonEmptyLines(notes)[0] || "");
  if (firstLine && candidates.indexOf(firstLine) === -1) candidates.unshift(firstLine);
  const publicOnly = candidates.filter(function (l) { return !looksSensitive(l); });
  return Array.from(new Set(publicOnly)).slice(0, 5);
}

// ---------- Split builder ----------
function buildSplitSop(company) {
  const notes      = (company._DPMetaData && company._DPMetaData.AddressObject &&
                       company._DPMetaData.AddressObject.Notes) || "";
  const printAddr  = (company._DPMetaData && company._DPMetaData.AddressObject &&
                       (company._DPMetaData.AddressObject.PrintFull ||
                        company._DPMetaData.AddressObject.Print)) || company.Address || "";

  const access          = parseAccess(notes);
  const critical        = parseCriticalNotes(notes);
  const service_profile = parseServiceProfile(notes);
  const sectionsRaw     = parseSections(notes);

  // ----- Split critical notes into public vs secure -----
  // do_not / must_do lines that look sensitive (contain codes /
  // phone numbers / alarm-flavored words) go to secureInstructions.
  // Everything else stays public.
  const sopDoNot   = [];
  const sopMustDo  = [];
  const secureInstructions = [];
  critical.do_not_do.forEach(function (l) {
    (looksSensitive(l) ? secureInstructions : sopDoNot).push(l);
  });
  critical.must_do.forEach(function (l) {
    (looksSensitive(l) ? secureInstructions : sopMustDo).push(l);
  });

  // Section TASK lines: tasks that look sensitive (rare but possible)
  // are removed from the public sopSections array and added to
  // secureInstructions instead, so the public render is always safe.
  const sections = sectionsRaw.map(function (s) {
    const safe = [];
    (s.tasks || []).forEach(function (t) {
      if (looksSensitive(t)) secureInstructions.push("[" + s.title + "] " + t);
      else                   safe.push(t);
    });
    return { title: s.title, frequency: s.frequency, tasks: safe };
  }).filter(function (s) { return s.tasks.length > 0; });

  // Public catch-all — safety and preferences that don't contain codes.
  const sopPublicNotes = [];
  (critical.safety_or_emergency || []).forEach(function (l) {
    if (!looksSensitive(l)) sopPublicNotes.push(l);
    else                    secureInstructions.push(l);
  });
  (critical.customer_preferences || []).forEach(function (l) {
    if (!looksSensitive(l)) sopPublicNotes.push(l);
    else                    secureInstructions.push(l);
  });
  (service_profile.frequency_notes || []).forEach(function (l) {
    if (!looksSensitive(l) && sopPublicNotes.indexOf(l) === -1) sopPublicNotes.push(l);
  });

  const quickGlance = parseQuickGlance(notes, critical);

  // ----- Status (string) -----
  let sopStatus;
  if (company.Active === false)        sopStatus = "inactive";
  else if (!notes || notes.length < 20) sopStatus = "needs_review";
  else                                  sopStatus = "has_sop";

  const hasSecureSop = !!(
    access.alarm_codes.length || access.door_codes.length ||
    access.gate_codes.length  || access.key_fob_notes.length ||
    access.alarm_company_notes.length || access.emergency_contacts.length ||
    secureInstructions.length ||
    (notes && notes.length > 0)   // raw notes themselves are admin-only
  );

  const nowIso = new Date().toISOString();
  const safeName = String(company.CompanyName || "").trim();

  // ----- Public doc fields (camelCase, flat on customers/{slug}) -----
  // NOTE: sopRawPublicText is the new tech-view source of truth. It's
  // the original Deputy notes with sensitive lines removed and code-
  // shaped patterns redacted. The sectioned arrays (sopQuickGlance,
  // sopSections, sopDoNot, sopMustDo, sopPublicNotes) stay populated
  // for admin-side rendering and back-compat, but the tech view now
  // renders sopRawPublicText as a single readable block.
  const publicFields = {
    sopStatus:        sopStatus,
    sopUpdatedAt:     nowIso,
    sopSource:        "deputy_company_notes (parser deputy-notes-v1)",
    sopRawPublicText: buildPublicRawText(notes),
    sopQuickGlance:   quickGlance,
    sopSections:      sections,
    sopDoNot:         sopDoNot,
    sopMustDo:        sopMustDo,
    sopPublicNotes:   sopPublicNotes,
    hasSecureSop:     hasSecureSop
  };

  // ----- Secure doc fields (camelCase, customer_secure/{slug}) -----
  const secureFields = {
    alarmCodes:          access.alarm_codes,
    doorCodes:           access.door_codes,
    gateCodes:           access.gate_codes,
    keyFobNotes:         access.key_fob_notes,
    alarmCompanyNotes:   access.alarm_company_notes,
    emergencyContacts:   access.emergency_contacts,
    secureInstructions:  Array.from(new Set(secureInstructions)),
    rawDeputyNotes:      String(notes).trim(),
    deputyCompanyId:     Number(company.Id) || 0,
    deputyCompanyName:   safeName,
    deputyCompanyCode:   String(company.Code || "").trim(),
    addressPrint:        printAddr,
    activeInDeputy:      company.Active !== false,
    sourceUpdatedAt:     nowIso,
    parsedAt:            nowIso,
    parserVersion:       "deputy-notes-v1"
  };

  return { public: publicFields, secure: secureFields, hasSecureSop: hasSecureSop };
}

// ---------- Matching ----------
function buildCustomerIndex(customersSnap, aliasesSnap) {
  const byCompanyId = {};
  const byNameKey   = {};
  const all         = [];
  // aliasesBySlug: customer_slug → array of normalized alias keys.
  // Used to confirm a deputy_company_id match when the names look
  // different but admin curated an explicit alias for that mapping.
  const aliasesBySlug = new Map();
  if (aliasesSnap && aliasesSnap.docs) {
    aliasesSnap.docs.forEach(function (d) {
      const a = d.data() || {};
      if (a.active === false) return;
      const slug = String(a.customer_slug || "").trim();
      if (!slug) return;
      const k = a.normalized_alias
                  ? String(a.normalized_alias).toLowerCase().replace(/[^a-z0-9]+/g, "")
                  : normalizeKey(a.alias);
      if (!k) return;
      if (!aliasesBySlug.has(slug)) aliasesBySlug.set(slug, []);
      aliasesBySlug.get(slug).push(k);
    });
  }
  customersSnap.docs.forEach(function (d) {
    const c    = d.data() || {};
    const slug = c.customer_slug || d.id;
    const ref  = {
      slug:               slug,
      customer_name:      c.customer_name || c.name || "",
      active:             c.active !== false,
      deputy_company_id:  c.deputy_company_id != null && c.deputy_company_id !== ""
                            ? c.deputy_company_id
                            : c.deputy_location_id,
      deputy_company_name: String(c.deputy_company_name || "").trim(),
      aliases:            aliasesBySlug.get(slug) || [],
      doc_data:           c
    };
    if (ref.deputy_company_id != null && ref.deputy_company_id !== "") {
      byCompanyId[String(ref.deputy_company_id)] = ref;
    }
    const k = normalizeKey(ref.customer_name);
    if (k && !byNameKey[k]) byNameKey[k] = ref;
    all.push(ref);
  });
  return { byCompanyId: byCompanyId, byNameKey: byNameKey, all: all, aliasesBySlug: aliasesBySlug };
}

// SAFETY GATE: a deputy_company_id match only counts when the
// customer's *real-world* name plausibly refers to the same entity as
// the Deputy CompanyName. "Plausibly the same" requires at least one of
// the two primary signals to fire:
//
//   • Tier 1a (customer_name overlap): customer.customer_name normalized
//     substring-overlaps Deputy CompanyName normalized.
//   • Tier 1b (alias overlap): some /customer_aliases entry under the
//     customer's slug normalizes to (or overlaps) the Deputy name.
//
// The customer's stored deputy_company_name is treated as a SUPPORTING
// signal only — it can strengthen an already-plausible mapping, but it
// can NEVER independently approve a mapping. That's because the field
// is admin-written and can go stale; a stale value silently rubber-
// stamped two wrong mappings on 2026-05-17:
//   - Baker Construction (Deputy id 3) → baker-commodities
//   - Willow & Branch (Deputy id 20) → high-country-property
// Both passed the old gate because the customer doc's stored
// deputy_company_name still pointed at the wrong real-world entity.
//
// Return shape:
//   { aligned: true,  reason: "<which tier fired>" }                — safe
//   { aligned: false, reason: "stale_mapping_stored_name_only" }    — stored
//                                                                     matches
//                                                                     but no
//                                                                     primary
//                                                                     signal
//   { aligned: false, reason: "names_disagree" }                    — nothing
//                                                                     matches
function deputyAndCustomerNamesAlign(deputyName, customerRef) {
  const d = normalizeKey(deputyName);
  if (!d) return { aligned: false, reason: "deputy_name_empty" };

  // Tier 1a — customer_name normalized substring overlap.
  const c = normalizeKey(customerRef.customer_name);
  const nameOverlap = !!(d.length >= 4 && c &&
                         (c.indexOf(d) !== -1 || d.indexOf(c) !== -1));

  // Tier 1b — any alias under /customer_aliases that normalizes to / over-
  // laps Deputy CompanyName.
  let aliasReason = null;
  const aliases = customerRef.aliases || [];
  for (let i = 0; i < aliases.length; i++) {
    const a = aliases[i];
    if (!a) continue;
    if (a === d)                                    { aliasReason = "alias_exact"; break; }
    if (a.length >= 4 && d.indexOf(a) !== -1)       { aliasReason = "alias_in_deputy_name"; break; }
    if (d.length >= 4 && a.indexOf(d) !== -1)       { aliasReason = "alias_contains_deputy_name"; break; }
  }

  // Tier 2 — SUPPORTING ONLY: stored deputy_company_name normalized match.
  const stored = normalizeKey(customerRef.deputy_company_name);
  const storedConfirms = !!(stored && stored === d);

  if (nameOverlap) {
    return {
      aligned: true,
      reason:  storedConfirms ? "name_substring_overlap+stored_confirms"
                              : "name_substring_overlap"
    };
  }
  if (aliasReason) {
    return {
      aligned: true,
      reason:  storedConfirms ? aliasReason + "+stored_confirms"
                              : aliasReason
    };
  }
  // No primary signal. If only the stored field matched, this is a
  // stale-mapping candidate — caller will surface it as
  // STALE_MAPPING_DETECTED when deputy_company_id ALSO matched.
  if (storedConfirms) return { aligned: false, reason: "stale_mapping_stored_name_only" };
  return { aligned: false, reason: "names_disagree" };
}

function matchCustomer(company, ix) {
  const cid = String(company.Id || "");
  // ID-first match — but ONLY if names align. ID alone is not enough.
  if (cid && ix.byCompanyId[cid]) {
    const ref   = ix.byCompanyId[cid];
    const align = deputyAndCustomerNamesAlign(company.CompanyName, ref);
    if (align.aligned) {
      return { ref: ref, reason: "deputy_company_id+" + align.reason, confirmed: true };
    }
    // Two distinct unsafe sub-cases:
    //   A) STALE_MAPPING_DETECTED — the customer's stored
    //      deputy_company_name agrees with Deputy, but the customer's
    //      real name does NOT overlap. That stored field is stale and
    //      must be cleared on the customer doc before re-import.
    //   B) names_disagree — id matches but neither customer_name nor
    //      any alias nor stored deputy_company_name overlaps Deputy.
    //      Plain risky-id-match.
    const isStale = align.reason === "stale_mapping_stored_name_only";
    return {
      ref:       ref,
      reason:    isStale ? "STALE_MAPPING_DETECTED" : "deputy_company_id_name_disagrees",
      confirmed: false,
      stale:     isStale,
      block_reason: isStale
        ? ("STALE_MAPPING_DETECTED: customers/" + ref.slug +
           " has deputy_company_id=" + cid +
           " AND stored deputy_company_name='" + ref.deputy_company_name +
           "' both pointing at Deputy '" + company.CompanyName +
           "', but the customer's actual name '" + ref.customer_name +
           "' does not overlap. The stored deputy_company_name is " +
           "stale — clear it (and probably deputy_company_id) on " +
           "customers/" + ref.slug + " before re-importing, or add an " +
           "explicit alias if these two truly are the same entity.")
        : ("deputy_company_id matches customer '" + ref.customer_name +
           "' but Deputy CompanyName '" + company.CompanyName +
           "' does not align (no customer_name overlap, no /customer_aliases hit). " +
           "Either fix customers/" + ref.slug + ".deputy_company_id or add an alias.")
    };
  }
  // Plain normalized-name match — safe because name is the same key.
  const nk = normalizeKey(company.CompanyName);
  if (nk && ix.byNameKey[nk]) {
    return { ref: ix.byNameKey[nk], reason: "name_normalized", confirmed: true };
  }
  return null;
}

// ---------- Firestore connect (lazy) ----------
let db = null;
async function ensureFirestore() {
  if (db) return db;
  if (!admin) {
    console.error("\nfirebase-admin is not installed. Run:");
    console.error("  cd functions && npm install firebase-admin");
    console.error("or install it at the repo root, then re-run.\n");
    process.exit(1);
  }
  // Friendly credentials check. Two valid paths:
  //   A) GOOGLE_APPLICATION_CREDENTIALS env var points to a real file.
  //   B) Application Default Credentials are already configured locally
  //      (e.g. `gcloud auth application-default login`). We don't try
  //      to detect (B) directly — we let admin.initializeApp() attempt
  //      it and catch any failure with a clear, actionable message.
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (credPath) {
    if (!fs.existsSync(credPath)) {
      console.error("\nGOOGLE_APPLICATION_CREDENTIALS is set but the file does not exist:");
      console.error("  path: " + credPath);
      console.error("\nFix one of:");
      console.error("  • export GOOGLE_APPLICATION_CREDENTIALS=/correct/path/to/service-account.json");
      console.error("  • unset GOOGLE_APPLICATION_CREDENTIALS  (and rely on gcloud ADC)");
      console.error("  • gcloud auth application-default login\n");
      process.exit(1);
    }
    console.log("Credentials      : GOOGLE_APPLICATION_CREDENTIALS file present (contents not logged).");
  } else {
    console.log("Credentials      : GOOGLE_APPLICATION_CREDENTIALS not set; trying application default credentials.");
    console.log("                   If this fails, run `gcloud auth application-default login` or set the env var.");
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
    db = admin.firestore();
  } catch (err) {
    console.error("\nFirebase Admin failed to initialize.");
    console.error("  reason: " + (err && err.message || err));
    console.error("\nFix one of:");
    console.error("  • export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json");
    console.error("  • gcloud auth application-default login\n");
    process.exit(1);
  }
  return db;
}

// ---------- Seed loader ----------
// Accepts either:
//   A) a top-level JSON ARRAY of Deputy Company objects, OR
//   B) a JSON WRAPPER object with .raw (array) or .summary (array).
function loadSeed(seedPath) {
  if (!fs.existsSync(seedPath)) {
    console.error("Seed file not found: " + seedPath);
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")); }
  catch (err) {
    console.error("Couldn't parse seed JSON: " + err.message);
    process.exit(1);
  }
  if (Array.isArray(parsed)) {
    return { companies: parsed, shape: "array" };
  }
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.raw))     return { companies: parsed.raw,     shape: "wrapper(raw)" };
    if (Array.isArray(parsed.summary)) return { companies: parsed.summary, shape: "wrapper(summary)" };
  }
  console.error("Seed file must be a JSON array of Deputy Company objects, " +
                "or a wrapper object with `.raw` or `.summary` array.");
  process.exit(1);
}

// ---------- Verification checklist ----------
function printVerificationChecklist() {
  console.log("\n============ VERIFICATION CHECKLIST ============");
  console.log("Run these checks before --write to production:\n");
  console.log("  1. firestore.rules has /customer_secure/{id} admin-only block:");
  console.log("       grep -A2 'match /customer_secure' firestore.rules");
  console.log("");
  console.log("  2. As a SIGNED-IN TECH (not admin), in the browser console:");
  console.log("       firebase.firestore().collection(\"customer_secure\").doc(\"<slug>\").get()");
  console.log("     → must return permission-denied.");
  console.log("");
  console.log("  3. As a SIGNED-IN ADMIN:");
  console.log("       firebase.firestore().collection(\"customer_secure\").doc(\"<slug>\").get()");
  console.log("     → must succeed.");
  console.log("");
  console.log("  4. Confirm DCR submit payload never references secure fields:");
  console.log("       grep -n 'alarmCodes\\|doorCodes\\|gateCodes\\|emergencyContacts\\|rawDeputyNotes\\|secureInstructions' functions/index.js");
  console.log("     → expect NO hits inside submitDcrV1 / buildZapierPayload.");
  console.log("");
  console.log("  5. Confirm no tech HTML/JS file references secure fields:");
  console.log("       grep -RIn 'alarmCodes\\|doorCodes\\|gateCodes\\|emergencyContacts\\|rawDeputyNotes\\|secureInstructions\\|customer_secure' public/tech.* public/today-work.* public/work.* public/team-hub.* public/index.html");
  console.log("     → expect NO hits.");
  console.log("");
  console.log("  6. Confirm techHubView customer subset has NO secure fields:");
  console.log("       grep -A30 'Customer info (tech-safe subset)' functions/index.js");
  console.log("     → expect ONLY sopStatus / sopQuickGlance / sopSections /");
  console.log("       sopDoNot / sopMustDo / sopPublicNotes / hasSecureSop /");
  console.log("       sopUpdatedAt / sopSource (no codes, no contacts, no raw).");
  console.log("=================================================\n");
}

// ---------- Main ----------
async function main() {
  console.log("Customer SOP seed — mode: " + MODE.toUpperCase());
  console.log("Seed file: " + SEED_FILE);

  const seed = loadSeed(SEED_FILE);
  const companies = seed.companies;
  console.log("Seed shape       : " + seed.shape);
  console.log("Loaded " + companies.length + " company entr" + (companies.length === 1 ? "y" : "ies") + " from seed.");

  const fs_db = await ensureFirestore();
  console.log("Reading /customers from Firestore…");
  const custSnap = await fs_db.collection("customers").get();
  let aliasesSnap = null;
  try {
    aliasesSnap = await fs_db.collection("customer_aliases").get();
  } catch (_e) { /* collection may not exist; alias check just skips */ }
  const ix = buildCustomerIndex(custSnap, aliasesSnap);
  console.log("Loaded " + ix.all.length + " customers; " +
              (aliasesSnap ? aliasesSnap.size : 0) + " alias docs.");

  const report = {
    parsed:           0,
    matched:          [],
    skipped_internal: [],
    skipped_placeholder: [],
    inactive_in_deputy:  [],
    needs_review:        [],
    blocked_id_name_disagrees: [],
    stale_mappings:      [],
    duplicate_conflicts: [],
    write_errors:        []
  };

  // ---------- Pass 1: classify every Deputy company ----------
  // No writes happen in this pass. We collect all confirmed matches in
  // `pendingWrites` so a Pass-2 duplicate-target scan can remove any
  // slug that two Deputy companies both resolved to BEFORE a single
  // Firestore write happens.
  const pendingWrites = [];

  for (const company of companies) {
    if (!company || typeof company !== "object") continue;
    if (String(company.CompanyName || "") === "__placeholder__") {
      report.skipped_placeholder.push({ id: company.Id, name: company.CompanyName });
      continue;
    }
    if (ONLY_COMP && String(company.Id) !== ONLY_COMP) continue;

    if (isInternalSkip(company.CompanyName)) {
      report.skipped_internal.push({ id: company.Id, name: company.CompanyName });
      continue;
    }

    const m = matchCustomer(company, ix);
    if (!m) {
      report.needs_review.push({
        id:   company.Id,
        name: company.CompanyName,
        reason: "no Pioneer customer match (set customers.deputy_company_id or align customer_name first)"
      });
      continue;
    }
    if (!m.confirmed) {
      // ID matched but names don't plausibly align — BLOCKED for safety.
      // Stale-mapping (stored deputy_company_name agrees with Deputy but
      // customer's real name disagrees) goes to its own bucket so admin
      // can find and clear the stale stored field.
      const blockEntry = {
        deputy_id:          company.Id,
        deputy_name:        company.CompanyName,
        customer_slug:      m.ref.slug,
        customer_name:      m.ref.customer_name,
        stored_deputy_name: m.ref.deputy_company_name || "",
        block_reason:       m.block_reason
      };
      if (m.stale) report.stale_mappings.push(blockEntry);
      else         report.blocked_id_name_disagrees.push(blockEntry);
      continue;
    }
    if (ONLY_CUST && m.ref.slug !== ONLY_CUST) continue;

    const split = buildSplitSop(company);
    pendingWrites.push({ company: company, match: m, split: split });
  }

  // ---------- Pass 2: duplicate-target conflict detection ----------
  // Two or more Deputy companies pointing at the same Pioneer customer
  // slug is never safe — the second write would overwrite the first and
  // the wrong customer's secure codes could land on the survivor's
  // customer_secure doc. Drop ALL conflicting entries (not just the
  // duplicates) so admin disambiguates explicitly.
  const slugCounts = {};
  pendingWrites.forEach(function (p) {
    slugCounts[p.match.ref.slug] = (slugCounts[p.match.ref.slug] || 0) + 1;
  });
  const conflictSlugs = new Set(Object.keys(slugCounts).filter(function (s) {
    return slugCounts[s] > 1;
  }));
  const safeWrites = [];
  pendingWrites.forEach(function (p) {
    if (conflictSlugs.has(p.match.ref.slug)) {
      report.duplicate_conflicts.push({
        deputy_id:     p.company.Id,
        deputy_name:   p.company.CompanyName,
        customer_slug: p.match.ref.slug,
        match_via:     p.match.reason,
        block_reason:  "DUPLICATE_TARGET_CONFLICT: Pioneer customer slug '" +
                       p.match.ref.slug + "' is the resolution target for " +
                       slugCounts[p.match.ref.slug] + " Deputy companies. " +
                       "Disambiguate the customer mapping (usually clear the " +
                       "wrong deputy_company_id / deputy_company_name on one " +
                       "of the customer docs, or split into separate " +
                       "customers) before re-running."
      });
    } else {
      safeWrites.push(p);
    }
  });

  // ---------- Pass 3: record summary + write surviving safe matches ----------
  for (const p of safeWrites) {
    const company = p.company;
    const m       = p.match;
    const split   = p.split;

    report.parsed += 1;
    report.matched.push({
      deputy_id:        company.Id,
      deputy_name:      company.CompanyName,
      customer_slug:    m.ref.slug,
      match_via:        m.reason,
      pub: {
        sopStatus:        split.public.sopStatus,
        quickGlance:      split.public.sopQuickGlance.length,
        sections:         split.public.sopSections.length,
        doNot:            split.public.sopDoNot.length,
        mustDo:           split.public.sopMustDo.length,
        publicNotes:      split.public.sopPublicNotes.length,
        rawPublicChars:   String(split.public.sopRawPublicText || "").length,
        hasSecureSop:     split.public.hasSecureSop
      },
      sec: {
        alarmCodes:        split.secure.alarmCodes.length,
        doorCodes:         split.secure.doorCodes.length,
        gateCodes:         split.secure.gateCodes.length,
        keyFobNotes:       split.secure.keyFobNotes.length,
        alarmCompanyNotes: split.secure.alarmCompanyNotes.length,
        emergencyContacts: split.secure.emergencyContacts.length,
        secureInstructions:split.secure.secureInstructions.length,
        rawNotesChars:     split.secure.rawDeputyNotes.length
      },
      pioneer_customer_active: m.ref.active
    });

    if (split.public.sopStatus === "inactive") {
      report.inactive_in_deputy.push({
        id:   company.Id,
        name: company.CompanyName,
        slug: m.ref.slug
      });
    }

    if (VERBOSE) {
      console.log("\n----- " + company.CompanyName + " → " + m.ref.slug + " (" + m.reason + ") -----");
      console.log("  PUBLIC (would write to customers/" + m.ref.slug + "):");
      console.log("    sopStatus:      " + split.public.sopStatus);
      console.log("    sopQuickGlance: " + split.public.sopQuickGlance.length + " items");
      console.log("    sopSections:    " + split.public.sopSections.map(function (s) { return s.title; }).join(", "));
      console.log("    sopDoNot:       " + split.public.sopDoNot.length);
      console.log("    sopMustDo:      " + split.public.sopMustDo.length);
      console.log("    sopPublicNotes: " + split.public.sopPublicNotes.length);
      console.log("    sopRawPublicText: " + String(split.public.sopRawPublicText || "").length + " chars");
      console.log("    hasSecureSop:   " + split.public.hasSecureSop);
      console.log("  SECURE (would write to customer_secure/" + m.ref.slug + "):");
      console.log("    alarmCodes:         " + split.secure.alarmCodes.length);
      console.log("    doorCodes:          " + split.secure.doorCodes.length);
      console.log("    gateCodes:          " + split.secure.gateCodes.length);
      console.log("    keyFobNotes:        " + split.secure.keyFobNotes.length);
      console.log("    alarmCompanyNotes:  " + split.secure.alarmCompanyNotes.length);
      console.log("    emergencyContacts:  " + split.secure.emergencyContacts.length);
      console.log("    secureInstructions: " + split.secure.secureInstructions.length);
      console.log("    rawDeputyNotes:     " + split.secure.rawDeputyNotes.length + " chars");
    }

    if (MODE === "write") {
      try {
        await fs_db.collection("customers").doc(m.ref.slug).set(split.public, { merge: true });
        if (split.public.hasSecureSop) {
          await fs_db.collection("customer_secure").doc(m.ref.slug).set(split.secure, { merge: false });
        } else {
          // No sensitive data found — delete any prior customer_secure
          // doc so stale codes don't linger.
          try { await fs_db.collection("customer_secure").doc(m.ref.slug).delete(); }
          catch (_e) { /* swallow — doc may not exist */ }
        }
        if (VERBOSE) console.log("  WROTE customers/" + m.ref.slug + " and customer_secure/" + m.ref.slug);
      } catch (err) {
        report.write_errors.push({ slug: m.ref.slug, error: err.message });
      }
    }
  }

  // ---------- Diagnose mode (extra context) ----------
  if (DIAGNOSE) {
    const withNotes = companies.filter(function (c) {
      return c && c._DPMetaData && c._DPMetaData.AddressObject &&
             String(c._DPMetaData.AddressObject.Notes || "").trim().length > 0;
    }).length;
    let customersWithCompanyId = 0;
    ix.all.forEach(function (c) {
      if (c.deputy_company_id != null && c.deputy_company_id !== "") customersWithCompanyId += 1;
    });
    console.log("\n========== DIAGNOSE ==========");
    console.log("Seed file path    : " + SEED_FILE);
    console.log("Seed shape        : " + seed.shape);
    console.log("Raw company count : " + companies.length);
    console.log("  • with notes    : " + withNotes);
    console.log("  • without notes : " + (companies.length - withNotes));
    console.log("Pioneer customers loaded : " + ix.all.length);
    console.log("  • with deputy_company_id : " + customersWithCompanyId);
    console.log("  • with at least one alias: " + ix.aliasesBySlug.size);
    console.log("Matching fields available on customer docs:");
    console.log("  • customer_slug, customer_name, deputy_company_id,");
    console.log("    deputy_company_name, /customer_aliases entries.");
    console.log("Safety gate active : deputy_company_id match REQUIRES a PRIMARY");
    console.log("                      signal — customer_name overlap OR a");
    console.log("                      /customer_aliases entry overlap with the");
    console.log("                      Deputy CompanyName. Stored deputy_company_name");
    console.log("                      is SUPPORTING ONLY (never approves alone).");
    console.log("Stale-mapping       : id+stored agree but customer_name disagrees →");
    console.log("                      STALE_MAPPING_DETECTED, blocked.");
    console.log("Duplicate target    : two Deputy companies → one Pioneer slug →");
    console.log("                      DUPLICATE_TARGET_CONFLICT, both blocked.");
    console.log("Strict mode         : " + (STRICT ? "ENABLED (non-zero exit on any issue)"
                                                    : "off (use --strict to enforce)"));
    console.log("==============================");
  }

  // ---------- Summary ----------
  console.log("\n========== SUMMARY ==========");
  console.log("Mode                  : " + MODE.toUpperCase() + (STRICT ? " (--strict)" : ""));
  console.log("Parsed companies      : " + report.parsed);
  console.log("SAFE matches          : " + report.matched.length);
  console.log("Skipped internal      : " + report.skipped_internal.length);
  console.log("Skipped placeholder   : " + report.skipped_placeholder.length);
  console.log("Inactive in Deputy    : " + report.inactive_in_deputy.length);
  console.log("Needs manual review   : " + report.needs_review.length);
  console.log("Risky matches blocked : " + report.blocked_id_name_disagrees.length);
  console.log("Stale mappings        : " + report.stale_mappings.length);
  console.log("Duplicate conflicts   : " + report.duplicate_conflicts.length);
  console.log("Write errors          : " + report.write_errors.length);

  if (report.skipped_internal.length) {
    console.log("\n-- Skipped (internal/non-customer) --");
    report.skipped_internal.forEach(function (s) { console.log("  • " + s.name + " (id " + s.id + ")"); });
  }
  if (report.inactive_in_deputy.length) {
    console.log("\n-- Inactive in Deputy --");
    report.inactive_in_deputy.forEach(function (s) { console.log("  • " + s.name + " → " + s.slug); });
  }

  console.log("\n========== SAFE MATCHES (" + report.matched.length + ") ==========");
  if (report.matched.length === 0) {
    console.log("  (none)");
  } else {
    report.matched.forEach(function (m) {
      console.log("  ✓ " + m.deputy_name + " → " + m.customer_slug +
                  " (via " + m.match_via + ")");
      console.log("       public  : quickGlance=" + m.pub.quickGlance +
                  "  sections=" + m.pub.sections +
                  "  doNot=" + m.pub.doNot +
                  "  mustDo=" + m.pub.mustDo +
                  "  publicNotes=" + m.pub.publicNotes +
                  "  rawPublic=" + m.pub.rawPublicChars + "ch" +
                  "  status=" + m.pub.sopStatus +
                  "  hasSecureSop=" + m.pub.hasSecureSop);
      console.log("       secure  : alarm=" + m.sec.alarmCodes +
                  "  door=" + m.sec.doorCodes +
                  "  gate=" + m.sec.gateCodes +
                  "  fob=" + m.sec.keyFobNotes +
                  "  alarmCo=" + m.sec.alarmCompanyNotes +
                  "  emergency=" + m.sec.emergencyContacts +
                  "  secInstr=" + m.sec.secureInstructions +
                  "  rawChars=" + m.sec.rawNotesChars +
                  (m.pioneer_customer_active ? "" : "  ⚠ Pioneer customer INACTIVE"));
    });
  }

  console.log("\n========== RISKY MATCHES BLOCKED (" + report.blocked_id_name_disagrees.length + ") ==========");
  if (report.blocked_id_name_disagrees.length === 0) {
    console.log("  (none)");
  } else {
    report.blocked_id_name_disagrees.forEach(function (b) {
      console.log("  ⛔ Deputy '" + b.deputy_name + "' (id " + b.deputy_id + ")");
      console.log("       → customers/" + b.customer_slug + " ('" + b.customer_name + "')");
      console.log("       BLOCKED: " + b.block_reason);
    });
    console.log("\n  How to resolve:");
    console.log("    1. Open Firestore console → customers/{slug} for each above.");
    console.log("    2. Either clear the stale deputy_company_id field, OR");
    console.log("    3. Add an alias in /customer_aliases that maps the Deputy");
    console.log("       CompanyName to the right Pioneer customer.");
    console.log("    4. Re-run --dry-run; the blocked entries should clear.");
  }

  console.log("\n========== STALE CUSTOMER MAPPINGS (" + report.stale_mappings.length + ") ==========");
  if (report.stale_mappings.length === 0) {
    console.log("  (none)");
  } else {
    report.stale_mappings.forEach(function (s) {
      console.log("  ⚠️  STALE_MAPPING_DETECTED");
      console.log("       Deputy : '" + s.deputy_name + "' (id " + s.deputy_id + ")");
      console.log("       Customer: customers/" + s.customer_slug +
                  " (name='" + s.customer_name + "'," +
                  " stored deputy_company_name='" + s.stored_deputy_name + "')");
      console.log("       BLOCKED: " + s.block_reason);
    });
    console.log("\n  How to resolve a stale mapping:");
    console.log("    1. Open Firestore console → customers/" + (report.stale_mappings[0] && report.stale_mappings[0].customer_slug || "<slug>") + " for each entry above.");
    console.log("    2. Clear the deputy_company_name field (it's the stale signal).");
    console.log("    3. Clear deputy_company_id unless you're sure that ID is correct.");
    console.log("    4. If these two entities really are the same customer, add an");
    console.log("       explicit /customer_aliases doc with the Deputy CompanyName.");
    console.log("    5. Re-run --dry-run; stale entries should clear.");
  }

  console.log("\n========== DUPLICATE TARGET CONFLICTS (" + report.duplicate_conflicts.length + ") ==========");
  if (report.duplicate_conflicts.length === 0) {
    console.log("  (none)");
  } else {
    // Group by slug for readability.
    const bySlug = {};
    report.duplicate_conflicts.forEach(function (d) {
      (bySlug[d.customer_slug] = bySlug[d.customer_slug] || []).push(d);
    });
    Object.keys(bySlug).forEach(function (slug) {
      console.log("  ⛔ DUPLICATE_TARGET_CONFLICT on customers/" + slug);
      bySlug[slug].forEach(function (d) {
        console.log("       • Deputy '" + d.deputy_name + "' (id " + d.deputy_id +
                    ", via " + d.match_via + ")");
      });
    });
    console.log("\n  How to resolve a duplicate target:");
    console.log("    1. Decide which Deputy company really maps to this Pioneer slug.");
    console.log("    2. On the OTHER customer doc(s), clear deputy_company_id and");
    console.log("       deputy_company_name so they no longer resolve here.");
    console.log("    3. Either map the loser(s) to a different Pioneer customer slug");
    console.log("       (set deputy_company_id there) or create a new customer doc.");
    console.log("    4. Re-run --dry-run; duplicate entries should clear.");
  }

  console.log("\n========== NEEDS MANUAL REVIEW (" + report.needs_review.length + ") ==========");
  if (report.needs_review.length === 0) {
    console.log("  (none)");
  } else {
    report.needs_review.forEach(function (s) {
      console.log("  • " + s.name + " (id " + s.id + ") — " + s.reason);
    });
  }

  if (report.write_errors.length) {
    console.log("\n========== WRITE ERRORS (" + report.write_errors.length + ") ==========");
    report.write_errors.forEach(function (e) { console.log("  ✗ " + e.slug + ": " + e.error); });
  }

  console.log("\n=============================");
  if (MODE === "dry-run") {
    console.log("DRY RUN: no Firestore writes were made.");
    console.log("To commit, re-run with --write.");
  } else {
    console.log("WRITE: " + (report.matched.length - report.write_errors.length) +
                " customers/* AND customer_secure/* doc pairs updated.");
  }

  // ---------- Strict mode enforcement ----------
  // Any risky/stale/duplicate/write_error in strict mode → non-zero exit.
  // This prevents an accidental future `--write --strict` from running
  // against an unsafe dataset and lets CI / shell scripts fail loudly.
  if (STRICT) {
    const issueCount =
      report.blocked_id_name_disagrees.length +
      report.stale_mappings.length          +
      report.duplicate_conflicts.length     +
      report.write_errors.length;
    if (issueCount > 0) {
      console.log("\n❌ STRICT MODE FAILED: " + issueCount + " unresolved issue(s).");
      console.log("   (" + report.blocked_id_name_disagrees.length + " risky, " +
                            report.stale_mappings.length + " stale, " +
                            report.duplicate_conflicts.length + " duplicate, " +
                            report.write_errors.length + " write errors)");
      console.log("   Production --write is BLOCKED until the customer docs above are cleaned up.");
      // Print verification checklist before exiting so admin still sees it.
      printVerificationChecklist();
      process.exit(2);
    } else {
      console.log("\n✅ STRICT MODE PASSED: no risky / stale / duplicate / write-error issues.");
      console.log("   Safe to proceed to --write.");
    }
  }

  // Final block: print the human verification checklist.
  printVerificationChecklist();
}

main().catch(function (err) {
  console.error("FATAL:", err);
  process.exit(1);
});
