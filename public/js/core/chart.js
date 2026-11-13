/**
 * Graphs in answers, drawn like a textbook figure: white paper, dark ink, ticks with round numbers, light grid,
 * labelled axes, a legend, and the figure's title. The model writes a ```chart block with JSON (src/ai/prompts.js,
 * CHART_GUIDE); markdown.js turns it into an <svg> with this module, so it can be copied as a picture or saved.
 *
 *   chartSvg(spec) → SVG markup                       parseChart(text) → spec | null
 *   compileExpression('2x^2 - 3') → (x) => number     (no eval: a small parser for + - * / ^, functions, pi, e)
 *
 * Spec: { type: 'line' | 'bar' | 'scatter' | 'function' | 'pie' | 'area', title, caption,
 *         x: { label, min, max, categories }, y: { label, min, max },
 *         series: [{ name, points: [[x, y], …] } | { name, values: [y, …] }],
 *         functions: [{ name, expr, from, to }],
 *         lines: [{ x | y, label }], annotations: [{ x, y, label }] }
 * Any type can carry functions, so a supply-and-demand diagram or a fitted curve over data points works too.
 */

let chartSeq = 0;
const W = 640;
const H = 400;
const INK = '#1f2328';
const SOFT = '#57606a';
const GRID = '#e6e8eb';
const PAPER = '#ffffff';
const COLORS = ['#2563eb', '#ea580c', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777'];
const FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif\"";

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const finite = (v) => Number.isFinite(v);
const fmt = (v) => {
  if (!finite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(1).replace('e+', 'e');
  return String(Math.round(v * 1e6) / 1e6).replace('-', '−');
};

// ---------------------------------------------------------------- expressions

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, lg: Math.log10, log10: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, e: Math.E, π: Math.PI };

/** (x) => number for a formula such as "2x^2 - 3x + 1", "e^(-x/2) sin(3x)" or "max(0, 10 - 2*x)". Throws on nonsense. */
export function compileExpression(source) {
  const text = String(source || '').replace(/\*\*/g, '^').replace(/·|×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\\cdot/g, '*')
    .replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, '').trim();
  if (!text || text.length > 300) throw new Error('No formula');
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([a-zA-Zπ][a-zA-Z0-9_]*)|(\S))/gy;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1] !== undefined) tokens.push({ t: 'n', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2].toLowerCase() });
    else if ('+-*/^(),'.includes(m[3])) tokens.push({ t: m[3] });
    else throw new Error(`Unexpected ${m[3]}`);
  }
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => (tokens[i]?.t === t ? tokens[i++] : null);
  const startsPrimary = (tok) => tok && (tok.t === 'n' || tok.t === 'id' || tok.t === '(');

  function expr() {
    let left = term();
    for (;;) {
      if (take('+')) { const a = left; const b = term(); left = (x) => a(x) + b(x); }
      else if (take('-')) { const a = left; const b = term(); left = (x) => a(x) - b(x); }
      else return left;
    }
  }
  function term() {
    let left = unary();
    for (;;) {
      if (take('*')) { const a = left; const b = unary(); left = (x) => a(x) * b(x); }
      else if (take('/')) { const a = left; const b = unary(); left = (x) => a(x) / b(x); }
      else if (startsPrimary(peek())) { const a = left; const b = power(); left = (x) => a(x) * b(x); } // 2x, 3(x+1), x sin(x)
      else return left;
    }
  }
  function unary() {
    if (take('-')) { const a = unary(); return (x) => -a(x); }
    if (take('+')) return unary();
    return power();
  }
  function power() {
    const base = primary();
    if (take('^')) { const ex = unary(); return (x) => base(x) ** ex(x); } // right-associative, -x^2 = -(x^2)
    return base;
  }
  function primary() {
    const tok = tokens[i++];
    if (!tok) throw new Error('Formula ends too early');
    if (tok.t === 'n') return () => tok.v;
    if (tok.t === '(') {
      const inner = expr();
      if (!take(')')) throw new Error('Missing )');
      return inner;
    }
    if (tok.t === 'id') {
      if (tok.v === 'x') return (x) => x;
      if (Object.hasOwn(CONSTS, tok.v)) return () => CONSTS[tok.v];
      const fn = Object.hasOwn(FUNCS, tok.v) ? FUNCS[tok.v] : null; // own names only: never "constructor" and the like
      if (!fn) throw new Error(`Unknown name ${tok.v}`);
      if (take('(')) {
        const args = [expr()];
        while (take(',')) args.push(expr());
        if (!take(')')) throw new Error('Missing )');
        return (x) => fn(...args.map((a) => a(x)));
      }
      const arg = power(); // "sin x", "ln 2x"
      return (x) => fn(arg(x));
    }
    throw new Error('Unexpected symbol');
  }
  const f = expr();
  if (i < tokens.length) throw new Error('Unexpected text after the formula');
  return f;
}

// ---------------------------------------------------------------- scales

function niceStep(span, target = 6) {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function niceRange(lo, hi, { zero = false } = {}) {
  if (!finite(lo) || !finite(hi)) return [0, 1];
  if (zero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.5 || 1;
    hi += Math.abs(hi) * 0.5 || 1;
  }
  const step = niceStep(hi - lo);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

const ticks = (lo, hi) => {
  const step = niceStep(hi - lo);
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out.slice(0, 20);
};

/** Values to fit the y-axis to, without letting an asymptote flatten everything else. */
function robustRange(values) {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
  const lo = at(0.02);
  const hi = at(0.98);
  const pad = (hi - lo) * 0.08 || 1;
  return [Math.max(v[0], lo - pad), Math.min(v[v.length - 1], hi + pad)];
}

// ---------------------------------------------------------------- spec

/** The spec from a ```chart block, forgiving trailing commas and comments; null when it is not usable. */
export function parseChart(source) {
  const text = String(source || '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1').trim();
  if (!text.startsWith('{')) return null;
  try {
    const spec = JSON.parse(text);
    return spec && typeof spec === 'object' ? spec : null;
  } catch {
    return null;
  }
}

function prepare(spec) {
  const type = ['line', 'bar', 'scatter', 'function', 'pie', 'area'].includes(spec.type) ? spec.type : (spec.functions?.length && !spec.series?.length ? 'function' : 'line');
  const x = spec.x || spec.xAxis || {};
  const y = spec.y || spec.yAxis || {};
  const series = (Array.isArray(spec.series) ? spec.series : spec.data ? [{ name: spec.name || '', points: spec.data }] : []).slice(0, 8).map((s, k) => ({
    name: String(s.name ?? s.label ?? '').slice(0, 60),
    color: COLORS[k % COLORS.length],
    points: Array.isArray(s.points) ? s.points.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [num(p?.x), num(p?.y)])).filter((p) => finite(p[0]) && finite(p[1])).slice(0, 2000) : [],
    values: Array.isArray(s.values) ? s.values.map(num).slice(0, 60) : null,
  }));
  const fx = (Array.isArray(spec.functions) ? spec.functions : spec.expr ? [{ expr: spec.expr, name: spec.name }] : []).slice(0, 6).map((f, k) => {
    let fn = null;
    try {
      fn = compileExpression(f.expr ?? f.expression ?? f.formula);
    } catch {
      fn = null;
    }
    return { name: String(f.name ?? f.label ?? f.expr ?? '').slice(0, 60), fn, from: num(f.from), to: num(f.to), color: COLORS[(series.length + k) % COLORS.length], dashed: !!f.dashed };
  }).filter((f) => f.fn);
  return { type, x, y, series, fx, title: String(spec.title || '').slice(0, 120), caption: String(spec.caption || '').slice(0, 240), lines: Array.isArray(spec.lines) ? spec.lines.slice(0, 8) : [], notes: Array.isArray(spec.annotations) ? spec.annotations.slice(0, 12) : [] };
}

// ---------------------------------------------------------------- drawing

function frame(c, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(c.title || 'Chart')}" ${FONT} font-size="13">
<rect width="${W}" height="${H}" fill="${PAPER}"/>${c.title ? `<text x="${W / 2}" y="26" text-anchor="middle" font-size="16" font-weight="600" fill="${INK}">${esc(c.title)}</text>` : ''}${inner}</svg>`;
}

/** A legend row under the title, centred, so it never covers the data. Only when there is more than one name. */
const named = (items) => items.filter((s) => s.name);
const hasLegend = (items) => named(items).length >= 2;
function legend(items, y) {
  const list = named(items);
  if (list.length < 2) return '';
  const widths = list.map((s) => 30 + s.name.length * 7);
  let x = Math.max(12, (W - widths.reduce((a, b) => a + b, 0)) / 2);
  return `<g>${list.map((s, k) => {
    const at = x;
    x += widths[k];
    return `<line x1="${at}" x2="${at + 18}" y1="${y}" y2="${y}" stroke="${s.color}" stroke-width="3"${s.dashed ? ' stroke-dasharray="6 4"' : ''}/><text x="${at + 24}" y="${y + 4}" fill="${INK}">${esc(s.name)}</text>`;
  }).join('')}</g>`;
}

function cartesian(c) {
  const keyed = hasLegend([...c.series, ...c.fx]);
  const box = { left: 70, right: W - 24, top: (c.title ? 44 : 20) + (keyed ? 22 : 0), bottom: H - 56 };
  // x range
  const xs = c.series.flatMap((s) => s.points.map((p) => p[0]));
  for (const f of c.fx) if (finite(f.from) && finite(f.to)) xs.push(f.from, f.to);
  let [x0, x1] = [num(c.x.min), num(c.x.max)];
  if (!finite(x0) || !finite(x1) || x1 <= x0) {
    const [lo, hi] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [-10, 10];
    [x0, x1] = c.series.length ? niceRange(lo, hi) : [finite(x0) ? x0 : lo, finite(x1) ? x1 : hi];
    if (!(x1 > x0)) [x0, x1] = [-10, 10];
  }
  // sample the functions
  const curves = c.fx.map((f) => {
    const a = finite(f.from) ? Math.max(x0, f.from) : x0;
    const b = finite(f.to) ? Math.min(x1, f.to) : x1;
    const pts = [];
    for (let k = 0; k <= 320; k += 1) {
      const xv = a + ((b - a) * k) / 320;
      let yv;
      try {
        yv = f.fn(xv);
      } catch {
        yv = NaN;
      }
      pts.push([xv, finite(yv) ? yv : NaN]);
    }
    return { ...f, points: pts };
  });
  // y range
  let [y0, y1] = [num(c.y.min), num(c.y.max)];
  if (!finite(y0) || !finite(y1) || y1 <= y0) {
    const ys = [...c.series.flatMap((s) => s.points.map((p) => p[1])), ...c.notes.map((n) => num(n.y)), ...c.lines.map((l) => num(l.y))];
    const [rlo, rhi] = curves.length ? robustRange([...ys, ...curves.flatMap((cv) => cv.points.map((p) => p[1]))]) : [Math.min(...ys.filter(finite)), Math.max(...ys.filter(finite))];
    const [nlo, nhi] = niceRange(rlo, rhi, { zero: c.type === 'bar' || c.type === 'area' });
    y0 = finite(y0) ? y0 : nlo;
    y1 = finite(y1) ? y1 : nhi;
    if (!(y1 > y0)) [y0, y1] = [0, 1];
  }
  const X = (v) => box.left + ((v - x0) / (x1 - x0)) * (box.right - box.left);
  const Y = (v) => box.bottom - ((v - y0) / (y1 - y0)) * (box.bottom - box.top);
  const out = [];
  // grid and ticks
  const xt = ticks(x0, x1);
  const yt = ticks(y0, y1);
  out.push(`<g stroke="${GRID}" stroke-width="1">${xt.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${box.top}" y2="${box.bottom}"/>`).join('')}${yt.map((v) => `<line x1="${box.left}" x2="${box.right}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>`);
  // axes: through the origin when it is in view (a textbook graph of a function), otherwise along the edges
  const ax = x0 < 0 && x1 > 0 ? X(0) : box.left;
  const ay = y0 < 0 && y1 > 0 ? Y(0) : box.bottom;
  out.push(`<g stroke="${INK}" stroke-width="1.4" fill="none"><line x1="${box.left}" x2="${box.right + 6}" y1="${ay}" y2="${ay}"/><line x1="${ax}" x2="${ax}" y1="${box.bottom}" y2="${box.top - 6}"/>
<path d="M${box.right + 6} ${ay} l-8 -4 v8 z M${ax} ${box.top - 6} l-4 8 h8 z" fill="${INK}" stroke="none"/></g>`);
  out.push(`<g fill="${SOFT}" font-size="12">${xt.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${ay}" y2="${ay + 5}" stroke="${INK}"/><text x="${X(v)}" y="${Math.min(box.bottom + 18, ay + 18)}" text-anchor="middle">${fmt(v)}</text>`).join('')}${yt.map((v) => `<line x1="${ax - 5}" x2="${ax}" y1="${Y(v)}" y2="${Y(v)}" stroke="${INK}"/><text x="${Math.max(box.left - 8, ax - 8)}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}</g>`);
  if (c.x.label) out.push(`<text x="${(box.left + box.right) / 2}" y="${H - 14}" text-anchor="middle" fill="${INK}" font-size="13">${esc(c.x.label)}</text>`);
  if (c.y.label) out.push(`<text transform="translate(18 ${(box.top + box.bottom) / 2}) rotate(-90)" text-anchor="middle" fill="${INK}" font-size="13">${esc(c.y.label)}</text>`);
  // Each figure clips with its own id: several graphs in one answer must not borrow each other's clip.
  const clip = `plot-${(chartSeq += 1).toString(36)}`;
  out.push(`<clipPath id="${clip}"><rect x="${box.left}" y="${box.top - 2}" width="${box.right - box.left}" height="${box.bottom - box.top + 4}"/></clipPath><g clip-path="url(#${clip})">`);
  // reference lines
  for (const l of c.lines) {
    if (finite(num(l.x))) out.push(`<line x1="${X(num(l.x))}" x2="${X(num(l.x))}" y1="${box.top}" y2="${box.bottom}" stroke="${SOFT}" stroke-dasharray="5 4"/>${l.label ? `<text x="${X(num(l.x)) + 4}" y="${box.top + 14}" fill="${SOFT}" font-size="12">${esc(l.label)}</text>` : ''}`);
    else if (finite(num(l.y))) out.push(`<line x1="${box.left}" x2="${box.right}" y1="${Y(num(l.y))}" y2="${Y(num(l.y))}" stroke="${SOFT}" stroke-dasharray="5 4"/>${l.label ? `<text x="${box.left + 6}" y="${Y(num(l.y)) - 5}" fill="${SOFT}" font-size="12">${esc(l.label)}</text>` : ''}`);
  }
  // data
  const path = (pts) => {
    let d = '';
    let pen = false;
    const span = y1 - y0;
    for (let k = 0; k < pts.length; k += 1) {
      const [px, py] = pts[k];
      const prev = pts[k - 1];
      if (!finite(py) || (prev && finite(prev[1]) && Math.abs(py - prev[1]) > span * 3)) {
        pen = false;
        if (!finite(py)) continue;
      }
      d += `${pen ? 'L' : 'M'}${X(px).toFixed(1)} ${Y(Math.max(y0 - span, Math.min(y1 + span, py))).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  for (const s of c.series) {
    const pts = [...s.points].sort((a, b) => a[0] - b[0]);
    if (c.type === 'scatter') out.push(pts.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4" fill="${s.color}" fill-opacity="0.85"/>`).join(''));
    else {
      if (c.type === 'area' && pts.length) out.push(`<path d="${path(pts)}L${X(pts[pts.length - 1][0])} ${Y(Math.max(y0, 0))} L${X(pts[0][0])} ${Y(Math.max(y0, 0))} Z" fill="${s.color}" fill-opacity="0.15"/>`);
      out.push(`<path d="${path(pts)}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (pts.length <= 24) out.push(pts.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3.2" fill="${PAPER}" stroke="${s.color}" stroke-width="2"/>`).join(''));
    }
  }
  for (const cv of curves) out.push(`<path d="${path(cv.points)}" fill="none" stroke="${cv.color}" stroke-width="2.5" stroke-linejoin="round"${cv.dashed ? ' stroke-dasharray="7 5"' : ''}/>`);
  for (const n of c.notes) {
    const nx = num(n.x);
    const ny = num(n.y);
    if (!finite(nx) || !finite(ny)) continue;
    out.push(`<circle cx="${X(nx)}" cy="${Y(ny)}" r="4.5" fill="${INK}"/>${n.label ? `<text x="${X(nx) + 8}" y="${Y(ny) - 8}" fill="${INK}" font-size="12.5" font-weight="600">${esc(n.label)}</text>` : ''}`);
  }
  out.push('</g>');
  out.push(legend([...c.series, ...curves], box.top - 16));
  return frame(c, out.join(''));
}

function bars(c) {
  const box = { left: 70, right: W - 24, top: (c.title ? 44 : 20) + (hasLegend(c.series) ? 22 : 0), bottom: H - 64 };
  const cats = (Array.isArray(c.x.categories) ? c.x.categories : c.series[0]?.points?.map((p) => p[0]) || []).slice(0, 30).map(String);
  const values = c.series.map((s) => (s.values || s.points.map((p) => p[1])).slice(0, cats.length));
  const all = values.flat().filter(finite);
  const [y0, y1] = finite(num(c.y.min)) && finite(num(c.y.max)) ? [num(c.y.min), num(c.y.max)] : niceRange(Math.min(0, ...all), Math.max(0, ...all), { zero: true });
  const Y = (v) => box.bottom - ((v - y0) / (y1 - y0)) * (box.bottom - box.top);
  const slot = (box.right - box.left) / Math.max(1, cats.length);
  const bw = Math.min(56, (slot * 0.75) / Math.max(1, values.length));
  const out = [];
  out.push(`<g stroke="${GRID}">${ticks(y0, y1).map((v) => `<line x1="${box.left}" x2="${box.right}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>`);
  out.push(`<g fill="${SOFT}" font-size="12">${ticks(y0, y1).map((v) => `<text x="${box.left - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}</g>`);
  values.forEach((vals, k) => {
    vals.forEach((v, j) => {
      if (!finite(v)) return;
      const x = box.left + slot * j + (slot - bw * values.length) / 2 + bw * k;
      const top = Y(Math.max(0, v));
      const h = Math.abs(Y(v) - Y(0));
      out.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${c.series[k].color}"/>`);
      if (cats.length * values.length <= 16) out.push(`<text x="${(x + bw / 2 - 1.5).toFixed(1)}" y="${(v >= 0 ? top - 5 : top + h + 14).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="${INK}">${fmt(v)}</text>`);
    });
  });
  const rotate = cats.some((t) => t.length > 9) && cats.length > 4;
  out.push(`<g fill="${INK}" font-size="12">${cats.map((t, j) => {
    const x = box.left + slot * j + slot / 2;
    return rotate ? `<text transform="translate(${x} ${box.bottom + 14}) rotate(-30)" text-anchor="end">${esc(t.slice(0, 22))}</text>` : `<text x="${x}" y="${box.bottom + 18}" text-anchor="middle">${esc(t.slice(0, 22))}</text>`;
  }).join('')}</g>`);
  out.push(`<line x1="${box.left}" x2="${box.right}" y1="${Y(0)}" y2="${Y(0)}" stroke="${INK}" stroke-width="1.4"/><line x1="${box.left}" x2="${box.left}" y1="${box.top}" y2="${box.bottom}" stroke="${INK}" stroke-width="1.4"/>`);
  if (c.x.label) out.push(`<text x="${(box.left + box.right) / 2}" y="${H - 10}" text-anchor="middle" fill="${INK}">${esc(c.x.label)}</text>`);
  if (c.y.label) out.push(`<text transform="translate(18 ${(box.top + box.bottom) / 2}) rotate(-90)" text-anchor="middle" fill="${INK}">${esc(c.y.label)}</text>`);
  out.push(legend(c.series, box.top - 16));
  return frame(c, out.join(''));
}

function pie(c) {
  const s = c.series[0] || { values: [], points: [] };
  const labels = (c.x.categories || s.points.map((p) => p[0])).map(String);
  const vals = (s.values || s.points.map((p) => p[1])).map(num).filter((v) => finite(v) && v > 0).slice(0, 12);
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = 230;
  const cy = c.title ? 222 : 205;
  const r = 140;
  let angle = -Math.PI / 2;
  const out = [];
  vals.forEach((v, k) => {
    const sweep = (v / total) * Math.PI * 2;
    const a2 = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
    out.push(vals.length === 1 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS[0]}"/>` : `<path d="M${cx} ${cy} L${p(angle)} A${r} ${r} 0 ${large} 1 ${p(a2)} Z" fill="${COLORS[k % COLORS.length]}" stroke="${PAPER}" stroke-width="2"/>`);
    const mid = angle + sweep / 2;
    if (v / total > 0.05) out.push(`<text x="${(cx + r * 0.62 * Math.cos(mid)).toFixed(1)}" y="${(cy + r * 0.62 * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" fill="#fff" font-weight="600">${Math.round((100 * v) / total)}%</text>`);
    out.push(`<rect x="410" y="${70 + k * 24}" width="14" height="14" rx="3" fill="${COLORS[k % COLORS.length]}"/><text x="432" y="${82 + k * 24}" fill="${INK}">${esc((labels[k] || `Part ${k + 1}`).slice(0, 26))} (${fmt(v)})</text>`);
    angle = a2;
  });
  return frame(c, out.join(''));
}

/** SVG markup for a chart spec. Never throws: a broken spec gives a small note instead. */
export function chartSvg(spec) {
  try {
    const c = prepare(spec || {});
    if (c.type === 'pie') return pie(c);
    if (c.type === 'bar') return bars(c);
    if (!c.series.some((s) => s.points.length) && !c.fx.length) throw new Error('empty');
    return cartesian(c);
  } catch {
    return frame({ title: 'This graph could not be drawn' }, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${SOFT}">The data for this graph was incomplete.</text>`);
  }
}

/** The figure markdown.js puts in an answer: the graph, its caption and the copy and download buttons. */
export function chartFigure(source, { streaming = false } = {}) {
  const spec = parseChart(source);
  if (!spec) return streaming ? '<figure class="chart is-drawing"><span class="typing"><i></i><i></i><i></i></span> Drawing the graph…</figure>' : `<pre><code>${esc(source)}</code></pre>`;
  const caption = spec.caption || spec.title || '';
  return `<figure class="chart">${chartSvg(spec)}<figcaption>${caption ? `<span>${esc(caption)}</span>` : '<span></span>'}<span class="chart-actions">`
    + '<button type="button" class="btn btn-ghost btn-sm" data-chart-action="copy">Copy image</button>'
    + '<button type="button" class="btn btn-ghost btn-sm" data-chart-action="png">Save PNG</button>'
    + '<button type="button" class="btn btn-ghost btn-sm" data-chart-action="svg">Save SVG</button></span></figcaption></figure>';
}
