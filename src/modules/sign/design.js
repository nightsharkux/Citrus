'use strict';
/**
 * Checking a study-sign design that came from the assistant. The reply is untrusted text: it is read as a small JSON
 * object, and only known values with readable colours get through. Nothing from it is ever used as HTML or CSS.
 *
 * The rules are the same as the browser's own (public/js/features/sign-model.js); tests/study-sign.test.js checks
 * that the two lists agree.
 */
const LIMITS = { message: 80, sub: 80 };
const SIZES = ['m', 'l', 'xl'];
const SYMBOLS = ['none', 'moon', 'book', 'lock', 'mic-off', 'clock'];
const SPEEDS = ['slow', 'normal', 'fast'];
const LANGUAGES = ['en', 'de', 'both'];

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function hex(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : fallback;
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (h) => 0.2126 * channel(parseInt(h.slice(1, 3), 16)) + 0.7152 * channel(parseInt(h.slice(3, 5), 16)) + 0.0722 * channel(parseInt(h.slice(5, 7), 16));
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function dimmed(color, amount = 0.45) {
  const part = (i) => Math.round(parseInt(color.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
}

/** The first JSON object in a reply (models sometimes wrap it in text or a code fence), or null. */
function parseObject(reply) {
  const s = String(reply ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const value = JSON.parse(s.slice(a, b + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A safe sign from a model's reply, or null when it holds no design at all. Colours that cannot be read from across a
 * room are replaced by white or black; a flashing sign is only ever a slow pulse.
 */
function sanitizeDesign(reply) {
  const raw = parseObject(reply);
  if (!raw) return null;
  const style = raw.style === 'flash' ? 'flash' : 'solid';
  const background = hex(raw.background, null);
  if (!background) return null; // no usable colours: not a design
  const wanted = hex(raw.color, '#ffffff');
  const backgrounds = style === 'flash' ? [background, dimmed(background)] : [background];
  const ok = (c) => backgrounds.every((bg) => contrastRatio(bg, c) >= 4.5);
  const color = ok(wanted) ? wanted : ok('#ffffff') ? '#ffffff' : '#000000';
  return {
    preset: 'custom',
    style,
    background,
    color,
    message: clean(raw.message, LIMITS.message),
    language: LANGUAGES.includes(raw.language) ? raw.language : 'en',
    sub: clean(raw.sub, LIMITS.sub),
    size: SIZES.includes(raw.size) ? raw.size : 'l',
    symbol: SYMBOLS.includes(raw.symbol) ? raw.symbol : 'none',
    speed: SPEEDS.includes(raw.speed) ? raw.speed : 'slow',
  };
}

module.exports = { sanitizeDesign, parseObject, contrastRatio, LIMITS, SIZES, SYMBOLS, SPEEDS, LANGUAGES };
