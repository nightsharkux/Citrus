/**
 * Study sign (/sign): a screen that tells people nearby not to disturb you while you study.
 *
 * Up front there is only what most people want: one of four styles (black with white text, black with red text, red, or
 * flashing red), English, German or both, an optional message of their own, and "Show the sign". Everything else
 * (text size, a symbol, a small line, the colours, how fast it pulses, and a sign designed by Citrus from a description)
 * sits under "More options". The sign opens full screen at /sign?show=1: tap it for the Exit button, or use Esc or the
 * back button. The choices are kept on this device.
 */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { getLanguage } from '../core/i18n.js';
import { pageHead } from '../core/components.js';
import { toast, toastError, busy } from '../core/ui.js';
import { PRESETS, SIZES, SYMBOLS, SPEEDS, LIMITS, DEFAULT_MESSAGE, BACK_IN, backAtLine, normalizeSpec, withPreset, messageLines, decodeSpec } from '../features/sign-model.js';
import { signView, openSign } from '../features/sign.js';

const KEY = 'citrus.sign';
const LANGUAGES = [['en', 'English'], ['de', 'Deutsch'], ['both', 'English and German']];
const SPEED_NAMES = { slow: 'Slow', normal: 'Medium', fast: 'Quicker' };
const SYMBOL_NAMES = { none: 'None', moon: 'Moon', book: 'Book', lock: 'Lock', 'mic-off': 'Quiet', clock: 'Clock' };
const defaultLanguage = () => (getLanguage() === 'de' ? 'de' : 'en');

function loadSpec() {
  try {
    return normalizeSpec(JSON.parse(localStorage.getItem(KEY) || '{}'), { language: defaultLanguage() });
  } catch {
    return normalizeSpec({}, { language: defaultLanguage() });
  }
}
function saveSpec(spec) {
  try {
    localStorage.setItem(KEY, JSON.stringify(spec));
  } catch {
    /* blocked storage: the sign still works for this visit */
  }
}

/** Which ready-made style the sign currently is, or '' once colours or flashing were changed by hand. */
const activePreset = (s) => PRESETS.find((p) => p.spec.style === s.style && p.spec.background === s.background && p.spec.color === s.color)?.id || '';

// One card of the catalogue: a small copy of the sign in that look (drawn in refresh()), and its name.
const card = (p) => html`<button type="button" class="sign-card" data-preset="${p.id}" aria-pressed="false">
  <span class="sign-card-face" data-card="${p.id}" aria-hidden="true"></span><span class="sign-card-name">${p.name}</span></button>`;

const BACK_NAMES = { 15: '15 min', 30: '30 min', 60: '1 hour', 120: '2 hours' };

/** The sign's shape on this screen: tall on a phone held upright, wide on a laptop or a phone on its side. */
const screenRatio = () => Math.min(1.8, Math.max(0.45, innerWidth / Math.max(1, innerHeight)));

const choices = (name, entries, label = (v) => v) => entries.map((value) => html`<button type="button" class="chip-button" data-choice="${name}" data-value="${value}" aria-pressed="false">${label(value)}</button>`);

// Where the sign was opened from: Exit goes back one step if the Show button put the sign on the history, else replaces it.
let openedHere = false;

export default {
  title: 'Study sign',
  render() {
    const aiOn = !!session.ai?.aiEnabled;
    return html`${pageHead({ title: 'Study sign', subtitle: 'Show a screen that asks people nearby not to disturb you.' })}
      <section class="card stack sign-setup">
        <div class="sign-stage" data-stage role="button" tabindex="0" aria-label="Show the sign">
          <div data-preview></div>
          <span class="sign-stage-hint">${icon('maximize', 14)} Tap the preview to see it full screen</span>
        </div>

        <div class="field"><span>Pick a look</span>
          <div class="sign-catalogue" data-catalogue role="group" aria-label="Pick a look">${PRESETS.map(card)}</div></div>

        <div class="field"><span>Language</span>
          <div class="sign-seg" role="group" aria-label="Language">${LANGUAGES.map(([v, name]) => html`<button type="button" class="chip-button" data-choice="language" data-value="${v}" aria-pressed="false">${name}</button>`)}</div></div>

        <label class="field"><span>Message</span><input class="input" data-message maxlength="${LIMITS.message}" placeholder="${DEFAULT_MESSAGE.en}" autocomplete="off">
          <span class="hint">Leave it empty for the standard message in the language above.</span></label>

        <div class="field"><span>Back in</span>
          <div class="sign-seg" role="group" aria-label="Back in">
            ${BACK_IN.map((m) => html`<button type="button" class="chip-button" data-back="${m}">${BACK_NAMES[m]}</button>`)}
            <button type="button" class="chip-button" data-back="0">No time</button>
          </div>
          <span class="hint">Adds a small line like “Back at 15:30”.</span></div>

        <button class="btn btn-primary btn-lg" data-show>${icon('maximize', 18)} Show the sign</button>

        <details class="sign-more">
          <summary>More options</summary>
          <div class="stack sign-more-body">
            <div class="field"><span>Text size</span><div class="sign-seg">${choices('size', Object.keys(SIZES), (v) => SIZES[v])}</div></div>
            <div class="field"><span>Symbol</span><div class="sign-seg">${choices('symbol', SYMBOLS, (v) => SYMBOL_NAMES[v])}</div></div>
            <label class="field"><span>Small line (optional)</span><input class="input" data-sub maxlength="${LIMITS.sub}" placeholder="Back at 15:30" autocomplete="off"></label>
            <div class="input-row">
              <label class="field"><span>Background</span><input class="input sign-color" type="color" data-color="background" aria-label="Background colour"></label>
              <label class="field"><span>Text</span><input class="input sign-color" type="color" data-color="color" aria-label="Text colour"></label>
            </div>
            <div class="field" data-speed-field><span>Flash speed</span><div class="sign-seg">${choices('speed', Object.keys(SPEEDS), (v) => SPEED_NAMES[v])}</div>
              <span class="hint">It pulses slowly, never faster than once a second. With “reduce motion” on, it stays solid.</span></div>

            <div class="field sign-design"><span>Design with Citrus</span>
              <div class="input-row"><input class="input" data-design-text maxlength="300" placeholder="A calm blue sign for the library, in German" ${aiOn ? '' : 'disabled'} autocomplete="off">
                <button type="button" class="btn" data-design ${aiOn ? '' : 'disabled'}>${icon('sparkle', 16)} Design</button></div>
              <span class="hint">${aiOn ? 'Describe the look and the message. You can still change everything above.' : 'Needs the assistant to be connected.'}</span></div>
          </div>
        </details>
      </section>`;
  },

  mount(root, data, ctx) {
    let spec = loadSpec();
    // A sign the assistant made ("show a red sign that says shh") arrives in the link; it is kept like one made by hand.
    const shared = ctx.query.get('spec') ? decodeSpec(ctx.query.get('spec'), { language: defaultLanguage() }) : null;
    if (shared) {
      spec = shared;
      saveSpec(spec);
    }

    // ---- the sign itself, full screen
    let sign = null;
    if (ctx.query.get('show')) {
      const startedHere = openedHere;
      openedHere = false;
      sign = openSign(spec, { onExit: () => (startedHere ? history.back() : ctx.navigate('/sign', { replace: true })) });
    }

    // ---- the controls
    const preview = $('[data-preview]', root);
    const stage = $('[data-stage]', root);
    // Every preview has the shape of this screen, so what you see here is what the full screen will look like.
    root.style.setProperty('--sign-ratio', String(screenRatio()));
    stage.classList.toggle('is-tall', screenRatio() < 1);
    const refresh = () => {
      preview.replaceChildren(signView(spec, 'sign-preview'));
      const preset = activePreset(spec);
      // The catalogue: each look drawn as a small sign with your own message, language and symbol.
      root.querySelectorAll('[data-card]').forEach((slot) => {
        const p = PRESETS.find((x) => x.id === slot.dataset.card);
        slot.replaceChildren(signView(withPreset(spec, p.id, { language: defaultLanguage() }), 'sign-preview sign-card-sign'));
      });
      root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
      root.querySelectorAll('[data-choice]').forEach((b) => b.setAttribute('aria-pressed', String(spec[b.dataset.choice] === b.dataset.value)));
      const input = $('[data-message]', root);
      if (document.activeElement !== input) input.value = spec.message;
      input.placeholder = messageLines({ ...spec, message: '' }).join(' / ');
      const sub = $('[data-sub]', root);
      if (document.activeElement !== sub) sub.value = spec.sub;
      $('[data-color="background"]', root).value = spec.background;
      $('[data-color="color"]', root).value = spec.color;
      $('[data-speed-field]', root).hidden = spec.style !== 'flash';
    };
    const change = (next) => {
      spec = normalizeSpec({ ...spec, ...next }, { language: defaultLanguage() });
      saveSpec(spec);
      refresh();
    };
    refresh();

    const offs = [
      on(root, 'click', '[data-preset]', (e, b) => {
        spec = withPreset(spec, b.dataset.preset, { language: defaultLanguage() });
        saveSpec(spec);
        refresh();
        // A little feedback: the big preview pops, the card slides to the middle, and a phone buzzes once.
        stage.classList.remove('pop');
        void stage.offsetWidth;
        stage.classList.add('pop');
        root.querySelector(`[data-preset="${b.dataset.preset}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        try {
          navigator.vibrate?.(8);
        } catch {
          /* not every browser can */
        }
      }),
      on(root, 'click', '[data-back]', (e, b) => {
        const minutes = Number(b.dataset.back);
        change({ sub: minutes ? backAtLine(spec.language, minutes) : '' });
      }),
      on(root, 'click', '[data-stage]', () => $('[data-show]', root).click()),
      on(root, 'keydown', '[data-stage]', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          $('[data-show]', root).click();
        }
      }),
      on(root, 'click', '[data-choice]', (e, b) => change({ [b.dataset.choice]: b.dataset.value })),
      on(root, 'input', '[data-message]', (e, input) => change({ message: input.value })),
      on(root, 'input', '[data-sub]', (e, input) => change({ sub: input.value })),
      on(root, 'input', '[data-color]', (e, input) => change({ [input.dataset.color]: input.value })),
      on(root, 'click', '[data-show]', () => {
        saveSpec(spec);
        openedHere = true;
        ctx.navigate('/sign?show=1');
      }),
      on(root, 'click', '[data-design]', (e, button) => busy(button, async () => {
        const text = $('[data-design-text]', root).value.trim();
        if (text.length < 3) return toast('Describe the sign you want.', 'info');
        try {
          const r = await api.post('/sign/design', { prompt: text });
          spec = normalizeSpec(r.design, { language: defaultLanguage() });
          saveSpec(spec);
          refresh();
          toast('Designed. Change anything you like, then show it.', 'success', { duration: 2400 });
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'keydown', '[data-design-text]', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('[data-design]', root).click();
        }
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      sign?.close({ silent: true }); // leaving the page (the back button) takes the sign down
    };
  },
};
