// Reads the per-store "top product sales" ranking that the data pipeline keeps in Redis:
//
//   key   inventory_top_product_sales:<store>.myshopify.com   (STRING, refreshed daily)
//   value { window_start_date, window_end_date_exclusive, updated_at,
//           products: [ { product_id, product_title, sales, rank, source_rows: [ { gross_sales, ... } ] } ] }
//
// The inventory report uses it to pick its top products by sales. It is gift-free and covers a
// 7-day window. Needs REDIS_URI. Anything that stops the ranking from being usable (no URL,
// connection problem, missing/expired key, bad or stale data) throws RedisSalesUnavailableError,
// so the caller can fall back to another ranking.

const KEY_PREFIX = 'inventory_top_product_sales:';
// The pipeline refreshes daily; older than this means it has stopped.
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// The Redis host can be slow to answer (the first read after a restart has taken 8-14s: connect,
// auth, then the read), so the limits are generous. The connection is then kept, so later reads
// are a single round trip (about 1s).
const CONNECT_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUT_MS = 30000;

class RedisSalesUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RedisSalesUnavailableError';
    this.reason = reason;
  }
}

const STORE_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// "https://Acme.myshopify.com/" -> "acme.myshopify.com"; anything that is not a myshopify domain -> ''.
function normalizeStoreDomain(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return STORE_DOMAIN_RE.test(cleaned) ? cleaned : '';
}

let client = null;

function getClient() {
  const uri = process.env.REDIS_URI;
  if (!uri) throw new RedisSalesUnavailableError('REDIS_URI is not configured');
  if (!client) {
    const Redis = require('ioredis');
    client = new Redis(uri, {
      lazyConnect: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      // keep reconnecting (a dropped idle connection should not end the client for good)
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000)
    });
    client.on('error', () => {});
  }
  return client;
}

async function closeRedisSales() {
  const current = client;
  client = null;
  if (current) await current.quit().catch(() => current.disconnect());
}

async function defaultFetchRaw(key) {
  try {
    return await getClient().get(key);
  } catch (error) {
    if (error instanceof RedisSalesUnavailableError) throw error;
    // Drop the connection so the next run starts a fresh one instead of reusing a dead client.
    await closeRedisSales();
    throw new RedisSalesUnavailableError(`could not read Redis (${error.message})`);
  }
}

function toSales(product) {
  const direct = Number(product.sales);
  if (product.sales != null && Number.isFinite(direct)) return direct;
  const rows = Array.isArray(product.source_rows) ? product.source_rows : [];
  return rows.reduce((sum, row) => sum + (Number(row?.gross_sales) || 0), 0);
}

// Validates the stored value and returns the products ranked by sales, highest first.
function parseSalesPayload(raw, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new RedisSalesUnavailableError('the sales data in Redis is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.products)) {
    throw new RedisSalesUnavailableError('the sales data in Redis has an unexpected shape (no products list)');
  }

  const updatedAtMs = payload.updated_at ? Date.parse(payload.updated_at) : NaN;
  if (Number.isFinite(updatedAtMs) && now - updatedAtMs > maxAgeMs) {
    throw new RedisSalesUnavailableError(`the sales data in Redis is stale (last updated ${payload.updated_at})`);
  }

  const seen = new Set();
  const products = [];
  payload.products.forEach((product, index) => {
    const id = String(product?.product_id ?? '').trim();
    // Shopify product ids are numeric; anything else would not match the inventory table anyway.
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) return;
    seen.add(id);
    products.push({
      product_id: id,
      product_title: typeof product.product_title === 'string' ? product.product_title : '',
      sales: toSales(product),
      position: index
    });
  });
  if (!products.length) throw new RedisSalesUnavailableError('the sales data in Redis has no products');

  // Highest sales first; a tie keeps the order the pipeline wrote.
  products.sort((a, b) => (b.sales - a.sales) || (a.position - b.position));
  return {
    products: products.map(({ position, ...product }, index) => ({ ...product, rank: index + 1 })),
    windowStart: payload.window_start_date || null,
    windowEnd: payload.window_end_date_exclusive || null,
    updatedAt: payload.updated_at || null
  };
}

// fetchRaw and now can be replaced in tests.
async function getTopProductSales(storeDomain, { fetchRaw = defaultFetchRaw, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const domain = normalizeStoreDomain(storeDomain);
  if (!domain) {
    throw new RedisSalesUnavailableError('this tenant has no valid Shopify store domain set (Settings)');
  }
  const raw = await fetchRaw(`${KEY_PREFIX}${domain}`);
  if (raw === null || raw === undefined || raw === '') {
    throw new RedisSalesUnavailableError(`no sales data in Redis for ${domain}`);
  }
  return parseSalesPayload(raw, { now, maxAgeMs });
}

module.exports = {
  getTopProductSales,
  parseSalesPayload,
  normalizeStoreDomain,
  closeRedisSales,
  RedisSalesUnavailableError,
  KEY_PREFIX
};
