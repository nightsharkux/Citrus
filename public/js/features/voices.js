/**
 * The voice Campus speaks with: which voices this device has, what they sound
 * like, and the user's choice (voice, speed, pitch, volume, when to read aloud).
 *
 * Browsers do not say whether a voice is male or female, so the gender is read
 * from well-known voice names ("Aria", "Guy", "Google UK English Female").
 * Voices that cannot be told are listed as "Other". Voices belong to the
 * browser and operating system, so the choice is stored on this device only.
 * The best-sounding ones are usually Microsoft Edge's "Natural" voices, Apple's
 * Premium/Enhanced voices and Google's online voices.
 */
const KEY = 'campus-voice';

// Browsers read at "1" noticeably slower than people talk, so even the calm style is a little quicker than 1.
export const PRESETS = [
  { id: 'natural', label: 'Natural', rate: 1.12, pitch: 1 },
  { id: 'calm', label: 'Calm', rate: 1, pitch: 0.96 },
  { id: 'bright', label: 'Bright', rate: 1.18, pitch: 1.1 },
  { id: 'deep', label: 'Deep', rate: 1.08, pitch: 0.8 },
  { id: 'quick', label: 'Quick', rate: 1.35, pitch: 1 },
];

/**
 * voices: the chosen device voice per language ({ en: uri, de: uri }); gender: what Automatic should prefer.
 * engine: 'natural' (Campus's natural voices from the server, when available) or 'device' (this browser's voices).
 * natural: the chosen natural voice ('' for the server's default).
 */
export const DEFAULTS = { v: 2, voices: {}, uri: '', preset: 'natural', rate: 1.12, pitch: 1, volume: 1, readAloud: 'spoken', gender: 'any', engine: 'natural', natural: '' };

/**
 * The speaking speed for natural voices. Those already talk at a natural pace at 1, while browser voices needed
 * the faster defaults above, so the style's rate is mapped around that: Natural 1, Calm 0.9, Quick about 1.2.
 */
export function naturalSpeed(settings = getVoiceSettings()) {
  const rate = Number(settings.rate) || DEFAULTS.rate;
  return Math.round(Math.min(1.35, Math.max(0.8, 1 + (rate - DEFAULTS.rate) * 0.85)) * 100) / 100;
}
export const READ_ALOUD = [
  ['spoken', 'When I speak to Campus'],
  ['always', 'Every answer'],
  ['never', 'Never (only when I press the speaker)'],
];

export function getVoiceSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Settings saved before the faster defaults still say 1: that was the old "normal", so move it to the new one.
    if (!saved.v && saved.rate === 1) saved.rate = DEFAULTS.rate;
    return { ...DEFAULTS, ...saved, v: 2, voices: { ...(saved.voices || {}) } };
  } catch {
    return { ...DEFAULTS, voices: {} };
  }
}

export function saveVoiceSettings(patch) {
  const next = { ...getVoiceSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
  return next;
}

const FEMALE = /\b(female|woman|zira|aria|jenny|hazel|susan|libby|sonia|maisie|michelle|natasha|clara|emma|ava|amber|ashley|cora|elizabeth|jane|nancy|sara|sarah|monica|mónica|katja|hedda|samantha|victoria|karen|moira|tessa|fiona|kate|serena|allison|joana|paulina|amelie|amélie|audrey|marie|anna|helena|alice|luciana|laura|elsa|isabella|ioana|zosia|milena|kyoko|yuna|ting-ting|mei-jia|sin-ji|lekha|carmit|joanna|salli|kimberly|kendra|ivy|nicole|olivia|lucia|paola|siri|vicki|zoe|heather|catherine|linda|eva|hanna|hortense|julie|denise|elvira|dalia|jenny|ana|nanami|xiaoxiao|yunxi|sonja|seraphina)\b/i;
const MALE = /\b(male|man|david|mark|guy|ryan|daniel|alex|fred|tom|oliver|thomas|george|james|rishi|aaron|arthur|gordon|lee|diego|jorge|juan|luca|yannick|stefan|killian|conrad|florian|christopher|eric|roger|brian|davis|jason|tony|matthew|henri|claude|paul|pablo|raul|hans|jan|markus|stefanos|kangkang|yunjian|keita|ichiro|andrew|steffan|connor|liam|ronan)\b/i;
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|fred|junior|kathy|princess|ralph|agnes)\b/i;

export function guessGender(name) {
  if (/\bfemale\b/i.test(name)) return 'female';
  if (/\bmale\b/i.test(name)) return 'male';
  if (FEMALE.test(name)) return 'female';
  if (MALE.test(name)) return 'male';
  return 'other';
}

/** natural: neural/premium voices · online: network voices · standard: built into the device. */
export function qualityOf(voice) {
  if (/natural|neural|premium|enhanced|siri|multilingual/i.test(voice.name)) return 'natural';
  if (!voice.localService || /google/i.test(voice.name)) return 'online';
  return 'standard';
}

export const QUALITY_LABEL = { natural: 'Natural', online: 'Online', standard: 'Standard' };
const RANK = { natural: 0, online: 1, standard: 2 };

/** "Microsoft Aria Online (Natural) - English (United States)" → "Aria". */
export function shortName(name) {
  return String(name)
    .replace(/^(Microsoft|Google|Apple)\s+/i, '')
    .replace(/\s*-\s*.*$/, '')
    .replace(/\s*\((?:Natural|Premium|Enhanced|Neural|[^)]*)\)\s*/gi, ' ')
    .replace(/\b(Online|Desktop|Mobile)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || String(name);
}

const regionName = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return null;
  }
})();
const languageName = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' });
  } catch {
    return null;
  }
})();

/** Describe where a voice is from: "English · United States". */
export function accentOf(lang) {
  const [l, region] = String(lang).replace('_', '-').split('-');
  const language = languageName?.of(l) || l;
  const place = region && regionName ? regionName.of(region.toUpperCase()) : '';
  return place ? `${language} · ${place}` : language;
}

/** Resolves once the browser has loaded its voices (they arrive a moment after page load). */
export function voicesReady() {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** All usable voices with their gender, quality and accent, best first. */
export function listVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices()
    .filter((v) => !NOVELTY.test(v.name))
    .map((voice) => ({
      voice,
      uri: voice.voiceURI,
      name: shortName(voice.name),
      fullName: voice.name,
      lang: voice.lang,
      accent: accentOf(voice.lang),
      gender: guessGender(voice.name),
      quality: qualityOf(voice),
    }))
    .sort((a, b) => RANK[a.quality] - RANK[b.quality] || a.name.localeCompare(b.name));
}

/**
 * The voice for a piece of speech in a language: the one chosen for that language, otherwise the best voice of
 * that language (natural ones first) in the preferred gender. Each language has its own choice, so a German
 * sentence is read by a German voice even when the person picked an English one.
 */
export function chooseVoice(settings = getVoiceSettings(), languageCode = navigator.language || 'en-US') {
  const all = listVoices();
  if (!all.length) return null;
  const code = languageCode.slice(0, 2).toLowerCase();
  const sameLanguage = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(code));
  const chosen = settings.voices?.[code] || (settings.uri && sameLanguage.some((v) => v.uri === settings.uri) ? settings.uri : '');
  const saved = chosen && all.find((v) => v.uri === chosen);
  if (saved) return saved.voice;
  if (!sameLanguage.length) return null;
  const wanted = settings.gender && settings.gender !== 'any' ? sameLanguage.filter((v) => v.gender === settings.gender) : [];
  const pool = wanted.length ? wanted : sameLanguage;
  const exact = pool.filter((v) => v.lang.toLowerCase().replace('_', '-') === languageCode.toLowerCase());
  return (exact[0] || pool[0]).voice;
}

/** Speech rate, pitch and volume from the saved settings. */
export function voiceTuning(settings = getVoiceSettings()) {
  const volume = Number(settings.volume);
  return { rate: Math.min(2, Math.max(0.5, Number(settings.rate) || 1)), pitch: Math.min(2, Math.max(0.5, Number(settings.pitch) || 1)), volume: Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1)) };
}
