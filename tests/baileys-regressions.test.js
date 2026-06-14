const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { parseCookies } = require('../src/auth');
const { BaileysWhatsappProvider } = require('../src/whatsapp/baileysProvider');
const services = require('../src/services');

async function createStore(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp-panel-${name}-`));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  const department = store.all('departments')[0];
  const staff = store.create('users', {
    username: `staff-${name}`,
    fullName: 'Staff User',
    passwordHash: 'not-used',
    role: 'staff',
    departmentId: department.id,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { directory, store, department, staff };
}

test('Baileys 2@ formatındaki QR değerini geçerli kabul edip görsel üretir', async () => {
  const { store, department, staff } = await createStore('baileys-qr');
  store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Baileys QR',
    phoneNumber: '',
    provider: 'baileys',
    status: 'qr_required',
    statusReason: 'QR bekliyor',
    connectionHealth: 'waiting_qr',
    qrCode: '2@real-baileys-reference,abc,def',
    qrCreatedAt: new Date().toISOString(),
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const accounts = await services.listAccounts(store, staff);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].status, 'qr_required');
  assert.equal(accounts[0].qrCode, '2@real-baileys-reference,abc,def');
  assert.match(accounts[0].qrImage, /^data:image\/png;base64,/);
});

test('Baileys timestamp fallback saniye cinsinden kullanılır', async () => {
  const { directory, store, department, staff } = await createStore('baileys-timestamp');
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Baileys Incoming',
    phoneNumber: '',
    provider: 'baileys',
    status: 'connected',
    statusReason: 'connected',
    connectionHealth: 'healthy',
    qrCode: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = new BaileysWhatsappProvider(store, new EventHub(), { sessionDir: path.join(directory, 'sessions') });
  await provider.handleMessages(account.id, {
    messages: [{
      key: { id: 'no-timestamp-1', fromMe: false, remoteJid: '905551110000@s.whatsapp.net' },
      message: { conversation: 'timestamp fallback' }
    }]
  });
  const message = store.all('messages')[0];
  const skewMs = Math.abs(Date.now() - new Date(message.createdAt).getTime());
  assert.ok(skewMs < 60_000);
});

test('Baileys reconnect zamanlayıcısı kullanıcı bağlantıyı keserse soketi yeniden başlatmaz', async () => {
  const { directory, store, department, staff } = await createStore('baileys-reconnect');
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Reconnect',
    phoneNumber: '',
    provider: 'baileys',
    status: 'connected',
    statusReason: 'connected',
    connectionHealth: 'healthy',
    qrCode: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = new BaileysWhatsappProvider(store, new EventHub(), { sessionDir: path.join(directory, 'sessions') });
  let startCount = 0;
  provider.startClient = async () => {
    startCount += 1;
    return null;
  };
  await provider.handleConnectionUpdate(account.id, {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 }, message: 'restart required' } }
  });
  store.update('whatsappAccounts', account.id, {
    status: 'disconnected',
    connectionHealth: 'disconnected',
    active: false
  });
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(startCount, 0);
});

test('Baileys startClient eşzamanlı çağrılarda tek init çalıştırır', async () => {
  const { directory, store, department, staff } = await createStore('baileys-lock');
  const account = store.create('whatsappAccounts', {
    userId: staff.id,
    departmentId: department.id,
    label: 'Lock',
    phoneNumber: '',
    provider: 'baileys',
    status: 'qr_required',
    statusReason: 'QR',
    connectionHealth: 'waiting_qr',
    qrCode: null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const provider = new BaileysWhatsappProvider(store, new EventHub(), { sessionDir: path.join(directory, 'sessions') });
  let createCount = 0;
  provider.createClient = async () => {
    createCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { fake: true };
  };
  await Promise.all([provider.startClient(account.id), provider.startClient(account.id)]);
  assert.equal(createCount, 1);
});

test('parseCookies hatalı yüzde kodlamasında 500 üretmez', () => {
  const cookies = parseCookies('session=%; theme=dark');
  assert.equal(cookies.session, '%');
  assert.equal(cookies.theme, 'dark');
});