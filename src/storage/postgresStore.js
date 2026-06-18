const { Pool } = require('pg');
const { BaseStore } = require('./baseStore');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS app_backups (
  id SERIAL PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS app_messages_index (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  account_id TEXT,
  department_id TEXT,
  user_id TEXT,
  sender_user_id TEXT,
  direction TEXT NOT NULL,
  status TEXT,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  template_id TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  seen_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  seen_by_user_id TEXT,
  responded_by_user_id TEXT
);
CREATE TABLE IF NOT EXISTS app_conversations_index (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT,
  department_id TEXT,
  customer_phone TEXT,
  last_message_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON app_messages_index(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON app_messages_index(sender_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON app_messages_index(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction_seen ON app_messages_index(direction, seen_by_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON app_conversations_index(user_id);
`;

function parseTimestamp(value) {
  if (!value) return null;
  const stamp = Date.parse(value);
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

function istanbulDayBounds(dayKey) {
  const start = new Date(`${dayKey}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

class PostgresStore extends BaseStore {
  constructor(databaseUrl, options = {}) {
    super(options);
    this.databaseUrl = databaseUrl;
    this.maxBackups = Number(options.maxBackups ?? 20);
    const sslRejectUnauthorized = options.sslRejectUnauthorized === true;
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: options.ssl === false ? false : { rejectUnauthorized: sslRejectUnauthorized },
      max: Number(options.poolMax || 10)
    });
    this.kind = 'postgres';
  }

  async ensureSchema() {
    await this.pool.query(SCHEMA_SQL);
  }

  async loadFromDatabase() {
    const result = await this.pool.query('SELECT data FROM app_state WHERE id = 1');
    return result.rows[0]?.data || null;
  }

  async createBackup() {
    await this.pool.query(
      'INSERT INTO app_backups (data) VALUES ($1::jsonb)',
      [JSON.stringify(this.data)]
    );
    if (this.maxBackups > 0) {
      await this.pool.query(`
        DELETE FROM app_backups
        WHERE id NOT IN (
          SELECT id FROM app_backups ORDER BY created_at DESC LIMIT $1
        )
      `, [this.maxBackups]);
    }
  }

  async syncSearchIndexes() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM app_messages_index');
      await client.query('DELETE FROM app_conversations_index');

      const messages = this.all('messages');
      const chunkSize = 500;
      for (let offset = 0; offset < messages.length; offset += chunkSize) {
        const chunk = messages.slice(offset, offset + chunkSize);
        if (!chunk.length) continue;
        const values = [];
        const placeholders = chunk.map((message, index) => {
          const base = index * 16;
          values.push(
            message.id,
            message.conversationId,
            message.accountId || null,
            message.departmentId || null,
            message.userId || null,
            message.senderUserId || null,
            message.direction,
            message.status || null,
            Boolean(message.hidden),
            message.templateId || null,
            message.providerMessageId || null,
            parseTimestamp(message.createdAt),
            parseTimestamp(message.seenAt),
            parseTimestamp(message.respondedAt),
            message.seenByUserId || null,
            message.respondedByUserId || null
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16})`;
        });
        await client.query(`
          INSERT INTO app_messages_index (
            id, conversation_id, account_id, department_id, user_id, sender_user_id,
            direction, status, hidden, template_id, provider_message_id, created_at,
            seen_at, responded_at, seen_by_user_id, responded_by_user_id
          ) VALUES ${placeholders.join(',')}
        `, values);
      }

      const conversations = this.all('conversations');
      for (let offset = 0; offset < conversations.length; offset += chunkSize) {
        const chunk = conversations.slice(offset, offset + chunkSize);
        if (!chunk.length) continue;
        const values = [];
        const placeholders = chunk.map((conversation, index) => {
          const base = index * 8;
          values.push(
            conversation.id,
            conversation.accountId,
            conversation.userId || null,
            conversation.departmentId || null,
            conversation.customerPhone || null,
            parseTimestamp(conversation.lastMessageAt),
            parseTimestamp(conversation.lastInboundAt),
            Number(conversation.unreadCount) || 0
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
        });
        await client.query(`
          INSERT INTO app_conversations_index (
            id, account_id, user_id, department_id, customer_phone,
            last_message_at, last_inbound_at, unread_count
          ) VALUES ${placeholders.join(',')}
        `, values);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  rowToMessage(row) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      accountId: row.account_id,
      departmentId: row.department_id,
      userId: row.user_id,
      senderUserId: row.sender_user_id,
      direction: row.direction,
      status: row.status,
      hidden: row.hidden,
      templateId: row.template_id,
      providerMessageId: row.provider_message_id,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      seenAt: row.seen_at ? new Date(row.seen_at).toISOString() : null,
      respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
      seenByUserId: row.seen_by_user_id,
      respondedByUserId: row.responded_by_user_id
    };
  }

  async fetchMessagesForAudit(dayKey) {
    const { start, end } = istanbulDayBounds(dayKey);
    const result = await this.pool.query(`
      SELECT * FROM app_messages_index
      WHERE hidden = FALSE
        AND (
          (created_at >= $1 AND created_at < $2)
          OR (seen_at >= $1 AND seen_at < $2)
          OR (responded_at >= $1 AND responded_at < $2)
        )
    `, [start, end]);
    return result.rows.map((row) => this.rowToMessage(row));
  }

  async fetchUnseenIncomingCount(staffUserIds) {
    if (!staffUserIds.length) return 0;
    const result = await this.pool.query(`
      SELECT COUNT(*)::int AS count
      FROM app_messages_index m
      JOIN app_conversations_index c ON c.id = m.conversation_id
      WHERE m.direction = 'in'
        AND m.seen_by_user_id IS NULL
        AND m.hidden = FALSE
        AND c.user_id = ANY($1::text[])
    `, [staffUserIds]);
    return result.rows[0]?.count || 0;
  }

  async init(seed) {
    await this.ensureSchema();
    const loaded = await this.loadFromDatabase();
    if (loaded) {
      this.data = this.mergeDefaults(typeof loaded === 'string' ? JSON.parse(loaded) : loaded);
      if (this.migrateTemplates()) await this.save();
    } else {
      this.data = this.mergeDefaults(this.data);
      await this.seed(seed);
      await this.save();
    }
    if (!this.data.users.some((user) => user.role === 'admin')) {
      await this.seed(seed);
      await this.save();
    }
  }

  async restoreFromLatestBackup() {
    const result = await this.pool.query(
      'SELECT id, data, created_at FROM app_backups ORDER BY created_at DESC LIMIT 1'
    );
    const row = result.rows[0];
    if (!row) {
      const error = new Error('Kurtarılabilir yedek bulunamadı');
      error.statusCode = 404;
      throw error;
    }
    this.data = this.mergeDefaults(row.data);
    await this.save();
    return {
      restoredFrom: `postgres-backup:${row.id}`,
      restoredAt: new Date(row.created_at).toISOString()
    };
  }

  async isHealthy() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }

  async _saveNow() {
    this.pruneAuditLogs();
    const existing = await this.pool.query('SELECT 1 FROM app_state WHERE id = 1');
    if (existing.rowCount > 0) await this.createBackup();
    const payload = JSON.stringify(this.data);
    await this.pool.query(`
      INSERT INTO app_state (id, data, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `, [payload]);
    await this.syncSearchIndexes();
  }
}

module.exports = { PostgresStore, istanbulDayBounds };