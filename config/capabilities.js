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
    group: 'The classroom',
    items: [
      item('live-lecture', 'Live lecture', 'limited', '/lectures', 'The lecturer goes live and shows a six-digit code; students type it on their phones (that joins the course too). Students signal whether they follow, are unsure or are lost, and flag moments they need help with (didn’t get it, too fast, need an example, a question, with a note); the lecturer sees the class pulse, a minute-by-minute timeline and the flags live, without names. Citrus follows the lecture through the browser microphone, knows the prepared notes (pictures and PDFs are read) and answers questions such as “explain the last thing I said” or “what are students stuck on?”. When the lecturer keeps the transcript (the default, chosen at the start), students can ask Citrus about the lecture privately, during it and afterwards, and get each flag explained; only the lecturer can download or delete the transcript. Without it, only the last minutes stay in memory. Speech recognition needs Chrome, Edge or Safari, and AI answers can be wrong. The room light is not yet driven by the pulse.'),
      item('checkin', 'Participation sessions', 'available', '/participation', 'Course check-ins with lecturer confirmation.'),
      item('nfc', 'NFC tap with app confirmation', 'configuration', '/admin/devices', 'Tap a card at a registered reader, confirm in the app. Needs a reader.', STAFF),
      item('lecture-review', 'Lecture review and recaps', 'available', '/lectures', 'After each lecture the lecturer sees where the class struggled, minute by minute, with what was being said and what students flagged; each student gets a private recap with explanations of their flags and a quiz. The way to improve teaching and understanding over time.'),
      item('puck', 'Citrus Puck', 'configuration', '/admin/devices', 'Shows the live class status in the lecture room (green, amber, red) so the lecturer can explain again at once. Signed device API for voice questions, room status and session start.', STAFF),
      item('meetings', 'Meetings with minutes', 'limited', '/meetings', 'Start a meeting from Meetings or Home, or in a space: every member can turn on their microphone and what they say appears for everyone with their name; decisions, action items and questions are added with one tap; ending it drafts the minutes for all members. Audio recording is optional, with consent. The minutes are an AI draft to review. Speech recognition needs Chrome, Edge or Safari.'),
    ],
  },
  {
    group: 'Study',
    items: [
      item('courses', 'Courses and lectures', 'available', '/courses', 'Your modules, lectures and topics in one place.'),
      item('comprehension', 'Understanding checks', 'available', '/courses', 'Tell your lecturer privately how well a topic landed.'),
      item('quizzes', 'Concept checks', 'available', '/courses', 'Short multiple-choice checks published during a lecture.'),
      item('review', 'Spaced review queue', 'available', '/learning', 'Revisit difficult topics and missed checks at the right time.'),
      item('revision', 'Revision packs', 'limited', '/learning/packs', 'Practice sets built from your course. AI-written questions should be double-checked.'),
      item('practice-quizzes', 'Practice quizzes', 'limited', '/quiz', 'Quizzes written for you from a topic, one of your courses or your own notes: multiple choice, select all, true or false, fill in the blank, short answer, put in order, match and calculations. Instant marking with explanations, a hint and a tutor for every question, written answers marked with feedback, and a retry of your mistakes. Ask Citrus “quiz me on…” to start one. AI-written questions should be double-checked.'),
      item('programme-timetables', 'Academic schedules', 'limited', '/assistant', 'Search the supplied snapshot for timetable pages, exam plans, curricula and semester dates, with page citations. Unclear grids and OCR need verification. This is not a live personal calendar.'),
      item('timetable', 'Schedule and calendar sync', 'available', '/schedule', 'Lectures, exams and personal events, with ICS import and a subscribable feed.'),
      item('career', 'Career interest explorer', 'limited', '/career', 'A reflective interest activity. Not a validated psychometric test.'),
      item('captions', 'Live lecture captions', 'limited', '/spaces', 'Live speech recognition shared with the space. Uses configured Wispr Flow or Deepgram, otherwise browser recognition. Wispr returns phrases after a pause.'),
      item('adaptive', 'Validated mastery modelling', 'planned', null, 'Research-grade mastery estimation needs evaluation data first.'),
    ],
  },
  {
    group: 'Assistant and collaboration',
    items: [
      item('assistant', 'Citrus, the assistant', 'configuration', '/assistant', 'Conversations with your university context, in a window or full screen. Needs an AI provider.'),
      item('attachments', 'Pictures and documents', 'limited', '/assistant', 'Attach, paste or drop a photo, screenshot, PDF, Word, PowerPoint, Excel or text file and ask about it. Reading pictures needs an AI model that can see images; scanned PDFs have no text, so attach photos of the pages instead.'),
      item('maths', 'Formulas and worked examples', 'limited', '/assistant', 'Answers are laid out like a textbook: stacked fractions, roots, steps, tables. Quality depends on the AI model.'),
      item('actions', 'Hands-free actions', 'available', '/assistant', 'Ask Citrus to manage your calendar, profile, courses, study groups, notifications and settings, post or sign up for campus events, open any page or university link, start a quiz or send feedback. Every change shows a card and can be undone.'),
      item('memory', 'Assistant memory', 'available', '/assistant', 'Citrus keeps short facts you tell it (your programme, commitments, goals) for later conversations. Ask it what it remembers or to forget something.'),
      item('study-groups', 'Study groups', 'available', '/groups', 'Say what you want a group for and Citrus matches you with students looking for the same. Your name and e-mail are shared only if you agree.'),
      item('web-search', 'Web search', 'limited', '/assistant', 'Citrus looks things up on the web when its own sources are not enough, or for every message while the globe button is on, and links the pages it used. Runs through the AI Gateway (Perplexity). An administrator can turn it off.'),
      item('natural-voices', 'Natural voices', 'configuration', '/settings/assistant', 'Answers read aloud by the AI Gateway’s speech models (OpenAI, Gemini, Microsoft or ElevenLabs) without gaps between sentences, with a choice of voices. Text to speech is in beta on the gateway: until it is enabled for your account, browsers use their own voices.'),
      item('graphs', 'Graphs in answers', 'limited', '/assistant', 'Ask for a graph and Citrus draws a real figure, like one in a textbook: functions, data, bars, pie charts, with labelled axes and marked points. Copy it as a picture or save it as PNG or SVG. The numbers come from the AI, so check them.'),
      item('explainers', 'Animated explanations', 'limited', '/assistant', 'Citrus’s eye turns into small animations — formulas, steps, figures — while it explains. Depends on the AI model.'),
      item('citations', 'Knowledge search with citations', 'available', '/campus/guide', 'Answers grounded in the approved knowledge library, with sources.'),
      item('website-knowledge', 'University website knowledge', 'limited', '/assistant', 'About 3,000 passages from the public OTH Amberg-Weiden website in German and English (programmes, services, contacts, procedures) are searchable with sources. Copied from the public pages on the date shown with each source; the staff directory is not included. Confirm anything important on the live page.'),
      item('bilingual', 'German and English', 'limited', '/settings/assistant', 'The interface, the assistant and voice work in both languages, including mixed sentences. Some catalogue texts, such as this list and the career questions, are English only.'),
      item('assistant-settings', 'Settings by chat', 'available', '/settings/assistant', 'Rename the assistant, switch the language, change the voice or turn features on and off by asking. Changes can be undone.'),
      item('spaces', 'Workspaces and shared notes', 'available', '/spaces', 'Invite-only spaces for groups, lectures and meetings.'),
      item('transcription', 'Audio transcription', 'planned', null, 'Automatic transcription of uploaded recordings.'),
      item('live-recognition', 'External speech recognition', 'configuration', '/settings/assistant', 'Wispr Flow and Deepgram recognize German and English together with microphone echo cancellation and noise suppression. Wispr requires approved API access and returns phrases after a pause. Provider configuration is required; browser recognition remains available.'),
      item('guidance', 'Lecturer-defined AI guidance', 'available', '/spaces', 'Coach, Socratic, direct or assessment-safe assistant behaviour.'),
      item('conversation', 'Voice conversation', 'limited', '/assistant', 'Talk with Citrus hands-free: it listens, answers out loud, then listens again, and you can interrupt it. On computers with GPT-Live on the AI Gateway it hears you while it talks and answers as soon as you finish. Start it with the waveform button or “Hey Citrus, let’s talk”. Listening uses configured Wispr Flow or Deepgram, otherwise browser recognition. Requires microphone access over HTTPS or on this computer.'),
      item('focus', 'Citrus Focus', 'available', '/inbox', 'A do-not-disturb setting for 30 minutes to 4 hours. Pop-ups and push notifications pause and everything waits in your inbox; urgent device taps still come through. The moon in the top bar turns it on and off.'),
      item('wake', 'Voice wake word', 'limited', '/settings/assistant', 'Say “Hey Citrus” or “Citrus” on any page, then a command or question. Uses configured Wispr Flow or Deepgram, otherwise browser recognition. Wispr returns phrases after a pause. Requires microphone access over HTTPS or on this computer.'),
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
      item('codes', 'Live check-in codes', 'available', '/participation', 'A rotating six-digit code shown in the room.'),
      item('room-status', 'Room status', 'available', '/campus/rooms', 'Open, quiet, do not disturb or consultation — visible to everyone.'),
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
      item('documents', 'Documents for Citrus', 'limited', '/library', 'Lecturers and administrators upload files as they are: PDFs, scanned PDFs, photos and screenshots, Word, PowerPoint, Excel and text. Text is taken from the file itself; pictures, scanned pages and PDFs in fonts that cannot be decoded are read by the AI (unverified, and marked as such). Citrus files every page in the knowledge library with its file and page, and each document downloads as one plain-text file with reading instructions that any AI can use. AI reading needs the AI Gateway; files up to 10 MB.', STAFF),
      item('moderation', 'Moderation and feedback triage', 'available', '/admin/moderation', 'Review posts, reports and suggestions.', ADMIN),
      item('devices', 'Device registry', 'available', '/admin/devices', 'Register, monitor and revoke classroom hardware.', ADMIN),
      item('sso', 'University single sign-on', 'configuration', '/admin/institution', 'OpenID Connect login. Needs your identity provider’s approval.', ADMIN),
      item('audit', 'Audit log and data retention', 'available', '/admin/institution', 'Track sensitive changes and auto-delete old recordings.', ADMIN),
      item('privacy', 'Personal data export and deletion', 'available', '/settings/privacy', 'Download everything about you, or delete your account.'),
      item('compliance', 'Institutional security and GDPR review', 'planned', null, 'A process with your data-protection office, not a code feature.'),
      item('i18n', 'German interface', 'limited', '/settings/assistant', 'The whole interface switches between German and English. A few catalogue texts are English only.'),
    ],
  },
  {
    group: 'Your own tools',
    items: [
      item('make-a-tool', 'Make a tool', 'limited', '/apps', 'Describe a small tool, such as a big clock for the projector or a group picker, and Citrus makes it in the Citrus look, with a choice of looks. It stays yours unless you share it. Tools run on their own, with no access to your account or the internet. Made by the AI, so try it before relying on it.'),
      item('more-tools', 'More tools', 'limited', '/apps/gallery', 'Tools people at your university made and shared, checked by an administrator first. Add the ones you like to My tools.'),
    ],
  },
]);
