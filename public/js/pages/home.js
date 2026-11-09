/** Home: a calm overview with one gradient hero, quick actions and what's next. */
import { html, $, $$ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, firstName, assistantName } from '../core/store.js';
import { greeting, time, dayLabel, ago, plural, dayKey, humanize } from '../core/format.js';
import { row, empty, courseTile } from '../core/components.js';
import { countUp } from '../core/ui.js';
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
  const shared = [schedule, soft(api.get('/courses'), { courses: [] }), soft(api.get('/participation'), { sessions: [] }), soft(api.get('/connect/posts'), { posts: [] }), soft(api.get('/lectures/feed?scope=mine'), { lectures: [] })];
  if (role === 'student') {
    const [events, courses, participation, feed, live, review] = await Promise.all([...shared, soft(api.get('/review'), { stats: { dueNow: 0 }, due: [] })]);
    return { role, events: events.events, courses: courses.courses.filter((c) => c.enrolled), participation: participation.sessions, posts: feed.posts, live, review };
  }
  const [events, courses, participation, feed, live, activations] = await Promise.all([...shared, soft(api.get('/activations'), { activations: [] })]);
  return { role, events: events.events, courses: courses.courses, participation: participation.sessions, posts: feed.posts, live, activations: activations.activations };
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
      ['/assistant', 'campus', 'Ask', 0],
    ];
  }
  const openSessions = (data.participation || []).filter((s) => s.open && !s.mine).length;
  if (data.role === 'lecturer') {
    return [
      ['/lectures', 'presentation', 'Lectures', 0],
      ['/participation?new=1', 'clipboard', 'Check-in', 0],
      ['/classroom', 'door', 'Room status', 0],
      ['/schedule', 'calendar', 'Schedule', 0],
      ['/assistant', 'campus', 'Ask', 0],
    ];
  }
  return [
    ['/participation', 'clipboard', 'Check in', openSessions],
    ['/lectures', 'presentation', 'Lectures', 0],
    ['/learning', 'graduation', 'Review', data.review?.stats?.dueNow || 0],
    ['/schedule', 'calendar', 'Schedule', 0],
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
    <div class="spread"><div><h2>Ask ${name}</h2><p class="muted small">${ready ? 'Your courses, schedule and campus — just ask.' : 'Campus is asleep until an AI model is connected.'}</p></div><span data-home-face></span></div>
    <form class="ask-pill mt-16" id="home-ask">
      <input name="q" placeholder="${ready ? 'What’s on my plate this week?' : 'Ask anything'}" aria-label="Ask ${name}" autocomplete="off">
      <button class="btn btn-primary btn-icon btn-sm" aria-label="Ask">${icon('arrow-up', 16)}</button>
    </form>
  </section>`;
}

function campusCard(posts) {
  const items = (posts || []).filter((p) => p.status === 'published' && p.visible).slice(0, 3);
  return html`<section class="card flush">
    <div class="card-head"><h2>On campus</h2><a class="btn btn-sm btn-ghost" href="/campus">Feed ${icon('chevron-right', 16)}</a></div>
    ${items.length ? html`<div class="list" style="padding-bottom:8px">${items.map((p) => row({ href: `/campus?post=${p.id}`, icon: { event: 'calendar', job: 'briefcase', housing: 'home', research: 'target', announcement: 'bell', community: 'users', product: 'sparkle' }[p.category], title: p.title, sub: `${humanize(p.category)} · ${ago(p.created)}`, trail: p.match?.length ? html`<span class="chip accent">For you</span>` : '' }))}</div>`
      : empty({ icon: 'compass', title: 'Quiet on campus', body: 'Announcements, events and opportunities will show up here.' })}
  </section>`;
}

/**
 * The next lectures: the one live now first, then what is coming up, with date, time and room. A calm list, not a
 * banner: a live lecture only gets a small dot.
 */
function lecturesCard(feed) {
  const items = (feed?.lectures || []).filter((l) => l.state !== 'past').slice(0, 3);
  const lecturer = session.user.role !== 'student';
  const action = (l) => (lecturer ? html`<a class="btn btn-sm ${l.state === 'live' ? 'btn-primary' : ''}" href="/live/${l.course.id}${l.state === 'live' ? '' : `?lecture=${l.id}`}">${l.state === 'live' ? 'Resume' : 'Start'}</a>`
    : l.state === 'live' ? html`<a class="btn btn-sm btn-primary" href="/live/${l.course.id}">Join</a>` : '');
  return html`<section class="card flush lectures-card"><div class="card-head"><h2>Lectures</h2><a class="btn btn-sm btn-ghost" href="/lectures">All ${icon('chevron-right', 16)}</a></div>
    ${items.length ? html`<div class="list" style="padding-bottom:8px">${items.map((l) => html`<div class="list-row">${courseTile(l.course.code)}
      <a class="body" href="/lectures" style="color:inherit;text-decoration:none"><span class="title">${l.topic}${l.state === 'live' ? html` <span class="chip success"><span class="dot live"></span>Live</span>` : ''}</span><span class="sub">${whenLine(l)} · ${l.course.code}</span></a>
      <span class="trail">${action(l)}</span></div>`)}</div>`
      : html`<p class="muted small" style="padding:0 20px 18px">${lecturer ? 'Nothing scheduled. Schedule a lecture in a course, or start one live.' : 'No lectures coming up in your courses. Browse lectures to find one to join.'}</p>`}
  </section>`;
}

function studentBody(data) {
  const due = data.review.stats.dueNow;
  const open = data.participation.filter((s) => s.open && !s.mine);
  return html`
    ${open.length ? html`<a class="notice accent" href="/participation/${open[0].id}" style="text-decoration:none">${icon('clipboard', 18)}<span><strong>${open[0].code} check-in is open.</strong> ${open[0].title}${open[0].room ? ` · ${open[0].room}` : ''} — tap to check in.</span></a>` : ''}
    <div class="home-grid">
      <div class="stack">${upNext(data)}${campusCard(data.posts)}</div>
      <div class="stack">
        <section class="card">
          <div class="spread"><div><div class="stat-value" data-count="${due}">${due}</div><div class="stat-label">${due === 1 ? 'card to review' : 'cards to review'}</div></div><span class="tile lg success">${icon('graduation', 26)}</span></div>
          <a class="btn ${due ? 'btn-primary' : ''} btn-block mt-16" href="/learning">${due ? 'Start review' : 'Open learning'}</a>
        </section>
        <section class="card flush">
          <div class="card-head"><h2>Courses</h2><a class="btn btn-sm btn-ghost" href="/courses">All ${icon('chevron-right', 16)}</a></div>
          ${data.courses.length ? html`<div class="list" style="padding-bottom:8px">${data.courses.slice(0, 4).map((c) => row({ href: `/courses/${c.id}`, tile: courseTile(c.code), title: c.title, sub: c.lecturer || c.code }))}</div>`
            : empty({ icon: 'book', title: 'No courses yet', action: html`<a class="btn btn-sm btn-primary" href="/courses">Browse courses</a>` })}
        </section>
        ${assistantCard()}
      </div>
    </div>`;
}

function lecturerBody(data) {
  const pending = data.activations.filter((a) => a.status === 'pending');
  const recent = data.participation.slice(0, 3);
  return html`
    ${pending.map((a) => html`<a class="notice accent" href="/classroom?activation=${a.id}" style="text-decoration:none">${icon('nfc', 18)}<span><strong>Confirm sign-in at ${a.room || a.device}.</strong> You tapped your card — tap here to start the session.</span></a>`)}
    <div class="home-grid">
      <div class="stack">${upNext(data)}
        <section class="card flush">
          <div class="card-head"><h2>Your courses</h2><a class="btn btn-sm btn-ghost" href="/courses">All ${icon('chevron-right', 16)}</a></div>
          ${data.courses.length ? html`<div class="list" style="padding-bottom:8px">${data.courses.slice(0, 5).map((c) => row({ href: `/courses/${c.id}`, tile: courseTile(c.code), title: c.title, sub: `${c.code} · ${plural(c.enrolled_count || 0, 'student')}` }))}</div>`
            : empty({ icon: 'book', title: 'No courses assigned yet', body: 'An administrator assigns courses to lecturers.' })}
        </section>
      </div>
      <div class="stack">
        <section class="card flush">
          <div class="card-head"><h2>Recent check-ins</h2><a class="btn btn-sm btn-ghost" href="/participation">All ${icon('chevron-right', 16)}</a></div>
          ${recent.length ? html`<div class="list" style="padding-bottom:8px">${recent.map((s) => row({ href: `/participation/${s.id}`, icon: 'clipboard', tone: s.open ? 'success' : 'neutral', title: s.title, sub: `${s.code} · ${plural(s.checkins, 'check-in')}`, trail: s.open ? html`<span class="chip success"><span class="dot live"></span>Open</span>` : '' }))}</div>`
            : empty({ icon: 'clipboard', title: 'No sessions yet', action: html`<a class="btn btn-sm btn-primary" href="/participation?new=1">Start a check-in</a>` })}
        </section>
        ${campusCard(data.posts)}
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
    // A small live Campus that watches you type.
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
    return () => {
      unwatch?.();
      face?.destroy();
    };
  },
};
