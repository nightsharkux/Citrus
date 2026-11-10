'use strict';
/**
 * The class pulse: how well the room is following, from the signals students send.
 * Pure functions (no database), so the rules are easy to read and to test.
 *
 * A signal is 1 (following), 2 (unsure) or 3 (lost). Only each student's latest signal inside the window counts,
 * so a student who says "lost" and then "following" is no longer lost.
 */

const WINDOW_MS = 3 * 60_000;
/** Fewer answers than this say too little to call the room. */
const MIN_SIGNALS = 3;

/** Share of the answering students who are struggling: lost counts fully, unsure half. */
const strain = (c) => (c.total ? (c.lost + c.unsure * 0.5) / c.total : 0);

/** 'quiet' | 'good' | 'watch' | 'trouble' for a count of { following, unsure, lost }. */
function statusOf(counts) {
  const total = counts.following + counts.unsure + counts.lost;
  if (total < MIN_SIGNALS) return 'quiet';
  const share = strain({ ...counts, total });
  if (share >= 0.4) return 'trouble';
  if (share >= 0.2) return 'watch';
  return 'good';
}

/**
 * @param signals  [{ user_id, level, created }] in any order
 * @param now      ms
 * @param enrolled how many students could answer
 */
function pulse(signals, { now = Date.now(), enrolled = 0, windowMs = WINDOW_MS } = {}) {
  const latest = new Map();
  for (const s of signals) {
    const at = Date.parse(s.created);
    if (now - at > windowMs || at > now + 5000) continue;
    const known = latest.get(s.user_id);
    if (!known || at > known.at) latest.set(s.user_id, { at, level: s.level });
  }
  const counts = { following: 0, unsure: 0, lost: 0 };
  for (const { level } of latest.values()) counts[level === 1 ? 'following' : level === 2 ? 'unsure' : 'lost'] += 1;
  const answered = latest.size;
  return { ...counts, answered, enrolled, status: statusOf(counts), strain: Math.round(strain({ ...counts, total: answered }) * 100) / 100 };
}

/**
 * Minute-by-minute strain since the lecture began, so the lecturer (and the AI) can see where it went wrong.
 * Each minute uses every student's latest signal up to the end of that minute.
 * Returns [{ minute, answered, strain, status }].
 */
function timeline(signals, startedIso, { now = Date.now() } = {}) {
  const start = Date.parse(startedIso);
  const minutes = Math.max(1, Math.min(240, Math.ceil((now - start) / 60_000)));
  const ordered = [...signals].map((s) => ({ ...s, at: Date.parse(s.created) })).sort((a, b) => a.at - b.at);
  const out = [];
  for (let m = 1; m <= minutes; m += 1) {
    const end = start + m * 60_000;
    const from = end - WINDOW_MS;
    const latest = new Map();
    for (const s of ordered) {
      if (s.at > end) break;
      if (s.at >= from) latest.set(s.user_id, s.level);
    }
    const counts = { following: 0, unsure: 0, lost: 0 };
    for (const level of latest.values()) counts[level === 1 ? 'following' : level === 2 ? 'unsure' : 'lost'] += 1;
    out.push({ minute: m, answered: latest.size, strain: Math.round(strain({ ...counts, total: latest.size }) * 100) / 100, status: statusOf(counts) });
  }
  return out;
}

/** The stretches of a lecture that went badly: runs of minutes in 'trouble', for the end-of-lecture summary. */
function roughPatches(line) {
  const patches = [];
  let run = null;
  for (const point of line) {
    if (point.status === 'trouble') {
      run = run ? { ...run, to: point.minute } : { from: point.minute, to: point.minute };
    } else if (run) {
      patches.push(run);
      run = null;
    }
  }
  if (run) patches.push(run);
  return patches;
}

module.exports = { pulse, timeline, roughPatches, statusOf, WINDOW_MS, MIN_SIGNALS };

/**
 * One student's own path through a lecture: for each minute, how they said they were following (the latest answer
 * within the window), or null before they answered. Private to that student.
 * Returns [{ minute, level }].
 */
function personalTimeline(signals, startedIso, { now = Date.now() } = {}) {
  const start = Date.parse(startedIso);
  const minutes = Math.max(1, Math.min(240, Math.ceil((now - start) / 60_000)));
  const mine = [...signals].map((s) => ({ level: s.level, at: Date.parse(s.created) })).sort((a, b) => a.at - b.at);
  const out = [];
  for (let m = 1; m <= minutes; m += 1) {
    const end = start + m * 60_000;
    let level = null;
    for (const s of mine) {
      if (s.at > end) break;
      if (s.at >= end - WINDOW_MS) level = s.level;
    }
    out.push({ minute: m, level });
  }
  return out;
}

module.exports.personalTimeline = personalTimeline;
