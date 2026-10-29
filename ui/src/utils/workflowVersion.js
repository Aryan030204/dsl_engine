// The version number for the next save of a workflow: one minor step above the NEWEST version known to the page.
// Looking only at the "version" written inside the latest definition is not enough: it can lag behind the version
// the workflow really is at (an older save, an import, a restored version), and then every save asks for a number
// that already exists. So the workflow's own latestVersion and every listed version are considered too.

function parseParts(value) {
  return String(value ?? '').split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

export function compareWorkflowVersions(a, b) {
  const left = parseParts(a);
  const right = parseParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function nextWorkflowVersion({ latestVersion, definitionVersion, versions = [] } = {}) {
  const known = [latestVersion, definitionVersion, ...(Array.isArray(versions) ? versions.map((entry) => entry?.version ?? entry) : [])]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const newest = known.reduce((best, value) => (best === null || compareWorkflowVersions(value, best) > 0 ? String(value) : best), null) ?? '1.0';
  const parts = parseParts(newest);
  return `${parts[0]}.${(parts[1] ?? 0) + 1}`;
}
