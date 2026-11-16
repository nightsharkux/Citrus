/** All tools: every feature with an honest status, searchable. */
import { html, $, $$, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { pageHead, statusChip } from '../core/components.js';
import { sheet } from '../core/ui.js';

const GROUP_ICON = { 'The classroom': 'presentation', Study: 'graduation', 'Assistant and collaboration': 'sparkle', Campus: 'compass', 'Classrooms and devices': 'door', Administration: 'shield', 'Your own tools': 'layers' };
const ITEM_ICON = { 'live-lecture': 'presentation', checkin: 'clipboard', nfc: 'nfc', 'lecture-review': 'trending', puck: 'radio', meetings: 'message', 'make-a-tool': 'sparkle', 'more-tools': 'layers', graphs: 'activity' };
const FILTERS = [['all', 'All'], ['available', 'Available'], ['limited', 'Pilot'], ['configuration', 'Setup required'], ['planned', 'In development']];

export default {
  title: 'All tools',
  async load() {
    return fetch('/api/v1/capabilities', { credentials: 'same-origin' }).then((r) => r.json());
  },
  render(d) {
    return html`
      ${pageHead({ title: 'All tools', subtitle: 'The classroom comes first: live feedback in lectures, check-in with your student ID, and reviews that show what to improve. Everything else is here when you need it.' })}
      <div class="spread" style="flex-wrap:wrap;margin-bottom:20px">
        <div class="search-input" style="flex:1;min-width:220px;max-width:420px">${icon('search', 18)}<input class="input" data-q placeholder="Search features" aria-label="Search features"></div>
        <div class="filter-bar" style="margin:0">${FILTERS.map(([k, label]) => html`<button class="chip ${k === 'all' ? 'is-active' : ''}" data-status-filter="${k}">${label}</button>`)}</div>
      </div>
      <div class="stack stagger">${d.groups.filter((g) => g.items.length).map((g, n) => html`<section data-group class="${n === 0 ? 'tools-core' : ''}">
        <h3 class="section-title">${g.group}</h3>
        <div class="grid-auto" style="--min:260px">${g.items.map((i) => html`<${i.route ? 'a' : 'button'} class="card tight tool" ${i.route ? html`href="${i.route}"` : html`data-planned="${i.id}"`} data-status="${i.status}" data-text="${`${i.label} ${i.description}`.toLowerCase()}">
          <div class="spread"><span class="tile ${i.status === 'planned' ? 'neutral' : n === 0 ? 'accent' : ''}">${icon(ITEM_ICON[i.id] || GROUP_ICON[g.group] || 'layers', 18)}</span>${statusChip(i.status)}</div>
          <strong class="mt-16" style="display:block">${i.label}</strong>
          <span class="small muted tool-desc" title="${i.description}">${i.description}</span>
        </${i.route ? 'a' : 'button'}>`)}</div>
      </section>`)}</div>
      <p class="small faint mt-24">Available: tested end to end · Pilot: works, with limits · Setup required: built, needs credentials or hardware · In development: not built yet.</p>`;
  },
  mount(root, d) {
    let status = 'all';
    const apply = () => {
      const q = $('[data-q]', root).value.trim().toLowerCase();
      $$('.tool', root).forEach((el) => el.classList.toggle('hidden', !((status === 'all' || el.dataset.status === status) && el.dataset.text.includes(q))));
      $$('[data-group]', root).forEach((g) => g.classList.toggle('hidden', !g.querySelector('.tool:not(.hidden)')));
    };
    const offs = [
      on(root, 'input', '[data-q]', apply),
      on(root, 'click', '[data-status-filter]', (e, b) => {
        status = b.dataset.statusFilter;
        $$('[data-status-filter]', root).forEach((x) => x.classList.toggle('is-active', x === b));
        apply();
      }),
      on(root, 'click', '[data-planned]', (e, b) => {
        const item = d.groups.flatMap((g) => g.items).find((i) => i.id === b.dataset.planned);
        sheet({ title: item.label, content: html`<div class="stack">${statusChip(item.status)}<p class="muted">${item.description}</p><p class="small faint">This feature isn’t available in Citrus yet, and nothing in the app pretends otherwise.</p></div>` });
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
