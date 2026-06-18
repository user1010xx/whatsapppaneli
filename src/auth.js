const crypto = require('node:crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

async function verifyPassword(password, storedHash) {
  const [type, salt, hash] = String(storedHash || '').split('$');
  if (type !== 'scrypt' || !salt || !hash) return false;
  const candidate = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
  const expected = Buffer.from(hash, 'base64url');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function createToken(userId, secret, tokenVersion = 0, ttlMs = 1000 * 60 * 60 * 12) {
  const payload = base64url(JSON.stringify({
    sub: userId,
    tv: Number(tokenVersion) || 0,
    exp: Date.now() + ttlMs,
    jti: crypto.randomUUID()
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.sub || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index > -1) {
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  });
  return cookies;
}

module.exports = {
  createToken,
  hashPassword,
  parseCookies,
  verifyPassword,
  verifyToken
};