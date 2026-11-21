'use strict';
/**
 * German is the language most people will use Citrus in, so every visible English text and every message the server
 * shows must have a German version. This scans the front end (text between tags, placeholders, labels, toasts,
 * titles and messages) and the server's error messages, and fails with the list of strings that have none.
 *
 * To fix a failure add the German to public/js/core/i18n-de-gaps.js (or the dictionary file of its area). If a
 * string is not interface text (a code fragment, sample content, a name), add it to IGNORE below.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

/** Not interface text: code the scan mistook for text, sample content, names, texts that already exist in both languages. */
const IGNORE_FILES = [/features[\\/]pitch\.js$/]; // the pitch is written in both languages on purpose
const IGNORE = new Set([
  "({ '&': '&amp;', '", '(acc', 'Google Maps', 'M. Mangena', 'MF2 lectern puck', 'Mensa, Weiden', 'Digital Technology and Management', 'Link (optional)', '(optional)',
  'https://moodle.oth-aw.de/course/view.php?id=…', 'Exercise sheet 3', 'e.g. Lena Meyer',
  'Week 5 · Sorting algorithms', 'Week 5: gradient descent', 'Project team, week 6', 'Algorithms and Data Structures', '.txt / .md',
  '(one record per line with title, content, category, sources, volatility) or a',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

const letters = (s) => (s.match(/[A-Za-z]/g) || []).length;
const looksLikeText = (s) => letters(s) >= 3 && /[a-z]/.test(s) && !/^[\w.\-/:#?&=%{}$]+$/.test(s) && !/^(true|false|null|undefined)$/.test(s)
  && !/[=<>]{2}|=>|function|\b(const|return|await)\b/.test(s)
  // what is left of a template's code: calls, operators, indexes
  && !/\)\)\}|&&|\|\||\?\s*['"]|\w\(.*\)\}|\[\w+\]\)\}|\.\w+\(|\bnow\b.*-|[<>]=?\s*\w+\s*&&|=\/g|, '&'/.test(s) && !/^[^A-Za-z]*[a-z]+\s*[-+*/&|<>=]/.test(s);

test('every visible English text and every server message has a German version', async () => {
  const i18n = await import(pathToFileURL(path.join(root, 'public/js/core/i18n.js')).href);
  const dict = await i18n.loadGerman();
  const known = (s) => dict.DE[s] !== undefined || i18n.translateWith('de', 'Citrus', s) !== s;

  const missing = new Map();
  const add = (s, file) => {
    s = s.replace(/\s+/g, ' ').trim();
    if (!looksLikeText(s) || IGNORE.has(s) || known(s)) return;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (!missing.has(s)) missing.set(s, rel);
  };

  const client = walk(path.join(root, 'public/js')).filter((f) => !/i18n/.test(f) && !IGNORE_FILES.some((re) => re.test(f)) && !/[\\/]core[\\/](markdown|pdf|math|icons)\.js$/.test(f));
  for (const file of client) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/>([^<>`$\n]{3,}?)</g)) add(m[1], file);
    for (const m of src.matchAll(/>\s*\n\s*([A-Z][^<>`$\n]{6,})\n\s*</g)) add(m[1], file);
    for (const m of src.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"$]{3,})"/g)) add(m[1], file);
    for (const m of src.matchAll(/\b(?:toast|toastError)\(\s*(['"`])((?:(?!\1)[^\\\n$]|\\.){3,})\1/g)) add(m[2], file);
    for (const m of src.matchAll(/\b(?:title|message|body|subtitle|label|confirmLabel|hint|text)\s*:\s*(['"`])((?:(?!\1)[^\\\n$]|\\.){4,})\1/g)) add(m[2], file);
  }

  // What the server says, shown as it comes.
  const server = walk(path.join(root, 'src')).filter((f) => /modules|http|services/.test(f.replace(/\\/g, '/')));
  for (const file of server) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:badRequest|forbidden|notFound|conflict|unauthorized|tooMany|unavailable|tooLarge)\(\s*(['"`])((?:(?!\1)[^\\\n$]|\\.){6,})\1/g)) add(m[2], file);
  }

  const list = [...missing].map(([s, f]) => `  ${f}: ${s}`);
  assert.equal(list.length, 0, `${list.length} texts have no German version (add them to public/js/core/i18n-de-gaps.js):\n${list.join('\n')}`);
});

test('the German agreement has the same parts and version as the English one, no blanks, and says it is binding', () => {
  const { agreementFor, VERSION } = require('../src/modules/legal/agreement');
  const de = agreementFor({ role: 'all', lang: 'de', institution: 'Beispiel-Hochschule' });
  const en = agreementFor({ role: 'all', lang: 'en', institution: 'Example University' });
  const headings = (t) => [...t.markdown.matchAll(/^(#{2,3}) /gm)].map((m) => m[1]);
  assert.deepEqual(headings(de), headings(en), 'the same sections in the same order');
  assert.equal(de.version, VERSION);
  assert.equal(en.version, VERSION);
  assert.equal(de.language, 'de');
  assert.match(de.markdown, /Maßgeblich ist die deutsche Fassung/);
  assert.match(en.markdown, /The German version is the binding one/);
  assert.doesNotMatch(de.markdown, /\[[A-Za-zÄÖÜäöü]/, 'no placeholder');
  assert.match(de.markdown, /eu-west-1 \(Irland\)/);
  assert.match(de.markdown, /Vercel, Dublin \(Irland\)/);
  assert.match(de.markdown, /365 Tage/);
  // Tables have the same shape in both languages.
  const rows = (t) => t.markdown.split('\n').filter((l) => /^\|/.test(l)).length;
  assert.equal(rows(de), rows(en), 'the same number of table rows');
  // No English sentence is left in the German text.
  assert.doesNotMatch(de.markdown, /\b(?:Your institution|the institution|You must|Part A)\b/);
});
