/** Brand marks: the Citrus slice (the mark, drawn in src/lib/brand-mark.js and served at /brand/mark.svg) and the wordmark. */
import { raw } from './dom.js';

/** Wordmark: the slice, then "Citrus". size: '' | 'lg'. Screen readers hear "Citrus". */
export const wordmark = (size = '', extra = '') => raw(
  `<span class="wordmark with-mark ${size} ${extra}" role="img" aria-label="Citrus"><img class="wordmark-mark" src="/brand/mark.svg" alt="" width="26" height="26" aria-hidden="true"><span aria-hidden="true">Citrus</span></span>`,
);

/** The earlier wordmark, a gradient C and "itrus": kept for the full-screen presentation. */
export const wordmarkClassic = (size = '', extra = '') => raw(
  `<span class="wordmark ${size} ${extra}" role="img" aria-label="Citrus"><span class="wordmark-c" aria-hidden="true"></span><span aria-hidden="true">itrus</span></span>`,
);

/** The slice on its own (compact headers, the sign-in card). */
export const ringMark = (px = 32) => raw(`<img class="ring-mark" src="/brand/mark.svg" alt="" width="${Number(px)}" height="${Number(px)}" style="--ring:${Number(px)}px" aria-hidden="true">`);
