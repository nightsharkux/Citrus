'use strict';
/**
 * What the assistant knows about Citrus itself: the list of features, written from the same registry that fills the
 * "All tools" page (config/capabilities.js), for the role of the person it is talking to. When a feature is added to the
 * registry the assistant knows about it with no further change, and a feature that is not built is described as not built.
 */
const capabilities = require('../../config/capabilities');

const STATUS = {
  available: '',
  limited: ' (pilot)',
  configuration: ' (needs set-up by the university)',
  planned: ' (IN DEVELOPMENT: not built yet)',
};

/** What the German interface calls things, so a German question reaches the right feature and a German answer uses the app's own words. */
const GERMAN_NAMES = 'In German the app calls its pages: Lectures = Vorlesungen, Courses = Kurse, Teaching = Lehre, Schedule = Stundenplan, My progress = Mein Fortschritt, Meetings = Besprechungen, Documents = Dokumente, Quizzes = Quizze, Study groups = Lerngruppen, Campus life = Campusleben, Campus map = Campusplan, My tools = Meine Werkzeuge, Study sign = Lernschild, Inbox = Postfach, Settings = Einstellungen, All tools = Alle Werkzeuge. A break is a Pause and a chapter is a Kapitel. "Vorlesungen" is the Lectures page and "Kurse" the Courses page. Use these names when you answer in German.';

/** The first sentence of a description, at most `max` characters. */
function firstSentence(text, max = 170) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const end = s.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? s.slice(0, end + 1) : s;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** A feature written about one university (the OTH knowledge, timetables) is not offered to another university's people. */
const LOCAL = /\b(?:OTH|Amberg|Weiden|DTM)\b/;

/** The features this role can use, one line each: name, state, page, what it does. */
function featureLines(role, groups = capabilities, { university = '' } = {}) {
  const lines = [];
  const atOth = !university || LOCAL.test(university);
  for (const group of groups) {
    for (const f of group.items) {
      if (f.roles && !f.roles.includes(role)) continue;
      if (!atOth && LOCAL.test(`${f.label} ${f.description}`)) continue;
      lines.push(`- ${f.label}${STATUS[f.status] ?? ''}${f.route ? ` [${f.route}]` : ''}: ${firstSentence(f.description)}`);
    }
  }
  return lines;
}

/**
 * The block for the system prompt. It says what the assistant can do itself (the actions) and what it can only point to,
 * so it neither claims too little nor promises what it cannot do.
 */
function featureGuide(role, groups = capabilities, options = {}) {
  return [
    'WHAT CITRUS CAN DO. You are part of Citrus and you know it well. This is the list of its features for this person, with the page of each in brackets. Use it to answer "what can you do?", "is there a way to…?" and "where do I find…?" with the real feature and its page, and to suggest the right feature when it would help.',
    'You can open any of these pages yourself (action app.navigate) and carry out the actions listed under ACTIONS. A feature that is marked IN DEVELOPMENT is not built: say so, never pretend it works. For a feature you cannot start yourself, tell the person where it is and what to tap.',
    ...featureLines(role, groups, options),
    GERMAN_NAMES,
  ].join('\n');
}

module.exports = { featureGuide, featureLines, firstSentence };
