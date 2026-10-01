const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const MessagingNode = require('../nodes/MessagingNode');
const { sendTelegram, formatTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } = require('../server/services/telegramService');
const { renderTelegramImages, normalizeDetails } = require('../server/lib/renderTelegramImage');

function context() {
  return {
    meta: { tenantId: 'tenant_a', brandName: 'Brand A', window: 'today', baselineWindow: 'yesterday' },
    metrics: {},
    scratch: { finalInsight: { summary: 'CVR dropped', details: ['Landing page conversion is down'] } }
  };
}

test('telegram renderer creates compact JPEG page data URLs', async () => {
  const insight = {
    summary: 'Conversion performance across the best and weakest UTM sources.',
    confidence: 0.62,
    details: [
      {
        title: 'Top 3 UTM sources',
        items: [
          '1. google | CVR 1.87% -> 2.05% (increase 9.66%) | sessions 19,667 -> 18,375 (-6.57%) | orders 367 -> 376 (+2.45%)',
          '2. facebook | CVR 1.09% -> 1.19% (increase 9.17%) | sessions 38,560 -> 34,618 (-10.22%) | orders 421 -> 379 (-9.98%)'
        ]
      },
      {
        title: 'Bottom 3 UTM sources',
        items: ['1. kwikengage | CVR 4.55% -> 4.14% (drop -9.06%) | sessions 1,625 -> 1,473 (-9.35%) | orders 74 -> 61 (-17.57%)']
      }
    ]
  };
  const message = 'Workflow: Daily report\nBrand: Example';
  const images = await renderTelegramImages({
    title: 'Tenant <critical>',
    message,
    insight,
    brandName: 'Example',
    workflowName: 'Daily report',
    severity: 'critical'
  });

  assert.equal(images.length, 1);
  assert.match(images[0], /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.from(images[0].split(',')[1], 'base64').length <= 60 * 1024);
  const metadata = await sharp(Buffer.from(images[0].split(',')[1], 'base64')).metadata();
  assert.ok(metadata.width >= 760);
  assert.ok(metadata.height > 600);
});

test('telegram detail normalization extracts source and metric columns', () => {
  const sections = normalizeDetails({
    summary: 'Conversion rate report',
    details: [{
      title: 'Top 3 UTM sources',
      items: ['1. google | CVR 1.87% -> 2.05% (increase 9.66%) | sessions 19,667 -> 18,375 (-6.57%) | orders 367 -> 376 (+2.45%)']
    }]
  });

  assert.equal(sections[0].title, 'Top 3 UTM sources');
  assert.equal(sections[0].rows[0].source, 'google');
  assert.deepEqual(sections[0].rows[0].metrics.map((metric) => metric.label), ['CVR', 'sessions', 'orders']);
  assert.deepEqual(sections[0].rows[0].metrics.map((metric) => metric.tone), ['positive', 'negative', 'positive']);
});

test('telegram renderer splits all report lines beyond the old cutoff into pages', async () => {
  const message = Array.from({ length: 160 }, (_, index) => `Full report detail row ${index + 1}`).join('\n');
  const images = await renderTelegramImages({ title: 'Full report', message });

  assert.equal(images.length, 20);
  for (const image of images) {
    assert.match(image, /^data:image\/jpeg;base64,/);
    assert.ok(Buffer.from(image.split(',')[1], 'base64').length <= 60 * 1024);
    const metadata = await sharp(Buffer.from(image.split(',')[1], 'base64')).metadata();
    assert.ok(metadata.height > 200);
  }
});

test('messaging node sends both enabled channels independently', async () => {
  const calls = [];
  const result = await MessagingNode({
    id: 'notify',
    type: 'messaging',
    channels: { email: true, telegram: true },
    format: 'insight',
    subject: 'Brand A alert',
    template: { insightSource: 'scratch.finalInsight' },
    email: { to: ['ops@example.com'] },
    telegram: { users: [{ username: 'real-user' }], severity: 'critical' }
  }, context(), {
    emailSender: async (payload) => {
      calls.push({ channel: 'email', payload });
      return { status: 'sent', provider: 'smtp' };
    },
    telegramSender: async (payload) => {
      calls.push({ channel: 'telegram', payload });
      return { status: 'sent', provider: 'telegram' };
    }
  });

  assert.equal(result.status, 'pass');
  assert.deepEqual(calls.map((call) => call.channel), ['email', 'telegram']);
  assert.deepEqual(calls[1].payload.users, [{ username: 'real-user' }]);
  assert.equal(calls[1].payload.severity, 'critical');
  assert.match(calls[1].payload.images[0], /^data:image\/jpeg;base64,/);
  assert.match(calls[1].payload.message, /CVR dropped/);
});

// In-process Telegram delivery (ported from the standalone message service). The
// bot API and the linked-users lookup are swapped for fakes via `deps`.
function fakeTelegram({ linked = {}, failChatIds = [], configured = true } = {}) {
  const sent = [];
  return {
    sent,
    isTelegramConfigured: () => configured,
    resolveChatIds: async (users) => users.map((user) => ({
      username: user.username,
      telegramChatId: user.telegramChatId || linked[user.username] || null
    })),
    sendToUsers: async (users, text) => users.map((user) => {
      sent.push({ chatId: user.telegramChatId, text });
      return failChatIds.includes(user.telegramChatId)
        ? { telegramChatId: user.telegramChatId, username: user.username, success: false, error: 'Forbidden: bot was blocked by the user' }
        : { telegramChatId: user.telegramChatId, username: user.username, success: true };
    })
  };
}

test('telegram: linked usernames and raw chat ids both receive the formatted alert', async () => {
  const deps = fakeTelegram({ linked: { ops_lead: '111' } });
  const result = await sendTelegram({
    title: 'CVR drop', message: 'Conversion rate dropped', severity: 'critical',
    users: [{ username: '@ops_lead' }, { telegramChatId: '222' }], deps
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(deps.sent.map((m) => m.chatId), ['111', '222']);
  assert.equal(deps.sent[0].text, ['[CRITICAL] CVR drop', 'Conversion rate dropped'].join('\n'));
});

test('telegram: an unlinked username is reported, and the others still get it (partial)', async () => {
  const deps = fakeTelegram({ linked: { ops_lead: '111' } });
  const result = await sendTelegram({ title: 'CVR drop', message: 'm', users: [{ username: 'ops_lead' }, { username: 'nobody' }], deps });

  assert.equal(result.status, 'partial');
  assert.equal(deps.sent.length, 1);
  assert.match(result.error, /no linked Telegram chat for "nobody"/);
});

test('telegram: every recipient failing is failed, not partial', async () => {
  const deps = fakeTelegram({ linked: { ops_lead: '111' }, failChatIds: ['111'] });
  const result = await sendTelegram({ title: 'CVR drop', message: 'm', users: [{ username: 'ops_lead' }], deps });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /blocked/);
});

test('telegram: a missing bot token fails clearly without trying to send', async () => {
  const deps = fakeTelegram({ configured: false });
  const result = await sendTelegram({ title: 'CVR drop', message: 'm', users: [{ username: 'ops_lead' }], deps });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'TELEGRAM_BOT_TOKEN is not configured');
  assert.equal(deps.sent.length, 0);
});

test('telegram: messages are cut to the 4096-character limit', () => {
  const text = formatTelegramMessage({ title: 'T', message: 'x'.repeat(10000), severity: 'info' });
  assert.equal(text.length, TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.ok(text.startsWith(['[INFO] T', 'xxx'].join('\n')));
  assert.ok(text.endsWith('…'));
});

function fakePhotoTelegram({ linked = {}, failChatIds = [] } = {}) {
  const photos = [];
  return {
    photos,
    isTelegramConfigured: () => true,
    resolveChatIds: async (users) => users.map((user) => ({
      username: user.username,
      telegramChatId: user.telegramChatId || linked[user.username] || null
    })),
    sendToUsers: async () => { throw new Error('text path must not be used for image reports'); },
    sendPhotoToUsers: async (users, { photo, caption }) => users.map((user) => {
      photos.push({ chatId: user.telegramChatId, caption, bytes: photo.data.length, contentType: photo.contentType });
      return failChatIds.includes(user.telegramChatId)
        ? { telegramChatId: user.telegramChatId, username: user.username, success: false, error: 'Forbidden' }
        : { telegramChatId: user.telegramChatId, username: user.username, success: true };
    })
  };
}

test('telegram: report pages go out as photos, in order, captioned "[SEVERITY] title (n/m)"', async () => {
  const deps = fakePhotoTelegram({ linked: { ops_lead: '111' } });
  const images = [
    `data:image/jpeg;base64,${Buffer.from('page-one').toString('base64')}`,
    `data:image/jpeg;base64,${Buffer.from('page-two').toString('base64')}`
  ];
  const result = await sendTelegram({
    title: 'CVR drop', message: 'Conversion rate dropped', images, severity: 'critical',
    users: [{ username: 'ops_lead' }], deps
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.pages, 2);
  assert.deepEqual(deps.photos.map((p) => p.caption), ['[CRITICAL] CVR drop (1/2)', '[CRITICAL] CVR drop (2/2)']);
  assert.deepEqual(deps.photos.map((p) => p.bytes), [8, 8]);
  assert.equal(deps.photos[0].contentType, 'image/jpeg');
});

test('telegram: a single report page has no page counter, and a failed page fails that user', async () => {
  const deps = fakePhotoTelegram({ linked: { a: '1', b: '2' }, failChatIds: ['2'] });
  const result = await sendTelegram({
    title: 'CVR drop', image: Buffer.from('only').toString('base64'), severity: 'info',
    users: [{ username: 'a' }, { username: 'b' }], deps
  });

  assert.equal(deps.photos[0].caption, '[INFO] CVR drop');
  assert.equal(result.status, 'partial');
  assert.match(result.error, /page 1: Forbidden/);
});

test('messaging node falls back to a text alert when the report cannot be rendered as images', async () => {
  const calls = [];
  const result = await MessagingNode({
    id: 'notify', type: 'messaging', channels: { email: false, telegram: true },
    format: 'insight', subject: 'Big report', template: { insightSource: 'scratch.finalInsight' },
    telegram: { users: [{ username: 'real-user' }] }
  }, {
    ...context(),
    // 130 rows in one section: over the renderer's 120-row limit, which it rejects
    // before rendering anything.
    scratch: { finalInsight: { summary: 'Too many rows', details: [{ title: 'Sources', items: Array.from({ length: 130 }, (_, index) => `${index + 1}. src${index} | CVR 1% -> 2% (increase 100%)`) }] } }
  }, {
    telegramSender: async (payload) => { calls.push(payload); return { status: 'sent' }; }
  });

  assert.equal(result.status, 'pass');
  assert.equal(calls[0].images, undefined);
  assert.ok(calls[0].message.length > 0);
  assert.match(result.deliveries.telegram.imageFallback, /maximum supported is 120/);
});
