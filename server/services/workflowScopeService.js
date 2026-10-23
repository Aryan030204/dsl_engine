const Tenant = require('../models/Tenant');
const WorkflowVersion = require('../models/WorkflowVersion');
const { buildWorkflowVersionQuery } = require('./workflowResolverService');

const SCOPE_CHOICES = ['single', 'multiple', 'global'];

function scopeError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Validates a requested scope change and returns the fields to store.
// `scope` is what the UI offers: 'single' | 'multiple' | 'global'.
async function resolveScopeChange({ scope, tenantIds }) {
  if (!SCOPE_CHOICES.includes(scope)) {
    throw scopeError(`scope must be one of: ${SCOPE_CHOICES.join(', ')}`);
  }
  if (scope === 'global') {
    return { scope: 'global', tenantId: null, tenantIds: [], brandScope: 'global', brandIds: [] };
  }

  const ids = [...new Set((Array.isArray(tenantIds) ? tenantIds : []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw scopeError('select at least one tenant');
  if (scope === 'single' && ids.length !== 1) throw scopeError('a single-tenant workflow needs exactly one tenant');

  const found = await Tenant.find({ tenantId: { $in: ids }, isActive: { $ne: false } }).select('tenantId').lean();
  const known = new Set(found.map((tenant) => tenant.tenantId));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw scopeError(`unknown or inactive tenant(s): ${missing.join(', ')}`);

  return {
    scope: 'tenant',
    tenantId: null,
    tenantIds: ids,
    brandScope: ids.length === 1 ? 'single' : 'multiple',
    brandIds: ids,
  };
}

// Applies the change to the workflow document and every one of its versions, and keeps the
// trigger's brandScope/brandIds in step so the scheduler matches alerts for the new scope.
async function applyScopeChange(workflow, change) {
  const oldVersionFilter = buildWorkflowVersionQuery(workflow, workflow.workflowId);

  await WorkflowVersion.updateMany(oldVersionFilter, {
    $set: {
      scope: change.scope,
      tenantId: change.tenantId,
      tenantIds: change.tenantIds,
      'definitionJson.trigger.brandScope': change.brandScope,
      'definitionJson.trigger.brandIds': change.brandIds,
    },
  });

  workflow.scope = change.scope;
  workflow.tenantId = change.tenantId;
  workflow.tenantIds = change.tenantIds;
  await workflow.save();
  return workflow;
}

module.exports = { resolveScopeChange, applyScopeChange, SCOPE_CHOICES };
