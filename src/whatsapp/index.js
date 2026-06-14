const { MockWhatsappProvider } = require('./mockProvider');
const { BaileysWhatsappProvider } = require('./baileysProvider');

function createWhatsappProvider(name, store, eventHub, options = {}) {
  if (name === 'mock') return new MockWhatsappProvider(store, eventHub);
  if (name === 'baileys') return new BaileysWhatsappProvider(store, eventHub, options);
  throw new Error(`Bilinmeyen WhatsApp sağlayıcısı: ${name}`);
}

module.exports = { createWhatsappProvider };