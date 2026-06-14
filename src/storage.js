const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');

const emptyData = () => ({
  users: [],
  departments: [],
  templates: [],
  whatsappAccounts: [],
  conversations: [],
  messages: [],
  auditLogs: []
});

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyData();
  }

  async init(seed) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(this.filePath)) {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const key of Object.keys(emptyData())) {
        if (!Array.isArray(this.data[key])) this.data[key] = [];
      }
    } else {
      this.data = emptyData();
      await this.seed(seed);
      this.save();
    }
    if (!this.data.users.some((user) => user.role === 'admin')) {
      await this.seed(seed);
      this.save();
    }
  }

  async seed(seed) {
    const now = new Date().toISOString();
    // Mevcut 'Genel' departmanını yeniden kullan; yoksa oluştur
    let defaultDepartment = this.data.departments.find((d) => d.name === 'Genel');
    if (!defaultDepartment) {
      defaultDepartment = this.create('departments', {
        name: 'Genel',
        active: true,
        createdAt: now,
        updatedAt: now
      }, false);
    }
    // Admin kullanıcısı yoksa oluştur
    if (!this.data.users.some((u) => u.username === seed.adminUsername)) {
      const passwordHash = await hashPassword(seed.adminPassword);
      this.create('users', {
        username: seed.adminUsername,
        fullName: 'Sistem Admini',
        passwordHash,
        role: 'admin',
        departmentId: defaultDepartment.id,
        active: true,
        createdAt: now,
        updatedAt: now
      }, false);
    }
    // Varsayılan şablon yoksa oluştur
    if (this.data.templates.length === 0) {
      this.create('templates', {
        title: 'İlk Bilgilendirme',
        body: 'Merhaba {{müşteri_adı}}, görüşmemize istinaden ürün bilgilerimizi sizinle paylaşıyorum.',
        departmentId: defaultDepartment.id,
        active: true,
        createdBy: null,
        createdAt: now,
        updatedAt: now
      }, false);
    }
  }

  save() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      fs.copyFileSync(temporary, this.filePath);
      fs.unlinkSync(temporary);
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
    if (persist) this.save();
    return item;
  }

  update(collection, id, changes) {
    const item = this.find(collection, id);
    if (!item) return null;
    Object.assign(item, changes, { updatedAt: new Date().toISOString() });
    this.save();
    return item;
  }

  remove(collection, id) {
    const index = this.data[collection].findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data[collection].splice(index, 1);
    this.save();
    return true;
  }

  audit(actorId, action, entity, entityId, metadata = {}) {
    const log = this.create('auditLogs', {
      actorId,
      action,
      entity,
      entityId,
      metadata,
      createdAt: new Date().toISOString()
    });
    return log;
  }
}

module.exports = { Store };