const assert = require('node:assert/strict');
const { login, request, startTestServer } = require('./helpers');

(async () => {
  const app = await startTestServer('smoke');
  try {
    const cookie = await login(app.baseUrl);
    const me = await request(app.baseUrl, 'GET', '/api/me', null, cookie);
    assert.equal(me.response.status, 200);
    assert.equal(me.data.user.role, 'admin');
    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, cookie);
    assert.ok(departments.data.departments.length >= 1);
    const users = await request(app.baseUrl, 'GET', '/api/users', null, cookie);
    assert.ok(users.data.users.some((user) => user.role === 'admin'));
    const templates = await request(app.baseUrl, 'GET', '/api/templates', null, cookie);
    assert.ok(templates.data.templates.length >= 1);
    const reports = await request(app.baseUrl, 'GET', '/api/reports', null, cookie);
    assert.equal(typeof reports.data.reports.users, 'number');
    console.log('Smoke test başarılı: login, listeleme, şablon ve rapor uçları çalışıyor.');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});