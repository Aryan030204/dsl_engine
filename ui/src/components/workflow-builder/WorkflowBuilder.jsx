import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { ReactFlowProvider, useNodesState, useEdgesState, addEdge, MarkerType, useReactFlow } from '@xyflow/react';
import { ArrowLeft, Save, Layout } from 'lucide-react';
import toast from 'react-hot-toast';
import { useUnsavedChangesNavigation } from '../../context/UnsavedChangesContext';

import NodeSidebar from './NodeSidebar';
import WorkflowCanvas from './WorkflowCanvas';
import PropertiesPanel from './PropertiesPanel';
import { jsonToGraph, graphToJson } from '../../utils/workflowTransformers';
import {
  buildDefaultBreakdownOutputKey,
} from '../../constants/workflowOutputKeys';
import {
  getPartialDayProductCompatibilityErrors,
} from '../../utils/workflowValidation';

const sanitizeIdSegment = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'imported';

const getUniqueNodeId = (preferredId, usedIds) => {
  let candidate = preferredId;
  let suffix = 1;
  while (usedIds.has(candidate)) {
    candidate = `${preferredId}_${suffix++}`;
  }
  usedIds.add(candidate);
  return candidate;
};

function WorkflowBuilderContent({
  initialData,
  onSave,
  workflowImportOptions,
  onBack,
  isEditing,
  scope,
  onScopeChange,
  tenantOptions,
  selectedTenantIds,
  onToggleTenant,
  tenantsLoading,
  currentTenantId,
  isSaving,
}) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, applyNodesChange] = useNodesState([]);
  const [edges, setEdges, applyEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [metadata, setMetadata] = useState(initialData || {});
  const [isAttachingWorkflowRef, setIsAttachingWorkflowRef] = useState(false);
  const { hasUnsavedChanges, setHasUnsavedChanges, blocker } = useUnsavedChangesNavigation();
  const workflowImportOptionMap = useMemo(
    () => new Map((workflowImportOptions || []).map((item) => [item.workflowId, item])),
    [workflowImportOptions]
  );
  const breakdownOutputKeySuggestions = useMemo(() => {
    const keys = new Set();

    nodes.forEach((node) => {
      const nodeType = node?.data?.type || node?.type;
      if (nodeType !== 'recursive_dimension_breakdown') return;

      const explicitOutputKey = typeof node?.data?.output_key === 'string'
        ? node.data.output_key.trim()
        : '';
      const baseMetrics = Array.isArray(node?.data?.base_metrics) && node.data.base_metrics.length
        ? node.data.base_metrics
        : (node?.data?.base_metric ? [node.data.base_metric] : ['cvr']);
      const isMultiMetric = baseMetrics.length > 1;
      if (explicitOutputKey) {
        if (isMultiMetric) baseMetrics.forEach((metric) => keys.add(`${explicitOutputKey}_${metric}`));
        else keys.add(explicitOutputKey);
      }

      const dimensions = Array.isArray(node?.data?.dimensions)
        ? node.data.dimensions
        : (node?.data?.dimension ? [node.data.dimension] : []);
      const firstDimension = typeof dimensions[0] === 'string' ? dimensions[0].trim() : '';
      if (!firstDimension) return;

      baseMetrics.forEach((metric) => keys.add(
        buildDefaultBreakdownOutputKey({
          baseMetric: metric,
          dimension: firstDimension,
          filterMode: node?.data?.filter_mode || 'drop',
        })
      ));

      // Backward compatibility: older workflows may still reference plain dimension keys.
      keys.add(firstDimension);
    });

    return Array.from(keys).sort();
  }, [nodes]);

  // Initialize graph from JSON on mount
  useEffect(() => {
    if (initialData) {
      const { nodes: flowNodes, edges: flowEdges } = jsonToGraph(initialData);
      setNodes(flowNodes);
      setEdges(flowEdges);
      setHasUnsavedChanges(false);
    }
  }, [initialData, setNodes, setEdges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const onNodesChange = useCallback((changes) => {
    if (changes.some((change) => change.type === 'remove')) {
      setHasUnsavedChanges(true);
    }
    applyNodesChange(changes);
  }, [applyNodesChange]);

  const onEdgesChange = useCallback((changes) => {
    if (changes.some((change) => change.type === 'remove')) {
      setHasUnsavedChanges(true);
    }
    applyEdgesChange(changes);
  }, [applyEdgesChange]);

  const handleAddNode = useCallback((updateNodes) => {
    setHasUnsavedChanges(true);
    setNodes(updateNodes);
  }, [setNodes]);

  const onConnect = useCallback(
    (params) => {
        let newEdge = { 
          ...params, 
          type: 'deletable', 
          markerEnd: { type: MarkerType.ArrowClosed } 
        };

        // Styling for Rule connections (Branch Node)
        if (params.sourceHandle && params.sourceHandle.startsWith('handle-rule-')) {
             // Extract rule ID (format: handle-rule-{ruleId})
             const ruleId = params.sourceHandle.replace('handle-rule-', '');
             
             // Find the source node to get the rule index for labeling
             const sourceNode = nodes.find(n => n.id === params.source);
             const ruleIndex = sourceNode?.data?.rules?.findIndex(r => 
               (r._ruleId || `legacy_rule_${sourceNode.data.rules.indexOf(r)}`) === ruleId
             ) ?? 0;
             
             newEdge = { 
                ...newEdge, 
                style: { stroke: '#9333ea' },
                label: `Rule ${ruleIndex + 1}`,
             };
        } 
        // Styling for Default path (Branch Node)
        else if (params.sourceHandle === 'handle-default') {
             newEdge = { 
                ...newEdge, 
                animated: true,
                label: 'Default',
                style: { stroke: '#6b7280' }
             };
        }
        // Styling for Composite Steps
        // (If we had specific handles for steps, we would check here. 
        // For now, if source is composite and target is not 'final', we might assume...)
        
        setEdges((eds) => addEdge(newEdge, eds));
        setHasUnsavedChanges(true);
    },
    [setEdges, nodes],
  );

  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
  }, []);

  const handleNodeUpdate = (id, newData) => {
    setHasUnsavedChanges(true);
    setNodes((nds) => {
      const oldNode = nds.find(n => n.id === id);
      
      // Check if this is a branch node with deleted rules - clean up orphaned edges
      if (oldNode?.data?.rules && newData.rules) {
        const oldRuleIds = new Set(oldNode.data.rules.map((r, idx) => r._ruleId || `legacy_rule_${idx}`));
        const newRuleIds = new Set(newData.rules.map((r, idx) => r._ruleId || `legacy_rule_${idx}`));
        
        // Find deleted rule IDs
        const deletedRuleIds = [...oldRuleIds].filter(rId => !newRuleIds.has(rId));
        
        if (deletedRuleIds.length > 0) {
          // Remove edges connected to deleted rules
          setEdges((eds) => eds.filter(e => {
            if (e.source !== id) return true;
            if (!e.sourceHandle?.startsWith('handle-rule-')) return true;
            const edgeRuleId = e.sourceHandle.replace('handle-rule-', '');
            return !deletedRuleIds.includes(edgeRuleId);
          }));
        }
      }
      
      return nds.map((node) => {
        if (node.id === id) {
          // If ID changed in data, we might need to update node.id too, 
          // but React Flow prefers stable IDs. Ideally keep display ID separate from internal ID.
          // For now, update data only.
          return { ...node, data: newData };
        }
        return node;
      });
    });
    // Update local selection state too
    setSelectedNode((prev) => ({ ...prev, data: newData }));
  };

  const handleNodeDelete = (id) => {
      setHasUnsavedChanges(true);
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelectedNode(null);
  };

  const handleAttachWorkflowToBranchRule = useCallback(
    async ({ branchNodeId, ruleId, workflowId }) => {
      if (!branchNodeId || !ruleId || !workflowId) {
        toast.error('Missing branch rule or workflow selection');
        return;
      }

      setIsAttachingWorkflowRef(true);
      try {
        const targetWorkflow = workflowImportOptionMap.get(workflowId);
        if (!targetWorkflow) {
          throw new Error('Selected workflow is not available');
        }
        if (!targetWorkflow.latestVersion) {
          throw new Error('Selected workflow has no latest version');
        }

        const branchNode = nodes.find((node) => node.id === branchNodeId);
        if (!branchNode || branchNode.type !== 'branch') {
          throw new Error('Selected node is not a branch');
        }

        const branchRules = Array.isArray(branchNode.data?.rules) ? branchNode.data.rules : [];
        const ruleIndex = branchRules.findIndex((rule, idx) => {
          const stableRuleId = rule?._ruleId || `legacy_rule_${idx}`;
          return stableRuleId === ruleId;
        });
        if (ruleIndex === -1) {
          throw new Error('Branch rule not found');
        }

        const usedReactIds = new Set(nodes.map((node) => node.id));
        const usedBackendNodeIds = new Set(nodes.map((node) => node.data?.id).filter(Boolean));
        const reactNodeId = getUniqueNodeId(`node_${Date.now().toString(36)}`, usedReactIds);
        const backendNodeId = getUniqueNodeId(
          `workflow_ref_${sanitizeIdSegment(workflowId)}`,
          usedBackendNodeIds
        );

        const workflowRefNode = {
          id: reactNodeId,
          type: 'workflow_ref',
          position: {
            x: (branchNode.position?.x ?? 0) + 420,
            y: branchNode.position?.y ?? 0,
          },
          data: {
            id: backendNodeId,
            type: 'workflow_ref',
            ref: {
              workflow_id: workflowId,
              version: targetWorkflow.latestVersion,
              scope: targetWorkflow.scope || 'tenant',
            },
            referencedWorkflowName: targetWorkflow.name || workflowId,
          },
        };

        const updatedNodes = nodes.map((node) => {
          if (node.id !== branchNodeId) return node;
          const nextRules = [...branchRules];
          nextRules[ruleIndex] = { ...nextRules[ruleIndex], then: backendNodeId };
          return {
            ...node,
            data: {
              ...node.data,
              rules: nextRules,
            },
          };
        });

        const updatedRuleEdge = {
          id: `${branchNodeId}-rule-${ruleId}-${reactNodeId}`,
          source: branchNodeId,
          sourceHandle: `handle-rule-${ruleId}`,
          target: reactNodeId,
          type: 'deletable',
          label: `Rule ${ruleIndex + 1}`,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: '#9333ea' },
        };

        const updatedEdges = [
          ...edges.filter(
            (edge) => !(edge.source === branchNodeId && edge.sourceHandle === `handle-rule-${ruleId}`)
          ),
          updatedRuleEdge,
        ];
        const finalNodes = [...updatedNodes, workflowRefNode];
        const finalEdges = updatedEdges;

        setNodes(finalNodes);
        setEdges(finalEdges);
        setHasUnsavedChanges(true);
        requestAnimationFrame(() => {
          fitView({ padding: 0.2, duration: 250 });
        });

        if (selectedNode?.id === branchNodeId) {
          const refreshedBranch = finalNodes.find((node) => node.id === branchNodeId);
          if (refreshedBranch) {
            setSelectedNode(refreshedBranch);
          }
        }

        toast.success(`Attached workflow reference "${targetWorkflow.name || workflowId}" to rule ${ruleIndex + 1}`);
      } catch (error) {
        console.error(error);
        toast.error(error?.message || 'Failed to attach workflow reference');
      } finally {
        setIsAttachingWorkflowRef(false);
      }
    },
    [workflowImportOptionMap, nodes, edges, selectedNode, setNodes, setEdges, fitView]
  );

  const handleSave = async () => {
    try {
      const workflowJson = graphToJson(nodes, edges, metadata);
      const compatibilityErrors = getPartialDayProductCompatibilityErrors(workflowJson);
      if (compatibilityErrors.length) {
        toast.error(compatibilityErrors[0]);
        return;
      }
      // Validate or cleanup
      const saved = await onSave(workflowJson);
      if (saved) {
        setHasUnsavedChanges(false);
      }
      return Boolean(saved);
    } catch (error) {
      console.error(error);
      toast.error('Failed to generate workflow JSON');
      return false;
    }
  };

  const handleSaveAndProceed = async () => {
    const saved = await handleSave();
    if (saved) {
      blocker.proceed();
    }
  };

  const handleAutoLayout = () => {
     const { nodes: layoutedNodes, edges: layoutedEdges } = jsonToGraph(graphToJson(nodes, edges, metadata));
     setNodes([...layoutedNodes]);
     setEdges([...layoutedEdges]);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={onBack}
            className="p-2 hover:bg-gray-100 rounded-full text-gray-500"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                className="text-lg font-semibold text-gray-900 border border-transparent focus:border-gray-300 rounded px-2 py-1 min-w-[180px]"
                value={metadata.name || ''}
                onChange={(e) => {
                  setMetadata((m) => ({ ...m, name: e.target.value }));
                  setHasUnsavedChanges(true);
                }}
                placeholder="Workflow Name"
              />
              <span className="text-xs text-gray-500">Visual Editor</span>
            </div>
            {metadata.workflow_id && (
              <p className="text-xs text-gray-400 font-mono px-2">{metadata.workflow_id}</p>
            )}
            <input
              className="mt-1 text-xs text-gray-700 border border-gray-200 rounded px-2 py-1 w-full max-w-md"
              value={metadata.description || ''}
              onChange={(e) => {
                setMetadata((m) => ({ ...m, description: e.target.value }));
                setHasUnsavedChanges(true);
              }}
              placeholder="Description"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
           <button
            onClick={handleAutoLayout}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
          >
            <Layout className="w-4 h-4" />
            Auto Layout
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded ${
              isSaving ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            <Save className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {!isEditing && (
        <div className="bg-gray-50 border-b border-gray-200 px-4 py-3">
          <div className="flex flex-wrap items-start gap-6">
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Workflow Scope
              </div>
              <div className="flex flex-wrap gap-4 text-sm text-gray-700">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="workflow-scope"
                    value="single"
                    checked={scope === 'single'}
                    onChange={() => onScopeChange?.('single')}
                  />
                  Current tenant ({currentTenantId || 'None'})
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="workflow-scope"
                    value="multiple"
                    checked={scope === 'multiple'}
                    onChange={() => onScopeChange?.('multiple')}
                  />
                  Selected tenants
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="workflow-scope"
                    value="global"
                    checked={scope === 'global'}
                    onChange={() => onScopeChange?.('global')}
                  />
                  Global (all tenants)
                </label>
              </div>
            </div>

            {scope === 'multiple' && (
              <div className="min-w-[220px]">
                <div className="text-xs text-gray-500 mb-2">Select tenants</div>
                <div className="max-h-36 overflow-auto border border-gray-200 rounded bg-white">
                  {tenantsLoading ? (
                    <div className="px-3 py-2 text-sm text-gray-500">Loading tenants...</div>
                  ) : tenantOptions?.length ? (
                    tenantOptions.map((tenantId) => (
                      <label
                        key={tenantId}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedTenantIds?.includes(tenantId)}
                          onChange={() => onToggleTenant?.(tenantId)}
                        />
                        {tenantId}
                      </label>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-gray-500">No tenants available</div>
                  )}
                </div>
              </div>
            )}

            {scope === 'global' && (
              <div className="text-xs text-gray-500 mt-6">
                This will create the workflow for {tenantOptions?.length || 0} tenant(s).
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        <NodeSidebar />
        
        <div className="flex-1 bg-gray-100 relative h-full w-full">
          <WorkflowCanvas 
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            setNodes={handleAddNode}
          />
        </div>

        {selectedNode && (
          <PropertiesPanel 
            selectedNode={selectedNode} 
            onChange={handleNodeUpdate}
            onClose={() => setSelectedNode(null)}
            onDelete={handleNodeDelete}
            workflowImportOptions={workflowImportOptions}
            onAttachWorkflowToRule={handleAttachWorkflowToBranchRule}
            isAttachingWorkflow={isAttachingWorkflowRef}
            breakdownOutputKeySuggestions={breakdownOutputKeySuggestions}
          />
        )}
      </div>

      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-changes-title"
            aria-describedby="unsaved-changes-description"
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
          >
            <h2 id="unsaved-changes-title" className="text-lg font-semibold text-gray-900">
              Unsaved changes
            </h2>
            <p id="unsaved-changes-description" className="mt-2 text-sm text-gray-600">
              Your changes have not been saved. Save them before leaving, or leave without saving.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={isSaving}
                onClick={() => {
                  setHasUnsavedChanges(false);
                  blocker.proceed();
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Leave
              </button>
              <button
                type="button"
                onClick={handleSaveAndProceed}
                disabled={isSaving}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WorkflowBuilder(props) {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderContent {...props} />
    </ReactFlowProvider>
  );
}
