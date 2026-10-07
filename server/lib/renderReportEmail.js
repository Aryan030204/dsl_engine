const { resolveBinding } = require('./emailBindings');
const { resolveEmailBranding } = require('./emailBranding');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requireBinding(root, path) {
  const resolved = resolveBinding(root, path);
  if (!resolved.found || resolved.value === undefined || resolved.value === null) {
    throw new Error(`missing required binding: ${path}`);
  }
  return resolved.value;
}

// Money in the tenant's currency (Tenant.settings.currency, threaded onto
// context.meta.currency by workflowExecutionService). Falls back to a plain number
// when the code is missing or not a valid ISO currency.
function formatCurrency(number, currency) {
  if (currency) {
    try {
      return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
      }).format(number);
    } catch {
      // invalid currency code: fall through to a plain number
    }
  }
  return number.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Like requireBinding, but a path that resolves to null/undefined returns null
// instead of throwing -- only an unknown path is an error.
function requirePresentBinding(root, path) {
  const resolved = resolveBinding(root, path);
  if (!resolved.found) throw new Error(`missing required binding: ${path}`);
  return resolved.value ?? null;
}

function formatValue(value, format = 'text', { currency } = {}) {
  if (format === 'text') return String(value ?? '');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`value is not numeric for format ${format}`);
  if (format === 'integer') return Math.round(number).toLocaleString('en-US');
  if (format === 'decimal') return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'percent_ratio') return `${(number * 100).toFixed(2)}%`;
  if (format === 'percent') return `${number.toFixed(2)}%`;
  if (format === 'delta_percent') return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
  if (format === 'currency') return formatCurrency(number, currency);
  throw new Error(`unsupported value format: ${format}`);
}

function formatDate(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid report date: ${value}`);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: timezone || 'UTC'
  }).format(date).toUpperCase();
}

function formatRange(range, timezone) {
  return `${formatDate(range.start, timezone)} – ${formatDate(range.end, timezone)}`;
}

function buildReportViewModel({ context, template, branding }) {
  if (template?.preset !== 'performance_report_v1') {
    throw new Error(`unsupported report preset: ${template?.preset || 'missing'}`);
  }
  const timezone = context?.meta?.timezone || 'UTC';
  const currentPeriod = requireBinding(context, template.period.current);
  const comparisonPeriod = requireBinding(context, template.period.comparison);
  if (!currentPeriod?.start || !currentPeriod?.end || !comparisonPeriod?.start || !comparisonPeriod?.end) {
    throw new Error('report period bindings must resolve to start/end objects');
  }

  const currency = context?.meta?.currency;
  const metrics = template.metrics.map((item) => {
    // A card path that doesn't exist is a misconfiguration and still fails loudly,
    // but one that exists with no value (e.g. AOV or a delta when a window had zero
    // orders) is legitimate data and renders as a dash instead of failing the run.
    const rawValue = requirePresentBinding(context, item.value);
    const rawChange = item.change ? requirePresentBinding(context, item.change) : null;
    return {
      label: item.label,
      icon: item.icon || 'metric',
      value: rawValue == null ? '—' : formatValue(rawValue, item.format, { currency }),
      change: rawChange == null ? null : formatValue(rawChange, 'delta_percent'),
      changeValue: rawChange == null ? null : Number(rawChange),
    };
  });

  const tables = template.tables.map((table) => {
    const source = requireBinding(context, table.source);
    if (!Array.isArray(source)) throw new Error(`table source must resolve to an array: ${table.source}`);
    return {
      title: table.title,
      tone: table.tone || 'neutral',
      columns: table.columns.map((column) => ({ label: column.label })),
      rows: source.slice(0, table.limit).map((entry, index) => ({
        rank: index + 1,
        cells: table.columns.map((column) => {
          const rawValue = requireBinding(entry, column.path);
          return {
            value: formatValue(rawValue, column.format, { currency }),
            numericValue: column.format === 'delta_percent' ? Number(rawValue) : null,
            format: column.format,
          };
        })
      }))
    };
  });

  // Optional: the insight node's generated text, shown as a takeaway under the KPI
  // cards. Same binding convention as the insight email format's insightSource.
  let insight = null;
  if (template.insightSource) {
    const resolved = requireBinding(context, template.insightSource);
    if (typeof resolved !== 'object') throw new Error(`insight source must resolve to an insight: ${template.insightSource}`);
    insight = resolved.summary ? { summary: String(resolved.summary) } : null;
  }

  return {
    branding: resolveEmailBranding({
      displayName: context?.meta?.brandName,
      ...(context?.meta?.emailBranding || {}),
    }, branding),
    eyebrow: template.eyebrow,
    title: template.title,
    description: template.description || '',
    timezone,
    currentPeriod,
    comparisonPeriod,
    currentDate: formatDate(currentPeriod.start, timezone),
    comparisonDate: formatDate(comparisonPeriod.start, timezone),
    currentRange: formatRange(currentPeriod, timezone),
    comparisonRange: formatRange(comparisonPeriod, timezone),
    metrics,
    insight,
    tables,
  };
}

// Colors signed percentages in the takeaway the way the insight email does:
// red for negative, green for positive. Runs on already-escaped text, and the
// pattern only matches digits, signs, '.' and '%', so it can't break the escaping.
function highlightPercentages(escapedText) {
  return escapedText.replace(/([-+]?\d+(?:\.\d+)?%)/g, (match) => {
    const value = parseFloat(match);
    if (!Number.isFinite(value) || value === 0) return match;
    return `<span style="font-weight:800;color:${changeColor(value)};">${match}</span>`;
  });
}

function renderInsight(insight, primaryColor) {
  if (!insight) return '';
  return `<div style="margin-top:22px;padding:18px 20px;border:1px solid #e5e7eb;border-left:4px solid ${primaryColor};border-radius:8px;background:#fafafa;"><div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${primaryColor};">Key takeaway</div><div class="rpt-takeaway" style="margin-top:8px;font-size:16px;line-height:1.5;font-weight:600;color:#111827;">${highlightPercentages(escapeHtml(insight.summary))}</div></div>`;
}

// Phone overrides. Desktop layout lives in the inline styles; these only apply at
// <= 600px, in clients that honour <style> media queries (Gmail web and apps, Apple
// Mail, iOS Mail). Elsewhere the inline layout still holds: cards wrap and long
// values break instead of overflowing.
const REPORT_STYLES = `
@media only screen and (max-width: 600px) {
  .rpt-wrap { padding: 16px !important; }
  .rpt-divider { margin: 16px -16px 18px !important; }
  .rpt-head-cell { display: block !important; width: 100% !important; text-align: left !important; }
  .rpt-head-date { padding-top: 10px !important; }
  .rpt-brand { font-size: 18px !important; letter-spacing: .14em !important; }
  .rpt-title { font-size: 28px !important; }
  .rpt-desc { font-size: 14px !important; margin: 12px 0 18px !important; }
  .rpt-kpi-card { width: 50% !important; padding: 16px 6px !important; }
  .rpt-kpi-value { font-size: 20px !important; margin-top: 8px !important; }
  .rpt-kpi-label { font-size: 10px !important; }
  .rpt-kpi-change { font-size: 13px !important; margin-top: 6px !important; }
  .rpt-takeaway { font-size: 14px !important; }
  .rpt-panel { padding: 12px 8px !important; }
  .rpt-panel-title { font-size: 14px !important; }
  .rpt-th { padding: 6px 4px !important; font-size: 9px !important; }
  .rpt-td { padding: 9px 4px !important; font-size: 12px !important; }
  .rpt-rank { width: 20px !important; height: 20px !important; line-height: 20px !important; font-size: 11px !important; }
}
`;

function changeColor(value) {
  if (value > 0) return '#4fbd19';
  if (value < 0) return '#ef2929';
  return '#6b7280';
}

function iconGlyph(icon) {
  return { sessions: '◎', orders: '▣', conversion: '↗', trend: '↗', sales: '◆', aov: '◇', cart: '⊕', metric: '●' }[icon] || '●';
}

// KPI cards as a fluid grid: each card is an inline-block, so they flow into as
// many per row as fit. Desktop: up to four on one row, five or six as rows of
// three. Phones: two per row (see REPORT_STYLES). The container's top/left border
// plus each card's right/bottom border draws single grid lines at any column count.
// font-size:0 on the container removes the whitespace gap between inline-blocks.
function cardWidthPct(count) {
  const perRow = count <= 4 ? count : 3;
  return `${(100 / perRow).toFixed(4)}%`;
}

function renderMetricCards(metrics, primaryColor) {
  const width = cardWidthPct(metrics.length);
  const cards = metrics.map((metric) => `<div class="rpt-kpi-card" style="display:inline-block;vertical-align:top;box-sizing:border-box;width:${width};padding:24px 10px;text-align:center;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;font-size:14px;">`
    + `<div aria-hidden="true" style="font-size:22px;line-height:1;color:${primaryColor};">${iconGlyph(metric.icon)}</div>`
    + `<div class="rpt-kpi-label" style="font-size:12px;font-weight:700;color:${primaryColor};text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(metric.label)}</div>`
    + `<div class="rpt-kpi-value" style="margin-top:12px;font-size:27px;font-weight:800;color:#111827;word-break:break-word;">${escapeHtml(metric.value)}</div>`
    + (metric.change == null ? '' : `<div class="rpt-kpi-change" style="margin-top:8px;font-size:15px;font-weight:700;color:${changeColor(metric.changeValue)};">${metric.changeValue > 0 ? '↑' : metric.changeValue < 0 ? '↓' : '—'} ${escapeHtml(metric.change)}</div>`)
    + '</div>').join('');
  return `<div class="rpt-kpis" style="font-size:0;border-top:1px solid #e5e7eb;border-left:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">${cards}</div>`;
}

function renderTable(table, primaryColor) {
  const toneColor = table.tone === 'negative' ? '#ef2929' : table.tone === 'positive' ? primaryColor : '#374151';
  const header = [`<th class="rpt-th" align="left" style="padding:10px;width:36px;color:#4b5563;font-size:11px;">#</th>`, ...table.columns.map((column) => `<th class="rpt-th" align="left" style="padding:10px;color:#4b5563;font-size:11px;text-transform:uppercase;">${escapeHtml(column.label)}</th>`)].join('');
  const rows = table.rows.length ? table.rows.map((row) => `<tr style="border-top:1px solid #e5e7eb;"><td class="rpt-td" style="padding:13px 10px;"><span class="rpt-rank" style="display:inline-block;width:25px;height:25px;line-height:25px;text-align:center;border-radius:3px;background:${toneColor};color:#fff;font-weight:700;">${row.rank}</span></td>${row.cells.map((cell) => `<td class="rpt-td" style="padding:13px 10px;font-size:14px;color:${cell.format === 'delta_percent' ? changeColor(cell.numericValue) : '#111827'};font-weight:${cell.format === 'delta_percent' ? '700' : '500'};${cell.format === 'text' ? 'word-break:break-word;' : 'white-space:nowrap;'}">${cell.format === 'delta_percent' ? (cell.numericValue > 0 ? '↑ ' : cell.numericValue < 0 ? '↓ ' : '— ') : ''}${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('') : `<tr style="border-top:1px solid #e5e7eb;"><td colspan="${table.columns.length + 1}" align="center" style="padding:22px;color:#6b7280;font-size:13px;">No data available</td></tr>`;
  return `<div class="rpt-panel" style="margin-top:20px;border:1px solid #e5e7eb;border-radius:8px;padding:20px;"><div class="rpt-panel-title" style="font-size:16px;font-weight:800;color:${toneColor};text-transform:uppercase;">${escapeHtml(table.title)}</div><table role="table" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:collapse;"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderInventoryReportEmail({ context, template, branding, subject }) {
  const report = context?.scratch?.inventoryReport;
  if (!report || !Array.isArray(report.products)) {
    throw new Error('missing inventory report data at scratch.inventoryReport');
  }
  const brand = resolveEmailBranding({
    displayName: context?.meta?.brandName,
    ...(context?.meta?.emailBranding || {})
  }, branding);
  const timezone = context?.meta?.timezone || 'UTC';
  const reportTopK = Number(report.report_top_k) || report.lowest_doh_products.length || 2;
  const selectedWindowEnd = context?.meta?.window?.end;
  const selectedEndDate = selectedWindowEnd ? new Date(selectedWindowEnd) : null;
  // Workflow windows are half-open [start, end), so midnight at the end
  // represents the prior day as the last day included in the selection.
  const selectedWindowEndDate = selectedEndDate && !Number.isNaN(selectedEndDate.getTime())
    ? new Date(selectedEndDate.getTime() - 1)
    : null;
  const asOf = selectedWindowEndDate
    ? formatDate(selectedWindowEndDate, timezone)
    : report.as_of ? formatDate(report.as_of, timezone) : 'DATE UNAVAILABLE';
  const cards = [
    ['Total Products Analysed', report.analyzed_count, '#2563eb', '#eff6ff'],
    ['Critical Products', report.critical_count, '#dc2626', '#fef2f2'],
    ['Low-stock Products', report.medium_count, '#ea580c', '#fff7ed'],
    ['Healthy Products', report.healthy_count, '#059669', '#ecfdf5']
  ];
  const rows = report.lowest_doh_products.length
    ? report.lowest_doh_products.map((product, index) => {
      const critical = product.status === 'Critical';
      const tone = critical ? '#dc2626' : '#ea580c';
      const background = critical ? '#fff1f2' : '#fff7ed';
      const doh = product.doh_7d == null ? '—' : Number(product.doh_7d).toFixed(2);
      const drr = Number(product.drr_7d || 0).toFixed(2);
      return `<tr style="background:${background};border-top:1px solid #e5e7eb;">
        <td style="padding:13px 10px;"><span style="display:inline-block;width:27px;height:27px;line-height:27px;text-align:center;border-radius:5px;background:${tone};color:#fff;font-weight:800;">${index + 1}</span></td>
        <td style="padding:13px 10px;font-weight:700;">${escapeHtml(product.product_title)}</td>
        <td style="padding:13px 10px;">${escapeHtml(product.sku)}</td>
        <td align="right" style="padding:13px 10px;">${escapeHtml(drr)}</td>
        <td align="right" style="padding:13px 10px;color:${tone};font-weight:800;">${escapeHtml(doh)}</td>
        <td align="center" style="padding:13px 10px;"><span style="display:inline-block;border-radius:16px;padding:6px 12px;background:${critical ? '#fee2e2' : '#ffedd5'};color:${tone};font-weight:700;">${escapeHtml(product.status)}</span></td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="6" align="center" style="padding:20px;color:#6b7280;">No products with a calculable DOH were found.</td></tr>`;
  const mobileProductCards = report.lowest_doh_products.length
    ? report.lowest_doh_products.map((product, index) => {
      const critical = product.status === 'Critical';
      const tone = critical ? '#dc2626' : '#ea580c';
      const doh = product.doh_7d == null ? '—' : Number(product.doh_7d).toFixed(2);
      const drr = Number(product.drr_7d || 0).toFixed(2);
      return `<div class="inventory-mobile-product" style="display:none;margin-top:12px;padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:${critical ? '#fff1f2' : '#fff7ed'};">
        <div style="font-size:15px;font-weight:700;color:#111827;">${index + 1}. ${escapeHtml(product.product_title)}</div>
        <div style="margin-top:5px;font-size:12px;color:#5b6475;word-break:break-word;">SKU: ${escapeHtml(product.sku)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:collapse;"><tr>
          <td width="33%" style="padding:8px 4px;border-top:1px solid #e5e7eb;"><div style="font-size:10px;color:#64748b;">DRR (7 days)</div><div style="margin-top:3px;font-size:14px;font-weight:700;">${escapeHtml(drr)}</div></td>
          <td width="33%" style="padding:8px 4px;border-top:1px solid #e5e7eb;"><div style="font-size:10px;color:#64748b;">DOH (7 days)</div><div style="margin-top:3px;font-size:14px;font-weight:800;color:${tone};">${escapeHtml(doh)}</div></td>
          <td width="34%" style="padding:8px 4px;border-top:1px solid #e5e7eb;"><div style="font-size:10px;color:#64748b;">Status</div><div style="margin-top:3px;font-size:12px;font-weight:700;color:${tone};">${escapeHtml(product.status)}</div></td>
        </tr></table>
      </div>`;
    }).join('')
    : '<div class="inventory-mobile-product" style="display:none;margin-top:12px;color:#6b7280;">No products with a calculable DOH were found.</div>';
  const notes = report.no_velocity_count > 0
    ? `<div style="margin-top:14px;padding:12px 15px;border-radius:8px;background:#f3f4f6;color:#4b5563;font-size:13px;">${report.no_velocity_count} product(s) have no 7-day sales velocity and are excluded from DOH status counts.</div>`
    : '';
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light only"><style>
    @media only screen and (max-width:600px) {
      .inventory-email-body { padding:8px !important; }
      .inventory-email-shell { width:100% !important; max-width:100% !important; padding:14px !important; border-radius:8px !important; }
      .inventory-header { padding:14px !important; }
      .inventory-brand-cell, .inventory-date-cell { display:block !important; width:100% !important; text-align:left !important; }
      .inventory-date-cell { padding-top:12px !important; }
      .inventory-title { font-size:24px !important; }
      .inventory-section { padding:12px !important; margin-top:12px !important; }
      .inventory-card-cell { display:inline-block !important; width:47% !important; box-sizing:border-box !important; vertical-align:top !important; padding:8px !important; }
      .inventory-desktop-table { display:none !important; max-height:0 !important; overflow:hidden !important; }
      .inventory-mobile-product { display:block !important; }
    }
  </style></head><body class="inventory-email-body" style="margin:0;padding:20px;background:#f4f7f5;font-family:Arial,sans-serif;color:#111827;"><div class="inventory-email-shell" style="width:100%;max-width:760px;box-sizing:border-box;margin:0 auto;background:#fff;padding:24px;border:1px solid #e5e7eb;border-radius:14px;">
    <table role="presentation" class="inventory-header" width="100%" cellpadding="0" cellspacing="0" style="background:#effaf4;border-radius:12px;padding:20px;"><tr><td class="inventory-brand-cell"><div style="font-size:21px;font-weight:900;letter-spacing:.16em;color:#111827;">${escapeHtml(brand.displayName.toUpperCase())}</div></td><td class="inventory-date-cell" align="right"><div style="font-size:12px;color:#4b5563;text-transform:uppercase;">Inventory as of</div><div style="font-size:19px;font-weight:800;color:${brand.primaryColor};">${escapeHtml(asOf)}</div></td></tr>
      <tr><td colspan="2" align="center" style="padding-top:20px;"><span style="display:inline-block;padding:7px 14px;border-radius:18px;background:#d1fae5;color:#047857;font-size:12px;font-weight:800;text-transform:uppercase;">${escapeHtml(template.eyebrow || 'Inventory Alert')}</span><div style="margin-top:12px;font-size:32px;line-height:1.15;font-weight:900;color:#111827;">${escapeHtml(template.title || 'Top Products Inventory Report')}</div><div style="margin-top:8px;font-size:15px;color:#5b6475;">${escapeHtml(template.description || `Inventory health of the top ${report.analyzed_count} products, ranked by 7-day sales.`)}</div></td></tr></table>
    <div class="inventory-section" style="margin-top:16px;border:1px solid #e5e7eb;border-radius:10px;padding:18px;"><div style="font-size:22px;font-weight:900;">Inventory Overview</div><div style="margin:6px 0 16px;color:#5b6475;">Inventory health of the top ${report.analyzed_count} products, ranked by 7-day sales.</div><table role="presentation" width="100%" cellpadding="6" cellspacing="6"><tr>${cards.map(([label, value, color, bg]) => `<td class="inventory-card-cell" width="25%" valign="top" style="padding:15px;border-radius:10px;background:${bg};"><div style="font-size:13px;font-weight:700;">${escapeHtml(label)}</div><div style="margin-top:12px;font-size:32px;font-weight:900;color:${color};">${escapeHtml(value)}</div></td>`).join('')}</tr></table><div style="margin-top:10px;padding:12px 14px;background:#f3f6fa;border-radius:8px;color:#4b5563;font-size:12px;">Status counts are calculated across the selected products using the configured DOH thresholds.</div>${notes}</div>
    <div class="inventory-section" style="margin-top:16px;border:1px solid #e5e7eb;border-radius:10px;padding:18px;"><div style="font-size:22px;font-weight:900;">Top ${escapeHtml(reportTopK)} Products with Lowest DOH</div><div style="margin:6px 0 16px;color:#5b6475;">The products with the fewest estimated days of inventory among the top sellers.</div><table class="inventory-desktop-table" role="table" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><thead><tr style="background:#f3f4f6;"><th align="left" style="padding:11px;">#</th><th align="left" style="padding:11px;">Product</th><th align="left" style="padding:11px;">SKU</th><th align="right" style="padding:11px;">DRR (7 days)</th><th align="right" style="padding:11px;">DOH (7 days)</th><th align="center" style="padding:11px;">Status</th></tr></thead><tbody>${rows}</tbody></table>${mobileProductCards}</div>
    <table role="presentation" width="100%" style="margin-top:24px;border-collapse:collapse;"><tr><td align="right" style="font-size:12px;color:#6b7280;">${escapeHtml(brand.footerText)}</td></tr></table>
  </div></body></html>`;
  const text = [
    brand.displayName,
    template.title || 'Top Products Inventory Report',
    `Inventory as of ${asOf}`,
    `Products analysed: ${report.analyzed_count}`,
    `Critical (≤${report.critical_threshold_days} DOH): ${report.critical_count}`,
    `Low stock: ${report.medium_count}`,
    `Healthy (≥${report.healthy_threshold_days} DOH): ${report.healthy_count}`,
    '',
    'Top products with lowest DOH:',
    ...report.lowest_doh_products.map((product, index) => `${index + 1}. ${product.product_title} | SKU ${product.sku} | DRR ${Number(product.drr_7d || 0).toFixed(2)} | DOH ${product.doh_7d == null ? '—' : Number(product.doh_7d).toFixed(2)} | ${product.status}`),
    brand.footerText
  ].join('\n');
  const inventoryRows = report.lowest_doh_products.map((product, index) => ({
    rank: index + 1,
    cells: [product.product_title, product.sku, Number(product.drr_7d || 0).toFixed(2),
      product.doh_7d == null ? '—' : Number(product.doh_7d).toFixed(2), product.status]
      .map((value) => ({ value: String(value ?? ''), format: 'text', numericValue: null }))
  }));
  return {
    subject,
    html,
    text,
    viewModel: {
      inventory: report,
      asOf,
      branding: brand,
      eyebrow: template.eyebrow || 'Inventory Alert',
      title: template.title || 'Top Products Inventory Report',
      description: template.description || '',
      tables: [{
        title: `Top ${reportTopK} Products with Lowest DOH`,
        columns: ['Product', 'SKU', 'DRR (7 days)', 'DOH (7 days)', 'Status'].map((label) => ({ label })),
        rows: inventoryRows
      }]
    }
  };
}

function renderReportEmail({ context, template, branding, subject }) {
  if (template?.preset === 'inventory_alert_v1') {
    return renderInventoryReportEmail({ context, template, branding, subject });
  }
  const view = buildReportViewModel({ context, template, branding });
  const brand = view.branding;
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.displayName)}" style="max-height:42px;max-width:190px;display:block;">`
    : `<div class="rpt-brand" style="font-size:24px;font-weight:900;letter-spacing:.22em;color:#111827;">${escapeHtml(brand.displayName.toUpperCase())}</div>`;
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><style>${REPORT_STYLES}</style></head><body style="margin:0;padding:0;background:#f4f5f3;font-family:Arial,sans-serif;color:#111827;"><div class="rpt-wrap" style="max-width:760px;margin:0 auto;background:#fff;padding:30px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="rpt-head-cell">${logo}<div style="margin-top:5px;color:${brand.primaryColor};font-size:11px;font-weight:700;letter-spacing:.12em;">${escapeHtml(brand.tagline.toUpperCase())}</div></td><td class="rpt-head-cell rpt-head-date" align="right"><div style="font-size:13px;color:#4b5563;text-transform:uppercase;">Daily Report</div><div style="font-size:19px;font-weight:800;color:${brand.primaryColor};">${escapeHtml(view.currentDate)}</div><div style="font-size:12px;color:#4b5563;">vs ${escapeHtml(view.comparisonDate)}</div></td></tr></table>
    <div class="rpt-divider" style="height:1px;background:#e5e7eb;margin:22px -30px 28px;"></div>
    <div style="font-size:15px;font-weight:800;text-transform:uppercase;color:${brand.primaryColor};">${escapeHtml(view.eyebrow)}</div>
    <div class="rpt-title" style="margin-top:12px;font-size:38px;line-height:1.08;font-weight:900;color:#050505;">${escapeHtml(view.title)}</div>
    ${view.description ? `<div class="rpt-desc" style="margin:16px 0 26px;font-size:16px;line-height:1.5;color:#5b5b5b;">${escapeHtml(view.description)}</div>` : '<div style="height:24px;"></div>'}
    ${renderMetricCards(view.metrics, brand.primaryColor)}
    ${renderInsight(view.insight, brand.primaryColor)}
    ${view.tables.map((table) => renderTable(table, brand.primaryColor)).join('')}
    <div style="margin-top:22px;padding:15px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;color:#4b5563;">Comparisons use ${escapeHtml(view.comparisonRange)} in ${escapeHtml(view.timezone)}.</div>
    <table role="presentation" width="100%" style="margin-top:26px;border-collapse:collapse;"><tr><td style="font-weight:800;letter-spacing:.15em;">${escapeHtml(brand.displayName.toUpperCase())}</td><td align="right" style="font-size:12px;color:#6b7280;">${escapeHtml(brand.footerText)}</td></tr></table>
  </div></body></html>`;

  const text = [
    brand.displayName,
    brand.tagline,
    `${view.eyebrow}: ${view.title}`,
    view.description,
    `Current period: ${view.currentRange} (${view.timezone})`,
    `Comparison period: ${view.comparisonRange} (${view.timezone})`,
    '',
    ...view.metrics.map((metric) => `${metric.label}: ${metric.value}${metric.change == null ? '' : ` (${metric.change})`}`),
    ...(view.insight ? ['', `Key takeaway: ${view.insight.summary}`] : []),
    ...view.tables.flatMap((table) => ['', table.title, ...(table.rows.length ? table.rows.map((row) => `${row.rank}. ${row.cells.map((cell, index) => `${table.columns[index].label}: ${cell.value}`).join(' | ')}`) : ['No data available'])]),
    '',
    brand.footerText,
  ].filter((line) => line !== undefined && line !== null).join('\n');

  return { subject, html, text, viewModel: view };
}

module.exports = { renderReportEmail, buildReportViewModel, formatValue };
