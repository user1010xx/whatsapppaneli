const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');

class BaileysWhatsappProvider {
  constructor(store, eventHub, options = {}) {
    this.store = store;
    this.eventHub = eventHub;
    this.name = 'baileys';
    this.sessionDir = options.sessionDir || path.join(process.cwd(), 'data', 'whatsapp-sessions');
    this.clients = new Map();
    this.initializing = new Map();
    this.logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  async loadBaileys() {
    if (!this.baileys) {
      this.baileys = await import('@whiskeysockets/baileys');
    }
    return this.baileys;
  }

  accountSessionDir(accountId) {
    return path.join(this.sessionDir, accountId);
  }

  async createQr(account) {
    await this.stopClient(account.id);
    this.clearSession(account.id);
    const now = new Date().toISOString();
    this.store.update('whatsappAccounts', account.id, {
      status: 'qr_required',
      qrCode: null,
      statusReason: 'WhatsApp gerçek QR kodu bekleniyor',
      qrCreatedAt: now,
      connectionHealth: 'waiting_qr'
    });
    this.eventHub.emit('account.updated', { accountId: account.id });
    await this.startClient(account.id);
    return this.store.find('whatsappAccounts', account.id)?.qrCode || null;
  }

  async confirmQr(account) {
    const current = this.store.find('whatsappAccounts', account.id);
    if (current?.status === 'connected') return current;
    if (!this.clients.has(account.id)) await this.startClient(account.id);
    return this.store.find('whatsappAccounts', account.id);
  }

  async disconnect(account, reason = 'Bağlantı kullanıcı tarafından kesildi') {
    await this.stopClient(account.id);
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
    const current = this.store.find('whatsappAccounts', account.id);
    if (current?.status === 'connected') {
      const updated = this.store.update('whatsappAccounts', account.id, {
        connectionHealth: 'healthy',
        lastHeartbeatAt: new Date().toISOString()
      });
      this.eventHub.emit('account.updated', { accountId: account.id });
      return updated;
    }
    if (!this.clients.has(account.id)) await this.startClient(account.id);
    return this.store.find('whatsappAccounts', account.id);
  }

  async sendMessage(account, conversation, text) {
    const client = this.clients.get(account.id)?.socket;
    if (!client || account.status !== 'connected') {
      const error = new Error('WhatsApp hesabı bağlı değil');
      error.statusCode = 409;
      throw error;
    }
    const jid = this.toJid(conversation.customerPhone);
    const result = await client.sendMessage(jid, { text });
    return {
      providerMessageId: result?.key?.id || `baileys-${Date.now()}`,
      status: 'sent',
      sentAt: new Date().toISOString(),
      text,
      accountId: account.id,
      conversationId: conversation.id
    };
  }

  toJid(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  async startClient(accountId) {
    if (this.initializing.has(accountId)) return this.initializing.get(accountId);
    const initialization = this.createClient(accountId).finally(() => this.initializing.delete(accountId));
    this.initializing.set(accountId, initialization);
    return initialization;
  }

  async createClient(accountId) {
    const account = this.store.find('whatsappAccounts', accountId);
    if (!account || account.active === false || account.status === 'deleted') return null;
    if (this.clients.has(accountId)) return this.clients.get(accountId);
    const baileys = await this.loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.accountSessionDir(accountId));
    const { version } = await baileys.fetchLatestBaileysVersion();
    const socket = baileys.default({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: this.logger,
      browser: ['WhatsApp Panel', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    const clientState = { socket, saveCreds };
    this.clients.set(accountId, clientState);
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(accountId, update).catch((error) => {
        const latestAccount = this.store.find('whatsappAccounts', accountId);
        if (latestAccount?.status === 'connected') return;
        this.store.update('whatsappAccounts', accountId, {
          status: 'disconnected',
          qrCode: null,
          statusReason: `WhatsApp bağlantı hatası: ${error.message}`,
          connectionHealth: 'error',
          lastDisconnectedAt: new Date().toISOString()
        });
        this.eventHub.emit('account.updated', { accountId });
      });
    });
    socket.ev.on('messages.upsert', (payload) => this.handleMessages(accountId, payload).catch((error) => {
      this.logger.error({ error }, 'incoming message handling failed');
    }));
    return clientState;
  }

  async stopClient(accountId) {
    const client = this.clients.get(accountId);
    if (!client) return;
    this.clients.delete(accountId);
    try {
      client.socket.ev.removeAllListeners('connection.update');
      client.socket.ev.removeAllListeners('messages.upsert');
      client.socket.ev.removeAllListeners('creds.update');
      client.socket.end?.();
      client.socket.ws?.close?.();
    } catch {}
  }

  clearSession(accountId) {
    fs.rmSync(this.accountSessionDir(accountId), { recursive: true, force: true });
  }

  async handleConnectionUpdate(accountId, update) {
    const now = new Date().toISOString();
    if (update.qr) {
      this.store.update('whatsappAccounts', accountId, {
        status: 'qr_required',
        qrCode: update.qr,
        statusReason: 'WhatsApp QR kodu okutulmayı bekliyor',
        qrCreatedAt: now,
        connectionHealth: 'waiting_qr'
      });
      this.eventHub.emit('account.updated', { accountId });
    }
    if (update.connection === 'connecting') {
      this.store.update('whatsappAccounts', accountId, {
        status: 'connecting',
        statusReason: 'WhatsApp oturumu bağlanıyor',
        connectionHealth: 'connecting'
      });
      this.eventHub.emit('account.updated', { accountId });
    }
    if (update.connection === 'open') {
      const client = this.clients.get(accountId);
      const phoneNumber = client?.socket?.user?.id?.split(':')?.[0] || '';
      this.store.update('whatsappAccounts', accountId, {
        status: 'connected',
        qrCode: null,
        statusReason: 'WhatsApp bağlantısı aktif',
        connectionHealth: 'healthy',
        phoneNumber,
        lastConnectedAt: now,
        lastHeartbeatAt: now
      });
      this.eventHub.emit('account.updated', { accountId });
    }
    if (update.connection === 'close') {
      const baileys = await this.loadBaileys();
      const statusCode = update.lastDisconnect?.error?.output?.statusCode
        || update.lastDisconnect?.error?.statusCode
        || update.lastDisconnect?.error?.data?.statusCode;
      const closeMessage = update.lastDisconnect?.error?.message || 'Bağlantı kapandı';
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut;
      this.clients.delete(accountId);
      if (shouldReconnect) {
        this.store.update('whatsappAccounts', accountId, {
          status: 'connecting',
          qrCode: null,
          statusReason: `WhatsApp oturumu yeniden başlatılıyor (${statusCode || closeMessage})`,
          connectionHealth: 'reconnecting',
          lastDisconnectedAt: now,
          lastCloseCode: statusCode || null,
          lastCloseReason: closeMessage
        });
        this.eventHub.emit('account.updated', { accountId });
        setTimeout(() => {
          const latestAccount = this.store.find('whatsappAccounts', accountId);
          if (!latestAccount || latestAccount.active === false || latestAccount.status !== 'connecting' || latestAccount.connectionHealth !== 'reconnecting') {
            return;
          }
          this.startClient(accountId).catch((error) => {
            this.store.update('whatsappAccounts', accountId, {
              status: 'disconnected',
              qrCode: null,
              statusReason: `Yeniden bağlantı başarısız: ${error.message}`,
              connectionHealth: 'error',
              lastDisconnectedAt: new Date().toISOString()
            });
            this.eventHub.emit('account.updated', { accountId });
          });
        }, 1200);
        return;
      }
      this.clearSession(accountId);
      this.store.update('whatsappAccounts', accountId, {
        status: 'disconnected',
        qrCode: null,
        statusReason: `WhatsApp oturumu kapatıldı, QR yenileyin (${statusCode || closeMessage})`,
        connectionHealth: 'disconnected',
        lastDisconnectedAt: now,
        lastCloseCode: statusCode || null,
        lastCloseReason: closeMessage
      });
      this.eventHub.emit('account.updated', { accountId });
    }
  }

  async handleMessages(accountId, payload) {
    const account = this.store.find('whatsappAccounts', accountId);
    if (!account || !Array.isArray(payload.messages)) return;
    for (const providerMessage of payload.messages) {
      if (providerMessage.key?.fromMe) continue;
      const remoteJid = providerMessage.key?.remoteJid;
      if (!remoteJid || (!remoteJid.endsWith('@s.whatsapp.net') && !remoteJid.endsWith('@lid'))) continue;
      const messageContent = this.unwrapMessage(providerMessage.message);
      const text = this.extractText(messageContent);
      if (!text) continue;
      const customerPhone = this.extractCustomerPhone(remoteJid, providerMessage);
      const conversation = this.getOrCreateConversation(account, customerPhone);
      const timestampSeconds = Number(providerMessage.messageTimestamp || Math.floor(Date.now() / 1000));
      const createdAt = new Date(timestampSeconds * 1000).toISOString();
      if (this.store.all('messages').some((message) => message.providerMessageId === providerMessage.key?.id)) continue;
      this.store.create('messages', {
        conversationId: conversation.id,
        accountId: account.id,
        userId: account.userId,
        departmentId: account.departmentId,
        senderUserId: null,
        direction: 'in',
        text,
        templateId: null,
        providerMessageId: providerMessage.key?.id || `incoming-${Date.now()}`,
        status: 'received',
        hidden: false,
        createdAt,
        updatedAt: createdAt
      });
      this.store.update('conversations', conversation.id, { lastMessageAt: createdAt });
      this.eventHub.emit('message.created', { accountId: account.id, conversationId: conversation.id });
    }
  }

  unwrapMessage(message) {
    let current = message || {};
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    return current;
  }

  extractText(message) {
    if (!message) return '';
    return message.conversation
      || message.extendedTextMessage?.text
      || message.imageMessage?.caption
      || message.videoMessage?.caption
      || message.documentMessage?.caption
      || message.buttonsResponseMessage?.selectedDisplayText
      || message.listResponseMessage?.title
      || message.templateButtonReplyMessage?.selectedDisplayText
      || message.reactionMessage?.text
      || '';
  }

  extractCustomerPhone(remoteJid, providerMessage) {
    const participant = providerMessage.key?.participant || remoteJid;
    const source = participant.includes('@s.whatsapp.net') ? participant : remoteJid;
    return source.replace('@s.whatsapp.net', '').replace('@lid', '');
  }

  getOrCreateConversation(account, customerPhone) {
    let conversation = this.store.all('conversations').find((item) => (
      item.accountId === account.id && item.customerPhone === customerPhone
    ));
    if (conversation) return conversation;
    const now = new Date().toISOString();
    return this.store.create('conversations', {
      accountId: account.id,
      userId: account.userId,
      departmentId: account.departmentId,
      customerPhone,
      customerName: customerPhone,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null
    });
  }
}

module.exports = { BaileysWhatsappProvider };