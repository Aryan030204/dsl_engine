// A workflow run that takes longer than this is cut off and marked failed. Applies to the
// in-process executor (deadline + hard timer) and to the sweeper that fails runs whose
// process died mid-run. WORKFLOW_RUN_TIMEOUT_MS=0 disables it.
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_CODE = 'RUN_TIMEOUT';
const RUN_CANCELED_CODE = 'RUN_CANCELED';

function getRunTimeoutMs(env = process.env) {
  const raw = env.WORKFLOW_RUN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_RUN_TIMEOUT_MS;
}

function describeLimit(timeoutMs) {
  const minutes = timeoutMs / 60000;
  return Number.isInteger(minutes) ? `${minutes} minute` : `${Math.round(timeoutMs / 1000)} second`;
}

function runTimeoutMessage(timeoutMs) {
  return `Run exceeded the ${describeLimit(timeoutMs)} limit and was stopped`;
}

function createRunTimeoutError(timeoutMs) {
  const error = new Error(runTimeoutMessage(timeoutMs));
  error.code = RUN_TIMEOUT_CODE;
  return error;
}

// A run that was cut because a newer scheduled run replaced it (overlap policy replace_running).
function createRunCanceledError() {
  const error = new Error('Run was canceled: replaced by a newer scheduled run');
  error.code = RUN_CANCELED_CODE;
  return error;
}

module.exports = { DEFAULT_RUN_TIMEOUT_MS, RUN_TIMEOUT_CODE, RUN_CANCELED_CODE, createRunCanceledError, getRunTimeoutMs, runTimeoutMessage, createRunTimeoutError };
