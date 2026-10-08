const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFindingValue, classifySeverity, isLowerWorse } = require('../server/lib/stateEngine/severity');
const { normalizeStateConfig } = require('../server/lib/stateEngine/defaults');

const drop = { normal: -10, critical: -20 };
const rise = { normal: 10, critical: 20 };

test('the finding value is the raw signed metric', () => {
  const finding = resolveFindingValue({ metrics: { cvr_delta_pct: -17 } }, { metric: 'cvr_delta_pct' });
  assert.equal(finding.conclusive, true);
  assert.equal(finding.value, -17);
});

test('numeric strings are accepted', () => {
  assert.equal(resolveFindingValue({ metrics: { cvr_delta_pct: '-20.5' } }, { metric: 'cvr_delta_pct' }).value, -20.5);
});

test('critical below normal means lower is worse (drop)', () => {
  assert.equal(isLowerWorse(drop), true);
  assert.equal(classifySeverity(-9.99, drop), 'NORMAL');
  assert.equal(classifySeverity(5, drop), 'NORMAL');
  assert.equal(classifySeverity(-10, drop), 'TRIGGERED');
  assert.equal(classifySeverity(-17, drop), 'TRIGGERED');
  assert.equal(classifySeverity(-19.99, drop), 'TRIGGERED');
  assert.equal(classifySeverity(-20, drop), 'CRITICAL');
  assert.equal(classifySeverity(-35, drop), 'CRITICAL');
});

test('critical above normal means higher is worse (rise)', () => {
  assert.equal(isLowerWorse(rise), false);
  assert.equal(classifySeverity(9.99, rise), 'NORMAL');
  assert.equal(classifySeverity(-40, rise), 'NORMAL');
  assert.equal(classifySeverity(10, rise), 'TRIGGERED');
  assert.equal(classifySeverity(20, rise), 'CRITICAL');
});

test('thresholds may straddle zero', () => {
  const nearZero = { normal: 0, critical: -5 };
  assert.equal(classifySeverity(0.5, nearZero), 'NORMAL');
  assert.equal(classifySeverity(0, nearZero), 'TRIGGERED');
  assert.equal(classifySeverity(-5, nearZero), 'CRITICAL');
});

test('a legacy drop config with positive magnitudes is read as its signed equivalent', () => {
  const legacy = normalizeStateConfig({ finding: { metric: 'cvr_delta_pct', direction: 'drop' }, thresholds: { normal: 15, critical: 25 } });
  assert.deepEqual(legacy.thresholds, { normal: -15, critical: -25 });
  assert.equal(legacy.finding.direction, undefined);
  assert.equal(classifySeverity(-17, legacy.thresholds), 'TRIGGERED');

  const signed = normalizeStateConfig({ thresholds: { normal: -10, critical: -20 } });
  assert.deepEqual(signed.thresholds, { normal: -10, critical: -20 });
});

test('a missing or non-finite metric is inconclusive', () => {
  const finding = { metric: 'cvr_delta_pct' };
  assert.equal(resolveFindingValue({ metrics: {} }, finding).conclusive, false);
  assert.equal(resolveFindingValue({}, finding).conclusive, false);
  assert.equal(resolveFindingValue({ metrics: { cvr_delta_pct: null } }, finding).conclusive, false);
  assert.equal(resolveFindingValue({ metrics: { cvr_delta_pct: NaN } }, finding).conclusive, false);
  assert.equal(resolveFindingValue({ metrics: { cvr_delta_pct: 'unknown' } }, finding).conclusive, false);
  assert.equal(resolveFindingValue({ metrics: { cvr_delta_pct: '' } }, finding).conclusive, false);
});
