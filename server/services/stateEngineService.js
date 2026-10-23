const { normalizeStateConfig, isAutomaticTrigger } = require('../lib/stateEngine/defaults');
const { resolveFindingValue } = require('../lib/stateEngine/severity');
const { evaluateState } = require('../lib/stateEngine/evaluateState');
const { renderStateEmail } = require('../lib/renderStateEmail');

const DEFAULT_MAX_CAS_ATTEMPTS = 5;

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameInstant(a, b) {
  return toIso(a) === toIso(b);
}

// Mongo-backed store used in production. Tests inject an in-memory fake with this
// same shape (same DI idiom as EmailNode's runtime.emailSender), so the concurrency
// and idempotency logic below is testable without a database.
function createMongoStateStore() {
  const WorkflowState = require('../models/WorkflowState');
  const WorkflowStateEvaluation = require('../models/WorkflowStateEvaluation');

  return {
    async getState(tenantId, workflowId) {
      return WorkflowState.findOne({ tenantId, workflowId }).lean();
    },
    // First write for a (tenant, workflow). The unique index makes a concurrent
    // first write lose cleanly, and the caller re-reads and retries as a CAS.
    async insertState(doc) {
      try {
        await WorkflowState.create(doc);
        return true;
      } catch (error) {
        if (error && error.code === 11000) return false;
        throw error;
      }
    },
    async compareAndSetState(tenantId, workflowId, expectedVersion, fields) {
      const result = await WorkflowState.updateOne(
        { tenantId, workflowId, version: expectedVersion },
        { $set: fields, $inc: { version: 1 } }
      );
      return result.matchedCount === 1;
    },
    async getEvaluation(tenantId, workflowId, executionId) {
      return WorkflowStateEvaluation.findOne({ tenantId, workflowId, executionId }).lean();
    },
    // Returns whichever row owns this execution -- ours, or the one an earlier
    // attempt already wrote.
    async insertEvaluation(row) {
      try {
        const created = await WorkflowStateEvaluation.create(row);
        return created.toObject();
      } catch (error) {
        if (error && error.code === 11000) {
          return WorkflowStateEvaluation.findOne({
            tenantId: row.tenantId, workflowId: row.workflowId, executionId: row.executionId
          }).lean();
        }
        throw error;
      }
    },
    async claimDelivery(tenantId, workflowId, executionId) {
      return WorkflowStateEvaluation.findOneAndUpdate(
        { tenantId, workflowId, executionId, 'delivery.status': 'pending' },
        { $set: { 'delivery.status': 'sending' } },
        { new: true }
      ).lean();
    },
    async updateDelivery(tenantId, workflowId, executionId, fields) {
      const $set = {};
      Object.entries(fields).forEach(([key, value]) => { $set[`delivery.${key}`] = value; });
      await WorkflowStateEvaluation.updateOne({ tenantId, workflowId, executionId }, { $set });
    },
    async listEvaluations(tenantId, workflowId, limit = 20) {
      return WorkflowStateEvaluation.find({ tenantId, workflowId })
        .sort({ executed_at: -1 })
        .limit(limit)
        .lean();
    }
  };
}

function deliveryStatusFor(decision) {
  if (decision.notification.should_send) return 'pending';
  return decision.notification.candidate_reason ? 'suppressed' : 'none';
}

function buildEvaluationRow({ tenantId, workflowId, executionId, decision }) {
  return {
    tenantId,
    workflowId,
    executionId,
    executed_at: decision.evaluated_at,
    trigger_type: decision.trigger_type,
    automatic: decision.automatic,
    conclusive: true,
    previous_state: decision.previous_state,
    resulting_state: decision.resulting_state,
    finding: decision.finding,
    notification: decision.notification,
    cooldown: decision.cooldown,
    quiet_hours: decision.quiet_hours,
    decision,
    delivery: { status: deliveryStatusFor(decision) }
  };
}

function buildInconclusiveRow({ tenantId, workflowId, executionId, triggerType, automatic, finding, currentState, evaluatedAt }) {
  return {
    tenantId,
    workflowId,
    executionId,
    executed_at: evaluatedAt,
    trigger_type: triggerType || null,
    automatic,
    conclusive: false,
    previous_state: currentState,
    resulting_state: currentState,
    finding: { metric: finding.metric, value: null },
    notification: { candidate_reason: null, should_send: false, reason: null, suppressed_by: null },
    decision: null,
    delivery: { status: 'none' }
  };
}

function summarize(evaluation, delivery) {
  if (!evaluation) return null;
  return {
    conclusive: evaluation.conclusive !== false,
    previous_state: evaluation.previous_state,
    resulting_state: evaluation.resulting_state,
    trigger_type: evaluation.trigger_type,
    finding: evaluation.finding,
    notification: evaluation.notification,
    delivery_status: delivery?.status || evaluation.delivery?.status || 'none',
    delivery_error: delivery?.error || evaluation.delivery?.error || null,
    telegram_status: delivery?.telegram?.status || evaluation.delivery?.telegram?.status || null,
    telegram_error: delivery?.telegram?.error || evaluation.delivery?.telegram?.error || null,
    delivery_skipped_reason: delivery?.skippedReason || evaluation.delivery?.skipped_reason || null
  };
}

function createStateEngineService({
  store = createMongoStateStore(),
  sender = (...args) => require('./emailService').sendEmail(...args),
  telegramSender = (...args) => require('./telegramService').sendTelegram(...args),
  // Per-person pause / mute / severity rules (server/services/recipientPolicy.js). Null = send to everyone
  // the workflow lists; getDefaultStateEngineService() passes the real policy.
  recipientPolicy = null,
  now = () => new Date(),
  maxCasAttempts = DEFAULT_MAX_CAS_ATTEMPTS
} = {}) {
  // Spec §29 steps 2-6 for one execution. Idempotent per executionId: a retried run
  // (same runId, re-executed from node one) replays the decision it already made
  // instead of transitioning a second time.
  async function applyExecution({ tenantId, workflowId, executionId, triggerType, context, config: rawConfig, timezone = 'UTC' }) {
    if (!tenantId || !workflowId || !executionId) {
      throw new Error('state engine: tenantId, workflowId and executionId are required');
    }
    const config = normalizeStateConfig(rawConfig);

    const existing = await store.getEvaluation(tenantId, workflowId, executionId);
    if (existing) return { evaluation: existing, replayed: true };

    const finding = resolveFindingValue(context, config.finding);
    const evaluatedAt = now();

    if (!finding.conclusive) {
      const current = await store.getState(tenantId, workflowId);
      const evaluation = await store.insertEvaluation(buildInconclusiveRow({
        tenantId, workflowId, executionId, triggerType,
        automatic: isAutomaticTrigger(triggerType),
        finding, currentState: current?.state || 'NORMAL', evaluatedAt: evaluatedAt.toISOString()
      }));
      return { evaluation, replayed: false };
    }

    let decision = null;
    for (let attempt = 0; attempt < maxCasAttempts && !decision; attempt += 1) {
      const current = await store.getState(tenantId, workflowId);

      // This execution already won the state write on an earlier attempt, but its
      // audit row never landed (crash in between) -- rebuild it from the stored decision.
      if (current?.last_execution_id === executionId && current.last_decision) {
        decision = current.last_decision;
        break;
      }

      const candidate = evaluateState({ prior: current, finding, triggerType, now: evaluatedAt, config, timezone });
      const fields = { ...candidate.next, last_execution_id: executionId, last_decision: candidate };

      const written = current
        ? await store.compareAndSetState(tenantId, workflowId, current.version ?? 0, fields)
        : await store.insertState({ tenantId, workflowId, ...fields, version: 1 });

      // Lost the race: another execution changed the state after we read it.
      // Re-read and recompute from its result rather than overwriting it.
      if (written) decision = candidate;
    }

    if (!decision) {
      throw new Error(`state engine: could not update state for ${tenantId}/${workflowId} after ${maxCasAttempts} attempts`);
    }

    const evaluation = await store.insertEvaluation(buildEvaluationRow({ tenantId, workflowId, executionId, decision }));
    return { evaluation, replayed: false };
  }

  // Manual (dry-run) executions: work out what the engine WOULD decide from the current state,
  // without writing anything -- no state change, no cooldown, no audit row, no delivery. This is
  // how a manual run stays a safe preview instead of moving live alert state or emailing people.
  async function previewExecution({ tenantId, workflowId, triggerType, context, config: rawConfig, timezone = 'UTC' }) {
    if (!tenantId || !workflowId) {
      throw new Error('state engine: tenantId and workflowId are required');
    }
    const config = normalizeStateConfig(rawConfig);
    const finding = resolveFindingValue(context, config.finding);
    const current = await store.getState(tenantId, workflowId);

    if (!finding.conclusive) {
      return {
        conclusive: false,
        previous_state: current?.state || 'NORMAL',
        resulting_state: current?.state || 'NORMAL',
        trigger_type: triggerType || null,
        finding: { metric: finding.metric, value: null },
        notification: { candidate_reason: null, should_send: false, reason: null, suppressed_by: null },
        delivery_status: 'dry_run',
        delivery_error: null,
        telegram_status: null,
        telegram_error: null,
        delivery_skipped_reason: null,
        dry_run: true
      };
    }

    const decision = evaluateState({ prior: current, finding, triggerType, now: now(), config, timezone });
    return {
      conclusive: true,
      previous_state: decision.previous_state,
      resulting_state: decision.resulting_state,
      trigger_type: decision.trigger_type,
      finding: decision.finding,
      notification: decision.notification,
      delivery_status: 'dry_run',
      delivery_error: null,
      telegram_status: null,
      telegram_error: null,
      delivery_skipped_reason: null,
      dry_run: true
    };
  }

  // A failed send must not consume the cooldown. Hands back only the notification
  // bookkeeping this execution wrote; the state transition itself always stands.
  // Guarded on last_alert_at and the cooldown start so a later execution's own alert
  // is never undone.
  async function rollbackBookkeeping({ tenantId, workflowId, decision }) {
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const current = await store.getState(tenantId, workflowId);
      if (!current || !sameInstant(current.last_alert_at, decision.next.last_alert_at)) return false;
      if (!sameInstant(current.cooldown?.started_at, decision.next.cooldown?.started_at)) return false;

      const fields = {
        cooldown: decision.prior_bookkeeping.cooldown || null,
        last_alert_at: decision.prior_bookkeeping.last_alert_at || null
      };
      if (await store.compareAndSetState(tenantId, workflowId, current.version ?? 0, fields)) return true;
    }
    return false;
  }

  // Spec §29 steps 10-11, for every channel the run captured (email and Telegram).
  // At-most-once per execution: the row is claimed
  // (pending -> sending) before SMTP, and a retry that finds it still `sending`
  // cannot know whether the provider accepted it, so it records `uncertain` and
  // never resends.
  async function deliver({ evaluation, intents = [], telegramIntents = [], fallbackRecipients = [], workflowName, brandName, branding }) {
    const { tenantId, workflowId, executionId } = evaluation;
    const status = evaluation.delivery?.status;

    if (status === 'sending') {
      await store.updateDelivery(tenantId, workflowId, executionId, { status: 'uncertain' });
      return { status: 'uncertain' };
    }
    if (status !== 'pending') return { status: status || 'none' };

    const claimed = await store.claimDelivery(tenantId, workflowId, executionId);
    if (!claimed) {
      const latest = await store.getEvaluation(tenantId, workflowId, executionId);
      if (latest?.delivery?.status === 'sending') {
        await store.updateDelivery(tenantId, workflowId, executionId, { status: 'uncertain' });
        return { status: 'uncertain' };
      }
      return { status: latest?.delivery?.status || 'none' };
    }

    const decision = claimed.decision || evaluation.decision;

    // The engine decides *whether* the workflow's own notification goes out; it never invents
    // one. If this run's path reached no email/messaging node (a deliberate silent branch such as
    // "CVR is stable"), nothing is sent -- and the cooldown is handed back so the next run that
    // does reach a notifier is not blocked by an alert nobody received.
    if (intents.length === 0 && telegramIntents.length === 0) {
      const rolledBack = await rollbackBookkeeping({ tenantId, workflowId, decision });
      await store.updateDelivery(tenantId, workflowId, executionId, {
        status: 'none',
        skipped_reason: 'no_notification_on_path',
        rolled_back: rolledBack,
        error: null
      });
      return { status: 'none', skippedReason: 'no_notification_on_path', rolledBack, to: [], subject: null, messageId: null, email: null, telegram: null };
    }

    // Email goes out when the run captured one. A run whose only notifier is a Telegram-only
    // messaging node sends Telegram and no email.
    const emailWanted = intents.length > 0;
    const email = emailWanted
      ? await deliverEmail({ decision, intents, fallbackRecipients, workflowName, brandName, branding, tenantId, workflowId })
      : null;
    const telegram = telegramIntents.length ? await deliverTelegram(telegramIntents) : null;

    // An email channel whose every recipient paused or muted these emails is not a failure and not a
    // delivery: it simply did not happen. If that was the only channel, hand the cooldown back like
    // any alert nobody received.
    const suppressedRecipients = email?.suppressed || [];
    const channels = [email, telegram].filter((channel) => channel && channel.status !== 'skipped');
    if (!channels.length) {
      const rolledBack = await rollbackBookkeeping({ tenantId, workflowId, decision });
      await store.updateDelivery(tenantId, workflowId, executionId, {
        status: 'none',
        skipped_reason: 'recipients_opted_out',
        suppressed_recipients: suppressedRecipients,
        rolled_back: rolledBack,
        error: null
      });
      return { status: 'none', skippedReason: 'recipients_opted_out', suppressed: suppressedRecipients, rolledBack, to: [], subject: null, messageId: null, email, telegram: null };
    }
    const sentCount = channels.filter((channel) => channel.status === 'sent').length;
    const anyDelivered = channels.some((channel) => channel.status === 'sent' || channel.status === 'partial');
    let overall = 'failed';
    if (sentCount === channels.length) overall = 'sent';
    else if (anyDelivered) overall = 'partial';

    const error = channels
      .filter((channel) => channel.status !== 'sent' && channel.error)
      .map((channel) => `${channel.channel}: ${channel.error}`)
      .join('; ') || null;

    // A notification nobody received must not consume the cooldown. If any channel
    // got through, the alert counts as delivered.
    const rolledBack = anyDelivered ? false : await rollbackBookkeeping({ tenantId, workflowId, decision });

    await store.updateDelivery(tenantId, workflowId, executionId, {
      status: overall,
      to: email?.to || [],
      subject: email?.subject || telegramIntents[0]?.title || null,
      messageId: email?.messageId || null,
      sent_at: anyDelivered ? now() : null,
      error,
      rolled_back: rolledBack,
      ...(suppressedRecipients.length ? { suppressed_recipients: suppressedRecipients } : {}),
      ...(telegram ? { telegram: { status: telegram.status, error: telegram.error || null, messages: telegram.count } } : {})
    });

    return {
      status: overall,
      error,
      rolledBack,
      to: email?.to || [],
      subject: email?.subject || null,
      messageId: email?.messageId || null,
      email,
      telegram
    };
  }

  async function deliverEmail({ decision, intents, fallbackRecipients, workflowName, brandName, branding, tenantId, workflowId }) {
    const email = renderStateEmail({ decision, intents, fallbackRecipients, workflowName, brandName, branding });
    let suppressed = [];
    if (recipientPolicy && email.to.length) {
      // The decision's state is the alert's severity (TRIGGERED / CRITICAL) for the severity filter.
      const filtered = await recipientPolicy.applyRecipientPreferences({
        recipients: email.to,
        tenantId,
        workflowId,
        severity: decision.resulting_state
      });
      suppressed = filtered.suppressed;
      email.to = filtered.allowed;
      if (!email.to.length) {
        return { channel: 'email', status: 'skipped', to: [], subject: email.subject, suppressed };
      }
    }
    const base = { channel: 'email', to: email.to, subject: email.subject, ...(suppressed.length ? { suppressed } : {}) };
    if (!email.to.length) {
      // Nothing to send to: no email node ran and none of the workflow's nodes has
      // email turned on (e.g. an insight node with "Email Insight" unticked).
      return {
        ...base,
        status: 'failed',
        error: 'no recipients: turn on "Email Insight" on an insight node or add an Email node with recipients'
      };
    }
    try {
      const delivery = await sender({ to: email.to, subject: email.subject, html: email.html, text: email.text });
      return delivery?.status === 'sent'
        ? { ...base, status: 'sent', messageId: delivery.messageId || null }
        : { ...base, status: 'failed', error: delivery?.error || 'email delivery failed' };
    } catch (error) {
      return { ...base, status: 'failed', error: error.message };
    }
  }

  // Sends each Telegram message the run's messaging nodes captured, exactly as
  // rendered. 'sent' only if every message fully went through.
  async function deliverTelegram(messages) {
    const results = [];
    for (const message of messages) {
      try {
        results.push(await telegramSender(message));
      } catch (error) {
        results.push({ status: 'failed', error: error.message });
      }
    }
    const sent = results.filter((result) => result?.status === 'sent').length;
    const delivered = results.some((result) => result?.status === 'sent' || result?.status === 'partial');
    let status = 'failed';
    if (sent === results.length) status = 'sent';
    else if (delivered) status = 'partial';
    const error = results.find((result) => result?.status !== 'sent')?.error || null;
    return { channel: 'telegram', status, error: status === 'sent' ? null : (error || 'telegram delivery failed'), count: results.length };
  }

  async function processExecution(params) {
    const { intents, telegramIntents, fallbackRecipients, workflowName, brandName, branding, ...applyParams } = params;
    const { evaluation, replayed } = await applyExecution(applyParams);
    const delivery = await deliver({ evaluation, intents, telegramIntents, fallbackRecipients, workflowName, brandName, branding });
    return { evaluation, replayed, delivery, summary: summarize(evaluation, delivery) };
  }

  return { applyExecution, deliver, processExecution, previewExecution, rollbackBookkeeping };
}

let defaultService = null;
function getDefaultStateEngineService() {
  if (!defaultService) {
    defaultService = createStateEngineService({
      recipientPolicy: require('./recipientPolicy').getDefaultRecipientPolicy()
    });
  }
  return defaultService;
}

module.exports = {
  createStateEngineService,
  createMongoStateStore,
  getDefaultStateEngineService
};
