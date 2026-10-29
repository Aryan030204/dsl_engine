const WorkflowVersion = require('../models/WorkflowVersion');
const { buildWorkflowVersionQuery } = require('./workflowResolverService');

const CONFLICT_MESSAGE = 'A newer version of this workflow was already saved (version {latest}). '
  + 'Reload the page to continue from the latest version, then save again.';

// "1.10" > "1.9": compare dotted versions part by part as numbers, falling back to text for odd values.
function compareVersions(a, b) {
  const left = String(a).split('.');
  const right = String(b).split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number(left[i] ?? 0);
    const y = Number(right[i] ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x !== y) return x < y ? -1 : 1;
    } else if ((left[i] ?? '') !== (right[i] ?? '')) {
      return String(left[i] ?? '') < String(right[i] ?? '') ? -1 : 1;
    }
  }
  return 0;
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

function versionConflictError(latestVersion) {
  const error = new Error(CONFLICT_MESSAGE.replace('{latest}', latestVersion));
  error.status = 409;
  error.code = 'workflow_version_conflict';
  error.latestVersion = latestVersion;
  return error;
}

// The newest version that exists for this workflow, whatever the workflow's own pointer says.
async function findHighestVersion(workflow) {
  const versions = await WorkflowVersion.find(buildWorkflowVersionQuery(workflow, workflow.workflowId))
    .select('version')
    .lean();
  return versions.reduce((best, entry) => (best == null || compareVersions(entry.version, best) > 0 ? entry.version : best), null);
}

// Stores a new version and moves the workflow's latestVersion to it.
//  - A version number that already exists is a conflict (409), not a server error: the page was working
//    from an out-of-date copy, or the same save was sent twice. If the workflow's latestVersion was left
//    behind by an earlier half-finished save, it is moved up to the newest version that exists, so a reload
//    shows the right version.
//  - If updating the workflow fails after the version was stored, the new version is removed again, so a
//    failed save never leaves a version the workflow does not point to.
async function saveNewVersion({ workflow, versionFields, version, name }) {
  let created;
  try {
    created = await WorkflowVersion.create({ ...versionFields, version });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const highest = (await findHighestVersion(workflow)) || version;
    if (compareVersions(highest, workflow.latestVersion) > 0) {
      workflow.latestVersion = highest;
      await workflow.save();
    }
    throw versionConflictError(highest);
  }

  try {
    workflow.latestVersion = version;
    // Keep the display name in sync with the latest definition name (if provided)
    if (name) workflow.name = name;
    await workflow.save();
  } catch (error) {
    await WorkflowVersion.deleteOne({ _id: created._id }).catch(() => {});
    throw error;
  }
  return created;
}

module.exports = { saveNewVersion, compareVersions, findHighestVersion, versionConflictError, isDuplicateKeyError };
