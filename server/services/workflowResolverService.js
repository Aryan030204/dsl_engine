const Workflow = require('../models/Workflow');
const WorkflowVersion = require('../models/WorkflowVersion');

function workflowNotFoundError(message = 'workflow not found') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function workflowVersionNotFoundError(message = 'workflow version not found') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function workflowInactiveError(message = 'workflow is inactive') {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function scopeMismatchError(message = 'workflow scope mismatch') {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function buildVersionScopeClause(scope) {
  return scope === 'global'
    ? { scope: 'global' }
    : { $or: [{ scope: 'tenant' }, { scope: { $exists: false } }] };
}

function buildTenantWorkflowQuery(tenantId, workflowId) {
  return {
    workflowId,
    $or: [
      { tenantIds: tenantId },
      { tenantId }
    ],
    $and: [
      { $or: [{ scope: 'tenant' }, { scope: { $exists: false } }] }
    ]
  };
}

function getWorkflowTenantIds(workflow = {}) {
  if (Array.isArray(workflow.tenantIds) && workflow.tenantIds.length) {
    return workflow.tenantIds;
  }
  return workflow.tenantId ? [workflow.tenantId] : [];
}

// The tenantId stored on a workflow's version rows. The unique index (tenantId, workflowId, version) makes this
// the "namespace" a version number must be unique in.
//   - A workflow document that has its own tenantId is a per-tenant copy: older "create for selected tenants"
//     runs made one document per tenant that all share ONE workflowId. Each copy keeps its own history under
//     its own tenantId; with null here, the copies would share a single numbering space and a save of
//     version 1.3 for one tenant would collide with another tenant's 1.3 (and could never be fixed by reloading).
//   - A document with no tenantId (one document for one or many tenants, with its own unique workflowId)
//     stores null, as before.
function getVersionTenantId(workflow = {}) {
  if (workflow.tenantId) return workflow.tenantId;
  return null;
}

function buildWorkflowVersionQuery(workflow = {}, workflowId, version) {
  const scope = workflow.scope || 'tenant';
  const query = {
    workflowId,
    ...buildVersionScopeClause(scope),
  };

  if (version !== undefined && version !== null) {
    query.version = version;
  }

  if (scope === 'global') {
    query.tenantId = null;
    return query;
  }

  const tenantIds = getWorkflowTenantIds(workflow);
  if (tenantIds.length) {
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { tenantIds: { $in: tenantIds } },
          { tenantId: { $in: tenantIds } }
        ]
      }
    ];
    return query;
  }

  query.tenantId = getVersionTenantId(workflow);
  return query;
}

function normalizeWorkflowIdentity(workflow, versionId) {
  const scope = workflow.scope || 'tenant';
  const tenantIds = getWorkflowTenantIds(workflow);
  const tenantScope = scope === 'global' ? 'global' : (workflow.tenantId || tenantIds.join(',') || 'tenant');
  return `${tenantScope}/${workflow.workflowId}@${versionId}`;
}

async function resolveWorkflowRecord({
  tenantId,
  workflowId,
  preferredScope,
  allowGlobalFallback = true,
  allowedScopes = ['tenant', 'global'],
}) {
  if (!workflowId) {
    throw workflowNotFoundError('workflowId is required');
  }

  const canUseTenant = allowedScopes.includes('tenant');
  const canUseGlobal = allowedScopes.includes('global');

  let workflow = null;

  if (preferredScope) {
    if (!allowedScopes.includes(preferredScope)) {
      throw scopeMismatchError(`workflow scope '${preferredScope}' is not allowed`);
    }
    if (preferredScope === 'tenant') {
      workflow = canUseTenant ? await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId)).lean() : null;
    } else if (preferredScope === 'global') {
      workflow = canUseGlobal
        ? await Workflow.findOne({ scope: 'global', tenantId: null, workflowId }).lean()
        : null;
    }
    if (!workflow) {
      throw workflowNotFoundError();
    }
  } else {
    if (canUseTenant) {
      workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId)).lean();
    }
    if (!workflow && allowGlobalFallback && canUseGlobal) {
      workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId }).lean();
    }
    if (!workflow) {
      throw workflowNotFoundError();
    }
  }

  if (!workflow.isActive) {
    throw workflowInactiveError();
  }

  return workflow;
}

async function resolveWorkflowVersion({
  tenantId,
  workflowId,
  version,
  preferredScope,
  allowGlobalFallback = true,
  allowedScopes = ['tenant', 'global'],
}) {
  const workflow = await resolveWorkflowRecord({
    tenantId,
    workflowId,
    preferredScope,
    allowGlobalFallback,
    allowedScopes,
  });

  const versionId = version || workflow.latestVersion;
  const workflowVersion = await WorkflowVersion.findOne(
    buildWorkflowVersionQuery(workflow, workflowId, versionId)
  ).lean();

  if (!workflowVersion) {
    throw workflowVersionNotFoundError();
  }

  return {
    workflow,
    workflowVersion,
    versionId,
    identity: normalizeWorkflowIdentity(workflow, versionId),
  };
}

async function resolveWorkflowReference({ tenantId, ref }) {
  const workflowId = ref?.workflow_id;
  const version = ref?.version;
  const preferredScope = ref?.scope;

  if (!workflowId) {
    const err = new Error('workflow_ref.ref.workflow_id is required');
    err.status = 400;
    throw err;
  }

  if (!version) {
    const err = new Error('workflow_ref.ref.version is required');
    err.status = 400;
    throw err;
  }

  return resolveWorkflowVersion({
    tenantId,
    workflowId,
    version,
    preferredScope,
    allowGlobalFallback: preferredScope !== 'tenant',
    allowedScopes: ['tenant', 'global'],
  });
}

module.exports = {
  resolveWorkflowVersion,
  resolveWorkflowReference,
  normalizeWorkflowIdentity,
  buildTenantWorkflowQuery,
  buildWorkflowVersionQuery,
  getWorkflowTenantIds,
  getVersionTenantId,
};
