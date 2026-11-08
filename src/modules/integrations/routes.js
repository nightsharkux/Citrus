'use strict';
/** The signed-in user's connected accounts (Moodle) and integration status. */
const { text } = require('../../lib/validate');
const { badRequest, notFound } = require('../../http/errors');

function register(router, { db, moodle, secretBox, audit }) {
  const linked = (userId) => db.get("SELECT secret, meta FROM connector_tokens WHERE user_id = ? AND connector = 'moodle'", userId);

  router.get('/api/integrations', (ctx) => {
    const m = linked(ctx.user.id);
    return {
      moodle: { configured: moodle.configured(), connected: !!m, account: m ? JSON.parse(m.meta) : null },
      calendarFeed: !!db.get('SELECT 1 FROM calendar_feeds WHERE user_id = ?', ctx.user.id),
      pushDevices: db.get('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', ctx.user.id).n,
    };
  });

  router.post('/api/integrations/moodle', async (ctx) => {
    if (!moodle.configured()) throw badRequest('Moodle is not configured for your university yet');
    const b = await ctx.json();
    const token = text(b.token, { min: 16, max: 128, label: 'Moodle token' }).replace(/\s/g, '');
    let account;
    try {
      account = await moodle.verify(token);
    } catch (error) {
      throw badRequest(`Moodle did not accept this token: ${error.message}`);
    }
    db.run(
      `INSERT INTO connector_tokens(user_id, connector, secret, meta, created) VALUES(?, 'moodle', ?, ?, ?)
       ON CONFLICT(user_id, connector) DO UPDATE SET secret = excluded.secret, meta = excluded.meta, created = excluded.created`,
      ctx.user.id, secretBox.seal(token), JSON.stringify(account), new Date().toISOString(),
    );
    audit(ctx.user, 'moodle_connected', account.userId);
    return { account };
  });

  router.delete('/api/integrations/moodle', (ctx) => {
    db.run("DELETE FROM connector_tokens WHERE user_id = ? AND connector = 'moodle'", ctx.user.id);
    return { ok: true };
  });

  router.get('/api/integrations/moodle/courses', async (ctx) => {
    const m = linked(ctx.user.id);
    if (!m) throw notFound('Connect your Moodle account first');
    const account = JSON.parse(m.meta);
    try {
      return { courses: await moodle.courses(secretBox.open(m.secret), account.userId) };
    } catch (error) {
      throw badRequest(`Could not load Moodle courses: ${error.message}`);
    }
  });
}

module.exports = { register };
