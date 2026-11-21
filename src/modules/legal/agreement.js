'use strict';
/**
 * Terms of Use and Privacy (Nutzungsbedingungen und Datenschutz): what everyone accepts to use Citrus, and again
 * whenever it changes. Students, guests, lecturers and administrators each get their own version, in four sections
 * like a website's legal pages: terms of use, privacy policy, cookie policy, data retention.
 *
 *   policy-de.js   the German text, which is the binding one
 *   policy-en.js   the English translation, same sections
 *
 * Changing the text in a way that matters means changing VERSION: everyone is then asked to read and accept it
 * again before using the app (until they do they can read it, download their data or delete their account).
 *
 * The text names the institution and its contacts from the institution's own settings (Admin → Institution →
 * Legal details); where those are not entered it says so in plain words instead of showing a blank. The retention
 * periods it states are the institution's real settings.
 */
const de = require('./policy-de');
const en = require('./policy-en');

const VERSION = '2026-11-21.2';
const UPDATED = '2026-11-21';

/** What the app does today, as built: where each service runs. Update this and VERSION when it changes. */
const HOSTING = {
  de: { app: 'Vercel, Dublin (Irland)', database: 'Turso, auf Amazon Web Services in der Region eu-west-1, Dublin (Irland)', files: 'Vercel Blob, Dublin (Irland)' },
  en: { app: 'Vercel, Dublin (Ireland)', database: 'Turso, on Amazon Web Services in the eu-west-1 region, Dublin (Ireland)', files: 'Vercel Blob, Dublin (Ireland)' },
};

const ROLES = ['student', 'guest', 'lecturer', 'admin'];
const TITLE = { de: 'Nutzungsbedingungen und Datenschutz', en: 'Terms of Use and Privacy' };

/**
 * The agreement for one role in German (the default, and the binding text) or English (`lang: 'en'`).
 * `role`: 'student' | 'guest' | 'lecturer' | 'admin'. Both languages have the same sections and the same VERSION:
 * accepting means accepting the agreement, not a language.
 */
function agreementFor({ role = 'student', institution, legal = {}, lectureTextRetentionDays = 365, lang = 'de' } = {}) {
  const language = lang === 'en' ? 'en' : 'de';
  const r = ROLES.includes(role) ? role : 'student';
  const text = (language === 'en' ? en : de).build({
    role: r,
    institution: institution || (language === 'en' ? 'your institution' : 'Ihre Einrichtung'),
    legal,
    lectureTextRetentionDays,
    hosting: HOSTING[language],
    VERSION,
    UPDATED,
  });
  const markdown = text.sections.map((s) => `## ${s.title}\n\n${s.markdown}`).join('\n\n');
  return { version: VERSION, updated: UPDATED, role: r, roleLabel: text.roleLabel, language, title: TITLE[language], summary: text.summary, sections: text.sections, markdown };
}

module.exports = { agreementFor, VERSION, UPDATED, HOSTING, ROLES };
