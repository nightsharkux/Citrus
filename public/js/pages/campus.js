/** Campus: feed, guide (search + maps + links) and room status. */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, isStaff } from '../core/store.js';
import { pageHead, segmented, empty, roomChip, ROOM_LABELS } from '../core/components.js';
import { ago, dateTime, humanize, plural } from '../core/format.js';
import { sheet, onSubmit, toast, toastError, confirm, prompt, menu, busy } from '../core/ui.js';
import { debounce } from '../core/live.js';

const TABS = [['feed', 'Feed', '/campus'], ['guide', 'Guide', '/campus/guide'], ['rooms', 'Rooms', '/campus/rooms']];
const CAT = {
  announcement: ['bell', 'Announcement', 'info'], event: ['calendar', 'Event', 'accent'], job: ['briefcase', 'Job', 'success'],
  housing: ['home', 'Housing', 'warning'], research: ['target', 'Research', 'info'], community: ['users', 'Community', ''], product: ['sparkle', 'App update', ''],
};
const FILTERS = [['for-you', 'For you'], ['all', 'All'], ['event', 'Events'], ['job', 'Jobs'], ['research', 'Research'], ['housing', 'Housing'], ['community', 'Community'], ['announcement', 'Announcements']];

export default {
  title: 'Campus life',
  async load(ctx) {
    const tab = ctx.params.tab || 'feed';
    if (tab === 'guide') return { tab, ...(await api.get('/campus')) };
    if (tab === 'rooms') return { tab, ...(await api.get('/campus')) };
    return { tab: 'feed', ...(await api.get('/connect/posts')) };
  },
  render(d, ctx) {
    return html`
      ${pageHead({ title: 'Campus life', subtitle: d.tab === 'feed' ? 'Announcements, events and opportunities from your university community.' : d.tab === 'guide' ? 'Find your way around and search official information.' : 'Which rooms are open, busy or available for consultation.', actions: d.tab === 'feed' ? html`<button class="btn btn-primary" data-compose>${icon('plus', 17)} Post</button>` : d.tab === 'rooms' && isStaff() ? html`<a class="btn btn-primary" href="/classroom">${icon('door', 17)} Update a room</a>` : '' })}
      <div class="page-tabs">${segmented(TABS, d.tab)}</div>
      ${d.tab === 'feed' ? feed(d, ctx) : d.tab === 'guide' ? guide(d) : rooms(d)}`;
  },
  mount(root, d, ctx) {
    if (d.tab === 'feed') return mountFeed(root, d, ctx);
    if (d.tab === 'guide') return mountGuide(root);
    ctx.live.on('room.updated', debounce(ctx.refresh, 400));
    return undefined;
  },
};

// ---------------------------------------------------------------- Feed

function postCard(p) {
  const [glyph, label, tone] = CAT[p.category] || CAT.community;
  return html`<article class="card post" id="post-${p.id}" data-cat="${p.category}" data-match="${p.match.length ? 1 : 0}">
    <div class="spread">
      <div class="cluster" style="--gap:10px"><span class="tile ${tone}">${icon(glyph, 18)}</span><div><span class="chip ${tone}">${label}</span>${p.verified ? html` <span class="chip success">${icon('check', 12)} Verified</span>` : ''}${p.priority >= 4 ? html` <span class="chip danger">Important</span>` : ''}</div></div>
      <button class="btn btn-ghost btn-icon btn-sm" data-post-menu="${p.id}" aria-label="Post options">${icon('more', 17)}</button>
    </div>
    <h3 class="mt-16">${p.title}</h3>
    <p class="post-body pre-wrap mt-8">${p.body}</p>
    ${p.category === 'event' && (p.event_start || p.location) ? html`<div class="event-block mt-16">${p.event_start ? html`<span>${icon('calendar', 16)} ${dateTime(p.event_start)}</span>` : ''}${p.location ? html`<span>${icon('map-pin', 16)} ${p.location}</span>` : ''}</div>` : ''}
    ${p.match.length ? html`<p class="small mt-16" style="color:var(--accent)">${icon('sparkle', 13)} Matches your interests: ${p.match.join(', ')}</p>` : ''}
    <div class="spread mt-16 post-foot">
      <span class="small faint">${p.author} · ${ago(p.created)}</span>
      <div class="cluster" style="--gap:8px">
        ${p.link ? html`<a class="btn btn-sm" href="${p.link}" target="_blank" rel="noopener">${icon('external', 14)} Open</a>` : ''}
        ${p.category === 'event' && p.status === 'published' ? html`<button class="btn btn-sm ${p.attending ? 'btn-primary' : ''}" data-rsvp="${p.id}" data-going="${p.attending}">${p.attending ? html`${icon('check', 14)} Going` : 'I’m going'} · ${p.going}</button>` : ''}
      </div>
    </div>
  </article>`;
}

function feed(d, ctx) {
  const filter = ctx.query.get('filter') || 'all';
  const published = d.posts.filter((p) => p.status === 'published');
  const pending = d.posts.filter((p) => p.mine && p.status === 'pending');
  return html`
    <div class="filter-bar">${FILTERS.map(([key, label]) => html`<button class="chip ${filter === key ? 'is-active' : ''}" data-filter="${key}">${key === 'for-you' ? icon('sparkle', 13) : ''}${label}</button>`)}</div>
    ${pending.length ? html`<div class="notice" style="margin-bottom:16px">${icon('clock', 18)}<span>${plural(pending.length, 'post')} of yours ${pending.length === 1 ? 'is' : 'are'} waiting for review: ${pending.map((p) => p.title).join(', ')}</span></div>` : ''}
    <div class="feed stagger" id="feed">${published.length ? published.map(postCard) : html`<div class="card">${empty({ icon: 'compass', title: 'Nothing posted yet', body: 'Be the first — share an event, a job, or a call for study participants.', action: html`<button class="btn btn-primary" data-compose>Create a post</button>` })}</div>`}</div>
    <div class="card hidden" id="feed-empty">${empty({ icon: 'filter', title: 'Nothing here right now', body: 'Try another filter, or add interests in your profile to improve “For you”.', action: html`<a class="btn" href="/settings/profile">Edit interests</a>` })}</div>`;
}

function applyFilter(root, key) {
  let shown = 0;
  root.querySelectorAll('#feed .post').forEach((el) => {
    const visible = key === 'all' || (key === 'for-you' ? el.dataset.match === '1' : el.dataset.cat === key);
    el.classList.toggle('hidden', !visible);
    if (visible) shown += 1;
  });
  root.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === key));
  $('#feed-empty', root)?.classList.toggle('hidden', shown > 0 || !root.querySelector('#feed .post'));
}

function composeSheet(d, ctx) {
  const tags = d.interestTags || [];
  sheet({
    title: 'New post',
    wide: true,
    content: html`<form class="form" id="post-form">
      <label class="field"><span>Title</span><input class="input" name="title" required minlength="4" maxlength="120" placeholder="Looking for participants for a short UX study" autofocus></label>
      <div class="input-row">
        <label class="field"><span>Category</span><select class="select" name="category">${d.categories.filter((c) => c !== 'product' || session.user.role === 'admin').map((c) => html`<option value="${c}">${CAT[c][1]}</option>`)}</select></label>
        <label class="field"><span>Link (optional)</span><input class="input" name="link" type="url" placeholder="https://"></label>
      </div>
      <div class="input-row" data-event-fields>
        <label class="field"><span>When (events)</span><input class="input" name="event_start" type="datetime-local"></label>
        <label class="field"><span>Where (events)</span><input class="input" name="location" placeholder="Mensa, Weiden"></label>
      </div>
      <label class="field"><span>Details</span><textarea class="textarea" name="body" required minlength="8" maxlength="2500" placeholder="What, who it’s for, how to get involved"></textarea></label>
      <div class="field"><span>Topics (helps matching)</span><div class="cluster">${tags.map((t) => html`<label class="chip-check"><input type="checkbox" name="tags" value="${t}"><span>${humanize(t)}</span></label>`)}</div></div>
      <label class="check"><input type="checkbox" name="official"> This is on behalf of the university or an organisation</label>
      ${session.user.role === 'admin' ? html`<label class="field"><span>Priority</span><select class="select" name="priority"><option value="2">Normal</option><option value="3">High — notify everyone</option><option value="4">Critical — notify even in essential mode</option></select></label>` : ''}
      <p class="hint">${session.user.role === 'admin' || session.user.can_publish ? 'Your post is published immediately.' : 'An administrator reviews posts before they appear.'}</p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Post</button></div>
    </form>`,
    onMount(el, close) {
      const form = $('#post-form', el);
      const toggleEvent = () => el.querySelector('[data-event-fields]').classList.toggle('hidden', form.category.value !== 'event');
      form.category.addEventListener('change', toggleEvent);
      toggleEvent();
      onSubmit(form, async (v) => {
        const body = { ...v, tags: Array.isArray(v.tags) ? v.tags : [], event_start: v.event_start ? new Date(v.event_start).toISOString() : undefined, priority: Number(v.priority || 2) };
        const r = await api.post('/connect/posts', body);
        close();
        ctx.refresh();
        return r.note;
      });
    },
  });
}

function mountFeed(root, d, ctx) {
  applyFilter(root, ctx.query.get('filter') || 'all');
  const target = ctx.query.get('post');
  if (target) {
    const el = $(`#post-${target}`, root);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('is-flash');
  }
  if (ctx.query.get('compose') === '1') {
    history.replaceState({}, '', '/campus');
    composeSheet(d, ctx);
  }
  const offs = [
    on(root, 'click', '[data-filter]', (e, b) => {
      applyFilter(root, b.dataset.filter);
      history.replaceState({}, '', b.dataset.filter === 'all' ? '/campus' : `/campus?filter=${b.dataset.filter}`);
    }),
    on(root, 'click', '[data-compose]', () => composeSheet(d, ctx)),
    on(root, 'click', '[data-rsvp]', (e, b) => busy(b, async () => {
      try {
        const going = b.dataset.going !== 'true';
        const r = await api.post(`/connect/posts/${b.dataset.rsvp}/rsvp`, { going });
        b.dataset.going = String(going);
        b.classList.toggle('btn-primary', going);
        render(b, going ? html`${icon('check', 14)} Going · ${r.going}` : html`I’m going · ${r.going}`);
      } catch (error) {
        toastError(error);
      }
    })),
    on(root, 'click', '[data-post-menu]', (e, b) => {
      const post = d.posts.find((p) => p.id === Number(b.dataset.postMenu));
      const items = [{ label: 'Report', icon: 'flag', onSelect: async () => {
        const reason = await prompt({ title: 'Report this post', label: 'What’s wrong with it?', placeholder: 'Spam, misleading, inappropriate…', confirmLabel: 'Send report', minLength: 4 });
        if (!reason) return;
        await api.post(`/connect/posts/${post.id}/report`, { reason }).then(() => toast('Thanks — an administrator will take a look', 'success'), toastError);
      } }];
      if (post.mine || session.user.role === 'admin') items.push('divider', { label: 'Remove post', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirm({ title: 'Remove this post?', message: 'It disappears from the feed for everyone.', confirmLabel: 'Remove', danger: true }))) return;
        await api.del(`/connect/posts/${post.id}`).catch(toastError);
        ctx.refresh();
      } });
      menu(b, items);
    }),
  ];
  return () => offs.forEach((off) => off());
}

// ---------------------------------------------------------------- Guide

function guide(d) {
  const mapsLink = (address) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;
  return html`<div class="stack stagger">
    <section class="card">
      <h2>Search university information</h2>
      <form class="search-input mt-16" id="kb-search">${icon('search', 18)}<input class="input" name="q" placeholder="Library hours, exam registration, semester dates…" autocomplete="off" aria-label="Search university information"></form>
      <div id="kb-results" class="mt-16">${d.knowledgeCount ? '' : html`<p class="small muted">The knowledge library is empty. ${session.user.role === 'admin' ? html`<a href="/admin/ai">Add or import sources</a>.` : 'Your administrator can add official information here.'}</p>`}</div>
    </section>
    ${d.campuses.length ? html`<div class="grid-2">${d.campuses.map((c) => html`<section class="card campus-card">
      <div class="campus-map" aria-hidden="true">${icon('map-pin', 26)}</div>
      <h2 class="mt-16">${c.name}</h2>
      <p class="muted small">${c.address}</p>
      <div class="cluster mt-16" style="--gap:6px">${c.areas.map((a) => html`<span class="chip">${a}</span>`)}</div>
      <div class="cluster mt-16">
        <a class="btn btn-sm btn-primary" href="${c.mapUrl}" target="_blank" rel="noopener">${icon('file', 15)} Campus map</a>
        <a class="btn btn-sm" href="${mapsLink(c.address)}" target="_blank" rel="noopener">${icon('map-pin', 15)} Directions</a>
        <a class="btn btn-sm btn-ghost" href="${c.infoUrl}" target="_blank" rel="noopener">${icon('external', 15)} Info</a>
      </div>
    </section>`)}</div>` : ''}
    ${d.links.length ? html`<section><h3 class="section-title">Official services</h3><div class="grid-auto" style="--min:220px">${d.links.map((l) => html`<a class="card tight link-card" href="${l.url}" target="_blank" rel="noopener"><span class="tile">${icon(l.icon, 18)}</span><span class="grow"><strong>${l.label}</strong><span class="small muted" style="display:block">${l.description}</span></span>${icon('external', 15)}</a>`)}</div></section>` : ''}
    ${d.notice ? html`<p class="small faint">${d.notice} Always confirm dates, rules and room details with the official source.</p>` : ''}
  </div>`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Source';
  }
}

function mountGuide(root) {
  const form = $('#kb-search', root);
  const out = $('#kb-results', root);
  let controller;
  const search = debounce(async () => {
    const q = form.q.value.trim();
    if (q.length < 2) return render(out, '');
    controller?.abort();
    controller = new AbortController();
    try {
      const { results } = await api.get(`/knowledge/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      render(out, results.length ? html`<div class="stack" style="--gap:10px">${results.map((r) => html`<article class="kb-hit">
        <div class="spread"><strong>${r.title}</strong>${r.checkLive ? html`<span class="chip warning">Check live source</span>` : ''}</div>
        <p class="small muted mt-8">${r.excerpt}</p>
        ${r.url ? html`<a class="small" href="${r.url}" target="_blank" rel="noopener">${hostOf(r.url)} ${icon('external', 12)}</a>` : ''}
      </article>`)}
      <a class="btn btn-sm" href="/assistant?q=${encodeURIComponent(q)}">${icon('campus', 14)} Ask Campus</a></div>` : html`<p class="small muted">No matches. Try different words, or <a href="/assistant?q=${encodeURIComponent(q)}">ask Campus</a>.</p>`);
    } catch (error) {
      if (error.name !== 'AbortError') toastError(error);
    }
  }, 250);
  form.addEventListener('input', search);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
}

// ---------------------------------------------------------------- Rooms

function rooms(d) {
  return html`<section class="card flush stagger">
    ${d.rooms.length ? html`<div class="list" style="padding:8px 0">${d.rooms.map((r) => html`<div class="list-row">
      <span class="tile ${{ open: 'success', quiet: 'warning', do_not_disturb: 'danger', consultation: 'info' }[r.status]}">${icon('door', 18)}</span>
      <span class="body"><span class="title">${r.room}</span><span class="sub">${r.note || ROOM_LABELS[r.status]} · updated ${ago(r.updated)}</span></span>
      <span class="trail">${roomChip(r.status)}</span>
    </div>`)}</div>` : empty({ icon: 'door', title: 'No room updates', body: 'When lecturers set a room’s status, it shows here — and on any connected door light.' })}
  </section>`;
}
