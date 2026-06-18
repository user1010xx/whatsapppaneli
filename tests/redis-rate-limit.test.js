const test = require('node:test');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { createRedisLoginLimiter, createRedisApiLimiter } = require('../src/rateLimit');

const redisUrl = process.env.REDIS_URL || process.env.TEST_REDIS_URL;

test('Redis login limiter çoklu instance arasında sayaç paylaşır', { skip: !redisUrl }, async () => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const prefix = `test:login:${Date.now()}:`;
  const limiter = createRedisLoginLimiter(redis, { maxAttempts: 2, windowMs: 60000, prefix });
  const key = '10.0.0.1|tester';
  try {
    await limiter.fail(key);
    await limiter.fail(key);
    const blocked = await limiter.check(key);
    assert.equal(blocked.blocked, true);
    await limiter.reset(key);
    assert.equal((await limiter.check(key)).blocked, false);
  } finally {
    await redis.del(`${prefix}${key}`);
    await redis.quit();
  }
});

test('Redis api limiter istekleri sınırlar', { skip: !redisUrl }, async () => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const prefix = `test:api:${Date.now()}:`;
  const limiter = createRedisApiLimiter(redis, { maxRequests: 2, windowMs: 60000, prefix });
  const key = '10.0.0.2';
  try {
    assert.equal((await limiter.check(key)).blocked, false);
    assert.equal((await limiter.check(key)).blocked, false);
    assert.equal((await limiter.check(key)).blocked, true);
  } finally {
    await redis.del(`${prefix}${key}`);
    await redis.quit();
  }
});