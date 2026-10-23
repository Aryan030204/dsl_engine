// Where a workflow definition keeps its email recipients, in one place:
//   - email nodes                         -> node.to
//   - insight nodes with Email Insight on  -> node.email.to
//   - messaging nodes with the email channel on -> node.email.to
// Used by the Email Configurations panel to find (and edit) who is on a workflow.

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

// Returns [{ node, nodeId, type, list }] where `list` is the live recipients array of that node
// (or null when the node can hold recipients but has none yet).
function listNotifierNodes(definition = {}) {
  const found = [];
  for (const node of definition.nodes || []) {
    if (node.type === 'email') {
      found.push({ node, nodeId: node.id, type: 'email', list: Array.isArray(node.to) ? node.to : null, path: 'to' });
    } else if (node.type === 'insight' && node.email?.enabled) {
      found.push({ node, nodeId: node.id, type: 'insight', list: Array.isArray(node.email.to) ? node.email.to : null, path: 'email.to' });
    } else if (node.type === 'messaging' && node.channels?.email) {
      found.push({ node, nodeId: node.id, type: 'messaging', list: Array.isArray(node.email?.to) ? node.email.to : null, path: 'email.to' });
    }
  }
  return found;
}

// Every distinct address (lower-cased) on the workflow, with the nodes that send to it.
function collectRecipients(definition = {}) {
  const byEmail = new Map();
  for (const entry of listNotifierNodes(definition)) {
    for (const raw of entry.list || []) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push({ nodeId: entry.nodeId, type: entry.type });
    }
  }
  return byEmail;
}

function setList(node, path, list) {
  if (path === 'to') node.to = list;
  else node.email = { ...(node.email || {}), to: list };
}

// Returns a deep copy of the definition with `email` added to every notifier node that doesn't have
// it yet (or only to `nodeIds`). `changed` says whether anything was added.
function addRecipient(definition, email, { nodeIds = null } = {}) {
  const copy = JSON.parse(JSON.stringify(definition));
  const target = normalizeEmail(email);
  let changed = false;
  for (const entry of listNotifierNodes(copy)) {
    if (nodeIds && !nodeIds.includes(entry.nodeId)) continue;
    const list = entry.list || [];
    if (list.some((existing) => normalizeEmail(existing) === target)) continue;
    setList(entry.node, entry.path, [...list, String(email).trim()]);
    changed = true;
  }
  return { definition: copy, changed };
}

// Returns a deep copy without `email` in any notifier node. Matching ignores case.
function removeRecipient(definition, email) {
  const copy = JSON.parse(JSON.stringify(definition));
  const target = normalizeEmail(email);
  let changed = false;
  for (const entry of listNotifierNodes(copy)) {
    const list = entry.list || [];
    const next = list.filter((existing) => normalizeEmail(existing) !== target);
    if (next.length !== list.length) {
      setList(entry.node, entry.path, next);
      changed = true;
    }
  }
  return { definition: copy, changed };
}

module.exports = { normalizeEmail, listNotifierNodes, collectRecipients, addRecipient, removeRecipient };
