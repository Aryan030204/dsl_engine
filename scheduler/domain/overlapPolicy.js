const ACTIVE_STATUSES = new Set(['running', 'retrying']);
const PENDING_STATUSES = new Set(['queued', 'deferred', 'retrying']);

function evaluateOverlap({ activeRun, pendingRun, overlapPolicy = 'queue_one_pending' }) {
  if (overlapPolicy === 'allow_parallel') {
    return { action: 'queue' };
  }

  // The newest scheduled run wins: whatever is running or waiting is cancelled and the new run
  // starts straight away (see enqueueRun).
  if (overlapPolicy === 'replace_running') {
    return activeRun || pendingRun ? { action: 'replace' } : { action: 'queue' };
  }

  if (!activeRun) {
    return { action: 'queue' };
  }

  if (overlapPolicy === 'skip_if_running') {
    return { action: 'skip', reason: 'active_run_exists' };
  }

  if (pendingRun) {
    return { action: 'skip', reason: 'pending_run_exists' };
  }

  return { action: 'defer' };
}

module.exports = {
  ACTIVE_STATUSES,
  PENDING_STATUSES,
  evaluateOverlap
};
