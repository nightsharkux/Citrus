/**
 * German and English for the whole interface, and the assistant's name.
 *
 * Pages are written in English. When the language is German, every visible string (text, placeholders, labels,
 * tooltips) is looked up in the dictionary in i18n-de.js and swapped as it appears on screen, so a page needs no
 * special code to be translated: add its English text and the German beside it in the dictionary. Strings that
 * contain a number or a name are matched by the patterns at the end of that file. Anything not in the dictionary
 * stays English. Text the user wrote (messages, titles, notes) is never touched.
 *
 * The same pass puts the person's name for the assistant where the interface says "Campus" (Ask Campus, Hey
 * Campus), except in "Campus OS", "Campus life", "Campus map" and similar names.
 */

/**
 * The German dictionary is about 60 KB, so it is fetched only when German is needed (at start-up for German
 * speakers, or when someone switches). Until it has arrived, text stays as the page wrote it.
 */
let dictionary = null;
export async function loadGerman() {
  dictionary ||= await import('./i18n-de.js');
  return dictionary;
}

const KEY = 'campus-lang';
const SKIP = 'script, style, textarea, input, code, pre, svg, [data-no-translate], .prose, .bubble, .att-name, .md, .markdown';
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
/** "Campus" as the assistant, not as a place or as the product name. */
const NAME_RE = /\bCampus\b(?!\s+(?:OS|life|map|feed|guide|topics|TV)\b)/g;

let language = 'en';
let assistant = 'Campus';
let observer = null;
let queue = new Set();
let frame = 0;
/** Text nodes and elements we changed: what the page wrote, and what we put there. */
const texts = new Map();
const attrs = new Map();

export const getLanguage = () => language;
export const getAssistantName = () => assistant;

function browserLanguage() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch { /* private mode */ }
  return /^de\b/i.test(navigator.language || '') ? 'de' : 'en';
}

/**
 * Translate one string into `lang`, with the assistant called `name`. Pure, so it can be tested without a page.
 * Used by the page scan and by code that builds text itself (toasts, speech) through t().
 */
export function translateWith(lang, name, text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const key = name !== 'Campus' && trimmed.includes(name) ? trimmed.split(name).join('Campus') : trimmed;
  // Only an English "Campus" that means the assistant is renamed. A German "Campus" is the place (Auf dem Campus).
  const meansAssistant = name !== 'Campus' && new RegExp(NAME_RE.source).test(key);
  let out = key;
  if (lang === 'de' && dictionary) {
    const { DE, PATTERNS } = dictionary;
    out = DE[key];
    if (out === undefined) {
      out = key;
      for (const [re, make] of PATTERNS) {
        const m = re.exec(key);
        if (m) {
          out = make(...m.slice(1));
          break;
        }
      }
      if (out === key && key.includes(' · ')) {
        const parts = key.split(' · ');
        const done = parts.map((p) => DE[p] ?? PATTERNS.reduce((r, [re, make]) => (r !== p ? r : re.test(p) ? make(...re.exec(p).slice(1)) : r), p));
        if (done.some((p, i) => p !== parts[i])) out = done.join(' · ');
      }
    }
  }
  if (meansAssistant && out !== 'Campus') out = out.replace(NAME_RE, name);
  return out === trimmed ? raw : raw.replace(trimmed, () => out);
}


export const t = (text) => translateWith(language, assistant, text);

const active = () => language !== 'en' || assistant !== 'Campus';

function textNode(node) {
  const known = texts.get(node);
  let source = node.nodeValue;
  if (known) {
    if (source === known.out) source = known.source;
    else known.source = source; // the page wrote new text here
  }
  const out = active() ? t(source) : source;
  if (out !== node.nodeValue) {
    texts.set(node, { source, out });
    node.nodeValue = out;
  } else if (known && out === source) texts.delete(node);
}

function attributes(el) {
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const now = el.getAttribute(name);
    let rec = attrs.get(el);
    const known = rec?.[name];
    let source = now;
    if (known) {
      if (now === known.out) source = known.source;
    }
    const out = active() ? t(source) : source;
    if (out !== now) {
      rec ||= {};
      rec[name] = { source, out };
      attrs.set(el, rec);
      el.setAttribute(name, out);
    }
  }
}

/** Fields keep what the person typed, but their placeholder and label are interface text. */
const FIELD = 'textarea, input';

function scan(root) {
  if (root.nodeType === 3) {
    if (root.parentElement && !root.parentElement.closest(SKIP)) textNode(root);
    return;
  }
  if (root.nodeType !== 1) return;
  if (root.matches(FIELD)) {
    attributes(root);
    return;
  }
  if (root.closest?.(SKIP)) return;
  attributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (n.matches(FIELD)) {
        attributes(n);
        return NodeFilter.FILTER_REJECT;
      }
      return n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) textNode(n);
    else attributes(n);
  }
}

function flush() {
  frame = 0;
  const batch = queue;
  queue = new Set();
  observer?.disconnect();
  for (const node of batch) if (node.isConnected) scan(node);
  observe();
}

function observe() {
  observer?.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

function schedule(node) {
  queue.add(node);
  if (!frame) frame = setTimeout(flush, 16);
}

/** Everything on the page again, from what the pages wrote (after the language or the name changed). */
function rescan() {
  for (const [node] of texts) if (!node.isConnected) texts.delete(node);
  for (const [el] of attrs) if (!el.isConnected) attrs.delete(el);
  observer?.disconnect();
  for (const node of [...texts.keys()]) textNode(node);
  for (const el of [...attrs.keys()]) attributes(el);
  scan(document.body);
  document.title = active() ? t(document.title) : document.title;
  observe();
}

export function setLanguage(code, { save = true } = {}) {
  const next = code === 'de' ? 'de' : 'en';
  if (next === 'de' && !dictionary) loadGerman().then(() => language === 'de' && rescan()).catch(() => {});
  if (save) {
    try {
      localStorage.setItem(KEY, next);
    } catch { /* private mode */ }
  }
  if (next === language && document.documentElement.lang === next) return;
  language = next;
  document.documentElement.lang = next;
  rescan();
}

export function setAssistantName(name) {
  const next = String(name || '').trim() || 'Campus';
  if (next === assistant) return;
  assistant = next;
  rescan();
}

/** Start once at boot: pick the language, then keep every new piece of the page in step with it. */
export function startTranslating({ language: account = null, assistantName = null } = {}) {
  language = account === 'de' || account === 'en' ? account : browserLanguage();
  assistant = String(assistantName || '').trim() || 'Campus';
  document.documentElement.lang = language;
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => schedule(n));
        else if (r.type === 'characterData') schedule(r.target);
        else if (r.type === 'attributes') schedule(r.target);
      }
    });
  }
  rescan();
  // German speakers get their dictionary before the first page is drawn (the caller waits for this).
  return language === 'de' ? loadGerman().then(rescan).catch(() => {}) : Promise.resolve();
}

/** Follow the signed-in person's account settings (called whenever the session changes). */
export function syncFromUser(user) {
  const prefs = user?.preferences || {};
  setAssistantName(prefs.assistantName);
  if (prefs.language === 'de' || prefs.language === 'en') setLanguage(prefs.language);
}
