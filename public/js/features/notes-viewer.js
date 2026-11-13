/**
 * Full-screen notes for a live lecture: the lecturer's pictures, PDFs and slides, big, with the island at the bottom.
 *
 *   const viewer = openNotesViewer({ sessionId, notes, start, tools, status, onClose });
 *   viewer.setStatus(html`…`); viewer.answer(question, promise); viewer.close();
 *
 * `tools` are extra island items from the lecture page (listen, ask by voice, the join code…). The viewer itself
 * adds switching (previous, next, all notes), the chat panel and exit. Pictures and PDFs are shown as they are
 * (PDFs in the browser's own viewer, with its page controls); other files are shown as their text, a slide or a
 * page at a time.
 */
import { html, render, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { markdown } from '../core/markdown.js';
import { createIsland } from './island.js';

/** Text of a slide deck or document in readable pages: slides as they are, other text about a screen at a time. */
export function textPages(text) {
  const clean = String(text || '').trim();
  if (!clean) return ['(This note has no text to show.)'];
  const slides = clean.split(/^Slide \d+\n/m).map((s) => s.trim()).filter(Boolean);
  if (slides.length > 1) return slides;
  const pages = [];
  let page = '';
  for (const para of clean.split(/\n{2,}/)) {
    if (page && page.length + para.length > 1400) {
      pages.push(page);
      page = '';
    }
    page = page ? `${page}\n\n${para}` : para;
  }
  if (page) pages.push(page);
  return pages;
}

export function openNotesViewer({ sessionId, notes, start = 0, tools = [], status = '', onAsk, onClose }) {
  const el = document.createElement('div');
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Lecture notes');
  render(el, html`<div class="viewer-stage" data-stage></div>
    <div class="viewer-caption" data-caption></div>
    <aside class="viewer-panel" data-panel hidden>
      <div class="spread"><strong>Ask Campus</strong><button class="btn btn-ghost btn-icon btn-sm" data-panel-close aria-label="Close">${icon('x', 16)}</button></div>
      <div class="viewer-answer prose" data-answer><p class="small muted">Ask about these notes or what you just said. The answer stays here and is read aloud.</p></div>
      <form class="composer" data-panel-form><textarea name="q" rows="1" maxlength="600" placeholder="Explain this slide more simply" aria-label="Question"></textarea>
        <div class="composer-actions"><button class="btn btn-primary btn-icon" aria-label="Ask">${icon('arrow-up', 18)}</button></div></form>
    </aside>
    <div class="viewer-grid" data-grid hidden></div>`);
  document.body.append(el);

  const cache = new Map();
  let index = Math.min(Math.max(0, start), Math.max(0, notes.length - 1));
  let page = 0;

  async function noteData(n) {
    if (!cache.has(n.id)) cache.set(n.id, api.get(`/live/sessions/${sessionId}/notes/${n.id}`).catch(() => ({ ...n, viewable: 'text', text: '' })));
    return cache.get(n.id);
  }

  async function show(i, p = 0) {
    if (!notes.length) {
      render($('[data-stage]', el), html`<div class="viewer-empty">${icon('file', 40)}<p>No notes yet. Add pictures or PDFs on the lecture page.</p></div>`);
      return;
    }
    index = (i + notes.length) % notes.length;
    const n = await noteData(notes[index]);
    const stage = $('[data-stage]', el);
    const file = `/api/live/sessions/${sessionId}/notes/${n.id}/file`;
    let pages = 1;
    if (n.viewable === 'image') render(stage, html`<img class="viewer-image" src="${file}" alt="${n.name}">`);
    else if (n.viewable === 'pdf') render(stage, html`<iframe class="viewer-pdf" src="${file}#view=FitH&toolbar=1" title="${n.name}"></iframe>`);
    else {
      const all = textPages(n.text);
      pages = all.length;
      page = Math.min(Math.max(0, p < 0 ? all.length - 1 : p), all.length - 1);
      render(stage, html`<article class="viewer-text prose">${markdown(all[page])}</article>`);
    }
    if (n.viewable !== 'text') page = 0;
    render($('[data-caption]', el), html`<span>${n.name}</span><span class="faint">${notes.length > 1 ? `${index + 1} of ${notes.length}` : ''}${pages > 1 ? ` · ${page + 1}/${pages}` : ''}</span>`);
    show.pages = pages;
  }

  const next = () => (show.pages > 1 && page < show.pages - 1 ? show(index, page + 1) : show(index + 1, 0));
  const previous = () => (show.pages > 1 && page > 0 ? show(index, page - 1) : show(index - 1, -1));

  function grid() {
    const box = $('[data-grid]', el);
    box.hidden = !box.hidden;
    if (box.hidden) return;
    render(box, html`<div class="viewer-grid-inner">${notes.map((n, i) => html`<button class="viewer-thumb ${i === index ? 'is-current' : ''}" data-pick="${i}">${n.kind === 'image' ? html`<img src="/api/live/sessions/${sessionId}/notes/${n.id}/file" alt="">` : icon('file', 28)}<span>${n.name}</span></button>`)}</div>`);
  }

  const panel = $('[data-panel]', el);
  const answerBox = $('[data-answer]', el);
  function togglePanel(force) {
    panel.hidden = force === undefined ? !panel.hidden : !force;
    island.setActive('chat', !panel.hidden);
    if (!panel.hidden) setTimeout(() => panel.querySelector('textarea').focus(), 60);
  }
  /** Show a question and its answer in the panel (also used for questions asked by voice). */
  async function answer(question, pending) {
    togglePanel(true);
    render(answerBox, html`<p class="small muted">${question}</p><span class="typing"><i></i><i></i><i></i></span>`);
    try {
      const r = await pending;
      render(answerBox, html`<p class="small muted">${question}</p>${markdown(r.answer)}`);
    } catch (error) {
      render(answerBox, html`<p class="small muted">${question}</p><p>${error.message}</p>`);
    }
  }

  const island = createIsland({
    label: 'Lecture tools',
    status,
    items: [
      { id: 'prev', icon: 'chevron-left', label: 'Previous', onSelect: previous, keepOpen: true },
      { id: 'next', icon: 'chevron-right', label: 'Next', onSelect: next, keepOpen: true },
      { id: 'all', icon: 'grid', label: 'All notes', onSelect: grid },
      'divider',
      ...tools,
      { id: 'chat', icon: 'message', label: 'Chat with Campus', onSelect: () => togglePanel() },
      'divider',
      { id: 'exit', icon: 'minimize', label: 'Exit full screen', onSelect: () => close() },
    ],
  });
  island.el.classList.add('in-viewer');
  el.append(island.el);

  const onKey = (e) => {
    if (e.target.closest?.('textarea, input')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      previous();
    } else if (e.key === 'Escape' && !document.fullscreenElement) close();
  };
  const onClick = (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      $('[data-grid]', el).hidden = true;
      show(Number(pick.dataset.pick));
    }
    if (e.target.closest('[data-panel-close]')) togglePanel(false);
  };
  const onSubmit = (e) => {
    if (!e.target.matches('[data-panel-form]')) return;
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q || !onAsk) return;
    e.target.q.value = '';
    answer(q, onAsk(q, notes[index]?.name));
  };
  const onTextKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('[data-panel-form] textarea')) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  };
  // Leaving the browser's full screen (Esc) leaves the viewer too.
  const onFullscreen = () => {
    if (!document.fullscreenElement && el.dataset.wasFull) close();
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('keydown', onTextKey);
  document.addEventListener('fullscreenchange', onFullscreen);
  el.requestFullscreen?.().then(() => { el.dataset.wasFull = '1'; }).catch(() => {});

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFullscreen);
    if (document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
    island.destroy();
    el.remove();
    onClose?.();
  }

  show(index);
  return { el, island, close, answer, setStatus: island.setStatus, setActive: island.setActive, setItem: island.setItem };
}
