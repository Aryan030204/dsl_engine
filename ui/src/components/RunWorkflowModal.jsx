import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import { useExecuteWorkflow, useTenants, useWorkflow } from '../api/hooks';
import { useTenant } from '../context/TenantContext';
import { Button } from './ui';
import {
  getPartialDayProductCompatibilityErrors,
  getPartialDayLandingPagePathCompatibilityErrors,
  isPartialDayWindow,
  validateRunDateRanges
} from '../utils/workflowValidation';

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function midnightInputForDayOffset(date, timeZone, dayOffset) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}T00:00`;
}

function wallClockTimestamp(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

function formatWallClockTimestamp(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export default function RunWorkflowModal({ workflow, onClose }) {
  const navigate = useNavigate();
  const { tenantId } = useTenant();
  const { data: tenants = [] } = useTenants();
  const currentTenant = tenants.find((tenant) => tenant.tenantId === tenantId);
  const tenantTimezone = currentTenant?.settings?.timezone || 'UTC';
  const executeWorkflow = useExecuteWorkflow(workflow.workflowId);
  const { data: workflowData } = useWorkflow(workflow.workflowId);

  const formatDateForApi = (dateStr) => {
    return dateStr.replace('T', ' ') + ':00';
  };

  const [formData, setFormData] = useState({
    windowStart: midnightInputForDayOffset(new Date(), tenantTimezone, -1),
    windowEnd: midnightInputForDayOffset(new Date(), tenantTimezone, 0),
    baselineStart: midnightInputForDayOffset(new Date(), tenantTimezone, -2),
    baselineEnd: midnightInputForDayOffset(new Date(), tenantTimezone, -1),
  });

  const [usePreviousPeriod, setUsePreviousPeriod] = useState(false);
  const [previousBaselineDates, setPreviousBaselineDates] = useState(null);

  useEffect(() => {
    const now = new Date();
    setFormData({
      windowStart: midnightInputForDayOffset(now, tenantTimezone, -1),
      windowEnd: midnightInputForDayOffset(now, tenantTimezone, 0),
      baselineStart: midnightInputForDayOffset(now, tenantTimezone, -2),
      baselineEnd: midnightInputForDayOffset(now, tenantTimezone, -1),
    });
  }, [tenantTimezone]);

  const handleCheckboxChange = (e) => {
    const checked = e.target.checked;
    if (checked) {
      // Store current dates before they are overwritten by sync
      setPreviousBaselineDates({
        baselineStart: formData.baselineStart,
        baselineEnd: formData.baselineEnd,
      });
    } else if (previousBaselineDates) {
      // Restore previous dates when unchecking
      setFormData((prev) => ({
        ...prev,
        baselineStart: previousBaselineDates.baselineStart,
        baselineEnd: previousBaselineDates.baselineEnd,
      }));
      setPreviousBaselineDates(null);
    }
    setUsePreviousPeriod(checked);
  };

  useEffect(() => {
    if (usePreviousPeriod && formData.windowStart && formData.windowEnd) {
      const start = wallClockTimestamp(formData.windowStart);
      const end = wallClockTimestamp(formData.windowEnd);
      const duration = end - start;

      if (duration > 0) {
        const baselineEnd = start;
        const baselineStart = start - duration;

        setFormData(prev => ({
          ...prev,
          baselineStart: formatWallClockTimestamp(baselineStart),
          baselineEnd: formatWallClockTimestamp(baselineEnd)
        }));
      }
    }
  }, [usePreviousPeriod, formData.windowStart, formData.windowEnd]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const validationErrors = validateRunDateRanges(formData);
    if (validationErrors.length) {
      toast.error(validationErrors[0]);
      return;
    }

    const isPartialDayRun = (
      isPartialDayWindow(formData.windowStart, formData.windowEnd)
      || isPartialDayWindow(formData.baselineStart, formData.baselineEnd)
    );
    if (isPartialDayRun) {
      const compatibilityErrors = [
        ...getPartialDayProductCompatibilityErrors(workflowData?.version?.definitionJson),
        ...getPartialDayLandingPagePathCompatibilityErrors(workflowData?.version?.definitionJson),
      ];
      if (compatibilityErrors.length) {
        toast.error(compatibilityErrors[0]);
        return;
      }
    }

    const context = {
      meta: {
        tenantId,
        metric: 'cvr',
        timezone: tenantTimezone,
        window: {
          start: formatDateForApi(formData.windowStart),
          end: formatDateForApi(formData.windowEnd),
        },
        baselineWindow: {
          start: formatDateForApi(formData.baselineStart),
          end: formatDateForApi(formData.baselineEnd),
        },
      },
      filters: [],
      metrics: {},
      rootCausePath: [],
      scratch: {},
    };

    try {
      const result = await executeWorkflow.mutateAsync({ context, mode: 'async' });
      toast.success(`Workflow run started: ${result.runId}`);
      onClose();
      navigate(`/workflows/${workflow.workflowId}/runs/${result.runId}`);
    } catch (err) {
      const errorMessage = err.response?.data?.errors?.[0]
        || err.response?.data?.error
        || 'Failed to run workflow';
      toast.error(errorMessage);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Run Workflow</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            <div className="text-sm text-gray-500 mb-4">
              Running <span className="font-medium text-gray-900">{workflow.workflowId}</span>
              <span className="block mt-1">Times are interpreted in {tenantTimezone}.</span>
            </div>

            {/* Analysis Window */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Analysis Window
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Start</label>
                  <input
                    type="datetime-local"
                    value={formData.windowStart}
                    onChange={(e) => setFormData({ ...formData, windowStart: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">End</label>
                  <input
                    type="datetime-local"
                    value={formData.windowEnd}
                    onChange={(e) => setFormData({ ...formData, windowEnd: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Previous Period Checkbox */}
            <div className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                id="usePreviousPeriod"
                checked={usePreviousPeriod}
                onChange={handleCheckboxChange}
                className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
              />
              <label htmlFor="usePreviousPeriod" className="text-sm font-medium text-gray-700 cursor-pointer">
                Select Previous Period for Baseline
              </label>
            </div>

            {/* Baseline Window */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Baseline Window
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Start</label>
                  <input
                    type="datetime-local"
                    value={formData.baselineStart}
                    onChange={(e) => {
                      setFormData({ ...formData, baselineStart: e.target.value });
                      setUsePreviousPeriod(false);
                      setPreviousBaselineDates(null);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">End</label>
                  <input
                    type="datetime-local"
                    value={formData.baselineEnd}
                    onChange={(e) => {
                      setFormData({ ...formData, baselineEnd: e.target.value });
                      setUsePreviousPeriod(false);
                      setPreviousBaselineDates(null);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={executeWorkflow.isPending}>
              <Play className="w-4 h-4 mr-2" />
              Run Workflow
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
