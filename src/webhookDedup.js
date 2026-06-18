const WEBHOOK_DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

async function claimWebhookEvent(redis, store, providerMessageId) {
  const id = String(providerMessageId || '').trim();
  if (!id) return false;

  if (redis) {
    try {
      const key = `wh:dedup:${id}`;
      const result = await redis.set(key, '1', 'EX', WEBHOOK_DEDUP_TTL_SEC, 'NX');
      return result === 'OK';
    } catch {
      // Redis hatasında store dedup'a düş.
    }
  }

  return store.claimWebhookDedup(id);
}

module.exports = { WEBHOOK_DEDUP_TTL_SEC, claimWebhookEvent };