// Alert storm protection: a daily quota plus an exceptional-deterioration bypass, applied
// AFTER the existing cooldown and quiet-hours gates (docs/workflow-state-engine.md). It
// only decides whether an otherwise-valid notification may go out; it never changes the
// state classification, cooldown or thresholds. Pure: plain objects in, plain objects out.
// The caller persists `sent`/`held` inside the same version-CAS write as the state
// transition, which is what makes the counters and latches concurrency-safe.

const { STATES } = require('./defaults');
const { isLowerWorse } = require('./severity');
const { localDayKey } = require('./localDay');

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function previousValueOf(prior) {
  const direct = num(prior?.last_value);
  if (direct !== null) return direct;
  return num(prior?.last_decision?.finding?.value);
}

// Counters/latches stored for another local day count as zero/unfired: the reset is lazy
// and aligned with the tenant-local calendar boundary.
function currentStorm(prior, day) {
  const stored = prior?.storm && prior.storm.day === day ? prior.storm : null;
  return {
    day,
    triggered_count: stored?.triggered_count || 0,
    critical_count: stored?.critical_count || 0,
    total_count: stored?.total_count || 0,
    absolute_fired: stored?.absolute_fired === true,
    difference_fired: stored?.difference_fired === true
  };
}

// candidate: resolveCandidate output (non-null). resultingState: TRIGGERED | CRITICAL.
function evaluateStorm({ resultingState, finding, prior, config, now, timezone }) {
  const storm = config.storm_protection;
  const day = localDayKey(now, timezone);
  const used = currentStorm(prior, day);
  const stateType = resultingState === STATES.CRITICAL ? 'critical' : 'triggered';

  const limits = storm.daily_limits;
  const usedByType = { triggered: used.triggered_count, critical: used.critical_count, total: used.total_count };
  let blockedBy = null;
  for (const type of [stateType, 'total']) {
    if (limits[type] != null && usedByType[type] >= limits[type]) { blockedBy = type; break; }
  }

  // Exceptional conditions are always evaluated for the audit trail, and only act as a
  // quota bypass when the quota is exhausted.
  const exc = storm.exceptional_alerts;
  const lowerWorse = isLowerWorse(config.thresholds);
  const current = finding.value;
  const previous = previousValueOf(prior);

  const absoluteMet = exc.enabled && exc.absolute.enabled
    && (lowerWorse ? current <= exc.absolute.value : current >= exc.absolute.value);
  const deterioration = previous === null ? null : (lowerWorse ? previous - current : current - previous);
  const differenceMet = exc.enabled && exc.difference.enabled && deterioration !== null
    && deterioration >= exc.difference.value;

  const reasons = [];
  if (absoluteMet && !used.absolute_fired) reasons.push('absolute_threshold');
  if (differenceMet && !used.difference_fired) reasons.push('difference_threshold');

  const allowed = blockedBy === null || reasons.length > 0;
  const exceptional = blockedBy !== null && reasons.length > 0;

  const audit = {
    enabled: true,
    day,
    suppressed_by: allowed ? null : 'daily_limit',
    limit_type: blockedBy,
    limit: blockedBy ? limits[blockedBy] : null,
    used: blockedBy ? usedByType[blockedBy] : null,
    counters: { ...usedByType },
    exceptional,
    exception_reasons: exceptional ? reasons : [],
    absolute: {
      enabled: Boolean(exc.enabled && exc.absolute.enabled),
      threshold: exc.absolute.value,
      value: current,
      met: Boolean(absoluteMet),
      latch_fired: used.absolute_fired
    },
    difference: {
      enabled: Boolean(exc.enabled && exc.difference.enabled),
      threshold: exc.difference.value,
      previous_value: previous,
      current_value: current,
      deterioration,
      met: Boolean(differenceMet),
      latch_fired: used.difference_fired
    },
    quota_bypassed: exceptional
  };

  // `held` is persisted when the notification is blocked (only the day rolls over);
  // `sent` when it goes out (counters advance, claimed latches latch).
  const sent = {
    ...used,
    [`${stateType}_count`]: used[`${stateType}_count`] + 1,
    total_count: used.total_count + 1,
    absolute_fired: used.absolute_fired || (exceptional && reasons.includes('absolute_threshold')),
    difference_fired: used.difference_fired || (exceptional && reasons.includes('difference_threshold'))
  };

  return { allowed, exceptional, reasons: exceptional ? reasons : [], audit, held: used, sent };
}

module.exports = { evaluateStorm, previousValueOf, currentStorm };
