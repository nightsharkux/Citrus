'use strict';
/** Schedule API, ICS import and a private calendar subscription feed. */
const { oneOf, id, optionalId, isoDate } = require('../../lib/validate');
const { KINDS } = require('./service');
const { badRequest, forbidden, notFound } = require('../../http/errors');
const { parseIcs, toIcs } = require('../../lib/ics');
const { randomToken, sha256 } = require('../../lib/crypto');
const { DAY } = require('../../lib/time');

const SCOPES = ['personal', 'course', 'institution'];

function register(router, { db, config, access, timetable, notifier, audit }) {
  const isoNow = () => new Date().toISOString();

  /** Validate scope permissions and return { courseId, ownerId }. */
  function ownership(user, scope, courseIdInput) {
    if (scope === 'personal') return { courseId: null, ownerId: user.id };
    if (scope === 'institution') {
      if (user.role !== 'admin') throw forbidden('Only administrators can add university-wide events');
      return { courseId: null, ownerId: null };
    }
    const courseId = id(courseIdInput, 'Course');
    if (!access.teachingCourse(user, courseId)) throw forbidden('Only the course lecturer can add course events');
    return { courseId, ownerId: null };
  }

  router.get('/api/timetable', (ctx) => {
    const from = ctx.query.get('from') ? isoDate(ctx.query.get('from'), 'From') : new Date(Date.now() - DAY).toISOString();
    const to = ctx.query.get('to') ? isoDate(ctx.query.get('to'), 'To') : new Date(Date.now() + 14 * DAY).toISOString();
    if (new Date(to) - new Date(from) > 120 * DAY) throw badRequest('Choose a range of at most 120 days');
    const courseId = optionalId(ctx.query.get('course_id'), 'Course');
    if (courseId && !access.course(ctx.user, courseId)) throw forbidden('No access to this course');
    const feed = db.get('SELECT created FROM calendar_feeds WHERE user_id = ?', ctx.user.id);
    return { timeZone: config.site.timezone, events: timetable.between(ctx.user, from, to, { courseId }), feed: feed ? { created: feed.created } : null };
  });

  router.post('/api/timetable', async (ctx) => {
    const b = await ctx.json();
    const scope = oneOf(b.scope || 'personal', SCOPES, 'Scope');
    const { courseId, ownerId } = ownership(ctx.user, scope, b.course_id);
    const e = timetable.readEvent(b);
    const eventId = timetable.insert(ctx.user, { courseId, ownerId }, e);
    if (courseId) {
      const course = db.get('SELECT code FROM courses WHERE id = ?', courseId);
      const students = db.all('SELECT user_id FROM enrollments WHERE course_id = ?', courseId).map((r) => r.user_id);
      const when = new Intl.DateTimeFormat('en-GB', { timeZone: config.site.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(e.starts));
      notifier.notify(students, { kind: 'course', title: `${course.code}: ${e.kind === 'exam' ? 'exam scheduled' : 'schedule updated'}`, body: `${e.title} · ${when}${e.location ? ` · ${e.location}` : ''}`, link: '/schedule' });
    }
    ctx.status = 201;
    return { id: eventId };
  });

  function editable(user, eventId) {
    const e = db.get('SELECT * FROM timetable_events WHERE id = ? AND institution_id = ?', id(eventId), user.institution_id);
    if (!e) throw notFound('Event not found');
    if (!timetable.canEdit(user, e)) throw forbidden('You cannot change this event');
    return e;
  }

  router.patch('/api/timetable/:id', async (ctx) => {
    const existing = editable(ctx.user, ctx.params.id);
    const e = timetable.readEvent({ ...existing, repeat_weeks: existing.repeat_weeks, ...(await ctx.json()) });
    db.run(
      'UPDATE timetable_events SET title = ?, kind = ?, location = ?, notes = ?, starts = ?, ends = ?, repeat_weeks = ?, until = ? WHERE id = ?',
      e.title, e.kind, e.location, e.notes, e.starts, e.ends, e.repeatWeeks, e.until, existing.id,
    );
    return { ok: true };
  });

  router.delete('/api/timetable/:id', (ctx) => {
    const e = editable(ctx.user, ctx.params.id);
    db.run('DELETE FROM timetable_events WHERE id = ?', e.id);
    return { ok: true };
  });

  router.post('/api/timetable/import', async (ctx) => {
    const b = await ctx.json(1_000_000);
    const scope = oneOf(b.scope || 'personal', SCOPES, 'Scope');
    const { courseId, ownerId } = ownership(ctx.user, scope, b.course_id);
    const ics = String(b.ics || '');
    if (!ics.includes('BEGIN:VCALENDAR')) throw badRequest('This does not look like an .ics calendar file');
    const events = parseIcs(ics, { timeZone: config.site.timezone }).slice(0, 2000);
    let imported = 0;
    let updated = 0;
    db.transaction(() => {
      for (const e of events) {
        const until = e.until || (e.count && e.repeatWeeks ? new Date(new Date(e.starts).getTime() + (e.count - 1) * e.repeatWeeks * 7 * DAY + DAY).toISOString() : null);
        const existing = e.uid && db.get(
          'SELECT id FROM timetable_events WHERE institution_id = ? AND external_uid = ? AND COALESCE(course_id, 0) = ? AND COALESCE(owner_id, 0) = ?',
          ctx.user.institution_id, e.uid, courseId || 0, ownerId || 0,
        );
        const values = [e.title.slice(0, 120), e.location.slice(0, 120), e.notes.slice(0, 1000), e.starts, e.ends, e.repeatWeeks, until];
        if (existing) {
          db.run('UPDATE timetable_events SET title = ?, location = ?, notes = ?, starts = ?, ends = ?, repeat_weeks = ?, until = ? WHERE id = ?', ...values, existing.id);
          updated += 1;
        } else {
          db.run(
            `INSERT INTO timetable_events(institution_id, course_id, owner_id, title, location, notes, starts, ends, repeat_weeks, until, kind, source, external_uid, created_by, created)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ics', ?, ?, ?)`,
            ctx.user.institution_id, courseId, ownerId, ...values, scope === 'personal' ? 'personal' : 'lecture', e.uid, ctx.user.id, isoNow(),
          );
          imported += 1;
        }
      }
    });
    audit(ctx.user, 'timetable_imported', `${imported} new, ${updated} updated (${scope})`);
    return { imported, updated, skipped: events.length - imported - updated };
  });

  // --- Calendar subscription feed (token in URL, stored hashed) ---

  router.post('/api/timetable/feed', (ctx) => {
    const token = randomToken(24);
    db.run(
      'INSERT INTO calendar_feeds(user_id, token_hash, created) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created = excluded.created',
      ctx.user.id, sha256(token), isoNow(),
    );
    return { url: `${ctx.baseUrl}/calendar/${token}.ics` };
  });

  router.delete('/api/timetable/feed', (ctx) => {
    db.run('DELETE FROM calendar_feeds WHERE user_id = ?', ctx.user.id);
    return { ok: true };
  });

  router.get('/calendar/:token', (ctx) => {
    const token = String(ctx.params.token || '').replace(/\.ics$/, '');
    const feed = token && db.get('SELECT user_id FROM calendar_feeds WHERE token_hash = ?', sha256(token));
    if (!feed) throw notFound('Calendar not found');
    const user = db.get('SELECT * FROM users WHERE id = ? AND deleted = 0', feed.user_id);
    if (!user) throw notFound('Calendar not found');
    const events = timetable.between(user, new Date(Date.now() - 30 * DAY).toISOString(), new Date(Date.now() + 119 * DAY).toISOString());
    ctx.res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(toIcs(events, { name: `${config.site.shortName} schedule`, host: new URL(config.publicUrl).host }));
  }, { auth: 'public' });
}

module.exports = { register, KINDS };
