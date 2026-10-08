import React, { useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { WorkflowBuilder, PageSpinner } from '../components';
import { useWorkflow, useWorkflowVersions, useWorkflows, useCreateGlobalWorkflow, useCreateWorkflowForTenants, useCreateWorkflowVersion, useCreateGlobalWorkflowVersion, useTenants } from '../api/hooks';
import { workflowApi } from '../api/endpoints';
import { useTenant } from '../context/TenantContext';
import toast from 'react-hot-toast';

const NEW_WORKFLOW_TEMPLATE = {
  name: 'New Workflow',
  workflow_type: 'root_cause_analysis',
  description: 'New visual workflow',
  version: '1.0',
  workflow_purpose: 'rca',
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
      id: 'start',
      type: 'validation',
      checks: [
        { field: 'sessions', condition: 'current > 0' },
      ],
      next: 'analysis',
    },
    {
        id: 'analysis',
        type: 'metric_compare',
        metrics: ['cvr'],
        next: 'insight'
    },
    {
        id: 'insight',
        type: 'insight',
        template: 'Analysis complete'
    }
  ],
};

export default function WorkflowBuilderPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedVersion = searchParams.get('version');
  const isEditing = !!workflowId;
  const { tenantId } = useTenant();
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants();
  const { data: availableWorkflows = [] } = useWorkflows();
  const createGlobalWorkflow = useCreateGlobalWorkflow();
  const createWorkflowForTenants = useCreateWorkflowForTenants();
  const [scope, setScope] = useState('single'); // 'single' | 'multiple' | 'global'
  const [selectedTenantIds, setSelectedTenantIds] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobProgress, setJobProgress] = useState(null);

  // Hooks for fetching (if editing)
  const { data: workflowData, isLoading: workflowLoading, error: workflowError } = useWorkflow(workflowId);
  const { data: workflowVersions = [], isLoading: versionsLoading, error: versionsError } = useWorkflowVersions(workflowId);
  const historicalVersion = requestedVersion
    ? workflowVersions.find((version) => String(version.version) === String(requestedVersion))
    : null;
  const isLoading = workflowLoading || Boolean(requestedVersion && versionsLoading);
  const historicalVersionError = requestedVersion
    ? versionsError || (!versionsLoading && !historicalVersion
      ? new Error(`Workflow version ${requestedVersion} was not found`)
      : null)
    : null;
  const error = workflowError || historicalVersionError;

  // Determine if editing a global workflow
  const isGlobalWorkflow = workflowData?.workflow?.scope === 'global';

  // Hooks for mutations
  const createVersion = useCreateWorkflowVersion(workflowId);
  const createGlobalVersion = useCreateGlobalWorkflowVersion(workflowId);

  const initialData = useMemo(() => isEditing
        ? (() => {
            const definition = requestedVersion
              ? historicalVersion?.definitionJson
              : workflowData?.version?.definitionJson;
            return {
              ...(definition || NEW_WORKFLOW_TEMPLATE),
              ...(!requestedVersion && workflowData?.workflow?.name
                ? { name: workflowData.workflow.name }
                : {})
            };
          })()
        : NEW_WORKFLOW_TEMPLATE, [isEditing, workflowData, requestedVersion, historicalVersion]);

  const tenantOptions = useMemo(() => {
    const list = Array.isArray(tenants) ? tenants : [];
    return list
      .filter((tenant) => tenant?.tenantId)
      .map((tenant) => tenant.tenantId)
      .sort();
  }, [tenants]);

  const workflowImportOptions = useMemo(() => {
    return (Array.isArray(availableWorkflows) ? availableWorkflows : [])
      .filter((workflow) => workflow?.workflowId && workflow?.isActive !== false)
      .map((workflow) => ({
        workflowId: workflow.workflowId,
        name: workflow.name || workflow.workflowId,
        scope: workflow.scope || 'tenant',
        latestVersion: workflow.latestVersion || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [availableWorkflows]);

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

  const handleScopeChange = (nextScope) => {
    setScope(nextScope);
    if (nextScope === 'multiple' && selectedTenantIds.length === 0 && tenantId) {
      setSelectedTenantIds([tenantId]);
    }
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

  const handleSave = async (workflowJson) => {
    try {
      if (isEditing) {
        // Creating a new version
        // We probably want to auto-increment version number if not handled by backend or user
        const currentVersion = workflowData?.version?.definitionJson?.version || '1.0';
        const versionParts = currentVersion.split('.');
        const newVersion = `${versionParts[0]}.${parseInt(versionParts[1] || 0) + 1}`;
        
        workflowJson.version = newVersion;
        // Ensure workflow_id matches
        workflowJson.workflow_id = workflowId;

        // Use appropriate mutation based on workflow scope
        if (isGlobalWorkflow) {
          await createGlobalVersion.mutateAsync(workflowJson);
        } else {
          await createVersion.mutateAsync(workflowJson);
        }
        toast.success('Changes saved');
        return true;
      } else {
        // Creating new workflow - workflow_id will be auto-generated by server
        // Remove any placeholder workflow_id to let server generate
        delete workflowJson.workflow_id;
        
        const result = scope === 'global'
          ? await createGlobalWorkflowDefinition(workflowJson)
          : await createWorkflowsForTenants(workflowJson, resolvedTenantIds);
        if (result?.workflow?.workflowId) {
          toast.success('Workflow created successfully');
          navigate(`/workflows/${result.workflow.workflowId}`);
          return true;
        } else if (result === null) {
          navigate('/workflows');
          return false;
        }
        return false;
      }
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409 && err.response?.data?.conflicts?.length) {
        const tenantList = err.response.data.conflicts.map((item) => item.tenantId).join(', ');
        toast.error(`Workflow ID already exists for: ${tenantList}`);
        return false;
      }
      const errorMsg = err.response?.data?.error 
        || (err.response?.data?.errors ? err.response.data.errors.join(', ') : null)
        || 'Failed to save workflow';
      toast.error(errorMsg);
      return false;
    }
  };

  return (
    <div className="h-screen w-full bg-white">
      {jobProgress && (
        <div className="fixed left-1/2 top-4 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 shadow-lg">
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
      {isEditing && isLoading ? (
        <PageSpinner />
      ) : isEditing && error ? (
        <div className="text-center py-12">
          <p className="text-red-500">Error loading workflow: {error.message}</p>
          <button onClick={() => navigate(`/workflows/${workflowId}`)} className="text-blue-500 underline mt-4">
            Go back
          </button>
        </div>
      ) : (
        <WorkflowBuilder 
          initialData={initialData}
          onSave={handleSave}
          workflowImportOptions={workflowImportOptions}
          onBack={() => navigate(isEditing ? `/workflows/${workflowId}` : '/workflows')}
          isEditing={isEditing}
          scope={scope}
          onScopeChange={handleScopeChange}
          tenantOptions={tenantOptions}
          selectedTenantIds={selectedTenantIds}
          onToggleTenant={toggleTenantSelection}
          tenantsLoading={tenantsLoading}
          currentTenantId={tenantId}
          isSaving={isSubmitting || createVersion.isPending || createGlobalVersion.isPending}
        />
      )}
    </div>
  );
}
