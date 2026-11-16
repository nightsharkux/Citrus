'use strict';
/**
 * What the lecturer has said in a live lecture, kept in memory only.
 *
 * Citrus listens through the lecture so it can answer "what did I just say?". This memory holds the most recent part
 * (the last few thousand words) for quick answers; it is gone when the lecture ends or the server restarts.
 * When the lecturer chose "Keep the transcript" at the start, every line is also written to live_transcript
 * (routes.js) so Citrus can answer students about the lecture afterwards. Without that choice nothing is stored.
 */
const MAX_LINES = 600;
const MAX_LINE = 600;

function createTranscripts() {
  const bySession = new Map();

  function add(sessionId, text, at = Date.now()) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
    if (!clean) return 0;
    const lines = bySession.get(sessionId) || [];
    lines.push({ at, text: clean });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    bySession.set(sessionId, lines);
    return lines.length;
  }

  /** The last `minutes` of speech as plain text with a mark at the start of each minute ("[12:04]"). */
  function recent(sessionId, { minutes = 6, maxChars = 7000, now = Date.now() } = {}) {
    const from = now - minutes * 60_000;
    const lines = (bySession.get(sessionId) || []).filter((l) => l.at >= from);
    let out = '';
    let mark = '';
    for (const l of lines) {
      const stamp = new Date(l.at).toISOString().slice(11, 16);
      if (stamp !== mark) {
        mark = stamp;
        out += `\n[${stamp}] `;
      }
      out += `${l.text} `;
    }
    return out.trim().slice(-maxChars);
  }

  const clear = (sessionId) => bySession.delete(sessionId);
  const size = (sessionId) => (bySession.get(sessionId) || []).length;
  /** When something was last heard (ms), or 0. Tells students whether Citrus is listening. */
  const lastAt = (sessionId) => (bySession.get(sessionId) || []).at(-1)?.at || 0;
  return { add, recent, clear, size, lastAt };
}

module.exports = { createTranscripts };
