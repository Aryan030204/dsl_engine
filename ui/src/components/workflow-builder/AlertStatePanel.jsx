import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  WORKFLOW_PURPOSES,
  STATE_METRIC_OPTIONS,
  getWorkflowPurpose,
  withStateConfigDefaults,
  withStormProtectionDefaults,
  getStormProtectionErrors,
  isLowerWorse,
} from '../../utils/stateConfig';

const inputClass = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500';
const numberInputClass = `${inputClass} w-20`;

// Keeps an empty (or a lone "-" while typing a negative) input empty rather than
// coercing it to 0, so validation can flag it.
const toNumberOrEmpty = (value) => (value === '' || value === '-' ? '' : Number(value));

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

// Workflow-level settings for the state engine (docs/workflow-state-engine.md):
// whether this is an RCA alert or a daily insight/report, and for RCA workflows the
// thresholds, cooldowns and quiet hours. Writes straight into the
// builder's metadata, which graphToJson spreads into the saved definition.
export default function AlertStatePanel({ metadata, setMetadata }) {
  const [expanded, setExpanded] = useState(false);
  const purpose = getWorkflowPurpose(metadata);
  const config = withStateConfigDefaults(metadata.state_config);
  const isRca = purpose === WORKFLOW_PURPOSES.RCA;
  const enabled = isRca && config.enabled;

  const setPurpose = (nextPurpose) => {
    setMetadata((m) => ({
      ...m,
      workflow_purpose: nextPurpose,
      // A daily insight must send every run, so it can never keep state enabled.
      ...(nextPurpose === WORKFLOW_PURPOSES.DAILY_INSIGHT && m.state_config
        ? { state_config: { ...m.state_config, enabled: false } }
        : {}),
    }));
  };

  const update = (section, field, value) => {
    setMetadata((m) => {
      const current = withStateConfigDefaults(m.state_config);
      return {
        ...m,
        state_config: section
          ? { ...current, [section]: { ...current[section], [field]: value } }
          : { ...current, [field]: value },
      };
    });
  };

  // Storm protection is policy only; runtime counters/latches live in the backend's
  // WorkflowState and are never touched here.
  const storm = withStormProtectionDefaults(config.storm_protection);
  const updateStorm = (mutate) => {
    setMetadata((m) => {
      const current = withStateConfigDefaults(m.state_config);
      const next = withStormProtectionDefaults(current.storm_protection);
      mutate(next);
      return { ...m, state_config: { ...current, storm_protection: next } };
    });
  };
  const setException = (name, field, value) => updateStorm((s) => { s.exceptional_alerts[name][field] = value; });
  const setLimit = (name, value) => updateStorm((s) => { s.daily_limits[name] = value; });
  const stormErrors = getStormProtectionErrors(storm);
  const exceptionHint = isLowerWorse(config.thresholds)
    ? 'This workflow alerts on drops, so lower is worse.'
    : 'This workflow alerts on rises, so higher is worse.';

  const thresholdsValid =typeof config.thresholds.normal === 'number' && typeof config.thresholds.critical === 'number'
    && config.thresholds.normal !== config.thresholds.critical;
  let thresholdHint = "Use the metric's signed value, e.g. -10 / -20 for a drop";
  if (thresholdsValid) {
    thresholdHint = isLowerWorse(config.thresholds)
      ? `Alerts on drops: ${config.thresholds.normal} or lower, critical at ${config.thresholds.critical} or lower`
      : `Alerts on rises: ${config.thresholds.normal} or higher, critical at ${config.thresholds.critical} or higher`;
  }

  const metricUnit = STATE_METRIC_OPTIONS.find((item) => item.value === config.finding.metric)?.unit || '%';
  let summary = 'Sends on every run';
  if (isRca) {
    summary = enabled
      ? `Alert at ${config.thresholds.normal}, critical at ${config.thresholds.critical} · ${config.finding.metric}`
      : 'Alert state off: sends on every run';
  }

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-2">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3 text-sm text-gray-700">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Workflow type</span>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="workflow-purpose"
              checked={isRca}
              onChange={() => setPurpose(WORKFLOW_PURPOSES.RCA)}
            />
            RCA alert
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="workflow-purpose"
              checked={!isRca}
              onChange={() => setPurpose(WORKFLOW_PURPOSES.DAILY_INSIGHT)}
            />
            Daily insight / report
          </label>
        </div>

        {isRca ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className="font-medium">Alert state</span>
            <span className="text-xs text-gray-500">· {summary}</span>
          </button>
        ) : (
          <span className="text-xs text-gray-500">
            Daily insights ignore alert state, cooldowns and quiet hours and send on every run.
          </span>
        )}
      </div>

      {isRca && expanded && (
        <div className="mt-3 pb-2 space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => update(null, 'enabled', e.target.checked)}
            />
            Use alert state (Normal / Triggered / Critical) to decide when to email
          </label>

          {enabled && (
            <div className="flex flex-wrap gap-x-8 gap-y-4">
              <Field label="Metric">
                <select
                  className={inputClass}
                  value={config.finding.metric}
                  onChange={(e) => {
                    const option = STATE_METRIC_OPTIONS.find((item) => item.value === e.target.value);
                    update('finding', 'metric', e.target.value);
                    // a count metric needs count thresholds (1 / 3), not the percent defaults
                    if (option?.thresholds) update('thresholds', null, { ...option.thresholds });
                  }}
                >
                  {STATE_METRIC_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>

              <div className="flex flex-col gap-1">
                <div className="flex gap-3 items-start">
                  <Field label={`Alert at (${metricUnit})`}>
                    <input
                      type="number" step="any" className={numberInputClass}
                      value={config.thresholds.normal}
                      onChange={(e) => update('thresholds', 'normal', toNumberOrEmpty(e.target.value))}
                    />
                  </Field>
                  <Field label={`Critical at (${metricUnit})`}>
                    <input
                      type="number" step="any" className={numberInputClass}
                      value={config.thresholds.critical}
                      onChange={(e) => update('thresholds', 'critical', toNumberOrEmpty(e.target.value))}
                    />
                  </Field>
                </div>
                <span className="text-[11px] text-gray-400">{thresholdHint}</span>
              </div>

              <div className="flex gap-3 items-start">
                <Field label="Triggered cooldown (min)">
                  <input
                    type="number" min="0" step="1" className={numberInputClass}
                    value={config.cooldown.triggered_minutes}
                    onChange={(e) => update('cooldown', 'triggered_minutes', toNumberOrEmpty(e.target.value))}
                  />
                </Field>
                <Field label="Critical cooldown (min)">
                  <input
                    type="number" min="0" step="1" className={numberInputClass}
                    value={config.cooldown.critical_minutes}
                    onChange={(e) => update('cooldown', 'critical_minutes', toNumberOrEmpty(e.target.value))}
                  />
                </Field>
              </div>

              <div className="flex gap-3 items-start">
                <Field label="Quiet hours" hint="Tenant timezone, both ends inclusive">
                  <label className="flex items-center gap-2 text-sm text-gray-700 h-[30px]">
                    <input
                      type="checkbox"
                      checked={config.quiet_hours.enabled}
                      onChange={(e) => update('quiet_hours', 'enabled', e.target.checked)}
                    />
                    Enabled
                  </label>
                </Field>
                {config.quiet_hours.enabled && (
                  <>
                    <Field label="From">
                      <input
                        type="time" className={inputClass}
                        value={config.quiet_hours.start}
                        onChange={(e) => update('quiet_hours', 'start', e.target.value)}
                      />
                    </Field>
                    <Field label="To">
                      <input
                        type="time" className={inputClass}
                        value={config.quiet_hours.end}
                        onChange={(e) => update('quiet_hours', 'end', e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </div>

              <div className="w-full border-t border-gray-100 pt-3 space-y-3">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={storm.enabled}
                    onChange={(e) => updateStorm((s) => { s.enabled = e.target.checked; })}
                  />
                  <span className="font-medium">Storm protection</span>
                  <span className="text-xs text-gray-500">Cap how many alerts a persistent problem can send per day</span>
                </label>

                {storm.enabled && (
                  <div className="pl-6 space-y-3">
                    <div>
                      <div className="text-xs font-medium text-gray-600 mb-1">Daily alert limits</div>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {[['triggered', 'Triggered'], ['critical', 'Critical'], ['total', 'Total']].map(([name, label]) => {
                          const limited = storm.daily_limits[name] !== null;
                          return (
                            <div key={name} className="flex items-center gap-2 text-sm text-gray-700">
                              <label className="flex items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={limited}
                                  onChange={(e) => setLimit(name, e.target.checked ? 3 : null)}
                                />
                                {label}
                              </label>
                              {limited ? (
                                <input
                                  type="number" min="1" step="1" className={numberInputClass}
                                  value={storm.daily_limits[name]}
                                  onChange={(e) => setLimit(name, toNumberOrEmpty(e.target.value))}
                                />
                              ) : (
                                <span className="text-xs text-gray-400">Unlimited</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <span className="text-[11px] text-gray-400">
                        Per tenant-local calendar day (resets at local midnight). Only delivered alerts count.
                      </span>
                    </div>

                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={storm.exceptional_alerts.enabled}
                          onChange={(e) => updateStorm((s) => { s.exceptional_alerts.enabled = e.target.checked; })}
                        />
                        <span className="font-medium">Exceptional alerts</span>
                        <span className="text-xs text-gray-500">Each kind may bypass an exhausted daily limit once per day. {exceptionHint}</span>
                      </label>

                      {storm.exceptional_alerts.enabled && (
                        <div className="pl-6 flex flex-wrap gap-x-8 gap-y-3">
                          <div className="flex items-start gap-2">
                            <Field label="Absolute value" hint="Metric value at which an alert can bypass an exhausted daily limit">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={storm.exceptional_alerts.absolute.enabled}
                                  onChange={(e) => setException('absolute', 'enabled', e.target.checked)}
                                />
                                <input
                                  type="number" step="any" className={numberInputClass}
                                  disabled={!storm.exceptional_alerts.absolute.enabled}
                                  value={storm.exceptional_alerts.absolute.value ?? ''}
                                  onChange={(e) => setException('absolute', 'value', toNumberOrEmpty(e.target.value))}
                                />
                              </div>
                            </Field>
                          </div>
                          <div className="flex items-start gap-2">
                            <Field label="Deterioration" hint="Minimum worsening from the previous valid finding (positive)">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={storm.exceptional_alerts.difference.enabled}
                                  onChange={(e) => setException('difference', 'enabled', e.target.checked)}
                                />
                                <input
                                  type="number" min="0" step="any" className={numberInputClass}
                                  disabled={!storm.exceptional_alerts.difference.enabled}
                                  value={storm.exceptional_alerts.difference.value ?? ''}
                                  onChange={(e) => setException('difference', 'value', toNumberOrEmpty(e.target.value))}
                                />
                              </div>
                            </Field>
                          </div>
                        </div>
                      )}
                    </div>

                    {stormErrors.length > 0 && (
                      <ul className="text-[11px] text-red-600 list-disc pl-4">
                        {stormErrors.map((error) => <li key={error}>{error}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
