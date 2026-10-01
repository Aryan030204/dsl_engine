
import dagre from 'dagre';
import { MarkerType } from '@xyflow/react';

const NODE_WIDTH = 250;
const NODE_HEIGHT = 80;

// Generate unique ID for rules (for backward compatibility when loading)
const generateRuleId = () => `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// Ensure a rule has an ID - used for backward compatibility
const ensureRuleId = (rule, idx) => rule._ruleId || `legacy_rule_${idx}`;

/**
 * Converts Backend JSON format to React Flow elements (Nodes + Edges)
 */
export const jsonToGraph = (workflowJson) => {
  const nodes = [];
  const edges = [];
  const nodeMap = new Map();

  if (!workflowJson?.nodes) return { nodes: [], edges: [] };

  // 1. Create Nodes
  workflowJson.nodes.forEach((n) => {
    // Determine visual type based on backend type
    let type = 'default';
    if (n.type === 'validation') type = 'validation';
    if (n.type === 'branch') type = 'branch';
    if (n.type === 'metric_compare' || n.type === 'metric_breakdown' || n.type === 'recursive_dimension_breakdown') type = 'analysis';
    if (n.type === 'insight') type = 'insight';
    if (n.type === 'composite') type = 'composite';
    if (n.type === 'workflow_ref') type = 'workflow_ref';
    if (n.type === 'email' || n.type === 'messaging') type = 'email';
    if (n.id === 'trigger') type = 'trigger'; // hypothetical

    // For branch nodes, ensure each rule has a stable _ruleId
    let nodeData = { ...n };
    if (n.type === 'branch' && Array.isArray(n.rules)) {
      nodeData.rules = n.rules.map((rule, idx) => ({
        ...rule,
        _ruleId: rule._ruleId || generateRuleId()
      }));
    }

    // Create the node object
    const flowNode = {
      id: n.id,
      type: type, // Matches registered custom node types
      position: { x: 0, y: 0 }, // Will be calculated by layout engine
      data: { 
        // Pass original definition as data
        ...nodeData,
        label: n.id // Default label
      },
    };
    
    nodes.push(flowNode);
    nodeMap.set(n.id, flowNode);
  });

  // 2. Create Edges
  workflowJson.nodes.forEach((n) => {
    // Standard 'next' pointer
    if (n.next) {
      edges.push({
        id: `${n.id}-${n.next}`,
        source: n.id,
        target: n.next,
        type: 'deletable',
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }

    // Branch nodes have routing logic
    if (n.type === 'branch' && n.rules) {
      // Get the rules with IDs from the node we created (which has _ruleId assigned)
      const nodeWithRuleIds = nodeMap.get(n.id);
      const rulesWithIds = nodeWithRuleIds?.data?.rules || n.rules;
      
      rulesWithIds.forEach((rule, index) => {
        const ruleId = rule._ruleId || `legacy_rule_${index}`;
        if (rule.then) {
          edges.push({
            id: `${n.id}-rule-${ruleId}-${rule.then}`,
            source: n.id,
            sourceHandle: `handle-rule-${ruleId}`, // Use rule ID for stable handle
            target: rule.then,
            type: 'deletable',
            label: `Rule ${index + 1}`,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: '#9333ea' } 
          });
        }
      });

      // Default path for branch
      if (n.default && n.default.then) {
        edges.push({
          id: `${n.id}-default-${n.default.then}`,
          source: n.id,
          sourceHandle: 'handle-default',
          target: n.default.then,
          type: 'deletable',
          label: 'Default',
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: true,
        });
      }
    } 
    // Composite nodes have 'steps' which point to other nodes, but those nodes are *start points* of sub-chains?
    // In the JSON provided:
    // composite_breakdown points to [product_breakdown, traffic_source_breakdown].
    // These nodes (product_breakdown, etc) are defined at the top level of the JSON.
    // So visualy, the composite node should point to them.
    else if (n.type === 'composite' && n.steps) {
        n.steps.forEach((stepId) => {
             edges.push({
                id: `${n.id}-step-${stepId}`,
                source: n.id,
                target: stepId,
                type: 'deletable',
                label: 'Step',
                markerEnd: { type: MarkerType.ArrowClosed },
                style: { strokeDasharray: '5,5' } // Dashed line for composite containment/flow
              });
        });
        
        // Composite node ALSO has a 'next' pointer (to final_insight). 
        // This is handled by the generic 'next' block below, BUT...
        // If a node is inside a composite, does it connect back to 'next'?
        // The JSON says `product_breakdown.next = null`. 
        // This implies the composite executions finish, and then the flow continues from `composite_breakdown.next`.
    }
    
    // Standard 'next' pointer
    // Usually validation is linear unless terminating.
    // If on_fail has a 'next' property (unlikely in current schema, but possible).
  });

  // 3. Auto-layout
  return getLayoutedElements(nodes, edges);
};

/**
 * Converts React Flow elements back to Backend JSON
 */
export const graphToJson = (nodes, edges, initialMetadata) => {
  // Create a map of React Flow ID -> Backend ID (from data.id)
  const idMap = new Map();
  nodes.forEach(node => {
    if (node.data && node.data.id) {
        idMap.set(node.id, node.data.id);
    }
  });

  const backendNodes = nodes.map((node) => {
    // Start with data from the node
    const backendNode = { ...node.data };
    
    // Clean up internal React Flow flags
    delete backendNode.label;

    // React Flow renders both legacy email and messaging with the email component.
    // Preserve the backend node type from the node data explicitly.
    if (node.data?.type === 'messaging') {
      backendNode.type = 'messaging';
    }

    // Ensure type is present (Critical Fix for backend validation)
    // If backendNode.type is missing, infer it from React Flow node.type
    if (!backendNode.type) {
      if (node.type === 'validation') backendNode.type = 'validation';
      if (node.type === 'branch') backendNode.type = 'branch';
      if (node.type === 'insight') backendNode.type = 'insight';
      if (node.type === 'composite') backendNode.type = 'composite';
      if (node.type === 'workflow_ref') backendNode.type = 'workflow_ref';
      if (node.type === 'email' && backendNode.type !== 'messaging') backendNode.type = 'email';
      if (node.type === 'messaging') backendNode.type = 'messaging';
      // Note: 'analysis' nodes (metric_compare/breakdown) explicitly set 'type' in data during creation,
      // so they should likely preserve it.
    }
    
    // Reconstruct 'next' pointers based on edges
    const outgoingEdges = edges.filter(e => e.source === node.id);

    if (node.type === 'branch') {
      // Branch logic handled via rules reconstruction or keeping data in sync
      // Ideally BranchNode data.rules is updated by the properties panel
      // Here we mostly valid structure or update 'then' pointers if edges changed
      
      // Update rules 'then' targets based on edges connected to specific handles
      // Deep clone rules to avoid mutating React state
      if (backendNode.rules) {
        backendNode.rules = backendNode.rules.map((rule, idx) => {
            const ruleId = rule._ruleId || `legacy_rule_${idx}`;
            const ruleEdge = outgoingEdges.find(e => e.sourceHandle === `handle-rule-${ruleId}`);
            const newRule = { ...rule };
            if (ruleEdge && idMap.has(ruleEdge.target)) {
                newRule.then = idMap.get(ruleEdge.target);
            } else {
                delete newRule.then; 
            }
            return newRule;
        });
      }
      
      const defaultEdge = outgoingEdges.find(e => e.sourceHandle === 'handle-default');
      
      if (defaultEdge && idMap.has(defaultEdge.target)) {
          // Ensure default object exists and set 'then'
          backendNode.default = backendNode.default || {};
          backendNode.default.then = idMap.get(defaultEdge.target);
      } else if (backendNode.default) {
          // Clean up if disconnected
          delete backendNode.default.then;
          // Optional: delete backendNode.default if empty? 
          // Keeping it is fine as it might have other props in future.
      }

      delete backendNode.next; // Branches typically don't have a single next
    } else if (node.type === 'composite') {
      const stepEdges = outgoingEdges.filter((edge) => edge.label === 'Step' || edge.id?.startsWith(`${node.id}-step-`));
      if (stepEdges.length) {
        backendNode.steps = stepEdges
          .filter((edge) => idMap.has(edge.target))
          .map((edge) => idMap.get(edge.target));
      }

      const nextEdge = outgoingEdges.find((edge) => !stepEdges.includes(edge));
      if (nextEdge && idMap.has(nextEdge.target)) {
        backendNode.next = idMap.get(nextEdge.target);
      } else {
        delete backendNode.next;
      }
    } else {
      // Standard nodes
      const nextEdge = outgoingEdges[0]; // Assuming single output for standard nodes
      if (nextEdge && idMap.has(nextEdge.target)) {
        backendNode.next = idMap.get(nextEdge.target);
      } else {
        delete backendNode.next;
      }
    }

    return backendNode;
  });

  return {
    ...initialMetadata,
    nodes: backendNodes
  };
};


// --- Helper for Dagre Layout ---
const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Improved spacing configuration
  dagreGraph.setGraph({ 
    rankdir: direction,
    ranksep: 100, // Increased vertical separation between ranks
    nodesep: 80   // Increased horizontal separation between nodes
  });

  // Dynamic dimension calculation based on node type and content
  // This helps Dagre allocate enough space so nodes don't overlap
  const getNodeDimensions = (node) => {
      let width = 280; // Base width including some margin
      let height = 100; // Base height

      switch(node.type) {
          case 'branch':
              width = 330; // Branch nodes are wider (300px + margin)
              const rulesCount = node.data?.rules?.length || 0;
              // Header(~40) + Padding(~20) + Rules(rulesCount * 45) + Default(~45)
              height = 70 + (rulesCount * 45) + 45; 
              break;
          case 'composite':
              width = 330;
              const stepsCount = node.data?.steps?.length || 0;
              height = 80 + (stepsCount * 35);
              break;
          case 'validation':
              const checksCount = node.data?.checks?.length || 0;
              height = 70 + (checksCount * 30);
              break;
          case 'insight':
              height = 160; // Text content usually makes these taller
              break;
          case 'analysis':
              height = 140;
              break;
          case 'workflow_ref':
              width = 310;
              height = 145;
              break;
          default:
              height = 100;
      }
      return { width, height };
  };

  nodes.forEach((node) => {
    const { width, height } = getNodeDimensions(node);
    dagreGraph.setNode(node.id, { width, height });
    // Store calculated dimensions on node for position recovery
    node.__layoutDimensions = { width, height };
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const { width, height } = node.__layoutDimensions;
    
    // Clean up temporary property
    delete node.__layoutDimensions;

    return {
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: {
            // Dagre gives center coordinates, React Flow needs top-left
            x: nodeWithPosition.x - (width / 2),
            y: nodeWithPosition.y - (height / 2),
        },
    };
  });

  return { nodes: layoutedNodes, edges };
};
