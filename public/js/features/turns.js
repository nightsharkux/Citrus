/**
 * Turn-taking for a spoken conversation. No browser APIs here, so it is tested
 * directly (tests/voice-conversation.test.js).
 *
 *   endOfTurnDelay(text, { final })    how long a silence means "your turn, Campus"
 *   isEcho(heard, spoken)              the microphone is hearing Campus's own voice
 *   isInterruption(heard, spoken, …)   the user is talking over Campus
 *   conversationCommand(text)          'end' | 'interrupt' | null
 *   speakBoundary(buffer, final)       where the next spoken piece of a streamed answer ends
 *
 * Speech recognition gives no punctuation and no "finished" signal that can be
 * trusted, so the end of a turn is a pause whose length depends on how the
 * sentence ends: "what's on my schedule for" is still going, "yes" is done.
 */

/** Lower case, accents folded, apostrophes dropped, punctuation to spaces. */
export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (text) => {
  const t = normalise(text);
  return t ? t.split(' ') : [];
};

// Words a sentence rarely ends on: the speaker is pausing to think, not finished.
const TRAILING = new Set([
  'and', 'or', 'but', 'so', 'because', 'cause', 'then', 'if', 'when', 'while', 'that', 'which', 'who', 'where',
  'the', 'a', 'an', 'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'into', 'about', 'than', 'as',
  'my', 'your', 'our', 'their', 'is', 'are', 'was', 'were', 'be', 'can', 'could', 'should', 'would', 'will',
  'um', 'umm', 'uh', 'uhm', 'erm', 'er', 'hmm', 'like', 'maybe', 'also', 'plus', 'whats', 'how', 'what',
  'und', 'oder', 'aber', 'weil', 'dass', 'wenn', 'der', 'die', 'das', 'ein', 'eine', 'mit', 'von', 'zu', 'fur', 'mein', 'meine', 'ahm',
]);
// Complete answers on their own, so there is no need to wait long.
const SHORT_REPLIES = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'sure', 'thanks', 'thank you', 'go on', 'continue', 'go ahead',
  'why', 'how', 'really', 'right', 'correct', 'exactly', 'please', 'ja', 'nein', 'danke', 'genau', 'weiter',
]);

/**
 * Milliseconds of silence after which the user has finished speaking.
 * `final`: the speech service has closed the phrase (it does after a short pause).
 * Null when nothing was said.
 */
export function endOfTurnDelay(text, { final = false } = {}) {
  const list = words(text);
  if (!list.length) return null;
  let wait = final ? 1000 : 1600;
  const phrase = list.join(' ');
  if (TRAILING.has(list[list.length - 1])) wait += 1000;
  else if (SHORT_REPLIES.has(phrase)) wait -= 350;
  else if (list.length < 3) wait += 300;
  return wait;
}

/** Word stems of what Campus said, for comparing with what the microphone heard. */
const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);

/** How much of `heard` is new compared with `spoken`: { total, novel }. */
export function overlap(heard, spoken) {
  const vocabulary = new Set(words(spoken).map(stem));
  const list = words(heard);
  return { total: list.length, novel: list.filter((w) => !vocabulary.has(stem(w))).length };
}

/** True when the microphone most likely picked up Campus's own voice (most words were in what it said). */
export function isEcho(heard, spoken) {
  const { total, novel } = overlap(heard, spoken);
  return total > 0 && novel <= Math.floor(total * 0.25);
}

const INTERRUPT = /^(?:(?:hey|ok|okay)\s+)?(?:campus\s+)?(?:stop(?: it| talking| there)?|wait(?: a (?:second|moment|minute))?|hold on|hang on|one (?:moment|second|sec)|excuse me|sorry|no no|pause|enough|thats enough|be quiet|quiet|shush|shh|cancel|never ?mind|forget it|halt|stopp|warte|moment)(?:\s+(?:please|campus|a second))*$/;

/**
 * The user is talking over Campus (and it is not Campus hearing itself).
 * A short stop word counts at once, unless Campus just said that word; other
 * speech needs a few words that Campus did not say.
 */
export function isInterruption(heard, spoken, { final = false } = {}) {
  const phrase = words(heard).join(' ');
  if (!phrase) return false;
  const { total, novel } = overlap(heard, spoken);
  if (INTERRUPT.test(phrase)) return novel > 0;
  if (novel >= 3 && novel / total >= 0.4) return true;
  return final && novel >= 2 && novel / total >= 0.5;
}

const END = /^(?:(?:ok|okay|alright|right|thanks|thank you|cheers|great|perfect|that was helpful)\s+)*(?:(?:good ?)?bye(?: bye)?|see you(?: later)?|thats all|that is all|thats it|thats everything|im done|i am done|were done|end(?: the)? (?:conversation|call|chat|voice mode)|stop(?: the)? conversation|hang up|exit(?: voice mode)?|close(?: voice mode)?|stop listening|go to sleep|tschuss|auf wiedersehen|ende)(?:\s+(?:campus|then|now|for now|thanks|thank you))*$/;

/** Spoken control phrases: 'end' (finish the conversation), 'interrupt' (be quiet / never mind), or null for anything else. */
export function conversationCommand(text) {
  const phrase = words(text).join(' ');
  if (!phrase) return null;
  if (END.test(phrase)) return 'end';
  if (INTERRUPT.test(phrase)) return 'interrupt';
  return null;
}

/**
 * Where the next spoken piece of a streaming answer ends: the end of a sentence
 * or paragraph outside code and display formulas, at least a short sentence
 * long. Returns an index into `buffer`, or -1 to wait for more text. `final`:
 * no more text is coming, so the rest is one piece.
 */
export function speakBoundary(buffer, final = false) {
  let fence = false;
  let display = false;
  let boundary = -1;
  let lastSoft = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.startsWith('```', i)) {
      fence = !fence;
      i += 2;
      continue;
    }
    if (fence) continue;
    if (buffer.startsWith('$$', i)) {
      display = !display;
      i += 1;
      continue;
    }
    if (display) continue;
    const c = buffer[i];
    const next = buffer[i + 1];
    // "1." at the start of a line numbers a list item; it does not end a sentence.
    const listNumber = c === '.' && /(?:^|\n)\s*\d+$/.test(buffer.slice(0, i));
    if (c === '\n' && next === '\n') boundary = i + 2;
    else if (/[.!?…]/.test(c) && (next === undefined ? final : /\s/.test(next)) && !listNumber) boundary = i + 1;
    else if (/[,;:]/.test(c) && /\s/.test(next || '')) lastSoft = i + 1;
    if (boundary >= 24) return boundary;
  }
  if (boundary > 0) return boundary;
  if (!fence && !display && buffer.length > 260) return lastSoft > 80 ? lastSoft : buffer.lastIndexOf(' ');
  return final ? buffer.length : -1;
}
