/** A single space: notes, meeting recorder and minutes, assistant, live captions, settings. */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session } from '../core/store.js';
import { pageHead, segmented, empty, avatar } from '../core/components.js';
import { ago, bytes, dateTime, humanize, plural } from '../core/format.js';
import { onSubmit, toast, toastError, confirm, menu, copyText, busy } from '../core/ui.js';
import { markdown } from '../core/markdown.js';
import { debounce } from '../core/live.js';
import { createRecorder } from '../features/recorder.js';
import { createCaptioner } from '../features/voice.js';
import { printDocument } from '../features/print.js';
import { KIND, GUIDANCE } from './spaces.js';
import { faceMark } from '../features/face.js';

const NOTE_TYPES = [['note', 'Note', 'file'], ['minutes', 'Decision', 'check-circle'], ['task', 'Action item', 'clipboard'], ['resource', 'Resource', 'link'], ['question', 'Question', 'bulb']];
const NOTE_TONE = { minutes: 'success', task: 'warning', resource: 'info', question: 'accent' };

export default {
  title: (d) => d.room.title,
  async load(ctx) {
    const data = await api.get(`/workspaces/${ctx.params.id}`);
    const tab = ctx.params.tab || 'notes';
    if (tab === 'live') data.captions = await api.get(`/workspaces/${ctx.params.id}/captions`);
    return { ...data, tab };
  },
  render(d) {
    const w = d.room;
    const [glyph, kindLabel] = KIND[w.kind] || KIND.study;
    const base = `/spaces/${w.id}`;
    const tabs = [['notes', 'Notes', base], ['meeting', 'Meeting', `${base}/meeting`], ['assistant', 'Assistant', `${base}/assistant`]];
    if (['lecture', 'meeting', 'discussion'].includes(w.kind) || w.live) tabs.push(['live', w.live ? 'Live ●' : 'Live captions', `${base}/live`]);
    if (w.isOwner) tabs.push(['settings', 'Settings', `${base}/settings`]);
    return html`
      ${pageHead({
        back: { href: '/spaces', label: 'Spaces' },
        title: w.title,
        subtitle: html`<span class="cluster" style="--gap:8px"><span class="chip">${icon(glyph, 14)} ${kindLabel}</span>${w.course ? html`<a class="chip accent" href="/courses/${w.course.id}">${w.course.code}</a>` : ''}<span class="chip outline">${GUIDANCE[w.guidance]?.[0]} assistant</span></span>`,
        actions: html`
          <span class="avatars" title="${d.members.map((m) => m.name).join(', ')}">${d.members.slice(0, 4).map((m) => avatar(m.name, 'sm'))}</span>
          <button class="btn" data-copy-code="${w.join_code}">${icon('ticket', 16)} <span class="mono">${w.join_code}</span></button>
          <button class="btn btn-ghost btn-icon" data-space-menu aria-label="Space options">${icon('more', 19)}</button>`,
      })}
      ${d.activeRecorders ? html`<div class="notice danger" style="margin-bottom:16px">${icon('record', 16)}<span><strong>Recording in progress.</strong> Someone in this space is recording audio.</span></div>` : ''}
      <div class="page-tabs">${segmented(tabs, d.tab)}</div>
      <div class="stagger">${({ notes, meeting, assistant, live, settings })[d.tab]?.(d) || notes(d)}</div>`;
  },
  mount(root, d, ctx) {
    const w = d.room;
    const offs = [
      on(root, 'click', '[data-copy-code]', (e, b) => copyText(b.dataset.copyCode, 'Invite code copied')),
      on(root, 'click', '[data-space-menu]', (e, b) => menu(b, [
        { label: 'Copy invite code', icon: 'copy', onSelect: () => copyText(w.join_code, 'Invite code copied') },
        w.isOwner
          ? { label: 'Archive space', icon: 'trash', danger: true, onSelect: async () => {
            if (!(await confirm({ title: 'Archive this space?', message: 'Members lose access. Notes and recordings are kept for the record.', confirmLabel: 'Archive', danger: true }))) return;
            await api.post(`/workspaces/${w.id}/archive`).catch(toastError);
            ctx.navigate('/spaces');
          } }
          : { label: 'Leave space', icon: 'logout', danger: true, onSelect: async () => {
            await api.post(`/workspaces/${w.id}/leave`).catch(toastError);
            ctx.navigate('/spaces');
          } },
      ])),
    ];
    const tabCleanup = ({ notes: mountNotes, meeting: mountMeeting, assistant: mountAssistant, live: mountLive, settings: mountSettings })[d.tab]?.(root, d, ctx);
    if (d.tab !== 'live') ctx.live.on('workspace.updated', debounce((e) => e.workspaceId === w.id && ['notes', 'recording'].includes(e.what) && ctx.refresh(), 700));
    return () => {
      offs.forEach((off) => off());
      tabCleanup?.();
    };
  },
};

// ---------------------------------------------------------------- Notes

function notes(d) {
  return html`<div class="space-grid">
    <section class="card">
      <form class="form" id="note-form">
        <div class="cluster note-types">${NOTE_TYPES.map(([k, label, glyph], i) => html`<label class="chip-radio"><input type="radio" name="category" value="${k}" ${i === 0 ? 'checked' : ''}><span>${icon(glyph, 14)} ${label}</span></label>`)}</div>
        <textarea class="textarea" name="content" required minlength="3" maxlength="10000" placeholder="Write a note, a decision, an action item…"></textarea>
        <div class="form-actions"><button class="btn btn-primary">Add to notes</button></div>
      </form>
    </section>
    <section class="stack" style="--gap:12px">
      ${d.notes.length ? d.notes.map((n) => html`<article class="card tight note">
        <div class="spread"><div class="cluster" style="--gap:8px">${avatar(n.author, 'sm')}<strong class="small">${n.author}</strong><span class="faint small">${ago(n.created)}</span></div>
          <div class="cluster" style="--gap:6px"><span class="chip ${NOTE_TONE[n.category] || ''}">${NOTE_TYPES.find((t) => t[0] === n.category)?.[1] || humanize(n.category)}</span>
          ${n.author_id === session.user.id || d.room.isOwner ? html`<button class="btn btn-ghost btn-icon btn-sm" data-del-note="${n.id}" aria-label="Delete note">${icon('trash', 15)}</button>` : ''}</div></div>
        <p class="pre-wrap mt-8">${n.content}</p>
      </article>`) : html`<div class="card">${empty({ icon: 'file', title: 'No notes yet', body: 'Notes are shared with everyone in this space and give the assistant context.' })}</div>`}
    </section>
  </div>`;
}

function mountNotes(root, d, ctx) {
  onSubmit($('#note-form', root), async (v, form) => {
    await api.post(`/workspaces/${d.room.id}/notes`, v);
    form.reset();
    ctx.refresh();
  });
  return on(root, 'click', '[data-del-note]', async (e, b) => {
    if (!(await confirm({ title: 'Delete note?', message: 'It will be removed for everyone.', confirmLabel: 'Delete', danger: true }))) return;
    await api.del(`/workspaces/${d.room.id}/notes/${b.dataset.delNote}`).catch(toastError);
    ctx.refresh();
  });
}

// ---------------------------------------------------------------- Meeting

function meeting(d) {
  return html`<div class="space-grid">
    <div class="stack">
      <section class="card recorder">
        <div class="spread"><h2>Record</h2><span class="chip" id="rec-state">Ready</span></div>
        <canvas id="rec-canvas" width="560" height="80" aria-hidden="true"></canvas>
        <div class="rec-controls">
          <span class="rec-time mono" id="rec-time">00:00</span>
          <button class="rec-button" id="rec-button" aria-label="Start recording"><span></span></button>
          <span class="rec-time"></span>
        </div>
        <label class="check"><input type="checkbox" id="rec-consent"> Everyone present knows this is being recorded and agrees.</label>
        <p class="hint">Audio is stored on your university’s server and is private to you until you share it.${d.transcription !== 'Disabled' ? ' It is transcribed automatically.' : ''}</p>
      </section>
      <section class="card flush">
        <div class="card-head"><h2>Recordings</h2></div>
        ${d.recordings.length ? html`<div class="list" style="padding-bottom:10px">${d.recordings.map((r) => html`<div class="recording">
          <div class="spread"><div><strong>${dateTime(r.created)}</strong><p class="small muted">${bytes(r.bytes)} · ${r.mine ? (r.shared ? 'Shared with members' : 'Only you') : 'Shared with you'}</p></div>
            ${r.mine ? html`<button class="btn btn-ghost btn-icon btn-sm" data-rec-menu="${r.id}" data-shared="${r.shared}" aria-label="Recording options">${icon('more', 17)}</button>` : ''}</div>
          <audio controls preload="none" src="/api/workspaces/recordings/${r.id}/audio"></audio>
          ${r.mine ? html`<details class="transcript"><summary>${r.transcript ? 'Transcript' : 'Add a transcript'}</summary>
            <form data-transcript="${r.id}" class="form mt-8"><textarea class="textarea" name="transcript" placeholder="Paste or type the transcript">${r.transcript}</textarea><div class="form-actions"><button class="btn btn-sm">Save transcript</button></div></form>
          </details>` : r.transcript ? html`<details class="transcript"><summary>Transcript</summary><p class="pre-wrap small mt-8">${r.transcript}</p></details>` : ''}
        </div>`)}</div>` : html`<p class="muted small" style="padding:0 20px 20px">Nothing recorded yet.</p>`}
      </section>
    </div>
    <section class="card flush">
      <div class="card-head"><h2>Minutes</h2><button class="btn btn-sm btn-primary" data-analyze>${icon('sparkle', 15)} Draft from notes</button></div>
      <p class="small muted" style="padding:0 20px">${d.aiEnabled ? 'Drafted by AI from your notes and transcripts. Review before sharing.' : 'Drafted with a simple text extractor because no AI model is connected.'}</p>
      ${d.reports.length ? html`<div class="stack" style="padding:14px 20px 20px;--gap:12px">${d.reports.map((r) => html`<article class="report">
        <div class="spread"><span class="chip ${r.source === 'AI draft' ? 'accent' : ''}">${r.source}</span><div class="cluster" style="--gap:4px"><span class="small faint">${ago(r.created)}</span>
          <button class="btn btn-ghost btn-icon btn-sm" data-print="${r.id}" aria-label="Print">${icon('download', 15)}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-del-report="${r.id}" aria-label="Delete">${icon('trash', 15)}</button></div></div>
        <div class="prose small mt-8">${markdown(r.report)}</div>
      </article>`)}</div>` : html`<div style="padding:0 20px 20px">${empty({ icon: 'clipboard', title: 'No minutes yet', body: 'Add decisions and action items in Notes, then draft minutes here.' })}</div>`}
    </section>
  </div>`;
}

function mountMeeting(root, d, ctx) {
  const id = d.room.id;
  const button = $('#rec-button', root);
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const recorder = createRecorder({
    workspaceId: id,
    canvas: $('#rec-canvas', root),
    onTick: (s) => ($('#rec-time', root).textContent = fmt(s)),
    onSaved: (r) => {
      toast(r.warning || 'Recording saved', r.warning ? 'info' : 'success');
      ctx.refresh();
    },
    onError: toastError,
  });
  const setState = (on_) => {
    button.classList.toggle('is-recording', on_);
    button.setAttribute('aria-label', on_ ? 'Stop recording' : 'Start recording');
    const state = $('#rec-state', root);
    state.className = `chip ${on_ ? 'danger' : ''}`;
    state.innerHTML = on_ ? '<span class="dot live"></span>Recording' : 'Ready';
  };
  button.addEventListener('click', async () => {
    if (recorder.recording) {
      recorder.stop();
      setState(false);
      $('#rec-state', root).textContent = 'Saving…';
      return;
    }
    if (!$('#rec-consent', root).checked) return toast('Confirm that everyone agreed to the recording first.', 'error');
    try {
      await recorder.start();
      setState(true);
    } catch (error) {
      toastError(error);
    }
  });

  const offs = [
    on(root, 'click', '[data-analyze]', (e, b) => busy(b, async () => {
      try {
        await api.post(`/workspaces/${id}/analyze`, { include_captions: true });
        ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    })),
    on(root, 'click', '[data-print]', (e, b) => {
      const r = d.reports.find((x) => x.id === Number(b.dataset.print));
      printDocument({ title: `${d.room.title} — minutes`, subtitle: `${dateTime(r.created)} · ${r.source} · Review before distributing`, body: markdown(r.report) });
    }),
    on(root, 'click', '[data-del-report]', async (e, b) => {
      await api.del(`/workspaces/${id}/reports/${b.dataset.delReport}`).catch(toastError);
      ctx.refresh();
    }),
    on(root, 'submit', '[data-transcript]', async (e, form) => {
      e.preventDefault();
      await api.patch(`/workspaces/recordings/${form.dataset.transcript}`, { transcript: form.transcript.value }).then(() => toast('Transcript saved', 'success'), toastError);
    }),
    on(root, 'click', '[data-rec-menu]', (e, b) => {
      const shared = b.dataset.shared === 'true';
      menu(b, [
        { label: shared ? 'Stop sharing' : 'Share with members', icon: 'users', onSelect: () => api.patch(`/workspaces/recordings/${b.dataset.recMenu}`, { shared: !shared }).then(ctx.refresh, toastError) },
        { label: 'Draft minutes from this', icon: 'sparkle', onSelect: () => api.post(`/workspaces/${id}/analyze`, { recording_id: Number(b.dataset.recMenu) }).then(ctx.refresh, toastError) },
        { label: 'Download', icon: 'download', onSelect: () => { location.href = `/api/workspaces/recordings/${b.dataset.recMenu}/audio?download=1`; } },
        'divider',
        { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirm({ title: 'Delete recording?', message: 'The audio file and any minutes drafted from it are deleted permanently.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/workspaces/recordings/${b.dataset.recMenu}`).catch(toastError);
          ctx.refresh();
        } },
      ]);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    recorder.destroy();
  };
}

// ---------------------------------------------------------------- Assistant (space-scoped)

function assistant(d) {
  const [label, desc] = GUIDANCE[d.room.guidance] || GUIDANCE.coach;
  const name = 'Campus';
  return html`<section class="card chat-card">
    <div class="spread"><div><h2>${name}</h2><p class="small muted">${label}: ${desc}</p></div>${d.messages.length ? html`<button class="btn btn-sm btn-ghost" data-clear>Clear</button>` : ''}</div>
    <div class="chat-log compact" id="space-log">${d.messages.length ? d.messages.map((m) => m.role === 'user'
      ? html`<div class="msg user"><div class="bubble">${m.content}</div></div>`
      : html`<div class="msg ai"><span class="msg-avatar">${faceMark()}</span><div class="msg-body"><div class="prose">${markdown(m.content)}</div></div></div>`)
      : html`<p class="muted small center" style="padding:30px 0">Ask about this space’s notes, topic or assignment. Your conversation here is private.</p>`}</div>
    ${d.aiEnabled ? html`<form class="composer mt-16" id="space-ask"><textarea name="prompt" rows="1" placeholder="Ask ${name}…" required minlength="2"></textarea><div class="composer-actions"><button class="btn btn-primary btn-icon" aria-label="Send">${icon('arrow-up', 18)}</button></div></form>`
      : html`<div class="notice warning mt-16">${icon('info', 18)}<span>No AI model is connected yet.</span></div>`}
  </section>`;
}

function mountAssistant(root, d, ctx) {
  const log = $('#space-log', root);
  log.scrollTop = log.scrollHeight;
  const form = $('#space-ask', root);
  form?.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  onSubmit(form, async (v) => {
    log.insertAdjacentHTML('beforeend', html`<div class="msg user"><div class="bubble">${v.prompt}</div></div><div class="msg ai is-streaming" id="pending"><span class="msg-avatar">${faceMark()}</span><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div></div>`.value);
    log.scrollTop = log.scrollHeight;
    form.reset();
    try {
      await api.post(`/workspaces/${d.room.id}/assistant`, { prompt: v.prompt });
      ctx.refresh();
    } catch (error) {
      $('#pending', log)?.remove();
      throw error;
    }
  });
  return on(root, 'click', '[data-clear]', async () => {
    await api.del(`/workspaces/${d.room.id}/assistant`);
    ctx.refresh();
  });
}

// ---------------------------------------------------------------- Live captions

function live(d) {
  const canSpeak = d.room.canGuide || d.room.isOwner;
  return html`<div class="space-grid">
    <section class="card captions-card">
      <div class="spread"><h2>${d.room.live ? html`<span class="chip danger"><span class="dot live"></span>Live</span>` : 'Captions'}</h2><span class="small faint">${plural(d.captions.captions.length, 'line')}</span></div>
      <div class="captions" id="captions" aria-live="polite">${d.captions.captions.map((c) => html`<p>${c.text}</p>`)}<p class="interim" id="interim"></p></div>
      ${!d.captions.captions.length ? html`<p class="muted small center" id="captions-empty">${d.room.live ? 'Waiting for the speaker…' : 'Captions appear here when the lecturer starts them.'}</p>` : ''}
    </section>
    <div class="stack">
      ${canSpeak ? html`<section class="card">
        <h2>Speaker controls</h2>
        <p class="small muted mt-8">Your browser turns your speech into text and shares it with everyone in this space. Chrome and Edge send audio to their speech service.</p>
        <div class="cluster mt-16"><button class="btn ${d.room.live ? 'btn-danger' : 'btn-primary'}" data-live-toggle>${d.room.live ? html`${icon('stop', 16)} Stop captions` : html`${icon('captions', 16)} Start captions`}</button></div>
        ${d.room.course ? html`<form class="input-row mt-16" id="topic-form"><input class="input" name="title" placeholder="New topic, e.g. Merge sort" required minlength="3"><button class="btn">Mark</button></form><p class="hint mt-8">Marks a topic in ${d.room.course.code} so students can rate it straight away.</p>` : ''}
      </section>` : ''}
      <section class="card">
        <h2>Summary</h2>
        <div id="summary" class="prose small mt-8"><p class="muted">Get key points and self-check questions from the transcript so far.</p></div>
        <button class="btn mt-16" data-summary ${d.aiEnabled ? '' : 'disabled'}>${icon('sparkle', 15)} Summarise</button>
      </section>
    </div>
  </div>`;
}

function mountLive(root, d, ctx) {
  const id = d.room.id;
  const box = $('#captions', root);
  const interim = $('#interim', root);
  box.scrollTop = box.scrollHeight;
  const append = (text, topic = false) => {
    $('#captions-empty', root)?.remove();
    const p = document.createElement('p');
    p.textContent = text;
    if (topic) p.className = 'topic-mark';
    box.insertBefore(p, interim);
    box.scrollTop = box.scrollHeight;
  };
  let captioner = null;
  ctx.live.on('caption', (c) => c.workspaceId === id && append(c.text, c.topic));
  // The speaker's own page must not refresh mid-stream (that would stop the microphone).
  ctx.live.on('captions.state', (s) => s.workspaceId === id && !captioner?.running && ctx.refresh());

  const offs = [
    on(root, 'click', '[data-live-toggle]', async (e, b) => {
      if (d.room.live) {
        captioner?.stop();
        d.room.live = false;
        await api.post(`/workspaces/${id}/live`, { active: false }).catch(toastError);
        return;
      }
      captioner = createCaptioner({
        onFinal: (text) => text && api.post(`/workspaces/${id}/captions`, { text }).catch(() => {}),
        onInterim: (text) => (interim.textContent = text),
      });
      if (!captioner) return toast('Live captions need Chrome, Edge or Safari.', 'error');
      await busy(b, () => api.post(`/workspaces/${id}/live`, { active: true, reset: !d.captions.captions.length }));
      d.room.live = true;
      captioner.start();
      render(b, html`${icon('stop', 16)} Stop captions`);
      b.className = 'btn btn-danger';
    }),
    on(root, 'click', '[data-summary]', (e, b) => busy(b, async () => {
      try {
        const r = await api.post(`/workspaces/${id}/captions/summary`);
        render($('#summary', root), markdown(r.summary));
      } catch (error) {
        toastError(error);
      }
    })),
  ];
  onSubmit($('#topic-form', root), async (v, form) => {
    await api.post(`/workspaces/${id}/topic`, v);
    form.reset();
    return 'Topic added — students can rate it now';
  });
  return () => {
    offs.forEach((off) => off());
    if (captioner?.running) {
      captioner.stop();
      api.post(`/workspaces/${id}/live`, { active: false }).catch(() => {});
    }
  };
}

// ---------------------------------------------------------------- Settings

function settings(d) {
  const w = d.room;
  return html`<div class="space-grid">
    <section class="card">
      <h2>Space settings</h2>
      <form class="form mt-16" id="settings-form">
        <label class="field"><span>Name</span><input class="input" name="title" value="${w.title}" required minlength="3"></label>
        <label class="field"><span>Assistant approach</span><select class="select" name="guidance">${Object.entries(GUIDANCE).map(([k, [label, desc]]) => html`<option value="${k}" ${k === w.guidance ? 'selected' : ''}>${label} — ${desc}</option>`)}</select></label>
        <label class="field"><span>Instructions</span><textarea class="textarea" name="instructions" maxlength="2000" placeholder="e.g. Encourage independent analysis before offering examples.">${w.instructions}</textarea></label>
        <div class="form-actions"><button class="btn btn-primary">Save</button></div>
      </form>
    </section>
    <section class="card flush"><div class="card-head"><h2>Members</h2><span class="chip">${d.members.length}</span></div>
      <div class="list" style="padding-bottom:8px">${d.members.map((m) => html`<div class="list-row">${avatar(m.name)}<span class="body"><span class="title">${m.name}</span><span class="sub">${humanize(m.role)}${m.id === w.creator_id ? ' · Owner' : ''}</span></span></div>`)}</div>
      <div style="padding:6px 20px 20px"><p class="small muted">Invite people with the code <b class="mono">${w.join_code}</b>. Anyone at your university with the code can join.</p></div>
    </section>
  </div>`;
}

function mountSettings(root, d, ctx) {
  onSubmit($('#settings-form', root), async (v) => {
    await api.patch(`/workspaces/${d.room.id}`, v);
    ctx.refresh();
    return 'Saved';
  });
}
