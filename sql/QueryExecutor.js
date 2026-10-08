// sql/QueryExecutor.js
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const dns = require('node:dns');

dns.setDefaultResultOrder('ipv4first');

const pools = new Map();

// Verify the server certificate by default (system CAs, or DB_SSL_CA_PATH for a private CA
// such as the RDS bundle). Disabling verification must be an explicit opt-out.
function buildSslConfig() {
  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath) {
    return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }
  if (process.env.DB_SSL_INSECURE === 'true') {
    console.warn('[QueryExecutor] DB_SSL_INSECURE=true: MySQL TLS certificate is NOT verified');
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const sslConfig = buildSslConfig();

// The tenant ID is used as the MySQL database name, so only plain identifiers are accepted,
// and the number of live pools is capped so arbitrary IDs can't exhaust connections.
const TENANT_DB_NAME = /^[A-Za-z0-9_]{1,64}$/;
const MAX_POOLS = Number(process.env.DB_MAX_TENANT_POOLS) || 100;

function getPool(dbName) {
  if (!dbName) throw new Error('QueryExecutor: tenantId/dbName is required');

  if (typeof dbName !== 'string' || !TENANT_DB_NAME.test(dbName)) {
    throw new Error('QueryExecutor: invalid tenantId/dbName');
  }

  if (pools.has(dbName)) {
    // Refresh recency so eviction below drops the least recently used pool.
    const existing = pools.get(dbName);
    pools.delete(dbName);
    pools.set(dbName, existing);
    return existing;
  }

  if (pools.size >= MAX_POOLS) {
    const [oldestName, oldestPool] = pools.entries().next().value;
    pools.delete(oldestName);
    oldestPool.end().catch(() => {});
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,
    ssl: sslConfig,
    decimalNumbers: true,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  pools.set(dbName, pool);
  return pool;
}

module.exports = {
  async execute(querySpec) {
    if (!querySpec?.sql) {
      throw new Error('QueryExecutor.execute: querySpec.sql is required');
    }

    const tenantId = querySpec.meta?.tenantId;
    if (!tenantId) {
      throw new Error('QueryExecutor.execute: querySpec.meta.tenantId is required');
    }

    const pool = getPool(tenantId);
    const params = querySpec.params || [];

    const [rows] = await pool.query(querySpec.sql, params);
    return { rows };
  }
};
