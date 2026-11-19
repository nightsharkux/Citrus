/**
 * The study sign: a screen that tells people nearby not to disturb you. This is everything about what a sign
 * *is*, with no page or browser in it (so it is tested in Node): the ready-made styles, the message in English,
 * German or both, readable colours, and how fast a sign may flash.
 *
 * A sign is a small plain object (a "spec"), never HTML or CSS:
 *
 *   { preset, style: 'solid' | 'flash', background: '#rrggbb', color: '#rrggbb', message, language: 'en' | 'de' | 'both',
 *     sub, size: 'm' | 'l' | 'xl', symbol, speed: 'slow' | 'normal' | 'fast' }
 *
 * Citrus can design one from a description (src/modules/sign/design.js checks what comes back with the same rules).
 *
 * Flashing is a slow pulse, never a strobe: the quickest is one cycle a second, well under the three flashes a
 * second that photosensitive people are warned about, and with "reduce motion" on it is a plain solid sign.
 */
export const DEFAULT_MESSAGE = { en: 'Please do not disturb', de: 'Bitte nicht stören' };
export const LIMITS = { message: 80, sub: 80 };
export const SIZES = { m: 'Medium', l: 'Large', xl: 'Extra large' };
export const SYMBOLS = ['none', 'moon', 'book', 'lock', 'mic-off', 'clock'];
/** Seconds for one full pulse. The shortest (1 s) is one flash a second. */
export const SPEEDS = { slow: 2.4, normal: 1.6, fast: 1 };
export const LANGUAGES = ['en', 'de', 'both'];

/** The four styles offered up front. */
export const PRESETS = [
  { id: 'black-white', name: 'Black, white text', spec: { style: 'solid', background: '#000000', color: '#ffffff' } },
  { id: 'black-red', name: 'Black, red text', spec: { style: 'solid', background: '#000000', color: '#ff3b30' } },
  { id: 'red', name: 'Red', spec: { style: 'solid', background: '#d71920', color: '#ffffff' } },
  { id: 'flash-red', name: 'Flashing red', spec: { style: 'flash', background: '#d71920', color: '#ffffff' } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** "#abc" or "#aabbcc" (any case) as "#aabbcc", else the fallback. */
export function hex(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX.test(v) ? v : fallback;
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (h) => 0.2126 * channel(parseInt(h.slice(1, 3), 16)) + 0.7152 * channel(parseInt(h.slice(3, 5), 16)) + 0.0722 * channel(parseInt(h.slice(5, 7), 16));

/** WCAG contrast ratio between two "#rrggbb" colours, 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour mixed with black, for the dim half of a flashing sign. */
export function dimmed(color, amount = 0.45) {
  const part = (i) => Math.round(parseInt(color.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
}

/** The text colour to use: the wanted one when it can be read from across a room, else white or black. */
export function readableText(background, wanted, { flash = false } = {}) {
  const backgrounds = flash ? [background, dimmed(background)] : [background];
  const ok = (c) => backgrounds.every((bg) => contrastRatio(bg, c) >= 4.5);
  if (ok(wanted)) return wanted;
  return ok('#ffffff') ? '#ffffff' : '#000000';
}

/**
 * A safe sign from anything (stored settings, a design from the assistant): known values only, colours that can be
 * read, text trimmed. `language` is the default for a sign that has not chosen one.
 */
export function normalizeSpec(raw = {}, { language = 'en' } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const preset = PRESETS.find((p) => p.id === input.preset);
  const base = preset ? preset.spec : PRESETS[0].spec;
  const style = (input.style ?? base.style) === 'flash' ? 'flash' : 'solid';
  const background = hex(input.background, base.background);
  const wanted = hex(input.color, base.color);
  return {
    preset: preset ? preset.id : 'custom',
    style,
    background,
    color: readableText(background, wanted, { flash: style === 'flash' }),
    message: clean(input.message, LIMITS.message),
    language: LANGUAGES.includes(input.language) ? input.language : (LANGUAGES.includes(language) ? language : 'en'),
    sub: clean(input.sub, LIMITS.sub),
    size: SIZES[input.size] ? input.size : 'l',
    symbol: SYMBOLS.includes(input.symbol) ? input.symbol : 'none',
    speed: SPEEDS[input.speed] ? input.speed : 'slow',
  };
}

/** A sign carried in a link (base64url JSON, as the assistant makes it), checked like any other; null when it is not one. */
export function decodeSpec(param, options) {
  try {
    const bytes = Uint8Array.from(atob(String(param).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    return normalizeSpec(JSON.parse(new TextDecoder().decode(bytes)), options);
  } catch {
    return null;
  }
}

/** A ready-made style applied to a sign, keeping the person's own message and choices. */
export const withPreset = (spec, id, options) => normalizeSpec({ ...spec, preset: id, background: undefined, color: undefined, style: undefined }, options);

/** The lines of text on the sign: the person's own message, or the default in the chosen language(s). */
export function messageLines(spec) {
  if (spec.message) return [spec.message];
  if (spec.language === 'de') return [DEFAULT_MESSAGE.de];
  if (spec.language === 'both') return [DEFAULT_MESSAGE.en, DEFAULT_MESSAGE.de];
  return [DEFAULT_MESSAGE.en];
}

/** Seconds for one pulse of a flashing sign. */
export const pulseSeconds = (spec) => SPEEDS[spec.speed] ?? SPEEDS.slow;
