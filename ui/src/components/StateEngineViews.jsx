import { format, formatDistanceToNow } from 'date-fns';
import { Badge, Card, CardHeader, CardContent, CardTitle } from './ui';
import { useWorkflowState, useWorkflowStateEvaluations } from '../api/hooks';
import {
  STATE_LABELS,
  NOTIFICATION_REASON_LABELS,
  SUPPRESSION_LABELS,
  DELIVERY_LABELS,
  withStateConfigDefaults,
  isLowerWorse,
} from '../utils/stateConfig';

export function StateBadge({ state }) {
  if (!state) return <span className="text-gray-400">-</span>;
  return <Badge status={state.toLowerCase()}>{STATE_LABELS[state] || state}</Badge>;
}

function formatValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '-';
}

function formatDate(value, pattern = 'MMM d, HH:mm') {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : format(date, pattern);
}

// One line saying what the engine decided to do about notifying.
function describeNotification(notification, deliveryStatus) {
  if (!notification) return '-';
  if (notification.reason) {
    const label = NOTIFICATION_REASON_LABELS[notification.reason] || notification.reason;
    return `${label} · ${DELIVERY_LABELS[deliveryStatus] || deliveryStatus || ''}`;
  }
  if (notification.candidate_reason) {
    const label = NOTIFICATION_REASON_LABELS[notification.candidate_reason] || notification.candidate_reason;
    return `${label} held: ${SUPPRESSION_LABELS[notification.suppressed_by] || notification.suppressed_by}`;
  }
  return 'No notification';
}

// Cooldown clock is paused during quiet hours on the server, so this is a
// wall-clock upper bound, labelled as such.
function describeCooldown(cooldown) {
  if (!cooldown?.started_at || !cooldown.duration_minutes) return 'None';
  const endsBy = new Date(new Date(cooldown.started_at).getTime() + cooldown.duration_minutes * 60 * 1000);
  if (endsBy <= new Date()) return `${STATE_LABELS[cooldown.state] || cooldown.state} cooldown elapsed`;
  return `${STATE_LABELS[cooldown.state] || cooldown.state}, ${cooldown.duration_minutes}m, ends ~${formatDistanceToNow(endsBy, { addSuffix: true })}`;
}

// Run detail: what the state engine decided for this execution.
export function RunStateDecisionCard({ run }) {
  const evaluation = run?.stateEvaluation;
  const error = run?.stateEvaluationError;
  if (!evaluation && !error) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert State</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="text-sm text-red-600 mb-3">State engine error: {error}</p>
        )}
        {evaluation && (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">Transition</dt>
              <dd className="flex items-center gap-1 mt-1">
                <StateBadge state={evaluation.previous_state} />
                <span className="text-gray-400">→</span>
                <StateBadge state={evaluation.resulting_state} />
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Finding</dt>
              <dd className="font-medium mt-1">
                {evaluation.conclusive === false ? (
                  <span className="text-gray-500">Inconclusive: no {evaluation.finding?.metric || 'metric'} value</span>
                ) : (
                  <>
                    {formatValue(evaluation.finding?.value)}%
                    {evaluation.finding?.thresholds && (
                      <span className="text-gray-500 font-normal">
                        {' '}(alert {evaluation.finding.thresholds.normal}, critical {evaluation.finding.thresholds.critical})
                      </span>
                    )}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Notification</dt>
              <dd className="font-medium mt-1">
                {describeNotification(evaluation.notification, evaluation.delivery_status)}
              </dd>
              {evaluation.telegram_status && (
                <dd className="text-xs text-gray-500 mt-1">
                  Telegram: {DELIVERY_LABELS[evaluation.telegram_status] || evaluation.telegram_status}
                </dd>
              )}
              {evaluation.delivery_error && (
                <dd className="text-xs text-red-600 mt-1">{evaluation.delivery_error}</dd>
              )}
            </div>
            <div>
              <dt className="text-gray-500">Trigger</dt>
              <dd className="font-medium mt-1 capitalize">{evaluation.trigger_type || '-'}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// Workflow detail: current incident state plus recent decisions.
export function WorkflowStateCard({ workflowId, definition }) {
  const { data: state, isLoading } = useWorkflowState(workflowId);
  const { data: evaluations = [] } = useWorkflowStateEvaluations(workflowId, { limit: 5 });
  const config = withStateConfigDefaults(definition?.state_config);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert State</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-gray-500">Loading state…</p>
        ) : (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">Current state</dt>
              <dd className="mt-1"><StateBadge state={state?.state || 'NORMAL'} /></dd>
            </div>
            <div>
              <dt className="text-gray-500">Cooldown</dt>
              <dd className="font-medium mt-1">{describeCooldown(state?.cooldown)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Last evaluated</dt>
              <dd className="font-medium mt-1">{formatDate(state?.last_evaluated_at)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Last alert</dt>
              <dd className="font-medium mt-1">{formatDate(state?.last_alert_at)}</dd>
            </div>
          </dl>
        )}

        <p className="text-xs text-gray-500">
          {config.finding.metric}: alert at {config.thresholds.normal}{isLowerWorse(config.thresholds) ? ' or lower' : ' or higher'},
          {' '}critical at {config.thresholds.critical}. Cooldowns {config.cooldown.triggered_minutes}m / {config.cooldown.critical_minutes}m.
          {config.quiet_hours.enabled ? ` Quiet ${config.quiet_hours.start}–${config.quiet_hours.end}.` : ''}
          {' '}Returning to normal does not send an email.
        </p>

        {evaluations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Trigger</th>
                  <th className="py-2 pr-4 font-medium">Transition</th>
                  <th className="py-2 pr-4 font-medium">Value</th>
                  <th className="py-2 font-medium">Notification</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((row) => (
                  <tr key={row.executionId} className="border-b border-gray-100 last:border-0">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDate(row.executed_at)}</td>
                    <td className="py-2 pr-4">{row.trigger_type || '-'}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {row.conclusive === false ? (
                        <span className="text-gray-500">Inconclusive</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <StateBadge state={row.previous_state} />
                          <span className="text-gray-400">→</span>
                          <StateBadge state={row.resulting_state} />
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{formatValue(row.finding?.value)}</td>
                    <td className="py-2">
                      {describeNotification(row.notification, row.delivery?.status)}
                      {row.delivery?.telegram?.status && (
                        <span className="text-xs text-gray-500"> · Telegram {DELIVERY_LABELS[row.delivery.telegram.status] || row.delivery.telegram.status}</span>
                      )}
                      {row.delivery?.rolled_back && (
                        <span className="text-xs text-gray-500"> (cooldown restored)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
