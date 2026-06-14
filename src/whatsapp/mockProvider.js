const crypto = require('node:crypto');

class MockWhatsappProvider {
  constructor(store, eventHub) {
    this.store = store;
    this.eventHub = eventHub;
    this.name = 'mock';
  }

  async createQr(account) {
    const qrCode = `MOCK-QR:${account.id}:${crypto.randomBytes(8).toString('hex')}`;
    this.store.update('whatsappAccounts', account.id, {
      status: 'qr_required',
      qrCode,
      statusReason: 'QR kod okutulmayı bekliyor',
      qrCreatedAt: new Date().toISOString(),
      connectionHealth: 'waiting_qr'
    });
    this.eventHub.emit('account.updated', { accountId: account.id });
    return qrCode;
  }

  async confirmQr(account) {
    this.store.update('whatsappAccounts', account.id, {
      status: 'connecting',
      statusReason: 'QR doğrulandı, oturum bağlanıyor',
      connectionHealth: 'connecting'
    });
    const updated = this.store.update('whatsappAccounts', account.id, {
      status: 'connected',
      qrCode: null,
      statusReason: 'Bağlantı aktif ve izleniyor',
      connectionHealth: 'healthy',
      lastConnectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString()
    });
    this.eventHub.emit('account.updated', { accountId: account.id });
    return updated;
  }

  async disconnect(account, reason = 'Bağlantı kullanıcı tarafından kesildi') {
    const updated = this.store.update('whatsappAccounts', account.id, {
      status: 'disconnected',
      qrCode: null,
      statusReason: reason,
      connectionHealth: 'disconnected',
      lastDisconnectedAt: new Date().toISOString()
    });
    this.eventHub.emit('account.updated', { accountId: account.id });
    return updated;
  }

  async ensureHealthy(account) {
    if (account.status !== 'connected') return account;
    const updated = this.store.update('whatsappAccounts', account.id, {
      connectionHealth: 'healthy',
      lastHeartbeatAt: new Date().toISOString()
    });
    this.eventHub.emit('account.updated', { accountId: account.id });
    return updated;
  }

  async sendMessage(account, conversation, text) {
    if (account.status !== 'connected') {
      const error = new Error('WhatsApp hesabı bağlı değil');
      error.statusCode = 409;
      throw error;
    }
    return {
      providerMessageId: `mock-${crypto.randomUUID()}`,
      status: 'sent',
      sentAt: new Date().toISOString(),
      text,
      accountId: account.id,
      conversationId: conversation.id
    };
  }
}

module.exports = { MockWhatsappProvider };