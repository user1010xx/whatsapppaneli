const path = require('node:path');
const { validatePassword } = require('./passwordPolicy');

const DEFAULTS = {
  sessionSecret: 'dev-session-secret-change-me',
  adminUsername: 'admin',
  adminPassword: 'admin123'
};

function getConfig(overrides = {}) {
  const root = path.resolve(__dirname, '..');
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

  const sessionSecret = process.env.SESSION_SECRET || overrides.sessionSecret || DEFAULTS.sessionSecret;
  const adminUsername = String(
    process.env.ADMIN_USERNAME || overrides.adminUsername || DEFAULTS.adminUsername
  ).trim();
  const adminPassword = process.env.ADMIN_PASSWORD || overrides.adminPassword || DEFAULTS.adminPassword;

  const databaseUrl = process.env.DATABASE_URL || overrides.databaseUrl || '';

  if (isProd) {
    if (sessionSecret === DEFAULTS.sessionSecret) {
      throw new Error('Üretim ortamında SESSION_SECRET ortam değişkeni zorunludur ve varsayılan değer kullanılamaz');
    }
    if (!process.env.ADMIN_USERNAME && !overrides.adminUsername) {
      throw new Error('Üretim ortamında ADMIN_USERNAME ortam değişkeni zorunludur');
    }
    if (!process.env.ADMIN_PASSWORD && !overrides.adminPassword) {
      throw new Error('Üretim ortamında ADMIN_PASSWORD ortam değişkeni zorunludur');
    }
    if (adminPassword === DEFAULTS.adminPassword) {
      throw new Error('Üretim ortamında ADMIN_PASSWORD varsayılan değer kullanılamaz');
    }
    validatePassword(adminPassword);
    if (!databaseUrl) {
      throw new Error('Üretim ortamında DATABASE_URL (PostgreSQL) zorunludur; veriler kalıcı depolamada tutulmalıdır');
    }
  }
  const redisUrl = process.env.REDIS_URL || overrides.redisUrl || '';
  const dataFile = process.env.DATA_FILE || overrides.dataFile || path.join(root, 'data', 'app.json');
  const mediaDir = process.env.MEDIA_DIR || overrides.mediaDir || (
    databaseUrl ? path.join(root, 'data', 'media') : path.join(path.dirname(dataFile), 'media')
  );
  const maxMediaBytes = Number(process.env.MAX_MEDIA_BYTES || overrides.maxMediaBytes || 32 * 1024 * 1024);
  const webhookMaxBytes = Number(process.env.WEBHOOK_MAX_BYTES || overrides.webhookMaxBytes || 256 * 1024);

  const graphVersion = process.env.CLOUD_API_GRAPH_VERSION || overrides.cloudApiGraphVersion || 'v21.0';
  const cloudApiOverrides = overrides.cloudApi || {};
  const skipHealthPingRequested = ['1', 'true', 'yes'].includes(String(
    process.env.CLOUD_API_SKIP_HEALTH_PING || overrides.cloudApiSkipHealthPing || ''
  ).toLowerCase());
  if (isProd && skipHealthPingRequested) {
    console.warn('CLOUD_API_SKIP_HEALTH_PING üretimde yok sayıldı; health ping zorunlu.');
  }
  const cloudApi = {
    baseUrl: process.env.CLOUD_API_BASE_URL || cloudApiOverrides.baseUrl || `https://graph.facebook.com/${graphVersion}`,
    accessToken: process.env.CLOUD_API_ACCESS_TOKEN || cloudApiOverrides.accessToken || '',
    phoneNumberId: process.env.CLOUD_API_PHONE_NUMBER_ID || cloudApiOverrides.phoneNumberId || '',
    wabaId: process.env.CLOUD_API_WABA_ID || cloudApiOverrides.wabaId || '',
    webhookVerifyToken: process.env.CLOUD_API_WEBHOOK_VERIFY_TOKEN || cloudApiOverrides.webhookVerifyToken || '',
    appSecret: process.env.CLOUD_API_APP_SECRET || cloudApiOverrides.appSecret || '',
    skipHealthPing: !isProd && skipHealthPingRequested
  };

  const persistSecretsInStore = !['0', 'false', 'no'].includes(String(
    process.env.PERSIST_SECRETS_IN_STORE || overrides.persistSecretsInStore || (isProd ? '0' : '1')
  ).toLowerCase());

  const databaseSslRejectUnauthorized = ['1', 'true', 'yes'].includes(String(
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || overrides.databaseSslRejectUnauthorized || ''
  ).toLowerCase());

  return {
    port: Number(process.env.PORT || overrides.port || 3000),
    databaseUrl,
    redisUrl,
    dataFile,
    mediaDir,
    maxMediaBytes,
    webhookMaxBytes,
    sessionSecret,
    adminUsername,
    adminPassword,
    adminFullName: process.env.ADMIN_FULL_NAME || overrides.adminFullName || 'Sistem Yöneticisi',
    cloudApi,
    publicDir: path.join(root, 'public'),
    trustProxy: ['1', 'true', 'yes'].includes(String(
      process.env.TRUST_PROXY || overrides.trustProxy || ''
    ).toLowerCase()),
    persistSecretsInStore,
    databaseSslRejectUnauthorized,
    graphVersion,
    auditLogMax: Number(process.env.AUDIT_LOG_MAX ?? overrides.auditLogMax ?? (isProd ? 0 : 5000)),
    maxBackups: Number(process.env.MAX_BACKUPS ?? overrides.maxBackups ?? (isProd ? 0 : 20)),
    mediaMaxAgeDays: Number(process.env.MEDIA_MAX_AGE_DAYS ?? overrides.mediaMaxAgeDays ?? (isProd ? 0 : 90)),
    pruneOrphanMedia: ['1', 'true', 'yes'].includes(String(
      process.env.PRUNE_ORPHAN_MEDIA || overrides.pruneOrphanMedia || (isProd ? '' : '1')
    ).toLowerCase()),
    requireWebhookSignature: ['1', 'true', 'yes'].includes(String(
      process.env.REQUIRE_WEBHOOK_SIGNATURE || overrides.requireWebhookSignature || (isProd ? '1' : '')
    ).toLowerCase()),
    isProd
  };
}

module.exports = { getConfig };