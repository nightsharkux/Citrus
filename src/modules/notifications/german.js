'use strict';
/**
 * Notifications are written once, in English, where something happens ("Lecture scheduled: Week 5"). A person whose
 * language is German gets the German version, in the inbox and in the push message on their phone. This is the one
 * place that knows the German wording of every notification; a message with no entry here is sent as written, and
 * tests/notifications-german.test.js fails when a notification is added without one.
 *
 * Each entry: [pattern for the English text, function that makes the German text from what the pattern captured].
 */
const TITLES = [
  [/^New lecturer request$/, () => 'Neue Anfrage für Dozierendenzugang'],
  [/^Your post is live$/, () => 'Dein Beitrag ist online'],
  [/^Matches your interests: (.+)$/s, (t) => `Passt zu deinen Interessen: ${t}`],
  [/^Post waiting for review$/, () => 'Beitrag wartet auf Prüfung'],
  [/^Your post was not approved$/, () => 'Dein Beitrag wurde nicht freigegeben'],
  [/^Lecture scheduled: (.+)$/s, (t) => `Vorlesung geplant: ${t}`],
  [/^New concept check in (.+)$/s, (c) => `Neue Verständnisfrage in ${c}`],
  [/^Card linked$/, () => 'Karte verknüpft'],
  [/^Confirm sign-in at (.+)$/s, (r) => `Anmeldung bestätigen: ${r}`],
  [/^(.+): study notes ready$/s, (t) => `${t}: Lernnotizen fertig`],
  [/^(.+) is live again$/s, (t) => `${t} ist wieder live`],
  [/^(.+) is live$/s, (t) => `${t} ist live`],
  [/^Notifications are working$/, () => 'Benachrichtigungen funktionieren'],
  [/^(.+): exam scheduled$/s, (c) => `${c}: Prüfung angesetzt`],
  [/^(.+): schedule updated$/s, (c) => `${c}: Stundenplan geändert`],
  [/^Lecturer access approved$/, () => 'Dozierendenzugang genehmigt'],
  [/^Lecturer request not approved$/, () => 'Anfrage für Dozierendenzugang nicht genehmigt'],
  [/^(.+) is also looking for a study group$/s, (who) => `${who === 'Another student' ? 'Eine andere Person' : who} sucht ebenfalls eine Lerngruppe`],
];

const BODIES = [
  [/^(.+) asked for lecturer access\.$/s, (n) => `${n} hat Dozierendenzugang angefragt.`],
  [/^Because you’re into (.+)\.$/s, (r) => `Weil dich interessiert: ${r}.`],
  [/^(.+)'s card is now linked\.$/s, (n) => `Die Karte von ${n} ist jetzt verknüpft.`],
  [/^You tapped your card\. Open Citrus to start the session\.$/, () => 'Du hast deine Karte gescannt. Öffne Citrus, um die Sitzung zu starten.'],
  [/^Key points, terms and self-check questions from the lecture\.$/, () => 'Kernpunkte, Begriffe und Selbsttest-Fragen aus der Vorlesung.'],
  [/^(.+)\. Open it to tell your lecturer how you're following\.$/s, (c) => `${c}. Öffne sie, um deiner Lehrperson zu sagen, wie du mitkommst.`],
  [/^You’ll get updates like this one\.$/, () => 'Du bekommst Updates wie dieses.'],
  [/^Sign out and back in to see your teaching tools\.$/, () => 'Melde dich ab und wieder an, um deine Lehrwerkzeuge zu sehen.'],
  [/^Contact your administrator if you think this is a mistake\.$/, () => 'Wende dich an deine Administration, wenn du glaubst, dass das ein Fehler ist.'],
];

function translate(list, text) {
  const s = String(text ?? '');
  for (const [re, make] of list) {
    const m = re.exec(s);
    if (m) return make(...m.slice(1));
  }
  return s;
}

/** The German version of a notification, or the message as it was when nothing in it has a German wording. */
function inGerman({ title, body, ...rest }) {
  return { ...rest, title: translate(TITLES, title), body: body === undefined ? body : translate(BODIES, body) };
}

/** True when the English text has a German wording here (the test uses it). */
const hasGermanTitle = (title) => translate(TITLES, title) !== String(title ?? '');
const hasGermanBody = (body) => !body || translate(BODIES, body) !== String(body);

module.exports = { inGerman, hasGermanTitle, hasGermanBody };
