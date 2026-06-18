const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const services = require('../src/services');

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

test('getStaffOperations şablon bazlı farklı kişi ve ilk iletişim sayar', async () => {
  const { store } = await freshStore('staff-ops');
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: 'personel1',
    fullName: 'Personel 1',
    passwordHash: 'x',
    role: 'staff',
    departmentId: department.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const linkTemplate = store.create('templates', {
    title: 'Link Şablonu',
    body: 'Link',
    departmentId: department.id,
    metaTemplateName: 'link_tpl',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const noReplyTemplate = store.create('templates', {
    title: 'Cevapsız Şablonu',
    body: 'Cevapsız',
    departmentId: department.id,
    metaTemplateName: 'no_reply_tpl',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Hat 1',
    phoneNumber: '905551103297',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const day = '2026-06-17T10:00:00.000Z';
  const convA = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone: '905551111111',
    customerName: 'Ali',
    status: 'open',
    createdAt: day,
    updatedAt: day
  });
  const convB = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone: '905552222222',
    customerName: 'Veli',
    status: 'open',
    createdAt: day,
    updatedAt: day
  });
  const convC = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone: '905553333333',
    customerName: 'Ayşe',
    status: 'open',
    createdAt: day,
    updatedAt: day
  });

  store.create('messages', {
    conversationId: convA.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'link',
    templateId: linkTemplate.id,
    status: 'sent',
    hidden: false,
    createdAt: day,
    updatedAt: day
  });
  store.create('messages', {
    conversationId: convB.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'link',
    templateId: linkTemplate.id,
    status: 'sent',
    hidden: false,
    createdAt: day,
    updatedAt: day
  });
  store.create('messages', {
    conversationId: convC.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'cevapsız',
    templateId: noReplyTemplate.id,
    status: 'sent',
    hidden: false,
    createdAt: day,
    updatedAt: day
  });
  store.create('messages', {
    conversationId: convA.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'serbest mesaj',
    templateId: null,
    status: 'sent',
    hidden: false,
    createdAt: '2026-06-17T12:00:00.000Z',
    updatedAt: '2026-06-17T12:00:00.000Z'
  });

  const result = services.getStaffOperations(store, staff, { date: '2026-06-17' });
  assert.equal(result.totalFirstContacts, 3);
  const linkRow = result.byTemplate.find((row) => row.templateId === linkTemplate.id);
  const noReplyRow = result.byTemplate.find((row) => row.templateId === noReplyTemplate.id);
  assert.equal(linkRow.uniqueRecipients, 2);
  assert.equal(noReplyRow.uniqueRecipients, 1);

  assert.throws(
    () => services.getStaffOperations(store, store.all('users').find((u) => u.role === 'admin')),
    (err) => err.statusCode === 403
  );
});