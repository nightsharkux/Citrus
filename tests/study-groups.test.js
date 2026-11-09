'use strict';
/**
 * Study groups and assistant memory: a request made in chat is remembered, matched with other students, and the
 * contact is shown only with consent. The assistant also reaches profile, courses, campus and notifications.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { subjectKey, similar } = require('../src/modules/groups/service');

function gateway(script) {
  const seen = [];
  return {
    seen,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      seen.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: script(body) } }] }));
    },
  };
}

test('subjects match across spelling, numbering and German or English filler words', () => {
  assert.ok(similar(subjectKey('Mathe 2'), subjectKey('Lerngruppe für Mathematik II')));
  assert.ok(similar(subjectKey('study group for Statistics'), subjectKey('Statistik')));
  assert.ok(!similar(subjectKey('Mathe 2'), subjectKey('Mathe 1')));
  assert.ok(!similar(subjectKey('Marketing'), subjectKey('Mathematik')));
});

test('a study-group request made in chat is remembered, matched and shares contacts only with consent', async () => {
  let reply = 'Okay.';
  const fixture = gateway(() => reply);
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_RATE_PER_MINUTE: '200' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    await app.register('ana');
    await app.register('ben');
    await app.register('cleo');

    // Ana asks for a group and agrees to share her contact.
    reply = '[action: groups.seek | {"subject":"Mathe 2","note":"Tuesdays after 16:00","share_contact":true}]\n\nIch suche für dich.';
    const first = await app.call('ana', 'POST', '/api/assistant/messages', { prompt: 'ich brauche eine Lerngruppe für Mathe 2, du kannst meine Mail teilen' });
    const seek = first.body.message.actions[0];
    assert.equal(seek.ok, true, JSON.stringify(seek));
    assert.match(seek.detail, /Nobody else is looking yet/);
    assert.match(seek.detail, /shared with matches \(ana@test\.invalid\)/);

    // Ben does not share; he is matched with Ana and sees her contact.
    reply = '[action: groups.seek | {"subject":"Mathematik II"}]\n\nLooking.';
    const second = await app.call('ben', 'POST', '/api/assistant/messages', { prompt: 'looking for a study group for Mathematik II' });
    const benSeek = second.body.message.actions[0];
    assert.match(benSeek.detail, /Ana Person \(ana@test\.invalid\)/);
    assert.match(benSeek.detail, /Your contact: not shared/);
    const anaInbox = (await app.call('ana', 'GET', '/api/notifications')).body;
    assert.ok(JSON.stringify(anaInbox).includes('Another student is also looking for a study group'), 'Ana hears about Ben without his name');
    assert.ok(!JSON.stringify(anaInbox).includes('ben@test.invalid'));

    // Cleo asks whether Ana is looking: the model sees Ana's request with her contact, and Ben's without his.
    reply = 'Ja.';
    await app.call('cleo', 'POST', '/api/assistant/messages', { prompt: 'is Ana looking for a group?' });
    let system = fixture.seen.at(-1).messages[0].content;
    assert.match(system, /Other students looking for a study group/);
    assert.match(system, /Mathe 2 — Ana Person \(ana@test\.invalid\)/);
    assert.match(system, /a student \(contact not shared\)/);
    assert.ok(!system.includes('ben@test.invalid'), 'an unshared contact never reaches the model');

    // Ana's own request stays in her context in later conversations.
    await app.call('ana', 'POST', '/api/assistant/messages', { prompt: 'what should I do today?' });
    system = fixture.seen.at(-1).messages[0].content;
    assert.match(system, /The user is looking for a study group[^]*Mathe 2 — you/);

    // The page API shows the same, and only the owner can change or close a request.
    const page = (await app.call('cleo', 'GET', '/api/groups')).body;
    assert.equal(page.mine.length, 0);
    const anaReq = page.others.find((r) => r.subject === 'Mathe 2');
    assert.equal(anaReq.email, 'ana@test.invalid');
    const benReq = page.others.find((r) => r.subject === 'Mathematik II');
    assert.equal(benReq.email, null);
    assert.equal(benReq.name, null);
    assert.equal((await app.call('cleo', 'DELETE', `/api/groups/${anaReq.id}`)).status, 404, 'not someone else\'s request');
    assert.equal((await app.call('cleo', 'PATCH', `/api/groups/${anaReq.id}`, { share_contact: false })).status, 404);
    assert.equal((await app.call('anon', 'GET', '/api/groups')).status, 401);
    assert.equal((await app.call('anon', 'POST', '/api/groups', { subject: 'X stuff' })).status, 401);

    // Ben now agrees to share; Ana is told who he is.
    const shared = await app.call('ben', 'POST', '/api/groups', { subject: 'Mathematik II', share_contact: true });
    assert.equal(shared.status, 200, 'the same subject updates the existing request');
    assert.ok(JSON.stringify((await app.call('ana', 'GET', '/api/notifications')).body).includes('Ben Person is also looking for a study group'));

    // Closing in chat, and undo reopens it.
    reply = '[action: groups.stop | {"subject":"Mathe 2"}]\n\nClosing it.';
    const stop = await app.call('ana', 'POST', '/api/assistant/messages', { prompt: 'I found a group' });
    assert.equal(stop.body.message.actions[0].ok, true);
    assert.equal((await app.call('ana', 'GET', '/api/groups')).body.mine.length, 0);
    await app.call('ana', 'POST', `/api/assistant/messages/${stop.body.message.id}/actions/0/undo`);
    assert.equal((await app.call('ana', 'GET', '/api/groups')).body.mine.length, 1);
  } finally {
    await app.close();
  }
});

test('the assistant remembers facts and reaches profile, courses, campus and notifications', async () => {
  let reply = 'Okay.';
  const fixture = gateway(() => reply);
  const app = await startApp({ env: { AI_GATEWAY_API_KEY: 'fixture-key', CAMPUS_AI_RATE_PER_MINUTE: '200' }, fetchImpl: fixture.fetchImpl });
  try {
    await app.login('admin');
    await app.call('admin', 'PATCH', '/api/ai/settings', { provider: 'gateway' });
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Statistics', code: 'STA1' });
    assert.equal(course.status, 201, JSON.stringify(course.body));
    await app.register('ana');
    await app.register('ben');

    const act = async (who, action, prompt = 'please') => {
      reply = `[action: ${action}]\n\nDoing it.`;
      const res = await app.call(who, 'POST', '/api/assistant/messages', { prompt });
      return { result: res.body.message.actions[0], id: res.body.message.id };
    };

    // Memory: saved, shown in later prompts, private, forgettable.
    const saved = await act('ana', 'memory.save | {"text":"Works at the library on Tuesdays"}');
    assert.equal(saved.result.ok, true);
    await app.call('ana', 'POST', '/api/assistant/messages', { prompt: 'hi' });
    const system = fixture.seen.at(-1).messages[0].content;
    const memoryId = /\[memory (\d+)\] Works at the library on Tuesdays/.exec(system)?.[1];
    assert.ok(memoryId, 'the memory is in the prompt');
    const benHi = await app.call('ben', 'POST', '/api/assistant/messages', { prompt: 'hi' });
    assert.equal(benHi.status, 200, JSON.stringify(benHi.body));
    assert.ok(!fixture.seen.at(-1).messages[0].content.includes('[memory '), 'memories are private');
    assert.equal((await act('ben', `memory.forget | {"id":${memoryId}}`)).result.ok, false, 'not someone else\'s memory');
    assert.equal((await act('ana', `memory.forget | {"id":${memoryId}}`)).result.ok, true);

    // Profile.
    const profile = await act('ana', 'profile.update | {"programme":"DTM","semester":3,"add_interests":["data"]}');
    assert.equal(profile.result.ok, true, JSON.stringify(profile.result));
    let me = (await app.call('ana', 'GET', '/api/me')).body.profile;
    assert.deepEqual(me, { programme: 'DTM', semester: 3, interests: ['data'] });
    await app.call('ana', 'POST', `/api/assistant/messages/${profile.id}/actions/0/undo`);
    me = (await app.call('ana', 'GET', '/api/me')).body.profile;
    assert.equal(me.programme, '');

    // Courses.
    assert.equal((await act('ana', 'course.enroll | {"course":"sta1"}')).result.ok, true);
    assert.equal((await act('ana', 'course.enroll | {"course":"STA1"}')).result.ok, false, 'already enrolled');
    assert.equal((await act('ana', 'course.leave | {"course":"STA1"}')).result.ok, true);

    // Campus post goes to moderation; RSVP works on a published event.
    const post = await act('ana', 'campus.post | {"title":"Board game night","body":"Bring a game, Thursday in the Mensa.","category":"event","event_start":"2027-01-14T19:00"}');
    assert.equal(post.result.ok, true, JSON.stringify(post.result));
    assert.equal(post.result.title, 'Post sent for review');
    const pending = (await app.call('admin', 'GET', '/api/connect/moderation')).body.pending;
    assert.equal(pending.length, 1);
    await app.call('admin', 'POST', '/api/connect/moderation', { id: pending[0].id, action: 'publish' });
    const rsvp = await act('ben', `campus.rsvp | {"post":${pending[0].id}}`, 'sign me up for board game night');
    assert.equal(rsvp.result.ok, true, JSON.stringify(rsvp.result));
    assert.match(fixture.seen.at(-1).messages[0].content, new RegExp(`\\[post ${pending[0].id}\\] event: Board game night`));

    // Notifications and feedback.
    const notif = await act('ana', 'notifications.set | {"level":"essential","quiet_start":"21:00"}');
    assert.equal(notif.result.ok, true, JSON.stringify(notif.result));
    assert.equal((await app.call('ana', 'GET', '/api/connect/preferences')).body.preferences.level, 'essential');
    assert.equal((await act('ana', 'notifications.set | {"quiet_start":"25:00"}')).result.ok, false);
    assert.equal((await act('ana', 'notifications.read | {}')).result.ok, true);
    assert.equal((await act('ana', 'feedback.send | {"message":"Please add the Weiden bus times."}')).result.ok, true);
  } finally {
    await app.close();
  }
});
