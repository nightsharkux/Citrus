import { html } from '../core/dom.js';
import { empty } from '../core/components.js';
import { session } from '../core/store.js';

export default {
  public: true,
  title: 'Not found',
  render() {
    return html`<div class="card" style="margin-top:40px">${empty({ icon: 'compass', title: 'This page doesn’t exist', body: 'The link may be old, or the page has moved.', action: html`<a class="btn btn-primary" href="${session.user ? '/home' : '/'}">Go home</a>` })}</div>`;
  },
};
