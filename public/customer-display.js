/* Pioneer DCR Hub — canonical customer display-name helper.
 *
 * One function, used by every surface that shows a customer label to a
 * human (DCR dropdown, Today's Work cards, Team Hub schedule, Team
 * Schedule list/coverage/assignments, Customer Info, Yesterday's Work,
 * DCR email, tokenized customer report).
 *
 * Schema (new optional fields on /customers/{slug}):
 *   displayNameMode      "customerName" | "locationName" | "customAlias"
 *   customDisplayName    string (only honored when mode === "customAlias")
 *
 * Priority ladder:
 *   1. customDisplayName  — when mode === "customAlias" AND value is set
 *   2. location_name      — when mode === "locationName"  (camelCase + snake)
 *   3. customer_name      — default; covers mode === "customerName" or unset
 *   4. slug               — final fallback only (id-shaped, last resort)
 *
 * Accepts ANY shape carrying customer name-ish fields:
 *   • /customers/{slug} doc (snake_case + camelCase variants)
 *   • published_team_schedule snapshot rows (camelCase)
 *   • deputy_shift_cache rows (snake_case)
 *
 * NEVER touches:  customer_slug, deputy_company_id, deputy_location_id,
 * deputy_shift_id, submission_id, pioneer_session_id.
 *
 * Pure read. Returns "" only when the input is null/undefined or has no
 * recognizable name-bearing fields.
 */
(function () {
  "use strict";

  function pickCustomerName(c) {
    return String(
      c.customer_name  ||
      c.customerName   ||
      c.name           ||
      ""
    ).trim();
  }
  function pickLocationName(c) {
    return String(
      c.location_name  ||
      c.locationName   ||
      ""
    ).trim();
  }
  function pickCustomAlias(c) {
    return String(
      c.customDisplayName   ||
      c.custom_display_name ||
      ""
    ).trim();
  }
  function pickSlug(c) {
    return String(
      c.customer_slug ||
      c.customerSlug  ||
      c.slug          ||
      c.id            ||
      ""
    ).trim();
  }

  function getCustomerDisplayName(customer) {
    if (!customer) return "";
    const mode = String(customer.displayNameMode || customer.display_name_mode || "").trim();
    if (mode === "customAlias") {
      const alias = pickCustomAlias(customer);
      if (alias) return alias;
    }
    if (mode === "locationName") {
      return pickLocationName(customer) || pickCustomerName(customer) || pickSlug(customer) || "";
    }
    // mode === "customerName" OR unset OR unknown → customer_name first
    return pickCustomerName(customer) || pickLocationName(customer) || pickSlug(customer) || "";
  }

  if (typeof window !== "undefined") {
    window.PioneerCustomerDisplay = {
      getCustomerDisplayName: getCustomerDisplayName,
      // exported for tests / unit checks
      _pickCustomerName:  pickCustomerName,
      _pickLocationName:  pickLocationName,
      _pickCustomAlias:   pickCustomAlias,
      _pickSlug:          pickSlug
    };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      getCustomerDisplayName: getCustomerDisplayName
    };
  }
})();
