// A tenant's Shopify store domain, e.g. the-man-company.myshopify.com. It is the key under
// which per-store data (like the inventory top-products cache in Redis) is stored.
const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// Returns { ok: true, value } where value is '' for "not set", or { ok: false }.
function normalizeShopifyDomain(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false };
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: true, value: '' };
  return SHOPIFY_DOMAIN_RE.test(value) ? { ok: true, value } : { ok: false };
}

module.exports = { normalizeShopifyDomain, SHOPIFY_DOMAIN_RE };
