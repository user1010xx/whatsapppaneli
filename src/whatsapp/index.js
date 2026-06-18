const { CloudApiProvider } = require('./cloudApiProvider');

function createWhatsappProvider(store, eventHub, options = {}) {
  return new CloudApiProvider(store, eventHub, options);
}

module.exports = { createWhatsappProvider };