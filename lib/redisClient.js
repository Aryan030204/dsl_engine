// Lazy, shared Redis connection for read-only cache lookups (REDIS_URI, e.g. rediss://... for a
// cloud instance with TLS). Nothing connects at require time, and every command has a short
// timeout so an unreachable Redis costs a few seconds, never a hung run.
const Redis = require('ioredis');

const CONNECT_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 3000;

let client = null;
let clientUri = null;

function getRedisUri(env = process.env) {
  const uri = String(env.REDIS_URI || '').trim();
  return uri || null;
}

function getRedisClient(env = process.env) {
  const uri = getRedisUri(env);
  if (!uri) return null;

  if (client && clientUri === uri) return client;
  if (client) {
    client.disconnect();
    client = null;
  }

  client = new Redis(uri, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Fail fast instead of reconnecting in the background forever.
    retryStrategy: () => null
  });
  // Without a listener an unreachable server would crash the process with an unhandled 'error'.
  client.on('error', () => {});
  clientUri = uri;
  return client;
}

async function closeRedis() {
  if (!client) return;
  const closing = client;
  client = null;
  clientUri = null;
  try {
    await closing.quit();
  } catch {
    closing.disconnect();
  }
}

module.exports = { getRedisClient, getRedisUri, closeRedis };
