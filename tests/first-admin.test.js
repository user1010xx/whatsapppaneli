const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { getConfig } = require('../src/config');
const { JsonStore } = require('../src/storage/jsonStore');

test('üretim ortamında ADMIN_USERNAME ve güçlü ADMIN_PASSWORD zorunlu', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSession = process.env.SESSION_SECRET;
  const previousDb = process.env.DATABASE_URL;
  const previousAdminUser = process.env.ADMIN_USERNAME;
  const previousAdminPass = process.env.ADMIN_PASSWORD;
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'prod-secret-value';
  process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
  delete process.env.ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = 'Weak1';
  try {
    assert.throws(() => getConfig(), /ADMIN_USERNAME/);
    process.env.ADMIN_USERNAME = 'panel-admin';
    assert.throws(() => getConfig(), /Şifre/);
    process.env.ADMIN_PASSWORD = 'PanelAdmin1';
    const config = getConfig();
    assert.equal(config.adminUsername, 'panel-admin');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSession) process.env.SESSION_SECRET = previousSession;
    else delete process.env.SESSION_SECRET;
    if (previousDb) process.env.DATABASE_URL = previousDb;
    else delete process.env.DATABASE_URL;
    if (previousAdminUser) process.env.ADMIN_USERNAME = previousAdminUser;
    else delete process.env.ADMIN_USERNAME;
    if (previousAdminPass) process.env.ADMIN_PASSWORD = previousAdminPass;
    else delete process.env.ADMIN_PASSWORD;
  }
});

test('boş veritabanında yalnızca env admin kullanıcısı oluşturulur', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-first-admin-'));
  const store = new JsonStore(path.join(directory, 'app.json'));
  await store.init({
    adminUsername: 'railway-admin',
    adminPassword: 'RailwayAdmin1',
    adminFullName: 'İlk Yönetici'
  });
  assert.equal(store.all('users').length, 1);
  const admin = store.all('users')[0];
  assert.equal(admin.username, 'railway-admin');
  assert.equal(admin.fullName, 'İlk Yönetici');
  assert.equal(admin.role, 'admin');
  assert.equal(store.all('departments').length, 1);
});