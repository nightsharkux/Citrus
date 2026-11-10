'use strict';
/**
 * Exam dates read straight from the university's exam plan text, so a date or a time is never guessed by the AI.
 *
 * A row of the plan looks like
 *   DTM  03.07.2026  90 Min.  09:00  Object-oriented Coding  Beham  keine, nur Unterlagen ...  E-Präsenz-Klausur  3  EDV-232
 * and is read with fixed rules: the date, the length and the start are taken as printed. Courses that are assessed
 * during the semester (no date in the plan) are left out. The room is only given when it is clear at the end of the
 * row; table text can be scrambled, so the notes always point back to the original page.
 */
const ROOM = /(HS \d+|EDV-\d+|MF(?: \+ (?:Speisesaal Mensa|HS \d+))?|DBC 1 \+ 2|Speisesaal Mensa|E-House [\d.]+|WTC [\d.]+|Labor \d+)\s*$/;
const ROW = /^\s*(DTM|IIE)\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d+)\s*Min\.\s+(\d{1,2}:\d{2})(?:\s*-)?\s+(.+)$/;

/** @returns {{programme, year, month, day, time, minutes, module, examiner, aids, room, line}[]} */
function parseExamRows(pageText) {
  const rows = [];
  for (const line of String(pageText).split(/\r?\n/)) {
    const m = ROW.exec(line);
    if (!m) continue;
    const [, programme, dd, mm, yyyy, minutes, time, rest] = m;
    const parts = rest.trim().split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    const module = (parts[0] || '').replace(/^-\s*/, '').trim();
    if (!module) continue;
    const room = ROOM.exec(rest)?.[1] || '';
    const form = parts.findIndex((p) => /Klausur/.test(p));
    const aids = parts.slice(2, form > 2 ? form : 3).join(' ').trim();
    rows.push({
      programme, year: +yyyy, month: +mm, day: +dd, time: time.padStart(5, '0'), minutes: +minutes, module,
      examiner: parts[1] && !/Klausur/.test(parts[1]) ? parts[1] : '', aids: /Klausur|^\d+(, ?\d?\s?S)?$/.test(aids) ? '' : aids, room,
    });
  }
  return rows;
}

module.exports = { parseExamRows };
