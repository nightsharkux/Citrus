'use strict';
/**
 * Terms of Use and Privacy, English version (a translation: the German one, policy-de.js, is binding). One version
 * for each role (students, guests, lecturers, administrators), in the four sections people know from websites:
 * terms of use, privacy policy, cookie policy, data retention.
 */

const ROLE = {
  student: { label: 'Students', who: 'students who use Citrus with an account' },
  guest: { label: 'Guests', who: 'guests who take part in a lecture without an account, with its QR code or code' },
  lecturer: { label: 'Lecturers', who: 'lecturers who use Citrus in their teaching' },
  admin: { label: 'Administrators', who: 'administrators who manage the accounts and settings of an institution' },
};

const kept = (n) => (Number(n) > 0 ? `${Number(n)} days after they were written (the institution's setting)` : "until they are deleted (the institution's setting)");

function build({ role, institution, legal, lectureTextRetentionDays, hosting, VERSION, UPDATED }) {
  const is = (...roles) => roles.includes(role);
  const controller = legal.controller || institution;
  const dpo = legal.dpo || 'the data-protection officer of your institution, whose contact details your institution publishes';
  const contact = legal.contact || 'the data-protection officer';
  const authority = legal.authority || 'the data-protection supervisory authority that is competent for your institution';
  const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const list = (items) => items.filter(Boolean).map((t) => `- ${t}`).join('\n');
  const numbered = (items) => items.filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join('\n');

  // ---------------------------------------------------------------- the short version
  const summary = {
    student: [
      'Your answers in a lecture are anonymous to the lecturer unless you choose to show your name.',
      'You see only your own results, never the class\'s and never a summary of the lecture.',
      'Citrus uses AI. It can make mistakes and is never used to grade or assess you.',
      'There is no advertising and there are no trackers, only strictly necessary cookies.',
      'You can download your data or delete your account at any time.',
    ],
    guest: [
      'You take part without an account. Your guest access is retired after 30 days without use.',
      'Only your name (optional), your answers and your flags in this lecture are stored.',
      'The lecturer sees your answers only as totals, unless you choose to show your name.',
      'Citrus sets one strictly necessary cookie for your session, no advertising, no trackers.',
      'You can ask for your guest access to be deleted at any time.',
    ],
    lecturer: [
      'You use Citrus on behalf of your institution and tell your students about it.',
      'You see answers and flags anonymously; names only when students choose to show them.',
      'What you say is stored only if you choose, encrypted, and deleted after the institution\'s period.',
      'AI output must not be used to grade, assess or monitor exams.',
      'There is no advertising and there are no trackers, only strictly necessary cookies.',
    ],
    admin: [
      'You act on behalf of the institution and use your powers only for your task.',
      'Your actions in the Service are logged (180 days).',
      'You set retention periods and legal details, and report incidents within 24 hours.',
      'Any change to these terms that matters means a new version that everyone must accept again.',
      'There is no advertising and there are no trackers, only strictly necessary cookies.',
    ],
  }[role];

  // ---------------------------------------------------------------- 1. Terms of use
  const access = {
    student: 'You use Citrus with an account set up on your university email address or your university login. Keep your password secret and do not share your account. You can delete your account yourself at any time.',
    guest: 'You take part without an account. Joining creates a temporary guest access meant for this lecture. Do not pass the code or QR code on outside the lecture hall.',
    lecturer: 'The administration of your institution confirms lecturer access. You use Citrus in your teaching on behalf of your institution; it remains responsible for the data and you are responsible for using it correctly. Keep your password secret.',
    admin: 'Administrator access gives you wide powers. You manage the institution\'s accounts and settings on behalf of the controller. Keep your password secret, use the university login where possible, and never share your account.',
  }[role];

  const duties = {
    student: [
      '**Your answers are yours.** "Following, unsure or lost" and your flags are tied to your account only so you can see your own results. You choose, lecture by lecture, whether to show your name.',
      '**Flags are not graded.** What you flag, and the notes you write, are never used to grade, rank or discipline you. Write about the lecture, not about people, and do not put sensitive personal data (health, beliefs and the like) into a note.',
      '**The assistant and AI notes can be wrong.** You remain responsible for your learning and for any work you submit.',
      '**Voice.** Voice features use your microphone only after you allow it and only while you use them.',
    ],
    guest: [
      '**Your answers are yours.** The lecturer sees your answers and flags as totals and anonymous flags. You choose whether to show your name.',
      '**Flags are not graded.** Write about the lecture, not about people, and do not put sensitive personal data into a note.',
      '**AI answers can be wrong.** Check anything important.',
      '**Voice.** Voice features use your microphone only after you allow it and only while you use them.',
    ],
    lecturer: [
      '**Tell your students.** At the start of the course, tell students that Citrus is used, what it collects and that their answers are anonymous to you unless they choose otherwise.',
      '**Keep students anonymous.** Do not try to identify students from anonymous totals or flags, for example by running a lecture with so few answers that one person stands out. Where students have shown their name, use it only to help them, such as a word after class, never to grade or sanction.',
      '**No assessment use.** Do not use Citrus\'s feedback, notes or AI output to grade, rank, admit or discipline a student, or to monitor an exam. This keeps Citrus outside the high-risk uses listed in Annex III of the EU AI Act.',
      '**Your own voice and recordings.** Listening in a lecture captures your speech and may capture students who speak. A transcript is kept only if you choose to keep it; audio only if you use the Android app\'s recording and tell the room. Do not record without the notice and, where required, the consent the law demands. You can delete a chapter, the audio, or the whole record at any time.',
      '**What you upload.** Do not upload anything you have no right to share, or other people\'s personal data. Notes and files are shown to your students as your institution permits.',
      '**Check AI output.** Review lecture notes, reviews and explanations before you share or rely on them. They are suggestions.',
      '**Report incidents.** Tell ' + contact + ' without delay if you suspect a breach, for example a lecture file sent to the wrong person. Where the law requires it, the use of classroom tools by staff is agreed with the staff representation.',
    ],
    admin: [
      '**Least privilege.** Give roles and course assignments on the principle of least privilege. Approve lecturers only after verifying who they are, and remove accounts and access promptly when someone leaves.',
      '**Settings you own.** You set retention periods, sign-in rules (university login, open registration), which AI features are on, and the legal details shown in these terms (Admin → Institution). Keep retention as short as the purpose allows, and record any change and its reason.',
      '**Confidentiality.** You can reach account and technical data. Do not look at a person\'s data without a task-related reason, do not copy it elsewhere, and keep the duty of confidentiality after you stop being an administrator.',
      '**Requests from people.** Pass any request about access, erasure, objection or complaint to ' + contact + ' at once. People can do most of them themselves in Settings → Your data.',
      '**Processors and contracts.** Keep the list of processors, their contracts and their locations current, and tell the data-protection officer before enabling a new AI provider or speech service.',
      '**Incidents.** Report a suspected breach to ' + contact + ' immediately and in any case within 24 hours, so the 72-hour notification period to the authority can be met.',
      '**Backups and keys.** The master encryption key and the database backups are part of the protection of the data. Store them as the operator\'s security instructions say, never in the code repository, and test a restore at least once a year.',
      '**Records.** Help keep the records of processing, the impact assessment and these terms up to date.',
    ],
  }[role];

  const terms = `### 1. Scope and acceptance

These terms of use apply to ${ROLE[role].who}. **You must accept them and the privacy policy to use Citrus**: by ticking the box when you register or join, and the first time you sign in after a change. We record the version you accepted and when. The terms of use, privacy policy, cookie policy and retention belong together. The German version is the binding one; the English version helps you understand it.

### 2. The service

Citrus is a student-built service run for ${controller}. It is provided as it is, without a guarantee that it is always available.

### 3. Your access

${access}

### 4. What applies in your role

${numbered(duties)}

### 5. Acceptable use

You will not access another person's data or account; try to identify people who are anonymous; probe or disrupt the Service; upload unlawful material, malware, or other people's personal data without a right to; or use the Service to harass, to cheat in assessments, or to record people without the notice the law requires.

### 6. Artificial intelligence

The assistant, lecture notes, explanations, study notes and spoken voices are produced by AI models that can be wrong. **Check anything important** before relying on it. Voices are labelled as AI-generated. AI output is advice only and is never used to grade, rank, admit, discipline or otherwise decide anything about a student.${is('student', 'lecturer', 'guest') ? ' You can switch AI features off in your settings.' : ' You can switch AI features off for the institution.'}

### 7. Availability, liability and law

The Service is provided without a warranty of availability or fitness for a particular purpose. Liability is limited to intent and gross negligence, and to the breach of duties that are essential to the use of the Service, to the extent the law allows; liability that cannot be limited by law is not limited. German law applies, subject to mandatory rules that protect you; the place of jurisdiction is that of the controller's seat.

### 8. Changes

This is version ${VERSION}, as of ${UPDATED}. When the Service or the law changes in a way that matters to you, the version changes and you are asked to read and accept it again the next time you use it. Until you do, you can read it, download your data or delete your account, but not use the rest of the Service. Minor corrections that change no rights do not change the version.`;

  // ---------------------------------------------------------------- 2. Privacy policy
  const data = [
    [['student', 'lecturer', 'admin'], '**Account:** name, university email, password (stored only as a salted hash), role, last sign-in; or your single sign-on identifier', 'to give you an account and keep it secure', 'public task, Art. 6(1)(e) GDPR with the applicable state law'],
    [['guest'], '**Guest access:** a throwaway account without email or password, with the name you choose (optional)', 'to let you take part without registering', 'consent, Art. 6(1)(a) GDPR'],
    [['student', 'lecturer', 'admin'], role === 'lecturer' ? '**Courses:** your courses, lectures, topics and assignments' : role === 'admin' ? '**Courses and assignments:** courses, lecturers, enrolments' : '**Courses:** your enrolments, your timetable and the settings you choose', 'to run teaching and show timetables', 'public task'],
    [['student', 'guest'], '**How you follow in a lecture:** "following, unsure or lost", the minute, and your own flags (a kind and an optional note you write)', 'so the lecturer can adjust the teaching and you can review the parts you found hard', is('guest') ? 'consent' : 'public task'],
    [['student', 'guest'], '**Attendance in a lecture:** that you joined, and whether you chose to show your name', 'to count who is in the room; showing your name is optional', 'public task; showing your name: consent, Art. 6(1)(a) GDPR'],
    [['lecturer'], '**What you say in a lecture**, from speech recognition, if you choose to keep a transcript; audio kept by the Android app if you wish', 'to write notes and reviews for you and to help students with the parts they struggled with', 'public task; your own choice to keep it'],
    [['lecturer'], '**Course material and notes** you upload', 'to show them to your students and use them in your lectures', 'public task'],
    [['student', 'guest', 'lecturer', 'admin'], '**Your conversations with the assistant**, the files you attach, and what it remembers about your preferences', 'to answer you and help you', 'public task; for what you attach: consent by attaching'],
    [['student', 'guest', 'lecturer', 'admin'], '**Voice:** your microphone audio, only while you use a voice feature you started', 'speech recognition and spoken answers', 'consent, Art. 6(1)(a) GDPR; your browser asks for microphone permission'],
    [['student', 'lecturer', 'admin'], '**Check-ins** (NFC card or code), room and device events', 'attendance and room status where the institution uses them', 'public task'],
    [['admin'], '**Administration log:** your important changes to accounts and settings', 'traceability and security', 'public task'],
    [['student', 'guest', 'lecturer', 'admin'], '**Security and operation:** sign-in sessions, a log of important changes, technical error logs', 'to keep the Service secure and working', 'public task'],
    [['student', 'guest', 'lecturer', 'admin'], '**Your acceptance:** the version and the date', 'to show that you were informed', 'legal obligation, Art. 6(1)(c) GDPR'],
  ].filter(([roles]) => roles.includes(role)).map(([, a, b, c]) => [a, b, c]);

  const sees = {
    student: [
      '**Your answers are anonymous to the lecturer.** They are shown as totals, unless you choose to show your name for that lecture. Flags are shown without names.',
      '**You see only your own results**, never how the class did, and never a summary of the lecture. After a lecture, Citrus helps you only with the parts you found hard yourself.',
      '**The lecturer sees** totals, anonymous flags and, only if you choose, your name with your answers.',
      '**The administration** manages accounts and settings and, in the current software, can open the lecturer\'s view of any course of the institution. Private assistant conversations are not shown to it.',
    ],
    guest: [
      '**Your answers are anonymous to the lecturer**, who sees totals and flags without names unless you show your name.',
      '**You see only your own results**, never how the class did.',
      '**The administration** can, in the current software, open the lecturer\'s view of any course of the institution.',
    ],
    lecturer: [
      '**You see** the class totals, the anonymous flags, the lecture record and, for students who chose it, those students\' names and answers.',
      '**Students stay anonymous** unless they show their name; they never see how the class did.',
      '**What you say** is stored encrypted, with a separate key for each lecture. It opens only for you as the lecturer of that lecture, or as input to an AI request.',
      '**The administration** can, in the current software, open your lecture records through the lecturer\'s view. It does not see private assistant conversations.',
    ],
    admin: [
      '**You see** account and institution data and can open the lecturer\'s view of any course of the institution, including its lecture records. Private assistant conversations are not shown to you.',
      '**What lecturers say** is stored encrypted, with one key per lecture.',
      '**Your actions** are recorded in the security log.',
    ],
  }[role];

  const privacy = `### 1. Controller and contact

${table(['Role', 'Who'], [
    ['Controller', controller],
    ['Data-protection officer', dpo],
    ['Operator (processor)', `the operator of this Citrus installation, who runs it for ${controller} and may process the data only on its instructions`],
    ['Questions and requests', contact],
    ['Supervisory authority', authority],
  ])}

### 2. The data we process, why, and on what basis

${table(['Data', 'Purpose', 'Legal basis'], data)}

Citrus does **not** use advertising or analytics trackers, does not sell data, and does not infer emotions, attention or personality from your face or voice.

### 3. Who sees your data

${list(sees)}

### 4. Recipients and locations

Citrus runs in the European Union. Each service below processes data only for us and under a contract that binds it to do so.

${table(['Service', 'What it does', 'Where'], [
    ['Vercel Inc.', 'hosts the application and serves its files', hosting.app],
    ['Turso', 'the database', hosting.database],
    ['Vercel Blob', 'stores uploaded files and audio kept by the Android app', hosting.files],
    ['Vercel AI Gateway, and the model providers it reaches (for example OpenAI, Google, Microsoft, Perplexity and ElevenLabs, depending on the feature)', 'AI answers, notes, web search and speech', 'processed by the provider; may be outside the European Economic Area'],
    ['Deepgram or Wispr Flow, only if the institution turns them on', 'speech recognition', 'processed by the provider; may be outside the European Economic Area'],
    ['Your browser\'s own speech recognition (Chrome and Edge send audio to Google or Microsoft)', 'speech recognition when no other service is set', 'outside the Service\'s control'],
    ['The institution\'s single sign-on, and Moodle if connected', 'sign-in and course data', 'the institution'],
  ])}

### 5. Artificial intelligence and transfers to third countries

Citrus gives the AI models only the text a feature needs. Lecture records and the notes written from them carry no names or account numbers of students. The personal assistant is given your first name, your role and your own course and schedule information so it can answer you${is('lecturer') ? '; in your own lecture tools it also knows your name' : ''}.

Where data leaves the European Economic Area it is protected by an adequacy decision (for the United States, the EU-US Data Privacy Framework, for certified providers) or by the European Commission's standard contractual clauses. A provider is used only where one of these safeguards is in place. The providers are bound not to keep the data longer than the request needs and not to use it to train their models.

### 6. Your rights

You can, at any time and free of charge:

${list([
    '**access your data and take it with you:** Settings → Your data → *Download*',
    '**have it erased:** Settings → Your data → *Delete my account*' + (is('guest') ? ' or by writing to ' + contact : ''),
    '**correct** what is wrong (your profile in Settings; for anything else write to ' + contact + ')',
    '**restrict or object** to processing based on the public task, on grounds relating to your situation (Art. 18 and 21 GDPR)',
    '**withdraw consent** without affecting what happened before' + (is('student', 'guest') ? ', for example by hiding your name in a lecture or by not using voice' : ''),
    '**complain** to the supervisory authority: ' + authority,
  ])}

We answer within one month. The self-service functions work at once and stay available even if you have not accepted the current version.

### 7. Security

Connections are encrypted (TLS). Passwords are stored only as salted hashes. What lecturers say is stored encrypted with a key per lecture. Access is checked on the server for every request and limited by role and course. Important changes are written to a security log. The database is backed up by its provider, and the encryption key is kept apart from the database. If a breach puts personal data at risk, the controller will notify the supervisory authority within 72 hours where required, and affected people without undue delay where the risk is high.`;

  // ---------------------------------------------------------------- 3. Cookie policy
  const cookies = `### 1. What this is

Cookies are small files a website places in your browser. The browser's local storage and session storage work in a similar way. Citrus uses them only to make the service you opened work.

### 2. What Citrus stores on your device

${table(['Name', 'Purpose', 'Duration', 'Type'], [
    ['campus_session', 'keeps you signed in (sign-in session; HttpOnly, sent only over HTTPS)', '30 days from your last use, then deleted', 'cookie, strictly necessary'],
    ['campus-lang', 'remembers your language', 'until you delete it', 'local storage, necessary'],
    ['campus-theme', 'remembers light, dark or system', 'until you delete it', 'local storage, necessary'],
    ['campus-voice', 'remembers your voice and volume settings', 'until you delete it', 'local storage, necessary'],
    ['campus-web, campus-intro-dismissed, citrus.island, citrus.sign', 'remember web-search settings, dismissed hints, the place of the tool bar and your sign', 'until you delete it', 'local storage, necessary'],
    ['Page state (for example the microphone in a meeting)', 'holds a state while the tab is open', 'until you close the tab', 'session storage, necessary'],
    ['App files (offline storage)', 'loads the app faster and keeps it available offline; private data from the application is not cached', 'replaced with new versions', 'service worker, necessary'],
  ])}

### 3. No trackers, no advertising, no third parties

Citrus sets no analytics, tracking or advertising cookies and embeds no third-party services that set their own. Because everything above is strictly necessary for the service you asked for (§ 25(2) TDDDG), no consent and therefore no cookie banner is needed.

### 4. Your control

You can delete cookies and stored data in your browser at any time; you are then signed out and your settings on this device are lost. Links to other websites (for example a map) open third-party pages with their own rules.`;

  // ---------------------------------------------------------------- 4. Retention
  const rows = [
    [['student', 'lecturer', 'admin'], 'Account and course data', 'while your account exists; removed when you delete it'],
    [['guest'], 'Guest access', 'retired after 30 days without use; deleted at any time on request'],
    [['student', 'guest'], 'Your answers in a lecture', is('guest') ? 'after the guest access is retired, only as anonymous class data' : 'while your account exists; after you delete it they remain only as anonymous class data'],
    [['student', 'guest'], 'Notes and explanations on your flags', kept(lectureTextRetentionDays)],
    [['lecturer'], 'Lecture transcripts, trouble-moment excerpts and kept audio', kept(lectureTextRetentionDays)],
    [['lecturer'], 'Meeting recordings', 'until you delete them, or the institution\'s period'],
    [['lecturer'], 'Course material and notes you upload', 'until you delete them or the course'],
    [['student', 'lecturer', 'admin'], 'Conversations with the assistant', 'until you delete them, at the latest with your account'],
    [['student', 'lecturer', 'admin'], 'Notifications', '60 days after you read them, 180 days at most'],
    [['admin'], 'Administration log and security log', '180 days'],
    [['admin'], 'Device events', '30 days'],
    [['admin'], 'The institution\'s guest accounts', 'retired after 30 days without use'],
    [['student', 'guest', 'lecturer', 'admin'], 'Sign-in sessions', 'until they expire (30 days without use) or you end them'],
    [['student', 'guest', 'lecturer', 'admin'], 'Your acceptances (version and date)', 'while your account exists'],
  ].filter(([roles]) => roles.includes(role)).map(([, a, b]) => [a, b]);

  const retention = `### 1. Periods

${table(['Data', 'Retention'], rows)}

### 2. Deletion and anonymisation

When a period ends the data is deleted automatically; the clean-up runs every hour in the background. If you delete your account${is('guest') ? ' (or have it deleted)' : ''}, your personal data is removed. What concerns groups (for example how many people found a lecture hard) is kept only without any link to you. Contributions you shared remain, shown as "Deleted user".

### 3. Earlier deletion

You can delete data earlier at any time, or have it deleted: Settings → Your data, or by writing to ${contact}. The database provider's backups may still hold data for the length of its backup cycle.${is('admin', 'lecturer') ? ' The periods for lecture content are set by the institution\'s administration (Admin → Institution → Data retention).' : ''}`;

  return {
    roleLabel: ROLE[role].label,
    summary,
    sections: [
      { id: 'terms', title: 'Terms of use', markdown: terms },
      { id: 'privacy', title: 'Privacy policy', markdown: privacy },
      { id: 'cookies', title: 'Cookie policy', markdown: cookies },
      { id: 'retention', title: 'Data retention', markdown: retention },
    ],
  };
}

module.exports = { build };
