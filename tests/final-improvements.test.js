const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebhookQueue } = require('../src/webhookQueue');
const { pruneOrphanMedia } = require('../src/mediaMaintenance');
const { startMediaRetryLoop } = require('../src/mediaRetry');
const { securityHeaders } = require('../src/http');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { CloudApiProvider } = require('../src/whatsapp/cloudApiProvider');
const { createStore } = require('../src/storage');

test('WebhookQueue bellek modunda işi tamamlar', async () => {
  const seen = [];
  const queue = new WebhookQueue(async (payload) => {
    seen.push(payload.id);
    return { ok: true };
  });
  const result = await queue.enqueue({ id: 'job-1' });
  assert.deepEqual(seen, ['job-1']);
  assert.equal(result.ok, true);
});

test('pruneOrphanMedia DB referansı olmayan dosyayı siler', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-orphan-'));
  const mediaDir = path.join(directory, 'media');
  const accountDir = path.join(mediaDir, 'acc-1');
  fs.mkdirSync(accountDir, { recursive: true });
  const orphan = path.join(accountDir, 'orphan.jpg');
  fs.writeFileSync(orphan, 'x');
  const store = {
    all(collection) {
      return collection === 'messages' ? [{ mediaFile: 'acc-1/kept.jpg' }] : [];
    }
  };
  const result = pruneOrphanMedia(mediaDir, store);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(orphan), false);
});

test('retryPendingMedia başarılı indirmede mesajı received yapar', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-retry-'));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: 'retry-staff',
    fullName: 'Retry Staff',
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
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone: '905559998877',
    customerName: 'Müşteri',
    status: 'open',
    unreadCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    direction: 'in',
    text: '[Fotoğraf — indiriliyor]',
    providerMessageId: 'wamid.RETRY1',
    status: 'media_pending',
    mediaPending: true,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    metadata: { cloudMediaId: 'meta-media-1', mediaRetryCount: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const provider = new CloudApiProvider(store, new EventHub(), {
    mediaDir: path.join(directory, 'media'),
    cloudApi: { accessToken: 'token', phoneNumberId: '123' }
  });
  provider.downloadIncomingMedia = async () => ({
    mediaType: 'image',
    mediaFile: path.posix.join(account.id, 'retry.jpg'),
    mimeType: 'image/jpeg',
    fileName: 'retry.jpg',
    mediaSize: 4
  });

  const ok = await provider.retryPendingMedia(message);
  assert.equal(ok, true);
  const updated = store.find('messages', message.id);
  assert.equal(updated.status, 'received');
  assert.equal(updated.mediaPending, false);
  assert.ok(updated.mediaFile);
});

test('media retry loop pending mesajları işler', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-retry-loop-'));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: 'loop-staff',
    fullName: 'Loop',
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
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone: '905559998877',
    customerName: 'Müşteri',
    status: 'open',
    unreadCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    direction: 'in',
    text: '[Fotoğraf — indiriliyor]',
    providerMessageId: 'wamid.LOOP1',
    status: 'media_pending',
    mediaPending: true,
    mediaType: 'image',
    metadata: { cloudMediaId: 'meta-loop-1', mediaRetryCount: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const provider = new CloudApiProvider(store, new EventHub(), { mediaDir: path.join(directory, 'media') });
  provider.retryPendingMedia = async () => {
    store.update('messages', message.id, { status: 'received', mediaPending: false, mediaFile: 'acc/x.jpg' });
    return true;
  };

  const loop = startMediaRetryLoop(provider, store, { intervalMs: 40 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  loop.stop();
  assert.equal(store.find('messages', message.id).status, 'received');
});

test('CSP unsafe-inline script içermez', () => {
  assert.ok(securityHeaders['Content-Security-Policy'].includes("script-src 'self'"));
  assert.equal(securityHeaders['Content-Security-Policy'].includes('unsafe-inline'), false);
});

const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

test('PostgresStore arama indeks tablolarını senkronlar', { skip: !databaseUrl }, async () => {
  const store = await createStore({
    databaseUrl,
    adminUsername: 'idx-admin',
    adminPassword: 'Secret12a'
  });
  const dept = store.create('departments', { name: 'Index Dept', active: true }, false);
  const conv = store.create('conversations', {
    accountId: 'acc-idx',
    userId: 'user-idx',
    departmentId: dept.id,
    customerPhone: '905551112233',
    status: 'open',
    unreadCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, false);
  store.create('messages', {
    conversationId: conv.id,
    accountId: 'acc-idx',
    userId: 'user-idx',
    departmentId: dept.id,
    direction: 'out',
    senderUserId: 'user-idx',
    text: 'test',
    status: 'sent',
    hidden: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, false);
  await store.save();
  await store._saveChain;

  const messageCount = await store.pool.query('SELECT COUNT(*)::int AS count FROM app_messages_index');
  const conversationCount = await store.pool.query('SELECT COUNT(*)::int AS count FROM app_conversations_index');
  assert.ok(messageCount.rows[0].count >= 1);
  assert.ok(conversationCount.rows[0].count >= 1);
  await store.close();
});