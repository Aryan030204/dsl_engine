const SQL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseSqlDateTime(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace('T', ' ').replace('Z', '');
  const match = normalized.match(SQL_DATETIME_RE);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

function toUtcMs(parts) {
  if (!parts) return NaN;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

function isHourAligned(value) {
  const parts = typeof value === 'string' ? parseSqlDateTime(value) : value;
  return Boolean(parts) && parts.minute === 0 && parts.second === 0;
}

export function isFullDayAlignedWindow(start, end) {
  const startParts = typeof start === 'string' ? parseSqlDateTime(start) : start;
  const endParts = typeof end === 'string' ? parseSqlDateTime(end) : end;
  if (!startParts || !endParts) return false;
  if (!isHourAligned(startParts) || !isHourAligned(endParts)) return false;
  if (startParts.hour !== 0 || endParts.hour !== 0) return false;

  const durationMs = toUtcMs(endParts) - toUtcMs(startParts);
  if (durationMs <= 0) return false;

  const durationHours = durationMs / (60 * 60 * 1000);
  return Number.isInteger(durationHours) && durationHours % 24 === 0;
}

export function isPartialDayWindow(start, end) {
  const startParts = typeof start === 'string' ? parseSqlDateTime(start) : start;
  const endParts = typeof end === 'string' ? parseSqlDateTime(end) : end;
  if (!startParts || !endParts) return false;
  if (!isHourAligned(startParts) || !isHourAligned(endParts)) return false;
  return !isFullDayAlignedWindow(startParts, endParts);
}

function getRecursiveDimensions(node) {
  if (!node || node.type !== 'recursive_dimension_breakdown') return [];
  if (Array.isArray(node.dimensions) && node.dimensions.length) {
    return node.dimensions.filter((dimension) => typeof dimension === 'string' && dimension.trim() !== '');
  }
  if (typeof node.dimension === 'string' && node.dimension.trim() !== '') {
    return [node.dimension];
  }
  return [];
}

function getReachableDepthCount(node, dimensionCount) {
  const maxDepth = Number(node?.stop_conditions?.max_depth);
  if (Number.isInteger(maxDepth) && maxDepth > 0) {
    return Math.min(maxDepth, dimensionCount);
  }
  return Math.min(1, dimensionCount);
}

export function getPartialDayProductCompatibilityErrors(workflowJson) {
  if (!workflowJson || !Array.isArray(workflowJson.nodes)) return [];

  const errors = [];

  workflowJson.nodes.forEach((node) => {
    if (node?.type !== 'recursive_dimension_breakdown') return;

    const dimensions = getRecursiveDimensions(node);
    if (!dimensions.length) return;

    const reachableDepthCount = getReachableDepthCount(node, dimensions.length);
    const productIndex = dimensions.indexOf('product_id');
    if (productIndex === -1 || productIndex >= reachableDepthCount || productIndex === 0) {
      return;
    }

    const precedingDimensions = dimensions.slice(0, productIndex).filter((dimension) => dimension !== 'product_id');
    if (!precedingDimensions.length) return;

    errors.push(
      `Node "${node.id}" cannot support partial-day product analysis because product_id appears after ${precedingDimensions.join(', ')}. Put product_id first or reduce max depth below ${productIndex + 1}.`
    );
  });

  return errors;
}

export function getPartialDayLandingPagePathCompatibilityErrors(workflowJson) {
  if (!workflowJson || !Array.isArray(workflowJson.nodes)) return [];

  const errors = [];

  workflowJson.nodes.forEach((node) => {
    if (node?.type !== 'recursive_dimension_breakdown') return;

    const dimensions = getRecursiveDimensions(node);
    if (!dimensions.length) return;

    const reachableDepthCount = getReachableDepthCount(node, dimensions.length);
    const landingPathIndex = dimensions.indexOf('landing_page_path');
    if (landingPathIndex === -1 || landingPathIndex >= reachableDepthCount || landingPathIndex === 0) {
      return;
    }

    const precedingDimensions = dimensions
      .slice(0, landingPathIndex)
      .filter((dimension) => dimension !== 'product_id');
    if (!precedingDimensions.length) return;

    errors.push(
      `Node "${node.id}" cannot support partial-day landing page path analysis because landing_page_path appears after ${precedingDimensions.join(', ')}. Put landing_page_path first, only precede it with product_id, or reduce max depth below ${landingPathIndex + 1}.`
    );
  });

  return errors;
}

export function getNodePartialDayProductWarnings(nodeData) {
  if (!nodeData || nodeData.type !== 'recursive_dimension_breakdown') return [];
  return [
    ...getPartialDayProductCompatibilityErrors({ nodes: [nodeData] }),
    ...getPartialDayLandingPagePathCompatibilityErrors({ nodes: [nodeData] }),
  ];
}

export function validateRunDateRanges({ windowStart, windowEnd, baselineStart, baselineEnd }) {
  const errors = [];
  const ranges = [
    { label: 'Analysis window', start: windowStart, end: windowEnd },
    { label: 'Baseline window', start: baselineStart, end: baselineEnd },
  ];

  for (const range of ranges) {
    if (!range.start || !range.end) {
      errors.push(`${range.label} start and end are required.`);
      continue;
    }

    const startParts = parseSqlDateTime(range.start);
    const endParts = parseSqlDateTime(range.end);
    if (!startParts || !endParts) {
      errors.push(`${range.label} must use a valid date and hour.`);
      continue;
    }

    if (!isHourAligned(startParts) || !isHourAligned(endParts)) {
      errors.push(`${range.label} must be aligned to the hour. Minutes and seconds must be 00.`);
    }

    if (toUtcMs(endParts) <= toUtcMs(startParts)) {
      errors.push(`${range.label} end must be after start.`);
    }
  }

  return errors;
}

// Inventory numbers only exist once an inventory-mode breakdown node has run, so a report that
// shows them (the inventory section, a metrics.inventory_* card, or the lowest-DOH table) must
// come after that node in the workflow. Mirrors the server-side check.
const DEFAULT_INVENTORY_OUTPUT_KEY = 'inventory_top_products';

function successorIds(node) {
  const ids = [];
  if (node?.next) ids.push(node.next);
  (Array.isArray(node?.rules) ? node.rules : []).forEach((rule) => { if (rule?.then) ids.push(rule.then); });
  if (node?.default?.then) ids.push(node.default.then);
  if (Array.isArray(node?.steps)) ids.push(...node.steps);
  return ids;
}

function reportReadsInventoryData(node, inventoryOutputKeys) {
  const template = node.template || {};
  if (template.includeInventory === true) return true;
  if (template.inventory?.enabled === true) return true;
  const paths = (Array.isArray(template.metrics) ? template.metrics : [])
    .flatMap((metric) => [metric?.value, metric?.change])
    .filter((path) => typeof path === 'string');
  if (paths.some((path) => path.startsWith('metrics.inventory_'))) return true;
  const sources = new Set();
  [...inventoryOutputKeys, DEFAULT_INVENTORY_OUTPUT_KEY].forEach((key) => {
    sources.add(`breakdowns.${key}`);
    sources.add(`breakdowns.${key}_lowest_doh`);
  });
  return (Array.isArray(template.tables) ? template.tables : []).some((table) => sources.has(table?.source));
}

export function getInventorySectionErrors(workflowJson) {
  const nodes = Array.isArray(workflowJson?.nodes) ? workflowJson.nodes.filter(Boolean) : [];
  const inventoryNodes = nodes.filter((node) => node.analysis_mode === 'inventory');
  const inventoryOutputKeys = inventoryNodes.map((node) => (
    typeof node.output_key === 'string' && node.output_key.trim() ? node.output_key.trim() : DEFAULT_INVENTORY_OUTPUT_KEY
  ));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const reachable = new Set();
  const queue = [];
  inventoryNodes.forEach((node) => {
    queue.push(node.id);
    nodes.filter((other) => Array.isArray(other.steps) && other.steps.includes(node.id)).forEach((other) => queue.push(other.id));
  });
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    successorIds(byId.get(id)).forEach((nextId) => { if (byId.has(nextId)) queue.push(nextId); });
  }

  const errors = [];
  nodes.forEach((node) => {
    if ((node.type !== 'email' && node.type !== 'messaging') || node.format !== 'report') return;
    if (!reportReadsInventoryData(node, inventoryOutputKeys)) return;
    if (!inventoryNodes.length) {
      errors.push(`"${node.id}" shows inventory data, but the workflow has no Dimension Breakdown node in "Inventory coverage" mode.`);
    } else if (!reachable.has(node.id)) {
      errors.push(`"${node.id}" shows inventory data but runs before the inventory breakdown node. Connect it after that node.`);
    }
  });
  return errors;
}
