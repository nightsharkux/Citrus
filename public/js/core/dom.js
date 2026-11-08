/**
 * Safe HTML templating.
 *
 *   html`<p>${userText}</p>`      → interpolations are escaped automatically
 *   html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`   → nested templates are kept
 *   raw(trustedMarkup)            → opt out (only for markup we generated, e.g. icons)
 *
 * `null`, `undefined`, `false` and `true` render as nothing, so
 * `${cond && html`...`}` works as expected.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export class SafeHTML {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
export const raw = (markup) => new SafeHTML(String(markup ?? ''));

function stringify(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHTML) return value.value;
  if (Array.isArray(value)) return value.map(stringify).join('');
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += stringify(values[i]) + strings[i + 1];
  return new SafeHTML(out);
}

/** Replace an element's content with a template. */
export function render(element, view) {
  element.innerHTML = stringify(view);
  return element;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Delegated event listener. Returns a function that removes it. */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target.closest?.(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** Read a form into a plain object. Checkboxes become booleans; repeated names become arrays. */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      const group = form.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`);
      if (group.length > 1) {
        out[el.name] = out[el.name] || [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else if (el.tagName !== 'BUTTON') {
      out[el.name] = el.value;
    }
  }
  return out;
}

/** Deterministic hue for avatars and course tiles. */
export function hueOf(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
