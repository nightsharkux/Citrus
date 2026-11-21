'use strict';
/**
 * Everything the app stores about a person is either in their data export, removed or anonymised when they delete
 * their account, or listed here with the reason it stays. A new table that holds a user id fails this test until
 * someone decides which it is (GDPR Art. 15, 17, 20).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('./helpers');

const USER_COLUMNS = /^(user_id|owner_id|author_id|student_id|lecturer_id|creator_id|actor_id|requested_by|created_by|invited_by|sender_id|recipient_id|assignee_id|member_id)$/;

// What the export (GET /api/me/export) carries, by table.
const EXPORTED = new Set([
  'users', 'user_profiles', 'enrollments', 'responses', 'poll_answers', 'assistant_threads', 'workspace_notes', 'meeting_recordings', 'cx_posts',
  'cx_preferences', 'cx_checkins', 'career_interests', 'review_items', 'timetable_events', 'suggestions',
  'live_signals', 'live_flags', 'live_attendees', 'lecture_insight_marks', 'custom_tools', 'custom_tool_adds', 'agreement_acceptances',
]);

// Removed when the account is deleted (POST /api/me/delete). Lecture answers and flags stay without the person
// (the account becomes "Deleted user"), after their free text is removed; see the delete route.
const DELETED = new Set([
  'sessions', 'assistant_threads', 'notifications', 'push_subscriptions', 'review_items', 'revision_packs', 'career_interests', 'cx_preferences', 'user_profiles',
  'connector_tokens', 'cx_nfc_bindings', 'calendar_feeds', 'timetable_events', 'ai_chats', 'responses', 'poll_answers', 'cx_rsvps', 'enrollments',
  'workspace_members', 'recording_signals', 'device_activations', 'study_group_requests', 'assistant_memories', 'meeting_reports', 'meeting_recordings',
  'live_attendees', 'nfc_pairings', 'lecture_insight_marks', 'custom_tools', 'custom_tool_adds',
]);

// Stays, with the reason. Rows here are shared records, are about the institution rather than the person, or hold
// no personal data once the account is anonymised.
const KEPT = {
  agreement_acceptances: 'proof that the person was informed of the agreement (version and date); the account becomes "Deleted user"',
  live_signals: 'how they followed a lecture stays as anonymous class data: the account becomes "Deleted user"',
  live_flags: 'the moment stays as anonymous class data; the note and the explanation written for them are removed',
  workspaces: 'a shared workspace; its creator is shown as "Deleted user"',
  cx_attendance_sessions: 'attendance sessions a lecturer opened belong to the course record',
  live_captions: 'part of the shared workspace record, shown as "Deleted user"',
  lecture_digests: 'part of the shared workspace record, shown as "Deleted user"',
  course_items: 'course material added by a lecturer',
  workspace_notes: 'a shared contribution in a workspace, shown as "Deleted user"',
  cx_posts: 'a shared campus post, shown as "Deleted user"',
  cx_checkins: 'attendance record of the institution; the account is anonymised',
  suggestions: 'feedback to the administrators; the account is anonymised',
  audit: 'security log of the institution, kept 180 days',
  courses: 'the lecturer of a course is part of the course record',
  lectures: 'part of the course record',
  live_sessions: 'the lecture the lecturer gave belongs to the course record',
  live_moments: 'content of the lecturer’s lecture; no student is in it',
  live_recordings: 'the lecturer’s audio of their own lecture; removed with the lecture or by retention',
  live_notes: 'material the lecturer attached to their lecture',
  live_chapters: 'the lecturer’s chapters of their own lecture',
  live_breaks: 'the lecturer’s breaks in their own lecture',
  devices: 'room hardware registered by an administrator',
  assistant_attachments: 'removed with the thread or message they belong to; unsent ones expire after two days',
  assistant_messages: 'removed with the thread',
  topics: 'course material by a lecturer',
  polls: 'course material by a lecturer',
  quizzes: 'removed with the quiz owner’s data or kept as the user’s own; see quizzes',
};

test('every table that holds a person’s id is exported, deleted, or kept for a stated reason', async () => {
  const app = await startApp();
  try {
    const tables = app.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
    const withUser = tables.filter((t) => app.db.all(`PRAGMA table_info(${t})`).some((c) => USER_COLUMNS.test(c.name)));
    assert.ok(withUser.length > 15, 'the schema was read');
    const undecided = withUser.filter((t) => !EXPORTED.has(t) && !DELETED.has(t) && !(t in KEPT));
    assert.deepEqual(undecided, [], `decide for each: exported, deleted on account deletion, or kept (with the reason) in tests/privacy-coverage.test.js\n${undecided.join(', ')}`);
    // A table that is deleted should also be exported, unless it is only technical (sessions, tokens, notifications …).
    const technical = new Set(['nfc_pairings', 'sessions', 'notifications', 'push_subscriptions', 'revision_packs', 'connector_tokens', 'cx_nfc_bindings', 'calendar_feeds', 'ai_chats', 'cx_rsvps', 'workspace_members', 'recording_signals', 'device_activations', 'study_group_requests', 'assistant_memories', 'meeting_reports']);
    const silent = [...DELETED].filter((t) => withUser.includes(t) && !EXPORTED.has(t) && !technical.has(t));
    assert.deepEqual(silent, [], 'deleted but not in the export');
  } finally {
    await app.close();
  }
});

test('a person’s lecture answers, flags and attendance are in their export, and deleting the account removes the free text and the presence', async () => {
  const app = await startApp();
  try {
    await app.login('admin');
    const lecturerId = await app.lecturer('prof');
    const course = await app.call('admin', 'POST', '/api/courses', { title: 'Machine Learning', code: 'ML101' });
    await app.call('admin', 'POST', '/api/admin/assign', { course_id: course.body.id, lecturer_id: lecturerId });
    const reg = await app.register('ann');
    await app.call('ann', 'POST', `/api/courses/${course.body.id}/enroll`);
    const sid = (await app.call('prof', 'POST', '/api/live/sessions', { course_id: course.body.id, title: 'Week 1' })).body.session.id;
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/signal`, { level: 3 })).status, 200);
    assert.equal((await app.call('ann', 'POST', `/api/live/sessions/${sid}/flags`, { kind: 'confused', note: 'my phone number is 0151 1234567' })).status, 201);

    const data = JSON.parse(await (await app.call('ann', 'GET', '/api/me/export', undefined, { raw: true })).text());
    assert.equal(data.lectureAnswers.length, 1);
    assert.equal(data.lectureFlags[0].note, 'my phone number is 0151 1234567');
    assert.ok(Array.isArray(data.lectureAttendance));

    const uid = reg.body.user.id;
    const gone = await app.call('ann', 'POST', '/api/me/delete', { password: PASSWORD, confirm: 'DELETE' });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(app.db.get('SELECT COUNT(*) n FROM live_attendees WHERE user_id = ?', uid).n, 0, 'presence removed');
    assert.ok(app.db.all('SELECT note, explanation FROM live_flags WHERE user_id = ?', uid).every((f) => f.note === '' && !f.explanation), 'free text removed');
  } finally {
    await app.close();
  }
});
