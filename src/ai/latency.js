'use strict';
/** Keep ordinary conversation and bundled university questions out of the slower web-search path. */
function needsWebSearch(prompt) {
  const q = String(prompt || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (/\b(search (?:for|online|the web|the internet)|web search|(?:please|can you|could you) search|google|browse (?:online|the web)|look up|look online|check online|suche? (?:nach|online|im internet)|recherchier\w*|nachschauen|online nach|im internet)\b/.test(q)) return true;
  if (/\b(weather|wetter|news|nachrichten|exchange rate|wechselkurs|stock price|aktienkurs)\b/.test(q)) return true;
  return /\b(latest|current|new|recent|aktuell|neueste|neuesten|heute|this week|diese woche)\b/.test(q)
    && /\b(research|forschung|release|version|price|prices|preis|preise|president|prasident|election|wahl|results|ergebnisse)\b/.test(q);
}

// A request to explain, work something out, write or practise: the chat model thinks it through.
const THINKING = /\b(explain|erklar\w*|why|warum|wieso|weshalb|how does|wie funktioniert|solve|lose|berechne\w*|calculate|derive|herleit\w*|prove|beweis\w*|summari[sz]e|zusammenfass\w*|write|schreib\w*|translate|ubersetz\w*|essay|code|program(?:me)? (?:a|this|that)|quiz|teach|bring mir|learn|lern\w*|practi[cs]e|ub(?:e|en|ung)\w*)\b/;
// Something to do in the app: the chat model runs actions.
const ACTION = /\b(add|create|remind|reminder|erinner\w*|eintrag\w*|trag\w*|move|verschieb\w*|delete|losch\w*|remove|entfern\w*|remember|merk\w*|forget|vergiss|open|offne\w*|set|stell\w*|change|ander\w*|switch|rename|umbenenn\w*|book|buch\w*)\b/;
// Facts that live in the university's documents and pages.
const FACT = /\b(when|where|who|which|what time|wann|wo|wohin|wer|welche[rnms]?|how (?:do|can) i (?:register|apply|sign up|enrol|enroll|get|find|reach|contact)|wie (?:melde|bewerbe|komme|erreiche) ich|deadline\w*|frist\w*|termin\w*|raum|room|rooms|building|gebaude|office|buro|sprechstunde\w*|office hours|contact|kontakt\w*|e ?mail|phone|telefon\w*|opening|offnungszeit\w*|timetable|stundenplan|vorlesung\w*|lectures?|class(?:es)?|schedule|exams?|prufung\w*|klausur\w*|semester\w*|lecture period|registration|anmeld\w*|einschreib\w*|enrol\w*|bewerb\w*|application|fees?|gebuhr\w*|beitrag|mensa|cafeteria|library|bibliothek|print\w*|druck\w*|wifi|wlan|eduroam|vpn|parking|park\w*|bus|moodle|primuss|portal|studiengang|programme|modul\w*|modules?|ects|credits|grades?|noten?|transcript|zeugnis|praktikum|internship|thesis|bachelorarbeit|masterarbeit|abgabe)\b/;

/**
 * A question about facts in the university's documents (when, where, who, which office, which deadline), rather
 * than a request to explain, work something out or do something in the app. These go to the search model, which
 * reads long timetable and regulation excerpts quickly.
 */
function needsLookup(prompt) {
  const q = String(prompt || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  if (THINKING.test(q) || ACTION.test(q)) return false;
  return FACT.test(q);
}

module.exports = { needsWebSearch, needsLookup };
