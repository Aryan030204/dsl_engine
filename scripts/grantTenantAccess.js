// Usage: node scripts/grantTenantAccess.js <email> [--admin] [TENANT_ID ...]
// Sets a user's role to admin and/or adds tenants they may access.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../server/models/User');

async function main() {
  const [email, ...rest] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node scripts/grantTenantAccess.js <email> [--admin] [TENANT_ID ...]');
    process.exit(1);
  }
  const makeAdmin = rest.includes('--admin');
  const tenantIds = rest.filter((arg) => arg !== '--admin').map((id) => id.toUpperCase());

  await mongoose.connect(process.env.MONGO_URI);
  const update = { $addToSet: { tenantIds: { $each: tenantIds } } };
  if (makeAdmin) update.$set = { role: 'admin' };
  const user = await User.findOneAndUpdate({ email: email.toLowerCase() }, update, { new: true });
  console.log(user ? `Updated ${user.email}: role=${user.role} tenants=${user.tenantIds.join(',')}` : 'User not found');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
