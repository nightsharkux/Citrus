'use strict';
/**
 * The published exam plans as data, for questions like "when are my exams?" and "what was the exam schedule last
 * semester?". resources/oth-exams.json is made by scripts/oth-timetables.py from the official exam plan PDFs: one
 * row per exam with its term, date, time and the text of the row (module, examiner, room, aids).
 *
 *   exams.wantsExams(text)                     -> does the question ask about exams?
 *   exams.wantsLast(text)                      -> does it ask about the previous term?
 *   exams.describe({ codes, text, now })       -> context lines for the assistant
 */
const { readBundled } = require('../lib/bundled');
const { zonedParts } = require('../lib/time');

const EXAM_WORDS = /\b(exams?|examination|klausur(en)?|pr(ü|ue)fung(en|splan)?|pruefung(en|splan)?|assessments?|resit|retake|nachpr(ü|ue)fung|wiederholungspr(ü|ue)fung|finals?)\b/i;
const LAST_WORDS = /\b(last|previous|past|earlier|old)\s+(semester|term)\b|\b(letzte[sn]?|vorherige[sn]?|vergangene[sn]?|vorige[sn]?)\s+semester\b|\blast (summer|winter)\b|\bsommersemester\s*2026\b|\bsose\s*2026\b|\bwhat was\b|\bwie war\b/i;

const termKey = (term) => {
  const m = /^(SoSe|WS) (\d{4})/.exec(term || '');
  return m ? Number(m[2]) * 2 + (m[1] === 'WS' ? 1 : 0) : 0;
};

function createExams({ root, timeZone, file = 'resources/oth-exams.json' }) {
  let rows = null;
  const load = () => {
    if (rows) return rows;
    try {
      rows = JSON.parse(readBundled(root, file)).exams || [];
    } catch {
      rows = [];
    }
    return rows;
  };

  const today = (now) => {
    const p = zonedParts(now, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  };
  const line = (r) => `${r.date || 'no fixed date'}${r.start ? ` ${r.start}${r.end ? `–${r.end}` : ''}` : ''} · ${r.text}`.slice(0, 260);

  /**
   * Exam rows for the programmes asked about: the dates still to come, and the most recent finished term. A
   * programme with no rows says so with the link to the exam plan the university has published (or that none is).
   */
  function describe({ codes, text = '', now = new Date(), limit = 28 }) {
    const all = load();
    if (!all.length || !codes.length) return [];
    const out = [];
    const day = today(now);
    const wantLast = LAST_WORDS.test(text);
    for (const code of codes.slice(0, 2)) {
      const mine = all.filter((r) => r.programme === code);
      if (!mine.length) {
        out.push(`${code}: no exam plan for this programme is in the data. Say so, and point to the exam plans page: https://www.oth-aw.de/studium/im-studium/organisatorisches/stunden-und-pruefungsplaene/`);
        continue;
      }
      const terms = [...new Set(mine.map((r) => r.term).filter(Boolean))].sort((a, b) => termKey(b) - termKey(a));
      const upcoming = mine.filter((r) => r.date && r.date >= day).sort((a, b) => a.date.localeCompare(b.date));
      const sources = [...new Map(mine.map((r) => [r.source, r])).values()];
      const plan = (r) => `${r.term || 'term unknown'}: ${r.source}`;
      out.push(`${code} exam plans in the data: ${sources.slice(0, 4).map(plan).join(' | ')}`);
      if (upcoming.length) {
        out.push(`${code} exams still to come (from ${day}), by date:\n${upcoming.slice(0, limit).map(line).join('\n')}`);
      } else {
        out.push(`${code}: no exam dates after today (${day}) are published yet.`);
      }
      // The latest term that has already finished (every dated row before today), or the one asked about.
      const past = mine.filter((r) => r.date && r.date < day);
      const pastTerm = [...new Set(past.map((r) => r.term).filter(Boolean))].sort((a, b) => termKey(b) - termKey(a))[0];
      if (pastTerm && (wantLast || !upcoming.length)) {
        const rowsOfTerm = past.filter((r) => r.term === pastTerm).sort((a, b) => a.date.localeCompare(b.date));
        out.push(`${code} exams of ${pastTerm} (the last finished term), by date:\n${rowsOfTerm.slice(0, limit).map(line).join('\n')}`);
        const undated = mine.filter((r) => r.term === pastTerm && !r.date);
        if (undated.length) out.push(`${code} ${pastTerm} without a fixed date (coursework or by arrangement): ${undated.slice(0, 12).map((r) => r.module).join('; ')}`);
      }
      if (terms.length > 1) out.push(`${code} terms covered: ${terms.join(', ')}`);
    }
    return out;
  }

  return { describe, wantsExams: (text) => EXAM_WORDS.test(String(text || '')), wantsLast: (text) => LAST_WORDS.test(String(text || '')), count: () => load().length };
}

module.exports = { createExams };
