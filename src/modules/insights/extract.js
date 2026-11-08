'use strict';
/**
 * Picking key points out of lecture speech: parsing what the AI returns,
 * a plain-text fallback for when no AI is connected, and de-duplication.
 * Pure functions, no database.
 */
const KINDS = ['definition', 'concept', 'formula', 'example', 'important', 'announcement', 'question'];

const STOP = new Set('the a an and or but if then so of to in on at for with as is are was were be been it this that these those we you i they he she there here from by not can will would should could do does did have has had just very really also about into than which what when where how why who one two like okay ok right well now going gonna let lets us our your their its'.split(' '));

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9äöüß\s]/gi, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** 0..1 overlap of the meaningful words of two phrases. */
function similarity(a, b) {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** One point from the model (or the fallback), checked and trimmed; null when it is not usable. */
function cleanPoint(p, source) {
  if (!p || typeof p !== 'object') return null;
  const title = clip(p.title, 90);
  const body = clip(p.body ?? p.text, 400);
  if (title.length < 3 && body.length < 12) return null;
  const kind = KINDS.includes(p.kind) ? p.kind : 'concept';
  const formula = kind === 'formula' || p.formula ? clip(p.formula, 200).replace(/\$/g, '') : '';
  return {
    kind,
    title: title.length >= 3 ? title : clip(body, 60),
    body: title.length >= 3 ? body : '',
    formula,
    importance: Math.min(3, Math.max(1, Math.round(Number(p.importance)) || 2)),
    source,
  };
}

/** Parse the model's reply: tolerant of code fences and chatter around the JSON. Returns { topic, points } or null. */
function parseInsights(reply, source = 'ai') {
  const text = String(reply || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const json = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(json.points)) return null;
    return {
      topic: clip(json.topic, 60),
      points: json.points.map((p) => cleanPoint(p, source)).filter(Boolean).slice(0, 8),
    };
  } catch {
    return null;
  }
}

/** Remove points that repeat something already captured (or an earlier point in the same batch). */
function dropRepeats(points, knownTitles) {
  const seen = [...knownTitles];
  const out = [];
  for (const p of points) {
    const label = `${p.title} ${p.body}`;
    if (seen.some((t) => similarity(t, label) >= 0.7 || similarity(t, p.title) >= 0.8)) continue;
    seen.push(p.title);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- fallback without AI

const CUES = [
  { kind: 'definition', weight: 4, re: /\b(is defined as|are defined as|we define|is called|are called|is known as|refers to|stands for|means that|the definition of)\b/i },
  { kind: 'announcement', weight: 5, re: /\b(deadline|is due|are due|due (on|by|next)|hand in|submit|assignment|homework|coursework|midterm|final exam|exam(?:ination)? (?:is|will|on)|office hours|next (?:week|lecture|class|session)|no (?:lecture|class) (?:on|next)|room (?:change|has changed))\b/i },
  { kind: 'important', weight: 5, re: /\b(important|remember|key (?:point|idea|takeaway)|crucial|essential|make sure|pay attention|don'?t forget|keep in mind|note that|be careful|common mistake|will (?:be|come) (?:on|up in) the (?:exam|test|quiz)|exam[- ]relevant)\b/i },
  { kind: 'example', weight: 3, re: /\b(for example|for instance|e\.g\.|let'?s say|suppose|consider the|imagine)\b/i },
  { kind: 'formula', weight: 4, re: /\b(equals|is equal to|squared|cubed|divided by|times|plus|minus)\b.*\b(equals|is equal to|squared|cubed|divided by|times|plus|minus)\b|[a-z]\s*=\s*[a-z0-9(]/i },
  { kind: 'question', weight: 3, re: /\?\s*$|^(?:why|how come|what happens if|what if)\b/i },
];

const TITLE_LEAD = /^(?:so|and|but|well|now|okay|ok|right|then|um|uh|basically|actually|therefore)[,\s]+/i;

/** Rule-based key points. Labelled "basic" in the interface; far less precise than the AI path. */
function basicInsights(transcript) {
  const sentences = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(' ').length >= 5 && s.length <= 320);
  if (!sentences.length) return { topic: '', points: [] };
  const counts = new Map();
  for (const w of words(sentences.join(' '))) counts.set(w, (counts.get(w) || 0) + 1);
  const repeated = new Set([...counts].filter(([, n]) => n >= 3).map(([w]) => w));

  const scored = sentences.map((s, i) => {
    let best = null;
    for (const cue of CUES) if (cue.re.test(s) && (!best || cue.weight > best.weight)) best = cue;
    const echo = words(s).filter((w) => repeated.has(w)).length;
    const score = (best ? best.weight : 0) + Math.min(2, echo * 0.5);
    return { s, i, kind: best?.kind || 'concept', score };
  }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.i - b.i);

  const topTerms = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);
  const points = scored.map(({ s, kind, score }) => {
    const sentence = s.replace(TITLE_LEAD, '');
    return {
      kind,
      title: clip(sentence.split(/\s+/).slice(0, 8).join(' '), 70),
      body: clip(sentence, 260),
      formula: '',
      importance: score >= 5 ? 3 : 2,
      source: 'basic',
    };
  });
  return { topic: topTerms.join(' '), points };
}

module.exports = { KINDS, parseInsights, dropRepeats, basicInsights, similarity, cleanPoint };
