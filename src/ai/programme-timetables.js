'use strict';
/**
 * The university's published class timetables, read by the assistant.
 *
 * resources/oth-timetables.json is produced by scripts/oth-timetables.py from the official PDFs. Each class is
 * one programme and semester with its weekly pattern (weekday, start, end, and the text printed in the box:
 * course, room, lecturer). This module answers "what do I have right now?" for any programme without the
 * student explaining anything: the programme comes from their profile or from what they said in the
 * conversation ("I'm in DTM", "Digital Technology and Management, 3rd semester").
 *
 *   timetables.mentioned(text)                  -> programme codes named in a text
 *   timetables.describe({ codes, semester, now }) -> context lines for the assistant
 *   timetables.programmes()                     -> [{ code, name }]
 */
const { readBundled } = require('../lib/bundled');
const { zonedToUtc, zonedParts, DAY } = require('../lib/time');

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** Short upper-case words that are not programme codes even if a programme uses them. */
const NOT_CODES = new Set(['WS', 'SS', 'BA', 'MA', 'OK', 'EU', 'PDF', 'FAQ', 'AM', 'PM']);

/** Lower-case codes that are ordinary words, so they only count when upper-case or introduced as a programme. */
const WORDS_LIKE_CODES = new Set(['edu', 'ime', 'dib']);
const SAID_BEFORE = /(?:\bi do|\bi am in|\bi'?m in|\bim in|\bi study|\bi'?m studying|\bstudying|\bstudent (?:of|in)|\benrolled in|\bich studiere|\bbin im|\bbin in|\bstudiere|\bim studiengang|\ban|\bthe|\bfor|\bof|\bvon|\bund|\band|\boder|\bor|\bvs|\bversus|\bim|\bfor an?)\s+$/i;
const SAID_AFTER = /^\s*(?:students?|studiengang|programme|program|course|studium|semester|studenten|studentin|studierende|timetable|stundenplan|schedule)\b/i;

const fold = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

function createProgrammeTimetables({ root, timeZone, file = 'resources/oth-timetables.json' }) {
  let data = null;
  function load() {
    if (data) return data;
    try {
      data = JSON.parse(readBundled(root, file));
    } catch {
      data = { classes: [], sources: [] };
    }
    return data;
  }

  const index = () => {
    const d = load();
    if (!d.index) {
      const byCode = new Map();
      for (const c of d.classes) {
        const code = String(c.programme || '').toUpperCase();
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, { code, name: c.programmeName || code, level: c.level, classes: [], source: c.source });
        byCode.get(code).classes.push(c);
      }
      // Programmes with documents but no readable timetable: known by name and link, with the kind of file the university published.
      for (const src of d.sources) {
        const code = String(src.programme || '').toUpperCase();
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, { code, name: src.title.replace(/^(Stundenplan|Studienplan|Timetable|Study plan)\s+/i, '').split(' / ')[0], level: null, classes: [], source: src.url, docs: [] });
        const programme = byCode.get(code);
        programme.docs ||= [];
        programme.docs.push({ kind: src.kind, title: src.title, url: src.url, term: src.term });
        if (!programme.classes.length && src.kind === 'timetable') programme.source = src.url;
      }
      for (const programme of byCode.values()) programme.docs ||= [];
      d.index = byCode;
      d.names = [...byCode.values()].map((p) => ({ code: p.code, key: fold(p.name.replace(/^(Bachelor|Master|Bachelorstudiengang|Masterstudiengang)\s+/i, '')) })).filter((n) => n.key.length >= 6);
    }
    return d;
  };

  const programmes = () => [...index().index.values()].map(({ code, name, level }) => ({ code, name, level }));

  /**
   * Programme codes a text refers to, by code ("DTM", "dtm") or by name ("Digital Technology and Management"), the
   * most recently mentioned first: in "What does an IB student have tomorrow? Oh, I do DTM" the answer is about DTM.
   * Speech recognition writes lower case, so codes are accepted in any case; two-letter codes that are also words
   * ("ib", "ei", "me") only count when the sentence says they are a programme ("I do IB", "an IB student").
   */
  function mentioned(text) {
    const d = index();
    const raw = String(text || '');
    const at = new Map();
    const note = (code, position) => at.set(code, Math.max(at.get(code) ?? -1, position));
    for (const m of raw.matchAll(/\b[A-Za-z][A-Za-z0-9]{1,5}\b/g)) {
      const token = m[0];
      const code = token.toUpperCase();
      if (NOT_CODES.has(code) || !d.index.has(code)) continue;
      const before = raw.slice(Math.max(0, m.index - 30), m.index);
      const after = raw.slice(m.index + token.length, m.index + token.length + 26);
      const stated = SAID_BEFORE.test(before) || SAID_AFTER.test(after);
      if (token === code || stated || (token.length >= 3 && !WORDS_LIKE_CODES.has(token.toLowerCase()))) note(code, m.index);
    }
    const folded = ` ${fold(raw)} `;
    for (const { code, key } of d.names) {
      const position = folded.lastIndexOf(` ${key} `);
      if (position >= 0) note(code, position);
    }
    return [...at.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
  }

  /** A programme field from a profile ("DTM", "Digital Technology and Management"): code or name, any case. */
  function fromProfile(programme) {
    const d = index();
    const raw = String(programme || '').trim();
    if (!raw) return [];
    const code = raw.toUpperCase().replace(/\s+/g, '');
    if (d.index.has(code) && !NOT_CODES.has(code)) return [code];
    return mentioned(raw);
  }

  function semesterIn(text) {
    const t = String(text || '');
    // The last one said wins: "I'm in semester 3... no, semester 5".
    const hits = [...t.matchAll(/(?:semester|sem\.?)\s*(\d{1,2})\b/gi), ...t.matchAll(/\b(\d{1,2})\s*(?:st|nd|rd|th|\.)?\s*(?:semester|sem\b)/gi)].sort((a, b) => a.index - b.index);
    const m = hits[hits.length - 1];
    const n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 12 ? n : null;
  }

  function local(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
    return { day: Math.max(0, DAY_NAMES.findIndex((n) => n === parts.weekday)), minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  const tag = (c) => `${c.programme}${c.semester ? ` sem ${c.semester}` : ''}`;
  const line = (e) => `${e.start}–${e.end} ${e.text}${e.format === 'in person' ? '' : ` [${e.format}]`}`;
  const validFrom = (c) => {
    const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(c.validFrom || '');
    return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null;
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const short = (t, n = 96) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const brief = (e) => `${e.start}–${e.end} ${short(e.text)}${e.format === 'in person' ? '' : ` [${e.format}]`}`;

  /** The weekday (0 = Monday) and a label such as "Tue 10 Nov" for the day `offset` days from `now`. */
  function dayInfo(now, offset) {
    const p = zonedParts(new Date(now.getTime() + offset * DAY), timeZone);
    const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
    return { weekday, label: `${DAY_NAMES[weekday]} ${p.day} ${MONTHS[p.month - 1]}` };
  }

  /**
   * Context lines for the assistant. `semester` narrows the programme to one class; without it every semester of
   * the programme is listed, so the answer is usually direct and the model only asks "which semester?" when the
   * answer depends on it. Today, tomorrow and the day after are listed with dates, then the weekly pattern.
   */
  function describe({ codes, semester = null, now = new Date() }) {
    const d = index();
    const out = [];
    const { day, minute } = local(now);
    for (const code of codes.slice(0, 3)) {
      const programme = d.index.get(code);
      if (!programme) continue;
      const links = (kind) => programme.docs.filter((x) => x.kind === kind);
      let classes = programme.classes;
      const exact = semester ? classes.filter((c) => c.semester === semester) : [];
      if (exact.length) classes = exact;
      if (!classes.length) {
        const handbook = links('module-handbook')[0];
        const plan = links('timetable')[0] || links('study-plan')[0];
        out.push(`${programme.code} (${programme.name}): the university does not publish a weekly timetable with times for this programme that I can read${handbook ? `; the file it links as the timetable is the module handbook (${handbook.url})` : plan ? `; its file is a picture or a format I cannot read (${plan.url})` : ''}. Say so plainly, give that link, and suggest the programme office or Moodle for the lesson times. Never invent lessons.`);
        continue;
      }
      const stand = classes.map((c) => c.stand).find(Boolean);
      const from = classes.map(validFrom).find(Boolean);
      const term = classes.map((c) => c.term).find(Boolean) || 'WS 2026/27';
      out.push(`Official timetable for ${programme.code} (${programme.name}), ${term}${from ? `, valid from ${from.toISOString().slice(0, 10)}` : ''}${stand ? `, published ${stand}` : ''}. It is the weekly pattern; ${exact.length ? `semester ${semester}` : 'all semesters shown'}. Source: ${programme.source}`);
      const exams = links('exam-plan')[0];
      if (exams) out.push(`${programme.code} exam plan (${exams.term || 'current'}): ${exams.url}`);

      const nowItems = [];
      const laterItems = [];
      for (const c of classes) {
        for (const e of c.events.filter((x) => x.day === day)) {
          if (minute >= minutes(e.start) && minute < minutes(e.end)) nowItems.push(`${tag(c)}: ${brief(e)}`);
          else if (minutes(e.start) > minute) laterItems.push(`${tag(c)}: ${brief(e)}`);
        }
      }
      out.push(`${programme.code} right now (${DAY_NAMES[day]} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}): ${nowItems.length ? nowItems.join(' | ') : 'no class is running'}`);
      out.push(`${programme.code} later today: ${laterItems.length ? laterItems.slice(0, 12).join(' | ') : 'nothing more'}`);
      for (const [offset, name] of [[1, 'tomorrow'], [2, 'the day after tomorrow']]) {
        const { weekday, label } = dayInfo(now, offset);
        const items = classes.flatMap((c) => c.events.filter((e) => e.day === weekday).map((e) => `${tag(c)}: ${brief(e)}`));
        out.push(`${programme.code} ${name} (${label}): ${items.length ? items.slice(0, 16).join(' | ') : 'no classes'}`);
      }
      for (const c of classes.slice(0, 8)) {
        const week = DAY_NAMES.map((name, i) => {
          const events = c.events.filter((e) => e.day === i);
          return events.length ? `${name}: ${events.map(brief).join('; ')}` : '';
        }).filter(Boolean);
        out.push(`${programme.code} ${c.semester ? `semester ${c.semester}` : c.label} week: ${week.join(' || ')}`);
      }
    }
    return out;
  }

  /** The room printed in a box: the first line that looks like a room ("HSG 001", "EMI104", "WTC 1.25"). */
  const roomOf = (e) => {
    const lines = (e.lines || []).map((l) => l.trim());
    const coded = lines.find((l) => /^[A-Z]{2,5}[ -]?\d[\w.,/ -]{0,24}$/.test(l) && !/^(DTM|GBR|OOC|GE)\b/.test(l) && !/Gr\b|Group/i.test(l));
    return coded || lines.find((l) => /^\d{3}[a-z]?$/.test(l)) || '';
  };

  /** Upcoming lessons in the next days with real dates, for the map and for "what is next?". */
  function upcoming({ codes, semester = null, now = new Date(), days = 7, limit = 10 }) {
    const d = index();
    const out = [];
    for (const code of codes.slice(0, 2)) {
      const programme = d.index.get(code);
      if (!programme) continue;
      let classes = programme.classes;
      const exact = semester ? classes.filter((c) => c.semester === semester) : [];
      if (exact.length) classes = exact;
      for (let offset = 0; offset <= days; offset += 1) {
        const date = new Date(now.getTime() + offset * DAY);
        const p = zonedParts(date, timeZone);
        const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
        for (const c of classes) {
          for (const e of c.events.filter((x) => x.day === weekday)) {
            const [sh, sm] = e.start.split(':').map(Number);
            const [eh, em] = e.end.split(':').map(Number);
            const starts = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: sh, minute: sm, second: 0 }, timeZone);
            const ends = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: eh, minute: em, second: 0 }, timeZone);
            if (ends.getTime() <= now.getTime()) continue;
            out.push({ title: (e.lines && e.lines[0]) || e.text, starts: starts.toISOString(), ends: ends.toISOString(), location: roomOf(e), detail: e.text, programme: programme.code, semester: c.semester, source: 'official' });
          }
        }
      }
    }
    return out.sort((a, b) => a.starts.localeCompare(b.starts)).slice(0, limit);
  }

  const semestersOf = (code) => [...new Set((index().index.get(code)?.classes || []).map((c) => c.semester).filter(Boolean))].sort((a, b) => a - b);

  return { programmes, mentioned, fromProfile, semesterIn, describe, upcoming, semestersOf, DAY_FULL, local };
}

module.exports = { createProgrammeTimetables };
