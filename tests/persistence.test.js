const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { getConfig } = require('../src/config');
const { Store } = require('../src/storage');
const services = require('../src/services');
const { login, request, startTestServer } = require('./helpers');
const { pruneOldMedia } = require('../src/mediaMaintenance');

async function freshStore(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp-panel-${name}-`));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({
    adminUsername: 'admin',
    adminPassword: 'admin123',
    cloudApi: { accessToken: 't', phoneNumberId: '1' }
  });
  return { store, directory };
}

test('üretim ortamında DATABASE_URL zorunludur', () => {
  const previous = process.env.NODE_ENV;
  const previousDb = process.env.DATABASE_URL;
  process.env.NODE_ENV = 'production';
  delete process.env.DATABASE_URL;
  try {
    assert.throws(
      () => getConfig({
        sessionSecret: 'prod-secret',
        adminUsername: 'prod-admin',
        adminPassword: 'ProdPass123!'
      }),
      /DATABASE_URL/
    );
  } finally {
    process.env.NODE_ENV = previous;
    if (previousDb) process.env.DATABASE_URL = previousDb;
    else delete process.env.DATABASE_URL;
  }
});

test('deleteUser mesaj ve sohbet kayıtlarını silmez', async () => {
  const app = await startTestServer('persist-user');
  try {
    const cookie = await login(app.baseUrl);
    const dept = app.store.all('departments')[0];
    const created = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'persist-user',
      fullName: 'Persist User',
      password: 'Secret12a',
      role: 'staff',
      departmentId: dept.id
    }, cookie);
    const userId = created.data.user.id;
    const account = app.store.create('whatsappAccounts', {
      userId,
      departmentId: dept.id,
      label: 'Hat',
      phoneNumber: '905551112233',
      provider: 'cloudapi',
      status: 'connected',
      active: true
    });
    const conversation = app.store.create('conversations', {
      accountId: account.id,
      userId,
      departmentId: dept.id,
      customerPhone: '905559999999',
      customerName: 'Müşteri',
      status: 'open'
    });
    const message = app.store.create('messages', {
      conversationId: conversation.id,
      accountId: account.id,
      userId,
      departmentId: dept.id,
      senderUserId: userId,
      direction: 'out',
      text: 'Kalıcı mesaj',
      templateId: null,
      status: 'sent',
      hidden: false
    });

    const deleted = await request(app.baseUrl, 'DELETE', `/api/users/${userId}`, null, cookie);
    assert.equal(deleted.response.status, 200);
    assert.equal(app.store.find('users', userId), null);
    assert.equal(app.store.find('messages', message.id)?.text, 'Kalıcı mesaj');
    const archivedConversation = app.store.find('conversations', conversation.id);
    assert.equal(archivedConversation?.status, 'archived');
    assert.equal(archivedConversation?.archivedUserId, userId);
  } finally {
    await app.close();
  }
});

test('deleteDepartment departman mesajlarını silmez', async () => {
  const { store } = await freshStore('persist-dept');
  const admin = store.all('users').find((user) => user.role === 'admin');
  const deptA = store.all('departments')[0];
  const deptB = store.create('departments', {
    name: 'Silinecek',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const staff = store.create('users', {
    username: 'dept-staff',
    fullName: 'Dept Staff',
    passwordHash: 'x',
    role: 'staff',
    departmentId: deptB.id,
    active: true
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: deptB.id,
    label: 'Hat',
    phoneNumber: '905551100001',
    provider: 'cloudapi',
    status: 'connected',
    active: true
  });
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: deptB.id,
    customerPhone: '905551111111',
    customerName: 'Ali',
    status: 'open'
  });
  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: deptB.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'Departman mesajı',
    templateId: null,
    status: 'sent',
    hidden: false
  });

  await services.deleteDepartment(store, admin, deptB.id);
  assert.equal(store.find('departments', deptB.id), null);
  assert.equal(store.find('messages', message.id)?.text, 'Departman mesajı');
  assert.equal(store.find('conversations', conversation.id)?.customerPhone, '905551111111');
});

test('auditLogMax=0 denetim kayıtlarını budamaz', () => {
  const { BaseStore } = require('../src/storage/baseStore');
  const store = new BaseStore({ auditLogMax: 0 });
  store.data.auditLogs = Array.from({ length: 6000 }, (_, index) => ({
    id: String(index),
    action: 'test',
    createdAt: new Date().toISOString()
  }));
  store.pruneAuditLogs();
  assert.equal(store.data.auditLogs.length, 6000);
});

test('mediaMaxAgeDays=0 eski medyayı silmez', () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-media-age-'));
  const filePath = path.join(mediaDir, 'old.bin');
  fs.writeFileSync(filePath, 'x');
  const past = Date.now() - (120 * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, past / 1000, past / 1000);
  const result = pruneOldMedia(mediaDir, 0, null);
  assert.equal(result.removed, 0);
  assert.ok(fs.existsSync(filePath));
});