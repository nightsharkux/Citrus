'use strict';
/**
 * Natural voices for Campus: the speech models on the AI Gateway (text to speech, see docs/AI.md#voices).
 *
 * The model comes from CAMPUS_AI_SPEECH_MODEL (default openai/tts-1, "off" to disable). Each model family has
 * its own voices and options. Only voices named in the providers' documentation are listed, because some
 * providers reject unknown names; a voice the server does not know is replaced by the family default, so a
 * request never carries an arbitrary string to the provider.
 */

/** How Campus should sound, for models that take spoken directions (Gemini). */
const DELIVERY = 'Speak in a calm, even, matter-of-fact voice, like a helpful colleague explaining something quietly across a desk. Keep one steady, unhurried pace from the first word to the last, with a level tone: no excitement, no drama, no emphasis on single words, no rising or exclamatory intonation.';

/** The text as it is read: no exclamation marks, ellipses or emphasis marks, which make a synthetic voice sound theatrical. */
function calmText(text) {
  return String(text).replace(/[*_`#]+/g, '').replace(/…|\.{2,}/g, '.').replace(/!+/g, '.').replace(/\?{2,}/g, '?').replace(/\s+/g, ' ').trim();
}

const FAMILIES = {
  openai: {
    format: 'mp3',
    mime: 'audio/mpeg',
    speed: true,
    fallback: 'coral',
    voices: [
      { id: 'coral', label: 'Coral', tone: 'Warm and friendly' },
      { id: 'nova', label: 'Nova', tone: 'Bright and lively' },
      { id: 'sage', label: 'Sage', tone: 'Calm and clear' },
      { id: 'shimmer', label: 'Shimmer', tone: 'Soft and gentle' },
      { id: 'alloy', label: 'Alloy', tone: 'Balanced and neutral' },
      { id: 'ash', label: 'Ash', tone: 'Clear and direct' },
      { id: 'echo', label: 'Echo', tone: 'Even and steady' },
      { id: 'fable', label: 'Fable', tone: 'Expressive storyteller' },
      { id: 'onyx', label: 'Onyx', tone: 'Deep and calm' },
    ],
  },
  google: {
    format: 'wav',
    mime: 'audio/wav',
    instructions: true,
    fallback: 'Kore',
    voices: [
      { id: 'Kore', label: 'Kore', tone: 'Firm and clear' },
      { id: 'Puck', label: 'Puck', tone: 'Upbeat and playful' },
      { id: 'Zephyr', label: 'Zephyr', tone: 'Bright and light' },
      { id: 'Charon', label: 'Charon', tone: 'Informative and calm' },
      { id: 'Aoede', label: 'Aoede', tone: 'Breezy and easy-going' },
      { id: 'Leda', label: 'Leda', tone: 'Youthful and friendly' },
    ],
  },
  microsoft: {
    format: 'mp3',
    mime: 'audio/mpeg',
    speed: true,
    language: true,
    fallback: '',
    // Each voice speaks one language; for any other language the model picks its own voice.
    voices: [
      { id: 'en-US-Harper', label: 'Harper', tone: 'Warm', language: 'en' },
      { id: 'en-US-Ethan', label: 'Ethan', tone: 'Friendly', language: 'en' },
      { id: 'de-DE-Mia', label: 'Mia', tone: 'Warm', language: 'de' },
    ],
  },
  elevenlabs: {
    format: 'mp3',
    mime: 'audio/mpeg',
    fallback: 'hpp4J3VqNfWAUOO0d1Us',
    voices: [{ id: 'hpp4J3VqNfWAUOO0d1Us', label: 'Bella', tone: 'Warm' }],
  },
};

const familyOf = (model) => FAMILIES[String(model || '').split('/')[0]] || null;

/** What the settings screen shows for a speech model: its voices and the default one. */
function voiceCatalog(model) {
  const family = familyOf(model);
  if (!family) return { voices: [], default: '' };
  return { voices: family.voices.map((v) => ({ ...v })), default: family.fallback || family.voices[0]?.id || '' };
}

/**
 * The provider request for one piece of speech. `voice` is checked against the catalog; `language` ('en'|'de')
 * picks a matching voice where voices are tied to a language; `speed` is about 0.8–1.3.
 */
function speechOptions(model, { voice, language, speed }) {
  const family = familyOf(model);
  if (!family) return { voice: voice || undefined, format: 'mp3', mime: 'audio/mpeg' };
  let chosen = family.voices.find((v) => v.id === voice) || family.voices.find((v) => v.id === family.fallback) || null;
  // A German sentence is not read by an English-only voice: take that language's voice, or let the model choose.
  if (chosen?.language && language && chosen.language !== language) chosen = family.voices.find((v) => v.language === language) || null;
  return {
    voice: chosen?.id || undefined,
    format: family.format,
    mime: family.mime,
    ...(family.speed && speed && Math.abs(speed - 1) > 0.01 ? { speed } : {}),
    ...(family.instructions || /gpt-4o-mini-tts/.test(model) ? { instructions: DELIVERY } : {}),
    ...(family.language && language ? { language } : {}),
  };
}

module.exports = { voiceCatalog, speechOptions, calmText, FAMILIES };
