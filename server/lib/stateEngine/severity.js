const { STATES } = require('./defaults');

function toFiniteNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The finding value is the metric exactly as the run produced it -- a CVR drop of
// 17% is -17. Returns conclusive: false when the run never produced a usable value,
// which the caller treats as "no observation": no state change.
function resolveFindingValue(context, finding = {}) {
  const metric = finding.metric;
  const raw = context?.metrics?.[metric];
  const value = toFiniteNumber(raw);
  if (!metric || value == null) {
    return { metric: metric || null, value: null, conclusive: false };
  }
  return { metric, value, conclusive: true };
}

// Which way is "worse" comes from the thresholds themselves, so a workflow can't
// declare a direction that contradicts its own numbers: critical below normal means
// lower is worse (a drop, e.g. -10 / -20); critical above normal means higher is
// worse (a rise, e.g. 10 / 20).
function isLowerWorse(thresholds) {
  return thresholds.critical < thresholds.normal;
}

// Inclusive boundaries: with -10 / -20, -10 is TRIGGERED and -20 is CRITICAL.
function classifySeverity(value, thresholds) {
  if (isLowerWorse(thresholds)) {
    if (value <= thresholds.critical) return STATES.CRITICAL;
    if (value <= thresholds.normal) return STATES.TRIGGERED;
    return STATES.NORMAL;
  }
  if (value >= thresholds.critical) return STATES.CRITICAL;
  if (value >= thresholds.normal) return STATES.TRIGGERED;
  return STATES.NORMAL;
}

module.exports = {
  resolveFindingValue,
  classifySeverity,
  isLowerWorse
};
