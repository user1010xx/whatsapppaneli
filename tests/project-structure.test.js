const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('ölü public/app.js kaldırıldı, modüler giriş kullanılıyor', () => {
  assert.equal(fs.existsSync(path.join(root, 'public', 'app.js')), false);
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /\/js\/app\/main\.js/);
  assert.doesNotMatch(html, /\/app\.js/);
});

test('yardımcılar tek kaynaktan paylaşılıyor', () => {
  const escape = fs.readFileSync(path.join(root, 'public', 'js', 'shared', 'escape.js'), 'utf8');
  assert.match(escape, /export function escapeHtml/);
  assert.match(escape, /export function normalizeSearchQuery/);
});