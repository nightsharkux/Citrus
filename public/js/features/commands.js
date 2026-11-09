/**
 * Voice commands that need no AI: they run the moment they are heard, in German or English.
 *
 *   "open schedule" · "öffne Stundenplan" · "go to my inbox" · "dark mode" · "Dunkelmodus" · "new chat"
 *   "stop" · "stopp" · "stop listening" · "let's talk" · "lass uns reden" · "auf Deutsch" · "in English"
 *
 * A command only matches when the *whole* sentence is one of these shapes, so a question like "show me what's on
 * my calendar tomorrow" or "zeig mir, was morgen ansteht" still goes to the assistant, which can answer it and
 * act on it. Page names come from the menu (nav.js) plus the aliases below, in both languages.
 */
import { allItems } from '../nav.js';

const EXTRA_NAMES = {
  '/schedule': ['calendar', 'timetable', 'my schedule', 'my calendar', 'my timetable', 'stundenplan', 'mein stundenplan', 'kalender', 'mein kalender', 'terminplan'],
  '/home': ['home', 'dashboard', 'start', 'home screen', 'startseite', 'startbildschirm'],
  '/courses': ['courses', 'my courses', 'classes', 'teaching', 'my classes', 'kurse', 'meine kurse', 'lehrveranstaltungen', 'vorlesungen', 'lehre'],
  '/quiz': ['quiz', 'quizzes', 'my quizzes', 'quizze', 'meine quizze', 'tests', 'practice quiz'],
  '/learning': ['learning', 'study', 'review', 'revision', 'lernen', 'wiederholen', 'wiederholung'],
  '/inbox': ['inbox', 'notifications', 'my notifications', 'messages', 'postfach', 'benachrichtigungen', 'nachrichten', 'meine nachrichten'],
  '/campus': ['campus', 'campus life', 'campus feed', 'feed', 'events', 'campusleben', 'veranstaltungen'],
  '/campus/map': ['map', 'campus map', 'maps', 'lageplan', 'campusplan', 'karte', 'plan', 'campuskarte'],
  '/spaces': ['spaces', 'my spaces', 'rooms', 'workspaces', 'raume', 'meine raume', 'arbeitsraume', 'lernraume', 'gruppen'],
  '/settings': ['settings', 'preferences', 'my settings', 'einstellungen', 'meine einstellungen', 'konto', 'optionen'],
  '/tools': ['tools', 'all tools', 'features', 'werkzeuge', 'alle werkzeuge', 'funktionen'],
  '/participation': ['participation', 'check in', 'check-in', 'attendance', 'teilnahme', 'anwesenheit', 'einchecken'],
  '/career': ['career', 'career explorer', 'careers', 'karriere', 'berufsorientierung'],
  '/classroom': ['classroom', 'horsaal', 'klassenzimmer'],
  '/assistant': ['assistant', 'chat', 'assistent'],
};

/** Lower case, accents folded (ö becomes o, ß becomes ss), apostrophes dropped, anything else to spaces. */
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const ARTICLE = /^(?:the|my|der|die|das|dem|den|mein|meine|meinen|meinem)\s+/;
const POLITE = /^(?:(?:please|bitte|hey|hallo|ok|okay)\s+)*(?:(?:can|could|would) you\s+|(?:kannst|konntest|konntet|wurdest) du\s+)?(?:(?:please|bitte)\s+)?/;

function pageFor(target, role) {
  const wanted = norm(target).replace(ARTICLE, '').replace(/\s+(?:page|tab|screen|section|seite|bereich)$/, '');
  for (const item of allItems(role)) {
    const names = [item.label, ...(EXTRA_NAMES[item.href] || [])].map((n) => norm(n).replace(ARTICLE, ''));
    if (names.includes(wanted)) return item;
  }
  return null;
}

/**
 * Match a spoken sentence. Returns { say, run } or null.
 * `ctx` = { role, navigate, setTheme, stop, stopListening, talk?, setSpeechLanguage? }.
 */
export function matchCommand(text, ctx) {
  const t = norm(text).replace(POLITE, '').trim();
  if (!t) return null;

  // "open chat" still opens the assistant page (below); these start talking.
  if (ctx.talk && /^(?:lets talk|let us talk|talk to me|start (?:a )?(?:voice )?conversation|start (?:a )?voice chat|(?:start |open |use )?voice (?:mode|conversation|chat)|conversation mode|lass uns (?:reden|sprechen|quatschen)|sprich mit mir|(?:starte|offne) (?:ein )?(?:sprach)?gesprach|sprachmodus|gesprachsmodus)$/.test(t)) {
    return { say: 'I’m listening', run: () => ctx.talk() };
  }

  // The language the microphone listens for (it can only do one at a time).
  if (ctx.setSpeechLanguage) {
    if (/^(?:auf deutsch|deutsch|sprich deutsch|sprechen wir deutsch|wechsle zu deutsch|in german|speak german|german|switch to german|lets speak german)$/.test(t)) return { say: 'Voice input: Deutsch', run: () => ctx.setSpeechLanguage('de') };
    if (/^(?:in english|english|auf englisch|englisch|sprich englisch|sprechen wir englisch|speak english|switch to english|lets speak english)$/.test(t)) return { say: 'Voice input: English', run: () => ctx.setSpeechLanguage('en') };
    if (/^(?:automatisch|beide sprachen|both languages|automatic language|auto)$/.test(t)) return { say: 'Voice input: automatic', run: () => ctx.setSpeechLanguage('auto') };
  }

  if (/^(?:stop|stopp|cancel|abbrechen|be quiet|quiet|enough|genug|ruhe|sei still|shut up|never ?mind|vergiss es|thats enough|lass gut sein|halt)$/.test(t)) return { say: 'Stopped', run: () => ctx.stop() };
  if (/^(?:stop listening|go to sleep|sleep|turn off (?:hey )?\w+|turn off listening|stop hey \w+|hor auf zu horen|nicht mehr zuhoren|schlaf|geh schlafen|schlafen)$/.test(t)) return { say: 'Stopped listening', run: () => ctx.stopListening() };
  if (/^(?:new (?:chat|conversation)|start (?:a )?new (?:chat|conversation)|start over|clear (?:the )?chat|neues gesprach|neuer chat|neu anfangen|von vorn|von vorne)$/.test(t)) return { say: 'New conversation', run: () => ctx.navigate('/assistant?new=1') };

  const theme = /^(?:(?:switch|turn|change|go)(?: it)?(?: on| to)?\s+)?(?:the\s+)?(dark|light|system)(?: mode| theme)?$/.exec(t)
    || /^(?:use|enable)\s+(dark|light|system)(?: mode| theme)?$/.exec(t);
  const german = /^(?:(?:schalte|stell|stelle|wechsle|mach)(?: es| auf| zu| in| den| ein)*\s+)?(?:den\s+|auf\s+|zum\s+)?(?:(dunkel|hell|system)\s?(?:modus|darstellung)|(dunkler|heller) modus)(?: ein)?$/.exec(t);
  if (german) {
    const mode = german[1] ? ({ dunkel: 'dark', hell: 'light', system: 'system' })[german[1]] : german[2] === 'dunkler' ? 'dark' : 'light';
    return { say: mode === 'system' ? 'Theme follows your device' : `${mode[0].toUpperCase()}${mode.slice(1)} mode`, run: () => ctx.setTheme(mode) };
  }
  if (theme && (theme[1] !== 'system' || /mode|theme/.test(t))) {
    const mode = theme[1];
    return { say: mode === 'system' ? 'Theme follows your device' : `${mode[0].toUpperCase()}${mode.slice(1)} mode`, run: () => ctx.setTheme(mode) };
  }

  const open = /^(?:open|go to|go|show(?: me)?|take me to|navigate to|bring up|switch to|offne|geh(?:e)? zu|gehe|zeig(?:e)?(?: mir)?|bring mich zu|navigiere zu|wechsle zu)\s+(.+)$/.exec(t);
  if (open) {
    const item = pageFor(open[1], ctx.role);
    if (item) return { say: `Opening ${item.label}`, run: () => ctx.navigate(item.href) };
  }
  return null;
}
