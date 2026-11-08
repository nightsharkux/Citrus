/** Reusable view fragments. Each returns a template; none touch the DOM. */
import { html } from './dom.js';
import { icon } from './icons.js';
import { initials } from './format.js';
import { hueOf } from './dom.js';

export function pageHead({ title, subtitle, actions, back }) {
  return html`
    ${back ? html`<a class="back-link" href="${back.href}">${icon('chevron-left', 18)} ${back.label}</a>` : ''}
    <header class="page-head">
      <div><h1>${title}</h1>${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ''}</div>
      ${actions ? html`<div class="actions">${actions}</div>` : ''}
    </header>`;
}

export function empty({ icon: glyph = 'sparkle', title, body, action }) {
  return html`<div class="empty"><span class="tile">${icon(glyph, 24)}</span><h3>${title}</h3>${body ? html`<p>${body}</p>` : ''}${action || ''}</div>`;
}

export function row({ href, icon: glyph, tile, tone = '', title, sub, trail, chevron = !!href, attrs = '' }) {
  const lead = tile ?? (glyph ? html`<span class="tile ${tone}">${icon(glyph, 19)}</span>` : '');
  const inner = html`${lead}<span class="body"><span class="title">${title}</span>${sub ? html`<span class="sub">${sub}</span>` : ''}</span>
    <span class="trail">${trail || ''}${chevron ? icon('chevron-right', 18) : ''}</span>`;
  const cls = `list-row ${lead ? '' : 'no-icon'}`;
  return href ? html`<a class="${cls}" href="${href}" ${attrs}>${inner}</a>` : html`<div class="${cls}">${inner}</div>`;
}

export function avatar(name, size = '') {
  return html`<span class="avatar ${size}" style="--h:${hueOf(name)}" aria-hidden="true">${initials(name)}</span>`;
}

export function courseTile(code) {
  return html`<span class="tile text" style="background:hsl(${hueOf(code)} 80% 60% / .15);color:hsl(${hueOf(code)} 65% 45%)">${String(code || '?').slice(0, 3)}</span>`;
}

export function segmented(items, active) {
  return html`<nav class="segmented" aria-label="Sections">${items.map(([key, label, href]) => html`<a href="${href}" class="${key === active ? 'is-active' : ''}" ${key === active ? 'aria-current="page"' : ''}>${label}</a>`)}</nav>`;
}

export function stat(label, value, { icon: glyph, tone } = {}) {
  return html`<div class="card stat">${glyph ? html`<span class="tile sm ${tone || ''}" style="margin-bottom:10px">${icon(glyph, 17)}</span>` : ''}<div class="stat-value" data-count="${value}">${value}</div><div class="stat-label">${label}</div></div>`;
}

const STATUS_TONE = { available: 'success', limited: 'info', configuration: 'warning', planned: '' };
const STATUS_LABEL = { available: 'Available', limited: 'Pilot', configuration: 'Setup required', planned: 'In development' };
export const statusChip = (status) => html`<span class="chip ${STATUS_TONE[status] || ''}">${STATUS_LABEL[status] || status}</span>`;

const ROOM = {
  open: ['success', 'Open'],
  quiet: ['warning', 'Enter quietly'],
  do_not_disturb: ['danger', 'Do not disturb'],
  consultation: ['info', 'Consultation'],
};
export const roomChip = (status) => html`<span class="chip ${ROOM[status]?.[0] || ''}"><span class="dot"></span>${ROOM[status]?.[1] || 'Unknown'}</span>`;
export const ROOM_LABELS = Object.fromEntries(Object.entries(ROOM).map(([k, v]) => [k, v[1]]));

export function skeletonPage() {
  return html`<div class="skeleton title"></div><div class="skeleton line" style="width:30%;margin-bottom:28px"></div>
    <div class="grid-3"><div class="skeleton block"></div><div class="skeleton block"></div><div class="skeleton block"></div></div>
    <div class="skeleton block mt-24" style="height:220px"></div>`;
}

export function errorState(error, retryHref) {
  return html`<div class="card">${empty({ icon: 'alert', title: 'Something went wrong', body: error?.message || 'Please try again.', action: html`<a class="btn" href="${retryHref || location.pathname}">Try again</a>` })}</div>`;
}
