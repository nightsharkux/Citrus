/**
 * LaTeX → MathML, so formulas look like they do in a textbook (stacked
 * fractions, real square-root signs, proper exponents) with no library and no
 * build step. Browsers draw MathML natively; css/components.css picks the font.
 *
 *   mathHtml('\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', { display: true })   → '<math display="block">…</math>'
 *   speakable('Solve $x^2 = 4$')                                          → 'Solve x squared equals 4'
 *
 * Covers what school and university courses use: fractions, roots, scripts,
 * Greek letters, relations and arrows, big operators with limits, matrices,
 * piecewise definitions, aligned equations, accents and delimiters that grow.
 * Anything it does not recognise is shown as written instead of breaking the
 * answer. Every piece of text is escaped, and only known tags are produced.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
};
const GREEK_UPPER = { Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };

/** Symbols drawn as operators or relations (the browser adds the right spacing). */
const OPERATORS = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺',
  mapsto: '↦', uparrow: '↑', downarrow: '↓', longrightarrow: '⟶', longleftarrow: '⟵', rightleftharpoons: '⇌', hookrightarrow: '↪',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', wedge: '∧', land: '∧', vee: '∨', lor: '∨',
  neg: '¬', lnot: '¬', forall: '∀', exists: '∃', nexists: '∄', perp: '⊥', parallel: '∥', mid: '∣', nmid: '∤', vdash: '⊢', models: '⊨', top: '⊤', bot: '⊥',
  therefore: '∴', because: '∵', angle: '∠', triangle: '△', square: '□', nabla: '∇', partial: '∂', prime: '′', colon: ':', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}', vert: '|', Vert: '‖', backslash: '\\', degree: '°', checkmark: '✓',
  lvert: '|', rvert: '|', lVert: '‖', rVert: '‖', dagger: '†', ddagger: '‡', S: '§', P: '¶',
};
/** Symbols drawn as identifiers or numbers. */
const IDENTIFIERS = { infty: '∞', emptyset: '∅', varnothing: '∅', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', imath: 'ı', jmath: 'ȷ' };
const LETTER_OPS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'det', 'gcd', 'arg', 'deg', 'dim', 'ker', 'hom', 'Pr', 'mod', 'sgn']);
const LIMIT_OPS = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'argmax', 'argmin']);
const BIG = { sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀' };
const INTEGRALS = { int: '∫', iint: '∬', iiint: '∭', oint: '∮' };
const ACCENTS = { hat: '^', widehat: '^', bar: '¯', overline: '‾', vec: '→', overrightarrow: '→', dot: '˙', ddot: '¨', tilde: '˜', widetilde: '˜', check: 'ˇ', breve: '˘', acute: '´', grave: '`' };
const TEXT_RAW = new Set(['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mbox', 'hbox']);
const TEXT_MATH = { mathrm: 'm-rm', mathsf: 'm-rm', mathtt: 'm-rm', mathbf: 'm-bf', boldsymbol: 'm-bf', bm: 'm-bf', mathit: 'm-it', mathnormal: 'm-it', mathcal: 'm-cal', mathscr: 'm-cal', mathfrak: 'm-rm' };
const SPACES = { ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', ' ': '0.28em', quad: '1em', qquad: '2em', enspace: '0.5em', thinspace: '0.17em', medspace: '0.22em', thickspace: '0.28em', negthinspace: '-0.17em' };
const IGNORE = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits', 'nonumber', 'notag', 'hline', 'toprule', 'midrule', 'bottomrule', 'strut', 'relax', 'allowbreak', 'centering', 'protect']);
const SKIP_ARG = new Set(['label', 'tag', 'ref', 'eqref', 'vphantom', 'hspace', 'vspace', 'rule', 'color']);
const SIZES = new Set(['big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'bigm', 'Bigm', 'middle']);
const MATRICES = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], smallmatrix: ['', ''] };
const ALIGNED = new Set(['aligned', 'align', 'align*', 'alignedat', 'split', 'gather', 'gather*', 'gathered', 'eqnarray', 'eqnarray*', 'multline', 'equation', 'equation*', 'flalign']);
const DOUBLE_STRUCK = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };

// Plain lookups: `\constructor` or `\toString` must be "unknown", never an inherited function.
for (const table of [GREEK, GREEK_UPPER, OPERATORS, IDENTIFIERS, BIG, INTEGRALS, ACCENTS, TEXT_MATH, SPACES, MATRICES, DOUBLE_STRUCK]) Object.setPrototypeOf(table, null);

const mo = (c, attrs = '') => `<mo${attrs}>${esc(c)}</mo>`;
const row = (all) => {
  const parts = all.filter(Boolean);
  return parts.length === 1 ? parts[0] : `<mrow>${parts.join('')}</mrow>`;
};
const FENCE = ' fence="true" stretchy="true"';
const SOFT = ' stretchy="false"';

// ---------------------------------------------------------------- tokens

const TOKEN = /\\([A-Za-z]+)|\\([^A-Za-z])|(\d+(?:\.\d+)?)|([A-Za-z])|(\s+)|([\s\S])/gy;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    const start = m.index;
    const end = TOKEN.lastIndex;
    if (m[1] !== undefined) out.push({ k: 'cmd', v: m[1], s: start, e: end });
    else if (m[2] !== undefined) out.push({ k: 'cmd', v: m[2], s: start, e: end });
    else if (m[3] !== undefined) out.push({ k: 'num', v: m[3], s: start, e: end });
    else if (m[4] !== undefined) out.push({ k: 'let', v: m[4], s: start, e: end });
    else if (m[5] === undefined) out.push({ k: 'ch', v: m[6], s: start, e: end });
    // whitespace is dropped: spacing in TeX math is decided by the operators, not the source
  }
  return out;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(src, display) {
    this.src = src;
    this.t = tokenize(src);
    this.i = 0;
    this.display = display;
    this.depth = 0;
  }

  peek() {
    return this.t[this.i];
  }

  next() {
    return this.t[this.i++];
  }

  isCh(tok, c) {
    return tok && tok.k === 'ch' && tok.v === c;
  }

  isCmd(tok, name) {
    return tok && tok.k === 'cmd' && tok.v === name;
  }

  guard() {
    if (++this.depth > 48) throw new Error('too deeply nested');
  }

  /** Nodes until `stop(token)` is true (the stop token is left for the caller). */
  seq(stop) {
    this.guard();
    const nodes = [];
    for (let tok = this.peek(); tok && !stop(tok); tok = this.peek()) nodes.push(this.scripted());
    this.depth -= 1;
    return nodes;
  }

  /** `{ ... }` or a single token, as one node. */
  arg() {
    const tok = this.peek();
    if (!tok) return '<mrow></mrow>';
    if (this.isCh(tok, '{')) {
      this.next();
      const inner = this.seq((x) => this.isCh(x, '}'));
      if (this.isCh(this.peek(), '}')) this.next();
      return row(inner);
    }
    if (tok.k === 'num' && tok.v.length > 1) {
      // Like TeX: x^23 and \frac12 take one digit per argument.
      this.t[this.i] = { ...tok, v: tok.v.slice(1), s: tok.s + 1 };
      return `<mn>${esc(tok.v[0])}</mn>`;
    }
    return this.atom().h || '<mrow></mrow>';
  }

  scripted() {
    const base = this.atom();
    let sub = null;
    let sup = null;
    let primes = '';
    for (let tok = this.peek(); tok; tok = this.peek()) {
      if (this.isCh(tok, '^')) {
        this.next();
        sup = this.arg();
      } else if (this.isCh(tok, '_')) {
        this.next();
        sub = this.arg();
      } else if (this.isCh(tok, "'")) {
        this.next();
        primes += '′';
      } else break;
    }
    if (primes) sup = sup ? `<mrow><mo>${primes}</mo>${sup}</mrow>` : `<mo>${primes}</mo>`;
    let h = base.h;
    if (sub !== null || sup !== null) {
      const over = base.limits && this.display;
      if (sub !== null && sup !== null) h = over ? `<munderover>${h}${sub}${sup}</munderover>` : `<msubsup>${h}${sub}${sup}</msubsup>`;
      else if (sub !== null) h = over ? `<munder>${h}${sub}</munder>` : `<msub>${h}${sub}</msub>`;
      else h = over ? `<mover>${h}${sup}</mover>` : `<msup>${h}${sup}</msup>`;
    }
    return base.fn ? `${h}<mo>&#x2061;</mo>` : h;
  }

  /** Read raw text inside braces (for \text{...}). */
  rawGroup() {
    const open = this.peek();
    if (!this.isCh(open, '{')) {
      const t = this.next();
      return t ? this.src.slice(t.s, t.e) : '';
    }
    let depth = 0;
    let end = this.src.length;
    let inner = this.src.length;
    for (let p = open.s; p < this.src.length; p += 1) {
      const c = this.src[p];
      if (c === '\\') p += 1;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          inner = p;
          end = p + 1;
          break;
        }
      }
    }
    const text = this.src.slice(open.e, inner);
    while (this.peek() && this.peek().s < end) this.i += 1;
    return text;
  }

  delimiter() {
    const tok = this.next();
    if (!tok) return '';
    if (tok.k === 'ch') return tok.v === '.' ? '' : tok.v;
    if (tok.k === 'cmd') {
      if (tok.v === '{' || tok.v === '}') return tok.v;
      if (tok.v === '|') return '‖';
      if (OPERATORS[tok.v] !== undefined) return OPERATORS[tok.v];
    }
    return '';
  }

  atom() {
    const tok = this.next();
    if (!tok) return { h: '<mrow></mrow>' };
    switch (tok.k) {
      case 'num': return { h: `<mn>${esc(tok.v)}</mn>` };
      case 'let': return { h: `<mi>${esc(tok.v)}</mi>` };
      case 'ch': return this.character(tok);
      default: return this.command(tok);
    }
  }

  character(tok) {
    const c = tok.v;
    switch (c) {
      case '{': {
        const inner = this.seq((x) => this.isCh(x, '}'));
        if (this.isCh(this.peek(), '}')) this.next();
        return { h: row(inner) };
      }
      case '^': case '_':
        this.i -= 1; // a script with nothing before it: leave it for scripted()
        return { h: '<mrow></mrow>' };
      case '-': return { h: mo('−') };
      case '*': return { h: mo('∗') };
      case '~': return { h: '<mspace width="0.33em"></mspace>' };
      case '(': case ')': case '[': case ']': case '|': case '/': return { h: mo(c, SOFT) };
      case '&': return { h: '' };
      case '%': return { h: mo('%') };
      default:
        return { h: /\p{L}/u.test(c) ? `<mi>${esc(c)}</mi>` : /\p{N}/u.test(c) ? `<mn>${esc(c)}</mn>` : mo(c) };
    }
  }

  command(tok) {
    const n = tok.v;
    if (GREEK[n]) return { h: `<mi>${GREEK[n]}</mi>` };
    if (GREEK_UPPER[n]) return { h: `<mi mathvariant="normal">${GREEK_UPPER[n]}</mi>` };
    if (OPERATORS[n] !== undefined) return { h: mo(OPERATORS[n], n === 'langle' || n === 'rangle' || n === 'lfloor' || n === 'rfloor' || n === 'lceil' || n === 'rceil' ? SOFT : '') };
    if (IDENTIFIERS[n]) return { h: `<mi mathvariant="normal">${IDENTIFIERS[n]}</mi>` };
    if (BIG[n]) return { h: mo(BIG[n]), limits: true };
    if (INTEGRALS[n]) return { h: mo(INTEGRALS[n]) };
    if (LETTER_OPS.has(n)) return { h: `<mi>${n}</mi>`, fn: true };
    if (LIMIT_OPS.has(n)) return { h: `<mi>${n}</mi>`, limits: true, fn: true };
    if (SPACES[n] !== undefined) return { h: `<mspace width="${SPACES[n]}"></mspace>` };
    if (IGNORE.has(n)) return { h: '' };
    if (SKIP_ARG.has(n)) {
      this.rawGroup();
      if (n === 'color') this.rawGroup();
      return { h: '' };
    }
    if (SIZES.has(n)) {
      const d = this.delimiter();
      return { h: d ? mo(d, FENCE) : '' };
    }
    if (ACCENTS[n]) {
      const body = this.arg();
      const sym = ACCENTS[n];
      return { h: `<mover accent="true">${body}${mo(sym, ' stretchy="true"')}</mover>` };
    }
    if (TEXT_RAW.has(n)) return { h: `<mtext>${esc(this.rawGroup())}</mtext>` };
    if (TEXT_MATH[n]) return { h: `<mrow class="${TEXT_MATH[n]}">${this.arg()}</mrow>` };
    if (n === 'mathbb') {
      const letters = this.rawGroup();
      const out = [...letters].map((c) => (DOUBLE_STRUCK[c] ? `<mi mathvariant="normal">${DOUBLE_STRUCK[c]}</mi>` : `<mi>${esc(c)}</mi>`));
      return { h: row(out) };
    }
    if (n === 'operatorname') {
      if (this.isCh(this.peek(), '*')) this.next();
      return { h: `<mi>${esc(this.rawGroup().trim())}</mi>`, fn: true };
    }

    switch (n) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const a = this.arg();
        const b = this.arg();
        const f = `<mfrac>${a}${b}</mfrac>`;
        if (n === 'dfrac' || n === 'cfrac') return { h: `<mstyle displaystyle="true">${f}</mstyle>` };
        if (n === 'tfrac') return { h: `<mstyle displaystyle="false">${f}</mstyle>` };
        return { h: f };
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const a = this.arg();
        const b = this.arg();
        return { h: `<mrow>${mo('(', FENCE)}<mfrac linethickness="0">${a}${b}</mfrac>${mo(')', FENCE)}</mrow>` };
      }
      case 'sqrt': {
        let index = null;
        if (this.isCh(this.peek(), '[')) {
          this.next();
          const inner = this.seq((x) => this.isCh(x, ']'));
          if (this.isCh(this.peek(), ']')) this.next();
          index = row(inner);
        }
        const body = this.arg();
        return { h: index ? `<mroot>${body}${index}</mroot>` : `<msqrt>${body}</msqrt>` };
      }
      case 'underline': return { h: `<munder>${this.arg()}${mo('_', ' accent="true"')}</munder>` };
      case 'overset': case 'stackrel': { const over = this.arg(); return { h: `<mover>${this.arg()}${over}</mover>` }; }
      case 'underset': { const under = this.arg(); return { h: `<munder>${this.arg()}${under}</munder>` }; }
      case 'overbrace': return { h: `<mover>${this.arg()}${mo('⏞')}</mover>` };
      case 'underbrace': return { h: `<munder>${this.arg()}${mo('⏟')}</munder>` };
      case 'boxed': case 'fbox': return { h: `<mrow class="m-boxed">${this.arg()}</mrow>` };
      case 'cancel': case 'bcancel': case 'xcancel': return { h: `<mrow class="m-cancel">${this.arg()}</mrow>` };
      case 'phantom': case 'hphantom': return { h: `<mphantom>${this.arg()}</mphantom>` };
      case 'textcolor': case 'colorbox': this.rawGroup(); return { h: this.arg() };
      case 'not': {
        const nx = this.peek();
        if (nx && ((nx.k === 'ch' && nx.v === '=') || (nx.k === 'cmd' && (nx.v === 'in' || nx.v === 'equiv')))) {
          this.next();
          return { h: mo(nx.v === '=' ? '≠' : nx.v === 'in' ? '∉' : '≢') };
        }
        return { h: '' };
      }
      case 'pmod': return { h: `<mrow>${mo('(', SOFT)}<mi>mod</mi><mspace width="0.28em"></mspace>${this.arg()}${mo(')', SOFT)}</mrow>` };
      case 'bmod': return { h: '<mi>mod</mi>' };
      case 'left': return { h: this.fenced() };
      case 'right': return { h: '' };
      case 'begin': return { h: this.environment() };
      case 'end': this.rawGroup(); return { h: '' };
      case '\\': case 'cr': return { h: '' };
      case '{': return { h: mo('{', SOFT) };
      case '}': return { h: mo('}', SOFT) };
      case '|': return { h: mo('‖', SOFT) };
      case '%': case '$': case '&': case '#': case '_': return { h: mo(n) };
      case ',': case ';': case ':': case '!': case ' ': return { h: '' };
      default:
        // Unknown command: show it as written, so the reader still sees what was meant.
        return { h: `<mtext class="m-unknown">${esc(`\\${n}`)}</mtext>` };
    }
  }

  /** \left( … \right) */
  fenced() {
    const open = this.delimiter();
    const inner = this.seq((x) => this.isCmd(x, 'right'));
    let close = '';
    if (this.isCmd(this.peek(), 'right')) {
      this.next();
      close = this.delimiter();
    }
    return `<mrow>${open ? mo(open, `${FENCE} form="prefix"`) : ''}${row(inner)}${close ? mo(close, `${FENCE} form="postfix"`) : ''}</mrow>`;
  }

  /** \begin{env} … \end{env} */
  environment() {
    const name = this.rawGroup().trim();
    if (name === 'array') {
      if (this.isCh(this.peek(), '{')) this.rawGroup(); // column spec
    }
    const rows = [[]];
    let cell = [];
    const endCell = () => {
      rows[rows.length - 1].push(cell);
      cell = [];
    };
    const isEnd = (x) => this.isCmd(x, 'end');
    for (let tok = this.peek(); tok && !isEnd(tok); tok = this.peek()) {
      if (this.isCh(tok, '&')) {
        this.next();
        endCell();
      } else if (this.isCmd(tok, '\\') || this.isCmd(tok, 'cr')) {
        this.next();
        if (this.isCh(this.peek(), '[')) this.rawBracket();
        endCell();
        rows.push([]);
      } else {
        this.guard();
        cell.push(this.scripted());
        this.depth -= 1;
      }
    }
    if (isEnd(this.peek())) {
      this.next();
      this.rawGroup();
    }
    endCell();
    const filled = rows.filter((r) => r.some((c) => c.length));
    const cls = ALIGNED.has(name) ? 'm-aligned' : name === 'cases' || name === 'dcases' ? 'm-cases' : 'm-matrix';
    const table = `<mtable class="${cls}">${filled.map((r) => `<mtr>${r.map((c) => `<mtd>${c.length ? row(c) : ''}</mtd>`).join('')}</mtr>`).join('')}</mtable>`;
    if (name === 'cases' || name === 'dcases') return `<mrow>${mo('{', FENCE)}${table}</mrow>`;
    if (MATRICES[name]) {
      const [l, r] = MATRICES[name];
      return l ? `<mrow>${mo(l, FENCE)}${table}${mo(r, FENCE)}</mrow>` : table;
    }
    return table;
  }

  rawBracket() {
    while (this.peek() && !this.isCh(this.peek(), ']')) this.next();
    this.next();
  }
}

// ---------------------------------------------------------------- public API

const cache = new Map();
const CACHE_MAX = 600;

/** LaTeX → `<math>…</math>`. Never throws; unreadable input comes back as plain code. */
export function mathHtml(latex, { display = false } = {}) {
  const src = String(latex ?? '').trim();
  const key = `${display ? 'b' : 'i'}${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let html;
  try {
    const parser = new Parser(src, display);
    const nodes = [];
    while (parser.peek()) {
      const before = parser.i;
      nodes.push(parser.scripted());
      if (parser.i === before) parser.i += 1; // never loop on a stray token
    }
    html = `<math${display ? ' display="block"' : ''}>${row(nodes.length ? nodes : [''])}</math>`;
  } catch {
    html = `<code class="math-error">${esc(src)}</code>`;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}

// ---------------------------------------------------------------- read aloud

const WORDS = {
  pm: 'plus or minus', mp: 'minus or plus', times: 'times', cdot: 'times', div: 'divided by', leq: 'is less than or equal to', le: 'is less than or equal to', geq: 'is greater than or equal to', ge: 'is greater than or equal to',
  neq: 'is not equal to', ne: 'is not equal to', approx: 'is approximately', equiv: 'is equivalent to', infty: 'infinity', to: 'goes to', rightarrow: 'goes to', Rightarrow: 'implies', implies: 'implies', iff: 'if and only if',
  in: 'in', notin: 'not in', subset: 'subset of', cup: 'union', cap: 'intersection', forall: 'for all', exists: 'there exists', sum: 'the sum of', prod: 'the product of', int: 'the integral of', partial: 'partial', nabla: 'nabla',
  ldots: 'and so on', cdots: 'and so on', degree: 'degrees', circ: 'degrees', lim: 'the limit', sin: 'sine of', cos: 'cosine of', tan: 'tangent of', log: 'log', ln: 'natural log of', angle: 'angle', triangle: 'triangle', therefore: 'therefore',
};
Object.setPrototypeOf(WORDS, null);

/** Spoken form of a LaTeX expression ("x squared plus 3"). Rough but listenable. */
function spokenMath(latex) {
  let s = ` ${latex} `;
  const group = '\\{([^{}]*)\\}';
  for (let pass = 0; pass < 6; pass += 1) {
    s = s
      .replace(new RegExp(`\\\\d?frac${group}${group}`, 'g'), ' $1 over $2 ')
      .replace(new RegExp(`\\\\sqrt\\[([^\\]]*)\\]${group}`, 'g'), ' the $1 th root of $2 ')
      .replace(new RegExp(`\\\\sqrt${group}`, 'g'), ' the square root of $1 ')
      .replace(new RegExp(`\\\\(?:text|mathrm|operatorname|mathbf|mbox)${group}`, 'g'), ' $1 ')
      .replace(new RegExp(`\\^${group}`, 'g'), (m, e) => (e === '2' ? ' squared ' : e === '3' ? ' cubed ' : ` to the power ${e} `))
      .replace(new RegExp(`_${group}`, 'g'), ' sub $1 ');
  }
  s = s
    .replace(/\^2\b/g, ' squared ').replace(/\^3\b/g, ' cubed ').replace(/\^(\w)/g, ' to the power $1 ').replace(/_(\w)/g, ' sub $1 ')
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, ' ')
    .replace(/\\([A-Za-z]+)/g, (m, name) => (WORDS[name] ? ` ${WORDS[name]} ` : GREEK[name] || GREEK_UPPER[name] ? ` ${name} ` : ' '))
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/=/g, ' equals ').replace(/\+/g, ' plus ').replace(/(\s)-(?=\s*[\w(])/g, '$1 minus ').replace(/</g, ' is less than ').replace(/>/g, ' is greater than ')
    .replace(/[{}$&]/g, ' ').replace(/\\/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Markdown + LaTeX → plain words for text-to-speech. */
export function speakable(markdownText) {
  return String(markdownText || '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, x) => ` ${spokenMath(x)}. `)
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, x) => ` ${spokenMath(x)}. `)
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, x) => ` ${spokenMath(x)} `)
    .replace(/\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g, (m, x) => ` ${spokenMath(x)} `)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/\[(\d{1,2})\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
