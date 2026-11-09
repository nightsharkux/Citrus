/**
 * The German dictionary: exact English strings from the interface and their German, plus patterns for the strings
 * that carry a number or a name. See i18n.js. To translate a new string, add it to the file for its area.
 */
import shell from './i18n-de-shell.js';
import pages from './i18n-de-pages.js';
import staff from './i18n-de-staff.js';
import more from './i18n-de-more.js';
import learn from './i18n-de-learn.js';

export const DE = {
  'From your saved schedule. Ask the assistant about programme timetables.': 'Aus deinem gespeicherten Stundenplan. Studiengangspläne findest du beim Assistenten.',
  'Ask about a programme timetable': 'Nach einem Studiengangsplan fragen',
  'Answer language': 'Antwortsprache',
  'Follow my language': 'Meiner Sprache folgen',
  'You can switch languages or mix German and English in any conversation.': 'Du kannst jederzeit die Sprache wechseln oder Deutsch und Englisch mischen.',
  'Translate page to English': 'Seite ins Englische übersetzen',
  'Translate page to German': 'Seite ins Deutsche übersetzen',
  'Translating…': 'Wird übersetzt…',
  'No text to translate': 'Kein Text zum Übersetzen vorhanden',
  'Message not found': 'Nachricht nicht gefunden',
  'The translation is too long. Select a shorter passage and try again.': 'Die Übersetzung ist zu lang. Wähle einen kürzeren Abschnitt und versuche es erneut.',
  ...staff,
  ...more,
  ...learn,
  ...pages,
  ...shell,
  // Messages the server sends.
  'Please sign in': 'Bitte melde dich an',
  'You do not have access to this': 'Darauf hast du keinen Zugriff',
  'Too many requests. Please wait a moment.': 'Zu viele Anfragen. Bitte warte einen Moment.',
  'Please allow a minute before sending more AI requests': 'Bitte warte eine Minute, bevor du weitere KI-Anfragen sendest',
  'Conversation not found': 'Gespräch nicht gefunden',
  'Invalid request': 'Ungültige Anfrage',
  'Tomorrow': 'Morgen',
  'Yesterday': 'Gestern',
  'on': 'an',
  'off': 'aus',
};

const NOUNS = {
  student: ['Studierende/r', 'Studierende'], 'check-in': ['Check-in', 'Check-ins'], response: ['Antwort', 'Antworten'], note: ['Notiz', 'Notizen'],
  member: ['Mitglied', 'Mitglieder'], post: ['Beitrag', 'Beiträge'], question: ['Frage', 'Fragen'], 'new suggestion': ['neuer Vorschlag', 'neue Vorschläge'],
  report: ['Meldung', 'Meldungen'], 'lecturer request': ['Dozierendenanfrage', 'Dozierendenanfragen'], entry: ['Eintrag', 'Einträge'], entries: ['Eintrag', 'Einträge'],
  course: ['Kurs', 'Kurse'], topic: ['Thema', 'Themen'], line: ['Zeile', 'Zeilen'], device: ['Gerät', 'Geräte'], day: ['Tag', 'Tage'], file: ['Datei', 'Dateien'],
};
const noun = (word, n) => {
  const [one, many] = NOUNS[word.replace(/s$/, '').toLowerCase()] || NOUNS[word.toLowerCase()] || [word, word];
  return Number(n) === 1 ? one : many;
};
const VALUES = { on: 'an', off: 'aus', faster: 'schneller', slower: 'langsamer', automatic: 'automatisch', 'back to the default': 'wieder Standard', female: 'weiblich', male: 'männlich', 'when I speak': 'wenn ich spreche', 'every answer': 'jede Antwort', never: 'nie', natural: 'natürlich', calm: 'ruhig', bright: 'hell', deep: 'tief', quick: 'schnell', light: 'hell', dark: 'dunkel', system: 'System' };
const value = (v) => VALUES[v] ?? v;

/** [regex, builder]. The first match wins. */
export const PATTERNS = [
  [/^Partly right · (\d+)%$/, (n) => `Teilweise richtig · ${n} %`],
  [/^Practise my (?:(\d+) )?mistakes?$/, (n) => (n ? `Meine ${n} Fehler üben` : 'Meinen Fehler üben')],
  [/^([\d.]+) of (\d+) points\.(.*)$/, (a, b, rest) => `${a} von ${b} Punkten.${rest ? ' Die verpassten Fragen sind auch in deiner Wiederholungsliste.' : ''}`],
  [/^Tutor · Question (\d+)$/, (n) => `Tutor · Frage ${n}`],
  [/^(\d+) questions · (.+)$/, (n, when) => `${n} Fragen · ${when}`],
  [/^Practise with questions (\S+) writes for you: eight kinds of question, instant feedback, and a tutor for every question\.$/, (name) => `Übe mit Fragen, die ${name} für dich schreibt: acht Fragearten, sofortiges Feedback und ein Tutor für jede Frage.`],
  [/^Web search automatic: (\S+) searches when it needs to$/, (name) => `Websuche automatisch: ${name} sucht, wenn es nötig ist`],
  [/^From the web: (.+)$/, (site) => `Aus dem Web: ${site}`],
  [/^Play (.+)$/, (name) => `${name} abspielen`],
  [/^How (\S+) sounds\. Talk hands-free with the waveform button in the assistant, or say “Hey (\S+), let’s talk”\.$/, (name, hey) => `So klingt ${name}. Sprich ohne Hände über den Wellen-Knopf im Assistenten oder sag „Hey ${hey}, lass uns reden“.`],
  [/^(\d+) (students?|check-ins?|responses?|notes?|members?|posts?|questions?|new suggestions?|reports?|lecturer requests?|entry|entries|courses?|topics?|lines?|devices?|days?|files?)$/, (n, w) => `${n} ${noun(w, n)}`],
  [/^Hi (.+), what can I help with\?$/, (name) => `Hallo ${name}, wobei kann ich helfen?`],
  [/^Ask (\S+)$/, (name) => `${name} fragen`],
  [/^Ask (\S+)…$/, (name) => `${name} fragen…`],
  [/^Message (\S+), or paste a picture$/, (name) => `Schreib ${name} – oder füge ein Bild ein`],
  [/^Message (\S+)$/, (name) => `Nachricht an ${name}`],
  [/^Talk to (\S+)$/, (name) => `Mit ${name} sprechen`],
  [/^Talk to (\S+): a hands-free voice conversation$/, (name) => `Mit ${name} sprechen: ein Sprachgespräch ohne Hände`],
  [/^Opening (.+)$/, (page) => `Öffne ${page}`],
  [/^(.+) is asleep until an AI model is connected\.$/, (name) => `${name} schläft, bis ein KI-Modell verbunden ist.`],
  [/^Say “Hey (.+)” on any page\. Answers are read aloud\.$/, (name) => `Sag auf jeder Seite „Hey ${name}“. Antworten werden vorgelesen.`],
  [/^(.+) is listening for “Hey (.+)”\.$/, (name, hey) => `${name} hört auf „Hey ${hey}“.`],
  [/^(.+) stopped listening\.$/, (name) => `${name} hört nicht mehr zu.`],
  [/^Active (.+)$/, (when) => `Aktiv ${when}`],
  [/^Connected as (.+) on (.+)$/, (who, site) => `Verbunden als ${who} auf ${site}`],
  [/^On for (\d+) devices?\.$/, (n) => `An für ${n} ${noun('device', n)}.`],
  [/^Model: (.+)\.$/, (m) => `Modell: ${m}.`],
  [/^Version (.+) · (.+)$/, (v, i) => `Version ${v} · ${i}`],
  [/^Name: (.+)$/, (v) => `Name: ${value(v)}`],
  [/^Language: (.+)$/, (v) => `Sprache: ${v}`],
  [/^Answers in: (.+)$/, (v) => `Antwortsprache: ${v === 'the language you write' ? 'Meiner Sprache folgen' : v}`],
  [/^Speech recognition: (.+)$/, (v) => `Spracherkennung: ${value(v)}`],
  [/^Listening for the name: (.+)$/, (v) => `Auf den Namen hören: ${value(v)}`],
  [/^Animated explanations: (.+)$/, (v) => `Animierte Erklärungen: ${value(v)}`],
  [/^Opportunity matching: (.+)$/, (v) => `Passende Angebote: ${value(v)}`],
  [/^Theme: (.+)$/, (v) => `Darstellung: ${value(v)}`],
  [/^Voice speed: (.+)$/, (v) => `Sprechtempo: ${value(v)}`],
  [/^Voice style: (.+)$/, (v) => `Stimmstil: ${value(v)}`],
  [/^Voice: (.+)$/, (v) => `Stimme: ${value(v)}`],
  [/^Read aloud: (.+)$/, (v) => `Vorlesen: ${value(v)}`],
  [/^From your schedule and the official (S+) timetable(?:, semester (d+))?.$/, (p, n) => `Aus deinem Stundenplan und dem offiziellen ${p}-Stundenplan${n ? `, Semester ${n}` : ''}.`],
  [/^Dark mode$/, () => 'Dunkelmodus'],
  [/^Light mode$/, () => 'Hellmodus'],
  [/^Theme follows your device$/, () => 'Die Darstellung folgt deinem Gerät'],
  [/^Next: (.+)$/, (v) => `Als Nächstes: ${v}`],
  [/^You are about (.+) from the nearest campus \((.+)\)\.$/, (d, c) => `Du bist etwa ${d} vom nächsten Campus (${c}) entfernt.`],
  [/^From (Bahnhof .+)$/, (s) => `Ab ${s}`],
  [/^Getting to (.+)$/, (c) => `Anreise nach ${c}`],
  [/^Nearest bus stops: (.+)\.$/, (s) => `Nächste Bushaltestellen: ${s}.`],
  [/^Room (.+) does not say which building it is in\. Look for it on the campus plan\.$/, (r) => `Bei Raum ${r} steht nicht, in welchem Gebäude er liegt. Schau auf dem Lageplan nach.`],
];
