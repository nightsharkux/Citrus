/**
 * After a lecture (/lectures/review/:sessionId).
 *
 *   Lecturer  where it went wrong: the class's minute-by-minute understanding, the lecture part by part with its
 *             average, each stretch where students got lost with what was being said, the flags and key points.
 *             Campus writes notes and a teaching review (PDF to the phone), and the lecturer talks it through with
 *             Campus right here to improve the explanations and the notes.
 *   Student   a private recap: their own results part by part next to the class, the areas to target first, their
 *             flags explained, their own study notes (PDF), and one tap to a quiz or a question to the assistant.
 *
 * Every download also comes as a tagged .txt with instructions any AI can follow (src/modules/live/record.js).
 */
import { html, render, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { dateTime } from '../core/format.js';
import { markdown } from '../core/markdown.js';
import { busy, confirm, toast, toastError } from '../core/ui.js';
import { savePdf, saveText } from '../features/notes-export.js';
import { FLAGS } from './live.js';

// ---- the record, part by part

const STATUS = {
  good: ['success', 'Following'],
  watch: ['warning', 'Some unsure'],
  trouble: ['danger', 'Many lost'],
  quiet: ['outline', 'Too few answers'],
};
const YOU = { 1: ['success', 'You followed'], 2: ['warning', 'You were unsure'], 3: ['danger', 'You were lost'] };
const pct = (n) => (n === null || n === undefined ? '–' : `${n}%`);

/** One part of the lecture: its time, what it was about, how the class (and the student) followed. */
function sectionRow(s, student) {
  const [tone, word] = STATUS[s.status] || STATUS.quiet;
  const you = student && s.youWorst ? YOU[s.youWorst] : null;
  return html`<div class="review-section ${s.followUp ? 'is-follow' : ''} ${student && s.target ? 'is-target' : ''}">
    <div class="spread"><strong>${s.id} · ${s.clock}</strong>
      <span class="cluster" style="--gap:6px">${student && s.target ? html`<span class="chip danger">${icon('target', 13)} Work on this</span>` : ''}${!student && s.followUp ? html`<span class="chip danger">Follow up</span>` : ''}<span class="chip ${tone}">${word}</span></span></div>
    <p class="mt-4">${s.title}</p>
    <div class="review-meter" role="img" aria-label="${s.understood === null ? 'Too few answers' : `${s.understood}% understood`}"><i class="is-${s.status}" style="width:${s.understood ?? 0}%"></i></div>
    <p class="small muted mt-4">${s.understood === null ? 'Too few answers to tell' : `Class: ${s.understood}% understood${s.lowest !== null && s.lowest < s.understood ? `, lowest ${s.lowest}%` : ''}`}${s.flags ? ` · ${s.flags} ${s.flags === 1 ? 'flag' : 'flags'}` : ''}${you ? ` · ${you[1]}` : ''}</p>
    ${s.points.length > 1 ? html`<ul class="small review-points-mini">${s.points.slice(1).map((p) => html`<li>${p}</li>`)}</ul>` : ''}
    ${s.struggles.map((x) => html`<p class="small mt-4">${icon('alert', 13)} ${x.note || `${x.lost} of ${x.answered} lost`}</p>`)}
    ${student
      ? (s.target ? html`<button class="btn btn-sm mt-8" data-explain-part="${s.id}">${icon('sparkle', 14)} Explain this part to me</button>` : '')
      : html`<button class="btn btn-sm btn-ghost mt-8" data-coach-ask="${`How could I explain ${s.id} (${s.clock}, “${s.title}”) better? Use what students flagged and what I said there.`}">${icon('campus', 14)} Ask ${assistantName()} about this part</button>`}
  </div>`;
}

function sectionsCard(record, student) {
  if (!record?.sections?.length) return '';
  const a = record.averages;
  return html`<section class="card flush"><div class="card-head"><h2>${student ? 'Your results, part by part' : 'Part by part'}</h2></div>
    <div class="review-averages">
      ${student ? html`<div><span class="review-big">${pct(a.you?.understood)}</span><span class="small muted">You understood</span></div>` : ''}
      <div><span class="review-big">${pct(a.lecture.understood)}</span><span class="small muted">${student ? 'Class average' : 'Class understood, on average'}</span></div>
      ${student
        ? html`<div><span class="review-big">${record.targets.length}</span><span class="small muted">${record.targets.length === 1 ? 'Part to work on' : 'Parts to work on'}</span></div>`
        : html`<div><span class="review-big">${record.followUps.length}</span><span class="small muted">${record.followUps.length === 1 ? 'Part to follow up' : 'Parts to follow up'}</span></div>`}
    </div>
    <div class="list">${(student ? [...record.sections].sort((x, y) => (y.target ? 1 : 0) - (x.target ? 1 : 0) || x.from - y.from) : record.sections).map((s) => sectionRow(s, student))}</div></section>`;
}

/** Notes Campus writes from the record, and the record itself, saved to this device. */
function notesCard(d, student) {
  const name = assistantName();
  return html`<section class="card stack review-notes"><div class="spread"><div><h2>${student ? 'My notes' : 'Notes and teaching review'}</h2>
      <p class="small muted">${student
        ? `${name} writes study notes from your own answers and flags: the parts to work on first, explained, with practice questions.`
        : `${name} writes the lecture notes from everything that happened: what you said, how the class followed, the flags. Every part that did not land gets a clearer explanation.`}
      The PDF and the .txt are saved to this device. The .txt carries instructions, so any AI can turn it into notes too.</p></div></div>
    <div class="cluster"><button class="btn btn-primary" data-make-notes>${icon('sparkle', 16)} ${student ? 'Make my notes (PDF)' : 'Make the notes (PDF)'}</button>
      <a class="btn" href="/api/live/sessions/${d.session.id}/record.txt" download>${icon('download', 16)} ${student ? 'My record (.txt)' : 'Lecture record (.txt)'}</a></div>
    <div data-notes-out></div></section>`;
}

/** The lecturer and Campus, in the review: why parts did not land, better explanations, improved notes. */
function coachCard() {
  const name = assistantName();
  const ideas = ['Which part went worst, and why?', 'Rewrite my explanation of the hardest part with a simpler example', 'What should I recap at the start of the next lecture?', 'Make improved notes for next time'];
  return html`<section class="card stack review-coach"><div><h2>Improve it with ${name}</h2>
      <p class="small muted">${name} has the whole lecture: what you said, every answer and flag, the averages and your notes. Ask why a part did not land, or how to explain it better. The conversation stays on this device.</p></div>
    <div class="coach-log" data-log aria-live="polite"></div>
    <div class="cluster" data-ideas>${ideas.map((q) => html`<button class="chip outline coach-idea" data-coach-ask="${q}">${q}</button>`)}</div>
    <form class="composer" data-coach-form><textarea name="q" rows="1" maxlength="2000" aria-label="Message" placeholder="Why were they lost at minute 7?"></textarea>
      <div class="composer-actions"><button class="btn btn-primary btn-icon composer-send" aria-label="Send">${icon('arrow-up', 19)}</button></div></form></section>`;
}

const TONE = { 1: 'good', 2: 'watch', 3: 'trouble' };
const isLecturer = () => session.user.role !== 'student';

const blocks = (cells) => html`<div class="live-line" role="img" aria-label="Minute-by-minute understanding">${cells.map((c) => html`<i class="${c.tone ? `is-${c.tone}` : ''}" title="${c.title}"></i>`)}</div>`;

const keyPoints = (points) => (points.length
  ? html`<section class="card"><h3>Key points</h3><ul class="review-points">${points.map((p) => html`<li><span class="chip outline">${p.minute} min</span> ${p.text}</li>`)}</ul></section>`
  : '');

function lecturerView(d) {
  const { session: s, course, timeline, struggles, points, pulse, answeredBy } = d;
  const hasSpeech = struggles.some((m) => m.excerpt);
  return html`${pageHead({ back: { href: '/lectures', label: 'Lectures' }, title: s.title, subtitle: `${course.code} · ${dateTime(s.started)}` })}
    <div class="stack stagger" style="max-width:760px">
      <section class="card">
        <p><strong>${struggles.length ? `The class got lost ${struggles.length === 1 ? 'once' : `${struggles.length} times`}.` : 'The class followed without major trouble.'}</strong>
          <span class="muted"> ${answeredBy} ${answeredBy === 1 ? 'student' : 'students'} answered${pulse.enrolled ? ` out of ${pulse.enrolled}` : ''}.</span></p>
        <h3 class="mt-24">Through the lecture</h3>
        ${blocks(timeline.map((m) => ({ tone: m.status === 'quiet' ? '' : m.status, title: `Minute ${m.minute}` })))}
        <p class="small muted mt-8">Green: following. Amber: some unsure. Red: many lost. Grey: too few answers to tell.</p>
      </section>
      ${sectionsCard(d.record, false)}
      ${coachCard()}
      ${notesCard(d, false)}
      ${struggles.length ? html`<section class="card flush"><div class="card-head"><h2>Where it got hard</h2></div>
        <div class="list">${struggles.map((m) => html`<div class="review-moment">
          <div class="spread"><strong>Minute ${m.minute}</strong><span class="chip danger">${m.lost} of ${m.answered} lost</span></div>
          ${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}
          ${m.excerpt ? html`<blockquote class="review-quote">${m.excerpt.replace(/^\[\d\d:\d\d\]\s*/, '').replace(/\s*\[\d\d:\d\d\]\s*/g, ' ')}</blockquote>` : ''}
        </div>`)}</div>
        ${hasSpeech ? '' : html`<p class="small muted" style="padding:0 20px 18px">Campus didn’t hear the lecture at these moments. Turn on listening next time to see what was being said.</p>`}</section>` : ''}
      ${lecturerFlags(d.flags)}
      ${keyPoints(points)}
      ${transcriptCard(d)}
    </div>`;
}

const flagLabel = (kind) => (FLAGS[kind] || FLAGS.confused)[0];

const liveAgain = (courseId) => html`<a class="notice accent live-again" href="/live/${courseId}" style="text-decoration:none;margin-bottom:16px" data-live-again>${icon('presentation', 18)}<span><strong>This lecture is live again.</strong> Tap to rejoin.</span><span class="btn btn-sm btn-primary" style="margin-left:auto">Rejoin</span></a>`;

/** The moments students flagged, grouped by minute, with what was being said when the transcript was kept. */
function lecturerFlags(flags = []) {
  if (!flags.length) return '';
  const byMinute = new Map();
  for (const f of flags) byMinute.set(f.minute, [...(byMinute.get(f.minute) || []), f]);
  return html`<section class="card flush"><div class="card-head"><h2>What students flagged</h2><span class="chip">${flags.length}</span></div>
    <div class="list">${[...byMinute.entries()].map(([minute, group]) => html`<div class="review-moment">
      <div class="spread"><strong>Minute ${minute}</strong><span class="cluster" style="--gap:6px">${[...new Set(group.map((f) => f.kind))].map((k) => html`<span class="chip outline">${flagLabel(k)} ${group.filter((f) => f.kind === k).length}</span>`)}</span></div>
      ${group.filter((f) => f.note).map((f) => html`<p class="small mt-8">“${f.note}”</p>`)}
      ${group[0].excerpt ? html`<blockquote class="review-quote">${group[0].excerpt.replace(/\[minute \d+\]\s*/g, '')}</blockquote>` : ''}
    </div>`)}</div></section>`;
}

function transcriptCard(d) {
  const s = d.session;
  if (!s.keepTranscript) return html`<p class="small muted">The transcript of this lecture was not kept.</p>`;
  return html`<section class="card"><div class="spread"><div><h3>Transcript</h3><p class="small muted">${d.stored ? `${d.stored} lines heard. Students can ask ${assistantName()} about this lecture; only you can download it.` : 'Nothing was heard during this lecture.'}</p></div>
    ${d.stored ? html`<div class="cluster"><a class="btn btn-sm" href="/api/live/sessions/${s.id}/transcript.txt">${icon('download', 15)} Download .txt</a><button class="btn btn-sm btn-ghost" data-forget>${icon('trash', 15)} Delete</button></div>` : ''}</div></section>`;
}

function myFlags(flags = []) {
  if (!flags.length) return '';
  return html`<section class="card flush"><div class="card-head"><h2>Moments you flagged</h2></div>
    <div class="list">${flags.map((f) => html`<div class="review-moment">
      <div class="spread"><strong>Minute ${f.minute} · ${flagLabel(f.kind)}</strong>${f.explanation ? '' : html`<button class="btn btn-sm" data-explain="${f.id}">${icon('sparkle', 14)} Explain it</button>`}</div>
      ${f.note ? html`<p class="small muted mt-8">“${f.note}”</p>` : ''}
      <div class="prose small mt-8" data-explanation="${f.id}">${f.explanation ? markdown(f.explanation) : ''}</div>
    </div>`)}</div></section>`;
}

function askLecture(d) {
  if (!d.canAsk) return '';
  return html`<section class="card stack"><div><h2>Ask ${assistantName()} about this lecture</h2><p class="small muted">${assistantName()} answers from what was said in the lecture and the lecturer’s notes. Private to you.</p></div>
    <form class="composer" data-ask-form><textarea name="q" rows="1" maxlength="600" aria-label="Question" placeholder="What was the second example about?"></textarea>
      <div class="composer-actions"><button class="btn btn-primary btn-icon composer-send" aria-label="Ask">${icon('arrow-up', 19)}</button></div></form>
    <div class="live-answer" data-answer hidden></div></section>`;
}

function studentView(d) {
  const { session: s, course, mine, classPatches, struggles, points, signals } = d;
  const level = (minute) => mine.find((m) => m.minute === minute)?.level || null;
  const stuck = struggles.map((m) => ({ ...m, you: [level(m.minute), level(m.minute + 1), level(m.minute - 1)].find((l) => l === 3 || l === 2) || null }));
  const topic = [s.title, ...points.slice(0, 2).map((p) => p.text)].join('. ').slice(0, 160);
  return html`${pageHead({ back: { href: '/lectures', label: 'Lectures' }, title: s.title, subtitle: `${course.code} · ${dateTime(s.started)}` })}
    <div class="stack stagger" style="max-width:760px">
      <section class="card">
        <h3>How you followed</h3>
        ${signals ? blocks(mine.map((m) => ({ tone: m.level ? TONE[m.level] : '', title: `Minute ${m.minute}` }))) : ''}
        <p class="small muted mt-8">${signals ? 'Only you can see this. Green: following. Amber: unsure. Red: lost. Grey: no answer.' : 'You didn’t answer during this lecture. Next time, tap how you’re following and this recap will show where you got stuck.'}</p>
      </section>
      ${signals || d.flags?.length ? sectionsCard(d.record, true) : ''}
      ${notesCard(d, true)}
      ${myFlags(d.flags)}
      ${askLecture(d)}
      ${stuck.length ? html`<section class="card flush"><div class="card-head"><h2>Where the class got stuck</h2></div>
        <div class="list">${stuck.map((m) => html`<div class="review-moment"><div class="spread"><strong>Minute ${m.minute}</strong>${m.you ? html`<span class="chip ${m.you === 3 ? 'danger' : 'warning'}">${m.you === 3 ? 'You were lost too' : 'You were unsure too'}</span>` : ''}</div>${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}</div>`)}</div></section>` : ''}
      ${keyPoints(points)}
      ${points.length || stuck.length ? html`<section class="card"><h3>Review</h3>
        <div class="cluster mt-8"><a class="btn btn-primary" href="/quiz/new?topic=${encodeURIComponent(topic)}&count=6">${icon('target', 16)} Quiz me on this lecture</a>
        <a class="btn" href="/assistant?new=1&q=${encodeURIComponent(`Help me review the lecture “${s.title}”. ${points.map((p) => p.text).join(' ')}`)}">${icon('campus', 16)} Ask Campus</a></div></section>` : ''}
      ${!points.length && !stuck.length && !signals && !d.flags?.length && !d.canAsk ? html`<div class="card">${empty({ icon: 'presentation', title: 'Nothing to review yet', body: 'Key points and trouble spots appear when the lecturer’s microphone was on during the lecture.' })}</div>` : ''}
    </div>`;
}

export default {
  title: 'Lecture review',
  async load(ctx) {
    const id = ctx.params.id;
    const data = await api.get(`/live/sessions/${id}/${isLecturer() ? 'report' : 'recap'}`);
    // The lecturer may have reopened the lecture: then the student can go straight back in.
    const active = isLecturer() ? null : await api.get(`/live/courses/${data.session.course_id}/active`).catch(() => null);
    const again = active?.session && active.session.id !== data.session.id && active.session.lecture_id === data.session.lecture_id ? active.session : null;
    return { lecturer: isLecturer(), data, again };
  },
  render({ lecturer, data, again }) {
    return html`${again ? liveAgain(data.session.course_id) : ''}${lecturer ? lecturerView(data) : studentView(data)}`;
  },
  mount(root, data, ctx) {
    const sid = data.data.session.id;
    const courseId = data.data.session.course_id;
    // The lecturer's page keeps filling in while the AI writes its notes.
    if (data.lecturer && !data.data.session.ended) {
      ctx.live.on('live.moment', () => ctx.refresh());
    }
    // A student who just left: if the lecture comes back, show "Rejoin". Live events, and a slow check as a fallback
    // for hosts where live events do not reach every open page.
    let poll = 0;
    if (!data.lecturer && !data.again) {
      ctx.live.on('live.started', (e) => (!e.lecture || e.lecture === data.data.session.lecture_id) && ctx.refresh());
      const endedAgo = Date.now() - Date.parse(data.data.session.ended || 0);
      if (endedAgo < 2 * 3_600_000) {
        poll = setInterval(async () => {
          const active = await api.get(`/live/courses/${courseId}/active`).catch(() => null);
          if (active?.session && active.session.id !== sid) {
            clearInterval(poll);
            ctx.refresh();
          }
        }, 20_000);
      }
    }
    const d = data.data;
    const student = !data.lecturer;
    const subtitle = `${d.course.code} ${d.course.title} · ${dateTime(d.session.started)}`;
    const figure = d.record ? { minutes: d.record.minutes, audience: student ? 'student' : 'lecturer' } : null;
    const store = {
      get(key, fallback) {
        try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; }
      },
      set(key, value) {
        try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: kept in memory only */ }
      },
    };

    // ---- notes: written by Campus, saved to this device as PDF and .txt
    const notesKey = `campus-notes-${sid}-${student ? 'me' : 'lecturer'}`;
    let notes = store.get(notesKey, null);
    const showNotes = () => {
      const out = $('[data-notes-out]', root);
      if (!out || !notes) return;
      render(out, html`<div class="review-notes-ready"><div class="spread"><strong>${icon('check', 16)} Notes ready</strong>
          <span class="cluster"><button class="btn btn-sm btn-primary" data-save-pdf>${icon('download', 15)} Save PDF</button><button class="btn btn-sm" data-save-txt>${icon('download', 15)} Notes + record (.txt)</button></span></div>
        <details class="mt-8"><summary class="small">Read them here</summary><div class="prose mt-8">${markdown(notes.markdown)}</div></details></div>`);
    };
    showNotes();
    const pdfOfNotes = () => savePdf({ markdown: notes.markdown, name: notes.name, subtitle, kicker: student ? 'Campus OS · My lecture notes' : 'Campus OS · Lecture notes and teaching review', figure });

    // ---- the conversation with Campus about the lecture (lecturer)
    const chatKey = `campus-review-chat-${sid}`;
    let chat = store.get(chatKey, []);
    const showChat = (pending = '') => {
      const log = $('[data-log]', root);
      if (!log) return;
      render(log, html`${chat.map((m, i) => (m.role === 'user'
        ? html`<div class="coach-msg is-me">${m.content}</div>`
        : html`<div class="coach-msg"><div class="prose">${markdown(m.content)}</div><div class="cluster mt-8"><button class="btn btn-sm btn-ghost" data-coach-pdf="${i}">${icon('download', 14)} Save as PDF</button></div></div>`))}
        ${pending ? html`<div class="coach-msg is-me">${pending}</div><div class="coach-msg"><span class="typing"><i></i><i></i><i></i></span></div>` : ''}`);
      $('[data-ideas]', root)?.toggleAttribute('hidden', chat.length > 0 || !!pending);
      log.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    showChat();
    let talking = false;
    const coach = async (message) => {
      if (talking || !message.trim()) return;
      talking = true;
      showChat(message);
      try {
        const r = await api.post(`/live/sessions/${sid}/review-chat`, { message, history: chat });
        chat = [...chat, { role: 'user', content: message }, { role: 'assistant', content: r.answer }].slice(-24);
        store.set(chatKey, chat);
      } catch (error) {
        toastError(error);
      } finally {
        talking = false;
        showChat();
      }
    };

    const offs = [
      on(root, 'click', '[data-make-notes]', (e, button) => busy(button, async () => {
        const out = $('[data-notes-out]', root);
        render(out, html`<p class="small muted"><span class="typing"><i></i><i></i><i></i></span> ${assistantName()} is writing the notes. This takes about half a minute.</p>`);
        try {
          notes = await api.post(`/live/sessions/${sid}/ai-notes`);
          store.set(notesKey, notes);
          showNotes();
          toast('Notes ready. Save them as PDF.', 'success', { duration: 2400 });
        } catch (error) {
          render(out, html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
        }
      })),
      on(root, 'click', '[data-save-pdf]', (e, button) => busy(button, async () => {
        try {
          await pdfOfNotes();
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'click', '[data-save-txt]', () => saveText(notes.txt, notes.name)),
      on(root, 'click', '[data-coach-ask]', (e, button) => {
        const form = $('[data-coach-form]', root);
        form?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        coach(button.dataset.coachAsk);
      }),
      on(root, 'submit', '[data-coach-form]', (e, form) => {
        e.preventDefault();
        const q = form.q.value.trim();
        form.q.value = '';
        coach(q);
      }),
      on(root, 'click', '[data-coach-pdf]', (e, button) => busy(button, async () => {
        const answer = chat[Number(button.dataset.coachPdf)];
        const asked = chat[Number(button.dataset.coachPdf) - 1]?.content || 'Notes';
        if (!answer) return;
        try {
          await savePdf({ markdown: answer.content, name: `${d.course.code}-${d.session.title}-improved`.replace(/[^\w-]+/g, '-'), title: /^#\s/m.test(answer.content) ? '' : asked.slice(0, 90), subtitle, kicker: `Campus OS · ${d.session.title}` });
        } catch (error) {
          toastError(error);
        }
      })),
      // A student asks Campus to explain one part they should work on.
      on(root, 'click', '[data-explain-part]', (e, button) => {
        const part = d.record.sections.find((s) => s.id === button.dataset.explainPart);
        if (!part) return;
        const how = part.youWorst === 3 ? 'I was lost there' : part.youWorst === 2 ? 'I was unsure there' : 'I flagged it';
        const q = `Explain part ${part.id} (${part.clock}, “${part.title}”) to me: ${how}. Start with what the lecturer was explaining, then a simple example and one check question.`;
        const form = $('[data-ask-form]', root);
        if (!form) {
          location.href = `/assistant?new=1&q=${encodeURIComponent(`${q} The lecture was “${d.session.title}” (${d.course.code}).`)}`;
          return;
        }
        form.q.value = q;
        form.scrollIntoView({ block: 'center', behavior: 'smooth' });
        form.requestSubmit();
      }),
      on(root, 'click', '[data-explain]', (e, button) => busy(button, async () => {
        const box = $(`[data-explanation="${button.dataset.explain}"]`, root);
        render(box, html`<span class="typing"><i></i><i></i><i></i></span>`);
        try {
          const r = await api.post(`/live/sessions/${sid}/flags/${button.dataset.explain}/explain`);
          render(box, markdown(r.explanation));
          button.remove();
        } catch (error) {
          render(box, '');
          toastError(error);
        }
      })),
      on(root, 'submit', '[data-ask-form]', async (e, form) => {
        e.preventDefault();
        const q = form.q.value.trim();
        if (!q) return;
        form.q.value = '';
        const box = $('[data-answer]', root);
        box.hidden = false;
        render(box, html`<p class="small muted">${q}</p><span class="typing"><i></i><i></i><i></i></span>`);
        try {
          const r = await api.post(`/live/sessions/${sid}/student-ask`, { question: q });
          render(box, html`<p class="small muted">${q}</p><div class="prose mt-8">${markdown(r.answer)}</div>`);
        } catch (error) {
          render(box, html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
        }
      }),
      on(root, 'click', '[data-forget]', async () => {
        if (!(await confirm({ title: 'Delete the transcript?', message: `${assistantName()} can no longer answer questions about this lecture. The flags and key points stay.`, confirmLabel: 'Delete', danger: true }))) return;
        try {
          await api.del(`/live/sessions/${sid}/transcript`);
          toast('Transcript deleted', 'success');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      clearInterval(poll);
    };
  },
};
