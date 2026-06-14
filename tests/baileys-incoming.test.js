const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { BaileysWhatsappProvider } = require('../src/whatsapp/baileysProvider');

test('Baileys gelen mesajı yeni sohbet olarak panele kaydeder', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-baileys-incoming-'));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: 'staff-incoming',
    fullName: 'Incoming Staff',
    passwordHash: 'not-used',
    role: 'staff',
    departmentId: department.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Gerçek Hat',
    phoneNumber: '905551112233',
    provider: 'baileys',
    status: 'connected',
    statusReason: 'connected',
    connectionHealth: 'healthy',
    qrCode: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = new BaileysWhatsappProvider(store, new EventHub(), {
    sessionDir: path.join(directory, 'sessions')
  });
  await provider.handleMessages(account.id, {
    messages: [{
      key: {
        id: 'incoming-real-1',
        fromMe: false,
        remoteJid: '905551119999@s.whatsapp.net'
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        extendedTextMessage: {
          text: 'Merhaba, bilgi alabilir miyim?'
        }
      }
    }]
  });
  const conversations = store.all('conversations');
  const messages = store.all('messages');
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].customerPhone, '905551119999');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, 'in');
  assert.equal(messages[0].text, 'Merhaba, bilgi alabilir miyim?');
});