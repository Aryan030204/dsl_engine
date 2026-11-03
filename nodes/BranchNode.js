async function BranchNode(def, context) {
  const { metrics, breakdowns } = context;
  const { rules = [], default: defaultRule } = def;

  // Track rule evaluations for debugging
  const ruleEvaluations = [];

  if (!metrics) {
    return {
      status: 'fail',
      reason: 'BranchNode: context.metrics is missing'
    };
  }

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    const ruleEval = { 
      ruleIndex, 
      ruleId: rule._ruleId,
      conditions: [],
      matched: false 
    };

    if (rule.filter_in_breakdowns) {
      const filterResult = filterBreakdownEntries(rule.filter_in_breakdowns, breakdowns);
      ruleEval.type = 'breakdown_filter';
      ruleEval.entryLogic = getEntryLogic(rule.filter_in_breakdowns);
      ruleEval.matchScope = getMatchScope(rule.filter_in_breakdowns);
      ruleEval.outputKey = rule.filter_in_breakdowns.write_matches_to || '';
      ruleEval.matchedCount = filterResult.matches.length;
      ruleEval.poolCount = filterResult.poolCount;
      ruleEval.matched = filterResult.passed;
      ruleEvaluations.push(ruleEval);

      if (filterResult.passed) {
        const firstMatch = filterResult.matches[0];
        if (firstMatch) {
          context.scratch = {
            ...(context.scratch || {}),
            matched_breakdown: firstMatch
          };
        }
        return {
          status: 'pass',
          next: rule.then,
          ruleEvaluations,
          matchedRule: ruleIndex,
          delta: {
            breakdowns: {
              [rule.filter_in_breakdowns.write_matches_to]: filterResult.matches
            }
          }
        };
      }
      continue;
    }

    if (rule.any_in_breakdowns || rule.all_in_breakdowns) {
      const breakdownConfig = rule.any_in_breakdowns || rule.all_in_breakdowns;
      const breakdownMode = rule.all_in_breakdowns ? 'all' : 'any';
      const matchedEntry = evaluateBreakdownRule(breakdownConfig, breakdowns, breakdownMode);
      ruleEval.type = 'breakdown';
      ruleEval.entryLogic = getBreakdownEntryLogic(breakdownConfig);
      ruleEval.breakdownMode = breakdownMode;
      ruleEval.matched = !!matchedEntry;
      ruleEvaluations.push(ruleEval);
      
      if (matchedEntry) {
        if (breakdownMode === 'any') {
          context.scratch = {
            ...(context.scratch || {}),
            matched_breakdown: matchedEntry
          };
        }
        return {
          status: 'pass',
          next: rule.then,
          ruleEvaluations,
          matchedRule: ruleIndex
        };
      }
      continue;
    }

    const allConditions = rule.all || [];
    let allMatched = true;

    for (const condition of allConditions) {
      const metricValue = metrics[condition.metric];
      const result = checkCondition(condition, metrics);
      ruleEval.conditions.push({
        type: 'all',
        metric: condition.metric,
        op: condition.op,
        expectedValue: condition.value,
        actualValue: metricValue,
        found: condition.metric in metrics,
        passed: result
      });
      if (!result) {
        allMatched = false;
        break;
      }
    }

    const anyConditions = rule.any || [];
    let anyMatched = false;
    
    if (anyConditions.length > 0) {
      for (const condition of anyConditions) {
        const metricValue = metrics[condition.metric];
        const result = checkCondition(condition, metrics);
        ruleEval.conditions.push({
          type: 'any',
          metric: condition.metric,
          op: condition.op,
          expectedValue: condition.value,
          actualValue: metricValue,
          found: condition.metric in metrics,
          passed: result
        });
        if (result) {
          anyMatched = true;
          break;
        }
      }
    } else {
      anyMatched = true; 
    }

    if (allConditions.length === 0 && anyConditions.length === 0) {
        allMatched = true;
    }

    const finalMatch = (allConditions.length > 0 ? allMatched : true) && 
                       (anyConditions.length > 0 ? anyMatched : true);

    ruleEval.matched = finalMatch;
    ruleEvaluations.push(ruleEval);

    if (finalMatch) {
      return {
        status: 'pass',
        next: rule.then,
        ruleEvaluations,
        matchedRule: ruleIndex
      };
    }
  }

  // --- default path ---
  ruleEvaluations.push({ type: 'default', matched: true });
  
  if (!defaultRule || !defaultRule.then) {
    const missingMetrics = [...new Set(ruleEvaluations
      .flatMap((evaluation) => evaluation.conditions || [])
      .filter((condition) => condition.found === false)
      .map((condition) => condition.metric))];
    return {
      status: 'fail',
      reason: missingMetrics.length
        ? `BranchNode: No rule matched and no default path defined. Metric(s) not available at this point: ${missingMetrics.join(', ')}. Add a Metric Compare node before this branch.`
        : 'BranchNode: No rule matched and no default path defined',
      ruleEvaluations
    };
  }

  return {
    status: 'pass',
    next: defaultRule.then,
    ruleEvaluations,
    matchedRule: 'default'
  };
}

module.exports = BranchNode;

function filterBreakdownEntries(config, breakdowns = {}) {
  const {
    dimension,
    conditions = [],
    limit
  } = config || {};

  if (!dimension || !Array.isArray(conditions) || conditions.length === 0) {
    return { matches: [], passed: false, poolCount: 0 };
  }

  const entries = Array.isArray(breakdowns?.[dimension]) ? breakdowns[dimension] : [];
  const pool = typeof limit === 'number' ? entries.slice(0, limit) : entries;
  const entryLogic = getEntryLogic(config);
  const matchScope = getMatchScope(config);
  if (!pool.length) {
    return { matches: [], passed: false, poolCount: 0 };
  }

  const matches = pool.filter((entry) => {
    if (entryLogic === 'and') {
      return conditions.every((condition) => evaluate(resolveEntryMetric(entry, condition.metric), condition.op, condition.value));
    }

    return conditions.some((condition) => evaluate(resolveEntryMetric(entry, condition.metric), condition.op, condition.value));
  }).map((entry) => ({
    ...entry,
    source_output_key: dimension
  }));

  const passed = matchScope === 'all'
    ? matches.length === pool.length
    : matches.length > 0;

  return {
    matches,
    passed,
    poolCount: pool.length
  };
}

function getEntryLogic(config = {}) {
  if (config.entry_logic === 'and' || config.entry_logic === 'or') {
    return config.entry_logic;
  }

  return config.mode === 'all' ? 'and' : 'or';
}

function getMatchScope(config = {}) {
  return config.match_scope === 'all' ? 'all' : 'any';
}

function getBreakdownEntryLogic(config = {}) {
  return config.entry_logic === 'or' ? 'or' : 'and';
}

function evaluateBreakdownRule(config, breakdowns = {}, mode = 'any') {
  const { dimension, conditions = [], limit } = config || {};
  if (!dimension || !Array.isArray(conditions) || conditions.length === 0) {
    return false;
  }

  const entries = Array.isArray(breakdowns?.[dimension]) ? breakdowns[dimension] : [];
  const pool = typeof limit === 'number' ? entries.slice(0, limit) : entries;
  const entryLogic = getBreakdownEntryLogic(config);
  if (pool.length === 0) return false;

  for (const entry of pool) {
    const entryMatched = entryLogic === 'or'
      ? conditions.some((condition) => evaluate(resolveEntryMetric(entry, condition.metric), condition.op, condition.value))
      : conditions.every((condition) => evaluate(resolveEntryMetric(entry, condition.metric), condition.op, condition.value));

    if (entryMatched) {
      if (mode === 'any') {
        return {
          ...entry,
          source_output_key: dimension
        };
      }
      continue;
    }

    if (mode === 'all') {
      return false;
    }
  }

  if (mode === 'all') {
    return {
      source_output_key: dimension,
      count: pool.length
    };
  }

  return null;
}

function resolveEntryMetric(entry, metric) {
  if (!entry || !metric) return undefined;

  if (entry.deltas && metric in entry.deltas) return entry.deltas[metric];
  if (entry.current && metric in entry.current) return entry.current[metric];
  if (entry.baseline && metric in entry.baseline) return entry.baseline[metric];
  if (metric in entry) return entry[metric];

  return undefined;
}

function checkCondition(condition, metrics) {
    const { metric, op, value } = condition;
    if (!(metric in metrics)) {
        return false;
    }
    const metricValue = metrics[metric];
    return evaluate(metricValue, op, value);
}

function evaluate(left, op, right) {
  // Convert right (from JSON config) to number for numeric comparisons
  const numRight = typeof right === 'string' ? parseFloat(right) : right;
  const numLeft = typeof left === 'number' ? left : parseFloat(left);
  
  // Handle NaN cases
  if (isNaN(numLeft) || isNaN(numRight)) {
    // Fall back to string comparison for non-numeric values
    switch (op) {
      case '==':
        return left == right;
      case '!=':
        return left != right;
      default:
        return false;
    }
  }
  
  switch (op) {
    case '>':
      return numLeft > numRight;
    case '>=':
      return numLeft >= numRight;
    case '<':
      return numLeft < numRight;
    case '<=':
      return numLeft <= numRight;
    case '==':
      return numLeft === numRight;
    case '!=':
      return numLeft !== numRight;
    default:
      return false;
  }
}
