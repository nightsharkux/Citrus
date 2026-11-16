/**
 * Illustrations that Citrus's eye turns into while it explains something.
 *
 * Each visual draws inside the eye (SVG user space, centre 0,0, radius ~32)
 * and may animate with CSS (face.css) or a small JS loop. Add a visual by
 * adding an entry to VISUALS: { draw(content) -> markup, start?(layer) -> stop }.
 * All text is escaped; colours come from the theme tokens.
 */
import { escape } from '../core/dom.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const r1 = (n) => Math.round(n * 10) / 10;

/** Turn plain-text maths into nicer glyphs: a^2 → a², sqrt → √, pi → π … */
export function prettyMath(s) {
  return String(s || '')
    .replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\^n/g, 'ⁿ').replace(/\^-?1\b/g, '⁻¹')
    .replace(/sqrt\s*/gi, '√').replace(/\bpi\b/gi, 'π').replace(/\binf(inity)?\b/gi, '∞')
    .replace(/\bsum\b/gi, '∑').replace(/\bint(egral)?\b/gi, '∫').replace(/\bdelta\b/gi, 'Δ')
    .replace(/\btheta\b/gi, 'θ').replace(/\balpha\b/gi, 'α').replace(/\bbeta\b/gi, 'β').replace(/\blambda\b/gi, 'λ')
    .replace(/\bmu\b/gi, 'μ').replace(/\bsigma\b/gi, 'σ')
    .replace(/>=/g, '≥').replace(/<=/g, '≤').replace(/!=/g, '≠').replace(/->/g, '→').replace(/\*/g, '·')
    .replace(/\s+/g, ' ').trim();
}

/** "Lectures 12, Seminars 7" → [{ label: 'Lectures', value: 12 }, …] */
export function parseNumbers(content) {
  return String(content || '').split(/[,;\n]/).map((part) => {
    const m = /-?\d+(?:\.\d+)?/.exec(part.replace(/(\d),(\d{3})/g, '$1$2'));
    if (!m) return null;
    return { label: part.replace(m[0], '').replace(/[%:=]/g, '').trim().slice(0, 10), value: Number(m[0]) };
  }).filter(Boolean).slice(0, 4);
}

const fmt = (n) => (Math.abs(n) >= 10_000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : Number.isInteger(n) ? n.toLocaleString() : n.toFixed(Math.min(2, String(n).split('.')[1]?.length || 0)));

// ------------------------------------------------------------------ figures

function stickman(x, { wave = false, nod = false, walk = false, delay = 0 } = {}) {
  const arm = wave
    ? `<line class="fv-stroke" x1="${x}" y1="-4" x2="${x - 7}" y2="3"/><g class="fv-wave" style="transform-origin:${x}px -4px;animation-delay:${delay}ms"><line class="fv-stroke" x1="${x}" y1="-4" x2="${x + 7}" y2="-12"/></g>`
    : `<line class="fv-stroke" x1="${x}" y1="-4" x2="${x - 7}" y2="3"/><line class="fv-stroke" x1="${x}" y1="-4" x2="${x + 7}" y2="3"/>`;
  const legs = walk
    ? `<g class="fv-leg" style="transform-origin:${x}px 6px"><line class="fv-stroke" x1="${x}" y1="6" x2="${x}" y2="17"/></g><g class="fv-leg back" style="transform-origin:${x}px 6px"><line class="fv-stroke" x1="${x}" y1="6" x2="${x}" y2="17"/></g>`
    : `<line class="fv-stroke" x1="${x}" y1="6" x2="${x - 5}" y2="17"/><line class="fv-stroke" x1="${x}" y1="6" x2="${x + 5}" y2="17"/>`;
  return `<g class="${nod ? 'fv-nod' : ''}" style="animation-delay:${delay}ms">
    <circle class="fv-stroke" cx="${x}" cy="-12" r="4.6"/>
    <line class="fv-stroke" x1="${x}" y1="-7.4" x2="${x}" y2="6"/>${arm}${legs}</g>`;
}

// ------------------------------------------------------------------ visuals

const VISUALS = {
  formula: {
    label: (c) => `Formula ${c}`,
    draw(content) {
      const text = prettyMath(content) || 'a² + b² = c²';
      const floats = [['∑', -22, -16], ['π', 21, -19], ['√', -24, 15], ['∫', 22, 13], ['Δ', -2, -25], ['∞', 3, 24]]
        .map(([g, x, y], i) => `<text class="fv-ink fv-float" x="${x}" y="${y}" font-size="7" text-anchor="middle" style="animation-delay:${i * 450}ms">${g}</text>`).join('');
      if (text.length <= 10) {
        const size = text.length <= 5 ? 17 : text.length <= 8 ? 13 : 11;
        const chars = [...text].map((ch, i) => `<tspan class="fv-char" style="animation-delay:${120 + i * 70}ms">${escape(ch)}</tspan>`).join('');
        const half = Math.min(26, text.length * size * 0.29);
        return `${floats}<text class="fv-ink fv-formula" font-size="${size}" text-anchor="middle" y="${r1(size * 0.36)}">${chars}</text>
          <line class="fv-accent-stroke fv-draw" pathLength="1" x1="${-half}" x2="${half}" y1="${r1(size * 0.36 + 6)}" y2="${r1(size * 0.36 + 6)}" stroke-width="2.4"/>`;
      }
      return `${floats}<g class="fv-marquee"><text class="fv-ink fv-formula" font-size="12" y="4">${escape(text)}</text></g>`;
    },
    start(layer) {
      const g = layer.querySelector('.fv-marquee');
      if (!g) return null;
      const width = g.querySelector('text').getComputedTextLength();
      if (reduced()) {
        g.setAttribute('transform', `translate(${r1(-width / 2)} 0)`);
        return null;
      }
      let x = 30;
      let last = performance.now();
      let raf = requestAnimationFrame(function step(now) {
        x -= ((now - last) / 1000) * 16;
        last = now;
        if (x < -width - 30) x = 30;
        g.setAttribute('transform', `translate(${r1(x)} 0)`);
        raf = requestAnimationFrame(step);
      });
      return () => cancelAnimationFrame(raf);
    },
  },

  numbers: {
    label: (c) => `Numbers ${c}`,
    draw(content) {
      const values = parseNumbers(content);
      if (values.length >= 2) return VISUALS.chart.draw(values);
      const v = values[0];
      return `<circle class="fv-faint-stroke" r="27" stroke-width="2.5"/>
        <circle class="fv-accent-stroke fv-draw slow" r="27" stroke-width="2.5" pathLength="1" transform="rotate(-90)"/>
        <text class="fv-ink fv-number" font-size="${v && fmt(v.value).length > 4 ? 12 : 17}" text-anchor="middle" y="${v?.label ? 3 : 6}" data-to="${v ? v.value : 123}">0</text>
        ${v?.label ? `<text class="fv-ink fv-label" font-size="6" text-anchor="middle" y="14">${escape(v.label)}</text>` : ''}`;
    },
    start(layer) {
      const el = layer.querySelector('.fv-number');
      if (!el) return VISUALS.chart.start?.(layer) || null;
      const to = Number(el.dataset.to);
      if (reduced()) {
        el.textContent = fmt(to);
        return null;
      }
      const t0 = performance.now();
      let raf = requestAnimationFrame(function step(now) {
        const p = Math.min(1, (now - t0) / 1600);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(Number.isInteger(to) ? Math.round(to * eased) : to * eased);
        if (p < 1) raf = requestAnimationFrame(step);
      });
      return () => cancelAnimationFrame(raf);
    },
  },

  chart: {
    label: () => 'Comparison chart',
    draw(input) {
      const values = Array.isArray(input) ? input : parseNumbers(input);
      const data = values.length >= 2 ? values : [{ value: 4 }, { value: 7 }, { value: 5 }, { value: 9 }];
      const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
      const n = data.length;
      const w = 8;
      const gap = n > 3 ? 4 : 6;
      const x0 = -(n * w + (n - 1) * gap) / 2;
      const bars = data.map((d, i) => {
        const h = Math.max(3, (Math.abs(d.value) / max) * 30);
        const x = x0 + i * (w + gap);
        return `<rect class="fv-bar ${i % 2 ? 'alt' : ''}" x="${r1(x)}" y="${r1(16 - h)}" width="${w}" height="${r1(h)}" rx="2" style="animation-delay:${i * 130}ms,${900 + i * 200}ms"/>
          ${values.length >= 2 ? `<text class="fv-ink fv-label fv-char" font-size="5" text-anchor="middle" x="${r1(x + w / 2)}" y="${r1(13 - h)}" style="animation-delay:${600 + i * 130}ms">${escape(fmt(d.value))}</text>` : ''}`;
      }).join('');
      return `${bars}<line class="fv-stroke thin" x1="${r1(x0 - 4)}" x2="${r1(-x0 + 4)}" y1="16.5" y2="16.5"/>`;
    },
  },

  sort: {
    label: () => 'Sorting',
    draw() {
      const heights = [12, 26, 18, 30, 8];
      return heights.map((h, i) => `<rect class="fv-sort-bar" data-h="${h}" x="-3" y="${16 - h}" width="6" height="${h}" rx="1.5" style="transform:translateX(${(i - 2) * 9}px)"/>`).join('')
        + '<line class="fv-stroke thin" x1="-25" x2="25" y1="16.5" y2="16.5"/>';
    },
    start(layer) {
      const bars = [...layer.querySelectorAll('.fv-sort-bar')];
      const place = (order) => order.forEach((bar, i) => (bar.style.transform = `translateX(${(i - 2) * 9}px)`));
      let order = [...bars];
      if (reduced()) {
        place(order.sort((a, b) => a.dataset.h - b.dataset.h));
        return null;
      }
      let i = 0;
      let pass = 0;
      const timer = setInterval(() => {
        bars.forEach((b) => b.classList.remove('is-compared', 'is-done'));
        if (pass >= order.length - 1) {
          order.forEach((b) => b.classList.add('is-done'));
          if (++i > 3) {
            order = order.map((b) => [Math.random(), b]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
            place(order);
            i = 0;
            pass = 0;
          }
          return;
        }
        const a = order[i];
        const b = order[i + 1];
        a.classList.add('is-compared');
        b.classList.add('is-compared');
        if (Number(a.dataset.h) > Number(b.dataset.h)) {
          [order[i], order[i + 1]] = [b, a];
          place(order);
        }
        i += 1;
        if (i >= order.length - 1 - pass) {
          i = 0;
          pass += 1;
        }
      }, 620);
      return () => clearInterval(timer);
    },
  },

  steps: {
    label: (c) => `Steps ${c}`,
    draw(content) {
      const names = String(content || '').split(/[,;>→]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
      const n = Math.max(3, Math.min(4, names.length || 3));
      const xs = Array.from({ length: n }, (_, i) => -24 + (48 / (n - 1)) * i);
      const nodes = xs.map((x, i) => `<g class="fv-node" data-i="${i}"><circle cx="${r1(x)}" cy="-3" r="6"/><text x="${r1(x)}" y="-0.6" font-size="6.5" text-anchor="middle">${i + 1}</text></g>
        ${names[i] ? `<text class="fv-ink fv-label" x="${r1(x)}" y="11" font-size="4.6" text-anchor="middle">${escape(names[i].slice(0, 9))}</text>` : ''}`).join('');
      return `<line class="fv-stroke thin faint" x1="${xs[0]}" x2="${xs[n - 1]}" y1="-3" y2="-3"/>${nodes}<circle class="fv-traveler" r="2.4" cx="${xs[0]}" cy="-3"/>`;
    },
    start(layer) {
      const nodes = [...layer.querySelectorAll('.fv-node')];
      const dot = layer.querySelector('.fv-traveler');
      const xs = nodes.map((g) => Number(g.querySelector('circle').getAttribute('cx')));
      if (reduced()) {
        nodes.forEach((g) => g.classList.add('is-on'));
        return null;
      }
      const seg = 900;
      const total = seg * (xs.length + 1);
      const t0 = performance.now();
      let raf = requestAnimationFrame(function step(now) {
        const t = (now - t0) % total;
        const k = Math.min(xs.length - 1, Math.floor(t / seg));
        const p = Math.min(1, (t % seg) / (seg * 0.6));
        const next = Math.min(xs.length - 1, k + 1);
        const eased = p * p * (3 - 2 * p);
        dot.setAttribute('cx', r1(xs[k] + (xs[next] - xs[k]) * (k === xs.length - 1 ? 0 : eased)));
        nodes.forEach((g, i) => g.classList.toggle('is-on', i <= k));
        raf = requestAnimationFrame(step);
      });
      return () => cancelAnimationFrame(raf);
    },
  },

  people: {
    label: (c) => `People ${c}`,
    draw(content) {
      const c = String(content || '').toLowerCase();
      if (/walk|move|go|travel|commut/.test(c)) {
        return `<g class="fv-walker">${stickman(0, { walk: true })}</g><line class="fv-stroke thin faint" x1="-30" x2="30" y1="17.5" y2="17.5"/>`;
      }
      if (/team|group|three|class|students|together/.test(c)) {
        return `${stickman(-17, { nod: true })}${stickman(0, { wave: true, delay: 200 })}${stickman(17, { nod: true, delay: 500 })}<line class="fv-stroke thin faint" x1="-28" x2="28" y1="17.5" y2="17.5"/>`;
      }
      return `${stickman(-12, { wave: true })}${stickman(13, { nod: true, delay: 300 })}
        <g class="fv-bubble"><rect x="4" y="-31" width="20" height="11" rx="5.5"/><circle cx="9" cy="-25.5" r="1.4" class="fv-dot"/><circle cx="14" cy="-25.5" r="1.4" class="fv-dot" style="animation-delay:.2s"/><circle cx="19" cy="-25.5" r="1.4" class="fv-dot" style="animation-delay:.4s"/></g>
        <line class="fv-stroke thin faint" x1="-28" x2="28" y1="17.5" y2="17.5"/>`;
    },
  },

  cycle: {
    label: (c) => `Cycle ${c}`,
    draw(content) {
      const stages = String(content || '').split(/[,;>→]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
      const n = Math.max(3, stages.length || 3);
      const nodes = Array.from({ length: n }, (_, i) => {
        const a = (-90 + (360 / n) * i) * (Math.PI / 180);
        const x = r1(Math.cos(a) * 19);
        const y = r1(Math.sin(a) * 19);
        const glyph = stages[i] ? escape(stages[i][0].toUpperCase()) : i + 1;
        return `<g class="fv-node pulse" style="animation-delay:${(i * 4) / n}s"><circle cx="${x}" cy="${y}" r="6"/><text x="${x}" y="${r1(y + 2.3)}" font-size="6.5" text-anchor="middle">${glyph}</text></g>`;
      }).join('');
      return `<circle class="fv-stroke thin faint" r="19" stroke-dasharray="2 3"/><g class="fv-orbit"><circle class="fv-traveler" cx="19" cy="0" r="2.6"/></g>${nodes}`;
    },
  },

  clock: {
    label: () => 'Time',
    draw() {
      const ticks = Array.from({ length: 12 }, (_, i) => `<line class="fv-stroke thin ${i % 3 ? 'faint' : ''}" x1="0" y1="-22" x2="0" y2="${i % 3 ? -19.5 : -18}" transform="rotate(${i * 30})"/>`).join('');
      return `<circle class="fv-stroke" r="25" stroke-width="2.2"/>${ticks}
        <g class="fv-hand hour"><line class="fv-stroke" x1="0" y1="2" x2="0" y2="-11" stroke-width="3"/></g>
        <g class="fv-hand minute"><line class="fv-accent-stroke" x1="0" y1="3" x2="0" y2="-18" stroke-width="2.2" stroke-linecap="round"/></g>
        <circle class="fv-ink" r="2.4"/>`;
    },
  },

  code: {
    label: () => 'Code',
    draw() {
      const lines = [[-13, -9, 24], [-9, -1, 18], [-9, 7, 13]];
      return `<text class="fv-accent fv-mono" x="-25" y="9" font-size="27">{</text><text class="fv-accent fv-mono" x="25" y="9" font-size="27" text-anchor="end">}</text>
        ${lines.map(([x, y, w], i) => `<rect class="fv-code-line" x="${x}" y="${y}" width="${w}" height="3.6" rx="1.8" style="animation-delay:${i * 450}ms"/>`).join('')}
        <rect class="fv-cursor" x="6" y="6.4" width="1.6" height="4.8"/>`;
    },
  },

  idea: {
    label: () => 'Idea',
    draw() {
      const rays = Array.from({ length: 8 }, (_, i) => `<line class="fv-accent-stroke fv-ray" x1="0" y1="-16" x2="0" y2="-21" stroke-width="2" stroke-linecap="round" transform="rotate(${i * 45 - 90} 0 -6)" style="animation-delay:${i * 90}ms"/>`).join('');
      return `<g class="fv-glow"><circle class="fv-accent" cx="0" cy="-6" r="11"/></g>
        <path class="fv-stroke thin" d="M-3 -4 L-1 -8 L1 -4 L3 -8" />
        <rect class="fv-ink" x="-5" y="6" width="10" height="3" rx="1.2"/><rect class="fv-ink" x="-4" y="10" width="8" height="2.6" rx="1.2"/>${rays}`;
    },
  },

  trend: {
    label: (c) => `Trend ${c || 'up'}`,
    draw(content) {
      const down = /down|decreas|declin|fall|drop|less/i.test(String(content || ''));
      const pts = down ? [[-20, -14], [-9, -8], [0, -10], [10, 2], [21, 12]] : [[-20, 12], [-9, 4], [0, 8], [10, -6], [21, -16]];
      const d = `M${pts.map((p) => p.join(' ')).join(' L')}`;
      const [ex, ey] = pts[pts.length - 1];
      return `<path class="fv-stroke thin faint" d="M-24 -20 V18 H25"/>
        <path class="fv-accent-stroke fv-draw loop" d="${d}" pathLength="1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <circle class="fv-accent fv-pop" cx="${ex}" cy="${ey}" r="3.2"/>`;
    },
  },
};

export const VISUAL_KINDS = Object.keys(VISUALS);

/** Build a visual: returns { markup, label, start(layer) -> stop } or null for unknown kinds. */
export function buildVisual(spec) {
  const visual = VISUALS[spec?.kind];
  if (!visual) return null;
  return {
    markup: visual.draw(spec.content || ''),
    label: visual.label(spec.content || ''),
    start: (layer) => visual.start?.(layer) || null,
  };
}

// ------------------------------------------------------------------ fallback detection

const RULES = [
  ['code', /```|\b(function|algorithm|recursion|array|variable|python|javascript|java|sql|pseudocode|source code)\b/i],
  ['sort', /\b(sort(ing)?|bubble ?sort|quick ?sort|merge ?sort)\b/i],
  ['formula', /\b(equation|formula|derivative|integral|theorem|pythagor|algebra|calculus|probability|variance|standard deviation)\b|[²³√∑∫π]|\b[a-z]\s?\^\s?\d/i],
  ['chart', /\b(compare|comparison|percentage|statistics|distribution|bar chart|versus|vs\.)\b|\d+\s?%/i],
  ['trend', /\b(growth|grows|increase|decrease|decline|trend|over time|inflation)\b/i],
  ['cycle', /\b(cycle|life ?cycle|iterat(e|ion|ive)|feedback loop|pdca|scrum|sprint)\b/i],
  ['steps', /\b(step[- ]by[- ]step|steps|process|procedure|workflow|pipeline|stages|phases)\b/i],
  ['people', /\b(teamwork|team|group work|negotiat\w*|communicat\w*|interview|stakeholders?|collaborat\w*|presentation)\b/i],
  ['clock', /\b(deadline|time management|timetable|schedule|semester dates)\b/i],
];

/**
 * Best-effort guess when the model did not send a cue: only for explanatory
 * questions with a substantial answer, and only for clear signals.
 */
export function inferVisual(prompt, answer = '') {
  if (!/\b(explain|how|why|what (is|are|does)|show|teach|walk me through|difference|calculate|solve|steps?|compare)\b/i.test(prompt)) return null;
  const hay = `${prompt}\n${answer.slice(0, 500)}`;
  for (const [kind, re] of RULES) {
    if (!re.test(hay)) continue;
    if (kind === 'formula') {
      const m = /([A-Za-z0-9()²³]+\s?[=]\s?[A-Za-z0-9()²³+\-*/^·\s]{1,22})/.exec(answer);
      return { kind, content: m ? m[1].trim() : '' };
    }
    if (kind === 'trend') return { kind, content: /decreas|declin|fall|drop/i.test(hay) ? 'down' : 'up' };
    return { kind, content: '' };
  }
  return null;
}
