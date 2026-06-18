class WebhookQueue {
  constructor(handler, {
    maxRetries = 2,
    retryDelayMs = 500,
    redis = null,
    deadLetterKey = 'webhook:deadletter',
    queueKey = 'webhook:queue'
  } = {}) {
    this.handler = handler;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.redis = redis;
    this.deadLetterKey = deadLetterKey;
    this.queueKey = queueKey;
    this.queue = [];
    this.running = false;
    this._stopped = false;
    if (this.redis) {
      this._redisWorkerPromise = this.runRedisWorker().catch((error) => {
        if (!this._stopped) console.error('Redis webhook worker hatası:', error.message);
      });
    }
  }

  stop() {
    this._stopped = true;
  }

  enqueue(payload) {
    if (this.redis) {
      return this.redis.rpush(this.queueKey, JSON.stringify(payload)).then(() => ({ queued: true }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject, attempts: 0 });
      this.pump();
    });
  }

  async persistDeadLetter(payload, attempts, error) {
    if (!this.redis) return;
    try {
      await this.redis.lpush(this.deadLetterKey, JSON.stringify({
        payload,
        attempts,
        error: error?.message || 'unknown',
        at: new Date().toISOString()
      }));
      await this.redis.ltrim(this.deadLetterKey, 0, 499);
    } catch {}
  }

  async processWithRetry(payload) {
    let attempts = 0;
    while (attempts <= this.maxRetries) {
      try {
        return await this.handler(payload);
      } catch (error) {
        attempts += 1;
        if (attempts > this.maxRetries) {
          await this.persistDeadLetter(payload, attempts, error);
          throw error;
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempts));
      }
    }
    return null;
  }

  async runRedisWorker() {
    while (!this._stopped) {
      try {
        const item = await this.redis.brpop(this.queueKey, 2);
        if (!item || this._stopped) continue;
        const payload = JSON.parse(item[1]);
        await this.processWithRetry(payload);
      } catch (error) {
        if (!this._stopped) console.error('Webhook işleme hatası:', error.message);
      }
    }
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        const result = await this.processWithRetry(job.payload);
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      }
    }
    this.running = false;
  }
}

module.exports = { WebhookQueue };