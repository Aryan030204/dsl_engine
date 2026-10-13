// Option building for the "Import from workflow" dialog, kept free of React so it
// can be unit tested with node --test.

// Active workflows only, sorted by name, ready for a <select>.
export function buildImportWorkflowOptions(workflows) {
  return (Array.isArray(workflows) ? workflows : [])
    .filter((workflow) => workflow?.workflowId && workflow?.isActive !== false)
    .map((workflow) => ({
      workflowId: workflow.workflowId,
      name: workflow.name || workflow.workflowId,
      scope: workflow.scope || 'tenant',
      latestVersion: workflow.latestVersion || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Tenants the signed-in user can see, sorted by id, as { tenantId, label } options.
export function buildImportTenantOptions(tenants) {
  return (Array.isArray(tenants) ? tenants : [])
    .filter((tenant) => tenant?.tenantId)
    .map((tenant) => ({
      tenantId: tenant.tenantId,
      label: tenant.name && tenant.name !== tenant.tenantId
        ? `${tenant.tenantId} — ${tenant.name}`
        : tenant.tenantId,
    }))
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}

// Prefer the tenant being edited; otherwise the first one available.
export function pickInitialImportTenant(options, currentTenantId) {
  if (options.some((option) => option.tenantId === currentTenantId)) return currentTenantId;
  return options[0]?.tenantId || '';
}
