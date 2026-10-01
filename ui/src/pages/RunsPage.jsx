import { Link } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import { RefreshCw, Clock } from 'lucide-react';
import { useRecentRuns } from '../api/hooks';
import { Button, Badge, Card, PageSpinner, EmptyState } from '../components/ui';
import { useTenant } from '../context/TenantContext';
import toast from 'react-hot-toast';

function getStatusBadge(status) {
  const statusMap = {
    completed: 'completed',
    success: 'success',
    failed: 'failed',
    error: 'error',
    running: 'running',
  };
  return statusMap[status?.toLowerCase()] || 'pending';
}

function getDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '-';
  const start = new Date(startedAt);
  const end = new Date(finishedAt);
  const diffMs = end - start;
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
  return `${(diffMs / 60000).toFixed(1)}m`;
}

export default function RunsPage() {
  const { tenantId } = useTenant();
  const { data: runs, isLoading, error, refetch } = useRecentRuns(100);

  const handleRefresh = async () => {
    try {
      const result = await refetch();
      if (result.isError) throw result.error || new Error('Failed to refresh runs');
      toast.success('Runs refreshed');
    } catch (err) {
      toast.error(err.message || 'Failed to refresh runs');
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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Runs</h1>
          <p className="text-gray-500 mt-1">
            Recent workflow runs for {tenantId}
          </p>
        </div>
        <Button variant="secondary" onClick={handleRefresh}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {runs?.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock}
            title="No runs yet"
            description="Recent runs across all workflows will appear here."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Workflow
                  </th>
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
                    Trigger
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="text-left py-3 px-6 text-sm font-medium text-gray-500 uppercase tracking-wider">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {runs.map((run) => {
                  const workflowLabel = run?.definitionJson?.name || run.workflowId;
                  return (
                    <tr key={run._id} className="hover:bg-gray-50">
                      <td className="py-4 px-6">
                        <div>
                          <Link
                            to={`/workflows/${run.workflowId}`}
                            className="font-medium text-gray-900 hover:text-primary-600"
                          >
                            {workflowLabel}
                          </Link>
                          <p className="text-xs text-gray-400 font-mono">{run.workflowId}</p>
                        </div>
                      </td>
                      <td className="py-4 px-6">
                        <Link
                          to={`/workflows/${run.workflowId}/runs/${run._id}`}
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
                        {run.triggerType || '-'}
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
                            ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })
                            : ''}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
