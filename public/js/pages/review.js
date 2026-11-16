/**
 * After a lecture (/lectures/review/:sessionId).
 *
 *   Lecturer  where it went wrong: the class's minute-by-minute understanding, the lecture part by part with its
 *             average, each stretch where students got lost with what was being said, the flags and key points.
 *             Citrus writes notes and a teaching review (PDF to the phone), and the lecturer talks it through with
 *             Citrus right here to improve the explanations and the notes.
 *   Student   a private recap: their own results part by part next to the class, the areas to target first, their
 *             flags explained, their own study notes (PDF), and one tap to a quiz or a question to the assistant.
 *
 * Every download also comes as a tagged .txt with instructions any AI can follow (src/modules/live/record.js).
 */
import { html, render, raw, $, on } from '../core/dom.js';
import { lectureChart, eventsBetween, eventText, mmss, COLORS } from '../features/lecture-chart.js';
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

/** Exact moments, in time order: what was said, every answer, flags, struggles, key points. */
function momentList(events) {
  if (!events.length) return html`<p class="small muted">Nothing was recorded here.</p>`;
  return html`<ol class="moment-list">${events.map((e) => {
    const x = eventText(e);
    return html`<li class="moment is-${e.kind}${x.tone ? ` tone-${x.tone}` : ''}"><span class="moment-time mono">${mmss(e.t)}</span><span class="moment-icon">${icon(x.icon, 14)}</span><span class="moment-text">${x.text}</span></li>`;
  })}</ol>`;
}

/** One part of the lecture: its time, what it was about, how the class (and the student) followed; opens to the exact moments. */
function sectionRow(s, record, student) {
  const [tone, word] = STATUS[s.status] || STATUS.quiet;
  const you = student && s.youWorst ? YOU[s.youWorst] : null;
  const moments = eventsBetween(record, s.from, s.to);
  return html`<details class="review-section ${s.followUp ? 'is-follow' : ''} ${student && s.target ? 'is-target' : ''}" data-part="${s.id}">
    <summary>
      <div class="spread"><strong>${s.id} · ${s.clock}</strong>
        <span class="cluster" style="--gap:6px">${student && s.target ? html`<span class="chip danger">${icon('target', 13)} Work on this</span>` : ''}${!student && s.followUp ? html`<span class="chip danger">Follow up</span>` : ''}<span class="chip ${tone}">${word}</span>${icon('chevron-down', 16)}</span></div>
      <p class="mt-4">${s.title}</p>
      <div class="review-meter" role="img" aria-label="${s.understood === null ? 'Too few answers' : `${s.understood}% understood`}"><i class="is-${s.status}" style="width:${s.understood ?? 0}%"></i></div>
      <p class="small muted mt-4">${s.understood === null ? 'Too few answers to tell' : `Class: ${s.understood}% understood${s.lowest !== null && s.lowest < s.understood ? `, lowest ${s.lowest}%` : ''}`}${s.flags ? ` · ${s.flags} ${s.flags === 1 ? 'flag' : 'flags'}` : ''}${you ? ` · ${you[1]}` : ''}</p>
    </summary>
    <div class="review-part-body">
      ${s.points.length > 1 ? html`<ul class="small review-points-mini">${s.points.slice(1).map((p) => html`<li>${p}</li>`)}</ul>` : ''}
      ${s.struggles.map((x) => html`<p class="small mt-4">${icon('alert', 13)} ${x.note || `${x.lost} of ${x.answered} lost`}</p>`)}
      <div class="cluster mt-8">${student
        ? (s.target ? html`<button class="btn btn-sm" data-explain-part="${s.id}">${icon('sparkle', 14)} Explain this part to me</button>` : '')
        : html`<button class="btn btn-sm" data-coach-ask="${`How could I explain ${s.id} (${s.clock}, “${s.title}”) better? Use what students flagged and what I said there.`}">${icon('campus', 14)} Ask ${assistantName()} about this part</button>`}</div>
      <p class="small mt-12"><strong>Exact moments</strong> <span class="muted">(${moments.length})</span></p>
      ${momentList(moments)}
    </div>
  </details>`;
}

function sectionsCard(record, student) {
  if (!record?.sections?.length) return '';
  const a = record.averages;
  return html`<section class="card flush"><div class="card-head"><h2>${student ? 'Your results, part by part' : 'Part by part'}</h2><span class="small muted">Open a part for the exact moments</span></div>
    ${student ? html`<div class="review-averages">
      <div><span class="review-big">${pct(a.you?.understood)}</span><span class="small muted">You understood</span></div>
      <div><span class="review-big">${pct(a.lecture.understood)}</span><span class="small muted">Class average</span></div>
      <div><span class="review-big">${record.targets.length}</span><span class="small muted">${record.targets.length === 1 ? 'Part to work on' : 'Parts to work on'}</span></div>
    </div>` : ''}
    <div class="list">${(student ? [...record.sections].sort((x, y) => (y.target ? 1 : 0) - (x.target ? 1 : 0) || x.from - y.from) : record.sections).map((s) => sectionRow(s, record, student))}</div></section>`;
}

/** The numbers first: how well the class understood, how many answered, flags, parts to follow up. */
function statsRow(d) {
  const r = d.record;
  const a = r.averages.lecture;
  const tile = (value, label, tone = '') => html`<div class="review-stat ${tone}"><span class="review-big">${value}</span><span class="small muted">${label}</span></div>`;
  return html`<section class="review-stats">
    ${tile(pct(a.understood), 'Understood, on average', a.status === 'quiet' ? '' : `is-${a.status}`)}
    ${tile(`${r.meta.answeredBy}${r.meta.enrolled ? `/${r.meta.enrolled}` : ''}`, 'Students answered')}
    ${tile(r.meta.flags, r.meta.flags === 1 ? 'Flag' : 'Flags', r.meta.flags ? 'is-flag' : '')}
    ${tile(r.followUps.length, r.followUps.length === 1 ? 'Part to follow up' : 'Parts to follow up', r.followUps.length ? 'is-trouble' : 'is-good')}
  </section>`;
}

/** The coloured chart: tap a minute or a part for the exact moments. */
function chartCard(record, student) {
  if (!record?.minutes?.length) return '';
  const legend = [['following', student ? 'Following' : 'Following'], ['unsure', 'Unsure'], ['lost', 'Lost'], ['flag', 'Flag']];
  return html`<section class="card review-chart-card">
    <div class="spread"><h2>${student ? 'You and the class, minute by minute' : 'How the class followed'}</h2><span class="small muted">Tap a minute or a part</span></div>
    <div class="lecture-chart-wrap">${raw(lectureChart(record, { student }))}</div>
    <div class="chart-legend">${legend.map(([k, label]) => html`<span><i style="background:${COLORS[k]}"></i>${label}</span>`)}<span><i class="is-band"></i>Parts, coloured by how the class followed</span></div>
    <div data-moment></div>
  </section>`;
}

/** Citrus's quick take: the basics, one click; then more detail or a conversation. */
function quickTakeCard(d) {
  const name = assistantName();
  return html`<section class="card stack quick-take">
    <div class="spread"><div><h2>${name}’s quick take</h2><p class="small muted">Only the points worth discussing, each with its time and part.</p></div>
      <button class="btn btn-primary" data-quick-take>${icon('sparkle', 16)} What should I discuss?</button></div>
    <div data-quick-out></div>
    <div class="cluster" data-quick-next hidden>
      <button class="btn btn-sm" data-go-notes>${icon('file', 15)} More detail: notes and review (PDF)</button>
      <button class="btn btn-sm" data-go-coach>${icon('message', 15)} Talk it through</button>
      <a class="btn btn-sm btn-ghost" href="${askCampusHref(d)}">${icon('campus', 15)} Continue in Ask ${name}</a>
    </div>
  </section>`;
}

const askCampusHref = (d) => `/assistant?new=1&lecture=${d.session.id}&q=${encodeURIComponent(`About my lecture “${d.session.title}” (${d.course.code}, ${dateTime(d.session.started)}): what went well, what did not, and what should I improve?`)}`;

/** Students who chose to show their name: what each struggled with, and ways to help them personally. */
function studentsCard(record) {
  const list = record.students || [];
  const title = (id) => record.sections.find((s) => s.id === id);
  return html`<section class="card flush"><div class="card-head"><h2>Students who shared their name</h2><span class="chip">${list.length}</span></div>
    ${list.length ? html`<div class="list">${list.map((st) => {
      const first = st.name.split(' ')[0];
      const parts = st.targets.map(title).filter(Boolean);
      const mail = `mailto:${encodeURIComponent(st.email || '')}?subject=${encodeURIComponent(`${record.meta.title}: shall we go through it?`)}&body=${encodeURIComponent(`Hi ${first},\n\nthank you for sharing how you followed "${record.meta.title}". ${parts.length ? `I saw that ${parts.map((p) => `${p.id} (${p.clock}, ${p.title})`).join(' and ')} ${parts.length === 1 ? 'was' : 'were'} hard to follow.` : ''} If you like, we can go through it together after the next lecture.\n\nBest regards`)}`;
      return html`<div class="review-student">
        <div class="spread"><strong>${st.name}</strong><span class="chip ${st.understood === null ? 'outline' : st.understood <= 60 ? 'danger' : st.understood <= 80 ? 'warning' : 'success'}">${st.understood === null ? 'No answers' : `${st.understood}% understood`}</span></div>
        ${parts.length ? html`<div class="cluster mt-8" style="--gap:6px"><span class="small muted">Needs help with</span>${parts.map((p) => html`<span class="chip danger">${p.id} · ${p.clock}</span>`)}</div>` : html`<p class="small muted mt-4">Followed without trouble.</p>`}
        ${st.flags.length ? html`<ul class="small review-points-mini">${st.flags.map((f) => html`<li><span class="mono">${mmss(f.t)}</span> ${f.section} · ${FLAG_NAMES[f.flag] || f.flag}${f.note ? `: “${f.note}”` : ''}</li>`)}</ul>` : ''}
        <div class="cluster mt-8">
          <button class="btn btn-sm" data-student-notes="${st.id}" data-name="${first}">${icon('sparkle', 14)} Notes for ${first} (PDF)</button>
          <button class="btn btn-sm" data-student-talk="${st.id}" data-name="${first}">${icon('message', 14)} Ask to talk after class</button>
          ${st.email ? html`<a class="btn btn-sm btn-ghost" href="${mail}">${icon('send', 14)} Email</a>` : ''}
          <button class="btn btn-sm btn-ghost" data-coach-ask="${`${st.name} chose to show their name. What did ${first} struggle with, and how could I help ${first} personally?`}">${icon('campus', 14)} Ask about ${first}</button>
        </div>
      </div>`;
    })}</div>` : html`<p class="small muted" style="padding:0 20px 18px">No one chose to show their name in this lecture. Students can turn it on during the lecture or on their recap; everyone else stays anonymous.</p>`}
  </section>`;
}

const FLAG_NAMES = { confused: 'didn’t get this', fast: 'too fast', example: 'needs an example', question: 'a question' };

/** Every download in one place. Every .txt explains itself to any AI. */
function downloadsCard(d) {
  const s = d.session;
  const row = (glyph, title, sub, action) => html`<div class="list-row"><span class="tile">${icon(glyph, 18)}</span><span class="body"><span class="title">${title}</span><span class="sub">${sub}</span></span><span class="trail">${action}</span></div>`;
  return html`<section class="card flush"><div class="card-head"><h2>Downloads</h2></div>
    <p class="small muted" style="padding:0 20px 8px">Every .txt starts with instructions, so ChatGPT, Claude, Gemini or any other AI can use it as it is.</p>
    <div class="list">
      ${s.keepTranscript && d.stored ? row('file', 'Transcript (.txt)', `What you said, by time and part · ${d.stored} lines`, html`<span class="cluster" style="--gap:4px"><a class="btn btn-sm" href="/api/live/sessions/${s.id}/transcript.txt" download>${icon('download', 15)} Download</a><button class="btn btn-sm btn-ghost btn-icon" data-forget aria-label="Delete the transcript" title="Delete the transcript">${icon('trash', 15)}</button></span>`)
        : row('file', 'Transcript', s.keepTranscript ? 'Nothing was heard during this lecture.' : 'The transcript of this lecture was not kept.', '')}
      ${d.recording ? row('mic', 'Recording (audio)', `Recorded by the Citrus app · ${Math.round(d.recording.seconds / 60)} min`, html`<a class="btn btn-sm" href="/api/live/sessions/${s.id}/recording.aac" download>${icon('download', 15)} Download</a>`) : ''}
      ${row('cpu', 'Lecture record for AI (.txt)', 'Everything that happened, every result and average tagged with its time and part', html`<a class="btn btn-sm" href="/api/live/sessions/${s.id}/record.txt" download>${icon('download', 15)} Download</a>`)}
      ${row('sparkle', 'Notes and teaching review (PDF)', `Written by ${assistantName()}, saved to this device`, html`<button class="btn btn-sm" data-go-notes>${icon('sparkle', 15)} Make</button>`)}
    </div></section>`;
}

/** A student chooses whether the lecturer sees their name with their answers. */
function shareCard(d) {
  return html`<section class="card"><label class="spread live-keep"><span><strong>Show my name to the lecturer</strong><br>
    <span class="small muted">Your lecturer then sees your answers and flags with your name, so they can help you personally: notes for you, or a word after class. Off: they only see totals.</span></span>
    <span class="switch"><input type="checkbox" data-share ${d.shareName ? 'checked' : ''}><span></span></span></label></section>`;
}

/** Notes Citrus writes from the record, and the record itself, saved to this device. */
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

/** The lecturer and Citrus, in the review: why parts did not land, better explanations, improved notes. */
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

const isLecturer = () => session.user.role !== 'student';

const keyPoints = (points) => (points.length
  ? html`<section class="card"><h3>Key points</h3><ul class="review-points">${points.map((p) => html`<li><span class="chip outline">${p.minute} min</span> ${p.text}</li>`)}</ul></section>`
  : '');

/**
 * The lecturer's review, in the order they need it: the numbers, the chart (tap for the exact moments), Citrus's
 * quick take, the lecture part by part, students who shared their name, the conversation with Citrus, notes and
 * downloads. "Ask Citrus" in the header continues in the general assistant with this lecture.
 */
function lecturerView(d) {
  const { session: s, course } = d;
  return html`${pageHead({ back: { href: '/lectures', label: 'Lectures' }, title: s.title, subtitle: `${course.code} · ${dateTime(s.started)}${d.record ? ` · ${d.record.meta.duration.replace(/^00:/, '')}` : ''}`, actions: html`<a class="btn" href="${askCampusHref(d)}">${icon('campus', 16)} Ask ${assistantName()}</a>` })}
    <div class="stack stagger review-page">
      ${statsRow(d)}
      ${chartCard(d.record, false)}
      ${quickTakeCard(d)}
      ${sectionsCard(d.record, false)}
      ${studentsCard(d.record)}
      ${coachCard()}
      ${notesCard(d, false)}
      ${downloadsCard(d)}
    </div>`;
}

const flagLabel = (kind) => (FLAGS[kind] || FLAGS.confused)[0];

const liveAgain = (courseId) => html`<a class="notice accent live-again" href="/live/${courseId}" style="text-decoration:none;margin-bottom:16px" data-live-again>${icon('presentation', 18)}<span><strong>This lecture is live again.</strong> Tap to rejoin.</span><span class="btn btn-sm btn-primary" style="margin-left:auto">Rejoin</span></a>`;


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
      ${signals ? chartCard(d.record, true) : html`<section class="card"><h3>How you followed</h3><p class="small muted mt-8">You didn’t answer during this lecture. Next time, tap how you’re following and this recap will show where you got stuck.</p></section>`}
      ${signals ? html`<p class="small muted" style="margin-top:-8px">Only you can see your own row. The bars are the whole class, without names.</p>` : ''}
      ${signals || d.flags?.length ? sectionsCard(d.record, true) : ''}
      ${shareCard(d)}
      ${notesCard(d, true)}
      ${myFlags(d.flags)}
      ${askLecture(d)}
      ${stuck.length ? html`<section class="card flush"><div class="card-head"><h2>Where the class got stuck</h2></div>
        <div class="list">${stuck.map((m) => html`<div class="review-moment"><div class="spread"><strong>Minute ${m.minute}</strong>${m.you ? html`<span class="chip ${m.you === 3 ? 'danger' : 'warning'}">${m.you === 3 ? 'You were lost too' : 'You were unsure too'}</span>` : ''}</div>${m.note ? html`<p class="mt-8">${m.note}</p>` : ''}</div>`)}</div></section>` : ''}
      ${keyPoints(points)}
      ${points.length || stuck.length ? html`<section class="card"><h3>Review</h3>
        <div class="cluster mt-8"><a class="btn btn-primary" href="/quiz/new?topic=${encodeURIComponent(topic)}&count=6">${icon('target', 16)} Quiz me on this lecture</a>
        <a class="btn" href="/assistant?new=1&q=${encodeURIComponent(`Help me review the lecture “${s.title}”. ${points.map((p) => p.text).join(' ')}`)}">${icon('campus', 16)} Ask Citrus</a></div></section>` : ''}
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
    // Opened at one part (?part=P3, from the term overview or My progress): open it and bring it into view.
    const linked = /^P\d{1,3}$/.test(ctx.query.get('part') || '') ? root.querySelector(`details[data-part="${ctx.query.get('part')}"]`) : null;
    if (linked) {
      linked.open = true;
      linked.classList.add('is-linked');
      requestAnimationFrame(() => linked.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
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

    // ---- notes: written by Citrus, saved to this device as PDF and .txt
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
    const pdfOfNotes = () => savePdf({ markdown: notes.markdown, name: notes.name, subtitle, kicker: student ? 'Citrus · My lecture notes' : 'Citrus · Lecture notes and teaching review', figure });

    // ---- the conversation with Citrus about the lecture (lecturer)
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

    // ---- the chart: a minute or a part opens the exact moments
    const record = d.record;
    const clearMinute = () => root.querySelectorAll('.lc-min.is-selected').forEach((g) => g.classList.remove('is-selected'));
    const showMinute = (minute) => {
      const box = $('[data-moment]', root);
      const m = record?.minutes?.[minute - 1];
      if (!box || !m) return;
      clearMinute();
      root.querySelector(`.lc-min[data-minute="${minute}"]`)?.classList.add('is-selected');
      render(box, html`<div class="moment-panel">
        <div class="spread"><strong>Minute ${minute} · ${m.section}</strong><button class="btn btn-ghost btn-icon btn-sm" data-close-moment aria-label="Close">${icon('x', 16)}</button></div>
        <p class="small mt-4">${m.answered ? `${m.following} following · ${m.unsure} unsure · ${m.lost} lost · ${m.understood}% understood` : 'Nobody answered in this minute.'}${student && m.you ? ` · you: ${['', 'following', 'unsure', 'lost'][m.you]}` : ''}</p>
        ${momentList(eventsBetween(record, (minute - 1) * 60, minute * 60))}
        ${student ? '' : html`<button class="btn btn-sm mt-8" data-coach-ask="${`What happened at minute ${minute} (${m.section})? Why did the class react like that, and how should I explain it next time?`}">${icon('campus', 14)} Ask ${assistantName()} about this minute</button>`}
      </div>`);
    };
    const openPart = (id) => {
      const part = $(`details[data-part="${id}"]`, root);
      if (!part) return;
      part.open = true;
      part.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };

    // ---- Citrus's quick take (lecturer): the basics first
    const quickKey = `campus-quick-${sid}`;
    const showQuick = (markdownText) => {
      const out = $('[data-quick-out]', root);
      if (!out || !markdownText) return;
      render(out, html`<div class="prose">${markdown(markdownText)}</div>`);
      $('[data-quick-next]', root)?.removeAttribute('hidden');
      const button = $('[data-quick-take]', root);
      if (button) render(button, html`${icon('refresh', 16)} Again`);
    };
    showQuick(store.get(quickKey, ''));

    const offs = [
      on(root, 'click', '[data-minute]', (e, g) => showMinute(Number(g.dataset.minute))),
      on(root, 'click', '[data-section]', (e, g) => openPart(g.dataset.section)),
      on(root, 'keydown', '[data-section]', (e, g) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openPart(g.dataset.section);
      }),
      on(root, 'click', '[data-close-moment]', () => {
        render($('[data-moment]', root), '');
        clearMinute();
      }),
      on(root, 'click', '[data-quick-take]', (e, button) => busy(button, async () => {
        render($('[data-quick-out]', root), html`<p class="small muted"><span class="typing"><i></i><i></i><i></i></span> ${assistantName()} is looking at the lecture…</p>`);
        try {
          const r = await api.post(`/live/sessions/${sid}/quick-take`);
          store.set(quickKey, r.markdown);
          showQuick(r.markdown);
        } catch (error) {
          render($('[data-quick-out]', root), html`<div class="notice danger">${icon('alert', 18)}<span>${error.message}</span></div>`);
        }
      })),
      on(root, 'click', '[data-go-notes]', () => {
        const button = $('[data-make-notes]', root);
        button?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (button && !notes) button.click();
      }),
      on(root, 'click', '[data-go-coach]', () => {
        const form = $('[data-coach-form]', root);
        form?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        form?.q.focus({ preventScroll: true });
      }),
      // Personal help for a student who showed their name.
      on(root, 'click', '[data-student-notes]', (e, button) => busy(button, async () => {
        try {
          const r = await api.post(`/live/sessions/${sid}/ai-notes`, { student_id: Number(button.dataset.studentNotes) });
          await savePdf({ markdown: r.markdown, name: r.name, subtitle, kicker: `Citrus · Notes for ${button.dataset.name}` });
          toast(`Notes for ${button.dataset.name} saved. Send them by email or hand them over.`, 'success', { duration: 3600 });
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'click', '[data-student-talk]', (e, button) => busy(button, async () => {
        try {
          await api.post(`/live/sessions/${sid}/students/${button.dataset.studentTalk}/message`, { text: `Could we talk briefly after the next lecture about “${d.session.title}”? I’d like to go through the part that was hard with you.` });
          toast(`${button.dataset.name} gets a notification.`, 'success');
        } catch (error) {
          toastError(error);
        }
      })),
      // A student shows or hides their name.
      on(root, 'change', '[data-share]', async (e, input) => {
        try {
          const r = await api.post(`/live/sessions/${sid}/share`, { share: input.checked });
          toast(r.share ? 'Your lecturer can now see your name with your answers and flags.' : 'Your name is hidden again.', 'success');
        } catch (error) {
          input.checked = !input.checked;
          toastError(error);
        }
      }),
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
          await savePdf({ markdown: answer.content, name: `${d.course.code}-${d.session.title}-improved`.replace(/[^\w-]+/g, '-'), title: /^#\s/m.test(answer.content) ? '' : asked.slice(0, 90), subtitle, kicker: `Citrus · ${d.session.title}` });
        } catch (error) {
          toastError(error);
        }
      })),
      // A student asks Citrus to explain one part they should work on.
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
        if (!(await confirm({ title: 'Delete the transcript?', message: `${assistantName()} can no longer answer questions about this lecture${data.data.recording ? ', and the recording is deleted too' : ''}. The flags and key points stay.`, confirmLabel: 'Delete', danger: true }))) return;
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
