import React, { useState } from 'react';
import { AlertCircle, GitFork, BarChart3, Lightbulb, SplitSquareVertical, Layers, Mail, Copy, X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { workflowApi } from '../../api/endpoints';

const SidebarItem = ({ type, label, icon: Icon, colorClass, onDragStart }) => (
  <div
    className={`flex items-center gap-3 p-3 mb-2 bg-white border rounded cursor-grab hover:shadow-md transition-shadow ${colorClass}`}
    onDragStart={(event) => onDragStart(event, type)}
    draggable
  >
    <Icon className="w-5 h-5" />
    <span className="text-sm font-medium">{label}</span>
  </div>
);

const formatNodeType = (type) => ({
  validation: 'Validation Check',
  branch: 'Logic Branch',
  metric_compare: 'Metric Compare',
  recursive_dimension_breakdown: 'Dimension Breakdown',
  metric_breakdown: 'Dimension Breakdown',
  composite: 'Composite / Group',
  insight: 'Insight Generator',
  email: 'Messaging',
  messaging: 'Messaging',
  workflow_ref: 'Workflow Reference',
}[type] || type || 'Unknown node');

function ImportWorkflowModal({ workflows, tenantId, onImportNode, onClose }) {
  const [workflowId, setWorkflowId] = useState('');
  const [workflowDefinition, setWorkflowDefinition] = useState(null);
  const [loading, setLoading] = useState(false);

  const selectWorkflow = async (nextWorkflowId) => {
    setWorkflowId(nextWorkflowId);
    setWorkflowDefinition(null);
    if (!nextWorkflowId) return;

    setLoading(true);
    try {
      const result = await workflowApi.get(tenantId, nextWorkflowId, { includeGlobal: true });
      setWorkflowDefinition(result?.version?.definitionJson || null);
      if (!result?.version?.definitionJson) toast.error('This workflow has no saved definition');
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load this workflow');
    } finally {
      setLoading(false);
    }
  };

  const sourceWorkflow = workflows.find((workflow) => workflow.workflowId === workflowId);
  const nodes = Array.isArray(workflowDefinition?.nodes) ? workflowDefinition.nodes : [];

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby="import-workflow-title" className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 id="import-workflow-title" className="text-lg font-semibold text-gray-900">Import a node</h2>
            <p className="mt-1 text-sm text-gray-500">Copy a node’s settings from another workflow.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </header>

        <div className="p-5">
          <label htmlFor="source-workflow" className="mb-2 block text-sm font-medium text-gray-700">Source workflow</label>
          <select id="source-workflow" value={workflowId} onChange={(event) => selectWorkflow(event.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
            <option value="">Choose a workflow…</option>
            {workflows.map((workflow) => (
              <option key={workflow.workflowId} value={workflow.workflowId}>{workflow.name} ({workflow.scope === 'global' ? 'Global' : 'Tenant'})</option>
            ))}
          </select>

          <div className="mt-4 max-h-[50vh] space-y-2 overflow-y-auto">
            {loading && <div className="flex items-center gap-2 py-8 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading workflow nodes…</div>}
            {!loading && workflowId && workflowDefinition && nodes.length === 0 && <p className="py-8 text-center text-sm text-gray-500">No nodes in this workflow.</p>}
            {!loading && nodes.map((node, index) => {
              return (
                <div key={`${node.id || node.type}-${index}`} className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-900">{node.id || `Node ${index + 1}`}</div>
                    <div className="mt-1 text-xs text-gray-500">{formatNodeType(node.type)}{node.type === 'composite' ? ' · includes its step nodes' : ''}</div>
                  </div>
                  <button type="button" onClick={() => onImportNode(node, sourceWorkflow, workflowDefinition)} className="shrink-0 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">Import</button>
                </div>
              );
            })}
          </div>
          <p className="mt-4 rounded-md bg-blue-50 p-3 text-xs leading-5 text-blue-800">Imported nodes are copies. The original stays unchanged. The copy gets a new ID and is added without its outgoing connections, so you can connect it in this workflow.</p>
        </div>
      </section>
    </div>
  );
}

export default function NodeSidebar({ workflowImportOptions = [], currentTenantId, onImportNode }) {
  const [showImportModal, setShowImportModal] = useState(false);
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-64 bg-gray-50 border-r border-gray-200 p-4 flex flex-col h-full overflow-y-auto">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Components
      </h3>
      
      <div className="space-y-1">
        <SidebarItem 
            type="validation" 
            label="Validation Check" 
            icon={AlertCircle} 
            colorClass="border-yellow-200 text-yellow-700"
            onDragStart={onDragStart}
        />
        
        <SidebarItem 
            type="branch" 
            label="Logic Branch" 
            icon={GitFork} 
            colorClass="border-purple-200 text-purple-700"
            onDragStart={onDragStart}
        />

        <SidebarItem 
            type="metric_compare" 
            label="Metric Compare" 
            icon={BarChart3} 
            colorClass="border-blue-200 text-blue-700"
            onDragStart={onDragStart}
        />

        <SidebarItem 
            type="metric_breakdown" 
            label="Dimension Breakdown" 
            icon={SplitSquareVertical} 
            colorClass="border-indigo-200 text-indigo-700"
            onDragStart={onDragStart}
        />

        <SidebarItem 
            type="composite" 
            label="Composite / Group" 
            icon={Layers} 
            colorClass="border-gray-300 text-gray-700 bg-gray-50"
            onDragStart={onDragStart}
        />

        <SidebarItem 
            type="insight" 
            label="Insight Generator" 
            icon={Lightbulb} 
            colorClass="border-green-200 text-green-700"
            onDragStart={onDragStart}
        />

        <SidebarItem
            type="email"
            label="Messaging"
            icon={Mail}
            colorClass="border-cyan-200 text-cyan-700"
            onDragStart={onDragStart}
        />
      </div>

      <div className="mt-4 border-t border-gray-200 pt-4">
        <button type="button" onClick={() => setShowImportModal(true)} className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50">
          <Copy className="h-4 w-4" /> Import from workflow
        </button>
      </div>

      <div className="mt-auto p-4 bg-blue-50 rounded-lg text-xs text-blue-700">
        <p className="font-semibold mb-1">Tip:</p>
        Drag and drop nodes onto the canvas to build your workflow.
      </div>
      {showImportModal && (
        <ImportWorkflowModal
          workflows={workflowImportOptions}
          tenantId={currentTenantId}
          onImportNode={(node, workflow) => {
            onImportNode?.(node, workflow);
            setShowImportModal(false);
          }}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}
