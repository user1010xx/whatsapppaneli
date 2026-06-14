const path = require('node:path');

const DEFAULTS = {
  sessionSecret: 'dev-session-secret-change-me',
  adminUsername: 'admin',
  adminPassword: 'admin123'
};

function getConfig(overrides = {}) {
  const root = path.resolve(__dirname, '..');
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

  const sessionSecret = process.env.SESSION_SECRET || overrides.sessionSecret || DEFAULTS.sessionSecret;
  const adminPassword = process.env.ADMIN_PASSWORD || overrides.adminPassword || DEFAULTS.adminPassword;

  if (isProd) {
    if (sessionSecret === DEFAULTS.sessionSecret) {
      throw new Error('Üretim ortamında SESSION_SECRET ortam değişkeni zorunludur ve varsayılan değer kullanılamaz');
    }
    if (adminPassword === DEFAULTS.adminPassword) {
      throw new Error('Üretim ortamında ADMIN_PASSWORD ortam değişkeni zorunludur ve varsayılan değer kullanılamaz');
    }
  }

  return {
    port: Number(process.env.PORT || overrides.port || 3000),
    dataFile: process.env.DATA_FILE || overrides.dataFile || path.join(root, 'data', 'app.json'),
    sessionSecret,
    adminUsername: process.env.ADMIN_USERNAME || overrides.adminUsername || DEFAULTS.adminUsername,
    adminPassword,
    whatsappProvider: process.env.WHATSAPP_PROVIDER || overrides.whatsappProvider || 'mock',
    whatsappSessionDir: process.env.WHATSAPP_SESSION_DIR || overrides.whatsappSessionDir || path.join(root, 'data', 'whatsapp-sessions'),
    publicDir: path.join(root, 'public'),
    isProd
  };
}

module.exports = { getConfig };
