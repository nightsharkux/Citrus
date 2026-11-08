/** Brand marks: the "Campus OS" wordmark (ring as the O) and the standalone ring. */
import { raw } from './dom.js';

/** Wordmark. size: '' | 'lg'. Screen readers hear "Campus OS". */
export const wordmark = (size = '', extra = '') => raw(
  `<span class="wordmark ${size} ${extra}" role="img" aria-label="Campus OS"><span aria-hidden="true">Campus</span><span class="wordmark-o" aria-hidden="true"></span><span aria-hidden="true">S</span></span>`,
);

/** The ring on its own (compact headers, sign-in card). */
export const ringMark = (px = 32) => raw(`<span class="ring-mark" style="--ring:${Number(px)}px" aria-hidden="true"></span>`);
