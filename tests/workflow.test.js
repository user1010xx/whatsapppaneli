const test = require('node:test');
const assert = require('node:assert/strict');
const { login, request, startTestServer } = require('./helpers');

test('personel Cloud API hesabı ekler, webhook ile mesaj alır ve şablon gönderir', async () => {
  const app = await startTestServer('workflow');
  try {
    const adminCookie = await login(app.baseUrl);
    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, adminCookie);
    const departmentId = departments.data.departments[0].id;
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'personel',
      fullName: 'Test Personel',
      password: 'Staff1234',
      role: 'staff',
      departmentId
    }, adminCookie);
    const staffCookie = await login(app.baseUrl, 'personel', 'Staff1234');
    const account = await request(app.baseUrl, 'POST', '/api/accounts', {
      phoneNumber: '905551103297'
    }, staffCookie);
    assert.equal(account.response.status, 201);
    assert.equal(account.data.account.provider, 'cloudapi');
    assert.equal(account.data.account.status, 'connected');
    assert.equal(account.data.account.phoneNumber, '905551103297');

    const health = await request(app.baseUrl, 'POST', `/api/accounts/${account.data.account.id}/health`, null, staffCookie);
    assert.equal(health.response.status, 200);
    assert.equal(health.data.account.connectionHealth, 'healthy');

    const account2 = await request(app.baseUrl, 'POST', '/api/accounts', {
      phoneNumber: '905551103298'
    }, staffCookie);
    assert.equal(account2.response.status, 201);
    assert.notEqual(account2.data.account.id, account.data.account.id);

    const duplicate = await request(app.baseUrl, 'POST', '/api/accounts', {
      phoneNumber: '905551103297'
    }, staffCookie);
    assert.equal(duplicate.response.status, 409);

    const cloudApiDenied = await request(app.baseUrl, 'GET', '/api/settings/cloud-api', null, staffCookie);
    assert.equal(cloudApiDenied.response.status, 403);

    const renamed = await request(app.baseUrl, 'PATCH', `/api/accounts/${account.data.account.id}`, {
      label: 'Satış Hattı 2',
      phoneNumber: '905551103299'
    }, staffCookie);
    assert.equal(renamed.response.status, 403);

    const webhook = await fetch(`${app.baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: '123456789' },
              contacts: [{ wa_id: '905551112233', profile: { name: 'Mehmet' } }],
              messages: [{
                from: '905551112233',
                id: 'wamid.IN1',
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Bilgi alabilir miyim?' }
              }]
            }
          }]
        }]
      })
    });
    assert.equal(webhook.status, 200);

    const conversations = await request(app.baseUrl, 'GET', '/api/conversations', null, staffCookie);
    assert.equal(conversations.data.conversations.length, 1);
    const conversationId = conversations.data.conversations[0].id;

    const templates = await request(app.baseUrl, 'GET', '/api/templates', null, staffCookie);
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('graph.facebook.com') && target.includes('/messages') && options.method === 'POST') {
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT.TEST' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return originalFetch(url, options);
    };
    let sent;
    try {
      sent = await request(app.baseUrl, 'POST', '/api/messages/send', {
        accountId: account.data.account.id,
        conversationId,
        text: 'manuel',
        templateId: templates.data.templates[0].id,
        variables: { 'müşteri_adı': 'Mehmet Bey' }
      }, staffCookie);
      assert.equal(sent.response.status, 201);
      assert.match(sent.data.message.text, /Mehmet Bey/);
    } finally {
      global.fetch = originalFetch;
    }

    const messages = await request(app.baseUrl, 'GET', `/api/conversations/${conversationId}/messages`, null, staffCookie);
    assert.equal(messages.data.messages.length, 2);
    const inbound = messages.data.messages.find((message) => message.direction === 'in');
    const outbound = messages.data.messages.find((message) => message.direction === 'out');
    assert.ok(inbound.respondedAt, 'gelen mesaja yanıt zamanı yazılmalı');
    assert.equal(inbound.respondedByUserId, outbound.senderUserId);

    const hideAttempt = await request(app.baseUrl, 'POST', `/api/messages/${sent.data.message.id}/hide`, null, staffCookie);
    assert.equal(hideAttempt.response.status, 403);

    const inboundMessage = messages.data.messages.find((message) => message.direction === 'in');
    const adminHideAttempt = await request(app.baseUrl, 'POST', `/api/messages/${inboundMessage.id}/hide`, null, adminCookie);
    assert.equal(adminHideAttempt.response.status, 200);

    const deleteAccountAttempt = await request(app.baseUrl, 'DELETE', `/api/accounts/${account.data.account.id}`, null, staffCookie);
    assert.equal(deleteAccountAttempt.response.status, 403);

    const staffAudit = await request(app.baseUrl, 'GET', '/api/reports/staff-audit', null, adminCookie);
    assert.equal(staffAudit.response.status, 200);
    const row = staffAudit.data.audit.byUser.find((item) => item.user.username === 'personel');
    assert.ok(row);
    assert.equal(row.sentCount, 1);
    assert.equal(row.seenCount, 0);
    assert.equal(row.respondedCount, 1);
    assert.ok(row.lastLoginAt);

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
    const users = await request(app.baseUrl, 'GET', '/api/users', null, adminCookie);
    assert.equal(users.data.users.some((user) => user.username === 'yeni.personel'), true);
  } finally {
    await app.close();
  }
});

test('admin kullanıcı şifre değiştirme, pasife alma ve silme yapabilir', async () => {
  const app = await startTestServer('user-manage');
  try {
    const adminCookie = await login(app.baseUrl);
    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, adminCookie);
    const departmentId = departments.data.departments[0].id;
    const created = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'yonetilecek',
      fullName: 'Yönetilecek Personel',
      password: 'IlkSifre123!',
      role: 'staff',
      departmentId
    }, adminCookie);
    const userId = created.data.user.id;

    const passwordChanged = await request(app.baseUrl, 'PATCH', `/api/users/${userId}`, {
      password: 'YeniSifre456!'
    }, adminCookie);
    assert.equal(passwordChanged.response.status, 200);

    const loginOld = await request(app.baseUrl, 'POST', '/api/auth/login', {
      username: 'yonetilecek',
      password: 'IlkSifre123!'
    });
    assert.equal(loginOld.response.status, 401);

    const loginNew = await request(app.baseUrl, 'POST', '/api/auth/login', {
      username: 'yonetilecek',
      password: 'YeniSifre456!'
    });
    assert.equal(loginNew.response.status, 200);

    const deactivated = await request(app.baseUrl, 'PATCH', `/api/users/${userId}`, {
      active: false
    }, adminCookie);
    assert.equal(deactivated.response.status, 200);
    assert.equal(deactivated.data.user.active, false);

    const loginInactive = await request(app.baseUrl, 'POST', '/api/auth/login', {
      username: 'yonetilecek',
      password: 'YeniSifre456!'
    });
    assert.equal(loginInactive.response.status, 401);

    const deleted = await request(app.baseUrl, 'DELETE', `/api/users/${userId}`, null, adminCookie);
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.deleted, true);
    assert.match(deleted.data.message || '', /korunuyor/i);

    const users = await request(app.baseUrl, 'GET', '/api/users', null, adminCookie);
    assert.equal(users.data.users.some((user) => user.id === userId), false);
    assert.equal(app.store.find('users', userId), null);
  } finally {
    await app.close();
  }
});

test('admin departman sildiğinde bağlı personel, yönetici ve denetçiler kalıcı silinir', async () => {
  const app = await startTestServer('department-delete');
  try {
    const adminCookie = await login(app.baseUrl);
    const createdDept = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Silinecek Departman' }, adminCookie);
    const departmentId = createdDept.data.department.id;
    const staff = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'dept-staff',
      fullName: 'Dept Staff',
      password: 'Secret12a',
      role: 'staff',
      departmentId
    }, adminCookie);
    const manager = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'dept-manager',
      fullName: 'Dept Manager',
      password: 'Secret12a',
      role: 'manager',
      departmentId
    }, adminCookie);
    const auditor = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'dept-auditor',
      fullName: 'Dept Auditor',
      password: 'Secret12a',
      role: 'auditor',
      departmentId
    }, adminCookie);
    app.store.create('templates', {
      title: 'Dept Şablon',
      body: 'Test',
      departmentId,
      active: true,
      createdBy: staff.data.user.id
    });

    const deleted = await request(app.baseUrl, 'DELETE', `/api/departments/${departmentId}`, null, adminCookie);
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.deleted, true);
    assert.equal(deleted.data.removedUsers, 3);
    assert.equal(app.store.find('departments', departmentId), null);
    assert.equal(app.store.find('users', staff.data.user.id), null);
    assert.equal(app.store.find('users', manager.data.user.id), null);
    assert.equal(app.store.find('users', auditor.data.user.id), null);
    assert.equal(app.store.all('templates').some((template) => template.departmentId === departmentId), false);

    const managerLogin = await request(app.baseUrl, 'POST', '/api/auth/login', {
      username: 'dept-manager',
      password: 'Secret12a'
    });
    assert.equal(managerLogin.response.status, 401);
  } finally {
    await app.close();
  }
});

test('admin departman silme korumaları çalışır', async () => {
  const app = await startTestServer('department-delete-guards');
  try {
    const adminCookie = await login(app.baseUrl);
    const onlyDept = app.store.all('departments')[0];
    const blockedLast = await request(app.baseUrl, 'DELETE', `/api/departments/${onlyDept.id}`, null, adminCookie);
    assert.equal(blockedLast.response.status, 400);
    assert.match(blockedLast.data.error || '', /Son departman/i);

    const extraDept = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Admin Taşıma' }, adminCookie);
    const adminUser = app.store.all('users').find((user) => user.username === 'admin');
    app.store.update('users', adminUser.id, { departmentId: extraDept.data.department.id });
    const blockedAdmin = await request(app.baseUrl, 'DELETE', `/api/departments/${extraDept.data.department.id}`, null, adminCookie);
    assert.equal(blockedAdmin.response.status, 400);
    assert.match(blockedAdmin.data.error || '', /admin kullanıcısı/i);
  } finally {
    await app.close();
  }
});

test('health endpoint çalışır', async () => {
  const app = await startTestServer('health');
  try {
    const res = await fetch(`${app.baseUrl}/health`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'cloudapi');
  } finally {
    await app.close();
  }
});