'use strict';
/**
 * Words the speech recogniser should expect in a lecture: the course and lecture titles, the topic names, and the
 * terms that stand out in the lecturer's notes (names, acronyms, technical words). Recognisers mishear exactly
 * these, because they are rare in everyday speech; handing them over as "keyterms" is one of the biggest accuracy
 * gains available for lecture audio.
 *
 * Pure functions: no database or network here.
 */

const MAX_TERMS = 80;
const STOP = new Set(('the and for with this that from have will your what when where which about into over under also than then them they their there these those been being were was are not but can could should would may might must our out use used using one two three four first second more most some any each other such only very just like many much make made lecture slide slides page week chapter example examples und der die das ist nicht ein eine mit von zu für auf im den dem des wie wenn dann oder auch noch schon nur aber sind wird werden kann können').split(' '));

/** A term worth boosting: 3-40 characters, letters/digits with inner hyphens or dots, not a common word. */
const usable = (w) => w.length >= 3 && w.length <= 40 && /^[\p{L}][\p{L}\p{N}.'’-]*$/u.test(w) && !STOP.has(w.toLowerCase());

/**
 * Terms from free text, best first: acronyms and capitalised words that are not just the start of a sentence, then
 * long words repeated often (technical vocabulary). Whole phrases of two capitalised words ("Gradient Descent")
 * count as one term.
 */
function termsFrom(text, limit = 50) {
  const score = new Map();
  const add = (term, points) => {
    const key = term.toLowerCase();
    const known = score.get(key);
    score.set(key, { term: known?.term || term, points: (known?.points || 0) + points });
  };
  const body = String(text || '').slice(0, 60_000);

  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.split(/[\s,;:()[\]"“”„]+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i].replace(/[.!?]+$/, '');
      if (!usable(w)) continue;
      const acronym = /^[A-ZÄÖÜ][A-ZÄÖÜ0-9-]{1,}$/.test(w);
      const capital = /^[A-ZÄÖÜ]/.test(w) && i > 0; // not merely the first word of a sentence
      if (acronym) add(w, 3);
      else if (capital) {
        const next = words[i + 1]?.replace(/[.!?]+$/, '');
        if (next && /^[A-ZÄÖÜ]/.test(next) && usable(next)) {
          add(`${w} ${next}`, 3);
          i += 1;
        } else add(w, 2);
      } else if (w.length >= 8) add(w, 1);
    }
  }
  return [...score.values()]
    .filter((s) => s.points >= 2 || s.term.length >= 8)
    .sort((a, b) => b.points - a.points || b.term.length - a.term.length)
    .slice(0, limit)
    .map((s) => s.term);
}

/**
 * @param lecture  { title, course: { code, title }, topics: [string], notes: [string] }  the notes are plain text
 * @returns up to MAX_TERMS distinct terms, titles first
 */
function lectureVocabulary({ title = '', course = null, topics = [], notes = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (term) => {
    const clean = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = clean.toLowerCase();
    if (clean.length < 3 || seen.has(key) || out.length >= MAX_TERMS) return;
    seen.add(key);
    out.push(clean);
  };
  push(title);
  if (course) {
    push(course.title);
    push(course.code);
  }
  for (const t of topics) push(t);
  for (const text of notes) for (const t of termsFrom(text)) push(t);
  return out;
}

module.exports = { lectureVocabulary, termsFrom, MAX_TERMS };

/**
 * The vocabulary for a running lecture, read from the database. Only the lecture's own lecturer gets it
 * (others get an empty list), so one teacher's notes never shape another person's recogniser.
 */
function loadLectureVocabulary({ db, access }, user, sessionId) {
  const s = db.get('SELECT * FROM live_sessions WHERE id = ? AND institution_id = ?', Number(sessionId), user.institution_id);
  if (!s || !access.teachingCourse(user, s.course_id)) return [];
  const course = db.get('SELECT code, title FROM courses WHERE id = ?', s.course_id);
  const topics = db.all('SELECT t.title FROM topics t JOIN lectures l ON l.id = t.lecture_id WHERE l.course_id = ? ORDER BY t.id DESC LIMIT 30', s.course_id).map((t) => t.title);
  const notes = db.all('SELECT a.text FROM live_notes n JOIN assistant_attachments a ON a.id = n.attachment_id WHERE n.session_id = ? AND a.kind = ?', s.id, 'document').map((r) => r.text);
  return lectureVocabulary({ title: s.title, course, topics, notes });
}

module.exports.loadLectureVocabulary = loadLectureVocabulary;
