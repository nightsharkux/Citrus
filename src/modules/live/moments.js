'use strict';
/**
 * What happens during a lecture besides the live pulse, so the lecturer can see afterwards where it went wrong:
 *
 *   struggle  the class tipped into "trouble". Saved: when, how many were lost, a short excerpt of what had just
 *             been said, and (a moment later, best effort) one sentence from the assistant on the likely sticking point.
 *   point     every few minutes of listening, up to three key points the assistant picked up.
 *
 * Nothing else the lecturer says is stored. Both kinds need the lecturer's microphone to be on; without speech there
 * is still the timeline, just no excerpt or key points.
 */
const { liveStrugglePrompt, liveKeyPointsPrompt } = require('../../ai/prompts');

const STRUGGLE_GAP_MS = 4 * 60_000; // one moment per stretch of trouble, not one per tap
const POINTS_EVERY_MS = 5 * 60_000;
const POINTS_MIN_CHARS = 300;

/** The up-to-three strings in a model's reply that should be a JSON array; anything else gives []. */
function parsePoints(raw) {
  const s = String(raw || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try {
    return (JSON.parse(s.slice(a, b + 1)) || [])
      .filter((x) => typeof x === 'string')
      .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter((x) => x.length >= 8)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function createMoments({ db, ai, bus, transcripts, now = Date.now, minuteOf: minuteFor }) {
  const lastStruggle = new Map();
  const lastPoints = new Map();
  const isoNow = () => new Date(now()).toISOString();
  // In teaching time (breaks left out) when the routes pass their clock; wall-clock minutes otherwise.
  const minuteOf = minuteFor || ((s) => Math.max(1, Math.ceil((now() - Date.parse(s.started)) / 60_000)));
  const lecturer = (s) => db.get('SELECT u.*, i.name AS institution FROM users u JOIN institutions i ON i.id = u.institution_id WHERE u.id = ?', s.lecturer_id);
  const language = (user) => (user?.preferences?.language === 'de' ? 'de' : 'en');
  const aiReady = (user) => !!user && ai.status(user).aiEnabled;

  /** Called after each signal with the new pulse. Records a struggle moment when the class has just got into trouble. */
  function onPulse(s, p) {
    if (s.ended || p.status !== 'trouble') return null;
    if (now() - (lastStruggle.get(s.id) || 0) < STRUGGLE_GAP_MS) return null;
    lastStruggle.set(s.id, now());
    const excerpt = transcripts.recent(s.id, { minutes: 1.5, maxChars: 700, now: now() });
    const id = db.insert(
      "INSERT INTO live_moments(session_id, kind, minute, answered, lost, unsure, excerpt, created) VALUES(?, 'struggle', ?, ?, ?, ?, ?, ?)",
      s.id, minuteOf(s), p.answered, p.lost, p.unsure, excerpt, isoNow(),
    );
    bus.publish(`user:${s.lecturer_id}`, 'live.moment', { session: s.id, kind: 'struggle', minute: minuteOf(s) });
    if (excerpt) explain(id, s, excerpt);
    return id;
  }

  /** One sentence on the likely sticking point. Failures leave the moment without a note, never break the lecture. */
  function explain(id, s, excerpt) {
    const user = lecturer(s);
    if (!aiReady(user)) return Promise.resolve();
    return ai.complete({ user, system: liveStrugglePrompt(language(user)), prompt: `<EXCERPT>\n${excerpt}\n</EXCERPT>`, maxTokens: 120, task: 'summary' })
      .then((text) => {
        db.run('UPDATE live_moments SET note = ? WHERE id = ?', String(text).replace(/\s+/g, ' ').trim().slice(0, 240), id);
        bus.publish(`user:${s.lecturer_id}`, 'live.moment', { session: s.id, kind: 'note' });
      })
      .catch(() => {});
  }

  /** Called as speech arrives: every few minutes, ask for the key points of what was just said. */
  function onSpeech(s) {
    if (s.ended) return null;
    const last = lastPoints.get(s.id);
    if (last && now() - last < POINTS_EVERY_MS) return null;
    const text = transcripts.recent(s.id, { minutes: 5, maxChars: 6000, now: now() });
    if (text.length < POINTS_MIN_CHARS) return null;
    lastPoints.set(s.id, now());
    const user = lecturer(s);
    if (!aiReady(user)) return null;
    const minute = minuteOf(s);
    return ai.complete({ user, system: liveKeyPointsPrompt(language(user)), prompt: `<TRANSCRIPT>\n${text}\n</TRANSCRIPT>`, maxTokens: 400, task: 'summary' })
      .then((raw) => {
        for (const point of parsePoints(raw)) {
          db.run("INSERT INTO live_moments(session_id, kind, minute, note, created) VALUES(?, 'point', ?, ?, ?)", s.id, minute, point, isoNow());
        }
        bus.publish(`user:${s.lecturer_id}`, 'live.moment', { session: s.id, kind: 'point' });
      })
      .catch(() => {});
  }

  /** Stored moments of a session, in time order. `excerpts: false` for students, who never see what was said. */
  function list(sessionId, { excerpts = true } = {}) {
    const rows = db.all('SELECT id, kind, minute, answered, lost, unsure, excerpt, note FROM live_moments WHERE session_id = ? ORDER BY minute, id', sessionId);
    return {
      struggles: rows.filter((r) => r.kind === 'struggle').map((r) => ({ id: r.id, minute: r.minute, answered: r.answered, lost: r.lost, unsure: r.unsure, note: r.note, ...(excerpts ? { excerpt: r.excerpt } : {}) })),
      points: rows.filter((r) => r.kind === 'point').map((r) => ({ id: r.id, minute: r.minute, text: r.note })),
    };
  }

  const forget = (sessionId) => {
    lastStruggle.delete(sessionId);
    lastPoints.delete(sessionId);
  };

  return { onPulse, onSpeech, list, forget };
}

module.exports = { createMoments, parsePoints, STRUGGLE_GAP_MS, POINTS_EVERY_MS };
