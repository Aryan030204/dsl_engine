let amqpLib = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RabbitWorkflowRunQueue {
  constructor(options = {}) {
    this.options = {
      url: options.url || process.env.RABBITMQ_URL,
      exchange: options.exchange || process.env.RABBITMQ_RUN_EXCHANGE || 'scheduler.runs',
      queue: options.queue || process.env.RABBITMQ_RUN_QUEUE || 'scheduler.workflow-runs.v1',
      routingKey: options.routingKey || process.env.RABBITMQ_RUN_ROUTING_KEY || 'workflow.run',
      prefetch: Number(options.prefetch || process.env.RABBITMQ_RUN_PREFETCH || 10)
    };
    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
  }

  async _loadAmqp() {
    if (amqpLib) return amqpLib;
    try {
      amqpLib = require('amqplib');
      return amqpLib;
    } catch (error) {
      const err = new Error('amqplib is required for RabbitMQ run queue. Install dependency and configure RABBITMQ_URL.');
      err.code = 'AMQPLIB_MISSING';
      throw err;
    }
  }

  async connect() {
    if (this.channel) return;
    if (!this.options.url) {
      const err = new Error('RABBITMQ_URL is required for rabbit run queue backend');
      err.code = 'RABBITMQ_URL_MISSING';
      throw err;
    }

    const amqp = await this._loadAmqp();
    this.connection = await amqp.connect(this.options.url, { timeout: 5000 });
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(this.options.exchange, 'direct', { durable: true });
    await this.channel.assertQueue(this.options.queue, { durable: true });
    await this.channel.bindQueue(this.options.queue, this.options.exchange, this.options.routingKey);
    await this.channel.prefetch(this.options.prefetch);
    console.log(
      `[rabbit-run-queue] connected exchange=${this.options.exchange} queue=${this.options.queue} routingKey=${this.options.routingKey} prefetch=${this.options.prefetch}`
    );
  }

  async publishRun(runId, headers = {}) {
    await this.connect();
    const body = Buffer.from(JSON.stringify({ runId: String(runId) }), 'utf8');
    const ok = this.channel.publish(this.options.exchange, this.options.routingKey, body, {
      persistent: true,
      contentType: 'application/json',
      messageId: `run:${String(runId)}:${Date.now()}`,
      headers
    });

    if (!ok) {
      await sleep(5);
    }
  }

  async consumeRuns({ stopSignal, handler }) {
    await this.connect();

    const result = await this.channel.consume(this.options.queue, async (msg) => {
      if (!msg) return;

      let payload;
      try {
        payload = JSON.parse(msg.content.toString('utf8'));
      } catch (error) {
        console.error('[rabbit-run-queue] invalid message payload', error.message);
        this.channel.nack(msg, false, false);
        return;
      }

      const wrapped = {
        runId: payload.runId,
        headers: msg.properties.headers || {},
        raw: msg
      };

      try {
        await handler(wrapped);
        this.channel.ack(msg);
      } catch (error) {
        const requeue = !['AMQPLIB_MISSING', 'INVALID_RUN_MESSAGE'].includes(error.code);
        this.channel.nack(msg, false, requeue);
      }
    }, { noAck: false });

    this.consumerTag = result.consumerTag;

    while (!stopSignal.stopped) {
      await sleep(500);
    }
  }

  async close() {
    if (this.channel && this.consumerTag) {
      try { await this.channel.cancel(this.consumerTag); } catch (_) {}
    }
    if (this.channel) await this.channel.close();
    if (this.connection) await this.connection.close();
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
  }
}

let singleton = null;
function getRabbitWorkflowRunQueue() {
  if (!singleton) singleton = new RabbitWorkflowRunQueue();
  return singleton;
}

module.exports = {
  RabbitWorkflowRunQueue,
  getRabbitWorkflowRunQueue
};
