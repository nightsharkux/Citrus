'use strict';
/**
 * Visual cues for Citrus's animated explanations.
 *
 * The model may begin an answer with one line:  [visual: KIND | CONTENT]
 * The cue is removed from the text the user reads and sent separately, so the
 * front end can turn Citrus's eye into a small animation (formula, bars,
 * stick figures, …). Anything malformed is simply left as normal text.
 */
const KINDS = ['formula', 'numbers', 'chart', 'sort', 'steps', 'people', 'cycle', 'clock', 'code', 'idea', 'trend'];
const ALIASES = {
  equation: 'formula', math: 'formula', maths: 'formula',
  number: 'numbers', count: 'numbers', stats: 'numbers',
  bars: 'chart', graph: 'chart', comparison: 'chart', compare: 'chart',
  sorting: 'sort', process: 'steps', step: 'steps', sequence: 'steps',
  person: 'people', team: 'people', group: 'people',
  loop: 'cycle', lifecycle: 'cycle', time: 'clock', timeline: 'clock', schedule: 'clock',
  growth: 'trend', decline: 'trend', lightbulb: 'idea', concept: 'idea',
};
const PREFIX = '[visual:';
const MAX_CUE = 240;

function normaliseKind(raw) {
  const kind = String(raw || '').trim().toLowerCase();
  if (KINDS.includes(kind)) return kind;
  return ALIASES[kind] || null;
}

/** Parse "[visual: kind | content]" → { kind, content } or null. */
function parseCue(line) {
  const m = /^\[visual:\s*([a-z-]+)\s*(?:\|\s*([^\]]*))?\]$/i.exec(String(line).trim());
  if (!m) return null;
  const kind = normaliseKind(m[1]);
  if (!kind) return null;
  // eslint-disable-next-line no-control-regex
  const content = String(m[2] || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  return { kind, content };
}

/** Split a complete answer into { visual, text }. */
function extractVisual(answer) {
  const text = String(answer || '');
  const lead = text.replace(/^\s+/, '');
  if (!lead.toLowerCase().startsWith(PREFIX)) return { visual: null, text };
  const end = lead.indexOf(']');
  if (end < 0) return { visual: null, text };
  const visual = parseCue(lead.slice(0, end + 1));
  if (!visual) return { visual: null, text };
  return { visual, text: lead.slice(end + 1).replace(/^\s+/, '') };
}

/**
 * Streaming version. push(delta) returns the text that is safe to show now;
 * end() returns whatever is still held back. `visual` is set once a cue is found.
 */
function createVisualExtractor() {
  let buffer = '';
  let decided = false;
  let trimLeading = false; // swallow the blank line that follows a cue, whichever chunk it arrives in
  const state = { visual: null };

  function push(delta) {
    if (decided) {
      if (!trimLeading) return delta;
      const rest = delta.replace(/^\s+/, '');
      if (rest) trimLeading = false;
      return rest;
    }
    buffer += delta;
    const lead = buffer.replace(/^\s+/, '');
    if (!lead) return '';
    const head = lead.slice(0, PREFIX.length).toLowerCase();
    if (!PREFIX.startsWith(head) && !head.startsWith(PREFIX)) return release();
    const end = lead.indexOf(']');
    if (end < 0) return lead.length > MAX_CUE ? release() : '';
    const visual = parseCue(lead.slice(0, end + 1));
    if (!visual) return release();
    state.visual = visual;
    decided = true;
    buffer = '';
    const rest = lead.slice(end + 1).replace(/^\s+/, '');
    trimLeading = !rest;
    return rest;
  }

  function release() {
    decided = true;
    const out = buffer;
    buffer = '';
    return out;
  }

  return {
    push,
    end: () => (decided ? '' : release()),
    get visual() {
      return state.visual;
    },
  };
}

module.exports = { KINDS, parseCue, extractVisual, createVisualExtractor };
