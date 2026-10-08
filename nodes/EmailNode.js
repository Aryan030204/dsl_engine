const { renderEmail } = require('../server/lib/renderEmail');
const { sendEmail } = require('../server/services/emailService');

async function EmailNode(def, context, runtime = {}) {
  let rendered;
  try {
    rendered = renderEmail({
      format: def.format,
      template: def.template,
      context,
      branding: def.branding,
      subject: def.subject,
    });
  } catch (error) {
    return { status: 'fail', reason: `EmailNode: ${error.message}` };
  }

  const emailSender = runtime.emailSender || sendEmail;
  let delivery;
  try {
    delivery = await emailSender({
      to: def.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch (error) {
    return { status: 'fail', reason: `EmailNode: ${error.message}` };
  }
  // 'deferred': a state-engine workflow captured this send (server/lib/
  // notificationCapture.js); whether it goes out is decided after the run.
  if (!delivery || (delivery.status !== 'sent' && delivery.status !== 'deferred')) {
    return { status: 'fail', reason: `EmailNode: ${delivery?.error || 'email delivery failed'}`, delivery };
  }

  const scratch = context.scratch || {};
  return {
    status: 'pass',
    delta: {
      scratch: {
        ...scratch,
        emailDeliveries: {
          ...(scratch.emailDeliveries || {}),
          [def.id]: delivery,
        }
      }
    },
    delivery,
    next: def.next,
  };
}

module.exports = EmailNode;
