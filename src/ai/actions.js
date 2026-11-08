'use strict';
/**
 * Leading cues of an assistant answer: an optional illustration and any number
 * of actions, each on its own line before the prose.
 *
 *   [visual: formula | a^2 + b^2 = c^2]
 *   [action: calendar.add | {"title":"Study group","start":"2026-11-10T15:00"}]
 *
 * The cues are removed from the text the user reads. Actions are handed to
 * `onAction` the moment they are complete, so they can run while the answer is
 * still streaming. Anything that does not parse as a cue stays normal text.
 *
 * Only the *start* of the answer is inspected: the model is told to put cues
 * first, and text further down is never executed.
 */
const { parseCue } = require('./visuals');

const VISUAL = '[visual:';
const ACTION = '[action:';
const MAX_VISUAL = 240;
const MAX_ACTION = 2500;
const MAX_ACTIONS = 6;

/**
 * Parse one action starting at the beginning of `lead`.
 * Returns null when the text is not an action, 'wait' when it is still
 * incomplete, or { end, action } once complete (`end` is the index after `]`).
 */
function parseAction(lead) {
  let i = ACTION.length;
  const skip = () => {
    while (i < lead.length && /\s/.test(lead[i])) i += 1;
  };
  skip();
  const nameStart = i;
  while (i < lead.length && /[A-Za-z0-9_.]/.test(lead[i])) i += 1;
  if (i >= lead.length) return 'wait';
  const name = lead.slice(nameStart, i).toLowerCase();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(name)) return null;
  skip();
  if (i >= lead.length) return 'wait';

  let args = {};
  let error = null;
  if (lead[i] === '|') {
    i += 1;
    skip();
    if (i >= lead.length) return 'wait';
    if (lead[i] !== '{') return null;
    const jsonStart = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < lead.length; i += 1) {
      const ch = lead[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    if (depth !== 0) return 'wait';
    try {
      args = JSON.parse(lead.slice(jsonStart, i));
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
    } catch {
      args = {};
      error = 'I could not read the details of that request.';
    }
    skip();
    if (i >= lead.length) return 'wait';
  }
  if (lead[i] !== ']') return null;
  return { end: i + 1, action: { name, args, ...(error ? { error } : {}) } };
}

/**
 * Streaming extractor. `push(delta)` returns the text that is safe to show now,
 * `end()` whatever is still held back.
 */
function createLeadExtractor({ onAction = () => {} } = {}) {
  let buffer = '';
  let decided = false;
  let count = 0;
  const state = { visual: null, actions: [] };

  function release() {
    decided = true;
    const out = buffer.replace(/^\s+/, '');
    buffer = '';
    return out;
  }

  function push(delta) {
    if (decided) return delta;
    buffer += delta;
    for (;;) {
      const lead = buffer.replace(/^\s+/, '');
      if (!lead) return '';
      const head = lead.slice(0, 8).toLowerCase();
      const isVisual = VISUAL.startsWith(head) || head === VISUAL;
      const isAction = ACTION.startsWith(head) || head === ACTION;
      if (!isVisual && !isAction) return release();
      if (lead.length < 8) return '';

      if (isVisual) {
        const close = lead.indexOf(']');
        if (close < 0) return lead.length > MAX_VISUAL ? release() : '';
        const visual = parseCue(lead.slice(0, close + 1));
        if (!visual) return release();
        if (!state.visual) state.visual = visual;
        buffer = lead.slice(close + 1);
      } else {
        const parsed = parseAction(lead);
        if (parsed === 'wait') return lead.length > MAX_ACTION ? release() : '';
        if (!parsed) return release();
        buffer = lead.slice(parsed.end);
        if (count < MAX_ACTIONS) {
          count += 1;
          state.actions.push(parsed.action);
          onAction(parsed.action);
        }
      }
    }
  }

  return {
    push,
    end() {
      if (decided) return '';
      decided = true;
      const out = buffer.replace(/^\s+/, '');
      buffer = '';
      return out;
    },
    get visual() {
      return state.visual;
    },
    get actions() {
      return state.actions;
    },
  };
}

/** Whole-answer version for non-streaming replies. */
function extractLead(answer, onAction) {
  const extractor = createLeadExtractor({ onAction });
  const text = extractor.push(String(answer || '')) + extractor.end();
  return { text, visual: extractor.visual, actions: extractor.actions };
}

module.exports = { createLeadExtractor, extractLead, parseAction };
