/**
 * Print / "Save as PDF" without pop-ups: render into a print-only container
 * and call window.print(). Styles live in pages.css (@media print).
 */
import { html, render } from '../core/dom.js';

export function printDocument({ title, subtitle = '', body }) {
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.append(root);
  }
  render(root, html`<article><h1>${title}</h1>${subtitle ? html`<p class="print-sub">${subtitle}</p>` : ''}${body}</article>`);
  document.body.classList.add('is-printing');
  const done = () => {
    document.body.classList.remove('is-printing');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}
