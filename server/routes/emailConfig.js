const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { createEmailConfigService, EmailConfigError } = require('../services/emailConfigService');
const { getDefaultRecipientPolicy } = require('../services/recipientPolicy');

// Email Configurations panel API. Mounted at /email-config behind requireAuth (server.js); every signed-in
// domain user is an admin, and every change is recorded in the audit trail with who made it.
function createEmailConfigRouter({ service } = {}) {
  const router = express.Router();
  const emailConfig = service || createEmailConfigService({ onChange: () => getDefaultRecipientPolicy().invalidate() });

  router.use(requireAdmin);

  const handle = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      if (error instanceof EmailConfigError) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
  const actor = (req) => req.user?.email || null;

  router.get('/recipients', handle(async () => ({ recipients: await emailConfig.listRecipients() })));

  router.get('/recipients/:email', handle(async (req) => emailConfig.getRecipient(req.params.email)));

  router.get('/workflows', handle(async () => ({ workflows: await emailConfig.listWorkflows() })));

  router.get('/events', handle(async (req) => ({ events: await emailConfig.recentEvents(req.query.email || null, 50) })));

  router.put('/recipients/:email/preferences', handle(async (req) => ({
    preferences: await emailConfig.updatePreferences(req.params.email, req.body || {}, actor(req))
  })));

  router.put('/recipients/:email/workflows/:workflowKey/mute', handle(async (req) => (
    emailConfig.setMute(req.params.email, req.params.workflowKey, req.body?.muted, actor(req))
  )));

  router.post('/recipients/:email/workflows', handle(async (req) => {
    const { add = [], remove = [] } = req.body || {};
    if (!Array.isArray(add) || !Array.isArray(remove)) {
      throw new EmailConfigError('add and remove must be lists of workflow keys');
    }
    if (add.length + remove.length > 100) throw new EmailConfigError('too many workflows in one request');
    return { results: await emailConfig.applyWorkflowChanges(req.params.email, { add, remove }, actor(req)) };
  }));

  return router;
}

module.exports = createEmailConfigRouter();
module.exports.createEmailConfigRouter = createEmailConfigRouter;
