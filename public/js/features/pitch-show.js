/**
 * Citrus explains Citrus (see pitch.js): a full-screen card with Citrus's face, excited, the three core
 * features lighting up as each is explained, and subtitles. Spoken with the natural voice when there is one, the
 * browser's voice otherwise; with no voice at all the subtitles still move on by themselves. Esc, the close button
 * or "Citrus, stop" ends it.
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { wordmark } from '../core/brand.js';
import { session } from '../core/store.js';
import { createFace } from './face.js';
import { speak, stopSpeaking } from './speaker.js';
import { PITCH, PITCH_CARDS } from './pitch.js';

let open = null;

export function showPitch() {
  if (open) return open;
  const lang = session.user?.preferences?.language === 'de' ? 'de' : 'en';
  const parts = PITCH[lang];
  const cards = PITCH_CARDS[lang];
  const el = document.createElement('div');
  el.className = 'pitch';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'What Citrus is');
  render(el, html`<button class="pitch-close" data-close aria-label="Close">${icon('x', 22)}</button>
    <div class="pitch-inner">
      <div class="pitch-face" data-face></div>
      <h1 class="pitch-title">${wordmark()}</h1>
      <p class="pitch-lead">${lang === 'de' ? 'Der Assistent für den Hörsaal' : 'The classroom assistant'}</p>
      <div class="pitch-cards">${cards.map(([id, glyph, title, body]) => html`<div class="pitch-card" data-card="${id}"><span class="tile accent">${icon(glyph, 22)}</span><strong>${title}</strong><span class="small muted">${body}</span></div>`)}</div>
      <div class="pitch-side" data-card="ask">${icon('campus', 16)} ${lang === 'de' ? 'Nebenbei: einfach Citrus fragen, statt Dokumente zu durchsuchen' : 'On the side: just ask Citrus instead of searching documents'}</div>
      <p class="pitch-subtitle" data-subtitle aria-live="polite"></p>
    </div>`);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  const face = createFace({ size: 150, mood: 'excited', followPointer: false });
  el.querySelector('[data-face]').append(face.el);

  let step = -1;
  let timer = 0;
  let speaker = null;
  let closed = false;

  function next() {
    clearTimeout(timer);
    if (closed) return;
    step += 1;
    if (step >= parts.length) {
      face.setMood('happy');
      timer = setTimeout(close, 6000);
      return;
    }
    const part = parts[step];
    el.querySelectorAll('[data-card]').forEach((c) => c.classList.toggle('is-on', c.dataset.card === part.card));
    el.querySelector('[data-subtitle]').textContent = part.text;
    face.setMood(part.mood === 'speaking' ? 'speaking' : part.mood);
    if (part.mood === 'speaking') face.react('excited', 1300);
    // Move on when the voice finishes, or after a reading-speed estimate if there is no voice.
    const estimate = 1800 + part.text.split(/\s+/).length * 400;
    let done = false;
    const advance = () => {
      if (done) return;
      done = true;
      timer = setTimeout(next, 450);
    };
    timer = setTimeout(advance, estimate + 4000);
    try {
      speaker = speak(part.text, { onEnd: advance });
    } catch {
      clearTimeout(timer);
      timer = setTimeout(advance, estimate);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    stopSpeaking();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('campus:stop', close);
    el.classList.remove('is-in');
    setTimeout(() => {
      face.destroy();
      el.remove();
    }, 350);
    open = null;
  }
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  document.addEventListener('campus:stop', close);
  el.addEventListener('click', (e) => e.target.closest('[data-close]') && close());

  face.setMood('excited');
  timer = setTimeout(next, 700); // a beat of excitement before the first words
  open = { close, get speaker() { return speaker; } };
  return open;
}
