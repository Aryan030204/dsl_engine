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
    let currentNodeId = workflowDefinition.nodes[0].id;
    const visited = new Set();
    const { workflowIdentity, sharedState } = frame;

    context.meta = context.meta || {};
    context.meta.workflowId = workflowDefinition.workflow_id || context.meta.workflowId;
    context.meta.workflowName = workflowDefinition.name || workflowDefinition.workflow_id || context.meta.workflowName;
    context.meta.brandName = inferBrandName(workflowDefinition, context.meta);

    // --- execution trace ---
    context.executionTrace = context.executionTrace || [];

    while (currentNodeId) {
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
      context.executionTrace.push({
        nodeId: currentNodeId,
        type: nodeDef.type,
        workflowIdentity,
        timestamp: new Date().toISOString()
      });

      const runtime = this.createNodeRuntime({ nodeMap, workflowIdentity, sharedState });

      const result = nodeDef.type === 'composite'
        ? await executor(nodeDef, context, { nodeMap, runtime })
        : nodeDef.type === 'workflow_ref'
          ? await executor(nodeDef, context, runtime)
          : nodeDef.type === 'email' || nodeDef.type === 'insight' || nodeDef.type === 'messaging'
            ? await executor(nodeDef, context, runtime)
          : await executor(nodeDef, context);

      if (this.options.onNodeResult) {
        this.options.onNodeResult({
          nodeId: currentNodeId,
          type: nodeDef.type,
          workflowIdentity,
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

      // --- move execution pointer ---
      currentNodeId = result.next || null;
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
