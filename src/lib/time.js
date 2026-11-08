'use strict';
/**
 * Time-zone helpers built on Intl, so weekly events keep their wall-clock time
 * across daylight-saving changes without a date library.
 */
const now = () => new Date().toISOString();

const formatters = new Map();
function partsFormatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/** Wall-clock components of a UTC instant in a time zone. */
function zonedParts(date, timeZone) {
  const out = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

/** Offset (ms) of a zone at a given instant: local = utc + offset. */
function zoneOffset(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert local wall-clock time in `timeZone` to a UTC Date. */
function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffset(new Date(guess), timeZone);
  let result = guess - offset;
  const second_ = zoneOffset(new Date(result), timeZone);
  if (second_ !== offset) result = guess - second_;
  return new Date(result);
}

/** Add whole days to an instant while keeping its local wall-clock time. */
function addLocalDays(date, days, timeZone) {
  const p = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: p.hour, minute: p.minute, second: p.second }, timeZone);
}

/** Local date key (YYYY-MM-DD) for grouping. */
function localDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const DAY = 86_400_000;

module.exports = { now, zonedParts, zonedToUtc, addLocalDays, localDateKey, DAY };
