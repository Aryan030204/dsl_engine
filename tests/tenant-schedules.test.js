const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const Tenant = require('../server/models/Tenant');
const WorkflowSchedule = require('../server/models/WorkflowSchedule');

// Runs the real tenants router against stubbed models.
async function withTenantApi(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: 'admin', tenantIds: [] }; next(); });
  app.use('/tenants', require('../server/routes/tenants'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/tenants`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const originals = { findOne: Tenant.findOne, find: WorkflowSchedule.find, updateOne: WorkflowSchedule.updateOne };
  try {
    return await fn(call);
  } finally {
    Tenant.findOne = originals.findOne;
    WorkflowSchedule.find = originals.find;
    WorkflowSchedule.updateOne = originals.updateOne;
    await new Promise((resolve) => server.close(resolve));
  }
}

// a schedule as it sits in the database today: it carries a retired overlapPolicy, so saving it as a whole
// document would fail validation ("`replace_running` is not a valid enum value")
const legacySchedule = (id, timezone) => ({
  _id: id,
  tenantId: 'AJMAL',
  cronExpr: '0 0 * * *',
  timezone,
  overlapPolicy: 'replace_running',
  async save() { throw new Error('WorkflowSchedule validation failed: overlapPolicy: `replace_running` is not a valid enum value'); },
});

function setup({ schedules }) {
  const tenant = { tenantId: 'AJMAL', settings: { currency: 'INR', timezone: 'Asia/Kolkata' }, async save() { return this; } };
  const finds = [];
  const updates = [];
  Tenant.findOne = async () => tenant;
  WorkflowSchedule.find = async (filter) => {
    finds.push(filter);
    // behave like the database for the timezone filter
    return schedules.filter((s) => s.tenantId === filter.tenantId && s.timezone !== filter.timezone.$ne);
  };
  WorkflowSchedule.updateOne = async (filter, update) => { updates.push({ filter, update }); return { acknowledged: true }; };
  return { tenant, finds, updates };
}

test('saving the Shopify store no longer fails because of old schedule data (the error from the Settings page)', async () => {
  await withTenantApi(async (call) => {
    const schedules = [legacySchedule('a', 'Asia/Kolkata'), legacySchedule('b', 'Asia/Kolkata')];
    const { tenant, updates } = setup({ schedules });
    // the Settings page sends the whole settings object, timezone included, with every save
    const res = await call('PATCH', '/AJMAL', { settings: { currency: 'INR', timezone: 'Asia/Kolkata', shopifyDomain: 'ajmal-perfumes-india.myshopify.com' } });
    assert.equal(res.status, 200);
    assert.equal(tenant.settings.shopifyDomain, 'ajmal-perfumes-india.myshopify.com');
    assert.deepEqual(updates, [], 'schedules already on the tenant timezone are left alone');
  });
});

test('changing the timezone re-times only the schedules on another timezone, without re-saving them whole', async () => {
  await withTenantApi(async (call) => {
    const schedules = [legacySchedule('a', 'UTC'), legacySchedule('b', 'Asia/Tokyo'), legacySchedule('c', 'Asia/Kolkata')];
    const { tenant, finds, updates } = setup({ schedules });
    const res = await call('PATCH', '/AJMAL', { settings: { timezone: 'Asia/Kolkata' } });
    assert.equal(res.status, 200);
    assert.equal(tenant.settings.timezone, 'Asia/Kolkata');
    assert.deepEqual(finds, [{ tenantId: 'AJMAL', timezone: { $ne: 'Asia/Kolkata' } }], 'only this tenant, only schedules on another timezone');
    assert.deepEqual(updates.map((u) => u.filter._id).sort(), ['a', 'b']);
    for (const { update } of updates) {
      assert.deepEqual(Object.keys(update.$set).sort(), ['nextRunAt', 'timezone'], 'only these two fields are written');
      assert.equal(update.$set.timezone, 'Asia/Kolkata');
      assert.ok(update.$set.nextRunAt instanceof Date && update.$set.nextRunAt > new Date());
    }
  });
});

test('an invalid timezone is refused and no schedule is touched', async () => {
  await withTenantApi(async (call) => {
    const { updates, finds } = setup({ schedules: [legacySchedule('a', 'UTC')] });
    const res = await call('PATCH', '/AJMAL', { settings: { timezone: 'Mars/Olympus' } });
    assert.equal(res.status, 400);
    assert.deepEqual(updates, []);
    assert.deepEqual(finds, []);
  });
});

test('settings saved without a timezone never look at schedules at all', async () => {
  await withTenantApi(async (call) => {
    const { updates, finds } = setup({ schedules: [legacySchedule('a', 'UTC')] });
    const res = await call('PATCH', '/AJMAL', { settings: { currency: 'USD' } });
    assert.equal(res.status, 200);
    assert.deepEqual(finds, []);
    assert.deepEqual(updates, []);
  });
});
