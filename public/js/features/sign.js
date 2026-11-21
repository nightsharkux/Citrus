/**
 * The study sign on screen.
 *
 *   signView(spec, 'sign')                 the sign as an element: full-screen overlay (class "sign") or a small preview
 *   openSign(spec, { onExit })             shows it full screen: tap the screen for the Exit button, Esc also leaves
 *   const s = openSign(…); s.close()       leaves without calling onExit (the page went away)
 *
 * A spec is checked (sign-model.js) before it gets here, so the colours are always valid hex and readable; they are set as
 * CSS variables, never as markup. The screen is kept awake while the sign is up.
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { keepAwake } from './keep-awake.js';
import { native, inApp } from './native.js';
import { messageLines, pulseSeconds, dimmed } from './sign-model.js';

/** The sign as an element. `className` is "sign" for the overlay, or "sign sign-preview" for a small one. */
export function signView(spec, className = 'sign-view') {
  const el = document.createElement('div');
  el.className = `sign-view ${className} size-${spec.size} ${spec.style === 'flash' ? 'is-flash' : ''}`;
  el.style.setProperty('--sign-bg', spec.background);
  el.style.setProperty('--sign-fg', spec.color);
  el.style.setProperty('--sign-dim', dimmed(spec.background));
  el.style.setProperty('--sign-pulse', `${pulseSeconds(spec)}s`);
  render(el, html`<div class="sign-face">
    ${spec.symbol !== 'none' ? html`<span class="sign-symbol" aria-hidden="true">${icon(spec.symbol, 64)}</span>` : ''}
    ${messageLines(spec).map((line) => html`<p class="sign-text">${line}</p>`)}
    ${spec.sub ? html`<p class="sign-sub">${spec.sub}</p>` : ''}
  </div>`);
  return el;
}

export function openSign(spec, { onExit } = {}) {
  const overlay = signView(spec, 'sign');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Study sign');
  const exit = Object.assign(document.createElement('button'), { type: 'button', className: 'sign-exit' });
  render(exit, html`${icon('x', 18)} <span>Exit</span>`);
  overlay.append(exit);
  document.body.append(overlay);

  let hideTimer = 0;
  const showExit = () => {
    overlay.classList.add('show-exit');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => overlay.classList.remove('show-exit'), 4000);
  };
  const awake = keepAwake({ label: 'Study sign' });
  let closed = false;
  let wasFull = false;

  function close({ silent = false } = {}) {
    if (closed) return;
    closed = true;
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFullscreen);
    if (document.fullscreenElement === overlay) document.exitFullscreen?.().catch(() => {});
    if (inApp()) native.send('immersive', { on: false });
    awake.release();
    overlay.remove();
    if (!silent) onExit?.();
  }
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  // Leaving the browser's full screen (Esc, or a swipe on a phone) leaves the sign too.
  const onFullscreen = () => {
    if (document.fullscreenElement === overlay) wasFull = true;
    else if (wasFull) close();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.sign-exit')) close();
    else showExit();
  });
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFullscreen);
  // In the Android app the browser's full screen is not available: the web view has no screen to hand it, and asking
  // for it turns the sign black. The sign already fills the window, so the app hides its own bars instead.
  if (inApp()) native.send('immersive', { on: true });
  else overlay.requestFullscreen?.().catch(() => {}); // best effort: the sign fills the window either way
  showExit(); // the way out is shown for a moment first, then only after a tap
  return { el: overlay, close };
}
