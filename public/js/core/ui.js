/**
 * UI primitives: toasts, sheets (dialogs / bottom sheets), confirm and prompt
 * dialogs, popover menus, busy buttons and form submission.
 */
import { html, render, formValues } from './dom.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- Toasts

let toastHost;
export function toast(message, tone = 'info', { duration = 3200, href = '', hrefLabel = 'Open' } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  const glyph = tone === 'success' ? 'check-circle' : tone === 'error' ? 'alert' : 'info';
  render(el, html`${icon(glyph, 18)}<span>${message}</span>${href ? html`<a class="btn btn-sm" href="${href}" target="_blank" rel="noopener noreferrer">${hrefLabel}</a>` : ''}`);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}
export const toastError = (error) => toast(error?.message || String(error), 'error', { duration: 4800 });

// ---------------------------------------------------------------- Sheets

const openSheets = [];

/**
 * Open a sheet. `content` is a template; `onMount(body, close)` wires events.
 * Returns { close, root }. Escape and backdrop clicks close it.
 */
export function sheet({ title, content, footer, wide = false, onMount, onClose, className = '' }) {
  const previousFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  render(backdrop, html`
    <div class="sheet ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${title || 'Dialog'}">
      ${title ? html`<div class="sheet-head"><h2>${title}</h2><button class="btn btn-icon btn-ghost" data-close aria-label="Close">${icon('x')}</button></div>` : ''}
      <div class="sheet-body">${content}</div>
      ${footer ? html`<div class="sheet-foot">${footer}</div>` : ''}
    </div>`);
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    backdrop.classList.add('is-closing');
    setTimeout(() => {
      backdrop.remove();
      openSheets.splice(openSheets.indexOf(close), 1);
      if (!openSheets.length) document.body.style.overflow = '';
      previousFocus?.focus?.();
      onClose?.(result);
    }, 140);
  };
  openSheets.push(close);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close()));
  const root = backdrop.querySelector('.sheet');
  onMount?.(root, close);
  requestAnimationFrame(() => (root.querySelector('[autofocus]') || root.querySelector('input, textarea, select, button:not([data-close])'))?.focus());
  return { close, root };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSheets.length) {
    e.preventDefault();
    openSheets[openSheets.length - 1]();
  }
});

export const closeAllSheets = () => [...openSheets].forEach((close) => close());

/** Promise<boolean> confirmation dialog. */
export function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    sheet({
      title,
      content: html`<p class="muted">${message}</p>`,
      footer: html`<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmLabel}</button>`,
      onMount(root, close) {
        root.querySelector('[data-ok]').addEventListener('click', () => {
          resolve(true);
          close(true);
        });
      },
      onClose: (result) => result !== true && resolve(false),
    });
  });
}

/** Promise<string|null> single-field prompt. */
export function prompt({ title, label, placeholder = '', confirmLabel = 'Save', value = '', multiline = false, minLength = 1 }) {
  return new Promise((resolve) => {
    sheet({
      title,
      content: html`<form class="form" data-prompt>
        <label class="field"><span>${label}</span>
          ${multiline
            ? html`<textarea class="textarea" name="value" placeholder="${placeholder}" minlength="${minLength}" required autofocus>${value}</textarea>`
            : html`<input class="input" name="value" value="${value}" placeholder="${placeholder}" minlength="${minLength}" required autofocus>`}
        </label>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${confirmLabel}</button></div>
      </form>`,
      onMount(root, close) {
        root.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const v = e.target.value.value.trim();
          resolve(v);
          close(v);
        });
      },
      onClose: (result) => result === undefined && resolve(null),
    });
  });
}

// ---------------------------------------------------------------- Menus

/** Small popover menu anchored to a button. items: [{ label, icon, onSelect, danger }] or 'divider'. */
export function menu(anchor, items, { above = false, align = 'end' } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  render(el, html`${items.map((item, i) => (item === 'divider' ? html`<hr>` : html`<button role="menuitem" data-i="${i}" class="${item.danger ? 'danger' : ''}">${item.icon ? icon(item.icon, 17) : ''}${item.hint ? html`<span class="menu-text">${item.label}<small>${item.hint}</small></span>` : item.label}</button>`))}`);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  el.style.top = `${window.scrollY + (above ? Math.max(8, r.top - height - 8) : r.bottom + 6)}px`;
  const left = align === 'start' ? r.left : r.right - width;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, window.scrollX + left))}px`;
  const close = () => {
    el.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => {
    if (!el.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    close();
    items[Number(b.dataset.i)].onSelect?.();
  });
}

// ---------------------------------------------------------------- Async helpers

/** Show a spinner on `button` while `promise` runs. */
export async function busy(button, task) {
  if (!button) return task();
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

/**
 * Wire a form: prevents default, collects values, shows a busy state on the
 * submit button and toasts errors. `handler(values, form)` may return a
 * success message string.
 */
export function onSubmit(form, handler) {
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter || form.querySelector('button:not([type="button"])');
    try {
      const message = await busy(button, () => handler(formValues(form), form));
      if (typeof message === 'string') toast(message, 'success');
    } catch (error) {
      toastError(error);
    }
  });
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success');
  } catch {
    prompt({ title: 'Copy', label: 'Copy this text', value: text, confirmLabel: 'Done' });
  }
}

/** Animate a number from 0 to its value (respects reduced motion). */
export function countUp(el, to, duration = 700) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
