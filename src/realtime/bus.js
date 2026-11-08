'use strict';
/**
 * In-process publish/subscribe with a Server-Sent Events endpoint.
 *
 * Channels: `user:<id>`, `institution:<id>`, `course:<id>`, `workspace:<id>`.
 * Each SSE connection authorises channels lazily via `canSee(user, channel)`
 * (cached briefly), so membership changes are picked up without reconnecting.
 *
 * Single-process by design. To scale out, replace `publish` with a Redis or
 * Postgres LISTEN/NOTIFY fan-out; the client API stays the same.
 */
function createBus({ canSee }) {
  const clients = new Set();

  function publish(channel, type, data = {}) {
    const payload = `event: ${type}\ndata: ${JSON.stringify({ channel, ...data })}\n\n`;
    for (const client of clients) {
      if (client.allowed(channel)) client.res.write(payload);
    }
  }

  function connect(req, res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 4000\n\n');

    const cache = new Map();
    const client = {
      res,
      allowed(channel) {
        const hit = cache.get(channel);
        if (hit && Date.now() - hit.at < 30_000) return hit.ok;
        let ok = false;
        try {
          ok = !!canSee(user, channel);
        } catch {
          ok = false;
        }
        cache.set(channel, { ok, at: Date.now() });
        return ok;
      },
    };
    clients.add(client);

    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    ping.unref();
    const close = () => {
      clearInterval(ping);
      clients.delete(client);
    };
    req.on('close', close);
    res.on('error', close);
  }

  return { publish, connect, size: () => clients.size };
}

module.exports = { createBus };
