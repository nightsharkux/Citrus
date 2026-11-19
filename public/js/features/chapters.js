/**
 * Chapters of a lecture: the lecturer's own sections, marked with the Chapter button while teaching (like a lap on a
 * stopwatch) and named whenever they like, during the lecture or afterwards.
 *
 *   chaptersCard(chapters, { live })              the card: a numbered list, each chapter with where it runs
 *   mountChapters(root, { sid, chapters, onChange })   rename, join, and delete what was recorded in one chapter
 *   chapterTime(seconds)                          "4:05" or "1:02:03"
 *
 * Everything goes through the lecturer-only routes in src/modules/live/lecture-edits.js.
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { prompt, confirm, toast, toastError, menu } from '../core/ui.js';

/** Seconds as m:ss, or h:mm:ss from an hour on. */
export function chapterTime(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const row = (c) => html`<li class="chapter-row ${c.running ? 'is-running' : ''}" data-chapter="${c.id}">
  <span class="chapter-n" aria-hidden="true">${c.n}</span>
  <span class="chapter-main"><strong class="chapter-name ${c.title ? '' : 'is-default'}">${c.name}</strong><span class="small muted">${chapterTime(c.from)} – ${c.running ? 'now' : chapterTime(c.to)}</span></span>
  <button class="btn btn-ghost btn-icon btn-sm" data-chapter-menu="${c.id}" aria-label="Edit ${c.name}" title="Rename, join or delete">${icon('more', 16)}</button>
</li>`;

export const chapterRows = (chapters) => chapters.map(row);

export function chaptersCard(chapters, { live = false } = {}) {
  return html`<section class="card stack" data-chapters>
    <div><h2>Chapters</h2>
      <p class="small muted">${live ? 'Tap Chapter in the bar whenever you start something new, like a lap on a stopwatch. Name them now or later.' : 'Your own parts of the lecture. Name them, join two, or delete what was recorded in one.'}</p></div>
    <ol class="chapter-list" data-chapter-list>${chapterRows(chapters)}</ol>
  </section>`;
}

export function mountChapters(root, { sid, chapters, onChange }) {
  let list = chapters;
  const show = (next) => {
    list = next;
    const box = $('[data-chapter-list]', root);
    if (box) render(box, chapterRows(list));
    onChange?.(list);
  };

  async function rename(c) {
    const title = await prompt({ title: 'Name this chapter', label: 'Name', value: c.title, placeholder: 'Eigenvalues', confirmLabel: 'Save' });
    if (title === null || title === undefined) return;
    try {
      show((await api.patch(`/live/sessions/${sid}/chapters/${c.id}`, { title })).chapters);
    } catch (error) {
      toastError(error);
    }
  }

  async function join(c) {
    const first = c.n === 1;
    const ok = await confirm({
      title: first ? 'Join with the next chapter?' : 'Join with the chapter before?',
      message: first ? `“${list[1].name}” then starts where the lecture started. Nothing that was recorded is deleted.` : `“${c.name}” becomes part of “${list[c.n - 2].name}”. Nothing that was recorded is deleted.`,
      confirmLabel: 'Join',
    });
    if (!ok) return;
    try {
      show((await api.del(`/live/sessions/${sid}/chapters/${c.id}`)).chapters);
    } catch (error) {
      toastError(error);
    }
  }

  async function forget(c) {
    const ok = await confirm({
      title: `Delete the recording of “${c.name}”?`,
      message: 'What Citrus heard in this chapter and its audio are deleted for good, and so are the key points and excerpts from it. The chapter, the class answers and the flags stay.',
      confirmLabel: 'Delete recording',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.del(`/live/sessions/${sid}/chapters/${c.id}/content`);
      show(r.chapters);
      const parts = [r.deleted.lines ? `${r.deleted.lines} ${r.deleted.lines === 1 ? 'line' : 'lines'} of transcript` : '', r.deleted.audio ? `${r.deleted.audio} ${r.deleted.audio === 1 ? 'piece' : 'pieces'} of audio` : ''].filter(Boolean);
      toast(parts.length ? `Deleted ${parts.join(' and ')}` : 'Nothing was recorded in this chapter', 'success');
    } catch (error) {
      toastError(error);
    }
  }

  const off = on(root, 'click', '[data-chapter-menu]', (e, button) => {
    const c = list.find((x) => x.id === Number(button.dataset.chapterMenu));
    if (!c) return;
    menu(button, [
      { label: 'Rename', icon: 'edit', onSelect: () => rename(c) },
      ...(list.length > 1 ? [{ label: c.n === 1 ? 'Join with the next chapter' : 'Join with the chapter before', icon: 'undo', onSelect: () => join(c) }] : []),
      'divider',
      { label: 'Delete what was recorded here', icon: 'trash', danger: true, onSelect: () => forget(c) },
    ]);
  });
  off.set = show; // the page shows a new list (a chapter was just marked)
  return off;
}
