const { createRunTimeoutError, createRunCanceledError } = require('../lib/runTimeout');
const workflow = require('../workflows/cvr_drop.json');
const mergeContext = require('./MergeContext');
const validationNode = require('../nodes/ValidationNode');
const metricCompareNode = require('../nodes/MetricCompareNode');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const compositeNode = require('../nodes/CompositeNode');
const branchNode = require('../nodes/BranchNode');
const insightNode = require('../nodes/InsightNode');
const workflowRefNode = require('../nodes/WorkflowRefNode');
const emailNode = require('../nodes/EmailNode');
const messagingNode = require('../nodes/MessagingNode');
const { getQueryStats } = require('../sql/QueryExecutor');

const NodeRegistry = {
  validation: validationNode,
  metric_compare: metricCompareNode,
  recursive_dimension_breakdown: recursiveDimensionBreakdownNode,
  composite: compositeNode,
  branch: branchNode,
  workflow_ref: workflowRefNode,
  insight: insightNode,
  email: emailNode,
  messaging: messagingNode
};

// A node's `next` is one node id, or a list of ids (the run fans out: every listed node runs). These helpers read
// the static graph the runner schedules from.
function normalizeTargets(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((id) => typeof id === 'string' && id.trim() !== ''))];
}

// Every node a node can hand the run to: its next target(s) and a branch's rule / default targets.
function staticSuccessors(node) {
  const ids = [...normalizeTargets(node?.next)];
  (Array.isArray(node?.rules) ? node.rules : []).forEach((rule) => ids.push(...normalizeTargets(rule?.then)));
  ids.push(...normalizeTargets(node?.default?.then));
  return [...new Set(ids)];
}

function buildPredecessorMap(nodeMap) {
  const predecessors = new Map();
  Object.values(nodeMap).forEach((node) => {
    staticSuccessors(node).forEach((target) => {
      if (!predecessors.has(target)) predecessors.set(target, new Set());
      predecessors.get(target).add(node.id);
    });
  });
  return predecessors;
}

// Everything that can still run after (and including) the given nodes.
function reachableFrom(startIds, nodeMap) {
  const seen = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (nodeMap[id]) stack.push(...staticSuccessors(nodeMap[id]));
  }
  return seen;
}

// Picks the next waiting node to run. A node that several branches lead into (a join, e.g. one report built from
// two branches) must wait until every branch that can still reach it has finished; otherwise it would run
// after the first branch only and miss the other branch's results.
function takeNextReady(queue, executed, predecessors, nodeMap) {
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    const others = queue.filter((id) => id !== candidate);
    const stillComing = reachableFrom(others, nodeMap);
    const waitingOn = [...(predecessors.get(candidate) || [])]
      .some((predecessor) => !executed.has(predecessor) && stillComing.has(predecessor));
    if (!waitingOn) {
      queue.splice(index, 1);
      return candidate;
    }
  }
  // Nothing is clear to run (should not happen in an acyclic workflow): run the first one rather than hang.
  return queue.shift();
}

const DEFAULT_MAX_EXECUTION_STEPS = 100;
const DEFAULT_MAX_WORKFLOW_REF_DEPTH = 8;

class WorkflowRunner {
  constructor(workflow, options = {}) {
    this.workflow = workflow;
    this.options = options;
    this.maxExecutionSteps = options.maxExecutionSteps || DEFAULT_MAX_EXECUTION_STEPS;
    this.maxWorkflowRefDepth = options.maxWorkflowRefDepth || DEFAULT_MAX_WORKFLOW_REF_DEPTH;
  }

  buildNodeMap(nodes) {
    const map = {};
    nodes.forEach(node => {
      if (!node.id) {
        throw new Error('Each node must have a unique id');
      }
      map[node.id] = node;
    });
    return map;
  }

  async executeWorkflow(context) {
    const rootIdentity = this.options.workflowIdentity || this.inferRootIdentity(context);
    const sharedState = {
      totalSteps: 0,
      workflowStack: rootIdentity ? [rootIdentity] : [],
      workflowRefDepth: 0
    };

    return this.executeDefinition(this.workflow, context, {
      workflowIdentity: rootIdentity || 'root',
      sharedState
    });
  }

  inferRootIdentity(context) {
    const tenantId = context?.meta?.tenantId || 'tenant';
    const workflowId = this.workflow?.workflow_id || 'workflow';
    const version = this.workflow?.version || 'unknown';
    return `${tenantId}/${workflowId}@${version}`;
  }

  async executeDefinition(workflowDefinition, context, frame) {
    if (!context || Object.keys(context).length === 0) {
      throw new Error('Execution context is required to run the workflow');
    }

    if (!workflowDefinition?.nodes?.length) {
      throw new Error('Workflow definition has no nodes');
    }

    const nodeMap = this.buildNodeMap(workflowDefinition.nodes);
    // Nodes waiting to run, in order. The run starts at the first node; a node with several `next` targets adds
    // all of them, so every branch runs (one after another, in the listed order, each to its end before the
    // next starts unless they join).
    const queue = [workflowDefinition.nodes[0].id];
    const predecessors = buildPredecessorMap(nodeMap);
    const visited = new Set();
    const { workflowIdentity, sharedState } = frame;

    context.meta = context.meta || {};
    context.meta.workflowId = workflowDefinition.workflow_id || context.meta.workflowId;
    context.meta.workflowName = workflowDefinition.name || workflowDefinition.workflow_id || context.meta.workflowName;
    context.meta.brandName = inferBrandName(workflowDefinition, context.meta);

    // --- execution trace ---
    context.executionTrace = context.executionTrace || [];

    while (queue.length) {
      const currentNodeId = takeNextReady(queue, visited, predecessors, nodeMap);
      // Stop between nodes once the run's time limit has passed (see lib/runTimeout.js).
      if (this.options.deadlineAt && Date.now() > this.options.deadlineAt) {
        throw createRunTimeoutError(this.options.timeoutMs || 0);
      }
      // Stop between nodes when the run was cancelled (a newer scheduled run replaced it).
      if (typeof this.options.shouldStop === 'function' && await this.options.shouldStop()) {
        throw createRunCanceledError();
      }
      sharedState.totalSteps++;

      // --- infinite loop guard ---
      if (sharedState.totalSteps > this.maxExecutionSteps) {
        throw new Error('Workflow exceeded maximum execution steps');
      }

      // --- cycle detection ---
      if (visited.has(currentNodeId)) {
        throw new Error(`Workflow cycle detected at node: ${currentNodeId}`);
      }
      visited.add(currentNodeId);

      const nodeDef = nodeMap[currentNodeId];
      if (!nodeDef) {
        throw new Error(`Node not found: ${currentNodeId}`);
      }

      const executor = NodeRegistry[nodeDef.type];
      if (!executor) {
        throw new Error(`Unsupported node type: ${nodeDef.type}`);
      }

      // --- trace ---
      const traceEntry = {
        nodeId: currentNodeId,
        type: nodeDef.type,
        workflowIdentity,
        timestamp: new Date().toISOString()
      };
      context.executionTrace.push(traceEntry);

      const runtime = this.createNodeRuntime({ nodeMap, workflowIdentity, sharedState });

      // How long the node took and how many queries it sent to MySQL (cache hits don't count).
      const nodeStartedAt = Date.now();
      const statsBefore = getQueryStats();
      let result;
      try {
        result = nodeDef.type === 'composite'
          ? await executor(nodeDef, context, { nodeMap, runtime })
          : nodeDef.type === 'workflow_ref'
            ? await executor(nodeDef, context, runtime)
            : nodeDef.type === 'email' || nodeDef.type === 'insight' || nodeDef.type === 'messaging'
              ? await executor(nodeDef, context, runtime)
            : await executor(nodeDef, context);
      } finally {
        traceEntry.durationMs = Date.now() - nodeStartedAt;
        const statsAfter = getQueryStats();
        if (statsBefore && statsAfter) traceEntry.queryCount = statsAfter.queryCount - statsBefore.queryCount;
      }

      if (this.options.onNodeResult) {
        this.options.onNodeResult({
          nodeId: currentNodeId,
          type: nodeDef.type,
          workflowIdentity,
          durationMs: traceEntry.durationMs,
          ...(traceEntry.queryCount !== undefined ? { queryCount: traceEntry.queryCount } : {}),
          result
        });
      }

      if (!result || typeof result !== 'object') {
        throw new Error(`Invalid result returned from node ${currentNodeId}`);
      }

      // --- nested workflow propagated termination ---
      if (result.status === 'terminated') {
        return {
          status: 'terminated',
          reason: result.reason,
          context: result.context || context
        };
      }

      // --- failure handling with on_fail policy ---
      if (result.status === 'fail') {
        const onFail = nodeDef.on_fail;

        if (onFail?.action === 'terminate') {
          return {
            status: 'terminated',
            reason: onFail.reason || result.reason,
            context
          };
        }

        throw new Error(result.reason || `Node ${currentNodeId} failed`);
      }

      // --- merge analytical delta ---
      if (result.delta) {
        mergeContext(context, result.delta);
      }

      // --- schedule the next node(s) ---
      // Targets go to the FRONT of the queue (in order) so a branch is followed to its end before the
      // next branch starts. A target already waiting is not queued twice (that is how branches join).
      const targets = normalizeTargets(result.next);
      for (const target of targets) {
        if (visited.has(target)) {
          throw new Error(`Workflow cycle detected at node: ${target}`);
        }
      }
      const fresh = targets.filter((target) => !queue.includes(target));
      queue.unshift(...fresh);
    }

    return {
      status: 'completed',
      context
    };
  }

  createNodeRuntime({ nodeMap, workflowIdentity, sharedState }) {
    return {
      nodeMap,
      workflowIdentity,
      emailSender: this.options.emailSender,
      telegramSender: this.options.telegramSender,
      executeWorkflowReference: async (nodeDef, context) =>
        this.executeWorkflowReference(nodeDef, context, { workflowIdentity, sharedState })
    };
  }

  async executeWorkflowReference(nodeDef, context, frame) {
    const tenantId = context?.meta?.tenantId;
    if (!tenantId) {
      throw new Error('WorkflowRefNode: context.meta.tenantId is required');
    }

    const resolver = this.options.workflowResolver;
    if (!resolver || typeof resolver.resolveWorkflowReference !== 'function') {
      throw new Error('WorkflowRefNode: workflow resolver service is not configured');
    }

    const { sharedState, workflowIdentity: parentWorkflowIdentity } = frame;
    if (sharedState.workflowRefDepth >= this.maxWorkflowRefDepth) {
      throw new Error(`Workflow reference nesting exceeded maximum depth (${this.maxWorkflowRefDepth})`);
    }

    const resolved = await resolver.resolveWorkflowReference({
      tenantId,
      ref: nodeDef.ref
    });

    if (sharedState.workflowStack.includes(resolved.identity)) {
      const chain = [...sharedState.workflowStack, resolved.identity].join(' -> ');
      throw new Error(`Workflow reference cycle detected: ${chain}`);
    }

    context.executionTrace = context.executionTrace || [];
    context.executionTrace.push({
      type: 'workflow_ref_enter',
      nodeId: nodeDef.id,
      parentWorkflowIdentity,
      workflowIdentity: resolved.identity,
      ref: {
        workflowId: resolved.workflow.workflowId,
        version: resolved.versionId,
        scope: resolved.workflow.scope || 'tenant'
      },
      timestamp: new Date().toISOString()
    });

    sharedState.workflowRefDepth += 1;
    sharedState.workflowStack.push(resolved.identity);

    try {
      const nestedResult = await this.executeDefinition(
        resolved.workflowVersion.definitionJson,
        context,
        {
          workflowIdentity: resolved.identity,
          sharedState
        }
      );

      context.executionTrace.push({
        type: 'workflow_ref_exit',
        nodeId: nodeDef.id,
        parentWorkflowIdentity,
        workflowIdentity: resolved.identity,
        status: nestedResult.status,
        timestamp: new Date().toISOString()
      });

      return nestedResult;
    } catch (error) {
      context.executionTrace.push({
        type: 'workflow_ref_exit',
        nodeId: nodeDef.id,
        parentWorkflowIdentity,
        workflowIdentity: resolved.identity,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      });
      throw error;
    } finally {
      sharedState.workflowStack.pop();
      sharedState.workflowRefDepth -= 1;
    }
  }
}

function inferBrandName(workflowDefinition, meta = {}) {
  if (meta.brandName) {
    return meta.brandName;
  }

  if (meta.tenantId) {
    return meta.tenantId;
  }

  const configuredBrandIds = workflowDefinition?.trigger?.brandScope === 'single'
    ? workflowDefinition?.trigger?.brandIds
    : null;

  if (Array.isArray(configuredBrandIds) && configuredBrandIds.length === 1) {
    return configuredBrandIds[0];
  }

  return null;
}

// Example usage
if (require.main === module) {
  (async () => {
    const runner = new WorkflowRunner(workflow);
    const context = require('./ExecutionContext');
    const finalContext = await runner.executeWorkflow(context);

    console.log('Final Execution Context:', JSON.stringify(finalContext, null, 2));
  })();
}

module.exports = WorkflowRunner;
