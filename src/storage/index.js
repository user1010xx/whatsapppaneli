const { JsonStore } = require('./jsonStore');
const { PostgresStore } = require('./postgresStore');
const { emptyData } = require('./shared');

async function createStore(config = {}) {
  if (config.databaseUrl) {
    const store = new PostgresStore(config.databaseUrl, {
      auditLogMax: config.auditLogMax,
      maxBackups: config.maxBackups ?? 0,
      ssl: config.databaseSsl,
      sslRejectUnauthorized: config.databaseSslRejectUnauthorized
    });
    await store.init({
      adminUsername: config.adminUsername,
      adminPassword: config.adminPassword,
      adminFullName: config.adminFullName,
      cloudApi: config.cloudApi
    });
    return store;
  }

  const store = new JsonStore(config.dataFile, {
    auditLogMax: config.auditLogMax,
    backupDir: config.backupDir,
    maxBackups: config.maxBackups
  });
  await store.init({
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    adminFullName: config.adminFullName,
    cloudApi: config.cloudApi
  });
  return store;
}

module.exports = { createStore, JsonStore, PostgresStore, emptyData };