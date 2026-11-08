'use strict';
/**
 * BM25 full-text ranking for the knowledge library. Small, dependency-free and
 * good enough for a few thousand records. Replace with an embedding index in
 * src/ai/retrieval.js if you need semantic search.
 */
const STOPWORDS = new Set((
  'a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our ' +
  'so that the their then there these this to was we were what when where which who why will with you your ' +
  'der die das und ist im in den dem des ein eine einer zu mit von für auf an wie was wo wann ich du sie es nicht'
).split(' '));

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Very light stemming: enough to match "lectures"/"lecture", "exams"/"exam". */
function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function buildIndex(docs, fields = (d) => `${d.title} ${d.title} ${d.tags || ''} ${d.content}`) {
  const postings = new Map();
  const lengths = [];
  docs.forEach((doc, i) => {
    const terms = tokenize(fields(doc));
    lengths[i] = terms.length;
    const counts = new Map();
    for (const t of terms) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, tf] of counts) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([i, tf]);
    }
  });
  const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  return { docs, postings, lengths, avg };
}

/**
 * Words that mean the same in English and German (and the terms this university uses), so a question in one
 * language finds a page written in the other. Each line is one group; any member of a group in the question
 * also looks for the others, a little less strongly than the word itself.
 */
const SYNONYM_GROUPS = [
  'contact kontakt ansprechpartner ansprechperson erreichbarkeit',
  'email mail e-mail',
  'phone telefon tel telefonnummer',
  'office-hours sprechzeiten sprechstunde sprechzeit',
  'mentor mentoring mentorenprogramm mentorin patenprogramm tutor tutorium buddy',
  'timetable stundenplan stundenplane schedule',
  'exam examination pruefung pruefungen klausur klausuren pruefungsplan',
  'lecture lectures vorlesung vorlesungen lehrveranstaltung lehrveranstaltungen',
  'semester vorlesungszeit vorlesungszeiten semesterzeiten',
  'library bibliothek bib',
  'canteen mensa cafeteria gastronomie coffee-lounge',
  'map lageplan campusplan gelandeplan',
  'fee fees gebuhr gebuhren beitrag beitrage semesterbeitrag studiengebuhr studienservicegebuhr',
  'application apply bewerbung bewerben bewerbungsfrist',
  'enrolment enrollment matriculation immatrikulation einschreibung',
  'exmatriculation exmatrikulation deregistration',
  'thesis abschlussarbeit bachelorarbeit masterarbeit',
  'internship praktikum praxissemester praxisphase placement',
  'housing accommodation dormitory wohnen unterkunft wohnheim wohnung zimmer',
  'scholarship scholarships stipendium stipendien funding foerderung',
  'opening-hours offnungszeiten geoffnet',
  'dean dekan dekanin',
  'studiengangleiter studiengangsleiter studiengangsleitung studiengangleitung studiengangsleiterin director leader',
  'student-council fachschaft studierendenvertretung asta stuve',
  'station bahnhof train zug bahn bus',
  'parking parkplatz parkplatze',
  'wifi wlan eduroam',
  'moodle lms',
  'grades noten notenspiegel transcript',
  'certificate bescheinigung zeugnis nachweis',
  'international-office auslandsamt incoming outgoing exchange austausch erasmus',
  'language-centre sprachenzentrum sprachkurs',
  'german deutsch',
  'degree abschluss',
  'module modul course kurs fach',
  'professor prof dozent lecturer lehrende lehrender',
  'secretary sekretariat office buero',
  'career karriere berufseinstieg',
  'counselling advice beratung studienberatung',
  'sports sport hochschulsport',
  'tuition studiengebuhren',
  'room raum hoersaal hall lecture-hall',
  'deadline frist abgabe',
  'portal primuss myoth',
  'registration anmeldung ruckmeldung',
  'leave-of-absence beurlaubung urlaubssemester',
  'bus-schedule fahrplan',
];

const SYNONYMS = (() => {
  const map = new Map();
  for (const line of SYNONYM_GROUPS) {
    const group = line.split(' ').map((w) => tokenize(w.replace(/-/g, ' ')));
    for (let i = 0; i < group.length; i += 1) {
      for (const token of group[i]) {
        if (!map.has(token)) map.set(token, new Set());
        group.forEach((other, j) => j !== i && other.forEach((t) => t !== token && map.get(token).add(t)));
      }
    }
  }
  return map;
})();

/** Edit distance where swapping two neighbouring letters counts as one slip ("Banhof" for "Bahnhof"). */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j += 1) rows[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

/** Terms in the index that a query word probably meant: spelling slips, and longer German compounds that start with it. */
function similar(index, term) {
  if (term.length < 4) return [];
  index.vocabulary ||= [...index.postings.keys()];
  const max = term.length >= 8 ? 2 : 1;
  const found = [];
  for (const candidate of index.vocabulary) {
    if (candidate === term) continue;
    if (term.length >= 6 && candidate.length > term.length && candidate.startsWith(term)) found.push([candidate, 0.55]);
    else if (candidate[0] === term[0] && distance(term, candidate, max) <= max) found.push([candidate, 0.6]);
  }
  return found.slice(0, 12);
}

function search(index, query, { limit = 5, k1 = 1.4, b = 0.75, minScore = 0.5 } = {}) {
  const base = [...new Set(tokenize(query))];
  if (!base.length || !index.docs.length) return [];
  // term -> weight. The question's own words count fully; synonyms and near-misses count less.
  const weights = new Map(base.map((t) => [t, 1]));
  const widen = (term, weight) => weights.set(term, Math.max(weights.get(term) || 0, weight));
  for (const term of base) {
    for (const other of SYNONYMS.get(term) || []) widen(other, 0.7);
    if (!index.postings.has(term)) for (const [near, w] of similar(index, term)) widen(near, w);
  }
  const scores = new Map();
  const N = index.docs.length;
  for (const [term, weight] of weights) {
    const list = index.postings.get(term);
    if (!list) continue;
    const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const [i, tf] of list) {
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * index.lengths[i] / index.avg));
      scores.set(i, (scores.get(i) || 0) + idf * norm * weight);
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s >= minScore)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([i, score]) => ({ ...index.docs[i], score: Math.round(score * 100) / 100 }));
}

module.exports = { tokenize, buildIndex, search, distance };
