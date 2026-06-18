const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('escapeHtml XSS karakterlerini kaçırır', () => {
  const filePath = path.join(__dirname, '..', 'public', 'js', 'shared', 'escape.js');
  const source = fs.readFileSync(filePath, 'utf8').replace(/export /g, '');
  const context = {};
  vm.runInNewContext(`${source}; this.escapeHtml = escapeHtml; this.normalizeSearchQuery = normalizeSearchQuery;`, context);
  assert.equal(context.escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(context.escapeHtml('a & b'), 'a &amp; b');
});