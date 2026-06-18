const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/storage');

test('Store bozuk JSON dosyasını yedekten kurtarır', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-store-recover-'));
  const filePath = path.join(directory, 'app.json');
  const backupDir = path.join(directory, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(filePath, '{ broken json');
  const backupPayload = { users: [], departments: [], templates: [], whatsappAccounts: [], conversations: [], messages: [], auditLogs: [], webhookDedup: [], panelSettings: { cloudApi: { baseUrl: '', accessToken: '', phoneNumberId: '', wabaId: '', webhookVerifyToken: '', appSecret: '' } } };
  fs.writeFileSync(path.join(backupDir, 'app-recover.json'), JSON.stringify(backupPayload));

  const store = new Store(filePath, { backupDir });
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  assert.ok(Array.isArray(store.all('users')));
});

test('Store beginBatch tek save ile birden fazla güncellemeyi birleştirir', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-store-batch-'));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const user = store.create('users', { username: 'u1', fullName: 'U1', role: 'staff', departmentId: store.all('departments')[0].id, active: true }, false);
  store.beginBatch();
  store.update('users', user.id, { fullName: 'U1a' }, false);
  store.update('users', user.id, { fullName: 'U1b' }, false);
  store.endBatch();
  assert.equal(store.find('users', user.id).fullName, 'U1b');
});