const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { CloudApiProvider } = require('../src/whatsapp/cloudApiProvider');
const { normalizePhone } = require('../src/phone');
const { login, request, startTestServer } = require('./helpers');
const services = require('../src/services');

function tempStoreDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wp-panel-${name}-`));
}

async function seedCloudAccount(store, overrides = {}) {
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: `staff-${Math.random().toString(36).slice(2, 8)}`,
    fullName: 'Flow Staff',
    passwordHash: 'not-used',
    role: 'staff',
    departmentId: department.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Cloud Hat',
    phoneNumber: '905551112233',
    provider: 'cloudapi',
    phoneNumberId: '123456789',
    accessToken: 'token',
    status: 'connected',
    connectionHealth: 'healthy',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
  return { department, staff, account };
}

test('normalizePhone yerel ve uluslararası biçimleri tek formata indirger', () => {
  assert.equal(normalizePhone('0505 110 32 97'), '905051103297');
  assert.equal(normalizePhone('+90 505 110 3297'), '905051103297');
  assert.equal(normalizePhone('905051103297'), '905051103297');
  assert.equal(normalizePhone('5051103297'), '905051103297');
  assert.equal(normalizePhone('00905051103297'), '905051103297');
});

test('Cloud API aynı kişiden gelen mesajlar tek sohbette toplanır', async () => {
  const directory = tempStoreDir('flow-dedupe');
  const store = new Store(path.join(directory, 'app.json'));
  const { account } = await seedCloudAccount(store);
  const provider = new CloudApiProvider(store, new EventHub(), { cloudApi: { skipHealthPing: true } });
  store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: '05051103297',
    customerName: '05051103297',
    status: 'open',
    unreadCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: null
  });
  await provider.handleWebhook({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '123456789' },
          messages: [{
            from: '905051103297',
            id: 'wamid.1',
            timestamp: '1',
            type: 'text',
            text: { body: 'Merhaba' }
          }]
        }
      }]
    }]
  });
  assert.equal(store.all('conversations').length, 1);
});

test('logout token sürümünü artırarak eski oturumu geçersiz kılar', async () => {
  const app = await startTestServer('flow-logout');
  try {
    const cookie = await login(app.baseUrl);
    const before = await request(app.baseUrl, 'GET', '/api/me', null, cookie);
    assert.equal(before.response.status, 200);
    await request(app.baseUrl, 'POST', '/api/auth/logout', null, cookie);
    const after = await request(app.baseUrl, 'GET', '/api/me', null, cookie);
    assert.equal(after.response.status, 401);
  } finally {
    await app.close();
  }
});

test('login art arda başarısız denemelerde rate-limit (429) uygular', async () => {
  const app = await startTestServer('flow-ratelimit');
  try {
    for (let i = 0; i < 5; i += 1) {
      const fail = await request(app.baseUrl, 'POST', '/api/auth/login', { username: 'admin', password: 'yanlis' });
      assert.equal(fail.response.status, 401);
    }
    const blocked = await request(app.baseUrl, 'POST', '/api/auth/login', { username: 'admin', password: 'yanlis' });
    assert.equal(blocked.response.status, 429);
  } finally {
    await app.close();
  }
});

test('sendMediaMessage giden medya kaydı oluşturur ve dosyayı diske yazar', async () => {
  const directory = tempStoreDir('flow-media-send');
  const store = new Store(path.join(directory, 'app.json'));
  const { account } = await seedCloudAccount(store);
  const admin = store.all('users').find((user) => user.role === 'admin');
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: '905051103297',
    customerName: 'Test',
    status: 'open',
    unreadCount: 0,
    lastInboundAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = {
    name: 'cloudapi',
    sendMedia: async () => ({
      providerMessageId: 'cloud-media-1',
      status: 'sent',
      sentAt: new Date().toISOString()
    })
  };
  const mediaDir = path.join(directory, 'media');
  const buffer = Buffer.from('PNGDATA');
  const result = await services.sendMediaMessage(store, admin, provider, mediaDir, {
    conversationId: conversation.id,
    buffer,
    mimeType: 'image/png',
    fileName: 'foto.png',
    caption: 'Bak bu resim'
  });
  assert.equal(result.message.mediaType, 'image');
  const onDisk = path.resolve(mediaDir, result.message.mediaFile);
  assert.ok(fs.existsSync(onDisk));
});

test('getMessageMedia RBAC: başka departmanın personeli medyaya erişemez', async () => {
  const directory = tempStoreDir('flow-media-rbac');
  const store = new Store(path.join(directory, 'app.json'));
  const { account } = await seedCloudAccount(store);
  const admin = store.all('users').find((user) => user.role === 'admin');
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: '905051103297',
    customerName: 'Test',
    status: 'open',
    unreadCount: 0,
    lastInboundAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = {
    sendMedia: async () => ({
      providerMessageId: 'cloud-media-2',
      status: 'sent',
      sentAt: new Date().toISOString()
    })
  };
  const mediaDir = path.join(directory, 'media');
  const result = await services.sendMediaMessage(store, admin, provider, mediaDir, {
    conversationId: conversation.id,
    buffer: Buffer.from('DOC'),
    mimeType: 'application/pdf',
    fileName: 'sozlesme.pdf',
    caption: ''
  });
  const otherDept = store.create('departments', {
    name: 'Diğer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const outsider = store.create('users', {
    username: 'disardaki',
    fullName: 'Dışarıdaki',
    passwordHash: 'x',
    role: 'staff',
    departmentId: otherDept.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  assert.throws(
    () => services.getMessageMedia(store, outsider, mediaDir, result.message.id),
    (error) => error.statusCode === 403 || error.statusCode === 404
  );
});

test('listMessages limit parametresi çalışır', async () => {
  const directory = tempStoreDir('flow-limit');
  const store = new Store(path.join(directory, 'app.json'));
  const { account, staff } = await seedCloudAccount(store);
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: '905051103297',
    customerName: 'Test',
    status: 'open',
    unreadCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  for (let i = 0; i < 5; i += 1) {
    store.create('messages', {
      conversationId: conversation.id,
      accountId: account.id,
      userId: account.userId,
      departmentId: account.departmentId,
      direction: 'in',
      text: `m${i}`,
      providerMessageId: `id-${i}`,
      status: 'received',
      hidden: false,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      updatedAt: new Date(Date.now() + i * 1000).toISOString()
    });
  }
  const limited = services.listMessages(store, staff, conversation.id, { limit: 2 });
  assert.equal(limited.length, 2);
});