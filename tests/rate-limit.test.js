const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryLoginLimiter, createMemoryApiLimiter } = require('../src/rateLimit');

test('login limiter başarısız denemelerde bloklar', async () => {
  const limiter = createMemoryLoginLimiter({ maxAttempts: 2, windowMs: 60000 });
  const key = '127.0.0.1|admin';
  assert.equal((await limiter.check(key)).blocked, false);
  await limiter.fail(key);
  await limiter.fail(key);
  const blocked = await limiter.check(key);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSec > 0);
  await limiter.reset(key);
  assert.equal((await limiter.check(key)).blocked, false);
});

test('api limiter istek sayısını sınırlar', async () => {
  const limiter = createMemoryApiLimiter({ maxRequests: 2, windowMs: 60000 });
  const key = '10.0.0.1';
  assert.equal((await limiter.check(key)).blocked, false);
  assert.equal((await limiter.check(key)).blocked, false);
  const blocked = await limiter.check(key);
  assert.equal(blocked.blocked, true);
});