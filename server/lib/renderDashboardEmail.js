// "Daily dashboard report" layout (preset dashboard_report_v1): brand header, two hero KPI cards, a
// strip of KPI cells, performer tables with share bars, and an inventory-health block. The greens
// are derived from the tenant's brand color; red / orange / green for stock status are fixed.
//
// Plain tables + inline styles (email safe) with <style> media queries for phones. Clients that ignore
// the media queries keep the desktop layout, which wraps safely.

const { resolveEmailBranding } = require('./emailBranding');
const { hasReportCopyField } = require('./reportCopy');
const { tint, shade } = require('./colorUtils');
const { requireBinding, requirePresentBinding, formatValue, escapeHtml } = require('./renderReportEmail');

const INK = '#0f172a';
const GRAY = '#4b5563';
const LINE = '#e5e7eb';
const TRACK = '#eef0ed';
const RED = '#dc2626';
const RED_TEXT = '#b91c1c';
const RED_DELTA = '#d22725';
const RED_BAR = '#ef2929';
const RED_PILL = '#fef2f2';
const ORANGE = '#ea580c';
const ORANGE_TEXT = '#c2410c';
const GREEN = '#059669';
const GREEN_TEXT = '#047857';
const BADGE_BG = '#fff7ed';
const BADGE_TEXT = '#9a3412';

const STATUS_COLORS = {
  critical: { segment: RED, text: RED_TEXT },
  'low stock': { segment: ORANGE, text: ORANGE_TEXT },
  healthy: { segment: GREEN, text: GREEN_TEXT }
};

const DEFAULT_LIST_TITLE = 'Act first · lowest days on hand';
const STRIP_PER_ROW = 4;

// ---------------------------------------------------------------- formatting

// "21 Oct 2026" (the layout shows the date in sentence case, unlike the older layouts).
function formatDay(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid report date: ${value}`);
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', timeZone: timezone || 'UTC' })
    .formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.day} ${parts.month} ${parts.year}`;
}

// "+3.59%" / "−7.55%" (typographic minus) with an arrow chosen by the caller.
function formatDelta(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const sign = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${sign}${Math.abs(number).toFixed(2)}%`;
}

function arrowFor(value) {
  const number = Number(value);
  if (number > 0) return '↑';
  if (number < 0) return '↓';
  return '—';
}

function formatShare(percent) {
  if (!Number.isFinite(percent)) return '—';
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

function chunk(list, size) {
  const rows = [];
  for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size));
  return rows;
}

// ---------------------------------------------------------------- view model

function buildCard(item, context, currency) {
  const rawValue = requirePresentBinding(context, item.value);
  const rawChange = item.change ? requirePresentBinding(context, item.change) : null;
  return {
    label: item.label,
    icon: item.icon || 'metric',
    value: rawValue == null ? '—' : formatValue(rawValue, item.format, { currency }),
    change: rawChange == null ? null : formatDelta(rawChange),
    changeValue: rawChange == null ? null : Number(rawChange)
  };
}

const formatStock = (value) => (value == null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('en-US'));

function buildInventory(template, context) {
  const config = template.inventory;
  if (!config || config.enabled !== true) return null;
  const report = context?.scratch?.inventoryReport;
  if (!report || !Array.isArray(report.products)) {
    throw new Error('missing inventory report data at scratch.inventoryReport');
  }
  const listed = (Array.isArray(report.lowest_doh_products) ? report.lowest_doh_products : []).map((product) => ({
    title: product.product_title,
    sku: product.sku,
    stock: product.inventory_available == null ? null : Number(product.inventory_available),
    drr: Number(product.drr_7d || 0),
    doh: product.doh_7d == null ? null : Number(product.doh_7d),
    status: product.status
  }));
  // the badge goes on the listed product with the highest run rate
  let badgeIndex = -1;
  listed.forEach((product, index) => {
    if (badgeIndex === -1 || product.drr > listed[badgeIndex].drr) badgeIndex = index;
  });
  return {
    title: config.title || 'Inventory health',
    listTitle: config.listTitle || DEFAULT_LIST_TITLE,
    analyzed: Number(report.analyzed_count || 0),
    critical: Number(report.critical_count || 0),
    low: Number(report.medium_count || 0),
    healthy: Number(report.healthy_count || 0),
    rows: listed,
    badgeIndex
  };
}

function buildDashboardViewModel({ context, template, branding }) {
  if (template?.preset !== 'dashboard_report_v1') {
    throw new Error(`unsupported report preset: ${template?.preset || 'missing'}`);
  }
  const timezone = context?.meta?.timezone || 'UTC';
  const currentPeriod = hasReportCopyField(template, 'period.current') && template.period?.current
    ? requireBinding(context, template.period.current)
    : null;
  const comparisonPeriod = hasReportCopyField(template, 'period.comparison') && template.period?.comparison
    ? requireBinding(context, template.period.comparison)
    : null;
  if (currentPeriod && (!currentPeriod.start || !currentPeriod.end)) throw new Error('current report period binding must resolve to a start/end object');
  if (comparisonPeriod && (!comparisonPeriod.start || !comparisonPeriod.end)) throw new Error('comparison report period binding must resolve to a start/end object');
  const currency = context?.meta?.currency;

  const cards = (template.metrics || []).map((item) => buildCard(item, context, currency));
  const requestedHero = Number.isInteger(template.heroCount) ? template.heroCount : 2;
  const heroCount = Math.max(0, Math.min(requestedHero, cards.length));

  const tables = (template.tables || []).map((table) => {
    const source = requireBinding(context, table.source);
    if (!Array.isArray(source)) throw new Error(`table source must resolve to an array: ${table.source}`);
    return {
      title: table.title,
      tone: table.tone || 'neutral',
      columns: table.columns.map((column) => ({ label: column.label, format: column.format })),
      rows: source.slice(0, table.limit).map((entry, index) => ({
        rank: index + 1,
        cells: table.columns.map((column) => {
          const rawValue = requireBinding(entry, column.path);
          if (column.format === 'share_bar') {
            const total = Number(requireBinding(context, column.of));
            const number = Number(rawValue);
            const share = Number.isFinite(number) && Number.isFinite(total) && total > 0 ? (number / total) * 100 : NaN;
            return { value: formatShare(share), numericValue: null, format: 'share_bar', share };
          }
          if (column.format === 'delta_percent') {
            return { value: formatDelta(rawValue), numericValue: Number(rawValue), format: 'delta_percent' };
          }
          return {
            value: formatValue(rawValue, column.format, { currency }),
            numericValue: null,
            format: column.format
          };
        })
      }))
    };
  });

  // Bars are drawn relative to the largest share anywhere in the report, so a 2% row next to a
  // 53% row reads as small.
  const shares = tables.flatMap((table) => table.rows.flatMap((row) => row.cells.filter((cell) => cell.format === 'share_bar').map((cell) => cell.share)));
  const maxShare = Math.max(0, ...shares.filter(Number.isFinite));

  const inventory = buildInventory(template, context);

  return {
    branding: resolveEmailBranding({
      displayName: context?.meta?.brandName,
      ...(context?.meta?.emailBranding || {})
    }, branding),
    headerLabel: hasReportCopyField(template, 'headerLabel') ? String(template.headerLabel || '').trim() : '',
    timezone,
    currentDate: currentPeriod ? formatDay(currentPeriod.start, timezone) : null,
    comparisonDate: comparisonPeriod ? formatDay(comparisonPeriod.start, timezone) : null,
    hero: cards.slice(0, heroCount),
    strip: cards.slice(heroCount),
    tables,
    maxShare,
    inventory
  };
}

// ---------------------------------------------------------------- html

const STYLES = `
@media only screen and (max-width: 600px) {
  .dsh-wrap { padding: 22px 16px 20px !important; }
  .dsh-head-cell { display: block !important; width: 100% !important; text-align: left !important; }
  .dsh-head-left { padding-top: 0 !important; }
  .dsh-head-right { padding-top: 14px !important; }
  .dsh-brand { font-size: 20px !important; letter-spacing: .14em !important; }
  .dsh-date { font-size: 18px !important; }
  .dsh-hero { display: block !important; width: 100% !important; padding: 0 0 10px 0 !important; }
  .dsh-hero-card { padding: 18px 18px !important; }
  .dsh-hero-value { font-size: 34px !important; }
  .dsh-cell { display: inline-block !important; width: 50% !important; box-sizing: border-box !important; border-right: 0 !important; border-bottom: 1px solid #e5e7eb !important; padding: 14px 14px !important; }
  .dsh-odd { border-right: 1px solid #e5e7eb !important; }
  .dsh-strip-inner { margin-bottom: -1px !important; }
  .dsh-cell-value { font-size: 22px !important; }
  .dsh-section { font-size: 14px !important; margin: 28px 0 8px !important; }
  .dsh-table { table-layout: auto !important; }
  .dsh-th { width: auto !important; font-size: 10px !important; letter-spacing: .02em !important; padding: 8px 0 8px 6px !important; }
  .dsh-td { font-size: 12.5px !important; padding: 12px 0 12px 6px !important; }
  .dsh-td-first, .dsh-th-first { padding-left: 0 !important; width: 30% !important; }
  .dsh-name { font-size: 14px !important; }
  .dsh-bar { width: 44px !important; }
  .dsh-pct { padding-left: 6px !important; font-size: 12px !important; }
  .dsh-count { margin-right: 18px !important; margin-bottom: 8px !important; }
  .dsh-count-num { font-size: 26px !important; }
  .dsh-prod-name { font-size: 15px !important; }
  .dsh-doh { font-size: 24px !important; }
  .dsh-drr { font-size: 14px !important; }
  .dsh-badge { margin-left: 0 !important; margin-top: 6px !important; }
  .dsh-footer { font-size: 11px !important; }
}
@media only screen and (max-width: 420px) {
  .dsh-bar-wrap { display: none !important; }
  .dsh-pct { padding-left: 0 !important; }
}
@media only screen and (max-width: 360px) {
  .dsh-th { font-size: 9px !important; letter-spacing: 0 !important; padding-left: 4px !important; }
  .dsh-td { font-size: 12px !important; padding-left: 4px !important; }
  .dsh-th-first, .dsh-td-first { padding-left: 0 !important; width: 26% !important; }
  .dsh-name { font-size: 13px !important; }
}
`;

function heroFontSize(text, wide) {
  const length = String(text).length;
  if (wide) return length <= 13 ? 40 : length <= 16 ? 33 : 27;
  return length <= 8 ? 40 : length <= 11 ? 33 : 26;
}

function palette(primary) {
  return {
    primary,
    dark: shade(primary, 0.4),
    pillText: shade(primary, 0.5),
    accentBg: tint(primary, 0.08),
    pillBg: tint(primary, 0.22)
  };
}

function changeColors(value, c) {
  if (value > 0) return { pillBg: c.pillBg, pillText: c.pillText, text: c.dark };
  if (value < 0) return { pillBg: RED_PILL, pillText: RED_TEXT, text: RED_DELTA };
  return { pillBg: '#f3f4f6', pillText: GRAY, text: GRAY };
}

function renderHeader(view, c) {
  const brand = view.branding;
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.displayName)}" style="max-height:44px;max-width:220px;display:block;">`
    : `<div class="dsh-brand" style="font-size:23px;line-height:1.2;font-weight:900;letter-spacing:.2em;color:${INK};">${escapeHtml(brand.displayName.toUpperCase())}</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="dsh-head-cell dsh-head-left" valign="top" style="padding-top:17px;">${logo}</td>
      <td class="dsh-head-cell dsh-head-right" align="right" valign="top">${view.headerLabel ? `<div style="font-size:12px;font-weight:600;letter-spacing:.1em;color:${GRAY};text-transform:uppercase;">${escapeHtml(view.headerLabel)}</div>` : ''}${view.currentDate ? `<div class="dsh-date" style="margin-top:4px;font-size:23px;line-height:1.15;font-weight:800;color:${INK};">${escapeHtml(view.currentDate)}</div>` : ''}${view.comparisonDate ? `<div style="margin-top:4px;font-size:13px;color:${GRAY};">vs ${escapeHtml(view.comparisonDate)}</div>` : ''}</td>
    </tr></table>
    <div style="height:1px;background:${LINE};margin:25px 0 31px;"></div>`;
}

function renderHero(cards, c) {
  if (!cards.length) return '';
  const weights = cards.map((_, index) => (index === 0 && cards.length > 1 ? 1.53 : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const html = cards.map((card, index) => {
    const accent = index === 0;
    const width = ((weights[index] / total) * 100).toFixed(2);
    const colors = changeColors(card.changeValue, c);
    const wide = weights[index] > 1 || cards.length === 1;
    const pill = card.change == null
      ? ''
      : `<div style="margin-top:17px;"><span style="display:inline-block;padding:5px 13px;border-radius:999px;background:${colors.pillBg};color:${colors.pillText};font-size:14px;font-weight:700;white-space:nowrap;">${arrowFor(card.changeValue)} ${escapeHtml(card.change)}</span></div>`;
    const sidePadding = cards.length === 1 ? '' : index === 0 ? 'padding-right:7px;' : index === cards.length - 1 ? 'padding-left:7px;' : 'padding:0 7px;';
    return `<div class="dsh-hero" style="display:inline-block;vertical-align:top;box-sizing:border-box;width:${width}%;${sidePadding}"><div class="dsh-hero-card" style="box-sizing:border-box;background:${accent ? c.accentBg : '#ffffff'};border:1px solid ${accent ? c.accentBg : LINE};border-radius:18px;padding:25px 26px 28px;">`
      + `<div style="font-size:13px;font-weight:600;letter-spacing:.08em;color:${c.dark};text-transform:uppercase;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${c.primary};vertical-align:middle;margin-right:9px;"></span><span style="vertical-align:middle;">${escapeHtml(card.label)}</span></div>`
      + `<div class="dsh-hero-value" style="margin-top:8px;font-size:${heroFontSize(card.value, wide)}px;line-height:1.1;font-weight:900;color:${INK};word-break:break-word;">${escapeHtml(card.value)}</div>`
      + `${pill}</div></div>`;
  }).join('');
  return `<div style="font-size:0;margin-bottom:14px;">${html}</div>`;
}

function renderStrip(cards, c, perRow = STRIP_PER_ROW) {
  if (!cards.length) return '';
  const rows = chunk(cards, perRow).map((row, rowIndex) => {
    const padded = [...row, ...Array(perRow - row.length).fill(null)];
    const cells = padded.map((card, index) => {
      const border = index < perRow - 1 ? `border-right:1px solid ${LINE};` : '';
      const parity = index % 2 === 0 ? 'dsh-odd' : 'dsh-even';
      const style = `width:${(100 / perRow).toFixed(2)}%;padding:21px 20px 22px;${border}`;
      if (!card) return `<td class="dsh-cell ${parity}" valign="top" style="${style}">&nbsp;</td>`;
      const colors = changeColors(card.changeValue, c);
      const delta = card.change == null
        ? ''
        : `<div style="margin-top:8px;font-size:15px;font-weight:700;color:${colors.text};white-space:nowrap;">${arrowFor(card.changeValue)} ${escapeHtml(card.change)}</div>`;
      return `<td class="dsh-cell ${parity}" valign="top" style="${style}">`
        + `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;color:${GRAY};text-transform:uppercase;">${escapeHtml(card.label)}</div>`
        + `<div class="dsh-cell-value" style="margin-top:13px;font-size:28px;line-height:1.1;font-weight:800;color:${INK};word-break:break-word;">${escapeHtml(card.value)}</div>`
        + `${delta}</td>`;
    }).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border-collapse:collapse;${rowIndex ? `border-top:1px solid ${LINE};` : ''}"><tr>${cells}</tr></table>`;
  }).join('');
  return `<div style="border:1px solid ${LINE};border-radius:14px;overflow:hidden;margin-bottom:31px;"><div class="dsh-strip-inner">${rows}</div></div>`;
}

function renderShareCell(cell, maxShare, tone, c) {
  const barColor = tone === 'negative' ? RED_BAR : c.primary;
  const width = Number.isFinite(cell.share) && maxShare > 0 ? Math.max(cell.share > 0 ? 4 : 0, Math.min(100, (cell.share / maxShare) * 100)) : 0;
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>`
    + `<td class="dsh-bar-wrap" style="padding:0;"><div class="dsh-bar" style="width:86px;height:6px;background:${TRACK};border-radius:3px;overflow:hidden;"><div style="width:${width.toFixed(1)}%;height:6px;background:${barColor};border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></div></td>`
    + `<td class="dsh-pct" style="padding:0 0 0 10px;font-size:14px;color:${GRAY};white-space:nowrap;">${escapeHtml(cell.value)}</td></tr></table>`;
}

// Column widths: the first (name) column is the widest, the share bar and the change column get a
// little more room than plain numbers. Fixed widths keep every table lined up the same way.
function columnWidths(columns) {
  const weights = columns.map((column, index) => {
    if (index === 0) return 35.5;
    if (column.format === 'share_bar') return 20.5;
    if (column.format === 'delta_percent') return 14.5;
    return 9.9;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => ((w / total) * 100).toFixed(2));
}

function renderTable(table, maxShare, c, index = 0) {
  const headingColor = table.tone === 'positive' ? c.dark : table.tone === 'negative' ? RED : INK;
  const alignOf = (column, index) => (index === 0 || column.format === 'share_bar' ? 'left' : 'right');
  const widths = columnWidths(table.columns);
  const head = table.columns.map((column, index) => `<th class="dsh-th${index === 0 ? ' dsh-th-first' : ''}" align="${alignOf(column, index)}" width="${widths[index]}%" style="width:${widths[index]}%;padding:10px 0 10px ${index === 0 ? 0 : 10}px;border-bottom:1px solid ${LINE};font-size:12px;font-weight:600;letter-spacing:.08em;color:${GRAY};text-transform:uppercase;">${escapeHtml(column.label)}</th>`).join('');
  const body = table.rows.length
    ? table.rows.map((row, rowIndex) => {
      const last = rowIndex === table.rows.length - 1;
      const cells = row.cells.map((cell, index) => {
        const column = table.columns[index];
        const base = `padding:16px 0 16px ${index === 0 ? 0 : 10}px;${last ? '' : `border-bottom:1px solid ${LINE};`}`;
        const cls = `dsh-td${index === 0 ? ' dsh-td-first' : ''}`;
        if (cell.format === 'share_bar') return `<td class="${cls}" align="left" style="${base}">${renderShareCell(cell, maxShare, table.tone, c)}</td>`;
        if (cell.format === 'delta_percent') {
          const colors = changeColors(cell.numericValue, c);
          return `<td class="${cls}" align="right" style="${base}font-size:16px;font-weight:700;color:${colors.text};white-space:nowrap;">${arrowFor(cell.numericValue)} ${escapeHtml(cell.value)}</td>`;
        }
        if (index === 0) return `<td class="${cls} dsh-name" align="left" style="${base}font-size:17px;font-weight:700;color:${INK};word-break:break-word;">${escapeHtml(cell.value)}</td>`;
        return `<td class="${cls}" align="${alignOf(column, index)}" style="${base}font-size:16px;color:${INK};white-space:nowrap;">${escapeHtml(cell.value)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('')
    : `<tr><td colspan="${table.columns.length}" align="center" style="padding:22px;font-size:13px;color:${GRAY};">No data available</td></tr>`;
  return `<div class="dsh-section" style="margin:${index === 0 ? 34 : 20}px 0 6px;font-size:15.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${headingColor};">${escapeHtml(table.title)}</div>`
    + `<table class="dsh-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderSegments(inventory) {
  const parts = [
    { count: inventory.critical, color: RED },
    { count: inventory.low, color: ORANGE },
    { count: inventory.healthy, color: GREEN }
  ].filter((part) => part.count > 0);
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (!total) return '';
  const cells = parts.map((part, index) => {
    const left = index === 0 ? '9px' : '0';
    const right = index === parts.length - 1 ? '9px' : '0';
    const gap = index === parts.length - 1 ? '' : '<td width="3" style="width:3px;font-size:0;line-height:0;">&nbsp;</td>';
    const width = Math.max(2, (part.count / total) * 100).toFixed(2);
    return `<td width="${width}%" style="width:${width}%;height:18px;background:${part.color};border-radius:${left} ${right} ${right} ${left};font-size:0;line-height:0;">&nbsp;</td>${gap}`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;table-layout:fixed;"><tr>${cells}</tr></table>`;
}

function renderCounts(inventory) {
  const items = [
    ['Critical', inventory.critical, RED_TEXT],
    ['Low stock', inventory.low, ORANGE_TEXT],
    ['Healthy', inventory.healthy, GREEN_TEXT]
  ];
  return `<div style="margin-top:20px;font-size:0;">${items.map(([label, count, color]) => `<span class="dsh-count" style="display:inline-block;margin-right:36px;white-space:nowrap;vertical-align:baseline;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:9px;vertical-align:middle;"></span><span class="dsh-count-num" style="font-size:30px;line-height:1.1;font-weight:900;color:${color};vertical-align:middle;">${escapeHtml(count)}</span><span style="font-size:13px;font-weight:600;letter-spacing:.08em;color:${color};text-transform:uppercase;margin-left:9px;vertical-align:middle;">${escapeHtml(label)}</span></span>`).join('')}</div>`;
}

function renderInventory(inventory, c) {
  const rows = inventory.rows.length
    ? inventory.rows.map((product, index) => {
      const last = index === inventory.rows.length - 1;
      const colors = STATUS_COLORS[String(product.status || '').trim().toLowerCase()] || { text: INK };
      const isBadge = index === inventory.badgeIndex;
      const badge = isBadge ? `<span class="dsh-badge" style="display:inline-block;margin-left:10px;padding:4px 10px;border-radius:999px;background:${BADGE_BG};color:${BADGE_TEXT};font-size:11px;font-weight:800;letter-spacing:.08em;white-space:nowrap;vertical-align:middle;">HIGHEST RUN RATE</span>` : '';
      const base = `padding:16px 0;${last ? '' : `border-bottom:1px solid ${LINE};`}`;
      return `<tr>`
        + `<td valign="middle" style="${base}"><div class="dsh-prod-name" style="font-size:17.5px;line-height:1.25;font-weight:700;color:${INK};word-break:break-word;">${escapeHtml(product.title)}${badge}</div><div style="margin-top:4px;font-size:12.7px;color:${GRAY};word-break:break-word;">${escapeHtml(product.sku)}</div></td>`
        + `<td class="dsh-drr" align="right" valign="middle" style="${base}padding-left:10px;font-size:17px;font-weight:400;color:${INK};white-space:nowrap;">${escapeHtml(formatStock(product.stock))}</td>`
        + `<td class="dsh-drr" align="right" valign="middle" style="${base}padding-left:10px;font-size:17px;font-weight:${isBadge ? 800 : 400};color:${INK};white-space:nowrap;">${escapeHtml(product.drr.toFixed(2))}</td>`
        + `<td class="dsh-doh" align="right" valign="middle" style="${base}padding-left:10px;font-size:26px;line-height:1.1;font-weight:900;color:${colors.text};white-space:nowrap;">${escapeHtml(product.doh == null ? '—' : product.doh.toFixed(2))}</td>`
        + `</tr>`;
    }).join('')
    : `<tr><td colspan="4" align="center" style="padding:22px;font-size:13px;color:${GRAY};">No products with a calculable DOH were found.</td></tr>`;
  const th = (label, align, width) => `<th class="dsh-th" align="${align}" width="${width}%" style="width:${width}%;padding:10px 0 10px ${align === 'right' ? 10 : 0}px;border-bottom:1px solid ${LINE};font-size:12px;font-weight:600;letter-spacing:.08em;color:${GRAY};text-transform:uppercase;white-space:nowrap;">${label}</th>`;
  return `<div style="height:1px;background:${LINE};margin:18px 0 30px;"></div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:15.5px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${INK};">${escapeHtml(inventory.title)}</td><td align="right" style="font-size:14px;color:${GRAY};white-space:nowrap;">${escapeHtml(inventory.analyzed)} products</td></tr></table>`
    + renderSegments(inventory)
    + renderCounts(inventory)
    + `<div style="margin:34px 0 4px;font-size:15px;font-weight:800;color:${RED_TEXT};">${escapeHtml(inventory.listTitle)}</div>`
    + `<table class="dsh-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;"><thead><tr>${th('Product', 'left', 52)}${th('Inventory', 'right', 16)}${th('DRR · 7D', 'right', 15)}${th('DOH · 7D', 'right', 17)}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDashboardReportEmail({ context, template, branding, subject }) {
  const view = buildDashboardViewModel({ context, template, branding });
  const c = palette(view.branding.primaryColor);

  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><style>${STYLES}</style></head><body style="margin:0;padding:0;background:#ffffff;font-family:Arial,sans-serif;color:${INK};"><div class="dsh-wrap" style="max-width:784px;margin:0 auto;box-sizing:border-box;background:#ffffff;padding:37px 37px 30px;">
    ${renderHeader(view, c)}
    ${renderHero(view.hero, c)}
    ${renderStrip(view.strip, c)}
    ${view.tables.map((table, index) => renderTable(table, view.maxShare, c, index)).join('')}
    ${view.inventory ? renderInventory(view.inventory, c) : ''}
    <div style="height:1px;background:${LINE};margin:40px 0 18px;"></div>
  </div></body></html>`;

  const cardLine = (card) => `${card.label}: ${card.value}${card.change == null ? '' : ` (${card.change})`}`;
  const text = [
    view.branding.displayName,
    [view.headerLabel, view.currentDate, view.comparisonDate ? `vs ${view.comparisonDate}` : ''].filter(Boolean).join(' '),
    '',
    ...view.hero.map(cardLine),
    ...view.strip.map(cardLine),
    ...view.tables.flatMap((table) => ['', table.title, ...(table.rows.length
      ? table.rows.map((row) => `${row.rank}. ${row.cells.map((cell, index) => `${table.columns[index].label}: ${cell.value}`).join(' | ')}`)
      : ['No data available'])]),
    ...(view.inventory ? [
      '',
      `${view.inventory.title}: ${view.inventory.analyzed} products`,
      `Critical: ${view.inventory.critical} | Low stock: ${view.inventory.low} | Healthy: ${view.inventory.healthy}`,
      view.inventory.listTitle,
      ...view.inventory.rows.map((product, index) => `${index + 1}. ${product.title} | SKU ${product.sku} | Inventory ${formatStock(product.stock)} | DRR ${product.drr.toFixed(2)} | DOH ${product.doh == null ? '—' : product.doh.toFixed(2)}${index === view.inventory.badgeIndex ? ' | HIGHEST RUN RATE' : ''}`)
    ] : []),
    ''
  ].join('\n');

  // The drawn Telegram pages read `tables` (and branding / title). The inventory list is exposed as one more
  // table; there is deliberately no top-level `inventory` key, which would select the inventory-only layout.
  const inventoryTable = view.inventory ? [{
    title: view.inventory.listTitle,
    tone: 'negative',
    columns: ['Product', 'SKU', 'Inventory', 'DRR (7 days)', 'DOH (7 days)'].map((label) => ({ label })),
    rows: view.inventory.rows.map((product, index) => ({
      rank: index + 1,
      cells: [product.title, product.sku, formatStock(product.stock), product.drr.toFixed(2), product.doh == null ? '—' : product.doh.toFixed(2)]
        .map((value) => ({ value: String(value ?? ''), numericValue: null, format: 'text' }))
    }))
  }] : [];

  return {
    subject,
    html,
    text,
    viewModel: {
      branding: view.branding,
      eyebrow: view.headerLabel,
      title: view.headerLabel,
      description: '',
      metrics: [...view.hero, ...view.strip],
      tables: [...view.tables, ...inventoryTable]
    }
  };
}

module.exports = { renderDashboardReportEmail, buildDashboardViewModel, formatDelta, formatShare, formatDay };
