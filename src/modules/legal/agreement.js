'use strict';
/**
 * The Data Service and Privacy Agreement everyone accepts to use Citrus: students, guests, lecturers and
 * administrators. It is read in the app (when accepting, and any time under Settings → Your data) and every
 * acceptance is recorded with the version.
 *
 * Changing the text in a way that matters means changing VERSION: everyone is then asked to read and accept it again
 * before using the app (until they do they can read it, download their data or delete their account).
 *
 * The text names the institution and its contacts from the institution's own settings (Admin → Institution → Legal
 * details); where those are not entered yet it says so in plain words instead of showing a blank. The retention
 * periods it states are the institution's real settings.
 */

const VERSION = '2026-11-21';
const UPDATED = '2026-11-21';

/** What the app does today, as built: where each service runs. Update this and VERSION when it changes. */
const HOSTING = {
  app: 'Vercel, Dublin (Ireland)',
  database: 'Turso, on Amazon Web Services in the eu-west-1 region (Ireland)',
  files: 'Vercel Blob, Dublin (Ireland)',
};

const days = (n) => (Number(n) > 0 ? `${Number(n)} days` : 'until it is deleted');

/** The agreement for a role, as Markdown. `role`: 'student' | 'lecturer' | 'admin' (guests read the student part), or 'all'. */
function agreementFor({ role = 'all', institution = 'your institution', legal = {}, lectureTextRetentionDays = 365 } = {}) {
  const controller = legal.controller || institution;
  const dpo = legal.dpo || 'the data-protection officer of your institution, whose contact details your institution publishes';
  const contact = legal.contact || 'the data-protection officer';
  const authority = legal.authority || 'the data-protection supervisory authority that is competent for your institution';
  const parts = role === 'all' ? ['student', 'lecturer', 'admin'] : [role === 'guest' ? 'student' : role];

  const common = `## Part A: for everyone

### 1. What this agreement is

This agreement explains how Citrus (the "Service") handles personal data and on what terms you may use it. **You must accept it to use Citrus**: by ticking the box when you create an account, when you join a lecture as a guest, and the first time you sign in after it has changed. We keep a record of the version you accepted and when. Parts B, C and D add what applies to **students and guests**, **lecturers** and **administrators**. If you hold more than one role, each part applies to you in that role.

Citrus is a student-built service run for ${controller}. It is provided as it is, without a guarantee that it is always available.

### 2. Who is responsible

| Role | Who |
| --- | --- |
| Controller | ${controller} |
| Data-protection officer | ${dpo} |
| Operator (processor) | the operator of this Citrus installation, who runs it for ${controller} and may process the data only on its instructions |
| Questions and requests | ${contact} |
| Supervisory authority | ${authority} |

### 3. The data Citrus handles, why, and on what basis

| Data | Purpose | Legal basis |
| --- | --- | --- |
| **Account:** name, university email, password (stored only as a salted hash), role, last sign-in; or your single sign-on identifier | to give you an account and keep it secure | public task, Art. 6(1)(e) GDPR with the applicable state law |
| **Courses:** your enrolments, your timetable and the settings you choose | to run teaching and show you your own schedule | public task |
| **How you follow in a lecture:** "following, unsure or lost", the minute, and your own flags (a kind and an optional note you write) | so the lecturer can adjust the teaching and you can review the parts you found hard | public task |
| **Attendance in a lecture:** that you joined, and whether you chose to show your name | to count who is in the room; showing your name is optional | public task; showing your name: consent, Art. 6(1)(a) |
| **What the lecturer says**, from speech recognition, if the lecturer chooses to keep a transcript; optional audio kept by the Android app | to write notes and reviews for the lecturer, and to help students with the parts they struggled with | public task; the lecturer's own choice to keep it |
| **Your conversations with the assistant**, the files you attach, and what it remembers about your preferences | to answer you and help you study | public task; for what you attach: consent by attaching |
| **Voice:** your microphone audio, only while you use a voice feature you started | speech recognition and spoken answers | consent, Art. 6(1)(a); your browser asks for microphone permission |
| **Check-ins** (NFC card or code), room and device events | attendance and room status where the institution uses them | public task |
| **Security and operation:** sign-in sessions, a log of important changes, technical error logs | to keep the Service secure and working | public task |
| **Your acceptance of this agreement:** the version and the date | to show that you were informed | legal obligation, Art. 6(1)(c) |
| **Guests:** a throwaway account made when you join a lecture by its QR code, with the name you choose (optional) | to let you take part without registering | consent |

Citrus does **not** use advertising or analytics trackers, does not sell data, and does not infer emotions, attention or personality from your face or voice.

### 4. Who sees what

- **Students' answers are anonymous to the lecturer.** They are shown as totals, unless the student chooses to show their name for that lecture. Flags are shown without names.
- **A student sees only their own results**, never how the class did, and never a summary of the lecture. After a lecture, Citrus helps a student only with the parts they themselves found hard.
- **A lecturer sees** the class totals, the anonymous flags, the lecture record and, for students who chose it, those students' names and answers.
- **Administrators** manage the institution's settings and accounts. In the current software an administrator can also open the lecturer's view of any course in their institution, including its lecture records. Private assistant conversations are not shown to administrators.
- **What a lecturer says** is stored encrypted, with a separate key for each lecture. It opens only for the lecturer who teaches that lecture, or as input to an AI request.

### 5. Artificial intelligence

- The assistant, lecture notes, flag explanations, study notes and spoken voices are produced by AI models. They can be wrong. **Check anything important** before relying on it. Voices are labelled as AI-generated.
- Citrus gives the models only the text a feature needs. Lecture records and the notes written from them carry no names or account numbers of students. The personal assistant is given your first name, your role and your own course and schedule information so it can answer you; in a lecturer's own lecture tools it also knows the lecturer's name.
- AI output is **advice only**. It is never used to grade, rank, admit, discipline or otherwise decide anything about a student.
- You can switch AI features off in your settings, and the institution can switch any of them off for everyone.

### 6. Who else handles the data, and where

Citrus runs in the European Union. Each service below processes data only for us and under a contract that binds it to do so.

| Service | What it does | Where |
| --- | --- | --- |
| Vercel Inc. | hosts the application and serves its files | ${HOSTING.app} |
| Turso | the database | ${HOSTING.database} |
| Vercel Blob | stores uploaded files and audio kept by the Android app | ${HOSTING.files} |
| Vercel AI Gateway, and the model providers it reaches (for example OpenAI, Google, Microsoft, Perplexity and ElevenLabs, depending on the feature) | AI answers, notes, web search and speech | processed by the provider; may be outside the European Economic Area |
| Deepgram or Wispr Flow, only if the institution turns them on | speech recognition | processed by the provider; may be outside the European Economic Area |
| Your browser's own speech recognition (Chrome and Edge send audio to Google or Microsoft) | speech recognition when no other service is set | outside the Service's control |
| The institution's single sign-on, and Moodle if connected | sign-in and course data | the institution |

Where data leaves the European Economic Area it is protected by an adequacy decision (for the United States, the EU-US Data Privacy Framework, for certified providers) or by the European Commission's standard contractual clauses. A provider is used only where one of these safeguards is in place. The providers are bound not to keep the data longer than the request needs and not to use it to train their models.

### 7. How long data is kept

| Data | Kept |
| --- | --- |
| Account and course data | while your account exists; removed when you delete it |
| Your answers in a lecture | while your account exists; after you delete it they remain only as anonymous class data |
| Lecture transcripts, trouble-moment excerpts, kept audio, and the notes and explanations on flags | ${days(lectureTextRetentionDays)} after they were written (the institution's setting) |
| Meeting recordings | until their owner deletes them, or the institution's period |
| Guest accounts | retired after 30 idle days |
| Security log | 180 days |
| Notifications | 60 days after you read them, and 180 days at most |
| Device events | 30 days |
| Sign-in sessions | until they expire or you end them |
| Your acceptances of this agreement | while your account exists |

### 8. How the data is protected

Connections are encrypted (TLS). Passwords are stored only as salted hashes. What lecturers say is stored encrypted with a key per lecture. Access is checked on the server for every request and limited by role and course. Important changes are written to a security log. The Service stores no advertising or analytics identifiers. The database is backed up by its provider, and the encryption key is kept apart from the database.

If a breach puts personal data at risk, the controller will notify the supervisory authority within 72 hours where required, and affected people without undue delay where the risk is high.

### 9. Your rights

You can, at any time and free of charge:

- **access your data and take it with you:** Settings → Your data → *Download*;
- **have it erased:** Settings → Your data → *Delete my account*;
- **correct** what is wrong (your profile in Settings; for anything else write to the contact in section 2);
- **restrict or object** to processing based on the public task, on grounds relating to your situation (Art. 18 and 21 GDPR);
- **withdraw consent**, for example by hiding your name in a lecture, by not using voice, or by deleting what you attached, without affecting what happened before;
- **complain** to the supervisory authority named in section 2.

We answer within one month. The self-service functions above work at once, and they stay available even if you have not accepted the current version of this agreement.

### 10. Cookies and similar storage

Citrus stores a sign-in cookie and a few preferences (language, theme, voice choices) on your device. These are strictly necessary for the service you asked for, so no consent banner is needed. Citrus sets no tracking or advertising cookies.

### 11. Acceptable use

You will not access another person's data or account; try to identify people who are anonymous; probe or disrupt the Service; upload unlawful material, malware, or other people's personal data without a right to; or use the Service to harass, to cheat in assessments, or to record people without the notice the law requires.

### 12. Responsibility and law

The Service is provided without a warranty of availability or fitness for a particular purpose. Liability is limited to intent and gross negligence, and to the breach of duties that are essential to the use of the Service, to the extent the law allows; liability that cannot be limited by law is not limited. German law applies, subject to mandatory rules that protect you; the place of jurisdiction is that of the controller's seat.

### 13. When this agreement changes

This is version ${VERSION}, updated ${UPDATED}. When the Service or the law changes in a way that matters to you, the version changes and you are asked to read and accept it again the next time you use Citrus. Until you do, you can read it, download your data or delete your account, but not use the rest of the Service. Minor corrections that change no rights do not change the version. You can read the current agreement and see when you accepted it under Settings → Your data.
`;

  const student = `## Part B: students and guests

1. **Your answers are yours.** "Following, unsure or lost" and your flags are tied to your account only so you can see your own results. The lecturer sees totals and anonymous flags. You choose, lecture by lecture, whether to show your name, and you can change it later.
2. **You see only your own results.** Citrus does not show you how the class did and does not give you a summary of the lecture. It helps you with the parts *you* found hard, using your own answers and flags.
3. **Flags are not graded.** What you flag, and the notes you write, are never used to grade, rank or discipline you. Write about the lecture, not about people. Do not put sensitive personal data (health, beliefs and the like) into a note.
4. **The assistant and AI notes can be wrong.** You remain responsible for your learning and for any work you submit.
5. **Voice.** Voice features use your microphone only after you allow it and only while you use them. Turning the microphone off at any time stops them.
6. **Guests.** A guest account is temporary and holds only what you do in that lecture. It is retired after 30 idle days, and a guest can ask for it to be deleted at any time.
7. **Leaving.** You can download your data and delete your account at any time (Part A, section 9). Your answers then remain only as anonymous class data.
`;

  const lecturer = `## Part C: lecturers

1. **Your role.** You use Citrus in your teaching under the authority of ${controller}. ${controller} remains responsible for the data; you are responsible for using it correctly.
2. **Tell your students.** At the start of the course, tell students that Citrus is used, what it collects (Part A, section 3) and that their answers are anonymous to you unless they choose otherwise.
3. **Anonymity.** Do not try to identify students from anonymous totals or flags, for example by running a lecture with so few answers that one person stands out. Where a student has chosen to show their name, use what they shared only to help them, such as a word after class, never to grade or sanction.
4. **No assessment use.** Do not use Citrus's feedback, notes or AI output to grade, rank, admit or discipline a student, or to monitor an exam. This keeps Citrus outside the high-risk uses listed in Annex III of the EU AI Act.
5. **Your own voice and recordings.** Listening in a lecture captures your speech and may capture students who speak. A transcript is kept only if you choose to keep it. Audio is kept only if you use the Android app's recording and tell the room. Do not record or keep audio without the notice and, where required, the consent the law demands. You can delete a chapter, the audio, or the whole record at any time. Transcripts and kept audio are removed after the institution's period (Part A, section 7).
6. **What you upload.** Notes and files you add are shown to your students as your institution permits. Do not upload anything you have no right to share, or other people's personal data.
7. **AI output.** Review lecture notes, reviews and explanations before you share or rely on them. They are suggestions.
8. **Your own data.** Your use of Citrus is logged as described in Part A, section 8. Where the law requires it, the use of classroom tools by staff is agreed with the staff representation. You have the rights in Part A, section 9 for your own data.
9. **Incidents.** Tell ${contact} without delay if you suspect a breach, for example a lecture file sent to the wrong person.
`;

  const admin = `## Part D: administrators

1. **Your role.** You manage the institution's accounts and settings on behalf of the controller, ${controller}. Use your powers only for that purpose and only as far as your task requires.
2. **Access.** Give roles and course assignments on the principle of least privilege. Approve lecturers only after verifying who they are. Remove accounts and access promptly when someone leaves.
3. **Settings you own.** You set the institution's retention periods, sign-in rules (university login, open registration), which AI features are on, and the legal details shown in this agreement (Admin → Institution). Keep retention as short as the purpose allows (Part A, section 7), and record any change and its reason.
4. **Confidentiality.** You can reach account and technical data. Do not look at a person's data without a task-related reason, do not copy it elsewhere, and keep the duty of confidentiality after you stop being an administrator. Your actions in the Service are logged.
5. **Requests from people.** Pass any request about access, erasure, objection or complaint to ${contact} at once. People can do most of them themselves in Settings → Your data.
6. **Processors and contracts.** Keep the list of processors, their contracts and their locations current (Part A, section 6), and tell the data-protection officer before enabling a new AI provider or speech service.
7. **Incidents.** Report a suspected breach to ${contact} immediately and in any case within 24 hours, so the 72-hour notification period to the authority can be met. Help to contain and document it.
8. **Backups and keys.** The master encryption key and the database backups are part of the protection of the data. Store them as the operator's security instructions say, never in the code repository, and test a restore at least once a year.
9. **Records.** Help keep the records of processing, the impact assessment and this agreement up to date when the Service changes. Changing this agreement in a way that matters means a new version, which every user must accept again.
`;

  const text = { student, lecturer, admin };
  const body = [common, ...parts.map((p) => text[p])].filter(Boolean).join('\n');
  return { version: VERSION, updated: UPDATED, role, title: 'Data Service and Privacy Agreement', markdown: `# Data Service and Privacy Agreement\n\nVersion ${VERSION} · ${controller}\n\n${body}` };
}

module.exports = { agreementFor, VERSION, UPDATED, HOSTING };
