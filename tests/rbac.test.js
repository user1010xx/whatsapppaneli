const test = require('node:test');
const assert = require('node:assert/strict');
const { login, request, startTestServer } = require('./helpers');

test('denetçi sadece kendi departmanının personellerini ve işlemlerini görebilir', async () => {
  const app = await startTestServer('rbac');
  try {
    const adminCookie = await login(app.baseUrl);
    const sales = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Satış' }, adminCookie);
    const support = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Destek' }, adminCookie);
    const salesStaff = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'satis1',
      fullName: 'Satış Personeli',
      password: '123456',
      role: 'staff',
      departmentId: sales.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'destek1',
      fullName: 'Destek Personeli',
      password: '123456',
      role: 'staff',
      departmentId: support.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'denetci1',
      fullName: 'Satış Denetçisi',
      password: '123456',
      role: 'auditor',
      departmentId: sales.data.department.id
    }, adminCookie);
    const auditorCookie = await login(app.baseUrl, 'denetci1', '123456');
    const visibleUsers = await request(app.baseUrl, 'GET', '/api/users', null, auditorCookie);
    assert.equal(visibleUsers.response.status, 200);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'satis1'), true);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'destek1'), false);
    const denied = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'hata',
      fullName: 'Yetkisiz',
      password: '123456',
      role: 'staff',
      departmentId: sales.data.department.id
    }, auditorCookie);
    assert.equal(denied.response.status, 403);
    // Denetçi artık yazma işlemi yapamaz: hesap oluşturma 403 dönmeli
    const account = await request(app.baseUrl, 'POST', '/api/accounts', {
      userId: salesStaff.data.user.id,
      label: 'Satış WP'
    }, auditorCookie);
    assert.equal(account.response.status, 403);
    // Denetçi departman da oluşturamaz
    const forbiddenDepartment = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Yetkisiz' }, auditorCookie);
    assert.equal(forbiddenDepartment.response.status, 403);
    // Denetçi kendi departmanındaki personellerin sohbetlerini okuyabilir
    const conversations = await request(app.baseUrl, 'GET', '/api/conversations', null, auditorCookie);
    assert.equal(conversations.response.status, 200);
  } finally {
    await app.close();
  }
});