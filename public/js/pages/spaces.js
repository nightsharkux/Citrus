import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { isStaff } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { ago, plural } from '../core/format.js';
import { sheet, onSubmit } from '../core/ui.js';

export const KIND = {
  study: ['users', 'Study group'],
  meeting: ['message', 'Meeting'],
  discussion: ['bulb', 'Discussion'],
  lecture: ['presentation', 'Lecture'],
  assignment: ['clipboard', 'Assignment'],
};
export const GUIDANCE = {
  coach: ['Coach', 'Hints first; nudges students to try before giving answers.'],
  socratic: ['Socratic', 'Answers mostly with guiding questions.'],
  direct: ['Direct', 'Clear explanations and worked examples.'],
  assessment: ['Assessment-safe', 'Explains concepts but never gives final answers.'],
};

export function newSpaceSheet(ctx, courses = []) {
  const kinds = Object.entries(KIND).filter(([k]) => isStaff() || !['lecture', 'assignment'].includes(k));
  sheet({
    title: 'New space',
    content: html`<form class="form" id="space-form">
      <label class="field"><span>Name</span><input class="input" name="title" required minlength="3" maxlength="120" placeholder="Marketing project team" autofocus></label>
      <div class="field"><span>Type</span><div class="choice-grid">${kinds.map(([k, [glyph, label]], i) => html`<label class="choice"><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}>${icon(glyph, 18)}${label}</label>`)}</div></div>
      ${courses.length ? html`<label class="field"><span>Link to a course (optional)</span><select class="select" name="course_id"><option value="">None</option>${courses.map((c) => html`<option value="${c.id}">${c.code} · ${c.title}</option>`)}</select><span class="hint">Linked lecture spaces can add live topics to the course.</span></label>` : ''}
      <label class="field"><span>Assistant approach</span><select class="select" name="guidance">${Object.entries(GUIDANCE).map(([k, [label, desc]]) => html`<option value="${k}">${label} — ${desc}</option>`)}</select></label>
      <label class="field"><span>Instructions for the assistant (optional)</span><textarea class="textarea" name="instructions" maxlength="2000" placeholder="Goals, rules or boundaries for this space"></textarea></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Create space</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#space-form', el), async (v) => {
        const r = await api.post('/workspaces', { ...v, course_id: v.course_id ? Number(v.course_id) : undefined });
        close();
        ctx.navigate(`/spaces/${r.id}`);
        return 'Space created — share the code to invite people';
      });
    },
  });
}

export function joinSheet(ctx) {
  sheet({
    title: 'Join a space',
    content: html`<form class="form" id="join-form">
      <label class="field"><span>Invite code</span><input class="input mono" name="code" required minlength="4" maxlength="25" placeholder="A3F5C91021" autocapitalize="characters" autocomplete="off" autofocus style="letter-spacing:.12em;font-size:18px"></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Join</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#join-form', el), async (v) => {
        const r = await api.post('/workspaces/join', v);
        close();
        ctx.navigate(`/spaces/${r.id}`);
        return 'You joined the space';
      });
    },
  });
}

export default {
  title: 'Spaces',
  async load() {
    const [spaces, courses] = await Promise.all([api.get('/workspaces'), isStaff() ? api.get('/courses') : Promise.resolve({ courses: [] })]);
    return { rooms: spaces.rooms, courses: courses.courses };
  },
  render({ rooms }) {
    return html`
      ${pageHead({ title: 'Spaces', subtitle: 'Private rooms for study groups, meetings and lectures — with shared notes and an assistant that follows your rules.', actions: html`<button class="btn" data-join>${icon('ticket', 17)} Join with code</button><button class="btn btn-primary" data-new>${icon('plus', 17)} New space</button>` })}
      ${rooms.length ? html`<div class="grid-auto stagger" style="--min:260px">${rooms.map((r) => {
        const [glyph, label] = KIND[r.kind] || KIND.study;
        return html`<a class="card space-card" href="/spaces/${r.id}">
          <div class="spread"><span class="tile">${icon(glyph, 19)}</span>${r.live ? html`<span class="chip danger"><span class="dot live"></span>Live</span>` : html`<span class="chip">${label}</span>`}</div>
          <h3 class="mt-16">${r.title}</h3>
          <p class="small muted mt-8">${plural(r.member_count, 'member')} · ${plural(r.note_count, 'note')}</p>
          <p class="small faint">${r.last_activity ? `Active ${ago(r.last_activity)}` : `Created ${ago(r.created)}`}</p>
        </a>`;
      })}</div>`
        : html`<div class="card">${empty({ icon: 'grid', title: 'No spaces yet', body: 'Create one for your project team or study group, or join with an invite code.', action: html`<div class="cluster" style="justify-content:center"><button class="btn" data-join>Join with code</button><button class="btn btn-primary" data-new>New space</button></div>` })}</div>`}`;
  },
  mount(root, data, ctx) {
    const offs = [
      on(root, 'click', '[data-new]', () => newSpaceSheet(ctx, data.courses)),
      on(root, 'click', '[data-join]', () => joinSheet(ctx)),
    ];
    if (ctx.query.get('new') === '1') {
      history.replaceState({}, '', '/spaces');
      newSpaceSheet(ctx, data.courses);
    }
    return () => offs.forEach((off) => off());
  },
};
