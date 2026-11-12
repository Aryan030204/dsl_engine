// Errors a retry can never fix: the workflow itself is misconfigured (a report points at data no
// node produces, a branch has no matching path, a node type doesn't exist ...). Retrying these only
// repeats the same failure three times over ~12 minutes before the run is dead-lettered. Anything
// not listed here (database, network, SMTP, Redis ...) is treated as transient and retried.
const NON_RETRYABLE_PATTERNS = [
  /missing required binding/i,
  /no rule matched and no default/i,
  /node not found/i,
  /unsupported node type/i,
  /workflow cycle detected|cycle detected at node/i,
  /workflow definition has no nodes/i,
  /exceeded maximum execution steps/i,
  /unsupported value format|value is not numeric for format/i,
  /report period bindings must resolve/i,
  /unsupported report preset/i,
  /table source must resolve to an array/i
];

const NON_RETRYABLE_CODE = 'WORKFLOW_CONFIG';

function isNonRetryableError(error) {
  if (!error) return false;
  if (error.code === NON_RETRYABLE_CODE) return true;
  const message = String(error.message || error);
  return NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

module.exports = { isNonRetryableError, NON_RETRYABLE_CODE };
