const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
require('dotenv').config();

const { runLoop } = require('./infra/workerLoop');
const { evaluateDueSchedules } = require('./app/schedulerService');
const { startAlertSubscriber } = require('./infra/subscriber/alertSubscriberLoop');

async function start() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(mongoUri);

  const workerId = process.env.SCHEDULER_WORKER_ID || `worker-${process.pid}`;
  const intervalMs = Number(process.env.SCHEDULER_POLL_INTERVAL_MS || 2000);
  const cronTickMs = Number(process.env.SCHEDULER_CRON_TICK_MS || 60000);
  const cronEnabled = process.env.SCHEDULER_CRON_ENABLED !== 'false';
  const runExecutorEnabled = process.env.SCHEDULER_RUN_EXECUTOR_ENABLED !== 'false';
  const alertSubscriberEnabled = process.env.SCHEDULER_ALERT_SUBSCRIBER_ENABLED === 'true';

  const stopSignal = { stopped: false };
  let subscriberHandle = null;

  // The tick must never throw (an unhandled rejection in a timer callback ends the worker process)
  // and must never overlap itself when a slow tick runs past the interval.
  let tickInFlight = false;
  const cronTick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const results = await evaluateDueSchedules(new Date());
      if (results.length) {
        const queued = results.filter((result) => result.enqueued).length;
        console.log(`[scheduler-worker] cron tick: ${queued} queued, ${results.length - queued} not queued (${results.filter((result) => !result.enqueued).map((result) => result.reason).join(', ') || 'none'})`);
      }
    } catch (error) {
      console.error('[scheduler-worker] cron tick failed', error.message);
    } finally {
      tickInFlight = false;
    }
  };
  const cronTimer = cronEnabled ? setInterval(cronTick, cronTickMs) : null;
  if (cronEnabled) void cronTick();

  if (alertSubscriberEnabled) {
    subscriberHandle = await startAlertSubscriber({ stopSignal });
  }

  process.on('SIGINT', () => {
    stopSignal.stopped = true;
    if (cronTimer) clearInterval(cronTimer);
  });

  process.on('SIGTERM', () => {
    stopSignal.stopped = true;
    if (cronTimer) clearInterval(cronTimer);
  });

  console.log(`[scheduler-worker] started workerId=${workerId}`);
  const tasks = [];
  if (runExecutorEnabled) {
    tasks.push(runLoop({ workerId, intervalMs, stopSignal }));
  }
  if (subscriberHandle) {
    tasks.push(subscriberHandle.promise);
  }

  if (tasks.length) {
    await Promise.all(tasks);
  } else {
    while (!stopSignal.stopped) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  if (subscriberHandle) {
    await subscriberHandle.close();
  }

  await mongoose.disconnect();
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
