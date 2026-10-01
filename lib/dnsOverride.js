const dns = require('dns');

// Opt-in DNS override for machines whose local resolver can't resolve MongoDB SRV
// records or other hosts (e.g. DNS_SERVERS=8.8.8.8,1.1.1.1). Off unless set: in
// hosted environments the platform resolver is required for internal hostnames
// (such as a Render-internal RABBITMQ_URL), which public DNS servers can't resolve.
function applyDnsOverride(env = process.env) {
  const servers = String(env.DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (!servers.length) return null;
  dns.setServers(servers);
  console.log('[dns] using DNS_SERVERS override:', dns.getServers().join(', '));
  return servers;
}

module.exports = { applyDnsOverride };
