const express = require('express');
const WorkflowSchedule = require('../models/WorkflowSchedule');
const MissedTrigger = require('../models/MissedTrigger');
const { createSchedule, replayMissedTriggers } = require('../../scheduler/app/schedulerService');
const { getNextRunAt, validateCronExpr } = require('../../scheduler/app/cronUtils');
const {
  SCHEDULE_WINDOW_MODES,
  SCHEDULE_WINDOW_MODE_VALUES
} = require('../../scheduler/app/scheduleWindowModes');
const Tenant = require('../models/Tenant');

function isSupportedTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const router = express.Router({ mergeParams: true });

router.post('/:workflowId/schedules', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    const { cronExpr, timezone, windowMode = SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY } = req.body || {};

    if (!cronExpr) {
      return res.status(400).json({ error: 'cronExpr is required' });
    }
    const cronCheck = validateCronExpr(cronExpr);
    if (!cronCheck.ok) {
      return res.status(400).json({ error: cronCheck.error });
    }

    let resolvedTimeZone = timezone;
    if (!resolvedTimeZone) {
      const tenant = await Tenant.findOne({ tenantId }).lean();
      resolvedTimeZone = tenant?.settings?.timezone || 'UTC';
    }

    if (!isSupportedTimeZone(resolvedTimeZone)) {
      return res.status(400).json({ error: 'timezone must be a supported IANA timezone' });
    }

    if (!SCHEDULE_WINDOW_MODE_VALUES.includes(windowMode)) {
      return res.status(400).json({ error: `windowMode must be one of ${SCHEDULE_WINDOW_MODE_VALUES.join(', ')}` });
    }

    const schedule = await createSchedule({
      tenantId,
      workflowId,
      payload: {
        ...(req.body || {}),
        timezone: resolvedTimeZone
      }
    });

    res.status(201).json({ schedule });
  } catch (error) {
    next(error);
  }
});

router.get('/:workflowId/schedules', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    const schedules = await WorkflowSchedule.find({ tenantId, workflowId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ schedules });
  } catch (error) {
    next(error);
  }
});

router.patch('/:workflowId/schedules/:scheduleId', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;

    const updates = {};
    ['name', 'cronExpr', 'overlapPolicy', 'retryPolicy', 'isActive', 'windowMode', 'timezone'].forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (
      updates.windowMode !== undefined
      && !SCHEDULE_WINDOW_MODE_VALUES.includes(updates.windowMode)
    ) {
      return res.status(400).json({ error: `windowMode must be one of ${SCHEDULE_WINDOW_MODE_VALUES.join(', ')}` });
    }

    const current = await WorkflowSchedule.findOne({ _id: scheduleId, tenantId, workflowId }).lean();
    if (!current) return res.status(404).json({ error: 'schedule not found' });

    if (updates.cronExpr !== undefined) {
      const cronCheck = validateCronExpr(updates.cronExpr);
      if (!cronCheck.ok) return res.status(400).json({ error: cronCheck.error });
    }

    if (updates.timezone !== undefined && !isSupportedTimeZone(updates.timezone)) {
      return res.status(400).json({ error: 'timezone must be a supported IANA timezone' });
    }

    const resolvedWindowMode = updates.windowMode || current.windowMode || SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY;
    const resolvedCronExpr = updates.cronExpr || current.cronExpr;
    const resolvedTimeZone = updates.timezone || current.timezone || 'UTC';

    if (updates.cronExpr || updates.timezone) {
      updates.nextRunAt = getNextRunAt(resolvedCronExpr, new Date(), resolvedTimeZone);
    }

    const schedule = await WorkflowSchedule.findOneAndUpdate(
      { _id: scheduleId, tenantId, workflowId },
      { $set: updates },
      { new: true }
    );

    res.json({ schedule });
  } catch (error) {
    next(error);
  }
});

router.post('/:workflowId/schedules/:scheduleId/pause', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;
    const schedule = await WorkflowSchedule.findOneAndUpdate(
      { _id: scheduleId, tenantId, workflowId },
      { $set: { isActive: false, pausedAt: new Date() } },
      { new: true }
    );

    if (!schedule) return res.status(404).json({ error: 'schedule not found' });
    res.json({ schedule });
  } catch (error) {
    next(error);
  }
});

router.post('/:workflowId/schedules/:scheduleId/resume', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;
    const current = await WorkflowSchedule.findOne({ _id: scheduleId, tenantId, workflowId }).lean();
    if (!current) return res.status(404).json({ error: 'schedule not found' });

    const schedule = await WorkflowSchedule.findOneAndUpdate(
      { _id: scheduleId, tenantId, workflowId },
      {
        $set: {
          isActive: true,
          nextRunAt: getNextRunAt(current.cronExpr, new Date(), current.timezone || 'UTC')
        },
        $unset: { pausedAt: 1 }
      },
      { new: true }
    );

    res.json({ schedule });
  } catch (error) {
    next(error);
  }
});

router.post('/:workflowId/schedules/:scheduleId/replay-missed', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;
    const schedule = await WorkflowSchedule.findOne({ _id: scheduleId, tenantId, workflowId }).lean();
    if (!schedule) return res.status(404).json({ error: 'schedule not found' });

    const replayed = await replayMissedTriggers(scheduleId);

    res.json({ replayedCount: replayed.length, replayed });
  } catch (error) {
    next(error);
  }
});

router.delete('/:workflowId/schedules/:scheduleId', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;

    const schedule = await WorkflowSchedule.findOneAndDelete({
      _id: scheduleId,
      tenantId,
      workflowId
    });

    if (!schedule) {
      return res.status(404).json({ error: 'schedule not found' });
    }

    await MissedTrigger.deleteMany({ tenantId, workflowId, scheduleId });

    res.json({ deleted: true, scheduleId });
  } catch (error) {
    next(error);
  }
});

router.get('/:workflowId/schedules/:scheduleId/missed', async (req, res, next) => {
  try {
    const { tenantId, workflowId, scheduleId } = req.params;

    const missed = await MissedTrigger.find({ tenantId, workflowId, scheduleId })
      .sort({ intendedRunAt: -1 })
      .lean();

    res.json({ missed });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
