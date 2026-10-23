// Per-person email rules applied at send time (Email Configurations panel). The recipient lists inside
// workflow definitions decide who is ON a workflow; these rules decide, per person, whether a send
// actually reaches them:
//   - paused           (optionally until a date)
//   - muted workflow   (this workflow, or this workflow for this tenant)
//   - severity minimum (CRITICAL only; applies when the send has a severity, i.e. alert-state workflows)
// If the preference store is unavailable the send goes out unfiltered: a database problem must never
// swallow an alert.
const { normalizeEmail } = require('../lib/notifierNodes');

const SEVERITY_RANK = { TRIGGERED: 1, CRITICAL: 2 };
const DEFAULT_CACHE_MS = 30 * 1000;

function createMongoPreferenceStore() {
  const EmailRecipientPreference = require('../models/EmailRecipientPreference');
  return {
    async findByEmails(emails) {
      return EmailRecipientPreference.find({ email: { $in: emails } }).lean();
    }
  };
}

// Why this person should NOT receive the send, or null when they should.
function suppressionReason(preference, { tenantId, workflowId, severity, now }) {
  if (!preference) return null;

  if (preference.paused) {
    const until = preference.pausedUntil ? new Date(preference.pausedUntil) : null;
    if (!until || until.getTime() > now.getTime()) return 'paused';
  }

  const muted = (preference.mutedWorkflows || []).some((entry) => entry.workflowId === workflowId
    && (entry.tenantId == null || entry.tenantId === tenantId));
  if (muted) return 'workflow_muted';

  if (severity && preference.severityMin === 'CRITICAL'
    && (SEVERITY_RANK[severity] || 0) < SEVERITY_RANK.CRITICAL) {
    return 'severity_below_minimum';
  }
  return null;
}

function createRecipientPolicy({ store, now = () => new Date(), cacheMs = DEFAULT_CACHE_MS } = {}) {
  let resolvedStore = store || null;
  const cache = new Map(); // email -> { at, preference }

  const getStore = () => {
    if (!resolvedStore) resolvedStore = createMongoPreferenceStore();
    return resolvedStore;
  };

  async function loadPreferences(emails) {
    const nowMs = now().getTime();
    const missing = emails.filter((email) => {
      const hit = cache.get(email);
      return !hit || nowMs - hit.at > cacheMs;
    });

    if (missing.length) {
      const docs = await getStore().findByEmails(missing);
      const byEmail = new Map(docs.map((doc) => [normalizeEmail(doc.email), doc]));
      for (const email of missing) {
        cache.set(email, { at: nowMs, preference: byEmail.get(email) || null });
      }
    }
    return new Map(emails.map((email) => [email, cache.get(email).preference]));
  }

  // recipients: the addresses a send is addressed to. severity: 'TRIGGERED' | 'CRITICAL' | null.
  async function applyRecipientPreferences({ recipients = [], tenantId = null, workflowId = null, severity = null } = {}) {
    const list = (Array.isArray(recipients) ? recipients : []).map((value) => String(value || '').trim()).filter(Boolean);
    if (!list.length) return { allowed: [], suppressed: [] };

    let preferences;
    try {
      preferences = await loadPreferences([...new Set(list.map(normalizeEmail))]);
    } catch (error) {
      console.warn(`[email-config] preferences unavailable, sending unfiltered: ${error.message}`);
      return { allowed: list, suppressed: [] };
    }

    const allowed = [];
    const suppressed = [];
    const context = { tenantId, workflowId, severity, now: now() };
    for (const recipient of list) {
      const reason = suppressionReason(preferences.get(normalizeEmail(recipient)), context);
      if (reason) suppressed.push({ email: recipient, reason });
      else allowed.push(recipient);
    }
    return { allowed, suppressed };
  }

  // Wraps an email sender for sends that are not held by the state engine (daily insights, RCA without
  // alert state). Everyone opted out => 'skipped' (the nodes treat it as a pass, never a failure).
  function createPreferenceAwareSender(baseSender, { tenantId, workflowId } = {}) {
    return async (message) => {
      const { allowed, suppressed } = await applyRecipientPreferences({ recipients: message?.to, tenantId, workflowId });
      if (!allowed.length) {
        return { status: 'skipped', provider: 'preferences', to: [], subject: message?.subject, suppressed, error: null };
      }
      const result = await baseSender({ ...message, to: allowed });
      return suppressed.length ? { ...result, suppressed } : result;
    };
  }

  const invalidate = () => cache.clear();

  return { applyRecipientPreferences, createPreferenceAwareSender, invalidate, suppressionReason };
}

let defaultPolicy = null;
function getDefaultRecipientPolicy() {
  if (!defaultPolicy) defaultPolicy = createRecipientPolicy();
  return defaultPolicy;
}

module.exports = { createRecipientPolicy, getDefaultRecipientPolicy, suppressionReason };
