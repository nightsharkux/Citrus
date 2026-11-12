/**
 * Which phrases wake Campus ("Hey Campus"). Pure functions, tested in Node (tests/wake-phrase.test.js).
 *
 * Speech engines mishear the greeting as well as the name: "hey" comes back as "hit", "hate", "high" or "he",
 * and "Campus" as "Kampus", "Campos" or "compass". Waking by mistake is worse than missing a wake (Campus would
 * start answering a conversation it wasn't part of), so the rules widen what is heard only where an ordinary
 * sentence is unlikely:
 *
 *   clear greeting + name     anywhere in a phrase          "so, hey Campus, what's next?"
 *   misheard greeting + name  only at the start of a phrase "hit Campus, open my schedule"
 *   name alone                only at the start of a phrase "Campus, dark mode"
 *
 * After a misheard greeting or the bare name, the words that follow must not read like a sentence about the
 * place: "hit campus tomorrow", "campus is closed", "Campus library opens at 8" never wake it. A comma or colon
 * straight after the name ("Campus, is it raining?") always counts, because then the name is being addressed.
 *
 *   const wake = wakeMatcher('Campus');
 *   wake.match('hit campus open my schedule')   // { rest: 'open my schedule' }
 *   wake.match("let's hit campus tomorrow")     // null
 *   wake.isStop('Campus, stop')                 // true
 */

const CLEAR = ['hey', 'hay', 'hei', 'hai', 'hej', 'hi', 'hello', 'hallo', 'halo'];
// Greetings that are also filler words ("okay, campus is far"): anywhere, but only when a command follows.
const FILLER = ['okay', 'ok', 'yo', 'ey', 'servus', 'moin'];
// What "hey" turns into in speech recognition. Ordinary words, so they only count at the start of a phrase.
const MISHEARD = ['hit', 'hits', 'hid', 'heat', 'hate', 'hat', 'high', 'hy', 'he', 'hee', 'heh', 'eh', 'ay', 'aye', 'ei'];

// Words that make "<greeting> campus …" or "campus …" an ordinary sentence about going to, or being on, campus.
const PLACE_WORDS = [
  // going there: "hit campus tomorrow", "hit campus at nine"
  'tomorrow', 'today', 'tonight', 'later', 'early', 'again', 'first', 'together', 'after', 'before', 'at', 'by', 'around',
  'in', 'on', 'this', 'next', 'with', 'and', 'or', 'so', 'then', 'for', 'to', 'from', 'when', 'until', 'til', 'till',
  // talking about it: "campus is closed", "campus library", "campus life"
  'is', 'was', 'were', 'are', 'has', 'had', 'will', 'would', 'looks', 'seems', 'gets', 'got', 'life', 'map', 'maps',
  'library', 'card', 'tour', 'building', 'buildings', 'cafe', 'cafeteria', 'canteen', 'mensa', 'security', 'housing',
  'office', 'wifi', 'wlan', 'parking', 'area', 'grounds', 'shop', 'store', 'gym', 'police', 'events', 'news', 'radio',
  'os', 'west', 'east', 'north', 'south', 'amberg', 'weiden', 'side', 'party', 'visit', 'tours',
  // German: "Campus ist zu", "Campus Amberg", "Campusleben"
  'ist', 'war', 'hat', 'wird', 'sind', 'heute', 'morgen', 'bibliothek', 'karte', 'leben', 'gebaude', 'gebäude', 'in', 'im', 'am', 'zum', 'und',
];
const PLACE = new RegExp(`^(?:${[...new Set(PLACE_WORDS)].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const STOP = /^(?:stop|stopp|quiet|cancel|enough|shut up|be quiet|halt|genug|ruhe|sei still)\W*$/i;

/**
 * A pattern for an assistant name that accepts the usual recognition confusions
 * (c/k, u/o/a, doubled s: "Campos", "Kampus", "Compass").
 */
export function phonetic(name) {
  const plain = String(name || 'Campus').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/ph/g, 'f').replace(/[^a-z\s]/g, '').replace(/(.)\1+/g, '$1').trim() || 'campus';
  const vowel = { a: '[aeo]', e: '[eia]', i: '[iey]', o: '[oua]', u: '[uoaw]', y: '[iye]' };
  const letter = { c: '[ckq]', k: '[ckq]', q: '[ckq]', s: '[sz]{1,2}', z: '[sz]{1,2}', v: '[vwf]', w: '[vwf]', f: '[fv]', t: '[td]', d: '[td]', b: '[bp]', p: '[bp]', g: '[gk]', h: 'h?', j: '[jy]', x: '(?:x|[ck]s)' };
  return [...plain].map((c, i, all) => {
    if (c === ' ') return '\\s?';
    if (vowel[c]) return vowel[c] + (all[i + 1] && vowel[all[i + 1]] ? '?' : '');
    return letter[c] || c;
  }).join('');
}

const words = (list) => list.map((w) => w.replace(/\s+/g, '\\s+')).join('|');
const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * @param name   the assistant's name (a per-account setting)
 * @param strict for a microphone that hears a lecture: the bare name only counts when it is followed by a pause
 *               mark ("Campus, …"), since a lecturer may say the word in passing
 */
export function wakeMatcher(name = 'Campus', { strict = false } = {}) {
  const n = phonetic(name);
  const end = '(?=$|[\\s,.:;!?])';
  // Groups: [1] the name as heard, [2] a pause mark straight after it, [3] the rest of the phrase.
  const clear = new RegExp(`(?:^|[\\s,.!?])(?:${words(CLEAR)})[\\s,.!?]+(${n})${end}([,.:;!?]?)\\s*(.*)$`, 'i');
  const filler = new RegExp(`(?:^|[\\s,.!?])(?:${words(FILLER)})[\\s,.!?]+(${n})${end}([,.:;!?]?)\\s*(.*)$`, 'i');
  const misheard = new RegExp(`^\\W*(?:${words(MISHEARD)})[\\s,.!?]+(${n})${end}([,.:;!?]?)\\s*(.*)$`, 'i');
  const bare = new RegExp(`^\\W*(${n})${end}([,.:;!?]?)\\s*(.*)$`, 'i');
  // "'s" right after the name ("campus's") is about the place.
  const possessive = new RegExp(`${n}['’]s\\b`, 'i');

  /** The rest reads as a command, not as a sentence about the place. */
  const addressed = (pause, rest) => !!pause || !rest || !PLACE.test(rest);

  function match(text) {
    const said = tidy(text);
    if (!said) return null;
    let m = clear.exec(said);
    if (m) return { rest: tidy(m[3]), how: 'greeting' };
    if (possessive.test(said.slice(0, 40))) return null;
    m = filler.exec(said);
    if (m && addressed(m[2], m[3])) return { rest: tidy(m[3]), how: 'filler' };
    m = misheard.exec(said);
    if (m && addressed(m[2], m[3])) return { rest: tidy(m[3]), how: 'misheard' };
    m = bare.exec(said);
    if (m && (strict ? !!m[2] : addressed(m[2], m[3]))) return { rest: tidy(m[3]), how: 'name' };
    return null;
  }

  /** "Campus, stop" (or "hey Campus, stop") while Campus is talking. */
  function isStop(text) {
    const m = match(text);
    return !!m && STOP.test(m.rest);
  }

  /**
   * Whether a phrase still being spoken (an interim result) is enough to wake. A clear greeting is; after a
   * misheard greeting or the bare name, wait for the end of the phrase or two words after the name (so the first
   * one is whole), so "hit campus tomorrow" is not taken for a wake while "tomorrow" is still being heard.
   */
  function ready(found, final) {
    if (!found) return false;
    return found.how === 'greeting' || final || found.rest.split(' ').length >= 2;
  }

  return { match, isStop, ready };
}
