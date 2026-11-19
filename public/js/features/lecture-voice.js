/**
 * Spoken commands for a live lecture, in English and German, understood without the assistant: a lecturer says
 * "Hey Citrus, new chapter", "Hey Citrus, wir machen Pause" or "Hey Citrus, we're back" and it happens at once.
 *
 *   lectureCommand("neues Kapitel: Eigenwerte")   → { type: 'chapter', title: 'Eigenwerte' }
 *   lectureCommand("take a break")                → { type: 'break' }
 *   lectureCommand("weiter")                      → { type: 'resume' }
 *   lectureCommand("what is an eigenvalue?")      → null       (a question for the assistant, as before)
 *
 * Only whole short phrases count, and only after the wake phrase, so a sentence that merely mentions a break or a
 * chapter ("the next chapter of the book says…") is still a question. Speech recognition drops umlauts and capital
 * letters, so matching ignores both (ä = a, ö = o, ü = u, ß = ss).
 *
 * No page or browser in here: it is tested in Node.
 */
const plain = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’`]/g, ' ')
  .replace(/[^a-z0-9\s:]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const FILLER = '(?:(?:ok|okay|so|now|jetzt|also|bitte|please|let us|lets|let s|we will|we ll|wir|machen wir|lass uns|lasst uns) )*';

const CHAPTER = new RegExp(`^${FILLER}(?:(?:start|mark|make|add|begin) )?(?:a )?(?:(?:new|next) chapter|(?:neues|nachstes|naechstes|neuer) kapitel|kapitel (?:markieren|setzen|starten))(?: (?:called|named|about|on|for|zu|uber|ueber|mit dem thema|thema))?[ :]*(.*)$`);
const BREAK = new RegExp(`^${FILLER}(?:(?:take|start|have|make|begin|do|machen|einlegen|starten|beginnen) )?(?:(?:now|jetzt|bitte|please) )?(?:a |one |eine |ne )?(?:(?:short|quick|little|coffee|five minute|ten minute|kurze|kleine|kaffee) )?(?:break|pause|pausieren|pause machen|pause einlegen|pause starten)(?: now| time| jetzt| bitte| please| machen| einlegen)*$|^(?:time for a break|break time|vorlesung pausieren|pause the lecture|pausiere die vorlesung)$`);
const RESUME = new RegExp(`^${FILLER}(?:we are back|we re back|i am back|back from (?:the )?break|(?:let s |let us )?(?:continue|carry on|resume)(?: the lecture| the lecture now| now)?|(?:end|stop|finish) (?:the )?break|break is over|the break is over|weiter|weitermachen|(?:wir )?machen weiter|fortsetzen|vorlesung fortsetzen|pause (?:beenden|ist vorbei|ist zu ende|zu ende|vorbei)|wir sind (?:wieder )?da|wir sind zuruck|wir sind zurueck)$`);

/** The lecture command in a phrase, or null when it is not one. */
export function lectureCommand(text) {
  const s = plain(text);
  if (!s || s.length > 80) return null;
  if (RESUME.test(s)) return { type: 'resume' };
  if (BREAK.test(s)) return { type: 'break' };
  const chapter = CHAPTER.exec(s);
  if (chapter) {
    // The name is what was said after it, as it was said (not the simplified form used to match).
    const raw = String(text).trim().replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, '');
    const at = raw.search(/(?:chapter|kapitel)\b/i);
    const tail = at >= 0 ? raw.slice(at).replace(/^(?:chapter|kapitel)\b\s*(?:called|named|about|on|for|zu|über|ueber|uber|mit dem thema|thema|markieren|setzen|starten)?[\s:,-]*/i, '') : '';
    return { type: 'chapter', title: (tail || '').replace(/^["„“]|["“”]$/g, '').trim().slice(0, 80) };
  }
  return null;
}
