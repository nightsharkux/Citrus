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

test('meeting mode: start in one tap, questions to Citrus are kept, minutes split into separate files', async () => {
  const state = { calls: [] };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    state.calls.push(body);
    const system = body.messages[0].content;
    let reply = 'Recursion is when a function calls itself.';
    if (/meeting secretary/.test(system)) reply = '## Summary\nWe planned the exam review.\n\n## Decisions\n- Review on Friday.\n\n## Questions raised\n- Ann: Is recursion on the exam? (Asked Citrus)';
    if (/You edit meeting minutes/.test(system)) reply = JSON.stringify([{ label: 'With student questions', minutes: '## Decisions\n- Review on Friday.\n\n## Questions raised\n- Ann: Is recursion on the exam?' }, { label: 'Without student questions', minutes: '## Decisions\n- Review on Friday.' }]);
    return Response.json({ choices: [{ message: { content: reply } }] });
  };
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_PROVIDER: 'gateway' }, fetchImpl });
  try {
    await app.login('admin');
    await app.register('ann');
    await app.register('ben');
    const quick = await app.call('ann', 'POST', '/api/meetings/quick', { title: 'Exam review planning' });
    assert.equal(quick.status, 201);
    const hub = await app.call('ann', 'GET', '/api/meetings');
    assert.equal(hub.body.running.length, 1, 'it is running straight away');
    assert.equal(hub.body.running[0].space.title, 'Exam review planning');
    assert.equal((await app.call('ben', 'GET', '/api/meetings')).body.running.length, 0, 'not in his spaces');
    assert.equal((await app.call('ben', 'POST', `/api/workspaces/${quick.body.id}/assistant`, { prompt: 'Explain recursion' })).status, 403);

    // "Hey Citrus, explain recursion" during the meeting: answered, and kept as a question for the minutes.
    const asked = await app.call('ann', 'POST', `/api/workspaces/${quick.body.id}/assistant`, { prompt: 'Explain recursion' });
    assert.match(asked.body.answer, /calls itself/);
    const room = await app.call('ann', 'GET', `/api/workspaces/${quick.body.id}`);
    assert.ok(room.body.notes.some((n) => n.category === 'question' && /Asked Citrus: Explain recursion/.test(n.content)));

    const ended = await app.call('ann', 'POST', `/api/workspaces/${quick.body.id}/meeting`, { action: 'end' });
    assert.ok(ended.body.report.id);
    assert.ok(state.calls.at(-1).model.startsWith('openai/gpt-6.1'), 'minutes use the main model, not the cheap summary one');
    assert.match(JSON.stringify(state.calls.at(-1).messages.at(-1).content), /\[question\] Asked Citrus: Explain recursion/);

    // "Make two files: one with the student questions and one without."
    const split = await app.call('ann', 'POST', `/api/workspaces/${quick.body.id}/reports/${ended.body.report.id}/versions`, { instruction: 'Two files: one with the student questions and one without' });
    assert.equal(split.status, 201);
    assert.deepEqual(split.body.versions.map((v) => v.label), ['With student questions', 'Without student questions']);
    assert.doesNotMatch(split.body.versions[1].report, /Questions raised/);
    const after = await app.call('ann', 'GET', `/api/workspaces/${quick.body.id}`);
    assert.equal(after.body.reports.filter((r) => r.parent_id === ended.body.report.id).length, 2, 'kept as separate files');
    const file = await app.call('ann', 'GET', `/api/workspaces/${quick.body.id}/reports/${split.body.versions[1].id}/minutes.txt`, undefined, { raw: true });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /Without-student-questions\.txt/);
    const minutesFile = await file.text();
    assert.match(minutesFile, /Review on Friday/);
    assert.match(minutesFile, /INSTRUCTIONS FOR ANY AI[\s\S]*=== DATA ===[\s\S]*--- MINUTES ---/, 'instructions any AI can follow come first');
    assert.match(minutesFile, /\[QUESTION t=00:00:\d\d [^\]]+\] Asked Citrus: Explain recursion/, 'what was noted, tagged with its time');
    assert.equal((await app.call('ben', 'GET', `/api/workspaces/${quick.body.id}/reports/${split.body.versions[1].id}/minutes.txt`)).status, 403);
    assert.equal((await app.call('ben', 'POST', `/api/workspaces/${quick.body.id}/reports/${ended.body.report.id}/versions`, { instruction: 'only decisions' })).status, 403);
  } finally {
    await app.close();
  }
});
