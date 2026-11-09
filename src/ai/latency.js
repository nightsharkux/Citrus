'use strict';
/** Keep ordinary conversation and bundled university questions out of the slower web-search path. */
function needsWebSearch(prompt) {
  const q = String(prompt || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(search (?:for|online|the web|the internet)|web search|(?:please|can you|could you) search|google|browse (?:online|the web)|look up|look online|check online|suche? (?:nach|online|im internet)|recherchier\w*|nachschauen|online nach|im internet)\b/.test(q)) return true;
  if (/\b(weather|wetter|news|nachrichten|exchange rate|wechselkurs|stock price|aktienkurs)\b/.test(q)) return true;
  return /\b(latest|current|new|recent|aktuell|neueste|neuesten|heute|this week|diese woche)\b/.test(q)
    && /\b(research|forschung|release|version|price|prices|preis|preise|president|prasident|election|wahl|results|ergebnisse)\b/.test(q);
}
module.exports = { needsWebSearch };
