// Workflow state engine (docs/workflow-state-engine.md). Shared constants, default
// config/state, and the small predicates every other stateEngine module keys off.

const STATES = Object.freeze({
  NORMAL: 'NORMAL',
  TRIGGERED: 'TRIGGERED',
  CRITICAL: 'CRITICAL'
});

const REASONS = Object.freeze({
  INITIAL_TRIGGER: 'INITIAL_TRIGGER',
  REMINDER: 'REMINDER',
  ESCALATION: 'ESCALATION',
  DE_ESCALATION: 'DE_ESCALATION'
});

const WORKFLOW_PURPOSES = Object.freeze({
  RCA: 'rca',
  DAILY_INSIGHT: 'daily_insight'
});

const AUTOMATIC_TRIGGER_TYPES = new Set(['cron', 'event']);

// Thresholds are signed values of the metric itself. A drop workflow uses negative
// thresholds with critical below normal (-10 / -20); a rise workflow uses critical
// above normal (10 / 20). See severity.classifySeverity.
const DEFAULT_STATE_CONFIG = Object.freeze({
  enabled: false,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' }
});

function getWorkflowPurpose(definition = {}) {
  return definition?.workflow_purpose === WORKFLOW_PURPOSES.DAILY_INSIGHT
    ? WORKFLOW_PURPOSES.DAILY_INSIGHT
    : WORKFLOW_PURPOSES.RCA;
}

// Daily insight/report workflows never go through the state engine, whatever their
// state_config says -- they must send every run, inside quiet hours included.
function isStateEngineEnabled(definition = {}) {
  if (getWorkflowPurpose(definition) === WORKFLOW_PURPOSES.DAILY_INSIGHT) return false;
  return definition?.state_config?.enabled === true;
}

function isAutomaticTrigger(triggerType) {
  return AUTOMATIC_TRIGGER_TYPES.has(triggerType);
}

// Early versions of state_config had finding.direction with positive magnitudes
// ("drop" + 15/25). Versions saved that way still execute, so a legacy drop config
// is converted to the signed form it meant (-15/-25) rather than silently flipping
// into a rise alert. Rise configs were already signed the same way.
function resolveThresholds(config) {
  const normal = Number(config.thresholds?.normal ?? DEFAULT_STATE_CONFIG.thresholds.normal);
  const critical = Number(config.thresholds?.critical ?? DEFAULT_STATE_CONFIG.thresholds.critical);
  if (config.finding?.direction === 'drop' && normal >= 0 && critical >= 0) {
    return { normal: 0 - normal, critical: 0 - critical };
  }
  return { normal, critical };
}

function normalizeStateConfig(config = {}) {
  const d = DEFAULT_STATE_CONFIG;
  return {
    enabled: config.enabled === true,
    finding: { metric: config.finding?.metric || d.finding.metric },
    thresholds: resolveThresholds(config),
    cooldown: {
      triggered_minutes: Number(config.cooldown?.triggered_minutes ?? d.cooldown.triggered_minutes),
      critical_minutes: Number(config.cooldown?.critical_minutes ?? d.cooldown.critical_minutes)
    },
    quiet_hours: {
      enabled: config.quiet_hours?.enabled === true,
      start: config.quiet_hours?.start || d.quiet_hours.start,
      end: config.quiet_hours?.end || d.quiet_hours.end
    }
  };
}

function defaultRuntimeState() {
  return {
    state: STATES.NORMAL,
    cooldown: null,
    last_evaluated_at: null,
    last_alert_at: null,
    last_execution_id: null,
    version: 0
  };
}

module.exports = {
  STATES,
  REASONS,
  WORKFLOW_PURPOSES,
  DEFAULT_STATE_CONFIG,
  getWorkflowPurpose,
  isStateEngineEnabled,
  isAutomaticTrigger,
  normalizeStateConfig,
  defaultRuntimeState
};
