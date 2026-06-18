const http = require('node:http');
const { URL } = require('node:url');
const { getConfig } = require('./config');
const { createStore } = require('./storage');
const { createRateLimiters } = require('./rateLimit');
const Redis = require('ioredis');
const { createToken } = require('./auth');
const { EventHub } = require('./eventHub');
const crypto = require('node:crypto');
const { createWhatsappProvider } = require('./whatsapp');
const {
  badRequest,
  getAuthUser,
  isCrossSiteRequest,
  notFound,
  readJson,
  readRawBody,
  sendError,
  sendFileStream,
  sendJson,
  securityHeaders,
  serveStatic
} = require('./http');
const { publicUser } = require('./rbac');
const services = require('./services');
const { WebhookQueue } = require('./webhookQueue');
const { pruneOldMedia, pruneOrphanMedia } = require('./mediaMaintenance');
const { startMediaRetryLoop } = require('./mediaRetry');
const fs = require('node:fs');
const path = require('node:path');

function routeKey(method, pathname) {
  return `${method.toUpperCase()} ${pathname}`;
}

function getId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split('/').filter(Boolean);
  return rest[0] || null;
}

function effectiveCloudApi(store, envCloudApi) {
  const panel = store.getPanelSettings().cloudApi || {};
  return {
    webhookVerifyToken: panel.webhookVerifyToken || envCloudApi.webhookVerifyToken || '',
    appSecret: panel.appSecret || envCloudApi.appSecret || ''
  };
}

async function createApp(overrides = {}) {
  const config = getConfig(overrides);
  let redisClient = null;
  if (config.redisUrl) {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
  }
  const store = await createStore({
    databaseUrl: config.databaseUrl,
    dataFile: config.dataFile,
    auditLogMax: config.auditLogMax,
    maxBackups: config.maxBackups,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    cloudApi: config.cloudApi,
    databaseSslRejectUnauthorized: config.databaseSslRejectUnauthorized
  });
  const eventHub = new EventHub();
  const { loginLimiter, apiLimiter, webhookLimiter, backend: rateLimitBackend, degraded: rateLimitDegraded } = await createRateLimiters({ redis: redisClient });
  const provider = createWhatsappProvider(store, eventHub, {
    mediaDir: config.mediaDir,
    cloudApi: config.cloudApi,
    redis: redisClient
  });
  const webhookQueue = new WebhookQueue((payload) => provider.handleWebhook(payload), { redis: redisClient });
  try {
    if (config.mediaMaxAgeDays > 0) {
      const mediaPrune = pruneOldMedia(config.mediaDir, config.mediaMaxAgeDays, store);
      if (mediaPrune.removed > 0) console.log(`Eski medya temizlendi: ${mediaPrune.removed} dosya`);
    }
    if (config.pruneOrphanMedia) {
      const orphanPrune = pruneOrphanMedia(config.mediaDir, store);
      if (orphanPrune.removed > 0) console.log(`Yetim medya temizlendi: ${orphanPrune.removed} dosya`);
    }
  } catch (error) {
    console.error('Medya temizliği başarısız:', error.message);
  }
  const mediaRetry = startMediaRetryLoop(provider, store);

  async function handler(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/health' && request.method === 'GET') {
        const storeWritable = await store.isHealthy();
        return sendJson(response, storeWritable ? 200 : 503, {
          ok: storeWritable,
          provider: 'cloudapi',
          uptimeSec: Math.floor(process.uptime()),
          storeWritable,
          storeKind: store.kind || 'json',
          rateLimitBackend,
          rateLimitDegraded: Boolean(rateLimitDegraded),
          cloudApiConfigured: Boolean(effectiveCloudApi(store, config.cloudApi).webhookVerifyToken)
        });
      }

      if (pathname.startsWith('/api/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && isCrossSiteRequest(request, config.trustProxy)) {
        return sendJson(response, 403, { error: 'Çapraz site isteği reddedildi' });
      }

      if (pathname.startsWith('/api/')) {
        const ip = (config.trustProxy
          ? (request.headers['x-forwarded-for'] || '').split(',')[0].trim()
          : '') || request.socket.remoteAddress || 'unknown';
        const apiLimit = await apiLimiter.check(ip);
        if (apiLimit.blocked && pathname !== '/api/auth/login') {
          return sendJson(response, 429, {
            error: `Çok fazla istek. ${apiLimit.retryAfterSec} saniye sonra tekrar deneyin.`
          }, { 'Retry-After': String(apiLimit.retryAfterSec) });
        }
      }

      if (pathname === '/api/events') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });
        return eventHub.connect(response, actor);
      }

      if (pathname === '/webhook/whatsapp' && request.method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        const verifyToken = effectiveCloudApi(store, config.cloudApi).webhookVerifyToken;
        if (mode === 'subscribe' && verifyToken && token === verifyToken) {
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          return response.end(String(challenge || ''));
        }
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        return response.end('Forbidden');
      }

      if (pathname === '/webhook/whatsapp' && request.method === 'POST') {
        const webhookIp = (config.trustProxy
          ? (request.headers['x-forwarded-for'] || '').split(',')[0].trim()
          : '') || request.socket.remoteAddress || 'unknown';
        const webhookLimit = await webhookLimiter.check(webhookIp);
        if (webhookLimit.blocked) {
          response.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(webhookLimit.retryAfterSec) });
          return response.end('RATE_LIMITED');
        }
        const raw = await readRawBody(request, config.webhookMaxBytes);
        const appSecret = effectiveCloudApi(store, config.cloudApi).appSecret;
        if ((config.isProd || config.requireWebhookSignature) && !appSecret) {
          response.writeHead(503, { 'Content-Type': 'text/plain' });
          return response.end('Webhook not configured');
        }
        if (appSecret || config.requireWebhookSignature) {
          if (!appSecret) {
            response.writeHead(503, { 'Content-Type': 'text/plain' });
            return response.end('Webhook signature required');
          }
          const sigBuffer = Buffer.from(String(request.headers['x-hub-signature-256'] || ''));
          const expBuffer = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex'));
          const valid = sigBuffer.length === expBuffer.length
            && crypto.timingSafeEqual(sigBuffer, expBuffer);
          if (!valid) {
            response.writeHead(401, { 'Content-Type': 'text/plain' });
            return response.end('Invalid signature');
          }
        }
        let payload = null;
        try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { payload = null; }
        try {
          await webhookQueue.enqueue(payload);
        } catch (error) {
          console.error('Cloud API webhook işleme hatası:', error.message);
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          return response.end('PROCESSING_FAILED');
        }
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        return response.end('EVENT_RECEIVED');
      }

      if (!pathname.startsWith('/api/')) {
        if (!serveStatic(request, response, config.publicDir)) notFound(response);
        return;
      }

      if (routeKey(request.method, pathname) === 'POST /api/auth/login') {
        const input = await readJson(request);
        const ip = (config.trustProxy
          ? (request.headers['x-forwarded-for'] || '').split(',')[0].trim()
          : '') || request.socket.remoteAddress || 'unknown';
        const limiterKey = `${ip}|${String(input.username || '').toLowerCase()}`;
        const limit = await loginLimiter.check(limiterKey);
        if (limit.blocked) {
          return sendJson(response, 429, {
            error: `Çok fazla başarısız deneme. ${limit.retryAfterSec} saniye sonra tekrar deneyin.`
          }, { 'Retry-After': String(limit.retryAfterSec) });
        }
        let user;
        try {
          user = await services.login(store, input.username, input.password, input.totpCode);
        } catch (error) {
          await loginLimiter.fail(limiterKey);
          throw error;
        }
        await loginLimiter.reset(limiterKey);
        const token = createToken(user.id, config.sessionSecret, user.tokenVersion || 0);
        const secureCookie = config.isProd ? '; Secure' : '';
        return sendJson(response, 200, { user: publicUser(user) }, {
          'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secureCookie}`
        });
      }

      if (routeKey(request.method, pathname) === 'POST /api/auth/2fa/setup') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });
        return sendJson(response, 200, services.setup2fa(store, actor));
      }
      if (routeKey(request.method, pathname) === 'POST /api/auth/2fa/verify') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });
        const input = await readJson(request);
        return sendJson(response, 200, services.verify2faSetup(store, actor, input.code));
      }
      if (routeKey(request.method, pathname) === 'POST /api/auth/2fa/disable') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });
        const input = await readJson(request);
        return sendJson(response, 200, await services.disable2fa(store, actor, input.password));
      }

      if (routeKey(request.method, pathname) === 'POST /api/auth/logout') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (actor) {
          store.audit(actor.id, 'auth.logout', 'user', actor.id);
          store.update('users', actor.id, { tokenVersion: (Number(actor.tokenVersion) || 0) + 1 });
        }
        return sendJson(response, 200, { ok: true }, {
          'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
        });
      }

      const actor = getAuthUser(request, store, config.sessionSecret);
      if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });

      if (routeKey(request.method, pathname) === 'POST /api/activity/click') {
        const updated = services.touchPanelClick(store, actor);
        return sendJson(response, 200, {
          ok: true,
          lastPanelClickAt: updated?.lastPanelClickAt || null
        });
      }

      if (routeKey(request.method, pathname) === 'GET /api/settings/cloud-api') {
        return sendJson(response, 200, { settings: services.getCloudApiSettings(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'PATCH /api/settings/cloud-api') {
        return sendJson(response, 200, {
          settings: await services.updateCloudApiSettings(store, actor, provider, await readJson(request), {
            envCloudApi: config.cloudApi,
            persistSecrets: config.persistSecretsInStore
          })
        });
      }

      if (routeKey(request.method, pathname) === 'GET /api/me') {
        return sendJson(response, 200, { user: publicUser(actor) });
      }

      if (routeKey(request.method, pathname) === 'GET /api/departments') {
        return sendJson(response, 200, { departments: services.listDepartments(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'POST /api/departments') {
        return sendJson(response, 201, { department: services.createDepartment(store, actor, await readJson(request)) });
      }
      const departmentId = getId(pathname, '/api/departments/');
      if (departmentId && request.method === 'PATCH') {
        return sendJson(response, 200, { department: services.updateDepartment(store, actor, departmentId, await readJson(request)) });
      }
      if (departmentId && request.method === 'DELETE') {
        return sendJson(response, 200, await services.deleteDepartment(store, actor, departmentId, { mediaDir: config.mediaDir }));
      }

      if (routeKey(request.method, pathname) === 'GET /api/users') {
        return sendJson(response, 200, { users: services.listUsers(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'POST /api/users') {
        return sendJson(response, 201, { user: await services.createUser(store, actor, await readJson(request)) });
      }
      const userId = getId(pathname, '/api/users/');
      if (userId && request.method === 'PATCH') {
        return sendJson(response, 200, { user: await services.updateUser(store, actor, userId, await readJson(request)) });
      }
      if (userId && request.method === 'DELETE' && !pathname.endsWith('/data') && !pathname.endsWith('/export')) {
        return sendJson(response, 200, await services.deleteUser(store, actor, userId, { mediaDir: config.mediaDir }));
      }
      if (userId && pathname.endsWith('/export') && request.method === 'GET') {
        return sendJson(response, 200, { export: services.exportUserData(store, actor, userId) });
      }
      if (userId && pathname.endsWith('/data') && request.method === 'DELETE') {
        return sendJson(response, 200, services.eraseUserData(store, actor, userId, { mediaDir: config.mediaDir }));
      }

      if (routeKey(request.method, pathname) === 'GET /api/templates') {
        return sendJson(response, 200, { templates: services.listTemplates(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'POST /api/templates') {
        return sendJson(response, 201, { template: services.createTemplate(store, actor, await readJson(request)) });
      }
      const templateId = getId(pathname, '/api/templates/');
      if (templateId && request.method === 'PATCH') {
        return sendJson(response, 200, { template: services.updateTemplate(store, actor, templateId, await readJson(request)) });
      }
      if (templateId && request.method === 'DELETE') {
        return sendJson(response, 200, { template: services.deleteTemplate(store, actor, templateId) });
      }

      if (routeKey(request.method, pathname) === 'GET /api/accounts') {
        return sendJson(response, 200, { accounts: await services.listAccounts(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'POST /api/accounts') {
        return sendJson(response, 201, { account: await services.createAccount(store, actor, provider, await readJson(request)) });
      }
      const accountId = getId(pathname, '/api/accounts/');
      if (accountId) {
        const [, action] = pathname.slice('/api/accounts/'.length).split('/').filter(Boolean);
        if (request.method === 'PATCH' && !action) {
          await services.updateAccount(store, actor, accountId, await readJson(request));
          const account = store.find('whatsappAccounts', accountId);
          if (account) await provider.ensureHealthy(account);
          return sendJson(response, 200, { account: services.serializeAccount(store.find('whatsappAccounts', accountId)) });
        }
        if (request.method === 'POST' && action === 'health') {
          return sendJson(response, 200, { account: await services.checkAccountHealth(store, actor, provider, accountId) });
        }
        if (request.method === 'POST' && action === 'disconnect') {
          return sendJson(response, 200, { account: await services.disconnectAccount(store, actor, provider, accountId) });
        }
        if (request.method === 'DELETE' && !action) {
          return sendJson(response, 200, { account: await services.deleteAccount(store, actor, provider, accountId) });
        }
      }

      if (routeKey(request.method, pathname) === 'GET /api/conversations') {
        return sendJson(response, 200, {
          conversations: services.listConversations(store, actor, url.searchParams.get('accountId'))
        });
      }
      const conversationId = getId(pathname, '/api/conversations/');
      if (conversationId && pathname.endsWith('/messages') && request.method === 'GET') {
        return sendJson(response, 200, {
          messages: services.listMessages(store, actor, conversationId, {
            limit: url.searchParams.get('limit'),
            before: url.searchParams.get('before')
          })
        });
      }
      if (conversationId && pathname.endsWith('/read') && request.method === 'POST') {
        return sendJson(response, 200, services.markConversationRead(store, actor, conversationId));
      }
      if (conversationId && pathname.endsWith('/media') && request.method === 'POST') {
        const buffer = await readRawBody(request, config.maxMediaBytes);
        const decodeHeader = (value) => {
          if (!value) return '';
          try { return Buffer.from(String(value), 'base64').toString('utf8'); } catch { return ''; }
        };
        const result = await services.sendMediaMessage(store, actor, provider, config.mediaDir, {
          conversationId,
          buffer,
          mimeType: request.headers['x-mime-type'] || request.headers['content-type'] || 'application/octet-stream',
          fileName: decodeHeader(request.headers['x-file-name']),
          caption: decodeHeader(request.headers['x-caption'])
        });
        eventHub.emit('message.created', { departmentId: result.conversation.departmentId, accountId: result.conversation.accountId, conversationId: result.conversation.id });
        return sendJson(response, 201, result);
      }


      const mediaMessageId = getId(pathname, '/api/media/');
      if (mediaMessageId && request.method === 'GET') {
        const media = services.getMessageMedia(store, actor, config.mediaDir, mediaMessageId);
        return sendFileStream(response, media.absPath, {
          mimeType: media.mimeType,
          fileName: media.fileName,
          inline: media.mediaType !== 'document'
        });
      }

      if (routeKey(request.method, pathname) === 'POST /api/messages/send') {
        const result = await services.sendMessage(store, actor, provider, await readJson(request));
        eventHub.emit('message.created', { departmentId: result.conversation.departmentId, accountId: result.conversation.accountId, conversationId: result.conversation.id });
        return sendJson(response, 201, result);
      }
      const messageId = getId(pathname, '/api/messages/');
      if (messageId && pathname.endsWith('/hide') && request.method === 'POST') {
        return sendJson(response, 200, { message: services.hideMessage(store, actor, messageId) });
      }

      if (routeKey(request.method, pathname) === 'GET /api/reports') {
        return sendJson(response, 200, { reports: services.getReports(store, actor) });
      }
      if (routeKey(request.method, pathname) === 'GET /api/reports/staff-audit') {
        const date = new URL(request.url, 'http://localhost').searchParams.get('date');
        return sendJson(response, 200, { audit: await services.getStaffAudit(store, actor, { date }) });
      }
      if (routeKey(request.method, pathname) === 'GET /api/reports/staff-operations') {
        const date = new URL(request.url, 'http://localhost').searchParams.get('date');
        return sendJson(response, 200, { operations: services.getStaffOperations(store, actor, { date }) });
      }
      if (pathname.startsWith('/api/reports/template-contacts')) {
        const reportUrl = new URL(request.url, 'http://localhost');
        const search = reportUrl.searchParams.get('search') || reportUrl.searchParams.get('phone') || '';
        if (pathname.endsWith('/export') && request.method === 'GET') {
          const log = services.getTemplateContactLog(store, actor, { search });
          if (!log.canExport) {
            return sendJson(response, 403, { error: 'Excel dışa aktarma yetkiniz yok' });
          }
          const csv = services.buildTemplateContactExport(store, log);
          response.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="sablon-iletisim-kayitlari.csv"',
            ...securityHeaders
          });
          return response.end(`\uFEFF${csv}`);
        }
        if (request.method === 'GET') {
          return sendJson(response, 200, {
            log: services.getTemplateContactLog(store, actor, { search })
          });
        }
      }
      if (routeKey(request.method, pathname) === 'GET /api/audit-logs') {
        const limit = new URL(request.url, 'http://localhost').searchParams.get('limit');
        return sendJson(response, 200, { logs: services.listAuditLogs(store, actor, { limit }) });
      }
      if (routeKey(request.method, pathname) === 'POST /api/admin/restore-backup') {
        return sendJson(response, 200, { restore: services.restoreFromBackup(store, actor) });
      }

      throw badRequest('Desteklenmeyen API isteği');
    } catch (error) {
      try {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (actor) {
          services.recordUserError(store, actor, `${request.method} ${new URL(request.url, 'http://localhost').pathname}.failed`, error.message);
        }
      } catch {}
      sendError(response, error, { isProd: config.isProd });
    }
  }

  const server = http.createServer(handler);
  return { config, store, eventHub, provider, server, webhookQueue, redisClient, rateLimitBackend, rateLimitDegraded, mediaRetry };
}

if (require.main === module) {
  createApp().then(({ server, config, eventHub, store, redisClient, webhookQueue, mediaRetry }) => {
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} kullanımda. Farklı PORT deneyin.`);
      } else {
        console.error('Sunucu hatası:', error.message);
      }
      process.exit(1);
    });
    server.listen(config.port, () => {
      console.log(`WhatsApp Cloud API paneli http://localhost:${config.port} adresinde çalışıyor`);
    });

    const shutdown = async (signal) => {
      console.log(`${signal} alındı, sunucu kapatılıyor...`);
      mediaRetry?.stop?.();
      webhookQueue?.stop?.();
      eventHub.close();
      try { await store.close?.(); } catch {}
      try { await redisClient?.quit(); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApp };