import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { useRun } from '../api/hooks';
import { Badge, Card, CardHeader, CardContent, CardTitle, PageSpinner } from '../components/ui';
import InsightDetail from '../components/InsightDetail';
import { RunStateDecisionCard } from '../components/StateEngineViews';
import { useState } from 'react';

const formatFieldLabel = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

function StructuredValue({ value, depth = 0 }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400">-</span>;
  }

  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-gray-400">No items</span>;
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-md border border-gray-200 bg-white p-3">
            {typeof item === 'object' && item !== null && !Array.isArray(item) && (
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Item {index + 1}
              </div>
            )}
            <StructuredValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return <span className="text-gray-400">No data</span>;
    if (depth >= 5) {
      return <pre className="max-w-full overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(value, null, 2)}</pre>;
    }
    return (
      <dl className="min-w-0 space-y-2">
        {entries.map(([key, item]) => (
          <div key={key} className="min-w-0 rounded-md bg-gray-50 p-3">
            <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              {formatFieldLabel(key)}
            </dt>
            <dd className="min-w-0 break-words text-sm text-gray-900 [overflow-wrap:anywhere]">
              <StructuredValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${value ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'}`}>
        {value ? 'Yes' : 'No'}
      </span>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

export default function RunDetailPage() {
  const { workflowId, runId } = useParams();
  const { data: run, isLoading, error } = useRun(workflowId, runId);
  const [expandedNodes, setExpandedNodes] = useState({});

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500">Error loading run: {error.message}</p>
      </div>
    );
  }

  const toggleNode = (nodeId) => {
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeId]: !prev[nodeId],
    }));
  };

  const getStatusIcon = (status) => {
    switch (status?.toLowerCase()) {
      case 'completed':
      case 'success':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'failed':
      case 'error':
        return <XCircle className="w-5 h-5 text-red-500" />;
      default:
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
    }
  };

  const getDuration = () => {
    if (!run?.startedAt || !run?.finishedAt) return '-';
    const start = new Date(run.startedAt);
    const end = new Date(run.finishedAt);
    const diffMs = end - start;
    if (diffMs < 1000) return `${diffMs}ms`;
    if (diffMs < 60000) return `${(diffMs / 1000).toFixed(2)}s`;
    return `${(diffMs / 60000).toFixed(2)}m`;
  };
  const truncate = (text, max = 200) => {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  };
  const renderRankedList = (text) => {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length || !lines.every((line) => /^\d+\.\s+/.test(line))) return null;

    return (
      <ol className="list-decimal list-inside space-y-1">
        {lines.map((line, idx) => {
          const content = line.replace(/^\d+\.\s+/, '');
          const parts = content.split(' | ').map((part) => part.trim()).filter(Boolean);
          const [title, ...rest] = parts;
          return (
            <li key={idx}>
              <span>{truncate(title, 140)}</span>
              {rest.length > 0 && (
                <ul className="list-disc list-inside ml-4 mt-0.5 space-y-0.5">
                  {rest.map((item, itemIdx) => (
                    <li key={itemIdx}>{truncate(item, 160)}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    );
  };
  const formatMetricValue = (key, value) => {
    if (typeof value !== 'number') {
      return renderRankedList(value) || truncate(String(value), 200);
    }

    if (
      key === 'current_cvr'
      || key === 'baseline_cvr'
      || key === 'current_atc_rate'
      || key === 'baseline_atc_rate'
    ) {
      return `${(value * 100).toFixed(2)}%`;
    }

    if (key.endsWith('_delta_pct')) {
      return `${value.toFixed(2)}%`;
    }

    return value.toFixed(2);
  };
  const formatMetaValue = (key, value) => {
    if (value == null) return '';

    if (key === 'window' || key === 'baselineWindow') {
      let rangeValue = value;
      if (typeof value === 'string') {
        try {
          rangeValue = JSON.parse(value);
        } catch {
          rangeValue = value;
        }
      }

      if (rangeValue && typeof rangeValue === 'object') {
        const start = rangeValue.start ? new Date(rangeValue.start) : null;
        const end = rangeValue.end ? new Date(rangeValue.end) : null;

        const isValidStart = start && !Number.isNaN(start.getTime());
        const isValidEnd = end && !Number.isNaN(end.getTime());

        if (isValidStart && isValidEnd) {
          const range = `${format(start, 'MMM d, yyyy HH:mm')} → ${format(end, 'MMM d, yyyy HH:mm')}`;
          const suffix = rangeValue.type ? ` (${rangeValue.type})` : '';
          return `${range}${suffix}`;
        }
      }
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  };

  const finalInsight = run?.context?.scratch?.finalInsight
    || run?.nodeOutputs
      ?.map((output) => output?.result?.delta?.scratch?.finalInsight)
      .filter(Boolean)
      .at(-1)
    || null;
  const finalInsightMeta = run?.context?.scratch?.finalInsightMeta
    || run?.nodeOutputs
      ?.map((output) => output?.result?.delta?.scratch?.finalInsightMeta)
      .filter(Boolean)
      .at(-1)
    || null;
  const finalInsightEmail = run?.context?.scratch?.finalInsightEmail
    || run?.nodeOutputs
      ?.map((output) => output?.result?.delta?.scratch?.finalInsightEmail)
      .filter(Boolean)
      .at(-1)
    || null;
  const hasSidebarContent = Boolean(run?.context?.meta || finalInsight || finalInsightMeta || finalInsightEmail);
  const metricGroups = Object.entries(run?.metrics || {}).reduce((groups, [key, value]) => {
    const normalizedKey = key.toLowerCase();
    const group = normalizedKey.includes('order')
      ? 'Orders'
      : normalizedKey.includes('session')
        ? 'Sessions and activity'
        : normalizedKey.includes('cvr') || normalizedKey.includes('rate')
          ? 'Conversion rates'
          : 'Breakdowns and other metrics';
    (groups[group] ||= []).push([key, value]);
    return groups;
  }, {});

  return (
    <div>
      {/* Back Link */}
      <Link
        to={`/workflows/${workflowId}/runs`}
        className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back to Runs
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
            {getStatusIcon(run?.status)}
            Run Details
          </h1>
          <p className="text-gray-500 mt-1 font-mono text-sm">{runId}</p>
        </div>
        <Badge status={run?.status?.toLowerCase()}>
          {run?.status}
        </Badge>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Execution Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <dt className="text-sm text-gray-500">Workflow</dt>
              <dd className="font-medium">{workflowId}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Version</dt>
              <dd className="font-medium">v{run?.version}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Duration</dt>
              <dd className="font-medium">{getDuration()}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Started</dt>
              <dd className="font-medium">
                {run?.startedAt ? format(new Date(run.startedAt), 'HH:mm:ss') : '-'}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {Object.keys(metricGroups).length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Run Metrics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {Object.entries(metricGroups).map(([group, entries]) => (
              <section key={group}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  {group}
                </h2>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {entries.map(([key, value]) => (
                    <div key={key} className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <dt className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                        {formatFieldLabel(key)}
                      </dt>
                      <dd className="break-words text-sm font-semibold text-gray-900">
                        {formatMetricValue(key, value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className={`${hasSidebarContent ? 'lg:col-span-2' : 'lg:col-span-3'} min-w-0 space-y-6`}>
          <RunStateDecisionCard run={run} />

          {/* Execution Trace */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Clock className="w-4 h-4 mr-2" />
                Execution Trace ({run?.executionTrace?.length || 0} steps)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {run?.executionTrace?.length === 0 ? (
                <p className="text-sm text-gray-500">No execution trace available</p>
              ) : (
                <div className="space-y-2">
                  {run?.executionTrace?.map((step, idx) => (
                    <div
                      key={idx}
                      className="flex items-center p-3 bg-gray-50 rounded-lg border border-gray-200"
                    >
                      <span className="w-6 h-6 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-medium mr-3">
                        {idx + 1}
                      </span>
                      <div className="flex-1">
                        <p className="font-medium text-gray-900">
                          {typeof step === 'string' ? step : step.nodeId || step.id}
                        </p>
                        {step.type && (
                          <p className="text-sm text-gray-500">{step.type}</p>
                        )}
                      </div>
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Node Outputs */}
          <Card>
            <CardHeader>
              <CardTitle>Node Outputs ({run?.nodeOutputs?.length || 0})</CardTitle>
            </CardHeader>
            <CardContent>
              {run?.nodeOutputs?.length === 0 ? (
                <p className="text-sm text-gray-500">No node outputs available</p>
              ) : (
                <div className="space-y-3">
                  {run?.nodeOutputs?.map((output, idx) => (
                    <div key={idx} className="border border-gray-200 rounded-lg">
                      <button
                        onClick={() => toggleNode(`output-${idx}`)}
                        className="w-full flex items-center justify-between p-3 hover:bg-gray-50"
                      >
                        <span className="font-medium">
                          {output.nodeId || `Node ${idx + 1}`}
                        </span>
                        <span className="text-sm text-gray-500">
                          {expandedNodes[`output-${idx}`] ? '▼' : '▶'}
                        </span>
                      </button>
                      {expandedNodes[`output-${idx}`] && (
                        <div className="p-3 border-t border-gray-200 bg-gray-50">
                          <StructuredValue value={output} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        {hasSidebarContent && <div className="min-w-0 space-y-6">
          {/* Context - Meta */}
          {run?.context?.meta && (
            <Card>
              <CardHeader>
                <CardTitle>Context Meta</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-2 text-sm">
                  {Object.entries(run.context.meta).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-gray-500">{key}</dt>
                      <dd className="font-medium break-all">
                        {formatMetaValue(key, value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          )}

          {/* Final Insight */}
          {finalInsight && (
            <Card className="border-primary-200 bg-primary-50">
              <CardHeader>
                <CardTitle className="text-primary-800">💡 Insight</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-primary-900 font-medium mb-3 whitespace-pre-wrap">
                  {finalInsight.summary}
                </div>
                
                {finalInsight.details && finalInsight.details.length > 0 && (
                   <div className="space-y-3 mb-3">
                      {finalInsight.details.map((detail, idx) => (
                        <InsightDetail key={idx} detail={detail} compact />
                      ))}
                   </div>
                )}

                {finalInsight.confidence !== undefined && finalInsight.confidence !== null && (
                  <div className="pt-2 border-t border-primary-200/50 flex justify-between items-center">
                    <span className="text-xs text-primary-700">Confidence Score</span>
                    <span className="text-xs font-bold text-primary-800">
                        {(Number(finalInsight.confidence) * 100).toFixed(0)}%
                    </span>
                  </div>
                )}

                {finalInsightMeta && (
                  <div className="pt-3 mt-3 border-t border-primary-200/50 space-y-1.5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-xs text-primary-700">Detail Rendering</span>
                      <span className="text-xs font-semibold text-primary-800">
                        {finalInsightMeta.renderedDetailsCount}/{finalInsightMeta.configuredDetailsCount}
                      </span>
                    </div>
                    <div className="text-xs text-primary-800">
                      Configured details: {finalInsightMeta.detailsConfigured ? 'yes' : 'no'}
                    </div>
                    {finalInsightMeta.detailsConfigured && finalInsightMeta.detailsRenderedEmpty && (
                      <div className="text-xs text-amber-700">
                        All configured detail templates rendered empty for this run.
                      </div>
                    )}
                  </div>
                )}

                {finalInsightEmail && (
                  <div className="pt-3 mt-3 border-t border-primary-200/50 space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-xs text-primary-700">Email Delivery</span>
                      <span className={`text-xs font-semibold ${
                        finalInsightEmail.status === 'sent'
                          ? 'text-green-700'
                          : finalInsightEmail.status === 'skipped'
                            ? 'text-amber-700'
                            : 'text-red-700'
                      }`}>
                        {finalInsightEmail.status}
                      </span>
                    </div>
                    {Array.isArray(finalInsightEmail.to) && finalInsightEmail.to.length > 0 && (
                      <div className="text-xs text-primary-800 break-all">
                        To: {finalInsightEmail.to.join(', ')}
                      </div>
                    )}
                    {finalInsightEmail.subject && (
                      <div className="text-xs text-primary-800 break-words">
                        Subject: {finalInsightEmail.subject}
                      </div>
                    )}
                    {finalInsightEmail.error && (
                      <div className="text-xs text-red-700 break-words">
                        Error: {finalInsightEmail.error}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>}
      </div>
    </div>
  );
}
