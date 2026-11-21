/**
 * A small PDF writer for notes: Markdown in, a formatted A4 PDF out, made on the device (nothing is uploaded or
 * stored). No libraries: the standard PDF fonts (Helvetica and Courier, WinAnsi encoding, so German umlauts work),
 * vector drawing for boxes, tables and the class timeline, and JPEG pictures for graphs.
 *
 *   notesPdf({ title, subtitle, kicker, markdown, accent, figure, images }) → Uint8Array
 *
 * Markdown it understands: # ## ### headings, paragraphs with **bold**, *italic* and `code`, - and 1. lists,
 * > quotes (a quote that starts with a bold label such as "**Key idea:**" or "**Explain it better · 12:34 · P3:**"
 * becomes a coloured box), | tables | (the words good, watch, trouble and quiet are coloured), ``` code ```,
 * ```chart blocks (drawn from `images`, made by pdf-charts.js in the browser) and --- rules.
 *
 * `figure` draws the class timeline: { minutes: [{ minute, status, you? }], audience }.
 */

const PAGE = { w: 595.28, h: 841.89, left: 54, right: 54, top: 58, bottom: 62 };
const WIDTH = PAGE.w - PAGE.left - PAGE.right;

// ---- fonts: widths per 1000 units for the printable ASCII range (32..126)
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const WIDE = { '€': 556, '…': 1000, '‘': 222, '’': 222, '‚': 222, '“': 333, '”': 333, '„': 333, '•': 350, '–': 556, '—': 1000, '™': 1000, ' ': 278, '°': 400, '²': 333, '³': 333, '¹': 333, '·': 278, '×': 584, '÷': 584, 'ß': 611, 'µ': 556, '§': 556, '©': 737, '®': 737, '±': 584, '«': 556, '»': 556, '¼': 834, '½': 834, '¾': 834, 'Æ': 1000, 'æ': 889, 'Ø': 778, 'ø': 611, 'Œ': 1000, 'œ': 944, '¿': 611, '¡': 333 };
const FONTS = { regular: 'F1', bold: 'F2', italic: 'F3', boldItalic: 'F4', mono: 'F5', symbol: 'F6' };

/**
 * Greek letters and maths symbols come from the standard Symbol font, so formulas look like a textbook:
 * [byte in the Symbol encoding, width].
 */
const SYMBOL = {
  'α': [0x61, 631], 'β': [0x62, 549], 'γ': [0x67, 411], 'δ': [0x64, 494], 'ε': [0x65, 439], 'ζ': [0x7a, 494], 'η': [0x68, 603], 'θ': [0x71, 521], 'ι': [0x69, 329], 'κ': [0x6b, 549],
  'λ': [0x6c, 549], 'μ': [0x6d, 576], 'ν': [0x6e, 521], 'ξ': [0x78, 493], 'π': [0x70, 549], 'ρ': [0x72, 549], 'σ': [0x73, 603], 'τ': [0x74, 439], 'υ': [0x75, 576], 'φ': [0x66, 521],
  'χ': [0x63, 549], 'ψ': [0x79, 686], 'ω': [0x77, 686], 'Γ': [0x47, 603], 'Δ': [0x44, 612], 'Θ': [0x51, 741], 'Λ': [0x4c, 686], 'Ξ': [0x58, 645], 'Π': [0x50, 768], 'Σ': [0x53, 592],
  'Φ': [0x46, 763], 'Ψ': [0x59, 795], 'Ω': [0x57, 768], '≤': [0xa3, 549], '≥': [0xb3, 549], '≠': [0xb9, 549], '≈': [0xbb, 549], '≡': [0xba, 549], '√': [0xd6, 549], '∑': [0xe5, 713],
  '∏': [0xd5, 823], '∫': [0xf2, 274], '∞': [0xa5, 713], '∂': [0xb6, 494], '∇': [0xd1, 713], '∈': [0xce, 713], '∉': [0xcf, 713], '∀': [0x22, 713], '∃': [0x24, 549], '∩': [0xc7, 768],
  '∪': [0xc8, 768], '⊂': [0xcc, 713], '∅': [0xc6, 823], '→': [0xae, 987], '←': [0xac, 987], '↔': [0xab, 1042], '↑': [0xad, 603], '↓': [0xaf, 603], '⇒': [0xde, 987], '⇔': [0xdb, 1042],
  '∼': [0x7e, 549], '⋅': [0xd7, 250], '∙': [0xd7, 250], '−': [0x2d, 549],
};
const isSymbol = (ch) => SYMBOL[ch] !== undefined;

// ---- text: Unicode → the WinAnsi characters the standard fonts have
const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const SPELL = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇔': '<=>', '↑': '^', '↓': 'v', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '≡': '===', '∼': '~',
  '√': 'sqrt', '∑': 'sum', '∏': 'prod', '∫': 'integral ', '∞': 'infinity', '∂': 'd', '∇': 'nabla', '∈': ' in ', '∉': ' not in ', '∀': 'for all ', '∃': 'there is ',
  '∩': ' and ', '∪': ' or ', '⊂': ' subset of ', '∅': 'empty set', '−': '-', '‐': '-', '‑': '-', '⁄': '/', '∗': '*', '⋅': '·', '∙': '·', ' ': ' ', ' ': ' ', '​': '',
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'µ', 'ν': 'nu', 'ξ': 'xi', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Γ': 'Gamma', 'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Π': 'Pi', 'Σ': 'Sigma', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega',
  '⁰': '^0', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9', 'ⁿ': '^n', '⁻': '^-', '⁺': '^+',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₙ': 'n', 'ᵢ': 'i',
  'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ſ': 's', 'ŋ': 'n', 'ħ': 'h',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', '■': '-', '□': '-', '▪': '-', '►': '>', '▶': '>', '◆': '-', '❗': '!', '⚠': '!', '✅': 'v', '❌': 'x',
};
const winAnsi = (ch) => {
  const code = ch.charCodeAt(0);
  if (ch.length === 1 && ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff))) return code;
  return WIN[ch] ?? null;
};

/**
 * Text with only characters the standard fonts can show: Greek and maths kept for the Symbol font (unless
 * `spell`), other symbols spelled out, emoji dropped, anything else as "?".
 */
export function pdfText(text, { spell = false } = {}) {
  let out = '';
  for (const ch of String(text ?? '').replace(/\r/g, '').replace(/\t/g, '    ')) {
    if (winAnsi(ch) !== null) out += ch;
    else if (!spell && isSymbol(ch)) out += ch;
    else if (SPELL[ch] !== undefined) out += SPELL[ch];
    else if (/\p{Extended_Pictographic}|\p{Variation_Selector}|‍/u.test(ch)) continue;
    else {
      const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
      out += base && [...base].every((c) => winAnsi(c) !== null) ? base : '?';
    }
  }
  return out;
}

function charWidth(ch, font) {
  if (isSymbol(ch)) return SYMBOL[ch][1];
  if (font === FONTS.mono) return 600;
  const bold = font === FONTS.bold || font === FONTS.boldItalic;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return (bold ? HELVETICA_BOLD : HELVETICA)[code - 32];
  if (WIDE[ch]) return bold && (ch === '“' || ch === '”' || ch === '„') ? 500 : WIDE[ch];
  const base = ch.normalize('NFD')[0];
  const b = base.charCodeAt(0);
  return b >= 32 && b <= 126 ? (bold ? HELVETICA_BOLD : HELVETICA)[b - 32] : 556;
}
export const textWidth = (text, font, size) => {
  let w = 0;
  for (const ch of text) w += charWidth(ch, font);
  return (w / 1000) * size;
};

/** A PDF string literal in WinAnsi bytes (or Symbol bytes for the Symbol font). */
function literal(text, font = FONTS.regular) {
  let out = '(';
  for (const ch of text) {
    const b = font === FONTS.symbol ? (SYMBOL[ch]?.[0] ?? 63) : (winAnsi(ch) ?? 63);
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

// ---- colours
const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xf07a2e;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
};
const tint = (rgb, amount) => rgb.map((v) => 1 - (1 - v) * amount);
const rgbOp = (rgb, stroke = false) => `${rgb.map((v) => v.toFixed(3)).join(' ')} ${stroke ? 'RG' : 'rg'}`;
const INK = hex('#1f2328');
const MUTED = hex('#5b636e');
const RULE = hex('#dfe3e8');
const STATUS = { good: hex('#1f9d55'), watch: hex('#c98200'), trouble: hex('#d93b3b'), quiet: hex('#8a939e') };
const BOX = [
  [/explain it better|target|follow.?up|trouble|watch out|common mistake|lost/i, hex('#d93b3b')],
  [/check yourself|question|quiz|try this|practice/i, hex('#c98200')],
  [/example|worked/i, hex('#7a4fd8')],
  [/next time|tip|do this|improve|well done|good/i, hex('#1f9d55')],
  [/key idea|key point|remember|definition|summary|note/i, hex('#2f6fdb')],
];

// ---- Markdown → blocks and inline runs
export function parseInline(text) {
  const runs = [];
  const re = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_\s][^_]*)_\b|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2]) runs.push({ text: m[2], bold: true, italic: true });
    else if (m[3] || m[4]) runs.push({ text: m[3] || m[4], bold: true });
    else if (m[5] || m[6]) runs.push({ text: m[5] || m[6], italic: true });
    else if (m[7]) runs.push({ text: m[7], code: true });
    else if (m[8]) runs.push({ text: m[8], link: m[9] });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.map((r) => ({ ...r, text: pdfText(r.text.replace(/\*\*|__/g, '')) })).filter((r) => r.text);
}

export function parseMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      const lang = fence[1].toLowerCase();
      blocks.push(['chart', 'graph', 'plot'].includes(lang) ? { type: 'chart', code: body.join('\n') } : { type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: Math.min(3, heading[1].length), text: heading[2].replace(/#+\s*$/, '').trim() }); i += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i += 1; continue; }
    if (isTable(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', lines: body });
      continue;
    }
    const item = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), marker: /\d/.test(m[2]) ? m[2].replace(')', '.') : '•', text: m[3] }); i += 1; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items.at(-1).text += ` ${lines[i].trim()}`; i += 1; }
        else break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*([-*+•]|\d+[.)])\s+)/.test(lines[i]) && !(isTable(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ''))) para.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }
  return blocks;
}

// ---- layout: runs → lines that fit a width
const fontOf = (r) => (r.code ? FONTS.mono : r.bold && r.italic ? FONTS.boldItalic : r.bold ? FONTS.bold : r.italic ? FONTS.italic : FONTS.regular);

function wrap(runs, width, size) {
  const pieces = [];
  for (const r of runs) for (const part of r.text.split(/(\s+)/)) if (part) pieces.push({ ...r, text: /^\s+$/.test(part) ? ' ' : part });
  const lines = [];
  let line = [];
  let used = 0;
  const push = () => {
    while (line.length && line.at(-1).text === ' ') line.pop();
    lines.push(line);
    line = [];
    used = 0;
  };
  for (const p of pieces) {
    const font = fontOf(p);
    const w = textWidth(p.text, font, size);
    if (p.text === ' ') {
      if (line.length) { line.push({ ...p, font, w }); used += w; }
      continue;
    }
    if (used + w > width && line.length) push();
    if (w > width) {
      // A word longer than the line (a URL, a long formula): break it by characters.
      let chunk = '';
      for (const ch of p.text) {
        if (textWidth(chunk + ch, font, size) > width - used && chunk) {
          line.push({ ...p, text: chunk, font, w: textWidth(chunk, font, size) });
          push();
          chunk = '';
        }
        chunk += ch;
      }
      if (chunk) { const cw = textWidth(chunk, font, size); line.push({ ...p, text: chunk, font, w: cw }); used += cw; }
      continue;
    }
    line.push({ ...p, font, w });
    used += w;
  }
  if (line.length) push();
  return lines.length ? lines : [[]];
}

/** Text split into runs of one font: Greek and maths symbols in the Symbol font, the rest in `font`. */
function segments(text, font) {
  const out = [];
  for (const ch of text) {
    const f = isSymbol(ch) ? FONTS.symbol : font;
    if (out.length && out.at(-1).font === f) out.at(-1).text += ch;
    else out.push({ text: ch, font: f });
  }
  return out;
}

// ---- the document
class Doc {
  constructor(accent) {
    this.accent = accent;
    this.pages = [];
    this.images = [];
    this.newPage();
  }
  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE.h - PAGE.top;
  }
  room(h) {
    if (this.y - h < PAGE.bottom) this.newPage();
  }
  rect(x, y, w, h, fill, stroke = null, lineWidth = 0.6) {
    this.ops.push(`q ${fill ? rgbOp(fill) : ''} ${stroke ? `${rgbOp(stroke, true)} ${lineWidth} w` : ''} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
  }
  line(x1, y1, x2, y2, color, lineWidth = 0.6) {
    this.ops.push(`q ${rgbOp(color, true)} ${lineWidth} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`);
  }
  /** One wrapped line of runs at (x, baseline). */
  textLine(parts, x, baseline, size, color = INK, colorOf = null) {
    if (!parts.length) return;
    // Words of the same font and colour go out as one string.
    const runs = [];
    for (const p of parts) {
      const c = rgbOp(p.color || colorOf?.(p) || (p.link ? hex('#2f6fdb') : color));
      for (const seg of segments(p.text, p.font)) {
        const last = runs.at(-1);
        if (last && last.font === seg.font && last.color === c) last.text += seg.text;
        else runs.push({ ...seg, color: c });
      }
    }
    let op = `BT 1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm`;
    let font = '';
    let fill = '';
    for (const r of runs) {
      if (r.color !== fill) { op += ` ${r.color}`; fill = r.color; }
      if (r.font !== font) { op += ` /${r.font} ${size} Tf`; font = r.font; }
      op += ` ${literal(r.text, r.font)} Tj`;
    }
    this.ops.push(`${op} ET`);
  }
  text(text, x, baseline, size, font = FONTS.regular, color = INK) {
    this.textLine([{ text: pdfText(text), font }], x, baseline, size, color);
  }
  /** Wrapped runs from the current y, page breaks included. Returns nothing; moves y. */
  flow(runs, { x = PAGE.left, width = WIDTH, size = 10.5, leading = size * 1.45, color = INK, colorOf = null } = {}) {
    for (const parts of wrap(runs, width, size)) {
      this.room(leading);
      this.y -= leading;
      this.textLine(parts, x, this.y + leading * 0.28, size, color, colorOf);
    }
  }
  image(img, height) {
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, ...img });
    const w = Math.min(WIDTH, (height * img.width) / img.height);
    const h = (w * img.height) / img.width;
    this.room(h + 8);
    this.y -= h;
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${(PAGE.left + (WIDTH - w) / 2).toFixed(2)} ${this.y.toFixed(2)} cm /${name} Do Q`);
    this.y -= 8;
  }
}

function statusColor(text) {
  const word = String(text || '').trim().toLowerCase().replace(/[^a-zäöü]/g, '');
  const map = { good: 'good', gut: 'good', watch: 'watch', aufpassen: 'watch', trouble: 'trouble', problem: 'trouble', quiet: 'quiet', ruhig: 'quiet' };
  return map[word] ? STATUS[map[word]] : null;
}

function drawHeading(doc, block) {
  const sizes = { 1: 17, 2: 14, 3: 11.5 };
  const size = sizes[block.level];
  const runs = parseInline(block.text).map((r) => ({ ...r, bold: true }));
  const lines = wrap(runs, WIDTH - (block.level === 2 ? 12 : 0), size);
  const lead = size * 1.3;
  doc.room((block.level === 3 ? 14 : 22) + lines.length * lead + 40);
  doc.y -= block.level === 3 ? 8 : 16;
  const top = doc.y;
  for (const parts of lines) {
    doc.y -= lead;
    doc.textLine(parts, PAGE.left + (block.level === 2 ? 12 : 0), doc.y + lead * 0.25, size, block.level === 3 ? hex('#343a42') : INK);
  }
  if (block.level === 2) doc.rect(PAGE.left, doc.y + 3, 3.5, top - doc.y - 4, doc.accent);
  if (block.level === 1) { doc.y -= 4; doc.line(PAGE.left, doc.y, PAGE.left + WIDTH, doc.y, tint(doc.accent, 0.5), 1); }
  doc.y -= 4;
}

function drawParagraph(doc, block) {
  doc.y -= 4;
  doc.flow(parseInline(block.text));
  doc.y -= 4;
}

function drawList(doc, block) {
  doc.y -= 2;
  for (const item of block.items) {
    const indent = 6 + item.depth * 16;
    const size = 10.5;
    const lead = size * 1.45;
    const lines = wrap(parseInline(item.text), WIDTH - indent - 16, size);
    lines.forEach((parts, n) => {
      doc.room(lead);
      doc.y -= lead;
      const base = doc.y + lead * 0.28;
      if (n === 0) {
        if (item.marker === '•') doc.textLine([{ text: '•', font: FONTS.bold }], PAGE.left + indent, base, size, doc.accent);
        else doc.textLine([{ text: item.marker, font: FONTS.bold }], PAGE.left + indent - 2, base, size, doc.accent);
      }
      doc.textLine(parts, PAGE.left + indent + 16, base, size);
    });
    doc.y -= 2;
  }
  doc.y -= 4;
}

/** A quote: a coloured box when it starts with a bold label ("**Key idea:**"), otherwise a grey quote. */
function drawQuote(doc, block) {
  const text = block.lines.join('\n').trim();
  const label = /^\*\*([^*]{1,80}?):?\*\*:?\s*/.exec(text);
  const color = label ? (BOX.find(([re]) => re.test(label[1]))?.[1] || doc.accent) : hex('#8a939e');
  const fill = label ? tint(color, 0.09) : hex('#f5f6f8');
  const pad = 10;
  const size = 10.3;
  const lead = size * 1.45;
  const inner = WIDTH - pad * 2 - 4;
  const paragraphs = (label ? text.slice(label[0].length) : text).split(/\n+/).filter((l) => l.trim());
  const lines = [];
  if (label) lines.push(...wrap([{ text: pdfText(label[1].replace(/:$/, '')), bold: true, color }], inner, size).map((l) => l.map((p) => ({ ...p, color }))));
  for (const p of paragraphs) lines.push(...wrap(parseInline(p.replace(/^[-*•]\s+/, '• ')), inner, size));
  doc.y -= 6;
  // A box that fits on a page is never split: it moves to the next page whole.
  const whole = lines.length * lead + pad * 2;
  if (whole <= PAGE.h - PAGE.top - PAGE.bottom) doc.room(whole);
  let i = 0;
  while (i < lines.length) {
    doc.room(lead + pad * 2);
    const fits = Math.max(1, Math.floor((doc.y - PAGE.bottom - pad * 2) / lead));
    const part = lines.slice(i, i + fits);
    const h = part.length * lead + pad * 2 - 4;
    doc.rect(PAGE.left, doc.y - h, WIDTH, h, fill);
    doc.rect(PAGE.left, doc.y - h, 3.5, h, color);
    let y = doc.y - pad + 2;
    for (const parts of part) {
      y -= lead;
      doc.textLine(parts, PAGE.left + pad + 4, y + lead * 0.3, size, label ? INK : hex('#3b424b'));
    }
    doc.y -= h;
    i += part.length;
    if (i < lines.length) doc.newPage();
  }
  doc.y -= 8;
}

function drawTable(doc, block) {
  const cols = Math.max(block.head.length, ...block.rows.map((r) => r.length));
  const size = 9.5;
  const lead = size * 1.4;
  const pad = 5;
  const all = [block.head, ...block.rows].map((r) => Array.from({ length: cols }, (_, c) => r[c] || ''));
  const want = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r, n) => textWidth(pdfText(r[c].replace(/\*\*/g, '')), n === 0 ? FONTS.bold : FONTS.regular, size))) + pad * 2 + 1);
  // The longest single word of a column (a header such as "Understood") should not be broken.
  const word = Array.from({ length: cols }, (_, c) => Math.max(...all.flatMap((r, n) => pdfText(r[c].replace(/\*\*/g, '')).split(/\s+/).map((w) => textWidth(w, n === 0 ? FONTS.bold : FONTS.regular, size)))) + pad * 2 + 1);
  const floor = word.map((w) => Math.min(Math.max(44, w), WIDTH / cols));
  let widths = want.map((w, c) => Math.max(floor[c], w));
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > WIDTH) {
    const flexible = widths.map((w, c) => Math.max(0, w - floor[c]));
    const over = total - WIDTH;
    const flexTotal = flexible.reduce((a, b) => a + b, 0) || 1;
    widths = widths.map((w, c) => w - (over * flexible[c]) / flexTotal);
  }
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const tone = (p) => statusColor(p.text);
  doc.y -= 6;
  const drawRow = (row, header) => {
    const wrapped = row.map((cell, c) => wrap(parseInline(cell).map((r) => (header ? { ...r, bold: true } : r)), widths[c] - pad * 2, size));
    const h = Math.max(...wrapped.map((l) => l.length)) * lead + pad * 2 - 2;
    if (doc.y - h < PAGE.bottom) {
      doc.newPage();
      if (!header) drawRow(all[0], true);
    }
    doc.rect(PAGE.left, doc.y - h, tableWidth, h, header ? tint(doc.accent, 0.12) : null, RULE, 0.5);
    let x = PAGE.left;
    wrapped.forEach((lines, c) => {
      if (c) doc.line(x, doc.y, x, doc.y - h, RULE, 0.5);
      let y = doc.y - pad + 1;
      for (const parts of lines) {
        y -= lead;
        doc.textLine(header ? parts : parts.map((p) => (tone(p) ? { ...p, font: FONTS.bold } : p)), x + pad, y + lead * 0.3, size, INK, header ? null : tone);
      }
      x += widths[c];
    });
    doc.y -= h;
  };
  drawRow(all[0], true);
  for (const row of all.slice(1)) drawRow(row, false);
  doc.y -= 10;
}

function drawCode(doc, block) {
  const size = 8.8;
  const lead = size * 1.4;
  const lines = block.text.split('\n').flatMap((l) => wrap([{ text: pdfText(l) || ' ', code: true }], WIDTH - 20, size));
  doc.y -= 6;
  let i = 0;
  while (i < lines.length) {
    doc.room(lead + 16);
    const fits = Math.max(1, Math.floor((doc.y - PAGE.bottom - 16) / lead));
    const part = lines.slice(i, i + fits);
    const h = part.length * lead + 12;
    doc.rect(PAGE.left, doc.y - h, WIDTH, h, hex('#f3f4f6'));
    let y = doc.y - 6;
    for (const parts of part) {
      y -= lead;
      doc.textLine(parts, PAGE.left + 10, y + lead * 0.3, size, hex('#24292f'));
    }
    doc.y -= h;
    i += part.length;
    if (i < lines.length) doc.newPage();
  }
  doc.y -= 8;
}

function drawChart(doc, block, images) {
  const img = images?.get(block.code);
  if (img) {
    doc.y -= 4;
    doc.image(img, 250);
    return;
  }
  let title = 'Graph';
  try { title = JSON.parse(block.code).title || title; } catch { /* not JSON */ }
  doc.flow([{ text: pdfText(`[${title}: open the notes in Citrus to see this graph]`), italic: true }], { color: MUTED, size: 9.5 });
}

/** The class (and for a student, their own) understanding minute by minute, as coloured cells. */
function drawFigure(doc, figure) {
  const minutes = figure?.minutes || [];
  if (!minutes.length) return;
  const student = figure.audience === 'student';
  const rows = student ? [['You', (m) => (m.you ? { 1: 'good', 2: 'watch', 3: 'trouble' }[m.you] : 'none')], ['Class', (m) => m.status]] : [['Class', (m) => m.status]];
  const labelW = student ? 38 : 0;
  const cellW = (WIDTH - labelW) / minutes.length;
  const cellH = 14;
  const h = 26 + rows.length * (cellH + 6) + 30;
  doc.room(h);
  doc.y -= 8;
  doc.text(figure.title || (student ? 'How you followed, minute by minute' : 'How the class followed, minute by minute'), PAGE.left, doc.y - 10, 10.5, FONTS.bold, INK);
  doc.y -= 22;
  for (const [label, pick] of rows) {
    if (labelW) doc.text(label, PAGE.left, doc.y - cellH + 3.5, 8.5, FONTS.bold, MUTED);
    minutes.forEach((m, n) => {
      const s = pick(m);
      const color = s === 'none' || !STATUS[s] ? hex('#eceef1') : s === 'quiet' ? hex('#d5d9de') : STATUS[s];
      doc.rect(PAGE.left + labelW + n * cellW + 0.4, doc.y - cellH, Math.max(0.6, cellW - 0.8), cellH, color);
    });
    doc.y -= cellH + 6;
  }
  doc.text('0 min', PAGE.left + labelW, doc.y - 6, 7.5, FONTS.regular, MUTED);
  const endLabel = `${minutes.length} min`;
  doc.text(endLabel, PAGE.left + WIDTH - textWidth(endLabel, FONTS.regular, 7.5), doc.y - 6, 7.5, FONTS.regular, MUTED);
  let x = PAGE.left;
  const legend = [['good', 'Following'], ['watch', 'Some unsure'], ['trouble', 'Many lost'], ['quiet', 'Too few answers']];
  for (const [s, word] of legend) {
    doc.rect(x, doc.y - 21, 8, 8, s === 'quiet' ? hex('#d5d9de') : STATUS[s]);
    doc.text(word, x + 11, doc.y - 20, 8, FONTS.regular, MUTED);
    x += 20 + textWidth(word, FONTS.regular, 8);
  }
  doc.y -= 34;
}

/** The finished file: objects, cross-reference table and trailer, as bytes. */
function assemble(doc, { title, footer }) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesId = add(null);
  const fontIds = {
    F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    F3: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'),
    F4: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>'),
    F5: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
    F6: add('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>'),
  };
  const imageIds = {};
  for (const img of doc.images) {
    let bytes = '';
    for (let i = 0; i < img.data.length; i += 0x8000) bytes += String.fromCharCode.apply(null, img.data.subarray(i, i + 0x8000));
    imageIds[img.name] = add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n${bytes}\nendstream`);
  }
  const fonts = Object.entries(fontIds).map(([k, v]) => `/${k} ${v} 0 R`).join(' ');
  const xobjects = Object.entries(imageIds).map(([k, v]) => `/${k} ${v} 0 R`).join(' ');
  const resources = `<< /Font << ${fonts} >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >>`;
  const total = doc.pages.length;
  const pageIds = doc.pages.map((ops, n) => {
    const foot = [];
    const y = PAGE.bottom - 30;
    foot.push(`q ${rgbOp(RULE, true)} 0.5 w ${PAGE.left} ${y + 12} m ${PAGE.w - PAGE.right} ${y + 12} l S Q`);
    foot.push(`BT /F1 8 Tf ${rgbOp(MUTED)} ${PAGE.left} ${y} Td ${literal(pdfText(footer))} Tj ET`);
    const num = `${n + 1} / ${total}`;
    foot.push(`BT /F1 8 Tf ${rgbOp(MUTED)} ${(PAGE.w - PAGE.right - textWidth(num, FONTS.regular, 8)).toFixed(2)} ${y} Td ${literal(num)} Tj ET`);
    const content = [...ops, ...foot].join('\n');
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources ${resources} /Contents ${contentId} 0 R >>`);
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  const info = add(`<< /Title ${literal(pdfText(title, { spell: true }))} /Producer (Citrus) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, n) => {
    offsets.push(out.length);
    out += `${n + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}

/**
 * Notes as a PDF. The first "# " heading of the Markdown becomes the title when no title is given.
 * @returns {Uint8Array}
 */
export function notesPdf({ title = '', subtitle = '', kicker = 'Citrus', markdown = '', accent = '#F07A2E', figure = null, images = null, footer = 'Citrus · Student project · M. Mangena' } = {}) {
  const blocks = parseMarkdown(markdown);
  if (blocks[0]?.type === 'heading' && blocks[0].level === 1) {
    if (!title) title = blocks[0].text;
    blocks.shift();
  }
  const doc = new Doc(hex(accent));
  // Title block: a coloured band, the kicker, the title and what it is about.
  doc.rect(0, PAGE.h - 8, PAGE.w, 8, doc.accent);
  doc.y -= 4;
  doc.flow([{ text: pdfText(kicker.toUpperCase()), bold: true }], { size: 8.5, color: doc.accent, leading: 12 });
  doc.y -= 2;
  doc.flow(parseInline(title || 'Notes').map((r) => ({ ...r, bold: true })), { size: 21, leading: 26 });
  if (subtitle) {
    doc.y -= 2;
    doc.flow(parseInline(subtitle), { size: 10, color: MUTED, leading: 14 });
  }
  doc.y -= 10;
  doc.line(PAGE.left, doc.y, PAGE.left + WIDTH, doc.y, RULE, 0.8);
  doc.y -= 4;
  if (figure) drawFigure(doc, figure);
  for (const block of blocks) {
    if (block.type === 'heading') drawHeading(doc, block);
    else if (block.type === 'paragraph') drawParagraph(doc, block);
    else if (block.type === 'list') drawList(doc, block);
    else if (block.type === 'quote') drawQuote(doc, block);
    else if (block.type === 'table') drawTable(doc, block);
    else if (block.type === 'code') drawCode(doc, block);
    else if (block.type === 'chart') drawChart(doc, block, images);
    else if (block.type === 'rule') {
      doc.room(14);
      doc.y -= 7;
      doc.line(PAGE.left, doc.y, PAGE.left + WIDTH, doc.y, RULE, 0.8);
      doc.y -= 7;
    }
  }
  return assemble(doc, { title: title || 'Notes', footer });
}
