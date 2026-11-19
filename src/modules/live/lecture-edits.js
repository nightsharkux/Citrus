'use strict';
/**
 * What a lecturer can do with a lecture besides teaching it: take a break, mark chapters, and tidy the recording.
 *
 *   POST   /api/live/sessions/:id/pause                  a break begins: nothing is heard, students cannot answer
 *   POST   /api/live/sessions/:id/resume                 the break is over; the lecture goes on where it was
 *   GET    /api/live/sessions/:id/chapters               the chapters so far, with where each starts
 *   POST   /api/live/sessions/:id/chapters               { title? }  a new chapter starts now (the lap button)
 *   PATCH  /api/live/sessions/:id/chapters/:cid          { title }   name it, now or after the lecture
 *   DELETE /api/live/sessions/:id/chapters/:cid          merge it into the chapter before it (the mark goes away)
 *   DELETE /api/live/sessions/:id/chapters/:cid/content  forget what was recorded in that chapter, and nothing else
 *   DELETE /api/live/sessions/:id/audio                  forget the audio, keep the transcript
 *
 * Chapters are the lecturer's own sections of the lecture. They replace the automatic sections in the lecture
 * record (record.js) as soon as there is more than one, so notes, the review and the downloads follow them.
 * Everything here is for the lecturer of the course only.
 */
const { text, id } = require('../../lib/validate');
const { conflict, badRequest, notFound } = require('../../http/errors');
const { activeMs } = require('./breaks');

const TITLE_MAX = 80;
const DOUBLE_TAP_MS = 2_000;

/** A break begins (nothing happens if one is already open). Returns the session row. */
function startBreak({ db, bus }, s) {
  if (!s.paused_at) {
    const at = new Date().toISOString();
    db.run('INSERT INTO live_breaks(session_id, started) VALUES(?, ?)', s.id, at);
    db.run('UPDATE live_sessions SET paused_at = ? WHERE id = ?', at, s.id);
    bus.publish(`course:${s.course_id}`, 'live.paused', { session: s.id });
  }
  return db.get('SELECT * FROM live_sessions WHERE id = ?', s.id);
}

/** The open break ends. Returns the session row. */
function endBreak({ db, bus }, s) {
  if (s.paused_at) {
    db.run('UPDATE live_breaks SET ended = ? WHERE session_id = ? AND ended IS NULL', new Date().toISOString(), s.id);
    db.run('UPDATE live_sessions SET paused_at = NULL WHERE id = ?', s.id);
    bus.publish(`course:${s.course_id}`, 'live.resumed', { session: s.id });
  }
  return db.get('SELECT * FROM live_sessions WHERE id = ?', s.id);
}

/** A new chapter starts now. A second mark within seconds of the last is the same mark. Returns { added, number }. */
function startChapter({ db }, s, title = '') {
  const rows = db.all('SELECT id, started FROM live_chapters WHERE session_id = ? ORDER BY started, id', s.id);
  if (rows.length > 1 && Date.now() - Date.parse(rows.at(-1).started) < DOUBLE_TAP_MS) return { added: false, number: rows.length };
  if (!rows.length) db.insert('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', s.id, s.started, '', new Date().toISOString());
  const now = new Date().toISOString();
  db.insert('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', s.id, now, title, now);
  return { added: true, number: Math.max(rows.length, 1) + 1 };
}

function registerLectureEdits(router, { db, bus, blobs = { enabled: false }, transcripts, teaching, lecturerView, breaksOf }) {
  const isoNow = () => new Date().toISOString();

  // ---- chapters ---------------------------------------------------------------------------------------------

  /** The stored chapters in order. A lecture always has one: the first starts with the lecture. */
  function rowsOf(s) {
    const rows = db.all('SELECT id, started, title FROM live_chapters WHERE session_id = ? ORDER BY started, id', s.id);
    if (rows.length) return rows;
    const first = db.insert('INSERT INTO live_chapters(session_id, started, title, created) VALUES(?, ?, ?, ?)', s.id, s.started, '', isoNow());
    return [{ id: first, started: s.started, title: '' }];
  }

  /** Chapters as the lecturer sees them: name, and from/to in teaching seconds (breaks left out). */
  function chaptersOf(s, pre = {}) {
    // The screens fetch the rows and breaks in their own batch and pass them in: no extra round trips.
    const rows = pre.rows?.length ? pre.rows : rowsOf(s);
    const breaks = pre.breaks || breaksOf(s.id);
    const now = Date.now();
    const endMs = s.ended ? Date.parse(s.ended) : now;
    const seconds = (iso) => Math.round(activeMs(s.started, breaks, Math.min(Date.parse(iso), endMs), now) / 1000);
    return rows.map((c, i) => ({
      id: c.id,
      n: i + 1,
      title: c.title,
      name: c.title || `Chapter ${i + 1}`,
      started: c.started,
      from: seconds(c.started),
      to: seconds(rows[i + 1]?.started || new Date(endMs).toISOString()),
      running: i === rows.length - 1 && !s.ended,
    }));
  }

  const chapterOf = (s, chapterId) => {
    const row = rowsOf(s).find((c) => c.id === id(chapterId, 'Chapter'));
    if (!row) throw notFound('Chapter not found');
    return row;
  };

  router.get('/api/live/sessions/:id/chapters', (ctx) => ({ chapters: chaptersOf(teaching(ctx.user, ctx.params.id)) }));

  router.post('/api/live/sessions/:id/chapters', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    const b = await ctx.json();
    const title = text(b.title, { max: TITLE_MAX, optional: true, label: 'Title' });
    rowsOf(s); // a lecture always has its first chapter
    const { added } = startChapter({ db }, s, title); // a second tap right after the first is the same mark
    if (added) ctx.status = 201;
    return { chapters: chaptersOf(s), added };
  });

  router.patch('/api/live/sessions/:id/chapters/:cid', async (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const chapter = chapterOf(s, ctx.params.cid);
    const b = await ctx.json();
    if (b.title === undefined) throw badRequest('Nothing to change');
    db.run('UPDATE live_chapters SET title = ? WHERE id = ?', text(b.title, { max: TITLE_MAX, optional: true, label: 'Title' }), chapter.id);
    return { chapters: chaptersOf(s) };
  });

  router.delete('/api/live/sessions/:id/chapters/:cid', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const rows = rowsOf(s);
    const at = rows.findIndex((c) => c.id === id(ctx.params.cid, 'Chapter'));
    if (at < 0) throw notFound('Chapter not found');
    if (rows.length === 1) throw conflict('A lecture needs at least one chapter.');
    if (at === 0) {
      // The first chapter starts with the lecture: the next one takes over that start, and keeps its own name.
      db.run('UPDATE live_chapters SET started = ? WHERE id = ?', s.started, rows[1].id);
    }
    db.run('DELETE FROM live_chapters WHERE id = ?', rows[at].id);
    return { chapters: chaptersOf(s) };
  });

  // ---- deleting what was recorded ---------------------------------------------------------------------------

  const dropBlobs = (urls) => {
    if (urls.length && blobs.enabled) blobs.del(urls).catch(() => {});
  };

  router.delete('/api/live/sessions/:id/chapters/:cid/content', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const rows = rowsOf(s);
    const at = rows.findIndex((c) => c.id === id(ctx.params.cid, 'Chapter'));
    if (at < 0) throw notFound('Chapter not found');
    const from = rows[at].started;
    const to = rows[at + 1]?.started || (s.ended ? s.ended : '9999-12-31T00:00:00.000Z');
    const fromMs = Date.parse(from);
    const toMs = rows[at + 1] || s.ended ? Date.parse(to) : Infinity;
    // Audio pieces belong to the chapter they began in.
    const pieces = db.all('SELECT id, blob_url, recorded_at FROM live_recordings WHERE session_id = ?', s.id).filter((p) => p.recorded_at >= fromMs && p.recorded_at < toMs);
    for (const p of pieces) db.run('DELETE FROM live_recordings WHERE id = ?', p.id);
    dropBlobs(pieces.map((p) => p.blob_url));
    const lines = db.run('DELETE FROM live_transcript WHERE session_id = ? AND created >= ? AND created < ?', s.id, from, to)?.changes || 0;
    // The few pieces of speech kept beside the transcript go with it: excerpts and key points of that stretch.
    db.run("UPDATE live_moments SET excerpt = '' WHERE session_id = ? AND kind = 'struggle' AND created >= ? AND created < ?", s.id, from, to);
    db.run("DELETE FROM live_moments WHERE session_id = ? AND kind = 'point' AND created >= ? AND created < ?", s.id, from, to);
    if (!s.ended && !rows[at + 1]) transcripts.clear(s.id); // the running chapter: what is in memory goes too
    return { deleted: { lines, audio: pieces.length }, chapters: chaptersOf(s) };
  });

  router.delete('/api/live/sessions/:id/audio', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    const urls = db.all('SELECT blob_url FROM live_recordings WHERE session_id = ?', s.id).map((r) => r.blob_url);
    db.run('DELETE FROM live_recordings WHERE session_id = ?', s.id);
    dropBlobs(urls);
    return { deleted: { audio: urls.length } };
  });

  // ---- breaks -----------------------------------------------------------------------------------------------

  router.post('/api/live/sessions/:id/pause', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    return lecturerView(startBreak({ db, bus }, s));
  });

  router.post('/api/live/sessions/:id/resume', (ctx) => {
    const s = teaching(ctx.user, ctx.params.id);
    if (s.ended) throw conflict('This lecture has ended');
    return lecturerView(endBreak({ db, bus }, s));
  });

  return { chaptersOf };
}

module.exports = { registerLectureEdits, startBreak, endBreak, startChapter, TITLE_MAX };
