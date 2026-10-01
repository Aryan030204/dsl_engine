import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, RefreshCw } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { useWorkflowRuns, useExecuteWorkflow } from '../api/hooks';
import toast from 'react-hot-toast';
import { Button, Badge, Card, PageSpinner, EmptyState } from '../components/ui';
import { useState } from 'react';
import RunWorkflowModal from '../components/RunWorkflowModal';

export default function WorkflowRunsPage() {
  const { workflowId } = useParams();
  const { data: runs, isLoading, error, refetch } = useWorkflowRuns(workflowId);
  const executeWorkflow = useExecuteWorkflow(workflowId);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [rerunningRunId, setRerunningRunId] = useState(null);

  const handleRefresh = async () => {
    try {
      const result = await refetch();
      if (result.isError) throw result.error || new Error('Failed to refresh runs');
      toast.success('Runs refreshed');
    } catch (err) {
      toast.error(err.message || 'Failed to refresh runs');
    }
  };

  const handleRerun = async (run) => {
    setRerunningRunId(run._id);
    try {
      const result = await executeWorkflow.mutateAsync({
        context: run.context,
        rerun: true,
        mode: 'async',
      });
      toast.success(`Workflow rerun started: ${result.runId}`);
      // Explicitly refetch to update the list immediately
      refetch();
    } catch (err) {
      const errorMessage = err.response?.data?.error
        || (Array.isArray(err.response?.data?.errors) ? err.response.data.errors.join(', ') : null)
        || 'Failed to rerun workflow';
      toast.error(errorMessage);
    } finally {
      setRerunningRunId(null);
    }
  };

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500">Error loading runs: {error.message}</p>
      </div>
    );
  }

  const getStatusBadge = (status) => {
    const statusMap = {
      completed: 'completed',
      success: 'success',
      failed: 'failed',
      error: 'error',
      running: 'running',
    };
    return statusMap[status?.toLowerCase()] || 'pending';
  };

  const getDuration = (startedAt, finishedAt) => {
    if (!startedAt || !finishedAt) return '-';
    const start = new Date(startedAt);
    const end = new Date(finishedAt);
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
    return `${(diffMs / 60000).toFixed(1)}m`;
  };

  return (
    <div>
      {/* Back Link */}
      <Link
        to={`/workflows/${workflowId}`}
        className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back to {workflowId}
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workflow Runs</h1>
          <p className="text-gray-500 mt-1">
            Execution history for <span className="font-medium">{workflowId}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={() => setRunModalOpen(true)}>
            <Play className="w-4 h-4 mr-2" />
            New Run
          </Button>
        </div>
      </div>

      {/* Runs Table */}
      {runs?.length === 0 ? (
        <Card>
          <EmptyState
            icon={Play}
            title="No runs yet"
            description="Execute your first workflow run to see results here."
            action={
              <Button onClick={() => setRunModalOpen(true)}>
                <Play className="w-4 h-4 mr-2" />
                Run Workflow
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Run ID
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Version
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Started
                  </th>
                  <th className="text-right py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {runs?.map((run) => (
                  <tr key={run._id} className="hover:bg-gray-50">
                    <td className="py-4 px-6">
                      <Link
                        to={`/workflows/${workflowId}/runs/${run._id}`}
                        className="font-mono text-sm text-primary-600 hover:underline"
                      >
                        {run._id.slice(-8)}
                      </Link>
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-600">
                      v{run.version}
                    </td>
                    <td className="py-4 px-6">
                      <Badge status={getStatusBadge(run.status)}>
                        {run.status}
                      </Badge>
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-600">
                      {getDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-500">
                      <div>
                        {run.startedAt
                          ? format(new Date(run.startedAt), 'MMM d, HH:mm:ss')
                          : '-'}
                      </div>
                      <div className="text-xs text-gray-400">
                        {run.startedAt
                          ? formatDistanceToNow(new Date(run.startedAt), {
                            addSuffix: true,
                          })
                          : ''}
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRerun(run)}
                        loading={rerunningRunId === run._id}
                        className="text-primary-600 hover:text-primary-700 hover:bg-primary-50"
                        title="Rerun with same parameters"
                      >
                        <Play className="w-4 h-4 mr-1 fill-current" />
                        Rerun
                      </Button>
                      <Link to={`/workflows/${workflowId}/runs/${run._id}`}>
                        <Button variant="ghost" size="sm">
                          View Details
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Run Modal */}
      {runModalOpen && (
        <RunWorkflowModal
          workflow={{ workflowId }}
          onClose={() => setRunModalOpen(false)}
        />
      )}
    </div>
  );
}
