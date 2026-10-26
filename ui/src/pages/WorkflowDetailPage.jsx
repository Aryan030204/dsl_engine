import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  GitCommit,
  Clock,
  Edit2,
  Trash2,
  Layout,
  CalendarPlus,
  Pause,
  PlayCircle,
  RefreshCw,
  AlertTriangle,
  Activity
} from 'lucide-react';
import {
  useWorkflow,
  useWorkflowVersions,
  useDeleteWorkflow,
  useTenants,
  useWorkflowSchedules,
  useCreateWorkflowSchedule,
  useCreateWorkflowBulkSchedule,
  usePauseWorkflowSchedule,
  useResumeWorkflowSchedule,
  useDeleteWorkflowSchedule,
  useReplayMissedTriggers,
  useSchedulerQueue,
  useTriggerEvents,
  useUnmatchedAlerts
} from '../api/hooks';
import { useTenant } from '../context/TenantContext';
import { Button, Badge, Card, CardHeader, CardContent, CardTitle, PageSpinner } from '../components/ui';
import { format } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';
import RunWorkflowModal from '../components/RunWorkflowModal';
import EditWorkflowModal from '../components/EditWorkflowModal';
import { getWorkflowKind, getWorkflowKindLabel, getWorkflowKindStatus } from '../utils/workflowKind';
import { getWorkflowPurpose, getWorkflowPurposeLabel, isStateEngineEnabled } from '../utils/stateConfig';
import { WorkflowStateCard } from '../components/StateEngineViews';
import { describeCron } from '../utils/schedule';
import toast from 'react-hot-toast';

const SCHEDULE_WINDOW_MODES = {
  previous_complete_day: {
    label: 'Previous Complete Day',
    description: 'Current window is the previous full day in the schedule timezone; baseline is the day before that.'
  },
  day_to_date_vs_previous_day: {
    label: 'Today Until Scheduled Time vs Yesterday',
    description: 'Current window is 00:00 to the scheduled hour; baseline is yesterday 00:00 to the same hour. Minute offsets are ignored.'
  },
  day_to_date_vs_7day_average: {
    label: 'Today Until Scheduled Time vs 7-Day Average',
    description: 'Current window is 00:00 to the scheduled hour; baseline is the average of the same 00:00 to scheduled-hour range on each of the 7 days before today. Minute offsets are ignored.'
  }
};

// Why a due schedule run was not started (see scheduler/app/runQueueService.js overlap policy).
const SKIP_REASONS = {
  pending_run_exists: 'the previous run was still running and another was already waiting. Check the Runs page for a stuck run',
  active_run_exists: 'the previous run was still running',
  unknown: 'the run could not be queued'
};

const OVERLAP_POLICIES = {
  replace_running: {
    label: 'Cancel the previous run and start the new one',
    description: 'If the previous run is still going, it is cut off and the new run starts straight away. Best for alerts, where the newest data matters most.'
  },
  queue_one_pending: {
    label: 'Wait for it, then run (keep one waiting)',
    description: 'The new run waits until the current one finishes. If one is already waiting, extra runs are skipped.'
  },
  skip_if_running: {
    label: 'Skip this run',
    description: 'If the previous run is still going, this run is skipped.'
  },
  allow_parallel: {
    label: 'Run both at the same time',
    description: 'Runs never wait for each other. Several can be running at once.'
  }
};

const SCHEDULE_PRESETS = {
  weekly: {
    label: 'Weekly',
    cronExpr: '0 9 * * 1',
    description: 'Runs every Monday at 09:00'
  },
  every_5m: {
    label: 'Every 5 minutes',
    cronExpr: '*/5 * * * *',
    description: 'Runs every 5 minutes'
  },
  every_15m: {
    label: 'Every 15 minutes',
    cronExpr: '*/15 * * * *',
    description: 'Runs every 15 minutes'
  },
  hourly: {
    label: 'Hourly',
    cronExpr: '0 * * * *',
    description: 'Runs at minute 0 of every hour'
  }
};

export default function WorkflowDetailPage() {
  const navigate = useNavigate();
  const { workflowId } = useParams();
  const { tenantId } = useTenant();

  const { data, isLoading, error } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const workflowKind = getWorkflowKind(workflow);
  const { data: tenants = [] } = useTenants();
  const { data: versions } = useWorkflowVersions(workflowId);
  const { data: schedules = [], isLoading: schedulesLoading } = useWorkflowSchedules(workflowId);
  const { data: queue } = useSchedulerQueue();
  const { data: triggerEvents = [] } = useTriggerEvents();
  const { data: unmatchedAlerts = [] } = useUnmatchedAlerts();

  const deleteWorkflow = useDeleteWorkflow();
  const createSchedule = useCreateWorkflowSchedule(workflowId);
  const createBulkSchedule = useCreateWorkflowBulkSchedule(workflowId);
  const pauseSchedule = usePauseWorkflowSchedule(workflowId);
  const resumeSchedule = useResumeWorkflowSchedule(workflowId);
  const deleteSchedule = useDeleteWorkflowSchedule(workflowId);
  const replayMissed = useReplayMissedTriggers(workflowId);

  const [runModalOpen, setRunModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [scheduleForm, setScheduleForm] = useState({
    name: '',
    overlapPolicy: 'replace_running',
    windowMode: 'previous_complete_day'
  });
  const [scheduleMode, setScheduleMode] = useState('simple');
  // Nothing is pre-selected: a default here used to read like the workflow's active schedule.
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [customCronExpr, setCustomCronExpr] = useState('');
  const [scheduleTargetTenantIds, setScheduleTargetTenantIds] = useState([]);
  const [scheduleJobProgress, setScheduleJobProgress] = useState(null);
  const editorVersion = selectedVersion || workflow?.latestVersion;

  const targetableTenantIds = useMemo(() => {
    if (workflowKind === 'global') {
      return (Array.isArray(tenants) ? tenants : [])
        .map((item) => item.tenantId)
        .filter(Boolean)
        .sort();
    }

    if (Array.isArray(workflow?.tenantIds) && workflow.tenantIds.length) {
      return [...workflow.tenantIds].sort();
    }

    return [];
  }, [workflowKind, tenants, workflow]);

  useEffect(() => {
    if ((workflowKind === 'multi_tenant' || workflowKind === 'global') && tenantId) {
      setScheduleTargetTenantIds([tenantId]);
    }
  }, [workflowKind, tenantId]);

  useEffect(() => {
    const nodes = data?.version?.definitionJson?.nodes || [];
    if (nodes.some((node) => node?.analysis_mode === 'inventory')) {
      setSelectedPreset('weekly');
      setScheduleForm((current) => ({ ...current, name: current.name || 'Weekly inventory report' }));
    }
  }, [data]);

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500">Error loading workflow: {error.message}</p>
        <Link to="/workflows" className="text-primary-600 hover:underline mt-4 inline-block">
          Back to Workflows
        </Link>
      </div>
    );
  }

  const { version } = data || {};
  const definition = version?.definitionJson;
  const currentTenant = tenants.find((tenant) => tenant.tenantId === tenantId);
  const schedulerTimeZone = currentTenant?.settings?.timezone || 'UTC';

  const formatScheduleDate = (dateValue, timeZone) => {
    if (!dateValue) return '-';
    const date = new Date(dateValue);
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone || 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete workflow "${workflowId}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await deleteWorkflow.mutateAsync(workflowId);
      toast.success(`Workflow "${workflowId}" deleted successfully`);
      navigate('/workflows');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete workflow');
    }
  };

  const pendingCron = scheduleMode === 'simple'
    ? (SCHEDULE_PRESETS[selectedPreset]?.cronExpr || '')
    : customCronExpr.trim();

  const handleCreateSchedule = async (e) => {
    e.preventDefault();
    setScheduleJobProgress(null);

    try {
      const cronExpr = scheduleMode === 'simple'
        ? SCHEDULE_PRESETS[selectedPreset]?.cronExpr
        : customCronExpr.trim();
      if (!cronExpr) {
        toast.error('Choose when the schedule should run');
        return;
      }

      const supportsBulkSchedule = workflowKind === 'multi_tenant' || workflowKind === 'global';
      const selectedTargets = supportsBulkSchedule
        ? scheduleTargetTenantIds.filter((targetTenantId) => targetableTenantIds.includes(targetTenantId))
        : [tenantId].filter(Boolean);

      if (supportsBulkSchedule && !selectedTargets.length) {
        toast.error('Select at least one tenant');
        return;
      }

      const payload = {
        name: scheduleForm.name.trim() || undefined,
        cronExpr,
        overlapPolicy: scheduleForm.overlapPolicy,
        windowMode: scheduleForm.windowMode
      };

      if (
        supportsBulkSchedule
        && !(selectedTargets.length === 1 && selectedTargets[0] === tenantId)
      ) {
        const result = await createBulkSchedule.mutateAsync({
          ...payload,
          tenantIds: selectedTargets,
          onProgress: setScheduleJobProgress
        });
        if (result.failures?.length) {
          const failedTenantList = result.failures.map((entry) => entry.tenantId).join(', ');
          toast.error(`Failed to create schedule for: ${failedTenantList}`);
        }
        toast.success(`Schedule created for ${result.successes?.length || 0} tenant(s)`);
      } else {
        await createSchedule.mutateAsync({
          ...payload,
          timezone: schedulerTimeZone
        });
        toast.success('Schedule created');
      }
      setScheduleForm((prev) => ({ ...prev, name: '' }));
      setShowScheduleForm(false);
      setSelectedPreset('');
      setCustomCronExpr('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create schedule');
    } finally {
      setScheduleJobProgress(null);
    }
  };

  const handlePauseSchedule = async (scheduleId) => {
    try {
      await pauseSchedule.mutateAsync(scheduleId);
      toast.success('Schedule paused');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to pause schedule');
    }
  };

  const handleResumeSchedule = async (scheduleId) => {
    try {
      await resumeSchedule.mutateAsync(scheduleId);
      toast.success('Schedule resumed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to resume schedule');
    }
  };

  const handleReplayMissed = async (scheduleId) => {
    try {
      const result = await replayMissed.mutateAsync(scheduleId);
      toast.success(`Replayed ${result.replayedCount || 0} missed triggers`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to replay missed triggers');
    }
  };

  const handleDeleteSchedule = async (scheduleId, scheduleName) => {
    const label = scheduleName || 'this schedule';
    if (!confirm(`Delete ${label}? This removes the schedule and its missed-trigger records.`)) {
      return;
    }

    try {
      await deleteSchedule.mutateAsync(scheduleId);
      toast.success('Schedule deleted');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete schedule');
    }
  };

  const workflowEvents = triggerEvents.filter((event) => event.matchedWorkflowId === workflowId);
  const workflowUnmatched = unmatchedAlerts.filter((alert) => alert.alertType === definition?.trigger?.alertType);
  const workflowDescription = definition?.description || 'No description';
  const scheduleIsPending = createSchedule.isPending || createBulkSchedule.isPending;

  const toggleScheduleTargetTenant = (targetTenantId) => {
    setScheduleTargetTenantIds((prev) => {
      if (prev.includes(targetTenantId)) {
        return prev.filter((item) => item !== targetTenantId);
      }
      return [...prev, targetTenantId];
    });
  };

  const selectAllScheduleTargets = () => {
    setScheduleTargetTenantIds(targetableTenantIds);
  };

  const selectCurrentScheduleTarget = () => {
    setScheduleTargetTenantIds(tenantId ? [tenantId] : []);
  };

  return (
    <div>
      <Link
        to="/workflows"
        className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back to Workflows
      </Link>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between mb-6">
        <div className="min-w-0 flex-1 max-w-2xl">
          <h1 className="text-2xl font-bold text-gray-900">{workflow?.name || workflowId}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs text-gray-400 font-mono">{workflowId}</p>
            {workflow && (
              <Badge status={getWorkflowKindStatus(workflow)}>
                {getWorkflowKindLabel(workflow)}
              </Badge>
            )}
            {definition && (
              <Badge status={getWorkflowPurpose(definition)}>
                {getWorkflowPurposeLabel(definition)}
              </Badge>
            )}
          </div>
          <p className="mt-3 max-w-xl text-[15px] leading-7 text-gray-500 line-clamp-2">
            {workflowDescription}
          </p>
        </div>
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto xl:flex-shrink-0 xl:justify-end xl:overflow-visible">
          <div className="flex flex-nowrap items-center gap-2">
            <Link to={`/workflows/${workflowId}/runs`}>
              <Button variant="secondary" className="h-10 min-w-[120px] px-4 whitespace-nowrap text-sm">
              <Clock className="w-4 h-4 mr-2" />
              View Runs
              </Button>
            </Link>
            <Link to={`/workflows/${workflowId}/edit/visual${editorVersion ? `?version=${encodeURIComponent(editorVersion)}` : ''}`}>
              <Button variant="secondary" className="h-10 min-w-[128px] px-4 whitespace-nowrap text-sm">
              <Layout className="w-4 h-4 mr-2" />
              Visual Editor
              </Button>
            </Link>
            <Button
              variant="secondary"
              onClick={() => setEditModalOpen(true)}
              className="h-10 min-w-[122px] px-4 whitespace-nowrap text-sm"
            >
              <Edit2 className="w-4 h-4 mr-2" />
              Edit JSON
            </Button>
          </div>
          <Button variant="danger" onClick={handleDelete} className="h-10 min-w-[122px] px-4 whitespace-nowrap text-sm">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
          <Button onClick={() => setRunModalOpen(true)} className="h-10 min-w-[148px] px-4 whitespace-nowrap text-sm">
            <Play className="w-4 h-4 mr-2" />
            Run Workflow
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workflow Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm text-gray-500">Workflow ID</dt>
                  <dd className="font-medium">{workflowId}</dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">Type</dt>
                  <dd className="font-medium">{definition?.workflow_type || '-'}</dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">Workflow Scope</dt>
                  <dd className="font-medium">
                    {workflow ? getWorkflowKindLabel(workflow) : '-'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">Purpose</dt>
                  <dd className="font-medium">
                    {definition ? getWorkflowPurposeLabel(definition) : '-'}
                    {definition && getWorkflowPurpose(definition) === 'rca' && !isStateEngineEnabled(definition) && (
                      <span className="text-xs text-gray-500 font-normal"> (alert state off)</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">Latest Version</dt>
                  <dd className="font-medium">v{workflow?.latestVersion}</dd>
                </div>
                <div>
                  <dt className="text-sm text-gray-500">Status</dt>
                  <dd>
                    <Badge status={workflow?.isActive ? 'active' : 'inactive'}>
                      {workflow?.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {isStateEngineEnabled(definition) && (
            <WorkflowStateCard workflowId={workflowId} definition={definition} />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Schedules</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-500 mb-4">
                A schedule runs this workflow automatically. Schedules and queued runs are carried out by the
                scheduler worker, so it has to be running (<span className="font-mono">npm run start:worker</span>).
              </p>

              {/* 1. What is already scheduled */}
              <div className="space-y-3">
                {schedulesLoading ? (
                  <p className="text-sm text-gray-500">Loading schedules...</p>
                ) : schedules.length === 0 ? (
                  <p className="text-sm text-gray-500">This workflow has no schedule yet, so it only runs when you start it.</p>
                ) : (
                  schedules.map((schedule) => {
                    const timezone = schedule.timezone || 'UTC';
                    const windowMode = SCHEDULE_WINDOW_MODES[schedule.windowMode || 'previous_complete_day'];
                    return (
                      <div
                        key={schedule._id}
                        className="border border-gray-200 rounded-lg p-4 bg-gray-50"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-gray-900">{schedule.name || 'Untitled schedule'}</p>
                            <p className="text-sm text-gray-800 mt-1">
                              {describeCron(schedule.cronExpr) || `Cron ${schedule.cronExpr}`}
                              <span className="text-gray-500"> ({timezone})</span>
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              Analyses: {windowMode?.label || schedule.windowMode}
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              If a run is still going: {OVERLAP_POLICIES[schedule.overlapPolicy]?.label || schedule.overlapPolicy}
                            </p>
                            <p className="text-xs text-gray-400 mt-1 font-mono">cron: {schedule.cronExpr}</p>
                          </div>
                          <Badge status={schedule.isActive ? 'active' : 'inactive'}>
                            {schedule.isActive ? 'Active' : 'Paused'}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-gray-600 mt-3">
                          <p>Next run: <span className="font-medium">{formatScheduleDate(schedule.nextRunAt, timezone)}</span></p>
                          <p>Last run started: <span className="font-medium">{formatScheduleDate(schedule.lastTriggeredAt, timezone)}</span></p>
                        </div>

                        {schedule.metadata?.lastSkipReason && (
                          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mt-3">
                            The run due {formatScheduleDate(schedule.metadata.lastSkippedAt, timezone)} did not start:{' '}
                            {SKIP_REASONS[schedule.metadata.lastSkipReason] || schedule.metadata.lastSkipReason}.
                          </p>
                        )}

                        <div className="flex flex-wrap gap-2 mt-3">
                          {schedule.isActive ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handlePauseSchedule(schedule._id)}
                              loading={pauseSchedule.isPending}
                            >
                              <Pause className="w-3 h-3 mr-1" />
                              Pause
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleResumeSchedule(schedule._id)}
                              loading={resumeSchedule.isPending}
                            >
                              <PlayCircle className="w-3 h-3 mr-1" />
                              Resume
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleReplayMissed(schedule._id)}
                            loading={replayMissed.isPending}
                            title="Run the scheduled times that were missed while the worker was not running"
                          >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            Replay missed runs
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => handleDeleteSchedule(schedule._id, schedule.name)}
                            loading={deleteSchedule.isPending}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 2. Add another one, step by step */}
              <div className="mt-5 pt-4 border-t border-gray-200">
                {!showScheduleForm ? (
                  <Button type="button" size="sm" variant="secondary" onClick={() => setShowScheduleForm(true)}>
                    <CalendarPlus className="w-4 h-4 mr-2" />
                    Add a schedule
                  </Button>
                ) : (
                  <form className="space-y-5" onSubmit={handleCreateSchedule}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-gray-900">New schedule</h3>
                      <button
                        type="button"
                        onClick={() => setShowScheduleForm(false)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Name <span className="text-gray-400 font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={scheduleForm.name}
                        onChange={(e) => setScheduleForm((prev) => ({ ...prev, name: e.target.value }))}
                        className="w-full h-10 border border-gray-300 rounded-lg px-3 text-sm"
                        placeholder="e.g. Morning check"
                      />
                    </div>

                    {/* Step 1: when */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">1. When should it run?</label>
                      <div className="flex gap-2 mb-2">
                        <button
                          type="button"
                          onClick={() => setScheduleMode('simple')}
                          className={`h-9 px-3 rounded-lg border text-sm ${
                            scheduleMode === 'simple'
                              ? 'border-primary-300 bg-primary-50 text-primary-700'
                              : 'border-gray-300 bg-white text-gray-700'
                          }`}
                        >
                          Pick a common schedule
                        </button>
                        <button
                          type="button"
                          onClick={() => setScheduleMode('advanced')}
                          className={`h-9 px-3 rounded-lg border text-sm ${
                            scheduleMode === 'advanced'
                              ? 'border-primary-300 bg-primary-50 text-primary-700'
                              : 'border-gray-300 bg-white text-gray-700'
                          }`}
                        >
                          Custom (cron)
                        </button>
                      </div>
                      {scheduleMode === 'simple' ? (
                        <select
                          value={selectedPreset}
                          onChange={(e) => setSelectedPreset(e.target.value)}
                          className="w-full h-10 border border-gray-300 rounded-lg px-3 text-sm"
                          required
                        >
                          <option value="" disabled>Choose when to run...</option>
                          {Object.entries(SCHEDULE_PRESETS).map(([key, item]) => (
                            <option key={key} value={key}>{item.label}</option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <input
                            type="text"
                            value={customCronExpr}
                            onChange={(e) => setCustomCronExpr(e.target.value)}
                            className="w-full h-10 border border-gray-300 rounded-lg px-3 text-sm font-mono"
                            placeholder="3 11,14,17 * * *"
                            required
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Five fields: minute hour day-of-month month day-of-week. For example
                            <span className="font-mono"> 0 9 * * 1-5</span> is weekdays at 09:00.
                          </p>
                        </>
                      )}
                      <p className={`text-xs mt-2 ${pendingCron ? 'text-gray-700' : 'text-gray-400'}`}>
                        {pendingCron
                          ? `This will run: ${describeCron(pendingCron) || `cron ${pendingCron}`} (${schedulerTimeZone})`
                          : 'Nothing chosen yet.'}
                      </p>
                    </div>

                    {/* Step 2: which period */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">2. Which period should each run analyse?</label>
                      <select
                        value={scheduleForm.windowMode}
                        onChange={(e) => setScheduleForm((prev) => ({ ...prev, windowMode: e.target.value }))}
                        className="w-full h-10 border border-gray-300 rounded-lg px-3 text-sm"
                      >
                        {Object.entries(SCHEDULE_WINDOW_MODES).map(([key, item]) => (
                          <option key={key} value={key}>{item.label}</option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        {SCHEDULE_WINDOW_MODES[scheduleForm.windowMode].description}
                      </p>
                      {(scheduleForm.windowMode === 'day_to_date_vs_previous_day'
                        || scheduleForm.windowMode === 'day_to_date_vs_7day_average'
                        ) && (
                        <p className="text-xs text-amber-700 mt-1">
                          The period ends at the start of the scheduled hour, so a 09:03 run analyses 00:00 to 09:00. The minutes
                          do not change the period.
                        </p>
                      )}
                    </div>

                    {/* Step 3: overlap */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">3. If the previous run is still going when the next one is due</label>
                      <select
                        value={scheduleForm.overlapPolicy}
                        onChange={(e) => setScheduleForm((prev) => ({ ...prev, overlapPolicy: e.target.value }))}
                        className="w-full h-10 border border-gray-300 rounded-lg px-3 text-sm"
                      >
                        {Object.entries(OVERLAP_POLICIES).map(([key, item]) => (
                          <option key={key} value={key}>{item.label}</option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">{OVERLAP_POLICIES[scheduleForm.overlapPolicy].description}</p>
                    </div>

                    {(workflowKind === 'multi_tenant' || workflowKind === 'global') && targetableTenantIds.length > 0 && (
                      <div className="border border-gray-200 rounded-lg p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                          <label className="block text-sm font-medium text-gray-700">Which tenants?</label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={selectCurrentScheduleTarget}
                              className="h-8 px-3 rounded-lg border border-gray-300 bg-white text-xs text-gray-700"
                            >
                              Current
                            </button>
                            <button
                              type="button"
                              onClick={selectAllScheduleTargets}
                              className="h-8 px-3 rounded-lg border border-gray-300 bg-white text-xs text-gray-700"
                            >
                              All
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {targetableTenantIds.map((targetTenantId) => (
                            <label
                              key={targetTenantId}
                              className="flex items-center gap-2 rounded border border-gray-200 bg-white px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={scheduleTargetTenantIds.includes(targetTenantId)}
                                onChange={() => toggleScheduleTargetTenant(targetTenantId)}
                              />
                              <span className="truncate" title={targetTenantId}>{targetTenantId}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {scheduleJobProgress && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="font-medium text-blue-900">
                            Creating schedules: {scheduleJobProgress.status}
                          </span>
                          <span className="text-blue-700">
                            {scheduleJobProgress.processedCount || 0}/{scheduleJobProgress.totalCount || 0}
                            {scheduleJobProgress.failureCount ? `, ${scheduleJobProgress.failureCount} failed` : ''}
                          </span>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-blue-100 overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all"
                            style={{
                              width: `${scheduleJobProgress.totalCount
                                ? Math.min(100, ((scheduleJobProgress.processedCount || 0) / scheduleJobProgress.totalCount) * 100)
                                : 0}%`
                            }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button type="submit" size="sm" className="whitespace-nowrap" loading={scheduleIsPending} disabled={!pendingCron}>
                        <CalendarPlus className="w-4 h-4 mr-2" />
                        Create schedule
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setShowScheduleForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Workflow Nodes ({definition?.nodes?.length || 0})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {definition?.nodes?.map((node, idx) => (
                  <div
                    key={node.id}
                    className="flex items-center p-3 bg-gray-50 rounded-lg border border-gray-200"
                  >
                    <span className="w-6 h-6 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-xs font-medium mr-3">
                      {idx + 1}
                    </span>
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{node.id}</p>
                      <p className="text-sm text-gray-500">Type: {node.type}</p>
                    </div>
                    {node.next && (
                      <span className="text-xs text-gray-400">→ {node.next}</span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Definition JSON</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto max-h-96 text-sm">
                {JSON.stringify(definition, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <GitCommit className="w-4 h-4 mr-2" />
                Versions
              </CardTitle>
            </CardHeader>
            <CardContent className="max-h-64 overflow-y-auto">
              {versions?.length === 0 ? (
                <p className="text-sm text-gray-500">No versions found</p>
              ) : (
                <ul className="space-y-2">
                  {versions?.map((v) => (
                    <li
                      key={v._id}
                      className="list-none"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedVersion(v.version)}
                        aria-pressed={editorVersion === v.version}
                        className={`w-full rounded border p-2 text-left transition-colors ${
                          editorVersion === v.version
                            ? 'border-primary-200 bg-primary-50 ring-1 ring-primary-200'
                            : 'border-gray-200 hover:border-primary-200 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">v{v.version}</span>
                          <div className="flex items-center gap-2">
                            {editorVersion === v.version && v.version !== workflow?.latestVersion && (
                              <Badge status="info">Selected</Badge>
                            )}
                            {v.version === workflow?.latestVersion && (
                              <Badge status="active">Latest</Badge>
                            )}
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          {v.createdAt
                            ? format(new Date(v.createdAt), 'MMM d, yyyy HH:mm')
                            : '-'}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Activity className="w-4 h-4 mr-2" />
                Scheduler Queue
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-gray-500">Queued</dt>
                  <dd className="font-medium">{queue?.queued ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Running</dt>
                  <dd className="font-medium">{queue?.running ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Deferred</dt>
                  <dd className="font-medium">{queue?.deferred ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Retrying</dt>
                  <dd className="font-medium">{queue?.retrying ?? 0}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-gray-500">Dead Letter</dt>
                  <dd className="font-medium">{queue?.deadLetter ?? 0}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {definition?.trigger && (
            <Card>
              <CardHeader>
                <CardTitle>Trigger</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-gray-500">Type</dt>
                    <dd className="font-medium">{definition.trigger.type}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Alert Type</dt>
                    <dd className="font-medium">{definition.trigger.alertType || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Brand Scope</dt>
                    <dd className="font-medium">{definition.trigger.brandScope || '-'}</dd>
                  </div>
                  {Array.isArray(definition.trigger.brandIds) && definition.trigger.brandIds.length > 0 && (
                    <div>
                      <dt className="text-gray-500">Brands</dt>
                      <dd className="font-medium break-all">{definition.trigger.brandIds.join(', ')}</dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <AlertTriangle className="w-4 h-4 mr-2" />
                Trigger Observability
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <p className="text-gray-600">
                  Matched events for this workflow: <span className="font-medium">{workflowEvents.length}</span>
                </p>
                <p className="text-gray-600">
                  Unmatched alerts for this trigger type: <span className="font-medium">{workflowUnmatched.length}</span>
                </p>
                {workflowEvents[0] && (
                  <p className="text-xs text-gray-500">
                    Latest matched event: {format(new Date(workflowEvents[0].createdAt), 'MMM d, yyyy HH:mm:ss')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {runModalOpen && workflow && (
        <RunWorkflowModal
          workflow={workflow}
          onClose={() => setRunModalOpen(false)}
        />
      )}

      {editModalOpen && workflow && (
        <EditWorkflowModal
          workflow={workflow}
          onClose={() => setEditModalOpen(false)}
        />
      )}
    </div>
  );
}
