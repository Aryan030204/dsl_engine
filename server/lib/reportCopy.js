const DEFAULT_REPORT_COPY_FIELDS = Object.freeze({
  performance_report_v1: ['eyebrow', 'title', 'description', 'period.current', 'period.comparison'],
  inventory_alert_v1: ['eyebrow', 'title', 'description'],
  dashboard_report_v1: ['headerLabel', 'period.current', 'period.comparison']
});

function hasReportCopyField(template, field) {
  if (template?.includeReportCopy === false) return false;
  const defaults = DEFAULT_REPORT_COPY_FIELDS[template?.preset] || [];
  const configured = Array.isArray(template?.reportCopyFields) ? template.reportCopyFields : defaults;
  return configured.includes(field);
}

module.exports = { DEFAULT_REPORT_COPY_FIELDS, hasReportCopyField };
