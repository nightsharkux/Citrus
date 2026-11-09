'use strict';
/**
 * Quiz questions: the kinds there are, checking what the model wrote, what the student sees, and marking.
 *
 *   single     multiple choice, one right option         multi     select all that apply
 *   truefalse  true or false                              blank     fill in the missing word
 *   short      a written answer, marked like a tutor (AI) order     put steps in order
 *   match      match terms to descriptions                numeric   a calculation, with a tolerance
 *
 * The model's output is untrusted: every field is checked and cut to size, and a question that does not fit its
 * shape is dropped. The student never receives the answer before answering; order items and match descriptions
 * are shuffled the same way every time the quiz is opened.
 */

const KINDS = ['single', 'multi', 'truefalse', 'blank', 'short', 'order', 'match', 'numeric'];

const LABELS = {
  single: 'Multiple choice',
  multi: 'Select all that apply',
  truefalse: 'True or false',
  blank: 'Fill in the blank',
  short: 'Short answer',
  order: 'Put in order',
  match: 'Match',
  numeric: 'Calculation',
};

const line = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string' ? v.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');
const distinct = (list) => new Set(list.map((s) => s.toLowerCase())).size === list.length;
const index = (v, length) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < length ? Number(v) : null);

/** German "12,5" and English "1,250.5" both become numbers. */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value ?? '').trim().replace(/\s/g, '').replace(/[^\d.,eE+-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{3}$/.test(s) && !/^-?0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** One question from the model, checked; null when it does not fit its kind. */
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!KINDS.includes(type)) return null;
  const question = text(raw.question, 700);
  if (question.length < 5) return null;
  const q = { type, question, explanation: text(raw.explanation, 900), hint: line(raw.hint, 300) };

  if (type === 'single' || type === 'multi') {
    const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => line(o, 240)).filter(Boolean);
    if (options.length < (type === 'multi' ? 3 : 2) || options.length > 6 || !distinct(options)) return null;
    q.options = options;
    if (type === 'single') {
      q.answer = index(raw.answer, options.length);
      if (q.answer === null) return null;
    } else {
      const answers = [...new Set((Array.isArray(raw.answers) ? raw.answers : []).map((a) => index(a, options.length)))];
      if (!answers.length || answers.includes(null) || answers.length >= options.length) return null;
      q.answers = answers.sort((a, b) => a - b);
    }
  } else if (type === 'truefalse') {
    const a = typeof raw.answer === 'string' ? raw.answer.trim().toLowerCase() : raw.answer;
    if (a === true || a === 'true' || a === 'wahr' || a === 'richtig') q.answer = true;
    else if (a === false || a === 'false' || a === 'falsch') q.answer = false;
    else return null;
  } else if (type === 'blank') {
    const answers = (Array.isArray(raw.answers) ? raw.answers : [raw.answer]).map((a) => line(a, 100)).filter(Boolean).slice(0, 6);
    if (!answers.length) return null;
    q.answers = answers;
    if (!/_{2,}/.test(q.question)) q.question = `${q.question} ___`;
  } else if (type === 'short') {
    q.model_answer = text(raw.model_answer ?? raw.answer, 1000);
    if (q.model_answer.length < 3) return null;
    q.key_points = (Array.isArray(raw.key_points) ? raw.key_points : []).map((p) => line(p, 240)).filter(Boolean).slice(0, 6);
  } else if (type === 'order') {
    const items = (Array.isArray(raw.items) ? raw.items : []).map((i) => line(i, 200)).filter(Boolean);
    if (items.length < 3 || items.length > 7 || !distinct(items)) return null;
    q.items = items;
  } else if (type === 'match') {
    const pairs = (Array.isArray(raw.pairs) ? raw.pairs : [])
      .map((p) => (Array.isArray(p) ? [line(p[0], 160), line(p[1], 240)] : p && typeof p === 'object' ? [line(p.term ?? p.left, 160), line(p.match ?? p.right ?? p.description, 240)] : null))
      .filter((p) => p && p[0] && p[1]);
    if (pairs.length < 2 || pairs.length > 6 || !distinct(pairs.map((p) => p[0])) || !distinct(pairs.map((p) => p[1]))) return null;
    q.pairs = pairs;
  } else if (type === 'numeric') {
    const answer = toNumber(raw.answer);
    if (answer === null) return null;
    const tolerance = toNumber(raw.tolerance);
    q.answer = answer;
    q.tolerance = tolerance !== null && tolerance >= 0 ? Math.min(tolerance, Math.abs(answer) || 1) : Math.max(Math.abs(answer) * 0.01, 1e-9);
    q.unit = line(raw.unit, 24);
  }
  return q;
}

/** The model's whole reply: { title, questions } with at most `limit` valid, distinct questions. */
function parseQuiz(raw, { limit = 15 } = {}) {
  const s = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  let data = null;
  if (start >= 0 && end > start) {
    try {
      data = JSON.parse(s.slice(start, end + 1));
    } catch {
      data = null;
    }
  }
  if (!data) {
    // Some models answer with the bare list.
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    try {
      data = a >= 0 && b > a ? { questions: JSON.parse(s.slice(a, b + 1)) } : null;
    } catch {
      data = null;
    }
  }
  const seen = new Set();
  const questions = [];
  for (const item of Array.isArray(data?.questions) ? data.questions : []) {
    const q = normalise(item);
    const key = q?.question.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    questions.push(q);
    if (questions.length >= limit) break;
  }
  return { title: line(data?.title, 100), questions };
}

/** A shuffle that comes out the same for the same seed (so a reload shows the same order). */
function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // A shuffle that happens to leave everything in place would give the order question away.
  if (out.length > 1 && out.every((v, i) => v === list[i])) out.push(out.shift());
  return out;
}

/** What the student sees of a question before answering it: no answers. */
function publicView(q, seed) {
  const base = { type: q.type, label: LABELS[q.type], question: q.question, hint: q.hint || '' };
  if (q.type === 'single' || q.type === 'multi') return { ...base, options: q.options };
  if (q.type === 'order') return { ...base, items: shuffled(q.items, seed) };
  if (q.type === 'match') return { ...base, left: q.pairs.map((p) => p[0]), right: shuffled(q.pairs.map((p) => p[1]), seed) };
  if (q.type === 'numeric') return { ...base, unit: q.unit };
  return base;
}

/** The right answer, written out for the student after answering. */
function solution(q) {
  switch (q.type) {
    case 'single': return q.options[q.answer];
    case 'multi': return q.answers.map((i) => q.options[i]).join('; ');
    case 'truefalse': return q.answer ? 'True' : 'False';
    case 'blank': return q.answers[0];
    case 'short': return q.model_answer;
    case 'order': return q.items.join(' → ');
    case 'match': return q.pairs.map(([a, b]) => `${a}: ${b}`).join('; ');
    case 'numeric': return `${q.answer}${q.unit ? ` ${q.unit}` : ''}`;
    default: return '';
  }
}

/** The right answer in the shape the page needs to show it (only sent after the question was answered). */
function answerKey(q) {
  switch (q.type) {
    case 'single': case 'truefalse': case 'numeric': return q.answer;
    case 'multi': case 'blank': return q.answers;
    case 'order': return q.items;
    case 'match': return q.pairs.map((p) => p[1]);
    default: return null;
  }
}

/** Lower case, accents and punctuation gone: for comparing typed answers. */
const plain = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/**
 * Mark an answer to every kind except 'short' (that needs the tutor). Returns { score: 0..1 } or null when the
 * answer has the wrong shape. A typo in a long word still counts for fill-in-the-blank.
 */
function mark(q, answer, seed) {
  switch (q.type) {
    case 'single': {
      const i = index(answer, q.options.length);
      return i === null ? null : { score: i === q.answer ? 1 : 0 };
    }
    case 'multi': {
      if (!Array.isArray(answer)) return null;
      const picked = [...new Set(answer.map((a) => index(a, q.options.length)))];
      if (!picked.length || picked.includes(null)) return null;
      const hits = picked.filter((i) => q.answers.includes(i)).length;
      const wrong = picked.length - hits;
      return { score: Math.max(0, (hits - wrong) / q.answers.length) };
    }
    case 'truefalse':
      return typeof answer === 'boolean' ? { score: answer === q.answer ? 1 : 0 } : null;
    case 'blank': {
      const given = plain(answer);
      if (!given) return null;
      const ok = q.answers.some((a) => {
        const want = plain(a);
        return given === want || (want.length >= 5 && editDistance(given, want) <= 1);
      });
      return { score: ok ? 1 : 0 };
    }
    case 'order': {
      if (!Array.isArray(answer) || answer.length !== q.items.length) return null;
      const given = answer.map((a) => String(a));
      if ([...given].sort().join('\u0000') !== [...q.items].sort().join('\u0000')) return null;
      const right = given.filter((item, i) => item === q.items[i]).length;
      return { score: right === q.items.length ? 1 : right / q.items.length * 0.8 };
    }
    case 'match': {
      // answer: for each term (in order), the description chosen.
      if (!Array.isArray(answer) || answer.length !== q.pairs.length) return null;
      const right = q.pairs.filter(([, desc], i) => String(answer[i]) === desc).length;
      return { score: right / q.pairs.length };
    }
    case 'numeric': {
      const n = toNumber(answer);
      if (n === null) return null;
      return { score: Math.abs(n - q.answer) <= q.tolerance + 1e-12 ? 1 : 0 };
    }
    default:
      return null;
  }
}

/** When the tutor cannot mark a written answer: how many key points it mentions. */
function markShortByKeywords(q, answer) {
  const given = new Set(plain(answer).split(' ').filter((w) => w.length >= 4));
  const points = q.key_points.length ? q.key_points : [q.model_answer];
  const hits = points.filter((p) => {
    const words = plain(p).split(' ').filter((w) => w.length >= 4);
    return words.length && words.filter((w) => given.has(w)).length / words.length >= 0.5;
  }).length;
  return { score: Math.round((hits / points.length) * 100) / 100 };
}

module.exports = { KINDS, LABELS, normalise, parseQuiz, publicView, solution, answerKey, mark, markShortByKeywords, shuffled, toNumber };
