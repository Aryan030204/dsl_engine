const mergeContext = require('../engine/MergeContext');
const validationNode = require('./ValidationNode');
const metricCompareNode = require('./MetricCompareNode');
const recursiveDimensionBreakdownNode = require('./RecursiveDimensionBreakdownNode');
const branchNode = require('./BranchNode');
const insightNode = require('./InsightNode');
const workflowRefNode = require('./WorkflowRefNode');
const emailNode = require('./EmailNode');
const messagingNode = require('./MessagingNode');

const NodeRegistry = {
  validation: validationNode,
  metric_compare: metricCompareNode,
  recursive_dimension_breakdown: recursiveDimensionBreakdownNode,
  branch: branchNode,
  workflow_ref: workflowRefNode,
  insight: insightNode,
  email: emailNode,
  messaging: messagingNode
};

async function CompositeNode(def, context, nodeMapOrOptions) {
  const { steps = [], next } = def;
  const nodeMap = nodeMapOrOptions?.nodeMap || nodeMapOrOptions;
  const runtime = nodeMapOrOptions?.runtime;

  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      status: 'fail',
      reason: 'CompositeNode: steps must be a non-empty array'
    };
  }

  const compositeDelta = {
    filters: [],
    metrics: {},
    rootCausePath: [],
    scratch: {}
  };

  for (const stepId of steps) {
    const stepDef = nodeMap[stepId];

    if (!stepDef) {
      return {
        status: 'fail',
        reason: `CompositeNode: step not found: ${stepId}`
      };
    }

    const executor = NodeRegistry[stepDef.type];
    if (!executor) {
      return {
        status: 'fail',
        reason: `CompositeNode: unsupported node type: ${stepDef.type}`
      };
    }

    const result = ['workflow_ref', 'email', 'insight', 'messaging'].includes(stepDef.type)
      ? await executor(stepDef, context, runtime)
      : await executor(stepDef, context);

    if (!result || typeof result !== 'object') {
      return {
        status: 'fail',
        reason: `CompositeNode: invalid result from ${stepId}`
      };
    }

    // --- failure handling ---
    if (result.status === 'terminated') {
      return result;
    }

    if (result.status === 'fail') {
      const onFail = stepDef.on_fail;

      if (onFail?.action === 'terminate') {
        return {
          status: 'fail',
          reason: onFail.reason || result.reason
        };
      }

      return {
        status: 'fail',
        reason: result.reason
      };
    }

    // --- merge into context immediately ---
    if (result.delta) {
      mergeContext(context, result.delta);
      mergeContext(compositeDelta, result.delta);
    }
  }

  return {
    status: 'pass',
    delta: compositeDelta,
    next
  };
}

module.exports = CompositeNode;
