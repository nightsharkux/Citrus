/** Home: a calm overview with one gradient hero, quick actions and what's next. */
import { html, $, $$, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, firstName, assistantName } from '../core/store.js';
import { greeting, time, dayLabel, ago, plural, dayKey, humanize } from '../core/format.js';
import { row, empty, courseTile } from '../core/components.js';
import { countUp, toast, toastError } from '../core/ui.js';
import { debounce } from '../core/live.js';
import { createFace, watchTyping } from '../features/face.js';
import { whenLine } from './lectures.js';

const soft = (promise, fallback) => promise.catch(() => fallback);
const DAY = 86_400_000;

async function load() {
  const role = session.user.role;
  const now = Date.now();
  const schedule = soft(api.get(`/timetable?from=${new Date(now - 3 * 3_600_000).toISOString()}&to=${new Date(now + 2 * DAY).toISOString()}`), { events: [] });
  if (role === 'admin') {
    const [overview, events] = await Promise.all([api.get('/admin/overview'), schedule]);
    return { role, overview, events: events.events };
  }
  const shared = [schedule, soft(api.get('/courses'), { courses: [] }), soft(api.get('/participation'), { sessions: [] }), soft(api.get('/connect/posts'), { posts: [] }), soft(api.get('/lectures/feed?scope=mine'), { lectures: [] }), soft(api.get('/meetings'), { running: [], minutes: [] })];
  if (role === 'student') {
    const [events, courses, participation, feed, live, meetings, review] = await Promise.all([...shared, soft(api.get('/review'), { stats: { dueNow: 0 }, due: [] })]);
    return { role, events: events.events, courses: courses.courses.filter((c) => c.enrolled), participation: participation.sessions, posts: feed.posts, live, meetings, review };
  }
  const [events, courses, participation, feed, live, meetings, activations] = await Promise.all([...shared, soft(api.get('/activations'), { activations: [] })]);
  return { role, events: events.events, courses: courses.courses, participation: participation.sessions, posts: feed.posts, live, meetings, activations: activations.activations };
}

function heroFor(data) {
  const now = Date.now();
  const today = dayKey(new Date().toISOString());
  const upcoming = (data.events || []).filter((e) => new Date(e.ends).getTime() > now);
  const todays = (data.events || []).filter((e) => dayKey(e.starts) === today && e.kind !== 'personal');
  const next = upcoming[0];

  if (data.role === 'admin') {
    const p = data.overview.people;
    const total = p.students + p.lecturers + p.admins;
    return { figure: total, unit: total === 1 ? 'person' : 'people', line: `${p.activeWeek} active this week · ${p.lecturers} ${p.lecturers === 1 ? 'lecturer' : 'lecturers'}` };
  }
  const nextLine = next
    ? `Next: ${next.title} · ${dayLabel(next.starts) === 'Today' ? '' : `${dayLabel(next.starts)} `}${time(next.starts)}${next.location ? ` · ${next.location}` : ''}`
    : 'Nothing else scheduled — a good time to review.';
  if (!todays.length) return { figure: 'Free', unit: 'today', line: nextLine, plain: true };
  return { figure: todays.length, unit: data.role === 'lecturer' ? (todays.length === 1 ? 'session today' : 'sessions today') : (todays.length === 1 ? 'class today' : 'classes today'), line: nextLine };
}

function quickActions(data) {
  if (data.role === 'admin') {
    const p = data.overview.pending;
    return [
      ['/admin/people?tab=requests', 'user-plus', 'Approvals', p.lecturers],
      ['/admin/moderation', 'flag', 'Moderate', p.posts + p.reports],
      ['/admin/ai', 'cpu', 'Knowledge', 0],
      ['/admin/devices', 'radio', 'Devices', 0],
      ['/sign', 'moon', 'Study sign', 0],
      ['/assistant', 'campus', 'Ask', 0],
    ];
  }
  const openSessions = (data.participation || []).filter((s) => s.open && !s.mine).length;
  if (data.role === 'lecturer') {
    return [
      ['/lectures', 'presentation', 'Go live', 0],
      ['/participation?new=1', 'nfc', 'Check-in', 0],
      ['/meetings', 'message', 'Meeting', (data.meetings?.running || []).length],
      ['/courses', 'trending', 'How it went', 0],
      ['/sign', 'moon', 'Study sign', 0],
      ['/assistant', 'campus', 'Ask', 0],
    ];
  }
  return [
    ['/join', 'presentation', 'Join lecture', 0],
    ['/participation', 'nfc', 'Check in', openSessions],
    ['/learning', 'trending', 'My progress', data.review?.stats?.dueNow || 0],
    ['/meetings', 'message', 'Meeting', (data.meetings?.running || []).length],
    ['/sign', 'moon', 'Study sign', 0],
    ['/assistant', 'campus', 'Ask', 0],
  ];
}

function eventRow(e) {
  const kindTone = { exam: 'danger', deadline: 'warning', personal: 'neutral', event: 'info' }[e.kind] || '';
  return row({
    href: e.course ? `/courses/${e.course.id}` : '/schedule',
    tile: html`<span class="tile ${kindTone}" style="flex-direction:column;gap:0;line-height:1.05"><b style="font-size:13px">${time(e.starts)}</b></span>`,
    title: e.title,
    sub: [dayLabel(e.starts), e.location, e.course?.code].filter(Boolean).join(' · '),
    chevron: false,
    trail: e.kind !== 'lecture' ? html`<span class="chip ${kindTone}">${humanize(e.kind)}</span>` : '',
  });
}

function upNext(data) {
  const upcoming = (data.events || []).filter((e) => new Date(e.ends).getTime() > Date.now()).slice(0, 4);
  return html`<section class="card flush">
    <div class="card-head"><h2>Up next</h2><a class="btn btn-sm btn-ghost" href="/schedule">Schedule ${icon('chevron-right', 16)}</a></div>
    ${upcoming.length ? html`<div class="list" style="padding-bottom:8px">${upcoming.map(eventRow)}</div>`
      : empty({ icon: 'calendar', title: 'Nothing coming up', body: data.role === 'student' ? 'When your lecturers publish sessions, they appear here.' : 'Add your teaching sessions so students see them.', action: html`<a class="btn btn-sm" href="/schedule?new=1">${icon('plus', 16)} Add to schedule</a>` })}
  </section>`;
}

function assistantCard() {
  const name = assistantName();
  const ready = session.ai?.aiEnabled;
  return html`<section class="card assistant-teaser">
    <div class="spread"><div><h2>Ask ${name}</h2><p class="muted small">${ready ? 'Your courses, schedule and campus — just ask.' : 'Citrus is asleep until an AI model is connected.'}</p></div><span data-home-face></span></div>
    <form class="ask-pill mt-16" id="home-ask">
      <input name="q" placeholder="${ready ? 'What’s on my plate this week?' : 'Ask anything'}" aria-label="Ask ${name}" autocomplete="off">
      <button class="btn btn-primary btn-icon btn-sm" aria-label="Ask">${icon('arrow-up', 16)}</button>
    </form>
  </section>`;
}

/**
 * Lectures: the one live now first, then what is coming up, with date, time and room. For a student a live lecture
 * shows the three "how am I following" buttons right here, so answering takes one tap and no navigation. A live
 * lecture is marked with a small dot only.
 */
const SIGNALS = [[1, 'Following'], [2, 'Unsure'], [3, 'Lost']];
function lecturesCard(feed) {
  const items = (feed?.lectures || []).filter((l) => l.state !== 'past').slice(0, 3);
  const lecturer = session.user.role !== 'student';
  const action = (l) => (lecturer ? html`<a class="btn btn-sm ${l.state === 'live' ? 'btn-primary' : ''}" href="/live/${l.course.id}${l.state === 'live' ? '' : `?lecture=${l.id}`}" data-start="${l.state === 'live' ? '' : l.id}" data-course="${l.course.id}">${l.state === 'live' ? 'Resume' : 'Start'}</a>` : '');
  const quick = (l) => (!lecturer && l.state === 'live' && l.enrolled ? html`<div class="quick-signal" data-session="${l.liveSession}" role="group" aria-label="How are you following?">${SIGNALS.map(([level, label]) => html`<button type="button" class="chip-btn quick-signal-${level}" data-quick="${level}">${label}</button>`)}</div>` : '');
  return html`<section class="card flush lectures-card"><div class="card-head"><h2>Lectures</h2><a class="btn btn-sm btn-ghost" href="/lectures">All ${icon('chevron-right', 16)}</a></div>
    ${items.length ? html`<div class="list" style="padding-bottom:8px">${items.map((l) => html`<div class="list-row lecture-home-row">${courseTile(l.course.code)}
      <a class="body" href="${l.state === 'live' && !lecturer ? `/live/${l.course.id}` : '/lectures'}" style="color:inherit;text-decoration:none"><span class="title">${l.topic}${l.state === 'live' ? html` <span class="chip success"><span class="dot live"></span>Live</span>` : ''}</span><span class="sub">${whenLine(l)} · ${l.course.code}</span></a>
      <span class="trail">${action(l)}</span>${quick(l)}</div>`)}</div>`
      : html`<p class="muted small" style="padding:0 20px 18px">${lecturer ? html`Nothing scheduled. <a href="/lectures">Go live</a> in one of your courses, or schedule a lecture.` : html`No lectures coming up in your courses. In a lecture room? <a href="/join">Join with the code</a>.`}</p>`}
  </section>`;
}

/**
 * What Citrus is for, once, for new people: the classroom loop in three lines. Dismissed for good on this device.
 */
const INTRO_KEY = 'campus-intro-dismissed';
function introCard(role) {
  try {
    if (localStorage.getItem(INTRO_KEY)) return '';
  } catch {
    /* no storage: show it */
  }
  const lines = role === 'student'
    ? [['presentation', 'In lectures', 'Tell your lecturer how you’re following and flag the moments you need help with. Nobody sees your name.'],
      ['trending', 'Afterwards', 'See where you got stuck, get each flag explained and practise it.'],
      ['nfc', 'Check in', 'Tap your student ID on the reader, or type the code.']]
    : [['presentation', 'While you teach', 'See live how the class follows, on screen and on the Citrus Puck, and explain again when it turns red.'],
      ['trending', 'Afterwards', 'Review where the class struggled and what was being said, to improve the explanation.'],
      ['nfc', 'Participation', 'Students tap their student ID; you confirm.']];
  return html`<section class="card intro-card" data-intro>
    <div class="spread"><h2>What Citrus does</h2><button class="btn btn-ghost btn-icon btn-sm" data-intro-close aria-label="Got it">${icon('x', 16)}</button></div>
    <div class="intro-grid">${lines.map(([glyph, title, body]) => html`<div><span class="tile accent">${icon(glyph, 18)}</span><strong>${title}</strong><span class="small muted">${body}</span></div>`)}</div>
    <p class="small muted mt-8">On the side, ask Citrus anything about your courses and the university. Everything else is under <a href="/tools">All tools</a>.</p>
  </section>`;
}

/** Meeting mode: running meetings to join, or start one. */
function meetingCard(meetings) {
  const running = meetings?.running || [];
  return html`<section class="card meeting-card">
    <div class="spread"><div><h2>Meetings</h2><p class="small muted">${running.length ? `${running.length === 1 ? 'A meeting is' : `${running.length} meetings are`} running in your spaces.` : 'Citrus writes the minutes while you talk.'}</p></div>
      <a class="btn btn-sm btn-primary" href="/meetings">${icon('play', 14)} Start</a></div>
    ${running.length ? html`<div class="list mt-8">${running.slice(0, 2).map((m) => html`<a class="list-row" href="/spaces/${m.space.id}/meeting"><span class="tile accent">${icon('message', 16)}</span><span class="body"><span class="title">${m.space.title}</span><span class="sub">Started by ${m.by || 'a member'} ${ago(m.started)}</span></span><span class="trail"><span class="chip success"><span class="dot live"></span>Join</span></span></a>`)}</div>` : ''}
  </section>`;
}

/** Recent finished lectures: a student catches up on them (their own recap, a quiz); a lecturer sees where the class got lost. */
function lastLecturesCard(feed) {
  const lecturer = session.user.role !== 'student';
  const past = (feed?.lectures || []).filter((l) => l.state === 'past' && l.lastSession).slice(0, 3);
  if (!past.length) return '';
  return html`<section class="card flush"><div class="card-head"><h2>${lecturer ? 'How it went' : 'Catch up'}</h2><a class="btn btn-sm btn-ghost" href="/lectures">All ${icon('chevron-right', 16)}</a></div>
    <div class="list" style="padding-bottom:8px">${past.map((l) => html`<div class="list-row">${courseTile(l.course.code)}
      <a class="body" href="/lectures/review/${l.lastSession}" style="color:inherit;text-decoration:none"><span class="title">${l.topic}</span><span class="sub">${lecturer ? (l.struggles ? `The class got lost ${l.struggles === 1 ? 'once' : `${l.struggles} times`}` : 'No trouble spots') : whenLine(l)}</span></a>
      <span class="trail"><a class="btn btn-sm" href="/lectures/review/${l.lastSession}">${lecturer ? 'Review' : 'Recap'}</a></span></div>`)}</div></section>`;
}

function studentBody(data) {
  const due = data.review.stats.dueNow;
  const open = data.participation.filter((s) => s.open && !s.mine);
  return html`
    ${open.length ? html`<a class="notice accent" href="/participation/${open[0].id}" style="text-decoration:none">${icon('clipboard', 18)}<span><strong>${open[0].code} check-in is open.</strong> ${open[0].title}${open[0].room ? ` · ${open[0].room}` : ''}. Tap to check in.</span></a>` : ''}
    ${introCard('student')}
    <div class="home-grid">
      <div class="stack">${lastLecturesCard(data.live) || upNext(data)}</div>
      <div class="stack">
        ${meetingCard(data.meetings)}
        <section class="card">
          <div class="spread"><div><div class="stat-value" data-count="${due}">${due}</div><div class="stat-label">${due === 1 ? 'card to review' : 'cards to review'}</div></div><span class="tile lg success">${icon('graduation', 26)}</span></div>
          <a class="btn ${due ? 'btn-primary' : ''} btn-block mt-16" href="/learning">${due ? 'Start review' : 'Open review'}</a>
        </section>
        <section class="card flush">
          <div class="card-head"><h2>Courses</h2><a class="btn btn-sm btn-ghost" href="/courses">All ${icon('chevron-right', 16)}</a></div>
          ${data.courses.length ? html`<div class="list" style="padding-bottom:8px">${data.courses.slice(0, 4).map((c) => row({ href: `/courses/${c.id}`, tile: courseTile(c.code), title: c.title, sub: c.lecturer || c.code }))}</div>`
            : empty({ icon: 'book', title: 'No courses yet', action: html`<a class="btn btn-sm btn-primary" href="/courses">Browse courses</a>` })}
        </section>
      </div>
    </div>`;
}

function lecturerBody(data) {
  const pending = data.activations.filter((a) => a.status === 'pending');
  const recent = data.participation.slice(0, 3);
  return html`
    ${pending.map((a) => html`<a class="notice accent" href="/classroom?activation=${a.id}" style="text-decoration:none">${icon('nfc', 18)}<span><strong>Confirm sign-in at ${a.room || a.device}.</strong> You tapped your card. Tap here to start the session.</span></a>`)}
    ${introCard('lecturer')}
    <div class="home-grid">
      <div class="stack">${lastLecturesCard(data.live) || upNext(data)}</div>
      <div class="stack">
        ${meetingCard(data.meetings)}
        <section class="card flush">
          <div class="card-head"><h2>Your courses</h2><a class="btn btn-sm btn-ghost" href="/courses">All ${icon('chevron-right', 16)}</a></div>
          ${data.courses.length ? html`<div class="list" style="padding-bottom:8px">${data.courses.slice(0, 5).map((c) => row({ href: `/courses/${c.id}`, tile: courseTile(c.code), title: c.title, sub: `${c.code} · ${plural(c.enrolled_count || 0, 'student')}` }))}</div>`
            : empty({ icon: 'book', title: 'No courses yet', body: 'Create your first course. Students can find it and join it themselves.', action: html`<a class="btn btn-sm btn-primary" href="/courses">Create a course</a>` })}
        </section>
        <section class="card flush">
          <div class="card-head"><h2>Recent check-ins</h2><a class="btn btn-sm btn-ghost" href="/participation">All ${icon('chevron-right', 16)}</a></div>
          ${recent.length ? html`<div class="list" style="padding-bottom:8px">${recent.map((s) => row({ href: `/participation/${s.id}`, icon: 'clipboard', tone: s.open ? 'success' : 'neutral', title: s.title, sub: `${s.code} · ${plural(s.checkins, 'check-in')}`, trail: s.open ? html`<span class="chip success"><span class="dot live"></span>Open</span>` : '' }))}</div>`
            : empty({ icon: 'clipboard', title: 'No sessions yet', action: html`<a class="btn btn-sm btn-primary" href="/participation?new=1">Start a check-in</a>` })}
        </section>
      </div>
    </div>`;
}

function adminBody(data) {
  const o = data.overview;
  const attention = [
    o.pending.lecturers && row({ href: '/admin/people?tab=requests', icon: 'user-plus', tone: 'warning', title: `${plural(o.pending.lecturers, 'lecturer request')}`, sub: 'Verify staff before approving' }),
    o.pending.posts && row({ href: '/admin/moderation', icon: 'flag', tone: 'warning', title: `${plural(o.pending.posts, 'post')} waiting for review`, sub: 'Campus feed' }),
    o.pending.reports && row({ href: '/admin/moderation?tab=reports', icon: 'alert', tone: 'danger', title: `${plural(o.pending.reports, 'report')}`, sub: 'Reported posts' }),
    o.pending.suggestions && row({ href: '/admin/moderation?tab=feedback', icon: 'bulb', tone: 'info', title: `${plural(o.pending.suggestions, 'new suggestion')}`, sub: 'Feedback from users' }),
  ].filter(Boolean);
  return html`<div class="home-grid">
    <div class="stack">
      <section class="card flush"><div class="card-head"><h2>Needs attention</h2></div>
        ${attention.length ? html`<div class="list" style="padding-bottom:8px">${attention}</div>` : empty({ icon: 'check-circle', title: 'All clear', body: 'No approvals, posts or reports are waiting.' })}
      </section>
      ${upNext(data)}
    </div>
    <div class="stack">
      <section class="card flush"><div class="card-head"><h2>System</h2></div>
        <div class="list" style="padding-bottom:8px">
          ${row({ href: '/admin/ai', icon: 'cpu', tone: o.ai.aiEnabled ? 'success' : 'warning', title: 'AI provider', sub: o.ai.aiEnabled ? `${o.ai.label} · ${o.ai.model}` : o.ai.description })}
          ${row({ href: '/admin/ai', icon: 'library', title: 'Knowledge library', sub: `${plural(o.knowledge, 'entry', 'entries')}` })}
          ${row({ href: '/admin/devices', icon: 'radio', tone: o.devices.online ? 'success' : 'neutral', title: 'Classroom devices', sub: o.devices.total ? `${o.devices.online} of ${o.devices.total} online` : 'None registered' })}
          ${row({ href: '/courses', icon: 'book', title: 'Courses', sub: plural(o.courses, 'course') })}
        </div>
      </section>
      ${assistantCard()}
    </div>
  </div>`;
}

export default {
  title: 'Home',
  load,
  render(data) {
    const hero = heroFor(data);
    const subtitle = data.role === 'admin' ? session.user.institution : data.role === 'lecturer' ? 'Teaching overview' : session.user.institution;
    return html`
      <section class="hero home-hero">
        <div class="spread" style="align-items:flex-start">
          <div><p class="muted">${greeting()}, ${firstName()}</p><p class="muted small" style="opacity:.75">${subtitle}</p></div>
          ${session.user.requested_role === 'lecturer' ? html`<span class="chip">Lecturer access pending</span>` : ''}
        </div>
        <div class="hero-figure" style="margin-top:22px"><span ${typeof hero.figure === 'number' ? html`data-count="${hero.figure}"` : ''}>${hero.figure}</span><small>${hero.unit}</small></div>
        <p class="muted" style="margin-top:10px">${hero.line}</p>
      </section>
      <nav class="actions-row home-actions stagger" aria-label="Quick actions">
        ${quickActions(data).map(([href, glyph, label, count]) => html`<a class="action" href="${href}"><span class="action-circle">${icon(glyph, 22)}${count ? html`<span class="count">${count}</span>` : ''}</span>${label}</a>`)}
      </nav>
      <div class="stagger">${data.role === 'admin' ? '' : lecturesCard(data.live)}${data.role === 'admin' ? adminBody(data) : data.role === 'lecturer' ? lecturerBody(data) : studentBody(data)}</div>`;
  },
  mount(root, data, ctx) {
    $$('[data-count]', root).forEach((el) => countUp(el, Number(el.dataset.count)));
    const form = $('#home-ask', root);
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = e.target.q.value.trim();
      ctx.navigate(q ? `/assistant?q=${encodeURIComponent(q)}` : '/assistant');
    });
    // A small live Citrus that watches you type.
    const slot = $('[data-home-face]', root);
    const face = slot ? createFace({ size: 52, mood: session.ai?.aiEnabled ? 'idle' : 'asleep' }) : null;
    let unwatch = null;
    if (face) {
      slot.replaceWith(face.el);
      unwatch = watchTyping(form.q, face);
      face.el.addEventListener('click', () => ctx.navigate('/assistant'));
      face.el.style.cursor = 'pointer';
    }
    const refresh = debounce(ctx.refresh, 800);
    ctx.live.on('activation', refresh);
    ctx.live.on('participation.updated', refresh);
    ctx.live.on('live.started', refresh);
    ctx.live.on('live.ended', refresh);

    const offs = [
      on(root, 'click', '[data-intro-close]', () => {
        try {
          localStorage.setItem(INTRO_KEY, '1');
        } catch {
          /* fine: it shows again next time */
        }
        $('[data-intro]', root)?.remove();
      }),
      // Students answer "how am I following" with one tap, right here.
      on(root, 'click', '[data-quick]', async (e, button) => {
        const group = button.closest('[data-session]');
        try {
          await api.post(`/live/sessions/${group.dataset.session}/signal`, { level: Number(button.dataset.quick) });
          group.querySelectorAll('[data-quick]').forEach((b) => b.classList.toggle('is-active', b === button));
          navigator.vibrate?.(20);
          toast('Sent', 'success', { duration: 1200 });
        } catch (error) {
          toastError(error);
        }
      }),
      // A lecturer starts a scheduled lecture with one tap, without a form in between.
      on(root, 'click', '[data-start]', async (e, button) => {
        if (!button.dataset.start) return; // "Resume": follow the link
        e.preventDefault();
        button.disabled = true;
        try {
          await api.post('/live/sessions', { course_id: Number(button.dataset.course), lecture_id: Number(button.dataset.start) });
          ctx.navigate(`/live/${button.dataset.course}`);
        } catch (error) {
          button.disabled = false;
          toastError(error);
        }
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      unwatch?.();
      face?.destroy();
    };
  },
};
