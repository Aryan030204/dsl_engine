const test = require('node:test');
const assert = require('node:assert/strict');

const MessagingNode = require('../nodes/MessagingNode');
const { isPrivateHost, isAllowedRequest, isEmailScreenshotMode } = require('../server/lib/renderEmailScreenshot');

const def = {
  id: 'notify',
  type: 'messaging',
  channels: { email: false, telegram: true },
  format: 'insight',
  subject: 'Brand A alert',
  template: { insightSource: 'scratch.finalInsight' },
  telegram: { users: [{ username: 'real-user' }] }
};

function context() {
  return {
    meta: { tenantId: 'tenant-1', brandName: 'Acme', workflowName: 'CVR drop' },
    scratch: { finalInsight: { summary: 'CVR dropped', details: ['Mobile down'], confidence: 0.8 } }
  };
}

async function withMode(mode, fn) {
  const previous = process.env.TELEGRAM_RENDER_MODE;
  if (mode === undefined) delete process.env.TELEGRAM_RENDER_MODE;
  else process.env.TELEGRAM_RENDER_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_RENDER_MODE;
    else process.env.TELEGRAM_RENDER_MODE = previous;
  }
}

test('screenshot mode is off unless explicitly enabled', async () => {
  await withMode(undefined, () => assert.equal(isEmailScreenshotMode(), false));
  await withMode('email_screenshot', () => assert.equal(isEmailScreenshotMode(), true));
});

test('screenshot mode sends the screenshots of the email html to Telegram', async () => {
  await withMode('email_screenshot', async () => {
    const seen = [];
    let sentImages;
    const result = await MessagingNode(def, context(), {
      emailScreenshotRenderer: async ({ html }) => { seen.push(html); return ['data:image/jpeg;base64,AAAA']; },
      telegramSender: async (payload) => { sentImages = payload.images; return { status: 'sent' }; }
    });
    assert.equal(result.status, 'pass');
    assert.deepEqual(sentImages, ['data:image/jpeg;base64,AAAA']);
    assert.match(seen[0], /CVR dropped/);
    assert.equal(result.deliveries.telegram.imageFallback, undefined);
  });
});

test('a failing screenshot falls back to the drawn pages and is reported', async () => {
  await withMode('email_screenshot', async () => {
    let sentImages;
    const result = await MessagingNode(def, context(), {
      emailScreenshotRenderer: async () => { throw new Error('no Chrome/Chromium found'); },
      telegramSender: async (payload) => { sentImages = payload.images; return { status: 'sent' }; }
    });
    assert.equal(result.status, 'pass');
    assert.match(sentImages[0], /^data:image\/jpeg;base64,/);
    assert.match(result.deliveries.telegram.imageFallback, /email screenshot: no Chrome/);
  });
});

test('without the flag the screenshot renderer is never called', async () => {
  await withMode(undefined, async () => {
    let called = false;
    const result = await MessagingNode(def, context(), {
      emailScreenshotRenderer: async () => { called = true; return ['x']; },
      telegramSender: async () => ({ status: 'sent' })
    });
    assert.equal(result.status, 'pass');
    assert.equal(called, false);
  });
});

test('screenshot browser only loads public http(s) images', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('10.0.0.5'), true);
  assert.equal(isPrivateHost('192.168.1.2'), true);
  assert.equal(isPrivateHost('169.254.169.254'), true);
  assert.equal(isPrivateHost('172.20.1.1'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('cdn.example.com'), false);
  assert.equal(isAllowedRequest('https://cdn.example.com/logo.png', false), true);
  assert.equal(isAllowedRequest('http://169.254.169.254/latest/meta-data', false), false);
  assert.equal(isAllowedRequest('file:///etc/passwd', false), false);
  assert.equal(isAllowedRequest('https://evil.example.com/', true), false);
});
