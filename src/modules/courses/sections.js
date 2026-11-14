'use strict';
/**
 * The course page as an outline, like Moodle: topics, topics inside topics (folders within folders), and in each
 * one files, links and its own lectures. What has no topic belongs to the course as a whole ("General").
 *
 *   GET    /api/courses/:id/outline              topics (a tree), files and links, lectures by topic   (members)
 *   POST   /api/courses/:id/sections             { title, parent_id?, summary? }                       (lecturer)
 *   PATCH  /api/sections/:id                     { title?, summary?, move?: 'up'|'down', parent_id? }  (lecturer)
 *   DELETE /api/sections/:id                     the topic, its sub-topics and their files; lectures stay (lecturer)
 *   POST   /api/courses/:id/files                the file itself (raw), X-File-Name, X-Section-Id      (lecturer)
 *   POST   /api/courses/:id/files/start          { name, size, type, section_id? } → an upload pass     (lecturer, file storage)
 *   POST   /api/courses/:id/files/finish         { ticket, url } after the browser uploaded the file    (lecturer, file storage)
 *   POST   /api/courses/:id/links                { title, url, section_id? }                           (lecturer)
 *   PATCH  /api/course-items/:id                 { title?, section_id?, move?: 'up'|'down' }           (lecturer)
 *   DELETE /api/course-items/:id                                                                       (lecturer)
 *   GET    /api/course-items/:id/file            download; ?view=1 opens PDFs and pictures in the browser (members)
 *   PATCH  /api/lectures/:id/section             { section_id }  put a lecture in a topic              (lecturer)
 *
 * Files are kept with their readable text, so Campus can use a topic's files in lectures and answers. Without file
 * storage they live in the database (at most 4 MB each, the limit of a request on the hosting); with a Vercel Blob
 * store (src/services/blob.js) the browser uploads them straight to it, up to 100 MB, and downloads are streamed
 * through here after the access check. Nothing runs from an uploaded file: downloads are attachments, and only
 * PDFs and pictures may open in the browser.
 */
const crypto = require('node:crypto');
const { text, id } = require('../../lib/validate');
const { badRequest, forbidden, notFound } = require('../../http/errors');
const { extractText } = require('../../lib/extract-text');
const { pipeTo, safeName } = require('../../services/blob');

const MAX_FILE = 4 * 1024 * 1024;
const MAX_STORED_FILE = 100 * 1024 * 1024;
const MAX_READ = 25 * 1024 * 1024; // larger files are kept for download, without Campus reading them
const MAX_DEPTH = 6;
const VIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SAFE_TYPES = /^(application\/(pdf|msword|vnd\.[\w.+-]+|zip|json|x-ipynb\+json)|text\/(plain|markdown|csv)|image\/(png|jpeg|webp|gif)|audio\/[\w.+-]+|video\/(mp4|webm))$/;

function registerSections(router, { db, access, bus, blobs = { enabled: false } }) {
  const now = () => new Date().toISOString();
  const touch = (courseId) => bus.publish(`course:${courseId}`, 'course.updated', { courseId });

  const teaching = (user, courseId) => {
    const course = access.teachingCourse(user, courseId);
    if (!course) throw forbidden('Only the lecturer of this course can change it');
    return course;
  };
  const sectionOf = (user, sectionId, { teach = true } = {}) => {
    const s = db.get('SELECT * FROM course_sections WHERE id = ?', id(sectionId, 'Topic'));
    if (!s) throw notFound('Topic not found');
    if (teach) teaching(user, s.course_id);
    else if (!access.course(user, s.course_id)) throw forbidden('Join this course first');
    return s;
  };
  const itemOf = (user, itemId, { teach = true } = {}) => {
    const item = db.get('SELECT * FROM course_items WHERE id = ?', id(itemId, 'File'));
    if (!item) throw notFound('Not found');
    if (teach) teaching(user, item.course_id);
    else if (!access.course(user, item.course_id) && !access.teachingCourse(user, item.course_id)) throw forbidden('Join this course first');
    return item;
  };
  /** A topic id that belongs to this course, or null for "General". */
  const sectionIn = (courseId, value) => {
    if (value === undefined || value === null || value === '') return null;
    const s = db.get('SELECT id FROM course_sections WHERE id = ? AND course_id = ?', id(value, 'Topic'), courseId);
    if (!s) throw badRequest('That topic is not in this course');
    return s.id;
  };
  const depthOf = (sectionId) => {
    let depth = 0;
    let at = sectionId;
    while (at && depth < 50) {
      at = db.get('SELECT parent_id FROM course_sections WHERE id = ?', at)?.parent_id;
      depth += 1;
    }
    return depth;
  };
  /** A topic and every topic inside it. */
  const subtree = (sectionId) => {
    const out = [sectionId];
    for (let i = 0; i < out.length; i += 1) out.push(...db.all('SELECT id FROM course_sections WHERE parent_id = ?', out[i]).map((r) => r.id));
    return out;
  };
  const nextPosition = (table, where, ...args) => (db.get(`SELECT MAX(position) AS p FROM ${table} WHERE ${where}`, ...args)?.p ?? -1) + 1;
  /** Swap with the neighbour above or below among siblings. */
  function move(table, row, dir, siblingsWhere, ...args) {
    const siblings = db.all(`SELECT id, position FROM ${table} WHERE ${siblingsWhere} ORDER BY position, id`, ...args);
    const i = siblings.findIndex((x) => x.id === row.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    siblings.forEach((x, k) => db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, k === i ? j : k === j ? i : k, x.id));
  }

  // ---- the outline -----------------------------------------------------------------------------------------

  router.get('/api/courses/:id/outline', (ctx) => {
    const courseId = id(ctx.params.id, 'Course');
    const course = access.course(ctx.user, courseId) || access.teachingCourse(ctx.user, courseId);
    if (!course) throw forbidden('Join this course to see it');
    const sections = db.all('SELECT id, parent_id, title, summary, position FROM course_sections WHERE course_id = ? ORDER BY position, id', course.id);
    const items = db.all('SELECT id, section_id, kind, title, url, mime, size, created FROM course_items WHERE course_id = ? ORDER BY position, id', course.id);
    const lectures = db.all('SELECT id, topic, section_id, status, starts, room FROM lectures WHERE course_id = ? ORDER BY COALESCE(starts, created), id', course.id).map((l) => {
      const live = db.get('SELECT id FROM live_sessions WHERE lecture_id = ? AND ended IS NULL ORDER BY id DESC LIMIT 1', l.id);
      const last = db.get('SELECT id FROM live_sessions WHERE lecture_id = ? ORDER BY id DESC LIMIT 1', l.id);
      return { ...l, live: !!live, lastSession: last?.id || null };
    });
    return {
      course: { id: course.id, code: course.code, title: course.title }, sections, items, lectures, isTeacher: !!access.teachingCourse(ctx.user, course.id),
      storage: { direct: !!blobs.enabled, maxBytes: blobs.enabled ? MAX_STORED_FILE : MAX_FILE },
    };
  });

  // ---- topics ------------------------------------------------------------------------------------------------

  router.post('/api/courses/:id/sections', async (ctx) => {
    const course = teaching(ctx.user, id(ctx.params.id, 'Course'));
    const b = await ctx.json();
    const title = text(b.title, { min: 1, max: 120, label: 'Topic' });
    const summary = text(b.summary, { max: 1000, optional: true, label: 'Summary' }) || '';
    const parent = sectionIn(course.id, b.parent_id);
    if (parent && depthOf(parent) >= MAX_DEPTH) throw badRequest(`Topics go at most ${MAX_DEPTH} levels deep`);
    const sectionId = db.insert('INSERT INTO course_sections(course_id, parent_id, title, summary, position, created) VALUES(?, ?, ?, ?, ?, ?)',
      course.id, parent, title, summary, nextPosition('course_sections', 'course_id = ? AND parent_id IS ?', course.id, parent), now());
    touch(course.id);
    ctx.status = 201;
    return { id: sectionId };
  });

  router.patch('/api/sections/:id', async (ctx) => {
    const s = sectionOf(ctx.user, ctx.params.id);
    const b = await ctx.json();
    if (b.title !== undefined) db.run('UPDATE course_sections SET title = ? WHERE id = ?', text(b.title, { min: 1, max: 120, label: 'Topic' }), s.id);
    if (b.summary !== undefined) db.run('UPDATE course_sections SET summary = ? WHERE id = ?', text(b.summary, { max: 1000, optional: true, label: 'Summary' }) || '', s.id);
    if (b.parent_id !== undefined) {
      const parent = sectionIn(s.course_id, b.parent_id);
      if (parent && subtree(s.id).includes(parent)) throw badRequest('A topic cannot go inside itself');
      if (parent && depthOf(parent) >= MAX_DEPTH) throw badRequest(`Topics go at most ${MAX_DEPTH} levels deep`);
      db.run('UPDATE course_sections SET parent_id = ?, position = ? WHERE id = ?', parent, nextPosition('course_sections', 'course_id = ? AND parent_id IS ?', s.course_id, parent), s.id);
    }
    if (b.move === 'up' || b.move === 'down') move('course_sections', s, b.move, 'course_id = ? AND parent_id IS ?', s.course_id, s.parent_id);
    touch(s.course_id);
    return { ok: true };
  });

  router.delete('/api/sections/:id', (ctx) => {
    const s = sectionOf(ctx.user, ctx.params.id);
    const ids = subtree(s.id);
    const marks = ids.map(() => '?').join(',');
    // Lectures are kept (with their reviews); they move to "General".
    db.run(`UPDATE lectures SET section_id = NULL WHERE section_id IN (${marks})`, ...ids);
    forget(db.all(`SELECT blob_url FROM course_items WHERE section_id IN (${marks}) AND blob_url != ''`, ...ids).map((r) => r.blob_url));
    db.run(`DELETE FROM course_items WHERE section_id IN (${marks})`, ...ids);
    for (const sectionId of [...ids].reverse()) db.run('DELETE FROM course_sections WHERE id = ?', sectionId);
    touch(s.course_id);
    return { ok: true, removed: ids.length };
  });

  // ---- files and links ---------------------------------------------------------------------------------------

  const cleanName = (value) => String(value || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 160) || 'file';
  async function readableText(name, mime, buffer) {
    try {
      const result = await extractText({ name, mime, buffer });
      return String(result?.text ?? result ?? '').slice(0, 200_000);
    } catch {
      return ''; // a picture or a file without text: kept for download all the same
    }
  }
  const forget = (urls) => {
    const list = urls.filter(Boolean);
    if (blobs.enabled && list.length) blobs.del(list).catch(() => {});
  };

  router.post('/api/courses/:id/files', async (ctx) => {
    const course = teaching(ctx.user, id(ctx.params.id, 'Course'));
    const sectionId = sectionIn(course.id, ctx.req.headers['x-section-id']);
    let name = 'file';
    try {
      name = decodeURIComponent(String(ctx.req.headers['x-file-name'] || 'file'));
    } catch {
      /* keep the default */
    }
    name = cleanName(name);
    const mime = String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const buffer = await ctx.raw(MAX_FILE);
    if (!buffer.length) throw badRequest('The file is empty');
    const readable = await readableText(name, mime, buffer);
    const itemId = db.insert(
      'INSERT INTO course_items(course_id, section_id, kind, title, mime, size, data, text, position, created_by, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      course.id, sectionId, 'file', name, mime, buffer.length, buffer.toString('base64'), readable,
      nextPosition('course_items', 'course_id = ? AND section_id IS ?', course.id, sectionId), ctx.user.id, now(),
    );
    touch(course.id);
    ctx.status = 201;
    return { id: itemId, title: name, size: buffer.length, readable: readable.length > 0 };
  });

  /**
   * Big files (file storage only): the browser asks for a pass, uploads the file straight to the store, then hands
   * back the receipt. The pass allows only this path, this size and this type, for ten minutes.
   */
  router.post('/api/courses/:id/files/start', async (ctx) => {
    const course = teaching(ctx.user, id(ctx.params.id, 'Course'));
    if (!blobs.enabled) throw badRequest('Large files need file storage, which is not set up. Files up to 4 MB still work.');
    const b = await ctx.json();
    const name = cleanName(b.name);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 1) throw badRequest('The file is empty');
    if (size > MAX_STORED_FILE) throw badRequest(`Files can be at most ${MAX_STORED_FILE / 1024 / 1024} MB`);
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(b.type || '')) ? String(b.type).toLowerCase() : 'application/octet-stream';
    const sectionId = sectionIn(course.id, b.section_id);
    const pathname = `courses/${course.id}/${crypto.randomUUID()}/${safeName(name)}`;
    return {
      pass: blobs.uploadPass({ pathname, maximumSizeInBytes: size, allowedContentTypes: [mime] }),
      contentType: mime,
      ticket: blobs.ticket({ kind: 'course-file', courseId: course.id, userId: ctx.user.id, sectionId, pathname, name, mime, size }),
    };
  });

  router.post('/api/courses/:id/files/finish', async (ctx) => {
    const course = teaching(ctx.user, id(ctx.params.id, 'Course'));
    if (!blobs.enabled) throw badRequest('File storage is not set up');
    const b = await ctx.json();
    const t = blobs.readTicket(b.ticket);
    if (!t || t.kind !== 'course-file' || t.courseId !== course.id || t.userId !== ctx.user.id) throw badRequest('This upload has expired. Please try again.');
    const url = typeof b.url === 'string' && b.url ? b.url : blobs.urlOf(t.pathname);
    if (!blobs.owns(url) || new URL(url).pathname !== `/${t.pathname}`) throw badRequest('That is not the file that was uploaded');
    if (db.get('SELECT 1 AS dup FROM course_items WHERE blob_url = ?', url)) throw badRequest('This file is already in the course');
    const buffer = t.size <= MAX_READ ? await blobs.read(url, MAX_READ) : null;
    if (t.size <= MAX_READ && !buffer) throw badRequest('The upload did not arrive. Please try again.');
    if (!buffer && !(await blobs.get(url).then((r) => (r?.body?.cancel?.(), !!r)))) throw badRequest('The upload did not arrive. Please try again.');
    const readable = buffer ? await readableText(t.name, t.mime, buffer) : '';
    const sectionId = t.sectionId && db.get('SELECT id FROM course_sections WHERE id = ? AND course_id = ?', t.sectionId, course.id) ? t.sectionId : null;
    const size = buffer ? buffer.length : t.size;
    const itemId = db.insert(
      'INSERT INTO course_items(course_id, section_id, kind, title, mime, size, blob_url, text, position, created_by, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      course.id, sectionId, 'file', t.name, t.mime, size, url, readable,
      nextPosition('course_items', 'course_id = ? AND section_id IS ?', course.id, sectionId), ctx.user.id, now(),
    );
    touch(course.id);
    ctx.status = 201;
    return { id: itemId, title: t.name, size, readable: readable.length > 0 };
  });

  router.post('/api/courses/:id/links', async (ctx) => {
    const course = teaching(ctx.user, id(ctx.params.id, 'Course'));
    const b = await ctx.json();
    const url = text(b.url, { min: 4, max: 2000, label: 'Link' }).trim();
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
      throw badRequest('That is not a web address');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw badRequest('Links must start with http or https');
    const title = text(b.title, { max: 160, optional: true, label: 'Title' }) || parsed.hostname;
    const sectionId = sectionIn(course.id, b.section_id);
    const itemId = db.insert('INSERT INTO course_items(course_id, section_id, kind, title, url, position, created_by, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      course.id, sectionId, 'link', title, parsed.href, nextPosition('course_items', 'course_id = ? AND section_id IS ?', course.id, sectionId), ctx.user.id, now());
    touch(course.id);
    ctx.status = 201;
    return { id: itemId };
  });

  router.patch('/api/course-items/:id', async (ctx) => {
    const item = itemOf(ctx.user, ctx.params.id);
    const b = await ctx.json();
    if (b.title !== undefined) db.run('UPDATE course_items SET title = ? WHERE id = ?', text(b.title, { min: 1, max: 160, label: 'Title' }), item.id);
    if (b.section_id !== undefined) {
      const sectionId = sectionIn(item.course_id, b.section_id);
      db.run('UPDATE course_items SET section_id = ?, position = ? WHERE id = ?', sectionId, nextPosition('course_items', 'course_id = ? AND section_id IS ?', item.course_id, sectionId), item.id);
    }
    if (b.move === 'up' || b.move === 'down') move('course_items', item, b.move, 'course_id = ? AND section_id IS ?', item.course_id, item.section_id);
    touch(item.course_id);
    return { ok: true };
  });

  router.delete('/api/course-items/:id', (ctx) => {
    const item = itemOf(ctx.user, ctx.params.id);
    forget([item.blob_url]);
    db.run('DELETE FROM course_items WHERE id = ?', item.id);
    touch(item.course_id);
    return { ok: true };
  });

  router.get('/api/course-items/:id/file', async (ctx) => {
    const item = itemOf(ctx.user, ctx.params.id, { teach: false });
    if (item.kind !== 'file') throw notFound('Not a file');
    const inline = ctx.query.get('view') === '1' && VIEWABLE.has(item.mime);
    const type = SAFE_TYPES.test(item.mime) ? item.mime : 'application/octet-stream';
    const ascii = item.title.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, "'");
    const head = (length) => ({
      'Content-Type': type,
      ...(length ? { 'Content-Length': length } : {}),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.title)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(inline ? { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' } : {}),
    });
    if (item.blob_url) {
      if (!blobs.enabled) throw notFound('This file is in file storage, which is not connected right now');
      const upstream = await blobs.get(item.blob_url);
      if (!upstream) throw notFound('This file is no longer in storage');
      ctx.res.writeHead(200, head(Number(upstream.headers.get('content-length')) || 0));
      await pipeTo(ctx.res, upstream);
      return;
    }
    const full = db.get('SELECT data FROM course_items WHERE id = ?', item.id);
    const bytes = Buffer.from(full.data, 'base64');
    ctx.res.writeHead(200, head(bytes.length));
    ctx.res.end(bytes);
  });

  // ---- lectures in topics ------------------------------------------------------------------------------------

  router.patch('/api/lectures/:id/section', async (ctx) => {
    const lecture = access.lecture(ctx.user, id(ctx.params.id, 'Lecture'), { teach: true });
    if (!lecture) throw forbidden('Not your lecture');
    const b = await ctx.json();
    db.run('UPDATE lectures SET section_id = ? WHERE id = ?', sectionIn(lecture.course_id, b.section_id), lecture.id);
    touch(lecture.course_id);
    return { ok: true };
  });
}

/**
 * The readable text of the files in a lecture's topic (and the topics around it, up to the course), for Campus
 * during and after the lecture. Empty when the lecture has no topic or the files have no text.
 */
function topicFilesText(db, lectureId, maxChars = 40_000) {
  const lecture = lectureId ? db.get('SELECT course_id, section_id FROM lectures WHERE id = ?', lectureId) : null;
  if (!lecture?.section_id) return '';
  const chain = [];
  let at = lecture.section_id;
  while (at && chain.length < 10) {
    const s = db.get('SELECT id, parent_id, title FROM course_sections WHERE id = ?', at);
    if (!s) break;
    chain.push(s);
    at = s.parent_id;
  }
  let out = '';
  for (const s of chain) {
    for (const f of db.all("SELECT title, text FROM course_items WHERE section_id = ? AND kind = 'file' AND text != '' ORDER BY position, id", s.id)) {
      const block = `<TOPIC_FILE topic="${s.title.replace(/"/g, "'")}" file="${f.title.replace(/"/g, "'")}">\n${f.text}\n</TOPIC_FILE>\n`;
      if (out.length + block.length > maxChars) return out;
      out += block;
    }
  }
  return out;
}

const STOP = new Set('the and for with that this what how why when where which who are was were can could should would does did have has from into about your you our their them they then than there here also just only some any all not but use using used make made like over under more most less very much many each other such these those been being will shall may might must its der die das und oder mit für fur von zum zur ist sind war wie was warum wann wo wer ein eine einen einem einer nicht auch nur noch bei aus auf den dem des sich ich du er sie wir ihr mein dein kann können konnen soll muss'.split(' '));
const termsOf = (s) => [...new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))];

/**
 * Course files that answer a question, best first, for Ask Campus at any time (not only in lectures). `courseIds`
 * are the courses the person may see. With `all`, every readable file of the course counts (best first) even
 * without a match: the person asked about that course. Returns [{ id, title, topic, course, excerpt, text }].
 */
function findCourseFiles(db, courseIds, query, { all = false, limit = 4, maxChars = 36_000 } = {}) {
  if (!courseIds.length) return [];
  const words = termsOf(query);
  // The database narrows it down first (a file must contain one of the words), so a question never loads every
  // file; both the word as written and without accents ("Prüfung", "prufung").
  const asWritten = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  const likes = [...new Set([...asWritten, ...words])].slice(0, 12);
  if (!all && !likes.length) return [];
  const marks = courseIds.map(() => '?').join(',');
  const narrow = all ? '' : ` AND (${likes.map(() => '(i.title LIKE ? OR i.text LIKE ?)').join(' OR ')})`;
  const files = db.all(
    `SELECT i.id, i.title, substr(i.text, 1, 30000) AS head, length(i.text) AS size, i.course_id, c.code, s.title AS topic FROM course_items i
     JOIN courses c ON c.id = i.course_id LEFT JOIN course_sections s ON s.id = i.section_id
     WHERE i.course_id IN (${marks}) AND i.kind = 'file' AND i.text != ''${narrow} ORDER BY i.course_id, i.position, i.id LIMIT 80`,
    ...courseIds, ...(all ? [] : likes.flatMap((w) => [`%${w}%`, `%${w}%`])),
  );
  const scored = files.map((f) => {
    const title = termsOf(`${f.title} ${f.topic || ''}`);
    const body = f.head.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const inTitle = words.filter((w) => title.includes(w)).length;
    const inText = words.filter((w) => body.includes(w)).length;
    const matched = words.filter((w) => title.includes(w) || body.includes(w)).length;
    return { f, score: inTitle * 3 + inText, matched };
  });
  // Two of the question's words (one for a one-word question), unless the person asked about this course.
  const need = Math.min(2, words.length);
  const chosen = scored.filter((x) => all || (need > 0 && x.matched >= need))
    .sort((a, b) => b.score - a.score).slice(0, limit);
  let left = maxChars;
  const out = [];
  for (const { f } of chosen) {
    if (left < 1500) break;
    const text = f.size > f.head.length ? db.get('SELECT text FROM course_items WHERE id = ?', f.id).text : f.head;
    const piece = excerptAround(text, words, Math.min(left, 20_000));
    left -= piece.length;
    out.push({ id: f.id, title: f.title, topic: f.topic || 'General', course: f.code, text: piece, excerpt: piece.replace(/\s+/g, ' ').slice(0, 277) + (piece.length > 277 ? '…' : '') });
  }
  return out;
}

/** The part of a long text where the question's words are, so a big file still fits. */
function excerptAround(text, words, size) {
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  let best = 0;
  let bestHits = -1;
  const step = Math.max(1000, Math.floor(size / 4));
  for (let at = 0; at < text.length; at += step) {
    const window = lower.slice(at, at + size);
    const hits = words.reduce((n, w) => n + (window.includes(w) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = at;
    }
  }
  return `${best ? '…' : ''}${text.slice(best, best + size)}${best + size < text.length ? '…' : ''}`;
}

module.exports = { registerSections, topicFilesText, findCourseFiles, MAX_FILE, MAX_STORED_FILE };
