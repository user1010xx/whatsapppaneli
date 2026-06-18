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

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"
};

// Ham ikili gövdeyi (medya yükleme) okur. JSON gövdesinden ayrı bir sınır alır.
async function readRawBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Dosya çok büyük (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Diskteki bir dosyayı uygun başlıklarla akıtır. Belgeler için indirme
// (attachment), resim/video/ses için satır içi (inline) gösterim.
function sendFileStream(response, absPath, { mimeType, fileName, inline = true } = {}) {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    return notFound(response);
  }
  const headers = { 'Content-Type': mimeType || 'application/octet-stream' };
  if (fileName) {
    const disposition = inline ? 'inline' : 'attachment';
    const safeName = encodeURIComponent(fileName);
    headers['Content-Disposition'] = `${disposition}; filename*=UTF-8''${safeName}`;
  }
  headers['Cache-Control'] = 'private, max-age=86400';
  response.writeHead(200, { ...securityHeaders, ...headers });
  return fs.createReadStream(absPath).pipe(response);
}

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
    ...securityHeaders,
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error, { isProd = false } = {}) {
  const statusCode = error.statusCode || 500;
  const message = statusCode >= 500 && isProd
    ? 'Sunucu hatası'
    : (error.publicMessage || error.message || 'Sunucu hatası');
  sendJson(response, statusCode, { error: message });
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
  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    ...securityHeaders
  });
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
  // Token iptali: kullanıcının güncel tokenVersion'ı ile token'daki tv eşleşmeli.
  if ((Number(user.tokenVersion) || 0) !== (Number(payload.tv) || 0)) return null;
  return user;
}

// Tarayıcı kaynaklı çapraz site (CSRF) isteklerini engeller: durum değiştiren
// isteklerde Origin/Referer varsa host'un istek host'uyla aynı olmasını şart koşar.
// Origin yoksa (server-to-server, test, curl) engellenmez.
function isCrossSiteRequest(request, trustProxy = false) {
  const origin = request.headers.origin || request.headers.referer;
  if (!origin) return false;
  let originHostname;
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    return true;
  }
  // Ters proxy (Nginx/IIS) Host başlığını değiştirebilir; tarayıcı Origin'de
  // varsayılan portları (80/443) göndermez. Bu yüzden yalnızca hostname (portsuz)
  // karşılaştırılır. x-forwarded-host yalnızca proxy'ye GÜVENİLİYORSA okunur;
  // aksi halde saldırgan bu başlığı uydurarak CSRF korumasını atlatabilir.
  const targetHost = (trustProxy && request.headers['x-forwarded-host'])
    || request.headers.host || '';
  const targetHostname = targetHost.split(',')[0].trim().split(':')[0];
  return Boolean(targetHostname) && originHostname !== targetHostname;
}

module.exports = {
  badRequest,
  forbidden,
  getAuthUser,
  isCrossSiteRequest,
  notFound,
  readJson,
  readRawBody,
  securityHeaders,
  sendError,
  sendFileStream,
  sendJson,
  serveStatic
};