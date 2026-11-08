'use strict';
/**
 * iCalendar (RFC 5545) import and export — the subset universities actually
 * publish: VEVENT with SUMMARY/LOCATION/DESCRIPTION, DTSTART/DTEND (UTC,
 * TZID or all-day), weekly RRULE with UNTIL/COUNT/INTERVAL, and EXDATE.
 */
const { zonedToUtc } = require('./time');

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const part of paramParts) {
    const [k, v = ''] = part.split('=');
    params[k.toUpperCase()] = v.replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escapeText = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Parse an ICS date/time value to a UTC Date. Floating times use `fallbackZone`. */
function parseDate(value, params, fallbackZone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const parts = { year: +y, month: +mo, day: +d, hour: h ? +h : 0, minute: mi ? +mi : 0, second: s ? +s : 0 };
  if (z) return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const zone = params.TZID || fallbackZone;
  try {
    return zonedToUtc(parts, zone);
  } catch {
    return zonedToUtc(parts, fallbackZone);
  }
}

/**
 * @returns {Array<{uid,title,location,notes,starts,ends,repeatWeeks,until,count,exdates,allDay}>}
 */
function parseIcs(text, { timeZone = 'Europe/Berlin' } = {}) {
  const events = [];
  let current = null;
  for (const raw of unfold(text)) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      current = { exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.starts) {
        if (!current.ends) current.ends = new Date(current.starts.getTime() + (current.allDay ? 86_400_000 : 3_600_000));
        events.push(current);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': current.uid = prop.value.trim(); break;
      case 'SUMMARY': current.title = unescapeText(prop.value).trim(); break;
      case 'LOCATION': current.location = unescapeText(prop.value).trim(); break;
      case 'DESCRIPTION': current.notes = unescapeText(prop.value).trim(); break;
      case 'DTSTART':
        current.starts = parseDate(prop.value, prop.params, timeZone);
        current.allDay = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(prop.value.trim());
        break;
      case 'DTEND': current.ends = parseDate(prop.value, prop.params, timeZone); break;
      case 'EXDATE':
        for (const v of prop.value.split(',')) {
          const d = parseDate(v, prop.params, timeZone);
          if (d) current.exdates.push(d.toISOString());
        }
        break;
      case 'RRULE': {
        const rule = Object.fromEntries(prop.value.split(';').map((kv) => kv.split('=')));
        if (rule.FREQ === 'WEEKLY') {
          current.repeatWeeks = Math.max(1, Number(rule.INTERVAL || 1));
          if (rule.UNTIL) current.until = parseDate(rule.UNTIL, {}, timeZone);
          if (rule.COUNT) current.count = Number(rule.COUNT);
        }
        break;
      }
      default:
        break;
    }
  }
  return events.map((e) => ({
    uid: e.uid || null,
    title: e.title || 'Untitled event',
    location: e.location || '',
    notes: e.notes || '',
    starts: e.starts.toISOString(),
    ends: e.ends.toISOString(),
    repeatWeeks: e.repeatWeeks || 0,
    until: e.until ? e.until.toISOString() : null,
    count: e.count || null,
    exdates: e.exdates,
    allDay: !!e.allDay,
  }));
}

const icsStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Serialise expanded occurrences. Using UTC per-occurrence avoids DST surprises in clients. */
function toIcs(occurrences, { name = 'Campus OS', host = 'campusos.local' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Campus OS//Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  const stamp = icsStamp(new Date().toISOString());
  for (const o of occurrences) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${o.key}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(o.starts)}`,
      `DTEND:${icsStamp(o.ends)}`,
      `SUMMARY:${escapeText(o.title)}`,
      ...(o.location ? [`LOCATION:${escapeText(o.location)}`] : []),
      ...(o.notes ? [`DESCRIPTION:${escapeText(o.notes)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function foldLine(line) {
  if (line.length <= 74) return line;
  const parts = [];
  for (let i = 0; i < line.length; i += 73) parts.push((i ? ' ' : '') + line.slice(i, i + 73));
  return parts.join('\r\n');
}

module.exports = { parseIcs, toIcs };
