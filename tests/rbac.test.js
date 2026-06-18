const test = require('node:test');
const assert = require('node:assert/strict');
const { login, request, startTestServer } = require('./helpers');

test('denetçi departman personelini izler, mesaj gönderebilir; kullanıcı/departman yönetemez', async () => {
  const app = await startTestServer('rbac');
  try {
    const adminCookie = await login(app.baseUrl);
    const sales = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Satış' }, adminCookie);
    const support = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Destek' }, adminCookie);
    const salesStaff = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'satis1',
      fullName: 'Satış Personeli',
      password: 'Staff1234',
      role: 'staff',
      departmentId: sales.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'destek1',
      fullName: 'Destek Personeli',
      password: 'Staff1234',
      role: 'staff',
      departmentId: support.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'denetci1',
      fullName: 'Satış Denetçisi',
      password: 'Staff1234',
      role: 'auditor',
      departmentId: sales.data.department.id
    }, adminCookie);

    await request(app.baseUrl, 'POST', '/api/templates', {
      title: 'Satış Şablonu',
      body: 'Merhaba {{müşteri_adı}}',
      departmentId: sales.data.department.id,
      metaTemplateName: 'hello_world',
      language: 'tr'
    }, adminCookie);
    const staffAccount = await request(app.baseUrl, 'POST', '/api/accounts', {
      userId: salesStaff.data.user.id,
      phoneNumber: '905551103297'
    }, adminCookie);
    assert.equal(staffAccount.response.status, 201);

    const auditorCookie = await login(app.baseUrl, 'denetci1', 'Staff1234');
    const auditorMe = await request(app.baseUrl, 'GET', '/api/me', null, auditorCookie);
    const visibleUsers = await request(app.baseUrl, 'GET', '/api/users', null, auditorCookie);
    assert.equal(visibleUsers.response.status, 200);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'satis1'), true);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'destek1'), false);

    const deniedUser = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'hata',
      fullName: 'Yetkisiz',
      password: 'Staff1234',
      role: 'staff',
      departmentId: sales.data.department.id
    }, auditorCookie);
    assert.equal(deniedUser.response.status, 403);

    const deniedAccount = await request(app.baseUrl, 'POST', '/api/accounts', {
      userId: salesStaff.data.user.id,
      phoneNumber: '905551103298'
    }, auditorCookie);
    assert.equal(deniedAccount.response.status, 403);

    const forbiddenDepartment = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Yetkisiz' }, auditorCookie);
    assert.equal(forbiddenDepartment.response.status, 403);

    const staffAuditDenied = await request(app.baseUrl, 'GET', '/api/reports/staff-audit', null, auditorCookie);
    assert.equal(staffAuditDenied.response.status, 403);

    const conversations = await request(app.baseUrl, 'GET', '/api/conversations', null, auditorCookie);
    assert.equal(conversations.response.status, 200);

    const templates = await request(app.baseUrl, 'GET', '/api/templates', null, auditorCookie);
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('graph.facebook.com') && target.includes('/messages') && options.method === 'POST') {
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.AUDITOR.TEST' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return originalFetch(url, options);
    };
    let sent;
    try {
      sent = await request(app.baseUrl, 'POST', '/api/messages/send', {
        accountId: staffAccount.data.account.id,
        customerPhone: '905559998877',
        text: 'Denetçi şablon mesajı',
        templateId: templates.data.templates[0].id,
        variables: { 'müşteri_adı': 'Test' }
      }, auditorCookie);
      assert.equal(sent.response.status, 201);
      assert.equal(sent.data.message.senderUserId, auditorMe.data.user.id);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    await app.close();
  }
});

test('yönetici yalnızca kendi departmanını yönetir; personel/denetçi ekler, admin/yönetici ve departman ekleyemez', async () => {
  const app = await startTestServer('rbac-manager');
  try {
    const adminCookie = await login(app.baseUrl);
    const sales = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Satış' }, adminCookie);
    const support = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Destek' }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'destek1',
      fullName: 'Destek Personeli',
      password: 'Staff1234',
      role: 'staff',
      departmentId: support.data.department.id
    }, adminCookie);
    const salesStaff = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'satis2',
      fullName: 'Satış Personeli 2',
      password: 'Staff1234',
      role: 'staff',
      departmentId: sales.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'yonetici1',
      fullName: 'Satış Yöneticisi',
      password: 'Staff1234',
      role: 'manager',
      departmentId: sales.data.department.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/templates', {
      title: 'Satış Şablonu 2',
      body: 'Merhaba {{müşteri_adı}}',
      departmentId: sales.data.department.id,
      metaTemplateName: 'hello_world',
      language: 'tr'
    }, adminCookie);
    const staffAccount = await request(app.baseUrl, 'POST', '/api/accounts', {
      userId: salesStaff.data.user.id,
      phoneNumber: '905551103299'
    }, adminCookie);
    assert.equal(staffAccount.response.status, 201);

    const managerCookie = await login(app.baseUrl, 'yonetici1', 'Staff1234');
    const managerMe = await request(app.baseUrl, 'GET', '/api/me', null, managerCookie);

    const departments = await request(app.baseUrl, 'GET', '/api/departments', null, managerCookie);
    assert.equal(departments.data.departments.length, 1);
    assert.equal(departments.data.departments[0].id, sales.data.department.id);

    const visibleUsers = await request(app.baseUrl, 'GET', '/api/users', null, managerCookie);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'satis2'), true);
    assert.equal(visibleUsers.data.users.some((user) => user.username === 'destek1'), false);

    const staffCreate = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'satis3',
      fullName: 'Yeni Personel',
      password: 'Staff1234',
      role: 'staff',
      departmentId: sales.data.department.id
    }, managerCookie);
    assert.equal(staffCreate.response.status, 201);

    const auditorCreate = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'denetci2',
      fullName: 'Yeni Denetçi',
      password: 'Staff1234',
      role: 'auditor',
      departmentId: sales.data.department.id
    }, managerCookie);
    assert.equal(auditorCreate.response.status, 201);

    const deniedManager = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'baska-yonetici',
      fullName: 'Yetkisiz Yönetici',
      password: 'Staff1234',
      role: 'manager',
      departmentId: sales.data.department.id
    }, managerCookie);
    assert.equal(deniedManager.response.status, 403);

    const deniedAdmin = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'baska-admin',
      fullName: 'Yetkisiz Admin',
      password: 'Staff1234',
      role: 'admin',
      departmentId: sales.data.department.id
    }, managerCookie);
    assert.equal(deniedAdmin.response.status, 403);

    const deniedOtherDept = await request(app.baseUrl, 'POST', '/api/users', {
      username: 'destek-staff',
      fullName: 'Destek Personeli',
      password: 'Staff1234',
      role: 'staff',
      departmentId: support.data.department.id
    }, managerCookie);
    assert.equal(deniedOtherDept.response.status, 403);

    const forbiddenDepartment = await request(app.baseUrl, 'POST', '/api/departments', { name: 'Yetkisiz' }, managerCookie);
    assert.equal(forbiddenDepartment.response.status, 403);

    const forbiddenTemplate = await request(app.baseUrl, 'POST', '/api/templates', {
      title: 'Yetkisiz Şablon',
      body: 'Test',
      departmentId: sales.data.department.id,
      metaTemplateName: 'hello_world'
    }, managerCookie);
    assert.equal(forbiddenTemplate.response.status, 403);

    const cloudApi = await request(app.baseUrl, 'PATCH', '/api/settings/cloud-api', {
      phoneNumberId: '123456789',
      accessToken: 'test-token'
    }, managerCookie);
    assert.equal(cloudApi.response.status, 200);

    const staffAudit = await request(app.baseUrl, 'GET', '/api/reports/staff-audit', null, managerCookie);
    assert.equal(staffAudit.response.status, 200);

    const reports = await request(app.baseUrl, 'GET', '/api/reports', null, managerCookie);
    assert.equal(reports.response.status, 200);
    assert.equal(reports.data.reports.byUser.every((row) => row.user.departmentId === managerMe.data.user.departmentId), true);

    const templates = await request(app.baseUrl, 'GET', '/api/templates', null, managerCookie);
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('graph.facebook.com') && target.includes('/messages') && options.method === 'POST') {
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.MANAGER.TEST' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return originalFetch(url, options);
    };
    let sent;
    try {
      sent = await request(app.baseUrl, 'POST', '/api/messages/send', {
        accountId: staffAccount.data.account.id,
        customerPhone: '905559998878',
        text: 'Yönetici şablon mesajı',
        templateId: templates.data.templates[0].id,
        variables: { 'müşteri_adı': 'Test' }
      }, managerCookie);
      assert.equal(sent.response.status, 201);
      assert.equal(sent.data.message.senderUserId, managerMe.data.user.id);
    } finally {
      global.fetch = originalFetch;
    }

    const managerAuditLogs = await request(app.baseUrl, 'GET', '/api/audit-logs?limit=200', null, managerCookie);
    assert.equal(managerAuditLogs.response.status, 200);
    const salesDepartmentId = sales.data.department.id;
    const supportUser = app.store.all('users').find((user) => user.username === 'destek1');
    const salesUser = app.store.all('users').find((user) => user.username === 'satis2');
    assert.ok(managerAuditLogs.data.logs.some((log) => log.entity === 'user' && log.entityId === salesUser.id));
    assert.equal(
      managerAuditLogs.data.logs.some((log) => log.entity === 'user' && log.entityId === supportUser.id),
      false
    );
    assert.equal(
      managerAuditLogs.data.logs.every((log) => {
        const actor = app.store.find('users', log.actorId);
        const metadata = log.metadata || {};
        const entityUser = log.entity === 'user' ? app.store.find('users', log.entityId) : null;
        return (
          actor?.departmentId === salesDepartmentId
          || metadata.departmentId === salesDepartmentId
          || entityUser?.departmentId === salesDepartmentId
          || (log.entity === 'department' && log.entityId === salesDepartmentId)
          || (log.entity === 'whatsappAccount' && app.store.find('whatsappAccounts', log.entityId)?.departmentId === salesDepartmentId)
          || (log.entity === 'template' && app.store.find('templates', log.entityId)?.departmentId === salesDepartmentId)
          || (log.entity === 'message' && app.store.find('messages', log.entityId)?.departmentId === salesDepartmentId)
        );
      }),
      true
    );

    const adminAuditLogs = await request(app.baseUrl, 'GET', '/api/audit-logs?limit=200', null, adminCookie);
    assert.equal(adminAuditLogs.response.status, 200);
    assert.ok(adminAuditLogs.data.logs.length >= managerAuditLogs.data.logs.length);
    assert.ok(adminAuditLogs.data.logs.some((log) => log.entity === 'user' && log.entityId === supportUser.id));
  } finally {
    await app.close();
  }
});

test('denetçi ve personel denetim günlüğünü göremez', async () => {
  const app = await startTestServer('rbac-audit-logs');
  try {
    const adminCookie = await login(app.baseUrl);
    const dept = app.store.all('departments')[0];
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'audit-staff',
      fullName: 'Audit Staff',
      password: 'Staff1234',
      role: 'staff',
      departmentId: dept.id
    }, adminCookie);
    await request(app.baseUrl, 'POST', '/api/users', {
      username: 'audit-auditor',
      fullName: 'Audit Auditor',
      password: 'Staff1234',
      role: 'auditor',
      departmentId: dept.id
    }, adminCookie);
    const staffCookie = await login(app.baseUrl, 'audit-staff', 'Staff1234');
    const auditorCookie = await login(app.baseUrl, 'audit-auditor', 'Staff1234');
    const staffLogs = await request(app.baseUrl, 'GET', '/api/audit-logs', null, staffCookie);
    const auditorLogs = await request(app.baseUrl, 'GET', '/api/audit-logs', null, auditorCookie);
    assert.equal(staffLogs.response.status, 403);
    assert.equal(auditorLogs.response.status, 403);
  } finally {
    await app.close();
  }
});