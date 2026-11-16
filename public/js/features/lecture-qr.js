/**
 * The QR code of a lecture. Anyone who scans it with a phone camera joins the lecture (pages/join.js): at once
 * when signed in, otherwise as a guest without an account. Every lecture has its own, and it stays the same, so
 * it can go on a slide or a printed sheet before the lecture starts.
 *
 *   openLectureQr({ lectureId })   for its lecturer: the code big, the link to copy, PNG (slides) and SVG (print)
 *                                  downloads, a printed sheet, full screen, and a new link if the old one got out
 *   showProjector({ … })           full screen for the projector: the QR code, the six-digit code while live
 *   qrImage(url)                   the code as an inline SVG
 */
import { html, raw, render, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { sheet, copyText, confirm, toast, toastError, busy } from '../core/ui.js';
import { dayLabel, time } from '../core/format.js';
import { qrSvg, qrCanvas } from '../core/qr.js';
import { printDocument } from './print.js';

export const joinUrl = (path) => `${location.origin}${path}`;
const spaced = (code) => (code ? `${code.slice(0, 3)} ${code.slice(3)}` : '');

/** The QR code as markup. Black on white whatever the theme, as scanners expect. */
export const qrImage = (url, label = 'QR code to join the lecture') => raw(qrSvg(url, { ecl: 'M', label }));

const whenOf = (lecture) => [lecture.starts ? `${dayLabel(lecture.starts)} · ${time(lecture.starts)}` : '', lecture.room].filter(Boolean).join(' · ');
const fileName = (link, ext) => `${`${link.course.code}-${link.lecture.title}`.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'lecture'}-qr.${ext}`;

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Full screen for the projector. `code` (while live) adds the six-digit code; `present` the count in the room. */
export function showProjector({ title, url, code = '', present = null, parent = document.body }) {
  const el = document.createElement('div');
  el.className = 'live-projector';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Join the lecture');
  const short = code ? `${location.host}/join/${code}` : url.replace(/^https?:\/\//, '');
  render(el, html`<button class="btn btn-ghost live-projector-close" data-close aria-label="Close">${icon('x', 22)}</button>
    <p class="live-projector-title">${title}</p>
    <div class="live-projector-join">
      <div class="qr-box live-projector-qr">${qrImage(url)}</div>
      <div class="live-projector-how">
        <p class="live-projector-lead"><b>Scan to join</b> with your phone camera.<br>No account needed.</p>
        ${code ? html`<p class="live-projector-lead">Or tap <b>Join lecture</b> in Campus OS and type</p>
          <p class="live-projector-code mono">${spaced(code)}</p>` : ''}
        <p class="live-projector-link mono">${short}</p>
      </div>
    </div>
    ${present === null ? '' : html`<p class="live-projector-count"><span data-projector-n>${present}</span> in the room</p>`}`);
  parent.append(el);
  const key = (e) => e.key === 'Escape' && close();
  function close() {
    el.remove();
    document.removeEventListener('keydown', key);
    if (parent === document.body && document.fullscreenElement === el) document.exitFullscreen?.().catch(() => {});
  }
  document.addEventListener('keydown', key);
  el.addEventListener('click', (e) => e.target.closest('[data-close]') && close());
  if (parent === document.body) el.requestFullscreen?.().catch(() => {}); // inside the notes viewer it already is
  return { el, close };
}

/**
 * The lecturer's QR code sheet for one lecture. `onShow` replaces the plain full screen (the live lecture shows its
 * code and the count as well); `onChange` hears about a new link.
 */
export async function openLectureQr({ lectureId, onShow = null, onChange = null }) {
  let link;
  try {
    link = await api.get(`/live/lectures/${lectureId}/link`);
  } catch (error) {
    toastError(error);
    return;
  }
  const url = () => joinUrl(link.path);
  const sub = () => [`${link.course.code} · ${link.course.title}`, whenOf(link.lecture)].filter(Boolean).join(' · ');
  const body = () => html`<div class="qr-box" data-qr>${qrImage(url())}</div>
    <div class="stack" style="--gap:14px">
      <div><strong>${link.lecture.title}</strong><p class="small muted">${sub()}</p></div>
      <p class="small muted">Anyone can scan it with a phone camera. People who are signed in join straight away; everyone else joins as a guest, without an account.${link.live ? '' : ' Before the lecture they join the course, and the lecture opens on their phone when you start it.'}</p>
      <div class="qr-link"><span class="mono small" data-url>${url()}</span><button class="btn btn-sm btn-ghost" data-copy title="Copy the link">${icon('copy', 15)} Copy</button></div>
      <div class="cluster">
        <button class="btn btn-sm btn-primary" data-show>${icon('maximize', 15)} Full screen</button>
        <button class="btn btn-sm" data-print>${icon('file', 15)} Print</button>
        <button class="btn btn-sm" data-png title="For slides">${icon('download', 15)} PNG</button>
        <button class="btn btn-sm" data-svg title="Sharp at any size, for printing">${icon('download', 15)} SVG</button>
      </div>
      <p class="small faint">Same code for this lecture every time, also when you open it again. Did it get out? <button class="link-button" data-new>Make a new one</button></p>
    </div>`;

  sheet({
    title: 'QR code',
    className: 'qr-sheet',
    content: html`<div class="qr-sheet-body" data-body>${body()}</div>`,
    onMount(root, close) {
      // The listeners go with the sheet when it closes.
      [
        on(root, 'click', '[data-copy]', () => copyText(url(), 'Link copied')),
        on(root, 'click', '[data-show]', () => {
          close();
          if (onShow) onShow(link);
          else showProjector({ title: link.lecture.title, url: url() });
        }),
        on(root, 'click', '[data-print]', () => printDocument({
          title: link.lecture.title,
          subtitle: sub(),
          body: html`<div class="qr-print">${qrImage(url())}<p><b>Scan to join the lecture</b> with your phone camera. No account needed.</p><p class="mono">${url()}</p></div>`,
        })),
        on(root, 'click', '[data-png]', () => qrCanvas(url(), { scale: 24 }).toBlob((blob) => blob && save(blob, fileName(link, 'png')), 'image/png')),
        on(root, 'click', '[data-svg]', () => save(new Blob([qrSvg(url(), { ecl: 'M' })], { type: 'image/svg+xml' }), fileName(link, 'svg'))),
        on(root, 'click', '[data-new]', async (e, button) => {
          const ok = await confirm({ title: 'Make a new QR code?', message: 'The current QR code and link stop working, also on slides and sheets you already made. Students already in the course stay in it.', confirmLabel: 'Make a new one', danger: true });
          if (!ok) return;
          await busy(button, async () => {
            try {
              link = await api.post(`/live/lectures/${lectureId}/link`);
              render(root.querySelector('[data-body]'), body());
              onChange?.(link);
              toast('New QR code ready', 'success');
            } catch (error) {
              toastError(error);
            }
          });
        }),
      ];
    },
  });
}
