const Workflow = require('../../server/models/Workflow');
const WorkflowVersion = require('../../server/models/WorkflowVersion');
const WorkflowSchedule = require('../../server/models/WorkflowSchedule');
const TriggerEvent = require('../../server/models/TriggerEvent');
const UnmatchedAlert = require('../../server/models/UnmatchedAlert');
const MissedTrigger = require('../../server/models/MissedTrigger');
const Tenant = require('../../server/models/Tenant');
const { selectWorkflowMatches } = require('../domain/triggerMatcher');
const {
  getNextRunAt,
  listMissedRuns,
  getTimeZoneParts,
  localDateTimeToUtc
} = require('./cronUtils');
const { enqueueRun } = require('./runQueueService');
const { resolveWorkflowVersion } = require('../../server/services/workflowExecutionService');
const { buildWorkflowVersionQuery } = require('../../server/services/workflowResolverService');
const { SCHEDULE_WINDOW_MODES } = require('./scheduleWindowModes');

async function getWorkflowCandidates(tenantId, includeGlobal = true) {
  const clauses = [
    { tenantIds: tenantId, isActive: true },
    { tenantId, isActive: true }
  ];
  if (includeGlobal) {
    clauses.push({ scope: 'global', tenantId: null, isActive: true });
  }

  const workflows = await Workflow.find({ $or: clauses }).lean();
  const candidates = await Promise.all(workflows.map(async (workflow) => {
    const version = await WorkflowVersion.findOne(
      buildWorkflowVersionQuery(workflow, workflow.workflowId, workflow.latestVersion)
    ).lean();

    return {
      workflow,
      definition: version?.definitionJson || null
    };
  }));

  return candidates.filter(item => item.definition);
}

function buildDefaultContext(tenantId, payload, timezone = 'UTC') {
  const now = new Date().toISOString();
  const bodyContext = payload?.context;
  if (bodyContext && typeof bodyContext === 'object') {
    return {
      ...bodyContext,
      meta: {
        ...bodyContext.meta,
        tenantId,
        timezone
      }
    };
  }

  return {
    meta: {
      tenantId,
      metric: payload?.metric || 'cvr',
      timezone,
      triggeredAt: payload?.occurredAt || now,
      window: payload?.window || { start: now, end: now },
      baselineWindow: payload?.baselineWindow || { start: now, end: now }
    },
    filters: payload?.filters || [],
    metrics: payload?.metrics || {},
    rootCausePath: [],
    scratch: {}
  };
}

function toIsoUtc(date) {
  return new Date(date).toISOString();
}

function startOfDay(dateInput, timeZone = 'UTC') {
  const parts = getTimeZoneParts(new Date(dateInput), timeZone);
  return localDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);
}

function buildPreviousCompleteDayContext(tenantId, triggerTime, payload = {}, timeZone = 'UTC') {
  const triggerDate = new Date(triggerTime);
  const triggerParts = getTimeZoneParts(triggerDate, timeZone);
  const currentDayStart = startOfDay(triggerDate, timeZone);
  const previousDayStart = localDateTimeToUtc({
    year: triggerParts.year,
    month: triggerParts.month,
    day: triggerParts.day - 1,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);
  const baselineDayStart = localDateTimeToUtc({
    year: triggerParts.year,
    month: triggerParts.month,
    day: triggerParts.day - 2,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);

  return {
    meta: {
      tenantId,
      metric: payload?.metric || 'cvr',
      timezone: timeZone,
      triggeredAt: toIsoUtc(triggerDate),
      window: {
        start: toIsoUtc(previousDayStart),
        end: toIsoUtc(currentDayStart)
      },
      baselineWindow: {
        start: toIsoUtc(baselineDayStart),
        end: toIsoUtc(previousDayStart)
      }
    },
    filters: payload?.filters || [],
    metrics: payload?.metrics || {},
    rootCausePath: [],
    scratch: {}
  };
}

// `baselineDays` > 1 marks the baseline as "this same time-of-day range on each of the N days before today,
// averaged" (baselineWindow is the first of those days: yesterday's range). Queries expand it with
// lib/timeWindowUtils.expandBaselineWindows.
function buildDayToDateVsPreviousDayContext(tenantId, triggerTime, payload = {}, timeZone = 'UTC', baselineDays = null) {
  const triggerDate = new Date(triggerTime);
  const triggerParts = getTimeZoneParts(triggerDate, timeZone);
  const currentDayStart = startOfDay(triggerDate, timeZone);
  const currentDayCutoff = localDateTimeToUtc({
    year: triggerParts.year,
    month: triggerParts.month,
    day: triggerParts.day,
    hour: triggerParts.hour,
    minute: 0,
    second: 0
  }, timeZone);
  const previousDayStart = localDateTimeToUtc({
    year: triggerParts.year,
    month: triggerParts.month,
    day: triggerParts.day - 1,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);
  const previousDayCutoff = localDateTimeToUtc({
    year: triggerParts.year,
    month: triggerParts.month,
    day: triggerParts.day - 1,
    hour: triggerParts.hour,
    minute: 0,
    second: 0
  }, timeZone);

  return {
    meta: {
      tenantId,
      metric: payload?.metric || 'cvr',
      timezone: timeZone,
      triggeredAt: toIsoUtc(triggerDate),
      window: {
        start: toIsoUtc(currentDayStart),
        end: toIsoUtc(currentDayCutoff)
      },
      baselineWindow: {
        start: toIsoUtc(previousDayStart),
        end: toIsoUtc(previousDayCutoff)
      },
      ...(baselineDays > 1 ? { baselineDays } : {})
    },
    filters: payload?.filters || [],
    metrics: payload?.metrics || {},
    rootCausePath: [],
    scratch: {}
  };
}

const SEVEN_DAY_BASELINE = 7;

function buildCronContext(schedule, triggerTime, payload = {}) {
  const mode = schedule?.windowMode || SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY;
  const timeZone = schedule?.timezone || 'UTC';

  if (mode === SCHEDULE_WINDOW_MODES.DAY_TO_DATE_VS_PREVIOUS_DAY) {
    return buildDayToDateVsPreviousDayContext(schedule.tenantId, triggerTime, payload, timeZone);
  }

  if (mode === SCHEDULE_WINDOW_MODES.DAY_TO_DATE_VS_7DAY_AVERAGE) {
    return buildDayToDateVsPreviousDayContext(schedule.tenantId, triggerTime, payload, timeZone, SEVEN_DAY_BASELINE);
  }

  return buildPreviousCompleteDayContext(schedule.tenantId, triggerTime, payload, timeZone);
}

async function ingestEventTrigger({ tenantId, body }) {
  const brand = body.brand || tenantId;
  const alertType = body.alertType;
  const idempotencyKey = body.idempotencyKey;

  const existing = await TriggerEvent.findOne({ tenantId, idempotencyKey }).lean();
  if (existing) {
    return {
      duplicate: true,
      triggerEvent: existing,
      run: existing.runId ? { _id: existing.runId } : null
    };
  }

  let triggerEvent;
  try {
    triggerEvent = await TriggerEvent.create({
      tenantId,
      brand,
      alertType,
      idempotencyKey,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
      payload: body.payload || {},
      status: 'accepted'
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const duplicate = await TriggerEvent.findOne({ tenantId, idempotencyKey }).lean();
      return {
        duplicate: true,
        triggerEvent: duplicate,
        run: duplicate?.runId ? { _id: duplicate.runId } : null
      };
    }
    throw error;
  }

  const candidates = await getWorkflowCandidates(tenantId, true);
  const matches = selectWorkflowMatches(candidates, brand, alertType);

  if (!matches.length) {
    await UnmatchedAlert.create({
      tenantId,
      brand,
      alertType,
      idempotencyKey,
      occurredAt: triggerEvent.occurredAt,
      payload: body.payload || {},
      reason: 'no_matching_workflow'
    });

    triggerEvent.status = 'unmatched';
    triggerEvent.reason = 'no_matching_workflow';
    await triggerEvent.save();

    return { duplicate: false, triggerEvent, run: null, unmatched: true };
  }

  const tenant = await Tenant.findOne({ tenantId }).lean();
  const timezone = tenant?.settings?.timezone || 'UTC';
  const context = buildDefaultContext(tenantId, {
    ...body.payload,
    occurredAt: triggerEvent.occurredAt
  }, timezone);

  const enqueued = [];
  const skipped = [];

  for (const match of matches) {
    const workflowId = match.workflow.workflowId;
    const { workflowVersion, versionId } = await resolveWorkflowVersion({
      tenantId,
      workflowId,
      version: match.workflow.latestVersion
    });

    const queued = await enqueueRun({
      tenantId,
      workflowId,
      version: versionId,
      context,
      definitionJson: workflowVersion.definitionJson,
      triggerType: 'event',
      triggerRef: triggerEvent._id,
      overlapPolicy: 'queue_one_pending',
      maxAttempts: 3
    });

    if (!queued.enqueued) {
      skipped.push({ workflowId, reason: queued.reason || 'not_enqueued' });
      continue;
    }

    enqueued.push({
      workflowId,
      versionId,
      runId: queued.run._id
    });
  }

  if (!enqueued.length) {
    triggerEvent.status = 'failed';
    triggerEvent.reason = skipped[0]?.reason || 'no_runs_enqueued';
    await triggerEvent.save();

    return {
      duplicate: false,
      triggerEvent,
      run: null,
      runs: [],
      unmatched: false,
      skipped: true
    };
  }

  triggerEvent.status = 'enqueued';
  triggerEvent.matchedWorkflowId = enqueued[0].workflowId;
  triggerEvent.matchedVersion = enqueued[0].versionId;
  triggerEvent.runId = enqueued[0].runId;
  triggerEvent.matchedWorkflowIds = enqueued.map(item => item.workflowId);
  triggerEvent.matchedVersions = enqueued.map(item => item.versionId);
  triggerEvent.runIds = enqueued.map(item => item.runId);
  if (skipped.length) {
    triggerEvent.reason = `partially_enqueued:${skipped.length}`;
  }
  await triggerEvent.save();

  return {
    duplicate: false,
    triggerEvent,
    run: { _id: enqueued[0].runId },
    runs: enqueued.map(item => ({ _id: item.runId, workflowId: item.workflowId, version: item.versionId })),
    unmatched: false,
    enqueuedCount: enqueued.length,
    skippedCount: skipped.length
  };
}

async function createSchedule({ tenantId, workflowId, payload }) {
  const now = new Date();
  const nextRunAt = getNextRunAt(payload.cronExpr, now, payload.timezone || 'UTC');

  return WorkflowSchedule.create({
    tenantId,
    workflowId,
    scheduleGroupId: payload.scheduleGroupId || null,
    name: payload.name || `${workflowId}-schedule`,
    cronExpr: payload.cronExpr,
    timezone: payload.timezone || 'UTC',
    windowMode: payload.windowMode || SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY,
    isActive: payload.isActive !== false,
    overlapPolicy: payload.overlapPolicy || 'replace_running',
    retryPolicy: payload.retryPolicy || { maxAttempts: 3, backoffSeconds: [30, 120, 600] },
    nextRunAt,
    lastEvaluatedAt: now
  });
}

// A schedule whose due time is older than this when it is finally evaluated (the worker was down) is
// NOT run: it would analyse a window from the past and could send hours- or days-old alerts. The
// skipped slots are recorded as missed triggers instead, ready for "Replay missed runs".
const DEFAULT_STALE_GRACE_MS = 5 * 60 * 1000;

function getStaleGraceMs(env = process.env) {
  const value = Number(env.SCHEDULER_STALE_GRACE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STALE_GRACE_MS;
}

// `deps` lets tests replace the database and queue; production always uses the defaults.
async function evaluateDueSchedules(now = new Date(), { staleGraceMs = getStaleGraceMs(), deps = {} } = {}) {
  const scheduleModel = deps.scheduleModel || WorkflowSchedule;
  const resolveVersion = deps.resolveVersion || resolveWorkflowVersion;
  const enqueue = deps.enqueue || enqueueRun;
  const recordMissed = deps.recordMissed || recordMissedTriggers;

  const schedules = await scheduleModel.find({
    triggerType: 'cron',
    isActive: true,
    nextRunAt: { $lte: now }
  }).lean();

  const results = [];

  for (const schedule of schedules) {
    const dueAt = new Date(schedule.nextRunAt);
    try {
      // Computed first: an invalid cron fails here, before anything is queued.
      const nextRunAt = getNextRunAt(schedule.cronExpr, now, schedule.timezone || 'UTC');

      // Claim the due slot atomically by advancing nextRunAt. A second worker (or a slow tick that
      // overlaps this one) finds nextRunAt already moved and skips, so a slot can't be queued twice.
      const claimed = await scheduleModel.findOneAndUpdate(
        { _id: schedule._id, isActive: true, nextRunAt: schedule.nextRunAt },
        { $set: { nextRunAt, lastEvaluatedAt: now } },
        { new: false }
      );
      if (!claimed) {
        results.push({ scheduleId: schedule._id, workflowId: schedule.workflowId, enqueued: false, reason: 'claimed_elsewhere' });
        continue;
      }

      if (now.getTime() - dueAt.getTime() > staleGraceMs) {
        const missed = await recordMissed(schedule._id, new Date(dueAt.getTime() - 1), now);
        console.warn(`[scheduler] skipped stale schedule=${schedule._id} workflow=${schedule.workflowId} tenant=${schedule.tenantId} dueAt=${dueAt.toISOString()} missed=${missed.length}`);
        results.push({
          scheduleId: schedule._id,
          workflowId: schedule.workflowId,
          enqueued: false,
          reason: 'stale_skipped',
          missedCount: missed.length
        });
        continue;
      }

      let queued;
      try {
        const { workflowVersion, versionId } = await resolveVersion({
          tenantId: schedule.tenantId,
          workflowId: schedule.workflowId,
          version: null
        });

        // Windows are built from the slot that was due, not from "now".
        const context = buildCronContext(schedule, dueAt, {
          metric: 'cvr'
        });

        queued = await enqueue({
          tenantId: schedule.tenantId,
          workflowId: schedule.workflowId,
          version: versionId,
          context,
          definitionJson: workflowVersion.definitionJson,
          triggerType: 'cron',
          triggerRef: schedule._id,
          overlapPolicy: schedule.overlapPolicy,
          maxAttempts: schedule.retryPolicy?.maxAttempts || 3
        });
      } catch (error) {
        // Nothing was queued: hand the slot back so the next tick retries it.
        await scheduleModel.updateOne(
          { _id: schedule._id, nextRunAt },
          { $set: { nextRunAt: dueAt } }
        );
        throw error;
      }

      if (queued.enqueued) {
        await scheduleModel.updateOne({ _id: schedule._id }, {
          $set: { lastTriggeredAt: now, 'metadata.lastSkipReason': null, 'metadata.lastSkippedAt': null }
        });
      } else {
        // A due run that was not queued (e.g. the previous run is still going) used to leave no trace
        // at all. Remember why, so it shows on the schedule and in the worker log.
        console.warn(`[scheduler] due run not queued schedule=${schedule._id} workflow=${schedule.workflowId} tenant=${schedule.tenantId} reason=${queued.reason || 'unknown'}`);
        await scheduleModel.updateOne({ _id: schedule._id }, {
          $set: { 'metadata.lastSkipReason': queued.reason || 'unknown', 'metadata.lastSkippedAt': now }
        });
      }

      results.push({
        scheduleId: schedule._id,
        workflowId: schedule.workflowId,
        enqueued: queued.enqueued,
        reason: queued.reason || null,
        runId: queued.run?._id || null
      });
    } catch (error) {
      const shouldDeactivate = error?.status === 404;
      const update = shouldDeactivate
        ? {
            isActive: false,
            lastEvaluatedAt: now,
            'metadata.lastScheduleError': error.message,
            'metadata.deactivatedReason': 'workflow_resolution_failed',
            'metadata.deactivatedAt': now.toISOString()
          }
        : {
            lastEvaluatedAt: now,
            'metadata.lastScheduleError': error.message
          };

      await scheduleModel.updateOne(
        { _id: schedule._id },
        { $set: update }
      );

      console.error(
        `[scheduler] schedule evaluation failed schedule=${schedule._id} workflow=${schedule.workflowId} tenant=${schedule.tenantId} deactivate=${shouldDeactivate} error=${error.message}`
      );

      results.push({
        scheduleId: schedule._id,
        workflowId: schedule.workflowId,
        enqueued: false,
        reason: shouldDeactivate ? 'workflow_resolution_failed' : 'schedule_evaluation_failed',
        error: error.message
      });
    }
  }

  return results;
}

async function recordMissedTriggers(scheduleId, fromTime, toTime) {
  const schedule = await WorkflowSchedule.findById(scheduleId).lean();
  if (!schedule) return [];

  const missedRuns = listMissedRuns(
    schedule.cronExpr,
    fromTime,
    toTime,
    500,
    schedule.timezone || 'UTC'
  );
  const records = [];
  for (const runAt of missedRuns) {
    try {
      const item = await MissedTrigger.create({
        tenantId: schedule.tenantId,
        workflowId: schedule.workflowId,
        scheduleId: schedule._id,
        intendedRunAt: runAt
      });
      records.push(item);
    } catch (error) {
      if (error && error.code === 11000) continue;
      throw error;
    }
  }
  return records;
}

// At most `limit` oldest pending slots per call, so one click can't queue hundreds of runs.
async function replayMissedTriggers(scheduleId, { limit = 50 } = {}) {
  const schedule = await WorkflowSchedule.findById(scheduleId).lean();
  if (!schedule) {
    const err = new Error('schedule not found');
    err.status = 404;
    throw err;
  }

  const pending = await MissedTrigger.find({
    scheduleId,
    status: 'pending_replay'
  }).sort({ intendedRunAt: 1 }).limit(limit);

  const replayed = [];

  for (const missed of pending) {
    const { workflowVersion, versionId } = await resolveWorkflowVersion({
      tenantId: schedule.tenantId,
      workflowId: schedule.workflowId,
      version: null
    });

    const context = buildCronContext(schedule, missed.intendedRunAt, {
      metric: 'cvr'
    });

    const queued = await enqueueRun({
      tenantId: schedule.tenantId,
      workflowId: schedule.workflowId,
      version: versionId,
      context,
      definitionJson: workflowVersion.definitionJson,
      triggerType: 'cron',
      triggerRef: schedule._id,
      overlapPolicy: schedule.overlapPolicy,
      maxAttempts: schedule.retryPolicy?.maxAttempts || 3
    });

    if (!queued.enqueued) {
      continue;
    }

    missed.status = 'replayed';
    missed.replayedAt = new Date();
    missed.replayRunId = queued.run._id;
    await missed.save();

    replayed.push({ missedTriggerId: missed._id, runId: queued.run._id });
  }

  return replayed;
}

module.exports = {
  buildDefaultContext,
  buildPreviousCompleteDayContext,
  buildDayToDateVsPreviousDayContext,
  buildCronContext,
  ingestEventTrigger,
  createSchedule,
  evaluateDueSchedules,
  getStaleGraceMs,
  recordMissedTriggers,
  replayMissedTriggers
};
