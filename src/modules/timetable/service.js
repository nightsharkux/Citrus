'use strict';
/**
 * Schedule visibility and recurrence expansion.
 *
 * Events are stored once (first occurrence + repeat_weeks + until) and
 * expanded on read in the institution's time zone, so a 10:00 lecture stays
 * at 10:00 after the clocks change.
 */
const { addLocalDays, DAY } = require('../../lib/time');
const { text, oneOf, isoDate, integer } = require('../../lib/validate');
const { badRequest } = require('../../http/errors');

const KINDS = ['lecture', 'exam', 'seminar', 'lab', 'event', 'deadline', 'personal'];

const MAX_OCCURRENCES = 1000;

function createTimetable({ db, timeZone }) {
  /** Base rows visible to a user (optionally a single course). */
  function visibleRows(user, { courseId = null } = {}) {
    if (courseId) {
      return db.all(
        `SELECT e.*, c.code AS course_code, c.title AS course_title FROM timetable_events e LEFT JOIN courses c ON c.id = e.course_id
         WHERE e.course_id = ? AND e.institution_id = ?`, courseId, user.institution_id,
      );
    }
    const courseFilter = user.role === 'student'
      ? 'e.course_id IN (SELECT course_id FROM enrollments WHERE user_id = @uid)'
      : 'e.course_id IN (SELECT id FROM courses WHERE lecturer_id = @uid)';
    return db.prepare(
      `SELECT e.*, c.code AS course_code, c.title AS course_title FROM timetable_events e LEFT JOIN courses c ON c.id = e.course_id
       WHERE e.institution_id = @inst AND (${courseFilter} OR e.owner_id = @uid OR (e.course_id IS NULL AND e.owner_id IS NULL))`,
    ).all({ uid: user.id, inst: user.institution_id });
  }

  function expand(rows, fromIso, toIso, user) {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const out = [];
    for (const e of rows) {
      const start = new Date(e.starts);
      const duration = new Date(e.ends).getTime() - start.getTime();
      const until = e.until ? new Date(e.until).getTime() : Infinity;
      const step = e.repeat_weeks > 0 ? 7 * e.repeat_weeks : 0;

      let n = 0;
      if (step && from > start.getTime()) n = Math.max(0, Math.floor((from - start.getTime()) / (step * DAY)) - 1);
      for (let guard = 0; guard < MAX_OCCURRENCES; guard += 1, n += 1) {
        const occStart = step ? addLocalDays(start, n * step, timeZone) : start;
        const t = occStart.getTime();
        if (t > to || t > until) break;
        if (t + duration >= from) {
          out.push({
            key: `${e.id}-${n}`,
            id: e.id,
            title: e.title,
            kind: e.kind,
            location: e.location,
            notes: e.notes,
            starts: occStart.toISOString(),
            ends: new Date(t + duration).toISOString(),
            recurring: step > 0,
            course: e.course_id ? { id: e.course_id, code: e.course_code, title: e.course_title } : null,
            scope: e.owner_id ? 'personal' : e.course_id ? 'course' : 'institution',
            editable: !!user && canEdit(user, e),
          });
        }
        if (!step) break;
      }
    }
    return out.sort((a, b) => a.starts.localeCompare(b.starts));
  }

  function canEdit(user, e) {
    if (e.owner_id) return e.owner_id === user.id;
    if (user.role === 'admin') return true;
    if (e.course_id && user.role === 'lecturer') return !!db.get('SELECT 1 FROM courses WHERE id = ? AND lecturer_id = ?', e.course_id, user.id);
    return false;
  }

  function between(user, fromIso, toIso, options) {
    return expand(visibleRows(user, options), fromIso, toIso, user);
  }

  function upcoming(user, { days = 7, limit = 10 } = {}) {
    const now = Date.now();
    return between(user, new Date(now).toISOString(), new Date(now + days * DAY).toISOString()).filter((e) => new Date(e.ends).getTime() > now).slice(0, limit);
  }

  /** Validate event fields from a request body. Shared by the schedule API and the assistant. */
  function readEvent(b) {
    const starts = isoDate(b.starts, 'Start');
    const ends = isoDate(b.ends, 'End');
    if (new Date(ends) <= new Date(starts)) throw badRequest('The event must end after it starts');
    if (new Date(ends) - new Date(starts) > 14 * DAY) throw badRequest('Events can be at most two weeks long');
    const repeatWeeks = b.repeat_weeks ? integer(b.repeat_weeks, { min: 0, max: 4, label: 'Repeat' }) : 0;
    return {
      title: text(b.title, { min: 2, max: 120, label: 'Title' }),
      kind: oneOf(b.kind || 'lecture', KINDS, 'Type'),
      location: text(b.location, { max: 120, optional: true }),
      notes: text(b.notes, { max: 1000, optional: true }),
      starts,
      ends,
      repeatWeeks,
      until: repeatWeeks && b.until ? isoDate(b.until, 'Repeat until') : null,
    };
  }

  function insert(user, { courseId = null, ownerId = null }, e) {
    return db.insert(
      `INSERT INTO timetable_events(institution_id, course_id, owner_id, title, kind, location, notes, starts, ends, repeat_weeks, until, created_by, created)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.institution_id, courseId, ownerId, e.title, e.kind, e.location, e.notes, e.starts, e.ends, e.repeatWeeks, e.until, user.id, new Date().toISOString(),
    );
  }

  return { between, upcoming, canEdit, expand, visibleRows, readEvent, insert };
}

module.exports = { createTimetable, KINDS };
