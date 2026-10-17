// Top-selling products for the inventory report, read from the Redis cache that is already
// populated per Shopify store: `inventory_top_product_sales:<shop>.myshopify.com` holds
//   { window_start_date, window_end_date_exclusive, updated_at,
//     products: [{ product_id, product_title, sales, rank, source_rows: [...] }] }
// ranked by 7-day sales revenue. Anything unusable throws a TopProductsCacheError with a short
// `reason`, which the inventory node turns into a fallback to the DB ranking query.
const { getRedisClient } = require('../../lib/redisClient');

const KEY_PREFIX = 'inventory_top_product_sales:';
const DEFAULT_MAX_AGE_HOURS = 36;

class TopProductsCacheError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'TopProductsCacheError';
    this.reason = reason;
  }
}

function cacheKey(shopDomain) {
  return `${KEY_PREFIX}${shopDomain}`;
}

function maxAgeMs(env = process.env) {
  const hours = Number(env.INVENTORY_CACHE_MAX_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_AGE_HOURS) * 60 * 60 * 1000;
}

function classifyRedisError(error) {
  const message = String(error?.message || error);
  if (/timed? ?out|timeout/i.test(message)) return new TopProductsCacheError('timeout', message);
  return new TopProductsCacheError('connect_failed', message);
}

// Pure: turns the cached JSON string into the ranked product list, or throws. Exported for tests.
function parseTopProducts(raw, { topK = 50, now = new Date(), maxAge = maxAgeMs() } = {}) {
  if (raw == null) throw new TopProductsCacheError('key_missing');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new TopProductsCacheError('bad_payload', 'not valid JSON');
  }
  if (!payload || !Array.isArray(payload.products)) {
    throw new TopProductsCacheError('bad_payload', 'missing products array');
  }

  const updatedAt = payload.updated_at ? new Date(payload.updated_at) : null;
  if (updatedAt && !Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() > maxAge) {
    throw new TopProductsCacheError('stale', `updated ${updatedAt.toISOString()}`);
  }

  const products = [];
  const seen = new Set();
  for (const entry of payload.products) {
    const productId = entry?.product_id == null ? '' : String(entry.product_id).trim();
    const rank = Number(entry?.rank);
    if (!productId || !Number.isFinite(rank)) {
      throw new TopProductsCacheError('bad_payload', 'product without product_id or rank');
    }
    if (seen.has(productId)) continue;
    seen.add(productId);
    products.push({
      product_id: productId,
      product_title: entry.product_title || null,
      rank,
      sales: Number.isFinite(Number(entry.sales)) ? Number(entry.sales) : null
    });
  }
  if (!products.length) throw new TopProductsCacheError('empty');

  products.sort((a, b) => a.rank - b.rank);
  const limit = Math.max(1, Math.floor(Number(topK) || 50));
  return {
    products: products.slice(0, limit),
    updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toISOString() : null,
    windowStart: payload.window_start_date || null,
    windowEnd: payload.window_end_date_exclusive || null
  };
}

// redis is injectable so tests never touch the network.
async function getTopProducts({ shopDomain, topK = 50, redis, now = new Date(), env = process.env } = {}) {
  if (!shopDomain) throw new TopProductsCacheError('no_shop_domain');

  const client = redis || getRedisClient(env);
  if (!client) throw new TopProductsCacheError('no_redis_uri');

  let raw;
  try {
    // The shared client is lazy and has no offline queue, so connect explicitly first.
    if (client.status === 'wait' && typeof client.connect === 'function') await client.connect();
    raw = await client.get(cacheKey(shopDomain));
  } catch (error) {
    throw classifyRedisError(error);
  }
  return parseTopProducts(raw, { topK, now, maxAge: maxAgeMs(env) });
}

module.exports = { getTopProducts, parseTopProducts, TopProductsCacheError, cacheKey };
