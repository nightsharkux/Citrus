/**
 * The island: a small frosted toolbar for full-screen views (lecture notes, tools).
 *
 *   const island = createIsland({ items, status, label });
 *   document.body.append(island.el);
 *   island.setStatus(html`…`); island.setActive('mic', true); island.setTone('trouble'); island.destroy();
 *
 *   items  [{ id, icon, label, onSelect(button), hidden?, keepOpen? }]   'divider' adds a thin separator
 *
 * It starts out of the way, as a small frosted circle. A tap opens the tools; Hide, Esc or a tap outside puts them
 * back. The person using it decides where it lives:
 *
 *   drag the circle (or the open bar) anywhere on the screen          arrow keys move it when the circle has focus
 *   Turn      lay the bar out across or down                          Fade   make the circle faint and blurred, so
 *   Hide      back to the circle                                      it cannot be seen until a touch or the pointer
 *                                                                     comes close
 *
 * Place, direction and fade are remembered on this device (localStorage, when the browser allows it). The bar opens
 * towards the side with more room and never leaves the screen. Every motion respects prefers-reduced-motion.
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';

const NARROW = '(max-width: 720px), (pointer: coarse) and (max-width: 1024px)';
const KEY = 'citrus.island';
const HANDLE = 44; // px, the circle
const PAD = 5; // px, round the circle inside the bar
const MARGIN = 10; // px kept free at the screen edges
const REVEAL = 96; // px: a pointer this close wakes a faded circle
const IDLE_MS = 3500;

/** What this device remembered: { fx, fy (the circle's centre as a share of the screen), vertical, fade }. */
export function loadPlace(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY) || '{}');
    const share = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined);
    return { fx: share(saved.fx), fy: share(saved.fy), vertical: typeof saved.vertical === 'boolean' ? saved.vertical : undefined, fade: saved.fade === true };
  } catch {
    return { fade: false };
  }
}

export function savePlace(place, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(place));
  } catch {
    /* private window or blocked storage: it simply starts from the default next time */
  }
}

/**
 * Where the circle's centre goes: the saved place, else the corner for this screen, kept inside the area. Pure, so
 * it is tested without a browser.
 */
export function anchorFor({ fx, fy }, { w, h }, narrow) {
  const x = fx ?? (narrow ? 1 - (HANDLE / 2 + MARGIN + 6) / w : 0.5);
  const y = fy ?? (narrow ? 0.62 : 1 - (HANDLE / 2 + MARGIN + 8) / h);
  const half = HANDLE / 2 + MARGIN;
  return { x: Math.min(Math.max(x * w, half), Math.max(half, w - half)), y: Math.min(Math.max(y * h, half), Math.max(half, h - half)) };
}

export function createIsland({ items = [], status = '', label = 'Tools' } = {}) {
  const el = document.createElement('div');
  el.className = 'island is-collapsed';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', label);
  const narrow = matchMedia(NARROW);
  const saved = loadPlace();
  let open = false;
  let idleTimer = 0;
  let tone = '';
  let place = { fx: saved.fx, fy: saved.fy };
  let vertical = saved.vertical ?? narrow.matches;
  let chosen = saved.vertical !== undefined; // the person turned the bar themselves: the screen size no longer decides
  let fade = saved.fade;

  const remember = () => savePlace({ fx: place.fx, fy: place.fy, vertical, fade });

  function draw() {
    render(el, html`
      <button class="island-handle" data-island-toggle aria-label="${open ? 'Hide tools' : 'Open tools'}" aria-expanded="${open}" aria-haspopup="true"></button>
      <div class="island-body">
        <div class="island-status" data-island-status ${status ? '' : 'hidden'}></div>
        <div class="island-items">${items.map((item) => (item === 'divider' ? html`<span class="island-divider" aria-hidden="true"></span>`
          : html`<button class="island-btn" data-island="${item.id}" aria-label="${item.label}" data-tip="${item.label}" ${item.hidden ? 'hidden' : ''}>${icon(item.icon, 20)}<span class="island-label">${item.label}</span></button>`))}</div>
        <span class="island-divider" aria-hidden="true"></span>
        <div class="island-items island-own">
          <button class="island-btn" data-island-turn aria-label="Turn the bar" data-tip="Turn the bar">${icon('turn', 19)}</button>
          <button class="island-btn" data-island-fade aria-label="Fade the circle" aria-pressed="${fade}" data-tip="Fade the circle">${icon('eye-off', 19)}</button>
          <button class="island-btn" data-island-hide aria-label="Hide tools" data-tip="Hide tools">${icon('minus', 19)}</button>
        </div>
      </div>`);
    drawHandle();
    setStatus(status);
    layout();
  }

  function drawHandle() {
    const handle = el.querySelector('[data-island-toggle]');
    if (!handle) return;
    render(handle, icon(open ? 'x' : 'campus', open ? 19 : 18));
    handle.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-label', open ? 'Hide tools' : 'Open tools');
    el.querySelector('[data-island-fade]')?.setAttribute('aria-pressed', String(fade));
  }

  /** The area the island lives in: the screen, or the box it was put in. */
  function area() {
    const parent = el.offsetParent;
    if (getComputedStyle(el).position === 'fixed' || !parent || parent === document.body) return { left: 0, top: 0, w: innerWidth, h: innerHeight };
    const r = parent.getBoundingClientRect();
    return { left: r.left, top: r.top, w: parent.clientWidth, h: parent.clientHeight };
  }

  /**
   * Put the circle where it belongs and, when open, fit the bar: towards the side with room, slid along the edge when
   * it would still run off, and scrolling only when the whole screen is too small for it.
   */
  function layout() {
    const a = area();
    const { x, y } = anchorFor(place, a, narrow.matches);
    el.classList.toggle('is-vertical', vertical);
    el.classList.toggle('is-open', open);
    el.classList.toggle('is-collapsed', !open);
    el.classList.toggle('is-faded', fade && !open);
    const box = HANDLE + PAD * 2;
    let back = false;
    let shift = 0;
    let tight = false;
    let room = 'none';
    if (open) {
      const body = el.querySelector('.island-body');
      el.style.setProperty('--island-room', 'none');
      el.classList.remove('is-tight');
      const natural = body ? (vertical ? body.scrollHeight : body.scrollWidth) : 0;
      const total = box + natural + 2;
      const main = vertical ? a.h : a.w;
      const at = vertical ? y : x;
      const forward = main - MARGIN - (at - box / 2);
      const backward = at + box / 2 - MARGIN;
      back = forward >= total ? false : backward >= total ? true : at > main / 2;
      const start = back ? at + box / 2 - total : at - box / 2;
      shift = Math.min(Math.max(start, MARGIN), Math.max(MARGIN, main - MARGIN - total)) - start;
      if (total > main - MARGIN * 2) {
        tight = true;
        room = `${Math.max(120, main - MARGIN * 2 - box - 2)}px`;
      }
    }
    el.classList.toggle('grow-back', back);
    el.classList.toggle('is-tight', tight);
    el.style.setProperty('--island-room', room);
    el.style.left = `${Math.round(x - box / 2 + (vertical ? 0 : shift))}px`;
    el.style.top = `${Math.round(y - box / 2 + (vertical ? shift : 0))}px`;
    el.dataset.tip = vertical ? (x > a.w / 2 ? 'left' : 'right') : y > a.h / 2 ? 'above' : 'below';
  }

  function setStatus(content) {
    status = content;
    const slot = el.querySelector('[data-island-status]');
    if (!slot) return;
    slot.hidden = !content;
    render(slot, content || '');
  }

  function setActive(id, on) {
    el.querySelector(`[data-island="${id}"]`)?.classList.toggle('is-active', !!on);
  }

  /** A small light on the circle while it is closed: 'good', 'watch' or 'trouble' (the class status in a lecture). */
  function setTone(next) {
    tone = ['good', 'watch', 'trouble'].includes(next) ? next : '';
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
  }

  function setItem(id, { icon: glyph, label: text, hidden } = {}) {
    const item = items.find((i) => i !== 'divider' && i.id === id);
    if (!item) return;
    if (glyph) item.icon = glyph;
    if (text) item.label = text;
    if (hidden !== undefined) item.hidden = hidden;
    const button = el.querySelector(`[data-island="${id}"]`);
    if (!button) return;
    render(button, html`${icon(item.icon, 20)}<span class="island-label">${item.label}</span>`);
    button.setAttribute('aria-label', item.label);
    button.dataset.tip = item.label;
    button.hidden = !!item.hidden;
    if (open) layout(); // the bar may have grown or shrunk
  }

  const setOpen = (value) => {
    open = !!value;
    drawHandle();
    layout();
    wakeUp();
  };

  // A faded circle comes back when something moves near it or a finger touches the screen, then fades again.
  const wakeUp = () => {
    el.classList.add('is-awake');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!el.matches(':hover, :focus-within') && !drag) el.classList.remove('is-awake');
    }, IDLE_MS);
  };
  const near = (e) => {
    const r = el.getBoundingClientRect();
    return e.clientX > r.left - REVEAL && e.clientX < r.right + REVEAL && e.clientY > r.top - REVEAL && e.clientY < r.bottom + REVEAL;
  };

  // ---- dragging: the circle, or the open bar by its circle ----
  let drag = null;
  const onDown = (e) => {
    if (!e.target.closest('[data-island-toggle]') || (e.button !== undefined && e.button > 0)) return;
    const a = area();
    const anchor = anchorFor(place, a, narrow.matches);
    drag = { startX: e.clientX, startY: e.clientY, dx: anchor.x - (e.clientX - a.left), dy: anchor.y - (e.clientY - a.top), moved: false, id: e.pointerId };
    try {
      e.target.closest('[data-island-toggle]').setPointerCapture?.(e.pointerId);
    } catch {
      /* the pointer is already gone: the drag simply follows the window's pointer events */
    }
  };
  const onMove = (e) => {
    if (!drag) {
      if (fade && !open && near(e)) wakeUp();
      return;
    }
    if (!drag.moved && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      el.classList.add('is-dragging');
    }
    const a = area();
    place = { fx: (e.clientX - a.left + drag.dx) / a.w, fy: (e.clientY - a.top + drag.dy) / a.h };
    layout();
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.moved) {
      el.dataset.dragged = '1'; // the click that ends a drag is not a tap
      el.classList.remove('is-dragging');
      remember();
    }
    drag = null;
    wakeUp();
  };

  const turn = () => {
    vertical = !vertical;
    chosen = true;
    layout();
    remember();
  };
  const toggleFade = () => {
    fade = !fade;
    drawHandle();
    layout();
    remember();
  };

  const onClick = (e) => {
    const toggle = e.target.closest('[data-island-toggle]');
    if (toggle) {
      if (el.dataset.dragged) {
        delete el.dataset.dragged;
        return;
      }
      setOpen(!open);
      return;
    }
    if (e.target.closest('[data-island-turn]')) return turn();
    if (e.target.closest('[data-island-fade]')) return toggleFade();
    if (e.target.closest('[data-island-hide]')) return setOpen(false);
    const button = e.target.closest('[data-island]');
    if (!button) return;
    const item = items.find((i) => i !== 'divider' && i.id === button.dataset.island);
    item?.onSelect?.(button);
    if (!item?.keepOpen) setOpen(false);
  };
  const onOutside = (e) => {
    wakeUp();
    if (open && !el.contains(e.target)) setOpen(false);
  };
  const STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const onKey = (e) => {
    if (e.key === 'Escape' && open) {
      // Folds the tools away; the full-screen view behind them stays.
      e.stopPropagation();
      e.stopImmediatePropagation();
      setOpen(false);
      return;
    }
    // With the circle focused, the arrow keys move it (and are not also taken as "next slide").
    if (STEP[e.key] && e.target.closest?.('[data-island-toggle]') && el.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      const a = area();
      const at = anchorFor(place, a, narrow.matches);
      const step = e.shiftKey ? 80 : 20;
      place = { fx: (at.x + STEP[e.key][0] * step) / a.w, fy: (at.y + STEP[e.key][1] * step) / a.h };
      layout();
      remember();
    }
  };
  const onResize = () => {
    if (!chosen) vertical = narrow.matches;
    layout();
  };

  el.addEventListener('click', onClick);
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('keydown', onKey);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey);
  narrow.addEventListener?.('change', onResize);
  el.addEventListener('focusin', wakeUp);

  draw();
  wakeUp();

  return {
    el,
    setStatus,
    setActive,
    setItem,
    setTone,
    setOpen,
    collapse: () => setOpen(false),
    turn,
    destroy() {
      clearTimeout(idleTimer);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
      narrow.removeEventListener?.('change', onResize);
      el.remove();
    },
  };
}
