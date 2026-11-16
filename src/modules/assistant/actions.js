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
const { parseExamRows } = require('../timetable/exam-plan');
const { readPreferences, applyPreferences } = require('../account/preferences');
const { KINDS: QUIZ_KINDS } = require('../quiz/questions');
const { INTEREST_TAGS } = require('../account/routes');
const { CATEGORIES: POST_CATEGORIES } = require('../connect/routes');

const ERRORS = {
  when: 'I could not read that date and time.',
  mine: 'I can only change your own events. Open the schedule to change course or university events.',
  repeats: 'This event repeats every week. Change it in the schedule so the whole series moves correctly.',
};

/** Where "navigate" may go, by role. */
const PAGES = {
  home: '/home', map: '/campus/map', assistant: '/assistant', courses: '/courses', schedule: '/schedule', spaces: '/spaces', campus: '/campus', inbox: '/inbox', settings: '/settings', tools: '/tools', guide: '/campus/guide', profile: '/settings/profile', quiz: '/quiz', groups: '/groups',
};
const ROLE_PAGES = {
  student: { learning: '/learning', review: '/learning', participation: '/participation', career: '/career' },
  lecturer: { classroom: '/classroom', participation: '/participation' },
  admin: { people: '/admin/people', moderation: '/admin/moderation', ai: '/admin/ai', devices: '/admin/devices', institution: '/admin/institution', classroom: '/classroom', participation: '/participation' },
};
const ALIASES = { 'campus_map': 'map', maps: 'map', lageplan: 'map', campusplan: 'map', karte: 'map', calendar: 'schedule', timetable: 'schedule', notifications: 'inbox', messages: 'inbox', chat: 'assistant', learn: 'learning', study: 'learning', teaching: 'courses', events: 'campus', feed: 'campus', rooms: 'spaces', checkin: 'participation', 'check-in': 'participation', careers: 'career', all_tools: 'tools', features: 'tools', preferences: 'settings', account: 'settings', quizzes: 'quiz', quizze: 'quiz', tests: 'quiz', study_groups: 'groups', group: 'groups', lerngruppen: 'groups', lerngruppe: 'groups' };

function createActionRunner({ db, config, access, timetable, audit, studyGroups = null, campusPosts = null, programmes = null, now = () => new Date() }) {
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

  const yes = (v) => !(v === false || /^(false|off|no|aus|nein|0)$/i.test(String(v)));
  const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const courseByCode = (user, code) => {
    const c = db.get('SELECT id, code, title FROM courses WHERE institution_id = ? AND (UPPER(code) = UPPER(?) OR LOWER(title) = LOWER(?))', user.institution_id, String(code).trim(), String(code).trim());
    if (!c) throw fail('I could not find that course.');
    return c;
  };
  const contactLine = (m) => (m.name ? `${m.name} (${m.email})` : `a student${m.programme ? ` in ${m.programme}` : ''} who has not shared their contact`);
  const profileRow = (user) => {
    const p = db.get('SELECT programme, semester, interests FROM user_profiles WHERE user_id = ?', user.id);
    return { programme: p?.programme || '', semester: p?.semester ?? null, interests: p ? JSON.parse(p.interests) : [] };
  };
  const saveProfile = (user, p) => db.run(
    `INSERT INTO user_profiles(user_id, programme, semester, interests, updated) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET programme = excluded.programme, semester = excluded.semester, interests = excluded.interests, updated = excluded.updated`,
    user.id, p.programme, p.semester, JSON.stringify(p.interests), new Date().toISOString(),
  );
  const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  const ACTIONS = {
    /** Record that the user wants a study group and show who else wants one for the same subject. */
    'groups.seek'(user, a) {
      if (!studyGroups) throw fail('Study groups are not available here.');
      const courseId = a.course ? courseByCode(user, a.course).id : null;
      let r;
      try {
        r = studyGroups.seek(user, { subject: a.subject || a.course, note: a.note, courseId, shareContact: a.share_contact === undefined ? undefined : yes(a.share_contact) });
      } catch (error) {
        throw fail(error.message);
      }
      const found = r.matches.length
        ? `Also looking: ${r.matches.slice(0, 5).map(contactLine).join('; ')}`
        : 'Nobody else is looking yet. You will get a notification when someone is.';
      return {
        title: r.created ? `Looking for a study group: ${r.subject}` : `Study group request updated: ${r.subject}`,
        detail: `${found} · Your contact: ${r.shareContact ? `shared with matches (${user.email})` : 'not shared'}`,
        link: '/groups',
        undo: r.created ? { op: 'group_close', id: r.id } : { op: 'group_restore', id: r.id, before: r.before },
      };
    },

    /** Who is looking for a group for a subject, without recording anything. */
    'groups.find'(user, a) {
      if (!studyGroups) throw fail('Study groups are not available here.');
      const courseId = a.course ? courseByCode(user, a.course).id : null;
      const subject = oneLine(a.subject || a.course, 120);
      if (!subject) throw fail('Which subject is the group for?');
      const found = studyGroups.matches(user, subject, { courseId });
      return {
        title: `Study groups for ${subject}`,
        detail: found.length ? found.map((m) => `${contactLine(m)}${m.note ? `: ${m.note}` : ''}`).join('; ') : 'Nobody is looking for a group for this yet.',
        link: '/groups',
      };
    },

    'groups.stop'(user, a) {
      if (!studyGroups) throw fail('Study groups are not available here.');
      const r = studyGroups.close(user, { id: a.id, subject: a.subject });
      if (!r) throw fail('I could not find that study group request.');
      return { title: 'Study group request closed', detail: r.subject, link: '/groups', undo: { op: 'group_reopen', id: r.id } };
    },

    /** Keep a short fact for later conversations ("I work on Tuesdays", "my thesis is about batteries"). */
    'memory.save'(user, a) {
      const t = oneLine(a.text, 240);
      if (t.length < 3) throw fail('What should I remember?');
      const count = db.get('SELECT COUNT(*) n FROM assistant_memories WHERE user_id = ?', user.id).n;
      if (count >= 60) db.run('DELETE FROM assistant_memories WHERE id = (SELECT id FROM assistant_memories WHERE user_id = ? ORDER BY id LIMIT 1)', user.id);
      const id = db.insert('INSERT INTO assistant_memories(user_id, text, created) VALUES(?, ?, ?)', user.id, t, new Date().toISOString());
      return { title: 'Remembered', detail: t, undo: { op: 'memory_delete', id } };
    },

    'memory.forget'(user, a) {
      const row = db.get('SELECT * FROM assistant_memories WHERE id = ? AND user_id = ?', Number(a.id), user.id);
      if (!row) throw fail('I could not find that memory.');
      db.run('DELETE FROM assistant_memories WHERE id = ?', row.id);
      return { title: 'Forgotten', detail: row.text, undo: { op: 'memory_restore', row: { text: row.text, created: row.created } } };
    },

    /** Programme, semester and interests: what timetable answers and matching use. */
    'profile.update'(user, a) {
      const before = profileRow(user);
      const next = { ...before, interests: [...before.interests] };
      if (a.programme !== undefined) next.programme = oneLine(a.programme, 120);
      if (a.semester !== undefined) next.semester = a.semester === null || a.semester === '' ? null : Math.max(1, Math.min(20, Math.round(Number(a.semester)) || 1));
      const tags = (v) => (Array.isArray(v) ? v : [v]).map((t) => String(t).toLowerCase().trim()).filter((t) => INTEREST_TAGS.includes(t));
      if (a.interests !== undefined) next.interests = [...new Set(tags(a.interests))];
      if (a.add_interests !== undefined) next.interests = [...new Set([...next.interests, ...tags(a.add_interests)])];
      if (a.remove_interests !== undefined) next.interests = next.interests.filter((t) => !tags(a.remove_interests).includes(t));
      if (JSON.stringify(next) === JSON.stringify(before)) throw fail(`Tell me what to change. Interests can be: ${INTEREST_TAGS.join(', ')}.`);
      saveProfile(user, next);
      const parts = [];
      if (next.programme !== before.programme) parts.push(`Programme: ${next.programme || 'none'}`);
      if (next.semester !== before.semester) parts.push(`Semester: ${next.semester ?? 'none'}`);
      if (JSON.stringify(next.interests) !== JSON.stringify(before.interests)) parts.push(`Interests: ${next.interests.join(', ') || 'none'}`);
      return { title: 'Profile updated', detail: parts.join(' · '), link: '/settings/profile', undo: { op: 'profile', before } };
    },

    'course.enroll'(user, a) {
      if (user.role !== 'student') throw fail('Only students enrol in courses.');
      const c = courseByCode(user, a.course);
      if (db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND user_id = ?', c.id, user.id)) throw fail(`You are already enrolled in ${c.code}.`);
      db.run('INSERT INTO enrollments(course_id, user_id) VALUES(?, ?)', c.id, user.id);
      return { title: `Enrolled in ${c.code}`, detail: c.title, link: `/courses/${c.id}`, undo: { op: 'unenroll', id: c.id } };
    },

    'course.leave'(user, a) {
      const c = courseByCode(user, a.course);
      if (!db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND user_id = ?', c.id, user.id)) throw fail(`You are not enrolled in ${c.code}.`);
      db.run('DELETE FROM enrollments WHERE course_id = ? AND user_id = ?', c.id, user.id);
      return { title: `Left ${c.code}`, detail: c.title, undo: { op: 'enroll', id: c.id } };
    },

    /** A campus post written in chat; students' posts go to moderation like any other. */
    'campus.post'(user, a) {
      if (!campusPosts) throw fail('Posting is not available here.');
      const category = POST_CATEGORIES.includes(String(a.category)) && (a.category !== 'announcement' || user.role === 'admin') ? a.category : 'community';
      let r;
      try {
        r = campusPosts.create(user, { title: a.title, body: a.body, category, location: a.location, event_start: a.event_start ? parseWhen(a.event_start).toISOString() : undefined, link: a.link, tags: a.tags });
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) throw fail(error.message);
        throw error;
      }
      return { title: r.status === 'published' ? 'Posted to the campus feed' : 'Post sent for review', detail: `${r.title} · ${r.note}`, link: '/campus', undo: { op: 'post_remove', id: r.id } };
    },

    'campus.rsvp'(user, a) {
      const post = db.get("SELECT id, title FROM cx_posts WHERE id = ? AND institution_id = ? AND status = 'published' AND category = 'event'", Number(a.post), user.institution_id);
      if (!post) throw fail('I could not find that event.');
      const going = a.going === undefined ? true : yes(a.going);
      const was = !!db.get('SELECT 1 FROM cx_rsvps WHERE post_id = ? AND user_id = ?', post.id, user.id);
      if (going) db.run('INSERT OR IGNORE INTO cx_rsvps(post_id, user_id, created) VALUES(?, ?, ?)', post.id, user.id, new Date().toISOString());
      else db.run('DELETE FROM cx_rsvps WHERE post_id = ? AND user_id = ?', post.id, user.id);
      return { title: going ? 'You are going' : 'No longer going', detail: post.title, link: '/campus', undo: { op: 'rsvp', id: post.id, was } };
    },

    /** Campus notification level, topics and quiet hours. */
    'notifications.set'(user, a) {
      db.run('INSERT OR IGNORE INTO cx_preferences(user_id, updated) VALUES(?, ?)', user.id, new Date().toISOString());
      const row = db.get('SELECT level, topics, quiet_start, quiet_end FROM cx_preferences WHERE user_id = ?', user.id);
      const before = { ...row };
      let topics = JSON.parse(row.topics);
      const level = a.level === undefined ? row.level : String(a.level).toLowerCase();
      if (!['all', 'personalized', 'essential', 'digest'].includes(level)) throw fail('Level can be all, personalized, essential or digest.');
      const list = (v) => (Array.isArray(v) ? v : [v]).map(String).filter((t) => POST_CATEGORIES.includes(t));
      if (a.follow !== undefined) topics = [...new Set([...topics, ...list(a.follow)])];
      if (a.mute !== undefined) topics = topics.filter((t) => !list(a.mute).includes(t));
      const time = (v, old) => {
        if (v === undefined) return old;
        if (!TIME.test(String(v))) throw fail('Quiet hours look like 22:00.');
        return String(v);
      };
      const qs = time(a.quiet_start, row.quiet_start);
      const qe = time(a.quiet_end, row.quiet_end);
      db.run('UPDATE cx_preferences SET level = ?, topics = ?, quiet_start = ?, quiet_end = ?, updated = ? WHERE user_id = ?', level, JSON.stringify(topics), qs, qe, new Date().toISOString(), user.id);
      return { title: 'Notifications updated', detail: `Level: ${level} · Topics: ${topics.join(', ') || 'none'} · Quiet ${qs}–${qe}`, link: '/inbox', undo: { op: 'cx_prefs', before } };
    },

    'notifications.read'(user) {
      const n = db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', user.id).n;
      db.run('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0', user.id);
      return { title: 'Notifications marked as read', detail: `${n} ${n === 1 ? 'entry' : 'entries'}`, link: '/inbox' };
    },

    /** Feedback or a suggestion for the university's Citrus administrators. */
    'feedback.send'(user, a) {
      const message = oneLine(a.message, 2000);
      if (message.length < 5) throw fail('What would you like to tell the team?');
      db.run('INSERT INTO suggestions(institution_id, user_id, message, created) VALUES(?, ?, ?, ?)', user.institution_id, user.id, message, new Date().toISOString());
      return { title: 'Feedback sent', detail: message.slice(0, 140) };
    },

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

    /**
     * A programme's weekly class timetable for one semester, into the user's own calendar: every class on every
     * lecture day from today to the end of the lecture period, with lecture-free days left out. Times, rooms and
     * lecturers come from the printed timetable grid as the app parsed it (src/ai/lecture-plan.js), never from the
     * model. Classes split into groups are added only for the user's group; without one they are left out and named.
     */
    'calendar.classes'(user, a) {
      if (!programmes) throw fail('The university timetables are not available here.');
      const d = programmes.load();
      const profile = db.get('SELECT programme, semester FROM user_profiles WHERE user_id = ?', user.id) || {};
      const code = String(a.programme || programmes.fromProfile(profile.programme || '')[0] || '').toUpperCase().replace(/[^A-Z-]/g, '');
      if (!code) throw fail('Which programme are you in?');
      const semester = Number(a.semester || profile.semester);
      if (!Number.isInteger(semester) || semester < 1 || semester > 12) throw fail('Which semester are you in?');
      const own = d.timetables.filter((t) => (t.programme === code.replace(/-MA$/, '') || t.programmes.includes(code)) && t.semester === semester);
      if (!own.length) throw fail(`There is no printed ${code} timetable for semester ${semester}.`);
      const start = /^(SS|S|SUMMER|SOMMER)/i.test(String(a.start || '')) ? 'SS' : /^(WS|W|WINTER)/i.test(String(a.start || '')) ? 'WS' : '';
      const tt = start ? own.find((t) => t.term === start) : own.length === 1 ? own[0] : null;
      if (!tt) throw fail(start ? `There is no ${code} timetable for semester ${semester} with a ${start === 'SS' ? 'summer' : 'winter'} start.` : 'Did you start in the summer or the winter semester?');

      const groups = [...new Set(tt.entries.map((e) => e.group).filter(Boolean))];
      const group = String(a.group || '').toUpperCase().replace(/^(?:GROUP|GRUPPE|GR\.?)\s*/, '').trim();
      const roman = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' }[group] || group;
      const mine = groups.includes(roman) ? roman : '';
      const picked = tt.entries.filter((e) => !e.group || e.group === mine);
      const leftOut = [...new Set(tt.entries.filter((e) => e.group && e.group !== mine).map((e) => e.title))];

      const key = (x) => x.year * 10000 + x.month * 100 + x.day;
      const valid = tt.valid ? { day: +tt.valid.slice(0, 2), month: +tt.valid.slice(3, 5), year: +tt.valid.slice(6) } : null;
      const period = d.periods.find((p) => valid && key(valid) >= key(p.from) && key(valid) <= key(p.to));
      if (!period) throw fail('I could not find the lecture period this timetable belongs to.');
      const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const today = zonedParts(now(), tz);
      const from = Math.max(key(today), key(period.from));
      const label = `${code} semester ${semester} (${tt.term === 'SS' ? 'summer' : 'winter'} start)`;
      const ids = [];
      let existing = 0;
      db.transaction(() => {
        for (let t = Date.UTC(period.from.year, period.from.month - 1, period.from.day); ; t += DAY) {
          const day = new Date(t);
          const ymd = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
          if (key(ymd) > key(period.to) || ids.length >= 600) break;
          if (key(ymd) < from || period.free.some(([x, y]) => key(ymd) >= key(x) && key(ymd) <= key(y))) continue;
          for (const e of picked.filter((x) => x.day === DAY_NAMES[day.getUTCDay()])) {
            const stamp = `${ymd.year}${String(ymd.month).padStart(2, '0')}${String(ymd.day).padStart(2, '0')}`;
            const uid = `class:${tt.sourceId}:${code}${semester}${tt.term}:${stamp}:${e.start}:${e.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}:${e.group}`;
            if (db.get('SELECT 1 FROM timetable_events WHERE institution_id = ? AND external_uid = ? AND owner_id = ?', user.institution_id, uid, user.id)) {
              existing += 1;
              continue;
            }
            const startsAt = zonedToUtc({ ...ymd, hour: +e.start.slice(0, 2), minute: +e.start.slice(3) }, tz);
            const endsAt = zonedToUtc({ ...ymd, hour: +e.end.slice(0, 2), minute: +e.end.slice(3) }, tz);
            const notes = [e.lecturer && `Lecturer: ${e.lecturer}`, e.mode, `From the printed ${label} timetable, valid from ${tt.valid}. Late changes are not included.`].filter(Boolean).join('. ').slice(0, 1000);
            ids.push(db.insert(
              `INSERT INTO timetable_events(institution_id, course_id, owner_id, title, kind, location, notes, starts, ends, repeat_weeks, until, source, external_uid, created_by, created)
               VALUES(?, NULL, ?, ?, 'lecture', ?, ?, ?, ?, 0, NULL, 'plan', ?, ?, ?)`,
              user.institution_id, user.id, `${e.title}${e.group ? ` (group ${e.group})` : ''}`.slice(0, 120), e.room || null, notes,
              startsAt.toISOString(), endsAt.toISOString(), uid, user.id, new Date().toISOString(),
            ));
          }
        }
      });
      if (!ids.length && !existing) throw fail(`The ${label} timetable has no classes left this lecture period.`);
      const until = `${period.to.day}.${period.to.month}.${period.to.year}`;
      return {
        title: ids.length ? `Added your ${code} classes to your calendar` : `Your ${code} classes are already there`,
        detail: `${picked.length} weekly classes, ${ids.length} dates until ${until}${existing ? `, ${existing} already there` : ''} · lecture-free days skipped`,
        warning: leftOut.length ? `Not added because they are split into groups (${groups.join(', ')}): ${leftOut.join(', ')}. Tell me your group to add them.` : undefined,
        link: '/schedule',
        undo: ids.length ? { op: 'delete_many', ids } : undefined,
      };
    },

    /**
     * All exam dates of a programme, read from the exam plan in the knowledge library (not by the model, so dates and
     * times are exactly as printed). Into the user's own calendar, or into a course the user teaches.
     */
    'calendar.import'(user, a) {
      const programme = String(a.programme || '').toUpperCase().replace(/[^A-Z]/g, '');
      const SOURCES = { DTM: 'CAMPUS_PDF_02', IIE: 'CAMPUS_PDF_03' };
      if (!SOURCES[programme]) throw fail('I have exam plans for DTM and IIE. Which programme do you mean?');
      const pages = db.all('SELECT title, content FROM institution_knowledge WHERE institution_id = ? AND tags = ? ORDER BY title', user.institution_id, SOURCES[programme]);
      if (!pages.length) throw fail('The exam plan is not in the knowledge library yet. An administrator can import it under Admin, AI.');
      const rows = pages.flatMap((pg) => parseExamRows(pg.content));
      if (!rows.length) throw fail('I could not read any exam dates from the plan.');

      let courseId = null;
      let course = null;
      if (a.course) {
        course = db.get('SELECT id, code, title FROM courses WHERE institution_id = ? AND UPPER(code) = UPPER(?)', user.institution_id, String(a.course).trim());
        if (!course) throw fail('I could not find that course.');
        if (!access.teachingCourse(user, course.id)) throw fail('Only the lecturer of a course can add events to it.');
        courseId = course.id;
      }
      const ownerId = courseId ? null : user.id;
      const ids = [];
      let existing = 0;
      let past = 0;
      db.transaction(() => {
        for (const r of rows) {
          const start = zonedToUtc({ year: r.year, month: r.month, day: r.day, hour: +r.time.slice(0, 2), minute: +r.time.slice(3) }, tz);
          const end = new Date(start.getTime() + r.minutes * 60_000);
          const uid = `exam:${SOURCES[programme]}:${r.year}${String(r.month).padStart(2, '0')}${String(r.day).padStart(2, '0')}:${r.module.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
          if (db.get('SELECT 1 FROM timetable_events WHERE institution_id = ? AND external_uid = ? AND COALESCE(course_id, 0) = ? AND COALESCE(owner_id, 0) = ?', user.institution_id, uid, courseId || 0, ownerId || 0)) {
            existing += 1;
            continue;
          }
          if (end.getTime() < Date.now()) past += 1;
          const notes = [r.examiner && `Examiner: ${r.examiner}`, r.aids && `Aids: ${r.aids}`, 'From the university exam plan (Sommersemester 2026). Check the original for the exact room.'].filter(Boolean).join('. ').slice(0, 1000);
          ids.push(db.insert(
            `INSERT INTO timetable_events(institution_id, course_id, owner_id, title, kind, location, notes, starts, ends, repeat_weeks, until, source, external_uid, created_by, created)
             VALUES(?, ?, ?, ?, 'exam', ?, ?, ?, ?, 0, NULL, 'plan', ?, ?, ?)`,
            user.institution_id, courseId, ownerId, `${r.module} (exam)`.slice(0, 120), r.room, notes, start.toISOString(), end.toISOString(), uid, user.id, new Date().toISOString(),
          ));
        }
      });
      if (!ids.length && !existing) throw fail('Nothing to add.');
      return {
        title: ids.length ? `Added ${ids.length} ${programme} exams to ${course ? course.code : 'your calendar'}` : `Your ${programme} exams are already there`,
        detail: `${ids.length} added${existing ? `, ${existing} already there` : ''} · dates and times as printed in the plan`,
        warning: past && past === ids.length ? 'These are the Sommersemester 2026 exam dates and they have already passed.' : undefined,
        link: '/schedule',
        undo: ids.length ? { op: 'delete_many', ids } : undefined,
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
      if (path === '/campus/map' && a.place) path = `/campus/map?to=${encodeURIComponent(String(a.place).slice(0, 40))}`;
      return { title: `Opening ${label.replace(/_/g, ' ')}`, client: { type: 'navigate', path } };
    },

    /**
     * Settings the person asks for in chat. Account settings are saved here (and can be undone); settings that belong
     * to the device they are using (voice speed, voice, read-aloud) are sent to the browser to apply.
     */
    'settings.update'(user, a) {
      const yes = (v) => !(v === false || /^(false|off|no|aus|nein|0)$/i.test(String(v)));
      const word = (v) => String(v ?? '').trim().toLowerCase();
      const input = {};
      if (a.assistant_name !== undefined) input.assistantName = /^(reset|default|standard|campus)$/i.test(String(a.assistant_name).trim()) ? '' : a.assistant_name;
      if (a.language !== undefined) input.language = /^(de|deutsch|german|germany)/.test(word(a.language)) ? 'de' : /^(en|english|englisch)/.test(word(a.language)) ? 'en' : a.language;
      if (a.answer_language !== undefined) input.answerLanguage = /^(de|deutsch|german)/.test(word(a.answer_language)) ? 'de' : /^(en|english|englisch)/.test(word(a.answer_language)) ? 'en' : /^(match|auto|both|same|beide)/.test(word(a.answer_language)) ? 'match' : a.answer_language;
      if (a.speech_language !== undefined) input.speechLanguage = /^(de|deutsch|german)/.test(word(a.speech_language)) ? 'de' : /^(en|english|englisch)/.test(word(a.speech_language)) ? 'en' : /^(auto|both|beide|automatic)/.test(word(a.speech_language)) ? 'auto' : a.speech_language;
      if (a.wake_word !== undefined) input.voiceWake = yes(a.wake_word);
      if (a.animations !== undefined) input.visuals = yes(a.animations);
      if (a.opportunity_matching !== undefined) input.matching = yes(a.opportunity_matching);
      if (a.theme !== undefined) input.theme = word(a.theme);

      const device = {};
      if (a.voice_speed !== undefined) {
        const s = word(a.voice_speed);
        const n = Number(s);
        if (/^(slower|slow|langsamer)/.test(s)) device.voiceSpeed = 'slower';
        else if (/^(faster|fast|quicker|schneller)/.test(s)) device.voiceSpeed = 'faster';
        else if (/^(normal|default|standard)/.test(s)) device.voiceSpeed = 1;
        else if (Number.isFinite(n) && n >= 0.5 && n <= 2) device.voiceSpeed = n;
        else throw fail('Voice speed can be slower, faster, normal or a number from 0.5 to 2.');
      }
      if (a.voice_style !== undefined) {
        if (!['natural', 'calm', 'bright', 'deep', 'quick'].includes(word(a.voice_style))) throw fail('Voice style can be natural, calm, bright, deep or quick.');
        device.voiceStyle = word(a.voice_style);
      }
      if (a.voice_gender !== undefined) {
        const g = word(a.voice_gender);
        device.voiceGender = /^(f|female|weiblich|woman|frau)/.test(g) ? 'female' : /^(m|male|männlich|maennlich|man|mann)/.test(g) ? 'male' : 'any';
      }
      if (a.read_aloud !== undefined) {
        if (!['spoken', 'always', 'never'].includes(word(a.read_aloud))) throw fail('Read aloud can be spoken, always or never.');
        device.readAloud = word(a.read_aloud);
      }

      const changes = readPreferences(input);
      if (!Object.keys(changes).length && !Object.keys(device).length) throw fail('Tell me which setting to change.');
      const current = JSON.parse(db.get('SELECT preferences FROM users WHERE id = ?', user.id)?.preferences || '{}');
      const before = Object.fromEntries(Object.keys(changes).map((k) => [k, current[k] ?? null]));
      const next = applyPreferences(current, changes);
      if (Object.keys(changes).length) db.run('UPDATE users SET preferences = ? WHERE id = ?', JSON.stringify(next), user.id);

      const parts = [];
      if ('assistantName' in changes) parts.push(changes.assistantName ? `Name: ${changes.assistantName}` : 'Name: back to the default');
      if (changes.language) parts.push(`Language: ${changes.language === 'de' ? 'Deutsch' : 'English'}`);
      if ('answerLanguage' in changes) parts.push(`Answers in: ${{ de: 'Deutsch', en: 'English' }[changes.answerLanguage] || 'the language you write'}`);
      if (changes.speechLanguage) parts.push(`Speech recognition: ${{ auto: 'automatic', en: 'English', de: 'Deutsch' }[changes.speechLanguage]}`);
      if ('voiceWake' in changes) parts.push(`Listening for the name: ${changes.voiceWake ? 'on' : 'off'}`);
      if ('visuals' in changes) parts.push(`Animated explanations: ${changes.visuals ? 'on' : 'off'}`);
      if ('matching' in changes) parts.push(`Opportunity matching: ${changes.matching ? 'on' : 'off'}`);
      if (changes.theme) parts.push(`Theme: ${changes.theme}`);
      if (device.voiceSpeed !== undefined) parts.push(`Voice speed: ${typeof device.voiceSpeed === 'number' ? device.voiceSpeed : device.voiceSpeed}`);
      if (device.voiceStyle) parts.push(`Voice style: ${device.voiceStyle}`);
      if (device.voiceGender) parts.push(`Voice: ${device.voiceGender === 'any' ? 'automatic' : device.voiceGender}`);
      if (device.readAloud) parts.push(`Read aloud: ${{ spoken: 'when I speak', always: 'every answer', never: 'never' }[device.readAloud]}`);
      return {
        title: 'Settings updated',
        detail: parts.join(' · '),
        client: { type: 'settings', prefs: next, device },
        ...(Object.keys(changes).length ? { undo: { op: 'prefs', before } } : {}),
      };
    },

    /**
     * Open one of the university's own pages or documents in a new tab. Only https links on the university's
     * domain, and on the sites its edition lists (the application portal, Moodle), are accepted, so text in a
     * document can never send someone anywhere else.
     */
    'link.open'(user, a) {
      let url;
      try {
        url = new URL(String(a.url || '').trim());
      } catch {
        throw fail('That is not a link I can open.');
      }
      const host = url.hostname.toLowerCase();
      const listed = (config.site.links || []).some((l) => {
        try {
          return new URL(l.url).hostname.toLowerCase() === host;
        } catch {
          return false;
        }
      });
      if (url.protocol !== 'https:' || url.username || url.password || !(host === 'oth-aw.de' || host.endsWith('.oth-aw.de') || listed)) {
        throw fail('I can only open links to the university’s own pages.');
      }
      const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 100) || `${host}${url.pathname}`.slice(0, 100);
      return { title: 'Opening the page', detail: title, link: url.toString(), client: { type: 'open', url: url.toString() } };
    },

    /** Opens the Quizzes tool on a new quiz; the page makes the questions (src/modules/quiz). */
    'quiz.start'(user, a) {
      const topic = String(a.topic || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      let course = null;
      if (a.course) {
        course = db.get('SELECT id, code FROM courses WHERE institution_id = ? AND UPPER(code) = UPPER(?)', user.institution_id, String(a.course).trim());
        if (!course || !access.course(user, course.id)) throw fail('I could not find that course.');
      }
      if (!topic && !course) throw fail('What should the quiz be about?');
      const count = Math.min(15, Math.max(3, Math.round(Number(a.count) || 6)));
      const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(String(a.difficulty)) ? String(a.difficulty) : 'mixed';
      const types = (Array.isArray(a.types) ? a.types : []).map(String).filter((t) => QUIZ_KINDS.includes(t));
      const query = new URLSearchParams({ topic, count: String(count), difficulty, ...(types.length ? { types: [...new Set(types)].join(',') } : {}), ...(course ? { course: String(course.id) } : {}) });
      const path = `/quiz/new?${query}`;
      return { title: `Quiz: ${topic || course.code}`, detail: `${count} questions · ${difficulty}`, link: path, client: { type: 'navigate', path } };
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
      if (!['app.navigate', 'app.theme', 'link.open', 'quiz.start', 'groups.find'].includes(action.name)) audit(user, 'assistant_action', `${action.name}: ${result.detail || ''}`.slice(0, 200));
      return { ...base, ok: true, ...result };
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) return { ...base, ok: false, error: error.message };
      console.error('Citrus assistant action failed:', action.name, error);
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
    } else if (u.op === 'delete_many') {
      for (const eventId of u.ids || []) db.run('DELETE FROM timetable_events WHERE id = ? AND institution_id = ? AND created_by = ?', Number(eventId), user.institution_id, user.id);
    } else if (u.op === 'restore') {
      personal(user, u.id);
      restoreRow(u.id, u.row);
    } else if (u.op === 'prefs') {
      const current = JSON.parse(db.get('SELECT preferences FROM users WHERE id = ?', user.id)?.preferences || '{}');
      const restored = applyPreferences(current, u.before);
      db.run('UPDATE users SET preferences = ? WHERE id = ?', JSON.stringify(restored), user.id);
      audit(user, 'assistant_action_undone', result.name);
      return { ...result, undone: true, client: { type: 'settings', prefs: restored, device: {} } };
    } else if (u.op === 'group_close') {
      studyGroups.close(user, { id: u.id });
    } else if (u.op === 'group_reopen') {
      studyGroups.reopen(user, u.id);
    } else if (u.op === 'group_restore') {
      studyGroups.restore(user, u.id, u.before);
    } else if (u.op === 'memory_delete') {
      db.run('DELETE FROM assistant_memories WHERE id = ? AND user_id = ?', u.id, user.id);
    } else if (u.op === 'memory_restore') {
      db.run('INSERT INTO assistant_memories(user_id, text, created) VALUES(?, ?, ?)', user.id, u.row.text, u.row.created);
    } else if (u.op === 'profile') {
      saveProfile(user, u.before);
    } else if (u.op === 'unenroll') {
      db.run('DELETE FROM enrollments WHERE course_id = ? AND user_id = ?', u.id, user.id);
    } else if (u.op === 'enroll') {
      db.run('INSERT OR IGNORE INTO enrollments(course_id, user_id) VALUES(?, ?)', u.id, user.id);
    } else if (u.op === 'post_remove') {
      db.run("UPDATE cx_posts SET status = 'removed' WHERE id = ? AND author_id = ?", u.id, user.id);
    } else if (u.op === 'rsvp') {
      if (u.was) db.run('INSERT OR IGNORE INTO cx_rsvps(post_id, user_id, created) VALUES(?, ?, ?)', u.id, user.id, new Date().toISOString());
      else db.run('DELETE FROM cx_rsvps WHERE post_id = ? AND user_id = ?', u.id, user.id);
    } else if (u.op === 'cx_prefs') {
      db.run('UPDATE cx_preferences SET level = ?, topics = ?, quiet_start = ?, quiet_end = ? WHERE user_id = ?', u.before.level, u.before.topics, u.before.quiet_start, u.before.quiet_end, user.id);
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
