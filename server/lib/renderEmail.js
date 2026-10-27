const { renderInsightEmail } = require('./renderInsightEmail');
const { renderReportEmail } = require('./renderReportEmail');
const { renderBindingTemplate, resolveBinding } = require('./emailBindings');
const { applyEmailFooter } = require('./emailFooter');

function renderEmail({ format, template, context, branding, subject }) {
  const renderedSubject = renderBindingTemplate(subject, context);
  if (format === 'report') {
    return applyEmailFooter(renderReportEmail({ context, template, branding, subject: renderedSubject }));
  }
  if (format === 'insight') {
    const source = template?.insightSource || 'scratch.finalInsight';
    const resolved = resolveBinding(context, source);
    if (!resolved.found || !resolved.value || typeof resolved.value !== 'object') {
      throw new Error(`missing required insight binding: ${source}`);
    }
    const rendered = renderInsightEmail({
      insight: resolved.value,
      workflowId: context?.meta?.workflowId,
      workflowName: context?.meta?.workflowName,
      brandName: context?.meta?.brandName,
      tenantId: context?.meta?.tenantId,
    });
    return applyEmailFooter({ ...rendered, subject: renderedSubject });
  }
  throw new Error(`unsupported email format: ${format}`);
}

module.exports = { renderEmail };
