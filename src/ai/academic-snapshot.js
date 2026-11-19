'use strict';
/** Offline, page-aware retrieval. Source layouts are evidence, never normalized calendar events. */
const { readBundled } = require('../lib/bundled');
const { buildIndex, search } = require('../lib/search');
const { parsePage, parseLecturePeriods, describeTimetable, groupFrom } = require('./lecture-plan');

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const field = (text, key) => text.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1] || '';
const sections = (text, name) => text.split(`=== ${name} ===\n`)[1]?.split('\n=== ')[0] || '';
const codeFrom = (text) => text.match(/\/files\/oth-aw\/Studiengaenge\/(?:Bachelor|Master)\/([^/\s]+)\//i)?.[1]?.toUpperCase();

const STOP = new Set(['in', 'im', 'an', 'do', 'of', 'for', 'my', 'me', 'to', 'is', 'am', 'at', 'on', 'or', 'no']);
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, erstes: 1, zweites: 2, drittes: 3, viertes: 4, funftes: 5, sechstes: 6, siebtes: 7 };
function semesterIn(text) {
  const spoken = [...String(text).matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|erstes|zweites|drittes|viertes|f[uü]nftes|sechstes|siebtes)\s+semester/gi)]
    .map((m) => ({ index: m.index, 1: ORDINALS[m[1].toLowerCase().replace('ü', 'u')] }));
  const hits = [...String(text).matchAll(/(?:semester|sem\.?)\s*(\d{1,2})\b/gi), ...String(text).matchAll(/\b(\d{1,2})\s*(?:st|nd|rd|th|\.)?\s*semester/gi), ...spoken].sort((a, b) => a.index - b.index);
  const n = Number(hits.at(-1)?.[1]);
  return n >= 1 && n <= 12 ? n : null;
}

function parseSnapshot(input) {
  const text = String(input).replace(/\r\n/g, '\n');
  if (!/^(?:CITRUS|CAMPUSOS) \| OTH AMBERG-WEIDEN \| PUBLIC ACADEMIC DATA SNAPSHOT/.test(text) || !text.includes('END_OF_CORPUS')) throw new Error('Incomplete academic snapshot');
  const date = field(text, 'snapshot_date');
  const programmes = [...sections(text, 'PROGRAMME DIRECTORY AND DOCUMENT COVERAGE').matchAll(/^PROGRAMME_ID: (\w+)\n([\s\S]*?)(?=^PROGRAMME_ID: |$(?![\s\S]))/gm)].map((m) => {
    const body = m[2];
    return { id: m[1], code: codeFrom(body) || m[1], name: field(body, 'name'), level: field(body, 'degree_level'), body,
      sourceIds: [...new Set([...body.matchAll(/\b[SPI]\d{3}\b/g)].map((x) => x[0]))], url: field(body, 'source_url') };
  });
  // Keep degrees with the same abbreviation distinct in the profile/map selector.
  for (const p of programmes) {
    p.alias = p.code;
    if (programmes.some((other) => other !== p && other.code === p.code) && p.level === 'master') p.code += '-MA';
  }
  const timetables = [];
  const periods = parseLecturePeriods(sections(text, 'ACADEMIC CALENDAR: WEBPAGE TABLES'));
  const docs = [];
  function add(doc) {
    docs.push({ id: -100000 - docs.length, observed_on: date, volatility: 'snapshot', academic: true, ...doc });
  }
  for (const m of text.matchAll(/^BEGIN_SOURCE (\w+)\n([\s\S]*?)^END_SOURCE \1\s*$/gm)) {
    const [sourceId, body] = [m[1], m[2]];
    const header = body.split(/^BEGIN_PAGE /m)[0];
    const owners = programmes.filter((p) => p.sourceIds.includes(sourceId));
    const meta = { source_id: sourceId, source_url: field(header, 'source_url'), kind: field(header, 'kind'),
      programmes: owners.map((p) => p.code), category: 'Academic snapshot', title: field(header, 'title'),
      tags: owners.map((p) => `${p.code} ${p.name} ${p.level}`).join(' '), header };
    const pages = [...body.matchAll(/^BEGIN_PAGE (\d+) \| extraction=([^\n]+)\n([\s\S]*?)^END_PAGE \1\s*$/gm)];
    if (!pages.length) add({ ...meta, content: header, source_page: null });
    for (const page of pages) {
      const grid = meta.kind === 'lecture_timetable' ? parsePage(page[3]) : null;
      if (grid) timetables.push({ ...grid, sourceId, sourceTitle: meta.title, url: meta.source_url, page: Number(page[1]), programmes: meta.programmes });
      // Split only very long pages at line boundaries, retaining coordinates and horizontal spacing.
      const parts = []; let part = '';
      for (const line of page[3].split('\n')) {
        if (part && part.length + line.length > 24000) { parts.push(part); part = ''; }
        part += line + '\n';
      }
      if (part) parts.push(part);
      parts.forEach((content, i) => add({ ...meta, title: `${meta.title} — ${sourceId}, page ${page[1]}${parts.length > 1 ? `, part ${i + 1}/${parts.length}` : ''}`,
        content, source_page: Number(page[1]), extraction: page[2], partial_page: parts.length > 1,
        page_heading: page[3].slice(0, 650), part: i + 1, parts: parts.length }));
    }
  }
  for (const p of programmes) add({ source_id: p.id, source_url: p.url, title: `${p.name} (${p.level}) — document coverage`,
    category: 'Academic snapshot', kind: 'programme_directory', programmes: [p.code], tags: `${p.code} ${p.name}`, content: p.body });
  for (const [name, sourceId] of [['ACADEMIC CALENDAR: WEBPAGE TABLES', 'CAL-WEB'], ['ACADEMIC CALENDAR: MACHINE FEED EVENTS (2026 AND 2027)', 'CAL-ICS']]) {
    const body = sections(text, name);
    if (sourceId === 'CAL-WEB') add({ source_id: sourceId, source_url: field(body, 'source_url'), title: name, kind: 'academic_calendar', content: body, programmes: [] });
    else {
      // Group by year, retaining DTEND semantics and the conflict from the companion webpage.
      for (const year of ['2026', '2027']) {
        const rows = body.split('\n').filter((line) => line.startsWith('{') && JSON.parse(line).DTSTART.startsWith(year));
        add({ source_id: `${sourceId}-${year}`, source_url: field(body, 'source_url'), title: `${name} ${year}`, kind: 'academic_calendar', programmes: [],
          content: `DTEND is exclusive for date-only events.\n${sections(text, 'ACADEMIC CALENDAR: WEBPAGE TABLES').match(/^SOURCE_CONFLICT: .*$/m)?.[0] || ''}\n${rows.join('\n')}` });
      }
    }
  }
  return { date, programmes, docs, timetables, periods };
}

function createAcademicSnapshot({ root, file, read = readBundled }) {
  let data;
  const load = () => {
    if (!data) {
      data = parseSnapshot(read(root, file));
      data.indices = new Map();
    }
    return data;
  };
  function mentioned(text) {
    const raw = String(text || ''); const normalized = ` ${fold(raw)} `;
    return load().programmes.map((p) => {
      let position = normalized.lastIndexOf(` ${fold(p.name)} `);
      for (const m of raw.matchAll(/\b[A-Za-z][A-Za-z0-9-]{1,8}\b/g)) {
        if (![p.code, p.alias].includes(m[0].toUpperCase())) continue;
        if (STOP.has(m[0].toLowerCase())) continue;
        const stated = /(?:study|studying|studiere|studiengang|im|in|do|for|an|von|of)\s+$/i.test(raw.slice(0, m.index)) || /^\s*(?:student|semester|timetable|stundenplan)/i.test(raw.slice(m.index + m[0].length));
        if (m[0] === m[0].toUpperCase() || stated || (m[0].length >= 3 && !['edu', 'dib', 'ime'].includes(m[0].toLowerCase()))) position = Math.max(position, m.index);
      }
      return { code: p.code, position };
    }).filter((p) => p.position >= 0).sort((a, b) => b.position - a.position).map((p) => p.code);
  }
  function fromProfile(value) {
    const exact = load().programmes.filter((p) => fold(p.code) === fold(value));
    return exact.length ? exact.map((p) => p.code) : mentioned(value);
  }
  function intent(query) {
    const q = fold(query);
    if (/semesterbeginn|vorlesungszeit|ruckmeldung|prufungszeit|exam period|academic calendar|semester dates|registration|anmeldung|lecture free|vorlesungsfrei|christmas|weihnacht|corpus christi|fronleichnam/.test(q)) return 'academic_calendar';
    if (/exam|prufung|pruefung|klausur/.test(q)) return 'examination_schedule';
    if (/curricul|studienplan|study plan|ects|module|modul/.test(q)) return 'curriculum_plan';
    if (/timetable|schedule|stundenplan|lecture|vorlesung|classes|class|tomorrow|morgen|today|heute|right now|gerade/.test(q)) return 'lecture_timetable';
    return null;
  }
  function find(query, opts = {}) {
    const { limit = 6 } = opts;
    const profile = opts.profile || {};
    const d = load();
    const latest = String(query).split('\n').at(-1);
    const codes = mentioned(query);
    const chosen = codes[0] || fromProfile(profile.programme)[0];
    // A short follow-up ("im in group 2", "second semester") carries on the schedule question asked before it.
    const follow = /\b(group|gruppe|gr|semester|sem)\b/.test(fold(latest)) && latest.length < 80;
    const kind = intent(latest) || (follow ? intent(String(query).split('\n').slice(-6, -1).join(' ')) : null);
    if (!kind && !mentioned(latest).length) return [];
    const semester = semesterIn(query) || (chosen === fromProfile(profile.programme)[0] ? profile.semester : null);
    let lead = null;
    if (kind === 'lecture_timetable' && chosen) {
      const own = d.timetables.filter((t) => t.programmes.includes(chosen) || t.programme === chosen.replace(/-MA$/, ''));
      if (own.length) {
        const tt = semester ? own.find((t) => t.semester === Number(semester)) : null;
        const base = { id: -200000, academic: true, source_id: own[0].sourceId, source_url: own[0].url, kind: 'lecture_timetable', programmes: [chosen], category: 'Academic snapshot', observed_on: d.date, volatility: 'snapshot', score: 1000, extraction: 'parsed_grid' };
        if (tt) lead = { ...base, title: `${chosen} timetable, semester ${tt.semester} (parsed from the printed grid)`, source_page: tt.page, content: describeTimetable(tt, { now: opts.now || new Date(), group: groupFrom(query), periods: d.periods, sourceTitle: tt.sourceTitle, page: tt.page }) };
        else lead = { ...base, title: `${chosen} timetable: which semester?`, source_page: own[0].page, content: `The ${chosen} weekly timetable has pages for semesters ${own.map((t) => `${t.semester} (${t.term === 'SS' ? 'summer' : 'winter'} start)`).join(', ')}. The student's semester is not known. Ask which semester (and group, if the timetable has groups), then answer from that page. Do not guess.` };
      }
    }
    let docs = d.docs.filter((doc) => (!chosen || kind === 'academic_calendar' || doc.programmes.includes(chosen)) && (!kind || doc.kind.startsWith(kind)));
    if (!docs.length && chosen) docs = d.docs.filter((doc) => doc.kind === 'programme_directory' && doc.programmes.includes(chosen));
    const key = `${chosen || ''}:${kind || ''}`;
    if (!d.indices.has(key)) d.indices.set(key, buildIndex(docs));
    const ranked = search(d.indices.get(key), `${latest} ${chosen || ''}`, { limit: docs.length, minScore: 0 });
    for (const hit of ranked) {
      // Only an explicit printed page label is a semester match, never the page number or the document's year.
      if (semester && chosen && new RegExp(`\\b${chosen.replace(/-MA$/, '')}\\s*${Number(semester)}\\b`, 'i').test(hit.page_heading || '')) hit.score += 100;
      if (semester && new RegExp(`\\bSem\\.\\s*${Number(semester)}\\b`, 'i').test(hit.page_heading || '')) hit.score += 120;
      if (semester && new RegExp(`\\b${Number(semester)}\\.?\\s*(?:Semester|semester)\\b`).test(hit.page_heading || '')) hit.score += 50;
    }
    const rest = ranked.sort((a, b) => b.score - a.score);
    // The parsed grid goes first; the raw page stays behind it as the citation.
    return lead ? [lead, ...rest.slice(0, Math.max(1, limit - 1))] : rest.slice(0, limit);
  }
  function describe({ codes = [], semester } = {}) {
    const d = load();
    return [`Academic snapshot dated ${d.date}; not live or a personal enrolment record. Programme: ${codes.join(', ') || 'unknown'}; study semester: ${semester || 'unknown'}. Use the page-specific SOURCES, printed semester and entry cohort. Weekly class timetables parsed from the printed grid can be put into the user's calendar with calendar.classes; never copy class times by hand.`];
  }
  const handles = (query) => !!intent(String(query).split('\n').at(-1)) || mentioned(String(query).split('\n').at(-1)).length > 0;
  return { find, handles, mentioned, fromProfile, semesterIn, describe, programmes: () => load().programmes,
    // Layout/OCR documents cannot safely feed the map's normalized calendar-event interface.
    upcoming: () => [], semestersOf: () => [], count: () => load().docs.length, load };
}

module.exports = { parseSnapshot, createAcademicSnapshot, semesterIn };
