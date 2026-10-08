const { resolveEmailBranding } = require('./emailBranding');
const { isLowerWorse } = require('./stateEngine/severity');

// Renders the single email the state engine sends for one execution. The workflow's
// own email/insight/messaging nodes produce the content -- their rendered output is captured
// during the run (server/lib/notificationCapture.js) and sent exactly as rendered:
// same subject, same body, no state banner or prefix. The state engine only decides
// *whether* it goes out. Only when no email node ran on the alerting path does this
// fall back to a short built-in message.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : 'unknown';
}

// One-line description of the finding, used only by the fallback email.
function headline(decision) {
  const metric = decision.finding?.metric || 'metric';
  const value = formatNumber(decision.finding?.value);
  const thresholds = decision.finding?.thresholds || {};
  const bound = thresholds && isLowerWorse(thresholds) ? 'at or below' : 'at or above';
  if (decision.resulting_state === 'CRITICAL') {
    return `${metric} is ${value}, ${bound} the critical threshold of ${formatNumber(thresholds.critical)}.`;
  }
  return `${metric} is ${value}, ${bound} the alert threshold of ${formatNumber(thresholds.normal)}.`;
}

function uniqueRecipients(lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const value of Array.isArray(list) ? list : []) {
      const email = String(value || '').trim();
      if (email && !seen.has(email.toLowerCase())) {
        seen.add(email.toLowerCase());
        result.push(email);
      }
    }
  }
  return result;
}

function renderFallback({ decision, workflowName, brandName, branding }) {
  const resolved = resolveEmailBranding(branding);
  const name = workflowName || 'Workflow alert';
  const message = headline(decision);
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;">',
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;font-family:Arial,sans-serif;">',
    `<div style="font-size:16px;font-weight:bold;color:${resolved.primaryColor};margin-bottom:16px;">${escapeHtml(resolved.displayName)}</div>`,
    `<p style="font-size:15px;color:#0f172a;">${escapeHtml(message)}</p>`,
    `<p style="font-size:14px;color:#334155;">Workflow: <strong>${escapeHtml(name)}</strong>${brandName ? ` · Brand: <strong>${escapeHtml(brandName)}</strong>` : ''}</p>`,
    `<p style="font-size:12px;color:#94a3b8;margin-top:24px;">${escapeHtml(resolved.footerText)}</p>`,
    '</div></body></html>'
  ].join('');
  const text = [message, '', `Workflow: ${name}${brandName ? ` · Brand: ${brandName}` : ''}`].join('\n');
  return { subject: `${name}${brandName ? ` · ${brandName}` : ''}`, html, text };
}

// intents: [{ to, subject, html, text }] captured from the run's email nodes.
// fallbackRecipients: used when nothing was captured.
function renderStateEmail({ decision, intents = [], fallbackRecipients = [], workflowName, brandName, branding }) {
  if (intents.length) {
    const [first] = intents;
    return {
      to: uniqueRecipients(intents.map((intent) => intent.to)),
      subject: first.subject || workflowName || 'Workflow alert',
      html: intents.map((intent) => intent.html || '').join('<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">'),
      text: intents.map((intent) => intent.text || '').join('\n\n')
    };
  }

  const fallback = renderFallback({ decision, workflowName, brandName, branding });
  return {
    to: uniqueRecipients([fallbackRecipients]),
    subject: fallback.subject,
    html: fallback.html,
    text: fallback.text
  };
}

// Recipients for the built-in fallback email: whatever the workflow itself would
// have mailed -- every email node's `to`, every email-enabled insight node's
// `email.to`, and every messaging node's `email.to` when its email channel is on.
function collectWorkflowRecipients(definition = {}) {
  const lists = [];
  for (const node of definition.nodes || []) {
    if (node.type === 'email') lists.push(node.to);
    if (node.type === 'insight' && node.email?.enabled) lists.push(node.email.to);
    if (node.type === 'messaging' && node.channels?.email) lists.push(node.email?.to);
  }
  return uniqueRecipients(lists);
}

// Whether the workflow can notify anyone at all: an email recipient anywhere, or a
// messaging node with Telegram users.
function hasNotificationTarget(definition = {}) {
  if (collectWorkflowRecipients(definition).length) return true;
  return (definition.nodes || []).some((node) => node.type === 'messaging'
    && node.channels?.telegram
    && Array.isArray(node.telegram?.users)
    && node.telegram.users.some((user) => user && (user.username || user.telegramChatId)));
}

module.exports = {
  renderStateEmail,
  collectWorkflowRecipients,
  hasNotificationTarget,
  headline
};
