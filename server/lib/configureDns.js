const dns = require('dns');
require('dotenv').config();

// Node's resolver can end up pointing at a dead local 127.0.0.1 stub, which breaks the mongodb+srv lookup,
// so the resolvers are set explicitly. Some networks block public DNS (8.8.8.8 / 1.1.1.1) but answer SRV
// lookups through their own router: set DNS_SERVERS in .env (comma separated, tried in order) for those.
const DEFAULT_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

function configureDns() {
  const configured = String(process.env.DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  dns.setServers(configured.length ? configured : DEFAULT_DNS_SERVERS);
  return dns.getServers();
}

module.exports = { configureDns };
