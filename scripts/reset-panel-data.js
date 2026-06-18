#!/usr/bin/env node
/**
 * Yerel panel verisini sıfırlar (data/app.json, yedekler, medya).
 * Sonraki npm start ile yalnızca .env / ortam değişkenlerindeki ilk admin oluşturulur.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');

function removePath(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

removePath(path.join(dataDir, 'app.json'));
removePath(path.join(dataDir, 'backups'));
removePath(path.join(dataDir, 'media'));
removePath(path.join(dataDir, 'whatsapp-sessions'));

console.log('Panel verisi sıfırlandı. Sunucuyu yeniden başlatın; ilk admin ortam değişkenlerinden oluşturulacak.');