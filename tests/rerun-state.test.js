const test = require('node:test');
const assert = require('node:assert/strict');

const mergeContext = require('../engine/MergeContext');
const { normalizeRerunContext } = require('../lib/timeWindowUtils');
const { renderEmail } = require('../server/lib/renderEmail');

const window = {
  start: '2026-08-17 00:00:00',
  end: '2026-08-18 00:00:00'
};

test('reruns retain inputs but clear all derived analysis state', () => {
  const rerun = normalizeRerunContext({
    meta: {
      tenantId: 'tenant-1', timezone: 'Asia/Kolkata', window, baselineWindow: window,
      emailBranding: { displayName: 'Old Brand', primaryColor: '#112233' },
      currency: 'USD'
    },
    filters: [{ dimension: 'utm_source', operator: '=', value: 'google' }],
    metrics: { bottom_utm_sources: 'old result' },
    breakdowns: { bottom_utm_sources: [{ display_value: 'old source' }] },
    rootCausePath: [{ dimension: 'utm_source', value: 'old source' }],
    scratch: { finalInsight: { summary: 'old insight' } },
    executionTrace: [{ nodeId: 'old_node' }]
  }, 'Asia/Kolkata');

  assert.deepEqual(rerun.filters, [{ dimension: 'utm_source', operator: '=', value: 'google' }]);
  assert.deepEqual(rerun.metrics, {});
  assert.deepEqual(rerun.breakdowns, {});
  assert.deepEqual(rerun.rootCausePath, []);
  assert.deepEqual(rerun.scratch, {});
  assert.deepEqual(rerun.executionTrace, []);
  assert.equal(rerun.meta.emailBranding, undefined);
  assert.equal(rerun.meta.currency, undefined);
});

test('a later breakdown output replaces an earlier result with the same key', () => {
  const context = { filters: [], metrics: {}, rootCausePath: [], scratch: {}, breakdowns: {} };
  mergeContext(context, {
    breakdowns: { bottom_utm_sources: [{ display_value: 'old source' }] }
  });
  mergeContext(context, {
    breakdowns: { bottom_utm_sources: [{ display_value: 'google' }] }
  });

  assert.deepEqual(context.breakdowns.bottom_utm_sources, [{ display_value: 'google' }]);
});

test('report email renders only the current bottom-source breakdown', () => {
  const currentSources = [
    { display_value: 'google', current: { sessions: 21811 }, deltas: { cvr_delta_pct: -30.07 } },
    { display_value: 'PM_Facebook_Ad', current: { sessions: 51614 }, deltas: { cvr_delta_pct: -3.12 } },
    { display_value: 'facebook', current: { sessions: 5240 }, deltas: { cvr_delta_pct: -27.08 } }
  ];
  const context = {
    meta: { tenantId: 'tenant-1', timezone: 'Asia/Kolkata', window, baselineWindow: window },
    metrics: {},
    breakdowns: { bottom_utm_sources: currentSources },
    scratch: {}
  };
  const template = {
    preset: 'performance_report_v1',
    eyebrow: 'Report', title: 'Daily',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [],
    tables: [{
      title: 'Bottom performers', source: 'breakdowns.bottom_utm_sources', tone: 'negative', limit: 3,
      columns: [
        { label: 'Source', path: 'display_value', format: 'text' },
        { label: 'Sessions', path: 'current.sessions', format: 'integer' },
        { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' }
      ]
    }]
  };

  const rendered = renderEmail({ format: 'report', context, template, subject: 'Report' });
  assert.match(rendered.html, /google/);
  assert.match(rendered.html, /PM_Facebook_Ad/);
  assert.match(rendered.html, /facebook/);
  assert.doesNotMatch(rendered.html, /old source/);
});
