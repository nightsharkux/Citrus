'use strict';
/** Meetings in a space: start, everyone's words as captions with names, quick notes, and shared minutes at the end. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

function gateway() {
  const state = { calls: [] };
  return {
    state,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      state.calls.push(body);
      const system = body.messages[0].content;
      const reply = /meeting secretary/.test(system) ? 'Decisions\n- Launch on Friday.\n\nAction items\n- Ben books the room.' : 'You agreed to launch on Friday.';
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  };
}

test('a meeting runs from start to shared minutes', async () => {
  const fixture = gateway();
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    for (const who of ['ann', 'ben', 'cem']) await app.register(who);
    const space = await app.call('ann', 'POST', '/api/workspaces', { title: 'Project team', kind: 'meeting' });
    const wid = space.body.id;
    await app.call('ben', 'POST', '/api/workspaces/join', { code: space.body.joinCode });

    assert.equal((await app.call('cem', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'start' })).status, 403, 'not a member');
    assert.equal((await app.call('ben', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'end' })).status, 400, 'nothing to end yet');
    const started = await app.call('ben', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'start' });
    assert.equal(started.status, 201, 'any member of a group space can start one');
    assert.equal(started.body.meeting.by, 'Ben Person');
    assert.equal((await app.call('ann', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'start' })).body.resumed, true, 'one meeting at a time');
    const room = await app.call('ann', 'GET', `/api/workspaces/${wid}`);
    assert.ok(room.body.room.meeting.started);
    assert.equal(room.body.room.canSpeak, true);

    // Both speak; the captions carry who said what.
    assert.equal((await app.call('ann', 'POST', `/api/workspaces/${wid}/captions`, { text: 'I think we should launch on Friday.' })).status, 200);
    await app.call('ben', 'POST', `/api/workspaces/${wid}/captions`, { text: 'Agreed, I will book the room.' });
    assert.equal((await app.call('cem', 'POST', `/api/workspaces/${wid}/captions`, { text: 'hello' })).status, 403);
    const captions = await app.call('ann', 'GET', `/api/workspaces/${wid}/captions`);
    assert.deepEqual(captions.body.captions.map((c) => c.author), ['Ann Person', 'Ben Person']);

    // A decision noted with one tap; the assistant knows what has been said.
    await app.call('ann', 'POST', `/api/workspaces/${wid}/notes`, { category: 'minutes', content: 'Launch on Friday' });
    const asked = await app.call('ben', 'POST', `/api/workspaces/${wid}/assistant`, { prompt: 'What did we decide?' });
    assert.equal(asked.status, 200);
    assert.match(fixture.state.calls.at(-1).messages[0].content, /SAID IN THE MEETING SO FAR[\s\S]*launch on Friday/);

    // Ending drafts the minutes from what was said and noted, for everyone in the space.
    const ended = await app.call('ben', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'end' });
    assert.equal(ended.status, 200);
    assert.match(ended.body.report.report, /Launch on Friday/);
    const source = JSON.stringify(fixture.state.calls.at(-1).messages.at(-1).content);
    assert.match(source, /\[decision\] Launch on Friday \(Ann Person\)/);
    assert.match(source, /Ben Person: Agreed, I will book the room/);
    const annSees = await app.call('ann', 'GET', `/api/workspaces/${wid}`);
    assert.equal(annSees.body.room.meeting, null);
    const minutes = annSees.body.reports.find((r) => r.meeting_started);
    assert.ok(minutes, 'the minutes are shared with members');
    assert.equal(minutes.mine, false);

    // Only whoever ran it, or the owner, deletes the minutes.
    await app.register('dan');
    await app.call('dan', 'POST', '/api/workspaces/join', { code: space.body.joinCode });
    assert.equal((await app.call('dan', 'DELETE', `/api/workspaces/${wid}/reports/${minutes.id}`)).status, 403);
    assert.equal((await app.call('ann', 'DELETE', `/api/workspaces/${wid}/reports/${minutes.id}`)).status, 200);

    // A meeting where nothing was said or noted leaves no minutes.
    await app.call('ann', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'start' });
    const quiet = await app.call('ann', 'POST', `/api/workspaces/${wid}/meeting`, { action: 'end' });
    assert.equal(quiet.body.empty, true);
  } finally {
    await app.close();
  }
});

test('in a lecture space only the lecturer or the owner runs a meeting', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    await app.lecturer('prof');
    await app.register('stu');
    const space = await app.call('prof', 'POST', '/api/workspaces', { title: 'ML lecture room', kind: 'lecture' });
    await app.call('stu', 'POST', '/api/workspaces/join', { code: space.body.joinCode });
    assert.equal((await app.call('stu', 'GET', `/api/workspaces/${space.body.id}`)).body.room.canSpeak, false);
    assert.equal((await app.call('stu', 'POST', `/api/workspaces/${space.body.id}/meeting`, { action: 'start' })).status, 403);
    assert.equal((await app.call('prof', 'POST', `/api/workspaces/${space.body.id}/meeting`, { action: 'start' })).status, 201);
    assert.equal((await app.call('stu', 'POST', `/api/workspaces/${space.body.id}/captions`, { text: 'hi' })).status, 403);
    const ended = await app.call('prof', 'POST', `/api/workspaces/${space.body.id}/meeting`, { action: 'end' });
    assert.equal(ended.status, 200, 'without AI the meeting still ends');
  } finally {
    await app.close();
  }
});
