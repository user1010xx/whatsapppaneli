const http = require('node:http');
const { URL } = require('node:url');
const { getConfig } = require('./config');
const { Store } = require('./storage');
const { createToken } = require('./auth');
const { EventHub } = require('./eventHub');
const { createWhatsappProvider } = require('./whatsapp');
const {
  badRequest,
  getAuthUser,
  notFound,
  readJson,
  sendError,
  sendJson,
  serveStatic
} = require('./http');
const { publicUser } = require('./rbac');
const services = require('./services');

function routeKey(method, pathname) {
  return `${method.toUpperCase()} ${pathname}`;
}

function getId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split('/').filter(Boolean);
  return rest[0] || null;
}

async function createApp(overrides = {}) {
  const config = getConfig(overrides);
  const store = new Store(config.dataFile);
  await store.init({ adminUsername: config.adminUsername, adminPassword: config.adminPassword });
  const eventHub = new EventHub();
  const provider = createWhatsappProvider(config.whatsappProvider, store, eventHub, {
    sessionDir: config.whatsappSessionDir
  });

  async function handler(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname === '/api/events') {
        const actor = getAuthUser(request, store, config.sessionSecret);
        if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });
        return eventHub.connect(response, actor.id);
      }
      if (!pathname.startsWith('/api/')) {
        if (!serveStatic(request, response, config.publicDir)) notFound(response);
        return;
      }

      if (routeKey(request.method, pathname) === 'POST /api/auth/login') {
        const input = await readJson(request);
        const user = await services.login(store, input.username, input.password);
        const token = createToken(user.id, config.sessionSecret);
        const secureCookie = config.isProd ? '; Secure' : '';
        return sendJson(response, 200, { user: publicUser(user) }, {
          'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secureCookie}`
        });
      }

      if (routeKey(request.method, pathname) === 'POST /api/auth/logout') {
        return sendJson(response, 200, { ok: true }, {
          'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
        });
      }

      const actor = getAuthUser(request, store, config.sessionSecret);
      if (!actor) return sendJson(response, 401, { error: 'Oturum gerekli' });

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
      if (userId && request.method === 'DELETE') {
        return sendJson(response, 200, { user: services.deleteUser(store, actor, userId) });
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
          return sendJson(response, 200, { account: await services.updateAccount(store, actor, accountId, await readJson(request)) });
        }
        if (request.method === 'POST' && action === 'confirm-qr') {
          return sendJson(response, 200, { account: await services.confirmAccountQr(store, actor, provider, accountId) });
        }
        if (request.method === 'POST' && (action === 'refresh-qr' || action === 'qr')) {
          return sendJson(response, 200, { account: await services.refreshAccountQr(store, actor, provider, accountId) });
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
        return sendJson(response, 200, { messages: services.listMessages(store, actor, conversationId) });
      }

      if (routeKey(request.method, pathname) === 'POST /api/messages/send') {
        const result = await services.sendMessage(store, actor, provider, await readJson(request));
        eventHub.emit('message.created', result);
        return sendJson(response, 201, result);
      }
      if (routeKey(request.method, pathname) === 'POST /api/messages/receive') {
        const result = services.receiveMessage(store, actor, await readJson(request));
        eventHub.emit('message.created', result);
        return sendJson(response, 201, result);
      }
      const messageId = getId(pathname, '/api/messages/');
      if (messageId && pathname.endsWith('/hide') && request.method === 'POST') {
        return sendJson(response, 200, { message: services.hideMessage(store, actor, messageId) });
      }

      if (routeKey(request.method, pathname) === 'GET /api/reports') {
        return sendJson(response, 200, { reports: services.getReports(store, actor) });
      }

      throw badRequest('Desteklenmeyen API isteği');
    } catch (error) {
      sendError(response, error);
    }
  }

  const server = http.createServer(handler);
  return { config, store, eventHub, provider, server };
}

if (require.main === module) {
  createApp().then(({ server, config }) => {
    server.listen(config.port, () => {
      console.log(`WhatsApp personel paneli http://localhost:${config.port} adresinde çalışıyor`);
    });
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApp };