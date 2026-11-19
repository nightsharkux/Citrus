'use strict';
/**
 * Teaching time: the lecture's clock with its breaks taken out.
 *
 * A lecture can be paused (a coffee break, lunch). Wall-clock time keeps running, but the lecture's minutes, its
 * class timeline and its record should not count the break: minute 40 is forty minutes of teaching. Every
 * timestamp is moved back by the break time before it ("shifted"), so everything that reads time since the start
 * (minutes, sections, the timeline) works unchanged on teaching time. Pure functions, no database.
 *
 *   breaks   [{ started, ended | null }]   ISO times; an open break (ended null) lasts until `now`
 */
const ms = (iso) => Date.parse(iso);

/** How much break time lies before an instant (ms). */
function breakMsBefore(breaks, atMs, nowMs = Date.now()) {
  let total = 0;
  for (const b of breaks || []) {
    const from = ms(b.started);
    if (!(from < atMs)) continue;
    const to = b.ended ? ms(b.ended) : nowMs;
    total += Math.max(0, Math.min(to, atMs) - from);
  }
  return total;
}

/** Teaching milliseconds from the start up to an instant. */
const activeMs = (startedIso, breaks, atMs, nowMs = Date.now()) => Math.max(0, atMs - ms(startedIso) - breakMsBefore(breaks, atMs, nowMs));

/** An ISO time moved back by the break time before it. */
const shiftIso = (breaks, iso, nowMs = Date.now()) => new Date(ms(iso) - breakMsBefore(breaks, ms(iso), nowMs)).toISOString();

/** Rows with their time column shifted (the same rows when there were no breaks). */
const shiftRows = (rows, breaks, nowMs = Date.now(), key = 'created') => (breaks?.length ? rows.map((r) => ({ ...r, [key]: shiftIso(breaks, r[key], nowMs) })) : rows);

/** All break time up to `nowMs` (an open break counts up to now). */
const totalBreakMs = (breaks, nowMs = Date.now()) => breakMsBefore(breaks, Infinity, nowMs);

module.exports = { breakMsBefore, activeMs, shiftIso, shiftRows, totalBreakMs };
