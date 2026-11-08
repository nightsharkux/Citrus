'use strict';
/**
 * Machine-readable feature registry, served at /api/v1/capabilities and rendered
 * by the "All tools" screen.
 *
 * Status meanings (keep them factual):
 *   available      Works end-to-end and is covered by automated tests.
 *   limited        Works, but depends on the browser, AI output quality or is not validated.
 *   configuration  Code is complete; needs credentials, hardware or institutional approval.
 *   planned        Not built. Shown as "In development". Never simulate it.
 *
 * `route` is the in-app path. `roles` (optional) limits who sees the entry.
 */
const STAFF = ['lecturer', 'admin'];
const ADMIN = ['admin'];

const item = (id, label, status, route, description, roles) => Object.freeze({ id, label, status, route, description, ...(roles ? { roles } : {}) });

module.exports = Object.freeze([
  {
    group: 'Study',
    items: [
      item('courses', 'Courses and lectures', 'available', '/courses', 'Your modules, lectures and topics in one place.'),
      item('comprehension', 'Understanding checks', 'available', '/courses', 'Tell your lecturer privately how well a topic landed.'),
      item('quizzes', 'Concept checks', 'available', '/courses', 'Short multiple-choice checks published during a lecture.'),
      item('review', 'Spaced review queue', 'available', '/learning', 'Revisit difficult topics and missed checks at the right time.'),
      item('revision', 'Revision packs', 'limited', '/learning/packs', 'Practice sets built from your course. AI-written questions should be double-checked.'),
      item('programme-timetables', 'Official class timetables', 'limited', '/assistant', 'Ask what you have right now or next and Campus answers from the university’s published timetable for your programme. Read from the PDFs; a few programmes publish only a picture, which is linked instead.'),
      item('timetable', 'Schedule and calendar sync', 'available', '/schedule', 'Lectures, exams and personal events, with ICS import and a subscribable feed.'),
      item('career', 'Career interest explorer', 'limited', '/career', 'A reflective interest activity. Not a validated psychometric test.'),
      item('captions', 'Live lecture captions', 'limited', '/spaces', 'Browser speech recognition streamed to everyone in the space.'),
      item('adaptive', 'Validated mastery modelling', 'planned', null, 'Research-grade mastery estimation needs evaluation data first.'),
    ],
  },
  {
    group: 'Assistant and collaboration',
    items: [
      item('assistant', 'Campus, the assistant', 'configuration', '/assistant', 'Conversations with your university context, in a window or full screen. Needs an AI provider.'),
      item('attachments', 'Pictures and documents', 'limited', '/assistant', 'Attach, paste or drop a photo, screenshot, PDF, Word, PowerPoint, Excel or text file and ask about it. Reading pictures needs an AI model that can see images; scanned PDFs have no text, so attach photos of the pages instead.'),
      item('maths', 'Formulas and worked examples', 'limited', '/assistant', 'Answers are laid out like a textbook: stacked fractions, roots, steps, tables. Quality depends on the AI model.'),
      item('actions', 'Hands-free actions', 'available', '/assistant', 'Ask Campus to add, move or remove your own calendar events, open a page or change the theme. Every change can be undone.'),
      item('explainers', 'Animated explanations', 'limited', '/assistant', 'Campus’s eye turns into small animations — formulas, steps, figures — while it explains. Depends on the AI model.'),
      item('citations', 'Knowledge search with citations', 'available', '/campus/guide', 'Answers grounded in the approved knowledge library, with sources.'),
      item('website-knowledge', 'University website knowledge', 'limited', '/assistant', 'About 3,000 passages from the public OTH Amberg-Weiden website in German and English (programmes, services, contacts, procedures) are searchable with sources. Copied from the public pages on the date shown with each source; the staff directory is not included. Confirm anything important on the live page.'),
      item('bilingual', 'German and English', 'limited', '/settings/assistant', 'The interface, the assistant and voice work in both languages, including mixed sentences. Some catalogue texts, such as this list and the career questions, are English only.'),
      item('assistant-settings', 'Settings by chat', 'available', '/settings/assistant', 'Rename the assistant, switch the language, change the voice or turn features on and off by asking. Changes can be undone.'),
      item('spaces', 'Workspaces and shared notes', 'available', '/spaces', 'Invite-only spaces for groups, lectures and meetings.'),
      item('transcription', 'Audio transcription', 'planned', null, 'Automatic transcription of uploaded recordings.'),
      item('meetings', 'Meeting recording and minutes', 'limited', '/spaces', 'Record audio with consent, add a transcript, and draft minutes for review.'),
      item('guidance', 'Lecturer-defined AI guidance', 'available', '/spaces', 'Coach, Socratic, direct or assessment-safe assistant behaviour.'),
      item('conversation', 'Voice conversation', 'limited', '/assistant', 'Talk with Campus hands-free: it listens, answers out loud, then listens again, and you can interrupt it. Start it with the waveform button in the assistant or “Hey Campus, let’s talk”. Uses your browser’s speech service; needs Chrome, Edge or Safari over HTTPS or on this computer.'),
      item('wake', 'Voice wake word', 'limited', '/settings/assistant', 'Say “Hey Campus” or “Campus” on any page, then a command: “open schedule”, “dark mode”, or anything you would ask Campus. Needs Chrome, Edge or Safari over HTTPS or on this computer.'),
      item('moodle', 'Moodle connection', 'configuration', '/settings/connections', 'Link your Moodle account with a personal token. Needs MOODLE_URL.'),
    ],
  },
  {
    group: 'Campus',
    items: [
      item('connect', 'Campus feed', 'available', '/campus', 'Moderated announcements, events, jobs, housing and research calls.'),
      item('post', 'Moderated posts', 'available', '/campus', 'Anyone can post; administrators review before publishing.'),
      item('events', 'Event RSVPs', 'available', '/campus', 'Let organisers know you are coming.'),
      item('matching', 'Opportunity matching', 'limited', '/campus', 'Opt-in matching of posts to the interests in your profile.'),
      item('inbox', 'Notification inbox', 'available', '/inbox', 'Approvals, check-ins, new concept checks and campus updates.'),
      item('push', 'Push notifications', 'limited', '/inbox/preferences', 'Browser push with quiet hours. Requires HTTPS outside localhost.'),
      item('guide', 'Campus guide and maps', 'available', '/campus/guide', 'Addresses, official maps and quick links.'),
      item('campus-map', 'Campus map', 'limited', '/campus/map', 'Both campuses from OpenStreetMap data, your position and the way to your next lesson. Walking time is an estimate, directions open in your maps app, and the E-House is not in the map data yet.'),
      item('suggestions', 'Feedback to the university', 'available', '/settings/feedback', 'Send ideas and problems straight to the administrators.'),
    ],
  },
  {
    group: 'Classrooms and devices',
    items: [
      item('checkin', 'Participation sessions', 'available', '/participation', 'Course check-ins with lecturer confirmation.'),
      item('codes', 'Live check-in codes', 'available', '/participation', 'A rotating six-digit code shown in the room.'),
      item('room-status', 'Room status', 'available', '/campus/rooms', 'Open, quiet, do not disturb or consultation — visible to everyone.'),
      item('nfc', 'NFC tap with app confirmation', 'configuration', '/admin/devices', 'Tap a card at a registered reader, confirm in the app. Needs a reader.', STAFF),
      item('puck', 'Classroom voice puck gateway', 'configuration', '/admin/devices', 'Signed device API for voice questions, room status and session start.', STAFF),
      item('door-light', 'Door status light', 'configuration', '/admin/devices', 'Registered lights mirror the room status automatically.', STAFF),
      item('nearby', 'Nearby lecture discovery', 'planned', null, 'Bluetooth proximity hints. Requires native apps and beacons.'),
      item('iot', 'Projector and room equipment control', 'planned', null, 'Needs vendor-approved equipment integrations.'),
      item('native', 'Native iOS and Android apps', 'planned', null, 'The installable web app works today; store apps are not built.'),
    ],
  },
  {
    group: 'Administration',
    items: [
      item('approval', 'Lecturer approvals', 'available', '/admin/people', 'Verify staff before teaching permissions activate.', ADMIN),
      item('providers', 'AI Gateway settings', 'available', '/admin/ai', 'Configure Vercel AI Gateway or turn AI off.', ADMIN),
      item('knowledge', 'University knowledge library', 'available', '/admin/ai', 'Curate the sources the assistant is allowed to cite.', ADMIN),
      item('moderation', 'Moderation and feedback triage', 'available', '/admin/moderation', 'Review posts, reports and suggestions.', ADMIN),
      item('devices', 'Device registry', 'available', '/admin/devices', 'Register, monitor and revoke classroom hardware.', ADMIN),
      item('sso', 'University single sign-on', 'configuration', '/admin/institution', 'OpenID Connect login. Needs your identity provider’s approval.', ADMIN),
      item('audit', 'Audit log and data retention', 'available', '/admin/institution', 'Track sensitive changes and auto-delete old recordings.', ADMIN),
      item('privacy', 'Personal data export and deletion', 'available', '/settings/privacy', 'Download everything about you, or delete your account.'),
      item('compliance', 'Institutional security and GDPR review', 'planned', null, 'A process with your data-protection office, not a code feature.'),
      item('i18n', 'German interface', 'planned', null, 'Interface translation. The assistant already answers in German.'),
    ],
  },
]);
