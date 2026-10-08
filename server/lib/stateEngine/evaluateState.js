const { STATES, REASONS, defaultRuntimeState, isAutomaticTrigger } = require('./defaults');
const { classifySeverity } = require('./severity');
const { isQuietMinute, effectiveElapsedMs } = require('./quietHours');

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePrior(prior) {
  const base = defaultRuntimeState();
  if (!prior) return base;
  return {
    ...base,
    ...prior,
    state: Object.values(STATES).includes(prior.state) ? prior.state : STATES.NORMAL,
    cooldown: prior.cooldown?.started_at ? prior.cooldown : null
  };
}

function cooldownMinutesFor(state, config) {
  if (state === STATES.CRITICAL) return config.cooldown.critical_minutes;
  if (state === STATES.TRIGGERED) return config.cooldown.triggered_minutes;
  return 0;
}

// Picks the notification a transition is a candidate for, and which gates apply.
//   cooldownState: whose cooldown duration gates this send (null = cooldown bypassed)
//   quietBypass:   true only for a direct NORMAL -> CRITICAL escalation
// Returning to NORMAL never notifies: there are no recovery emails.
function resolveCandidate({ prev, next }) {
  if (next === STATES.NORMAL) return null;

  if (next === STATES.CRITICAL) {
    if (prev === STATES.CRITICAL) {
      return { reason: REASONS.REMINDER, cooldownState: STATES.CRITICAL, quietBypass: false };
    }
    return { reason: REASONS.ESCALATION, cooldownState: null, quietBypass: prev === STATES.NORMAL };
  }

  // next === TRIGGERED
  if (prev === STATES.NORMAL) {
    return { reason: REASONS.INITIAL_TRIGGER, cooldownState: STATES.TRIGGERED, quietBypass: false };
  }
  if (prev === STATES.CRITICAL) {
    return { reason: REASONS.DE_ESCALATION, cooldownState: STATES.TRIGGERED, quietBypass: false };
  }
  return { reason: REASONS.REMINDER, cooldownState: STATES.TRIGGERED, quietBypass: false };
}

// Pure transition + notification decision. State is computed first and
// unconditionally; cooldown and quiet hours only ever decide notification.should_send.
// Plain objects in, plain objects out -- the caller owns persistence.
//
// finding: output of severity.resolveFindingValue (must be conclusive)
// config:  output of defaults.normalizeStateConfig
function evaluateState({ prior: rawPrior, finding, triggerType, now = new Date(), config, timezone = 'UTC' }) {
  const prior = normalizePrior(rawPrior);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();

  const prev = prior.state;
  const next = classifySeverity(finding.value, config.thresholds);
  const candidate = resolveCandidate({ prev, next });

  const quietActive = isQuietMinute(nowDate, config.quiet_hours, timezone);

  let cooldownActive = false;
  let effectiveElapsed = null;
  if (candidate?.cooldownState && prior.cooldown?.started_at) {
    const durationMs = cooldownMinutesFor(candidate.cooldownState, config) * 60 * 1000;
    effectiveElapsed = effectiveElapsedMs(prior.cooldown.started_at, nowDate, config.quiet_hours, timezone, durationMs);
    cooldownActive = durationMs > 0 && effectiveElapsed < durationMs;
  }

  let shouldSend = false;
  let suppressedBy = null;
  if (candidate) {
    if (cooldownActive) {
      suppressedBy = 'cooldown';
    } else if (quietActive && !candidate.quietBypass) {
      suppressedBy = 'quiet_hours';
    } else {
      shouldSend = true;
    }
  }

  // An escalation ignores cooldown; for the audit trail, only call that a bypass when
  // the existing cooldown was actually still running.
  let cooldownBypassed = false;
  if (candidate?.reason === REASONS.ESCALATION && prior.cooldown?.started_at) {
    const priorDurationMs = (prior.cooldown.duration_minutes || 0) * 60 * 1000;
    cooldownBypassed = priorDurationMs > 0
      && effectiveElapsedMs(prior.cooldown.started_at, nowDate, config.quiet_hours, timezone, priorDurationMs) < priorDurationMs;
  }

  // Only a sent notification starts a cooldown. A suppressed one -- and a return to
  // NORMAL -- leaves any running cooldown to expire on its own clock.
  const nextCooldown = shouldSend
    ? { state: next, duration_minutes: cooldownMinutesFor(next, config), started_at: nowIso }
    : prior.cooldown;

  return {
    previous_state: prev,
    resulting_state: next,
    trigger_type: triggerType || null,
    automatic: isAutomaticTrigger(triggerType),
    evaluated_at: nowIso,
    finding: {
      metric: finding.metric,
      value: finding.value,
      severity: next,
      thresholds: { ...config.thresholds }
    },
    notification: {
      candidate_reason: candidate?.reason || null,
      should_send: shouldSend,
      reason: shouldSend ? candidate.reason : null,
      suppressed_by: suppressedBy
    },
    cooldown: {
      active: cooldownActive,
      bypassed: cooldownBypassed,
      applicable_state: candidate?.cooldownState || null,
      effective_elapsed_ms: effectiveElapsed
    },
    quiet_hours: { active: quietActive, bypassed: Boolean(candidate?.quietBypass && quietActive) },
    // What notification bookkeeping looked like before this run, so a failed SMTP
    // send can hand its cooldown back -- see stateEngineService's rollback.
    prior_bookkeeping: {
      cooldown: prior.cooldown,
      last_alert_at: toIso(prior.last_alert_at)
    },
    next: {
      state: next,
      cooldown: nextCooldown,
      last_evaluated_at: nowIso,
      last_alert_at: shouldSend ? nowIso : toIso(prior.last_alert_at)
    }
  };
}

module.exports = {
  evaluateState,
  resolveCandidate,
  cooldownMinutesFor
};
