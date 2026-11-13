/**
 * The island: a small frosted toolbar for full-screen views (lecture notes, tools).
 *
 *   const island = createIsland({ items, status, label });
 *   document.body.append(island.el);
 *   island.setStatus(html`…`); island.setActive('mic', true); island.destroy();
 *
 *   items  [{ id, icon, label, onSelect(button), hidden? }]   'divider' adds a thin separator
 *
 * Wide screens: a pill floating at the bottom centre that fades back after a few seconds without movement and
 * returns when the pointer moves. Phones and narrow windows: a round button at the side of the screen, which can
 * be dragged up and down or to the other side; a tap opens the tools as a column. Esc or a tap outside closes it.
 * Every motion respects prefers-reduced-motion.
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';

const NARROW = '(max-width: 720px), (pointer: coarse) and (max-width: 1024px)';

export function createIsland({ items = [], status = '', label = 'Tools' } = {}) {
  const el = document.createElement('div');
  el.className = 'island';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', label);
  const narrow = matchMedia(NARROW);
  let open = false;
  let idleTimer = 0;
  let side = 'right';
  let top = 0.62; // share of the screen height, phones

  function draw() {
    render(el, html`
      <button class="island-handle" data-island-toggle aria-label="${open ? 'Close tools' : 'Open tools'}" aria-expanded="${open}">${icon(open ? 'x' : 'grid', 22)}</button>
      <div class="island-body">
        <div class="island-status" data-island-status ${status ? '' : 'hidden'}></div>
        <div class="island-items">${items.map((item) => (item === 'divider' ? html`<span class="island-divider" aria-hidden="true"></span>`
          : html`<button class="island-btn" data-island="${item.id}" aria-label="${item.label}" data-tip="${item.label}" ${item.hidden ? 'hidden' : ''}>${icon(item.icon, 20)}<span class="island-label">${item.label}</span></button>`))}</div>
      </div>`);
    setStatus(status);
    place();
  }

  function place() {
    el.classList.toggle('is-narrow', narrow.matches);
    el.classList.toggle('is-open', open);
    el.classList.toggle('on-left', side === 'left');
    if (narrow.matches) el.style.top = `${Math.round(top * 100)}%`;
    else el.style.top = '';
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
  }

  const setOpen = (value) => {
    open = value;
    const toggle = el.querySelector('[data-island-toggle]');
    if (toggle) {
      render(toggle, icon(open ? 'x' : 'grid', 22));
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close tools' : 'Open tools');
    }
    place();
  };

  // Wide screens: fade back when nothing moves, come back on movement.
  const wakeUp = () => {
    el.classList.remove('is-resting');
    clearTimeout(idleTimer);
    if (!narrow.matches) idleTimer = setTimeout(() => el.classList.add('is-resting'), 3500);
  };

  // Phones: drag the button along the edge.
  let drag = null;
  const onDown = (e) => {
    if (!narrow.matches || open || !e.target.closest('[data-island-toggle]')) return;
    drag = { y: e.clientY, x: e.clientX, moved: false };
  };
  const onMove = (e) => {
    wakeUp();
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) + Math.abs(e.clientX - drag.x) > 8) drag.moved = true;
    if (!drag.moved) return;
    top = Math.min(0.88, Math.max(0.12, e.clientY / innerHeight));
    side = e.clientX < innerWidth / 2 ? 'left' : 'right';
    place();
  };
  const onUp = () => {
    if (drag?.moved) el.dataset.dragged = '1';
    drag = null;
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
    const button = e.target.closest('[data-island]');
    if (!button) return;
    const item = items.find((i) => i !== 'divider' && i.id === button.dataset.island);
    item?.onSelect?.(button);
    if (narrow.matches && !item?.keepOpen) setOpen(false);
  };
  const onOutside = (e) => {
    if (open && !el.contains(e.target)) setOpen(false);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  };
  const onResize = () => {
    if (!narrow.matches) setOpen(false);
    place();
    wakeUp();
  };

  el.addEventListener('click', onClick);
  el.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
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
    setOpen,
    destroy() {
      clearTimeout(idleTimer);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
      narrow.removeEventListener?.('change', onResize);
      el.remove();
    },
  };
}
