const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, login, request } = require('./helpers');
const { validatePassword } = require('../src/passwordPolicy');

test('validatePassword kısa şifreyi reddeder', () => {
  assert.throws(() => validatePassword('123'), (err) => err.statusCode === 400);
});

test('validatePassword karmaşıklık kurallarını uygular', () => {
  assert.throws(() => validatePassword('abcdefgh'), (err) => err.statusCode === 400);
  assert.equal(validatePassword('Secret12a'), 'Secret12a');
});

test('CSRF: farklı origin ile mutating istek 403 döner', async () => {
  const app = await startTestServer('csrf');
  const cookie = await login(app.baseUrl);
  const blocked = await fetch(`${app.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: 'https://evil.example'
    },
    body: JSON.stringify({
      username: 'csrf-user',
      fullName: 'CSRF',
      password: 'Secret12a',
      role: 'staff',
      departmentId: app.store.all('departments')[0].id
    })
  });
  assert.equal(blocked.status, 403);
  await app.close();
});

test('deleteUser ilişkili hesap ve sohbetleri temizler', async () => {
  const app = await startTestServer('cascade');
  const cookie = await login(app.baseUrl);
  const dept = app.store.all('departments')[0];
  const created = await request(app.baseUrl, 'POST', '/api/users', {
    username: 'cascade-user',
    fullName: 'Cascade User',
    password: 'Secret12a',
    role: 'staff',
    departmentId: dept.id
  }, cookie);
  const userId = created.data.user.id;
  app.store.create('whatsappAccounts', {
    userId,
    departmentId: dept.id,
    label: 'H1',
    phoneNumber: '905551112233',
    provider: 'cloudapi',
    status: 'connected',
    active: true
  });
  const deleted = await request(app.baseUrl, 'DELETE', `/api/users/${userId}`, null, cookie);
  assert.equal(deleted.response.status, 200);
  assert.equal(app.store.all('whatsappAccounts').filter((a) => a.userId === userId).length, 0);
  await app.close();
});