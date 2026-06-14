const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { parseCookies, verifyToken } = require('./auth');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('İstek gövdesi çok büyük (max 1 MB)');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Geçersiz JSON gövdesi');
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  sendJson(response, error.statusCode || 500, {
    error: error.publicMessage || error.message || 'Sunucu hatası'
  });
}

function notFound(response) {
  sendJson(response, 404, { error: 'Bulunamadı' });
}

function forbidden(message = 'Bu işlem için yetkiniz yok') {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function serveStatic(request, response, publicDir) {
  const url = new URL(request.url, 'http://localhost');
  const rawPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolvedPublic = path.resolve(publicDir);
  const resolvedFile = path.resolve(resolvedPublic, `.${decodeURIComponent(rawPath)}`);
  const insidePublic = resolvedFile === resolvedPublic || resolvedFile.startsWith(`${resolvedPublic}${path.sep}`);
  if (!insidePublic || !fs.existsSync(resolvedFile) || fs.statSync(resolvedFile).isDirectory()) {
    return false;
  }
  const extension = path.extname(resolvedFile);
  response.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream' });
  fs.createReadStream(resolvedFile).pipe(response);
  return true;
}

function getAuthUser(request, store, secret) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.session || request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token, secret);
  if (!payload) return null;
  const user = store.find('users', payload.sub);
  if (!user || !user.active) return null;
  return user;
}

module.exports = {
  badRequest,
  forbidden,
  getAuthUser,
  notFound,
  readJson,
  sendError,
  sendJson,
  serveStatic
};