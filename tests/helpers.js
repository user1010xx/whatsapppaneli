const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/server');

async function startTestServer(name = 'test') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp-panel-${name}-`));
  const dataFile = path.join(directory, 'app.json');
  const app = await createApp({
    port: 0,
    dataFile,
    sessionSecret: `secret-${name}`,
    adminUsername: 'admin',
    adminPassword: 'admin123',
    cloudApi: {
      accessToken: 'test-token',
      phoneNumberId: '123456789',
      webhookVerifyToken: 'verify-123',
      skipHealthPing: true
    },
    cloudApiSkipHealthPing: true
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  async function close() {
    app.eventHub.close();
    await new Promise((resolve) => app.server.close(resolve));
  }
  return { ...app, baseUrl, close, dataFile, directory };
}

async function request(baseUrl, method, pathName, body, cookie) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  const setCookie = response.headers.get('set-cookie');
  return { response, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function login(baseUrl, username = 'admin', password = 'admin123') {
  const result = await request(baseUrl, 'POST', '/api/auth/login', { username, password });
  if (!result.response.ok) throw new Error(`Login failed: ${JSON.stringify(result.data)}`);
  return result.cookie;
}

module.exports = { login, request, startTestServer };