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

export const PRESETS = [
  { id: 'natural', label: 'Natural', rate: 1, pitch: 1 },
  { id: 'calm', label: 'Calm', rate: 0.92, pitch: 0.96 },
  { id: 'bright', label: 'Bright', rate: 1.06, pitch: 1.1 },
  { id: 'deep', label: 'Deep', rate: 0.97, pitch: 0.8 },
  { id: 'quick', label: 'Quick', rate: 1.25, pitch: 1 },
];

export const DEFAULTS = { uri: '', preset: 'natural', rate: 1, pitch: 1, volume: 1, readAloud: 'spoken' };
export const READ_ALOUD = [
  ['spoken', 'When I speak to Campus'],
  ['always', 'Every answer'],
  ['never', 'Never (only when I press the speaker)'],
];

export function getVoiceSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
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

/** The voice to speak with: the saved one, else the best match for the interface language. */
export function chooseVoice(settings = getVoiceSettings(), languageCode = navigator.language || 'en-US') {
  const all = listVoices();
  if (!all.length) return null;
  const saved = settings.uri && all.find((v) => v.uri === settings.uri);
  if (saved) return saved.voice;
  const code = languageCode.slice(0, 2).toLowerCase();
  const sameLanguage = all.filter((v) => v.lang.toLowerCase().startsWith(code));
  const exact = sameLanguage.filter((v) => v.lang.toLowerCase().replace('_', '-') === languageCode.toLowerCase());
  return (exact[0] || sameLanguage[0] || all[0]).voice;
}

/** Speech rate, pitch and volume from the saved settings. */
export function voiceTuning(settings = getVoiceSettings()) {
  return { rate: Math.min(2, Math.max(0.5, Number(settings.rate) || 1)), pitch: Math.min(2, Math.max(0.5, Number(settings.pitch) || 1)), volume: Math.min(1, Math.max(0.1, Number(settings.volume) || 1)) };
}
