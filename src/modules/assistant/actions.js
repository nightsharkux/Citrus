'use strict';
/**
 * Things the assistant can do for the user, and how to undo them.
 *
 * Every action runs as the signed-in user, through the same rules as the rest
 * of the app, and only touches that user's own data: personal calendar events,
 * navigation and the colour theme. Nothing here posts, messages or notifies
 * anyone else, and every change except navigation can be undone.
 *
 * To add an action: add a function to ACTIONS that returns
 *   { title, detail?, warning?, link?, client?, undo? }
 * and describe it in src/ai/prompts.js (ACTION_GUIDE).
 * `client` is carried out by the browser (navigate, theme); `undo` is kept
 * server-side and never sent to the client.
 */
const { HttpError } = require('../../http/errors');
const { zonedToUtc, zonedParts, DAY } = require('../../lib/time');
const { KINDS } = require('../timetable/service');

const ERRORS = {
  when: 'I could not read that date and time.',
  mine: 'I can only change your own events. Open the schedule to change course or university events.',
  repeats: 'This event repeats every week. Change it in the schedule so the whole series moves correctly.',
};

/** Where "navigate" may go, by role. */
const PAGES = {
  home: '/home', assistant: '/assistant', courses: '/courses', schedule: '/schedule', spaces: '/spaces', campus: '/campus', inbox: '/inbox', settings: '/settings', tools: '/tools', guide: '/campus/guide', profile: '/settings/profile',
};
const ROLE_PAGES = {
  student: { learning: '/learning', review: '/learning', participation: '/participation', career: '/career' },
  lecturer: { classroom: '/classroom', participation: '/participation' },
  admin: { people: '/admin/people', moderation: '/admin/moderation', ai: '/admin/ai', devices: '/admin/devices', institution: '/admin/institution', classroom: '/classroom', participation: '/participation' },
};
const ALIASES = { calendar: 'schedule', timetable: 'schedule', notifications: 'inbox', messages: 'inbox', chat: 'assistant', learn: 'learning', study: 'learning', teaching: 'courses', events: 'campus', feed: 'campus', rooms: 'spaces', checkin: 'participation', 'check-in': 'participation', careers: 'career', all_tools: 'tools', features: 'tools', preferences: 'settings', account: 'settings' };

function createActionRunner({ db, config, access, timetable, audit }) {
  const tz = config.site.timezone;
  const when = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(iso));
  const dayAndTime = (startIso, endIso) => `${when(startIso, { weekday: 'short', day: 'numeric', month: 'short' })}, ${when(startIso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}–${when(endIso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
  const fail = (message) => new HttpError(400, message);

  /** "2026-11-10T15:00" is local time in the institution's zone; a full ISO string with Z or an offset is taken as written. */
  function parseWhen(value, { endOfDay = false } = {}) {
    const s = String(value ?? '').trim();
    const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    let date = null;
    if (local) {
      const [, y, mo, d, h, mi, sec] = local;
      const dateOnly = h === undefined;
      date = zonedToUtc({ year: +y, month: +mo, day: +d, hour: dateOnly && endOfDay ? 23 : +(h || 0), minute: dateOnly && endOfDay ? 59 : +(mi || 0), second: dateOnly && endOfDay ? 59 : +(sec || 0) }, tz);
      const p = zonedParts(date, tz);
      if (p.month !== +mo || p.day !== +d) date = null; // 31 February and similar
    } else if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      date = new Date(s);
    }
    if (!date || Number.isNaN(date.getTime())) throw fail(ERRORS.when);
    const now = Date.now();
    if (date.getTime() < now - 366 * DAY || date.getTime() > now + 3 * 366 * DAY) throw fail('That date looks wrong. Please give the day again.');
    return date;
  }

  const personal = (user, id) => {
    const row = db.get('SELECT * FROM timetable_events WHERE id = ? AND institution_id = ?', Number(id), user.institution_id);
    if (!row) throw fail('I could not find that event. It may have been removed.');
    if (row.owner_id !== user.id) throw fail(ERRORS.mine);
    return row;
  };
  const snapshot = (row) => ({ title: row.title, kind: row.kind, location: row.location, notes: row.notes, starts: row.starts, ends: row.ends, repeat_weeks: row.repeat_weeks, until: row.until });
  const restoreRow = (id, s) => db.run('UPDATE timetable_events SET title = ?, kind = ?, location = ?, notes = ?, starts = ?, ends = ?, repeat_weeks = ?, until = ? WHERE id = ?', s.title, s.kind, s.location, s.notes, s.starts, s.ends, s.repeat_weeks, s.until, id);

  const overlaps = (user, startIso, endIso, ignoreId) => timetable.between(user, startIso, endIso)
    .filter((e) => e.id !== ignoreId && e.starts < endIso && e.ends > startIso)
    .slice(0, 3)
    .map((e) => e.title);
  const clash = (names) => (names.length ? `Overlaps with ${names.join(', ')}` : undefined);

  const ACTIONS = {
    'calendar.add'(user, a) {
      const start = parseWhen(a.start);
      let end;
      if (a.end) end = parseWhen(a.end);
      else {
        const minutes = Math.min(720, Math.max(5, Number(a.duration_minutes) || 60));
        end = new Date(start.getTime() + minutes * 60_000);
      }
      const repeatWeeks = Number(a.repeat_weeks) > 0 ? Math.min(4, Math.round(Number(a.repeat_weeks))) : 0;
      const e = timetable.readEvent({
        title: a.title, kind: KINDS.includes(a.kind) ? a.kind : 'personal', location: a.location, notes: a.notes,
        starts: start.toISOString(), ends: end.toISOString(), repeat_weeks: repeatWeeks, until: repeatWeeks && a.until ? parseWhen(a.until, { endOfDay: true }).toISOString() : null,
      });
      const id = timetable.insert(user, { ownerId: user.id }, e);
      return {
        title: 'Added to your calendar',
        detail: `${e.title} · ${dayAndTime(e.starts, e.ends)}${e.repeatWeeks ? ` · repeats ${e.repeatWeeks === 1 ? 'weekly' : `every ${e.repeatWeeks} weeks`}` : ''}`,
        warning: clash(overlaps(user, e.starts, e.ends, id)),
        eventId: id,
        link: `/schedule?week=${weekOffset(start)}`,
        undo: { op: 'delete', id },
      };
    },

    'calendar.update'(user, a) {
      const row = personal(user, a.id);
      const before = snapshot(row);
      const timeChange = a.start !== undefined || a.end !== undefined || a.duration_minutes !== undefined;
      if (row.repeat_weeks > 0 && timeChange) throw fail(ERRORS.repeats);
      let starts = row.starts;
      let ends = row.ends;
      if (a.start !== undefined) {
        const duration = new Date(row.ends) - new Date(row.starts);
        starts = parseWhen(a.start).toISOString();
        ends = new Date(new Date(starts).getTime() + duration).toISOString();
      }
      if (a.end !== undefined) ends = parseWhen(a.end).toISOString();
      else if (a.duration_minutes !== undefined) ends = new Date(new Date(starts).getTime() + Math.min(720, Math.max(5, Number(a.duration_minutes) || 60)) * 60_000).toISOString();
      const e = timetable.readEvent({
        title: a.title ?? row.title, kind: KINDS.includes(a.kind) ? a.kind : row.kind, location: a.location ?? row.location, notes: a.notes ?? row.notes,
        starts, ends, repeat_weeks: row.repeat_weeks, until: row.until,
      });
      db.run('UPDATE timetable_events SET title = ?, kind = ?, location = ?, notes = ?, starts = ?, ends = ?, repeat_weeks = ?, until = ? WHERE id = ?', e.title, e.kind, e.location, e.notes, e.starts, e.ends, e.repeatWeeks, e.until, row.id);
      return {
        title: 'Calendar updated',
        detail: `${e.title} · ${dayAndTime(e.starts, e.ends)}`,
        warning: clash(overlaps(user, e.starts, e.ends, row.id)),
        eventId: row.id,
        link: `/schedule?week=${weekOffset(new Date(e.starts))}`,
        undo: { op: 'restore', id: row.id, row: before },
      };
    },

    'calendar.delete'(user, a) {
      const row = personal(user, a.id);
      db.run('DELETE FROM timetable_events WHERE id = ?', row.id);
      return {
        title: 'Removed from your calendar',
        detail: `${row.title} · ${dayAndTime(row.starts, row.ends)}${row.repeat_weeks ? ' · all repeats' : ''}`,
        undo: { op: 'recreate', row: snapshot(row) },
      };
    },

    'app.navigate'(user, a) {
      const pages = { ...PAGES, ...(ROLE_PAGES[user.role] || {}) };
      if (user.role !== 'student') delete pages.career;
      const key = String(a.to || '').toLowerCase().replace(/^\//, '');
      let path = pages[ALIASES[key] || key];
      let label = ALIASES[key] || key;
      if (a.course) {
        const c = db.get('SELECT id, code FROM courses WHERE institution_id = ? AND UPPER(code) = UPPER(?)', user.institution_id, String(a.course).trim());
        if (!c || !access.course(user, c.id)) throw fail('I could not find that course.');
        path = `/courses/${c.id}`;
        label = c.code;
      }
      if (!path) throw fail('I do not know that page.');
      return { title: `Opening ${label.replace(/_/g, ' ')}`, client: { type: 'navigate', path } };
    },

    'app.theme'(user, a) {
      const mode = String(a.mode || '').toLowerCase();
      if (!['light', 'dark', 'system'].includes(mode)) throw fail('Choose light, dark or system.');
      return { title: mode === 'system' ? 'Theme follows your device' : `${mode[0].toUpperCase()}${mode.slice(1)} mode`, client: { type: 'theme', mode } };
    },
  };

  /** Week offset (from this week) of a date, for linking to the right schedule page. */
  function weekOffset(date) {
    const monday = (d) => {
      const p = zonedParts(d, tz);
      const local = new Date(Date.UTC(p.year, p.month - 1, p.day));
      return local.getTime() - ((local.getUTCDay() + 6) % 7) * DAY;
    };
    return Math.round((monday(date) - monday(new Date())) / (7 * DAY));
  }

  /** Run one parsed action. Never throws: failures come back as { ok: false, error }. */
  function run(user, action) {
    const base = { name: action.name };
    if (action.error) return { ...base, ok: false, error: action.error };
    const fn = ACTIONS[action.name];
    if (!fn) return { ...base, ok: false, error: 'I cannot do that yet.' };
    try {
      const result = fn(user, action.args || {});
      if (action.name.startsWith('calendar.')) audit(user, 'assistant_action', `${action.name}: ${result.detail || ''}`.slice(0, 200));
      return { ...base, ok: true, ...result };
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) return { ...base, ok: false, error: error.message };
      console.error('Campus OS assistant action failed:', action.name, error);
      return { ...base, ok: false, error: 'Something went wrong while doing that.' };
    }
  }

  /** Reverse a stored result. The undo data was written by the server; the client only names which result. */
  function undo(user, result) {
    const u = result?.undo;
    if (!result?.ok || !u || result.undone) throw fail('There is nothing to undo.');
    if (u.op === 'delete') {
      personal(user, u.id);
      db.run('DELETE FROM timetable_events WHERE id = ?', u.id);
    } else if (u.op === 'restore') {
      personal(user, u.id);
      restoreRow(u.id, u.row);
    } else if (u.op === 'recreate') {
      timetable.insert(user, { ownerId: user.id }, { ...u.row, repeatWeeks: u.row.repeat_weeks });
    } else {
      throw fail('There is nothing to undo.');
    }
    audit(user, 'assistant_action_undone', result.name);
    return { ...result, undone: true };
  }

  /** What the browser gets: no internal undo data, just whether undo is possible. */
  const publicView = (result) => {
    const { undo: internal, ...rest } = result;
    return { ...rest, undoable: !!internal && !result.undone && result.ok };
  };

  return { run, undo, publicView, parseWhen };
}

module.exports = { createActionRunner };
