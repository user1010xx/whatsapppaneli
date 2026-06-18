const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword } = require('./auth');
const { validatePassword } = require('./passwordPolicy');
const { normalizePhone } = require('./phone');
const {
  canManageCloudApiSettings,
  canManageDepartments,
  canManageTemplates,
  canManageUsers,
  canCreateUserRole,
  managerMayEditTarget,
  canCreateStaffAccount,
  canOperateUser,
  canDeleteAccount,
  canHideMessage,
  canDisconnectAccount,

  canReadDepartment,
  canReadUser,
  canViewStaffAudit,
  isAdmin,
  publicUser,
  roles,
  sameDepartment
} = require('./rbac');
const { buildOtpAuthUrl, generateTotpSecret, verifyTotp } = require('./totp');

function now() {
  return new Date().toISOString();
}

function pickLatestTimestamp(...values) {
  const stamps = values
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((stamp) => !Number.isNaN(stamp));
  if (!stamps.length) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireText(value, field) {
  if (!String(value || '').trim()) throw fail(400, `${field} zorunludur`);
  return String(value).trim();
}

function departmentScope(store, actor) {
  if (actor.role === roles.admin) return null;
  return actor.departmentId;
}

function listDepartments(store, actor) {
  const scope = departmentScope(store, actor);
  return store.all('departments').filter((department) => !scope || department.id === scope);
}

function createDepartment(store, actor, input) {
  if (!canManageDepartments(actor)) throw fail(403, 'Departman yönetimi için admin yetkisi gerekir');
  const created = store.create('departments', {
    name: requireText(input.name, 'Departman adı'),
    active: input.active !== false,
    createdAt: now(),
    updatedAt: now()
  });
  store.audit(actor.id, 'department.create', 'department', created.id);
  return created;
}

function updateDepartment(store, actor, id, input) {
  if (!canManageDepartments(actor)) throw fail(403, 'Departman yönetimi için admin yetkisi gerekir');
  const department = store.find('departments', id);
  if (!department) throw fail(404, 'Departman bulunamadı');
  const updated = store.update('departments', id, {
    name: input.name === undefined ? department.name : requireText(input.name, 'Departman adı'),
    active: input.active === undefined ? department.active : Boolean(input.active)
  });
  store.audit(actor.id, 'department.update', 'department', id);
  return updated;
}

const departmentMemberRoles = new Set([roles.staff, roles.manager, roles.auditor]);

function isDepartmentMember(user) {
  return Boolean(user && departmentMemberRoles.has(user.role));
}

async function deleteDepartment(store, actor, id, options = {}) {
  if (!canManageDepartments(actor)) throw fail(403, 'Departman yönetimi için admin yetkisi gerekir');
  const department = store.find('departments', id);
  if (!department) throw fail(404, 'Departman bulunamadı');
  if (store.all('departments').length <= 1) {
    throw fail(400, 'Son departman silinemez');
  }
  const departmentUsers = store.all('users').filter((user) => user.departmentId === id);
  const adminsInDepartment = departmentUsers.filter((user) => user.role === roles.admin);
  if (adminsInDepartment.length) {
    throw fail(400, 'Departmanda admin kullanıcısı var. Silmeden önce başka departmana taşıyın.');
  }
  const removableUsers = departmentUsers.filter(isDepartmentMember);
  const snapshot = {
    name: department.name,
    removedUsers: removableUsers.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role
    }))
  };
  store.beginBatch();
  for (const user of removableUsers) {
    purgeUserData(store, user.id, options.mediaDir, { inBatch: true });
    store.remove('users', user.id, false);
  }
  store.removeWhere('templates', (template) => template.departmentId === id, false);
  store.removeWhere('whatsappAccounts', (account) => account.departmentId === id, false);
  const removed = store.remove('departments', id, false);
  store.audit(actor.id, 'department.delete', 'department', id, snapshot, false);
  store.endBatch();
  await store._saveChain;
  if (!removed || store.find('departments', id)) {
    throw fail(500, 'Departman kalıcı olarak silinemedi');
  }
  const count = removableUsers.length;
  return {
    id,
    deleted: true,
    removedUsers: count,
    message: count
      ? `Departman ve ${count} kullanıcı silindi; mesaj kayıtları korunuyor`
      : 'Departman silindi; mesaj kayıtları korunuyor'
  };
}

function listUsers(store, actor) {
  return store.all('users')
    .filter((user) => canReadUser(actor, user))
    .map(publicUser);
}

async function createUser(store, actor, input) {
  const role = input.role || roles.staff;
  if (!Object.values(roles).includes(role)) throw fail(400, 'Geçersiz rol');
  const departmentId = requireText(input.departmentId, 'Departman');
  if (!store.find('departments', departmentId)) throw fail(404, 'Departman bulunamadı');
  if (!canManageUsers(actor, departmentId)) throw fail(403, 'Bu departman için kullanıcı yönetimi yetkiniz yok');
  if (!canCreateUserRole(actor, role)) throw fail(403, 'Bu rolü oluşturma yetkiniz yok');
  const username = requireText(input.username, 'Kullanıcı adı');
  const fullName = requireText(input.fullName, 'Ad soyad');
  const passwordHash = await hashPassword(validatePassword(requireText(input.password, 'Şifre')));
  if (store.all('users').some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    throw fail(409, 'Bu kullanıcı adı zaten kullanılıyor');
  }
  const created = store.create('users', {
    username,
    fullName,
    passwordHash,
    role,
    departmentId,
    active: input.active !== false,
    createdAt: now(),
    updatedAt: now()
  });
  store.audit(actor.id, 'user.create', 'user', created.id, { role, departmentId });
  return publicUser(created);
}

async function updateUser(store, actor, id, input) {
  const target = store.find('users', id);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı');
  const nextDepartmentId = input.departmentId || target.departmentId;
  if (!canManageUsers(actor, target.departmentId) || !canManageUsers(actor, nextDepartmentId)) {
    throw fail(403, 'Bu kullanıcıyı düzenleme yetkiniz yok');
  }
  if (!managerMayEditTarget(actor, target)) {
    throw fail(403, 'Yönetici yalnızca personel ve denetçi kullanıcılarını düzenleyebilir');
  }
  if (!canCreateUserRole(actor, input.role === undefined ? target.role : input.role)) {
    throw fail(403, 'Bu role atama yetkiniz yok');
  }
  if ((input.role === roles.admin || target.role === roles.admin) && actor.role !== roles.admin) {
    throw fail(403, 'Admin kullanıcısı sadece admin tarafından düzenlenebilir');
  }
  if (input.departmentId && !store.find('departments', input.departmentId)) throw fail(404, 'Departman bulunamadı');
  const changes = {
    username: input.username === undefined ? target.username : requireText(input.username, 'Kullanıcı adı'),
    fullName: input.fullName === undefined ? target.fullName : requireText(input.fullName, 'Ad soyad'),
    role: input.role === undefined ? target.role : input.role,
    departmentId: nextDepartmentId,
    active: input.active === undefined ? target.active : Boolean(input.active)
  };
  if (!Object.values(roles).includes(changes.role)) throw fail(400, 'Geçersiz rol');
  if (input.password) {
    changes.passwordHash = await hashPassword(validatePassword(requireText(input.password, 'Şifre')));
    changes.tokenVersion = (Number(target.tokenVersion) || 0) + 1;
  }
  if (input.active === false && target.active !== false) {
    changes.tokenVersion = (Number(changes.tokenVersion ?? target.tokenVersion) || 0) + 1;
  }
  const duplicate = store.all('users').find((user) => user.id !== id && user.username.toLowerCase() === changes.username.toLowerCase());
  if (duplicate) throw fail(409, 'Bu kullanıcı adı zaten kullanılıyor');
  const updated = store.update('users', id, changes);
  store.audit(actor.id, 'user.update', 'user', id);
  return publicUser(updated);
}

function assertUserManagementAccess(actor, target, actionLabel) {
  if (!target) throw fail(404, 'Kullanıcı bulunamadı');
  if (target.id === actor.id) throw fail(400, `Kendi kullanıcınızı ${actionLabel}`);
  if (target.role === roles.admin && actor.role !== roles.admin) {
    throw fail(403, `Admin kullanıcısı yalnızca admin tarafından ${actionLabel}`);
  }
  if (!managerMayEditTarget(actor, target)) {
    throw fail(403, `Yönetici yalnızca personel ve denetçi kullanıcılarını ${actionLabel}`);
  }
  if (!canManageUsers(actor, target.departmentId)) {
    throw fail(403, 'Bu kullanıcı üzerinde işlem yapma yetkiniz yok');
  }
}

async function deleteUser(store, actor, id, options = {}) {
  const target = store.find('users', id);
  assertUserManagementAccess(actor, target, 'silemezsiniz');
  const activeAdmins = store.all('users').filter((user) => user.role === roles.admin && user.active !== false);
  if (target.role === roles.admin && activeAdmins.length <= 1) {
    throw fail(400, 'Son aktif admin kullanıcısı silinemez');
  }
  const snapshot = {
    username: target.username,
    fullName: target.fullName,
    role: target.role,
    departmentId: target.departmentId
  };
  store.beginBatch();
  purgeUserData(store, id, options.mediaDir, { inBatch: true });
  const removed = store.remove('users', id, false);
  store.audit(actor.id, 'user.delete', 'user', id, snapshot, false);
  store.endBatch();
  await store._saveChain;
  if (!removed || store.find('users', id)) {
    throw fail(500, 'Kullanıcı kalıcı olarak silinemedi');
  }
  return {
    id,
    deleted: true,
    message: 'Kullanıcı silindi; mesaj ve sohbet kayıtları korunuyor'
  };
}

function purgeUserData(store, userId, mediaDir, options = {}) {
  const accountIds = new Set(store.all('whatsappAccounts').filter((a) => a.userId === userId).map((a) => a.id));
  const ownsBatch = !options.inBatch;
  if (ownsBatch) store.beginBatch();
  for (const conversation of store.all('conversations').filter((c) => c.userId === userId)) {
    store.update('conversations', conversation.id, {
      status: 'archived',
      archivedUserId: userId,
      archivedAt: now()
    }, false);
  }
  store.removeWhere('whatsappAccounts', (a) => a.userId === userId, false);
  store.removeWhere('templates', (t) => t.createdBy === userId, false);
  store.anonymizeAuditLogsForUser(userId, ownsBatch);
  if (ownsBatch) store.endBatch();
}

function exportUserData(store, actor, userId) {
  const target = store.find('users', userId);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı');
  if (!isAdmin(actor) && actor.id !== userId && !canReadUser(actor, target)) {
    throw fail(403, 'Bu kullanıcının verisini dışa aktarma yetkiniz yok');
  }
  const accountIds = new Set(store.all('whatsappAccounts').filter((a) => a.userId === userId).map((a) => a.id));
  const conversationIds = new Set(store.all('conversations').filter((c) => c.userId === userId).map((c) => c.id));
  return {
    exportedAt: now(),
    user: publicUser(target),
    accounts: store.all('whatsappAccounts').filter((a) => a.userId === userId).map(serializeAccount),
    conversations: store.all('conversations').filter((c) => c.userId === userId),
    messages: store.all('messages').filter((m) => conversationIds.has(m.conversationId) || accountIds.has(m.accountId))
  };
}

function eraseUserData(store, actor, userId, options = {}) {
  const target = store.find('users', userId);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı');
  if (!isAdmin(actor)) throw fail(403, 'KVKK veri silme yalnızca admin tarafından yapılabilir');
  purgeUserData(store, userId, options.mediaDir);
  store.audit(actor.id, 'user.data.erase', 'user', userId, { messagesRetained: true });
  return { userId, erased: true, messagesRetained: true };
}

function restoreFromBackup(store, actor) {
  if (!isAdmin(actor)) throw fail(403, 'Yedekten geri yükleme yalnızca admin tarafından yapılabilir');
  const result = store.restoreFromLatestBackup();
  store.audit(actor.id, 'store.restore', 'panelSettings', 'backup', { restoredFrom: result.restoredFrom });
  return result;
}

function auditLogMatchesDepartmentScope(store, log, scope, usersById) {
  if (!scope) return true;
  const metadata = log.metadata && typeof log.metadata === 'object' ? log.metadata : {};
  const actor = usersById.get(log.actorId);
  if (actor?.departmentId === scope) return true;
  if (metadata.departmentId === scope) return true;
  if (log.entity === 'department' && log.entityId === scope) return true;
  if (log.entity === 'user' && log.entityId) {
    const target = usersById.get(log.entityId);
    if (target?.departmentId === scope || metadata.departmentId === scope) return true;
  }
  if (log.entity === 'template' && log.entityId) {
    const template = store.find('templates', log.entityId);
    if (template?.departmentId === scope) return true;
  }
  if (log.entity === 'whatsappAccount' && log.entityId) {
    const account = store.find('whatsappAccounts', log.entityId);
    if (account?.departmentId === scope) return true;
    const owner = account && usersById.get(account.userId);
    if (owner?.departmentId === scope) return true;
  }
  if (log.entity === 'message' && log.entityId) {
    const message = store.find('messages', log.entityId);
    if (message?.departmentId === scope) return true;
    if (message?.conversationId) {
      const conversation = store.find('conversations', message.conversationId);
      if (conversation?.departmentId === scope) return true;
    }
    const owner = message && usersById.get(message.userId);
    if (owner?.departmentId === scope) return true;
  }
  if (metadata.userId) {
    const target = usersById.get(metadata.userId);
    if (target?.departmentId === scope) return true;
  }
  if (metadata.accountId) {
    const account = store.find('whatsappAccounts', metadata.accountId);
    if (account?.departmentId === scope) return true;
    const owner = account && usersById.get(account.userId);
    if (owner?.departmentId === scope) return true;
  }
  if (metadata.conversationId) {
    const conversation = store.find('conversations', metadata.conversationId);
    if (conversation?.departmentId === scope) return true;
  }
  if (Array.isArray(metadata.removedUsers) && metadata.removedUsers.length) {
    return metadata.removedUsers.some((entry) => {
      const target = usersById.get(entry.id);
      return target?.departmentId === scope;
    });
  }
  return false;
}

function listAuditLogs(store, actor, { limit = 100 } = {}) {
  if (!isAdmin(actor) && actor.role !== roles.manager) {
    throw fail(403, 'Denetim günlüğünü görme yetkiniz yok');
  }
  const scope = departmentScope(store, actor);
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const usersById = new Map(store.all('users').map((u) => [u.id, u]));
  return store.all('auditLogs')
    .filter((log) => auditLogMatchesDepartmentScope(store, log, scope, usersById))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, max)
    .map((log) => ({
      ...log,
      actorName: usersById.get(log.actorId)?.fullName || 'Sistem'
    }));
}

function listTemplates(store, actor) {
  return store.all('templates').filter((template) => {
    if (actor.role === roles.admin) return true;
    if (template.active === false) return false;
    return template.departmentId === actor.departmentId;
  });
}

function createTemplate(store, actor, input) {
  const departmentId = requireText(input.departmentId || actor.departmentId, 'Departman');
  if (!canManageTemplates(actor)) throw fail(403, 'Şablon yönetimi yalnızca admin tarafından yapılabilir');
  if (!store.find('departments', departmentId)) throw fail(404, 'Departman bulunamadı');
  const created = store.create('templates', {
    title: requireText(input.title, 'Şablon başlığı'),
    body: requireText(input.body, 'Şablon metni'),
    departmentId,
    active: input.active !== false,
    metaTemplateName: String(input.metaTemplateName || '').trim(),
    language: String(input.language || 'tr').trim() || 'tr',
    createdBy: actor.id,
    createdAt: now(),
    updatedAt: now()
  });
  store.audit(actor.id, 'template.create', 'template', created.id, { departmentId });
  return created;
}

function updateTemplate(store, actor, id, input) {
  const template = store.find('templates', id);
  if (!template) throw fail(404, 'Şablon bulunamadı');
  const nextDepartmentId = input.departmentId || template.departmentId;
  if (!canManageTemplates(actor)) {
    throw fail(403, 'Bu şablonu düzenleme yetkiniz yok');
  }
  if (input.departmentId && !store.find('departments', input.departmentId)) {
    throw fail(404, 'Hedef departman bulunamadı');
  }
  const updated = store.update('templates', id, {
    title: input.title === undefined ? template.title : requireText(input.title, 'Şablon başlığı'),
    body: input.body === undefined ? template.body : requireText(input.body, 'Şablon metni'),
    departmentId: nextDepartmentId,
    active: input.active === undefined ? template.active : Boolean(input.active),
    metaTemplateName: input.metaTemplateName === undefined
      ? (template.metaTemplateName || '')
      : String(input.metaTemplateName || '').trim(),
    language: input.language === undefined
      ? (template.language || 'tr')
      : (String(input.language || 'tr').trim() || 'tr')
  });
  store.audit(actor.id, 'template.update', 'template', id);
  return updated;
}

function deleteTemplate(store, actor, id) {
  const template = store.find('templates', id);
  if (!template) throw fail(404, 'Şablon bulunamadı');
  if (!canManageTemplates(actor)) throw fail(403, 'Bu şablonu silme yetkiniz yok');
  store.remove('templates', id);
  store.audit(actor.id, 'template.delete', 'template', id);
  return { id, deleted: true };
}

function serializeAccount(account) {
  if (!account) return account;
  const { accessToken, ...rest } = account;
  return { ...rest, hasAccessToken: Boolean(accessToken) };
}

function serializeCloudApiSettings(store) {
  const panel = store.getPanelSettings().cloudApi || {};
  const { accessToken, appSecret, ...safe } = panel;
  return {
    ...safe,
    hasAccessToken: Boolean(accessToken),
    hasAppSecret: Boolean(appSecret),
    configured: Boolean(panel.phoneNumberId && accessToken)
  };
}

function cloudApiReady(store) {
  const panel = store.getPanelSettings().cloudApi || {};
  return Boolean(panel.phoneNumberId && panel.accessToken);
}

function getCloudApiSettings(store, actor) {
  if (!actor) throw fail(401, 'Oturum gerekli');
  if (!canManageCloudApiSettings(actor)) {
    throw fail(403, 'Cloud API ayarlarını yalnızca admin veya yönetici görüntüleyebilir');
  }
  return serializeCloudApiSettings(store);
}

async function updateCloudApiSettings(store, actor, provider, input, options = {}) {
  if (!canManageCloudApiSettings(actor)) throw fail(403, 'Cloud API ayarlarını yalnızca admin veya yönetici düzenleyebilir');
  const current = store.getPanelSettings().cloudApi || {};
  const env = options.envCloudApi || {};
  const persistSecrets = options.persistSecrets !== false;
  const next = {
    baseUrl: input.baseUrl === undefined ? current.baseUrl : String(input.baseUrl || '').trim(),
    phoneNumberId: input.phoneNumberId === undefined ? current.phoneNumberId : String(input.phoneNumberId || '').trim(),
    wabaId: input.wabaId === undefined ? current.wabaId : String(input.wabaId || '').trim(),
    webhookVerifyToken: input.webhookVerifyToken === undefined
      ? current.webhookVerifyToken
      : String(input.webhookVerifyToken || '').trim(),
    accessToken: input.accessToken === undefined
      ? (env.accessToken || current.accessToken)
      : (String(input.accessToken || '').trim() || current.accessToken || env.accessToken),
    appSecret: input.appSecret === undefined
      ? (env.appSecret || current.appSecret)
      : (String(input.appSecret || '').trim() || current.appSecret || env.appSecret)
  };
  if (!persistSecrets) {
    next.accessToken = env.accessToken || '';
    next.appSecret = env.appSecret || '';
  }
  store.updatePanelSettings({
    cloudApi: {
      ...next,
      updatedAt: now(),
      updatedBy: actor.id
    }
  });
  store.audit(actor.id, 'settings.cloudapi.update', 'panelSettings', 'cloudApi');
  const accounts = store.all('whatsappAccounts').filter((a) => a.provider === 'cloudapi' && a.active !== false);
  for (const account of accounts) {
    await provider.ensureHealthy(account);
  }
  return serializeCloudApiSettings(store);
}

function touchPanelClick(store, actor) {
  if (!actor) return null;
  const clickedAt = now();
  return store.update('users', actor.id, { lastPanelClickAt: clickedAt }, true);
}

function recordUserError(store, actor, action, message, metadata = {}) {
  if (!actor) return;
  store.audit(actor.id, action, 'error', null, { message, ...metadata });
  store.update('users', actor.id, {
    lastErrorAt: now(),
    lastErrorMessage: String(message || '').slice(0, 240)
  });
}

async function listAccounts(store, actor) {
  const accounts = store.all('whatsappAccounts').filter((account) => {
    const owner = store.find('users', account.userId);
    return account.active !== false && owner && canReadUser(actor, owner);
  });
  return accounts.map(serializeAccount);
}

async function createAccount(store, actor, provider, input) {
  const userId = input.userId || actor.id;
  const owner = store.find('users', userId);
  if (!owner) throw fail(404, 'Personel bulunamadı');
  if (owner.role !== roles.staff) throw fail(400, 'WhatsApp hesabı sadece personel kullanıcısına eklenebilir');
  if (!canCreateStaffAccount(actor, owner)) throw fail(403, 'Bu personel için WhatsApp hesabı ekleme yetkiniz yok');
  if (!cloudApiReady(store)) {
    throw fail(409, 'Cloud API ayarları henüz yapılandırılmamış. Yöneticinizden Phone Number ID ve Access Token girmesini isteyin.');
  }

  const phoneNumber = normalizePhone(requireText(input.phoneNumber, 'Telefon numarası'));
  const MAX_STAFF_ACCOUNTS = 10;
  const activeAccounts = store.all('whatsappAccounts').filter((item) => (
    item.userId === owner.id && item.active !== false && item.status !== 'deleted'
  ));
  if (activeAccounts.length >= MAX_STAFF_ACCOUNTS) {
    throw fail(409, `Bir personel en fazla ${MAX_STAFF_ACCOUNTS} WhatsApp numarası ekleyebilir`);
  }
  const duplicate = activeAccounts.find((item) => normalizePhone(item.phoneNumber) === phoneNumber);
  if (duplicate) throw fail(409, 'Bu telefon numarası zaten hesaplarınızda kayıtlı');

  const created = store.create('whatsappAccounts', {
    userId,
    departmentId: owner.departmentId,
    label: String(input.label || '').trim() || phoneNumber,
    phoneNumber,
    cloudPhoneNumberId: String(input.cloudPhoneNumberId || '').trim() || null,
    provider: 'cloudapi',
    status: 'creating',
    statusReason: 'Cloud API bağlantısı doğrulanıyor',
    connectionHealth: 'initializing',
    qrCode: null,
    active: true,
    createdAt: now(),
    updatedAt: now()
  });

  await provider.ensureHealthy(store.find('whatsappAccounts', created.id));
  store.audit(actor.id, 'account.create', 'whatsappAccount', created.id, { userId, phoneNumber, provider: 'cloudapi' });
  return serializeAccount(store.find('whatsappAccounts', created.id));
}

async function updateAccount(store, actor, id, input) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (actor.role === roles.staff) throw fail(403, 'Personel hesap bilgilerini düzenleyemez');
  if (actor.role === roles.auditor || actor.role === roles.manager) {
    throw fail(403, 'Hesap bilgilerini düzenleme yetkiniz yok');
  }
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesabı düzenleme yetkiniz yok');

  const changes = {};
  if (input.label !== undefined) changes.label = requireText(input.label, 'Hesap takma adı');
  if (input.phoneNumber !== undefined) changes.phoneNumber = normalizePhone(requireText(input.phoneNumber, 'Telefon numarası'));
  if (input.cloudPhoneNumberId !== undefined) {
    changes.cloudPhoneNumberId = String(input.cloudPhoneNumberId || '').trim() || null;
  }

  const updated = store.update('whatsappAccounts', id, changes);
  store.audit(actor.id, 'account.update', 'whatsappAccount', id);
  return serializeAccount(updated);
}

async function checkAccountHealth(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu hesabı görme yetkiniz yok');
  const result = await provider.ensureHealthy(account);
  return serializeAccount(result);
}

async function deleteAccount(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (actor.role === roles.auditor || actor.role === roles.manager) {
    throw fail(403, 'Hesap silme yetkiniz yok');
  }
  if (!canDeleteAccount(actor, owner)) throw fail(403, 'Bu hesabı silme yetkiniz yok');
  if (account.status === 'connected') await provider.disconnect(account, 'Hesap silindi');
  const updated = store.update('whatsappAccounts', id, {
    active: false,
    status: 'deleted',
    qrCode: null,
    statusReason: 'Hesap panelden silindi',
    connectionHealth: 'deleted'
  });
  store.audit(actor.id, 'account.delete', 'whatsappAccount', id);
  return serializeAccount(updated);
}

async function disconnectAccount(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (actor.role === roles.auditor || actor.role === roles.manager) {
    throw fail(403, 'Hesap bağlantısını kesme yetkiniz yok');
  }
  if (!canDisconnectAccount(actor, owner)) throw fail(403, 'Bu hesabın bağlantısını kesme yetkiniz yok');
  const updated = await provider.disconnect(account);
  store.audit(actor.id, 'account.disconnect', 'whatsappAccount', id);
  return serializeAccount(updated);
}

function computeUnreadCount(store, conversationId) {
  const messages = store.getMessagesForConversation
    ? store.getMessagesForConversation(conversationId)
    : store.all('messages').filter((m) => m.conversationId === conversationId);
  return messages.filter((message) => (
    message.direction === 'in'
    && message.status !== 'read'
    && !message.hidden
  )).length;
}

function listConversations(store, actor, accountId) {
  const accounts = store.all('whatsappAccounts')
    .filter((account) => {
      const owner = store.find('users', account.userId);
      return account.active !== false && owner && canReadUser(actor, owner);
    })
    .map((account) => account.id);

  const messagesByConversation = new Map();
  for (const message of store.all('messages')) {
    if (message.hidden) continue;
    const list = messagesByConversation.get(message.conversationId);
    if (list) list.push(message);
    else messagesByConversation.set(message.conversationId, [message]);
  }
  if (store.getMessagesForConversation) {
    messagesByConversation.clear();
    for (const conversation of store.all('conversations')) {
      const visible = store.getMessagesForConversation(conversation.id).filter((m) => !m.hidden);
      if (visible.length) messagesByConversation.set(conversation.id, visible);
    }
  }

  return store.all('conversations')
    .filter((conversation) => accounts.includes(conversation.accountId))
    .filter((conversation) => !accountId || conversation.accountId === accountId)
    .map((conversation) => {
      const messages = messagesByConversation.get(conversation.id) || [];
      const lastMessage = messages
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
      const lastPreview = lastMessage
        ? { ...lastMessage, text: lastMessage.text || (lastMessage.mediaType ? mediaLabel(lastMessage.mediaType) : '') }
        : null;
      const unreadCount = computeUnreadCount(store, conversation.id);
      const window = sessionWindow(conversation);
      return { ...conversation, lastMessage: lastPreview, unreadCount, windowOpen: window.open, windowExpiresAt: window.expiresAt };
    });
}

function getOrCreateConversation(store, account, customerPhone, customerName = '') {
  const raw = requireText(customerPhone, 'Müşteri telefonu');
  const phone = normalizePhone(raw) || raw;
  let conversation = store.all('conversations').find((item) => (
    item.accountId === account.id && normalizePhone(item.customerPhone) === phone
  ));
  if (conversation) return conversation;
  conversation = store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: phone,
    customerName: String(customerName || phone).trim(),
    status: 'open',
    unreadCount: 0,
    createdAt: now(),
    updatedAt: now(),
    lastMessageAt: null
  });
  return conversation;
}

function listMessages(store, actor, conversationId, { limit = 200, before } = {}) {
  const conversation = store.find('conversations', conversationId);
  if (!conversation) throw fail(404, 'Sohbet bulunamadı');
  const owner = store.find('users', conversation.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu sohbeti görme yetkiniz yok');

  const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
  let messages = store.all('messages')
    .filter((message) => message.conversationId === conversationId)
    .filter((message) => !message.hidden || actor.role !== roles.staff)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  if (before) {
    messages = messages.filter((message) => String(message.createdAt) < String(before));
  }
  if (messages.length > max) {
    messages = messages.slice(messages.length - max);
  }
  return messages;
}

function markConversationRead(store, actor, conversationId) {
  const conversation = store.find('conversations', conversationId);
  if (!conversation) throw fail(404, 'Sohbet bulunamadı');
  const owner = store.find('users', conversation.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu sohbeti görme yetkiniz yok');
  const unread = store.all('messages').filter((message) => (
    message.conversationId === conversationId && message.direction === 'in' && message.status !== 'read'
  ));
  const seenAt = now();
  store.beginBatch();
  unread.forEach((message) => {
    const changes = { status: 'read' };
    if (!message.seenByUserId) {
      changes.seenByUserId = actor.id;
      changes.seenAt = seenAt;
    }
    store.update('messages', message.id, changes, false);
  });
  if (unread.length > 0) {
    store.update('conversations', conversationId, { unreadCount: 0 }, false);
  }
  store.endBatch();
  touchPanelClick(store, actor);
  return { conversationId, updated: unread.length };
}

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
function sessionWindow(conversation) {
  const last = conversation?.lastInboundAt ? Date.parse(conversation.lastInboundAt) : NaN;
  if (Number.isNaN(last)) return { open: false, expiresAt: null };
  const expiresAt = last + SESSION_WINDOW_MS;
  return { open: Date.now() < expiresAt, expiresAt: new Date(expiresAt).toISOString() };
}

function buildTemplateComponents(template, variables) {
  const body = applyTemplate(template.body, variables || {});
  const placeholders = [...String(template.body).matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
  if (!placeholders.length) return { text: body, components: undefined };
  return {
    text: body,
    components: [{
      type: 'body',
      parameters: placeholders.map((key) => ({
        type: 'text',
        text: String(variables?.[key] ?? variables?.[key.replace(/\s+/g, '_')] ?? '')
      }))
    }]
  };
}

async function sendMessage(store, actor, provider, input) {
  const account = store.find('whatsappAccounts', requireText(input.accountId, 'WhatsApp hesabı'));
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  if (account.status !== 'connected') throw fail(409, 'WhatsApp hesabı bağlı değil');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesap üzerinden mesaj gönderme yetkiniz yok');
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (idempotencyKey) {
    const duplicate = store.all('messages').find((m) => (
      m.senderUserId === actor.id && m.metadata?.idempotencyKey === idempotencyKey
    ));
    if (duplicate) {
      const conversation = store.find('conversations', duplicate.conversationId);
      return { conversation, message: duplicate, duplicate: true };
    }
  }
  const conversation = input.conversationId
    ? store.find('conversations', input.conversationId)
    : getOrCreateConversation(store, account, input.customerPhone, input.customerName);
  if (!conversation || conversation.accountId !== account.id) throw fail(404, 'Sohbet bulunamadı');

  let text = requireText(input.text, 'Mesaj');
  let templateId = input.templateId || null;
  let template = null;
  let templateComponents;
  if (templateId) {
    template = store.find('templates', templateId);
    if (!template || !template.active || (!canReadDepartment(actor, template.departmentId) && !sameDepartment(actor, template.departmentId))) {
      throw fail(404, 'Şablon bulunamadı');
    }
    const built = buildTemplateComponents(template, input.variables || {});
    text = built.text;
    templateComponents = built.components;
  }

  const window = sessionWindow(conversation);
  let delivery;
  if (!window.open) {
    if (!template) {
      throw fail(409, '24 saatlik yanıt penceresi kapalı. Serbest metin gönderilemez; yalnızca onaylı bir şablon gönderebilirsiniz.');
    }
    if (!template.metaTemplateName) {
      throw fail(409, 'Bu şablon Meta onaylı bir şablonla eşleştirilmemiş. Pencere kapalıyken yalnızca Meta şablon adı tanımlı şablonlar gönderilebilir.');
    }
    delivery = await provider.sendTemplate(account, conversation, {
      name: template.metaTemplateName,
      language: template.language || 'tr',
      components: templateComponents
    });
    delivery.text = text;
  } else if (template && template.metaTemplateName && input.forceTemplate) {
    delivery = await provider.sendTemplate(account, conversation, {
      name: template.metaTemplateName,
      language: template.language || 'tr',
      components: templateComponents
    });
    delivery.text = text;
  } else {
    delivery = await provider.sendMessage(account, conversation, text);
  }

  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    senderUserId: actor.id,
    direction: 'out',
    text: delivery.text,
    templateId,
    providerMessageId: delivery.providerMessageId,
    status: delivery.status,
    hidden: false,
    metadata: idempotencyKey ? { idempotencyKey } : undefined,
    createdAt: delivery.sentAt,
    updatedAt: delivery.sentAt
  });
  store.update('conversations', conversation.id, { lastMessageAt: message.createdAt });
  markOutboundResponse(store, conversation.id, actor.id, message.createdAt);
  store.audit(actor.id, 'message.send', 'message', message.id, { accountId: account.id, conversationId: conversation.id });
  touchPanelClick(store, actor);
  return { conversation, message };
}

function markOutboundResponse(store, conversationId, actorId, respondedAt) {
  const pending = store.all('messages')
    .filter((item) => item.conversationId === conversationId && item.direction === 'in' && !item.respondedAt);
  if (!pending.length) return;
  store.beginBatch();
  pending.forEach((message) => {
    store.update('messages', message.id, {
      respondedAt,
      respondedByUserId: actorId
    }, false);
  });
  store.endBatch();
}

function mediaTypeFromMime(mime) {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function mediaExt(mime, fileName) {
  const fromName = fileName ? path.extname(fileName).replace('.', '').toLowerCase() : '';
  if (fromName) return fromName;
  if (!mime) return 'bin';
  const sub = String(mime).split(';')[0].split('/')[1] || 'bin';
  const map = { jpeg: 'jpg', 'svg+xml': 'svg', plain: 'txt', mpeg: 'mp3', quicktime: 'mov', 'x-matroska': 'mkv' };
  return map[sub] || sub.replace(/[^a-z0-9]+/gi, '') || 'bin';
}

function mediaLabel(mediaType) {
  return { image: '[Fotoğraf]', video: '[Video]', audio: '[Ses]', document: '[Dosya]' }[mediaType] || '[Medya]';
}

async function sendMediaMessage(store, actor, provider, mediaDir, input) {
  const conversation = store.find('conversations', requireText(input.conversationId, 'Sohbet'));
  if (!conversation) throw fail(404, 'Sohbet bulunamadı');
  const account = store.find('whatsappAccounts', conversation.accountId);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesap üzerinden mesaj gönderme yetkiniz yok');
  const buffer = input.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, 'Dosya boş');
  const mimeType = String(input.mimeType || 'application/octet-stream');
  const fileName = input.fileName ? String(input.fileName) : null;
  const caption = input.caption ? String(input.caption) : '';
  const mediaType = mediaTypeFromMime(mimeType);

  if (!sessionWindow(conversation).open) {
    throw fail(409, '24 saatlik yanıt penceresi kapalı. Medya gönderilemez; yalnızca onaylı bir şablon gönderebilirsiniz.');
  }

  const delivery = await provider.sendMedia(account, conversation, { buffer, mimeType, fileName, mediaType, caption });

  const providerMessageId = delivery.providerMessageId;
  const dir = path.join(mediaDir, account.id);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${providerMessageId}.${mediaExt(mimeType, fileName)}`;
  fs.writeFileSync(path.join(dir, storedName), buffer);

  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    senderUserId: actor.id,
    direction: 'out',
    text: caption,
    templateId: null,
    providerMessageId,
    status: delivery.status || 'sent',
    hidden: false,
    mediaType,
    mediaFile: path.posix.join(account.id, storedName),
    mimeType,
    fileName: fileName || storedName,
    mediaSize: buffer.length,
    createdAt: delivery.sentAt,
    updatedAt: delivery.sentAt
  });
  store.update('conversations', conversation.id, { lastMessageAt: message.createdAt });
  markOutboundResponse(store, conversation.id, actor.id, message.createdAt);
  store.audit(actor.id, 'message.send.media', 'message', message.id, { accountId: account.id, conversationId: conversation.id, mediaType });
  touchPanelClick(store, actor);
  return { conversation, message };
}

function getMessageMedia(store, actor, mediaDir, messageId) {
  const message = store.find('messages', messageId);
  if (!message || !message.mediaFile) throw fail(404, 'Medya bulunamadı');
  const conversation = store.find('conversations', message.conversationId);
  if (!conversation) throw fail(404, 'Sohbet bulunamadı');
  const owner = store.find('users', conversation.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu medyayı görme yetkiniz yok');
  if (message.hidden && actor.role === roles.staff) throw fail(404, 'Medya bulunamadı');
  const baseDir = path.resolve(mediaDir);
  const absPath = path.resolve(baseDir, message.mediaFile);
  const rel = path.relative(baseDir, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail(400, 'Geçersiz medya yolu');
  return {
    absPath,
    mimeType: message.mimeType || 'application/octet-stream',
    fileName: message.fileName || path.basename(absPath),
    mediaType: message.mediaType
  };
}

function hideMessage(store, actor, id) {
  const message = store.find('messages', id);
  if (!message) throw fail(404, 'Mesaj bulunamadı');
  if (!canHideMessage(actor, message.departmentId)) throw fail(403, 'Mesaj gizleme yetkiniz yok');
  const conversationId = message.conversationId;
  const updated = store.update('messages', id, {
    hidden: true,
    hiddenBy: actor.id,
    hiddenAt: now()
  });
  store.audit(actor.id, 'message.hide', 'message', id);
  if (conversationId) {
    store.update('conversations', conversationId, {
      unreadCount: computeUnreadCount(store, conversationId)
    });
  }
  return updated;
}

function istanbulDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
}

function resolveFilterDate(input) {
  const raw = String(input || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return istanbulDayKey(new Date());
}

function phoneSearchDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function allowedTemplateContactStaffIds(store, actor) {
  if (actor.role === roles.staff) return new Set([actor.id]);
  const scope = departmentScope(store, actor);
  return new Set(
    store.all('users')
      .filter((user) => user.role === roles.staff && user.active !== false && (!scope || user.departmentId === scope))
      .map((user) => user.id)
  );
}

function getTemplateContactLog(store, actor, query = {}) {
  const searchRaw = String(query.search || query.phone || '').trim();
  const searchDigits = searchRaw ? phoneSearchDigits(searchRaw) : '';
  const allowedStaffIds = allowedTemplateContactStaffIds(store, actor);
  const templatesById = new Map(store.all('templates').map((template) => [template.id, template]));
  const conversationsById = new Map(store.all('conversations').map((conversation) => [conversation.id, conversation]));
  const usersById = new Map(store.all('users').map((user) => [user.id, user]));
  const departmentsById = new Map(store.all('departments').map((department) => [department.id, department]));

  const entries = [];
  for (const message of store.all('messages')) {
    if (message.direction !== 'out' || !message.templateId || message.hidden) continue;
    if (!message.senderUserId || !allowedStaffIds.has(message.senderUserId)) continue;
    const conversation = conversationsById.get(message.conversationId);
    if (!conversation) continue;
    const phone = normalizePhone(conversation.customerPhone) || conversation.customerPhone || '';
    if (searchDigits && !String(phone).includes(searchDigits)) continue;
    const sender = usersById.get(message.senderUserId);
    const template = templatesById.get(message.templateId);
    const department = departmentsById.get(sender?.departmentId || message.departmentId);
    entries.push({
      id: message.id,
      phone,
      customerName: conversation.customerName || phone,
      contactedAt: message.createdAt,
      templateId: message.templateId,
      templateTitle: template?.title || '-',
      staffUserId: message.senderUserId,
      staffName: sender?.fullName || '-',
      staffUsername: sender?.username || '-',
      departmentId: department?.id || sender?.departmentId || null,
      departmentName: department?.name || '-'
    });
  }

  entries.sort((a, b) => String(b.contactedAt).localeCompare(String(a.contactedAt)));
  return {
    search: searchRaw || null,
    total: entries.length,
    canExport: actor.role !== roles.staff,
    showStaff: actor.role !== roles.staff,
    entries
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function buildTemplateContactExport(store, log) {
  if (!log?.canExport) {
    const error = new Error('Excel dışa aktarma yetkiniz yok');
    error.statusCode = 403;
    throw error;
  }
  const headers = ['Personel', 'Kullanıcı Adı', 'Departman', 'Numara', 'Müşteri Adı', 'Tarih', 'Şablon'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const entry of log.entries) {
    lines.push([
      entry.staffName,
      entry.staffUsername,
      entry.departmentName,
      entry.phone,
      entry.customerName,
      entry.contactedAt,
      entry.templateTitle
    ].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function getStaffOperations(store, actor, query = {}) {
  if (actor.role !== roles.staff) throw fail(403, 'Bu rapor yalnızca personel içindir');
  const filterDate = resolveFilterDate(query.date);

  const accountIds = new Set(
    store.all('whatsappAccounts')
      .filter((account) => account.userId === actor.id && account.active !== false && account.status !== 'deleted')
      .map((account) => account.id)
  );

  const conversationIds = new Set(
    store.all('conversations')
      .filter((conversation) => accountIds.has(conversation.accountId))
      .map((conversation) => conversation.id)
  );

  const outboundTemplateMessages = store.all('messages').filter((message) => (
    message.direction === 'out'
    && message.templateId
    && !message.hidden
    && message.senderUserId === actor.id
    && conversationIds.has(message.conversationId)
    && istanbulDayKey(message.createdAt) === filterDate
  ));

  const uniqueByTemplate = new Map();
  for (const message of outboundTemplateMessages) {
    if (!uniqueByTemplate.has(message.templateId)) uniqueByTemplate.set(message.templateId, new Set());
    uniqueByTemplate.get(message.templateId).add(message.conversationId);
  }

  const outboundByConversation = new Map();
  for (const message of store.all('messages')) {
    if (!conversationIds.has(message.conversationId)) continue;
    if (message.direction !== 'out' || message.hidden) continue;
    if (!outboundByConversation.has(message.conversationId)) outboundByConversation.set(message.conversationId, []);
    outboundByConversation.get(message.conversationId).push(message);
  }

  let totalFirstContacts = 0;
  for (const [, list] of outboundByConversation) {
    const ordered = list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const first = ordered[0];
    if (
      first
      && first.templateId
      && first.senderUserId === actor.id
      && istanbulDayKey(first.createdAt) === filterDate
    ) {
      totalFirstContacts += 1;
    }
  }

  const templates = listTemplates(store, actor).filter((template) => template.active !== false);
  const byTemplate = templates.map((template) => ({
    templateId: template.id,
    title: template.title,
    uniqueRecipients: uniqueByTemplate.get(template.id)?.size || 0
  }));

  return {
    date: filterDate,
    totalFirstContacts,
    byTemplate
  };
}

function getReports(store, actor) {
  const scope = departmentScope(store, actor);
  const users = store.all('users').filter((user) => {
    if (actor.role === roles.staff) return user.id === actor.id;
    return !scope || user.departmentId === scope;
  });
  const userIds = new Set(users.map((user) => user.id));
  const messages = store.all('messages').filter((message) => userIds.has(message.userId));
  const accounts = store.all('whatsappAccounts')
    .filter((account) => account.active !== false)
    .filter((account) => userIds.has(account.userId));
  const conversations = store.all('conversations').filter((conversation) => userIds.has(conversation.userId));
  return {
    users: users.length,
    accounts: accounts.length,
    connectedAccounts: accounts.filter((account) => account.status === 'connected').length,
    conversations: conversations.length,
    incomingMessages: messages.filter((message) => message.direction === 'in').length,
    outgoingMessages: messages.filter((message) => message.direction === 'out').length,
    templatesUsed: messages.filter((message) => message.templateId).length,
    byUser: users.map((user) => ({
      user: publicUser(user),
      accounts: accounts.filter((account) => account.userId === user.id).length,
      conversations: conversations.filter((conversation) => conversation.userId === user.id).length,
      incomingMessages: messages.filter((message) => message.userId === user.id && message.direction === 'in').length,
      outgoingMessages: messages.filter((message) => message.userId === user.id && message.direction === 'out').length
    }))
  };
}

function buildResponseSamplesByUser(messages, filterDate) {
  const responseSamplesByUser = new Map();
  const byConversation = new Map();
  for (const message of messages) {
    if (!byConversation.has(message.conversationId)) byConversation.set(message.conversationId, []);
    byConversation.get(message.conversationId).push(message);
  }
  for (const [, list] of byConversation) {
    const ordered = list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let pendingInboundAt = null;
    for (const message of ordered) {
      if (message.direction === 'in') {
        if (pendingInboundAt === null) pendingInboundAt = Date.parse(message.createdAt);
      } else if (message.direction === 'out' && pendingInboundAt !== null) {
        const diff = Date.parse(message.createdAt) - pendingInboundAt;
        const onDate = istanbulDayKey(message.createdAt) === filterDate;
        if (message.senderUserId && diff >= 0 && onDate) {
          if (!responseSamplesByUser.has(message.senderUserId)) responseSamplesByUser.set(message.senderUserId, []);
          responseSamplesByUser.get(message.senderUserId).push(diff);
        }
        pendingInboundAt = null;
      }
    }
  }
  return responseSamplesByUser;
}

async function getStaffAudit(store, actor, query = {}) {
  if (!canViewStaffAudit(actor)) throw fail(403, 'Personel denetim raporunu görme yetkiniz yok');
  const filterDate = resolveFilterDate(query.date);
  const scope = actor.role === roles.admin ? null : actor.departmentId;
  const staff = store.all('users').filter((user) => (
    user.role === roles.staff && user.active !== false && (!scope || user.departmentId === scope)
  ));
  const staffIds = new Set(staff.map((user) => user.id));
  const messages = store.fetchMessagesForAudit
    ? await store.fetchMessagesForAudit(filterDate)
    : store.all('messages');
  const conversations = store.all('conversations');
  const convById = new Map(conversations.map((c) => [c.id, c]));

  const responseSamplesByUser = buildResponseSamplesByUser(messages, filterDate);

  const auditLogs = store.all('auditLogs');
  const nowMs = Date.now();

  const byUser = staff.map((user) => {
    const sent = messages.filter((m) => (
      m.direction === 'out' && m.senderUserId === user.id && istanbulDayKey(m.createdAt) === filterDate
    ));
    const seen = messages.filter((m) => (
      m.direction === 'in' && m.seenByUserId === user.id && m.seenAt && istanbulDayKey(m.seenAt) === filterDate
    ));
    const responded = messages.filter((m) => (
      m.direction === 'in' && m.respondedByUserId === user.id && m.respondedAt && istanbulDayKey(m.respondedAt) === filterDate
    ));
    const lastSent = sent.map((m) => m.createdAt).sort().slice(-1)[0] || null;
    const lastSeen = seen.map((m) => m.seenAt).filter(Boolean).sort().slice(-1)[0] || null;
    const lastResponded = responded.map((m) => m.respondedAt).filter(Boolean).sort().slice(-1)[0] || null;
    const samples = responseSamplesByUser.get(user.id) || [];
    const avgFirstResponseMs = samples.length
      ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
      : null;
    const lastMessageActivity = [lastSent, lastSeen, lastResponded].filter(Boolean).sort().slice(-1)[0] || null;
    const errorLogs = auditLogs.filter((log) => (
      log.actorId === user.id
      && String(log.action || '').endsWith('.failed')
      && istanbulDayKey(log.createdAt) === filterDate
    ));
    const lastLoginAt = user.lastLoginAt || null;
    const lastPanelClickAt = pickLatestTimestamp(
      user.lastPanelClickAt,
      user.lastActivityAt,
      user.lastLoginAt,
      lastMessageActivity
    );
    const inactiveMs = lastPanelClickAt ? Math.max(0, nowMs - Date.parse(lastPanelClickAt)) : null;
    const sinceLoginMs = lastLoginAt ? Math.max(0, nowMs - Date.parse(lastLoginAt)) : null;
    return {
      user: publicUser(user),
      sentCount: sent.length,
      seenCount: seen.length,
      respondedCount: responded.length,
      avgFirstResponseMs,
      lastSentAt: lastSent,
      lastSeenAt: lastSeen,
      lastRespondedAt: lastResponded,
      lastMessageActivityAt: lastMessageActivity,
      lastLoginAt,
      lastPanelClickAt,
      inactiveMs,
      sinceLoginMs,
      errorCount: errorLogs.length,
      lastErrorAt: user.lastErrorAt || null,
      lastErrorMessage: user.lastErrorMessage || null
    };
  });

  const unseenIncoming = store.fetchUnseenIncomingCount
    ? await store.fetchUnseenIncomingCount([...staffIds])
    : messages.filter((m) => (
      m.direction === 'in' && !m.seenByUserId && staffIds.has((convById.get(m.conversationId) || {}).userId)
    )).length;

  return {
    date: filterDate,
    scope: scope || 'all',
    staffCount: staff.length,
    unseenIncoming,
    generatedAt: new Date(nowMs).toISOString(),
    byUser: byUser.sort((a, b) => b.sentCount - a.sentCount)
  };
}

async function login(store, username, password, totpCode) {
  const user = store.all('users').find((item) => item.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !user.active) throw fail(401, 'Kullanıcı adı veya şifre hatalı');
  const department = store.find('departments', user.departmentId);
  if (department && department.active === false) throw fail(403, 'Departmanınız pasif durumda');
  if (!(await verifyPassword(password || '', user.passwordHash))) throw fail(401, 'Kullanıcı adı veya şifre hatalı');
  if (user.totpEnabled) {
    if (!verifyTotp(user.totpSecret, totpCode)) {
      throw fail(401, 'İki faktörlü doğrulama kodu geçersiz');
    }
  }
  store.audit(user.id, 'auth.login', 'user', user.id);
  const loggedInAt = now();
  const tokenVersion = (Number(user.tokenVersion) || 0) + 1;
  store.update('users', user.id, { lastLoginAt: loggedInAt, lastPanelClickAt: loggedInAt, tokenVersion });
  return { ...user, lastLoginAt: loggedInAt, lastPanelClickAt: loggedInAt, tokenVersion };
}

function setup2fa(store, actor) {
  if (!actor) throw fail(401, 'Oturum gerekli');
  const secret = generateTotpSecret();
  store.update('users', actor.id, { totpPendingSecret: secret });
  return {
    enabled: false,
    pending: true,
    secret,
    otpauthUrl: buildOtpAuthUrl({
      issuer: 'WhatsApp Panel',
      accountName: actor.username,
      secret
    })
  };
}

function verify2faSetup(store, actor, code) {
  if (!actor) throw fail(401, 'Oturum gerekli');
  const user = store.find('users', actor.id);
  const pending = user?.totpPendingSecret;
  if (!pending) throw fail(400, 'Önce 2FA kurulumunu başlatın');
  if (!verifyTotp(pending, code)) throw fail(400, 'Doğrulama kodu geçersiz');
  store.update('users', actor.id, {
    totpSecret: pending,
    totpPendingSecret: null,
    totpEnabled: true,
    tokenVersion: (Number(user.tokenVersion) || 0) + 1
  });
  store.audit(actor.id, 'auth.2fa.enable', 'user', actor.id);
  return { enabled: true };
}

async function disable2fa(store, actor, password) {
  if (!actor) throw fail(401, 'Oturum gerekli');
  const user = store.find('users', actor.id);
  if (!user?.totpEnabled) return { enabled: false };
  if (!(await verifyPassword(password || '', user.passwordHash))) {
    throw fail(401, 'Şifre hatalı');
  }
  store.update('users', actor.id, {
    totpSecret: null,
    totpPendingSecret: null,
    totpEnabled: false,
    tokenVersion: (Number(user.tokenVersion) || 0) + 1
  });
  store.audit(actor.id, 'auth.2fa.disable', 'user', actor.id);
  return { enabled: false };
}

function applyTemplate(body, variables) {
  return String(body).replace(/\{\{([^}]+)\}\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    return variables[key] ?? variables[rawKey] ?? match;
  });
}

module.exports = {
  createAccount,
  serializeAccount,
  getCloudApiSettings,
  updateCloudApiSettings,
  touchPanelClick,
  recordUserError,
  checkAccountHealth,
  createDepartment,
  deleteDepartment,
  createTemplate,
  createUser,
  deleteAccount,
  deleteTemplate,
  deleteUser,
  disconnectAccount,
  eraseUserData,
  exportUserData,
  getReports,
  listAuditLogs,
  restoreFromBackup,
  getStaffAudit,
  getStaffOperations,
  getTemplateContactLog,
  buildTemplateContactExport,
  hideMessage,
  listAccounts,
  listConversations,
  listDepartments,
  listMessages,
  markConversationRead,
  listTemplates,
  listUsers,
  login,
  setup2fa,
  verify2faSetup,
  disable2fa,
  sendMessage,
  sendMediaMessage,
  getMessageMedia,
  updateAccount,
  updateDepartment,
  updateTemplate,
  updateUser
};