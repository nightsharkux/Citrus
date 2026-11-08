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
      // Programmes whose timetable is only a picture: known by name and link, with no readable classes.
      for (const s of d.sources) {
        const m = /\/Studiengaenge\/(?:Bachelor|Master)\/([A-Za-z0-9_-]+)\//.exec(s.url);
        const code = m?.[1]?.toUpperCase();
        if (code && !byCode.has(code) && /^(Stundenplan|Studienplan)/i.test(s.title)) {
          byCode.set(code, { code, name: s.title.replace(/^(Stundenplan|Studienplan)\s+/i, '').split(' / ')[0], level: null, classes: [], source: s.url });
        }
      }
      d.index = byCode;
      d.names = [...byCode.values()].map((p) => ({ code: p.code, key: fold(p.name.replace(/^(Bachelor|Master|Bachelorstudiengang|Masterstudiengang)\s+/i, '')) })).filter((n) => n.key.length >= 6);
    }
    return d;
  };

  const programmes = () => [...index().index.values()].map(({ code, name, level }) => ({ code, name, level }));

  /** Programme codes a text refers to, by code ("DTM") or by name ("Digital Technology and Management"). */
  function mentioned(text) {
    const d = index();
    const found = new Set();
    for (const token of String(text || '').match(/\b[A-Z][A-Za-z0-9]{1,5}\b/g) || []) {
      const code = token.toUpperCase();
      if (token === code && !NOT_CODES.has(code) && d.index.has(code)) found.add(code);
    }
    const folded = ` ${fold(text)} `;
    for (const { code, key } of d.names) if (folded.includes(` ${key} `)) found.add(code);
    return [...found];
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
    const m = /(?:semester|sem\.?)\s*(\d{1,2})\b/i.exec(t) || /\b(\d{1,2})\s*(?:st|nd|rd|th|\.)?\s*(?:semester|sem\b)/i.exec(t);
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

  /**
   * Context lines for the assistant. `semester` narrows the programme to one class; without it every semester of
   * the programme is listed for what is on right now, so the answer is usually direct and the model only asks
   * "which semester?" when more than one class has something on.
   */
  function describe({ codes, semester = null, now = new Date() }) {
    const d = index();
    const out = [];
    const { day, minute } = local(now);
    for (const code of codes.slice(0, 3)) {
      const programme = d.index.get(code);
      if (!programme) continue;
      let classes = programme.classes;
      const exact = semester ? classes.filter((c) => c.semester === semester) : [];
      if (exact.length) classes = exact;
      if (!classes.length) {
        out.push(`${programme.code} (${programme.name}): the university publishes this timetable only as a picture or PDF I cannot read: ${programme.source}`);
        continue;
      }
      const stand = classes.map((c) => c.stand).find(Boolean);
      const from = classes.map(validFrom).find(Boolean);
      out.push(`Official timetable for ${programme.code} (${programme.name}), winter semester 2026/27${from ? `, valid from ${from.toISOString().slice(0, 10)}` : ''}${stand ? `, published ${stand}` : ''}. It is the weekly pattern; ${exact.length ? `semester ${semester}` : 'all semesters shown'}. Source: ${programme.source}`);
      const nowItems = [];
      const laterItems = [];
      for (const c of classes) {
        for (const e of c.events.filter((x) => x.day === day)) {
          if (minute >= minutes(e.start) && minute < minutes(e.end)) nowItems.push(`${tag(c)}: ${line(e)}`);
          else if (minutes(e.start) > minute) laterItems.push(`${tag(c)}: ${line(e)}`);
        }
      }
      out.push(`${programme.code} right now (${DAY_NAMES[day]} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}): ${nowItems.length ? nowItems.join(' | ') : 'no class is running'}`);
      out.push(`${programme.code} later today: ${laterItems.length ? laterItems.slice(0, 12).join(' | ') : 'nothing more'}`);
      if (classes.length <= 3) {
        for (const c of classes) {
          const week = DAY_NAMES.map((name, i) => {
            const events = c.events.filter((e) => e.day === i);
            return events.length ? `${name}: ${events.map(line).join('; ')}` : '';
          }).filter(Boolean);
          out.push(`${programme.code} ${c.semester ? `semester ${c.semester}` : c.label} week: ${week.join(' || ')}`);
        }
      } else {
        out.push(`${programme.code} has ${classes.length} classes (${classes.map((c) => c.semester && `sem ${c.semester}`).filter(Boolean).join(', ')}); ask which semester the student is in only when it changes the answer.`);
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
