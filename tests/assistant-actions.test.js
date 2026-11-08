'use strict';
/** The assistant can change the user's own calendar and move around the app; every change is scoped, audited and undoable. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { createLeadExtractor, extractLead } = require('../src/ai/actions');

/** Gateway stand-in that answers with whatever `reply()` returns for the latest user message. */
function gateway(reply) {
  const state = { last: null };
  return {
    state,
    async fetchImpl(url, options) {
      state.last = JSON.parse(options.body);
      const text = reply(state.last.messages.at(-1).content);
      if (state.last.stream) {
        const chunks = text.match(/[\s\S]{1,7}/g).map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        return new Response(`${chunks.join('')}data: [DONE]\n\n`);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    },
  };
}

const parseSse = (text) => text.split('\n\n').filter(Boolean).map((chunk) => ({
  event: /event: (.+)/.exec(chunk)?.[1],
  data: JSON.parse(/data: (.+)/.exec(chunk)?.[1] || 'null'),
}));

async function ask(app, who, prompt, threadId) {
  const res = await app.call(who, 'POST', '/api/assistant/messages', { prompt, thread_id: threadId }, { headers: { accept: 'text/event-stream' }, raw: true });
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());
  return {
    events,
    thread: events.find((e) => e.event === 'thread').data,
    text: events.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''),
    actions: events.filter((e) => e.event === 'action').map((e) => e.data),
    done: events.find((e) => e.event === 'done')?.data,
  };
}

const future = (days, hour = 15) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00`;
};

test('lead cues are found whatever the chunking, and only at the start of the answer', () => {
  const answer = '[visual: steps | plan, build]\n[action: calendar.add | {"title":"Study ] group","start":"2026-11-10T15:00"}]\n[action: app.theme | {"mode":"dark"}]\n\nAdding it now. [1]';
  for (const size of [1, 3, 7, 500]) {
    const seen = [];
    const lead = createLeadExtractor({ onAction: (a) => seen.push(a) });
    let out = '';
    for (let i = 0; i < answer.length; i += size) out += lead.push(answer.slice(i, i + size));
    out += lead.end();
    assert.equal(out, 'Adding it now. [1]', `chunk size ${size}`);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].args.title, 'Study ] group', 'brackets inside JSON strings are fine');
    assert.equal(lead.visual.kind, 'steps');
  }
  assert.deepEqual(extractLead('Sure. [action: app.theme | {"mode":"dark"}]').actions, [], 'an action in the middle of the text is never run');
  assert.equal(extractLead('Sure. [action: app.theme | {"mode":"dark"}]').text, 'Sure. [action: app.theme | {"mode":"dark"}]');
  assert.equal(extractLead('[1] The library opens at 8.').text, '[1] The library opens at 8.');
  const bad = extractLead('[action: calendar.add | {nope}]\nok');
  assert.equal(bad.text, 'ok');
  assert.ok(bad.actions[0].error, 'unreadable details become a failed action, not visible text');
  const many = extractLead(Array.from({ length: 9 }, () => '[action: app.theme | {"mode":"dark"}]').join('\n'));
  assert.equal(many.actions.length, 6, 'at most six actions per answer');
});

test('the assistant adds, moves and removes personal events, and every change can be undone', async () => {
  const start = future(3);
  const replies = {
    add: `[action: calendar.add | {"title":"Study group","start":"${start}","duration_minutes":90,"location":"Library"}]\n\nAdding it to your calendar.`,
    move: (id) => `[action: calendar.update | {"id":${id},"start":"${future(3, 17)}"}]\n\nMoving it two hours later.`,
    remove: (id) => `[action: calendar.delete | {"id":${id}}]\n\nRemoving it.`,
  };
  let eventId = null;
  const gw = gateway((prompt) => {
    if (/add/.test(prompt)) return replies.add;
    if (/later/.test(prompt)) return replies.move(eventId);
    return replies.remove(eventId);
  });
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    await app.register('stu');
    const added = await ask(app, 'stu', 'add a study group in three days at 15:00 for 90 minutes');
    assert.equal(added.text, 'Adding it to your calendar.', 'the action line never reaches the reader');
    assert.equal(added.actions.length, 1);
    assert.equal(added.actions[0].ok, true);
    assert.match(added.actions[0].detail, /Study group/);
    assert.equal(added.actions[0].undoable, true);
    assert.equal(added.actions[0].undo, undefined, 'undo data stays on the server');
    assert.equal(added.done.actions[0].title, 'Added to your calendar');
    eventId = added.actions[0].eventId;

    const week = await app.call('stu', 'GET', `/api/timetable?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}`);
    const mine = week.body.events.find((e) => e.id === eventId);
    assert.equal(mine.title, 'Study group');
    assert.equal(mine.scope, 'personal');
    assert.equal(new Date(mine.ends) - new Date(mine.starts), 90 * 60_000);

    // The model sees the event, with its id, in the next turn's context.
    await ask(app, 'stu', 'move it two hours later', added.thread.id);
    assert.match(gw.state.last.messages[0].content, new RegExp(`\\[id ${eventId}\\] .*Study group`));
    assert.match(JSON.stringify(gw.state.last.messages), new RegExp(`event id ${eventId}`), 'earlier actions are part of the history');
    const moved = (await app.call('stu', 'GET', `/api/timetable?from=${encodeURIComponent(mine.starts)}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}`)).body.events.find((e) => e.id === eventId);
    assert.equal(new Date(moved.ends) - new Date(moved.starts), 90 * 60_000, 'moving keeps the length');
    assert.notEqual(moved.starts, mine.starts);

    // Undo the move from the thread, then the creation.
    const thread = (await app.call('stu', 'GET', `/api/assistant/threads/${added.thread.id}`)).body;
    const moveMessage = thread.messages.filter((m) => m.actions?.length).at(-1);
    assert.equal(moveMessage.actions[0].name, 'calendar.update');
    assert.equal(moveMessage.actions[0].undo, undefined);
    const undone = await app.call('stu', 'POST', `/api/assistant/messages/${moveMessage.id}/actions/0/undo`);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.action.undone, true);
    assert.equal(undone.body.action.undoable, false);
    const restored = (await app.call('stu', 'GET', `/api/timetable?from=${encodeURIComponent(mine.starts)}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}`)).body.events.find((e) => e.id === eventId);
    assert.equal(restored.starts, mine.starts);
    assert.equal((await app.call('stu', 'POST', `/api/assistant/messages/${moveMessage.id}/actions/0/undo`)).status, 400, 'undo works once');

    // Deleting and undoing the delete brings the event back.
    await ask(app, 'stu', 'remove it', added.thread.id);
    const after = await app.call('stu', 'GET', `/api/timetable?from=${encodeURIComponent(mine.starts)}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}`);
    assert.equal(after.body.events.some((e) => e.title === 'Study group'), false);
    const full = (await app.call('stu', 'GET', `/api/assistant/threads/${added.thread.id}`)).body;
    const deleteMessage = full.messages.filter((m) => m.actions?.length).at(-1);
    assert.equal((await app.call('stu', 'POST', `/api/assistant/messages/${deleteMessage.id}/actions/0/undo`)).status, 200);
    const back = await app.call('stu', 'GET', `/api/timetable?from=${encodeURIComponent(mine.starts)}&to=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}`);
    assert.equal(back.body.events.filter((e) => e.title === 'Study group').length, 1);

    const audit = app.db.all("SELECT action FROM audit WHERE action LIKE 'assistant_action%'");
    assert.ok(audit.length >= 4, 'changes and undos are audited');
  } finally {
    await app.close();
  }
});

test('assistant actions are limited to the user\'s own data', async () => {
  let reply = '';
  const gw = gateway(() => reply);
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    await app.login('admin');
    const university = await app.call('admin', 'POST', '/api/timetable', { scope: 'institution', title: 'Open day', kind: 'event', starts: new Date(Date.now() + 2 * 86_400_000).toISOString(), ends: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString() });
    assert.equal(university.status, 201);
    await app.register('stu');
    await app.register('other');

    // Someone else's personal event, and a university-wide one, cannot be changed or removed.
    const theirs = await app.call('other', 'POST', '/api/timetable', { title: 'Private appointment', kind: 'personal', starts: new Date(Date.now() + 86_400_000).toISOString(), ends: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString() });
    for (const id of [theirs.body.id, university.body.id]) {
      reply = `[action: calendar.delete | {"id":${id}}]\n\nRemoving it.`;
      const r = await ask(app, 'stu', 'delete that event');
      assert.equal(r.actions[0].ok, false);
      assert.match(r.actions[0].error, /only change your own/);
      assert.equal(r.actions[0].undoable, false);
    }
    assert.ok(app.db.get('SELECT 1 FROM timetable_events WHERE id = ?', theirs.body.id), 'the other user\'s event is untouched');
    assert.ok(app.db.get('SELECT 1 FROM timetable_events WHERE id = ?', university.body.id), 'the university event is untouched');

    // Bad dates fail visibly and create nothing.
    const before = app.db.get('SELECT COUNT(*) n FROM timetable_events').n;
    reply = '[action: calendar.add | {"title":"Impossible","start":"2026-02-31T10:00"}]\n\nAdding it.';
    const bad = await ask(app, 'stu', 'add an event');
    assert.equal(bad.actions[0].ok, false);
    reply = '[action: calendar.add | {"title":"Ancient","start":"1999-01-01T10:00"}]\n\nAdding it.';
    assert.equal((await ask(app, 'stu', 'add an event')).actions[0].ok, false);
    assert.equal(app.db.get('SELECT COUNT(*) n FROM timetable_events').n, before);

    // Unknown actions and admin-only pages are refused.
    reply = '[action: course.delete | {"id":1}]\n\nDeleting it.';
    assert.match((await ask(app, 'stu', 'delete my course')).actions[0].error, /cannot do that/);
    reply = '[action: app.navigate | {"to":"people"}]\n\nOpening it.';
    assert.equal((await ask(app, 'stu', 'open people')).actions[0].ok, false);

    // Undo belongs to the person who asked.
    reply = `[action: calendar.add | {"title":"Mine","start":"${future(2)}"}]\n\nAdding.`;
    const added = await ask(app, 'stu', 'add mine');
    assert.equal((await app.call('other', 'POST', `/api/assistant/messages/${added.done.messageId}/actions/0/undo`)).status, 404);
    assert.equal((await app.call('stu', 'POST', `/api/assistant/messages/${added.done.messageId}/actions/5/undo`)).status, 404);
  } finally {
    await app.close();
  }
});

test('the assistant opens pages and switches theme through the browser, and works without streaming', async () => {
  let reply = '';
  const gw = gateway(() => reply);
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: gw.fetchImpl });
  try {
    await app.register('stu');
    reply = '[action: app.navigate | {"to":"calendar"}]\n[action: app.theme | {"mode":"dark"}]\n\nOpening your schedule.';
    const r = await ask(app, 'stu', 'open my calendar in dark mode');
    assert.deepEqual(r.actions.map((a) => a.client), [{ type: 'navigate', path: '/schedule' }, { type: 'theme', mode: 'dark' }]);

    reply = `[action: calendar.add | {"title":"Revision","start":"${future(1, 9)}"}]`;
    const json = await app.call('stu', 'POST', '/api/assistant/messages', { prompt: 'add revision tomorrow at 9' });
    assert.equal(json.status, 200);
    assert.equal(json.body.message.actions[0].ok, true);
    assert.match(json.body.message.content, /Added to your calendar/, 'an answer made only of actions still reads as a sentence');
  } finally {
    await app.close();
  }
});
