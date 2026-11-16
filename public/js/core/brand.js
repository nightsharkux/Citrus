/** Brand marks: the "Citrus" wordmark (a gradient C is its first letter) and the standalone C. */
import { raw } from './dom.js';

/** Wordmark. size: '' | 'lg'. Screen readers hear "Citrus". */
export const wordmark = (size = '', extra = '') => raw(
  `<span class="wordmark ${size} ${extra}" role="img" aria-label="Citrus"><span class="wordmark-c" aria-hidden="true"></span><span aria-hidden="true">itrus</span></span>`,
);

/** The C on its own (compact headers, sign-in card). */
export const ringMark = (px = 32) => raw(`<span class="ring-mark" style="--ring:${Number(px)}px" aria-hidden="true"></span>`);
