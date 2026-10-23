// Email Configurations panel: who receives which workflow's emails, plus per-person settings.
// Recipient lists stay inside the workflow definitions (the source of truth for who is ON a workflow);
// the per-person settings live in EmailRecipientPreference and are applied when an email is sent
// (server/services/recipientPolicy.js). Editing who is on a workflow saves a NEW workflow version.
const { collectRecipients, addRecipient, removeRecipient, normalizeEmail } = require('../lib/notifierNodes');
const { validateWorkflowDefinition } = require('../validation/workflowDefinition');
const {
  buildWorkflowVersionQuery,
  getVersionTenantId,
  getWorkflowTenantIds
} = require('./workflowResolverService');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class EmailConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EmailConfigError';
    this.status = status;
  }
}

function defaultModels() {
  return {
    Workflow: require('../models/Workflow'),
    WorkflowVersion: require('../models/WorkflowVersion'),
    User: require('../models/User'),
    Preference: require('../models/EmailRecipientPreference'),
    Event: require('../models/EmailConfigEvent')
  };
}

const workflowKeyOf = (workflow) => String(workflow._id);
const isSharedWorkflow = (workflow) => workflow.scope === 'global'
  || (Array.isArray(workflow.tenantIds) && workflow.tenantIds.length > 0);

// A mute applies to one tenant's workflow, or to every tenant for global / multi-tenant workflows.
const muteTenantOf = (workflow) => (isSharedWorkflow(workflow) ? null : workflow.tenantId || null);

// 1.7 -> 1.8. If that version already exists, keep counting.
function nextVersionAfter(version) {
  const parts = String(version || '1.0').split('.');
  return { major: parts[0] || '1', minor: parseInt(parts[1] || '0', 10) || 0 };
}

function createEmailConfigService({ models, onChange = () => {} } = {}) {
  const m = models || defaultModels();

  async function loadActiveWorkflows() {
    const workflows = await m.Workflow.find({ isActive: true }).lean();
    const loaded = await Promise.all(workflows.map(async (workflow) => {
      const version = await m.WorkflowVersion.findOne(
        buildWorkflowVersionQuery(workflow, workflow.workflowId, workflow.latestVersion)
      ).lean();
      return { workflow, definition: version?.definitionJson || null };
    }));
    return loaded.filter((item) => item.definition);
  }

  const describeWorkflow = ({ workflow, definition }) => ({
    key: workflowKeyOf(workflow),
    workflowId: workflow.workflowId,
    name: workflow.name || definition.name || workflow.workflowId,
    scope: workflow.scope || 'tenant',
    tenantId: workflow.tenantId || null,
    tenantIds: workflow.tenantIds || [],
    version: workflow.latestVersion,
    alertState: Boolean(definition.state_config?.enabled),
    purpose: definition.workflow_purpose || 'rca'
  });

  function isMutedFor(preference, workflow) {
    const tenantId = muteTenantOf(workflow);
    return (preference?.mutedWorkflows || []).some((entry) => entry.workflowId === workflow.workflowId
      && (entry.tenantId == null ? tenantId == null : entry.tenantId === tenantId));
  }

  const preferenceSummary = (preference) => ({
    paused: Boolean(preference?.paused),
    pausedUntil: preference?.pausedUntil || null,
    severityMin: preference?.severityMin || 'TRIGGERED',
    mutedCount: (preference?.mutedWorkflows || []).length,
    updatedBy: preference?.updatedBy || null,
    updatedAt: preference?.updatedAt || null
  });

  async function loadPeopleContext() {
    const [loaded, users, preferences] = await Promise.all([
      loadActiveWorkflows(),
      m.User.find({}).select('name email').lean(),
      m.Preference.find({}).lean()
    ]);
    return {
      loaded,
      userByEmail: new Map(users.map((user) => [normalizeEmail(user.email), user])),
      preferenceByEmail: new Map(preferences.map((pref) => [normalizeEmail(pref.email), pref]))
    };
  }

  // Everyone who is on at least one active workflow, plus every app user (so they can be added).
  async function listRecipients() {
    const { loaded, userByEmail, preferenceByEmail } = await loadPeopleContext();
    const people = new Map();
    const ensure = (email) => {
      if (!people.has(email)) people.set(email, { email, workflows: [] });
      return people.get(email);
    };

    for (const item of loaded) {
      for (const [email] of collectRecipients(item.definition)) {
        ensure(email).workflows.push(item.workflow);
      }
    }
    for (const email of userByEmail.keys()) ensure(email);
    for (const email of preferenceByEmail.keys()) ensure(email);

    return [...people.values()]
      .map((person) => {
        const preference = preferenceByEmail.get(person.email);
        const tenants = new Set();
        person.workflows.forEach((workflow) => {
          if (workflow.scope === 'global') tenants.add('GLOBAL');
          (workflow.tenantIds || []).forEach((id) => tenants.add(id));
          if (workflow.tenantId) tenants.add(workflow.tenantId);
        });
        return {
          email: person.email,
          name: userByEmail.get(person.email)?.name || null,
          isAppUser: userByEmail.has(person.email),
          workflowCount: person.workflows.length,
          tenants: [...tenants].sort(),
          ...preferenceSummary(preference)
        };
      })
      .sort((a, b) => b.workflowCount - a.workflowCount || a.email.localeCompare(b.email));
  }

  async function recentEvents(email, limit = 20) {
    const rows = await m.Event.find(email ? { email } : {}).sort({ at: -1 }).limit(limit).lean();
    return rows.map((row) => ({ at: row.at, by: row.by, email: row.email, action: row.action, details: row.details }));
  }

  async function getRecipient(rawEmail) {
    const email = requireEmail(rawEmail);
    const { loaded, userByEmail, preferenceByEmail } = await loadPeopleContext();
    const preference = preferenceByEmail.get(email) || null;

    const on = [];
    const available = [];
    for (const item of loaded) {
      const nodes = collectRecipients(item.definition).get(email);
      const base = describeWorkflow(item);
      if (nodes) {
        on.push({ ...base, nodes, muted: isMutedFor(preference, item.workflow) });
      } else {
        available.push(base);
      }
    }
    const byName = (a, b) => (a.tenantId || '').localeCompare(b.tenantId || '') || a.name.localeCompare(b.name);

    return {
      email,
      name: userByEmail.get(email)?.name || null,
      isAppUser: userByEmail.has(email),
      preferences: preferenceSummary(preference),
      workflows: on.sort(byName),
      availableWorkflows: available.sort(byName),
      events: await recentEvents(email)
    };
  }

  // Reverse view: every active workflow with its recipients and their status.
  async function listWorkflows() {
    const { loaded, userByEmail, preferenceByEmail } = await loadPeopleContext();
    return loaded.map((item) => {
      const recipients = [...collectRecipients(item.definition).entries()].map(([email, nodes]) => {
        const preference = preferenceByEmail.get(email) || null;
        return {
          email,
          name: userByEmail.get(email)?.name || null,
          nodes,
          muted: isMutedFor(preference, item.workflow),
          paused: Boolean(preference?.paused && (!preference.pausedUntil || new Date(preference.pausedUntil) > new Date())),
          severityMin: preference?.severityMin || 'TRIGGERED'
        };
      }).sort((a, b) => a.email.localeCompare(b.email));
      return { ...describeWorkflow(item), recipients };
    }).sort((a, b) => (a.tenantId || '').localeCompare(b.tenantId || '') || a.name.localeCompare(b.name));
  }

  function requireEmail(raw) {
    const email = normalizeEmail(raw);
    if (!EMAIL_REGEX.test(email)) throw new EmailConfigError('a valid email address is required');
    return email;
  }

  async function log(by, email, action, details = null) {
    await m.Event.create({ by: by || null, email, action, details });
  }

  async function updatePreferences(rawEmail, patch = {}, by = null) {
    const email = requireEmail(rawEmail);
    const set = {};

    if (patch.paused !== undefined) {
      if (typeof patch.paused !== 'boolean') throw new EmailConfigError('paused must be true or false');
      set.paused = patch.paused;
      // un-pausing also clears the resume date
      if (!patch.paused) set.pausedUntil = null;
    }
    if (patch.pausedUntil !== undefined && patch.paused !== false) {
      if (patch.pausedUntil === null || patch.pausedUntil === '') {
        set.pausedUntil = null;
      } else {
        const until = new Date(patch.pausedUntil);
        if (Number.isNaN(until.getTime())) throw new EmailConfigError('pausedUntil must be a valid date');
        set.pausedUntil = until;
      }
    }
    if (patch.severityMin !== undefined) {
      if (!['TRIGGERED', 'CRITICAL'].includes(patch.severityMin)) {
        throw new EmailConfigError('severityMin must be TRIGGERED or CRITICAL');
      }
      set.severityMin = patch.severityMin;
    }
    if (!Object.keys(set).length) throw new EmailConfigError('nothing to update');
    set.updatedBy = by || null;

    const saved = await m.Preference.findOneAndUpdate(
      { email },
      { $set: set, $setOnInsert: { email } },
      { new: true, upsert: true }
    ).lean();

    await log(by, email, 'preferences_updated', set);
    onChange();
    return preferenceSummary(saved);
  }

  async function findWorkflowByKey(key) {
    const workflow = await m.Workflow.findById(key).lean();
    if (!workflow) throw new EmailConfigError(`workflow ${key} not found`, 404);
    return workflow;
  }

  async function setMute(rawEmail, workflowKey, muted, by = null) {
    const email = requireEmail(rawEmail);
    if (typeof muted !== 'boolean') throw new EmailConfigError('muted must be true or false');
    const workflow = await findWorkflowByKey(workflowKey);
    const entry = { tenantId: muteTenantOf(workflow), workflowId: workflow.workflowId };

    // pull any existing entry for this workflow first, so the list never holds duplicates
    await m.Preference.updateOne(
      { email },
      { $pull: { mutedWorkflows: { workflowId: entry.workflowId, tenantId: entry.tenantId } } }
    );
    if (muted) {
      await m.Preference.updateOne(
        { email },
        { $push: { mutedWorkflows: { ...entry, mutedAt: new Date() } }, $set: { updatedBy: by || null }, $setOnInsert: { email } },
        { upsert: true }
      );
    }

    await log(by, email, muted ? 'workflow_muted' : 'workflow_unmuted', { workflowId: entry.workflowId, tenantId: entry.tenantId, workflow: workflow.name });
    onChange();
    return { muted };
  }

  async function saveNewVersion(workflow, definition) {
    const current = nextVersionAfter(workflow.latestVersion || definition.version);
    let minor = current.minor + 1;
    let version = `${current.major}.${minor}`;
    for (let guard = 0; guard < 50; guard += 1) {
      const taken = await m.WorkflowVersion.findOne(buildWorkflowVersionQuery(workflow, workflow.workflowId, version)).lean();
      if (!taken) break;
      minor += 1;
      version = `${current.major}.${minor}`;
    }

    const next = { ...definition, version, workflow_id: workflow.workflowId };
    const { ok, errors } = validateWorkflowDefinition(next);
    if (!ok) throw new EmailConfigError(`workflow no longer validates: ${errors.join('; ')}`, 422);

    const global = workflow.scope === 'global';
    await m.WorkflowVersion.create({
      tenantId: global ? null : getVersionTenantId(workflow),
      tenantIds: global ? [] : getWorkflowTenantIds(workflow),
      scope: workflow.scope || 'tenant',
      workflowId: workflow.workflowId,
      version,
      definitionJson: next
    });
    await m.Workflow.updateOne({ _id: workflow._id }, { $set: { latestVersion: version } });
    return version;
  }

  // Adds / removes one person on a list of workflows. Each workflow that changes gets a new version.
  async function applyWorkflowChanges(rawEmail, { add = [], remove = [] } = {}, by = null) {
    const email = requireEmail(rawEmail);
    const results = [];

    const run = async (key, change) => {
      try {
        const workflow = await findWorkflowByKey(key);
        const version = await m.WorkflowVersion.findOne(
          buildWorkflowVersionQuery(workflow, workflow.workflowId, workflow.latestVersion)
        ).lean();
        if (!version?.definitionJson) throw new EmailConfigError('workflow has no definition', 404);

        const { definition, changed } = change === 'add'
          ? addRecipient(version.definitionJson, email)
          : removeRecipient(version.definitionJson, email);
        if (change === 'add' && !changed && !collectRecipients(version.definitionJson).has(email)) {
          throw new EmailConfigError('this workflow has no email notification node to add a recipient to');
        }
        if (!changed) {
          results.push({ key, name: workflow.name, change, changed: false, version: workflow.latestVersion });
          return;
        }

        const saved = await saveNewVersion(workflow, definition);
        if (change === 'remove') {
          await m.Preference.updateOne(
            { email },
            { $pull: { mutedWorkflows: { workflowId: workflow.workflowId, tenantId: muteTenantOf(workflow) } } }
          );
        }
        await log(by, email, change === 'add' ? 'added_to_workflow' : 'removed_from_workflow',
          { workflowId: workflow.workflowId, tenantId: workflow.tenantId || null, workflow: workflow.name, version: saved });
        results.push({ key, name: workflow.name, change, changed: true, version: saved });
      } catch (error) {
        results.push({ key, change, changed: false, error: error.message });
      }
    };

    for (const key of add) await run(key, 'add');
    for (const key of remove) await run(key, 'remove');
    onChange();
    return results;
  }

  return {
    listRecipients,
    getRecipient,
    listWorkflows,
    updatePreferences,
    setMute,
    applyWorkflowChanges,
    recentEvents
  };
}

module.exports = { createEmailConfigService, EmailConfigError, nextVersionAfter };
