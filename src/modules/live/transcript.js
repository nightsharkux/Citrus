'use strict';
/**
 * What the lecturer has said in a live lecture, kept in memory only.
 *
 * Campus listens through the lecture so it can answer "what did I just say?", but the lecture is not recorded:
 * nothing is written to the database. Only the most recent part is kept (the last few thousand words), and it is
 * gone when the lecture ends or the server restarts. The lecturer's browser keeps the full text on that device and
 * can save it as a file if they choose to.
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
  return { add, recent, clear, size };
}

module.exports = { createTranscripts };
