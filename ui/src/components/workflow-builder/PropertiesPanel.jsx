import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import SuggestionInput from '../SuggestionInput';
import { INSIGHT_BASE_TOKENS } from '../../constants/insightTokens';
import { getNodePartialDayProductWarnings } from '../../utils/workflowValidation';

// Generate unique ID for rules
const generateRuleId = () => `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;


const METRIC_OPTIONS = [
  'orders',
  'sessions',
  'cvr',
  'atc_rate',
  'atc_sessions',
  'cod_orders',
  'ppcod_orders',
  'prepaid_orders'
];

const RANK_BY_OPTIONS = [
  { value: 'delta', label: 'Delta (default)' },
  { value: 'baseline_cvr', label: 'Baseline CVR' },
  { value: 'baseline_sessions', label: 'Baseline Sessions' },
  { value: 'baseline_orders', label: 'Baseline Orders' }
];

const RANK_ORDER_OPTIONS = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' }
];

const FILTER_MODE_OPTIONS = [
  { value: 'drop', label: 'Drops only' },
  { value: 'increase', label: 'Increases only' },
  { value: 'all', label: 'All' }
];

const MIN_SESSIONS_MODE_OPTIONS = [
  { value: 'both_low', label: 'Skip only if both are low' },
  { value: 'either_low', label: 'Skip if either is low' },
  { value: 'baseline_only', label: 'Require baseline only' }
];

const BREAKDOWN_INPUT_SCOPE_OPTIONS = [
  { value: 'global', label: 'Global' },
  { value: 'breakdown', label: 'From Breakdown' }
];

const EMAIL_VALUE_FORMATS = ['text', 'integer', 'decimal', 'percent_ratio', 'percent', 'delta_percent'];
const EMAIL_TABLE_TONES = ['positive', 'negative', 'neutral'];
const EMAIL_METRIC_ICONS = ['metric', 'sessions', 'orders', 'conversion', 'trend'];

const createDefaultReportTemplate = () => ({
  preset: 'performance_report_v1',
  eyebrow: 'Performance Report',
  title: 'Daily Performance',
  description: 'Performance compared with the previous period.',
  period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
  metrics: [
    { label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' },
    { label: 'Orders', value: 'metrics.current_orders', change: 'metrics.orders_delta_pct', format: 'integer', icon: 'orders' },
    { label: 'Conversion Rate', value: 'metrics.current_cvr', change: 'metrics.cvr_delta_pct', format: 'percent_ratio', icon: 'conversion' }
  ],
  tables: [
    {
      title: 'Top Performers', source: 'breakdowns.top_utm_sources', tone: 'positive', limit: 3,
      columns: [
        { label: 'Source', path: 'display_value', format: 'text' },
        { label: 'Sessions', path: 'current.sessions', format: 'integer' },
        { label: 'Orders', path: 'current.orders', format: 'integer' },
        { label: 'CVR', path: 'current.cvr', format: 'percent_ratio' },
        { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' }
      ]
    },
    {
      title: 'Bottom Performers', source: 'breakdowns.bottom_utm_sources', tone: 'negative', limit: 3,
      columns: [
        { label: 'Source', path: 'display_value', format: 'text' },
        { label: 'Sessions', path: 'current.sessions', format: 'integer' },
        { label: 'Orders', path: 'current.orders', format: 'integer' },
        { label: 'CVR', path: 'current.cvr', format: 'percent_ratio' },
        { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' }
      ]
    }
  ]
});


const DIMENSION_OPTIONS = [
  'product_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'landing_page_path',
  'landing_page_type',
  'referrer_name'
];

const BRANCH_METRIC_OPTIONS = [
  'orders_delta_pct',
  'cod_orders_delta_pct',
  'ppcod_orders_delta_pct',
  'prepaid_orders_delta_pct',
  'sessions_delta_pct',
  'cvr_delta_pct',
  'atc_rate_delta_pct',
  'atc_sessions_delta_pct',
  'current_orders',
  'baseline_orders',
  'current_cod_orders',
  'baseline_cod_orders',
  'current_ppcod_orders',
  'baseline_ppcod_orders',
  'current_prepaid_orders',
  'baseline_prepaid_orders',
  'current_sessions',
  'baseline_sessions',
  'current_atc_sessions',
  'baseline_atc_sessions',
  'current_cvr',
  'baseline_cvr',
  'current_atc_rate',
  'baseline_atc_rate',
  'sessionShare',
  'orderShare',
  'depth'
];

const VALIDATION_FIELDS = [
  'sessions',
  'orders',
  'atc_sessions',
  'cvr',
  'atc_rate'
];

function getTokenContext(text, caret) {
  if (typeof text !== 'string') return null;
  const before = text.slice(0, caret);
  const openIndex = before.lastIndexOf('{{');
  if (openIndex === -1) return null;
  const closeIndex = before.lastIndexOf('}}');
  if (closeIndex > openIndex) return null;
  const query = before.slice(openIndex + 2);
  if (!/^\w*$/.test(query)) return null;
  return { start: openIndex, end: caret, query };
}

function MetricMultiSelect({ value, onChange, placeholder }) {
  const [inputValue, setInputValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const normalizedValue = Array.isArray(value) ? value : [];
  const available = METRIC_OPTIONS.filter((m) => !normalizedValue.includes(m));
  const suggestions = inputValue
    ? available.filter((m) => m.startsWith(inputValue.toLowerCase()))
    : available;

  const addMetric = (metric) => {
    if (!metric || normalizedValue.includes(metric)) return;
    onChange([...normalizedValue, metric]);
    setInputValue('');
  };

  const removeMetric = (metric) => {
    onChange(normalizedValue.filter((m) => m !== metric));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const trimmed = inputValue.trim().toLowerCase();
      if (METRIC_OPTIONS.includes(trimmed)) {
        addMetric(trimmed);
      }
    }
    if (e.key === 'Backspace' && !inputValue && normalizedValue.length) {
      removeMetric(normalizedValue[normalizedValue.length - 1]);
    }
    if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {normalizedValue.map((metric) => (
          <span key={metric} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs">
            {metric}
            <button
              type="button"
              className="text-gray-500 hover:text-gray-700"
              onClick={() => removeMetric(metric)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          type="text"
          className="w-full border text-sm p-1 rounded"
          value={inputValue}
          onChange={(e) => {
            const next = e.target.value;
            setInputValue(next);
            if (isFocused) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setIsFocused(true);
            setIsOpen(true);
          }}
          onBlur={() => {
            setIsFocused(false);
            setTimeout(() => setIsOpen(false), 100);
          }}
          placeholder={placeholder}
        />
        {isOpen && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-h-28 overflow-y-auto rounded border border-gray-200 bg-white shadow-sm text-xs">
            <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 bg-white sticky top-0">
              <span className="text-[10px] text-gray-400">Suggestions</span>
              <button
                type="button"
                className="text-[10px] text-gray-500 hover:text-gray-700"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setIsOpen(false)}
              >
                Close
              </button>
            </div>
            {suggestions.map((metric) => (
              <button
                type="button"
                key={metric}
                className="w-full text-left px-2 py-1 hover:bg-gray-50"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addMetric(metric);
                }}
              >
                {metric}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="text-[10px] text-gray-400">
        Supported: {METRIC_OPTIONS.join(', ')}
      </div>
    </div>
  );
}

function DimensionMultiSelect({ value, onChange, placeholder }) {
  const [inputValue, setInputValue] = useState('');
  const normalizedValue = Array.isArray(value) ? value : [];
  const available = DIMENSION_OPTIONS.filter((d) => !normalizedValue.includes(d));

  const addDimension = (dimension) => {
    if (!dimension || normalizedValue.includes(dimension)) return;
    onChange([...normalizedValue, dimension]);
    setInputValue('');
  };

  const removeDimension = (dimension) => {
    onChange(normalizedValue.filter((d) => d !== dimension));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {normalizedValue.map((dimension) => (
          <span key={dimension} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs">
            {dimension}
            <button
              type="button"
              className="text-gray-500 hover:text-gray-700"
              onClick={() => removeDimension(dimension)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <SuggestionInput
        value={inputValue}
        onChange={(next) => setInputValue(next)}
        onSubmit={(next) => {
          const trimmed = next.trim().toLowerCase();
          if (DIMENSION_OPTIONS.includes(trimmed)) {
            addDimension(trimmed);
          }
        }}
        onPick={(next) => addDimension(next)}
        placeholder={placeholder}
        suggestions={available}
        footerLabel="Supported"
      />
    </div>
  );
}

function OutputKeyInput({ value, onChange, placeholder, suggestions = [] }) {
  return (
    <SuggestionInput
      value={value}
      onChange={onChange}
      onSubmit={(next) => onChange(next.trim())}
      onPick={(next) => onChange(next)}
      placeholder={placeholder}
      suggestions={suggestions}
      footerLabel={suggestions.length ? 'Existing keys' : undefined}
    />
  );
}

function TokenTextarea({ value, onChange, placeholder, className, tokenSuggestions = INSIGHT_BASE_TOKENS }) {
  const textareaRef = useRef(null);
  const [context, setContext] = useState(null);

  const suggestions = useMemo(() => {
    if (!context) return [];
    const q = context.query || '';
    return tokenSuggestions.filter((token) => token.startsWith(q));
  }, [context, tokenSuggestions]);

  const updateContext = (text, caret) => {
    const next = getTokenContext(text, caret);
    setContext(next);
  };

  const handleChange = (e) => {
    const nextValue = e.target.value;
    onChange(nextValue);
    updateContext(nextValue, e.target.selectionStart ?? nextValue.length);
  };

  const handleKeyUp = (e) => {
    updateContext(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handleBlur = () => {
    setTimeout(() => setContext(null), 100);
  };

  const applySuggestion = (token) => {
    if (!context) return;
    const nextValue = `${value.slice(0, context.start)}{{${token}}}${value.slice(context.end)}`;
    onChange(nextValue);
    setContext(null);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      const caret = context.start + token.length + 4;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        onChange={handleChange}
        onKeyUp={handleKeyUp}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {context && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-40 overflow-auto rounded border border-gray-200 bg-white shadow-sm text-xs">
          {suggestions.map((token) => (
            <button
              type="button"
              key={token}
              className="w-full text-left px-2 py-1 hover:bg-gray-50"
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(token);
              }}
            >
              {`{{${token}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function parseValidationCondition(condition) {
  if (!condition || typeof condition !== 'string') {
    return { scope: 'current', op: '>', value: '' };
  }
  const match = condition.trim().match(/^(current|baseline)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
  if (!match) return { scope: 'current', op: '>', value: '' };
  return { scope: match[1], op: match[2], value: match[3] };
}

function buildValidationCondition(scope, op, value) {
  if (value === '' || value === null || value === undefined) return '';
  return `${scope} ${op} ${value}`;
}

function formatEmailRecipients(value) {
  if (!Array.isArray(value) || !value.length) return '';
  return value.join(', ');
}

function parseEmailRecipients(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatTelegramRecipients(value) {
  if (!Array.isArray(value) || !value.length) return '';
  return value.map((user) => user?.telegramChatId || user?.username || '').filter(Boolean).join(', ');
}

function parseTelegramRecipients(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /^-?\d+$/.test(item) ? { telegramChatId: item } : { username: item.replace(/^@/, '') });
}

export default function PropertiesPanel({
  selectedNode,
  onChange,
  onClose,
  onDelete,
  workflowImportOptions = [],
  onAttachWorkflowToRule,
  isAttachingWorkflow = false,
  breakdownOutputKeySuggestions = [],
}) {
  const [data, setData] = useState(selectedNode?.data || {});
  const [ruleWorkflowSelections, setRuleWorkflowSelections] = useState({});
  const [emailRecipientsInput, setEmailRecipientsInput] = useState('');
  const [telegramRecipientsInput, setTelegramRecipientsInput] = useState('');
  const partialDayProductWarnings = useMemo(
    () => getNodePartialDayProductWarnings(data),
    [data]
  );

  useEffect(() => {
    setData(selectedNode?.data || {});
    setRuleWorkflowSelections({});
    setEmailRecipientsInput(formatEmailRecipients(
      selectedNode?.data?.type === 'email' ? selectedNode?.data?.to : selectedNode?.data?.email?.to
    ));
    setTelegramRecipientsInput(formatTelegramRecipients(selectedNode?.data?.telegram?.users));
  }, [selectedNode?.id]);

  const bumpTopTokenVersion = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/\{\{top(\d+)(_[a-zA-Z0-9_]+)\}\}/g, (_, num, suffix) => `{{top${Number(num) + 1}${suffix}}}`);
  };

  const cloneDetailCardWithBumpedTopTokens = (detail) => ({
    ...(detail || {}),
    title: bumpTopTokenVersion(detail?.title || ''),
    items: Array.isArray(detail?.items)
      ? detail.items.map((item) => bumpTopTokenVersion(item))
      : []
  });

  const handleChange = (field, value) => {
    const newData = { ...data, [field]: value };
    setData(newData);
    onChange(selectedNode.id, newData);
  };
  const handleStopConditionChange = (field, value, parseFn) => {
    const current = data.stop_conditions || {};
    const next = { ...current };
    if (value === '' || value === null || value === undefined) {
      delete next[field];
    } else {
      const parsed = parseFn ? parseFn(value) : Number(value);
      next[field] = Number.isNaN(parsed) ? value : parsed;
    }
    handleChange('stop_conditions', next);
  };

  if (!selectedNode) {
    return null;
  }

  // Common Header
  const renderHeader = () => (
    <div className="flex items-center justify-between p-4 border-b">
      <h3 className="font-semibold text-gray-800">Properties</h3>
      <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
        <X className="w-4 h-4" />
      </button>
    </div>
  );

  // Common Fields (ID, Description)
  const renderCommonFields = () => (
    <div className="space-y-3 mb-4">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Node ID</label>
        <input
          type="text"
          value={data.id || ''}
          onChange={(e) => handleChange('id', e.target.value)}
          className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500"
        />
      </div>
    </div>
  );

  const renderContent = () => {
    switch (selectedNode.type) {
      case 'email':
      case 'messaging': {
        const reportTemplate = data.template && typeof data.template === 'object'
          ? data.template
          : createDefaultReportTemplate();
        const updateReportTemplate = (field, value) => handleChange('template', { ...reportTemplate, [field]: value });
        const updateMetric = (index, field, value) => {
          const metrics = [...(reportTemplate.metrics || [])];
          metrics[index] = { ...metrics[index], [field]: value };
          updateReportTemplate('metrics', metrics);
        };
        const updateTable = (index, field, value) => {
          const tables = [...(reportTemplate.tables || [])];
          tables[index] = { ...tables[index], [field]: value };
          updateReportTemplate('tables', tables);
        };
        const updateColumn = (tableIndex, columnIndex, field, value) => {
          const tables = [...(reportTemplate.tables || [])];
          const columns = [...(tables[tableIndex]?.columns || [])];
          columns[columnIndex] = { ...columns[columnIndex], [field]: value };
          tables[tableIndex] = { ...tables[tableIndex], columns };
          updateReportTemplate('tables', tables);
        };
        return (
          <div className="space-y-4">
            {selectedNode.type === 'email' && data.type === 'messaging' && (
              <div className="space-y-2 pb-3 border-b">
                <div className="text-xs font-semibold text-gray-700">Messaging Channels</div>
                {['email', 'telegram'].map((channel) => (
                  <label key={channel} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(data.channels?.[channel])}
                      onChange={(e) => handleChange('channels', { ...(data.channels || {}), [channel]: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <span className="capitalize">{channel}</span>
                  </label>
                ))}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Email Format</label>
              <select
                value={data.format || 'insight'}
                onChange={(e) => {
                  const format = e.target.value;
                  const newData = {
                    ...data,
                    format,
                    template: format === 'report' ? createDefaultReportTemplate() : { insightSource: 'scratch.finalInsight' }
                  };
                  setData(newData);
                  onChange(selectedNode.id, newData);
                }}
                className="w-full border p-2 rounded text-sm bg-white"
              >
                <option value="insight">Insight</option>
                <option value="report">Report</option>
              </select>
            </div>

            {selectedNode.type === 'email' && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Recipients</label>
              <input
                value={emailRecipientsInput}
                onChange={(e) => {
                  setEmailRecipientsInput(e.target.value);
                  if (data.type === 'messaging') {
                    handleChange('email', { ...(data.email || {}), to: parseEmailRecipients(e.target.value) });
                    return;
                  }
                  handleChange('to', parseEmailRecipients(e.target.value));
                }}
                placeholder="ops@example.com, owner@example.com"
                className="w-full border p-2 rounded text-sm"
              />
            </div>
            )}
            {selectedNode.type === 'email' && data.type === 'messaging' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Telegram Users</label>
                <input
                  value={telegramRecipientsInput}
                  onChange={(e) => {
                    setTelegramRecipientsInput(e.target.value);
                    handleChange('telegram', { ...(data.telegram || {}), users: parseTelegramRecipients(e.target.value) });
                  }}
                  placeholder="username or chat ID, comma separated"
                  className="w-full border p-2 rounded text-sm"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const username = parseTelegramRecipients(telegramRecipientsInput)
                      .find((user) => user.username)?.username;
                    if (!username) {
                      window.alert('Enter a Telegram username first.');
                      return;
                    }
                    try {
                      const response = await fetch(`/api/telegram/link?username=${encodeURIComponent(username)}`);
                      const body = await response.json();
                      if (!response.ok) {
                        window.alert(body.error || 'Could not create Telegram link.');
                        return;
                      }
                      await navigator.clipboard.writeText(body.url);
                      window.alert('Telegram link copied. Send it to the recipient.');
                    } catch (error) {
                      window.alert(error.message || 'Could not copy the Telegram link.');
                    }
                  }}
                  className="w-full border border-cyan-200 text-cyan-700 p-2 rounded text-sm hover:bg-cyan-50"
                >
                  Copy Telegram link
                </button>
                <select
                  value={data.telegram?.severity || 'info'}
                  onChange={(e) => handleChange('telegram', { ...(data.telegram || {}), severity: e.target.value })}
                  className="w-full border p-2 rounded text-sm bg-white mt-2"
                >
                  {['info', 'warning', 'critical'].map((severity) => <option key={severity}>{severity}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Subject</label>
              <input
                value={data.subject || ''}
                onChange={(e) => handleChange('subject', e.target.value)}
                placeholder="{{meta.brandName}}: Daily report"
                className="w-full border p-2 rounded text-sm"
              />
              <div className="text-[10px] text-gray-400 mt-1">Supports safe context bindings such as {'{{meta.brandName}}'}.</div>
            </div>

            {data.format === 'report' ? (
              <>
                <div className="space-y-2 pt-3 border-t">
                  <div className="text-xs font-semibold text-gray-700">Report Copy & Period</div>
                  {['eyebrow', 'title', 'description'].map((field) => (
                    <input key={field} value={reportTemplate[field] || ''} onChange={(e) => updateReportTemplate(field, e.target.value)} placeholder={field} className="w-full border p-2 rounded text-sm" />
                  ))}
                  <input value={reportTemplate.period?.current || ''} onChange={(e) => updateReportTemplate('period', { ...(reportTemplate.period || {}), current: e.target.value })} placeholder="Current period path" className="w-full border p-2 rounded text-sm font-mono" />
                  <input value={reportTemplate.period?.comparison || ''} onChange={(e) => updateReportTemplate('period', { ...(reportTemplate.period || {}), comparison: e.target.value })} placeholder="Comparison period path" className="w-full border p-2 rounded text-sm font-mono" />
                </div>

                <div className="space-y-3 pt-3 border-t">
                  <div className="flex justify-between items-center"><span className="text-xs font-semibold text-gray-700">Metric Cards</span><button type="button" disabled={(reportTemplate.metrics || []).length >= 4} onClick={() => updateReportTemplate('metrics', [...(reportTemplate.metrics || []), { label: 'Metric', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'metric' }])} className="text-xs text-blue-600 disabled:text-gray-300"><Plus className="inline w-3 h-3" /> Add</button></div>
                  {(reportTemplate.metrics || []).map((metric, index) => (
                    <div key={index} className="border rounded p-2 space-y-2 bg-gray-50">
                      <div className="flex gap-2"><input value={metric.label || ''} onChange={(e) => updateMetric(index, 'label', e.target.value)} placeholder="Label" className="min-w-0 flex-1 border p-1 rounded text-xs" /><button type="button" disabled={(reportTemplate.metrics || []).length <= 1} onClick={() => updateReportTemplate('metrics', reportTemplate.metrics.filter((_, idx) => idx !== index))} className="text-red-500 disabled:text-gray-300"><Trash2 className="w-4 h-4" /></button></div>
                      <input value={metric.value || ''} onChange={(e) => updateMetric(index, 'value', e.target.value)} placeholder="Value context path" className="w-full border p-1 rounded text-xs font-mono" />
                      <input value={metric.change || ''} onChange={(e) => updateMetric(index, 'change', e.target.value || undefined)} placeholder="Change context path (optional)" className="w-full border p-1 rounded text-xs font-mono" />
                      <div className="flex gap-2"><select value={metric.format || 'text'} onChange={(e) => updateMetric(index, 'format', e.target.value)} className="min-w-0 flex-1 border p-1 rounded text-xs bg-white">{EMAIL_VALUE_FORMATS.map((format) => <option key={format}>{format}</option>)}</select><select value={metric.icon || 'metric'} onChange={(e) => updateMetric(index, 'icon', e.target.value)} className="min-w-0 flex-1 border p-1 rounded text-xs bg-white">{EMAIL_METRIC_ICONS.map((icon) => <option key={icon}>{icon}</option>)}</select></div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3 pt-3 border-t">
                  <div className="flex justify-between items-center"><span className="text-xs font-semibold text-gray-700">Report Tables</span><button type="button" disabled={(reportTemplate.tables || []).length >= 4} onClick={() => updateReportTemplate('tables', [...(reportTemplate.tables || []), { title: 'Table', source: 'breakdowns.output_key', tone: 'neutral', limit: 3, columns: [{ label: 'Name', path: 'display_value', format: 'text' }] }])} className="text-xs text-blue-600 disabled:text-gray-300"><Plus className="inline w-3 h-3" /> Add</button></div>
                  {(reportTemplate.tables || []).map((table, tableIndex) => (
                    <div key={tableIndex} className="border rounded p-2 space-y-2 bg-gray-50">
                      <div className="flex gap-2"><input value={table.title || ''} onChange={(e) => updateTable(tableIndex, 'title', e.target.value)} placeholder="Table title" className="min-w-0 flex-1 border p-1 rounded text-xs" /><button type="button" disabled={(reportTemplate.tables || []).length <= 1} onClick={() => updateReportTemplate('tables', reportTemplate.tables.filter((_, idx) => idx !== tableIndex))} className="text-red-500 disabled:text-gray-300"><Trash2 className="w-4 h-4" /></button></div>
                      <input value={table.source || ''} onChange={(e) => updateTable(tableIndex, 'source', e.target.value)} placeholder="Array context path" className="w-full border p-1 rounded text-xs font-mono" />
                      <div className="flex gap-2"><select value={table.tone || 'neutral'} onChange={(e) => updateTable(tableIndex, 'tone', e.target.value)} className="min-w-0 flex-1 border p-1 rounded text-xs bg-white">{EMAIL_TABLE_TONES.map((tone) => <option key={tone}>{tone}</option>)}</select><input type="number" min="1" max="100" value={table.limit || 1} onChange={(e) => updateTable(tableIndex, 'limit', Number(e.target.value))} className="w-16 border p-1 rounded text-xs" /></div>
                      <div className="text-[10px] font-semibold text-gray-500">Columns</div>
                      {(table.columns || []).map((column, columnIndex) => (
                        <div key={columnIndex} className="grid grid-cols-[1fr_1fr_auto] gap-1">
                          <input value={column.label || ''} onChange={(e) => updateColumn(tableIndex, columnIndex, 'label', e.target.value)} placeholder="Label" className="min-w-0 border p-1 rounded text-[10px]" />
                          <input value={column.path || ''} onChange={(e) => updateColumn(tableIndex, columnIndex, 'path', e.target.value)} placeholder="Row path" className="min-w-0 border p-1 rounded text-[10px] font-mono" />
                          <button type="button" disabled={(table.columns || []).length <= 1} onClick={() => updateTable(tableIndex, 'columns', table.columns.filter((_, idx) => idx !== columnIndex))} className="text-red-500 disabled:text-gray-300"><Trash2 className="w-3 h-3" /></button>
                          <select value={column.format || 'text'} onChange={(e) => updateColumn(tableIndex, columnIndex, 'format', e.target.value)} className="col-span-2 border p-1 rounded text-[10px] bg-white">{EMAIL_VALUE_FORMATS.map((format) => <option key={format}>{format}</option>)}</select>
                        </div>
                      ))}
                      <button type="button" onClick={() => updateTable(tableIndex, 'columns', [...(table.columns || []), { label: 'Value', path: 'value', format: 'text' }])} className="text-[10px] text-blue-600"><Plus className="inline w-3 h-3" /> Add column</button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="pt-3 border-t">
                <label className="block text-xs font-medium text-gray-500 mb-1">Insight Source</label>
                <input value={data.template?.insightSource || 'scratch.finalInsight'} onChange={(e) => handleChange('template', { insightSource: e.target.value })} className="w-full border p-2 rounded text-sm font-mono" />
              </div>
            )}

            <div className="space-y-2 pt-3 border-t">
              <div className="text-xs font-semibold text-gray-700">Branding Overrides</div>
              {['displayName', 'logoUrl', 'tagline', 'primaryColor', 'footerText'].map((field) => (
                <input key={field} value={data.branding?.[field] || ''} onChange={(e) => handleChange('branding', { ...(data.branding || {}), [field]: e.target.value || undefined })} placeholder={field} className="w-full border p-2 rounded text-sm" />
              ))}
            </div>
            <div className="space-y-2 pt-3 border-t">
              <label className="block text-xs font-medium text-gray-500">Failure Policy</label>
              <select value="terminate" disabled className="w-full border p-2 rounded text-sm bg-gray-100"><option value="terminate">Terminate workflow</option></select>
              <input value={data.on_fail?.reason || ''} onChange={(e) => handleChange('on_fail', { action: 'terminate', reason: e.target.value })} placeholder="Email could not be sent" className="w-full border p-2 rounded text-sm" />
            </div>
          </div>
        );
      }
      case 'branch':
        return (
          <div className="space-y-4">
            <datalist id="branch-metric-options">
              {BRANCH_METRIC_OPTIONS.map((metric) => (
                <option key={metric} value={metric} />
              ))}
            </datalist>
            <div className="text-sm font-medium text-gray-700">Rules</div>
            {(data.rules || []).map((rule, ruleIdx) => {
               const breakdownRuleType = rule.filter_in_breakdowns
                 ? 'filter'
                 : rule.all_in_breakdowns
                   ? 'all'
                   : rule.any_in_breakdowns
                     ? 'any'
                     : null;
               const breakdownEntryLogic = breakdownRuleType === 'filter'
                 ? (rule.filter_in_breakdowns?.entry_logic
                   || (rule.filter_in_breakdowns?.mode === 'all' ? 'and' : 'or'))
                 : ((rule.any_in_breakdowns || rule.all_in_breakdowns)?.entry_logic || 'and');
               const filterEntryLogic = rule.filter_in_breakdowns?.entry_logic
                 || (rule.filter_in_breakdowns?.mode === 'all' ? 'and' : 'or');
               const filterMatchScope = rule.filter_in_breakdowns?.match_scope || 'any';
               const isBreakdownsRule = !!breakdownRuleType;
               const isOr = isBreakdownsRule
                 ? breakdownEntryLogic === 'or'
                 : (rule.any && rule.any.length > 0);
               const ruleId = rule._ruleId || `legacy_rule_${ruleIdx}`;
               const activeBreakdownRule = rule.filter_in_breakdowns || rule.any_in_breakdowns || rule.all_in_breakdowns || null;
               const currentList = isBreakdownsRule
                 ? (activeBreakdownRule?.conditions || [])
                 : (isOr ? rule.any : (rule.all || []));
               
               return (
                  <div key={ruleIdx} className="p-3 bg-gray-50 rounded border text-xs relative group">
                    <div className="flex justify-between items-center mb-2">
                       <span className="font-semibold text-gray-700">Rule {ruleIdx + 1}</span>
                       <div className="flex items-center gap-2">
                           <select
                               className="text-[10px] border border-gray-300 rounded px-2 py-0.5 bg-white"
                               value={breakdownRuleType === 'filter' ? 'breakdown_filter' : (isBreakdownsRule ? 'breakdowns' : 'metrics')}
                               onChange={(e) => {
                                  const mode = e.target.value;
                                  const newRules = [...data.rules];
                                  if (mode === 'breakdowns') {
                                    newRules[ruleIdx] = {
                                      ...newRules[ruleIdx],
                                      filter_in_breakdowns: undefined,
                                      any_in_breakdowns: {
                                        dimension: activeBreakdownRule?.dimension || '',
                                        limit: activeBreakdownRule?.limit ?? '',
                                        entry_logic: breakdownEntryLogic,
                                        conditions: activeBreakdownRule?.conditions || [{ metric: '', op: '>', value: '' }]
                                      },
                                      all_in_breakdowns: undefined,
                                      all: [],
                                      any: []
                                    };
                                  } else if (mode === 'breakdown_filter') {
                                    newRules[ruleIdx] = {
                                      ...newRules[ruleIdx],
                                      filter_in_breakdowns: {
                                        dimension: activeBreakdownRule?.dimension || '',
                                       limit: activeBreakdownRule?.limit ?? '',
                                       mode: rule.filter_in_breakdowns?.mode || 'any',
                                        entry_logic: breakdownEntryLogic,
                                        match_scope: rule.filter_in_breakdowns?.match_scope || 'any',
                                        write_matches_to: rule.filter_in_breakdowns?.write_matches_to || '',
                                        conditions: activeBreakdownRule?.conditions || [{ metric: '', op: '>', value: '' }]
                                      },
                                      any_in_breakdowns: undefined,
                                      all_in_breakdowns: undefined,
                                      all: [],
                                      any: []
                                    };
                                  } else {
                                    newRules[ruleIdx] = {
                                      ...newRules[ruleIdx],
                                      filter_in_breakdowns: undefined,
                                      any_in_breakdowns: undefined,
                                      all_in_breakdowns: undefined,
                                      all: (newRules[ruleIdx].all && newRules[ruleIdx].all.length)
                                        ? newRules[ruleIdx].all
                                        : [{ metric: '', op: '>', value: '' }],
                                      any: []
                                    };
                                  }
                                  handleChange('rules', newRules);
                               }}
                           >
                               <option value="metrics">Metrics</option>
                               <option value="breakdowns">Breakdowns</option>
                               <option value="breakdown_filter">Breakdown Filter</option>
                           </select>
                           <div className="flex bg-white rounded border border-gray-300 overflow-hidden">
                               <button 
                                   className={`px-2 py-0.5 text-[10px] ${!isOr ? 'bg-purple-100 text-purple-700 font-bold' : 'text-gray-500 hover:bg-gray-50'}`}
                                   onClick={() => {
                                       const newRules = [...data.rules];
                                       if (isBreakdownsRule) {
                                           const current = activeBreakdownRule || {};
                                           const nextRule = { ...current, entry_logic: 'and' };
                                           if (breakdownRuleType === 'filter') {
                                             newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                           } else if (breakdownRuleType === 'all') {
                                             newRules[ruleIdx].all_in_breakdowns = nextRule;
                                           } else {
                                             newRules[ruleIdx].any_in_breakdowns = nextRule;
                                           }
                                       } else if (isOr) {
                                           newRules[ruleIdx] = { ...newRules[ruleIdx], all: rule.any, any: [] };
                                       }
                                       handleChange('rules', newRules);
                                   }}
                               >AND</button>
                               <div className="w-px bg-gray-300"></div>
                               <button 
                                  className={`px-2 py-0.5 text-[10px] ${isOr ? 'bg-purple-100 text-purple-700 font-bold' : 'text-gray-500 hover:bg-gray-50'}`}
                                  onClick={() => {
                                       const newRules = [...data.rules];
                                       if (isBreakdownsRule) {
                                           const current = activeBreakdownRule || {};
                                           const nextRule = { ...current, entry_logic: 'or' };
                                           if (breakdownRuleType === 'filter') {
                                             newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                           } else if (breakdownRuleType === 'all') {
                                             newRules[ruleIdx].all_in_breakdowns = nextRule;
                                           } else {
                                             newRules[ruleIdx].any_in_breakdowns = nextRule;
                                           }
                                       } else if (!isOr) {
                                           newRules[ruleIdx] = { ...newRules[ruleIdx], any: rule.all || [], all: [] };
                                       }
                                       handleChange('rules', newRules);
                                  }}
                               >OR</button>
                           </div>
                           <button 
                                onClick={() => {
                                    const newRules = [...data.rules];
                                    newRules.splice(ruleIdx, 1);
                                    handleChange('rules', newRules);
                                }}
                                className="p-1 hover:bg-red-100 text-red-500 rounded transition-colors"
                                title="Delete Rule"
                           >
                                <Trash2 className="w-3 h-3" />
                           </button>
                       </div>
                    </div>
                    
                    <div className="space-y-2">
                       {isBreakdownsRule && (
                         <>
                           <div className={`grid gap-2 mb-2 ${breakdownRuleType === 'filter' ? 'grid-cols-3' : 'grid-cols-3'}`}>
                             <div>
                               <label className="block text-[10px] text-gray-500 mb-1">
                                 {breakdownRuleType === 'filter' ? 'Match Scope' : 'Match Mode'}
                               </label>
                               {breakdownRuleType !== 'filter' ? (
                                 <select
                                   className="w-full border p-1 rounded"
                                   value={breakdownRuleType || 'any'}
                                   onChange={(e) => {
                                     const nextMode = e.target.value;
                                     const newRules = [...data.rules];
                                     const current = activeBreakdownRule || {};
                                     const nextBreakdownRule = {
                                       dimension: current.dimension || '',
                                       limit: current.limit ?? '',
                                       entry_logic: breakdownEntryLogic,
                                       conditions: current.conditions || [{ metric: '', op: '>', value: '' }]
                                     };
                                     newRules[ruleIdx] = {
                                       ...newRules[ruleIdx],
                                       any_in_breakdowns: nextMode === 'any' ? nextBreakdownRule : undefined,
                                       all_in_breakdowns: nextMode === 'all' ? nextBreakdownRule : undefined
                                     };
                                     handleChange('rules', newRules);
                                   }}
                                 >
                                   <option value="any">Any entry matches</option>
                                   <option value="all">All entries match</option>
                                 </select>
                               ) : (
                                 <select
                                   className="w-full border p-1 rounded"
                                   value={filterMatchScope}
                                   onChange={(e) => {
                                     const newRules = [...data.rules];
                                     const current = activeBreakdownRule || {};
                                     newRules[ruleIdx].filter_in_breakdowns = {
                                       ...current,
                                       match_scope: e.target.value
                                     };
                                     handleChange('rules', newRules);
                                   }}
                                 >
                                   <option value="any">Any entry matches</option>
                                   <option value="all">All entries match</option>
                                 </select>
                               )}
                             </div>
                             <div>
                               <label className="block text-[10px] text-gray-500 mb-1">Breakdown Key</label>
                               <input
                                 placeholder="sessions_product_drops"
                                 className="w-full border p-1 rounded"
                                 value={activeBreakdownRule?.dimension || ''}
                                 onChange={(e) => {
                                   const newRules = [...data.rules];
                                   const current = activeBreakdownRule || {};
                                   const nextRule = { ...current, dimension: e.target.value };
                                   if (breakdownRuleType === 'filter') {
                                     newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                   } else if (breakdownRuleType === 'all') {
                                     newRules[ruleIdx].all_in_breakdowns = nextRule;
                                   } else {
                                     newRules[ruleIdx].any_in_breakdowns = nextRule;
                                   }
                                   handleChange('rules', newRules);
                                 }}
                               />
                             </div>
                             <div>
                               <label className="block text-[10px] text-gray-500 mb-1">Top K</label>
                               <input
                                 type="number"
                                 min="1"
                                 placeholder="9"
                                 className="w-full border p-1 rounded"
                                 value={activeBreakdownRule?.limit ?? ''}
                                 onChange={(e) => {
                                   const newRules = [...data.rules];
                                   const current = activeBreakdownRule || {};
                                   const nextValue = e.target.value === '' ? '' : Number(e.target.value);
                                   const nextRule = { ...current, limit: nextValue };
                                   if (breakdownRuleType === 'filter') {
                                     newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                   } else if (breakdownRuleType === 'all') {
                                     newRules[ruleIdx].all_in_breakdowns = nextRule;
                                   } else {
                                     newRules[ruleIdx].any_in_breakdowns = nextRule;
                                   }
                                   handleChange('rules', newRules);
                                 }}
                               />
                             </div>
                           </div>
                           {breakdownRuleType === 'filter' && (
                             <div className="mb-2">
                               <label className="block text-[10px] text-gray-500 mb-1">Write Matches To</label>
                               <OutputKeyInput
                                 value={rule.filter_in_breakdowns?.write_matches_to || ''}
                                 onChange={(nextValue) => {
                                   const newRules = [...data.rules];
                                   const current = activeBreakdownRule || {};
                                   newRules[ruleIdx].filter_in_breakdowns = {
                                     ...current,
                                     write_matches_to: nextValue
                                   };
                                   handleChange('rules', newRules);
                                 }}
                                 placeholder="filtered_product_drops"
                                 suggestions={Array.from(new Set(breakdownOutputKeySuggestions))}
                               />
                             </div>
                           )}
                         </>
                       )}
                       {currentList.map((cond, condIdx) => (
                           <div key={condIdx} className="flex gap-1 items-center">
                               <select
                                  className="w-full border p-1 rounded min-w-0 text-xs"
                                  value={cond.metric || ''}
                                  onChange={(e) => {
                                     const newRules = [...data.rules];
                                     if (isBreakdownsRule) {
                                       const current = activeBreakdownRule || {};
                                       const conditions = current.conditions || [];
                                       conditions[condIdx] = { ...conditions[condIdx], metric: e.target.value };
                                       const nextRule = { ...current, conditions };
                                       if (breakdownRuleType === 'filter') {
                                         newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                       } else if (breakdownRuleType === 'all') {
                                         newRules[ruleIdx].all_in_breakdowns = nextRule;
                                       } else {
                                         newRules[ruleIdx].any_in_breakdowns = nextRule;
                                       }
                                     } else {
                                       const listKey = isOr ? 'any' : 'all';
                                       if (!newRules[ruleIdx][listKey]) newRules[ruleIdx][listKey] = [];
                                       newRules[ruleIdx][listKey][condIdx] = { ...newRules[ruleIdx][listKey][condIdx], metric: e.target.value };
                                     }
                                     handleChange('rules', newRules);
                                  }}
                               >
                                  <option value="">Select metric...</option>
                                  {BRANCH_METRIC_OPTIONS.map((metric) => (
                                    <option key={metric} value={metric}>{metric}</option>
                                  ))}
                               </select>
                               <select 
                                   className="border p-1 rounded shrink-0 w-12 text-center"
                                   value={cond.op || '>'}
                                   onChange={(e) => {
                                      const newRules = [...data.rules];
                                      if (isBreakdownsRule) {
                                        const current = activeBreakdownRule || {};
                                        const conditions = current.conditions || [];
                                        conditions[condIdx] = { ...conditions[condIdx], op: e.target.value };
                                        const nextRule = { ...current, conditions };
                                        if (breakdownRuleType === 'filter') {
                                          newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                        } else if (breakdownRuleType === 'all') {
                                          newRules[ruleIdx].all_in_breakdowns = nextRule;
                                        } else {
                                          newRules[ruleIdx].any_in_breakdowns = nextRule;
                                        }
                                      } else {
                                        const listKey = isOr ? 'any' : 'all';
                                        newRules[ruleIdx][listKey][condIdx] = { ...newRules[ruleIdx][listKey][condIdx], op: e.target.value };
                                      }
                                      handleChange('rules', newRules);
                                   }}
                               >
                                   <option value=">">&gt;</option>
                                   <option value=">=">&ge;</option>
                                   <option value="<">&lt;</option>
                                   <option value="<=">&le;</option>
                                   <option value="==">=</option>
                                   <option value="!=">!=</option>
                               </select>
                               <input 
                                  placeholder="Value" 
                                  className="w-full border p-1 rounded min-w-0"
                                  value={cond.value || ''} 
                                  onChange={(e) => {
                                       const newRules = [...data.rules];
                                       if (isBreakdownsRule) {
                                         const current = activeBreakdownRule || {};
                                         const conditions = current.conditions || [];
                                         conditions[condIdx] = { ...conditions[condIdx], value: e.target.value };
                                         const nextRule = { ...current, conditions };
                                         if (breakdownRuleType === 'filter') {
                                           newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                         } else if (breakdownRuleType === 'all') {
                                           newRules[ruleIdx].all_in_breakdowns = nextRule;
                                         } else {
                                           newRules[ruleIdx].any_in_breakdowns = nextRule;
                                         }
                                       } else {
                                         const listKey = isOr ? 'any' : 'all';
                                         newRules[ruleIdx][listKey][condIdx] = { ...newRules[ruleIdx][listKey][condIdx], value: e.target.value };
                                       }
                                       handleChange('rules', newRules);
                                  }}
                                />
                                <button 
                                    onClick={() => {
                                        const newRules = [...data.rules];
                                        if (isBreakdownsRule) {
                                          const current = activeBreakdownRule || {};
                                          const conditions = current.conditions || [];
                                          conditions.splice(condIdx, 1);
                                          const nextRule = { ...current, conditions };
                                          if (breakdownRuleType === 'filter') {
                                            newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                          } else if (breakdownRuleType === 'all') {
                                            newRules[ruleIdx].all_in_breakdowns = nextRule;
                                          } else {
                                            newRules[ruleIdx].any_in_breakdowns = nextRule;
                                          }
                                        } else {
                                          const listKey = isOr ? 'any' : 'all';
                                          newRules[ruleIdx][listKey].splice(condIdx, 1);
                                        }
                                        handleChange('rules', newRules);
                                    }}
                                    className="text-gray-400 hover:text-red-500 p-0.5"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </button>
                           </div>
                       ))}
                       <button 
                            onClick={() => {
                                const newRules = [...data.rules];
                                if (isBreakdownsRule) {
                                  const current = activeBreakdownRule || {};
                                  const conditions = current.conditions || [];
                                  conditions.push({ metric: '', op: '>', value: '' });
                                  const nextRule = { ...current, conditions };
                                  if (breakdownRuleType === 'filter') {
                                    newRules[ruleIdx].filter_in_breakdowns = nextRule;
                                  } else if (breakdownRuleType === 'all') {
                                    newRules[ruleIdx].all_in_breakdowns = nextRule;
                                  } else {
                                    newRules[ruleIdx].any_in_breakdowns = nextRule;
                                  }
                                } else {
                                  const listKey = isOr ? 'any' : 'all';
                                  if (!newRules[ruleIdx][listKey]) newRules[ruleIdx][listKey] = [];
                                  newRules[ruleIdx][listKey].push({ metric: '', op: '>', value: '' });
                                }
                                handleChange('rules', newRules);
                            }}
                            className="text-blue-600 text-[10px] hover:underline flex items-center gap-1 mt-1"
                        >
                            <Plus className="w-3 h-3" /> Add Condition
                        </button>

                       <div className="mt-3 pt-2 border-t border-gray-200">
                         <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                           Attach Existing Workflow
                         </div>
                         <div className="flex gap-2 items-center min-w-0">
                           <select
                             className="flex-1 min-w-0 border p-1 rounded text-[11px] bg-white"
                             value={ruleWorkflowSelections[ruleId] || ''}
                             onChange={(e) => {
                               setRuleWorkflowSelections((prev) => ({
                                 ...prev,
                                 [ruleId]: e.target.value,
                               }));
                             }}
                           >
                             <option value="">Select workflow...</option>
                             {workflowImportOptions.map((workflow) => (
                               <option key={workflow.workflowId} value={workflow.workflowId}>
                                 {workflow.name} ({workflow.scope}{workflow.latestVersion ? ` v${workflow.latestVersion}` : ''})
                               </option>
                             ))}
                           </select>
                           <button
                             type="button"
                             disabled={!ruleWorkflowSelections[ruleId] || isAttachingWorkflow || !onAttachWorkflowToRule}
                             onClick={() =>
                               onAttachWorkflowToRule?.({
                                 branchNodeId: selectedNode.id,
                                 ruleId,
                                 workflowId: ruleWorkflowSelections[ruleId],
                               })
                             }
                             className={`px-2 py-1 rounded text-[11px] border ${
                               !ruleWorkflowSelections[ruleId] || isAttachingWorkflow || !onAttachWorkflowToRule
                                 ? 'border-gray-200 text-gray-400 bg-gray-100 cursor-not-allowed'
                                 : 'border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100'
                             } shrink-0`}
                           >
                             {isAttachingWorkflow ? 'Attaching...' : 'Attach'}
                           </button>
                         </div>
                       </div>
                    </div>
                  </div>
               );
            })}
            <button 
                onClick={() => {
                    const newRules = [...(data.rules || []), { _ruleId: generateRuleId(), all: [{ metric: '', op: '>', value: '' }] }];
                    handleChange('rules', newRules);
                }}
                className="w-full py-2 border-2 border-dashed border-gray-300 rounded text-gray-500 hover:border-blue-500 hover:text-blue-500 text-sm flex items-center justify-center gap-2"
            >
                <Plus className="w-4 h-4" /> Add Rule
            </button>
          </div>
        );
      
      case 'validation':
        return (
            <div className="space-y-2">
                <div className="text-sm font-medium text-gray-700">Checks</div>
                 {(data.checks || []).map((check, idx) => (
                     <div key={idx} className="flex gap-2 text-sm items-center">
                         <select
                            className="border p-1 rounded flex-1 min-w-0 text-xs"
                            value={check.field || ''}
                            onChange={(e) => {
                                const newChecks = [...data.checks];
                                newChecks[idx].field = e.target.value;
                                handleChange('checks', newChecks);
                            }}
                         >
                            <option value="">Select field...</option>
                            {VALIDATION_FIELDS.map((field) => (
                              <option key={field} value={field}>{field}</option>
                            ))}
                         </select>
                         {(() => {
                            const { scope, op, value } = parseValidationCondition(check.condition);
                            return (
                              <>
                                <select
                                  className="border p-1 rounded w-20 text-center text-xs"
                                  value={scope}
                                  onChange={(e) => {
                                      const newChecks = [...data.checks];
                                      const next = buildValidationCondition(e.target.value, op, value);
                                      newChecks[idx].condition = next;
                                      handleChange('checks', newChecks);
                                  }}
                                >
                                  <option value="current">current</option>
                                  <option value="baseline">baseline</option>
                                </select>
                                <select
                                  className="border p-1 rounded w-14 text-center text-xs"
                                  value={op}
                                  onChange={(e) => {
                                      const newChecks = [...data.checks];
                                      const next = buildValidationCondition(scope, e.target.value, value);
                                      newChecks[idx].condition = next;
                                      handleChange('checks', newChecks);
                                  }}
                                >
                                  <option value=">">&gt;</option>
                                  <option value=">=">&ge;</option>
                                  <option value="<">&lt;</option>
                                  <option value="<=">&le;</option>
                                  <option value="==">=</option>
                                  <option value="!=">!=</option>
                                </select>
                                <input
                                  className="border p-1 rounded flex-[2] min-w-0 text-xs"
                                  value={value}
                                  placeholder="Value"
                                  onChange={(e) => {
                                      const newChecks = [...data.checks];
                                      newChecks[idx].condition = buildValidationCondition(scope, op, e.target.value);
                                      handleChange('checks', newChecks);
                                  }}
                                />
                              </>
                            );
                         })()}
                         <button 
                            onClick={() => {
                                const newChecks = [...data.checks];
                                newChecks.splice(idx, 1);
                                handleChange('checks', newChecks);
                            }}
                            className="p-1 hover:bg-red-50 text-red-500 rounded flex-shrink-0"
                            title="Delete Check"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                     </div>
                 ))}
                  <button 
                    onClick={() => {
                        const newChecks = [...(data.checks || []), { field: '', condition: '' }];
                        handleChange('checks', newChecks);
                    }}
                    className="text-blue-600 text-xs hover:underline flex items-center gap-1"
                >
                    <Plus className="w-3 h-3" /> Add Check
                </button>
            </div>
        );
      case 'composite':
        return (
            <div className="space-y-4">
                <div className="text-sm font-medium text-gray-700">Steps (Node IDs)</div>
                <div className="text-xs text-gray-500 mb-2">
                    Enter the IDs of the nodes that should be executed in this composite block.
                </div>
                {(data.steps || []).map((stepId, idx) => (
                    <div key={idx} className="flex gap-2 mb-2">
                        <input
                            className="w-full border p-1 rounded text-sm"
                            value={stepId}
                            onChange={(e) => {
                                const newSteps = [...(data.steps || [])];
                                newSteps[idx] = e.target.value;
                                handleChange('steps', newSteps);
                            }}
                            placeholder="Node ID"
                        />
                         <button 
                            onClick={() => {
                                const newSteps = [...(data.steps || [])];
                                newSteps.splice(idx, 1);
                                handleChange('steps', newSteps);
                            }}
                            className="p-1 hover:bg-red-50 text-red-500 rounded"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                ))}
                 <button 
                    onClick={() => {
                        const newSteps = [...(data.steps || []), ''];
                        handleChange('steps', newSteps);
                    }}
                    className="w-full py-1.5 border border-dashed text-gray-500 rounded text-xs hover:border-gray-400 flex items-center justify-center gap-1"
                >
                    <Plus className="w-3 h-3" /> Add Step
                </button>
            </div>
        );

      case 'workflow_ref':
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Referenced Workflow Name</label>
              <input
                type="text"
                value={data.referencedWorkflowName || ''}
                onChange={(e) => handleChange('referencedWorkflowName', e.target.value)}
                className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500"
                placeholder="Display name"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Workflow ID</label>
              <input
                type="text"
                value={data.ref?.workflow_id || ''}
                onChange={(e) =>
                  handleChange('ref', { ...(data.ref || {}), workflow_id: e.target.value })
                }
                className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 font-mono"
                placeholder="wf_..."
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Version</label>
                <input
                  type="text"
                  value={data.ref?.version || ''}
                  onChange={(e) =>
                    handleChange('ref', { ...(data.ref || {}), version: e.target.value })
                  }
                  className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 font-mono"
                  placeholder="1.0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Scope</label>
                <select
                  value={data.ref?.scope || 'tenant'}
                  onChange={(e) =>
                    handleChange('ref', { ...(data.ref || {}), scope: e.target.value })
                  }
                  className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="tenant">tenant</option>
                  <option value="global">global</option>
                </select>
              </div>
            </div>
            <div className="text-[11px] text-gray-500">
              This node executes the referenced workflow using the current run context (same tenant/date window).
            </div>
          </div>
        );

      case 'analysis':
      case 'metric_compare':
      case 'metric_breakdown':
      case 'recursive_dimension_breakdown': 
          return (
             <div className="space-y-3">
                 <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                    <select 
                        value={data.type === 'metric_compare' ? 'metric_compare' : 'recursive_dimension_breakdown'} 
                        onChange={(e) => handleChange('type', e.target.value)}
                        className="w-full text-sm border-gray-300 rounded"
                    >
                        <option value="metric_compare">Metric Comparison</option>
                        <option value="recursive_dimension_breakdown">Dimension Breakdown</option>
                    </select>
                 </div>
                 
                 {data.type === 'metric_compare' ? (
                     <div>
                         <label className="block text-xs font-medium text-gray-500 mb-1">Metrics</label>
                         <MetricMultiSelect
                            value={data.metrics || []}
                            onChange={(nextValue) => handleChange('metrics', nextValue)}
                            placeholder="Add metric..."
                         />
                     </div>
                 ) : (
                    <>
                     {partialDayProductWarnings.length > 0 && (
                        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          {partialDayProductWarnings[0]}
                        </div>
                     )}
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Base Metrics (analyzed separately)</label>
                            <MetricMultiSelect
                              value={Array.isArray(data.base_metrics) && data.base_metrics.length
                                ? data.base_metrics
                                : (data.base_metric ? [data.base_metric] : [])}
                              onChange={(nextValue) => {
                                const nextData = {
                                  ...data,
                                  base_metrics: nextValue,
                                  base_metric: nextValue[0] || 'cvr'
                                };
                                setData(nextData);
                                onChange(selectedNode.id, nextData);
                              }}
                              placeholder="Add base metric..."
                            />
                            <p className="mt-1 text-[11px] text-gray-400">Each metric gets separate results; delta ranking and filtering run independently per metric.</p>
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Dimensions (comma separated)</label>
                          <DimensionMultiSelect
                             value={data.dimensions || []}
                             onChange={(nextValue) => handleChange('dimensions', nextValue)}
                             placeholder="Add dimension..."
                          />
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Rank By</label>
                          <select
                              className="w-full border text-sm p-1 rounded"
                              value={data.rank_by || 'delta'}
                              onChange={(e) => handleChange('rank_by', e.target.value)}
                          >
                              {RANK_BY_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Rank Order</label>
                          <select
                              className="w-full border text-sm p-1 rounded"
                              value={data.rank_order || 'desc'}
                              onChange={(e) => handleChange('rank_order', e.target.value)}
                          >
                              {RANK_ORDER_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Filter Mode</label>
                          <select
                              className="w-full border text-sm p-1 rounded"
                              value={data.filter_mode || 'drop'}
                              onChange={(e) => handleChange('filter_mode', e.target.value)}
                          >
                              {FILTER_MODE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Min Sessions Mode</label>
                          <select
                              className="w-full border text-sm p-1 rounded"
                              value={data.min_sessions_mode || 'both_low'}
                              onChange={(e) => handleChange('min_sessions_mode', e.target.value)}
                          >
                              {MIN_SESSIONS_MODE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                     </div>
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Input Scope</label>
                          <select
                              className="w-full border text-sm p-1 rounded"
                              value={data.input_scope || 'global'}
                              onChange={(e) => {
                                  const nextScope = e.target.value;
                                  const nextData = {
                                    ...data,
                                    input_scope: nextScope,
                                    ...(nextScope !== 'breakdown' ? { input_key: '' } : {})
                                  };
                                  setData(nextData);
                                  onChange(selectedNode.id, nextData);
                              }}
                          >
                              {BREAKDOWN_INPUT_SCOPE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                     </div>
                     {((data.input_scope || 'global') === 'breakdown') && (
                       <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Input Breakdown Key</label>
                            <OutputKeyInput
                                value={data.input_key || ''}
                                onChange={(nextValue) => handleChange('input_key', nextValue)}
                                placeholder="orders_drop_pages"
                                suggestions={Array.from(new Set(breakdownOutputKeySuggestions))}
                            />
                            <p className="mt-1 text-[11px] text-gray-500">
                              Restrict this breakdown to the full set of values produced by the selected upstream breakdown key.
                            </p>
                       </div>
                     )}
                     <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Output Key (optional)</label>
                      <OutputKeyInput
                              value={data.output_key || ''}
                              onChange={(nextValue) => handleChange('output_key', nextValue)}
                              placeholder="orders_drop_pages"
                              suggestions={Array.from(new Set(breakdownOutputKeySuggestions))}
                          />
                     </div>
                     <div className="pt-2 border-t">
                          <div className="text-xs font-medium text-gray-600 mb-2">Stop Conditions</div>
                          <div className="space-y-2">
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Max Depth</label>
                                  <input
                                      type="number"
                                      min="1"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.max_depth ?? ''}
                                      onChange={(e) => handleStopConditionChange('max_depth', e.target.value, (v) => parseInt(v, 10))}
                                      placeholder="1"
                                  />
                              </div>
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Top K</label>
                                  <input
                                      type="number"
                                      min="1"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.top_k ?? ''}
                                      onChange={(e) => handleStopConditionChange('top_k', e.target.value, (v) => parseInt(v, 10))}
                                      placeholder="5"
                                  />
                              </div>
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Min Sessions (default)</label>
                                  <input
                                      type="number"
                                      min="0"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.min_sessions ?? ''}
                                      onChange={(e) => handleStopConditionChange('min_sessions', e.target.value, (v) => parseFloat(v))}
                                      placeholder="50"
                                  />
                              </div>
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Min Current Sessions</label>
                                  <input
                                      type="number"
                                      min="0"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.min_current_sessions ?? ''}
                                      onChange={(e) => handleStopConditionChange('min_current_sessions', e.target.value, (v) => parseFloat(v))}
                                      placeholder="50"
                                  />
                              </div>
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Min Baseline Sessions</label>
                                  <input
                                      type="number"
                                      min="0"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.min_baseline_sessions ?? ''}
                                      onChange={(e) => handleStopConditionChange('min_baseline_sessions', e.target.value, (v) => parseFloat(v))}
                                      placeholder="50"
                                  />
                              </div>
                              <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Min Impact %</label>
                                  <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      className="w-full border text-sm p-1 rounded"
                                      value={data.stop_conditions?.min_impact_pct ?? ''}
                                      onChange={(e) => handleStopConditionChange('min_impact_pct', e.target.value, (v) => parseFloat(v))}
                                      placeholder="5"
                                  />
                              </div>
                          </div>
                     </div>
                  </>
                 )}
             </div>
          );

      case 'insight':
          const isStructured = typeof data.template === 'object' && data.template !== null;
          const mergedInsightTokens = Array.from(new Set(INSIGHT_BASE_TOKENS));
          const switchInsightTemplate = (targetType) => {
            const drafts = { ...(data._editorTemplateDrafts || {}) };
            if (isStructured) {
              drafts.structured = data.template;
            } else {
              drafts.simple = data.template;
            }

            const nextTemplate = targetType === 'structured'
              ? (drafts.structured ?? { summary: '', details: [], confidence: '' })
              : (drafts.simple ?? '');
            const newData = {
              ...data,
              _editorTemplateDrafts: drafts,
              template: nextTemplate,
            };
            setData(newData);
            onChange(selectedNode.id, newData);
          };
          
          return (
             <div className="space-y-4">
                 <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Output Key (optional)</label>
                    <OutputKeyInput
                      value={data.output_key || ''}
                      onChange={(nextValue) => handleChange('output_key', nextValue)}
                      placeholder="sessions_product_drops"
                      suggestions={Array.from(new Set(breakdownOutputKeySuggestions))}
                    />
                    <div className="text-[10px] text-gray-400 mt-1">
                      If set, this insight reads evidence from the matching breakdown output key.
                    </div>
                 </div>

                 <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Template Type</label>
                    <div className="flex gap-2">
                         <button
                            className={`px-3 py-1 text-xs rounded border ${!isStructured ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-gray-200 text-gray-600'}`}
                            onClick={() => switchInsightTemplate('simple')}
                         >
                            Simple Text
                         </button>
                         <button
                            className={`px-3 py-1 text-xs rounded border ${isStructured ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-gray-200 text-gray-600'}`}
                            onClick={() => switchInsightTemplate('structured')}
                         >
                            Structured
                         </button>
                    </div>
                 </div>

                 {!isStructured ? (
                     <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Message Template</label>
                        <TokenTextarea
                            className="w-full border p-2 rounded text-sm min-h-[100px]"
                            value={typeof data.template === 'string' ? data.template : ''}
                            onChange={(nextValue) => handleChange('template', nextValue)}
                            placeholder="Analysis complete for {{cvr_delta_pct_fmt}}..."
                            tokenSuggestions={mergedInsightTokens}
                        />
                         <div className="text-[10px] text-gray-400 mt-1">
                             Use {'{{variable}}'} for dynamic values.
                         </div>
                     </div>
                 ) : (
                     <div className="space-y-3">
                         <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Summary Template</label>
                            <TokenTextarea
                                className="w-full border p-2 rounded text-sm min-h-[60px]"
                                value={data.template.summary || ''}
                                onChange={(nextValue) => handleChange('template', { ...data.template, summary: nextValue })}
                                placeholder="Summary text..."
                                tokenSuggestions={mergedInsightTokens}
                            />
                         </div>
                         
                         <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Details (List)</label>
                            {(data.template.details || []).map((detail, idx) => (
                                typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? (
                                  <div key={idx} className="border rounded-md p-3 mb-3 bg-gray-50 space-y-3">
                                    <div className="flex items-start gap-2">
                                      <div className="flex-1">
                                        <label className="block text-[11px] font-medium text-gray-500 mb-1">Detail Title</label>
                                        <TokenTextarea
                                          className="w-full border p-1 rounded text-xs min-h-[40px] bg-white"
                                          value={detail.title || ''}
                                          onChange={(nextValue) => {
                                            const newDetails = [...(data.template.details || [])];
                                            newDetails[idx] = { ...(detail || {}), title: nextValue };
                                            handleChange('template', { ...data.template, details: newDetails });
                                          }}
                                          placeholder="{{top1_value}}"
                                          tokenSuggestions={mergedInsightTokens}
                                        />
                                      </div>
                                      <button
                                        onClick={() => {
                                          const newDetails = [...(data.template.details || [])];
                                          const clonedDetail = cloneDetailCardWithBumpedTopTokens(detail);
                                          newDetails.splice(idx + 1, 0, clonedDetail);
                                          handleChange('template', { ...data.template, details: newDetails });
                                        }}
                                        className="p-1 h-fit hover:bg-blue-50 text-blue-600 rounded"
                                        title="Duplicate detail card"
                                      >
                                        <Plus className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => {
                                          const newDetails = [...(data.template.details || [])];
                                          newDetails.splice(idx, 1);
                                          handleChange('template', { ...data.template, details: newDetails });
                                        }}
                                        className="p-1 h-fit hover:bg-red-50 text-red-500 rounded"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>

                                    <div>
                                      <label className="block text-[11px] font-medium text-gray-500 mb-1">Detail Items</label>
                                      {(detail.items || []).map((item, itemIdx) => (
                                        <div key={itemIdx} className="flex gap-2 mb-2">
                                          <TokenTextarea
                                            className="w-full border p-2 rounded text-xs min-h-[72px] bg-white"
                                            value={item}
                                            onChange={(nextValue) => {
                                              const newDetails = [...(data.template.details || [])];
                                              const nextItems = [...(detail.items || [])];
                                              nextItems[itemIdx] = nextValue;
                                              newDetails[idx] = { ...(detail || {}), items: nextItems };
                                              handleChange('template', { ...data.template, details: newDetails });
                                            }}
                                            placeholder="Sessions Delta: {{top1_sessions_delta_pct_fmt}}"
                                            tokenSuggestions={mergedInsightTokens}
                                          />
                                          <button
                                            onClick={() => {
                                              const newDetails = [...(data.template.details || [])];
                                              const nextItems = [...(detail.items || [])];
                                              nextItems.splice(itemIdx, 1);
                                              newDetails[idx] = { ...(detail || {}), items: nextItems };
                                              handleChange('template', { ...data.template, details: newDetails });
                                            }}
                                            className="p-1 h-fit hover:bg-red-50 text-red-500 rounded"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </div>
                                      ))}
                                      <button
                                        onClick={() => {
                                          const newDetails = [...(data.template.details || [])];
                                          const nextItems = [...(detail.items || []), ''];
                                          newDetails[idx] = { ...(detail || {}), items: nextItems };
                                          handleChange('template', { ...data.template, details: newDetails });
                                        }}
                                        className="text-blue-600 text-xs hover:underline flex items-center gap-1"
                                      >
                                        <Plus className="w-3 h-3" /> Add Detail Item
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div key={idx} className="flex gap-2 mb-2">
                                      <TokenTextarea
                                          className="w-full border p-1 rounded text-xs min-h-[40px]"
                                          value={detail}
                                          onChange={(nextValue) => {
                                              const newDetails = [...(data.template.details || [])];
                                              newDetails[idx] = nextValue;
                                              handleChange('template', { ...data.template, details: newDetails });
                                          }}
                                          tokenSuggestions={mergedInsightTokens}
                                      />
                                      <button 
                                          onClick={() => {
                                              const newDetails = [...(data.template.details || [])];
                                              newDetails.splice(idx, 1);
                                              handleChange('template', { ...data.template, details: newDetails });
                                          }}
                                          className="p-1 h-fit hover:bg-red-50 text-red-500 rounded"
                                      >
                                          <Trash2 className="w-4 h-4" />
                                      </button>
                                  </div>
                                )
                            ))}
                            <div className="flex gap-4">
                              <button 
                                  onClick={() => {
                                      const newDetails = [...(data.template.details || []), ''];
                                      handleChange('template', { ...data.template, details: newDetails });
                                  }}
                                  className="text-blue-600 text-xs hover:underline flex items-center gap-1"
                              >
                                  <Plus className="w-3 h-3" /> Add Legacy Detail
                              </button>
                              <button 
                                  onClick={() => {
                                      const newDetails = [...(data.template.details || []), { title: '', items: [''] }];
                                      handleChange('template', { ...data.template, details: newDetails });
                                  }}
                                  className="text-blue-600 text-xs hover:underline flex items-center gap-1"
                              >
                                  <Plus className="w-3 h-3" /> Add Detail Card
                              </button>
                            </div>
                         </div>

                         <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Confidence Score (Optional)</label>
                             <input 
                                className="w-full border p-1 rounded text-sm" 
                                value={data.template.confidence || ''}
                                onChange={(e) => handleChange('template', { ...data.template, confidence: e.target.value })}
                                placeholder="{{confidence_score}}"
                            />
                         </div>
                     </div>
                 )}

                 <div className="pt-3 border-t border-gray-100 space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-medium text-gray-500">Email Insight</label>
                      <input
                        type="checkbox"
                        checked={Boolean(data.email?.enabled)}
                        onChange={(e) =>
                          handleChange('email', {
                            ...(data.email || {}),
                            enabled: e.target.checked,
                            to: Array.isArray(data.email?.to) ? data.email.to : []
                          })
                        }
                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Recipients</label>
                      <input
                        type="text"
                        value={emailRecipientsInput}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          setEmailRecipientsInput(nextValue);
                          handleChange('email', {
                            ...(data.email || {}),
                            enabled: Boolean(data.email?.enabled),
                            to: parseEmailRecipients(nextValue)
                          });
                        }}
                        placeholder="ops@example.com, owner@example.com"
                        className="w-full border p-2 rounded text-sm"
                      />
                      <div className="text-[10px] text-gray-400 mt-1">
                        The HTML email layout is fixed. Subject and recipients are configurable here.
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Subject</label>
                      <input
                        type="text"
                        value={data.email?.subject || ''}
                        onChange={(e) =>
                          handleChange('email', {
                            ...(data.email || {}),
                            enabled: Boolean(data.email?.enabled),
                            to: Array.isArray(data.email?.to) ? data.email.to : [],
                            subject: e.target.value
                          })
                        }
                        placeholder="CVR drop alert"
                        className="w-full border p-2 rounded text-sm"
                      />
                      <div className="text-[10px] text-gray-400 mt-1">
                        Email subject will be sent as: <span className="font-mono">TENANT_ID: your subject</span>
                      </div>
                    </div>
                 </div>
             </div>
          );

      default:
        return <div className="text-sm text-gray-500 italic">No specific properties for this node type.</div>;
    }
  };

  return (
    <div className="w-80 border-l border-gray-200 bg-white h-full overflow-y-auto">
      {renderHeader()}
      <div className="p-4 overflow-y-auto max-h-[calc(100vh-120px)]">
        {renderCommonFields()}
        <hr className="my-4 border-gray-100" />
        {renderContent()}
        
        <div className="mt-8 pt-4 border-t border-gray-100">
           <button 
            onClick={() => onDelete(selectedNode.id)}
            className="w-full py-2 bg-red-50 text-red-600 rounded-md text-sm hover:bg-red-100 flex items-center justify-center gap-2"
           >
               <Trash2 className="w-4 h-4" /> Delete Node
           </button>
        </div>
      </div>
    </div>
  );
}
