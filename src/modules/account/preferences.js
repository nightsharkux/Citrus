'use strict';
/**
 * The settings a person can change about their own account: theme, language, what the assistant is called and
 * whether it listens for its name. One place validates them, so the settings page, the API and the assistant
 * (which changes them when asked in chat) all follow the same rules.
 */
const { badRequest } = require('../../http/errors');
const { oneOf } = require('../../lib/validate');

const LANGUAGES = ['en', 'de'];
const SPEECH_LANGUAGES = ['auto', 'en', 'de'];
/** What language answers come in: whatever the person wrote ('match'), or always German, or always English. */
const ANSWER_LANGUAGES = ['match', 'de', 'en'];
const THEMES = ['system', 'light', 'dark'];
/** One to three words of letters, digits, apostrophes and hyphens. The name goes into the assistant's instructions, so nothing else is allowed. */
const NAME = /^\p{L}[\p{L}\p{M}\p{N}'’-]*(?: [\p{L}\p{M}\p{N}'’-]+){0,2}$/u;

/** '' means "back to the default name". */
function cleanAssistantName(value) {
  const name = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  if (name.length > 24 || !NAME.test(name)) throw badRequest('Choose a name of up to 24 letters, for example Claudia.');
  return name;
}

/**
 * Validate the preferences present in `input` (anything else is ignored).
 * Returns the changes: a value to set, or null to remove the setting.
 */
function readPreferences(input = {}) {
  const changes = {};
  if (input.theme !== undefined) changes.theme = oneOf(input.theme, THEMES, 'Theme');
  if (input.voiceWake !== undefined) changes.voiceWake = !!input.voiceWake;
  if (input.visuals !== undefined) changes.visuals = !!input.visuals;
  if (input.matching !== undefined) changes.matching = !!input.matching;
  if (input.language !== undefined) changes.language = oneOf(input.language, LANGUAGES, 'Language');
  if (input.answerLanguage !== undefined) changes.answerLanguage = input.answerLanguage === 'match' ? null : oneOf(input.answerLanguage, ANSWER_LANGUAGES, 'Answer language');
  if (input.speechLanguage !== undefined) changes.speechLanguage = oneOf(input.speechLanguage, SPEECH_LANGUAGES, 'Speech language');
  if (input.focusUntil !== undefined) changes.focusUntil = cleanFocus(input.focusUntil);
  if (input.assistantName !== undefined) changes.assistantName = cleanAssistantName(input.assistantName) || null;
  return changes;
}

function applyPreferences(current, changes) {
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Citrus Focus: "do not disturb until". null (or a time already past) turns it off; otherwise a time up to 12 hours away.
 * While it lasts, notifications that are not urgent arrive silently in the inbox (no push, no pop-up).
 */
function cleanFocus(value) {
  if (value === null || value === false || value === '') return null;
  const at = Date.parse(value);
  const now = Date.now();
  if (!Number.isFinite(at)) throw badRequest('Choose when Focus should end.');
  if (at <= now) return null;
  if (at > now + 12 * 3600_000 + 60_000) throw badRequest('Focus can last up to 12 hours.');
  return new Date(at).toISOString();
}

/** True while the person has Citrus Focus on. */
const isFocused = (preferences, now = Date.now()) => Date.parse(preferences?.focusUntil || '') > now;

/** The name the assistant answers to for this person. */
const assistantNameFor = (user, site) => {
  const own = user?.preferences?.assistantName;
  // A saved value is checked again on every use, so a name stored before these rules existed cannot reach the prompt.
  return typeof own === 'string' && own.length <= 24 && NAME.test(own) ? own : site.assistant || 'Citrus';
};

module.exports = { isFocused, readPreferences, applyPreferences, cleanAssistantName, assistantNameFor, LANGUAGES, SPEECH_LANGUAGES, ANSWER_LANGUAGES };
