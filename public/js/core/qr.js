/**
 * QR codes, made here (no library): the text as bytes (UTF-8), Reed–Solomon error correction, the eight masks
 * with the standard penalty rules, versions 1 to 40 (ISO/IEC 18004). Built the way Project Nayuki's reference
 * encoder builds them, so any phone camera reads them.
 *
 *   qrCode('https://…/join/abc', { ecl: 'M' })  → { size, version, ecl, mask, dark(x, y) }
 *   qrSvg(text, { margin: 4 })                  → '<svg …>' black on white, one path, crisp at any size
 *   qrCanvas(text, { scale: 16 })               → a <canvas> for saving as PNG (browser only)
 *
 * Error correction: L 7 %, M 15 %, Q 25 %, H 30 % of the code can be damaged or covered. The level is raised
 * by itself while that keeps the code the same size, so it is never larger than it needs to be.
 */

const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = [1, 0, 3, 2]; // L M Q H as they are written into the code

// Per level (L M Q H) and version (index 0 unused): error correction codewords per block, and number of blocks.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules left for data and error correction once the fixed patterns are drawn. */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver];

// ---- Reed–Solomon over GF(2^8) with the polynomial 0x11D ------------------------------------------------------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => {
      out[i] ^= gfMul(coef, factor);
    });
  }
  return out;
}

// ---- the code --------------------------------------------------------------------------------------------------

/** The bytes as data codewords for this version and level: byte mode, count, data, terminator, padding. */
function dataFor(bytes, ver, ecl) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return out;
}

/** Split into blocks, add error correction to each, and interleave them. */
function withCorrection(data, ver, ecl) {
  const blocks = BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const total = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (total % blocks);
  const shortLen = Math.floor(total / blocks);
  const divisor = rsDivisor(eccLen);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    all.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < all[0].length; i += 1) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]);
    });
  }
  return out;
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

function makeGrid(ver) {
  const size = ver * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => {
    dark[y][x] = on;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver, size);
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
  return { size, dark, fixed, set };
}

function drawFormat(grid, ecl, mask) {
  const { size, set } = grid;
  const data = (FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module
}

function drawData(grid, codewords) {
  const { size, dark, fixed } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid, mask) {
  const { size, dark, fixed } = grid;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
}

/** The standard penalty: long runs, 2×2 blocks, finder-like patterns and an uneven share of dark modules. */
function penalty({ size, dark }) {
  let score = 0;
  const addHistory = (run, history) => {
    if (history[0] === 0) run += size; // the light border before the first run
    history.pop();
    history.unshift(run);
  };
  const finderLike = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const line = (get) => {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i += 1) {
      if (get(i) === color) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        addHistory(run, history);
        if (!color) score += finderLike(history) * 40;
        color = get(i);
        run = 1;
      }
    }
    if (color) {
      addHistory(run, history);
      run = 0;
    }
    addHistory(run + size, history);
    score += finderLike(history) * 40;
  };
  for (let y = 0; y < size; y += 1) line((x) => dark[y][x]);
  for (let x = 0; x < size; x += 1) line((y) => dark[y][x]);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
    }
  }
  let black = 0;
  for (const row of dark) for (const c of row) if (c) black += 1;
  const total = size * size;
  score += (Math.ceil(Math.abs(black * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * The QR code of a text. `ecl` is the least error correction wanted; `mask` -1 picks the best of the eight.
 * Throws when the text does not fit (more than about 2,300 bytes at level M).
 */
export function qrCode(text, { ecl = 'M', minVersion = 1, maxVersion = 40, mask = -1, boost = true } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let level = ECL[String(ecl).toUpperCase()];
  if (level === undefined) throw new Error(`Unknown error correction level: ${ecl}`);
  let ver = minVersion;
  const fits = (v, l) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v, l) * 8;
  while (!fits(ver, level)) {
    ver += 1;
    if (ver > maxVersion) throw new Error('Too long for a QR code');
  }
  if (boost) while (level < 3 && fits(ver, level + 1)) level += 1;
  const codewords = withCorrection(dataFor(bytes, ver, level), ver, level);

  const build = (m) => {
    const grid = makeGrid(ver);
    drawFormat(grid, level, m);
    drawData(grid, codewords);
    applyMask(grid, m);
    return grid;
  };
  let chosen = mask;
  if (chosen < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m += 1) {
      const score = penalty(build(m));
      if (score < best) {
        best = score;
        chosen = m;
      }
    }
  }
  const grid = build(chosen);
  const { size, dark } = grid;
  return {
    size,
    version: ver,
    ecl: Object.keys(ECL)[level],
    mask: chosen,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && dark[y][x],
    rows: dark.map((row) => row.map((c) => (c ? 1 : 0))),
  };
}

/** The code as an SVG: one path of dark runs on a white square, with a quiet zone of `margin` modules. */
export function qrSvg(text, { ecl = 'M', margin = 4, dark = '#000', light = '#fff', label = '' } = {}) {
  const qr = qrCode(text, { ecl });
  const full = qr.size + margin * 2;
  let d = '';
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.dark(x, y)) continue;
      let run = 1;
      while (qr.dark(x + run, y)) run += 1;
      d += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>`
    + `<rect width="${full}" height="${full}" fill="${esc(light)}"/><path fill="${esc(dark)}" d="${d}"/></svg>`;
}

/** The code drawn on a canvas, `scale` pixels per module (for saving as a PNG). Browser only. */
export function qrCanvas(text, { ecl = 'M', margin = 4, scale = 16 } = {}) {
  const qr = qrCode(text, { ecl });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (qr.size + margin * 2) * scale;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (let y = 0; y < qr.size; y += 1) for (let x = 0; x < qr.size; x += 1) if (qr.dark(x, y)) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return canvas;
}
