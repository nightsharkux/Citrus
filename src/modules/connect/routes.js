'use strict';
/**
 * Campus feed: announcements, events, jobs, housing, research calls and
 * community posts. Student posts are moderated; official claims are only
 * marked verified after an administrator approves them.
 */
const { text, oneOf, id, isoDate, httpUrl } = require('../../lib/validate');
const { badRequest, forbidden, notFound } = require('../../http/errors');
const { INTEREST_TAGS } = require('../account/routes');
const matching = require('./matching');

const CATEGORIES = ['announcement', 'event', 'job', 'housing', 'research', 'community', 'product'];
const LEVELS = ['all', 'personalized', 'essential', 'digest'];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function register(router, { db, notifier, audit }) {
  const isoNow = () => new Date().toISOString();

  function prefs(user) {
    let p = db.get('SELECT * FROM cx_preferences WHERE user_id = ?', user.id);
    if (!p) {
      db.run('INSERT OR IGNORE INTO cx_preferences(user_id, updated) VALUES(?, ?)', user.id, isoNow());
      p = db.get('SELECT * FROM cx_preferences WHERE user_id = ?', user.id);
    }
    return { level: p.level, topics: JSON.parse(p.topics), quiet_start: p.quiet_start, quiet_end: p.quiet_end };
  }

  function savePrefs(user, { level, topics, quiet_start: qs, quiet_end: qe }) {
    db.run('UPDATE cx_preferences SET level = ?, topics = ?, quiet_start = ?, quiet_end = ?, updated = ? WHERE user_id = ?', level, JSON.stringify([...new Set(topics)]), qs, qe, isoNow(), user.id);
    return prefs(user);
  }

  const careerTop = (userId) => {
    const row = db.get('SELECT answers FROM career_interests WHERE user_id = ?', userId);
    if (!row) return [];
    const { questions } = require('../careers/questions');
    const counts = {};
    JSON.parse(row.answers).forEach((choice, i) => {
      const key = questions[i]?.[2]?.[choice];
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  };

  /** After a post is published: tell the author, broadcast important posts, and ping matched users. */
  function announce(post, { publishedBy }) {
    if (post.author_id !== publishedBy) {
      notifier.notify(post.author_id, { kind: 'system', title: 'Your post is live', body: post.title, link: '/campus' });
    }
    const users = db.all('SELECT id, preferences FROM users WHERE institution_id = ? AND deleted = 0 AND id != ?', post.institution_id, post.author_id);
    const important = post.priority >= 3 || (post.official && post.verified);
    for (const u of users) {
      const optedIn = JSON.parse(u.preferences || '{}').matching !== false;
      if (important) {
        notifier.notify(u.id, { kind: 'campus', category: post.category, priority: post.priority, title: post.title, body: post.body.slice(0, 140), link: '/campus' });
      } else if (optedIn && ['job', 'research', 'event'].includes(post.category)) {
        const m = matching.score(post, matching.interestsFor(db, u.id, careerTop(u.id)));
        if (m.score >= 3) notifier.notify(u.id, { kind: 'campus', category: post.category, priority: post.priority, title: `Matches your interests: ${post.title}`, body: `Because you’re into ${m.reasons.join(', ')}.`, link: '/campus?filter=for-you' });
      }
    }
  }

  router.get('/api/connect/posts', (ctx) => {
    const u = ctx.user;
    const p = prefs(u);
    const interests = matching.interestsFor(db, u.id, careerTop(u.id));
    const matchingOn = u.preferences?.matching !== false;
    const posts = db.all(
      `SELECT p.id, p.title, p.body, p.category, p.priority, p.official, p.verified, p.status, p.created, p.author_id,
              p.tags, p.event_start, p.location, p.link, x.name AS author,
              (SELECT COUNT(*) FROM cx_rsvps r WHERE r.post_id = p.id) AS going,
              EXISTS(SELECT 1 FROM cx_rsvps r WHERE r.post_id = p.id AND r.user_id = ?) AS attending
       FROM cx_posts p JOIN users x ON x.id = p.author_id
       WHERE p.institution_id = ? AND p.status != 'removed' AND (p.status = 'published' OR p.author_id = ? OR ? = 'admin')
       ORDER BY p.created DESC LIMIT 160`,
      u.id, u.institution_id, u.id, u.role,
    );
    return {
      posts: posts.map((z) => {
        const m = matchingOn ? matching.score(z, interests) : { score: 0, reasons: [] };
        return {
          ...z,
          official: !!z.official,
          verified: z.verified,
          attending: !!z.attending,
          mine: z.author_id === u.id,
          tags: String(z.tags || '').split(',').filter(Boolean),
          match: m.score >= 2 ? m.reasons : [],
          visible: (p.level === 'all' || p.topics.includes(z.category)) && (p.level !== 'essential' || z.priority >= 4),
        };
      }),
      preferences: p,
      categories: CATEGORIES,
      interestTags: INTEREST_TAGS,
    };
  });

  router.post('/api/connect/posts', async (ctx) => {
    const u = ctx.user;
    const b = await ctx.json();
    const title = text(b.title, { min: 4, max: 120, label: 'Title' });
    const body = text(b.body, { min: 8, max: 2500, label: 'Details' });
    const category = oneOf(b.category, CATEGORIES, 'Category');
    const priority = Number(b.priority || 2);
    if (![1, 2, 3, 4].includes(priority)) throw badRequest('Priority must be between 1 and 4');
    const official = b.official === true || b.official === 'true';
    const tags = (Array.isArray(b.tags) ? b.tags : []).filter((t) => INTEREST_TAGS.includes(t)).slice(0, 5).join(',');
    const eventStart = category === 'event' && b.event_start ? isoDate(b.event_start, 'Event start') : null;
    const location = text(b.location, { max: 120, optional: true });
    const link = httpUrl(b.link);

    const trusted = u.role === 'admin' || u.can_publish;
    const status = trusted ? 'published' : 'pending';
    const verified = u.role === 'admin' && official ? 1 : 0;
    const postId = db.insert(
      `INSERT INTO cx_posts(institution_id, author_id, title, body, category, priority, official, verified, status, created, tags, event_start, location, link)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.institution_id, u.id, title, body, category, u.role === 'admin' ? priority : Math.min(priority, trusted ? 3 : 2), official ? 1 : 0, verified, status, isoNow(), tags, eventStart, location, link,
    );
    if (status === 'published') announce(db.get('SELECT * FROM cx_posts WHERE id = ?', postId), { publishedBy: u.id });
    else {
      const admins = db.all("SELECT id FROM users WHERE institution_id = ? AND role = 'admin' AND deleted = 0", u.institution_id).map((a) => a.id);
      notifier.notify(admins, { kind: 'system', title: 'Post waiting for review', body: title, link: '/admin/moderation' });
    }
    ctx.status = 201;
    return { id: postId, status, note: trusted ? 'Published.' : 'Sent for review. It appears once an administrator approves it.' };
  });

  router.delete('/api/connect/posts/:id', (ctx) => {
    const post = db.get('SELECT * FROM cx_posts WHERE id = ? AND institution_id = ?', id(ctx.params.id), ctx.user.institution_id);
    if (!post) throw notFound('Post not found');
    if (post.author_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden('Only the author or an administrator can remove this post');
    db.run("UPDATE cx_posts SET status = 'removed' WHERE id = ?", post.id);
    if (ctx.user.role === 'admin' && post.author_id !== ctx.user.id) audit(ctx.user, 'post_removed', post.id);
    return { ok: true };
  });

  router.post('/api/connect/posts/:id/rsvp', async (ctx) => {
    const post = db.get("SELECT id FROM cx_posts WHERE id = ? AND institution_id = ? AND status = 'published' AND category = 'event'", id(ctx.params.id), ctx.user.institution_id);
    if (!post) throw notFound('Event not found');
    const b = await ctx.json();
    if (b.going === false) db.run('DELETE FROM cx_rsvps WHERE post_id = ? AND user_id = ?', post.id, ctx.user.id);
    else db.run('INSERT OR IGNORE INTO cx_rsvps(post_id, user_id, created) VALUES(?, ?, ?)', post.id, ctx.user.id, isoNow());
    return { going: db.get('SELECT COUNT(*) n FROM cx_rsvps WHERE post_id = ?', post.id).n, attending: b.going !== false };
  });

  router.post('/api/connect/posts/:id/report', async (ctx) => {
    const post = db.get("SELECT id FROM cx_posts WHERE id = ? AND institution_id = ? AND status = 'published'", id(ctx.params.id), ctx.user.institution_id);
    if (!post) throw notFound('Post not found');
    const b = await ctx.json();
    const reason = text(b.reason, { min: 4, max: 600, label: 'Reason' });
    db.run('INSERT OR REPLACE INTO cx_reports(post_id, reporter_id, reason, created) VALUES(?, ?, ?, ?)', post.id, ctx.user.id, reason, isoNow());
    return { ok: true };
  });

  // --- Moderation ---

  router.get('/api/connect/moderation', (ctx) => ({
    pending: db.all("SELECT p.*, u.name AS author FROM cx_posts p JOIN users u ON u.id = p.author_id WHERE p.institution_id = ? AND p.status = 'pending' ORDER BY p.id DESC", ctx.user.institution_id)
      .map((p) => ({ ...p, official: !!p.official, tags: String(p.tags || '').split(',').filter(Boolean) })),
    reports: db.all(
      "SELECT r.id, r.reason, r.created, p.title, p.id AS post_id, p.status FROM cx_reports r JOIN cx_posts p ON p.id = r.post_id WHERE p.institution_id = ? AND p.status = 'published' ORDER BY r.id DESC LIMIT 80",
      ctx.user.institution_id,
    ),
  }), { roles: ['admin'] });

  router.post('/api/connect/moderation', async (ctx) => {
    const b = await ctx.json();
    const post = db.get('SELECT * FROM cx_posts WHERE id = ? AND institution_id = ?', id(b.id), ctx.user.institution_id);
    if (!post) throw notFound('Post not found');
    const action = oneOf(b.action, ['publish', 'reject', 'dismiss_reports', 'remove'], 'Action');
    if (action === 'publish') {
      db.run("UPDATE cx_posts SET status = 'published', verified = ? WHERE id = ?", post.official ? 1 : 0, post.id);
      announce(db.get('SELECT * FROM cx_posts WHERE id = ?', post.id), { publishedBy: ctx.user.id });
    } else if (action === 'reject') {
      db.run("UPDATE cx_posts SET status = 'rejected' WHERE id = ?", post.id);
      notifier.notify(post.author_id, { kind: 'system', title: 'Your post was not approved', body: post.title, link: '/campus' });
    } else if (action === 'remove') {
      db.run("UPDATE cx_posts SET status = 'removed' WHERE id = ?", post.id);
    } else {
      db.run('DELETE FROM cx_reports WHERE post_id = ?', post.id);
    }
    audit(ctx.user, `post_${action}`, post.id);
    return { ok: true };
  }, { roles: ['admin'] });

  // --- Notification preferences ---

  router.get('/api/connect/preferences', (ctx) => ({ preferences: prefs(ctx.user), categories: CATEGORIES, levels: LEVELS }));

  router.patch('/api/connect/preferences', async (ctx) => {
    const b = await ctx.json();
    const old = prefs(ctx.user);
    const next = {
      level: oneOf(b.level ?? old.level, LEVELS, 'Level'),
      topics: b.topics === undefined ? old.topics : b.topics,
      quiet_start: String(b.quiet_start ?? old.quiet_start),
      quiet_end: String(b.quiet_end ?? old.quiet_end),
    };
    if (!Array.isArray(next.topics) || next.topics.some((t) => !CATEGORIES.includes(t))) throw badRequest('Unknown topic');
    if (!TIME.test(next.quiet_start) || !TIME.test(next.quiet_end)) throw badRequest('Quiet hours must look like 22:00');
    return { preferences: savePrefs(ctx.user, next) };
  });

  /** Plain-language settings, e.g. "mute events" or "essential notifications only". */
  router.post('/api/connect/command', async (ctx) => {
    const b = await ctx.json();
    const input = String(b.text || '').toLowerCase().slice(0, 500);
    const old = prefs(ctx.user);
    let level = old.level;
    let topics = [...old.topics];
    let reply = '';

    if (/(essential|critical|urgent)(?:\s+(?:alerts|notifications|only))?\s+only|only\s+(?:essential|critical|urgent)/.test(input)) { level = 'essential'; reply = 'You’ll only get essential notifications now.'; }
    else if (/(?:daily|evening|morning)\s+digest|digest\s+only/.test(input)) { level = 'digest'; reply = 'Switched to a daily digest — no individual pushes.'; }
    else if (/(?:all|every)\s+notifications?/.test(input)) { level = 'all'; reply = 'You’ll get every campus notification.'; }
    else if (/(?:personali[sz]ed|recommended)\s+(?:alerts?|notifications?)/.test(input)) { level = 'personalized'; reply = 'Back to notifications for your chosen topics.'; }

    const topicWords = { job: /\b(jobs?|student.assistant|hiring|vacanc)/, event: /\b(events?|stammtisch|party|social)/, housing: /\b(housing|sublet|apartment|flat|room to rent)/, research: /\b(research|thesis|participant)/, community: /\b(community|student.group|club)/, announcement: /\b(announcements?|university news)/ };
    const off = /\b(stop|disable|mute|unsubscribe|turn off|no more)\b/.test(input);
    const on = /\b(enable|follow|notify|subscribe|turn on|send me|tell me)\b/.test(input);
    if (off || on) {
      const found = Object.entries(topicWords).filter(([, re]) => re.test(input)).map(([k]) => k);
      if (found.length) {
        for (const t of found) topics = off ? topics.filter((z) => z !== t) : [...new Set([...topics, t])];
        reply = `${off ? 'Muted' : 'Following'}: ${found.join(', ')}.`;
      }
    }
    if (!reply) return { recognized: false, reply: 'Try “Notify me about student jobs”, “Mute events” or “Essential notifications only”.' };
    return { recognized: true, reply, preferences: savePrefs(ctx.user, { ...old, level, topics }) };
  });
}

module.exports = { register, CATEGORIES };
