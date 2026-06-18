const fs = require('node:fs');
const path = require('node:path');
const { normalizePhone } = require('../phone');
const { claimWebhookEvent } = require('../webhookDedup');

class CloudApiProvider {
  constructor(store, eventHub, options = {}) {
    this.store = store;
    this.eventHub = eventHub;
    this.name = 'cloudapi';
    this.config = options.cloudApi || {};
    this.redis = options.redis || null;
    this.mediaDir = options.mediaDir || path.join(process.cwd(), 'data', 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  requireProviderMessageId(result, context) {
    const id = result?.messages?.[0]?.id;
    if (!id) {
      const error = new Error(`Cloud API ${context} yanıtında mesaj kimliği döndürülmedi`);
      error.statusCode = 502;
      throw error;
    }
    return id;
  }

  panelCloudApi() {
    return this.store.getPanelSettings?.().cloudApi || {};
  }

  accountConfig(account = {}) {
    const panel = this.panelCloudApi();
    const c = this.config || {};
    return {
      baseUrl: (account.baseUrl || panel.baseUrl || c.baseUrl || 'https://graph.facebook.com/v21.0').replace(/\/+$/, ''),
      accessToken: account.accessToken || panel.accessToken || c.accessToken || '',
      phoneNumberId: account.cloudPhoneNumberId || account.phoneNumberId || panel.phoneNumberId || c.phoneNumberId || '',
      wabaId: account.wabaId || panel.wabaId || c.wabaId || '',
      skipHealthPing: Boolean(c.skipHealthPing)
    };
  }

  resolvedPhoneNumberId() {
    return this.accountConfig({}).phoneNumberId;
  }

  isConfigured(account) {
    const cfg = this.accountConfig(account);
    return Boolean(cfg.baseUrl && cfg.accessToken && cfg.phoneNumberId);
  }

  async http(account, endpoint, { method = 'GET', body, headers = {} } = {}) {
    const cfg = this.accountConfig(account);
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      const error = new Error('Cloud API kimlik bilgileri eksik (accessToken / phoneNumberId)');
      error.statusCode = 409;
      throw error;
    }
    const url = `${cfg.baseUrl}/${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined)
    });
    const textBody = await res.text();
    let parsed = null;
    try { parsed = textBody ? JSON.parse(textBody) : null; } catch { parsed = null; }
    if (!res.ok) {
      const detail = parsed?.error?.message || textBody || `HTTP ${res.status}`;
      const error = new Error(`Cloud API isteği başarısız: ${detail}`);
      error.statusCode = res.status === 401 || res.status === 403 ? 409 : 502;
      throw error;
    }
    return parsed || {};
  }

  mapStatus(raw) {
    const value = String(raw || '').toLowerCase();
    if (value === 'sent') return 'sent';
    if (value === 'delivered') return 'delivered';
    if (value === 'read') return 'read';
    if (value === 'failed') return 'failed';
    return null;
  }

  statusRank(status) {
    return { pending: 0, failed: 0, sent: 1, delivered: 2, received: 2, read: 3 }[status] ?? -1;
  }

  async ensureHealthy(account) {
    if (!this.isConfigured(account)) {
      const updated = this.store.update('whatsappAccounts', account.id, {
        status: 'disconnected',
        qrCode: null,
        statusReason: 'Cloud API kimlik bilgileri eksik (accessToken / phoneNumberId / baseUrl)',
        connectionHealth: 'disconnected'
      });
      this.eventHub.emit('account.updated', {
        accountId: account.id,
        departmentId: account.departmentId
      });
      return updated;
    }

    const cfg = this.accountConfig(account);
    if (cfg.skipHealthPing) {
      const updated = this.store.update('whatsappAccounts', account.id, {
        status: 'connected',
        qrCode: null,
        statusReason: 'Cloud API bağlantısı yapılandırıldı',
        connectionHealth: 'healthy',
        lastConnectedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString()
      });
      this.eventHub.emit('account.updated', {
        accountId: account.id,
        departmentId: account.departmentId
      });
      return updated;
    }

    try {
      await this.http(account, `${cfg.phoneNumberId}?fields=display_phone_number`, { method: 'GET' });
      const updated = this.store.update('whatsappAccounts', account.id, {
        status: 'connected',
        qrCode: null,
        statusReason: 'Cloud API bağlantısı aktif',
        connectionHealth: 'healthy',
        lastConnectedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString()
      });
      this.eventHub.emit('account.updated', {
        accountId: account.id,
        departmentId: account.departmentId
      });
      return updated;
    } catch (error) {
      const updated = this.store.update('whatsappAccounts', account.id, {
        status: 'disconnected',
        qrCode: null,
        statusReason: `Cloud API bağlantı doğrulaması başarısız: ${error.message}`,
        connectionHealth: 'error'
      });
      this.eventHub.emit('account.updated', {
        accountId: account.id,
        departmentId: account.departmentId
      });
      return updated;
    }
  }

  async disconnect(account, reason = 'Bağlantı kullanıcı tarafından kesildi') {
    const updated = this.store.update('whatsappAccounts', account.id, {
      status: 'disconnected',
      qrCode: null,
      statusReason: reason,
      connectionHealth: 'disconnected',
      lastDisconnectedAt: new Date().toISOString()
    });
    this.eventHub.emit('account.updated', {
      accountId: account.id,
      departmentId: account.departmentId
    });
    return updated;
  }

  async sendMessage(account, conversation, text) {
    const to = this.recipient(conversation);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text }
    };
    const cfg = this.accountConfig(account);
    const result = await this.http(account, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: payload });
    return {
      providerMessageId: this.requireProviderMessageId(result, 'metin gönderimi'),
      status: 'sent',
      sentAt: new Date().toISOString(),
      text,
      accountId: account.id,
      conversationId: conversation.id
    };
  }

  async sendTemplate(account, conversation, { name, language = 'tr', components } = {}) {
    if (!name) {
      const error = new Error('Şablon gönderimi için Meta şablon adı (metaTemplateName) gerekli');
      error.statusCode = 400;
      throw error;
    }
    const to = this.recipient(conversation);
    const template = { name, language: { code: language || 'tr' } };
    if (Array.isArray(components) && components.length > 0) template.components = components;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template
    };
    const cfg = this.accountConfig(account);
    const result = await this.http(account, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: payload });
    return {
      providerMessageId: this.requireProviderMessageId(result, 'şablon gönderimi'),
      status: 'sent',
      sentAt: new Date().toISOString(),
      accountId: account.id,
      conversationId: conversation.id
    };
  }

  async sendMedia(account, conversation, { buffer, mimeType, fileName, mediaType, caption } = {}) {
    const cfg = this.accountConfig(account);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
    form.append('file', blob, fileName || 'dosya');
    const upload = await this.http(account, `${cfg.phoneNumberId}/media`, { method: 'POST', body: form });
    const mediaId = upload?.id;
    if (!mediaId) {
      const error = new Error('Cloud API medya yüklemesi kimlik döndürmedi');
      error.statusCode = 502;
      throw error;
    }
    const type = mediaType === 'image' || mediaType === 'video' || mediaType === 'audio' ? mediaType : 'document';
    const mediaObject = { id: mediaId };
    if (caption && (type === 'image' || type === 'video' || type === 'document')) mediaObject.caption = caption;
    if (type === 'document' && fileName) mediaObject.filename = fileName;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.recipient(conversation),
      type,
      [type]: mediaObject
    };
    const result = await this.http(account, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: payload });
    return {
      providerMessageId: this.requireProviderMessageId(result, 'medya gönderimi'),
      status: 'sent',
      sentAt: new Date().toISOString(),
      accountId: account.id,
      conversationId: conversation.id
    };
  }

  async fetchProfilePicture() {
    return null;
  }

  recipient(conversation) {
    return normalizePhone(conversation.customerPhone) || conversation.customerPhone;
  }

  async handleWebhook(payload) {
    if (!payload || !Array.isArray(payload.entry)) return { processed: 0 };
    let processed = 0;
    for (const entry of payload.entry) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!this.findAccount(phoneNumberId)) continue;
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const nameByWaId = new Map(contacts.map((c) => [c?.wa_id, c?.profile?.name]));
        for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
          const account = this.resolveAccountForInbound(message?.from, phoneNumberId);
          if (account && await this.persistIncoming(account, message, nameByWaId.get(message.from))) processed += 1;
        }
        const statusAccount = this.findAccount(phoneNumberId);
        for (const status of (Array.isArray(value.statuses) ? value.statuses : [])) {
          if (statusAccount && this.applyStatus(statusAccount, status)) processed += 1;
        }
      }
    }
    return { processed };
  }

  activeCloudAccounts() {
    return this.store.all('whatsappAccounts').filter((a) => (
      a.provider === 'cloudapi' && a.active !== false && a.status !== 'deleted'
    ));
  }

  accountMatchesPhoneNumberId(account, phoneNumberId) {
    if (!phoneNumberId) return true;
    const panelId = this.resolvedPhoneNumberId();
    const accountId = account.cloudPhoneNumberId || panelId;
    return String(accountId) === String(phoneNumberId);
  }

  findAccount(phoneNumberId) {
    if (!phoneNumberId) return null;
    const accounts = this.activeCloudAccounts().filter((a) => this.accountMatchesPhoneNumberId(a, phoneNumberId));
    if (!accounts.length) return null;
    return accounts.find((a) => a.status === 'connected') || accounts[0];
  }

  resolveAccountForInbound(customerPhone, phoneNumberId) {
    const phone = normalizePhone(customerPhone) || customerPhone;
    const scopedAccounts = this.activeCloudAccounts().filter((a) => this.accountMatchesPhoneNumberId(a, phoneNumberId));

    const matches = this.store.all('conversations').filter((item) => (
      normalizePhone(item.customerPhone) === phone
      && scopedAccounts.some((account) => account.id === item.accountId)
    ));
    if (matches.length) {
      const latest = matches.slice().sort((a, b) => String(b.lastMessageAt || b.updatedAt || 0)
        .localeCompare(String(a.lastMessageAt || a.updatedAt || 0)))[0];
      const account = this.store.find('whatsappAccounts', latest.accountId);
      if (account && account.active !== false && account.status !== 'deleted') return account;
    }

    const connected = scopedAccounts.filter((a) => a.status === 'connected');
    const pool = connected.length ? connected : scopedAccounts;
    const ranked = pool.slice().sort((a, b) => {
      const convA = this.store.all('conversations').filter((c) => c.accountId === a.id).length;
      const convB = this.store.all('conversations').filter((c) => c.accountId === b.id).length;
      if (convA !== convB) return convA - convB;
      const userA = this.store.find('users', a.userId);
      const userB = this.store.find('users', b.userId);
      const clickA = Date.parse(userA?.lastPanelClickAt || 0) || 0;
      const clickB = Date.parse(userB?.lastPanelClickAt || 0) || 0;
      return clickB - clickA;
    });
    return ranked[0] || this.findAccount(phoneNumberId);
  }

  mediaTypeFromCloud(type) {
    if (type === 'image' || type === 'sticker') return 'image';
    if (type === 'video') return 'video';
    if (type === 'audio') return 'audio';
    if (type === 'document') return 'document';
    return null;
  }

  extFromMime(mime, fallback = 'bin') {
    if (!mime) return fallback;
    const sub = String(mime).split(';')[0].split('/')[1] || fallback;
    const map = { jpeg: 'jpg', 'svg+xml': 'svg', plain: 'txt', mpeg: 'mp3', quicktime: 'mov', webp: 'webp' };
    return map[sub] || sub.replace(/[^a-z0-9]+/gi, '') || fallback;
  }

  async downloadIncomingMedia(account, message) {
    const type = message?.type;
    const mediaType = this.mediaTypeFromCloud(type);
    if (!mediaType) return null;
    const mediaObject = message[type];
    const mediaId = mediaObject?.id;
    if (!mediaId) return null;

    const meta = await this.http(account, mediaId);
    const mediaUrl = meta?.url;
    if (!mediaUrl) return null;

    const res = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${this.accountConfig(account).accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = mediaObject?.mime_type || meta?.mime_type || res.headers.get('content-type') || 'application/octet-stream';
    const fileName = mediaObject?.filename || null;
    const dir = path.join(this.mediaDir, account.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${message.id}.${this.extFromMime(mimeType, mediaType === 'image' ? 'jpg' : 'bin')}`;
    fs.writeFileSync(path.join(dir, storedName), buffer);
    return {
      mediaType,
      mediaFile: path.posix.join(account.id, storedName),
      mimeType,
      fileName: fileName || storedName,
      mediaSize: buffer.length
    };
  }

  cloudTypeFromMediaType(mediaType) {
    if (mediaType === 'image') return 'image';
    if (mediaType === 'video') return 'video';
    if (mediaType === 'audio') return 'audio';
    return 'document';
  }

  async retryPendingMedia(message) {
    const account = this.store.find('whatsappAccounts', message.accountId);
    if (!account || account.active === false || account.status === 'deleted') return false;
    const cloudMediaId = message.metadata?.cloudMediaId;
    if (!cloudMediaId || !message.mediaType) return false;
    const cloudType = this.cloudTypeFromMediaType(message.mediaType);
    const synthetic = {
      id: message.providerMessageId || message.id,
      type: cloudType,
      [cloudType]: {
        id: cloudMediaId,
        mime_type: message.mimeType || undefined,
        filename: message.fileName || undefined
      }
    };
    const mediaFields = await this.downloadIncomingMedia(account, synthetic);
    if (!mediaFields?.mediaFile) return false;
    const caption = message.text && !String(message.text).includes('indiriliyor') ? message.text : '';
    this.store.update('messages', message.id, {
      ...mediaFields,
      text: caption || this.extractText(synthetic),
      status: 'received',
      mediaPending: false,
      metadata: {
        ...(message.metadata && typeof message.metadata === 'object' ? message.metadata : {}),
        mediaRetryCount: Number(message.metadata?.mediaRetryCount) || 0,
        mediaRecoveredAt: new Date().toISOString()
      }
    });
    this.eventHub.emit('message.created', {
      accountId: account.id,
      conversationId: message.conversationId,
      departmentId: account.departmentId
    });
    return true;
  }

  pendingMediaLabel(mediaType) {
    return {
      image: '[Fotoğraf — indiriliyor]',
      video: '[Video — indiriliyor]',
      audio: '[Ses — indiriliyor]',
      document: '[Dosya — indiriliyor]'
    }[mediaType] || '[Medya — indiriliyor]';
  }

  async persistIncoming(account, message, profileName) {
    const providerMessageId = message?.id;
    const from = message?.from;
    if (!providerMessageId || !from) return false;

    const existing = this.store.findMessageByProviderId(account.id, providerMessageId)
      || this.store.all('messages').findLast((m) => (
        m.accountId === account.id && m.providerMessageId === providerMessageId
      ));
    if (existing) return false;

    const claimed = await claimWebhookEvent(this.redis, this.store, providerMessageId);
    if (!claimed) return false;

    const customerPhone = normalizePhone(from) || from;
    let text = this.extractText(message);
    let mediaFields = {};
    let mediaPending = false;
    const cloudMediaType = this.mediaTypeFromCloud(message?.type);
    if (cloudMediaType) {
      try {
        mediaFields = await this.downloadIncomingMedia(account, message) || {};
      } catch {
        mediaFields = {};
      }
      if (!mediaFields.mediaFile) {
        mediaPending = true;
        text = text || this.pendingMediaLabel(cloudMediaType);
        const cloudMediaId = message[message.type]?.id || null;
        mediaFields = {
          mediaType: cloudMediaType,
          mediaPending: true,
          mimeType: message[message.type]?.mime_type || null
        };
        if (cloudMediaId) {
          mediaFields.metadata = { cloudMediaId, mediaRetryCount: 0 };
        }
      }
    }
    if (!text && !mediaFields.mediaType) return false;

    const conversation = this.getOrCreateConversation(account, customerPhone, profileName);
    const timestampSeconds = Number(message.timestamp || Math.floor(Date.now() / 1000));
    const createdAt = new Date(timestampSeconds * 1000).toISOString();

    const { metadata: pendingMeta, ...restMediaFields } = mediaFields;
    this.store.create('messages', {
      conversationId: conversation.id,
      accountId: account.id,
      userId: account.userId,
      departmentId: account.departmentId,
      senderUserId: null,
      direction: 'in',
      text,
      templateId: null,
      providerMessageId,
      status: mediaPending ? 'media_pending' : 'received',
      hidden: false,
      metadata: pendingMeta,
      ...restMediaFields,
      createdAt,
      updatedAt: createdAt
    });

    const current = this.store.find('conversations', conversation.id);
    const changes = {
      lastInboundAt: createdAt,
      unreadCount: (Number(current?.unreadCount) || 0) + 1
    };
    if (!current?.lastMessageAt || String(createdAt) > String(current.lastMessageAt)) {
      changes.lastMessageAt = createdAt;
    }
    this.store.update('conversations', conversation.id, changes);
    this.eventHub.emit('message.created', {
      accountId: account.id,
      conversationId: conversation.id,
      departmentId: account.departmentId
    });
    return true;
  }

  extractText(message) {
    const type = message?.type;
    if (type === 'text') return message.text?.body || '';
    if (type === 'button') return message.button?.text || '';
    if (type === 'interactive') {
      const i = message.interactive;
      return i?.button_reply?.title || i?.list_reply?.title || '[Etkileşim]';
    }
    if (type === 'image') return message.image?.caption || '[Fotoğraf]';
    if (type === 'video') return message.video?.caption || '[Video]';
    if (type === 'audio') return '[Ses]';
    if (type === 'document') return message.document?.caption || (message.document?.filename ? `[Dosya: ${message.document.filename}]` : '[Dosya]');
    if (type === 'sticker') return '[Çıkartma]';
    if (type === 'location') return '[Konum]';
    if (type === 'contacts') return '[Kişi]';
    return message?.text?.body || '';
  }

  applyStatus(account, status) {
    const providerMessageId = status?.id;
    const nextStatus = this.mapStatus(status?.status);
    if (!providerMessageId || !nextStatus) return false;
    const message = this.store.findMessageByProviderId(account.id, providerMessageId)
      || this.store.all('messages').findLast((m) => (
        m.providerMessageId === providerMessageId && m.accountId === account.id && m.direction === 'out'
      ));
    if (!message) return false;
    if (this.statusRank(nextStatus) <= this.statusRank(message.status)) return false;
    this.store.update('messages', message.id, { status: nextStatus });
    this.eventHub.emit('message.created', {
      accountId: account.id,
      conversationId: message.conversationId,
      departmentId: account.departmentId
    });
    return true;
  }

  getOrCreateConversation(account, customerPhone, customerName = '') {
    const conversations = this.store.all('conversations');
    const existing = conversations.find((item) => (
      item.accountId === account.id && normalizePhone(item.customerPhone) === customerPhone
    ));
    if (existing) {
      if (customerName && !existing.customerName) {
        return this.store.update('conversations', existing.id, { customerName: String(customerName).trim() });
      }
      return existing;
    }
    const now = new Date().toISOString();
    return this.store.create('conversations', {
      accountId: account.id,
      userId: account.userId,
      departmentId: account.departmentId,
      customerPhone,
      customerName: String(customerName || customerPhone).trim(),
      status: 'open',
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      lastInboundAt: null
    });
  }
}

module.exports = { CloudApiProvider };