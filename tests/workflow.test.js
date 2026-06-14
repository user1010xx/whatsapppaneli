const test = require('node:test');
const assert = require('node:assert/strict');
const { login, request, startTestServer } = require('./helpers');

test('personel QR hesap ekler, şablon mesaj gönderir ve mesaj silemez', async () => {
  const app = await startTestServer('workflow');
  try {
    const adminCookie = await login(app.baseUrl);
    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, adminCookie);
    const departmentId = departments.data.departments[0].id;
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'personel',
      fullName: 'Test Personel',
      password: '123456',
      role: 'staff',
      departmentId
    }, adminCookie);
    const staffCookie = await login(app.baseUrl, 'personel', '123456');
    const account = await request(app.baseUrl, 'POST', '/api/accounts', { label: 'WP 1' }, staffCookie);
    assert.equal(account.response.status, 201);
    assert.equal(account.data.account.status, 'qr_required');
    assert.equal(account.data.account.connectionHealth, 'waiting_qr');
    assert.match(account.data.account.qrCode, /^MOCK-QR:/);
    assert.match(account.data.account.qrImage, /^data:image\/png;base64,/);
    const connected = await request(app.baseUrl, 'POST', `/api/accounts/${account.data.account.id}/confirm-qr`, null, staffCookie);
    assert.equal(connected.data.account.status, 'connected');
    assert.equal(connected.data.account.connectionHealth, 'healthy');
    const health = await request(app.baseUrl, 'POST', `/api/accounts/${account.data.account.id}/health`, null, staffCookie);
    assert.equal(health.response.status, 200);
    assert.equal(health.data.account.connectionHealth, 'healthy');
    const refreshed = await request(app.baseUrl, 'POST', `/api/accounts/${account.data.account.id}/refresh-qr`, null, staffCookie);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.data.account.status, 'qr_required');
    assert.equal(refreshed.data.account.connectionHealth, 'waiting_qr');
    assert.match(refreshed.data.account.qrCode, /^MOCK-QR:/);
    assert.match(refreshed.data.account.qrImage, /^data:image\/png;base64,/);
    const reconnected = await request(app.baseUrl, 'POST', `/api/accounts/${account.data.account.id}/confirm-qr`, null, staffCookie);
    assert.equal(reconnected.response.status, 200);
    assert.equal(reconnected.data.account.status, 'connected');
    const renamed = await request(app.baseUrl, 'PATCH', `/api/accounts/${account.data.account.id}`, {
      label: 'Satış Hattı'
    }, staffCookie);
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.data.account.label, 'Satış Hattı');
    const templates = await request(app.baseUrl, 'GET', '/api/templates', null, staffCookie);
    const sent = await request(app.baseUrl, 'POST', '/api/messages/send', {
      accountId: account.data.account.id,
      customerPhone: '+905551112233',
      customerName: 'Mehmet',
      text: 'manuel',
      templateId: templates.data.templates[0].id,
      variables: { 'müşteri_adı': 'Mehmet Bey' }
    }, staffCookie);
    assert.equal(sent.response.status, 201);
    assert.match(sent.data.message.text, /Mehmet Bey/);
    const incoming = await request(app.baseUrl, 'POST', '/api/messages/receive', {
      accountId: account.data.account.id,
      customerPhone: '+905551112233',
      text: 'Bilgi alabilir miyim?'
    }, staffCookie);
    assert.equal(incoming.response.status, 201);
    const messages = await request(app.baseUrl, 'GET', `/api/conversations/${sent.data.conversation.id}/messages`, null, staffCookie);
    assert.equal(messages.data.messages.length, 2);
    const deleteAttempt = await request(app.baseUrl, 'POST', `/api/messages/${sent.data.message.id}/hide`, null, staffCookie);
    assert.equal(deleteAttempt.response.status, 403);
    const reports = await request(app.baseUrl, 'GET', '/api/reports', null, adminCookie);
    assert.equal(reports.data.reports.outgoingMessages, 1);
    assert.equal(reports.data.reports.incomingMessages, 1);
  } finally {
    await app.close();
  }
});

test('admin kullanıcı ekleme API akışı çalışır', async () => {
  const app = await startTestServer('user-create');
  try {
    const adminCookie = await login(app.baseUrl);
    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, adminCookie);
    const departmentId = departments.data.departments[0].id;
    const created = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'yeni.personel',
      fullName: 'Yeni Personel',
      password: 'GucluSifre123!',
      role: 'staff',
      departmentId
    }, adminCookie);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.user.username, 'yeni.personel');
    assert.equal(created.data.user.role, 'staff');
    const users = await request(app.baseUrl, 'GET', '/api/users', null, adminCookie);
    assert.equal(users.data.users.some((user) => user.username === 'yeni.personel'), true);
  } finally {
    await app.close();
  }
});