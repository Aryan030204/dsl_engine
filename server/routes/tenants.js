const express = require('express');
const Tenant = require('../models/Tenant');
const { requireAdmin } = require('../middleware/auth');
const WorkflowSchedule = require('../models/WorkflowSchedule');
const WorkflowRun = require('../models/WorkflowRun');
const { getNextRunAt } = require('../../scheduler/app/cronUtils');
const { validateEmailBranding } = require('../lib/emailBranding');

// Report emails format money with Intl in this currency, so it must be an ISO 4217
// code Intl accepts (e.g. INR, USD).
function isSupportedCurrency(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isSupportedTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const { normalizeShopifyDomain } = require('../../lib/shopifyDomain');

const router = express.Router();

// List all tenants
router.get('/', async (req, res, next) => {
  try {
    const filter = { isActive: true };
    if (req.user.role !== 'admin') {
      filter.tenantId = { $in: req.user.tenantIds || [] };
    }
    const tenants = await Tenant.find(filter).sort({ name: 1 }).lean();
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

// Get a single tenant
router.get('/:tenantId', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId }).lean();
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

// List recent runs across all workflows for a tenant
router.get('/:tenantId/runs', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 200)
      : 50;

    const runs = await WorkflowRun.find({ tenantId })
      .sort({ startedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ runs });
  } catch (err) {
    next(err);
  }
});

// Create a new tenant
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId, name, description, settings } = req.body;

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    // Check if tenant already exists
    const existing = await Tenant.findOne({ tenantId });
    if (existing) {
      return res.status(409).json({ error: 'Tenant already exists' });
    }

    const resolvedSettings = { ...(settings || {}) };
    if (resolvedSettings.timezone && !isSupportedTimeZone(resolvedSettings.timezone)) {
      return res.status(400).json({ error: 'timezone must be a supported IANA timezone' });
    }
    if (resolvedSettings.currency !== undefined && !isSupportedCurrency(resolvedSettings.currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO currency code, e.g. INR' });
    }
    if (resolvedSettings.shopifyDomain !== undefined) {
      const domain = normalizeShopifyDomain(resolvedSettings.shopifyDomain);
      if (!domain.ok) {
        return res.status(400).json({ error: 'shopifyDomain must look like your-store.myshopify.com' });
      }
      resolvedSettings.shopifyDomain = domain.value;
    }
    const brandingErrors = validateEmailBranding(resolvedSettings.emailBranding, 'settings.emailBranding');
    if (brandingErrors.length) return res.status(400).json({ errors: brandingErrors });

    const tenant = await Tenant.create({
      tenantId: tenantId.toUpperCase(),
      name,
      description,
      settings: resolvedSettings
    });

    res.status(201).json({ tenant });
  } catch (err) {
    next(err);
  }
});

// Update a tenant
router.patch('/:tenantId', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { name, description, isActive, settings } = req.body;

    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    if (name !== undefined) tenant.name = name;
    if (description !== undefined) tenant.description = description;
    if (isActive !== undefined) tenant.isActive = isActive;
    if (settings !== undefined) {
      if (settings.timezone && !isSupportedTimeZone(settings.timezone)) {
        return res.status(400).json({ error: 'timezone must be a supported IANA timezone' });
      }
      if (settings.currency !== undefined && !isSupportedCurrency(settings.currency)) {
        return res.status(400).json({ error: 'currency must be a 3-letter ISO currency code, e.g. INR' });
      }
      if (settings.shopifyDomain !== undefined) {
        const domain = normalizeShopifyDomain(settings.shopifyDomain);
        if (!domain.ok) {
          return res.status(400).json({ error: 'shopifyDomain must look like your-store.myshopify.com' });
        }
        settings.shopifyDomain = domain.value;
      }
      const brandingErrors = validateEmailBranding(settings.emailBranding, 'settings.emailBranding');
      if (brandingErrors.length) return res.status(400).json({ errors: brandingErrors });
      const incomingSettings = { ...settings };
      const currentSettings = tenant.settings?.toObject
        ? tenant.settings.toObject()
        : (tenant.settings || {});
      tenant.settings = {
        ...currentSettings,
        ...incomingSettings,
        ...(incomingSettings.emailBranding !== undefined ? {
          // Treat this as a complete branding form. Merging prevents users
          // from removing a previously configured logo, tagline, or color.
          emailBranding: incomingSettings.emailBranding || {}
        } : {})
      };
    }

    await tenant.save();

    // Keep the tenant's schedules on the tenant's timezone. Only schedules that are on a different
    // timezone are touched, so saving any other setting (the Settings page sends the whole settings
    // object every time) leaves them alone. They are updated field by field instead of re-saved
    // whole, so an unrelated old value on a schedule (e.g. a retired overlapPolicy) cannot make a
    // tenant save fail.
    if (settings?.timezone) {
      const schedules = await WorkflowSchedule.find({ tenantId, timezone: { $ne: settings.timezone } });
      await Promise.all(schedules.map((schedule) => WorkflowSchedule.updateOne(
        { _id: schedule._id },
        { $set: { timezone: settings.timezone, nextRunAt: getNextRunAt(schedule.cronExpr, new Date(), settings.timezone) } }
      )));
    }

    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});

// Delete (deactivate) a tenant
router.delete('/:tenantId', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    tenant.isActive = false;
    await tenant.save();
    res.json({ message: 'Tenant deactivated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
