'use strict';
/**
 * Weekly lecture timetables read from the printed grid, so the assistant never has to interpret column layout.
 *
 * The university's timetable PDFs (Untis) come with the drawn region of every cell: its box on the page and its text.
 * The day is the column the box sits in and the time is the row band it covers, so a lesson is simply read off:
 *   box x in the "Di" column, y from the 17:30 row to the end of the 19:00 row  ->  Tuesday 17:30-19:00.
 * Nothing is guessed; a cell that cannot be placed is left out.
 */
const { zonedParts, zonedToUtc } = require('../lib/time');

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HEADER = /([A-Z]{2,6}),\s*(BA|MA),\s*Sem\.\s*(\d+),\s*S(?:tart|art)\s+(WS|SS)/;
const GROUP = /^[A-Z]{2,6}-[A-Z]{2,5}-Gr\s*([IVX]+|\d+)$/;
const ROOM = /^(?:(?:HSG|EH|WTC|FOS|GE|MF|DBC)\s?[\d.]*|\d{2,3}[A-Za-z]?|[A-Z]{1,3}\s?\d[\d.]*)(?:\s+(Hybrid|Online|In Presence))?$/;
const TITLE_FIXES = { 'English for Acade': 'English for Academic Purposes' };

const regionsOf = (pageText) => [...String(pageText).matchAll(/^\{"bbox": \[([^\]]+)\], "text": "((?:[^"\\]|\\.)*)"\}$/gm)].map((m) => {
  const [x0, y0, x1, y1] = m[1].split(',').map(Number);
  return { x0, y0, x1, y1, text: JSON.parse(`"${m[2]}"`) };
});

/** One timetable page -> { programme, semester, term, entries[] } or null when the page is not a timetable grid. */
function parsePage(pageText) {
  const head = HEADER.exec(pageText);
  if (!head) return null;
  const regions = regionsOf(pageText);
  const dayCols = DAYS.map((d) => regions.find((r) => r.text === d && r.y1 < 105)).map((r, i) => (r ? { name: DAY_NAMES[i], x0: r.x0, x1: r.x1 } : null));
  const rows = regions
    .filter((r) => r.x1 < 90 && /^\d{1,2}:\d{2}\s+\d\s*\/\s*\d{1,2}:\d{2}$/.test(r.text))
    .map((r) => { const m = /^(\d{1,2}:\d{2})\s+\d\s*\/\s*(\d{1,2}:\d{2})$/.exec(r.text); return { y0: r.y0, y1: r.y1, start: m[1].padStart(5, '0'), end: m[2].padStart(5, '0') }; })
    .sort((a, b) => a.y0 - b.y0);
  if (!dayCols.some(Boolean) || !rows.length) return null;
  const rowAt = (y) => rows.find((r) => y >= r.y0 - 1 && y <= r.y1 + 1);

  const entries = [];
  for (const r of regions) {
    if (r.x0 < 84 || r.y0 < 100 || DAYS.includes(r.text)) continue;
    const cx = (r.x0 + r.x1) / 2;
    const day = dayCols.find((d) => d && cx >= d.x0 && cx < d.x1);
    const first = rowAt(r.y0 + 2);
    const last = rowAt(Math.min(r.y1 - 2, rows.at(-1).y1));
    if (!day || !first || !last) continue;
    const parts = r.text.split(/\s+\/\s+/).map((p) => p.trim()).filter(Boolean);
    if (/^first-year/i.test(parts[0])) continue;
    let group = '';
    let room = '';
    let mode = '';
    const title = [];
    const rest = [];
    for (const p of parts) {
      const g = GROUP.exec(p);
      const rm = ROOM.exec(p);
      if (g) group = g[1];
      else if (rm && title.length) { room = p.replace(/\s+(Hybrid|Online|In Presence)$/, ''); mode = rm[1] || ''; }
      else if (!room && !group) title.push(p);
      else rest.push(p);
    }
    const lecturer = rest.at(-1) || '';
    const name = TITLE_FIXES[title.join(' ')] || title.join(' ');
    if (!name) continue;
    entries.push({ day: day.name, start: first.start, end: last.end, title: name, group, room, mode, lecturer });
  }
  entries.sort((a, b) => DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day) || a.start.localeCompare(b.start) || a.group.localeCompare(b.group));
  return { programme: head[1], level: head[2], semester: Number(head[3]), term: head[4], entries, valid: /Gültig ab:\s*(\d{2}\.\d{2}\.\d{4})/.exec(pageText)?.[1] || '' };
}

const MONTHS = { januar: 1, februar: 2, marz: 3, maerz: 3, märz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
const germanDate = (s) => { const m = /(\d{1,2})\.?\s*([A-Za-zäöü]+)\s+(\d{4})/.exec(s); const mo = m && MONTHS[m[2].toLowerCase()]; return mo ? { year: +m[3], month: mo, day: +m[1] } : null; };
const key = (d) => d.year * 10000 + d.month * 100 + d.day;

/** Lecture period and lecture-free ranges of every semester in the calendar table text. */
function parseLecturePeriods(calendarText) {
  const out = [];
  for (const table of String(calendarText).split(/^TABLE \d+$/m).slice(1)) {
    const lecture = /^Vorlesungszeit \|(.+)$/m.exec(table)?.[1] || '';
    const [from, to] = lecture.split(/bis einschlie\S+/).map((p) => germanDate(p || ''));
    if (!from || !to) continue;
    const free = [...(/^Vorlesungsfreie Zeiten \|(.+)$/m.exec(table)?.[1] || '').matchAll(/(\d{1,2}\.?\s*[A-Za-zäöü]+\s+\d{4})\s+bis einschlie\S+\s+\w+,\s*(\d{1,2}\.?\s*[A-Za-zäöü]+\s+\d{4})/g)]
      .map((m) => [germanDate(m[1]), germanDate(m[2])]).filter(([a, b]) => a && b);
    out.push({ from, to, free });
  }
  return out;
}

const roman = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
const groupFrom = (text) => {
  const m = /\b(?:group|gruppe|gr\.?)\s*(IV|V|I{1,3}|\d)\b/i.exec(String(text));
  if (!m) return '';
  return /^\d$/.test(m[1]) ? roman[m[1]] || '' : m[1].toUpperCase();
};

/**
 * The timetable of one semester as text for the assistant: the weekly grid and the next classes with exact dates.
 * `timeZone` is the institution's zone; `periods` come from parseLecturePeriods.
 */
function describeTimetable(tt, { now = new Date(), timeZone = 'Europe/Berlin', group = '', periods = [], sourceTitle = '', page = null } = {}) {
  const groups = [...new Set(tt.entries.map((e) => e.group).filter(Boolean))];
  const picked = group && groups.includes(group) ? tt.entries.filter((e) => !e.group || e.group === group) : tt.entries;
  const fmtLine = (e) => `${e.start}–${e.end} ${e.title}${e.group ? ` (group ${e.group})` : ''}${e.room ? ` · room ${e.room}${e.mode ? ` (${e.mode})` : ''}` : ''}${e.lecturer ? ` · ${e.lecturer}` : ''}`;

  const nowParts = zonedParts(now, timeZone);
  const today = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const valid = tt.valid ? { day: +tt.valid.slice(0, 2), month: +tt.valid.slice(3, 5), year: +tt.valid.slice(6) } : null;
  const period = periods.find((p) => valid && key(valid) >= key(p.from) && key(valid) <= key(p.to)) || null;
  const upcoming = [];
  for (let i = 0; i < 28 && upcoming.length < 6; i += 1) {
    const d = new Date(today + i * 86_400_000);
    const ymd = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    if (period && (key(ymd) < key(period.from) || key(ymd) > key(period.to) || period.free.some(([a, b]) => key(ymd) >= key(a) && key(ymd) <= key(b)))) continue;
    const dayName = DAY_NAMES[(d.getUTCDay() + 6) % 7];
    for (const e of picked.filter((x) => x.day === dayName)) {
      const end = zonedToUtc({ ...ymd, hour: +e.end.slice(0, 2), minute: +e.end.slice(3) }, timeZone);
      if (end.getTime() <= now.getTime()) continue;
      upcoming.push({ ymd, e, label: `${dayName} ${ymd.day} ${new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(d)} ${ymd.year}` });
    }
  }
  const nowText = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return [
    `TIMETABLE read from the printed grid (times, rooms and lecturers exactly as printed). ${tt.programme} ${tt.level === 'MA' ? 'Master' : 'Bachelor'}, semester ${tt.semester}, ${tt.term === 'SS' ? 'summer' : 'winter'}-term start. Valid from ${tt.valid || 'n/a'}${sourceTitle ? `. Source: ${sourceTitle}${page ? `, PDF p. ${page}` : ''}` : ''}.`,
    `Now: ${nowText} (${timeZone}).`,
    groups.length ? `Groups in this timetable: ${groups.join(', ')}.${group && groups.includes(group) ? ` Showing group ${group} plus classes for everyone.` : ' The student\'s group is not known: ask which group, or list the options.'}` : '',
    '',
    'Weekly:',
    ...DAY_NAMES.map((d) => ({ d, rows: picked.filter((e) => e.day === d) })).filter((x) => x.rows.length).map((x) => `${x.d}: ${x.rows.map(fmtLine).join(' | ')}`),
    '',
    upcoming.length ? 'Next classes from now (lecture-free days skipped):' : 'No class left in the printed lecture period.',
    ...upcoming.map((u, i) => `${i + 1}. ${u.label} ${fmtLine(u.e)}`),
    period ? `Lecture period: ${period.from.day}.${period.from.month}.${period.from.year} to ${period.to.day}.${period.to.month}.${period.to.year}.` : '',
    'Late changes are not in this timetable. Say that it is the printed timetable.',
  ].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { parsePage, parseLecturePeriods, describeTimetable, groupFrom, DAY_NAMES };
