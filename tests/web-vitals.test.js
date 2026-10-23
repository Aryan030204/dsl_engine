const test = require('node:test');
const assert = require('node:assert/strict');

const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { renderEmail } = require('../server/lib/renderEmail');

const WINDOW = { start: '2026-10-22 00:00:00', end: '2026-10-23 00:00:00' };

async function run(rows, def = {}, meta = {}, mvRows = []) {
  const original = queryExecutor.execute;
  const captured = [];
  queryExecutor.execute = async (query) => {
    captured.push(query);
    return { rows: query.meta.type === 'page_path_cvr' ? mvRows : rows };
  };
  try {
    const result = await recursiveDimensionBreakdownNode(
      { id: 'wv', type: 'recursive_dimension_breakdown', analysis_mode: 'web_vitals', ...def },
      { meta: { tenantId: 'TMC', window: WINDOW, ...meta }, scratch: {} }
    );
    return { result, captured };
  } finally {
    queryExecutor.execute = original;
  }
}

const row = (page, sessions, performance, extra = {}) => ({
  page_name: page, url: `https://s.test/s.test/products/${page}`, sessions, performance, snapshots: 3, ...extra
});
const mv = (page, sessions, cvr, product = '1') => ({ landing_page_path: `/products/${page}`, product_id: product, sessions, cvr_pct: cvr });

test('the web vitals query reads whole days, ranks by the day\'s highest sessions and averages the vitals', () => {
  const { sql, params, meta } = queryBuilder.buildWebVitalsQuery({ tenantId: 'TMC', window: WINDOW, limit: 50 });
  assert.deepEqual(params, ['2026-10-22', '2026-10-23']);
  assert.match(sql, /`date` >= \? AND `date` < \?/);
  assert.match(sql, /MAX\(sessions\) AS sessions/);
  assert.match(sql, /AVG\(performance\) AS performance/);
  assert.match(sql, /GROUP BY page_name/);
  assert.match(sql, /ORDER BY MAX\(sessions\) DESC/);
  assert.match(sql, /LIMIT 50\b/);
  assert.doesNotMatch(sql, /inp|lcp|fcp|ttfb/i);
  assert.equal(meta.tenantId, 'TMC');
});

test('a window that ends mid-day includes that day', () => {
  const { sql, params } = queryBuilder.buildWebVitalsQuery({
    tenantId: 'TMC', window: { start: '2026-10-23 00:00:00', end: '2026-10-23 14:00:00' }
  });
  assert.match(sql, /`date` <= \?/);
  assert.deepEqual(params, ['2026-10-23', '2026-10-23']);
});

test('the web vitals query rejects missing tenant or bad windows', () => {
  assert.throws(() => queryBuilder.buildWebVitalsQuery({ window: WINDOW }), /tenantId/);
  assert.throws(() => queryBuilder.buildWebVitalsQuery({ tenantId: 'TMC', window: { start: 'x', end: 'y' } }), /YYYY-MM-DD/);
});

test('the node ranks by full-day sessions from the sessions table and adds CVR', async () => {
  const { result, captured } = await run(
    [row('mini-perfume-box', 9000, '51.3'), row('fab-five-kit', 5000, 95), row('slow', 100, 20)],
    { web_vitals_top_k: 2 }, {},
    [mv('fab-five-kit', 14000, 4.6955), mv('mini-perfume-box', 12000, 3.6298)]
  );
  assert.equal(result.status, 'pass');
  const pages = result.delta.breakdowns.web_vitals_pages;
  // fab-five-kit overtakes mini-perfume-box once full-day sessions are used
  assert.deepEqual(pages.map((p) => [p.rank, p.page_name, p.sessions]), [[1, 'fab-five-kit', 14000], [2, 'mini-perfume-box', 12000]]);
  assert.equal(pages[0].cvr_pct, 4.7);
  assert.equal(pages[1].performance, 51);
  assert.equal(pages[1].rating, 'Needs improvement');
  assert.equal(pages[0].rating, 'Good');
  assert.equal(pages[0].lcp, undefined);
  assert.deepEqual(captured[1].params[2], ['/products/mini-perfume-box', '/products/fab-five-kit', '/products/slow']);
});

test('pages the sessions table does not credit (home) have no CVR; unknown pages keep snapshot sessions', async () => {
  const { result } = await run(
    [{ ...row('the-man-company.myshopify.com', 8000, 48), url: 'https://the-man-company.myshopify.com/the-man-company.myshopify.com/' }, row('new-page', 700, 30)],
    {}, {},
    [{ landing_page_path: '/', product_id: null, sessions: 8375, cvr_pct: 0 }]
  );
  const [home, fresh] = result.delta.breakdowns.web_vitals_pages;
  assert.equal(home.path, '/');
  assert.equal(home.sessions, 8375);
  assert.equal(home.cvr_pct, null);
  assert.equal(fresh.sessions, 700);
  assert.equal(fresh.cvr_pct, null);
});

test('the sessions/CVR query weights multi-day CVR by sessions and needs paths', () => {
  const { sql, params } = queryBuilder.buildPagePathCvrQuery({ tenantId: 'TMC', window: WINDOW, paths: ['/', '/', '/products/a'] });
  assert.match(sql, /SUM\(sessions \* conversion_rate_pct\) \/ NULLIF\(SUM\(sessions\), 0\)/);
  assert.match(sql, /mv_product_sessions_by_path_daily/);
  assert.deepEqual(params, ['2026-10-22', '2026-10-23', ['/', '/products/a']]);
  assert.throws(() => queryBuilder.buildPagePathCvrQuery({ tenantId: 'TMC', window: WINDOW, paths: [] }), /paths/);
});

test('the node honours output_key and fails clearly with no rows or no window', async () => {
  const custom = await run([row('a', 10, 80)], { output_key: 'top_pages' });
  assert.ok(custom.result.delta.breakdowns.top_pages);

  const empty = await run([]);
  assert.equal(empty.result.status, 'fail');
  assert.match(empty.result.reason, /no web vitals rows for 2026-10-22/);

  const noWindow = await run([row('a', 1, 1)], {}, { window: undefined });
  assert.equal(noWindow.result.status, 'fail');
});

test('validation accepts web_vitals mode and checks its settings', () => {
  const base = (extra) => ({
    name: 'wv', workflow_id: 'wf_wv', version: '1.0', workflow_type: 'root_cause_analysis',
    nodes: [{ id: 'wv', type: 'recursive_dimension_breakdown', analysis_mode: 'web_vitals', ...extra }]
  });
  const errorsFor = (extra) => (validateWorkflowDefinition(base(extra)).errors || []).filter((e) => /web vitals|analysis_mode/.test(e));
  assert.deepEqual(errorsFor({ web_vitals_top_k: 5 }), []);
  assert.ok(errorsFor({ web_vitals_top_k: 0 }).length);
  assert.ok(errorsFor({ web_vitals_top_k: 51 }).length);
  assert.ok(errorsFor({ output_key: '  ' }).length);
});

test('the report table shows performance and CVR, with a dash for a page without CVR', async () => {
  const { result } = await run(
    [row('mini-perfume-box', 9000, 51), { ...row('home', 8000, 95), url: 'https://s.test/s.test/' }], {}, {},
    [mv('mini-perfume-box', 12000, 3.6298), { landing_page_path: '/', product_id: null, sessions: 8375, cvr_pct: 0 }]
  );
  const html = renderEmail({
    format: 'report',
    template: {
      preset: 'performance_report_v1',
      period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
      metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer' }],
      tables: [{
        title: 'Top pages', source: 'breakdowns.web_vitals_pages', limit: 5,
        columns: [
          { label: 'Page', path: 'page_name', format: 'text' },
          { label: 'Sessions', path: 'sessions', format: 'integer' },
          { label: 'Performance', path: 'performance', format: 'integer' },
          { label: 'Rating', path: 'rating', format: 'status' },
          { label: 'CVR', path: 'cvr_pct', format: 'percent' }
        ]
      }]
    },
    context: {
      meta: { tenantId: 'TMC', brandName: 'TMC', timezone: 'Asia/Kolkata', window: WINDOW, baselineWindow: { start: '2026-10-21 00:00:00', end: '2026-10-22 00:00:00' } },
      metrics: { current_sessions: 1000 },
      breakdowns: result.delta.breakdowns,
      scratch: {}
    },
    subject: 'Web vitals'
  }).html;
  assert.match(html, /12,000/);
  assert.match(html, />3\.63%</);
  assert.match(html, />—</);
  assert.match(html, /background:#ffedd5;color:#ea580c[^>]*>Needs improvement</);
  assert.match(html, /background:#d1fae5;color:#059669[^>]*>Good</);
});

test('scheduler windows (UTC instants) are read as the brand\'s local days', () => {
  // previous complete day for an Asia/Kolkata brand: 22 Oct 00:00 IST -> 23 Oct 00:00 IST
  const { params, sql } = queryBuilder.buildWebVitalsQuery({
    tenantId: 'TMC', timezone: 'Asia/Kolkata',
    window: { start: '2026-10-21T18:30:00.000Z', end: '2026-10-22T18:30:00.000Z' }
  });
  assert.deepEqual(params, ['2026-10-22', '2026-10-23']);
  assert.match(sql, /`date` < \?/);

  // day-to-date at 14:00 IST on the 23rd includes the 23rd
  const partial = queryBuilder.buildWebVitalsQuery({
    tenantId: 'TMC', timezone: 'Asia/Kolkata',
    window: { start: '2026-10-22T18:30:00.000Z', end: '2026-10-23T08:30:00.000Z' }
  });
  assert.deepEqual(partial.params, ['2026-10-23', '2026-10-23']);
  assert.match(partial.sql, /`date` <= \?/);
});
