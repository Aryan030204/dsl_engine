const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveBinding, renderBindingTemplate, isSafeBindingPath } = require('../server/lib/emailBindings');
const { renderEmail } = require('../server/lib/renderEmail');
const { renderInsightEmail } = require('../server/lib/renderInsightEmail');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const EmailNode = require('../nodes/EmailNode');
const WorkflowRunner = require('../engine/WorkflowRunner');

function context(overrides = {}) {
  return {
    meta: {
      tenantId: 'tenant-1',
      brandName: 'Acme',
      timezone: 'Asia/Kolkata',
      window: { start: '2026-08-12T18:30:00.000Z', end: '2026-08-13T18:30:00.000Z' },
      baselineWindow: { start: '2026-08-11T18:30:00.000Z', end: '2026-08-12T18:30:00.000Z' },
      emailBranding: { displayName: 'Tenant Brand', primaryColor: '#123456' },
    },
    metrics: { current_sessions: 18420, sessions_delta_pct: -8.4 },
    breakdowns: {
      top: [{ display_value: '<Facebook>', current: { sessions: 9004 }, deltas: { cvr_delta_pct: 12.8 } }]
    },
    scratch: {},
    ...overrides,
  };
}

function reportTemplate(source = 'breakdowns.top') {
  return {
    preset: 'performance_report_v1',
    eyebrow: 'UTM Source Report',
    title: 'Top & Bottom UTM Sources',
    description: 'Traffic performance.',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' }],
    tables: [{
      title: 'Top sources', source, tone: 'positive', limit: 3,
      columns: [
        { label: 'Source', path: 'display_value', format: 'text' },
        { label: 'Sessions', path: 'current.sessions', format: 'integer' },
        { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' },
      ]
    }]
  };
}

function workflowWithEmail(node) {
  return {
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['tenant-1'] },
    nodes: [node],
  };
}

test('safe bindings resolve own properties and reject prototype paths', () => {
  assert.deepEqual(resolveBinding({ metrics: { value: 12 } }, 'metrics.value'), { found: true, value: 12 });
  assert.equal(isSafeBindingPath('metrics.constructor.name'), false);
  assert.equal(resolveBinding({}, '__proto__.polluted').found, false);
  assert.equal(renderBindingTemplate('{{meta.brand}} report', { meta: { brand: 'Acme' } }), 'Acme report');
  assert.throws(() => renderBindingTemplate('{{meta.missing}}', { meta: {} }), /missing required binding/);
});

test('report rendering formats, escapes and applies node branding precedence', () => {
  const rendered = renderEmail({
    format: 'report', context: context(), template: reportTemplate(),
    branding: { displayName: 'Node Brand', primaryColor: '#abcdef' },
    subject: '{{meta.brandName}}: Daily report',
  });
  assert.equal(rendered.subject, 'Acme: Daily report');
  assert.match(rendered.html, /18,420/);
  assert.match(rendered.html, /-8\.40%/);
  assert.match(rendered.html, /&lt;Facebook&gt;/);
  assert.doesNotMatch(rendered.html, /<Facebook>/);
  assert.equal(rendered.viewModel.branding.displayName, 'Node Brand');
  assert.equal(rendered.viewModel.branding.primaryColor, '#abcdef');
  assert.match(rendered.text, /Current period:/);
  assert.match(rendered.text, /Comparison period:/);
});

test('tenant name becomes the report wordmark when no display-name branding is configured', () => {
  const ctx = context();
  ctx.meta.emailBranding = { primaryColor: '#123456' };
  const rendered = renderEmail({ format: 'report', context: ctx, template: reportTemplate(), subject: 'Report' });
  assert.equal(rendered.viewModel.branding.displayName, 'Acme');
});

test('an existing empty report table renders an empty state while a missing source fails', () => {
  const empty = context({ breakdowns: { top: [] } });
  assert.match(renderEmail({ format: 'report', context: empty, template: reportTemplate(), subject: 'Report' }).html, /No data available/);
  assert.throws(() => renderEmail({ format: 'report', context: context(), template: reportTemplate('breakdowns.missing'), subject: 'Report' }), /missing required binding/);
});

test('dedicated insight format reads finalInsight and keeps its exact configured subject', () => {
  const ctx = context({ scratch: { finalInsight: { summary: 'CVR dropped', details: [], confidence: 0.8 } } });
  const rendered = renderEmail({ format: 'insight', context: ctx, template: { insightSource: 'scratch.finalInsight' }, subject: '{{meta.brandName}} alert' });
  assert.equal(rendered.subject, 'Acme alert');
  assert.match(rendered.html, /CVR dropped/);
});

test('legacy insight renderer retains tenant-prefixed subjects', () => {
  const rendered = renderInsightEmail({ insight: { summary: 'Legacy' }, tenantId: 'T1', subjectTemplate: 'Alert' });
  assert.equal(rendered.subject, 'T1: Alert');
});

test('insight email colors payment increases, drops, and zero changes consistently', () => {
  const rendered = renderInsightEmail({
    insight: {
      summary: 'Payment mode changes',
      details: [{
        title: 'UTM Source',
        items: [
          '1. google | COD orders 15 -> 33 (increase 120.00%) | PPCOD orders 10 -> 10 (no change 0.00%) | Prepaid orders 47 -> 20 (drop -57.45%)'
        ]
      }]
    },
    tenantId: 'T1'
  });

  assert.match(rendered.html, /color:#047857 !important/);
  assert.match(rendered.html, /color:#b91c1c !important/);
  assert.match(rendered.html, /color:#475569 !important/);
  assert.match(rendered.html, /\+120\.00%/);
  assert.match(rendered.html, /-57\.45%/);
});

test('legacy insight nodes with inline email remain valid', () => {
  const workflow = workflowWithEmail({
    id: 'insight', type: 'insight', template: { summary: 'Legacy insight', details: [] },
    email: { enabled: true, subject: 'Legacy alert', to: ['ops@example.com'] }
  });
  assert.deepEqual(validateWorkflowDefinition(workflow), { ok: true, errors: [] });
});

test('partial-day report windows retain full ranges in plain text', () => {
  const ctx = context();
  ctx.meta.window.end = '2026-08-13T06:30:00.000Z';
  ctx.meta.baselineWindow.end = '2026-08-12T06:30:00.000Z';
  const rendered = renderEmail({ format: 'report', context: ctx, template: reportTemplate(), subject: 'Partial report' });
  assert.match(rendered.text, /Current period: 13 AUG 2026 – 13 AUG 2026 \(Asia\/Kolkata\)/);
  assert.match(rendered.text, /Comparison period: 12 AUG 2026 – 12 AUG 2026 \(Asia\/Kolkata\)/);
});

test('workflow validation accepts a report node and rejects unsafe or unsupported configuration', () => {
  const validNode = {
    id: 'email', type: 'email', format: 'report', to: ['ops@example.com'], subject: '{{meta.brandName}} report',
    template: reportTemplate(), branding: { logoUrl: 'https://example.com/logo.png', primaryColor: '#66c61c' }
  };
  assert.deepEqual(validateWorkflowDefinition(workflowWithEmail(validNode)), { ok: true, errors: [] });

  const invalid = structuredClone(validNode);
  invalid.subject = '{{meta["brandName"]}}';
  invalid.template.preset = 'unknown';
  invalid.template.tables[0].columns[0].path = '__proto__.value';
  invalid.template.tables[0].columns[0].expression = 'value * 100';
  invalid.branding.logoUrl = 'http://example.com/logo.png';
  const result = validateWorkflowDefinition(workflowWithEmail(invalid));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsafe binding/);
  assert.match(result.errors.join('\n'), /unsupported report preset/);
  assert.match(result.errors.join('\n'), /HTTPS URL/);
  assert.match(result.errors.join('\n'), /unsupported field expression/);
});

test('EmailNode records sent delivery without discarding scratch data', async () => {
  const ctx = context({ scratch: { finalInsight: { summary: 'Ready', details: [] }, keep: true } });
  const result = await EmailNode({
    id: 'mail', type: 'email', format: 'insight', to: ['ops@example.com'], subject: 'Report',
    template: { insightSource: 'scratch.finalInsight' }
  }, ctx, { emailSender: async () => ({ status: 'sent', messageId: 'message-1' }) });
  assert.equal(result.status, 'pass');
  assert.equal(result.delta.scratch.keep, true);
  assert.equal(result.delta.scratch.emailDeliveries.mail.messageId, 'message-1');
});

test('delivery failures use existing workflow on_fail termination', async () => {
  const workflow = workflowWithEmail({
    id: 'mail', type: 'email', format: 'insight', to: ['ops@example.com'], subject: 'Report',
    template: { insightSource: 'scratch.finalInsight' },
    on_fail: { action: 'terminate', reason: 'Report email could not be sent' }
  });
  const ctx = context({ scratch: { finalInsight: { summary: 'Ready', details: [] } } });
  const runner = new WorkflowRunner(workflow, { emailSender: async () => ({ status: 'failed', error: 'SMTP unavailable' }) });
  const result = await runner.executeWorkflow(ctx);
  assert.equal(result.status, 'terminated');
  assert.equal(result.reason, 'Report email could not be sent');
});

test('thrown sender errors are converted to node failures', async () => {
  const ctx = context({ scratch: { finalInsight: { summary: 'Ready', details: [] } } });
  const result = await EmailNode({
    id: 'mail', type: 'email', format: 'insight', to: ['ops@example.com'], subject: 'Report',
    template: { insightSource: 'scratch.finalInsight' }
  }, ctx, { emailSender: async () => { throw new Error('connection lost'); } });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /connection lost/);
});

test('report can show the insight summary as a takeaway under the metric cards', () => {
  const ctx = context({ scratch: { finalInsight: { summary: 'CVR fell -21.74% while orders moved -5.61% & <b>x</b>.' } } });
  const template = { ...reportTemplate(), insightSource: 'scratch.finalInsight' };
  const rendered = renderEmail({ format: 'report', context: ctx, template, subject: 'Report' });

  const cardsAt = rendered.html.indexOf('Sessions');
  const takeawayAt = rendered.html.indexOf('Key takeaway');
  const tableAt = rendered.html.indexOf('Top sources');
  assert.ok(cardsAt < takeawayAt && takeawayAt < tableAt);
  assert.match(rendered.html, /<span style="font-weight:800;color:#ef2929;">-21\.74%<\/span>/);
  assert.match(rendered.html, /&amp; &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(rendered.text, /Key takeaway: CVR fell -21\.74%/);
});

test('report without insightSource renders no takeaway, and a missing insight fails loudly', () => {
  assert.doesNotMatch(renderEmail({ format: 'report', context: context(), template: reportTemplate(), subject: 'R' }).html, /Key takeaway/);
  assert.throws(
    () => renderEmail({ format: 'report', context: context(), template: { ...reportTemplate(), insightSource: 'scratch.finalInsight' }, subject: 'R' }),
    /missing required binding: scratch\.finalInsight/
  );
});

test('validation accepts a report insightSource and rejects an unsafe one', () => {
  const node = (insightSource) => ({
    id: 'mail', type: 'email', format: 'report', to: ['ops@example.com'], subject: 'Report',
    template: { ...reportTemplate(), insightSource }
  });
  assert.equal(validateWorkflowDefinition(workflowWithEmail(node('scratch.finalInsight'))).ok, true);
  assert.ok(validateWorkflowDefinition(workflowWithEmail(node('__proto__.x'))).errors.some((e) => /insightSource/.test(e)));
});
