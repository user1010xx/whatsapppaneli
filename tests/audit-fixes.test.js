const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { CloudApiProvider } = require('../src/whatsapp/cloudApiProvider');
const { managerMayEditTarget } = require('../src/rbac');
const { verifyTotp, generateTotpSecret, totpAt } = require('../src/totp');
const { pruneOldMedia } = require('../src/mediaMaintenance');
const services = require('../src/services');
const { startTestServer, login, request } = require('./helpers');

async function freshStore(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp-audit-${name}-`));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  return { store, directory };
}

test('webhookDedup aynı providerMessageId ikinci kez işlenmez', async () => {
  const { store } = await freshStore('dedup');
  assert.equal(store.claimWebhookDedup('wamid.X'), true);
  assert.equal(store.claimWebhookDedup('wamid.X'), false);
});

test('managerMayEditTarget yönetici olmayan için kısıt uygulanmaz', () => {
  const admin = { role: 'admin' };
  const manager = { role: 'manager' };
  const staff = { role: 'staff' };
  assert.equal(managerMayEditTarget(admin, staff), true);
  assert.equal(managerMayEditTarget(manager, staff), true);
  assert.equal(managerMayEditTarget(manager, { role: 'manager' }), false);
});

test('TOTP üretim ve doğrulama çalışır', () => {
  const secret = generateTotpSecret();
  const code = totpAt(secret, Date.now());
  assert.equal(verifyTotp(secret, code), true);
  assert.equal(verifyTotp(secret, '000000'), false);
});

test('login tokenVersion artırır ve eski oturumu geçersiz kılar', async () => {
  const app = await startTestServer('login-tv');
  const first = await request(app.baseUrl, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const oldCookie = first.cookie;
  const meOld = await request(app.baseUrl, 'GET', '/api/me', null, oldCookie);
  assert.equal(meOld.response.status, 200);

  await request(app.baseUrl, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const meStale = await request(app.baseUrl, 'GET', '/api/me', null, oldCookie);
  assert.equal(meStale.response.status, 401);
  await app.close();
});

test('2FA kurulum ve doğrulama akışı', async () => {
  const app = await startTestServer('2fa');
  const cookie = await login(app.baseUrl);
  const setup = await request(app.baseUrl, 'POST', '/api/auth/2fa/setup', null, cookie);
  assert.equal(setup.response.status, 200);
  assert.ok(setup.data.secret);
  const code = totpAt(setup.data.secret, Date.now());
  const verify = await request(app.baseUrl, 'POST', '/api/auth/2fa/verify', { code }, cookie);
  assert.equal(verify.response.status, 200);
  assert.equal(verify.data.enabled, true);
  await app.close();
});

test('gelen medya indirilemezse media_pending kaydı oluşur', async () => {
  const { store } = await freshStore('media-pending');
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: 'staff-media',
    fullName: 'Staff',
    passwordHash: 'x',
    role: 'staff',
    departmentId: department.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Hat',
    phoneNumber: '905551112233',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  store.updatePanelSettings({
    cloudApi: {
      ...store.getPanelSettings().cloudApi,
      phoneNumberId: '123456789',
      accessToken: 'token'
    }
  });

  const provider = new CloudApiProvider(store, new EventHub(), { cloudApi: { phoneNumberId: '123456789' } });
  provider.downloadIncomingMedia = async () => null;
  const payload = {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '123456789' },
          messages: [{
            from: '905559998877',
            id: 'wamid.MEDIA1',
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'image',
            image: { id: 'cloud-media-1', mime_type: 'image/jpeg' }
          }]
        }
      }]
    }]
  };
  const result = await provider.handleWebhook(payload);
  assert.equal(result.processed, 1);
  const message = store.all('messages').find((m) => m.providerMessageId === 'wamid.MEDIA1');
  assert.equal(message.status, 'media_pending');
  assert.equal(message.mediaPending, true);
});

test('pruneOldMedia referanslı dosyayı silmez', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-media-prune-'));
  const mediaDir = path.join(directory, 'media');
  const accountDir = path.join(mediaDir, 'acc-1');
  fs.mkdirSync(accountDir, { recursive: true });
  const filePath = path.join(accountDir, 'old.jpg');
  fs.writeFileSync(filePath, 'x');
  const oldTime = Date.now() - (100 * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, oldTime / 1000, oldTime / 1000);

  const store = {
    all(collection) {
      if (collection === 'messages') {
        return [{ mediaFile: 'acc-1/old.jpg' }];
      }
      return [];
    }
  };

  const result = pruneOldMedia(mediaDir, 90, store);
  assert.equal(result.skippedReferenced, 1);
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(filePath));
});

test('deleteUser audit kayıtlarını siler yerine anonimleştirir', async () => {
  const app = await startTestServer('audit-anon');
  const cookie = await login(app.baseUrl);
  const dept = app.store.all('departments')[0];
  const created = await request(app.baseUrl, 'POST', '/api/users', {
    username: 'audit-user',
    fullName: 'Audit User',
    password: 'Secret12a',
    role: 'staff',
    departmentId: dept.id
  }, cookie);
  const userId = created.data.user.id;
  app.store.audit(userId, 'message.send', 'message', 'msg-1');
  await request(app.baseUrl, 'DELETE', `/api/users/${userId}`, null, cookie);
  const logs = app.store.all('auditLogs').filter((log) => log.action === 'message.send');
  assert.ok(logs.some((log) => log.metadata?.actorErased));
  await app.close();
});