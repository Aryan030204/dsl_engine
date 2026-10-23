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

// A query that outlives this limit is killed by MySQL itself (max_execution_time, SELECT only),
// so an abandoned or runaway workflow query cannot keep running and pile up on the server.
// DB_QUERY_TIMEOUT_MS=0 disables it. Queries slower than DB_SLOW_QUERY_MS are logged.
function readMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
const QUERY_TIMEOUT_MS = readMs('DB_QUERY_TIMEOUT_MS', 180000);
const SLOW_QUERY_MS = readMs('DB_SLOW_QUERY_MS', 5000);

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

  if (QUERY_TIMEOUT_MS > 0) {
    pool.pool.on('connection', (connection) => {
      connection.query(`SET SESSION max_execution_time = ${QUERY_TIMEOUT_MS}`, (err) => {
        if (err) console.warn(`[QueryExecutor] could not set max_execution_time: ${err.message}`);
      });
    });
  }

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
    const label = `tenant=${tenantId} type=${querySpec.meta?.type || 'query'}${querySpec.meta?.dimension ? ` dimension=${querySpec.meta.dimension}` : ''}`;
    const startedAt = Date.now();

    try {
      // The client-side timeout is only a backstop (e.g. a hung connection); MySQL enforces the real limit.
      const [rows] = await pool.query(
        { sql: querySpec.sql, timeout: QUERY_TIMEOUT_MS > 0 ? QUERY_TIMEOUT_MS + 5000 : undefined },
        params
      );
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SLOW_QUERY_MS) {
        console.warn(`[QueryExecutor] slow query ${label} ${elapsed}ms rows=${rows.length}`);
      }
      return { rows };
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      const timedOut = error?.errno === 3024 || error?.code === 'ER_QUERY_TIMEOUT' || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
      console.warn(`[QueryExecutor] query failed ${label} after ${elapsed}ms: ${error.message}`);
      if (timedOut) {
        const timeoutError = new Error(`Query timed out after ${Math.round(QUERY_TIMEOUT_MS / 1000)}s (${label}). The database is slow or overloaded.`);
        timeoutError.code = 'QUERY_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    }
  }
};
