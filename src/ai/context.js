'use strict';
/**
 * Builds the "CONTEXT" block for the personal assistant from the user's OWN
 * Campus OS data only, so questions like "what should I do tonight?" or "am I ready
 * for the exam?" can be answered without the user explaining who they are.
 *
 * Add a section by adding a function to SECTIONS: each takes (user, shared) and
 * returns a short string or ''. `shared.events` is the user's next 14 days, read once.
 * Nothing here is invented: a deadline or exam shows up only if it is in the schedule.
 */
const { zonedToUtc, zonedParts, DAY } = require('../lib/time');

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const MIN_FREE_MINUTES = 45;

function createContextBuilder({ db, timetable, timeZone, programmes = null }) {
  const fmt = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(new Date(iso));
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hhmm = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });

  /** Whole local days from today to the day of `iso`. */
  const daysAway = (iso) => Math.round((Date.parse(ymd(new Date(iso))) - Date.parse(ymd(new Date()))) / DAY);
  const when = (iso) => {
    const n = daysAway(iso);
    return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? `${-n} days ago` : `in ${n} days`;
  };
  const span = (ms) => {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    return minutes % 60 ? `${h} h ${minutes % 60} min` : `${h} h`;
  };
  const place = (e) => (e.location ? ` @ ${e.location}` : '');
  const courseTag = (e) => (e.course ? ` [${e.course.code}]` : '');

  const SECTIONS = [
    function clock() {
      const now = new Date().toISOString();
      const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(Date.now() + i * DAY);
        return `${fmt(d, { weekday: 'short' })} ${ymd(d)}${i === 0 ? ' (today)' : ''}`;
      });
      return [
        `Now: ${fmt(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${hhmm(now)} (${timeZone})`,
        `Dates (${timeZone}): ${days.join(', ')}`,
      ].join('\n');
    },

    function profile(user) {
      const p = db.get('SELECT p.programme, p.semester, p.interests FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.institution_id = ?', user.id, user.institution_id);
      const bits = [`Role: ${user.role}`];
      if (p?.programme) bits.push(`Programme: ${p.programme}${p.semester ? `, semester ${p.semester}` : ''}`);
      const interests = p ? JSON.parse(p.interests) : [];
      if (interests.length) bits.push(`Interests: ${interests.join(', ')}`);
      return bits.join(' · ');
    },

    /**
     * The university's published class timetable for the user's programme, taken from their profile or from what
     * they said in this conversation ("I'm in DTM"). It is how "what lecture do I have right now?" is answered
     * without any further context.
     */
    function programme(user, shared) {
      if (!programmes) return '';
      const profile = db.get('SELECT programme, semester FROM user_profiles WHERE user_id = ?', user.id);
      const said = shared.extras.query || '';
      let codes = programmes.mentioned(said);
      const own = profile?.programme ? programmes.fromProfile(profile.programme) : [];
      if (!codes.length) codes = own;
      if (!codes.length) {
        return `Official class timetables (from the university's PDFs) exist for these programme codes: ${programmes.programmes().map((p) => p.code).join(', ')}. When the user says which programme they study (or asks about their classes), their timetable appears here; if you do not know it yet, ask which programme in one short question, then use it.`;
      }
      const semester = programmes.semesterIn(said) || (codes.some((c) => own.includes(c)) ? profile?.semester ?? null : null);
      return programmes.describe({ codes, semester, now: new Date() }).join('\n');
    },

    /** Where the user is in their day: in class, or how long until the next one. */
    function rightNow(user, shared) {
      const now = Date.now();
      const current = shared.events.filter((e) => Date.parse(e.starts) <= now && Date.parse(e.ends) > now);
      const next = shared.events.find((e) => Date.parse(e.starts) > now);
      const lines = [];
      if (current.length) lines.push(`Right now: ${current.map((e) => `${e.title}${courseTag(e)}${place(e)} until ${hhmm(e.ends)}`).join('; ')}`);
      else lines.push('Right now: nothing scheduled');
      if (next) lines.push(`Next up: ${next.title}${courseTag(next)} ${when(next.starts)} at ${hhmm(next.starts)}${place(next)} (in ${span(Date.parse(next.starts) - now)})`);
      return lines.join('\n');
    },

    function courses(user, shared) {
      const rows = user.role === 'student'
        ? db.all('SELECT c.id, c.code, c.title, l.name AS lecturer FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN users l ON l.id = c.lecturer_id WHERE e.user_id = ? AND c.institution_id = ? ORDER BY c.code LIMIT 20', user.id, user.institution_id)
        : db.all("SELECT c.id, c.code, c.title, NULL AS lecturer FROM courses c WHERE c.institution_id = ? AND (c.lecturer_id = ? OR ? = 'admin') ORDER BY c.code LIMIT 20", user.institution_id, user.id, user.role);
      if (!rows.length) return '';
      const line = (c) => {
        const next = shared.events.find((e) => e.course?.id === c.id && Date.parse(e.ends) > Date.now());
        return `- ${c.code} ${c.title}${c.lecturer ? `, lecturer ${c.lecturer}` : ''}${next ? `; next: ${next.title} ${when(next.starts)} ${hhmm(next.starts)}` : ''}`;
      };
      return `${user.role === 'student' ? 'Enrolled courses' : 'Courses you teach/manage'}:\n${rows.map(line).join('\n')}`;
    },

    /** Exams and deadlines for the next two months, shown separately so a busy week cannot push them out. */
    function deadlines(user) {
      const now = Date.now();
      const rows = timetable.between(user, new Date(now).toISOString(), new Date(now + 60 * DAY).toISOString())
        .filter((e) => (e.kind === 'deadline' || e.kind === 'exam') && Date.parse(e.ends) > now)
        .slice(0, 12);
      if (!rows.length) return 'Exams and deadlines (next 60 days): none in Campus OS. Assignments the university has not entered here are unknown to you.';
      return `Exams and deadlines (next 60 days):\n${rows.map((e) => `- ${e.kind === 'exam' ? 'Exam' : 'Due'}: ${e.title}${courseTag(e)}, ${dayLabel(e.starts)} ${hhmm(e.starts)} (${when(e.starts)})${e.scope === 'personal' ? ` [id ${e.id}]` : ''}`).join('\n')}`;
    },

    function schedule(user, shared) {
      const events = shared.events.filter((e) => Date.parse(e.ends) > Date.now()).slice(0, 22);
      if (!events.length) return 'Upcoming schedule (14 days): nothing in Campus OS';
      // Only the user's own events carry an id: those are the ones the assistant may change.
      const line = (e) => `- ${e.scope === 'personal' ? `[id ${e.id}] ` : ''}${dayLabel(e.starts)} ${hhmm(e.starts)}–${hhmm(e.ends)} ${e.title}${courseTag(e)}${place(e)}${e.recurring ? ' (repeats weekly)' : ''}`;
      return `Upcoming schedule (14 days):\n${events.map(line).join('\n')}`;
    },

    /** Open stretches in the next three days, for "when can I study?" and planning. */
    function freeTime(user, shared) {
      const out = [];
      for (let i = 0; i < 3; i++) {
        const day = new Date(Date.now() + i * DAY);
        const p = zonedParts(day, timeZone);
        const from = Math.max(zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: DAY_START_HOUR }, timeZone).getTime(), Date.now());
        const to = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: DAY_END_HOUR }, timeZone).getTime();
        if (to - from < MIN_FREE_MINUTES * 60_000) continue;
        const busy = shared.events.map((e) => [Date.parse(e.starts), Date.parse(e.ends)]).filter(([s, e]) => e > from && s < to).sort((a, b) => a[0] - b[0]);
        const gaps = [];
        let cursor = from;
        for (const [s, e] of busy) {
          if (s - cursor >= MIN_FREE_MINUTES * 60_000) gaps.push([cursor, s]);
          cursor = Math.max(cursor, e);
        }
        if (to - cursor >= MIN_FREE_MINUTES * 60_000) gaps.push([cursor, to]);
        if (gaps.length) out.push(`${i === 0 ? 'today' : i === 1 ? 'tomorrow' : dayLabel(day)}: ${gaps.slice(0, 4).map(([s, e]) => `${hhmm(new Date(s).toISOString())}–${hhmm(new Date(e).toISOString())}`).join(', ')}`);
      }
      return out.length ? `Free time between ${DAY_START_HOUR}:00 and ${DAY_END_HOUR}:00 (from the schedule): ${out.join('; ')}` : '';
    },

    function difficulties(user) {
      if (user.role !== 'student') return '';
      const rows = db.all(
        `SELECT t.title, c.code FROM responses r JOIN topics t ON t.id = r.topic_id JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id
         WHERE r.user_id = ? AND c.institution_id = ? AND r.level < 3 AND EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = r.user_id AND e.course_id = c.id) ORDER BY r.created DESC LIMIT 8`, user.id, user.institution_id,
      );
      return rows.length ? `Topics the user marked as not yet understood: ${rows.map((r) => `${r.title} (${r.code})`).join('; ')}` : '';
    },

    /** For lecturers: how the latest sessions went, as counts only. */
    function classroom(user) {
      if (user.role === 'student') return '';
      const rows = db.all(
        `SELECT c.code, l.topic AS lecture, t.title,
                SUM(CASE WHEN r.level = 1 THEN 1 ELSE 0 END) AS lost, SUM(CASE WHEN r.level = 2 THEN 1 ELSE 0 END) AS partly, SUM(CASE WHEN r.level = 3 THEN 1 ELSE 0 END) AS clear
         FROM topics t JOIN lectures l ON l.id = t.lecture_id JOIN courses c ON c.id = l.course_id LEFT JOIN responses r ON r.topic_id = t.id
         WHERE c.institution_id = ? AND (c.lecturer_id = ? OR ? = 'admin') AND l.created > ?
         GROUP BY t.id HAVING lost + partly + clear > 0 ORDER BY lost DESC, partly DESC LIMIT 6`,
        user.institution_id, user.id, user.role, new Date(Date.now() - 21 * DAY).toISOString(),
      );
      return rows.length ? `How recent topics landed (student self-ratings, counts):\n${rows.map((r) => `- ${r.code} ${r.title}: ${r.lost} lost, ${r.partly} partly, ${r.clear} clear`).join('\n')}` : '';
    },

    function review(user) {
      const due = db.get('SELECT COUNT(*) n FROM review_items r JOIN users u ON u.id = r.user_id LEFT JOIN courses c ON c.id = r.course_id WHERE r.user_id = ? AND u.institution_id = ? AND (r.course_id IS NULL OR c.institution_id = u.institution_id) AND r.due <= ?', user.id, user.institution_id, new Date().toISOString()).n;
      return due ? `Review items due now: ${due}` : '';
    },

    /** What was said in the user's own lectures lately, so "explain what the lecturer just said" has something to go on. */
    function lectures(user) {
      const since = new Date(Date.now() - 10 * DAY).toISOString();
      const rows = db.all(
        `SELECT i.id, i.title, i.body, i.kind, w.title AS space,
                EXISTS(SELECT 1 FROM lecture_insight_marks m WHERE m.insight_id = i.id AND m.user_id = ? AND m.mark = 'saved') AS saved
         FROM lecture_insights i JOIN workspaces w ON w.id = i.workspace_id
         WHERE w.institution_id = ? AND w.archived = 0 AND i.created > ?
           AND (w.creator_id = ? OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = ?))
         ORDER BY saved DESC, i.importance DESC, i.id DESC LIMIT 10`,
        user.id, user.institution_id, since, user.id, user.id,
      );
      if (!rows.length) return '';
      return `Key points captured in the user's recent lectures (from live captions, may contain recognition errors):\n${rows.map((r) => `- [${r.space}] ${r.title}${r.body ? `: ${r.body}` : ''}`).join('\n')}`;
    },

    /** Shared spaces the user is in, and any that are live right now. */
    function spaces(user) {
      const rows = db.all(
        `SELECT w.title, w.kind, w.live FROM workspaces w
         WHERE w.institution_id = ? AND w.archived = 0 AND (w.creator_id = ? OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ?))
         ORDER BY w.live DESC, w.id DESC LIMIT 6`,
        user.institution_id, user.id, user.id,
      );
      return rows.length ? `Spaces: ${rows.map((w) => `${w.title} (${w.kind}${w.live ? ', live now' : ''})`).join('; ')}` : '';
    },

    function unread(user) {
      const n = db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', user.id).n;
      return n ? `Unread notifications: ${n}` : '';
    },

    /** What the person can change by asking, and what it is now, so "make it faster" or "call yourself Claudia" needs no setup. */
    function settings(user, shared) {
      const p = user.preferences || {};
      const d = shared.extras.device || {};
      const bits = [
        `assistant name "${shared.extras.assistantName || 'Campus'}"`,
        `interface language ${p.language === 'de' ? 'German' : p.language === 'en' ? 'English' : 'not chosen (follows the browser)'}`,
        `speech recognition ${{ de: 'German', en: 'English' }[p.speechLanguage] || 'automatic (English or German)'}`,
        `listening for the assistant's name ${p.voiceWake ? 'on' : 'off'}`,
        `animated explanations ${p.visuals === false ? 'off' : 'on'}`,
        `opportunity matching ${p.matching === false ? 'off' : 'on'}`,
        `theme ${p.theme || 'system'}`,
      ];
      if (d.voiceRate) bits.push(`voice speed ${d.voiceRate} (1 is normal)`);
      if (d.voiceStyle) bits.push(`voice style ${d.voiceStyle}`);
      if (d.voiceGender) bits.push(`voice ${d.voiceGender === 'any' ? 'automatic' : d.voiceGender}`);
      if (d.readAloud) bits.push(`read aloud: ${{ spoken: 'when the user speaks', always: 'every answer', never: 'never' }[d.readAloud]}`);
      return `Current settings (change them with settings.update when asked): ${bits.join('; ')}`;
    },

    /** Titles of the latest conversations, so "like we talked about before" has something to go on. */
    function recent(user) {
      const rows = db.all('SELECT title FROM assistant_threads WHERE user_id = ? ORDER BY updated DESC LIMIT 5', user.id);
      return rows.length ? `Recent conversations: ${rows.map((r) => r.title).join('; ')}` : '';
    },
  ];

  return function build(user, extras = {}) {
    let events = null;
    const shared = {
      extras,
      get events() {
        if (!events) events = timetable.upcoming(user, { days: 14, limit: 120 });
        return events;
      },
    };
    return SECTIONS.map((section) => {
      try {
        return section(user, shared);
      } catch {
        return '';
      }
    }).filter(Boolean).join('\n');
  };
}

module.exports = { createContextBuilder };
