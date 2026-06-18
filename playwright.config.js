const os = require('node:os');
const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const e2eDataFile = path.join(os.tmpdir(), `wp-panel-e2e-${process.pid}.json`);

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3099',
    headless: true
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:3099/health',
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '3099',
      NODE_ENV: 'development',
      SESSION_SECRET: 'e2e-session-secret',
      ADMIN_PASSWORD: 'admin123',
      DATA_FILE: e2eDataFile,
      CLOUD_API_SKIP_HEALTH_PING: '1'
    }
  }
});