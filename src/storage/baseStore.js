const crypto = require('node:crypto');
const { hashPassword } = require('../auth');
const { emptyData } = require('./shared');

const WEBHOOK_DEDUP_MAX = 10000;
const WEBHOOK_DEDUP_TRIM = 5000;
const WEBHOOK_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class BaseStore {
  constructor(options = {}) {
    this.auditLogMax = Number(options.auditLogMax ?? 5000);
    this.data = emptyData();
    this._batchDepth = 0;
    this._pendingSave = false;
    this._saveChain = Promise.resolve();
    this._opChain = Promise.resolve();
    this._indexes = null;
  }

  _touchIndexes(collection) {
    if (collection === 'messages' || collection === 'conversations') {
      this._indexes = null;
    }
  }

  async runExclusive(fn) {
    const run = this._opChain.then(() => Promise.resolve().then(fn));
    this._opChain = run.catch(() => {});
    return run;
  }

  _buildIndexes() {
    if (this._indexes) return this._indexes;
    const messagesByConversation = new Map();
    const messagesByProviderId = new Map();
    const conversationsByAccount = new Map();
    const conversationsByPhone = new Map();

    for (const conversation of this.all('conversations')) {
      const accountList = conversationsByAccount.get(conversation.accountId);
      if (accountList) accountList.push(conversation);
      else conversationsByAccount.set(conversation.accountId, [conversation]);
      const phoneKey = `${conversation.accountId}:${String(conversation.customerPhone || '')}`;
      conversationsByPhone.set(phoneKey, conversation);
    }

    for (const message of this.all('messages')) {
      const convList = messagesByConversation.get(message.conversationId);
      if (convList) convList.push(message);
      else messagesByConversation.set(message.conversationId, [message]);
      if (message.providerMessageId) {
        const key = `${message.accountId}:${message.providerMessageId}`;
        messagesByProviderId.set(key, message);
      }
    }

    this._indexes = {
      messagesByConversation,
      messagesByProviderId,
      conversationsByAccount,
      conversationsByPhone
    };
    return this._indexes;
  }

  getMessagesForConversation(conversationId) {
    return this._buildIndexes().messagesByConversation.get(conversationId) || [];
  }

  findMessageByProviderId(accountId, providerMessageId) {
    const key = `${accountId}:${providerMessageId}`;
    return this._buildIndexes().messagesByProviderId.get(key) || null;
  }

  pruneWebhookDedup(ttlMs = WEBHOOK_DEDUP_TTL_MS) {
    const cutoff = Date.now() - ttlMs;
    const before = this.data.webhookDedup.length;
    this.data.webhookDedup = this.data.webhookDedup.filter((entry) => {
      const stamp = Date.parse(entry.createdAt);
      return !Number.isNaN(stamp) && stamp >= cutoff;
    });
    if (this.data.webhookDedup.length > WEBHOOK_DEDUP_MAX) {
      this.data.webhookDedup = this.data.webhookDedup.slice(-WEBHOOK_DEDUP_TRIM);
    }
    return before - this.data.webhookDedup.length;
  }

  claimWebhookDedup(providerMessageId) {
    const id = String(providerMessageId || '').trim();
    if (!id) return false;
    this.pruneWebhookDedup();
    if (this.data.webhookDedup.some((entry) => entry.id === id)) return false;
    this.data.webhookDedup.push({ id, createdAt: new Date().toISOString() });
    if (this.data.webhookDedup.length > WEBHOOK_DEDUP_MAX) {
      this.data.webhookDedup = this.data.webhookDedup.slice(-WEBHOOK_DEDUP_TRIM);
    }
    return true;
  }

  migrateTemplates() {
    let changed = false;
    for (const template of this.data.templates) {
      if (!template.language) {
        template.language = 'tr';
        changed = true;
      }
      if (template.title === 'İlk Bilgilendirme' && template.metaTemplateName === 'hello_world') {
        template.metaTemplateName = '';
        changed = true;
      }
    }
    return changed;
  }

  async seed(seed) {
    const now = new Date().toISOString();
    let defaultDepartment = this.data.departments.find((d) => d.name === 'Genel');
    if (!defaultDepartment) {
      defaultDepartment = this.create('departments', {
        name: 'Genel',
        active: true,
        createdAt: now,
        updatedAt: now
      }, false);
    }
    if (!this.data.users.some((u) => u.username === seed.adminUsername)) {
      const passwordHash = await hashPassword(seed.adminPassword);
      this.create('users', {
        username: seed.adminUsername,
        fullName: seed.adminFullName || 'Sistem Yöneticisi',
        passwordHash,
        role: 'admin',
        departmentId: defaultDepartment.id,
        active: true,
        createdAt: now,
        updatedAt: now
      }, false);
    }
    if (seed.cloudApi && typeof seed.cloudApi === 'object') {
      const panel = this.getPanelSettings().cloudApi;
      if (!panel.phoneNumberId && !panel.accessToken) {
        this.updatePanelSettings({
          cloudApi: {
            ...panel,
            baseUrl: seed.cloudApi.baseUrl || panel.baseUrl || '',
            accessToken: seed.cloudApi.accessToken || '',
            phoneNumberId: seed.cloudApi.phoneNumberId || '',
            wabaId: seed.cloudApi.wabaId || '',
            webhookVerifyToken: seed.cloudApi.webhookVerifyToken || '',
            appSecret: seed.cloudApi.appSecret || '',
            updatedAt: now,
            updatedBy: null
          }
        }, false);
      }
    }
    if (this.data.templates.length === 0) {
      this.create('templates', {
        title: 'İlk Bilgilendirme',
        body: 'Merhaba {{müşteri_adı}}, görüşmemize istinaden ürün bilgilerimizi sizinle paylaşıyorum.',
        departmentId: defaultDepartment.id,
        metaTemplateName: '',
        language: 'tr',
        active: true,
        createdBy: null,
        createdAt: now,
        updatedAt: now
      }, false);
    }
  }

  mergeDefaults(loaded) {
    const defaults = emptyData();
    for (const key of Object.keys(defaults)) {
      if (key === 'panelSettings') {
        if (!loaded.panelSettings || typeof loaded.panelSettings !== 'object') {
          loaded.panelSettings = defaults.panelSettings;
        } else if (!loaded.panelSettings.cloudApi) {
          loaded.panelSettings.cloudApi = { ...defaults.panelSettings.cloudApi };
        }
      } else if (!Array.isArray(loaded[key])) {
        loaded[key] = [];
      }
    }
    return loaded;
  }

  beginBatch() {
    this._batchDepth += 1;
  }

  endBatch() {
    this._batchDepth = Math.max(0, this._batchDepth - 1);
    if (this._batchDepth === 0 && this._pendingSave) {
      this._pendingSave = false;
      this.save();
    }
  }

  save() {
    if (this._batchDepth > 0) {
      this._pendingSave = true;
      return;
    }
    this._saveChain = this._saveChain.then(() => this._saveNow()).catch((error) => {
      console.error('Store kayıt hatası:', error.message);
    });
    return this._saveChain;
  }

  pruneAuditLogs() {
    if (!Array.isArray(this.data.auditLogs)) return;
    if (!this.auditLogMax || this.auditLogMax <= 0) return;
    if (this.data.auditLogs.length > this.auditLogMax) {
      this.data.auditLogs = this.data.auditLogs.slice(-this.auditLogMax);
    }
  }

  all(collection) {
    return this.data[collection] || [];
  }

  find(collection, id) {
    return this.all(collection).find((item) => item.id === id) || null;
  }

  create(collection, payload, persist = true) {
    const item = { id: crypto.randomUUID(), ...payload };
    this.data[collection].push(item);
    this._touchIndexes(collection);
    if (persist) this.save();
    return item;
  }

  update(collection, id, changes, persist = true) {
    const item = this.find(collection, id);
    if (!item) return null;
    Object.assign(item, changes, { updatedAt: new Date().toISOString() });
    this._touchIndexes(collection);
    if (persist) this.save();
    return item;
  }

  remove(collection, id, persist = true) {
    const index = this.data[collection].findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data[collection].splice(index, 1);
    this._touchIndexes(collection);
    if (persist) this.save();
    return true;
  }

  removeWhere(collection, predicate, persist = true) {
    const before = this.all(collection).length;
    this.data[collection] = this.all(collection).filter((item) => !predicate(item));
    const removed = before - this.data[collection].length;
    if (removed) this._touchIndexes(collection);
    if (removed && persist) this.save();
    return removed;
  }

  anonymizeAuditLogsForUser(userId, persist = true) {
    let changed = 0;
    for (const log of this.all('auditLogs')) {
      const updates = {};
      if (log.actorId === userId) {
        updates.actorId = null;
        updates.metadata = {
          ...(log.metadata && typeof log.metadata === 'object' ? log.metadata : {}),
          actorErased: true
        };
      }
      if (log.entity === 'user' && log.entityId === userId) {
        updates.entityId = null;
        updates.metadata = {
          ...(updates.metadata || (log.metadata && typeof log.metadata === 'object' ? log.metadata : {})),
          subjectErased: true
        };
      }
      if (Object.keys(updates).length) {
        Object.assign(log, updates);
        changed += 1;
      }
    }
    if (changed && persist && this._batchDepth === 0) this.save();
    return changed;
  }

  getPanelSettings() {
    const defaults = emptyData().panelSettings;
    return {
      ...defaults,
      ...(this.data.panelSettings || {}),
      cloudApi: {
        ...defaults.cloudApi,
        ...((this.data.panelSettings || {}).cloudApi || {})
      }
    };
  }

  updatePanelSettings(changes, persist = true) {
    const current = this.getPanelSettings();
    this.data.panelSettings = {
      ...current,
      ...changes,
      cloudApi: {
        ...current.cloudApi,
        ...(changes.cloudApi || {})
      }
    };
    if (persist) this.save();
    return this.data.panelSettings;
  }

  audit(actorId, action, entity, entityId, metadata = {}, persist = true) {
    return this.create('auditLogs', {
      actorId,
      action,
      entity,
      entityId,
      metadata,
      createdAt: new Date().toISOString()
    }, persist);
  }
}

module.exports = { BaseStore };