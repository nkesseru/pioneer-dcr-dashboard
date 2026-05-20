/* Pioneer DCR Hub — form config (vanilla JS, no build step).
 * Exposes window.DCR_FORM_CONFIG for use by index.html / app.js.
 * Replace the *_PLACEHOLDERS arrays once Firestore is seeded with real
 * customers / techs; everything else (checklist, problems, etc.) is
 * authoritative for Phase 1.
 */
(function () {
  "use strict";

  // ⚠ NOT USED IN PRODUCTION since the live-Firestore dropdown rollout.
  // The form now fetches customers from the `customers` collection at boot
  // (filtered to active && dcr_enabled, sorted by location_name || customer_name).
  // These arrays remain as a data-shape reference for offline dev and for
  // anyone seeding a brand-new `customers` collection by hand. Edit them
  // freely — the running form will not see the change.
  const CUSTOMER_OPTIONS_PLACEHOLDERS = [
    {
      slug: "acme-dental",
      name: "Acme Dental — Riverside",
      location_name: "Acme Dental — Riverside",
      email: "",
      review_links: { five_star_url: "", issue_url: "" }
    },
    {
      slug: "northgate-medical",
      name: "Northgate Medical Plaza",
      location_name: "Northgate Medical Plaza",
      email: "",
      review_links: { five_star_url: "", issue_url: "" }
    },
    {
      slug: "pioneer-hq",
      name: "Pioneer HQ (internal test)",
      location_name: "Pioneer HQ",
      email: "",
      review_links: { five_star_url: "", issue_url: "" }
    }
  ];

  const CLEANING_TECH_PLACEHOLDERS = [
    { slug: "maria-g",   display_name: "Maria G.",   experience_level: "lead"     },
    { slug: "david-r",   display_name: "David R.",   experience_level: "standard" },
    { slug: "trainee-1", display_name: "Trainee #1", experience_level: "trainee"  }
  ];

  const CHECKLIST_SECTIONS = [
    {
      id: "bathrooms",
      label: "Bathrooms",
      items: [
        { id: "toilets-cleaned",        label: "Toilets cleaned & disinfected" },
        { id: "mirrors-streak",         label: "Mirrors streak-free" },
        { id: "tp-restocked",           label: "Toilet paper restocked" },
        { id: "soap-restocked",         label: "Soap restocked" },
        { id: "paper-towels",           label: "Paper towels restocked" },
        { id: "bathroom-floors",        label: "Floors swept & mopped" },
        { id: "bathroom-trash",         label: "Trash emptied & relined" }
      ]
    },
    {
      id: "general-areas",
      label: "General Areas",
      items: [
        { id: "vacuumed",               label: "Carpets vacuumed" },
        { id: "hard-floors",            label: "Hard floors swept & mopped" },
        { id: "high-low-dusting",       label: "High & low dusting" },
        { id: "glass-touchpoints",      label: "Glass / touchpoints wiped" },
        { id: "trash-general",          label: "Trash emptied & relined" }
      ]
    },
    {
      id: "kitchen-cafeteria-break",
      label: "Kitchens / Break Rooms",
      items: [
        { id: "counters-wiped",         label: "Counters wiped & sanitized" },
        { id: "sinks-cleaned",          label: "Sinks cleaned" },
        { id: "appliance-fronts",       label: "Appliance fronts wiped" },
        { id: "tables-chairs",          label: "Tables & chairs wiped" },
        { id: "kitchen-floor",          label: "Floor swept & mopped" },
        { id: "kitchen-trash",          label: "Trash emptied & relined" }
      ]
    },
    {
      id: "offices",
      label: "Offices",
      items: [
        { id: "desks-dusted",           label: "Desks dusted (per customer policy)" },
        { id: "trash-offices",          label: "Office trash emptied" },
        { id: "vacuum-offices",         label: "Office floors vacuumed" },
        { id: "office-touchpoints",     label: "Touchpoints wiped" }
      ]
    },
    {
      id: "entry-vestibules",
      label: "Entryways",
      items: [
        { id: "entry-glass",            label: "Entry glass / doors cleaned" },
        { id: "entry-swept",            label: "Entry / vestibule swept" },
        { id: "entry-mats",             label: "Mats vacuumed / shaken out" },
        { id: "entry-cobwebs",          label: "Cobwebs removed" },
        { id: "entry-trash",            label: "Exterior trash policed" }
      ]
    }
  ];

  const PROBLEM_CATEGORIES = [
    { id: "plumbing",   label: "Plumbing" },
    { id: "equipment",  label: "Equipment / appliance" },
    { id: "safety",     label: "Safety hazard" },
    { id: "access",     label: "Access / lock / alarm" },
    { id: "vandalism",  label: "Vandalism / damage" },
    { id: "supplies",   label: "Out of supplies" },
    { id: "other",      label: "Other" }
  ];

  const PROBLEM_TIERS = [
    { id: "tier_1", label: "Tier 1 — Minor (log only)" },
    { id: "tier_2", label: "Tier 2 — Moderate (notify account manager)" },
    { id: "tier_3", label: "Tier 3 — Critical (notify customer immediately)" }
  ];

  // Tech skill level — used to denormalize on submissions for escalation weighting.
  const EXPERIENCE_LEVELS = [
    { id: "trainee",    label: "Trainee" },
    { id: "standard",   label: "Standard" },
    { id: "lead",       label: "Lead" },
    { id: "supervisor", label: "Supervisor" }
  ];

  // How TODAY'S CLEAN went, from the tech's perspective. Distinct from skill level.
  const EXPERIENCE_RATINGS = [
    { id: "excellent",  label: "Excellent" },
    { id: "good",       label: "Good" },
    { id: "okay",       label: "Okay" },
    { id: "difficult",  label: "Difficult / need help" }
  ];

  const OCCUPANCY_OPTIONS = [
    { id: "empty",       label: "Empty (no occupants)" },
    { id: "light",       label: "Light occupancy" },
    { id: "normal",      label: "Normal occupancy" },
    { id: "heavy",       label: "Heavy occupancy" },
    { id: "after-event", label: "After event / unusual mess" }
  ];

  const BUDGET_REASON_GROUPS = {
    over_budget_due_to: [
      { id: "extra-mess",     label: "Extra mess / spill" },
      { id: "event-cleanup",  label: "After-event cleanup" },
      { id: "supplies-issue", label: "Supplies / equipment issue" },
      { id: "access-delay",   label: "Access / lockout delay" },
      { id: "training",       label: "Training another tech" },
      // V6 pilot — supportive freeform option. Picking "other" reveals
      // an optional note field on the form. The note is OPTIONAL — we
      // don't gate submission on it. Goal is to surface scope creep
      // early without making the tech feel interrogated.
      { id: "other",          label: "Other — leave a note" }
    ],
    under_budget_due_to: [
      { id: "light-occupancy", label: "Light occupancy" },
      { id: "site-closed",     label: "Site partially closed" },
      { id: "scope-reduced",   label: "Customer reduced scope" }
    ]
  };

  window.DCR_FORM_CONFIG = Object.freeze({
    customer_options_placeholders: CUSTOMER_OPTIONS_PLACEHOLDERS,
    cleaning_tech_placeholders:    CLEANING_TECH_PLACEHOLDERS,
    checklist_sections:            CHECKLIST_SECTIONS,
    problem_categories:            PROBLEM_CATEGORIES,
    problem_tiers:                 PROBLEM_TIERS,
    experience_levels:             EXPERIENCE_LEVELS,
    experience_ratings:            EXPERIENCE_RATINGS,
    occupancy_options:             OCCUPANCY_OPTIONS,
    budget_reason_groups:          BUDGET_REASON_GROUPS,
    max_photos:                    12
  });
})();
