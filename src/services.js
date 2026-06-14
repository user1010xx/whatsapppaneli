const { hashPassword, verifyPassword } = require('./auth');
const QRCode = require('qrcode');
const {
  canManageDepartments,
  canManageTemplates,
  canManageUsers,
  canOperateUser,
  canReadDepartment,
  canReadUser,
  publicUser,
  roles,
  sameDepartment
} = require('./rbac');

function now() {
  return new Date().toISOString();
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
  if (role === roles.admin && actor.role !== roles.admin) throw fail(403, 'Admin oluşturma yetkiniz yok');
  const username = requireText(input.username, 'Kullanıcı adı');
  const fullName = requireText(input.fullName, 'Ad soyad');
  const passwordHash = await hashPassword(requireText(input.password, 'Şifre'));
  // Hash hesaplandıktan sonra event-loop serbest kaldı; tekrar benzersizlik kontrolü yap
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
  if (input.password) changes.passwordHash = await hashPassword(input.password);
  const duplicate = store.all('users').find((user) => user.id !== id && user.username.toLowerCase() === changes.username.toLowerCase());
  if (duplicate) throw fail(409, 'Bu kullanıcı adı zaten kullanılıyor');
  const updated = store.update('users', id, changes);
  store.audit(actor.id, 'user.update', 'user', id);
  return publicUser(updated);
}

function deleteUser(store, actor, id) {
  const target = store.find('users', id);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı');
  if (target.id === actor.id) throw fail(400, 'Kendi kullanıcınızı silemezsiniz');
  if (target.role === roles.admin && actor.role !== roles.admin) {
    throw fail(403, 'Admin kullanıcısı sadece admin tarafından pasifleştirilebilir');
  }
  if (!canManageUsers(actor, target.departmentId)) throw fail(403, 'Bu kullanıcıyı silme yetkiniz yok');
  const updated = store.update('users', id, { active: false });
  store.audit(actor.id, 'user.delete', 'user', id);
  return publicUser(updated);
}

function listTemplates(store, actor) {
  return store.all('templates').filter((template) => {
    if (!template.active) return false;
    if (actor.role === roles.admin) return true;
    return template.departmentId === actor.departmentId;
  });
}

function createTemplate(store, actor, input) {
  const departmentId = requireText(input.departmentId || actor.departmentId, 'Departman');
  if (!canManageTemplates(actor, departmentId)) throw fail(403, 'Bu departman için şablon yönetimi yetkiniz yok');
  if (!store.find('departments', departmentId)) throw fail(404, 'Departman bulunamadı');
  const created = store.create('templates', {
    title: requireText(input.title, 'Şablon başlığı'),
    body: requireText(input.body, 'Şablon metni'),
    departmentId,
    active: input.active !== false,
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
  if (!canManageTemplates(actor, template.departmentId) || !canManageTemplates(actor, nextDepartmentId)) {
    throw fail(403, 'Bu şablonu düzenleme yetkiniz yok');
  }
  if (input.departmentId && !store.find('departments', input.departmentId)) {
    throw fail(404, 'Hedef departman bulunamadı');
  }
  const updated = store.update('templates', id, {
    title: input.title === undefined ? template.title : requireText(input.title, 'Şablon başlığı'),
    body: input.body === undefined ? template.body : requireText(input.body, 'Şablon metni'),
    departmentId: nextDepartmentId,
    active: input.active === undefined ? template.active : Boolean(input.active)
  });
  store.audit(actor.id, 'template.update', 'template', id);
  return updated;
}

function deleteTemplate(store, actor, id) {
  const template = store.find('templates', id);
  if (!template) throw fail(404, 'Şablon bulunamadı');
  if (!canManageTemplates(actor, template.departmentId)) throw fail(403, 'Bu şablonu silme yetkiniz yok');
  const updated = store.update('templates', id, { active: false });
  store.audit(actor.id, 'template.delete', 'template', id);
  return updated;
}

function isQrExpired(account, ttlMs = 1000 * 45) {
  if (!account?.qrCreatedAt) return false;
  return Date.now() - new Date(account.qrCreatedAt).getTime() > ttlMs;
}

function isWhatsappQr(account) {
  if (!account?.qrCode) return false;
  if (account.provider === 'mock') return true;
  if (account.provider === 'baileys') return String(account.qrCode).trim().length > 0;
  return false;
}

async function serializeAccount(account) {
  if (!account?.qrCode) return account;
  if (!isWhatsappQr(account) || isQrExpired(account)) {
    return {
      ...account,
      qrCode: null,
      qrImage: null,
      status: 'disconnected',
      statusReason: 'QR süresi doldu veya geçersiz; QR yenileyin',
      connectionHealth: 'qr_expired'
    };
  }
  return {
    ...account,
    qrImage: await QRCode.toDataURL(account.qrCode, {
      width: 420,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    })
  };
}

async function listAccounts(store, actor) {
  const accounts = store.all('whatsappAccounts').filter((account) => {
    const owner = store.find('users', account.userId);
    return account.active !== false && owner && canReadUser(actor, owner);
  });
  return Promise.all(accounts.map(serializeAccount));
}

async function createAccount(store, actor, provider, input) {
  const userId = input.userId || actor.id;
  const owner = store.find('users', userId);
  if (!owner) throw fail(404, 'Personel bulunamadı');
  if (owner.role !== roles.staff) throw fail(400, 'WhatsApp hesabı sadece personel kullanıcısına eklenebilir');
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu personel için WhatsApp hesabı ekleme yetkiniz yok');
  const created = store.create('whatsappAccounts', {
    userId,
    departmentId: owner.departmentId,
    label: requireText(input.label || 'WhatsApp Hesabı', 'Hesap adı'),
    phoneNumber: String(input.phoneNumber || '').trim(),
    provider: provider.name || 'unknown',
    status: 'creating',
    statusReason: 'Oturum hazırlanıyor',
    connectionHealth: 'initializing',
    qrCode: null,
    active: true,
    createdAt: now(),
    updatedAt: now()
  });
  await provider.createQr(created);
  store.audit(actor.id, 'account.create', 'whatsappAccount', created.id, { userId });
  return serializeAccount(store.find('whatsappAccounts', created.id));
}

async function updateAccount(store, actor, id, input) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesabı düzenleme yetkiniz yok');
  const updated = store.update('whatsappAccounts', id, {
    label: input.label === undefined ? account.label : requireText(input.label, 'Hesap takma adı'),
    phoneNumber: input.phoneNumber === undefined ? account.phoneNumber : String(input.phoneNumber || '').trim()
  });
  store.audit(actor.id, 'account.update', 'whatsappAccount', id);
  return serializeAccount(updated);
}

async function confirmAccountQr(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesabı bağlama yetkiniz yok');
  if (account.status === 'connected') return account;
  const updated = await provider.confirmQr(account);
  store.audit(actor.id, 'account.qr.confirm', 'whatsappAccount', id);
  return serializeAccount(updated);
}

async function refreshAccountQr(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesap için QR yenileme yetkiniz yok');
  if (account.status === 'connected' && typeof provider.disconnect === 'function') {
    await provider.disconnect(account, 'QR yenileme için mevcut bağlantı kapatıldı');
  }
  store.update('whatsappAccounts', id, {
    provider: provider.name || account.provider || 'unknown',
    qrCode: null,
    status: 'creating',
    statusReason: 'Yeni QR hazırlanıyor',
    connectionHealth: 'initializing'
  });
  await provider.createQr(account);
  const updated = store.find('whatsappAccounts', id);
  store.audit(actor.id, 'account.qr.refresh', 'whatsappAccount', id);
  return serializeAccount(updated);
}

async function checkAccountHealth(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu hesabı görme yetkiniz yok');
  if (typeof provider.ensureHealthy === 'function') {
    return provider.ensureHealthy(account);
  }
  return serializeAccount(account);
}

async function deleteAccount(store, actor, provider, id) {
  const account = store.find('whatsappAccounts', id);
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesabı silme yetkiniz yok');
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
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesabın bağlantısını kesme yetkiniz yok');
  const updated = await provider.disconnect(account);
  store.audit(actor.id, 'account.disconnect', 'whatsappAccount', id);
  return serializeAccount(updated);
}

function listConversations(store, actor, accountId) {
  const accounts = store.all('whatsappAccounts')
    .filter((account) => {
      const owner = store.find('users', account.userId);
      return account.active !== false && owner && canReadUser(actor, owner);
    })
    .map((account) => account.id);
  return store.all('conversations')
    .filter((conversation) => accounts.includes(conversation.accountId))
    .filter((conversation) => !accountId || conversation.accountId === accountId)
    .map((conversation) => ({
      ...conversation,
      lastMessage: store.all('messages')
        .filter((message) => message.conversationId === conversation.id && !message.hidden)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null
    }));
}

function getOrCreateConversation(store, account, customerPhone, customerName = '') {
  const phone = requireText(customerPhone, 'Müşteri telefonu');
  let conversation = store.all('conversations').find((item) => item.accountId === account.id && item.customerPhone === phone);
  if (conversation) return conversation;
  conversation = store.create('conversations', {
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    customerPhone: phone,
    customerName: String(customerName || phone).trim(),
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
    lastMessageAt: null
  });
  return conversation;
}

function listMessages(store, actor, conversationId) {
  const conversation = store.find('conversations', conversationId);
  if (!conversation) throw fail(404, 'Sohbet bulunamadı');
  const owner = store.find('users', conversation.userId);
  if (!canReadUser(actor, owner)) throw fail(403, 'Bu sohbeti görme yetkiniz yok');
  return store.all('messages')
    .filter((message) => message.conversationId === conversationId)
    .filter((message) => !message.hidden || actor.role !== roles.staff)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function sendMessage(store, actor, provider, input) {
  const account = store.find('whatsappAccounts', requireText(input.accountId, 'WhatsApp hesabı'));
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesap üzerinden mesaj gönderme yetkiniz yok');
  const conversation = input.conversationId
    ? store.find('conversations', input.conversationId)
    : getOrCreateConversation(store, account, input.customerPhone, input.customerName);
  if (!conversation || conversation.accountId !== account.id) throw fail(404, 'Sohbet bulunamadı');
  let text = requireText(input.text, 'Mesaj');
  let templateId = input.templateId || null;
  if (templateId) {
    const template = store.find('templates', templateId);
    if (!template || !template.active || (!canReadDepartment(actor, template.departmentId) && !sameDepartment(actor, template.departmentId))) {
      throw fail(404, 'Şablon bulunamadı');
    }
    text = applyTemplate(template.body, input.variables || {});
  }
  const delivery = await provider.sendMessage(account, conversation, text);
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
    createdAt: delivery.sentAt,
    updatedAt: delivery.sentAt
  });
  store.update('conversations', conversation.id, { lastMessageAt: message.createdAt });
  store.audit(actor.id, 'message.send', 'message', message.id, { accountId: account.id, conversationId: conversation.id });
  return { conversation, message };
}

function receiveMessage(store, actor, input) {
  const account = store.find('whatsappAccounts', requireText(input.accountId, 'WhatsApp hesabı'));
  if (!account) throw fail(404, 'WhatsApp hesabı bulunamadı');
  const owner = store.find('users', account.userId);
  if (!canOperateUser(actor, owner)) throw fail(403, 'Bu hesap için gelen mesaj simülasyonu yetkiniz yok');
  const conversation = getOrCreateConversation(store, account, input.customerPhone, input.customerName);
  const createdAt = now();
  const message = store.create('messages', {
    conversationId: conversation.id,
    accountId: account.id,
    userId: account.userId,
    departmentId: account.departmentId,
    senderUserId: null,
    direction: 'in',
    text: requireText(input.text, 'Mesaj'),
    templateId: null,
    providerMessageId: `incoming-${Date.now()}`,
    status: 'received',
    hidden: false,
    createdAt,
    updatedAt: createdAt
  });
  store.update('conversations', conversation.id, { lastMessageAt: createdAt });
  store.audit(actor.id, 'message.receive.mock', 'message', message.id, { accountId: account.id, conversationId: conversation.id });
  return { conversation, message };
}

function hideMessage(store, actor, id) {
  const message = store.find('messages', id);
  if (!message) throw fail(404, 'Mesaj bulunamadı');
  if (actor.role === roles.staff) throw fail(403, 'Personel mesaj silemez');
  if (!canOperateUser(actor, store.find('users', message.userId))) throw fail(403, 'Bu mesaj için işlem yetkiniz yok');
  const updated = store.update('messages', id, {
    hidden: true,
    hiddenBy: actor.id,
    hiddenAt: now()
  });
  store.audit(actor.id, 'message.hide', 'message', id);
  return updated;
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

async function login(store, username, password) {
  const user = store.all('users').find((item) => item.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !user.active) throw fail(401, 'Kullanıcı adı veya şifre hatalı');
  if (!(await verifyPassword(password || '', user.passwordHash))) throw fail(401, 'Kullanıcı adı veya şifre hatalı');
  return user;
}

function applyTemplate(body, variables) {
  return String(body).replace(/\{\{([^}]+)\}\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    return variables[key] ?? variables[rawKey] ?? match;
  });
}

module.exports = {
  createAccount,
  confirmAccountQr,
  checkAccountHealth,
  createDepartment,
  createTemplate,
  createUser,
  deleteAccount,
  deleteTemplate,
  deleteUser,
  disconnectAccount,
  getReports,
  hideMessage,
  listAccounts,
  listConversations,
  listDepartments,
  listMessages,
  listTemplates,
  listUsers,
  login,
  receiveMessage,
  refreshAccountQr,
  sendMessage,
  updateAccount,
  updateDepartment,
  updateTemplate,
  updateUser
};