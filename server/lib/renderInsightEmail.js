function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlPreserveBreaks(value) {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

function getValueColor(value) {
  const normalized = String(value || '').trim();
  if (normalized.startsWith('-')) return '#dc2626';
  return '#059669';
}

function colorizeNumericText(value) {
  const escaped = escapeHtml(String(value ?? ''));
  const NUMBER_RE = /(^|[\s([{>])([+-]?\d+(?:\.\d+)?%?)(?=$|[\s)\]}<,.:;!?])/g;

  return escaped.replace(NUMBER_RE, (match, prefix, token) => {
    if (!token || token.startsWith('+0') || token === '0' || token === '0%' || token === '0.00' || token === '0.00%') {
      return `${prefix}${token}`;
    }

    const numeric = Number(String(token).replace(/%$/, ''));
    if (Number.isNaN(numeric) || numeric === 0) {
      return `${prefix}${token}`;
    }

    const color = numeric > 0 ? '#059669' : '#dc2626';
    return `${prefix}<span style="color:${color} !important;-webkit-text-fill-color:${color};font-weight:700;">${token}</span>`;
  });
}

function splitDetailLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatLargeIntegers(value) {
  return String(value || '')
    .replace(/\s*->\s*/g, ' → ')
    .replace(/\b\d{4,}\b/g, (token) => Number(token).toLocaleString('en-US'));
}

function parseMetricSegment(segment) {
  const normalized = formatLargeIntegers(segment);
  const metricMatch = normalized.match(/^([^\d+-]*?)([+-]?\d.*)$/);
  const label = metricMatch?.[1]?.trim() || '';
  const rawValue = metricMatch?.[2]?.trim() || normalized;
  const deltaMatch = rawValue.match(/^(.*?)\s+\((?:(?:change|increase|drop|decrease|no change)\s+)?([+-]?\d+(?:\.\d+)?%)\)$/i);

  if (!deltaMatch) {
    return { label, value: rawValue, delta: null, deltaValue: null };
  }

  const deltaValue = Number(deltaMatch[2].replace('%', ''));
  return {
    label,
    value: deltaMatch[1].trim(),
    delta: `${deltaValue > 0 ? '+' : ''}${deltaMatch[2]}`,
    deltaValue,
  };
}

function parseRankedItem(item) {
  const match = String(item || '').match(/^(\d+)\.\s+(.+)$/);
  if (!match) return null;

  const parts = match[2].split(' | ').map((part) => part.trim()).filter(Boolean);
  return {
    rank: Number(match[1]),
    label: parts[0] || `Rank ${match[1]}`,
    metrics: parts.slice(1).map(parseMetricSegment),
  };
}

function renderDeltaBadge(metric) {
  if (!metric.delta) return '';
  const color = metric.deltaValue > 0
    ? '#047857'
    : metric.deltaValue < 0
      ? '#b91c1c'
      : '#475569';
  const background = metric.deltaValue > 0
    ? '#ecfdf5'
    : metric.deltaValue < 0
      ? '#fef2f2'
      : '#f1f5f9';

  return `<span style="display:inline-block;margin-left:6px;padding:2px 6px;border-radius:3px;background:${background};color:${color} !important;-webkit-text-fill-color:${color};font-size:11px;font-weight:700;white-space:nowrap;">${escapeHtml(metric.delta)}</span>`;
}

function renderRankedEntry(entry) {
  return `
    <div style="margin-top:10px;padding:12px;border:1px solid #dbe3ee;border-radius:4px;background:#ffffff;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td valign="top" style="width:28px;padding-right:10px;">
            <div style="width:24px;height:24px;border-radius:4px;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:800;line-height:24px;text-align:center;">${entry.rank}</div>
          </td>
          <td valign="top">
            <div style="font-size:14px;line-height:1.4;font-weight:700;color:#0f172a;word-break:break-word;">${escapeHtml(entry.label)}</div>
            ${entry.metrics.length ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;border-collapse:collapse;">
                ${entry.metrics.map((metric) => `
                  <tr>
                    <td valign="top" style="width:70px;padding:5px 10px 5px 0;border-top:1px solid #eef2f7;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#64748b;white-space:nowrap;">${escapeHtml(metric.label || 'Value')}</td>
                    <td valign="top" align="right" style="padding:5px 0;border-top:1px solid #eef2f7;font-size:12px;line-height:1.5;font-weight:600;color:#1e293b;font-variant-numeric:tabular-nums;">${escapeHtml(metric.value)}${renderDeltaBadge(metric)}</td>
                  </tr>
                `).join('')}
              </table>
            ` : ''}
          </td>
        </tr>
      </table>
    </div>
  `;
}

function renderDetailCard(detail, index) {
  const parsed = normalizeDetail(detail);
  const title = parsed.title;
  const metricLines = parsed.items;
  const rankedEntries = metricLines.map(parseRankedItem).filter(Boolean);
  const metricRows = metricLines
    .map((line) => {
      if (parseRankedItem(line)) return null;
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) {
        return null;
      }
      const label = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (!label || !value) return null;
      return { label, value };
    })
    .filter(Boolean);
  const looseLines = metricLines.filter((line) => !line.includes(':') && !parseRankedItem(line));

  return `
    <div style="margin-bottom:12px;padding:18px 20px;border:1px solid #d9e1ec;border-radius:4px;background:#f8fafc;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td valign="top" style="width:40px;padding-right:14px;">
            <div style="width:32px;height:32px;border-radius:4px;background:#dbeafe;color:#1d4ed8;font-size:14px;font-weight:800;line-height:32px;text-align:center;font-variant-numeric:tabular-nums;">
              ${index + 1}
            </div>
          </td>
          <td valign="top">
            <div style="font-size:19px;line-height:1.35;font-weight:650;color:#0f172a;letter-spacing:-0.01em;">${escapeHtml(title)}</div>
            ${rankedEntries.length ? rankedEntries.map(renderRankedEntry).join('') : ''}
            ${metricRows.length ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-collapse:collapse;">
                ${metricRows.map((row) => `
                  <tr>
                    <td valign="top" style="padding:0 14px 8px 0;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;white-space:nowrap;">
                      ${escapeHtml(row.label)}
                    </td>
                    <td valign="top" style="padding:0 0 8px 0;font-size:18px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap;">
                      <span style="color:${getValueColor(row.value)} !important;-webkit-text-fill-color:${getValueColor(row.value)};font-weight:700;">
                        ${escapeHtml(row.value)}
                      </span>
                    </td>
                  </tr>
                `).join('')}
              </table>
            ` : ''}
            ${looseLines.length ? `
              <div style="margin-top:${metricRows.length ? '4px' : '12px'};font-size:14px;line-height:1.6;color:#334155;white-space:pre-wrap;">
                ${colorizeNumericText(looseLines.join('\n')).replace(/\n/g, '<br />')}
              </div>
            ` : ''}
          </td>
        </tr>
      </table>
    </div>
  `;
}

function normalizeDetail(detail) {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const title = String(detail.title || '').trim();
    const items = Array.isArray(detail.items)
      ? detail.items.flatMap(splitDetailLines)
      : [];
    return { title, items };
  }

  const lines = String(detail || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    title: lines[0] || '',
    items: lines.slice(1)
  };
}

function detailToText(detail) {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const title = String(detail.title || '').trim();
    const items = Array.isArray(detail.items)
      ? detail.items.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    return [title, ...items].filter(Boolean).join('\n');
  }

  return String(detail || '').trim();
}

function renderInsightEmail({ insight, workflowId, workflowName, brandName, subjectTemplate, tenantId }) {
  const summary = insight?.summary || 'Insight generated';
  const details = Array.isArray(insight?.details)
    ? insight.details.filter((detail) => {
        if (detail === undefined || detail === null) return false;
        if (typeof detail === 'object' && !Array.isArray(detail)) {
          return String(detail.title || '').trim() !== '' || Array.isArray(detail.items);
        }
        return String(detail).trim() !== '';
      })
    : [];
  const confidence = insight?.confidence;
  const confidencePct = confidence == null || Number.isNaN(Number(confidence))
    ? null
    : `${Math.round(Number(confidence) * 100)}%`;

  const tenantPrefix = (tenantId || brandName || 'Tenant').trim();
  const subjectBody = String(subjectTemplate || summary).trim() || summary;
  const subject = `${tenantPrefix}: ${subjectBody}`.slice(0, 200);
  const workflowLabel = workflowName || workflowId || 'workflow';
  const brandLabel = brandName || tenantId || 'unknown brand';

  const detailsHtml = details.length
    ? `
      <div style="margin-top:28px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;margin-bottom:12px;">At a Glance</div>
        ${details.map((detail, index) => renderDetailCard(detail, index)).join('')}
      </div>
    `
    : '';

  const confidenceHtml = confidencePct
    ? `
      <div style="display:inline-block;padding:0;border-radius:4px;background:#ecfdf5;border:1px solid #a7f3d0;overflow:hidden;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding:11px 14px 10px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#047857;white-space:nowrap;border-right:1px solid rgba(16, 185, 129, 0.18);">
              Confidence
            </td>
            <td style="padding:9px 16px 9px 14px;font-size:16px;font-weight:800;line-height:1;color:#065f46;font-variant-numeric:tabular-nums;white-space:nowrap;">
              ${escapeHtml(confidencePct)}
            </td>
          </tr>
        </table>
      </div>
    `
    : '';

  const html = `
<!doctype html>
<html>
  <head>
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
  </head>
  <body style="margin:0;padding:28px;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ee;border-radius:4px;overflow:hidden;box-shadow:0 10px 30px rgba(15, 23, 42, 0.08);">
      <div style="padding:24px 28px;background-color:#0f172a;background-image:linear-gradient(135deg, #0f172a 0%, #1e293b 100%);color:#ffffff !important;-webkit-text-fill-color:#ffffff;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td valign="top">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#cbd5e1 !important;-webkit-text-fill-color:#cbd5e1;">Datum Intelligence Insight</div>
            <div style="margin-top:10px;font-size:15px;line-height:1.5;color:#f8fafc !important;-webkit-text-fill-color:#f8fafc;">
              ${escapeHtml(workflowLabel)}
            </div>
            <div style="margin-top:4px;font-size:13px;line-height:1.5;color:#cbd5e1 !important;-webkit-text-fill-color:#cbd5e1;">
              Brand<span style="opacity:0.55;"> / </span>${escapeHtml(brandLabel)}
            </div>
            </td>
            <td valign="top" align="right" style="width:1%;white-space:nowrap;">
              <div style="display:inline-block;padding:8px 14px;border-radius:4px;background-color:#334155;color:#ffffff !important;-webkit-text-fill-color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                Alert Summary
              </div>
            </td>
          </tr>
        </table>
      </div>
      <div style="padding:28px;">
        <div style="padding:22px 24px;border-radius:4px;background-color:#0f172a;background-image:linear-gradient(135deg, #0f172a 0%, #172554 100%);border:1px solid #1e3a8a;box-shadow:inset 0 1px 0 rgba(255,255,255,0.04);color:#f8fafc !important;-webkit-text-fill-color:#f8fafc;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#bfdbfe !important;-webkit-text-fill-color:#bfdbfe;margin-bottom:10px;">Key Takeaway</div>
          <div style="font-size:24px;line-height:1.3;font-weight:750;color:#f8fafc !important;-webkit-text-fill-color:#f8fafc;white-space:pre-wrap;letter-spacing:-0.02em;text-shadow:0 1px 1px rgba(0,0,0,0.12);">${colorizeNumericText(summary)}</div>
        </div>
        <div style="margin-top:18px;">
          ${confidenceHtml}
        </div>
        ${detailsHtml}
        <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#64748b;">
          This message was generated automatically by Datum Intelligence to help you identify the issue quickly.
        </div>
      </div>
    </div>
  </body>
</html>`;

  const textLines = [
    'Datum Intelligence Insight',
    workflowLabel ? `Workflow: ${workflowLabel}` : null,
    brandLabel ? `Brand: ${brandLabel}` : null,
    '',
    `Summary: ${summary}`,
    details.length ? '' : null,
    details.length ? 'Details:' : null,
    ...details.map((detail, index) => `${index + 1}. ${detailToText(detail)}`),
    confidencePct ? '' : null,
    confidencePct ? `Confidence: ${confidencePct}` : null,
  ].filter(Boolean);

  return {
    subject,
    html,
    text: textLines.join('\n')
  };
}

module.exports = {
  renderInsightEmail,
};
