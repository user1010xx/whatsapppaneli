const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('../src/storage');
const { EventHub } = require('../src/eventHub');
const { CloudApiProvider } = require('../src/whatsapp/cloudApiProvider');

test('accountConfig hesap bazlı cloudPhoneNumberId kullanır', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cloud-account-'));
  const store = new Store(path.join(directory, 'app.json'));
  await store.init({ adminUsername: 'admin', adminPassword: 'admin123' });
  store.updatePanelSettings({
    cloudApi: {
      ...store.getPanelSettings().cloudApi,
      phoneNumberId: 'panel-id',
      accessToken: 'token'
    }
  }, false);
  const provider = new CloudApiProvider(store, new EventHub(), {
    cloudApi: { accessToken: 'token', phoneNumberId: 'panel-id' }
  });
  const cfg = provider.accountConfig({ cloudPhoneNumberId: 'account-id' });
  assert.equal(cfg.phoneNumberId, 'account-id');
});