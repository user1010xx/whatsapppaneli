const test = require('node:test');
const assert = require('node:assert/strict');
const { canHideMessage } = require('../src/rbac');
const { login, request, startTestServer } = require('./helpers');

test('canHideMessage yalnızca admin ve yönetici için true', () => {
  const deptA = 'dept-a';
  const deptB = 'dept-b';
  assert.equal(canHideMessage({ role: 'staff', departmentId: deptA }, deptA), false);
  assert.equal(canHideMessage({ role: 'auditor', departmentId: deptA }, deptA), false);
  assert.equal(canHideMessage({ role: 'admin', departmentId: deptA }, deptB), true);
  assert.equal(canHideMessage({ role: 'manager', departmentId: deptA }, deptA), true);
  assert.equal(canHideMessage({ role: 'manager', departmentId: deptA }, deptB), false);
});

test('mesaj gizleme personel ve denetçi için 403, admin için 200', async () => {
  const app = await startTestServer('hide-roles');
  try {
    const adminCookie = await login(app.baseUrl);
    const dept = app.store.all('departments')[0];
    const staffRes = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'hide-staff',
      fullName: 'Hide Staff',
      password: 'Secret12a',
      role: 'staff',
      departmentId: dept.id
    }, adminCookie);
    const managerRes = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'hide-manager',
      fullName: 'Hide Manager',
      password: 'Secret12a',
      role: 'manager',
      departmentId: dept.id
    }, adminCookie);
    const auditorRes = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'hide-auditor',
      fullName: 'Hide Auditor',
      password: 'Secret12a',
      role: 'auditor',
      departmentId: dept.id
    }, adminCookie);
    const staffCookie = await login(app.baseUrl, 'hide-staff', 'Secret12a');
    const managerCookie = await login(app.baseUrl, 'hide-manager', 'Secret12a');
    const auditorCookie = await login(app.baseUrl, 'hide-auditor', 'Secret12a');

    const conversation = app.store.create('conversations', {
      accountId: 'acc-1',
      userId: staffRes.data.user.id,
      departmentId: dept.id,
      customerPhone: '905551111111',
      customerName: 'Test',
      status: 'open'
    });
    const message = app.store.create('messages', {
      conversationId: conversation.id,
      accountId: 'acc-1',
      userId: staffRes.data.user.id,
      departmentId: dept.id,
      senderUserId: staffRes.data.user.id,
      direction: 'out',
      text: 'Gizlenecek',
      status: 'sent',
      hidden: false
    });

    const staffAttempt = await request(app.baseUrl, 'POST', `/api/messages/${message.id}/hide`, null, staffCookie);
    assert.equal(staffAttempt.response.status, 403);

    const auditorAttempt = await request(app.baseUrl, 'POST', `/api/messages/${message.id}/hide`, null, auditorCookie);
    assert.equal(auditorAttempt.response.status, 403);

    const managerAttempt = await request(app.baseUrl, 'POST', `/api/messages/${message.id}/hide`, null, managerCookie);
    assert.equal(managerAttempt.response.status, 200);
    assert.equal(app.store.find('messages', message.id)?.hidden, true);

    const message2 = app.store.create('messages', {
      conversationId: conversation.id,
      accountId: 'acc-1',
      userId: staffRes.data.user.id,
      departmentId: dept.id,
      senderUserId: staffRes.data.user.id,
      direction: 'in',
      text: 'Admin gizleyecek',
      status: 'received',
      hidden: false
    });
    const adminAttempt = await request(app.baseUrl, 'POST', `/api/messages/${message2.id}/hide`, null, adminCookie);
    assert.equal(adminAttempt.response.status, 200);
    assert.equal(app.store.find('messages', message2.id)?.hidden, true);
  } finally {
    await app.close();
  }
});

test('panel mesaj gizleme düğmesi yalnızca yönetici ve admin için tanımlı', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const views = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app', 'views.js'), 'utf8');
  assert.match(views, /canHideMessages\(\)/);
  assert.match(views, /hideChatMessage/);
  assert.doesNotMatch(views, /!isStaff\(\) && !message\.hidden/);
});