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

function createStaff(store, { username, fullName, departmentId }) {
  return store.create('users', {
    username,
    fullName,
    passwordHash: 'x',
    role: 'staff',
    departmentId,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function createTemplateMessage(store, {
  staff,
  department,
  account,
  template,
  customerPhone,
  customerName,
  createdAt
}) {
  const conversation = store.create('conversations', {
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    customerPhone,
    customerName,
    status: 'open',
    createdAt,
    updatedAt: createdAt
  });
  store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: staff.id,
    departmentId: department.id,
    senderUserId: staff.id,
    direction: 'out',
    text: 'template',
    templateId: template.id,
    status: 'sent',
    hidden: false,
    createdAt,
    updatedAt: createdAt
  });
}

test('getTemplateContactLog personel yalnızca kendi kayıtlarını görür', async () => {
  const { store } = await freshStore('tpl-staff-scope');
  const departments = store.all('departments');
  const deptA = departments[0];
  const deptB = store.create('departments', {
    name: 'Satış',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const staffA = createStaff(store, { username: 'p1', fullName: 'Personel 1', departmentId: deptA.id });
  const staffB = createStaff(store, { username: 'p2', fullName: 'Personel 2', departmentId: deptB.id });
  const templateA = store.create('templates', {
    title: 'Şablon A',
    body: 'A',
    departmentId: deptA.id,
    metaTemplateName: 'tpl_a',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const templateB = store.create('templates', {
    title: 'Şablon B',
    body: 'B',
    departmentId: deptB.id,
    metaTemplateName: 'tpl_b',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const accountA = store.create('whatsappAccounts', {
    userId: staffA.id,
    departmentId: deptA.id,
    label: 'Hat A',
    phoneNumber: '905551100001',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const accountB = store.create('whatsappAccounts', {
    userId: staffB.id,
    departmentId: deptB.id,
    label: 'Hat B',
    phoneNumber: '905551100002',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const day = '2026-06-17T10:00:00.000Z';
  createTemplateMessage(store, {
    staff: staffA,
    department: deptA,
    account: accountA,
    template: templateA,
    customerPhone: '905551111111',
    customerName: 'Ali',
    createdAt: day
  });
  createTemplateMessage(store, {
    staff: staffB,
    department: deptB,
    account: accountB,
    template: templateB,
    customerPhone: '905552222222',
    customerName: 'Veli',
    createdAt: day
  });

  const ownLog = services.getTemplateContactLog(store, staffA);
  assert.equal(ownLog.total, 1);
  assert.equal(ownLog.entries[0].phone, '905551111111');
  assert.equal(ownLog.canExport, false);
  assert.equal(ownLog.showStaff, false);

  const admin = store.all('users').find((user) => user.role === 'admin');
  const adminLog = services.getTemplateContactLog(store, admin);
  assert.equal(adminLog.total, 2);
  assert.equal(adminLog.canExport, true);
  assert.equal(adminLog.showStaff, true);
});

test('getTemplateContactLog yönetici departman personelini görür', async () => {
  const { store } = await freshStore('tpl-manager-scope');
  const deptA = store.all('departments')[0];
  const deptB = store.create('departments', {
    name: 'Destek',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const manager = store.create('users', {
    username: 'yonetici',
    fullName: 'Yönetici',
    passwordHash: 'x',
    role: 'manager',
    departmentId: deptA.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const staffA = createStaff(store, { username: 'p1', fullName: 'Personel 1', departmentId: deptA.id });
  const staffB = createStaff(store, { username: 'p2', fullName: 'Personel 2', departmentId: deptB.id });
  const templateA = store.create('templates', {
    title: 'Şablon A',
    body: 'A',
    departmentId: deptA.id,
    metaTemplateName: 'tpl_a',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const templateB = store.create('templates', {
    title: 'Şablon B',
    body: 'B',
    departmentId: deptB.id,
    metaTemplateName: 'tpl_b',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const accountA = store.create('whatsappAccounts', {
    userId: staffA.id,
    departmentId: deptA.id,
    label: 'Hat A',
    phoneNumber: '905551100001',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const accountB = store.create('whatsappAccounts', {
    userId: staffB.id,
    departmentId: deptB.id,
    label: 'Hat B',
    phoneNumber: '905551100002',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const day = '2026-06-17T11:00:00.000Z';
  createTemplateMessage(store, {
    staff: staffA,
    department: deptA,
    account: accountA,
    template: templateA,
    customerPhone: '905553333333',
    customerName: 'Ayşe',
    createdAt: day
  });
  createTemplateMessage(store, {
    staff: staffB,
    department: deptB,
    account: accountB,
    template: templateB,
    customerPhone: '905554444444',
    customerName: 'Can',
    createdAt: day
  });

  const managerLog = services.getTemplateContactLog(store, manager);
  assert.equal(managerLog.total, 1);
  assert.equal(managerLog.entries[0].staffUsername, 'p1');
  assert.equal(managerLog.canExport, true);
});

test('getTemplateContactLog numara araması filtreler', async () => {
  const { store } = await freshStore('tpl-search');
  const department = store.all('departments')[0];
  const staff = createStaff(store, { username: 'p1', fullName: 'Personel 1', departmentId: department.id });
  const template = store.create('templates', {
    title: 'Şablon',
    body: 'X',
    departmentId: department.id,
    metaTemplateName: 'tpl_x',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Hat',
    phoneNumber: '905551100001',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const day = '2026-06-17T12:00:00.000Z';
  createTemplateMessage(store, {
    staff,
    department,
    account,
    template,
    customerPhone: '905551111111',
    customerName: 'Ali',
    createdAt: day
  });
  createTemplateMessage(store, {
    staff,
    department,
    account,
    template,
    customerPhone: '905559999999',
    customerName: 'Zeynep',
    createdAt: '2026-06-17T13:00:00.000Z'
  });

  const filtered = services.getTemplateContactLog(store, staff, { search: '999999' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].phone, '905559999999');
  assert.equal(filtered.search, '999999');
});

test('buildTemplateContactExport personel için 403, admin için CSV üretir', async () => {
  const { store } = await freshStore('tpl-export');
  const department = store.all('departments')[0];
  const staff = createStaff(store, { username: 'p1', fullName: 'Personel 1', departmentId: department.id });
  const template = store.create('templates', {
    title: 'Şablon',
    body: 'X',
    departmentId: department.id,
    metaTemplateName: 'tpl_x',
    language: 'tr',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Hat',
    phoneNumber: '905551100001',
    provider: 'cloudapi',
    status: 'connected',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const day = '2026-06-17T14:00:00.000Z';
  createTemplateMessage(store, {
    staff,
    department,
    account,
    template,
    customerPhone: '905551111111',
    customerName: 'Ali',
    createdAt: day
  });

  const staffLog = services.getTemplateContactLog(store, staff);
  assert.throws(
    () => services.buildTemplateContactExport(store, staffLog),
    (err) => err.statusCode === 403
  );

  const admin = store.all('users').find((user) => user.role === 'admin');
  const adminLog = services.getTemplateContactLog(store, admin);
  const csv = services.buildTemplateContactExport(store, adminLog);
  assert.match(csv, /^Personel,Kullanıcı Adı,Departman,Numara,Müşteri Adı,Tarih,Şablon/);
  assert.match(csv, /905551111111/);
  assert.match(csv, /Personel 1/);
});