const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { renderEmail } = require('../server/lib/renderEmail');
const { renderTelegramImages } = require('../server/lib/renderTelegramImage');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { tint, shade } = require('../server/lib/colorUtils');
const { formatDelta, formatShare, formatDay } = require('../server/lib/renderDashboardEmail');

const loadHelpers = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/reportTemplates.js')).href);
const loadEditorCheck = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/workflowValidation.js')).href);

const LIME = '#66c61c';

const lowest = [
  { product_id: '1', product_title: 'WISAL DHAHAB', sku: 'WISALDHAHAB_EDP_14ML, WISALDHAHAB_EDP_50ML', status: 'Critical', doh_7d: 0, drr_7d: 11.58 },
  { product_id: '2', product_title: 'MUKHALLAT ALWAFA Non-Alcoholic Attar 12ML for Men & Women', sku: 'MUKHALLATALWAFA_CONCENTRATED_12ML', status: 'Low stock', doh_7d: 9.4, drr_7d: 11 },
  { product_id: '3', product_title: 'Oud Series Perfume', sku: 'OUDSERIES_EDP_90ML', status: 'Healthy', doh_7d: 31.2, drr_7d: 444.71 },
];

function context(overrides = {}) {
  return {
    meta: {
      tenantId: 'AJMAL', brandName: 'Ajmal perfumes', timezone: 'Asia/Kolkata', currency: 'INR',
      window: { start: '2026-10-20T18:30:00.000Z', end: '2026-10-21T18:30:00.000Z' },
      baselineWindow: { start: '2026-10-19T18:30:00.000Z', end: '2026-10-20T18:30:00.000Z' },
      ...(overrides.meta || {}),
    },
    metrics: {
      current_sales: 2159414.67, sales_delta_pct: 0.58, current_cvr: 0.0111, cvr_delta_pct: -0.13,
      current_sessions: 121034, sessions_delta_pct: 3.59, current_orders: 1346, orders_delta_pct: 3.46,
      current_atc_sessions: 121034, atc_sessions_delta_pct: 3.59, current_aov: 1604.32, aov_delta_pct: -2.79,
    },
    breakdowns: {
      top: [{ display_value: 'facebook', current: { sessions: 2554, orders: 28, cvr: 0.011 }, deltas: { cvr_delta_pct: 87.13 } }],
      bottom: [
        { display_value: 'google', current: { sessions: 28673, orders: 409, cvr: 0.0143 }, deltas: { cvr_delta_pct: -7.55 } },
        { display_value: 'PM_Facebook_Ad', current: { sessions: 64560, orders: 577, cvr: 0.0089 }, deltas: { cvr_delta_pct: -0.05 } },
      ],
    },
    scratch: overrides.scratch !== undefined ? overrides.scratch : {
      inventoryReport: { products: lowest, lowest_doh_products: lowest, analyzed_count: 49, critical_count: 7, medium_count: 9, healthy_count: 33, no_velocity_count: 0, critical_threshold_days: 7, healthy_threshold_days: 15, report_top_k: 3, as_of: '2026-10-21T00:00:00.000Z' },
    },
  };
}

// the editor's default dashboard template, pointed at this test's data
async function template(overrides = {}) {
  const { createDashboardTemplate } = await loadHelpers();
  const base = createDashboardTemplate();
  base.tables[0].source = 'breakdowns.top';
  base.tables[1].source = 'breakdowns.bottom';
  return { ...base, ...overrides };
}

const render = async (tpl, ctx = context(), branding) => renderEmail({ format: 'report', template: tpl, context: ctx, branding, subject: 'Daily report' });

// ---------------------------------------------------------------- helpers

test('brand colors: tint keeps a share of the color, shade darkens it', () => {
  assert.equal(tint('#66c61c', 0), '#ffffff');
  assert.equal(tint('#66c61c', 1), '#66c61c');
  assert.equal(tint('#66c61c', 0.08), '#f3faed');
  assert.equal(shade('#66c61c', 0), '#66c61c');
  assert.equal(shade('#66c61c', 1), '#000000');
  assert.equal(shade('#66c61c', 0.4), '#3d7711');
  assert.equal(tint('not a color', 0.5), '#ffffff');
  assert.equal(shade('not a color', 0.5), '#000000');
});

test('number formatting: typographic minus, share rounding, sentence-case dates', () => {
  assert.equal(formatDelta(0.58), '+0.58%');
  assert.equal(formatDelta(-0.13), '−0.13%');
  assert.equal(formatDelta(0), '0.00%');
  assert.equal(formatDelta('x'), '');
  assert.equal(formatShare(2.11), '2%');
  assert.equal(formatShare(53.34), '53%');
  assert.equal(formatShare(0.4), '0.4%');
  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(NaN), '—');
  assert.equal(formatDay('2026-10-20T18:30:00.000Z', 'Asia/Kolkata'), '21 Oct 2026');
  assert.equal(formatDay('2026-09-05T00:00:00.000Z', 'UTC'), '05 Sep 2026');
});

// ---------------------------------------------------------------- the email

test('the header carries the brand, label and both dates without a tagline', async () => {
  const { html, subject } = await render(await template());
  assert.equal(subject, 'Daily report');
  assert.match(html, />AJMAL PERFUMES</);
  assert.doesNotMatch(html, /YOUR DATA\. DECODED\./);
  assert.match(html, />Daily Report</);
  assert.match(html, />21 Oct 2026</);
  assert.match(html, />vs 20 Oct 2026</);
  assert.equal(html.split('<!doctype html>').length - 1, 1);
});

test('hero cards: the first is tinted, deltas get a green or red pill with the typographic minus', async () => {
  const { html } = await render(await template());
  assert.match(html, /TOTAL SALES|Total Sales/i);
  assert.match(html, />₹21,59,414\.67</);
  assert.match(html, />1\.11%</);
  // first hero = brand tint background, second = plain white with a border
  assert.ok(html.includes(`background:${tint(LIME, 0.08)};border:1px solid ${tint(LIME, 0.08)}`));
  assert.ok(html.includes('background:#ffffff;border:1px solid #e5e7eb;border-radius:18px'));
  // up = brand pill, down = red pill
  assert.ok(html.includes(`background:${tint(LIME, 0.22)};color:${shade(LIME, 0.5)}`));
  assert.ok(html.includes('background:#fef2f2;color:#b91c1c'));
  assert.match(html, /↑ \+0\.58%/);
  assert.match(html, /↓ −0\.13%/);
});

test('the KPI strip shows the remaining cards, with AOV in whole rupees and colored deltas', async () => {
  const { html } = await render(await template());
  for (const label of ['Sessions', 'Orders', 'ATC Sessions', 'AOV']) assert.ok(html.includes(`>${label}</div>`), label);
  assert.match(html, />121,034</);
  assert.match(html, />₹1,604</);
  assert.doesNotMatch(html, />₹1,604\.32</);
  assert.ok(html.includes(`color:${shade(LIME, 0.4)};white-space:nowrap;">↑ +3.59%`), 'up delta in the dark brand green');
  assert.ok(html.includes('color:#d22725;white-space:nowrap;">↓ −2.79%'), 'down delta in red');
});

test('performer tables: heading colors by tone, share as a bar and a percentage, change with arrows', async () => {
  const { html } = await render(await template());
  assert.ok(html.includes(`text-transform:uppercase;color:${shade(LIME, 0.4)};">Top Performers`));
  assert.ok(html.includes('text-transform:uppercase;color:#dc2626;">Bottom Performers'));
  assert.match(html, />facebook</);
  assert.match(html, />PM_Facebook_Ad</);
  // share of total sessions: 2554/121034 = 2%, 28673/121034 = 24%, 64560/121034 = 53%
  assert.match(html, />2%</);
  assert.match(html, />24%</);
  assert.match(html, />53%</);
  assert.ok(html.includes('↑ +87.13%'));
  assert.ok(html.includes('↓ −7.55%'));
});

test('share bars are drawn relative to the biggest share in the whole report', async () => {
  const { html } = await render(await template());
  const widths = [...html.matchAll(/width:([\d.]+)%;height:6px;background:(#[0-9a-f]{6})/g)].map((m) => [Number(m[1]), m[2]]);
  assert.equal(widths.length, 3);
  const max = (64560 / 121034) * 100;
  const expected = [(2554 / 121034) * 100 / max * 100, (28673 / 121034) * 100 / max * 100, 100];
  widths.forEach(([width], index) => assert.ok(Math.abs(width - Math.max(4, expected[index])) < 0.06, `bar ${index}: ${width} vs ${expected[index]}`));
  assert.equal(widths[0][1], LIME, 'the top table bar uses the brand color');
  assert.equal(widths[1][1], '#ef2929', 'the bottom table bars are red');
  assert.equal(widths[2][0], 100, 'the largest share fills the track');
});

test('a share of a zero total shows a dash instead of breaking', async () => {
  const ctx = context();
  ctx.metrics.current_sessions = 0;
  const { html } = await render(await template(), ctx);
  assert.ok(html.includes('>—<'));
});

test('inventory health: product count, proportional segments, counts, badge and status-colored DOH', async () => {
  const { html } = await render(await template());
  assert.match(html, />Inventory health</);
  assert.match(html, />49 products</);
  const widths = [...html.matchAll(/width="([\d.]+)%" style="width:[\d.]+%;height:18px;background:(#[0-9a-f]{6})/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(widths.map((w) => w[1]), ['#dc2626', '#ea580c', '#059669']);
  assert.deepEqual(widths.map((w) => Math.round(w[0])), [Math.round(7 / 49 * 100), Math.round(9 / 49 * 100), Math.round(33 / 49 * 100)]);
  assert.match(html, /color:#b91c1c;vertical-align:middle;">7</);
  assert.match(html, /color:#c2410c;vertical-align:middle;">9</);
  assert.match(html, /color:#047857;vertical-align:middle;">33</);
  assert.match(html, />Act first · lowest days on hand</);
  assert.match(html, />WISALDHAHAB_EDP_14ML, WISALDHAHAB_EDP_50ML</);
  // DOH colored by status
  assert.match(html, /color:#b91c1c;white-space:nowrap;">0\.00</);
  assert.match(html, /color:#c2410c;white-space:nowrap;">9\.40</);
  assert.match(html, /color:#047857;white-space:nowrap;">31\.20</);
});

test('the HIGHEST RUN RATE badge sits on the listed product with the highest DRR, whose DRR is bold', async () => {
  const { html } = await render(await template());
  assert.equal(html.split('HIGHEST RUN RATE').length - 1, 1);
  const badgeAt = html.indexOf('HIGHEST RUN RATE');
  assert.ok(badgeAt > html.indexOf('Oud Series Perfume') && badgeAt < html.indexOf('OUDSERIES_EDP_90ML'), 'badge next to Oud Series Perfume');
  assert.match(html, /font-weight:800;color:#0f172a;white-space:nowrap;">444\.71</);
  assert.match(html, /font-weight:400;color:#0f172a;white-space:nowrap;">11\.58</);
});

test('the footer shows the timezone and the brand footer text', async () => {
  const { html } = await render(await template());
  assert.match(html, />Asia\/Kolkata</);
  assert.match(html, />Powered by Datum Analytics</);
});

test('every green is derived from the tenant\'s brand color', async () => {
  const blue = '#2563eb';
  const { html } = await render(await template(), context({ meta: { emailBranding: { primaryColor: blue, displayName: 'Blue Co', footerText: 'Blue footer', tagline: 'Be blue' } } }));
  assert.ok(html.includes(`background:${tint(blue, 0.08)};border:1px solid ${tint(blue, 0.08)}`), 'hero tint');
  assert.ok(html.includes(`background:${blue};vertical-align:middle;margin-right:9px;`), 'hero dot');
  assert.ok(html.includes(`color:${shade(blue, 0.4)};`), 'dark shade for labels / headings');
  assert.ok(html.includes(`background:${blue};border-radius:3px`), 'share bar fill');
  assert.doesNotMatch(html, /#66c61c/i, 'no default lime left over');
  assert.match(html, />BLUE CO</);
  assert.match(html, />BE BLUE</);
  assert.match(html, />Blue footer</);
});

test('a node branding override and a logo are honoured', async () => {
  const { html } = await render(await template(), context(), { displayName: 'Override', logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#e11d48' });
  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/logo\.png" alt="Override"/);
  assert.doesNotMatch(html, />OVERRIDE</);
  assert.ok(html.includes(`background:${tint('#e11d48', 0.08)}`));
});

test('text from the data is escaped', async () => {
  const ctx = context({ meta: { brandName: '<script>alert(1)</script> Co' } });
  ctx.breakdowns.top[0].display_value = '"><img src=x onerror=alert(1)>';
  const tpl = await template({ headerLabel: '<b>Report</b>' });
  const { html } = await render(tpl, ctx);
  assert.doesNotMatch(html, /<script>alert|<img src=x|<b>Report<\/b>/);
  assert.match(html, /&lt;SCRIPT&gt;/);
  assert.match(html, /&lt;b&gt;Report&lt;\/b&gt;/);
});

test('hero count decides how many cards are large; the rest go to the strip', async () => {
  const heroCards = (html) => html.split('class="dsh-hero"').length - 1;
  const stripCells = (html) => html.split('class="dsh-cell ').length - 1;
  const none = (await render(await template({ heroCount: 0 }))).html;
  assert.equal(heroCards(none), 0);
  assert.equal(stripCells(none), 8, '6 cards in two rows of four, padded');
  const one = (await render(await template({ heroCount: 1 }))).html;
  assert.equal(heroCards(one), 1);
  assert.ok(one.includes('width:100.00%'), 'a single hero card is full width');
  const three = (await render(await template({ heroCount: 3 }))).html;
  assert.equal(heroCards(three), 3);
});

test('the strip wraps into rows of four, with a rule between rows, and any number of cards', async () => {
  const tpl = await template({ heroCount: 0 });
  tpl.metrics = Array.from({ length: 10 }, (_, i) => ({ label: `M${i}`, value: 'metrics.current_sessions', format: 'integer', icon: 'metric' }));
  const { html } = await render(tpl);
  const strip = html.slice(html.indexOf('class="dsh-strip-inner"'), html.indexOf('class="dsh-section"'));
  assert.equal(strip.split('<table').length - 1, 3, 'ten cards = three rows');
  assert.equal(strip.split('border-top:1px solid #e5e7eb').length - 1, 2);
  assert.equal(strip.split('class="dsh-cell ').length - 1, 12, 'the last row is padded to four cells');
});

test('phone styles are included: stacked header and hero cards, two-up strip, share bars dropped on small screens', async () => {
  const { html } = await render(await template());
  assert.match(html, /@media only screen and \(max-width: 600px\)/);
  assert.match(html, /@media only screen and \(max-width: 420px\)/);
  assert.match(html, /\.dsh-hero \{ display: block !important; width: 100% !important/);
  assert.match(html, /\.dsh-cell \{ display: inline-block !important; width: 50% !important/);
  assert.match(html, /\.dsh-table \{ table-layout: auto !important; \}/);
  assert.match(html, /\.dsh-bar-wrap \{ display: none !important; \}/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /max-width:784px/);
});

test('the inventory block is optional, and required data is checked when it is on', async () => {
  const off = await template({ inventory: { enabled: false } });
  assert.doesNotMatch((await render(off)).html, /Inventory health|HIGHEST RUN RATE/);
  const none = await template();
  delete none.inventory;
  assert.doesNotMatch((await render(none)).html, /Inventory health/);
  await assert.rejects(async () => render(await template(), context({ scratch: {} })), /missing inventory report data at scratch\.inventoryReport/);
});

test('inventory titles are configurable', async () => {
  const { html } = await render(await template({ inventory: { enabled: true, title: 'Stock health', listTitle: 'Restock these first' } }));
  assert.match(html, />Stock health</);
  assert.match(html, />Restock these first</);
});

test('a missing value fails loudly, a null one shows a dash', async () => {
  const ctx = context();
  ctx.metrics.current_aov = null;
  assert.ok((await render(await template(), ctx)).html.includes('>—<'));
  delete ctx.metrics.current_sales;
  await assert.rejects(async () => render(await template(), ctx), /missing required binding: metrics\.current_sales/);
});

test('the plain-text version carries the same content', async () => {
  const { text } = await render(await template());
  assert.match(text, /Total Sales: ₹21,59,414\.67 \(\+0\.58%\)/);
  assert.match(text, /AOV: ₹1,604 \(−2\.79%\)/);
  assert.match(text, /Top Performers/);
  assert.match(text, /google/);
  assert.match(text, /Inventory health: 49 products/);
  assert.match(text, /Critical: 7 \| Low stock: 9 \| Healthy: 33/);
  assert.match(text, /3\. Oud Series Perfume \| SKU OUDSERIES_EDP_90ML \| DRR 444\.71 \| DOH 31\.20 \| HIGHEST RUN RATE/);
  assert.match(text, /Asia\/Kolkata · Powered by Datum Analytics/);
});

test('the view model works for the drawn Telegram pages (no top-level inventory key)', async () => {
  const { viewModel } = await render(await template());
  assert.equal(viewModel.inventory, undefined);
  assert.equal(viewModel.inventorySection, undefined);
  assert.equal(viewModel.metrics.length, 6);
  assert.equal(viewModel.tables.length, 3, 'two performer tables plus the inventory list');
  const pages = await renderTelegramImages({ title: 'T', reportViewModel: viewModel, workflowName: 'W' });
  assert.ok(pages.length >= 1);
  pages.forEach((page) => assert.match(page, /^data:image\/jpeg;base64,/));
});

// ---------------------------------------------------------------- the older layouts still know the new formats

test('whole-rupee currency also works in the existing performance layout, and plain currency is unchanged', () => {
  const tpl = (format) => ({
    preset: 'performance_report_v1', eyebrow: 'E', title: 'T',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [{ label: 'AOV', value: 'metrics.current_aov', format, icon: 'aov' }],
    tables: [{ title: 'T', source: 'breakdowns.top', tone: 'neutral', limit: 1, columns: [{ label: 'Source', path: 'display_value', format: 'text' }] }],
  });
  const run = (format) => renderEmail({ format: 'report', template: tpl(format), context: context(), subject: 'S' }).html;
  assert.match(run('currency_whole'), />₹1,604</);
  assert.match(run('currency'), />₹1,604\.32</);
});

// ---------------------------------------------------------------- validation

const definition = (tpl, extraNodes = []) => ({
  workflow_type: 'root_cause_analysis', version: '1',
  trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['AJMAL'] },
  nodes: [
    { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', next: 'notify' },
    { id: 'notify', type: 'messaging', channels: { email: true, telegram: false }, format: 'report', subject: 'Report', template: tpl, email: { to: ['ops@example.com'] } },
    ...extraNodes,
  ],
});
const errorsFor = (tpl) => validateWorkflowDefinition(definition(tpl)).errors.filter((e) => /notify|template|metric|table|column/i.test(e));

test('the editor\'s default dashboard template passes the server validation', async () => {
  assert.deepEqual(errorsFor(await template()), []);
});

test('dashboard template rules', async () => {
  const bad = async (mutate, pattern) => {
    const tpl = await template();
    mutate(tpl);
    const errors = errorsFor(tpl);
    assert.ok(errors.some((e) => pattern.test(e)), `${pattern}: ${errors.join(' | ')}`);
  };
  await bad((t) => { t.heroCount = 4; }, /heroCount must be an integer from 0 to 3/);
  await bad((t) => { t.heroCount = 1.5; }, /heroCount/);
  await bad((t) => { t.headerLabel = ''; }, /headerLabel/);
  await bad((t) => { delete t.period; }, /period must be an object/);
  await bad((t) => { t.metrics = 'x'; }, /metrics must be an array/);
  await bad((t) => { t.metrics[0].format = 'nope'; }, /unsupported format/);
  await bad((t) => { t.metrics[0].format = 'share_bar'; }, /unsupported format/);
  await bad((t) => { t.metrics[0].colour = 'red'; }, /unsupported field/);
  await bad((t) => { t.tables.push(t.tables[0], t.tables[0], t.tables[0]); }, /at most four tables/);
  await bad((t) => { delete t.tables[0].columns[2].of; }, /of \(the total the share is taken of\)/);
  await bad((t) => { t.tables[0].columns[1].of = 'metrics.current_sessions'; }, /"of" is only for the share_bar format/);
  await bad((t) => { t.tables[0].columns[0].format = 'nope'; }, /unsupported format/);
  await bad((t) => { t.tables[0].limit = 0; }, /limit must be an integer/);
  await bad((t) => { t.inventory = { enabled: 'yes' }; }, /inventory\.enabled must be true or false/);
  await bad((t) => { t.inventory = { enabled: true, title: '' }; }, /inventory\.title must be a non-empty string/);
  await bad((t) => { t.inventory = { enabled: true, extra: 1 }; }, /unsupported field extra/);
  await bad((t) => { t.eyebrow = 'x'; }, /dashboard template contains unsupported field eyebrow/);
  await bad((t) => { t.metrics = []; t.tables = []; t.inventory = { enabled: false }; }, /must show something/);
});

test('any number of KPI cards is fine in the dashboard layout, and zero cards is fine when there is something else', async () => {
  const many = await template();
  many.metrics = Array.from({ length: 40 }, (_, i) => ({ label: `M${i}`, value: 'metrics.current_sessions', format: 'integer' }));
  assert.deepEqual(errorsFor(many), []);
  const none = await template();
  none.metrics = [];
  assert.deepEqual(errorsFor(none), []);
});

test('share_bar and the dashboard fields are refused by the older performance layout', async () => {
  const { createDashboardTemplate } = await loadHelpers();
  const dash = createDashboardTemplate();
  const performance = {
    preset: 'performance_report_v1', eyebrow: 'E', title: 'T',
    period: dash.period, metrics: dash.metrics.slice(0, 2), tables: dash.tables.slice(0, 1),
  };
  const errors = validateWorkflowDefinition(definition(performance)).errors.filter((e) => /column|format/.test(e));
  assert.ok(errors.some((e) => /unsupported format/.test(e)), errors.join(' | '));
  const withInventory = validateWorkflowDefinition(definition({ ...performance, tables: [{ ...dash.tables[0], columns: [dash.tables[0].columns[0]] }], inventory: { enabled: true } })).errors;
  assert.ok(withInventory.some((e) => /unsupported field inventory/.test(e)), withInventory.join(' | '));
});

test('the inventory block follows the same ordering rule as the other inventory data', async () => {
  const tpl = await template();
  const inventoryErrors = (nodes) => validateWorkflowDefinition({ ...definition(tpl), nodes }).errors.filter((e) => /inventory/i.test(e));
  const mail = { id: 'notify', type: 'messaging', channels: { email: true, telegram: false }, format: 'report', subject: 'R', template: tpl, email: { to: ['ops@example.com'] } };

  assert.deepEqual(inventoryErrors([{ id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', next: 'notify' }, mail]), []);
  assert.ok(inventoryErrors([mail])[0].includes('no inventory breakdown node'));
  assert.ok(inventoryErrors([{ ...mail, next: 'inv' }, { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory' }])[0].includes('runs before the inventory breakdown node'));

  const off = { ...mail, template: { ...tpl, inventory: { enabled: false } } };
  assert.deepEqual(inventoryErrors([off]), [], 'no inventory block, no inventory node needed');

  const { getInventorySectionErrors } = await loadEditorCheck();
  assert.equal(getInventorySectionErrors({ nodes: [mail] }).length, 1, 'the editor check agrees');
  assert.deepEqual(getInventorySectionErrors({ nodes: [{ id: 'inv', analysis_mode: 'inventory', next: 'notify' }, mail] }), []);
});

// ---------------------------------------------------------------- editor defaults

test('the default dashboard template matches the layout: two hero cards, four strip cells, two tables, inventory on', async () => {
  const { createDashboardTemplate, DASHBOARD_SHARE_TOTAL_PATH } = await loadHelpers();
  const t = createDashboardTemplate();
  assert.equal(t.preset, 'dashboard_report_v1');
  assert.equal(t.heroCount, 2);
  assert.deepEqual(t.metrics.map((m) => m.label), ['Total Sales', 'Conversion Rate', 'Sessions', 'Orders', 'ATC Sessions', 'AOV']);
  assert.equal(t.metrics.find((m) => m.label === 'AOV').format, 'currency_whole');
  assert.equal(t.metrics.find((m) => m.label === 'ATC Sessions').value, 'metrics.current_atc_sessions');
  assert.deepEqual(t.tables.map((x) => [x.title, x.tone]), [['Top Performers', 'positive'], ['Bottom Performers', 'negative']]);
  assert.deepEqual(t.tables[0].columns.map((c) => c.label), ['Source', 'Sessions', 'Share', 'Orders', 'CVR', 'Change']);
  assert.equal(t.tables[0].columns[2].of, DASHBOARD_SHARE_TOTAL_PATH);
  assert.equal(t.inventory.enabled, true);
  // every call is a fresh, independent object the editor can change
  t.metrics[0].label = 'Changed';
  t.tables[0].columns[0].label = 'Changed';
  const again = createDashboardTemplate();
  assert.equal(again.metrics[0].label, 'Total Sales');
  assert.equal(again.tables[0].columns[0].label, 'Source');
});
