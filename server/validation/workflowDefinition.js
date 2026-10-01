const ALLOWED_NODE_TYPES = new Set([
  'validation',
  'metric_compare',
  'branch',
  'recursive_dimension_breakdown',
  'composite',
  'workflow_ref',
  'insight',
  'email',
  'messaging'
]);

const ALLOWED_DIMENSIONS = new Set([
  "product_id",
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'landing_page_path',
  'landing_page_type',
  'referrer_name'
]);

const ALLOWED_OPS = new Set(['>', '>=', '<', '<=', '==', '!=']);
const ALLOWED_BREAKDOWN_METRICS = new Set([
  'orders', 'sessions', 'cvr', 'atc_rate', 'atc_sessions',
  'cod_orders', 'ppcod_orders', 'prepaid_orders'
]);
const {
  getPartialDayProductCompatibilityErrors,
  getPartialDayLandingPagePathCompatibilityErrors
} = require('./productPartialDayCompatibility');
const { validateRecipients } = require('../services/emailService');
const { isSafeBindingPath } = require('../lib/emailBindings');
const { validateEmailBranding } = require('../lib/emailBranding');
const { WORKFLOW_PURPOSES } = require('../lib/stateEngine/defaults');
const { hasNotificationTarget } = require('../lib/renderStateEmail');

const EMAIL_FORMATS = new Set(['insight', 'report']);
const REPORT_PRESETS = new Set(['performance_report_v1']);
const REPORT_VALUE_FORMATS = new Set(['text', 'integer', 'decimal', 'percent_ratio', 'percent', 'delta_percent', 'currency']);
const REPORT_TONES = new Set(['positive', 'negative', 'neutral']);
const REPORT_ICONS = new Set(['metric', 'sessions', 'orders', 'conversion', 'trend', 'sales', 'aov', 'cart']);
const MAX_REPORT_METRICS = 6;

function validateBindingPath(value, label, errors) {
  if (!isSafeBindingPath(value)) errors.push(`${label} must be a safe dot-separated context path`);
}

function validateBindingTemplate(value, label, errors) {
  if (typeof value !== 'string') return;
  let remainder = value;
  const tokens = value.matchAll(/\{\{([^{}]+)\}\}/g);
  for (const token of tokens) {
    if (!isSafeBindingPath(token[1].trim())) {
      errors.push(`${label} contains an unsafe binding`);
    }
    remainder = remainder.replace(token[0], '');
  }
  if (/[{}]/.test(remainder)) {
    errors.push(`${label} contains malformed binding syntax`);
  }
}

function rejectUnknownFields(value, allowedFields, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.keys(value).filter((key) => !allowedFields.has(key)).forEach((key) => {
    errors.push(`${label} contains unsupported field ${key}`);
  });
}

function validateEmailNode(node, errors) {
  const prefix = `email node ${node.id}`;
  if (!EMAIL_FORMATS.has(node.format)) errors.push(`${prefix} format must be insight or report`);
  if (typeof node.subject !== 'string' || node.subject.trim() === '') errors.push(`${prefix} subject is required`);
  validateBindingTemplate(node.subject, `${prefix} subject`, errors);
  const recipients = validateRecipients(node.to);
  if (!recipients.ok) errors.push(`${prefix} recipients invalid: ${recipients.error}`);
  errors.push(...validateEmailBranding(node.branding, `${prefix} branding`));
  validateEmailTemplate(node, prefix, errors);
}

// Shared by email and messaging nodes: both render through renderEmail, so an
// insight or report template must pass the same checks whichever node carries it.
function validateEmailTemplate(node, prefix, errors) {
  if (!node.template || typeof node.template !== 'object' || Array.isArray(node.template)) {
    errors.push(`${prefix} template must be an object`);
    return;
  }
  if (node.format === 'insight') {
    validateBindingPath(node.template.insightSource || 'scratch.finalInsight', `${prefix} template.insightSource`, errors);
    const unsupported = Object.keys(node.template).filter((key) => key !== 'insightSource');
    unsupported.forEach((key) => errors.push(`${prefix} insight template contains unsupported field ${key}`));
    return;
  }
  if (node.format !== 'report') return;

  if (!REPORT_PRESETS.has(node.template.preset)) errors.push(`${prefix} has unsupported report preset`);
  ['eyebrow', 'title'].forEach((field) => {
    if (typeof node.template[field] !== 'string' || node.template[field].trim() === '') {
      errors.push(`${prefix} template.${field} is required`);
    }
  });
  if (node.template.description !== undefined && typeof node.template.description !== 'string') {
    errors.push(`${prefix} template.description must be a string`);
  }
  if (!node.template.period || typeof node.template.period !== 'object' || Array.isArray(node.template.period)) {
    errors.push(`${prefix} template.period must be an object`);
  }
  rejectUnknownFields(node.template.period, new Set(['current', 'comparison']), `${prefix} template.period`, errors);
  validateBindingPath(node.template.period?.current, `${prefix} template.period.current`, errors);
  validateBindingPath(node.template.period?.comparison, `${prefix} template.period.comparison`, errors);

  if (!Array.isArray(node.template.metrics) || node.template.metrics.length < 1 || node.template.metrics.length > MAX_REPORT_METRICS) {
    errors.push(`${prefix} template.metrics must contain one to ${MAX_REPORT_METRICS} items`);
  } else {
    node.template.metrics.forEach((metric, index) => {
      const label = `${prefix} metric ${index + 1}`;
      if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof metric.label !== 'string' || metric.label.trim() === '') errors.push(`${label} label is required`);
      validateBindingPath(metric.value, `${label} value`, errors);
      if (metric.change !== undefined) validateBindingPath(metric.change, `${label} change`, errors);
      if (!REPORT_VALUE_FORMATS.has(metric.format)) errors.push(`${label} has unsupported format`);
      if (metric.icon !== undefined && !REPORT_ICONS.has(metric.icon)) errors.push(`${label} has unsupported icon`);
      rejectUnknownFields(metric, new Set(['label', 'value', 'change', 'format', 'icon']), label, errors);
    });
  }

  if (!Array.isArray(node.template.tables) || node.template.tables.length < 1 || node.template.tables.length > 4) {
    errors.push(`${prefix} template.tables must contain one to four tables`);
  } else {
    node.template.tables.forEach((table, tableIndex) => {
      const label = `${prefix} table ${tableIndex + 1}`;
      if (!table || typeof table !== 'object' || Array.isArray(table)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof table.title !== 'string' || table.title.trim() === '') errors.push(`${label} title is required`);
      validateBindingPath(table.source, `${label} source`, errors);
      if (!REPORT_TONES.has(table.tone || 'neutral')) errors.push(`${label} has unsupported tone`);
      if (!Number.isInteger(table.limit) || table.limit < 1 || table.limit > 100) errors.push(`${label} limit must be an integer from 1 to 100`);
      if (!Array.isArray(table.columns) || table.columns.length < 1) {
        errors.push(`${label} must contain at least one column`);
      } else {
        table.columns.forEach((column, columnIndex) => {
          const columnLabel = `${label} column ${columnIndex + 1}`;
          if (!column || typeof column !== 'object' || Array.isArray(column)) {
            errors.push(`${columnLabel} must be an object`);
            return;
          }
          if (typeof column.label !== 'string' || column.label.trim() === '') errors.push(`${columnLabel} label is required`);
          validateBindingPath(column.path, `${columnLabel} path`, errors);
          if (!REPORT_VALUE_FORMATS.has(column.format)) errors.push(`${columnLabel} has unsupported format`);
          rejectUnknownFields(column, new Set(['label', 'path', 'format']), columnLabel, errors);
        });
      }
      rejectUnknownFields(table, new Set(['title', 'source', 'tone', 'limit', 'columns']), label, errors);
    });
  }
  if (node.template.insightSource !== undefined) {
    validateBindingPath(node.template.insightSource, `${prefix} template.insightSource`, errors);
  }
  const allowed = new Set(['preset', 'eyebrow', 'title', 'description', 'period', 'metrics', 'insightSource', 'tables']);
  Object.keys(node.template).filter((key) => !allowed.has(key)).forEach((key) => {
    errors.push(`${prefix} report template contains unsupported field ${key}`);
  });
}

// Telegram integration (ported from my-feature-branch d0fc6f9). A messaging node
// renders like an email node and delivers to email and/or Telegram.
function validateMessagingNode(node, errors) {
  const prefix = `messaging node ${node.id}`;
  const channels = node.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    errors.push(`${prefix} channels must be an object`);
    return;
  }
  if (typeof channels.email !== 'boolean' || typeof channels.telegram !== 'boolean') {
    errors.push(`${prefix} channels.email and channels.telegram must be booleans`);
  }
  if (!channels.email && !channels.telegram) {
    errors.push(`${prefix} must enable email, telegram, or both`);
  }
  if (!EMAIL_FORMATS.has(node.format)) errors.push(`${prefix} format must be insight or report`);
  if (typeof node.subject !== 'string' || node.subject.trim() === '') errors.push(`${prefix} subject is required`);
  validateBindingTemplate(node.subject, `${prefix} subject`, errors);
  validateEmailTemplate(node, prefix, errors);

  if (channels.email) {
    const recipients = validateRecipients(node.email?.to);
    if (!recipients.ok) errors.push(`${prefix} email recipients invalid: ${recipients.error}`);
    errors.push(...validateEmailBranding(node.branding, `${prefix} branding`));
  }
  if (channels.telegram) {
    const users = Array.isArray(node.telegram?.users) ? node.telegram.users : [];
    if (!users.length || users.some((user) => !user || (!user.username && !user.telegramChatId))) {
      errors.push(`${prefix} telegram users must contain a username or telegramChatId`);
    }
    if (node.telegram?.severity !== undefined && typeof node.telegram.severity !== 'string') {
      errors.push(`${prefix} telegram severity must be a string`);
    }
  }
}

function validateInsightDetailItem(detail, nodeId, errors, index) {
  if (typeof detail === 'string') {
    return;
  }

  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    errors.push(`insight node ${nodeId} detail ${index + 1} must be a string or object`);
    return;
  }

  if (typeof detail.title !== 'string' || detail.title.trim() === '') {
    errors.push(`insight node ${nodeId} detail ${index + 1} must include a non-empty title`);
  }

  if (detail.items !== undefined && !Array.isArray(detail.items)) {
    errors.push(`insight node ${nodeId} detail ${index + 1} items must be an array when provided`);
    return;
  }

  (detail.items || []).forEach((item, itemIndex) => {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`insight node ${nodeId} detail ${index + 1} item ${itemIndex + 1} must be a non-empty string`);
    }
  });
}

const WORKFLOW_PURPOSE_VALUES = new Set(Object.values(WORKFLOW_PURPOSES));
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const METRIC_KEY_RE = /^[a-z0-9_]+$/;

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

// workflow_purpose decides whether the state engine applies at all; state_config is
// its per-workflow policy (docs/workflow-state-engine.md). A daily insight/report
// workflow must send every run, so it may not enable state.
function validateStateConfig(definition, errors) {
  const purpose = definition.workflow_purpose;
  if (purpose !== undefined && !WORKFLOW_PURPOSE_VALUES.has(purpose)) {
    errors.push(`workflow_purpose must be one of ${Array.from(WORKFLOW_PURPOSE_VALUES).join('|')}`);
  }

  const config = definition.state_config;
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) {
    errors.push('state_config must be an object');
    return;
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('state_config.enabled must be a boolean');
  }
  if (config.enabled === true && purpose === WORKFLOW_PURPOSES.DAILY_INSIGHT) {
    errors.push('state_config cannot be enabled for a daily_insight workflow');
  }
  if (config.enabled !== true) return;

  const { finding, thresholds, cooldown, quiet_hours: quietHours } = config;

  if (!finding || typeof finding !== 'object') {
    errors.push('state_config.finding is required');
  } else {
    if (typeof finding.metric !== 'string' || !METRIC_KEY_RE.test(finding.metric)) {
      errors.push('state_config.finding.metric must be a metric key like cvr_delta_pct');
    }
    if (finding.direction !== undefined) {
      errors.push('state_config.finding.direction is no longer supported; use signed thresholds (e.g. normal -10, critical -20 for a drop)');
    }
  }

  // Thresholds are signed metric values. Which way is worse comes from their order:
  // critical below normal alerts on drops, critical above normal alerts on rises.
  if (!thresholds || typeof thresholds !== 'object') {
    errors.push('state_config.thresholds is required');
  } else {
    const { normal, critical } = thresholds;
    const normalOk = typeof normal === 'number' && Number.isFinite(normal);
    const criticalOk = typeof critical === 'number' && Number.isFinite(critical);
    if (!normalOk) errors.push('state_config.thresholds.normal must be a number');
    if (!criticalOk) errors.push('state_config.thresholds.critical must be a number');
    if (normalOk && criticalOk && normal === critical) {
      errors.push('state_config.thresholds.critical must differ from thresholds.normal');
    }
  }

  // The state engine only knows who to notify from the workflow's own email,
  // email-enabled insight, and messaging (email / Telegram) nodes; with none, every
  // alert would fail to send.
  if (!hasNotificationTarget(definition)) {
    errors.push('state_config is enabled but no node sends a notification: turn on "Email Insight" on an insight node, or add an Email or Messaging node with recipients');
  }

  if (config.recovery !== undefined) {
    errors.push('state_config.recovery is no longer supported; returning to normal does not send an email');
  }

  if (cooldown !== undefined) {
    ['triggered_minutes', 'critical_minutes'].forEach((field) => {
      if (cooldown?.[field] !== undefined && !isNonNegativeInteger(cooldown[field])) {
        errors.push(`state_config.cooldown.${field} must be a whole number of minutes >= 0`);
      }
    });
  }

  if (quietHours !== undefined) {
    if (!quietHours || typeof quietHours !== 'object') {
      errors.push('state_config.quiet_hours must be an object');
    } else if (quietHours.enabled === true) {
      ['start', 'end'].forEach((field) => {
        if (!HHMM_RE.test(String(quietHours[field] || ''))) {
          errors.push(`state_config.quiet_hours.${field} must be HH:MM (24h)`);
        }
      });
    }
  }
}

function validateWorkflowDefinition(definition) {
  const errors = [];

  if (!definition || typeof definition !== 'object') {
    return { ok: false, errors: ['definition must be an object'] };
  }

  // workflow_id is optional (auto-generated if not provided)
  ['workflow_type', 'version', 'nodes', 'trigger'].forEach(field => {
    if (!definition[field]) {
      errors.push(`missing ${field}`);
    }
  });

  if (definition.workflow_type && definition.workflow_type !== 'root_cause_analysis') {
    errors.push('workflow_type must be root_cause_analysis');
  }

  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    errors.push('nodes must be a non-empty array');
    return { ok: false, errors };
  }

  if (!definition.trigger || typeof definition.trigger !== 'object') {
    errors.push('trigger must be an object');
  } else {
    const { alertType, brandScope, brandIds, type } = definition.trigger;
    if (type && type !== 'alert') {
      errors.push('trigger.type must be alert');
    }
    if (!alertType || typeof alertType !== 'string') {
      errors.push('trigger.alertType is required');
    }
    if (!brandScope || !['single', 'multiple', 'global'].includes(brandScope)) {
      errors.push('trigger.brandScope must be one of single|multiple|global');
    }
    if ((brandScope === 'single' || brandScope === 'multiple')
      && (!Array.isArray(brandIds) || brandIds.length === 0)) {
      errors.push('trigger.brandIds is required for single/multiple brandScope');
    }
    if (brandScope === 'global' && Array.isArray(brandIds) && brandIds.length) {
      errors.push('trigger.brandIds must be empty for global brandScope');
    }
  }

  validateStateConfig(definition, errors);

  const nodeIds = new Set();
  for (const node of definition.nodes) {
    if (!node?.id || typeof node.id !== 'string') {
      errors.push('each node must have an id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    if (!node.type || !ALLOWED_NODE_TYPES.has(node.type)) {
      errors.push(`unsupported node type: ${node.type}`);
      continue;
    }

    if (node.type === 'validation') {
      if (!Array.isArray(node.checks) || node.checks.length === 0) {
        errors.push(`validation node ${node.id} must include checks`);
      }
    }

    if (node.type === 'metric_compare') {
      if (!Array.isArray(node.metrics) || node.metrics.length === 0) {
        errors.push(`metric_compare node ${node.id} must include metrics`);
      }
    }

    if (node.type === 'branch') {
      if (!Array.isArray(node.rules) || node.rules.length === 0) {
        errors.push(`branch node ${node.id} must include rules`);
      } else {
        for (const rule of node.rules) {
          const breakdownRuleDefinitions = [
            rule.any_in_breakdowns,
            rule.all_in_breakdowns,
            rule.filter_in_breakdowns
          ].filter(Boolean);
          if (breakdownRuleDefinitions.length > 1) {
            errors.push(`branch node ${node.id} rule ${rule._ruleId || ''} cannot define more than one breakdown rule type`);
          }

          const breakdownRule = rule.any_in_breakdowns || rule.all_in_breakdowns || rule.filter_in_breakdowns;
          if (breakdownRule) {
            if (typeof breakdownRule.dimension !== 'string' || breakdownRule.dimension.trim() === '') {
              errors.push(`branch node ${node.id} has breakdown rule with invalid dimension/output key`);
            }
            if (!Array.isArray(breakdownRule.conditions) || breakdownRule.conditions.length === 0) {
              errors.push(`branch node ${node.id} has breakdown rule without conditions`);
            }
            if (
              breakdownRule.limit !== undefined &&
              (!Number.isFinite(Number(breakdownRule.limit)) || Number(breakdownRule.limit) <= 0)
            ) {
              errors.push(`branch node ${node.id} has breakdown rule with invalid limit`);
            }
            if (
              (rule.any_in_breakdowns || rule.all_in_breakdowns)?.entry_logic !== undefined &&
              !['and', 'or'].includes((rule.any_in_breakdowns || rule.all_in_breakdowns).entry_logic)
            ) {
              errors.push(`branch node ${node.id} has breakdown rule with invalid entry_logic`);
            }
            if (
              rule.filter_in_breakdowns &&
              !['any', 'all'].includes(rule.filter_in_breakdowns.mode || 'any')
            ) {
              errors.push(`branch node ${node.id} has breakdown filter rule with invalid mode`);
            }
            if (
              rule.filter_in_breakdowns?.entry_logic !== undefined &&
              !['and', 'or'].includes(rule.filter_in_breakdowns.entry_logic)
            ) {
              errors.push(`branch node ${node.id} has breakdown filter rule with invalid entry_logic`);
            }
            if (
              rule.filter_in_breakdowns?.match_scope !== undefined &&
              !['any', 'all'].includes(rule.filter_in_breakdowns.match_scope)
            ) {
              errors.push(`branch node ${node.id} has breakdown filter rule with invalid match_scope`);
            }
            if (
              rule.filter_in_breakdowns &&
              (typeof rule.filter_in_breakdowns.write_matches_to !== 'string'
                || rule.filter_in_breakdowns.write_matches_to.trim() === '')
            ) {
              errors.push(`branch node ${node.id} has breakdown filter rule without write_matches_to`);
            }
          }

          const allConditions = rule.all || [];
          const anyConditions = rule.any || [];
          const breakdownConditions = Array.isArray(breakdownRule?.conditions) ? breakdownRule.conditions : [];
          const conditions = [...allConditions, ...anyConditions, ...breakdownConditions];
          
          for (const condition of conditions) {
            if (!ALLOWED_OPS.has(condition.op)) {
              errors.push(`branch node ${node.id} has invalid op ${condition.op}`);
            }
          }
        }
      }
    }

    if (node.type === 'recursive_dimension_breakdown') {
      if (node.base_metrics !== undefined) {
        if (!Array.isArray(node.base_metrics) || node.base_metrics.length === 0) {
          errors.push(`recursive_dimension_breakdown node ${node.id} must include at least one base metric`);
        } else {
          for (const metric of node.base_metrics) {
            if (!ALLOWED_BREAKDOWN_METRICS.has(metric)) {
              errors.push(`recursive_dimension_breakdown node ${node.id} has unsupported base metric: ${metric}`);
            }
          }
          if (new Set(node.base_metrics).size !== node.base_metrics.length) {
            errors.push(`recursive_dimension_breakdown node ${node.id} cannot repeat base metrics`);
          }
        }
      }

      const dimensions = Array.isArray(node.dimensions) && node.dimensions.length
        ? node.dimensions
        : node.dimension
          ? [node.dimension]
          : [];

      if (!dimensions.length) {
        errors.push(`recursive_dimension_breakdown node ${node.id} must include dimension(s)`);
      }

      for (const dim of dimensions) {
        if (!ALLOWED_DIMENSIONS.has(dim)) {
          errors.push(`unsupported dimension: ${dim}`);
        }
      }

      if (
        node.output_key !== undefined &&
        (typeof node.output_key !== 'string' || node.output_key.trim() === '')
      ) {
        errors.push(`recursive_dimension_breakdown node ${node.id} has invalid output_key`);
      }

      if (
        node.input_scope !== undefined &&
        !['global', 'breakdown'].includes(node.input_scope)
      ) {
        errors.push(`recursive_dimension_breakdown node ${node.id} has invalid input_scope`);
      }

      if (
        node.input_scope === 'breakdown' &&
        (typeof node.input_key !== 'string' || node.input_key.trim() === '')
      ) {
        errors.push(`recursive_dimension_breakdown node ${node.id} requires input_key when input_scope is breakdown`);
      }

      if (
        node.input_key !== undefined &&
        (typeof node.input_key !== 'string' || node.input_key.trim() === '')
      ) {
        errors.push(`recursive_dimension_breakdown node ${node.id} has invalid input_key`);
      }

      if (
        typeof node.output_key === 'string' &&
        typeof node.input_key === 'string' &&
        node.output_key.trim() &&
        node.input_key.trim() &&
        node.output_key.trim() === node.input_key.trim()
      ) {
        errors.push(`recursive_dimension_breakdown node ${node.id} cannot use the same input_key and output_key`);
      }
    }

    if (node.type === 'composite') {
      if (!Array.isArray(node.steps) || node.steps.length === 0) {
        errors.push(`composite node ${node.id} must include steps`);
      }
    }

    if (node.type === 'workflow_ref') {
      if (!node.ref || typeof node.ref !== 'object') {
        errors.push(`workflow_ref node ${node.id} must include ref`);
      } else {
        if (!node.ref.workflow_id || typeof node.ref.workflow_id !== 'string') {
          errors.push(`workflow_ref node ${node.id} must include ref.workflow_id`);
        }
        if (!node.ref.version || typeof node.ref.version !== 'string') {
          errors.push(`workflow_ref node ${node.id} must include ref.version`);
        }
        if (
          node.ref.scope !== undefined &&
          !['tenant', 'global'].includes(node.ref.scope)
        ) {
          errors.push(`workflow_ref node ${node.id} has invalid ref.scope`);
        }
      }
    }

    if (node.type === 'insight') {
      if (!node.template || (typeof node.template !== 'object' && typeof node.template !== 'string')) {
        errors.push(`insight node ${node.id} must include template`);
      }
      if (
        node.template
        && typeof node.template === 'object'
        && node.template !== null
        && node.template.details !== undefined
      ) {
        if (!Array.isArray(node.template.details)) {
          errors.push(`insight node ${node.id} template.details must be an array when provided`);
        } else {
          node.template.details.forEach((detail, index) => validateInsightDetailItem(detail, node.id, errors, index));
        }
      }
      if (
        node.output_key !== undefined &&
        (typeof node.output_key !== 'string' || node.output_key.trim() === '')
      ) {
        errors.push(`insight node ${node.id} has invalid output_key`);
      }
      if (node.email !== undefined) {
        if (!node.email || typeof node.email !== 'object' || Array.isArray(node.email)) {
          errors.push(`insight node ${node.id} email must be an object`);
        } else {
          if (
            node.email.enabled !== undefined &&
            typeof node.email.enabled !== 'boolean'
          ) {
            errors.push(`insight node ${node.id} email.enabled must be boolean`);
          }
          if (
            node.email.subject !== undefined &&
            (typeof node.email.subject !== 'string' || node.email.subject.trim() === '')
          ) {
            errors.push(`insight node ${node.id} email.subject must be a non-empty string when provided`);
          }
          if (node.email.to !== undefined && !Array.isArray(node.email.to)) {
            errors.push(`insight node ${node.id} email.to must be an array`);
          }
          if (node.email.enabled) {
            const recipientValidation = validateRecipients(node.email.to);
            if (!recipientValidation.ok) {
              errors.push(`insight node ${node.id} email config invalid: ${recipientValidation.error}`);
            }
          }
        }
      }
    }

    if (node.type === 'email') {
      validateEmailNode(node, errors);
    }
    if (node.type === 'messaging') {
      validateMessagingNode(node, errors);
    }
  }

  errors.push(...getPartialDayProductCompatibilityErrors(definition));
  errors.push(...getPartialDayLandingPagePathCompatibilityErrors(definition));

  return { ok: errors.length === 0, errors };
}

module.exports = { validateWorkflowDefinition };
