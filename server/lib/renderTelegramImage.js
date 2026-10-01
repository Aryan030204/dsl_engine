const sharp = require('sharp');

const WIDTH = 1120;
const PAGE_ROW_LIMIT = 8;
const MAX_ROWS = 120;
const MAX_IMAGE_BYTES = 60 * 1024;
const FONT = 'Arial, sans-serif';

const COLORS = {
  critical: { accent: '#dc2626', label: 'CRITICAL' },
  error: { accent: '#dc2626', label: 'ERROR' },
  warning: { accent: '#d97706', label: 'WARNING' },
  warn: { accent: '#d97706', label: 'WARNING' },
  success: { accent: '#059669', label: 'SUCCESS' },
  info: { accent: '#2563eb', label: 'INFO' }
};

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getPresentation(severity) {
  const normalized = String(severity || 'info').trim().toLowerCase();
  return COLORS[normalized] || COLORS.info;
}

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value == null ? '' : String(value);
  return `${Math.round(number <= 1 ? number * 100 : number)}%`;
}

function parseMetricRow(value) {
  const parts = String(value || '').split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const source = parts.shift().replace(/^\d+[.)]\s*/, '').trim();
  const metrics = parts.map((part) => {
    const match = part.match(/^(.+?)\s+(-?[\d,.]+%?)\s*(?:->|→)\s*(-?[\d,.]+%?)(?:\s*\((.*?)\))?$/);
    if (!match) return null;
    const [, label, before, after, change = ''] = match;
    const signedChange = change.match(/-?\d[\d,.]*%?/);
    const isNegative = /drop|decrease|negative/i.test(change)
      || (signedChange && signedChange[0].startsWith('-'));
    const isPositive = /increase|growth|positive/i.test(change)
      || (signedChange && !signedChange[0].startsWith('-') && Number.parseFloat(signedChange[0]) > 0);
    return {
      label: label.trim(),
      value: `${before} → ${after}`,
      change,
      tone: isNegative ? 'negative' : isPositive ? 'positive' : 'neutral'
    };
  }).filter(Boolean);

  return source && metrics.length ? { source, metrics } : null;
}

function normalizeDetails(insight = {}) {
  const details = Array.isArray(insight.details) ? insight.details : [];
  return details.map((detail) => {
    const rawLines = detail && typeof detail === 'object' && !Array.isArray(detail)
      ? { title: String(detail.title || '').trim(), items: (detail.items || []).flatMap((item) => String(item || '').split(/\r?\n/)) }
      : (() => {
          const lines = String(detail || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          return { title: lines[0] || '', items: lines.slice(1) };
        })();
    const rows = rawLines.items.map((item) => parseMetricRow(item) || { source: item, metrics: [] });
    return { title: rawLines.title, rows, notes: [] };
  }).filter((section) => section.title || section.rows.length || section.notes.length);
}

function normalizeReport(viewModel) {
  return (viewModel?.tables || []).map((table) => ({
    title: table.title,
    rows: (table.rows || []).map((row) => {
      const source = row.cells?.[0]?.value || `Row ${row.rank}`;
      const metrics = (row.cells || []).slice(1).map((cell, index) => ({
        label: table.columns?.[index + 1]?.label || `Metric ${index + 1}`,
        value: cell.value,
        change: cell.format === 'delta_percent' ? cell.value : '',
        tone: cell.numericValue > 0 ? 'positive' : cell.numericValue < 0 ? 'negative' : 'neutral'
      }));
      return { source, metrics };
    }),
    notes: []
  }));
}

function paginateSections(sections) {
  const pages = [];
  let page = [];
  let rowCount = 0;
  for (const section of sections) {
    const sectionRows = section.rows.length;
    if (page.length && rowCount + sectionRows > PAGE_ROW_LIMIT) {
      pages.push(page);
      page = [];
      rowCount = 0;
    }
    if (sectionRows > PAGE_ROW_LIMIT) {
      if (page.length) pages.push(page);
      for (let offset = 0; offset < sectionRows; offset += PAGE_ROW_LIMIT) {
        pages.push([{ ...section, title: offset ? `${section.title} (continued)` : section.title, rows: section.rows.slice(offset, offset + PAGE_ROW_LIMIT), notes: offset ? [] : section.notes }]);
      }
      page = [];
      rowCount = 0;
      continue;
    }
    page.push(section);
    rowCount += sectionRows;
  }
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

function text(x, y, value, { size = 18, weight = 400, color = '#1f2937', anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}px" font-weight="${weight}" fill="${color}">${escapeXml(value)}</text>`;
}

function splitText(value, maxLength = 78) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxLength && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function renderMetricTable(section, y) {
  const left = 64;
  const width = WIDTH - (left * 2);
  const sourceWidth = 290;
  const metricWidth = (width - sourceWidth) / 3;
  const headerHeight = 50;
  const rowHeight = 88;
  const hasMetrics = section.rows.some((row) => row.metrics?.length);
  const rowCount = Math.max(section.rows.length, 1);
  const tableHeight = headerHeight + (rowCount * rowHeight);
  let markup = `<rect x="${left}" y="${y}" width="${width}" height="${tableHeight}" rx="5" fill="#ffffff" stroke="#dbe3ee"/>`;
  markup += `<rect x="${left}" y="${y}" width="${width}" height="${headerHeight}" rx="5" fill="#f1f5f9"/>`;
  markup += text(left + 18, y + 33, hasMetrics ? 'SOURCE' : 'DETAIL', { size: 16, weight: 700, color: '#64748b' });

  if (hasMetrics) {
    for (let index = 0; index < 3; index += 1) {
      const label = section.rows.flatMap((row) => row.metrics || [])[index]?.label || '';
      if (label) markup += text(left + sourceWidth + (metricWidth * index) + 14, y + 33, label.toUpperCase(), { size: 16, weight: 700, color: '#64748b' });
    }
  }

  if (!section.rows.length) {
    markup += text(left + 18, y + headerHeight + 42, 'No data available', { size: 20, color: '#64748b' });
  }

  section.rows.forEach((row, rowIndex) => {
    const rowY = y + headerHeight + (rowIndex * rowHeight);
    markup += `<line x1="${left}" y1="${rowY}" x2="${left + width}" y2="${rowY}" stroke="#e5e7eb"/>`;
    markup += `<rect x="${left + 14}" y="${rowY + 24}" width="32" height="32" rx="4" fill="#dbeafe"/>`;
    markup += text(left + 30, rowY + 47, String(rowIndex + 1), { size: 17, weight: 800, color: '#2563eb', anchor: 'middle' });
    const sourceLines = splitText(row.source, 27).slice(0, 2);
    sourceLines.forEach((line, lineIndex) => {
      markup += text(left + 58, rowY + 38 + (lineIndex * 27), line, { size: 21, weight: 700, color: '#0f172a' });
    });

    (row.metrics || []).slice(0, 3).forEach((metric, metricIndex) => {
      const cellX = left + sourceWidth + (metricWidth * metricIndex) + 14;
      const toneColor = metric.tone === 'positive' ? '#047857' : metric.tone === 'negative' ? '#dc2626' : '#111827';
      markup += text(cellX, rowY + 37, metric.value, { size: 21, weight: 700, color: '#111827' });
      if (metric.change) {
        const changeText = metric.change.length > 25 ? metric.change.slice(0, 23) + '…' : metric.change;
        markup += text(cellX, rowY + 66, changeText, { size: 17, weight: 600, color: toneColor });
      }
    });
  });

  return { markup, height: tableHeight };
}

async function renderTelegramPage({ title, summary, confidence, sections, brandName, workflowName, severity, pageNumber, pageCount }) {
  const presentation = getPresentation(severity);
  const margin = 32;
  const contentX = 52;
  const contentWidth = WIDTH - (contentX * 2);
  const summaryLines = splitText(summary, 86).slice(0, 4);
  const summaryBlockY = 170;
  const summaryHeight = Math.max(112, 46 + (summaryLines.length * 31));
  const confidenceText = formatConfidence(confidence);
  let cursorY = summaryBlockY + summaryHeight + (confidenceText ? 76 : 30);
  const sectionsSvg = [];

  sections.forEach((section) => {
    cursorY += 32;
    sectionsSvg.push(text(contentX, cursorY, section.title.toUpperCase(), { size: 17, weight: 800, color: '#475569' }));
    cursorY += 16;
    const table = renderMetricTable(section, cursorY);
    sectionsSvg.push(table.markup);
    cursorY += table.height;
    if (section.notes?.length) {
      cursorY += 12;
      section.notes.slice(0, 3).forEach((note) => {
        for (const line of splitText(`• ${note}`, 96).slice(0, 2)) {
          cursorY += 23;
          sectionsSvg.push(text(contentX + 10, cursorY, line, { size: 14, color: '#475569' }));
        }
      });
    }
  });

  const height = Math.max(cursorY + 48, 620);
  const pageLabel = pageCount > 1 ? ` · ${pageNumber}/${pageCount}` : '';
  const headerTitle = `${title || 'Insight report'}${pageLabel}`;
  const summarySvg = summaryLines.map((line, index) => text(contentX + 22, summaryBlockY + 68 + (index * 30), line, {
    size: index === 0 ? 27 : 25,
    weight: index === 0 ? 750 : 650,
    color: '#f8fafc'
  })).join('');
  const confidenceSvg = confidenceText
    ? `<rect x="${contentX}" y="${summaryBlockY + summaryHeight + 18}" width="240" height="48" rx="4" fill="#ecfdf5" stroke="#a7f3d0"/>${text(contentX + 16, summaryBlockY + summaryHeight + 49, 'CONFIDENCE', { size: 15, weight: 800, color: '#047857' })}${text(contentX + 222, summaryBlockY + summaryHeight + 50, confidenceText, { size: 21, weight: 800, color: '#065f46', anchor: 'end' })}`
    : '';
  const renderedSections = sectionsSvg.join('');
  const workflowLabel = workflowName ? `${workflowName}${brandName ? ` / ${brandName}` : ''}` : brandName || 'Datum Intelligence';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <rect width="100%" height="100%" fill="#eef2f7"/>
    <rect x="${margin}" y="${margin}" width="${WIDTH - margin * 2}" height="${height - margin * 2}" rx="8" fill="#ffffff" stroke="#dbe3ee"/>
    <rect x="${margin}" y="${margin}" width="${WIDTH - margin * 2}" height="132" rx="8" fill="#172033"/>
    <rect x="${margin}" y="${margin + 124}" width="${WIDTH - margin * 2}" height="8" fill="#172033"/>
    ${text(contentX, 84, 'DATUM INTELLIGENCE INSIGHT', { size: 16, weight: 800, color: '#cbd5e1' })}
    ${text(contentX, 124, headerTitle, { size: 34, weight: 750, color: '#ffffff' })}
    ${text(contentX, 152, workflowLabel, { size: 20, color: '#cbd5e1' })}
    <rect x="${WIDTH - contentX - 126}" y="58" width="126" height="34" rx="4" fill="#334155"/>
    ${text(WIDTH - contentX - 63, 81, presentation.label, { size: 15, weight: 800, color: '#ffffff', anchor: 'middle' })}
    <rect x="${contentX}" y="${summaryBlockY}" width="${contentWidth}" height="${summaryHeight}" rx="5" fill="#14234a" stroke="#1e3a8a"/>
    ${text(contentX + 22, summaryBlockY + 36, 'KEY TAKEAWAY', { size: 13, weight: 800, color: '#bfdbfe' })}
    ${summarySvg}
    ${confidenceSvg}
    ${renderedSections}
    ${text(contentX, height - 46, 'Generated by Datum Intelligence', { size: 15, color: '#64748b' })}
  </svg>`;

  let buffer = await sharp(Buffer.from(svg)).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 55, mozjpeg: true }).toBuffer();
  if (buffer.length > MAX_IMAGE_BYTES) {
    buffer = await sharp(Buffer.from(svg)).resize({ width: 760, withoutEnlargement: true }).jpeg({ quality: 43, mozjpeg: true }).toBuffer();
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Telegram report image exceeds ${MAX_IMAGE_BYTES} bytes`);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function renderTelegramImages({ title, message, insight, reportViewModel, brandName, workflowName, severity = 'info' }) {
  const sections = reportViewModel ? normalizeReport(reportViewModel) : normalizeDetails(insight);
  const summary = reportViewModel?.description || reportViewModel?.title || insight?.summary || '';
  const confidence = insight?.confidence;
  const rows = sections.reduce((count, section) => count + section.rows.length, 0);
  if (rows > MAX_ROWS) throw new Error(`Telegram report has ${rows} rows; maximum supported is ${MAX_ROWS}`);
  if (!sections.length && message) {
    sections.push({
      title: 'DETAILS',
      rows: String(message).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ source: line, metrics: [] })),
      notes: []
    });
  }

  const pages = paginateSections(sections);
  const pageCount = pages.length;
  const images = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    images.push(await renderTelegramPage({
      title,
      summary,
      confidence,
      sections: pages[pageIndex],
      brandName: reportViewModel?.branding?.displayName || brandName,
      workflowName,
      severity,
      pageNumber: pageIndex + 1,
      pageCount
    }));
  }
  return images;
}

module.exports = { renderTelegramImages, parseMetricRow, normalizeDetails, normalizeReport };