/* Pioneer DCR Hub — server-side customer display-name helper.
 *
 * Twin of public/customer-display.js. Used by every server surface that
 * renders a customer name to a human (DCR customer email, tokenized
 * customer report).
 *
 * Keep the priority + accepted shapes IN SYNC with the frontend helper.
 *
 *   1. customer.displayNameMode === "customAlias" → customDisplayName
 *   2. customer.displayNameMode === "locationName" → location_name
 *   3. default → customer_name (snake) / customerName (camel) / name
 *   4. final fallback → slug
 */

function pickCustomerName(c) {
  return String(c.customer_name || c.customerName || c.name || "").trim();
}
function pickLocationName(c) {
  return String(c.location_name || c.locationName || "").trim();
}
function pickCustomAlias(c) {
  return String(c.customDisplayName || c.custom_display_name || "").trim();
}
function pickSlug(c) {
  return String(c.customer_slug || c.customerSlug || c.slug || c.id || "").trim();
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
  return pickCustomerName(customer) || pickLocationName(customer) || pickSlug(customer) || "";
}

module.exports = {
  getCustomerDisplayName: getCustomerDisplayName,
  _internal: {
    pickCustomerName:  pickCustomerName,
    pickLocationName:  pickLocationName,
    pickCustomAlias:   pickCustomAlias,
    pickSlug:          pickSlug
  }
};
