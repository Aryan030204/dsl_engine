// Client-side mirror of server/lib/stateEngine/defaults.js and the state_config
// checks in server/validation/workflowDefinition.js, so the builder can catch
// mistakes before a save round-trip. The server stays the source of truth.

export const WORKFLOW_PURPOSES = {
  RCA: 'rca',
  DAILY_INSIGHT: 'daily_insight',
};

// Signed percent deltas produced by the metric_compare node.
export const STATE_METRIC_OPTIONS = [
  { value: 'cvr_delta_pct', label: 'CVR change %' },
  { value: 'sessions_delta_pct', label: 'Sessions change %' },
  { value: 'orders_delta_pct', label: 'Orders change %' },
  { value: 'atc_sessions_delta_pct', label: 'ATC sessions change %' },
  { value: 'atc_rate_delta_pct', label: 'ATC rate change %' },
  { value: 'sales_delta_pct', label: 'Total sales change % (needs "sales" in Metric Compare)' },
  { value: 'aov_delta_pct', label: 'AOV change % (needs "aov" in Metric Compare)' },
];

// Thresholds are signed values of the metric. Critical below normal alerts on drops
// (-10 / -20); critical above normal alerts on rises (10 / 20).
export const DEFAULT_STATE_CONFIG = {
  enabled: false,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' },
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getWorkflowPurpose(definition = {}) {
  return definition?.workflow_purpose === WORKFLOW_PURPOSES.DAILY_INSIGHT
    ? WORKFLOW_PURPOSES.DAILY_INSIGHT
    : WORKFLOW_PURPOSES.RCA;
}

export function getWorkflowPurposeLabel(definition = {}) {
  return getWorkflowPurpose(definition) === WORKFLOW_PURPOSES.DAILY_INSIGHT ? 'Daily insight' : 'RCA alert';
}

export function isStateEngineEnabled(definition = {}) {
  return getWorkflowPurpose(definition) === WORKFLOW_PURPOSES.RCA && definition?.state_config?.enabled === true;
}

// Early saved configs had finding.direction "drop" with positive magnitudes (15/25)
// and a recovery section. Rewrites them to the current signed shape, the same
// conversion the server applies, so re-saving an old workflow can't flip a drop
// alert into a rise alert or fail validation on the removed fields.
function toSignedThresholds(source) {
  const thresholds = { ...DEFAULT_STATE_CONFIG.thresholds, ...(source.thresholds || {}) };
  const legacyDrop = source.finding?.direction === 'drop'
    && typeof thresholds.normal === 'number' && thresholds.normal >= 0
    && typeof thresholds.critical === 'number' && thresholds.critical >= 0;
  return legacyDrop
    ? { normal: 0 - thresholds.normal, critical: 0 - thresholds.critical }
    : thresholds;
}

// Fills any missing section with its default so the form always has a value to show,
// and keeps only the fields the current state_config supports.
export function withStateConfigDefaults(config) {
  const source = config || {};
  return {
    enabled: source.enabled === true,
    finding: { metric: source.finding?.metric || DEFAULT_STATE_CONFIG.finding.metric },
    thresholds: toSignedThresholds(source),
    cooldown: { ...DEFAULT_STATE_CONFIG.cooldown, ...(source.cooldown || {}) },
    quiet_hours: { ...DEFAULT_STATE_CONFIG.quiet_hours, ...(source.quiet_hours || {}) },
  };
}

export function isLowerWorse(thresholds = {}) {
  return thresholds.critical < thresholds.normal;
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isWholeAtLeast = (value, min) => Number.isInteger(value) && value >= min;

export function getStateConfigErrors(workflowJson = {}) {
  const errors = [];
  const config = workflowJson.state_config;
  if (!config || config.enabled !== true) return errors;

  if (getWorkflowPurpose(workflowJson) === WORKFLOW_PURPOSES.DAILY_INSIGHT) {
    errors.push('Alert state cannot be enabled for a daily insight workflow');
    return errors;
  }

  // Mirrors the server (hasNotificationTarget): the state engine notifies whoever the
  // workflow's own email, email-enabled insight, and messaging nodes would have.
  const nonEmpty = (list) => Array.isArray(list) && list.length > 0;
  const hasRecipients = (workflowJson.nodes || []).some((node) => {
    if (node.type === 'email') return nonEmpty(node.to);
    if (node.type === 'insight') return Boolean(node.email?.enabled) && nonEmpty(node.email.to);
    if (node.type === 'messaging') {
      return (Boolean(node.channels?.email) && nonEmpty(node.email?.to))
        || (Boolean(node.channels?.telegram) && nonEmpty(node.telegram?.users));
    }
    return false;
  });
  if (!hasRecipients) {
    errors.push('Alert state needs someone to notify: turn on "Email Insight" on an insight node, or add an Email or Messaging node with recipients');
  }

  const { normal, critical } = config.thresholds || {};
  if (!isNumber(normal)) errors.push('Alert threshold must be a number');
  if (!isNumber(critical)) errors.push('Critical threshold must be a number');
  if (isNumber(normal) && isNumber(critical) && normal === critical) {
    errors.push('Critical threshold must differ from the alert threshold');
  }

  ['triggered_minutes', 'critical_minutes'].forEach((field) => {
    if (!isWholeAtLeast(config.cooldown?.[field], 0)) {
      errors.push(`${field === 'critical_minutes' ? 'Critical' : 'Triggered'} cooldown must be a whole number of minutes`);
    }
  });

  if (config.quiet_hours?.enabled) {
    if (!HHMM_RE.test(config.quiet_hours.start || '') || !HHMM_RE.test(config.quiet_hours.end || '')) {
      errors.push('Quiet hours must be HH:MM (24h)');
    }
  }
  return errors;
}

export const STATE_LABELS = {
  NORMAL: 'Normal',
  TRIGGERED: 'Triggered',
  CRITICAL: 'Critical',
};

export const NOTIFICATION_REASON_LABELS = {
  INITIAL_TRIGGER: 'Initial trigger',
  REMINDER: 'Reminder',
  ESCALATION: 'Escalation',
  DE_ESCALATION: 'Improved',
};

export const SUPPRESSION_LABELS = {
  cooldown: 'Cooldown active',
  quiet_hours: 'Quiet hours',
};

export const DELIVERY_LABELS = {
  none: 'No notification',
  suppressed: 'Suppressed',
  pending: 'Pending',
  sending: 'Sending',
  sent: 'Sent',
  partial: 'Partly sent',
  failed: 'Failed',
  uncertain: 'Uncertain',
};
