import { useState, useEffect, useMemo } from 'react';
import { X, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUpdateWorkflow, useWorkflow, useCreateWorkflowVersion, useUpdateGlobalWorkflow, useCreateGlobalWorkflowVersion, useTenants } from '../api/hooks';
import { useTenant } from '../context/TenantContext';
import { Button } from './ui';

export default function EditWorkflowModal({ workflow, onClose }) {
  const { data: workflowData } = useWorkflow(workflow.workflowId);
  const updateWorkflow = useUpdateWorkflow(workflow.workflowId);
  const updateGlobalWorkflow = useUpdateGlobalWorkflow(workflow.workflowId);
  const createVersion = useCreateWorkflowVersion(workflow.workflowId);
  const createGlobalVersion = useCreateGlobalWorkflowVersion(workflow.workflowId);
  const isGlobal = workflow.scope === 'global';
  const { tenantId } = useTenant();
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants();
  const currentTenantIds = Array.isArray(workflow.tenantIds) && workflow.tenantIds.length
    ? workflow.tenantIds
    : (workflow.tenantId ? [workflow.tenantId] : []);
  const initialScope = isGlobal ? 'global' : (currentTenantIds.length > 1 ? 'multiple' : 'single');
  const [scope, setScope] = useState(initialScope); // 'single' | 'multiple' | 'global'
  const [selectedTenantIds, setSelectedTenantIds] = useState(
    isGlobal ? (tenantId ? [tenantId] : []) : currentTenantIds
  );
  const tenantOptions = useMemo(() => (
    (Array.isArray(tenants) ? tenants : []).filter((tenant) => tenant?.tenantId).map((tenant) => tenant.tenantId).sort()
  ), [tenants]);
  const toggleTenant = (id) => setSelectedTenantIds((prev) => (
    prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
  ));
  const scopeChanged = scope !== initialScope
    || (scope !== 'global' && [...selectedTenantIds].sort().join(',') !== [...currentTenantIds].sort().join(','));

  const [mode, setMode] = useState('metadata'); // 'metadata' or 'definition'
  const [formData, setFormData] = useState({
    name: workflow.name || '',
    isActive: workflow.isActive ?? true,
  });
  
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState(null);

  useEffect(() => {
    if (workflowData?.version?.definitionJson) {
      setJsonInput(JSON.stringify(workflowData.version.definitionJson, null, 2));
    }
  }, [workflowData]);

  const handleMetadataSubmit = async (e) => {
    e.preventDefault();

    if (scopeChanged && scope !== 'global' && !selectedTenantIds.length) {
      toast.error('Select at least one tenant');
      return;
    }
    if (scopeChanged && scope === 'single' && selectedTenantIds.length !== 1) {
      toast.error('Choose exactly one tenant for a single-tenant workflow');
      return;
    }

    try {
      const updates = { name: formData.name, isActive: formData.isActive };
      if (scopeChanged) {
        updates.scope = scope;
        if (scope !== 'global') updates.tenantIds = selectedTenantIds;
      }
      if (isGlobal) {
        await updateGlobalWorkflow.mutateAsync(updates);
      } else {
        await updateWorkflow.mutateAsync(updates);
      }
      toast.success('Workflow updated successfully');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update workflow');
    }
  };

  const handleDefinitionSubmit = async (e) => {
    e.preventDefault();

    try {
      const definition = JSON.parse(jsonInput);
      setJsonError(null);

      // Increment version
      const currentVersion = workflowData?.version?.definitionJson?.version || '1.0';
      const versionParts = currentVersion.split('.');
      const newVersion = `${versionParts[0]}.${parseInt(versionParts[1] || 0) + 1}`;
      
      definition.version = newVersion;

      if (isGlobal) {
        await createGlobalVersion.mutateAsync(definition);
      } else {
        await createVersion.mutateAsync(definition);
      }
      toast.success(`New version ${newVersion} created successfully`);
      onClose();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setJsonError('Invalid JSON format');
      } else {
        toast.error(err.response?.data?.errors?.join(', ') || err.response?.data?.error || 'Failed to update workflow definition');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Edit Workflow: {workflow.workflowId}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Mode Toggle */}
        <div className="px-6 pt-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('metadata')}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                mode === 'metadata'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Metadata
            </button>
            <button
              type="button"
              onClick={() => setMode('definition')}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                mode === 'definition'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Definition (New Version)
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {mode === 'metadata' ? (
            <form onSubmit={handleMetadataSubmit} id="edit-form">
              <div className="px-6 py-4 space-y-4">
                {/* Workflow ID (read-only) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Workflow ID
                  </label>
                  <input
                    type="text"
                    value={workflow.workflowId}
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Workflow ID cannot be changed
                  </p>
                </div>

                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="Friendly name for the workflow"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>

                {/* Status */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Status
                  </label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="status"
                        checked={formData.isActive}
                        onChange={() => setFormData({ ...formData, isActive: true })}
                        className="w-4 h-4 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm">Active</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="status"
                        checked={!formData.isActive}
                        onChange={() => setFormData({ ...formData, isActive: false })}
                        className="w-4 h-4 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm">Inactive</span>
                    </label>
                  </div>
                </div>

                {/* Scope */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="text-sm font-medium text-gray-700 mb-3">Workflow Scope</div>
                  <div className="grid gap-2">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="workflow-scope"
                        checked={scope === 'single'}
                        onChange={() => {
                          setScope('single');
                          setSelectedTenantIds((prev) => (prev.length === 1 ? prev : (tenantId ? [tenantId] : [])));
                        }}
                      />
                      Current tenant ({selectedTenantIds.length === 1 ? selectedTenantIds[0] : (tenantId || 'None')})
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="workflow-scope"
                        checked={scope === 'multiple'}
                        onChange={() => setScope('multiple')}
                      />
                      Selected tenants
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="workflow-scope"
                        checked={scope === 'global'}
                        onChange={() => setScope('global')}
                      />
                      Global (all tenants)
                    </label>
                  </div>

                  {scope === 'multiple' && (
                    <div className="mt-4">
                      <div className="text-xs text-gray-500 mb-2">Select tenants</div>
                      <div className="max-h-40 overflow-auto border border-gray-200 rounded-lg bg-white">
                        {tenantsLoading ? (
                          <div className="px-3 py-2 text-sm text-gray-500">Loading tenants...</div>
                        ) : tenantOptions.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-gray-500">No tenants available</div>
                        ) : (
                          tenantOptions.map((id) => (
                            <label key={id} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                              <input type="checkbox" checked={selectedTenantIds.includes(id)} onChange={() => toggleTenant(id)} />
                              {id}
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {scopeChanged && (
                    <p className="mt-3 text-xs text-amber-700">
                      Saving will change which tenants this workflow runs for, including all its versions and its trigger brands.
                    </p>
                  )}
                </div>

                {/* Current Version Info */}
                <div className="bg-gray-50 p-3 rounded-lg text-sm">
                  <p className="text-gray-600">
                    <span className="font-medium">Current Version:</span> v{workflow.latestVersion}
                  </p>
                  <p className="text-gray-500 text-xs mt-1">
                    To update the workflow definition, switch to the "Definition" tab
                  </p>
                </div>
              </div>
            </form>
          ) : (
            <form onSubmit={handleDefinitionSubmit} id="edit-form">
              <div className="px-6 py-4">
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                  <p className="text-sm text-yellow-800">
                    <strong>Note:</strong> Editing the definition will create a new version. 
                    Current version: v{workflowData?.workflow?.latestVersion || workflow.latestVersion}
                  </p>
                </div>
                
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Workflow Definition (JSON)
                </label>
                <textarea
                  value={jsonInput}
                  onChange={(e) => {
                    setJsonInput(e.target.value);
                    setJsonError(null);
                  }}
                  className={`w-full h-80 px-3 py-2 font-mono text-sm border rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${
                    jsonError ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder="Loading workflow definition..."
                />
                {jsonError && (
                  <p className="text-sm text-red-500 mt-1">{jsonError}</p>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-form"
            loading={updateWorkflow.isPending || createVersion.isPending}
          >
            <Save className="w-4 h-4 mr-2" />
            {mode === 'metadata' ? 'Save Changes' : 'Create New Version'}
          </Button>
        </div>
      </div>
    </div>
  );
}
