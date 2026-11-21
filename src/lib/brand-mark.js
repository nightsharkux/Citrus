'use strict';
/**
 * The Citrus mark: a slice of citrus fruit, a ring with ten segments in a diagonal gradient from orange through pink
 * to violet. It is drawn here from numbers, so it stays sharp at any size and the same drawing makes the browser icon
 * (GET /brand/mark.svg), the app icons and the Android launcher icon (scripts/make-brand-assets.js).
 *
 * The design is a 512 x 512 square. The segments are sectors with rounded corners and a gap that widens with the
 * distance from the centre (a constant angle), like the slice in the presentation it came from.
 */

const SIZE = 512;
const C = SIZE / 2;
const RING_OUT = 255; // the ring's outer edge
const RING_IN = 209; // and its inner edge
const R_OUT = 188; // where the segments end
const HALF_GAP = 3.3; // degrees of gap on each side of a segment
const CR = 8; // radius of the rounded corners
const COUNT = 10;
const OPACITY = 0.85; // the segments are the same gradient, a little lighter

const GRADIENT = [[0, '#ED8641'], [0.27, '#E7817C'], [0.5, '#E07BB0'], [0.73, '#B974CE'], [1, '#8B6BF0']];

const f = (n) => Math.round(n * 100) / 100;
const rad = (deg) => (deg * Math.PI) / 180;
const dir = (deg) => [Math.cos(rad(deg)), Math.sin(rad(deg))];
const at = (v, scale) => [C + v[0] * scale, C + v[1] * scale];

/** One segment, as a closed outline (no stroke needed): two straight sides, a rounded point inside, an arc outside. */
function segment(center) {
  const half = 360 / COUNT / 2 - HALF_GAP;
  const ua = dir(center - half);
  const ub = dir(center + half);
  const na = [-ua[1], ua[0]]; // towards the inside of the segment
  const nb = [ub[1], -ub[0]];
  const Ro = R_OUT - CR;
  const t = Math.sqrt(Ro * Ro - CR * CR);
  const Pa = [C + ua[0] * t + na[0] * CR, C + ua[1] * t + na[1] * CR]; // centres of the outer corner circles
  const Pb = [C + ub[0] * t + nb[0] * CR, C + ub[1] * t + nb[1] * CR];
  const out = (P) => { const d = Math.hypot(P[0] - C, P[1] - C); return [C + ((P[0] - C) / d) * R_OUT, C + ((P[1] - C) / d) * R_OUT]; };
  const Qa = out(Pa);
  const Qb = out(Pb);
  const apex = CR / Math.sin(rad(half)); // distance of the centre of the rounded point from the middle
  const s = apex * Math.cos(rad(half));
  const T1a = at(ua, s);
  const T1b = at(ub, s);
  const T2a = at(ua, t);
  const T2b = at(ub, t);
  const p = (q) => `${f(q[0])} ${f(q[1])}`;
  return `M${p(T1a)}L${p(T2a)}A${CR} ${CR} 0 0 1 ${p(Qa)}A${R_OUT} ${R_OUT} 0 0 1 ${p(Qb)}A${CR} ${CR} 0 0 1 ${p(T2b)}L${p(T1b)}A${CR} ${CR} 0 0 1 ${p(T1a)}Z`;
}

const SEGMENTS = Array.from({ length: COUNT }, (_, k) => segment(-90 + 360 / COUNT / 2 + k * (360 / COUNT)));
const RING = `M${C - RING_OUT} ${C}a${RING_OUT} ${RING_OUT} 0 1 0 ${RING_OUT * 2} 0a${RING_OUT} ${RING_OUT} 0 1 0 ${-RING_OUT * 2} 0ZM${C - RING_IN} ${C}a${RING_IN} ${RING_IN} 0 1 0 ${RING_IN * 2} 0a${RING_IN} ${RING_IN} 0 1 0 ${-RING_IN * 2} 0Z`;

/** The mark as an SVG document. `title` is what a screen reader says; `id` keeps the gradient's name unique when inlined. */
function markSvg(title = 'Citrus', id = 'cg') {
  const stops = GRADIENT.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"><title>${String(title).replace(/[<>&"]/g, '')}</title>`
    + `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${SIZE}" y2="${SIZE}">${stops}</linearGradient></defs>`
    + `<path d="${RING}" fill-rule="evenodd" fill="url(#${id})"/>`
    + `<g fill="url(#${id})" opacity="${OPACITY}">${SEGMENTS.map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;
}

module.exports = { markSvg, SEGMENTS, RING, GRADIENT, OPACITY, SIZE };
