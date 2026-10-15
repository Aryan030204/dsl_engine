import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCreateGlobalWorkflow, useCreateWorkflowForTenants, useTenants } from '../api/hooks';
import { applyTypedWorkflowName } from '../utils/workflowName';
import { workflowApi } from '../api/endpoints';
import { useTenant } from '../context/TenantContext';
import { Button } from './ui';

const WORKFLOW_TEMPLATE = {
  workflow_type: 'root_cause_analysis',
  description: '',
  version: '1.0',
  trigger: {
    type: 'alert',
    alertType: 'cvr_drop',
    metric: 'cvr',
    condition: {
      operator: '<',
      delta_pct: -15,
    },
    window: {
      type: 'rolling',
      duration: '1h',
    },
  },
  context: {},
  nodes: [
    {
      id: 'data_sanity_check',
      type: 'validation',
      checks: [
        { field: 'sessions', condition: 'current > 0' },
        { field: 'orders', condition: 'current >= 0' },
      ],
      on_fail: {
        action: 'terminate',
        reason: 'Insufficient or invalid data for RCA',
      },
      next: 'metric_decomposition',
    },
    {
      id: 'metric_decomposition',
      type: 'metric_compare',
      metrics: ['orders', 'sessions', 'cvr'],
      next: 'final_insight',
    },
    {
      id: 'final_insight',
      type: 'insight',
      template: 'Analysis complete for {{meta.metric}}',
    },
  ],
};

export default function CreateWorkflowModal({ onClose }) {
  const navigate = useNavigate();
  const { tenantId } = useTenant();
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants();
  const createGlobalWorkflow = useCreateGlobalWorkflow();
  const createWorkflowForTenants = useCreateWorkflowForTenants();
  const [mode, setMode] = useState('form'); // 'form' or 'json'
  const [scope, setScope] = useState('single'); // 'single' | 'multiple' | 'global'
  const [selectedTenantIds, setSelectedTenantIds] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobProgress, setJobProgress] = useState(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    version: '1.0',
    alertType: 'cvr_drop',
    triggerBrandScope: 'auto',
    triggerBrandIds: '',
    metric: 'cvr',
    deltaThreshold: -15,
  });

  const [jsonInput, setJsonInput] = useState(
    JSON.stringify(WORKFLOW_TEMPLATE, null, 2)
  );
  const [jsonError, setJsonError] = useState(null);

  const tenantOptions = useMemo(() => {
    const list = Array.isArray(tenants) ? tenants : [];
    return list
      .filter((tenant) => tenant?.tenantId)
      .map((tenant) => tenant.tenantId)
      .sort();
  }, [tenants]);

  const resolvedTenantIds = useMemo(() => {
    if (scope === 'multiple') return selectedTenantIds;
    return tenantId ? [tenantId] : [];
  }, [scope, selectedTenantIds, tenantId]);

  const toggleTenantSelection = (targetTenantId) => {
    setSelectedTenantIds((prev) => {
      if (prev.includes(targetTenantId)) {
        return prev.filter((id) => id !== targetTenantId);
      }
      return [...prev, targetTenantId];
    });
  };

  const createWorkflowsForTenants = async (definition, tenantIds) => {
    if (!tenantIds.length) {
      toast.error('Select at least one tenant');
      return null;
    }

    setIsSubmitting(true);
    setJobProgress(null);

    try {
      if (tenantIds.length === 1 && tenantIds[0] === tenantId) {
        return await workflowApi.create(tenantId, definition);
      }

      const result = await createWorkflowForTenants.mutateAsync({
        tenantIds,
        definition,
        name: definition.name,
        onProgress: setJobProgress
      });

      if (result.failures?.length) {
        const failedTenantList = result.failures.map((entry) => entry.tenantId).join(', ');
        toast.error(`Failed to create workflow for: ${failedTenantList}`);
      }

      if (!result.successes?.length) {
        return null;
      }

      const successCount = result.successes.length;
      const successLabel = successCount === 1 ? 'tenant' : 'tenant(s)';
      toast.success(`Workflow created for ${successCount} ${successLabel}`);
      return null;
    } finally {
      setIsSubmitting(false);
      setJobProgress(null);
    }
  };

  const createGlobalWorkflowDefinition = async (definition) => {
    setIsSubmitting(true);

    try {
      const result = await createGlobalWorkflow.mutateAsync(definition);
      return result;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      toast.error('Workflow name is required');
      return;
    }

    const effectiveBrandScope = formData.triggerBrandScope === 'auto'
      ? (scope === 'global' ? 'global' : scope === 'multiple' ? 'multiple' : 'single')
      : formData.triggerBrandScope;

    const parsedBrandIds = formData.triggerBrandIds
      .split(',')
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean);

    const autoBrandIds = scope === 'multiple'
      ? selectedTenantIds
      : tenantId
        ? [tenantId]
        : [];

    const triggerBrandIds = effectiveBrandScope === 'global'
      ? []
      : (parsedBrandIds.length ? parsedBrandIds : autoBrandIds);

    const definition = {
      ...WORKFLOW_TEMPLATE,
      // workflow_id will be auto-generated by server
      name: formData.name.trim(),
      description: formData.description.trim(),
      version: formData.version,
      trigger: {
        ...WORKFLOW_TEMPLATE.trigger,
        alertType: formData.alertType.trim(),
        brandScope: effectiveBrandScope,
        brandIds: triggerBrandIds,
        metric: formData.metric,
        condition: {
          operator: '<',
          delta_pct: Number(formData.deltaThreshold),
        },
      },
    };
    
    // Remove template workflow_id
    delete definition.workflow_id;

    try {
      const result = scope === 'global'
        ? await createGlobalWorkflowDefinition(definition)
        : await createWorkflowsForTenants(definition, resolvedTenantIds);
      if (result?.workflow?.workflowId) {
        toast.success('Workflow created successfully');
        onClose();
        navigate(`/workflows/${result.workflow.workflowId}`);
      } else if (result === null) {
        onClose();
      }
    } catch (err) {
      if (err.response?.status === 409 && err.response?.data?.conflicts?.length) {
        const tenantList = err.response.data.conflicts.map((item) => item.tenantId).join(', ');
        toast.error(`Workflow ID already exists for: ${tenantList}`);
      } else {
        toast.error(err.response?.data?.errors?.join(', ') || 'Failed to create workflow');
      }
    }
  };

  const handleJsonSubmit = async (e) => {
    e.preventDefault();

    try {
      // The name typed above the editor replaces the JSON's own "name".
      const definition = applyTypedWorkflowName(JSON.parse(jsonInput), formData.name);
      delete definition.workflow_id;
      setJsonError(null);

      const result = scope === 'global'
        ? await createGlobalWorkflowDefinition(definition)
        : await createWorkflowsForTenants(definition, resolvedTenantIds);
      if (result?.workflow?.workflowId) {
        toast.success('Workflow created successfully');
        onClose();
        navigate(`/workflows/${result.workflow.workflowId}`);
      } else if (result === null) {
        onClose();
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        setJsonError('Invalid JSON format');
      } else if (err.response?.status === 409 && err.response?.data?.conflicts?.length) {
        const tenantList = err.response.data.conflicts.map((item) => item.tenantId).join(', ');
        toast.error(`Workflow ID already exists for: ${tenantList}`);
      } else {
        toast.error(err.response?.data?.errors?.join(', ') || 'Failed to create workflow');
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
          <h2 className="text-lg font-semibold">Create Workflow</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Mode Toggle */}
        <div className="px-6 pt-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('form')}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                mode === 'form'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              Simple Form
            </button>
            <button
              type="button"
              onClick={() => setMode('json')}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                mode === 'json'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              JSON Editor
            </button>
          </div>
        </div>

        {/* Scope */}
        <div className="px-6 pt-4">
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-700 mb-3">Workflow Scope</div>
            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="workflow-scope"
                  value="single"
                  checked={scope === 'single'}
                  onChange={() => setScope('single')}
                />
                Current tenant ({tenantId || 'None'})
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="workflow-scope"
                  value="multiple"
                  checked={scope === 'multiple'}
                  onChange={() => setScope('multiple')}
                />
                Selected tenants
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="workflow-scope"
                  value="global"
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
                    tenantOptions.map((targetTenantId) => (
                      <label
                        key={targetTenantId}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedTenantIds.includes(targetTenantId)}
                          onChange={() => toggleTenantSelection(targetTenantId)}
                        />
                        {targetTenantId}
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            {scope === 'global' && (
              <p className="mt-3 text-xs text-gray-500">
                This will create the workflow for {tenantOptions.length} tenant(s).
              </p>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {mode === 'form' ? (
            <form onSubmit={handleFormSubmit} id="create-form">
              <div className="px-6 py-4 space-y-4">
                {/* Workflow Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Workflow Name *
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="e.g., CVR Drop Analysis"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    required
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) =>
                      setFormData({ ...formData, description: e.target.value })
                    }
                    placeholder="Brief description of the workflow"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>

                {/* Version */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Version
                  </label>
                  <input
                    type="text"
                    value={formData.version}
                    onChange={(e) =>
                      setFormData({ ...formData, version: e.target.value })
                    }
                    placeholder="1.0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>

                {/* Trigger Alert Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Trigger Alert Type *
                  </label>
                  <input
                    type="text"
                    value={formData.alertType}
                    onChange={(e) =>
                      setFormData({ ...formData, alertType: e.target.value })
                    }
                    placeholder="e.g., cvr_drop"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Scheduler matches incoming alerts by this value.
                  </p>
                </div>

                {/* Trigger Brand Scope */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Trigger Brand Scope
                  </label>
                  <select
                    value={formData.triggerBrandScope}
                    onChange={(e) =>
                      setFormData({ ...formData, triggerBrandScope: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="auto">
                      Auto (from workflow scope: {scope === 'global' ? 'global' : scope === 'multiple' ? 'multiple' : 'single'})
                    </option>
                    <option value="single">Single brand</option>
                    <option value="multiple">Multiple brands</option>
                    <option value="global">Global (all brands)</option>
                  </select>
                </div>

                {/* Trigger Brand IDs */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Trigger Brand IDs (optional)
                  </label>
                  <input
                    type="text"
                    value={formData.triggerBrandIds}
                    onChange={(e) =>
                      setFormData({ ...formData, triggerBrandIds: e.target.value })
                    }
                    placeholder="Comma separated, e.g., TMC, ACME"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty to auto-use selected tenant scope.
                  </p>
                </div>

                {/* Trigger Metric */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Trigger Metric
                  </label>
                  <select
                    value={formData.metric}
                    onChange={(e) =>
                      setFormData({ ...formData, metric: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="cvr">CVR (Conversion Rate)</option>
                    <option value="revenue">Revenue</option>
                    <option value="orders">Orders</option>
                    <option value="sessions">Sessions</option>
                  </select>
                </div>

                {/* Delta Threshold */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Delta Threshold (%)
                  </label>
                  <input
                    type="number"
                    value={formData.deltaThreshold}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        deltaThreshold: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Negative value triggers when metric drops below threshold
                  </p>
                </div>

                <div className="bg-gray-50 p-3 rounded-lg text-sm text-gray-600">
                  <p className="font-medium mb-1">💡 Tip</p>
                  <p>
                    This creates a basic workflow template. You can add more
                    nodes and configure advanced settings by editing the workflow
                    after creation.
                  </p>
                </div>
              </div>
            </form>
          ) : (
            <form onSubmit={handleJsonSubmit} id="create-form">
              <div className="px-6 py-4">
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Workflow Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="Leave empty to use the name in the JSON"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    If you enter a name here, it is used instead of the "name" in the JSON.
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
                  className={`w-full h-96 px-3 py-2 font-mono text-sm border rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${
                    jsonError ? 'border-red-500' : 'border-gray-300'
                  }`}
                  placeholder="Paste your workflow JSON here..."
                />
                {jsonError && (
                  <p className="text-sm text-red-500 mt-1">{jsonError}</p>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        {jobProgress && (
          <div className="px-6 py-3 border-t border-gray-200 bg-blue-50">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-blue-900">
                Creating workflows: {jobProgress.status}
              </span>
              <span className="text-blue-700">
                {jobProgress.processedCount || 0}/{jobProgress.totalCount || 0}
                {jobProgress.failureCount ? `, ${jobProgress.failureCount} failed` : ''}
              </span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-blue-100 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{
                  width: `${jobProgress.totalCount
                    ? Math.min(100, ((jobProgress.processedCount || 0) / jobProgress.totalCount) * 100)
                    : 0}%`
                }}
              />
            </div>
          </div>
        )}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-form"
            loading={isSubmitting}
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Workflow
          </Button>
        </div>
      </div>
    </div>
  );
}
