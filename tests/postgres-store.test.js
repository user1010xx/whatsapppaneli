const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/storage');

const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

test('PostgresStore kalıcı veri yazar ve okur', { skip: !databaseUrl }, async () => {
  const store = await createStore({
    databaseUrl,
    adminUsername: 'pg-admin',
    adminPassword: 'Secret12a',
    auditLogMax: 100
  });
  const dept = store.create('departments', { name: 'PG Test', active: true }, false);
  store.save();
  await store._saveChain;

  const reloaded = await createStore({
    databaseUrl,
    adminUsername: 'pg-admin',
    adminPassword: 'Secret12a',
    auditLogMax: 100
  });
  assert.ok(reloaded.all('departments').some((item) => item.id === dept.id));
  await store.close();
  await reloaded.close();
});