const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function startMediaRetryLoop(provider, store, { intervalMs = RETRY_INTERVAL_MS } = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const pending = store.all('messages').filter((message) => (
        message.status === 'media_pending'
        && message.mediaPending
        && message.direction === 'in'
        && (Number(message.metadata?.mediaRetryCount) || 0) < MAX_ATTEMPTS
      ));
      for (const message of pending.slice(0, 20)) {
        try {
          await provider.retryPendingMedia(message);
        } catch (error) {
          const count = (Number(message.metadata?.mediaRetryCount) || 0) + 1;
          store.update('messages', message.id, {
            metadata: {
              ...(message.metadata && typeof message.metadata === 'object' ? message.metadata : {}),
              mediaRetryCount: count,
              lastMediaRetryError: String(error.message || '').slice(0, 200)
            }
          });
        }
      }
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick().catch(() => {});

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { MAX_ATTEMPTS, RETRY_INTERVAL_MS, startMediaRetryLoop };