const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { CloudApiProvider } = require('../src/whatsapp/cloudApiProvider');
const { createApp } = require('../src/server');
const services = require('../src/services');

async function freshStore(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp-panel-${name}-`));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({
    adminUsername: 'admin',
    adminPassword: 'admin123',
    cloudApi: {
      accessToken: 'test-token',
      phoneNumberId: '123456789',
      webhookVerifyToken: 'verify-123',
      skipHealthPing: true
    }
  });
  return { store, directory };
}

function makeStaffAndAccount(store, overrides = {}) {
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: `staff-${Math.random().toString(36).slice(2, 8)}`,
    fullName: 'Cloud Staff',
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
    status: 'connected',
    connectionHealth: 'healthy',
    qrCode: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  });
  return { department, staff, account };
}

test('Cloud API handleWebhook gelen mesajı tek sohbet+mesaj olarak kaydeder ve pencereyi açar', async () => {
  const { store } = await freshStore('cloudapi-inbound');
  const { account } = makeStaffAndAccount(store);
  const provider = new CloudApiProvider(store, new EventHub(), { cloudApi: { phoneNumberId: '' } });
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '123456789' },
          contacts: [{ wa_id: '905559998877', profile: { name: 'Müşteri' } }],
          messages: [{ from: '905559998877', id: 'wamid.AAA', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Merhaba' } }]
        }
      }]
    }]
  };
  const first = await provider.handleWebhook(payload);
  assert.equal(first.processed, 1);
  // Dedup: aynı providerMessageId ikinci kez işlenmez.
  const second = await provider.handleWebhook(payload);
  assert.equal(second.processed, 0);

  const conversations = store.all('conversations').filter((c) => c.accountId === account.id);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].customerName, 'Müşteri');
  assert.ok(conversations[0].lastInboundAt, 'lastInboundAt set edilmeli (24s pencere)');
  const messages = store.all('messages').filter((m) => m.conversationId === conversations[0].id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'Merhaba');
  assert.equal(messages[0].direction, 'in');
});

test('Cloud API statü webhook giden mesajı sent->delivered->read yükseltir, düşürmez', async () => {
  const { store } = await freshStore('cloudapi-status');
  const { account } = makeStaffAndAccount(store);
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905559998877', customerName: 'X', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: null
  });
  const message = store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: account.userId, direction: 'out',
    text: 'Selam', templateId: null, providerMessageId: 'wamid.OUT1', status: 'sent', hidden: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const provider = new CloudApiProvider(store, new EventHub(), {});
  const statusPayload = (s) => ({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '123456789' }, statuses: [{ id: 'wamid.OUT1', status: s, timestamp: '1' }] } }] }]
  });
  await provider.handleWebhook(statusPayload('delivered'));
  assert.equal(store.find('messages', message.id).status, 'delivered');
  await provider.handleWebhook(statusPayload('read'));
  assert.equal(store.find('messages', message.id).status, 'read');
  // Düşürme denemesi: read -> delivered yok sayılır.
  await provider.handleWebhook(statusPayload('delivered'));
  assert.equal(store.find('messages', message.id).status, 'read');
});

test('sendMessage: pencere kapalıyken cloudapi serbest metni 409 ile engeller, şablonla geçer', async () => {
  const { store } = await freshStore('cloudapi-window');
  const { account, staff } = makeStaffAndAccount(store);
  const admin = store.all('users').find((u) => u.role === 'admin');
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905559998877', customerName: 'X', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessageAt: null, lastInboundAt: null // pencere hiç açılmamış
  });
  const template = services.createTemplate(store, admin, {
    title: 'Karşılama', body: 'Merhaba {{ad}}', departmentId: account.departmentId,
    metaTemplateName: 'hello_world', language: 'tr'
  });
  // Ağ çağrısı yapmayan stub provider.
  const calls = { send: 0, template: 0 };
  const provider = {
    name: 'cloudapi',
    sendMessage: async () => { calls.send += 1; return { providerMessageId: 'm1', status: 'sent', sentAt: new Date().toISOString(), text: 'x' }; },
    sendTemplate: async () => { calls.template += 1; return { providerMessageId: 't1', status: 'sent', sentAt: new Date().toISOString() }; }
  };
  // Serbest metin -> 409.
  await assert.rejects(
    () => services.sendMessage(store, staff, provider, { accountId: account.id, conversationId: conversation.id, text: 'serbest metin' }),
    (err) => err.statusCode === 409
  );
  assert.equal(calls.send, 0);
  // Şablon (metaTemplateName dolu) -> geçer.
  const result = await services.sendMessage(store, staff, provider, {
    accountId: account.id, conversationId: conversation.id, text: 'placeholder', templateId: template.id, variables: { ad: 'Ali' }
  });
  assert.equal(calls.template, 1);
  assert.equal(result.message.direction, 'out');
});

test('sendMessage: pencere açıkken cloudapi serbest metin gönderir', async () => {
  const { store } = await freshStore('cloudapi-window-open');
  const { account, staff } = makeStaffAndAccount(store);
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905559998877', customerName: 'X', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessageAt: null, lastInboundAt: new Date().toISOString() // pencere açık
  });
  let sent = 0;
  const provider = { name: 'cloudapi', sendMessage: async () => { sent += 1; return { providerMessageId: 'm1', status: 'sent', sentAt: new Date().toISOString(), text: 'ok' }; } };
  const result = await services.sendMessage(store, staff, provider, { accountId: account.id, conversationId: conversation.id, text: 'serbest' });
  assert.equal(sent, 1);
  assert.equal(result.message.status, 'sent');
});

test('markConversationRead seenByUserId+seenAt yazar; getStaffAudit doğru sayar', async () => {
  const { store } = await freshStore('cloudapi-audit');
  const { account, staff } = makeStaffAndAccount(store);
  const admin = store.all('users').find((u) => u.role === 'admin');
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905559998877', customerName: 'X', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: null
  });
  store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: null, direction: 'in', text: 'soru',
    templateId: null, providerMessageId: 'in1', status: 'received', hidden: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const read = services.markConversationRead(store, staff, conversation.id);
  assert.equal(read.updated, 1);
  const inbound = store.all('messages').find((m) => m.providerMessageId === 'in1');
  assert.equal(inbound.seenByUserId, staff.id);
  assert.ok(inbound.seenAt, 'seenAt yazılmalı');

  // Personelin giden yanıtı.
  store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: staff.id, direction: 'out', text: 'cevap',
    templateId: null, providerMessageId: 'out1', status: 'sent', hidden: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const audit = await services.getStaffAudit(store, admin);
  const row = audit.byUser.find((r) => r.user.id === staff.id);
  assert.ok(row, 'personel denetim satırı olmalı');
  assert.equal(row.sentCount, 1);
  assert.equal(row.seenCount, 1);

  // Personel kendi denetim raporunu göremez.
  await assert.rejects(() => services.getStaffAudit(store, staff), (err) => err.statusCode === 403);
});

test('getStaffAudit son görülme süresini son panel tıklamasına göre hesaplar', async () => {
  const { store } = await freshStore('cloudapi-panel-click');
  const { staff } = makeStaffAndAccount(store);
  const admin = store.all('users').find((u) => u.role === 'admin');
  const eightMinutesAgo = new Date(Date.now() - 8 * 60 * 1000).toISOString();
  store.update('users', staff.id, { lastPanelClickAt: eightMinutesAgo });

  const audit = await services.getStaffAudit(store, admin);
  const row = audit.byUser.find((item) => item.user.id === staff.id);
  assert.ok(row?.lastPanelClickAt);
  assert.ok(row.inactiveMs >= 8 * 60 * 1000 - 2000);
  assert.ok(row.inactiveMs <= 8 * 60 * 1000 + 2000);

  services.touchPanelClick(store, staff);
  const refreshed = store.find('users', staff.id);
  assert.ok(refreshed.lastPanelClickAt);
  assert.ok(Date.parse(refreshed.lastPanelClickAt) >= Date.now() - 3000);
});

test('getStaffAudit tarih filtresine göre günlük mesaj metriklerini sayar', async () => {
  const { store } = await freshStore('cloudapi-audit-date');
  const { account, staff } = makeStaffAndAccount(store);
  const admin = store.all('users').find((u) => u.role === 'admin');
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905551112233', customerName: 'Y', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: null
  });
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString();
  store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: staff.id, direction: 'out', text: 'dün',
    templateId: null, providerMessageId: 'out-yesterday', status: 'sent', hidden: false,
    createdAt: yesterday, updatedAt: yesterday
  });
  store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: staff.id, direction: 'out', text: 'bugün',
    templateId: null, providerMessageId: 'out-today', status: 'sent', hidden: false,
    createdAt: today, updatedAt: today
  });

  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
  const yesterdayKey = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
  const todayAudit = await services.getStaffAudit(store, admin, { date: todayKey });
  const yesterdayAudit = await services.getStaffAudit(store, admin, { date: yesterdayKey });
  const todayRow = todayAudit.byUser.find((item) => item.user.id === staff.id);
  const yesterdayRow = yesterdayAudit.byUser.find((item) => item.user.id === staff.id);
  assert.equal(todayAudit.date, todayKey);
  assert.equal(todayRow.sentCount, 1);
  assert.equal(yesterdayRow.sentCount, 1);
});

test('getStaffAudit mesaj aktivitesini son görülme yedeği olarak kullanır', async () => {
  const { store } = await freshStore('cloudapi-panel-fallback');
  const { account, staff } = makeStaffAndAccount(store);
  const admin = store.all('users').find((u) => u.role === 'admin');
  store.update('users', staff.id, { lastPanelClickAt: null, lastActivityAt: null, lastLoginAt: null });
  const conversation = store.create('conversations', {
    accountId: account.id, userId: account.userId, departmentId: account.departmentId,
    customerPhone: '905559998877', customerName: 'X', remoteJid: null, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: null
  });
  const sentAt = new Date().toISOString();
  store.create('messages', {
    conversationId: conversation.id, accountId: account.id, userId: account.userId,
    departmentId: account.departmentId, senderUserId: staff.id, direction: 'out', text: 'merhaba',
    templateId: null, providerMessageId: 'out-fallback', status: 'sent', hidden: false,
    createdAt: sentAt, updatedAt: sentAt
  });

  const audit = await services.getStaffAudit(store, admin);
  const row = audit.byUser.find((item) => item.user.id === staff.id);
  assert.equal(row.lastPanelClickAt, sentAt);
  assert.ok(row.inactiveMs !== null);
});

test('webhook GET doğrulaması hub.challenge yankılar; yanlış token 403', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-cloudapi-verify-'));
  const app = await createApp({
    port: 0,
    dataFile: path.join(directory, 'app.json'),
    sessionSecret: 'secret-verify',
    adminUsername: 'admin',
    adminPassword: 'admin123',
    cloudApi: { webhookVerifyToken: 'verify-123', skipHealthPing: true }
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const ok = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=42`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '42');
    const bad = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
    assert.equal(bad.status, 403);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
