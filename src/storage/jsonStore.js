const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BaseStore } = require('./baseStore');

class JsonStore extends BaseStore {
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
    this.backupDir = options.backupDir || path.join(path.dirname(filePath), 'backups');
    this.maxBackups = Number(options.maxBackups ?? 20);
    this.kind = 'json';
  }

  loadFromDisk() {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      const backup = this.latestBackupPath();
      if (backup) {
        try {
          const recovered = JSON.parse(fs.readFileSync(backup, 'utf8'));
          console.error(`app.json bozuk; yedekten kurtarıldı: ${backup}`);
          return recovered;
        } catch {
          throw new Error(`Veri dosyası okunamadı ve yedek kurtarılamadı: ${error.message}`);
        }
      }
      throw new Error(`Veri dosyası okunamadı: ${error.message}`);
    }
  }

  latestBackupPath() {
    if (!fs.existsSync(this.backupDir)) return null;
    const files = fs.readdirSync(this.backupDir)
      .filter((name) => name.startsWith('app-') && name.endsWith('.json'))
      .map((name) => path.join(this.backupDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
  }

  createBackup() {
    if (!fs.existsSync(this.filePath)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `app-${stamp}.json`);
    fs.copyFileSync(this.filePath, backupPath);
    const files = fs.readdirSync(this.backupDir)
      .filter((name) => name.startsWith('app-') && name.endsWith('.json'))
      .map((name) => path.join(this.backupDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (this.maxBackups > 0) {
      for (const old of files.slice(this.maxBackups)) {
        try { fs.unlinkSync(old); } catch {}
      }
    }
  }

  async init(seed) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(this.filePath)) {
      this.data = this.mergeDefaults(this.loadFromDisk());
      if (this.migrateTemplates()) this.save();
    } else {
      this.data = this.mergeDefaults(this.data);
      await this.seed(seed);
      this.save();
    }
    if (!this.data.users.some((user) => user.role === 'admin')) {
      await this.seed(seed);
      this.save();
    }
  }

  restoreFromLatestBackup() {
    const backup = this.latestBackupPath();
    if (!backup) {
      const error = new Error('Kurtarılabilir yedek bulunamadı');
      error.statusCode = 404;
      throw error;
    }
    this.data = this.mergeDefaults(JSON.parse(fs.readFileSync(backup, 'utf8')));
    this.save();
    return { restoredFrom: backup, restoredAt: new Date().toISOString() };
  }

  async isHealthy() {
    try {
      fs.accessSync(path.dirname(this.filePath), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async close() {}

  _saveNow() {
    this.pruneAuditLogs();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    if (fs.existsSync(this.filePath)) this.createBackup();
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    try {
      try {
        fs.renameSync(temporary, this.filePath);
      } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        fs.copyFileSync(temporary, this.filePath);
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

module.exports = { JsonStore };