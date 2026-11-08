'use strict';
/** Inbox, Web Push subscriptions and the live event stream. */
const { id, text } = require('../../lib/validate');
const { badRequest } = require('../../http/errors');

function register(router, { db, bus, push, notifier }) {
  router.get('/api/notifications', (ctx) => {
    const limit = Math.min(100, Number(ctx.query.get('limit')) || 50);
    return {
      notifications: db.all('SELECT id, kind, title, body, link, read, created FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', ctx.user.id, limit)
        .map((n) => ({ ...n, read: !!n.read })),
      unread: notifier.unread(ctx.user.id),
    };
  });

  router.post('/api/notifications/read', async (ctx) => {
    const b = await ctx.json();
    if (b.all) db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', ctx.user.id);
    else for (const n of (Array.isArray(b.ids) ? b.ids : []).slice(0, 200)) db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', id(n), ctx.user.id);
    return { unread: notifier.unread(ctx.user.id) };
  });

  router.delete('/api/notifications/:id', (ctx) => {
    db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', id(ctx.params.id), ctx.user.id);
    return { unread: notifier.unread(ctx.user.id) };
  });

  router.delete('/api/notifications', (ctx) => {
    db.run('DELETE FROM notifications WHERE user_id = ? AND read = 1', ctx.user.id);
    return { unread: notifier.unread(ctx.user.id) };
  });

  // --- Web Push ---

  router.get('/api/push', (ctx) => ({
    publicKey: push.publicKey,
    devices: db.get('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', ctx.user.id).n,
  }));

  router.post('/api/push/subscribe', async (ctx) => {
    const b = await ctx.json();
    const endpoint = text(b.endpoint, { min: 10, max: 800, label: 'Endpoint' });
    const p256dh = text(b.keys?.p256dh, { min: 40, max: 200, label: 'Key' });
    const auth = text(b.keys?.auth, { min: 8, max: 64, label: 'Auth secret' });
    if (!push.isAllowedEndpoint(endpoint)) throw badRequest('This browser’s push service is not supported');
    db.run(
      `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent, created) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      ctx.user.id, endpoint, p256dh, auth, String(ctx.req.headers['user-agent'] || '').slice(0, 200), new Date().toISOString(),
    );
    ctx.status = 201;
    return { ok: true };
  });

  router.post('/api/push/unsubscribe', async (ctx) => {
    const b = await ctx.json();
    db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', ctx.user.id, String(b.endpoint || ''));
    return { ok: true };
  });

  router.post('/api/push/test', (ctx) => {
    notifier.notify(ctx.user.id, { kind: 'system', title: 'Notifications are working', body: 'You’ll get updates like this one.', link: '/inbox', urgent: true });
    return { ok: true };
  });

  // --- Live updates (Server-Sent Events) ---

  router.get('/api/events', (ctx) => {
    bus.connect(ctx.req, ctx.res, ctx.user);
  });
}

module.exports = { register };
