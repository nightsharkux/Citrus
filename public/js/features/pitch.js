/**
 * "What is Campus OS?" for presentations: after someone explains Campus OS, a line such as
 *
 *   "Now you probably didn't understand that, did you?"
 *   "In case that wasn't clear, hey Campus, could you please elaborate further?"
 *   "Hey Campus, explain what Campus OS is."
 *
 * makes Campus give its own short explanation of the core features, with an excited face (pitch-show.js). The
 * explanation is written here, not generated, so it works the same every time, with or without the AI or a network.
 *
 * Rules (tests/pitch.test.js), strict on purpose so that ordinary talk never sets it off:
 *   doubt       "you probably didn't understand that", "you didn't get that, did you": a question to the audience,
 *               enough on its own (in a lecture or meeting microphone only together with the wake word)
 *   unclear     "in case that wasn't clear" + a request to someone ("could you elaborate", "hey Campus")
 *   about       the wake word + "explain what Campus OS is", "introduce yourself", "tell them what you do"
 *   elaborate   the wake word + "elaborate (further)" when Campus has not just answered something else
 *               (then "elaborate" means that answer)
 *
 *   matchPitch(text, { recent, requireWake, answeredRecently, name })  → boolean (pure)
 *   notePitch(text, options)   remembers recent phrases, fires once (event "campus:pitch") → boolean
 */
import { wakeMatcher } from './wake-phrase.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  .replace(/[’'`´]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const NOT = '(?:did not|didnt|did nt|do not|dont|have not|havent)';
const GET = '(?:understand|get|follow|catch|grasp)';
const THAT = '(?:that|this|it|all that|all of that|any of that|a word of that|a thing|what i (?:just )?said|what i meant)';
const DOUBT = [
  new RegExp(`\\byou (?:probably|likely|most likely|surely|definitely|possibly|maybe|perhaps|still) ${NOT} (?:really |quite |fully |entirely |actually )?${GET} ${THAT}\\b`),
  new RegExp(`\\byou ${NOT} (?:really |quite |fully |actually )?${GET} ${THAT}(?: now| then| at all| either)?,? (?:did|do|have) you\\b`),
  // "didn't get that now, did you?" — but not "I didn't get that, did you?", which is someone asking a neighbour
  new RegExp(`(?<!\\bi )(?<!\\bwe )\\b${NOT} (?:really |quite )?${GET} ${THAT}(?: now| then| at all)? (?:did|do|have) (?:you|ya|yall)\\b`),
  /\bdu hast (?:das|es) (?:wahrscheinlich|bestimmt|sicher|vermutlich) nicht verstanden\b/,
  /\bihr habt (?:das|es) (?:wahrscheinlich|bestimmt|sicher|vermutlich) nicht verstanden\b/,
];
const UNCLEAR = [
  /\b(?:in case|just in case|if) (?:that|this|it|any of that|all of that|everything) (?:was not|wasnt|was nt|is not|isnt|was not quite|wasnt quite) (?:clear|clear enough|obvious|understandable)\b/,
  /\b(?:falls|wenn) (?:das|es) (?:nicht|noch nicht) (?:klar|ganz klar|verstandlich) (?:war|ist)\b/,
];
// A request to someone else, not "let me explain".
const ASK_YOU = /\b(?:(?:could|can|would|will|wont|might) you|please|bitte|kannst du|konntest du|wurdest du)\b[\s\w]{0,24}\b(?:elaborate|explain|clarify|break (?:it|that|this) down|go (?:into|in) (?:more )?detail|say (?:a bit |a little )?more|tell (?:them|us|everyone|the audience)|help (?:them|us) out|erklar|erlauter|genauer)/;
const ELABORATE = /\b(?:elaborate|erlauter|genauer erklar)\w*/;
const ABOUT = [
  /\b(?:explain|describe|present|tell (?:us|them|everyone|the audience|me|people))\b[\s\w]{0,30}\b(?:campus os|campusos|campus o s|what campus (?:os )?is|what you (?:are|do|can do)|this app|the app)\b/,
  /\b(?:what is|whats) campus ?os\b/,
  /\bintroduce yourself\b/,
  /\bstell dich (?:bitte |mal )?vor\b/,
  /\b(?:erklar|erzahl|beschreib)\w*\b[\s\w]{0,30}\b(?:campus os|campusos|was du (?:bist|kannst|machst)|was campus (?:os )?ist)\b/,
];

export function matchPitch(text, { recent = '', requireWake = false, answeredRecently = false, name = 'Campus' } = {}) {
  const now = norm(text);
  if (!now) return false;
  const all = norm(`${recent} ${text}`);
  const wake = wakeMatcher(name);
  const greeted = new RegExp(`\\b(?:hey|hi|hallo|hello|ok|okay|hit|hey there) ${norm(name).replace(/\s+/g, '\\s')}\\b`);
  const woke = !!wake.match(text) || greeted.test(now) || greeted.test(norm(recent));
  if (DOUBT.some((re) => re.test(all))) return !requireWake || woke;
  if (UNCLEAR.some((re) => re.test(all)) && (woke || ASK_YOU.test(now))) return !requireWake || woke;
  if (woke && ABOUT.some((re) => re.test(now))) return true;
  if (woke && ELABORATE.test(now) && !answeredRecently) return true;
  return false;
}

// ---- state for the app: the last few phrases, a pause after firing, and what Campus said last

const WINDOW_MS = 12_000;
const COOLDOWN_MS = 45_000;
let phrases = [];
let firedAt = 0;
let answeredAt = 0;
let assistant = 'Campus';

export const setPitchName = (name) => { assistant = name || 'Campus'; };
/** Call when Campus finishes saying something, so "elaborate" right after it means that answer. */
export const noteAnswered = () => { answeredAt = Date.now(); };

/** Check a heard phrase. Fires the presentation once (event "campus:pitch") and returns true when it matched. */
export function notePitch(text, { requireWake = false, now = Date.now() } = {}) {
  phrases = phrases.filter((p) => now - p.at < WINDOW_MS);
  const recent = phrases.map((p) => p.text).join(' ');
  phrases.push({ at: now, text: String(text || '') });
  if (now - firedAt < COOLDOWN_MS) return false;
  if (!matchPitch(text, { recent, requireWake, answeredRecently: now - answeredAt < 120_000, name: assistant })) return false;
  firedAt = now;
  phrases = [];
  globalThis.document?.dispatchEvent(new CustomEvent('campus:pitch'));
  return true;
}

/** Show it without voice (command palette, button). */
export function startPitch() {
  firedAt = Date.now();
  globalThis.document?.dispatchEvent(new CustomEvent('campus:pitch'));
}

/**
 * The explanation, a few sentences per card. `card` points at one of the core features on screen; null shows the
 * face alone. `mood` is the face's expression while that part is spoken.
 */
export const PITCH = {
  en: [
    { card: null, mood: 'excited', text: 'Gladly! Campus OS is a classroom assistant that follows the lecture together with you.' },
    { card: 'live', mood: 'speaking', text: 'While you teach, students tell it from their phones whether they are following, unsure or lost, and they can flag the exact moment they need help. Campus turns all of that into one live classroom status. It shows on the Campus Puck on your desk, green, amber or red, so you know straight away when something needs explaining again.' },
    { card: 'review', mood: 'speaking', text: 'After the lecture, the professor gets a summary of where the class struggled, minute by minute, together with what was being said at that moment, so it is clear which explanations to improve. And every student gets a private recap: where they got stuck, an explanation of each moment they flagged, and a quick quiz on it.' },
    { card: 'nfc', mood: 'speaking', text: 'Campus OS also tracks participation securely. Students tap the student ID they already carry, using its built-in NFC chip, on a reader, and the lecturer confirms the session. No lists, no paperwork.' },
    { card: 'ask', mood: 'happy', text: 'And on the side, anyone can simply ask me about their courses, timetables and the university, instead of digging through documents.' },
    { card: null, mood: 'excited', text: 'Better teaching, better understanding, and attendance without the paperwork. That is Campus OS!' },
  ],
  de: [
    { card: null, mood: 'excited', text: 'Sehr gern! Campus OS ist ein Assistent für den Hörsaal, der die Vorlesung mit dir zusammen verfolgt.' },
    { card: 'live', mood: 'speaking', text: 'Während der Vorlesung sagen die Studierenden über ihr Handy, ob sie mitkommen, unsicher sind oder den Faden verloren haben, und sie können genau die Stelle markieren, an der sie Hilfe brauchen. Daraus macht Campus einen Live-Status der ganzen Klasse. Er leuchtet auf dem Campus Puck am Pult, grün, gelb oder rot, damit man sofort sieht, wann etwas noch einmal erklärt werden sollte.' },
    { card: 'review', mood: 'speaking', text: 'Nach der Vorlesung bekommt die Professorin oder der Professor eine Übersicht, wo es Minute für Minute schwierig wurde und was in dem Moment gesagt wurde. So ist klar, welche Erklärungen besser werden können. Und alle Studierenden bekommen eine private Zusammenfassung: wo sie hängen geblieben sind, eine Erklärung zu jeder markierten Stelle und ein kurzes Quiz.' },
    { card: 'nfc', mood: 'speaking', text: 'Außerdem erfasst Campus OS die Teilnahme sicher. Die Studierenden halten ihren Studierendenausweis mit dem eingebauten NFC-Chip an ein Lesegerät, und die Lehrperson bestätigt die Sitzung. Keine Listen, kein Papier.' },
    { card: 'ask', mood: 'happy', text: 'Und nebenbei kann man mich einfach alles zu Kursen, Stundenplänen und der Hochschule fragen, statt in Dokumenten zu suchen.' },
    { card: null, mood: 'excited', text: 'Besser lehren, besser verstehen und Anwesenheit ohne Papierkram. Das ist Campus OS!' },
  ],
};

export const PITCH_CARDS = {
  en: [
    ['live', 'activity', 'Live classroom status', 'Students say how they follow and flag moments; the class status shows on the Campus Puck.'],
    ['review', 'trending', 'Better teaching and learning', 'Where the class struggled for the professor, a private recap and quiz for each student.'],
    ['nfc', 'nfc', 'Participation with your student ID', 'Tap the NFC chip already in the card; the lecturer confirms.'],
  ],
  de: [
    ['live', 'activity', 'Live-Status der Klasse', 'Studierende sagen, wie sie mitkommen, und markieren Stellen; der Status leuchtet auf dem Campus Puck.'],
    ['review', 'trending', 'Besser lehren und lernen', 'Wo es schwierig war, für die Lehrperson; eine private Zusammenfassung mit Quiz für alle Studierenden.'],
    ['nfc', 'nfc', 'Teilnahme mit dem Studierendenausweis', 'Den NFC-Chip im Ausweis antippen; die Lehrperson bestätigt.'],
  ],
};
