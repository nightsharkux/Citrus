/**
 * Meetings (/meetings): meeting mode in one place. Start one now (a private meeting space is made for it, or use
 * one of your spaces), rejoin one that is running, or open recent minutes. The meeting itself runs in the space's
 * Meeting tab (pages/space.js).
 */
import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { ago, dateTime } from '../core/format.js';
import { busy, toastError } from '../core/ui.js';

/** Which speech recognition writes the captions, said plainly, so people know what to expect. */
export function speechLine() {
  const r = session.ai?.recognition;
  const provider = r?.enabled ? r.provider : 'browser';
  const names = { deepgram: 'Deepgram Nova-3', wispr: 'Wispr Flow', gateway: 'OpenAI transcription' };
  return names[provider]
    ? `Speech is written down by ${names[provider]}, which handles names, numbers and mixed German and English well.`
    : 'Speech is written down by your browser’s speech recognition (Chrome, Edge or Safari). For the most accurate minutes, an administrator can connect Deepgram or Wispr.';
}

export default {
  title: 'Meetings',
  async load() {
    return api.get('/meetings');
  },
  render(d) {
    const name = assistantName();
    const spaces = d.spaces.filter((s) => s.canSpeak && !s.meeting);
    return html`${pageHead({ title: 'Meetings', subtitle: `${name} writes down what’s said, you note decisions and action items with one tap, and the minutes are ready when the meeting ends.` })}
      <div class="stack stagger" style="max-width:860px">
        ${d.running.map((m) => html`<a class="notice accent" href="/spaces/${m.space.id}/meeting" style="text-decoration:none">${icon('message', 18)}<span><strong>${m.space.title}: meeting running.</strong> Started by ${m.by || 'a member'} ${ago(m.started)}.</span><span class="btn btn-sm btn-primary" style="margin-left:auto">Join</span></a>`)}
        <section class="card stack meeting-hub">
          <div><h2>Start a meeting</h2><p class="small muted">${speechLine()}</p></div>
          <form class="join-form" data-quick>
            <label class="field"><span>Title (optional)</span><input class="input" name="title" maxlength="120" placeholder="Project team, week 6"></label>
            <button class="btn btn-primary btn-lg">${icon('play', 18)} Start meeting</button>
          </form>
          ${spaces.length ? html`<form class="join-form" data-in-space>
            <label class="field"><span>Or in one of your spaces</span><select class="select" name="space">${spaces.map((s) => html`<option value="${s.id}">${s.title}</option>`)}</select></label>
            <button class="btn">${icon('play', 16)} Start there</button></form>` : ''}
          <ul class="meeting-points small muted">
            <li>Say “Hey ${name}, explain …” during the meeting and the answer appears straight away.</li>
            <li>After the meeting, ask for versions: “one file with the student questions and one without”.</li>
          </ul>
        </section>
        <section class="card flush"><div class="card-head"><h2>Recent minutes</h2></div>
          ${d.minutes.length ? html`<div class="list" style="padding-bottom:8px">${d.minutes.map((m) => html`<a class="list-row" href="/spaces/${m.workspace_id}/meeting">
            <span class="tile">${icon('clipboard', 18)}</span>
            <span class="body"><span class="title">${m.space}${m.label ? ` · ${m.label}` : ''}</span><span class="sub">${m.meeting_started ? `Meeting ${dateTime(m.meeting_started)}` : `Drafted ${dateTime(m.created)}`} · ${m.source}</span></span>
            <span class="trail">${icon('chevron-right', 18)}</span></a>`)}</div>`
            : html`<div style="padding:0 20px 16px">${empty({ icon: 'clipboard', title: 'No minutes yet', body: 'Minutes appear here after your first meeting.' })}</div>`}
        </section>
      </div>`;
  },
  mount(root, d, ctx) {
    const open = (id) => {
      sessionStorage.setItem(`meeting-mic-${id}`, '1'); // your microphone turns on when the meeting opens
      ctx.navigate(`/spaces/${id}/meeting`);
    };
    const offs = [
      on(root, 'submit', '[data-quick]', (e, form) => {
        e.preventDefault();
        busy(form.querySelector('button'), async () => {
          try {
            const r = await api.post('/meetings/quick', { title: form.title.value.trim() || undefined });
            open(r.id);
          } catch (error) {
            toastError(error);
          }
        });
      }),
      on(root, 'submit', '[data-in-space]', (e, form) => {
        e.preventDefault();
        busy(form.querySelector('button'), async () => {
          try {
            await api.post(`/workspaces/${form.space.value}/meeting`, { action: 'start' });
            open(form.space.value);
          } catch (error) {
            toastError(error);
          }
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};

