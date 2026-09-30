const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const MessagingNode = require('../nodes/MessagingNode');
const { sendTelegram } = require('../server/services/telegramService');
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
});

test('telegram service sends the curl-equivalent headers and payload', async () => {
  const originalUrl = process.env.TELEGRAM_SERVICE_URL;
  const originalSecret = process.env.TELEGRAM_SERVICE_SECRET;
  process.env.TELEGRAM_SERVICE_URL = 'http://telegram-service.test';
  process.env.TELEGRAM_SERVICE_SECRET = 'test-secret';

  let request;
  try {
    const requests = [];
    const images = [
      'data:image/jpeg;base64,page-one',
      'data:image/jpeg;base64,page-two'
    ];
    const result = await sendTelegram({
      title: 'CVR drop',
      message: 'Conversion rate dropped',
      images,
      severity: 'critical',
      users: [{ username: 'real-user' }],
      fetchImpl: async (url, options) => {
        request = { url, options };
        requests.push({ url, options });
        return new Response(JSON.stringify({ delivered: 1 }), { status: 200 });
      }
    });

    assert.equal(result.status, 'sent');
    assert.equal(request.url, 'http://telegram-service.test/alerts');
    assert.equal(request.options.headers['x-shared-secret'], 'test-secret');
    assert.equal(request.options.headers['x-drains'], 'TELEGRAM');
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      alert: {
        title: 'CVR drop (1/2)',
        image: images[0],
        severity: 'critical',
        imageMimeType: 'image/jpeg',
        delivery: 'image'
      },
      users: [{ username: 'real-user' }]
    });
    assert.equal(JSON.parse(requests[1].options.body).alert.title, 'CVR drop (2/2)');
    assert.equal(JSON.parse(requests[1].options.body).alert.image, images[1]);
  } finally {
    if (originalUrl === undefined) delete process.env.TELEGRAM_SERVICE_URL;
    else process.env.TELEGRAM_SERVICE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.TELEGRAM_SERVICE_SECRET;
    else process.env.TELEGRAM_SERVICE_SECRET = originalSecret;
  }
});