class EventHub {
  constructor() {
    this.clients = new Set();
  }

  connect(response, userId) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write('\n');
    const client = { response, userId };
    this.clients.add(client);
    response.on('close', () => this.clients.delete(client));
    return client;
  }

  // Yalnızca opak sinyal yayımla; veri içeriği istemci tarafından yetkili API
  // uçlarından yeniden çekilir. Bu sayede farklı departmandaki kullanıcılar
  // SSE kanalı üzerinden başkasının mesaj içeriğini göremez.
  emit(type, _payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString() })}\n\n`;
    for (const client of this.clients) {
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
