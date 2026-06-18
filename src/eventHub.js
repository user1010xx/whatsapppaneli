const { roles } = require('./rbac');

class EventHub {
  constructor() {
    this.clients = new Set();
    this._heartbeat = setInterval(() => this.emit('heartbeat', {}), 25000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  connect(response, user) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write('\n');
    const client = {
      response,
      userId: user.id,
      departmentId: user.departmentId,
      role: user.role
    };
    this.clients.add(client);
    response.on('close', () => this.clients.delete(client));
    return client;
  }

  close() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    for (const client of this.clients) {
      try { client.response.end(); } catch {}
    }
    this.clients.clear();
  }

  shouldNotify(client, payload = {}) {
    if (client.role === roles.admin) return true;
    if (!payload.departmentId) return true;
    return client.departmentId === payload.departmentId;
  }

  emit(type, payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify({
      type,
      at: new Date().toISOString(),
      ...payload
    })}\n\n`;
    for (const client of this.clients) {
      if (!this.shouldNotify(client, payload)) continue;
      if (!client.response.destroyed && client.response.writable) {
        try {
          client.response.write(message);
        } catch {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    }
  }
}

module.exports = { EventHub };