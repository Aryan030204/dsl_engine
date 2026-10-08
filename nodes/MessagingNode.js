const { renderEmail } = require('../server/lib/renderEmail');
const { renderTelegramImages } = require('../server/lib/renderTelegramImage');
const { resolveBinding } = require('../server/lib/emailBindings');
const { sendEmail } = require('../server/services/emailService');
const { sendTelegram } = require('../server/services/telegramService');

async function MessagingNode(def, context, runtime = {}) {
  const channels = def.channels || {};
  const emailEnabled = channels.email === true;
  const telegramEnabled = channels.telegram === true;

  if (!emailEnabled && !telegramEnabled) {
    return { status: 'fail', reason: 'MessagingNode: select at least one channel' };
  }

  let rendered;
  try {
    rendered = renderEmail({
      format: def.format,
      template: def.template,
      context,
      branding: def.branding,
      subject: def.subject
    });
  } catch (error) {
    return { status: 'fail', reason: `MessagingNode: ${error.message}` };
  }

  const deliveries = {};
  if (emailEnabled) {
    const emailSender = runtime.emailSender || sendEmail;
    deliveries.email = await emailSender({
      to: def.email?.to || [],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text
    });
  }
  if (telegramEnabled) {
    const telegramSender = runtime.telegramSender || sendTelegram;
    const severity = def.telegram?.severity || 'info';
    const insightBinding = def.format === 'insight'
      ? resolveBinding(context, def.template?.insightSource || 'scratch.finalInsight')
      : null;
    // Report pages rendered as images (server/lib/renderTelegramImage.js). The text
    // version always goes along too, so a page that can't be rendered (e.g. a report
    // over the renderer's row limit) degrades to a text alert instead of failing
    // the run.
    let images;
    let imageError = null;
    try {
      images = await renderTelegramImages({
        title: rendered.subject,
        message: rendered.text,
        insight: insightBinding?.value,
        reportViewModel: rendered.viewModel,
        brandName: context?.meta?.brandName,
        workflowName: context?.meta?.workflowName,
        severity
      });
    } catch (error) {
      imageError = error.message;
    }
    deliveries.telegram = await telegramSender({
      title: rendered.subject,
      message: rendered.text,
      ...(images && images.length ? { images } : {}),
      severity,
      users: def.telegram?.users || []
    });
    if (imageError && deliveries.telegram) {
      deliveries.telegram = { ...deliveries.telegram, imageFallback: imageError };
    }
  }

  // 'deferred': a state-engine workflow captured this send (server/lib/
  // notificationCapture.js); whether it goes out is decided after the run.
  const failedChannels = Object.entries(deliveries)
    .filter(([, delivery]) => !delivery || (delivery.status !== 'sent' && delivery.status !== 'deferred'))
    .map(([channel, delivery]) => `${channel}: ${delivery?.error || 'delivery failed'}`);
  const scratch = context.scratch || {};
  const result = {
    status: failedChannels.length ? 'fail' : 'pass',
    delta: {
      scratch: {
        ...scratch,
        messagingDeliveries: {
          ...(scratch.messagingDeliveries || {}),
          [def.id]: deliveries
        }
      }
    },
    deliveries,
    next: def.next
  };
  if (failedChannels.length) result.reason = `MessagingNode: ${failedChannels.join('; ')}`;
  return result;
}

module.exports = MessagingNode;