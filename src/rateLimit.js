function createMemoryLoginLimiter({ maxAttempts = 5, windowMs = 1000 * 60 * 15 } = {}) {
  const attempts = new Map();
  return {
    async check(key) {
      const entry = attempts.get(key);
      if (!entry) return { blocked: false };
      if (Date.now() > entry.resetAt) {
        attempts.delete(key);
        return { blocked: false };
      }
      if (entry.count >= maxAttempts) {
        return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - Date.now()) / 1000) };
      }
      return { blocked: false };
    },
    async fail(key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() > entry.resetAt) {
        attempts.set(key, { count: 1, resetAt: Date.now() + windowMs });
      } else {
        entry.count += 1;
      }
      if (attempts.size > 1000) {
        const cutoff = Date.now();
        for (const [existingKey, existingEntry] of attempts.entries()) {
          if (cutoff > existingEntry.resetAt) attempts.delete(existingKey);
        }
      }
    },
    async reset(key) {
      attempts.delete(key);
    }
  };
}

function createMemoryApiLimiter({ maxRequests = 120, windowMs = 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    async check(key) {
      const entry = hits.get(key);
      const now = Date.now();
      if (!entry || now > entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { blocked: false };
      }
      entry.count += 1;
      if (entry.count > maxRequests) {
        return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
      }
      return { blocked: false };
    }
  };
}

function createRedisLoginLimiter(redis, { maxAttempts = 5, windowMs = 1000 * 60 * 15, prefix = 'rl:login:' } = {}) {
  const windowSec = Math.ceil(windowMs / 1000);
  return {
    async check(key) {
      const redisKey = `${prefix}${key}`;
      const count = Number(await redis.get(redisKey) || 0);
      if (count >= maxAttempts) {
        const ttl = await redis.ttl(redisKey);
        return { blocked: true, retryAfterSec: Math.max(1, ttl) };
      }
      return { blocked: false };
    },
    async fail(key) {
      const redisKey = `${prefix}${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.expire(redisKey, windowSec);
    },
    async reset(key) {
      await redis.del(`${prefix}${key}`);
    }
  };
}

function createRedisApiLimiter(redis, { maxRequests = 120, windowMs = 60 * 1000, prefix = 'rl:api:' } = {}) {
  const windowSec = Math.ceil(windowMs / 1000);
  return {
    async check(key) {
      const redisKey = `${prefix}${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.expire(redisKey, windowSec);
      if (count > maxRequests) {
        const ttl = await redis.ttl(redisKey);
        return { blocked: true, retryAfterSec: Math.max(1, ttl) };
      }
      return { blocked: false };
    }
  };
}

async function createRateLimiters(options = {}) {
  const redis = options.redis;
  if (redis) {
    try {
      await redis.ping();
      return {
        loginLimiter: createRedisLoginLimiter(redis, options.login),
        apiLimiter: createRedisApiLimiter(redis, options.api),
        webhookLimiter: createRedisApiLimiter(redis, { maxRequests: 300, windowMs: 60 * 1000, prefix: 'rl:webhook:', ...(options.webhook || {}) }),
        backend: 'redis',
        degraded: false
      };
    } catch (error) {
      console.error('Redis rate limit kullanılamıyor, bellek moduna düşülüyor:', error.message);
    }
  }
  return {
    loginLimiter: createMemoryLoginLimiter(options.login),
    apiLimiter: createMemoryApiLimiter(options.api),
    webhookLimiter: createMemoryApiLimiter({ maxRequests: 300, windowMs: 60 * 1000, ...(options.webhook || {}) }),
    backend: 'memory',
    degraded: Boolean(options.redis)
  };
}

module.exports = {
  createRateLimiters,
  createMemoryLoginLimiter,
  createMemoryApiLimiter,
  createRedisLoginLimiter,
  createRedisApiLimiter
};